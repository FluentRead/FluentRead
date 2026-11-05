# 视频字幕与本地推理

[返回测试入口](../testing.md)。按本次改动选择下面的专项；这些条目不要求每次全部运行。

## 读音状态与菜单稳定性

`videoReadingPlayer` 覆盖准备、无适用读音、失败重试及显示模式切换。生产 Chrome 构建后，运行 `node scripts/testing/run-video-menu-ui-test.cjs --suite reading-stability --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper scripts/testing/focus-safe-browser.cjs --runtime-diagnostics <浏览器测试技能>/scripts/runtime-diagnostics.cjs --artifacts-dir <证据目录>`；将 suite 改为 `x-reading-stability` 可测试 X 缓存 AI 字幕菜单。专项在第二屏临时 Edge 后台窗口使用受控页面、媒体与字幕，连续切换韩语、无需标注的文字和空字幕，采样菜单及控件几何并保存截图；不代表真实网站、真实 AI 转写、Firefox 或辅助技术实机验收。

## 视频双语上下顺序（issue #1073）

播放器菜单和字幕外观设置共用 `videoSubtitleAppearance.bilingualOrder`，默认原文在上；切换只重排原文、读音和译文，读音始终紧跟原文，单语显示与字幕下载顺序保持各自语义。`videoSubtitleAppearance`、`videoSubtitleAppearanceSettingsLifecycle`、`videoUiI18n`、`videoSubtitleTrackPriorityRuntime`、`videoCaptionPlatformRuntime` 和 `videoNativeFullscreen` 覆盖归一化、持久化、即时更新、缓存/节点保留、单语和原生轨道选择。

生产 Chrome 构建后，运行 `node scripts/testing/run-video-menu-ui-test.cjs --suite subtitle-order --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper scripts/testing/focus-safe-browser.cjs --runtime-diagnostics <浏览器测试技能>/scripts/runtime-diagnostics.cjs --artifacts-dir <证据目录>`。专项在第二屏临时 Edge 后台正常窗口中验证真实点击和键盘切换、字幕上下几何、无重复翻译请求、刷新后偏好、单语显示、390/320px 菜单与外部配置同步，并保存截图及运行时诊断。网页、媒体、原字幕和翻译响应使用确定性夹具，不代表原站、在线服务、Firefox 或 Safari 系统全屏实机验收。

## 自定义字幕轮廓与背景（issue #1183）

`videoSubtitleAppearance` 验证旧配置继续跟随皮肤、轮廓样式与颜色/粗细归一化，以及关闭背景时透明背景、边框、阴影和模糊一并清除。`videoSubtitleAppearanceSettingsLifecycle` 执行真实设置组件的控件事件，验证实时预览、透明度保留、禁用状态和七种界面语言；`videoCaptionPlatformRuntime` 验证 Meet 等平台字幕面板消费同一组外观变量。YouTube/X 与平台字幕 DOM 均使用受控夹具，不代表真实网站或跨浏览器实机验收。

先运行 `pnpm test:unit -- tests/videoSubtitleAppearance.test.ts --dry-run` 与 `pnpm test:functional -- tests/videoSubtitleAppearanceSettingsLifecycle.test.ts tests/videoCaptionPlatformRuntime.test.ts --dry-run` 核对范围，再运行相同命令并移除 `--dry-run` 执行定向回归。

## 视频完整句学习

视频字幕总开关关闭时，YouTube/X 播放器按钮和菜单必须移除；播放器菜单的「关闭」遵循同一行为，重新开启从扩展弹窗或设置页操作。`videoSubtitleTrackPriorityRuntime` 覆盖两个平台初始关闭、已打开菜单的移除、周期同步后保持隐藏、重复开启不产生副本，以及隐藏字幕与关闭功能的区别。生产 Chrome 构建后使用 `node scripts/run-video-menu-state-test.cjs --button-visibility-only --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper scripts/testing/focus-safe-browser.cjs --artifacts-dir <证据目录>` 定向验证：初始关闭、外部配置关闭、控制栏重建、刷新、菜单关闭、重新开启，以及字幕关闭时网页段落翻译—恢复—再次翻译的 `[1, 0, 1]`。脚本使用临时 Edge 后台正常窗口与受控 YouTube/X DOM、媒体和翻译响应；不代表原站、在线服务或 Firefox 运行验收。

AI 字幕运行时的缓存恢复与完整生成提交由 `video-ai/subtitleSession.ts` 统一拥有：媒体、模型、来源语言变化或卸载后，旧缓存不能写入新会话；原生轨道就绪时拒绝缓存恢复；同媒体元数据补全保持生成开始时的模型与语言快照。`videoAiSubtitleSession` 使用受控未决 Promise 验证这些边界、请求去重、新旧请求终结顺序、失败恢复、重入与销毁，完整时间轴提交会复制身份和 cue，缓存失败保留已识别字幕。

`video-ai/requestSession.ts` 将完整和实时采集器的本地 session 映射为同一后台流的单调请求 generation，避免相同本地计数碰撞。模型预热、转写和取消共用冻结身份，缓存恢复不虚构识别请求；销毁后禁止新请求，原采集器仍用精确旧身份终止资源。`videoAiRequestSession` 联合真实后台 handler 验证旧预热、旧取消与新代际的隔离；`videoSubtitleTrackPriorityRuntime` 继续验证实际挂载、原生字幕优先、模型切换、元数据补全、预览和离开清理。两模块四维覆盖率单列；这组端口/DOM 证据不代表真实 PCM 采集、本地模型准确率或原站播放验收。

`pnpm test:video:learning --coverage` 限定执行原始字幕聚合、播放控制、面板所有权与来源恢复、收藏来源及 UI 五份测试；四个新增 TypeScript 模块的 statements/branches/functions/lines 均要求 100%。字幕菜单和运行时回归使用 `videoSubtitle`、`videoSubtitleTrackPriorityRuntime`、`videoSubtitleLogic`、`videoUiI18n`，以及架构、文件头和 i18n 检查。

生产 Chrome 构建后运行：

```sh
node scripts/run-video-sentence-learning-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root "$PLAYWRIGHT_ROOT" \
  --focus-safe-helper scripts/testing/focus-safe-browser.cjs \
  --artifacts-dir /private/tmp/fluentread-video-sentence-learning
```

脚本使用自有临时 Edge profile、第二屏后台正常窗口、前台 PID 保护和真实解码的本地 MP4。平台 DOM、原字幕与翻译/解释传输受控；断言整句原时间、用户播放优先、循环与句末暂停、失败恢复、主动收藏、来源去重、学习中心链接、X 多视频/引用帖归属、全屏与窄屏边界。它不代表原站字幕可取得或线上服务译文质量。

追加 `--live-only --live-youtube-urls <视频地址列表> --live-x-url <帖子地址>` 单独访问真实网站，不注入字幕或替换网站 DOM/媒体；仍使用受控翻译传输。原站无法供给可读取字幕时记录状态和失败，不能据此宣称字幕学习闭环通过。Firefox 与 userscript 构建不等于实际浏览器运行验收；原生画中画未通过此前台隔离脚本测试。本次结果与边界见[视频完整句学习记录](../reports/video-sentence-learning-20261011/README.md)。


## 扩展体积与共享推理引擎

`pnpm analyze:bundle [构建目录] [基线目录]` 统计真实字节、文件类型、目录、最大文件和相同内容，详见 [2026-10-06 体积记录](../maintainers/extension-size-20261006.md)。普通开发构建不内联源码映射；需要时使用 `FLUENTREAD_DEV_SOURCEMAPS=1 pnpm dev`。手动加载可设置 `FLUENTREAD_DISABLE_BROWSER_RUNNER=1`。

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

本轮诊断、资源策略、CPU/GPU 对照与验收边界见[本地推理可靠性报告](../maintainers/local-inference-reliability-20261006.md)。漫画性能模式用同一原图、提前导入已校验模型和固定文字传输；`--worker-diagnostics` 只修改临时扩展副本，记录真实 GPU 提交与 pthread 创建。`--pipeline-cpu` 强制禁用 GPU，不将能力探测当作实际后端证明。

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
  --focus-safe-helper scripts/testing/focus-safe-browser.cjs \
  --runtime-diagnostics <扩展界面测试技能>/scripts/runtime-diagnostics.cjs \
  --artifacts-dir /private/tmp/fluentread-selection-speech
```

浏览器专项加载生产扩展，在第二屏临时 Edge 后台窗口运行；翻译与语音响应使用确定性夹具，但音频解码、媒体时钟、跳转及跨后台路由真实执行。验证完整词高亮、文字节点与换行稳定、跳转不重新合成、浅色/深色/390px 布局、减少动画和停止清理；保存 `report.json` 与卡片截图。它不证明在线发音对齐、扬声器输出或 Firefox 实机行为。

## X 字幕来源与恢复体验

`node scripts/run-video-menu-state-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-x-experience-proof` 验证生产扩展在临时 Edge profile 中的播放器操作、全屏、320–960px 控件位置、横屏紧凑菜单、缓存恢复、模型确认与三类 SRT 下载。

同一专项覆盖 200 条缓存字幕按播放位置预取、空翻译响应与独立重试、双语和原文切换复用译文、重新识别绕过缓存且确认前保留原文、迟到原生轨道优先、原生静音空档、原文模式加载 sidecar、初始隐藏后恢复字幕和键盘焦点。页面、识别结果与翻译响应为受控夹具，不代表真实 X 登录会话、Whisper 识别质量或外部翻译服务可用性。产品取舍见 [体验复核](../reports/x-video-experience-20260930/README.md)。

`node scripts/run-x-native-subtitle-flicker-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-x-native-flicker` 在临时 Chrome profile 的第二屏后台窗口中验证视频 5 秒处的原生字幕：陆续注入五个字幕分片，每 20ms 采样原文与译文，断言已显示的双语不会被清空、翻译请求数不增加；同时检查正常字幕空档与跳转换句。使用真实视频和浏览器 TextTrack，分片与固定 250ms 翻译响应为受控夹具；不代表外部供应商、登录账号或 Firefox 实机验证。

`node scripts/run-x-home-audio-recovery-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-x-home-recovery` 在临时 Chrome profile 的第二屏后台窗口中验证 Home：使用真实 MSE 视频和 HLS 音轨解码，复现 arraybuffer 清单未被页面桥捕获，检查当前视频匹配、A 失败后切换 B、无法读音频时的刷新提示、播放状态保持，以及从字幕选项重新识别后 Base 空结果的可见提示。脚本需要 ffmpeg；可用 `--ffmpeg` 指定路径。Base 识别结果与翻译响应使用受控回复，不代表真实模型或 X 登录账号验证。

## YouTube 全屏与字幕同步

`tests/videoTranslationScheduler.test.ts` 验证三路满载的重复当前句请求不枚举等待队列，仍合并同一 Promise、提升优先级并在完成后保留同级顺序；清理后不响应 abort 的旧传输仍占原名额，其迟到 finally 可启动同 key 的新请求。两路预取保留第三路的原行为继续回归，操作计数不代表播放器或供应商耗时。

`tests/videoSubtitleTrackPriorityRuntime.test.ts` 从实际公共 mount 验证 YouTube 同轮选择、两次时钟跨界、NaN、seek、字幕偏移、换轨、迟到结果及人工目标轨命中后回退。只在同步媒体事件窗口对真实 selector 作 call-through 计数，先检查原译文及翻译请求不变；不模拟业务算法。YouTube 夹具按订阅过滤 Linkedom 错发的 attributes，保留真实 childList 与业务回调，并断言观察器预算、订阅和计时器清理；既有 X 夹具继续使用原观察器。这是受控 DOM/媒体/fetch 端口验证，不代表原生浏览器布局、在线字幕服务或设备耗时。

`pnpm test -- tests/youtubeSubtitleData.test.ts tests/videoSubtitleLogic.test.ts tests/videoSubtitleDownloads.test.ts tests/videoSubtitle.test.ts tests/videoSubtitleTrackPriorityRuntime.test.ts` 离线验证原生 timedtext 的事件边界与时间轴。不同事件的 Unicode 字母、引号和括号边界保留必要空格；直/弯 apostrophe 在前一事件末尾、后一事件开头或独立事件时，有限英语缩写与常见法语省音前缀继续组成完整词，单引号及其内部缩写保留引用空格。引用判断只查看本次可合并词流，只有有限引述动词借可见闭号判断引用，普通缩写与名词所有格不会借后面的复数所有格误判；这些局部规则不声称能消除纯文本中的全部语言歧义。称谓仅在可靠人名式后继时延续，歧义缩写、域名样式和小数样式保留句界。JSON3/XML 拒绝空白、非数值类型、负时间和非有限结束时间，缺失或零时长仍按有效后继推断；前缀折叠与词流合并收敛后，重复规范化和 SRT 导出保持幂等。这些 fixture 只证明数据处理，不代表真实 YouTube 捕获、在线翻译质量或 ASR/GPU 验收。

`node scripts/run-video-caption-prefetch-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-caption-prefetch` 在临时 Edge profile 的第二屏后台窗口中，以固定 500ms 翻译响应检查 YouTube/X 的预取和首次显示：重复原生条目不能占满后续句子的名额，轨道加入后立即启动预取，缓存命中的原文与译文在同一次 DOM 更新中显示。报告记录请求启动时间、两行首次显示的间隔和焦点隔离信息；页面与供应商均为受控夹具，不代表真实账号或在线翻译服务的端到端延迟。

同一专项还覆盖滚动字幕的上一句残留、窗口裁切的旧行、连续每 40ms 增词、无时间轴的请求启动延迟与缓存重播。报告中的 `dispatchMs` 只度量原文变化到请求发出的等待，不包含真实供应商耗时；译文仍使用确定性响应，不能据此声称真实视频端到端零延迟。

X 另覆盖未预取句子等待原译文成对显示、seek 后迟到结果丢弃、仅原文模式零翻译请求与同目标语言单行显示。使用新版 Chrome 时添加 `--extension-install cdp --browser-path <Chrome可执行文件>`；其余焦点隔离和夹具边界相同。

播放页菜单校时使用真实按钮点击，验证正负半秒的字幕内容、视频进度不变、仅原文模式、时间轴空档、重新打开页面后持久化、跨页同步、连续点击、重置和播放期间按帧更新。没有时间轴时禁用无效的提前/延后操作，仍允许重置已保存的偏移。

`node scripts/run-youtube-subtitle-sync-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-youtube-sync` 在临时 Edge profile 的后台可见窗口中验证文档全屏、菜单操作、整句/逐词字幕定位、时间边界、重复句、延迟译文、真实视频 seek、空字幕、原文模式和关闭清理。夹具使用真实视频进度、受控 YouTube DOM 与模拟翻译响应，不代表真实 YouTube 字幕供应或翻译服务质量。

该专项还逐动画帧采样原生字幕的可见性，覆盖前句过期、下一句延迟、seek 和整块字幕容器替换；容器替换会在观察器重新绑定前立即检查样式。双语/译文模式和暂时隐藏字幕时持续接管原生显示，切回原文、关闭视频翻译或扩展后恢复，未选中的播放器保持原样。`videoSubtitleTrackPriorityRuntime` 补充播放器重绑、离开视频页和卸载清理。脚本通过 `--runtime-diagnostics-helper <浏览器翻译测试技能>/scripts/runtime-diagnostics.cjs` 指定诊断采集器，默认使用本机该技能；在导航前附加网页和 popup，并采集扩展后台，保存错误/告警、上下文归属与采集空窗。Edge 夹具与 Firefox 构建不能代替 Firefox 真实 YouTube 验收。


## YouTube 受限直达音轨本地转写

`youtubeDirectAudio` 覆盖当前视频身份、直达音频资格、googlevideo URL 边界、完整响应与 PCM 校验、取消/期限和自有字幕层清理；`videoSubtitleTrackPriorityRuntime` 通过真实生产模块及 DOM 验证入口资格、fullCapture 接线、晚到原生字幕仲裁、导航/广告/取消/卸载，以及失败不触碰播放器/CC。全部音频、模型和网络端口均为确定性夹具，不代表真实 YouTube 音轨或 CORS 验收。受限能力、缓存行为和未验证范围见 [YouTube 直达音轨](../maintainers/youtube-direct-audio.md)。
