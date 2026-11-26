// Pure counting and safe-cut planning, used by the Provider transport.
const integer = (n, min = 1) => Number.isSafeInteger(n) && n >= min && n <= 100000;

export function policies(options) {
  const source = options?.providers;
  if (!source || typeof source !== "object" || Array.isArray(source)) return [];
  return Object.entries(source).flatMap(([id, value]) => {
    const p = typeof value === "number" ? { maxMessages: value } : value;
    if (!p || typeof p !== "object" || p.enabled === false) return [];
    if (p.maxMessages !== undefined && !integer(p.maxMessages)) return [];
    if (p.maxTurns !== undefined && !integer(p.maxTurns)) return [];
    if (p.maxMessages === undefined && p.maxTurns === undefined) return [];
    if (p.keepTurns !== undefined && !integer(p.keepTurns)) return [];
    if (p.mode !== undefined && !["pack", "summary", "responses"].includes(p.mode)) return [];
    return [[id, { ...p, mode: p.mode ?? "pack", keepTurns: p.keepTurns ?? 4 }]];
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
  const n = counts(items, protocol);
  return withinCounts(n.messages, n.turns, policy);
}

function withinCounts(messages, turns, policy) {
  return (policy.maxMessages === undefined || messages <= policy.maxMessages)
    && (policy.maxTurns === undefined || turns <= policy.maxTurns);
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

// Unknown/opaque and multimodal data must remain native: JSON text cannot
// substitute for an actual image, audio input, encrypted reasoning or a file.
function textOnly(item, protocol) {
  if (protocol === "responses" && ![undefined, "message", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes(item.type)) return false;
  const check = (v) => {
    if (!v || typeof v !== "object") return true;
    if (Array.isArray(v)) return v.every(check);
    if (v.encrypted_content || v.image_url || v.inlineData || v.inline_data || v.fileData || v.file_data || v.thoughtSignature || v.thought_signature) return false;
    if (v.type && !["message", "text", "input_text", "output_text", "tool_use", "tool_result", "function", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes(v.type)) return false;
    return Object.values(v).every(check);
  };
  // Function argument/output strings are preserved verbatim, not parsed.
  return check(item);
}

export function plan(body, protocol, policy, native = false, reserve = 0, force = false) {
  const h = history(body, protocol);
  if (!h || (!force && within(h.items, protocol, policy))) return null;
  const pending = new Map();
  let remainingTurns = counts(h.items.slice(h.start), protocol).turns;
  let valid = true, safeText = true;
  for (let cut = h.start; cut < h.items.length; cut++) {
    const item = h.items[cut];
    if (cut > h.start && userTurn(item, protocol) && pending.size === 0 && valid && (native || safeText)) {
      // A summary is prepended to the first retained user message. Native
      // compaction is a separate input item plus any restored configuration.
      if (remainingTurns <= policy.keepTurns && withinCounts(h.start + reserve + h.items.length - cut, remainingTurns, policy)) {
        return { ...h, cut, prefix: h.items.slice(h.start, cut), tail: h.items.slice(cut) };
      }
    }
    if (userTurn(item, protocol)) remainingTurns--;
    safeText = safeText && textOnly(item, protocol)
      && !(["system", "developer"].includes(item.role) && [undefined, "message"].includes(item.type));
    for (const [direction, id] of toolEvents(item, protocol)) {
      if (!id) { valid = false; continue; }
      const n = (pending.get(id) ?? 0) + direction;
      if (n < 0) valid = false;
      if (n <= 0) pending.delete(id); else pending.set(id, n);
    }
  }
  return null;
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
  if (protocol === "gemini") first.parts = [{ text }, ...(first.parts ?? [])];
  else if (typeof first.content === "string") first.content = text + first.content;
  else if (Array.isArray(first.content)) first.content = [{ type: protocol === "responses" ? "input_text" : "text", text }, ...first.content];
  else return null;
  return { ...body, [p.key]: [...p.items.slice(0, p.start), first, ...p.tail.slice(1)] };
}

