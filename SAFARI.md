# Safari 版适配说明

本仓库是 [FluentRead（流畅阅读）](https://github.com/FluentRead/FluentRead) 的 Safari 移植分支：在上游 WXT + Vue 3 扩展的基础上，补齐 Safari 构建目标、运行时差异处理和 macOS 容器应用。

## 当前状态

| 环节 | 结果 |
| --- | --- |
| Safari 扩展构建 | 通过，`.output/safari-mv3`，61.5 MB |
| Xcode 容器工程 | 已生成，`safari/流畅阅读/流畅阅读.xcodeproj` |
| 应用编译 | 通过，`build/dist/流畅阅读.app`（ad-hoc 签名，`codesign --verify` 通过） |
| 引导界面 | 已本地化并截图核对（品牌卡片、状态徽标、三步引导、品牌图标） |

## 构建与产物

```sh
pnpm install          # 也可用 npm install --legacy-peer-deps
pnpm build:safari     # wxt build -b safari --mv3 → .output/safari-mv3
pnpm safari:app       # 同步扩展资源 + xcodebuild → build/dist/流畅阅读.app
```

- **`pnpm safari:convert` 只在首次生成 Xcode 工程时执行。** 它会调用 `safari-web-extension-converter --force`，覆盖容器应用里的 Swift 与界面改动。
- 日常改动扩展代码后，只需 `build:safari` + `safari:app`；后者会把新产物同步进工程的 `Resources`。
- Safari 目标强制 MV3：WXT 0.20 默认把 Safari 输出成 MV2，而 MV2 后台是持久页面，会改变本项目 `isBackgroundContext` 的判定与权限模型，因此构建脚本显式带 `--mv3`。

## 安装与启用

1. 把 `build/dist/流畅阅读.app` 移到 `/Applications`，打开一次（让 macOS 注册其中的扩展）。
2. 本地构建是 ad-hoc 签名，需先允许未签名扩展：
   Safari → 设置 → 高级 → 勾选「显示网页开发者功能」，然后菜单栏 开发 → 允许未签名的扩展。
3. Safari → 设置 → 扩展 → 勾选「流畅阅读」。
4. 点工具栏扩展图标，把网站访问权限设为「允许所有网站」；只在单站点授权时，其他网页不会注入内容脚本。
5. 在工具栏图标上右键 → 固定。

## 与 Chromium 的差异处理

| 主题 | Chromium | Safari | 处理方式 |
| --- | --- | --- | --- |
| 后台 DOM 容器 | MV3 service worker + Offscreen API | 只有 service worker，无 Offscreen | 扩展自己的后台标签页承载同一份 `offscreen.html`；tabId 存 `storage.local`，空闲 10 分钟自动关闭（`src/platform/offscreen/safariDocument.ts`） |
| 能力矩阵 | `extensionDom` 由 Offscreen 决定 | 由后台标签页决定 | `resolveBrowserCapabilities` 增加 `safari` 分支；并按 UA 兜底，Chromium 产物被侧载进 Safari 时同样按 Safari 降级 |
| 请求头规则 | `initiatorDomains` 限定发起方 | DNR 条件不支持 `initiatorDomains` / `requestMethods` | 规则只按精确域名 + `xmlhttprequest` 收窄（`requestHeaderRules.ts`、`doubaoGuest.ts`） |
| Google Drive 备份 | `identity` API | 未声明该权限 | 设置页在 Safari 只显示 WebDAV |
| 动态资源地址 | `use_dynamic_url` | 不支持 | 转换前从清单移除（`scripts/safari/convert.mjs`） |
| 扩展页面 CSP | 自定义 `extension_pages` | 使用系统默认策略 | Safari 产物不写 `content_security_policy` |
| Chrome 内置翻译 | 可用 | 无 Translator API | 能力矩阵关闭，设置页自动隐藏该服务 |
| Bundle ID | — | 内嵌扩展必须以主 App 前缀开头 | 中文应用名会被转换器转义成 `----`，脚本回写为 `com.fluentread.safari` |

## 已知限制

- **MAIN world 桥接**：转换器提示 `world`、`open_in_tab`、`match_about_blank` 不受当前 Safari 版本支持。若 Safari 确实忽略 `world`，YouTube / X 字幕桥接和页内 Shadow UI 桥会在隔离环境运行，相关功能可能失效；需在真机 Safari 中逐项验证。
- **后台运行页可见**：图片翻译、圈选翻译、本地模型首次使用会打开标题为「流畅阅读 · 后台运行页」的标签页，这是 Safari 允许扩展持有 DOM 的唯一方式。手动关闭后下次请求会自动重建。
- **本地模型**：本地翻译、本地 TTS、视频转写依赖 WebGPU/WASM 与大体积模型下载，未在 Safari 上做逐机型验证。
- **快捷键**：Safari 的扩展快捷键受系统与 Safari 设置约束，扩展内配置可能被拦截。

## 应用图标（macOS 26 外观）

macOS 26 会按外观重绘资源目录里的位图图标：深色外观下，`.appiconset` 的底色被系统底板替换，品牌粉变成近似黑色，并出现浅色描边。因此应用图标改用 Icon Composer 的分层格式：

```
safari/流畅阅读/流畅阅读/AppIcon.icon/
├── icon.json            # fill + 浅色/深色图层声明
└── Assets/
    ├── light.png        # 满幅品牌粉 + 白色 A/中 字形
    └── dark.png         # 同构图，底色降到 90% 亮度
```

构建时由 `build-app.mjs` 在复制产物后执行：

```sh
xcrun actool Assets.xcassets AppIcon.icon \
  --compile <tmp> --platform macosx --minimum-deployment-target 12.0 \
  --app-icon AppIcon --output-partial-info-plist <tmp>/partial.plist
```

用产物覆盖 `Contents/Resources/Assets.car` 并重新做临时签名（资源替换会让原签名失效）。

注意事项：

- `.icon` 目录名必须与 `--app-icon` 名称一致（`AppIcon.icon`），否则 `actool` 会静默不产出 `Assets.car`。
- 图层必须是**满幅**图像。只放字形、指望 `fill` 提供底色时，深色外观会用系统黑底覆盖 `fill`。
- `Assets.xcassets` 与 `.icon` 一起传给 `actool`，可同时保留 `AccentColor` 等条目。

## 目录

```
scripts/safari/convert.mjs     # 清单校验、safari-web-extension-converter 封装、资源同步
scripts/safari/build-app.mjs   # 同步资源 + xcodebuild + 复制 .app + 分层图标编译与重签
safari/                        # 生成的 Xcode 工程（含定制引导界面与 AppIcon.icon）
src/platform/offscreen/safariDocument.ts   # Safari 后台标签页文档容器
build/dist/流畅阅读.app        # 可安装产物
```
