# Google 翻译快速换线与批量优化

核对日期：2026-10-05（Asia/Shanghai）。基础为 `origin/main`，提交 `f94225c333c8d17c69de06574860ea202c674c94`。

## 发现与实现

原适配器先尝试两个网页 RPC，再尝试 `translate_a/single`，每个入口最多等待 8 秒。只对 RPC 的 XSRF 拒绝冷却，其他故障可能在后续段落反复出现；客户端还可能按全局配置重跑整条回退链。全文富文本槽没有使用 Google 原生批量能力。

现在按 `translateHtml` → `translate_a/t` → 主 RPC → 英国区域 RPC 换线。明确失败立即继续；单入口最多 2 秒，整批共用 8 秒。谷歌与免费聚合一样免除外层重复重试。常规故障从 30 秒开始指数冷却，最多 5 分钟；403、429、XSRF 拒绝冷却 5 分钟。到期只允许一个恢复探测。400、413、415、422 等请求特有错误不会淘汰健康入口；取消也不计作故障。较早的在途成功不能覆盖后来观察到的失败。

同语言请求在 10 毫秒窗口内合批，每包最多 32 条、通常不超过 4,000 个转义后的字符；超长单条保留为独立请求，不在适配层拆分语言上下文。回退入口也支持多条，RPC 按编号还原乱序响应。数量、类型、非空译文和编号必须有效，否则整批换线，不把错误结果填入其他段落。HTML 入口转义纯文本，用 `pre` 保留换行，并只解码一次实体。一个调用者取消不影响共用请求的其他调用者；全部离开后才终止网络。

## 最新参考版本

工作区原有参考仓库保持只读。通过独立临时快照检查最新远程分支，没有复制成段源码或添加跨仓库依赖；在 FluentRead 的 Vue/WXT/TypeScript 边界内独立实现。

| 项目 | 分支与提交 | 相关做法 |
| --- | --- | --- |
| [陪读蛙](https://github.com/mengxi-ream/read-frog/blob/b9a081fdafd2079821139d80fa7b446ad63ba641/src/utils/host/translate/api/google.ts) | main，`b9a081f` | `translateHtml`、浏览器协议标识、纯文本转义和换行保护 |
| [简约翻译](https://github.com/fishjar/kiss-translator/blob/d330c9b82d921160cd5a9ad096c8301cd4c9816c/src/apis/trans.js) | master，`d330c9b`；默认 dev，`7053689` | Google2 使用原生文本数组批量，另保留旧接口选择 |
| [沉浸式翻译](https://github.com/immersive-translate/immersive-translate/tree/c470f0aca3c75b2785c9009a0ac48e78ead34126) | main，`c470f0a` | 当前源码不公开；只读核对公开 1.33.3 发布产物中的 `translate_a/t`、可选浏览器 API 和批量路径，不把产物当成开源源码 |
| [TWP](https://github.com/FilipePS/Traduzir-paginas-web/blob/50a92116542ab93524594cc210f4bf4e5d86a925/src/background/translationService.js) | 默认 master，`50a9211` | `translateHtml`、转义、`pre` 保留排版、多文本响应还原 |

公开浏览器协议标识与用户 Google Cloud API Key 分离，不读取、记录或覆盖用户凭据，也不提供官方云 API 的配额或可用性承诺。

## 接口实测与清理

对三句公开合成英文分别请求，检查实际中文译文，而不只检查 HTTP 200。

| 入口 | 三次结果 | 处理 |
| --- | --- | --- |
| 主网页 RPC | 3/3 成功，约 1.09–2.95 秒 | 保留批量回退 |
| 英国区域 RPC | 3/3 成功，约 1.43–2.61 秒 | 保留最后回退 |
| `translate_a/single` | 0/3，均 HTTP 429 | 移除候选与解析代码 |
| `translateHtml` | 3/3 成功，约 1.13–1.69 秒 | 优先使用，并实测多条、换行和字面 HTML |
| `translate_a/t` | 3/3 成功 | 保留原生批量回退，并实测两条数组 |

零成功是本轮网络环境的观测，不代表 `single` 在全球永久失效。保留入口也不保证所有地区、语言或以后的时间都可用。2 秒等待是快速换线的取舍：慢于阈值的可用入口也会暂时跳过。

## 验证

定向覆盖 Google 批量与安全错误、取消所有权、冷却恢复、乱序/缺槽、总预算、客户端单条/批量/视频不重复重试，以及全文语言跳过、会话缓存、动态文本、标题和可见性调度。供应商/模块边界与文件头检查通过；测试审计、类型检查、Chrome/Firefox/userscript 构建、userscript verifier 和文档构建通过。未运行全量回归。

userscript 初次构建被基础分支已有的语言资源缺失阻断；只在任务 worktree 临时生成后完成验证，不把无关资源纳入补丁。Firefox 只做构建验证，未验证真实 Firefox 请求。

真实生产扩展在临时 Edge 配置中通过 DOM 断言验证悬浮 `[1,0,1]`、全文 `[6,0,6]`、原文恢复、相邻段落不受悬浮操作影响及 URL 不变。服务为 `google`，英文到简体中文；6 段首次全文约 313 毫秒，再次约 1,025 毫秒。网络记录包括 6 条合为一次的真实 `translateHtml` 请求。

注入主接口 HTTP 503 后，备用请求约 0.5 毫秒内发出；第一段取得真实备用译文约 1,156 毫秒，下一段跳过主接口，约 273 毫秒完成。无响应的单入口 2 秒与四入口总预算由确定性测试覆盖。这些时间仅说明本机网络与合成短文本的结果，不是对大网页、国内直连或 Chrome 自带翻译的速度保证。

浏览器保护证据：`launchMode=macos-background-cdp`、`focusPolicy=launchservices-no-foreground`、`windowPlacement.mode=background-visible-no-focus`、`browserFrontmost=false`，正常尺寸窗口完整位于第二屏；未连接用户日常配置。临时浏览器和配置已清理。

- [DOM、网络与延迟证据](./browser-report.json)
- [真实译文截图](./final-live-translation.png)
