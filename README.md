# Magpie 自动上下文压缩

## 介绍

Magpie 自动上下文压缩是一个 Provider 插件。它可在对话历史达到设定阈值时整理上下文，帮助长对话继续进行。支持 OpenAI Responses、Chat Completions 和 Anthropic Messages 上游。

## 安装

在插件目录运行：

```powershell
magpie plugin add "$PWD"
```

## 使用

1. 编辑配置示例，填入上游地址、API 密钥和模型。
2. 将配置导入 Magpie。
3. 运行 `magpie models` 查看可用模型，并在 Magpie 中选择 `供应商ID/模型别名`。

```powershell
$options = Get-Content -Raw -Encoding utf8 examples/options.jsonc |
  ConvertFrom-Json -ErrorAction Stop |
  ConvertTo-Json -Depth 100 -Compress
magpie plugin options magpie-autocompact $options
magpie models
```

此命令适用于 PowerShell 7 或更高版本。修改配置后，重新执行导入命令。

## 配置

从 [`examples/options.jsonc`](examples/options.jsonc) 开始配置。先修改启用的 `responses-main` 条目中的 `baseURL`、`key` 和模型 ID；其他示例条目默认关闭，可按需修改并启用。已有供应商配置时，将插件配置合并到同一个 `providers` 对象中。

常用选项：

- `protocol`：上游类型，支持 `responses`、`chat` 和 `anthropic`。
- `models`：可配置模型列表和 Magpie 中显示的模型别名；省略时尝试从上游获取模型。
- `maxMessages`：对话历史超过该条数时触发压缩；省略或设为 `0` 时不压缩。
- `maxRequests`：控制何时更换会话标识；省略或设为 `0` 时不更换。
- `enablePack`：控制是否启用最后一级的历史整理，默认开启。
- `compactionNotice`：默认 `false`；设为 `true` 或非空字符串时，压缩成功后先输出提示，再继续请求上游。流式请求在同一条响应流中接续模型回复，提示后不结束本轮；非流式请求将提示与模型回复一起返回。`true` 使用“上下文已压缩，请继续。”，提示与回复以空行分隔。
- `timeoutMs`：整个请求的超时预算，默认 `120000` 毫秒；设为 `0` 时不限制，否则至少 `100`。
- `summary.maxTokens`：摘要输出 token 上限，默认 `2048`；设为 `0` 时不发送该上限，由上游决定。
- `summary.maxInputChars` / `responses.maxInputChars`：摘要 / 原生压缩的历史前缀 JSON 字符数上限，默认分别为 `200000` / `2000000`；设为 `0` 时不检查字符数。
- `summary.timeoutMs` / `responses.timeoutMs`：每次摘要 / 原生压缩尝试的超时，默认 `25000` 毫秒；设为 `0` 时关闭该层计时器。整个请求和外部摘要供应商配置的超时仍生效，请求取消也仍生效。

summary 支持非文本历史：历史结构以 JSON 文本提供，图片、音频、文件等另以原生内容块发送给摘要模型，工具调用与结果保持在同一个历史前缀中。摘要模型和上游须支持相应输入模态。同协议保留原始媒体块；跨协议可转换图片和内联文件 / 支持的文件 URL，无法转换的内容会令摘要失败，再按配置尝试 pack。加密推理等不透明历史仍不能通过 summary 或 pack 丢弃；pack 仅支持文本历史。当前输入保持原样。

`0` 只关闭插件对应的限制，实际输出和上下文仍受上游限制。部分上游（例如要求 `max_tokens` 的 Anthropic 接口）可能拒绝未指定输出上限的摘要请求，此时会进入已有的失败回退流程。

使用 `"models": ["模型 ID"]` 或省略 `models` 自动从上游获取列表时，插件会从 `https://pi.dev/api/models` 补齐已知模型的显示名称、推理能力、effort 档位、上下文与输出限额、输入模态、temperature 支持及价格。列表仍由配置或上游 `/models` 决定，实际模型 ID、上游地址与认证不变。对象格式的 `models` 保持手动声明，不查询或覆盖元数据。

元数据按完整模型 ID 匹配，也支持目录中的 `供应商/模型 ID`；不模糊匹配或移除版本后缀。同名条目优先匹配上游主机，再匹配供应商 ID，随后优先原厂目录（OpenAI、Anthropic、Google 等）。未知模型保持基本声明。公共目录请求不携带供应商密钥或自定义 headers，超时为 4 秒；同一宿主进程共享请求并缓存成功结果 1 小时，失败结果缓存 1 分钟，目录不可用时仍可使用模型。

effort 的 `variants` 键遵循 Magpie 的 Pi 适配器和 Pi `getSupportedThinkingLevels`：`thinkingLevelMap` 中的 `null` 表示不支持，未声明的 `minimal/low/medium/high` 使用 Pi 默认支持规则，`xhigh/max` 需要显式声明；不注册 `off`。这些字段声明可选档位，不强制请求使用某个 effort。价格来自公共目录，仅供估算，可能与实际中转商计费不同。

实现定义参照 Magpie 仓库 `yetone/magpie` 的 `internal/plugin/host.js`（配置模型、价格及 variants）、`internal/plugin/pi.js`（Pi 模型映射）、`internal/provider/plugins.go`（effort 读取）和 `docs/subsystems/provider-plugins.md`；Pi 档位规则参照 `badlogic/pi-mono` 的 `packages/ai/src/models.ts` 与 `packages/ai/src/types.ts`。

配置文件是带注释的 JSONC，不能原样传给 Magpie；上面的命令会先解析配置再导入。不要在配置文件中保存真实密钥并提交到版本库。

## 开发

需要 Node.js 22.13 或更高版本。运行测试：

```sh
npm test
```

需要已安装 Magpie 才能运行集成测试：

```sh
npm run test:integration
```

## LICENSE

本项目使用 MIT License，详见 [`LICENSE`](LICENSE)。

## 致谢

感谢 Magpie 项目及所有为本项目提供反馈和贡献的使用者与维护者。
