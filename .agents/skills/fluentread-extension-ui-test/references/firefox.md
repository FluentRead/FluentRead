# Firefox 独立配置验证

## Firefox 首次启动引导

`pnpm dev:firefox` 使用新的临时 profile 时，Firefox 可能先显示“欢迎使用 Firefox”或隐私条款引导。这是浏览器 profile 初始化，不是扩展页面，也不能被当成 FluentRead UI 失败。测试必须在启动参数层预置 Firefox runner 偏好（WXT 的 `webExt.startUrls` 与 `webExt.firefoxPref`），让浏览器直接进入 `about:blank`；不要在可见页面上循环点击“继续”。

每次 Firefox 测试启动后，只执行一次自动化启动检查：

1. 使用 Computer Use 的 `get_app_state`，优先传 `app: "org.mozilla.firefox"`，读取可访问性树。
2. 若仍检测到“欢迎使用 Firefox”或 `about:welcome`，先保存截图和状态文本，然后立即将该次测试标记为 `browserBootstrap.firstRunBlocked = true` 并停止，不要反复点击页面；这表示 runner profile 预置没有生效，需要修正启动配置。
3. 只有确认当前窗口已经进入 `about:blank` 或扩展测试页面后，才定位工具栏中的“流畅阅读”按钮；不要复用上一次状态中的 `element_index`，每次动作后重新读取状态。
4. 报告中记录 `browserBootstrap.firstRunDetected`、`browserBootstrap.firstRunBlocked`、`browserBootstrap.remainingDialogs`。引导页无法通过启动配置消除时，测试应明确失败并保留证据。

为了保留真实 Firefox 行为，不要把 `--headless` 当作扩展回归方案，也不要修改用户 Firefox profile 的首启偏好。允许只在本次临时 profile 的 runner 配置中使用：

```ts
webExt: {
  startUrls: ['about:blank'],
  firefoxPref: {
    'browser.aboutwelcome.enabled': false,
    'browser.startup.homepage_override.mstone': 'ignore',
    'browser.shell.checkDefaultBrowser': false,
  },
},
```

若测试需要重复执行，允许删除本次创建的临时 profile；下一轮仍应由启动配置自动跳过引导，而不是依靠人工点击留下状态。

Firefox 测试最小流程：`pnpm dev:firefox` → 处理首次启动引导 → 打开 popup → 齿轮进入 options → 修改目标语言/开关/服务 → 立即关闭 options → 重新打开 popup → 断言修改值保持。完成同步断言后，必须进入“配置管理”验证最近配置版本、时间、最多 5 条、恢复、撤销与重做，并生成配置历史截图和可访问性文本证据。

