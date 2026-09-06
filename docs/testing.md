# 测试与回归

FluentRead 把测试按意图分组，而不是把所有文件塞进一个难以诊断的命令。每个 `tests/**/*.test.ts` 必须且只能出现在 `tests/test-matrix.json` 的一个分组中；测试审计会拒绝漏归类、重复归类、重复用例名、`.only`、无原因 `.skip` 和覆盖率忽略指令。

## 按需运行

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

该回归检查宿主为新增链接写入 `tabindex=-1/0` 时保持同一个译文节点，避免把键盘焦点管理误判为内容损坏；正文、链接目的地或隐藏状态变化仍由确定性测试验证失效行为。仅译文模式还检查相邻 DOM 更新不会因原文位于扩展槽内而撤销翻译。固定高度按钮覆盖嵌套 flex/grid 标签、文字边界、点击与“翻译—恢复—再次翻译”，使用确定性翻译服务排除网络响应波动；真实 GitHub 页面结果需单独记录，不能以本地夹具代替。

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
