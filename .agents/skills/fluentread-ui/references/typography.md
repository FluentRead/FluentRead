# FluentRead 排版与多语言规范（Typography & i18n）

## 1. 字体栈

- **界面默认字体**：消费 `var(--interface-font-family)`（由 `src/ui/styles/interface-font.css` 声明，系统原生优先：macOS SF Pro / PingFang SC、Windows Segoe UI / Microsoft YaHei），严禁在局部 CSS 中硬编码 `Inter` 覆盖用户界面字体偏好。
- **等宽字体**：消费 `var(--fr-font-mono)`，用于快捷键 `kbd`、API 端点、模型 ID、代码片段与日志详情。

## 2. 7 级可读字号阶梯

| Token | 尺寸 | 推荐字重 | 行高 | 适用场景 |
| --- | --- | --- | --- | --- |
| `--fr-text-2xl` | `24px` | `700` | `1.3` | 关于页、文档落地页主标题 |
| `--fr-text-xl` | `18px` | `600` | `1.35` | 服务详情标题、抽屉标题 |
| `--fr-text-lg` | `15px` | `600` | `1.4` | 设置分组标题（`SettingsGroup`）、弹窗标题 |
| `--fr-text-md` | `14px` | `500 / 600` | `1.5` | 表单输入值、Popup 品牌名、阅读正文 |
| `--fr-text-base` | `13px` | `500 / 600` | `1.5` | 设置项标签、侧栏导航、主操作按钮 |
| `--fr-text-sm` | `12px` | `400 / 500` | `1.55` | 辅助说明、表单帮助、Popup 快捷卡标题、次级按钮 |
| `--fr-text-xs` | `11px` | `500 / 600` | `1.4` | **绝对最小底线**：徽标、快捷键、版本号、小计数、分组标签 |

### 强制排版规则

1. **禁止 `<11px` 文本**：不再使用 `8px`、`9px`、`9.5px`、`10px`、`10.5px` 渲染任何可见界面文字（汉字在 <11px 下极易糊笔划）。
2. **标准整数像素与标准字重**：只使用整数像素和 `400 / 500 / 600 / 700` 标准字重，避免 `520 / 650 / 760` 在非可变 CJK 字体上产生跨平台不一致跳变。
3. **等宽数字**：版本号、翻译计数、权重百分比、进度、页码、时间轴必须设置 `font-variant-numeric: tabular-nums`，避免数字更新时水平抖动。
4. **标题平衡换行**：宽幅展示标题使用 `text-wrap: balance`。

## 3. 多语言防溢出契约

FluentRead 支持 `zh-CN`、`en-US`、`ja-JP`、`ko-KR`、`fr-FR`、`ru-RU`、`es-ES`。法语、俄语与德/西语常见文案长度可达中文的 1.8×–2.4×：

- 弹性/网格文本子项必须设置 `min-width: 0`。
- 长标签与 URL 使用 `overflow-wrap: anywhere` 允许安全换行；仅在明确需要单行槽位的默认 320px Popup 卡片上使用 `text-overflow: ellipsis` 并配合 `title` / Tooltip 展示完整内容。
- 按钮与分段选项不要锁死 `height` 与 `white-space: nowrap`（除明确单行工具栏外），优先使用 `min-height` 允许两行自然伸展。
