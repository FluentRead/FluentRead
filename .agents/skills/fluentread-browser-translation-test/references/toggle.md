# 页面翻译专项

只读取本次相关段落。隔离与诊断见 [browser-contract.md](browser-contract.md)。

## 前台焦点保护

`--background` 保持测试浏览器处于后台，依次选择 DeskPad、副屏、主屏。

- macOS 后台模式使用随 Skill 提供的 `scripts/focus-safe-browser.cjs`，通过 `/usr/bin/open -g -n` 和 `--no-startup-window` 在后台启动独立 Edge，再通过 CDP 连接。不得在后台模式中直接调用 Playwright `launchPersistentContext()`。
- 禁止在后台模式中直接调用 `context.newPage()`；使用 `newPageWithoutForeground()` 通过 `Target.createTarget({ background: true })` 创建页签。
- 禁止调用 `page.bringToFront()`。需要让扩展识别某个 active tab 时，使用 `activateExtensionTabWithoutForeground()` 在隔离 Edge 内执行 `chrome.tabs.update(tabId, { active: true })`；这只改变测试浏览器内部页签，不激活 macOS 应用。
- 后台窗口保持 `windowState: "normal"`，完整位于实际选中屏幕的可用区域。合法坐标由 macOS 显示器布局计算。
- `page.mouse` 和 `page.keyboard` 只能作为 DevTools 协议输入使用，禁止使用 Computer Use、系统鼠标或会激活应用的脚本来完成普通页面手势。
- 后台启动、CDP 连接、前台应用校验或窗口可见区域校验失败时立即停止测试，不得静默退回会抢焦点的启动方式。成功报告必须包含 `launchMode: "macos-background-cdp"`、`focusPolicy: "launchservices-no-foreground"`、`windowPlacement.mode: "background-visible-no-focus"` 和 `windowPlacement.browserFrontmost: false`。
- 同一批 case 尽量复用一个隔离浏览器实例。必须使用前台窗口、系统级全局快捷键或真实系统鼠标的测试，先告知用户并获得本次明确同意，再使用 `--headed`。
- `connectOverCDP` 的 Playwright 保真度低于原生协议。修改本 helper 或升级 Edge/Playwright 后，必须同时做真实焦点事件监控和实际 FluentRead 功能回归；不能只根据启动参数宣称“不抢焦点”或功能通过。


## 定位待测项目

1. 将当前 FluentRead 检出目录或 worktree 作为待测项目。
2. 确认其中包含 `package.json`、`wxt.config.ts` 和 `entrypoints/content.ts`。
3. 测试前运行 `git status --short`，保留所有现有改动。
4. 不要编辑或构建 `read-frog`、`kiss-translator`；它们仅是参考项目。


## 选择测试方式

- 标准段落测试优先运行随 Skill 提供的 `scripts/run-toggle-test.cjs`；脚本默认使用 `--background` 行为。
- 修改候选发现、DOM 分类、站点 adapter、mutation、恢复逻辑或全文/悬浮共享核心时，优先运行 FluentRead 仓库内的 `scripts/run-site-translation-test.cjs` 和 `scripts/run-site-translation-matrix.cjs`。它们是随产品版本演进的真实站点契约；Skill 自带脚本只负责最小诊断，不替代项目矩阵。
- 默认使用 `--background` 和自动选屏。需要系统级快捷键、系统鼠标或前台交互时，按本轮授权传 `--headed`。
- 全新隔离配置默认使用 FluentRead 的免费翻译聚合服务，此时传入 `--expected-service freeTranslation`。
- 测试 `siliconCloud` 或其他需要凭据的服务时，通过 `--profile-dir` 使用专用测试配置。让用户在图形界面中配置凭据，再传入 `--expected-service siliconCloud` 证明实际启用的是目标服务。
- 不得为了让测试通过而覆盖 API 密钥或模型。只有目标服务缺少必要凭据时才询问用户。


## 启动开发构建

在待测 FluentRead 目录中运行：

```bash
FLUENTREAD_DISABLE_BROWSER_RUNNER=1 pnpm dev
```

保持该进程运行。等待 WXT 报告构建成功，并确认以下文件存在：

```text
.output/chrome-mv3-dev/manifest.json
```

交付前还应运行 `pnpm build`，再把 `.output/chrome-mv3` 作为 `--extension-dir` 重跑与本次改动相关的关键站点；完整矩阵仅在正式发版时或用户明确要求时运行，避免只验证开发热更新产物。

项目的 `FLUENTREAD_DISABLE_BROWSER_RUNNER=1` 只启动 WXT 开发服务。随后用随附脚本启动临时 Edge 并加载开发产物。

如果 `pnpm dev` 需要图形界面或网络权限，只为该命令请求范围明确的授权，不要扩大到无关命令。


## 获取浏览器自动化依赖

调用 Codex 工作区依赖工具，记录：

- Node.js 可执行文件路径
- Node.js 包目录

将包目录作为 `--playwright-root` 传入。不要在新文档中硬编码带日期的 Codex 运行时路径。


## 运行标准测试

使用绝对路径调用脚本：

```bash
<bundled-node> \
  <this-skill>/scripts/run-toggle-test.cjs \
  --extension-dir <fluentread-checkout>/.output/chrome-mv3-dev \
  --playwright-root <bundled-node-packages> \
  --url https://example.com \
  --selector p \
  --expected-hotkey Control \
  --background \
  --artifacts-dir /private/tmp/fluentread-toggle-evidence
```

`--background` 是默认行为，优先选择 `DeskPad Display`，按需回退到副屏、主屏。需要真实系统级输入时，按本轮授权使用 `--headed`。

必须让 Edge 进入前台完成系统级交互时才使用：

```bash
--headed --display secondary
```

需要精确校验服务时追加：

```bash
--expected-service freeTranslation
```

或：

```bash
--expected-service siliconCloud
```

测试需要凭据的服务时，还要传入专用配置目录，且该目录不能是日常浏览器配置：

```bash
--profile-dir /private/tmp/fluentread-edge-profile-silicon-test
```

脚本不会删除显式传入的配置目录。不得把普通 Chrome 或 Edge 用户配置传给 `--profile-dir`。如果必须输入或修改凭据，把该步骤交给用户操作。

脚本会严格执行三次以下手势：

```text
把鼠标移到段落普通文本
-> 单击该段落
-> keyboard.down("Control")
-> keyboard.up("Control")
-> 等待预期 DOM 状态
```

不得替换为 `CTRL`、`Control_L`、`Ctrl+A` 或 JavaScript 合成的 `KeyboardEvent`。FluentRead 会精确匹配快捷键，浏览器输入也必须是可信事件。


## 必须通过的断言

仅当以下断言全部通过时才接受测试结果：

1. 内容脚本已注入稳定标志 `#fluent-read-page-styles`，且快捷键/译文状态证明运行时已建立。`#fluent-read-floating-ball-container` 只有在当前配置启用悬浮球时才要求存在，不能把合法关闭悬浮球误判成内容脚本未注入。
2. 当前配置已启用插件、使用双语模式，并配置了预期的 `Control` 快捷键。
3. 第一次操作后，目标段落恰好包含一个带中文文本的 `.fluent-read-bilingual-content` 元素。
4. 第二次操作后，目标段落不包含译文元素。
5. 第三次操作后，目标段落再次恰好包含一个译文元素。
6. 相邻段落始终没有译文元素。
7. 页面 URL 始终不变，证明没有触发链接跳转或全文操作。
8. 最终目标段落只有一份译文，没有重复插入。

当翻译服务输出足够稳定时，使用 `--expected-text '<已知译文片段>'` 做精确内容校验。否则，脚本至少要求译文包含一个中日韩统一表意文字，并报告实际文本。

传入 `--artifacts-dir` 后，保存首次翻译和最终状态截图。视觉正确性重要时，至少检查最终截图。


## 多站点与多结构覆盖

按本次改动选择相关真实页面，无须每次覆盖所有类别；以下是可选样本：

- 静态标准页：`https://example.com`，选择器 `p`。
- 长文档正文：Wikipedia 使用 `#mw-content-text p`，Swift 文档使用 `main p`。
- Markdown/评论结构：GitHub Issue 使用 `.markdown-body p`，Hacker News 讨论页使用 `.commtext`。

每个站点都使用新的临时 profile，执行完整 `[1, 0, 1]` 切换，检查相邻元素 `[0, 0, 0]`、URL 不变和最终只有一份译文。动态网站必须先等待目标元素可见且正文稳定；脚本已内置这一步。若页面重定向或站点改版导致选择器为空，先在隔离浏览器中只读检查实际 DOM，再记录调整后的选择器。

修改翻译核心候选算法时，选择受影响的站点和结构子集，覆盖相关 `hover` 与 `full` 链路。只有正式发版或用户明确要求完整矩阵时，才运行至少 20 个不同真实网站。所选矩阵为每页声明：

- `requiredSelectors`：预期能产生译文的正文区域；
- `forbiddenSelectors`：代码、公式、搜索框、导航或受控 UI 等必须保持不变的区域；
- `interactionSelectors`：翻译前后 URL、链接与基本交互语义保持一致；
- `tier`：稳定样本为 `required`，登录墙、验证码、远端断连或已知需要独立 capability 的页面为 `quarantine`，并写明原因。

全文模式除了译文非零，还要验证 required selector 覆盖、恢复后原始 DOM、再次翻译、无同父重复 wrapper 和无嵌套 wrapper。悬浮与全文必须命中同一候选语义；只有入口和调度可以不同。单个站点受网络或浏览器限制时可以进入 quarantine，但不得用它凑足 20 个 required 成功站点。

站点被 Cloudflare、人机验证、登录墙或同语言检测跳过时，记录为“站点/服务限制”或“无需翻译分支”，不能把它们冒充插件回归。若诊断脚本已经看到 loading、retry 或译文节点，结合控制台和服务请求分类，不要只根据总超时下结论。


## 隔离窗口兜底

如果脚本无法建立测试状态：

1. 仍然只启动临时 Edge 配置，只加载 `.output/chrome-mv3-dev`，并优先保持 `--background`。
2. 通过 Playwright 在隔离页面中执行鼠标和 `Control` 手势；不要切到用户当前浏览器窗口。
3. 默认窗口在自动选中的屏幕上可见且处于后台。需要前台或系统级交互时按本轮授权显式使用 `--headed`，测试结束关闭该隔离窗口。
4. 每次操作后检查 `.fluent-read-bilingual-content`，并保存 DOM/截图证据。

因测试失败而准备修改产品代码前，先阅读 `references/troubleshooting.md`。


## 解读结果

- 成功得到 `[1, 0, 1]` 只能证明指定段落状态切换正常，不能代表所有翻译能力都正常。
- 只有构建成功、没有浏览器证据，不能判定测试通过。
- 使用其他按键名称后 `Control` 未生效属于自动化错误，不能据此认定插件损坏。
- 快捷键和 DOM 注入正常但服务请求报错，属于服务或配置故障，不是快捷键故障。
- `Alt+T` 或 `Option+T` 测试的是全文翻译，不属于本段落测试范围。
- `pnpm compile` 可能暴露已有的无关类型错误。仅当修改文件引入新错误时才归因于本次回归。


## 清理并报告

1. 让脚本在 `finally` 中关闭 Edge，并且只删除自动创建的临时配置；保留显式传入的专用配置。
2. 停止本次测试启动的那个 `pnpm dev` 进程。
3. 运行 `git status --short` 和 `git diff --check`。
4. 确认测试没有生成受版本控制的项目改动。
5. 核对隔离 profile、`windowPlacement.browserFrontmost=false`、显示器名称和窗口边界。报告启动和焦点策略、证据目录、实际服务、配置摘要、`[1, 0, 1]` 计数、译文样例、截图路径与覆盖范围。

不得批量终止浏览器进程，也不得删除非临时用户配置。

