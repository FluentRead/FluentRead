# 字幕菜单滚动与键盘焦点修复

短播放器中的字幕菜单滚到时间调整或底部提示时，关闭按钮会随标题滚出可见区域。现在标题和关闭按钮保持可见，滚动顶部背景完整；键盘切换项目时预留标题空间，避免焦点落到标题下方。产品改动仅为字幕菜单的六条 CSS 声明，桌面保持紧凑尺寸，触屏保持至少 44×44 的操作目标。

## 缺陷与复验

| 阶段 | 实际结果 |
| --- | --- |
| 原生产基线 | 时间行位置的关闭按钮可见高度仅 14.50px，中心命中视频；底部提示位置完全不可见。 |
| 首个固定标题候选 | 正常关闭及焦点返回恢复，但第 6 次键盘操作到 Off 时，目标被标题遮住，五个采样点全部命中覆盖层，仍然失败。 |
| 最终菜单专项 | 退出 0、错误为空；18 个菜单几何场景，触屏 12 次真实键盘操作、正常关闭和 Escape 焦点返回、桌面紧凑呈现及禁用清理通过。 |
| 修正旧测试预期后的完整受控流程 | 退出 0、12 个具名场景、错误为空；轨道选择、换视频、刷新、合成 pageshow 后就绪及菜单清理断言通过。 |

原始[基线失败](./current-menu-scroll/baseline-geometry/report.json)、[首个候选失败](./current-menu-scroll/sticky-only/report.json)、[菜单专项结果](./current-menu-scroll/menu-suite/report.json)与[完整受控结果](./current-menu-scroll/lifecycle-corrected-oracle/report.json)分别保留。所有触屏目标在实际裁切范围内完整可见，五个内部采样点均命中所属控件；键盘按键没有通过手工聚焦或强制滚动来修补结果。独立审查实际查看了菜单专项 23 张原图和完整流程 11 张关键原图，见[菜单审查](./current-menu-scroll/independent-menu-suite-runtime-review.json)与[生命周期审查](./current-menu-scroll/independent-corrected-lifecycle-review.json)。

![基线：滚到底部提示后，关闭按钮已滚出可见范围](./current-menu-scroll/baseline-geometry/portrait-menu-hint-targets.png)

![修复后：底部提示可见，标题和关闭按钮保持可操作](./current-menu-scroll/menu-suite/portrait-menu-hint-targets.png)

![修复后：键盘到 Off 时，焦点控件完整位于标题下方](./current-menu-scroll/menu-suite/portrait-menu-keyboard-6-ArrowUp.png)

![桌面保持紧凑菜单和原有目标尺寸](./current-menu-scroll/menu-suite/desktop-menu-open.png)

## 字幕选择测试的预期更正

旧完整脚本在 `A→FluentRead→Off→FluentRead→退出` 后要求恢复最初的站点字幕 A，实际保持 disabled，原始[失败记录](./current-menu-scroll/final-geometry/report.json)没有覆盖或改写。现有产品状态机及既有单测要求保留用户的最新选择：Off 会清除过时的来源归属，之后再选 FluentRead 也不应复活 A。

测试现在分别要求 `A→FluentRead→退出` 恢复 A，以及含 Off 的链路保持 A disabled，并保留 Off 跨重进、另选站点轨道 B 和禁用后的来源保护。产品原生轨道状态机未修改。每次测试选择写入前订阅真实 `TextTrackList.change`，要求可信事件，在事件分发后的下一任务复核全部目标模式，并保留绝对 2 秒截止。实际 11 份选择回执共记录 17 个可信事件，最长约 6.3ms；cue 数量仅另作就绪检查。见[更正补丁](./current-menu-scroll/native-oracle-preparation/native-oracle.patch)、[静态审查](./current-menu-scroll/native-oracle-preparation/independent-code-review.json)及[实际结果](./current-menu-scroll/root-corrected-lifecycle-outcome.json)。静态审查当时尚未执行浏览器，其待验证项由后续独立[事件回执补充审查](./current-menu-scroll/native-oracle-preparation/independent-browser-ack-addendum.json)关闭，两个时点分别保留。

## 构建与证据边界

三份布局相关测试共 147 项、原生轨道既有测试 27 项、类型检查及测试审计通过。Chrome、Firefox、Safari Web 和 userscript 生产构建以及相关校验通过；[第一组验证](./current-menu-scroll/final-build/summary.json)、[跨平台验证](./current-menu-scroll/cross-platform-build/summary.json)与[完整产物身份](./current-menu-scroll/artifact-gate.json)分别绑定源文件和逐文件清单。两轮浏览器运行的所属关闭检查完成，临时 profile 删除，未观察到本轮浏览器抢焦点；[随后资源检查](./current-menu-scroll/root-fresh-corrected-lifecycle-release.json)确认专用进程、端口和模拟器已释放。

- 运行使用本地 YouTube 拓扑、timedtext 与翻译响应夹具、Chromium 触屏和视口模拟。时间行与提示位置由受控 DOM 设置，未验证原生手指惯性滚动或在线供应商。
- 标准 TextTrack 模式写入及隔离世界的 webkit 事件 shim 只验证共享逻辑，不能证明 Safari/AVKit 系统菜单选择或渲染。
- CDP 安全区注入 API 不可用，本轮只通过 fallback 与 DOM 全屏几何，没有验证 44px/24px 刘海安全区或系统窗口全屏。
- 桌面确实为 `coarsePointer=false`、`maxTouchPoints=0`，四个记录的 scrollTop 均为 0；只接受紧凑呈现、End/Home 和正常关闭，未覆盖桌面溢出滚动。
- pageshow 使用合成 persisted 事件后检查就绪，没有真实 BFCache 转移或独立 pageshow 截图。刷新截图证明网页双语恢复；该时刻原生 cue 仅英文，未断言刷新瞬间的原生双语就绪。
- 此前 a2 的独立真实 Safari 运行记录为 [0 PASS、1 SKIP](./current-menu-scroll/safari-precondition-skip/inline-attempt1/runtime-summary.json)。只执行一次正常播放器中心触摸，未达到入口和关闭控件前置，未打开、滚动或关闭菜单；[限定结论](./current-menu-scroll/safari-precondition-skip/root-runtime-outcome.json)不能转记为这份修复产物的验收。

## Safari 三目标本地编译

同一最终菜单源码 `6eecd6710e7daac2d2a8cca9a34d0f26dc849b44` 已生成独立 Safari 双平台工程，并顺序完成 macOS、iOS Simulator、arm64 iPhoneOS 三目标本地编译；SDK 检查、Web 校验、工程生成及三次编译共六条命令均退出 0，随后产物校验也退出 0。独立复核实际重读三个完整 App 共 **1,452 份文件、191,602,241 字节**（482 / 485 / 485），每份产物内的 467 份 Web 资源均与 raw `b1a66b3fc4e579216321758ebb921b7396430610119c9e5ca356de23b8cfc161` 精确匹配；源文件及输入 Web 前后保持一致。见[执行摘要](./current-menu-native/execution-summary.json)、[完整身份](./current-menu-native/compiled-artifact-identities.json)与[独立复核](./current-menu-native/root-independent-compiled-review.json)。

本地 App/Extension 版本均为 1.0 / build 1；macOS 与 Simulator 为链接器 ad-hoc、无开发者团队，iPhoneOS 完全未签名。三份 App 全文件统计已包含其内嵌 Extension，不能再次累加。本次三目标编译阶段未安装、启动模拟器或执行 Safari UI，编译通过不能代替安装更新、真实 Safari/AVKit、物理设备或开发者签名发布验收。后续真实 Safari 的单次观察另列下节，编译记录不覆盖其跳过结果。

独立产物复核没有进行新的进程或端口检查；Root 的[资源释放记录](./current-menu-native/fresh-resource-release.json)另证所查 owned 进程、端口无残留，任务 Simulator 为 Shutdown，`laneReleased=true`。选择复制的 22 份证据及逐文件哈希见[原件映射](./current-menu-native/provenance.json)。复制 JSON 内的绝对路径保留原样，指向本地研究原件，不表示这些路径可在仓库中打开；仓库中可用副本以该映射的 `copy` 字段为准，App/DerivedData 未纳入文档。
## 当前修复包的真实 Safari 单次观察

同一菜单源码 `6eecd6710e7daac2d2a8cca9a34d0f26dc849b44` 的完整 Simulator App 已安装至专用 iPhone 16 Pro / iOS 26.2 Simulator，并在 Safari 执行一次观察；研究 harness 为本次新编译，源码、三份二进制、运行 plist 与唯一 selector 经[独立编译绑定复核](./current-menu-safari/compiled-binding-independent-review.json)。本次实际结果是 **0 PASS / 1 SKIP**，测试持续 12.640 秒；[原始摘要](./current-menu-safari/inline-attempt1/runtime-summary.json)与[独立运行审查](./current-menu-safari/runtime-outcome-review.json)没有把执行器退出 0 或恢复成功算成产品通过。

第二个只读观察样本中，唯一所属字幕入口自行出现，实际 AX 为 44×45 点、可命中且完整位于播放器内；此前没有播放器中心触摸。随后 XCTest 发出一次正常入口 tap，等待 3 秒仍未建立“关闭字幕菜单”控件，测试在滚动、关闭和焦点回归断言前跳过，未重试。动作记录 `FRMenuOpen:1` 表示一次点击尝试，不表示菜单已打开。复合 skip 文案中的“required original image unavailable”也不能解释成截图工具故障：Close 等待先失败，后续菜单截图调用因短路未执行，四张已导出的原图均保留。见[原始动作](./current-menu-safari/inline-attempt1/runtime-evidence/menu-scroll-result.json)、[入口观察](./current-menu-safari/inline-attempt1/runtime-evidence/menu-readiness-before-reveal-summary.json)及[运行日志](./current-menu-safari/inline-attempt1/runtime-run.log)。

Root 和独立审查均实际查看全部四张原图：白色加载页、黑色播放器、英文片头与粉色字幕入口、随后加载的 YouTube 视频及页面内容；最终原图未见菜单。图片与其后的 AX 是顺序采集，不能当作原子同帧；也无法排除两次截图之间的短暂状态。当前缺少事件到达及 DOM / 媒体身份时间线，不能确定输入投递、节点重绑、显隐或 AX 变化中的唯一原因；不把入口出现、视频画面变化记作稳定播放、双语或菜单滚动通过。

![第二个只读样本：英文片头与粉色字幕入口可见](./current-menu-safari/inline-attempt1/runtime-evidence/menu-readiness-before-reveal-2.png)

![单次入口点击后：最终原图未见字幕菜单](./current-menu-safari/inline-attempt1/runtime-evidence/unverified-final.png)

本轮只安装一次、运行一个测试、恢复一次原 App。原 d9 完整 485 文件已恢复，五阶段 Userscripts47、所列 native App 私有17文件哈希及 Demo 保持一致；数据容器 UUID 迁移单独记录，没有复制私有文件回去，不代表所有扩展设置或缓存均被检查。任务模拟器已 Shutdown，所查 owned 进程与端口释放，未观察到本轮抢焦点。见[限定结论](./current-menu-safari/root-runtime-outcome.json)、[五阶段恢复记录](./current-menu-safari/inline-attempt1/identity-after-shutdown.json)、[独立资源检查](./current-menu-safari/root-fresh-post-runtime-release.json)及[46 份原件复制索引](./current-menu-safari/provenance.json)。此前 a2 的 SKIP 保留，不能用本次入口观察覆盖；后续诊断与真实菜单滚动仍未完成。


上述受控菜单检查与本地编译通过，不等于真实 Safari 或移动端完整矩阵验收通过。物理设备、辅助技术、原生键盘、旋转与后台回收、真实 Safari 播放及菜单滚动仍需单独验收。本次未借鉴参考仓库代码，没有变更版本、依赖或权限；受控菜单原件及复制哈希见[复制索引](./current-menu-scroll/provenance.json)，本次编译与真实观察分别见上面的分项索引。

## 同播放器入口副本后续修复

本轮新增修复、最终构建及平台边界见[同播放器重复入口修复补充](./clone-entry-followup.md)。该报告保留旧包失败和真实 Safari 跳过结果，不将本地编译或受控 Chromium 通过转记为真实平台验收。
