# 安装与第一次翻译

本页介绍扩展安装、语言设置、首次网页翻译和恢复原文的操作。

## 安装

选择当前使用的浏览器，进入商店点击添加，并按浏览器提示完成安装。

| 你使用的浏览器 | 安装入口 |
| --- | --- |
| Chrome | [Chrome 应用商店](https://chromewebstore.google.com/detail/djnlaiohfaaifbibleebjggkghlmcpcj) |
| Edge | [Edge 加载项](https://microsoftedge.microsoft.com/addons/detail/kakgmllfpjldjhcnkghpplmlbnmcoflp) |
| Firefox | [Firefox 附加组件](https://addons.mozilla.org/zh-CN/firefox/addon/%E6%B5%81%E7%95%85%E9%98%85%E8%AF%BB/) |
| Thunderbird | [邮件翻译源码构建与安装指南](/guide/thunderbird) |
| 使用脚本管理器的浏览器 | [油猴脚本安装指南](/guide/userscript) |

建议将 FluentRead 固定到浏览器工具栏。安装前已经打开的网页，请刷新一次。

在支持扩展的**安卓 Edge** 中，从浏览器的扩展入口搜索并安装 FluentRead，然后在扩展列表中打开菜单操作当前网页。手机没有桌面快捷键或右键菜单；可在菜单中点击“翻译页面”。若已在设置中开启悬浮球，默认轻点它会切换全文翻译并展开触控工具，点页面其他位置可收起工具。此处的移动端说明仅针对安卓 Edge，iPhone/iPad 上的 Edge 仍需另行确认扩展可用性。

## 第一次翻译

### 1. 打开文章

新闻、博客、论坛正文或在线文档都适合。浏览器设置页和扩展商店不允许扩展翻译，先用普通网页试试。

### 2. 确认目标语言

点击工具栏里的 FluentRead 图标。源语言可以保留“自动检测”，目标语言选你想阅读的语言，默认是简体中文。繁体中文可以单独选择，也可以明确指定源语言进行简繁转换。

悬浮翻译和全文翻译会跳过已属于目标中文书写体系的原文。少量 AI、CoT、OpenAI 等缩写，以及中文说明中的 PDF、ePub、DOCX、Markdown 等文件格式清单，不会让整段中文重复翻译。“新增功能”这类有明确中文词语且简繁写法相同的标题也会保留原文。简繁转换、简繁混排、含完整外语内容或语言不确定的文本，仍会尝试翻译。

翻译服务先保留“免费翻译服务”，不用填写密钥。网络不通或免费服务繁忙时，可以稍后重试，或[选择其他服务](/config/translation-engines)。

<figure class="doc-figure">
  <a href="/screenshots/ui/zh-CN/popup.webp" target="_blank" rel="noopener"><img class="doc-screenshot popup" src="/screenshots/ui/zh-CN/popup.webp" width="640" height="874" alt="扩展菜单里的语言、免费翻译服务与翻译页面按钮" /></a>
  <figcaption>常用操作集中在扩展菜单里。点击图片可查看原图。</figcaption>
</figure>

### 3. 点击“翻译页面”

原文下方会出现译文。默认按阅读位置逐步翻译，向下滚动就能继续读，不必等整篇文章全部完成。

### 4. 随时回到原文

打开扩展菜单，点击“恢复原文”。想换语言或服务时，先恢复，再重新翻译。

## 只想查一句话

先在扩展菜单的 **划词翻译** 中开启双语显示，然后选中一句话，点击选区附近的 FluentRead 图标查看译文。也可以将鼠标放在段落上，按默认的 **Control** 键翻译这一段。触发方式可在设置中调整。

需要查词或拆解句子时，可以在同一个[划词翻译](/guide/deepseek-harness)弹窗切换到卡片模式。词典无需 AI，深入讲解按需开启。

## 点击后没有变化

先确认扩展已开启，再刷新网页重试。若仍无结果，查看[按现象排查的常见问题](/guide/faq)。

## 接下来

- [按任务查看完整文档](/docs/)
- [调整阅读外观与触发方式](/config/)
- [连接自己的翻译服务](/config/translation-engines)
