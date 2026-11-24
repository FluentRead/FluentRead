# 文档上下文与篇章一致性评估

更新日期：2026-11-18  
状态：source-evidence 检索有合成单文档试跑；真实材料有 OWID 探索性对照、PLOS 论文 / PostgreSQL 技术文档的段落级受控上下文矩阵，以及 MDN Promise、PostgreSQL 18、Kubernetes StatefulSet、Node.js v22.20.0、三篇独立科学论文摘要和 TICO-19 十八个来源文档的受控对照。新增 TICO-19 文档顺序语料含 1,996 条对齐文本行；其上下文实验按相邻对齐行解释，并将输出敏感性与质量判断分开。技术文档测试把上下文差异、代码字面量保留和实际输入成本纳入同一受控矩阵；2026 EMNLP 方法研究也提示“显示全文”与“记录篇章判断”需要分开验证。另有来源证据问答候选 v1（4 文档、24 任务、0 执行）。MDN AbortSignal 新增固定版本的完整仓库 Markdown 英中候选及分语言词面位置数据；未生成新模型请求。长文档翻译质量和用户收益仍无人工评估证据。

v61 已把 TICO-19 官方 dev 的 12 篇文档、36 条目标对齐行用于配对上下文敏感性试跑：无上下文与加入同文档前后相邻英文对齐行，两条件、三模型、每格双重复，共 432 次请求；431 次 HTTP 200，35B 一次 HTTP 504，未自动重试。对齐行可能含多句。归一化后上下文改变输出的有效配对数为 2B 68/72、9B 54/72、35B 62/71；这些是字符串敏感性数据，不证明质量提升。双语评审、参考分数和模型排名仍为 0。[v61 摘要](../../../workspace-data/evidence/translation-benchmark-tico19-dev-context-ablation-20261116/summary-v1.md) · [上下文敏感性与重复性诊断](../../../workspace-data/evidence/translation-benchmark-tico19-dev-context-ablation-20261116/context-comparison-diagnostics-v1.json) · [v61 结构校验](../../../workspace-data/evidence/translation-benchmark-tico19-dev-context-ablation-20261116/manifest-validation-v61.json)

2026-11-16 新增 TICO-19 dev 完整对齐语料：12 篇文档共 934 行、20,716 个空格分词源词；其中保留了与 v61 相同的 36 个目标。针对这 36 个目标追加“同文档其余全部英文对齐行”条件，提示模板和目标文本与 v61 相同，目标行不再放入上下文；三模型共 108/108 HTTP 200。逐字变化对无上下文：2B 33/36、9B 31/36、35B 30/36；对邻接行：2B 30/36、9B 30/36、35B 27/35（一个 v61 的 35B r1 基线失败）。Bilibili 回报每模型 87,132 个 prompt tokens，合计 261,396；中位 API 延迟 0.40/0.88/1.52 秒。这些是输入成本和响应表现，变化率只说明模型依赖上下文范围，不代表译文更好。单独的来源页 URL 元数据未发送，但五个嵌在原文行中的 URL 字符串有 27/108 次随源文进入请求；词面计数和链接处理说明见[传输边界说明](../../../workspace-data/evidence/translation-benchmark-tico19-dev-full-document-corpus-20261116/transmission-boundary-clarification-v1.md)。COVID-19 与 SARS-CoV 的表面保留计数亦不是术语准确率；没有术语进入记忆，没有评分、双审或排名。[全文语料摘要](../../../workspace-data/evidence/translation-benchmark-tico19-dev-full-document-corpus-20261116/summary-v1.md) · [v2 运行和配对敏感性摘要](../../../workspace-data/evidence/translation-benchmark-tico19-dev-full-document-corpus-20261116/full-document-context-paired-summary-v2.md) · [逐目标诊断](../../../workspace-data/evidence/translation-benchmark-tico19-dev-full-document-corpus-20261116/full-document-context-sensitivity-diagnostics-v2.json)

此前一次文档批量输出试跑在 8 次请求后停止：2B 的两格没有翻译目标原文，9B/35B 的六格返回 504；这些调用封存并排除。单目标 v2 先通过最大的文档试点，再完成全 108 格；全文语料仍只对 36 个目标有模型输出。[废弃试跑审计](../../../workspace-data/evidence/translation-benchmark-tico19-dev-full-document-corpus-20261116/aborted-document-context-run-v1.md)

另新增 [TICO-19 dev 自动参考诊断](../../../workspace-data/evidence/translation-benchmark-tico19-dev-full-document-corpus-20261116/automatic-reference-diagnostics-v1/context-reference-diagnostics-v1.md)：对相同的 36 个目标、12 篇来源文档计算 chrF2，并以文档为单位做成簇 bootstrap。完整文档条件有 108/108 次成功输出，基线条件有 431/432 次成功；9B 的完整文档上下文相对邻接行上下文 chrF2 差值为 −2.24（95% 区间 −3.50 至 −0.87），其余配对差异因模型而异。该结果只是待审 TICO dev 参考上的字面相似度，不是质量分；样本不在 TICO 论文列出的第二轮 QA 文档中，参考和译文仍待本项目双语评审。[机器可读指标与数据完整性检查](../../../workspace-data/evidence/translation-benchmark-tico19-dev-full-document-corpus-20261116/automatic-reference-diagnostics-v1/context-reference-diagnostics-v1.json) · [复现脚本](../../../workspace-data/evidence/translation-benchmark-tico19-dev-full-document-corpus-20261116/automatic-reference-diagnostics-v1/compute-reference-chrf2-v1.py)

## 当前产品流程

`src/services/translation/context/discourse.ts` 在单篇材料内维护有界的段落来源和已有译文，并为下一段挑选可核对的上下文证据。当前上限为 256 个块、64,000 个源字符、最多 64 对译文，单次序列化参考最多 2,400 字符。证据类型区分定义、相邻段、章节开头、先前机器译文和用户确认译文；提示协议标明用户 glossary/确认译文/机器译文的优先级，并警告机器译文可能错误、不要合并不同词义或臆造指代。

这套代码完成的是**受限证据检索与请求生命周期管理**，不是通用文档理解模型：它不会自行确认实体关系、摘要正确性或翻译事实；OCR/正文抽取仍属于上游流程；模型是否正确利用送入的上下文还需另行评估。

## 当前试跑

- [合成长文档 fixture](../../tests/fixtures/discourse-context-long-article.json) 有 21 段、4 章和 7 个目标检查，包含跨章缩写异义、人物指代、未决说话者和把恶意句子当作翻译数据等场景。[本次检索试跑](../../../workspace-data/evidence/translation-document-context-retrieval-pilot-20261114/README.md) 直接调用当前 `createDiscourseContext()`：6 个带正向证据标签的检查命中 9/9 个必需证据块，受控的跨章节缩写负例没有导入前章定义，7/7 结果都没有未来块泄漏且未超过 2,400 字符预算。

该 fixture 同时用于现有单元测试，因此这是对当前算法和一份合成 fixture 的描述性核查，不是独立文档集。runner 没有 commit 先前机器译文或用户确认译文，也没有注入 glossary，只测静态 source evidence。最后的 `page-data-boundary` 检查没有“相关证据”金标准；本次看到了两个同章邻段，但不能仅凭该来源断定它们有用或有害。报告里将它们标为未标注，不把它们计成 precision 错误。

另有[OWID 收入分类文章单段上下文试跑](../../../workspace-data/evidence/translation-document-context-owid-bilibili-api-20261114/summary.md)：对一个 276 字符目标段，用同一 Bilibili 35B 模型比较无上下文、源文定义、源文定义加先前机器译文三种提示，3/3 返回 HTTP 200。上下文条件改变了译文用词；只有无上下文译文保留了 `（GNI）`。这是可供后续人工判断的差异证据，不是质量分或上下文效果结论。该试跑直接调用 API，没有运行当前 discourse 检索器或浏览器 broker；此前机器译文也没有经过人审。

2026-11-15 新增[两文档受控上下文消融](../../../workspace-data/evidence/translation-document-context-controlled-multidocument-bilibili-api-20261115/summary.md)：PLOS 生物系统建模论文与 PostgreSQL 18 文档各选 3 个目标段，三模型 × 六目标共 18 格；每个上下文请求复用对应结构化无上下文 payload，只在目标段前插入两个同文档源文块。18/18 返回 HTTP 200，18/18 均通过“删除唯一上下文块后还原为基线提示”检查，非上下文请求字段 18/18 相同；输出字面变化 18/18。结构诊断为 JSON 有效 16/18、目标 ID 保留 16/18、section 原样保留 11/18。离线恢复模拟修正 5 个 section 值，且 16/16 translated-text 哈希未改变，显示产品可以把元数据恢复和语义翻译分开处理。这些结果不说明上下文改善语义或用户体验。

论文和 PostgreSQL 候选包原有的 9 格上下文矩阵采用了另一套上下文条件提示，整体改写任务说明，不满足单因素消融。现有数据继续作为工作流包探索保存；严格比较只使用新的 `controlled-source-context-v1` 条件，后续新增运行必须保留相同提示正文、模型参数和目标段，只改变上下文块。

2026-11-15 又在 MDN `Using promises` 候选上做了[文档级 bundle 上下文试跑](../../../workspace-data/evidence/translation-document-context-mdn-promises-controlled-bilibili-api-20261115/summary.md)：选 3 个相互关联的段落作为同一目标 bundle，三模型 × 无上下文/同文档上下文共 6 格。两条件只差在提示中是否插入同一份 source-context block；上下文输出 3/3 JSON 有效、3/3 保留所有 ID 和 `kind`，文字也都不同于基线。这个实验是文档任务的一个样本 bundle；三个段落共同构成一个输入，不能计为三个独立统计单位。它使用研究者指定的上下文块，不是 FluentRead discourse 检索器的效果测量。

随后在同一 MDN bundle 上做了[重复目标输入控制](../../../workspace-data/evidence/translation-document-context-mdn-promises-repetition-control-bilibili-api-20261115/summary.md)：无上下文、相关源文上下文、重复已出现在目标 bundle 中的目标段三条件，三模型 × 每条件两次，共 18 格；新增 12 次调用全部 HTTP 200。每个条件都保留同一目标、结构化输出提示和请求参数。相关上下文与重复块都为 401 字符，但 Bilibili 报告的输入量为 470 与 460 tokens；因此这是字符匹配，不是精确 token 匹配。18/18 输出保留 JSON、ID、`kind` 与非空译文。2B/9B 两次输出哈希相同，35B-A3B 两次哈希不同；这是有限的重复性信号，不是质量或随机性区间。该实验仍只覆盖一个文档级 bundle，不包含人审、目标参考、glossary、图像或当前产品检索器。

同日还在 PostgreSQL 18《Transaction Isolation》的 `Read Committed` 并发更新段做了[三条件重复控制](../../../workspace-data/evidence/translation-document-context-postgresql-repeat-control-bilibili-api-20261115/summary.md)：复用原结构化基线与相关上下文首轮结果，再新增 12 次请求，得到 3 模型 × 3 条件 × 2 次运行。上下文和重复块都为 1,333 字符，但 Bilibili 报告相关上下文为 696 tokens、重复目标为 711 tokens。18 条输出中 16 条 JSON 有效、16 条 ID 精确，只有 4 条原样保留 `section`。重复运行哈希在 2B/9B 的三臂相同，在 35B-A3B 的三臂不同。该结果提供跨第二篇技术文档的格式、输入量和有限重复性证据，仍没有人评或语义质量结论。

2026-11-15 又在 Kubernetes StatefulSet 官方技术文档上运行[上下文 × 本地术语保护 2×2 控制](../../../workspace-data/evidence/translation-memory-document-context-k8s-statefulset-controlled-bilibili-api-20261115/summary.md)：固定 6 个目标段和 3 个同文档上下文段，三模型 × 四条件 × 两次，共 24 格；22/24 首轮 HTTP 200，两格 35B-A3B 的上下文 + 术语保护请求均为 504，原样重试后仍失败。22/22 个成功响应保留严格 JSON 和目标 ID/kind，但 2B 上下文 + 术语保护的两次输出都在同一目标段缺少一个保护标记；9B 该条件 2/2 回填完整。上下文 prompt tokens 中位数为 540→612（无术语保护）和 733→805（有术语保护），仅是输入成本/延迟信号。7 条映射与官方简中候选均未审定；本实验没有上下文质量分，也未运行 discourse 检索器或浏览器 broker。

同日新增[arXiv 自适应机器翻译摘要的前缀上下文试跑](../../../workspace-data/evidence/translation-document-context-arxiv-adaptive-mt-controlled-bilibili-api-20261115/summary.md)：目标为摘要后六句，context-on 只加入前三句，三模型 × 两条件 × 两次共 12 格，12/12 HTTP 200。严格 JSON / ID/kind/text 为 10/12；两次 2B 无上下文输出都因模型名 `gpt-3.5-turbo` 周围未转义引号而失败。离线精确转义候选将这两条输出恢复为结构完整数组，但原始严格失败仍保留；这只是语法恢复诊断。严格合同下 4/6 个同模型配对可比较，其中 23/24 个目标段字面变化；纳入受限转义诊断后 6/6 配对可比较、35/36 个目标段文本不同。context-on prompt tokens 中位数为 732，context-off 为 581。结果仅为输入、格式和字面差异信号；一个摘要 bundle、两次重复、没有译文质量或篇章一致性人评，也没有测试当前检索器。

产品评估应保留两条通道：原始 provider 响应的严格结构合同，以及带明确修复规则的本地恢复候选。即便一个可追溯的引号问题能被机械修正，也不能把修复后的数组回填成“原始 JSON 通过”；模型、上下文和输出格式三个维度应分别记录。

另在 PLOS Computational Biology《Surrogate modeling of Cellular-Potts agent-based models》摘要上做了[同设计的独立论文复现](../../../workspace-data/evidence/translation-document-context-plos-cpm-unet-controlled-bilibili-api-20261115/summary.md)：后四句作目标、前三句作上下文，三模型 × 两条件 × 两次共 12 格，HTTP 与严格 JSON/ID/kind/text 合同均为 12/12；6/6 配对可比较，22/24 个目标段字面不同。prompt tokens 中位数为 409→559。与 arXiv 摘要分开报告：两份独立论文的格式信号不同，当前样本仍不足以对科学论文整体下结论；PLOS 的字面变化同样不是质量证据。

随后在 Node.js v22.20.0《Asynchronous context tracking》技术文档上做了[三段 API 定义的前文上下文对照](../../../workspace-data/evidence/translation-benchmark-nodejs-async-context-bilibili-api-20261115/summary.md)：三模型 × 无/有对应前文 × 两次重复，共 36 格。首轮请求因本机 DNS 未解析而没有到达服务，36 条失败原样保存；独立网络尝试 36/36 HTTP 200。18/18 个精确配对可比较，16 对目标译文字符串变化；96/96 个预先枚举的代码字面量保持。三个模型的 prompt tokens 中位数均从 context-off 110 增至 context-on 255。此样本展示了一个具体产品风险/机会：上下文开关应同时展示来源范围和实际成本，技术模式还应独立显示代码标识符校验；这些结果不证明语义更准。目标段都嵌套在一篇文档中，单篇统计单位；35B-A3B 有一次约 18.6 秒的耗时尾值，应保留在延迟分布里，不代表稳定服务水平。[受控设计与原始运行](../../../workspace-data/evidence/translation-benchmark-nodejs-async-context-bilibili-api-20261115/experiment-design.json) · [逐次评估](../../../workspace-data/evidence/translation-benchmark-nodejs-async-context-bilibili-api-20261115/retry-network-authorized-1/evaluation-report.json)

2026-11-16 新增 [TICO-19 对齐行上下文消融 v2](../../../workspace-data/evidence/translation-benchmark-tico19-data-expansion-20261116/context-consistency-v2/summary.md)：从 18 个来源文档整理出 1,996 条有序英中对齐行，另有 104 条 CMU 医疗短语排除在文档统计外。每篇选 3 个有前后相邻对齐行的目标，在同一提示骨架中比较显式无上下文与前后各一行，三模型共 324 格，全部 HTTP 200。该上下文样本中的 54 行，经筛查确认 7 行本身包含多个句子边界，因此原始请求的“句子”措辞只作为历史协议保留；当前结果按邻行上下文敏感性解释。复算后各模型均为 41/54 对输出字面变化、13 对不变；prompt token 中位数为 121→204.5。结果没有判定译文更好或跨句一致性更高。来源、参考、URL 和许可信息均未随模型输入发送；1,044 项文件证据检查无结构问题、0 条准入。此前单句试点的 71 次 DNS 失败单独保存，不计入此矩阵。双语评审仍按用户安排暂缓。

两篇论文各已准备一个离线盲态配对评审页：评审者看到完整标题与摘要，A/B 次序随机，模型与上下文条件映射保存在权限受限的 sidecar；六对输出/文档仍按一篇论文作为统计单位。静态检查未发现模型、条件或请求 ID 泄漏，也不加载远程脚本；浏览器交互和人工评审都尚未进行。arXiv 页面把两条受限引号转义结果仅用于显示译文文本，格式失败仍单列。正式分发使用版本化 HTML，不发送整个证据目录或身份映射。[arXiv 盲审页](../../../workspace-data/evidence/translation-document-context-arxiv-adaptive-mt-controlled-bilibili-api-20261115/blind-review-b10378ee65ecefad6e14c9760d2b1877.html) · [PLOS 盲审页](../../../workspace-data/evidence/translation-document-context-plos-cpm-unet-controlled-bilibili-api-20261115/blind-review-1df39c2932051611da6a486c4427c849.html) · [评审包说明](../../../workspace-data/evidence/translation-document-context-scientific-blind-review-20261115/README.md)

v58 新增[AbortSignal 技术文档候选](../../../workspace-data/evidence/translation-benchmark-mdn-abortsignal-reference-candidate-20261116/summary.md)及 108 格待执行消融：9 个目标段 × 3 个模型 × 两个同文档源文条件 × 双重复。条件只改变是否将同页其余 8 个英文段落作为源文上下文；两组都只把目标段作为翻译目标，不发送中文参考、术语候选、URL 或评审意见。片段覆盖 aborted/reason 状态、取消方法、事件和 fetch 响应体读取边界，供后续一致性与技术语义评审。AbortSignal 中文页的 `l10n.sourceCommit` 与英文源提交精确一致，但 `AbortSignal.any()` 参考候选出现重复措辞；这是待审数据标记，不是质量结论。本机 DNS 解析失败，108 次请求均未发送。[矩阵与来源/参考哈希](../../../workspace-data/evidence/translation-benchmark-mdn-abortsignal-reference-candidate-20261116/study-design-v1.json) · [v58 主清单与校验](../../../workspace-data/evidence/translation-benchmark-main-manifest-v58-mdn-abortsignal-localization-candidate-20261116/summary-v58.md)

## 质量评估设计

### 篇章判断的构念效度检查

ACL Anthology 的 2026 EMNLP 研究以 English→Korean 数据比较隔离片段 SEG、同一系统输出的完整文档 DOC 与跨系统拼接的 MIX。作者报告 18,420 条专业标注和 14 个自动指标；在该 ESA 设置下，DOC/MIX 的评分、系统排序和错误标注接近，但单独的盲态正向控制中，评审者在 87.3% 的配对里识别出更一致的 DOC。论文明确限定语言对、ESA 协议和 MIX 扰动范围。[论文摘要与正式 PDF](https://aclanthology.org/2026.emnlp-main.540/)。这是我们评估工具的风险提示，不能外推为英→简中或 MQM 的效果结论。

v30 又登记了 ACL 2026 摘要级候选 [Exploring the Impact of Document Context on LLM-based Machine Translation Evaluation](https://aclanthology.org/2026.findings-emnlp.1839/)。其摘要报告：文档上下文对自动评估的影响会因测试集而异，输入重复本身也可能解释部分表面增益；它研究的是评估器，不是 FluentRead 翻译器。该候选的六次 Bilibili 输出只用于论文文本候选，不是论文方法的复现，也没有人工评分。基于此，评估器侧的后续消融应把**是否提供文档上下文**与**输入重复控制**分开，并固定参考文本可用性、推理模式和模型配置，按测试集/文档簇报告结果。

翻译器上下文实验也要控制输入量：在同一个模型、目标段和提示下，至少配对无上下文、相关源文上下文、仅重复目标输入的等长控制；必要时再加等长但不相关的同文段落，测上下文污染。记录每臂实际 token 数和重复跨度，不能把多发了一遍相同文字造成的差异归因于“理解了篇章”。

评审者看到完整文档时，还需填写一条明确的**篇章一致性判断**并回链相互关联的段落/跨度。新增的[评审 JSON Schema 草案](./translation-document-consistency-annotation.schema.json)规定 `document_consistency_score`（1–5）、`cross_segment_issue_links[]`（两端 `segment_id` / target span、现象、严重度）和不暴露真实条件名的 opaque `blind_condition_code`。SEG / DOC / MIX 映射保存在私有分析 sidecar，双审结束前不与评审记录合并。将一致性轴与段落准确度、自然度、完整度分开报告；此轴要在双语试标后校准，不与现有总评维度相加。

正式比较加入盲态配对控制：从质量相近的输出构造 DOC/MIX，保持源段顺序和界面一致；先用独立强制选择题确认操纵确实可被感知，再检查常规评分、错误跨度和显式一致性轴能否记录差异。MIX 主要探测跨系统词汇、实体和语域不一致；另加同一系统内的指代错误或术语漂移挑战，覆盖 MIX 无法制造的内部错误。报告一致性冲突检出率、连贯文档误报率、DOC/MIX 配对分布与文档簇 bootstrap 区间；先做盲态试标与仲裁，再决定是否进入正式模型比较。

要把“检索正确”和“上下文让译文更好”拆开，至少需要两层：

1. **Evidence routing**：双语/领域标注者针对目标段落，把候选前文标为 `required`、`helpful`、`irrelevant`、`contradictory` 或 `sensitive/out-of-scope`。分别计算 required-evidence recall、helpful precision、contradictory/irrelevant exposure、章节/材料隔离及上下文预算内覆盖。段落是定位单位，文档是统计单位。
2. **Translation impact**：在相同目标段、模型、提示、词库、分段和运行设置下，配对比较：仅目标段、相邻段、章节定义、当前产品检索证据、人工裁定的 oracle evidence；章节摘要另列条件。每种条件都保存实际发送上下文的文本哈希、来源块 ID、token 数、运行时间和错误状态。

评审者始终看到完整源文和同一组候选译文；模型只收到该实验条件指定的上下文。盲审分别评估含义准确、指代/实体、定义和缩写、否定/数量、上下文矛盾、自然度及接受性，并要求错误跨度回链源文。另报告 critical/major 错误文档数、延迟/费用/覆盖和上下文污染；不能把 context-on 后措辞改变本身当作收益。

机器摘要必须单独评估其忠实度和来源；若摘要由模型生成，需保留摘要来源和错误，并设置“摘要传播错误”的负向案例。先前机器译文只能作为可疑证据，不得当成 gold；用户确认的译法与术语库条目要另外记录其来源和作用域。

## 下一阶段数据要求

- 在现有 PLOS / PostgreSQL 段落级严格配对和 MDN 文档 bundle 试跑之外，继续扩展独立文档，覆盖跨段指代、同形缩写异义、章节内定义、跨章实体重名、相互矛盾的前文、没有必要上下文的负例和超预算文档；记录文档版本、语言方向、许可、块位置、证据 ID 和人工依据。
- 对现有 fixture 补齐 `page-data-boundary` 的邻段相关性标注；不要把当前算法输出直接写成 gold。
- 先在相同模型上做配对上下文层级，再单独比较模型。PLOS/PostgreSQL 原矩阵每单元仅一次运行；MDN 控制实验覆盖一个文档 bundle，PostgreSQL 控制实验覆盖一个目标段。应继续扩展独立来源和上下文现象，不能把同一文档内的段落或复本当作独立文档样本。
- 在双审和仲裁后才报告上下文带来的翻译差异。当前试跑调用了模型但没有人工评审，不能说明系统级质量收益。

产品界面应以紧凑的“本次依据”状态显示章节上下文、确认译法、词库命中数及来源；上下文应作为可单独关闭的输入块组合到原任务提示，不能通过整体重写任务提示来隐式启用。用户可展开核对、关闭上下文或修改记忆作用域。超出边界的页面内容、未来段落和其他项目材料不能静默混入请求。

## Funmilayo 漫画连续页上下文候选

主清单 v52 新增 UNESCO 2014 漫画连续印刷页 11–20：10 个页级单元、18 个目标文本区域；第 10 页另有两个仅供上下文使用的文本区域。已准备每页同一批目标区域的仅当前页/前页英文源文上下文两种条件、三模型和双重复矩阵，共 120 格，15 项请求隔离与运行状态检查通过。模型输入不含页图、中文参考、术语候选、来源 URL 或目标页以后的文字。

这是待执行的上下文敏感性设计，不是篇章理解或一致性质量分。页级源文本只有一次视觉转录；第 13 页被遮挡的约鲁巴语黑板文字被排除。断点续跑器会先检查路由，仅发往 Bilibili 官方端点；连续三次网络错误即暂停。当前 DNS 预检失败，0 次翻译 POST、0 条模型输出。人工转录复核与双语质量评审仍按用户安排暂缓。[设计与传输摘要](../../../workspace-data/evidence/translation-benchmark-funmilayo-comic-expansion-20261116/summary.md) · [已准备矩阵与隔离校验](../../../workspace-data/evidence/translation-benchmark-funmilayo-comic-expansion-20261116/bilibili-matrix-setup-validation-v1.json) · [逐次路由探测记录](../../../workspace-data/evidence/translation-benchmark-funmilayo-comic-expansion-20261116/bilibili-transport-attempts-v1.jsonl)

## React 状态更新跨页上下文候选

[Queueing a Series of State Updates](../../../workspace-data/evidence/translation-benchmark-react-queueing-reference-candidate-20261116/summary.md)与已登记的 React State as a Snapshot 页面共享 `react-docs` 项目范围，并由页面链接形成明确的前后文关系。它为后续对照提供 13 个固定段落，可比较无上下文、前置状态快照段和整页上下文；当前仅记录设计候选，没有上下文 API 请求、人工评分或质量提升结论。文档仍是唯一统计单位，参考译文先经过双语裁定再进入正式比较。

## React State Structure 与跨文档理解候选

[Choosing the State Structure](../../../workspace-data/evidence/translation-benchmark-react-state-structure-reference-candidate-20261116/summary.md)新增状态派生、冗余、互相矛盾状态、对象去重和扁平化段落，并关联 React 更新对象、状态快照和更新队列文档。可作为后续文档理解试验的材料：模型只看段落、给相关前页定义、或给完整文档上下文，再比较是否保留状态间关系、否定条件、引用术语和数据结构约束。当前仅准备了源文/候选参考；这些实验尚未运行，译文未双审，不支持上下文改善结论。

## React 状态结构页面的文档理解候选

[Choosing the State Structure](../../../workspace-data/evidence/translation-benchmark-react-state-structure-reference-candidate-20261116/summary.md)让后续试验可以检查模型是否理解“从 props 或现有 state 推导”“不镜像会更新的 props”“对象重复导致 UI 失同步”“扁平化需要同步更新父级与根表”等跨段关系。后续可比较无上下文、当前小节上下文、关联 React 前页上下文和整页上下文；现在只有源文/候选参考数据，没有模型输出或人评结论。

## React 四页状态管理 cohort v1

v49 将 Updating Objects、State as a Snapshot、Queueing State Updates、Choosing the State Structure 放入同一个 React 项目来源组，共 4 篇文档、44 个源文目标段。每篇仍以文档为统计单位。页面源文和候选中文各自固定版本，但快照页、对象更新页与 2026 年两篇新页的 revision 不同；正式实验必须把每条上下文块的来源页、版本、段落哈希一并记录，不能把当前线上页面默认为同一时点快照。

这组数据适合测试从局部句段到跨页理解的层级：state 快照与事件处理、对象不可变更新、批处理/队列顺序、状态派生与归一化。建议后续先由双语/领域评审者在不看译文的情况下，将候选上下文块标为 `required`、`helpful`、`irrelevant`、`contradictory` 或 `sensitive/out-of-scope`；只有审定为源文证据的块才能进入受控输入。页面标题关系或术语候选本身不能自动证明上下文相关。

建议固定目标段与提示，配对比较无上下文、同页相邻源文、关联 React 页源文三种条件；任何目标段、语言方向、模型、分段或术语设置变化都应另开实验。请求只传英文源文块，不传候选中文参考或术语候选。评审时分别记录语义准确、状态关系/条件/否定、代码字面、跨页术语、文档一致性和可读性；文档作为统计单位汇总。提示 token、格式有效率、字面变化只作为成本/运行/敏感性指标，不作为质量收益。

当前四页的中文文本仍是未仲裁候选；Queueing 有代码字面替换线索，其他页面的历史审批也不能替代本项目逐段双审。新建的 [跨页上下文候选矩阵](../../../workspace-data/evidence/translation-document-context-react-cross-page-candidate-20261116/summary.md) 从四页各选 2 个目标，保留 15 个同页相邻块和 16 个跨页源文块；提出 target-only / 同页 / 关联页三臂 × 三模型 × 双重复，共计划 144 次。请求包已冻结，10 项 source-only 隔离审计通过；首格本地提交因 DNS 解析失败而未到达 HTTP，0 次服务端响应、143 格未发送且未重试。上下文关系仍待独立标注，目标译文与术语候选均排除在请求外；没有人工质量分或模型排名。[运行摘要与隔离审计](../../../workspace-data/evidence/translation-document-context-react-cross-page-candidate-20261116/bilibili-context-run-v1/run-summary-v1.md) · [请求隔离审计](../../../workspace-data/evidence/translation-document-context-react-cross-page-candidate-20261116/bilibili-context-run-v1/request-isolation-audit-v1.json) · [v49 数据与分组](../../../workspace-data/evidence/translation-benchmark-balanced-source-expansion-20261115/summary-v49.md) · [React 文档候选 intake](../../../workspace-data/evidence/translation-benchmark-technical-reference-intake-20261116/v8/summary-v8.md) · [一致性标注 Schema](./translation-document-consistency-annotation.schema.json)


## TICO-19 全文上下文的 934 行覆盖扩展

完整语料扩展后，12 篇文档的 934 行都进入了三模型批量首轮：121 批 × 3 模型，363/363 次请求。首轮能映射的译文行为 855（2B）、817（9B）、857（35B）；严格格式候选分别为 0、665、857。2B/9B 的可恢复格式偏离、8 个无效行批次和 24 次 HTTP 错误都在覆盖报告中单独列出。由于它不是 v2 单目标提示，不能与早期矩阵做配对比较。

对 273 个缺口另做单目标全文上下文修复，272 次返回译文；响应哈希通过的 271 条加入独立候选。一次截断响应和一次响应文件哈希不匹配均没有进入候选。最终每模型可核验候选覆盖为 933/934、933/934、934/934。输出格式、API 可用性、候选覆盖和译文质量应分别显示；此处没有语义评分或一致性人工标注，不能据此判断长文上下文改善了翻译。原文 URL 字符串可能出现在模型输入中（批量首轮 108 次，单目标修复 84 次）；来源页定位 URL 字段未发送。[v3 首轮报告](../../../workspace-data/evidence/translation-benchmark-tico19-dev-full-document-corpus-20261116/full-document-context-coverage-v3/full-document-context-coverage-summary-v3.md) · [修复摘要与响应校验](../../../workspace-data/evidence/translation-benchmark-tico19-dev-full-document-corpus-20261116/full-document-context-coverage-v3/single-target-repair-summary-v2.md) · [合并覆盖审计](../../../workspace-data/evidence/translation-benchmark-tico19-dev-full-document-corpus-20261116/full-document-context-coverage-v3/single-target-repair-and-combined-coverage-audit-v2.json) 随后针对 2B/9B 两个缺口尝试一次独立补采，但本机 DNS 返回 ENOTFOUND，0 次 HTTP 请求，未产生新候选；覆盖仍是 933/934、933/934、934/934。[末两格补采审计](../../../workspace-data/evidence/translation-benchmark-tico19-dev-full-document-corpus-20261116/full-document-context-coverage-v3/final-two-cell-repair-audit-v3.json)

## PLOS One 材料科学摘要上下文敏感性计划

新增一个非 COVID 科技论文 source-only 试点：1 篇材料科学论文摘要、10 个英文句段。按同一目标、同一模板、同一模型和双重复，比较显式无上下文与“同摘要其余 9 句、排除目标句”的上下文条件，共计划 120 次 Bilibili 调用。上下文是唯一实验变量；请求不含中文参考、研究者提出的术语候选、来源 URL、许可证字段或本地行 ID。请求与提示哈希 120/120 通过离线核对。

当前 Bilibili DNS 返回 ENOTFOUND，0/120 次已提交。即使日后执行，这仍是一篇论文的重复测量，只能报告 API/格式状态、token/延迟和输出对上下文的敏感性；不能把 10 句当独立论文，也不能产生质量排名。双语评审按用户安排暂缓。[试验摘要](../../../workspace-data/evidence/translation-benchmark-plos-stance-markers-source-only-candidate-20261116/context-ablation-v1/ summary-v1.md) · [上下文计划与机器审计](../../../workspace-data/evidence/translation-benchmark-plos-stance-markers-source-only-candidate-20261116/context-ablation-v1/ study-design-v1.json) · [执行状态与 DNS 审计](../../../workspace-data/evidence/translation-benchmark-plos-stance-markers-source-only-candidate-20261116/context-ablation-v1/ execution-audit-v1.json)

为该单篇试点配套建立了 source-first 立场标注包：10 个目标句分别链接到同摘要其余 9 句上下文，队列不含候选术语、目标参考或模型译文。10/10 源文哈希与上下文映射通过核验，评审分配 0；这只是待用标注素材，不是立场判断结果。[队列摘要](../../../workspace-data/evidence/translation-benchmark-plos-stance-markers-source-only-candidate-20261116/context-ablation-v1/ source-stance-review-packet-summary-v1.md) · [队列审计](../../../workspace-data/evidence/translation-benchmark-plos-stance-markers-source-only-candidate-20261116/context-ablation-v1/ source-stance-review-packet-audit-v1.json)


## PLOS One 生存率统计摘要：受控上下文扩展

新来源组选择 PLOS One 论文 DOI 10.1371/journal.pone.0355291 的英文摘要，版本记录日期为 2026-08-04；本地只保存 13 个句段，不包含全文、图表或未审中文译文。来源页面说明文章使用 CC BY 4.0，归属信息随候选包保存。

每个目标句分别生成“只输入该句”和“输入 13 句完整摘要、仅翻译指定句”两种请求；3 个 Bilibili 模型、双重复，共 156 格。句子、模型、重复编号用于成对对照，独立样本数仍是一篇论文。请求哈希和 source-only 隔离审计 156/156 通过，但 Bilibili 域名 DNS 返回 ENOTFOUND，HTTP 请求为 0，故无模型输出。

后续评审应盲化模型及上下文条件，逐句记录术语、主张方向、限定词强度、0/1 边界、置信区间上下界和推荐范围。只有成对译文都由双语评审后，才归纳上下文有益/无变化/有害。12 项源术语候选不含目标词形；术语记忆消融需等译法审定后另行设计，避免把“加上下文”与“加词库”混成同一变量。 [数据包与审计](../../../workspace-data/evidence/translation-benchmark-plos-survival-ci-abstract-20261117/v1/summary-v1.md) · [专用 rubric](../../../workspace-data/evidence/translation-benchmark-plos-survival-ci-abstract-20261117/v1/evaluation-rubric-v1.json)

## 来源证据问答候选集 v1

新增一个与翻译评分分离的英文 source-evidence QA 候选包，覆盖 Kubernetes Service、TypeScript Handbook Basics、React State Structure 和一篇 PLOS One Materials Science 摘要，共 4 个来源组、24 个问题。任务包括定义/关系、默认值、代码/流程条件、否定与作者限定，以及 4 个“所给摘录不足以回答”的拒答控制。每个问题绑定原文段落 ID 和哈希，答案候选与模型输入分文件保存。

每条模型输入只包含英文问题和固定版本的英文摘录，要求模型给出简短答案并引用摘录标签；不包含目标参考译文、答案键、术语候选、来源 URL 元数据或本地文档 ID。53 个源段对照主清单哈希，24 个证据映射和 24 个输入哈希通过结构审计。任务统计应按文档/来源组聚类；4 个来源组不足以支持稳定的通用文档理解模型排名。

候选答案仍待内容审阅和仲裁。72 行三模型探索计划未执行；API 是否适合问答任务、外部服务处理与留存范围仍须单独确认。本任务集使用英文问题/答案测量源文理解，不能并入英译简中质量分。[任务集摘要](../../../workspace-data/evidence/translation-document-understanding-source-evidence-candidates-20261116/v1/summary-v1.md) · [源文输入](../../../workspace-data/evidence/translation-document-understanding-source-evidence-candidates-20261116/v1/source-only-model-input-v1.jsonl) · [独立答案候选](../../../workspace-data/evidence/translation-document-understanding-source-evidence-candidates-20261116/v1/answer-key-candidates-v1.jsonl) · [评分量表](../../../workspace-data/evidence/translation-document-understanding-source-evidence-candidates-20261116/v1/evaluation-rubric-v1.json) · [结构和隔离审计](../../../workspace-data/evidence/translation-document-understanding-source-evidence-candidates-20261116/v1/validation-report-v1.json)

### Kubernetes Service v1.32 证据问答扩展

另建了一个可独立检查的 10 题 sidecar，使用 Kubernetes Service v1.32 页的 10 个选取英文片段，覆盖字段关系、旧 Endpoints API 截断范围、NodePort 分配失败、ExternalName 的 CNAME/代理边界、Headless Service、环境变量条件、PreferClose 偏好和 externalIPs 职责。8 题有片段支持，2 题询问摘录中没有给出的 DNS TTL 和云厂商负载均衡算法，应拒答。答案键候选分文件保留，模型输入含 10 个带标签的证据段但不含答案键或中文页面。

该版本仍沿用 `kubernetes-website` 来源组，不新增独立组；它与原 v1 的固定 Git 提交版本分开标识为 v1.32 版本页摘录候选，不能合并成同一版本证据。30 行三模型计划尚未提交；来源修订未固定到内容提交，外部处理/留存复核待完成，人工答案键审定为 0。[扩展摘要](../../../workspace-data/evidence/translation-document-understanding-kubernetes-service-extension-20261117/v1/summary-v1.md) · [10 个任务与独立候选答案](../../../workspace-data/evidence/translation-document-understanding-kubernetes-service-extension-20261117/v1/task-candidates-v1.jsonl) · [评分量表与隔离审计](../../../workspace-data/evidence/translation-document-understanding-kubernetes-service-extension-20261117/v1/evaluation-rubric-v1.json)

### Kubernetes Service v1.32 整页技术文档翻译候选

完整页面实验与前述 10 段局部上下文实验分开：整页 Markdown 固定在一个上游提交，使用通用提示与结构感知提示各跑三模型一格，共 6 次计划。此处可回答整页结构是否保留、章节关系和代码/列表如何随提示处理；不能把它解释成段落上下文增益，也不能与 10 段实验混池。10 个旧段落对规范化全文达到至少 98% 的有序 token 覆盖，仅是源文映射检查。

整页评估把章节/列表/代码覆盖与语义严重度拆开：标记 API 字段和 Service 类型边界、默认值/要求/条件、否定与废弃状态、版本范围/数字、DNS 语义、职责主体、YAML 示例及锚文本含义。超长文档需记录发送 token 与截断点；若模型上下文窗口容纳不下，必须明确改变样本范围或采用分块实验，并把跨块定义/术语记忆作为单独条件，不得静默截断。该样本目前只有一个来源组，可用于流程可行性和错误类型设计，不能支持普遍页面质量排序。

并行中文文件未标 `l10n.sourceCommit`，段落对齐和译文质量未经复核；模型输入不含该目标。外部模型处理和输出留存复核完成前不运行计划。来源、处理状态和 rubric 见[整页候选记录](../../../workspace-data/evidence/translation-benchmark-kubernetes-service-full-page-candidate-20261117/v1/full-page-source-record-v1.json)、[校验报告](../../../workspace-data/evidence/translation-benchmark-kubernetes-service-full-page-candidate-20261117/v1/validation-report-v1.json)与[评分量表](../../../workspace-data/evidence/translation-benchmark-kubernetes-service-full-page-candidate-20261117/v1/evaluation-rubric-v1.json)。

整页 QA 另以 231 个哈希块作为可引用的来源单位；每个问题都看到完整页面，问题键与答案键分离。这样可以测跨章节主张组合、错误证据引用和拒答，而不是让人工先裁剪少量证据块后仅测局部检索。它仍只有一个来源组：同一文档的 10 题与 231 块不是 10 或 231 个独立文档样本。对未来多文档集，任务和置信区间须按作品/来源组聚类；先审定问题可答性、答案键和证据块，再比较模型。[整页理解任务候选与审计](../../../workspace-data/evidence/translation-document-understanding-kubernetes-service-full-page-20261117/v1/summary-v1.md)

独立 OpenTelemetry 全页候选可作为另一组技术概念材料：同一篇中关联 observability、telemetry、metrics、SLI/SLO 与 logs/spans/traces，适合检查跨段定义关系和术语一致性。但其中文平行页在前置 metadata 中明确标为已漂移，不能据它自动生成问答答案键或术语记忆；需要先固定当前目标文本、做段落对齐和双语内容审定。当前 6 格翻译计划因 Bilibili DNS `ENOTFOUND` 未执行，0 输出。[源文/漂移元数据/术语候选](../../../workspace-data/evidence/translation-benchmark-opentelemetry-observability-primer-candidate-20261117/v1/full-page-source-record-v1.json) · [候选摘要](../../../workspace-data/evidence/translation-benchmark-opentelemetry-observability-primer-candidate-20261117/v1/summary-v1.md)

该页面另配 10 个全文证据问答任务（8 答、2 拒答），每题输入 37 个稳定证据块并要求主张级引用。整页输入让模型可自行定位概念和例子，区别于只给人工挑选的段落证据；答案键仍是待审候选。它与同页翻译实验共用一个来源组，不能把 10 道题计作额外文档样本，也不能使用漂移中文页作为 QA 正确答案来源。[任务、来源块及独立答案键](../../../workspace-data/evidence/translation-document-understanding-opentelemetry-observability-primer-20261117/v1/summary-v1.md) · [隔离审计](../../../workspace-data/evidence/translation-document-understanding-opentelemetry-observability-primer-20261117/v1/validation-report-v1.json)

## Pepper&Carrot Episode 26：漫画跨行一致性盲审准备

已有 6 页英中官方语言包的 56 个 SVG 文本 ID 配对和 36 个文本型 Bilibili 输出（3 模型 × 2 提示 × 6 页）。新队列拆成 336 个逐行候选和 36 个整页上下文包；逐行评分先看源句与匿名译文，不显示中文参考、模型名和提示条件。随后按页检查同一角色的语气、复现术语、指代、笑点和音效，再揭示英文原图检查气泡归属及字数适配。

逐行表单规划为 12 份逻辑盲态版本，每份 56 个任务；每个匿名输出被两份不同表单独立评审，同一源区域不会在同一表单里重复出现。整页上下文另有 12 份逻辑版本，每份 6 页，每个页面候选两评。这里的表单数量是排程素材，不代表已有评审者或评审结果；当前实际分配、人工审定、质量分和排名均为 0。

官方中文 SVG 候选在初评中隐藏，不能直接当金标准。164 条角色标签变化和行号/顺序检查作为格式诊断单列；全页流畅度、机器成功率和参考候选相似度也不能替代语义评审。候选输出服务留存审核未完成，队列与键文件仅供内部维护。[队列、评分量表和机器审计](../../../workspace-data/evidence/translation-benchmark-peppercarrot-ep26-bilibili-api-20261115/blind-review-summary-v1.md)

### Episode 26 / 39 跨篇章角色声音候选

新复核包从两集共用的 `Pepper`、`Sound`、`Writing` 元数据标签收集 101 条英中候选行；两集官方简中页均将译者标为 Ran Zhuang。阅读界面按作品/集数、页码和候选角色展开上下文，先让评审者确认图像中的区域类别与发言者，再判断中文是否保留语气、语用功能、幽默和声线。拟声词与画内字样使用独立标注，不并入对白分数。

跨集仅发现一个归一化完全重复的源文本 `- FIN -`，来源标签为 Narrator/Writing，译文标点空格也不同；没有完全重复的 Pepper 对白。该包适合准备跨篇章风格复核素材，但不足以测相同源句记忆效果，且 Episode 26/39 属同一系列来源组。人评、模型输出和记忆准入均为 0。[队列摘要](../../../workspace-data/evidence/translation-benchmark-peppercarrot-cross-episode-style-review-20261118/v1/summary-v1.md) · [行级候选及图像哈希](../../../workspace-data/evidence/translation-benchmark-peppercarrot-cross-episode-style-review-20261118/v1/cross-episode-review-rows-v1.jsonl) · [唯一重复源表面](../../../workspace-data/evidence/translation-benchmark-peppercarrot-cross-episode-style-review-20261118/v1/normalized-source-overlap-candidates-v1.jsonl)

## PLOS One 论文摘录证据问答

同一篇统计论文现增加独立于翻译消融的文档理解包：13 句摘要加 13 个选自方法、结果、示例和讨论的正文证据块，共 14 个稳定来源块。14 道问题包括 12 个可答任务和 2 个限定摘录材料不足的拒答控制；每题都看到完整摘录包，要求按证据块 ID 引用。问题覆盖模拟设计、数值条件、结果方向、示例范围、方法局限和拒答边界。

三模型计划共 42 格，答案键候选与模型输入分离，哈希和答案键隔离 42/42 通过；Bilibili DNS ENOTFOUND，0 次 HTTP。它复用摘要上下文实验的 DOI 来源组，不增加独立论文数。数据包只覆盖选定摘录，不代表全文理解；本轮无输出、答案键审定、质量分或排名。[摘录数据、问题和执行状态](../../../workspace-data/evidence/translation-document-understanding-plos-survival-ci-article-20261117/v1/summary-v1.md)

### PLOS One 分节证据扩展 v2

在 v1 的摘要与选摘基础上，新增 11 个引言、方法、结果、示例和讨论证据块，总计 25 块，仍对应同一个 DOI 来源组。新增 12 道问答（10 个可答候选、2 个公式/表格拒答控制）；与 v1 合并呈现时是 26 道任务、22 个可答候选、4 个拒答控制。题目补充变换判别规则、截断区间处理、有效样本量、重复模拟细节、变换识别误差、作者 AI 辅助代码披露和示例结果范围。

36 格 Bilibili 计划请求的哈希与输入隔离检查为 36/36；本次没有重复网络预检、未发 HTTP。问答只依据选定可见文字，不是全文/完整正文捕获；公式图像、表格、图表和补充材料均未提供，因此保留相应拒答题。答案键尚未人工审定，输出、评分和排名均为 0；任务和来源块数量不增加独立论文样本数。[v2 摘要与审计](../../../workspace-data/evidence/translation-document-understanding-plos-survival-ci-article-20261117/v2-section-expanded/summary-v2.md) · [分节证据包](../../../workspace-data/evidence/translation-document-understanding-plos-survival-ci-article-20261117/v2-section-expanded/source-evidence-packet-v2.md) · [机器校验](../../../workspace-data/evidence/translation-document-understanding-plos-survival-ci-article-20261117/v2-section-expanded/validation-report-v2.json)

## eLife 蜻蜓目范围与物候论文证据问答

新增独立的 eLife 生态论文 sidecar，DOI 版本为 10.7554/eLife.101208.4。16 个证据块覆盖摘要、研究问题、数据与方法、统计表、讨论及数据可用性；18 道题（16 个可答候选、2 个拒答控制）重点考察不同分析分母、负号/效应方向、统计限定和观测研究的因果边界。答案必须引用证据块 ID。

官方 README 明确列出 Index-Translate-35B-A3B 免费 API；同一 Bilibili endpoint 的 2026-11-14 历史运行则为 2B、9B、35B 均留下 HTTP 200 与原始响应。因此本 QA 侧车恢复为三模型 × 18 题，共 54 格，哈希和输入隔离 54/54；当前 DNS `ENOTFOUND`，0 次新 HTTP。该文章没有合并进主清单 v61，作为一个新增独立论文来源组保存在 sidecar；选摘不是完整论文，图像和其余附录表未纳入。答案键仍未人工审定，无本侧车输出、质量分或排名。[模型接入范围与历史响应](../../../workspace-data/evidence/translation-document-understanding-elife-odonate-range-phenology-20261117/bilibili-model-access-scope-v1.json) · [摘要与覆盖说明](../../../workspace-data/evidence/translation-document-understanding-elife-odonate-range-phenology-20261117/v1/summary-v1.md) · [证据包](../../../workspace-data/evidence/translation-document-understanding-elife-odonate-range-phenology-20261117/v1/source-evidence-packet-v1.md) · [输入隔离审计](../../../workspace-data/evidence/translation-document-understanding-elife-odonate-range-phenology-20261117/v1/validation-report-v1.json)

同篇摘要另建独立的翻译上下文消融：11 个句子分别使用仅目标句和完整 11 句摘要上下文，覆盖 Index-Translate 2B、9B、35B-A3B，每个模型/条件重复两次，共 132 个计划请求。公开 API 计划的请求哈希与来源隔离为 132/132，但 API 通道受 DNS `ENOTFOUND` 阻断，132 格仍未通过 API 提交；这不限制随后单独使用官方网页 UI 采集。[API 实验计划](../../../workspace-data/evidence/translation-document-understanding-elife-odonate-range-phenology-20261117/translation-ablation-v1/summary-v1.md) · [成对任务表](../../../workspace-data/evidence/translation-document-understanding-elife-odonate-range-phenology-20261117/translation-ablation-v1/translation-task-plan-v1.jsonl) · [API DNS 状态](../../../workspace-data/evidence/translation-document-understanding-elife-odonate-range-phenology-20261117/translation-ablation-v1/network-preflight-v1.json)

官方网页 UI 另有两版 sidecar：v1 在 6/132 格 canary 全部回显人工加入的句号标签后停止；v2 删除源文句号 ID 并将目标句作为独立字段，完成 132/132 格，三模型返回 ID 和浏览器/本地译文哈希均 132/132 匹配。机器输出范围标记为 114 格未检出显式标题、4 格回显上下文标题、14 格回显目标标题；这是结构信号，不是完整范围裁定。公开 API 的 132 格仍未提交，UI 输出只用于后续上下文敏感性评审；译文差异、耗时或模型规模均不代表质量提升。人工评审、质量分和排名仍为 0。[v2 UI 摘要与审计](../../../workspace-data/evidence/translation-document-understanding-elife-odonate-range-phenology-20261117/web-ui-context-ablation-v2/summary-v2.md) · [逐格 UI 输出](../../../workspace-data/evidence/translation-document-understanding-elife-odonate-range-phenology-20261117/web-ui-context-ablation-v2/ui-run-results-v2.jsonl) · [v1 标签回显 canary](../../../workspace-data/evidence/translation-document-understanding-elife-odonate-range-phenology-20261117/web-ui-context-ablation-v1/summary-v1.md)

该 Bilibili 请求计划是直接 API 自定义问答提示，不是 FluentRead 内置翻译 provider 的页面翻译请求；它只能检验这一模型/提示配置下的证据问答候选，不能写入翻译质量分或扩展 provider 能力结论。

### eLife 图注翻译与图注证据问答 sidecar v2

在同一论文来源组内新增 Figure 1–3 三个图注源块和三条简中 source-only 翻译输入，并从图例、面板、分母、统计值/单位、跨图示意与实测范围差异构建 5 道问答（4 个可答候选、1 个拒答控制）。17 个术语跨度归为 12 个候选家族；目标译法为空，尚无术语记忆准入。问答输入只含问题与可回链英文证据块，答案键单独保存；SHA-256、span、证据映射、source-only 隔离与答案键隔离审计通过。

三模型图注翻译计划为 9 格，本轮 DNS `ENOTFOUND`，0 次 HTTP。该包只包含图注文本，不含图像、alt text、原始 HTML 或逐点观测，因此不能作为 OCR、图表视觉理解或页面布局评测。它复用 `elife-odonate-range-phenology-101208`，独立来源组数不变，也不进入 v61。Rubric 尚未人工校准；按用户安排评审暂缓，当前 0 次人工评分、0 个准入术语、0 个模型排名。[v2 摘要与完整性审计](../../../workspace-data/evidence/translation-document-understanding-elife-odonate-range-phenology-20261117/figure-caption-expansion-v2/summary-v2.md) · [图注/模型输入](../../../workspace-data/evidence/translation-document-understanding-elife-odonate-range-phenology-20261117/figure-caption-expansion-v2/figure-caption-source-blocks-v2.jsonl) / [source-only 输入](../../../workspace-data/evidence/translation-document-understanding-elife-odonate-range-phenology-20261117/figure-caption-expansion-v2/source-only-model-inputs-v2.jsonl) · [问答与独立答案键](../../../workspace-data/evidence/translation-document-understanding-elife-odonate-range-phenology-20261117/figure-caption-expansion-v2/document-understanding-task-candidates-v2.jsonl) / [答案候选](../../../workspace-data/evidence/translation-document-understanding-elife-odonate-range-phenology-20261117/figure-caption-expansion-v2/answer-key-candidates-v2.jsonl)

## Apache ECharts Handbook 整页理解与证据问答候选

新的独立 Apache ECharts Handbook 文档组包含 5 个稳定来源块和 8 道候选问答：6 道要求解释数据转换、transform 链、filter parser 和按需引入，2 道检查模型是否会对文档未说明的时区假定和算法复杂度拒答。答案键单独保存，要求逐条主张引用来源块 ID；问题、证据和答案候选均未经过双语/技术专家审定。

三模型共 24 格计划已通过 source-only 与答案键隔离检查，当前 0 次 API 调用；此前同文档翻译矩阵遇到 HTTP 504 后停止，因此问答调用仍未提交。它测英文全页理解与证据回链，不是翻译质量；一篇文档不能支持一般理解能力排名。[任务、来源块和答案键摘要](../../../workspace-data/evidence/translation-benchmark-apache-echarts-handbook-data-transform-20261118/v1/document-understanding-v1/validation-report-v1.json) · [24 格 Bilibili QA 计划](../../../workspace-data/evidence/translation-benchmark-apache-echarts-handbook-data-transform-20261118/v1/document-understanding-v1/bilibili-qa-plan-summary-v1.md) · [机器可读量表](../../../workspace-data/evidence/translation-benchmark-apache-echarts-handbook-data-transform-20261118/v1/document-understanding-v1/evaluation-rubric-v1.json)

## Ant Design Form 重复 API 词项上下文消融候选 v87

对既有 Ant Design Form 八个同提交英中段落完成逐字面审计后，先冻结并运行 24 格技术提示基线（8 段 × 3 模型 × 1 次），随后运行 60 格上下文消融：五个含重复 `dependencies` / `shouldUpdate` 的目标段，比较 target-only 与同页另外七个选定英文段落。两项共 84/84 HTTP 200 非空，逐请求与响应哈希通过，0 自动重试。所有请求排除中文候选、13 条未审术语、来源/许可元数据及图像；只包含目标英文段和按条件指定的英语上下文，不代表整页理解。

上下文部分同目标、模型和复本共形成 30 组配对，27 组的译文字符串变化；逐模型为 2B 8/10、9B 9/10、35B-A3B 10/10。API 报告的 prompt token 中位数从 123 增至 532。盲态池含 60 条单译文与 27 组成对候选，3 对相同输出从偏好题中排除；基线另有 24 条匿名单译文候选。所有评审、分数和排名仍为 0。变化只代表单文档实验中的上下文敏感性与请求成本，不证明翻译质量或跨段术语一致性提高。源组 84 格已完成。Bilibili 当前公开服务条款允许其使用提交内容开发、训练、测试和评估与服务有关的 AI 系统；本批来源为 MIT 文档，数据仍保留为私有研究候选，外部输出留存与公开分发审批单独待审。[基线执行审计](../../../workspace-data/evidence/translation-benchmark-ant-design-form-reference-candidate-20261116/base-translation-v1/execution-v1/execution-audit-v1.json) · [基线盲态池](../../../workspace-data/evidence/translation-benchmark-ant-design-form-reference-candidate-20261116/base-translation-v1/execution-v1/blind-review-pool-v1/summary-v1.md) · [上下文执行审计](../../../workspace-data/evidence/translation-benchmark-ant-design-form-reference-candidate-20261116/context-ablation-v1/execution-v1/execution-audit-v1.json) · [数据用途记录](../../../workspace-data/evidence/translation-benchmark-ant-design-form-reference-candidate-20261116/base-translation-v1/execution-v1/data-use-review-v1.json) · [Bilibili 服务条款](https://www.bilibili.com/blackboard/era/termsofservice.html)。

### ECharts Dataset 网页快照与跨页上下文门槛

Dataset 英中渲染网页快照尚未绑定仓库提交。英文有 13 个 H2 节、简中有 12 个；任务包的 14 个英文证据块、10 个问答候选（8 可答、2 不可答）和答案键都只是待审候选，不能按标题序号推定英中对应，也不能形成 QA 准确率。模型输入计划保持未生成，直到修订号和许可范围得到核实。[来源与结构审计](../../../workspace-data/evidence/translation-benchmark-echarts-dataset-web-snapshot-20261118/v1/capture-provenance-v1.json) · [任务和答案候选](../../../workspace-data/evidence/translation-benchmark-echarts-dataset-web-snapshot-20261118/v1/document-understanding-summary-v1.md)

后续若与固定版本的 Data Transform 建立同文档上下文对照，应使用同一个英语查询段，分别输入无上下文、同页段落、已核实的关联页段落与经双语审定的术语记忆。记录每个上下文块的来源页、版本、相关性判断、token 数和是否包含查询段本身；单独报告检索覆盖/误带入、术语跨页一致性、证据引用和翻译质量。不能把页面修订不同或检索到更多文字造成的变化归因成术语记忆收益。

## React 四页 excerpt packet 跨文档理解候选

React state guides sidecar 将 44 个英语段落候选作为同一证据包输入 10 道问题；8 题涉及状态快照、更新队列、对象 mutation、状态结构与去重，另 2 题测试对摘录未说明事实的拒答。答案候选按主张映射证据 block ID，并与输入隔离。Bilibili 30 格 QA 计划尚未提交，当前无输出、答案键审定或准确率。[44 个证据块和来源版本](../../../workspace-data/evidence/translation-document-understanding-react-state-guides-cross-document-20261118/v1/source-evidence-blocks-v1.jsonl) · [任务与分离答案键](../../../workspace-data/evidence/translation-document-understanding-react-state-guides-cross-document-20261118/v1/document-understanding-task-candidates-v1.jsonl) / [答案键候选](../../../workspace-data/evidence/translation-document-understanding-react-state-guides-cross-document-20261118/v1/answer-key-candidates-v1.jsonl) · [30 格 QA 计划](../../../workspace-data/evidence/translation-document-understanding-react-state-guides-cross-document-20261118/v1/bilibili-call-plan-v1.jsonl) · [未校准 Rubric](../../../workspace-data/evidence/translation-document-understanding-react-state-guides-cross-document-20261118/v1/document-understanding-rubric-v1.json)

该包不是四篇全文：44 个选定段落来自一个 React 项目来源组，每篇单独固定 source commit/blob，版本日期不完全相同。界面须显示“选段证据包 / 非全文”和每段来源页/修订；四篇文档在统计和 split 上仍聚类为一个项目组，不能把 10 道题或 44 个段落算作 10/44 个独立文档样本。

翻译上下文敏感性已有独立的 144 格 React 计划：8 个目标分别比较 target-only、同页相邻和关联页英语源文上下文，三模型、双重复。这个任务和上述 QA sidecar 共用来源组，但问答与翻译矩阵是不同研究单元。新 QA 包只链接该计划，没有再造 36 格重叠请求。请求包隔离审计通过；首次本地请求因 DNS 失败未到达服务，0 次 HTTP 响应、143 格未发送。上下文相关性仍待独立审定，暂无译文、人工质量评分或模型排名。[运行摘要与隔离审计](../../../workspace-data/evidence/translation-document-context-react-cross-page-candidate-20261116/bilibili-context-run-v1/run-summary-v1.md) · [已有上下文计划](../../../workspace-data/evidence/translation-document-context-react-cross-page-candidate-20261116/context-plan-v1.json) · [8 个目标和上下文候选](../../../workspace-data/evidence/translation-document-context-react-cross-page-candidate-20261116/context-candidates-v1.jsonl) · [哈希对账](../../../workspace-data/evidence/translation-document-understanding-react-state-guides-cross-document-20261118/v1/related-context-study-link-v1.json)

## MDN AbortSignal 整页候选：上下文与术语数据边界

2026-11-18 保存的英中页面是同一 MDN 内容来源组的完整仓库 Markdown 文件；两个提交固定，简中页记录的 `l10n.sourceCommit` 与英文源提交一致。结构解析得到源/目标 48/47 块，但块数不同且无人工逐节映射，不能假定相同序号代表同一内容。此包可为未来的整页技术翻译和分块策略提供源文材料；它与 v58 的 9 个局部目标及 108 格上下文计划是不同的分析单位。

同包附 10 个英文与 10 个简中独立词面检索组（116/99 个出现位置）。位置可帮助研究重复 API 名称、正文用词与代码标识符如何分布，但不能当成术语一致性标签，也没有建立英中词对。未来若要比较 target-only、同页局部上下文和整页其余源文上下文，应固定相同目标片段、从上下文中排除目标本身，记录完整输入 token 与上下文块来源，并把结构/标识符保真、术语一致性和双语质量分开报告。当前许可范围和外部处理待审，因此未准备或发送新模型调用；没有人评、质量分或记忆准入。[整页版本与结构说明](../../../workspace-data/evidence/translation-document-mdn-abortsignal-full-page-20261118/v1/README.md) · [独立词面观察与位置](../../../workspace-data/evidence/translation-document-mdn-abortsignal-full-page-20261118/v1/term-observations/summary-v1.md) · [术语观察机器审计](../../../workspace-data/evidence/translation-document-mdn-abortsignal-full-page-20261118/v1/term-observations/term-observation-audit-v1.json)

## PLOS Biology ALS 论文跨章节证据问答候选

同一 PLOS Biology DOI 另抽取 8 个英文证据块，跨引言、结果、图注和方法，配 12 道 source-only 问答候选（10 可答、2 拒答控制）。答案键文件与问题分开，要求证据块 ID 回链；这增加的是一个论文来源组内的段落和任务覆盖，不增加独立论文数，也不是完整论文问答。

题目重点保留分母、危险率、统计筛选条件、加权/不加权条件、归一化警告和数据排除可复现性；拒答题专门询问摘录未提供的 treatment effect 和个体当前预后。当前原文抽取与答案候选均未审，许可版本待核；模型调用、质量分和 QA 准确率均为 0。[证据包摘要与限制](../../../workspace-data/evidence/translation-benchmark-plos-biology-als-candidate-20261118/v1/document-understanding-v1/summary-v1.md) · [带哈希证据块](../../../workspace-data/evidence/translation-benchmark-plos-biology-als-candidate-20261118/v1/document-understanding-v1/source-evidence-blocks-v1.jsonl) · [任务候选](../../../workspace-data/evidence/translation-benchmark-plos-biology-als-candidate-20261118/v1/document-understanding-v1/document-understanding-task-candidates-v1.jsonl) · [独立答案键](../../../workspace-data/evidence/translation-benchmark-plos-biology-als-candidate-20261118/v1/document-understanding-v1/answer-key-candidates-v1.jsonl)

## MDN AbortSignal 整页文档理解候选

为固定提交的 MDN AbortSignal 英文全文建立 10 道 source-only QA 候选，8 道可答、2 道拒答控制；答案键与题目分文件，且没有生成模型输入。任务要求按哈希稳定的结构块引用证据，问题单列跨章节信号组合、错误语义与 Promise 状态关系；拒答题检验文档是否说明 API 最大 timeout 和远端服务端取消保证。证据覆盖 48 个正文结构块，但仍只有一个技术文档来源组，不能据此给模型做通用文档理解排名。答案候选未审，质量分为 0。[摘要与限制](../../../workspace-data/evidence/translation-document-understanding-mdn-abortsignal-20261118/v1/summary-v1.md) · [问题集](../../../workspace-data/evidence/translation-document-understanding-mdn-abortsignal-20261118/v1/task-candidates-v1.jsonl) · [私有答案键](../../../workspace-data/evidence/translation-document-understanding-mdn-abortsignal-20261118/v1/answer-key-candidates-v1.jsonl) · [证据块与校验](../../../workspace-data/evidence/translation-document-understanding-mdn-abortsignal-20261118/v1/source-evidence-blocks-v1.jsonl) / [报告](../../../workspace-data/evidence/translation-document-understanding-mdn-abortsignal-20261118/v1/validation-report-v1.json)
