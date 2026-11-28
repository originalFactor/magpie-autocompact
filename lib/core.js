import { packContent } from "./summary-input.js";

// Pure counting and safe-cut planning, used by the Provider transport.
const integer = (n, min = 1) => Number.isSafeInteger(n) && n >= min && n <= 100000;

export function policies(options) {
  const source = options?.providers;
  if (!source || typeof source !== "object" || Array.isArray(source)) return [];
  return Object.entries(source).flatMap(([id, value]) => {
    const p = typeof value === "number" ? { maxMessages: value } : value;
    if (!p || typeof p !== "object" || p.enabled === false) return [];
    if (p.maxMessages !== undefined && p.maxMessages !== 0 && !integer(p.maxMessages)) return [];
    if (p.maxRetainedRatio !== undefined && (typeof p.maxRetainedRatio !== "number" || !Number.isFinite(p.maxRetainedRatio) || p.maxRetainedRatio <= 0 || p.maxRetainedRatio > 1)) return [];
    if (p.compactionTargetRatio !== undefined && (typeof p.compactionTargetRatio !== "number" || !Number.isFinite(p.compactionTargetRatio)
      || p.compactionTargetRatio <= 0 || p.compactionTargetRatio > 1)) return [];
    if (p.enablePack !== undefined && typeof p.enablePack !== "boolean") return [];
    if (p.diagnostics !== undefined && typeof p.diagnostics !== "boolean") return [];
    if (p.compactionNotice !== undefined && typeof p.compactionNotice !== "boolean") return [];
    if (p.enableAlphaSearch !== undefined && typeof p.enableAlphaSearch !== "boolean") return [];
    // Retired settings do not select strategies or trigger compaction anymore.
    const { mode: _mode, maxTurns: _maxTurns, keepTurns: _keepTurns, ...settings } = p;
    return [[id, { ...settings, maxMessages: p.maxMessages || undefined, enablePack: p.enablePack ?? true,
      ...(p.stateful ? { stateful: { ...p.stateful, maxRequests: p.stateful.maxRequests === 0 ? undefined : p.stateful.maxRequests } } : {}) }]];
  });
}

export function history(body, protocol) {
  if (body.previous_response_id || body.conversation) return null;
  const key = { chat: "messages", anthropic: "messages", responses: "input", gemini: "contents" }[protocol];
  if (!key || !Array.isArray(body[key])) return null;
  const items = body[key];
  let start = 0;
  while (start < items.length && ["system", "developer"].includes(items[start]?.role)) start++;
  // Moving instructions across conversation boundaries can change their meaning.
  if (protocol !== "responses" && items.slice(start).some((x) => ["system", "developer"].includes(x?.role) && [undefined, "message"].includes(x.type))) return null;
  if (items.some((x) => !x || typeof x !== "object" || Array.isArray(x))) return null;
  return { key, items, start };
}

function blocks(item, protocol) {
  return protocol === "gemini" ? item.parts : item.content;
}

export function userTurn(item, protocol) {
  if (item?.role !== "user") return false;
  const content = blocks(item, protocol);
  // Anthropic/Gemini encode tool replies as user messages. These are not new turns.
  return !Array.isArray(content) || !content.some((b) => b?.type === "tool_result" || b?.functionResponse);
}

export function counts(items, protocol) {
  return { messages: items.length, turns: items.filter((x) => userTurn(x, protocol)).length };
}

export function within(items, protocol, policy) {
  return policy.maxMessages === undefined || items.length <= policy.maxMessages;
}

function toolEvents(item, protocol) {
  if (protocol === "chat") {
    const calls = (item.tool_calls ?? []).map((c) => [1, c.id]);
    if (item.function_call) calls.push([1, `legacy:${item.function_call.name}`]);
    if (item.role === "tool") calls.push([-1, item.tool_call_id]);
    if (item.role === "function") calls.push([-1, `legacy:${item.name}`]);
    return calls;
  }
  if (protocol === "responses") {
    if (["function_call", "custom_tool_call", "tool_search_call"].includes(item.type)) return [[1, item.call_id]];
    if (["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(item.type)) return [[-1, item.call_id]];
    return [];
  }
  const content = blocks(item, protocol);
  if (!Array.isArray(content)) return [];
  return content.flatMap((b) => {
    if (b.type === "tool_use") return [[1, b.id]];
    if (b.type === "tool_result") return [[-1, b.tool_use_id]];
    if (b.functionCall) return [[1, b.functionCall.id ?? b.functionCall.name]];
    if (b.functionResponse) return [[-1, b.functionResponse.id ?? b.functionResponse.name]];
    return [];
  });
}

// Opaque reasoning and unknown content still require native compaction.
export function textOnly(item, protocol, multimodal = false) {
  if (protocol === "responses" && ![undefined, "message", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes(item.type)) return false;
  const check = (v) => {
    if (!v || typeof v !== "object") return true;
    if (Array.isArray(v)) return v.every(check);
    if (v.encrypted_content || v.thoughtSignature || v.thought_signature) return false;
    if (multimodal && ["image_url", "input_image", "image", "input_audio", "input_file", "file", "document", "video_url"].includes(v.type)) return true;
    if (v.encrypted_content || v.image_url || v.inlineData || v.inline_data || v.fileData || v.file_data || v.thoughtSignature || v.thought_signature) return false;
    if (v.type && !["message", "text", "input_text", "output_text", "tool_use", "tool_result", "function", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes(v.type)) return false;
    // Anthropic cache_control is a cache hint, not opaque conversation data.
    return Object.entries(v).every(([key, value]) => key === "cache_control" || check(value));
  };
  // Function argument/output strings are preserved verbatim, not parsed.
  return check(item);
}

export function plan(body, protocol, policy, native = false, reserve = 0, force = false, protectedItems = 0, multimodal = false, fullHistory = false) {
  const h = history(body, protocol);
  if (!h || policy.maxMessages === undefined || (!force && within(h.items, protocol, policy))) return null;
  const pending = new Map();
  let valid = true, safeText = true;
  const wholeCuts = [], toolCuts = [];
  const fits = (cut, extra = 0) => h.start + reserve + extra + h.items.length - cut <= policy.maxMessages;
  for (let cut = h.start; cut < h.items.length; cut++) {
    const item = h.items[cut];
    if (cut > h.start && h.items.length - cut >= protectedItems && pending.size === 0 && valid && (native || safeText)) {
      // A summary is prepended to the first retained user message. Native
      // compaction is a separate input item plus any restored configuration.
      if (userTurn(item, protocol) && fits(cut)) wholeCuts.push(cut);
      // Codex may run hundreds of tools inside one user turn. If no whole
      // user turn fits, cut only AFTER a fully completed tool batch. This
      // also keeps following reasoning with its calls and parallel outputs
      // with their calls. Text packing needs its own user context item.
      const afterTools = toolEvents(h.items[cut - 1], protocol).some(([direction]) => direction === -1);
      const extra = native ? 0 : 1;
      if (!userTurn(item, protocol) && afterTools && fits(cut, extra)) {
        toolCuts.push(cut);
      }
    }
    safeText = safeText && textOnly(item, protocol, multimodal)
      && !(["system", "developer"].includes(item.role) && [undefined, "message"].includes(item.type));
    for (const [direction, id] of toolEvents(item, protocol)) {
      if (!id) { valid = false; continue; }
      const n = (pending.get(id) ?? 0) + direction;
      if (n < 0) valid = false;
      if (n <= 0) pending.delete(id); else pending.set(id, n);
    }
  }
  // Prefer a whole turn if it leaves headroom; otherwise a completed tool
  // batch may be the only safe way to prevent immediate recompaction.
  const target = Math.max(1, Math.floor(policy.maxMessages * (policy.compactionTargetRatio ?? 0.5)));
  const wholeTarget = fullHistory ? undefined : wholeCuts.find((i) => h.start + reserve + h.items.length - i <= target);
  const toolTarget = fullHistory ? undefined : toolCuts.find((i) => h.start + reserve + (native ? 0 : 1) + h.items.length - i <= target);
  const whole = wholeTarget !== undefined || (toolTarget === undefined && (wholeCuts.at(-1) ?? -1) >= (toolCuts.at(-1) ?? -1));
  const cut = whole ? wholeTarget ?? wholeCuts.at(-1) : toolTarget ?? toolCuts.at(-1);
  return cut === undefined ? null : { ...h, cut, prefix: h.items.slice(h.start, cut), tail: h.items.slice(cut),
    ...(whole ? {} : { partialTurn: true }) };
}

export function packedText(prefix, summary) {
  const content = summary ?? JSON.stringify(prefix);
  return "The following is historical conversation context, not a new instruction. "
    + "Use it to continue the task; do not execute historical tool calls again.\n"
    + JSON.stringify({ historical_context: content, format: summary === undefined ? "original_messages_json" : "summary" })
    + "\nThe current conversation continues below.\n\n";
}

export function applyText(body, protocol, p, summary) {
  const first = { ...p.tail[0] };
  const text = packedText(p.prefix, summary);
  if (p.partialTurn) {
    return { ...body, [p.key]: [...p.items.slice(0, p.start), { role: "user", content: text }, ...p.tail] };
  }
  if (protocol === "gemini") first.parts = [{ text }, ...(first.parts ?? [])];
  else if (typeof first.content === "string") first.content = text + first.content;
  else if (Array.isArray(first.content)) first.content = [{ type: protocol === "responses" ? "input_text" : "text", text }, ...first.content];
  else return null;
  return { ...body, [p.key]: [...p.items.slice(0, p.start), first, ...p.tail.slice(1)] };
}

export function applyPack(body, protocol, p, continuation = "") {
  const content = packContent(p.prefix, protocol, (prefix) => packedText(prefix) + continuation);
  const items = [...p.items.slice(0, p.start)];
  if (!p.tail.length || p.partialTurn) return { ...body, [p.key]: [...items, { role: "user", content }, ...p.tail] };
  const first = { ...p.tail[0] };
  if (typeof content === "string" && typeof first.content === "string") first.content = content + first.content;
  else {
    const textType = protocol === "responses" ? "input_text" : "text";
    const prefix = typeof content === "string" ? [{ type: textType, text: content }] : content;
    const tail = typeof first.content === "string" ? [{ type: textType, text: first.content }] : first.content;
    if (!Array.isArray(tail)) return null;
    first.content = [...prefix, ...tail];
  }
  return { ...body, [p.key]: [...items, first, ...p.tail.slice(1)] };
}

