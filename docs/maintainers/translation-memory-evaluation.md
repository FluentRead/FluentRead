# 翻译记忆与术语作用域评估

更新日期：2026-11-19  
状态：确定性检索/作用域合同试跑、真实网页与漫画提示消融、Kubernetes 技术文档本地术语保护 × 上下文交互试跑，以及合成跨项目术语采用试跑已完成；跨轨道候选索引为 v9，共 274 条。另有 MDN AbortSignal 整页英中词面观察与 Wikipedia Capybara 源语词面观察侧车，均不计入该 registry。全部真实词条仍待双语审定、0 条批准为持久记忆、0 条进入模型输入；真实术语对译文质量的影响和用户收益尚未评估。

## 评估边界

FluentRead 现有本地能力中有两种不同对象，不能合称为一个“记忆”指标：

| 机制 | 保存什么 | 当前生效方式 | 评估重点 |
| --- | --- | --- | --- |
| 术语库 | 用户维护的源词 → 目标词条，可限定语言、网站、启用状态和显式选中的库 | 本地检索本次输入实际命中的词条，用占位符保护，服务只接收受保护文本与必要指令；不发送整本术语库 | 检索召回、错域/错语言泄漏、长短语冲突、词条精确保护与周围句自然度 |
| 个人校订 | 用户确认过的整句译法、语言、章节上下文与材料/项目范围 | 精确匹配可识别当前记录；近似句最多给 5 条参考候选，由用户选入草稿并预览保存；不自动替换当前译文 | 精确命中率、项目/材料隔离、上下文适用性、近似候选 precision@5、冲突是否要求人工决定 |

实现依据：[术语库匹配](../../src/core/glossary/match.ts)、[术语占位保护](../../src/services/translation/glossaryProtection.ts)、[个人校订匹配](../../src/core/personal-corrections/matching.ts)、[主动确认流程](../../src/features/personal-corrections/controller.ts)、[本地术语库说明](../guide/glossary.md)。

## 当前检索合同试跑

机器可读候选集位于 [`translation-memory-retrieval-pilot-20261114`](../../../workspace-data/evidence/translation-memory-retrieval-pilot-20261114/README.md)。它包含 13 个个人校订案例和 13 个术语库案例，使用全合成英文材料，不含用户网页、用户校订或许可未明的原文。runner 直接导入当前 FluentRead 的 TypeScript 纯函数，记录 Git revision 和被测文件 SHA-256。

本次 26/26 案例与候选合同标签一致：

- 个人校订覆盖材料/项目命中、跨项目与未加入项目拒绝、章节字符串变化、语言标签差异、精确冲突、近似候选阈值、top-5 限制与“近似只建议、不自动采用”。
- 术语库覆盖同词异义（`token` → “词元”/“令牌”）、网站与通配域名、`null` 继承和 `[]` 明确停用、目标语言、区分大小写、长短语重叠及库优先级冲突。

这只证明本地检索函数符合当前数据合同，不能证明合同适合用户，也不评翻译输出。尤其个人校订对源/目标语言和章节上下文使用精确字符串匹配；`zh-CN` 与 `zh-Hans` 目前不会共用记录。是否应归一化语言别名、是否应将章节文本改为稳定章节 ID，属于产品决策，不能靠放宽匹配阈值处理。

运行结果见[机器报告](../../../workspace-data/evidence/translation-memory-retrieval-pilot-20261114/retrieval-evaluation.json)和[完整运行日志](../../../workspace-data/evidence/translation-memory-retrieval-pilot-20261114/retrieval-benchmark.log)。该小型候选集不是发布门槛，也不替代边界、回归或浏览器验证。

## 真实网页术语保护链路试跑

[OWID 收入分类解释文章的配对试跑](../../../workspace-data/evidence/translation-glossary-owid-core-ablation-bilibili-api-20261114/summary.md)从父来源快照中抽取 3 段（1,137 字符），用 FluentRead 当前 core glossary 函数解析 12 个未审核候选词条、命中 14 处，再比较空词库与本地保护/恢复。三模型直连专项提示矩阵为 18 格，HTTP 200 为 18/18；2B、9B 各有 2/3 个保护格在恢复阶段被严格拒绝，35B-A3B 为 3/3。另按 FluentRead Bilibili 适配器的固定模型和请求提示做了 6 格试跑，HTTP 200 与恢复均为 6/6。

这不是完整 broker/provider 生命周期的端到端运行，也没有人工判断候选词条是否合适。成功恢复只说明占位符完整、译法能够本地回填；输出变化不等于质量改善。小模型直连探测不代表 FluentRead 的 Bilibili 服务，因为该服务固定使用 35B-A3B。人工双审和翻译质量评分仍按用户安排暂缓。

## 三份真实来源的本地术语机会审计

[三类来源的候选术语审计](../../../workspace-data/evidence/translation-memory-real-source-scope-audit-20261115/summary.md)把 MDN `Using promises`、PostgreSQL 18 事务隔离和 OWID 收入分类摘录接入 FluentRead 当前 `resolveGlossaryEntries()` 与 `protectGlossaryText()` 纯函数。候选列表共有 20 条未审词项：MDN 3 条、PostgreSQL 5 条、OWID 12 条。正确站点/语言/已选词库下，本地检索找到字面机会词项分别为 3/3、5/5、12/12，登记到 6、26、14 个非重叠受保护出现位置；15/15 个错域、停用、语言不匹配和错误库选择负向控制均未泄漏。

14/14 个含命中的段落经过保护占位再原样回送恢复，得到按候选译法替换的结果且未残留 token。这是**本地检索/回填可靠性信号**，不是经标注的召回率或翻译记忆收益。所有映射仍未审定；本次没有 API 调用、真人评审或模型质量分，也未运行完整 broker 生命周期。

## 真实技术文档项目级术语候选队列

[术语候选包](../../../workspace-data/evidence/translation-memory-technical-candidate-20261116/summary.md)现有 45 条 Astro、Ant Design、Vite 和 React 项目级词项，分别为 9、13、8、15 条。React 的 15 条来自同项目两篇页面；其他项目各有一篇。每条保留源/译候选上下文、segment ID、术语类型与作用域。

中文候选来自待审的 test 参考段，因此 45/45 均标记为 eligible_for_model_input=false，不能用于翻译同一批评测段。后续记忆效应试验需要与 test 文档分离的已批准词库，并比较无词库、同项目词库、错误项目或无关词条干扰。当前数据仍不足以估计跨项目记忆收益。Vite 中文参考另有 CC BY-NC-SA 4.0 用途限制待审。

[机器可读队列](../../../workspace-data/evidence/translation-memory-technical-candidate-20261116/term-candidates-v1.jsonl) · [实验与作用域设计](../../../workspace-data/evidence/translation-memory-technical-candidate-20261116/study-design-v1.json) · [7 项校验，0 问题](../../../workspace-data/evidence/translation-memory-technical-candidate-20261116/validation-report-v1.json)

## 漫画跨页候选词表提示试跑

[Pepper&Carrot Episode 26 跨页词表试跑](../../../workspace-data/evidence/translation-glossary-manga-memory-ep26-bilibili-api-20261115/summary.md)从同作品的官方简中候选译文中取 `dungeon → 洞穴` 和 `Carrot → 萝卜头` 两条**未审定**词项，分别在后续页面 P03/P05 做同模型、同页漫画提示配对。六格 Bilibili 请求均返回；无词表基线没有出现候选译词的精确字串，加入词项后 6/6 出现，且六个译文均有文本变化。六个输出都保留区域编号顺序，说话者标签原样保留 3/6。

这是直接把少量词项拼入提示的显式词表消融，不是 FluentRead 的本地匹配、占位保护、回填或持久用户记忆。词条本身来自未审定的官方本地化候选；字面采用率不能证明词义适用、译文更准确或更自然。人工双语审定按用户安排暂缓，Bilibili 输出用途与留存仍待审核。

## FluentRead 原创漫画夹具重复词面基线

在已有四页漫画夹具中，英语表面 `ferry` 出现在两个区域；整页数组与单区域条件共 12 个可读模型输出均出现“渡轮”这一候选词面。页面响应与单区域响应中有 2 格依靠结构恢复、10 格严格满足 JSON 契约。此次未发送术语表、未增加 API 调用、未做人工判断或质量评分。

这只是 1 个词项 × 2 个区域 × 1 个作品来源组，且基线输出已一致；不能估计术语记忆收益。因此不在这份漫画夹具上补一个低信息量的术语表开关矩阵。后续记忆试验应优先选择跨多段反复出现、有词义/项目作用域冲突、且已由双语专家审定目标变体的技术文档词项；本候选不能进入持久记忆。[词面观察摘要与逐格证据](../../../workspace-data/evidence/translation-benchmark-manga-color-quality-bilibili-api-20261115/segment-only-matrix-v1/term-surface-baseline-v1/summary-v1.md) · [机器报告](../../../workspace-data/evidence/translation-benchmark-manga-color-quality-bilibili-api-20261115/segment-only-matrix-v1/term-surface-baseline-v1/term-surface-baseline-v1.json)

## Kubernetes StatefulSet 上下文 × 本地术语保护

[受控试跑](../../../workspace-data/evidence/translation-memory-document-context-k8s-statefulset-controlled-bilibili-api-20261115/summary.md)新增 Kubernetes StatefulSet 技术文档 bundle：6 个目标段、3 个同文档上下文段、7 条未审核候选映射。三模型 × 无上下文/有上下文 × 无术语保护/FluentRead 本地占位保护 × 两次重复，共 24 格；22/24 首轮 HTTP 200，35B-A3B 的上下文 + 术语保护格两次 504，完全相同的两条请求重试后仍 504。

首轮有译文的术语保护格中，8/10 完整通过占位回填；2B 在上下文 + 术语保护下，两次都在同一个终止说明段漏掉一个标记，9B 为 2/2 完整，35B 两次没有可用输出。这个观察同时覆盖真实技术文档、上下文交互和当前本地保护函数，但仍是一个来源文档；词条及官方简中对齐未审定，不能作为质量、术语正确率或模型排名。API 结构、超时、占位恢复和 token/延迟分别报告；双语评审继续暂缓。

候选映射中的 `persistent storage → 持久化的存储` 是研究者提出的待审变体；同页官方候选原文为“持久的存储”。实际执行词表另存快照，后续词表说明调整不会改写这次运行记录。

这组结果也给出一条产品验收要求：JSON/ID 合规与词条占位回填必须是分开的状态；标记丢失时不能把该段当成已完成。对于 `graceful` 这类上下文译法可能变化的词项，界面应显示词条来源与作用范围，允许关闭本次强制保护或保留局部表达，不把单条候选悄悄升级成整篇固定规则。

## 合成跨项目术语记忆影响试跑

[合成跨项目实验](../../../workspace-data/evidence/translation-memory-synthetic-polysemy-bilibili-api-20261115/summary.md)在模型系统文档与身份认证平台文档两个虚构项目中，测试同形词 `token` 的项目范围切换，以及重叠词组 `access token` 的长短语优先级。语料有 8 个英文分段、3 个构造术语目标；映射明确标为未经过双语审定。FluentRead 当前 core glossary 纯函数的正确作用域检索、错项目/错域/停用/未选择负例共 8/8 通过，保护与恢复预检覆盖 8 个分段。

对 2B、9B、35B-A3B 分别运行无词条、显式作用域术语提示、本地占位保护/恢复三种条件，每格重复两次，共 36 次 Bilibili 请求，36/36 HTTP 200。构造目标字符串命中 136/144 个机会：9B 与 35B-A3B 各 48/48；2B 为 40/48，8 个未命中全部来自模型系统项目的无词条条件，显式提示和本地保护条件各 8/8。未发现本实验枚举的替代词目标；48/48 个保护 token 精确保留并成功恢复。

JSON 合约单独统计：严格 JSON 是 24/36，所有 36 格均可从提示标签包装文本中提取出 ID 顺序和非空文本都正确的数组。该现象是本实验多段 JSON 请求的模型格式信号，不等同于 FluentRead 当前页面翻译 UI 缺陷。两次重复的归一化译文中，35B-A3B 在 6 组里有 3 组不同，2B/9B 的 12 组相同；两次运行不足以估计模型方差。详细原始请求/响应、指标分母和可重算评估见[实验包](../../../workspace-data/evidence/translation-memory-synthetic-polysemy-bilibili-api-20261115/experiment-design.json)、[结果摘要](../../../workspace-data/evidence/translation-memory-synthetic-polysemy-bilibili-api-20261115/summary.md)与[逐次评估](../../../workspace-data/evidence/translation-memory-synthetic-polysemy-bilibili-api-20261115/evaluated-results.json)。

这些数字只表示构造目标词串的采用信号，不是语义充分性、自然度或质量分；模型系统无词条基线已出现构造映射的地板效应，2B 的单一差异也不能外推到真实项目。此试跑没有上传图像、网页、用户数据或外部参考译文，也没有覆盖浏览器和 provider 生命周期。人工双审依用户安排暂缓，未审核词条不得据此变为产品金标准。

## 合成跨项目多术语扩展与产品提示探针

[扩展实验包](../../../workspace-data/evidence/translation-memory-synthetic-polysemy-expanded-bilibili-api-20261115/summary.md)把语料扩到 20 段、两个虚构项目、5 种源词形式（`token`、`access token`、`scope`、`prompt`、`claim`）和 9 条构造词条，共 378 个计划术语机会。正确作用域检索覆盖全部 21 个文档内机会；8/8 个错选择、错域、停用和未选择负向控制通过，21 个保护词位回环通过。

Bilibili 首轮 36 格中 32 格 HTTP 200，4 格 504 全在 35B-A3B 本地保护条件；每格一次原样重试仍是 504。故 378 个机会中只对有完整输出的 336 个评分，命中 284/336、另 42 个标为未评分。显式术语条件命中 126/126；无术语条件命中 74/126，出现 20 次所枚举的跨项目替代目标词；成功返回的 2B/9B 本地保护条件为 84/84，35B 的 42 个机会不可评分。不得用完整案例比率给模型排总名次。

另外对 4 个分段使用 FluentRead 当前 Bilibili 适配器生产提示、35B 固定模型和单段文本请求，8/8 返回 HTTP 200；无词条目标串命中 3/5，本地保护后命中 5/5，5/5 个占位符精确保留并完成 4/4 个分段恢复。这说明 35B 能处理本组单段产品提示，但无法解释大批量 JSON 条件的 504；批量数量和输出合约同时变化，根因仍未隔离。该探针也未执行 browser broker/runtimeFetch 生命周期。

扩展数据仍完全合成，目标映射未双语审定。指标仅测构造词串采用、结构和服务可用性，不是译文语义质量或自然度。未上传用户网页、图像或参考译文；双语人工评审依用户安排暂缓。[扩展矩阵与逐次结果](../../../workspace-data/evidence/translation-memory-synthetic-polysemy-expanded-bilibili-api-20261115/evaluated-results.json) · [单段产品提示探针](../../../workspace-data/evidence/translation-memory-synthetic-polysemy-expanded-bilibili-api-20261115/product-prompt-probe/summary.md)

## 翻译质量影响的下一阶段

必须把“能否找到正确的记忆”和“记忆是否让译文变好”分开测。检索合同先固定后，对同一文档、同一分段和同一底层模型做配对条件：

1. 无词条保护 vs. 用户明确选中的同作用域术语库，使用 FluentRead 实际占位/恢复请求路径。
2. 同词异义的两个项目各自使用独立术语库；负向控制检查错项目词条不进入请求。
3. 个人校订保留为用户触发的草稿建议。若未来要把已确认校订注入模型上下文，作为一个新功能条件单独实验，不能把当前面板的候选建议说成自动翻译记忆。
4. 短上下文逐档增加邻段、同章定义和章节摘要；评审者固定看到完整材料，模型输入逐条件记录哈希和实际边界。

每个词义先人工标注“相关词条机会”，然后分别报告：合格记忆检索召回、错作用域命中率、词条正确采用率、同义同词一致率、错义迁移率、过度统一率、准确度/自然度和关键错误。分母按机会计，文档仍是统计单位；相同拼写但不同词义不能算作不一致。章节摘要或已有译文可能传播上游错误，因此另标“上下文污染”。

直接把 glossary 文本拼进 Bilibili 提示词，是一种**显式提示消融**，不是 FluentRead 当前本地占位保护机制；结果只能归到提示条件。需要评估产品效果时，应复用实际保护/恢复管线，并在每次运行证据中记录命中的条目 ID、scope reason、请求摘要和回填结果，但不保存整本用户词库或任何真实用户网页内容。

## 数据与发布门槛

- 第一版只用合成多项目语料，明确标出每条词项的词义、适用项目、语言、章节和负向同形词；当前两项目 8 段实验只是构造映射的机制试跑。通过检索合同试跑后，才用许可证允许的公开技术文档扩为留出集。
- 两位双语且有相应技术领域经验的评审独立判断词义、候选译法、合理变体和上下文污染；冲突词条由第三人仲裁。未经人工确认的自动抽取词条只能是候选，不得当作金标准。
- 报告检索指标与译文指标的分母、文档数、运行次数、失败/费用/延迟；不将它们加权为一个“记忆提升分”。
- 用户记忆只按用户明确选定的材料/项目/网站范围读取；建议展示命中来源及作用域，保存前要求确认，并提供禁用、删除和撤销。不得把一次改写自动变成全局词条或跨项目记忆。

## 科学论文术语与跨段一致性候选

[PLOS HFMD source-only 候选](../../../workspace-data/evidence/translation-benchmark-plos-hfmd-source-only-candidate-20261116/summary.md)额外登记 11 个源语术语及其在同一篇摘要中的出现位置，涵盖 HFMD、EV-A71、CV-A16、TSIR、基本再生数、交叉保护、血清型替代和群体免疫等。所有 `target_term_candidate` 均为空，`approved_for_memory=false` 且 `eligible_for_model_input=false`；v51 已将来源论文登记为未分区 source-only 记录。这些条目只是后续双语标注队列，不是记忆收益证据。

若后续翻译并评审该文档，可分别测固定实体/缩写译法的一致性、正确性与自然度；术语一致不代表语义正确，也不能把多个句段当作多个独立论文。该文档仍是单一来源组，不能支持通用排名。

## React 状态更新队列术语与跨页一致性候选

[React Queueing 候选包](../../../workspace-data/evidence/translation-benchmark-react-queueing-reference-candidate-20261116/summary.md)新增 9 个未审术语候选，包括 `state`、`batching`、`render`、`updater function`、`queue` 与 `Strict Mode`。候选保留此页上游译文的出现形式；例如 batching 同时出现“批处理”和“批量更新”，可作为合理变体与固定术语偏好的标注任务。所有目标形式均为候选，`approved_for_memory=false`、`eligible_for_model_input=false`，不用于翻译这篇 test 候选文档。

它和 State as a Snapshot 等 React 页面共享 `react-docs` 作用域，适合后续按词义标注页内/跨页一致性、合理变体和错误传播。当前没有检索召回或译文改善的测量；同一项目的段落仍按文档聚类统计。[术语候选 JSONL](../../../workspace-data/evidence/translation-benchmark-react-queueing-reference-candidate-20261116/term-candidates-v1.jsonl) · [候选与评估限制](../../../workspace-data/evidence/translation-benchmark-react-queueing-reference-candidate-20261116/study-design-v1.json)

## 多篇 React 技术文档术语候选聚合 v2

[术语聚合 v2](../../../workspace-data/evidence/translation-memory-technical-candidate-20261116/v2/summary-v2.md)把 Astro、Ant Design、Vite 与四篇 React 文档的候选整理为 66 条记录、131 个段落出现证据，覆盖 7 篇文档、4 个项目作用域。全部中文译法仍待双语确认，approved 0、model-eligible 0；不得将 test 参考候选注入同文翻译请求。

当前 66 条中，严格按英文源词字面与项目作用域分组，只有 `state` 一组在多个文档出现，而且只有两个新增 React 页面参与该组。这是候选抽取覆盖的局限，不是语料整体缺少重复术语，也不能形成一致性分数。下一步应有意抽取跨页同义概念和同形异义词，再由评审标出词义、可接受译法、首选变体与错域风险。[66 条 JSONL](../../../workspace-data/evidence/translation-memory-technical-candidate-20261116/v2/term-candidates-v2.jsonl) · [重复词面审计](../../../workspace-data/evidence/translation-memory-technical-candidate-20261116/v2/term-surface-audit-v2.json) · [实验设计](../../../workspace-data/evidence/translation-memory-technical-candidate-20261116/v2/study-design-v2.json) · [9 项校验](../../../workspace-data/evidence/translation-memory-technical-candidate-20261116/v2/validation-report-v2.json)

## React state-structure 术语候选扩充

[Choosing the State Structure 候选](../../../workspace-data/evidence/translation-benchmark-react-state-structure-reference-candidate-20261116/summary.md)再增加 12 条未审术语表面，涉及 `state`、`props`、redundant/duplicate/nested state、flatten/normalize 和 selected ID。与 Queueing、State as a Snapshot 等页面一同聚合后，v2 有 66 条 term records、131 个段落出现证据，覆盖 7 篇文档、4 个项目作用域；approved 和 model-eligible 仍都为 0。

严格按源词字符串统计，这 66 条里只有一组词面跨文档出现（`state`，仅出现在两个新增 React 页面），因此当前抽取不足以代表真实的跨文档记忆覆盖。必须先人工标词义和可接受变体，再有意增加同概念跨页样本；不能拿字符串表面计数当一致性质量分。[聚合词条](../../../workspace-data/evidence/translation-memory-technical-candidate-20261116/v2/term-candidates-v2.jsonl) · [表面重复审计](../../../workspace-data/evidence/translation-memory-technical-candidate-20261116/v2/term-surface-audit-v2.json) · [v2 校验报告](../../../workspace-data/evidence/translation-memory-technical-candidate-20261116/v2/validation-report-v2.json)


### React 四页 state guides 词项位置 sidecar v1

新的 excerpt packet 从四个 React 文档抽取 `state`、`render`、`update`、`object`、`mutation`、`immutable` 六组英中表面候选，分别锚定到 44 个源文/未审目标段哈希，共 12 条按语言分开的观察行。它扩充了跨页词项位置数据，但没有把英文词和中文表面自动配对，也没有加入 registry v9、批准词库或模型输入；目标页评审历史仍按原候选包的限制处理。[观察和字符跨度](../../../workspace-data/evidence/translation-document-understanding-react-state-guides-cross-document-20261118/v1/term-occurrence-candidates-v1.jsonl) · [逐页来源与许可](../../../workspace-data/evidence/translation-document-understanding-react-state-guides-cross-document-20261118/v1/source-document-manifest-v1.jsonl) · [12 行跨度校验](../../../workspace-data/evidence/translation-document-understanding-react-state-guides-cross-document-20261118/v1/validation-report-v1.json)

## TypeScript Handbook 术语候选与聚合 v3

TypeScript Handbook Basics 增加 8 条未审术语候选和 11 个选中段落出现上下文，包括 type-checker、type annotations、erased away、noImplicitAny、strictNullChecks 及 null。它们来自同一待审 test 文档，不能输入该文档的翻译请求。

2026-11-19 的 TypeScript v2 矩阵已完成 90 格通用/技术专用提示对照；8 条术语仍未审、未输入，且本矩阵没有 glossary 条件。因而它只用于提示流程与模型候选的盲态评审准备，不是术语记忆收益实验。后续 glossary-on/off 实验应先独立审定词条、把同一源段随机分到条件，并保留不含记忆的基线。[v2 执行和盲态池摘要](../../../workspace-data/evidence/translation-benchmark-typescript-basics-reference-candidate-20261116/v2/summary-v2.md)

同日 Astro Routing 新增 36 格通用/专用提示矩阵，同样未输入词表且没有 context 条件。虽可用于技术文档术语一致性盲审，但它不是 memory-on/off 结果；Astro 译文候选中的术语形式也需双语审定后才可加入记忆。当前两篇技术文档的提示比较须按来源组分别报告。[Astro 执行和盲态池摘要](../../../workspace-data/evidence/translation-benchmark-astro-routing-reference-candidate-20261116/v2/summary-v2.md)

Ant Design Form 已预注册 60 格上下文消融，比较目标单独输入与同页其他七个选段上下文，聚焦 `dependencies`、`shouldUpdate` 的重复用法。中文参考与未审词库没有传入；请求文件哈希 60/60 通过，但本机 DNS 检查失败、HTTP/译文仍为 0，官方页面可访问但 API POST 未从本机确认。这一设计可观察上下文是否改变重复字面量的呈现，不等于词汇记忆实验，也不能以术语字符串一致代替人工语义判断。[实验计划与物化审计](../../../workspace-data/evidence/translation-benchmark-ant-design-form-reference-candidate-20261116/context-ablation-v1/execution-v1/materialization-report-v1.json) · [Bilibili 页面与 API 路由对账](../../../workspace-data/evidence/translation-benchmark-ant-design-form-reference-candidate-20261116/context-ablation-v1/execution-v1/provider-route-status-v1.json)

术语聚合 v3 将 Astro、Ant Design、Vite、React 与 TypeScript 合并为 74 条候选、142 个选中段落上下文，覆盖 8 篇文档和 5 个项目作用域。所有词条 approved 为 0、model-eligible 为 0、人工裁定为 0。精确词面审计仍只有 1 个同作用域跨文档重复组（state），这是当前抽取的覆盖结果，不是语料整体的一致性分数；后续需先标注词义、可接受变体和跨项目适用范围，再设计相互独立的检索留出集。[术语 v3 汇总](../../../workspace-data/evidence/translation-memory-technical-candidate-20261116/v3/summary-v3.md) · [74 条候选](../../../workspace-data/evidence/translation-memory-technical-candidate-20261116/v3/term-candidates-v3.jsonl) · [词面覆盖审计](../../../workspace-data/evidence/translation-memory-technical-candidate-20261116/v3/term-surface-audit-v3.json) · [v3 校验](../../../workspace-data/evidence/translation-memory-technical-candidate-20261116/v3/validation-report-v3.json)


## PLOS One 学术立场术语候选

[PLOS One stance-marker 摘要](../../../workspace-data/evidence/translation-benchmark-plos-stance-markers-source-only-candidate-20261116/summary.md)增加 10 条未审的术语建议，包括 stance marker、hedge、booster、attitude marker、self-mention 和 journal quartile。源文文章采用 CC BY 4.0，但没有中文参考译文；术语目标只是候选，记忆批准与模型输入资格均为 false。该材料不并入技术文档术语聚合，也不用于翻译其自身段落。只有经过双语评审并在来源隔离的文档上测试，才能判断这些词条是否适合作为学术项目记忆。

## 跨轨道候选索引 v1

新建[跨轨道术语候选索引](../../../workspace-data/evidence/translation-memory-candidate-registry-20261116/v1/summary-v1.md)，合并技术文档 66 条、MDN/PostgreSQL/OWID 20 条、PLOS HFMD 11 条、PLOS One 10 条和 Pepper&Carrot 2 条，共 109 条，覆盖 13 篇来源文档、10 个来源组。98 条带有目标词面候选，11 条 HFMD 项仅有英文词项和来源段落位置。候选资料均未批准为持久术语记忆，未来模型输入资格仍为 0。

该索引保留术语 ID、来源组/分区、词面候选、片段 ID、哈希、审阅状态和历史试验使用标记，不复制完整上下文。14 条曾出现在隔离提示实验中（12 条 OWID、2 条 Pepper&Carrot）；这只记录历史输入，不构成准入或质量证据。8 条 Vite 候选留在 intake，未登记入 v51 主清单，因其简中仓库的许可范围仍待核实。逐字重复词面只用于排队，不能视作同义或首选译法。[JSONL 索引](../../../workspace-data/evidence/translation-memory-candidate-registry-20261116/v1/term-memory-candidate-registry-v1.jsonl) · [索引校验](../../../workspace-data/evidence/translation-memory-candidate-registry-20261116/v1/validation-report-v1.json)

## 跨轨道候选索引 v4

v4 保留 v3 的 132 条记录，并新增 9 条来自 UNESCO Funmilayo 印刷页 31-40 的源语候选，共 141 条，覆盖 14 篇来源文档、11 个来源组。全库有 98 条目标表面候选和 43 条 source-only 项；批准为持久记忆 0，未来模型输入资格 0。新增候选包括 Aba、Native Court、Ademola、no tax without representation、local market wardens、district officer、colonial order、colonial state 和 flat-tax；译法、词义和出现跨度均待审，未进入 Bilibili 输入。[v4 摘要和校验](../../../workspace-data/evidence/translation-memory-candidate-registry-20261116/v4/summary-v4.md) · [141 条机器可读候选](../../../workspace-data/evidence/translation-memory-candidate-registry-20261116/v4/term-memory-candidate-registry-v4.jsonl) · [v3 历史版本](../../../workspace-data/evidence/translation-memory-candidate-registry-20261116/v3/summary-v3.md)

## 跨轨道候选索引 v5

v5 原样保留 v4 的 141 行，并从 UNESCO Funmilayo Pedagogical Unit 加入 24 个教育文档术语候选，合计 165 行、15 篇候选文档、11 个来源组。98 条已有目标表面候选，67 条仍为 source-only；批准进入持久记忆与未来模型输入资格均为 0。新候选覆盖约鲁巴族群与次群体、`iyalode` 等称谓、殖民行政概念、历史事件、组织名和缩写；没有添加中文形式。

其中 5 个词面也出现在前段漫画候选中，可作为同一来源组内跨内容类型一致性队列，但还不是已确认词义或推荐译法。OCR 精确字符串命中 15/24，规范化后 19/24；其余 5 条无法从 OCR 文本确认，页图定位也仍待双审。这些只是抽取诊断，不作为术语准确率。24 条都保持未审、未获准、不可进入模型输入，教育矩阵也明确排除术语候选。[v5 摘要与校验](../../../workspace-data/evidence/translation-memory-candidate-registry-20261116/v5/summary-v5.md) · [165 条机器可读候选](../../../workspace-data/evidence/translation-memory-candidate-registry-20261116/v5/term-memory-candidate-registry-v5.jsonl) · [教育文档来源包](../../../workspace-data/evidence/translation-benchmark-funmilayo-educational-document-expansion-v1-20261116/summary.md)

## MDN AbortSignal 术语候选与 registry v6

v6 保留 v5 的 165 条记录，并新增 AbortSignal dev 文档中的 14 条 API、异常与事件术语候选；全库 179 条、16 篇文档、11 个来源组，其中 112 条带有目标表面候选、67 条 source-only。新增条目包括 `AbortSignal.aborted`、`AbortSignal.reason`、`AbortSignal.any()`、`AbortSignal.timeout()`、`AbortError` 和 `onabort` 等。目标形式只是官方中文页上的候选词面，尚未成为已审译法。

这 14 条全部未审、未获准、不可进入未来模型输入；108 格 AbortSignal 上下文矩阵明确不把候选词或中文参考发送给 Bilibili。来源组和参考译文属于 dev 数据，后续术语记忆收益实验必须使用独立来源组，避免把测试参考泄漏进术语提示。[v6 摘要与校验](../../../workspace-data/evidence/translation-memory-candidate-registry-20261116/v6/summary-v6.md) · [179 条机器可读候选](../../../workspace-data/evidence/translation-memory-candidate-registry-20261116/v6/term-memory-candidate-registry-v6.jsonl) · [AbortSignal 来源与对齐证据](../../../workspace-data/evidence/translation-benchmark-mdn-abortsignal-reference-candidate-20261116/summary.md)


## TICO-19 dev 对齐行术语候选与 registry v7

v7 保留 v6 的 179 条记录，并从 v59 的 36 条 TICO-19 dev 英中对齐行新增 54 条带目标表面候选的词条，涉及 11 篇文档、11 个来源组。全库共 233 条记录，166 条有目标表面候选、67 条 source-only；批准进入持久记忆 0 条、未来模型输入资格 0 条。词项与目标候选均逐条核对是否出现在所声明的对齐行，源段/参考段哈希与 v59 清单匹配。

重复词面审计发现 `COVID-19` 在 3 篇来源文档出现，`SARS-CoV` 在 2 篇来源文档出现；这只是后续同词跨文档审阅的队列线索。National Basketball Association 和 `efficacy` 各有两个观察到的中文表面候选，暂不决定偏好或等价性。包括这些条目在内，全部候选都来自 dev 参考，未审之前不得作为翻译记忆输入任何同源请求；未来记忆效应实验需用独立来源组。TICO 译文许可和英语源文逐行许可分开记录在 v59，API 处理与输出留存仍待用途审核。

v7 注册表构建本身未发起模型调用、未生成质量分或人工双语判断。随后单独运行的 v61 TICO dev 上下文矩阵没有注入术语表；重复源语候选的模型输出只作另一个表面观察队列，不追溯修改 v7 的候选或审批状态。[v7 摘要与校验](../../../workspace-data/evidence/translation-memory-candidate-registry-20261116/v7/summary-v7.md) · [233 条机器可读候选](../../../workspace-data/evidence/translation-memory-candidate-registry-20261116/v7/term-memory-candidate-registry-v7.jsonl) · [跨文档重复词面审计](../../../workspace-data/evidence/translation-memory-candidate-registry-20261116/v7/cross-document-repeat-audit-v1.json)

## TICO-19 dev 重复词项表面诊断

从 v7 registry 中选出跨文档重复、且出现在 v61 目标对齐行的两个源语候选：`COVID-19`（3 篇文档、4 个对齐行位置）和 `SARS-CoV`（2 篇文档、2 个位置）。报告只检查未经双语审定的候选目标词面是否精确出现在输出中：`COVID-19` 在 2B 的无上下文/邻接上下文条件分别出现 2/8、2/8；9B 为 0/8、4/8；35B 为 0/8、0/8。`SARS-CoV` 的候选原样词面在三个模型、两种条件下均为 4/4。上下文只改变 9B 的 `COVID-19` 候选词面出现状态 4/8 个可配对输出；其余这些配对中该状态未变。

这些是字符串包含计数，不是术语正确率：模型可能使用了合理的中文表达，也可能误用术语；不能从候选词面出现与否判断。没有批准任何词条，也没有把词条送入模型。后续人工标注应确认词义、可接受译法和语境作用域，再用独立来源组设计 glossary/no-glossary 对照。[术语表面诊断](../../../workspace-data/evidence/translation-benchmark-tico19-dev-context-ablation-20261116/term-surface-consistency-diagnostics-v1.md) · [机器可读计数](../../../workspace-data/evidence/translation-benchmark-tico19-dev-context-ablation-20261116/term-surface-consistency-diagnostics-v1.json) · [v61 上下文运行记录](../../../workspace-data/evidence/translation-benchmark-tico19-dev-context-ablation-20261116/summary-v1.md)

## TICO-19 全文上下文重复词面诊断 v2

完整文档上下文配对实验仍只用 v7 的候选词面做离线观察，没有把词条或中文表面发送给模型。36 个目标中，5 行源文包含精确拼写 `COVID-19`，2 行包含 `SARS-CoV`。按目标行计数，COVID-19 原样英文表面保留：2B 在无上下文/相邻行/全文上下文分别为 2/5、2/5、2/5；9B 为 0/5、2/5、2/5；35B 为 0/5、0/5、0/5。SARS-CoV 在三个模型、三种条件下均为 2/2。

这只度量模型是否保留英文原样词面；中文译法、缩写解释或其他同义写法都没有被评判，故不能解释为术语准确率或一致性优劣。v7 registry 未变，批准进入持久记忆和未来模型输入资格仍为 0。正式词库实验仍需双语领域审阅来确定可接受译法，再用独立来源组做 glossary/no-glossary 配对，并记录文档/项目作用域，避免用 TICO dev 的待审参考泄漏到同源提示。[v2 术语与上下文诊断](../../../workspace-data/evidence/translation-benchmark-tico19-dev-full-document-corpus-20261116/full-document-context-sensitivity-diagnostics-v2.json) · [完整上下文候选译文](../../../workspace-data/evidence/translation-benchmark-tico19-dev-full-document-corpus-20261116/full-document-context-paired-summary-v2.md) · [v7 registry 摘要](../../../workspace-data/evidence/translation-memory-candidate-registry-20261116/v7/summary-v7.md)


## TICO-19 全行批量首轮术语表面诊断 v3

934 行的批量全文上下文首轮只对精确英文词面做覆盖与保留计数，没有加载 v7 词库，也没有向模型发送待审中文候选。源文含 `COVID-19` 的 165 行中，有候选覆盖数/原样英文保留数分别为：2B 150/135、9B 125/89、35B 153/77。源文含 `SARS-CoV` 的 15 行中分别为 15/14、12/12、15/15。批次里可恢复的格式偏离译文也可能计入这些表面诊断，但不计作严格输出合同通过。

这些计数不能判定译文是否采用可接受的中文表达，也不等于术语准确率或文档一致性分数。TICO dev 中由参考译文提出的条目仍不可回填同源提示；v7 的批准持久记忆和模型输入资格继续为 0。正式术语实验须先由双语领域评审确认词义、可接受变体和作用域，再在独立来源组上做记忆开/关对照。[v3 机器可读覆盖与词面计数](../../../workspace-data/evidence/translation-benchmark-tico19-dev-full-document-corpus-20261116/full-document-context-coverage-v3/full-document-context-coverage-audit-v3.json) · [候选 registry v7](../../../workspace-data/evidence/translation-memory-candidate-registry-20261116/v7/summary-v7.md)

## PLOS One 材料科学摘要的术语隔离

材料科学摘要候选 registry 中的 hedge、booster、自我提及和态度标记目标译法均为未审研究者候选。新建的 120 格上下文计划只传英语目标句和可选的同摘要英语上下文；请求清单逐条排除了中文术语候选。全部条目继续 `approved_for_memory=false`、`eligible_for_model_input=false`。未来若做 glossary/no-glossary 对照，须先由领域评审确认可接受变体、效力强弱和适用范围；不能把研究者候选或来源论文中的中文群体术语定义直接当作词库金标准。[术语候选摘要](../../../workspace-data/evidence/translation-benchmark-plos-stance-markers-source-only-candidate-20261116/summary.md) · [请求隔离审计](../../../workspace-data/evidence/translation-benchmark-plos-stance-markers-source-only-candidate-20261116/context-ablation-v1/ execution-audit-v1.json)

## 技术文档术语候选扩充与 registry v8

v8 保留 v7 的 233 条记录，并新增 21 条技术文档候选：Kubernetes Service 官方中译候选 13 条、TypeScript Handbook Basics 官方本地化候选 8 条。来源项目各自有固定版本与 CC BY 4.0 记录。构建时逐条检查 37 个源词—片段出现关系和 23 个目标表面—译文片段出现关系；TypeScript 旧候选清单中 6 个不能在所列源段找到字面词项的片段引用被排除，避免把上下文相关误写成词项出现证据。

这只证明候选词面出现在选定句段中，不证明跨度边界、词义、偏好译法或语义准确。`Service` 暂保留 “Service” 与“服务”两种表面，API 名称、代码字面量和普通术语分开标注；两篇文档仍各自只有一个来源组。v8 总计 254 条，已批准持久记忆 0、可进入模型输入 0；本次没有调用模型或开始双语审阅。候选不得回填同源实验，记忆效果比较仍需先审定后换独立来源组。[v8 摘要与校验](../../../workspace-data/evidence/translation-memory-candidate-registry-20261116/v8/summary-v8.md) · [254 条候选注册表](../../../workspace-data/evidence/translation-memory-candidate-registry-20261116/v8/term-memory-candidate-registry-v8.jsonl) · [源词与目标表面审计](../../../workspace-data/evidence/translation-memory-candidate-registry-20261116/v8/technical-term-source-audit-v1.json)

## OpenTelemetry Observability Primer 术语表面候选

独立来源组 `opentelemetry-io` 新增 observability、telemetry、trace/span、instrumentation、reliability、metric、signal、SLI/SLO 和 attribute 共 11 条术语表面观察。英文页面固定到 OpenTelemetry website 提交 `71130c7451ddc597fba9896813467a5754de664f`；同提交中文页面标记为 `drifted_from_default`，目标短语没有验证对齐。因此现有中文词面仅用于后续标注候选，不作为记忆条目，也不能作为这份文档的提示词输入。记录里的英文块 ID/跨度和中文行/上下文位置分别锚定各自固定文件哈希，不是彼此配对的证据。

计数仅反映一个页面内的候选表面次数，不是覆盖率或正确率。后续应让双语技术评审确认概念定义、可接受变体和作用范围，再建立隔离式的 no-memory / reviewed-memory 对照；复用同一文档与相同目标文本评估时需避免将记忆构建样本兼作独立测试集。[术语观察、漂移状态与频次](../../../workspace-data/evidence/translation-benchmark-opentelemetry-observability-primer-candidate-20261117/v1/term-observation-candidates-v1.jsonl) · [来源和目标版本记录](../../../workspace-data/evidence/translation-benchmark-opentelemetry-observability-primer-candidate-20261117/v1/full-page-source-record-v1.json)

## Pepper&Carrot Episode 26 术语与复现表达观察

在既有 56 个逐行英中候选与 36 份模型输出上，新增 9 组源词/短语/音效观察，覆盖 dungeon、Water-Tree、The Guardian、shortcut、Carrot、复现口号、阅读笑点以及 BOING/tickle，共 17 个源文位置、102 条盲态输出行观察。位置精确锚到源段哈希；模型/提示和官方中文候选分别隔离保存。

这些观察只适合生成标注队列：对官方中译仍是整行候选，没有词级跨度对齐，也不判断译法正误。角色名、世界观词、口号和拟声词需要不同的记忆类别与作用域；笑点回调则是篇章一致性线索，不应自动当作词条。当前获批记忆 0、双语审定 0、质量分 0，本次没有模型调用。[术语位置与盲态输出摘要](../../../workspace-data/evidence/translation-benchmark-peppercarrot-ep26-bilibili-api-20261115/term-observation-summary-v1.md) · [逐处观察和分离目标候选](../../../workspace-data/evidence/translation-benchmark-peppercarrot-ep26-bilibili-api-20261115/term-source-occurrence-candidates-v1.jsonl) · [记忆准入审阅协议](../../../workspace-data/evidence/translation-benchmark-peppercarrot-ep26-bilibili-api-20261115/term-consistency-review-protocol-v1.json)

同一队列另保存了 51 对“通用提示 / 漫画提示”的逐行对照，其中 21 对完整译文行字符串不同。该数只表示提示敏感性，可能由行内任何措辞变化造成，不说明术语是否变化或哪一版更好；待双语评审后才可把差异归因到词项或记忆收益。[精确行变化诊断](../../../workspace-data/evidence/translation-benchmark-peppercarrot-ep26-bilibili-api-20261115/term-bearing-line-context-sensitivity-v1.json)

Episode 26/39 跨篇章复核候选另含 101 条共用角色/区域标签行，可供后续同系列声线与文字效果标注；它没有完全重复的 Pepper 源句，唯一重复英文表面为片尾 `- FIN -`，且两集标签不同。因此它支持建立评审队列，不支持估计相同术语记忆带来的收益。两集共用一个 series split group，全部官方简中仍待审，不进入记忆 registry 或模型输入。[复核队列与重复审计](../../../workspace-data/evidence/translation-benchmark-peppercarrot-cross-episode-style-review-20261118/v1/summary-v1.md) · [审计 JSONL](../../../workspace-data/evidence/translation-benchmark-peppercarrot-cross-episode-style-review-20261118/v1/normalized-source-overlap-candidates-v1.jsonl)

## eLife 蜻蜓目生态论文术语位置候选

eLife 蜻蜓目范围/物候论文的 16 个选定证据块新增 24 组 source-only 词面候选和 175 条块内跨度观察，覆盖 Odonata、phenology、range shifts、温度变异、栖地类型、GLM/MCMCglmm 及统计量等。坐标以规范化证据块为基准，不是原始网页字符偏移；摘要、方法、结果表和讨论之间的重复位置可以帮助后来审定篇章一致性，但当前词面家族不等同于术语同义组。

目标译法、可接受变体、批准记忆与模型输入资格均为 0；没有发起模型调用或开始双语审阅。候选仅供后续核对词义、限定范围与表格标签使用；分词面计数不能作为准确率、记忆召回率或跨段一致性分。[候选家族与跨度摘要](../../../workspace-data/evidence/translation-document-understanding-elife-odonate-range-phenology-20261117/v1/term-observation-summary-v1.md) · [候选词面](../../../workspace-data/evidence/translation-document-understanding-elife-odonate-range-phenology-20261117/v1/term-candidates-v1.jsonl) · [逐处位置与块哈希](../../../workspace-data/evidence/translation-document-understanding-elife-odonate-range-phenology-20261117/v1/term-occurrences-v1.jsonl) · [校验报告](../../../workspace-data/evidence/translation-document-understanding-elife-odonate-range-phenology-20261117/v1/term-validation-v1.json)

同篇图注 v2 又新增 17 条 source-only 术语位置、12 个图注候选族。精确词面桥接将其中 6 族（11 条位置）连到正文 registry 的候选族；其余 6 族没有 exact body surface match。桥接只支持正文/图注间的来源导航，不推断术语语义同组、目标译法对齐或翻译一致性；正文和图注仍是一篇论文、一个来源组，memory 准入和模型输入资格继续为 0。[跨章节桥接摘要](../../../workspace-data/evidence/translation-document-understanding-elife-odonate-range-phenology-20261117/cross-section-term-bridge-v1/summary-v1.md) · [逐项链接](../../../workspace-data/evidence/translation-document-understanding-elife-odonate-range-phenology-20261117/cross-section-term-bridge-v1/caption-to-body-term-links-v1.jsonl)

## FastAPI Handling Errors 技术术语观察候选

同一固定来源组新增 9 组未审词项观察，包括 `HTTPException`、`RequestValidationError` 等受保护标识符，以及 `HTTP status code` / “HTTP 状态码”、`custom exception handler` / “自定义异常处理器”等正文译法。当前 61 个英文与 58 个中文命中位置来自作者 AI/人工协作本地化候选；逐处偏移锚定固定 Markdown 源文件，不视为术语词义同组、批准译法或记忆召回。

所有候选 `memory_admission_status` 均未批准，模型输入资格为 0。后续评审应先判断词义、代码属性和可接受变体，再决定作用域；尤其不能把出现次数不同直接解释成漏译或术语不一致。[候选包摘要](../../../workspace-data/evidence/translation-benchmark-fastapi-handling-errors-candidate-20261117/v1/summary-v1.md) · [术语观察 JSONL](../../../workspace-data/evidence/translation-benchmark-fastapi-handling-errors-candidate-20261117/v1/term-observation-candidates-v1.jsonl) · [出现位置审计](../../../workspace-data/evidence/translation-benchmark-fastapi-handling-errors-candidate-20261117/v1/term-observation-audit-v1.json)

## NASA 航空科普漫画术语表面候选

NASA 漫画全部 12 页的 54 组观察把专名、角色名、日常 `plane/wing`、受力术语、航空史、航天与未来飞机术语分开定位。当前中文版候选把 `lift` 表示为“浮力”、把 `weight` 表示为“重力”；这些字面对应尚未经专业双语审定，不能当作推荐译法或记忆词条。所有候选均未准入记忆、未进入 Bilibili 输入，也没有术语一致性分数；后续若通过权利门槛，应先标注概念与区域跨度，再做同页/跨页记忆消融。[术语观察与计数](../../../workspace-data/evidence/translation-benchmark-nasa-aeronautics-manga-candidate-20261117/transcript-expansion-v2/term-observation-candidates-v2.jsonl) · [数据准入状态](../../../workspace-data/evidence/translation-benchmark-nasa-aeronautics-manga-candidate-20261117/transcript-expansion-v2/audit-v2.json)

## FastAPI 与 OpenTelemetry 候选并入 registry v9

registry v9 保留 v8 的 254 条记录，再增加 FastAPI Handling Errors 9 组、OpenTelemetry Observability Primer 11 组候选，合计 274 条，覆盖 31 篇候选文档与 26 个来源组。新增 121 个英文词项出现跨度与 173 个中文页面候选出现位置，均可追到固定文件哈希；这只证明字符串和位置存在，不证明术语边界、含义、可接受译法或源译对齐。对新添两组做精确源词重复检查，没有发现与旧 registry 重复的英文词面；全库既有重复项仍单列为待审队列。

FastAPI 页面位于同一仓库提交，官方简中页声明由 AI 与人工协作且可能出错；OpenTelemetry 中文伴页的默认语言提交与英文版本不同，明确保留为漂移候选。两种中文页面都不是 gold。两来源权利审查仍待完成，公开分发未批准；没有新 Bilibili 调用、人工评审、质量分、持久记忆准入或模型输入资格，v61 主清单未增加记录。未来要测 memory/no-memory 效果，应先完成双语术语裁定，并在与记忆构建分离的来源组上评估。[registry v9 摘要与校验](../../../workspace-data/evidence/translation-memory-candidate-registry-20261116/v9/summary-v9.md) · [274 条机器可读 registry](../../../workspace-data/evidence/translation-memory-candidate-registry-20261116/v9/term-memory-candidate-registry-v9.jsonl) · [出现位置、来源版本与许可状态](../../../workspace-data/evidence/translation-memory-candidate-registry-20261116/v9/technical-term-source-audit-v1.json) · [跨文档重复审计](../../../workspace-data/evidence/translation-memory-candidate-registry-20261116/v9/cross-document-repeat-audit-v1.json)

## Apache ECharts Handbook Data Transform 术语位置候选

固定提交中的英语和简中 Data Transform 页面新增 8 个候选术语家族，每种语言分别保存 occurrence、字符跨度和行号，共 16 条观察记录。候选涉及 data transform、dataset、transform、filter、sort、dimension、parser 和 API 字段/组件名。源/目标词面没有自动配对，也没有准确性或偏好判断；全部保留为未审观察，不加入已批准的产品记忆或模型输入。[观察摘要与完整性](../../../workspace-data/evidence/translation-benchmark-apache-echarts-handbook-data-transform-20261118/v1/section-sidecar-audit-v1.json) · [逐词出现位置](../../../workspace-data/evidence/translation-benchmark-apache-echarts-handbook-data-transform-20261118/v1/term-observation-candidates-v1.jsonl)

### Apache ECharts Handbook Dataset 网页快照术语候选

未绑定提交的 Dataset 页面另有 8 条英中分开的词面观察，覆盖 `dataset`、`dimension`、`series` 与 `encode`。这些位置锚到各自网页文本哈希；相同 `observation_family_id` 仅用于候选检索，`alignment_to_other_language` 均为 `not_inferred`，不表示词级对齐或可接受译法。该包不并入 registry v9、模型记忆或 benchmark split；待来源版本确认并由双语技术评审裁定词义、变体和作用域后再考虑准入。[候选及字符跨度](../../../workspace-data/evidence/translation-benchmark-echarts-dataset-web-snapshot-20261118/v1/term-observation-candidates-v1.jsonl) · [版本/许可状态](../../../workspace-data/evidence/translation-benchmark-echarts-dataset-web-snapshot-20261118/v1/capture-provenance-v1.json)

## Ant Design Form 重复 API 字面量观察

对既有 8 个英中候选段落单独扫描 inline-code，不新增 glossary 记录：识别到 16 个英文源代码字面量和 16 个简中候选字面量；`dependencies` 与 `shouldUpdate` 各跨多个段落重复，计数一致。相同字面量出现只支持后续检查字段/属性保护，不证明语义一致或译法正确；原 registry 的 13 条 Ant Design term family 保持待审、不可输入模型。[逐处跨度和哈希](../../../workspace-data/evidence/translation-benchmark-ant-design-form-reference-candidate-20261116/term-observation-v1/inline-code-occurrences-v1.jsonl) · [跨段重复审计](../../../workspace-data/evidence/translation-benchmark-ant-design-form-reference-candidate-20261116/term-observation-v1/cross-segment-repeat-audit-v1.json) · [校验报告](../../../workspace-data/evidence/translation-benchmark-ant-design-form-reference-candidate-20261116/term-observation-v1/validation-report-v1.json)

## MDN AbortSignal 整页英中独立词面观察

完整仓库 Markdown 版本包新增两种语言各 10 个词面检索观察：英文命中 116 次，简中命中 99 次；每处包括源文件 SHA-256、零起始 Unicode 字符跨度、行号、可用的结构块 ID、代码围栏标记和短上下文。候选覆盖 API/异常标识符、`abort` / `aborted` / abort signal、`response body`、`promise`，以及中文页的“中止”“中止信号”“中止原因”“承诺”等可检索表面。

两种语言采用不同的 observation ID，`alignment_to_other_language` 为 `not_inferred`；5 对重叠跨度/语言保留在数据中并单独统计。该数据用于让后续评审者检查术语边界、重复位置和作用域，不主张这些形式互为翻译，不加入 registry v9，也不用于当前文档的模型输入。所有观察仍未审，持久记忆准入和输入资格均为 0；没有模型调用、双语评审或质量分。[摘要与计数](../../../workspace-data/evidence/translation-document-mdn-abortsignal-full-page-20261118/v1/term-observations/summary-v1.md) · [逐处观察 JSONL](../../../workspace-data/evidence/translation-document-mdn-abortsignal-full-page-20261118/v1/term-observations/term-observation-candidates-v1.jsonl) · [可复跑构建器](../../../workspace-data/evidence/translation-document-mdn-abortsignal-full-page-20261118/v1/term-observations/build-v1.py) · [机器审计](../../../workspace-data/evidence/translation-document-mdn-abortsignal-full-page-20261118/v1/term-observations/term-observation-audit-v1.json)

## Wikipedia Capybara 正文窗口 source-only 词面观察 v1

从固定英文 revision `1381316101` 的 Web Reader 正文窗口（行 244–348）登记 8 个重复源语词面候选、119 个逐处跨度；观察包括通用名称、学名/分类名、栖息环境、地理分布和食性词面。每处保存 reader 行号、行内字符跨度、原始表面形式、行哈希和最近章节标题；构建器逐处回查固定捕获文本与 source-window 哈希。`Hydrochoerus` 与 `Hydrochoerus hydrochaeris` 有 2 处嵌套跨度，二者只是不同表面候选，不是同义关系或独立观察样本。

该包只有英文源语观察，没有中文目标映射、对齐或词典释义；简中主题页与英文正文修订相差 122 天，不作为参考或模型输入。8 条候选均 `approved_for_memory=false`、`eligible_for_model_input=false`，不并入跨轨道 registry v9，也不改变批准记忆总数。该来源组沿用 `wikipedia-capybara` dev 组；CC BY-SA 4.0 的外部处理/输出留存审核未完成，未准备 Bilibili 请求。术语类别与词面边界仍待双语/领域评审。[词面观察摘要](../../../workspace-data/evidence/translation-term-observations-wikipedia-capybara-body-window-20261119/v1/summary-v1.md) · [8 条 source-only JSONL](../../../workspace-data/evidence/translation-term-observations-wikipedia-capybara-body-window-20261119/v1/term-observation-candidates-v1.jsonl) · [跨度与许可隔离审计](../../../workspace-data/evidence/translation-term-observations-wikipedia-capybara-body-window-20261119/v1/term-observation-audit-v1.json) · [确定性构建器](../../../workspace-data/evidence/translation-term-observations-wikipedia-capybara-body-window-20261119/v1/build_term_observations_v1.py)

## Ant Design Form 模型输出中的代码字面量基线 v2

对现有 24 条技术提示基线输出与 60 条上下文消融输出计数，不新增 API 调用，也不把中文候选或 glossary 输入模型。8 个源段有 16 个 inline-code 出现、9 个不同表面；84 条输出产生 138 个源词面/运行对照，108 个与源文出现次数相同，30 个多出一次，0 个少于源文。重复的 `dependencies` 在基线 3/9、target-only 6/18、附加同页上下文 6/18 次计数相同，所有差异都是额外出现；`shouldUpdate` 的 60/60 次计数相同。对这两项重复词面，target-only 与上下文条件的 42 个配对计数全部未变。

这是代码字面量计数信号，不是翻译正确率、语义一致性或记忆效果。产品面可以并列显示源文次数、译文字符串次数、命中位置与条件；评审前不自动建议修订、不批准记忆。后续 memory/no-memory 对照仍需先裁定目标译法与作用域，再隔离记忆构建来源。[机器审计摘要](../../../workspace-data/evidence/translation-benchmark-ant-design-form-reference-candidate-20261116/term-observation-v2-model-output/summary-v1.md) · [逐运行词面观察](../../../workspace-data/evidence/translation-benchmark-ant-design-form-reference-candidate-20261116/term-observation-v2-model-output/model-output-literal-observations-v1.jsonl) · [上下文配对计数](../../../workspace-data/evidence/translation-benchmark-ant-design-form-reference-candidate-20261116/term-observation-v2-model-output/context-pair-literal-delta-v1.jsonl)

## React 跨文档术语记忆来源候选 v1

从 `Queueing a Series of State Updates` 与 `Choosing the State Structure` 的既有 sidecar 合并 21 条来源词项候选，归并为 20 个规范化源语族；`state` 是唯一在两篇文档中重复出现的候选族，其未审目标表面候选存在共同字面形式。该数据只覆盖 `reactjs-zh-hans-react-dev` 同组 4 篇文档中的 2 篇，且相关模型运行尚未开始；不能计算跨文档译文一致率、术语准确率或记忆收益。来源映射保留 document/segment ID 与哈希，不含源句或目标段全文。[候选摘要](../../../workspace-data/evidence/translation-benchmark-candidate-manifest-v88-echarts-translation-20261119/react-term-memory-source-inventory-v1.md) · [逐项来源记录](../../../workspace-data/evidence/translation-benchmark-candidate-manifest-v88-echarts-translation-20261119/react-term-memory-source-candidates-v1.jsonl) · [机器清单](../../../workspace-data/evidence/translation-benchmark-candidate-manifest-v88-echarts-translation-20261119/react-term-memory-source-inventory-v1.json)

20 个候选族均保持 `approved_for_memory=false`、`eligible_for_model_input=false`。工作台可据此设计“来源 → 候选目标表面 → 适用范围 → 审定结果”的查看流程；不得自动批准，也不得在术语映射和用途门槛解决前把这些候选送入 React 翻译调用。

### React 候选词族在四篇文档中的源文跨度

把同一组中的四篇 React 文档（44 个段落）作为检索范围，对 20 个既有未审候选族做精确表面匹配，得到 153 个 source-only 词面跨度。`state`、`render/re-render`、`event handler` 与 `props/prop` 这四个候选族至少在两篇源文中出现；这表示候选位置可供后续查阅，不表示源文概念完全等价或目标译文一致。`duplicate state / data` 因斜线标签无法无歧义拆成搜索词，暂不生成跨度。

逐项记录保留 segment ID、源段哈希、Unicode 零起始 offset 和短上下文哈希，不包含源句、参考译句全文或自动记忆输入。目标译法仍来自两篇待审官方本地化候选；四篇页面没有模型译文，因此一致率、准确率和 memory/no-memory 收益仍不可计算。[跨度清单](../../../workspace-data/evidence/translation-benchmark-candidate-manifest-v88-echarts-translation-20261119/react-term-source-occurrence-map-v1.md) · [逐跨度 JSONL](../../../workspace-data/evidence/translation-benchmark-candidate-manifest-v88-echarts-translation-20261119/react-term-source-occurrences-v1.jsonl) · [机器审计](../../../workspace-data/evidence/translation-benchmark-candidate-manifest-v88-echarts-translation-20261119/react-term-source-occurrence-map-v1.json)

## Soldering Is Easy 技术漫画 source-only 术语跨度

从同一作品组的 42 个英文 panel-region 文本候选提取出 17 个未审源语族、257 条精确字符串跨度；15 个候选族出现在多个面板，跨词族有 25 对跨度重叠。该数量按匹配出现计数，不是 257 个独立术语，也不自动认定同一词形在不同语境中意义相同。候选涵盖 `solder/soldering`、`soldering iron`、`solder connection`、`tip`、`lead`、`PCB`、`pad`、`resistor`、`flux`、`Celsius` 等；`tip` 与 `lead` 保留歧义提示，目标译法仍为空。

此 inventory 只读取英文 panel-region 候选及其页/面板 ID、字符跨度和哈希，不使用双语出版文本或 126 条模型输出，不产生术语批准、memory 输入资格或质量分。PDFKit 区域文本与视觉阅读顺序仍是候选状态，双语与领域评审暂缓。[source-only 术语跨度摘要](../../../workspace-data/evidence/translation-benchmark-soldering-is-easy-comic-20261118/v1/term-memory-source-inventory-v1/summary-v1.md) · [候选词族](../../../workspace-data/evidence/translation-benchmark-soldering-is-easy-comic-20261118/v1/term-memory-source-inventory-v1/term-family-candidates-v1.jsonl) · [逐跨度位置](../../../workspace-data/evidence/translation-benchmark-soldering-is-easy-comic-20261118/v1/term-memory-source-inventory-v1/term-occurrence-map-v1.jsonl) · [提取审计](../../../workspace-data/evidence/translation-benchmark-soldering-is-easy-comic-20261118/v1/term-memory-source-inventory-v1/validation-report-v1.json)
