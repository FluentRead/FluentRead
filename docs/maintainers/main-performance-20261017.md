# main 性能与生命周期审查（2026-10-17）

## 基线与范围

固定基线：`877ee77b5e3c905f6cc016db63633342dceb2419`。这是开始实施时获取的 main；本批独立于阅读外观 PR #1016。

按入口、功能、纯算法、共享服务、平台边界和集成建立生产代码清单，再沿实际调用链检查热点及生命周期。静态清单覆盖 `src`、`entrypoints`、`userscript`、`integrations` 下 1,134 个代码文件、222,189 行，识别 17,181 个函数/方法/回调节点。包含 2 个生成资源和 4 个声明文件；Vue 的函数数来自提取的 script，CSS 不做函数计数。HTML 壳、静态资源、文档和测试另由构建及归属审计检查。

**这是全仓范围扫描与定向深入审查，不是 1,134 个文件逐行人工审计，也不能证明没有 bug。** 下表的计数是清单覆盖，不代表每个函数已人工验证。

| 生产模块 | 文件 | 函数/回调节点 |
| --- | ---: | ---: |
| `entrypoints` | 16 | 3 |
| `integrations` | 11 | 157 |
| `src/app` | 129 | 1755 |
| `src/core` | 175 | 1782 |
| `src/features/area-translation` | 14 | 87 |
| `src/features/document-translation` | 31 | 1279 |
| `src/features/floating-ball` | 7 | 120 |
| `src/features/full-page-translation` | 61 | 1114 |
| `src/features/glossary` | 4 | 93 |
| `src/features/hover-translation` | 2 | 50 |
| `src/features/image-translation` | 59 | 1106 |
| `src/features/information-highlight` | 16 | 177 |
| `src/features/input-translation` | 6 | 130 |
| `src/features/local-translation` | 8 | 136 |
| `src/features/local-tts` | 7 | 112 |
| `src/features/model-usage` | 5 | 121 |
| `src/features/page-notice` | 3 | 35 |
| `src/features/paragraph-copy` | 3 | 22 |
| `src/features/personal-corrections` | 5 | 66 |
| `src/features/quick-translation` | 3 | 27 |
| `src/features/reading-assistant` | 20 | 257 |
| `src/features/section-translation` | 5 | 121 |
| `src/features/selection-translation` | 23 | 544 |
| `src/features/self-help` | 1 | 30 |
| `src/features/settings` | 106 | 2149 |
| `src/features/share-card` | 7 | 52 |
| `src/features/site-rules` | 1 | 0 |
| `src/features/translation-center` | 3 | 113 |
| `src/features/translation-stats` | 4 | 99 |
| `src/features/video-subtitle` | 67 | 1432 |
| `src/features/vocabulary` | 36 | 582 |
| `src/features/writing-assistant` | 18 | 212 |
| `src/platform` | 49 | 645 |
| `src/providers` | 51 | 495 |
| `src/services` | 76 | 1332 |
| `src/shared` | 10 | 41 |
| `src/ui` | 43 | 227 |
| `userscript` | 49 | 478 |

### 人工重点与缺口

- 全文/悬浮/区域：检查队列、会话、变更观察、属性批处理、路由取消、请求缓存/批量、共享 scheduler；全文 runtime、broker 的大型编排只检查关键路径，未逐行审完
- UI/设置：检查入口、popup/settings 状态、菜单点击与异步写入、文档阅读锚点；没有对全部 106 个 settings 文件和所有视觉状态逐一执行浏览器验收
- 平台/网络/持久化：深入阅读 80 个文件、部分阅读 13 个，检查配置权威/安全存储、缓存、预算、transport、身份与事务；其余分配范围文件只完成清单及自动化门禁覆盖
- 文档/图片/视频/offscreen：深入阅读 46 个文件、部分阅读 6 个，重点是任务归属、取消、队列、资源释放和本地模型边界；各站点适配、全部二进制解析器和模型运行路径仍有人工覆盖缺口
- 学习/写作/词书/userscript/Obsidian：重点检查 stream cleanup、后台 handler、材料存储、DOM scanner、取消/重试、GM HTTP/storage 和集成输出；未逐一执行每个第三方系统和网站
- 不包含真实供应商调用、模型下载/推理、真实站点矩阵、原生 IndexedDB 多进程压力测试；fake-indexeddb 结果不能替代原生浏览器结果

## 本批修改与可复现证据

### 1. 阻塞请求队列避免重复全量扫描

`requestScheduler.ts` 在资源、配置、时间边界均未改变时复用等待前沿，追加只检查新项；取消通过槽位摘除，并在公平性、期限或限速可能影响后续任务时保守重扫。保留同步首次启动、跨服务旁路、同 bucket FIFO、真实 HTTP attempt、transport lease、配置动态投影、deadline 和 Retry-After 语义。

初始固定基线 4,000 个等待任务：入队身份读取 8,006,001 次、取消 8,002,000 次；最终版本分别为 4,001 和 0 次（纯并发阻塞场景）。可移植基准的 5 次测量中位数：入队 1,574.560 → 6.753 ms，取消 1,651.348 → 47.105 ms。此指标不是所有调度场景的复杂度保证：限速、公平性、配置变化仍会重扫，配置签名也有自身开销。

### 2. 文档阅读位置不变时复用待译顺序

文档 translator 新增可选的进程内 `priorityKey`，相同不可变标识复用游标；标识变化重排全部未领取原文组及其重复位置。未提供标识的调用者保持逐批排序。DocumentApp 标识覆盖 PDF 页映射、全文长度和实际阅读锚点，翻页/跨段滚动仍及时调整剩余任务。

固定基线、每批 16 段、确定性即时 gateway、1 次预热与 5 次测量：10,000 段候选访问 3,130,000 → 10,000；队列 CPU 中位数 913.023 → 24.794 ms；两版都是 625 次请求且译文相同。5,000 段为 216.068 → 10.223 ms。这些数据来自下述可移植基准脚本，是当前云环境的局部 CPU 样本，不是网络或完整用户操作耗时承诺。

### 3. 素材批量导入/迁移复用事务内计数

容量计数只在同一 read-write transaction 的首个合法新身份写入前读取一次，成功新增后递增；更新、无效输入和重复身份不消耗新增容量。上限仍为 10,000，回滚、clear generation、别名冲突和备份协议不变。

128 个新增材料：`count()` 128 → 1。新用例在固定基线出现 5 个工作次数断言失败，在修改后通过；不把测试计数优化描述成原版容量溢出修复。独立真实 9,999 条记录的 fake-indexeddb 双连接并发导入仍停在 10,000；第二次写入失败回滚全部新增，重试重新计数。

### 4. 右键菜单拒绝失去归属的点击快照

既有点击路径已复用已确认状态，本批只补上文档归属和值一致性检查，覆盖活动标签查询、原生写入队列和每个菜单项的异步边界。导航、关闭或更新状态后，旧快照不能继续写菜单。已经发出的原生写入无法取消，后续串行刷新会修正实际状态。

原版在真实 click listener 回归中 49 通过、5 失败；修复后相关 162 项通过。曾评估直接复用广播以省查询，但广播缺少充分的文档来源证明，已撤回，因此**没有 IPC 次数下降的声明**。

### 复现

使用锁定依赖与仓库既有资源保护脚本：

```sh
pnpm test tests/translationRequestScheduler.test.ts tests/documentTranslationApi.test.ts tests/documentAppLifecycle.test.ts tests/materialRepository.test.ts tests/contextMenuRuntimeOwnership.test.ts
node scripts/testing/benchmark-main-performance-20261017.cjs
pnpm test:regression:all
```

[最终快照基准原始结果](./assets/main-performance-20261017.json)包含运行环境、源文件哈希、5 次样本及输出一致性断言结果。

基准脚本需要 Git 中保留上述基线提交，读取两版实际 TypeScript 实现；不发出供应商请求。性能用例优先断言工作次数、输出和顺序，墙钟时间只作为测量结果。

## 三轮代码审查

每轮均检查修改上下文与调用方，审查发现后的修改重新核查受影响部分；第一轮、第二轮、第三轮由不同审查者承担。以下角色标识对应本次相互独立的代码审查，不是三次重复运行同一命令。

| 批次 | 第一轮：实现正确性 | 第二轮：上下游/状态 | 第三轮：性能/异常 |
| --- | --- | --- | --- |
| 调度器 | 平台/存储审查者：全调度控制流、配置投影、真实 lease；发现时钟回退及取消后的限速唤醒缺陷 | 统筹审查者：broker、冻结 request snapshot、AI transport attempt/response、计数/槽位/期限；独立复跑具体反例 | 设置/状态审查者：FIFO 与限速交错、空闲尾部；发现提前取消后遗漏将来 timer |
| 文档 | 平台/存储审查者：去重、领取、提交、重试与取消 | 统筹审查者：完整队列调用链、阅读锚点全部输入、兼容旧调用者；联合相关 350 项测试 | 设置/状态审查者：188 项测试和独立两版 trace，对比批量/单段/AI/fallback/章节重复/取消 |
| 素材 | 平台/存储审查者：完整事务与身份规则、双连接 9,999 条并发和失败回滚 | 媒体/文档审查者：导入/迁移失败、meta 回滚、重试和 clear，43 项测试 | 翻译生命周期审查者：事务内计数、更新不占容量、边界/回滚/clear，43 项测试 |
| 菜单 | 平台/存储审查者：runtime/clicks/updater/state/query 全调用链 | 统筹审查者：已确认快照来源、活动页/文档/设置/队列归属，联合相关 350 项测试 | 媒体/文档审查者：127 项测试，原生写入中断与后续修复 |

调度器审查中特别补足：不带 Retry-After 的 503 读取时钟后回退；取消最早 deadline 后撤销旧 timer；被 FIFO 遮蔽的模型限速在取消前/后恢复；无新请求、无释放动作、只推进时间的空闲尾部；配置/时钟读取回调同步入队或取消时必须完成重入重扫。持续有新活动的随机差分可能掩盖遗漏 timer，不能用随机通过替代这些确定性反例。

最终生产快照（SHA-256，三轮审查后冻结）：

| 文件 | SHA-256 |
| --- | --- |
| `src/services/translation/requestScheduler.ts` | `18f7f38e4c68f548900e29a2a5221f67e7a137837c8230d02784de72f04df48f` |
| `src/features/document-translation/services/translation.ts` | `37ec202e3e6dea1821a0d27f0fac263e3d9148b3b58aff8cd8f80db55a4bdb19` |
| `src/app/document-translation/DocumentApp.vue` | `e342a5775480e529e8847a48eaad7891793bbc82a73637cdb914236c92f25d67` |
| `src/features/vocabulary/materialRepository.ts` | `4794c327862cd39222b78311630df59982f88fede8e893c706b70c20e281b178` |
| `src/app/background/contextMenuRuntime.ts` | `d955f41ea519c809f1f685602e5767527aeae73e249b53fffae989c0bd9f4170` |
| `src/app/background/contextMenuUpdates.ts` | `5744616f3aac49621646bcc4c773842922e51b5ddf492bbb8cbe6caca07a54a0` |

调度器最终重新审查包含 70 项定向测试（四维覆盖率均 100%）、96 个独立时间/lease/deadline 场景，以及配置和时钟回调重入的取消/追加顺序反例。曾建议删除的 timer 分支被实际重入反例否定；先修复重入归属，再凭不变量移除真正不可达分支，没有添加覆盖率忽略或降低门槛。

完整回归追加发现菜单 runtime 超出既有 142 行上限；未提高门槛，将相同状态捕获闭包移至既有菜单更新模块，runtime 降至 140 行。修正后重新完成三轮：平台/存储审查者核查实现与 AST 等价，统筹审查者核查 click → store → query → native 队列及方法绑定，媒体/文档审查者核查性能与异常/导航/写入中断，并以 6 组轻量探针复验。6 套邻接与架构测试共 177 项通过，表中两个菜单哈希为该次重新审查后的快照；其余四个生产文件及五个测试未变。

另做六个生产文件的联合交叉审查：文档排序继续进入相同 broker/scheduler，素材缓存只属于事务，菜单只影响显示归属；不更改消息协议、设置 schema、权限、依赖、workflow、并发/批次限制或重试预算。

## 验收状态

本节保留草稿创建时的验证快照；后续完整验收与 CI 终态以 [PR #1019](https://github.com/FluentRead/FluentRead/pull/1019) 的最新验收记录为准。

完整验收进行中，当前仅作草稿交付。早期运行因第三轮发现 scheduler 缺陷主动中断（exit 130）；冻结快照的第二次运行已通过测试归属审计、WXT prepare 和类型检查，之后在完整 Vitest/覆盖率阶段因执行环境中断未取得终态，不计作通过。2026-10-17 01:35 UTC 已核对全部生产/测试文件哈希不变且没有遗留活跃进程，重新启动完整流水线；完整测试、全局覆盖率、各端构建与远端 CI 结果待补齐。真实浏览器和在线供应商验收仍未执行。

## 已确认但留待独立处理

1. 使用量小时桶与时区：UTC 写入后换为 Asia/Kolkata 读取，累计量存在而按小时图可能漏计；已有小时聚合无法精确拆成半小时，需先定义历史桶迁移/重分桶策略。本批不改变已有用户统计
2. 视频本地转录 cancel-before-start：没有当前 owner 时先取消，之后同 tab/stream/generation 的请求仍可能进入 offscreen。真实 handler 顺序已复现；自然浏览器消息重排频率尚未证明。需独立增加 tombstone 且保证旧 cancel 不影响新 owner，未混入本批

以上是已观察到的边界，不代表清单以外路径不存在其他问题。
