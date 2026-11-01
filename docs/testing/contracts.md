# 范围、诊断与完整流水线

[返回测试入口](../testing.md)。按本次改动选择下面的专项；这些条目不要求每次全部运行。

## 编译与构建缓存

本地开发推荐 Node 22.12 以上的 22.x 版本，与 CI 的 Node 22 保持一致。切换后分别检查 `node --version` 和 `pnpm exec node --version`，避免交互式 shell 与 pnpm 的 PATH 使用不同的 Node。旧 Node 20 下 WXT 的 `ora` → `cli-spinners` 动画依赖会产生 JSON 模块实验性告警；不通过 `--no-warnings` 隐藏它。

`pnpm compile` 继续校验固定语言资源并检查完整的 Vue/TypeScript 项目，增量信息写入各工作树自己的 `.wxt/cache/extension.tsbuildinfo`，不缩小 include 范围或放宽诊断。可以删除这个文件强制重建缓存，或运行 `pnpm exec vue-tsc --noEmit` 单独比较编译器的非增量耗时；类型错误仍须使本次命令失败。其他集成的类型检查不共用此缓存路径。

完整项目在 Node 默认约 4 GiB 旧生代预算下可能发生 OOM。编译入口在可见总内存至少 16 GiB、且 Node 报告的内存约束没有更小时，只为编译子进程默认设置 6 GiB 旧生代上限；显式 `NODE_OPTIONS` 堆设置保持原值。小内存或已知受限环境不自动提高预算，可见总量不保证当前空闲量或隐藏容器限制。资源锁、信号转发与真实退出码仍由原 runner 处理；CI 在调用前继续执行原有可用内存门禁。

独立用户脚本的大型静态资源压缩结果存于 `.wxt/cache/userscript-gzip/`。原文、压缩实现、worker 或锁文件变化均重新压缩；读取时核对摘要及有界解压后的完整内容。损坏缓存保留告警后重建；真实 I/O 或压缩器错误继续失败。同进程相同输入共用在途任务，缓存与返回值不共享可变缓冲区。`FLUENTREAD_BUILD_CACHE=0 pnpm build:userscript:standalone` 可用于无缓存对照，也可删除该目录；这些构建数据不进入 Firefox 源码包或发布安装包。

Vite 构建不再为日志重复计算整份产物的 gzip 大小；扩展与两个用户脚本的实际体积门禁保持原样。扩展页面把 Vue 运行时、域名算法与自有公共配置分别打包，不改变内容脚本、后台 IIFE 或模块 Worker 的输出模式。第三方字体引擎与语音依赖仍可能超过 Vite 的默认 500 kB 提示线；必须保留告警并审查实际依赖，不能据此认定整个构建无告警。

`Extension quality` 在准备 WXT 类型后恢复上述两种缓存；缓存键包含操作系统、Node 22、锁文件、包配置、根类型配置与本次提交。相同配置的后继提交可恢复上一次成功 job 的缓存，类型检查仍按当前文件图及内容失效，压缩缓存仍逐条校验输入，不复用安装包或测试通过状态。

比较构建性能时固定源码、Node、锁文件及压缩参数，分别报告首次与缓存命中耗时。资源锁排队时间与实际命令耗时分开记录；通过完整产物摘要比较或必要的浏览器验收验证优化没有丢失资源与功能。


## 运行时错误与告警

功能断言与运行时诊断共同决定测试结果。日常测试、针对性回归和正式发版回归均须检查选定范围内 FluentRead 自身的错误与告警；发现后定位根因、修复并重跑相关用例。译文出现、界面可用或构建成功不能代替这项检查，也不因此扩大为无关功能的全量回归。

浏览器测试在导航、扩展 UI 加载与测试动作前开始采集 `console.warn/error`、未捕获异常、未处理 Promise rejection 和扩展 API 失败，覆盖本次相关的内容脚本隔离世界、popup/options、后台及重新启动的 Service Worker。网页的 `pageerror` 不能保证观察到内容脚本错误；Chromium 可结合 CDP `Runtime.exceptionThrown`、`Runtime.consoleAPICalled` 与执行上下文归属，必要时检查本轮临时 profile 的扩展管理页错误记录。禁止操作用户日常 profile。首次后台附着前的空窗、附着失败或无法观察的 surface 都要记录，不能据零条日志推断全程没有错误。

成功、失败与中断都须在清理浏览器前保存诊断证据：级别、surface/上下文、页面和脚本 URL、位置、堆栈、时间、测试阶段及次数。记录时排除密钥、令牌与完整用户配置。报告分别列出自身错误/告警、预期负向诊断、外部噪声、归属不明项、采集缺口、修复和复测结果；存在未修复自身问题时标为未通过，采集不足时标为未验证。

宿主网页和第三方日志须用脚本来源、堆栈或执行上下文证明归属后单独报告；归属不明须继续调查。不得忽略整站、所有网络失败、全部 `TypeError`、`toLowerCase` 或消息前缀。故意注入失败的负向用例须限定用例、阶段、来源、精确消息和次数，并检查恢复结果；保留原始诊断及预期标记，不能通过删日志、吞异常、降级日志级别、关闭功能或将已有缺陷加入白名单使测试通过。

### 扩展重载后的界面资源

Chrome/Edge MV3 的公开图标和实际消费的两份内容入口样式使用稳定扩展地址，避免扩展重载后动态 UUID 轮换使旧页面保存的 CSS、图标地址失效。当前产物为 `icon/32.png`、`icon/48.png`、`icon/128.png` 及 `content-scripts/content.css`、`content-scripts/neteaseMailFrame.css`。共用受限 frame 不显示 Shadow UI，裁剪静态 UI 依赖后不再生成 `supportedFrame.css`；网页翻译样式仍由原四份 inline 样式安装和清理。稳定资源配置继续识别旧文件名，但不会创建文件或清单项。站点匹配、权限和 CSP 不增加，语言包继续使用动态地址。稳定地址会使这些已公开界面资产可按固定扩展 ID 探测。

`extensionManifestContract` 验证最终清单调整的文件集合、原站点边界、语言包动态地址及其他目标行为；产物校验同时检查真实 UI 脚本的 CSS 地址、文件和公开范围，以及共用 frame 没有未消费的 Shadow UI 样式。源码边界、CSS 有序 AST 与字节比较的维护约束见 [受限 frame 的 UI 样式依赖裁剪](../maintainers/frame-ui-css-20261024.md)。浏览器专项须分别验证首次加载、同源 frame、软导航、扩展重载后旧地址与新页面，检查实际 CSS 内容/计算样式、图标尺寸和 Runtime/Log 诊断。旧上下文仍按原生命周期清理；稳定资源地址不代表旧脚本可继续调用失效的扩展 API。动态 UUID 资源不能仅因 host 不同于实际扩展 ID 就自动当成其他扩展噪声排除，未证明归属的安全日志应保留并阻断。

网页兼容维护集与生命周期验收见 [网页翻译稳定性维护](../maintainers/web-stability.md)。该入口显式选择十个独立站点，复用已有正文与保护区契约，并将宿主 DOM 探针、原生站点操作、在线供应商和不同浏览器的证据分开记录。`fullPageVisibilityScheduling` 新增路由观察选项刷新、断连 ShadowRoot 回收/重新插入，以及重连观察器时保留待投递保护区变化；`contentFeatureMounting` 与划词 `--lifecycle-only` 验证入口被移除后的恢复、取消、错误重试、禁用和窄屏键盘操作。

真实站点 runner 与矩阵执行必须显式提供 `--runtime-diagnostics-helper <浏览器翻译测试技能>/scripts/runtime-diagnostics.cjs`，不依赖开发者固定安装路径。`--list` 只读取清单，无需该 helper。一键回归的 `--network --allow-network` 同样接收该参数，也可通过 `FLUENTREAD_RUNTIME_DIAGNOSTICS_HELPER` 指定；普通改动仍应显式用 `--cases` 选择受影响站点。受控供应商只向首次选定的 `chrome-extension://<id>/` worker 注入响应，网站的 HTTP(S) worker 与其它扩展不被注入、不计入供应商证据；选定扩展的 worker 重启、丢失或身份变化仍会失败。

站点默认使用 `fullPageScope: "finite-page"`，要求滚动到稳定底部。无限信息流可显式配置 `"initial-corpus"`：每轮翻译开始时冻结覆盖选择器中当前已载入的全部可读正文，逐个给予可见机会并要求每个 owner 完成，随后验证恢复原文和再次翻译；第二轮以该轮开始时已载入的集合重新取证。此范围禁止 `trackDynamic`，不会追逐无限新增的节点，不宣称抵达信息流底部，也不代表未配置区域、无限滚动或分页加载验收。结果保存 `fullPageScope`、`fullPageBoundary` 以及各轮完整覆盖数量，缺失初始正文仍会失败。

Bing 普通搜索会在悬停时把 `/ck/a?u=a1<base64>` 跟踪链接改为同目标的直链。交互检查仅在 `https://www.bing.com/search` 对该已观察格式核对解码后的 HTTP(S) 目标，证据仍保存前后原始 href；其它站点、路径、协议、伪造域名或目的地变化继续失败，不按整站忽略链接变化。

```bash
node scripts/run-site-translation-matrix.cjs \
  --cases example-com,wikipedia-united-states --mode both --allow-network --background \
  --controlled-provider --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> \
  --focus-safe-helper scripts/testing/focus-safe-browser.cjs \
  --runtime-diagnostics-helper <浏览器翻译测试技能>/scripts/runtime-diagnostics.cjs \
  --artifacts-dir <证据目录>
```

采集在创建供应商配置页和导航目标页之前启动，每个本轮页面在导航前等待 Runtime/Log 附着；后台 target 重新出现时继续采集。既有功能证据保存后，目标页在三秒预算内导航到 `about:blank`，在采集仍开启时观察相关文档卸载；导航失败单独保留并令本轮失败，不覆盖原始功能异常。功能断言完成后仍需通过诊断门禁，扩展错误、告警、归属不明日志、附着失败或后台未观察到都会失败。失败与成功均保存 `runtime-diagnostics.json` 和 `result.json`，并继续关闭自有浏览器与清理临时 profile；省略证据目录时生成临时证据目录并打印路径。报告保留采集器的 `completeCoverage=false`、首次后台附着前空窗、重启附着空窗和跨进程 iframe 等 limitations，零条日志只代表声明范围内未观察到阻断项，不能写成全程运行时干净。受控响应只验证真实站点 DOM 与扩展链路，不证明在线翻译质量。

`contentRuntimeLifecycle` 与 `qqMailFrameRuntime` 验证冷启动的两次取消边界：配置就绪后先检查文档销毁或扩展上下文失效，避免为已经退出的顶层、QQ、网易及受支持正文 frame 开始读取和解析界面语言包；语言资源已经开始等待时，完成后仍须复核，禁止迟到挂载。有效页面继续等待语言包，失败仍沿用中文回退；往返缓存中的暂停不是销毁，恢复继续复用原生命周期。本层不取消已经共享的资源请求，也不改变后台 frame 授权时序。

## 按需运行

测试、类型检查和生产构建的 package scripts 统一经过
`scripts/testing/run-resource-safe.mjs`。同一台机器上的 FluentRead worktree
共用一组全局锁槽位，默认最多 5 个任务同时运行，第 6 个起排队等待空槽；每个任务中
Vitest 最多使用 2 个 worker，并关闭测试文件并行。直接运行 `pnpm exec vitest` 也通过
globalSetup 占用同一组槽位。嵌套的 package 命令复用父进程所持槽位，子进程结束或收到
终止信号后才释放；已退出进程遗留的槽位可自动回收。槽 0 沿用旧版唯一的 `lock` 目录，
尚未更新的 worktree 仍会在这个槽位上与新版本互相协调。

默认显示的 60% 是协作式资源预算标记，不是 CPU 使用率硬上限，也不会根据
这个百分比自动计算 worker 数量。需要进一步减少占用时使用
`FLUENTREAD_TEST_MAX_WORKERS=1 pnpm test`。直接调用浏览器脚本或其他高负载命令时，
可使用 `node scripts/testing/run-resource-safe.mjs -- <命令及参数>`。
默认最多等待锁 30 分钟，可用 `FLUENTREAD_TEST_LOCK_WAIT_MS` 调整；并发槽位数可用
`FLUENTREAD_TEST_CONCURRENCY` 或 `--concurrency <n>` 调整，设为 1 时恢复完全串行。
`FLUENTREAD_RESOURCE_LOCK_DIR` 仅用于专项锁隔离验证；日常任务不要改写它，否则
不同目录的任务无法互相协调。

`tests/resourceSafeRunner.test.ts` 使用真实 Node 子进程验证并发槽位上限与排队、串行模式下的互斥、死进程锁竞争回收
（取得清理权后整代锁目录原子改名再删除，避免递归删除中途被其他等待者重建清理标记而崩溃）、
非首个槽位的回收与父子锁复用、worker 参数、Vitest setup、等待超时、退出码和 SIGTERM 释放。
`pnpm test -- <文件>` 和 coverage 命令的首个 Vitest 转发分隔符会被兼容处理；
其他命令中的 `--` 原样保留。

```bash
pnpm test:audit          # 测试矩阵、重复和禁用项审计
pnpm test:architecture   # 分层、依赖方向与验证归属
pnpm test:unit           # 纯函数、状态机、parser、cache、handler
pnpm test:functional     # 多模块协作，替换网络/浏览器等外部边界
pnpm test:regression     # 历史缺陷的最小复现
pnpm test:coverage       # 全部 Vitest 与原生进程夹具一次编排 + 四维 100% 门禁
pnpm test:document       # 文档格式、导出、取消、边界与历史回归
pnpm verify:extension-manifests  # fresh Chrome/Firefox 产物的权限、Offscreen 与 runtime marker
node scripts/verify-userscript-build.mjs  # userscript 元数据与产物边界
```

普通回归与严格覆盖率共用 `vitest.config.ts` 的 Vue 编译、环境、文件隔离、资源预算和 `tests/**/*.test.ts` 发现规则。`test:coverage` 一次执行全部分组；`processRegression.test.ts` 注册并执行所有原生 Node 进程夹具，核验实际退出码与 TAP 全部通过、零跳过，原生清理语义继续在真实子进程中运行；`test:regression:all` 不再重复运行已执行的分组，单独分组入口继续用于定向开发。覆盖率的生产源码清单、`all: true`、四维 100% 阈值及忽略检查保持严格；测试数量或四维覆盖率不能代替有效的行为断言。

真实组件夹具可复用 `tests/helpers/compiledVueFixture.ts` 的纯编译结果，支持独立模板与 `inlineTemplate` 两种原有编译方式。缓存按绝对路径、完整源码及编译选项区分，并限制容量；有序脚本替换、模块格式和编译 ID 分开缓存，运行时 import 信息保持不可变。helper 不保存已执行模块、render 函数、组件实例、DOM 或 mock。挂载继续创建独立实例、DOM 和端口，并按各夹具原有生命周期清理；递归组件图只在一次挂载内保持类型身份，已有的文件级 Vite server 保持原有作用域。不得缓存运行中的组件或关闭文件隔离。时间行为优先使用可控时钟，异步持久化和挂载优先等待明确的事件；取消、超时和时间边界断言仍须保留。

真实论文回归需要显式提供输入：`FLUENTREAD_ATTENTION_PDF` 指向 Attention v7 的 PDF，`FLUENTREAD_PDF_CORPUS` 指向非空论文目录，`FLUENTREAD_HARNESS_PDF` 指向 Harness 论文 PDF；Harness 历史修订用例还需 `FLUENTREAD_HARNESS_LAYOUT_OLD` 与 `FLUENTREAD_HARNESS_LAYOUT_FIXED` 指向对应解析结果 JSON，再执行 `pnpm test:coverage` 或 `pnpm test:regression:all`。未提供必要输入时相关用例会标记跳过，不能称为包含真实论文的完整验收；验收报告应保留语料文件名和 SHA-256。论文本身不进入仓库。

新增测试时应选择唯一分组：

- `unit` 只验证一个可隔离模块；不要再次复制同一功能的集成路径。
- `functional` 验证真实模块协作，mock 只放在网络、浏览器、时间或存储边界。
- `regression` 的用例名要写出历史失败条件，并保留能使旧实现失败的最小输入。
- `architecture` 验证目录、依赖、协议、安全运行方式和流水线归属，不替代行为断言。

`tests/architecture/sourceFileHeaders.test.ts` 会枚举 `src/` 下所有 TypeScript、Vue、CSS 与 Markdown 文件，检查首字符处的长注释、精确 `@file` 路径以及职责、内容、边界三个非空语义段。新增或移动源码时必须同步书写文件级说明，不能只让旧文件一次性通过。

## 覆盖率定义

### PR 的扩展质量检查

`.github/workflows/extension-quality.yml` 在面向 `main` 的 PR、主线提交和手动运行时检查扩展。使用锁文件安装与 pnpm 缓存，单个 Vitest worker、一个资源槽和串行构建；同一 PR 的新提交取消旧检查。工作流先执行测试登记审计，再由 `scripts/testing/run-affected-tests.mjs` 将完整架构组与受影响行为测试合并去重，统一执行一次。架构组中已有真实 runtime 消费者；它们在同一覆盖率运行中贡献执行证据，不能按分类标签排除。涉及扩展、共享源码、测试、资源或构建脚本时，继续检查 TypeScript/Vue、Chrome 与 Firefox 构建、生成清单，以及标准和 standalone userscript 的构建、元数据与原有体积门禁。文档内容独立变化仍执行架构门禁，不触发这些扩展构建。

影响规划以 PR 基线到实际检出提交的 Git diff 为准，跟踪静态 import、使用明确路径的动态 import、barrel、CSS、夹具路径，以及现有组件测试直接读取 SFC 的文件路径；删除和重命名的旧路径同样参与追踪。测试归类复用 `tests/test-matrix.json`，架构组只执行一次。单纯新增测试登记或覆盖率清单保持定向范围；共享依赖、TypeScript/Vitest 执行环境变化则显式扩大到全部受影响行为套件，计划记录扩大原因。改动的严格覆盖模块没有可追踪行为测试时检查失败，不能以空选择通过。

模板夹具路径按固定子目录和静态后缀匹配已知 Git 路径，例如 `./fixtures/page-context/${name}.html`；解析器不执行插值，不把 `src/${name}` 等仅含项目根的路径扩大为全源码。删除和重命名的旧路径仍参与匹配。无法确定子目录的动态读取，应在消费者中明确保留目录依赖；新增动态路径应同时检查真正消费者入选和无关目录未入选。

严格覆盖率只统计此次改动并已纳入显式清单的源码，以及此次新纳入清单的已有源码；生成的临时配置继承真实测试插件与资源设置，并保留 statements/branches/functions/lines 四项 100% 门槛，逐文件检查。测试本身或纯文档变化没有覆盖源码目标时，执行所选行为测试并明确记录覆盖率未执行。计划与 coverage summary 作为 7 天 CI 证据保存；这些结果不代表全项目行为覆盖、真实浏览器、Firefox 实机或在线供应商验证。依赖图选择不能替代新增功能测试与必要的人工浏览器专项。

本地可检查和执行相同范围：

```bash
node scripts/testing/run-affected-tests.mjs --base origin/main --plan-only --report coverage/affected-plan/plan.json
node scripts/testing/run-resource-safe.mjs -- node scripts/testing/run-affected-tests.mjs --base origin/main
```

没有受影响测试时，入口明确跳过执行，不向 Vitest 传空筛选而误跑全量。缺失 Git 基线、无效覆盖清单、测试失败或子进程终止均使入口失败。源码头审计仅忽略 Finder 的精确 `.DS_Store` 文件名；隐藏源码、相似文件名和未知资产仍遵循原规则。

### 全项目的验证归属

项目使用两道互补门禁，不能把“构建成功”和“代码行为已经覆盖”混为一谈：

1. `vitest.coverage.config.ts` 中列出的已迁移 TypeScript 业务模块，V8 statements、branches、functions、lines 必须同时达到 100%。
2. `tests/architecture/verificationOwnership.test.ts` 审计其余 WXT entrypoint、Vue、CSS、HTML、browser runner、userscript 和文档文件，保证每个文件都由编译、双浏览器构建、静态契约、文档构建或隔离浏览器回归负责。

新增 `src` 可执行 TypeScript 模块默认必须进入第一道门禁。只有纯类型文件、纯 re-export barrel 和列明理由的静态 composition root 可以由第二道门禁负责；Vue 的业务验证归属按下述独立规则检查。禁止使用 `v8 ignore`、扩大 exclude 或无断言执行来制造 100%。

`src` 与 `userscript` 的 Vue 另受 `tests/architecture/vue-verification-owners.json` 约束：已纳入严格覆盖的组件复用该边界；其他有业务行为的组件必须明确登记实际 SFC 消费者及场景。门禁检查测试存在且已归类、组件依赖可追踪、真实装载/执行与断言形态，并拒绝只出现源码名称、删除执行入口、挂载无关组件或仅 mock 目标 SFC 的登记；这些结构检查仍不能代替对领域断言的审查。纯展示与静态组装例外逐项说明，并检查脚本及模板没有新增状态、方法、事件和副作用。

本轮保留 34 份历史 Vue 验证债务，记录完整源码 SHA-256、固定 `e765165d` Git blob、缺口及迁出条件；它们明确不算已验证的业务 owner。修改源码、刷新清单 hash 或把新增组件放进历史记录都会失败，必须迁出到真实组件行为测试或正式严格覆盖。少量记录附现有隔离浏览器入口及证据限制，入口存在不等于本轮已执行；不能用父组件的 mock、构建成功或任意浏览器脚本替代该组件行为证明。

`videoSubtitleAppearanceSettingsLifecycle` 挂载真实字幕外观设置 SFC，验证自动贴底与手动偏移联动、位置显隐、七语标签及 ARIA、字号和皮肤预览、重置及草稿替换；Element Plus 与语言上下文作为受控端口。该组件已从冻结债务迁为真实行为消费者，测试不代表真实浏览器排版或辅助技术语音验收。

文档翻译的 parser、预览生成、二进制格式服务、翻译编排和展示模型全部进入第一道门禁；PDF.js worker 与真实 Canvas 像素采样适配由双浏览器构建及屏幕外文档浏览器回归负责。

配置计数测试需要同时覆盖：扩展后台 mutation 串行化、operationId 在提交后重启时去重、失败批次
复用同一标识、普通配置保存不能回滚 count，以及 userscript 多副本并发、提交后响应丢失和新页面聚合恢复。

## 动态任务清单与核心行为验证

GitHub Issue #1029 的任务列表在 React 加载后会变成一个外层 LI 内的多个 DIV 正文。
`tests/translationGitHubTaskList.test.ts` 检查真实结构对应的独立所有权，
`translationOwnershipBoundaries`、`translationVisualProtection`、`translationSnapshotProtection`
和 `syntheticCandidateFreshness` 分别覆盖悬浮边界、隐藏内容、最终副本及排队节点时效。

生产扩展专项 `scripts/testing/run-github-task-list-test.cjs` 使用临时后台 Edge，默认运行
确定性夹具，追加 `--live` 验证用户报告的实时 GitHub Issue。包括每项译文、隐藏说明、
原生节点身份、390px 布局、动态增改、恢复重译、重挂和失败重试；供应商响应是本地夹具。
[行为说明、测试结果与复现命令](../reports/translation-core-audit-20260915/README.md)。

## 一键回归

### X 本地 AI 字幕同步

`scripts/run-x-subtitle-sync-test.cjs` 使用生产扩展、真实 Whisper Tiny/Base 与确定性语音验证完整识别。它要求 macOS 的 `say`（Samantha 声音）、`/opt/homebrew/bin/ffmpeg`、`ffprobe`、独立 Playwright runtime 和 focus-safe helper；首次运行会下载所选模型。

```bash
pnpm test:video:x-fixture -- \
  --extension-dir .output/chrome-mv3 \
  --playwright-root <path> \
  --focus-safe-helper <path> \
  --artifacts-dir /private/tmp/fluentread-x-subtitle-proof \
  --long true --native-track true
```

使用 `--early-hls true --background-generation true --owner-handoff true --display-mode bilingual` 验证首屏早到清单、切换标签页后继续生成、完成后另一标签页可用和慢翻译；`--media-source direct` 验证独立媒体解码。使用 `--host-overlay true` 复现 X 媒体链接覆盖内层播放器的结构，使用普通鼠标点击验证菜单可操作，同时检查原有媒体链接仍可点击。`--model base --media-source direct` 覆盖较大模型与支持 Range 的直接 MP4 播放和跳转。另用 `--background-music true` 在语音下叠加持续背景音，按 20 ms 帧验证其 RMS 高于固定静音阈值；字幕边界仍对照未混音的原始语音，保留 250 ms 预算。口述文字比较只忽略大小写和句末标点，句子数量与词序必须一致。双语测试仅替换翻译供应商为固定延迟响应，不替换本地音频识别。

报告分别记录模型准备与字幕生成耗时，校验完整句子、SRT 非重叠区间、相对独立音频停顿检测的 250 ms 边界预算、暂停/seek/停止和原生字幕恢复。测试窗口保持正常尺寸、位于第二块屏幕且不抢前台。该语音夹具证明指定音轨的行为，不能代替真实 X 网络、任意口音或背景音乐的识别验证。

使用 `--prepare-after-load true --trusted-storage true --browser-path <新版 Chrome 可执行文件> --extension-install cdp` 验证播放器页面已打开后才下载模型，无需刷新即可生成字幕。该用例强制将本地存储设为 `TRUSTED_CONTEXTS`，通过 CDP 在扩展内容脚本上下文确认直接读取被拒绝，再验证后台模型查询与真实生成成功、没有误开设置页。旧浏览器没有此 API，不能作为这条权限回归的验证环境。`--extension-install cdp` 在独立临时 profile 中通过官方 DevTools `Extensions.loadUnpacked` 加载扩展，兼容不再接受命令行加载扩展的新 Chrome；不会使用日常 profile。追加 `--model-query-failure true` 可注入一次后台状态查询失败，检查提示重试、没有误开下载页，随后仍使用真实模型生成。生成前、生成中和就绪后的截图及 DOM 断言同时检查菜单分组、下载按钮并排和内容溢出。

### X 模型下载来源与等待边界

`modelDownloads`、`videoAiModelCache`、`downloadProgress`、`downloadProgressTransport`、`videoAiBackground` 和 `videoAiOffscreen` 测试覆盖国内/官方优先顺序、连接与首字节等待、忽略取消的底层请求和读取、完整响应后仍未返回的消费端、迟到流清理、总预算、完整文件复用及可信来源状态传输。共享 HTTP helper 变化同时覆盖本地 TTS、漫画、OCR 和本地翻译直接消费者，保留历史缓存的来源兼容性。`localModelSettingsLifecycle` 与 `implementationAudit49C` 执行实际 Vue 客户端模板，检查来源选择只影响后续请求、切源文字、失败重试和旧视图事件隔离。

Small 默认配置另覆盖新配置、旧配置缺字段、非法值及保留明确 Tiny/Base 选择。下载来源的公网 HTTP 核验与隔离浏览器中的受控失败/流式接收必须分开报告；权重片段和服务端哈希元数据不能代替完整远端文件下载，也不能据单机结果保证中国、美国、欧洲的地域可达性。实际结果见[X 模型下载验证记录](../reports/x-model-download-sources-20261009/verification.md)。

### AI 字幕中文质量与性能基准

`scripts/run-video-ai-recognition-benchmark.cjs` 在同一个临时 profile 中对照两份生产扩展，实际调用 Whisper Tiny/Base 转写三段确定性的普通话音频（含较快长句），分别测显式中文和自动检测。模型在本机执行，测量不使用用户日常浏览器配置。

```bash
node scripts/run-video-ai-recognition-benchmark.cjs \
  --extension-dir <baseline-production-build> \
  --next-extension-dir .output/chrome-mv3 \
  --playwright-root <path> \
  --focus-safe-helper <path> \
  --artifacts-dir /private/tmp/fluentread-ai-recognition-benchmark
```

报告包含原始识别文字、字符错误率 CER、首次模型准备耗时、各音频窗口转写耗时、后端与量化类型、隔离浏览器累计 CPU 时间和累计 RSS 峰值。CER 忽略标点但保留简繁字形差异；RSS 累加可能重复计入共享页，不等于独占物理内存或 GPU 显存。应在没有并行构建等负载时测量。首次推理包含冷启动，第二版本复用模型下载缓存，不能把下载/首次推理差异算作代码提速。合成语音只是可重复基准，不能代表影视对白、方言、背景音乐或用户帖子里的实际准确率。

`scripts/run-video-ai-media-persistence-test.cjs` 使用已保存的时间轴和确定性翻译验证元数据补全、鼠标移出/移回、控制栏重建、同媒体 video 替换、暂时隐藏及真正换媒体时的字幕状态；它不调用真实 ASR，不能用来声称识别准确率提高。

### 完整流水线

本地确定性回归负责测试审计、WXT prepare、类型检查、全部 Vitest 测试与原生 Node 进程夹具的单轮编排及严格覆盖率、Chrome/Firefox/userscript 构建及文档构建：

```bash
pnpm test:regression:all
pnpm test:regression:all -- --artifacts-dir /private/tmp/fluentread-regression-<本轮唯一名称>
pnpm test:regression:all -- --browser \
  --playwright-root <path> \
  --browser-path <path> \
  --focus-safe-helper <path>
```

执行后，终端显示总报告的位置；默认在系统临时目录新建本轮独立目录，也可用 `--artifacts-dir` 指定新目录。目录内包含：

- `summary.md`：阶段状态、命令、耗时、退出码、日志链接，以及测试数量和四维覆盖率。
- `report.json`：结构化结果、源码提交与工作树状态、运行开始时的源码与清单指纹、完整测试矩阵和覆盖源码清单的比对结果。
- `repair-plan.md`：失败项、跳过项、依赖受阻项、原始复现参数与后续复验建议。
- `logs/`、`vitest-results.json` 和 `coverage/`：本轮日志、测试结果和覆盖率原始证据。

默认继续执行独立检查，构建失败后依赖其产物的检查记为受阻，避免使用上轮残留产物。需要首个失败或证据不完整后停止时，使用 `--fail-fast`。已含证据或被其他运行占用的目录会拒绝重用；复验须使用新目录，保留原始结果。每阶段结束都会更新报告，收到中断信号时保存中断状态、停止后续调度，并等待当前步骤清理退出；忽略信号的进程可能延迟结束。

只有本轮计划全部通过、Vitest 逐用例计数与全部测试文件范围一致、零跳过，并且严格覆盖清单中每份源码的 statements/branches/functions/lines 原始 `covered === total`、`skipped === 0`、`pct === 100` 时，命令才返回成功。缺失或损坏的报告、测试跳过、范围遗漏、运行中源码或清单变化、中断及执行失败都返回非零；报告分别记录“失败”和“证据不完整”。真实论文用例未提供所需本地输入时仍保留跳过记录，不能认定为完整验收。测试失败时也请求生成覆盖率报告，保留可用的诊断证据。

修复流程由 Codex 读取总报告与日志，先复现并核对源码，区分环境或语料问题与已确认缺陷，再自动修复已确认的缺陷并运行相关定向测试。修复记录应注明改动、复验范围、剩余失败和未执行项；定向通过后仍需按影响范围补做完整回归。CLI 负责执行和报告，修复代码由 Codex 完成。不得通过删除必要用例或断言、缩小覆盖范围、降低阈值、增加跳过或覆盖率忽略来获得通过。

真实浏览器层必须使用临时 profile、屏幕外正常尺寸窗口和 focus-safe helper；不会连接用户日常 profile，也不会静默退化成抢焦点的普通 Playwright 启动。`--browser` 追加 14 组本地浏览器夹具：首次 popup 高度、划词触发、全文翻译、翻译 DOM 与按钮稳定性、固定高度双语布局、GitHub 间距、嵌套列表和任务列表、视频字幕、文档翻译、设置中心、术语库、隐私边界和 userscript smoke；真实网络站点矩阵还需要单独的网络许可。具体参数以 `node scripts/testing/run-full-regression.mjs --help` 为准。

CI 或本地报告必须分别说明：确定性回归、隔离浏览器回归、真实网络矩阵是否执行。任何未执行层都不能写成“全量回归已通过”。

## 真实站点用例精简

页面已被删除、输入已失效且没有可验证目标的用例，可以从执行矩阵移除；在问题记录中保留来源、退出原因、证据及尚未覆盖的能力。重复用例只有在确认没有独有行为覆盖后才合并，不能把相邻场景当作完整替代。

临时连接失败、人机验证、正文未渲染，以及尚待修复的产品或测试缺口，不因未通过就删除。明确区分 required、quarantine 和已退役样本；删除数量不能计为通过数量。修改矩阵后运行配置校验、测试清单审计和相关回归，并核对保留用例的断言与覆盖门槛。

只读的正文骨架、来源指纹和测试探针快照使用无浏览上下文的文档复制。实时文档中的深拷贝即使没有挂载，或随后立即移除图片，也可能重新请求失败的图片；先浅复制 Document 壳，再由该惰性文档 importNode，可保留原始属性、命名空间和文本顺序。实际重新挂载的可信模板另行检查，不能与只读快照混改。机制验证使用本地 no-store 图片响应、逐路径请求计数和显式图片请求阳性对照；本地结果不能直接给原站错误归因，原始运行时失败、请求身份与采集缺口继续保留。

