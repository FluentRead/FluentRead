/**
 * @file src/core/config/model/configClass.ts
 *
 * 文件职责：定义 FluentRead 顶层 Config 配置类及开箱默认字段初始化与默认提示词映射构造器。
 * 主要内容：导出 Config 类以及 systemRoleFactory、userRoleFactory，在构造函数中声明并初始化全部翻译、外观、快捷键、视频字幕、划词、文档、词汇本、限流与隐私防护字段；userscript 构建下跳过扩展专属词典与个人校订字段。
 * 模块边界：仅负责领域配置对象结构与初始默认值构造，不包含旧配置迁移或导入归一化逻辑；归一化编排由同目录 normalizeConfig.ts 承担。
 */

import {normalizePrivacyPolicy, type PrivacyProtectionPolicy} from '../../privacy/policy';
import {DEFAULT_AI_MULTI_SEGMENT_MAX_CHARACTERS, DEFAULT_AI_MULTI_SEGMENT_MAX_SEGMENTS} from '../aiMultiSegment';
import {DEFAULT_AI_REQUEST_TIMEOUT_MS} from '../aiRequestTimeout';
import {DEFAULT_AREA_TRANSLATION_HOTKEY} from '../areaTranslation';
import {defaultModels} from '../catalog/models';
import {defaultOption} from '../catalog/prompts';
import type {MiniMaxBillingPlan, MiniMaxRegion, MiMoBillingPlan, MiMoRegion} from '../catalog/regions';
import {services} from '../catalog/services';
import {DEFAULT_CLICK_SELECTION_HOTKEY} from '../clickSelection';
import type {CompositeTranslationProvider} from '../compositeTranslation';
import {LEGACY_CUSTOM_OPENAI_PROVIDER_ID, type CustomOpenAIProvider} from '../customOpenAI';
import {DEFAULT_DEEPL_API_PLAN, type DeepLApiPlan} from '../deepl';
import {defaultDictionaryWorkspace, type DictionaryWorkspace} from '../dictionaryWorkspace';
import {
    DEFAULT_FREE_TRANSLATION_COOLDOWN_MS,
    DEFAULT_FREE_TRANSLATION_MODE,
    DEFAULT_FREE_TRANSLATION_ORDER,
    DEFAULT_FREE_TRANSLATION_TIMEOUT_MS,
    type FreeTranslationMode,
} from '../freeTranslation';
import {DEFAULT_HARNESS_PREFERENCES, normalizeHarnessPreferences, type HarnessPreferences} from '../harness';
import {DEFAULT_INFORMATION_HIGHLIGHT_PREFERENCES, type InformationHighlightPreferences} from '../informationHighlight';
import {DEFAULT_INPUT_BOX_TRANSLATION_INTERVAL, type InputBoxTranslationOutputMode} from '../inputTranslation';
import {
    DEFAULT_INTERFACE_FONT,
    DEFAULT_INTERFACE_VISIBILITY,
    DEFAULT_POPUP_MODULE_ORDER,
    DEFAULT_POPUP_QUICK_FEATURE_ORDER,
    DEFAULT_POPUP_QUICK_FEATURE_VISIBILITY,
    type InterfaceFont,
    type InterfaceSkin,
    type InterfaceVisibility,
    type PopupModuleId,
    type PopupQuickFeatureId,
    type PopupQuickFeatureVisibility,
} from '../interfaceAppearance';
import {DEFAULT_LOCAL_TTS_MODE, DEFAULT_LOCAL_TTS_VOICE, type LocalTtsMode, type LocalTtsVoiceId} from '../localTts';
import type {MangaSiteRule} from '../mangaNormalization';
import type {ModelThinkingMapping} from '../modelThinking';
import {DEFAULT_NATIVE_ASR_BASE_URL} from '../nativeAsr';
import {DEFAULT_NATIVE_BATCH_TRANSLATION_ENABLED} from '../nativeBatch';
import {DEFAULT_EAGER_TRANSLATION_CHARACTERS, DEFAULT_MIN_TRANSLATION_TEXT_LENGTH} from '../pageTranslation';
import {
    DEFAULT_PARAGRAPH_COPY_CONTENT_MODE,
    DEFAULT_PARAGRAPH_COPY_HOTKEY,
    type ParagraphCopyContentMode,
} from '../paragraphCopy';
import type {QuickTranslationProfile} from '../quickTranslation';
import type {RequestHeaderRule} from '../requestHeaders';
import type {ModelRequestLimits, ServiceRequestLimits} from '../requestLimits';
import {
    DEFAULT_API_KEY_RECOVERY_MS,
    DEFAULT_MAX_CONCURRENT_TRANSLATIONS,
    DEFAULT_TRANSLATION_BACKOFF_BASE_MS,
    DEFAULT_TRANSLATION_BACKOFF_MAX_MS,
    DEFAULT_TRANSLATION_MAX_RETRIES,
    DEFAULT_TRANSLATION_REQUESTS_PER_MINUTE,
    DEFAULT_TRANSLATION_REQUESTS_PER_SECOND,
} from '../scheduling';
import {DEFAULT_SECTION_TRANSLATION_HOTKEY} from '../sectionTranslation';
import type {SectionTranslationRule} from '../sectionTranslationRules';
import type {WordDictionarySourceSetting} from '../selectionDictionary';
import {
    DEFAULT_SELECTION_TTS_ONLINE_SOURCES,
    DEFAULT_SELECTION_TTS_OPENAI_MODEL,
    DEFAULT_SELECTION_TTS_OPENAI_VOICE,
    DEFAULT_SELECTION_TTS_RATE,
    type SelectionTtsOnlineSourceId,
    type SelectionTtsOpenAiModel,
    type SelectionTtsOpenAiVoice,
} from '../selectionTts';
import {
    DEFAULT_SENTENCE_HIGHLIGHT_APPEARANCE,
    DEFAULT_SENTENCE_HIGHLIGHT_STYLE,
    type SentenceHighlightAppearance,
    type SentenceHighlightProfile,
    type SentenceHighlightStyle,
} from '../sentenceHighlight';
import {DEFAULT_DISABLED_AI_PLATFORM_SERVICES} from '../serviceAvailability';
import {normalizeShareCardPreferences, type ShareCardPreferences} from '../shareCard';
import {
    DEFAULT_TRANSLATION_APPEARANCE,
    normalizeTranslationAppearance,
    type TranslationAppearance,
    type TranslationStyleProfile,
} from '../translationAppearance';
import {DEFAULT_TRANSLATION_CACHE_MAX_BYTES, DEFAULT_TRANSLATION_CACHE_MAX_ENTRIES} from '../translationCache';
import {DEFAULT_TRANSLATION_LOADING_STYLE, type TranslationLoadingStyle} from '../translationLoadingStyle';
import {normalizeVideoCourseAutoStart, type VideoCourseAutoStart} from '../videoCourse';
import {
    DEFAULT_VIDEO_SENTENCE_LEARNING_APPEARANCE,
    normalizeVideoSentenceLearningAppearance,
    type VideoSentenceLearningAppearance,
} from '../videoSentenceLearningAppearance';
import {
    DEFAULT_VIDEO_SUBTITLE_APPEARANCE,
    normalizeVideoSubtitleAppearance,
    type VideoSubtitleAppearance,
} from '../videoSubtitleAppearance';
import {
    DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY,
    DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY_ACTION,
    type VideoSubtitleModeHotkeyAction,
} from '../videoSubtitleShortcut';
import {DEFAULT_AREA_VISION_PROMPT, type AreaRecognitionMode, type ModelVisionOverrides} from '../vision';
import {normalizeWritingPreferences, type WritingPreferences} from '../writing';
import type {ContextMenuEntryPreferences} from '@/src/core/context-menu/domain';
import type {GlossaryLibrary} from '@/src/core/glossary';
import type {UiLanguage} from '@/src/core/i18n/language';
import {normalizeSiteAdaptationSettings} from '@/src/core/site-adaptation/schema';
import type {SiteAdaptationSettings} from '@/src/core/site-adaptation/types';
import type {TranslationScope} from '@/src/core/translation/types';
import {
    DEFAULT_FLOATING_BALL_COLLAPSED_OPACITY,
    DEFAULT_FLOATING_BALL_DEFAULT_MARGIN,
    DEFAULT_FLOATING_BALL_HOVER_DELAY,
    DEFAULT_FLOATING_BALL_POPOUT_MARGIN,
    DEFAULT_MOUSE_HOVER_TRANSLATION_DELAY,
    DEFAULT_NEW_API_URL,
    DEFAULT_SELECTION_TRANSLATOR_DELAY,
    DEFAULT_VIDEO_SUBTITLE_FONT_SIZE,
} from './interactionDefaults';
import type {
    DeepSeekApiType,
    DeepSeekThinkingMode,
    FloatingBallClickAction,
    FloatingBallToolsDisplay,
    FullPageTranslationMode,
    IExtra,
    IMapping,
    TranslationSidepanelScope,
    VideoLocalTranscriptionModel,
    VideoSubtitleDisplayMode,
    VideoTranscriptionProvider,
} from './types';

// 构建所有服务的 system_role
export function systemRoleFactory(): IMapping {
    const systems_role: IMapping = {};
    Object.keys(services).forEach(key => systems_role[key] = defaultOption.system_role);
    return systems_role;
}

// 构建所有服务的 user_role
export function userRoleFactory(): IMapping {
    const users_role: IMapping = {};
    Object.keys(services).forEach(key => users_role[key] = defaultOption.user_role);
    return users_role;
}

export class Config {
    on: boolean; // 是否开启
    uiLanguage: UiLanguage; // 扩展界面语言，不影响网页翻译的目标语言
    uiLanguageSetupCompleted: boolean; // 是否已完成首次 Popup 的界面语言选择
    autoTranslate: boolean; // 是否即时翻译
    alwaysTranslateDomains: string[]; // 始终自动翻译的可注册域名（eTLD+1）
    disabledExtensionDomains: string[]; // 禁用扩展的可注册域名（eTLD+1）
    translationOnlyDomains: string[]; // 仅显示译文的网站；其他网站继续沿用全局 display
    siteAdaptation: SiteAdaptationSettings; // 网站内容范围、保护区域及本地 JSON 适配规则
    from: string;
    to: string;
    excludedLanguages: string[]; // 网页全文、悬浮及标题翻译跳过的语言
    excludedTags: string[]; // 网页全文及悬浮翻译跳过的 HTML 标签或 CSS 选择器
    hotkey: string;
    hoverShortcutBeforeDisable: string; // 关闭默认悬停开关前的选择，重开恢复；不参与运行时触发
    style: number;
    translationAppearance: TranslationAppearance; // 双语译文的颜色、线条、底色、字号、字重、字体与不透明度微调
    browserDefaultTranslationFont: boolean; // 所有网页的双语和仅译文统一使用浏览器默认字体，不改写原有外观配置
    translationStyleProfiles: TranslationStyleProfile[]; // 用户保存的可命名译文样式快照
    activeTranslationStyleProfileId: string; // 当前选中的样式快照；外观可继续编辑，保存时再更新快照
    display: number = 1;
    service: string;
    disabledTranslationServices: string[]; // 用户关闭的服务；关闭后停止新请求并从选择项中禁选
    aiPlatformDefaultRemovalMigrated: boolean; // 指定 AI 平台默认移除策略的一次性迁移标记
    hoverTranslationService: string; // 悬浮翻译服务，空值跟随默认网页服务
    selectionTranslationService: string; // 普通划词翻译服务，空值跟随默认网页服务
    imageTranslationService: string; // 图片 OCR 后的文字翻译服务，空值跟随默认网页服务
    imageTranslationOcrEngine: 'tesseract' | 'paddle'; // 单图识别方式；漫画按源语言选择专用模型，俄语/韩语使用既有语言包
    imageTranslationInferenceBackend: 'auto' | 'cpu'; // 图片与漫画的本地模型共用；CPU 从首次初始化起使用单线程 WASM
    documentService: string; // 文档服务，空值跟随网页默认
    documentModel: IMapping; // 文档翻译按服务保存的独立模型选择
    documentCustomModel: IMapping; // 文档翻译按服务保存的独立自定义模型
    videoTranslationEnabled: boolean; // 是否启用视频字幕翻译 Beta
    videoMeetingAutoEnabled: boolean; // 自动开启会议平台的本地字幕显示
    videoCourseAutoStart: VideoCourseAutoStart; // 每个课程站点分别决定新视频是否自动翻译
    videoPreferHumanSubtitles: boolean; // 优先使用目标语言人工字幕
    videoService: string; // 字幕服务，空值跟随网页默认
    videoLocalModel: VideoLocalTranscriptionModel; // X 无原生字幕时使用的本地 Whisper 模型
    videoTranscriptionProvider: VideoTranscriptionProvider; // 本机 Qwen 仅在明确选择后启用
    videoNativeAsrBaseUrl: string; // 发送前仍须校验回环端点，保存不探测服务
    videoSourceLanguage: string; // 视频原语言，auto 表示自动识别；独立于网页翻译 from
    videoServiceDefaultMigrated: boolean; // 是否已迁移视频字幕默认服务
    videoSubtitleVisible: boolean; // 是否显示 FluentRead 视频字幕
    videoSubtitleDisplayMode: VideoSubtitleDisplayMode; // 视频字幕显示模式
    videoSubtitleModeHotkeyEnabled: boolean; // 是否启用快捷键切换视频字幕显示模式
    videoSubtitleModeHotkey: string; // 视频字幕模式切换快捷键；'custom' 表示使用自定义组合键
    customVideoSubtitleModeHotkey: string; // 自定义视频字幕模式切换快捷键
    videoSubtitleModeHotkeyAction: VideoSubtitleModeHotkeyAction; // 快捷键切换方式：双语↔原文或循环切换
    videoSubtitleFontSize: number; // 视频字幕字号百分比
    videoSubtitleOffsetMs: number; // 字幕时间偏移，正数延后、负数提前
    videoSubtitleAppearance: VideoSubtitleAppearance; // 视频字幕皮肤与布局参数
    videoSentenceLearningAppearance: VideoSentenceLearningAppearance; // 完整句学习面板外观，不含会话拖动位置
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
    compositeTranslationProviders: CompositeTranslationProvider[]; // 组合策略与普通成员的公开配置（不含统计或凭据）
    favoriteServices: string[]; // 用户标记的常用翻译服务，按标记顺序保存
    requestHeaderRules: RequestHeaderRule[]; // 用户指定精确域名的 Origin/Referer 移除名单，默认空
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
    toolbarClickAction: 'popup' | 'translate'; // 工具栏图标打开快捷面板或直接切换全文翻译
    translationSidepanelScope: TranslationSidepanelScope; // Chromium 原生侧边栏的显示范围
    popupQuickFeatureOrder: PopupQuickFeatureId[]; // 快捷功能卡片的显示顺序
    popupQuickFeatureVisibility: PopupQuickFeatureVisibility; // 单张快捷功能卡片的可见性
    privacyProtection: PrivacyProtectionPolicy; // 翻译出口的本地隐私防护策略
    privacyProtectionSecretTerms: string[]; // 自定义敏感词，存入凭据区，不广播给网页或写入普通备份
    useCache: boolean; // 是否使用缓存
    translationCacheMaxBytes: number; // 翻译缓存内容容量上限（字节）
    translationCacheMaxEntries: number; // 翻译缓存条数上限
    enableAIContext: boolean; // 是否为 AI 翻译附加网页上下文
    glossaryEnabled: boolean; // 是否在支持的翻译服务中使用本地术语库
    glossaryLibraries: GlossaryLibrary[]; // 有序术语库；首个匹配译名优先
    documentGlossaryIds: string[] | null; // 文档术语选择；null 跟随全局，空数组停用
    videoGlossaryIds: string[] | null; // 字幕术语选择；null 跟随全局，空数组停用
    enableAIMultiSegment: boolean; // 是否把相邻全文段落合并为一次 AI 翻译请求
    aiMultiSegmentMaxSegments: number; // 一批 AI 多段请求最多包含的可翻译文本片段数
    aiMultiSegmentMaxCharacters: number; // 一批 AI 多段请求的原文字符预算，超长单候选仍保持完整
    nativeBatchTranslationEnabled: Record<string, boolean>; // 原生多文本服务的合批开关，按服务独立保存且默认开启
    informationHighlight: InformationHighlightPreferences; // 信息高亮偏好；当前页面开启状态不持久化
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
    floatingBallDefaultMargin: number; // 悬浮球默认状态相对视口边缘的水平边距（px，可为负数）
    floatingBallPopoutMargin: number; // 悬停展开时悬浮球相对视口边缘的水平边距（px，可为负数）
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
    sectionTranslationRules: SectionTranslationRule[]; // 用户明确保存的网站/路径局部翻译规则
    disableSelectionTranslator: boolean; // 是否禁用划词翻译
    selectionAreaEnabled: boolean; // 是否启用圈选翻译
    selectionAreaHotkey: string; // 圈选翻译触发快捷键；'custom' 表示使用自定义组合键
    customSelectionAreaHotkey: string; // 自定义圈选翻译快捷键
    areaTranslationMode: 'standard' | 'ai'; // 圈选文字的标准翻译或 AI 上下文增强
    areaTranslationService: string; // 圈选独立翻译服务；空字符串跟随当前服务
    areaRecognitionMode: AreaRecognitionMode; // 圈选优先使用模型识图，模型不支持时回退本地 OCR
    areaVisionPrompt: string; // 模型识图时发送的图片文字提取指令
    modelVision: ModelVisionOverrides; // 按服务和精确模型保存的视觉能力显式覆盖
    imageTranslationMangaEnabled: boolean; // 是否在已适配阅读器显示漫画连续翻译入口
    imageTranslationMangaPromptEnabled: boolean; // 悬浮球关闭时显示独立漫画按钮；旧提示偏好沿用，不自动弹出面板
    imageTranslationMangaDownloadConfirmed: boolean; // 已阅读首次下载说明
    imageTranslationMangaSites: MangaSiteRule[]; // 用户添加的精确阅读页规则
    imageTranslationMangaCachePages: number; // 快速缓存 1 至 24 张，默认 12
    imageTranslationMangaPrefetchPages: number; // 当前页之后提前准备的图片数量，0 至 5
    imageTranslationHoverEnabled: boolean; // 是否显示图片悬浮入口
    imageTranslationContextMenuEnabled: boolean; // 是否显示图片右键入口
    disableImageTranslator: boolean; // 是否禁用图片翻译
    freeTranslationOrder: string[]; // 免费服务的启用列表与回退顺序
    freeTranslationBilibiliDefaultApplied: boolean; // B站默认开启的一次性迁移标记
    freeTranslationMode: FreeTranslationMode; // 默认按权重随机分配健康服务
    freeTranslationTimeoutMs: number; // 每路服务最长等待
    freeTranslationCooldownMs: number; // 失败服务的暂时跳过时间
    myMemoryEmail: string; // MyMemory 可选额度联系邮箱
    deeplApiPlan: DeepLApiPlan; // DeepL API Free / Pro 套餐
    deeplx: string; // DeepLX 服务地址
    selectionTranslatorMode: string; // 划词翻译显示模式: 'disabled' | 'bilingual' | 'translation-only'
    selectionTranslatorModeBeforeDisable: 'bilingual' | 'translation-only'; // 关闭前的显示偏好，重开恢复
    selectionTranslatorPresentation: 'simple' | 'card'; // 兼容旧备份字段，规范化后统一为 card
    selectionTranslatorTrigger: string; // 划词翻译互斥触发方式: 'direct' | 'icon' | 'dot' | 'hover' | 'contextMenu' | 'Control' | 'Alt' | 'Shift' | 'custom'
    selectionTranslatorHotkey: string; // 旧版快捷键字段；与 selectionTranslatorTrigger 中的快捷键选项保持镜像
    customSelectionTranslatorHotkey: string; // 自定义划词翻译快捷键
    selectionClickSelectEnabled: boolean; // 主动开启后才允许用快捷键启动单次两点选取
    selectionClickSelectHotkey: string; // 两点选取启动键，包含普通主键与修饰键
    selectionTranslatorDelay: number; // 选区稳定后显示划词翻译入口的延迟（毫秒）
    selectionTranslatorAutoDismiss: boolean; // 继续阅读或复制原文时收起，避免浮层长时间遮挡页面
    selectionTranslatorBidirectional: boolean; // 中英目标下为同语言选区提供反向划词入口
    selectionDictionarySource: WordDictionarySourceSetting; // auto 保留本地优先；指定后只查询所选词典
    declare selectionDictionaryRecipe: string; // 扩展主动选定的配方；空值继续使用内置词典
    declare selectionDictionaryWorkspace: DictionaryWorkspace; // 复用加密配置，词库正文另存本地索引
    selectionTtsVoices: string[]; // 划词朗读的 Edge TTS 音色回退顺序
    selectionTtsMode: LocalTtsMode; // 朗读在线/本地合成策略
    selectionTtsLocalVoice: LocalTtsVoiceId; // 本地 Kokoro 音色，auto 表示按语言选择
    selectionTtsRate: number; // 朗读默认语速（0.5-2.0 倍速）
    selectionTtsOnlineSources: SelectionTtsOnlineSourceId[]; // 在线朗读多源尝试与回退顺序
    selectionTtsOpenAiModel: SelectionTtsOpenAiModel; // OpenAI / 兼容 TTS 模型名
    selectionTtsOpenAiVoice: SelectionTtsOpenAiVoice; // OpenAI / 兼容 TTS 音色
    vocabularyBookEnabled: boolean; // 是否启用本地单词本 Beta
    vocabularyReencounterEnabled: boolean; // 阅读时轻量标记已收藏表达，独立于收藏入口
    declare personalCorrectionsEnabled: boolean; // 扩展个人校订须主动开启；userscript 不创建此不可用字段
    newApiUrl: string; // NewAPI地址
    maxConcurrentTranslations: number; // 最大并发翻译数量
    aiRequestTimeoutMs: number; // AI 翻译单次请求最长等待时间（毫秒）
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
    customInputBoxTranslationHotkey: string; // 自定义输入框翻译快捷键
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
        this.translationOnlyDomains = [];
        this.siteAdaptation = normalizeSiteAdaptationSettings(undefined);
        this.from = defaultOption.from;
        this.to = defaultOption.to;
        this.excludedLanguages = [];
        this.excludedTags = [];
        this.style = defaultOption.style;
        this.translationAppearance = normalizeTranslationAppearance(DEFAULT_TRANSLATION_APPEARANCE); // 默认沿用各样式自带配色
        this.browserDefaultTranslationFont = false;
        this.translationStyleProfiles = [];
        this.activeTranslationStyleProfileId = '';
        this.display = defaultOption.display;
        this.hotkey = defaultOption.hotkey;
        this.hoverShortcutBeforeDisable = defaultOption.hotkey;
        this.service = defaultOption.service;
        this.disabledTranslationServices = [...DEFAULT_DISABLED_AI_PLATFORM_SERVICES];
        this.aiPlatformDefaultRemovalMigrated = true;
        this.hoverTranslationService = '';
        this.selectionTranslationService = '';
        this.imageTranslationService = '';
        this.imageTranslationOcrEngine = 'paddle';
        this.imageTranslationInferenceBackend = 'auto';
        this.documentService = '';
        this.documentModel = Object.fromEntries(
            [...defaultModels].filter(([service]) => service !== LEGACY_CUSTOM_OPENAI_PROVIDER_ID),
        );
        this.documentCustomModel = {};
        this.videoTranslationEnabled = true; // 默认开启视频字幕翻译
        this.videoMeetingAutoEnabled = true;
        this.videoCourseAutoStart = normalizeVideoCourseAutoStart(undefined);
        this.videoPreferHumanSubtitles = true;
        this.videoService = ''; // 默认跟随网页服务
        this.videoLocalModel = 'small';
        this.videoTranscriptionProvider = 'browser';
        this.videoNativeAsrBaseUrl = DEFAULT_NATIVE_ASR_BASE_URL;
        this.videoSourceLanguage = 'auto';
        this.videoServiceDefaultMigrated = true;
        this.videoSubtitleVisible = true; // 默认显示视频译文
        this.videoSubtitleDisplayMode = 'bilingual'; // 默认双语显示
        this.videoSubtitleModeHotkeyEnabled = false; // 默认关闭，避免未主动选择时接管播放器页面的组合键
        this.videoSubtitleModeHotkey = DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY; // 默认 Alt+M，开启后才监听
        this.customVideoSubtitleModeHotkey = '';
        this.videoSubtitleModeHotkeyAction = DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY_ACTION; // 默认在双语和仅原文之间往返
        this.videoSubtitleFontSize = DEFAULT_VIDEO_SUBTITLE_FONT_SIZE; // 默认字幕字号
        this.videoSubtitleOffsetMs = 0;
        this.videoSubtitleAppearance = normalizeVideoSubtitleAppearance(DEFAULT_VIDEO_SUBTITLE_APPEARANCE);
        this.videoSentenceLearningAppearance = normalizeVideoSentenceLearningAppearance(DEFAULT_VIDEO_SENTENCE_LEARNING_APPEARANCE);
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
        this.compositeTranslationProviders = [];
        this.favoriteServices = [];
        this.customBody = {};
        this.customHeaders = {};
        this.requestHeaderRules = [];
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
        this.translationSidepanelScope = 'tab';
        this.toolbarClickAction = 'popup';
        this.popupQuickFeatureOrder = [...DEFAULT_POPUP_QUICK_FEATURE_ORDER];
        this.popupQuickFeatureVisibility = {...DEFAULT_POPUP_QUICK_FEATURE_VISIBILITY};
        this.privacyProtection = normalizePrivacyPolicy(undefined);
        this.privacyProtectionSecretTerms = [];
        this.useCache = true; // 默认开启缓存
        this.translationCacheMaxBytes = DEFAULT_TRANSLATION_CACHE_MAX_BYTES;
        this.translationCacheMaxEntries = DEFAULT_TRANSLATION_CACHE_MAX_ENTRIES;
        this.enableAIContext = false; // 默认关闭 AI 智能上下文，避免意外增加请求体和费用
        this.glossaryEnabled = false;
        this.glossaryLibraries = [];
        this.documentGlossaryIds = null;
        this.videoGlossaryIds = null;
        this.enableAIMultiSegment = false; // 默认逐段请求，由用户按需开启 AI 多段翻译
        this.aiMultiSegmentMaxSegments = DEFAULT_AI_MULTI_SEGMENT_MAX_SEGMENTS;
        this.aiMultiSegmentMaxCharacters = DEFAULT_AI_MULTI_SEGMENT_MAX_CHARACTERS;
        this.nativeBatchTranslationEnabled = {...DEFAULT_NATIVE_BATCH_TRANSLATION_ENABLED};
        this.informationHighlight = {...DEFAULT_INFORMATION_HIGHLIGHT_PREFERENCES};
        this.bilingualSentenceHighlightEnabled = true; // 默认开启双语逐句高亮，便于对照阅读
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
        this.disableFloatingBall = true; // 默认关闭全文翻译悬浮球，由用户按需开启
        this.floatingBallPosition = 'right'; // 默认在右侧
        this.floatingBallVerticalPosition = null; // 未拖动时保持视口纵向居中
        this.floatingBallHotkey = 'Alt+T'; // 默认快捷键为 Alt+T
        this.customFloatingBallHotkey = ''; // 自定义快捷键为空
        this.floatingBallToolsDisplay = 'hover'; // 开启后默认悬停展开，移开后缩回页面边缘
        this.floatingBallHoverDelay = DEFAULT_FLOATING_BALL_HOVER_DELAY; // 默认立即展开，保持既有手感
        this.floatingBallClickAction = 'translate'; // 默认点击悬浮球即切换全文翻译
        this.floatingBallCompact = false; // 默认使用标准尺寸
        this.floatingBallSettingsEntryVisible = true; // 默认保留设置入口
        this.floatingBallCollapsedOpacity = DEFAULT_FLOATING_BALL_COLLAPSED_OPACITY; // 默认保持既有半透明收起效果
        this.floatingBallDefaultMargin = DEFAULT_FLOATING_BALL_DEFAULT_MARGIN; // 默认按钮贴近视口边缘，减少对正文的遮挡
        this.floatingBallPopoutMargin = DEFAULT_FLOATING_BALL_POPOUT_MARGIN; // 悬停展开时向内留出操作间距
        this.floatingBallDisabledDomains = []; // 开启后默认不额外排除网站
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
        this.sectionTranslationRules = []; // 不自动记住网页区域，只有用户明确保存才建立规则
        this.disableSelectionTranslator = true; // 默认关闭划词翻译
        this.selectionAreaEnabled = true; // 默认开启，按快捷键圈选后才截图翻译
        this.selectionAreaHotkey = DEFAULT_AREA_TRANSLATION_HOTKEY; // 默认 Shift+Z，可改为其他预设或自定义组合键
        this.customSelectionAreaHotkey = ''; // 自定义圈选快捷键为空
        this.areaTranslationMode = 'standard';
        this.areaTranslationService = '';
        this.areaRecognitionMode = 'prefer-vision';
        this.areaVisionPrompt = DEFAULT_AREA_VISION_PROMPT;
        this.modelVision = {};
        this.imageTranslationMangaEnabled = true;
        this.imageTranslationMangaPromptEnabled = true;
        this.imageTranslationMangaDownloadConfirmed = false;
        this.imageTranslationMangaSites = [];
        this.imageTranslationMangaPrefetchPages = 3;
        this.imageTranslationMangaCachePages = 12;
        this.imageTranslationHoverEnabled = true;
        this.imageTranslationContextMenuEnabled = true;
        this.disableImageTranslator = true; // 默认关闭图片翻译，由用户按需开启
        this.freeTranslationOrder = [...DEFAULT_FREE_TRANSLATION_ORDER];
        this.freeTranslationBilibiliDefaultApplied = true;
        this.freeTranslationMode = DEFAULT_FREE_TRANSLATION_MODE;
        this.freeTranslationTimeoutMs = DEFAULT_FREE_TRANSLATION_TIMEOUT_MS;
        this.freeTranslationCooldownMs = DEFAULT_FREE_TRANSLATION_COOLDOWN_MS;
        this.myMemoryEmail = '';
        this.deeplApiPlan = DEFAULT_DEEPL_API_PLAN; // 兼容既有 DeepL API Free 默认端点
        this.deeplx = defaultOption.deeplx; // DeepLX 默认服务地址
        this.selectionTranslatorMode = 'disabled'; // 默认关闭划词翻译
        this.selectionTranslatorModeBeforeDisable = 'bilingual';
        this.selectionTranslatorPresentation = 'card';
        this.selectionTranslatorTrigger = 'icon'; // 默认显示可发现的操作图标
        this.selectionTranslatorHotkey = 'none'; // 默认不增加额外快捷键，保持原有划词行为
        this.customSelectionTranslatorHotkey = ''; // 自定义划词翻译快捷键为空
        this.selectionClickSelectEnabled = false;
        this.selectionClickSelectHotkey = DEFAULT_CLICK_SELECTION_HOTKEY;
        this.selectionTranslatorDelay = DEFAULT_SELECTION_TRANSLATOR_DELAY;
        this.selectionTranslatorAutoDismiss = true;
        this.selectionTranslatorBidirectional = false; // 保留默认的同语言跳过，用户可按需开启双向入口
        this.selectionDictionarySource = 'auto';
        if (import.meta.env?.BROWSER !== 'userscript') {
            this.selectionDictionaryRecipe = '';
            this.selectionDictionaryWorkspace = defaultDictionaryWorkspace();
        }
        this.selectionTtsVoices = []; // 默认按当前语言使用内置音色回退顺序
        this.selectionTtsMode = DEFAULT_LOCAL_TTS_MODE;
        this.selectionTtsLocalVoice = DEFAULT_LOCAL_TTS_VOICE;
        this.selectionTtsRate = DEFAULT_SELECTION_TTS_RATE;
        this.selectionTtsOnlineSources = [...DEFAULT_SELECTION_TTS_ONLINE_SOURCES];
        this.selectionTtsOpenAiModel = DEFAULT_SELECTION_TTS_OPENAI_MODEL;
        this.selectionTtsOpenAiVoice = DEFAULT_SELECTION_TTS_OPENAI_VOICE;
        this.vocabularyBookEnabled = false; // Beta 默认关闭，由用户在单词本页面主动开启
        this.vocabularyReencounterEnabled = false; // 主动开启后才在网页中匹配收藏
        if (import.meta.env?.BROWSER !== 'userscript') this.personalCorrectionsEnabled = false;
        this.newApiUrl = DEFAULT_NEW_API_URL; // NewAPI 默认地址
        this.maxConcurrentTranslations = DEFAULT_MAX_CONCURRENT_TRANSLATIONS; // 默认最大并发数为10
        this.aiRequestTimeoutMs = DEFAULT_AI_REQUEST_TIMEOUT_MS;
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
        this.customInputBoxTranslationHotkey = ''; // 自定义输入框翻译快捷键为空
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
