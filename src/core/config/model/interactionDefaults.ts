/**
 * @file src/core/config/model/interactionDefaults.ts
 *
 * 文件职责：定义悬浮球、鼠标悬停、划词延迟与视频字幕字号/偏移的默认常量、合法步长范围及纯归一化函数。
 * 主要内容：导出 DEFAULT_NEW_API_URL、VIDEO_SOURCE_LANGUAGE_OPTIONS、悬浮球与延迟范围常量，以及 normalizeVideoSubtitleFontSize、normalizeVideoSubtitleOffsetMs、normalizeMouseHoverTranslationDelay、normalizeFloatingBallMargin、normalizeFloatingBallHoverDelay、normalizeFloatingBallCollapsedOpacity、normalizeFloatingBallVerticalPosition、normalizeFloatingBallToolsDisplay、normalizeFloatingBallClickAction 与 normalizeSelectionTranslatorDelay。
 * 模块边界：本文件只包含零外部运行时依赖的纯数值与枚举约束函数，让设置表单组件与运行时无需经由 config/model 拉入整棵配置目录与迁移链路。
 */

import type {FloatingBallClickAction, FloatingBallToolsDisplay} from './types';

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

export const FLOATING_BALL_TOOLS_DISPLAY_VALUES: readonly FloatingBallToolsDisplay[] = ['hover', 'always', 'hidden'];
export const FLOATING_BALL_CLICK_ACTION_VALUES: readonly FloatingBallClickAction[] = ['translate', 'settings', 'none'];
export const DEFAULT_FLOATING_BALL_HOVER_DELAY = 0;
export const FLOATING_BALL_HOVER_DELAY_MIN = 0;
export const FLOATING_BALL_HOVER_DELAY_MAX = 2000;
export const FLOATING_BALL_HOVER_DELAY_STEP = 50;
export const DEFAULT_FLOATING_BALL_COLLAPSED_OPACITY = 36;
export const FLOATING_BALL_COLLAPSED_OPACITY_MIN = 20;
export const FLOATING_BALL_COLLAPSED_OPACITY_MAX = 100;
export const FLOATING_BALL_COLLAPSED_OPACITY_STEP = 4;

export const DEFAULT_FLOATING_BALL_DEFAULT_MARGIN = 0;
export const DEFAULT_FLOATING_BALL_POPOUT_MARGIN = 20;
export const FLOATING_BALL_MARGIN_MIN = -200;
export const FLOATING_BALL_MARGIN_MAX = 200;
export const FLOATING_BALL_MARGIN_STEP = 1;

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

/** 悬浮球横向边距允许负数，使按钮可以贴到视口边缘或部分移出视口。 */
export function normalizeFloatingBallMargin(
    value: unknown,
    fallback: number = DEFAULT_FLOATING_BALL_DEFAULT_MARGIN,
): number {
    return clampStepped(
        value,
        fallback,
        FLOATING_BALL_MARGIN_MIN,
        FLOATING_BALL_MARGIN_MAX,
        FLOATING_BALL_MARGIN_STEP,
    );
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
