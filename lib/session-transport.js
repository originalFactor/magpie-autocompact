import { randomUUID } from "node:crypto";
import { policies, within } from "./core.js";
import { compactSession } from "./session-compaction.js";
import { SessionStore, SessionLocks, hash } from "./session-store.js";

const HOP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding", "accept-encoding", "upgrade", "proxy-authorization", "proxy-authenticate", "trailer", "te"]);
const TERMINAL = new Set(["response.completed", "response.incomplete", "response.failed", "response.cancelled"]);
const TERMINAL_STATUS = new Set(["completed", "incomplete", "failed", "cancelled"]);

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

async function readJSON(body, limit = 16 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > limit) throw new HTTPError(413, "body_too_large", "JSON body exceeds the configured limit");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HTTPError(502, "invalid_json", "Invalid JSON response"); }
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

export async function createSessionTransport(options, { stateDir, fetchImpl = fetch } = {}) {
  if (!stateDir) throw new Error("stateDir is required for durable server sessions");
  const configured = new Map(policies(options).filter(([, p]) => p.stateful?.enabled === true));
  for (const [, p] of configured) {
    const url = new URL(p.stateful.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.pathname.endsWith("/responses")) throw new Error("stateful.url must be a direct /responses HTTP(S) endpoint");
    if (p.stateful.maxRequests !== undefined && (!Number.isSafeInteger(p.stateful.maxRequests) || p.stateful.maxRequests < 2)) throw new Error("stateful.maxRequests must be an integer >= 2");
    if (p.stateful.timeoutMs !== undefined && (!Number.isSafeInteger(p.stateful.timeoutMs) || p.stateful.timeoutMs < 100)) throw new Error("stateful.timeoutMs must be an integer >= 100");
  }
  if (!configured.size) throw new Error("no providers have stateful.enabled=true");
  const store = new SessionStore(stateDir), locks = new SessionLocks(stateDir);
  await store.start();

  async function handle(req, provider, deliver, controller, setOutput) {
    const policy = configured.get(provider);
    if (!policy) throw new HTTPError(404, "not_found", "Provider is not enabled for server sessions");
    const upstreamURL = new URL(policy.stateful.url), path = new URL(req.url);
    const basePath = upstreamURL.pathname.slice(0, -"responses".length);
    if (path.origin !== upstreamURL.origin || !path.pathname.startsWith(basePath)) throw new HTTPError(400, "invalid_endpoint", "Request must target the configured upstream");
    const route = path.pathname.slice(basePath.length);
    if (!/^(responses(?:\/.*)?|conversations(?:\/.*)?|models(?:\/.*)?)$/.test(route)) throw new HTTPError(404, "not_found", "Unknown provider route");
    const headers = headersFrom(req.headers);
    if (policy.stateful.apiKeyEnv) {
      const key = process.env[policy.stateful.apiKeyEnv];
      if (!key) throw new HTTPError(503, "missing_credential", "Configured upstream credential is unavailable");
      headers.set("authorization", `Bearer ${key}`);
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
    const signal = AbortSignal.any([req.signal, controller.signal, AbortSignal.timeout(policy.stateful.timeoutMs ?? 120000)]);
    const requestSignal = signal;
    async function upstream(method, url, payload, ownSignal = requestSignal) {
      const outgoing = new Headers(headers);
      if (payload !== undefined) outgoing.set("content-type", "application/json");
      return fetchImpl(url, { method, headers: outgoing, body: payload === undefined ? undefined : JSON.stringify(payload), redirect: "error", signal: ownSignal });
    }
    async function json(method, url, payload, ownSignal) {
      const response = await upstream(method, url, payload, ownSignal);
      if (!response.ok) { await response.body?.cancel(); throw new HTTPError(502, "upstream_state_unavailable", "Unable to read or create upstream session state"); }
      return readJSON(response.body);
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
          if (alias) target = new URL("conversations/" + encodeURIComponent(alias.upstreamId) + (segments.length > 2 ? "/" + segments.slice(2).join("/") : ""), upstreamURL);
        }
        target.search = path.search;
        const payload = ["POST", "PATCH"].includes(req.method) ? await readJSON(req.body) : undefined;
        const response = await upstream(req.method, target, payload);
        if (!response.ok) { await copyBody(response, stream(response)); return; }
        if (kind === "responses" && id && req.method === "GET" && segments.length === 2) {
          const record = await store.get(namespace, "response", id), reply = await readJSON(response.body);
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
    const key = namespace + ":" + (conversationId ?? ("response:" + (previous ?? randomUUID())));
    await locks.run(key, signal, async () => {
      const incoming = inputItems(original.input);
      let base = [], requests = 0, alias;
      if (conversationId) {
        alias = await store.get(namespace, "conversation", conversationId) ?? { upstreamId: conversationId, requests: 0 };
        if (alias.pending) {
          if (!alias.pending.id) throw new HTTPError(409, "ambiguous_conversation_request", "A prior conversation request has an uncertain outcome; reconcile the upstream request before resuming this conversation");
          const recovered = await json("GET", new URL(upstreamURL.toString() + "/" + encodeURIComponent(alias.pending.id)));
          if (!TERMINAL_STATUS.has(recovered.status)) throw new HTTPError(409, "response_not_finished", "Prior conversation response has not completed");
          await store.put(namespace, "response", recovered.id, {
            history: [...alias.pending.history, ...recovered.output], requests: alias.pending.requests, status: recovered.status, original: alias.pending.original,
          });
          const succeeded = ["completed", "incomplete"].includes(recovered.status);
          alias = { upstreamId: succeeded ? (alias.pending.upstreamId ?? alias.upstreamId) : alias.upstreamId, requests: succeeded ? alias.pending.requests : alias.requests + 1 };
          await store.put(namespace, "conversation", conversationId, alias);
        }
        base = await listConversation(alias.upstreamId);
        requests = alias.requests;
      } else if (previous) {
        let record = await store.get(namespace, "response", previous);
        if (!record) throw new HTTPError(409, "unknown_response_chain", "Response chain is not tracked by this provider; start it through this provider or restore its state directory");
        if (!TERMINAL_STATUS.has(record.status)) {
          const recovered = await json("GET", new URL(upstreamURL.toString() + "/" + encodeURIComponent(previous)));
          if (!TERMINAL_STATUS.has(recovered.status) || !Array.isArray(recovered.output)) throw new HTTPError(409, "response_not_finished", "Previous response has not completed");
          record = { ...record, history: [...record.history, ...recovered.output], status: recovered.status };
          await store.put(namespace, "response", previous, record);
        }
        base = record.history; requests = record.requests;
      }

      const oldRequests = requests;
      let targetConversationId = alias?.upstreamId;
      let body = structuredClone(original);
      let full = { ...body, input: [...base, ...incoming] };
      delete full.previous_response_id; delete full.conversation;
      const requestLimit = policy.stateful.maxRequests;
      const forced = requestLimit !== undefined && requests + 1 > requestLimit;
      let compacted = null;
      if (forced || !within(full.input, "responses", policy)) {
        compacted = await compactSession(full, policy, {
          force: forced,
          nativePost: (payload) => json("POST", upstreamURL, payload, AbortSignal.any([requestSignal, AbortSignal.timeout(policy.responses?.timeoutMs ?? 25000)])),
          summaryPost: async (payload) => {
            const config = policy.summary, summaryHeaders = { "content-type": "application/json" };
            if (!config?.url || !config.model) throw new Error("missing summary configuration");
            if (config.apiKeyEnv) {
              const credential = process.env[config.apiKeyEnv];
              if (!credential) throw new Error("missing summary credential");
              summaryHeaders.authorization = `Bearer ${credential}`;
            }
            const result = await fetchImpl(config.url, { method: "POST", headers: summaryHeaders, body: JSON.stringify(payload), signal: AbortSignal.any([requestSignal, AbortSignal.timeout(config.timeoutMs ?? 25000)]), redirect: "error" });
            if (!result.ok) { await result.body?.cancel(); throw new Error("summary unavailable"); }
            return readJSON(result.body);
          },
        });
      }
      if (compacted) {
        full = compacted; requests = 0;
        if (conversationId) {
          const split = compacted.input.length - incoming.length;
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

      const pending = { history: full.input, requests: requests + 1, original: { previous_response_id: previous, conversation: conversationId }, upstreamId: targetConversationId };
      if (conversationId) {
        // Keep the old alias until inference succeeds. In pack/summary mode,
        // part of the compacted history can be embedded in the new input; an
        // unused shadow is not yet a complete replacement for the old one.
        alias = { ...alias, pending };
        await store.put(namespace, "conversation", conversationId, alias);
      }
      const response = await upstream("POST", upstreamURL, body);
      if (!response.ok) {
        if (conversationId) await store.put(namespace, "conversation", conversationId, { upstreamId: alias.upstreamId, requests: oldRequests });
        await copyBody(response, stream(response)); return;
      }
      let committed = false;
      let observedId;
      async function observe(reply) {
        if (reply.id === observedId || committed) return;
        observedId = reply.id;
        if (original.store !== false || conversationId) await store.put(namespace, "response", reply.id, { ...pending, status: "in_progress" });
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
            history: [...full.input, ...reply.output], requests: requests + 1, status: reply.status,
            original: { previous_response_id: previous, conversation: conversationId },
          });
        }
        if (conversationId) {
          const succeeded = ["completed", "incomplete"].includes(reply.status);
          await store.put(namespace, "conversation", conversationId, { upstreamId: succeeded ? targetConversationId : alias.upstreamId, requests: succeeded ? requests + 1 : oldRequests + 1 });
        }
        committed = true;
      }
      if (response.headers.get("content-type")?.includes("text/event-stream")) await relaySSE(response, stream(response), original, commit, observe);
      else {
        const reply = await readJSON(response.body);
        await commit(reply);
        deliver(jsonReply(response, clientReply(reply, original)));
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
