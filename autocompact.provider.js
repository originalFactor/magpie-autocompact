import { providerSettings, accountModels } from "./lib/provider-config.js";
import { providerForm } from "./lib/provider-form.js";
import { createSessionTransport } from "./lib/session-transport.js";

// Magpie treats every exported function as a separate plugin.
export default {
  id: "magpie-autocompact",
  async server(_input, options = {}) {
    const config = options.provider;
    if (config?.enabled === false) return {};
    const id = config?.id ?? "autocompact";
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error("provider.id must contain lowercase letters, digits, _ or -");
    const configured = config ? providerSettings(config, id) : null;
    const settingsFor = (auth) => configured ?? (auth?.metadata?.autocompact ? providerSettings(auth.metadata.autocompact, id) : null);
    return {
      async config(cfg) {
        cfg.provider ??= {};
        cfg.provider[id] = { name: config?.name ?? "自动压缩 · 自定义供应商", npm: "@ai-sdk/openai", api: configured?.baseURL ?? "", models: configured?.models ?? {} };
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
              const auth = await getAuth();
              if (auth?.type !== "api" || !auth.key) return Response.json({ error: { message: "Sign in to the compaction provider first" } }, { status: 401 });
              const settings = settingsFor(auth);
              if (!settings) return Response.json({ error: { message: "请重新登录自动压缩供应商以填写上游设置" } }, { status: 401 });
              const signature = JSON.stringify(settings.config);
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
      provider: { id, async models(provider, { auth } = {}) {
        if (configured) return provider.models;
        const settings = settingsFor(auth);
        return settings ? accountModels(settings, id) : {};
      } },
    };
  },
};
