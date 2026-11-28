# 网站阅读范围与偏好

网页漏译正文、希望常用外语站自动翻译，或想在某些网站完全禁用扩展时，在这里按清晰优先级一步配置。

<GuideVisual kind="rules" />

<DocDiagram kind="site-rules-priority" />

## 第一步：排查正文漏译 {#正文漏译}

1. 安装或更新扩展后，先刷新当前网页。
2. 向下滚动页面——流畅阅读默认随阅读位置逐步翻译。
3. 需要连菜单、侧栏和按钮一并翻译时，在**高级选项 → 页面识别**开启**识别全部节点**，恢复原文后重译。
4. 图片或图表中的非可选文字，使用[图片翻译](/guide/image-translation)或[圈选翻译](/guide/area-translation)。

### 内置专站保护策略

为了不破坏网页交互与专名辨识度，部分常见站点自带精细规则：

- **通用话题标签与 Discourse 徽标**：如 `chatgpt`、`rate-limit`、`API` 等标签链接默认保留原文（开启识别全部节点亦保留），标题与正文正常翻译。
- **GitHub**：页头面包屑中的用户名/组织名/仓库名及 PR 作者名保留原文，PR 标题与讨论正文正常翻译。
- **X / OpenAI 社区 / Google 搜索 / Twitch / Llamaperf**：保留 X「显示更多」展开按钮与 OpenAI 社区筛选器；支持 Google 搜索 AI 概览正文、Llamaperf 基准说明，以及 Twitch 聊天正文与侧栏主播显示名（保留登录名、`@` 提及与表情按钮）。

## 第二步：配置网站偏好 {#每次都翻译-或始终保持原样}

打开**设置 → 工具与学习 → 网站规则 → 网站偏好**（或直接在扩展菜单快捷切换）：

| 网站偏好 | 行为说明 |
| --- | --- |
| **始终翻译** | 打开该网站新页面时自动开始翻译（当前页手动恢复原文后保持原文，进入下一篇重新生效） |
| **禁用扩展** | 恢复原文并停止该网站的全部扩展功能，**优先级高于自动翻译** |
| **隐藏悬浮球** | 仅隐藏悬浮球入口，快捷键与菜单仍可正常使用 |
| **仅显示译文** | 该网站不显示原文对照，其他网站继续沿用全局模式；切换后对已有译文即时生效（本身不触发自动翻译） |

::: info 域名匹配规则
网站偏好按**主域名**保存，自动覆盖其所有子域名，不区分路径与端口。开启**所有网站自动翻译**时，已设为「禁用扩展」的网站仍保持禁用。
:::

## 第三步：精细调整正文范围与突破禁译标记 {#仍然识别不对}

如果某个网站依然识别不准，可进入**网站规则 → 正文适配**编写可视化选择器规则，并通过**生效预览**输入完整网址检查命中优先级（详见[自定义网站正文规则](/guide/custom-site-rules)）。

### 突破指定区域的禁译标记（`forceTranslate`） {#指定区域被禁译标记阻挡}

当网站给需要阅读的区域加上了 `translate="no"`、`.notranslate` 或 `data-notranslate="true"` 时，可在正文适配的高级 JSON 中添加 `forceTranslate` 选择**携带禁译标记的元素本身**（以 itch.io 评论外壳为例，内置规则已包含该例外）：

```json
{
  "version": 1,
  "rules": [{
    "id": "itch-comments",
    "name": "itch.io 评论",
    "match": {"hosts": ["*.itch.io"]},
    "forceTranslate": ["div[id^='game_comments_react_'][id*='_Game-Comments_']"],
    "content": [{"css": [".post_body", ".post_body p", ".post_body li"], "atomic": false}]
  }]
}
```

- `forceTranslate` 仅覆盖匹配元素自身的禁译标记，不修改网页 DOM 属性；嵌套编辑区、代码、隐藏内容及规则中的 `protect` / `exclude` 仍受保护。
- 若存在多层嵌套禁译容器，需分别匹配每一层；需在「识别全部节点」下生效时显式设置 `allScopes: true`。

不熟悉 CSS 选择器时，可直接到 [GitHub Issues](https://github.com/FluentRead/FluentRead/issues) 提供可公开网址、浏览器版本及去敏截图反馈。完整规则字段见[维护者规则参考](https://github.com/FluentRead/FluentRead/blob/main/docs/maintainers/product-reference/site-adaptation-20260906.md)。

## 相关文档

- [自定义网站正文规则](/guide/custom-site-rules)
- [全文与局部翻译](/guide/webpage-translation)
- [常见问题与排查](/guide/faq)
