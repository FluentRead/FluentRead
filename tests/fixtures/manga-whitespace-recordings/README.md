# 固定空格识别回放行

本语料保留 32 条实际识别记录、6 个完整已观测 cohort 和 22 张去重的 48 像素高无损 PNG。测试直接调用生产 `createMangaRecognitionWhitespace()`，不加载模型、字体、SDK 私有模块或浏览器，也不访问工作区证据目录。

它验证的是当前控制器的确定性合同，并非模型准确率全绿：旧 20 行中两条 BGR `CABIN04` 恢复为独立真值 `CABIN 04`，原 18 条正确结果不退步；新 12 行保持原文，其中 9 条可评分、6 条正确，`THE RIVERIS CLEAR TODAY`、`POSTCARD FROMTHE FERRY` 和 `雨あがり の市場へ` 仍是明确的已知准确率失败，另 3 条噪声不评分。合计准确率为 26/29，不能把测试通过称为 32 条识别全部正确。

数据按职责分开：

- `truth.json`：先前冻结的独立源文真值；噪声为 `null`。
- `sdk-output.json`：原 SDK 等值文本/置信与已记录的位置附加元数据；旧/新记录的位置来源见下文。
- `replay-expected.json`：source `02804605…` 的当前控制器输出与已知失败，不是新的真值。
- `observations.json`：每帧 `[argmaxIndex, argmaxValue, blankValue, spaceValue]` 充分统计。
- `sparse-dictionary.json`：原字典 SHA 和仅 50 个已观察 ID→字符事实，非第三方完整字典。
- `manifest.json`：原 `N/T/C`、宽度、完整 cohort、原读索引→局部 replay 索引、PNG 与 JSON SHA。
- `provenance.json`：来源和证据边界。所列 evidence ID 只用于追溯，不是运行时路径依赖。

旧 20 行的 text 与 confidence 在原捕获中分别断言与 SDK 输出相等；positions 来自记录的 `projection.emissions`，未保存原 SDK positions 对象，回放只验证这份已记录元数据按引用透传。新 12 行有实际 `sdkRaw`，其文本、置信及位置可逐项核同。此区别不改变任何数值、源真值或当前预期。

旧 20 行共享 10 张原始 resized RGBA；`enhancedRRR` 表示该条 CTC 记录采用的识别输入模式，并不表示 PNG 已做增强。新 12 张是同流程、零模型的原生 Canvas **研究复建** RGBA，9 个历史 NCHW RGB SHA 一致；它们的 alpha 全为 255 仅描述新复建，不证明历史 alpha 字节相同。

完整已观测 cohort 保留原批次成员、稳定宽序和原 readIndex 事实，未加 synthetic companion。回放会按原读序局部重编号。每个 cohort 作为独立 selected-window 页范围，在同一页账本里处理全部行；原整页另外 42 张 RGBA 没有捕获，不能冒称逐字重建整页原索引、原预算消耗或完整页面质量。独立生产单元测试另行覆盖页预算跨 run 不退款等合同。

为调用真实 controller，回放按记录构建有界 NTC surrogate：只填已观察 argmax/max/blank/space，其他类别归零。它不是原始完整 logits，也不证明未保存类别的分布。sparse 字典只用于这些固定统计，不能交给真实模型推理。每个 cohort 的 dense surrogate 在该 cohort 返回后不再持有；最大一批 69,152,160 字节，测试使用单 worker，不能把这等同进程 RSS 上限或性能基准。

PNG 使用固定 RGBA8、非交错、filter0 编码；测试 helper 只接受这个窄格式，校验尺寸、字节上限、CRC、库存 SHA 和解码后 RGBA SHA，再调用生产控制器。数据生成没有重新画字、改 crop、换 batch、挑输出或改真值；所有 32 行均保留。原始外部迁移脚本与来源清单只存测试证据，不是仓库依赖。

运行：`pnpm exec vitest run tests/mangaRecognitionWhitespaceRecordings.test.ts --maxWorkers=1 --minWorkers=1`。
