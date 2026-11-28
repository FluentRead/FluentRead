/**
 * @file src/core/i18n/language.ts
 *
 * 文件职责：提供不依赖具体文案资源的界面语言领域规则。
 * 主要内容：声明默认语言、八语可选语言列表及多语言显示名称、存储值归一化、浏览器区域语言映射（含 zh-TW/zh-HK/zh-MO/zh-Hant 到繁體中文的识别）和按需资源包路径，让配置模型与运行时加载器可以复用语言契约而不把整套 UI 文案打进后台或纯配置 bundle。
 * 模块边界：这里只处理语言标识；资源查找和文本翻译由 i18n/index.ts 负责。
 */

import type {RegisteredUiLanguage, UiLanguage} from './types';

export type {UiLanguage} from './types';

export const DEFAULT_UI_LANGUAGE: UiLanguage = 'zh-CN';

/** 构建产物中按需加载的非中文资源包路径；生成器、manifest 与运行时加载器共用。 */
export const UI_LANGUAGE_BUNDLE_DIRECTORY = 'i18n';

export function getUiLanguageBundlePath(language: RegisteredUiLanguage): string {
    return `${UI_LANGUAGE_BUNDLE_DIRECTORY}/${language}.json`;
}

export const UI_LANGUAGE_OPTIONS = [
    {value: 'zh-CN', labelKey: 'language.zhCN'},
    {value: 'zh-TW', labelKey: 'language.zhTW'},
    {value: 'en-US', labelKey: 'language.enUS'},
    {value: 'ja-JP', labelKey: 'language.jaJP'},
    {value: 'ko-KR', labelKey: 'language.koKR'},
    {value: 'fr-FR', labelKey: 'language.frFR'},
    {value: 'ru-RU', labelKey: 'language.ruRU'},
    {value: 'es-ES', labelKey: 'language.esES'},
] as const satisfies ReadonlyArray<{value: UiLanguage; labelKey: string}>;

const multilingualUiLanguageLabels: Readonly<Record<UiLanguage, string>> = {
    'zh-CN': '简体中文 / Simplified Chinese',
    'zh-TW': '繁體中文 / Traditional Chinese',
    'en-US': 'English / 英语',
    'ja-JP': '日本語 / Japanese / 日语',
    'ko-KR': '한국어 / Korean / 韩语',
    'fr-FR': 'Français / French / 法语',
    'ru-RU': 'Русский / Russian / 俄语',
    'es-ES': 'Español / Spanish / 西班牙语',
};

const englishUiLanguageLabels: Readonly<Record<UiLanguage, string>> = {
    'zh-CN': 'Simplified Chinese / 简体中文',
    'zh-TW': 'Traditional Chinese / 繁體中文',
    'en-US': 'English / 英语',
    'ja-JP': 'Japanese / 日本語',
    'ko-KR': 'Korean / 한국어',
    'fr-FR': 'French / Français',
    'ru-RU': 'Russian / Русский',
    'es-ES': 'Spanish / Español',
};

const localizedUiLanguageLabels: Readonly<Record<Exclude<UiLanguage, 'zh-CN' | 'en-US'>, Readonly<Record<UiLanguage, string>>>> = {
    'zh-TW': {
        'zh-CN': '簡體中文 / Simplified Chinese / 简体中文',
        'zh-TW': '繁體中文 / Traditional Chinese',
        'en-US': '英語 / English',
        'ja-JP': '日語 / Japanese / 日本語',
        'ko-KR': '韓語 / Korean / 한국어',
        'fr-FR': '法語 / French / Français',
        'ru-RU': '俄語 / Russian / Русский',
        'es-ES': '西班牙語 / Spanish / Español',
    },
    'ja-JP': {
        'zh-CN': '中国語（簡体字） / Simplified Chinese / 简体中文',
        'zh-TW': '中国語（繁体字） / Traditional Chinese / 繁體中文',
        'en-US': '英語 / English',
        'ja-JP': '日本語 / Japanese',
        'ko-KR': '韓国語 / Korean / 한국어',
        'fr-FR': 'フランス語 / French / Français',
        'ru-RU': 'ロシア語 / Russian / Русский',
        'es-ES': 'スペイン語 / Spanish / Español',
    },
    'ko-KR': {
        'zh-CN': '중국어 간체 / Simplified Chinese / 简体中文',
        'zh-TW': '중국어 번체 / Traditional Chinese / 繁體中文',
        'en-US': '영어 / English',
        'ja-JP': '일본어 / Japanese / 日本語',
        'ko-KR': '한국어 / Korean',
        'fr-FR': '프랑스어 / French / Français',
        'ru-RU': '러시아어 / Russian / Русский',
        'es-ES': '스페인어 / Spanish / Español',
    },
    'fr-FR': {
        'zh-CN': 'chinois simplifié / Simplified Chinese / 简体中文',
        'zh-TW': 'chinois traditionnel / Traditional Chinese / 繁體中文',
        'en-US': 'anglais / English',
        'ja-JP': 'japonais / Japanese / 日本語',
        'ko-KR': 'coréen / Korean / 한국어',
        'fr-FR': 'français / French',
        'ru-RU': 'russe / Russian / Русский',
        'es-ES': 'espagnol / Spanish / Español',
    },
    'ru-RU': {
        'zh-CN': 'китайский (упрощённый) / Simplified Chinese / 简体中文',
        'zh-TW': 'китайский (традиционный) / Traditional Chinese / 繁體中文',
        'en-US': 'английский / English',
        'ja-JP': 'японский / Japanese / 日本語',
        'ko-KR': 'корейский / Korean / 한국어',
        'fr-FR': 'французский / French / Français',
        'ru-RU': 'русский / Russian',
        'es-ES': 'испанский / Spanish / Español',
    },
    'es-ES': {
        'zh-CN': 'Chino simplificado / Simplified Chinese / 简体中文',
        'zh-TW': 'Chino tradicional / Traditional Chinese / 繁體中文',
        'en-US': 'Inglés / English',
        'ja-JP': 'Japonés / Japanese / 日本語',
        'ko-KR': 'Coreano / Korean / 한국어',
        'fr-FR': 'Francés / French / Français',
        'ru-RU': 'Ruso / Russian / Русский',
        'es-ES': 'Español / Spanish',
    },
};

const uiLanguageLabelsByInterfaceLanguage: Readonly<Record<UiLanguage, Readonly<Record<UiLanguage, string>>>> = {
    ...localizedUiLanguageLabels,
    'zh-CN': multilingualUiLanguageLabels,
    'en-US': englishUiLanguageLabels,
};

export function normalizeUiLanguage(value: unknown): UiLanguage {
    if (value === 'zh-TW') return 'zh-TW';
    if (value === 'en-US') return 'en-US';
    if (value === 'ja-JP') return 'ja-JP';
    if (value === 'ko-KR') return 'ko-KR';
    if (value === 'fr-FR') return 'fr-FR';
    if (value === 'ru-RU') return 'ru-RU';
    if (value === 'es-ES') return 'es-ES';
    return DEFAULT_UI_LANGUAGE;
}

/** 将浏览器 locale 映射到当前支持的界面语言；繁體地区/文字回落 zh-TW，其余未支持语言回退简体中文。 */
export function resolveUiLanguageFromLocale(value: unknown): UiLanguage {
    if (typeof value !== 'string') return DEFAULT_UI_LANGUAGE;
    const locale = value.trim().toLowerCase().replace(/_/gu, '-');
    if (locale === 'en' || locale.startsWith('en-')) return 'en-US';
    if (locale === 'ja' || locale.startsWith('ja-')) return 'ja-JP';
    if (locale === 'ko' || locale.startsWith('ko-')) return 'ko-KR';
    if (locale === 'fr' || locale.startsWith('fr-')) return 'fr-FR';
    if (locale === 'ru' || locale.startsWith('ru-')) return 'ru-RU';
    if (locale === 'es' || locale.startsWith('es-')) return 'es-ES';
    if (locale === 'zh' || locale.startsWith('zh-')) {
        const subtags = locale.split('-').slice(1);
        if (subtags.includes('hans')) return 'zh-CN';
        if (subtags.includes('hant') || subtags.includes('tw') || subtags.includes('hk') || subtags.includes('mo')) {
            return 'zh-TW';
        }
        return 'zh-CN';
    }
    return DEFAULT_UI_LANGUAGE;
}

export function getUiLanguageDisplayLabel(language: UiLanguage, interfaceLanguage: UiLanguage = DEFAULT_UI_LANGUAGE): string {
    const labels = uiLanguageLabelsByInterfaceLanguage[normalizeUiLanguage(interfaceLanguage)];
    return Object.hasOwn(labels, language) ? labels[language] : '中文';
}
