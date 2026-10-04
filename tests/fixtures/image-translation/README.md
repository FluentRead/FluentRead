# 图片段落回归样本

`bambu-ocr-lines.json` 来自用户提供的 [Bambu Studio 截图](https://wiki.bambulab.com/h2/manual/deal-nozzles-filament-grouping/image-5.png)，尺寸 390 × 300。2026-10-05 使用 Tesseract.js 6.0.1、英文模型及 `PSM.SPARSE_TEXT` 识别，再经过 FluentRead 的 `normalizeOcrLines` 得到这些物理行。

保留真实结果中的 `printers`、`Lear more` 和图标误识别，不人工修正样本。两段说明各有三行，三个标题与底部两个链接应保持独立。夹具仅包含文本和坐标，原始图片不随测试打包。原截图内容属于 Bambu Lab；此样本只用于用户报告的布局问题回归。
