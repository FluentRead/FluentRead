/**
 * @file src/core/config/model/normalizeVideoAndMedia.ts
 *
 * 文件职责：规范化视频字幕翻译、语音识别引擎、视频快捷键外观以及图片与漫画连续翻译等媒体域配置字段。
 * 主要内容：提供 normalizeVideoAndMediaConfig，完成旧 Beta 默认视频服务一次性迁移、字幕显示模式/偏移/字体与完整句学习外观清洗，以及图片 OCR 引擎、推理后端、漫画站点与预取缓存页数校验。
 * 模块边界：仅由 normalizeConfig.ts 在供应商配置归一后调用，属于无副作用的纯配置归一子模块，不触碰媒体 DOM 或后台消息通道。
 */

import {services} from '../catalog/services';
import {normalizeMangaCachePages, normalizeMangaPrefetchPages, normalizeMangaSiteRules} from '../mangaNormalization';
import {DEFAULT_NATIVE_ASR_BASE_URL, normalizeNativeAsrBaseUrl} from '../nativeAsr';
import {normalizeVideoCourseAutoStart} from '../videoCourse';
import {normalizeVideoSentenceLearningAppearance} from '../videoSentenceLearningAppearance';
import {normalizeVideoSubtitleAppearance} from '../videoSubtitleAppearance';
import {
    DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY,
    normalizeCustomVideoSubtitleModeHotkey,
    normalizeVideoSubtitleModeHotkey,
    normalizeVideoSubtitleModeHotkeyAction,
} from '../videoSubtitleShortcut';
import {hasOwn} from './clone';
import type {Config} from './configClass';
import {
    normalizeVideoSubtitleFontSize,
    normalizeVideoSubtitleOffsetMs,
    VIDEO_SOURCE_LANGUAGE_OPTIONS,
} from './interactionDefaults';
import {isSupportedTranslationService} from './providerNormalization';

export function normalizeVideoAndMediaConfig(normalized: Config, source: Partial<Config>): void {
    if (typeof normalized.videoTranslationEnabled !== 'boolean') {
        normalized.videoTranslationEnabled = true;
    }
    normalized.videoMeetingAutoEnabled = typeof source.videoMeetingAutoEnabled === 'boolean' ? source.videoMeetingAutoEnabled : true;
    normalized.videoCourseAutoStart = normalizeVideoCourseAutoStart(source.videoCourseAutoStart);
    normalized.videoPreferHumanSubtitles = typeof source.videoPreferHumanSubtitles === 'boolean' ? source.videoPreferHumanSubtitles : true;
    // 缺失或非法选择统一使用质量默认；明确保存的 Tiny/Base/Small 继续保留。
    if (normalized.videoLocalModel !== 'tiny' && normalized.videoLocalModel !== 'base' && normalized.videoLocalModel !== 'small') {
        normalized.videoLocalModel = 'small';
    }
    normalized.videoTranscriptionProvider = source.videoTranscriptionProvider === 'native-qwen' ? 'native-qwen' : 'browser';
    normalized.videoNativeAsrBaseUrl = source.videoNativeAsrBaseUrl === undefined
        ? DEFAULT_NATIVE_ASR_BASE_URL
        : normalizeNativeAsrBaseUrl(source.videoNativeAsrBaseUrl);
    if (!VIDEO_SOURCE_LANGUAGE_OPTIONS.some((item) => item.value === normalized.videoSourceLanguage)) {
        normalized.videoSourceLanguage = 'auto';
    }
    // 早期 Beta 版本曾把 DeepLX 写成默认值。只对没有迁移标记的旧配置
    // 执行一次迁移，避免覆盖用户在新版本中主动选择的 DeepLX。
    const shouldMigrateLegacyVideoDefault = source.videoService === services.deeplx
        && source.videoServiceDefaultMigrated !== true;
    if (shouldMigrateLegacyVideoDefault
        || !isSupportedTranslationService(normalized.videoService, normalized.customOpenAIProviders, normalized.compositeTranslationProviders)) {
        normalized.videoService = '';
    }
    normalized.videoServiceDefaultMigrated = true;
    if (typeof normalized.videoSubtitleVisible !== 'boolean') {
        normalized.videoSubtitleVisible = true;
    }
    if (!['bilingual', 'translation-only', 'original-only'].includes(normalized.videoSubtitleDisplayMode)) {
        normalized.videoSubtitleDisplayMode = 'bilingual';
    }
    if (typeof normalized.videoSubtitleModeHotkeyEnabled !== 'boolean') {
        normalized.videoSubtitleModeHotkeyEnabled = false;
    }
    normalized.customVideoSubtitleModeHotkey = normalizeCustomVideoSubtitleModeHotkey(source.customVideoSubtitleModeHotkey);
    normalized.videoSubtitleModeHotkey = normalizeVideoSubtitleModeHotkey(source.videoSubtitleModeHotkey);
    // 选择自定义却没有可用组合键时回到预设默认值，避免开启状态没有可用快捷键。
    if (normalized.videoSubtitleModeHotkey === 'custom' && !normalized.customVideoSubtitleModeHotkey) {
        normalized.videoSubtitleModeHotkey = DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY;
    }
    normalized.videoSubtitleModeHotkeyAction = normalizeVideoSubtitleModeHotkeyAction(source.videoSubtitleModeHotkeyAction);
    normalized.videoSubtitleFontSize = normalizeVideoSubtitleFontSize(normalized.videoSubtitleFontSize);
    normalized.videoSubtitleOffsetMs = normalizeVideoSubtitleOffsetMs(normalized.videoSubtitleOffsetMs);
    const hasVideoSubtitleAppearance = hasOwn(source as object, 'videoSubtitleAppearance');
    normalized.videoSubtitleAppearance = normalizeVideoSubtitleAppearance(
        hasVideoSubtitleAppearance
            ? source.videoSubtitleAppearance
            : {fontScale: source.videoSubtitleFontSize},
    );
    normalized.videoSentenceLearningAppearance = normalizeVideoSentenceLearningAppearance(source.videoSentenceLearningAppearance);

    if (typeof normalized.disableImageTranslator !== 'boolean') {
        normalized.disableImageTranslator = true;
    }
    normalized.imageTranslationMangaEnabled = typeof normalized.imageTranslationMangaEnabled === 'boolean' ? normalized.imageTranslationMangaEnabled : true;
    // 新安装、缺失或非法值使用 PaddleOCR；保留已保存的 Tesseract 选择。
    normalized.imageTranslationOcrEngine = normalized.imageTranslationOcrEngine === 'tesseract' ? 'tesseract' : 'paddle';
    normalized.imageTranslationInferenceBackend = normalized.imageTranslationInferenceBackend === 'cpu' ? 'cpu' : 'auto';
    normalized.imageTranslationMangaPromptEnabled = typeof normalized.imageTranslationMangaPromptEnabled === 'boolean' ? normalized.imageTranslationMangaPromptEnabled : true;
    normalized.imageTranslationMangaDownloadConfirmed = normalized.imageTranslationMangaDownloadConfirmed === true;
    normalized.imageTranslationMangaSites = normalizeMangaSiteRules(normalized.imageTranslationMangaSites);
    normalized.imageTranslationMangaPrefetchPages = normalizeMangaPrefetchPages(normalized.imageTranslationMangaPrefetchPages);
    normalized.imageTranslationMangaCachePages = normalizeMangaCachePages(normalized.imageTranslationMangaCachePages);
    normalized.imageTranslationHoverEnabled = typeof normalized.imageTranslationHoverEnabled === 'boolean' ? normalized.imageTranslationHoverEnabled : true;
    normalized.imageTranslationContextMenuEnabled = typeof normalized.imageTranslationContextMenuEnabled === 'boolean' ? normalized.imageTranslationContextMenuEnabled : true;
}
