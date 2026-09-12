# 下拉选择器调整与验证

2026-09-12。基于 `4ddc631887ddb5a2ea6e3e27c35154440f002fd1`，任务分支 `codex/select-ui-refinement-20260912`。

## 交互与覆盖

统一 FluentRead 自有界面的下拉选择器：更轻的边框和阴影、相同的菜单圆角、整行点击区域、浅色选中背景及勾选标记。沿用现有品牌色和皮肤变量，保留已保存的选项值、禁用状态、多选与键盘操作。未借用或修改参考项目。

长列表支持在原选择框直接输入筛选。默认网页翻译服务展开后显示放大镜和“搜索翻译服务”，只有一个搜索输入，输入时实时缩小结果，选中后恢复服务图标及名称；无匹配时显示反馈。机器翻译和 AI 翻译以分组标题区分。

- 设置、Popup、文档、词库、写作与翻译卡片通过共享 `UiSelect` 覆盖；自定义服务和模型菜单使用相同菜单变量。
- 窄语言控件展开时提供至少 220px 的列表（受视口限制），避免长语言名称逐字折行。
- userscript 模板中的 16 个原生选择器全部转换为共享组件；默认配置实际显示 12 个，其余按配置出现。菜单挂载到自己的 closed Shadow Root 中，并位于面板滚动区之外。

## 结果

| 验证 | 结果与范围 |
| --- | --- |
| 生产扩展专项 | 40 项通过，18 张截图，0 个 console/page 错误；真实后台 Edge、临时 profile、第二屏可见且不抢焦点 |
| 搜索与保存 | 唯一输入、无结果、DeepSeek 筛选、方向键/Enter、Escape、外部关闭、关页重开保留服务/语言、多选及移除通过 |
| 主题与宽度 | 1440/820/390px，默认亮/暗与樱花暗色；菜单在视口内，页面无横向溢出，搜索区无重复焦点框 |
| 油猴选择器专项 | 搜索、键盘选中、关闭不保存、数字 0/1 保存并重开、亮暗与 390px 菜单边界、closed Shadow Root 隔离通过，0 个浏览器错误 |
| 油猴既有完整冒烟 | 通过；悬浮/全文翻译—恢复—再翻译、宿主全局隔离、跨页计数与桥接清理均由内存 GM 夹具验证 |
| 相关 Vitest | 8 个文件、709 项通过；涵盖设置架构/保存、词库、i18n、源文件/验证归属及浏览器焦点约束 |
| 类型与构建 | Vue/TypeScript、Chrome/Firefox 生产构建、userscript 构建及产物校验、文档构建通过 |
| 变更卫生 | `git diff --check` 通过；主检出目录保持干净 |

完整扩展 UI 技能套件已在最终 `.output/chrome-mv3` 上运行，但未通过：外部脚本仍等待旧 Popup 标题“让阅读自然地流动 / 翻译功能已暂停”，当前页面标题为“网页翻译”。因此不能把专项成功表述为完整扩展回归成功。

`pnpm test:audit` 仍被基线中未归类的 `tests/userscriptDexieIsolation.test.ts` 阻断；本次没有修改该测试、矩阵或审计器。油猴测试使用 Edge 加载实际构建产物及确定性 GM 接口，不代表 Safari、真实 userscript 管理器或真实供应商质量认证。

选择器专项修改草稿与保存配置；既有油猴翻译冒烟保留独立夹具。分别执行 `scripts/run-userscript-smoke-test.cjs --suite selects` 与 `--suite full`，避免测试状态互相影响。完整命令参数见[测试文档](../../testing.md)。逐项断言与布局数据见 [validation.json](./validation.json)。

## 实际截图

默认服务展开后，原选择框直接搜索：

![单输入服务菜单](./options-service-menu.png)

输入后的匹配结果：

![服务搜索](./options-service-search.png)

樱花暗色、模型整行选项，以及窄语言列表：

![樱花暗色](./service-sakura-dark-1440.png)

![模型列表](./model-picker.png)

![Popup 语言列表](./popup-target-language.png)

![文档语言列表](./document-language-menu.png)

油猴版窄屏、暗色菜单：

![油猴菜单](./userscript-service-narrow.png)
