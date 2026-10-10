# 原生合批独立开关与 B 站标记验证

Google、微软、DeepL、Azure Translator 和 Google Cloud 各自在服务设置的“请求限制”中提供“合并翻译请求”，默认开启。旧配置或缺少字段也默认开启，各服务独立保存；AI 多段仍默认关闭。B 站独立服务及免费聚合列表统一显示“免费”。

关闭开关后，全文合批、显式数组调用及 Google 的 120 毫秒收集窗改为逐条 HTTP；免费聚合也尊重 Google／微软子服务的设置。请求入口冻结偏好，缓存、在途请求和全文会话身份区分开关值。逐条执行及结构异常恢复仍共享原始截止时间和取消域，完整成功后才发布或缓存，失败保留原文。恢复请求明确关闭 Google 收集窗，避免再次合入坏批次。

实现复用 FluentRead 的配置、快照、broker 和服务 UI，没有引用或修改参考仓库，没有升级依赖或修改版本号。

## 验证范围

[验证清单](./validation.json) 记录 2,283 项定向测试：运行链路 930、真实 Vue 模板及文案 82、配置差异／导入导出／Drive 130、配置与架构边界 1,118、油猴构建配置 23。其中 894 项是文件头断言，不能都计作翻译场景；未运行全量回归。新纯配置模块的四维覆盖率为 100%，见 [coverage.json](./coverage.json)。类型检查、Chrome MV3、Firefox MV2、油猴生产构建、manifest、油猴 verifier、测试分类审计及文档构建通过。

生产扩展的 [浏览器报告](./browser-report.json) 共 26 项通过：15 项三云协议合成响应、五服务停用后的逐条请求、1 项真实设置持久化／B 站标记、开启与关闭时的两组全文切换、2 项免费服务真实对照及 1 项微软实体保真或拒收。Google／微软停用检查和免费对照使用真实免费端点；三云及全文页面译文使用合成响应。

五个开关逐一验证默认开启、互不影响、点击可见控件后立即关闭、后台保存成功、另一设置页可见控件同步、重开保持关闭；Azure 连续修改验证最后值胜出。浏览服务配置未改变默认服务，不支持的服务没有此开关。页面及清理错误均为空。

全文两种模式都执行真实 content 快捷键，译文计数为 `6 → 0 → 6`，逐段核对来源、数字、多行、字面 HTML、实体和重复原文，无重复嵌套。所有九张截图已人工复核；例如 [停用后重开的开关](./native-batch-azure-disabled-reopened.png)、[B 站免费标记](./bilibili-free-label.png)、[开启后的全文译文](./native-full-page-1-translated.png)、[停用后的全文译文](./native-full-page-disabled-1-translated.png)。

隔离 Edge 131.0.2903.147 使用临时 profile、生产 Chrome MV3 产物及第二屏正常可见后台窗口，`launchMode=macos-background-cdp`、`focusPolicy=launchservices-no-foreground`、`browserFrontmost=false`。未读取日常 profile 或用户密钥。

DeepL、Azure 和 Google Cloud 没有专用测试凭据，合成协议结果不能证明真实鉴权、区域、计费或线上翻译质量。Firefox 和油猴完成构建及静态校验，没有运行时验收；小规模免费端点对照也不代表所有语言、网站或设备的质量保证。

## 油猴体积与语言资源

在独立目录导出基线 `e4932521fe6036a403fbd3e034dc20d5b4495fe0`，复用同一套锁定安装依赖，分别执行 `pnpm exec wxt prepare` 与 `pnpm build:userscript`。基线 1,982,807 字节，最终候选 1,985,367 字节，增加 2,560 字节（0.1291%）。原预算只剩 2,193 字节，因此预算最小增加 1 KB 至 1,986,000；继续保留全部体积、协议及执行边界校验，见 [userscript-size.json](./userscript-size.json)。

五种远程语言文件按内容哈希生成，固定到首次包含它们的提交 `93759ec4387415a6cd12864a2f825bf5abc7353e`；23 项油猴构建配置测试验证该提交内容与构建输入完全一致，中英离线文案继续随脚本发布。

## 重现

运行 `scripts/testing/run-native-batch-live-test.cjs --help` 查看必要路径。使用 production 扩展，显式传入 `--settings --live --full-page --background`、Playwright 包目录、focus-safe helper 和独立证据目录。默认仅执行云协议合成响应；`--settings` 增加本次开关专项，`--live` 增加无凭据免费服务样本，`--full-page` 增加六段翻译／恢复／再翻译。报告只保留已知测试文本、请求路径和开关，不保留用户配置或凭据。
