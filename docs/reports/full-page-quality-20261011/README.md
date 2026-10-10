# 全文翻译性能与交互优化验收

日期：2026-10-11。基线：`origin/main` 的 `fe7005dd9`。本地分支：`codex/full-page-quality-20261011`。

## 改进结果

- **减少动态页面的重复调度。** 同一个 MutationObserver 回调内，复用属性变化影响根的 owner 快照，并合并每个 owner 的 class/style 延迟复验。合成段、应用壳和非布局属性仍走即时边界检查；源文、状态或 DOM 写入会使快照失效；排时前检查当前会话、连接状态和 state 身份。
- **结果提示准确。** 悬浮球订阅全文翻译已有的权威工具栏状态：处理中显示静态省略号，成功显示勾选，失败显示感叹号。活动会话始终可恢复原文；按钮名称包含本地化结果信息。
- **入口显隐与会话分开。** 隐藏悬浮球保留正在阅读的译文；重新显示时读取当前结果。站点名单隐藏入口时保留紧凑状态提示。总开关关闭、恢复原文和页面生命周期仍由全文会话负责清理。
- **隔离迟到状态和订阅回声。** 同步订阅采用有限队列，隔离订阅者异常，抑制当轮写入者回声；失效实例、旧会话和过期后台通知不会覆盖当前状态。
- **保持油猴体积预算。** 标准版管理器元数据的图标复用既有固定提交资源，页面工具继续内嵌 PNG；两份图片逐字节一致，standalone 的元数据仍内嵌。最终产物 1,979,720 字节，低于原 1,986,000 字节预算。

没有引入站点特例、跨仓库依赖、供应商协议变化或配置开关；此次未借用参考项目代码。性能协调逻辑提取到 feature 内的 `attributeMutationBatch.ts`，主运行文件有效行数为 2189，仍低于现有 2196 上限，架构和覆盖率阈值未降低。

## 性能证据

真实全文运行时的受控测试包含 120 个已有译文 owner、80 次不同兄弟节点的 class/style 变化，以及 `observedAttributes: null` 的关系规则。

| 同一检查点内的操作 | 修改前 | 修改后 |
| --- | ---: | ---: |
| owner 集合复制 | 80 | 1 |
| 500ms 定时器创建 | 9720 | 240 |
| 旧定时器清除 | 9480 | 0 |

修改后的 240 个定时器包含 120 个尾部复验和 120 个首次边界检查。基线实测由同一回归用例先失败、修改后通过得到；完整计数见 `mutation-scheduling.json`。这是操作次数证据，不代表所有网站的总 CPU、翻译网络延迟或端到端提速比例。

## 自动验证

| 验证范围 | 结果 |
| --- | --- |
| 属性调度、边界、优先级、重挂载、合成段及模块边界 | 7 文件、468 测试通过 |
| 状态订阅、悬浮球和进度交互 | 111 测试通过 |
| 原生批量与 broker 时限；content 生命周期；快捷配置切换 | 分别 31、140、5 测试通过 |
| 完整 architecture 分组 | 33 文件、1593 测试通过 |
| 测试归类 audit | 638 文件、10407 声明用例，唯一归类检查通过；这是登记检查而非全量测试执行 |
| 新属性协调模块与状态通知模块 | statements / branches / functions / lines 均 100% |
| 类型检查、Chrome / Firefox / userscript 构建 | 通过 |
| userscript verifier 与扩展 manifest verifier | 通过 |

各组存在重叠，不能把计数相加当成独立测试总数。覆盖率 JSON、架构原始日志、manifest 与油猴验证日志均在本目录，汇总见 [verification.json](./verification.json)。性能回归可运行 `pnpm test tests/fullPageVisibilityScheduling.test.ts tests/translationStability.test.ts tests/fullPageAttributeBoundary.test.ts tests/fullPagePriority.test.ts tests/architecture/moduleBoundaries.test.ts tests/fullPageRemountPreparation.test.ts tests/syntheticCandidateFreshness.test.ts`。

严格覆盖率证据仅针对被测模块及新增路径，不宣称所有悬浮球拖拽、漫画功能或整个仓库达到 100%。此前两个原生批量翻译测试夹具问题已在未修改基线复现；本次仅同步 Microsoft 第六参数断言及保留 catalog 实际导出的 partial mock，未修改供应商实现。

## 真实浏览器

使用生产 Chrome MV3 扩展、临时 Edge 131.0.2903.147 profile、`macos-background-cdp`、`launchservices-no-foreground`、第二屏正常窗口和 `browserFrontmost=false`；浏览器关闭和临时目录清理均确认完成。

- [交互专项报告](./status-browser/report.json)：12 个场景通过，包含加载与全部失败不显示成功勾选、局部重试成功、入口隐藏保留原有译文节点、重挂载读取已有结果、站点隐藏保留紧凑提示、总开关恢复原文、取消后迟到响应隔离、再次翻译，以及 390px / 深色 / 英文结果和可操作失败面板。成功勾选使用实际样式和几何可见性检查。
- [完整机制回归报告](./lifecycle-browser/report.json)：翻译—恢复—再翻译、宿主按钮/富文本、动态正文、Shadow DOM、连续 hover、同源重挂载、同值属性稳定、失败说明与重试、悬浮 UI 和离屏任务显隐均通过；46 次确定性请求，外部意外请求和控制台异常均为零。
- [供应商边界报告](./provider-browser/report.json)：19 个场景通过。DeepL / Azure / Google Cloud 的数组恢复与原子缓存使用合成响应；六段页面的 `6 → 0 → 6` 使用真实快捷键和合成 Azure 响应。Google 六项和 Microsoft 五项联网小样本的批量/逐条结果一致。Microsoft 字面实体样本仍受上游语义破坏影响，本次验收确认安全拒绝、保留原文，没有声称修复供应商。

已人工检查加载、窄屏成功和窄屏失败截图：状态标记可辨认，失败面板、重试与定位按钮在视口内。截图保存在对应报告子目录。

可复现入口：`scripts/testing/run-full-page-status-test.cjs`、`scripts/run-full-page-translation-test.cjs --verify-floating-ui`、`scripts/testing/run-native-batch-live-test.cjs --live --full-page`。传入生产扩展目录、Playwright 根目录、focus-safe helper、证据目录和 `--background`；最后一项会发送已知测试句子到 Google / Microsoft 公网服务，其余页面与供应商均受控。

受控页面和供应商响应验证机制与交互；Firefox 构建不等于 Firefox 运行时证明，小样本联网验证不等于所有供应商、账户、设备和网站的完整保证。

## 本地交付

主工作目录保持原样。改动保留在独立工作树，未上传分支、创建 PR、合并或发布。
