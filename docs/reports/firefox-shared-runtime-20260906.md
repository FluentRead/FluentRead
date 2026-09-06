# Firefox 共享 DOM 运行时验证（2026-09-06）

Firefox MV2 通过后台页面中的隐藏 iframe 加载与 Chromium 相同的 `offscreen.html`。OCR、图片和区域翻译、Whisper Worker、TTS 播放器与业务消息协议均复用现有实现；新增平台文件只选择文档容器并管理 Firefox iframe。准备、并发复用、握手、超时、取消和丢失重建继续使用同一个 `createOffscreenClient`。

首次浏览器验证的基础提交：`f04a0fb`。Chrome Translator 仍只在支持它的 Chrome 中开放；此适配不开放 Firefox MV3。

## 合并前复验

用户授权上传并合并后，将任务分支接到最新主分支 `0c7c5db894407e744ea48eac5fed85c14816b223`，没有冲突。生产代码验证提交为 `4cb26a7588948c14d827d30d4930e9553bb06bcb`，之后仅补充本报告与结构化证据。

- 全套测试：274 个文件、5,270 项测试全部通过。首次验证记录中的测试归属问题已由主分支 PR #485 修复；一次因 Finder 在工作树生成 `.DS_Store` 导致的文件头审计失败，在将该未跟踪元数据移至临时备份后复验通过，没有修改审计规则。
- 严格覆盖率：224 个文件、4,318 项测试通过，语句、分支、函数、行均为 100%。
- 测试审计、类型检查、Chrome/Firefox 构建、manifest 校验、userscript 构建和验证通过。
- 更新后 Chrome 产物再次通过 Edge 的 16 项图片交互回归，临时配置已删除，测试窗口在第二块屏幕正常显示且未抢占前台。
- Chrome 与 Firefox 的共享 DOM 核心和 Whisper Worker SHA-256 仍与下方真实 Firefox 测试产物完全相同。Firefox 的运行证据来自首次验证的生产构建，未声称已重跑整个 Firefox 网站交互层。

结构化证据的 `mergeValidation` 字段记录此轮测试与浏览器结果。下文保留首次验证范围和当时发现的问题，不能将历史基线失败视为最终待合并版本的失败。

## 真实浏览器证据

使用 Firefox 155.0b5 的临时配置与生产 Firefox MV2 产物，在第二块屏幕以正常窗口后台运行。共 138 次焦点检查未发现测试 Firefox 成为前台，测试结束后仅关闭测试进程并删除临时配置。结构化证据见 [verification.json](./firefox-shared-runtime-20260906/verification.json)。

| 链路 | 结果与边界 |
| --- | --- |
| OCR 与图片翻译 | 实际下载 Tesseract 英语模型，识别 `Hello world` 并生成中文译图；OCR、Canvas 和消息链路真实执行，Google 翻译响应使用确定性夹具。 |
| 区域翻译 | 从活动夹具标签页的内容脚本请求原生 `tabs.captureVisibleTab`，然后通过共享管线裁剪、识别并翻译；未把程序化消息测试当成真实拖选手势测试。 |
| 取消与恢复 | 延迟翻译响应期间取消，迟到结果不成功提交；移除后台 iframe 后再次 OCR 成功，且只创建一个替代 iframe。 |
| 本地字幕 | 实际下载 Whisper Tiny q4，使用 WASM 单线程转写 3.375 秒合成语音，得到 `Hello world, this is a Firefox translation test.`；最终推理耗时 1,463 ms。使用与产品相同的 PCM16 后台请求，未验证真实 X 视频的音频捕获与字幕同步。 |
| 音频播放 | 默认 Firefox 自动播放设置下，以音量 1、未静音的原生 Audio 播放无声 WAV；播放、自然结束、再次播放和停止均成功。未验证外部语音合成服务。 |
| Chromium 回归 | Edge 加载 Chrome 生产产物，原有图片交互回归 16 项通过，包括语言包准备、真实 OCR、译图恢复、几何定位、动态图片、取消和透明图。该轮在最后的 TTS 通知修复前执行；最终 TTS 通知修改另由共享组合根回归与真实 Firefox 播放验证覆盖。 |

真实播放验证发现 Firefox 的 `chrome.runtime.sendMessage` 返回 `undefined`，原先通知调用的 `.catch()` 会使停止操作误报失败。现在两种浏览器统一采用原生 callback 并读取 `runtime.lastError`，新增回归覆盖接收标签页已关闭时的结束和停止。

![Firefox 实际生成的译图](./firefox-shared-runtime-20260906/translated-image.png)

## 首次验证的自动化与打包

- `pnpm test:audit` 通过。
- 严格覆盖率：223 个文件、4,271 个测试通过，语句、分支、函数与行覆盖率均为 100%；新平台文件纳入严格覆盖率。
- 全套测试：272 个文件通过、1 个文件失败；5,210 个测试通过、1 个失败。唯一失败是已在原始 `f04a0fb` 上复现的验证归属缺失，涉及 `scripts/build-product-assets.cjs`、`capture-product-assets.cjs`、`package-product-kit.cjs`、`verify-product-site.cjs` 和 `verify-support-ui.cjs`。本次没有修改这些脚本或放宽检查。
- 曾同时运行两套大测试与构建，出现两个无关测试的 5 秒超时；恢复串行运行后均通过，最终仅剩上述已确认的基线失败。
- 类型检查、Chrome 构建、Firefox ZIP 和源码 ZIP、manifest/归档检查均通过；userscript 构建及验证通过。
- Firefox 扩展包包含共享 DOM 页面与本地 OCR worker/core，不声明 Chromium 的 `offscreen` 权限；源码包保留对应 OCR 资产。

最终两种浏览器的共享运行时文件均为 `offscreen-CccO2YBY.js`，SHA-256 为 `c4c4a8cd4a12c30f9eb5a6992361f1671d1fb66373e3ef0e19c6a0ea8f249831`。两者 `videoTranscriptionWorker.js` 的 SHA-256 均为 `a32d8206d2064e9b035f06ce59495a501e010ffbe85768ea68572dffcdc0639b`。这两份产物逐字节相同。

未借用或修改参考仓库的代码。上述结果证明本次执行范围内的共享运行时可用，不代表所有网站、历史 Firefox 版本或外部翻译服务均已验证。
