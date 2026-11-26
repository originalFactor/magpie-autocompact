import { apiBase, providerSettings } from "./provider-config.js";

const errorOf = (check) => (value) => { try { check(value); } catch (error) { return error.message; } };
const required = (value) => { if (typeof value !== "string" || !value.trim()) throw new Error("此项不能为空"); };
const number = (value, fallback, optional = false) => {
  const n = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < (optional ? 0 : 1) || n > 100000) throw new Error(`请输入 ${optional ? 0 : 1}–100000 的整数`);
  return n === 0 ? undefined : n;
};
const numericPrompt = (key, message, fallback, optional = false) => ({ type: "text", key, message, placeholder: `${fallback}${optional ? "；0 表示关闭此限制" : ""}`, validate: errorOf((v) => number(v, fallback, optional)) });
const requests = (value) => {
  const n = number(value, 80, true);
  if (n === 1) throw new Error("请输入 2–100000，或 0 关闭此限制");
  return n;
};

// Native auth prompts keep the key in Magpie's credential store. Only explicit
// nonsecret settings are returned as metadata; inputs are never copied wholesale.
export function providerForm(id, { fetchImpl = fetch } = {}) {
  return {
    type: "api", label: "添加自定义供应商（自动压缩）",
    prompts: [
      { type: "text", key: "name", message: "名称", placeholder: "例如：我的供应商", validate: errorOf(required) },
      { type: "text", key: "baseURL", message: "Base URL（Responses API 根地址）", placeholder: "https://api.example.com/v1", validate: errorOf(apiBase) },
      { type: "password", key: "apiKey", message: "API Key", placeholder: "sk-…", validate: errorOf(required) },
      { type: "text", key: "models", message: "模型 ID（逗号分隔，留空从 /models 获取）", placeholder: "model-a, model-b" },
      { type: "select", key: "advanced", message: "自动上下文压缩设置", options: [
        { label: "使用默认值", value: "default", hint: "80 条消息 / 40 轮，保留最近 4 轮，原生压缩" },
        { label: "自定义阈值和压缩方式", value: "custom" },
      ] },
      ...[
        numericPrompt("maxMessages", "最大消息数（留空 80，0 关闭）", 80, true),
        numericPrompt("maxTurns", "最大对话轮数（留空 40，0 关闭）", 40, true),
        numericPrompt("keepTurns", "保留最近轮数（留空 4）", 4),
        { ...numericPrompt("maxRequests", "服务端会话最大请求数（留空 80，0 关闭）", 80, true), validate: errorOf(requests) },
        { type: "select", key: "mode", message: "压缩方式", options: [
          { label: "Responses 原生压缩", value: "responses", hint: "不支持时回退到文本打包" },
          { label: "文本打包", value: "pack", hint: "减少消息数，不减少 token" },
        ] },
      ].map((p) => ({ ...p, when: { key: "advanced", op: "eq", value: "custom" } })),
    ],
    async authorize(inputs, { signal } = {}) {
      try {
        required(inputs.name); required(inputs.apiKey);
        const base = apiBase(inputs.baseURL);
        let models = [...new Set((inputs.models ?? "").split(/[,，\s]+/u).filter(Boolean))];
        if (!models.length) {
          const response = await fetchImpl(new URL("models", base), { headers: { authorization: `Bearer ${inputs.apiKey.trim()}` }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), redirect: "error" });
          if (!response.ok) throw new Error(`获取模型失败（HTTP ${response.status}），请重试并手动填写模型 ID`);
          const body = await response.json();
          models = [...new Set((Array.isArray(body.data) ? body.data : []).map((m) => m?.id).filter((v) => typeof v === "string" && v.trim()))];
          if (!models.length) throw new Error("上游未返回模型，请重试并手动填写模型 ID");
        }
        const custom = inputs.advanced === "custom";
        const config = {
          name: inputs.name.trim(), baseURL: base.href.replace(/\/$/, ""), models,
          maxMessages: number(custom ? inputs.maxMessages : undefined, 80, true),
          maxTurns: number(custom ? inputs.maxTurns : undefined, 40, true),
          keepTurns: number(custom ? inputs.keepTurns : undefined, 4),
          maxRequests: requests(custom ? inputs.maxRequests : undefined),
          mode: custom ? inputs.mode ?? "responses" : "responses",
        };
        providerSettings(config, id);
        // Magpie displays metadata.email as the account name and deduplicates
        // sign-ins by it. Include the endpoint so equally named suppliers differ.
        return { type: "success", key: inputs.apiKey.trim(), metadata: { email: `${config.name} · ${config.baseURL}`, autocompact: config } };
      } catch (error) {
        if (signal?.aborted) throw error;
        return { type: "failed", error: error.message };
      }
    },
  };
}
