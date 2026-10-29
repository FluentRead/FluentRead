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

// Userscript does not mount settings-video or its native ASR runtime. Keep config-diff
// field names AND provider values; only unreachable video UI/transport feedback is omitted.
const extensionOnlyNativeAsrText = new Set([
    "识别方式",
    "本机服务地址",
    "固定模型：Qwen/Qwen3-ASR-1.7B。使用标准 vLLM 音频转写接口，仅允许 127.0.0.1 或 [::1]，服务需由你事先启动。",
    "保存设置不会探测端口、启动服务或下载权重。开始 AI 字幕后才发送音频到所填本机地址；失败会报错，不自动切回 Whisper。",
    "该接口返回文本，字幕时间按音频窗口估计，并非字级对齐；此处不代表模型已经加载或已使用 GPU。",
    "请在设置中切换识别方式",
    "字幕配置尚未安全加载，请稍后重试",
    "原生转写模型与请求不一致",
    "识别配置已改变，请重新请求 AI 字幕",
    "本机转写选择、地址或语言已改变，请重新请求 AI 字幕",
    "本机转写仍在进行，请等待当前音频窗口完成",
    "原生转写需要 PCM16 音频",
    "原生模型由本机服务管理，不通过浏览器下载",
    "原生转写地址必须是本机回环地址，不接受凭据、远程地址或额外路径",
    "原生转写需要不超过30秒的16kHz单声道PCM16数据",
    "原生转写PCM16数据无效",
    "原生转写响应为空",
    "原生转写响应超过大小限制",
    "原生转写源语言必须是ISO 639-1代码或auto",
    "原生转写响应缺少text字符串",
    "原生转写超时",
    "识别设置已更改，请重新请求 AI 字幕"
]);
const extensionOnlyNativeAsrPattern = "^原生转写服务返回HTTP (\\d+)$";


/** 按实际脚本能力投影当前词典；学习材料和文档页不随脚本构建进入本地增量。 */
export function currentUserscriptLanguageBundle(language: RegisteredUiLanguage): UiLanguageBundle {
    const bundle = extensionBundles[language];
    return {
        messages: userscriptPageMessages(userscriptMessages(bundle.messages)),
        legacyText: Object.fromEntries(Object.entries(bundle.legacyText).filter(([source]) =>
            !materialSources.has(source) && !extensionOnlyNativeAsrText.has(source) && source !== '移动端 / X 自动贴底')),
        legacyPatterns: {
            early: bundle.legacyPatterns.early.filter(([source]) => !materialPatternSources.has(source) && source !== extensionOnlyNativeAsrPattern),
            late: bundle.legacyPatterns.late.filter(([source]) => !materialPatternSources.has(source) && source !== extensionOnlyNativeAsrPattern),
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
