# 课程播放器布局复刻

这是独立编写的宿主测试页，FluentRead 图标、菜单和字幕由实际扩展注入。

- B 站采用 2026-11-14 真实 TED 视频页面测得的尺寸：底控 55px、操作行 35px、可见字幕与设置图标 22px，按钮靠行顶端排列。复刻页还增加不对称命中留白，验收同时比较可见字幕文字和设置 SVG 的中心，防止整行或外框中心对齐仍然肉眼偏低。
- Udemy 与 edX 是代表性布局：分别覆盖嵌套字幕按钮、居中对齐，以及带边框和底部 padding 的靠下对齐。它们不构成当前线上课程页的验证证据。
- 网页全屏用固定定位；浏览器全屏调用真实 `requestFullscreen()`，退出用 `exitFullscreen()` 后保留隐藏旧栏并生成新控件，验证入口的重新挂载。没有复制第三方播放器脚本或资源。
- B 站退出全屏后启动独立推荐预览，验证主视频暂停时入口仍留在主播放器。

裸布局预览：`node tests/fixtures/course-players/player.cjs`，访问输出地址并用 `?site=udemy` 或 `?site=edx` 切换。完整扩展验收使用：

```sh
node scripts/testing/run-course-player-layout-test.cjs \
  --sites bilibili,udemy,edx --background \
  --extension-dir .output/chrome-mv3 \
  --playwright-root /path/to/node_modules \
  --artifacts-dir /path/to/evidence
```

验收器把本地 HTML 显式提供给三站测试 URL，以触发扩展的实际站点入口；字幕响应是固定数据，不访问真实课程或账号。报告必须标明本地复刻及诊断采集范围。
