// Real Magpie Provider + Bun host. No user settings or
// real upstream accounts are accessed; all HTTP model calls stay on loopback.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, readdir, mkdir, copyFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";

const sandbox = await mkdtemp(join(tmpdir(), "magpie-autocompact-integration-"));
// Reuse installed runtime binaries without sharing settings or mutable state.
// A cold isolated cache otherwise makes tests depend on a Bun download finishing
// within Magpie's plugin-start deadline.
const runtimeCache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "magpie", "bun");
try {
  for (const entry of await readdir(runtimeCache, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+\.\d+\.\d+$/.test(entry.name)) continue;
    const target = join(sandbox, ".cache", "magpie", "bun", entry.name);
    await mkdir(target, { recursive: true });
    const executable = process.platform === "win32" ? "magpie-bun.exe" : "magpie-bun";
    try { await copyFile(join(runtimeCache, entry.name, executable), join(target, executable)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
} catch (error) { if (error.code !== "ENOENT") throw error; }
const upstreamRequests = [], upstreamCredentials = [], compactCredentials = [], modelCredentials = [];
const upstreamSessions = [], compactSessions = [];
const nativeSearchRequests = [];
let summaryCalls = 0, compactCalls = 0, rejectSummary = false, gateway, logs = "";
let rejectTrigger = false, rejectCompact = false, rejectProviderSummary = false, rejectMessageSummary = false;
const compactionAttempts = [];
const messageRequests = [], messageSummaries = [];
const storedResponses = new Map(), storedConversations = new Map([["conv_integration", []]]);
let responseNumber = 0;
const upstream = createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  if (req.method === "GET") {
    res.setHeader("content-type", "application/json");
    const path = new URL(req.url, "http://localhost").pathname;
    if (/^\/v1\/responses\//.test(path)) { res.end(JSON.stringify(storedResponses.get(path.split("/").at(-1))?.reply ?? {})); return; }
    if (/^\/v1\/conversations\/[^/]+\/items$/.test(path)) { res.end(JSON.stringify({ data: storedConversations.get(path.split("/").at(-2)) ?? [], has_more: false })); return; }
    modelCredentials.push(req.headers.authorization);
    res.end(JSON.stringify({ object: "list", data: [{ id: "test", object: "model" }] })); return;
  }
  const body = JSON.parse(raw);
  if (req.url === "/v1/alpha/search") {
    nativeSearchRequests.push({ body, headers: { ...req.headers } });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ encrypted_output: "native-search-cipher", output: "Native alpha search result", results: [
      { type: "text_result", ref_id: "turn0search0", url: "https://example.com/result" },
    ] })); return;
  }
  if (["/v1/chat/completions", "/v1/messages"].includes(req.url)) {
    const isSummary = (req.url === "/v1/messages" ? body.system : body.messages?.[0]?.content)?.startsWith?.("Summarize the historical conversation");
    const row = { path: req.url, body, headers: { ...req.headers } };
    (isSummary ? messageSummaries : messageRequests).push(row);
    if (isSummary) {
      if (rejectMessageSummary) { res.writeHead(503).end(JSON.stringify({ error: { message: "Message summary unavailable" } })); return; }
      const text = "Summary from message model.";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/v1/messages" ? { type: "message", content: [{ type: "text", text }], stop_reason: "end_turn" }
        : { choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }] })); return;
    }
    if (req.url === "/v1/messages") {
      const reply = { id: `msg_local_${++responseNumber}`, type: "message", role: "assistant", model: body.model,
        content: [{ type: "text", text: "anthropic reply" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 3 } };
      if (!body.stream) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(reply)); return; }
      res.setHeader("content-type", "text/event-stream");
      for (const event of [
        { type: "message_start", message: { ...reply, content: [], stop_reason: null } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "anthropic reply" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
        { type: "message_stop" },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end(); return;
    }
  }
  if (req.url === "/v1/conversations") {
    const id = `conv_shadow_${++responseNumber}`; storedConversations.set(id, body.items ?? []);
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id, object: "conversation" })); return;
  }
  if (req.url === "/summary-api/v1/chat/completions") {
    summaryCalls++;
    assert.equal(req.headers.authorization, "Bearer local-summary-key");
    assert.equal(req.headers["session-id"], undefined);
    assert.equal(body.model, "small-actual");
    assert.equal(body.messages[0].content, "自定义摘要提示词：保留任务与待办，只输出摘要。");
    if (rejectSummary) { res.writeHead(503).end("{}"); return; }
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "Summary from internal model." } }] })); return;
  }
  if (req.url === "/v1/responses/compact") {
    compactionAttempts.push("compact");
    if (rejectCompact) { res.writeHead(429).end(JSON.stringify({ error: { type: "rate_limit_error", message: "compact endpoint unavailable" } })); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "compact_window", object: "response.compaction", output: [{ type: "compaction", encrypted_content: "standalone-opaque-context" }] })); return;
  }
  if (body.input?.at(-1)?.type === "compaction_trigger") {
    compactionAttempts.push("trigger");
    compactCalls++; compactCredentials.push(req.headers.authorization);
    compactSessions.push({ id: req.headers["session-id"], cacheKey: body.prompt_cache_key });
    if (rejectTrigger) { res.writeHead(503).end(JSON.stringify({ error: { message: "trigger unavailable" } })); return; }
    assert.equal(body.stream, true);
    res.setHeader("content-type", "text/event-stream");
    res.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_compact", object: "response", status: "completed", output: [{ type: "compaction", id: "cmp_local", encrypted_content: "local-opaque-context" }] } })}\n\n`); return;
  }
  if (body.input?.[0]?.role === "system" && body.input[0].content?.startsWith("Summarize the historical conversation for continuation.")) {
    compactionAttempts.push("summary");
    if (rejectProviderSummary) { res.writeHead(503).end(JSON.stringify({ error: { message: "provider summary unavailable" } })); return; }
    res.setHeader("content-type", "text/event-stream");
    res.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: "summary_internal", status: "completed", output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Summary from provider model." }] },
    ] } })}\n\n`); return;
  }
  upstreamRequests.push(body); upstreamCredentials.push(req.headers.authorization);
  upstreamSessions.push({ id: req.headers["session-id"], cacheKey: body.prompt_cache_key });
  if (req.url.includes("responses")) {
    const id = `resp_local_${++responseNumber}`;
    const conversation = typeof body.conversation === "string" ? body.conversation : body.conversation?.id;
    const input = typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input ?? [];
    const base = conversation ? storedConversations.get(conversation) ?? [] : storedResponses.get(body.previous_response_id)?.history ?? [];
    const reply = { id, object: "response", status: "completed", model: "test", previous_response_id: body.previous_response_id ?? null, conversation: conversation ? { id: conversation } : null,
      output: [{ type: "message", id: `msg_${responseNumber}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "native reply", annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
    const history = [...base, ...input, ...reply.output]; storedResponses.set(id, { reply, history });
    if (conversation) storedConversations.set(conversation, history);
    if (body.stream) {
      res.setHeader("content-type", "text/event-stream");
      res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { ...reply, status: "in_progress", output: [] } })}\n\n`);
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: reply.output[0].id, output_index: 0, content_index: 0, delta: "native reply" })}\n\n`);
      res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: reply })}\n\n`);
    } else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(reply)); }
    return;
  }
  const reply = { id: "chatcmpl-local", object: "chat.completion", created: 1, model: "test", choices: [{ index: 0, message: { role: "assistant", content: "transparent reply" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
  if (body.stream) {
    res.setHeader("content-type", "text/event-stream");
    for (const [delta, finish_reason] of [[{ role: "assistant", content: "transparent " }, null], [{ content: "reply" }, null], [{}, "stop"]])
      res.write(`data: ${JSON.stringify({ id: reply.id, object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  } else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(reply)); }
});
upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
const upstreamURL = `http://127.0.0.1:${upstream.address().port}`;
const portProbe = createServer(); portProbe.listen(0, "127.0.0.1"); await once(portProbe, "listening");
const addr = `127.0.0.1:${portProbe.address().port}`; await new Promise((r) => portProbe.close(r));
// The Windows .com launcher starts a separate .exe. Killing that launcher
// leaves its gateway alive; spawn the actual CLI process so restarts stop it.
const magpie = process.env.MAGPIE_BIN ?? (process.platform === "win32"
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "magpie", "magpie.exe") : "magpie");
const env = { ...process.env, ...(process.platform === "win32" ? { MAGPIE_COM: "1" } : {}), HOME: sandbox, XDG_CONFIG_HOME: join(sandbox, ".config"), XDG_CACHE_HOME: join(sandbox, ".cache"), XDG_STATE_HOME: join(sandbox, ".state"), XDG_DATA_HOME: join(sandbox, ".local/share"), MAGPIE_ADDR: addr, MAGPIE_NO_ACCOUNTS: "0" };

function command(args, input = "") {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(magpie, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(input);
    let out = "", errors = "";
    child.stdout.on("data", (b) => out += b);
    child.stderr.on("data", (b) => errors += b);
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      // Plugin hosts may inherit a CLI pipe after the CLI itself exits. Keep
      // collecting output without letting those inherited handles pin Node.
      child.stdout.unref?.(); child.stderr.unref?.();
      if (code === 0) resolveCommand(out); else reject(new Error(`magpie ${args.slice(0, 2).join(" ")} failed: ${errors}${out}`));
    });
  });
}

async function stopGateway() {
  if (!gateway || gateway.exitCode !== null) return;
  gateway.kill("SIGTERM");
  const kill = setTimeout(() => gateway.kill("SIGKILL"), 3000);
  await once(gateway, "exit"); clearTimeout(kill);
}

async function startGateway() {
  gateway = spawn(magpie, ["serve"], { env, stdio: ["pipe", "pipe", "pipe"] });
  gateway.stdout.on("data", (b) => logs = (logs + b).slice(-32000)); gateway.stderr.on("data", (b) => logs = (logs + b).slice(-32000));
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (gateway.exitCode !== null) throw new Error(`gateway exited: ${logs}`);
    try { const res = await fetch(`http://${addr}/v1/models`, { headers: { authorization: "Bearer magpie" }, signal: AbortSignal.timeout(500) }); if (res.ok) { ready = true; break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, logs);
}

const messages = Array.from({ length: 8 }, (_, i) => [{ role: "user", content: `question ${i}: ${"history ".repeat(30)}` }, ...(i === 7 ? [] : [{ role: "assistant", content: `answer ${i}` }])]).flat();
async function request(path, body, headers = {}, expectedStatus = 200) {
  let response;
  try {
    response = await fetch(`http://${addr}/v1/${path}`, { method: "POST", headers: { ...headers, authorization: "Bearer magpie", "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  } catch (error) {
    throw new Error(`Gateway ${path} request failed (expected ${expectedStatus}; recent compaction attempts: ${compactionAttempts.slice(-12).join(", ")}): ${error.message}`, { cause: error });
  }
  const text = await response.text(); assert.equal(response.status, expectedStatus, text); return text;
}

async function configure(overrides = {}) {
  await command(["plugin", "options", "magpie-autocompact", JSON.stringify({ providers: { session: {
    key: "local-session-key", baseURL: `${upstreamURL}/v1`, models: ["test"], stateDir: join(sandbox, "session-state"),
    maxMessages: 4, enablePack: true, headers: { "session-id": "codex-integration-client", "thread-id": "codex-integration-client" }, ...overrides,
  }, ...(overrides.summary?.provider === "summary-helper" ? { "summary-helper": {
    protocol: "chat", baseURL: `${upstreamURL}/summary-api/v1`, key: "local-summary-key", models: { small: { id: "small-actual" } },
  } } : {}) } })]);
}

try {
  await command(["plugin", "add", resolve(".")]);
  const fresh = JSON.parse(await command(["plugin", "list", "--json"]));
  assert.deepEqual(fresh.loaded.find((p) => p.spec === resolve(".")).provides ?? [], []);
  await command(["provider", "add", "Plain", "id=plain", `url=${upstreamURL}/v1`, "key=local-plain-key", "models=test", "list=off"]);
  await configure();
  // The package registers only its Provider; no gateway request hooks or
  // JavaScript middleware should be loaded alongside it.
  const installed = JSON.parse(await command(["plugin", "list", "--json"]));
  assert.deepEqual(installed.loaded.find((p) => p.spec === resolve(".")).provides, ["session"]);
  assert.equal(Object.keys(installed.middleware ?? {}).length, 0);
  await startGateway();
  const native = JSON.parse(await request("responses", { model: "session/test", input: messages, stream: false, instructions: "keep system" }));
  assert.equal(native.output[0].content[0].text, "native reply");
  assert.equal(compactCalls, 1, logs);
  assert.equal(upstreamRequests.at(-1).input[0].type, "compaction");
  assert.ok(upstreamRequests.at(-1).input.length <= 4);
  assert.equal(upstreamRequests.at(-1).instructions, "keep system");

  const loop = [{ role: "user", content: "Complete a long coding task." }, ...Array.from({ length: 100 }, (_, i) => [
    { type: "function_call", call_id: `loop_${i}`, name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: `loop_${i}`, output: `result ${i}` },
  ]).flat()];
  const loopTools = [{ type: "function", name: "read", parameters: { type: "object", properties: {} } }];
  const clientId = "codex-integration-client";
  const sessionHeaders = { "session-id": clientId, "thread-id": clientId };
  await request("responses", { model: "session/test", input: loop, tools: loopTools, prompt_cache_key: clientId, store: false, stream: false }, sessionHeaders);
  assert.equal(upstreamRequests.at(-1).input[0].type, "compaction");
  assert.ok(upstreamRequests.at(-1).input.length <= 4);
  assert.deepEqual(upstreamRequests.at(-1).input.slice(-2), loop.slice(-2));
  const mappedId = upstreamSessions.at(-1).id;
  assert.equal(mappedId, clientId, "compression alone preserves the client session ID");
  assert.equal(upstreamSessions.at(-1).cacheKey, clientId);
  assert.deepEqual(compactSessions.at(-1), { id: mappedId, cacheKey: clientId });
  const beforeReplay = compactCalls;
  await stopGateway();
  await startGateway();
  await request("responses", { model: "session/test", input: loop, tools: loopTools, prompt_cache_key: clientId, store: false, stream: true }, sessionHeaders);
  assert.equal(compactCalls, beforeReplay, "real Magpie full-history replay reuses native compaction");
  assert.equal(upstreamRequests.at(-1).input[0].type, "compaction");
  assert.equal(upstreamSessions.at(-1).id, mappedId, "upstream session mapping survives a real host restart");
  await request("responses", { model: "session/test", input: [...loop,
    { type: "function_call", call_id: "next_batch", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "next_batch", output: "next result" }],
  tools: loopTools, prompt_cache_key: clientId, store: false, stream: false }, sessionHeaders);
  assert.equal(upstreamSessions.at(-1).id, mappedId, "another compaction still preserves session identity");
  assert.equal(upstreamSessions.at(-1).cacheKey, clientId);

  // Use different histories so successful prefix caches cannot skip a stage.
  const fallbackInput = (label) => [{ ...messages[0], content: label }, ...messages.slice(1)];
  rejectTrigger = true;
  let attemptStart = compactionAttempts.length;
  await request("responses", { model: "session/test", input: fallbackInput("standalone fallback"), stream: false });
  assert.deepEqual(compactionAttempts.slice(attemptStart), ["trigger", "compact"]);
  assert.equal(upstreamRequests.at(-1).input[0].encrypted_content, "standalone-opaque-context");
  rejectCompact = true;
  attemptStart = compactionAttempts.length;
  await request("responses", { model: "session/test", input: fallbackInput("summary fallback"), stream: false });
  assert.deepEqual(compactionAttempts.slice(attemptStart), ["trigger", "compact", "summary"]);
  assert.match(JSON.stringify(upstreamRequests.at(-1).input), /Summary from provider model/);
  assert.doesNotMatch(JSON.stringify(upstreamRequests.at(-1).input), /original_messages_json/);
  rejectProviderSummary = true;
  await stopGateway(); await configure({ enablePack: false }); await startGateway();
  const beforeFailure = upstreamRequests.length;
  attemptStart = compactionAttempts.length;
  const failed = await request("responses", { model: "session/test", input: fallbackInput("all compaction methods fail"), stream: false }, {}, 422);
  assert.deepEqual(compactionAttempts.slice(attemptStart), ["trigger", "compact", "summary"], "Exhausted policy must not trigger host retries");
  assert.match(failed, /compaction_failed/); assert.match(failed, /trigger unavailable/);
  assert.match(failed, /compact endpoint unavailable/); assert.match(failed, /provider summary unavailable/);
  assert.equal(upstreamRequests.length, beforeFailure, "All failures must stop before inference");
  rejectTrigger = rejectCompact = rejectProviderSummary = false;
  await stopGateway(); await configure(); await startGateway();

  const first = JSON.parse(await request("responses", { model: "session/test", input: "first", stream: false }));
  const second = JSON.parse(await request("responses", { model: "session/test", input: "second", previous_response_id: first.id, stream: false }));
  const beforeSession = compactCalls;
  const third = JSON.parse(await request("responses", { model: "session/test", input: "third", previous_response_id: second.id, stream: false }));
  // Magpie expands known response IDs before invoking Provider plugins.
  // The client continues by ID; the Provider receives and compacts history.
  assert.equal(third.output[0].content[0].text, "native reply");
  assert.equal(compactCalls, beforeSession + 1);
  assert.equal(compactCredentials.at(-1), "Bearer local-session-key");
  assert.equal(upstreamRequests.at(-1).previous_response_id, undefined);
  assert.equal(upstreamRequests.at(-1).input[0].type, "compaction");
  const sessionStream = await request("responses", { model: "session/test", input: "fourth", previous_response_id: third.id, stream: true });
  assert.match(sessionStream, /response.completed/);
  assert.match(sessionStream, /native reply/);

  await request("responses", { model: "session/test", conversation: "conv_integration", input: "first", stream: false });
  await request("responses", { model: "session/test", conversation: "conv_integration", input: "second", stream: false });
  const conversation = JSON.parse(await request("responses", { model: "session/test", conversation: "conv_integration", input: "third", stream: false }));
  assert.equal(conversation.conversation.id, "conv_integration");
  assert.notEqual(upstreamRequests.at(-1).conversation, "conv_integration");
  const translated = JSON.parse(await request("chat/completions", { model: "session/test", messages, stream: false }));
  assert.equal(translated.choices[0].message.content, "native reply");
  assert.ok(upstreamRequests.at(-1).input.length <= 4);
  await stopGateway();
  await startGateway();
  const resumed = JSON.parse(await request("responses", { model: "session/test", previous_response_id: third.id, input: "after gateway restart", stream: false }));
  assert.equal(resumed.output[0].content[0].text, "native reply");
  const resumedConversation = JSON.parse(await request("responses", { model: "session/test", conversation: "conv_integration", input: "after restart", stream: false }));
  assert.equal(resumedConversation.conversation.id, "conv_integration");

  await stopGateway();
  await configure({ maxMessages: 6, summary: { provider: "summary-helper", model: "small", prompt: "自定义摘要提示词：保留任务与待办，只输出摘要。" } });
  rejectTrigger = rejectCompact = true;
  await startGateway();
  const summarized = JSON.parse(await request("responses", { model: "session/test", input: messages, stream: false }));
  assert.equal(summarized.output[0].content[0].text, "native reply");
  assert.ok(upstreamRequests.at(-1).input.length <= 6);
  assert.match(JSON.stringify(upstreamRequests.at(-1).input), /Summary from internal model/);
  assert.equal(summaryCalls, 1);
  await request("chat/completions", { model: "plain/test", messages, stream: false });
  assert.equal(upstreamRequests.at(-1).messages.length, messages.length);
  assert.equal(summaryCalls, 1, "other providers are unaffected");
  const stream = await request("responses", { model: "session/test", input: messages, stream: true });
  assert.match(stream, /native reply/); assert.match(stream, /response.completed/);
  assert.equal(summaryCalls, 1, "identical full-history requests reuse the successful summary prefix");
  rejectSummary = true;
  await request("responses", { model: "session/test", input: [{ ...messages[0], content: "different uncached history" }, ...messages.slice(1)], stream: false });
  assert.match(JSON.stringify(upstreamRequests.at(-1).input), /original_messages_json/);

  await stopGateway();
  await configure({ maxMessages: 6 });
  rejectTrigger = rejectCompact = rejectProviderSummary = true;
  await startGateway();
  const toolTail = [
    { type: "function_call", call_id: "call_local", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "call_local", output: "tool result retained" },
  ];
  const tools = [{ type: "function", name: "read", parameters: { type: "object", properties: {} } }];
  const beforePack = summaryCalls;
  await request("responses", { model: "session/test", input: [...messages, ...toolTail], tools, stream: false });
  const packed = upstreamRequests.at(-1);
  assert.ok(packed.input.length <= 6);
  assert.match(JSON.stringify(packed.input[0]), /original_messages_json/);
  assert.deepEqual(packed.input.slice(-2), toolTail);
  assert.equal(packed.tools[0].name, "read");
  assert.equal(summaryCalls, beforePack, "default summary uses the provider endpoint, not the external service");
  assert.deepEqual(compactionAttempts.slice(-3), ["trigger", "compact", "summary"]);
  rejectTrigger = rejectCompact = rejectProviderSummary = false;
  await stopGateway();
  // Rotation is controlled only by successful inference count, even when the
  // effective history is large enough that native compression would run.
  await configure({ maxMessages: 4, maxRequests: 2 }); await startGateway();
  const beforeCount = compactionAttempts.length;
  for (let i = 0; i < 4; i++) {
    await request("responses", { model: "session/test", input: fallbackInput(`rotation ${i}`), prompt_cache_key: "rotation-key", store: false, stream: i % 2 === 1 });
  }
  const rotated = upstreamSessions.slice(-4).map((row) => row.id);
  // Earlier tests already used the configured client ID, so changing to a
  // new prompt_cache_key provides a distinct session counter.
  assert.equal(rotated[0], "codex-integration-client"); assert.equal(rotated[1], rotated[0]);
  assert.notEqual(rotated[2], rotated[0]); assert.equal(rotated[3], rotated[2]);
  assert.ok(compactionAttempts.length > beforeCount);
  await stopGateway();
  await configure({ maxMessages: undefined, maxRequests: 1 }); await startGateway();
  const beforeRotationOnly = compactionAttempts.length;
  for (let i = 0; i < 2; i++) {
    await request("responses", { model: "session/test", input: fallbackInput(`rotation-only ${i}`), prompt_cache_key: "rotation-only-key", store: false, stream: i === 1 });
    assert.equal(upstreamRequests.at(-1).input.length, messages.length);
  }
  assert.equal(compactionAttempts.length, beforeRotationOnly);
  assert.notEqual(upstreamSessions.at(-1).id, upstreamSessions.at(-2).id);
  await stopGateway();
  const multi = { providers: {
    compact_a: { name: "配置供应商 A", baseURL: `${upstreamURL}/v1`, key: "configured-key-a", models: ["test"], maxMessages: 6, enablePack: true, enableAlphaSearch: true, compactionNotice: "Context compacted" },
    compact_b: { name: "配置供应商 B", baseURL: `${upstreamURL}/v1`, apiKey: "configured-key-b", enablePack: false },
    chat_upstream: { protocol: "chat", baseURL: `${upstreamURL}/v1`, key: "configured-chat-key", models: ["chat-test"], maxMessages: 6, enablePack: false, compactionNotice: "Context compacted" },
    anthropic_upstream: { protocol: "anthropic", baseURL: `${upstreamURL}/v1`, key: "configured-anthropic-key", models: ["anthropic-test"], maxMessages: 6, enablePack: true, compactionNotice: "Context compacted" },
  } };
  await command(["plugin", "options", "magpie-autocompact", JSON.stringify(multi)]);
  const multiple = JSON.parse(await command(["plugin", "list", "--json"]));
  assert.deepEqual(multiple.loaded.find((p) => p.spec === resolve(".")).provides.sort(), ["anthropic_upstream", "chat_upstream", "compact_a", "compact_b"]);
  assert.equal(multiple.providers.find((provider) => provider.id === "compact_a")?.searches, true, "Magpie must register the provider as supporting native search");
  assert.notEqual(multiple.providers.find((provider) => provider.id === "compact_b")?.searches, true);
  assert.ok(modelCredentials.includes("Bearer configured-key-b"), "omitted models fetched during plugin startup");
  await startGateway();
  const searchBody = { id: "native-search-session", model: "compact_a/test", input: [{ role: "user", content: "Find the latest release" }],
    commands: { search_query: [{ q: "current release" }], open: [{ ref_id: "https://example.com", lineno: 12 }] },
    settings: { external_web_access: true }, max_output_tokens: 2500 };
  const alpha = JSON.parse(await request("alpha/search", searchBody, { originator: "codex_cli_rs", "user-agent": "Codex test UA" }));
  if (nativeSearchRequests.length) {
    assert.equal(alpha.encrypted_output, "native-search-cipher");
    assert.deepEqual(nativeSearchRequests.at(-1).body.commands, searchBody.commands);
    assert.equal(nativeSearchRequests.at(-1).body.model, "test");
    assert.equal(nativeSearchRequests.at(-1).headers.authorization, "Bearer configured-key-a");
    console.log("PASS: Magpie forwards Codex alpha/search to the native upstream.");
  } else {
    assert.notEqual(alpha.encrypted_output, "native-search-cipher");
    assert.equal(typeof alpha.output, "string");
    if (process.env.REQUIRE_ALPHA_SEARCH === "1") throw new Error("Magpie registered native search, but its alpha/search gateway did not forward plugin providers");
    console.log("LIMITATION: Magpie registers searches:true, but alpha/search does not reach plugin providers; its fallback is not native search success.");
  }
  const noticeReply = await request("responses", { model: "compact_a/test", input: messages, stream: false });
  assert.match(noticeReply, /Context compacted/); assert.match(noticeReply, /native reply/);
  assert.equal(upstreamCredentials.at(-1), "Bearer configured-key-a");
  assert.ok(upstreamRequests.at(-1).input.length <= 6);
  await request("responses", { model: "compact_b/test", input: messages, stream: false });
  assert.equal(upstreamCredentials.at(-1), "Bearer configured-key-b");
  assert.equal(upstreamRequests.at(-1).input.length, messages.length);
  const freshMessages = [{ ...messages[0], content: "Fresh history for streaming" }, ...messages.slice(1)];
  const noticeStream = await request("responses", { model: "compact_a/test", input: freshMessages, stream: true });
  assert.match(noticeStream, /Context compacted/); assert.match(noticeStream, /native reply/); assert.match(noticeStream, /response.completed/);
  const beforeNonResponses = compactionAttempts.length;
  const chat = await request("responses", { model: "chat_upstream/chat-test", input: messages, stream: false });
  assert.match(chat, /Context compacted/); assert.match(chat, /transparent reply/);
  assert.equal(messageRequests.at(-1).path, "/v1/chat/completions");
  assert.equal(messageRequests.at(-1).headers.authorization, "Bearer configured-chat-key");
  assert.ok(messageRequests.at(-1).body.messages.length <= 6);
  assert.match(JSON.stringify(messageRequests.at(-1).body.messages), /Summary from message model/);
  assert.equal(messageSummaries.at(-1).path, "/v1/chat/completions");
  const chatNoticeStream = await request("responses", { model: "chat_upstream/chat-test", input: freshMessages, stream: true });
  assert.match(chatNoticeStream, /Context compacted/); assert.match(chatNoticeStream, /transparent/); assert.match(chatNoticeStream, /response.completed/);
  rejectMessageSummary = true;
  const anthropic = await request("responses", { model: "anthropic_upstream/anthropic-test", input: messages, stream: true });
  assert.match(anthropic, /Context compacted/); assert.match(anthropic, /anthropic reply/); assert.match(anthropic, /response.completed/);
  assert.equal(messageRequests.at(-1).path, "/v1/messages");
  assert.equal(messageRequests.at(-1).headers["x-api-key"], "configured-anthropic-key");
  assert.equal(messageRequests.at(-1).headers.authorization, undefined);
  assert.equal(messageRequests.at(-1).headers["anthropic-version"], "2023-06-01");
  assert.ok(messageRequests.at(-1).body.messages.length <= 6);
  assert.match(JSON.stringify(messageRequests.at(-1).body.messages), /original_messages_json/);
  rejectMessageSummary = false;
  assert.equal(compactionAttempts.length, beforeNonResponses, "Message upstreams must never invoke native Responses compression");
  await stopGateway();
  multi.providers.compact_a.key = "rotated-key-a";
  // Reorder providers as well: export positions must not define identity.
  multi.providers = { compact_b: multi.providers.compact_b, compact_a: multi.providers.compact_a, chat_upstream: multi.providers.chat_upstream, anthropic_upstream: multi.providers.anthropic_upstream };
  await command(["plugin", "options", "magpie-autocompact", JSON.stringify(multi)]);
  await startGateway();
  await request("responses", { model: "compact_a/test", input: "after key update", stream: false });
  assert.equal(upstreamCredentials.at(-1), "Bearer rotated-key-a");
  await request("responses", { model: "compact_b/test", input: "other key unchanged", stream: false });
  assert.equal(upstreamCredentials.at(-1), "Bearer configured-key-b");
  // Empty configuration removes all registrations without reviving the old
  // form/account metadata path. Previously saved credentials are retained.
  await stopGateway();
  await command(["plugin", "options", "magpie-autocompact", JSON.stringify({ providers: {} })]);
  const empty = JSON.parse(await command(["plugin", "list", "--json"]));
  assert.deepEqual(empty.loaded.find((p) => p.spec === resolve(".")).provides ?? [], []);
  const retainedCredentials = JSON.parse(await readFile(join(sandbox, ".config/magpie/plugin-auth.json"), "utf8"));
  assert.ok(Object.values(retainedCredentials).some((a) => a.key === "rotated-key-a"));
  await startGateway();
  const remaining = await fetch(`http://${addr}/v1/models`, { headers: { authorization: "Bearer magpie" }, signal: AbortSignal.timeout(5000) });
  assert.equal(remaining.status, 200);
  const modelIds = (await remaining.json()).data.map((model) => model.id);
  assert.ok(modelIds.includes("plain/test"), "Unrelated configured providers remain available");
  // Magpie retains historical model listings independently of plugin hooks;
  // the empty `provides` above verifies this plugin no longer registers any.
  assert.doesNotMatch(logs, /SyntaxError|ReferenceError/i);
  console.log("PASS: real Magpie Provider + Bun: Responses, Chat Completions and Anthropic Messages upstreams via providers-only configuration without login, isolated credentials, summary/pack, disabled native compression for message upstreams, trigger > compact > summary > optional pack, stable IDs on compaction, independent request-count rotation, no-threshold passthrough, exhausted-policy errors without host retries, tool calls, previous_response_id, conversations, JSON/SSE, and restart.");
} catch (error) { console.error(logs); console.error(error); throw error; }
finally {
  await stopGateway();
  upstream.closeAllConnections();
  await new Promise((r) => upstream.close(r));
  if (process.env.KEEP_INTEGRATION_SANDBOX) console.error("sandbox:", sandbox);
  // Windows can retain the exiting plugin host's directory handles briefly.
  else await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
