const mediaTypes = new Set(["image_url", "input_image", "image", "input_audio", "input_file", "file", "document", "video_url"]);

// Keep the historical structure as data, with media supplied as actual inputs
// rather than expecting the model to decode URLs or base64 inside JSON text.
export function summaryContent(prefix) {
  const media = [];
  const visit = (value) => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    if (mediaTypes.has(value.type)) {
      media.push(value);
      return { historical_media: media.length };
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry)]));
  };
  const text = JSON.stringify(visit(prefix));
  return media.length ? [{ type: "text", text }, ...media] : text;
}

export function packContent(prefix, protocol, text) {
  const content = summaryContent(prefix);
  if (typeof content === "string") return text(JSON.parse(content));
  const supported = { responses: ["input_image", "input_audio", "input_file"], chat: ["image_url", "input_audio", "file"], anthropic: ["image", "document"] };
  if (!content.slice(1).every((block) => supported[protocol]?.includes(block.type))) {
    throw Object.assign(new Error("Historical media cannot be represented as user input in this protocol"), { code: "unsupported_pack_media" });
  }
  return [{ type: protocol === "responses" ? "input_text" : "text", text: text(JSON.parse(content[0].text)) }, ...content.slice(1)];
}

export function summaryMessages(messages, source, target) {
  return messages.map((message) => ({ ...message, content: !Array.isArray(message.content) ? message.content : message.content.map((block) => {
    if (block.type === "text") return { ...block, type: target === "responses" ? "input_text" : "text" };
    if (source === target) return block;
    if (["image_url", "input_image", "image"].includes(block.type)) {
      const url = block.type === "image_url" ? block.image_url.url : block.type === "input_image" ? block.image_url
        : block.source?.type === "url" ? block.source.url : block.source?.type === "base64"
          ? `data:${block.source.media_type};base64,${block.source.data}` : undefined;
      if (typeof url !== "string" || !url) {
        throw Object.assign(new Error("Summary image conversion requires an image URL or inline data"), { code: "unsupported_summary_content" });
      }
      const detail = block.type === "image_url" ? block.image_url.detail : block.detail;
      if (target === "chat") return { type: "image_url", image_url: { url, ...(detail ? { detail } : {}) } };
      if (target === "responses") return { type: "input_image", image_url: url, ...(detail ? { detail } : {}) };
      const data = /^data:([^;]+);base64,([\s\S]+)$/.exec(url);
      return { type: "image", source: data ? { type: "base64", media_type: data[1], data: data[2] } : { type: "url", url } };
    }
    if (["file", "input_file", "document"].includes(block.type)) {
      const file = block.type === "file" ? block.file : block.type === "input_file"
        ? Object.fromEntries(Object.entries(block).filter(([key]) => key !== "type")) : block.source?.type === "base64"
        ? { file_data: `data:${block.source.media_type};base64,${block.source.data}`, filename: block.title }
        : block.source?.type === "url" ? { file_url: block.source.url } : {};
      // Uploaded IDs belong to their source API and cannot be moved safely.
      if (!file.file_id && (file.file_data || file.file_url)) {
        if (target === "responses") return { type: "input_file", ...file };
        if (target === "chat" && file.file_data) return { type: "file", file };
        if (target === "anthropic") {
          const data = /^data:([^;]+);base64,([\s\S]+)$/.exec(file.file_data ?? "");
          if (data || file.file_url) return { type: "document", ...(file.filename ? { title: file.filename } : {}),
            source: data ? { type: "base64", media_type: data[1], data: data[2] } : { type: "url", url: file.file_url } };
        }
      }
    }
    throw Object.assign(new Error(`Cannot convert summary content ${block.type} from ${source} to ${target}`), { code: "unsupported_summary_content" });
  }) }));
}
