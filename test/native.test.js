import test from "node:test";
import assert from "node:assert/strict";
import { parseNativeResponse } from "../lib/native.js";

const item = { type: "compaction", id: "cmp_test", encrypted_content: "sealed-prefix" };
const completed = { id: "resp_test", status: "completed", output: [item] };
const frame = (event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
const done = frame({ type: "response.output_item.done", output_index: 0, item });

test("native response accepts JSON and completed SSE without duplicating items", () => {
  assert.deepEqual(parseNativeResponse(JSON.stringify(completed)), completed);
  const text = ": keepalive\r\n\r\n" + done + frame({ type: "response.completed", response: completed }) + "data: [DONE]\r\n\r\n";
  assert.deepEqual(parseNativeResponse(text), completed);
});

test("native response recovers an item omitted from the completed output", () => {
  assert.deepEqual(parseNativeResponse(done + frame({ type: "response.completed", response: { ...completed, output: [] } })), completed);
});

test("native response rejects truncated, failed and incomplete streams", () => {
  for (const type of ["error", "response.failed", "response.incomplete", "response.cancelled"]) {
    assert.throws(() => parseNativeResponse(done + frame({ type, response: completed })));
  }
  assert.throws(() => parseNativeResponse(done + "data: [DONE]\n\n"));
  assert.throws(() => parseNativeResponse(done + frame({ type: "response.completed", response: { ...completed, status: "in_progress" } })));
  assert.throws(() => parseNativeResponse(done + "data: invalid\n\n"));
});

test("native SSE errors preserve the upstream code and reason", () => {
  assert.throws(() => parseNativeResponse(frame({ type: "error", code: "upstream_rate_limit", message: "Native compaction quota exhausted" })),
    (error) => error.code === "upstream_rate_limit" && error.message === "Native compaction quota exhausted");
});
