/**
 * @file src/core/config/informationHighlight.ts
 * 文件职责：定义信息高亮的持久阅读偏好及安全归一化规则，供配置、页面绘制和设置界面共用。
 * 主要内容：保存当前页快捷键、全局开启、本地模型选择及阅读外观；旧配置缺少模型时沿用 Qwen2.5，非法导入回退到默认值，开关只接受明确的 true，快捷键规范化为稳定写法。
 * 模块边界：纯数据规则，不读取网页、不下载模型；页内会话由信息高亮 feature 管理。
 */
import {canonicalizeHotkey} from '@/src/core/hotkey';
import {DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID, INFORMATION_HIGHLIGHT_MODEL_IDS, type InformationHighlightModelId} from './informationHighlightModel';

export type InformationHighlightMode = 'keywords' | 'surprisal-local';
export type InformationHighlightDensity = 'low' | 'medium' | 'high';
export type InformationHighlightColor = 'rose' | 'amber' | 'mint' | 'blue' | 'violet' | 'slate';
export type InformationHighlightStyle = 'heatmap' | 'background' | 'underline';
export type InformationHighlightIntensity = 'soft' | 'standard' | 'strong';

export interface InformationHighlightPreferences {
    enabled: boolean;
    hotkey: string;
    hotkeyEnabled: boolean;
    mode: InformationHighlightMode;
    model: InformationHighlightModelId;
    density: InformationHighlightDensity;
    color: InformationHighlightColor;
    style: InformationHighlightStyle;
    intensity: InformationHighlightIntensity;
}

export const DEFAULT_INFORMATION_HIGHLIGHT_PREFERENCES: Readonly<InformationHighlightPreferences> = Object.freeze({
    enabled: false, hotkey: 'Alt+H', hotkeyEnabled: true, mode: 'keywords', model: DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID, density: 'high', color: 'rose', style: 'heatmap', intensity: 'standard',
});

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T => allowed.includes(value as T) ? value as T : allowed[0];

export function normalizeInformationHighlightPreferences(value: unknown): InformationHighlightPreferences {
    const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : {};
    const hotkey = record.hotkey;
    // 每个列表的首项是缺失或非法值的回退。
    return {
        enabled: record.enabled === true,
        hotkey: hotkey === '' ? '' : (typeof hotkey === 'string' && canonicalizeHotkey(hotkey)) || 'Alt+H',
        hotkeyEnabled: record.hotkeyEnabled !== false,
        mode: oneOf(record.mode, ['keywords', 'surprisal-local']),
        model: oneOf(record.model, INFORMATION_HIGHLIGHT_MODEL_IDS),
        density: oneOf(record.density, ['high', 'low', 'medium']),
        color: oneOf(record.color, ['rose', 'amber', 'mint', 'blue', 'violet', 'slate']),
        style: oneOf(record.style, ['heatmap', 'background', 'underline']),
        intensity: oneOf(record.intensity, ['standard', 'soft', 'strong']),
    };
}
