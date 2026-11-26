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
