# PDF 与文档

[返回测试入口](../testing.md)。按本次改动选择下面的专项；这些条目不要求每次全部运行。

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

原生在线 PDF 的右键划词交接可单独验证：

```bash
node scripts/run-native-pdf-selection-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <Node包目录> \
  --artifacts-dir /private/tmp/fluentread-native-pdf-selection
```

该范围直接打开 USENIX 论文的真实 PDF 地址，检查原查看器和地址保留、一次性选文交接、关闭后重新选词、并发结果归属、触发方式切换后关闭结果窗口及没有额外 PDF 下载。只在临时生产产物副本前置测试 hook，向浏览器实际注册的菜单监听器传入受控选文；结果页和划词卡片使用生产代码、翻译使用本机确定性服务。为了保护前台焦点，测试将记录到的真实 `windows.create` 参数映射到预建后台标签，保留目标窗口和标签身份校验。报告不代表原生系统右键手势、原生 PDF 内部选区捕获、真实弹窗激活或在线供应商验收。

生产扩展构建后运行：

```bash
pnpm test:pdf-selection -- \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <Node包目录> \
  --focus-safe-helper <浏览器测试技能>/scripts/focus-safe-browser.cjs \
  --runtime-diagnostics-helper <浏览器测试技能>/scripts/runtime-diagnostics.cjs \
  --arxiv-pdf <已下载的1706.03762.pdf> \
  --live-arxiv \
  --artifacts-dir /private/tmp/fluentread-pdf-selection
```

测试使用临时 Edge profile、第二屏后台可见窗口和真实鼠标/键盘，不连接日常浏览器。PDF.js、Canvas、文字层、文件导入与扩展协议使用生产产物；翻译服务为本机确定性 OpenAI 兼容夹具，不证明外部服务质量。`--arxiv-pdf` 验证实际论文文件的本地导入；`--live-arxiv` 单独访问原始 HTTPS 地址，不拦截 PDF 下载，其成功、失败和耗时独立记录。

脚本验证精确跨行/跨页选区、来源过滤、快捷键与后台右键指令、旧请求迟到、390px 暗色、在线导入、原生 PDF 页面 Popup 分流，以及 120 页跳转、缩放、键盘和快速滚动的资源上限。普通页面先核验原生 caret 命中，再执行真实拖选；旋转页单独记录鼠标结果，并在本次临时 profile 开启浏览器光标浏览后用真实 Shift + 方向键核对原生选区，不写入 DOM Selection。适合宽度时还检查阅读器与 PDF 页面实际宽度，避免资源上限通过却没有可读页面。原生系统右键菜单点击及前台创建标签页不在这项证据内，Popup 测试记录实际 `tabs.create` 参数并将目标更新到预建后台标签页。

`pdfSource.test.ts`、`documentSelectionRuntime.test.ts`、`pdfReaderLifecycle.test.ts` 覆盖下载限额/取消、异步挂载/文档归属、页面渲染/释放和实际 Vue 导航布局；新增纯入口、下载、选区运行时及渲染调度器进入严格四维覆盖率。`documentAppLifecycle`、`documentUserActions` 与既有 binary/rasterizer 测试守护批量导入、校订和导出。Firefox 构建与清单验证单列，不等于 Firefox 实机验收。

对于嵌入字体返回零高度指标、译文漏盖原文的论文，可用 `--harness-layout-only --arxiv-pdf <2609.35738.pdf> --harness-pages 1,3,8,16` 替换上述脚本的测试范围。专项通过真实导入、翻译、暂停和下载控件获取选定页截图、遮罩几何以及 36 页的译文和双语 PDF，独立采样首页摘要的原文字形像素，并检查桌面及 390px 的状态与数字进度同行。中文回复来自本机确定性服务，只验证布局；仅选定页要求翻译完成，其他段落可能保留原文。`FLUENTREAD_HARNESS_PDF=<2609.35738.pdf>` 可启用 `documentTranslationBinaryEdge.test.ts` 的实际论文解析测试；默认用例也保留该字体的实测几何，验证合法的小高度数学字体和正常字形降部不受影响。

