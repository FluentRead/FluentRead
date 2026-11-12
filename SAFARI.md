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
    ├── light.png        # 品牌粉底 + 白色 A/中 字形
    └── dark.png         # #1C1C1E 深色底板 + 品牌粉字形
```

| 外观 | 底色 | 字形 |
| --- | --- | --- |
| 浅色 | `#E93475` | `#FFFFFF` |
| 深色 | `#1C1C1E` | `#E93475` |

深色配色对齐系统应用（快捷指令、密码等）：近黑底板 + 品牌色字形。两套图层由系统按外观自动选择，不需要运行时判断。字形高度约占画布 64%。

### 界面里的品牌图标

扩展自有页面（弹窗、设置、文档翻译）与容器应用引导页共用同一套配色：

- 资源：`public/icon/appearance/{light,dark}-{16..128}.png`，构建后进入扩展包；
- 切换：`src/ui/styles/brand-icon.css` 用 `img.brand-icon { content: url(...) }` 配合 `prefers-color-scheme`，不写脚本；
- 容器应用：`Resources/Icon.png` 与 `Icon-dark.png`，`Style.css` 里同样按外观切换（`content` 的相对地址以样式表目录为基准，不能写 `../`）；
- 清单图标（Safari 设置里的扩展列表）是静态资源，由系统渲染，不随外观变化。

#### 清单图标要自己烘焙圆角

Safari 把清单 `icons` 里的位图**原样**画进扩展列表，不施加任何遮罩，所以方形 PNG 会显示成直角方块。`public/icon/**` 与手机端不同，需要预先画好圆角（半径取边长 22.5%，边缘做 1px 抗锯齿）。

这与应用图标是两套规则，别混用：`AppIcon.icon` 的图层必须是**未遮罩的方形**（HIG 要求，圆角由系统施加），而清单图标必须自带圆角。


### 工具栏按钮

Safari 按模板渲染工具栏按钮：只取轮廓，颜色由工具栏明暗决定。因此工具栏不能复用带底色的应用图标（会被压成灰底方块），而是单独提供 `public/icon/action/{16,19,32,38}.png` —— 透明底、纯黑字形，通过清单 `action.default_icon` 指定（仅 Safari 产物），`badgeRuntime` 切换状态图标时也走这套资源。

### 重新签名时的坑

替换 `Assets.car` 后必须重签外层 App，但**不要加 `--deep`**：`--deep` 会连内嵌 appex 一起重签，并把它原本的授权（`com.apple.security.app-sandbox` 等）抹掉。扩展失去授权后 Safari 无法稳定保留，表现为每次启动 Safari 都要重新启用扩展。

```sh
codesign --force --sign - --preserve-metadata=entitlements,flags <app>
codesign --verify --deep --strict <app>
```

嵌套 appex 保持 Xcode 的原始签名即可。可用 `codesign -d --entitlements :- <appex>` 复核授权是否还在。

### 签名身份：决定扩展能否跨重启保留

Apple 官方文档明确写着：**「允许未签名的扩展」在退出 Safari 时会被重置**，下次启动需要重新勾选。ad-hoc 签名（`codesign -s -`）对 Safari 而言就是未签名，因此 ad-hoc 构建只能用于临时调试。

要让扩展的启用状态跨重启保留，必须用 Apple 签发的开发证书签名。`build-app.mjs` 会自动探测：优先取 `FLUENTREAD_SIGN_IDENTITY`，否则读钥匙串里第一个可用于代码签名的身份，都没有才回落到 ad-hoc。

```sh
# 有证书时（内层 appex 先签，外层再签，均保留授权）
FLUENTREAD_SIGN_IDENTITY="Apple Development: Your Name (TEAMID)" pnpm safari:app
```

免费 Apple ID 也能获得 Apple Development 证书：Xcode → Settings → Accounts 添加账号 → Manage Certificates → `+` → Apple Development。

#### 证书生成后仍显示 0 valid identities

钥匙串里常缺 WWDR **G3** 中间证书（系统只自带旧版 WWDR CA，链到 `Apple Root CA`），此时
`security find-identity -p codesigning` 能列出身份，但 `-v`（仅有效）为空，`verify-cert`
报 `CSSMERR_TP_NOT_TRUSTED`。

Xcode 自带这份中间证书，直接导入即可，不需要联网下载：

```sh
security import "/Applications/Xcode.app/Contents/SharedFrameworks/DVTFoundation.framework/Versions/A/Resources/AppleWWDRCA-2030.cer" \
  -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign
```

#### 为什么不用 xcodebuild 自动签名

命令行下 `-allowProvisioningUpdates` 取不到 Xcode 的账号库，会直接报 `No Accounts`；macOS
目标还会被要求 "Mac Development" 证书。本工程没有需要描述文件的受限能力（只有 app-sandbox
与网络客户端），因此固定 ad-hoc 构建 + 事后重签，签名链为
`Apple Development → WWDR CA → Apple Root CA`，`app-sandbox` 授权保留。

注意：用个人证书签名的产物只适合自用，不要发布到 Release——证书与团队绑定，换机即失效。



构建时由 `build-app.mjs` 在复制产物后执行：

```sh
xcrun actool Assets.xcassets AppIcon.icon \
  --compile <tmp> --platform macosx --minimum-deployment-target 12.0 \
  --app-icon AppIcon --output-partial-info-plist <tmp>/partial.plist
```

用产物的 `Assets.car` 与 `AppIcon.icns` 覆盖应用资源，并重新做临时签名（资源替换会让原签名失效）。

注意事项：

- `.icon` 目录名必须与 `--app-icon` 名称一致（`AppIcon.icon`），否则 `actool` 会静默不产出 `Assets.car`（exit code 仍为 0）。
- **图层必须满幅**。图层若自带透明外圈，深色外观下系统底板会从外圈透出，形成黑框；只放字形、指望 `fill` 提供底色时，`fill` 在深色下同样不生效。
- **视觉尺寸由字形占比决定，不是画布**。macOS 会把图层铺满图标区域，所以“图标比同类大”通常意味着字形过大。本项目按同屏第三方应用（字形包围盒约 54% × 64%）把字形缩到高 64%，其余留作底色。
- `Assets.xcassets` 与 `.icon` 一起传给 `actool`，可同时保留 `AccentColor` 等条目。

## 目录

```
scripts/safari/convert.mjs     # 清单校验、safari-web-extension-converter 封装、资源同步
scripts/safari/build-app.mjs   # 同步资源 + xcodebuild + 复制 .app + 分层图标编译与重签
safari/                        # 生成的 Xcode 工程（含定制引导界面与 AppIcon.icon）
src/platform/offscreen/safariDocument.ts   # Safari 后台标签页文档容器
build/dist/流畅阅读.app        # 可安装产物
```
