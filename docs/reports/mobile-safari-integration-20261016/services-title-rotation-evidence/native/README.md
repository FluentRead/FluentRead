# iOS Simulator 服务选择流程验证

已测生产版本 `8274d0c76bead3f1f76a04f5f71e2d58475d4551` 在专用 localhost 页面完成一次服务选择抽屉流程：输入 `gpt` → 保持原生键盘旋转至横屏 → 返回竖屏 → 清空 → Back → 关闭概览 → 原生 Done → 返回原页面。全部 16 个已登记动作各执行一次，官方结果 **1 通过、0 跳过、0 失败**；所选测试方法 65.105 秒，整个测试运行 82.529 秒。结束后已审查固定基线恢复、模拟器 Shutdown 和运行资源释放。

![旋转前的竖屏 gpt 搜索](portrait-gpt-before-rotation.png)

![旋转后返回竖屏，gpt 保留](portrait-gpt-after-rotation.png)

两张图片均为原始 PNG 的逐字节复制，未裁切或重新编码；精确来源文件名、字节数和 SHA256 见 [copy-index.json](copy-index.json)。结果和来源报告摘要见 [summary.json](summary.json)。公开目录仅收录这两张竖屏图；横屏图未复制。

横屏时 `gpt`、Back、清空及 Close 控件保留，服务列表被原生键盘遮住，未选择任何服务商。此次通过仅覆盖这一条已记录的 iOS Simulator／localhost 流程；不代表真机、供应商翻译、全部产品布局、物理 DOM 节点身份或真实输入焦点通过。恢复核对仅覆盖固定数据子集，不声称全部存储恢复。

**服务概览可见标题补丁在本轮运行后才应用，不包含在这些截图中。** 标题的桌面生产包检查单独记录于[补充验收](../../services-title-rotation-followup.md)，不能转记为标题的原生验收。
