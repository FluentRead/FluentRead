---
name: fluentread-ui
description: FluentRead 官方 UI/UX 设计体系与工程实践技能。编写、重构或审查 Popup、设置中心、侧边栏、文档阅读器、悬浮球、划词卡片、视频字幕、漫画面板及 Storybook 组件时使用，确保视觉一致、WCAG 2.2 AA 可读性、克制动效与多语言/亮暗/皮肤全兼容。
---

# FluentRead UI Design & Engineering Skill

本 Skill 是 FluentRead 产品设计体系（`PRODUCT.md`、`DESIGN.md`、`src/ui/styles/tokens.css`）在日常开发与评审中的可执行规范。所有界面改动遵循 **Editorial Precision（编辑级精准阅读）** 方向，融合 Impeccable（反模板化审查）、UI UX Pro Max（语义 Token 架构）、Emil Design Engineering（动效物理）与 Vercel Web Design Guidelines（无障碍与表单工程质量）。

## 技术栈边界（强制）

- 保留 **Vue 3 + Element Plus + TypeScript + WXT 0.21**，不引入 React、Tailwind 或额外 UI 框架。
- 样式必须消费 `src/ui/styles/tokens.css` 中的语义变量，禁止散落硬编码十六进制色值或私有暗色画布。
- 内容脚本 UI 必须使用 Shadow DOM 隔离和 `fr-*` / `fluent-*` 专属前缀，卸载时释放全部监听与观察器。

## 开始任何 UI 改动前

1. 明确当前所属界面面（Popup / Options / Sidepanel / Document / Content Shadow UI / Docs）。
2. 先读取对应参考文档：
   - 视觉方向、品牌克制与反模板化红线：[references/design-principles.md](references/design-principles.md)
   - 组件复用、容器层级与 Element Plus 约束：[references/component-guidelines.md](references/component-guidelines.md)
   - 字号阶梯、CJK/Latin 混排与多语言安全边界：[references/typography.md](references/typography.md)
   - 动效曲线、微交互物理与状态反馈：[references/interaction.md](references/interaction.md)
   - WCAG 2.2 AA 对比度、键盘焦点、ARIA 与触屏预算：[references/accessibility.md](references/accessibility.md)
3. 参照标准组件模板：[examples/settings-section-example.vue](examples/settings-section-example.vue) 与 [examples/popup-drawer-example.vue](examples/popup-drawer-example.vue)。

## 提交前自查清单（Pre-Ship Gate）

- [ ] **无硬编码漂移**：全部文字、表面、边框、圆角、间距、动效与微渐变均使用 `--fr-*` 或共享语义别名（`--ink` / `--muted` / `--line` / `--surface` / `--surface-soft` / `--brand` / `--brand-strong` / `--brand-soft` / `--fr-success-indicator`）。
- [ ] **无背景与动效噪音**：无主画布径向光斑、无 Logo 彩色光晕、无按钮 hover 上浮跳动、无全局 `* { transition }`；默认皮肤主按钮与状态灯统一消费 Token 化的轻盈微渐变与柔光圈，传统色皮肤继续纯色平涂。
- [ ] **分层可读性与对比度**：无 `<11px` 文本；常规正文/说明 ≥12px；文字对比度在 `--surface` 与 `--surface-soft` 上均 ≥4.5:1，图形图标（`--brand`）≥3.0:1，主按钮白字 ≥3.5:1。
- [ ] **双主题 + 全皮肤 + 多语言**：在浅色、深色、代表性皮肤（`default` / `minimal` / `contrast` / `xuanqing`）及 `en-US` 长文案下无横向溢出、无裁切。
- [ ] **键盘与无障碍**：所有可见交互控件有可访问名称、可见 `:focus-visible` 轮廓、正确 `aria-pressed` / `aria-expanded` / `role="switch"`，且响应 `prefers-reduced-motion: reduce`。
- [ ] **验证通过**：运行相关 Vitest（含 `tests/designSystemTokens.test.ts`、`tests/interfaceSkinReadability.test.ts`、`tests/settingsUiArchitecture.test.ts`）、`pnpm storybook:typecheck` 及隔离浏览器截图验收。
