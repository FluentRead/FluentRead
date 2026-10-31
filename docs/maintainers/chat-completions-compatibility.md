# Chat Completions 协议兼容方案

## 调研结论

[OpenAI Chat Completions 参数参考](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)与[官方 Python SDK 类型](https://github.com/openai/openai-python/blob/main/src/openai/types/chat/completion_create_params.py)明确将 `max_tokens` 标为弃用，使用 `max_completion_tokens`；后者包含可见输出及推理 token。这个选择应属于端点协议，不应为 Luna、Terra 或未来模型维护白名单。

[Responses 类型](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_create_params.py)使用 `max_output_tokens` 和不同的输入、工具、事件结构。原生 Claude Messages 使用 `max_tokens`，Gemini 使用 `generationConfig.maxOutputTokens`。因此不能对所有 JSON 请求做全局字段替换，也不能把 Chat 到 Responses 的迁移当作字段别名转换。

项目锁定的 `@ai-sdk/openai-compatible` 2.0.70 将 `maxOutputTokens` 编码成 `max_tokens`，然后调用 `transformRequestBody`；其流式入口也在最终序列化前调用该 hook。[上游 compatible 实现](https://github.com/vercel/ai/blob/main/packages/openai-compatible/src/chat/openai-compatible-chat-language-model.ts)仍采用通用映射。[专用 OpenAI 实现](https://github.com/vercel/ai/blob/main/packages/openai/src/chat/openai-chat-language-model.ts)另有模型能力、采样限制与推理参数逻辑，不能假设 compatible 包包含这些能力。本次不升级 SDK 或切换整套传输协议。

官方 Chat 类型允许 `reasoning_effort`，并明确不同模型支持不同取值；`service_tier` 接受 `fast` / `priority` 等值，响应报告实际使用的等级。传递用户配置不等于证明某个账户或模型支持它。这里不新增自动推理强度、采样参数过滤或 Fast 默认值，保留现有 Thinking 适配与明确的自定义字段优先级。

## 统一请求边界

`normalizeChatCompletionRequest` 是无副作用的 Chat 专用转换，输入为已解析的实际 endpoint 和已合并的最终 payload。普通翻译（含图片请求）、SDK 阅读/写作、轻量 userscript 阅读及 standalone 翻译在序列化之前共用它。

| 实际端点 / 显式配置 | 输出预算字段 | 依据 |
| --- | --- | --- |
| 官方 HTTPS OpenAI `/v1/chat/completions`，任意模型名 | `max_completion_tokens` | 现行官方 Chat 协议 |
| 自定义服务直连上述端点 | `max_completion_tokens` | 服务显示名称不决定协议 |
| 第三方网关、OpenRouter、本地兼容服务、Azure 版本化 deployment | 默认 `max_tokens` | 不能从模型别名或服务名称推断实际支持版本 |
| 任意 Chat 端点显式指定非空 `max_completion_tokens` | `max_completion_tokens`，删除旧字段 | 用户声明该端点的新字段能力 |
| Claude / Gemini / Responses / 固定匿名入口 | 原有专用适配器 | 不进入本次通用 Chat 转换 |

只精确识别官方 origin 和 Chat 路径；相似主机名、不同端口、HTTP 及不同路径不视为官方协议。Azure 保留旧默认，不推断部署别名对应的模型，也不假定所有 API 版本相同；需要新字段的部署可以显式配置。

显式非空 `max_completion_tokens` 高于 `max_tokens`；空值删除而不是作为绕过服务器校验的哨兵。没有预算时不添加预算。不会修改保存的配置，也不增加网络探测、错误重试或自动协议回退。

## 自定义字段与生命周期

所有使用通用 Chat 网关的阅读/写作服务统一浅合并高级 JSON，用户生成参数优先。DeepSeek Thinking 默认值先生成，自定义字段可显式覆盖，与翻译的优先级一致。`model`、`messages`、`tools`、`tool_choice`、`parallel_tool_calls`、`stream`、`stream_options` 和 `response_format` 仍由会话及 SDK 持有。原生接口和固定匿名服务不因此开放任意请求体替换。

阅读请求身份指纹纳入生效的自定义请求体，已有配置快照和多 Key 轮换机制保持不变。非法 JSON 在联网前报错；错误与取消仍走原来的链路，不记录完整配置或凭据。

## 验证边界

使用锁定的真实 SDK 和 mock HTTP 验证最终请求，覆盖官方端点任意模型、旧模型、未来别名、自定义官方端点、第三方代理、显式新字段、双字段冲突、空值、流式工具与消息保护，以及 SDK/standalone 翻译和 native/userscript 阅读一致性。为新增纯转换和改动配置模块执行四维严格覆盖率。

这些验证不替代真实浏览器、在线模型、账户等级或付费推理测试。尤其不能由请求中存在 `service_tier: fast` 推断实际获得 Fast 服务。
