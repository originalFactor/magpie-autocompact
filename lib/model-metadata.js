const CATALOG_URL = "https://pi.dev/api/models";
const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const NATIVE_PROVIDERS = ["openai", "anthropic", "google", "deepseek", "xai", "mistral", "moonshotai", "minimax", "zai"];

// Share the public catalog across provider slots, including concurrent startup.
// Failed lookups are briefly cached so an offline catalog cannot stall every slot.
export function createCatalogLoader(fetcher = (...args) => fetch(...args)) {
  let pending, expires = 0;
  return () => {
    if (!pending || Date.now() >= expires) {
      expires = Infinity;
      pending = (async () => {
        try {
          const response = await fetcher(CATALOG_URL, { redirect: "error", signal: AbortSignal.timeout(4000) });
          if (!response.ok) throw new Error("catalog unavailable");
          const catalog = await response.json();
          if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) throw new Error("invalid catalog");
          expires = Date.now() + 3600000;
          return catalog;
        } catch {
          expires = Date.now() + 60000;
          return {};
        }
      })();
    }
    return pending;
  };
}

export const loadModelCatalog = createCatalogLoader();

function host(url) {
  try { return new URL(url).host; } catch { return undefined; }
}

function catalogModel(models, id) {
  if (!models || typeof models !== "object" || !Object.hasOwn(models, id)) return;
  const model = models[id];
  if (!model || typeof model !== "object" || Array.isArray(model) || (model.type && model.type !== "chat")) return;
  if (model.input !== undefined && (!Array.isArray(model.input) || model.input.some((kind) => typeof kind !== "string"))) return;
  return model;
}

function findModel(catalog, id, config) {
  const baseHost = host(config.baseURL);
  const slash = id.indexOf("/");
  const namespace = slash < 0 ? "" : id.slice(0, slash);
  if (Object.hasOwn(catalog, namespace)) {
    const entry = catalogModel(catalog[namespace], id.slice(slash + 1));
    if (entry) return entry;
  }
  const candidates = [];
  for (const [provider, models] of Object.entries(catalog)) {
    const model = catalogModel(models, id);
    if (!model) continue;
    const native = NATIVE_PROVIDERS.indexOf(provider);
    const score = baseHost && host(model.baseUrl) === baseHost ? -3 : provider === config.id ? -2
      : native >= 0 ? native : NATIVE_PROVIDERS.length;
    candidates.push({ model, provider, score });
  }
  candidates.sort((a, b) => a.score - b.score || a.provider.localeCompare(b.provider));
  return candidates[0]?.model;
}

export function enrichModels(models, config, catalog) {
  return Object.fromEntries(Object.entries(models).map(([id, model]) => {
    const source = findModel(catalog, id, config);
    if (!source) return [id, model];
    const variants = source.reasoning ? Object.fromEntries(LEVELS.filter((level) => {
      const mapped = source.thinkingLevelMap?.[level];
      return mapped !== null && (!["xhigh", "max"].includes(level) || mapped !== undefined);
    }).map((level) => [level, {}])) : {};
    return [id, { ...model, name: source.name ?? id, reasoning: source.reasoning === true,
      temperature: source.compat?.supportsTemperature ?? true,
      attachment: (source.input ?? []).some((kind) => kind !== "text"),
      modalities: { input: source.input ?? ["text"], output: ["text"] },
      cost: { input: source.cost?.input ?? 0, output: source.cost?.output ?? 0,
        cache: { read: source.cost?.cacheRead ?? 0, write: source.cost?.cacheWrite ?? 0 } },
      limit: { context: source.contextWindow ?? 0, output: source.maxTokens ?? 0 }, variants }];
  }));
}
