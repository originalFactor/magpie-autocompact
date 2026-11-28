import { hash } from "./session-store.js";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function normalized(item) {
  const result = { ...item };
  const type = result.type ?? (result.role ? "message" : undefined);
  // SDKs may omit response envelope IDs/status when replaying full history.
  // Preserve semantic references (call_id, item_reference.id) and all opaque
  // contents; arbitrary unknown item fields are never stripped.
  if (["message", "reasoning", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "tool_search_call", "tool_search_output", "compaction"].includes(type)) {
    delete result.id; delete result.status;
    result.type = type;
  }
  if (type === "message" && typeof result.content === "string") {
    result.content = [{ type: result.role === "assistant" ? "output_text" : "input_text", text: result.content }];
  }
  if (type === "message" && Array.isArray(result.content)) {
    result.content = result.content.map((part) => {
      if (part?.type !== "output_text" || !Array.isArray(part.annotations) || part.annotations.length) return part;
      const { annotations, ...rest } = part;
      return rest;
    });
  }
  return result;
}

export function historyPrefixKeys(body, items, policy, sessionKey = null, summaryScope = null) {
  // A cached native item is valid only under the same model/configuration.
  // Account, endpoint and project isolation is provided by the store namespace.
  const { diagnostics: _diagnostics, ...cachePolicy } = policy;
  let key = hash(JSON.stringify(canonical({ model: body.model, instructions: body.instructions,
    tools: body.tools, reasoning: body.reasoning, text: body.text, system: body.system, thinking: body.thinking,
    tool_choice: body.tool_choice, response_format: body.response_format, output_config: body.output_config, policy: cachePolicy, sessionKey,
    ...(summaryScope ? { summaryProvider: summaryScope } : {}),
    // Prefixes no longer carry or restore a session identity or request count.
    compactionStrategy: "trigger-compact-summary-pack-v2" })));
  return items.map((item) => {
    key = hash(key + ":" + JSON.stringify(canonical(normalized(item))));
    return key;
  });
}
