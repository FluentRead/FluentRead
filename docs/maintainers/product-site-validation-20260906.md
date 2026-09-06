# 产品官网与宣传素材验收 · 2026-09-06

## 交付范围

- 中英文 README、首页与全部用户指南；首页突出 GPL-3.0 开源及翻译卡对 DeepSeek Harness 会话内核的浏览器适配。
- 浏览器首选语言决定首次首页语言，手动切换会记住选择。明确语言的路径和文档深链接保留原 URL。
- 独立 `marketing/` 目录及可重复生成的中英文商店 ZIP。每种语言包含商店介绍、5 张截图、2 张宣传图、社区文案与 9 张高清原图。
- 保留技术参考和上游许可记录，维护材料不进入官网。
- 首页使用项目名称与事实描述，清理 README、使用指南、商店介绍和中英文宣传图中的口号式表达；保留用户提供的大图标。
- 扩展赞赏窗口同时显示微信支付与 Ko-fi，7 种界面语言均有译文；设置页增加支持入口。中英文 README、官网导航和独立支持页同步提供两种方式。

## 已通过

| 检查 | 结果 |
| --- | --- |
| `pnpm docs:build` | 生产构建成功，47 个 HTML 页面 |
| `pnpm compile` | TypeScript / Vue 类型检查通过 |
| `pnpm build` / `pnpm build:firefox` | Chrome MV3 与 Firefox MV2 生产构建成功；真实 UI 验证使用 Chrome MV3 产物 |
| 相关单元测试 | i18n、Popup 功能显隐、设置 UI 架构、界面外观、Harness 配置/运行时、中文识别，共 7 个文件 261 个用例通过 |
| `scripts/verify-support-ui.cjs` | 7 种语言的双入口、原图链接、默认尺寸不滚动、窄窗口可达、Tab 焦点循环、Escape 与关闭按钮、中文英文深色模式；无页面或控制台错误 |
| `pnpm test:audit` | 266 个测试文件、3,456 个登记用例归类审计通过；此项不是运行全部用例 |
| `git diff --check` | 通过 |
| `scripts/verify-product-site.cjs` | 1,490 处内部链接和锚点、68 处图片引用通过；中英文指南路径成对 |
| 生产站点浏览器 | 中文与英文自动选择、手动语言切换与记忆、文档对应页、移动端菜单、深色模式、无横向溢出；无 pageerror 或 console error |
| 截图像素 | 整页 2560×1600，菜单 720×1120；划词特写 1400×960，翻译卡特写 840×1140 |
| 官网无损图 | 18 张高清 WebP 解码像素与对应 PNG 一致；5,381,125 → 2,334,628 bytes，约减少 57% |
| 商店图 | 每语言 5 张 1280×800 RGB PNG；440×280 小图与 1400×560 横幅；128×128 图标 |
| ZIP | 两个独立语言包，各 30 个文件，重新读取压缩包并核对 5 张商店截图、2 张宣传图、9 张高清原图 |

官网使用自有组件样式，并关闭首页的默认 Markdown 样式包装，避免 VitePress 的视口宽度计算导致生产 hydration 不一致。指南继续使用默认文档排版。

## 证据与范围

- 图片来源、真实尺寸与体积：`marketing/asset-manifest.json`。
- 扩展截图的 launch mode、focus policy、window placement、请求次数与完成状态：`marketing/source/capture-report.json`、`capture-report-en.json`。
- 官网浏览器报告：本次本地输出 `/private/tmp/fluentread-product-site-verification/report.json`，同目录包含桌面、手机、深色截图；可通过验证脚本重新生成。
- 产品截图来自生产扩展在临时 Edge 配置中的真实界面，源语言保持自动检测。自有文章及审校过的译文、AI 讲解来自本地示例服务，分别经过实际翻译链路与 Harness 会话、段落工具流程。没有改写扩展 UI 来伪造结果。
- 截图采集在配置完成后关闭本次其他扩展页面，检查翻译卡没有“设置已更新”或“已停止”的过渡状态再导出。
- 本次验证覆盖官网、产品素材与赞赏窗口，不是第三方翻译质量评测或全站兼容性回归。没有运行所有业务测试，也没有发布线上官网或提交商店。
- 未读取或移植 `read-frog`、`kiss-translator` 的设计或代码；主工作树保持原状。

## 赞赏窗口的验证边界

生产扩展在隔离临时 Edge 中运行，报告保存在 `/private/tmp/fluentread-support-ui/report.json`。启动模式为 `macos-background-cdp`，焦点策略为 `launchservices-no-foreground`，窗口完整位于第二显示器，`browserFrontmost=false`。七种语言在 360×560 视口均能完整显示微信与 Ko-fi；320×400 下可通过窗口内部滚动访问 Ko-fi。截图使用 CDP 实际 2x 像素，等待窗口动画结束后采集。

微信原图在扩展、README 和官网三个位置的 SHA-256 均为 `a2e7f4452a0efa645ca5e1013c6229d49e276e7e489cd95c18e195f494e2c63e`。界面通过 CSS 放大完整赞赏码区域，未改写图片内容；原图链接仍可打开 1152×1152 的原文件。Ko-fi 链接采用用户提供的 `https://ko-fi.com/thinkstu`，使用新标签页并带 `noopener noreferrer`。未发起支付，也未验证服务商的付款流程。

通用扩展 UI Skill 的 `run-ui-test.cjs --suite full` 已运行，但在初始化 Popup 时超时：脚本第 533 行查找旧标题 `/让阅读自然地流动|翻译功能已暂停/`，当前启用标题为“网页翻译”。改动前的 `27e315a` 也是“网页翻译”，且此脚本没有处理现有的首次语言选择。因此完整通用套件没有通过，后续用例未运行；不能把赞赏专项的通过当作通用套件通过。该外部 Skill 脚本未在本任务中修改。Firefox 完成构建，未执行浏览器交互回归。

## 合并前复核

任务分支已集成 `bc3c057` 的主分支更新，代码集成提交为 `dac0d25`。两处用户指南冲突按新的文档结构解决，并在中英文指南中保留中文书写体系识别与七语言默认提示词说明。类型检查、7 个文件 261 个测试、测试归类审计、Chrome / Firefox 构建及官网生产构建重新通过。官网报告位于 `/private/tmp/fluentread-product-site-merge/report.json`，赞赏窗口报告位于 `/private/tmp/fluentread-support-ui-merge/report.json`，两者均通过且没有页面或控制台错误。通用 UI 套件及 Firefox 交互的既有验证限制仍适用。
