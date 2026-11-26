import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { policies } from "./core.js";

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

export function providerSettings(config, id) {
  const base = apiBase(config.baseURL);
  const models = config.models === undefined ? {} : modelMap(config.models);
  const { key: _key, apiKey: _apiKey, ...policyConfig } = config;
  const policy = { ...policyConfig, stateful: { enabled: true, url: new URL("responses", base).href, maxRequests: config.maxRequests, timeoutMs: config.timeoutMs } };
  const transportOptions = { providers: { [id]: policy } };
  if (!policies(transportOptions).length) throw new Error("maxMessages / maxTurns 至少启用一个，且必须是 1–100000 的整数；请检查压缩方式和保留轮数");
  if (config.maxRequests !== undefined && (!Number.isSafeInteger(config.maxRequests) || config.maxRequests < 2)) throw new Error("服务端会话最大请求数必须是至少 2 的整数，或设为 0 关闭");
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 100)) throw new Error("timeoutMs 必须是至少 100 的整数");
  const stateDir = resolve(config.stateDir ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "magpie-autocompact", id));
  return { baseURL: base.href.replace(/\/$/, ""), models, transportOptions, stateDir, config };
}

export function accountModels(settings, id) {
  return Object.fromEntries(Object.entries(settings.models).map(([key, m]) => [key, {
    id: key, providerID: id, name: m.name,
    api: { id: m.id ?? key, url: settings.baseURL, npm: "@ai-sdk/openai" },
    cost: m.cost ?? { input: 0, output: 0 }, limit: { context: 0, output: 0, ...m.limit },
    options: m.options ?? {}, headers: m.headers ?? {}, variants: m.variants ?? {},
    capabilities: { temperature: m.temperature ?? true, reasoning: m.reasoning ?? false, attachment: m.attachment ?? false, toolcall: m.tool_call,
      input: Object.fromEntries((m.modalities?.input ?? ["text"]).map((v) => [v, true])),
      output: Object.fromEntries((m.modalities?.output ?? ["text"]).map((v) => [v, true])) },
  }]));
}
