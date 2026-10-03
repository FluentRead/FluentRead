# 漫画滚动修复验证记录

对应[漫画滚动稳定性与返页性能报告](../../maintainers/manga-scroll-stability-20261004)。初始验证基线为主分支 `6b110414` 加 PR #779 的已测试 head `85efb8688b334641b12abbc05f30a7adaba77faa`；交付前再整合主分支 `b03c75bb`。三个漫画运行时文件哈希保持一致；仅在隔离 worktree 修改，未修改参考项目。

## 针对性测试与构建

| 检查 | 实际范围与结果 |
| --- | --- |
| 内容运行时与阅读会话 | `imageTranslationRuntime` 141、`mangaReader` 38、`mangaEntry` 13、`mangaInpainting` 7，共 199 项通过 |
| 宿主与恢复边界 | `imageTranslationClientRecovery` 11、`imageTranslationPresentation` 10、`imageTranslationSecurityContract` 6，共 27 项通过 |
| 整合主分支后的针对性回归 | 上述七个文件加图片翻译流程、WASM 日志、语言资源加载与修改到的配置比较/备份标签链路，共 14 个文件、354 项通过 |
| 严格核心覆盖 | `mangaReader.ts`、`mangaSession.ts` statements / branches / functions / lines 各 100%，38 项通过；不是整个运行时全覆盖 |
| 测试归类审计 | `pnpm test:audit` 通过；未运行全量回归 |
| 类型检查 | `pnpm compile` 通过 |
| 扩展 | Chrome MV3、Firefox MV2 构建通过，manifest verifier 通过；Firefox 未运行真实浏览器测试 |
| Userscript | 生成合入分支后的五份语言快照并锁定不可变资源提交 `15314b25a58c043232044805a717da88a20d0ddb`；构建及 verifier 通过；不包含漫画本地模型运行能力 |
| 文档 | 中英文指南与报告构建、链接检查通过 |

初始两个缺陷用例在修复前失败，修复后通过。初次为七个文件、226 项本地测试，整合主分支后为 14 个文件、354 项，加 26 项浏览器专项。未降低阈值、屏蔽真实错误或把已有架构检查的历史结果当作本次全绿。

可重复的本地测试入口：

```sh
pnpm test tests/mangaReader.test.ts tests/imageTranslationRuntime.test.ts tests/mangaEntry.test.ts tests/mangaInpainting.test.ts
pnpm test tests/imageTranslationPresentation.test.ts tests/imageTranslationClientRecovery.test.ts tests/imageTranslationSecurityContract.test.ts
pnpm test:coverage tests/mangaReader.test.ts --coverage.include=src/features/image-translation/content/mangaReader.ts --coverage.include=src/features/image-translation/content/mangaSession.ts
pnpm test:audit
pnpm compile
```

## 浏览器对照

| 样本 | 专项 | 返页样本数 | 最小–最大 | 中位数 | 首次当前页 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 受控阅读器 | 9 | 10 | 2.2–16.4 ms | 13.0 ms | 3.041 s |
| MANGA Plus 1024050 | 5 | 8 | 0.9–16.9 ms | 11.9 ms | 13.385 s |
| Pixiv 150354216 | 5 | 8 | 7.4–24.5 ms | 17.2 ms | 32.193 s |
| 默认提前三张受控样本 | 7 | 另按准备窗口测量 | 当前加三张共四次识别 | 后续未进入窗口的图片不处理 | 当前完成即显示 |

修复前 #779 生产构建的相同受控用例失败：第二张文字服务挂起期间返回第一张，连续 90 帧不能恢复译图。修复后，六次快速往返不增加识别请求；关闭缓存时最近前页仍保留。首张未完成即滚到第二张，第一张不因离屏取消，重型处理仍串行，第一张结果在离屏完成后可立即复用。

MANGA Plus 首次站点加载替换占位来源，最初记录两个任务；第一张最终显示后，下一张新增一次，共三次。Pixiv 首张和第二张共两次，第二张无识别文字时保持原图。往返后的计数均不增加。暂停核对网站当时的资源、srcset、sizes 及原始样式，允许宿主正常完成加载，不要求恢复已经失效的占位地址。

26 项最终专项使用真实生产扩展和本地 PaddleOCR / LaMa；实页使用在线 Google，受控样本只延迟 Google 文字传输。模型已校验导入，两个下载来源阻断期间下载请求为 0；所有最终样本的页面异常和 FluentRead console error 为 0。CPU vendor=0 的已知 WASM 提示仅为 `debug`，未知告警和错误保留。屏幕中的站点自身提示不属于扩展弹窗。

实测是单设备、单次冷启动及少量返页样本，时间不包含模型下载；不代表所有设备、国家或站点的延迟保证，也不能证明模型吞吐或翻译质量提升。五阶段返页、标签页隐藏和错误分支另由针对性测试验证。

## 可重复浏览器入口与证据

使用 `scripts/testing/run-manga-translation-test.cjs`，提供当前环境的 Node/Playwright、`fluentread-browser-translation-test` 的 focus-safe helper 和完整校验的模型目录；不要使用日常 profile。

- `--scroll-stability --prefetch-pages 0`：受控在途、返页、暂停、来源与路由交接。
- 另加 `--live-site --live-translation --site-url <用户提供的章节链接>`：实际 MANGA Plus 或 Pixiv。
- `--prefetch-pages 3`：只运行默认提前三张专项。
- 上述运行均加 `--preload-models-dir <校验后的文件目录> --blocked-all-model-sources`。

所有运行确认 `macos-background-cdp`、`launchservices-no-foreground`、`background-visible-no-focus`、`browserFrontmost=false`，结束后临时 profile 已删除。最终证据在工作区 `artifacts/manga-scroll-stability-20261004/fixture-verified`、`mangaplus-verified`、`pixiv-verified`、`prefetch-final-verified`。`baseline-779` 保存修复前预期失败；其他早期失败来自测试对占位加载和资源快照的假设，最终断言核对网站当前资源。

浏览器测量对应的生产运行时源码 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `mangaReader.ts` | `94e295e0d81117ba566e5d26d1e922803988e0d89cd1392108669b43ce314fb3` |
| `mangaSession.ts` | `4231a3d42db4b2818f470c6769afd92d56844d42edca828161003d62cb53eafa` |
| `runtime.ts` | `b73c3cb54b910b3c37c07f31197faa1283ef40fa919e5426c3c8c73fb29a0389` |
