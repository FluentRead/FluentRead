# 故障排查

仅当标准脚本失败，或用户明确要求诊断时读取本文。

## 快捷键没有反应

- 确认鼠标悬浮快捷键配置严格等于 `Control`。
- 依次发送 `keyboard.down("Control")` 和 `keyboard.up("Control")`。
- 不要使用 `CTRL`、`Control_L`、`Ctrl+A`、Meta 键或通过 DOM 创建的键盘事件。
- 发送按键前先移动并单击目标段落，单击普通文字而不是链接。
- 确认没有按住其他普通按键。FluentRead 会精确匹配当前按键集合。

源码定位：

- `entrypoints/content.ts` 与 `src/features/hover-translation/content/`：鼠标悬停快捷键匹配与 `keyup` 处理器。
- `src/core/config/catalog.ts`：默认配置 `hotkey: "Control"`。

## 插件没有注入页面

- 确认 `.output/chrome-mv3-dev/manifest.json` 存在。
- 保持 `pnpm dev` 运行，使开发产物和 HMR 服务持续可用。
- 使用全新的临时浏览器配置，不要复用日常 Chrome 或 Edge 配置。
- 触发翻译前确认页面存在 `#fluent-read-floating-ball-container`。
- 检查 Service Worker 和内容页面控制台中的加载错误。

## 出现译文元素但没有中文

- 通过插件页面读取 `chrome.storage.local`，检查实际启用的翻译服务。
- 区分服务或 API 故障与快捷键故障。
- 测试 `siliconCloud` 时，使用显式传入的专用测试配置，并确认用户已配置令牌和自定义模型；不得打印或替换令牌。
- 测试 `microsoft` 时，检查 `src/providers/translation/microsoft.ts` 和后台消息链路。
- 在 `https://example.com` 上进行稳定的微软翻译测试时，可使用以下预期文本：

```text
该域用于文档示例，无需许可。避免在操作中使用。
```

除非用户明确要求，否则不要要求大语言模型翻译服务输出完全相同的措辞。

## 翻译了错误段落或整个页面

- 使用 `https://example.com` 上第一个纯文本段落。
- 确认第二个段落的译文子元素数量始终为零。
- 不要使用 `Alt+T` 或 `Option+T`，它们是全文翻译快捷键。
- 每次操作后确认 URL 保持不变。

## 状态计数不是 1、0、1

- 每次等待目标状态出现后，再执行下一次操作。
- 翻译服务请求最长可能需要等待配置的超时时间。
- 在目标段落内部统计 `.fluent-read-bilingual-content`，不要统计整个页面。
- 如果第三次计数大于一，将重复插入译文报告为回归。
- 如果第二次计数仍为一，检查 `src/features/full-page-translation/content/runtime.ts` 与 `state.ts` 中的译文移除和恢复时序。

## 解读构建和类型检查

- 需要检查生产构建时运行 `pnpm build`。
- 浏览器测试后运行 `git diff --check`。
- 除非本次修改在改动文件中引入新错误，否则把已有的 `pnpm compile` 失败视为基线问题。常见类别包括缺少 `chrome` 全局类型，以及重复的 Vite 类型版本。

## 清理

- 只关闭脚本创建的持久化浏览器上下文。
- 只删除操作系统临时目录下、名称以 `fluentread-edge-profile-` 开头且由脚本自动创建的配置。保留显式传入的专用配置。
- 只停止本次测试启动的那个 `pnpm dev` 进程。
- 不得使用宽泛的 `pkill` 命令终止 Chrome、Edge 或 Node。
