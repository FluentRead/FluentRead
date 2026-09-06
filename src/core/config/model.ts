/**
 * @file src/core/config/model.ts
 *
 * 文件职责：定义 FluentRead 完整配置模型、默认值及各项设置的合法范围，是配置读取、保存、迁移和 UI 绑定共同依赖的领域契约。
 * 主要内容：包含正文/全部节点识别范围；统一中文简繁标识及历史配置别名，并包含 Config 接口、defaultConfig、字幕和翻译模式类型、延迟与字号范围、默认 API 地址及多项功能开关，使新增配置项在一个位置获得类型和初始语义。 可核对的公开符号包括 DeepSeekApiType、DeepSeekThinkingMode、VideoSubtitleDisplayMode、FullPageTranslationMode、DEFAULT_VIDEO_SUBTITLE_FONT_SIZE、DEFAULT_NEW_API_URL、VIDEO_SUBTITLE_FONT_SIZE_OPTIONS、DEFAULT_MOUSE_HOVER_TRANSLATION_DELAY。
 * 模块边界：本文件属于 core 领域层，只定义规则、类型与纯转换；不直接读写浏览器存储、不发起网络请求、不挂载 Vue/WXT 入口，持久化、协议调用和界面编排分别由 services、providers 与 features 承担。
 */

import type {TranslationScope} from '@/src/core/translation/types';
import {
    currentModelIds,
    defaultModels,
    defaultOption,
    models,
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
    normalizeMyMemoryEmail,
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
import {
    DEFAULT_TRANSLATION_CACHE_MAX_BYTES,
    DEFAULT_TRANSLATION_CACHE_MAX_ENTRIES,
    normalizeTranslationCacheLimits,
} from './translationCache';
import {normalizeChineseLanguageCode} from '@/src/core/language/chinese';
import {resolveConfiguredHotkey} from '@/src/core/hotkey';
import { normalizeSelectionTtsVoiceOrder } from "./selectionTts";
import { normalizeUiLanguage, type UiLanguage } from '@/src/core/i18n/language';
import {normalizeGlossaryIds, normalizeGlossaryLibraries, type GlossaryLibrary} from '@/src/core/glossary';
import {
    inputBoxTranslationTriggerHotkey,
    normalizeQuickTranslationProfiles,
    type QuickTranslationProfile,
} from './quickTranslation';
import {
    DEFAULT_INTERFACE_VISIBILITY,
    DEFAULT_POPUP_MODULE_ORDER,
    DEFAULT_POPUP_QUICK_FEATURE_ORDER,
    DEFAULT_POPUP_QUICK_FEATURE_VISIBILITY,
    normalizeInterfaceSkin,
    normalizeInterfaceVisibility,
    normalizePopupModuleOrder,
    normalizePopupQuickFeatureOrder,
    normalizePopupQuickFeatureVisibility,
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
    normalizeMaxConcurrentTranslations,
    normalizeTranslationBackoffBaseMs,
    normalizeTranslationBackoffMaxMs,
    normalizeTranslationMaxRetries,
    normalizeTranslationRequestsPerMinute,
    normalizeTranslationRequestsPerSecond,
} from './scheduling';
import {DEFAULT_HARNESS_PREFERENCES, normalizeHarnessPreferences, type HarnessPreferences} from './harness';
import {
    DEFAULT_VIDEO_SUBTITLE_APPEARANCE,
    normalizeVideoSubtitleAppearance,
    type VideoSubtitleAppearance,
} from './videoSubtitleAppearance';

export * from './scheduling';

export type DeepSeekApiType = 'auto' | 'responses' | 'chat';
export type DeepSeekThinkingMode = 'enabled' | 'disabled';
export type VideoSubtitleDisplayMode = 'bilingual' | 'translation-only' | 'original-only';
export type VideoLocalTranscriptionModel = 'tiny' | 'base';
export type VideoSourceLanguage = 'auto' | 'en' | 'zh-Hans' | 'ja' | 'ko' | 'fr' | 'ru' | 'es' | 'de' | 'pt' | 'it';
export type FullPageTranslationMode = 'viewport' | 'all';
export const DEFAULT_VIDEO_SUBTITLE_FONT_SIZE = 100;
export const DEFAULT_NEW_API_URL = 'http://localhost:3000';
export const VIDEO_SUBTITLE_FONT_SIZE_OPTIONS = [80, 90, 100, 110, 120, 140, 160] as const;
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

export function normalizeMouseHoverTranslationDelay(value: unknown): number {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) return DEFAULT_MOUSE_HOVER_TRANSLATION_DELAY;
    const rounded = Math.round(number / MOUSE_HOVER_TRANSLATION_DELAY_STEP) * MOUSE_HOVER_TRANSLATION_DELAY_STEP;
    return Math.min(
        MOUSE_HOVER_TRANSLATION_DELAY_MAX,
        Math.max(MOUSE_HOVER_TRANSLATION_DELAY_MIN, rounded),
    );
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
    hotkey: string;
    style: number;
    display: number = 1;
    service: string;
    documentService: string; // 文档翻译独立翻译服务
    documentModel: IMapping; // 文档翻译按服务保存的独立模型选择
    documentCustomModel: IMapping; // 文档翻译按服务保存的独立自定义模型
    videoTranslationEnabled: boolean; // 是否启用视频字幕翻译 Beta
    videoService: string; // 视频字幕独立翻译服务
    videoLocalModel: VideoLocalTranscriptionModel; // X 无原生字幕时使用的本地 Whisper 模型
    videoSourceLanguage: string; // 视频原语言，auto 表示自动识别；独立于网页翻译 from
    videoServiceDefaultMigrated: boolean; // 是否已迁移视频字幕默认服务
    videoSubtitleVisible: boolean; // 是否显示 FluentRead 视频字幕
    videoSubtitleDisplayMode: VideoSubtitleDisplayMode; // 视频字幕显示模式
    videoSubtitleFontSize: number; // 视频字幕字号百分比
    videoSubtitleAppearance: VideoSubtitleAppearance; // 视频字幕皮肤与布局参数
    token: IMapping;
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
    customBody: IMapping;  // 自定义请求体（JSON 字符串，按服务存储），会合并进请求体
    proxy: IMapping;  // 代理地址
    custom: string; // 本地服务地址
    extra: IExtra;  // 额外信息（内包信息）
    system_role: IMapping;
    user_role: IMapping;
    count: number;  // 翻译次数
    theme: string;  // 主题模式：'auto' | 'light' | 'dark'
    interfaceSkin: InterfaceSkin; // 扩展界面皮肤；默认保留当前界面
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
    contextMenuEnabled: boolean; // 是否显示右键全文翻译菜单
    translationScope: TranslationScope; // 页面识别正文或全部可见界面文字
    fullPageTranslationMode: FullPageTranslationMode; // 全文翻译按视口加载或立即处理整页
    disableFloatingBall: boolean; // 是否禁用悬浮球
    floatingBallPosition: 'left' | 'right'; // 悬浮球位置
    floatingBallHotkey: string; // 悬浮球快捷键
    customFloatingBallHotkey: string; // 自定义悬浮球快捷键
    customHotkey: string; // 自定义鼠标悬浮快捷键
    quickTranslationProfiles: QuickTranslationProfile[]; // 额外快捷翻译方案；悬浮与全文各最多 8 项
    mouseHoverTranslationDelay: number; // 鼠标悬浮翻译触发延迟（毫秒）
    disableSelectionTranslator: boolean; // 是否禁用划词翻译
    selectionAreaEnabled: boolean; // 是否启用圈选翻译
    areaTranslationMode: 'standard' | 'ai'; // 圈选文字的标准翻译或 AI 上下文增强
    areaTranslationService: string; // 圈选独立翻译服务；空字符串跟随当前服务
    imageTranslationHoverEnabled: boolean; // 是否显示图片悬浮入口
    imageTranslationContextMenuEnabled: boolean; // 是否显示图片右键入口
    disableImageTranslator: boolean; // 是否禁用图片翻译
    freeTranslationOrder: string[]; // 免费服务的启用列表与回退顺序
    freeTranslationTimeoutMs: number; // 每路服务最长等待
    freeTranslationCooldownMs: number; // 失败服务的暂时跳过时间
    myMemoryEmail: string; // MyMemory 可选额度联系邮箱
    deeplApiPlan: DeepLApiPlan; // DeepL API Free / Pro 套餐
    deeplx: string; // DeepLX 服务地址
    selectionTranslatorMode: string; // 划词翻译显示模式: 'disabled' | 'bilingual' | 'translation-only'
    selectionTranslatorTrigger: string; // 划词翻译互斥触发方式: 'direct' | 'icon' | 'dot' | 'Control' | 'Alt' | 'Shift' | 'custom'
    selectionTranslatorHotkey: string; // 旧版快捷键字段；与 selectionTranslatorTrigger 中的快捷键选项保持镜像
    customSelectionTranslatorHotkey: string; // 自定义划词翻译快捷键
    selectionTranslatorDelay: number; // 选区稳定后显示划词翻译入口的延迟（毫秒）
    selectionTtsVoices: string[]; // 划词朗读的 Edge TTS 音色回退顺序
    vocabularyBookEnabled: boolean; // 是否启用本地单词本 Beta
    newApiUrl: string; // NewAPI地址
    maxConcurrentTranslations: number; // 最大并发翻译数量
    translationRequestsPerSecond: number; // 每秒最多启动的翻译请求数，0 表示不限速
    translationRequestsPerMinute: number; // 每分钟最多启动的翻译请求数，0 表示不限速
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
    deepseekApiType: DeepSeekApiType; // DeepSeek API 格式
    deepseekThinkingMode: DeepSeekThinkingMode; // DeepSeek Chat Completion 思考模式
    translationCenterServices: string[]; // 翻译中心已选服务及其展示顺序
    translationCenterSourceLanguage: string; // 翻译中心源语言
    translationCenterTargetLanguage: string; // 翻译中心目标语言
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
        this.style = defaultOption.style;
        this.display = defaultOption.display;
        this.hotkey = defaultOption.hotkey;
        this.service = defaultOption.service;
        this.documentService = defaultOption.service;
        this.documentModel = Object.fromEntries(
            [...defaultModels].filter(([service]) => service !== LEGACY_CUSTOM_OPENAI_PROVIDER_ID),
        );
        this.documentCustomModel = {};
        this.videoTranslationEnabled = true; // 默认开启视频字幕翻译
        this.videoService = services.microsoft; // 视频字幕默认使用微软翻译
        this.videoLocalModel = 'tiny';
        this.videoSourceLanguage = 'auto';
        this.videoServiceDefaultMigrated = true;
        this.videoSubtitleVisible = true; // 默认显示视频译文
        this.videoSubtitleDisplayMode = 'bilingual'; // 默认双语显示
        this.videoSubtitleFontSize = DEFAULT_VIDEO_SUBTITLE_FONT_SIZE; // 默认字幕字号
        this.videoSubtitleAppearance = normalizeVideoSubtitleAppearance(DEFAULT_VIDEO_SUBTITLE_APPEARANCE);
        this.token = {};
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
        this.customBody = {};
        this.proxy = {};
        this.custom = defaultOption.custom;
        this.extra = {};
        this.system_role = systemRoleFactory();
        this.user_role = userRoleFactory();
        this.count = 0;
        this.theme = 'auto';  // 默认跟随系统
        this.interfaceSkin = 'default'; // 默认保留当前界面
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
        this.contextMenuEnabled = true; // 默认显示右键全文翻译入口
        this.translationScope = 'content'; // 默认只识别正文，全部节点由高级设置显式开启
        this.fullPageTranslationMode = 'viewport'; // 默认按阅读进度翻译，避免一次发出过多请求
        this.disableFloatingBall = true; // 默认关闭悬浮球
        this.floatingBallPosition = 'right'; // 默认在右侧
        this.floatingBallHotkey = 'Alt+T'; // 默认快捷键为 Alt+T
        this.customFloatingBallHotkey = ''; // 自定义快捷键为空
        this.customHotkey = ''; // 自定义鼠标悬浮快捷键为空
        this.quickTranslationProfiles = []; // 默认仅保留旧快捷键，新方案由用户按需添加
        this.mouseHoverTranslationDelay = DEFAULT_MOUSE_HOVER_TRANSLATION_DELAY;
        this.disableSelectionTranslator = true; // 默认关闭划词翻译
        this.selectionAreaEnabled = true; // 默认开启，按快捷键圈选后才截图翻译
        this.areaTranslationMode = 'standard';
        this.areaTranslationService = '';
        this.imageTranslationHoverEnabled = true;
        this.imageTranslationContextMenuEnabled = true;
        this.disableImageTranslator = false; // 默认开启图片翻译入口，点击后才翻译
        this.freeTranslationOrder = [...DEFAULT_FREE_TRANSLATION_ORDER];
        this.freeTranslationTimeoutMs = DEFAULT_FREE_TRANSLATION_TIMEOUT_MS;
        this.freeTranslationCooldownMs = DEFAULT_FREE_TRANSLATION_COOLDOWN_MS;
        this.myMemoryEmail = '';
        this.deeplApiPlan = DEFAULT_DEEPL_API_PLAN; // 兼容既有 DeepL API Free 默认端点
        this.deeplx = defaultOption.deeplx; // DeepLX 默认服务地址
        this.selectionTranslatorMode = 'disabled'; // 默认关闭划词翻译
        this.selectionTranslatorTrigger = 'icon'; // 默认显示可发现的操作图标
        this.selectionTranslatorHotkey = 'none'; // 默认不增加额外快捷键，保持原有划词行为
        this.customSelectionTranslatorHotkey = ''; // 自定义划词翻译快捷键为空
        this.selectionTranslatorDelay = DEFAULT_SELECTION_TRANSLATOR_DELAY;
        this.selectionTtsVoices = []; // 默认按当前语言使用内置音色回退顺序
        this.vocabularyBookEnabled = false; // Beta 默认关闭，由用户在单词本页面主动开启
        this.newApiUrl = DEFAULT_NEW_API_URL; // NewAPI 默认地址
        this.maxConcurrentTranslations = DEFAULT_MAX_CONCURRENT_TRANSLATIONS; // 默认最大并发数为3
        this.translationRequestsPerSecond = DEFAULT_TRANSLATION_REQUESTS_PER_SECOND;
        this.translationRequestsPerMinute = DEFAULT_TRANSLATION_REQUESTS_PER_MINUTE;
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
        this.deepseekApiType = 'auto'; // DeepSeek 默认自动选择 API 格式
        this.deepseekThinkingMode = 'disabled'; // 翻译默认关闭思考模式，降低延迟和输出噪音
        this.translationCenterServices = [];
        this.translationCenterSourceLanguage = '';
        this.translationCenterTargetLanguage = '';
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
    [services.jieyue]: {
        'step-1-8k': currentModelIds.jieyue,
    },
    [services.huanYuan]: {
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
        || configuredString(source.proxy, LEGACY_CUSTOM_OPENAI_PROVIDER_ID)
        || configuredString(source.customBody, LEGACY_CUSTOM_OPENAI_PROVIDER_ID)) return true;
    const systemRole = configuredString(source.system_role, LEGACY_CUSTOM_OPENAI_PROVIDER_ID);
    const userRole = configuredString(source.user_role, LEGACY_CUSTOM_OPENAI_PROVIDER_ID);
    if ((systemRole && systemRole !== defaultOption.system_role)
        || (userRole && userRole !== defaultOption.user_role)) return true;

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
    normalized.inputBoxTranslationTarget = normalizeConfigLanguage(source.inputBoxTranslationTarget)
        || defaultOption.inputBoxTranslationTarget;
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
    normalized.freeTranslationOrder = normalizeFreeTranslationOrder(source.freeTranslationOrder);
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

    normalized.token = withoutRetiredServiceEntries(normalizeStringMapping(source.token));
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
    normalized.user_role = {
        ...userRoleFactory(),
        ...withoutRetiredServiceEntries(normalizeStringMapping(source.user_role)),
    };
    normalized.customBody = withoutRetiredServiceEntries(normalizeCustomBodyMapping(source.customBody));

    if (typeof normalized.custom !== 'string') normalized.custom = defaultOption.custom;
    normalized.deeplApiPlan = normalizeDeepLApiPlan(source.deeplApiPlan);
    if (typeof normalized.newApiUrl !== 'string') normalized.newApiUrl = DEFAULT_NEW_API_URL;
    normalizeCustomOpenAIProviderState(normalized, source);
    normalized.harness = normalizeHarnessPreferences(source.harness, normalized.customOpenAIProviders);

    if (!isSupportedTranslationService(normalized.service, normalized.customOpenAIProviders)) {
        normalized.service = defaultOption.service;
    }

    if (!isSupportedTranslationService(normalized.documentService, normalized.customOpenAIProviders)) {
        normalized.documentService = defaultOption.service;
    }

    normalized.areaTranslationMode = source.areaTranslationMode === 'ai' ? 'ai' : 'standard';
    normalized.areaTranslationService = isSupportedTranslationService(source.areaTranslationService, normalized.customOpenAIProviders)
        ? source.areaTranslationService : '';

    if (typeof normalized.videoTranslationEnabled !== 'boolean') {
        normalized.videoTranslationEnabled = true;
    }
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
        normalized.videoService = services.microsoft;
    }
    normalized.videoServiceDefaultMigrated = true;
    if (typeof normalized.videoSubtitleVisible !== 'boolean') {
        normalized.videoSubtitleVisible = true;
    }
    if (!['bilingual', 'translation-only', 'original-only'].includes(normalized.videoSubtitleDisplayMode)) {
        normalized.videoSubtitleDisplayMode = 'bilingual';
    }
    normalized.videoSubtitleFontSize = normalizeVideoSubtitleFontSize(normalized.videoSubtitleFontSize);
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
        // 官方迁移指南要求 reasoner 使用 v4-flash 并显式开启 thinking。
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

    normalized.mouseHoverTranslationDelay = normalizeMouseHoverTranslationDelay(
        source.mouseHoverTranslationDelay,
    );
    normalized.alwaysTranslateDomains = normalizeAlwaysTranslateDomains(source.alwaysTranslateDomains);
    normalized.disabledExtensionDomains = normalizeDisabledExtensionDomains(source.disabledExtensionDomains);
    normalized.siteAdaptation = normalizeSiteAdaptationSettings(source.siteAdaptation);
    normalized.interfaceSkin = normalizeInterfaceSkin(source.interfaceSkin);
    normalized.interfaceVisibility = normalizeInterfaceVisibility(source.interfaceVisibility);
    normalized.popupModuleOrder = normalizePopupModuleOrder(source.popupModuleOrder);
    normalized.popupQuickFeatureOrder = normalizePopupQuickFeatureOrder(source.popupQuickFeatureOrder);
    normalized.popupQuickFeatureVisibility = normalizePopupQuickFeatureVisibility(source.popupQuickFeatureVisibility);

    if (!['disabled', 'bilingual', 'translation-only'].includes(normalized.selectionTranslatorMode)) {
        normalized.selectionTranslatorMode = 'disabled';
    }
    const selectionTriggerValues = ['direct', 'icon', 'dot', 'Control', 'Alt', 'Shift', 'custom'];
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
    normalized.disableSelectionTranslator = normalized.selectionTranslatorMode === 'disabled';
    if (typeof normalized.vocabularyBookEnabled !== 'boolean') {
        normalized.vocabularyBookEnabled = false;
    }
    if (typeof normalized.selectionAreaEnabled !== 'boolean') {
        normalized.selectionAreaEnabled = true;
    }
    if (typeof normalized.disableImageTranslator !== 'boolean') {
        normalized.disableImageTranslator = false;
    }
    normalized.imageTranslationHoverEnabled = typeof normalized.imageTranslationHoverEnabled === 'boolean' ? normalized.imageTranslationHoverEnabled : true;
    normalized.imageTranslationContextMenuEnabled = typeof normalized.imageTranslationContextMenuEnabled === 'boolean' ? normalized.imageTranslationContextMenuEnabled : true;
    if (typeof normalized.contextMenuEnabled !== 'boolean') {
        normalized.contextMenuEnabled = true;
    }
    if (!['viewport', 'all'].includes(normalized.fullPageTranslationMode)) {
        normalized.fullPageTranslationMode = 'viewport';
    }
    normalized.translationCenterServices = normalizeStringList(source.translationCenterServices)
        .filter(service => isSupportedTranslationService(service, normalized.customOpenAIProviders));
    normalized.translationCenterSourceLanguage = normalizeConfigLanguage(source.translationCenterSourceLanguage);
    normalized.translationCenterTargetLanguage = normalizeConfigLanguage(source.translationCenterTargetLanguage);
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
                ...(normalized.selectionAreaEnabled ? ['Shift+Z'] : []),
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

function normalizeStringMapping(value: unknown): IMapping {
    if (!isRecord(value)) return {};
    return Object.fromEntries(
        Object.entries(value).filter(([, item]) => typeof item === 'string'),
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
