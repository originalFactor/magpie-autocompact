import { randomUUID } from "node:crypto";

export function compactionNotice(protocol, body, setting) {
  const text = typeof setting === "string" ? setting : "上下文已压缩，请继续。";
  const id = `resp_autocompact_${randomUUID()}`, created = Math.floor(Date.now() / 1000);
  const part = { type: "output_text", text, annotations: [] };
  const item = { id: `msg_${randomUUID()}`, type: "message", role: "assistant", status: "completed", content: [part] };
  const reply = protocol === "responses"
    ? { id, object: "response", created_at: created, status: "completed", model: body.model, output: [item],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, error: null, incomplete_details: null }
    : protocol === "chat"
      ? { id: id.replace("resp_", "chatcmpl_"), object: "chat.completion", created, model: body.model,
        choices: Array.from({ length: body.n ?? 1 }, (_, index) => ({ index, message: { role: "assistant", content: text }, finish_reason: "stop" })),
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }
      : { id: item.id, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text }],
        stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
  return { reply, response: (value = reply) => {
    if (!body.stream) return Response.json(value);
    const events = [];
    const add = (event, data) => events.push(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
    if (protocol === "responses") {
      let sequence = 0;
      const emit = (type, data) => add(type, { type, sequence_number: sequence++, ...data });
      const initial = { ...value, status: "in_progress", output: [], usage: null };
      emit("response.created", { response: initial });
      emit("response.in_progress", { response: initial });
      emit("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
      emit("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: "" } });
      emit("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: text });
      emit("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text });
      emit("response.content_part.done", { item_id: item.id, output_index: 0, content_index: 0, part });
      emit("response.output_item.done", { output_index: 0, item });
      emit("response.completed", { response: value });
    } else if (protocol === "chat") {
      const chunk = { id: reply.id, object: "chat.completion.chunk", created, model: body.model };
      add(null, { ...chunk, choices: reply.choices.map(({ index }) => ({ index, delta: { role: "assistant", content: text }, finish_reason: null })) });
      add(null, { ...chunk, choices: reply.choices.map(({ index }) => ({ index, delta: {}, finish_reason: "stop" })) });
      if (body.stream_options?.include_usage) add(null, { ...chunk, choices: [], usage: reply.usage });
      events.push("data: [DONE]\n\n");
    } else {
      add("message_start", { type: "message_start", message: { ...reply, content: [], stop_reason: null } });
      add("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      add("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
      add("content_block_stop", { type: "content_block_stop", index: 0 });
      add("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } });
      add("message_stop", { type: "message_stop" });
    }
    return new Response(events.join(""), { headers: { "content-type": "text/event-stream" } });
  } };
}
