# 免密钥翻译接口与自动降级

核对日期：2026-09-08。免费翻译继续提供四路默认后备，另增加可选的 Apertium，以及可连接自建免费实例的独立 LibreTranslate 服务。已有排序和停用设置保持不变。

## 可直接使用的四路后备

默认顺序为**微软 → DeepLX → 谷歌 → MyMemory**，四路都不要求填写密钥。

| 后备服务 | 接口性质 | 使用方式 |
| --- | --- | --- |
| 微软翻译 | Edge 网页内部接口，不是正式公开翻译 API | 保留已有免密钥调用方式 |
| DeepLX | 非官方公共接口 | 免费链固定使用默认公共匿名地址，不继承单独 DeepLX 服务的地址、代理或 Token |
| 谷歌翻译 | Google 网页接口，不是 Google Cloud Translation 官方 API | 保留已有免密钥调用方式 |
| MyMemory | 官方公开查询 API | 无需注册、密钥或邮箱即可调用 |

前三路的可调用性不等同于官方 API 额度或可用性承诺，可以在设置中停用。如果只想使用官方公开且免密钥的接口，可以只保留 MyMemory。

## MyMemory 官方匿名接口

匿名每天可查询 **5,000 字符**。联系邮箱是可选项，留空也能使用；自愿提供有效联系邮箱后，官方限额为每天 **50,000 字符**。[官方使用限制](https://mymemory.translated.net/doc/usagelimits.php)

公开查询使用 `GET https://api.mymemory.translated.net/get`。必填参数为 `q` 和 `langpair=源语言|目标语言`，公开查询不要求 `key`。单次 `q` 最多 **500 UTF-8 字节**，不是 500 个中文字符。[官方接口规范](https://mymemory.translated.net/doc/spec.php)

FluentRead 保留换行和分段边缘空白，优先在空白或标点处分割超长文本，并保护全文翻译的内部文本槽标记。自动源语言使用本地保守检测；短英文单词、无法区分的共享汉字等不确定输入会跳过 MyMemory，继续尝试后面的服务，也可以手动选择源语言。

如果填写邮箱，它会作为 `de` 参数随请求发送给 MyMemory。FluentRead 只调用 `get` 查询，不调用 `set` 或导入接口，不上传翻译贡献，也不会自动购买额度。邮箱输入是本地草稿，完成有效地址后才保存，逐字输入不会被配置校验清空。

2026-09-05 曾用通用示例 `Hello world.` 和 `en|zh-CN` 对官方端点进行一次真实匿名请求，收到 HTTP 200、`responseStatus: 200`、`quotaFinished: false` 与译文“你好世界”。这是一次可用性证据，不代表所有地区和以后时间都可用；未发送用户网页内容或真实凭据。

## 新增 Apertium（按需启用）

在服务目录中选择 **Apertium** 可直接使用，也可以在免费翻译的候选列表中开启并排序。它不需要账号和密钥，使用固定的 [官方 APY 接口](https://wiki.apertium.org/wiki/Apertium-apy)。默认四路顺序不变，不自动开启新增服务。

Apertium 只支持部分语言对，例如英语与西班牙语互译；不能假设任意两种欧洲语言都能互译。当前官方 [语言对列表](https://apertium.org/apy/listPairs) 不含中日韩。短文本无法可靠自动识别时，请手动选择源语言；不支持的语言对会失败并允许后备链尝试下一项。未查到明确公共服务额度或 SLA，不代表无限使用。

2026-09-08 用公开示例 `Hello world.`、`eng|spa` 实测匿名 API 返回 HTTP 200 和 `Hola Mundo.`。这是单次协议可用性证据，未验证所有地区或真实网页翻译。

## 新增 LibreTranslate（自建实例）

在服务目录选择 **LibreTranslate**，填写完整实例地址，例如 `http://localhost:5000/translate`。支持免密钥的自建实例可以留空 API Key；需要认证的实例填写其自己的 Key。默认不预置第三方实例，不加入匿名后备链。

[官方文档](https://docs.libretranslate.com/guides/api_usage/) 说明：自建实例可免密钥，官方托管 `libretranslate.com` 需要 Key。语言支持和额度由所连接实例决定，免费开源软件不等于免费官方托管。中文使用 `zh`（简体）和 `zt`（繁体）；实例未安装对应模型时会提示失败。

适配器使用 JSON 纯文本请求，密钥仅按该实例配置发送。地址、密钥、导入导出和请求快照复用已有配置机制。协议测试使用本地模拟响应，未声称验证用户自己的服务器。

## 暂未接入 Lingva

根据 [Lingva 项目公开接口说明](https://github.com/TheDavidDelta/lingva-translate) 核对了官方及多个公开实例；本环境于 2026-09-08 收到 403 或 TLS 连接失败，没有将其列为可用服务。这不代表所有地区都无法访问。

## 为什么没有加入其他有免费额度的服务

“有免费额度”和“免密钥”是两个不同条件。下列服务仍需账号凭据或自行部署，因此不加入匿名免费降级，也不要求用户申请或填写这些服务的 Key。

| 服务 | 排除理由 | 官方来源 |
| --- | --- | --- |
| Azure Translator F0 | 必须申请 Azure 资源并使用密钥；免费层也不能匿名调用 | [认证说明](https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/authentication) |
| DeepL API Free | 必须有账户和 API Key；已有单独 DeepL 服务不参与免密钥降级 | [访问与认证](https://developers.deepl.com/docs/getting-started/auth) |
| 百度通用文本翻译 | 需要 APPID 和签名密钥 | [接口与签名](https://fanyi-api.baidu.com/product/113) |
| 阿里云机器翻译 | 需要 AccessKey 认证 | [认证与调用](https://help.aliyun.com/zh/machine-translation/support/faq-about-api-calls) |
| Google Cloud Translation | 是需要项目认证的云 API，不能把它的免费额度套用到网页接口 | [Cloud Translation 设置](https://cloud.google.com/translate/docs/setup) |
| LibreTranslate 官方托管服务 | 托管服务需要 API Key；自建实例需要部署维护，第三方公共实例不等于官方免费托管 API | [官方文档](https://docs.libretranslate.com/) |

## 设置与降级行为

在“完整设置 → 翻译服务 → 免费翻译服务”中调整服务的顺序和启用状态，至少保留一路。免费链没有 Key 输入项，MyMemory 邮箱可留空。已有其他独立服务的凭据设置保持原有用途，不会被免费链读取、修改或作为后备调用。

- 默认每路最多等待 5 秒，可调整为 1–15 秒。
- 网络故障、限流、额度耗尽或超时后继续下一路，并暂停使用失败服务；默认暂停 60 秒，可调整为 1–300 秒。
- 暂停期间后续请求跳过该服务，冷却结束后重新探测。状态只保留在当前后台运行期，后台重启不代表供应商额度已恢复。
- 用户取消会停止整条链。全部服务不可用时显示失败，不无限重试；语言等请求参数错误只影响当前请求。
- 请求保持同一份配置快照；修改顺序后，新请求与旧缓存分开识别。新的等待策略只影响后续请求，迟到响应不能覆盖已取消的结果。

MyMemory 协议测试覆盖匿名请求、语言隔离、字节上限、文本槽标记、额度响应、空译文和取消。配置与调度测试覆盖四路目录、排序停用、导入归一、超时冷却和凭据隔离。实现依据官方文档和 FluentRead 现有架构独立完成，没有复制或修改参考仓库。

浏览器验证使用生产构建与临时 Edge profile，区分真实匿名 API 实测和本地故障注入。旧版完整 UI 技能脚本依赖已变更的导航选择器，完整套件未计为通过；当前功能使用独立专项验证。Firefox 与 userscript 的构建校验不等同于运行时浏览器验证。
