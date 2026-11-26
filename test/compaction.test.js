import test from "node:test";
import assert from "node:assert/strict";
import { plan, applyText, policies, counts } from "../lib/core.js";
import { compactSession } from "../lib/session-compaction.js";

function chat(n = 8) {
  return { model: "limited/test", stream: true, messages: [
    { role: "system", content: "Keep these instructions." },
    ...Array.from({ length: n }, (_, i) => [
      { role: "user", content: `question ${i}: ${"important context ".repeat(20)}` },
      ...(i === n - 1 ? [] : [{ role: "assistant", content: `answer ${i}` }]),
    ]).flat(),
  ], tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }], tool_choice: "auto" };
}

function context(options = { providers: { limited: { maxMessages: 6, keepTurns: 2 } } }, protocol = "chat") {
  return { policy: policies(options)[0]?.[1], protocol };
}

function route(body, { policy, protocol }) {
  const p = plan(body, protocol, policy);
  return p ? applyText(body, protocol, p) : body;
}

test("policy validation rejects invalid thresholds and modes", () => {
  assert.deepEqual(policies({ providers: { a: { maxMessages: 2.5 }, b: { maxTurns: -1 }, c: false, d: { maxMessages: 4, enabled: false }, e: { maxMessages: 5, mode: "typo" } } }), []);
  assert.equal(policies({ providers: { limited: 6 } })[0][1].maxMessages, 6);
});

test("packs old text, pins instructions, preserves current input and request controls", () => {
  const body = chat(), original = structuredClone(body), result = route(body, context());
  assert.equal(result.messages.length, 4);
  assert.deepEqual(result.messages[0], body.messages[0]);
  assert.deepEqual(result.messages.at(-1), body.messages.at(-1));
  const text = result.messages[1].content;
  assert.match(text, /question 0/); assert.match(text, /answer 5/);
  assert.deepEqual(result.tools, body.tools);
  assert.equal(result.model, body.model); assert.equal(result.stream, true); assert.equal(result.tool_choice, "auto");
  assert.deepEqual(body, original);
});

test("under limit and stateful Responses are unchanged", () => {
  assert.deepEqual(route(chat(2), context()), chat(2));
  for (const field of ["previous_response_id", "conversation"]) {
    const body = { model: "limited/test", input: [{ role: "user", content: "new question" }], [field]: "remote-id" };
    assert.deepEqual(route(body, context(undefined, "responses")), body);
  }
});

test("maxTurns counts actual user turns, not tool outputs", () => {
  const ctx = context({ providers: { limited: { maxTurns: 2, keepTurns: 2 } } });
  const body = chat(5);
  const result = route(body, ctx);
  assert.equal(counts(result.messages, "chat").turns, 2);
  assert.equal(counts([{ role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] }], "anthropic").turns, 0);
});

test("preserves parallel tool calls and outputs together in the active turn", () => {
  const body = chat(5);
  body.messages.push({ role: "assistant", content: null, tool_calls: ["a", "b"].map((id) => ({ id, type: "function", function: { name: "read", arguments: "{}" } })) },
    { role: "tool", tool_call_id: "a", content: "A" }, { role: "tool", tool_call_id: "b", content: "B" });
  const ctx = context({ providers: { limited: { maxMessages: 7, keepTurns: 1 } } });
  const result = route(body, ctx);
  assert.deepEqual(result.messages.slice(-3), body.messages.slice(-3));
  assert.ok(result.messages.length <= 7);
});

test("never cuts an outstanding call, drops a malformed tool result, or truncates an oversized active turn", () => {
  const body = chat(3);
  body.messages.splice(2, 0, { role: "assistant", tool_calls: [{ id: "open", type: "function", function: { name: "read", arguments: "{}" } }] });
  assert.deepEqual(route(body, context({ providers: { limited: { maxMessages: 3 } } })), body);
  const broken = chat(); broken.messages.splice(1, 0, { role: "tool", tool_call_id: "missing", content: "result" });
  assert.deepEqual(route(broken, context()), broken);
  const large = chat(3);
  large.messages.push(...Array.from({ length: 10 }, () => ({ role: "assistant", content: "same active turn" })));
  assert.deepEqual(route(large, context()), large);
});

test("old images, encrypted reasoning, and mid-conversation instructions are protected", () => {
  for (const content of [[{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }], [{ type: "input_audio", input_audio: { data: "AAAA" } }]]) {
    const body = chat(); body.messages[1].content = content;
    assert.deepEqual(route(body, context()), body);
  }
  const body = chat(); body.messages.splice(3, 0, { role: "developer", content: "new instructions" });
  assert.deepEqual(route(body, context()), body);
});

for (const protocol of ["anthropic", "responses", "gemini"]) {
  test(`compacts ${protocol} in its own wire format`, () => {
    const source = chat().messages.slice(1);
    const ctx = context(undefined, protocol);
    let body;
    if (protocol === "gemini") body = { model: "limited/test", contents: source.map((x) => ({ role: x.role === "assistant" ? "model" : "user", parts: [{ text: x.content }] })), systemInstruction: { parts: [{ text: "system" }] } };
    else if (protocol === "responses") body = { model: "limited/test", input: source.map((x) => ({ role: x.role, content: [{ type: x.role === "user" ? "input_text" : "output_text", text: x.content }] })), instructions: "system" };
    else body = { model: "limited/test", messages: source.map((x) => ({ role: x.role, content: [{ type: "text", text: x.content }] })), system: "system", max_tokens: 100 };
    const result = route(body, ctx), key = protocol === "gemini" ? "contents" : protocol === "responses" ? "input" : "messages";
    assert.equal(result[key].length, 3);
    assert.deepEqual(result[key].at(-1), body[key].at(-1));
    assert.deepEqual(result.systemInstruction ?? result.instructions ?? result.system, body.systemInstruction ?? body.instructions ?? body.system);
    assert.match(JSON.stringify(result[key][0]), /question 0/);
  });
}

function responsesBody() {
  return { model: "limited/test", stream: true, instructions: "original system instructions", input: [
    { role: "user", content: "first question" },
    { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "lookup" }] },
    { type: "configuration_update", reasoning: { effort: "high" } },
    { type: "configuration_update", text: { format: { type: "json_object" } } },
    { type: "reasoning", id: "rs_1", encrypted_content: "encrypted-reasoning" },
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "found" },
    { role: "assistant", content: "done" },
    { role: "user", content: "second" }, { role: "assistant", content: "second answer" },
    { role: "user", content: "third" }, { role: "assistant", content: "third answer" },
    { role: "user", content: "current" },
  ] };
}

test("native compaction restores dynamic tools and configuration without exposing its internal request", async () => {
  const source = responsesBody(), original = structuredClone(source);
  const result = await compactSession(source, { maxMessages: 6, maxTurns: 2, keepTurns: 2, mode: "responses" }, {
    async nativePost(payload) {
      assert.equal(payload.model, source.model);
      assert.deepEqual(payload.input.at(-1), { type: "compaction_trigger" });
      assert.equal(payload.stream, false); assert.equal(payload.store, false);
      assert.equal(payload.instructions, source.instructions);
      assert.equal(payload.input.some((x) => x.content === "current"), false);
      return { status: "completed", output: [{ type: "compaction", id: "cmp_1", encrypted_content: "opaque-state" }] };
    },
  });
  assert.ok(result.input.length <= 6); assert.ok(counts(result.input, "responses").turns <= 2);
  assert.equal(result.input[0].type, "compaction");
  assert.equal(result.input[1].type, "additional_tools");
  assert.deepEqual(result.input[2], { type: "configuration_update", reasoning: { effort: "high" }, text: { format: { type: "json_object" } } });
  assert.deepEqual(result.input.at(-1), source.input.at(-1));
  assert.equal(result.instructions, source.instructions); assert.equal(result.stream, true);
  assert.deepEqual(source, original);
});

test("invalid native compaction preserves opaque history rather than using a lossy text fallback", async () => {
  for (const output of [{ status: "incomplete", output: [{ type: "compaction", encrypted_content: "partial" }] }, { status: "completed", output: [] }]) {
    const body = responsesBody();
    const result = await compactSession(body, { maxMessages: 6, keepTurns: 2, mode: "responses" }, { nativePost: async () => output });
    assert.equal(result, null, "encrypted reasoning prevents text packing");
  }
});

test("invalid, truncated, empty or oversized summaries fall back to packing the full historical text", async () => {
  const body = { model: "test", input: chat().messages };
  for (const data of [
    { choices: [{ finish_reason: "length", message: { content: "partial" } }] },
    { choices: [{ finish_reason: "stop", message: { content: "" } }] },
    { choices: [{ finish_reason: "stop", message: { content: "x".repeat(100000) } }] },
    { error: "unavailable" },
  ]) {
    const result = await compactSession(body, { maxMessages: 6, keepTurns: 2, mode: "summary", summary: { model: "small" } }, { summaryPost: async () => data });
    assert.match(result.input[1].content, /original_messages_json/);
    assert.match(result.input[1].content, /question 0/);
    assert.deepEqual(result.input.at(-1), body.input.at(-1));
  }
});

test("no feasible safe cut returns no plan", () => {
  assert.equal(plan(chat(), "chat", { maxMessages: 1, keepTurns: 4 }), null);
});
