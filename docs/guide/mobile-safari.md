# 移动端与 Safari

按你的手机或 Mac 浏览器选择对应的安装方式。注意：电脑版扩展的 ZIP 压缩包**不能**直接安装到 iPhone。

<DocDiagram kind="platform-matrix" />

## 选择适合你的安装方式

| 使用环境 | 安装方式 | 支持范围 |
| --- | --- | --- |
| **Android Edge** | 在浏览器扩展目录搜索安装**流畅阅读** | 可用能力与权限由浏览器版本与管理策略决定 |
| **Android Firefox** | 扩展管理器或 [Mozilla Add-ons](https://addons.mozilla.org/en-US/firefox/addon/%E6%B5%81%E7%95%85%E9%98%85%E8%AF%BB/) | 扩展版核心能力，由 Firefox 管理更新（[官方说明](https://support.mozilla.org/en-US/kb/find-and-install-add-ons-firefox-android)） |
| **Android Via** | [安装独立油猴脚本](/guide/userscript#via-安装与排查) | 核心网页双语与划词翻译 |
| **iPhone / iPad / Mac Safari Userscripts** | [安装油猴脚本](/guide/userscript#safari-userscripts-安装与排查) | 核心网页与划词翻译（不含扩展视频字幕、图片或圈选） |
| **Safari 原生扩展（开发预览）** | 见下方源码构建与 Xcode 打包步骤 | 面向 Safari/iOS 26+ 开发预览，尚无商店安装包 |

## 手机上如何日常使用

1. 打开普通 HTTP(S) 网页，从扩展菜单或网页悬浮球点击**翻译**；同一入口再次点击恢复原文（换语言/服务前先恢复再重译）。
2. **划词翻译**：长按选中文字并拖动调整选区，再点击翻译图标（系统复制菜单同时出现时请保留选区）。
3. **切换服务**：在扩展面板打开服务列表，支持直接搜索服务或模型；在**划词翻译 → 更多设置**中可点**返回原页面**回到阅读页。
4. 屏幕旋转或从后台切回若导致系统重载网页，等待恢复后再次翻译即可。

## 移动端视频字幕

视频字幕翻译需要扩展版：在 YouTube 网页播放器先打开原生字幕；关闭字幕翻译后播放器入口会隐藏，可在扩展面板**设置 → 视频字幕翻译**重新开启。

::: info iOS 系统全屏字幕限制
iOS 原生视频全屏不支持渲染网页浮层。Safari 原生开发预览会准备名为 **FluentRead** 的系统字幕轨，需在系统字幕菜单手动选择（外观由系统控制）；不可用时退出全屏在网页内播放即可。
:::

## Safari 原生扩展开发预览

原生扩展面向 **Safari / iOS 26+**，与 Safari Userscripts 彼此独立，**切勿在同一网页同时启用**。

- **分级授权**：首次使用需分别授予**网页访问权限**和**翻译服务访问权限**；免费翻译仅尝试已授权服务（拒绝后不会连续弹窗，后续可在完整设置逐条按需授权）。
- **功能边界**：开发预览已接入图片识别/翻译、圈选翻译与扩展内朗读（仍待真机全面验证）；Chrome 内置翻译与 Chrome 专属 Google Drive 同步不可用。

<details class="guide-details">
<summary>从源码使用 Xcode 构建并安装 Safari 预览版</summary>

需要 macOS、完整 Xcode 及仓库 `.nvmrc` / `package.json` 要求的 Node.js 与 pnpm 版本，在仓库根目录运行：

```sh
pnpm safari:check
pnpm build:safari
pnpm safari:verify
pnpm safari:package --bundle-id org.example.FluentRead
```

请将示例 bundle ID 替换为自己的标识。工程默认输出到 `.output/safari-xcode`（再次打包可加 `--project-location .output/safari-xcode-next`），用 Xcode 打开配置签名并构建安装后，在 **设置 → App → Safari 浏览器 → 扩展 → 流畅阅读**（Mac 为 Safari 扩展设置）中启用授权。

</details>

## 验收边界

当前验证覆盖 Safari 模拟器的设置、授权、网页翻译与恢复，以及 Android 模拟器核心场景，尚不能替代全部真机触摸选区、系统全屏与后台恢复验收，原生 Safari 仍保持开发预览状态。

## 相关文档

- [油猴脚本安装与排查](/guide/userscript)
- [离线下载与安装（桌面 Chrome / Edge）](/guide/offline-install)
