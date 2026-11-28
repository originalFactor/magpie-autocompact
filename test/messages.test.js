import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionTransport } from "../lib/session-transport.js";
import { providerSettings, accountHeaders } from "../lib/provider-config.js";

const history = () => Array.from({ length: 6 }, (_, i) => [
  { role: "user", content: `question ${i}: ${"keep historical requirements ".repeat(5)}` },
  ...(i === 5 ? [] : [{ role: "assistant", content: `answer ${i}` }]),
]).flat();

function tools(protocol, n = 100) {
  return [{ role: "user", content: "Complete the coding task." }, ...Array.from({ length: n }, (_, i) => protocol === "chat" ? [
    { role: "assistant", content: null, tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: `call_${i}`, content: `result ${i}` },
  ] : [
    { role: "assistant", content: [{ type: "tool_use", id: `call_${i}`, name: "read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: `call_${i}`, content: `result ${i}` }] },
  ]).flat()];
}

async function fixture(t, protocol, settings = {}, fetchImpl) {
  const root = await mkdtemp(join(tmpdir(), "magpie-message-test-"));
  const calls = [], summaries = [], forbidden = [], controls = { summary: "ok", reject: false, truncate: false };
  const server = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : null;
      const row = { path: req.url, headers: { ...req.headers }, body };
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/models") { res.end(JSON.stringify({ data: [{ id: "test" }] })); return; }
      if (req.url !== (protocol === "chat" ? "/v1/chat/completions" : "/v1/messages")) {
        forbidden.push(row); res.writeHead(500).end("Native Responses endpoints must never be called"); return;
      }
      const isSummary = (protocol === "chat" ? body.messages?.[0]?.content : body.system)?.startsWith?.("Summarize the historical conversation");
      if (isSummary) {
        summaries.push(row);
        if (controls.summary === "error") { res.writeHead(503).end(JSON.stringify({ error: { message: "Summary unavailable" } })); return; }
        const text = controls.summary === "empty" ? "" : controls.summary === "long" ? "x".repeat(20000) : "Keep the task goal and pending changes.";
        res.end(JSON.stringify(protocol === "chat" ? { choices: [{ finish_reason: controls.summary === "truncated" ? "length" : "stop", message: { role: "assistant", content: text } }] }
          : { type: "message", content: [{ type: "text", text }], stop_reason: controls.summary === "truncated" ? "max_tokens" : "end_turn" })); return;
      }
      calls.push(row);
      if (controls.reject) { res.writeHead(400).end(JSON.stringify({ error: { message: "Inference rejected" } })); return; }
      const reply = protocol === "chat" ? { id: "chatcmpl-test", object: "chat.completion", model: body.model,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ACK" } }] }
        : { id: "msg_test", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "ACK" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 1 } };
      if (!body.stream) { res.end(JSON.stringify(reply)); return; }
      res.setHeader("content-type", "text/event-stream");
      const frame = (data) => `id: retain-this-id\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
      const first = frame(protocol === "chat" ? { id: "chatcmpl-test", choices: [{ index: 0, delta: { content: "ACK" }, finish_reason: null }] }
        : { type: "message_start", message: { ...reply, content: [], stop_reason: null } });
      res.write(first.slice(0, 17)); res.write(first.slice(17));
      if (controls.truncate) { res.end(); return; }
      if (protocol === "chat") res.end(frame({ id: "chatcmpl-test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\r\n\r\n");
      else res.end(frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
        + frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ACK" } })
        + frame({ type: "content_block_stop", index: 0 })
        + frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }) + frame({ type: "message_stop" }));
    } catch (error) { res.writeHead(500).end(JSON.stringify({ error: { message: error.message } })); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  const configured = providerSettings({ protocol, baseURL, models: ["test"], maxMessages: 6, ...settings }, "test");
  let transport = await createSessionTransport(configured.transportOptions, { stateDir: root, fetchImpl });
  const url = configured.transportOptions.providers.test.stateful.url;
  const request = (body, { key = "account-key", session = "client-session", path = url, signal } = {}) => transport.fetch("test", path, {
    method: path.endsWith("/models") ? "GET" : "POST", signal,
    headers: accountHeaders({ "content-type": "application/json", "session-id": session, "user-agent": "Codex test UA" }, key, protocol),
    body: path.endsWith("/models") ? undefined : JSON.stringify({ model: "test", max_tokens: 512, ...body }),
  });
  t.after(async () => { await transport.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { calls, summaries, forbidden, controls, request, baseURL, async restart() { await transport.close(); transport = await createSessionTransport(configured.transportOptions, { stateDir: root, fetchImpl }); } };
}

for (const protocol of ["chat", "anthropic"]) {
  test(`${protocol}: notice is readable while upstream inference is waiting`, async (t) => {
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    t.after(() => release());
    const f = await fixture(t, protocol, { compactionNotice: true }, async (url, init) => {
      const body = JSON.parse(init.body);
      const summary = (protocol === "chat" ? body.messages[0].content : body.system)?.startsWith?.("Summarize the historical conversation");
      if (!summary) await waiting;
      return fetch(url, init);
    });
    const response = await f.request({ messages: history(), stream: true });
    const reader = response.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /上下文已摘要/);
    assert.doesNotMatch(first, /\[DONE\]|message_stop/);
    assert.equal(f.calls.length, 0);
    release();
    let rest = "";
    for (;;) { const part = await reader.read(); if (part.done) break; rest += new TextDecoder().decode(part.value); }
    assert.match(rest, /ACK/);
    assert.match(rest, protocol === "chat" ? /\[DONE\]/ : /message_stop/);
    assert.equal(f.calls.length, 1);
    if (protocol === "anthropic") {
      assert.doesNotMatch(rest, /message_start/);
      assert.match(rest, /"index":1/);
      assert.match(rest, /"input_tokens":10/);
    }
  });

  test(`${protocol}: notice streams fail on rejected or truncated inference without caching success`, async (t) => {
    const f = await fixture(t, protocol, { compactionNotice: true });
    f.controls.reject = true;
    await assert.rejects(async () => (await f.request({ messages: history(), stream: true })).text());
    f.controls.reject = false; f.controls.truncate = true;
    await assert.rejects(async () => (await f.request({ messages: history(), stream: true })).text());
    f.controls.truncate = false;
    await (await f.request({ messages: history() })).json();
    assert.equal(f.summaries.length, 3);
  });

  test(`${protocol}: notice only follows successful compaction, including pack fallback`, async (t) => {
    const f = await fixture(t, protocol, { compactionNotice: true });
    const normal = await f.request({ messages: [{ role: "user", content: "hello" }] });
    assert.equal(normal.status, 200); await normal.json();
    assert.equal(f.calls.length, 1);
    f.controls.summary = "error";
    const packed = await f.request({ messages: history() });
    const reply = await packed.json();
    assert.equal(packed.status, 200);
    assert.equal(protocol === "chat" ? reply.choices[0].message.content : reply.content.map((part) => part.text).join(""), `上下文已打包到 ${f.calls.at(-1).body.messages.length} 条消息。\n\nACK`);
    assert.equal(f.calls.length, 2);
    const opaque = history().map((item) => ({ ...item }));
    opaque[0].content = [{ type: "unknown_opaque", data: "opaque" }];
    const failed = await f.request({ messages: opaque });
    assert.equal(failed.status, 422);
    assert.equal((await failed.json()).error.code, "compaction_failed");
    assert.equal(f.calls.length, 2);
  });

  for (const stream of [false, true]) {
    test(`${protocol}: compaction notice precedes inference and persists the prefix (stream=${stream})`, async (t) => {
      const f = await fixture(t, protocol, { compactionNotice: true });
      const messages = history();
      const response = await f.request({ messages, stream });
      assert.equal(response.status, 200);
      if (stream) {
        const events = await response.text();
        assert.match(events, /上下文已摘要到 \d+ 条消息。/);
        assert.match(events, protocol === "chat" ? /\[DONE\]/ : /message_stop/);
      } else {
        const reply = await response.json();
        assert.equal(protocol === "chat" ? reply.choices[0].message.content : reply.content.map((part) => part.text).join(""), `上下文已摘要到 ${f.calls.at(-1).body.messages.length} 条消息。\n\nACK`);
      }
      assert.equal(f.calls.length, 1);
      assert.equal(f.summaries.length, 1);
      await f.restart();
      const next = await f.request({ messages: [...messages, { role: "assistant", content: "上下文已摘要。" }, { role: "user", content: "continue" }] });
      assert.equal(next.status, 200); await next.json();
      assert.equal(f.summaries.length, 1);
      assert.equal(f.calls.length, 2);
      assert.match(JSON.stringify(f.calls[1].body.messages), /Keep the task goal/);
    });
  }

  test(`${protocol}: summary uses its own protocol, headers and model; replay and restart reuse the prefix`, async (t) => {
    const f = await fixture(t, protocol);
    const messages = history();
    const response = await f.request({ messages, system: "Preserve system", tools: [], temperature: 0.3 });
    assert.equal(response.status, 200); await response.json();
    assert.equal(f.summaries.length, 1); assert.equal(f.forbidden.length, 0);
    const summary = f.summaries[0], call = f.calls[0];
    assert.equal(summary.body.model, "test"); assert.equal(summary.body.max_tokens, 2048);
    assert.equal(summary.headers[protocol === "chat" ? "authorization" : "x-api-key"], protocol === "chat" ? "Bearer account-key" : "account-key");
    assert.equal(summary.headers["user-agent"], "Codex test UA");
    if (protocol === "anthropic") { assert.equal(summary.headers["anthropic-version"], "2023-06-01"); assert.equal(summary.headers.authorization, undefined); }
    assert.match(JSON.stringify(call.body.messages), /Keep the task goal/);
    assert.equal(call.body.system, "Preserve system"); assert.equal(call.body.max_tokens, 512); assert.equal(call.body.temperature, 0.3);
    assert.equal(call.headers["session-id"], "client-session"); assert.equal(call.headers["session-id"], summary.headers["session-id"]);
    await f.restart();
    const replay = await f.request({ messages: [...messages, { role: "assistant", content: "ACK" }, { role: "user", content: "continue" }], system: "Preserve system", tools: [], temperature: 0.3 });
    assert.equal(replay.status, 200); await replay.json();
    assert.equal(f.summaries.length, 1); assert.equal(f.calls.at(-1).headers["session-id"], call.headers["session-id"]);
  });

  test(`${protocol}: summary failure falls back to pack for a 100-batch tool loop`, async (t) => {
    const f = await fixture(t, protocol, { maxMessages: 12 }); f.controls.summary = "error";
    const messages = tools(protocol);
    const response = await f.request({ messages }); assert.equal(response.status, 200); await response.json();
    assert.equal(f.summaries.length, 1); assert.equal(f.forbidden.length, 0);
    const packed = f.calls[0].body.messages;
    assert.ok(packed.length <= 12); assert.match(packed[0].content, /original_messages_json/);
    const prefix = JSON.parse(JSON.parse(packed[0].content.split("\n")[1]).historical_context);
    assert.deepEqual([...prefix, ...packed.slice(1)], messages);
  });

  test(`${protocol}: summary errors, truncation and invalid output fall back to explicit text packing`, async (t) => {
    for (const failure of ["error", "truncated", "empty", "long"]) {
      const f = await fixture(t, protocol); f.controls.summary = failure;
      const response = await f.request({ messages: history() }); assert.equal(response.status, 200); await response.json();
      assert.equal(f.summaries.length, 1); assert.match(JSON.stringify(f.calls[0].body.messages), /original_messages_json/);
      assert.equal(f.forbidden.length, 0);
    }
  });

  test(`${protocol}: JSON and SSE keep their protocol; terminal streams publish state`, async (t) => {
    const f = await fixture(t, protocol);
    const response = await f.request({ messages: history(), stream: true });
    assert.equal(response.status, 200);
    const text = await response.text(); assert.match(text, /retain-this-id/);
    assert.match(text, protocol === "chat" ? /\[DONE\]/ : /message_stop/);
    await f.restart(); const next = await f.request({ messages: history() }); await next.json();
    assert.equal(f.summaries.length, 1);
  });

  test(`${protocol}: truncated streams and rejected inference do not publish cached prefixes or new IDs`, async (t) => {
    const f = await fixture(t, protocol); f.controls.truncate = true;
    await assert.rejects(async () => { const response = await f.request({ messages: history(), stream: true }); await response.text(); });
    await f.restart(); f.controls.truncate = false; f.controls.reject = true;
    const rejected = await f.request({ messages: history() }); assert.equal(rejected.status, 400); await rejected.text();
    assert.equal(f.summaries.length, 2);
    f.controls.reject = false;
    const small = await f.request({ messages: [{ role: "user", content: "small retry" }] }); await small.json();
    assert.equal(f.calls.at(-1).headers["session-id"], "client-session");
  });

  test(`${protocol}: opaque history fails explicitly and native Responses routes are blocked`, async (t) => {
    const f = await fixture(t, protocol);
    const messages = history(); messages[1].content = [{ type: "thinking", thinking: "Opaque reasoning", signature: "opaque-signature" }];
    const response = await f.request({ messages }); assert.equal(response.status, 422);
    const { error } = await response.json(); assert.equal(error.code, "compaction_failed");
    assert.deepEqual(error.attempts.map((a) => a.method), ["summary", "pack"]);
    assert.equal(f.summaries.length, 0); assert.equal(f.calls.length, 0);
    for (const route of ["responses", "responses/compact"]) {
      const disabled = await f.request({ input: [{ type: "compaction_trigger" }] }, { path: f.baseURL + "/" + route });
      assert.equal(disabled.status, 400); await disabled.json();
    }
    assert.equal(f.forbidden.length, 0);
    const models = await f.request(null, { path: f.baseURL + "/models" }); assert.equal(models.status, 200); await models.json();
  });

  test(`${protocol}: prefix cache is isolated by credentials, model, tools and Anthropic system`, async (t) => {
    const f = await fixture(t, protocol);
    for (const [change, key] of [[{}, "account-key"], [{ model: "other" }, "account-key"], [{ system: "changed" }, "account-key"], [{ tools: [{ name: "read", input_schema: { type: "object" } }] }, "account-key"], [{}, "another-account"]]) {
      const before = f.summaries.length;
      const response = await f.request({ messages: history(), ...change }, { key }); assert.equal(response.status, 200); await response.json();
      assert.equal(f.summaries.length, before + 1);
    }
  });

  test(`${protocol}: stable-session request limits rotate IDs without triggering compression`, async (t) => {
    const f = await fixture(t, protocol, { maxMessages: 100, maxRequests: 2 });
    const messages = history().slice(0, 5);
    for (let i = 0; i < 3; i++) { const response = await f.request({ messages }); assert.equal(response.status, 200); await response.json(); }
    assert.equal(f.summaries.length, 0); assert.equal(f.forbidden.length, 0);
    assert.equal(f.calls[0].headers["session-id"], "client-session");
    assert.notEqual(f.calls[2].headers["session-id"], "client-session");
  });

  test(`${protocol}: absent maxMessages is passthrough; optional rotation persists and failed candidates are not published`, async (t) => {
    const f = await fixture(t, protocol, { maxMessages: undefined, maxRequests: 1 });
    const messages = tools(protocol);
    for (let i = 0; i < 3; i++) {
      const response = await f.request({ messages, stream: i === 1 }); assert.equal(response.status, 200); await response.text();
      assert.deepEqual(f.calls.at(-1).body.messages, messages);
      await f.restart();
    }
    assert.equal(f.summaries.length, 0); assert.equal(f.forbidden.length, 0);
    const ids = f.calls.map((c) => c.headers["session-id"]);
    assert.equal(ids[0], "client-session"); assert.equal(new Set(ids).size, 3);
    f.controls.reject = true;
    const failure = await f.request({ messages }); assert.equal(failure.status, 400); await failure.text();
    const candidate = f.calls.at(-1).headers["session-id"];
    f.controls.reject = false;
    await f.restart();
    const retry = await f.request({ messages }); await retry.json();
    assert.notEqual(f.calls.at(-1).headers["session-id"], candidate);
  });

  test(`${protocol}: disabling pack reports summary failure instead of sending inference`, async (t) => {
    const f = await fixture(t, protocol, { enablePack: false }); f.controls.summary = "error";
    const response = await f.request({ messages: history() }); assert.equal(response.status, 422);
    assert.deepEqual((await response.json()).error.attempts.map((a) => a.method), ["summary"]);
    assert.equal(f.calls.length, 0); assert.equal(f.forbidden.length, 0);
  });

  test(`${protocol}: no thresholds preserves full message history and client session across restarts`, async (t) => {
    const f = await fixture(t, protocol, { maxMessages: undefined });
    for (let i = 0; i < 3; i++) {
      const messages = tools(protocol), response = await f.request({ messages, stream: i === 1 });
      assert.equal(response.status, 200); await response.text();
      assert.deepEqual(f.calls.at(-1).body.messages, messages);
      assert.equal(f.calls.at(-1).headers["session-id"], "client-session");
      await f.restart();
    }
    assert.equal(f.summaries.length, 0); assert.equal(f.forbidden.length, 0);
  });


  test(`${protocol}: compression and prefix replay never reset the request rotation counter`, async (t) => {
    const f = await fixture(t, protocol, { maxRequests: 2 });
    const messages = history();
    for (let i = 0; i < 4; i++) {
      const response = await f.request({ messages }); assert.equal(response.status, 200); await response.json();
      await f.restart();
    }
    const ids = f.calls.map((row) => row.headers["session-id"]);
    assert.equal(ids[0], "client-session"); assert.equal(ids[1], ids[0]);
    assert.notEqual(ids[2], ids[0]); assert.equal(ids[3], ids[2]);
    assert.equal(f.summaries.length, 1); assert.equal(f.forbidden.length, 0);
  });

}

test("Anthropic text cache hints remain safe to summarize while the system prompt is preserved", async (t) => {
  const f = await fixture(t, "anthropic");
  const messages = history();
  messages[1].content = [{ type: "text", text: "Keep these prior results", cache_control: { type: "ephemeral" } }];
  const system = [{ type: "text", text: "Keep the task constraints", cache_control: { type: "ephemeral" } }];
  const response = await f.request({ messages, system }); assert.equal(response.status, 200); await response.json();
  assert.equal(f.summaries.length, 1); assert.deepEqual(f.calls[0].body.system, system);
});
