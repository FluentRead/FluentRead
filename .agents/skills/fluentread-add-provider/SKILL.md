---
name: fluentread-add-provider
description: 在 FluentRead 中新增或迁移翻译服务商（AI SDK 兼容、云厂商机器翻译或自定义 REST）的端到端工程清单，覆盖配置目录、provider registry、broker 能力、模块化 i18n 与低 token 验证门禁。
---

# FluentRead 新增 / 迁移翻译服务清单

新增或迁移任何翻译供应商前，先运行 `pnpm find:module -- <keyword>` 查找最接近的既有服务作为模板，避免复制旧式代码或散落协议细节。

## 1. 配置目录与凭据边界（`src/core/config/`）

- `src/core/config/catalog/`（`src/core/config/catalog.ts` 为纯重导出 barrel，新增实现写入对应子模块再在 barrel 透出）：
  - `catalog/services.ts`：注册稳定服务 ID（`services`，保持向后兼容）、`cloudVendorServices`、`referenceAiPlatformServices`、`cloudCredentialLabels`、`resolveConfiguredModel`。
  - `catalog/serviceTypes.ts`：更新 `servicesType`（机器翻译 / AI / AI SDK / 云厂商 / 凭据与模型能力）。
  - `catalog/models.ts`、`catalog/regions.ts`、`catalog/options.ts`、`catalog/prompts.ts`：补齐模型候选、地域选项、下拉选项与默认提示词。
- `src/core/config/constants.ts`：集中登记默认接口地址与地域端点解析函数，禁止在 UI 或业务层硬编码 URL。
- `src/core/config/model/`（`src/core/config/model.ts` 为纯重导出 barrel，具体实现分别位于 `configClass.ts`、`normalizeConfig.ts`、`providerNormalization.ts`、`modelMigration.ts`、`types.ts`）以及 `credentials.ts`、`apiKeys.ts`、`serviceAvailability.ts`、`nativeBatch.ts`：
  - 新增配置项必须接入归一化、默认值与 diff/migration。
  - **凭据硬边界**：API Key、Secret、Token 只能走 `CONFIG_CREDENTIAL_FIELDS`（`src/core/config/credentials.ts`）与 `apiKeys`/`token`/`secret` 本地存储方案，严禁落入公开配置、日志、源码或测试夹具。
  - 仅在真正实现供应商原生多文本 HTTP 请求并校验响应长度时，才登记到 `src/core/config/nativeBatch.ts`。

## 2. Provider 适配与注册（`src/providers/translation/`）

- **OpenAI 兼容服务（优先）**：直接加入 `src/providers/translation/ai-sdk/endpoints.ts`（`AI_SDK_COMMON_SERVICE_IDS` 或专用 route），复用共享 `translateWithOpenAICompatibleAiSdk` transport。
- **独立协议服务**：在 `src/providers/translation/<provider>.ts` 实现适配器（首字符起写中文 `@file` 头注释），只负责统一请求到外部协议的转换；并在 `src/providers/translation/registry.ts` 注册。
  - 仅支持单条文本的适配器必须用 `singleTextProvider(...)` 包装，拒绝隐式传入数组。
- **连接测试**：核对 `src/providers/translation/connectionTest.ts` 能否通过 `translationProviderRegistry` 执行最小翻译检查并返回可读错误信息；严禁在 UI 组件中直接发起网络请求。

## 3. Broker 编排与能力声明（`src/services/translation/`）

- `src/services/translation/capabilities.ts`：确认批量支持（`supportsTranslationBatch` / `supportsNativeTranslationBatch`）、术语保护（`supportsTranslationGlossary`）以及跨浏览器 / Userscript 可用性（`isTranslationServiceAvailable`）。
- `src/services/translation/broker.ts` 与 `src/services/translation/broker/`（`cacheStore.ts`、`protocol.ts`、`providerTransport.ts`、`recoveryPipeline.ts`、`telemetry.ts`）：核对配置快照、地域/凭据摘要缓存隔离、超时总预算、取消边界与错误处理；不得将某家供应商的网络细节扩散到 `src/features/`。

## 4. 设置 UI 与模块化多语言

- `src/features/settings/` 与弹窗服务选择器：补齐服务目录可见性、本地图标（禁止退回裸字母占位）、模型列表与自定义模型入口、连接参数表单及提示说明。
- **模块化 i18n（强制）**：新增界面文案必须放在 `src/core/i18n/messages/<feature>/*.json` 并配强类型封装（参照 `src/core/i18n/messages/dictionaryWorkspace.ts`，可用 `pnpm i18n:scaffold -- <feature>` 生成脚手架），**禁止向 7 个巨型单体文件（`zh-CN.ts`、`en-US.ts`、`es-ES.ts`、`fr-FR.ts`、`ja-JP.ts`、`ko-KR.ts`、`ru-RU.ts`）追加新键**。需要覆盖服务目录名称时同步核对 `src/core/i18n/serviceLabels.ts`。

## 5. 测试与验证门禁

1. 补充单元测试：覆盖配置目录/归一化、端点解析、provider 协议（正常、鉴权失败、限流/错误体、超时、单条数组拒收或原生合批）、连接测试及设置页表单。
2. 同步登记表：`pnpm sync:registries -- --check`（必要时 `--write`），确保 `vitest.coverage.config.ts` 与 `test-matrix.json` 一致。
3. 低 token 验证循环：
   - `pnpm test:for -- <changed-paths>`
   - `pnpm verify:dev -- --compile`
   - `pnpm test:coverage:gaps`（确保 `src/` 新增/改动可执行模块 statements/branches/functions/lines 四维 100%）
   - 涉及文案时运行 `pnpm verify:i18n`
4. 构建与真机 UI 验收：
   - 运行 `pnpm build` 与 `pnpm build:firefox`；若改动共享翻译或平台代码，同时运行 `pnpm test:userscript`。
   - 涉及设置页或弹窗服务列表时，按 `.agents/skills/fluentread-extension-ui-test/SKILL.md` 用 `--suite services`（必要时加 `popup`）在隔离后台浏览器中验证，且保持 FluentRead 自身运行时错误/告警为 0。
