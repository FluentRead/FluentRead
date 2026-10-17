# Safari 触摸 Popup 竖屏填宽补充（2026-10-17）

源码 `461c2fb3b310382f67fa3b21303733a590783bfd` 修复了 Safari 触摸 Popup 沿用桌面固有宽度的问题。仅在 Safari 且当前输入能力为 `any-pointer: coarse` 时启用自有标记，让根容器随宿主填宽，并让已有可见视口标记的抽屉使用当前视口宽度；页内嵌入、桌面和 Firefox Android 保留各自尺寸契约。标记在 pagehide、卸载或挂载失败时按所有权清理。

## 源码与构建验证

4 份专项测试共 **255 项通过**，三份改动文件的字节与随后 clean `461c2fb` 提交的源码绑定一致。专项测试在提交前执行，旧回执中的“原生构建与运行待完成”保留为当时状态；最新 `461c2fb` 类型检查退出 0。Safari Web 构建退出 0，SDK 检查、Web 资源校验、全新 wrapper 与 macOS、iOS Simulator、iPhoneOS 六阶段均退出 0。clean source binding 为 `9524ba02…`，编译身份为 `62b1353c…`。这些构建记录证明本地编译及资源对应，不代表签名发布或物理设备验收。[完整 pins 与范围](./portrait-touch-width-evidence/validation-and-runtime-summary.json)。

## 本次 portrait 操作结果

专用 iPhone 16 Pro / iOS 26.2 Simulator 的单一用例实际为 **1 PASS / 0 SKIP / 0 FAIL**，执行器退出 0。Root 与运行复核者已审阅 **8 张原始 PNG、44 份 payload JSON**。主内容和服务概览的 AX 宽度由旧包的 308 变为 386，与本次普通 WebView 的 386 相同；键盘阶段的 WebView 与 dialog 则为 402。AX 帧不是计算后 CSS，也不能据此确定缩放根因或认为所有阶段宽度固定。

服务抽屉依次完成 7 个动作：打开服务概览、进入默认服务选择器、聚焦搜索、输入 `gpt`、清除、返回概览、关闭抽屉。查询分类先为 `gpt`、清除后为空；清除后键盘仍在，随后返回概览时键盘消失。该次打开选择器时键盘已经出现，不能把键盘出现单独归因于显式聚焦动作。最后正常原生“完成”关闭 Popup，回到同一已知 localhost fixture。本次没有权限选择、服务选择、翻译请求或配置写入意图。

| 观察点 | 当前原始 PNG |
| --- | --- |
| 普通 Popup 填宽 | [原图](./portrait-touch-width-evidence/attachments/CF0F7CBC-56DE-4FC6-B3A1-A7C5997BA666.png) |
| 服务概览填宽 | [原图](./portrait-touch-width-evidence/attachments/21C8154D-B49F-479D-B92F-837DC6FE73CB.png) |
| 键盘下 `gpt` 搜索 | [原图](./portrait-touch-width-evidence/attachments/8D472498-D7DD-491C-A548-DFDF929B10BA.png) |
| 关闭后同一 fixture | [原图](./portrait-touch-width-evidence/attachments/1E555D93-B8BE-4972-A486-8AC8A3D9F781.png) |

## 证据与未覆盖项

[复制索引](./portrait-touch-width-evidence/copy-index.json)包含当前用例 53 份原件：8 PNG、44 payload JSON 和 1 份导出 manifest。复制前后逐件核对 SHA-256 与字节长度，保持原始字节。导出 manifest 本身不含预期摘要和长度，索引是本次源文件与副本的实测身份。JSON 里的绝对路径仅是研究来源标识；仓库可用副本以索引的 `files[].copy` 为准，外部报告及其嵌套 pins 没有在此全部公开复制。SDK 日志、App、二进制、DerivedData、恢复记录和 native private 文件或完整私有哈希图未纳入本次交付副本。

本次只确认 portrait 主内容与服务概览填宽，以及搜索、清除、返回和关闭的有限流程。普通 Popup 下方卡片仍可见截断；没有执行滚动，不能据此断言不可滚动。服务列表与完整 Popup 底部可达性、横屏旋转、焦点保持或焦点返回、后台恢复、其他屏幕和皮肤、provider 请求、服务与模型持久化、物理设备及签名发布仍未验收。另行准备中的旋转场景不在此记录 PASS。

此前 `cae1d612…` 构建和 Safari 的 SKIP 历史继续按[旧报告](./clone-entry-followup.md)保留，本结果不覆盖视频入口、菜单滚动或 AVKit 的未完成记录。Android E5 在 live AX 与 tap 前因工具收据字段错误停止，实际 0 tap；它没有提供新版 Android 产品结论。移动端与 Safari 的整体目标仍在进行中。

## 后续记录

横竖屏新用例在启动 Safari 前因初始方向未知停止，详见[独立记录](./rotation-touch-width-followup.md)，不改变本文的限定竖屏结果。原复制索引中的 staging 状态保留创建时点；此处公开附件已经按该索引逐字节复制至仓库报告目录。
