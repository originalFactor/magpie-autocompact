import { hash } from "./session-store.js";

const SESSION_HEADERS = ["session-id", "session_id", "x-session-id"];
const THREAD_HEADERS = ["thread-id", "thread_id", "conversation-id", "conversation_id", "x-conversation-id"];
const string = (value) => typeof value === "string" && value.trim() ? value : undefined;

export function clientSessionKey(headers, body) {
  const session = SESSION_HEADERS.map((name) => string(headers.get(name))).find(Boolean)
    ?? string(body.session_id) ?? string(body.metadata?.session_id);
  const thread = THREAD_HEADERS.map((name) => string(headers.get(name))).find(Boolean) ?? string(body.conversation_id);
  const cache = string(body.prompt_cache_key);
  if (!session && !thread && !cache) return null;
  const identity = session ?? thread ?? cache;
  // These are routing identifiers, never authentication. The caller scopes
  // the record to the actual provider credentials, endpoint and project.
  return hash(JSON.stringify([body.model, identity, thread ?? identity, cache ?? identity]));
}

export function mappedRequest(headers, payload, sessionId) {
  const outgoing = new Headers(headers);
  if (!sessionId) return { headers: outgoing, payload };
  for (const name of [...SESSION_HEADERS, ...THREAD_HEADERS]) {
    if (outgoing.has(name)) outgoing.set(name, sessionId);
  }
  outgoing.set("session-id", sessionId);
  outgoing.set("session_id", sessionId);
  // The old turn's sticky token must not route a new generation back to it.
  outgoing.delete("x-codex-turn-state");
  if (!payload || typeof payload !== "object") return { headers: outgoing, payload };
  const body = { ...payload };
  for (const field of ["prompt_cache_key", "session_id", "conversation_id"]) {
    if (string(body[field])) body[field] = sessionId;
  }
  if (string(body.metadata?.session_id)) body.metadata = { ...body.metadata, session_id: sessionId };
  return { headers: outgoing, payload: body };
}
