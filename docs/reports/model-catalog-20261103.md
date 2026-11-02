# 翻译服务和模型目录核对（2026-11-03）

本次以用户截图和代码中的内置服务目录为范围，按照当前服务的协议、精确模型 ID 和公开官方资料，补充适用于文本翻译的候选。截图显示 49 项；实际数量会随浏览器能力和自定义配置变化，隔离 Edge 夹具中显示 47 项。自定义服务的实际模型取决于用户部署，本次没有读取用户浏览器配置。可用型号、账号权限、地域和价格会变化；候选不代表每个账号都已开通。保留已有默认值和已保存的选择，没有使用用户密钥访问真实服务或对译文质量、延迟作比较。

## 新增候选

| 服务 | 新增模型 ID | 主要依据 |
| --- | --- | --- |
| OpenAI | `gpt-6-luna`、`gpt-6.1-terra`、`gpt-6.1-sol`、`gpt-6-sol` | [模型列表](https://developers.openai.com/api/docs/models)、[Sol 接口](https://developers.openai.com/api/docs/models/gpt-6-sol) |
| Gemini | `gemini-4-argon` | [GenerateContent 示例](https://ai.google.dev/gemini-api/docs/generate-content/latest-model) |
| 千问 / Qwen | `qwen3.8-27b`、`qwen3.8-2.4t-a95b` | [百炼模型目录](https://help.aliyun.com/zh/model-studio/model-list-text-generation)、[定价与地域](https://help.aliyun.com/zh/model-studio/model-pricing) |
| Claude | `claude-haiku-5-5`、`claude-sonnet-5-5`、`claude-opus-5-5` | [模型目录](https://platform.claude.com/docs/en/models/overview) |
| 字节豆包 | `doubao-seed-2-1-lite-260915`、`doubao-seed-2-1-pro-260915`、`doubao-seed-2-1-turbo-260628`、`doubao-seed-evolving` | [火山方舟模型列表](https://docs.volcengine.com/docs/ark/model-list)、[Chat 调用示例](https://docs.volcengine.com/docs/ark/text-generation) |
| 阶跃星辰 | `step-3.7-flash`、`step-5-preview` | [Step 3.7 Chat 示例](https://github.com/stepfun-ai/Step-3.7-Flash)、[Step 5 示例](https://platform.stepfun.com/cookbook/step-5-reasoning) |
| 硅基流动 | `deepseek-ai/DeepSeek-V4.1-Flash`、`Qwen/Qwen3.8-27B` | [更新公告](https://docs.siliconflow.cn/docs/release-notes/overview)、[Qwen 示例](https://docs.siliconflow.cn/docs/usercases/use-siliconcloud-in-yan) |
| Groq | `qwen/qwen3.8-27b` | [模型及下线说明](https://console.groq.com/docs/deprecations) |
| OpenRouter | `qwen/qwen3.8-flash`、`google/gemini-4-argon`、`openai/gpt-6-luna`、`openai/gpt-6.1-sol`、`anthropic/claude-haiku-5.5`、`anthropic/claude-sonnet-5.5`、`anthropic/claude-opus-5.5`、`stepfun/step-3.7-flash` | [Qwen](https://openrouter.ai/qwen/qwen3.8-flash)、[Gemini](https://openrouter.ai/google/gemini-4-argon)、[GPT-6.1 Sol](https://openrouter.ai/openai/gpt-6.1-sol)、[GPT-6 Luna](https://openrouter.ai/openai/gpt-6-luna)、[Haiku](https://openrouter.ai/anthropic/claude-haiku-5.5)、[Sonnet](https://openrouter.ai/anthropic/claude-sonnet-5.5)、[Opus](https://openrouter.ai/anthropic/claude-opus-5.5)、[Step](https://openrouter.ai/stepfun/step-3.7-flash) |
| Mistral AI | `mistral-large-4` | [模型及 Chat Completions 支持](https://docs.mistral.ai/models/mistral-large-4-0) |
| Together AI | `Qwen/Qwen3.8-27B` | [模型页](https://www.together.ai/models/qwen3-8-27b) |
| DeepInfra | `Qwen/Qwen3.8-27B` | [API 示例](https://deepinfra.com/blog/qwen3-8-27b) |
| Ollama | `qwen3.8:27b`、`qwen3.8-flash-next:125b-a6b-q4_K_M`、`qwen3.8-flash-next:125b-mlx` | [Qwen3.8](https://ollama.com/library/qwen3.8)、[Flash-Next 标签及体积](https://ollama.com/library/qwen3.8-flash-next/tags) |

### Qwen3.8-Flash-Next

开放权重的 [Qwen3.8-Flash-Next](https://github.com/QwenLM/Qwen3.8-Flash-Next) 与百炼托管 API 的 `qwen3.8-flash` 应区分。后者在 FluentRead 的千问服务里此前已是默认候选；本次也加入 OpenRouter 的对应 ID。前者本次为 Ollama 加入两个官方标签：普通量化版本约 120 GB、MLX 版本约 105 GB，实际运行还需要相应的内存、硬件与 Ollama 环境，必须先自行拉取模型；选择列表不会下载或安装模型。Fireworks 的 Flash-Next 页面标为不支持 serverless，需要用户部署后使用其实际部署 ID，因此未把基础模型路径当作开箱即用的候选。[Fireworks 模型页面](https://fireworks.ai/models/fireworks/qwen3p8-flash-next-fp8)

## 其余服务的检查结果

| 服务 | 结论 |
| --- | --- |
| 免费翻译服务、B站翻译、MyMemory、微软翻译、谷歌翻译、DeepL、DeepLX、小牛翻译、有道翻译、Chrome 内置 AI 翻译 | 当前实现使用各自翻译接口，不暴露文本大模型 ID 选择；本次不添加通用对话模型。 |
| 本地模型翻译 | 使用扩展内置模型及其下载、执行约束；Ollama 模型不能直接放入此目录，保留现有模型。 |
| 腾讯云翻译、谷歌云翻译、Azure 翻译、阿里云机器翻译、百度翻译、火山引擎翻译 | 当前实现调用各云厂商的机器翻译接口，不提供通用大模型 ID 选择。 |
| DeepSeek | 已有 `deepseek-flash`；官方说明它指向最新 V4.1 Flash，旧 Flash 别名仍可兼容，故不猜测新 API ID。[官方说明](https://api-docs.deepseek.com/quick_start/agent_integrations/) |
| 月之暗面 / Kimi | 现有 `kimi-k3`、`kimi-k2.7-code` 等；本轮未取得可证明还需新增的官方当前接口编号。 |
| 智谱 / GLM | 已包含 `glm-5.3`、`glm-5.3-flash`；本轮未取得适用于当前接口的更新官方编号。 |
| 腾讯混元模型 | 现有 `hy3`；新 `hy4-preview` 的官方示例使用 TokenHub 端点和其 API Key，不能直接假定适用当前旧端点，本轮未添加。[TokenHub 接入](https://cloud.tencent.com/document/product/1823/132252) |
| 腾讯混元翻译 | 当前使用独立的腾讯云签名翻译接口；TokenHub 的 `hy-mt2-*` 使用不同 Chat 端点，不能仅追加名称。[协议列表](https://cloud.tencent.com/document/product/1823/130079) |
| 文心一言 | 已包含 `ernie-5.1`；本轮未确认需要新增的更高版本 API ID。[模型列表示例](https://cloud.baidu.com/doc/qianfan-api/s/Dmba8k71y) |
| MiniMax | 已包含 M3/M3.1 Flash 候选；本轮未取得足以核实更多当前接口 ID 的官方证据，保留原列表。 |
| 小米 MiMo | 已包含 V2.6 Flash / Pro；官方提示 V2.5 系列已退役。[平台公告](https://platform.xiaomimimo.com/) |
| Grok | 已包含 `grok-4.6`；网页产品的新名称不能直接推断为 API ID。[API 模型](https://docs.x.ai/developers/models) |
| New API、自定义接口 | 上游和模型由用户自建或指定，公开目录不能证明其部署支持；继续使用自定义模型。 |
| Azure | 模型取决于 Azure 资源、地域和用户创建的部署名，不能按 OpenAI 原厂 ID 假设可用。[Azure 文档](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/models) |
| 无问芯穹、Cerebras、Runcrate、CloudGPU | 本轮未取得足够的当前平台精确模型 ID 和当前端点证据，保留原候选；不能把原厂模型名直接套用到聚合商。 |
| Cohere | 保留现有翻译专用 `command-a-translate-08-2025` 及其他候选。[官方模型](https://docs.cohere.com/v1/docs/models) |
| Fireworks AI | 新 Flash-Next 页面明确为按需部署、非 serverless；用户部署后可填写实际部署 ID。[模型页](https://fireworks.ai/models/fireworks/qwen3p8-flash-next-fp8) |
| Perplexity | 保留现有 Sonar 候选；本轮未取得可可靠添加的更新型号及对应当前接口证据。 |

另外，ChatGPT 套餐入口只在开发实验中开放，其模型按已授权账户动态发现，不能套用 OpenAI API 目录。历史配置中的百川和零一万物入口不属于当前设置页的 49 项：百川保留历史配置；[零一万物公告](https://platform.lingyiwanwu.com/assets/)显示其开放平台已于 2026-09-03 停止 API，用户如有余额应以公告所示期限核对退款。

Groq 的 `qwen/qwen3.6-27b` 对免费和开发者账户已于 2026-09-14 停用，官方称部分企业合同不受影响；目录暂保留该 ID 以免破坏存量配置，新用户应选择 `qwen/qwen3.8-27b`。[官方公告](https://console.groq.com/docs/deprecations)

## 请求兼容性

根据官方规则，Gemini 4 Argon 在关闭思考偏好时使用最低 `low`；GPT-6.1 Sol 也使用最低 `low`，GPT-6 Luna、Sol 和 6.1 Terra 可以使用 `none`。Claude Opus 5.5 的思考不可关闭，Sonnet 5.5 在关闭前置思考时需要 `between_tools`，Haiku 5.5 可以使用 `disabled`；豆包 2.1 新增型号使用 `thinking.type` 开关。[Gemini](https://ai.google.dev/gemini-api/docs/thinking/)、[OpenAI](https://developers.openai.com/api/docs/guides/reasoning)、[Claude](https://platform.claude.com/docs/en/build-with-claude/thinking)、[豆包](https://docs.volcengine.com/docs/ark/deep-thinking)。明确支持图片输入的型号也登记在视觉能力表中；实际表现仍需对应账号与模型验证。

## 验证与限制

- 9 个相关测试文件、412 项测试通过；本次修改的 `catalog.ts`、`vision.ts` 和 `modelThinking.ts` 定向覆盖率在语句、分支、函数和行四项均为 100%。测试审计和 TypeScript/Vue 类型检查通过。
- Chrome、Firefox、userscript 生产构建和 userscript 校验、文档构建通过。Chrome 和 Firefox 构建各有两条产物体积超过 500 kB 的分包提示；本次没有调整构建拆包。
- 使用生产 Chrome 扩展产物和第二屏不抢焦点的隔离 Edge，检查 13 个服务的 33 个新增模型选项，逐服务选择并复查千问、Claude、Ollama 模型及默认服务在重载后的持久化。采集到的扩展页面和后台诊断为 0 个错误、0 个告警；采集从连接浏览器后开始，存在首次后台启动和跨进程 iframe 的采集空窗。未做 Firefox 真实浏览器测试。
- 现有通用 UI 脚本首次重试停在首启语言引导，因为脚本仍等待旧 Popup 标题；当前基线已有该引导和新版服务选择器。本次使用同一焦点安全启动器及诊断采集器，针对当前界面重新执行上述范围，未把旧脚本失败写为通过。
- 本次没有使用账户密钥调用真实供应商，也没有下载本地模型或测量翻译质量、可用性、速度和费用。模型和地域、账户权限请以各平台实际结果为准。不涉及参考仓库的代码或依赖。
