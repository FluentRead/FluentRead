## 2026-10-10 最终浏览器验收

标准版与 standalone 的最终 IIFE 浏览器验收均已通过。本次只补充文档证据，未修改生产代码、重新构建或更改 PR 元数据。

已验收源码合并提交：`72ff27e10603cc14c13db8690dcc03835ca42c79`；合入的 main：`f1af6300b240ce65d00d36dec37ab50742197044`。沿用该源码的既有最终产物，磁盘与真实浏览器读取脚本的执行前后 SHA256 一致，IIFE 未被重写。

真实浏览器为 Neo `browserclaw/v0.51.0`，报告版本 `Chrome/155.0.8309.26`。验收使用用户授权的隔离临时 profile、认证私有显示会话与私有 D-Bus；桌面用户会话保持不变。CPU target 60%、worker 1、concurrency 1，重命令串行。

| 成品 | 字节 | SHA256 |
| --- | ---: | --- |
| 标准版 | 1,957,253 | `4bb464d4440449b68170cb9ee897bdbcc0a0da560715f0ba767b1f2cb86d66fd` |
| standalone | 3,591,507 | `500520a34202b9611ff5c77252971e2da071714fde961f8e026edc1551efae62` |

保留 main 原有预算：标准版 1,965,000 字节，余量 7,747 字节；standalone 3,600,000 字节，余量 8,493 字节。本次没有放宽预算。

| 实机检查 | 标准版 | standalone |
| --- | --- | --- |
| 最终 IIFE 初始化 | 通过，A4 新运行 | 通过，A5 新运行 |
| 设置界面 | 基础面板保存、关闭重开通过 | 完整 Options 翻译/通用导航、关闭重开通过 |
| MD5 / SHA256 固定输入与 require 缓存 identity | 6 项通过；A3 实测，A4 复用 | 6 项通过；A5 新运行 |
| 生产 gzip / 原生 typed-offset / 错误合约 | 8 / 24 / 5 通过；A4 新运行 | 8 / 24 / 5 通过；A5 新运行 |

标准版六项 CJS 是本次授权创建的真实 Neo 会话 A3 中执行，原始结果写于 **2026-10-10 14:13:13.712876 UTC**。输入为空串、`abc`、`FluentRead 中文🙂`，分别检查 MD5 和 SHA256；原始工厂来自最终 IIFE 自然调用处的词法作用域。A4 核对同一产物 SHA256 和原始证据哈希后仅复用这六项，没有重复调用；A4 的初始化、设置和 gzip 均新运行。

gzip 检查使用最终 IIFE 的原始生产函数引用，每版八个独立压缩输入覆盖 base64 路径、原生 Uint8Array byteOffset 0/3/17、UTF-8 与后端原始字节 SHA256，以及输入和 padding 未改动。五个错误合约覆盖错误 header、CRC、空输入、截断 header 和 footer。仅在合成页面中令 DecompressionStream 为 undefined 以覆盖 fallback；标准版六份固定依赖由本地夹具提供，standalone 无外部依赖。

标准版设置保存仅修改合成内存 GM store 的缓存选项，关闭重开后值保持；翻译与自动翻译始终关闭。最终两会话记录的页面外部请求尝试/放行、GM 网络请求、页面异常、控制台错误和模型 API 调用均为 0。网络计数限记录页面与 GM 夹具范围，不作为整个浏览器后台或整机网络测量。

匿名尝试 A1/A2 因 harness 未适配 Neo 展平 argv 的严格归属检查失败，尚未连接页面；A3 完成真实初始化与六项 CJS 后，因误用完整 Options 选择器等待标准基础面板而超时；修正仅涉及本地 harness。最终 A4 标准版、A5 standalone 通过。五次尝试的已知自有存活非 Z 进程、监听端口和私有显示 socket 均已清理，夹具服务器均关闭。临时 profile **保留在本地作证据，未删除**；未使用或控制个人/Recovery profile。

[机器可读脱敏回执](browser-acceptance-20261010.json) 记录匿名 A1–A5 的 UTC 时间、结果、各阶段原始证据 SHA256、原始日志 SHA256及清理结果。原始本地日志、完整回执与个人环境信息不上传。

范围限上述 userscript IIFE、设置、CJS 与 gzip 合约；未执行扩展无痕路由、RTX5090 WebGPU 或原生 Wayland/Cua 部署。本次未新增安全权限、服务或浏览器扩展。

此前所选测试为 187 项通过、1 项失败；失败是视频设置要求包含“CPU 和内存”的既有文案断言，在相同 main 上也复现。类型检查、测试审计及两版原始构建和验证器已通过，本次未重跑。

下方原报告记录合入 main 前的历史提交，彼时 #912 head 为 `dd2d2e210275e952cb3af9c07640b5878d92c8af`；旧成品数值与旧测试结果不代表本次最终浏览器验收。历史正文保持原字节内容。

---

# #912 精简验证说明

基线 upstream/main `175c59514b9ce4242b34b9f6bed1ac6a2ceb3545`。原性能移植源码为 `a9193cb40e809664b3f84ca3204876538e625cfa`；本次追加最小预算修正与两处受影响测试，#912 保持 draft。PR 只保留必要源码/测试、本说明和一份小型核验收据，详细报告不重新加入。

完整历史源码审查、三出口模块图与原始构建/测试证据固定保留于 [19f2ac4f](https://github.com/ArietidsZ/FluentRead/tree/19f2ac4ffe587868ef2f73c52b3cdea32941920f/docs/reports/userscript-performance-clean-main-20261009)。报告精简采用普通后续提交，未重写历史或改其他分支；旧3,589,291字节仅是18e→9b的历史测量。

## 最终产物与最小修正

删除 `userscript/unsupportedCapabilities.ts` 的两个无消费者 UI re-export：`ImageOcrSettings`、`MangaSettings`。全部 runtime/state stubs、VIDEO_* 导出、alias 和扩展原 public.ts 两项 UI 导出保持不变，组件、CSS、资源和许可源文件没有删除。仅 standard userscript 出口配置 `strictRequires:true`；standalone、GF 和扩展不改变此策略，没有模块名单、全局 side-effects 关闭、预算增加或可执行源码压缩。

| 出口 | main / 修正前性能候选 | 最终候选 UTF-8 字节 | 原门禁结果 |
| --- | ---: | ---: | --- |
| standard | 1,963,967 / 1,964,011 | **1,957,868** | 原1,964,000预算通过，余6,132 |
| standalone | main缺少既有别名导出 / 3,595,173 | **3,590,688** | 原3,600,000预算通过，余9,312 |
| GF | 2,336,321 / 2,336,321 | 2,335,647 | 原正式脚本固定data检查停止，verifier未启动 |

standard SHA256 `5ed2858fca0faf87eb9469bfb1073a7f5081c6aa49affdfb22f8588dec08676f`；standalone `19afc0bc9260e07de9f9318a3088ef3713277bbd6f55c78b103a34747f62e3a5`。两出口原CLI构建的SHA与只读模块图观察构建一致，原verifier均通过。

最小消融保留实际原文件：修正前auto为1,964,011，修正前strict=true为1,964,355；只删re-export为1,957,524；删除并采用standard strict=true为1,957,868。确定性策略下删除死链实际减少 **6,487字节**，当前包装开销 **344字节**，净减6,143字节。三出口的loaded/entry图中两项专属CSS及 `mangaOcrAssets` 均消失；共享OCR语言契约自然保留，standalone完整设置及LocalTts仍在图中。standard解压CSS为166,821→136,867字节；此值是CSS数据大小，不作为最终压缩收益。

## 机制、契约与范围

此前44字节最终JS归因仍为：MD5初始化+10、AES调用+2、互操作绑定+28、局部标识符宽度+4。实际同源CryptoJS小图复现auto加载顺序竞态，两侧MD5与固定盐AES输出相同；strict=true两种顺序SHA一致。renderedLength不作为最终字节收益，也不据此宣称性能源码存在语义回归。[官方26.0.1说明](https://raw.githubusercontent.com/rollup/plugins/commonjs-v26.0.1/packages/commonjs/README.md)记录该auto混合require竞态。

本次类型、测试归类及42次实际根组件合成导航通过；受影响契约测试 **54/55通过**。唯一免费池顺序断言在固定main单项重放同样失败（期望仅sogou，实际含bilibili与sogou），没有扩大修复。既有“CPU 和内存”文案基线失败仍保留。未重跑不变的完整套件或扩展构建；原Chrome/Firefox证据属于此前源码验证。

GF原正式脚本在第79行固定data检查停止，verifier未启动，其预算、可读性、URL、UI、Dexie和许可断言均未执行。当前GF主文件SHA `6cd6a5da32c6745da726418eb138ebe02c88eaed0f1f68b7b0a5b7ec1fe8dbf3`；新生成data为868,136字节、SHA `85be944ad2d1f97ae94badf3a8e8f77e282beaf1f217ed472ef2e73050ae0981`，不等于已提交固定资源。静态大小比较2,335,647仍大于原2,000,000预算，但未称其为已执行的verifier结果。未prepare/提交资源、刷新URL或许可，GF问题独立保留。

## 浏览器验收阻塞与本地证据

18份历史Neo会话均已清理。本次获批改用新建专用CW隔离会话，已准备只追踪自身spawn PID/startTicks及子进程的独立启动器，不使用全局/proc、桌面/端口盘点或Recovery。Neo二进制SHA与既有核验记录一致；最终standalone八份生产gzip已重新捕获，七份非CSS字符串不变。

**自动审批审查在执行命令前拒绝新建 Neo/Xvfb/私有D-Bus**。补充原用户授权、明确撤销旧reuse-only范围后，完全相同的工具调用仅重试一次，仍被拒绝，理由继续引用“只复用活动会话、禁止新建Neo/Xvfb/D-Bus”。按指令停止，未进一步重试，没有进程创建、socket连接或权限变更。原样最终standalone IIFE的真实浏览器ungzip、24组typed offset输入及5项异常契约均未执行；原样standard最终IIFE的实际初始化、基本设置和必要CJS固定输入smoke同样未执行。配置单测、CryptoJS小图和Node/静态核验均不证明两个最终IIFE的浏览器运行通过。

详细证据保存在CW工作区 `userscript-performance-clean-pr-20261009/minimal-followup/final-budget-candidate/`：`FINAL-ARTIFACT-INPUTS.json`、三出口`final-*-result.json`/`*-graph.json`、`contracts.json`、`baseline-free-settings.json`、`BROWSER-CREATION-BLOCKED.json`。上层保留字节归因与竞态诊断，命令/退出码在`STAGES.json`及独立`followup-final-*`日志。串行CPU目标60%、单worker；无新依赖、扩展、凭据、模型或搜索API调用。standard预算已通过；真实浏览器IIFE验收与独立GF问题仍阻塞合并。

最新源码/产物SHA、消融数字、阶段退出码及原日志SHA、54/55与main个案失败、浏览器未执行及两次拒绝证据SHA见 [机器可读核验收据](./verification-receipt.json)。收据绑定源码提交 `64108a3a1078a3d42432f2dc301bd36abff0f263`；后续仅添加证据，不重跑构建或测试。浏览器没有运行日志，以审批拒绝记录SHA单独标识，不虚构退出码。
