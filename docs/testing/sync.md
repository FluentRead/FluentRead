# 缓存、备份与同步

[返回测试入口](../testing.md)。按本次改动选择下面的专项；这些条目不要求每次全部运行。

## 缓存清理等待与恢复

`translationCacheManagement`、`popupCache`、`popupAppLifecycle`、`implementationAudit49C`、`backgroundCoreHandlers` 和 `safariTabBroadcastIntegration` 验证缓存操作的真实消费者。覆盖清库确认前的等待、十五秒截止与重试、迟到成功/拒绝、弹窗失活、设置分类切换和 KeepAlive、容量草稿保留，以及清理与后续统计共用截止。清库成功后统计读取失败必须保留清库结果；超时不能报告清库失败或完成。

后台的清库屏障仍完整等待旧写入排空与持久存储清理。只有这些完成后才给页面通知一秒宽限；超时恢复界面等待，原广播继续投递，并通过 `invalidationPending` 区分已清库和页面同步未确认。`translationBroker` 与共享 `tabBroadcast`、缓存存储测试守护串行清库和通知所有权。

生产 Chrome 产物的聚焦浏览器验证：

```bash
node scripts/testing/run-cache-clear-recovery-test.cjs \
  --extension-dir .output/chrome-mv3 --playwright-root <捆绑 Node 包目录> \
  --focus-safe-helper scripts/testing/focus-safe-browser.cjs \
  --runtime-diagnostics <browser-translation-test-skill>/scripts/runtime-diagnostics.cjs \
  --artifacts-dir <证据目录>
```

使用临时 Edge profile 和第二屏后台正常窗口，页面导航前采集扩展页、内容隔离世界及后台诊断。延迟和未决回复只注入本次隔离配置，真实后台路由和数据库清理仍执行。报告分别记录注入边界、等待耗时、状态、重试、截图、焦点事件及诊断缺口；普通扩展标签页的 Popup 验证不代表原生工具栏弹窗、Firefox 实机或外部供应商验收。

脚本还记录 `focusTrace`：截图、页面探针、关闭和新建页签的开始/完成边界，以及五种白名单 CDP 命令的 target、window 和 bounds。记录不包含 URL、页面正文、配置或消息载荷。前台采样不可用或已确认测试浏览器激活时会锁存失败并阻止后续普通操作，只允许清理脚本已登记的 target；原始 CDP 拒绝、运行时诊断和清理错误分别保留。启动时浏览器 PID 尚未确认的事件先保存，再由启动后的焦点检查判定归属。

这些采样会改变测试时序，仅用于定位问题。Node `performance.now()` 与原生事件的 `systemUptime` 有不同原点，不能直接相减；跨来源须用 epoch 时间和采样区间关联。公开 CDP session 的五类命令记录不涵盖 Playwright 私有 page session 的全部协议；离线 `browserFocusSafety` 用例只验证报告接线、返回/拒绝身份和失败锁存，不能证明真实浏览器焦点问题已修复。

## 术语库排队保存

网站仅译文与新增内置词库的生产扩展专项：

```bash
node scripts/testing/run-site-display-mode-test.cjs \
  --extension-dir .output/chrome-mv3 --playwright-root <捆绑 Node 包目录> \
  --runtime-diagnostics <扩展 UI 测试技能>/scripts/runtime-diagnostics.cjs \
  --artifacts-dir <证据目录>
```

该专项只使用临时 Edge profile 与本地确定性服务，验证网站偏好保存重开、已有及迟到译文切换、动态正文、跨站继承、恢复重译、八套内置词库目录、新词搜索与副本持久化。页面导航前附着运行时采集；报告保留首次后台附着前等采集缺口，不能据此宣称真实供应商或 Firefox 验收。

运行 `pnpm test tests/glossarySettingsComponent.test.ts tests/configApplication.test.ts` 验证术语库操作的真实 SFC 与配置传输边界。新建、内置库添加、排序和导入捕获用户操作，在组件保存队列执行时合并共享 store 的最新列表；排序携带库 ID，按当前顺序移动一格，导入固定已确认内容并重新检查容量。覆盖排队期间的外部增删、同 ID 与同名、无写入的 no-op、隐藏及组件卸载、容量恢复、旧回执对新选择/新导入草稿的保护，以及确认框与延迟焦点的草稿归属。

`configApplication` 的 glossary list CAS 用例让两个独立 application 通过真实客户端及持久化 handler 交互；发送期间修改同一数组字段应拒绝、回读最新值且只发送一次，无关字段变化则正常确认。这不证明跨设备或真实浏览器关闭的持久化：组件卸载后共享 store 仍运行，整个页面销毁会终止尚未交给配置客户端的本地任务。实现边界及证据入口见[术语库排队保存与草稿归属](../maintainers/glossary-save-concurrency-20261024.md)。

### 术语库连续搜索

`glossarySettingsComponent` 同时验证真实 SFC 搜索与分页：空/纯空白查询不处理正文，连续非空查询复用当前库的小写字符串；数组原地编辑、增删、排序、对象替换、切库及外部配置更新必须重新匹配。保持原有默认 locale、换行拼接与不额外 Unicode 正规化的语义，查询结果长度相同的变化也要重置页码。计数使用合法 500 条单库与 10 库轮换夹具，透传原生字符串方法并区分正文处理、查询规范化、挂载与 hydration；不得把计数减少解释为实际帧耗时或实机验收。

## Google Drive 完整配置同步

Issue #1339 的 `googleDriveAuth` 回归覆盖带 Chrome UA 的衍生浏览器、缺失/空/未知品牌、移动端、Google Chrome 品牌顺序，以及授权失败后的替代方案与重试；不支持的环境不得调用 Identity 或 Drive HTTP。生产界面专项使用受控品牌信息复现判断分支，不能代替 Aside、Ego Lite、Vivaldi 的实机或真实账号授权验收。

`tests/googleDriveEncryption.test.ts`、`tests/googleDriveConfig.test.ts`、`tests/googleDriveAuth.test.ts`、`tests/googleDriveApi.test.ts`、`tests/googleDriveSync.test.ts`、`tests/googleDriveSyncClient.test.ts` 和 `tests/backgroundGoogleDriveSync.test.ts` 验证完整凭据快照、认证加密、账号隔离、差异隐藏、三方合并、过期与一次性预览、MV3 后台重启恢复和失败回滚。`tests/i18n.test.ts` 还验证同步状态及隐藏内容的多语言展示。

生产扩展构建后执行 `node scripts/testing/run-google-drive-sync-ui-test.cjs --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> --focus-safe-helper <扩展界面测试技能>/scripts/focus-safe-browser.cjs --artifacts-dir <证据目录>`。专项使用临时 Edge profile、第二屏后台可见窗口，先验证实际 Edge 的不支持提示，再注入虚构 Chrome Identity 与 Google Drive 响应；检查真实页面的预览、上传与下载方向、加密完整凭据恢复、损坏文件阻断、私有存储边界、无口令输入流程，以及中英文 390px 布局。

该证据覆盖生产扩展页面、后台 Web Crypto 与实际配置存储；Google 登录授权和 Drive HTTP 为受控夹具，不代表真实 Google 账号、两台设备或商店发行版本的联调结果。配置与公开发布步骤见 [Google Drive 同步教程](../maintainers/google-drive-sync-guide.md)。

## 云备份范围与敏感信息选择

`googleDriveConfig`、`googleDriveSync` 与 `webDavBackup` 定向覆盖网站规则普通备份：复制内置 Reddit 规则、带或不带正文 `key`、共享模板、全局开关和停用列表均可保存；解密、worker 重启后恢复与合并保留规则及本机连接。`configTransfer`、`configDomainBoundaries` 和 `configStoreAuditBoundaries` 还验证真实导入、配置保存与加密 IndexedDB 不会再次删掉正文标签。规则范围只接受严格归一化结构，额外凭据、未知字段和伪装标量仍被排除，其他配置中的同名 `key`/`custom` 不获得例外。恢复旧普通备份时保留其中未包含的网站规则；其他普通设置仍按原契约处理删除。这些测试使用受控存储和协议端口，不代表真实云账号或跨设备联调。

更新日期：2026 年 10 月 4 日。生产扩展构建完成后，使用 WebDAV 本机 HTTP 夹具运行本次范围专项：

```sh
node scripts/testing/run-webdav-backup-ui-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <Node包目录> \
  --focus-safe-helper <扩展界面测试技能>/scripts/focus-safe-browser.cjs \
  --artifacts-dir <证据目录> \
  --sensitive-only
```

`--sensitive-only` 限定为云备份范围与敏感信息选择专项。使用临时 Edge profile、第二屏后台可见窗口与 focus-safe helper；不读取日常浏览器配置，不使用真实账号或服务凭据。检查默认普通范围、风险勾选与取消、保存后的解密载荷不含密钥/鉴权地址/自定义请求体/私密提示词、普通备份及旧完整 v1 恢复保留本机密钥与地址、开启敏感配置后仍写兼容的完整 v1，以及普通设置相同时仍可确认保存普通范围、从当前云文件移除敏感信息。

还检查完成、预览与提交失败、取消预览、切换供应商、重开设置与确认后立即关闭时仍保持已选范围，手动关闭持久保存、多页同步与存储失败保护，以及七语言风险文案解析、390px 无横向溢出、Escape 取消、深色风险文字对比度至少 4.5:1 和控制台异常。紧凑风险弹窗保留本机加密与存储位置、公开口令和泄露风险、默认未勾选的风险同意，省去重复建议。保存普通范围只更新当前云文件，不证明服务商历史版本被删除。此专项使用受控 WebDAV 夹具，不代表真实 Google 授权、真实第三方账号、商店版本或跨设备联调结果；Google 账号切换与准备失败还可用 Google 专项的 `--sensitive-only` 验证；旧扩展拒绝 v2 与旧事务失效由对应领域回归验证。

## 云端备份删除专项

`run-webdav-backup-ui-test.cjs --delete-loading-only` 只检查删除加载反馈：本机夹具延迟核验和删除请求，验证入口转圈、按钮禁用、确认按钮加载、失败后恢复，以及一次删除和本机配置保留。同步操作使用原有加载状态，删除入口只在删除相关请求期间转圈。

更新日期：2026 年 10 月 5 日。`pnpm test:cloud-backup --coverage` 覆盖两阶段删除确认、页面所有权、账号绑定、MV3 重启、旧/未知/损坏密文、空文件、重放、版本冲突、强 ETag、清理失败和本机配置保留；真实 WebDAV HTTP 夹具分别验证 GET、PROPFIND、HEAD 三种 ETag 来源的条件 DELETE、冲突、缺失幂等与重新创建。

生产扩展构建后运行 `run-webdav-backup-ui-test.cjs --delete-only` 和 `run-google-drive-sync-ui-test.cjs --delete-only`，其余参数同上。两者均使用 focus-safe helper 和临时 Edge profile。WebDAV 使用本机服务器验证真实请求、取消/Escape/重开、版本变化、七语言、390px、深色和本机配置保留，还检查输入确认文本前后、输入错误、清空及 Enter 不执行删除，并验证按钮使用已有主色样式。删除影响突出目标服务和本机配置保留；删除影响和输入要求合在同一个提示块中，输入框紧接其下方；确认词加粗并与输入框建立无障碍关联。次要说明通过页脚浮层按需显示，使用 Enter/Space 检查打开与关闭，同时断言弹窗和删除按钮位置、尺寸完全不变，浮层不超出窄屏。Google 使用虚构 Chrome Identity 与 Drive 响应验证实际账号展示、更换账号后重新输入确认文本、缺少版本、v2 ETag 条件删除与窄屏。报告与截图写入各自证据目录；夹具不能代替真实 Google 登录、第三方账号或 Firefox 实机验证。

## WebDAV 属性响应边界

`tests/webDavProperties.test.ts` 直接验证实际 Saxes XML 解析器的命名空间、字符引用、CDATA、资源唯一性、属性状态、强 ETag、DTD 拒绝及长度/深度/元素数量限制。目标 URL 必须为可解析的绝对 URL；无效目标返回未识别结果，避免解析函数向调用方抛出 URL 异常。属性模块进入永久四维 100% 清单，和 `webDavApi`、`webDavConnection`、`webDavHttpIntegration` 联合验证；HTTP 用例只对临时本地服务完成首次/再次保存与版本冲突，不代表用户真实 WebDAV 账号。沙箱若禁止本地 listen，需在允许 127.0.0.1 的环境运行相同测试，不跳过或模拟这组三种 ETag 来源的协议链路。

