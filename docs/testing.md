# 测试与回归

## 阅读卡深色主题（issue #574）

生产扩展构建后运行 `node scripts/run-harness-reading-test.cjs --theme-only --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-reading-theme`。

专项使用临时 Edge profile 和第二屏后台窗口，检查显式浅色/深色、跟随系统及反复切换，测量原文、回答、引用、代码、表格、可用按钮和输入提示的实际前景/背景对比度（至少 4.5:1，禁用控件除外）。同时覆盖流式生成、阅读记录、关闭重开、错误重试，以及主题切换保留回答且不额外调用模型、宿主段落文字和样式不变。页面和模型响应为本地夹具，不代表真实供应商质量或 macOS Chrome/Firefox 实机验证。

`tests/readingThemeStyles.test.ts` 使用项目锁定的 Vue 编译器编译真实 SFC 样式，再匹配父子 DOM，防止 `:global()` 把深色规则错误编译到弹窗外壳。v0.0.32 包含这一缺陷；主分支已在 `4adc485c` 修正选择器，后续主题修复补齐引用、状态、按钮和辅助文字。

2026-09-12 的生产扩展专项 15/15 通过，所测深色文字最低对比度为 5.78:1，浅色为 4.67:1；逐项计算样式和浏览器隔离信息保存在 `docs/reports/issue-574-reading-theme/report.json`。截图：[深色](./reports/issue-574-reading-theme/dark.png)、[浅色](./reports/issue-574-reading-theme/light.png)。

## 输入框翻译

`node scripts/run-input-translation-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-input-translation` 使用生产扩展和临时 Edge profile，在第二屏后台验证输入框配置保存、三击间隔与恢复默认、独立模型和提示词、窄屏与深色布局，以及真实按键的翻译、取消、恢复和失败重试。

供应商响应与网页均为本地夹具，报告中的请求记录用于核对模型、提示词和原文；不代表外部服务连通性或模型翻译质量。`tests/inputTranslationConfig.test.ts`、`tests/inputTranslationBackground.test.ts` 和输入框内容脚本测试覆盖配置迁移、缓存隔离、输入快照、选区、输入法和迟到结果保护。Firefox 与用户脚本构建需另外执行，Edge 结果不能替代其运行时验证。

## 设置页视口与滚动

设置页保持侧栏品牌、页面标题和搜索框可见，菜单与表单分别在自身区域内滚动。切换分类后表单回到顶部；软件语言搜索仍定位到对应控件。内容区为绝对定位的辅助元素提供定位边界，避免长表单撑高外层文档，导致顶部消失和底部空白。

生产包构建后运行 `node scripts/testing/run-settings-viewport-ui-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-settings-viewport`。脚本通过临时 Edge profile 和后台可见窗口验证首次打开、全部菜单、搜索与下拉菜单、原生锚点滚动、通用/视频长表单底部、刷新深链接、窄屏、矮窗口及深色主题。报告保存页面高度、文档/容器滚动位置、截图、焦点隔离信息和控制台异常。Firefox 构建通过不等于 Firefox 实机验证；完整 UI 套件单独执行并报告。

## 圈选模型识图

`node scripts/testing/run-area-vision-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-area-vision` 使用生产扩展与临时 Edge profile，在后台可见窗口中验证识别方式及提示词保存、选区裁剪、无需 OCR 语言包的视觉路径、不支持或未知模型的 OCR 路径、模型能力覆盖、失败重试与取消清理。

该脚本的模型端点是本机 HTTP 夹具。它检查真实发出的图片尺寸、摘要及提示词，报告不保存图片请求体或凭据；截图展示真实扩展 UI。通过意味着请求和交互链路符合约定，不代表真实视觉模型对手写、模糊文字或复杂版面的识别准确率。

## 统一下拉选择器

设置页、Popup、文档页、词库和 userscript 设置面板使用 `src/ui/components/UiSelect.vue` 共享菜单外观。设置页默认翻译服务按机器翻译与 AI 翻译分组，显示本地服务图标；服务、目标语言与译文样式支持直接输入筛选。展开时原选择框显示搜索图标和输入提示，只保留一个搜索输入。当前选择使用浅色背景和勾选标记，焦点、禁用状态、多选标签与亮暗主题保持一致。共享组件透传 Element Plus 的属性、事件和具名插槽，保留调用方的菜单类名和挂载容器；不改变选项值或配置保存方式。服务和模型自定义菜单使用相同的菜单圆角、阴影和主题变量，模型使用可换行的整行选项。

userscript 的 16 个选择器通过 HTMLElement 引用将菜单挂到设置面板自己的 Shadow Root 内，避免宿主样式污染或面板内部滚动裁剪。`scripts/run-userscript-smoke-test.cjs --suite selects` 使用内存 GM 接口夹具验证单框搜索、键盘选择、取消不保存、数值设置保存重开和亮暗/窄屏菜单；默认 `--suite full` 保留既有翻译冒烟夹具，两组单独运行以避免修改配置的测试相互干扰。它不等同于真实 Userscripts/Tampermonkey 扩展或 Safari 验证。

生产包构建后运行 `node scripts/testing/run-select-ui-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-select-ui-production`，在临时 Edge profile 的后台可见窗口中检查选择、搜索、键盘操作、关闭菜单、保存重开、多选与禁用状态，以及桌面、窄屏和深色菜单截图。测试只使用临时配置，不调用翻译服务，也不证明真实服务质量。完整扩展 UI 回归仍使用 UI 测试技能的 `run-ui-test.cjs --suite full`，失败时区分控件回归与旧页面断言。

## 公告优先与关闭后续译

专项 case：`tests/fixtures/modal-first-translation.html` 和 `scripts/testing/run-modal-first-translation-test.cjs`。运行前生成生产扩展，再使用临时 Edge profile、第二屏正常尺寸后台窗口和 focus-safe helper：

```bash
node scripts/testing/run-modal-first-translation-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <工作区 Node 包目录> \
  --focus-safe-helper <浏览器翻译技能>/scripts/focus-safe-browser.cjs \
  --background --artifacts-dir /private/tmp/fluentread-modal-first-translation
```

检查原生 `showModal()` 公告、ARIA 公告、正文请求途中出现公告、关闭后自动续译、恢复再翻译及普通非模态对话框。报告保存请求顺序、逐段译文唯一性、截图与焦点隔离信息。本地确定性 provider 用于验证调度与页面行为，不代表真实翻译服务质量。

`tests/fullPageModalPriority.test.ts` 验证检测边界，`tests/fullPageVisibilityScheduling.test.ts` 中的“公告优先 case”验证视口与整页模式、失败、取消、重开和迟到响应。弹窗只控制调度，候选仍遵守原有识别范围和不可翻译区域；关闭后继续同一会话，恢复原文则终止等待。

## 工具栏翻译状态

`node scripts/testing/run-toolbar-status-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-toolbar-status` 使用生产扩展、临时 Edge profile 和第二屏后台窗口，检查原文、等待、完成、恢复、服务失败、原地重试、标签页切换和刷新。页面与供应商响应均为本地夹具，不代表外部服务质量。

报告中的 `toolbarStatus` 是内容脚本的真实结果状态；原生文字角标应始终为空，视觉状态改由静态工具栏图标显示。页面截图不包含浏览器工具栏；可选 `--window-query <可执行文件>` 接收一个输出匹配测试窗口的 CoreGraphics 窗口字典 JSON 数组的只读工具，追加原生窗口截图。该套件不强制重启 worker；不能把普通标签页切换或状态查询单测当作真实后台重启证据。

状态资源由 `scripts/testing/build-toolbar-icons.cjs` 生成。脚本通过 `FLUENTREAD_SHARP_PATH` 指定已有 Sharp 安装；生成后的 PNG 随扩展打包，不增加运行时依赖。叠层为图标右下角的三角折角，在 16 像素图标上两条直角边约为 8 像素、底色不透明度为 78%，提供五档分辨率。`tests/translationToolbarStatus.test.ts` 验证实际结果判定，`tests/backgroundBadgeRuntime.test.ts` 验证图标选择、导航清理、异步写入顺序及 MV2 回退。

FluentRead 把测试按意图分组，而不是把所有文件塞进一个难以诊断的命令。每个 `tests/**/*.test.ts` 必须且只能出现在 `tests/test-matrix.json` 的一个分组中；测试审计会拒绝漏归类、重复归类、重复用例名、`.only`、无原因 `.skip` 和覆盖率忽略指令。

## 按需运行

测试、类型检查和生产构建的 package scripts 统一经过
`scripts/testing/run-resource-safe.mjs`。默认同一台机器上的 FluentRead worktree
共用一把锁，Vitest 最多使用 2 个 worker，并关闭测试文件并行；直接运行
`pnpm exec vitest` 也通过 globalSetup 等待同一把锁。嵌套的 package 命令复用父锁，
子进程结束或收到终止信号后才释放；已退出进程遗留的锁可自动回收。

默认显示的 60% 是协作式资源预算标记，不是 CPU 使用率硬上限，也不会根据
这个百分比自动计算 worker 数量。需要进一步减少占用时使用
`FLUENTREAD_TEST_MAX_WORKERS=1 pnpm test`。直接调用浏览器脚本或其他高负载命令时，
可使用 `node scripts/testing/run-resource-safe.mjs -- <命令及参数>`。
默认最多等待锁 30 分钟，可用 `FLUENTREAD_TEST_LOCK_WAIT_MS` 调整。
`FLUENTREAD_RESOURCE_LOCK_DIR` 仅用于专项锁隔离验证；日常任务不要改写它，否则
不同目录的任务无法互相协调。

`tests/resourceSafeRunner.test.ts` 使用真实 Node 子进程验证并发互斥、死进程锁竞争回收、
父子锁复用、worker 参数、Vitest setup、等待超时、退出码和 SIGTERM 释放。
`pnpm test -- <文件>` 和 coverage 命令的首个 Vitest 转发分隔符会被兼容处理；
其他命令中的 `--` 原样保留。

```bash
pnpm test:audit          # 测试矩阵、重复和禁用项审计
pnpm test:architecture   # 分层、依赖方向与验证归属
pnpm test:unit           # 纯函数、状态机、parser、cache、handler
pnpm test:functional     # 多模块协作，替换网络/浏览器等外部边界
pnpm test:regression     # 历史缺陷的最小复现
pnpm test:coverage       # 已迁移可执行业务模块的四维 100% 门禁
pnpm test:document       # 文档格式、导出、取消、边界与历史回归
pnpm verify:extension-manifests  # fresh Chrome/Firefox 产物的权限、Offscreen 与 runtime marker
node scripts/verify-userscript-build.mjs  # userscript 元数据与产物边界
```

新增测试时应选择唯一分组：

- `unit` 只验证一个可隔离模块；不要再次复制同一功能的集成路径。
- `functional` 验证真实模块协作，mock 只放在网络、浏览器、时间或存储边界。
- `regression` 的用例名要写出历史失败条件，并保留能使旧实现失败的最小输入。
- `architecture` 验证目录、依赖、协议、安全运行方式和流水线归属，不替代行为断言。

`tests/architecture/sourceFileHeaders.test.ts` 会枚举 `src/` 下所有 TypeScript、Vue、CSS 与 Markdown 文件，检查首字符处的长注释、精确 `@file` 路径以及职责、内容、边界三个非空语义段。新增或移动源码时必须同步书写文件级说明，不能只让旧文件一次性通过。

## 覆盖率定义

项目使用两道互补门禁，不能把“构建成功”和“代码行为已经覆盖”混为一谈：

1. `vitest.coverage.config.ts` 中列出的已迁移 TypeScript 业务模块，V8 statements、branches、functions、lines 必须同时达到 100%。
2. `tests/architecture/verificationOwnership.test.ts` 审计其余 WXT entrypoint、Vue、CSS、HTML、browser runner、userscript 和文档文件，保证每个文件都由编译、双浏览器构建、静态契约、文档构建或隔离浏览器回归负责。

新增 `src` 可执行模块默认必须进入第一道门禁。只有纯类型文件、纯 re-export barrel 和列明理由的静态 composition root 可以由第二道门禁负责。禁止使用 `v8 ignore`、扩大 exclude 或无断言执行来制造 100%。

文档翻译的 parser、预览生成、二进制格式服务、翻译编排和展示模型全部进入第一道门禁；PDF.js worker 与真实 Canvas 像素采样适配由双浏览器构建及屏幕外文档浏览器回归负责。

配置计数测试需要同时覆盖：扩展后台 mutation 串行化、operationId 在提交后重启时去重、失败批次
复用同一标识、普通配置保存不能回滚 count，以及 userscript 多副本并发、提交后响应丢失和新页面聚合恢复。

## 翻译核心稳定性回归

OpenRouter 模型卡片曾在解除内部两行截断后仍保持外层 `height:176px`，使居中的双语内容覆盖相邻卡片。`translationHeightLayout.test.ts` 检查插入后由内向外测量、共享高度租约、宿主样式更新、窗口 resize、滚动/定位边界和移除清理；`translationTruncation.test.ts` 检查几何判断与安全边界。

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

生产 Chrome 产物另由 `scripts/run-full-page-translation-test.cjs` 验证真实键鼠事件、DOM 工件身份、请求数及连续帧可见性。使用浏览器技能提供的 focus-safe helper 与临时 profile，窗口在第二块屏幕可见但不抢前台。报告必须区分本地确定性服务夹具和真实网站、真实翻译服务的结果。

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

该回归检查宿主为新增链接写入 `tabindex=-1/0` 时保持同一个译文节点，避免把键盘焦点管理误判为内容损坏；正文、链接目的地或隐藏状态变化仍由确定性测试验证失效行为。仅译文模式还检查相邻 DOM 更新不会因原文位于扩展槽内而撤销翻译。固定高度按钮覆盖嵌套 flex/grid 标签、文字边界、点击与“翻译—恢复—再次翻译”，使用确定性翻译服务排除网络响应波动；真实 GitHub 页面结果需单独记录，不能以本地夹具代替。表单内的具名 submit 与用户输入框属于非候选控件，按完整 `outerHTML` 比对翻译前后与恢复原文，确保布局租约不在同层控件上留下属性残留。此类断言要求证据截图保持非侵入：Playwright 默认的 `caret: 'hide'` 会给每个 `input`/`textarea`/`[contenteditable]` 写入 `caret-color` 再以空值清除，在宿主控件上留下空 `style` 属性，因此浏览器回归截图统一使用 `caret: 'initial'`。

### Reddit 多翻译器共存

用户页面 HTML 曾同时包含沉浸式翻译的 `font.immersive-translate-target-wrapper` 与 FluentRead 双语 wrapper。旧快照把前者作为受保护原文复制，净化后丢失其标记，形成第三份译文。`translationCore.test.ts` 覆盖该结构的候选边界、快照省略与普通术语/代码保留。

生产扩展回归使用本地最小结构夹具，不执行用户粘贴的脚本，也不访问外部翻译服务：

```bash
node scripts/testing/run-reddit-translation-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <工作区依赖中的 Node.js 包目录> \
  --focus-safe-helper <浏览器测试技能>/scripts/focus-safe-browser.cjs \
  --background --artifacts-dir /private/tmp/fluentread-reddit-coexistence
```

同时检查正文与全部节点范围、悬浮 `[1,0,1]`、全文翻译与恢复、外部译文在请求前/途中/完成后出现、移除外部译文后重新翻译，以及外部 DOM 身份和 URL 保持不变。真实 Reddit 如果返回人机验证页，应单独记录为站点限制，不能把本地结构测试表述为真实帖子验证。

### GitHub Latest 仅译文反复翻译

仅译文将原文搬入自有槽时，必须同时识别原父节点的移除记录与槽内加入记录，避免合成正文段把自身渲染误判为外部变化、撤销译文并重复请求。`translationStability.test.ts` 覆盖 Latest 标签结构、同字不同节点、混合增删、真实原文修改和槽被移除；来源校验仍须保留。

手动验收使用仅译文及 AI 网页语境设置：翻译 GitHub Release 页，待首轮完成后停留至少 30 秒，确认 Latest 不闪烁且翻译次数不再持续增加；再恢复原文、重新翻译，并确认页面新增或修改的正文仍可正常翻译。

## 术语库回归

术语库的本地解析、三态选库、配置迁移、冻结版本、缓存身份、消息来源和 provider 协议先由确定性测试验证：

```bash
pnpm exec vitest run tests/glossary.test.ts tests/builtinGlossaries.test.ts tests/glossaryConfig.test.ts tests/glossarySettingsComponent.test.ts tests/translationGlossaryIntegration.test.ts tests/imageGlossaryContext.test.ts
```

生产 Chrome 产物另由以下隔离浏览器回归验证真实设置与翻译交互；`--browser` 一键计划也会自动包含此脚本：

```bash
node scripts/run-glossary-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <path> \
  --browser-path <path> \
  --focus-safe-helper <path> \
  --artifacts-dir /private/tmp/fluentread-glossary-browser
```

该脚本使用临时 profile 和本机 loopback OpenAI 兼容服务，不读取日常浏览器配置或真实密钥。它验证五套内置词库的真实词条预览、添加、来源版本持久化、删除重加和总开关；同时验证词库编辑、范围预览、导入、真实 CSV 下载后文件回导的语言无损、重载持久化、Control 悬浮及 Alt+T 全文的“翻译—恢复—再次翻译”、命中缓存与修改术语后失效、只发送命中词条，以及文档显式禁用和指定词库、跨页面保存、快速关闭、连续更新、深色与窄屏。报告与截图保存在指定目录；一键计划下使用 `<artifacts-dir>/glossary`。

术语脚本固定使用 focus-safe 后台启动，即使一键入口显式传入 `--headed` 也不转为前台；目前使用脚本内的超时设置，不接收一键入口的 `--timeout`。本机服务回显约束只能证明 FluentRead 请求与交互链路，不代表外部 AI 模型遵守术语的准确率；Qwen-MT 原生 `terms`、摘要跳过及不支持服务不改译文另由确定性协议测试覆盖。

视频字幕设置中的术语库与相邻设置统一为左侧标题和状态说明、右侧下拉控件；窄屏自动上下排列。视觉复核应覆盖跟随全局、不使用、指定多个词库、视频关闭后的禁用状态，以及服务不支持时的提示。文档翻译和快捷方案仍保留原生选择器，三态选库与配置保存行为共用。

## 快捷面板与完整设置

```bash
node scripts/testing/run-popup-quick-settings-ui-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <Node包目录> \
  --focus-safe-helper <focus-safe-browser.cjs路径> \
  --artifacts-dir /private/tmp/fluentread-popup-quick-settings
```

该专项使用生产扩展、临时 Edge profile 和第二屏后台窗口，检查六个快捷抽屉的完整可见性、对应设置入口、亮暗主题、划词与视频模式、隐藏字幕恢复、已有偏好保留、修改后立即关闭与重开、跨页面同步及连续写入。完整设置另验证 17 个导航入口、390px 布局、本地模型卡片在视频关闭后的禁用状态、字幕外观跟随配置草稿更新，以及迁入的朗读声音可以编辑并保存。配置通过真实后台消息写入本次临时扩展，不读取日常浏览器配置。

该脚本不下载模型、不调用外部翻译服务，也不验证播放器字幕质量或 Firefox 真实界面；不能把专项通过等同于其他 UI 套件或真实翻译链路通过。报告分别记录窗口位置、焦点策略、配置行为、布局尺寸、控制台错误和截图。

## 菜单栏首帧与快速关闭

Popup 必须等待配置服务完成读取或安全降级后再挂载。首个可见界面就应使用保存的皮肤、深浅主题和栏目布局；只有最终截图正确不足以证明没有闪烁。

设置中心生产 UI 矩阵同时检查 Popup 的内部滚动范围：短面板保持内容自适应高度，长面板在 600px 内可滚到底且底栏完整可见，之后恢复滚动位置。短文案和长文案均不得产生内部横向滚动；简约皮肤窄屏底栏的负边距必须与容器内边距一致，不能用外层裁切掩盖越界。失败时保留即时与等待过渡结束后的 DOM 尺寸和截图。

```bash
node scripts/testing/run-popup-startup-ui-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <path> \
  --focus-safe-helper <path> \
  --skin aurora \
  --artifacts-dir /private/tmp/fluentread-popup-startup
```

该回归在临时 Edge profile 中逐帧记录可见界面，并注入配置读取延迟来放大竞态窗口；报告同时保留正常打开的首个正确帧时间、挂载次数与 DOM 变更计数。对照旧产物时可传 `--expect-flash --skin emoji`，确认用例确实能发现旧版默认界面先绘制的问题。延迟注入数据不能当作正常启动耗时。

快速关闭用例冻结首条保存给 Popup 的回执，让第二次修改确定停留在页面内的队列，再立即关闭。报告必须证明关闭前已向后台交接包含未确认前驱的补丁链，关闭后最终选择仍被保存，且无修改关闭时普通保存与批量交接消息均为零。配置服务和后台处理器另验证前驱在途、已提交去重、字段冲突拒绝及失败后的接续边界。

加载动画另由 `scripts/testing/run-loading-motion-ui-test.cjs` 验证，使用相同的扩展目录、Playwright 与 focus-safe helper 参数。它在测试页面保留 closed ShadowRoot 句柄，检查 15 种动画的真实运动、关闭与系统减少动态效果后的静态反馈，并验证同一文档只解析一份共享样式表。采样窗口覆盖包含停顿的完整动画周期，避免把沙漏停顿误判为失效；跨文档样式隔离与旧浏览器的安全回退也有独立断言。

## 模型用量界面

模型用量的独立生产扩展回归使用临时 Edge profile 和同一套防抢焦点 helper：

```bash
node scripts/testing/run-model-usage-ui-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <path> \
  --focus-safe-helper <path> \
  --artifacts-dir /private/tmp/fluentread-model-usage-ui
```

脚本将确定性数据写入本次临时扩展的 IndexedDB，验证概览、缓存与推理不重复计数、上报覆盖率、实际零值与未上报的区别、双指标趋势与精确数字、键盘选取、筛选后晚到响应隔离、折叠与分页、英文界面，以及 1440/820/390 像素下的亮暗布局。截图中的用量是测试数据，不是用户真实使用记录。报告包含逐项结果、横轴日期完整性、窗口位置、前台应用检查和控制台错误。

该专项不替代完整设置中心与其他翻译功能的浏览器回归。

## 简体与繁体中文回归

`tests/chineseLanguage.test.ts` 覆盖语言别名、显式脚本优先、共享字和简繁混排；中文语境由明确字形或短语确认，常用中性汉字无需逐字白名单，简繁冲突由人工常用字表与 Unicode 17.0.0 Unihan 单向变体数据共同检查。截图评论语料位于 `tests/fixtures/chinese-language-posts.json`，覆盖普通中文、`OpenAI`/`CoT` 嵌入、同目标跳过和跨语言保留；完整外语、短混排与未确认的罕见字仍允许翻译。供应商协议矩阵、旧配置迁移、术语隔离和并发缓存分别由 `chineseTranslationProviders`、配置测试、`glossary`、`translationBroker` 与 `translationCache` 测试覆盖。

生产扩展可重复运行以下浏览器专项：

```bash
node scripts/testing/run-chinese-translation-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <path> \
  --focus-safe-helper <path> \
  --artifacts-dir /private/tmp/fluentread-chinese-browser
```

该脚本在临时 Edge profile 中以不抢焦点方式启动正常尺寸窗口，验证 Popup 源语言和目标语言选择、保存与重载、英文分别译成简繁、简繁互译，以及 Control 悬浮和 Alt+T 全文的 `[1,0,1]` 切换、恢复原文和缓存隔离。默认还用截图评论验证同目标中文零请求、零译文节点，相邻英文和繁体正常翻译，以及动态中文评论改为英文后的重新识别。默认本机 OpenAI 兼容服务只证明请求与交互链路；追加 `--live-google` 后另行验证实际 Google 服务，报告分开记录服务失败与确定性结果。此专项不替代其他站点、真实 OCR 或付费服务验证。

追加 `--spanish` 可运行西班牙语与简体、繁体中文之间的双向翻译矩阵，同样覆盖语言选择持久化、两种快捷键、恢复和缓存。西班牙语识别与朗读映射由 `commonUtilities`、`selectionTranslatorCore` 验证，OCR 语言包选择和保存由 `imageTranslation` 验证。

## 一键回归

### X 本地 AI 字幕同步

`scripts/run-x-subtitle-sync-test.cjs` 使用生产扩展、真实 Whisper Tiny/Base 与确定性语音验证完整识别。它要求 macOS 的 `say`（Samantha 声音）、`/opt/homebrew/bin/ffmpeg`、`ffprobe`、独立 Playwright runtime 和 focus-safe helper；首次运行会下载所选模型。

```bash
pnpm test:video:x-fixture -- \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <path> \
  --focus-safe-helper <path> \
  --artifacts-dir /private/tmp/fluentread-x-subtitle-proof \
  --long true --native-track true
```

使用 `--early-hls true --background-generation true --owner-handoff true --display-mode bilingual` 验证首屏早到清单、切换标签页后继续生成、完成后另一标签页可用和慢翻译；`--media-source direct` 验证独立媒体解码。使用 `--host-overlay true` 复现 X 媒体链接覆盖内层播放器的结构，使用普通鼠标点击验证菜单可操作，同时检查原有媒体链接仍可点击。`--model base --media-source direct` 覆盖较大模型与支持 Range 的直接 MP4 播放和跳转。另用 `--background-music true` 在语音下叠加持续背景音，按 20 ms 帧验证其 RMS 高于固定静音阈值；字幕边界仍对照未混音的原始语音，保留 250 ms 预算。口述文字比较只忽略大小写和句末标点，句子数量与词序必须一致。双语测试仅替换翻译供应商为固定延迟响应，不替换本地音频识别。

报告分别记录模型准备与字幕生成耗时，校验完整句子、SRT 非重叠区间、相对独立音频停顿检测的 250 ms 边界预算、暂停/seek/停止和原生字幕恢复。测试窗口保持正常尺寸、位于第二块屏幕且不抢前台。该语音夹具证明指定音轨的行为，不能代替真实 X 网络、任意口音或背景音乐的识别验证。

使用 `--prepare-after-load true --trusted-storage true --browser-path <新版 Chrome 可执行文件> --extension-install cdp` 验证播放器页面已打开后才下载模型，无需刷新即可生成字幕。该用例强制将本地存储设为 `TRUSTED_CONTEXTS`，通过 CDP 在扩展内容脚本上下文确认直接读取被拒绝，再验证后台模型查询与真实生成成功、没有误开设置页。旧浏览器没有此 API，不能作为这条权限回归的验证环境。`--extension-install cdp` 在独立临时 profile 中通过官方 DevTools `Extensions.loadUnpacked` 加载扩展，兼容不再接受命令行加载扩展的新 Chrome；不会使用日常 profile。追加 `--model-query-failure true` 可注入一次后台状态查询失败，检查提示重试、没有误开下载页，随后仍使用真实模型生成。生成前、生成中和就绪后的截图及 DOM 断言同时检查菜单分组、下载按钮并排和内容溢出。

### 完整流水线

本地确定性回归负责测试审计、WXT prepare、类型检查、严格覆盖率、四组 Vitest、Chrome/Firefox/userscript 构建及文档构建：

```bash
pnpm test:regression:all
pnpm test:regression:all -- --browser \
  --playwright-root <path> \
  --browser-path <path> \
  --focus-safe-helper <path>
```

真实浏览器层必须使用临时 profile、屏幕外正常尺寸窗口和 focus-safe helper；不会连接用户日常 profile，也不会静默退化成抢焦点的普通 Playwright 启动。`--browser` 追加 9 组本地浏览器夹具：划词触发、全文翻译、翻译 DOM 与按钮稳定性、视频字幕、文档翻译、设置中心、术语库、隐私边界和 userscript smoke；真实网络站点矩阵还需要单独的网络许可。具体参数以 `node scripts/testing/run-full-regression.mjs --help` 为准。

CI 或本地报告必须分别说明：确定性回归、隔离浏览器回归、真实网络矩阵是否执行。任何未执行层都不能写成“全量回归已通过”。

## 真实站点用例精简

页面已被删除、输入已失效且没有可验证目标的用例，可以从执行矩阵移除；在问题记录中保留来源、退出原因、证据及尚未覆盖的能力。重复用例只有在确认没有独有行为覆盖后才合并，不能把相邻场景当作完整替代。

临时连接失败、人机验证、正文未渲染，以及尚待修复的产品或测试缺口，不因未通过就删除。明确区分 required、quarantine 和已退役样本；删除数量不能计为通过数量。修改矩阵后运行配置校验、测试清单审计和相关回归，并核对保留用例的断言与覆盖门槛。

## 图片翻译完整流程

```bash
node scripts/testing/run-image-translation-flow-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <path> \
  --focus-safe-helper <path> \
  --artifacts-dir /private/tmp/fluentread-image-flow
```

使用独立临时 Edge profile 与 focus-safe helper，第二屏可见且不抢焦点。该测试执行真实 Tesseract 语言包下载与 OCR，以确定性的翻译 transport 排除服务波动，覆盖准备语言、可见阶段、完整文字、恢复和缓存重显、取消后重试、动态换图、祖先裁切与 object-fit 盒模型。报告区分首次语言准备时间和缓存重显时间，后者不应新增翻译请求；不将本地 transport 的通过视为真实翻译服务可用性证明。

追加 `--x-surface` 验证 X 页面快照中的透明 img 与同级背景图结构，保留根节点视口高度并滚动超过 2000 像素，使用自动识别语言，检查左下入口、关闭悬浮后的可信右键目标、持久准备卡片、居中转圈、真实 OCR 百分比、日语推荐包、中英日界面切换、翻译和还原。此用例通过生产消息执行菜单动作，未自动点击操作系统原生菜单项。可追加 `--multilingual` 断言实际 OCR 请求包含简体、繁體与英文，或追加 `--original-image <图片URL>` 使用真实原图、`--live-translation` 使用在线 Google 翻译；原图及 DOM 结构夹具不等同于登录后的 X 页面测试。报告分别记录页面和 OCR 控制台诊断，并要求实际监听 dedicated Worker、没有子语言文件加载错误。

图片单元与功能测试另覆盖低置信噪声、坐标回映、语言与图片缓存隔离、取消队列、有限并发保序去重、失败取消同批请求、同步消息异常清理及旧请求迟到清理。像素修补微基准只反映图像处理步骤，不代表 OCR 和网络请求的整体加速倍数。


## 圈选独立阅读流程

```bash
node scripts/testing/run-area-translation-flow-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <path> \
  --focus-safe-helper <path> \
  --artifacts-dir /private/tmp/fluentread-area-flow
```

使用临时 Edge profile、防抢焦点 helper、真实截图和 Tesseract，验证可信按键、可编辑输入保护、原/译文核对、整块请求、Esc取消、同截图重试、图像不上传、AI结构错误与重试、关闭后迟到响应、禁用卸载及页面CSS隔离。清晰/小字/暗底英文样本记录字符错误率和语言准备/首次/重试耗时；Google/OpenAI翻译传输是确定性夹具，不能代表外部服务质量或可用性。

标签切换用例通过 `connectOverCDP({noDefaults: true})` 禁用 Playwright 默认焦点模拟，验证浏览器真实的 `visible → hidden` 及在途取消。窄屏用例先稳定布局和页面焦点，再圈选；深色卡片同时断言外围透明，配置变更断言主题和静态进度立即更新。

### 悬浮说明框翻译稳定性

`run-full-page-translation-test.cjs` 在全文翻译会话中动态创建与旧 Bootstrap 相同结构的 tooltip，按原文高度定位，使双语内容增高后覆盖触发图标。真实 CDP 鼠标连续执行两次移入、持续停留和移出，断言每次只打开一次、译文仅一份、图标仍获得鼠标命中，移出后正常关闭。报告的 `tooltipHover` 同时记录语义 tooltip、未翻译提示、交互弹层和恢复原文后的命中边界。该保护只作用于已翻译的纯说明提示框，保留链接、按钮和可聚焦控件的交互。此测试为本地结构夹具，不代表登录后的真实网站验证。

Ko-fi 的 Monthly 按钮把 tooltip 插在按钮内部。回归同时覆盖提示框独立发现、按钮原文与请求槽不包含提示文字、提示框出现或移除不使按钮来源失效，以及直接控件翻译和加载阶段的命中保护。`scripts/run-kofi-tooltip-test.cjs --url https://ko-fi.com/thinkstu` 用临时后台 Edge 访问真实公开页面，配合本机延迟翻译响应验证持续悬停、再次悬停、移出关闭及恢复原文；需同时传入 `--extension-dir`、`--playwright-root`、`--focus-safe-helper`、`--artifacts-dir`。该脚本不访问日常浏览器配置，真实页面证据与本地翻译 transport 分别记录。

## 写作助手回复场景

`tests/writingCore`、`writingEditors`、`writingBackground`、`writingRuntime`、`writingIntegration` 覆盖默认开启及旧配置迁移、目标语言解析、长度/风格/语气/角色边界、网页范围、有界请求、来源校验、取消与超时、冻结模型、用量、当前编辑器的会话范围、编辑器快照和原生输入事件。上下文检查包含项目身份、Issue/PR 标题、原帖与最近回复预算，以及 PR 行内线程和 Gmail 会话隔离。`tests/writingMarkdown.test.ts` 检查纯文本投影中的段落、列表、代码缩进、表格、链接地址、转义与不执行 HTML 的边界。对应可执行模块按四维 100% 覆盖率要求验收；`tests/i18n.test.ts` 的全量界面扫描检查写作卡片与设置中的静态文案，配置选项标签另核对六种外语译文。

写作卡片顶部独立设置「回复语言」与「对照语言」。对照默认跟随界面语言，可选择具体语言或关闭；回复与对照相同时切换为单语展示：隐藏对照标题及区域，恢复普通写作说明，保留语言入口且不重复请求。对照显示在正文下方，仅供阅读，复制和插入仍只使用回复正文。`tests/writingReference.test.ts` 检查独立流的取消、迟到结果隔离、编辑与版本快照、会话及服务失效、五份完整结果缓存、失败重试和超长正文不截断。对照使用忠实翻译指令，不受写作篇幅、风格和角色要求影响。

`--suite bilingual` 验证英语回复/中文对照、中文回复/西班牙语对照、偏好持久化、关闭重开、编辑/版本切换、单独重试和只复制插入正文；也验证中文现稿切到英语、西班牙语时发送忠实翻译任务，以及历史稿语言不同于已保存偏好时仍转换当前稿。所有起草、改写及翻译请求都明确要求只输出所选回复语言，草稿、中文修改要求和角色偏好的语言不能覆盖该选择。模拟模型验证请求及界面链路，不代表真实模型遵循语言要求的质量评测。`--suite i18n` 验证七种界面语言与用户内容边界。对照关闭时仍可单独执行原有写作流程套件。

`--suite harness` 验证构建后的写作工具循环：实际后台读取本轮参考内容、查询 IndexedDB 中主动保存的学习记忆，再生成最终回复；清空记忆会取消在途生成并保留上一稿，重试读取空记忆，关闭记忆开关后不提供查询工具。它同时检查切换语言只做忠实翻译、不调用工具，以及原编辑框未被写入、未触发发送。该套件使用本机模拟模型，不证明线上模型的写作质量。

运行时测试还核对开发者/维护者反馈回复的「感谢 → 具体问题 → 未来排查或协助意愿」规则，以及自动和其他角色不因引用内容而取得维护者身份。此项验证实际传给模型的提示词与数据隔离，不代表外部模型一定生成符合要求的回复。

```bash
node scripts/testing/run-writing-assistant-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <path> \
  --focus-safe-helper <path> \
  --artifacts-dir /private/tmp/fluentread-writing-browser
```

默认 `--suite all` 执行完整流程，也可用逗号组合多个专项。`--suite presentation` 可独立验证设置与连接跳转、持久化、站点范围、深色及窄屏；`--suite settings` 验证默认回复偏好、稳定的自定义输入和设置/卡片同步；`--suite context` 验证项目与标题上下文、语言、风格确认及 Markdown 输出。报告会标明套件范围，不将短套件结果当作完整生命周期验证。若防打扰保护中止运行，保留已完成用例与错误，不能将该轮标记为全部通过。

该回归加载生产扩展，使用不抢焦点的临时 Edge 和 Gmail、GitHub Issue/PR 页面夹具。当前流程的验收范围包括：

- 默认自动显示入口；设置只有一个功能总开关，另提供默认回复偏好与服务模型配置；网页入口和卡片使用品牌图标、设置侧栏使用普通图标、Popup 无写作入口。
- 已有草稿自动完善、有讨论自动起草、无参考内容时填写要点；默认目标语言、简短长度和自然语气；具体语言切换和偏好持久化。
- 卡片「回答风格」集中呈现长度、风格、语气和角色；选择选项不请求 AI，取消不变，应用只请求一次。设置页直接显示四组可点选标签与独立语言入口，点选自动保存；设置页与卡片偏好同步，设置调整只影响后续生成，不重写当前版本；自定义语气与角色的有效性、长度限制及设置页空值回退。
- Markdown 默认预览与原文编辑切换，手工修改用于后续改写；生成、风格、语言与参考内容在固定区域内切换，深浅主题与窄屏保持可用。
- 参考内容包含项目、帖子标题、原帖和当前相关讨论；原草稿只读，参考修改确认后重新起草，取消不影响后续请求；跨编辑器、邮件窗口和评审线程隔离。
- 失败或停止保留已有草稿；版本切换与关闭重开恢复本页结果；GitHub 保留 Markdown，Gmail 插入及复制可读纯文本与链接地址；插入后回到原回复框，复杂格式提供复制操作。
- 草稿变化保护、编辑器重挂载、路由取消、配置变更、锚点定位，以及不自动发送邮件或评论。

以上是验收范围，不能视为新版浏览器验证已经通过。以本次实际执行报告记录的用例、窗口位置、前台状态和截图为准。正文与流式模型均为合成测试数据，不登录真实 Gmail/GitHub，不发送邮件或评论；夹具结果不能作为真实账号页面或外部 AI 服务质量的证明，旧版入口菜单、快捷键和写作网站名单的测试结果也不能代替新版流程验证。

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

使用 `scripts/run-selection-trigger-test.cjs --chinese-only` 配合原有隔离浏览器参数可验证纯中文的图标、小点、直接弹出、划词快捷键和翻译卡片点击/悬停/快捷键入口，并检查选区替换、目标切换及混排恢复。微软返回值使用本地响应夹具；翻译卡片验证入口，不调用真实 AI 模型。

## 自定义请求头回归（issue #522）

```bash
node scripts/testing/run-custom-headers-ui-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <playwright-node-modules> \
  --focus-safe-helper <fluentread-extension-ui-test-skill>/scripts/focus-safe-browser.cjs \
  --artifacts-dir /private/tmp/fluentread-custom-headers-ui
```

使用临时 Edge profile、不抢焦点的可见窗口和本地 HTTP 模拟模型，验证自定义服务的请求头保存、关闭重开、稳定会话 ID、服务隔离、非法输入阻断、清空恢复及窄屏布局。报告包含实际收到的测试请求和截图；测试只使用虚构凭据，不验证 OpenCode Go 或其他真实服务账号。配置加密、完整备份、公开导出脱敏、端点绑定和缓存快照由确定性测试覆盖。

## 划词窗口拖动与缩放（issue #525）

`node scripts/run-selection-trigger-test.cjs --geometry-only --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <浏览器测试技能>/scripts/focus-safe-browser.cjs --artifacts-dir /private/tmp/fluentread-selection-geometry` 使用临时 Edge profile 和第二屏后台窗口，检查顶部与内容空白处拖动、八个方向缩放、自动换行、正文选择、复制、滚动后位置保持、最小尺寸和视口边界，以及关闭、禁用、重新划词和迟到译文。截图涵盖放大、窄窗口和深色主题。页面及微软翻译响应为本地夹具，不代表真实供应商质量；窗口手势通过真实 CDP 输入执行。
