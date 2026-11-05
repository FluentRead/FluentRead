# 供应商、术语与请求上下文

AI 页面摘要缓存只保存共享摘要，按版本与旧的“摘要加全文”缓存隔离。每次翻译按当前原文补充少量直接命中的原始片段和页面元数据，成功摘要的参考预算最多 1600 字符；篇章证据继续遵守原有总预算。摘要失败保留原始上下文回退。`pageContextPolicy` 与 `translationBroker` 验证相关事实、不同原文的摘要复用、失败回退、泄漏重译和清库/取消边界。

[返回测试入口](../testing.md)。按本次改动选择下面的专项；这些条目不要求每次全部运行。

## 自定义服务 Base URL（issue #626）

`tests/aiSdkEndpoints.test.ts`、`tests/aiSdkErrors.test.ts` 和 `tests/aiSdkOpenAICompatible.test.ts` 覆盖标准 Base URL 补全、完整及非标准路径、代理优先级、查询参数、HTML 错误提示，以及真实 SDK 的请求体和鉴权传递。

生产扩展构建后运行 `node scripts/testing/run-custom-base-url-ui-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-issue626-ui`。专项使用临时 Edge profile、第二屏后台窗口和本地 HTTP 夹具，检查 Zen/Go 形状的 Base URL、根地址、完整和非标准接口、关闭重开后的配置、HTML 404 与手动重试，以及 390px 对话框。报告记录实际路径、模型和鉴权断言，不记录密钥。它证明扩展请求链路，不代表真实 OpenCode 账号、模型可用性或 Firefox 运行时验证。

## 谷歌合批、请求节奏与限流恢复

```bash
pnpm test tests/google.test.ts tests/googleRequestGate.test.ts tests/googleBackoffIntegration.test.ts tests/translateApiPerformance.test.ts tests/free-translation.test.ts tests/freeBalancedRouting.test.ts
```

Google 专项覆盖 120 毫秒收集窗口、32 段与 10,000 个 HTML 转义字符边界、满批立即发送、显式大数组及时启动，以及不跨调用所有权的免费池数组传输。合批的字符预算包含 `pre` 包装开销；超长单条独立处理，不在适配层任意拆分。纯文本转义、换行、译文槽数量、RPC 乱序还原和一个调用者取消不影响其他调用者继续参与回归。

`googleRequestGate` 用受控时钟验证四条 Google 入口共享实际 HTTP 请求节奏：最多 2 个在途请求、启动至少间隔 200 毫秒，取消或超时后释放排队与在途所有权。任一入口收到 429 时，全部入口共同等待 `Retry-After` 的秒数或日期；无有效等待提示时按 1、2、4 秒逐步退避，最长 60 秒。到期只允许一个恢复请求，成功才解冻队列；较早的在途成功不能抹掉较新的限流状态。合批、请求排队、退避和回退均纳入调用开始后的 8 秒总预算，等待不能装入预算时返回携带安全等待信息的 429，供免费池切换服务。403/XSRF 拒绝仍按单入口冷却，服务故障继续走有界回退；外层不重跑 Google 整条回退链。

生产扩展构建后运行定向浏览器专项：

```bash
node scripts/testing/run-google-backoff-browser-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <工作区 Node.js 包目录> \
  --focus-safe-helper scripts/testing/focus-safe-browser.cjs \
  --artifacts-dir /private/tmp/fluentread-google-backoff
```

专项使用临时 Edge profile、第二屏后台正常窗口和真实配置端口，在后台 service worker 的 `fetch` 边界记录请求时间、入口、批次大小和取消；`BrowserContext.route` 不能代替 MV3 后台请求的拦截。受控响应检查 12 个错开到达的段落合批、429 等待期间没有提前访问其他入口、恢复后的请求节奏、503 回退，以及排队调用者取消后不发 HTTP 且保留另一调用者的恢复。真实 Control 与 Alt+T 验证悬浮和全文的翻译、恢复、再次翻译、相邻段落边界、原始 DOM 恢复及无重复译文或重试占位。报告写明启动方式、焦点策略、窗口位置及证据目录。

本轮借鉴了[简约翻译的批量配置](https://github.com/fishjar/kiss-translator/blob/master/src/config/api.js)中延长合并窗口、提高每包字符容量的思路，以及 [Read Frog 请求队列](https://github.com/mengxi-ream/read-frog/blob/e3cbe2b7c669c875dbf1b050254da9b628daefe1/src/utils/request/request-queue.ts#L347-L366)暂停队列与恢复时限制突发的设计。在 FluentRead 的 WXT/Vue/TypeScript 服务边界内独立实现，没有复制成段代码或添加参考仓库依赖；使用独立探测锁，保证恢复请求完成前不启动第二个探测。确定性测试和浏览器响应夹具证明请求调度与交互，不证明 Google 在线额度变大；真实服务少量成功也不代表长页面、持续滚动、多标签页、其他地区或语言均不会限流。

## 术语库回归

术语库的本地解析、三态选库、配置迁移、冻结版本、缓存身份、消息来源和 provider 协议先由确定性测试验证：

```bash
pnpm exec vitest run tests/glossary.test.ts tests/builtinGlossaries.test.ts tests/glossaryConfig.test.ts tests/glossarySettingsComponent.test.ts tests/translationGlossaryIntegration.test.ts tests/imageGlossaryContext.test.ts
```

仅验证导入弹窗和圈选失败恢复时，可使用 `scripts/testing/run-import-recovery-ui-test.cjs`，显式传入 `--suite glossary` 或 `--suite area`，以及 `--artifacts-dir` 和 `--runtime-diagnostics-helper`。前者验证文件与粘贴草稿、三条预览、警告确认、持久化和响应式；后者用真实截图及本机 HTTP 夹具验证错误主动作和恢复，不证明线上模型质量或语言包公网下载。两者都使用第二屏后台临时 Edge，并保存运行时错误、告警与采集缺口。

统一弹窗和其他翻译失败提示使用 `scripts/testing/run-dialog-recovery-ui-test.cjs`，显式指定 `--suite backup`、`--suite dialogs` 或 `--suite translation`，并传入相同的产物、证据目录和诊断参数。分别覆盖原生下载与取消、恢复摘要和持久化，WebDAV/历史/敏感配置/服务弹窗，以及划词重试和图片缺包提示。网络只用本机夹具；划词的故意鉴权失败保留原始诊断，按本次用例、精确消息和次数标记预期。

仅修改术语库管理界面时，使用 `--suite ui` 运行专项，不进入网页或文档翻译链路：

```bash
node scripts/run-glossary-test.cjs --suite ui \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <path> \
  --focus-safe-helper <path> \
  --artifacts-dir /private/tmp/fluentread-glossary-ui
```

专项验证直达的新建、导入与匹配预览入口，空词库及已有词条的设置展开、键盘操作、重复切换和逐帧宽高稳定性，多词库草稿、排序、导入导出、取消删除、重载及快速关闭持久化，以及四种屏宽、深色主题和英文布局。使用临时 Edge profile 与第二块屏幕上的后台可见窗口，不抢占用户焦点；报告包含布局、展开状态采样、控制台错误与截图。

需要验证真实设置与翻译链路时运行以下术语库全链路专项；`--browser` 一键计划也会自动包含此脚本：

```bash
node scripts/run-glossary-test.cjs --suite full \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <path> \
  --browser-path <path> \
  --focus-safe-helper <path> \
  --artifacts-dir /private/tmp/fluentread-glossary-browser
```

该脚本使用临时 profile 和本机 loopback OpenAI 兼容服务，不读取日常浏览器配置或真实密钥。它验证五套内置词库的真实词条预览、添加、来源版本持久化、删除重加和总开关；同时验证词库编辑、范围预览、导入、真实 CSV 下载后文件回导的语言无损、重载持久化、Control 悬浮及 Alt+T 全文的“翻译—恢复—再次翻译”、命中缓存与修改术语后失效、只发送命中词条，以及文档显式禁用和指定词库、跨页面保存、快速关闭、连续更新、深色与窄屏。报告与截图保存在指定目录；一键计划下使用 `<artifacts-dir>/glossary`。

术语脚本固定使用 focus-safe 后台启动，即使一键入口显式传入 `--headed` 也不转为前台；目前使用脚本内的超时设置，不接收一键入口的 `--timeout`。本机服务回显约束只能证明 FluentRead 请求与交互链路，不代表外部 AI 模型遵守术语的准确率；Qwen-MT 原生 `terms`、摘要跳过及不支持服务不改译文另由确定性协议测试覆盖。

视频字幕设置中的术语库与相邻设置统一为左侧标题和状态说明、右侧下拉控件；窄屏自动上下排列。视觉复核应覆盖跟随全局、不使用、指定多个词库、视频关闭后的禁用状态，以及服务不支持时的提示。文档翻译和快捷方案仍保留原生选择器，三态选库与配置保存行为共用。

## 自定义请求头回归（issue #522）

```bash
node scripts/testing/run-custom-headers-ui-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <playwright-node-modules> \
  --focus-safe-helper <fluentread-extension-ui-test-skill>/scripts/focus-safe-browser.cjs \
  --artifacts-dir /private/tmp/fluentread-custom-headers-ui
```

使用临时 Edge profile、不抢焦点的可见窗口和本地 HTTP 模拟模型，验证自定义服务的请求头保存、关闭重开、稳定会话 ID、服务隔离、非法输入阻断、清空恢复及窄屏布局。报告包含实际收到的测试请求和截图；测试只使用虚构凭据，不验证 OpenCode Go 或其他真实服务账号。配置加密、完整备份、公开导出脱敏、端点绑定和缓存快照由确定性测试覆盖。

### 本机 ACP 桥接（issue #227）

`pnpm test:agent-bridge` 使用随机本机端口和模拟 ACP 子进程，验证 Chat Completions 到 ACP 的协议转换、OpenAI 兼容 SDK 解析、独立会话、模型选择、令牌与扩展来源检查、权限拒绝以及工具调用后的恢复。它不调用真实 Copilot/OpenCode 账号，不证明供应商额度或 CLI 版本兼容性；这些需要在用户已登录相应 CLI 的环境中另行确认。

## 单篇篇章参考

### AI 多段请求合并

生产 Chrome 构建后，运行 `node scripts/testing/run-ai-multi-segment-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <工作区 Node.js 包目录> --focus-safe-helper scripts/testing/focus-safe-browser.cjs --artifacts-dir /private/tmp/fluentread-ai-multi-segment`。

专项在临时 Edge profile、第二屏后台可见窗口中，验证四个相邻纯文本/富文本段落实际形成一次包含四段来源的模型请求，并按 DOM 顺序回填；覆盖 AI 精翻开启和关闭、请求并发为 1 和 2、全文翻译—恢复—再次翻译、悬浮保持单段、关闭多段、动态新增内容、取消后的迟到响应与重新翻译。默认八段短文本应形成一次请求；自定义 4 / 16 / 32 片段上限和原文字符预算须按实际来源分组生效，超预算单候选独立完整传输，不能截断。候选准备须允许收集配置的一批相邻片段，实际请求仍遵守配置的并发限制。新增设置仅在开关开启后显示，验证编辑、关闭重开、关闭保留、恢复默认、快速关闭后的最新值持久化以及窄屏布局。报告保存请求来源分组、DOM 断言、截图和原生焦点事件；导航前开始采集内容脚本隔离世界、扩展页面和后台的错误与告警，测试结束保存诊断并删除自建 profile。响应来自虚构 DeepSeek 端点的确定性夹具，不读取用户密钥，也不代表真实供应商质量或 Firefox 实机验收。

### 短标题跨语言上下文误译（issue #980）

```bash
<bundled-node> scripts/testing/run-ai-context-leak-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <bundled-node-packages> \
  --focus-safe-helper scripts/testing/focus-safe-browser.cjs \
  --artifacts-dir /private/tmp/fluentread-ai-context-leak
```

专项用 Prompts 英文标题及正文模拟短标题返回约 157 字中文页面介绍，核对一次无页面上下文/摘要重译、同批正常正文保留、悬浮与全文翻译—恢复—再次翻译、仅修复结果进入缓存、持续明确回显失败，以及关闭 AI 精翻后的单次直接翻译。检测器将 1–40 个 Unicode codepoint 的短来源、至少 `max(120, sourceLength × 6)` 个 codepoint 的结果作为保守重试信号；再次返回的合法长译文不会仅凭长度被拒绝。核心和 broker 专项同时覆盖阈值、匹配边界、取消与缓存版本隔离。

测试使用生产扩展、临时 Edge profile、第二屏正常尺寸后台窗口与真实 CDP 手势；原生 macOS 激活事件核对浏览器从未成为前台。DeepSeek Chat Completions 响应在本次临时配置中拦截，端点及凭据均为虚构，不读取用户 API Key，不证明真实 DeepSeek 的翻译质量或报告者现场已恢复。报告保存 DOM 断言结果、请求摘要、缓存结果、截图与焦点证据。

生产 Chrome 构建完成后运行以下独立网页套件：

```bash
<bundled-node> scripts/testing/run-discourse-context-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <bundled-node-packages> \
  --focus-safe-helper scripts/testing/focus-safe-browser.cjs \
  --artifacts-dir /private/tmp/fluentread-discourse-context
```

套件使用临时 Edge profile、第二屏后台可见窗口和真实 `Control` 手势，验证首 2,000 字符之后的定义、同缩写换义、正文更新、取消、SPA 材料切换、恢复后重译、深处嵌套布局以及普通锚点跳转中的已译与在途证据。生产客户端、broker、provider 和 DOM 挂载使用真实产物；本机确定性 OpenAI 响应验证传输与生命周期，不能证明模型语言质量。报告记录请求、预算、前台 PID 核对、DOM 与截图，最终关闭仅属于本次运行的浏览器。

`discourseContext` 与 `pageDiscourseContext` 专项守护来源位置、有界焦点窗口、原文版本、迟到提交、章节含义与确认译法优先级，并纳入严格四维覆盖率。`documentTranslationApi` 与 `documentAppLifecycle` 验证同章去重、跨章隔离、页码与章节标签、会话确认译文和重译清理；broker/template 与既有请求、状态测试守护上下文默认关闭、摘要复用和缓存隔离。真实本地模型的原文—译文对照、token 与耗时另存于 `docs/reports/discourse-context-20261011/model-quality.json`，其中保留漏译与歧义反例；有限样本尚未建立可靠的整体质量提升，Firefox 与真实云端服务不在这次运行验收范围内。

## 按域名移除来源请求头（issue #763）

```bash
<bundled-node> scripts/testing/run-request-headers-ui-test.cjs \
  --extension-dir <task-worktree>/.output/chrome-mv3 \
  --playwright-root <bundled-node-packages> \
  --focus-safe-helper <extension-ui-skill>/scripts/focus-safe-browser.cjs \
  --artifacts-dir /private/tmp/fluentread-763-production-ui
```

使用临时 Edge profile 与不抢焦点的后台可见窗口。服务器先实际收到扩展 Origin，再验证启用名单后 Origin 消失且鉴权不变，独立 Referer 规则安装、另一域名隔离、网页原有 Origin/Referer 保留、关闭与删除恢复、设置重开与扩展重载后持久化、非法域名阻断和 820px 布局。仅使用本地模拟 OpenAI 服务及虚构凭据，不证明真实网关或 Firefox 运行行为。新配置、DNR 同步和请求等待屏障由 `requestHeaderRules.test.ts` 与 `requestHeaderRuntime.test.ts` 覆盖。

Popup 服务概览显示默认、继承和独立功能在配置中选择的模型，包含自定义模型占位符解析；统一标注“配置模型”，自定义请求体等请求规则可能覆盖最终请求模型。机器翻译行不显示模型，凭据或能力提醒仍优先。模型说明通过局部本地化 `featureServices.configuredModel` 缓存在 rows 内，aria-label 保留服务/继承说明并追加配置模型，title 保留完整模型名。`popupServiceModelClarity` 和 `popupServicesLifecycle` 的真实 Vue 模板验证继承/独立/自定义、自定义请求体覆盖时的配置模型语义、搜索不改选模，以及活跃上下文、KeepAlive/卸载、配置替换、跨功能旧事件、已删除供应商和用户焦点保护；隔离浏览器结果另行绑定源码版本，普通扩展 tab 不代替工具栏 popup 验收。

## DeepLX 默认直连（issue #968）

生产 Chrome 构建后运行 `scripts/testing/run-deeplx-direct-test.cjs`，显式提供 `--extension-dir`、`--playwright-root`、`--artifacts-dir`，并使用仓库 `scripts/testing/focus-safe-browser.cjs` 作为 `--focus-safe-helper`。默认使用临时 Edge profile、第二屏后台可见窗口与焦点监控。

确定性夹具经过真实 broker 和 core，覆盖默认直连且不请求公共端点、繁体目标、429 后公共回退、1500 UTF-16 分块、自定义地址边界、取消中止，以及真实 Control 悬浮翻译/恢复/再翻译的 `[1,0,1]` 和邻段 `[0,0,0]`。`--live` 额外只发送一句公开短文到 DeepL，公共备用端点仍用夹具；结果单独记录，不能推断长期可用性、全部语言质量或 Firefox 实机表现。实现及本次证据范围见 [DeepLX 直连验证](../maintainers/deeplx-direct-968.md)。


## 无痕专用共享翻译模型

`privateTranslation`、`privateTranslationIntegration` 和 `privateTranslationSettingsLifecycle` 验证默认关闭、不可用选择保留、仅可信 sender 隐私身份启用、独立模型快照与迟到设置事件。专用模型开关开启与关闭均验证可信无痕请求不读写共享译文或摘要缓存。集成测试经过真实 fallback、broker 和锁定 OpenAI-compatible SDK，用离线 HTTP 端口检查最终模型、连接与凭据、统计、批量、并发/缓存隔离、取消、配置变化和不可用时不回退。新增纯配置、路由及设置组件纳入严格四维覆盖；已有配置归一化、快照和 broker 仍由各自全集回归守护。功能与限制见[无痕专用翻译模型](../guide/private-translation.md)。离线通过不代表真实无痕窗口、Firefox 实机、供应商质量或独立 OCR/阅读/写作验收。
