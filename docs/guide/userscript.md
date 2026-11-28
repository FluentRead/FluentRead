# 油猴脚本

当浏览器无法安装扩展时，可通过 **Tampermonkey**、**Violentmonkey**、**Via** 或 **Safari Userscripts** 运行流畅阅读的核心网页与划词翻译功能。

<GuideVisual kind="userscript" />

<DocDiagram kind="platform-matrix" />

## 直接安装（推荐）

1. 在浏览器中安装并启用兼容的脚本管理器。
2. 打开 [流畅阅读 Greasy Fork 页面](https://greasyfork.org/zh-CN/scripts/482986) 按提示安装脚本。
3. 确认仅启用了**一个**流畅阅读副本，刷新普通 HTTP(S) 网页后，通过悬浮球即可翻译或打开设置。

::: tip Chromium 浏览器脚本权限
使用 Tampermonkey 的 Chromium 浏览器（含 Edge Android）可能需额外开启脚本执行权限，请按 [Tampermonkey 官方说明](https://www.tampermonkey.net/faq.php?q=Q209)配置。
:::

## 从源码构建不同版本

在仓库根目录安装依赖后，按使用环境选择构建产物（本地构建不会更新 Greasy Fork 版本）：

| 构建命令 | 输出文件 | 适用场景与特点 |
| --- | --- | --- |
| `pnpm test:userscript:standalone` | `.output/userscript-standalone/fluent-read.user.js` | **独立完整版（Via 首选）**：内置运行库免外部依赖，自带完整设置中心 |
| `pnpm test:userscript` | `.output/userscript/fluent-read.user.js` | 精简版：安装时从 jsDelivr 加载依赖，使用简版设置 |
| `pnpm build:userscript:greasyfork` | `.output/userscript-greasyfork/fluent-read.user.js` | Greasy Fork 发布格式：需联网加载依赖，使用简版设置 |

## Via 安装与排查 {#via-安装与排查}

1. 运行 `pnpm test:userscript:standalone` 构建独立版。
2. 在 Via 中打开**设置 → 脚本 → + → 导入脚本**，选择生成的 `.user.js` 文件并启用（停用其他旧副本）。
3. 重新打开普通网页；若未出现悬浮球，检查脚本开关、网页协议与已安装版本。

## Safari Userscripts 安装与排查 {#safari-userscripts-安装与排查}

1. 从 App Store 安装 **Userscripts**，在系统 Safari 扩展设置中启用并允许访问网站。
2. 打开上方 Greasy Fork 页面按提示安装；或将本地 `.user.js` 放入 Userscripts 指定目录，再打开扩展面板刷新文件列表。
3. 确认 **Enable Injection** 已开启且当前网站匹配，刷新网页后从悬浮球打开设置（Safari Userscripts 无脚本菜单命令）。
4. 网页访问与翻译服务域名权限由管理器分别控制，请按提示授权。更多说明见 [Userscripts 文档](https://github.com/quoid/userscripts/tree/release/4.x.x)。

## 能力范围与数据说明

- **支持**：网页双语翻译与恢复、划词与悬浮翻译，以及管理器支持的输入框翻译、段落复制与朗读；可接入免费、云端、AI 或自定义服务。
- **不支持**：图片 OCR 与漫画翻译、圈选翻译、浏览器内置翻译、视频字幕、写作助手、翻译统计与模型用量，以及扩展右键菜单/弹出面板布局。
- **数据与语言包**：配置存于脚本管理器私有存储；中英文界面随脚本内置，日/韩/法/俄/西语首次使用时从 jsDelivr 或 GitHub 拉取缓存（请求不含网页文字或密钥，离线未缓存时回退中文）。

## 相关文档

- [移动端与 Safari](/guide/mobile-safari)
- [隐私政策](/guide/privacy)
