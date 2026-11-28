# 浏览器内置翻译

流畅阅读支持调用桌面版 **Chrome 138+** 与 **Edge 148+** 的内置 Translator API，在设备本地离线完成网页翻译，无需 API Key 也不向第三方云端发送文本。实际可用性取决于浏览器版本、设备、语言对及企业管理策略。

<GuideVisual kind="chrome-local" />

## 三步准备与启用

1. 打开**设置 → 翻译服务 → 浏览器内置翻译**，查看当前语言对与语言包状态（旧配置中的「Chrome 内置 AI 翻译」会自动显示为「浏览器内置翻译」）。
2. 点击**准备语言包**，让浏览器联网下载并验证所需语言对模型；如已下载，点击**检查语言包**确认。
3. 状态显示**已就绪**后，点击**设为默认翻译服务**，即可回到网页离线翻译。切换新语言对时按同样步骤准备对应语言包即可。

## Firefox 用户说明

Firefox 自带设备端整页与划词翻译（可通过 Firefox 菜单直接使用），但暂未向浏览器扩展开放翻译 API。在 Firefox 中使用流畅阅读离线翻译，请选用[内置本地模型翻译](/config/translation-engines#本地模型翻译)或本机 Ollama。

## 可用性与官方诊断

设置页会实时提示当前浏览器是否开放 Translator API。如果某语言对不可用，请检查浏览器版本、首次下载时的网络状态或设备策略，也可随时切回其他翻译服务。

- [Chrome Translator API 文档](https://developer.chrome.com/docs/ai/translator-api) · [Chrome 内置模型诊断指南](https://developer.chrome.com/docs/ai/debug-built-in-model)
- [Microsoft Edge Translator API 文档](https://learn.microsoft.com/microsoft-edge/web-platform/translator-api)
- [Firefox 本地翻译帮助](https://support.mozilla.org/kb/website-translation)

## 相关文档

- [翻译服务与本机离线模型](/config/translation-engines)
- [隐私政策](/guide/privacy)
