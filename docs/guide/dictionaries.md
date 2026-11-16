# 词典与学习卡

在扩展的 **专项翻译 → 划词翻译 → 词典与学习卡** 中管理来源。添加或导入后，在上方 **词典来源** 中选用；没有选择自定义来源时，继续使用原来的自动策略。内置来源已包含 Wiktionary，可直接选择。

## 离线词典

点击 **导入离线词典**，一起选择同一词典的相关文件：

| 格式 | 选择的文件 |
| --- | --- |
| MDict | `.mdx`，可附 `.mdd`、`.css` 与媒体文件 |
| StarDict | `.ifo`、`.idx` 或 `.idx.gz`、`.dict` 或 `.dict.dz` / `.dict.gz` |
| DSL | UTF-8 或带 BOM 的 UTF-16 `.dsl`，也支持 `.dsl.dz` / `.dsl.gz` |
| Yomitan | 含 `index.json` 和 `term_bank_*.json` 的 ZIP |

一次导入最多 128 MiB，解压后最多 256 MiB、50 万条索引。解析与索引在独立 Worker 中处理；查词只读取当前来源的匹配项。取消会停止本次 Worker，原文件保持原样。

MDict 支持 1.x / 2.x、未压缩 / zlib / LZO，以及 `Encrypted=2` 的索引混淆；不支持受密码保护的正文或 DRM。StarDict 的二进制字段不转成释义；DSL 保留常用文字标签，复杂排版可能简化。展开 **词典原版排版** 可查看 HTML、样式及引用的本地媒体。脚本、表单、外部资源与主动内容不执行；大媒体有展示容量限制。

词库只保存在当前浏览器，不随配置备份或配方分享。换设备需重新导入。删除离线来源会同时删除对应索引和媒体，不删除原文件或词书收藏。

## JSON API 与脚本配方

点击 **添加来源**，输入名称和带 `{{word}}` 的查询地址，例如：

```text
https://api.dictionaryapi.dev/api/v2/entries/en/{{word}}
```

在字段映射中填写：

```text
释义：[0].meanings[*].definitions[*].definition
音标：[0].phonetic
音频：[0].phonetics[0].audio
例句：[0].meanings[*].definitions[*].example
```

支持点号、数字数组下标、`[*]` 和开头的 `$`，不支持执行表达式的 JSONPath 过滤器。空字段不展示。鉴权请求头可填写 JSON；它们通过现有本地配置保存，分享导出时去除。地址使用 HTTPS，或 `localhost` / `127.0.0.1` / `[::1]` 的 HTTP 服务；本地词典服务器应提供 JSON 接口，按实际返回结构映射字段。

选择 **JavaScript** 时，后台先请求所填地址，再把单词 `word` 和 JSON 响应 `data` 交给脚本。脚本返回 JSON，随后应用同一套字段映射：

```js
return {
  definition: data[0].meanings.flatMap(m => m.definitions.map(d => d.definition)).join('\n'),
  phonetic: data[0].phonetic || ''
};
```

将释义路径设为 `definition`、音标路径设为 `phonetic`。脚本在随包 QuickJS 虚拟机中有界运行，不能读取网页、配置或文件，也没有网络和扩展 API；异步网络脚本可改为声明式请求，或放到自己的本地服务器。未选用配方时不查询，关闭或切换后旧结果不会覆盖当前单词。

**导出配方** 包含来源、路径与脚本，不含请求头或离线词库。地址和脚本可能含有自行填写的敏感信息，分享前请检查。导入同 ID 的配方保留已有配置。

## 网页来源

选择 **网页**，输入带 `{{word}}` 的地址。划词后点击 **加载词典网页** 才会向站点发送单词。页面在隔离 iframe 中打开；登录、嵌入限制或同源要求可能导致不可用，届时使用 **在新标签页打开**。

## 卡片模板与导出

模板支持 `{{word}}`、`{{phonetic}}`、`{{definition}}`、`{{example}}`、`{{audio}}`、`{{etymology}}`、`{{inflections}}`、`{{ai_explanation}}`、`{{context_sentence}}`、`{{source}}`、`{{source_url}}`。模板以纯文本显示，缺少的字段留空。

划词卡展开 **学习卡预览与导出**，确认正反面内容后导出 CSV / Markdown，或点击 **Anki**。`context_sentence` 来自当前选词附近的有限原句；`ai_explanation` 只使用已完成的当前 AI 讲解，不会自动调用模型。

Anki 需要先启动本机 AnkiConnect，并填写已有牌组、笔记类型及正反面字段（默认 `Basic` / `Front` / `Back`）。只允许回环地址，不自动创建牌组，默认拒绝重复。未确认保存时，先在 Anki 核对卡片再重试。导出可能含原句或个人解释，请按预览内容决定是否分享。

此工作区用于浏览器扩展；油猴版保留原有在线查词流程。[词书与复习](./vocabulary-book.md) 继续独立使用。
