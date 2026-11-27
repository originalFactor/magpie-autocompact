import { providerSettings, accountModels, modelMap, apiBase, protocolOf, accountHeaders, providerCredential, resolveSummaryProvider } from "./provider-config.js";
import { createSessionTransport } from "./session-transport.js";

// Magpie requires one module export per auth/provider hook pair.
export const MAX_PROVIDERS = 64;

export function configurations(options) {
  if (Object.hasOwn(options, "provider")) throw new Error("顶层 provider 配置已移除，请迁移到 providers: { \"供应商 ID\": { ... } }");
  if (options.providers !== undefined) {
    if (!options.providers || typeof options.providers !== "object" || Array.isArray(options.providers)) throw new Error("providers 必须是以供应商 ID 为键的对象");
    const entries = Object.entries(options.providers);
    if (entries.length > MAX_PROVIDERS) throw new Error(`最多支持 ${MAX_PROVIDERS} 个显式供应商`);
    return entries.map(([id, config]) => {
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("每个 provider 必须是配置对象");
      if (config.id !== undefined && config.id !== id) throw new Error("provider.id 必须与 providers 中的键一致");
      return { ...config, id };
    });
  }
  return [];
}

function validate(config) {
  if (config.enabled === false) return;
  const id = config.id;
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error("provider.id must contain lowercase letters, digits, _ or -");
  providerSettings(config, id);
  providerCredential(config, id);
}

export async function providerSlot(slot, input, options = {}) {
  const configs = configurations(options);
  // Validate the whole file before any credential writes or registration.
  configs.forEach(validate);
  const summaryProviders = Object.fromEntries(configs.map((config) => [config.id, config]));
  for (const config of configs) if (config.enabled !== false) resolveSummaryProvider(config.summary, config.id, summaryProviders);
  if (slot >= configs.length) return {};
  const config = configs[slot];
  if (config.enabled === false) return {};
  const id = config.id;
  const configured = providerSettings(config, id);
  const credential = providerCredential(config, id);
  const discovered = new Map();
  const discover = (signal) => {
    if (!discovered.has(credential)) {
      const pending = fetchModels(config, credential, signal);
      discovered.set(credential, pending);
      pending.catch(() => { if (discovered.get(credential) === pending) discovered.delete(credential); });
    }
    return discovered.get(credential);
  };
  return {
    async config(cfg) {
      if (typeof input?.client?.auth?.set !== "function") throw new Error("Magpie client.auth.set is required for configured keys");
      await input.client.auth.set({ path: { id }, body: { type: "api", key: credential } });
      cfg.provider ??= {};
      cfg.provider[id] = { name: config.name ?? id, npm: configured.npm, api: configured.baseURL, models: configured.models,
        searches: config.enableAlphaSearch === true };
      if (config.models === undefined) {
        const models = await discover();
        if (models) cfg.provider[id].models = models;
      }
    },
    auth: {
      provider: id,
      methods: [],
      async loader() {
        // A single lazy transport belongs to this configured provider. Stored
        // account metadata never overrides its endpoint, policy or credential.
        let transport;
        return {
          baseURL: configured.baseURL,
          async fetch(input, init) {
            const settings = configured;
            const request = new Request(input, init);
            // Do not forward account credentials to a stale or overridden URL.
            const target = new URL(request.url), base = new URL(settings.baseURL + "/");
            if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) return Response.json({ error: { message: "请求地址与当前账号的 Base URL 不匹配，请刷新供应商模型" } }, { status: 400 });
            let headers = new Headers(request.headers);
            for (const [key, value] of Object.entries(settings.config.headers ?? {})) headers.set(key, value);
            headers = accountHeaders(headers, credential, settings.protocol);
            if (!transport) {
              transport = createSessionTransport(settings.transportOptions, { stateDir: settings.stateDir, summaryProviders });
              transport.catch(() => { transport = undefined; });
            }
            return (await transport).fetch(id, new Request(request, { headers }));
          },
        };
      },
    },
    provider: { id, async models(provider, { signal } = {}) {
      if (config.models !== undefined) return provider.models;
      const models = await discover(signal);
      return accountModels({ ...configured, models }, id);
    } },
  };
}

// A bounded startup request; failures leave registration intact and can be
// retried by Magpie's model refresh. Never include upstream bodies or keys in errors.
async function fetchModels(config, key, signal) {
  const timeout = AbortSignal.timeout(8000);
  const headers = accountHeaders(config.headers ?? {}, key, protocolOf(config));
  let response;
  try {
    response = await fetch(new URL("models", apiBase(config.baseURL)), {
      headers, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    throw new Error(`${config.id}: 获取 /models 失败，请检查上游连接或手动配置 models`);
  }
  if (!response.ok) throw new Error(`${config.id}: 获取 /models 失败（HTTP ${response.status}）`);
  try {
    const body = await response.json();
    const ids = [...new Set((Array.isArray(body.data) ? body.data : []).map((m) => m?.id).filter((v) => typeof v === "string" && v.trim()))];
    return modelMap(ids);
  } catch {
    throw new Error(`${config.id}: /models 未返回有效模型列表，请手动配置 models`);
  }
}
