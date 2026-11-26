import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSessionTransport } from "../lib/session-transport.js";

async function fixture(t, policy = {}, fetchImpl) {
  const root = await mkdtemp(join(tmpdir(), "magpie-server-session-test-"));
  const responses = new Map(), conversations = new Map([["conv_client", []]]), calls = [], compactions = [], summaries = [];
  let counter = 0, failCompaction = false, delayCompaction = 0;
  const upstream = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://local");
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      res.setHeader("content-type", "application/json");
      if (req.url === "/summarize") {
        summaries.push({ body, authorization: req.headers.authorization });
        res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "Historical task summary." } }] })); return;
      }
      if (req.method === "GET" && /^\/v1\/responses\/[^/]+$/.test(url.pathname)) {
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
      if (req.method === "POST" && url.pathname === "/v1/conversations") {
        const id = `conv_shadow_${++counter}`;
        conversations.set(id, (body.items ?? []).map((x) => ({ ...x, id: x.id ?? `item_${++counter}` })));
        res.end(JSON.stringify({ id, object: "conversation" })); return;
      }
      if (req.method === "GET" && /^\/v1\/conversations\/[^/]+$/.test(url.pathname)) {
        res.end(JSON.stringify({ id: url.pathname.split("/").at(-1), object: "conversation" })); return;
      }
      if (req.method !== "POST" || url.pathname !== "/v1/responses") { res.writeHead(404).end("{}"); return; }
      if (body.input?.at(-1)?.type === "compaction_trigger") {
        compactions.push(body);
        if (delayCompaction) await new Promise((r) => setTimeout(r, delayCompaction));
        if (failCompaction) { res.writeHead(503).end("{}"); return; }
        res.end(JSON.stringify({ id: `resp_internal_${++counter}`, status: "completed", output: [{ type: "compaction", id: `cmp_${counter}`, encrypted_content: "sealed-prefix" }] })); return;
      }
      const incoming = typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input ?? [];
      const conversation = typeof body.conversation === "string" ? body.conversation : body.conversation?.id;
      const previous = body.previous_response_id && responses.get(body.previous_response_id);
      if (body.previous_response_id && !previous) { res.writeHead(404).end("{}"); return; }
      const base = conversation ? conversations.get(conversation) : previous?.history ?? [];
      if (!base) { res.writeHead(404).end("{}"); return; }
      calls.push({ body, authorization: req.headers.authorization, history: [...base, ...incoming] });
      if (body.metadata?.reject) { res.writeHead(400).end(JSON.stringify({ error: { message: "deliberate request rejection" } })); return; }
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
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "streamed text" })}\n\n`);
      res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: reply })}\n\n`);
    } catch (error) { res.writeHead(500).end(JSON.stringify({ error: String(error) })); }
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const upstreamURL = `http://127.0.0.1:${upstream.address().port}/v1/responses`;
  const options = { providers: { limited: {
    maxMessages: 4, maxTurns: 2, keepTurns: 1, mode: "responses", ...policy,
    ...(policy.mode === "summary" && !policy.summary ? { summary: { url: upstreamURL.replace("/v1/responses", "/summarize"), model: "small" } } : {}),
    stateful: { enabled: true, url: upstreamURL, ...policy.stateful },
  } } };
  let proxy = await createSessionTransport(options, { stateDir: root, fetchImpl });
  async function request(body, { key = "tenant-a", path = "/responses", method = "POST", signal } = {}) {
    return proxy.fetch("limited", `${upstreamURL.replace(/\/responses$/, "")}${path}`, {
      method, signal, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
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
    root, upstreamURL, calls, compactions, summaries, conversations, responses, request, turn,
    failCompaction() { failCompaction = true; },
    delayCompaction(ms) { delayCompaction = ms; },
    async restart() { await proxy.close(); proxy = await createSessionTransport(options, { stateDir: root, fetchImpl }); },
    async secondOwner() { return createSessionTransport(options, { stateDir: root }); },
  };
}

test("previous_response_id creates a fresh compacted chain and echoes the client's parent", async (t) => {
  const f = await fixture(t);
  const a = await f.turn({ input: "first" });
  const b = await f.turn({ input: "second", previous_response_id: a.id });
  const c = await f.turn({ input: "third", previous_response_id: b.id, instructions: "preserve", tools: [{ type: "function", name: "read", parameters: {} }] });
  assert.equal(c.previous_response_id, b.id);
  assert.equal(f.compactions.length, 1);
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

test("server chain request counts can trigger compaction independently of user/message counts", async (t) => {
  const f = await fixture(t, { maxMessages: 100, maxTurns: 100, stateful: { maxRequests: 2 } });
  const a = await f.turn({ input: "first" });
  const b = await f.turn({ input: "second", previous_response_id: a.id });
  await f.turn({ input: "third", previous_response_id: b.id });
  assert.equal(f.compactions.length, 1);
  assert.equal(f.calls.at(-1).body.previous_response_id, undefined);
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
    assert.equal((await stat(join(f.root, file))).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(join(f.root, file), "utf8"), /Bearer tenant-a/);
  }
});

test("immutable response snapshots preserve branches from the same parent", async (t) => {
  const f = await fixture(t, { maxMessages: 100, maxTurns: 100 });
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

test("pack handles server-side history without a model endpoint; failed native compaction falls back safely", async (t) => {
  const f = await fixture(t, { mode: "pack" });
  const a = await f.turn({ input: "first" });
  const b = await f.turn({ input: "second", previous_response_id: a.id });
  await f.turn({ input: "third", previous_response_id: b.id });
  assert.equal(f.compactions.length, 0);
  assert.match(JSON.stringify(f.calls.at(-1).body.input), /original_messages_json/);
  const native = await fixture(t);
  native.failCompaction();
  const n1 = await native.turn({ input: "first" });
  const n2 = await native.turn({ input: "second", previous_response_id: n1.id });
  await native.turn({ input: "third", previous_response_id: n2.id });
  assert.equal(native.compactions.length, 1);
  assert.match(JSON.stringify(native.calls.at(-1).body.input), /original_messages_json/);
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
  const f = await fixture(t, { mode: "summary" });
  const a = await f.turn({ input: "first" });
  const b = await f.turn({ input: "second", previous_response_id: a.id });
  await f.turn({ input: "third", previous_response_id: b.id });
  assert.equal(f.summaries.length, 1);
  assert.equal(f.summaries[0].authorization, undefined);
  assert.match(JSON.stringify(f.calls.at(-1).body.input), /Historical task summary/);
  assert.equal(f.calls.at(-1).authorization, "Bearer tenant-a");
});

test("failed inference after pack rotation leaves the old conversation mapping intact", async (t) => {
  const f = await fixture(t, { mode: "pack" });
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
  await f.restart();
  const next = await f.request({ conversation: "conv_client", input: "next" });
  assert.equal(next.status, 409);
  assert.equal((await next.json()).error.code, "ambiguous_conversation_request");
  assert.equal(f.calls.length, 1);
});

test("background execution is rejected explicitly, and store:false responses have no durable chain", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request({ input: "background", background: true })).status, 400);
  const first = await f.turn({ input: "not stored", store: false });
  const next = await f.request({ previous_response_id: first.id, input: "next" });
  assert.equal(next.status, 409);
  assert.equal(f.calls.length, 1);
});

test("native compaction timeout leaves time to run the actual request using the pack fallback", async (t) => {
  const f = await fixture(t, { responses: { timeoutMs: 20 } });
  f.delayCompaction(100);
  const a = await f.turn({ input: "first" });
  const b = await f.turn({ input: "second", previous_response_id: a.id });
  const c = await f.turn({ input: "third", previous_response_id: b.id });
  assert.equal(c.previous_response_id, b.id);
  assert.match(JSON.stringify(f.calls.at(-1).body.input), /original_messages_json/);
});

test("native chain resets replay developer messages from the compacted history", async (t) => {
  const f = await fixture(t, { maxMessages: 6 });
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
