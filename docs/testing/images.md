# 图片、漫画与圈选

[返回测试入口](../testing.md)。按本次改动选择下面的专项；这些条目不要求每次全部运行。

## 圈选模型识图

`node scripts/testing/run-area-vision-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <focus-safe-browser.cjs路径> --artifacts-dir /private/tmp/fluentread-area-vision` 使用生产扩展与临时 Edge profile，在后台可见窗口中验证识别方式及提示词保存、选区裁剪、无需 OCR 语言包的视觉路径、不支持或未知模型的 OCR 路径、模型能力覆盖、失败重试与取消清理。

该脚本的模型端点是本机 HTTP 夹具。它检查真实发出的图片尺寸、摘要及提示词，报告不保存图片请求体或凭据；截图展示真实扩展 UI。通过意味着请求和交互链路符合约定，不代表真实视觉模型对手写、模糊文字或复杂版面的识别准确率。

## 图片翻译完整流程

### 漫画顺序与文字边界的离线回归

`mangaReader` 与 `imageTranslationRuntime` 用确定性 DOM、布局帧和请求 gate 检查混合 IMG／Canvas／背景图片的顺序、重复或非法序号的稳定回退，以及布局变化通知到下一帧之间不启动过期任务。显式重试和开关仍读取最新布局，取消、暂停、释放与迟到结果的所有权断言保留。该范围不下载或加载识别模型，不证明公开漫画站点的真实 OCR 质量。

`imageOcrNormalization`、`mangaQuality` 和 `imageTranslationRendering` 保留韩文 Jamo、补充平面汉字及 IVS、半角浊音、组合字符与 emoji 的完整原文，并检查现代字素分割和缺少 `Intl.Segmenter` 时的窄框排版。后者只在确定安全的空格两侧分词，复杂无空白词组保持整体；英语组合字符、法语、俄语、泰语与老挝语的多词段落另检查字号，不能以整段缩字代替换行。纯 ASCII 与普通东亚文字仍保留原快路径。

回退使用固定 Unicode 17.0.0 的 Extend／SpacingMark／ZWJ／Prepend 区间，测试读取仓库内的官方原始属性文件独立核对，不在 CI 访问网络。运行 `node scripts/generate-image-grapheme-space-data.mjs --check` 校验离线生成与输入 SHA-256；来源、版本和许可见 `public/third-party-notices/image-grapheme-space-NOTICE.md`。该表只支持 ASCII 空格的局部边界判断，不是完整 UAX #29 分割器，也不声称恢复模型漏识别的文字。

### 漫画质量场景与模型复用

漫画专项和图片专项的 `--x-lightbox` 模式默认复用主仓库旁 `workspace-data/model-cache/` 中的公开 PaddleOCR／LaMa 文件。可用 `--model-cache-dir <目录>` 或 `FLUENTREAD_TEST_MODEL_CACHE_DIR` 指定位置。每次使用都按生产清单检查长度与 SHA-256，缺失或损坏才下载；并发测试共享逐文件锁。文件通过原有导入入口放入全新的临时浏览器，不复用日常 profile。报告记录每个文件的命中来源、下载数及导入状态。普通图片只准备 OCR，漫画按需包含修补模型；模型下载、来源故障和离线导入专项保留各自原有路径，不用缓存掩盖这些行为。Tesseract 语言包不在这份共享权重缓存内。

默认目录从测试 helper 所属仓库的 `git common-dir` 定位，因此从其他工作目录启动也复用同一缓存；源码快照无法定位 Git 时才回退到调用目录的 `.cache/image-translation-models/`。环境变量指定的相对路径以调用目录为准。

运行 `python3 scripts/testing/generate-manga-quality-fixtures.py --output-dir <证据目录>/corpus` 生成二十八类原创确定性场景：多气泡与单行旁白、日文竖排、横排日文混排、跨瓦片边界的长条漫、反白对白、纹理背景，以及双页相邻气泡、竖排注音、倾斜文字、窄条小字、双轴瓦片、彩色背景、合法重复对白和完全无字页；另覆盖手写笔记、日英菜单、低对比渐变、8/12/18px 小字截图、带尾气泡与长对白、聊天截图。新增八景包含真假 OT 与数字字母混码、斜字黑彩前缀和灰色尾文、多主列注音、报刊三栏嵌图、连接边框的文字与独立次行、密集无字拟字纹理、RGBA 透明通知和地图嵌图的正反九十度边注。需要 Pillow 和脚本参数指定的英文字体、日文字体；manifest 记录版本、六种字体及图片散列、129 个唯一原文锚点、28 个无字区域与保护像素。原二十类图片和期望保留；相同字体与 Pillow 版本可逐字节重建图片。小字难以识别也保留精确真值，不能以字高删除失败。

`tests/fixtures/manga-natural/manifest.json` 另提供四张固定 PNG 的原创自然漫画，覆盖密集线稿、网点、斜向分镜、夜景彩色渐变、反白气泡、深色机械科幻维修及浅色水彩动物漫画，共 18 个对白或旁白锚点和 12 个无字区域。生成提示、人工核对与选图过程见同目录 README 和 provenance；真值在首次 OCR 前冻结，图片以 SHA-256 固定，AI 生成不承诺可重复重建。这些测试资源不进入扩展。可将两份 manifest 的 fixtures 合并到独立证据 manifest，file 改成各自绝对路径；浏览器专项允许最多 32 景，合并后仍逐图校验散列与原文真值。

`tests/fixtures/manga-confusables/manifest.json` 是单独运行的六景控制集：不同模糊、字号、底色、两种字体与互补混码，保留真正的 OT、OO、IT、07 和字符库存相同但顺序不同的编号，共十二条完整原文锚点。设计与像素在首次 OCR 前固定，不并入主 32 景上限。`python3 scripts/testing/generate-manga-confusable-fixtures.py --out-dir <新目录>` 用固定 Pillow 和同 SHA 字体重建；`node scripts/testing/check-manga-confusable-fixtures.cjs` 无需模型，校验输入及二十五项误认、艺术假字和多字反例。首次浏览器基线的重复文字失败和未覆盖路径保存在目录说明与 baseline，不能用锚点齐全代替整体通过，也不能仅凭视图一致或置信度升高替换混码。

`tests/fixtures/manga-chromatic/manifest.json` 单独提供八景：白底红/品红字、黑底青色 HUD、等亮红绿卡片、两种 RGBA 叠层、细字与近白彩色尾字、混合彩底和完全无字画面。23 条完整锚点、独立段落、负区和保护点均在首次 OCR 前冻结；首次 stock 基线为 14/23 锚点、3/8 整景通过，保留失败。`generate-manga-chromatic-fixtures.py --out-dir <新目录>` 以固定 Pillow/字体重建，`check-manga-chromatic-fixtures.cjs` 无需模型校验固定内容及 47 项误认/合段/艺术注入反例；无字页仅用于漫画模式。这八景与原 43 景分开运行，测试资源不打包进扩展。

颜色适配只处理 SDK 原识别缩放副本的一次既有四参数整幅读回，先恢复上下文方法再读取原生 ImageData，保留原生异常及其他参数语义。完整不透明边缘的 R 必须共享 0 或 255 端点，完整 alpha 校验后才增强副本对比；灰阶保持原值，不修改原画布或 RGB 检测输入。每裁图最多 262144 像素、每原页最多 2000000 处理像素，整页切片、气泡和复识别共享此颜色预算，另有的斜行/反向预算与四次重试不变。没有额外像素读写、归一化像素数组或画布，但仍有颜色扫描及待消费裁图的恢复闭包；不能宣称零 CPU 或零总分配成本。单次读回前恢复方法并立即移除已消费闭包，避免适配层跨推理继续持有裁图上下文；未读的 hook 在原 run 实际收尾后恢复。取消、fetch/decode/画布失败与原页 finally 分别验证预算、信号和 bitmap 所有权。

`tests/fixtures/manga-structures/manifest.json` 再提供单独运行的五景，结构分别为大型气泡中的窄白卡、跨越气泡中段的上下独立卡片、装订跨页与书脊文字、多字号注音与图解引线、带阴影和透视的拍摄纸页及便笺。包含 29 条完整原文锚点、23 个段落组和 8 个无字区域；不修改已有 38 景，不扩大单次 32 景上限。设计、字体、图片及真值在首次 OCR 前固定；`python3 scripts/testing/generate-manga-structure-fixtures.py --out-dir <新目录>` 仅写入新目录，`node scripts/testing/check-manga-structure-fixtures.cjs` 无需模型检查冻结内容与反例。首轮真实浏览器结果保存在同目录 baseline：窄白卡、跨中段卡片和多字号注音三景通过，跨页和透视场景仍有漏字或分段失败，不把 26/29 锚点命中写成全部通过。

新场景的 `paragraphGroups` 引用真实源文字区域，允许单行卡片和横排标签。每区锚点必须等于该区完整规范化原文，并同时属于 `expectedSource` 与 `expectedAnchors`；每组按源顺序完整匹配一个实际 OCR 段落，各组须占不同段落。独立卡片混入正文、主列被拆散、顺序颠倒或借用别段子串，即使总锚点与字符库存齐全也失败。原 `readingOrder`／`readingOrderGroups` 的竖排契约保持；三种声明互斥，不能用新格式放宽旧夹具。

完整确认均匀背景的漫画页可复用本次 Offscreen 请求独占的 ImageData，避免整页临时数组与同数组拷回；修补 API 默认仍返回独立副本，复杂页保留输入与输出分离。`scripts/testing/benchmark-manga-owned-pixels.cjs` 用真实专项报告的源 PNG、识别框和背景分类，对比指定 Git 基线与当前工厂及实际拷回语句，核验受控原生输入张量、蒙版和最终 RGBA 一致。报告中的字节数是累计分配和拷贝量；局部返回与拷回计时不包括 OCR、模型、Canvas 和 PNG 编码，不能当作整页提速或进程峰值内存。取消、删除模型准入、FIFO 和引用所有权由修补与 Offscreen 专项分别验证。

为下面的漫画浏览器专项传入 `--quality-manifest <证据目录>/corpus/manifest.json`，逐图运行真实 OCR，以明确的原文锚点及出现次数核验识别，检查实际物理行是否进入无字区域、原文字符是否超出真值库存、保护像素、恢复原图和缓存重显；无字页须保持零识别文字、零文字翻译请求且不遮盖原图。每张图片的原语言来自 manifest。锚点、阅读顺序和误报失败保留到逐景报告，全部场景完成后统一失败；像素和缓存等结构错误立即失败。字符库存只检测多余字符，不能替代缺字、顺序及位置检查。翻译 transport 受控，因此这些结果不代表在线翻译模型的语言质量。原有 `--pipeline-inputs <图片列表> --pipeline-rounds 2` 仍用于区分冷启动与热运行，不把首次下载耗时混成推理性能。

同一脚本加 `--quality-profile image` 可单独验证普通图片模式：关闭漫画连续翻译，以实际悬停按钮完成翻译、恢复和缓存重显，保留全部锚点、库存、阅读顺序、保护像素及请求次数检查。按钮必须位于视口内且能命中，不能用脚本触发替代可信点击。此模式只接受受控的非空文字 en/ja/auto 质量 manifest，不与其他阅读专项、预取或旧模型来源诊断参数混用，通过 `--model-cache-dir` 只准备三个 OCR 模型文件，不导入 LaMa；与漫画模式分开报告，同一图片的两个模式不能算两张独立场景。双语菜单、透明通知、小字车站截图、多栏报纸和聊天截图可作为普通图片回归输入，真值应在首次 OCR 前固定。

质量矩阵根据真实 Offscreen 完成响应检查返显。漫画未识别到文字，或只识别到无需改写的时间数字而保留原图时，仍记录全部缺失锚点和段落失败并继续后续场景；不能因没有译图而一直等待，也不能用预期无字标记代替实际返回值。识别质量与背景清理效果分别检查，锚点通过并不证明原字已完全擦除。

Paddle 后处理保留置信度至少 0.9 的连续多位数字、有效时间日期及带货币符号金额；判定时规范化全角字形，输出仍保留识别原文和物理框，孤立数字、空格数字碎片与低置信绘画噪声继续过滤。检测裁框按原始字行短边计算留白，避免长竖列把邻列或注音夹入识别输入；检测平面短边不足 12 像素时保留 SDK 原高度留白及识别路径，这是有界的裁切输入策略，不删除细小文字或调整识别门槛。通过 SDK 公开处理器复用原检测会话，保留检测平面的裁边、舍入与缩放。水平原始框的语义保持，不能只按最终框宽高比推断原始方向。留白也会改变原尺寸筛选后的框数和按宽度补齐的识别批次，因此须核验整页原文、误报及实际推理次数。

低置信竖列复识别与倾斜水平行校正共享每页最多四框。仅对模型当前已读到拉丁字母且不含 CJK 的低置信高窄框，在原重试配额内尝试相反方向；其他文字继续原批次复识别，返回框不移动，仍须比原置信度提高至少 0.05。方向裁图和水平校正共享每页两百万预处理像素，超出方向预算时走原重试路径。水平校正只处理近白底、清晰墨迹及 3–15° 倾斜，源框与旋转结果读取面积共同计入预算，旋转画布另有硬上限；不得用期望文字选角。水平校正结果须至少 0.99 且比原置信度提高 0.01 才替换文字。这些门槛不能代替实际质量回归或保证所有字体准确。

同一次扫描把局部识别候选和段落归属分开：原有最多二十四处、面积至多全页 15% 的裁图预算不变。15–40% 的大型浅底连通组件仅在密度、上下曲边与行包络实心度均满足保守边界时提供中段内接矩形，避免将椭圆包围框的角落当作气泡内部。候选还须由已有原像素确认物理框边缘十二点至少九点为浅底，成员索引绑定未重排的原 OCR 结果。同次扫描记录其原组件外接框内后续发现的独立白色岛；物理文字框完整落在岛内时保持独立，避免窄白卡并入正文，字形孔洞仅覆盖部分文字框不会剥离整行。每个大型候选最多保留 128 个岛，超限撤回该新增归属，沿用原分组，不删除原文。岛列表不传到主线程。这不会增加 OCR、像素回读或第二次组件扫描；最紧气泡优先。只有同一气泡内的同字号、纵向重叠竖列可使用较宽的有界列距；页面、横排和普通图片维持各自原有合段策略。矩形、多洞面板、曲边角落、内部黑底及窄白底卡片、跨内接框的白卡、相邻独立气泡均有反例回归；形状、发现顺序与少量底色采样仍是启发式，不能保证辨别所有画风或与气泡连通的白底标签。

漫画译文以实际 Canvas 字形上下界、描边及像素余量适配原识别框，缺失或非法指标退回完整行框；不通过扩大擦除范围提升字号。单次绘制的字体族固定，度量缓存用字重、字号与全文短键，连续字号复用前缀；准入仍按原完整字体键计费，保持 8192 条、131072 个逻辑 key 字符预算与原缓存命中集合。字形回调先全部完成再读取指标，兼容回调复用或修改同一对象。字形适配可能增加局部排版计算，需要分别报告可读性、度量调用量与耗时。Node Canvas 的字体回退指标可能与真实浏览器不同，离线像素检查不能替代浏览器实际渲染与禁裁剪越界检查。

```bash
node scripts/testing/run-manga-translation-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <path> \
  --focus-safe-helper "$(pwd)/scripts/testing/focus-safe-browser.cjs" \
  --quality-manifest <证据目录>/corpus/manifest.json \
  --artifacts-dir <证据目录>/manga-quality
```

下列单图专项仍保留其独立入口与原有范围。

漫画脚本的 `--error-recovery` 在真实 OCR 后注入限定的文字传输失败，验证紧凑边缘提示、可信单页重试、键盘展开错误详情、关闭提示、暂停清理、原画像素与缓存重显。默认使用 IMG；分别加 `--error-recovery-surface canvas`、`background` 或 `segments` 验证已适配的公开 DOM 形态，全部使用受控页面和生产适配器，不访问站点接口。此模式不能与真实站点或质量矩阵合用。失败响应和布局度量保留到报告，不能让不可见控件的脚本点击冒充用户可操作。

`--recovery-background-alpha` 只用于 `--error-recovery --error-recovery-surface background`，复用已冻结的红色透明源 PNG，在源图无字区域放置独立前景文字和按钮，并使用不同的宿主背景色。检查实际原背景 URL/像素、译图 PNG、唯一 background-image 样式借用、前景绘制与可信点击、暂停精确恢复及同 URL 缓存返显；不再等待顶层 Canvas 作为背景译图的成功信号。`--recovery-canvas-alpha` 保留原生 Canvas 的独立检查。背景实页的 `--background-reader` 也读取原绘制层的真实译图，翻页后暂停核对真正的新原图身份，不能把扩展自己的新 blob URL 当作翻页证明。上述夹具结果不代表公开站点或所有 CSS 绘制条件均已通过。

加入 `--recovery-viewport 390x700` 或 `844x390` 可模拟小 CSS 视口，外层浏览器保持正常尺寸与第二屏不抢焦点策略；`--recovery-long-details --recovery-rtl` 额外验证 80 行诊断、RTL 宿主、动作先于详情的键盘顺序、详情独立滚动及展开时直接重试。每个可见动作须完整位于反馈卡与视口内，不能只用元素可见属性替代裁切断言。

`node scripts/testing/benchmark-manga-preprocessing.cjs --before-ref <commit> --out-dir <新证据目录>` 比较同机的气泡检测与修补张量准备。脚本先核对输出和散列，再交替采样前后实现，记录源码、硬件、原始耗时及显式辅助数组分配。它不下载模型，也不证明整页 OCR、翻译服务或其他项目的整体速度；查看病态连接图案等各项结果，不能只报告有收益的样本。

`node scripts/testing/benchmark-manga-repair-queue.cjs --before-ref <commit> --out-dir <新证据目录>` 从前后源码提取实际修补工厂，以受控原生推理 gate 比较多请求的完成顺序，并校验模型张量与输出散列。完整分类为均匀背景的页可绕过其他页的 LaMa 排队，复杂页继续 FIFO 且受模型删除 admission 约束。该测试证明跨请求阻塞是否消除，不把人为阻塞时长换算成速度提升；单个漫画阅读会话本来串行，不因此宣称单页 LaMa 更快。

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

