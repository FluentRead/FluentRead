# 网页翻译稳定性维护

本维护集复用 `tests/browser-translation-cases.json` 的正文覆盖、保护区、交互和恢复契约。清单在 `scripts/site-translation/maintenance-cases.json`，不是新的站点适配注册表。修改站点选择器前先检查真实 DOM，不能把漏译节点排除后宣布通过。

| 站点 | 维护入口 | 主要场景 |
| --- | --- | --- |
| GitHub | `github-project-pr` | PR 标题、正文、列表、原生搜索对话框 |
| Hacker News | `hacker-news-8863` | 讨论正文、评论折叠与展开 |
| MDN | `mdn-javascript-guide` | 技术长文、章节与代码保护 |
| Wikipedia | `wikipedia-united-states` | 长文章、滚动、链接与公式 |
| Python | `python-tutorial-introduction` | 教程正文与代码块 |
| Rust | `rust-book-getting-started` | mdBook、行内代码和列表 |
| Go | `go-tutorial-getting-started` | 操作步骤、代码与命令 |
| Dart | `dart-language` | 导语、正文、导航保护 |
| Use The Index, Luke | `index-luke-preface` | #969 新反馈、SQL 代码和长段落 |
| NASA Science | `nasa-webb-news` | 新闻长文、主标题与搜索框 |

Mastodon 公开信息流使用下文独立入口补充原生分页与 SPA 操作，不混入这十站的通过计数。当天产物摘要、每站覆盖及历史失败见 [验收记录](../reports/web-stability-20261015/verification.json)。

## 常用网站兼容性扩展

以“网站 × 页面类型 × 操作”作为验收单位。一个网站首页通过，不能推断文章、评论或登录信息流也通过。先用通用正文识别覆盖正常的 HTML，再复用页面类型 profile；只有实际候选、保护区或原生操作出现偏差时才增加站点规则。通用机制已经正确的页面需要补证据，不需要为了增加站点数量添加空规则。

| 页面类型 | 应翻译的内容 | 单独核验的边界与操作 |
| --- | --- | --- |
| 搜索与结果列表 | 结果标题、摘要 | 域名、日期、评分、筛选和分页；悬停后链接目的地 |
| 新闻与长文章 | 主标题、章节、正文、图注 | 作者与时间、媒体控件、付费墙；展开与路由切换 |
| 社区与评论 | 帖子、回复、可展开的长文 | 用户名、计数、投票和输入区；折叠、加载更多和虚拟列表 |
| 商品与评测 | 商品说明、参数说明、评论 | 价格、库存、规格选择、购买和购物车；变体切换 |
| 文档与百科 | 章节、段落、列表、注释正文 | 代码、公式、引用标记和导航；长页滚动 |
| AI 对话 | 用户和助手的可读消息 | 代码、输入区、工具状态；流式追加、编辑和重生成 |

`coverage.json` 的 `prioritySites` 是常用站点复验队列。按真实用户反馈、阅读频率、问题影响和页面结构代表性选择下一批；搜索、社区、新闻、购物和 AI 对话均需有样本，不能用大量相似技术文档代替。运行 `node scripts/site-translation/audit-site-coverage.cjs` 查看实际规则声明、历史夹具证据和按精确主机关联的浏览器契约；`quarantine` 与未执行的契约仍是待验证项。`--json` 可保存本轮清单。这里没有用户流量权重，不能据此计算“覆盖绝大多数用户”或按规则条数报通过率。

发现异常时先保留完整网址、语言、登录状态、浏览器/扩展版本、原文区域和触发操作，区分站点拦截、页面结构、调度、DOM 挂载与供应商结果。检查当前真实 DOM 后，用独立编写的最小夹具固定正文 owner 和保护区，再加必要的主机/路径规则；优先使用语义属性与组件边界，避免易变样式类。共享 profile 的修改需验证其它使用者，专站规则保留通用候选，除非当前页面证据表明确实需要限制读取范围。

每个修复都应验证翻译、恢复、再次翻译及相关原生操作，保留失败和成功证据。夹具通过、实际 DOM 兼容、在线译文质量、登录后页面和浏览器/设备验收分别记录。公开页面遇到验证码或登录墙时记录待验证范围，不绕过访问限制，也不凭参考项目的规则认定 FluentRead 已支持。

公开文章可正常关闭的推广弹层由用例明确声明对话框、关闭按钮和公开正文，再通过原生点击关闭；不能用移除 DOM、改写 ARIA 或提交登录表单代替。LinkedIn 的作者与推荐元数据、X 的作者与相邻账号组件分别保护，普通正文里提及同一姓名、作者简介及推荐标题仍应可译。真实供应商结果有省略或误译时，先核对请求是否包含完整原文；页面来源完整与译文质量分别验收，不因一次结果就扩大站点排除范围。

BBC 的图片署名与叙述图注分别判断。明确的图片署名节点保留原文；纯署名图注只有在完整文本与同一张图的唯一署名严格对应时才保护，带叙述内容的图注继续翻译。不能因为头图位置、样式类或 `Credit:` 前缀就排除整条图注。

GitHub issue 的作者、评论头部及时间线参与者以原生组件属性保护，并排除 Markdown 正文及包含正文的近似组件。正文中的用户名引用、链接、列表和引用块仍走原有阅读规则；不能按用户名或全部个人资料链接扩大保护。

Facebook 的公开 `www.facebook.com/*/posts/*` 页面以原生组件保护主帖和评论作者，正文中提及相同姓名、可读链接及评论里的个人资料引用继续翻译。公开帖 dialog 的页头通过唯一原生正文、主帖与 `aria-labelledby` 对应的标题识别；近似 ID、正文内标题或已失效关系不能继承保护。已实测中文界面的回复摘要还须符合评论卡片的兄弟组件、四个原生槽、当前主作者与完整计数字样；分享与回复计数按完整原生计数格式识别，排序标签须有原生菜单语义和评论区归属。未知语言或附加正文沿用通用识别。标准用例只在核对公开 URL、canonical、原生 permalink、完整 Text/BR 与 href 不变后，正常关闭已实测的中文登录推广，最多点击一次。测试器绑定原始帖子 dialog 的 Node 身份以验收正文，其它、嵌套或替换的 dialog，以及同一 Node 的隐藏/惰性标记仍被排除。两段帖文与已加载的全部评论都纳入完整来源、恢复和重译契约；登录信息流、移动版、新增分页和实译质量另行验收。

Wikipedia 的参考文献文本可能把引导句和子列表放在同一个内联容器中。只对实际引用列表下、包含直接子列表的原生参考文本容器显式启用非原子分段：引导句与子项各自拥有译文，不能把父列表项整体吞并或遗漏引导句。导航列表继续保留原文；正文验收不能把导航当作待译正文，也不能因此删去真正的引用引导句。

## 运行

先在任务 worktree 生成生产扩展。使用工作区依赖工具返回的 Node 包目录，不硬编码带版本号的运行时路径。

```bash
pnpm build
node scripts/testing/run-resource-safe.mjs -- node scripts/run-site-translation-matrix.cjs \
  --profile maintenance --mode full --allow-network --background \
  --controlled-provider --stability-probes \
  --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> \
  --focus-safe-helper scripts/testing/focus-safe-browser.cjs \
  --runtime-diagnostics-helper <浏览器翻译测试技能>/scripts/runtime-diagnostics.cjs \
  --artifacts-dir <证据目录>
```

定位单站用 `--cases index-luke-preface` 替换 `--profile maintenance`；两者不能同时指定。省略 `--controlled-provider` 后使用全新临时配置的真实免费服务。普通改动选择相关站点，只有维护集验收才运行这十站，不自动扩大到全部矩阵。

`--controlled-provider` 只替换临时扩展后台的微软翻译传输响应，网页仍从原站加载；它不读取日常配置和凭据。报告必须标明受控响应，不能据此声称在线服务质量、可用性或时延通过。源码和生产产物发生变化后必须重新构建。

X 的指定公开样本可用 `--runtime-diagnostics-helper scripts/testing/x-runtime-diagnostics.cjs`，并显式传入 `--raw-runtime-diagnostics-helper <原始采集器路径>`。这个测试包装器保留原始报告与判定，仅在同一 CDP session 的实际日志 entry ID、请求 ID、页面/loader、完整请求链、已审核桥接产物摘要及调用位置全部吻合时派生站点归属。缺少证据或出现新的调用栈仍须失败；不能按 API 域名、404 状态或历史记录批量忽略，也不能回填旧失败。

GitHub 的指定公开 issue 样本可改用 `scripts/testing/github-runtime-diagnostics.cjs`，同样显式传入原始采集器路径。包装器在导航前、原采集器的同一个 CDP session 上确认 2048 帧采集配置生效，只对无扩展对照中实测的三条精确 GET/404 请求及其完整版本化调用栈派生站点归属。默认 200 帧截断栈、达到新上限的栈、未解析的父栈、其它端点或任何采集缺口仍阻断。报告分别保留原始失败和派生判定，不改变网页请求或生产扩展。

## 每站验收

- 按独立覆盖规则检查所有发现的正文节点、主标题和列表，不以“存在一个译文”代替正文覆盖。
- 保护区和原链接语义在翻译前后保持一致。记录代码、公式、表单、搜索框等站点特定保护边界。
- `interactionSelectors` 对每条选择器记录匹配数量，并检查一个代表控件的链接与可操作语义；宽泛的文章链接选择器不等于逐条链接验收。需要完整链接或节点身份保证时，另存逐节点证据，不能从代表控件推断全部节点。
- 悬浮前用原生滚动把目标居中，再等待原文 TextRange 稳定且实际命中。视口内的文字可能仍被吸顶标题挡住；持续遮挡时必须失败，不能向遮罩发送快捷键或改写页面来消除它。
- 翻译、完整恢复、再次翻译均通过；无同父重复译文和嵌套译文；恢复时原始文字和 HTML 可核对。
- 稳定性探针从第二轮已译状态开始，检查静置、同文 Text 节点替换、宿主移除译文、追加正文、恢复重译，以及停止后追加正文保持原文。
- 探针主动修改的是本次临时页面 DOM，报告明确标为 `controlled-host-mutations-on-live-page`。它不能代替网站自身的评论展开、无限滚动或 SPA 导航。原生操作应另有操作步骤、前后 URL/DOM、覆盖和截图证据。
- 区分停止会话后不再挂载译文、测试观察器已释放、浏览器关闭/profile 删除，以及产品内部所有监听器释放。这些是不同证据，不能互相替代。
- 外部 HTTP 错误、验证码、登录墙、选择器漂移和供应商失败分别保留。失败或 quarantine 站点不能计为 required 成功。

## 浏览器与界面

Edge 使用临时 profile、第二屏正常窗口和后台启动；不连接日常浏览器，不抢焦点，不调用 `bringToFront()`。报告保存 launch mode、focus policy、window placement、DOM 与原始截图。窄视口/触摸模拟必须注明是桌面浏览器模拟，不能标为移动真机通过。

Firefox 需安装本次 production MV2 产物到独立 profile，并执行实际操作。构建与清单验证只证明产物，不证明运行时。Safari、Android 和 iOS 需要各自环境证据；缺少设备时保留明确的待验收项。

其余环境按以下顺序补验，结果不能继承桌面模拟；已经完成的管理器与浏览器组合以验收记录为准：

| 环境 | 安装与操作安排 | 必须保留的证据 |
| --- | --- | --- |
| Android Firefox 实机 | 使用移动端工程提供的兼容安装包；打开 SQL 教程、HN 和 Mastodon，触摸触发全文、滚动新增帖子、展开评论、恢复并再次翻译 | 设备/系统/浏览器/扩展版本、真实视口、触摸录屏、正文覆盖、保护区和恢复结果 |
| iOS/iPadOS Safari 实机 | 使用移动端工程的签名 Safari Web Extension，授予测试站点权限；在普通与横屏状态执行相同三站流程，并检查划词菜单与键盘 | 签名产物摘要、扩展启用状态、权限、横竖屏截图、译文/原文核对；模拟器单列 |
| macOS Safari | 使用独立测试 profile 与 Safari Web Extension 包，执行长文、公开信息流和网页卸载重开 | Safari 版本、安装来源、页面错误、恢复结果；不能以 Firefox MV2 代替 |
| userscript 管理器 | 在独立 profile 安装本次 userscript 及指定管理器；执行全文、停止、页面卸载及再次启用，重点检查失效订阅和 Shadow 样式清理 | 管理器名称/版本、脚本摘要、调用与清理结果；构建 verifier 单列 |

此任务不改签名、分发或移动入口。移动端工程验收其它提交时，应合入本分支后重建并对上述网页生命周期重验，不能把另一产物的设备结果直接记到本报告。

### 生产专项入口

以下命令同样需要资源保护包装器。所有浏览器脚本都限定新建临时 profile；路径参数使用本次 worktree 与证据目录。

```bash
# 划词入口：删除挂载节点、在途恢复、取消、失败重试、键盘、390px 深色
node scripts/testing/run-resource-safe.mjs -- node scripts/run-selection-trigger-test.cjs \
  --lifecycle-only --extension-dir .output/chrome-mv3 \
  --playwright-root <Node包目录> --runtime-diagnostics <runtime-diagnostics.cjs> \
  --artifacts-dir <划词证据目录>

# 原生 Mastodon 公开帖子：真实滚轮分页和同文档路由，不登录、不发帖
node scripts/testing/run-resource-safe.mjs -- node scripts/testing/run-web-native-feed-test.cjs \
  --allow-network --extension-dir .output/chrome-mv3 --playwright-root <Node包目录> \
  --artifacts-dir <动态站点证据目录>

# Firefox MV2：本机夹具与真实 SQL 教程，使用本地响应验证页面生命周期
node scripts/testing/run-resource-safe.mjs -- node scripts/testing/run-web-stability-firefox-test.cjs \
  --extension-dir .output/firefox-mv2 --artifacts-dir <Firefox证据目录> \
  --live --live-url https://use-the-index-luke.com/sql/preface \
  --live-selector '#article p' --live-protected '#article pre, #article code'
```

Firefox 使用当前安装版本的 Marionette 协议，并把所需系统访问环境变量仅传给本次新进程；不会修改全局 Firefox 配置。报告核对真实监听 PID、临时 profile、前台激活事件和关闭后的进程状态。窗口尺寸与实际内容视口分别记录，`focus:false` 切换自动化目标后仍须选中确切测试标签，不能把后台标签遗留的旧视口当成窄屏通过。

`run-web-mutation-lifecycle-test.cjs` 运行原创页面的不同规则/相同规则路由、ShadowRoot 卸载重插、保护区变化、恢复重译和样式生命周期。它通过真实快捷键、生产扩展和垃圾回收证据检查资源释放；此页面属于夹具，不计入真实站点数量。脚本的 `--help` 显示所需扩展、Playwright、focus-safe helper 与证据参数。

每份实站成功结果记录产物摘要和清理状态；维护矩阵汇总写入 `matrix-report.json`。静置探针当前使用 `contractVersion: 2`，包括动态副本的保护子树、全部后代译文数量、译文属性变化与原 owner 临时移除。旧版报告不能替代这些新增断言。

## 修复与集成边界

本项拥有网页候选、DOM 挂载、mutation/路由观察、划词入口生命周期与对应验证。文档阅读器、学习工作区、全局首次使用由其他工程维护。共享接口保持现有配置消息、全文快捷键和翻译请求协议；测试配置与测试登记文件是并行集成时的冲突热点。

#969 的 GitHub 旧版窗口变化重放已有产品修复，本项集成其既有两次测试提交并重新验证，不将旧修复标为新实现。该 issue 的 SQL 教程反馈独立核验。#956 描述不足，挂载节点被宿主删除的修复不代表已确认反馈者的根因。
