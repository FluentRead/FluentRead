# 阅读解释与学习材料

[返回测试入口](../testing.md)。按本次改动选择下面的专项；这些条目不要求每次全部运行。

## 词汇重遇的匹配索引

运行 `pnpm test tests/vocabularyReencounter.test.ts tests/vocabularyReencounterLifecycle.test.ts`。每次词表更新仍读取权威列表、复制最新记录、取消旧扫描、清除旧标记并重新扫描 DOM；只有按顺序逐项相等的 ID 与原始表达才能复用索引。复习状态、来源语言或提示元数据变化不能沿用旧记录，增删、原地编辑 ID 或表达、重复表达优先级和 Unicode 拼写变化则重建索引。私有索引键与回调能取得的条目对象分开保存，避免对象被修改后误用旧索引；销毁时释放键和待执行工作。

用例检查 5,000 条未变词表不再规范化表达，同时验证新 DOM、新提示记录、回调修改条目、重入替换、旧帧拒绝与资源清理。规范化次数是计算量证据，不代表浏览器输入延迟、绘制耗时或后台读取减少。索引键额外保留当前编译版本至多两倍条目数的字符串槽，不累积历史词表；浏览器与在线服务验收单独记录。

### 收藏词书隐藏与恢复

运行 `pnpm test tests/vocabularyBookComponentLifecycle.test.ts tests/learningCenterLifecycle.test.ts tests/optionsAppNavigationLifecycle.test.ts`。学习中心通过稳定 `isVisible` getter 把外层设置页状态传给词书；外层 KeepAlive 缓存和文档隐藏时，普通列表刷新只登记待办，取消分钟与最近到期扫描，恢复可见且操作空闲后串行读取最新快照。配置或异步学习中心在隐藏后才完成加载时，也延后首次列表读取；内层学习标签切换仍卸载词书。

组件存活与界面可见分别判断：已接受的掌握、复习、删除、撤销、导入和导出继续接收结果并结束忙碌状态，保留复习顺序、回忆草稿、筛选、页码与详情选择。写入期间调用刷新须立即记录待办并返回，防止保存等待自身结束；隐藏或写入前发出的旧列表响应不能覆盖更新后的记录。旧请求仍串行等待完成，失效结果随后补读；当次可见读取失败后等待主动重试或下一条通知，不循环重试失败请求。SFC 夹具与操作计数不等于真实浏览器延迟、绘制或存储性能验收。

## 阅读材料连续搜索

运行 `pnpm test tests/materialWorkspaceLifecycle.test.ts` 验证材料搜索的真实 SFC。主题过滤先于正文索引，空白查询不处理正文；非空查询复用至多 4 Mi 字符的小写文本，超预算材料完整匹配且当轮只构造一次，之后的小项仍可缓存。覆盖全部引用和跨字段短语、深层引用及来源/主题变更、同 ID 重载、分页和选择/草稿归属，以及清空查询、归档和清库后的失效。首次字段读取登记依赖与正文构造分开计数，不能把首次额外读取或原有空查询短路隐藏成收益。设计、证据和限制见[阅读材料搜索的正文复用](../maintainers/performance-material-search-20261024.md)。

### 阅读材料隐藏与恢复

运行 `pnpm test tests/materialWorkspaceKeepAlive.test.ts tests/materialWorkspaceLifecycle.test.ts tests/optionsAppNavigationLifecycle.test.ts tests/learningCenterLifecycle.test.ts`。材料页藏在外层 KeepAlive 时，把普通列表和详情读取合并为待刷新，恢复且操作空闲后再执行；内层学习标签切换仍卸载材料页。独立显示代次拒绝跨隐藏的旧读取与延迟焦点，组件存活和原操作代次继续接收已接受保存、导入、导出的结果，保留 busy 收尾与草稿身份。两级稳定 `isVisible` getter 还覆盖学习中心或材料组件在离开后才挂载的情况。

自动补刷须保留保存、导入或导出失败的首因，不能因读取成功清空它或因读取失败覆盖它；用户主动刷新/重试会清理旧错误并呈现新读取结果。已发出的请求和已接受操作仍可在隐藏期间完成，不能将普通读取合并描述为全部隐藏 I/O 为零。

实际父子 SFC 的 16 项与不可变基线配对，外层只复现 Options 异步组件/KeepAlive 结构；实际 Options SFC 的导航用例另以学习中心端口检查捕获的可见性 getter。直接材料组负责接受中的操作、各等待点、补刷错误及读取期间产生的文件校验错误，最新数量包含下节新增的引用比较用例；隐藏调度阶段另验证 Options 59 项与原学习中心 39 项。均为离线 Vue 与受控客户端端口验证，没有真实浏览器或持久存储验收。设计、分项结果和证据入口见[阅读材料的可见性与延后刷新](../maintainers/material-visibility-20261024.md)。

### 阅读材料刷新时的引用比较

`materialWorkspaceLifecycle` 的 72 项与 `materialWorkspaceKeepAlive` 的 16 项同时验证刷新后的完整引用比较：全部引用按顺序检查 `kind`、`id`、`excerpt`、`note`、`createdAt`、`updatedAt`，缺省与 `undefined` 等价，不受对象键插入顺序影响。去除前后两份正文 JSON 输出，仍保留引用变化时的权威详情补读、旧详情失效、选择/草稿及隐藏恢复调度。正式 SFC 上限夹具三次刷新从 6 次正文 JSON、108,521,346 个输出字符降至零；这不是端到端工作量或堆测量。边界及最终证据入口见[阅读材料刷新时的引用比较](../maintainers/material-reference-equality-20261024.md)。

## 关键内容空间与交互工作量

划词卡片定向回归使用 `tests/selectionTranslatorLifecycle.test.ts`、`tests/readingPanelLifecycle.test.ts` 与 `tests/readingPanelStreamingResize.test.ts`，检查单帧合并拖动、结束时刷新最后位置、取消与迟到帧、视口变化、UTF-16 朗读偏移和流式正文的尺寸通知。生产构建后执行 `node scripts/testing/run-selection-key-information-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --artifacts-dir <证据目录> --phase optimized`，在第二屏临时后台 Edge 中检查译文首屏、完整原文、单行工具栏的滚轮与键盘操作、手动拖动/缩放、流式阅读期间的卡片尺寸和网页内容保留。`--phase baseline` 允许记录优化前的关键内容失败，但仍要求基础交互、原文和清理契约通过。性能探针在核对扩展 ID 的隔离世界统计实际送达的受信指针事件与卡片几何读取；请求的输入数量不等于实际事件数量，也不代表 FPS。

`--blank-space` 在同一划词专项中追加短原句与短回答的中英文、亮暗主题、自动/390px 窄屏/280×180/360×200 卡片。它量化闲置音频占位、回答之后的实际空白、长回答内部滚动和追问可达性；使用本机延迟音频夹具逐帧检查生成、播放与停止的外框稳定、正文与播放控件不重叠。静音 WAV 只验证布局，不证明可听性。原文对照另有展开与返回的实际界面检查。

菜单使用 `tests/popupKeyInformation.test.ts` 及既有 Popup 生命周期、服务与页面操作测试。生产专项运行 `node scripts/testing/run-popup-key-information-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --artifacts-dir <证据目录> --phase optimized`，覆盖中英文、亮暗主题与三种皮肤，长名称、配置模型、本地/非模型服务、多服务分配、静态凭据提醒、模块排序及服务抽屉。仅使用合成配置，不执行翻译、连接检查或模型下载；普通扩展标签页尺寸不代表浏览器原生工具栏 Popup。

学习卡片在正文出现与完成后分别验证首个非标题回答段落的完整首行及至少 48px 的阅读视口；保持卡片尺寸不能代替正文可读性。`tests/uiI18nOwnership.test.ts` 使用真实界面指令与语言资源，检查 PRE/CODE 等内容祖先内的跟读子节点、语言切换和迟到文本不会被旧文案扫描改写。

两个专项使用自己的临时 profile 和 focus-safe helper，逐次截图前后检查自有浏览器没有成为前台，结束后只关闭自有浏览器再删除 profile。划词响应由本地夹具提供；它们证明生产 Chromium 的指定 UI 与事件路径，不能证明在线供应商质量、实际语音输出、Firefox 运行时或全部设备的流畅度。

## 划词学习面板原句滚动

生产扩展构建后运行 `node scripts/run-reading-density-test.cjs --source-scroll-only --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir <证据目录>`。

专项在临时 Edge profile、第二屏后台窗口中验证读懂、句法、用法和练习默认展示回答，完整原句与译文通过“查看原文”展开，返回当前阅读后收起对照。覆盖首次打开、短回答、长选区、流式生成期间向上滚动后保持位置、缓存动作切换、查看原文入口及键盘焦点、重复点击当前标签保留位置和未发送追问、追问、阅读记录往返与恢复、390px 窄屏和深色主题；检查页面本身不滚动、面板无横向溢出。网页与模型响应为确定性夹具，不代表在线模型质量或 Firefox 运行时验证。去掉 `--source-scroll-only` 可同时检查句法标注、键盘切词和次级操作。

## 阅读历史与学习选中状态

生产扩展构建后运行 `node scripts/run-reading-density-test.cjs --history-only --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir <证据目录>`。

专项只检查普通译文页的学习方式均未选中、点击一次进入对应回答、历史默认折叠、按轮次和问题摘要逐条展开、键盘收起、展开不发请求且不改变当前问答、长问题在 390px 深色界面中换行、返回译文时清除选中状态、缓存动作切换和恢复已保存记录。使用第二屏后台隔离 Edge 与本地确定性响应，不代表在线模型质量或 Firefox 运行时验证。`tests/readingPanelLifecycle.test.ts` 另覆盖空记录返回后点击默认动作，以及历史展开不改变追问上下文。

`tests/implementationAudit49C.test.ts` 通过真实学习笔记与阅读记录组件、确认弹窗和后台消息的受控端口，验证取消保留数据、挂载期间确认清空，以及确认尚未结束就卸载页面时不会发送清空请求。已经交给后台的清空操作不在此时撤回。

`tests/vocabularyStudyLifecycle.test.ts` 执行真实收藏学习组件 setup，验证计数、主题、动画与翻译术语库通知保留当前回答和待保存解释；启用、目标语言、完整学习偏好、模型与 transport 设置变化继续取消旧回答，迟到结果不覆盖当前归属。配置夹具使用真实规范化与模型比较，流式消息和保存端口受控；不把 setup 生命周期回归当作真实模型、原生布局或在线服务验收。

`tests/vocabularyReencounterPanelLifecycle.test.ts` 同样执行真实浮层 setup，回归五种无关通知（含同值快照）保留流式回答、十七种真实输入变化拒绝旧响应，以及明确操作、当前命中切换与卸载清理。共享讲解配置比较与旧模型标识的语义差异由 `tests/configHarness.test.ts` 验证；请求与 DOM 端口受控，原内容入口的功能停用和隐私资格仍由 `tests/vocabularyReencounterLifecycle.test.ts` / `tests/contentRuntimeLifecycle.test.ts` 负责。

`tests/usageDashboardLifecycle.test.ts` 另执行实际 Model setup 的速度和秒/分钟格式函数：核对七种界面语言、单位阈值、负零与异常值、组件实例隔离和构造失败重试；共享固定规则及八语言缓存淘汰由 `tests/numberFormat.test.ts` 覆盖。

`tests/dateFormatLifecycle.test.ts` 运行真实 Vue 更新、KeepAlive 和 SSR 生命周期，验证日期列表同轮惰性复用、下一轮重新解析语言和默认时区、独立组件与 SSR 请求隔离，以及构造失败重试。系统默认地区和时区通过原生 `Intl` 的受控端口切换，不表示已做真实操作系统变更或设备性能验收。

## 阅读卡深色主题（issue #574）

生产扩展构建后运行 `node scripts/run-harness-reading-test.cjs --theme-only --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-reading-theme`。

专项使用临时 Edge profile 和第二屏后台窗口，检查显式浅色/深色、跟随系统及反复切换，测量原文、回答、引用、代码、表格、可用按钮和输入提示的实际前景/背景对比度（至少 4.5:1，禁用控件除外）。同时覆盖流式生成、阅读记录、关闭重开、错误重试，以及主题切换保留回答且不额外调用模型、宿主段落文字和样式不变。页面和模型响应为本地夹具，不代表真实供应商质量或 macOS Chrome/Firefox 实机验证。

`tests/readingThemeStyles.test.ts` 使用项目锁定的 Vue 编译器编译真实 SFC 样式，再匹配父子 DOM，防止 `:global()` 把深色规则错误编译到弹窗外壳。v0.0.32 包含这一缺陷；主分支已在 `4adc485c` 修正选择器，后续主题修复补齐引用、状态、按钮和辅助文字。

2026-09-12 的生产扩展专项 15/15 通过，所测深色文字最低对比度为 5.78:1，浅色为 4.67:1；逐项计算样式和浏览器隔离信息保存在 `docs/reports/issue-574-reading-theme/report.json`。截图：[深色](../reports/issue-574-reading-theme/dark.png)、[浅色](../reports/issue-574-reading-theme/light.png)。

## AI 阅读解释的原文依据

阅读请求只通过带身份的原文清单提供选文和许可段落，`kind=selection` 是分析对象，`kind=context` 仅用于消歧。已经提供的段落不再注册重复读取工具；引用仍用同一份本地身份和连续原句校验。`harnessRuntime` 验证原文只发送一次、有效引用、真实历史、取消和意外工具调用不触发第二次模型请求。

引用协议与 Harness 后台的定向验证使用既有严格覆盖率配置；只收窄本轮涉及的文件，四维阈值保持 100%：

```bash
pnpm test:coverage -- tests/readingEvidence.test.ts tests/harnessRuntime.test.ts tests/readingAssistantPresentation.test.ts \
  --coverage.include=src/core/harness/evidence.ts \
  --coverage.include=src/services/harness/runtime.ts \
  --coverage.include=src/features/reading-assistant/answerFormat.ts
pnpm test:coverage -- tests/readingEvidenceAnchor.test.ts \
  --coverage.include=src/features/reading-assistant/evidenceAnchor.ts
pnpm test -- tests/readingEvidenceUi.test.ts tests/readingPanelLifecycle.test.ts \
  tests/readingPanelStreamingResize.test.ts tests/selectionTranslatorLifecycle.test.ts
```

这些测试覆盖真实送入模型的来源身份、连续引文校验、权限裁剪、未知/改写/不完整引用拒绝、表格内标记、重复句消歧、等价 DOM 恢复、隐藏正文、正文改写、导航、历史禁定位、取消与迟到结果，以及短期高亮和内部定位滚动的清理。

生产 Chrome 构建后的专项：

```bash
node scripts/testing/run-resource-safe.mjs -- node scripts/run-harness-reading-test.cjs --evidence-only \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <bundled-node-packages> \
  --focus-safe-helper <browser-translation-test-skill>/scripts/focus-safe-browser.cjs \
  --artifacts-dir /private/tmp/fluentread-reading-evidence
```

脚本使用临时 Edge profile、第二屏后台可见窗口和真实鼠标/键盘，核对解释旁的多句依据、点击/Enter/Space 定位、实际全文双语翻译与恢复、等价重建、隐藏/显示、追问、正文改写、SPA 导航、关闭及停止后迟到响应。顶栏更多入口另行检查“记录”右侧位置、正文无占位、菜单展开尺寸、键盘及外点关闭、浅深色与窄卡片。另有手工插入译文节点的排除规则测试，报告与真实翻译路径分开记录。模型和普通翻译均为本机确定性 HTTP 夹具，只证明协议、来源映射与交互链路；不证明在线模型质量、解释语义正确、所有站点或 Firefox 实机行为。报告保存来源 DOM、闭合 Shadow DOM、截图及源码/构建摘要。

原文依据入口使用句末无外框双引号，专项核对 20×20 按钮、16×16 引文 SVG、无警示形状/可见标签文字、完整引文 title/aria 和行内布局。真实 hover 检查原生 title 契约，系统层 tooltip 不作为截图证据；点击及 Enter / Space 继续定位原句。

## 写作助手回复场景

`tests/writingCore`、`writingEditors`、`writingBackground`、`writingRuntime`、`writingIntegration` 覆盖默认开启及旧配置迁移、目标语言解析、长度/风格/语气/角色边界、网页范围（包括 GitHub 新建 Issue）、有界请求、来源校验、取消与超时、冻结模型、用量、当前编辑器的会话范围、编辑器快照和原生输入事件。编辑器检查包含只有原帖时的首条回复与新建 Issue 表单；上下文检查包含项目身份、Issue/PR 标题、原帖与最近回复预算，以及 PR 行内线程和 Gmail 会话隔离。`tests/writingMarkdown.test.ts` 检查纯文本投影中的段落、列表、代码缩进、表格、链接地址、转义与不执行 HTML 的边界。对应可执行模块按四维 100% 覆盖率要求验收；`tests/i18n.test.ts` 的全量界面扫描检查写作卡片与设置中的静态文案，配置选项标签另核对六种外语译文。

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
- 卡片「回答风格」集中呈现长度、风格、语气和角色；选择选项不请求 AI，取消不变，应用只请求一次。设置页直接显示四组可点选标签与独立语言入口，点选自动保存；设置页范例在简短、标准、详细下逐项切换风格、语气和角色均更新正文，简短也保留角色句；自定义空值显示默认范例说明。设置页与卡片偏好同步，设置调整只影响后续生成，不重写当前版本；自定义语气与角色的有效性、长度限制及设置页空值回退。
- Markdown 默认预览与原文编辑切换，手工修改用于后续改写；生成、风格、语言与参考内容在固定区域内切换，深浅主题与窄屏保持可用。
- 参考内容包含项目、帖子标题、原帖和当前相关讨论；原草稿只读，参考修改确认后重新起草，取消不影响后续请求；跨编辑器、邮件窗口和评审线程隔离。
- 失败或停止保留已有草稿；版本切换与关闭重开恢复本页结果；GitHub 保留 Markdown，Gmail 插入及复制可读纯文本与链接地址；插入后回到原回复框，复杂格式提供复制操作。
- 草稿变化保护、编辑器重挂载、路由取消、配置变更、锚点定位，以及不自动发送邮件或评论。

以上是验收范围，不能视为新版浏览器验证已经通过。以本次实际执行报告记录的用例、窗口位置、前台状态和截图为准。正文与流式模型均为合成测试数据，不登录真实 Gmail/GitHub，不发送邮件或评论；夹具结果不能作为真实账号页面或外部 AI 服务质量的证明，旧版入口菜单、快捷键和写作网站名单的测试结果也不能代替新版流程验证。

仅调整回答风格布局与关于页时，使用 `node scripts/testing/run-settings-preview-about-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <path> --focus-safe-helper <path> --artifacts-dir /private/tmp/fluentread-settings-preview-about`。该专项在独立后台 Edge 中检查桌面左侧预览、右侧设置，1024/820/390px 的预览在上、设置在下及无横向溢出；验证实时预览、关于页已移除核心体验介绍且品牌区铺满、开源项目和问题反馈下方跨两列微信交流按钮和联系二维码弹窗、赞赏码在当前页弹窗放大、关闭按钮/遮罩/Escape 关闭与焦点返回、窄屏浅深色和七种界面语言。可用 `--suite about` 或 `--suite writing` 限定本次相关范围；关于页专项还检查 1440/1024/820/390px 的浅深色布局。它不请求模型、不打开外部赞赏服务，也不代表 Firefox 实机验证。

