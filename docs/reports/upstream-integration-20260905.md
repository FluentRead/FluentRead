# 上游修复整合与 PR #447 验证（2026-09-05）

本报告记录整合当前主分支后的交付验证，替代旧报告中的“最新源码”计数。原有失败及观察用例的归因见[浏览器跟进报告](../upstream-regression-followup-20260905.md)。

目标仓库为 `FluentRead/FluentRead`，PR 为 [#447](https://github.com/FluentRead/FluentRead/pull/447)。验证生产源码为 `93cc473c4d46d73b731d8b40a43b4e2b5d56c942`，包含主分支 `e69bca319fb59dcbd0401d386dcb2d4311ebf94a` 的 JSON 站点规则、术语库、共享划词/阅读助手及最新设置界面。两个参考仓库保持只读。

## 最终行为

- GitHub 仓库技术标签、语言/许可证/统计字段及可见性徽标按组件结构保留，不依赖 Java/Python 关键词表；普通正文与 README 继续翻译。
- 图标字体连字、X Chat/Discord 元数据不进入请求或双语副本。text/plain 正文可译；HTML/Scribble 代码、Ubuntu 手册命令和命令后选项保持原样。
- 站点保护进入 JSON 规则系统，支持 `omit`、`literalLabels`、`literalTokens`，继续遵循同 ID 用户规则覆盖。粗体自然句和相邻说明仍可译。
- 原生 modal 内的划词层保持正确归属、缩放定位、关闭交互和节点自愈；过期组件回调不能移动新实例。
- 输入法组合期间不保存中间值，嵌套配置草稿不污染保存基线；正常快速关闭设置页时，待确认的字段补丁链交给后台继续保存。

![最终产物在 Microsoft 仓库列表中保留技术标签，说明段继续翻译](./upstream-integration-20260905/github-technical-labels.png)

## 合并前补测发现的缺陷

| 问题 | 证据与修复 |
| --- | --- |
| Ubuntu 混合段落漏译 | 新站点规则的全属性观察看到了插件自身 `data-fr-translation-segment` 写入。真实页面时序记录 48 条相关属性事件，合成段约 14ms 后被取消；最小回归也在旧实现失败。只承认精确自有段落标记，并保留边界、来源和文本槽均未变化的无关请求；真正的保护区变化、来源编辑或伪造标记仍取消。 |
| 快速关页丢失最后修改 | 固定首条真实保存回执未交给页面，后续真实 UI 修改进入待发队列。旧实现没有交接；仅在 pagehide 交接时，前端发出 batch，后台观察器收件为零。修复在扩展 Options 的 beforeunload 提前同步交接，保留 pagehide/unmount 回退和去重，不阻止关闭或弹确认。页面若留存并继续编辑，可再次交接。 |
| 命令与选项被误译 | `dpkg-query\n  --list` 不符合原单 token 形态。字面判断补入命令后只接 -/-- 选项的字符结构，保留换行及空白，继续拒绝普通粗体自然句；没有添加命令词表。 |
| MDN 目录被要求翻译 | 实际 h2 位于 `nav.reference-toc` 导航内；测试范围改为 `.reference-layout__body` 的正文结构并增加目录保护断言，保留原正文数量门槛。 |

新增 Ubuntu JSON 夹具分别断言混合容器直属正文、内嵌段落和独立说明均有各自译文，不能让一个子段落译文替整块正文“通过”；还验证命令不进请求、译文骨架保留命令、恢复后原 HTML 一致。X Chat 元数据也加入长期 JSON 夹具。

保存竞态使用真实 UI 点击和真实后台持久化，只控制首条回执到达页面的时间。最终快速关闭时该回执始终保持 `held=1/released=0`，beforeunload 发出的两条补丁抵达后台，独立读取存储和重新打开 UI 均保留 `contextMode=selection`。连续修改的四条序号依次提交成功。原有 30 个 Harness case 保留，两个未执行占位已变成实际门禁，共 32 项。

## 确定性流水线

`VITEST_MAX_FORKS=2 VITEST_MIN_FORKS=1 pnpm test:regression:all` 退出码 0。

| 检查 | 结果 |
| --- | --- |
| 架构 | 772/772，25 文件 |
| 单元 | 2,185/2,185，135 文件 |
| 功能 | 641/641，46 文件 |
| 回归 | 339/339，15 文件 |
| 分组总计 | 3,937/3,937，221 文件 |
| 严格覆盖率 | 3,134/3,134，175 文件；该配置语句/分支/函数/行均 100% |
| 清单审计、WXT prepare、TypeScript、架构体积门禁 | 通过 |
| Chrome、Firefox 构建及 Firefox 打包/manifest | 通过 |
| 用户脚本构建与校验、文档构建、diff 检查 | 通过 |

严格覆盖率套件与分组套件重叠，不额外累加；100% 指严格配置纳入的范围。Firefox 仅完成构建、打包和清单校验，没有声称实际 Firefox 浏览器测试通过。日志：`/private/tmp/fr-pr-integration-v3-final-regression.log`。

## 固定产物与浏览器验收

Chrome 副本 `/private/tmp/fr-pr-integration-v3-chrome` 共 233 文件；逐文件核对其与完整流水线构建目录一致，另记录 647 个生产输入文件摘要。

- Chrome 目录摘要：`e94a965fc08bccf79476fbd168bc78dc9b4ceb8ad19fcfa0a943b97100e286ab`。
- 用户脚本 `/private/tmp/fr-pr-integration-v3.user.js`：`19c86578e17aa42145211510027c930be198863e60420100aa6d8c120c53f9ee`。
- 完整摘要：`/private/tmp/fr-pr-integration-v3-artifact.json`。

最终验收使用以上同一份冻结产物，所有有效执行均通过。逐项结果见[机器可读验证摘要](./upstream-integration-20260905/verification-summary.json)；摘要已移除第三方产品页面的历史记录，其余数据保留原始验证结果。

| 浏览器检查 | 最终结果及范围 |
| --- | --- |
| 在线必测矩阵 | 31 页、62/62 项通过。悬浮译文数量为 `[1,0,1]`，相邻目标保持 `[0,0,0]`；全文完成翻译、完整恢复、再次翻译，恢复时无自有译文残留或静态原文缺失/改变。 |
| 标准扩展功能 | 8/8 套退出码 0：设置界面、划词、全文、视频、文档、术语库、隐私边界、用户脚本。设置 48 项断言、划词 37/37、术语库 9/9；12 种文档输入及 PDF/EPUB/DOCX 实际导出通过。 |
| JSON 站点规则 | 58/58 个结构夹具通过，悬浮 `[1,0,1,0]`、全文 `[1,0,1]`；373 次本地服务请求，无控制台错误或外部请求。含 10 个既有规则、47 个目录规则和 1 个自定义规则。 |
| 阅读助手 Harness | 32/32，含原有 30 项及实际执行的连续编辑、待保存快速关闭竞态。另一次关闭诊断 3/3，不与 32 项重复累加。 |
| 内容边界专项 | 四类结构分别完成悬浮/全文切换 `[1,0,1,0]`，元数据保持原样且不进入翻译请求。 |
| 原生 modal 与输入法 | 0.8×/2× 缩放、实际关闭、层级自愈及移除后归位通过；输入法组合中不保存拼音，提交“你好”后存储与重开一致。 |

所有浏览器均为隔离临时 profile、第二屏正常可见窗口，`browserFrontmost=false`。标准八套保留 430 张截图并完成关键图像检查，设置测试另有连续前台 PID 监控。八套控制台错误均为零；未单独采集 HTTP 错误的 runner 在摘要中记为 `null`，不推断为零。JSON/内容边界/modal 使用真实浏览器中的等价结构夹具和本地翻译响应，不冒充在线站点证据；文档测试验证 12 种解析与阅读布局，注入确定性校对译文后验证真实导出，没有声称已向在线供应商完成全篇翻译。用户脚本使用冻结脚本及确定性 GM API shim，不能等同于全部脚本管理器兼容性验证。

原始证据索引（本机）：

- 在线矩阵：`/private/tmp/fr-pr-integration-v3-network-summary.json`；有效日志为 `network-a.log`、`network-b.log`、`network-a-ubuntu.log` 的全文项及 `network-a-ubuntu-hover-retry.log`，均位于同一 `fr-pr-integration-v3-` 前缀下。
- 八套功能：`/private/tmp/fr-pr-integration-v3-compact-browser-summary.json`，内含每套报告路径。
- JSON 规则：`/private/tmp/fr-pr-integration-v3-site-adaptation-retry/report.json`。
- Harness/边界/modal/IME：`/private/tmp/fr-pr-integration-v3-selection-specials-summary.json`。

最终记录前再次逐一核对：647 个生产输入没有变化；233 个冻结 Chrome 文件与流水线构建目录完全一致；用户脚本摘要一致。审查未发现新增 skip/only/ignore、覆盖率阈值下调或排除项扩张；本次收尾提交仅包含报告、验证摘要和截图。

## 保留的观察项与证据边界

当前矩阵仍为 31 个 required 页面、62 项必测，加 8 个 quarantine 页面、16 项观察用例。已删除的 Steam 原讨论样本共 2 项仅因原内容已失效而退役，没有计为修复或通过。

16 项观察用例不属于这次通过计数：历史诊断中 DarkLyrics、Reddit、TalkClassical、W3C、ScienceDirect 和 Kaggle 未取得有效正文；RFC 4251 仍缺少 HTML PRE 格式化正文分段能力；小众软件仍缺少同语种 no-op/布局测试模式。具体诊断、产品与测试缺口见前述跟进报告，本轮没有通过删除它们或降低门槛让矩阵标绿。

v1/v2 的中间构建与失败日志保留作归因，不混入最终产物的成功计数。曾出现两个浏览器上下文关闭、焦点保护中止、LearnOpenGL MathJax 前置超时及一次夹具恢复超时；没有绕过焦点保护，v3 最终重跑期间没有再修改等待预算。本分支此前已将全文外层上限从 `max(12 分钟, 3 × 页面预算 + 5 分钟)` 调整为 `max(30 分钟, 8 × 页面预算 + 5 分钟)`，覆盖翻译、完整恢复、再次翻译两轮；阶段等待仅在目标实际完成时延长，仍保留无进展超时和 3 倍阶段硬上限，没有减少覆盖或恢复断言。上下文关闭及首次恢复超时的触发原因未完全查明，必须以同一最终产物的完整有效重跑作为验收。宿主 MathJax Processing Error 与插件译文恢复断言分别记录，不能将宿主错误隐藏后声称页面完全正常。

收尾文档第一次构建发现两个链接指向文档站明确排除的 `reports/**` 目录，已改为 GitHub 报告链接；文档重新构建退出码 0，记录于 `/private/tmp/fr-pr-integration-v3-final-docs-retry.log`。

本机 `/private/tmp` 原始证据可能随系统清理消失；本报告保留修复归因、测试范围、计数与产物摘要。正式 PR 的检查为空意味着没有托管 CI，不能解释为 GitHub CI 已通过。
