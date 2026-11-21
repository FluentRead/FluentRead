# 文档翻译示例

这些文件是文档翻译的离线回归样例，也可以直接在扩展的“文档翻译”页面中打开。

| 文件 | 覆盖点 |
| --- | --- |
| `sample.pdf` | 两页文本层 PDF、分页上下文和双语 PDF 导出 |
| `sample.epub` | ePub 容器、OPF spine、双章节 XHTML 和内部链接 |
| `sample.docx` | DOCX 正文、拆分 run、标题、页眉页脚和 OOXML 重组 |
| `sample.html` | HTML 标签、属性、链接、代码块和脚本保护 |
| `sample.txt` | 空行、普通文本和换行保持 |
| `sample.md` | Markdown 标题、行内代码、代码块和链接保护 |
| `sample.srt` | SRT 时间轴、字幕标签和多行字幕 |
| `sample.vtt` | VTT 头部和时间轴 |
| `sample.ass` | ASS 对话字段和格式标记 |
| `sample.ssa` | SSA 对话字段兼容性 |
| `sample.lrc` | LRC 元信息、时间标签和歌词文本 |
| `sample.json` | 嵌套对象、数组、字符串值和非字符串值 |
| `sample.csv` | 按列翻译、带引号的逗号和单元格内换行、数字与链接 |
| `sample.tsv` | 按列翻译、单元格内制表符、公式和数字 |

测试会使用这些原始文件验证：

1. 文件格式识别和可翻译片段提取；
2. 模拟翻译后的双语/译文重组；
3. PDF、ePub、DOCX 导出后仍分别是有效的 PDF/EPUB/OOXML 文件；
4. 导出结果再次解析时，章节、段落、结构、时间轴和非翻译内容仍然有效。

二进制样例由 `scripts/generate-document-binary-examples.py` 独立生成。PDF 使用真实文本层并包含两页，DOCX 已通过 LibreOffice 渲染，ePub 的 `mimetype` 以未压缩首项写入。扫描版 PDF 没有文本层时会明确提示需要 OCR，不会把空白内容当成翻译成功。
