import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { policies } from "./core.js";

export const PROTOCOLS = {
  responses: { path: "responses", npm: "@ai-sdk/openai" },
  chat: { path: "chat/completions", npm: "@ai-sdk/openai-compatible" },
  anthropic: { path: "messages", npm: "@ai-sdk/anthropic" },
};

export function protocolOf(config) {
  const protocol = config.protocol ?? "responses";
  if (!Object.hasOwn(PROTOCOLS, protocol)) throw new Error("protocol 必须是 responses、chat 或 anthropic");
  return protocol;
}

export function accountHeaders(source, key, protocol) {
  const headers = new Headers(source);
  headers.delete("authorization"); headers.delete("x-api-key"); headers.delete("api-key");
  if (protocol === "anthropic") {
    headers.set("x-api-key", key);
    if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  } else headers.set("authorization", `Bearer ${key}`);
  return headers;
}

export function apiBase(value) {
  let base;
  try { base = new URL(value); } catch { throw new Error("Base URL 必须是完整的 HTTP(S) API 根地址"); }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("Base URL 不能含凭据、查询参数或片段");
  if (/\/(responses|chat\/completions|messages)\/?$/.test(base.pathname)) throw new Error("请填写 API 根地址（例如 /v1），不要包含 /responses、/chat/completions 或 /messages");
  base.pathname = base.pathname.replace(/\/+$/, "") + "/";
  return base;
}

export function modelMap(value) {
  const entries = Array.isArray(value) ? value.map((id) => [id, { name: id }]) : Object.entries(value ?? {});
  if (!entries.length || entries.some(([id, model]) => typeof id !== "string" || !id.trim() || !model || typeof model !== "object" || Array.isArray(model))) throw new Error("请至少填写一个模型 ID，或从上游获取模型");
  return Object.fromEntries(entries.map(([id, model]) => [id, { name: id, tool_call: true, ...model }]));
}

export function validateSummary(summary) {
  if (summary === undefined) return;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) throw new Error("summary 必须是对象");
  if (Object.hasOwn(summary, "url") || Object.hasOwn(summary, "apiKeyEnv")) throw new Error("summary.url / summary.apiKeyEnv 已移除，请用 summary.provider 引用 providers 中的供应商 ID");
  if (summary.provider !== undefined && (typeof summary.provider !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(summary.provider))) throw new Error("summary.provider 必须是有效的供应商 ID");
  for (const field of ["model", "prompt"]) if (summary[field] !== undefined && (typeof summary[field] !== "string" || !summary[field].trim())) throw new Error(`summary.${field} 必须是非空字符串`);
  for (const [field, min] of [["timeoutMs", 100], ["maxTokens", 1], ["maxInputChars", 1]])
    if (summary[field] !== undefined && (!Number.isSafeInteger(summary[field]) || (summary[field] !== 0 && summary[field] < min))) throw new Error(`summary.${field} 必须是 0（不限）或至少 ${min} 的整数`);
}

export function providerCredential(config, id) {
  for (const field of ["key", "apiKey"]) if (config[field] !== undefined && (typeof config[field] !== "string" || !config[field].trim())) throw new Error(`${id}.${field} 必须是非空字符串`);
  if (config.key === undefined && config.apiKey === undefined) throw new Error(`${id}: 请在 providers 中配置 key 或 apiKey；登录入口已移除`);
  if (config.key !== undefined && config.apiKey !== undefined && config.key !== config.apiKey) throw new Error(`${id}: key 与 apiKey 不一致`);
  return (config.key ?? config.apiKey).trim();
}

export function resolveSummaryProvider(summary, currentId, providers = {}) {
  validateSummary(summary);
  const id = summary?.provider;
  // An explicit self-reference uses the current request's protocol and model.
  if (id === undefined || id === currentId) return null;
  const config = Object.hasOwn(providers, id) ? providers[id] : null;
  if (!config || typeof config !== "object" || Array.isArray(config) || config.enabled === false) throw new Error(`summary.provider ${id} 不存在或已禁用`);
  const settings = providerSettings(config, id), key = providerCredential(config, id);
  const selected = summary.model ?? Object.keys(settings.models)[0];
  const selectedModel = settings.models[selected] ?? Object.values(settings.models).find((entry) => entry.id === selected);
  const model = selectedModel?.id ?? selected;
  if (typeof model !== "string" || !model.trim()) throw new Error(`summary.provider ${id} 未配置模型列表，请显式填写 summary.model`);
  return { id, url: new URL(PROTOCOLS[settings.protocol].path, apiBase(config.baseURL)).href,
    protocol: settings.protocol, model, key,
    headers: { ...(selectedModel?.headers ?? {}), ...(config.headers ?? {}) }, timeoutMs: config.timeoutMs };
}

export function providerSettings(config, id) {
  validateSummary(config.summary);
  if (config.diagnostics !== undefined && typeof config.diagnostics !== "boolean") throw new Error("diagnostics must be a boolean");
  if (config.maxRetainedMessages !== undefined) throw new Error("maxRetainedMessages 已移除，请使用 maxRetainedRatio");
  if (config.maxRetainedRatio !== undefined && (typeof config.maxRetainedRatio !== "number" || !Number.isFinite(config.maxRetainedRatio) || config.maxRetainedRatio <= 0 || config.maxRetainedRatio > 1)) throw new Error("maxRetainedRatio 必须大于 0 且不大于 1");
  if (config.compactionTargetRatio !== undefined && (typeof config.compactionTargetRatio !== "number" || !Number.isFinite(config.compactionTargetRatio)
    || config.compactionTargetRatio <= 0 || config.compactionTargetRatio > 1)) throw new Error("compactionTargetRatio 必须大于 0 且不大于 1");
  if (config.compactionNotice !== undefined && typeof config.compactionNotice !== "boolean") throw new Error("compactionNotice must be a boolean");
  if (config.enablePack !== undefined && typeof config.enablePack !== "boolean") throw new Error("enablePack 必须是布尔值");
  if (config.enableAlphaSearch !== undefined && typeof config.enableAlphaSearch !== "boolean") throw new Error("enableAlphaSearch 必须是布尔值");
  const base = apiBase(config.baseURL);
  const protocol = protocolOf(config), { path, npm } = PROTOCOLS[protocol];
  if (config.enableAlphaSearch === true && protocol !== "responses") throw new Error("enableAlphaSearch 仅支持 responses 上游");
  const models = config.models === undefined ? {} : modelMap(config.models);
  const { key: _key, apiKey: _apiKey, mode: _mode, maxTurns: _maxTurns, keepTurns: _keepTurns, ...policyConfig } = config;
  const policy = { ...policyConfig, protocol, maxMessages: config.maxMessages || undefined, enablePack: config.enablePack ?? true,
    stateful: { enabled: true, url: new URL(path, base).href, maxRequests: config.maxRequests || undefined, timeoutMs: config.timeoutMs } };
  const transportOptions = { providers: { [id]: policy } };
  if (config.maxMessages !== undefined && (!Number.isSafeInteger(config.maxMessages) || config.maxMessages < 0 || config.maxMessages > 100000)) throw new Error("maxMessages 必须是 0–100000 的整数；不填或 0 表示不压缩");
  if (!policies(transportOptions).length) throw new Error("enablePack 必须是布尔值，请检查压缩配置");
  if (config.maxRequests !== undefined && (!Number.isSafeInteger(config.maxRequests) || config.maxRequests < 0 || config.maxRequests > 100000)) throw new Error("maxRequests 必须是 0–100000 的整数；不填或 0 表示不更换 session ID");
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || (config.timeoutMs !== 0 && config.timeoutMs < 100))) throw new Error("timeoutMs 必须是 0（不限）或至少 100 的整数");
  const stateDir = resolve(config.stateDir ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "magpie-autocompact", id));
  return { baseURL: base.href.replace(/\/$/, ""), models, transportOptions, stateDir,
    config: { ...policyConfig, ...(_key === undefined ? {} : { key: _key }), ...(_apiKey === undefined ? {} : { apiKey: _apiKey }) }, protocol, npm };
}

export function accountModels(settings, id) {
  return Object.fromEntries(Object.entries(settings.models).map(([key, m]) => [key, {
    id: key, providerID: id, name: m.name,
    api: { id: m.id ?? key, url: settings.baseURL, npm: settings.npm ?? "@ai-sdk/openai" },
    cost: m.cost ?? { input: 0, output: 0 }, limit: { context: 0, output: 0, ...m.limit },
    options: m.options ?? {}, headers: m.headers ?? {}, variants: m.variants ?? {},
    capabilities: { temperature: m.temperature ?? true, reasoning: m.reasoning ?? false, attachment: m.attachment ?? false, toolcall: m.tool_call,
      input: Object.fromEntries((m.modalities?.input ?? ["text"]).map((v) => [v, true])),
      output: Object.fromEntries((m.modalities?.output ?? ["text"]).map((v) => [v, true])) },
  }]));
}
