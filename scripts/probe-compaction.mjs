// Explicitly paid, isolated upstream capability probe. No plugin imports,
// gateway, fallback, user conversation history, or live configuration writes.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import * as http from "node:http";

if (!process.argv.includes("--live")) throw new Error("This makes paid API calls. Run with --live to opt in.");
const providerId = process.argv.find((arg) => arg.startsWith("--provider="))?.slice(11) ?? "xc";
const listing = spawnSync("magpie", ["plugin", "list", "--json"], { encoding: "utf8", timeout: 20000 });
let installed;
try { installed = JSON.parse(listing.stdout); } catch { throw new Error("Unable to read Magpie plugin configuration"); }
const config = installed.plugins?.find((p) => p.options?.providers?.[providerId])?.options.providers[providerId];
if (!config) throw new Error("Requested explicit provider is not configured");
const credential = config.key ?? config.apiKey;
if (!credential) throw new Error("This probe requires a configured provider credential");
const model = Array.isArray(config.models) ? config.models[0] : Object.values(config.models ?? {})[0]?.id ?? Object.keys(config.models ?? {})[0];
if (!model) throw new Error("No configured model to probe");
const base = new URL(config.baseURL.replace(/\/+$/, "") + "/");
if (base.username || base.password || base.search || base.hash) throw new Error("Expected a credential-free API root URL");

let restoreProxy = () => {};
const proxyEnv = { ...process.env };
// Environment keys retain their original casing in process.env spreads on
// Windows. Normalize before interpreting ALL_PROXY or passing them to Node.
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
  const entry = Object.entries(process.env).find(([name]) => name.toUpperCase() === key);
  if (entry) proxyEnv[key] = entry[1];
}
const explicitProxy = process.argv.find((arg) => arg.startsWith("--proxy="))?.slice(8);
if (explicitProxy !== undefined) {
  const url = new URL(explicitProxy);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("--proxy requires an HTTP(S) proxy URL");
  proxyEnv.HTTP_PROXY = proxyEnv.HTTPS_PROXY = url.href;
  // An explicit route must not be silently bypassed by inherited NO_PROXY.
  proxyEnv.NO_PROXY = "127.0.0.1,localhost";
} else if (proxyEnv.ALL_PROXY && /^https?:\/\//i.test(proxyEnv.ALL_PROXY)) {
  proxyEnv.HTTP_PROXY ||= proxyEnv.ALL_PROXY;
  proxyEnv.HTTPS_PROXY ||= proxyEnv.ALL_PROXY;
}
// Remove duplicate lowercase keys so Node cannot select an older value.
for (const key of Object.keys(proxyEnv)) {
  if (/^(https?_proxy|all_proxy|no_proxy)$/i.test(key) && key !== key.toUpperCase()) delete proxyEnv[key];
}
const selectedProxy = base.protocol === "https:" ? proxyEnv.HTTPS_PROXY : proxyEnv.HTTP_PROXY;
if (selectedProxy && typeof http.setGlobalProxyFromEnv !== "function") {
  throw new Error("Proxy configuration requires a Node version with http.setGlobalProxyFromEnv");
}
if (typeof http.setGlobalProxyFromEnv === "function") restoreProxy = http.setGlobalProxyFromEnv(proxyEnv);
const userAgent = "codex_cli_rs/0.172.0 (Windows; x86_64) WindowsTerminal";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportPath = resolve(".state", "probes", `compaction-${stamp}.json`);
const report = {
  startedAt: new Date().toISOString(), provider: providerId, baseURL: base.href, model,
  transport: `isolated fetch ${selectedProxy ? "with configured HTTP(S) proxy" : "without proxy"}; no Magpie gateway or plugin fallback`,
  userAgent, proxyConfigured: !!selectedProxy,
  proxySource: explicitProxy !== undefined ? "argument" : selectedProxy ? "environment" : "none",
  proxyEndpoint: selectedProxy ? (() => { const u = new URL(selectedProxy); return `${u.protocol}//${u.host}`; })() : undefined,
  references: ["https://developers.openai.com/api/docs/guides/compaction", "https://developers.openai.com/api/reference/python/resources/responses/methods/compact"],
  cases: [],
};
const clean = (value) => String(value ?? "").split(credential).join("[REDACTED]")
  .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]").replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]");
const outputText = (data) => (data?.output ?? []).filter((i) => i.type === "message")
  .flatMap((i) => i.content ?? []).filter((i) => i.type === "output_text").map((i) => i.text).join("");

function parseBody(text) {
  try { return { data: JSON.parse(text), eventTypes: [] }; } catch {}
  let data, error;
  const completedItems = new Map();
  const eventTypes = new Set();
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const raw = frame.split(/\r?\n/).filter((s) => s.startsWith("data:")).map((s) => s.slice(5).trimStart()).join("\n");
    if (!raw || raw === "[DONE]") continue;
    try {
      const event = JSON.parse(raw);
      if (event.type) eventTypes.add(event.type);
      if (event.type === "response.output_item.done" && event.item) completedItems.set(event.output_index ?? event.item.id ?? completedItems.size, event.item);
      if (event.response && ["response.completed", "response.failed", "response.incomplete"].includes(event.type)) data = event.response;
      if (event.error) error = event.error;
      if (event.type === "error") error = event.error ?? event;
    } catch {}
  }
  const terminalObserved = !!data;
  if (!data && completedItems.size) data = { output: [...completedItems.values()] };
  if (data && completedItems.size) {
    data.output ??= [];
    for (const item of completedItems.values()) {
      if (item.type === "compaction" && !data.output.some((i) => i.type === "compaction" && i.encrypted_content === item.encrypted_content)) data.output.push(item);
    }
  }
  return { data, error, eventTypes: [...eventTypes], terminalObserved };
}

function shape(items = []) {
  return items.map((i) => ({ type: i.type ?? "message", role: i.role,
    encryptedBytes: typeof i.encrypted_content === "string" ? Buffer.byteLength(i.encrypted_content) : undefined }));
}

async function call(name, route, fields, sessionId = randomUUID()) {
  if (report.cases.length >= 16) throw new Error("Probe request budget exhausted");
  const start = Date.now();
  const body = { model, ...fields };
  if (route === "responses") body.prompt_cache_key = sessionId;
  const row = { name, route, sessionId, request: { fields: Object.keys(body), stream: body.stream,
    inputCount: body.input?.length, input: shape(body.input), compactThreshold: body.context_management?.[0]?.compact_threshold } };
  report.cases.push(row);
  let data;
  try {
    const response = await fetch(new URL(route, base), {
      method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json",
        "user-agent": userAgent, originator: "codex_cli_rs", "session-id": sessionId, session_id: sessionId, "thread-id": sessionId },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60000), redirect: "error",
    });
    row.httpStatus = response.status;
    row.contentType = response.headers.get("content-type");
    row.diagnostics = Object.fromEntries(["x-request-id", "request-id", "retry-after", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests"]
      .map((k) => [k, response.headers.get(k)]).filter(([, v]) => v !== null));
    const text = await response.text();
    const parsed = parseBody(text);
    data = parsed.data;
    row.eventTypes = parsed.eventTypes;
    if (parsed.eventTypes.length) row.terminalObserved = parsed.terminalObserved;
    row.responseObject = data?.object;
    row.responseStatus = data?.status;
    row.output = shape(data?.output);
    row.text = clean(outputText(data)).slice(0, 500);
    row.usage = data?.usage;
    const error = data?.error ?? parsed.error;
    if (error) row.error = { type: error.type, code: error.code, param: error.param, message: clean(error.message).slice(0, 1500) };
    else if (!response.ok) row.error = { message: clean(text).slice(0, 1500) };
    row.hasEncryptedCompaction = !!data?.output?.some((i) => i.type === "compaction" && typeof i.encrypted_content === "string" && i.encrypted_content);
    row.ok = response.ok && !error && !!data && !["failed", "cancelled"].includes(data.status);
  } catch (error) {
    row.ok = false;
    row.networkError = { name: error.name, code: error.cause?.code, message: clean(error.message) };
  }
  row.elapsedMs = Date.now() - start;
  await save();
  console.log(JSON.stringify({ case: name, status: row.httpStatus, ms: row.elapsedMs, native: row.hasEncryptedCompaction,
    outputTypes: row.output?.map((i) => i.type), text: row.text, error: row.error ?? row.networkError }));
  return { row, data, sessionId };
}

async function save() {
  await mkdir(join(reportPath, ".."), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
}

const validated = new Set();
async function validate(result, family, marker) {
  if (!result.row.ok || !result.row.hasEncryptedCompaction || validated.has(family)) return;
  validated.add(family);
  // Reuse the entire compacted output, including any preserved user messages.
  const input = [...result.data.output, { role: "user", content: "Return only the exact recovery marker generated earlier in the assistant message. Do not generate a new marker." }];
  for (const fresh of [false, true]) {
    const next = await call(`${family}_resume_${fresh ? "new" : "same"}_session`, "responses", { input, stream: true, store: false, max_output_tokens:256 }, fresh ? randomUUID() : result.sessionId);
    next.row.markerRecovered = !!(next.row.ok && marker && outputText(next.data).includes(marker));
    next.row.compactionCase = result.row.name;
    await save();
  }
}

try {
  const seedInput = [{ role: "user", content: "Generate a unique uppercase recovery marker starting with PROBE_ and remember it for this conversation. Reply with only that marker." }];
  const seed = await call("baseline_stream", "responses", { input: seedInput, stream: true, store: false, include: ["reasoning.encrypted_content"], max_output_tokens:256 });
  if (!seed.row.ok || !seed.data?.output?.length) throw new Error("Baseline failed; compaction support cannot be isolated while ordinary inference is unavailable");
  const marker = "PROBE_" + randomUUID().replaceAll("-", "").toUpperCase();
  const prefix = [{ role: "user", content: "Generate a unique recovery marker for this conversation and remember it. Reply with only the marker." },
    { role: "assistant", content: marker }, { role: "user", content: "Remember that marker for the next step." }, { role: "assistant", content: "ACK" }];
  const controlInput = [...prefix, { role: "user", content: "Reply only ACK." }];
  await call("baseline_json", "responses", { input: controlInput, stream: false, store: false, max_output_tokens:128 });
  for (const stream of [false, true]) {
    const r = await call(`trigger_plain_${stream ? "stream" : "json"}`, "responses", { input: [...prefix, { type: "compaction_trigger" }], stream, store: false });
    await validate(r, "trigger", marker);
  }
  const compact = await call("compact_endpoint_plain", "responses/compact", { input: prefix });
  await validate(compact, "compact_endpoint", marker);
  if (!validated.has("trigger")) {
    const genuine = await call("trigger_real_output_same_session", "responses", { input: [...seedInput, ...seed.data.output, { type: "compaction_trigger" }], stream: true, store: false }, seed.sessionId);
    await validate(genuine, "trigger", outputText(seed.data).trim());
  }
  if (!validated.has("compact_endpoint")) {
    const genuine = await call("compact_endpoint_real_output", "responses/compact", { input: [...seedInput, ...seed.data.output] }, seed.sessionId);
    await validate(genuine, "compact_endpoint", outputText(seed.data).trim());
  }
  if (!validated.has("trigger")) {
    await call("invalid_item_negative_control", "responses", { input: [...prefix, { type: "__autocompact_invalid_type__" }], stream: false, store: false });
  }
  if (!validated.size && report.cases.length < 13) {
    const notes = "Diagnostic context record: preserve task goals, constraints, completed changes, and pending work.\n".repeat(160);
    const automatic = await call("automatic_context_management", "responses", { input: [{ role: "user", content: "Remember the recovery marker in the assistant's diagnostic notes." },
      { role: "assistant", content: notes + "\nRecovery marker: " + marker }, { role: "user", content: "Reply only ACK." }],
    context_management: [{ type: "compaction", compact_threshold:1024 }], stream: true, store: false, max_output_tokens:256 });
    await validate(automatic, "automatic", marker);
  }
  await call("baseline_after_tests", "responses", { input: [{ role: "user", content: "Reply only ACK." }], stream: true, store: false, max_output_tokens:128 });
} catch (error) {
  report.probeError = clean(error.message);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  report.summary = { totalRequests:report.cases.length,
    ordinaryInference:report.cases.filter((r) => r.name.startsWith("baseline")).map((r) => ({ name:r.name, status:r.httpStatus, ok:r.ok })),
    encryptedCompactionCases:report.cases.filter((r) => r.hasEncryptedCompaction).map((r) => r.name),
    verifiedResumes:report.cases.filter((r) => r.markerRecovered).map((r) => r.name) };
  await save();
  restoreProxy();
  console.log(JSON.stringify({ reportPath, summary:report.summary, error:report.probeError }));
}
