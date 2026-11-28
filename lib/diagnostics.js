import { appendFile } from "node:fs/promises";
import { join } from "node:path";

const types = new Set(["message", "reasoning", "compaction", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "tool_search_call", "tool_search_output"]);
const roles = new Set(["system", "developer", "user", "assistant", "tool", "function"]);
const parts = new Set(["text", "input_text", "output_text", "input_image", "image_url", "image", "input_audio", "input_file", "file", "document", "tool_use", "tool_result", "refusal"]);

export function describeItems(items) {
  const entries = items.slice(0, 2000).map((item) => {
    const type = item.type ?? (item.role ? "message" : "unknown");
    const content = item.content;
    const blocks = Array.isArray(content) ? content : [];
    const text = typeof content === "string" ? content : blocks.filter((b) => ["text", "input_text", "output_text"].includes(b?.type)).map((b) => typeof b.text === "string" ? b.text : "").join("");
    return { type: types.has(type) ? type : "other", ...(roles.has(item.role) ? { role: item.role } : {}),
      ...(["analysis", "commentary", "final", "final_answer"].includes(item.phase) ? { phase: item.phase } : {}),
      ...(typeof content === "string" || Array.isArray(content) ? { textChars: text.length, blankText: !text.trim(),
        ...(Array.isArray(content) ? { blocks: blocks.map((b) => parts.has(b?.type) ? b.type : "other") } : {}) } : {}),
      ...(item.role === "assistant" && content == null ? { nullContent: true } : {}),
      ...(Array.isArray(item.tool_calls) ? { toolCalls: item.tool_calls.length } : {}) };
  });
  return { count: items.length, items: entries, ...(items.length > entries.length ? { omitted: items.length - entries.length } : {}) };
}

export async function diagnosticLog(stateDir, enabled, event) {
  if (!enabled) return;
  try { await appendFile(join(stateDir, "diagnostics.jsonl"), JSON.stringify({ time: new Date().toISOString(), ...event }) + "\n", { mode: 0o600 }); }
  catch (error) { console.warn("magpie-autocompact: unable to write diagnostic log", error?.code ?? "write_error"); }
}
