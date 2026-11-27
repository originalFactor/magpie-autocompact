import test from "node:test";
import assert from "node:assert/strict";
import { plan, applyText, policies, counts } from "../lib/core.js";
import { compactSession, CompactionError } from "../lib/session-compaction.js";

function chat(n = 8) {
  return { model: "limited/test", stream: true, messages: [
    { role: "system", content: "Keep these instructions." },
    ...Array.from({ length: n }, (_, i) => [
      { role: "user", content: `question ${i}: ${"important context ".repeat(20)}` },
      ...(i === n - 1 ? [] : [{ role: "assistant", content: `answer ${i}` }]),
    ]).flat(),
  ], tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }], tool_choice: "auto" };
}

function context(options = { providers: { limited: { maxMessages: 6, enablePack: true } } }, protocol = "chat") {
  return { policy: policies(options)[0]?.[1], protocol };
}

function route(body, { policy, protocol }) {
  const p = plan(body, protocol, policy);
  return p ? applyText(body, protocol, p) : body;
}

test("policy validation rejects invalid thresholds and ignores retired controls", () => {
  assert.deepEqual(policies({ providers: { a: { maxMessages: 2.5 }, b: { enablePack: null }, c: false, d: { maxMessages: 4, enabled: false }, e: { maxMessages: -1 } } }), []);
  assert.equal(policies({ providers: { limited: 6 } })[0][1].maxMessages, 6);
});

test("packs old text, pins instructions, preserves current input and request controls", () => {
  const body = chat(), original = structuredClone(body), result = route(body, context());
  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.messages[0], body.messages[0]);
  assert.ok(result.messages.at(-1).content.endsWith(body.messages.at(-1).content));
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

test("retired turn controls never trigger compaction without maxMessages", () => {
  const ctx = context({ providers: { limited: { maxTurns: 2, keepTurns: 2 } } });
  const body = chat(5);
  const result = route(body, ctx);
  assert.deepEqual(result, body);
  assert.equal(counts([{ role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] }], "anthropic").turns, 0);
});

test("preserves parallel tool calls and outputs together in the active turn", () => {
  const body = chat(5);
  body.messages.push({ role: "assistant", content: null, tool_calls: ["a", "b"].map((id) => ({ id, type: "function", function: { name: "read", arguments: "{}" } })) },
    { role: "tool", tool_call_id: "a", content: "A" }, { role: "tool", tool_call_id: "b", content: "B" });
  const ctx = context({ providers: { limited: { maxMessages: 7 } } });
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
      assert.equal(payload.stream, true); assert.equal(payload.store, false);
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

test("invalid native compaction explicitly fails rather than text-packing opaque history", async () => {
  for (const output of [{ status: "incomplete", output: [{ type: "compaction", encrypted_content: "partial" }] }, { status: "completed", output: [] }]) {
    const body = responsesBody();
    await assert.rejects(compactSession(body, { maxMessages: 6 }, {
      nativePost: async () => output, compactPost: async () => ({ ...output, object: "response.compaction" }),
    }), (error) => error instanceof CompactionError && error.attempts.length === 4 && error.attempts.at(-1).code === "no_safe_cut");
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
    const result = await compactSession(body, { maxMessages: 6, summary: { model: "small" } }, { summaryPost: async () => data });
    assert.match(result.input[1].content, /original_messages_json/);
    assert.match(result.input[1].content, /question 0/);
    assert.ok(result.input.at(-1).content.endsWith(body.input.at(-1).content));
  }
});

test("no feasible safe cut returns no plan", () => {
  assert.equal(plan(chat(), "chat", { maxMessages: 1 }), null);
});

function toolLoop(n = 100) {
  return { model: "gpt-6.1-sol", store: false, input: [
    { role: "user", content: "Complete the coding task without losing the requirements." },
    ...Array.from({ length: n }, (_, i) => [
      { type: "function_call", call_id: `call_${i}`, name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: `call_${i}`, output: `result ${i}` },
    ]).flat(),
  ] };
}

test("Codex's single-user tool loop compacts below the configured message limit", async () => {
  const body = toolLoop(), original = structuredClone(body);
  let calls = 0;
  const result = await compactSession(body, { maxMessages: 80 }, {
    async nativePost(payload) {
      calls++;
      assert.equal(payload.input.at(-2).type, "function_call_output");
      assert.equal(payload.input.at(-1).type, "compaction_trigger");
      return { status: "completed", output: [{ type: "compaction", encrypted_content: "sealed" }] };
    },
  });
  assert.equal(calls, 1);
  assert.ok(result.input.length <= 80);
  assert.equal(result.input[0].type, "compaction");
  assert.equal(result.input[1].type, "function_call");
  assert.deepEqual(result.input.slice(-2), body.input.slice(-2));
  assert.deepEqual(body, original);
});

test("last fallback tool-loop pack preserves every historical item and the active tool batch", async () => {
  const body = toolLoop();
  const result = await compactSession(body, { maxMessages: 80 }, {});
  assert.ok(result.input.length <= 80);
  assert.equal(result.input[0].role, "user");
  const serialized = result.input[0].content.split("\n")[1];
  const prefix = JSON.parse(JSON.parse(serialized).historical_context);
  assert.deepEqual([...prefix, ...result.input.slice(1)], body.input);
});

test("partial-turn compaction preserves parallel calls, their reasoning and all outputs", async () => {
  const body = toolLoop(10);
  const active = [
    { type: "reasoning", id: "rs_active", encrypted_content: "keep-with-calls" },
    ...["a", "b"].map((id) => ({ type: "function_call", call_id: id, name: "read", arguments: "{}" })),
    ...["a", "b"].map((id) => ({ type: "function_call_output", call_id: id, output: id })),
  ];
  body.input.push(...active);
  const result = await compactSession(body, { maxMessages: 6 }, {
    async nativePost(payload) {
      assert.equal(payload.input.some((i) => i.id === "rs_active"), false);
      return { status: "completed", output: [{ type: "compaction", encrypted_content: "sealed" }] };
    },
  });
  assert.deepEqual(result.input.slice(1), active);
});

test("partial-turn compaction cannot split pending calls or text-pack opaque history", async () => {
  const body = toolLoop(3);
  body.input.splice(1, 0, { type: "function_call", call_id: "pending", name: "read", arguments: "{}" });
  assert.equal(plan(body, "responses", { maxMessages: 4 }, true, 1), null);
  const opaque = toolLoop();
  opaque.input.splice(1, 0, { type: "reasoning", encrypted_content: "opaque" });
  await assert.rejects(compactSession(opaque, { maxMessages: 80 }, {
    nativePost: async () => { throw new Error("unavailable"); },
  }), CompactionError);
});

test("Responses compaction tries trigger then compact, preserving the whole endpoint output", async () => {
  const body = { model: "test", instructions: "Keep the objective.", input: chat().messages };
  const order = [], preserved = { role: "user", content: "Preserved user requirements" };
  const sealed = { type: "compaction", encrypted_content: "sealed" };
  const result = await compactSession(body, { maxMessages: 6 }, {
    nativePost: async () => { order.push("trigger"); throw new Error("trigger failed"); },
    compactPost: async (payload) => {
      order.push("compact");
      assert.deepEqual(Object.keys(payload).sort(), ["input", "instructions", "model"]);
      assert.equal(payload.instructions, body.instructions);
      assert.ok(!payload.input.some((x) => x.type === "compaction_trigger"));
      return { object: "response.compaction", output: [preserved, sealed] };
    },
    summaryPost: async () => { assert.fail("Summary must not run after compact succeeds"); },
  });
  assert.deepEqual(order, ["trigger", "compact"]);
  assert.deepEqual(result.input.slice(1, 3), [preserved, sealed]);
  assert.deepEqual(result.input.at(-1), body.input.at(-1));
});

test("Responses compaction falls back to a validated summary after both native methods fail", async () => {
  const body = { model: "test", input: chat().messages }, order = [];
  const result = await compactSession(body, { maxMessages: 6 }, {
    nativePost: async () => { order.push("trigger"); return { status: "incomplete", output: [] }; },
    compactPost: async () => { order.push("compact"); return { object: "response.compaction", output: [] }; },
    summaryPost: async (payload) => {
      order.push("summary"); assert.equal(payload.model, body.model);
      return { choices: [{ finish_reason: "stop", message: { content: "Keep the goal and pending work." } }] };
    },
  });
  assert.deepEqual(order, ["trigger", "compact", "summary"]);
  assert.match(JSON.stringify(result.input), /Keep the goal and pending work/);
  assert.doesNotMatch(JSON.stringify(result.input), /original_messages_json/);
});

test("Responses compaction reports all failed stages, including incomplete or invalid summaries", async () => {
  const body = { model: "test", input: chat().messages };
  for (const summary of [undefined, "", "x".repeat(100000), "truncated"]) {
    await assert.rejects(compactSession(body, { maxMessages: 6, enablePack: false }, {
      nativePost: async () => { throw Object.assign(new Error("trigger rate limited"), { code: "rate_limit_error", status: 429 }); },
      compactPost: async () => { throw Object.assign(new Error("compact route missing"), { status: 404 }); },
      summaryPost: async () => ({ choices: [{ finish_reason: summary === "truncated" ? "length" : "stop", message: { content: summary } }] }),
    }), (error) => {
      assert.ok(error instanceof CompactionError);
      assert.deepEqual(error.attempts.map((a) => a.method), ["compaction_trigger", "/responses/compact", "summary"]);
      assert.equal(error.attempts[0].status, 429); assert.equal(error.attempts[1].status, 404);
      assert.equal(error.attempts[2].code, "invalid_summary"); return true;
    });
  }
});

test("an oversized standalone compact result continues to summary instead of bypassing limits", async () => {
  const body = { model: "test", input: chat().messages };
  const result = await compactSession(body, { maxMessages: 6 }, {
    nativePost: async () => { throw new Error("unavailable"); },
    compactPost: async () => ({ object: "response.compaction", output: [...body.input, { type: "compaction", encrypted_content: "sealed" }] }),
    summaryPost: async () => ({ choices: [{ finish_reason: "stop", message: { content: "A short valid summary." } }] }),
  });
  assert.ok(result.input.length <= 6);
  assert.match(JSON.stringify(result.input), /A short valid summary/);
});

test("successful HTTP responses containing upstream errors remain explicit failures", async () => {
  await assert.rejects(compactSession({ model: "test", input: chat().messages }, { maxMessages: 6, enablePack: false }, {
    nativePost: async () => ({ error: { code: "trigger_rejected", message: "Trigger is disabled" } }),
    compactPost: async () => ({ error: { code: "compact_rejected", message: "Compact is disabled" } }),
    summaryPost: async () => ({ error: { code: "summary_rejected", message: "Summary is disabled" } }),
  }), (error) => {
    assert.deepEqual(error.attempts.map((a) => a.code), ["trigger_rejected", "compact_rejected", "summary_rejected"]);
    assert.deepEqual(error.attempts.map((a) => a.message), ["Trigger is disabled", "Compact is disabled", "Summary is disabled"]);
    return true;
  });
});


test("native web search history and encrypted search state stay native during compaction", async () => {
  const search = { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "release" } };
  const state = { type: "web_search_output", encrypted_output: "opaque-search-state" };
  const body = toolLoop(); body.input.splice(1, 0, search, state);
  const policy = { maxMessages: 8, enableAlphaSearch: true };
  const compacted = await compactSession(body, policy, { nativePost: async (payload) => {
    assert.ok(payload.input.some((item) => item.encrypted_output === state.encrypted_output));
    assert.ok(payload.input.some((item) => item.id === search.id));
    return { status: "completed", output: [{ type: "compaction", encrypted_content: "sealed-search-context" }] };
  } });
  assert.equal(compacted.input[0].encrypted_content, "sealed-search-context");
  await assert.rejects(compactSession(body, policy), (error) => {
    assert.ok(error instanceof CompactionError); assert.equal(error.attempts.at(-1).code, "no_safe_cut"); return true;
  });
});
