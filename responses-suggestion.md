我先查一下 OpenAI 目前关于 compaction 和会话状态的官方文档，再给出方案。

**可以做到，但“按轮数”压缩需要 Middleware 自己计数和触发，而且不应直接用 `/responses/compact`。** 以下结论基于官方文档，我没有对真实 API 或你的上游做过实测。

## 三种压缩方式

| 方式 | 触发条件 | 能否解决 100 轮限制 |
|---|---|---|
| `context_management` + `compact_threshold` | token 数超过阈值（服务端自动压缩，无需单独调用 compact） | 不能直接解决，它不看轮数 |
| `POST /responses/compact` | 手动调用 | **很可能不能**。API Reference 写明输出是全部 user 消息加一个 compaction item，user 轮数不会减少 |
| `input` 末尾追加 `{"type":"compaction_trigger"}` | 手动，立即压缩 | **最合适**，由 Middleware 决定何时触发 |

## 流程（`previous_response_id` 模式）

1. Middleware 按 `response_id` 记录当前链的轮数。
2. 到软阈值（建议 80–90，不要卡在 99）时，先向上游发一个只含 `compaction_trigger` 的内部请求。
3. 取出返回的 compaction item，**开一条新链**（不带 `previous_response_id`），输入为 `[compaction item, 用户新消息]`。
4. 把新响应返回给客户端。客户端下一轮自然会带上新链的 ID。

```python
SOFT_LIMIT = 85

def handle(req: dict):
    prev = req.get("previous_response_id")
    turns = store.get(prev, 0)          # response_id -> 本链轮数
    items = as_item_list(req["input"])  # 字符串转为 message item

    if prev and turns >= SOFT_LIMIT and not has_tool_output(items):
        c = upstream.responses.create(
            model=req["model"],
            previous_response_id=prev,
            input=[{"type": "compaction_trigger"}],
        )
        comp = [i.model_dump(exclude_none=True)
                for i in c.output if i.type == "compaction"]
        if not comp:
            raise RuntimeError("compaction failed")
        req = {**req, "input": comp + items}
        req.pop("previous_response_id")
        turns = 0

    resp = upstream.responses.create(**req)
    store[resp.id] = turns + 1
    out = resp.model_dump()
    out["previous_response_id"] = prev  # 回显客户端原来的值
    return out
```

这是非流式的示意代码。流式时，内部压缩请求的事件不要转发，响应事件里的 `previous_response_id` 也要同样改写。

## 无状态模式（客户端每次发完整历史）

客户端不知道发生过压缩，会一直发送全量历史，所以 Middleware 必须：

- 保存“已压缩的历史前缀哈希 → compaction item”的映射。
- 每次请求匹配最长前缀，替换成 compaction item，再拼上之后的新内容。
- 计算哈希前先做归一化，因为不同 SDK 回传时可能增删 `id`、`status` 或空字段。
- 按租户隔离缓存，避免串话。

## 容易踩的坑

- **先弄清上游的“轮”怎么算**：是 user 消息数、请求次数、input item 数，还是链长度？这决定计数方式。
- **工具调用**：不要在 `function_call` 和 `function_call_output` 之间压缩。长 agent loop 要预留余量。
- **工具与配置**：显式触发的压缩不会携带先前的 `additional_tools` 声明，需要重新提供。如果用了 `configuration_update`，也要补发最新值。
- **指令**：每次请求照常带上 `instructions`。写在历史里的 system/developer 消息建议在新链中重新注入。
- **上游兼容性**：如果上游是第三方网关或兼容实现，要确认它支持 `compaction_trigger`。compaction item 是不透明的加密内容，上游无法识别时，只能由 Middleware 自己生成文本摘要。
- **Conversations API**：历史保存在 `conversation` 对象里，需要新建对象并做新旧 ID 映射，透明性更差。
- **并非完全无感**：压缩那一轮延迟和 token 费用会增加，细节可能丢失。可以在到达阈值的那轮响应结束后异步预压缩，降低延迟。
- **工程细节**：对同一条链加锁，状态放持久化存储，压缩失败时要能重试。

建议先做一个最小验证：确认 `compaction_trigger` 的输出里确实没有保留旧的 user 消息，并且用它开新链后，上游的轮数确实归零。如果你告诉我上游是谁、客户端用哪种会话模式，我可以把它写成完整的代理服务。

Sources:
- [Compaction 指南](https://developers.openai.com/api/docs/guides/compaction.md)
- [Compact a response API Reference](https://developers.openai.com/api/reference/typescript/resources/responses/methods/compact)