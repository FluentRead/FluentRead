# 字幕生产扩展验收（2026-10-10）

22:43 在隔离 Edge 中加载最终 Chrome MV3 生产构建，以下定向场景全部通过。页面、视频、字幕轨和 Microsoft 响应均为固定 fixture；请求实际经过扩展 provider，再由 worker fetch 重定向到 loopback HTTP 服务。没有访问真实 YouTube 或真实翻译服务。这组证据不代表 Firefox、低配设备、真实视频站点或在线服务质量验收。

执行使用独立临时 profile、第二块屏幕的正常可见窗口和 `focus-safe-browser.cjs`。`launchMode=macos-background-cdp`，`focusPolicy=launchservices-no-foreground`，`windowPlacement.mode=background-visible-no-focus`；窗口位置为 `(212, -990)`、大小 `1280×900`。浏览器未成为前台应用，启动前后前台均为同一个 Google Chrome PID。结束后关闭该 Edge、loopback 服务并删除临时 profile 和生成的 `fixture.mp4`。

生产 `manifest.json` SHA-256：`fd80314b160701ed5500e584e1373f5eed44a19acdc6f8b76f9a12c1565970d8`。运行时从 `.output/chrome-mv3` 复制到自有临时镜像，防止构建目录变化影响验收。原始结果和 focus evidence 见 [result.json](./result.json)。

| 场景 | 实际结果 |
| --- | --- |
| 数字设置持久化 | 输入 `437%`，重新加载设置页仍为 `437%`；随后设为 `500%`。 |
| 短双语字幕 `500%` | 实际字号 `105.6px`，面板高度 `424.492px`，可用最大高度 `474px`；面板及完整文字均位于 `960×540` 视频内。 |
| 长双语字幕 `500%` | 实际字号 `24.39px`，面板高度 `456.0625px`，可用最大高度 `474px`，占用约 `96.2%`；`scrollHeight=clientHeight=454`，完整文本位于视频内。自动适配后存储偏好仍为 `500%`。 |
| 导出预览 | 共 `4` 条，可直接导出 `1` 条，待补译 `3` 条；最多新增 `2` 个不同文本请求，人工命中 `0`、缓存命中 `1`；缺失跨度 `00:02:00–00:02:05`。 |
| 取消后再次操作 | 取消新增请求 `0`；反馈结束后实际下载按钮恢复 enabled，随后再次点击并成功打开预览、导出。 |
| 仅导出已有结果 | 新增请求 `0`；生成含 `-partial.srt` 的文件，仅含已有 `1` 条，保留 `00:00:00,000–00:00:01,500`；跳过 `3` 条。预览说明跳过缺失条目，文件名也标明 partial。 |
| 补译后完整导出 | 新增请求恰好 `2` 个，均为实际缺失的不同文本；重复文本复用结果。导出 `4` 条，包含最后一条 `00:02:04,000–00:02:05,500`，没有 partial 文件名。 |
| 同页面地址换媒体 | 保持 href 不变，修改 video src；旧预览立即移除、按钮 `aria-busy` 清除，新增请求 `0`。 |

本次总共发出 `4` 个 fixture provider 请求：短字幕、长字幕以及两个不同的待补译文本。没有意外外部请求，也没有捕获到页面或 worker error。

[短字幕截图](./short-500.png)、[长双语截图](./long-500.png)、[导出预览截图](./export-preview.png)、[完整下载反馈截图](./complete-feedback.png) 已目视检查。导出文件：[仅已有结果](./Subtitle%20reliability%20fixture-zh-Hans-translated-partial.srt)、[完整结果](./Subtitle%20reliability%20fixture-zh-Hans-translated.srt)。

此前浏览器验收还定位并修复了取消后下载按钮无法再操作，以及长字幕被比例估算过度缩至 `8px` 的问题。修复前证据保留为 [按钮未恢复结果](./before-button-restore-fix.json)、[按钮未恢复截图](./before-button-restore-fix.png)、[字号过度收缩截图](./before-font-fit-fix.png)，不作为最终验收结果。

本轮最后一次定向单测为 `85/85`：下载 `54`、字幕逻辑 `22`、外观 `9`。`downloads.ts`、`exportPrompt.ts`、`subtitleLayout.ts`、`subtitleLogic.ts` 的 statements、branches、functions、lines 四维均为 `100%`。覆盖率摘要由实际 Istanbul `coverage-final.json` 生成，没有排除分支或手改覆盖值。

从项目根目录复跑（需要本机 Edge、ffmpeg、Playwright 及允许启动系统浏览器）：

```sh
<bundled-node> docs/reports/reading-reliability-experience-20261010/subtitle-browser-check.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <bundled-node-packages> \
  --focus-safe-helper scripts/testing/focus-safe-browser.cjs
```

runner 只执行本文列出的字幕场景；没有运行整个长站点矩阵。原文下载取消、迟到回包、同步取消、首个 provider 失败而兄弟请求挂起等边界由定向单测及独立 review 验证。
