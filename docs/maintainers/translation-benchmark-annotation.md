# 翻译基准人工标注指南

版本：0.3（小规模试标与来源扩展）
适用方向：英语 → 简体中文，可按语言对补充文化与术语规则  
状态：待双语审核者试标并校准；不作为已生效的生产验收门槛

## 1. 标注目标

标注需要回答：译文是否保留原意、信息是否完整、读起来是否自然、是否符合领域与上下文。比较模型或流程时，让评审者看到相同原文和相同的必要上下文，用随机 A/B 标识隐藏模型与实验条件。不要要求译文逐字对应某一条参考译文；同义、语域或漫画口吻上的合理变化可以并存。

翻译错误与上游提取错误分别记录。网页正文漏提、PDF 文本抽取错误、漫画 OCR 错字、气泡顺序错误不能记成模型的翻译错误；如果任务测的是 FluentRead 完整产品流程，再另加一条端到端结果并记录问题发生在哪一阶段。

## 1.1 参考译文候选与段落对齐

官方本地化、既有发布译文和机器译文都先标为候选参考。仓库提交相同只能证明版本锁定，不能证明段落等价或翻译正确。两位评审应分别核对来源与目标版本、段落覆盖、否定/数量/约束、术语和专名，并指出删增内容；分歧交第三人仲裁。目标文本不能可靠对应到源段时，标为未对齐并排除出参考译文指标，不从邻段推断或用空字符串补齐。

部分对齐的文档可以保留已映射段和未映射段，但报告指标时要只使用经审定的共同文本范围，并说明排除的段落数。只有在段落映射和译文语义都完成审定后，才可将候选参考用于 chrF/BLEU 等参考译文指标；指标仍须与双盲人工质量分开报告。Kubernetes ConfigMaps 与 Service 的同提交简中本地化是部分对齐候选示例，尚无评审或质量分：[配对证据](../../../workspace-data/evidence/translation-benchmark-kubernetes-localization-pairs-20261114/summary.md)。

## 1.2 源文完整性与本地标准化

把“源文进入模型前是什么”与“源数据包原来是什么”分别留证。遇到编码外壳、序列化标记、OCR 误字或空白清理时，不得静默覆盖来源：保留原归档哈希、原字段值哈希、标准化后哈希、变换规则、稳定片段 ID 和支撑该变换的页面版本。来源版本未固定时，标为候选标准化，不据此宣称已校准语料。

本流程示例是 TICO-19 官方 dev 的 `wiki_26:2435` 行：归档字段以 `b'` 开头，当前链接页面的正文不含该字节表示前缀；v59 仅在本地候选输入中去掉这两个字符，原归档保持不变，并保存前后哈希。由于 Wikipedia 页面修订未固定、TICO 的 row-level translator_ID 为 `TOFILL`，该处理仍是可追溯的候选数据整理，不是人工确认的源文真值或译文质量结论。[归档/标准化审计](../../../workspace-data/evidence/translation-benchmark-tico19-dev-reference-expansion-20261116/source-text-normalization-audit-v1.json) · [当前页面](https://en.wikipedia.org/wiki/Bat_SARS-like_coronavirus_WIV1)

## 2. 评审单元与盲审

- **采样与统计单位：文档或作品。** 句子、段落、表格单元、漫画气泡是定位和标注的子单元。同一文档里相关片段不能当作独立文档扩充样本数。
- **比较条件：配对。** 同一来源文档、语言方向、提取结果、上下文范围及其他配置应匹配；若评审的就是某项消融，只有该变量可以变化。每次运行记录提示词、模型/服务身份、版本、产品构建和运行时间。
- **盲审呈现：** 随机化系统或条件名称并平衡 A/B 顺序；每个输出单独打分，再做偏好选择。评审者不能先看到系统名、自动分数、参考译文或其他人的结论。
- **上下文：** 提供判断任务所需的原文邻段、标题、章节、代码/表格关系或整页漫画图像。清楚记录该上下文是否也发给了模型，避免“评审看到了而模型没看到”被误记为模型输入。
- **篇章一致性判断：** 对多段文档单列 `document_consistency_score`（1–5）与 `cross_segment_issue_links[]`，跨链接相关段落 / 译文跨度，标记术语、实体、指代、语域、时态或逻辑衔接问题。评审者看见全文时也要明确提交此项；保留隐藏的 SEG / DOC / MIX 实验条件元数据。字段和约束见[评审 JSON Schema 草案](./translation-document-consistency-annotation.schema.json)；此轴待试标校准，暂不并入其他维度或单一总分。
- **独立双审：** 每个正式样本由两名合格评审分别完成；至少覆盖目标语母语/高熟练读者，论文与技术文档再匹配相应领域经验。先保存两份原始标签，再仲裁，不覆盖分歧历史。
- **运行证据：** 每个运行格必须连接冻结计划、请求/响应哈希、原始状态、HTTP 状态、复本和尝试号。显式预登记的计划数与从观测输出推断的数量分开保存；旧记录没有计划矩阵时，只能标为“已观察到的运行”，不得据此声称完整执行。复本是独立重复，重试是同一复本的再次尝试，两者不得共用编号或混进分母。
- **运行结果分类：** 保留供应方原始状态，同时按 HTTP 状态和译文/结构证据映射到统一类别：`translation_output_available`、`provider_http_error`、`network_transport_error`、`response_parse_error`、`response_structure_error`、`unclassified_run_state`。HTTP 非 200 优先归为供应方 HTTP 错误，即使旧记录原始标签写成 `invalid-response`；HTTP 200 但解析或结构失败属于输出合同问题，不当作语义低分。
- **运行失败：** 超时、网络错误或服务端错误记录为可用性事件，不当作译文错误或低质量分数。质量评审只对有效可提取的译文进行；报告应列明预登记计划格、实际尝试格、成功可评译文、解析/结构失败、HTTP/网络失败、未发送格和重试次数。运行成功也不代表翻译正确。

### 译文评分前的输出范围门槛

先从冻结任务计划读取 `expected_output_unit_ids` 和 `context_only_unit_ids`，再确认每条模型回复输出了哪些来源单元。只译目标句的任务若输出完整摘要、相邻段或整页内容，标为 `includes_unrequested_units`；目标单元不完整则标为 `omits_required_units`。整页翻译任务若按要求输出整页，范围状态应为 `compliant`。HTTP 成功、响应可解析、范围符合和语义质量是分开的状态，范围错误不得混进语言质量总分。

范围不符合的样本仍可进入单译文的指令遵循评审；但目标范围未裁定前，不进入句/段级的上下文配对、数字保真或文体比较。字符长度、全篇数字签名和重复语句等机器特征只能生成审查候选，不能代替人工范围裁定。盲审刺激仅携带不透明 `stimulus_id`、任务所需的源文单元（目标与必要的 context-only 单元）和译文，不展示模型、提示条件或自动风险标签。字段约束见[输出范围评审 schema](./translation-output-scope-adjudication.schema.json)。

漫画文本区域任务要把 1 个目标区域与同页其余 context-only 区域显式区分，并让评审者能将疑似多译内容映射到源区域 ID。来源自带的 `caption`、角色名或 `sfx` 标签若尚未审定，必须原样呈现并标注“来源标签候选”；不能先把它们解释为已确认的说话者/内容类别。单独回显 `<TARGET>`、图格标题或区域 ID 是格式/指令遵循现象，不足以判 `includes_unrequested_units`；只有内容可对应到目标外来源单元时才记录越界，证据不清楚时用 `ambiguous` 或 `unjudgeable`。

Postext 同页漫画文本矩阵已准备 14 组盲态 A/B 范围候选，覆盖 7 个区域与两个响应模型层；请求 2B 但实际返回 9B 的 14 格已排除出模型配对。刺激、模型/条件身份键和随机化种子分开保存；评审尚未分配。A/B 偏好只作为快速范围信号，正式 `observed_scope_status` 和 `evidence_spans` 仍需按 schema 独立记录，不能把偏好直接当作完整裁定。[盲态范围池摘要与完整性审计](../../../workspace-data/evidence/translation-benchmark-candidate-manifest-v88-echarts-translation-20261119/postext-manga-context-web-ui-matrix-v1/scope-review-pool-v1/summary-v1.md)

## 3. 输出评分维度

各维度分别评分，不求和，不平均成单一质量总分。1–5 是有序等级，不假设档位间距相等。保留“无法判断”；没有提供相关上下文时记 `not_applicable`，不能当作中间分。

| 维度 | 5 | 4 | 3 | 2 | 1 |
| --- | --- | --- | --- | --- | --- |
| 含义准确度 | 所有命题、关系、语气和限定信息均保留 | 基本准确，只有不影响理解的轻微偏差 | 整体可理解，但有明显细节错误或歧义 | 主要事实/关系错误，必须修改才能可靠理解 | 核心含义相反、严重错译或无法理解 |
| 目标语自然度 | 符合相应领域和文体，自然清楚 | 清楚可读，只有轻微生硬 | 有明显生硬或搭配问题，但读者可理解 | 表达/语法造成明显歧义或理解困难 | 难以理解或目标语严重失常 |
| 上下文与语气贴合 | 指代、语域、人物关系和文体都符合提供的上下文 | 基本贴合，只有轻微语气偏差 | 存在可辨认的指代、语域或口吻偏差 | 重要关系或说话者意图不合适 | 与上下文冲突、说话者/态度错误 |

信息完整度单独选 `complete` / `omission` / `addition` / `both` / `cant_judge`，不与准确度相加。FLORES 句级试点只给孤立源句，因此上下文与语气贴合统一记 `not_applicable`；这是任务设计属性，不能把它误当作评审打分。其他篇章任务若没有足够上下文，才用 `cant_judge`。

输出范围状态使用独立分类字段，不并入以上 1–5 质量维度：`compliant`、`includes_unrequested_units`、`omits_required_units`、`wrong_target_units`、`mixed`、`ambiguous`、`unjudgeable`、`not_applicable`。这让“译得好不好”和“是否按任务要求处理指定单位”可以分别报告。

篇章级 `document_consistency_score` 为待试标轴：5 表示术语、实体形式、指代、语域与段落衔接一致，且变体有明确理由；4 表示有轻微变化但不造成混淆；3 表示至少一处可定位的不一致，读者仍能恢复关系；2 表示多处或一处严重漂移，改变了实体、术语或语气理解；1 表示跨段关系互相矛盾或无法可靠追踪。只适用于含多个关联单元的文档；孤立句、互不相关的摘录记 `not_applicable`。发生扣分时至少建立一组跨段 `consistency_issue_links`，保存两个 `segment_id`、译文跨度、现象类别和严重度。该轴需由英简中双语评审试标校准后才能冻结。

技术文档 schema v2 使用独立的文档级序数轴“上下文与操作流程贴合”，覆盖前置条件、步骤顺序、对象/字段关系、限制和警告：5 表示关键条件与流程完整准确；4 表示轻微措辞/衔接偏差，不改变操作理解；3 表示存在明显关系或范围偏差，但主流程仍可辨认；2 表示步骤、条件或对象关系错误，会引导错误操作；1 表示关键否定、警告或安全边界反转，或流程无法执行。它与含义准确度、信息完整度、目标语自然度及整体严重度分别记录，不求和。当前已用于 Kubernetes Deployment、ConfigMaps、Service、MDN JavaScript Promises 与 CPython asyncio 样本；这些新增来源尚未人工校准该轴，不能推广为所有技术文本的已验证量表。

每个输出还要选择：`use_as_is`（可直接采用）/ `revise`（修改后可用）/ `unusable`（不可用）/ `cant_judge`。该结果与模型偏好、自然度分开保存；评审偏好某版并不等于愿意直接采用。

## 4. 错误类别与严重度

### 类别

每个错误可记录一个或多个短跨度，并从共享的轻量 taxonomy 选择主类：`mistranslation`、`omission`、`addition`、`terminology`、`number_or_unit`、`named_entity`、`grammar`、`fluency`、`discourse_context`、`style_register`、`untranslated`、`task_scope`、`other`。跨轨道报告时保留主类；维护者可再映射到更细的 MQM 类型，不让通用标注者在过细类别中猜测。[MQM](https://www.themqm.org/)采用可配置的层级错误类型、严重度和评分模型；本指南只借用其可诊断的标注结构，不声称本量表是 MQM 合规计分。

- **语义：** 错译、漏译、无根据增译、否定/情态/因果/条件变化、数字/单位、时态/体、指代/篇章关系。
- **术语：** 错词义、违背已批准词条、同义项不一致、错误检索或过度统一。
- **语言：** 语法、搭配、标点、可读性、语域/风格；单纯润色差异而意思正确时不要标为语义错误。
- **结构与保护：** 标识符、代码、链接、公式、引用、表格、列表、标记、原文顺序或非文本节点被破坏。
- **漫画专属：** OCR/区域错误、气泡归属/阅读顺序、说话者/人物口吻、拟声词、画面线索、气泡长度/排版。OCR/定位与翻译分栏标注；文字合适但溢出属于排版问题。
- **网页/文档抽取：** 正文遗漏、重复、标题归属、段落/表格/代码块丢失。只有完整产品链路评测才计入端到端失败，并保留阶段归因。

### 严重度

- **Critical：** 会使读者在关键判断、执行或剧情理解上采取错误行动的错误，例如否定/结论反转、关键数字或单位错误、危险步骤错误、关键 API/标识符损坏，或漫画中的核心人物/动作/因果关系颠倒。
- **Major：** 改变主要事实、关系、操作步骤、术语含义或角色意图，需要修改才能可靠使用，但未达到 Critical 级后果。
- **Minor：** 主要意思仍正确，问题局限于轻微漏细节、语法、措辞、标点或语气，可读者不易误解。
- **无错误/合理变体：** 不强行标注错误；用备注记录合理同义表达、不同语域或不影响意思的表达选择。

严重度以实际使用后果和文本语义为准，不因输出流畅、术语出现或自动指标通过而降级。没有足够上下文时用“无法判断”，不要推测。

同一译文的 `highest_error_severity` 必须等于所有详细错误跨度中的最高等级；有非零严重度却没有错误跨度，或选择“无”但同时留下错误跨度，都视为未完成样本。

## 5. 领域补充检查

| 内容类型 | 审核时必须检查的高风险点 |
| --- | --- |
| 一般网页 | 主张和限定范围、指代与段落衔接、正文覆盖；标题/列表/表格和链接保护另作结构核验 |
| 科技论文 | 研究对象、方法、结果、因果与相关、否定/情态、作者立场与缓和/增强语、数值单位、公式、缩写首次定义和引用关系；模型选择文档还需核对 AICc 等准则定义、候选模型集合与排序逻辑，噪声实验核对噪声模型/强度，外推结果核对 out-of-sample 范围；不可把更强的结论当作“更清楚” |
| 技术文档 | 步骤先后、前置条件、警告、版本范围；命令、代码、参数名、API、路径和配置键按项目规则精确保留；Python asyncio 额外核对取消传播与清理、TaskGroup 失败后的任务取消/异常分组，以及 wait_for 与 wait 的超时行为边界；Kubernetes StatefulSet 额外核对稳定身份/存储、无状态工作负载适用边界、缩容不删卷、Headless Service 创建责任、Pod 终止与 OrderedReady 回滚限制；PostgreSQL 事务隔离额外核对默认级别、事务/语句快照边界、并发更新条件重评、Repeatable Read 与 Serializable 的差别、失败后整笔事务重试、SQLSTATE 和唯一约束例外。
| 漫画 | 气泡顺序和说话者、人物关系与口吻、指代、视觉对象/颜色/动作、拟声词；将角色 ID / 说话者元数据保留单独列为结构核验，先独立评译文，再分开判断 OCR 与最终排版/气泡适配 |

### 漫画视觉替代描述（文本单独评估）

`visual_alt_description` 只评估给定源文替代描述的译文，不推断未提供图像里的事实。评审者看到英文源描述和匿名译文；图像、模型身份、其他模型译文及页面原有中文候选在首轮评审时隐藏。原有中文候选只能在首轮标签保存后作为比较材料，不能当作唯一正确答案。模型输入也只包含源描述时，不能把视觉事实核验、OCR、气泡归属、阅读顺序或排版适配算进该任务分数。

分别记录人物/物体/动作/关系准确度、显著细节覆盖、无依据增补、简体中文可读性、名称与术语一致性；各维度 1–5 分，不合成总分。记录完整度、可直接采用状态和可定位错误跨度；无错误或合理措辞差异不强行标错。错误类别及评分锚点见对应任务量表。盲审包必须记录评审者和模型是否看过图像或候选参考；整条样本无法判断时不填伪分。

schema-v2 信封和此任务的字段约束见[视觉替代描述标注 schema 草案](./translation-manga-alt-description-annotation.schema.json)。它不替代数据包层面的校验：样本数、`complete` 与 `completed_samples`、参考暴露状态、span 边界和分配 ID 唯一性还需联合核验。Postext 教程候选目前只有 5 组文本对，尚无模型输出或人工标签；这些候选不作为漫画对白、OCR 或图像理解的证据。

### 漫画对白、旁白与拟声词（无图像文字上下文）

对白与拟声词不能套用替代描述 rubric。评审应获得目标文字区、说话者/区域类型和匿名译文；上下文实验分“目标区单独”与“同页全部源文”，两种条件都不提供图片或中文参考。分别判断意图/语义、说话者声音与关系、简中流畅度；整页条件再评复现名称、指代与跨区一致性；拟声词单列其表达功能，不要求逐字模仿英文拼写。OCR、从画面推断说话者、阅读顺序、气泡适配和视觉理解均不适用于该文本-only 任务。评审与区间按故事/页面聚类，不把 7 个区块视为 7 篇独立作品；专用 rubric 与 84 格计划见[Postext 固定来源包](../../../workspace-data/evidence/translation-benchmark-postext-one-page-six-languages-candidate-20261117/v1/summary-v1.md)。当前评审按用户安排暂缓。

### Kubernetes Service 同页上下文候选 v1

这组候选来自 Kubernetes 官方 v1.32 Service 文档的 10 个英文段落，输入条件仅比较“目标段单独”与“加入同页源文上下文”；3 个模型双重复共 120 格。它不是完整页面；中文 companion 页面和未审术语表都没有传给模型，且本批还没有输出。人工评审按文档聚类，不把 10 段当作 10 篇独立材料。

- **定义与资源边界：**Service、Ingress、selector、endpoint 和 EndpointSlice 不能互换；尤其不能把 Ingress 叫作 Service 类型。
- **字段和端口：**保留 port、targetPort、nodePort 的对象差异；“默认相同”不能变成“必须相同”，NodePort 的范围、逐节点行为和手动分配失败条件都要保留。
- **API 限制：**1000 个 endpoint 的截断只涉及旧 Endpoints API；即使旧负载均衡机制受限，Service 流量仍会发往后端。
- **DNS 与代理：**ExternalName 返回 CNAME、不是代理；保留 IPv4 字符串限制及 HTTP Host / TLS 证书可能不匹配的条件。Headless Service 不分配集群 IP、不由 kube-proxy 处理，并通过 DNS 返回 Pod 地址。
- **配置与上下文：**核对 YAML 键、结构、数值与注释；环境变量方法要求 Service 先于客户端 Pod 创建，但仅用 DNS 时无此顺序要求。
- **策略与职责：**流量策略是严格语义保证，traffic distribution 是偏好；externalIPs 的分配由集群管理员负责。
- **自动诊断：**只报告 YAML/代码字面量、数字和重复术语形式是否变化；模型输出差异只作为上下文敏感性信号，不代表质量提升。

错误跨度、严重度、领域维度和“可直接采用/需修改/不可用/无法判断”分别记录，不合成总分。字段改变、职责主体颠倒、否定反转、把 DNS/CNAME 写成代理或把旧 API 上限说成服务整体停流，应标为 Critical/Major 候选并由双语技术评审确认。当前评分规则是草案，人工评审按用户安排延后。[机器可读 rubric v1](../../../workspace-data/evidence/translation-benchmark-kubernetes-service-context-candidate-20261117/v1/evaluation-rubric-v1.json) · [候选数据与 120 格计划](../../../workspace-data/evidence/translation-benchmark-kubernetes-service-context-candidate-20261117/v1/summary-v1.md)

术语一致性只在**同词义且术语决策适用**的重复项上计分。报告正确检索、正确采用、错误命中和不自然的过度统一，不能只数译文字面是否相同。

科技论文的作者立场需要单独判断：评审先在上下文中标出 hedges、boosters、attitude markers、self-mentions 等表达承担的功能、范围和强度，再评译文是否保留。把审慎判断翻成确定断言、把相关翻成因果、或改变作者/研究对象的主体关系，应记录为立场或语义错误，不当作文风润色。[PLOS One stance-marker 摘要候选](../../../workspace-data/evidence/translation-benchmark-plos-stance-markers-source-only-candidate-20261116/summary.md)只有英文源文和研究者提出的术语候选，没有中文参考译文或人工标签；当前不能产生质量分。

### 科技论文作者立场传递标注 v1

对每个源文立场实例单独记录 `source_span`、`category`、`scope` 和对应 `target_span`。`category` 使用 `hedge`、`booster`、`attitude_marker`、`self_mention`、`other`；`scope` 说明它修饰的命题、结果、比较或贡献。译文传递结果从以下标签中选择，可多选并写明理由：

- `preserved`：目标语保留了相近的交际功能、强度和作用范围；不要求词面对应。
- `strengthened` / `weakened`：断言强度提高 / 降低，记录变化方向和被影响的命题。
- `omitted` / `added`：源文立场在译文中丢失，或译文加入源文没有的作者态度。
- `scope_shift` / `actor_shift`：限定语作用范围变化，或作者、研究者、数据/结果等主体关系变化。
- `cannot_judge`：缺少必要上下文、目标 span 不可对齐或译文本身无法判断；必须说明原因。

源段没有可识别的立场实例时标 `not_applicable`，不能把它算作“保留”。评审先独立标源文及作用范围，再看匿名译文，避免根据译法倒推源文标签。自动抽取只可给候选 span，最终标签由双语评审核验；报告按文档聚类，分别给出立场实例数、可判断数和各传递标签分布，不把多实例当独立文档，也不合成单一排名分。立场漂移同时属于语义准确问题时，可链接到既有错误跨度与严重度，但不重复累计为两个总分。PLOS One 摘要当前是 10 个 source-only 句段，尚无中文参考、译文输出或人工标签；其 10 条术语目标均不是审定词条。

机器可读的篇章评审 schema draft 1.1 新增科学论文 `scientific_stance_review`，按实例保存 cue 类别、源/目标跨度、作用范围、传递效果、严重度、置信度和理由；单个 cue 可以同时标记多种传递效果。通用 `segment_annotations[].errors` 保存共享错误类别、严重度、源/目标跨度与证据。该 schema 是评审导出契约，不会自动为当前数据填标签或分数；现有专业轨道 v2 envelope 的导入器仍需适配。[schema draft 1.1](./translation-document-consistency-annotation.schema.json)

漫画评审先对源区域独立标注类别和阅读顺序，再评各匿名译文，避免用模型译法倒推区域真值。类别可选标题/章节字、旁白/说明、对白气泡、想法气泡、拟声/音效字、招牌/环境文字、其他、类别不清或无法判断。逐次输入需记录 `image_uploaded`，并区分页面图像、已知转录、合成场景描述及其组合；只有文本或 manifest 场景描述、没有给模型看图时，不能按视觉理解能力评分。图像加已知文本可用于视觉上下文配对消融；纯图像条件同时测 OCR、阅读顺序与翻译，三者未分离时不得把 OCR 命中率当作译文质量。HTTP 200 但未满足 JSON/结构契约的响应应记为格式可靠性失败，不当作低质量译文。没有核验气泡类别或实际排版时，只评文本表达简洁度，不推断气泡适配或溢出表现。

原创四页漫画的 v20 图像输入试跑中，图像加转录条件 12/12 与文本基线提示一致，10/12 输出字面发生变化；纯图像条件 8/12 满足 JSON 契约，可解析结果中 OCR 转录 35/36 精确匹配。四个 2B 纯图像响应因重复思考标记而无效；这些是输出格式/可靠性记录。该试跑无人工语义评分、口吻评分或模型排名，不能据此宣称图像输入提升翻译质量。[逐次矩阵与结构报告](../../../workspace-data/evidence/translation-benchmark-manga-multimodal-input-ablation-bilibili-api-20261115/summary.md)。

Pepper&Carrot Episode 26 候选为 56 个英文 / 简中 SVG 文本对象提供了共享 ID，可用作区域级追溯键，但不能代替双语语义审定。其 36 格 API 试跑中检测到 164 处角色标签改写；这是待复核的结构信号，不自动等同于译文错误。标注时分别判断 ID / 角色元数据是否被保留、姓名是否应按经核准的作品术语表本地化，以及气泡正文的语义质量；不要把角色标签变化计入语义分。产品流程可把说话者标识与可译对白分字段传递，并在有意本地化角色名时单独配置规则。[该候选的对齐和运行证据](../../../workspace-data/evidence/translation-benchmark-peppercarrot-ep26-bilibili-api-20261115/summary.md)。
Pepper&Carrot Episode 39 候选新增 115 个 transcript/SVG 区域段，10 个文字页与一个静默视觉上下文页。72 格 Bilibili 试跑包含逐行 ID 输入、`id/kind/speaker/text` 分字段的 JSON 工作流和四页相邻源文上下文对照；40 个成功输出均作结构检查，18 个 JSON 可解析输出中 17 个完整保留非文本字段。一个上下文条件改写了元数据，应由产品层检测并回滚/人工复核；不作为语义错误或质量评分。评审必须单列模型是否收到前页源文、区域角色元数据及原图。[Episode 39 摘要与逐次证据](../../../workspace-data/evidence/translation-benchmark-peppercarrot-ep39-bilibili-api-20261115/summary.md)。
Pepper&Carrot Episode 26 候选为 56 个英文 / 简中 SVG 文本对象提供了共享 ID，可用作区域级追溯键，但不能代替双语语义审定。其 36 格 API 试跑中检测到 164 处角色标签改写；这是待复核的结构信号，不自动等同于译文错误。标注时分别判断 ID / 角色元数据是否被保留、姓名是否应按经核准的作品术语表本地化，以及气泡正文的语义质量；不要把角色标签变化计入语义分。产品流程可把说话者标识与可译对白分字段传递，并在有意本地化角色名时单独配置规则。[该候选的对齐和运行证据](../../../workspace-data/evidence/translation-benchmark-peppercarrot-ep26-bilibili-api-20261115/summary.md)。

### 普通网页文章 rubric v1

新 `general_web_article` 轨道将以下四个维度分开评分，不合成总分：

- **含义准确度：** 事实主张、数量范围、因果/比较关系、否定与限定是否保留。
- **信息完整度：** 是否漏译正文信息，是否擅自增加来源中没有的事实。
- **目标语自然度：** 中文句法、词语搭配和百科/说明性语域是否自然。
- **篇章衔接与文章结构：** 标题层级、段落边界、代词指代、相邻段落关系是否清晰。

来源当前为文本摘录测试，不含页面 DOM、图片、信息框、引用链接或排版。因此不得据此报告链接保留、图片理解或整页恢复质量。每个模型/提示运行成功与否要单列；失败单元不进入偏好或语义评分分母。Wikipedia Capybara 的 9B 两个提示单元各一次恢复后仍为 HTTP 504；NPS 旅行指南与 FAQ 的 9B 专项格、NOAA FAQ 的两个 35B 格也都在一次恢复后仍 HTTP 504。四篇普通网页候选都没有生成盲审页；NPS 两篇各有 5/6 个译文条件，NOAA FAQ 有 4/6，质量评审按用户安排暂缓。


### 普通网页旅行指南 rubric v1

旅行指南在普通网页四个主维度外，另记录以下可诊断检查，不合成额外总分：

- **指令强度与安全边界：** 保留祈使语气、禁止/许可、警示强度与不确定性；不得把建议改成要求，或弱化危险提示。
- **条件与例外：** 准确保留时间、地点、可用性条件、预订要求和例外范围（例如“在有条件的地点”“若露营”），不能把局部建议泛化。
- **列表任务关系：** 不重排、丢失或合并编号；每条标题与后续说明要保持对应，必要的操作对象不能被省略。
- **可执行信息：** 核对专名、地点/机构名、费用/预约/离线内容等对象，以及 `first-come, first-served`、`designated` 等限制语义是否可直接执行。

NPS 十条提示候选只评文本与编号列表结构，没有图片和整页 DOM；未完成的 9B 专项单元仍属服务可用性观察，不纳入质量或偏好统计。

### 公共安全整页网页 rubric v1

GOV.UK 洪水指南整页候选单独检查正文覆盖与操作安全，不与运行可靠性、结构诊断或普通自然度合成总分。源文当前版本是带哈希的读者渲染正文；上游 HTML / 固定 revision 未取得，且翻译输出尚不存在，本 rubric 是待试标规则。

- **自动结构诊断：**核对 1 个 H1、9 个 H2、5 组列表 / 18 个列表项及块顺序；另比对 999、105、Floodline 两个电话号码和“24-hour”等数字字面量。只作为格式/覆盖提示，不代表语义通过。
- **警告强度和范围：**保留普通 flood warning 与 severe flood warning 的差异、生命危险范围及紧急程度，不能弱化、扩大或互换。
- **否定和禁止：**逐项检查涉水通行、在水中触碰电气开关、冒险搬动车辆/财物等限制；反转禁令或漏掉关键禁令列为 Critical。
- **条件与权限主体：**保留“若安全”“可能需要/可能收费”“被应急服务要求撤离”等情态和条件；准确区分用户、当地 council、应急服务、能源/水务机构和 Environment Agency 的行动责任。
- **紧急联系方式：**核对紧急号码、Floodline 电话/文字电话和服务时段；错号、错对象或漏掉立即危险条件列为 Critical/Major。
- **手续和费用限定：**保留抽水去向与许可咨询对象的对应关系，以及消防队可能收费的限定。
- **页面结构与锚文本：**检查 9 个章节及列表/段落顺序、可见链接文字的含义。由于当前源捕获没有 `href` 目标，不评目标地址是否正确；没有 DOM/图片时不评布局和视觉信息。

机器诊断、双语语义标签和整页结构意见分别存储。发生 Critical 安全错误时单独阻止“可直接采用”判断；在双语及公共安全领域复核前，译文不得用于实际应急指导。[页面结构评估规格 v1](../../../workspace-data/evidence/translation-benchmark-govuk-flood-page-capture-20261116/v1/page-structure-evaluation-spec-v1.json)


### 普通网页 FAQ rubric v1

FAQ 除普通网页主维度外，单独检查问答结构和实用边界，不合成额外总分：

- **问答对应：** 每个问题只与其页面答案绑定；保留问句类型、标题层级、答案段落、子列表和相邻问答边界，不能错配答案。
- **问题范围：** 保留答案中的数量范围、地点、适用对象、否定、许可主体和法律/政策限定；不能把“部分”“通常”“并非所有”等写成全称判断。
- **条件与例外：** 准确处理预约渠道参与范围、先到先得条件、允许/禁止活动的地点限制，以及服务犬与宠物/情感支持动物的区分。
- **链接锚文字：** 在文本摘录任务中检查链接锚文字的含义与语序；没有提供链接目标时，不评译文是否恢复链接或指向正确网页。
- **许可 FAQ：** 稳定区分 licensor、licensee、creator、rights holder；保留 BY/NC/ND/SA、copyright 与类似权利、例外/管辖范围、第三方内容提醒以及署名/改动条件，不把说明改写成法律建议。

NPS FAQ 候选仅包含七组可见问答文本；NOAA FAQ 还包含嵌套问题与机会类子标题；Creative Commons FAQ 覆盖许可类别、许可人/被许可人权利边界和署名规则。三者都不含完整网页 DOM 或链接目标；失败模型条件不进入语义或偏好统计。


### 普通网页数据解释文章 rubric v1

数据解释文章沿用普通网页四个主维度，额外记录以下定量理解风险，不合成总分：

- **指标术语：** 区分名义指标、比率、每人均值、购买力平价和币种换算方法；缩写首次展开与后文使用要一致。
- **阈值端点：** 核对小于/不超过、区间端点、单位/币种、统计对象与阈值适用年份；相邻收入档位不得漏档或重叠。
- **时间关系：** 保留首次设定年份、更新周期、估算年份/生效年份及“下一次更新”条件；不能把年度更新误写成实时变化。
- **方法与局限：** 明确区分分类规则、数据来源和作者评论；平均值不代表分布，相关因素不改成因果，来源数据的限制与解释边界必须保留。

OWID 收入分类候选只提供文章正文和阈值列表，不含图表/原始数据；评审可以检查译文数字和方法表达，但数据事实仍应对照文章所引的世界银行来源。

## 6. 配对偏好、仲裁与评审质量

配对偏好选匿名输出标签、`tie`（平局）或 `cant_judge`，并简述胜负依据（含义、完整、术语、自然度、语气或结构）。没有实质差别时应允许平局；不能为了完成排序强迫选择。

两名评审在 Critical/Major、接受性或偏好上有分歧时，由第三名双语/领域仲裁者查看原文、所需上下文和两份原始标签，给出仲裁标签及理由。保留原始双审记录，仲裁不得覆盖它们。每批报告各序数维度完全一致率、相差一档率、逐档混淆、配对偏好一致/平/弃判比例、严重度分歧和仲裁率；文档是 bootstrap 单位。样本允许时另报适合有序数据且可容纳缺失值的 Krippendorff ordinal alpha，并同时给区间；小试标不设未经验证的通过阈值，也不把单一系数当质量结论。Krippendorff 的原始说明涵盖 nominal、ordinal 等测量级别，并允许部分观测缺失：[Krippendorff, 2011](https://www.asc.upenn.edu/sites/default/files/2021-03/Computing%20Krippendorff%27s%20Alpha-Reliability.pdf)。先用覆盖不同内容和难度的小批样本检验指南，修订后冻结版本，再扩到留出集。

## 7. 每条评审记录

至少保存这些字段；无值时显式为 `null`，不要用空字符串伪装“没有错误”。FLORES 试点的离线表单导出 schema 为 v2，状态保存在评审者当前浏览器；导出记录会写明 rubric 版本、未完成样本数和匿名分配指纹。正式分派时把同一份版本化 `blind-review-<assignment_id>.html` 发给两名评审者，保留同指纹的私有映射 sidecar；`blind-review.html` 只作为最新生成版本的预览，不用于跨版本合并。

### 专业内容轨道的共同外层格式

科技论文、技术文档、术语/上下文消融和漫画目前使用 schema v2 外层 envelope。字段约定如下：

- `schema_version` 固定为 `2`；`track` 标识内容轨道；`track_schema_version` 独立演进该轨道的内部字段；`rubric_version` 冻结该批评分规则。
- `dataset_id` 标识数据批次，`blind_assignment_id` 是 64 个十六进制字符组成的匿名分配引用，`reviewer_id` 是任务内代号，`created_at` 记录导出时间。分配引用不包含模型身份；身份 sidecar 保持 owner-only，不能随审阅页分发。
- `context_policy` 记录评审者看到的上下文、翻译系统实际收到的输入、参考译文是否存在以及暴露时机。不能只记录“有上下文”，需区分它给评审者还是给模型。
- `completed_samples`、`total_samples` 和 `complete` 明确标注覆盖度。一个文档、多页漫画和一组消融条件的“完成”规则分别由 `track_schema_version` 定义，不按页面控件数量推测。
- `track_data` 保存该轨道自己的评分结构；保留原单位、成对比较、错误证据和条件字段，不折算为跨领域总分。当前研究者报告会详细说明 `technical_document`、`academic_paper_abstract`、`terminology_context_ablation` 与 `manga_page_translation` 的 payload。

FLORES v2 目前保留其已实现的顶层 `samples` 结构和专用校验器；它是句级适配器，不会校验上述 `track_data`。在通用校验器与轨道适配器完成前，不得混并 FLORES 与专业轨道记录。下方 JSON 是 FLORES 当前导出示例，不代表所有轨道的内部 payload。

```json
{
  "schema_version": 2,
  "dataset_id": "FLORES-200-en-zh-Hans-pilot-v1",
  "rubric_version": "translation-quality-human-v0.2",
  "blind_assignment_id": "<64-character fingerprint>",
  "created_at": "2026-11-14T00:00:00Z",
  "reviewer_id": "R01",
  "context_policy": {
    "reviewer_sees": "source_sentence_only",
    "translation_system_received": "source_sentence_only",
    "context_and_voice_fit": "not_applicable_for_isolated_sentences",
    "reference_translation_hidden_until_after_initial_scoring": true
  },
  "completed_samples": 0,
  "total_samples": 30,
  "samples": [
    {
      "anonymous_id": "F-001",
      "context_scope": "isolated_source_sentence",
      "ratings": {
        "A": {
          "semantic_accuracy": 4,
          "target_naturalness": 3,
          "completeness": "omission",
          "highest_error_severity": "major",
          "acceptability": "revise",
          "context_and_voice_fit": "not_applicable",
          "errors": [{
            "category": "mistranslation",
            "severity": "major",
            "source_span": "source excerpt",
            "target_span": "translation excerpt",
            "evidence": "Explain the meaning change"
          }],
          "note": null
        }
      },
      "preference": {"selected": null, "rationale": null},
      "complete": false
    }
  ]
}
```

每位评审者导出一份匿名记录；系统每次生成盲审页时用操作系统随机数创建新的标签分配，导出只携带对应映射的 SHA-256 指纹，不含随机种子或模型身份。模型/服务身份映射在双审完成前不与记录合并。仲裁标签写入单独的 `adjudication` sidecar，保留两份原始标注和仲裁者理由，不回写覆盖评审者导出。

收到所有评审导出后，先运行 [FLORES 人评导出校验器](../../../workspace-data/evidence/translation-benchmark-flores200-pilot-20261114/validate-human-review.py)：

```bash
python3 workspace-data/evidence/translation-benchmark-flores200-pilot-20261114/validate-human-review.py reviewer-1.json reviewer-2.json --output validation-summary.json
```

退出码 `0` 表示双审完整且可进入解盲；`1` 表示 JSON 结构有效，但评审者数量或完成度不足；`2` 表示结构、值域或盲审边界不合法。输出只包含匿名评审代号、完成数量和问题位置，不复制源文、译文、跨度或自由文本。

校验通过后，先在仍保持盲态时计算评审一致性：

```bash
python3 workspace-data/evidence/translation-benchmark-flores200-pilot-20261114/analyze-human-review-agreement.py reviewer-1.json reviewer-2.json --output blind-agreement.json
```

报告含各维度完全一致率、相邻档一致率、有序/名义 Krippendorff α、错误类别集合 Jaccard，以及按源样本成簇的 bootstrap 区间；它不会输出每条评审自由文本或读取模型名称来排名。对重要分歧完成仲裁后，再单独解盲并做模型层面的质量比较。

专业轨道用[track-aware v2 导出校验器](../../../workspace-data/evidence/translation-benchmark-v2-track-migration-20261114/validate-professional-review-v2.py)检查共同 envelope、轨道字段、完整度、匿名分配引用和身份泄漏。示例：

```bash
python3 workspace-data/evidence/translation-benchmark-v2-track-migration-20261114/validate-professional-review-v2.py \
  --track technical_document \
  --evidence-dir workspace-data/evidence/translation-benchmark-kubernetes-deployment-bilibili-api-20261114 \
  --output validation-summary.json reviewer-1.json reviewer-2.json
```

退出码 `0` 仅表示双审记录可进入**盲态一致性分析**；`1` 表示记录有效但数量或完成度不足；`2` 表示结构、值域、匿名分配或盲态边界无效。该校验器不会读取私人身份映射来解盲，也不会计算一致性或排名。

专业轨道现有[盲态一致性分析器](../../../workspace-data/evidence/translation-benchmark-v2-track-migration-20261114/analyze-professional-review-agreement.py)支持四种 v2 轨道。它先调用对应校验器，只接受同一分配版本的完整真人双审；明确拒绝合成 dry-run。它按评分量表报告完全一致、有序评分相差一档、名义/序数 Krippendorff α，并按独立来源文档/作品做 percentile bootstrap；少于两个独立来源簇时不输出区间。漫画页图像开启状态不同的条目不会混作相同审阅上下文；参考译文揭示状态不同则停止分析。输出只留聚合统计，不解盲，也不生成模型排名。调用示例：

```bash
python3 workspace-data/evidence/translation-benchmark-v2-track-migration-20261114/analyze-professional-review-agreement.py \
  --track technical_document \
  --evidence-dir workspace-data/evidence/translation-benchmark-kubernetes-deployment-bilibili-api-20261114 \
  --output workspace-data/evidence/translation-benchmark-kubernetes-deployment-bilibili-api-20261114/human-agreement.json \
  reviewer-1.json reviewer-2.json
```

当前没有专业轨道或 FLORES 真人导出，因此没有真实一致性数值。v32 技术轨道现有 12 条来源文档记录，分属 8 个来源组（5 篇 Kubernetes 页面共用一组；MDN、CPython、Rust Book、PostgreSQL、Docker Docs、GitHub Docs 和 Go 官方网站各自分组）；论文轨道现有 8 篇（6 篇摘要、2 篇全文候选），其中 ACL 新增一篇 147 词、source-only 的文档上下文评估摘要。PLOS 和 ACL 全文分别有 7 与 6 个稳定 ID 子单元，PostgreSQL 页面有 9 个段落子单元，Go Getting Started 有 8 个稳定段落 ID。MDN Promise bundle 与 PostgreSQL 18 并发更新段均有无上下文、相关源文上下文和重复目标控制的重复运行；二者都只有单文档/单目标束的人评前信号，不能替代双语评分。PostgreSQL 的 `section` 元数据仅 4/18 受控输出原样保留。Kubernetes Jobs 8 个源段配有同提交简中译文候选，其中 1 个未选入配对集的回退上限段落被记录为同提交内容错位风险；Go 教程和 ACL 摘要没有中文参考文本。漫画轨道新增四页、17 个冻结英文区域；本轮只有逐字稿文本输出，区域类型仍待审，图像条件因外传授权审查拒绝而未运行。所有官方译文候选仍待双审，不能当作金标准。摘要/前文上下文属于模型输入消融，评审时明确暴露范围。新增全文和技术文档候选均没有人工评分，不能据此判断模型优劣。

另一项未完成的数据契约缺口是专业轨道 v2 envelope 的 `error_evidence`、`segment_error_evidence`、`line_notes` 等现有字段仍是自由文本，现有分析器不解析它们。篇章一致性 schema draft 1.1 提供了结构化错误证据与科学立场 sidecar 形状，但没有迁移既有导出或分析器，因此目前仍不能从历史专业轨道批次报告错误类型、错误跨度及其双审一致性。后续导入器需逐字段映射，并保留原始自由文本与迁移来源。

正式输出的模型/服务映射单独保存，直到盲审完成才与人工记录合并。人工身份只用任务内代号。来源、许可、语言方向、摘录位置、运行配置、输入上下文和模型输出应与评审标签可追溯关联；不得在评审导出中带入 API 密钥、真实用户网页或未授权内容。

## 8. 试标后的发布条件

发布一个可比较的版本前，核对源文档许可和文档级留出切分；检查每个样本都有对应运行、两名独立评审或明确的未完成状态；汇总双审分歧与仲裁；报告文档数和各类错误分母。没有达到这些条件的数据可以留作回归线索，不进入公开排行榜或质量提升声明。

PLOS One 材料科学摘要另准备了 10 项 source-first 立场标注队列：评审者可先在同摘要上下文中识别源文 cue 和命题范围，不显示研究者提出的术语候选、中文译文或模型身份。队列已经过源哈希与目标覆盖核验，但尚未分配评审者；后续模型译文出现后，才按 schema draft 1.1 记录立场传递标签。[source-first packet](../../../workspace-data/evidence/translation-benchmark-plos-stance-markers-source-only-candidate-20261116/context-ablation-v1/ source-stance-review-packet-summary-v1.md) · [机器可读任务](../../../workspace-data/evidence/translation-benchmark-plos-stance-markers-source-only-candidate-20261116/context-ablation-v1/ source-stance-review-packet-v1.json)
