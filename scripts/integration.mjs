// Real Magpie Provider + Bun host. No user settings or
// real upstream accounts are accessed; all HTTP model calls stay on loopback.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sandbox = await mkdtemp(join(tmpdir(), "magpie-autocompact-integration-"));
const upstreamRequests = [], compactCredentials = [];
let summaryCalls = 0, compactCalls = 0, rejectSummary = false, gateway, logs = "";
const storedResponses = new Map(), storedConversations = new Map([["conv_integration", []]]);
let responseNumber = 0;
const upstream = createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  if (req.method === "GET") {
    res.setHeader("content-type", "application/json");
    const path = new URL(req.url, "http://localhost").pathname;
    if (/^\/v1\/responses\//.test(path)) { res.end(JSON.stringify(storedResponses.get(path.split("/").at(-1))?.reply ?? {})); return; }
    if (/^\/v1\/conversations\/[^/]+\/items$/.test(path)) { res.end(JSON.stringify({ data: storedConversations.get(path.split("/").at(-2)) ?? [], has_more: false })); return; }
    res.end(JSON.stringify({ object: "list", data: [{ id: "test", object: "model" }] })); return;
  }
  const body = JSON.parse(raw);
  if (req.url === "/v1/conversations") {
    const id = `conv_shadow_${++responseNumber}`; storedConversations.set(id, body.items ?? []);
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id, object: "conversation" })); return;
  }
  if (req.url === "/summarize") {
    summaryCalls++;
    if (rejectSummary) { res.writeHead(503).end("{}"); return; }
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "Summary from internal model." } }] })); return;
  }
  if (body.input?.at(-1)?.type === "compaction_trigger") {
    compactCalls++; compactCredentials.push(req.headers.authorization);
    res.end(JSON.stringify({ id: "resp_compact", object: "response", status: "completed", output: [{ type: "compaction", id: "cmp_local", encrypted_content: "local-opaque-context" }] })); return;
  }
  upstreamRequests.push(body);
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
const env = { ...process.env, HOME: sandbox, XDG_CONFIG_HOME: join(sandbox, ".config"), XDG_CACHE_HOME: join(sandbox, ".cache"), XDG_STATE_HOME: join(sandbox, ".state"), XDG_DATA_HOME: join(sandbox, ".local/share"), MAGPIE_ADDR: addr, MAGPIE_NO_ACCOUNTS: "0" };

function command(args, input = "") {
  return new Promise((resolveCommand, reject) => {
    const child = spawn("magpie", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(input);
    let out = "", errors = "";
    child.stdout.on("data", (b) => out += b);
    child.stderr.on("data", (b) => errors += b);
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.on("error", reject);
    child.on("exit", (code) => { clearTimeout(timer); if (code === 0) resolveCommand(out); else reject(new Error(`magpie ${args.slice(0, 2).join(" ")} failed: ${errors}${out}`)); });
  });
}

async function stopGateway() {
  if (!gateway || gateway.exitCode !== null) return;
  gateway.kill("SIGTERM");
  const kill = setTimeout(() => gateway.kill("SIGKILL"), 3000);
  await once(gateway, "exit"); clearTimeout(kill);
}

async function startGateway() {
  gateway = spawn("magpie", ["serve"], { env, stdio: ["pipe", "pipe", "pipe"] });
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
async function request(path, body) {
  const response = await fetch(`http://${addr}/v1/${path}`, { method: "POST", headers: { authorization: "Bearer magpie", "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const text = await response.text(); assert.equal(response.status, 200, text); return text;
}

async function configure(mode) {
  await command(["plugin", "options", "magpie-autocompact", JSON.stringify({ provider: {
    id: "session", baseURL: `${upstreamURL}/v1`, models: ["test"], stateDir: join(sandbox, "session-state"),
    maxMessages: mode === "responses" ? 4 : 6, maxTurns: 2, keepTurns: 1, mode,
    ...(mode === "summary" ? { summary: { url: `${upstreamURL}/summarize`, model: "small" } } : {}),
  } })]);
}

try {
  await command(["plugin", "add", resolve(".")]);
  // The same native prompt/validate/authorize flow used by the GUI: there is
  // no options JSON prerequisite, and a blank model field fetches /models.
  const fresh = JSON.parse(await command(["plugin", "list", "--json"]));
  assert.deepEqual(fresh.loaded.find((p) => p.spec === resolve(".")).provides, ["autocompact"]);
  await command(["plugin", "login", "autocompact"], ["图形表单上游", `${upstreamURL}/v1`, "local-form-key", "", "2", "4", "2", "1", "80", "1", ""].join("\n"));
  const credentials = JSON.parse(await readFile(join(sandbox, ".config/magpie/plugin-auth.json"), "utf8"));
  const formAccount = Object.values(credentials).find((a) => a.key === "local-form-key");
  assert.equal(formAccount.metadata.autocompact.baseURL, `${upstreamURL}/v1`);
  assert.deepEqual(formAccount.metadata.autocompact.models, ["test"]);
  assert.doesNotMatch(JSON.stringify(formAccount.metadata), /local-form-key/);
  await startGateway();
  const fromForm = JSON.parse(await request("responses", { model: "autocompact/test", input: messages, stream: false }));
  assert.equal(fromForm.output[0].content[0].text, "native reply");
  assert.equal(compactCredentials.at(-1), "Bearer local-form-key");
  assert.equal(upstreamRequests.at(-1).input[0].type, "compaction");
  await stopGateway();
  await startGateway();
  await request("responses", { model: "autocompact/test", previous_response_id: fromForm.id, input: "form account after restart", stream: false });
  await stopGateway();
  compactCalls = 0;
  await command(["provider", "add", "Plain", "id=plain", `url=${upstreamURL}/v1`, "key=local-plain-key", "models=test", "list=off"]);
  await configure("responses");
  await command(["plugin", "login", "session"], "local-session-key\n");
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
  await configure("summary");
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
  assert.equal(summaryCalls, 2);
  rejectSummary = true;
  await request("responses", { model: "session/test", input: messages, stream: false });
  assert.match(JSON.stringify(upstreamRequests.at(-1).input), /original_messages_json/);

  await stopGateway();
  await configure("pack");
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
  assert.equal(summaryCalls, beforePack, "pack does not call a summary model");
  assert.doesNotMatch(logs, /SyntaxError|ReferenceError/i);
  console.log("PASS: real Magpie Provider + Bun: native supplier form, model discovery, credential storage, all compaction modes, fallback, tool calls, account credentials, previous_response_id, conversation aliases, Chat translation, JSON/SSE, and restart.");
} catch (error) { console.error(logs); throw error; }
finally {
  await stopGateway();
  await new Promise((r) => upstream.close(r));
  await rm(sandbox, { recursive: true, force: true });
}
