# 功能全景

按阅读与工作场景浏览流畅阅读的全部核心能力。如果是第一次使用，建议先阅读[快速开始](/guide/getting-started)。

<DocDiagram kind="ecosystem-map" />

<span id="页面悬浮球"></span>
<span id="按钮和操作文字只显示译文"></span>
<span id="补充翻译菜单和动态界面"></span>
<span id="时间数字与持续变化的内容"></span>
<span id="调整段落处理方式"></span>
<span id="右键翻译"></span>

## 网页与日常翻译

<GuideVisual kind="webpage" />

| 功能 | 一句话说明 | 操作指南 |
| --- | --- | --- |
| **页面翻译** | 在原文下方逐段展示译文，或一键切换为「仅译文」，支持学术论文快捷入口 | [全文与局部翻译](/guide/webpage-translation) |
| **局部翻译** | 点击菜单中的**局部**或按 `Alt+R`，点选/划选指定区域并可记住常用区域 | [局部翻译步骤](/guide/webpage-translation#局部翻译) |
| **划词翻译** | 选中词句打开翻译卡片：查英文词典、多源语音朗读、AI 深入讲解与收藏 | [划词翻译](/guide/deepseek-harness) |
| **悬浮段落翻译** | 鼠标停在段落上按 `Control` 即时翻译当前段，再按一次恢复原文 | [悬浮段落翻译](/guide/hover-translation) |
| **输入框翻译** | 在聊天、邮件等输入框用三连按或快捷键翻译草稿，绝不自动发送 | [输入框翻译](/guide/input-translation) |
| **翻译中心与侧边栏** | 同一段文字同时对照多个翻译服务，或打开浏览器侧边栏随贴随译 | [翻译中心](/guide/translation-center) |
| **智能高亮** | 本机分析关键词或预测意外度，在正文中柔和标色辅助长文扫读 | [智能高亮](/guide/information-highlight) |

<span id="局部翻译"></span>

## 图片、文档与视频

| 功能 | 一句话说明 | 操作指南 |
| --- | --- | --- |
| **图片与漫画翻译** | 本地 PaddleOCR 识别与 LaMa 背景修补，支持单图译图、漫画连续预译与文字面板 | [图片与漫画翻译](/guide/image-translation) |
| **圈选翻译** | 按 `Shift+Z` 框选截图、图表或暂停的视频画面，支持模型识图或本地 OCR | [圈选翻译](/guide/area-translation) |
| **文档翻译** | 支持 PDF、EPUB、Word、Markdown、CSV、字幕等 14 种格式，提供原版/重排双视图、扫描 OCR 与批注 | [文档翻译](/guide/document-translation) |
| **视频与会议字幕** | 适配 YouTube、B 站、X、课程站、Google Meet/Teams/Zoom 及普通 HTML 音视频，支持本地 Whisper 转写 | [视频与会议字幕](/guide/video-subtitles) |

## 学习与表达

| 功能 | 一句话说明 | 操作指南 |
| --- | --- | --- |
| **学习中心与词书** | 收藏词句与阅读材料、间隔回忆复习、导出 Anki，并在新网页自动标记「再次遇见」 | [学习中心](/guide/vocabulary-book) |
| **词典与学习卡** | 导入 MDict、StarDict、DSL、Yomitan 离线词典，自定义 JSON API 与 AnkiConnect 卡片模板 | [词典与学习卡](/guide/dictionaries) |
| **词性与句法** | 可视化拆解长难句的主干成分与词性，支持键盘切换解释 | [词性与句法](/guide/sentence-analysis) |
| **双语分享卡片** | 在本机将划词原文、译文与来源排成多套精美样式的图片分享 | [双语分享卡片](/guide/share-cards) |
| **写作助手** | 在 Gmail 与 GitHub 编辑器旁起草或润色单语/双语回复，确认后插入 | [写作助手](/guide/writing-assistant) |

## 服务、隐私与个性化

| 功能 | 一句话说明 | 操作指南 |
| --- | --- | --- |
| **多种翻译服务** | 免费池开箱即用，可按功能分别配置云厂商、AI 大模型、组合回退、Ollama 或本地模型 | [翻译服务与模型配置](/config/translation-engines) |
| **翻译隐私防护** | 本机自动识别邮箱/电话/密钥/自定义词，脱敏后翻译还原或直接阻止发送 | [翻译隐私防护](/config/privacy-protection) |
| **译文外观与逐句高亮** | 丰富译文样式预设、自定义 CSS、界面皮肤与双语逐句同步高亮 | [译文外观与阅读辅助](/config/appearance) |
| **术语库** | 锁定专有名词译法或保持原文拼写，支持从论文自动提取候选术语 | [术语库](/guide/glossary) |
| **网站规则与阅读范围** | 按主域名设置始终翻译、仅译文、禁用扩展，或自定义 CSS 正文范围 | [网站阅读范围](/config/site-adaptation) |
| **备份、同步与统计** | 本地完整备份、自动设置快照、Google Drive / WebDAV 云备份、请求耗时与 Token 统计 | [备份与同步](/config/backup-sync) |

### 请求限制 {#请求限制}

服务提示请求过于频繁或限流时，可在设置中心的[请求限制](/config/#请求限制)降低全局或单个服务/模型的并发与速率。
