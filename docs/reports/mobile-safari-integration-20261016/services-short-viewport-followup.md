# 服务选择器短视口滚动与高度恢复补充（2026-10-18）

产品提交与原生构建源码均为 7e504c21ad5bc6e51c29c5cf79b352c088a19146。本轮修复服务选择器在极矮视口中无法让出列表空间，以及恢复常规高度后搜索框仍留在标题上方的问题；不增加控件或改变服务选择、请求、权限及按键行为。

此前 a41dddd／clean f281c5e 的原生横屏记录显示：抽屉只剩 58px，吸顶操作行占用 48px，长模型摘要还使首项增高。该记录只接受工具行、查询保留及退出流程，没有接受横屏列表可用。本轮修复正是针对这一未完成项，不能用旧流程的 PASS 代替新产品验收。

## 产品变化

- 小于 224px 的短模式中，标题操作行和同排搜索框随原抽屉 body 一起滚走，让结果使用可见空间。服务名与模型摘要单行省略，完整 DOM 文本和按钮 title 保留；46px 命中下限、48px 共享行、16px 输入字号及唯一 body 滚动容器保持。
- 仅对带所属视口标记的抽屉将过渡属性限制为 transform，保留原滑入效果，使视口几何变化不再参与全属性过渡。不改变根 Popup 尺寸协商或宿主页面滚动。
- 回到常规高度后，仍聚焦的搜索框即使已完整滚出标题上方，也会由原 reveal 逻辑移回标题下。所属实例、会话、节点、滚动容器及用户焦点检查保持；没有新增 focus、Enter、blur、计时器或重试。

## 本轮验证

| 范围 | 实际结果及边界 |
| --- | --- |
| 组件专项 | PopupApp 101 项、PopupServices 45 项，共 **146/146**；类型检查与测试注册审计退出 0。不是仓库全量回归。 |
| 新增生命周期回归 | 5 项覆盖部分遮挡、完整滚出屏幕、已可见、用户移走焦点、仍处短模式。旧实现的完整滚出场景实际失败：scrollTop 仍为 200，预期 24；修复后通过。几何与焦点采用受控端口，不代替真实 CSS 或 OS 键盘。 |
| 隔离 Edge 生产 UI v4 | **4 PASS / 0 FAIL**；实际宽 320px，初始高 58／80／220／224px，恢复至 224／600px。27 份原始 PNG 已由独审逐张查看；原始 JSON、命中与保留状态核对通过。 |
| 快捷抽屉过渡 v2 | 实际打开和关闭完成，transform 的 run／end 各 2 次，打开态计算属性为 transform，配置深比较不变、清理无误。关闭后所属标记释放，不把该属性限制推广到全部关闭阶段。 |
| 生产 Web | Chrome／Firefox 构建日志对应相同三份产品源码 pin，但构建早于提交；Safari 在干净的新提交之后构建并完成 manifest／Web 验证。 |
| 三目标本地原生编译 | SDK 检查、Web 验证、新包装及 macOS／iOS Simulator／iPhoneOS 六阶段全部退出 0；467 份 Web 资源与三平台内嵌资源逐文件一致，13 份完整文件图经独立 FS 复核。编译结果本身不包含运行验收；本轮实际安装后的结果见下节。 |

Edge v4 的短模式实际滚动到首项和末项，完整 46px 行可见并通过五点命中；操作行随同一 body 滚离可见区。每次从首／末项恢复到 224px，再恢复到 600px，搜索框回到吸顶标题下，原输入节点、查询、焦点、body 及宿主滚动保持。另有 224px 常规布局将搜索框完整滚出后再恢复的场景。

这轮 Edge 仅覆盖中文、浅色、默认界面及一个合成长模型标识。输入、Back、Close 和目标行有五点命中，Back／Close 实际点击；清除按钮虽可见，没有单独五点记录或点击验收。未选择服务商、未触发翻译，不作供应商成功或网络请求计数结论。桌面 CDP 的触摸／视口仿真不能替代原生 Safari、实际软键盘、物理触屏尺度或全语言／主题回归。

中间 CSS-only 方案的四格失败材料与旧组件失败日志保留，未被后续通过覆盖。快捷抽屉首版采集器漏记所属标记释放后的关闭事件，其失败记录也保留；更正采集器后的实际结果单独记录。

macOS／Simulator 为链接器 ad-hoc、无开发者团队；iPhoneOS 未签名、无团队。这些分类来自 Root 实际记录的 codesign／file 结果，并由独审结合真实可执行文件 hash 复核，不等于开发者签名、发布或真机验收。产品版本、依赖与权限没有因本次修复改变，未借用参考仓库实现。

## 最新原生运行 R7：键盘、短列表与回程通过

同一 7e504c21… 生产包在任务专用 iPhone 16 Pro／iOS 26.2 Simulator 中实际运行，官方结果为 **1 PASS / 0 SKIP / 0 FAIL**；所选方法 73.008 秒，官方测试总耗时 79.124 秒。未增加产品修改，也未放宽原有 3 秒新鲜度、完整行、命中、单次手势或退出检查。

实际流程为：打开服务选择器并输入 `gpt`，保持原生软键盘旋转到横屏；在 58px 抽屉的保守 50px 内容区中只拖动一次，让操作行滚走，随后完整显示 Fireworks AI 的 46px 服务行。该行有实时命中证据，长模型摘要单行省略，没有点击服务或触发翻译。正常旋回竖屏后，`gpt` 与原生键盘保留，搜索框重新显示在标题下；清除搜索、返回服务概览、关闭抽屉和原生 Popup、回到已知本地夹具均实际完成。

| 场景 | 原图 |
| --- | --- |
| 竖屏输入与软键盘 | [截图](./services-short-viewport-evidence/native-r7/portrait-gpt-keyboard.png) |
| 横屏紧凑操作行 | [截图](./services-short-viewport-evidence/native-r7/landscape-controls.png) |
| 一次拖动后完整服务行 | [截图](./services-short-viewport-evidence/native-r7/landscape-complete-row.png) |
| 回到竖屏，搜索框恢复可见 | [截图](./services-short-viewport-evidence/native-r7/portrait-return.png) |
| 清除后返回服务概览 | [截图](./services-short-viewport-evidence/native-r7/returned-overview.png) |
| 关闭抽屉后的主 Popup | [截图](./services-short-viewport-evidence/native-r7/returned-popup.png) |
| 关闭原生 Popup 后的本地夹具 | [截图](./services-short-viewport-evidence/native-r7/closed-fixture.png) |

12 张原始 PNG 已由 Root 与独审分别逐张检查；独审另读完 69 份 JSON（含 10 份 AX）及 81 行附件清单。公开七图保持原始字节，见[本轮摘要](./services-short-viewport-evidence/native-r7/summary.json)及[复制索引](./services-short-viewport-evidence/native-r7/copy-index.json)。本轮没有权限选择，站点授权恢复后的持久性仍未知。查询和键盘连续性不等于物理 DOM 节点或焦点身份的证明，也不推广为所有 Popup 控件均为 46px。

运行后重新核对本轮恢复路径：D9 包 485 文件、内嵌 Web 467 文件、限定原生私有范围 13 文件、Userscripts 应用 47 文件及 Demo 396 字节与基线一致，独审完成逐文件 hash／大小复核。未复制回私有文件，不声称所有扩展存储保持；所属进程和端口释放，模拟器 Shutdown，主机前台应用保持。

### 中间原生运行仍保留 SKIP

R2–R6 的结果均为 **0 PASS / 1 SKIP / 0 FAIL**，没有改写：R2 因权限提示站点不匹配停止；R3 停在视频页原生控件最后检查，R4 对精确授权的 m.youtube.com 实际选择“允许1天”后用尽准备时限，均未进入本地 Popup 验收；R5 停在滚动前快照新鲜度检查；R6 实际完成一次拖动并显示 Fireworks AI，但测试的五项已知服务集合漏掉该行，未进入回程。R7 仅在测试识别集合中补齐现有服务的精确标签，再实际通过完整流程。快照读取调整和测试标签补齐均未改变产品包；各轮原始材料在本地分别保留。

## 历史原生运行 R2：权限提示站点不一致，SKIP

7e504c21… 的生产包已在任务专用 iPhone 16 Pro／iOS 26.2 Simulator 中实际安装并运行。官方结果为 **0 PASS / 1 SKIP / 0 FAIL**，所选方法 21.985 秒，官方测试总耗时 28.313 秒。

已加载的本地夹具及地址栏均为 `127.0.0.1`。通过 Safari 页面菜单点击流畅阅读后，原生提示却为“流畅阅读”想要访问 `m.youtube.com`。用例仅接受 localhost 的精确权限提示，因此未点击任何权限选项并停止。六项启动／导航／入口动作各一次；未取得可验收的生产 Popup 视图，未执行输入查询、呼出键盘、旋转或列表滚动。

| 已知本地夹具 | 站点不一致的权限提示 |
| --- | --- |
| [原图](./services-short-viewport-evidence/native/known-localhost-fixture.png) | [原图](./services-short-viewport-evidence/native/mismatched-host-permission-prompt.png) |

23 份诊断 JSON 与两张原始 PNG 已核对，图片逐字节保留。源码检查未发现向 m.youtube.com 主动申请权限的调用链，但缺少生产 Popup 实际 browser API 返回与提示的时序记录，**提示来源仍未确定**；不据此改产品或放宽权限提示检查。

退出后，安装前 D9 基线包的 485 份文件、其中 467 份 Web 资源、13 份限定原生私有文件、Userscripts 应用 47 份文件及 396 字节 Demo 均按完整文件图核对恢复；未将私有文件复制回去，也不声称全部扩展存储均已恢复。所属进程已退出、端口释放，模拟器 Shutdown，主机前台应用保持。结果与复制哈希见[原生摘要](./services-short-viewport-evidence/native/summary.json)及[复制索引](./services-short-viewport-evidence/native/copy-index.json)。

**R2 本身没有验收原生列表、键盘及高度恢复。** 其 SKIP 和安全恢复不等于产品 UI 通过；同一产品后续 R7 的实际通过单独记录于上节。

## 浏览器原始截图

| 场景 | 原图 |
| --- | --- |
| 58px 初始工具行 | [截图](./services-short-viewport-evidence/edge/services-short-zh-CN-gpt-58-top.png) |
| 58px 首项完整可见 | [截图](./services-short-viewport-evidence/edge/services-short-zh-CN-gpt-58-first-row.png) |
| 58px 末项完整可见 | [截图](./services-short-viewport-evidence/edge/services-short-zh-CN-gpt-58-last-row.png) |
| 末项滚动后恢复 600px | [截图](./services-short-viewport-evidence/edge/services-short-zh-CN-gpt-58-last-return-600.png) |
| 224px 将搜索框滚出 | [截图](./services-short-viewport-evidence/edge/services-short-zh-CN-gpt-224-224-scrolled.png) |
| 224px 场景恢复常规高度 | [截图](./services-short-viewport-evidence/edge/services-short-zh-CN-gpt-224-normal-return.png) |

六张公开截图均从原始 PNG 逐字节复制，未裁切或重编码。断言范围与来源哈希见[Edge 摘要](./services-short-viewport-evidence/edge/summary.json)和[复制索引](./services-short-viewport-evidence/edge/copy-index.json)。

## 历史结果保持原范围

- a41dddd／clean f281c5e 的标题／键盘旋转流程为 **1 PASS / 0 SKIP / 0 FAIL**，方法 65.468 秒。它确认标题、工具行、查询与退出流程；横屏列表被键盘遮挡，未选择服务商。该流程不含本次短视口修复。
- 同一旧产品的 YouTube 即时入口诊断为 **0 PASS / 1 SKIP / 0 FAIL**，方法 14.208 秒。取消静音后未读取到三个精确入口标签，没有入口点击、菜单选项或重试；英文画面文字来源未确定，不能声称 FluentRead 字幕、AVKit 或 #992 完整链路通过。
- Android Firefox F36 使用 f281c5e 生产包，观察到 On、一次拖动、Off 及限定页面保留；正常流程仍失败，恢复路径没有改写失败状态。限定产物与资源恢复通过，不等于位置持久化、完整悬浮翻译或正常流程验收。

更早版本的范围见[标题与旋转补充](./services-title-rotation-followup.md)及[分版本验收](./acceptance.md)。本轮未执行签名发布、物理设备或本地全量回归。

完整运行报告、编译身份、文件图和独立审查保存在本地研究目录；公开摘要列明对应文件大小与 SHA-256，截图复制索引可用于核对原始字节。本报告补充历史记录，不改写各版本结果。
