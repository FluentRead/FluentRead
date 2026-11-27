---
name: fluentread-extension-ui-test
description: 在隔离且不抢焦点的真实浏览器中验证 FluentRead popup、options 的交互、布局、配置持久化与运行时诊断，保存截图证据。
---

# FluentRead 扩展 UI 测试

使用当前任务 checkout/worktree 的扩展产物。同一轮需要网页翻译验证时，查阅[构建产物复用](../fluentread-browser-translation-test/references/browser-contract.md#构建产物复用)。按改动选择 `popup`、`options`、`services`、`isolation`、`responsive` 或 `persistence`，支持逗号组合。日常显式传 `--suite`，完整套件限明确全量要求或正式发版。只涉及页面翻译且公共 UI 契约未变时使用网页翻译测试。

本机后台窗口优先使用 `DeskPad Display`，不可用时依次回退到副屏、主屏。使用随附 focus-safe helper 和独立临时 profile，页面操作走 CDP。定位和截图见[共同契约](../fluentread-browser-translation-test/references/browser-contract.md)。自身错误和告警阻止通过，采集缺口如实报告。

```bash
<bundled-node> <本 skill>/scripts/run-ui-test.cjs \
  --extension-dir <checkout>/.output/chrome-mv3 \
  --playwright-root <bundled-node-packages> \
  --suite popup --background --artifacts-dir <证据目录>
```

通过工作区依赖工具获取 Node 和包目录。开发循环用 `FLUENTREAD_DISABLE_BROWSER_RUNNER=1 pnpm dev` 生成 `chrome-mv3-dev`，浏览器由测试 helper 启动。交付时生产构建后重跑相关专项。专项断言、快速关闭、跨页同步和截图要求见[UI 用例](references/ui-cases.md)。真实 Firefox UI 验证时才读[Firefox 启动与持久化](references/firefox.md)，前台占用按本轮授权执行。

成功、失败、中断都保存完整诊断与截图。终端默认返回摘要、阻断项和证据路径；机器消费者需要完整 JSON 时才加 `--report-format json`。检查相关截图，报告所选套件、布局/交互、错误/告警、产物和启动/焦点策略；未测项不能写为通过。清理仅限本轮创建的浏览器、进程与临时 profile。
