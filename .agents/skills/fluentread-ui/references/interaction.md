# FluentRead 动效物理与交互工程（Interaction & Motion）

> 基于 Emil Design Engineering 与 Vercel Web Design Guidelines，确保每次交互响应干脆、物理自然、零性能负担。

## 1. 标准动效 Token

| Token | 值 | 适用场景 |
| --- | --- | --- |
| `--fr-ease-out` | `cubic-bezier(0.23, 1, 0.32, 1)` | 绝大多数 UI 状态过渡、菜单展开、弹窗进入、箭头旋转 |
| `--fr-ease-in-out` | `cubic-bezier(0.77, 0, 0.175, 1)` | 开关滑块位移、面板原位切换 |
| `--fr-duration-instant` | `120ms` | 悬停色变、边框反馈、按压缩放 |
| `--fr-duration-fast` | `160ms` | 选项切换、下拉焦点、折叠箭头 |
| `--fr-duration-normal` | `220ms` | 抽屉滑入、模态对话框显隐 |

## 2. 微交互工程规则

1. **按压确认，而非悬停上浮**
   - 主按钮、快捷卡片与可点击图标按钮在 `:active:not(:disabled)` 时应用克制的 `transform: scale(0.985)`（图标按钮可至 `0.96`），提供明确的触觉确认。
   - **禁止**在 hover 时把按钮向上顶起（`translateY(-1px)`）并放大发光阴影。
2. **仅动画化低成本属性**
   - 只对 `transform`、`opacity`、`color`、`background-color`、`border-color`、`box-shadow`（谨慎）做过渡。
   - **严禁**声明全局 `* { transition: ... }` 或 `transition: all`。
3. **遵循用户减少动画偏好**
   - 任何带 `transition` 或 `animation` 的新样式都必须确保在 `@media (prefers-reduced-motion: reduce)` 下退化为无动画，并尊重扩展内 `config.animations` 开关。

## 3. 表单与状态诚实原则

- **永不拦截输入**：数字或配置输入框不吞掉按键，而是实时或失焦给出清晰的语义错误提示（`--fr-danger`）。
- **明确区分状态**：
  - 翻译按钮未翻译（`--fr-color-brand-action` 实心）与已翻译（`--brand-soft` 轻底 + 细边 + `aria-pressed="true"`）在视觉与语义上必须截然不同。
  - 服务目录左侧点击只切换「正在配置」对象，不隐式改写「当前默认服务」。
- **单一失败恢复路径**：网络或配置失败时，展示简短原因 + 一个主要恢复动作（如「配置服务」或「重试」），技术细节收进原生 `<details>`。
- **滚动边界隔离**：独立滚动面板（服务列表、下拉菜单、抽屉内容）必须设置 `overscroll-behavior: contain`，防止滚到底部带动宿主页或父容器滚动。
