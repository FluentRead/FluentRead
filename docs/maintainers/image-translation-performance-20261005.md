# 图片段落翻译的本地性能优化

本次在 [PR #820](https://github.com/FluentRead/FluentRead/pull/820) 的段落修复上继续优化。对照基线是 `55cb1513`，性能任务分支保留其历史；新的 PR 包含段落修复和本次性能改动，供替代 #820 审查。本次没有关闭或合并 #820。

## 改动

- 分组候选按纵向邻域扫描，段落字号、对齐范围和包围框增量更新。标题、列表、栏位、遮挡及竖排的原规则保持不变；遮挡检查仍覆盖原始文字区域。
- 排版只缓存当前段落、当前字号的测宽结果，最多 512 项；过长单词的字素分割跨字号搜索复用，完整单词能独立放下一行时直接换行。
- 相接文字框共用局部修补蒙版，保留一像素已知边界和原来的八邻域分层扩散。普通图片运行时显式复用本次独占的 ImageData，省去整图 RGBA 副本和复制回写；算法默认仍返回独立输出。
- 普通图片复用现有异步无损 PNG 编码器，在编码和 FileReader 转换期间支持取消、超时与迟到结果清理。原图裁剪和消息协议保持现有实现。

实现使用 FluentRead 的现有架构，没有复制或修改参考项目。

## 固定样本测量

Node 20.11.1，两个预热样本、七个正式样本的中位数；两版依次运行。测量仅包含纯算法调用，输入准备与输出校验不计时，也不包含 OCR、模型准备、网络翻译、Canvas 或 PNG 编码。所有十个样本的输出摘要一致。

| 样本 / 阶段 | 基线 | 优化后 |
| --- | ---: | ---: |
| Bambu 12 个 OCR 行分组 | 0.033 ms | 0.016 ms |
| 1000 个分散标签分组 | 47.10 ms | 0.63 ms |
| 500 个连续正文行分组 | 10.11 ms | 4.19 ms |
| 2048×2048 稀疏文字图：修补并回写 / 复用缓冲 | 12.41 ms | 9.30 ms |
| 英文长段落排版 | 6.30 ms | 4.15 ms |
| 中英混排长段落排版 | 4.83 ms | 3.77 ms |
| 组合字符与 emoji 长单词排版 | 9.09 ms | 4.07 ms |

英文样本测宽调用从 6995 次降到 1020 次；混排从 7210 次降到 2239 次；长单词从 8509 次降到 677 次。稀疏文字图的蒙版累计分配从 4,194,304 字节降到 95,616 字节，最大单次蒙版从 4,194,304 字节降到 2,988 字节；普通图片路径减少 16 MiB 的 RGBA 副本。这里记录的是算法显式缓冲分配，未测量浏览器或进程整体内存峰值。

稀疏文字的收益较明显；大块文字区域仍受逐像素修补成本影响。真实总等待时间还取决于模型准备、OCR 和翻译服务。

原始报告：[基线](./assets/image-translation-performance-20261005/baseline.json)、[优化后](./assets/image-translation-performance-20261005/candidate.json)。

## PNG 响应性

隔离 Edge 中使用同一张 2048×2048 确定性不透明噪声图，一次预热、七次正式测量。同步编码的调用阻塞中位数为 361.7 ms，异步调用低于 0.1 ms；零延迟定时器的实际等待从 362.0 ms 降到 0.1 ms。异步编码中取消返回 AbortError，耗时约 0.6 ms。

两种编码完成总耗时分别为 361.8 ms 和 375.4 ms，解码后的 RGBA 摘要及 data URL 长度相同。该改动改善编码期间的响应性，未降低 PNG 压缩总耗时。浏览器资源、图片纹理和设备差异会影响数值。

原始报告：[PNG 编码](./assets/image-translation-performance-20261005/encoding.json)。

## 验证范围

16 个相关测试文件共 438 项通过，覆盖 OCR、段落分组、排版、局部修补、图片请求与页面生命周期、消息路由和恢复。修改的 `paragraphs.ts`、`rendering.ts`、`inpainting.ts`、`offscreenRuntime.ts` 及复用的 `mangaEncoding.ts` 四维覆盖率均为 100%。修补测试保留来自 `55cb1513` 的半透明渐变像素摘要，覆盖分离、触图边、桥接及角相接区域；性能用例断言测宽次数、字素分割次数与缓冲分配，不依赖耗时阈值。

额外固定随机种子 `20261005`，与基线对照 1000 组段落、1000 张随机透明像素图（分别独立输出和复用缓冲）、1000 组混排文本，四类结果全部逐值一致。该临时差分检查报告保存在 `/private/tmp/fluentread-image-performance-compat.json`。

源文件头与模块边界 806 项通过；类型检查、Chrome/Firefox 构建、文档构建和测试分类审计通过。验证归属测试仍有两项既有失败，涉及三个未登记脚本及十九个覆盖边界缺口，基线和本次失败路径一致，本次没有新增缺口。

生产 Chrome 扩展在隔离 Edge 中通过 Bambu 原图三项检查和图片生命周期二十项检查，包括取消、重试、动态换图、offscreen 断线恢复、透明图、几何裁切、恢复与卸载。Bambu 原图识别为八个完整段落/标签，切换计数 `[1,0,1]`，缓存再次显示没有额外请求；译图 PNG 与 #820 相同夹具的结果逐字节一致。使用真实 Tesseract OCR 与固定 Google transport，本次没有重测线上翻译服务和 Firefox 运行时。

浏览器采用自动临时 profile、第二屏正常窗口后台运行：`launchMode=macos-background-cdp`、`focusPolicy=launchservices-no-foreground`、`windowPlacement.mode=background-visible-no-focus`、`browserFrontmost=false`，完成后关闭浏览器并删除临时 profile。证据目录为 `/private/tmp/fluentread-image-performance-paragraph` 和 `/private/tmp/fluentread-image-performance-flow`。

## 重复测量

在当前任务检出中运行以下命令；`BASELINE_CHECKOUT` 应指向包含基线源码与 Bambu OCR 夹具的独立检出。脚本从指定目录读取真实纯算法模块，输入准备不计时。对照参数会校验样本标识和输出摘要，差异导致非零退出。

```bash
node scripts/testing/run-image-rendering-performance.mjs \
  --project-root "$BASELINE_CHECKOUT" --label baseline-55cb1513 \
  --output /private/tmp/image-rendering-baseline.json
node scripts/testing/run-image-rendering-performance.mjs \
  --baseline-report /private/tmp/image-rendering-baseline.json \
  --output /private/tmp/image-rendering-candidate.json
```

原生 Canvas 测量使用已有 Playwright 包目录与 focus-safe helper；不访问日常浏览器配置或翻译服务。

```bash
node scripts/testing/run-image-encoding-performance.cjs \
  --playwright-root "$PLAYWRIGHT_ROOT" \
  --focus-safe-helper "$FOCUS_SAFE_HELPER" \
  --output /private/tmp/image-encoding.json
```
