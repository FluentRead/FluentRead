---
name: fluentread-browser-translation-test
description: 在隔离且不抢焦点的真实浏览器中验证 FluentRead 网页翻译、恢复和重复触发，保存诊断与截图；适用于全文、悬浮及站点兼容测试。
---

# FluentRead 网页翻译测试

以当前任务 checkout/worktree 为待测项目，检查改动范围后选择生产或开发产物。同一轮需要扩展 UI 验证时，查阅[构建产物复用](references/browser-contract.md#构建产物复用)。日常只跑相关文件和站点；完整矩阵限明确全量要求或正式发版。搜索限定当前 checkout，案例按标题定位，完整日志留在证据文件。

本机可见后台测试按 `DeskPad Display` → 副屏 → 主屏的顺序选屏，使用正常尺寸的隔离窗口和独立临时 profile。常规页面操作走 CDP，前台或系统级输入遵守本次授权边界。定位和截图见[共同契约](references/browser-contract.md)。

- 最小“翻译—恢复—再翻译”诊断：运行下方命令；断言与参数见[页面专项](references/toggle.md)。
- 候选发现、DOM、adapter、mutation 或全文共享逻辑用项目 `scripts/run-site-translation-matrix.cjs --cases <受影响站点>`，传入 `--focus-safe-helper <本 skill>/scripts/focus-safe-browser.cjs` 和 `--runtime-diagnostics-helper <本 skill>/scripts/runtime-diagnostics.cjs`。
- 仅在 popup/options 公共契约受影响时增加相关 UI 专项，不默认启动完整 UI 套件。

```bash
<bundled-node> <本 skill>/scripts/run-toggle-test.cjs \
  --extension-dir <checkout>/.output/chrome-mv3 \
  --playwright-root <bundled-node-packages> \
  --url https://example.com --selector p --expected-hotkey Control \
  --background --artifacts-dir <证据目录>
```

通过工作区依赖工具获取 Node 和包目录。开发循环用 `FLUENTREAD_DISABLE_BROWSER_RUNNER=1 pnpm dev` 生成 `chrome-mv3-dev`，浏览器由测试 helper 启动。交付时以生产产物重跑相关专项。用 `--expected-service` 核对实际服务，保留已有专用测试凭据和模型。

功能与运行时诊断共同决定结果。自身错误/告警阻止通过，采集空窗、外部噪声和负向预期保留证据及依据。终端默认返回摘要和证据路径；机器消费者确需完整 JSON 时才加 `--report-format json`。只读取失败相关证据，检查相关截图，报告实际范围、产物、启动/焦点策略和未验证项。清理仅限本轮自有进程与临时 profile。
