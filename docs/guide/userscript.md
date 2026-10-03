# 油猴脚本

如果你使用 Tampermonkey、Violentmonkey、Via 或 Safari Userscripts，也可以安装 FluentRead 油猴脚本，在网页中使用核心翻译功能。具体支持情况取决于浏览器和脚本管理器版本。

## 直接安装

打开 [Greasy Fork 安装流畅阅读油猴脚本](https://greasyfork.org/zh-CN/scripts/482986-%E6%B5%81%E7%95%85%E9%98%85%E8%AF%BB)，按照脚本管理器提示完成安装。

Greasy Fork 上的版本可能晚于 GitHub 源码。排查问题时，请先查看安装页和脚本设置中的版本号。当前运行验证覆盖 Chrome 与 Violentmonkey，以及 Android 模拟器中的 Via 7.3.3；Safari Userscripts 和 Via 真机仍需设备验证。

### 从源码构建独立脚本

如果要试用仓库中尚未发布到 Greasy Fork 的修复，可以在 FluentRead 仓库安装依赖后运行 `pnpm test:userscript:standalone`，将生成的 `.output/userscript-standalone/fluent-read.user.js` 通过脚本管理器的「从文件安装」导入。**Via 请使用这个独立版**：Via 7.3.3 模拟器实测没有加载精简版的 `@require` 依赖，导致悬浮球无法启动。独立版把 Vue、界面库和旧浏览器所需的 gzip 解压库一起打包，安装时不依赖 `@require` 下载；普通翻译服务和首次切换其他界面语言仍需要联网。请选择安装独立版或精简版其中一种，避免重复运行。

仓库也提供 `pnpm test:userscript` 生成体积较小的 `.output/userscript/fluent-read.user.js`，它在安装时需要脚本管理器下载固定版本的 `@require` 依赖。Violentmonkey 的首次文件安装曾出现依赖尚未就绪便执行脚本的问题；独立版在隔离的真实管理器中通过了立即打开页面的测试。两种构建都不是当前 Greasy Fork 页面已发布版本。

仓库另有面向 Greasy Fork 源码规则的精简版：运行 `pnpm build:userscript:greasyfork`，生成 `.output/userscript-greasyfork/fluent-read.user.js`。它保留可阅读的翻译逻辑，并把第三方库、静态词条、站点规则和样式放在固定 Git 提交的 `@require` 资源中。安装时必须联网下载这些资源；使用精简设置面板。源码构建低于 Greasy Fork 的 2 MB 上限，但是否被网站接受仍取决于实际提交审核，仓库构建不会自动更新 Greasy Fork 页面。维护资源时先运行 `node scripts/build-userscript-greasyfork.mjs --prepare-resources` 并提交生成的两个文件，再运行正式构建，使两个 `@require` 都锁定到该提交。

安装完成后：

1. 打开一篇普通网页；
2. 在脚本管理器中确认 FluentRead 已启用；
3. 使用页面翻译、划词翻译或悬浮球开始阅读。提供脚本菜单的管理器也可以从菜单打开设置。

仓库构建的**独立版**提供与浏览器扩展共用的完整设置中心：点击悬浮球中的设置或脚本菜单，桌面脚本管理器支持专用开标签 API 时会在当前网址的新标签页打开；Android（包括 Via）以及未提供该 API 的环境会在当前页的隔离面板中打开，分区导航不会改写网页地址。语言、服务和外观等设置保存在脚本管理器的私有存储中。图片翻译、圈选翻译、视频字幕、写作助手、翻译统计与模型用量分区在油猴脚本中会显示不可用提示；右键菜单和扩展 Popup 布局也只显示说明，避免保存无法生效的设置。**精简版**仍使用较小的设置面板。Greasy Fork 页面上当前安装到的脚本可能没有这些新行为，请先核对版本。

独立版已超过 [Greasy Fork 的脚本体积与代码规则](https://greasyfork.org/zh-CN/help/code-rules)允许的直接发布范围，目前只能从仓库构建后通过脚本管理器安装。仓库中的构建验证不代表该版本已发布到 Greasy Fork。

## Via 安装与排查

在仓库中构建上面的独立版，进入 Via 的「设置 → 脚本 → + → 导入脚本」，选择生成的 `.user.js` 文件。确认脚本已启用后，重新打开普通的 HTTP(S) 网页。**不要同时启用 Greasy Fork 版或精简版**，以免重复注入。若悬浮球仍未出现，请附上 Via、Android、脚本版本及网页地址。

在隔离的 Android 13 模拟器中，Via 7.3.3 导入独立版后，已实际点击悬浮球完成英文段落翻译、恢复原文、再次翻译，并验证设置主题在刷新后保留；翻译使用受控测试页面和译文响应。模拟器结果不代表 Android 真机，也不证明公开翻译服务持续可用。

## Safari Userscripts 安装与排查

1. 从 App Store 安装 Userscripts，并在 Safari 的扩展设置中启用。iPhone/iPad 上打开「设置 → Safari → 扩展 → Userscripts」；允许它访问所有网站，并在 Safari 中选择「始终允许」。macOS 上也要为访问的网站授予权限。
2. 在 Userscripts App 中确认脚本目录；新版 iPhone/iPad 客户端通常会自动设置默认目录，macOS 也可使用默认目录。安装 Greasy Fork 版本时，在 Safari 打开上方安装页，通过 Userscripts 工具栏的安装提示保存并启用。试用从源码构建的独立版时，把生成的 `.user.js` 放入该脚本目录，再打开 Userscripts 弹出窗口刷新文件列表。安装精简版时保持联网，让管理器下载 `@require` 中的界面依赖。
3. 在 Userscripts 弹出窗口确认「Enable Injection」已开启，FluentRead 对当前网页已匹配且启用，然后刷新一个普通的 HTTP(S) 网页。设置从页面悬浮球打开；Safari Userscripts 没有脚本菜单命令。
4. 如果脚本是直接加入脚本目录或从外部编辑器修改的，至少打开一次 Userscripts 弹出窗口，让它重新读取文件。仍未出现悬浮球时，请检查脚本版本、站点权限、当前页是否匹配，以及管理器是否成功下载依赖；反馈时附上 Safari、系统、Userscripts 版本和出问题的网页地址。

这些步骤依据 [Userscripts 官方安装与元数据说明](https://github.com/quoid/userscripts/tree/release/4.x.x)；Safari 上的实际运行情况仍需设备验证。

## 可以做什么？

- 全文翻译、恢复原文和再次翻译；
- 划词、悬浮、双击、长按和中键翻译；
- 输入框翻译、复制和朗读；
- 使用免费服务、云端服务、AI 服务或自定义接口；
- 在脚本自己的设置页中保存语言、服务和显示偏好；仓库独立版使用完整设置中心。

精简版首次安装需要脚本管理器访问 jsDelivr，取得固定版本的界面依赖；独立版已将这些依赖打包。简体中文和英文界面随脚本提供；首次切换到日语、韩语、法语、俄语或西班牙语时，脚本会从 jsDelivr 或 GitHub 下载对应的静态界面语言文件，并缓存在脚本管理器的私有存储中。这些请求不包含正在阅读的网页内容或 API Key。离线环境中，尚未缓存的语言会暂时使用中文界面。

## 和浏览器扩展有什么不同？

油猴脚本受脚本管理器和网页权限限制，不能提供浏览器扩展的全部能力。图片 OCR、圈选截图、Chrome 内置翻译、跨标签页后台功能和 YouTube 字幕功能可能不可用；不同脚本管理器的行为也可能不同。

## 数据与隐私

脚本配置保存在脚本管理器提供的私有存储中。翻译请求会发送到你当前选择的服务；界面依赖和语言文件按上文所述从 jsDelivr 或 GitHub 获取。使用云端服务前，请确认服务商的数据政策。不要在共享设备上填写 API Key，也不要把密钥放进网页、截图或公开反馈。

## 接下来

- [返回完整文档](/docs/)
- [遇到问题](/guide/faq)
