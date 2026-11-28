# 流畅阅读品牌宣传语

**Closer languages. A bigger world.**

**让语言更近，让世界更大。**

## 多语言文案

| 语言 | 宣传语 |
| --- | --- |
| 简体中文 | 让语言更近，让世界更大。 |
| 繁體中文 | 讓語言更近，讓世界更大。 |
| English | Closer languages. A bigger world. |
| 日本語 | 言葉をもっと身近に。世界をもっと広く。 |
| 한국어 | 언어는 더 가깝게. 세상은 더 넓게. |
| Français | Des langues plus proches. Un monde plus grand. |
| Русский | Языки ближе. Мир больше. |
| Español | Idiomas más cercanos. Un mundo más grande. |

## 展示约定

宣传语用于 README 首屏、官网首页与页脚、设置侧栏、关于页、首次欢迎页、商店介绍、宣传图片和社区文案。界面中的宣传语跟随界面语言；首次欢迎页和中英文 README 同时展示中英文，便于尚未选择语言的用户理解。

保留原有标点，可以在两句话之间换行。宣传语附近保留“开源浏览器双语翻译插件”等具体产品介绍，让首次接触流畅阅读的用户了解用途。不要把功能说明中的“双语阅读”“双语翻译”机械替换成宣传语。

## 维护入口

七种语言的宣传语来源为 [`src/core/i18n/messages/brand-taglines.json`](../../../src/core/i18n/messages/brand-taglines.json)。界面语言目录的 `brand.tagline`、官网和宣传图生成脚本复用该文件。README 和本页保留可直接复制的宣传语。

安装页需要说明产品用途，扩展和用户脚本的 description 使用 [`src/core/i18n/messages/product-descriptions.json`](../../../src/core/i18n/messages/product-descriptions.json) 中的七语功能说明。扩展的 `_locales/*/messages.json` 在构建时生成，名称继续复用界面品牌资源，不手工维护第二套语言目录。浏览器安装 metadata 跟随浏览器语言；应用内界面跟随用户选择的界面语言。

商店中英文短介绍与 `package.json` 保留可直接复制的功能说明，同步修改后运行 `pnpm verify:brand` 检查语言覆盖、长度限制和一致性。完整商店介绍仍以当地语言的宣传语开头，再解释能力与使用条件；不要用宣传语替代功能说明，也不要把浏览器扩展专属能力写进用户脚本的描述。仓库只有中英文商店上架资料；其他五语安装描述不代表已有对应的商店完整介绍。

语言资源改动后运行 `pnpm generate:userscript-languages`。非英文用户脚本资源生成后，先提交新资源，再将 `userscript/vite.config.ts` 的 `userscriptLanguageResourceCommit` 指向包含这些文件的提交，最后重新构建并校验用户脚本。

宣传图运行 `node scripts/build-product-assets.cjs --promo-only --runtime <Node 包目录>` 重新生成；需检查 440×280 与 1400×560 的中英文图片均完整显示两句话。仓库内更新不代表商店或官网已经发布。
