# FluentRead 设计原则（Design Principles）

## 1. 核心气质：Luminous Editorial Precision（澄明轻盈的编辑级精准）

FluentRead 是伴随用户每天阅读数小时的工具，界面既退居内容之后，又保持清透明快的现代气质，做到 **澄明、轻盈、专业、有辨识度**：

1. **中性为底，亮玫点睛，按角色分层控明度**
   - 90% 界面由高可读中性纸面（`--fr-color-canvas`、`--surface`、`--surface-soft`）与 1px 轻盈边框（`--line`）组成。
   - 图形图标（快捷入口图标、局部/显示模式图标）与开关开启态直接消费与 Logo 一致的 `--fr-color-brand`（`#ef4776`），避免图标发暗割裂。
   - 小字品牌文本与链接使用 `--fr-color-brand-strong`（`#d4235a`），严格守住 4.5:1 文本可读性。
   - 状态指示灯独立消费 `--fr-success-indicator`（`#24b47e` / 暗色 `#34d399`）与 `--fr-success-indicator-ring`，不复用偏暗的文字成功色 `--fr-success`。
   - 同一操作区域只保留 **1 个主按钮**，其余操作使用次级中性按钮或文字链接。

2. **清晰层级，克制呼吸感**
   - 静态设置卡片使用单层 `1px solid var(--line)` + 内部水平分隔线，不把子表单再包进独立圆角阴影卡；默认皮肤主卡片可使用极轻 `--fr-shadow-xs` 增加白底透气感。
   - 默认皮肤主按钮消费 `--fr-color-brand-action-gradient` 与 `--fr-shadow-brand-action` 呈现轻盈柔光质感；浮层菜单与模态对话框使用 `--fr-shadow-md` / `--fr-shadow-lg`。

3. **同心圆角几何（5 级收敛）**
   - 只使用 5 级圆角 Token：`--fr-radius-xs (6px)`、`--fr-radius-sm (8px)`、`--fr-radius-md (10px)`、`--fr-radius-lg (12px)`、`--fr-radius-full (9999px)`。
   - 内层控件圆角始终 `≤ 外层容器圆角 - 内边距`（例如 `12px` 卡片内嵌 `8px` 控件，`10px` 分段容器内嵌 `6px` 选中块）。

4. **精准反模板化边界（Anti-Slop Rules）**
   - 禁止在功能页面背景、关于页 Hero、文档页画布使用装饰性 `radial-gradient` 光斑。
   - 禁止给 Logo 图标加彩色光晕阴影，禁止在 hover 时把按钮向上顶起（`translateY(-1px)`）。
   - 禁止在标题左侧添加装饰性竖条（`border-left` / `::before` 彩条）。
   - 禁止使用 `backdrop-filter` 毛玻璃替代清晰的实体背景（易造成跨浏览器性能回退与对比度失控）。
   - 10 套中国传统色皮肤（`data-interface-skin-kind="palette"`）与简约/高对比皮肤必须保持 100% 纯色平涂，不得继承默认皮肤的渐变或指示灯外圈。

5. **亮暗一致与 13 套内置皮肤兼容**
   - 亮色与暗色均消费 `src/ui/styles/tokens.css` 的单一真相源（暗色画布统一 `#14171c`，表面 `#1c2028`，次级表面 `#232833`）。
   - 组件不硬编码 `#fff` / `#000` / `#172033` / `#737c8f`，确保切换至简约、紧凑、高对比及 10 套传统色皮肤时自动协同。
