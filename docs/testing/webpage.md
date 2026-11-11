# 网页翻译与站点兼容

[返回测试入口](../testing.md)。按本次改动选择下面的专项；这些条目不要求每次全部运行。

## 网页操作提示

网页提示按每条内容独立收缩：小品牌图标、具体结果和关闭按钮一行优先显示，不再用「流畅阅读 · 操作完成」占一行标题。品牌和状态仍供辅助技术读取；长文自动换行，缺少凭据时保留设置入口，关闭按钮至少 28px。提示外的留白允许继续点击网页，悬停或键盘聚焦暂停自动消失。

`pnpm test tests/pageNotice.test.ts tests/informationHighlightContent.test.ts` 验证既有通知生命周期与智能高亮反馈。生产构建后使用 `node scripts/testing/run-page-notice-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper scripts/testing/focus-safe-browser.cjs --artifacts-dir <证据目录>`，在临时 Edge 后台可见窗口验证短提示尺寸、长文与设置操作、深色及窄屏、关闭/暂停和提示旁点击穿透，保存截图与布局报告。浏览器报告区分实际生产入口与长文布局夹具，不代表 Firefox 实机验收。

## 翻译结果与浏览器清理边界

GitHub 等站点的软导航可能在 `pushState` 后才整体替换 body。独立 Vue Shadow UI 统一挂在 html 下，悬浮球与划词入口因而保留原实例，不依赖路由事件、Turbo 事件或固定延时重建。`pnpm test tests/shadowUi.test.ts tests/contentFeatureMounting.test.ts tests/contentFeatureRegistry.test.ts tests/floatingBallLifecycle.test.ts tests/userscriptPlatform.test.ts` 验证真实 WXT 0.20.18 挂载在路由检查后经历 0、34、572、1000ms 延迟 body 替换时仍存活，以及既有禁用、恢复与上下文失效清理；WXT DOM 用例仅替换 Vue app 端口，不代表 GitHub 实站或真实浏览器验收。

GitHub 文档出现译文消失、重现时，先记录扩展版本、浏览器、网页地址和触发动作。`tests/bilingualReplay.test.ts` 包含 Issue #969 截图对应的行内代码与链接段落，使用真实 MutationObserver 检查窗口 resize 后零自重放、译文零移除、链接提示变化、同文 Text 重绘与恢复原文。它验证当前实现的状态保持，不能单独证明反馈者的根因。

生产 Chrome 构建后，运行 `node scripts/testing/run-github-document-stability-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --artifacts-dir <证据目录> --background --live --full-mode viewport`。默认访问截图对应的 `pi-subagents/docs/models.md`，在临时 Edge 后台正常窗口记录选定正文的译文增删和内部子节点重写、源码节点身份、链接与代码、窗口宽度变化、滚动返回、可信鼠标经过以及全文/段落翻译—恢复—再次翻译；尺寸复验有独立 Node 看门狗，页面观察器循环也必须失败并清理本次浏览器。`--full-mode all` 检查立即处理整页，省略 `--live` 使用自建 GitHub 域名夹具。`--published` 验证已核验散列的正式发行包，记录其版本与 content.js 散列，不对该外部包套用当前检出的源码新鲜度检查。网页使用实站 DOM，翻译响应受控；结果不代表在线供应商、其他扩展共存或反馈者安装版本的验收，GitHub 错误页单独记录为访问失败。

正式发布包对照确认：0.0.35 在截图段落悬浮翻译后，窗口宽度变化可触发译文内部骨架反复重放。原因是 `agents.md` 链接从翻译槽中排除，却仍被实时结构签名记为正文；提交与复验签名因此不同。修复 `7db288d26` 统一了两者的 Text 保护政策，已包含在 [0.0.37](https://github.com/FluentRead/FluentRead/releases/tag/v0.0.37)。同一实站、受控响应和 resize/指针/滚动操作下，0.0.37 没有内部重写；0.0.34 同路径也未复现，不能把 0.0.35 的原因套用到它。旧包复现中整个 wrapper 没有移除，因此结论是已确认并修复译文内容的自刷新循环，反馈者的具体浏览器与触发动作仍未确认。

[#969 的后续反馈](https://github.com/FluentRead/FluentRead/issues/969#issuecomment-6574399232) 涉及 GitHub 仓库 README 的悬浮和右键划词。`tests/hoverRemountRecovery.test.ts` 验证请求在途时，同一路由和原位置的唯一等价 README 允许一次悬浮重试，链接变化或重复正文会放弃恢复。`tests/selectionTranslatorCore.test.ts` 验证三击段落时，终点即使落到下一段禁译代码块的偏移 0，也能读取已选的正文。实际选入禁译内容时继续拒绝。

`translationEchoValidationRegression` 与 `free-translation` 覆盖中文目标下长篇 Latin 外语结果的拒绝、既有线路降级、批量槽顺序、旧缓存失效、取消与共享请求期限。判定需要原文和结果都有充分的外语证据；中文结果、专名、技术标识、短句与不确定语言保持保守处理。拒绝错语种不等于对译文质量作完整评估。

GitHub 仓库列表和 Issue 列表同时保留旧容器与当前结构的保护规则，正文和标题仍须翻译。站点测试查询原样完成状态时使用可见文本，原始文本与结构仍用于恢复检查；隐藏反馈内容变化或仅 CSS 可见性变化均不能沿用旧完成证明。

`processRegression.test.ts` 在 Vitest 完整入口内串行执行普通上下文、后台信号与后台清理三套原生 Node 进程夹具。真实子进程验证重复中断只清理一次、保留首个退出码、等待完整所有权清理，以及原关闭期限和身份校验失效时保留失败。Node 测试不启动浏览器；实际不抢焦点及扩展功能须由临时 Edge 的原生焦点监控和生产浏览器专项另行验证。弹窗主题截图在既有阶段期限内等待颜色过渡结束。

## 网页个人校订

`personalCorrectionUiRuntime` 还覆盖同一个译文节点反复失效与重译：旧观察器退出时必须释放节点身份，重新选中后继续观察原文变化，旧观察器的排队回调不能关闭新卡片。

`personalCorrectionMemory`、`personalCorrectionDom`、`personalCorrectionTranslation`、`personalCorrectionComposition` 和三组 `personalCorrectionUi` 测试覆盖确认后保存、版本竞争、范围与语言隔离、近似候选、冲突拒绝自动复用、取消、节点归属、项目显式加入、编辑、删除与撤销；实际 Vue 模板检查语言信息归入页签栏、范围选择归入底部操作栏，以及范围帮助的悬停、键盘聚焦、Escape 收起与卸载清理。新增执行模块纳入严格四维覆盖率。

生产 Chrome 扩展构建后运行 `node scripts/testing/run-personal-corrections-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <捆绑 Node 包目录> --focus-safe-helper <focus-safe-browser.cjs 路径> --artifacts-dir <证据目录> --real-url https://example.com`。脚本使用第二屏临时 Edge 后台窗口和可信输入，翻译响应为确定性 Google 夹具；网页、双语渲染、后台消息和加密存储使用生产实现。验证原句重复复用时零额外 provider 请求、近似句只作草稿、两种语言与标题语境隔离、材料/项目范围、恢复重译、公共缓存隔离、页签栏右侧语言与底部紧凑范围的实际几何、范围帮助的真实悬停/焦点与 390px 提示边界、焦点恢复，保存 JSON、DOM 和截图。此证据不代表在线译文质量或 Firefox 实机验收。

## 实现审计：取消、恢复与热路径

`apiKeyRotation` 验证单密钥、无密钥和关闭轮询时的取消终态，凭据回显脱敏，以及无敏感元数据时保留原错误类和恢复标记。`informationHighlightArtifacts` 验证缓存命中期间取消、无视取消的连接或流读取、迟到响应释放和超时来源禁止回写；`documentHistory` 与 `documentHistoryCommitter` 验证 blocked/timeout 后的迟到连接释放、恢复连接与旧事件隔离。模型等待使用受控 transport，不能代替真实大文件或 CDN 下载验收。

模型流的取消等待还覆盖 2,048 个连续数据块及 EOF：保留实际字节与 SHA-256 校验，确认不会让同一个未决取消 Promise 累积所有读取的回调；操作计数不能替代真实浏览器堆内存测量。`personalCorrectionMemory` 验证清理后的迟到广播、扩展运行时撤销后的安全注销、注册失败和注册期间取消，始终使用注册时的事件对象完成本地清理。

`freeWebProviders` 与 `serializationPerformance` 验证七类免费适配器沿用原包槽位边界：原文中的字面标记、空槽和空白必须保留，译文注入活动标记则拒绝结果，不能重新猜测或更换命名空间。HTTP/SSE 响应使用受控夹具，不代表在线服务验收。`offscreenMessageRouter` 验证取消后不再读取、编码迟到音频或格式化迟到错误；正常响应仍按原协议结算一次。

`informationHighlightBackend` 验证暂停后的立即恢复会等待旧下载排空，后续暂停、删除和销毁能撤销旧恢复意图。`informationHighlightContent` 验证同一 Text 节点的数据重分配、同值重写及改回原文后重建绘制位置，同时保留评分缓存和未变化滚动的 Range 身份；原生 Range 的真实变更另以临时 Edge 对照夹具验证。`documentAppLifecycle` 和 `pdfOcr` 验证混合 PDF 补入扫描段落后，按原页、块位置及原文迁移已有译文和人工确认；重复原句不能跨块误配，取消与识别失败保留原状态，明确重译才清空确认。

`contentUiRuntime` 通过真实 feature registry 和悬浮球 runtime 验证宿主被页面移除后释放旧订阅并重建、旧排队回调隔离、停用后的迟到挂载移除与再次启用恢复；单纯替换 body 保留原实例。Shadow UI 工厂与组件端口在该测试中受控，不等于真实 Vue 挂载或网站验收。

`popupBootstrap` 验证设置页等待配置及界面资源时的退出与水合状态复核；阻止迟到挂载后，启动失败仍须由真实入口消费拒绝并提供手动恢复提示，不能留下空白页。`pageDiscourseContext` 验证候选本身就是文章或正文根时不读取根外兄弟和文档标题；请求等待期间移入另一材料须拒绝旧依据，同一材料内的合法移动继续有效。

`documentTextWrappedParagraphs` 验证补充平面汉字与普通汉字之间的固定宽度折行，覆盖 LF、CRLF、CR、边界空白及 Latin/emoji 对照，导出原文保持不变。`pdfReadingRegions` 与实际阅读计划消费者验证纯文本计划无保留区域时直接保留条目身份和顺序，不访问区域几何；操作计数只说明跳过的计算，不代表实际 PDF 渲染耗时。

`materialSource` 验证主动收藏新材料时立即清理旧恢复失败提示。`translationStatsAggregation`、`modelUsageAggregation` 与 `usageDashboardLifecycle` 验证已有记录起点（含 null 和 0）不再触发额外全量起点扫描，缺省时逐项归约而不展开无界函数实参；稀疏直方图的零或负分位数也须返回有限下界。大数组属于纯聚合合同测试，不能据此声称正常有界存储曾发生界面崩溃。

`vocabularyReencounterLifecycle` 通过真实 feature registry 验证消息订阅失败时回滚、恢复后重试、注册期间失效和卸载后的排队通知；扫描器和消息端口受控。`vocabularyTtsPageCancellationRuntime` 挂载真实收藏组件，验证停止后不解码等待恢复的音频、旧浏览器话语的开始事件不影响下一次朗读及超时保护；音频设备、浏览器语音与供应商仍是受控端口。

`inputBox` 与 `inputTranslationContentFeature` 覆盖 fieldset 继承禁用、首个 legend 例外、响应前再次检查及提示定位的按帧合并与卸载清理。`videoCaptionPlatformRuntime` 保证失败句 A→B→A 在退避期内仍可手动重试；`videoPretranslationController` 检查换句不重绑原生字幕监听，轨道增删只操作变化项。`paragraphCopyCore` 验证复制代码时保留首行缩进及内部空行。

`emojiLiterals` 对简单 emoji 检查零分段器构造，复杂字素每次扫描只构造一次；`harnessMemoryRecall` 用 200 条学习笔记检查无检索信息的查询不构建搜索投影，并保留偏好排序和每次重读。操作计数和 Node 微基准只证明所测计算减少，不代表页面帧率、输入延迟、实机内存或全项目无缺陷。函数索引、人工审查与实际行为验证须分别记录，未审函数不能因类型检查或测试总数而视为审查完成。

## 官网网页与漫画翻译演示

点击官网示例的第二步，会先显示翻译中的转圈与段落占位动画，或漫画气泡的扫描动画，随后展示译文并停留在结果。重复点击可重新演示；底部按钮可暂停、继续和重播。系统开启减少动态效果时，点击第二步直接展示结果。

执行 `pnpm docs:typecheck`、`pnpm docs:build` 后，运行 `node scripts/testing/run-site-demo-loading-test.cjs --playwright-root <Node包目录> --browser-path <Edge可执行文件> --output /private/tmp/fluentread-site-demo-loading`。专项使用隔离无窗口浏览器，不访问用户 profile，检查中英文首页在 1440、390、320px 宽度下的自动播放、真实点击、CSS 动画运动、逐段显示、完成停留、重复触发、暂停继续、跳转与重播，以及减少动态效果和其他演示的步骤控制。报告与截图保存到指定目录；只验证官网本地示例，不调用扩展或真实翻译服务。

## 划词行内代码与代码块（issue #704、#845）

`tests/selectionTranslatorCore.test.ts` 覆盖行内代码与正文混排、部分代码选区、多段代码、公式、代码空白、代码块和交互边界，以及只翻译正文和批量失败处理。生产构建后运行 `node scripts/run-selection-trigger-test.cjs --inline-code-only --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir <证据目录>`，在临时 Edge profile 的后台可见窗口验证图标、直接弹出和快捷键，检查原文/译文代码节点、宿主 DOM 不变、正文混排请求不含代码、复制反馈及改选后的迟到响应保护。用户主动选择纯代码、`pre` 代码块或高亮代码中的文字时，可使用同样的划词入口翻译；正文夹带行内代码时仍保留代码原文。带有代码语义的节点、按钮和显式禁止翻译区域仍排除。

网页与微软批量响应为本地确定性夹具；此专项不代表真实供应商翻译质量或 Zen/Firefox 扩展运行时验证。

## 跨条目划词与装饰图标（issue #1317）

跨标签、跨行的正文选区经过无文本的 SVG 或 `aria-hidden` 装饰元素时应显示划词入口。选区两端的保护规则不变；选区内部的按钮、编辑宿主、显式禁译文字、隐藏文字和扩展 UI 文字仍排除。零几何控件继续放行，`display:contents` 控件仍按内容几何检查。

`tests/selectionTranslatorCore.test.ts` 覆盖类 GitHub changelog 结构的单链接、日期到链接、跨条目和整块选区，以及空装饰之后的受保护内容。生产构建后运行 `node scripts/run-selection-trigger-test.cjs --decoration-only --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper scripts/testing/focus-safe-browser.cjs --runtime-diagnostics <fluentread-browser-translation-test>/scripts/runtime-diagnostics.cjs --artifacts-dir <证据目录>`，在隔离 Edge 后台窗口验证正反向拖选、重复翻译、两点选取、右键选区丢失后的恢复、动态保护内容移除、宿主 DOM 不变和清除/离开页面。网页与翻译响应使用本地夹具；右键命令经生产内容消息重放，不代表原生菜单项点击、GitHub 登录页、外部服务或 Firefox 运行时验收。

## 编辑器内显式选区（issue #1237）

`tests/selectionTranslatorCore.test.ts` 验证选区完整位于同一局部 `contenteditable` 或文本框宿主时可显示划词入口，同时拒绝跨出编辑区的范围、原生输入控件、扩展 UI、隐藏内容和显式禁译区域。`tests/selectionTranslatorLifecycle.test.ts` 验证编辑器右键菜单复用同一宿主的已核验 Range，并拒绝右键目标与页面陈旧选区不匹配的情况；`tests/contentHotkeyRuntime.test.ts` 检查编辑器内选区也可作为划词快捷键候选。编辑器内选区只读取用户明确选中的文本，不从原生输入框值或浏览器提供的裸文本构造来源。

生产构建后运行 `node scripts/run-selection-trigger-test.cjs --editable-selection-only --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper scripts/testing/focus-safe-browser.cjs --runtime-diagnostics <fluentread-browser-translation-test>/scripts/runtime-diagnostics.cjs --artifacts-dir <证据目录>`，在隔离 Edge profile 中检查 contenteditable 选区入口与右键 Range 归属；浏览器窗口后台可见且不抢焦点。

## 同目标语言跳过与统一语言判断

`src/core/language` 是全文、悬浮、页面标题、划词、快捷键和共享翻译客户端判断“文本已是目标语言或排除语言”的唯一入口。`codes.ts` 统一两/三字母代码、ISO 639-2/B、宏语言成员、旧别名、地区、脚本与下划线写法，目标语言和排除语言共用同一比较；配置中的裸 `zh` 仍为简体，检测器给出的裸 `zh`/`cmn` 只表示书写体系未知，不匹配任何简繁目标。`identify.ts` 只以文本为缓存键给出与目标无关的结论，目标、排除列表或源语言变化都会重新比较。

识别副本先由 `technicalTokens.ts` 遮蔽 URL、路径、文件名、哈希、版本号、带版本模型名（可带一个首字母大写后缀，如 `GPT-6 Sol`）、代码标识符和字母数字编号，原文、链接和 DOM 不变。非 Latin 正文中的缩写、内部大写名称和格式名按词计权，不能主导结论；短名称结合本句充足的本族文字与相邻边界判定，规则覆盖中日韩与其他非 Latin 文字；引述、外语功能词、孤立英文提示及不可信的大写词组优先作为外语正文，因此不能靠目标语言占多数吞掉外语。反引号中的自然语言句子仍提供外语证据，代码标识符继续遮蔽。可信中文技术正文另按句查找代码、缩写、字段名或操作符表达式证据，只接纳有局部中文技术句架支撑的短术语（每项至多三词，表达式至多 128 字符）；名称权重仍不能压倒中文，功能词、引文、明确要求翻译/解释的外语与跨句证据不被吞掉。`tests/fixtures/chinese-technical-pr-906.json` 保存反馈页面的四段原文，`sameTargetLanguageRegression` 与 `sameTargetLanguageClient` 验证中文目标零请求、外语目标仍请求及相邻英文仍翻译；`languageIdentification` 使用独立术语检查正反边界。

`statistical.ts` 只把 franc-min 的候选分数当作同一文本内的排序和分差信号，并与功能词逆文档频率得分、正字法字母反证共同判断：功能词决定性领先、功能词领先且分差达标、功能词持平但分差更大、franc 前两位几乎并列时由功能词打破平局；franc-min 没有模型的目录语言只接受决定性功能词。分差阈值随文本长度缩放；单词、少于十个字母、名称、纯共享汉字、相近语言无法区分以及目录外相近语言（加泰罗尼亚语、加利西亚语、南非荷兰语等）都保留翻译。希腊文、希伯来文、泰文和印度诸文字按文字直接识别，并排除多调希腊文、意第绪连字和阿萨姆字母；日文与韩文分支会排除中文专用字形，韩文中连续八个以上汉字按中文句子处理。

测试分组：`languageCodes`、`languageTechnicalTokens`、`languageScripts`、`languageStatistical`、`languageIdentification` 为单元测试；`languageIdentificationCorpus` 用真实 franc-min 在校准语料、留出语料和第二份只测量的留出语料上检查每个“文本 × 目录目标”的错误跳过为零、目标与排除语言等价，以及任意两种语言整段拼接不会吞掉其中一种；`sameTargetLanguageClient` 与 `sameTargetLanguageSlots` 验证客户端、标题、批量/文本包/逐槽/AI 合并/公式拆分路径的一致性、取消与失败重试；`sameTargetLanguageRegression` 保留旧实现失败条件（德/葡/意三字母代码、排除与目标不一致、短句、日韩模型名、未配置排除语言时富文本槽只做字符集快判）。全文运行时的翻译—恢复—再翻译、动态改写、目标与排除变化、取消和重试由 `fullPageVisibilityScheduling` 中的真实识别用例覆盖；同段行内 `code` 只为语言预检提供上下文，仍受隐藏、禁止翻译与候选范围限制，不进入翻译请求或覆盖快照。

识别器对比可复现运行 `node scripts/testing/evaluate-language-detectors.mjs --out <report.json>`；追加 `--franc-full <本地 franc 包目录>` 在同一判断链中替换统计库，`--old-root <旧源码目录>` 对比旧实现，`--browser --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径>` 在临时 profile 的后台 Edge 中测量 `chrome.i18n.detectLanguage`。结果只代表这些由项目编写的语料，不作为通用准确率。历史基准见 [语言识别报告](../reports/language-detection-20260916.md)，当前架构和留出回归见 [目标语言优化报告](../reports/target-language-quality-20261011.md)。使用 `--extra-corpus tests/fixtures/target-language-release-corpus.json` 将本次独立发行说明语料加入同一评测。

生产扩展构建后运行 `node scripts/testing/run-chinese-translation-test.cjs --multilingual-same-target --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir <证据目录>`。专项复用临时 Edge、后台可见且不抢焦点的窗口，对 de/pt/it/fr/en/ru/ja/ko/zh-Hans 分别验证同目标段落和标题在悬浮与全文中零请求、相邻外语悬浮 `[1,0,1,0]` 与全文 `[1,0,1]`、GitHub `li > a` 提交链接保持、宿主 `lang="en"` 不影响判断、全文会话中动态改写为外语后重新请求、恢复原文，以及同一页面从德文目标切到英文目标、以简体为目标并排除德文时的结论。页面与译文来自本地回环夹具，只证明扩展判断链与请求计数，不代表真实供应商质量，也不替代 Firefox 实机验证。

PR #906 技术中文专项将上述模式参数替换为 `--technical-pr-906`，只验证反馈中的四段原文及相邻英文。它分别使用普通文本和交替 `code`/`strong` 包装，检查简体中文目标下悬浮、全文均零中文请求和零译文节点，恢复、再次触发、动态改写为英文与切换英文目标后按新文本及目标重新判断。结果和复现说明见 [技术中文重复翻译回归报告](../reports/chinese-technical-pr-906-20261009/README.md)。

发行说明专项将模式参数替换为 `--target-release`，验证截图对应的十段中文、普通与行内 `code`/`strong` 结构、中文目标零请求、相邻英文翻译—恢复—再翻译、动态正文改写和目标切换，并单独打开真实 GitHub Releases 页面复核八个中文段落，包含产品名称枚举。翻译端点仍为回环夹具，真实页面证据不能作为线上供应商译文质量证明。

`targetLanguageReleaseCorpus` 覆盖 52 个目录目标的自然段落、短标题、标记外壳和 Unicode 空白；所有文本逐一检查各目标与排除语言。`targetLanguageDetector` 和独立 `targetLanguageAdversarial` 覆盖名称预算、大写提示、引述、跨语种混合与代码字面量；`imageTargetLanguage`、`inputTranslationBackground`、`areaTextTranslation` 验证直接后台文本入口同目标零调用、原行映射、冻结目标和 AI 纠错协议保留。

### 冻结真实网页的完整扩展 A/B

语言跳过策略除了纯文本测试，还需要用同一批真实网页验证完整扩展。先冻结 HTML、自然选段、目标语言、人工预期和散列，再运行双方；不根据运行结果更改标签。以原 URL 重放，共享样式、字体与图片资源，阻止宿主脚本改写冻结正文。研究脚本、冻结样本和原始请求账本随实验单独保留，不作为产品构建或运行依赖。

双方使用同版浏览器、独立临时 profile、相同目标语言及固定等待 20ms 的回环服务，两轮交换执行顺序。保留各自候选发现、语言判断、分段、批处理与限速；记录实际配置。`fullPageTranslationMode=all` 是整页压力测试，产品默认值为 `viewport`，不能将其结果描述为默认配置表现。发现范围不同的实验只比较双方共同可见的同一组选段，整页 HTTP 与队列耗时不能用于同范围效率排名。

计时前核对唯一 selector、原文和布局，隐藏或零尺寸选段按原状态排除。自然段、含糊样本和代码对照分开统计；`ambiguous` 不进入语言判断的对错分母。`cold` 表示当前 profile 对该页、目标和模式的首遍，此前页面可能已经预热进程缓存。全文和悬浮分开运行，浏览器启动、页面准备与触发后的观察期限分别记录。

漏译必须检查实际交付：译文可能位于专属容器，也可能直接替换原节点。原位译文要证明仍是同一选段节点，存在原生翻译标记及受控响应，且实际可见；不能用祖先、相邻段或整页的译文冒充。所有选段按相同顺序进入视口起点和末端，各停留 200ms 并等待两帧，最多两轮。保留历史可见证明，最终滚动到屏外不撤销已经显示的译文。

请求证据保留原始 payload 与匹配方式。短标题仅作为长 payload 子串出现时，不能证明标题已发请求，应标记归属未知；无可靠请求的原因也不能直接归因语言识别。漏译再分为可靠已请求、未请求与请求归属未知，多余翻译按明确应跳过选段的可靠请求计数，并与整页 HTTP 总量分开报告。

需要翻译的选段没有全部生成并显示时，完成耗时标为 `censored`；主耗时只比较双方均完成的配对样本，报告样本数。页面队列超时、测量错误和产品终态错误分别记录，不把部分交付包装为全部完成。连续安静至少 3000ms 的观察窗口还包含视口探测与等待，不能当作翻译耗时。固定响应不验证语义质量，耗时仍含候选发现、触发延迟与原生调度，也不代表在线服务延迟或纯语言识别速度。

## 原文回显与逐槽恢复

`tests/chineseUiNamesRegression.test.ts` 验证“继续使用 Apple”“通过 Google 继续操作”等短中文界面文字在中文目标下保持原样；引号内的外语、英文提示与中外文混合正文继续参与翻译。`tests/identicalTranslation.test.ts` 只在展示比较副本中忽略 U+200B，保留大小写、可见字词间隔、简繁转换、ZWJ 与 ZWNJ 的差异。网页另通过 `targetResult.ts` 对可信同目标正文做排版等价兜底；`targetTranslationResult` 验证其不吞数字、否定、问感叹符、运算符、简繁、真实字词及引用/代码字面量变化。其他写作和文档编辑维持精确比较。

`tests/translationEchoValidationRegression.test.ts` 验证有外语证据的正文仅增加句末标点或 U+200B 时，后台恢复一次并拒绝连续回显，异常结果不能缓存；真实词字、数字和运算符变化不能被折叠为相同。`tests/translationSlotEchoRegression.test.ts` 验证内部单条协议逐槽恢复：保留成功槽和顺序，沿用冻结术语的“保持原文”规则、Chrome 长检测样本和同一请求截止时间；取消、损坏协议与部分回显缓存不能被当作完整成功。`tests/requestConfigSnapshot.test.ts` 另覆盖来源中的字面槽标记、嵌套及碰撞避让后的 nonce、共享下划线和长来源边界扫描；非法尾部编号不能驱动不受输入规模约束的槽数组分配。普通用户文本不因含有相似标记而自动进入内部槽协议。

空槽、恢复后结果与缓存共用有效内容判定：空白及仅含 U+200B 的结果不能成功缓存，ZWJ/ZWNJ 和数学符号不被作为空白删除。`tests/sameTargetLanguageClient.test.ts` 使用真实全文入口、client、后台 handler 和 broker，仅替换浏览器消息边界与 provider，验证整包空字符串不会被换成合法来源包而跳过逐槽回退；普通单条空响应仍沿用原文回退行为。

生产 Chrome 扩展构建后，运行 `node scripts/testing/run-identical-translation-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper scripts/testing/focus-safe-browser.cjs --artifacts-dir <证据目录>`。专项使用临时 Edge profile、第二屏后台窗口和本地供应商夹具，验证悬浮、全文、恢复、重复翻译与相同结果展示。其计数观察供应商 fetch；不能把零 fetch 推导成零 runtime 消息，也不代表在线供应商质量或 Firefox 实机行为。

## 双语链接悬停提示与属性边界

`tests/bilingualReplay.test.ts` 和 `tests/translationStability.test.ts` 覆盖链接 `title` 的增删改与焦点/字体标记组合、跨手势零修复预算，以及译文副本单独改写 `href`、事件、隐藏样式、ARIA、class 或无效 tabindex 时恢复可信属性。源文属性变化继续复用已提交译文；原文链接保持不变。

生产扩展构建后运行 `node scripts/testing/run-bilingual-attribute-drift-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <浏览器翻译技能>/scripts/focus-safe-browser.cjs --artifacts-dir <证据目录>`。专项使用临时 Edge profile、第二屏后台正常窗口和固定翻译响应，检查悬浮与全文模式的六轮链接悬停、逐帧工件在位、源链接骨架同步、语义属性恢复、零额外请求及翻译—恢复—再次翻译。追加 `--live-wikipedia` 检查真实 Menches 页面；固定响应不代表真实供应商质量，Edge 结果也不代表 Firefox 实机验证。

## 双语逐句高亮

`tests/bilingualSentenceHighlight.test.ts` 覆盖字符坐标、缩写、小数、中英文标点、无原生分句能力的回退、拆句与合句分组，以及双向悬停、内联结构、动态变化和关闭清理。定向覆盖率命令仅包含 `sentenceAlignment.ts`、`sentenceHighlight.ts` 和 `bilingualSentenceHighlight.ts` 三个模块。

生产扩展构建后执行 `node scripts/testing/run-bilingual-sentence-highlight-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --runtime-diagnostics <runtime-diagnostics.cjs路径> --artifacts-dir /private/tmp/fluentread-bilingual-highlight`。专项使用临时 Edge、第二屏正常尺寸后台窗口，验证真实 Control 翻译—恢复—再翻译、双向逐句定位、富文本、动态 DOM、关闭和配置持久化、多句设置预览、窄屏与深色；阅读辅助通过当前样式入口进入界面风格页，以“无”和预设验证停用、启用与重载后的保存。报告记录悬停期间的 DOM 变化、几何偏移、请求计数及隔离世界、扩展页面和后台诊断。未传入诊断采集器时报告会注明采集缺口，不能据页面断言宣称运行时干净。

启动性能对照使用 `node scripts/testing/run-startup-performance.cjs --extension-dir <正式产物目录> --kinds popup,options,content --runs 5 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --runtime-diagnostics <runtime-diagnostics.cjs路径> --artifacts-dir <证据目录>`，同条件分别测试基线与候选产物。它记录实际加载的脚本字节、就绪时间、脚本及空闲任务耗时；计时包含浏览器、操作系统缓存和采集开销，不将单次对照描述为稳定加速。针对配置编辑、未译长列表和划选的操作计数回归及本批结果见[性能与交互热路径优化](../maintainers/performance-interaction-20261024.md)。

页面与翻译响应为本地确定性夹具，不能代表真实服务的语义对齐质量或 Firefox 实机行为。参考 [duo-translator](https://github.com/linuxscreen/duo-translator/tree/f3abdd18a0e20687222ab338b367edf5476cf746/main/dom) 的文字范围绘制与相邻句分组设计；FluentRead 独立实现，未复制其 GPL-3.0 源码。

句子操作统一使用已有划词入口。定向回归使用 `tests/sentenceActionsMount.test.ts`、`tests/selectionTranslatorLifecycle.test.ts`、`tests/bilingualSentenceHighlight.test.ts` 和 `tests/selectionTtsContentController.test.ts`，验证普通悬停仅绘制高亮、选区卡片按需收藏句子、多语言来源、关闭偏好与请求清理。生产浏览器专项运行 `node scripts/testing/run-sentence-listening-test.cjs --selection-entry-only --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-sentence-selection`，验证原文和译文停留不弹入口、不增加请求；主动选中后只有一个既有小图标，点击才展开、复制和收藏，继续阅读、390px 布局、划词关闭和翻译—恢复—再次翻译。网页和翻译服务为本地确定性夹具，不代表外部服务质量或 Firefox 实机运行。

译文样式由 `tests/translationAppearance.test.ts` 与 `tests/translationAppearanceStyles.test.ts` 覆盖预设注册表、旧版选项顺序、外观归一化、颜色换算与网页样式节点的安装、原位更新和移除；颜色换算还保留旧配置中的字母裸 hex（包括不透明四位与八位），继续拒绝透明和损坏值。`tests/pageStyles.test.ts` 验证外观样式随公共页面样式一起安装、订阅配置更新，并在移除或 context 失效时一起清理。生产扩展构建后执行 `node scripts/testing/run-translation-style-ui-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-translation-style`：在临时 Edge 与第二屏后台窗口中验证界面风格页第一组为译文样式、六类 71 张样式卡片逐一写入配置并同步预览，其中卡片与趣味各 12 种；覆盖色板与方向键、滑块、分段控件和自定义取色器、仅译文提示、逐句高亮开关、重新打开后的保存结果、设置搜索直达外观面板与逐句高亮开关、深色界面与 1024/820/390 宽度；再用本地确定性夹具真实悬浮翻译，确认外观调整无需新请求即可更新已有译文，停用插件或恢复默认时移除外观样式节点，并检查简约卡片底色在网页上生效。

网页阅读样式兼容专项执行 `node scripts/testing/run-reading-style-compatibility-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --runtime-diagnostics <浏览器测试技能>/scripts/runtime-diagnostics.cjs --artifacts-dir <证据目录>`。它使用临时 Edge、第二屏后台正常窗口和本地确定性服务，让 24 款卡片与趣味样式经过真实内容脚本翻译；覆盖白色、黑色、暖黄、紫色页面、与网站相反的系统主题、同页深浅区域、已译文主题切换且没有新请求、390px 换行、链接点击与键盘焦点、自定义前景背景覆盖、强制颜色和打印。常规卡片还检查无实时背景滤镜、无外阴影、长页屏外隔离可用和完整滚动；该检查证明渲染路径与功能，不将单次滚动观察解释为 FPS 提升。报告保留运行时诊断、采集缺口、计算颜色与截图，受控页面结果不能替代所有真实网站、远程翻译服务或 Firefox 实机验收。

## 不翻译的语言（issue #627）

使用 `scripts/testing/run-chinese-translation-test.cjs --excluded-languages`，并传入原有的 `--extension-dir`、`--playwright-root`、`--focus-safe-helper` 和独立 `--artifacts-dir`。该专项复用临时 Edge、后台可见且不抢焦点的窗口与本地确定性响应，验证翻译设置末尾的语言多选、立即关闭后持久化、跨页同步、键盘操作、展开后选择与清空、七种界面语言，以及浅色 1440/1024/820/390 和深色 1440/390 布局。

翻译链路检查繁体与日语零请求、相邻英文的翻译—恢复—再翻译、标题保留、动态内容改成英文后重识别、自动全文与清空后恢复简繁转换。此证据不代表真实供应商译文质量，也不替代 Firefox 实机验证。语言与配置单测覆盖中文别名、非法输入、旧配置迁移、会话冻结、富文本槽过滤及子页面快照校验。

## 中文格式清单与重复请求

`tests/chineseLanguage.test.ts` 覆盖中文文档格式清单、简繁字形相同的“新增功能”标题、短中文中的 AI/PDF、带版本与后缀的技术名称（例如 GPT-6 Sol）、发布说明中的提交哈希、真正外语正文与简繁转换边界。`tests/fixtures/chinese-language-model-post.json` 保留用户反馈原文，分别验证四行和整段；这份测试语料不代表对其中新闻内容的事实确认。

语言检测仅在用于判定的副本中识别标识符，原文保持不变。中文正文仍须有字形或词语证据：标识符规则与其他语言共用（见上文统一语言判断），文件格式不占外语预算，带版本的技术名称和缩写按词计权，提交哈希、更长摘要和字母数字混合编号不算外语；普通外语词、完整外语句子、简繁混排和不确定汉字继续翻译。中文词语证据同时用于中性字形和简繁字形，避免“允许清空”“不再保存”因未命中单字短表而重复翻译。简体证据另由 Unicode 17.0.0 补充中国来源且无日本来源的常用单向简体字；来源属性只作为辅助证据，不能直接等同语言。生成命令为 `node scripts/testing/generate-chinese-variants.mjs <Unihan_Variants.txt> <Unihan_IRGSources.txt>`，两份输入均来自固定版本的官方 Unihan 压缩包，生成文件保留各自 SHA-256。

生产扩展构建后运行 `node scripts/testing/run-chinese-translation-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-chinese-browser`。专项在临时 Edge profile 的后台可见窗口中，检查悬浮零请求、全文跳过中文且继续翻译相邻英文/繁体内容、恢复再翻译，以及动态中文改为英文后的重新识别；同时复现 GitHub 发布说明的 `li > a` 提交链接结构和宿主 `lang="en"`。端点在校验原文前记录请求，夹具拒绝的无效请求也会计数。页面和供应商响应为本地夹具，不代表真实翻译质量。

## 输入框翻译

`node scripts/run-input-translation-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-input-translation` 使用生产扩展和临时 Edge profile，在第二屏后台验证输入框配置保存、三击间隔与恢复默认、独立模型和提示词、窄屏与深色布局，以及真实按键的翻译、重复请求去重、后台 AbortSignal 取消、恢复和失败重试。还检查富文本失焦不夺回焦点、原生输入保持其他控件的焦点与选区、写回和恢复期间的新输入保护、390px 提示边距与滚动跟随，以及编辑器拒绝写入时可手动复制的译文。

供应商响应与网页均为本地夹具，报告中的请求记录用于核对模型、提示词和原文；不代表外部服务连通性或模型翻译质量。`tests/inputTranslationConfig.test.ts`、`tests/inputTranslationBackground.test.ts` 和输入框内容脚本测试覆盖配置迁移、缓存隔离、输入快照、选区、输入法和迟到结果保护；`tests/inputEditableHost.test.ts` 覆盖编辑宿主的光标度量、选区同步等待、合成粘贴与原生插入回退。

同一专项还验证富文本编辑区：原生 contenteditable 通过可撤销的原生插入写回，撤销后恢复粗体结构；模拟 Lexical/Draft.js 的模型驱动编辑器只在 selectionchange 后同步选区，报告中的 `modelEditorLog` 用于确认整段粘贴发生在选区同步之后、没有重复插入；plaintext-only 支持三连触发，密码框和代码编辑器保持不参与。`node scripts/run-rich-text-input-editors-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-rich-text-editors` 从 esm.sh 与 jsDelivr 加载真实的 Quill、ProseMirror、Lexical、Slate 和 Draft.js，逐个验证三连触发后编辑器自身模型只含译文、原文不含触发符，以及恢复原文；该脚本需要联网获取编辑器，结果不代表具体网站的定制编辑器。Firefox 与用户脚本构建需另外执行，Edge 结果不能替代其运行时验证。

给真实编辑器脚本追加 `--slate-fast-cache`，会在 Slate 连续执行五轮翻译与恢复：前三轮供应商立即返回，第四轮开启缓存并预热，第五轮断言缓存命中且不发送供应商请求。每轮都精确检查编辑器模型与 DOM 文字，避免只看到页面变化却留下旧模型内容。专项结果见 [输入框翻译质量报告](../reports/input-translation-quality-20261011/README.md)。

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

## 快捷键草稿与录制弹窗

`tests/translationShortcutSettings.test.ts` 使用真实 Vue effectScope 验证三种快捷键的重复选择、延迟打开、取消、确认、清除、配置替换、分区离开和卸载，并检查划词触发字段同步及额外方案冲突。`tests/customHotkeyInputLifecycle.test.ts` 执行实际客户端 SFC 模板、Teleport、按钮事件和 Vue 卸载；DOM 与焦点端口由 Linkedom 提供，检查录制只有一个完成计时器、旧录制不能结束新录制、当前值变化取消旧录制、确认前冲突重验、焦点循环和关闭后不抢走新控件焦点。两模块进入永久四维 100% 覆盖率清单，不使用覆盖率忽略。

生产 Chrome 构建后运行 `node scripts/testing/run-lazy-options-ui-test.cjs --suite shortcut-lifecycle --extension-dir .output/chrome-mv3 --playwright-root <path> --focus-safe-helper <path> --artifacts-dir <path>`。专项验证首次直达划词设置、真实键盘录制与取消、清除保存、切换分区阻止迟到弹窗、390 像素与减少动态效果、传统全文快捷键保存。为在 100 ms 打开延迟内稳定离开，只有该离开用例使用 DOM 导航点击；录制和其他操作使用可信浏览器输入。此专项验证生产扩展设置和存储，不代表真实翻译供应商或 Firefox 运行时。`--suite hotkeys` 继续验证共享弹窗在段落复制、额外悬浮方案和圈选翻译调用方中的兼容性。

## 简体与繁体中文回归

同目标与排除语言的定向回归运行 `pnpm test tests/languageChineseInterface.test.ts tests/languagePreflight.test.ts tests/targetLanguageReadingHoldout.test.ts tests/sameTargetLanguageClient.test.ts tests/sameTargetLanguageSlots.test.ts tests/translationStability.test.ts`。中文规则、补充检测资格、同文复用、超时、取消、配置快照及结构化槽分别验证。补充检测只接受本地候选与浏览器可靠单语言结果一致的长文，浏览器 API 不可用或超时则继续原翻译流程；不会覆盖源语言设置。

质量夹具分为开发后留出的 96 条样例与实现稳定后评估的第二组 60 条盲测，均以 SHA256 冻结，分别对全部 52 个目标检查误跳过及正确跳过比例。已经查看的样例作为回归集，不再称为盲测；不以提高跳过比例为由放宽混排或简繁转换的期望。历史语料中“您的更改已保存。”没有简繁区别，语言标签更正为两者共享，此更正不计入提升。

相对主线同一识别核心，第一组正确跳过为 51/80 → 67/80，第二组独立盲测为 29/55 → 36/55；4,992 和 3,120 组文本—目标组合均零误跳过。这些是有限人工编写样例，不能推断全部网站或线上供应商的准确率。补充资格限长 1,024 字符并保留最近 128 项完整文本结果，超限继续翻译；不将热缓存耗时当成新文本耗时。Userscript 在同依赖独立主线 `0fef0669` 上为 2,092,304 字节，候选 2,099,247，增加 6,943 字节（0.332%）；体积预算按既有 1 KB 步长最小增加 5 KB，协议与执行断言不变。

生产 Chrome 产物的网页链路使用 `node scripts/testing/run-target-language-reading-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <path> --focus-safe-helper scripts/testing/focus-safe-browser.cjs --artifacts-dir <path>`。脚本在临时后台 Edge 中验证 Control 悬浮、Alt+T 全文、恢复再译、目标切换、动态文本与零请求跳过，记录 DOM、请求和截图。本地响应仅用于证明调用和显示契约，不证明在线供应商的翻译质量。

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

## 局部翻译选择流程

```bash
node scripts/testing/run-section-translation-flow-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <path> \
  --focus-safe-helper <任务工作树>/scripts/testing/focus-safe-browser.cjs \
  --runtime-diagnostics <浏览器测试技能>/scripts/runtime-diagnostics.cjs \
  --artifacts-dir /private/tmp/fluentread-section-flow
```

使用 `--case-set sweep` 可单独验证真实 Alt+R 进入后左键划过两段、往返去重和间隙排除、从段落空白起划后收窄外壳、旧选择器退出动画不打断下一轮拖动、逐块高亮、松开仅锁定且确认前零请求、整组扩大缩小、精确翻译/恢复、混合已译状态补译、重新选择、Esc 取消后网页点击恢复，以及非首段被移除后的失效保护。`core` 保留原有单击、快捷键和页面生命周期回归，可与 `sweep` 分别运行。传入 `--runtime-diagnostics` 后保存内容脚本隔离世界、Popup 和后台的错误与告警；报告同时保留附加前启动日志等采集空窗。

划过体验专项使用 `--case-set quality --quality-cases pointer,layout,nested-scroll,boundary,cancel,narrow`：`pointer` 记录同段内 120 次可信指针移动的高亮隐藏帧、几何变化、浮层 DOM 写入以及布局、样式与脚本开销，核对最终邻段命中、原文布局不变和确认前零请求；原生时序指标仅用于同环境对照。`sweep` 另验证单次跨六段并立即松手仍精确选择和翻译六段。`sectionTranslationPicker` 单测覆盖同帧折线保留、松手统一盘点、稳定窗迟到复验、无关侧栏滚动与路径内滚动的区分，以及多框读写分离；样式和几何同值时不重复写入浮层。

使用临时 Edge profile、防抢焦点 helper 和 CDP 真实指针/按键，在类 GitHub 仓库页夹具上验证：Popup 局部按钮与主按钮同排等高，消息进入选择模式后稳定预览鼠标下的段落，边缘轻微移动不换选；点击只锁定选区、不请求服务且不跳转，锁定后鼠标移动与滚动不改变范围；可见按钮扩大到 README、缩小及重新选择，确认按钮才翻译该区域，网页收不到选择点击，视口外段落排在最后翻译，导航、文件列表、侧栏、页脚和代码保持原文；再次选择同一区域显示“恢复原文”并只恢复该区域。伪造点击和 Esc 不影响选择，真实 Esc 与右键退出且不发请求；主动选择侧栏时按全部节点范围翻译；已是目标语言与空白区域给出提示且不请求服务；快捷键默认关闭、开启后可进入和退出且在输入框中让行；全文恢复原文同时清除局部译文，关闭插件立即退出选择模式。追加 `--github-url <仓库地址>` 可在真实 GitHub README 上重复点选流程并断言 README 之外没有译文。翻译传输是确定性 Google 夹具，不代表外部服务可用性。

### 悬浮说明框翻译稳定性

`run-full-page-translation-test.cjs` 在全文翻译会话中动态创建与旧 Bootstrap 相同结构的 tooltip，按原文高度定位，使双语内容增高后覆盖触发图标。真实 CDP 鼠标连续执行两次移入、持续停留和移出，断言每次只打开一次、译文仅一份、图标仍获得鼠标命中，移出后正常关闭。报告的 `tooltipHover` 同时记录语义 tooltip、未翻译提示、交互弹层和恢复原文后的命中边界。该保护只作用于已翻译的纯说明提示框，保留链接、按钮和可聚焦控件的交互。此测试为本地结构夹具，不代表登录后的真实网站验证。

Ko-fi 的 Monthly 按钮把 tooltip 插在按钮内部。回归同时覆盖提示框独立发现、按钮原文与请求槽不包含提示文字、提示框出现或移除不使按钮来源失效，以及直接控件翻译和加载阶段的命中保护。`scripts/run-kofi-tooltip-test.cjs --url https://ko-fi.com/thinkstu` 用临时后台 Edge 访问真实公开页面，配合本机延迟翻译响应验证持续悬停、再次悬停、移出关闭及恢复原文；需同时传入 `--extension-dir`、`--playwright-root`、`--focus-safe-helper`、`--artifacts-dir`。该脚本不访问日常浏览器配置，真实页面证据与本地翻译 transport 分别记录。

新增局部快捷方案后，该流程同时检查：主快捷键关闭时独立方案仍能进入容器选择，确认前没有请求，容器外保持原文，目标语言实际传给供应商，换方案重译、同方案恢复，以及输入保护和同键/Esc 取消。Google 的浏览器批量、网页批量和 RPC 接口均使用确定性响应，不代表真实服务翻译质量。

设置专项执行 `run-lazy-options-ui-test.cjs --suite section-hotkeys`，其余扩展目录、Playwright、focus-safe helper 和证据目录参数同上；验证真实按键录制、重复快捷键拒绝、独立服务与语言、主快捷键关闭、关闭重开后的保存和 390px 无横向溢出。

