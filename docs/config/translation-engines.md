# 翻译服务与模型配置

流畅阅读将待译文本交给你选定的服务处理：零配置可用**免费翻译池**，也可按功能分别接入**云服务 API**、**AI 大模型**、**组合翻译回退**或**本机离线模型**。

<GuideVisual kind="provider" />

<DocDiagram kind="provider-routing" />

## 如何选择翻译服务 {#怎么选}

| 你的使用目标 | 推荐方案 | 是否需要密钥 |
| --- | --- | --- |
| 安装后立即可用，不折腾配置 | **免费翻译服务**（自动均衡多条免费线路） | 无需 |
| 日常长文与批量文档，追求高速稳定 | **DeepL / 微软 / 谷歌** 或各大**云服务厂商官方 API** | 需云账号密钥 |
| 学术论文、文学、技术博客与 AI 深度讲解 | **OpenAI / DeepSeek / Claude / Gemini** 或 **OpenAI 兼容接口** | 需 API Key |
| 数据绝不离开本机，或离线断网阅读 | **内置本地模型**、**Ollama** 或[浏览器内置翻译](/guide/chrome-translator) | 无需 |
| 自动容灾、避免单服务限流中断 | **组合翻译服务**（轮流 / 随机 / 智能回退） | 依成员而定 |

::: warning 网页会员 ≠ API 额度
流畅阅读免费开源，第三方服务由服务商独立计费。网页聊天会员（如 ChatGPT Plus / Claude Pro）通常**不包含** API 额度；免费额度、地区限制与费用请以服务商控制台为准。
:::

## 四步配置并按功能分配 {#配置并开始使用}

1. 打开**设置 → 翻译服务**，搜索并点击要配置的服务（浏览目录仅打开连接表单，不会更改当前默认服务）。
2. 按提示填写 API Key、接口地址或区域；AI 服务需同时选择模型（内置列表未收录时，在**自定义模型**填写官方 API 模型 ID；Azure 填写实际**部署名称**）。
3. 点击**检查连接**（发送一条短测试请求，可能消耗极少额度）。
4. 确认通过后，点击**设为默认翻译服务**，或在弹窗**翻译服务** / **通用设置 → 按功能选择服务**中将其分配给网页、划词、文档或字幕。

<figure class="doc-figure"><a href="/screenshots/ui/zh-CN/settings-services.webp" target="_blank" rel="noopener"><img class="doc-screenshot" src="/screenshots/ui/zh-CN/settings-services.webp" width="2560" height="1600" alt="流畅阅读翻译服务目录与连接配置" loading="lazy" /></a><figcaption>填写连接并检查通过后，再点击「设为默认」或按功能分别指定。</figcaption></figure>

### 移除与恢复服务

点击目录行末 **×** 并确认即可从列表隐藏该服务（至少保留一项；移除默认服务时会提示接替项）。之后随时可在**自定义服务 → 恢复已移除服务**中找回，原有密钥、模型与功能选择都会完整保留。

## 免费翻译池与合批可靠性 {#免费翻译如何工作}

- **自动均衡 vs 优先顺序**：免费翻译默认按可用性与响应速度**自动均衡**，失败时可能将同一段落切换给下一条候选线路；也可改为**优先顺序**，或停用其余候选用单一线路。健康统计保存在本机。
- **实验接口与特性**：豆包网页翻译（匿名参数，不读个人 Cookie 或 API Key）与 Reverso 为实验接口；B 站翻译会自动合并同一正文块内的多行文本并在异常时逐行回退。
- **谷歌翻译与机器合批**：谷歌、微软、DeepL、Azure 与谷歌云默认开启**请求限制 → 合并翻译请求**，合并同配置短段减少请求次数（不减少按字符计费总量），结果异常时自动逐段恢复且不缓存坏结果。

## 本机离线翻译 {#本地模型翻译}

无需 API Key，翻译文本全程留在本机设备：

### 内置本地模型（仅浏览器扩展）

在**翻译服务 → 本地模型翻译**下载并校验模型，显示**可离线使用**后先试译再启用：

| 模型 | 下载体积 | 适用场景 |
| --- | --- | --- |
| **中英轻量语言包** | 约 239 MB | 轻便快速，适合简单中英句子 |
| **混元 Hy-MT2 1.8B** | 约 1.13 GB | 多语言与复杂句表达，需更多内存 |
| **日英轻量语言包** | 约 214 MB | 日译英为主（英译日质量有限） |

下载支持暂停/续传与备用源自动切换；模型保存在本机浏览器缓存（不进入配置备份），空闲后自动释放运行内存，详见[本地模型常见问题](/guide/faq#本地模型会每次重新加载吗-会一直占用内存吗)。

### Ollama、Rapid-MLX 与浏览器内置翻译

- **Ollama（本地）**：启动本机 Ollama 并拉取模型后，在**聚合平台与接口 → Ollama（本地）**填入模型名即可连接 `http://127.0.0.1:11434`（无需 Key）。若电脑较慢，建议将该服务的**请求限制 → 整个服务 → 自定义**并发设为 `1`。
- **Rapid-MLX（Apple Silicon）**：`pip install rapid-mlx` 安装后，允许扩展来源启动：`rapid-mlx serve qwen3.5-4b-4bit --cors-origins chrome-extension://djnlaiohfaaifbibleebjggkghlmcpcj`（解压加载版换成 `chrome://extensions` 显示的 ID；Firefox 用 `moz-extension://<uuid>`）。选择 **Rapid-MLX → 自定义模型**，填写 `curl http://127.0.0.1:8000/v1/models` 返回的准确模型 ID，默认无需 Key；改端口时在代理地址填写完整的 `/v1/chat/completions` URL。
- **浏览器内置翻译**：桌面 Chrome 138+ / Edge 148+ 可直接使用系统 Translator API，详见[浏览器内置翻译](/guide/chrome-translator)。

## 传统翻译与云厂商 API {#使用云服务厂商}

| 服务 | 必填凭据 | 说明 |
| --- | --- | --- |
| **DeepL** | API Key（区分 Free / Pro） | 网页订阅与 API 套餐不可互换 |
| **DeepLX** | 可选接口与 Token | 留空时先试匿名接口再回退公共 DeepLX；自定义地址需填完整路径（如 `https://deeplx.example.com/translate`），网址鉴权可用占位符 <code v-pre>{{apiKey}}</code>（如 <code v-pre>?token={{apiKey}}</code> 或 <code v-pre>/{{apiKey}}/translate</code>） |
| **MyMemory** | 联系邮箱（可留空） | 短文本自动识别不准时可手动指定源语言 |
| **谷歌云翻译** | API Key | 需在对应控制台开通服务 |
| **Azure 翻译** | 密钥、区域 | 区域必须与控制台资源一致 |
| **阿里云机器翻译** | AccessKey ID、AccessKey Secret、地域 | 凭据存本机，不含于公开分享配置 |
| **腾讯云翻译** | SecretId、SecretKey | 鉴权异常检查权限与本机时间同步 |
| **百度翻译** | APP ID、密钥 | 展开服务内的**开通指南**查看详情 |
| **火山引擎翻译** | Access Key ID、Secret Access Key、地域 | 区域需与控制台一致 |

## AI 大模型、组合翻译与多 Key 轮换 {#使用-ai-服务}

### AI 精翻与多段翻译 {#ai-精翻与多段翻译}

两项高级能力默认关闭，可独立开启（修改后先恢复原文再重新翻译生效）：

- **AI 精翻**：附带页面标题、章节定义、附近段落与已有译文帮助消歧，仅保留在当前会话。
- **AI 多段翻译**：合并同一父节点下相邻正文（默认每批上限 **8 个片段 / 2,000 字符**，可调 `2–32` / `500–12,000`，收集窗口固定 `32 ms`）。OpenAI 兼容接口在默认提示词下使用紧凑 JSON 编号校验，单段缺漏自动补译，整包异常自动回退逐段并停用当前页合批。
- **Claude & DeepSeek Responses 协议**：翻译请求始终等待完整非流式响应；遇到截断、拒绝或未完成工具调用会直接报失败而非输出半截译文。

### 组合翻译服务 {#组合翻译服务}

在**自定义服务 → 组合翻译**中添加至少两个已配置好的服务（不可嵌套），选择调度策略并设置单成员等待时间（默认 12 秒，范围 `1–45` 秒）：

- **轮流**：按列表顺序轮换首选，失败自动试下一成员。
- **随机**：每次随机打乱顺序并按序回退。
- **智能**：优先近期成功率高、响应快的成员（仅衡量连通效率，不评判译文质量）。

::: note 注意费用与数据范围
失败回退会把同一段原文发送给备用成员并消耗对应额度；请结合数据政策与费用谨慎组合。
:::

### 多 API Key 轮换 {#使用多个-api-key}

在服务的**密钥管理**开启轮换并逐行添加多个 Key（共用该服务的地址、模型与请求头）。请求自动分担，限流或鉴权失败的 Key 自动冷却降权；点击**检查连接**可逐一验证有效 Key。

<details class="guide-details">
<summary>自定义兼容接口、请求头、代理与 ACP 桥接（进阶）</summary>

### 自定义服务的 Base URL

**自定义服务 → 兼容接口**遵循 OpenAI Chat Completions 协议：

| 填写形式 | 实际请求位置 |
| --- | --- |
| `https://api.example.com` | 自动补全 `/v1/chat/completions` |
| `https://api.example.com/v1` | 自动补全 `/chat/completions` |
| 完整接口路径 / 代理地址 | 按原样请求（不自动补全，保留查询参数） |

例如 [OpenCode Zen](https://opencode.ai/docs/zen/) 填写 `https://opencode.ai/zen/v1`，模型填不带 `opencode/` 前缀的 API 模型 ID（参见 [Go 说明](https://opencode.ai/docs/go/)）。仅支持 `/responses`、`/messages` 或 Gemini 原生协议的模型不可直接填在此处。

### 自定义请求头与按域名移除 Origin / Referer

- **自定义请求头**：在**接口兼容 → 自定义请求头**填入键值均为字符串的 JSON（如 `{"X-Title": "My client"}`）；凭据级存储，不进公开分享。无需默认 Bearer 时可关闭 API Key 要求。
- **移除来源请求头**：自建接口拒绝扩展来源时，在**接口兼容 → 移除来源请求头**填入精确域名（不含协议/端口/通配符），默认仅移除 Origin，Referer 可另选。

### Gemini 代理与腾讯混元 TokenHub

- **Gemini 代理地址**：支持完整模板 `https://myproxy.example/v1beta/models/{model}:generateContent?key={key}`（请确认代理可信；无 `{key}` 时不自动附加密钥）。
- **腾讯混元连接失败**：**腾讯混元模型**已迁至腾讯云 [TokenHub 控制台](https://console.cloud.tencent.com/tokenhub/)，需匹配对应区域（国际 `tokenhub-intl.tencentmaas.com` 或华南 `tokenhub.tencentmaas.com`，密钥不互通）；**腾讯混元翻译**仍使用 SecretId / SecretKey，参见[官方说明](https://cloud.tencent.com/document/product/1823/132252)。

### 本机 Agent 的 ACP 桥接（实验性）

在仓库源码目录运行[桥接程序](https://github.com/FluentRead/FluentRead/blob/main/scripts/agent-bridge/bridge.mjs)连接已登录的 GitHub Copilot CLI 或 OpenCode：

```sh
node scripts/agent-bridge/bridge.mjs --agent=copilot
```

OpenCode 使用 `--agent=opencode`，随后在兼容接口填入终端输出的回环地址与临时令牌（请勿公开令牌）。仅支持非流式文本翻译，禁用一切文件与终端工具调用。

</details>

## ChatGPT 套餐接入状态 & 连接排查

- **ChatGPT 套餐**：当前公开版本未开放 ChatGPT 登录接入，详见[接入状态](/config/chatgpt-plan)。
- **连接失败排查**：依次核对接口路径/协议（HTTP 404 且返回网页通常是路径错误而非密钥无效）、API Key 与账号余额、区域配置，以及短句正常但长文失败时适当在[请求限制](/config/#请求限制)降低并发。反馈问题时请仅提供错误码与去敏截图，切勿发送真实密钥。
