/**
 * @file src/ui/i18n.ts
 *
 * 文件职责：作为 Vue 界面语言适配层的纯重导出门面，保持既有公开符号兼容并允许依赖图按符号解耦组件与配置存储。
 * 主要内容：转发 UiI18nContext、localizeServiceOptions、UI_I18N_KEY、useUiI18n、registerUiI18nFallbackFactory、UiI18nPluginOptions、createUiI18nContext 与 createUiI18nPlugin。
 * 模块边界：仅包含纯 re-export 语句，不持有运行时逻辑或静态副作用；具体实现由 src/ui/i18n/ 下的独立子模块分别承担。
 */

export type {UiI18nContext} from './i18n/types';
export type {LocalizableServiceOption, ServiceProfileSummary} from './i18n/localizeServiceOptions';
export {localizeServiceOptions} from './i18n/localizeServiceOptions';
export {UI_I18N_KEY, useUiI18n, registerUiI18nFallbackFactory} from './i18n/useUiI18n';
export type {UiI18nPluginOptions} from './i18n/runtime';
export {createUiI18nContext, createUiI18nPlugin} from './i18n/runtime';
