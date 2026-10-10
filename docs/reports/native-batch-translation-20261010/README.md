# 原生批量翻译与失败恢复验证

## 行为与协议依据

全文翻译自动合并同一会话、语言、服务、模型、术语和上下文配置下的短段。原生数组能力与 AI 多段开关分开；`enableAIMultiSegment` 仍默认关闭。

| 服务 | 请求协议 | 对应关系 |
| --- | --- | --- |
| Google 免费端点 | HTML/list 文本数组；RPC 带编号的独立请求 | 数量完整；RPC 编号唯一、齐全并按编号回填 |
| Microsoft 免费端点 | 转义后的纯文本数组 | 数量完整并按输入顺序回填 |
| DeepL | `text[]`，不启用 HTML 标签解析 | 官方约定输入顺序；每项独立翻译 |
| Azure Translator | `[{Text}]`，`textType=plain` | 官方约定输入顺序；每项仅一个目标语结果 |
| Google Cloud v2 | `q[]`，`format=text` | 官方多输入结果数组，按输入位置回填 |

官方依据：[DeepL 请求协议](https://developers.deepl.com/api-reference/translate/request-translation)、[Azure Translate v3](https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/v3/translate)、[Google Cloud v2](https://docs.cloud.google.com/translate/docs/reference/rest/v2/translate)。免费网页端点没有与云 API 等同的稳定性承诺。

常规 provider 分包最多 32 项、4000 个 UTF-16 字符；全文微任务每组最多 4 槽、2000 字符。空白来源在本地保留，重复来源回填到各自位置；超长单槽独立请求并保持完整，不截断正文。不具备可靠数组协议的机器翻译及翻译专用小模型逐槽调用，不上传 BEGIN/END 分隔符。

响应必须为等长稠密字符串数组，非空来源必须对应有内容的译文。所有分包通过后才返回；Google RPC 的每个译文子片段也必须具有有效结构，不能丢弃坏片段后拼成“成功”。输入按纯文本传输，不把字面 HTML 当作可执行标签；这不能保证服务总会保留所有特殊字符，真实验证发现的微软实体改写另作拒收处理。

只在可识别的响应结构错误时由 broker 拆批；恢复共用原始截止时间和取消域，全部成功后才写缓存。恢复再次失败时前端直接进入失败状态，保留原文，不启动另一轮预算。网络、鉴权、HTTP 限流和明确的 HTML/XML 拦截页不会触发逐段拆批。Google 免费端点先沿已有协议整批换线，只有整条链均为结构错误时才把拆批交给 broker。

## AI 多段保护

仅同一父元素下直接相邻的候选可共享 AI 批次。标记缺失、重复、乱序、空正文或数量异常时回退逐段，并停用当前页面会话同一请求配置的后续 AI 合批。熔断身份不包含正文变化代数，因此邻段 mutation 不会重新启用失败协议；分组及缓存仍包含代数，避免旧邻段结果复用。不同 DOM owner 的在途工作隔离；已结算的单候选会话结果不用于猜测新邻段上下文，真正相同批次可复用 broker 的完整有序来源指纹缓存。即使关闭额外网页上下文，邻段变化也会失效上下文敏感缓存。

结构校验不能证明语义正确。服务违反顺序约定，或模型在保留标记的同时翻错、漏掉部分语义，仍不能仅靠数量和格式自动识别；因此 AI 多段保持用户主动开启，机器翻译只使用明确的原生协议。

## 确定性验证

定向测试覆盖：三云协议、免费 Google/Microsoft、broker、全文调度、文档调用与槽协议。包含缺中间项、重复/缺失/乱序 RPC 编号、截断 JSON、稀疏数组、零宽空译文、重复原文、HTML 字面文本、多行、取消、恢复失败无部分缓存、再次翻译、AI 熔断及邻段缓存失效。

新原生校验模块、provider 分包模块和 Microsoft transport 的 statements/branches/functions/lines 达到 100%；范围见 [coverage.json](./coverage.json)，不代表全库覆盖率。Chrome、Firefox、油猴生产构建、类型检查和 manifest 校验分别运行；本次没有升级依赖或版本号。

油猴同依赖独立基线为 `55d1219bd` 的 1,975,252 字节。原预算仅余 748 字节；本次新增协议校验、恢复与 AI 隔离逻辑超出该余量，因此预算增加 6000 字节至 1,982,000，并继续执行原有体积与运行边界检查。最终增量见 [userscript-size.json](./userscript-size.json)。

## 真实服务与浏览器证据边界

专用测试凭据不可用，因此 DeepL、Azure、Google Cloud 的验证采用官方结构的合成响应，不能认定三云真实鉴权、区域、计费或线上翻译质量已验收。Google 和 Microsoft 免费端点的小规模真实对照与全文快捷键使用隔离临时浏览器；结果与合成响应分别记录。

微软免费端点的批量和逐条结果都会把本例原文 `&lt;` 改写为 `&;`。3 次无凭据公开端点诊断确认损坏发生在服务原始响应内；命名转义、数字转义、双重转义和 `textType=plain` 探测均不能可靠保真，见 [原始响应摘要](./microsoft-entity-diagnostic.json)。因此不按猜测位置修复文本：对原文实体字面值逐 token 检查保留数量，损坏结果按协议异常拒收；同预算逐段恢复仍损坏时返回失败、保留原文，拒收结果不进入缓存。这是保守失败保护，并非对上游翻译内容的自动修复。

可重现入口：`scripts/testing/run-native-batch-live-test.cjs`。必须传入生产扩展、Playwright 包目录、focus-safe helper 和证据目录；默认仅合成云响应，`--live` 增加两条免费服务的六槽批量与顺序逐条对照，`--full-page` 增加六段全文翻译、恢复、再翻译。不会读取日常 profile 或用户凭据；后台正常窗口置于第二屏，校验 `browserFrontmost=false`，只清理本轮临时配置。
