import assert from "node:assert/strict";
import { test } from "node:test";
import { createCatalogLoader, enrichModels } from "../lib/model-metadata.js";
import { modelMap, PROTOCOLS } from "../lib/provider-config.js";
import plugin from "../autocompact.provider.js";

const source = { id: "reasoner", name: "Reasoner", api: "openai-responses", provider: "openai",
  baseUrl: "https://api.openai.com/v1", reasoning: true, input: ["text", "image"],
  contextWindow: 200000, maxTokens: 32000,
  cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 1 },
  thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: null },
  compat: { supportsTemperature: false } };
const catalog = { openai: { reasoner: source }, reseller: { reasoner: { ...source, name: "Resold", baseUrl: "https://relay.example/v1" } } };

test("Pi metadata follows supported thinking levels and preserves upstream model identity", () => {
  const models = enrichModels(modelMap(["reasoner", "openai/reasoner", "unknown"]), { id: "custom", baseURL: "https://custom.example/v1" }, catalog);
  const m = models.reasoner;
  assert.equal(m.name, "Reasoner");
  assert.deepEqual(Object.keys(m.variants), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(m.limit, { context: 200000, output: 32000 });
  assert.deepEqual(m.cost, { input: 2, output: 8, cache: { read: 0.5, write: 1 } });
  assert.deepEqual(m.modalities, { input: ["text", "image"], output: ["text"] });
  assert.equal(m.attachment, true); assert.equal(m.temperature, false); assert.equal(m.tool_call, true);
  assert.equal(m.id, undefined); assert.equal(m.headers, undefined); assert.equal(m.options, undefined);
  assert.equal(models["openai/reasoner"].name, "Reasoner");
  assert.deepEqual(models.unknown, { name: "unknown", tool_call: true });
  assert.equal(enrichModels(modelMap(["reasoner"]), { baseURL: "https://relay.example/v1" }, catalog).reasoner.name, "Resold");
  assert.equal(enrichModels(modelMap(["reasoner"]), { id: "reseller" }, catalog).reasoner.name, "Resold");
});

test("Pi default levels, explicit maximum, nonreasoning and nonchat entries", () => {
  const convert = (extra) => enrichModels(modelMap(["reasoner"]), {}, { openai: { reasoner: { ...source, ...extra } } }).reasoner;
  assert.deepEqual(Object.keys(convert({ thinkingLevelMap: undefined }).variants), ["minimal", "low", "medium", "high"]);
  assert.deepEqual(Object.keys(convert({ thinkingLevelMap: { minimal: null, low: null, medium: null, max: "max" } }).variants), ["high", "max"]);
  assert.deepEqual(convert({ reasoning: false }).variants, {});
  assert.deepEqual(convert({ type: "image" }), { name: "reasoner", tool_call: true });
  for (const input of ["text", {}, [null]]) {
    assert.deepEqual(convert({ input }), { name: "reasoner", tool_call: true });
  }
  assert.deepEqual(enrichModels(modelMap(["toString"]), {}, { openai: {} }), modelMap(["toString"]));
});

test("catalog requests are shared, bounded and contain no provider credentials", async () => {
  let calls = 0;
  const load = createCatalogLoader(async (url, init) => {
    calls++;
    assert.equal(url, "https://pi.dev/api/models");
    assert.equal(init.headers, undefined); assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json(catalog);
  });
  const [a, b] = await Promise.all([load(), load()]);
  assert.deepEqual(a, catalog); assert.equal(a, b);
  await load(); assert.equal(calls, 1);
});

test("catalog failures degrade to defaults and retry after the short failure cache expires", async (t) => {
  const originalNow = Date.now;
  let now = originalNow(), calls = 0;
  t.after(() => { Date.now = originalNow; });
  Date.now = () => now;
  const load = createCatalogLoader(async () => {
    if (++calls === 1) throw new Error("unavailable");
    return Response.json(catalog);
  });
  assert.deepEqual(await load(), {}); assert.deepEqual(await load(), {}); assert.equal(calls, 1);
  now += 60001;
  assert.deepEqual(await load(), catalog); assert.equal(calls, 2);
  now += 3600001;
  await load(); assert.equal(calls, 3);
  for (const response of [new Response("secret", { status: 503 }), new Response("invalid JSON"), Response.json([]), Response.json(null)]) {
    assert.deepEqual(await createCatalogLoader(async () => response)(), {});
  }
});

test("array and discovered models expose the same native metadata while object configuration stays explicit", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let publicCalls = 0, upstreamCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url) === "https://pi.dev/api/models") {
      publicCalls++; assert.equal(init.headers, undefined); return Response.json(catalog);
    }
    upstreamCalls++; assert.equal(init.headers.get("authorization") ?? init.headers.get("x-api-key"), init.headers.has("authorization") ? "Bearer provider-key" : "provider-key");
    return Response.json({ data: [{ id: "reasoner" }, { id: "unknown" }] });
  };
  const client = { client: { auth: { set: async () => {} } } };
  for (const protocol of Object.keys(PROTOCOLS)) for (const models of [["reasoner", "unknown"], undefined]) {
    const hooks = await plugin.server(client, { providers: { custom: { baseURL: "https://custom.example/v1", key: "provider-key", models, protocol } } });
    // Models hooks also work before the host's config hook has been called.
    const exposed = await hooks.provider.models({ models: {} });
    assert.equal(exposed.reasoner.api.id, "reasoner"); assert.equal(exposed.reasoner.api.url, "https://custom.example/v1");
    assert.equal(exposed.reasoner.api.npm, PROTOCOLS[protocol].npm);
    assert.equal(exposed.reasoner.capabilities.temperature, false);
    assert.equal(exposed.reasoner.capabilities.input.image, true);
    assert.deepEqual(exposed.reasoner.cost.cache, { read: 0.5, write: 1 });
    assert.deepEqual(Object.keys(exposed.reasoner.variants), ["low", "medium", "high", "xhigh"]);
    assert.equal(exposed.unknown.capabilities.reasoning, false);
    const cfg = {}; await hooks.config(cfg);
    assert.equal(cfg.provider.custom.models.reasoner.reasoning, true);
  }
  const explicit = { alias: { id: "reasoner", name: "Manual", reasoning: false, variants: { custom: {} } } };
  const hooks = await plugin.server(client, { providers: { custom: { baseURL: "https://custom.example/v1", key: "provider-key", models: explicit } } });
  const cfg = {}; await hooks.config(cfg);
  assert.equal(cfg.provider.custom.models.alias.name, "Manual");
  assert.equal(cfg.provider.custom.models.alias.reasoning, false);
  const given = { alias: { sentinel: true } };
  assert.equal(await hooks.provider.models({ models: given }), given);
  assert.equal(publicCalls, 1); assert.equal(upstreamCalls, 3);
});
