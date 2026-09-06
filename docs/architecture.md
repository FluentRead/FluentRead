# FluentRead 架构设计

> 本文描述当前架构、依赖规则和后续演进约束。迁移清单用于区分本轮已经验证的结果与仍需继续偿还的历史复杂度。

FluentRead 继续使用 WXT 0.20、Vue 3、TypeScript 和 pnpm。架构目标不是简单移动文件，而是建立可由编译、单测、功能测试和真实浏览器回归持续验证的模块边界。

## 设计目标

1. **入口薄**：WXT entrypoint 只声明 manifest 选项、绑定生命周期并组装模块。
2. **业务聚合**：单词本、划词、悬浮、图片、视频等功能各自拥有协议、运行时、UI 和测试。
3. **核心可测**：翻译算法、候选发现、文本识别算法、语言与热键规则尽量保持纯函数。
4. **边界可执行**：核心、provider、feature 内部与 WXT 入口等关键依赖方向由 fitness tests 约束。
5. **静态插件化**：各运行上下文使用静态注册表，兼顾 WXT 构建、MV2/MV3 与 tree-shaking。
6. **渐进迁移**：旧路径保留带 deprecated 标记的兼容导出，每次迁移都能独立编译和回归。
7. **开源友好**：目录、公共入口、注释、测试命令和扩展方式对新贡献者可发现、可复现。

## 与 Go 项目的对应关系

| FluentRead | Go 项目中的近似概念 | 职责 |
| --- | --- | --- |
| `entrypoints/` | `cmd/*` | WXT 文件式入口与运行时启动 |
| `src/app/` | application bootstrap | 组装 feature、消息路由和生命周期 |
| `src/features/` | 业务 package | 用户可感知的纵向功能 |
| `src/core/` | 纯领域 package | 算法、类型、不可变规则 |
| `src/services/` | use case/service | 跨 feature 的应用编排 |
| `src/providers/` | interface implementation | 翻译厂商和外部服务适配 |
| `src/platform/` | infrastructure/syscall wrapper | 浏览器、存储、offscreen、网络边界 |
| `src/shared/` | 小型公共 package | 无业务语义、无副作用的通用工具 |
| `src/ui/` | UI kit | 跨 feature 复用的 Vue 组件与设计 token |
| `userscript/`、测试 runner | 外部进程/插件 | 独立发布出口、Harness 与第三方集成边界 |

## 目标目录

```text
entrypoints/                         # WXT 只发现这里的入口
  background.ts
  content.ts
  popup/
  options/
  document/
  offscreen/
  *.content.ts

src/
  app/
    background/                      # 静态 message handler registry
    content/
      featureRegistry.ts             # content feature 生命周期契约
      featureLifecycle.ts
    popup/
    options/
    document-translation/
    offscreen/

  features/
    full-page-translation/
    hover-translation/
    selection-translation/
      services/
        edgeTtsPolicy.ts             # 音色、SSML、UTF-8 分段与 token 时效纯规则
        edgeTts.ts                   # Web Crypto、网络与取消边界
        wordDictionary.ts            # 词条归一化、开放数据 provider、缓存与并发去重
    input-translation/
    floating-ball/
    vocabulary/
    document-translation/
      core/                           # 格式识别、结构解析、渲染与安全预览
      services/                       # 二进制读写和可注入的翻译编排
      ui/                             # 纯展示模型与 PDF Canvas 浏览器适配
    image-translation/
    area-translation/
    video-subtitle/
    site-rules/
    settings/

  core/
    translation/                     # 纯翻译/候选/序列化算法
    language/
    hotkey/
    site-rules/

  services/
    translation/
      broker.ts                      # provider 调度、pending 去重、摘要编排
      cache.ts                       # 翻译缓存
      context/                       # 页面上下文纯策略与 Defuddle/DOM 适配
      legacyPageCache.ts             # 仅迁移 FluentRead 自有旧缓存键
      queue.ts
    config/                          # 配置读取、迁移、写入协调

  providers/
    translation/
      registry.ts
      microsoft.ts
      google.ts
      deepl.ts
      ai-sdk/
      ...

  platform/
    browser/
    storage/
    offscreen/
    http/
    shadow-ui/

  shared/
    dom/
    function/
    geometry/
    image/

  ui/
    components/
    styles/
      tokens.css
    view-model/

userscript/                          # 独立发布出口，复用 core/service/provider

tests/
  *.test.ts                         # 由 test-matrix 唯一归入 unit/functional/regression
  architecture/                    # 架构 fitness tests
  test-matrix.json
```

旧 `entrypoints/utils/` 兼容层已经删除；业务代码和测试必须直接依赖 `src` 公共契约，不能重新创建入口工具目录、`components/Main.vue` 或巨型 entrypoint。

## 依赖方向

```text
entrypoints
    |
    v
src/app ---------> src/features ---------> src/services ---------> src/providers
    |                    |                       |                       |
    |                    +-------> src/core <----+                       |
    |                    |                                               |
    +--------------------+---------------> src/platform <----------------+
                                             |
                                             v
                                         src/shared

src/ui 只能依赖 feature 的公开 view-model/contract、core 类型和 shared。
外部 Harness 或本机 bridge 通过版本化协议与 extension 通信，不能被扩展运行时代码反向依赖。
```

硬规则：

- `src/core/**` 不得 import `entrypoints`、Vue、WXT、browser API、feature 或 platform。
- `src/shared/**` 不得 import 任何业务层。
- feature 不得 import 另一个 feature 的内部文件；确需协作时通过公开 contract 或 service。
- provider 只处理供应商协议，不直接操作 DOM、Vue、配置页面或 runtime message。
- entrypoint 不直接 import feature 内部实现，只 import app composition root。
- 禁止新增跨层循环依赖。
- 兼容 re-export 只能位于明确的迁移白名单，并带 `@deprecated`。

当前仍有少量 feature 通过 `src/app/translation` 客户端或 background router 类型复用应用层契约；它们不形成循环，且关键 provider/core/跨 feature 边界已受测试约束，但仍是后续下沉 public port 的迁移债务。因此本文中的依赖图是目标方向，不代表所有历史调用已经完全单向。

## WXT 边界

WXT 会把 `entrypoints/` 下零层或一层的入口作为构建输入，并在构建阶段于 Node 环境导入 TypeScript entrypoint。因此：

- background/content 的浏览器运行时代码必须放在 `main()` 内，或放在被 `main()` 调用、且模块顶层无浏览器副作用的模块中。
- 不使用运行时扫描目录或未知动态 import 自动发现 feature。
- background、content、popup/options、offscreen 分别拥有静态注册表；不能创建一个会把所有上下文代码打进同一 bundle 的万能 barrel。
- MV3 background 是 service worker，内存状态必须允许重启；需要持久化的数据进入 storage/IndexedDB。
- 扩展自有 DOM 运行时由 background 管理，content 和 UI 只通过类型化消息协议请求能力。Chrome/Edge MV3 使用原生 Offscreen，Firefox MV2 使用后台页面中的隐藏扩展 iframe；两者加载同一个 `offscreen.html`，复用同一份消息路由、OCR、图片/区域绘制、字幕推理和 TTS 播放逻辑。
- `extensionDomClient` 只选择文档容器，并共用 `createOffscreenClient` 的准备、握手、截止时间、取消和重建。Firefox 特有代码仅负责 iframe 创建、查询和移除，不另写 feature handler、算法或配置。
- `offscreenDocument` 仅表示原生 API 与权限；`extensionDom` 表示共享运行时可用。Firefox 的图片、区域、本地字幕和扩展朗读可用，但 Chrome Translator 仍单独受 `chromeTranslation` 约束；Firefox MV3 尚未开放此适配。
- content 生命周期使用 WXT `ContentScriptContext` 与 `AbortSignal`，扩展失效后不得继续回写页面。

参考：[WXT Entrypoints](https://wxt.dev/guide/essentials/entrypoints)、[Content Scripts](https://wxt.dev/guide/essentials/content-scripts)、[Project Structure](https://wxt.dev/guide/essentials/project-structure)。

## 什么时候用单文件，什么时候建目录

单文件适合同时满足以下条件的能力：

- 只有一个清晰职责；
- 不跨 background/content/UI 等运行上下文；
- 没有独立协议、样式或持久化模型；
- 文件仍容易阅读和完整单测。

例如翻译缓存可以先是 `src/services/translation/cache.ts`，无需为了形式再建空的 repository/model 子目录。

出现任一情况时应建立 feature 目录：

- 同一能力跨两个以上运行上下文；
- 同时包含 domain、协议、运行时、Vue UI 或 CSS；
- 有独立持久化模型和迁移；
- 需要多个贡献者并行维护；
- 单文件已经混合多种变化原因。

禁止使用 `common.ts`、`misc.ts`、`helpers.ts` 作为新垃圾桶。通用函数应按语义进入 `shared/text`、`shared/time` 等小包。

## Feature 结构

复杂 feature 采用按需子目录，不创建空目录：

```text
src/features/vocabulary/
  domain/
    entry.ts
    reviewSchedule.ts
  application/
    vocabularyService.ts
  background/
    handlers.ts
  content/
    selectionAction.ts
  ui/
    VocabularyBook.vue
    vocabularyBook.css
  protocol.ts
  index.ts
  README.md
```

较小 feature 可以保持扁平：

```text
src/features/hover-translation/
  content.ts
  rules.ts
  hoverTranslation.css
  index.ts
```

每个 feature 通过 `public.ts`、`protocol.ts` 或明确的领域出口公开 API。内部文件可以互相 import，外部模块只能从这些公开契约导入。

## 插件契约

插件化是“编译期注册 + 运行时生命周期”，不是通用 IoC 容器。

content feature 的最小契约：

```ts
interface ContentFeatureDefinition {
  id: string
  isEnabled(): boolean
  mount(runtime: ContentFeatureRuntime): void | Promise<void>
  unmount?(): void
  isMounted?(): boolean
}
```

运行时负责：

1. 检查 feature 是否启用以及激活是否仍有效。
2. 按静态注册顺序挂载。
3. 隔离单个可选功能的失败，不让它阻断后续功能。
4. 激活失效时反向卸载，释放 DOM、listener、timer、observer 和 pending session。
5. 对异步 UI 做所有权校验，避免旧请求回写新页面。

background 使用独立的类型化 handler 契约：

```ts
interface BackgroundMessageHandler<TMessage, TResult> {
  type: TMessage['type']
  parse(value: unknown): TMessage
  handle(message: TMessage, context: BackgroundContext): Promise<TResult>
}
```

handler registry 必须静态 import。每个 feature 保存自己的 protocol 与 handler，app/background 只负责注册、分发和统一错误序列化。

## 翻译链路

目标调用链：

```text
feature
  -> translation service public API
  -> broker (凭据校验、上下文、pending 去重、缓存)
  -> provider registry
  -> provider adapter
  -> platform/http
```

约束：

- 翻译算法与 DOM 候选发现不读取 provider 配置。
- provider 不直接读 UI 状态。
- 缓存 key 必须包含会改变结果的 service、model、endpoint、语言、prompt/context 与 transport profile。
- background 与 userscript 共用同一 broker，不维护两份相似实现。
- cache 失败只能降级为未命中，不能让翻译功能整体失效。
- MV3 重启后仍需复用的数据进入 IndexedDB；仅请求内去重可以保存在内存。

### 动态页面的翻译稳定性

悬浮和全文翻译共用候选、节点状态和渲染链路。稳定性分别由手势、请求、提交和 DOM 所有权保证，不能只靠防抖延长等待时间：

- **手势有效性**：按键集合必须与当前配置精确匹配，部分释放期间不再响应移动。额外按键、选区接管、失焦或卸载取消当前悬浮手势；被取消的组合不能在下一次鼠标移动时自行恢复。
- **请求复用**：相同请求按完整调用身份去重。共享结果的等待者仍保留自己的取消和截止时间；页面路由提交代次与内容缓存代次分开，过期结果不能回写新页面。
- **提交校验**：异步返回后同时检查当前 owner、generation、候选资格及每个文本槽的原文。Text 对象相同或整段拼接原文相同都不足以证明结果有效。等价 Text 重建可以重绑，但必须同步更新恢复原文的快照，并使用当前空白前后缀。
- **DOM 所有权**：MutationObserver 根据精确目标和最后写入值识别扩展自己的事务。同值属性写入是无操作；后代的 class/style 改动不能拿祖先快照抵消。真正的原文、保护区或候选资格变化仍会失效并重新发现。
- **其他翻译器共存**：沉浸式翻译的 `immersive-translate-target-wrapper` 及其直属原文单元作为外部翻译边界；正文与全部节点范围都避免叠加译文。该边界进入来源与提交校验，后出现的外部译文会使 FluentRead 释放自身译文；移除外部译文后，活动全文会话可重新发现原文。快照省略已被接管的单元，避免净化 HTML 时去掉对方标记又复制其译文；恢复只清理 FluentRead 的工件，普通 `notranslate` 术语、代码和未翻译的相邻段落不受影响。
- **原文保全**：仅译文的轻 DOM 槽保存宿主原文。宿主克隆槽后会丢失闭合 ShadowRoot，清理必须先解包其中的原文，再删除失去所有权的容器，且不能拆掉其他活动翻译拥有的槽。
- **展示稳定性**：等价双语重挂按来源、结构和译文工件验证后接管；鼠标高亮仅改变绘制，不改变宿主布局。持续与宿主争抢 DOM 时使用已有修复预算收敛，避免无限恢复和重译。

回归需同时断言请求数、工件唯一性、原文恢复、迟到结果隔离和连续帧可见性；缓存命中导致请求数不增，仍可能发生 DOM 闪切。

## 配置与消息

配置分为三层：

- `core/config`：类型、默认值、纯 normalize/validate/migrate。
- `services/config`：latest-write-wins、历史记录、保存队列、凭据协调。
- `platform/storage`：后台专属加密 IndexedDB、旧 WXT storage/会话凭据迁移与跨上下文只读代理。

后台首次读取先检查 IndexedDB 的 `local:config` 主记录：存在时直接解密使用，完全不再读取旧
storage；只有主记录不存在时，才加载旧配置、原子写入并读回验证 IndexedDB，成功后清理旧键。
加密清理标记的检查优先于主记录，因此仅含历史或凭据的旧快照在清理中断后也只恢复既有迁移，
不会重新扫描残缺旧 storage 或删除已经成功迁入的记录。若旧快照没有主配置，标记在清理完成后
仍作为 durable authority 保留到默认主配置建立，保证并发事务检查期间不会同时缺少主记录和标记。
迁移会在同一个写事务内再次检查主记录，只允许一个完整旧快照胜出，避免并发后台把不同
快照的配置、历史和凭据逐键拼接。迁移记录和“待验证”加密清理标记同事务提交；该阶段只为
持久记录保存内容摘要，会话凭据只做 AES-GCM 认证，不在持久标记中保留普通摘要。读回成功后
先把标记改为只含实际待删键的“已验证”状态，再开始删除旧载体。清理被后台退出打断或配置随后
发生变化时，后续启动仍可按已验证键执行幂等删除，绝不重新读取或回灌旧 storage，全部删除
成功后再清除标记。

扩展页面提交整份配置时必须通过 background 的 mutation coordinator，不能在 popup、文档页或
content 上下文直接写配置记录。翻译计数使用独立增量消息；最近的 operationId 与 count
放在同一个存储记录中原子提交，但不会进入配置历史、导出文件或运行时 UI 对象。
后台保存普通配置时，公开配置、持久凭据、历史脱敏和旧会话凭据清理会先完成加密，
再通过同一个 IndexedDB 事务提交，避免后台在多条记录之间退出时留下新旧状态混合。

userscript 没有跨站点共享的原子后台，因此计数采用每个顶层文档独占的单调 GM 副本：总数等于
迁移基数加所有副本绝对值，`local:config.count` 只是可重建的显示投影。热路径只写当前副本，
启动、页面重新可见和打开设置时才聚合全部副本；经典 GM API 没有 CAS，不能在保持跨标签精确性的
同时安全自动压缩旧副本，因此不得用有竞争的读改写“优化”掉这些键。

消息必须使用版本化、可解析的 discriminated union。禁止在多个 feature 中散落同名字符串和 `any` payload。隐私或本机 bridge 协议还必须定义大小上限、TTL、URL 清洗、错误码和 stale-version 防护。

## CSS 与 Vue

- 全局颜色、间距、层级进入 `src/ui/styles/tokens.css`。
- extension page 的布局样式跟随对应 page/feature。
- content overlay 的 CSS 跟随 feature，并继续通过 Shadow DOM 或 WXT UI 工具隔离。
- 可复用无业务组件进入 `src/ui/components`；只服务一个 feature 的组件留在 feature 的 `ui/`。
- Vue 页面只负责组合和交互，不直接实现翻译、存储或消息业务规则。

## 注释规范

注释以中文为主，保留必要的协议名、标准名和用户可检索的英文错误上下文。

`src/` 下的 TypeScript、Vue、CSS 与 Markdown 文件必须从第一个字符开始提供可独立阅读的文件级长注释。注释统一写明精确的 `@file` 相对路径、`文件职责`、`主要内容` 与 `模块边界`：职责解释文件解决的问题，主要内容列出它维护的关键类型、流程或 UI，模块边界说明允许依赖和不得承担的职责。Vue/Markdown 使用 HTML 注释，TypeScript/CSS 使用 TSDoc 风格块注释；职责发生变化时必须同步维护，禁止复制不含文件语义的占位模板。

非平凡的编排函数使用有意义的 step 注释：

```ts
async function runTranslation(): Promise<Result> {
  // Step 1: 校验输入并创建本次请求的所有权标识。
  // Step 2: 读取缓存；命中时直接返回。
  // Step 3: 调用 provider，并在仍持有所有权时提交结果。
}
```

不为一行 getter、显然的类型守卫或简单映射机械添加 Step 1。注释解释“为什么、边界和所有权”，不复述语法。导出的公共契约需要 TSDoc；临时兼容导出必须标注 `@deprecated` 与新路径。

## 测试契约

测试分为四层：

1. **unit**：纯函数、状态机、parser、cache identity、feature registry、provider request builder。
2. **functional**：多个真实模块协作，但替换网络、浏览器或时间边界。
3. **regression**：每个历史 bug 至少一个最小复现，名称说明过去的失败条件。
4. **browser**：隔离的真实 Edge/Firefox 验证 manifest、WXT 生命周期、DOM、Shadow UI、快捷键与跨页面行为。

覆盖率采用两部分且都必须达到 100%：

- **可执行代码覆盖**：纳入测试边界的 TypeScript 业务代码在 statements、branches、functions、lines 四个维度均为 100%。
- **仓库验证归属覆盖**：每个被排除于 V8 覆盖率的 entrypoint、Vue、CSS、HTML、兼容 shim 或浏览器脚本，都必须在清单中拥有构建、组件测试、静态契约或真实浏览器测试，不能存在未分类文件。

不允许通过新增 `v8 ignore`、排除难测业务代码或无断言执行制造 100%。应先把 entrypoint/Vue 中的业务逻辑抽到可测模块，再扩大严格覆盖范围。

测试命令目标：

```text
pnpm test:unit                 # 精准单测
pnpm test:functional           # 功能测试
pnpm test:regression           # 历史回归
pnpm test:coverage             # 四维 100% 门槛
pnpm test:regression:all       # 一键确定性流水线：静态检查、测试、构建与文档
pnpm test:regression:all -- --browser  # 追加屏幕外隔离浏览器 fixtures
```

自动测试审计检查矩阵漏项/重复归类、重复 suite/case 名、`.only`、无说明的 `.skip` 和 coverage ignore pragma。mock 是否停留在外部边界、静态源码契约是否需要补行为测试，继续由 code review 与 verification ownership 审计共同负责。

## 迁移顺序

- [x] 建立重构前测试、TypeScript 与 Chrome MV3 构建基线。
- [x] 固化目标目录、依赖方向、WXT 与插件契约。
- [x] 建立架构 fitness tests、覆盖率边界清单和一键测试入口。
- [x] 合并 background/userscript 的翻译 broker 与缓存实现。
- [x] 拆分 background typed message router。
- [x] 拆分 content feature composition root。
- [x] 迁移配置、provider、platform 与 shared。
- [x] 迁移全文、悬浮、划词、输入框、单词本、文档、图片、区域和视频 feature。
- [x] 拆分 WXT 页面 composition、主要 Vue 页面和 feature CSS。
- [x] 全量单测/功能/回归、Chrome/Firefox/userscript 构建、文档构建。
- [x] 在屏幕外隔离 Edge 完成六组确定性 fixture 功能验收。
- [ ] 真实 Firefox 与真实网络站点矩阵作为独立后续门禁，不由本轮 Edge fixture 替代。
- [ ] 下游调用迁移完成后删除兼容导出；当前兼容集合由架构测试精确锁定。
- [x] 完成本轮逐条需求审计。

## 变更规则

## 阅读助手 Harness 核心

阅读助手采用浏览器内的有界 ledger 和独立工具循环，参考 DeepSeek Harness `dsh-v0.1.3-alpha.1`（commit `d347e703908d0406b7a7ef80e3a0e594d86b2215`）的 `packages/core/session/src/surface.ts` 消息投影思想。FluentRead 只保留选区、已授权段落、追问历史和只读 `read_context` 工具，不引入上游桌面 host、bridge、Cordis、插件、文件系统、进程、沙箱或动态执行能力；模型仍由现有 AI SDK gateway 选择。兼容模型与原生 Anthropic/Google 模型均通过各自协议接入，不能假设任意模型都支持工具调用或流式输出。

阅读卡通过 `fluentReadHarnessStream` port 接收模型、正文和会话进度，正文按模型返回的增量快照更新；停止、错误、关闭、换选区和 worker 中断会取消当前请求，已收到正文仍保留在卡片中。普通模式的会话按问答保存在本机 30 天，历史可从阅读卡或设置页折叠查看、恢复、删除和清空；恢复只加载已有 turns，不自动发起模型请求，后台重建上下文时最多使用最近四轮。隐私窗口不保存也不读取历史。

每个迁移批次必须：

1. 保持旧公开行为，或在同一批次更新产品文档。
2. 增加或迁移对应单测，历史 bug 保留回归用例。
3. 运行目标模块测试、`pnpm compile`、`git diff --check`。
4. 涉及入口、manifest、offscreen 或样式时运行对应浏览器构建。
5. 不在同一批次混入无关功能改动。
6. 在 PR 描述中列出迁移前后路径、兼容层、验证证据与剩余阶段。
