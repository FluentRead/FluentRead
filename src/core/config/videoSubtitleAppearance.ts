/**
 * @file src/core/config/videoSubtitleAppearance.ts
 * 文件职责：定义视频字幕外观 registry、默认值、配置归一化和播放器 CSS 变量契约。
 * 主要内容：提供可扩展字幕皮肤、字号/位置/背景/行距/宽度等有界参数，并把配置转换为隔离 UI 可消费的 CSS 变量。
 * 模块边界：只处理纯配置数据，不读取播放器、DOM 或浏览器存储；持久化由 Config/store 负责，实际挂载由 content UI 负责。
 */

export const VIDEO_SUBTITLE_SKINS = [
    {id: 'classic', label: '经典', description: '保留当前黑色半透明字幕外观', background: '12, 15, 22', shadow: '0 2px 6px rgba(0,0,0,.24), 0 0 0 1px rgba(0,0,0,.08)', fontFamily: 'Arial, sans-serif', backdropFilter: 'blur(2px)', border: 'rgba(255,255,255,.1)', textColor: '#ffffff', translationColor: '#ffe45c', backgroundOpacity: 56, textShadow: '0 1px 2px rgba(0,0,0,.72)', textStroke: '1px #000'},
    {id: 'clean', label: '清爽', description: '更轻的背景和柔和边缘', background: '255, 255, 255', shadow: '0 2px 12px rgba(0,0,0,.16)', fontFamily: 'Arial, sans-serif', backdropFilter: 'none', border: 'rgba(0,0,0,.08)', textColor: '#1f2937', translationColor: '#0f766e', backgroundOpacity: 88, textShadow: 'none', textStroke: '0'},
    {id: 'glass', label: '玻璃', description: '半透明毛玻璃效果', background: '20, 28, 40', shadow: '0 4px 18px rgba(0,0,0,.3)', fontFamily: 'Arial, sans-serif', backdropFilter: 'blur(10px)', border: 'rgba(255,255,255,.18)', textColor: '#ffffff', translationColor: '#b9f6e8', backgroundOpacity: 62, textShadow: '0 1px 3px rgba(0,0,0,.6)', textStroke: '1px rgba(0,0,0,.4)'},
    {id: 'contrast', label: '高对比', description: '适合复杂画面和户外视频', background: '0, 0, 0', shadow: '0 2px 0 rgba(0,0,0,.9)', fontFamily: 'Arial, sans-serif', backdropFilter: 'none', border: '#fff', textColor: '#ffffff', translationColor: '#ffffff', backgroundOpacity: 92, textShadow: '0 2px 3px #000', textStroke: '2px #000'},
    {id: 'paper', label: '纸张', description: '温暖的阅读感', background: '43, 35, 26', shadow: '0 2px 12px rgba(0,0,0,.3)', fontFamily: 'Georgia, serif', backdropFilter: 'none', border: 'rgba(255,225,190,.2)', textColor: '#fff7ed', translationColor: '#fed7aa', backgroundOpacity: 82, textShadow: '0 1px 2px rgba(35,20,10,.65)', textStroke: '1px rgba(35,20,10,.6)'},
    {id: 'terminal', label: '终端', description: '紧凑的等宽字风格', background: '4, 20, 16', shadow: '0 2px 14px rgba(0,0,0,.42)', fontFamily: 'ui-monospace, monospace', backdropFilter: 'none', border: 'rgba(94,234,212,.25)', textColor: '#d1fae5', translationColor: '#5eead4', backgroundOpacity: 88, textShadow: '0 0 5px rgba(94,234,212,.4)', textStroke: '0'},
    {id: 'neon', label: '霓虹', description: '更鲜明的科技感配色', background: '16, 8, 38', shadow: '0 2px 16px rgba(90,48,180,.5)', fontFamily: 'Arial, sans-serif', backdropFilter: 'blur(5px)', border: 'rgba(217,180,255,.35)', textColor: '#f5f3ff', translationColor: '#f0abfc', backgroundOpacity: 72, textShadow: '0 0 8px rgba(240,171,252,.65)', textStroke: '0'},
    {id: 'minimal', label: '极简', description: '低干扰透明字幕', background: '0, 0, 0', shadow: '0 1px 6px rgba(0,0,0,.5)', fontFamily: 'Arial, sans-serif', backdropFilter: 'none', border: 'transparent', textColor: '#ffffff', translationColor: '#ffffff', backgroundOpacity: 0, textShadow: '0 1px 3px rgba(0,0,0,.9)', textStroke: '1px #000'},
] as const;

export type VideoSubtitleSkinId = typeof VIDEO_SUBTITLE_SKINS[number]['id'];
export type VideoSubtitlePosition = 'bottom' | 'center' | 'top';
export const VIDEO_SUBTITLE_FONT_SCALE_OPTIONS = [80, 90, 100, 110, 120, 130, 140, 150, 160] as const;

export interface VideoSubtitleAppearance {
    skin: VideoSubtitleSkinId;
    textColor: string;
    translationColor: string;
    position: VideoSubtitlePosition;
    bottomOffset: number;
    autoBottom: boolean;
    backgroundOpacity: number;
    lineSpacing: number;
    maxWidth: number;
    fontScale: number;
}

export const DEFAULT_VIDEO_SUBTITLE_APPEARANCE: VideoSubtitleAppearance = {
    skin: 'classic',
    textColor: '#ffffff',
    translationColor: '#ffe45c',
    position: 'bottom',
    bottomOffset: 10,
    autoBottom: true,
    backgroundOpacity: 56,
    lineSpacing: 1.28,
    maxWidth: 96,
    fontScale: 100,
};

function normalizeNumber(value: unknown, fallback: number, min: number, max: number, step: number): number {
    const number = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
            ? Number(value)
            : Number.NaN;
    if (!Number.isFinite(number)) return fallback;
    const rounded = Math.round(number / step) * step;
    return Math.min(max, Math.max(min, Number(rounded.toFixed(2))));
}

function normalizeColor(value: unknown, fallback: string): string {
    return typeof value === 'string' && /^#[\da-f]{6}$/iu.test(value.trim())
        ? value.trim().toLowerCase()
        : fallback;
}

export function normalizeVideoSubtitleAppearance(value: unknown): VideoSubtitleAppearance {
    const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const skin = VIDEO_SUBTITLE_SKINS.some((item) => item.id === source.skin)
        ? source.skin as VideoSubtitleSkinId
        : DEFAULT_VIDEO_SUBTITLE_APPEARANCE.skin;
    const skinPreset = VIDEO_SUBTITLE_SKINS.find((item) => item.id === skin)!;
    const position: VideoSubtitlePosition = source.position === 'top' || source.position === 'center'
        ? source.position
        : 'bottom';
    const bottomOffset = normalizeNumber(source.bottomOffset, DEFAULT_VIDEO_SUBTITLE_APPEARANCE.bottomOffset, 0, 25, 1);
    return {
        skin,
        textColor: normalizeColor(source.textColor, skinPreset.textColor),
        translationColor: normalizeColor(source.translationColor, skinPreset.translationColor),
        position,
        bottomOffset,
        // 旧默认偏移升级为自动贴底，已调整的偏移及显式手动选择继续保留。
        autoBottom: typeof source.autoBottom === 'boolean' ? source.autoBottom : bottomOffset === 10,
        backgroundOpacity: normalizeNumber(source.backgroundOpacity, skinPreset.backgroundOpacity, 0, 95, 1),
        lineSpacing: normalizeNumber(source.lineSpacing, DEFAULT_VIDEO_SUBTITLE_APPEARANCE.lineSpacing, 1, 2, 0.01),
        maxWidth: normalizeNumber(source.maxWidth, DEFAULT_VIDEO_SUBTITLE_APPEARANCE.maxWidth, 40, 100, 1),
        fontScale: normalizeNumber(source.fontScale, DEFAULT_VIDEO_SUBTITLE_APPEARANCE.fontScale, 80, 160, 10),
    };
}

export function getVideoSubtitleAppearanceCssVars(value: unknown): Record<string, string> {
    const appearance = normalizeVideoSubtitleAppearance(value);
    const skin = VIDEO_SUBTITLE_SKINS.find((item) => item.id === appearance.skin)!;
    return {
        '--fluent-read-video-subtitle-text-color': appearance.textColor,
        '--fluent-read-video-subtitle-translation-color': appearance.translationColor,
        '--fluent-read-video-subtitle-position': appearance.position,
        '--fluent-read-video-subtitle-bottom-offset': `${appearance.bottomOffset}%`,
        '--fluent-read-video-subtitle-background': `rgba(${skin.background}, ${appearance.backgroundOpacity / 100})`,
        '--fluent-read-video-subtitle-line-spacing': String(appearance.lineSpacing),
        '--fluent-read-video-subtitle-max-width': `${appearance.maxWidth}%`,
        '--fluent-read-video-subtitle-font-scale': `${appearance.fontScale}%`,
        '--fluent-read-video-subtitle-preview-font-size': `${13 * appearance.fontScale / 100}px`,
        '--fluent-read-video-subtitle-shadow': skin.shadow,
        '--fluent-read-video-subtitle-font-family': skin.fontFamily,
        '--fluent-read-video-subtitle-backdrop-filter': skin.backdropFilter,
        '--fluent-read-video-subtitle-border': skin.border,
        '--fluent-read-video-subtitle-text-shadow': skin.textShadow,
        '--fluent-read-video-subtitle-text-stroke': skin.textStroke,
    };
}
