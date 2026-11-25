# FluentRead 设计原则（Design Principles）

## 1. 核心气质：Editorial Precision（编辑级精准阅读）

FluentRead 是伴随用户每天阅读数小时的工具，界面必须退居内容之后，做到 **简洁、现代、专业、克制、有辨识度**：

1. **中性为底，玫红点睛**
   - 90% 界面由高可读中性纸面（`--fr-color-canvas`、`--surface`、`--surface-soft`）与 1px 发丝边框（`--line`）组成。
   - FluentRead 标志性玫红（`--fr-color-brand` / `--fr-color-brand-action` / `--brand-strong`）只用于：主操作 CTA、当前激活态、开关开启态、键盘焦点与品牌锚点。
   - 同一操作区域只保留 **1 个主按钮**，其余操作使用次级中性按钮或文字链接。

2. **平涂层级，拒绝重阴影与卡片套卡片**
   - 静态设置卡片使用单层 `1px solid var(--line)` + 内部水平分隔线，不把子表单再包进独立圆角阴影卡。
   - `box-shadow` 仅用于真正浮在画布之上的层级：Level 2 浮层菜单（`--fr-shadow-md`）、Level 3 模态对话框与抽屉（`--fr-shadow-lg`）。

3. **同心圆角几何（5 级收敛）**
   - 只使用 5 级圆角 Token：`--fr-radius-xs (6px)`、`--fr-radius-sm (8px)`、`--fr-radius-md (10px)`、`--fr-radius-lg (12px)`、`--fr-radius-full (9999px)`。
   - 内层控件圆角始终 `≤ 外层容器圆角 - 内边距`（例如 `12px` 卡片内嵌 `8px` 控件，`10px` 分段容器内嵌 `6px` 选中块）。

4. **反模板化红线（Impeccable Anti-Slop Rules）**
   - 禁止在功能页面背景、关于页 Hero、文档页画布、主按钮上使用装饰性 `linear-gradient` / `radial-gradient`。
   - 禁止给 Logo 图标加彩色光晕阴影，禁止给状态小圆点加发光扩散环（`box-shadow: 0 0 0 4px ...`）。
   - 禁止在标题左侧添加装饰性竖条（`border-left` / `::before` 彩条）。
   - 禁止使用 `backdrop-filter` 毛玻璃替代清晰的实体背景（易造成跨浏览器性能回退与对比度失控）。

5. **亮暗一致与 13 套内置皮肤兼容**
   - 亮色与暗色均消费 `src/ui/styles/tokens.css` 的单一真相源（暗色画布统一 `#14171c`，表面 `#1c2028`，次级表面 `#232833`）。
   - 组件不硬编码 `#fff` / `#000` / `#172033` / `#737c8f`，确保切换至简约、紧凑、高对比及 10 套传统色皮肤时自动协同。
