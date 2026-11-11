# Popup、侧栏与工具栏

[返回测试入口](../testing.md)。按本次改动选择下面的专项；这些条目不要求每次全部运行。

## 原生侧边栏文本翻译（issue #1160）

`translationSidepanel`、`sidepanelBootstrap`、`sidepanelApp`、`translationCenterComponent` 和 `popupAppLifecycle` 验证按标签页或窗口原生打开、点击手势、错误重试、配置准备、页面退出取消与共享工作台。新版 Chromium 可能缓存关闭的面板，工作台在进入 hidden 时停止请求；同一实例重开保留输入与已有结果，不自动重启翻译。页面销毁或刷新后内容消失，不写入配置。`verify:extension-manifests` 同时检查 Chrome 的唯一 `sidePanel` 权限和无全局默认注册，以及 Firefox 的 `sidebar_action`、安装时不自动展开和不声明 Chromium 权限。

侧栏专用布局只由原生入口引入。`userscriptTranslationCenterBuild` 使用真实 SFC 验证构建时保留设置页的多服务对比、裁剪不可用的原生展示，并检查文字、注释和其它组件不被改写；交付还需执行 `pnpm test:userscript:standalone`，沿用现有体积上限。

生产 Chrome 构建后运行：

```bash
node scripts/testing/run-sidepanel-translation-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --browser-path <Chromium浏览器可执行文件> \
  --playwright-root <Node包目录> \
  --focus-safe-helper <扩展界面测试技能>/scripts/focus-safe-browser.cjs \
  --runtime-diagnostics-helper <扩展界面测试技能>/scripts/runtime-diagnostics.cjs \
  --artifacts-dir <证据目录>
```

新版 Chrome 使用 `--load-via-cdp`，由调试 API 载入扩展；支持启动参数加载扩展的 Edge 不加该参数。两者均使用第二屏正常尺寸后台窗口和临时 profile。专项从扩展页面中的真实点击打开原生面板，验证输入、翻译、受控复制、停止与关闭时中断上游请求、迟到结果隔离、重试、切换网页保持内容、缓存实例重开不自动继续请求、原生尺寸与 320×480 仿真视口。多服务场景配置 16 个本地供应商，验证模型搜索、多选保存、3 份译文的服务/模型归属、逐份复制、菜单内部滚动，以及设置页重开后保留同一份选择。复制端口只记录文本，不改系统剪贴板；翻译使用本地 HTTP 供应商，不代表在线翻译质量、原生工具栏 popup 或 Firefox 实机验收。

加 `--scope-only` 可专项验证 #1297：切换标签页时隐藏、返回时恢复或手动重新打开、设置持久化、窗口内共用面板，以及切回标签页模式时清理旧窗口面板。Edge 的自动恢复限制见 [Microsoft 文档](https://learn.microsoft.com/microsoft-edge/extensions/developer-guide/sidebar)。

浅色与深色同时检查 DOM 配色和截图像素。部分旧版 macOS Edge 曾出现[原生侧栏强制反色问题](https://github.com/microsoft/MicrosoftEdge-Extensions/discussions/204)，不能仅凭计算样式正确就判定通过。原生面板从 target 被发现时开始附着诊断，附着前的启动空窗和所测浏览器版本必须保留在报告中。

版本标签触发的安装包发布、全部交付目标、完整测试门禁及手动演练见 [自动发布安装包](../maintainers/releases.md)。发布脚本的 Node 夹具由 `processRegression.test.ts` 登记，覆盖版本一致性、缺失/损坏产物、附件摘要、草稿恢复和公开 Release 禁止覆盖等行为。

## Popup 首次打开与语言引导

生产构建后运行 `node scripts/testing/run-popup-first-run-height-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <捆绑Node包目录> --browser-path <Edge可执行文件> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-popup-first-run`。配置等待结束后应直接显示单屏语言选择，省去欢迎、下一步、返回和固定完成动画，高度随内容自适应。短视口检查在扩展标签页里模拟工具栏的当前标签查询，验证内容可以撑开，避免重现 130px 高度锁定。

Safari 工具栏弹窗可能关联当前网页的标签 ID。布局判别使用 WebKit 扩展视图类型，工具栏保留内容的固有尺寸，独立标签页按视口收窄并在面板内滚动。验证时分别检查工具栏的首次打开和重开、独立标签页以及触摸宿主的填宽行为。

语言页按所选宽度和深色主题检查七种语言原生名称、确认按钮可见、无横向溢出及内部裁切；选择只预览，保存等待期间控件冻结，保存确认成功后立即进入主菜单，重开不重复引导。脚本使用独立临时 Edge profile 与第二屏后台窗口，保存启动帧尺寸、布局指标和截图；`--baseline` 仅记录旧布局，不代表新验收通过。此证据不包含系统工具栏点击到 Popup 创建的延迟，也不代表 Firefox 实机或商店版本验证。

追加 `--confirm-language es-ES --fail-main-once` 可验证其他界面语言的真实按需资源、确认后的主菜单加载失败、重试和重开持久化。仅在本次临时 profile 中阻断一次主菜单模块请求，报告单独保留注入的网络错误；重试会重新打开文档，避免浏览器缓存失败的模块 import，已保存的语言不能丢失。

启动性能对照使用 `node scripts/testing/run-popup-onboarding-performance-test.cjs --extension-dir .output/chrome-mv3 --cold-worker --expect-lightweight --artifacts-dir /private/tmp/fluentread-onboarding-performance`。同一个隔离 Edge 实例分别采样七次未完成引导的单屏语言页与七次普通菜单，通过 CDP 确认各阶段首次采样的后台已停止；记录配置消息耗时、首屏 DOM/下一帧时间、实际解析脚本字节和布局。`--expect-lightweight` 断言首启未解析完整主菜单、未读取完整英文包，主配置只读取一次；旧包对照省略此参数。HTML 在 Vue 模块加载前通过无依赖脚本发送 `popupStartup` 提前唤醒后台，只获取引导是否完成的布尔提示，用于并行预取模块。实际界面始终由 store 新读配置后决定。单独加 `--stale-startup-hint`（省略 `--expect-lightweight`）会反转两种状态的后台提示，验证过期提示只能多加载候选模块，不能决定最终显示页面。普通菜单配置、首帧主题与保存退出专项可用 `run-popup-startup-ui-test.cjs --startup-only --opens 2` 限定启动与持久化范围。

## Popup 操作恢复与翻译服务 UI

首次翻译与自助恢复主流程使用 `run-self-help-ui-test.cjs --extension <生产产物> --artifacts <新证据目录> --playwright-root <捆绑Node包目录> --locales true --refresh-rounds 3`，保留真实故障、重试、取消、报告导出与七语场景。默认诊断只显示翻译按钮预留区域内的 24px 状态入口，脚本断言原因浮层、恢复动作和报告尚未挂载；所有动作和报告必须先通过入口展开，Escape 收起并还原焦点。认证、模型与限流故障出现前后，脚本比较网站开关、模式按钮和后续模块的位置，确认入口不遮挡按钮文字或其他控件。浮层不撑高翻译区，报告需再次明确预览后生成，关闭浮层与忽略诊断分别验收。使用稳定 `data-diagnostic-*` 选择器。此处仅说明验收契约，实际通过情况以当前产物报告为准。

`node scripts/testing/run-popup-actions-service-ui-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <捆绑Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-popup-actions-ui` 只运行本次 Popup、服务分配、划词抽屉及界面预览专项，不触发全量回归。

默认使用隔离 Edge。需要改用另一个已安装的 Chromium 浏览器时，显式传 `--browser-path <浏览器可执行文件>`；支持动态扩展加载的浏览器还可传 `--load-via-cdp`，用 `Extensions.loadUnpacked` 返回的准确 ID 打开清单页面，再核对扩展名称、版本和 Popup，不能拿浏览器自带的第一个 worker 猜扩展 ID。动态模式不混用旧的命令行扩展加载参数。测试页的 active-tab 查询夹具同时保留 Promise 和 callback 契约，仍返回真实本地网页标签；不改变产品 API 或关闭焦点保护。

仅调整底部开源入口样式时，追加 `--footer-only`，只复核浅深色、简洁/紧凑/月白皮肤、悬停和设置预览中的开源胶囊，不重复服务选择与翻译流程。

仅检查 Popup 窄版与悬停、划词、图片三个快捷面板时，追加 `--density-only`。以页面内在尺寸模拟工具栏视口，检查浅深色、简洁/紧凑/月白和英文界面的主屏与三个面板：没有横向溢出，标题与首要开关首次可见，所有按钮可通过键盘聚焦进入可见范围。记录 `scrollHeight`、`clientHeight` 和实际滚动；长文案与额外方案允许内部滚动，不能用裁切隐藏内容。还覆盖无搜索装饰但可搜索的语言框、悬停/圈选示意、额外悬停方案、关闭重开后恢复快捷键与划词模式、两个图片开关独立保存、连续写入最后值胜出，以及三个“更多设置”的实际导航。`--density-baseline` 仅与此专项组合用于记录旧产物布局，不包含新布局通过断言。

默认仍采用后台隔离窗口与真实前台 PID 保护，并额外持续采样前台应用；任何抢焦点检测立即停止并清理，不能通过禁用保护完成测试。若后台环境持续无法保持焦点隔离，先征得用户本次明确同意，才可追加 `--headed` 使用第二屏居中的独立临时前台窗口，报告中标记 `foreground-authorized`。快捷面板专项还检查关闭按钮距滚动体右沿至少 8px，避免 macOS 覆盖式滚动条遮住控件。新快捷面板的追加验收及历史边界见[窄版与快捷面板记录](../reports/popup-ui-restoration-20260930/quick-panel-refinement.md)。

使用第二屏可见但不抢焦点的临时 Edge profile，检查真实内容脚本的全文翻译—恢复—再次翻译、局部点选、站点规则立即关闭重开、每个可用服务及九项功能分配、继承和自定义模型搜索、当前服务留在常用服务、更多服务默认展开且可收起、搜索框随列表滚动、本地图标及键盘导航。还检查版本、赞赏、开源胶囊的新标签页导航、默认白底、无域名的两个紧凑站点开关、翻译服务选择框、划词说明宽度、设置预览横排图标、390px 窄屏、深色及多种皮肤、配置跨页同步和控制台错误。

Popup 赞赏窗口内的微信二维码点击后原位从 164px 放大到 200px，再次点击还原，关闭重开恢复默认大小。二维码按钮支持 Enter 与空格键，提示和可访问名称随状态切换；验证过程中页面地址与标签页数量应保持不变，浅深色和窄版布局不得产生横向溢出。

测试页只替换工具栏 Popup 的 active-tab 查询，返回一个真实本地网页标签；翻译使用本地确定性 OpenAI 兼容端点，错误分支和 GitHub 导航使用明确标注的响应夹具。不证明外部翻译服务、Firefox 实机或商店发布。完成后检查报告中的全部截图，并保存逐项复核结论；见[本次报告](../reports/popup-ui-restoration-20260930/README.md)。

## 工具栏一键翻译（issue #1315）

在通用设置选择“翻译 / 显示原文”，确认关闭并重开设置页后仍保留选择，原生 `getPopup` 返回空字符串。通过 `action.onClicked` 生产监听验证翻译、恢复、连续点击、独立标签页和后台冷启动；普通网页仅向顶层 frame 发送既有全文命令，关闭悬浮球或网页右键菜单仍可使用。导航后不能执行旧文档的排队动作。原生 PDF 沿用文档阅读器，扩展关闭或网页不可注入时保留面板入口。

右键工具栏图标的“打开快捷面板”独立于网页右键菜单开关，以 `sourceTabId` 绑定发起网页。测试需核对打开面板后的来源与翻译目标；切回“打开快捷面板”后原生 popup 恢复。Firefox 使用 `browserAction` 与 `browser_action` 菜单上下文；单元测试和构建不代表 Firefox 原生工具栏实机通过。

## 工具栏翻译状态

`node scripts/testing/run-toolbar-status-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-toolbar-status` 使用生产扩展、临时 Edge profile 和第二屏后台窗口，检查原文、等待、完成、恢复、服务失败、原地重试、标签页切换和刷新。页面与供应商响应均为本地夹具，不代表外部服务质量。

报告中的 `toolbarStatus` 是内容脚本的真实结果状态；原生文字角标分别为翻译中 `…`、完成 `✓`、失败 `!`，空闲时清空，工具栏底图保持品牌原图。页面截图不包含浏览器工具栏；可选 `--window-query <可执行文件>` 接收一个输出匹配测试窗口的 CoreGraphics 窗口字典 JSON 数组的只读工具，追加原生窗口截图。该套件不强制重启 worker；不能把普通标签页切换或状态查询单测当作真实后台重启证据。

原生角标尺寸、内边距及字形由浏览器管理；使用蓝色、深绿色和橙色实心底色，并在 API 可用时指定白色文字。静态状态 PNG 不再用于运行时展示。`tests/translationToolbarStatus.test.ts` 验证真实状态判定，`tests/backgroundBadgeRuntime.test.ts` 验证角标映射、导航清理、异步顺序及 MV2 回退。

角标直接替换状态文字，不在每次更新时先清空标识或重载底图；相同状态的在途更新合并为一次写入。完成或失败后的补译等待超过 180ms 才显示省略号，快速补译保留已显示结果；会话内候选扫描与入队之间的短暂空队列也等待 180ms 再清空标识。恢复原文、禁用和关闭取消迟到的状态标识。`tabs.onUpdated` 的 loading/complete 也可能来自同文档 History 更新或子 frame 加载，角标在这两种事件后向顶层内容脚本回源，而非直接清空；真正导航到原文页面后仍清空。加载结束会强制校准原生角标，避免浏览器重置后被本地同态缓存跳过。

角标回归还覆盖各角标异步写入步骤中“完成 → 翻译中 → 完成”、底图初始化中恢复原文、迟到的完成文字与恢复原文、部分写入失败后重画原状态，防止缓存去重跳过被中断后必需的更新。另覆盖 loading 查询迟到于导航完成、恢复原文和关闭，旧回复不得复活完成状态。浏览器专项逐状态断言原生文字、背景色与可用时的文字颜色，并记录真实 action 调用，检查完成后的动态样式重扫零重绘、新增正文正常补译且没有清空角标或重载底图。翻译中、完成和失败三种状态还分别执行不改变地址的 `history.replaceState` 以及空 iframe 加载/重载，验证角标不被清空、无需内容脚本再次推送且供应商请求数不增加。此用例对应滚动保存位置的 Astro 页面，回归不依赖真实 AI 服务。

FluentRead 把测试按意图分组，而不是把所有文件塞进一个难以诊断的命令。每个 `tests/**/*.test.ts` 必须且只能出现在 `tests/test-matrix.json` 的一个分组中；测试审计会拒绝漏归类、重复归类、重复用例名、`.only`、无原因 `.skip` 和覆盖率忽略指令。

### AI SDK 共享限流冷却

`pr906SchedulerAudit` 验证 OpenAI 兼容 SDK 线路的 429／503 `Retry-After` 秒数、日期、毫秒头、无效头回退、最长等待、时钟回拨、健康线路绕行，以及真实 HTTP attempt 的取消、deadline 和动态并发限制。`pr906SdkAudit` 使用真实 SDK 与内存 HTTP 夹具，检查响应体未结束时超时仍占槽、不同 Key 或可信私密来源不继承其他额度的冷却，以及轮询与有效重试策略的 pending 隔离。`pr906PrivacyAudit` 检查输入框显式预算与真实隐私来源同时保留、图片入口在 ready 前冻结文本和 sender、内部取消 symbol 以及图像实际模型身份。

```bash
pnpm test tests/pr906SchedulerAudit.test.ts tests/pr906SdkAudit.test.ts tests/pr906PrivacyAudit.test.ts tests/translationRequestScheduler.test.ts tests/aiSdkOpenAICompatible.test.ts
```

这些测试不调用在线供应商；生产 Chrome、Firefox 和 userscript 构建检查用于确认共享代码可发布，不能替代真实接口或 Firefox 实机验收。

标准 userscript 复用已有 `francDataPlugin` 压缩锁定的 franc-min 纯模型字符串，通过已有 pako 端口同步恢复；`userscriptViteConfig` 对四种构建模式和全部 66 个模型的字符串、属性顺序及 Unicode 字节逐项检查。算法、模型内容、许可和 Greasy Fork 固定资源不变，普通产物继续通过原体积预算与兼容性 verifier。

standalone 的中英文消息目录采用键值分列；英文键列与默认中文逐项同序时复用中文已还原的键，键不一致则保留完整列。中文虚拟模块通过局部 provider 发布不可变键副本，英文仍按需解包；不引入核心 i18n 的反向依赖。合法旧对象与完整列、标准脚本、Greasy Fork 数据和固定远程 JSON 保持原格式。显式列与共享列都检查长度和字符串类型，损坏列会被拒绝，失败不替换有效键；重复键及特殊属性沿用 `Object.fromEntries` 语义。

运行 `pnpm test tests/userscriptLanguageBundles.test.ts tests/userscriptViteConfig.test.ts`。真实 Vite 消费者夹具在未预热 provider 时，沿 loader、核心 i18n、中文虚拟模块完成初始化并加载英文，核对模块唯一性、逐 key 文案与零语言请求；另外覆盖键不等回退、旧格式、Unicode、模板顺序、失败重试及五语离线缓存。2026-10-24 的配对构建将 standalone 从 3,619,122B 减至 3,598,956B，中英文完整数据还原后字节一致，其余 35 份 gzip 资源保持一致。原 3,600,000B 门禁通过，余量为 1,044B；CI 同时构建并校验标准和 standalone 产物。provider 额外保留一份有序键引用，实际堆占用和浏览器启动表现未量化；这些构建和 Node 夹具不代替脚本管理器验收。

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

菜单栏启动时并行读取配置与加载界面组件；快捷抽屉在首次打开时加载，语言选择器关闭时只显示当前语言，不挂载完整选项列表。中文界面跳过旧文案的无效 DOM 扫描，从其他界面语言切回中文时仍执行一次恢复。

性能对照使用 `node scripts/testing/run-popup-performance-test.cjs --extension-dir .output/chrome-mv3 --artifacts-dir /private/tmp/fluentread-popup-performance --verify-ui`。每次运行创建临时后台 Edge profile，通过扩展图片文档和真实配置协议完成准备，避免先加载 popup/options 脚本；记录首次菜单文档、另外六次打开的 DOM 就绪与下一帧时间、布局/脚本时间、实际解析脚本字节和隐藏选项数量。`--verify-ui` 另验证语言搜索、键盘选择、Escape、关闭菜单时的配置同步、界面语言往返切换与重开持久化。

全文响应性对照使用 `node scripts/testing/run-translation-responsiveness.cjs --paragraphs 1500 --cpu-rate 4 --repeat --artifacts-dir /private/tmp/fluentread-responsiveness`，记录翻译、翻译后滚动、恢复原文、缓存重译的长任务、心跳间隔和宿主点击，断言中文目标下的中文技术说明保持原样且不发送请求。`--github` 改为验证中文 README 与 Issues 实际页面的翻译—恢复—再次翻译。均使用临时后台 Edge 与本地固定译文，执行时应通过资源安全包装器；依赖路径、基线开关及证据边界见[响应性报告](../reports/translation-responsiveness-20260929/report.md)。

对照前后产物需分别运行并保留截图，明确区分首次安装引导页与已完成引导的主菜单。首次文档数据包含冷脚本加载，但不包含用户点击浏览器工具栏到文档创建的耗时。追加 `--cold-worker` 会在首个菜单导航前停止隔离实例的 Service Worker，并等待协议确认 stopped 后再采样，让首个配置请求重新唤醒后台；报告以 `coldWorkerStopped` 区分这项证据。不要把一次采样或重复打开的中位数当作所有机器的冷启动承诺。

设置中心生产 UI 矩阵同时检查 Popup 的内部滚动范围：短面板保持内容自适应高度，长面板在 600px 内可滚到底且底栏完整可见，之后恢复滚动位置。短文案和长文案均不得产生内部横向滚动；简约皮肤窄屏底栏的负边距必须与容器内边距一致，不能用外层裁切掩盖越界。失败时保留即时与等待过渡结束后的 DOM 尺寸和截图。

```bash
node scripts/testing/run-popup-startup-ui-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <path> \
  --focus-safe-helper <path> \
  --skin shuimo \
  --artifacts-dir /private/tmp/fluentread-popup-startup
```

该回归在临时 Edge profile 中逐帧记录可见界面，并注入配置读取延迟来放大竞态窗口；快捷抽屉用例另检查悬停、划词和圈选抽屉打开时焦点进入抽屉、关闭后回到对应卡片，且 Popup 解析的脚本源码不包含只属于完整设置页的快捷键编辑器；报告同时保留正常打开的首个正确帧时间、挂载次数与 DOM 变更计数。对照旧产物时可传 `--expect-flash --skin emoji`，确认用例确实能发现旧版默认界面先绘制的问题。延迟注入数据不能当作正常启动耗时。

快速关闭用例冻结首条保存给 Popup 的回执，让第二次修改确定停留在页面内的队列，再立即关闭。报告必须证明关闭前已向后台交接包含未确认前驱的补丁链，关闭后最终选择仍被保存，且无修改关闭时普通保存与批量交接消息均为零。配置服务和后台处理器另验证前驱在途、已提交去重、字段冲突拒绝及失败后的接续边界。

加载动画另由 `scripts/testing/run-loading-motion-ui-test.cjs` 验证，使用相同的扩展目录、Playwright 与 focus-safe helper 参数。它在测试页面保留 closed ShadowRoot 句柄，检查 15 种动画的真实运动、关闭与系统减少动态效果后的静态反馈，并验证同一文档只解析一份共享样式表。采样窗口覆盖包含停顿的完整动画周期，避免把沙漏停顿误判为失效；跨文档样式隔离与旧浏览器的安全回退也有独立断言。

