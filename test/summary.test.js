import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../autocompact.provider.js";
import { providerSettings, resolveSummaryProvider } from "../lib/provider-config.js";
import { createSessionTransport } from "../lib/session-transport.js";
import { SUMMARY, compactHistory } from "../lib/session-compaction.js";
import { summaryContent, summaryMessages } from "../lib/summary-input.js";
import { setTimeout as delay } from "node:timers/promises";

const base = { baseURL: "https://summary.example/v1", key: "target-secret", models: { small: { id: "small-actual", headers: { "x-model": "selected" } } } };
const history = Array.from({ length: 11 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i}: ${"historical requirements ".repeat(20)}` }));

test("summary references and legacy fields are validated before credential writes", async () => {
  let writes = 0;
  for (const summary of [null, [], { url: "https://old.example" }, { apiKeyEnv: "OLD" }, { provider: "missing" }, { provider: "disabled" }, { provider: "Invalid ID" }, { prompt: " " }, { model: "" }, { timeoutMs: 99 }, { timeoutMs: -1 }, { maxTokens: -1 }, { maxInputChars: -1 }, { maxInputChars: 1.5 }]) {
    await assert.rejects(plugin.server({ client: { auth: { set: () => writes++ } } }, { providers: {
      source: { ...base, summary }, disabled: { enabled: false },
    } }));
  }
  assert.equal(writes, 0);
  assert.equal(resolveSummaryProvider({ provider: "source" }, "source", {}), null);
  assert.equal(resolveSummaryProvider({}, "source", {}), null);
  assert.equal(resolveSummaryProvider({ provider: "helper" }, "source", { helper: base }).model, "small-actual");
  assert.equal(resolveSummaryProvider({ provider: "helper", model: "small-actual" }, "source", { helper: base }).headers["x-model"], "selected");
  assert.throws(() => resolveSummaryProvider({ provider: "helper" }, "source", { helper: { ...base, models: undefined } }), /summary.model/);
  assert.equal(resolveSummaryProvider({ provider: "helper", model: "explicit" }, "source", { helper: { ...base, models: undefined } }).model, "explicit");
});

for (const source of ["responses", "chat", "anthropic"]) for (const target of ["responses", "chat", "anthropic"]) {
  test(`${source} -> ${target}: referenced summaries isolate credentials, preserve prompts and cache safely`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "magpie-summary-"));
    const summaries = [], inference = [];
    const image = source === "chat" ? { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
      : source === "responses" ? { type: "input_image", image_url: "data:image/png;base64,AAAA" }
        : { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
    const input = structuredClone(history);
    input[0].content = [{ type: source === "responses" ? "input_text" : "text", text: history[0].content }, image];
    let prompt = "  自定义摘要：保留目标与待办。\n只输出摘要。  ";
    const registry = { helper: { ...base, protocol: target, maxMessages: 1, maxRequests: 1, timeoutMs: 0,
      summary: { provider: "source" }, headers: { "x-provider": "helper", authorization: "stale" } } };
    let transport;
    t.after(async () => { await transport?.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body), headers = new Headers(init.headers);
      if (String(url).startsWith(base.baseURL)) {
        await delay(10);
        assert.equal(init.signal.aborted, false, "zero timeout must not abort the summary");
        summaries.push({ body, headers });
        if (target === "chat") return Response.json({ choices: [{ finish_reason: "stop", message: { content: "Keep pending work." } }] });
        if (target === "anthropic") return Response.json({ content: [{ type: "text", text: "Keep pending work." }], stop_reason: "end_turn" });
        return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Keep pending work." }] }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
      }
      if (String(url).endsWith("/compact") || body.input?.at(-1)?.type === "compaction_trigger") return Response.json({ error: { message: "unsupported" } }, { status: 400 });
      inference.push({ body, headers });
      if (source === "responses") return Response.json({ id: `resp_${inference.length}`, status: "completed", output: [] });
      if (source === "chat") return Response.json({ choices: [{ finish_reason: "stop", message: { content: "OK" } }] });
      return Response.json({ type: "message", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" });
    };
    const start = async () => {
      const settings = providerSettings({ baseURL: "https://source.example/v1", protocol: source, maxMessages: 6,
        maxRequests: 2, timeoutMs: 0, responses: { timeoutMs: 0, maxInputChars: 0 }, enablePack: false,
        summary: { provider: "helper", timeoutMs: 0, maxTokens: 0, maxInputChars: 0, ...(prompt === undefined ? {} : { prompt }) } }, "source");
      transport = await createSessionTransport(settings.transportOptions, { stateDir: root, summaryProviders: registry, fetchImpl });
      return settings.transportOptions.providers.source.stateful.url;
    };
    let url = await start();
    const request = async () => {
      const response = await transport.fetch("source", url, { method: "POST", headers: {
        authorization: "Bearer source-secret", "session-id": "source-session", "thread-id": "source-thread", "x-openai-actor-authorization": "actor-secret",
      }, body: JSON.stringify({ model: "inference-model", store: false, prompt_cache_key: "source-session", [source === "responses" ? "input" : "messages"]: input }) });
      const text = await response.text(); assert.equal(response.status, 200, text);
    };
    await request();
    assert.equal(summaries.length, 1);
    const row = summaries[0];
    assert.equal(row.body.model, "small-actual");
    assert.equal(Object.hasOwn(row.body, "max_tokens"), false);
    assert.equal(Object.hasOwn(row.body, "max_output_tokens"), false);
    const media = (row.body.messages ?? row.body.input).at(-1).content.at(-1);
    assert.equal(media.type, target === "chat" ? "image_url" : target === "responses" ? "input_image" : "image");
    assert.match(JSON.stringify(media), /AAAA/);
    assert.deepEqual(inference[0].body[source === "responses" ? "input" : "messages"].at(-1), input.at(-1));
    assert.equal(target === "anthropic" ? row.body.system : (row.body.messages ?? row.body.input)[0].content, prompt);
    assert.equal(row.headers.get(target === "anthropic" ? "x-api-key" : "authorization"), target === "anthropic" ? "target-secret" : "Bearer target-secret");
    for (const name of ["session-id", "thread-id", "x-openai-actor-authorization"]) assert.equal(row.headers.get(name), null);
    assert.equal(row.body.prompt_cache_key, undefined);
    assert.equal(row.headers.get("x-model"), "selected"); assert.equal(row.headers.get("x-provider"), "helper");
    assert.doesNotMatch(JSON.stringify(row.body), /source-secret|source-session|source-thread|inference-model/);
    await transport.close(); url = await start(); await request();
    assert.equal(summaries.length, 1, "durable prefix reuse after restart");
    prompt = undefined;
    await transport.close(); url = await start(); await request();
    assert.equal(summaries.length, 2, "prompt changes invalidate summaries");
    assert.equal(target === "anthropic" ? summaries[1].body.system : (summaries[1].body.messages ?? summaries[1].body.input)[0].content, SUMMARY);
    assert.equal(inference[0].headers.get("session-id"), "source-session");
    assert.equal(inference[1].headers.get("session-id"), "source-session", "summary does not spend an inference request");
    assert.notEqual(inference[2].headers.get("session-id"), "source-session");
    registry.helper.key = "changed-target-key";
    await transport.close(); url = await start(); await request();
    assert.equal(summaries.length, 3, "target credential changes invalidate cached summaries");
  });
}

test("summary input limits accept zero while positive limits still reject oversized history", async () => {
  const body = { model: "test", messages: history }, original = structuredClone(body);
  let calls = 0;
  const summaryPost = async () => { calls++; return { choices: [{ finish_reason: "stop", message: { content: "Keep pending work." } }] }; };
  await assert.rejects(compactHistory(body, "chat", { maxMessages: 6, enablePack: false, summary: { maxInputChars: 1 } }, { summaryPost }),
    (error) => error.attempts[0].code === "summary_input_too_large");
  assert.equal(calls, 0);
  const result = await compactHistory(body, "chat", { maxMessages: 6, enablePack: false, summary: { maxInputChars: 0 } }, { summaryPost });
  assert.equal(calls, 1);
  assert.ok(result.messages.length <= 6);
  assert.deepEqual(body, original);
});

test("native input limits accept zero while positive limits prevent native requests", async () => {
  const body = { model: "test", input: history };
  let calls = 0;
  const callbacks = { nativePost: async () => {
    calls++;
    return { status: "completed", output: [{ type: "compaction", encrypted_content: "sealed" }] };
  } };
  await assert.rejects(compactHistory(body, "responses", { maxMessages: 6, enablePack: false, responses: { maxInputChars: 1 } }, callbacks),
    (error) => error.attempts.slice(0, 2).every((attempt) => attempt.code === "native_input_too_large"));
  assert.equal(calls, 0);
  const result = await compactHistory(body, "responses", { maxMessages: 6, responses: { maxInputChars: 0 } }, callbacks);
  assert.equal(calls, 1);
  assert.equal(result.input[0].type, "compaction");
});

test("summary sends native media including nested tool results without mutating history", () => {
  for (const block of [
    { type: "input_audio", input_audio: { data: "AAAA", format: "wav" } },
    { type: "file", file: { file_data: "data:application/pdf;base64,AAAA", filename: "report.pdf" } },
    { type: "video_url", video_url: { url: "https://example.com/video.mp4" } },
  ]) {
    const prefix = [{ role: "tool", content: [{ type: "tool_result", tool_use_id: "call", content: [block] }] }];
    const original = structuredClone(prefix), content = summaryContent(prefix);
    assert.deepEqual(content[1], block);
    assert.match(content[0].text, /historical_media/);
    assert.deepEqual(summaryMessages([{ role: "user", content }], "chat", "chat")[0].content[1], block);
    assert.deepEqual(prefix, original);
  }
  assert.throws(() => summaryMessages([{ role: "user", content: [{ type: "input_audio", input_audio: { data: "AAAA" } }] }], "chat", "anthropic"),
    { code: "unsupported_summary_content" });
});

test("document summaries convert inline PDFs across all three protocols", () => {
  const blocks = {
    chat: { type: "file", file: { file_data: "data:application/pdf;base64,AAAA", filename: "report.pdf" } },
    responses: { type: "input_file", file_data: "data:application/pdf;base64,AAAA", filename: "report.pdf" },
    anthropic: { type: "document", title: "report.pdf", source: { type: "base64", media_type: "application/pdf", data: "AAAA" } },
  };
  for (const source of Object.keys(blocks)) for (const target of Object.keys(blocks)) {
    const result = summaryMessages([{ role: "user", content: [blocks[source]] }], source, target)[0].content[0];
    assert.equal(result.type, blocks[target].type);
    assert.match(JSON.stringify(result), /AAAA/);
  }
});

test("non-text summaries and pack fallback preserve media and the current input", async () => {
  for (const block of [
    { type: "input_audio", input_audio: { data: "AAAA", format: "wav" } },
    { type: "file", file: { file_data: "data:application/pdf;base64,AAAA", filename: "report.pdf" } },
  ]) {
    const messages = structuredClone(history);
    messages[0].content = [{ type: "text", text: history[0].content }, block];
    const body = { model: "test", messages }, original = structuredClone(body);
    const result = await compactHistory(body, "chat", { maxMessages: 6 }, { summaryPost: async (payload) => {
      assert.deepEqual(payload.messages[1].content.at(-1), block);
      return { choices: [{ finish_reason: "stop", message: { content: "Keep the task requirements." } }] };
    } });
    assert.deepEqual(result.messages.at(-1), messages.at(-1));
    assert.deepEqual(body, original);
    const packed = await compactHistory(body, "chat", { maxMessages: 6 }, { summaryPost: async () => { throw new Error("unavailable"); } });
    assert.deepEqual(packed.messages[0].content[1], block);
    assert.match(packed.messages[0].content[0].text, /historical_media/);
    assert.deepEqual(packed.messages.at(-1), messages.at(-1));
  }
});
