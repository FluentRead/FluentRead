# FluentRead 可访问性规范（Accessibility）

> 所有扩展页面与注入组件默认满足 **WCAG 2.2 AA** 与键盘全流程可达标准。

## 1. 色彩对比度门禁

- **主正文（`--ink`）** 在 `--surface` / `--surface-soft` 上：≥ `10:1`（当前亮色 `17.23:1`，暗色 `14.69:1`）。
- **辅助文字（`--muted`）** 在 `--surface` 与 `--surface-soft` 上：均 ≥ `4.5:1`（当前亮色 `5.95:1 / 5.55:1`，暗色 `7.31:1 / 6.61:1`）。
- **品牌文字（`--brand-strong`）** 在 `--surface` 与 `--brand-soft` 上：≥ `4.5:1`（当前亮色 `5.28:1 / 4.82:1`，暗色 `6.87:1`）。
- **主按钮白字（`#ffffff`）** 在 `--fr-color-brand-action` 上：≥ `4.5:1`（当前亮色 `4.69:1`，暗色 `4.54:1`）。
- **语义反馈色（`--fr-success` / `--fr-warning` / `--fr-danger` / `--fr-info`）**：在对应 `-soft` 底色和中性表面上均 ≥ `4.5:1`，且不得只靠颜色传递状态（需辅以文案或图标）。

## 2. 键盘导航与统一焦点轮廓

- 统一焦点样式：
  ```css
  :focus-visible {
    outline: var(--fr-focus-width, 2px) solid var(--fr-focus-color, var(--brand-strong));
    outline-offset: 2px;
  }
  ```
- 位于 `overflow: hidden` 裁切边缘内的交互项（如内嵌折叠标题、侧栏窄项），使用 `outline-offset: -2px` 或 `-3px`，防止焦点框被裁掉。
- 使用 `:focus-visible` 而非裸 `:focus`，避免鼠标点击产生多余焦点框，同时保证键盘 Tab 焦点 100% 清晰可见。
- 抽屉、弹窗和下拉菜单支持 `Escape` 关闭，关闭后焦点可靠回到触发元素。

## 3. 语义化 HTML 与 ARIA

- 图标按钮、隐藏文件输入（`visually-hidden`）、搜索框必须具备明确的 `aria-label` 或关联 `<label>`。
- 装饰性 SVG 必须标记 `aria-hidden="true"`。
- 开关使用 `role="switch"` + `:aria-checked`；切换按钮使用 `:aria-pressed`；导航激活项使用 `:aria-current="active ? 'page' : undefined"`；分段选择使用 `role="radiogroup"` + `role="radio"` + 方向键循环导航。
- 实时反馈提示使用 `role="status"`（`aria-live="polite"`），错误提示使用 `role="alert"`（`aria-live="assertive"`）。

## 4. 触屏与高对比模式

- 粗指针（`@media (any-pointer: coarse)`）及 Firefox Android 容器内，核心交互目标保持 `≥ 44px`（Popup 预留 `46px`）命中尺寸，输入框字号 `≥ 16px` 避免 iOS Safari 自动放大。
- 支持 `@media (forced-colors: active)`，不因背景渐变、阴影或自定义遮罩丢失边框与文字。
