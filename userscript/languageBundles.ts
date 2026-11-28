/**
 * @file userscript/languageBundles.ts
 * 文件职责：构建 userscript 的中英内嵌词典并引用已发布的五种固定远程词典。
 * 主要内容：按脚本能力裁剪当前词典，包括不挂载的原生侧栏、浏览器工具栏、菜单栏布局编辑提示、浏览器弹窗专有提示、浏览器翻译模型准备、本地离线翻译模型管理、视频字幕与学习面板外观、字幕导出对话框、不可用的本地字幕识别及漫画面板筛选文案；远程资源直接使用固定提交中的原始 JSON，构建时自动比较当前词典并生成新增与更新的稳定 key、旧文案和模板增量。增量由现有 gzip 静态资源机制携带，注册时合并，不再维护平行的手写补丁表。
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
    return Object.fromEntries(Object.entries(messages).filter(([key]) => !['learning.collection.undoExtensionNotice', 'popup.donationDescription'].includes(key)
        && !key.startsWith('informationHighlight.')
        && !key.startsWith('dictionary.')
        && !key.startsWith('scenarioPresets.')
        && !key.startsWith('commandPalette.')
        && (!key.startsWith('learning.collection.speech') || key === 'learning.collection.speechFailed')
        && !key.startsWith('contextMenu.notice.') && !key.startsWith('video.learning.') && !key.startsWith('video.learningAppearance.')
        && !key.startsWith('video.readingAnnotation.')
        && !key.startsWith('video.appearance.') && !key.startsWith('video.export') && !key.startsWith('video.ai') && !key.startsWith('video.model') && !key.startsWith('video.localMedia.')
        && !key.startsWith('writing.hotkey.')
        && !key.startsWith('document.xlsx.')
        && (!key.startsWith('video.modeShortcut.') || key === 'video.modeShortcut.title')
        && key !== 'video.nativeFullscreenHint'
        && !key.startsWith('diagnostics.')
        && !['waitingTranslation', 'crossPageContext', 'fullPassage', 'closePassage'].some(name => key === `document.pdfReading.${name}`)
        && !key.startsWith('safari.freePool.')
        && !key.startsWith('settings.services.chromePreparation.')
        && !key.startsWith('settings.localTranslation.')
        && !key.startsWith('sidepanel.')
        && !key.startsWith('toolbar.')
        && (!key.startsWith('settings.interface.popupLayout.')
            || key === 'settings.interface.popupLayout.label' || key.startsWith('settings.interface.popupLayout.modules.'))
        && key !== 'popup.donationButton' && !key.startsWith('popup.aiContext.status.') && !key.startsWith('popup.aiContext.description.')
        && !key.startsWith('popup.quickSettings.') && !key.startsWith('popup.quickTranslation.')
        && !key.startsWith('popup.compact.') && !key.startsWith('popup.displayMode.') && !key.startsWith('popup.pageFont.') && !key.startsWith('document.config.')
        && !key.startsWith('document.translationRecovery.')
        && !key.startsWith('document.retainedRevisions.') && !key.startsWith('document.translationProgress.')
        && !key.startsWith('settings.cloud.e2ee.')
        && !key.startsWith('settings.cloud.learning.')
        && !key.startsWith('settings.cloud.autoSync.'))) as T;
}
export const zhCNMessages = userscriptMessages(extensionChinese);

const materialSources = new Set(Object.keys(learningMaterialLegacyText['en-US']));
const materialPatternSources = new Set(learningMaterialPatterns.map(({pattern}) => pattern));
const nativeOnlyLegacySources = new Set([
    '移动端 / X 自动贴底', '未绘制译文', '查看全文', '复制全文',
    // 图片语言包与漫画首次下载提示由扩展提供。
    '识别阿拉伯语图片文字', '识别希伯来语图片文字',
    '需要准备阿拉伯语和英语识别资源，约 4.6 MB。复杂画面另需约 197 MB 的文字清除资源，已下载资源可重复使用。',
    '需要准备希伯来语和英语识别资源，约 3.5 MB。复杂画面另需约 197 MB 的文字清除资源，已下载资源可重复使用。',
    // 独立文档工作台专用的旧文案。共享的翻译、校订和下载操作仍由脚本词典提供。
    '文档换一种语言，阅读依然流畅',
    '论文、电子书、工作资料与字幕，从打开文件到双语阅读。',
    '文件在本地解析，待译文字会发送给你选择的翻译服务。扫描版 PDF 暂不支持文字识别。',
    '设置已更改。现有译文仍保留，按新设置翻译会从头开始。',
    '文件在本地解析，文字发送至所选服务。',
    '按页面连续阅读，可切换原文与译文',
    'PDF 译页以图像呈现，适合保留版面阅读，暂不支持复制译文。',
    '已完成的片段可在「校订译文」中查看，可随时暂停。',
    '已完成的译文已保留，继续时只翻译剩余内容。',
    '译文仅保留在本页，请下载后再离开。',
    '当前翻译和校订结果只保留在本页，离开后无法恢复。建议先下载需要的结果。',
    '重新翻译会替换现有译文和人工校订。你也可以返回并先下载当前结果。',
    // 扩展专用的云备份端到端加密、学习资产同步与自动同步报错文案。
    '同步加密口令模式已变化，请重新生成预览。',
    '云端备份使用自定义端到端加密口令保护，请先输入同步口令。',
    '同步口令不正确，或云端配置已损坏；本机配置未被修改',
    '加密口令模式无效',
    '同步口令至少需要 12 个字符，最多 1024 个字符',
    '本机学习数据已变化，请重新生成同步预览。',
    '本机学习数据写入和配置恢复失败，请重新打开设置检查；云端保留本次加密快照。',
    '合并后的单词本超出 5000 条上限，请清理后再同步',
    // 扩展专用的写作助手通用网页与文档 PPTX/XLSX/LaTeX 运行期提示文案。
    '写作助手仅支持常规网页（HTTP/HTTPS）',
    '当前富文本编辑器由页面框架托管，请复制正文后自行粘贴。',
    'PPTX 演示文稿',
    'XLSX 电子表格',
    'LaTeX 文档',
    'PPTX 文件结构无效，文件可能已损坏或扩展名不正确',
    'PPTX 中没有找到可翻译的幻灯片文字',
    'XLSX 文件结构无效，文件可能已损坏或扩展名不正确',
    'XLSX 中没有找到可翻译的单元格文字',
    '该文件不是 PDF、ePub、DOCX、PPTX 或 XLSX 二进制文档',
    'PPTX 文档状态无效，请重新打开文件',
    'XLSX 文档状态无效，请重新打开文件',
]);

// Userscript does not mount settings-video or its native ASR runtime. Keep config-diff
// field names AND provider values; only unreachable video UI/transport feedback is omitted.
const extensionOnlyNativeAsrText = new Set([
    "识别方式",
    "本机服务地址",
    "固定模型：Qwen/Qwen3-ASR-1.7B。使用标准 vLLM 音频转写接口，仅允许 127.0.0.1 或 [::1]，服务需由你事先启动。",
    "使用本机已启动的 vLLM 接口（仅限 127.0.0.1 / [::1]，模型固定为 Qwen/Qwen3-ASR-1.7B）；开始识别时才发送音频，不自动回退 Whisper。",
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
            !materialSources.has(source) && !extensionOnlyNativeAsrText.has(source) && !nativeOnlyLegacySources.has(source))),
        legacyPatterns: {
            early: bundle.legacyPatterns.early.filter(([source]) => !materialPatternSources.has(source) && source !== extensionOnlyNativeAsrPattern),
            late: bundle.legacyPatterns.late.filter(([source]) => !materialPatternSources.has(source) && source !== extensionOnlyNativeAsrPattern),
        },
    };
}

/** 所有脚本入口不挂载文档页、请求统计页面或扩展弹窗的支持说明。 */
export function userscriptPageMessages<T extends Record<string, string>>(messages: T): T {
    return Object.fromEntries(Object.entries(messages).filter(([key]) => !['learning.collection.undoExtensionNotice', 'popup.donationDescription'].includes(key)
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
