import { randomUUID } from "node:crypto";

// A notice belongs to the same assistant turn as the upstream inference.
export function compactionNotice(protocol, body, setting) {
  const text = (typeof setting === "string" ? setting : "上下文已压缩，请继续。") + "\n\n";
  const id = `resp_autocompact_${randomUUID()}`, created = Math.floor(Date.now() / 1000);
  const part = { type: "output_text", text, annotations: [] };
  const item = { id: `msg_${randomUUID()}`, type: "message", role: "assistant", status: "completed", content: [part] };
  let sequence = 0;
  const event = (type, data) => `${type ? `event: ${type}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
  const responseEvent = (type, data) => event(type, { type, ...data, sequence_number: sequence++ });
  const chunk = { id: id.replace("resp_", "chatcmpl_"), object: "chat.completion.chunk", created, model: body.model };
  function reply(value) {
    if (protocol === "responses") return { ...value, id, output: [item, ...(value.output ?? [])] };
    if (protocol === "chat") return { ...value, choices: value.choices.map((choice) => ({ ...choice,
      message: { ...choice.message, content: text + (choice.message.content ?? "") } })) };
    return { ...value, content: [{ type: "text", text }, ...value.content] };
  }
  async function start(output) {
    let prefix;
    if (protocol === "responses") {
      const initial = { id, object: "response", created_at: created, status: "in_progress", model: body.model, output: [], usage: null,
        previous_response_id: body.previous_response_id ?? null,
        conversation: body.conversation ? { id: typeof body.conversation === "string" ? body.conversation : body.conversation.id } : null };
      prefix = responseEvent("response.created", { response: initial })
        + responseEvent("response.in_progress", { response: initial })
        + responseEvent("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } })
        + responseEvent("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: "" } })
        + responseEvent("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: text })
        + responseEvent("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text })
        + responseEvent("response.content_part.done", { item_id: item.id, output_index: 0, content_index: 0, part })
        + responseEvent("response.output_item.done", { output_index: 0, item });
    } else if (protocol === "chat") {
      prefix = event(null, { ...chunk, choices: Array.from({ length: body.n ?? 1 }, (_, index) => ({ index,
        delta: { role: "assistant", content: text }, finish_reason: null })) });
    } else {
      prefix = event("message_start", { type: "message_start", message: { id: item.id, type: "message", role: "assistant", model: body.model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })
        + event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
        + event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })
        + event("content_block_stop", { type: "content_block_stop", index: 0 });
    }
    await output.write(new TextEncoder().encode(prefix));
  }
  function writer(output) {
    const encoder = new TextEncoder(), decoder = new TextDecoder();
    let inputUsage;
    return {
      async write(bytes) {
        const raw = decoder.decode(bytes), lines = raw.split(/\r?\n/);
        const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") return output.write(bytes);
        let value;
        try { value = JSON.parse(data); } catch { return output.write(bytes); }
        if (protocol === "responses") {
          if (["response.created", "response.in_progress"].includes(value.type)) return;
          if (typeof value.response_id === "string") value.response_id = id;
          if (typeof value.output_index === "number") value.output_index++;
          if (value.response) value.response = { ...value.response, id, output: [item, ...(value.response.output ?? [])] };
          value.sequence_number = sequence++;
        } else if (protocol === "chat") value.id = chunk.id;
        else {
          if (value.type === "message_start") { inputUsage = value.message?.usage; return; }
          if (typeof value.index === "number") value.index++;
          if (value.type === "message_delta" && inputUsage) value.usage = { ...inputUsage, ...value.usage };
        }
        let emitted = false;
        const rewritten = lines.flatMap((line) => {
          if (!line.startsWith("data:")) return [line];
          if (emitted) return [];
          emitted = true; return ["data: " + JSON.stringify(value)];
        }).join(raw.includes("\r\n") ? "\r\n" : "\n");
        await output.write(encoder.encode(rewritten));
      },
      close: () => output.close(),
    };
  }
  return { id, reply, start, writer };
}
