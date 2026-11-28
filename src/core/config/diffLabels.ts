/**
 * @file src/core/config/diffLabels.ts
 *
 * 文件职责：集中维护配置差异预览使用的枚举值中文标签映射表、排除字段集合与服务显示名解析函数。
 * 主要内容：聚合语言、翻译服务、译文样式、主题、界面皮肤与字体、快捷键、视频字幕、悬浮球及译文外观属性等只读 Map，提供 labelsFor 与 serviceName 工具供差异格式化层复用。
 * 模块边界：仅包含无副作用的静态标签表和纯查找辅助，不执行敏感内容脱敏、字段对比或差异分组计算。
 */

import {options} from './catalog';
import {isCustomOpenAIProviderId} from './customOpenAI';
import {FREE_TRANSLATION_PROVIDERS} from './freeTranslation';
import {
    interfaceSkinOptions,
    popupModuleOptions,
    popupQuickFeatureOptions,
} from './interfaceAppearance';
import {LOCAL_TTS_MODE_OPTIONS} from './localTts';
import {translationLoadingStyleOptions} from './translationLoadingStyle';

export type DiffLabelOption = {value: unknown; label: string};

export const EXCLUDED_DIFF_FIELDS = new Set([
    'count',
    'persistCredentials',
    'videoServiceDefaultMigrated',
    'freeTranslationBilibiliDefaultApplied',
    'aiPlatformDefaultRemovalMigrated',
    'uiLanguageSetupCompleted',
    // 关闭前偏好随快照保存，但不作为独立用户操作重复展示。
    'hoverShortcutBeforeDisable',
    'selectionTranslatorModeBeforeDisable',
    '__fluentConfigRevision',
]);

export function labelsFor(...optionLists: ReadonlyArray<ReadonlyArray<DiffLabelOption>>): Map<unknown, string> {
    return new Map(optionLists.flatMap((items) => items.map((item) => [item.value, item.label] as const)));
}

export const LANGUAGE_LABELS = labelsFor(options.to, options.inputBoxTranslationTarget, options.from);
export const SERVICE_LABELS = labelsFor(options.services, FREE_TRANSLATION_PROVIDERS.map(provider => ({value: provider.id, label: provider.label})));
export const STYLE_LABELS = labelsFor(options.styles);
export const THEME_LABELS = labelsFor(options.theme);
export const UI_LANGUAGE_LABELS = new Map<unknown, string>([
    ['zh-CN', '中文'],
    ['en-US', 'English'],
    ['ja-JP', '日本語'],
    ['ko-KR', '한국어'],
    ['fr-FR', 'Français'],
    ['ru-RU', 'Русский'],
    ['es-ES', 'Español'],
]);
export const INTERFACE_SKIN_LABELS = labelsFor(interfaceSkinOptions);
export const SIDEPANEL_SCOPE_LABELS = new Map<unknown, string>([['tab', '仅当前标签页'], ['window', '整个窗口']]);
export const INTERFACE_FONT_LABELS = new Map<unknown, string>([
    ['inter', 'Inter · 推荐'],
    ['system', '系统字体'],
    ['noto-sans-sc', 'Noto Sans SC · 中文'],
    ['roboto', 'Roboto · 简洁'],
    ['source-sans-3', 'Source Sans 3 · 易读'],
    ['ibm-plex-sans', 'IBM Plex Sans · 理性'],
    ['manrope', 'Manrope · 几何'],
    ['nunito-sans', 'Nunito Sans · 柔和'],
    ['lxgw-wenkai', '霞鹜文楷 · 手写'],
    ['noto-serif-sc', 'Noto Serif SC · 书卷'],
]);
export const TRANSLATION_LOADING_STYLE_LABELS = labelsFor(translationLoadingStyleOptions);
export const TRANSLATION_SCOPE_LABELS = new Map<unknown, string>([['content', '关闭'], ['all', '开启']]);
export const POPUP_MODULE_LABELS = new Map<string, string>(popupModuleOptions.map((item) => [item.id, item.label]));
export const POPUP_QUICK_FEATURE_LABELS = new Map<string, string>(
    popupQuickFeatureOptions.map((item) => [item.id, item.label]),
);
export const HOVER_TRIGGER_LABELS = labelsFor(options.keys);
export const SELECTION_TRIGGER_LABELS = labelsFor(options.selectionTranslatorTriggers);
export const FLOATING_HOTKEY_LABELS = labelsFor(options.floatingBallHotkeys);
export const INPUT_TRIGGER_LABELS = labelsFor(options.inputBoxTranslationTrigger);
export const INPUT_OUTPUT_LABELS = new Map<unknown, string>([
    ['replace', '替换原文'], ['append', '原文在前，译文在后'], ['prepend', '译文在前，原文在后'],
]);
export const BILLING_PLAN_LABELS = labelsFor(options.minimaxBillingPlan, options.mimoBillingPlan);
export const DEEPL_API_PLAN_LABELS = new Map<unknown, string>([
    ['free', 'API Free（免费）'],
    ['pro', 'API Pro（付费）'],
]);
export const REGION_LABELS = labelsFor(options.minimaxRegion, options.mimoRegion);
export const DEEPSEEK_API_LABELS = labelsFor(options.deepseekApiType);
export const DEEPSEEK_THINKING_LABELS = labelsFor(options.deepseekThinkingMode);
export const PARAGRAPH_COPY_CONTENT_LABELS = new Map<unknown, string>([
    ['auto', '跟随页面显示'],
    ['original', '原文'],
    ['translation', '译文'],
    ['bilingual', '原文和译文'],
]);
export const DISPLAY_LABELS = new Map<unknown, string>([
    [0, '仅译文模式'],
    [1, '双语对照模式'],
]);
export const FULL_PAGE_MODE_LABELS = new Map<unknown, string>([
    ['viewport', '按阅读进度'],
    ['all', '立即翻译到网页底部'],
]);
export const SELECTION_MODE_LABELS = new Map<unknown, string>([
    ['disabled', '关闭'],
    ['bilingual', '双语显示'],
    ['translation-only', '只显示译文'],
]);
export const LOCAL_TTS_MODE_LABELS = labelsFor(LOCAL_TTS_MODE_OPTIONS);
export const VIDEO_DISPLAY_MODE_LABELS = new Map<unknown, string>([
    ['bilingual', '双语显示'],
    ['translation-only', '只显示译文'],
    ['original-only', '只显示原文'],
]);
export const VIDEO_SUBTITLE_MODE_HOTKEY_ACTION_LABELS = new Map<unknown, string>([
    ['bilingual-original', '双语 ↔ 原文'],
    ['cycle-display', '双语 → 译文 → 原文'],
    ['cycle-all', '双语 → 译文 → 原文 → 关闭'],
]);
export const SIDE_LABELS = new Map<unknown, string>([
    ['left', '左侧'],
    ['right', '右侧'],
]);
export const FLOATING_BALL_TOOLS_DISPLAY_LABELS = new Map<unknown, string>([
    ['hover', '悬停时显示'],
    ['always', '始终显示'],
    ['hidden', '不显示'],
]);
export const FLOATING_BALL_CLICK_ACTION_LABELS = new Map<unknown, string>([
    ['translate', '翻译/显示原文'],
    ['settings', '打开设置页'],
    ['none', '仅拖动'],
]);
export const TRANSLATION_APPEARANCE_FIELD_LABELS = new Map<string, string>([
    ['textColor', '译文颜色'],
    ['backgroundColor', '译文背景色'],
    ['lineColor', '线条颜色'],
    ['fillColor', '标记底色'],
    ['fontScale', '译文字号'],
    ['fontWeight', '译文字重'],
    ['fontFamily', '译文字体'],
    ['opacity', '译文不透明度'],
    ['customCss', 'CSS'],
]);
// 颜色留空与 default 都表示沿用样式自带外观；字号和不透明度都是百分比。
export const TRANSLATION_APPEARANCE_VALUE_LABELS = new Map<unknown, string>([
    ['', '默认'],
    ['default', '默认'],
    ['normal', '常规'],
    ['semibold', '中粗'],
    ['bold', '加粗'],
    ['sans', '无衬线'],
    ['serif', '衬线'],
    ['mono', '等宽'],
]);

export function serviceName(key: string): string {
    if (SERVICE_LABELS.has(key)) return SERVICE_LABELS.get(key)!;
    if (isCustomOpenAIProviderId(key)) {
        return `自定义服务 ${key.slice('custom:'.length)}`;
    }
    return key;
}
