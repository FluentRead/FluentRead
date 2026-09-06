# 安装与第一次翻译

FluentRead 不需要注册账号。安装后打开一篇普通网页，通常几分钟就能完成第一次翻译。

## 安装

选择你正在使用的浏览器：

- [Chrome Web Store](https://chromewebstore.google.com/detail/%E6%B5%81%E7%95%85%E9%98%85%E8%AF%BB/djnlaiohfaaifbibleebjggkghlmcpcj?hl=zh-CN)
- [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/%E6%B5%81%E7%95%85%E9%98%85%E8%AF%BB/kakgmllfpjldjhcnkghpplmlbnmcoflp?hl=zh-CN)
- [Firefox Add-ons](https://addons.mozilla.org/zh-CN/firefox/addon/%E6%B5%81%E7%95%85%E9%98%85%E8%AF%BB/)
- [油猴脚本（Tampermonkey / Violentmonkey / Via）](https://greasyfork.org/zh-CN/scripts/482986-%E6%B5%81%E7%95%85%E9%98%85%E8%AF%BB)

安装后，建议把 FluentRead 固定到浏览器工具栏，之后打开弹窗会更方便。

## 第一次翻译

### 1. 打开一篇普通网页

新闻、博客、技术文档和论坛文章都可以。浏览器内部页面、扩展商店和部分受保护的编辑器通常不允许扩展注入内容，第一次使用时请先换一篇普通网页。

### 2. 选择语言和服务

打开 FluentRead 弹窗，确认源语言、目标语言和翻译服务。第一次使用可以保留默认值；免费翻译服务可以直接开始。

中文分为「简体中文」和「繁體中文」，源语言和目标语言都可以分别选择。例如，将源语言设为简体、目标语言设为繁体即可简转繁；反向选择即可繁转简，也可以保留自动检测源语言。全文、悬浮、划词、输入框、快捷方案、文档、图片和视频字幕翻译使用同一套语言标识。

默认目标仍为简体中文。导入旧配置时，`zh`、`zh-CN`、`zh-SG` 自动归入 `zh-Hans`，`zh-TW`、`zh-HK`、`zh-MO` 自动归入 `zh-Hant`；显式 `Hans` / `Hant` 优先于地区。简繁译文缓存和术语库分别匹配，旧术语库的 `zh` 也归入简体。能够明确识别为目标书写体系的中文会跳过翻译；中文长句中少量 `AI`、`CoT`、`OpenAI` 等技术缩写不会让整句被重复翻译。只有共享汉字、简繁混排或含完整外语内容时，系统仍继续翻译，不凭不确定的检测结果跳过请求。

使用 Chrome 内置翻译时，需要准备对应的语言模型。如果 Chrome 自动检测只能返回笼统的中文，且正文不足以确认书写体系，系统会尝试翻译；遇到不支持语言对的提示时，可将源语言明确设为简体或繁体后重试。

<figure class="doc-figure">
  <img class="doc-screenshot" src="/screenshots/popup.webp" alt="FluentRead 弹窗中的语言选择、翻译服务和翻译按钮" />
  <figcaption>弹窗会集中显示语言、服务和常用翻译入口。</figcaption>
</figure>

### 3. 点击“翻译页面”

译文会出现在原文附近。长页面可能分批显示，请保持当前标签页打开；页面不会自动滚动。

<figure class="doc-figure">
  <img class="doc-screenshot" src="/screenshots/translation.webp" alt="网页原文和译文按段落对照显示" />
  <figcaption>页面翻译保留原文，译文紧跟在对应段落下方。</figcaption>
</figure>

### 4. 恢复或重新翻译

- 使用“恢复原文”移除 FluentRead 添加的译文。
- 修改目标语言或翻译服务后，再次点击翻译。
- 只想确认一句话时，直接选中文本进行划词翻译。

## 如果点击后没有结果

1. 确认当前页面不是浏览器内部页、扩展商店或受保护页面。
2. 在弹窗中检查目标语言和翻译服务是否正确。
3. 先选中一句话测试，再尝试整页翻译。
4. 如果页面内容刚刚加载完成，等待片刻后重试。

仍然无法使用时，请查看[常见问题](/guide/faq)，反馈时不要粘贴 API Key、Cookie 或隐私内容。
