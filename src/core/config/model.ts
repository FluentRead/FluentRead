/**
 * @file src/core/config/model.ts
 *
 * 文件职责：定义 FluentRead 完整配置模型、默认值及各项设置的合法范围，是配置读取、保存、迁移和 UI 绑定共同依赖的领域契约。
 * 主要内容：包含正文/全部节点识别范围，保留各功能独立服务，并将所有功能服务的空值解释为继承网页默认；统一中文简繁标识及历史配置别名，并保存常用服务顺序，包含 Config 接口、defaultConfig、字幕和翻译模式类型、延迟与字号范围、默认 API 地址及多项功能开关，使新增配置项在一个位置获得类型和初始语义；归一化时把仍停留在历史默认值的翻译提示词升级为当前默认提示词。 可核对的公开符号包括 DeepSeekApiType、DeepSeekThinkingMode、VideoSubtitleDisplayMode、FullPageTranslationMode、DEFAULT_VIDEO_SUBTITLE_FONT_SIZE、DEFAULT_NEW_API_URL、DEFAULT_MOUSE_HOVER_TRANSLATION_DELAY。
 * 模块边界：本文件属于 core 领域层，只定义规则、类型与纯转换；不直接读写浏览器存储、不发起网络请求、不挂载 Vue/WXT 入口，持久化、协议调用和界面编排分别由 services、providers 与 features 承担。
 */

import {DEFAULT_SENTENCE_HIGHLIGHT_STYLE, DEFAULT_SENTENCE_HIGHLIGHT_APPEARANCE, normalizeSentenceHighlightStyle, normalizeSentenceHighlightAppearance, normalizeSentenceHighlightProfiles, type SentenceHighlightStyle, type SentenceHighlightAppearance, type SentenceHighlightProfile} from './sentenceHighlight';
import {normalizeShareCardPreferences, type ShareCardPreferences} from '@/src/core/config/shareCard';
import type {TranslationScope} from '@/src/core/translation/types';
import {
    currentModelIds,
    defaultModelIds,
    defaultModels,
    defaultOption,
    options,
    LEGACY_DEFAULT_USER_ROLES,
    models,
    resolveCloudRegion,
    resolveConfiguredModel,
    services,
    servicesType,
} from "./catalog";
import type { MiniMaxBillingPlan, MiniMaxRegion, MiMoBillingPlan, MiMoRegion } from "./catalog";
import {
    getCustomOpenAIProvider,
    isConfiguredCustomOpenAIProvider,
    isCustomOpenAIProviderId,
    LEGACY_CUSTOM_OPENAI_PROVIDER_ID,
    CUSTOM_OPENAI_RESERVED_MODEL_ID,
    MAX_CUSTOM_OPENAI_MODELS_PER_PROVIDER,
    normalizeCustomOpenAIModels,
    normalizeCustomOpenAIProviders,
    type CustomOpenAIProvider,
} from './customOpenAI';
import {
    DEFAULT_FREE_TRANSLATION_ORDER, DEFAULT_FREE_TRANSLATION_TIMEOUT_MS, DEFAULT_FREE_TRANSLATION_COOLDOWN_MS,
    normalizeFreeTranslationOrder, normalizeFreeTranslationTimeoutMs, normalizeFreeTranslationCooldownMs,
    normalizeMyMemoryEmail, DEFAULT_FREE_TRANSLATION_MODE,
    normalizeFreeTranslationMode, type FreeTranslationMode,
} from './freeTranslation';
import { normalizeCustomBodyMapping } from "./customBody";
import {DEFAULT_DEEPL_API_PLAN, normalizeDeepLApiPlan, type DeepLApiPlan} from './deepl';
import {
    normalizeModelThinkingMapping,
    type ModelThinkingMapping,
} from './modelThinking';
import {
    API_KEY_REQUIREMENT_KEY_PREFIX,
    createApiKeyRequirementKey,
    getLegacyApiKeyRequirementKey,
    parseApiKeyRequirementKey,
} from './validation';
import {isSensitiveConfigKey} from './sensitiveKeys';
import {normalizeContextMenuEntryPreferences, type ContextMenuEntryPreferences} from '@/src/core/context-menu/domain';
import {
    DEFAULT_TRANSLATION_CACHE_MAX_BYTES,
    DEFAULT_TRANSLATION_CACHE_MAX_ENTRIES,
    normalizeTranslationCacheLimits,
} from './translationCache';
import {normalizeChineseLanguageCode} from '@/src/core/language/chinese';
import {resolveConfiguredHotkey} from '@/src/core/hotkey';
import {
    DEFAULT_AREA_TRANSLATION_HOTKEY,
    normalizeAreaTranslationHotkey,
    normalizeCustomAreaTranslationHotkey,
    resolveAreaTranslationHotkey,
} from '@/src/core/config/areaTranslation';
import {
    DEFAULT_PARAGRAPH_COPY_CONTENT_MODE,
    DEFAULT_PARAGRAPH_COPY_HOTKEY,
    normalizeCustomParagraphCopyHotkey,
    normalizeParagraphCopyContentMode,
    normalizeParagraphCopyHotkey,
    resolveParagraphCopyHotkey,
    type ParagraphCopyContentMode,
} from '@/src/core/config/paragraphCopy';
import {
    DEFAULT_SECTION_TRANSLATION_HOTKEY,
    normalizeCustomSectionTranslationHotkey,
    normalizeSectionTranslationHotkey,
    resolveSectionTranslationHotkey,
} from '@/src/core/config/sectionTranslation';
import { normalizeSelectionTtsVoiceOrder } from "./selectionTts";
import {
    DEFAULT_LOCAL_TTS_MODE,
    DEFAULT_LOCAL_TTS_VOICE,
    normalizeLocalTtsMode,
    normalizeLocalTtsVoice,
    type LocalTtsMode,
    type LocalTtsVoiceId,
} from './localTts';
import { normalizeUiLanguage, type UiLanguage } from '@/src/core/i18n/language';
import {normalizeGlossaryIds, normalizeGlossaryLibraries, type GlossaryLibrary} from '@/src/core/glossary';
import {
    inputBoxTranslationTriggerHotkey,
    normalizeQuickTranslationProfiles,
    type QuickTranslationProfile,
} from './quickTranslation';
import {
    DEFAULT_INPUT_BOX_TRANSLATION_INTERVAL,
    normalizeInputBoxTranslationInterval,
    normalizeInputBoxTranslationModel,
    normalizeInputBoxTranslationOutputMode,
    normalizeInputBoxTranslationPrompt,
    normalizeInputBoxTranslationService,
    type InputBoxTranslationOutputMode,
} from './inputTranslation';
import {
    DEFAULT_INTERFACE_FONT,
    DEFAULT_INTERFACE_VISIBILITY,
    DEFAULT_POPUP_MODULE_ORDER,
    DEFAULT_POPUP_QUICK_FEATURE_ORDER,
    DEFAULT_POPUP_QUICK_FEATURE_VISIBILITY,
    normalizeInterfaceFont,
    normalizeInterfaceSkin,
    normalizeInterfaceVisibility,
    normalizePopupModuleOrder,
    normalizePopupQuickFeatureOrder,
    normalizePopupQuickFeatureVisibility,
    type InterfaceFont,
    type InterfaceSkin,
    type InterfaceVisibility,
    type PopupModuleId,
    type PopupQuickFeatureId,
    type PopupQuickFeatureVisibility,
} from './interfaceAppearance';
import {
    DEFAULT_TRANSLATION_LOADING_STYLE,
    normalizeTranslationLoadingStyle,
    type TranslationLoadingStyle,
} from './translationLoadingStyle';
import {
    normalizeAlwaysTranslateDomains,
    normalizeDisabledExtensionDomains,
    normalizeFloatingBallDisabledDomains,
} from "@/src/core/site-rules/domain";
import {normalizeSiteAdaptationSettings} from '@/src/core/site-adaptation/schema';
import type {SiteAdaptationSettings} from '@/src/core/site-adaptation/types';
import {
    DEFAULT_MAX_CONCURRENT_TRANSLATIONS,
    DEFAULT_TRANSLATION_BACKOFF_BASE_MS,
    DEFAULT_TRANSLATION_BACKOFF_MAX_MS,
    DEFAULT_TRANSLATION_MAX_RETRIES,
    DEFAULT_TRANSLATION_REQUESTS_PER_MINUTE,
    DEFAULT_TRANSLATION_REQUESTS_PER_SECOND,
    DEFAULT_API_KEY_RECOVERY_MS,
    normalizeMaxConcurrentTranslations,
    normalizeApiKeyRecoveryMs,
    normalizeTranslationBackoffBaseMs,
    normalizeTranslationBackoffMaxMs,
    normalizeTranslationMaxRetries,
    normalizeTranslationRequestsPerMinute,
    normalizeTranslationRequestsPerSecond,
} from './scheduling';
import {
    normalizeModelRequestLimits,
    normalizeServiceRequestLimits,
    type ModelRequestLimits,
    type ServiceRequestLimits,
} from './requestLimits';
import {
    DEFAULT_EAGER_TRANSLATION_CHARACTERS,
    DEFAULT_MIN_TRANSLATION_TEXT_LENGTH,
    normalizeEagerTranslationCharacters,
    normalizeExcludedLanguages,
    normalizeMinTranslationTextLength,
} from './pageTranslation';
import {normalizeWritingPreferences, type WritingPreferences} from './writing';
import {DEFAULT_HARNESS_PREFERENCES, normalizeHarnessPreferences, type HarnessPreferences} from './harness';
import {
    DEFAULT_VIDEO_SUBTITLE_APPEARANCE,
    normalizeVideoSubtitleAppearance,
    type VideoSubtitleAppearance,
} from './videoSubtitleAppearance';
import {
    DEFAULT_TRANSLATION_APPEARANCE,
    normalizeTranslationAppearance,
    normalizeTranslationStyleProfiles,
    type TranslationAppearance,
    type TranslationStyleProfile,
} from './translationAppearance';
import {
    DEFAULT_AREA_VISION_PROMPT,
    normalizeAreaVisionPrompt,
    normalizeModelVisionOverrides,
    type AreaRecognitionMode,
    type ModelVisionOverrides,
} from './vision';
import {apiKeysToToken, normalizeApiKeys} from './apiKeys';

export * from './scheduling';
export * from './pageTranslation';

export type DeepSeekApiType = 'auto' | 'responses' | 'chat';
export type DeepSeekThinkingMode = 'enabled' | 'disabled';
export type VideoSubtitleDisplayMode = 'bilingual' | 'translation-only' | 'original-only';
export type VideoLocalTranscriptionModel = 'tiny' | 'base';
export type FullPageTranslationMode = 'viewport' | 'all';
export const DEFAULT_VIDEO_SUBTITLE_FONT_SIZE = 100;
export const DEFAULT_NEW_API_URL = 'http://localhost:3000';
export const VIDEO_SOURCE_LANGUAGE_OPTIONS = [
    {value: 'auto', label: '自动检测'},
    {value: 'en', label: 'English'},
    {value: 'zh-Hans', label: '中文'},
    {value: 'ja', label: '日本語'},
    {value: 'ko', label: '한국어'},
    {value: 'fr', label: 'Français'},
    {value: 'ru', label: 'Русский'},
    {value: 'es', label: 'Español'},
    {value: 'de', label: 'Deutsch'},
    {value: 'pt', label: 'Português'},
    {value: 'it', label: 'Italiano'},
] as const;
export const DEFAULT_MOUSE_HOVER_TRANSLATION_DELAY = 50;
export const MOUSE_HOVER_TRANSLATION_DELAY_MIN = 0;
export const MOUSE_HOVER_TRANSLATION_DELAY_MAX = 2000;
export const MOUSE_HOVER_TRANSLATION_DELAY_STEP = 10;
export const DEFAULT_SELECTION_TRANSLATOR_DELAY = 300;
export const SELECTION_TRANSLATOR_DELAY_MIN = 0;
export const SELECTION_TRANSLATOR_DELAY_MAX = 2000;
export const SELECTION_TRANSLATOR_DELAY_STEP = 50;

export function normalizeVideoSubtitleFontSize(value: unknown): number {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) return DEFAULT_VIDEO_SUBTITLE_FONT_SIZE;
    return Math.min(160, Math.max(80, Math.round(number / 10) * 10));
}

/** 字幕延后为正、提前为负，按半秒调整，最多正负十秒。 */
export function normalizeVideoSubtitleOffsetMs(value: unknown): number {
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) ? Math.min(10_000, Math.max(-10_000, Math.round(number / 500) * 500)) || 0 : 0;
}

export function normalizeMouseHoverTranslationDelay(value: unknown): number {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) return DEFAULT_MOUSE_HOVER_TRANSLATION_DELAY;
    const rounded = Math.round(number / MOUSE_HOVER_TRANSLATION_DELAY_STEP) * MOUSE_HOVER_TRANSLATION_DELAY_STEP;
    return Math.min(
        MOUSE_HOVER_TRANSLATION_DELAY_MAX,
        Math.max(MOUSE_HOVER_TRANSLATION_DELAY_MIN, rounded),
    );
}

export type FloatingBallToolsDisplay = 'hover' | 'always' | 'hidden';
export type FloatingBallClickAction = 'translate' | 'settings' | 'none';
export const FLOATING_BALL_TOOLS_DISPLAY_VALUES: readonly FloatingBallToolsDisplay[] = ['hover', 'always', 'hidden'];
export const FLOATING_BALL_CLICK_ACTION_VALUES: readonly FloatingBallClickAction[] = ['translate', 'settings', 'none'];
export const DEFAULT_FLOATING_BALL_HOVER_DELAY = 0;
export const FLOATING_BALL_HOVER_DELAY_MIN = 0;
export const FLOATING_BALL_HOVER_DELAY_MAX = 2000;
export const FLOATING_BALL_HOVER_DELAY_STEP = 50;
export const DEFAULT_FLOATING_BALL_COLLAPSED_OPACITY = 52;
export const FLOATING_BALL_COLLAPSED_OPACITY_MIN = 20;
export const FLOATING_BALL_COLLAPSED_OPACITY_MAX = 100;
export const FLOATING_BALL_COLLAPSED_OPACITY_STEP = 4;

function clampStepped(value: unknown, fallback: number, min: number, max: number, step: number): number {
    const number = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
            ? Number(value)
            : Number.NaN;
    if (!Number.isFinite(number)) return fallback;
    const rounded = Math.round(number / step) * step;
    return Math.min(max, Math.max(min, rounded));
}

/** 悬浮球工具按钮展开前的指针停留时间，避免划过页面边缘时误展开。 */
export function normalizeFloatingBallHoverDelay(value: unknown): number {
    return clampStepped(
        value,
        DEFAULT_FLOATING_BALL_HOVER_DELAY,
        FLOATING_BALL_HOVER_DELAY_MIN,
        FLOATING_BALL_HOVER_DELAY_MAX,
        FLOATING_BALL_HOVER_DELAY_STEP,
    );
}

/** 悬浮球收起时的不透明度百分比；数值越小越不遮挡网页内容。 */
export function normalizeFloatingBallCollapsedOpacity(value: unknown): number {
    return clampStepped(
        value,
        DEFAULT_FLOATING_BALL_COLLAPSED_OPACITY,
        FLOATING_BALL_COLLAPSED_OPACITY_MIN,
        FLOATING_BALL_COLLAPSED_OPACITY_MAX,
        FLOATING_BALL_COLLAPSED_OPACITY_STEP,
    );
}

/** 拖动后的视口纵向比例；旧配置用 null 保持居中，无效值不进入布局计算。 */
export function normalizeFloatingBallVerticalPosition(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(1, Math.max(0, value))
        : null;
}

export function normalizeFloatingBallToolsDisplay(value: unknown): FloatingBallToolsDisplay {
    return FLOATING_BALL_TOOLS_DISPLAY_VALUES.includes(value as FloatingBallToolsDisplay)
        ? value as FloatingBallToolsDisplay
        : 'hover';
}

export function normalizeFloatingBallClickAction(value: unknown): FloatingBallClickAction {
    return FLOATING_BALL_CLICK_ACTION_VALUES.includes(value as FloatingBallClickAction)
        ? value as FloatingBallClickAction
        : 'translate';
}

export function normalizeSelectionTranslatorDelay(value: unknown): number {
    const number = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
            ? Number(value)
            : Number.NaN;
    if (!Number.isFinite(number)) return DEFAULT_SELECTION_TRANSLATOR_DELAY;
    const rounded = Math.round(number / SELECTION_TRANSLATOR_DELAY_STEP) * SELECTION_TRANSLATOR_DELAY_STEP;
    return Math.min(
        SELECTION_TRANSLATOR_DELAY_MAX,
        Math.max(SELECTION_TRANSLATOR_DELAY_MIN, rounded),
    );
}

interface IMapping {
    [key: string]: string;
}

// 内包，存储额外信息
interface IExtra {
    [key: string]: any
}

export class Config {
    on: boolean; // 是否开启
    uiLanguage: UiLanguage; // 扩展界面语言，不影响网页翻译的目标语言
    uiLanguageSetupCompleted: boolean; // 是否已完成首次 Popup 的界面语言选择
    autoTranslate: boolean; // 是否即时翻译
    alwaysTranslateDomains: string[]; // 始终自动翻译的可注册域名（eTLD+1）
    disabledExtensionDomains: string[]; // 禁用扩展的可注册域名（eTLD+1）
    siteAdaptation: SiteAdaptationSettings; // 网站内容范围、保护区域及本地 JSON 适配规则
    from: string;
    to: string;
    excludedLanguages: string[]; // 网页全文、悬浮及标题翻译跳过的语言
    hotkey: string;
    hoverShortcutBeforeDisable: string; // 关闭默认悬停开关前的选择，重开恢复；不参与运行时触发
    style: number;
    translationAppearance: TranslationAppearance; // 双语译文的颜色、线条、底色、字号、字重、字体与不透明度微调
    translationStyleProfiles: TranslationStyleProfile[]; // 用户保存的可命名译文样式快照
    activeTranslationStyleProfileId: string; // 当前选中的样式快照；外观可继续编辑，保存时再更新快照
    display: number = 1;
    service: string;
    hoverTranslationService: string; // 悬浮翻译服务，空值跟随默认网页服务
    selectionTranslationService: string; // 普通划词翻译服务，空值跟随默认网页服务
    imageTranslationService: string; // 图片 OCR 后的文字翻译服务，空值跟随默认网页服务
    documentService: string; // 文档服务，空值跟随网页默认
    documentModel: IMapping; // 文档翻译按服务保存的独立模型选择
    documentCustomModel: IMapping; // 文档翻译按服务保存的独立自定义模型
    videoTranslationEnabled: boolean; // 是否启用视频字幕翻译 Beta
    videoMeetingAutoEnabled: boolean; // 自动开启会议平台的本地字幕显示
    videoPreferHumanSubtitles: boolean; // 优先使用目标语言人工字幕
    videoService: string; // 字幕服务，空值跟随网页默认
    videoLocalModel: VideoLocalTranscriptionModel; // X 无原生字幕时使用的本地 Whisper 模型
    videoSourceLanguage: string; // 视频原语言，auto 表示自动识别；独立于网页翻译 from
    videoServiceDefaultMigrated: boolean; // 是否已迁移视频字幕默认服务
    videoSubtitleVisible: boolean; // 是否显示 FluentRead 视频字幕
    videoSubtitleDisplayMode: VideoSubtitleDisplayMode; // 视频字幕显示模式
    videoSubtitleFontSize: number; // 视频字幕字号百分比
    videoSubtitleOffsetMs: number; // 字幕时间偏移，正数延后、负数提前
    videoSubtitleAppearance: VideoSubtitleAppearance; // 视频字幕皮肤与布局参数
    token: IMapping;
    apiKeys: Record<string, string[]>; // 按服务保存完整有序 API Key 列表；token 镜像首个 key
    apiKeyRotationEnabled: Record<string, boolean>; // 按服务启用多 Key 轮询；关闭时只使用首个 Key
    secret: IMapping; // 与 token 配对的第二段密钥（阿里云/百度/火山等云服务厂商）
    serviceRegion: IMapping; // 云服务厂商所选地域，决定签名 scope 与请求域名
    requireApiKey: Record<string, boolean>; // 按服务和模型保存 API Key 校验开关
    minimaxBillingPlan: MiniMaxBillingPlan; // MiniMax 计费方案
    minimaxRegion: MiniMaxRegion; // MiniMax API 区域
    mimoBillingPlan: MiMoBillingPlan; // MiMo 计费方案
    mimoRegion: MiMoRegion; // MiMo Token Plan API 集群
    ak: string;
    sk: string;
    appid: string;
    key: string;
    model: IMapping;
    customModel: IMapping;  // 当前启用的自定义模型名称（兼容旧版运行时）
    customModels: Record<string, string[]>; // 按内置服务保存的自定义模型列表
    modelThinking: ModelThinkingMapping; // 按服务和实际模型保存 Thinking 开关，缺省为关闭
    customOpenAIProviders: CustomOpenAIProvider[]; // 用户保存的 OpenAI-compatible 自定义服务（不含凭据）
    favoriteServices: string[]; // 用户标记的常用翻译服务，按标记顺序保存
    customHeaders: IMapping; // 自定义服务 HTTP 请求头 JSON，按服务隔离并作为凭据保存
    customBody: IMapping;  // 自定义请求体（JSON 字符串，按服务存储），会合并进请求体
    proxy: IMapping;  // 代理地址
    custom: string; // 本地服务地址
    extra: IExtra;  // 额外信息（内包信息）
    system_role: IMapping;
    user_role: IMapping;
    count: number;  // 翻译次数
    theme: string;  // 主题模式：'auto' | 'light' | 'dark'
    shareCard: ShareCardPreferences; // 双语卡片外观，不保存摘录正文
    interfaceSkin: InterfaceSkin; // 扩展界面皮肤；默认保留当前界面
    interfaceFont: InterfaceFont; // 设置页和扩展弹窗使用的字体方案
    interfaceVisibility: InterfaceVisibility; // Popup 栏目可见性
    popupModuleOrder: PopupModuleId[]; // Popup 可编排模块的显示顺序
    popupQuickFeatureOrder: PopupQuickFeatureId[]; // 快捷功能卡片的显示顺序
    popupQuickFeatureVisibility: PopupQuickFeatureVisibility; // 单张快捷功能卡片的可见性
    useCache: boolean; // 是否使用缓存
    translationCacheMaxBytes: number; // 翻译缓存内容容量上限（字节）
    translationCacheMaxEntries: number; // 翻译缓存条数上限
    enableAIContext: boolean; // 是否为 AI 翻译附加网页上下文
    glossaryEnabled: boolean; // 是否在支持的翻译服务中使用本地术语库
    glossaryLibraries: GlossaryLibrary[]; // 有序术语库；首个匹配译名优先
    documentGlossaryIds: string[] | null; // 文档术语选择；null 跟随全局，空数组停用
    videoGlossaryIds: string[] | null; // 字幕术语选择；null 跟随全局，空数组停用
    enableAIMultiSegment: boolean; // 是否把相邻全文段落合并为一次 AI 翻译请求
    bilingualSentenceHighlightEnabled: boolean; // 是否在双语翻译中同步高亮原文与译文
    bilingualSentenceHighlightProfiles: SentenceHighlightProfile[]; // 命名的逐句高亮快照，包含 CSS
    activeSentenceHighlightProfileId: string; // 当前选中快照，编辑草稿不覆盖已保存内容
    bilingualSentenceHighlightAppearance: SentenceHighlightAppearance; // 逐句高亮自定义绘制外观
    bilingualSentenceHighlightStyle: SentenceHighlightStyle; // 逐句高亮外观，与译文整体样式独立
    contextMenuEnabled: boolean; // 右键菜单总开关
    contextMenuEntries: ContextMenuEntryPreferences; // 右键菜单各入口的显示偏好；未设置的入口按产品默认值
    contextMenuShowTargetLanguage: boolean; // 右键菜单标题是否标出译入语言
    contextMenuShowShortcut: boolean; // 右键菜单标题是否标出全文翻译快捷键
    pageTitleTranslationEnabled: boolean; // 全文翻译时是否一并翻译页面标题
    translationScope: TranslationScope; // 页面识别正文或全部可见界面文字
    sidebarTranslationEnabled: boolean; // 正文范围下是否一并翻译侧边栏与导航区域
    minTranslationTextLength: number; // 段落参与翻译所需的最少字符数
    eagerTranslationCharacters: number; // 进入网页后无需滚动即可直接翻译的字符数
    longParagraphLineBreakEnabled: boolean; // 长段落译文是否按句插入换行
    translationBeforeOriginal: boolean; // 双语模式下译文是否排在原文之前
    fullPageTranslationMode: FullPageTranslationMode; // 全文翻译按视口加载或立即处理整页
    disableFloatingBall: boolean; // 是否禁用悬浮球
    floatingBallPosition: 'left' | 'right'; // 悬浮球位置
    floatingBallVerticalPosition: number | null; // 悬浮球中心相对视口高度的比例；null 表示居中
    floatingBallHotkey: string; // 悬浮球快捷键
    customFloatingBallHotkey: string; // 自定义悬浮球快捷键
    floatingBallToolsDisplay: FloatingBallToolsDisplay; // 悬浮球上翻译与设置按钮的显示方式
    floatingBallHoverDelay: number; // 指针停留多久后展开悬浮球按钮（毫秒）
    floatingBallClickAction: FloatingBallClickAction; // 点击悬浮球主体时执行的动作
    floatingBallCompact: boolean; // 是否使用更小的悬浮球尺寸，减少对网页内容的遮挡
    floatingBallSettingsEntryVisible: boolean; // 是否在悬浮球上显示打开设置页的入口
    floatingBallCollapsedOpacity: number; // 悬浮球收起时的不透明度百分比
    floatingBallDisabledDomains: string[]; // 不显示悬浮球的可注册域名（eTLD+1）
    customHotkey: string; // 自定义鼠标悬浮快捷键
    quickTranslationProfiles: QuickTranslationProfile[]; // 额外快捷翻译方案；悬浮与全文各最多 8 项
    mouseHoverTranslationDelay: number; // 鼠标悬浮翻译触发延迟（毫秒）
    paragraphCopyEnabled: boolean; // 是否启用"复制鼠标所指段落"快捷键
    paragraphCopyHotkey: string; // 段落复制触发快捷键；'custom' 表示使用自定义组合键
    customParagraphCopyHotkey: string; // 自定义段落复制快捷键
    paragraphCopyContent: ParagraphCopyContentMode; // 段落复制写入剪贴板的内容口径
    sectionTranslationHotkeyEnabled: boolean; // 是否用快捷键进入局部翻译的区域选择模式
    sectionTranslationHotkey: string; // 局部翻译快捷键；'custom' 表示使用自定义组合键
    customSectionTranslationHotkey: string; // 自定义局部翻译快捷键
    disableSelectionTranslator: boolean; // 是否禁用划词翻译
    selectionAreaEnabled: boolean; // 是否启用圈选翻译
    selectionAreaHotkey: string; // 圈选翻译触发快捷键；'custom' 表示使用自定义组合键
    customSelectionAreaHotkey: string; // 自定义圈选翻译快捷键
    areaTranslationMode: 'standard' | 'ai'; // 圈选文字的标准翻译或 AI 上下文增强
    areaTranslationService: string; // 圈选独立翻译服务；空字符串跟随当前服务
    areaRecognitionMode: AreaRecognitionMode; // 圈选优先使用模型识图，模型不支持时回退本地 OCR
    areaVisionPrompt: string; // 模型识图时发送的图片文字提取指令
    modelVision: ModelVisionOverrides; // 按服务和精确模型保存的视觉能力显式覆盖
    imageTranslationHoverEnabled: boolean; // 是否显示图片悬浮入口
    imageTranslationContextMenuEnabled: boolean; // 是否显示图片右键入口
    disableImageTranslator: boolean; // 是否禁用图片翻译
    freeTranslationOrder: string[]; // 免费服务的启用列表与回退顺序
    freeTranslationMode: FreeTranslationMode; // 默认按权重随机分配健康服务
    freeTranslationTimeoutMs: number; // 每路服务最长等待
    freeTranslationCooldownMs: number; // 失败服务的暂时跳过时间
    myMemoryEmail: string; // MyMemory 可选额度联系邮箱
    deeplApiPlan: DeepLApiPlan; // DeepL API Free / Pro 套餐
    deeplx: string; // DeepLX 服务地址
    selectionTranslatorMode: string; // 划词翻译显示模式: 'disabled' | 'bilingual' | 'translation-only'
    selectionTranslatorModeBeforeDisable: 'bilingual' | 'translation-only'; // 关闭前的显示偏好，重开恢复
    selectionTranslatorPresentation: 'simple' | 'card'; // 划词翻译的默认呈现，独立于原文/译文显示偏好
    selectionTranslatorTrigger: string; // 划词翻译互斥触发方式: 'direct' | 'icon' | 'dot' | 'hover' | 'contextMenu' | 'Control' | 'Alt' | 'Shift' | 'custom'
    selectionTranslatorHotkey: string; // 旧版快捷键字段；与 selectionTranslatorTrigger 中的快捷键选项保持镜像
    customSelectionTranslatorHotkey: string; // 自定义划词翻译快捷键
    selectionTranslatorDelay: number; // 选区稳定后显示划词翻译入口的延迟（毫秒）
    selectionTranslatorAutoDismiss: boolean; // 继续阅读或复制原文时收起，避免浮层长时间遮挡页面
    selectionTranslatorBidirectional: boolean; // 中英目标下为同语言选区提供反向划词入口
    selectionTtsVoices: string[]; // 划词朗读的 Edge TTS 音色回退顺序
    selectionTtsMode: LocalTtsMode; // 朗读在线/本地合成策略
    selectionTtsLocalVoice: LocalTtsVoiceId; // 本地 Kokoro 音色，auto 表示按语言选择
    vocabularyBookEnabled: boolean; // 是否启用本地单词本 Beta
    newApiUrl: string; // NewAPI地址
    maxConcurrentTranslations: number; // 最大并发翻译数量
    translationRequestsPerSecond: number; // 每秒最多启动的翻译请求数，0 表示不限速
    translationRequestsPerMinute: number; // 每分钟最多启动的翻译请求数，0 表示不限速
    serviceRequestLimits: ServiceRequestLimits; // 按服务保存的独立请求限流配置
    modelRequestLimits: ModelRequestLimits; // 按服务和模型保存的独立请求限流配置
    apiKeyRecoveryMs: number; // API Key 失败后的默认冷却恢复时间
    translationMaxRetries: number; // 单次翻译失败后的最大重试次数
    translationBackoffBaseMs: number; // 指数退避初始间隔
    translationBackoffMaxMs: number; // 指数退避最大间隔
    youdaoAppKey: string; // 有道翻译 App Key
    youdaoAppSecret: string; // 有道翻译 App Secret
    tencentSecretId: string; // 腾讯云 Secret ID
    tencentSecretKey: string; // 腾讯云 Secret Key
    azureOpenaiEndpoint: string; // Azure 端点地址
    animations: boolean; // 是否启用动画效果
    translationLoadingStyle: TranslationLoadingStyle; // 网页段落翻译加载指示器样式
    translationProgressPanelEnabled: boolean; // 是否显示全文翻译进度面板
    inputBoxTranslationTrigger: string; // 输入框翻译触发方式
    inputBoxTranslationTarget: string; // 输入框翻译目标语言
    inputBoxTranslationOutputMode: InputBoxTranslationOutputMode; // 替换原文或双语输出顺序
    inputBoxTranslationInterval: number; // 输入框翻译相邻触发的最大间隔（毫秒）
    inputBoxTranslationService: string; // 输入框服务，空值跟随网页默认
    inputBoxTranslationModel: string; // 输入框翻译独立模型，空值跟随服务模型
    inputBoxTranslationPrompt: string; // 输入框翻译独立用户提示词，空值使用内置默认
    inputBoxTranslationSystemPrompt: string; // 输入框翻译独立系统提示词，空值使用内置默认
    deepseekApiType: DeepSeekApiType; // DeepSeek API 格式
    deepseekThinkingMode: DeepSeekThinkingMode; // DeepSeek Chat Completion 思考模式
    translationCenterServices: string[]; // 翻译中心已选服务及其展示顺序
    translationCenterSourceLanguage: string; // 翻译中心源语言
    translationCenterTargetLanguage: string; // 翻译中心目标语言
    translationCenterLayout: 'list' | 'grid'; // 翻译中心结果列表或并排布局
    writing: WritingPreferences; // 写作助手偏好
    harness: HarnessPreferences; // Harness 学习辅助偏好

    constructor() {
        this.on = true;
        this.uiLanguage = defaultOption.uiLanguage;
        this.uiLanguageSetupCompleted = false;
        this.autoTranslate = false;
        this.alwaysTranslateDomains = [];
        this.disabledExtensionDomains = [];
        this.siteAdaptation = normalizeSiteAdaptationSettings(undefined);
        this.from = defaultOption.from;
        this.to = defaultOption.to;
        this.excludedLanguages = [];
        this.style = defaultOption.style;
        this.translationAppearance = normalizeTranslationAppearance(DEFAULT_TRANSLATION_APPEARANCE); // 默认沿用各样式自带配色
        this.translationStyleProfiles = [];
        this.activeTranslationStyleProfileId = '';
        this.display = defaultOption.display;
        this.hotkey = defaultOption.hotkey;
        this.hoverShortcutBeforeDisable = defaultOption.hotkey;
        this.service = defaultOption.service;
        this.hoverTranslationService = '';
        this.selectionTranslationService = '';
        this.imageTranslationService = '';
        this.documentService = '';
        this.documentModel = Object.fromEntries(
            [...defaultModels].filter(([service]) => service !== LEGACY_CUSTOM_OPENAI_PROVIDER_ID),
        );
        this.documentCustomModel = {};
        this.videoTranslationEnabled = true; // 默认开启视频字幕翻译
        this.videoMeetingAutoEnabled = true;
        this.videoPreferHumanSubtitles = true;
        this.videoService = ''; // 默认跟随网页服务
        this.videoLocalModel = 'tiny';
        this.videoSourceLanguage = 'auto';
        this.videoServiceDefaultMigrated = true;
        this.videoSubtitleVisible = true; // 默认显示视频译文
        this.videoSubtitleDisplayMode = 'bilingual'; // 默认双语显示
        this.videoSubtitleFontSize = DEFAULT_VIDEO_SUBTITLE_FONT_SIZE; // 默认字幕字号
        this.videoSubtitleOffsetMs = 0;
        this.videoSubtitleAppearance = normalizeVideoSubtitleAppearance(DEFAULT_VIDEO_SUBTITLE_APPEARANCE);
        this.token = {};
        this.apiKeys = {};
        this.apiKeyRotationEnabled = {};
        this.secret = {};
        this.serviceRegion = {};
        this.requireApiKey = {};
        this.minimaxBillingPlan = 'payg';
        this.minimaxRegion = 'cn';
        this.mimoBillingPlan = 'payg';
        this.mimoRegion = 'cn';
        this.ak = '';
        this.sk = '';
        this.appid = '';
        this.key = '';
        this.model = Object.fromEntries(
            [...defaultModels].filter(([service]) => service !== LEGACY_CUSTOM_OPENAI_PROVIDER_ID),
        );
        this.customModel = {};
        this.customModels = {};
        this.modelThinking = {};
        this.customOpenAIProviders = [];
        this.favoriteServices = [];
        this.customBody = {};
        this.customHeaders = {};
        this.proxy = {};
        this.custom = defaultOption.custom;
        this.extra = {};
        this.system_role = systemRoleFactory();
        this.user_role = userRoleFactory();
        this.count = 0;
        this.theme = 'auto';  // 默认跟随系统
        this.shareCard = normalizeShareCardPreferences();
        this.interfaceSkin = 'default'; // 默认保留当前界面
        this.interfaceFont = DEFAULT_INTERFACE_FONT; // 默认使用现代无衬线字体栈
        this.interfaceVisibility = {...DEFAULT_INTERFACE_VISIBILITY};
        this.popupModuleOrder = [...DEFAULT_POPUP_MODULE_ORDER];
        this.popupQuickFeatureOrder = [...DEFAULT_POPUP_QUICK_FEATURE_ORDER];
        this.popupQuickFeatureVisibility = {...DEFAULT_POPUP_QUICK_FEATURE_VISIBILITY};
        this.useCache = true; // 默认开启缓存
        this.translationCacheMaxBytes = DEFAULT_TRANSLATION_CACHE_MAX_BYTES;
        this.translationCacheMaxEntries = DEFAULT_TRANSLATION_CACHE_MAX_ENTRIES;
        this.enableAIContext = false; // 默认关闭 AI 智能上下文，避免意外增加请求体和费用
        this.glossaryEnabled = false;
        this.glossaryLibraries = [];
        this.documentGlossaryIds = null;
        this.videoGlossaryIds = null;
        this.enableAIMultiSegment = false; // 默认逐段请求，由用户按需开启 AI 多段翻译
        this.bilingualSentenceHighlightEnabled = false; // 默认关闭双语逐句高亮，避免改变现有网页视觉
        this.bilingualSentenceHighlightStyle = DEFAULT_SENTENCE_HIGHLIGHT_STYLE;
        this.bilingualSentenceHighlightAppearance = {...DEFAULT_SENTENCE_HIGHLIGHT_APPEARANCE};
        this.bilingualSentenceHighlightProfiles = [];
        this.activeSentenceHighlightProfileId = '';
        this.contextMenuEnabled = true; // 默认显示右键菜单入口
        this.contextMenuEntries = {}; // 默认全部跟随产品默认值，用户改动才写入偏好
        this.contextMenuShowTargetLanguage = true; // 默认标出译入语言，让菜单说清会翻成什么
        this.contextMenuShowShortcut = true; // 默认标出快捷键，帮助用户从右键过渡到快捷键
        this.pageTitleTranslationEnabled = true; // 默认随全文翻译一并翻译标题，可在高级设置关闭
        this.translationScope = 'content'; // 默认只识别正文，全部节点由高级设置显式开启
        this.sidebarTranslationEnabled = false; // 默认跳过侧边栏和导航，保持正文阅读边界
        this.minTranslationTextLength = DEFAULT_MIN_TRANSLATION_TEXT_LENGTH; // 默认过滤单字符碎片
        this.eagerTranslationCharacters = DEFAULT_EAGER_TRANSLATION_CHARACTERS; // 默认完全按视口触发，免滚动预翻译由用户主动开启
        this.longParagraphLineBreakEnabled = false; // 默认保持原段落排版
        this.translationBeforeOriginal = false; // 默认译文排在每段原文之后
        this.fullPageTranslationMode = 'viewport'; // 默认按阅读进度翻译，避免一次发出过多请求
        this.disableFloatingBall = true; // 默认关闭悬浮球
        this.floatingBallPosition = 'right'; // 默认在右侧
        this.floatingBallVerticalPosition = null; // 未拖动时保持视口纵向居中
        this.floatingBallHotkey = 'Alt+T'; // 默认快捷键为 Alt+T
        this.customFloatingBallHotkey = ''; // 自定义快捷键为空
        this.floatingBallToolsDisplay = 'hover'; // 默认指针悬停时才展开翻译与设置按钮
        this.floatingBallHoverDelay = DEFAULT_FLOATING_BALL_HOVER_DELAY; // 默认立即展开，保持既有手感
        this.floatingBallClickAction = 'translate'; // 默认点击悬浮球即切换全文翻译
        this.floatingBallCompact = false; // 默认使用标准尺寸
        this.floatingBallSettingsEntryVisible = true; // 默认保留设置入口
        this.floatingBallCollapsedOpacity = DEFAULT_FLOATING_BALL_COLLAPSED_OPACITY; // 默认保持既有半透明收起效果
        this.floatingBallDisabledDomains = []; // 默认所有网站都显示悬浮球
        this.customHotkey = ''; // 自定义鼠标悬浮快捷键为空
        this.quickTranslationProfiles = []; // 默认仅保留旧快捷键，新方案由用户按需添加
        this.mouseHoverTranslationDelay = DEFAULT_MOUSE_HOVER_TRANSLATION_DELAY;
        this.paragraphCopyEnabled = false; // 默认关闭，避免用户未主动选择时接管快捷键
        this.paragraphCopyHotkey = DEFAULT_PARAGRAPH_COPY_HOTKEY; // 默认 Alt+C，避开浏览器的 Ctrl+C
        this.customParagraphCopyHotkey = ''; // 自定义段落复制快捷键为空
        this.paragraphCopyContent = DEFAULT_PARAGRAPH_COPY_CONTENT_MODE; // 默认跟随段落当前显示形态
        this.sectionTranslationHotkeyEnabled = false; // 默认关闭，局部翻译先从 Popup 进入，避免未主动选择时接管快捷键
        this.sectionTranslationHotkey = DEFAULT_SECTION_TRANSLATION_HOTKEY; // 默认 Alt+R，开启后才监听
        this.customSectionTranslationHotkey = ''; // 自定义局部翻译快捷键为空
        this.disableSelectionTranslator = true; // 默认关闭划词翻译
        this.selectionAreaEnabled = true; // 默认开启，按快捷键圈选后才截图翻译
        this.selectionAreaHotkey = DEFAULT_AREA_TRANSLATION_HOTKEY; // 默认 Shift+Z，可改为其他预设或自定义组合键
        this.customSelectionAreaHotkey = ''; // 自定义圈选快捷键为空
        this.areaTranslationMode = 'standard';
        this.areaTranslationService = '';
        this.areaRecognitionMode = 'prefer-vision';
        this.areaVisionPrompt = DEFAULT_AREA_VISION_PROMPT;
        this.modelVision = {};
        this.imageTranslationHoverEnabled = true;
        this.imageTranslationContextMenuEnabled = true;
        this.disableImageTranslator = true; // 默认关闭图片翻译，由用户按需开启
        this.freeTranslationOrder = [...DEFAULT_FREE_TRANSLATION_ORDER];
        this.freeTranslationMode = DEFAULT_FREE_TRANSLATION_MODE;
        this.freeTranslationTimeoutMs = DEFAULT_FREE_TRANSLATION_TIMEOUT_MS;
        this.freeTranslationCooldownMs = DEFAULT_FREE_TRANSLATION_COOLDOWN_MS;
        this.myMemoryEmail = '';
        this.deeplApiPlan = DEFAULT_DEEPL_API_PLAN; // 兼容既有 DeepL API Free 默认端点
        this.deeplx = defaultOption.deeplx; // DeepLX 默认服务地址
        this.selectionTranslatorMode = 'disabled'; // 默认关闭划词翻译
        this.selectionTranslatorModeBeforeDisable = 'bilingual';
        this.selectionTranslatorPresentation = 'simple';
        this.selectionTranslatorTrigger = 'icon'; // 默认显示可发现的操作图标
        this.selectionTranslatorHotkey = 'none'; // 默认不增加额外快捷键，保持原有划词行为
        this.customSelectionTranslatorHotkey = ''; // 自定义划词翻译快捷键为空
        this.selectionTranslatorDelay = DEFAULT_SELECTION_TRANSLATOR_DELAY;
        this.selectionTranslatorAutoDismiss = true;
        this.selectionTranslatorBidirectional = false; // 保留默认的同语言跳过，用户可按需开启双向入口
        this.selectionTtsVoices = []; // 默认按当前语言使用内置音色回退顺序
        this.selectionTtsMode = DEFAULT_LOCAL_TTS_MODE;
        this.selectionTtsLocalVoice = DEFAULT_LOCAL_TTS_VOICE;
        this.vocabularyBookEnabled = false; // Beta 默认关闭，由用户在单词本页面主动开启
        this.newApiUrl = DEFAULT_NEW_API_URL; // NewAPI 默认地址
        this.maxConcurrentTranslations = DEFAULT_MAX_CONCURRENT_TRANSLATIONS; // 默认最大并发数为10
        this.translationRequestsPerSecond = DEFAULT_TRANSLATION_REQUESTS_PER_SECOND;
        this.translationRequestsPerMinute = DEFAULT_TRANSLATION_REQUESTS_PER_MINUTE;
        this.serviceRequestLimits = {};
        this.modelRequestLimits = {};
        this.apiKeyRecoveryMs = DEFAULT_API_KEY_RECOVERY_MS;
        this.translationMaxRetries = DEFAULT_TRANSLATION_MAX_RETRIES;
        this.translationBackoffBaseMs = DEFAULT_TRANSLATION_BACKOFF_BASE_MS;
        this.translationBackoffMaxMs = DEFAULT_TRANSLATION_BACKOFF_MAX_MS;
        this.youdaoAppKey = ''; // 有道翻译 App Key
        this.youdaoAppSecret = ''; // 有道翻译 App Secret
        this.tencentSecretId = ''; // 腾讯云 Secret ID
        this.tencentSecretKey = ''; // 腾讯云 Secret Key
        this.azureOpenaiEndpoint = ''; // Azure 端点地址
        this.animations = true; // 默认启用动画
        this.translationLoadingStyle = DEFAULT_TRANSLATION_LOADING_STYLE; // 默认使用柔和圆环，缺失配置也回到该样式
        this.translationProgressPanelEnabled = false; // 默认关闭全文翻译进度面板
        this.inputBoxTranslationTrigger = 'disabled'; // 默认关闭输入框翻译
        this.inputBoxTranslationTarget = 'en'; // 默认翻译成英文
        this.inputBoxTranslationOutputMode = 'replace';
        this.inputBoxTranslationInterval = DEFAULT_INPUT_BOX_TRANSLATION_INTERVAL;
        this.inputBoxTranslationService = '';
        this.inputBoxTranslationModel = '';
        this.inputBoxTranslationPrompt = '';
        this.inputBoxTranslationSystemPrompt = '';
        this.deepseekApiType = 'auto'; // DeepSeek 默认自动选择 API 格式
        this.deepseekThinkingMode = 'disabled'; // 翻译默认关闭思考模式，降低延迟和输出噪音
        this.translationCenterServices = [];
        this.translationCenterSourceLanguage = '';
        this.translationCenterTargetLanguage = '';
        this.translationCenterLayout = 'list';
        this.writing = normalizeWritingPreferences(undefined);
        this.harness = normalizeHarnessPreferences(DEFAULT_HARNESS_PREFERENCES);
    }
}

const modelMigrations: Record<string, Record<string, string>> = {
    [services.openai]: {
        gpt5: currentModelIds.openai,
    },
    [services.zhipu]: {
        'glm-4.5': currentModelIds.zhipu,
        'GLM-4-Flash': currentModelIds.zhipuFlash,
        'glm-4-plus': currentModelIds.zhipu,
        'glm-4': currentModelIds.zhipu,
        'glm-4v': currentModelIds.zhipu,
    },
    [services.moonshot]: {
        'kimi-k2-0711-preview': currentModelIds.moonshot,
        'kimi-k2-turbo-preview': currentModelIds.moonshot,
        'moonshot-v1-auto': currentModelIds.moonshot,
        'moonshot-v1-8k': currentModelIds.moonshot,
        'moonshot-v1-32k': currentModelIds.moonshot,
    },
    [services.claude]: {
        'claude-sonnet-4-0': currentModelIds.claudeSonnet,
        'claude-opus-4-1': currentModelIds.claudeOpus,
        'claude-3-5-sonnet': currentModelIds.claudeSonnet,
        'claude-3-5-sonnet-20241022': currentModelIds.claudeSonnet,
        'claude-3-opus': currentModelIds.claudeOpus,
        'claude-3-opus-20240229': currentModelIds.claudeOpus,
        'claude-3-5-haiku': currentModelIds.claudeHaiku,
        'claude-3-5-haiku-20241022': currentModelIds.claudeHaiku,
        'claude-3-5-haiku-latest': currentModelIds.claudeHaiku,
    },
    [services.grok]: {
        'grok-4-0709': currentModelIds.grok,
    },
    [services.groq]: {
        'llama-3.3-70b-versatile': currentModelIds.groqLarge,
        'llama-3.1-8b-instant': currentModelIds.groqSmall,
        'llama3-8b-8192': currentModelIds.groqSmall,
    },
    [services.yiyan]: {
        'ERNIE-Bot 4.0': currentModelIds.yiyan,
        'ERNIE-Bot': currentModelIds.yiyan,
        'ERNIE-Speed-8K': currentModelIds.yiyanFast,
    },
    [services.minimax]: {
        chatcompletion_v2: currentModelIds.minimax,
        'MiniMax-Text-01': currentModelIds.minimax,
    },
    [services.mimo]: {
        // 官方将在 2026-10-21 直接停用旧编号；网页、文档和模型级偏好使用同一映射。
        'mimo-v2.5-pro': currentModelIds.mimo,
        'mimo-v2.5': defaultModelIds[services.mimo],
    },
    [services.jieyue]: {
        'step-1-8k': currentModelIds.jieyue,
    },
    [services.huanYuan]: {
        // 官方已于 2026-08-31 下线预览版，迁移到正式版并复用模型级偏好迁移。
        'hy3-preview': currentModelIds.huanYuan,
        'hunyuan-turbos-latest': currentModelIds.huanYuan,
        'hunyuan-t1-latest': currentModelIds.huanYuan,
        'hunyuan-a13b': currentModelIds.huanYuan,
        'hunyuan-lite': currentModelIds.huanYuan,
        'hunyuan-standard': currentModelIds.huanYuan,
    },
    [services.infini]: {
        'llama-2-13b-chat': currentModelIds.infiniGeneral,
        'llama-3.3-70b-instruct': currentModelIds.infiniGeneral,
        'qwen2.5-14b-instruct': currentModelIds.infiniGeneral,
        'gemma-2-27b-it': currentModelIds.infiniGeneral,
        'glm-4-9b-chat': currentModelIds.infiniZhipu,
    },
};

// 已退役服务只在配置迁移边界保留标识，用于清除旧版本遗留的不可见配置和凭据。
const retiredServiceIds = new Set(['cozecom', 'cozecn']);

function hasOwn(value: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function configuredString(mapping: unknown, key: string): string {
    if (!isRecord(mapping)) return '';
    const value = mapping[key];
    return typeof value === 'string' ? value.trim() : '';
}

function legacyCustomModel(
    selectedModels: unknown,
    customModels: unknown,
): string {
    return resolveConfiguredModel(
        configuredString(selectedModels, LEGACY_CUSTOM_OPENAI_PROVIDER_ID),
        configuredString(customModels, LEGACY_CUSTOM_OPENAI_PROVIDER_ID),
    ).trim();
}

/** 默认 Config 本来就含 custom 地址和默认模型；只有真实修改或引用才创建旧 profile。 */
function hasSubstantialLegacyCustomConfiguration(source: Partial<Config>): boolean {
    const sourceRecord = source as unknown as Record<string, unknown>;
    const referenced = source.service === LEGACY_CUSTOM_OPENAI_PROVIDER_ID
        || source.hoverTranslationService === LEGACY_CUSTOM_OPENAI_PROVIDER_ID
        || source.selectionTranslationService === LEGACY_CUSTOM_OPENAI_PROVIDER_ID
        || source.imageTranslationService === LEGACY_CUSTOM_OPENAI_PROVIDER_ID
        || source.documentService === LEGACY_CUSTOM_OPENAI_PROVIDER_ID
        || source.videoService === LEGACY_CUSTOM_OPENAI_PROVIDER_ID
        || source.areaTranslationService === LEGACY_CUSTOM_OPENAI_PROVIDER_ID
        || (Array.isArray(source.translationCenterServices)
            && source.translationCenterServices.includes(LEGACY_CUSTOM_OPENAI_PROVIDER_ID));
    if (referenced) return true;

    const endpoint = typeof source.custom === 'string' ? source.custom.trim() : '';
    if (endpoint && endpoint !== defaultOption.custom) return true;

    const defaultModel = defaultModels.get(LEGACY_CUSTOM_OPENAI_PROVIDER_ID)!;
    const selectedModel = configuredString(source.model, LEGACY_CUSTOM_OPENAI_PROVIDER_ID);
    const documentModel = configuredString(source.documentModel, LEGACY_CUSTOM_OPENAI_PROVIDER_ID);
    if ((selectedModel && selectedModel !== defaultModel)
        || (documentModel && documentModel !== defaultModel)
        || configuredString(source.customModel, LEGACY_CUSTOM_OPENAI_PROVIDER_ID)
        || configuredString(source.documentCustomModel, LEGACY_CUSTOM_OPENAI_PROVIDER_ID)) return true;

    if (configuredString(source.token, LEGACY_CUSTOM_OPENAI_PROVIDER_ID)
        || getConfiguredApiKey(source.apiKeys, LEGACY_CUSTOM_OPENAI_PROVIDER_ID)
        || configuredString(source.proxy, LEGACY_CUSTOM_OPENAI_PROVIDER_ID)
        || configuredString(source.customBody, LEGACY_CUSTOM_OPENAI_PROVIDER_ID)
        || configuredString(source.customHeaders, LEGACY_CUSTOM_OPENAI_PROVIDER_ID)) return true;
    const systemRole = configuredString(source.system_role, LEGACY_CUSTOM_OPENAI_PROVIDER_ID);
    const userRole = configuredString(source.user_role, LEGACY_CUSTOM_OPENAI_PROVIDER_ID);
    // 仍停留在历史默认提示词的旧配置不算用户改写；否则升级默认提示词会凭空
    // 判定旧自定义 OpenAI 档案存在真实配置。
    if ((systemRole && systemRole !== defaultOption.system_role)
        || (userRole && userRole !== defaultOption.user_role
            && !LEGACY_DEFAULT_USER_ROLES.includes(userRole))) return true;

    const requirementModel = legacyCustomModel(source.model, source.customModel);
    const requirementKey = createApiKeyRequirementKey(LEGACY_CUSTOM_OPENAI_PROVIDER_ID, requirementModel);
    const legacyRequirementKey = getLegacyApiKeyRequirementKey(
        LEGACY_CUSTOM_OPENAI_PROVIDER_ID,
        requirementModel,
    );
    return isBooleanMapping(source.requireApiKey)
        && requirementModel !== ''
        && (hasOwn(sourceRecord.requireApiKey as object, requirementKey)
            || hasOwn(sourceRecord.requireApiKey as object, legacyRequirementKey));
}

function getConfiguredApiKey(mapping: unknown, service: string): string {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return '';
    const values = (mapping as Record<string, unknown>)[service];
    return Array.isArray(values)
        ? values.find((value): value is string => typeof value === 'string' && Boolean(value.trim())) || ''
        : '';
}

function protectProviderModels(
    providers: CustomOpenAIProvider[],
    serviceId: string,
    modelsToProtect: readonly string[],
): CustomOpenAIProvider[] {
    const protectedModels = Array.from(new Set(modelsToProtect.map(model => model.trim()).filter(Boolean)));
    if (protectedModels.length === 0) return providers;
    const protectedSet = new Set(protectedModels);
    return providers.map((provider) => {
        if (provider.id !== serviceId) return provider;
        const missingModels = protectedModels.filter(model => !provider.models.includes(model));
        if (missingModels.length === 0) return provider;

        const combined = [...provider.models, ...missingModels];
        let removeCount = Math.max(0, combined.length - MAX_CUSTOM_OPENAI_MODELS_PER_PROVIDER);
        const removedIndexes = new Set<number>();
        for (let index = provider.models.length - 1; index >= 0 && removeCount > 0; index -= 1) {
            if (protectedSet.has(provider.models[index])) continue;
            removedIndexes.add(index);
            removeCount -= 1;
        }
        const models = combined.filter((_, index) => !removedIndexes.has(index));
        return {...provider, models};
    });
}

function withoutOrphanCustomProviderEntries<T>(
    mapping: Record<string, T>,
    configuredIds: ReadonlySet<string>,
): Record<string, T> {
    return Object.fromEntries(Object.entries(mapping).filter(([service]) => (
        !isCustomOpenAIProviderId(service) || configuredIds.has(service)
    )));
}

function normalizeCustomOpenAIProviderState(normalized: Config, source: Partial<Config>): void {
    let providers = normalizeCustomOpenAIProviders(source.customOpenAIProviders);
    const legacyProvider = getCustomOpenAIProvider(providers, LEGACY_CUSTOM_OPENAI_PROVIDER_ID);
    if (!legacyProvider
        && !Array.isArray(source.customOpenAIProviders)
        && hasSubstantialLegacyCustomConfiguration(source)) {
        const pageModel = legacyCustomModel(normalized.model, normalized.customModel)
            || defaultModels.get(LEGACY_CUSTOM_OPENAI_PROVIDER_ID)!;
        const documentModel = legacyCustomModel(normalized.documentModel, normalized.documentCustomModel)
            || pageModel;
        providers = normalizeCustomOpenAIProviders([...providers, {
            id: LEGACY_CUSTOM_OPENAI_PROVIDER_ID,
            name: '自定义接口',
            endpoint: typeof source.custom === 'string' ? source.custom : defaultOption.custom,
            models: [pageModel, documentModel],
        }]);
    } else if (legacyProvider && !legacyProvider.endpoint && typeof source.custom === 'string') {
        const legacyEndpoint = source.custom;
        providers = providers.map((provider) => provider.id === LEGACY_CUSTOM_OPENAI_PROVIDER_ID
            ? {...provider, endpoint: legacyEndpoint}
            : provider);
    }

    const configuredIds = new Set(providers.map((provider) => provider.id));
    normalized.token = withoutOrphanCustomProviderEntries(normalized.token, configuredIds);
    normalized.model = withoutOrphanCustomProviderEntries(normalized.model, configuredIds);
    normalized.documentModel = withoutOrphanCustomProviderEntries(normalized.documentModel, configuredIds);
    normalized.customModel = withoutOrphanCustomProviderEntries(normalized.customModel, configuredIds);
    normalized.documentCustomModel = withoutOrphanCustomProviderEntries(normalized.documentCustomModel, configuredIds);
    normalized.proxy = withoutOrphanCustomProviderEntries(normalized.proxy, configuredIds);
    normalized.system_role = withoutOrphanCustomProviderEntries(normalized.system_role, configuredIds);
    normalized.user_role = withoutOrphanCustomProviderEntries(normalized.user_role, configuredIds);
    normalized.customBody = withoutOrphanCustomProviderEntries(normalized.customBody, configuredIds);
    normalized.customHeaders = Object.fromEntries(Object.entries(normalized.customHeaders)
        .filter(([service]) => configuredIds.has(service)));
    normalized.apiKeys = withoutOrphanCustomProviderEntries(normalized.apiKeys, configuredIds);
    normalized.serviceRequestLimits = Object.fromEntries(Object.entries(normalized.serviceRequestLimits)
        .filter(([service]) => !isCustomOpenAIProviderId(service) || configuredIds.has(service)));
    normalized.modelRequestLimits = Object.fromEntries(Object.entries(normalized.modelRequestLimits)
        .filter(([service]) => !isCustomOpenAIProviderId(service) || configuredIds.has(service)));

    for (const provider of providers) {
        const service = provider.id;
        const savedPageCustomModel = configuredString(normalized.customModel, service);
        const savedDocumentCustomModel = configuredString(normalized.documentCustomModel, service);
        const resolvedPageModel = resolveConfiguredModel(
            normalized.model[service],
            normalized.customModel[service],
        ).trim();
        const pageModel = resolvedPageModel || provider.models[0] || '';
        const resolvedDocumentModel = resolveConfiguredModel(
            normalized.documentModel[service],
            normalized.documentCustomModel[service],
        ).trim();
        const documentModel = resolvedDocumentModel || pageModel;
        if (pageModel) normalized.model[service] = pageModel;
        else delete normalized.model[service];
        if (documentModel) normalized.documentModel[service] = documentModel;
        else delete normalized.documentModel[service];
        delete normalized.customModel[service];
        delete normalized.documentCustomModel[service];
        if (!normalized.system_role[service]) normalized.system_role[service] = defaultOption.system_role;
        if (!normalized.user_role[service]) normalized.user_role[service] = defaultOption.user_role;
        providers = protectProviderModels(providers, service, [
            pageModel,
            documentModel,
            savedPageCustomModel,
            savedDocumentCustomModel,
        ]);
    }

    const validRequirementKeys = new Set<string>();
    for (const provider of providers) {
        const models = new Set([
            ...provider.models,
            normalized.model[provider.id],
            normalized.documentModel[provider.id],
        ].filter((model): model is string => Boolean(model)));
        models.forEach((model) => {
            const key = createApiKeyRequirementKey(provider.id, model);
            const legacyKey = getLegacyApiKeyRequirementKey(provider.id, model);
            validRequirementKeys.add(key);
            validRequirementKeys.add(legacyKey);
            if (provider.id === LEGACY_CUSTOM_OPENAI_PROVIDER_ID
                && hasOwn(normalized.requireApiKey, legacyKey)
                && !hasOwn(normalized.requireApiKey, key)) {
                normalized.requireApiKey[key] = normalized.requireApiKey[legacyKey];
            }
        });
    }
    normalized.requireApiKey = Object.fromEntries(Object.entries(normalized.requireApiKey).filter(([key]) => {
        if (key.startsWith(API_KEY_REQUIREMENT_KEY_PREFIX)) {
            const parts = parseApiKeyRequirementKey(key);
            if (!parts) return false;
            return !isCustomOpenAIProviderId(parts[0]) || validRequirementKeys.has(key);
        }
        return !key.startsWith(`${LEGACY_CUSTOM_OPENAI_PROVIDER_ID}:`) || validRequirementKeys.has(key);
    }));
    normalized.customOpenAIProviders = normalizeCustomOpenAIProviders(providers);
    normalized.apiKeyRotationEnabled = withoutOrphanCustomProviderEntries(
        normalized.apiKeyRotationEnabled,
        new Set(providers.map((provider) => provider.id)),
    );
    normalized.token = apiKeysToToken(normalized.apiKeys);
}

/**
 * 将存储或导入的普通对象补齐为当前配置结构，并迁移已退役或错误的模型编号。
 */
export function normalizeConfig(value: unknown): Config {
    const normalized = new Config();
    const knownFields = new Set(Object.keys(normalized));
    // Vue 的响应式对象是 Proxy。Chrome 的 runtime 通道有时会替调用方
    // 做隐式转换，但 Firefox 会严格按 structured clone 处理并直接抛出
    // DataCloneError，所以配置边界必须先落成纯对象。
    const source = value && typeof value === 'object'
        ? cloneConfigValue(value) as Partial<Config>
        : {};
    Object.assign(normalized, source);
    // 短期版本曾暴露的策略开关在对应功能退役后必须主动丢弃，避免旧配置继续
    // 分叉存储语义，或让已经删除的 X 原生翻译设置进入历史和迁移导出。
    delete (normalized as unknown as Record<string, unknown>).persistCredentials;
    delete (normalized as unknown as Record<string, unknown>).xGrokAutoTranslateEnabled;
    for (const key of Object.keys(source)) {
        if (!knownFields.has(key) && isSensitiveConfigKey(key)) {
            delete (normalized as unknown as Record<string, unknown>)[key];
        }
    }
    const legacyTranslationStatus = (source as unknown as Record<string, unknown>).translationStatus;
    if (typeof source.translationProgressPanelEnabled !== 'boolean') {
        normalized.translationProgressPanelEnabled = typeof legacyTranslationStatus === 'boolean'
            ? legacyTranslationStatus
            : false;
    }
    normalized.bilingualSentenceHighlightEnabled = source.bilingualSentenceHighlightEnabled === true;
    normalized.bilingualSentenceHighlightStyle = normalizeSentenceHighlightStyle(source.bilingualSentenceHighlightStyle);
    normalized.bilingualSentenceHighlightAppearance = normalizeSentenceHighlightAppearance(source.bilingualSentenceHighlightAppearance);
    normalized.bilingualSentenceHighlightProfiles = normalizeSentenceHighlightProfiles(source.bilingualSentenceHighlightProfiles);
    normalized.activeSentenceHighlightProfileId = typeof source.activeSentenceHighlightProfileId === 'string'
        && normalized.bilingualSentenceHighlightProfiles.some(profile => profile.id === source.activeSentenceHighlightProfileId)
        ? source.activeSentenceHighlightProfileId : '';
    normalized.translationAppearance = normalizeTranslationAppearance(source.translationAppearance);
    normalized.translationStyleProfiles = normalizeTranslationStyleProfiles(source.translationStyleProfiles);
    normalized.activeTranslationStyleProfileId = typeof source.activeTranslationStyleProfileId === 'string'
        && normalized.translationStyleProfiles.some((profile) => profile.id === source.activeTranslationStyleProfileId)
        ? source.activeTranslationStyleProfileId : '';
    normalized.translationScope = source.translationScope === 'all' ? 'all' : 'content';
    delete (normalized as unknown as Record<string, unknown>).translationStatus;
    // __fluentConfigRevision 只用于 storage 的写入顺序判断，不能进入运行时
    // 配置或历史快照，否则默认配置与同值的页面快照会因内部字段不同而无法去重。
    delete (normalized as unknown as Record<string, unknown>).__fluentConfigRevision;
    // 后台计数幂等日志与 revision 一样只属于存储协议，不能进入 UI、历史或导出配置。
    delete (normalized as unknown as Record<string, unknown>).__fluentCountOperations;
    delete (normalized as unknown as Record<string, unknown>).robot_id;

    // 翻译次数只接受非负安全整数；旧版本或手工修改产生的字符串、负数和溢出值回退为 0。
    normalized.count = typeof source.count === 'number'
        && Number.isSafeInteger(source.count)
        && source.count >= 0
        ? source.count
        : 0;
    normalized.from = normalizeConfigLanguage(source.from) || defaultOption.from;
    normalized.to = normalizeConfigLanguage(source.to) || defaultOption.to;
    normalized.excludedLanguages = normalizeExcludedLanguages(source.excludedLanguages);
    normalized.inputBoxTranslationTarget = normalizeConfigLanguage(source.inputBoxTranslationTarget)
        || defaultOption.inputBoxTranslationTarget;
    normalized.inputBoxTranslationOutputMode = normalizeInputBoxTranslationOutputMode(source.inputBoxTranslationOutputMode);
    normalized.inputBoxTranslationInterval = normalizeInputBoxTranslationInterval(
        source.inputBoxTranslationInterval,
    );
    normalized.inputBoxTranslationModel = normalizeInputBoxTranslationModel(source.inputBoxTranslationModel);
    normalized.inputBoxTranslationPrompt = normalizeInputBoxTranslationPrompt(source.inputBoxTranslationPrompt);
    normalized.inputBoxTranslationSystemPrompt = normalizeInputBoxTranslationPrompt(
        source.inputBoxTranslationSystemPrompt,
    );
    normalized.uiLanguage = normalizeUiLanguage(source.uiLanguage);
    const cacheLimits = normalizeTranslationCacheLimits({
        maxBytes: source.translationCacheMaxBytes,
        maxEntries: source.translationCacheMaxEntries,
    });
    normalized.translationCacheMaxBytes = cacheLimits.maxBytes;
    normalized.translationCacheMaxEntries = cacheLimits.maxEntries;
    normalized.uiLanguageSetupCompleted = source.uiLanguageSetupCompleted === true;
    normalized.maxConcurrentTranslations = normalizeMaxConcurrentTranslations(
        source.maxConcurrentTranslations,
    );
    normalized.translationLoadingStyle = normalizeTranslationLoadingStyle(
        source.translationLoadingStyle,
    );
    normalized.translationRequestsPerSecond = normalizeTranslationRequestsPerSecond(
        source.translationRequestsPerSecond,
    );
    normalized.translationRequestsPerMinute = normalizeTranslationRequestsPerMinute(
        source.translationRequestsPerMinute,
    );
    normalized.serviceRequestLimits = withoutRetiredServiceEntries(normalizeServiceRequestLimits(source.serviceRequestLimits));
    normalized.modelRequestLimits = withoutRetiredServiceEntries(normalizeModelRequestLimits(source.modelRequestLimits));
    normalized.apiKeyRecoveryMs = normalizeApiKeyRecoveryMs(source.apiKeyRecoveryMs);
    normalized.freeTranslationOrder = normalizeFreeTranslationOrder(source.freeTranslationOrder);
    normalized.freeTranslationMode = normalizeFreeTranslationMode(source.freeTranslationMode);
    // 权重归后台管理，不接受导入文件或旧配置中的人工权重。
    delete (normalized as Config & {freeTranslationWeights?: unknown}).freeTranslationWeights;
    normalized.freeTranslationTimeoutMs = normalizeFreeTranslationTimeoutMs(source.freeTranslationTimeoutMs);
    normalized.freeTranslationCooldownMs = normalizeFreeTranslationCooldownMs(source.freeTranslationCooldownMs);
    normalized.myMemoryEmail = normalizeMyMemoryEmail(source.myMemoryEmail);
    normalized.translationMaxRetries = normalizeTranslationMaxRetries(source.translationMaxRetries);
    normalized.translationBackoffBaseMs = normalizeTranslationBackoffBaseMs(
        source.translationBackoffBaseMs,
    );
    normalized.translationBackoffMaxMs = Math.max(
        normalized.translationBackoffBaseMs,
        normalizeTranslationBackoffMaxMs(source.translationBackoffMaxMs),
    );

    normalized.apiKeys = withoutRetiredServiceEntries(normalizeApiKeys(source.apiKeys));
    const legacyToken = withoutRetiredServiceEntries(normalizeStringMapping(source.token));
    if (hasOwn(source as object, 'token') && isRecord(source.token)
        && Object.keys(legacyToken).length === 0) normalized.apiKeys = {};
    for (const [service, token] of Object.entries(legacyToken)) {
        if (!Object.prototype.hasOwnProperty.call(normalized.apiKeys, service)) {
            normalized.apiKeys[service] = token ? [token] : [];
        }
    }
    normalized.apiKeyRotationEnabled = isBooleanMapping(source.apiKeyRotationEnabled)
        ? withoutRetiredServiceEntries({...source.apiKeyRotationEnabled})
        : {};
    // 兼容已有多 Key 配置；新建配置仍默认关闭多 Key 轮询。
    for (const [service, keys] of Object.entries(normalized.apiKeys)) {
        if (keys.filter(Boolean).length > 1
            && !Object.prototype.hasOwnProperty.call(normalized.apiKeyRotationEnabled, service)) {
            normalized.apiKeyRotationEnabled[service] = true;
        }
    }
    normalized.token = apiKeysToToken(normalized.apiKeys);
    normalized.secret = withoutRetiredServiceEntries(normalizeStringMapping(source.secret));
    normalized.serviceRegion = normalizeCloudRegionMapping(source.serviceRegion);
    normalized.model = withoutRetiredServiceEntries(normalizeStringMapping(source.model));
    normalized.documentModel = withoutRetiredServiceEntries(normalizeStringMapping(source.documentModel));
    normalized.requireApiKey = isBooleanMapping(source.requireApiKey)
        ? withoutRetiredRequirementEntries({...source.requireApiKey})
        : {};
    normalized.customModel = withoutRetiredServiceEntries(normalizeStringMapping(source.customModel));
    normalized.documentCustomModel = withoutRetiredServiceEntries(normalizeStringMapping(source.documentCustomModel));
    const hasSavedCustomModelSchema = hasOwn(source as object, 'customModels');
    normalized.customModels = normalizeCustomModelMapping(source.customModels);
    const hasModelThinkingSchema = hasOwn(source as object, 'modelThinking');
    normalized.modelThinking = normalizeModelThinkingMapping(source.modelThinking);
    normalized.proxy = withoutRetiredServiceEntries(normalizeStringMapping(source.proxy));
    normalized.system_role = {
        ...systemRoleFactory(),
        ...withoutRetiredServiceEntries(normalizeStringMapping(source.system_role)),
    };
    normalized.user_role = upgradeLegacyDefaultUserRoles({
        ...userRoleFactory(),
        ...withoutRetiredServiceEntries(normalizeStringMapping(source.user_role)),
    });
    normalized.customBody = withoutRetiredServiceEntries(normalizeCustomBodyMapping(source.customBody));
    normalized.customHeaders = normalizeStringMapping(source.customHeaders);

    if (typeof normalized.custom !== 'string') normalized.custom = defaultOption.custom;
    normalized.deeplApiPlan = normalizeDeepLApiPlan(source.deeplApiPlan);
    if (typeof normalized.newApiUrl !== 'string') normalized.newApiUrl = DEFAULT_NEW_API_URL;
    normalizeCustomOpenAIProviderState(normalized, source);
    normalized.favoriteServices = Array.isArray(source.favoriteServices)
        ? [...new Set(source.favoriteServices.filter(service =>
            typeof service === 'string' && isSupportedTranslationService(service, normalized.customOpenAIProviders)))].slice(0, 100)
        : [];
    normalized.inputBoxTranslationService = normalizeInputBoxTranslationService(
        source.inputBoxTranslationService,
        normalized.customOpenAIProviders,
    );
    normalized.writing = normalizeWritingPreferences(source.writing, normalized.customOpenAIProviders);
    normalized.harness = normalizeHarnessPreferences(source.harness, normalized.customOpenAIProviders);

    if (!isSupportedTranslationService(normalized.service, normalized.customOpenAIProviders)) {
        normalized.service = defaultOption.service;
    }

    if (!isSupportedTranslationService(normalized.documentService, normalized.customOpenAIProviders)) {
        normalized.documentService = '';
    }

    for (const field of ['hoverTranslationService', 'selectionTranslationService', 'imageTranslationService'] as const) {
        normalized[field] = isSupportedTranslationService(source[field], normalized.customOpenAIProviders) ? source[field] : '';
    }

    normalized.areaTranslationMode = source.areaTranslationMode === 'ai' ? 'ai' : 'standard';
    normalized.areaTranslationService = isSupportedTranslationService(source.areaTranslationService, normalized.customOpenAIProviders)
        ? source.areaTranslationService : '';
    normalized.areaRecognitionMode = source.areaRecognitionMode === 'ocr' ? 'ocr' : 'prefer-vision';
    normalized.areaVisionPrompt = normalizeAreaVisionPrompt(source.areaVisionPrompt);
    normalized.modelVision = normalizeModelVisionOverrides(source.modelVision);

    if (typeof normalized.videoTranslationEnabled !== 'boolean') {
        normalized.videoTranslationEnabled = true;
    }
    normalized.videoMeetingAutoEnabled = typeof source.videoMeetingAutoEnabled === 'boolean' ? source.videoMeetingAutoEnabled : true;
    normalized.videoPreferHumanSubtitles = typeof source.videoPreferHumanSubtitles === 'boolean' ? source.videoPreferHumanSubtitles : true;
    if (normalized.videoLocalModel !== 'tiny' && normalized.videoLocalModel !== 'base') {
        normalized.videoLocalModel = 'tiny';
    }
    if (!VIDEO_SOURCE_LANGUAGE_OPTIONS.some((item) => item.value === normalized.videoSourceLanguage)) {
        normalized.videoSourceLanguage = 'auto';
    }
    // 早期 Beta 版本曾把 DeepLX 写成默认值。只对没有迁移标记的旧配置
    // 执行一次迁移，避免覆盖用户在新版本中主动选择的 DeepLX。
    const shouldMigrateLegacyVideoDefault = source.videoService === services.deeplx
        && source.videoServiceDefaultMigrated !== true;
    if (shouldMigrateLegacyVideoDefault
        || !isSupportedTranslationService(normalized.videoService, normalized.customOpenAIProviders)) {
        normalized.videoService = '';
    }
    normalized.videoServiceDefaultMigrated = true;
    if (typeof normalized.videoSubtitleVisible !== 'boolean') {
        normalized.videoSubtitleVisible = true;
    }
    if (!['bilingual', 'translation-only', 'original-only'].includes(normalized.videoSubtitleDisplayMode)) {
        normalized.videoSubtitleDisplayMode = 'bilingual';
    }
    normalized.videoSubtitleFontSize = normalizeVideoSubtitleFontSize(normalized.videoSubtitleFontSize);
    normalized.videoSubtitleOffsetMs = normalizeVideoSubtitleOffsetMs(normalized.videoSubtitleOffsetMs);
    const hasVideoSubtitleAppearance = hasOwn(source as object, 'videoSubtitleAppearance');
    normalized.videoSubtitleAppearance = normalizeVideoSubtitleAppearance(
        hasVideoSubtitleAppearance
            ? source.videoSubtitleAppearance
            : {fontScale: source.videoSubtitleFontSize},
    );

    migrateModelIdentifiers(normalized.model);
    migrateModelIdentifiers(normalized.documentModel);

    // 旧配置可能没有保存过模型选择；为所有 AI 服务补齐各自的默认模型。
    defaultModels.forEach((defaultModel, service) => {
        if (isCustomOpenAIProviderId(service)
            && !isConfiguredCustomOpenAIProvider(normalized.customOpenAIProviders, service)) return;
        if (!normalized.model[service]) normalized.model[service] = defaultModel;
        if (!normalized.documentModel[service]) normalized.documentModel[service] = defaultModel;
    });

    const selectedModel = normalized.model[services.deepseek];
    const configuredThinkingMode = source.deepseekThinkingMode;

    if (selectedModel === 'deepseek-chat') {
        normalized.model[services.deepseek] = currentModelIds.deepseek;
        normalized.deepseekThinkingMode = 'disabled';
    } else if (selectedModel === 'deepseek-reasoner') {
        // 旧 reasoner 使用当前 Flash 模型，并显式保留 thinking 开启状态。
        normalized.model[services.deepseek] = currentModelIds.deepseek;
        normalized.deepseekThinkingMode = 'enabled';
    } else if (configuredThinkingMode !== 'enabled' && configuredThinkingMode !== 'disabled') {
        // 兼容 #219 的早期配置：该实现把 v4-pro 作为默认思考模型。
        normalized.deepseekThinkingMode = selectedModel === 'deepseek-v4-pro' ? 'enabled' : 'disabled';
    }
    normalizeSavedCustomModelState(normalized, hasSavedCustomModelSchema);
    normalizeModelThinkingState(normalized, hasModelThinkingSchema);

    if (!['auto', 'responses', 'chat'].includes(normalized.deepseekApiType)) {
        normalized.deepseekApiType = 'auto';
    }

    if (!['payg', 'token-plan'].includes(normalized.minimaxBillingPlan)) {
        normalized.minimaxBillingPlan = 'payg';
    }

    if (!['global', 'cn'].includes(normalized.minimaxRegion)) {
        normalized.minimaxRegion = 'cn';
    }

    if (!['payg', 'token-plan'].includes(normalized.mimoBillingPlan)) {
        normalized.mimoBillingPlan = 'payg';
    }

    if (!['cn', 'sgp', 'ams'].includes(normalized.mimoRegion)) {
        normalized.mimoRegion = 'cn';
    }

    const enabledHoverChoices = options.keys.filter(item => !('disabled' in item && item.disabled) && item.value !== 'none').map(item => item.value);
    normalized.hoverShortcutBeforeDisable = enabledHoverChoices.includes(normalized.hotkey)
        ? normalized.hotkey : enabledHoverChoices.includes(source.hoverShortcutBeforeDisable ?? '')
            ? source.hoverShortcutBeforeDisable! : defaultOption.hotkey;
    normalized.mouseHoverTranslationDelay = normalizeMouseHoverTranslationDelay(
        source.mouseHoverTranslationDelay,
    );
    normalized.floatingBallToolsDisplay = normalizeFloatingBallToolsDisplay(source.floatingBallToolsDisplay);
    normalized.floatingBallVerticalPosition = normalizeFloatingBallVerticalPosition(
        source.floatingBallVerticalPosition,
    );
    normalized.floatingBallHoverDelay = normalizeFloatingBallHoverDelay(source.floatingBallHoverDelay);
    normalized.floatingBallClickAction = normalizeFloatingBallClickAction(source.floatingBallClickAction);
    normalized.floatingBallCompact = source.floatingBallCompact === true;
    normalized.floatingBallSettingsEntryVisible = source.floatingBallSettingsEntryVisible !== false;
    normalized.floatingBallCollapsedOpacity = normalizeFloatingBallCollapsedOpacity(
        source.floatingBallCollapsedOpacity,
    );
    normalized.floatingBallDisabledDomains = normalizeFloatingBallDisabledDomains(
        source.floatingBallDisabledDomains,
    );
    normalized.sidebarTranslationEnabled = source.sidebarTranslationEnabled === true;
    normalized.minTranslationTextLength = normalizeMinTranslationTextLength(source.minTranslationTextLength);
    normalized.eagerTranslationCharacters = normalizeEagerTranslationCharacters(source.eagerTranslationCharacters);
    normalized.longParagraphLineBreakEnabled = source.longParagraphLineBreakEnabled === true;
    normalized.translationBeforeOriginal = source.translationBeforeOriginal === true;
    normalized.alwaysTranslateDomains = normalizeAlwaysTranslateDomains(source.alwaysTranslateDomains);
    normalized.disabledExtensionDomains = normalizeDisabledExtensionDomains(source.disabledExtensionDomains);
    normalized.siteAdaptation = normalizeSiteAdaptationSettings(source.siteAdaptation);
    normalized.shareCard = normalizeShareCardPreferences(source.shareCard);
    normalized.interfaceSkin = normalizeInterfaceSkin(source.interfaceSkin);
    normalized.interfaceFont = normalizeInterfaceFont(source.interfaceFont);
    normalized.interfaceVisibility = normalizeInterfaceVisibility(source.interfaceVisibility);
    normalized.popupModuleOrder = normalizePopupModuleOrder(source.popupModuleOrder);
    normalized.popupQuickFeatureOrder = normalizePopupQuickFeatureOrder(source.popupQuickFeatureOrder);
    normalized.popupQuickFeatureVisibility = normalizePopupQuickFeatureVisibility(source.popupQuickFeatureVisibility);

    if (!['disabled', 'bilingual', 'translation-only'].includes(normalized.selectionTranslatorMode)) {
        normalized.selectionTranslatorMode = 'disabled';
    }
    // 仅旧版本缺失呈现字段时迁移；关闭统一开关后，学习偏好不能再次把功能打开。
    const legacySelection = source.selectionTranslatorPresentation === undefined;
    normalized.selectionTranslatorPresentation = source.selectionTranslatorPresentation === 'card'
        || (legacySelection && (normalized.harness.enabled || normalized.selectionTranslatorMode !== 'disabled')) ? 'card' : 'simple';
    if (legacySelection && normalized.harness.enabled && normalized.selectionTranslatorMode === 'disabled') {
        normalized.selectionTranslatorMode = 'bilingual';
        normalized.selectionTranslatorTrigger = normalized.harness.trigger === 'shortcut' ? 'custom'
            : normalized.harness.trigger === 'hover' ? 'hover' : 'icon';
        if (normalized.harness.trigger === 'shortcut') normalized.customSelectionTranslatorHotkey = normalized.harness.customHotkey;
    }
    const selectionTriggerValues = ['direct', 'icon', 'dot', 'hover', 'contextMenu', 'Control', 'Alt', 'Shift', 'custom'];
    const selectionShortcutValues = ['Control', 'Alt', 'Shift', 'custom'];
    const hasExplicitSelectionTrigger = typeof source.selectionTranslatorTrigger === 'string'
        && selectionTriggerValues.includes(source.selectionTranslatorTrigger);
    if (!selectionTriggerValues.includes(normalized.selectionTranslatorTrigger)) {
        normalized.selectionTranslatorTrigger = 'icon';
    }
    if (!['none', 'Control', 'Alt', 'Shift', 'custom'].includes(normalized.selectionTranslatorHotkey)) {
        normalized.selectionTranslatorHotkey = 'none';
    }
    if (typeof normalized.customSelectionTranslatorHotkey !== 'string') {
        normalized.customSelectionTranslatorHotkey = '';
    }
    normalized.selectionTranslatorDelay = normalizeSelectionTranslatorDelay(
        source.selectionTranslatorDelay,
    );
    normalized.selectionTranslatorBidirectional = source.selectionTranslatorBidirectional === true;
    normalized.selectionTranslatorAutoDismiss = typeof source.selectionTranslatorAutoDismiss === 'boolean'
        ? source.selectionTranslatorAutoDismiss : true;
    // 兼容上一版“触发方式 + 可选快捷键”配置，并将最终状态收敛为单一触发方式。
    if (!hasExplicitSelectionTrigger
        && ['direct', 'icon', 'dot'].includes(normalized.selectionTranslatorTrigger)
        && normalized.selectionTranslatorHotkey !== 'none') {
        normalized.selectionTranslatorTrigger = normalized.selectionTranslatorHotkey;
    }
    if (selectionShortcutValues.includes(normalized.selectionTranslatorTrigger)) {
        if (normalized.selectionTranslatorTrigger === 'custom'
            && (!normalized.customSelectionTranslatorHotkey.trim() || normalized.customSelectionTranslatorHotkey === 'none')) {
            normalized.selectionTranslatorTrigger = 'icon';
            normalized.selectionTranslatorHotkey = 'none';
        } else {
            normalized.selectionTranslatorHotkey = normalized.selectionTranslatorTrigger;
        }
    } else {
        normalized.selectionTranslatorHotkey = 'none';
    }
    normalized.selectionTtsVoices = normalizeSelectionTtsVoiceOrder(normalized.selectionTtsVoices);
    normalized.selectionTtsMode = normalizeLocalTtsMode(source.selectionTtsMode);
    normalized.selectionTtsLocalVoice = normalizeLocalTtsVoice(source.selectionTtsLocalVoice);
    normalized.disableSelectionTranslator = normalized.selectionTranslatorMode === 'disabled';
    normalized.selectionTranslatorModeBeforeDisable = normalized.selectionTranslatorMode === 'translation-only'
        || (normalized.selectionTranslatorMode === 'disabled' && source.selectionTranslatorModeBeforeDisable === 'translation-only')
        ? 'translation-only' : 'bilingual';
    if (typeof normalized.vocabularyBookEnabled !== 'boolean') {
        normalized.vocabularyBookEnabled = false;
    }
    if (typeof normalized.selectionAreaEnabled !== 'boolean') {
        normalized.selectionAreaEnabled = true;
    }
    normalized.customSelectionAreaHotkey = normalizeCustomAreaTranslationHotkey(source.customSelectionAreaHotkey);
    normalized.selectionAreaHotkey = normalizeAreaTranslationHotkey(source.selectionAreaHotkey);
    // 选择自定义却没有可用组合键时回到预设默认值，圈选翻译不会失去唯一入口。
    if (normalized.selectionAreaHotkey === 'custom' && !normalized.customSelectionAreaHotkey) {
        normalized.selectionAreaHotkey = DEFAULT_AREA_TRANSLATION_HOTKEY;
    }
    if (typeof normalized.paragraphCopyEnabled !== 'boolean') {
        normalized.paragraphCopyEnabled = false;
    }
    normalized.customParagraphCopyHotkey = normalizeCustomParagraphCopyHotkey(source.customParagraphCopyHotkey);
    normalized.paragraphCopyHotkey = normalizeParagraphCopyHotkey(source.paragraphCopyHotkey);
    // 选择自定义却没有可用组合键时回到预设默认值，段落复制不会失去唯一入口。
    if (normalized.paragraphCopyHotkey === 'custom' && !normalized.customParagraphCopyHotkey) {
        normalized.paragraphCopyHotkey = DEFAULT_PARAGRAPH_COPY_HOTKEY;
    }
    normalized.paragraphCopyContent = normalizeParagraphCopyContentMode(source.paragraphCopyContent);
    if (typeof normalized.sectionTranslationHotkeyEnabled !== 'boolean') {
        normalized.sectionTranslationHotkeyEnabled = false;
    }
    normalized.customSectionTranslationHotkey = normalizeCustomSectionTranslationHotkey(source.customSectionTranslationHotkey);
    normalized.sectionTranslationHotkey = normalizeSectionTranslationHotkey(source.sectionTranslationHotkey);
    // 选择自定义却没有可用组合键时回到预设默认值，开启的快捷键不会失去可用组合。
    if (normalized.sectionTranslationHotkey === 'custom' && !normalized.customSectionTranslationHotkey) {
        normalized.sectionTranslationHotkey = DEFAULT_SECTION_TRANSLATION_HOTKEY;
    }
    if (typeof normalized.disableImageTranslator !== 'boolean') {
        normalized.disableImageTranslator = true;
    }
    normalized.imageTranslationHoverEnabled = typeof normalized.imageTranslationHoverEnabled === 'boolean' ? normalized.imageTranslationHoverEnabled : true;
    normalized.imageTranslationContextMenuEnabled = typeof normalized.imageTranslationContextMenuEnabled === 'boolean' ? normalized.imageTranslationContextMenuEnabled : true;
    if (typeof normalized.contextMenuEnabled !== 'boolean') {
        normalized.contextMenuEnabled = true;
    }
    normalized.contextMenuEntries = normalizeContextMenuEntryPreferences(source.contextMenuEntries);
    normalized.contextMenuShowTargetLanguage = normalized.contextMenuShowTargetLanguage !== false;
    normalized.contextMenuShowShortcut = normalized.contextMenuShowShortcut !== false;
    if (typeof normalized.pageTitleTranslationEnabled !== 'boolean') {
        normalized.pageTitleTranslationEnabled = true;
    }
    if (!['viewport', 'all'].includes(normalized.fullPageTranslationMode)) {
        normalized.fullPageTranslationMode = 'viewport';
    }
    normalized.translationCenterServices = normalizeStringList(source.translationCenterServices)
        .filter(service => isSupportedTranslationService(service, normalized.customOpenAIProviders));
    normalized.translationCenterSourceLanguage = normalizeConfigLanguage(source.translationCenterSourceLanguage);
    normalized.translationCenterTargetLanguage = normalizeConfigLanguage(source.translationCenterTargetLanguage);
    normalized.translationCenterLayout = source.translationCenterLayout === 'grid' ? 'grid' : 'list';
    normalized.glossaryEnabled = source.glossaryEnabled === true;
    normalized.glossaryLibraries = normalizeGlossaryLibraries(source.glossaryLibraries);
    normalized.documentGlossaryIds = normalizeGlossaryIds(source.documentGlossaryIds, normalized.glossaryLibraries);
    normalized.videoGlossaryIds = normalizeGlossaryIds(source.videoGlossaryIds, normalized.glossaryLibraries);
    normalized.quickTranslationProfiles = normalizeQuickTranslationProfiles(
        source.quickTranslationProfiles,
        {
            isSupportedService: (service) => isSupportedTranslationService(
                service,
                normalized.customOpenAIProviders,
            ),
            serviceUsesModel: (service) => isCustomOpenAIProviderId(service)
                || servicesType.isUseModel(service),
            glossaryLibraries: normalized.glossaryLibraries,
            reservedHotkeys: [
                resolveConfiguredHotkey(normalized.hotkey, normalized.customHotkey),
                resolveConfiguredHotkey(normalized.floatingBallHotkey, normalized.customFloatingBallHotkey),
                ...(normalized.selectionAreaEnabled
                    ? [resolveAreaTranslationHotkey(normalized.selectionAreaHotkey, normalized.customSelectionAreaHotkey)]
                    : []),
                ...(normalized.paragraphCopyEnabled
                    ? [resolveParagraphCopyHotkey(normalized.paragraphCopyHotkey, normalized.customParagraphCopyHotkey)]
                    : []),
                ...(normalized.sectionTranslationHotkeyEnabled
                    ? [resolveSectionTranslationHotkey(normalized.sectionTranslationHotkey, normalized.customSectionTranslationHotkey)]
                    : []),
                inputBoxTranslationTriggerHotkey(normalized.inputBoxTranslationTrigger),
            ],
        },
    );
    normalized.enableAIMultiSegment = source.enableAIMultiSegment === true;
    return normalized;
}

function cloneConfigValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(cloneConfigValue);
    if (!isRecord(value)) return value;

    const cloned: Record<string, unknown> = {};
    for (const key of Object.keys(value)) cloned[key] = cloneConfigValue(value[key]);
    return cloned;
}

function migrateModelIdentifiers(configuredModels: IMapping): void {
    for (const service of Object.keys(modelMigrations)) {
        const selectedModel = configuredModels[service];
        if (!selectedModel) continue;
        configuredModels[service] = migrateModelIdentifier(service, selectedModel);
    }
}

function migrateModelThinkingIdentifiers(normalized: Config): ModelThinkingMapping {
    const migrated: ModelThinkingMapping = {};
    for (const [service, modelStates] of Object.entries(normalized.modelThinking)) {
        const customModels = new Set(normalized.customModels[service] || []);
        const currentId = (model: string) => {
            if (customModels.has(model)) return model;
            if (service === services.deepseek
                && (model === 'deepseek-chat' || model === 'deepseek-reasoner')) {
                return currentModelIds.deepseek;
            }
            return migrateModelIdentifier(service, model);
        };
        const currentEntries = Object.entries(modelStates)
            .filter(([model]) => currentId(model) === model);
        const legacyEntries = Object.entries(modelStates)
            .filter(([model]) => currentId(model) !== model);
        for (const [model, enabled] of [...currentEntries, ...legacyEntries]) {
            const currentModel = currentId(model);
            if (Object.prototype.hasOwnProperty.call(migrated[service] || {}, currentModel)) continue;
            (migrated[service] ||= {})[currentModel] = enabled;
        }
    }
    return migrated;
}

function resolvedConfiguredModels(normalized: Config, service: string): string[] {
    return [
        resolveConfiguredModel(normalized.model[service], normalized.customModel[service]),
        resolveConfiguredModel(normalized.documentModel[service], normalized.documentCustomModel[service]),
    ].map((model) => model.trim()).filter(Boolean);
}

function validThinkingModels(normalized: Config, service: string): Set<string> {
    const provider = getCustomOpenAIProvider(normalized.customOpenAIProviders, service);
    if (provider) return new Set([...provider.models, ...resolvedConfiguredModels(normalized, service)]);
    if (!isPersistableBuiltInModelService(service)) return new Set();
    return new Set([
        ...modelsForService(service),
        ...(normalized.customModels[service] || []),
        ...resolvedConfiguredModels(normalized, service),
    ]);
}

function normalizeModelThinkingState(normalized: Config, hasSavedSchema: boolean): void {
    let mapping = migrateModelThinkingIdentifiers(normalized);
    if (!hasSavedSchema) {
        const legacyEnabled = normalized.deepseekThinkingMode === 'enabled';
        for (const model of resolvedConfiguredModels(normalized, services.deepseek)) {
            (mapping[services.deepseek] ||= {})[model] = legacyEnabled;
        }
    }

    const pruned: ModelThinkingMapping = {};
    for (const [service, modelStates] of Object.entries(mapping)) {
        const validModels = validThinkingModels(normalized, service);
        const validEntries = Object.entries(modelStates).filter(([model]) => validModels.has(model));
        if (validEntries.length > 0) pruned[service] = Object.fromEntries(validEntries);
    }
    normalized.modelThinking = pruned;
}

/**
 * 将单个官方预设的旧编号映射到当前编号，供配置加载与请求模板共同兜底。
 * 自定义模型应由调用方跳过此函数，以免改写私有部署别名。
 */
export function migrateModelIdentifier(service: string, selectedModel: string): string {
    return modelMigrations[service]?.[selectedModel] || selectedModel;
}

function isRecord(value: unknown): value is Record<string, string> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 旧默认提示词允许模型“在不必要时返回原文”，较弱的模型据此整句保留源语言，
 * 造成译文中夹杂明显应当翻译的英文（Issue #54）。仅把仍停留在历史默认值的条目
 * 升级为当前默认提示词，用户自定义的提示词按原样保留。
 */
function upgradeLegacyDefaultUserRoles(mapping: IMapping): IMapping {
    const upgraded: IMapping = {};
    for (const [service, prompt] of Object.entries(mapping)) {
        upgraded[service] = LEGACY_DEFAULT_USER_ROLES.includes(prompt)
            ? defaultOption.user_role
            : prompt;
    }
    return upgraded;
}

function normalizeStringMapping(value: unknown): IMapping {
    if (!isRecord(value)) return {};
    return Object.fromEntries(
        Object.entries(value).filter(([, item]) => typeof item === 'string'),
    );
}

/**
 * 地域会同时决定签名 scope 与请求域名，因此只保留白名单内的取值：
 * 导入配置里的未知地域回落到该服务的默认地域，不需要地域的服务直接丢弃。
 */
function normalizeCloudRegionMapping(value: unknown): IMapping {
    return Object.fromEntries(
        Object.entries(normalizeStringMapping(value))
            .filter(([service]) => servicesType.isUseRegion(service))
            .map(([service, region]) => [service, resolveCloudRegion(service, region)]),
    );
}

function normalizeCustomModelMapping(value: unknown): Record<string, string[]> {
    if (!isRecord(value)) return {};
    const normalized: Record<string, string[]> = {};
    for (const [service, models] of Object.entries(value)) {
        if (!isPersistableBuiltInModelService(service)) continue;
        const builtInModels = new Set(modelsForService(service));
        const list = normalizeCustomOpenAIModels(models, builtInModels);
        if (list.length > 0) normalized[service] = list;
    }
    return normalized;
}

function isPersistableBuiltInModelService(service: string): boolean {
    return !isCustomOpenAIProviderId(service)
        && servicesType.AI.has(service)
        && servicesType.isUseModel(service);
}

function activeSavedCustomModel(selectedModel: string, customModel: string): string {
    // direct ID 已由 canonicalizeDirectCustomModel 在调用前收敛为 sentinel。
    if (selectedModel === CUSTOM_OPENAI_RESERVED_MODEL_ID) return customModel;
    return '';
}

function modelsForService(service: string): string[] {
    // catalog contract（由 serviceCatalog.test.ts 覆盖）：每个 useModel 服务都有模型列表。
    return models.get(service)!.filter((model) => model !== CUSTOM_OPENAI_RESERVED_MODEL_ID);
}

function normalizeSavedCustomModelState(normalized: Config, hasSavedSchema: boolean): void {
    const configuredServices = new Set([
        ...Object.keys(normalized.customModels),
        ...Object.keys(normalized.customModel),
        ...Object.keys(normalized.documentCustomModel),
        ...Object.keys(normalized.model),
        ...Object.keys(normalized.documentModel),
    ]);
    for (const service of configuredServices) {
        if (!isPersistableBuiltInModelService(service)) continue;
        canonicalizeDirectCustomModel(service, normalized.model, normalized.customModel);
        canonicalizeDirectCustomModel(service, normalized.documentModel, normalized.documentCustomModel);
        const activeModels = [
            activeSavedCustomModel(normalized.model[service], normalized.customModel[service]),
            activeSavedCustomModel(
                normalized.documentModel[service],
                normalized.documentCustomModel[service],
            ),
        ];
        protectSavedCustomModels(normalized.customModels, service, hasSavedSchema
            ? activeModels
            : [normalized.customModel[service], normalized.documentCustomModel[service], ...activeModels]);
    }
}

function canonicalizeDirectCustomModel(service: string, selected: IMapping, custom: IMapping): void {
    const selectedModel = selected[service];
    if (!selectedModel
        || selectedModel === CUSTOM_OPENAI_RESERVED_MODEL_ID
        || modelsForService(service).includes(selectedModel)) return;
    selected[service] = CUSTOM_OPENAI_RESERVED_MODEL_ID;
    custom[service] = selectedModel;
}

function protectSavedCustomModels(
    mapping: Record<string, string[]>,
    service: string,
    values: readonly string[],
): void {
    const builtInModels = new Set(modelsForService(service));
    const protectedModels = normalizeCustomOpenAIModels(values).filter((model) => !builtInModels.has(model));
    if (protectedModels.length === 0) return;
    const protectedSet = new Set(protectedModels);
    const savedModels = [...(mapping[service] || [])];
    protectedModels.forEach((model) => {
        if (!savedModels.includes(model)) savedModels.push(model);
    });
    while (savedModels.length > MAX_CUSTOM_OPENAI_MODELS_PER_PROVIDER) {
        let removableIndex = savedModels.length - 1;
        while (removableIndex >= 0 && protectedSet.has(savedModels[removableIndex])) removableIndex -= 1;
        // protectedModels 本身最多 50 个，因此溢出时一定还存在一个非保护项。
        savedModels.splice(removableIndex, 1);
    }
    mapping[service] = savedModels.slice(0, MAX_CUSTOM_OPENAI_MODELS_PER_PROVIDER);
}

function withoutRetiredServiceEntries<T>(mapping: Record<string, T>): Record<string, T> {
    return Object.fromEntries(
        Object.entries(mapping).filter(([service]) => !retiredServiceIds.has(service)),
    );
}

function withoutRetiredRequirementEntries(mapping: Record<string, boolean>): Record<string, boolean> {
    return Object.fromEntries(
        Object.entries(mapping).filter(([key]) => !Array.from(retiredServiceIds).some(
            service => key === service || key.startsWith(`${service}:`),
        )),
    );
}

function isSupportedTranslationService(
    value: unknown,
    customProviders: readonly CustomOpenAIProvider[],
): value is string {
    if (typeof value !== 'string') return false;
    if (isCustomOpenAIProviderId(value)) {
        return isConfiguredCustomOpenAIProvider(customProviders, value);
    }
    return servicesType.machine.has(value) || servicesType.AI.has(value);
}

function normalizeStringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean))];
}

function normalizeConfigLanguage(value: unknown): string {
    return typeof value === 'string' ? normalizeChineseLanguageCode(value) : '';
}

function isBooleanMapping(value: unknown): value is Record<string, boolean> {
    return typeof value === 'object'
        && value !== null
        && !Array.isArray(value)
        && Object.values(value).every((item) => typeof item === 'boolean');
}

// 构建所有服务的 system_role
function systemRoleFactory(): IMapping {
    let systems_role: IMapping = {};
    Object.keys(services).forEach(key => systems_role[key] = defaultOption.system_role);
    return systems_role;
}

// 构建所有服务的 user_role
function userRoleFactory(): IMapping {
    let users_role: IMapping = {};
    Object.keys(services).forEach(key => users_role[key] = defaultOption.user_role);
    return users_role;
}
