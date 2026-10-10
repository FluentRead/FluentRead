# 测试与回归

## 共享 Retry-After 冷却

`pnpm test tests/translationRetryAfter.test.ts tests/translationRequestScheduler.test.ts tests/aiSdkOpenAICompatible.test.ts tests/translationBroker.test.ts` 通过真实客户端、broker、调度器和锁定的 AI SDK 6.0.264，使用严格拒绝未匹配网络的 `setRuntimeFetch` 夹具验证 HTTP attempts。覆盖数字、HTTP-date、毫秒头、2/60/90 秒、无效及极端值、deadline、取消、真实 transport settle 后释放 lease、健康服务隔离、可信普通/私密来源以及端点、模型和凭据切换。30 个固定 seed 重放相同到达时序；少量真实 timer 验证集成，不调用外部 API。

429 的有效服务端等待作用于同 quota；缺失或无效头使用 SDK 原有的首个 2 秒退避。503 只在有效 Retry-After 下共享冷却，401/403 不引入冷却或新重试。状态只在内存保存后台冻结配置的摘要并在到期清理，不增加设置、重试次数、持久统计或跨服务 global 冷却。SDK 对大于等于 60 秒的头可能回退到 2 秒，本地共享门控仍等待服务端时点或原有 deadline。此项是确定性 mock 验证，不能视为真实服务提速。

## 扩展体积与共享推理引擎

`pnpm analyze:bundle [构建目录] [基线目录]` 统计真实字节、文件类型、目录、最大文件和相同内容，详见 [2026-10-06 体积记录](./maintainers/extension-size-20261006.md)。普通开发构建不内联源码映射；需要时使用 `FLUENTREAD_DEV_SOURCEMAPS=1 pnpm dev`。手动加载可设置 `FLUENTREAD_DISABLE_BROWSER_RUNNER=1`。

以下专项使用自有临时 Edge profile、第二屏后台正常窗口与 focus-safe helper。Node 包目录包含 Playwright。`run-bundle-model-smoke.cjs` 通过源码实际端口和固定摘要校验运行 Paddle/LaMa，OPUS 使用实际构建 Worker；音频专项使用实际生产 Worker。受控图片/合成语音不代表真实网站音轨或模型整体质量。

```sh
node scripts/testing/run-ort-runtime-smoke.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root "$PLAYWRIGHT_ROOT" \
  --focus-safe-helper "$FOCUS_SAFE_HELPER" \
  --artifacts-dir /private/tmp/fluentread-ort-smoke

node scripts/testing/run-bundle-model-smoke.cjs \
  --kinds paddle,opus --extension-dir .output/chrome-mv3 \
  --manga-models-dir "$MANGA_MODELS_DIR" \
  --playwright-root "$PLAYWRIGHT_ROOT" \
  --focus-safe-helper "$FOCUS_SAFE_HELPER" \
  --artifacts-dir /private/tmp/fluentread-model-smoke

node scripts/testing/run-local-audio-gpu-test.cjs \
  --kinds tts,whisper --modes gpu,cpu,init-failure,device-loss \
  --skip-settings --no-screenshots --extension-dir .output/chrome-mv3 \
  --playwright-root "$PLAYWRIGHT_ROOT" \
  --focus-safe-helper "$FOCUS_SAFE_HELPER" \
  --artifacts-dir /private/tmp/fluentread-audio-smoke

node scripts/testing/run-local-audio-gpu-test.cjs \
  --kinds whisper --modes q4-failure --skip-settings --no-screenshots \
  --extension-dir .output/chrome-mv3 \
  --playwright-root "$PLAYWRIGHT_ROOT" \
  --focus-safe-helper "$FOCUS_SAFE_HELPER" \
  --artifacts-dir /private/tmp/fluentread-whisper-q8-smoke
```

`MANGA_MODELS_DIR` 必须包含与源码版本、字节数及 SHA-256 匹配的 `PP-OCRv6_small_det.onnx`、`PP-OCRv6_small_rec.onnx`、`ppocrv6_dict.txt`、`lama-manga-dynamic.onnx`；文件只导入本次临时扩展。`--kinds opus` 无需这些文件。OPUS 和音频专项会联网下载公开模型。q4 故障仅注入自有扩展副本的 CPU q4 初始化调用，必须实际返回 `dtype=q8` 才通过；不修改生产产物或用户扩展。

## 本地推理响应、转圈与跟读

本轮诊断、资源策略、CPU/GPU 对照与验收边界见[本地推理可靠性报告](./maintainers/local-inference-reliability-20261006.md)。漫画性能模式用同一原图、提前导入已校验模型和固定文字传输；`--worker-diagnostics` 只修改临时扩展副本，记录真实 GPU 提交与 pthread 创建。`--pipeline-cpu` 强制禁用 GPU，不将能力探测当作实际后端证明。

```sh
pnpm test tests/localInferenceResources.test.ts tests/mangaInferenceClient.test.ts tests/mangaInferenceWorker.test.ts tests/selectionTranslatorLifecycle.test.ts tests/offscreenTtsPlayback.test.ts tests/speechProgress.test.ts tests/localTranslationRuntime.test.ts tests/videoAiOffscreen.test.ts
node scripts/testing/run-local-audio-gpu-test.cjs \
  --kinds tts --modes gpu,cpu --skip-settings --no-screenshots \
  --artifacts-dir /tmp/fluentread-audio-playback
```

音频专项验证实际 WAV 解码、媒体时钟推进、进度和结束清理；默认静音测试播放。需要双线程能力对照时仅在临时副本增加 `--cross-origin-isolated --modes unavailable,thread-failure`，不更改生产 manifest。线程创建故障注入和实际 GPU 不可用情况分别记录；真实设置页、扬声器和 Firefox 实机音频不在这个限定命令的验收范围内。

划词朗读的整词高亮与前后 5 秒跳转使用独立专项：

```sh
pnpm test tests/speechProgress.test.ts tests/offscreenTtsPlayback.test.ts tests/selectionTtsBackgroundHandler.test.ts tests/offscreenMessageRouter.test.ts tests/offscreenAdapters.test.ts tests/selectionTranslatorLifecycle.test.ts tests/selectionTtsProtocol.test.ts tests/selectionTtsContentController.test.ts
node scripts/run-selection-speech-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <Node包目录> \
  --focus-safe-helper <扩展界面测试技能>/scripts/focus-safe-browser.cjs \
  --artifacts-dir /private/tmp/fluentread-selection-speech
```

浏览器专项加载生产扩展，在第二屏临时 Edge 后台窗口运行；翻译与语音响应使用确定性夹具，但音频解码、媒体时钟、跳转及跨后台路由真实执行。验证完整词高亮、文字节点与换行稳定、跳转不重新合成、浅色/深色/390px 布局、减少动画和停止清理；保存 `report.json` 与卡片截图。它不证明在线发音对齐、扬声器输出或 Firefox 实机行为。

## 设置分组、阅读辅助与右键菜单

右键菜单后台恢复专项：`pnpm test tests/contextMenuRuntimeOwnership.test.ts tests/contextMenu.test.ts tests/backgroundBadgeRuntime.test.ts tests/contentMessageRuntime.test.ts`。受控浏览器端口覆盖 MV3 后台冷启动首击等待配置与菜单就绪、活动页查询暂时失败后的点击、导航/关闭/禁用期间丢弃旧点击，以及失败重试和翻译—恢复—再次翻译。菜单已创建后，活动页查询失败不会清空点击路由。该专项不代表操作系统原生菜单、报告者环境或在线供应商验收。

生产扩展构建后，运行 `node scripts/testing/run-settings-reading-menu-ui-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <扩展界面测试技能>/scripts/focus-safe-browser.cjs --artifacts-dir <证据目录>`。专项使用第二屏上的临时 Edge 后台窗口，检查阅读辅助左侧预览与右侧设置、完整说明、虚线、高亮联动与样式跳转，右键菜单左侧单一虚拟菜单与右侧紧凑选项、所有启用入口的实时增删、功能前置条件禁用、总开关禁用和重开后保存；覆盖七种语言的桌面与 390px 布局、深色主题和其他设置分组标题。浏览器范围为 Edge，不代表 Firefox 实机或外部翻译服务。

`run-settings-section-navigation-test.cjs` 检查连续表单中的完整导航、搜索、跨页定位、折叠、键盘与滚动高亮。翻译设置分别登记右键菜单、悬浮球进阶设置、段落复制、局部翻译与不翻译的语言；最后一组较短时，滚动到底仍应高亮其入口。元数据与既有直达链接由 `tests/optionsNavigation.test.ts` 和 `tests/optionsAppNavigationLifecycle.test.ts` 验证。

## 设置布局与控件交互

`node scripts/testing/run-settings-layout-polish-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <捆绑 Node 包目录> --focus-safe-helper <focus-safe-browser.cjs 路径> --artifacts-dir <证据目录>` 使用独立临时 Edge profile 与第二屏后台窗口，验证阅读辅助的左右布局与窄屏上下排列、学习程度对齐和保存、请求限制继承及自定义值、统一下拉菜单、说明提示的关闭延迟和文字选择，以及识图检测成功只显示一次而保留失败和取消反馈。

朗读来源、在线音色与本地模型集中在一个设置框中。仅在线收起本地选项，仅本地收起在线选项；切换来源保留原来的音色偏好。图片的识别方式与入口、漫画的预翻译与按钮和缓存分别位于对应预览右侧；共享识别资源集中在一个设置框，优先展示当前识别方式和准备状态；备用 Tesseract 默认收起，切换为当前方式时自动展开。语言包列表与下载来源、离线导入采用次要展开入口，进行中的任务或错误会自动展开。专项覆盖中文和英文、浅色和深色、1440/1024/820/390px 布局。识图检测只连接本机图片响应夹具，不证明真实供应商能力；测试不下载朗读或识别模型，不代替 Firefox 实机验收。

## 官网网页与漫画翻译演示

点击官网示例的第二步，会先显示翻译中的转圈与段落占位动画，或漫画气泡的扫描动画，随后展示译文并停留在结果。重复点击可重新演示；底部按钮可暂停、继续和重播。系统开启减少动态效果时，点击第二步直接展示结果。

执行 `pnpm docs:typecheck`、`pnpm docs:build` 后，运行 `node scripts/testing/run-site-demo-loading-test.cjs --playwright-root <Node包目录> --browser-path <Edge可执行文件> --output /private/tmp/fluentread-site-demo-loading`。专项使用隔离无窗口浏览器，不访问用户 profile，检查中英文首页在 1440、390、320px 宽度下的自动播放、真实点击、CSS 动画运动、逐段显示、完成停留、重复触发、暂停继续、跳转与重播，以及减少动态效果和其他演示的步骤控制。报告与截图保存到指定目录；只验证官网本地示例，不调用扩展或真实翻译服务。

## Popup 首次打开与语言引导

生产构建后运行 `node scripts/testing/run-popup-first-run-height-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <捆绑Node包目录> --browser-path <Edge可执行文件> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-popup-first-run`。只检查首启相关范围：配置读取延迟 1.2 秒时，等待状态与欢迎页高度一致，首个欢迎帧已有双语文字且不请求完整英文目录，卡片没有缩放入场。短视口还检查高度由内容撑开，避免重现 130px 高度锁定。

语言页覆盖 280、320、360、400px 宽度和深色主题，确认七个完整双语名称、末项占满整行、确认按钮可见、无横向溢出及内部裁切；逐项选择、返回欢迎页保留选择、确认和重开后不重复引导。脚本使用独立临时 Edge profile 与第二屏后台窗口，保存启动帧尺寸、布局指标和截图；`--baseline` 仅记录旧布局，不代表新验收通过。此证据不包含系统工具栏点击到 Popup 创建的延迟，也不代表 Firefox 实机或商店版本验证。

追加 `--confirm-language es-ES --fail-main-once` 可验证其他界面语言的真实按需资源、确认后的主菜单加载失败、重试和重开持久化。仅在本次临时 profile 中阻断一次主菜单模块请求，报告单独保留注入的网络错误；重试会重新打开文档，避免浏览器缓存失败的模块 import，已保存的语言不能丢失。

启动性能对照使用 `node scripts/testing/run-popup-onboarding-performance-test.cjs --extension-dir .output/chrome-mv3 --cold-worker --expect-lightweight --artifacts-dir /private/tmp/fluentread-onboarding-performance`。同一个隔离 Edge 实例分别采样七次未完成引导的欢迎页与七次普通菜单，通过 CDP 确认各阶段首次采样的后台已停止；记录配置消息耗时、首屏 DOM/下一帧时间、实际解析脚本字节和布局。`--expect-lightweight` 断言欢迎页未解析完整主菜单、未读取完整英文包，主配置只读取一次；旧包对照省略此参数。HTML 在 Vue 模块加载前通过无依赖脚本发送 `popupStartup` 提前唤醒后台，只获取引导是否完成的布尔提示，用于并行预取模块。实际界面始终由 store 新读配置后决定。单独加 `--stale-startup-hint`（省略 `--expect-lightweight`）会反转两种状态的后台提示，验证过期提示只能多加载候选模块，不能决定最终显示页面。普通菜单配置、首帧主题与保存退出专项可用 `run-popup-startup-ui-test.cjs --startup-only --opens 2` 限定启动与持久化范围。

## Popup 操作恢复与翻译服务 UI

`node scripts/testing/run-popup-actions-service-ui-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <捆绑Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-popup-actions-ui` 只运行本次 Popup、服务分配、划词抽屉及界面预览专项，不触发全量回归。

默认使用隔离 Edge。需要改用另一个已安装的 Chromium 浏览器时，显式传 `--browser-path <浏览器可执行文件>`；支持动态扩展加载的浏览器还可传 `--load-via-cdp`，用 `Extensions.loadUnpacked` 返回的准确 ID 打开清单页面，再核对扩展名称、版本和 Popup，不能拿浏览器自带的第一个 worker 猜扩展 ID。动态模式不混用旧的命令行扩展加载参数。测试页的 active-tab 查询夹具同时保留 Promise 和 callback 契约，仍返回真实本地网页标签；不改变产品 API 或关闭焦点保护。

仅调整底部开源入口样式时，追加 `--footer-only`，只复核浅深色、简洁/紧凑/月白皮肤、悬停和设置预览中的开源胶囊，不重复服务选择与翻译流程。

仅检查 Popup 窄版与悬停、划词、图片三个快捷面板时，追加 `--density-only`。以页面内在尺寸模拟工具栏视口，检查浅深色、简洁/紧凑/月白和英文界面的主屏与三个面板：没有横向溢出，标题与首要开关首次可见，所有按钮可通过键盘聚焦进入可见范围。记录 `scrollHeight`、`clientHeight` 和实际滚动；长文案与额外方案允许内部滚动，不能用裁切隐藏内容。还覆盖无搜索装饰但可搜索的语言框、悬停/圈选示意、额外悬停方案、关闭重开后恢复快捷键与划词模式、两个图片开关独立保存、连续写入最后值胜出，以及三个“更多设置”的实际导航。`--density-baseline` 仅与此专项组合用于记录旧产物布局，不包含新布局通过断言。

默认仍采用后台隔离窗口与真实前台 PID 保护，并额外持续采样前台应用；任何抢焦点检测立即停止并清理，不能通过禁用保护完成测试。若后台环境持续无法保持焦点隔离，先征得用户本次明确同意，才可追加 `--headed` 使用第二屏居中的独立临时前台窗口，报告中标记 `foreground-authorized`。快捷面板专项还检查关闭按钮距滚动体右沿至少 8px，避免 macOS 覆盖式滚动条遮住控件。新快捷面板的追加验收及历史边界见[窄版与快捷面板记录](./reports/popup-ui-restoration-20260930/quick-panel-refinement.md)。

使用第二屏可见但不抢焦点的临时 Edge profile，检查真实内容脚本的全文翻译—恢复—再次翻译、局部点选、站点规则立即关闭重开、每个可用服务及九项功能分配、继承和自定义模型搜索、当前更多服务可见性、本地图标及键盘导航。还检查版本、赞赏、开源胶囊的新标签页导航、默认白底、无域名的两个紧凑站点开关、翻译服务选择框、划词说明宽度、设置预览横排图标、390px 窄屏、深色及多种皮肤、配置跨页同步和控制台错误。

Popup 赞赏窗口内的微信二维码点击后原位从 164px 放大到 200px，再次点击还原，关闭重开恢复默认大小。二维码按钮支持 Enter 与空格键，提示和可访问名称随状态切换；验证过程中页面地址与标签页数量应保持不变，浅深色和窄版布局不得产生横向溢出。

测试页只替换工具栏 Popup 的 active-tab 查询，返回一个真实本地网页标签；翻译使用本地确定性 OpenAI 兼容端点，错误分支和 GitHub 导航使用明确标注的响应夹具。不证明外部翻译服务、Firefox 实机或商店发布。完成后检查报告中的全部截图，并保存逐项复核结论；见[本次报告](./reports/popup-ui-restoration-20260930/README.md)。

## 划词行内代码与代码块（issue #704、#845）

`tests/selectionTranslatorCore.test.ts` 覆盖行内代码与正文混排、部分代码选区、多段代码、公式、代码空白、代码块和交互边界，以及只翻译正文和批量失败处理。生产构建后运行 `node scripts/run-selection-trigger-test.cjs --inline-code-only --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir <证据目录>`，在临时 Edge profile 的后台可见窗口验证图标、直接弹出和快捷键，检查原文/译文代码节点、宿主 DOM 不变、正文混排请求不含代码、复制反馈及改选后的迟到响应保护。用户主动选择纯代码、`pre` 代码块或高亮代码中的文字时，可使用同样的划词入口翻译；正文夹带行内代码时仍保留代码原文。可编辑代码区域、按钮和显式禁止翻译区域仍排除。

网页与微软批量响应为本地确定性夹具；此专项不代表真实供应商翻译质量或 Zen/Firefox 扩展运行时验证。

## 同目标语言跳过与统一语言判断

`src/core/language` 是全文、悬浮、页面标题、划词、快捷键和共享翻译客户端判断“文本已是目标语言或排除语言”的唯一入口。`codes.ts` 统一两/三字母代码、ISO 639-2/B、宏语言成员、旧别名、地区、脚本与下划线写法，目标语言和排除语言共用同一比较；配置中的裸 `zh` 仍为简体，检测器给出的裸 `zh`/`cmn` 只表示书写体系未知，不匹配任何简繁目标。`identify.ts` 只以文本为缓存键给出与目标无关的结论，目标、排除列表或源语言变化都会重新比较。

识别副本先由 `technicalTokens.ts` 遮蔽 URL、路径、文件名、哈希、版本号、带版本模型名（可带一个首字母大写后缀，如 `GPT-6 Sol`）、代码标识符和字母数字编号，原文、链接和 DOM 不变。非 Latin 正文中的缩写、内部大写名称和格式名按词计权，不能主导结论；普通外语词、首字母大写的独立词和三个以上连续全大写词按外语正文处理，因此夹带的外语句子仍会翻译。可信中文技术正文另按句查找代码、缩写、字段名或操作符表达式证据，只接纳有局部中文技术句架支撑的短术语（每项至多三词，表达式至多 128 字符）；名称权重仍不能压倒中文，功能词、引文、明确要求翻译/解释的外语与跨句证据不被吞掉。`tests/fixtures/chinese-technical-pr-906.json` 保存反馈页面的四段原文，`sameTargetLanguageRegression` 与 `sameTargetLanguageClient` 验证中文目标零请求、外语目标仍请求及相邻英文仍翻译；`languageIdentification` 使用独立术语检查正反边界。

`statistical.ts` 只把 franc-min 的候选分数当作同一文本内的排序和分差信号，并与功能词逆文档频率得分、正字法字母反证共同判断：功能词决定性领先、功能词领先且分差达标、功能词持平但分差更大、franc 前两位几乎并列时由功能词打破平局；franc-min 没有模型的目录语言只接受决定性功能词。分差阈值随文本长度缩放；单词、少于十个字母、名称、纯共享汉字、相近语言无法区分以及目录外相近语言（加泰罗尼亚语、加利西亚语、南非荷兰语等）都保留翻译。希腊文、希伯来文、泰文和印度诸文字按文字直接识别，并排除多调希腊文、意第绪连字和阿萨姆字母；日文与韩文分支会排除中文专用字形，韩文中连续八个以上汉字按中文句子处理。

测试分组：`languageCodes`、`languageTechnicalTokens`、`languageScripts`、`languageStatistical`、`languageIdentification` 为单元测试；`languageIdentificationCorpus` 用真实 franc-min 在校准语料、留出语料和第二份只测量的留出语料上检查每个“文本 × 目录目标”的错误跳过为零、目标与排除语言等价，以及任意两种语言整段拼接不会吞掉其中一种；`sameTargetLanguageClient` 与 `sameTargetLanguageSlots` 验证客户端、标题、批量/文本包/逐槽/AI 合并/公式拆分路径的一致性、取消与失败重试；`sameTargetLanguageRegression` 保留旧实现失败条件（德/葡/意三字母代码、排除与目标不一致、短句、日韩模型名、未配置排除语言时富文本槽只做字符集快判）。全文运行时的翻译—恢复—再翻译、动态改写、目标与排除变化、取消和重试由 `fullPageVisibilityScheduling` 中的真实识别用例覆盖；同段行内 `code` 只为语言预检提供上下文，仍受隐藏、禁止翻译与候选范围限制，不进入翻译请求或覆盖快照。

识别器对比可复现运行 `node scripts/testing/evaluate-language-detectors.mjs --out <report.json>`；追加 `--franc-full <本地 franc 包目录>` 在同一判断链中替换统计库，`--old-root <旧源码目录>` 对比旧实现，`--browser --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径>` 在临时 profile 的后台 Edge 中测量 `chrome.i18n.detectLanguage`。结果只代表这些由项目编写的语料，不作为通用准确率。最近一次结论见 [语言识别报告](./reports/language-detection-20260916.md)。

生产扩展构建后运行 `node scripts/testing/run-chinese-translation-test.cjs --multilingual-same-target --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir <证据目录>`。专项复用临时 Edge、后台可见且不抢焦点的窗口，对 de/pt/it/fr/en/ru/ja/ko/zh-Hans 分别验证同目标段落和标题在悬浮与全文中零请求、相邻外语悬浮 `[1,0,1,0]` 与全文 `[1,0,1]`、GitHub `li > a` 提交链接保持、宿主 `lang="en"` 不影响判断、全文会话中动态改写为外语后重新请求、恢复原文，以及同一页面从德文目标切到英文目标、以简体为目标并排除德文时的结论。页面与译文来自本地回环夹具，只证明扩展判断链与请求计数，不代表真实供应商质量，也不替代 Firefox 实机验证。

PR #906 技术中文专项将上述模式参数替换为 `--technical-pr-906`，只验证反馈中的四段原文及相邻英文。它分别使用普通文本和交替 `code`/`strong` 包装，检查简体中文目标下悬浮、全文均零中文请求和零译文节点，恢复、再次触发、动态改写为英文与切换英文目标后按新文本及目标重新判断。结果和复现说明见 [技术中文重复翻译回归报告](./reports/chinese-technical-pr-906-20261009/README.md)。

## 原文回显与逐槽恢复

`tests/chineseUiNamesRegression.test.ts` 验证“继续使用 Apple”“通过 Google 继续操作”等短中文界面文字在中文目标下保持原样；引号内的外语、英文提示与中外文混合正文继续参与翻译。`tests/identicalTranslation.test.ts` 只在展示比较副本中忽略 U+200B，保留大小写、可见字词间隔、简繁转换、ZWJ 与 ZWNJ 的差异。

`tests/translationEchoValidationRegression.test.ts` 验证有外语证据的正文仅增加句末标点或 U+200B 时，后台恢复一次并拒绝连续回显，异常结果不能缓存；真实词字、数字和运算符变化不能被折叠为相同。`tests/translationSlotEchoRegression.test.ts` 验证内部单条协议逐槽恢复：保留成功槽和顺序，沿用冻结术语的“保持原文”规则、Chrome 长检测样本和同一请求截止时间；取消、损坏协议与部分回显缓存不能被当作完整成功。`tests/requestConfigSnapshot.test.ts` 另覆盖来源中的字面槽标记、嵌套及碰撞避让后的 nonce、共享下划线和长来源边界扫描；非法尾部编号不能驱动不受输入规模约束的槽数组分配。普通用户文本不因含有相似标记而自动进入内部槽协议。

空槽、恢复后结果与缓存共用有效内容判定：空白及仅含 U+200B 的结果不能成功缓存，ZWJ/ZWNJ 和数学符号不被作为空白删除。`tests/sameTargetLanguageClient.test.ts` 使用真实全文入口、client、后台 handler 和 broker，仅替换浏览器消息边界与 provider，验证整包空字符串不会被换成合法来源包而跳过逐槽回退；普通单条空响应仍沿用原文回退行为。

生产 Chrome 扩展构建后，运行 `node scripts/testing/run-identical-translation-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper scripts/testing/focus-safe-browser.cjs --artifacts-dir <证据目录>`。专项使用临时 Edge profile、第二屏后台窗口和本地供应商夹具，验证悬浮、全文、恢复、重复翻译与相同结果展示。其计数观察供应商 fetch；不能把零 fetch 推导成零 runtime 消息，也不代表在线供应商质量或 Firefox 实机行为。

## 双语链接悬停提示与属性边界

`tests/bilingualReplay.test.ts` 和 `tests/translationStability.test.ts` 覆盖链接 `title` 的增删改与焦点/字体标记组合、跨手势零修复预算，以及译文副本单独改写 `href`、事件、隐藏样式、ARIA、class 或无效 tabindex 时恢复可信属性。源文属性变化继续复用已提交译文；原文链接保持不变。

生产扩展构建后运行 `node scripts/testing/run-bilingual-attribute-drift-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <浏览器翻译技能>/scripts/focus-safe-browser.cjs --artifacts-dir <证据目录>`。专项使用临时 Edge profile、第二屏后台正常窗口和固定翻译响应，检查悬浮与全文模式的六轮链接悬停、逐帧工件在位、源链接骨架同步、语义属性恢复、零额外请求及翻译—恢复—再次翻译。追加 `--live-wikipedia` 检查真实 Menches 页面；固定响应不代表真实供应商质量，Edge 结果也不代表 Firefox 实机验证。

## Google Drive 完整配置同步

`tests/googleDriveEncryption.test.ts`、`tests/googleDriveConfig.test.ts`、`tests/googleDriveAuth.test.ts`、`tests/googleDriveApi.test.ts`、`tests/googleDriveSync.test.ts`、`tests/googleDriveSyncClient.test.ts` 和 `tests/backgroundGoogleDriveSync.test.ts` 验证完整凭据快照、认证加密、账号隔离、差异隐藏、三方合并、过期与一次性预览、MV3 后台重启恢复和失败回滚。`tests/i18n.test.ts` 还验证同步状态及隐藏内容的多语言展示。

生产扩展构建后执行 `node scripts/testing/run-google-drive-sync-ui-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <扩展界面测试技能>/scripts/focus-safe-browser.cjs --artifacts-dir <证据目录>`。专项使用临时 Edge profile、第二屏后台可见窗口，先验证实际 Edge 的不支持提示，再注入虚构 Chrome Identity 与 Google Drive 响应；检查真实页面的预览、上传与下载方向、加密完整凭据恢复、损坏文件阻断、私有存储边界、无口令输入流程，以及中英文 390px 布局。

该证据覆盖生产扩展页面、后台 Web Crypto 与实际配置存储；Google 登录授权和 Drive HTTP 为受控夹具，不代表真实 Google 账号、两台设备或商店发行版本的联调结果。配置与公开发布步骤见 [Google Drive 同步教程](./maintainers/google-drive-sync-guide.md)。

## 云备份范围与敏感信息选择

更新日期：2026 年 10 月 4 日。生产扩展构建完成后，使用 WebDAV 本机 HTTP 夹具运行本次范围专项：

```sh
node scripts/testing/run-webdav-backup-ui-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <Node包目录> \
  --focus-safe-helper <扩展界面测试技能>/scripts/focus-safe-browser.cjs \
  --artifacts-dir <证据目录> \
  --sensitive-only
```

`--sensitive-only` 限定为云备份范围与敏感信息选择专项。使用临时 Edge profile、第二屏后台可见窗口与 focus-safe helper；不读取日常浏览器配置，不使用真实账号或服务凭据。检查默认普通范围、风险勾选与取消、保存后的解密载荷不含密钥/鉴权地址/自定义请求体/私密提示词、普通备份及旧完整 v1 恢复保留本机密钥与地址、开启敏感配置后仍写兼容的完整 v1，以及普通设置相同时仍可确认保存普通范围、从当前云文件移除敏感信息。

还检查完成、预览与提交失败、取消预览、切换供应商、重开设置与确认后立即关闭时仍保持已选范围，手动关闭持久保存、多页同步与存储失败保护，以及七语言风险文案解析、390px 无横向溢出、Escape 取消、深色风险文字对比度至少 4.5:1 和控制台异常。紧凑风险弹窗保留本机加密与存储位置、公开口令和泄露风险、默认未勾选的风险同意，省去重复建议。保存普通范围只更新当前云文件，不证明服务商历史版本被删除。此专项使用受控 WebDAV 夹具，不代表真实 Google 授权、真实第三方账号、商店版本或跨设备联调结果；Google 账号切换与准备失败还可用 Google 专项的 `--sensitive-only` 验证；旧扩展拒绝 v2 与旧事务失效由对应领域回归验证。

## 云端备份删除专项

`run-webdav-backup-ui-test.cjs --delete-loading-only` 只检查删除加载反馈：本机夹具延迟核验和删除请求，验证入口转圈、按钮禁用、确认按钮加载、失败后恢复，以及一次删除和本机配置保留。同步操作使用原有加载状态，删除入口只在删除相关请求期间转圈。

更新日期：2026 年 10 月 5 日。`pnpm test:cloud-backup --coverage` 覆盖两阶段删除确认、页面所有权、账号绑定、MV3 重启、旧/未知/损坏密文、空文件、重放、版本冲突、强 ETag、清理失败和本机配置保留；真实 WebDAV HTTP 夹具分别验证 GET、PROPFIND、HEAD 三种 ETag 来源的条件 DELETE、冲突、缺失幂等与重新创建。

生产扩展构建后运行 `run-webdav-backup-ui-test.cjs --delete-only` 和 `run-google-drive-sync-ui-test.cjs --delete-only`，其余参数同上。两者均使用 focus-safe helper 和临时 Edge profile。WebDAV 使用本机服务器验证真实请求、取消/Escape/重开、版本变化、七语言、390px、深色和本机配置保留，还检查输入确认文本前后、输入错误、清空及 Enter 不执行删除，并验证按钮使用已有主色样式。删除影响突出目标服务和本机配置保留；删除影响和输入要求合在同一个提示块中，输入框紧接其下方；确认词加粗并与输入框建立无障碍关联。次要说明通过页脚浮层按需显示，使用 Enter/Space 检查打开与关闭，同时断言弹窗和删除按钮位置、尺寸完全不变，浮层不超出窄屏。Google 使用虚构 Chrome Identity 与 Drive 响应验证实际账号展示、更换账号后重新输入确认文本、缺少版本、v2 ETag 条件删除与窄屏。报告与截图写入各自证据目录；夹具不能代替真实 Google 登录、第三方账号或 Firefox 实机验证。

## 双语逐句高亮

`tests/bilingualSentenceHighlight.test.ts` 覆盖字符坐标、缩写、小数、中英文标点、无原生分句能力的回退、拆句与合句分组，以及双向悬停、内联结构、动态变化和关闭清理。定向覆盖率命令仅包含 `sentenceAlignment.ts`、`sentenceHighlight.ts` 和 `bilingualSentenceHighlight.ts` 三个模块。

生产扩展构建后执行 `node scripts/testing/run-bilingual-sentence-highlight-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-bilingual-highlight`。专项使用临时 Edge、第二屏正常尺寸后台窗口，验证真实 Control 翻译—恢复—再翻译、双向逐句定位、富文本、动态 DOM、关闭和配置持久化、多句设置预览、窄屏与深色。报告记录悬停期间的 DOM 变化、几何偏移和请求计数。

页面与翻译响应为本地确定性夹具，不能代表真实服务的语义对齐质量或 Firefox 实机行为。参考 [duo-translator](https://github.com/linuxscreen/duo-translator/tree/f3abdd18a0e20687222ab338b367edf5476cf746/main/dom) 的文字范围绘制与相邻句分组设计；FluentRead 独立实现，未复制其 GPL-3.0 源码。

句子操作统一使用已有划词入口。定向回归使用 `tests/sentenceActionsMount.test.ts`、`tests/selectionTranslatorLifecycle.test.ts`、`tests/bilingualSentenceHighlight.test.ts` 和 `tests/selectionTtsContentController.test.ts`，验证普通悬停仅绘制高亮、选区卡片按需收藏句子、多语言来源、关闭偏好与请求清理。生产浏览器专项运行 `node scripts/testing/run-sentence-listening-test.cjs --selection-entry-only --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-sentence-selection`，验证原文和译文停留不弹入口、不增加请求；主动选中后只有一个既有小图标，点击才展开、复制和收藏，继续阅读、390px 布局、划词关闭和翻译—恢复—再次翻译。网页和翻译服务为本地确定性夹具，不代表外部服务质量或 Firefox 实机运行。

译文样式由 `tests/translationAppearance.test.ts` 与 `tests/translationAppearanceStyles.test.ts` 覆盖预设注册表、旧版选项顺序、外观归一化、颜色换算与网页样式节点的安装、原位更新和移除；`tests/pageStyles.test.ts` 验证外观样式随公共页面样式一起安装、订阅配置更新，并在移除或 context 失效时一起清理。生产扩展构建后执行 `node scripts/testing/run-translation-style-ui-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-translation-style`：在临时 Edge 与第二屏后台窗口中验证界面风格页第一组为译文样式、四类 29 张样式卡片逐一写入配置并同步预览、色板与方向键、滑块、分段控件和自定义取色器、仅译文提示、逐句高亮开关、重新打开后的保存结果、设置搜索直达外观面板与逐句高亮开关、深色界面与 1024/820/390 宽度；再用本地确定性夹具真实悬浮翻译，确认外观调整无需新请求即可更新已有译文，停用插件或恢复默认时移除外观样式节点，并检查简约卡片底色在网页上生效。

## 关键内容空间与交互工作量

划词卡片定向回归使用 `tests/selectionTranslatorLifecycle.test.ts`、`tests/readingPanelLifecycle.test.ts` 与 `tests/readingPanelStreamingResize.test.ts`，检查单帧合并拖动、结束时刷新最后位置、取消与迟到帧、视口变化、UTF-16 朗读偏移和流式正文的尺寸通知。生产构建后执行 `node scripts/testing/run-selection-key-information-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --artifacts-dir <证据目录> --phase optimized`，在第二屏临时后台 Edge 中检查译文首屏、完整原文、单行工具栏的滚轮与键盘操作、手动拖动/缩放、流式阅读期间的卡片尺寸和网页内容保留。`--phase baseline` 允许记录优化前的关键内容失败，但仍要求基础交互、原文和清理契约通过。性能探针在核对扩展 ID 的隔离世界统计实际送达的受信指针事件与卡片几何读取；请求的输入数量不等于实际事件数量，也不代表 FPS。

`--blank-space` 在同一划词专项中追加短原句与短回答的中英文、亮暗主题、自动/390px 窄屏/280×180/360×200 卡片。它量化闲置音频占位、回答之后的实际空白、长回答内部滚动和追问可达性；使用本机延迟音频夹具逐帧检查生成、播放与停止的外框稳定、正文与播放控件不重叠。静音 WAV 只验证布局，不证明可听性。原文对照另有展开与返回的实际界面检查。

菜单使用 `tests/popupKeyInformation.test.ts` 及既有 Popup 生命周期、服务与页面操作测试。生产专项运行 `node scripts/testing/run-popup-key-information-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --artifacts-dir <证据目录> --phase optimized`，覆盖中英文、亮暗主题与三种皮肤，长名称、配置模型、本地/非模型服务、多服务分配、静态凭据提醒、模块排序及服务抽屉。仅使用合成配置，不执行翻译、连接检查或模型下载；普通扩展标签页尺寸不代表浏览器原生工具栏 Popup。

学习卡片在正文出现与完成后分别验证首个非标题回答段落的完整首行及至少 48px 的阅读视口；保持卡片尺寸不能代替正文可读性。`tests/uiI18nOwnership.test.ts` 使用真实界面指令与语言资源，检查 PRE/CODE 等内容祖先内的跟读子节点、语言切换和迟到文本不会被旧文案扫描改写。

两个专项使用自己的临时 profile 和 focus-safe helper，逐次截图前后检查自有浏览器没有成为前台，结束后只关闭自有浏览器再删除 profile。划词响应由本地夹具提供；它们证明生产 Chromium 的指定 UI 与事件路径，不能证明在线供应商质量、实际语音输出、Firefox 运行时或全部设备的流畅度。

## 不翻译的语言（issue #627）

使用 `scripts/testing/run-chinese-translation-test.cjs --excluded-languages`，并传入原有的 `--extension-dir`、`--playwright-root`、`--focus-safe-helper` 和独立 `--artifacts-dir`。该专项复用临时 Edge、后台可见且不抢焦点的窗口与本地确定性响应，验证翻译设置末尾的语言多选、立即关闭后持久化、跨页同步、键盘操作、展开后选择与清空、七种界面语言，以及浅色 1440/1024/820/390 和深色 1440/390 布局。

翻译链路检查繁体与日语零请求、相邻英文的翻译—恢复—再翻译、标题保留、动态内容改成英文后重识别、自动全文与清空后恢复简繁转换。此证据不代表真实供应商译文质量，也不替代 Firefox 实机验证。语言与配置单测覆盖中文别名、非法输入、旧配置迁移、会话冻结、富文本槽过滤及子页面快照校验。

## 自定义服务 Base URL（issue #626）

`tests/aiSdkEndpoints.test.ts`、`tests/aiSdkErrors.test.ts` 和 `tests/aiSdkOpenAICompatible.test.ts` 覆盖标准 Base URL 补全、完整及非标准路径、代理优先级、查询参数、HTML 错误提示，以及真实 SDK 的请求体和鉴权传递。

生产扩展构建后运行 `node scripts/testing/run-custom-base-url-ui-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-issue626-ui`。专项使用临时 Edge profile、第二屏后台窗口和本地 HTTP 夹具，检查 Zen/Go 形状的 Base URL、根地址、完整和非标准接口、关闭重开后的配置、HTML 404 与手动重试，以及 390px 对话框。报告记录实际路径、模型和鉴权断言，不记录密钥。它证明扩展请求链路，不代表真实 OpenCode 账号、模型可用性或 Firefox 运行时验证。

## X 字幕来源与恢复体验

`node scripts/run-video-menu-state-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-x-experience-proof` 验证生产扩展在临时 Edge profile 中的播放器操作、全屏、320–960px 控件位置、横屏紧凑菜单、缓存恢复、模型确认与三类 SRT 下载。

同一专项覆盖 200 条缓存字幕按播放位置预取、空翻译响应与独立重试、双语和原文切换复用译文、重新识别绕过缓存且确认前保留原文、迟到原生轨道优先、原生静音空档、原文模式加载 sidecar、初始隐藏后恢复字幕和键盘焦点。页面、识别结果与翻译响应为受控夹具，不代表真实 X 登录会话、Whisper 识别质量或外部翻译服务可用性。产品取舍见 [体验复核](./reports/x-video-experience-20260930/README.md)。

`node scripts/run-x-native-subtitle-flicker-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-x-native-flicker` 在临时 Chrome profile 的第二屏后台窗口中验证视频 5 秒处的原生字幕：陆续注入五个字幕分片，每 20ms 采样原文与译文，断言已显示的双语不会被清空、翻译请求数不增加；同时检查正常字幕空档与跳转换句。使用真实视频和浏览器 TextTrack，分片与固定 250ms 翻译响应为受控夹具；不代表外部供应商、登录账号或 Firefox 实机验证。

`node scripts/run-x-home-audio-recovery-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-x-home-recovery` 在临时 Chrome profile 的第二屏后台窗口中验证 Home：使用真实 MSE 视频和 HLS 音轨解码，复现 arraybuffer 清单未被页面桥捕获，检查当前视频匹配、A 失败后切换 B、无法读音频时的刷新提示、播放状态保持，以及从字幕选项重新识别后 Base 空结果的可见提示。脚本需要 ffmpeg；可用 `--ffmpeg` 指定路径。Base 识别结果与翻译响应使用受控回复，不代表真实模型或 X 登录账号验证。

## YouTube 全屏与字幕同步

`node scripts/run-video-caption-prefetch-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-caption-prefetch` 在临时 Edge profile 的第二屏后台窗口中，以固定 500ms 翻译响应检查 YouTube/X 的预取和首次显示：重复原生条目不能占满后续句子的名额，轨道加入后立即启动预取，缓存命中的原文与译文在同一次 DOM 更新中显示。报告记录请求启动时间、两行首次显示的间隔和焦点隔离信息；页面与供应商均为受控夹具，不代表真实账号或在线翻译服务的端到端延迟。

同一专项还覆盖滚动字幕的上一句残留、窗口裁切的旧行、连续每 40ms 增词、无时间轴的请求启动延迟与缓存重播。报告中的 `dispatchMs` 只度量原文变化到请求发出的等待，不包含真实供应商耗时；译文仍使用确定性响应，不能据此声称真实视频端到端零延迟。

X 另覆盖未预取句子等待原译文成对显示、seek 后迟到结果丢弃、仅原文模式零翻译请求与同目标语言单行显示。使用新版 Chrome 时添加 `--extension-install cdp --browser-path <Chrome可执行文件>`；其余焦点隔离和夹具边界相同。

播放页菜单校时使用真实按钮点击，验证正负半秒的字幕内容、视频进度不变、仅原文模式、时间轴空档、重新打开页面后持久化、跨页同步、连续点击、重置和播放期间按帧更新。没有时间轴时禁用无效的提前/延后操作，仍允许重置已保存的偏移。

`node scripts/run-youtube-subtitle-sync-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-youtube-sync` 在临时 Edge profile 的后台可见窗口中验证文档全屏、菜单操作、整句/逐词字幕定位、时间边界、重复句、延迟译文、真实视频 seek、空字幕、原文模式和关闭清理。夹具使用真实视频进度、受控 YouTube DOM 与模拟翻译响应，不代表真实 YouTube 字幕供应或翻译服务质量。

## 中文格式清单与重复请求

`tests/chineseLanguage.test.ts` 覆盖中文文档格式清单、简繁字形相同的“新增功能”标题、短中文中的 AI/PDF、带版本与后缀的技术名称（例如 GPT-6 Sol）、发布说明中的提交哈希、真正外语正文与简繁转换边界。`tests/fixtures/chinese-language-model-post.json` 保留用户反馈原文，分别验证四行和整段；这份测试语料不代表对其中新闻内容的事实确认。

语言检测仅在用于判定的副本中识别标识符，原文保持不变。中文正文仍须有字形或词语证据：标识符规则与其他语言共用（见上文统一语言判断），文件格式不占外语预算，带版本的技术名称和缩写按词计权，提交哈希、更长摘要和字母数字混合编号不算外语；普通外语词、完整外语句子、简繁混排和不确定汉字继续翻译。中文词语证据同时用于中性字形和简繁字形，避免“允许清空”“不再保存”因未命中单字短表而重复翻译。简体证据另由 Unicode 17.0.0 补充中国来源且无日本来源的常用单向简体字；来源属性只作为辅助证据，不能直接等同语言。生成命令为 `node scripts/testing/generate-chinese-variants.mjs <Unihan_Variants.txt> <Unihan_IRGSources.txt>`，两份输入均来自固定版本的官方 Unihan 压缩包，生成文件保留各自 SHA-256。

生产扩展构建后运行 `node scripts/testing/run-chinese-translation-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-chinese-browser`。专项在临时 Edge profile 的后台可见窗口中，检查悬浮零请求、全文跳过中文且继续翻译相邻英文/繁体内容、恢复再翻译，以及动态中文改为英文后的重新识别；同时复现 GitHub 发布说明的 `li > a` 提交链接结构和宿主 `lang="en"`。端点在校验原文前记录请求，夹具拒绝的无效请求也会计数。页面和供应商响应为本地夹具，不代表真实翻译质量。

## 划词学习面板原句滚动

生产扩展构建后运行 `node scripts/run-reading-density-test.cjs --source-scroll-only --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir <证据目录>`。

专项在临时 Edge profile、第二屏后台窗口中验证读懂、句法、用法和练习默认展示回答，完整原句与译文通过“查看原文”展开，返回当前阅读后收起对照。覆盖首次打开、短回答、长选区、流式生成期间向上滚动后保持位置、缓存动作切换、查看原文入口及键盘焦点、重复点击当前标签保留位置和未发送追问、追问、阅读记录往返与恢复、390px 窄屏和深色主题；检查页面本身不滚动、面板无横向溢出。网页与模型响应为确定性夹具，不代表在线模型质量或 Firefox 运行时验证。去掉 `--source-scroll-only` 可同时检查句法标注、键盘切词和次级操作。

## 阅读历史与学习选中状态

生产扩展构建后运行 `node scripts/run-reading-density-test.cjs --history-only --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir <证据目录>`。

专项只检查普通译文页的学习方式均未选中、点击一次进入对应回答、历史默认折叠、按轮次和问题摘要逐条展开、键盘收起、展开不发请求且不改变当前问答、长问题在 390px 深色界面中换行、返回译文时清除选中状态、缓存动作切换和恢复已保存记录。使用第二屏后台隔离 Edge 与本地确定性响应，不代表在线模型质量或 Firefox 运行时验证。`tests/readingPanelLifecycle.test.ts` 另覆盖空记录返回后点击默认动作，以及历史展开不改变追问上下文。

## 阅读卡深色主题（issue #574）

生产扩展构建后运行 `node scripts/run-harness-reading-test.cjs --theme-only --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-reading-theme`。

专项使用临时 Edge profile 和第二屏后台窗口，检查显式浅色/深色、跟随系统及反复切换，测量原文、回答、引用、代码、表格、可用按钮和输入提示的实际前景/背景对比度（至少 4.5:1，禁用控件除外）。同时覆盖流式生成、阅读记录、关闭重开、错误重试，以及主题切换保留回答且不额外调用模型、宿主段落文字和样式不变。页面和模型响应为本地夹具，不代表真实供应商质量或 macOS Chrome/Firefox 实机验证。

`tests/readingThemeStyles.test.ts` 使用项目锁定的 Vue 编译器编译真实 SFC 样式，再匹配父子 DOM，防止 `:global()` 把深色规则错误编译到弹窗外壳。v0.0.32 包含这一缺陷；主分支已在 `4adc485c` 修正选择器，后续主题修复补齐引用、状态、按钮和辅助文字。

2026-09-12 的生产扩展专项 15/15 通过，所测深色文字最低对比度为 5.78:1，浅色为 4.67:1；逐项计算样式和浏览器隔离信息保存在 `docs/reports/issue-574-reading-theme/report.json`。截图：[深色](./reports/issue-574-reading-theme/dark.png)、[浅色](./reports/issue-574-reading-theme/light.png)。

## 输入框翻译

`node scripts/run-input-translation-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-input-translation` 使用生产扩展和临时 Edge profile，在第二屏后台验证输入框配置保存、三击间隔与恢复默认、独立模型和提示词、窄屏与深色布局，以及真实按键的翻译、取消、恢复和失败重试。

供应商响应与网页均为本地夹具，报告中的请求记录用于核对模型、提示词和原文；不代表外部服务连通性或模型翻译质量。`tests/inputTranslationConfig.test.ts`、`tests/inputTranslationBackground.test.ts` 和输入框内容脚本测试覆盖配置迁移、缓存隔离、输入快照、选区、输入法和迟到结果保护；`tests/inputEditableHost.test.ts` 覆盖编辑宿主的光标度量、选区同步等待、合成粘贴与原生插入回退。

同一专项还验证富文本编辑区：原生 contenteditable 通过可撤销的原生插入写回，撤销后恢复粗体结构；模拟 Lexical/Draft.js 的模型驱动编辑器只在 selectionchange 后同步选区，报告中的 `modelEditorLog` 用于确认整段粘贴发生在选区同步之后、没有重复插入；plaintext-only 支持三连触发，密码框和代码编辑器保持不参与。`node scripts/run-rich-text-input-editors-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-rich-text-editors` 从 esm.sh 与 jsDelivr 加载真实的 Quill、ProseMirror、Lexical、Slate 和 Draft.js，逐个验证三连触发后编辑器自身模型只含译文、原文不含触发符，以及恢复原文；该脚本需要联网获取编辑器，结果不代表具体网站的定制编辑器。Firefox 与用户脚本构建需另外执行，Edge 结果不能替代其运行时验证。

## 设置页视口与滚动

设置页保持侧栏品牌、页面标题和搜索框可见，菜单与表单分别在自身区域内滚动。切换分类后表单回到顶部；软件语言搜索仍定位到对应控件。内容区为绝对定位的辅助元素提供定位边界，避免长表单撑高外层文档，导致顶部消失和底部空白。

生产包构建后运行 `node scripts/testing/run-settings-viewport-ui-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-settings-viewport`。脚本通过临时 Edge profile 和后台可见窗口验证首次打开、全部菜单、搜索与下拉菜单、原生锚点滚动、通用/视频长表单底部、刷新深链接、窄屏、矮窗口及深色主题。报告保存页面高度、文档/容器滚动位置、截图、焦点隔离信息和控制台异常。Firefox 构建通过不等于 Firefox 实机验证；完整 UI 套件单独执行并报告。

搜索结果面板位于页内导航与设置内容之间，高度随结果数量变化，超过上限后在面板内滚动，宽度与导航和内容同列。运行 `node scripts/testing/run-settings-search-results-layout-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-settings-search-results-layout`，在通用设置、翻译服务和关于页分别搜索单条、多条和无结果的关键词，覆盖 1440×900、1024×700、390×720 与 1440×480，检查面板内容完整、不挤占设置内容并保持对齐。

## 圈选模型识图

`node scripts/testing/run-area-vision-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-area-vision` 使用生产扩展与临时 Edge profile，在后台可见窗口中验证识别方式及提示词保存、选区裁剪、无需 OCR 语言包的视觉路径、不支持或未知模型的 OCR 路径、模型能力覆盖、失败重试与取消清理。

该脚本的模型端点是本机 HTTP 夹具。它检查真实发出的图片尺寸、摘要及提示词，报告不保存图片请求体或凭据；截图展示真实扩展 UI。通过意味着请求和交互链路符合约定，不代表真实视觉模型对手写、模糊文字或复杂版面的识别准确率。

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

仓库独立版把扩展的完整 Options 页面挂在全视口 closed ShadowRoot，使用 `--suite options` 验证页内回退、设置保存、下拉菜单和主题隔离、六个扩展专属分区与右键菜单、Popup 布局只显示不可用提示，以及宿主 hash 不变。页内回退会暂时隐藏悬浮球，显示可访问的关闭按钮，关闭后恢复悬浮球；浏览器断言还检查跨分区导航和切换到 390px 窄屏后悬浮球保持隐藏。窄屏截图与浏览器断言同时覆盖这一路径。`--suite options-route` 验证独立设置标签页不启动网页翻译运行时。精简版仍使用小面板。完整设置页的真实 Violentmonkey 检查在下面的管理器命令中加入 `--settings-mode full`，还会验证设置标签页关闭、重开悬浮球后源网页在焦点刷新时同步变化，重载保持设置且不覆盖已有主题。

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

报告中的 `toolbarStatus` 是内容脚本的真实结果状态；原生文字角标分别为翻译中 `…`、完成 `✓`、失败 `!`，空闲时清空，工具栏底图保持品牌原图。页面截图不包含浏览器工具栏；可选 `--window-query <可执行文件>` 接收一个输出匹配测试窗口的 CoreGraphics 窗口字典 JSON 数组的只读工具，追加原生窗口截图。该套件不强制重启 worker；不能把普通标签页切换或状态查询单测当作真实后台重启证据。

原生角标尺寸、内边距及字形由浏览器管理；使用蓝色、深绿色和橙色实心底色，并在 API 可用时指定白色文字。静态状态 PNG 不再用于运行时展示。`tests/translationToolbarStatus.test.ts` 验证真实状态判定，`tests/backgroundBadgeRuntime.test.ts` 验证角标映射、导航清理、异步顺序及 MV2 回退。

角标直接替换状态文字，不在每次更新时先清空标识或重载底图；相同状态的在途更新合并为一次写入。完成或失败后的补译等待超过 180ms 才显示省略号，快速补译保留已显示结果；会话内候选扫描与入队之间的短暂空队列也等待 180ms 再清空标识。恢复原文、禁用、导航和关闭立即清空，并取消迟到的状态标识。

角标回归还覆盖各角标异步写入步骤中“完成 → 翻译中 → 完成”、底图初始化中恢复原文、迟到的完成文字与恢复原文、部分写入失败后重画原状态，防止缓存去重跳过被中断后必需的更新。浏览器专项逐状态断言原生文字、背景色与可用时的文字颜色，并记录真实 action 调用，检查完成后的动态样式重扫零重绘、新增正文正常补译且没有清空角标或重载底图。

FluentRead 把测试按意图分组，而不是把所有文件塞进一个难以诊断的命令。每个 `tests/**/*.test.ts` 必须且只能出现在 `tests/test-matrix.json` 的一个分组中；测试审计会拒绝漏归类、重复归类、重复用例名、`.only`、无原因 `.skip` 和覆盖率忽略指令。

## 按需运行

测试、类型检查和生产构建的 package scripts 统一经过
`scripts/testing/run-resource-safe.mjs`。同一台机器上的 FluentRead worktree
共用一组全局锁槽位，默认最多 5 个任务同时运行，第 6 个起排队等待空槽；每个任务中
Vitest 最多使用 2 个 worker，并关闭测试文件并行。直接运行 `pnpm exec vitest` 也通过
globalSetup 占用同一组槽位。嵌套的 package 命令复用父进程所持槽位，子进程结束或收到
终止信号后才释放；已退出进程遗留的槽位可自动回收。槽 0 沿用旧版唯一的 `lock` 目录，
尚未更新的 worktree 仍会在这个槽位上与新版本互相协调。

默认显示的 60% 是协作式资源预算标记，不是 CPU 使用率硬上限，也不会根据
这个百分比自动计算 worker 数量。需要进一步减少占用时使用
`FLUENTREAD_TEST_MAX_WORKERS=1 pnpm test`。直接调用浏览器脚本或其他高负载命令时，
可使用 `node scripts/testing/run-resource-safe.mjs -- <命令及参数>`。
默认最多等待锁 30 分钟，可用 `FLUENTREAD_TEST_LOCK_WAIT_MS` 调整；并发槽位数可用
`FLUENTREAD_TEST_CONCURRENCY` 或 `--concurrency <n>` 调整，设为 1 时恢复完全串行。
`FLUENTREAD_RESOURCE_LOCK_DIR` 仅用于专项锁隔离验证；日常任务不要改写它，否则
不同目录的任务无法互相协调。

`tests/resourceSafeRunner.test.ts` 使用真实 Node 子进程验证并发槽位上限与排队、串行模式下的互斥、死进程锁竞争回收
（取得清理权后整代锁目录原子改名再删除，避免递归删除中途被其他等待者重建清理标记而崩溃）、
非首个槽位的回收与父子锁复用、worker 参数、Vitest setup、等待超时、退出码和 SIGTERM 释放。
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

## 动态任务清单与核心行为验证

GitHub Issue #1029 的任务列表在 React 加载后会变成一个外层 LI 内的多个 DIV 正文。
`tests/translationGitHubTaskList.test.ts` 检查真实结构对应的独立所有权，
`translationOwnershipBoundaries`、`translationVisualProtection`、`translationSnapshotProtection`
和 `syntheticCandidateFreshness` 分别覆盖悬浮边界、隐藏内容、最终副本及排队节点时效。

生产扩展专项 `scripts/testing/run-github-task-list-test.cjs` 使用临时后台 Edge，默认运行
确定性夹具，追加 `--live` 验证用户报告的实时 GitHub Issue。包括每项译文、隐藏说明、
原生节点身份、390px 布局、动态增改、恢复重译、重挂和失败重试；供应商响应是本地夹具。
[行为说明、测试结果与复现命令](./reports/translation-core-audit-20260915/README.md)。

## 翻译核心稳定性回归

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

### Hacker News 与 Product Hunt 翻译滚动

`tests/browser-translation-cases.json` 的 `hacker-news-home` 与
`producthunt-posting-access` 分别覆盖实时首页标题列表和用户指定的帮助文章，均支持
悬浮、全文模式。Hacker News 原有的讨论页用例继续保留。

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

### GitHub Latest 仅译文反复翻译

仅译文将原文搬入自有槽时，必须同时识别原父节点的移除记录与槽内加入记录，避免合成正文段把自身渲染误判为外部变化、撤销译文并重复请求。`translationStability.test.ts` 覆盖 Latest 标签结构、同字不同节点、混合增删、真实原文修改和槽被移除；来源校验仍须保留。

手动验收使用仅译文及 AI 网页语境设置：翻译 GitHub Release 页，待首轮完成后停留至少 30 秒，确认 Latest 不闪烁且翻译次数不再持续增加；再恢复原文、重新翻译，并确认页面新增或修改的正文仍可正常翻译。

## 术语库回归

术语库的本地解析、三态选库、配置迁移、冻结版本、缓存身份、消息来源和 provider 协议先由确定性测试验证：

```bash
pnpm exec vitest run tests/glossary.test.ts tests/builtinGlossaries.test.ts tests/glossaryConfig.test.ts tests/glossarySettingsComponent.test.ts tests/translationGlossaryIntegration.test.ts tests/imageGlossaryContext.test.ts
```

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

## 翻译服务目录

服务目录只有“我的服务”和“全部服务”两级入口，自定义 OpenAI 兼容服务在创建后作为“全部服务”中的一个分类出现。两个生产扩展专项使用相同的隔离浏览器参数，分工如下：

```bash
node scripts/testing/run-service-library-ui-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <Node包目录> \
  --focus-safe-helper <focus-safe-browser.cjs路径> \
  --artifacts-dir /private/tmp/fluentread-service-library

node scripts/testing/run-service-catalog-ui-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <Node包目录> \
  --focus-safe-helper <focus-safe-browser.cjs路径> \
  --artifacts-dir /private/tmp/fluentread-service-catalog
```

`run-service-library-ui-test.cjs` 覆盖按类别展示服务、查看配置不改默认服务、标题栏检查连接、首个自定义服务出现前不显示自定义分类、20 个长名称自定义服务的分类筛选，以及 1440/1024/820/390px、深色和英文界面。`run-service-design-ui-test.cjs` 检查免费接口卡片、可选邮箱字段、默认收起的云服务额度指引，以及 DeepLX 检查期间的布局稳定性、匿名检查和占位符地址必填密钥，连接结果使用本地夹具。`run-service-catalog-ui-test.cjs` 锁定机器翻译、云服务厂商、模型服务商和聚合平台的分类顺序与计数，检查免密钥候选不泄漏为独立服务、跨分类搜索和窄屏布局，并验证免费翻译默认自动均衡、DeepLX 默认停用且其他候选默认启用，以及切换优先顺序后的启停、排序和重载持久化。目录脚本默认不请求翻译服务；只有显式 `--live true` 才逐一检查三个免密钥候选的真实连接，结果需与本地断言分开报告。

`run-service-workspace-density-test.cjs` 是服务工作区空间与滚动的独立专项：先对保留的基础生产包运行 `--phase baseline`，再对优化生产包运行 `--phase optimized --baseline-report <基线证据目录>/report.json`，两次均传入 `--extension-dir`、`--playwright-root` 和独立的 `--artifacts-dir`。它使用一个临时后台 Edge 页面，检查五种视口、中文/英文、浅色/深色共 20 组布局；比较首个 API Key 在内容区的位置、单行目录的命中高度以及目录滚动时逐帧 `getBoundingClientRect` 调用数。长服务名称自然增高，不能为通过密度断言而截断名称。搜索、折叠、导航、模型弹层和窄屏配置可达性仍须通过；基线行为失败会明确记录，优化包不允许跳过。数据仅代表当前环境中的布局读取成本，不能用来宣称全页面帧率、真实服务速度或模型推理性能。专项不检查连接、不下载模型。

`tests/serviceDirectoryLifecycle.test.ts` 验证实际 Vue 模板的帧合并、布局缓存失效、旧帧取消和用户接管；`tests/localTranslationModelSettingsLifecycle.test.ts` 验证隐藏页退订、返回刷新、试译取消、旧确认与回包隔离，并通过公共后台路由证明页面离开不会暂停下载。

目录的分组标题可以收起或展开，目录上方的分组导航点击后展开并滚动到对应分组，并随目录滚动同步高亮；搜索时展开全部匹配分组，搜索中点击导航回到完整目录。收起状态只在本次打开的设置页内有效。`node scripts/testing/run-service-group-navigation-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-service-group-navigation` 验证导航与分组一一对应、滚动同步高亮、收起只影响自身、导航展开并定位已收起的分组、搜索期间的展开与导航稳定、从通用设置直达服务时展开所在分组，以及 820px 无横向溢出、390px 隐藏导航并保留目录内的收起。

## 菜单栏首帧与快速关闭

Popup 必须等待配置服务完成读取或安全降级后再挂载。首个可见界面就应使用保存的皮肤、深浅主题和栏目布局；只有最终截图正确不足以证明没有闪烁。

菜单栏启动时并行读取配置与加载界面组件；快捷抽屉在首次打开时加载，语言选择器关闭时只显示当前语言，不挂载完整选项列表。中文界面跳过旧文案的无效 DOM 扫描，从其他界面语言切回中文时仍执行一次恢复。

性能对照使用 `node scripts/testing/run-popup-performance-test.cjs --extension-dir .output/chrome-mv3 --artifacts-dir /private/tmp/fluentread-popup-performance --verify-ui`。每次运行创建临时后台 Edge profile，通过扩展图片文档和真实配置协议完成准备，避免先加载 popup/options 脚本；记录首次菜单文档、另外六次打开的 DOM 就绪与下一帧时间、布局/脚本时间、实际解析脚本字节和隐藏选项数量。`--verify-ui` 另验证语言搜索、键盘选择、Escape、关闭菜单时的配置同步、界面语言往返切换与重开持久化。

全文响应性对照使用 `node scripts/testing/run-translation-responsiveness.cjs --paragraphs 1500 --cpu-rate 4 --repeat --artifacts-dir /private/tmp/fluentread-responsiveness`，记录翻译、翻译后滚动、恢复原文、缓存重译的长任务、心跳间隔和宿主点击，断言中文目标下的中文技术说明保持原样且不发送请求。`--github` 改为验证中文 README 与 Issues 实际页面的翻译—恢复—再次翻译。均使用临时后台 Edge 与本地固定译文，执行时应通过资源安全包装器；依赖路径、基线开关及证据边界见[响应性报告](./reports/translation-responsiveness-20260929/report.md)。

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

## WebDAV 属性响应边界

`tests/webDavProperties.test.ts` 直接验证实际 Saxes XML 解析器的命名空间、字符引用、CDATA、资源唯一性、属性状态、强 ETag、DTD 拒绝及长度/深度/元素数量限制。目标 URL 必须为可解析的绝对 URL；无效目标返回未识别结果，避免解析函数向调用方抛出 URL 异常。属性模块进入永久四维 100% 清单，和 `webDavApi`、`webDavConnection`、`webDavHttpIntegration` 联合验证；HTTP 用例只对临时本地服务完成首次/再次保存与版本冲突，不代表用户真实 WebDAV 账号。沙箱若禁止本地 listen，需在允许 127.0.0.1 的环境运行相同测试，不跳过或模拟这组三种 ETag 来源的协议链路。

## 快捷键草稿与录制弹窗

`tests/translationShortcutSettings.test.ts` 使用真实 Vue effectScope 验证三种快捷键的重复选择、延迟打开、取消、确认、清除、配置替换、分区离开和卸载，并检查划词触发字段同步及额外方案冲突。`tests/customHotkeyInputLifecycle.test.ts` 执行实际客户端 SFC 模板、Teleport、按钮事件和 Vue 卸载；DOM 与焦点端口由 Linkedom 提供，检查录制只有一个完成计时器、旧录制不能结束新录制、当前值变化取消旧录制、确认前冲突重验、焦点循环和关闭后不抢走新控件焦点。两模块进入永久四维 100% 覆盖率清单，不使用覆盖率忽略。

生产 Chrome 构建后运行 `node scripts/testing/run-lazy-options-ui-test.cjs --suite shortcut-lifecycle --extension-dir .output/chrome-mv3 --playwright-root <path> --focus-safe-helper <path> --artifacts-dir <path>`。专项验证首次直达划词设置、真实键盘录制与取消、清除保存、切换分区阻止迟到弹窗、390 像素与减少动态效果、传统全文快捷键保存。为在 100 ms 打开延迟内稳定离开，只有该离开用例使用 DOM 导航点击；录制和其他操作使用可信浏览器输入。此专项验证生产扩展设置和存储，不代表真实翻译供应商或 Firefox 运行时。`--suite hotkeys` 继续验证共享弹窗在段落复制、额外悬浮方案和圈选翻译调用方中的兼容性。

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

### X 模型下载来源与等待边界

`modelDownloads`、`videoAiModelCache`、`downloadProgress`、`downloadProgressTransport`、`videoAiBackground` 和 `videoAiOffscreen` 测试覆盖国内/官方优先顺序、连接与首字节等待、忽略取消的底层请求和读取、完整响应后仍未返回的消费端、迟到流清理、总预算、完整文件复用及可信来源状态传输。共享 HTTP helper 变化同时覆盖本地 TTS、漫画、OCR 和本地翻译直接消费者，保留历史缓存的来源兼容性。`localModelSettingsLifecycle` 与 `implementationAudit49C` 执行实际 Vue 客户端模板，检查来源选择只影响后续请求、切源文字、失败重试和旧视图事件隔离。

Small 默认配置另覆盖新配置、旧配置缺字段、非法值及保留明确 Tiny/Base 选择。下载来源的公网 HTTP 核验与隔离浏览器中的受控失败/流式接收必须分开报告；权重片段和服务端哈希元数据不能代替完整远端文件下载，也不能据单机结果保证中国、美国、欧洲的地域可达性。实际结果见[X 模型下载验证记录](./reports/x-model-download-sources-20261009/verification.md)。

### AI 字幕中文质量与性能基准

`scripts/run-video-ai-recognition-benchmark.cjs` 在同一个临时 profile 中对照两份生产扩展，实际调用 Whisper Tiny/Base 转写三段确定性的普通话音频（含较快长句），分别测显式中文和自动检测。模型在本机执行，测量不使用用户日常浏览器配置。

```bash
node scripts/run-video-ai-recognition-benchmark.cjs \
  --extension-dir <baseline-production-build> \
  --next-extension-dir .output/chrome-mv3 \
  --playwright-root <path> \
  --focus-safe-helper <path> \
  --artifacts-dir /private/tmp/fluentread-ai-recognition-benchmark
```

报告包含原始识别文字、字符错误率 CER、首次模型准备耗时、各音频窗口转写耗时、后端与量化类型、隔离浏览器累计 CPU 时间和累计 RSS 峰值。CER 忽略标点但保留简繁字形差异；RSS 累加可能重复计入共享页，不等于独占物理内存或 GPU 显存。应在没有并行构建等负载时测量。首次推理包含冷启动，第二版本复用模型下载缓存，不能把下载/首次推理差异算作代码提速。合成语音只是可重复基准，不能代表影视对白、方言、背景音乐或用户帖子里的实际准确率。

`scripts/run-video-ai-media-persistence-test.cjs` 使用已保存的时间轴和确定性翻译验证元数据补全、鼠标移出/移回、控制栏重建、同媒体 video 替换、暂时隐藏及真正换媒体时的字幕状态；它不调用真实 ASR，不能用来声称识别准确率提高。

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

`pnpm exec vitest run tests/mangaEntryComponentLifecycle.test.ts tests/mangaCompositor.test.ts` 定向验证漫画入口和合成器。入口测试通过真实 Vue SFC 的客户端模板与 renderer 执行资源确认、按钮事件、焦点、闲置计时器、换章和卸载后的迟到响应；资源检查与保存由注入端口提供，不是实际模型下载或扩展配置持久化。`vitest.config.ts` 仅为该组件测试使用客户端转换，并断言真实 render 已生成，避免 Node 默认 SSR 转换让模板未执行。原生 DOM、闭合 Shadow Root、CSS、加载动画、触摸和窄屏仍须隔离浏览器验证。

漫画合成器的绘制和全部图块解码共用从调用开始计算的 15 秒截止时间，每块只使用剩余预算。测试验证多块等待、最后一次绘制、取消、迟到位图关闭和独立调用的预算。同步原生 Canvas 绘制无法中途抢占；返回后检测耗时并停止后续工作、释放自有画布，不把该预算描述为主线程阻塞的硬上限。


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

## 局部翻译选择流程

```bash
node scripts/testing/run-section-translation-flow-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <path> \
  --focus-safe-helper <path> \
  --artifacts-dir /private/tmp/fluentread-section-flow
```

使用临时 Edge profile、防抢焦点 helper 和 CDP 真实指针/按键，在类 GitHub 仓库页夹具上验证：Popup 局部按钮与主按钮同排等高，消息进入选择模式后稳定预览鼠标下的段落，边缘轻微移动不换选；点击只锁定选区、不请求服务且不跳转，锁定后鼠标移动与滚动不改变范围；可见按钮扩大到 README、缩小及重新选择，确认按钮才翻译该区域，网页收不到选择点击，视口外段落排在最后翻译，导航、文件列表、侧栏、页脚和代码保持原文；再次选择同一区域显示“恢复原文”并只恢复该区域。伪造点击和 Esc 不影响选择，真实 Esc 与右键退出且不发请求；主动选择侧栏时按全部节点范围翻译；已是目标语言与空白区域给出提示且不请求服务；快捷键默认关闭、开启后可进入和退出且在输入框中让行；全文恢复原文同时清除局部译文，关闭插件立即退出选择模式。追加 `--github-url <仓库地址>` 可在真实 GitHub README 上重复点选流程并断言 README 之外没有译文。翻译传输是确定性 Google 夹具，不代表外部服务可用性。

### 悬浮说明框翻译稳定性

`run-full-page-translation-test.cjs` 在全文翻译会话中动态创建与旧 Bootstrap 相同结构的 tooltip，按原文高度定位，使双语内容增高后覆盖触发图标。真实 CDP 鼠标连续执行两次移入、持续停留和移出，断言每次只打开一次、译文仅一份、图标仍获得鼠标命中，移出后正常关闭。报告的 `tooltipHover` 同时记录语义 tooltip、未翻译提示、交互弹层和恢复原文后的命中边界。该保护只作用于已翻译的纯说明提示框，保留链接、按钮和可聚焦控件的交互。此测试为本地结构夹具，不代表登录后的真实网站验证。

Ko-fi 的 Monthly 按钮把 tooltip 插在按钮内部。回归同时覆盖提示框独立发现、按钮原文与请求槽不包含提示文字、提示框出现或移除不使按钮来源失效，以及直接控件翻译和加载阶段的命中保护。`scripts/run-kofi-tooltip-test.cjs --url https://ko-fi.com/thinkstu` 用临时后台 Edge 访问真实公开页面，配合本机延迟翻译响应验证持续悬停、再次悬停、移出关闭及恢复原文；需同时传入 `--extension-dir`、`--playwright-root`、`--focus-safe-helper`、`--artifacts-dir`。该脚本不访问日常浏览器配置，真实页面证据与本地翻译 transport 分别记录。

新增局部快捷方案后，该流程同时检查：主快捷键关闭时独立方案仍能进入容器选择，确认前没有请求，容器外保持原文，目标语言实际传给供应商，换方案重译、同方案恢复，以及输入保护和同键/Esc 取消。Google 的浏览器批量、网页批量和 RPC 接口均使用确定性响应，不代表真实服务翻译质量。

设置专项执行 `run-lazy-options-ui-test.cjs --suite section-hotkeys`，其余扩展目录、Playwright、focus-safe helper 和证据目录参数同上；验证真实按键录制、重复快捷键拒绝、独立服务与语言、主快捷键关闭、关闭重开后的保存和 390px 无横向溢出。

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

## 论文版式回归

`tests/pdfPaperLayouts.test.ts` 用 pdf-lib 按真实字体度量现场生成典型论文版式，再走真实的 PDF.js 解析与版面分析，逐项断言送翻片段的文字与顺序。目前覆盖：

- 单栏 LaTeX 文章：题目、作者署名、收窄的摘要、编号章节、独立公式、脚注、页码。
- 双栏会议论文：罗马数字章节（`I. INTRODUCTION`）、图与图注、`TABLE I` 表题与三线表、脚注、页眉页码，以及先左栏后右栏的阅读顺序。
- 双倍行距的投稿稿件：段落保持完整，标题单独成段。
- 悬挂缩进的参考文献页：每条文献一个片段，跨两栏。

夹具文字均为测试自拟。调整分段、分栏、标题或题注规则时先跑这一组：

```bash
pnpm exec vitest run tests/pdfPaperLayouts.test.ts tests/pdfLayoutAnalysis.test.ts
```

新增一种版式时，在该文件里加一个用 `build(...)` 排版的用例，并断言 `sources(document)` 的完整顺序。真实论文不进入仓库；需要用本地论文核对结构不变量（可翻译块互不重叠、被拆散的碎片段落不超过十分之一）时，把目录交给环境变量：

```bash
FLUENTREAD_PDF_CORPUS=/path/to/papers pnpm exec vitest run tests/pdfPaperLayouts.test.ts
```

## 扫描版 PDF 识别

`tests/pdfOcr.test.ts` 覆盖“识别结果 → 版面段落 → 片段编号”，`tests/documentPageRecognizer.test.ts` 覆盖页面识别器的坐标换算。真实浏览器里的整条流程是文档翻译脚本的一个单独套件，它会现场生成一份“一页文字 + 两页扫描 + 三页旋转扫描（90、180、270 度）图像”的 PDF，核对打开时不发请求、开始翻译后先识别扫描页再翻译、文字页照常翻译、三句印刷文字都被认出、译文块落在扫描页内：

```bash
node scripts/run-document-translation-test.cjs --suite scanned --playwright-root <playwright>/node_modules --artifacts-dir <目录>
```

这个套件需要联网下载一次英文识别语言包，所以不包含在默认的 `full` 套件里。

## PDF 在线与本地划词

生产扩展构建后运行：

```bash
pnpm test:pdf-selection -- \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <Node包目录> \
  --focus-safe-helper <浏览器测试技能>/scripts/focus-safe-browser.cjs \
  --arxiv-pdf <已下载的1706.03762.pdf> \
  --live-arxiv \
  --artifacts-dir /private/tmp/fluentread-pdf-selection
```

测试使用临时 Edge profile、第二屏后台可见窗口和真实鼠标/键盘，不连接日常浏览器。PDF.js、Canvas、文字层、文件导入与扩展协议使用生产产物；翻译服务为本机确定性 OpenAI 兼容夹具，不证明外部服务质量。`--arxiv-pdf` 验证实际论文文件的本地导入；`--live-arxiv` 单独访问原始 HTTPS 地址，不拦截 PDF 下载，其成功、失败和耗时独立记录。

脚本验证精确跨行/跨页选区、来源过滤、快捷键与后台右键指令、旧请求迟到、390px 暗色、在线导入、原生 PDF 页面 Popup 分流，以及 120 页跳转、缩放、键盘和快速滚动的资源上限。普通页面先核验原生 caret 命中，再执行真实拖选；旋转页单独记录鼠标结果，并在本次临时 profile 开启浏览器光标浏览后用真实 Shift + 方向键核对原生选区，不写入 DOM Selection。适合宽度时还检查阅读器与 PDF 页面实际宽度，避免资源上限通过却没有可读页面。原生系统右键菜单点击及前台创建标签页不在这项证据内，Popup 测试记录实际 `tabs.create` 参数并将目标更新到预建后台标签页。

`pdfSource.test.ts`、`documentSelectionRuntime.test.ts`、`pdfReaderLifecycle.test.ts` 覆盖下载限额/取消、异步挂载/文档归属、页面渲染/释放和实际 Vue 导航布局；新增纯入口、下载、选区运行时及渲染调度器进入严格四维覆盖率。`documentAppLifecycle`、`documentUserActions` 与既有 binary/rasterizer 测试守护批量导入、校订和导出。Firefox 构建与清单验证单列，不等于 Firefox 实机验收。

## 划词窗口拖动与缩放（issue #525）

`node scripts/run-selection-trigger-test.cjs --geometry-only --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <浏览器测试技能>/scripts/focus-safe-browser.cjs --artifacts-dir /private/tmp/fluentread-selection-geometry` 使用临时 Edge profile 和第二屏后台窗口，检查顶部与内容空白处拖动、八个方向缩放、自动换行、正文选择、复制、滚动后位置保持、最小尺寸和视口边界，以及关闭、禁用、重新划词和迟到译文。截图涵盖放大、窄窗口和深色主题。页面及微软翻译响应为本地夹具，不代表真实供应商质量；窗口手势通过真实 CDP 输入执行。

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
