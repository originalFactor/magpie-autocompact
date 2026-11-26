import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "../autocompact.provider.js";
import { providerForm } from "../lib/provider-form.js";
import { apiBase } from "../lib/provider-config.js";

const inputs = { name: "供应商 A", baseURL: "https://a.example/v1/", apiKey: "secret-key", models: "model-a, model-b model-a", advanced: "default" };

test("unconfigured installation registers a supplier with native password prompts", async () => {
  const hooks = await plugin.server({});
  const config = {}; await hooks.config(config);
  assert.equal(config.provider.autocompact.name, "自动压缩 · 自定义供应商");
  assert.deepEqual(config.provider.autocompact.models, {});
  assert.equal(hooks.auth.methods[0].prompts.find((p) => p.key === "apiKey").type, "password");
  assert.deepEqual(await hooks.provider.models({ models: {} }), {});
  assert.deepEqual(await plugin.server({}, { provider: { enabled: false } }), {});
});

test("native form stores explicit nonsecret settings and the key separately", async () => {
  const form = providerForm("autocompact", { fetchImpl: () => { throw new Error("manual models must not fetch"); } });
  const result = await form.authorize({ ...inputs, unexpected: "do not store", maxMessages: "1", mode: "summary" });
  assert.equal(result.type, "success");
  assert.equal(result.key, inputs.apiKey);
  assert.doesNotMatch(JSON.stringify(result.metadata), /secret-key|unexpected|do not store/);
  assert.deepEqual(result.metadata.autocompact.models, ["model-a", "model-b"]);
  assert.equal(result.metadata.autocompact.maxMessages, 80);
  assert.equal(result.metadata.autocompact.mode, "responses");
});

test("native model discovery uses the configured endpoint and key with redirects disabled", async () => {
  let call;
  const form = providerForm("autocompact", { fetchImpl: async (url, init) => {
    call = { url: String(url), init };
    return Response.json({ data: [{ id: "discovered" }, { id: "discovered" }, {}, { id: 42 }] });
  } });
  const result = await form.authorize({ ...inputs, models: "" });
  assert.equal(result.type, "success");
  assert.equal(call.url, "https://a.example/v1/models");
  assert.equal(call.init.headers.authorization, "Bearer secret-key");
  assert.equal(call.init.redirect, "error");
  assert.deepEqual(result.metadata.autocompact.models, ["discovered"]);
  const failed = providerForm("autocompact", { fetchImpl: async () => Response.json({}, { status: 403 }) });
  assert.match((await failed.authorize({ ...inputs, models: "" })).error, /HTTP 403/);
});

test("form validation rejects invalid thresholds, unsafe URLs, and empty credentials", async () => {
  const form = providerForm("autocompact");
  for (const change of [
    { apiKey: "" }, { name: "" }, { baseURL: "file:///tmp/test" },
    { baseURL: "https://user:pass@example.com/v1" }, { baseURL: "https://example.com/v1/responses" },
    { advanced: "custom", maxMessages: "0", maxTurns: "0" },
    { advanced: "custom", maxRequests: "1" }, { advanced: "custom", keepTurns: "-1" },
    { advanced: "custom", maxMessages: "2.5" }, { advanced: "custom", mode: "invalid" },
  ]) assert.equal((await form.authorize({ ...inputs, ...change })).type, "failed", JSON.stringify(change));
  const custom = await form.authorize({ ...inputs, advanced: "custom", maxMessages: "0", maxTurns: "2", maxRequests: "0", keepTurns: "1", mode: "pack" });
  assert.equal(custom.type, "success");
  assert.equal(custom.metadata.autocompact.maxMessages, undefined);
  assert.equal(custom.metadata.autocompact.maxRequests, undefined);
  assert.equal(custom.metadata.autocompact.maxTurns, 2);
  assert.equal(form.prompts.find((p) => p.key === "maxRequests").validate("1"), "请输入 2–100000，或 0 关闭此限制");
  assert.equal(apiBase("https://example.com/v1///").href, "https://example.com/v1/");
});

test("models and loader endpoints follow the actual account; credentials cannot go to another origin", async () => {
  const hooks = await plugin.server({});
  const form = hooks.auth.methods[0];
  const a = await form.authorize(inputs);
  const b = await form.authorize({ ...inputs, name: "供应商 B", baseURL: "https://b.example/api", models: "model-b" });
  const authA = { type: "api", key: a.key, metadata: a.metadata };
  const authB = { type: "api", key: b.key, metadata: b.metadata };
  const modelsA = await hooks.provider.models({}, { auth: authA });
  const modelsB = await hooks.provider.models({}, { auth: authB });
  assert.equal(modelsA["model-a"].api.url, "https://a.example/v1");
  assert.equal(modelsB["model-b"].api.url, "https://b.example/api");
  assert.equal(modelsB["model-a"], undefined);
  const loaderA = await hooks.auth.loader(async () => authA);
  const loaderB = await hooks.auth.loader(async () => authB);
  assert.equal(loaderA.baseURL, "https://a.example/v1");
  assert.equal(loaderB.baseURL, "https://b.example/api");
  assert.equal((await loaderA.fetch("https://b.example/api/responses")).status, 400);
  assert.equal((await loaderA.fetch("https://a.example/v1evil/responses")).status, 400);
});

test("explicit provider options retain the existing key-only login", async () => {
  const hooks = await plugin.server({}, { provider: { id: "legacy", baseURL: inputs.baseURL, models: ["test"], maxTurns: 2 } });
  assert.equal(hooks.auth.provider, "legacy");
  assert.equal(hooks.auth.methods[0].prompts, undefined);
  const config = {}; await hooks.config(config);
  assert.equal(config.provider.legacy.models.test.tool_call, true);
  assert.equal((await hooks.auth.loader(async () => ({ type: "api", key: "key" }))).baseURL, "https://a.example/v1");
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
    { provider: good, providers: {} }, { providers: [] },
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
  const hooks = await plugin.server({ client: { auth: { set: async () => {} } } }, { provider: {
    baseURL: "https://example.com/v1", key: "configured-key", headers: { "openai-project": "project-a" }, maxTurns: 3,
  } });
  const cfg = {}; await hooks.config(cfg);
  assert.deepEqual(Object.keys(cfg.provider.autocompact.models), ["a", "b"]);
  const models = await hooks.provider.models({ models: {} });
  assert.equal(models.a.api.url, "https://example.com/v1");
  assert.equal(calls, 1);
});

test("model discovery without configured key waits for login and retries failures", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.equal(init.headers.get("authorization"), "Bearer login-key");
    if (calls === 1) return Response.json({ detail: "secret-login-key" }, { status: 503 });
    return Response.json({ data: [{ id: "available" }] });
  };
  const hooks = await plugin.server({}, { provider: { baseURL: "https://example.com/v1", maxTurns: 3 } });
  const cfg = {}; await hooks.config(cfg);
  assert.equal(calls, 0);
  assert.deepEqual(cfg.provider.autocompact.models, {});
  const args = { auth: { type: "api", key: "login-key" } };
  await assert.rejects(hooks.provider.models({ models: {} }, args), /HTTP 503/);
  assert.equal((await hooks.provider.models({ models: {} }, args)).available.api.id, "available");
  assert.equal(calls, 2);
});

test("failed startup discovery preserves registration and explicit empty models are invalid", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => Response.json({ data: [] });
  const config = { baseURL: "https://example.com/v1", maxTurns: 3, key: "key" };
  const hooks = await plugin.server({ client: { auth: { set: async () => {} } } }, { provider: config });
  const cfg = {};
  await assert.rejects(hooks.config(cfg), /未返回有效模型列表/);
  assert.ok(cfg.provider.autocompact);
  await assert.rejects(plugin.server({}, { provider: { ...config, models: [] } }), /至少填写一个模型/);
});
