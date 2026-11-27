---
name: fluentread-site-compat
description: 诊断并修复 FluentRead 网页翻译与特定站点 DOM 兼容问题的标准流程，结合模块索引、声明式站点规则、受影响站点矩阵与零运行时错误门禁。
---

# FluentRead 站点兼容诊断与修复清单

处理特定网站漏翻、错翻、排版错位、重复插入译文、无法恢复原文或动态加载失效时，按以下顺序定位并验证。

## 1. 快速定位模块

优先用 `pnpm find:module -- <site-or-keyword>` 定位相关模块，禁止盲目全仓搜索：

- **声明式站点规则**：`src/core/site-adaptation/catalog/`（`established.json`、`websites.json`、`profiles.json`、`coverage.json`）、`schema.ts`、`compiler.ts`。
- **通用候选与 DOM 引擎**：`src/core/translation/`（`engine.ts`、`dom.ts`、`serialization.ts`、`layout.ts`、`adapters/declarative.ts`）。
- **内容脚本运行时**：`src/features/full-page-translation/content/`（`runtime.ts`、`state.ts`、`renderer.ts`、`mutationObservation.ts`、`bilingualRemount.ts`、`hoverRemountRecovery.ts`、`orphanArtifacts.ts`、`routeLifecycle.ts`）。

先判别根因归属：
- 仅限单站或同类站点的正文边界、禁译区域或动态排除 → 优先调整声明式规则 JSON。
- 跨站通用的候选发现、序列化、布局、恢复或重挂载缺陷 → 在 `src/core/translation/` 或 `src/features/full-page-translation/content/` 修根因，不把站点特判堆进通用逻辑。

## 2. 最小复现（仅跑受影响站点）

1. 先执行相关单测：`pnpm test:for -- <related-paths>`。
2. 查看现有站点矩阵用例：`node scripts/run-site-translation-matrix.cjs --list`。
3. 仅针对受影响站点运行真实隔离后台测试（默认禁止无筛选全量跑矩阵）：

```bash
node scripts/run-site-translation-matrix.cjs \
  --cases <site> --mode both --allow-network \
  --extension-dir <checkout>/.output/chrome-mv3-dev \
  --playwright-root <playwright-root> \
  --focus-safe-helper .agents/skills/fluentread-browser-translation-test/scripts/focus-safe-browser.cjs \
  --runtime-diagnostics-helper .agents/skills/fluentread-browser-translation-test/scripts/runtime-diagnostics.cjs
```

- 只需快速检查单段悬浮切换 `[1, 0, 1]` 时，配合 `.agents/skills/fluentread-browser-translation-test/scripts/run-toggle-test.cjs`（详见该 skill）。
- 严格遵守隔离与焦点策略：临时 profile、`DeskPad Display` → 副屏 → 主屏、禁止连接日常 profile 或 `bringToFront()`，快捷键统一用 `Control`。

## 3. 根因修复与全状态闭环

- **声明式规则优先**：在 `src/core/site-adaptation/catalog/*.json` 中按 `src/core/site-adaptation/schema.ts` 的严格 `SiteRecipe` 契约调整 `mode`、`content`（含 `css`/`resolve`/`atomic`/`splitOnBr`/`key`）、`protect`、`exclude`、`watchIgnore`、`forceTranslate`、`omit`、`literalLabels`、`literalTokens`；确需专用纯 DOM 判定时，在 `src/core/site-adaptation/` 新增纯模块（首字符起写中文 `@file` 头注释）并在 `compiler.ts` 组合。
- **必须覆盖的全部状态**：
  1. 首次翻译 → 恢复原文 → 再次翻译（`[1, 0, 1]`）闭环；
  2. 无同父重复 wrapper、无嵌套 wrapper、恢复后无残留节点或样式污染；
  3. `forbiddenSelectors`（代码块、公式、输入框、导航或受控 UI）保持原文与交互语义不变；
  4. 动态 DOM 追加、SPA 路由切换、宿主框架重挂载（hydration/remount）、页面卸载清理与失败重试；
  5. 悬浮翻译与全文翻译保持同一候选语义，仅入口与调度不同。
- 修改 `tests/browser-translation-cases.json` 时，必须维持 `requiredSelectors` / `forbiddenSelectors` / `interactionSelectors` 严格契约，不得通过删减或放宽断言掩盖问题。

## 4. 验证与零运行时错误门禁

1. 低 token 单元与覆盖率验证：
   - `pnpm test:for -- <changed-paths>`
   - `pnpm verify:dev -- --compile`
   - `pnpm sync:registries -- --check`（必要时 `--write`）
   - `pnpm test:coverage:gaps`（确保改动涉及的 `src/` 可执行模块 4 维 100% 覆盖）
2. 生产产物复验：
   - 运行 `pnpm build`（改动共享翻译/平台代码时同时运行 `pnpm build:firefox` 与 `pnpm test:userscript`）。
   - 使用 `.output/chrome-mv3` 重跑受影响站点的 `scripts/run-site-translation-matrix.cjs --cases <site>`（必要时补跑 `run-toggle-test.cjs`）。
3. **运行时错误与告警门禁**：
   - 核对内容脚本隔离世界、扩展页与后台的诊断日志及截图证据，FluentRead 自身错误与告警必须为 0。
   - 宿主页面第三方噪声须给出 URL/堆栈归属依据并单独列示，禁止宽泛忽略、吞异常或删除日志。
