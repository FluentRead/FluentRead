/**
 * @file userscript/languageBundles.ts
 * 文件职责：构建 userscript 的中英内嵌词典并引用已发布的五种固定远程词典。
 * 主要内容：按脚本能力裁剪当前词典；远程资源直接使用固定提交中的原始 JSON，构建时自动比较当前词典并生成新增与更新的稳定 key、旧文案和模板增量。增量由现有 gzip 静态资源机制携带，注册时合并，不再维护平行的手写补丁表。
 * 发布兼容：扩展已删除的旧说明仅保留在五份已发布远程 JSON 中；中英内嵌词典使用当前扩展文案，不恢复退役说明。
 * 模块边界：只供构建期和资源验证使用；不将远程完整 JSON 打进脚本，不改扩展词典、固定文件摘要或发布提交。
 */
import {UI_LANGUAGE_BUNDLES as extensionBundles} from '../src/core/i18n/bundles';
import {zhCNMessages as extensionChinese} from '../src/core/i18n/messages/zh-CN';
import {learningMaterialLegacyText, learningMaterialPatterns} from '../src/core/i18n/messages/learningMaterials';
import type {MessageCatalog, RegisteredUiLanguage, UiLanguageBundle} from '../src/core/i18n/types';
import japanese from './languages/ja-JP.b81984c57e32c317.json';
import korean from './languages/ko-KR.f9dd4e317a3ccbac.json';
import french from './languages/fr-FR.fcc79905550b3705.json';
import russian from './languages/ru-RU.83347fe7c1e5f5da.json';
import spanish from './languages/es-ES.ccf366fbe218633c.json';

export function userscriptMessages<T extends Record<string, string>>(messages: T): T {
    return Object.fromEntries(Object.entries(messages).filter(([key]) => !['learning.collection.undoExtensionNotice'].includes(key)
        && !key.startsWith('informationHighlight.')
        && (!key.startsWith('learning.collection.speech') || key === 'learning.collection.speechFailed')
        && !key.startsWith('contextMenu.notice.') && !key.startsWith('video.learning.')
        && !key.startsWith('video.readingAnnotation.')
        && key !== 'video.nativeFullscreenHint'
        && !key.startsWith('diagnostics.')
        && !['waitingTranslation', 'crossPageContext', 'fullPassage', 'closePassage'].some(name => key === `document.pdfReading.${name}`)
        && !key.startsWith('safari.freePool.')
        && !key.startsWith('popup.compact.') && !key.startsWith('popup.displayMode.') && !key.startsWith('popup.pageFont.') && !key.startsWith('document.config.')
        && !key.startsWith('document.translationRecovery.')
        && !key.startsWith('document.retainedRevisions.') && !key.startsWith('document.translationProgress.'))) as T;
}
export const zhCNMessages = userscriptMessages(extensionChinese);

const materialSources = new Set(Object.keys(learningMaterialLegacyText['en-US']));
const materialPatternSources = new Set(learningMaterialPatterns.map(({pattern}) => pattern));

/** 按实际脚本能力投影当前词典；学习材料和文档页不随脚本构建进入本地增量。 */
export function currentUserscriptLanguageBundle(language: RegisteredUiLanguage): UiLanguageBundle {
    const bundle = extensionBundles[language];
    return {
        messages: userscriptPageMessages(userscriptMessages(bundle.messages)),
        legacyText: Object.fromEntries(Object.entries(bundle.legacyText).filter(([source]) =>
            !materialSources.has(source) && source !== '移动端 / X 自动贴底')),
        legacyPatterns: {
            early: bundle.legacyPatterns.early.filter(([source]) => !materialPatternSources.has(source)),
            late: bundle.legacyPatterns.late.filter(([source]) => !materialPatternSources.has(source)),
        },
    };
}

/** 所有脚本入口不挂载文档页或请求统计页面。 */
export function userscriptPageMessages<T extends Record<string, string>>(messages: T): T {
    return Object.fromEntries(Object.entries(messages).filter(([key]) => !['learning.collection.undoExtensionNotice'].includes(key)
        && !key.startsWith('document.') && !key.startsWith('translationStats.'))) as T;
}

export interface UserscriptLanguageUpdate extends UiLanguageBundle {
    /** 非负数引用固定资源的位置；负数引用增量的位置（-1 为首项），保留相同正则的不同译文与先后次序。 */
    readonly patternOrder?: Partial<Record<'early' | 'late', readonly number[]>>;
}

/** 保留固定基线，逐值比较当前资源；返回有序且可重复构建的最小覆盖。 */
export function createUserscriptLanguageUpdate(current: UiLanguageBundle, baseline: UiLanguageBundle): UserscriptLanguageUpdate {
    const changed = (catalog: MessageCatalog, previous: MessageCatalog) => Object.fromEntries(Object.entries(catalog)
        .filter(([key, value]) => !Object.hasOwn(previous, key) || previous[key] !== value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    const legacyPatterns: {early: UiLanguageBundle['legacyPatterns']['early']; late: UiLanguageBundle['legacyPatterns']['late']} = {early: [], late: []};
    const patternOrder: Partial<Record<'early' | 'late', readonly number[]>> = {};
    for (const phase of ['early', 'late'] as const) {
        if (JSON.stringify(current.legacyPatterns[phase]) === JSON.stringify(baseline.legacyPatterns[phase])) continue;
        const previous = new Map(baseline.legacyPatterns[phase].map((entry, index) => [JSON.stringify(entry), index]));
        const additions: (typeof current.legacyPatterns)[typeof phase][number][] = [];
        patternOrder[phase] = current.legacyPatterns[phase].map(entry => {
            const index = previous.get(JSON.stringify(entry));
            if (index !== undefined) return index;
            additions.push(entry);
            return -additions.length;
        });
        legacyPatterns[phase] = additions;
    }
    return {messages: changed(current.messages, baseline.messages), legacyText: changed(current.legacyText, baseline.legacyText), legacyPatterns,
        ...(Object.keys(patternOrder).length ? {patternOrder} : {})};
}

const embeddedEnglish: UiLanguageBundle = {...currentUserscriptLanguageBundle('en-US'),
    messages: userscriptMessages(extensionBundles['en-US'].messages)};

// 五份 JSON 的内容摘要和固定提交由发布配置测试逐字节验证；更新远程词典需要一起发布资源和提交 pin。
export const UI_LANGUAGE_BUNDLES = {
    'en-US': embeddedEnglish,
    'ja-JP': japanese as unknown as UiLanguageBundle,
    'ko-KR': korean as unknown as UiLanguageBundle,
    'fr-FR': french as unknown as UiLanguageBundle,
    'ru-RU': russian as unknown as UiLanguageBundle,
    'es-ES': spanish as unknown as UiLanguageBundle,
};
