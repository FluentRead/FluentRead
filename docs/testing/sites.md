# 真实站点与 DOM 兼容

[返回测试入口](../testing.md)。按本次改动选择下面的专项；这些条目不要求每次全部运行。

## man7 Linux 手册正文

man7 的 Linux 手册将自然语言正文、参数说明、终端会话和源码混放在 `pre` 中。翻译时按手册段落建立可恢复的正文边界，保留原来的换行、缩进和行内链接；命令会话与程序源码继续保持原文。此能力限定于经过结构核验的 man7 Linux 手册，普通网页代码块和 RFC 的格式化文本仍遵守原有保护策略。

生产 Chrome 构建后运行 `node scripts/testing/run-man7-translation-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper scripts/testing/focus-safe-browser.cjs --artifacts-dir <证据目录>`。专项在临时 Edge 第二屏后台正常窗口访问 `core.5.html`，逐段检查 DESCRIPTION 前后正文、参数说明、NOTES 和 EXAMPLES 的说明，验证悬浮与全文翻译—恢复—再次翻译、链接及代码保留，以及恢复后原文 HTML。默认翻译响应受控；在线供应商须另用 `--online` 验证并单独记录，Chrome 构建通过不代表 Firefox 运行验收。

## Hugging Face Spaces 内嵌正文

扩展通过受限子 frame 入口翻译 Hugging Face Space 的 `*.hf.space` 应用正文，复用顶层全文会话、恢复原文和子 frame 快捷键；从 Hugging Face 其他页面软导航进入 Space 也会建立会话。后台核验浏览器提供的顶层 URL、子 frame URL 和 frameId，仅允许 Space 标识与应用子域精确配对。当前支持名称由英文字母、数字及单连字符组成的标准 Space 地址；含点、下划线或自定义域名的映射尚未覆盖。

`pnpm test tests/issue146EmbeddedFrames.test.ts tests/supportedFrameEntrypoint.test.ts tests/qqMailFrameRuntime.test.ts tests/qqMailFrameSession.test.ts tests/extensionManifestContract.test.ts` 验证 URL 配对、命令授权、SPA 进入/退出、会话同步与清理。生产 Chrome 构建后运行 `node scripts/testing/run-huggingface-frame-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper scripts/testing/focus-safe-browser.cjs --artifacts-dir <证据目录>`，在第二屏临时 Edge 后台正常窗口验证翻译—恢复—再次翻译、frame 快捷键、动态正文、晚加载 frame、来源拒绝和唯一顶层浮球，并保存 DOM 与截图。网页响应与翻译传输受控；实站、在线供应商和 Firefox 运行证据须单独记录。

## 网站规则与连续导航

`pnpm test tests/contentFeatureLifecycle.test.ts tests/contentRuntimeLifecycle.test.ts tests/fullPageVisibilityScheduling.test.ts tests/popupPageActionsOwnership.test.ts tests/popupAppLifecycle.test.ts tests/popupChildOwnership.test.ts tests/siteRules.test.ts` 覆盖始终翻译的新页面意图、普通锚点与 HashRouter、非必要 UI 挂载等待、跨路由取消重试、无需变更结果失效，以及规则写入前的标签页复验、后台确认、保存失败和禁用中断翻译。

生产构建后运行定向浏览器专项：

```sh
node scripts/testing/run-site-rules-navigation-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <捆绑 Node 包目录> \
  --artifacts-dir <本次证据目录>
```

专项使用临时 Edge profile、第二屏后台正常窗口和焦点监控。页面和翻译 HTTP 响应为本地夹具，验证普通链接、跨站进出、push/replace/popstate、HashRouter、延迟正文和快速跳转，检查恢复原文后的同页保持与新文章自动触发、在途禁用与迟到响应、规则保存后立即关闭重开、最后写入胜出和配置跨页同步。DOM、请求计数、截图、保存响应和焦点信息保存在 `report.json`。它不代表外部翻译服务、原生工具栏 Popup、Firefox 实机或浏览器往返缓存的验收；真实网页结果需单独记录。

追加 `--producthunt` 会访问 Product Hunt 首页和 Reso 产品页，用实际链接检查正文适配切换后的自动翻译。翻译响应仍来自本地测试服务；站点防护或链接不可用会单独记录为隔离结果，不计入通过项。

仅补测在途禁用可追加 `--disable-inflight-only`，默认完整范围保持不变。该原有用例用本地 provider 响应闸门替代固定等待：确认当前正文请求已到达但尚未响应，点击禁用并立即关闭 Popup，核对持久化确认与请求取消，重开检查已禁用且保存已结束，最后释放响应并断言译文不回插、不新增请求。单项报告记录完整时序及资源锁配置，不能把一次固定延迟结束后的原文状态当作请求取消证据。

网站规则 CPU 对照可运行 `node scripts/testing/run-resource-safe.mjs --concurrency 1 -- node scripts/testing/benchmark-site-rules.mjs <明确的旧版本提交> <输出JSON路径>`。脚本用同一依赖编译旧/新 domain 模块，分别记录域名解析工作量与七轮交替计时，覆盖空、小、大名单、首次建索引、热查询、同值和真实配置修改、混合路线。输出保留源文件散列、语义比较、全部样本和初始化成本；低于计时下限不计算速度比例。配置通知仍 O(N) 比较，数据仅限本地 Node CPU，不代表 DOM、网络或用户端到端延迟。本轮范围与对照见 [网站规则性能复验](../reports/site-rules-navigation-20261011/performance.md)。

## 翻译核心稳定性回归

`tests/translateApiPerformance.test.ts` 通过实际客户端与受控页面上下文 gate，验证单条、批量和视频在 gate 未放行时随调用信号结束等待、另一调用继续、迟到成功/失败被消费，以及 signal 监听清理、同轮 settle/abort 和提取入口内同步取消。未取消的提取失败保留原错误；同轮失败尚未被观察而调用已取消时返回既有 AbortError。原显式上下文 trim/4,000 字符、禁用、不支持服务与无 signal 路径保留；无 signal 的全局取消和仅 queueSession 取消不在即时等待承诺内。`tests/pageContextDefuddle.test.ts` 继续验证共享提取、敏感节点清洗、SPA 代次和失败回退，`tests/translateQueue.test.ts` 验证实际传输结束前仍持有租约。同步 DOM 捕获或解析不能抢占中止，不据此宣称堆内存或真实设备耗时改善。

OpenRouter 模型卡片曾在解除内部两行截断后仍保持外层 `height:176px`，使居中的双语内容覆盖相邻卡片。`translationHeightLayout.test.ts` 检查插入后由内向外测量、共享高度租约、宿主样式更新、窗口 resize、滚动/定位边界和移除清理；`translationTruncation.test.ts` 检查几何判断与安全边界。

Factorio 模组列表的描述同时使用 `-webkit-line-clamp`、`height:4em` 与 `overflow:hidden`。旧逻辑虽已创建译文节点，却只解除行数限制，长描述的中文仍被固定高度裁掉。`translationTruncation.test.ts` 覆盖 owner 自身的高度租约、重复布局复核和恢复原样式；Issue #209 的实时页面专项只检查前三条描述的全文翻译、恢复与再次翻译，并以截图核对译文可见性。

内置 OpenRouter 规则按模型标题节点跳过名称与详情页 API 标识，避免在双语结果中重复名称。`translationCore.test.ts` 覆盖供应商列表、模型列表、详情页、祖先快照与域名边界，同一模型链接下的介绍仍可翻译。

生产扩展的确定性布局回归使用真实 Control / Alt+T、临时 Edge profile 和后台窗口：

```bash
node scripts/testing/run-fixed-height-translation-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <工作区 Node.js 包目录> \
  --focus-safe-helper <浏览器测试技能>/scripts/focus-safe-browser.cjs \
  --artifacts-dir /private/tmp/fluentread-fixed-height --background
```

它检查卡片实际内容边界而非仅检查卡片壳，覆盖翻译、恢复、再次翻译、共用卡片、宿主高度改写及独立滚动区域。页面和翻译响应均为本地夹具，不能代替真实网站或翻译服务的验证。高度覆盖在仍有译文时共享保留，避免在“解除高度后无溢出”与“恢复高度后再次溢出”之间反复切换；最后一个译文移除时恢复宿主样式。

### 连续滚动中的阅读等待

```bash
node scripts/testing/run-reading-wait-priority-test.cjs \
  --phase optimized --iterations 3 --delay-ms 180 \
  --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> \
  --focus-safe-helper scripts/testing/focus-safe-browser.cjs \
  --artifacts-dir /private/tmp/fluentread-reading-wait-optimized
```

专项使用生产扩展、临时 Edge profile 和第二屏后台可见窗口，在同一材料和本地微软 HTTP 响应下记录首屏与连续滚动的首次可读、逐帧实际视口完成时间、HTTP 请求数、文本槽数及至少 50ms 的长任务。首次可读要求译文自身进入视口；视口完成要求当帧所有可见候选的译文 DOM 就绪，部分可见段落也计入。指定三个阅读锚点另记完成时间，并检查它们始终可见。80 段视口模式重复三次，1000 段整页模式另测一次；滚动每 80ms 前进 3px，持续至少 1600ms。请求计数固定观察首屏 800ms、滚动 2600ms，包含已有的独立标题翻译；正文并发以一槽候选计数，不能把合批 HTTP 数等同于候选并发。

`--phase baseline --extension-dir <同一基础提交的冻结生产包> --measurements-only` 复现旧版等待滚动结束后才请求的行为；`--measurements-only` 和 `--lifecycle-only` 可限定范围，后者可追加 `--lifecycle-case failure-retry` 等单项。完整新版专项还检查并发占满、在途恢复和重译、全局关闭、恢复后切换目标语言、动态 DOM、失败重试、导航清理和悬浮翻译—恢复—再次翻译。既有会话冻结调用时配置，目标语言变更由下一次调用采用。

相关定向测试为 `fullPagePriority`、`fullPageVisibilityScheduling`、`fullPageTranslationIndicators`、`viewportStability`、`translateQueue`、`translationRequestScheduler`、`fullPageFailureRecovery` 与 `hoverTranslationScheduler`。对比结论见[阅读等待优化报告](../reports/reading-wait-priority-20261011.md)。本地响应只验证插件调度与 DOM 可读性，不证明在线服务延迟、语义质量、任意网站或 Firefox 实机表现。

### Hacker News 与 Product Hunt 翻译滚动

`tests/browser-translation-cases.json` 的 `hacker-news-home` 与
`producthunt-posting-access` 分别覆盖实时首页标题列表和用户指定的帮助文章，均支持
悬浮、全文模式。Hacker News 原有的讨论页用例继续保留。

`producthunt-home` 直接覆盖产品首页的介绍 span、产品名称、页脚、搜索及 Cookie 提示保护，
与帮助中心文章是独立用例；遇到 Cloudflare 时按 quarantine 记录站点限制。
实时投票数字会由网站更新，投票保护由固定夹具与专项浏览器验证检查，不用数字是否变化判断翻译污染。
`site-adaptation-fixtures.json` 的 `product-hunt` 与 established 夹具的
`hacker-news` 使用生产规则验证正文、代码和身份操作边界。
`siteAdaptationCatalog.test.ts` 与 `translationCore.test.ts` 检查悬浮/全文候选一致、
多段评论不合并、动态重建和 HN 阅读页回退。性能对比应另外报告候选数、扫描步骤、
最大源快照长度及真实浏览器长任务，不能把减少无效候选称为端到端翻译提速。

可见段落插入译文时，下方内容正常展开，不应主动滚动页面来抵消展开高度。只有变化
完全发生在同一滚动容器的视口上方时才做阅读位置补偿；页首保持页首，整页恢复优先
保护视口上沿。`viewportStability.test.ts` 和 `fullPageVisibilityScheduling.test.ts`
覆盖页首、可见/部分可见/屏外段落、嵌套容器、文本节点及整页恢复。

```bash
node scripts/testing/run-translation-viewport-test.cjs --allow-network \
  --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> \
  --focus-safe-helper <focus-safe-browser.cjs路径> \
  --artifacts-dir /private/tmp/fluentread-translation-viewport
```

脚本使用真实网站 HTML/CSS、生产扩展和固定延迟的本地微软响应，在第二屏临时后台
Edge 中执行两站点 × 两入口 × 页首/中部 × 翻译/恢复/再次翻译。它记录逐帧滚动值、
原文位置、各脚本执行上下文的 `scrollBy` 调用栈与截图；检查译文唯一性、搜索/反馈
控件及原文链接。追加 `--case hacker-news-home` 或 `--case producthunt-posting-access`
可缩小范围；`--expect-regression` 用于旧生产包，只执行首次翻译并要求实际复现位移。

页首与悬浮翻译要求滚动值变化不超过 1px，原文阅读锚点允许 2px 的排版误差。
中部全文翻译允许屏幕上方新增内容触发浏览器原生滚动锚定，但阅读锚点也必须保持在
2px 内，不能只用最终 `scrollY` 判断抖动。实时页面加载期间的错误单独保留在报告中；
翻译开始后的页面错误仍令测试失败。焦点保护中止的运行不计为通过。
本专项不代表 Turbo、Firefox 实机、商店安装包或在线翻译供应商的验证，也不运行
字体渲染脚本；字体冲突属于另一个独立的 DOM 生命周期问题。

### GitHub 列表译文间距

新版 PR 列表的标题旁保留带 padding 的空徽标占位符。行内标题插入块级译文后，
占位符会另起一行，使标题译文到元信息的间距达到 36px。双语标题现在使用行内块
容纳原文和译文，恢复原文时自动回到 GitHub 的布局；徽标、链接和检查按钮仍保留。
新版 PR 列表的用户名、创建/更新时间与检查状态保持原文，标题继续支持悬浮和全文翻译。

`run-github-spacing-test.cjs` 使用与实际 DOM/计算样式一致的最小本地夹具，检查空徽标、
非空徽标、新旧标题结构、普通正文、1150/360px 内容宽度、悬浮 `[1,0,1]`、全文恢复、
再次翻译、节点重挂和失败重试。报告保存像素间距、原始 DOM 恢复结果与截图。
脚本使用生产扩展、确定性微软响应和临时后台 Edge，不代表在线供应商的翻译质量。

```bash
node scripts/testing/run-github-spacing-test.cjs \
  --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> \
  --focus-safe-helper <focus-safe-browser.cjs路径> --background \
  --artifacts-dir /private/tmp/fluentread-github-spacing
```

一键浏览器回归已包含此脚本；仅在复核旧产物时追加 `--expect-regression`，它要求旧版
确实产生至少 30px 的空白及元信息译文，输出属于缺陷复现证据。

排查重复翻译、鼠标经过闪切或原文恢复异常时，先运行以下确定性测试：

```bash
pnpm exec vitest run tests/hoverTranslationContentFeature.test.ts tests/fullPageVisibilityScheduling.test.ts tests/translationStability.test.ts tests/translationState.test.ts tests/translationBroker.test.ts tests/bilingualRemount.test.ts tests/bilingualReplay.test.ts tests/syntheticRemount.test.ts
```

这些用例覆盖组合键取消后的连续移动、同值属性写入、后代保护资格变化、在途 Text 重建、分槽来源变化、共享等待者取消、双语重挂和恢复，以及仅译文槽被宿主克隆后的原文保全。新增竞态用例应证明旧实现失败，且包含用户下一次正常翻译或恢复的断言，避免用永久禁用翻译掩盖循环。

`fullPageVisibilityScheduling` 另覆盖 input 按钮的 `value/type/name` 动态变化、具名提交值恢复、迟到结果拒绝，以及宽根冷却时独立 ShadowRoot 仍可扫描。`translateQueue` 与翻译 API 用例验证排队期间取消单条请求会立即结算、移除监听且不影响同会话其他任务；已发出的真实传输仍占用并发槽直到结束。`languageTechnicalTokens` 与语言预检用例守护 Markdown 目的地括号边界，确保链接后的外语正文参与判断且供应商输入不被改写。

生产扩展中的链接与表单生命周期可单独运行：

```bash
node scripts/testing/run-target-language-reading-test.cjs \
  --cases markdown-boundary,control-lifecycle \
  --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> \
  --focus-safe-helper scripts/testing/focus-safe-browser.cjs --artifacts-dir <证据目录>
```

专项使用临时后台 Edge 与本机确定性响应，检查原始请求、翻译—恢复—再次翻译、动态标签、输入类型切换和实际 FormData 提交值。它验证生产扩展调用与 DOM 契约，不代表外部供应商质量或 Firefox 实机验收。

生产 Chrome 产物另由 `scripts/run-full-page-translation-test.cjs` 验证真实键鼠事件、DOM 工件身份、请求数及连续帧可见性。使用浏览器技能提供的 focus-safe helper 与临时 profile，窗口在第二块屏幕可见但不抢前台。报告必须区分本地确定性服务夹具和真实网站、真实翻译服务的结果。

悬浮性能与取消生命周期由独立专项验证；它使用临时后台 Edge、真实 CDP 键鼠事件和延迟 180ms 的本地微软协议响应：

```bash
node scripts/testing/run-hover-reliability-test.cjs \
  --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> \
  --focus-safe-helper scripts/testing/focus-safe-browser.cjs \
  --artifacts-dir /private/tmp/fluentread-hover-reliability
```

默认执行八组场景：开关及连续移动开销、同段停留与最后位置、在途及已译段落唯一性、离开视口、真实隐藏标签页、SPA 路由切换、宿主替换段落、显式失败重试。各组也检查原文、原生输入与链接，报告保留请求数、DOM、截图、焦点策略和扩展文件哈希。追加 `--cases dom-replacement` 可缩小复现；`--baseline` 仅用于旧产物，记录行为失败后继续采样，不能作为修复验收通过。性能对比必须使用相同脚本和夹具、相同 320 次移动，冻结两份生产包；本地 CPU 采样不能推广为所有网站或供应商的加速比例。

“识别全部节点”的专项由 `scripts/run-all-nodes-translation-test.cjs` 负责。它在生产扩展的“高级选项 → 页面识别”中操作真实开关，关闭并重新打开设置页确认保存，再通过原有全文翻译入口验证范围。设置从下一次翻译起生效；存量会话保持自己的范围快照，恢复后再次翻译才使用新值。

本地夹具覆盖导航与页脚、工作流工具栏、项目树与标签页、展开内容与动态菜单，以及输入框、编辑器、代码和显式排除区域。断言包含默认正文范围、开启全部节点、动态新增、恢复和再次翻译，以及关闭后回到默认范围，并检查元素身份、原有点击事件和保护内容不进入翻译请求。追加 `--live-epoch --allow-network` 会在真实 Epoch 页面验证导航、图表控件和页脚；两者都使用本地确定性翻译服务，结果用于验证翻译行为，不代表真实供应商的译文质量。

```bash
node scripts/run-all-nodes-translation-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <bundled-node-packages> \
  --focus-safe-helper <browser-translation-test-skill>/scripts/focus-safe-browser.cjs \
  --background \
  --artifacts-dir /private/tmp/fluentread-all-nodes \
  --live-epoch --allow-network
```

GitHub PR 提交列表中的链接焦点管理，以及其他网站的相同 DOM 行为，由专项浏览器回归验证：

```bash
node scripts/testing/run-translation-mutation-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <path> \
  --focus-safe-helper <path> \
  --artifacts-dir /private/tmp/fluentread-translation-mutation
```

该回归检查宿主为新增链接写入 `tabindex=-1/0` 时保持同一个译文节点，避免把键盘焦点管理误判为内容损坏；正文、链接目的地或隐藏状态变化仍由确定性测试验证失效行为。仅译文模式还检查相邻 DOM 更新不会因原文位于扩展槽内而撤销翻译。固定高度按钮覆盖嵌套 flex/grid 标签、文字边界、点击与“翻译—恢复—再次翻译”，使用确定性翻译服务排除网络响应波动；真实 GitHub 页面结果需单独记录，不能以本地夹具代替。表单内的具名 submit 与用户输入框属于非候选控件，按完整 `outerHTML` 比对翻译前后与恢复原文，确保布局租约不在同层控件上留下属性残留。此类断言要求证据截图保持非侵入：已核对的本地 Playwright 实现默认以 `caret: 'hide'` 给每个 `input`/`textarea`/`[contenteditable]` 写入 `caret-color` 再以空值清除，在原无样式的宿主控件上留下空 `style` 属性，因此浏览器回归截图使用 `caret: 'initial'`。真实站点脚本导出 `captureEvidence` 供证据脚本复用，Reddit 专项的成功与失败截图遵循同一参数；严格 DOM、源节点身份、恢复和原始运行时诊断门禁保持不变。

### Reddit 多翻译器共存与搜索结果

普通 `shreddit-comment` 的 `slot="comment"` 和 `*-comment-rtjson-content` 正文同时发现段落、列表、引用、六级标题和表格单元格；全文与悬浮共享这些明确的正文边界。列表、引用和单元格及其内嵌的普通 `div` 允许内部独立正文拥有各自的译文，子块前后的直接文字也分别保留，避免多个段落被拼接、遗漏或重复翻译。评论作者、正文外的近似标记、代码、编辑器和操作按钮继续保留原文。`translationCore.test.ts` 与 `translationSnapshotProtection.test.ts` 核对完整候选、混合文本、段落边界、链接和源节点身份、重复翻译恢复，以及正文标记失效和动态新增。标题与表格是 [Reddit 官方格式指南](https://support.reddithelp.com/hc/en-us/articles/360043033952-Formatting-Guide) 支持的正文格式；原创结构夹具不等同于当前实站验收。

页面 HTML 曾同时包含外部译文的 font 容器与 FluentRead 双语 wrapper。旧快照把前者作为受保护原文复制，净化后丢失其标记，形成第三份译文。`translationCore.test.ts` 覆盖该结构的候选边界、快照省略与普通术语/代码保留。

生产扩展回归使用本地最小结构夹具，不执行用户粘贴的脚本，也不访问外部翻译服务：

```bash
node scripts/testing/run-reddit-translation-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <工作区依赖中的 Node.js 包目录> \
  --focus-safe-helper <浏览器测试技能>/scripts/focus-safe-browser.cjs \
  --background --artifacts-dir /private/tmp/fluentread-reddit-coexistence
```

同时检查正文与全部节点范围、悬浮 `[1,0,1]`、全文翻译与恢复、外部译文在请求前/途中/完成后出现、移除外部译文后重新翻译，以及外部 DOM 身份和 URL 保持不变。真实 Reddit 如果返回人机验证页，应单独记录为站点限制，不能把本地结构测试表述为真实帖子验证。

Reddit 搜索结果沿用内置 focus 规则，补充 SDUI 的 `post-title-text` 标题与 `search-comment-content` 评论正文，不依赖 `shreddit` 标签。标题作为完整单元；评论内的段落、列表和引用分别发现，纯文本评论也能翻译。搜索框、导航、作者、时间和投票/分享/回复按钮继续受保护。

issue #1000 的 `reddit-search.html` 是依据报告选择器独立编写的最小结构夹具，并非实站快照。上述命令追加 `--search-only`，只运行全站 `/search/` 与社区 `/r/.../search/` 的搜索专项，覆盖 focus 正文范围、标题与评论悬浮 `[1,0,1]`、全文翻译、动态新增和移除结果、恢复后再翻译、链接与按钮节点身份和点击行为。`translationCore.test.ts` 同时检查候选发现与悬浮解析一致，以及 `data-testid` 被移除和恢复后的目标复验。

issue #1017 的 `reddit-profile.html` 同样依据报告的 DOM 结构独立编写，覆盖 `shreddit-profile-comment` 评论卡片、父帖标题，以及空前缀和带前缀的 `-post-rtjson-content` 正文。上述命令追加 `--profile-only`，只运行用户主页概览、帖子和评论路径，验证标题与正文悬浮 `[1,0,1]`、全文翻译、动态卡片增删、恢复后再翻译及导航/元数据/代码保护；默认命令也包含此专项。`translationCore.test.ts` 验证结构化段落与纯文本正文的发现、悬浮解析和目标失效复验。夹具和受控响应不代表 Reddit 实站可访问或在线供应商验收。

额外追加 `--live-search` 才会访问真实公开搜索页；翻译仍使用本地确定性微软响应。报告将 HTTP 状态、搜索目标数、实际翻译数和站点限制单独记录，真实页面不可访问时不算实站验证通过，也不代表在线供应商的翻译质量。

### GitHub Latest 仅译文反复翻译

仓库首页的 Latest 使用 flex 布局，自有原文槽会作为 flex 子项被计算为 block。候选范围复验必须把已验证原文槽视为透明包装，不能因此把原标签排除出正文范围。`translationStability.test.ts` 覆盖 flex/grid 下的重复复验、恢复后再次翻译，以及真实新增正文块、原文修改、禁译和同字克隆的拒绝边界。验收同时检查仓库首页和下述 Release 详情页；首页译文应保持同一槽节点，其他页面变化不应导致它反复撤销。

仅译文将原文搬入自有槽时，必须同时识别原父节点的移除记录与槽内加入记录，避免合成正文段把自身渲染误判为外部变化、撤销译文并重复请求。`translationStability.test.ts` 覆盖 Latest 标签结构、同字不同节点、混合增删、真实原文修改和槽被移除；来源校验仍须保留。

手动验收使用仅译文及 AI 网页语境设置：翻译 GitHub Release 页，待首轮完成后停留至少 30 秒，确认 Latest 不闪烁且翻译次数不再持续增加；再恢复原文、重新翻译，并确认页面新增或修改的正文仍可正常翻译。

## Firefox 共享 DOM 运行时

`tests/firefoxDocumentRuntime.test.ts` 验证 Firefox 后台 iframe 只承载同一个 DOM 页面，功能请求仍经过共享客户端与路由；覆盖按需创建、并发复用、接收端丢失重建、取消及页面资源清理。能力测试分别检查原生 Offscreen 权限与可执行 DOM 能力，Firefox MV2 开启图片/区域/本地字幕与扩展朗读，Chrome Translator 保持禁用。

`pnpm verify:extension-manifests` 要求两个目标都包含共享 DOM 页面和 OCR core/worker，Firefox 不声明 `offscreen` 权限。`--require-firefox-archives` 还检查 Firefox 扩展 ZIP 和源码 ZIP 中的相关资源。单元测试与构建不能替代 Firefox 中的真实 OCR、截图、字幕推理和音频播放验证。

### Codeforces 公式与倒计时

`tests/translationCore.test.ts` 验证命名输入控件遮蔽 `form.tagName` 时整页扫描仍能到达题面；`tests/translationTruncation.test.ts` 覆盖 MathJax v2 的 `nobr` 可视排版、辅助 MathML 去重和原始公式恢复；`tests/selectionTranslatorCore.test.ts` 覆盖正文跨公式选区与控件保护；`tests/siteAdaptationCore.test.ts` 验证 `.countdown` 不进入请求和译文快照，比赛状态文本仍可翻译。

```bash
node scripts/testing/run-codeforces-translation-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <工作区 Node.js 包目录> \
  --focus-safe-helper <浏览器测试技能>/scripts/focus-safe-browser.cjs \
  --artifacts-dir /private/tmp/fluentread-codeforces --live
```

该脚本使用隔离临时 Edge、第二屏后台窗口及本地确定性微软响应，检查默认全文和悬浮的翻译—恢复—再次翻译、公式重排、小点与 Control 划词入口。倒计时夹具连续更新 12 次，断言三个独立文字译文的节点身份不变、零额外请求、卡片高度不变；比赛状态变化仍触发正常更新。`--live` 追加 issue #492 的 Codeforces 实际题面，以及首页倒计时 12 秒的节点稳定性检查，省略时仅运行本地夹具。真实页面与确定性翻译响应的组合不代表真实供应商译文质量。

划词与翻译卡片在中文目标下共同跳过纯汉字选区（包括短词、简繁汉字、数字、标点和表情），不显示入口或占用快捷键。外语目标和含外语的选区保持可用；该规则只用于选区交互，不改变全文语言检测。`chineseLanguage` 与 `contentHotkeyRuntime` 覆盖该边界。

默认运行 `scripts/run-selection-trigger-test.cjs` 时，Popup 快捷抽屉只切换关闭、双语显示和仅译文；触发方式、显示延迟和自定义快捷键在同时打开的完整设置页修改，并断言设置页、Popup 预览、存储配置与网页中的真实划词手势一致。主矩阵固定使用本地夹具拦截的微软翻译，避免默认免费翻译均衡到真实公开接口。

使用 `scripts/run-selection-trigger-test.cjs --chinese-only` 配合原有隔离浏览器参数可验证纯中文的图标、小点、直接弹出、划词快捷键和翻译卡片点击/悬停/快捷键入口，并检查选区替换、目标切换及混排恢复。微软返回值使用本地响应夹具；翻译卡片验证入口，不调用真实 AI 模型。

## Kagi News 内容型标题按钮（issue #1045）

生产 Chrome 构建后，运行 `node scripts/testing/run-kagi-headline-translation-test.cjs --allow-network --extension-dir .output/chrome-mv3 --playwright-root <工作区 Node.js 包目录> --artifacts-dir /private/tmp/fluentread-kagi-headlines`。可用 `--focus-safe-helper` 指定等价的焦点安全 helper，默认使用仓库版本。

专项创建临时 Edge profile 与第二屏后台可见窗口，先检查 Kagi 原生展开/收起以确认页面水合，再验证正文/全部节点范围的双语标题、普通按钮原位替换、上下排版、点击与 Enter/空格、动态插入、仅译文闭合 Shadow 文本、恢复重译、Control 悬浮切换和真实分类切换。DOM、截图和报告写入证据目录；结束后关闭本次浏览器并删除临时 profile。翻译使用确定性微软响应，仅证明真实站点 DOM 与生产扩展的兼容性，不代表在线供应商质量或 Firefox 实机验收。


