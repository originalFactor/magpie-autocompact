import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSessionTransport } from "../lib/session-transport.js";
import { clientSessionKey, mappedRequest } from "../lib/session-identity.js";

async function fixture(t, policy = {}, fetchImpl) {
  const root = await mkdtemp(join(tmpdir(), "magpie-server-session-test-"));
  const responses = new Map(), conversations = new Map([["conv_client", []]]), calls = [], compactions = [], summaries = [];
  const sessionTurns = new Map(), managementCalls = [];
  const compactEndpoints = [], alphaSearches = [];
  let counter = 0, failCompaction = false, failCompactEndpoint = false, failSummary = false, summaryFailure = "summary unavailable", delayCompaction = 0, modelTurnLimit = Infinity, sessionTurnLimit = Infinity;
  const upstream = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://local");
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      const sessionId = req.headers["session-id"] ?? req.headers.session_id ?? body?.prompt_cache_key;
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && url.pathname === "/v1/alpha/search") {
        alphaSearches.push({ raw, body, sessionId, headers: { ...req.headers } });
        res.setHeader("x-native-search", "retained");
        res.end(JSON.stringify({ encrypted_output: "opaque-search-state", output: "Native search result", results: [
          { type: "text_result", ref_id: "turn0search0", url: "https://example.com/result" },
        ] })); return;
      }
      if (req.url === "/summary-api/v1/chat/completions") {
        summaries.push({ body, authorization: req.headers.authorization });
        if (failSummary) { res.writeHead(503).end(JSON.stringify({ error: { code: "summary_down", message: summaryFailure } })); return; }
        res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "Historical task summary." } }] })); return;
      }
      if (req.method === "GET" && /^\/v1\/responses\/[^/]+$/.test(url.pathname)) {
        managementCalls.push({ path: url.pathname, sessionId });
        const record = responses.get(decodeURIComponent(url.pathname.split("/").at(-1)));
        if (!record) { res.writeHead(404).end("{}"); return; }
        res.end(JSON.stringify(record.reply)); return;
      }
      if (req.method === "GET" && url.pathname.endsWith("/items")) {
        const items = conversations.get(decodeURIComponent(url.pathname.split("/").at(-2)));
        if (!items) { res.writeHead(404).end("{}"); return; }
        assert.equal(url.searchParams.get("order"), "asc");
        const start = url.searchParams.has("after") ? items.findIndex((x) => x.id === url.searchParams.get("after")) + 1 : 0;
        const data = items.slice(start, start + 2);
        res.end(JSON.stringify({ data, has_more: start + 2 < items.length, last_id: data.at(-1)?.id })); return;
      }
      if (req.method === "POST" && url.pathname.endsWith("/items")) {
        const id = decodeURIComponent(url.pathname.split("/").at(-2));
        const items = conversations.get(id);
        if (!items) { res.writeHead(404).end("{}"); return; }
        items.push(...body.items.map((item) => ({ ...item, id: item.id ?? `item_${++counter}` })));
        res.end(JSON.stringify({ data: body.items, has_more: false })); return;
      }
      if (req.method === "POST" && url.pathname === "/v1/conversations") {
        const id = `conv_shadow_${++counter}`;
        conversations.set(id, (body.items ?? []).map((x) => ({ ...x, id: x.id ?? `item_${++counter}` })));
        res.end(JSON.stringify({ id, object: "conversation" })); return;
      }
      if (req.method === "GET" && /^\/v1\/conversations\/[^/]+$/.test(url.pathname)) {
        res.end(JSON.stringify({ id: url.pathname.split("/").at(-1), object: "conversation" })); return;
      }
      if (req.method === "POST" && url.pathname === "/v1/responses/compact") {
        compactEndpoints.push({ body, sessionId, headers: { ...req.headers } });
        if (failCompactEndpoint) { res.writeHead(429).end(JSON.stringify({ error: { type: "rate_limit_error", message: "compact endpoint unavailable" } })); return; }
        res.end(JSON.stringify({ id: `cmp_window_${++counter}`, object: "response.compaction", output: [
          { role: "user", content: "Preserved by standalone compact endpoint." }, { type: "compaction", encrypted_content: "sealed-endpoint-prefix" },
        ] })); return;
      }
      if (req.method !== "POST" || url.pathname !== "/v1/responses") { res.writeHead(404).end("{}"); return; }
      if (sessionId) {
        const turns = sessionTurns.get(sessionId) ?? 0;
        if (turns >= sessionTurnLimit) {
          res.writeHead(400).end(JSON.stringify({ error: { message: "This conversation has reached 100 model turns" } })); return;
        }
        sessionTurns.set(sessionId, turns + 1);
      }
      if (Array.isArray(body.input) && body.input.filter((i) => i.role === "assistant" || ["function_call", "custom_tool_call"].includes(i.type)).length >= modelTurnLimit) {
        res.writeHead(400).end(JSON.stringify({ error: { message: "This conversation has reached 100 model turns" } })); return;
      }
      if (body.input?.at(-1)?.type === "compaction_trigger") {
        compactions.push({ ...body, userAgent: req.headers["user-agent"], sessionId, headers: { ...req.headers } });
        if (delayCompaction) await new Promise((r) => setTimeout(r, delayCompaction));
        if (failCompaction) { res.writeHead(503).end(JSON.stringify({ error: { code: "trigger_down", message: "trigger unavailable" } })); return; }
        assert.equal(body.stream, true, "native compaction uses the verified streaming protocol");
        const reply = { id: `resp_internal_${++counter}`, status: "completed", output: [{ type: "compaction", id: `cmp_${counter}`, encrypted_content: "sealed-prefix" }] };
        res.setHeader("content-type", "text/event-stream");
        const item = `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: reply.output[0] })}\r\n\r\n`;
        res.write(item.slice(0, 13)); res.write(item.slice(13));
        // Exercise item recovery when the terminal response omits its output.
        res.end(`data: ${JSON.stringify({ type: "response.completed", response: { ...reply, output: [] } })}\r\n\r\ndata: [DONE]\r\n\r\n`); return;
      }
      if (body.input?.[0]?.role === "system" && body.input[0].content?.startsWith("Summarize the historical conversation for continuation.")) {
        summaries.push({ body, sessionId, authorization: req.headers.authorization, userAgent: req.headers["user-agent"] });
        if (failSummary) { res.writeHead(503).end(JSON.stringify({ error: { code: "summary_down", message: summaryFailure } })); return; }
        res.setHeader("content-type", "text/event-stream");
        res.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: `summary_${++counter}`, status: "completed", output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "Historical task summary." }] },
        ] } })}\n\n`); return;
      }
      const incoming = typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input ?? [];
      const conversation = typeof body.conversation === "string" ? body.conversation : body.conversation?.id;
      const previous = body.previous_response_id && responses.get(body.previous_response_id);
      if (body.previous_response_id && !previous) { res.writeHead(404).end("{}"); return; }
      const base = conversation ? conversations.get(conversation) : previous?.history ?? [];
      if (!base) { res.writeHead(404).end("{}"); return; }
      calls.push({ body, authorization: req.headers.authorization, userAgent: req.headers["user-agent"], sessionId, headers: { ...req.headers }, history: [...base, ...incoming] });
      if (body.metadata?.reject) { res.writeHead(typeof body.metadata.reject === "number" ? body.metadata.reject : 400).end(JSON.stringify({ error: { message: "deliberate request rejection" } })); return; }
      if (body.metadata?.delay) await new Promise((r) => setTimeout(r, body.metadata.delay));
      const id = `resp_${++counter}`;
      const output = body.metadata?.tool ? [{ type: "function_call", id: `fc_${counter}`, call_id: "active_call", name: "read", arguments: "{}" }]
        : [{ type: "message", role: "assistant", id: `msg_${counter}`, status: "completed", content: [{ type: "output_text", text: `reply ${id}`, annotations: [] }] }];
      const reply = { id, object: "response", status: "completed", model: body.model, previous_response_id: body.previous_response_id ?? null, conversation: conversation ? { id: conversation } : null, output, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
      const history = [...base, ...incoming, ...output];
      responses.set(id, { reply, history });
      if (conversation) conversations.set(conversation, history.map((x) => ({ ...x, id: x.id ?? `item_${++counter}` })));
      if (body.metadata?.breakBeforeID) { res.destroy(); return; }
      if (!body.stream) { res.end(JSON.stringify(reply)); return; }
      res.setHeader("content-type", "text/event-stream");
      const created = { type: "response.created", response: { ...reply, status: "in_progress", output: [] } };
      // Deliberately fragment an SSE frame across network chunks.
      const first = `event: response.created\nid: keep-event-id\ndata: ${JSON.stringify(created)}\n\n`;
      res.write(first.slice(0, 19)); res.write(first.slice(19));
      if (body.metadata?.delayFinal) await new Promise((r) => setTimeout(r, body.metadata.delayFinal));
      if (body.metadata?.truncate) { res.end(); return; }
      res.write(`event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: output[0] })}\n\n`);
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "streamed text" })}\n\n`);
      res.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: output[0] })}\n\n`);
      res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: reply })}\n\n`);
    } catch (error) { res.writeHead(500).end(JSON.stringify({ error: String(error) })); }
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const upstreamURL = `http://127.0.0.1:${upstream.address().port}/v1/responses`;
  const options = { providers: { limited: {
    maxMessages: 4, ...policy,
    stateful: { enabled: true, url: upstreamURL, ...policy.stateful },
  } } };
  const summaryProviders = { "summary-fixture": { protocol: "chat", baseURL: upstreamURL.replace("/v1/responses", "/summary-api/v1"), key: "separate-summary-key", models: ["small"] } };
  let proxy = await createSessionTransport(options, { stateDir: root, fetchImpl, summaryProviders });
  async function request(body, { key = "tenant-a", path = "/responses", method = "POST", signal, headers = {} } = {}) {
    return proxy.fetch("limited", `${upstreamURL.replace(/\/responses$/, "")}${path}`, {
      method, signal, headers: { ...headers, authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify({ model: "test", ...body }),
    });
  }
  async function turn(body, opts) {
    const response = await request(body, opts), text = await response.text();
    assert.equal(response.status, 200, text); return JSON.parse(text);
  }
  t.after(async () => {
    await proxy.close(); await new Promise((r) => upstream.close(r)); await rm(root, { recursive: true, force: true });
  });
  return {
    root, upstreamURL, calls, compactions, compactEndpoints, alphaSearches, summaries, conversations, responses, request, turn, sessionTurns, managementCalls,
    failCompaction() { failCompaction = true; },
    failCompactEndpoint() { failCompactEndpoint = true; },
    failSummary(message) { failSummary = true; if (message) summaryFailure = message; },
    setModelTurnLimit(n) { modelTurnLimit = n; },
    setSessionTurnLimit(n) { sessionTurnLimit = n; },
    delayCompaction(ms) { delayCompaction = ms; },
    async restart() { await proxy.close(); proxy = await createSessionTransport(options, { stateDir: root, fetchImpl, summaryProviders }); },
    async secondOwner(overrides = {}) {
      return createSessionTransport({ providers: { limited: { ...options.providers.limited, ...overrides } } }, { stateDir: root, summaryProviders });
    },
  };
}

for (const stream of [false, true]) {
  test(`compaction notice continues inference and resumes after restart (stream=${stream})`, async (t) => {
    const f = await fixture(t, { maxMessages: 8, compactionNotice: true, stateful: { maxRequests: 1 } });
    const input = Array.from({ length: 9 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `turn ${index}` }));
    const response = await f.request({ input, stream });
    assert.equal(response.status, 200);
    let reply;
    if (stream) {
      const events = (await response.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
      assert.equal(events[0].type, "response.created");
      assert.equal(events.at(-1).type, "response.completed");
      assert.equal(events.find((event) => event.type === "response.output_text.delta").delta, `上下文已压缩到 ${f.calls[0].body.input.length} 条消息。\n\n`);
      reply = events.at(-1).response;
    } else reply = await response.json();
    assert.equal(reply.output[0].content[0].text, `上下文已压缩到 ${f.calls[0].body.input.length} 条消息。\n\n`);
    assert.equal(f.calls.length, 1);
    assert.equal(reply.output.length, 2);
    assert.match(reply.output[1].content[0].text, /reply resp_/);
    assert.equal(f.compactions.length, 1);
    await f.restart();
    const retrieved = await f.request(undefined, { path: `/responses/${reply.id}`, method: "GET" });
    assert.deepEqual(await retrieved.json(), reply);
    const next = await f.turn({ previous_response_id: reply.id, input: "continue" });
    assert.equal(next.previous_response_id, reply.id);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].body.previous_response_id, undefined);
    assert.ok(f.calls[1].sessionId);
    assert.equal(f.calls[1].body.input[0].type, "compaction");
    assert.match(JSON.stringify(f.calls[1].body.input), /上下文已压缩/);
  });
}

test("Responses notice is readable before upstream headers and shares one response lifecycle", async (t) => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t, { maxMessages: 8, compactionNotice: true }, async (url, init) => {
    const body = init.body && JSON.parse(init.body);
    if (body?.input?.at(-1)?.type !== "compaction_trigger") await waiting;
    return fetch(url, init);
  });
  const input = Array.from({ length: 9 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `turn ${index}` }));
  const response = await f.request({ input, stream: true, metadata: { tool: true } });
  const reader = response.body.getReader();
  let text = new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /上下文已压缩/);
  assert.doesNotMatch(text, /response.completed/);
  assert.equal(f.calls.length, 0);
  release();
  for (;;) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value); }
  const events = text.split(/\r?\n/).filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
  assert.equal(events.filter((event) => event.type === "response.created").length, 1);
  assert.equal(events.filter((event) => event.type === "response.completed").length, 1);
  assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, index) => index));
  const reply = events.at(-1).response;
  assert.equal(reply.id, events[0].response.id);
  assert.equal(reply.output[1].type, "function_call");
  assert.equal(events.find((event) => event.type === "response.output_item.done" && event.item.type === "function_call").output_index, 1);
  await f.restart();
  await f.turn({ previous_response_id: reply.id, input: [{ type: "function_call_output", call_id: "active_call", output: "tool result" }] });
  assert.equal(f.calls.at(-1).body.input.at(-2).type, "function_call");
});

test("truncated Responses notice streams recover the upstream reply after restart", async (t) => {
  const f = await fixture(t, { maxMessages: 8, compactionNotice: true });
  const input = Array.from({ length: 9 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `turn ${index}` }));
  const response = await f.request({ input, stream: true, metadata: { truncate: true } });
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const id = JSON.parse(first.split("\n").find((line) => line.startsWith("data: ")).slice(6)).response.id;
  await assert.rejects(async () => { while (!(await reader.read()).done) {} });
  await f.restart();
  await f.turn({ previous_response_id: id, input: "continue" });
  assert.equal(f.calls.length, 2);
  assert.match(JSON.stringify(f.calls[1].body.input), /reply resp_/);
  const retrieved = await f.request(undefined, { path: `/responses/${id}`, method: "GET" });
  assert.equal((await retrieved.json()).output[0].content[0].text, `上下文已压缩到 ${f.calls[0].body.input.length} 条消息。\n\n`);
});

test("truncated stateless inference reuses the completed compaction on retry", async (t) => {
  const f = await fixture(t, { maxMessages: 8, compactionNotice: true });
  const input = loopHistory();
  const response = await f.request({ input, store: false, stream: true, metadata: { truncate: true } });
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const notice = first.split("\n").filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6))).find((event) => event.type === "response.output_item.done").item;
  await assert.rejects(async () => { while (!(await reader.read()).done) {} });
  assert.equal(f.compactions.length, 1);
  await f.restart();
  await f.turn({ input: [...input, notice, { role: "assistant", content: " " }], store: false });
  assert.equal(f.compactions.length, 1, "retry should reuse the successful compaction");
  assert.equal(f.calls.at(-1).body.input[0].type, "compaction");
});

test("Responses compaction notice continues inference after pack fallback", async (t) => {
  const f = await fixture(t, { maxMessages: 8, compactionNotice: true });
  f.failCompaction(); f.failCompactEndpoint(); f.failSummary();
  const input = Array.from({ length: 9 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `turn ${index}` }));
  const reply = await f.turn({ input, store: false });
  assert.equal(reply.output[0].content[0].text, `上下文已打包到 ${f.calls[0].body.input.length} 条消息。\n\n`);
  assert.equal(f.calls.length, 1);
  await f.restart();
  await f.turn({ input: [...input, { role: "assistant", content: reply.output[0].content[0].text }, { role: "user", content: "continue" }], store: false });
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].body.input[0].content, /original_messages_json/);
});

test("Responses media survives pack fallback, replay, and provider restart", async (t) => {
  const f = await fixture(t, { maxMessages: 8 });
  f.failCompaction(); f.failCompactEndpoint(); f.failSummary();
  const media = { type: "input_image", image_url: "https://example.test/screenshot.png" };
  const input = loopHistory();
  input[0].content = [{ type: "input_text", text: "Inspect the image" }, media];
  const reply = await f.turn({ input, store: false });
  const packed = f.calls.at(-1).body.input;
  assert.deepEqual(packed[0].content[1], media);
  assert.match(packed[0].content[0].text, /historical_media/);
  await f.restart();
  await f.turn({ input: [...input, ...reply.output, { role: "user", content: "Continue" }], store: false });
  assert.deepEqual(f.calls.at(-1).body.input[0].content[1], media);
});

for (const stream of [false, true]) {
  test(`forced pack notice reports the retained item count (stream=${stream})`, async (t) => {
    const f = await fixture(t, { maxMessages: 8, maxRetainedRatio: 0.125, compactionNotice: true });
    f.failCompaction(); f.failCompactEndpoint(); f.failSummary();
    const response = await f.request({ input: loopHistory(), store: false, stream });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, new RegExp(`上下文已强制打包到 ${f.calls[0].body.input.length} 条消息。`));
    assert.match(JSON.stringify(f.calls[0].body.input), /result 7/);
  });
}

test("conversation compaction notice updates the shadow before returning", async (t) => {
  const f = await fixture(t, { maxMessages: 8, compactionNotice: true });
  f.conversations.set("conv_notice", Array.from({ length: 8 }, (_, index) => ({ id: `item_notice_${index}`, role: index % 2 ? "assistant" : "user", content: `turn ${index}` })));
  const reply = await f.turn({ conversation: "conv_notice", input: "new task" });
  assert.equal(reply.output[0].content[0].text, `上下文已压缩到 ${f.calls[0].history.length} 条消息。\n\n`);
  assert.equal(f.calls.length, 1);
  await f.restart();
  await f.turn({ conversation: "conv_notice", input: "continue" });
  assert.equal(f.calls.length, 2);
  const history = f.conversations.get(f.calls[1].body.conversation);
  assert.equal(history[0].type, "compaction");
  assert.match(JSON.stringify(history), /new task/);
  assert.match(JSON.stringify(history), /reply resp_/);
});

test("previous_response_id creates a fresh compacted chain and echoes the client's parent", async (t) => {
  const f = await fixture(t);
  const a = await f.turn({ input: "first" });
  const b = await f.turn({ input: "second", previous_response_id: a.id });
  const c = await f.turn({ input: "third", previous_response_id: b.id, instructions: "preserve", tools: [{ type: "function", name: "read", parameters: {} }] });
  assert.equal(c.previous_response_id, b.id);
  assert.equal(f.compactions.length, 1);
  assert.equal(f.compactEndpoints.length, 0);
  assert.equal(f.summaries.length, 0);
  assert.equal(f.calls.at(-1).body.previous_response_id, undefined);
  assert.equal(f.calls.at(-1).body.input[0].type, "compaction");
  assert.equal(f.calls.at(-1).body.instructions, "preserve");
  assert.equal(f.calls.at(-1).body.tools[0].name, "read");
  const d = await f.turn({ input: "fourth", previous_response_id: c.id });
  assert.equal(f.calls.at(-1).body.previous_response_id, c.id);
  assert.equal(d.previous_response_id, c.id);
  const retrieved = await f.request(undefined, { path: `/responses/${c.id}`, method: "GET" });
  assert.equal((await retrieved.json()).previous_response_id, b.id);
});

test("server chain request counts rotate IDs without compaction", async (t) => {
  const f = await fixture(t, { maxMessages: 100, stateful: { maxRequests: 2 } });
  const a = await f.turn({ input: "first" });
  const b = await f.turn({ input: "second", previous_response_id: a.id });
  await f.turn({ input: "third", previous_response_id: b.id });
  assert.equal(f.compactions.length, 0);
  assert.equal(f.calls.at(-1).body.previous_response_id, b.id);
  assert.match(f.calls.at(-1).sessionId, /^[0-9a-f-]{36}$/);
});

test("response snapshots survive a provider restart and isolate credentials", async (t) => {
  const f = await fixture(t);
  const a = await f.turn({ input: "private first" });
  await f.restart();
  const denied = await f.request({ input: "steal context", previous_response_id: a.id }, { key: "tenant-b" });
  assert.equal(denied.status, 409);
  const b = await f.turn({ input: "second", previous_response_id: a.id });
  await f.restart();
  const c = await f.turn({ input: "third", previous_response_id: b.id });
  assert.equal(c.previous_response_id, b.id);
  const files = (await readdir(f.root)).filter((x) => x.endsWith(".json"));
  assert.ok(files.length >= 3);
  for (const file of files) {
    if (process.platform !== "win32") assert.equal((await stat(join(f.root, file))).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(join(f.root, file), "utf8"), /Bearer tenant-a/);
  }
});

test("immutable response snapshots preserve branches from the same parent", async (t) => {
  const f = await fixture(t, { maxMessages: 100 });
  const parent = await f.turn({ input: "root" });
  const [left, right] = await Promise.all([
    f.turn({ previous_response_id: parent.id, input: "left branch" }),
    f.turn({ previous_response_id: parent.id, input: "right branch" }),
  ]);
  await f.turn({ previous_response_id: left.id, input: "left continuation" });
  assert.match(JSON.stringify(f.calls.at(-1).history), /left branch/);
  assert.doesNotMatch(JSON.stringify(f.calls.at(-1).history), /right branch/);
  await f.turn({ previous_response_id: right.id, input: "right continuation" });
  assert.doesNotMatch(JSON.stringify(f.calls.at(-1).history), /left branch/);
});

test("conversation keeps the client ID while rotating and durably mapping the upstream ID", async (t) => {
  const f = await fixture(t);
  await f.turn({ conversation: "conv_client", input: "first" });
  await f.turn({ conversation: { id: "conv_client" }, input: "second" });
  const c = await f.turn({ conversation: "conv_client", input: "third" });
  assert.equal(c.conversation.id, "conv_client");
  assert.notEqual(f.calls.at(-1).body.conversation, "conv_client");
  const shadow = f.calls.at(-1).body.conversation;
  assert.equal(f.conversations.get(shadow)[0].type, "compaction");
  assert.equal(f.conversations.get("conv_client").filter((x) => x.role === "user").length, 2);
  await f.restart();
  const d = await f.turn({ conversation: "conv_client", input: "fourth" });
  assert.equal(d.conversation.id, "conv_client");
  assert.equal(f.calls.at(-1).body.conversation, shadow);
  const retrieved = await f.request(undefined, { path: "/conversations/conv_client", method: "GET" });
  assert.equal((await retrieved.json()).id, "conv_client");
});

test("concurrent conversation requests serialize across compaction", async (t) => {
  const f = await fixture(t);
  await f.turn({ conversation: "conv_client", input: "first" });
  await f.turn({ conversation: "conv_client", input: "second" });
  const a = f.turn({ conversation: "conv_client", input: "third", metadata: { delay: 40 } });
  await new Promise((r) => setTimeout(r, 10));
  const b = f.turn({ conversation: "conv_client", input: "fourth" });
  await Promise.all([a, b]);
  assert.equal(f.compactions.length, 1);
  assert.equal(f.calls.at(-1).body.input, "fourth");
  assert.match(JSON.stringify(f.calls.at(-1).history), /third/);
});

test("streamed response IDs are preserved, parent/conversation IDs are rewritten, and terminal state is committed", async (t) => {
  const f = await fixture(t);
  const a = await f.turn({ input: "first" });
  const b = await f.turn({ input: "second", previous_response_id: a.id });
  const streamed = await f.request({ input: "third", previous_response_id: b.id, stream: true });
  const text = await streamed.text();
  assert.match(text, /id: keep-event-id/); assert.match(text, /streamed text/);
  assert.doesNotMatch(text, /resp_internal|sealed-prefix/);
  const events = text.split("\n").filter((x) => x.startsWith("data: ")).map((x) => JSON.parse(x.slice(6)));
  for (const event of events.filter((x) => x.response)) assert.equal(event.response.previous_response_id, b.id);
  const final = events.at(-1).response;
  await f.restart();
  await f.turn({ input: "fourth", previous_response_id: final.id });
  assert.equal(f.calls.at(-1).body.previous_response_id, final.id);
  await f.turn({ conversation: "conv_client", input: "one" });
  await f.turn({ conversation: "conv_client", input: "two" });
  const cs = await f.request({ conversation: "conv_client", input: "three", stream: true });
  const ct = await cs.text();
  for (const event of ct.split("\n").filter((x) => x.startsWith("data: ")).map((x) => JSON.parse(x.slice(6))).filter((x) => x.response)) assert.equal(event.response.conversation.id, "conv_client");
});

test("truncated streams recover by retrieving the actual upstream response, without relying on notifications", async (t) => {
  const f = await fixture(t);
  await assert.rejects(async () => { const broken = await f.request({ input: "first", stream: true, metadata: { truncate: true } }); await broken.text(); });
  const id = [...f.responses.keys()].at(-1);
  await f.restart();
  await f.turn({ input: "second", previous_response_id: id });
  assert.match(JSON.stringify(f.calls.at(-1).history), /reply resp_/);
  await assert.rejects(async () => { const cb = await f.request({ input: "first", conversation: "conv_client", stream: true, metadata: { truncate: true } }); await cb.text(); });
  await f.restart();
  const next = await f.turn({ input: "second", conversation: "conv_client" });
  assert.equal(next.conversation.id, "conv_client");
});

test("pack is last fallback; a failed trigger uses the standalone compact endpoint", async (t) => {
  const f = await fixture(t); f.failCompaction(); f.failCompactEndpoint(); f.failSummary();
  const a = await f.turn({ input: "first" });
  const b = await f.turn({ input: "second", previous_response_id: a.id });
  await f.turn({ input: "third", previous_response_id: b.id });
  assert.equal(f.compactions.length, 1);
  assert.equal(f.summaries.length, 1);
  assert.match(JSON.stringify(f.calls.at(-1).body.input), /original_messages_json/);
  const native = await fixture(t);
  native.failCompaction();
  const n1 = await native.turn({ input: "first" });
  const n2 = await native.turn({ input: "second", previous_response_id: n1.id });
  await native.turn({ input: "third", previous_response_id: n2.id });
  assert.equal(native.compactions.length, 1);
  assert.equal(native.compactEndpoints.length, 1);
  assert.equal(native.summaries.length, 0);
  assert.ok(native.calls.at(-1).body.input.some((x) => x.encrypted_content === "sealed-endpoint-prefix"));
  assert.ok(native.calls.at(-1).body.input.some((x) => x.content === "Preserved by standalone compact endpoint."));
});

test("both native failures use a same-provider summary without changing session identity", async (t) => {
  const f = await fixture(t);
  f.failCompaction(); f.failCompactEndpoint();
  const opts = { headers: { "session-id": "old-summary-session", "user-agent": "Codex test UA" } };
  await f.turn({ input: loopHistory(), prompt_cache_key: "old-summary-session", store: false }, opts);
  assert.equal(f.compactions.length, 1); assert.equal(f.compactEndpoints.length, 1); assert.equal(f.summaries.length, 1);
  const summary = f.summaries[0], generation = f.compactions[0].sessionId;
  assert.equal(generation, "old-summary-session");
  assert.equal(f.compactEndpoints[0].sessionId, generation);
  assert.equal(summary.sessionId, generation); assert.equal(summary.body.prompt_cache_key, generation);
  assert.equal(summary.authorization, "Bearer tenant-a"); assert.equal(summary.userAgent, "Codex test UA");
  assert.equal(summary.body.model, "test");
  assert.match(JSON.stringify(f.calls.at(-1).body.input), /Historical task summary/);
  assert.doesNotMatch(JSON.stringify(f.calls.at(-1).body.input), /original_messages_json/);
  await f.restart();
  await f.turn({ input: "continue", prompt_cache_key: "old-summary-session", store: false }, opts);
  assert.equal(f.calls.at(-1).sessionId, generation);
});

test("Responses summary fallback honors an external summarizer and isolates its credentials", async (t) => {
  const f = await fixture(t, { summary: { provider: "summary-fixture", model: "small" } });
  f.failCompaction(); f.failCompactEndpoint();
  await f.turn({ input: loopHistory(), store: false });
  assert.equal(f.summaries[0].authorization, "Bearer separate-summary-key");
  assert.equal(f.summaries[0].body.model, "small");
  assert.equal(f.calls.at(-1).authorization, "Bearer tenant-a");
});

test("external summary errors redact the target credential and preserve pack fallback", async (t) => {
  for (const enablePack of [false, true]) {
    const f = await fixture(t, { enablePack, summary: { provider: "summary-fixture" } });
    f.failCompaction(); f.failCompactEndpoint(); f.failSummary("service rejected separate-summary-key");
    const response = await f.request({ input: loopHistory(), store: false });
    const text = await response.text();
    assert.doesNotMatch(text, /separate-summary-key/);
    assert.equal(response.status, enablePack ? 200 : 422, text);
    if (!enablePack) assert.equal(JSON.parse(text).error.attempts.at(-1).method, "summary");
    else assert.match(JSON.stringify(f.calls.at(-1).body.input), /original_messages_json/);
  }
});

test("all failed compaction methods return explicit sanitized errors without inference or durable mapping", async (t) => {
  const f = await fixture(t, { enablePack: false });
  f.failCompaction(); f.failCompactEndpoint(); f.failSummary("summary unavailable; Bearer tenant-a; sk-test-secret");
  const opts = { headers: { "session-id": "failed-session" } };
  const response = await f.request({ input: loopHistory(), prompt_cache_key: "failed-session", store: false }, opts);
  assert.equal(response.status, 422);
  const text = await response.text(), { error } = JSON.parse(text);
  assert.equal(error.code, "compaction_failed");
  assert.deepEqual(error.attempts.map((a) => [a.method, a.status]), [["compaction_trigger", 503], ["/responses/compact", 429], ["summary", 503]]);
  assert.match(error.message, /trigger unavailable/); assert.match(error.message, /compact endpoint unavailable/); assert.match(error.message, /summary unavailable/);
  assert.doesNotMatch(text, /tenant-a|sk-test-secret/);
  assert.equal(f.calls.length, 0);
  await f.restart();
  await f.turn({ input: "small retry", prompt_cache_key: "failed-session", store: false }, opts);
  assert.equal(f.calls.at(-1).sessionId, "failed-session");
});

test("a failed conversation compaction leaves no pending journal or shadow alias", async (t) => {
  const f = await fixture(t, { enablePack: false });
  const first = await f.turn({ conversation: "conv_client", input: "first" });
  await f.turn({ conversation: "conv_client", input: "second" });
  f.failCompaction(); f.failCompactEndpoint(); f.failSummary();
  const response = await f.request({ conversation: "conv_client", input: "third" });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, "compaction_failed");
  assert.equal(f.calls.length, 2); assert.equal(f.conversations.size, 1);
  await f.restart();
  const result = await f.request(undefined, { path: `/responses/${first.id}`, method: "GET" });
  assert.equal(result.status, 200);
  const again = await f.request({ conversation: "conv_client", input: "retry third" });
  assert.equal(again.status, 422);
  assert.equal((await again.json()).error.code, "compaction_failed", "Failure must not become an ambiguous-conversation error");
});

test("pending function calls and current outputs stay together when resetting a chain", async (t) => {
  const f = await fixture(t, { maxMessages: 4 });
  const a = await f.turn({ input: "first" });
  const b = await f.turn({ input: "second", previous_response_id: a.id, metadata: { tool: true } });
  await f.turn({ previous_response_id: b.id, input: [{ type: "function_call_output", call_id: "active_call", output: "tool result" }] });
  const outgoing = f.calls.at(-1).body;
  assert.equal(outgoing.previous_response_id, undefined);
  assert.equal(outgoing.input[0].type, "compaction");
  assert.equal(outgoing.input.at(-2).type, "function_call");
  assert.equal(outgoing.input.at(-1).type, "function_call_output");
});

test("overlapping provider hosts serialize the same conversation using shared durable state", async (t) => {
  const f = await fixture(t);
  const second = await f.secondOwner();
  t.after(() => second.close());
  const unknown = await f.request({ previous_response_id: "resp_unknown", input: "next" });
  assert.equal(unknown.status, 409);
  assert.equal((await unknown.json()).error.code, "unknown_response_chain");
  assert.equal(f.calls.length, 0);
  await f.turn({ conversation: "conv_client", input: "first" });
  await f.turn({ conversation: "conv_client", input: "second" });
  const a = f.turn({ conversation: "conv_client", input: "third", metadata: { delay: 40 } });
  await new Promise((r) => setTimeout(r, 10));
  const b = second.fetch("limited", f.upstreamURL, {
    method: "POST", headers: { authorization: "Bearer tenant-a", "content-type": "application/json" },
    body: JSON.stringify({ model: "test", conversation: "conv_client", input: "fourth" }),
  }).then(async (response) => { assert.equal(response.status, 200); return response.json(); });
  await Promise.all([a, b]);
  assert.equal(f.compactions.length, 1);
  assert.match(JSON.stringify(f.calls.at(-1).history), /third/);
  assert.equal(f.calls.at(-1).body.input, "fourth");
});

test("model summaries work for server chains without leaking inference credentials", async (t) => {
  const f = await fixture(t, { summary: { provider: "summary-fixture", model: "small" } }); f.failCompaction(); f.failCompactEndpoint();
  const a = await f.turn({ input: "first" });
  const b = await f.turn({ input: "second", previous_response_id: a.id });
  await f.turn({ input: "third", previous_response_id: b.id });
  assert.equal(f.summaries.length, 1);
  assert.equal(f.summaries[0].authorization, "Bearer separate-summary-key");
  assert.match(JSON.stringify(f.calls.at(-1).body.input), /Historical task summary/);
  assert.equal(f.calls.at(-1).authorization, "Bearer tenant-a");
});

test("failed inference after pack rotation leaves the old conversation mapping intact", async (t) => {
  const f = await fixture(t); f.failCompaction(); f.failCompactEndpoint(); f.failSummary();
  await f.turn({ conversation: "conv_client", input: "first" });
  await f.turn({ conversation: "conv_client", input: "second" });
  const rejected = await f.request({ conversation: "conv_client", input: "rejected third", metadata: { reject: true } });
  assert.equal(rejected.status, 400);
  await f.restart();
  const retried = await f.turn({ conversation: "conv_client", input: "new third" });
  assert.equal(retried.conversation.id, "conv_client");
  assert.match(JSON.stringify(f.calls.at(-1).body.input), /first/);
  assert.match(JSON.stringify(f.calls.at(-1).body.input), /second/);
  assert.doesNotMatch(JSON.stringify(f.calls.at(-1).body.input), /rejected third/);
});

test("ambiguous conversation attempts remain blocked across restart rather than silently repeating", async (t) => {
  const f = await fixture(t);
  const first = await f.request({ conversation: "conv_client", input: "first", metadata: { breakBeforeID: true } });
  assert.equal(first.status, 502);
  assert.equal(f.calls.length, 1, "upstream received the request before its connection was lost");
  await f.restart();
  const next = await f.request({ conversation: "conv_client", input: "next" });
  assert.equal(next.status, 409);
  assert.equal((await next.json()).error.code, "ambiguous_conversation_request");
  assert.equal(f.calls.length, 1);
});

test("upstream gateway errors retain the ambiguous conversation journal across restart", async (t) => {
  for (const status of [502, 408]) {
    const f = await fixture(t);
    const failed = await f.request({ conversation: "conv_client", input: "first", metadata: { reject: status } });
    assert.equal(failed.status, status);
    await failed.text();
    await f.restart();
    const next = await f.request({ conversation: "conv_client", input: "retry" });
    assert.equal(next.status, 409);
    assert.equal((await next.json()).error.code, "ambiguous_conversation_request");
    assert.equal(f.calls.length, 1);
  }
});

test("background execution is rejected explicitly, and store:false responses have no durable chain", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request({ input: "background", background: true })).status, 400);
  const first = await f.turn({ input: "not stored", store: false });
  const next = await f.request({ previous_response_id: first.id, input: "next" });
  assert.equal(next.status, 409);
  assert.equal(f.calls.length, 1);
});

test("native trigger timeout leaves time to try standalone compact and inference", async (t) => {
  const f = await fixture(t, { responses: { timeoutMs: 20 } });
  f.delayCompaction(100);
  const a = await f.turn({ input: "first" });
  const b = await f.turn({ input: "second", previous_response_id: a.id });
  const c = await f.turn({ input: "third", previous_response_id: b.id });
  assert.equal(c.previous_response_id, b.id);
  assert.equal(f.compactEndpoints.length, 1);
  assert.ok(f.calls.at(-1).body.input.some((x) => x.type === "compaction"));
});

test("native chain resets replay developer messages from the compacted history", async (t) => {
  const f = await fixture(t, { maxMessages: 5 });
  const a = await f.turn({ input: [{ role: "user", content: "first" }, { role: "developer", content: "Keep this developer constraint." }] });
  const b = await f.turn({ input: "second", previous_response_id: a.id });
  await f.turn({ input: "third", previous_response_id: b.id });
  assert.equal(f.calls.at(-1).body.input[0].type, "compaction");
  assert.equal(f.calls.at(-1).body.input[1].role, "developer");
  assert.equal(f.calls.at(-1).body.input[1].content, "Keep this developer constraint.");
});


test("cancelling a streamed conversation releases the transaction and the next request recovers its journal", async (t) => {
  const f = await fixture(t);
  const response = await f.request({ conversation: "conv_client", input: "first", stream: true, metadata: { delayFinal: 100 } });
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /response.created/);
  const next = f.turn({ conversation: "conv_client", input: "second" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.calls.length, 1);
  await reader.cancel();
  assert.equal((await next).conversation.id, "conv_client");
  assert.match(JSON.stringify(f.calls.at(-1).history), /first/);
});

test("aborting an unconsumed stream releases its session lock", async (t) => {
  const f = await fixture(t);
  const abort = new AbortController();
  const response = await f.request({ conversation: "conv_client", input: "first", stream: true }, { signal: abort.signal });
  // Headers arrive before events. Even a caller that reads nothing must be
  // able to cancel while the writer is waiting for downstream backpressure.
  abort.abort();
  await assert.rejects(() => response.text());
  const next = await f.request({ conversation: "conv_client", input: "second" });
  // If no response.created reached the journal, the outcome stays ambiguous.
  assert.ok([200, 409].includes(next.status)); await next.text();
});

function loopHistory(n = 8) {
  return [{ role: "user", content: "Finish the coding task." }, ...Array.from({ length: n }, (_, i) => [
    { type: "function_call", call_id: `call_${i}`, name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: `call_${i}`, output: `result ${i}` },
  ]).flat()];
}

for (const [kind, policy, failNative, expected] of [
  ["summary", {}, true, "上下文已摘要到"],
  ["forced native", { maxRetainedRatio: 0.125 }, false, "上下文已强制压缩到"],
  ["forced summary", { maxRetainedRatio: 0.125 }, true, "上下文已强制摘要到"],
]) for (const streaming of [false, true]) {
  test(`notice identifies ${kind} (stream=${streaming})`, async (t) => {
    const f = await fixture(t, { maxMessages: 8, compactionNotice: true, ...policy });
    if (failNative) { f.failCompaction(); f.failCompactEndpoint(); }
    const response = await f.request({ input: loopHistory(), store: false, stream: streaming });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, new RegExp(`${expected} ${f.calls.at(-1).body.input.length} 条消息。`));
  });
}

test("forced conversation compaction continues from the fully compacted history", async (t) => {
  const f = await fixture(t, { maxMessages: 8, maxRetainedRatio: 0.125 });
  f.conversations.set("conv_client", loopHistory(8).map((item, index) => ({ ...item, id: `item_${index}` })));
  await f.turn({ conversation: "conv_client", input: "Newest instruction" });
  assert.equal(f.compactions.length, 1);
  assert.match(JSON.stringify(f.compactions[0].input), /Newest instruction/);
  const sent = f.calls.at(-1).body;
  assert.equal(sent.input.length, 1);
  assert.match(sent.input[0].content, /Continue the task/);
  assert.equal(f.calls.at(-1).history.filter((item) => item.content === "Newest instruction").length, 0);
  assert.ok(f.calls.at(-1).history.some((item) => item.type === "compaction"));
});

test("full-history Codex tool loops continue beyond 100 model turns with bounded native requests", async (t) => {
  const f = await fixture(t, { maxMessages: 80 });
  f.setModelTurnLimit(100);
  const input = [{ role: "user", content: "Finish the coding task." }];
  for (let i = 0; i < 130; i++) {
    const reply = await f.turn({ input, store: false, metadata: { tool: true } });
    assert.ok(f.calls.at(-1).body.input.length <= 80);
    input.push(...reply.output, { type: "function_call_output", call_id: "active_call", output: `step ${i}` });
  }
  assert.equal(f.calls.length, 130);
  assert.ok(f.compactions.length >= 2 && f.compactions.length < 8);
  assert.ok(f.compactions.slice(1).every((p) => p.input.some((i) => i.type === "compaction")));
  assert.ok(f.calls.every((call) => call.sessionId === undefined));
  assert.ok(f.compactions.every((call) => call.sessionId === undefined));
});

test("compaction notice continues tool calls through repeated native compaction", async (t) => {
  const f = await fixture(t, { maxMessages: 16, compactionNotice: true });
  let input = [{ role: "user", content: "Finish the coding task." }];
  let notices = 0;
  for (let i = 0; i < 24; i++) {
    const reply = await f.turn({ input, store: false, metadata: { tool: true } });
    const notice = reply.output.find((item) => item.type === "message" && item.content?.some((part) => /^上下文已压缩到 \d+ 条消息。\n\n$/.test(part.text)));
    const call = reply.output.find((item) => item.type === "function_call");
    assert.ok(call, `tool call missing after model turn ${i}`);
    if (notice) notices++;
    input = [...input, ...reply.output, { type: "function_call_output", call_id: call.call_id, output: `step ${i}` }];
  }
  assert.ok(notices >= 2, "the loop should continue after multiple compactions");
  assert.ok(f.compactions.length >= 2);
  assert.ok(f.compactions.slice(1).every((request) => {
    const prior = request.input.findIndex((item) => item.type === "compaction");
    const nextBatch = request.input.slice(prior + 1, -1);
    return prior >= 0 && nextBatch.some((item) => item.type === "function_call")
      && nextBatch.some((item) => item.type === "function_call_output");
  }), "later native compactions should include the previous state and a completed new tool batch");
  assert.ok(f.calls.every((call) => call.body.input.length <= 16));
});

test("one tool continuation after maxMessages 80 compaction does not compact again", async (t) => {
  const f = await fixture(t, { maxMessages: 80, compactionNotice: true });
  // A recent user turn fits under the limit, but retains almost the entire
  // active tool loop unless the planner chooses a later safe tool boundary.
  const history = [{ role: "user", content: "Earlier request." }, ...loopHistory(40)];
  const first = await f.turn({ input: history, store: false, metadata: { tool: true } });
  assert.equal(f.compactions.length, 1);
  assert.ok(f.calls[0].body.input.length <= 40, "compaction should leave room for the tool loop to continue");
  assert.ok(first.output.some((item) => item.type === "message" && item.content?.some((part) => part.text?.includes("\n\n"))));
  const call = first.output.find((item) => item.type === "function_call");
  assert.ok(call);

  const continued = await f.turn({
    input: [...history, ...first.output, { type: "function_call_output", call_id: call.call_id, output: "one tool result" }],
    store: false, metadata: { tool: true },
  });
  assert.equal(f.compactions.length, 1, "one completed tool batch should fit in the headroom left by compaction");
  assert.ok(f.calls[1].body.input.length <= 80);
  assert.ok(f.calls[1].body.input.some((item) => item.type === "compaction"));
  assert.ok(continued.output.some((item) => item.type === "function_call"));
});

test("streamed stateless compaction survives restart and SDK envelope normalization", async (t) => {
  const f = await fixture(t, { maxMessages: 8 });
  const input = loopHistory();
  const response = await f.request({ input, store: false, stream: true });
  const stream = await response.text();
  assert.match(stream, /response.completed/);
  const initial = f.compactions.length;
  await f.restart();
  // The SDK echoes the same semantic input with optional envelope fields.
  const replay = input.map((i, n) => ({ ...i, id: `sdk_${n}`, status: "completed" }));
  replay.push({ role: "assistant", content: "finished batch" }, { role: "user", content: "Continue." });
  await f.turn({ input: replay, store: false });
  assert.equal(f.compactions.length, initial, "reuses the existing compacted prefix");
  assert.equal(f.calls.at(-1).body.input[0].type, "compaction");
  assert.deepEqual(f.calls.at(-1).body.input.slice(-2), replay.slice(-2));
});

test("stateless cached compaction is isolated by credentials, model, configuration and changed input", async (t) => {
  const f = await fixture(t, { maxMessages: 8 });
  const input = loopHistory();
  await f.turn({ input, store: false });
  for (const [body, opts] of [
    [{}, { key: "tenant-b" }], [{ model: "other" }, {}], [{ instructions: "new constraints" }, {}],
    [{ input: [{ ...input[0], content: "A different task." }, ...input.slice(1)] }, {}],
  ]) {
    const before = f.compactions.length;
    await f.turn({ input, store: false, ...body }, opts);
    assert.equal(f.compactions.length, before + 1, "must not reuse a mismatched cache entry");
    assert.equal(f.compactions.at(-1).input.some((i) => i.type === "compaction"), false);
  }
});

test("Codex TUI user agent reaches both native compaction and inference", async (t) => {
  const f = await fixture(t, { maxMessages: 8 });
  const ua = "codex_cli_rs/0.172.0 (Windows; x86_64) WindowsTerminal";
  await f.turn({ input: loopHistory(), store: false }, { headers: { "user-agent": ua } });
  assert.equal(f.compactions.at(-1).userAgent, ua);
  assert.equal(f.calls.at(-1).userAgent, ua);
});

test("changing pack configuration does not reuse a cache under a different policy", async (t) => {
  const f = await fixture(t, { maxMessages: 8 });
  const input = loopHistory();
  await f.turn({ input, store: false });
  f.failCompaction(); f.failCompactEndpoint(); f.failSummary();
  const packed = await f.secondOwner({ enablePack: false, maxMessages: 8 });
  t.after(() => packed.close());
  const response = await packed.fetch("limited", f.upstreamURL, {
    method: "POST", headers: { authorization: "Bearer tenant-a", "content-type": "application/json" },
    body: JSON.stringify({ model: "test", input, store: false }),
  });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, "compaction_failed");
  assert.equal(f.compactions.length, 2);
});

test("an oversized protected current batch returns an explicit compaction failure", async (t) => {
  const f = await fixture(t, { maxMessages: 4 });
  const input = loopHistory();
  const response = await f.request({ conversation: "conv_client", input });
  assert.equal(response.status, 422);
  const { error } = await response.json();
  assert.equal(error.code, "compaction_failed");
  assert.equal(error.attempts.length, 4);
  assert.ok(error.attempts.every((a) => a.code === "no_safe_cut"));
  assert.equal(f.compactions.length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.conversations.size, 1, "No shadow conversation is created on failure");
});

test("mapped request replaces session markers together while preserving payloads and request IDs", () => {
  const headers = new Headers({ "session-id": "old", session_id: "old", "thread-id": "old", "x-session-id": "old",
    "x-codex-turn-state": "old-sticky-state", "x-client-request-id": "request-123", authorization: "Bearer tenant-a" });
  const body = { prompt_cache_key: "old", session_id: "old", conversation_id: "old", metadata: { session_id: "old", other: "preserve" },
    input: [{ role: "user", content: "Keep the actual task." }], previous_response_id: "resp_actual" };
  const original = structuredClone(body);
  const result = mappedRequest(headers, body, "new-generation");
  for (const name of ["session-id", "session_id", "thread-id", "x-session-id"]) assert.equal(result.headers.get(name), "new-generation");
  assert.equal(result.headers.has("x-codex-turn-state"), false);
  assert.equal(result.headers.get("x-client-request-id"), "request-123");
  assert.equal(result.headers.get("authorization"), "Bearer tenant-a");
  assert.equal(result.payload.prompt_cache_key, "new-generation");
  assert.equal(result.payload.metadata.session_id, "new-generation");
  assert.equal(result.payload.metadata.other, "preserve");
  assert.equal(result.payload.previous_response_id, "resp_actual");
  assert.deepEqual(body, original);
  assert.equal(headers.get("session-id"), "old");
  assert.equal(clientSessionKey(new Headers({ "session-id": "old" }), { model: "test", prompt_cache_key: "old" }),
    clientSessionKey(new Headers({ session_id: "old", "thread-id": "old" }), { model: "test", prompt_cache_key: "old" }));
});

test("request limits alone rotate persistent generations; compaction does not reset the count", async (t) => {
  const f = await fixture(t, { maxMessages: 8, stateful: { maxRequests: 2 } });
  const originalId = "codex-client-session";
  const opts = { headers: { "session-id": originalId, session_id: originalId, "thread-id": originalId,
    "x-codex-turn-state": "old-route", "x-client-request-id": "preserve-this-request-id" } };
  const input = loopHistory(), generations = [];
  for (let i = 0; i < 8; i++) {
    const reply = await f.turn({ input, prompt_cache_key: originalId, store: false }, opts);
    const call = f.calls.at(-1);
    if (i < 2) {
      assert.equal(call.sessionId, originalId);
      assert.equal(call.headers["x-codex-turn-state"], "old-route");
    } else {
      assert.match(call.sessionId, /^[0-9a-f-]{36}$/);
      assert.equal(call.headers["x-codex-turn-state"], undefined);
    }
    assert.equal(call.body.prompt_cache_key, call.sessionId);
    assert.equal(call.headers.session_id, call.sessionId);
    assert.equal(call.headers["thread-id"], call.sessionId);
    assert.equal(call.headers["x-client-request-id"], "preserve-this-request-id");
    if (i % 2 === 1) assert.equal(call.sessionId, generations.at(-1));
    else if (i > 0) assert.notEqual(call.sessionId, generations.at(-1));
    generations.push(call.sessionId);
    input.push(...reply.output, { role: "user", content: `Continue step ${i}.` });
    await f.restart();
  }
  assert.equal(new Set(generations).size, 4);
  assert.ok(f.compactions.length > 1);
});

test("identical histories in different client sessions or tenants receive distinct mappings", async (t) => {
  const f = await fixture(t, { maxMessages: 8, stateful: { maxRequests: 1 } });
  const input = loopHistory();
  const ids = [];
  for (const [client, key] of [["client-a", "tenant-a"], ["client-b", "tenant-a"], ["client-a", "tenant-b"]]) {
    await f.turn({ input: "prime", prompt_cache_key: client, store: false }, { key, headers: { "session-id": client } });
    await f.turn({ input, prompt_cache_key: client, store: false }, { key, headers: { "session-id": client } });
    ids.push(f.calls.at(-1).sessionId);
  }
  assert.equal(new Set(ids).size, 3);
  const calls = f.compactions.length;
  await f.restart();
  await f.turn({ input, prompt_cache_key: "client-a", store: false }, { headers: { "session-id": "client-a" } });
  assert.notEqual(f.calls.at(-1).sessionId, ids[0]);
  assert.equal(f.compactions.length, calls);
});

test("a failed compressed inference does not publish its tentative session mapping", async (t) => {
  const f = await fixture(t, { maxMessages: 8, stateful: { maxRequests: 1 } });
  const opts = { headers: { "session-id": "client-original" } };
  await f.turn({ input: "prime", prompt_cache_key: "client-original", store: false }, opts);
  const failed = await f.request({ input: loopHistory(), prompt_cache_key: "client-original", store: false, metadata: { reject: true } }, opts);
  assert.equal(failed.status, 400);
  await failed.text();
  assert.notEqual(f.calls.at(-1).sessionId, "client-original");
  await f.restart();
  await f.turn({ input: "uncompressed retry", prompt_cache_key: "client-original", store: false }, opts);
  assert.notEqual(f.calls.at(-1).sessionId, "client-original");
  assert.notEqual(f.calls.at(-1).sessionId, f.calls.at(-2).sessionId);
  assert.equal(f.calls.at(-1).body.prompt_cache_key, f.calls.at(-1).sessionId);
});

test("failure of both native methods with opaque history errors without publishing a session mapping", async (t) => {
  const f = await fixture(t, { maxMessages: 8 });
  f.failCompaction();
  f.failCompactEndpoint();
  const input = loopHistory();
  input.splice(1, 0, { type: "reasoning", encrypted_content: "opaque" });
  const response = await f.request({ input, prompt_cache_key: "client-original", store: false }, { headers: { "session-id": "client-original", "x-codex-turn-state": "old-route" } });
  assert.equal(response.status, 422);
  const { error } = await response.json();
  assert.equal(error.code, "compaction_failed");
  assert.equal(error.attempts.at(-1).code, "no_safe_cut");
  assert.equal(f.compactions.at(-1).sessionId, "client-original");
  assert.equal(f.compactEndpoints.at(-1).sessionId, f.compactions.at(-1).sessionId);
  assert.equal(f.calls.length, 0);
  assert.equal(f.summaries.length, 0, "Opaque history must never be sent for a lossy summary");
  await f.turn({ input: "small retry", prompt_cache_key: "client-original", store: false }, { headers: { "session-id": "client-original" } });
  assert.equal(f.calls.at(-1).sessionId, "client-original");
});

test("response-chain rotation keeps the mapped session for continuation and response retrieval", async (t) => {
  const f = await fixture(t, { stateful: { maxRequests: 2 } });
  const opts = { headers: { "session-id": "original-response-session" } };
  const a = await f.turn({ input: "first" }, opts);
  const b = await f.turn({ input: "second", previous_response_id: a.id }, opts);
  const c = await f.turn({ input: "third", previous_response_id: b.id }, opts);
  const mapped = f.calls.at(-1).sessionId;
  assert.notEqual(mapped, "original-response-session");
  assert.equal(c.previous_response_id, b.id);
  await f.restart();
  const retrieved = await f.request({}, { ...opts, path: `/responses/${c.id}`, method: "GET" });
  assert.equal(retrieved.status, 200);
  assert.equal((await retrieved.json()).id, c.id);
  assert.equal(f.managementCalls.at(-1).sessionId, mapped);
  await f.turn({ input: "fourth", previous_response_id: c.id }, opts);
  assert.equal(f.calls.at(-1).sessionId, mapped);
});

test("truncated conversation recovery uses the pending generation's ID rather than the old alias", async (t) => {
  const f = await fixture(t, { stateful: { maxRequests: 2 } });
  const opts = { headers: { "session-id": "original-conversation-session" } };
  await f.turn({ conversation: "conv_client", input: "first" }, opts);
  await f.turn({ conversation: "conv_client", input: "second" }, opts);
  const response = await f.request({ conversation: "conv_client", input: "third", stream: true, metadata: { truncate: true } }, opts);
  await assert.rejects(() => response.text());
  const mapped = f.calls.at(-1).sessionId;
  assert.notEqual(mapped, "original-conversation-session");
  await f.restart();
  const reply = await f.turn({ conversation: "conv_client", input: "fourth" }, opts);
  assert.equal(reply.conversation.id, "conv_client");
  assert.equal(f.managementCalls.at(-1).sessionId, mapped);
  assert.equal(f.calls.at(-1).sessionId, mapped);
});


test("Responses no-control passthrough preserves raw JSON and SSE and ignores retired thresholds", async (t) => {
  const seen = [];
  const rawSSE = 'event: custom\ndata: {"untouched":true}\n\n';
  const f = await fixture(t, { maxMessages: undefined, mode: "responses", maxTurns: 1, keepTurns: 1, stateful: { maxRequests: 0 } }, async (_url, init) => {
    seen.push({ body: init.body, headers: new Headers(init.headers) });
    return new Response(rawSSE, { headers: { "content-type": "text/event-stream" } });
  });
  const body = { input: loopHistory(), previous_response_id: "unknown-upstream-id", prompt_cache_key: "client", store: false };
  for (let i = 0; i < 2; i++) {
    const response = await f.request(body, { headers: { "session-id": "client", "x-codex-turn-state": "sticky" } });
    assert.equal(response.status, 200); assert.equal(await response.text(), rawSSE);
    assert.deepEqual(JSON.parse(seen.at(-1).body), { model: "test", ...body });
    assert.equal(seen.at(-1).headers.get("session-id"), "client");
    assert.equal(seen.at(-1).headers.get("x-codex-turn-state"), "sticky");
    await f.restart();
  }
});

test("Responses rotation only never compacts, accepts existing upstream response chains and survives restart", async (t) => {
  const f = await fixture(t, { maxMessages: undefined, stateful: { maxRequests: 1 } });
  // An upstream response created before this transport started is valid when
  // no history-based compression has been requested.
  f.responses.set("resp_existing", { history: [{ role: "user", content: "remote context" }], reply: {} });
  const opts = { headers: { "session-id": "rotation-client" } };
  const input = loopHistory();
  let previous = "resp_existing";
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const reply = await f.turn({ input, previous_response_id: previous }, opts);
    assert.equal(f.calls.at(-1).body.previous_response_id, previous);
    assert.deepEqual(f.calls.at(-1).body.input, input);
    ids.push(f.calls.at(-1).sessionId); previous = reply.id;
    await f.restart();
  }
  assert.equal(ids[0], "rotation-client"); assert.equal(new Set(ids).size, 4);
  assert.equal(f.compactions.length, 0); assert.equal(f.compactEndpoints.length, 0); assert.equal(f.summaries.length, 0);
  const compressing = await f.secondOwner({ maxMessages: 8 }); t.after(() => compressing.close());
  const unsafe = await compressing.fetch("limited", f.upstreamURL, { method: "POST", headers: { authorization: "Bearer tenant-a" }, body: JSON.stringify({ model: "test", previous_response_id: previous, input: "continue" }) });
  assert.equal(unsafe.status, 409); assert.equal((await unsafe.json()).error.code, "unknown_response_chain");
});

test("unsetting maxRequests ignores prior mappings even when compression or prefix replay runs", async (t) => {
  const f = await fixture(t, { maxMessages: 8, stateful: { maxRequests: 1 } });
  const body = { input: loopHistory(), prompt_cache_key: "original-client", store: false };
  const headers = { authorization: "Bearer tenant-a", "session-id": "original-client", "content-type": "application/json" };
  await f.turn({ input: "prime", prompt_cache_key: "original-client", store: false }, { headers });
  await f.turn(body, { headers }); assert.notEqual(f.calls.at(-1).sessionId, "original-client");
  for (const maxMessages of [undefined, 8]) {
    const noRotation = await f.secondOwner({ maxMessages, stateful: { enabled: true, url: f.upstreamURL } });
    try {
      const response = await noRotation.fetch("limited", f.upstreamURL, { method: "POST", headers, body: JSON.stringify({ model: "test", ...body }) });
      assert.equal(response.status, 200); await response.json();
      assert.equal(f.calls.at(-1).sessionId, "original-client");
      assert.equal(f.calls.at(-1).body.prompt_cache_key, "original-client");
    } finally { await noRotation.close(); }
  }
});

test("rotation counters are shared across response branches within one stable client session", async (t) => {
  const f = await fixture(t, { maxMessages: undefined, stateful: { maxRequests: 2 } });
  const opts = { headers: { "session-id": "branched-client" } };
  const first = await f.turn({ input: "first" }, opts);
  await f.turn({ input: "branch-a", previous_response_id: first.id }, opts);
  await f.turn({ input: "branch-b", previous_response_id: first.id }, opts);
  assert.equal(f.calls[0].sessionId, "branched-client"); assert.equal(f.calls[1].sessionId, "branched-client");
  assert.notEqual(f.calls[2].sessionId, "branched-client");
});


test("recovering a truncated response advances its stable-session counter before the next rotation", async (t) => {
  const f = await fixture(t, { maxMessages: undefined, stateful: { maxRequests: 2 } });
  const opts = { headers: { "session-id": "recover-client" } };
  const first = await f.turn({ input: "first" }, opts);
  const broken = await f.request({ previous_response_id: first.id, input: "second", stream: true, metadata: { truncate: true } }, opts);
  await assert.rejects(() => broken.text());
  const secondId = [...f.responses.keys()].at(-1);
  await f.restart();
  await f.turn({ previous_response_id: secondId, input: "third" }, opts);
  assert.equal(f.calls[0].sessionId, "recover-client"); assert.equal(f.calls[1].sessionId, "recover-client");
  assert.notEqual(f.calls[2].sessionId, "recover-client");
});


const alphaRequest = () => ({ id: "search-request-id", input: loopHistory(20),
  commands: { search_query: [{ q: "current release", recency: 7 }], open: [{ ref_id: "https://example.com", lineno: 12 }], find: [{ ref_id: "turn0search0", pattern: "version" }] },
  settings: { external_web_access: true, filters: { allowed_domains: ["example.com"] } }, max_output_tokens: 2500,
});

test("alpha search is opt-in, POST-only and never enters inference or compression", async (t) => {
  for (const enableAlphaSearch of [undefined, false, true]) {
    const f = await fixture(t, { enableAlphaSearch });
    const body = alphaRequest(), response = await f.request(body, { path: "/alpha/search", headers: { "user-agent": "Codex TUI test", "x-codex-turn-metadata": "retain-metadata", "x-openai-actor-authorization": "gateway-only" } });
    assert.equal(response.status, enableAlphaSearch ? 200 : 404);
    const data = await response.json();
    if (enableAlphaSearch) {
      assert.equal(data.encrypted_output, "opaque-search-state"); assert.equal(data.results[0].ref_id, "turn0search0");
      assert.equal(response.headers.get("x-native-search"), "retained");
      assert.deepEqual(f.alphaSearches[0].body, { model: "test", ...body });
      assert.equal(f.alphaSearches[0].headers.authorization, "Bearer tenant-a");
      assert.equal(f.alphaSearches[0].headers["user-agent"], "Codex TUI test");
      assert.equal(f.alphaSearches[0].headers["x-codex-turn-metadata"], "retain-metadata");
      assert.equal(f.alphaSearches[0].headers["x-openai-actor-authorization"], undefined);
      const wrongMethod = await f.request(null, { path: "/alpha/search", method: "GET" });
      assert.equal(wrongMethod.status, 405); await wrongMethod.json();
    } else assert.equal(f.alphaSearches.length, 0);
    assert.equal(f.calls.length, 0); assert.equal(f.compactions.length, 0); assert.equal(f.compactEndpoints.length, 0); assert.equal(f.summaries.length, 0);
  }
});

test("alpha search preserves raw JSON, encrypted output, upstream errors and provider isolation", async (t) => {
  const seen = [], text = '{ "encrypted_output": "opaque", "output": "unchanged", "results": [] }';
  const f = await fixture(t, { maxMessages: undefined, enableAlphaSearch: true }, async (url, init) => {
    seen.push({ url: String(url), body: init.body });
    return new Response(seen.length === 1 ? text : '{"error":{"code":"search_refused"}}', {
      status: seen.length === 1 ? 200 : 429, headers: { "content-type": "application/json", "x-upstream": "keep" },
    });
  });
  const owner = await f.secondOwner(); t.after(() => owner.close());
  const raw = '{ "model": "test", "commands": { "open": [{"ref_id":"https://example.com"}] }, "extra": true }';
  // Use the stubbed transport so upstream JSON never gets parsed/reencoded.
  const response = await f.request(alphaRequest(), { path: "/alpha/search?trace=1" });
  assert.equal(await response.text(), text); assert.match(seen[0].url, /alpha\/search\?trace=1$/);
  const failed = await f.request(alphaRequest(), { path: "/alpha/search" });
  assert.equal(failed.status, 429); assert.equal(await failed.text(), '{"error":{"code":"search_refused"}}');
  assert.equal(failed.headers.get("x-upstream"), "keep");
  const forbidden = await f.request(alphaRequest(), { path: "/alpha/search/other" });
  assert.equal(forbidden.status, 404); await forbidden.json();
  assert.equal(seen.length, 2);
  // A real native route accepts arbitrary future fields and preserves bytes.
  const native = await owner.fetch("limited", f.upstreamURL.replace("responses", "alpha/search"), { method: "POST", headers: { authorization: "Bearer tenant-a", "content-type": "application/json" }, body: raw });
  assert.equal(native.status, 200); await native.json();
  assert.equal(f.alphaSearches[0].raw, raw);
});

test("alpha search follows committed session rotation without incrementing or resetting request counts", async (t) => {
  const f = await fixture(t, { enableAlphaSearch: true, stateful: { maxRequests: 2 } });
  const opts = { headers: { "session-id": "search-client", "thread-id": "search-client", "x-codex-turn-state": "old-state" } };
  const search = async () => {
    const response = await f.request({ ...alphaRequest(), prompt_cache_key: "search-client" }, { ...opts, path: "/alpha/search" });
    assert.equal(response.status, 200); await response.json(); return f.alphaSearches.at(-1);
  };
  assert.equal((await search()).sessionId, "search-client");
  await f.turn({ input: "one", prompt_cache_key: "search-client", store: false }, opts);
  await search(); await search();
  await f.turn({ input: "two", prompt_cache_key: "search-client", store: false }, opts);
  assert.equal(f.calls.at(-1).sessionId, "search-client");
  assert.equal((await search()).sessionId, "search-client", "Searching at the limit must not rotate by itself");
  await f.turn({ input: "three", prompt_cache_key: "search-client", store: false }, opts);
  const mapped = f.calls.at(-1).sessionId; assert.notEqual(mapped, "search-client");
  await f.restart();
  const actual = await search(); assert.equal(actual.sessionId, mapped); assert.equal(actual.body.prompt_cache_key, mapped);
  assert.equal(actual.body.id, "search-request-id"); assert.equal(actual.headers["x-codex-turn-state"], undefined);
  const isolated = await f.request({ ...alphaRequest(), prompt_cache_key: "search-client" }, { ...opts, key: "tenant-b", path: "/alpha/search" });
  assert.equal(isolated.status, 200); await isolated.json();
  assert.equal(f.alphaSearches.at(-1).sessionId, "search-client", "Another account must not reuse this tenant's session mapping");
  await f.turn({ input: "four", prompt_cache_key: "search-client", store: false }, opts);
  assert.equal(f.calls.at(-1).sessionId, mapped); assert.equal(f.compactions.length, 0);
});
