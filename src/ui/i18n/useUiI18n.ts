/**
 * @file src/ui/i18n/useUiI18n.ts
 *
 * 文件职责：提供轻量、不依赖配置 store 的 Vue 界面语言注入键与组合式入口，阻断 UI 组件经 i18n 反向耦合配置存储链路。
 * 主要内容：导出 UI_I18N_KEY、useUiI18n 与 registerUiI18nFallbackFactory；优先读取组件树注入的 UiI18nContext，未注入时调用已注册的运行时回退工厂，或在独立单测环境中创建只读默认中文上下文。
 * 模块边界：只依赖 Vue inject/ref 与 core i18n 纯翻译能力，绝不导入 services/config/store、platform 资源加载器或 legacyDom 扫描器；真实配置订阅与持久化上下文由 ./runtime.ts 装配并注册。
 */

import {inject, readonly, ref, type InjectionKey} from 'vue';
import {
    DEFAULT_UI_LANGUAGE,
    translate,
    translateLegacyText,
    type TranslationParams,
    type UiLanguage,
} from '@/src/core/i18n';
import {translateServiceLabel} from '@/src/core/i18n/serviceLabels';
import type {UiI18nContext} from './types';

export const UI_I18N_KEY: InjectionKey<UiI18nContext> = Symbol('fluentread-ui-i18n');

let fallbackContextFactory: (() => UiI18nContext) | null = null;
let fallbackContext: UiI18nContext | null = null;

/** 允许 runtime.ts 在加载时登记配置驱动的回退上下文工厂，同时保持 useUiI18n 静态零存储依赖。 */
export function registerUiI18nFallbackFactory(factory: (() => UiI18nContext) | null): void {
    const previous = fallbackContext;
    fallbackContextFactory = factory;
    fallbackContext = null;
    previous?.dispose();
}

function createStandaloneFallbackContext(): UiI18nContext {
    const language = readonly(ref<UiLanguage>(DEFAULT_UI_LANGUAGE));
    const bundleRevision = readonly(ref(0));
    return {
        language,
        bundleRevision,
        t: (key: string, params?: TranslationParams): string => {
            void bundleRevision.value;
            return translate(key, language.value, params);
        },
        translateLegacy: (value: string): string => {
            void bundleRevision.value;
            return translateServiceLabel(value, language.value) ?? translateLegacyText(value, language.value);
        },
        setLanguage: async (): Promise<boolean> => false,
        dispose: (): void => undefined,
    };
}

export function useUiI18n(): UiI18nContext {
    const injected = inject(UI_I18N_KEY, null);
    if (injected) return injected;
    fallbackContext ??= fallbackContextFactory ? fallbackContextFactory() : createStandaloneFallbackContext();
    return fallbackContext;
}
