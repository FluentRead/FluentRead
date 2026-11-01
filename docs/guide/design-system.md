---
title: 设计系统与组件预览
description: 查看流畅阅读的颜色、字体与真实 Vue 组件，比较不同主题和屏幕尺寸下的交互。
---

# 设计系统与组件预览

在组件展示站中查看配色和字体，操作真实的下拉框、开关和设置卡片，并比较浅色、深色及不同皮肤。

<a class="bv-button bv-primary" href="/storybook/?path=/docs/foundations-colors--docs" target="_blank" rel="noopener noreferrer">打开组件展示站 →</a>

## 如何使用

1. 在左侧选择分区或组件，打开说明页或单个示例。
2. 在顶部切换主题、皮肤或组件语言。示例说明和演示文案保留原语言。
3. 在 **Controls** 面板调整禁用状态、图标尺寸或进度等参数。
4. 切换 Popup、Mobile 或 Desktop 视口，检查文字换行和布局，再用鼠标或键盘操作。

| 分区 | 内容 |
| --- | --- |
| Overview | 展示站介绍 |
| Foundations | 主题颜色、文字对比度、字体、圆角和阴影 |
| UI | 下拉框、开关、折叠卡片、进度、图标、按钮和弹窗 |
| Examples | 使用真实设置卡片的组合示例，包括长文案和窄屏 |

预览不读取或修改扩展设置，不调用翻译服务，也不下载模型或字体。未安装的字体会使用系统回退字体。完整功能请在扩展中体验。

<details class="guide-details">
<summary>参与界面开发</summary>

## 参与界面开发

在仓库根目录安装依赖并启动展示站：

```sh
pnpm install --frozen-lockfile
pnpm storybook
```

打开终端显示的地址，默认 `http://127.0.0.1:6006`。示例位于 `storybook/`，配置位于 `.storybook/`；复用 `src/ui/components/` 和 `src/ui/styles/` 中的组件与样式。

### 卡片与信息层级

- 设置页直接显示页内导航或内容，页面名称由侧栏、窄屏分类和辅助技术标题提供。
- 设置卡片复用 `SettingsGroup`、`SettingsItem`、`SettingsDisclosure`，位于 `src/features/settings/ui/components/`。颜色和密度使用 `src/ui/styles/tokens.css` 中的共享变量。
- 常用设置保持展开，次要设置可以折叠；待配置、失败等影响使用的状态留在折叠摘要中。折叠时保留草稿，请求与保存仍由调用方管理。
- 标题说明集中在同一区域，一个操作区使用一个主按钮。技术说明放进帮助入口。
- 任务弹窗和操作确认共用 `src/ui/styles/dialogs.css`：正文在窗口内滚动，底部操作始终可达，格式、完整差异等次要信息按需展开。取消按钮只取消，不承载另一种提交方式。
- 独立设置控件使用 `settings-controls.css` 和 `fr-settings-controls` 容器，复用开关尺寸、触摸区域和键盘焦点样式。
- 检查深色、窄屏、长文案、键盘焦点，以及展开后再次收起的草稿状态；主要文案允许换行，避免增加影响阅读的动画或滤镜。

构建与检查：

```sh
pnpm storybook:typecheck
pnpm docs:build:site
pnpm storybook:check
pnpm docs:check
pnpm docs:preview
```

`docs:build:site` 将展示站输出到文档产物的 `storybook/` 子目录。通过本地文档入口预览，GitHub Pages 使用同一份产物发布。

</details>

## 参考与来源

展示顺序参考 [Read Frog Storybook](https://storybook.readfrog.app/?path=/docs/foundations-colors--docs)，组件和样式使用流畅阅读自身的 Vue、Element Plus 与 Vite 实现。工具说明见 [Storybook Vue 与 Vite 文档](https://storybook.js.org/docs/8/get-started/frameworks/vue3-vite)。
