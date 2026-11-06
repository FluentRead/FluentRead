# 测试与回归

先确定当前任务 checkout 和受影响的功能，再选择对应文件、用例或浏览器专项。搜索默认限制在该 checkout 的具体目录，避免把其他 worktree、构建包和历史证据读入上下文。完整报告留在证据目录，终端优先返回状态、错误与告警计数、失败摘要和文件路径。

## 按需运行

日常开发、修复、PR 与普通交付只运行相关回归。全量测试和完整站点矩阵只用于用户明确要求的全量验收或正式发版；生产构建验证不等同于发版。四维 100% 覆盖率门禁及真实浏览器验收要求保持不变，专项通过须报告实际范围。

```bash
# 先核对将执行的文件；筛选不会扩大到当前分组之外
pnpm test:unit -- tests/harnessMemorySearch.test.ts --dry-run
pnpm test:unit -- tests/harnessMemorySearch.test.ts
# 单个用例或跨分组的明确文件集合
pnpm exec vitest run tests/harnessRuntime.test.ts -t 'authorized context' --reporter=dot
pnpm test:audit
pnpm compile
```

分组入口接受文件、目录或路径片段，以及 `-t` / `--testNamePattern`；多个路径取并集。无匹配、跨组、未知选项或缺少值立即失败。每个 `tests/**/*.test.ts` 仍唯一登记在 `tests/test-matrix.json`。完整命令、覆盖率范围和发版流水线见[范围与完整流水线](testing/contracts.md)。

## 运行时错误与告警

功能断言和运行时诊断共同决定结果。在导航及动作前开始采集相关内容脚本隔离世界、扩展页面与后台，包括重启后的 Service Worker。自身错误或告警阻止通过；负向预期和第三方噪声必须有用例、来源与次数依据，原始记录继续保存。采集空窗与无法观测的 surface 如实报告，零条日志不能证明全程无错。详见[诊断与浏览器边界](testing/contracts.md#运行时错误与告警)。

浏览器使用独立临时 profile、第二屏正常尺寸可见但不抢焦点的窗口和 focus-safe helper，禁止连接日常 profile。按本次影响选 `--cases` 或 `--suite`，共享核心改动覆盖直接受影响的关键链路。检查生产产物时重跑相关专项，保留启动模式、焦点策略、诊断及截图证据。

## 专项入口

- [范围、诊断与完整流水线](testing/contracts.md)
- [网页翻译与站点兼容](testing/webpage.md)
- [真实站点与 DOM 兼容](testing/sites.md)
- [供应商、术语与请求上下文](testing/providers.md)
- [Popup、侧栏与工具栏](testing/popup.md)
- [设置与界面布局](testing/settings.md)
- [阅读解释与学习材料](testing/learning.md)
- [缓存、备份与同步](testing/sync.md)
- [视频字幕与本地推理](testing/video.md)
- [图片、漫画与圈选](testing/images.md)
- [PDF 与文档](testing/documents.md)

## 原章节索引

旧章节链接仍可定位到此索引，再打开对应专项。只读取本次相关条目；新增案例直接写入对应专题。

| 原章节 | 专项 |
| --- | --- |
| <span id="原生侧边栏文本翻译-issue-1160"></span>原生侧边栏文本翻译（issue #1160） | [查看](testing/popup.md#原生侧边栏文本翻译-issue-1160) |
| <span id="扩展重载后的界面资源"></span>扩展重载后的界面资源 | [查看](testing/contracts.md#扩展重载后的界面资源) |
| <span id="缓存清理等待与恢复"></span>缓存清理等待与恢复 | [查看](testing/sync.md#缓存清理等待与恢复) |
| <span id="术语库排队保存"></span>术语库排队保存 | [查看](testing/sync.md#术语库排队保存) |
| <span id="术语库连续搜索"></span>术语库连续搜索 | [查看](testing/sync.md#术语库连续搜索) |
| <span id="词汇重遇的匹配索引"></span>词汇重遇的匹配索引 | [查看](testing/learning.md#词汇重遇的匹配索引) |
| <span id="收藏词书隐藏与恢复"></span>收藏词书隐藏与恢复 | [查看](testing/learning.md#收藏词书隐藏与恢复) |
| <span id="阅读材料连续搜索"></span>阅读材料连续搜索 | [查看](testing/learning.md#阅读材料连续搜索) |
| <span id="阅读材料隐藏与恢复"></span>阅读材料隐藏与恢复 | [查看](testing/learning.md#阅读材料隐藏与恢复) |
| <span id="阅读材料刷新时的引用比较"></span>阅读材料刷新时的引用比较 | [查看](testing/learning.md#阅读材料刷新时的引用比较) |
| <span id="man7-linux-手册正文"></span>man7 Linux 手册正文 | [查看](testing/sites.md#man7-linux-手册正文) |
| <span id="hugging-face-spaces-内嵌正文"></span>Hugging Face Spaces 内嵌正文 | [查看](testing/sites.md#hugging-face-spaces-内嵌正文) |
| <span id="网页操作提示"></span>网页操作提示 | [查看](testing/webpage.md#网页操作提示) |
| <span id="翻译结果与浏览器清理边界"></span>翻译结果与浏览器清理边界 | [查看](testing/webpage.md#翻译结果与浏览器清理边界) |
| <span id="网页个人校订"></span>网页个人校订 | [查看](testing/webpage.md#网页个人校订) |
| <span id="视频双语上下顺序-issue-1073"></span>视频双语上下顺序（issue #1073） | [查看](testing/video.md#视频双语上下顺序-issue-1073) |
| <span id="实现审计-取消、恢复与热路径"></span>实现审计：取消、恢复与热路径 | [查看](testing/webpage.md#实现审计-取消、恢复与热路径) |
| <span id="视频完整句学习"></span>视频完整句学习 | [查看](testing/video.md#视频完整句学习) |
| <span id="扩展体积与共享推理引擎"></span>扩展体积与共享推理引擎 | [查看](testing/video.md#扩展体积与共享推理引擎) |
| <span id="本地推理响应、转圈与跟读"></span>本地推理响应、转圈与跟读 | [查看](testing/video.md#本地推理响应、转圈与跟读) |
| <span id="设置分组、阅读辅助与右键菜单"></span>设置分组、阅读辅助与右键菜单 | [查看](testing/settings.md#设置分组、阅读辅助与右键菜单) |
| <span id="设置布局与控件交互"></span>设置布局与控件交互 | [查看](testing/settings.md#设置布局与控件交互) |
| <span id="官网网页与漫画翻译演示"></span>官网网页与漫画翻译演示 | [查看](testing/webpage.md#官网网页与漫画翻译演示) |
| <span id="网站规则与连续导航"></span>网站规则与连续导航 | [查看](testing/sites.md#网站规则与连续导航) |
| <span id="popup-首次打开与语言引导"></span>Popup 首次打开与语言引导 | [查看](testing/popup.md#popup-首次打开与语言引导) |
| <span id="popup-操作恢复与翻译服务-ui"></span>Popup 操作恢复与翻译服务 UI | [查看](testing/popup.md#popup-操作恢复与翻译服务-ui) |
| <span id="划词行内代码与代码块-issue-704、-845"></span>划词行内代码与代码块（issue #704、#845） | [查看](testing/webpage.md#划词行内代码与代码块-issue-704、-845) |
| <span id="编辑器内显式选区-issue-1237"></span>编辑器内显式选区（issue #1237） | [查看](testing/webpage.md#编辑器内显式选区-issue-1237) |
| <span id="同目标语言跳过与统一语言判断"></span>同目标语言跳过与统一语言判断 | [查看](testing/webpage.md#同目标语言跳过与统一语言判断) |
| <span id="冻结真实网页的完整扩展-a-b"></span>冻结真实网页的完整扩展 A/B | [查看](testing/webpage.md#冻结真实网页的完整扩展-a-b) |
| <span id="原文回显与逐槽恢复"></span>原文回显与逐槽恢复 | [查看](testing/webpage.md#原文回显与逐槽恢复) |
| <span id="双语链接悬停提示与属性边界"></span>双语链接悬停提示与属性边界 | [查看](testing/webpage.md#双语链接悬停提示与属性边界) |
| <span id="google-drive-完整配置同步"></span>Google Drive 完整配置同步 | [查看](testing/sync.md#google-drive-完整配置同步) |
| <span id="云备份范围与敏感信息选择"></span>云备份范围与敏感信息选择 | [查看](testing/sync.md#云备份范围与敏感信息选择) |
| <span id="云端备份删除专项"></span>云端备份删除专项 | [查看](testing/sync.md#云端备份删除专项) |
| <span id="双语逐句高亮"></span>双语逐句高亮 | [查看](testing/webpage.md#双语逐句高亮) |
| <span id="关键内容空间与交互工作量"></span>关键内容空间与交互工作量 | [查看](testing/learning.md#关键内容空间与交互工作量) |
| <span id="不翻译的语言-issue-627"></span>不翻译的语言（issue #627） | [查看](testing/webpage.md#不翻译的语言-issue-627) |
| <span id="自定义服务-base-url-issue-626"></span>自定义服务 Base URL（issue #626） | [查看](testing/providers.md#自定义服务-base-url-issue-626) |
| <span id="x-字幕来源与恢复体验"></span>X 字幕来源与恢复体验 | [查看](testing/video.md#x-字幕来源与恢复体验) |
| <span id="youtube-全屏与字幕同步"></span>YouTube 全屏与字幕同步 | [查看](testing/video.md#youtube-全屏与字幕同步) |
| <span id="中文格式清单与重复请求"></span>中文格式清单与重复请求 | [查看](testing/webpage.md#中文格式清单与重复请求) |
| <span id="划词学习面板原句滚动"></span>划词学习面板原句滚动 | [查看](testing/learning.md#划词学习面板原句滚动) |
| <span id="阅读历史与学习选中状态"></span>阅读历史与学习选中状态 | [查看](testing/learning.md#阅读历史与学习选中状态) |
| <span id="阅读卡深色主题-issue-574"></span>阅读卡深色主题（issue #574） | [查看](testing/learning.md#阅读卡深色主题-issue-574) |
| <span id="输入框翻译"></span>输入框翻译 | [查看](testing/webpage.md#输入框翻译) |
| <span id="设置页视口与滚动"></span>设置页视口与滚动 | [查看](testing/settings.md#设置页视口与滚动) |
| <span id="圈选模型识图"></span>圈选模型识图 | [查看](testing/images.md#圈选模型识图) |
| <span id="统一下拉选择器"></span>统一下拉选择器 | [查看](testing/settings.md#统一下拉选择器) |
| <span id="多语言界面布局"></span>多语言界面布局 | [查看](testing/settings.md#多语言界面布局) |
| <span id="公告优先与关闭后续译"></span>公告优先与关闭后续译 | [查看](testing/webpage.md#公告优先与关闭后续译) |
| <span id="工具栏翻译状态"></span>工具栏翻译状态 | [查看](testing/popup.md#工具栏翻译状态) |
| <span id="ai-sdk-共享限流冷却"></span>AI SDK 共享限流冷却 | [查看](testing/popup.md#ai-sdk-共享限流冷却) |
| <span id="覆盖率定义"></span>覆盖率定义 | [查看](testing/contracts.md#覆盖率定义) |
| <span id="pr-的扩展质量检查"></span>PR 的扩展质量检查 | [查看](testing/contracts.md#pr-的扩展质量检查) |
| <span id="全项目的验证归属"></span>全项目的验证归属 | [查看](testing/contracts.md#全项目的验证归属) |
| <span id="动态任务清单与核心行为验证"></span>动态任务清单与核心行为验证 | [查看](testing/contracts.md#动态任务清单与核心行为验证) |
| <span id="谷歌合批、请求节奏与限流恢复"></span>谷歌合批、请求节奏与限流恢复 | [查看](testing/providers.md#谷歌合批、请求节奏与限流恢复) |
| <span id="翻译核心稳定性回归"></span>翻译核心稳定性回归 | [查看](testing/sites.md#翻译核心稳定性回归) |
| <span id="连续滚动中的阅读等待"></span>连续滚动中的阅读等待 | [查看](testing/sites.md#连续滚动中的阅读等待) |
| <span id="hacker-news-与-product-hunt-翻译滚动"></span>Hacker News 与 Product Hunt 翻译滚动 | [查看](testing/sites.md#hacker-news-与-product-hunt-翻译滚动) |
| <span id="github-列表译文间距"></span>GitHub 列表译文间距 | [查看](testing/sites.md#github-列表译文间距) |
| <span id="reddit-多翻译器共存与搜索结果"></span>Reddit 多翻译器共存与搜索结果 | [查看](testing/sites.md#reddit-多翻译器共存与搜索结果) |
| <span id="github-latest-仅译文反复翻译"></span>GitHub Latest 仅译文反复翻译 | [查看](testing/sites.md#github-latest-仅译文反复翻译) |
| <span id="术语库回归"></span>术语库回归 | [查看](testing/providers.md#术语库回归) |
| <span id="快捷面板与完整设置"></span>快捷面板与完整设置 | [查看](testing/popup.md#快捷面板与完整设置) |
| <span id="ai-阅读解释的原文依据"></span>AI 阅读解释的原文依据 | [查看](testing/learning.md#ai-阅读解释的原文依据) |
| <span id="设置层级与渐进展开"></span>设置层级与渐进展开 | [查看](testing/settings.md#设置层级与渐进展开) |
| <span id="翻译服务目录"></span>翻译服务目录 | [查看](testing/webpage.md#翻译服务目录) |
| <span id="菜单栏首帧与快速关闭"></span>菜单栏首帧与快速关闭 | [查看](testing/popup.md#菜单栏首帧与快速关闭) |
| <span id="webdav-属性响应边界"></span>WebDAV 属性响应边界 | [查看](testing/sync.md#webdav-属性响应边界) |
| <span id="快捷键草稿与录制弹窗"></span>快捷键草稿与录制弹窗 | [查看](testing/webpage.md#快捷键草稿与录制弹窗) |
| <span id="模型用量界面"></span>模型用量界面 | [查看](testing/settings.md#模型用量界面) |
| <span id="翻译统计界面"></span>翻译统计界面 | [查看](testing/settings.md#翻译统计界面) |
| <span id="简体与繁体中文回归"></span>简体与繁体中文回归 | [查看](testing/webpage.md#简体与繁体中文回归) |
| <span id="一键回归"></span>一键回归 | [查看](testing/contracts.md#一键回归) |
| <span id="x-本地-ai-字幕同步"></span>X 本地 AI 字幕同步 | [查看](testing/contracts.md#x-本地-ai-字幕同步) |
| <span id="x-模型下载来源与等待边界"></span>X 模型下载来源与等待边界 | [查看](testing/contracts.md#x-模型下载来源与等待边界) |
| <span id="ai-字幕中文质量与性能基准"></span>AI 字幕中文质量与性能基准 | [查看](testing/contracts.md#ai-字幕中文质量与性能基准) |
| <span id="完整流水线"></span>完整流水线 | [查看](testing/contracts.md#完整流水线) |
| <span id="真实站点用例精简"></span>真实站点用例精简 | [查看](testing/contracts.md#真实站点用例精简) |
| <span id="图片翻译完整流程"></span>图片翻译完整流程 | [查看](testing/images.md#图片翻译完整流程) |
| <span id="漫画顺序与文字边界的离线回归"></span>漫画顺序与文字边界的离线回归 | [查看](testing/images.md#漫画顺序与文字边界的离线回归) |
| <span id="漫画质量场景与模型复用"></span>漫画质量场景与模型复用 | [查看](testing/images.md#漫画质量场景与模型复用) |
| <span id="圈选独立阅读流程"></span>圈选独立阅读流程 | [查看](testing/images.md#圈选独立阅读流程) |
| <span id="局部翻译选择流程"></span>局部翻译选择流程 | [查看](testing/webpage.md#局部翻译选择流程) |
| <span id="悬浮说明框翻译稳定性"></span>悬浮说明框翻译稳定性 | [查看](testing/webpage.md#悬浮说明框翻译稳定性) |
| <span id="写作助手回复场景"></span>写作助手回复场景 | [查看](testing/learning.md#写作助手回复场景) |
| <span id="firefox-共享-dom-运行时"></span>Firefox 共享 DOM 运行时 | [查看](testing/sites.md#firefox-共享-dom-运行时) |
| <span id="codeforces-公式与倒计时"></span>Codeforces 公式与倒计时 | [查看](testing/sites.md#codeforces-公式与倒计时) |
| <span id="自定义请求头回归-issue-522"></span>自定义请求头回归（issue #522） | [查看](testing/providers.md#自定义请求头回归-issue-522) |
| <span id="本机-acp-桥接-issue-227"></span>本机 ACP 桥接（issue #227） | [查看](testing/providers.md#本机-acp-桥接-issue-227) |
| <span id="论文版式回归"></span>论文版式回归 | [查看](testing/documents.md#论文版式回归) |
| <span id="扫描版-pdf-识别"></span>扫描版 PDF 识别 | [查看](testing/documents.md#扫描版-pdf-识别) |
| <span id="pdf-在线与本地划词"></span>PDF 在线与本地划词 | [查看](testing/documents.md#pdf-在线与本地划词) |
| 悬浮球边距（issue #1225） | [查看](testing/settings.md#悬浮球边距-issue-1225) |
| <span id="划词窗口拖动与缩放-issue-525"></span>划词窗口拖动与缩放（issue #525） | [查看](testing/settings.md#划词窗口拖动与缩放-issue-525) |
| <span id="单篇篇章参考"></span>单篇篇章参考 | [查看](testing/providers.md#单篇篇章参考) |
| <span id="ai-多段请求合并"></span>AI 多段请求合并 | [查看](testing/providers.md#ai-多段请求合并) |
| <span id="短标题跨语言上下文误译-issue-980"></span>短标题跨语言上下文误译（issue #980） | [查看](testing/providers.md#短标题跨语言上下文误译-issue-980) |
| <span id="按域名移除来源请求头-issue-763"></span>按域名移除来源请求头（issue #763） | [查看](testing/providers.md#按域名移除来源请求头-issue-763) |
| <span id="deeplx-默认直连-issue-968"></span>DeepLX 默认直连（issue #968） | [查看](testing/providers.md#deeplx-默认直连-issue-968) |
| <span id="kagi-news-内容型标题按钮-issue-1045"></span>Kagi News 内容型标题按钮（issue #1045） | [查看](testing/sites.md#kagi-news-内容型标题按钮-issue-1045) |
| <span id="划词语音栏与正文布局"></span>划词语音栏与正文布局 | [查看](testing/settings.md#划词语音栏与正文布局) |
| <span id="编译与构建缓存"></span>编译与构建缓存 | [查看](testing/contracts.md#编译与构建缓存) |
