# FluentRead — Design System Specification (`DESIGN.md`)

> 本规范综合 **Impeccable**（设计审查与反模板化）、**UI UX Pro Max**（系统化 Design Tokens 与层级规划）、**Emil Design Engineering**（动效物理与微交互打磨）以及 **Vercel Web Design Guidelines**（工程质量、表单可用性与无障碍合规），在保留 **Vue 3 + Element Plus + WXT** 技术体系的前提下，为 FluentRead 建立长期可演进的产品设计体系。

---

## 1. 现状全面审查摘要（Baseline Audit）

对 FluentRead `src/` 下 **194 个 Vue/CSS 文件**（其中 178 个包含样式声明）进行静态量化审计与真实浏览器渲染审查，发现六类结构性问题：

| 审查维度 | 量化现状（改造前） | 核心问题与影响 |
| --- | --- | --- |
| **色彩与主题一致性** | 1,062 种独立十六进制色值（2,312 处硬编码）；Popup / Settings / Document / Docs 各自维护不同暗色底色；`assets/styles/theme.css` 残留未使用旧样式与全局 `* { transition: 0.3s }` | 品牌色漂移（`#ef4776` / `#ed4775` / `#d63260` / `#b92252`）；跨模块暗色明度不统一；官网缺乏暗色支持 |
| **WCAG 2.2 对比度** | `--muted` (`#737c8f`) 在白底仅 **4.19:1**、在软灰底 **3.95:1**；`--brand-strong` (`#dc315f`) 在 `--brand-soft` (`#fff0f4`) 仅 **4.09:1**；侧栏分组标题 (`#9299a8`) 仅 **2.86:1**；主按钮白字配 `#ef4776` 仅 **3.60:1** | 辅助文字、标签与按钮在长时间阅读与低亮度屏幕上发虚，未达 WCAG AA 4.5:1 标准 |
| **圆角与层级体系** | 75 种独立 `border-radius` 值（3px–24px 混用）；Popup 内同时出现 7/8/9/10/11/14/22/24px | 嵌套元素缺乏同心圆角关系；卡片与控件边界语言割裂；服务配置页存在多层卡片嵌套 |
| **字号与排版可读性** | 30 种独立字号，包含 **321 处 <11px 极小字号**（7.5px / 8px / 8.5px / 9px×45 / 9.5px×26 / 10px×161 / 10.5px×70）及大量非标字重（520/550/650/730/760/780） | CJK 汉字在 9–10px 下笔画粘连；非整数像素与非标准字重在 Windows/macOS 渲染不一致 |
| **反模板化（Impeccable）** | 70 处装饰性渐变、327 处阴影、313 处 `!important`；Logo 带粉色光晕阴影、主按钮用双色渐变与 hover 上浮发光、状态点带绿色光晕、关于页/文档页带径向光斑 | 呈现过时的装饰感与视觉噪音，削弱阅读工具的平静与专业气质 |
| **交互与动效工程** | 普遍使用默认 `ease` 曲线；缺少按钮 `:active` 按压反馈；焦点环在 `3px rgba(.22)` 与 `2px solid` 间不统一；`popup.css` 与 `settings-page.css` 底部堆叠多轮覆盖补丁 | 反馈不够干脆利落；焦点可见性不一致；样式层叠脆弱、维护成本高 |

---

## 2. 成熟产品设计理念对比与 FluentRead 方向

| 参考产品 | 值得借鉴的核心设计理念 | 不可照搬之处 | FluentRead 落地转化 |
| --- | --- | --- | --- |
| **Linear** | 极高精度的中性灰阶、1px 发丝边框、克制的单点强调色、键盘与快捷键优先 | 偏暗黑高冷的工程看板气质，不适合轻松日常阅读 | 用 1px 中性边框与平涂层级替代重阴影；品牌色只承载主按钮、选中态与焦点 |
| **Readwise Reader** | 以阅读内容为绝对主角，界面退居幕后；长时间阅读的低疲劳亮暗明度配比 | 单一阅读器形态，缺少扩展多场景工具入口 | 提高辅助文字对比度（≥5.5:1），暗色采用 `#14171c` / `#1c2028` 柔和深炭，消除背景光斑 |
| **Raycast** | 紧凑面板内的清晰分组、高频操作直达、搜索驱动的快速选择、利落的快捷键徽章 | 强阴影悬浮命令面板，不适合完整设置表单 | Popup 保持 320px 紧凑秩序：语言→服务→主操作→站点/显示工具→2×2 快捷入口，消除多余嵌套 |
| **Apple HIG** | 原生分组列表（外框 + 内部分隔线）、同心圆角几何、可预测的开关/分段控件与清晰焦点 | macOS 强毛玻璃材质在跨平台浏览器扩展中性能与对比不稳定 | 设置中心坚持「单层分组容器 + 内部分隔线」，取消毛玻璃与卡片套卡片，保证跨浏览器一致 |
| **Read Frog / Kiss Translator** | 清晰的语义前缀隔离（避免宿主 CSS 污染）、Storybook 文档化验证、服务配置与规则分离 | React/Tailwind 技术栈与过于工具化的表单密度 | 坚守 Vue 3 + Element Plus + WXT，扩展现有 `--fr-*` 语义 Token 与 Storybook 规范站 |

### FluentRead 设计方向：**Editorial Precision（编辑级精准阅读）**

1. **中性为底，玫红点睛**：90% 界面由高可读中性纸面与细边框构成；FluentRead 标志性玫红只用于核心 CTA、当前激活态与焦点轮廓。
2. **平涂质感，克制阴影**：静态面板使用 `1px solid var(--fr-color-line)` 划分层级，去掉主画布渐变、Logo 发光与卡片大阴影；阴影仅用于悬浮菜单、抽屉与对话框。
3. **可读性第一的排版**：建立 7 级清晰字号阶梯与标准字重（400 / 500 / 600 / 700），核心 UI 文案原则上不低于 `12px`（仅极紧凑徽标/计数允许 `11px`），数值统一 `tabular-nums`。
4. **物理一致的微交互**：采用 `cubic-bezier(0.23, 1, 0.32, 1)` 缓出曲线、120ms–220ms 克制时长、`scale(0.985)` 按压确认，取消 hover 上浮发光。
5. **开放且兼容的皮肤架构**：默认主题与 13 套内置皮肤共享同一结构 Token 契约（间距、圆角比例、字号、焦点、反馈色），传统色皮肤只覆写调色与特色轮廓。

---

## 3. 统一 Design Tokens 规范（`src/ui/styles/tokens.css`）

### 3.1 色彩系统（WCAG 2.2 AA 数学校验）

#### 亮色主题（Light Default）
| Token | 别名 | 色值 | 用途 | 对比度（对 `--surface`） |
| --- | --- | --- | --- | --- |
| `--fr-color-brand` | `--brand` | `#ef4776` | 品牌源色、开关开启态、装饰锚点 | —（图形/大元素） |
| `--fr-color-brand-action` | — | `#d62d5e` | 主操作按钮纯色填充（白字对比 ≥ 4.69:1） | 4.69:1（白字） |
| `--fr-color-brand-action-hover` | — | `#bf2351` | 主操作按钮悬停态 | 5.79:1（白字） |
| `--fr-color-brand-strong` | `--brand-strong` | `#cc2655` | 品牌色文字、链接、选中态文字 | **5.28:1**（AA ✓） |
| `--fr-color-brand-soft` | `--brand-soft` | `#fff1f5` | 品牌浅底（选中项、轻强调标签） | 4.82:1（配 `brand-strong`） |
| `--fr-color-canvas` | — | `#f5f6f8` | 页面外层画布（设置页工作区） | — |
| `--fr-color-surface` | `--surface` | `#ffffff` | 卡片、弹窗、主面板表面 | — |
| `--fr-color-surface-soft` | `--surface-soft` | `#f6f7f9` | 控件底面、次级分区、悬停底色 | — |
| `--fr-color-surface-hover` | — | `#eef0f4` | 交互项悬停强化底色 | — |
| `--fr-color-ink` | `--ink` | `#161b26` | 主标题、正文、表单值 | **17.23:1**（AAA ✓） |
| `--fr-color-muted` | `--muted` | `#5b6476` | 辅助说明、次级标签、占位符 | **5.95:1**（AA ✓） |
| `--fr-color-line` | `--line` | `#e3e6ed` | 1px 标准分隔线与卡片边框 | — |
| `--fr-color-line-strong` | — | `#cfd5e0` | 控件悬停边框、强调分隔线 | — |

#### 暗色主题（Dark Default）
| Token | 别名 | 色值 | 用途 | 对比度（对 `--surface`） |
| --- | --- | --- | --- | --- |
| `--fr-color-brand` | `--brand` | `#f25c88` | 暗色品牌源色、开关开启态 | — |
| `--fr-color-brand-action` | — | `#d93464` | 暗色主操作按钮填充（白字对比 4.54:1） | **4.54:1**（AA ✓） |
| `--fr-color-brand-action-hover` | — | `#e44574` | 暗色主操作按钮悬停态 | — |
| `--fr-color-brand-strong` | `--brand-strong` | `#ff7fa6` | 暗色品牌色文字与选中图标 | **6.87:1**（AA ✓） |
| `--fr-color-brand-soft` | `--brand-soft` | `rgba(242, 92, 136, 0.16)` | 暗色品牌浅底 | — |
| `--fr-color-canvas` | — | `#14171c` | 暗色外层画布（Popup/Settings/Document 统一） | — |
| `--fr-color-surface` | `--surface` | `#1c2028` | 暗色卡片、弹窗、主面板表面 | — |
| `--fr-color-surface-soft` | `--surface-soft` | `#232833` | 暗色控件底面、次级分区 | — |
| `--fr-color-surface-hover` | — | `#2b313e` | 暗色交互悬停底色 | — |
| `--fr-color-ink` | `--ink` | `#f1f3f7` | 暗色主正文 | **14.69:1**（AAA ✓） |
| `--fr-color-muted` | `--muted` | `#a5aebf` | 暗色辅助说明 | **7.31:1**（AAA ✓） |
| `--fr-color-line` | `--line` | `#2f3542` | 暗色 1px 细边框 | — |
| `--fr-color-line-strong` | — | `#434b5c` | 暗色悬停边框 | — |

#### 语义反馈色（亮 / 暗均 ≥ 4.5:1）
- Success：`#1e6f5c` / `#eaf7f3`（暗：`#8fdcc4` / `#19322b`）
- Warning：`#8f5f16` / `#fff6e2`（暗：`#ebca84` / `#382e1d`）
- Danger：`#b42348` / `#fff0f3`（暗：`#f5a3b8` / `#3b2029`）
- Info：`#2563a6` / `#edf4ff`（暗：`#9bc5f2` / `#1f3045`）

---

### 3.2 排版阶梯（Typography Scale）

使用 `--interface-font-family`（系统原生优先：macOS SF Pro / PingFang SC、Windows Segoe UI / Microsoft YaHei）与等宽字体 `--fr-font-mono`：

| Token | 尺寸 | 行高 | 标准字重 | 典型用途 |
| --- | --- | --- | --- | --- |
| `--fr-text-2xl` | `24px` | `1.3` | `700` | 关于页/文档页主标题 |
| `--fr-text-xl` | `18px` | `1.35` | `600` | 服务详情标题、抽屉标题 |
| `--fr-text-lg` | `15px` | `1.4` | `600` | 分组卡片标题（`SettingsGroup`）、弹窗标题 |
| `--fr-text-md` | `14px` | `1.5` | `500 / 600` | 表单输入值、Popup 品牌名、阅读正文 |
| `--fr-text-base` | `13px` | `1.5` | `500 / 600` | 设置项标签、侧栏导航、按钮文案 |
| `--fr-text-sm` | `12px` | `1.55` | `400 / 500` | 辅助说明、表单帮助、Popup 卡片标题、页脚 |
| `--fr-text-xs` | `11px` | `1.4` | `500 / 600` | 仅用于紧凑标签、快捷键 `kbd`、分组小标题、计数器（禁止再出现 <11px 正文） |

> 排版细则：所有数字统计、版本号、进度百分比和快捷键宽度控制必须使用 `font-variant-numeric: tabular-nums`；多语言标签允许自然换行（`overflow-wrap: anywhere` + `min-width: 0`）。

---

### 3.3 空间与同心圆角（Spacing & Geometry）

- **4px 基准栅格**：`--fr-space-1 (4px)`、`--fr-space-2 (8px)`、`--fr-space-3 (12px)`、`--fr-space-4 (16px)`、`--fr-space-5 (20px)`、`--fr-space-6 (24px)`、`--fr-space-8 (32px)`。
- **收敛为 5 级圆角 Token**（替代原有的 75 种零散圆角）：
  - `--fr-radius-xs: 6px`（小徽标、`kbd`、分组折叠项）
  - `--fr-radius-sm: 8px`（输入框、下拉框、按钮、导航项、控件）
  - `--fr-radius-md: 10px`（Popup 快捷卡片、服务项、次级面板）
  - `--fr-radius-lg: 12px`（主设置卡片 `SettingsGroup`、Popup 主卡片、浮层菜单、对话框）
  - `--fr-radius-full: 9999px`（开关轨道、圆形图标、胶囊徽标）
- **同心圆角法则**：内层控件圆角始终 ≤ 外层容器圆角减去内边距（如 12px 卡片 + 12px padding 内嵌 8px 控件）。

---

### 3.4 层级与阴影（Elevation）

- **Level 0（画布）**：`--fr-color-canvas`，无阴影。
- **Level 1（静态表面/卡片）**：`--fr-color-surface` + `1px solid var(--fr-color-line)`，默认无阴影或极轻 `--fr-shadow-xs: 0 1px 2px rgba(22, 27, 38, 0.04)`。
- **Level 2（悬浮菜单 / Popover / Tooltip）**：`--fr-shadow-md: 0 8px 24px rgba(22, 27, 38, 0.10), 0 1px 3px rgba(22, 27, 38, 0.05)` + `1px solid var(--fr-color-line)`。
- **Level 3（模态 Dialog / Drawer）**：`--fr-shadow-lg: 0 18px 44px rgba(22, 27, 38, 0.16), 0 2px 8px rgba(22, 27, 38, 0.06)`。

---

### 3.5 动效物理与焦点规范（Emil Design Engineering + Vercel Guidelines）

- **缓动曲线**：
  - `--fr-ease-out: cubic-bezier(0.23, 1, 0.32, 1)`（所有弹出、展开、状态过渡默认曲线）
  - `--fr-ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)`（开关滑块、面板折叠位移）
- **标准时长**：
  - `--fr-duration-instant: 120ms`（按钮按压、微态悬停）
  - `--fr-duration-fast: 160ms`（边框、背景、文字颜色变化）
  - `--fr-duration-normal: 220ms`（抽屉、弹窗、展开收起）
- **微交互原则**：
  - 主按钮与可点击卡片在 `:active:not(:disabled)` 时提供克制的 `transform: scale(0.985)` 物理按压感，不再使用 hover 上浮发光。
  - 严格遵守 `@media (prefers-reduced-motion: reduce)`；绝不声明全局 `* { transition }`。
- **统一焦点轮廓**：
  - `--fr-focus-width: 2px`、`--fr-focus-color: var(--fr-color-brand-strong)`、`--fr-focus-ring: 0 0 0 3px color-mix(in srgb, var(--fr-color-brand) 20%, transparent)`。
  - 键盘 `:focus-visible` 统一使用 `outline: var(--fr-focus-width) solid var(--fr-focus-color); outline-offset: 2px;`（容器边缘内裁切元素使用 `outline-offset: -2px`）。

---

## 4. 分阶段优化路线图（Phased Rollout Plan）

| 阶段 | 范围 | 核心改造内容 | 验证门禁 |
| --- | --- | --- | --- |
| **Phase 1（本轮完成）** | 基础设施与规范 | `PRODUCT.md`、`DESIGN.md`、`src/ui/styles/tokens.css` 完整语义化（亮/暗/字号/圆角/间距/阴影/动效/焦点）、清理或治理旧 `theme.css`、扩展 Storybook Foundations & UI/Examples 规范 | Vitest 皮肤对比度与架构测试 + Storybook 构建校验 |
| **Phase 2（本轮完成）** | Popup 与设置中心（P0） | 重构 `popup.css`（消除渐变/Logo光晕/状态点光晕/极小字号、统一圆角与按压反馈、统一暗色变量）；重构 `settings-page.css` / `settings-sections.css` / `settings-navigation.css` / `settings-controls.css` / `ServiceCatalog` / `SegmentedControl` / `FeatureEnableCard` / `service-badges.css`（统一字号、对比度、表单密度、清理历史覆盖补丁与嵌套阴影） | Playwright `popup,options,services,responsive` 真实截图对比 + Vitest 回归 |
| **Phase 3（本轮覆盖关键对齐）** | 侧边栏与文档/页面组件（P1–P2） | 将 `sidepanel.css`、`document-page.css`、`dialogs.css`、`feedback.css` 对齐统一 Design Tokens（消除文档页背景光斑与独立色板漂移、对齐暗色底色与字体栈）；在 `.agents/skills/fluentread-ui/` 沉淀长期可复用的设计技能规范 | `pnpm compile` + `pnpm build` + Vitest 单元测试 + Playwright 视觉回归 |
| **Phase 4（持续演进）** | 网页/视频/漫画/官网全量深化 | 按 `.agents/skills/fluentread-ui/` 规范逐步完成划词卡细节、视频句级学习、漫画面板及 VitePress 官网暗色模式与组件同步 | 按模块专项 Playwright + Storybook 审查 |

---

## 5. 优化前后关键指标对照（Before vs. After Targets）

| 维度 | 优化前（Baseline） | 优化后（Target） |
| --- | --- | --- |
| 亮色 `--muted` 对比度 | `4.19:1`（白底）/ `3.95:1`（灰底） ❌ | `5.95:1`（白底）/ `5.55:1`（灰底） ✅ |
| 亮色 `--brand-strong` 在 `--brand-soft` 上对比度 | `4.09:1` ❌ | `4.82:1` ✅ |
| 亮色主按钮白字对比度 | `3.60:1`（梯度粉） ❌ | `4.69:1`（纯色 `#d62d5e`） ✅ |
| 侧栏分组标题对比度 | `2.86:1` ❌ | `5.95:1` ✅ |
| 暗色画布统一性 | Popup `#14161b` / Options `#191b21` / Document `#151a23` | 统一 `--fr-color-canvas: #14171c` / `--fr-color-surface: #1c2028` |
| Popup 极小字号（<11px） | 存在多处 `8px`/`9px`/`9.5px`/`10px` | 消除正文/按钮 <11px，核心标签 ≥12px，辅助最小 11px |
| Popup/Options 装饰噪音 | Logo 粉光晕、主按钮渐变+上浮发光、绿点光晕、关于页/文档页径向光斑 | 全部清零，纯色平涂 + 1px 细边框 + 克制按压反馈 |
| Storybook 规范覆盖 | Colors / Surfaces / Typography（基础版） | 新增 Spacing & Radius、Motion & Elevation、Popup & Settings 规范对照 |
