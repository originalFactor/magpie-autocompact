import { randomUUID } from "node:crypto";
import { policies, within } from "./core.js";
import { compactSession, CompactionError, FORCED_COMPACTION, COMPACTION_KIND } from "./session-compaction.js";
import { compactMessages } from "./message-compaction.js";
import { summaryMessages } from "./summary-input.js";
import { compactionNotice } from "./compaction-notice.js";
import { PROTOCOLS, protocolOf, accountHeaders, providerSettings, validateSummary, resolveSummaryProvider } from "./provider-config.js";
import { parseNativeResponse } from "./native.js";
import { historyPrefixKeys } from "./history-cache.js";
import { clientSessionKey, mappedRequest } from "./session-identity.js";
import { SessionStore, SessionLocks, hash } from "./session-store.js";

const HOP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding", "accept-encoding", "upgrade", "proxy-authorization", "proxy-authenticate", "trailer", "te"]);
const TERMINAL = new Set(["response.completed", "response.incomplete", "response.failed", "response.cancelled"]);
const TERMINAL_STATUS = new Set(["completed", "incomplete", "failed", "cancelled"]);
const ROTATION_VERSION = 1;

function withTimeout(signals, timeoutMs) {
  return AbortSignal.any(timeoutMs === 0 ? signals : [...signals, AbortSignal.timeout(timeoutMs)]);
}

function rotationState(record, limit) {
  if (record?.rotationVersion !== ROTATION_VERSION) return { requests: 0, upstreamSessionId: undefined };
  return { requests: record.requests ?? 0, upstreamSessionId: limit === undefined ? undefined : record.upstreamSessionId };
}

class HTTPError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function headersFrom(source) {
  return new Headers([...new Headers(source)].filter(([key]) => !HOP.has(key.toLowerCase())));
}

function jsonReply(upstream, value) {
  const headers = headersFrom(upstream.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { status: upstream.status, headers });
}

async function readText(body, limit = 16 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > limit) throw new HTTPError(413, "body_too_large", "Response body exceeds the configured limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJSON(body) {
  const text = await readText(body);
  try { return JSON.parse(text); }
  catch { throw new HTTPError(502, "invalid_json", "Invalid JSON response"); }
}

async function requireCompactionSuccess(response) {
  if (response.ok) return response;
  let detail;
  try { detail = (await readJSON(response.body))?.error; } catch {}
  throw Object.assign(new Error(typeof detail?.message === "string" ? detail.message : `Upstream returned HTTP ${response.status}`), {
    code: typeof detail?.code === "string" ? detail.code : typeof detail?.type === "string" ? detail.type : "upstream_http_error",
    status: response.status,
  });
}

function compactionErrorBody(error, req, policy, summaryCredential) {
  const values = [req.headers.get("authorization"), req.headers.get("api-key"), req.headers.get("x-api-key"),
    policy?.stateful?.apiKeyEnv && process.env[policy.stateful.apiKeyEnv], summaryCredential].filter(Boolean);
  for (const value of [...values]) if (/^Bearer\s+/i.test(value)) values.push(value.replace(/^Bearer\s+/i, ""));
  const clean = (text) => values.reduce((result, value) => result.split(value).join("[REDACTED]"), String(text))
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]").replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]").slice(0, 1500);
  const attempts = error.attempts.map((attempt) => ({ ...attempt, code: clean(attempt.code), message: clean(attempt.message) }));
  return { type: "magpie_autocompact_error", code: "compaction_failed",
    message: "All configured compaction methods failed: " + attempts.map((a) => `${a.method}${a.status ? ` (HTTP ${a.status})` : ""}: ${a.message}`).join("; "), attempts };
}

function inputItems(input) {
  if (input === undefined || input === null) return [];
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input) || input.some((x) => !x || typeof x !== "object" || Array.isArray(x))) throw new HTTPError(400, "invalid_input", "input must be a string or an array of items");
  return input;
}

function clientReply(reply, original) {
  const result = { ...reply };
  if (original.previous_response_id) result.previous_response_id = original.previous_response_id;
  if (original.conversation) {
    const id = typeof original.conversation === "string" ? original.conversation : original.conversation.id;
    result.conversation = typeof result.conversation === "string" ? id : { ...(result.conversation ?? {}), id };
  }
  return result;
}

// Fetch-native streaming: publishing headers does not release the session
// transaction. It lasts until the stream finishes or the reader cancels it.
function outputStream(upstream, deliver, controller, signal) {
  const channel = new TransformStream(), reader = channel.readable.getReader();
  let finished = false, onAbort;
  const cleanup = () => { finished = true; signal.removeEventListener("abort", onAbort); };
  const body = new ReadableStream({
    start(sink) {
      onAbort = () => {
        if (finished) return;
        cleanup(); sink.error(signal.reason);
        void reader.cancel(signal.reason).catch(() => {});
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    },
    async pull(sink) {
      try {
        const part = await reader.read();
        if (finished) return;
        if (part.done) { cleanup(); sink.close(); } else sink.enqueue(part.value);
      } catch (error) { if (!finished) { cleanup(); sink.error(error); } }
    },
    cancel(reason) { cleanup(); controller.abort(reason); return reader.cancel(reason); },
  });
  deliver(new Response(body, { status: upstream.status, headers: headersFrom(upstream.headers) }));
  return channel.writable.getWriter();
}

async function copyBody(upstream, output) {
  if (upstream.body) for await (const chunk of upstream.body) await output.write(chunk);
  await output.close();
}

async function relaySSE(upstream, output, original, commit, observe) {
  const encoder = new TextEncoder();
  const write = (text) => output.write(encoder.encode(text));
  const decoder = new TextDecoder(); let buffer = "", terminal = false;
  async function frame(raw) {
    const parts = raw.split(/\r?\n/);
    const lines = parts.filter((x) => x.startsWith("data:")).map((x) => x.slice(5).replace(/^ /, ""));
    if (!lines.length || lines.join("\n") === "[DONE]") { await write(raw); return; }
    let event;
    try { event = JSON.parse(lines.join("\n")); } catch { await write(raw); return; }
    if (event.response && typeof event.response === "object") {
      if (!terminal && typeof event.response.id === "string") await observe(event.response);
      if (TERMINAL.has(event.type)) { await commit(event.response); terminal = true; }
      event.response = clientReply(event.response, original);
      // Retain event/id/retry/comment fields and their order. JSON data may
      // span several SSE lines; replace only that data payload.
      let emitted = false;
      const rewritten = parts.flatMap((line) => {
        if (!line.startsWith("data:")) return [line];
        if (emitted) return [];
        emitted = true; return ["data: " + JSON.stringify(event)];
      }).join(raw.includes("\r\n") ? "\r\n" : "\n");
      await write(rewritten);
    } else await write(raw);
  }
  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 16 * 1024 * 1024) throw new Error("SSE event too large");
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const end = boundary.index + boundary[0].length;
      await frame(buffer.slice(0, end)); buffer = buffer.slice(end);
    }
  }
  buffer += decoder.decode();
  if (buffer) await frame(buffer);
  // A truncated upstream stream cannot look like a successful completion.
  if (!terminal) throw new Error("upstream stream ended without a terminal response");
  await output.close();
}

async function relayMessageSSE(response, output, protocol, commit, choices = 1) {
  const decoder = new TextDecoder(), encoder = new TextEncoder(), finished = new Set();
  let buffer = "", terminal = false, stopReason;
  async function frame(raw) {
    const data = raw.split(/\r?\n/).filter((s) => s.startsWith("data:")).map((s) => s.slice(5).trimStart()).join("\n");
    if (data && data !== "[DONE]") {
      const event = JSON.parse(data);
      if (event.error || event.type === "error") throw new Error("Upstream message stream failed");
      if (protocol === "chat") for (const choice of event.choices ?? []) {
        if (typeof choice.finish_reason === "string" && choice.finish_reason) finished.add(choice.index);
      }
      if (protocol === "anthropic") {
        if (event.type === "message_delta") stopReason = event.delta?.stop_reason ?? stopReason;
        if (event.type === "message_stop" && stopReason && !terminal) { await commit(); terminal = true; }
      }
    }
    if (protocol === "chat" && data === "[DONE]" && finished.size >= choices && !terminal) { await commit(); terminal = true; }
    await output.write(encoder.encode(raw));
  }
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 16 * 1024 * 1024) throw new Error("SSE event too large");
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const end = boundary.index + boundary[0].length;
      await frame(buffer.slice(0, end)); buffer = buffer.slice(end);
    }
  }
  buffer += decoder.decode();
  if (buffer) await frame(buffer);
  if (!terminal) throw new Error("Upstream message stream ended without a terminal event");
  await output.close();
}

export async function createSessionTransport(options, { stateDir, fetchImpl = fetch, summaryProviders = {} } = {}) {
  if (!stateDir) throw new Error("stateDir is required for durable server sessions");
  const configured = new Map(policies(options).filter(([, p]) => p.stateful?.enabled === true));
  const summaryContexts = new Map();
  for (const [id, p] of configured) {
    validateSummary(p.summary);
    const target = resolveSummaryProvider(p.summary, id, summaryProviders);
    const local = Object.hasOwn(summaryProviders, id) ? providerSettings(summaryProviders[id], id) : null;
    // Keep credentials only in memory; cache scope contains a digest alone.
    summaryContexts.set(id, { target, models: local?.models ?? {},
      scope: target || local ? hash(JSON.stringify(target ?? { models: local.models })) : null });
    const url = new URL(p.stateful.url);
    const protocol = protocolOf(p), endpoint = PROTOCOLS[protocol].path;
    if (p.enableAlphaSearch === true && protocol !== "responses") throw new Error("enableAlphaSearch requires a Responses upstream");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.pathname.endsWith("/" + endpoint)) throw new Error(`stateful.url must be a direct /${endpoint} HTTP(S) endpoint`);
    if (p.stateful.maxRequests !== undefined && (!Number.isSafeInteger(p.stateful.maxRequests) || p.stateful.maxRequests < 1)) throw new Error("stateful.maxRequests must be an integer >= 1");
    if (p.stateful.timeoutMs !== undefined && (!Number.isSafeInteger(p.stateful.timeoutMs) || (p.stateful.timeoutMs !== 0 && p.stateful.timeoutMs < 100))) throw new Error("stateful.timeoutMs must be 0 or an integer >= 100");
  }
  if (!configured.size) throw new Error("no providers have stateful.enabled=true");
  const store = new SessionStore(stateDir), locks = new SessionLocks(stateDir);
  await store.start();

  async function handle(req, provider, deliver, controller, setOutput) {
    const policy = configured.get(provider);
    if (!policy) throw new HTTPError(404, "not_found", "Provider is not enabled for server sessions");
    const protocol = protocolOf(policy), endpoint = PROTOCOLS[protocol].path;
    const upstreamURL = new URL(policy.stateful.url), path = new URL(req.url);
    const basePath = upstreamURL.pathname.slice(0, -endpoint.length);
    if (path.origin !== upstreamURL.origin || !path.pathname.startsWith(basePath)) throw new HTTPError(400, "invalid_endpoint", "Request must target the configured upstream");
    const route = path.pathname.slice(basePath.length);
    if (protocol === "responses" && !/^(responses(?:\/.*)?|conversations(?:\/.*)?|models(?:\/.*)?)$/.test(route)
      && !(policy.enableAlphaSearch === true && route === "alpha/search")) throw new HTTPError(404, "not_found", "Unknown or disabled provider route");
    if (protocol !== "responses" && route !== endpoint && !/^models(?:\/.*)?$/.test(route)) throw new HTTPError(400, "unsupported_protocol_route", "This upstream only supports its configured message endpoint; native Responses compaction is disabled");
    let headers = headersFrom(req.headers);
    if (policy.stateful.apiKeyEnv) {
      const key = process.env[policy.stateful.apiKeyEnv];
      if (!key) throw new HTTPError(503, "missing_credential", "Configured upstream credential is unavailable");
      headers = accountHeaders(headers, key, protocol);
    }
    const stream = (response) => {
      const output = outputStream(response, deliver, controller, requestSignal);
      setOutput(output); return output;
    };
    const identityHeaders = [...new Set(["authorization", "api-key", "x-api-key", "openai-organization", "openai-project", ...(policy.stateful.identityHeaders ?? [])])];
    // Tenant identity comes from actual upstream credentials, never a client
    // session name. Neither credentials nor their raw values go on disk.
    const namespace = hash(JSON.stringify([provider, upstreamURL.toString(), identityHeaders.map((x) => [x.toLowerCase(), headers.get(x) ?? ""])]));
    if (!identityHeaders.some((x) => headers.get(x)) && policy.stateful.allowUnauthenticated !== true) throw new HTTPError(401, "missing_credential", "Server sessions require an upstream credential");
    const signal = withTimeout([req.signal, controller.signal], policy.stateful.timeoutMs ?? 120000);
    const requestSignal = signal;
    const requestLimit = policy.stateful.maxRequests;
    const compressionEnabled = policy.maxMessages !== undefined;
    let upstreamSessionId;
    async function upstream(method, url, payload, ownSignal = requestSignal, sessionId = upstreamSessionId) {
      const outgoing = mappedRequest(headers, payload, sessionId);
      if (outgoing.payload !== undefined) outgoing.headers.set("content-type", "application/json");
      return fetchImpl(url, { method, headers: outgoing.headers, body: outgoing.payload === undefined ? undefined : JSON.stringify(outgoing.payload), redirect: "error", signal: ownSignal });
    }
    async function json(method, url, payload, ownSignal, sessionId = upstreamSessionId) {
      const response = await upstream(method, url, payload, ownSignal, sessionId);
      if (!response.ok) { await response.body?.cancel(); throw new HTTPError(502, "upstream_state_unavailable", "Unable to read or create upstream session state"); }
      return readJSON(response.body);
    }
    if (route === "alpha/search") {
      if (req.method !== "POST") throw new HTTPError(405, "method_not_allowed", "Native alpha search only supports POST");
      // This actor token authenticates to the gateway, not the upstream.
      headers.delete("x-openai-actor-authorization");
      const raw = await readText(req.body);
      // Search has its own request/response envelope (including encrypted
      // output). Never interpret it as Responses inference or compact it.
      let body, sessionKey;
      if (requestLimit !== undefined) {
        try { body = JSON.parse(raw); } catch { throw new HTTPError(400, "invalid_json", "Invalid alpha search JSON request"); }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new HTTPError(400, "invalid_request", "Expected an alpha search request object");
        sessionKey = clientSessionKey(headers, body);
      }
      const forward = async () => {
        const record = sessionKey ? await store.get(namespace, "session", sessionKey) : null;
        const sessionId = rotationState(record, requestLimit).upstreamSessionId;
        const mapped = mappedRequest(headers, body, sessionId);
        const response = await fetchImpl(req.url, { method: "POST", headers: mapped.headers,
          body: sessionId ? JSON.stringify(mapped.payload) : raw, redirect: "error", signal: requestSignal });
        await copyBody(response, stream(response));
      };
      // Follow an already committed routing ID, but do not rotate or spend an
      // inference request. Serialize only when this client has a stable ID.
      if (sessionKey) await locks.run(namespace + ":session:" + sessionKey, signal, forward);
      else await forward();
      return;
    }
    if (!compressionEnabled && requestLimit === undefined) {
      // With both controls absent, do not parse/rewrite inference or restore a
      // legacy session mapping. Preserve only an existing conversation alias.
      let existingAlias = false;
      if (protocol === "responses") {
        const segment = /^conversations\/([^/]+)/.exec(route)?.[1];
        let id = segment ? decodeURIComponent(segment) : undefined;
        if (route === "responses" && req.method === "POST") {
          try { const body = await readJSON(req.clone().body); id = typeof body.conversation === "string" ? body.conversation : body.conversation?.id; } catch {}
        }
        if (id) existingAlias = !!(await store.get(namespace, "conversation", id));
      }
      if (!existingAlias) {
        const response = await fetchImpl(req.url, { method: req.method, headers,
          body: req.body ? await readText(req.body) : undefined, signal: requestSignal, redirect: "error" });
        await copyBody(response, stream(response)); return;
      }
    }
    async function summaryPost(payload, sessionId, cacheKey) {
      const config = policy.summary;
      const context = summaryContexts.get(provider), target = context.target;
      const summaryProtocol = target?.protocol ?? protocol;
      const model = target?.model ?? context.models[payload.model]?.id ?? payload.model;
      const summarySignal = withTimeout([withTimeout([requestSignal], config?.timeoutMs ?? 25000)], target?.timeoutMs ?? 0);
      const messages = summaryMessages(payload.messages, protocol, summaryProtocol);
      let body;
      if (summaryProtocol === "responses") body = { model, input: messages, stream: true, store: false,
        max_output_tokens: payload.max_tokens, ...(!target ? { prompt_cache_key: sessionId ?? cacheKey } : {}) };
      else if (summaryProtocol === "chat") body = { ...payload, messages, model };
      else body = { model, system: messages[0].content,
        messages: messages.slice(1), max_tokens: payload.max_tokens, stream: false };
      let response;
      if (target) {
        const summaryHeaders = accountHeaders(target.headers, target.key, summaryProtocol);
        summaryHeaders.set("content-type", "application/json");
        response = await requireCompactionSuccess(await fetchImpl(target.url, { method: "POST", headers: summaryHeaders,
          body: JSON.stringify(body), signal: summarySignal, redirect: "error" }));
      } else response = await requireCompactionSuccess(await upstream("POST", upstreamURL, body, summarySignal, sessionId));
      const data = summaryProtocol === "responses" ? parseNativeResponse(await readText(response.body)) : await readJSON(response.body);
      if (data.error) throw Object.assign(new Error(data.error.message ?? "Upstream summary failed"), { code: data.error.code ?? data.error.type ?? "summary_error" });
      if (summaryProtocol === "chat") return data;
      const content = summaryProtocol === "anthropic" ? data.content : (data.output ?? []).filter((x) => x.type === "message").flatMap((x) => x.content ?? []);
      const text = (content ?? []).filter((x) => x.type === (summaryProtocol === "anthropic" ? "text" : "output_text")).map((x) => x.text).join("");
      const completed = summaryProtocol === "anthropic" ? ["end_turn", "stop_sequence"].includes(data.stop_reason) : data.status === "completed";
      return { choices: [{ finish_reason: completed ? "stop" : "length", message: { content: text } }] };
    }

    if (protocol !== "responses") {
      if (/^models(?:\/.*)?$/.test(route) && req.method === "GET") {
        const target = new URL(upstreamURL); target.pathname = basePath + route; target.search = path.search;
        const response = await upstream("GET", target);
        await copyBody(response, stream(response)); return;
      }
      if (req.method !== "POST" || route !== endpoint) throw new HTTPError(405, "method_not_allowed", "Only POST is supported for message inference");
      const original = await readJSON(req.body);
      if (!original || !Array.isArray(original.messages) || original.messages.some((x) => !x || typeof x !== "object" || Array.isArray(x))) throw new HTTPError(400, "invalid_input", "Expected a messages array");
      if (original.previous_response_id || original.conversation || original.background) throw new HTTPError(400, "unsupported_session_reference", "Non-Responses upstreams require full messages, without Responses session references");
      const sessionKey = clientSessionKey(headers, original);
      await locks.run(namespace + ":" + (sessionKey ? "session:" + sessionKey : randomUUID()), signal, async () => {
        const session = sessionKey ? await store.get(namespace, "session", sessionKey) : null;
        let { requests } = rotationState(session, requestLimit);
        let body = structuredClone(original), compacted = false;
        upstreamSessionId = rotationState(session, requestLimit).upstreamSessionId;
        const replayKeys = compressionEnabled ? historyPrefixKeys(original, original.messages, policy, sessionKey, summaryContexts.get(provider).scope) : [];
        for (let i = replayKeys.length - 1; i >= 0; i--) {
          const cached = await store.get(namespace, "prefix", replayKeys[i]);
          if (!cached) continue;
          if (!Array.isArray(cached.input)) throw new Error("Invalid messages prefix record");
          body.messages = [...cached.input, ...original.messages.slice(i + 1)];
          break;
        }
        if (requestLimit !== undefined && requests >= requestLimit) { upstreamSessionId = randomUUID(); requests = 0; }
        if (compressionEnabled && !within(body.messages, protocol, policy)) {
          body = await compactMessages(body, protocol, policy, { summaryPost: (payload) => summaryPost(payload, upstreamSessionId) });
          compacted = true;
        }
        // A completed compaction is reusable even if the following inference
        // fails or its stream is interrupted. Session counters remain tentative.
        if (compacted && replayKeys.length) await store.put(namespace, "prefix", replayKeys.at(-1), { input: body.messages });
        const notice = compacted && policy.compactionNotice ? compactionNotice(protocol, original, body[COMPACTION_KIND], body.messages.length) : null;
        const noticeOutput = notice && original.stream ? stream(new Response(null, { headers: { "content-type": "text/event-stream" } })) : null;
        if (noticeOutput) await notice.start(noticeOutput);
        const response = await upstream("POST", upstreamURL, body);
        if (!response.ok) {
          if (noticeOutput) { await response.body?.cancel(); throw new Error(`Upstream inference returned HTTP ${response.status}`); }
          await copyBody(response, stream(response)); return;
        }
        let committed = false;
        const commit = async () => {
          if (committed) return;
          if (sessionKey) await store.put(namespace, "session", sessionKey, { upstreamSessionId, requests: requests + 1, rotationVersion: ROTATION_VERSION });
          committed = true;
        };
        if (response.headers.get("content-type")?.includes("text/event-stream")) {
          await relayMessageSSE(response, noticeOutput ? notice.writer(noticeOutput) : stream(response), protocol, commit, original.n ?? 1);
        } else {
          const reply = await readJSON(response.body);
          const terminal = protocol === "chat" ? Array.isArray(reply.choices) && reply.choices.length >= (original.n ?? 1) && reply.choices.every((c) => c.message && c.finish_reason)
            : reply.type === "message" && Array.isArray(reply.content) && reply.stop_reason;
          if (reply.error || !terminal) throw new HTTPError(502, "invalid_upstream_response", "Upstream message response is not complete");
          if (noticeOutput) throw new Error("Upstream returned JSON instead of the requested event stream");
          await commit(); deliver(jsonReply(response, notice ? notice.reply(reply) : reply));
        }
      });
      return;
    }
    const conversationsURL = new URL("conversations", upstreamURL);
    const conversationURL = (id) => new URL(conversationsURL.toString() + "/" + encodeURIComponent(id));

    async function listConversation(id) {
      const items = []; let after;
      for (let page = 0; page < 1000; page++) {
        const url = new URL(conversationURL(id).toString() + "/items");
        url.searchParams.set("order", "asc"); url.searchParams.set("limit", "100");
        if (after) url.searchParams.set("after", after);
        const result = await json("GET", url);
        if (!Array.isArray(result.data)) throw new HTTPError(502, "invalid_upstream_state", "Invalid upstream conversation items");
        items.push(...result.data);
        if (!result.has_more) return items;
        const next = result.last_id ?? result.data.at(-1)?.id;
        if (!next || next === after) break;
        after = next;
      }
      throw new HTTPError(502, "invalid_upstream_state", "Conversation pagination did not finish");
    }

    if (route !== "responses" || req.method !== "POST") {
      // Management calls use the same durable alias as inference calls.
      const segments = route.split("/"), kind = segments[0], id = segments[1] && decodeURIComponent(segments[1]);
      await locks.run(namespace + ":" + (kind === "conversations" ? id : "response:" + id), signal, async () => {
        let target = new URL(route, upstreamURL);
        if (kind === "conversations" && id) {
          const alias = await store.get(namespace, "conversation", id);
          if (alias) {
            target = new URL("conversations/" + encodeURIComponent(alias.upstreamId) + (segments.length > 2 ? "/" + segments.slice(2).join("/") : ""), upstreamURL);
            upstreamSessionId = rotationState(alias, requestLimit).upstreamSessionId;
          }
        }
        const record = kind === "responses" && id ? await store.get(namespace, "response", id) : null;
        if (record?.localReply && req.method === "GET" && segments.length === 2) {
          deliver(Response.json(clientReply(record.localReply, record.original))); return;
        }
        if (record?.upstreamResponseId) target = new URL("responses/" + encodeURIComponent(record.upstreamResponseId) + (segments.length > 2 ? "/" + segments.slice(2).join("/") : ""), upstreamURL);
        if (record) upstreamSessionId = rotationState(record, requestLimit).upstreamSessionId;
        target.search = path.search;
        const payload = ["POST", "PATCH"].includes(req.method) ? await readJSON(req.body) : undefined;
        const response = await upstream(req.method, target, payload);
        if (!response.ok) { await copyBody(response, stream(response)); return; }
        if (kind === "responses" && id && req.method === "GET" && segments.length === 2) {
          let reply = await readJSON(response.body);
          if (record?.noticeItem) reply = { ...reply, id, output: [record.noticeItem, ...(reply.output ?? [])] };
          deliver(jsonReply(response, record ? clientReply(reply, record.original) : reply));
        } else if (kind === "conversations" && id && segments.length === 2 && req.method !== "DELETE") {
          const reply = await readJSON(response.body); reply.id = id;
          deliver(jsonReply(response, reply));
        } else await copyBody(response, stream(response));
      });
      return;
    }

    const original = await readJSON(req.body);
    if (!original || typeof original !== "object" || Array.isArray(original)) throw new HTTPError(400, "invalid_request", "Expected a Responses request object");
    if (original.background === true) throw new HTTPError(400, "background_not_supported", "Server session transport requires foreground Responses requests");
    if (original.previous_response_id && original.conversation) throw new HTTPError(400, "invalid_request", "previous_response_id and conversation cannot be combined");
    const conversationId = typeof original.conversation === "string" ? original.conversation : original.conversation?.id;
    if (original.conversation && (typeof conversationId !== "string" || !conversationId)) throw new HTTPError(400, "invalid_conversation", "conversation must name an existing conversation ID");
    const previous = original.previous_response_id;
    const sessionKey = clientSessionKey(headers, original);
    const key = namespace + ":" + (conversationId ? conversationId
      : sessionKey ? "session:" + sessionKey : previous ? "response:" + previous : "response:" + randomUUID());
    await locks.run(key, signal, async () => {
      const incoming = inputItems(original.input);
      let base = [], requests = 0, alias, historyComplete = true, localPrevious = false;
      if (conversationId) {
        alias = await store.get(namespace, "conversation", conversationId) ?? { upstreamId: conversationId, requests: 0 };
        upstreamSessionId = rotationState(alias, requestLimit).upstreamSessionId;
        if (alias.pending) {
          if (!alias.pending.id) throw new HTTPError(409, "ambiguous_conversation_request", "A prior conversation request has an uncertain outcome; reconcile the upstream request before resuming this conversation");
          const recovered = await json("GET", new URL(upstreamURL.toString() + "/" + encodeURIComponent(alias.pending.id)), undefined, undefined, rotationState(alias.pending, requestLimit).upstreamSessionId);
          if (!TERMINAL_STATUS.has(recovered.status)) throw new HTTPError(409, "response_not_finished", "Prior conversation response has not completed");
          const recoveredRequests = rotationState(alias.pending, requestLimit).requests;
          await store.put(namespace, "response", recovered.id, {
            history: [...alias.pending.history, ...recovered.output], historyComplete: alias.pending.historyComplete,
            requests: ["completed", "incomplete"].includes(recovered.status) ? recoveredRequests : rotationState(alias, requestLimit).requests,
            status: recovered.status, original: alias.pending.original,
            upstreamSessionId: rotationState(alias.pending, requestLimit).upstreamSessionId, rotationVersion: ROTATION_VERSION,
          });
          const succeeded = ["completed", "incomplete"].includes(recovered.status);
          alias = { upstreamId: succeeded ? (alias.pending.upstreamId ?? alias.upstreamId) : alias.upstreamId, requests: succeeded ? recoveredRequests : rotationState(alias, requestLimit).requests,
            upstreamSessionId: succeeded ? rotationState(alias.pending, requestLimit).upstreamSessionId : rotationState(alias, requestLimit).upstreamSessionId, rotationVersion: ROTATION_VERSION };
          await store.put(namespace, "conversation", conversationId, alias);
          upstreamSessionId = rotationState(alias, requestLimit).upstreamSessionId;
        }
        if (compressionEnabled) base = await listConversation(alias.upstreamId);
        else historyComplete = false;
        requests = rotationState(alias, requestLimit).requests;
      } else if (previous) {
        let record = await store.get(namespace, "response", previous);
        if (!record && compressionEnabled) throw new HTTPError(409, "unknown_response_chain", "Response chain is not tracked by this provider; start it through this provider or restore its state directory");
        if (!record) {
          const session = sessionKey ? await store.get(namespace, "session", sessionKey) : null;
          record = { ...rotationState(session, requestLimit), rotationVersion: ROTATION_VERSION, history: [], historyComplete: false, status: "completed" };
        }
        historyComplete = record.historyComplete !== false;
        if (compressionEnabled && !historyComplete) throw new HTTPError(409, "unknown_response_chain", "Response history is incomplete; replay full history to enable compaction safely");
        upstreamSessionId = rotationState(record, requestLimit).upstreamSessionId;
        if (!TERMINAL_STATUS.has(record.status)) {
          let recovered = await json("GET", new URL(upstreamURL.toString() + "/" + encodeURIComponent(record.upstreamResponseId ?? previous)));
          if (!TERMINAL_STATUS.has(recovered.status) || !Array.isArray(recovered.output)) throw new HTTPError(409, "response_not_finished", "Previous response has not completed");
          if (record.noticeItem) recovered = { ...recovered, id: previous, output: [record.noticeItem, ...recovered.output] };
          record = { ...record, history: [...record.history, ...recovered.output], status: recovered.status,
            ...(record.noticeItem ? { localReply: recovered } : {}),
            requests: ["completed", "incomplete"].includes(recovered.status) ? record.requests : record.previousRequests ?? 0 };
          await store.put(namespace, "response", previous, record);
          if (sessionKey && record.sessionKey === sessionKey && ["completed", "incomplete"].includes(recovered.status)) {
            const current = rotationState(await store.get(namespace, "session", sessionKey), requestLimit);
            // Publish recovered success only if this session has not already
            // advanced independently since the interrupted request began.
            if (current.requests === record.previousRequests && current.upstreamSessionId === record.previousUpstreamSessionId)
              await store.put(namespace, "session", sessionKey, { requests: record.requests,
                upstreamSessionId: rotationState(record, requestLimit).upstreamSessionId, rotationVersion: ROTATION_VERSION });
          }
        }
        base = record.history; requests = rotationState(record, requestLimit).requests;
        localPrevious = !!record.localReply;
      } else if (sessionKey) {
        const session = await store.get(namespace, "session", sessionKey);
        ({ upstreamSessionId, requests } = rotationState(session, requestLimit));
      }
      // A stable client session owns one counter even when it branches from an
      // older response. Snapshots still retain their original retrieval route.
      if (previous && sessionKey) {
        const session = await store.get(namespace, "session", sessionKey);
        if (session) ({ upstreamSessionId, requests } = rotationState(session, requestLimit));
      }

      const oldRequests = requests;
      const previousUpstreamSessionId = upstreamSessionId;
      let targetConversationId = alias?.upstreamId;
      let body = structuredClone(original);
      let full = { ...body, input: [...base, ...incoming] };
      delete full.previous_response_id; delete full.conversation;
      if (localPrevious) { body.input = full.input; delete body.previous_response_id; }
      const replayKeys = compressionEnabled && !previous && !conversationId ? historyPrefixKeys(body, incoming, policy, sessionKey, summaryContexts.get(provider).scope) : null;
      if (replayKeys) {
        // Longest matching historical prefix, not a client-supplied session ID.
        // Persist only prefixes that have actually been compacted; the client
        // can continue replaying its unmodified history, including store:false.
        for (let i = replayKeys.length - 1; i >= 0; i--) {
          const cached = await store.get(namespace, "prefix", replayKeys[i]);
          if (!cached) continue;
          if (!Array.isArray(cached.input)) throw new Error("invalid history prefix record");
          full.input = [...cached.input, ...incoming.slice(i + 1)];
          body.input = full.input;
          break;
        }
      }
      if (requestLimit !== undefined && requests >= requestLimit) { upstreamSessionId = randomUUID(); requests = 0; }
      let compacted = null;
      if (compressionEnabled && !within(full.input, "responses", policy)) {
        compacted = await compactSession(full, policy, {
          protectedItems: conversationId ? incoming.length : 0,
          nativePost: async (payload) => {
            const response = await requireCompactionSuccess(await upstream("POST", upstreamURL, payload, withTimeout([requestSignal], policy.responses?.timeoutMs ?? 25000), upstreamSessionId));
            return parseNativeResponse(await readText(response.body));
          },
          compactPost: async (payload) => {
            const response = await requireCompactionSuccess(await upstream("POST", new URL(upstreamURL.toString() + "/compact"), payload,
              withTimeout([requestSignal], policy.responses?.timeoutMs ?? 25000), upstreamSessionId));
            return readJSON(response.body);
          },
          summaryPost: (payload) => summaryPost(payload, upstreamSessionId, full.prompt_cache_key),
        });
      }
      if (compacted) {
        full = compacted;
        if (conversationId) {
          const split = compacted[FORCED_COMPACTION] ? compacted.input.length - 1 : compacted.input.length - incoming.length;
          if (split < 0) throw new Error("compaction changed the current input item count");
          const retained = compacted.input.slice(0, split);
          const created = await json("POST", conversationsURL, { items: retained.slice(0, 20) });
          if (typeof created.id !== "string" || !created.id) throw new HTTPError(502, "invalid_upstream_state", "Upstream did not create a conversation");
          for (let offset = 20; offset < retained.length; offset += 20)
            await json("POST", new URL(conversationURL(created.id).toString() + "/items"), { items: retained.slice(offset, offset + 20) });
          targetConversationId = created.id;
          body.conversation = created.id;
          body.input = compacted.input.slice(split);
        } else {
          body.input = compacted.input;
          delete body.previous_response_id;
        }
      } else if (conversationId) body.conversation = alias.upstreamId;

      if (compacted && replayKeys?.length) await store.put(namespace, "prefix", replayKeys.at(-1), { input: full.input });
      const notice = compacted && policy.compactionNotice ? compactionNotice("responses", original, compacted[COMPACTION_KIND], compacted.input.length) : null;
      const noticeOutput = notice && original.stream ? stream(new Response(null, { headers: { "content-type": "text/event-stream" } })) : null;
      if (noticeOutput) await notice.start(noticeOutput);

      const pending = { history: full.input, historyComplete, requests: requests + 1, previousRequests: oldRequests,
        sessionKey, previousUpstreamSessionId,
        original: { previous_response_id: previous, conversation: conversationId }, upstreamId: targetConversationId, upstreamSessionId, rotationVersion: ROTATION_VERSION };
      if (conversationId) {
        // Keep the old alias until inference succeeds. In pack/summary mode,
        // part of the compacted history can be embedded in the new input; an
        // unused shadow is not yet a complete replacement for the old one.
        alias = { ...alias, pending };
        await store.put(namespace, "conversation", conversationId, alias);
      }
      const response = await upstream("POST", upstreamURL, body);
      if (!response.ok) {
        // A gateway may return 5xx/408 AFTER inference ran. In particular,
        // Bun's HTTP server can represent a destroyed connection as a 502.
        // Keep the pending journal unless the upstream explicitly rejected
        // the request, so retrying cannot silently execute it twice.
        if (conversationId && response.status < 500 && response.status !== 408)
          await store.put(namespace, "conversation", conversationId, { upstreamId: alias.upstreamId, requests: oldRequests, upstreamSessionId: rotationState(alias, requestLimit).upstreamSessionId, rotationVersion: ROTATION_VERSION });
        if (noticeOutput) { await response.body?.cancel(); throw new Error(`Upstream inference returned HTTP ${response.status}`); }
        await copyBody(response, stream(response)); return;
      }
      let committed = false;
      let observedId;
      async function observe(reply) {
        if (reply.id === observedId || committed) return;
        observedId = reply.id;
        if (original.store !== false || conversationId) await store.put(namespace, "response", reply.id, { ...pending, status: "in_progress" });
        if (notice && (original.store !== false || conversationId)) await store.put(namespace, "response", notice.id, {
          ...pending, status: "in_progress", upstreamResponseId: reply.id, noticeItem: notice.reply({ output: [] }).output[0],
        });
        if (conversationId) {
          alias.pending.id = reply.id;
          await store.put(namespace, "conversation", conversationId, alias);
        }
      }
      async function commit(reply) {
        if (committed) return;
        if (typeof reply?.id !== "string" || !Array.isArray(reply.output) || !TERMINAL_STATUS.has(reply.status)) throw new HTTPError(502, "invalid_upstream_response", "Upstream response has no terminal ID, status or output array");
        if (original.store !== false || conversationId) {
          await store.put(namespace, "response", reply.id, {
            history: [...full.input, ...reply.output], historyComplete, requests: ["completed", "incomplete"].includes(reply.status) ? requests + 1 : oldRequests, status: reply.status,
            original: { previous_response_id: previous, conversation: conversationId },
            upstreamSessionId, rotationVersion: ROTATION_VERSION,
          });
          if (notice) {
            const localReply = notice.reply(reply);
            await store.put(namespace, "response", notice.id, {
              history: [...full.input, ...localReply.output], historyComplete,
              requests: ["completed", "incomplete"].includes(reply.status) ? requests + 1 : oldRequests, status: reply.status,
              original: { previous_response_id: previous, conversation: conversationId }, localReply,
              upstreamResponseId: reply.id, upstreamSessionId, rotationVersion: ROTATION_VERSION,
            });
          }
        }
        if (conversationId) {
          const succeeded = ["completed", "incomplete"].includes(reply.status);
          await store.put(namespace, "conversation", conversationId, { upstreamId: succeeded ? targetConversationId : alias.upstreamId, requests: succeeded ? requests + 1 : oldRequests,
            upstreamSessionId: succeeded ? upstreamSessionId : rotationState(alias, requestLimit).upstreamSessionId, rotationVersion: ROTATION_VERSION });
        }
        if (!conversationId && sessionKey && ["completed", "incomplete"].includes(reply.status)) {
          await store.put(namespace, "session", sessionKey, { upstreamSessionId, requests: requests + 1, rotationVersion: ROTATION_VERSION });
        }
        committed = true;
      }
      if (response.headers.get("content-type")?.includes("text/event-stream")) await relaySSE(response, noticeOutput ? notice.writer(noticeOutput) : stream(response), original, commit, observe);
      else {
        const reply = await readJSON(response.body);
        if (noticeOutput) throw new Error("Upstream returned JSON instead of the requested event stream");
        await commit(reply);
        deliver(jsonReply(response, clientReply(notice ? notice.reply(reply) : reply, original)));
      }
    });
  }

  const active = new Set();
  return {
    store,
    fetch(provider, input, init) {
      const req = new Request(input, init), controller = new AbortController();
      let output, deliver;
      const response = new Promise((resolve) => { deliver = resolve; });
      const task = handle(req, provider, deliver, controller, (writer) => { output = writer; }).catch(async (error) => {
        if (output) { await output.abort(error).catch(() => {}); return; }
        if (error instanceof CompactionError) {
          // The policy is exhausted, not a transient inference failure. Magpie
          // retries 5xx and would otherwise hide this error behind a timeout.
          deliver(Response.json({ error: compactionErrorBody(error, req, configured.get(provider), summaryContexts.get(provider)?.target?.key) }, { status: 422 })); return;
        }
        deliver(Response.json({ error: {
          type: "magpie_autocompact_error",
          code: error instanceof HTTPError ? error.code : "session_transport_error",
          message: error instanceof HTTPError ? error.message : "Session request could not be completed safely",
        } }, { status: error instanceof HTTPError ? error.status : 502 }));
      }).finally(() => active.delete(task));
      active.add(task);
      return response;
    },
    async close() { await Promise.allSettled([...active]); await store.close(); },
  };
}
