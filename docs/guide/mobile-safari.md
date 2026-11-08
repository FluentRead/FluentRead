# 手机与 Safari

先按浏览器选择安装方式，再从扩展菜单或网页悬浮球开始翻译。电脑上的扩展 ZIP 不能直接装到 iPhone。

| 环境 | 安装方式 | 适用范围 |
| --- | --- | --- |
| Android Edge | 在浏览器扩展目录搜索流畅阅读 | 可安装扩展及权限由浏览器版本和管理策略决定 |
| Android Firefox | 扩展管理器或 Mozilla Add-ons | 以设备上提供的兼容安装入口为准 |
| Android Via | [安装独立脚本](/guide/userscript#via-安装与排查) | 核心网页与划词翻译 |
| iPhone、iPad、Mac 的 Safari Userscripts | [安装脚本](/guide/userscript#safari-userscripts-安装与排查) | 核心网页与划词翻译，不提供扩展视频字幕、图片或区域翻译 |
| Safari 原生扩展 | 本页下方的开发预览 | 需要源码构建和 Xcode，尚无 Safari 商店安装包 |

## 安装与更新

**Android Edge**：在浏览器扩展目录安装流畅阅读，按提示授权，然后刷新已打开的网页。找不到目录或扩展时，检查浏览器版本及管理策略。更新后在已安装扩展详情中确认版本，再刷新网页。

**Android Firefox**：在扩展管理器或 [Mozilla Add-ons 页面](https://addons.mozilla.org/en-US/firefox/addon/%E6%B5%81%E7%95%85%E9%98%85%E8%AF%BB/) 使用设备提供的安装入口，由 Firefox 管理兼容更新。详细步骤见 [Mozilla 安装说明](https://support.mozilla.org/en-US/kb/find-and-install-add-ons-firefox-android)。

**Safari Userscripts**：按 [脚本安装步骤](/guide/userscript#safari-userscripts-安装与排查) 启用管理器、授予网站权限并安装脚本。只启用一个流畅阅读副本；手动导入的文件需手动替换，再刷新管理器的文件列表。

## 手机上怎样操作

1. 打开普通网页，从扩展菜单或悬浮球选择翻译；同一入口可恢复原文。更换语言或服务后，先恢复再翻译。
2. 需要划词翻译时，长按选中文字、调整选区，再点击翻译图标。系统复制菜单可能同时出现，请保留选区。
3. 需要修改服务时，在扩展面板打开服务列表，搜索服务或模型并选择。

浏览器内部页面和扩展商店无法翻译。在扩展的 **划词翻译 → 更多设置** 中，可用 **返回原页面** 回到阅读页；原标签页已关闭时会提示无法返回。

旋转屏幕或从后台返回后，如果系统重新加载了网页，等待恢复后再次翻译。反馈问题时附上系统、浏览器、扩展或脚本版本、网页地址，以及是否使用系统视频全屏。

## 视频字幕

视频字幕需要扩展版；在 YouTube 网页播放器中先开启原字幕。关闭字幕翻译后，播放器入口会隐藏；可在扩展面板的 **设置 → 视频字幕翻译** 中重新开启。

iOS 系统视频全屏不会显示网页上的双语浮层。原生扩展预览会准备名为 “FluentRead” 的系统字幕轨，需要在系统字幕菜单中手动选择；外观由系统控制，后台暂停时新译文可能延迟。字幕轨不可用时，退出系统全屏，回到网页内播放。此路径仍需 iPhone、iPad 真机验证。

## Safari 原生开发预览

原生扩展面向 Safari/iOS 26+，与 Userscripts 分别运行，请勿在同一网页同时启用。它目前属于开发预览。

首次使用时分别授予**网页访问权限**和**翻译服务访问权限**。免费翻译只尝试已获授权的服务：首次允许一条服务即可开始；拒绝后不会自动弹出下一条服务的授权。要增加服务，在完整设置中逐条允许，无需先授权所有网站。

此版本不提供 Chrome 内置翻译、图片识别和区域截图翻译，部分本地处理、语音播放及 Chrome 专属 Google Drive 登录也不可用。在线服务是否可用需要分别验证。

<details class="guide-details">
<summary>从源码构建和安装预览</summary>

需要 macOS、完整 Xcode，以及仓库 `.nvmrc` 和 `package.json` 指定的 Node.js 与 pnpm 版本。在仓库根目录执行以下命令。

```sh
pnpm safari:check
pnpm build:safari
pnpm safari:verify
pnpm safari:package --bundle-id org.example.FluentRead
```

将示例 bundle ID 换成自己的标识。生成的 Xcode 工程默认位于 `.output/safari-xcode`；已有目录不会被覆盖，再次打包可加 `--project-location .output/safari-xcode-next`。

用 Xcode 打开工程，选择需要的平台、开发团队及设备后构建安装。真机需要相应签名。安装后，在 iPhone/iPad 的 **设置 → App → Safari 浏览器 → 扩展 → 流畅阅读** 中启用并授权；Mac 在 Safari 扩展设置中启用。

构建与打包不会签名、发布商店版本或自动更新已安装 App。Xcode 提示缺少模拟器运行时时，在 **Xcode Settings → Components** 安装相应组件。

</details>

## 验收边界

现有验证包括 Safari 模拟器中的设置保存、授权、网页翻译与恢复，以及 Android 部分模拟器场景。它们不能替代真机安装更新、触摸选区、键盘、辅助功能、视频全屏和后台恢复验证；原生 Safari 仍保留开发预览状态。
