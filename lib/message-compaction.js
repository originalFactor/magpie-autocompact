import { compactHistory } from "./session-compaction.js";

// Chat Completions and Messages never invoke either native Responses method.
export function compactMessages(body, protocol, policy, callbacks) {
  if (!["chat", "anthropic"].includes(protocol)) throw new Error("Expected chat or anthropic protocol");
  return compactHistory(body, protocol, policy, callbacks);
}
