# 设置与界面布局

[返回测试入口](../testing.md)。按本次改动选择下面的专项；这些条目不要求每次全部运行。

## 设置分组、阅读辅助与右键菜单

右键菜单后台恢复专项：`pnpm test tests/contextMenuRuntimeOwnership.test.ts tests/contextMenu.test.ts tests/backgroundBadgeRuntime.test.ts tests/contentMessageRuntime.test.ts`。受控浏览器端口覆盖 MV3 后台冷启动首击等待配置与菜单就绪、活动页查询暂时失败后的点击、导航/关闭/禁用期间丢弃旧点击，以及失败重试和翻译—恢复—再次翻译。菜单已创建后，活动页查询失败不会清空点击路由。该专项不代表操作系统原生菜单、报告者环境或在线供应商验收。

右键翻译体验使用定向入口：

```sh
node scripts/run-selection-trigger-test.cjs --context-menu-only \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <Node包目录> \
  --focus-safe-helper scripts/testing/focus-safe-browser.cjs \
  --artifacts-dir /private/tmp/fluentread-context-menu-experience
```

此筛选只运行右键专项，使用临时 Edge profile、第二屏后台正常窗口和本地微软 HTTP 响应夹具。原生三击选中文字后用可信 CDP 右键捕获选区，清除活动 Selection，再走生产 `contextMenuTranslate` 消息检查菜单选区恢复；用延迟响应检查加载反馈、在途重新右键与重复触发仅一次请求、完成后复用卡片；单次 HTTP 400 后验证失败提示与手动右键重试。还检查断连选区和可编辑区域拒绝，以及全文翻译—恢复—再次翻译—恢复的 `[1, 0, 1, 0]` 和原始 HTML 还原。输入框保护同时覆盖 Edge 默认右键聚焦与宿主阻止聚焦、保留同文正文选区的受控情形。

通知专项复用生产 `contextMenuNotice`：同类提示只保留一份，浅色/深色和桌面/390px 的长文案均无横向溢出；检查圆角、中性阴影、阴影周围留白和完整 28px 关闭区域，并用可信鼠标点击关闭按钮边缘。真实鼠标停留超过六秒时通知继续显示，离开后按剩余阅读时间关闭；移动前明确选择输入标签页，以可信小幅鼠标移动维持后台窗口中的阅读输入，并在进入后及 500/2000/6500ms 采样实际 `:hover`、命中节点与可信进入/离开事件，失败报告也保留观测，避免将未命中的输入误判为计时回归。真实 Tab 聚焦有可见焦点，停留超过六秒仍可阅读，通知内部 Escape 关闭并还原网页焦点，外部 Escape 保持网页自身行为。还覆盖鼠标与键盘关闭后、离场动画期间同类提示再次到达时原位显示，并按新阅读时间正常关闭，避免残留暂停状态。全文专项还验证成功动作清除旧的右键失败提示，选区失效或总开关关闭的拒绝动作保留提示。报告保存时长、几何与样式数据及截图，并直接捕获带阴影留白的浅色通知局部截图；“无裁切”还需目视检查对应截图，不能仅凭构建判断。报告分别保存受控错误、加载/请求等待时间、请求计数、可信手势、焦点策略和截图；本机等待时间不代表在线供应商延迟。原生菜单注册由浏览器 API 核验，菜单项选择和后台 `contextMenus.onClicked` 事件仍由生产消息路径替代，不能将结果描述成操作系统原生菜单点击、Firefox 实机或真实供应商验收。

生产扩展构建后，运行 `node scripts/testing/run-settings-reading-menu-ui-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <扩展界面测试技能>/scripts/focus-safe-browser.cjs --artifacts-dir <证据目录>`。专项使用第二屏上的临时 Edge 后台窗口，检查阅读辅助左侧预览与右侧设置、完整说明、虚线、高亮联动与样式跳转，右键菜单左侧单一虚拟菜单与右侧紧凑选项、所有启用入口的实时增删、功能前置条件禁用、总开关禁用和重开后保存；覆盖七种语言的桌面与 390px 布局、深色主题和其他设置分组标题。浏览器范围为 Edge，不代表 Firefox 实机或外部翻译服务。

`run-settings-section-navigation-test.cjs` 检查连续表单中的完整导航、搜索、跨页定位、折叠、键盘与滚动高亮。翻译设置分别登记右键菜单、悬浮球进阶设置、段落复制、局部翻译与不翻译的语言；最后一组较短时，滚动到底仍应高亮其入口。元数据与既有直达链接由 `tests/optionsNavigation.test.ts` 和 `tests/optionsAppNavigationLifecycle.test.ts` 验证。实际 Options SFC 回归另覆盖单次查询的派生复用、原空白/全角匹配规则、同查询的迟到语言资源更新，以及旧搜索项点击时读取最新查询；不把操作计数当作真实输入延迟。

## 设置布局与控件交互

`node scripts/testing/run-settings-layout-polish-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <捆绑 Node 包目录> --focus-safe-helper <focus-safe-browser.cjs 路径> --artifacts-dir <证据目录>` 使用独立临时 Edge profile 与第二屏后台窗口，验证阅读辅助的左右布局与窄屏上下排列、学习程度对齐和保存、请求限制继承及自定义值、统一下拉菜单、说明提示的关闭延迟和文字选择，以及识图检测成功只显示一次而保留失败和取消反馈。

朗读来源、在线音色与本地模型集中在一个设置框中。仅在线收起本地选项，仅本地收起在线选项；切换来源保留原来的音色偏好。图片的识别方式与入口、漫画的预翻译与按钮和缓存分别位于对应预览右侧；共享识别资源集中在一个设置框，优先展示当前识别方式和准备状态；备用 Tesseract 默认收起，切换为当前方式时自动展开。语言包列表与下载来源、离线导入采用次要展开入口，进行中的任务或错误会自动展开。专项覆盖中文和英文、浅色和深色、1440/1024/820/390px 布局。识图检测只连接本机图片响应夹具，不证明真实供应商能力；测试不下载朗读或识别模型，不代替 Firefox 实机验收。

## 设置页视口与滚动

设置页保持侧栏品牌、页面标题和搜索框可见，菜单与表单分别在自身区域内滚动。切换分类后表单回到顶部；软件语言搜索仍定位到对应控件。内容区为绝对定位的辅助元素提供定位边界，避免长表单撑高外层文档，导致顶部消失和底部空白。

生产包构建后运行 `node scripts/testing/run-settings-viewport-ui-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-settings-viewport`。脚本通过临时 Edge profile 和后台可见窗口验证首次打开、全部菜单、搜索与下拉菜单、原生锚点滚动、通用/视频长表单底部、刷新深链接、窄屏、矮窗口及深色主题。报告保存页面高度、文档/容器滚动位置、截图、焦点隔离信息和控制台异常。Firefox 构建通过不等于 Firefox 实机验证；完整 UI 套件单独执行并报告。

搜索结果面板位于页内导航与设置内容之间，高度随结果数量变化，超过上限后在面板内滚动，宽度与导航和内容同列。运行 `node scripts/testing/run-settings-search-results-layout-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-settings-search-results-layout`，在通用设置、翻译服务和关于页分别搜索单条、多条和无结果的关键词，覆盖 1440×900、1024×700、390×720 与 1440×480，检查面板内容完整、不挤占设置内容并保持对齐。

## 统一下拉选择器

设置页、Popup、文档页、词库和 userscript 设置面板使用 `src/ui/components/UiSelect.vue` 共享菜单外观。设置页默认翻译服务按机器翻译与 AI 翻译分组，显示本地服务图标；服务、目标语言与译文样式支持直接输入筛选。展开时原选择框显示搜索图标和输入提示，只保留一个搜索输入。当前选择使用浅色背景和勾选标记，焦点、禁用状态、多选标签与亮暗主题保持一致。共享组件透传 Element Plus 的属性、事件和具名插槽，保留调用方的菜单类名和挂载容器；不改变选项值或配置保存方式。服务和模型自定义菜单使用相同的菜单圆角、阴影和主题变量，模型使用可换行的整行选项。

userscript 的 16 个选择器通过 HTMLElement 引用将菜单挂到设置面板自己的 Shadow Root 内，避免宿主样式污染或面板内部滚动裁剪。`scripts/run-userscript-smoke-test.cjs --suite selects` 使用内存 GM 接口夹具验证单框搜索、键盘选择、取消不保存、数值设置保存重开和亮暗/窄屏菜单；默认 `--suite full` 保留既有翻译冒烟夹具，两组单独运行以避免修改配置的测试相互干扰。它不等同于真实 Userscripts/Tampermonkey 扩展或 Safari 验证。

该浏览器夹具还会在同一执行环境的全局对象上预置 Dexie `4.4.4`，再执行当前打包脚本并检查预置实例未被覆盖。官方 Dexie `4.4.5` 入口在同一条件下会抛出 issue #524 中的版本冲突；分别用 `--gm-mode modern` 和 `--gm-mode legacy` 验证两类脚本管理器 API 的启动、设置和翻译路径。此项只模拟版本冲突和 GM 接口，不代表已在 Safari Userscripts 或 Via 真机上运行。

浏览器夹具还支持 `--engine webkit`，固定以 Playwright WebKit 的无窗口模式运行，不要求焦点保护 helper；默认仍为 Chromium。WebKit 26.5 的 `--gm-mode modern` 夹具已覆盖独立版完整设置、独立设置标签页、全文翻译—恢复—再翻译，以及精简版固定 `@require` 依赖、Dexie 异版本共存和重复注入保护。这是 WebKit 内核加确定性 GM 接口的证据，不能当作 Safari Userscripts 真实扩展或 Safari 27 的运行证明。

安装 Playwright 对应版本的 WebKit 后，可针对构建产物运行其中一个范围，例如：

```bash
node scripts/run-userscript-smoke-test.cjs \
  --engine webkit --gm-mode modern --suite full \
  --artifact .output/userscript-standalone/fluent-read.user.js \
  --playwright-root <Playwright-Node包目录> \
  --artifacts-dir /private/tmp/fluentread-userscript-webkit
```

仓库独立版把扩展的完整 Options 页面挂在全视口 closed ShadowRoot，使用 `--suite options` 验证页内回退、设置保存、下拉菜单和主题隔离、扩展专属设置页面与右键菜单、Popup 布局只显示不可用提示，以及宿主 hash 不变。圈选和模型用量已分别合并到图片翻译与翻译统计页面，因此按现有父页面检查不可用提示。页内回退会暂时隐藏悬浮球，显示可访问的关闭按钮，关闭后恢复悬浮球；浏览器断言还检查跨分区导航和切换到 390px 窄屏后悬浮球保持隐藏。窄屏截图与浏览器断言同时覆盖这一路径。`--suite options-route` 验证独立设置标签页不启动网页翻译运行时。精简版仍使用小面板。完整设置页的真实 Violentmonkey 检查在下面的管理器命令中加入 `--settings-mode full`，还会验证设置标签页关闭、重开悬浮球后源网页在焦点刷新时同步变化，重载保持设置且不覆盖已有主题。

真实脚本管理器回归使用 `pnpm test:userscript:manager`。默认把最终 `.user.js` 作为文件安装到临时 profile 的 Violentmonkey MV3；`--install-mode url` 从本机 HTTP 地址安装同一构建产物，经过脚本管理器确认页并等待已安装列表出现脚本版本，更接近公开脚本链接的安装流程。两种模式都在后台可见且不抢焦点的独立浏览器中检查声明的 `@require`（独立版为零个）、页面注入、桌面和 390px 截图、设置面板、可信 Control 悬浮翻译 `[1,0,1,0]`（相邻段落不变）、Alt+T 全文翻译 `[1,0,1]`（两段正文均完成）、原文与宿主全局保护。测试页在脚本执行前注册异版本 Dexie `4.4.4`，验证启动、悬浮翻译和刷新后都保留该实例；随后在真实管理器中保存关闭悬浮球、刷新确认配置保留、重新开启并检查当前页同步，最后断言控制台无卸载错误。报告保存 `evidence.json`。运行前需提供 Chromium 可执行文件、解压后的 Violentmonkey 2.49.0 扩展、Playwright 包目录与 focus-safe helper；翻译仍访问当前默认服务，精简版安装还会访问 jsDelivr，不能代替 Safari Userscripts 或 Via 真机验证：

精简版新安装后立即打开网页可能早于脚本管理器完成 `@require` 下载：隔离 Violentmonkey 2.49.0 的文件安装复现了主脚本先执行、`Vue is not defined`，同会话刷新及新标签页仍失败。URL 安装确认页通常等下载完成才启用安装按钮，但点击后立刻打开测试页也曾出现未注入的情况。精简版回归在首个测试页打开前等待每个依赖请求完成；URL 模式还等待管理器列表显示脚本版本。独立版用 `pnpm test:userscript:standalone` 构建到 `.output/userscript-standalone/fluent-read.user.js`，内置 Vue、Element Plus、tldts、pako 和完整 Options 页面，没有 `@require`。三份站点适配 JSON 在 userscript 构建期压缩为内置数据，启动时同步还原；精简版此时必须已加载固定版本的 pako `@require`。在含 #693、#694、#695 的同一份源码上对照，精简版由 1,864,179 降至 1,786,473 字节，未压缩精简版由 3,419,345 降至 3,269,885 字节；该基线的独立版为 3,294,397 字节，压缩改动在此前 #695 基线上也节省了 77,706 字节。与 #698 主线合并后重新构建，精简版为 1,789,993 字节，独立版为 3,298,115 字节。未压缩产物仍超过 [Greasy Fork 的 2 MB 上限与禁止压缩规则](https://greasyfork.org/zh-CN/help/code-rules)。最新基线下精简版的 gzip 体积增加 2,569 字节，不能把安装体积缩小视为加载性能收益；启动耗时尚未量化。更新后的五份语言资源固定到包含它们的 Git 提交；构建期验证内容一致性，CDN 抽样下载与仓库文件一致。这两种构建都不是已发布到 Greasy Fork 的新版本，也未在 Safari Userscripts 或 Via 设备上验证。

```bash
pnpm build:userscript:greasyfork
pnpm test:userscript:manager -- \
  --install-mode url \
  --settings-mode compact \
  --artifact .output/userscript-greasyfork/fluent-read.user.js \
  --manager-extension <Violentmonkey-MV3-目录> \
  --browser-path <Chromium-可执行文件> \
  --playwright-root <Playwright-Node包目录> \
  --focus-safe-helper <focus-safe-browser.cjs-路径> \
  --artifacts-dir <临时证据目录>
```

验证独立版首次文件安装时，把 `--install-mode` 改为 `file`，将 `--artifact` 指向 `.output/userscript-standalone/fluent-read.user.js`，并添加 `--settings-mode full`。

生产包构建后运行 `node scripts/testing/run-select-ui-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-select-ui-production`，在临时 Edge profile 的后台可见窗口中检查选择、搜索、键盘操作、关闭菜单、保存重开、多选与禁用状态，以及桌面、窄屏和深色菜单截图。测试只使用临时配置，不调用翻译服务，也不证明真实服务质量。完整扩展 UI 回归仍使用 UI 测试技能的 `run-ui-test.cjs --suite full`，失败时区分控件回归与旧页面断言。

## 多语言界面布局

生产包构建后运行 `node scripts/testing/run-multilingual-layout-ui-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-multilingual-ui`。专项在独立后台 Edge 中检查七种语言的所有设置分类、Popup 与快捷抽屉、文档导入和工作区，在 1280px 与 390px 下检查完整控件文字和横向溢出。等待实际语言资源渲染后才计入检查；用户正文、代码和可滚动区域不作为标签裁切。Popup 底部不展示宣传语。共用选择器的受影响范围使用 `scripts/testing/run-select-ui-test.cjs --controls-only`，覆盖搜索、键盘选择、点击外部关闭、重开保存以及皮肤与窄屏菜单。

阅读面板使用 `scripts/run-reading-density-test.cjs --multilingual-only`，写作助手使用 `scripts/testing/run-writing-assistant-test.cjs --suite i18n,presentation`，参数同上。分享卡片使用 `scripts/testing/run-share-card-test.cjs --multilingual-only` 检查七种语言标题、按钮与宿主内容保持。上述页面内面板使用本地确定性回答，检查七种语言、窄屏及用户输入保持，不代表真实服务质量或 Firefox 运行结果。`scripts/testing/run-popup-actions-service-ui-test.cjs --density-only --layout-only` 只检查皮肤、主题、语言和快捷抽屉布局，避免进入打开完整设置的浏览器窗口操作。

## 设置层级与渐进展开

通用页按日常翻译、网页辅助、基本偏好排序；服务页的连接字段直接排在服务标题下方、不再单设标题；密钥输入下方直接添加密钥，已有空行时也能继续添加，多行时每行都可删除，填好两个以上密钥后才显示“轮换使用 / 仅用首个”，仅用首个时其余密钥保持可见并标为备用。密钥要求（必填 / 允许留空）位于接口兼容页签，填写密钥后即使允许留空也仍使用已填密钥。模型偏好、提示词、请求限制和接口兼容通过紧凑页签切换，每次只显示一组；只有一个页签的服务改用小节标题。各页签统一为“左标签、右控件”的字段行，二选一或三选一用分段按钮，请求限制的三项数值各占一行；提示词模板可在确认后一键同步到所有 AI 服务。标签旁的信息按钮支持悬停和键盘聚焦，详细说明不挤占表单空间。可运行以下专项验证这些入口：

```bash
node scripts/testing/run-settings-hierarchy-ui-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <Node包目录> \
  --focus-safe-helper <focus-safe-browser.cjs路径> \
  --artifacts-dir /private/tmp/fluentread-settings-hierarchy
```

该专项在独立临时 Edge profile 中验证默认服务配置直达、浏览目录不改变默认服务、键盘切换页签、多 Key 保留、模型偏好与提示词保存、请求限制、快速关闭后的持久化、连续写入与两个设置页同步。还检查 18 个设置分区、1024/820/390 像素布局、窄屏目录及图标、深色和英文界面，并导出截图、布局尺寸与控制台错误。

服务配置的详细专项可运行：

```bash
node scripts/testing/run-service-configuration-ui-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <Node包目录> \
  --focus-safe-helper <focus-safe-browser.cjs路径> \
  --artifacts-dir /private/tmp/fluentread-service-configuration
```

该专项使用临时 Chrome profile 与第二屏后台窗口，验证四类设置页签、键盘访问、多 Key 保留及逐项结果、实际继承的限制值、模型与服务限制隔离、区域说明、本地模型悬停详情、自定义接口地址说明和删除确认。请求限制继承时仍显示生效数值，切换为自定义后可编辑。自定义接口地址接受完整 Chat Completions URL 或以 `/v1` 结尾的 Base URL，模型必须支持 Chat Completions；说明集中在标签旁提示中。Ollama 与腾讯混元模型使用统一的目录名称。

浏览器配置修改经过真实后台保存，覆盖快速关闭、连续写入、重开和两页同步；连接结果使用测试夹具，不调用外部服务、不下载模型。响应式覆盖 1440/1024/820/390px，另检查深色和英文界面，Firefox 仅有构建证据。

连续设置页的顶部同页导航可单独运行 `scripts/testing/run-settings-section-navigation-test.cjs`，传入 `--extension-dir .output/chrome-mv3`、`--playwright-root <bundled-node-packages>`、`--focus-safe-helper <skill>/scripts/focus-safe-browser.cjs` 和 `--artifacts-dir <evidence-dir>`。该专项覆盖通用、翻译、界面、划词、图片、视频、写作、高级及备份九个长表单的入口点击、滚动高亮、键盘操作、条件模块、折叠展开、搜索与跨页定位交接，并检查统计/网站规则原有视图切换、1024/820/390 像素布局和英文标签。仅使用临时 profile、第二屏可见后台窗口；导航本身不得写配置或更改 URL。Firefox 实机不在该专项范围内。

浏览器使用第二屏可见但不抢焦点窗口，结束后仅清理测试 profile。所有凭据都是测试占位符，不调用真实翻译服务；桌面窄屏验证不等同于手机或 Firefox 实机验证。

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

## 翻译统计界面

翻译统计的生产扩展回归同样使用临时 Edge profile 与防抢焦点 helper：

```bash
node scripts/testing/run-translation-stats-ui-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <path> \
  --focus-safe-helper <path> \
  --artifacts-dir /private/tmp/fluentread-translation-stats-ui
```

脚本启动本地 DeepLX 与 OpenAI 兼容夹具，从设置页经真实 runtime 消息发起单条、缓存命中、429 限流、并发复用、AI 单条、批量与部分缓存请求，再验证面板概览（成功率、复用率、平均与最长耗时）、服务表现排序、失败原因、请求记录的来源/状态筛选与最慢排序、服务与今日筛选、趋势指标切换、1440/1024/820/390 与深色布局、英文界面无中文残留，以及清除确认后三张统计表清空。免费链会请求公共接口，因此线路表使用写入本次临时 profile 的线路汇总夹具，验证线路排序与无成功尝试线路的排位。报告同时检查统计库只含数值与标识字段、窗口位置、前台应用和控制台错误。夹具耗时只用于构造分布，不代表真实服务速度。

## 移除和添加回翻译服务（issue #1201）

- 新配置的 Runcrate、CloudGPU、Cheaper Inference、cheapaimodel 和 Standard Compute 默认出现在“恢复已移除服务”；旧配置只迁移一次，没有凭据、服务选择或自定义设置的目标服务才默认移除。恢复后重开设置和规范化配置仍保持启用。
- 在服务目录检查行尾的 **×** 悬停无气泡，点击后须确认才移除。覆盖默认、普通、自定义与组合服务，检查移除默认服务前显示接替项，最后一项可用服务无法移除。
- 验证移除项从主目录和搜索结果中消失。打开**自定义服务**，选择**恢复已移除服务**，搜索并选中移除项。点击**添加服务**后，服务恢复显示并保留原密钥、模型和各功能选择。没有移除项时，窗口仅显示兼容接口和组合翻译。两种操作都要检查取消或按 Esc 保留原状态，重开设置页后检查持久化，并验证七语和窄屏布局。
- 验证 popup、各功能、文档与侧栏选择器不重新选用关闭服务；已有独立选择保留并提示。单条、批量、字幕、阅读与写作请求在 provider 或 transport 前拦截，关闭状态不能由缓存绕过。
- 组合路由跳过关闭成员，全部关闭时明确失败；编辑组合保留成员和顺序。免费池的权重与请求同样排除关闭成员，不重新启用默认池；重新启用后能翻译、恢复并再次翻译。
- 单元与实际组件测试使用 `serviceCatalog`、`serviceDirectoryLifecycle`、`settingsSectionsLifecycle`、`popupServicesLifecycle`、`serviceEditorLifecycle`、`documentAppLifecycle`、`translationBroker`、`compositeTranslationBroker`、`translateApiPerformance`、`free-translation`、`writingCore`、`writingRuntime` 和 `harnessModelGateway`。真实浏览器按运行时诊断门禁另存证据。

## 悬浮球边距（issue #1225）

`model`、`configDiff` 和 `googleDriveConfig` 验证默认/弹出边距的有符号整数规范化、旧配置默认值、px 差异摘要及备份恢复。`floatingBallLifecycle`、`contentUiRuntime` 和 `i18nSettingsCopy` 验证左右停靠、两种边距相等时不移动、非悬停模式只使用默认边距、实时配置和七语数值控件。

生产浏览器回归应覆盖左右两侧的负值、零和正值，悬停展开期间的连续命中，常驻模式旁边的网页按钮不被透明连接区阻挡，以及同一点点击完成翻译—恢复—再次翻译。额外检查普通关闭后的数值持久化、390px 设置页与 44px 触屏目标；本地微软响应及触屏模拟不代表真实供应商或手机实机验收。

## 划词窗口拖动与缩放（issue #525）

同一浏览器几何专项会双击英文单词，延迟返回受控词典和译文，检查选中行间距、整卡滚动、关闭按钮、八次稳定采样和视口放大后的恢复；`--zoom-only` 补验 50%、100%、200% 与预设缩放加载。

自动卡片避让完整选区的回归见 `selectionTranslatorCore` 与 `selectionTranslatorLifecycle`：覆盖两侧都放不下时的限高、可见视口外的旧锚点、异步内容扩高与缩小、尺寸观察器合帧和卸载、视口变化时合帧重测换行后的完整 Range、视口变大后的限高释放，以及手动拖动后停止自动重定位。极矮视口或选区占满纵向空间、连关闭按钮都放不下时，沿用整卡滚动的可见性退化；正常视口中某一侧不足 140px 时也让整卡滚动，避免标题或正文被裁掉。真实几何与滚动须结合生产浏览器证据，不把受控 DOM 测试当作 CSS 布局验收。

`node scripts/run-selection-trigger-test.cjs --geometry-only --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <浏览器测试技能>/scripts/focus-safe-browser.cjs --runtime-diagnostics <浏览器测试技能>/scripts/runtime-diagnostics.cjs --artifacts-dir /private/tmp/fluentread-selection-geometry` 使用临时 Edge profile 和第二屏后台窗口，检查顶部与内容空白处拖动、八个方向缩放、自动换行、正文选择、复制、滚动后位置保持、最小尺寸和视口边界，以及关闭、禁用、重新划词和迟到译文。截图涵盖放大、窄窗口和深色主题。页面及微软翻译响应为本地夹具，不代表真实供应商质量；窗口手势通过真实 CDP 输入执行。

## 划词语音栏与正文布局

生成语音和播放状态栏位于正文之后，带独立分隔线并按控件实际高度参与布局。自动尺寸卡片为底栏自然增高，达到当前位置的可用高度上限时正文滚动；手动调整过尺寸的卡片保留用户外框，正文独立滚动。停止后底栏收起，自动卡恢复自然高度。

针对该边界运行 `pnpm test tests/selectionTranslatorLifecycle.test.ts`。生产构建后运行 `node scripts/run-selection-speech-test.cjs --layout-only --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper scripts/testing/focus-safe-browser.cjs --runtime-diagnostics <扩展界面测试技能>/scripts/runtime-diagnostics.cjs --artifacts-dir <证据目录>`，验证等待生成、播放、停止和重播、原文与译文切换、窄屏与深色，以及手动缩小卡片后正文末尾和操作按钮仍可访问。断言正文滚动区域不与底栏相交，所有播放按钮完整位于底栏内；自动卡未到高度上限时不得因语音栏出现而压缩正文。测试使用临时后台 Edge 和确定性翻译/WAV 夹具，不能代替外部语音合成质量或 Firefox 实机验证。
