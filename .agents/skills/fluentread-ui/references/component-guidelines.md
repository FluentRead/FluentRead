# FluentRead 组件使用指南（Component Guidelines）

## 1. 优先复用现有共享原语

新增或重构界面前，优先复用既有组件，不要重复造轮子：

| 场景 | 标准组件 | 路径 |
| --- | --- | --- |
| 下拉选择（单选/多选/搜索） | `UiSelect` | `src/ui/components/UiSelect.vue` |
| 图标 | `UiIcon` / `ServiceIcon` | `src/ui/components/UiIcon.vue`, `ServiceIcon.vue` |
| 模块总开关卡 | `FeatureEnableCard` | `src/ui/components/FeatureEnableCard.vue` |
| 模型/语言包下载进度 | `DownloadProgress` | `src/ui/components/DownloadProgress.vue` |
| 设置二级分组容器 | `SettingsGroup` | `src/features/settings/ui/components/SettingsGroup.vue` |
| 单条设置行（标签+说明+帮助+控件） | `SettingsItem` | `src/features/settings/ui/components/SettingsItem.vue` |
| 可折叠次要配置组（保留状态与草稿） | `SettingsDisclosure` | `src/features/settings/ui/components/SettingsDisclosure.vue` |
| 2–4 项互斥选项 | `SegmentedControl` | `src/features/settings/ui/components/SegmentedControl.vue` |
| 延迟/长度/数值输入 | `SettingsNumberInput` | `src/features/settings/ui/components/SettingsNumberInput.vue` |
| 页内/分组紧凑导航 | `settings-subnavigation` | `src/features/settings/ui/components/settings-navigation.css` |

## 2. 设置中心布局约定

- 禁止在 `SettingsSections` 中新增旧式 `<el-row>` / `<el-col>` 拼装设置行；统一使用 `SettingsGroup` + `SettingsItem`。
- 补充解释文案放在 `SettingsItem` 的 `help` 属性中（由 `FieldHelp` 呈现），保持主行简洁可扫读。
- 常驻表单使用单列阅读宽（`--settings-content-width: 1080px`）；服务目录、翻译中心、学习中心保留全宽工作区，并在内部管理独立滚动区（外层视口不滚动）。
- 任务弹窗与确认框统一继承 `src/ui/styles/dialogs.css`：取消按钮只做取消，不承载二次提交；次要技术详情用原生 `<details class="fr-dialog-disclosure">` 按需展开。

## 3. Popup 320px 布局约定

- 桌面宽度由 `--interface-popup-width`（默认 `320px`）与多语言本地化宽度决定，高度由内容撑开且上限 `560px`（`max-height: 560px; overflow-y: auto`）。
- 高频流程固定为单列清晰秩序：品牌头（含侧栏/设置直达）→ 主翻译卡（语言对 → 当前服务摘要 → 翻译主按钮 + 局部按钮 → 站点规则 + 显示工具）→ 2×2 快捷入口 → 紧凑页脚。
- 抽屉（`popup-quick-drawer` / `popup-services-drawer`）优先呈现开关与直观操作示意，长配置统一通过底部链接跳转 Options 对应分区。

## 4. Element Plus 使用边界

- 局部组件样式优先覆盖 Element Plus CSS 变量（`--el-color-primary`、`--el-border-color`、`--el-bg-color` 等），避免大面积 `!important` 覆盖。
- 独立复用的设置控件包裹在 `.fr-settings-controls` 中并引入 `settings-controls.css`，确保与 Options 外观与 Storybook 预览完全一致。
