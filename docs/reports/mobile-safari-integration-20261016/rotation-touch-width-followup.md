# Safari 横竖屏用例的初始化停止记录

本次使用与[竖屏填宽验收](./portrait-touch-width-followup.md)相同的 `461c2fb` 生产包。新测试程序编译及独立绑定复核通过，但实际运行在启动 Safari 之前停止：首次读取专用模拟器方向为 `unknown`，不满足初始竖屏前置条件。

官方结果为 **0 PASS / 1 SKIP / 0 FAIL**；外层进程退出 **1**。原始附件只有两份 JSON，没有截图。`actions` 为空，没有启动 Safari、打开 Popup、输入、切换横屏或选择权限，因此本次既不能验收旋转，也不能据此判断产品布局有缺陷。finally 使用一次竖屏设置，立即读回 `portrait`；这个清理结果不代表界面布局通过。

原 guard 仍尝试终止指定 Safari，原生工具返回 code 3 和 `found nothing to terminate`。原始清理错误与 `laneReleased=false` 均保留。随后完整恢复原 D9 安装并核对 485 份文件及 467 份 Web 资源，13 份 native App 私有文件、Userscripts 与 Demo 内容匹配，专用模拟器已 Shutdown。后时点的独立资源检查确认所属进程和所列端口已释放；它不把本次 guard 或运行结果改为通过，也不代表检查了全部扩展存储。

下一版测试需显式设置一次初始竖屏，并与横屏返回／finally 共用的一次恢复额度分开；初始化失败不得再次设置重试。清理仅可精确识别本次指定 bundle 的完整“已经没有进程”输出，保留原始 code 3，其他错误仍失败。这些是测试工具修正，尚未执行新用例。

见[四份公开原件的复制索引](./rotation-attempt1-evidence/copy-index.json)及[限定汇总](./rotation-attempt1-evidence/summary.json)。不复制 SDK 日志、App、二进制或私有目录全图。真实横竖屏、焦点契约和完整底部可达性仍待验收。
