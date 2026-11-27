/**
 * @file src/core/config/model.ts
 *
 * 文件职责：作为 FluentRead 核心配置模型的纯重导出门面，保持既有公开符号 100% 兼容并让消费者按符号精确依赖子模块。
 * 主要内容：转发 scheduling、pageTranslation、aiRequestTimeout 以及 ./model/types、./model/interactionDefaults、./model/modelMigration、./model/configClass 与 ./model/normalizeConfig 的全部类型、常量、Config 类、migrateModelIdentifier 与 normalizeConfig。
 * 模块边界：仅包含纯 re-export 语句，不持有运行时语句；配置类初始化、交互默认值、模型迁移、服务子域归一化和顶层编排分别由 src/core/config/model/ 子模块承担。
 */

export * from './scheduling';
export * from './pageTranslation';
export * from './aiRequestTimeout';
export type {
    DeepSeekApiType,
    DeepSeekThinkingMode,
    VideoSubtitleDisplayMode,
    TranslationSidepanelScope,
    VideoLocalTranscriptionModel,
    VideoTranscriptionProvider,
    FullPageTranslationMode,
    FloatingBallToolsDisplay,
    FloatingBallClickAction,
} from './model/types';
export {
    DEFAULT_VIDEO_SUBTITLE_FONT_SIZE,
    DEFAULT_NEW_API_URL,
    VIDEO_SOURCE_LANGUAGE_OPTIONS,
    DEFAULT_MOUSE_HOVER_TRANSLATION_DELAY,
    MOUSE_HOVER_TRANSLATION_DELAY_MIN,
    MOUSE_HOVER_TRANSLATION_DELAY_MAX,
    MOUSE_HOVER_TRANSLATION_DELAY_STEP,
    DEFAULT_SELECTION_TRANSLATOR_DELAY,
    SELECTION_TRANSLATOR_DELAY_MIN,
    SELECTION_TRANSLATOR_DELAY_MAX,
    SELECTION_TRANSLATOR_DELAY_STEP,
    normalizeVideoSubtitleFontSize,
    normalizeVideoSubtitleOffsetMs,
    normalizeMouseHoverTranslationDelay,
    FLOATING_BALL_TOOLS_DISPLAY_VALUES,
    FLOATING_BALL_CLICK_ACTION_VALUES,
    DEFAULT_FLOATING_BALL_HOVER_DELAY,
    FLOATING_BALL_HOVER_DELAY_MIN,
    FLOATING_BALL_HOVER_DELAY_MAX,
    FLOATING_BALL_HOVER_DELAY_STEP,
    DEFAULT_FLOATING_BALL_COLLAPSED_OPACITY,
    FLOATING_BALL_COLLAPSED_OPACITY_MIN,
    FLOATING_BALL_COLLAPSED_OPACITY_MAX,
    FLOATING_BALL_COLLAPSED_OPACITY_STEP,
    DEFAULT_FLOATING_BALL_DEFAULT_MARGIN,
    DEFAULT_FLOATING_BALL_POPOUT_MARGIN,
    FLOATING_BALL_MARGIN_MIN,
    FLOATING_BALL_MARGIN_MAX,
    FLOATING_BALL_MARGIN_STEP,
    normalizeFloatingBallMargin,
    normalizeFloatingBallHoverDelay,
    normalizeFloatingBallCollapsedOpacity,
    normalizeFloatingBallVerticalPosition,
    normalizeFloatingBallToolsDisplay,
    normalizeFloatingBallClickAction,
    normalizeSelectionTranslatorDelay,
} from './model/interactionDefaults';
export {migrateModelIdentifier} from './model/modelMigration';
export {Config} from './model/configClass';
export {normalizeConfig} from './model/normalizeConfig';
