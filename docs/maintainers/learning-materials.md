# 学习材料集成契约

材料是学习记录的本地来源索引。收藏、问答和长期学习笔记继续由原仓库拥有；材料通过标识引用它们，不复制回答正文。只有明确在材料里写下的个人笔记由材料仓库保存。缺少可信来源的旧问答和笔记仍在原栏目中管理，不按标题或相同文字猜测归属。

## 公共入口

| 入口 | 使用场景 |
| --- | --- |
| `src/features/vocabulary/material/protocol.ts` | 纯类型 `MaterialSelection`，可供阅读请求类型引用，不加载浏览器或 UI |
| `src/features/vocabulary/material/public.ts` | 选区来源、继续阅读链接、采集开始与完成、材料客户端 |
| `src/features/vocabulary/material/content/public.ts` | 内容组合根挂载与卸载网页恢复、播放时间和阅读位置监听 |
| `src/features/video-subtitle/content/public.ts` | 识别具体媒体来源；不引入字幕学习面板或播放器生命周期 |

不要把内容运行时重新导出到纯类型入口；这会让阅读类型、视频学习面板和内容挂载形成循环。

## 来源与定位

文章保留语义查询与 SPA 路由，剥离已知追踪参数。YouTube 使用视频 ID，X 使用帖子与明确的媒体编号。本地文档使用原始文件字节的内容指纹，不能用文件名、临时 task ID 或 PDF 渲染 ID。来源迁移是用户显式操作，保留旧身份别名；旧来源的新采集不会把主来源改回旧地址。新地址已归属另一材料时拒绝隐式合并。

网页链接只携带本地材料标识，不携带原句。后台核对来源后读取本地定位；内容脚本再唯一匹配原句与上下文，或核对实际媒体。X 时间线允许官方 X/Twitter 页面采集同平台具体视频来源，但定位时仍核对当前媒体，不能按 DOM 顺序猜测多视频。通用播放器只允许同一材料页面里的唯一媒体。

当前标签页的 session marker 只含本地标识和规范地址，用于刷新后重新向后台核对，不含原句、笔记或回答。页面离开、停用、SPA 路由改变和卸载都必须淘汰旧响应、观察器与计时器。

文档阅读区提供以下元数据；选择采集与显式加入材料应使用同一套合同：

- `data-fluentread-material-fingerprint`：原文件内容指纹。
- `data-fluentread-material-title`、`data-fluentread-material-source`：标题及可用远程来源。
- `data-fluentread-material-page`：组合根当前页；PDF 选区优先读取真实文字层的 `data-pdf-page-number` / `data-pdf-reading-page`。
- `data-fluentread-material-section`：`docx:<part index>` 或 `epub:<chapter index>`。

文档恢复复用已有 history 和导入流程；文件记录缺失时保留待恢复材料，重新选择后先核对指纹。`PdfReader.resumePage` 是定位适配端口，文档组合根不应修改其布局或导出逻辑。该组件按需加载独立 chunk，必须等公开引用就绪后才消费待恢复材料；普通 `nextTick` 不代表组件已经加载。

## 并发与隐私

采集开始时冻结来源、定位和 `capturedAt`，异步准备之前取得存储 generation。清空在同一事务内推进 generation，旧采集、旧文件读取与旧导入不可复活清空的数据。位置写入只更新已经存在且未归档的材料，较旧位置不能覆盖较新位置。

编辑已有个人笔记必须传 `referenceMode: 'update-existing'`。仓库原子检查引用仍然存在，并用笔记的 `updatedAt` 拒绝旧编辑。不要通过删除单条笔记推进全库 generation，否则会误丢仍有效的异步问答关联。

材料工作区保存标题、主题或个人笔记时冻结提交草稿。保存尚未完成就返回材料列表，或返回记录的归档状态导致详情关闭时，保存成功只清理同一材料中与提交快照相同的草稿，重新进入不会把已保存内容再次当成未保存输入；失败仍保留草稿，较新的输入也不能被旧保存完成事件清掉。

材料库独立于配置，不进入默认配置同步。`memoryEnabled` 控制 AI 参考笔记，不能阻断用户主动保存笔记的材料关联。无痕读写均拒绝。独立私密备份 `fluentread-learning-materials` 包含来源、原句、组织和个人笔记，不能冒充普通配置备份；导入必须校验、报告计数并保留清空前的操作 guard。

## 本地化与测试端口

材料界面文案、来源恢复提示和私密备份反馈使用集中资源；六种非中文界面（en-US、ja-JP、ko-KR、fr-FR、ru-RU、es-ES）各有 134 条静态映射，并共用六类保留真实数量、页码、时间与导入计数的动态模板。用户标题、原句、回答和个人笔记不能按关键词或数字被这些界面模板改写。

内容脚本直接创建的原生通知不经过 Vue 模板，必须在创建通知文字与关闭按钮时应用当前界面语言，不能只补词典或依赖 Vue 本地化。界面标签与用户正文必须分别标记；不能把原文旁的页码、来源状态或默认问答标题放进 `data-i18n-ignore`。英文生产专项检查界面翻译，同时保留恰好与词典键相同的用户标题、原句和笔记。

实际组件 setup 夹具必须跟随公共入口演进：文档组合根的 `./index` 应接到同一 app 依赖端口，阅读面板的材料依赖应走 `material/public`。材料采集 fixture 使用真实公开的 begin/complete/client，只控制 runtime 传输；保存成功且取得权威记录 ID 后才关联，失败不得产生引用，来源元数据不得进入模型请求。不要通过空函数端口、删除原行为断言或跳过失败掩盖接入错误。

材料工作区目前依赖扩展后台；其新增文案通过构建期投影从 userscript 的远程词典中排除，保持已发布资源。确需更新脚本可用功能的文案时，先生成并提交内容寻址的语言文件，再将 `userscriptLanguageResourceCommit` 固定到已推送且确实包含这些文件的提交。`userscriptViteConfig` 必须比较固定提交与本地文件的完整字节；旧 Greasy Fork 文案投影仍使用其原有资源对照。构建产物通过 verifier 不足以证明远程引用存在，须另核对固定地址。

## 验证

日常只运行直接受影响的专项：`materialRepository`、`materialClient`、`materialSource`、`materialWorkspaceLifecycle`、`learningCenterLifecycle`、文档与视频对应组件用例及架构边界。材料及本次影响的组合根、本地化共十六个严格责任模块，statements、branches、functions、lines 均以 100% 为门槛。新增责任模块同时登记覆盖率 include 与测试矩阵，受影响范围以 `run-affected-tests.mjs --plan-only` 为准。生产视觉与跨页面行为由 `scripts/testing/run-material-workspace-test.cjs` 使用隔离 Edge 验证。

生产脚本需要 Playwright、现有 `pdf-lib`、`jszip` 和本机 ffmpeg。它生成受控网页、MP4、PDF、DOCX 与 EPUB，不代表真实供应商、YouTube/X 实站、Firefox 运行时、Safari 或移动真机验收。实际结果与未覆盖项以同一提交的验收报告为准。

生产 runner 提供默认完整范围、`--documents-only true`、`--sources-only true` 与 `--localization-only true` 四个独立执行范围。来源范围检查文章、视频、界面和原学习记录；文档范围检查 PDF、DOCX、EPUB；本地化范围检查英文界面、原文保护、原生恢复通知及窄屏文档入口。报告分别记录各次实际源码和产物，不能把不同批次的用例数相加。

本次专项结果与可重跑命令见[2026-10-15 验收报告](../reports/learning-materials-20261015.md)。
