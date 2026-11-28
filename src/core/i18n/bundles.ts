/**
 * @file src/core/i18n/bundles.ts
 *
 * 文件职责：静态汇总中文以外六种界面语言的完整资源包，作为构建期 JSON 生成、userscript 单文件产物与测试的唯一来源。
 * 主要内容：导出包含稳定资源、旧文案词典和按语言展开的旧文案模板的 UI_LANGUAGE_BUNDLES，
 * 以及生成按需加载文件的 createUiLanguageBundleFiles、生成七语扩展名称、安装说明和工具栏提示的 createExtensionMetadataLocaleFiles。
 * 模块边界：扩展的 content、background 和扩展页面不得直接 import 本文件，否则会把六种语言重新打进每个 bundle；
 * 它们通过 src/platform/i18n 按当前界面语言加载构建产物。本文件不访问浏览器 API，也不读写配置。
 */

import {getUiLanguageBundlePath, translate} from './index';
import {createLegacyPatternSet} from './messages/legacy-patterns';
import {createExtensionSiteActionText} from './messages/siteRules';
import {zhTWLegacyText, zhTWMessages} from './messages/zh-TW';
import {enUSLegacyText, enUSMessages} from './messages/en-US';
import {esESLegacyText, esESMessages} from './messages/es-ES';
import {frFRLegacyText, frFRMessages} from './messages/fr-FR';
import {jaJPLegacyText, jaJPMessages} from './messages/ja-JP';
import {koKRLegacyText, koKRMessages} from './messages/ko-KR';
import {ruRULegacyText, ruRUMessages} from './messages/ru-RU';
import productDescriptions from './messages/product-descriptions.json';
import toolbarDescriptions from './messages/toolbar-descriptions.json';
import {UI_LANGUAGE_OPTIONS} from './language';
import type {RegisteredUiLanguage, UiLanguageBundle} from './types';

export const UI_LANGUAGE_BUNDLES: Readonly<Record<RegisteredUiLanguage, UiLanguageBundle>> = {
    'zh-TW': {messages: zhTWMessages, legacyText: zhTWLegacyText, legacyPatterns: createLegacyPatternSet('zh-TW')},
    'en-US': {messages: enUSMessages, legacyText: enUSLegacyText, legacyPatterns: createLegacyPatternSet('en-US')},
    'ja-JP': {messages: jaJPMessages, legacyText: jaJPLegacyText, legacyPatterns: createLegacyPatternSet('ja-JP')},
    'ko-KR': {messages: koKRMessages, legacyText: koKRLegacyText, legacyPatterns: createLegacyPatternSet('ko-KR')},
    'fr-FR': {messages: frFRMessages, legacyText: frFRLegacyText, legacyPatterns: createLegacyPatternSet('fr-FR')},
    'ru-RU': {messages: ruRUMessages, legacyText: ruRULegacyText, legacyPatterns: createLegacyPatternSet('ru-RU')},
    'es-ES': {messages: esESMessages, legacyText: esESLegacyText, legacyPatterns: createLegacyPatternSet('es-ES')},
};

/** 生成扩展产物中的语言资源文件；紧凑 JSON 解析远快于等价的 JavaScript 对象字面量。 */
export function createUiLanguageBundleFiles(): Array<{relativeDest: string; contents: string}> {
    return (Object.keys(UI_LANGUAGE_BUNDLES) as RegisteredUiLanguage[]).map(language => ({
        relativeDest: getUiLanguageBundlePath(language),
        contents: JSON.stringify({
            ...UI_LANGUAGE_BUNDLES[language],
            legacyText: {...UI_LANGUAGE_BUNDLES[language].legacyText, ...createExtensionSiteActionText(language)},
        }),
    }));
}

/** 构建期生成浏览器原生本地化字段，工具栏提示复用扩展品牌名称。 */
export function createExtensionMetadataLocaleFiles(): Array<{relativeDest: string; contents: string}> {
    return UI_LANGUAGE_OPTIONS.map(({value: language}) => {
        const name = language === 'zh-CN' ? translate('common.brand', language) : UI_LANGUAGE_BUNDLES[language].messages['common.brand'];
        return {
            relativeDest: `_locales/${language === 'zh-CN' ? 'zh_CN' : language === 'zh-TW' ? 'zh_TW' : language.split('-')[0]}/messages.json`,
            contents: JSON.stringify({
                extensionName: {message: name},
                extensionDescription: {message: productDescriptions[language]},
                extensionToolbarTitle: {message: `${name} · ${toolbarDescriptions[language]}`},
            }),
        };
    });
}
