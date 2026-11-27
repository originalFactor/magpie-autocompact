// Native compression may return JSON or SSE, independently of Content-Type.
// Never turn a truncated stream or an error into a completed compression.
export function parseNativeResponse(text) {
  try { return JSON.parse(text); } catch {}
  let terminal;
  const compactions = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const raw = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!raw || raw === "[DONE]") continue;
    const event = JSON.parse(raw);
    if (event.error || ["error", "response.failed", "response.incomplete", "response.cancelled"].includes(event.type)) {
      const detail = event.error ?? event.response?.error ?? event;
      throw Object.assign(new Error(typeof detail.message === "string" ? detail.message : `Native compaction ended with ${event.type}`), {
        code: detail.code ?? detail.type ?? "native_stream_error",
      });
    }
    if (event.type === "response.output_item.done" && event.item?.type === "compaction") compactions.push(event.item);
    if (event.type === "response.completed") {
      if (terminal || event.response?.status !== "completed" || !Array.isArray(event.response.output)) {
        throw new Error("Invalid native compaction terminal response");
      }
      terminal = event.response;
    }
  }
  if (!terminal) throw new Error("Native compaction stream ended without a completed response");
  // Some upstreams publish the item only in output_item.done, leaving the
  // completed response's output empty. Retain it only after a real terminal.
  for (const item of compactions) {
    if (!terminal.output.some((other) => other.type === "compaction" && other.encrypted_content === item.encrypted_content)) terminal.output.push(item);
  }
  return terminal;
}

export function restorations(prefix) {
  const tools = prefix.filter((x) => x.type === "additional_tools"
    || (["system", "developer"].includes(x.role) && [undefined, "message"].includes(x.type)));
  const update = { type: "configuration_update" };
  for (const item of prefix) {
    if (item.type !== "configuration_update") continue;
    if (item.reasoning?.effort !== undefined) update.reasoning = { effort: item.reasoning.effort };
    if (item.text?.format !== undefined) update.text = { format: item.text.format };
  }
  return [...tools, ...(Object.keys(update).length > 1 ? [update] : [])];
}
