# 贡献网站适配规则

你可以通过 JSON 新增网站或修复现有网站的正文范围，无需为每个域名编写一个 TypeScript 适配器。先在本地验证，再向 [FluentRead 仓库](https://github.com/FluentRead/FluentRead) 提交 Pull Request，让规则随扩展版本分发给其他用户。

只想调整自己的阅读体验，请先看[自定义网站翻译](/guide/custom-site-rules)；字段定义、覆盖顺序和大小限制见[JSON 格式参考](/config/site-adaptation)。

## 先确认要解决的问题

记录一个可复现的网址、页面类型、扩展版本，以及应翻译和应保留的区域。例如：「文章段落漏译；作者、时间和分享按钮应保持原文」。先检查通用识别和现有规则是否已经处理该页面，再决定修改现有规则还是新增域名。

优先选择正文结构、稳定的语义属性和内容类名，不使用构建生成的随机类名或大量 `nth-child`。一个域名的文章页、搜索页和编辑页可能需要不同路径范围。登录、付费或人机验证限制不能当成规则无效的证据，也不能用自建夹具声称实站通过。

## 准备开发环境

先阅读仓库 `AGENTS.md`，使用独立 worktree 保留主检出目录的已有工作。Fork 并克隆自己的仓库后，从上游最新主线创建工作目录。首次添加 `upstream` 时执行以下命令；若已有同名 remote，先确认它指向 FluentRead 上游，再跳过第一行：

```sh
git remote add upstream https://github.com/FluentRead/FluentRead.git
git fetch upstream
git worktree add ../FluentRead-site-rules -b feat/site-rules upstream/main
cd ../FluentRead-site-rules
pnpm install --frozen-lockfile
pnpm exec wxt prepare
```

Node.js 版本以 `.nvmrc` 为准，pnpm 版本以 `package.json` 为准。开发扩展使用 `pnpm dev`。需要生产产物验证时运行 `pnpm build`，加载 `.output/chrome-mv3`。使用临时浏览器 profile，避免让测试改动日常配置。

## 文件放在哪里

| 文件 | 修改目的 |
| --- | --- |
| `src/core/site-adaptation/catalog/websites.json` | 新增或修改网站规则 |
| `src/core/site-adaptation/catalog/established.json` | 维护迁移自既有专用适配器的规则及原有边界 |
| `src/core/site-adaptation/catalog/profiles.json` | 多个网站共享的结构模板 |
| `src/core/site-adaptation/catalog/coverage.json` | 记录类别、验证等级、实站证据和限制 |
| `scripts/site-translation/site-adaptation-fixtures.json` | 新目录的独立网页夹具 |
| `scripts/site-translation/site-adaptation-established-fixtures.json` | 原有专用网站的浏览器夹具 |
| `scripts/site-translation/site-adaptation-live-cases.json` | 可公开访问的实站抽样地址 |
| `tests/siteAdaptationCatalog.test.ts` | 新目录的主机、内容、保护及重挂载验证 |
| `tests/siteAdaptationCore.test.ts` / `tests/translationCore.test.ts` | 编译器和已有适配边界的回归 |

`catalog.ts` 静态组合目录，生产引擎和设置页共用它。不要再注册一份并行规则，也不要直接维护生成的 `.output/site-rule-pack.json`。

## 新增一条规则

以下是添加到 `websites.json` 数组中的单条记录。示例域名需要替换成你实际验证的网站；它不是完整的设置导入包。

```json
{
  "id": "example-docs",
  "name": "示例文档",
  "match": {
    "hosts": ["docs.example.com"],
    "paths": ["/guide/*"],
    "excludePaths": ["/guide/editor/*"]
  },
  "profile": "documentation",
  "protect": [".article-author"]
}
```

`documentation` 已声明常见正文块、代码保护与导航排除。先确认该模板适合目标网站；不要为了复用模板而把整页改成正文。若只需要为一个网站补选择器或保护项，将它们写在该规则中。只有多个网站确实具有相同结构和边界时，才新增或修改共享模板。

声明正文目标的目录规则在展开模板后，`protect` 应包含 `code`、`pre`、`input`、`textarea`，且 `exclude` 包含 `nav`。编写不引用模板的正文规则时也要保留这些边界；这是内置目录的维护约定，不是所有用户自定义包的必填字段。

若通用识别已能找到正文，问题只在作者、时间或计数等元数据，可以使用不引用模板、不声明 `content` 的 `augment` 规则，只补 `exclude` 和相关 `watchIgnore`。不要为了满足正文模板而添加无必要的白名单。此类规则必须有独立夹具，证明元数据不进入候选或祖先源文本，正文、其中的普通链接与用户提及、新增内容仍能通过通用引擎发现。Bluesky 的 `/profile/*` 使用这一方式；它不代表登录信息流、私信或全部帖子页面已验证。

`id` 是持久标识，会被停用设置和自定义覆盖引用。新增时保证唯一，改名称或域名时尽量保留原 ID；不要给无关网站复用旧 ID。

明确正文白名单时可以使用 `focus`。每条 `focus` 规则都必须有专属夹具，同时声明段落、标题等目标。大容器设为 `atomic: false` 只是允许继续发现内部目标及直接文字，不会替你选择所有后代。

## 添加可重复的网页夹具

在 `site-adaptation-fixtures.json` 数组中加入对应记录。`id` 必须等于规则 ID，`url` 必须命中主机与路径。夹具使用自己编写的最小 HTML，保留真正导致问题的结构；不要提交完整私人页面。

```json
{
  "id": "example-docs",
  "url": "https://docs.example.com/guide/start",
  "html": "<main><article><p id='body-one'>The first readable paragraph explains how the feature works.<code id='protected'>KEEP_ORIGINAL_TOKEN</code></p><p id='body-two'>The second paragraph stays independently selectable.<span id='author' class='article-author'>User metadata remains unchanged</span></p><button id='controls'>Open menu</button></article></main><nav id='navigation'>Navigation remains unchanged</nav>",
  "required": ["#body-one", "#body-two"],
  "forbidden": ["#protected", "#author", "#controls", "#navigation"]
}
```

现有目录测试会要求两段正文分别进入实际候选引擎，悬浮命中一致，示例中的代码和元数据不进入源文本，等价重建后结果一致。上例的 `#protected` 和 `KEEP_ORIGINAL_TOKEN` 是当前通用夹具断言所需的约定；有其他嵌套保护文字时，也应补上对应的源文本断言。

修复回归时，先让新反例在旧规则上失败，再修改规则。只证明选择器字符串存在没有意义；要证明它改变了正确的候选或保护边界。若问题涉及混合文字、嵌套回复、公式、元数据或控件，把这些结构放进夹具中。

Product Hunt 的 `product-hunt` 规则覆盖首页、产品与旧发布详情路径。首页使用公开页面的 `homepage-section-*`、`section[data-container]` 及其介绍 span 结构，不依赖产品 ID 或构建生成的 class；产品名与分类链接独立保护。Cookie 提示通过 `dismiss-CookiePopup` 整块排除，避免把按钮文字复制进祖先译文。首页结构改版时优先复核这条专站选择器，详情页仍保留 `discussion` 的通用回退。帮助中心文章不命中这条规则，不能用它的翻译成功代表产品首页通过。

Hacker News 评论的第一段经常直接属于 `.commtext`，其余段落才使用 `p`。容器使用非原子 self 目标，并保留内部段落目标；只选择 `.commtext p` 会漏掉首段，使用 closest 原子容器会把全部段落合成一份译文。`.comhead`、`.reply` 等界面区域同时声明排除与动态观察忽略，让候选发现提前剪枝；FAQ、guidelines 等阅读页仍可走通用正文识别。

Bing 普通搜索结果只选择自然结果标题与摘要，来源、日期、广告、侧栏和摘要内的操作链接保持原文。Google News 当前声明 `/home` 的主标题和新闻标题，新闻使用可读的 `./read/` 链接，排除隐藏覆盖链接；其他页面形态继续由通用识别处理。

Amazon 商品的 `#acrPopover` 星级弹层与价格保持原文，商品描述、规格与评论正文仍可翻译。评分是语义组件边界，不使用全站图标类名或评分文字匹配来排除正文。

CNN 的图片说明与署名是相邻组件：说明继续翻译，作者名、发布日期和图片署名保留。说明的真实翻译 owner 可能包含插件为直接文字创建的分段节点，测试不能只在说明子节点内查找译文，也不能把附近署名的译文算作说明完成。

Steam 商店保留免费游戏入口和已加载评论的用户名。评论卡片的按钮语义会让通用识别把内部正文当成控件标签，因此只为评论链接旁的正文声明原子内容目标，让长评、换行和短评均使用正常的双语与恢复流程；不整块排除评论卡片或游戏介绍。商店实站契约还检查游戏介绍的完整直接正文，避免把容器里的单个标题译文误当成整段正文完成；这项原文归属检查要求使用 `--controlled-provider`。

Steam 社区规则覆盖应用讨论列表、帖子正文和回复。置顶标签、作者、时间、计数及发帖区不进入翻译请求；空覆盖链接保留原有点击行为。GitHub Gist 分别处理 Markdown 直接文本、段落、列表、表格和评论，保护代码表格、行号、用户提及和文件操作区。

Firefox Add-ons 使用独立 focus 规则：真实摘要位于 `.Addon-header` 内，因此不能继承排除所有 header 段落的模板。描述、开发者说明和评论正文分别选择，扩展名称、安装区、作者、评分、展开按钮和侧栏保持原文。评论正文只按官方组件声明的纯文本与 `<br>` 结构编写夹具。

验证长页面时，把屏外译文、滚动布局、动态内容和恢复行为一起检查，避免全局注入影响宿主布局的 CSS。

长页渲染优化仅作用于插件新建的普通块级双语译文，首次布局测量后保存其占位尺寸；公式、注音、图片、越界装饰与不支持相关 CSS 的浏览器保留普通渲染。隔离前后盒子位置或大小发生变化时立即回退，原文容器与仅译文文本槽不启用此优化。刷新、重挂载和修改译文外观时撤下旧尺寸隔离，避免沿用旧元素或旧宿主的高度记忆；打印也切回普通绘制。初次测量会增加布局读取，收益应与提交阶段分别记录，不能由屏外跳过推断首轮翻译更快。使用 mock 长评论、文章与论文检查屏外跳过、滚动往返、尺寸变化、文字搜索、链接焦点及精确恢复，并区分确定的渲染工作量减少与不同环境下的耗时波动。

## 更新验证记录

在 `coverage.json` 的 `rules` 中为新规则添加对应记录：

```json
{
  "id": "example-docs",
  "category": "documentation",
  "verification": "site-fixture",
  "fixture": "example-docs",
  "liveVerification": "not-performed"
}
```

类别沿用目录已有值。`semantic-fixture` 只证明共享模板契约，`site-fixture` 证明独立构造的专站结构；只有实际打开页面并完成交互验证后，才能填写实站通过记录。注明日期、URL、浏览器、测试范围和限制。站点改版后应更新过时记录，不得沿用已失效的通过结论。

新增共享模板时，还要在 `coverage.json` 的 `profiles` 中补充说明与验证等级，并为至少一条引用它的规则提供夹具；目录测试会检查模板与记录、夹具是否对应。

需要公开实站回归时，将地址加入 `site-adaptation-live-cases.json`：`selector` 用于测试定位实际可读正文，脚本会从中选择最多两段可见、文字长度至少 70 字符且不在导航、代码、按钮、列表项或编辑区内的内容。`guardSelectors` 可声明额外需要保持原文的唯一元素；当前脚本仅在该选择器恰好匹配一个元素时加入断言，零个或多个匹配不会作为该保护区的验证证据，应检查实际结果。这份列表是测试输入，不是生产规则。登录页与验证码页不应充当正文样本。

目录中带日期的规模与审计数据是历史快照；如果在新提交中更新它们，应同时更新日期和统计依据，不要仅为提高覆盖数字批量添加没有边界价值的域名。

## 修改已有规则或模板

先在设置中复制该内置规则到自定义草稿，快速确认改法，再将最终差异落实到目录。提交前删除本地同 ID 自定义覆盖，或使用全新测试 profile，否则实际运行的可能还是旧草稿。

缩小正文范围时检查是否遗漏摘要、文章内提示框或独立回复；扩大范围时检查代码、作者、时间、评分、导航和表单。`protect` 与 `exclude` 会共同保护嵌套文字，`watchIgnore` 只控制动态重扫，不能代替原文保护。模板数组与规则数组会追加，移除模板里的选择器需要修改模板或使用独立配方，不能靠空数组抵消。

规则默认仅应用于正文范围。必须在“全部节点”范围也保留名称等内容时，在该规则上显式声明 `allScopes: true`，并同时验证两个范围；这会让整条规则生效，因此不应把正文白名单或无关控件排除合并到此类规则中。OpenRouter 的模型名称保护使用这一设置，停用和同 ID 自定义替换仍按正常规则处理。

需要在双语译文里省略受控元数据时使用 `omit`；它同时保护源文本，但保留宿主原节点。命令手册的标签可使用严格范围的 `literalLabels`，其字符形态与括号检查由共享编译器完成；必须补普通粗体句子、中文说明以及紧邻代码示例的反例，不能把仅命中选择器当成标签证据。这两类边界都应经模板展开和同 ID 自定义替换测试，避免内置保护成为用户无法覆盖的隐藏规则。

共享模板的变化会影响全部引用网站；至少检查这些规则的所有夹具，并对不同布局做代表性实站复验。删除规则或更换 ID 时，在 PR 中说明用户自定义覆盖、停用项及通用回退的影响。

## 运行验证

从项目根目录执行：

```sh
pnpm test:audit
pnpm exec vitest run tests/siteAdaptationCatalog.test.ts tests/siteAdaptationCore.test.ts tests/siteAdaptationSession.test.ts tests/siteAdaptationSettings.test.ts tests/translationCore.test.ts
pnpm compile
pnpm build
pnpm build:firefox
pnpm build:userscript
node scripts/verify-userscript-build.mjs
node scripts/testing/verify-extension-manifests.mjs
git diff --check
```

修改引擎、观察器、取消或路由生命周期时，还需运行相应全文和 bridge 回归及 `pnpm test:coverage`，保持严格边界四维 100%；修改文档运行 `pnpm docs:build`。详细门禁见仓库的 `docs/testing.md`。

生产扩展的浏览器验证示例：

```sh
node scripts/run-site-adaptation-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root /absolute/path/to/node_modules \
  --focus-safe-helper /absolute/path/to/focus-safe-browser.cjs \
  --artifacts-dir /tmp/fluentread-site-rules \
  --cases example-docs
```

`--cases` 填已经加入夹具的 ID；添加 `--live` 则从实站清单取同 ID 页面。脚本依赖提供 Playwright 的依赖目录和项目维护者使用的 focus-safe helper，当前后台流程使用 macOS Edge；没有该环境的贡献者可在临时浏览器中手动验证，并准确标明执行方式，不应声称运行过该脚本。

常见站点新增规则可用 `--cases bing-search,steam-community-discussions,google-news-home-headlines,github-gist,firefox-addons --skip-settings-ui` 独立运行。一个规则的 `variants` 表示不同页面形态，Steam 包含列表和帖子，Firefox Add-ons 包含详情和评论。`sourceAssertions` 检查真正发送给本地供应商的文字；`restoreSelectors` 检查宿主 HTML 精确恢复。可选 `dynamic` 场景覆盖新增正文、原文 Text 槽更新、受保护元数据变化、宿主重建与同名规则替换后的迟到响应。

无论使用何种方式，都应检查悬浮与全文的翻译、恢复和再翻译，邻段独立性、保护区原文、动态新增、路径切换，以及修改规则后的迟到请求。自动化用本地确定性翻译响应验证链路；远程服务可用性需要另行说明。

长页渲染可运行三类独立编写的 mock 文档，无需访问实站或远程翻译服务：

```sh
node scripts/testing/run-resource-safe.mjs -- node scripts/testing/run-long-page-mock-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root /absolute/path/to/node_modules \
  --artifacts-dir /tmp/fluentread-long-page
```

该脚本使用项目的后台浏览器 helper，验证长评论、文章及 HTML 论文；它不验证 PDF 阅读器、操作系统桌面响应或屏幕阅读器。报告分别记录首次翻译与滚动阶段，耗时对照只改变测试文档的渲染控制规则，不代表旧版本扩展或远程服务性能。

## 提交 PR 与后续维护

提交到上游 `main` 的 PR 应说明具体网站和页面类型、修改前后的行为、采用哪些稳定结构、执行过哪些命令与浏览器用例，以及尚未验证的范围。提供脱敏截图或最小 HTML 反例，避免把登录信息、邮件、账户资料或整份个人配置上传到公开仓库。

不方便写代码时，可以提交 [Issue](https://github.com/FluentRead/FluentRead/issues/new)，附公开网址、复现步骤、期望保留和翻译的区域。已有本地规则也可以导出后作为提案提交；提案经过验证和合并后，才会随扩展版本成为内置规则，客户端不会自动订阅 Issue 附件或远程规则。

需要分发完整目录时运行 `node scripts/export-site-rule-pack.mjs`，默认生成 `.output/site-rule-pack.json`。设置中的 **导出内置规则** 同样可导出当前安装版本的完整内置包，**导出已保存规则** 则仅导出已保存的自定义包；两者都不包含未保存草稿、启用开关或停用列表。


GitHub 发布说明中的多段列表项先发现内部段落，再翻译列表项直接拥有的文字，避免把全部译文堆到条目末尾。正文规则可以声明 `splitOnBr: true`，按直接子级 `<br>` 建立逐行对照；原文的换行、链接与行内格式保持原位。普通段落及嵌套元素内部的换行仍保持原有处理方式。该字段默认关闭，悬浮与全文使用相同的行边界。
