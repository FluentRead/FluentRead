# 浏览器内置翻译

FluentRead 可通过桌面版 Chrome 138+ 和 Edge 148+ 的 Translator API 在设备上翻译。首次下载语言包需要联网，下载后可离线翻译。实际可用性取决于浏览器版本、设备、语言对和管理策略。

Firefox 也提供设备端整页翻译和划词翻译，可以从 Firefox 菜单使用。它暂未向扩展开放翻译接口。在 Firefox 上使用 FluentRead 离线翻译时，可选择「本地模型翻译」。

## 准备语言包

1. 打开 **设置 → 翻译服务 → 浏览器内置翻译**，查看当前语言对和语言包状态。
2. 点击 **准备语言包**，让浏览器按需下载模型并验证语言对。若已下载，点击 **检查语言包**。
3. 状态显示 **已就绪** 后，可点击 **设为默认翻译服务**，再回到网页翻译。使用新的语言对时，按提示准备对应的语言包。

旧配置里的「Chrome 内置 AI 翻译」会显示为「浏览器内置翻译」。

## 检查可用性

设置页会提示浏览器是否开放接口。如果语言对不可用，请检查浏览器提供的语言支持、网络和管理策略。也可以在翻译服务中切换到其他服务。

- [Chrome Translator API](https://developer.chrome.com/docs/ai/translator-api) · [Chrome 模型诊断](https://developer.chrome.com/docs/ai/debug-built-in-model)
- [Microsoft Edge Translator API](https://learn.microsoft.com/microsoft-edge/web-platform/translator-api)
- [Firefox 本地翻译帮助](https://support.mozilla.org/kb/website-translation)
