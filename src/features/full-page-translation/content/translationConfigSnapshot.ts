/**
 * @file src/features/full-page-translation/content/translationConfigSnapshot.ts
 * 文件职责：定义单次网页翻译的配置快照，并隔离异步合批与回退链路所使用的可编辑数组。
 * 主要内容：保留显式显示模式覆盖标记以隔离即时呈现切换；保留组合成员连接摘要及通用 AI 上下文能力、服务、模型、语言、展示模式、长段落换行、译文位置、术语、AI 合批段数和字符预算、原生服务合批偏好与请求覆盖字段，在入口归一化预算并复制术语选择和排除语言列表。
 * 模块边界：只定义类型并复制传入数据，不读取全局配置、不调用 provider、不管理会话或 DOM；请求和正文回退链路共享同一复制规则。
 */
import {normalizeAiMultiSegmentMaxCharacters, normalizeAiMultiSegmentMaxSegments} from '@/src/core/config/aiMultiSegment';
import {isTextInLanguage} from '@/src/core/language/detect';

export interface FullPageTranslationConfigSnapshot {
    glossaryRevision?: string;
    glossaryIds?: readonly string[] | null;
    service: string;
    /** 组合及成员连接的安全摘要，避免修改配置后复用旧的前端会话译文。 */
    compositeConnectionFingerprint?: string;
    /** 冻结组合是否至少有一名通用提示词 AI 成员，用于准备其可消费的篇章上下文。 */
    compositeAIContext?: boolean;
    model: string;
    thinking: boolean;
    sourceLanguage: string;
    sourceLanguageOnly?: true;
    targetLanguage: string;
    excludedLanguages?: readonly string[];
    useCache: boolean;
    enableAIContext: boolean;
    enableAIMultiSegment: boolean;
    /** 缺省兼容旧会话；入口冻结归一化后的 AI 文本槽数与原文字符预算。 */
    aiMultiSegmentMaxSegments?: number;
    aiMultiSegmentMaxCharacters?: number;
    /** 缺省兼容既有会话，原生服务默认开启；新会话显式冻结服务独立偏好。 */
    enableNativeBatch?: boolean;
    displayMode: 'bilingual' | 'single';
    /** 显式快捷方案的展示方式保持本次覆盖；普通网页显示可由弹窗即时切换。 */
    displayModeOverridden?: true;
    style: number;
    /** 调用入口冻结的展示设置；外部手工快照缺省沿用 renderer 的当前设置。 */
    longParagraphLineBreak?: boolean;
    translationBeforeOriginal?: boolean;
    profileId?: string;
    requestOverridesApplied?: true;
}

/** 单次快捷翻译可覆盖的公开请求维度；未提供的字段继续跟随全局网页设置。 */
export interface PageTranslationConfigOverrides {
    glossaryIds?: readonly string[] | null;
    service?: string;
    model?: string;
    targetLanguage?: string;
    displayMode?: 'bilingual' | 'single';
    profileId?: string;
}

/** 严格模式只让可信识别为用户指定源语言的正文通过。 */
export function allowsPageSourceLanguage(snapshot: Pick<FullPageTranslationConfigSnapshot, 'sourceLanguage' | 'sourceLanguageOnly'>, source: string): boolean {
    return !snapshot.sourceLanguageOnly || snapshot.sourceLanguage === 'auto' || isTextInLanguage(source, snapshot.sourceLanguage);
}

/** 捕获这一调用的字段值；后续合批、等待与回退不读取调用者仍可修改的对象。 */
export function copyFullPageTranslationConfigSnapshot(snapshot: FullPageTranslationConfigSnapshot): FullPageTranslationConfigSnapshot {
    const captured = {...snapshot,
        aiMultiSegmentMaxSegments: normalizeAiMultiSegmentMaxSegments(snapshot.aiMultiSegmentMaxSegments),
        aiMultiSegmentMaxCharacters: normalizeAiMultiSegmentMaxCharacters(snapshot.aiMultiSegmentMaxCharacters),
        enableNativeBatch: snapshot.enableNativeBatch !== false};
    if (captured.glossaryIds) captured.glossaryIds = [...captured.glossaryIds];
    if (captured.excludedLanguages) captured.excludedLanguages = [...captured.excludedLanguages];
    return captured;
}
