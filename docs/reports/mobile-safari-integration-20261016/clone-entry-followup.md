# 同播放器重复入口修复补充

站点保留原控制组，又在同一播放器范围追加完整控制组克隆或独立入口副本时，旧实现可能留下没有点击监听的重复入口。本次修复保留真实按钮和原监听，记住已认领的局部范围，在控制组变化、禁用、换媒体／播放器及销毁时清理本实例 owner 的副本。其他 owner、无关播放器和范围外节点保留；新增范围清理不认领 body/html。已有根节点 host 的历史清理逻辑不属于这项新限制。见[独立源码审查](./clone-entry-evidence/reviews/independent-production-review.json)。

| 验证 | 实际结果 | 原始证据 |
| --- | --- | --- |
| 新增公开 API 基线 | 11 FAIL；其余 83 项被过滤，未运行 | [基线回执](./clone-entry-evidence/tests/baseline-execution.json)、[原报告](./clone-entry-evidence/tests/baseline-vitest.json) |
| 修复后绑定模块 | 99/99 PASS；行、语句、函数、分支均 100% | [最终回执](./clone-entry-evidence/tests/final-scoped-test-receipt.json)、[覆盖率](./clone-entry-evidence/tests/final-coverage/coverage-summary.json) |
| 相关测试最终去重统计 | 1648 项通过 | [Root 汇总](./clone-entry-evidence/validation/root-targeted-verification-summary.json) |
| 旧 Chrome 产物 | 仅首个 desktop whole-host 场景到达断言，副本仍连接、owner 数仍为 2，形成 RED；随后停止 | [attempt3 原报告](./clone-entry-evidence/browser-old-attempt3/report.json)、[失败原图](./clone-entry-evidence/browser-old-attempt3/failure.png) |
| 候选 Chrome 产物 | 桌面／移动视口各 whole-host、loose、禁用，共 6 场景 PASS，退出 0 | [原报告](./clone-entry-evidence/browser-candidate/report.json)、[Root 回执](./clone-entry-evidence/root-browser-outcome.json) |
| 停止后错误注入 | 同样 6 场景 PASS；唯一固定合成错误使进程按预期退出 1 | [注入原报告](./clone-entry-evidence/focus-stop-fault/report.json)、[独立复核](./clone-entry-evidence/reviews/independent-focus-stop-fault-outcome-review.json) |
| 生命周期跟进 | 单次顺序流程完成 12 个命名快照，退出 0，errors 为空 | [原报告](./clone-entry-evidence/lifecycle/report.json)、[Root 退出回执](./clone-entry-evidence/lifecycle/root-outcome.json)、[独立复核](./clone-entry-evidence/reviews/independent-lifecycle-outcome-review.json) |

1648 是 `99 + 1254 + 251 + 21 + 23`，覆盖绑定、相邻模块、焦点安全、验证资源归属及清理端口。初始 295 项验证端口运行曾有 5 项 sandbox `listen EPERM`；随后只重跑清理文件的 23 项并全部通过，不能把原 295 项改写成全绿。首轮严格覆盖率也保留：98 项断言虽通过，分支仅 286/287（99.65%），进程退出 1；补充真实菜单宿主被错误移位的公共 API 用例后，最终为行／语句 403/403、函数 34/34、分支 287/287，无跳过。见[首轮回执](./clone-entry-evidence/tests/first-strict/receipt.json)及[独立证据复核](./clone-entry-evidence/reviews/independent-regression-evidence-review.json)。这些是相关范围验证，不是整库覆盖率。

候选中的四个副本修复场景确认原生 MutationObserver 在点击或手动 sync 前移除同 owner 副本，真实按钮身份和父节点保持；外 owner、无关播放器及原生按钮保留。另外两个场景覆盖真实配置禁用，操作时副本已清除，不能据此声称浏览器已验证禁用前尚待投递的副本。菜单 entry／Close 点击为 trusted，关闭后焦点返回。原图里额外的 foreign-owner 图标是隔离夹具刻意保留的节点。正常、故障注入与生命周期运行均保存无自有浏览器激活事件、受控关闭完成及临时 profile 已删除的记录。见[浏览器独立复核](./clone-entry-evidence/reviews/independent-browser-outcome-review.json)。

注入包装器透传真实 helper 和观察器，只在实际 `monitor.stop()` 成功之后，通过公开 `error` getter 返回 `INJECTED_FOCUS_OBSERVER_FAILURE_DURING_STOP`。runner 的 finally 保存该唯一错误并退出 1，同时完成关闭与 profile 清理。这是人工验证错误契约，未制造真实 Swift／NSWorkspace 故障，也不覆盖每种原生停止故障时点。[包装器原字节文本](./clone-entry-evidence/focus-stop-fault/focus-stop-fault-helper.cjs.txt)与[覆盖配置原字节文本](./clone-entry-evidence/tests/scoped-coverage.config.mts.txt)仅供审阅，不作为仓库可执行依赖。

生命周期 12 个快照依次为：竖屏内联 → 网页控件可见 → 竖屏菜单 → 菜单提示滚动位置 → 普通关闭 → 横屏内联 → 受控全屏几何 → WebKit shim 入口 → video 节点替换后 ready → 实际页面重载后 ready → 桌面菜单普通关闭 → 禁用清理。它们是一次流程中的记录点，不是 12 次隔离测试。菜单底部内容通过滚动到达，初始截图不要求整张菜单同时显示；滚动命中、键盘与关闭后焦点契约均有断言。[菜单原图](./clone-entry-evidence/lifecycle/portrait-menu.png)、[关闭原图](./clone-entry-evidence/lifecycle/portrait-menu-normal-close.png)、[横屏原图](./clone-entry-evidence/lifecycle/landscape-inline.png)由独立复核实际查看。

该生命周期使用本地 HTML、timedtext、生成媒体及 mock 译文；WebKit 能力／事件和 TextTrack 选择由受控端口模拟，fullscreenElement 为 DOM 夹具，安全区协议缺失时只验证几何回退。手工 `pageshow({persisted:true})` 不是真实 BFCache 恢复。替换／重载仅证明本夹具重新 ready，禁用只证明显式字幕层和 owned cues 清空；不据此声称所有监听器、计时器或内存均已清理。独立复核查看了 6 张原图，并未看完全部截图。结论不扩展到真实 Safari、iOS／AVKit、系统字幕菜单、刘海安全区、真实 BFCache、live YouTube 或翻译服务。

类型检查、测试审计、Chrome／Firefox／Safari Web／userscript 构建及对应产物检查均已通过，[构建回执](./clone-entry-evidence/validation/summary.json)和[四平台产物身份](./clone-entry-evidence/web-artifacts/artifact-gate.json)已封存。Web 版本仍为 **0.0.38**；Native 仍为 **1.0 / build 1**，两者未做同值比较，也未更改版本。

| 本轮本地 Native 编译 | 实际退出码 |
| --- | --- |
| macOS Release | 0 |
| iOS Simulator Release | 0 |
| iPhoneOS arm64 Release | 0 |

[本轮 Native 汇总](./clone-entry-evidence/native/execution-summary.json)记录检查、Web 校验、全新本地 wrapper 和上述三次编译。[Root 只读身份核验](./clone-entry-evidence/native/root-verification-execution.json)亦退出 0，已生成[App／appex、架构和内嵌 Web 身份清单](./clone-entry-evidence/native/compiled-artifact-identities.json)。[独立产物复核](./clone-entry-evidence/native/independent-outcome-review.json)实际重读三份完整 App 共 **1452 文件、191604005 字节**（482 / 485 / 485），每份 467 项 Web 资源精确一致；内嵌 Extension 已包含在 App 数量内，不重复累加。 编译与资源字节核验不代表 Safari 扩展已注入或运行验收通过。

本轮未手工安装／启动／注册验收，macOS 构建包含 Xcode 自动 LaunchServices 注册步骤。冻结身份原件 scope 中过宽的 “No install, registration” 已由[追加口径更正](./clone-entry-evidence/native/scope-correction.json)修正，原始字节保持。没有使用开发者证书签名或发布；当前 arm64 主机的 codesign 读回显示 macOS／Simulator 为无团队的链接器 ad-hoc；逐 Mach-O slice 核对表明其 arm64 带 linker ad-hoc 签名、x86_64 无 LC_CODE_SIGNATURE，iPhoneOS arm64 也未签名。不能据此称通用二进制全部架构都已签名。

产品提交为 `cae1d61221670a9d6812f803c3acefd8654ea300`。实际构建发生在 `121c0217…` 加当时未提交补丁的工作树；[提交对应回执](./clone-entry-evidence/root-product-commit-correspondence.json)逐项确认 14 个冻结输入与产品提交 blob、当前字节相同，不把构建改写为提交后重新执行。[最后资源检查](./clone-entry-evidence/fresh-resource-release.json)在 2026-10-16 23:23:58 UTC 记录 laneReleased=true、专用模拟器 Shutdown，已知本任务进程组／浏览器／观察器及所列端口无遗留；这是该时点的检查结果。

[r5 研究对应的 Safari E2 摘要](./clone-entry-evidence/safari-e2-boundary.json)仍为 **0 PASS / 1 SKIP / 0 FAIL**：地址编辑框的精确 URL 前置未验证，导航、入口 tap 和 Popup Read 均未发生。三个同名 AX 节点不能证明三个同 owner DOM 副本，也不能归因为本次源码缺陷。r5 的 10 项隔离 fake-DOM／时钟 VM 通过只是研究源码证据，不改变 E2 的 SKIP；fake `isTrusted` 不是真实浏览器 trusted 证据。相关研究原件按交付清单只引用，不复制私有附件或业务配置。

本次新增证据按[复制索引](./clone-entry-evidence/provenance.json)保留 66 份原件，共 1911054 字节，逐份复制后重哈希；App、二进制、DerivedData、SDK 原始日志及 E2 私有附件未纳入仓库。JSON 中的绝对路径是研究原件标识，仓库可用副本以索引的 copy 字段为准。

真实 Safari 播放中菜单和滚动、AVKit、完整安装更新、原生键盘、旋转、长期后台恢复、物理设备与 VoiceOver／TalkBack 仍未完成。独立 PR #1014 的翻译质量及 #1015 的 Safari bridge／学习后续保持各自范围，本次未借鉴参考仓库实现，也未改版本、依赖或权限。

2026-10-17 补充：`461c2fb` 的 portrait Popup 填宽，以及搜索、清除、选择器“返回”和关闭的限定结果见[竖屏填宽补充](./portrait-touch-width-followup.md)。上文保留 `cae1d612…` 当时的构建、SKIP 与边界；此补充不覆盖视频菜单／滚动、AVKit、旋转、后台恢复或物理设备，也不把“返回已通过”扩展为焦点返回验收。
