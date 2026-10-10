/**
 * @file src/features/full-page-translation/content/translationConfigSnapshot.ts
 * 文件职责：定义单次网页翻译的配置快照，并隔离异步合批与回退链路所使用的可编辑数组。
 * 主要内容：保留服务、模型、语言、展示模式、长段落换行、译文位置、术语、原生服务合批偏好与请求覆盖字段，在入口一次读取字段并复制术语选择和排除语言列表。
 * 模块边界：只定义类型并复制传入数据，不读取全局配置、不调用 provider、不管理会话或 DOM；请求和正文回退链路共享同一复制规则。
 */
export interface FullPageTranslationConfigSnapshot {
    glossaryRevision?: string;
    glossaryIds?: readonly string[] | null;
    service: string;
    model: string;
    thinking: boolean;
    sourceLanguage: string;
    targetLanguage: string;
    excludedLanguages?: readonly string[];
    useCache: boolean;
    enableAIContext: boolean;
    enableAIMultiSegment: boolean;
    /** 缺省兼容既有会话，原生服务默认开启；新会话显式冻结服务独立偏好。 */
    enableNativeBatch?: boolean;
    displayMode: 'bilingual' | 'single';
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

/** 捕获这一调用的字段值；后续合批、等待与回退不读取调用者仍可修改的对象。 */
export function copyFullPageTranslationConfigSnapshot(snapshot: FullPageTranslationConfigSnapshot): FullPageTranslationConfigSnapshot {
    const captured = {...snapshot, enableNativeBatch: snapshot.enableNativeBatch !== false};
    if (captured.glossaryIds) captured.glossaryIds = [...captured.glossaryIds];
    if (captured.excludedLanguages) captured.excludedLanguages = [...captured.excludedLanguages];
    return captured;
}
