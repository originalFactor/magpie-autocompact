import { providerSettings, accountModels, modelMap, apiBase } from "./provider-config.js";
import { providerForm } from "./provider-form.js";
import { createSessionTransport } from "./session-transport.js";

// Magpie requires one module export per auth/provider hook pair.
export const MAX_PROVIDERS = 64;

export function configurations(options) {
  if (options.providers !== undefined) {
    if (options.provider != null) throw new Error("provider 与 providers 不能同时配置");
    if (!options.providers || typeof options.providers !== "object" || Array.isArray(options.providers)) throw new Error("providers 必须是以供应商 ID 为键的对象");
    const entries = Object.entries(options.providers);
    if (entries.length > MAX_PROVIDERS) throw new Error(`最多支持 ${MAX_PROVIDERS} 个显式供应商`);
    return entries.map(([id, config]) => {
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("每个 provider 必须是配置对象");
      if (config.id !== undefined && config.id !== id) throw new Error("provider.id 必须与 providers 中的键一致");
      return { ...config, id };
    });
  }
  return [options.provider ?? null];
}

function validate(config) {
  if (config?.enabled === false) return;
  const id = config?.id ?? "autocompact";
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error("provider.id must contain lowercase letters, digits, _ or -");
  if (config) {
    providerSettings(config, id);
    for (const field of ["key", "apiKey"]) if (config[field] !== undefined && (typeof config[field] !== "string" || !config[field].trim())) throw new Error(`${id}.${field} 必须是非空字符串`);
    if (config.key !== undefined && config.apiKey !== undefined && config.key !== config.apiKey) throw new Error(`${id}: key 与 apiKey 不一致`);
  }
}

export async function providerSlot(slot, input, options = {}) {
  const configs = configurations(options);
  // Validate the whole file before any credential writes or registration.
  configs.forEach(validate);
  if (slot >= configs.length) return {};
  const config = configs[slot];
  if (config?.enabled === false) return {};
  const id = config?.id ?? "autocompact";
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error("provider.id must contain lowercase letters, digits, _ or -");
  const configured = config ? providerSettings(config, id) : null;
  const discovered = new Map();
  const discover = (auth, signal) => {
    const key = config?.key ?? config?.apiKey ?? (auth?.type === "api" ? auth.key : undefined);
    if (!key?.trim()) return Promise.resolve(null);
    const credential = key.trim();
    if (!discovered.has(credential)) {
      const pending = fetchModels(config, credential, signal);
      discovered.set(credential, pending);
      pending.catch(() => { if (discovered.get(credential) === pending) discovered.delete(credential); });
    }
    return discovered.get(credential);
  };
  const settingsFor = (auth) => configured ?? (auth?.metadata?.autocompact ? providerSettings(auth.metadata.autocompact, id) : null);
  return {
    async config(cfg) {
      const key = config?.key ?? config?.apiKey;
      if (key !== undefined) {
        if (typeof input?.client?.auth?.set !== "function") throw new Error("Magpie client.auth.set is required for configured keys");
        await input.client.auth.set({ path: { id }, body: { type: "api", key: key.trim() } });
      }
      cfg.provider ??= {};
      cfg.provider[id] = { name: config?.name ?? "自动压缩 · 自定义供应商", npm: "@ai-sdk/openai", api: configured?.baseURL ?? "", models: configured?.models ?? {} };
      if (configured && config.models === undefined) {
        const models = await discover();
        if (models) cfg.provider[id].models = models;
      }
    },
    auth: {
      provider: id,
      methods: configured ? [{ type: "api", label: "上游 API Key", placeholder: "sk-…" }] : [providerForm(id)],
      async loader(getAuth) {
        const initial = settingsFor(await getAuth());
        // Per-account engine: endpoints, policies and credentials stay paired.
        // Lazy creation keeps listing/login free of filesystem operations.
        const transports = new Map();
        return {
          baseURL: initial?.baseURL ?? "",
          async fetch(input, init) {
            const auth = config?.key !== undefined || config?.apiKey !== undefined
              ? { type: "api", key: (config.key ?? config.apiKey).trim() }
              : await getAuth();
            if (auth?.type !== "api" || !auth.key) return Response.json({ error: { message: "Sign in to the compaction provider first" } }, { status: 401 });
            const settings = settingsFor(auth);
            if (!settings) return Response.json({ error: { message: "请重新登录自动压缩供应商以填写上游设置" } }, { status: 401 });
            const { key: _key, apiKey: _apiKey, ...nonsecret } = settings.config;
            const signature = JSON.stringify(nonsecret);
            const request = new Request(input, init);
            // Do not forward account credentials to a stale or overridden URL.
            const target = new URL(request.url), base = new URL(settings.baseURL + "/");
            if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) return Response.json({ error: { message: "请求地址与当前账号的 Base URL 不匹配，请刷新供应商模型" } }, { status: 400 });
            const headers = new Headers(request.headers);
            for (const [key, value] of Object.entries(settings.config.headers ?? {})) headers.set(key, value);
            headers.set("authorization", `Bearer ${auth.key}`);
            if (!transports.has(signature)) {
              const pending = createSessionTransport(settings.transportOptions, { stateDir: settings.stateDir });
              transports.set(signature, pending);
              pending.catch(() => { if (transports.get(signature) === pending) transports.delete(signature); });
            }
            const transport = transports.get(signature);
            return (await transport).fetch(id, new Request(request, { headers }));
          },
        };
      },
    },
    provider: { id, async models(provider, { auth, signal } = {}) {
      if (configured) {
        if (config.models !== undefined) return provider.models;
        const models = await discover(auth, signal);
        return models ? accountModels({ ...configured, models }, id) : provider.models;
      }
      const settings = settingsFor(auth);
      return settings ? accountModels(settings, id) : {};
    } },
  };
}

// A bounded startup request; failures leave registration intact and can be
// retried by Magpie's model refresh. Never include upstream bodies or keys in errors.
async function fetchModels(config, key, signal) {
  const timeout = AbortSignal.timeout(8000);
  const headers = new Headers(config.headers ?? {});
  headers.set("authorization", `Bearer ${key}`);
  let response;
  try {
    response = await fetch(new URL("models", apiBase(config.baseURL)), {
      headers, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    throw new Error(`${config.id ?? "autocompact"}: 获取 /models 失败，请检查上游连接或手动配置 models`);
  }
  if (!response.ok) throw new Error(`${config.id ?? "autocompact"}: 获取 /models 失败（HTTP ${response.status}）`);
  try {
    const body = await response.json();
    const ids = [...new Set((Array.isArray(body.data) ? body.data : []).map((m) => m?.id).filter((v) => typeof v === "string" && v.trim()))];
    return modelMap(ids);
  } catch {
    throw new Error(`${config.id ?? "autocompact"}: /models 未返回有效模型列表，请手动配置 models`);
  }
}
