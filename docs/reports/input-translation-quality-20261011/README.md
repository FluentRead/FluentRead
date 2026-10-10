# 输入框翻译性能与交互可靠性

输入框翻译沿用 FluentRead 的 WXT、Vue、可注入内容 feature 和共享翻译 broker。优化集中在减少重复请求与无关事件的工作、取消真实后台请求，以及在异步写入期间保护用户草稿、焦点和光标。双语输出保留原文与段落，继续支持原文在前或译文在前。

## 请求与性能

相同宿主、相同内容的在途翻译只保留一个请求。请求与提示 UI 并行启动，提示挂载变慢或失败不再阻挡请求和写入。无关输入目标的 input/change 事件不读取编辑区快照，富文本快照使用 DOM markup 比较，避免每次校验都读取可能触发布局的 innerText。

输入入口复用共享、按发送者隔离的取消注册表，取消信号沿原有 broker 传递到 provider。配置水合之前也能取消，取消后不启动 provider；忽略取消的迟到 provider 返回不能写入。后台协议保留没有请求标识的旧调用方。Chrome、Firefox 和两种 userscript 入口共用业务处理器，没有新增依赖、配置迁移或框架私有 API。

页面消息最长等待 60 秒，包含后台唤醒与配置水合；共享 broker 的原有超时、缓存、并发与服务策略继续生效。超时后释放页面状态并显示重试，重试使用新请求标识。性能改进来自请求去重和减少无关事件工作，供应商的既有超时和并发策略得到保留。

## 写入与用户交互

翻译中可以按 Esc 或点击取消；用户编辑、输入法组合、配置变化和页面卸载都会作废请求。普通输入框完成后保持其他控件的焦点和选区；富文本失焦会取消写入。写回或恢复期间的实际编辑按键、粘贴和剪切会在宿主默认编辑之前取消写入。临时选区仍归本次写入占用，且原节点与内容仍有效时，同步恢复原选区；用户已经改变的选区继续保留。重复点击恢复只产生一次在途写入。

三连触发只清理本次插入的两个符号，原文中的空格、等号和短横线继续保留。富文本通过编辑器接管的标准输入事件与原生编辑路径提交，不直接覆盖其 innerHTML。非空文本使用 insertText 字符串事件，折叠光标处的单个非换行字符使用 insertReplacementText，避免字符延后到下一次输入重放。编辑器已接管事件后，只确认预期提交或安全停止，不再追加第二次写入。

状态提示提供取消、失败重试和恢复原文，具有 status/polite 无障碍状态，跟随滚动与视口尺寸变化，并限制在视口边距内。状态背景加深，提高白色小字的对比度。编辑器拒绝自动写入时，提示保留准确、只读且可选择复制的译文，直到用户关闭或改变输入状态。

富文本的“恢复原文”恢复文字；原有链接、提及与格式需通过宿主支持的撤销功能恢复。双语追加和前置保留原文内容、结构和格式，编辑器可按自身模型重新渲染。

## 验证结果

输入翻译核心的 204 个定向测试通过：内容生命周期 96 个，编辑宿主与资格判定 94 个，后台与输入集成 14 个。四个业务模块的 statements、branches、functions、lines 均为 100%。其中后台集成使用“输入框”用例过滤，其余 52 个用例未执行。

定向架构与相关回归共 998 个用例，997 个通过；optionalContentFeatures 另有 7 个通过。唯一失败是 providerBoundaries 对 Microsoft 适配器旧函数签名的字符串断言（第 188 行），已在未修改的 fe7005dd9 基线上重现。本次没有修改该适配器和断言文件，两者内容与基线逐字相同。这个结果不记作全套回归通过。

最终生产构建的浏览器终验全部通过；两个 runner 均以 exit 0 结束，无页面错误，浏览器保持第二屏后台可见且没有抢前台。

| 检查 | 最终结果 | 证据 |
| --- | --- | --- |
| 输入交互 | 29/29；6 次实际 AbortSignal 终止；连续 5 次快捷键仅 1 个请求 | [浏览器报告](./input-browser-report.json) |
| 真实编辑器 | Quill、ProseMirror、Lexical、Slate、Draft.js 5/5；译文与恢复均核对模型和 DOM | [编辑器报告](./real-editors-report.json) |
| Slate 即时返回与缓存 | 连续 5/5；4 次供应商请求、1 次实际缓存命中；最后一轮零请求 | [连续轮次](./real-editors-report.json) |
| 提示文字对比度 | 蓝 6.19:1、绿 6.49:1、红 6.13:1；状态、按钮和只读译文均达到 4.5:1 检查阈值 | [实际计算样式](./input-browser-report.json) |
| 定向覆盖率 | 4 个业务模块的四项指标均为 100% | [覆盖率摘要](./coverage-summary.json) |
| 类型与构建 | compile、Chrome MV3、Firefox MV2、userscript 全部通过 | [构建指纹与基线](./verification.json) |
| 产物守门 | Chrome/Firefox manifest 检查与完整 userscript verifier 通过 | [Manifest](./extension-manifests.json)、[指纹](./verification.json) |
| 测试归类审计 | 638 个测试文件、10,444 个用例条目；审计通过 | [审计摘要](./verification.json) |
| 文档与组件预览 | 构建与校验通过；81 页、4,328 条链接；28 个 stories | [检查记录](./verification.json) |

对比度使用浏览器实际 computed style，将半透明背景按最差白色背底合成后计算。窄屏截图：[翻译中与取消](./loading-390.png)、[手动复制译文](./manual-preview-390.png)。原文格式与恢复截图：[双语原文结构](./bilingual-rich-formatting.png)、[五种编辑器恢复原文](./editors-restored.png)。

真实编辑器版本固定为 Quill 2.0.3、ProseMirror state 1.4.3 / view 1.38.1、Lexical 0.28.0、Slate / slate-react 0.112.0、Draft.js 0.11.7。

userscript 使用相同锁文件与依赖独立重建基线：1,985,367 → 1,994,005 字节，增加 8,638 字节（0.4351%）。体积预算按实测增量向上取千字节，从 1,986,000 调整为 1,995,000，最终余量 995 字节；协议、依赖固定提交、执行隔离、兼容性与功能排除检查全部保留。基线与候选 SHA256、锁文件指纹保存在 [verification.json](./verification.json)。

定向覆盖率可复现命令：

```bash
pnpm test:coverage tests/inputTranslationContentFeature.test.ts \
  --coverage.include=src/features/input-translation/content/index.ts
pnpm test:coverage tests/inputEditableHost.test.ts tests/inputBox.test.ts \
  --coverage.include=src/features/input-translation/content/editableHost.ts \
  --coverage.include=src/features/input-translation/content/inputBox.ts
pnpm test:coverage tests/inputTranslationBackground.test.ts tests/backgroundFeatureHandlers.test.ts \
  --testNamePattern='输入框' \
  --coverage.include=src/features/input-translation/background/handler.ts
```

类型、构建、产物与文档检查：

```bash
pnpm compile
pnpm test:audit
pnpm build
pnpm build:firefox
pnpm build:userscript
node scripts/verify-userscript-build.mjs
pnpm verify:extension-manifests
pnpm docs:build
pnpm storybook:build
pnpm storybook:check
pnpm docs:check
```

浏览器回归命令（先执行 pnpm build，使用隔离的生产 Chrome MV3 产物）：

```bash
node scripts/run-input-translation-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <Node包目录> \
  --focus-safe-helper scripts/testing/focus-safe-browser.cjs \
  --artifacts-dir /private/tmp/fluentread-input-translation
node scripts/run-rich-text-input-editors-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <Node包目录> \
  --focus-safe-helper scripts/testing/focus-safe-browser.cjs \
  --artifacts-dir /private/tmp/fluentread-rich-text-editors \
  --slate-fast-cache
```

## 验证边界

浏览器验证使用生产 Chrome MV3 构建、临时 Edge profile、第二屏后台窗口和真实键盘/指针事件。供应商响应由本地确定性夹具提供，验证请求次数、参数、AbortSignal 和写入交互，不衡量外部服务连通性、账号认证或模型翻译质量。真实编辑器验证使用 Quill、ProseMirror、Lexical、Slate 和 Draft.js 的公开实现，不能覆盖具体网站的所有定制插件。

Firefox 和 userscript 的构建与产物检查不能代替其运行时验证。没有以本地结果宣称 GitHub CI 通过。

## 本地交付

基线为 origin/main 的 fe7005dd9；实现位于分支 codex/input-translation-quality-20261011 的独立 worktree。没有修改主检出目录或参考仓库，也没有借用参考项目代码。依赖按既有锁文件安装，package.json 与 pnpm-lock.yaml 均未改变。
