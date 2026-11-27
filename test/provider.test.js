import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import plugin, { Provider02 } from "../autocompact.provider.js";
import { apiBase, providerSettings, accountHeaders } from "../lib/provider-config.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inputs = { baseURL: "https://a.example/v1/" };
const client = { client: { auth: { set: async () => {} } } };
const networkFetch = globalThis.fetch;
before(() => { globalThis.fetch = async (url, init) => String(url) === "https://pi.dev/api/models" ? Response.json({}) : networkFetch(url, init); });
after(() => { globalThis.fetch = networkFetch; });

test("unconfigured installation registers no providers or login entry", async () => {
  for (const options of [undefined, {}, { providers: {} }]) {
    assert.deepEqual(await plugin.server({}, options), {});
    assert.deepEqual(await Provider02({}, options), {});
  }
  assert.deepEqual(await plugin.server({}, { providers: { disabled: { enabled: false } } }), {});
});

test("removed top-level provider explicitly requires migration before writes", async () => {
  let writes = 0;
  for (const provider of [null, undefined, {}, { enabled: false }, { baseURL: inputs.baseURL, key: "key" }]) {
    await assert.rejects(plugin.server({ client: { auth: { set: () => writes++ } } }, { provider }), /provider.*已移除.*providers/);
  }
  assert.equal(writes, 0);
});

test("configured providers expose no login methods and ignore old account form metadata", async () => {
  const hooks = await plugin.server(client, { providers: { configured: {
    baseURL: inputs.baseURL, key: "configured-key", models: ["model-a"],
  } } });
  assert.equal(hooks.auth.provider, "configured"); assert.deepEqual(hooks.auth.methods, []);
  const cfg = {}; await hooks.config(cfg);
  assert.equal(cfg.provider.configured.name, "configured");
  assert.equal(cfg.provider.configured.models["model-a"].tool_call, true);
  const loader = await hooks.auth.loader(() => { throw new Error("Stored login must not be consulted"); });
  assert.equal(loader.baseURL, "https://a.example/v1");
  const models = await hooks.provider.models({ models: cfg.provider.configured.models }, { auth: {
    key: "stale-key", metadata: { autocompact: { baseURL: "https://stale.example/v1", models: ["stale-model"] } },
  } });
  assert.deepEqual(Object.keys(models), ["model-a"]);
  assert.equal((await loader.fetch("https://stale.example/v1/responses")).status, 400);
  assert.equal((await loader.fetch("https://a.example/v1evil/responses")).status, 400);
});

test("non-Responses providers select native SDKs without login or retired compression modes", async () => {
  for (const [protocol, npm, path] of [["chat", "@ai-sdk/openai-compatible", "chat/completions"], ["anthropic", "@ai-sdk/anthropic", "messages"]]) {
    const config = { protocol, baseURL: inputs.baseURL, key: "configured-key", models: ["test"], maxMessages: 80, mode: "responses" };
    const settings = providerSettings(config, "test");
    assert.equal(settings.npm, npm); assert.equal(settings.transportOptions.providers.test.mode, undefined);
    assert.equal(settings.transportOptions.providers.test.stateful.url, "https://a.example/v1/" + path);
    const hooks = await plugin.server(client, { providers: { test: config } });
    const cfg = {}; await hooks.config(cfg); assert.equal(cfg.provider.test.npm, npm);
    assert.deepEqual(hooks.auth.methods, []);
    const model = await hooks.provider.models({ models: settings.models });
    assert.equal(model.test.name, "test");
  }
  assert.throws(() => providerSettings({ protocol: "invalid", baseURL: inputs.baseURL }, "test"), /protocol/);
});

test("configuration validates thresholds, URLs and protocol before registration", async () => {
  const base = { baseURL: inputs.baseURL, key: "configured-key", models: ["test"] };
  for (const change of [
    { baseURL: "file:///tmp/test" }, { baseURL: "https://user:pass@example.com/v1" },
    { baseURL: "https://example.com/v1/responses" }, { maxMessages: -1 }, { maxMessages: 2.5 },
    { maxRequests: -1 }, { maxRequests: 2.5 }, { enablePack: "false" }, { protocol: "invalid" },
    ...["", "  ", null, 1, {}, []].map((compactionNotice) => ({ compactionNotice })),
  ]) await assert.rejects(plugin.server(client, { providers: { test: { ...base, ...change } } }));
  assert.equal(apiBase("https://example.com/v1///").href, "https://example.com/v1/");
});

test("Anthropic discovery uses configured x-api-key and version without stale bearer auth", async (t) => {
  const headers = accountHeaders({ authorization: "Bearer stale-key", "x-api-key": "stale-key" }, "real-key", "anthropic");
  assert.equal(headers.get("authorization"), null); assert.equal(headers.get("x-api-key"), "real-key");
  assert.equal(headers.get("anthropic-version"), "2023-06-01");
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://a.example/v1/models");
    assert.equal(init.headers.get("authorization"), null); assert.equal(init.headers.get("x-api-key"), "configured-key");
    assert.equal(init.headers.get("anthropic-version"), "2023-06-01");
    return Response.json({ data: [{ id: "claude-test" }] });
  };
  const hooks = await plugin.server(client, { providers: { anthropic: { baseURL: inputs.baseURL, key: "configured-key", protocol: "anthropic" } } });
  const cfg = {}; await hooks.config(cfg);
  assert.deepEqual(Object.keys(cfg.provider.anthropic.models), ["claude-test"]);
  const models = await hooks.provider.models({ models: {} });
  assert.equal(models["claude-test"].api.npm, "@ai-sdk/anthropic");
});

test("multiple explicit providers register independent native hooks and configured credentials", async () => {
  const { Provider02, Provider03 } = await import("../autocompact.provider.js");
  const saved = [], input = { client: { auth: { set: async (v) => saved.push(v) } } };
  const options = { providers: {
    first: { baseURL: "https://first.example/v1", models: ["a"], key: "first-key", maxTurns: 3 },
    second: { baseURL: "https://second.example/v1", models: ["b"], apiKey: "second-key", maxMessages: 20 },
  } };
  const a = await plugin.server(input, options), b = await Provider02(input, options);
  assert.deepEqual(await Provider03(input, options), {});
  assert.equal(a.auth.provider, "first"); assert.equal(b.auth.provider, "second");
  const cfg = {}; await a.config(cfg); await b.config(cfg);
  assert.deepEqual(Object.keys(cfg.provider), ["first", "second"]);
  assert.deepEqual(saved.map((v) => [v.path.id, v.body.key]), [["first", "first-key"], ["second", "second-key"]]);
  assert.doesNotMatch(JSON.stringify(cfg), /first-key|second-key/);
  assert.equal((await b.auth.loader(async () => null)).baseURL, "https://second.example/v1");
});

test("invalid multi-provider configuration is rejected before credential writes", async () => {
  const { Provider02 } = await import("../autocompact.provider.js");
  const good = { baseURL: "https://example.com/v1", models: ["test"], maxTurns: 3, key: "key" };
  let writes = 0;
  const input = { client: { auth: { set: async () => writes++ } } };
  for (const options of [
    { provider: good, providers: {} }, { providers: [] }, { providers: null },
    { providers: { missing: { ...good, key: undefined } } },
    { providers: { first: good, second: { ...good, key: "" } } },
    { providers: { first: { ...good, apiKey: "different-key" } } },
    { providers: { first: { ...good, id: "other" } } },
    { providers: { "invalid#id": good } },
    { providers: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, good])) },
  ]) await assert.rejects(plugin.server(input, options));
  assert.equal(writes, 0);
  assert.deepEqual(await plugin.server(input, { providers: {} }), {});
  assert.deepEqual(await Provider02(input, {}), {});
  const disabled = await plugin.server(input, { providers: { off: { enabled: false }, on: good } });
  assert.deepEqual(disabled, {});
  assert.equal((await Provider02(input, { providers: { off: { enabled: false }, on: good } })).auth.provider, "on");
});

test("omitted models are discovered at startup with configured key and headers, then cached", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), "https://example.com/v1/models");
    assert.equal(init.headers.get("authorization"), "Bearer configured-key");
    assert.equal(init.headers.get("openai-project"), "project-a");
    assert.equal(init.redirect, "error");
    return Response.json({ data: [{ id: "a" }, { id: "a" }, { id: "b" }, {}] });
  };
  const hooks = await plugin.server({ client: { auth: { set: async () => {} } } }, { providers: { autocompact: {
    baseURL: "https://example.com/v1", key: "configured-key", headers: { "openai-project": "project-a" }, maxMessages: 80,
  } } });
  const cfg = {}; await hooks.config(cfg);
  assert.deepEqual(Object.keys(cfg.provider.autocompact.models), ["a", "b"]);
  const models = await hooks.provider.models({ models: {} });
  assert.equal(models.a.api.url, "https://example.com/v1");
  assert.equal(calls, 1);
});

test("model discovery retries failures with configured credentials and ignores stored account keys", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.equal(init.headers.get("authorization"), "Bearer configured-key");
    if (calls === 1) return Response.json({ detail: "secret-login-key" }, { status: 503 });
    return Response.json({ data: [{ id: "available" }] });
  };
  const hooks = await plugin.server({ client: { auth: { set: async () => {} } } }, { providers: { autocompact: { baseURL: "https://example.com/v1", key: "configured-key" } } });
  const cfg = {}; await assert.rejects(hooks.config(cfg), /HTTP 503/);
  assert.equal(calls, 1);
  assert.deepEqual(cfg.provider.autocompact.models, {});
  const args = { auth: { type: "api", key: "stale-login-key" } };
  assert.equal((await hooks.provider.models({ models: {} }, args)).available.api.id, "available");
  assert.equal(calls, 2);
});

test("failed startup discovery preserves registration and explicit empty models are invalid", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => Response.json({ data: [] });
  const config = { baseURL: "https://example.com/v1", maxTurns: 3, key: "key" };
  const hooks = await plugin.server({ client: { auth: { set: async () => {} } } }, { providers: { autocompact: config } });
  const cfg = {};
  await assert.rejects(hooks.config(cfg), /未返回有效模型列表/);
  assert.ok(cfg.provider.autocompact);
  await assert.rejects(plugin.server({}, { providers: { autocompact: { ...config, models: [] } } }), /至少填写一个模型/);
});


test("optional controls default to passthrough, responses and enabled pack; invalid booleans are rejected", async () => {
  const base = { baseURL: inputs.baseURL, models: ["test"], mode: "pack", maxTurns: 2, keepTurns: 1 };
  const result = providerSettings(base, "test"), policy = result.transportOptions.providers.test;
  assert.equal(result.protocol, "responses"); assert.equal(policy.enablePack, true);
  assert.equal(policy.maxMessages, undefined); assert.equal(policy.stateful.maxRequests, undefined);
  for (const key of ["mode", "maxTurns", "keepTurns"]) {
    assert.equal(Object.hasOwn(policy, key), false); assert.equal(Object.hasOwn(result.config, key), false);
  }
  const zeros = providerSettings({ ...base, maxMessages: 0, maxRequests: 0, enablePack: false }, "test").transportOptions.providers.test;
  assert.equal(zeros.maxMessages, undefined); assert.equal(zeros.stateful.maxRequests, undefined); assert.equal(zeros.enablePack, false);
  assert.equal(providerSettings({ ...base, maxRequests: 1 }, "test").transportOptions.providers.test.stateful.maxRequests, 1);
  for (const enablePack of [null, 0, "false", {}]) assert.throws(() => providerSettings({ ...base, enablePack }, "test"), /enablePack/);
});


test("optional alpha search registers the provider's native searches capability only when enabled", async () => {
  const base = { baseURL: inputs.baseURL, key: "configured-key", models: ["test"] };
  for (const enableAlphaSearch of [undefined, false, true]) {
    const hooks = await plugin.server(client, { providers: { test: { ...base, enableAlphaSearch } } });
    const cfg = {}; await hooks.config(cfg);
    assert.equal(cfg.provider.test.searches, enableAlphaSearch === true);
    assert.equal(cfg.provider.test.models.test.searches, undefined, "Native tool support must not mislabel the model as a text-only search engine");
  }
  let writes = 0;
  for (const enableAlphaSearch of [null, 0, "true", {}]) {
    await assert.rejects(plugin.server({ client: { auth: { set: () => writes++ } } }, { providers: { test: { ...base, enableAlphaSearch } } }), /enableAlphaSearch/);
  }
  for (const protocol of ["chat", "anthropic"]) {
    await assert.rejects(plugin.server(client, { providers: { test: { ...base, protocol, enableAlphaSearch: true } } }), /enableAlphaSearch.*responses/);
    assert.ok(await plugin.server(client, { providers: { test: { ...base, protocol, enableAlphaSearch: false } } }));
  }
  assert.equal(writes, 0);
});

test("the registered provider loader relays native alpha search with configured credentials and headers", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "magpie-alpha-loader-"));
  const original = globalThis.fetch, seen = [];
  t.after(async () => { globalThis.fetch = original; await rm(stateDir, { recursive: true, force: true }); });
  const answer = '{ "encrypted_output": "opaque-native-result", "output": "result", "results": [] }';
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(answer, { headers: { "content-type": "application/json" } });
  };
  const hooks = await plugin.server(client, { providers: { native: {
    baseURL: inputs.baseURL, key: "configured-native-key", models: ["test"], enableAlphaSearch: true,
    headers: { "user-agent": "Codex TUI configured UA", "openai-project": "configured-project" }, stateDir,
  } } });
  const cfg = {}; await hooks.config(cfg); assert.equal(cfg.provider.native.searches, true);
  const loader = await hooks.auth.loader();
  const raw = '{ "id":"keep-id", "model":"test", "commands":{"open":[{"ref_id":"https://example.com"}]}, "extra":true }';
  const response = await loader.fetch("https://a.example/v1/alpha/search", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer stale-key", "x-openai-actor-authorization": "gateway-only" }, body: raw,
  });
  assert.equal(response.status, 200); assert.equal(await response.text(), answer);
  assert.equal(seen.length, 1); assert.equal(seen[0].url, "https://a.example/v1/alpha/search");
  assert.equal(seen[0].init.body, raw);
  assert.equal(seen[0].init.headers.get("authorization"), "Bearer configured-native-key");
  assert.equal(seen[0].init.headers.get("user-agent"), "Codex TUI configured UA");
  assert.equal(seen[0].init.headers.get("openai-project"), "configured-project");
  assert.equal(seen[0].init.headers.get("x-openai-actor-authorization"), null);
});
