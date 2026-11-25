/**
 * @file src/core/config/inputTranslation.ts
 * 文件职责：定义输入框翻译的独立配置常量、提示词默认值与纯规范化规则，供配置模型、设置界面和输入翻译后台共同使用。
 * 主要内容：声明替换/双语输出顺序模式、自定义快捷键合法性校验与平台展示/键盘事件匹配、服务继承、模型与提示词默认值及相邻触发间隔的语义，限制 interval 为 200 至 2000 毫秒整数，并判断服务是否支持通用提示词。
 * 模块边界：本文件属于 core 配置领域层，只读取翻译服务目录、自定义服务元数据与按键解析规则；不读取浏览器存储、不接收网页消息、不访问凭据或发起网络请求。
 */

import {canonicalizeHotkey, matchesHotkey, parseHotkey} from '@/src/core/hotkey';
import {isConfiguredCustomOpenAIProvider, isCustomOpenAIProviderId, type CustomOpenAIProvider} from './customOpenAI';
import {servicesType} from './catalog';
import {isCompositeTranslationProviderId, isConfiguredCompositeTranslationProvider, type CompositeTranslationProvider} from './compositeTranslation';

export const DEFAULT_INPUT_BOX_TRANSLATION_INTERVAL = 1000;
export const INPUT_BOX_TRANSLATION_INTERVAL_MIN = 200;
export const INPUT_BOX_TRANSLATION_INTERVAL_MAX = 2000;
export const INPUT_BOX_TRANSLATION_INTERVAL_STEP = 1;

/**
 * 输入框内无修饰的普通字符、数字、编辑键或方向键会打断正常输入；
 * 自定义快捷键仅允许带修饰键的组合键或功能键（F1–F12），且禁止 CMD/Meta。
 */
export function isSupportedCustomInputBoxTranslationHotkey(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const parsed = parseHotkey(value);
    if (!parsed.isValid) return false;
    return parsed.modifiers.length > 0 || /^f\d+$/u.test(parsed.key);
}

/** 规范化输入框翻译自定义快捷键为平台无关写法；非法或不支持的裸键返回空字符串。 */
export function normalizeCustomInputBoxTranslationHotkey(value: unknown): string {
    if (!isSupportedCustomInputBoxTranslationHotkey(value)) return '';
    return canonicalizeHotkey(value as string);
}

/** 生成界面展示用的输入框自定义快捷键名称，Mac 上显示 Option/Control 习惯写法。 */
export function inputBoxTranslationHotkeyDisplayName(customHotkey: unknown): string {
    const normalized = normalizeCustomInputBoxTranslationHotkey(customHotkey);
    return normalized ? parseHotkey(normalized).displayName : '';
}

/** 判断键盘事件是否匹配已配置的输入框自定义快捷键；修饰键必须完全一致。 */
export function matchesCustomInputBoxTranslationHotkey(event: KeyboardEvent, customHotkey: unknown): boolean {
    const normalized = normalizeCustomInputBoxTranslationHotkey(customHotkey);
    return Boolean(normalized) && matchesHotkey(event, parseHotkey(normalized));
}

export type InputBoxTranslationOutputMode = 'replace' | 'append' | 'prepend';

/** 旧配置继续替换原文；只有显式选择双语模式时才保留原文。 */
export function normalizeInputBoxTranslationOutputMode(value: unknown): InputBoxTranslationOutputMode {
    return value === 'append' || value === 'prepend' ? value : 'replace';
}

export const DEFAULT_INPUT_BOX_TRANSLATION_SYSTEM_PROMPT =
    'You are a professional translation assistant. Translate only the user text. Return only the translation, with no explanation, notes, or quotation marks.';
export const DEFAULT_INPUT_BOX_TRANSLATION_PROMPT =
    'Translate the following text into {{to}}. If translation is unnecessary, return the original text. Return only the translation:\n\n{{origin}}';

export function normalizeInputBoxTranslationInterval(value: unknown): number {
    const numeric = typeof value === 'number' && Number.isFinite(value)
        ? Math.trunc(value)
        : DEFAULT_INPUT_BOX_TRANSLATION_INTERVAL;
    return Math.min(
        INPUT_BOX_TRANSLATION_INTERVAL_MAX,
        Math.max(INPUT_BOX_TRANSLATION_INTERVAL_MIN, numeric),
    );
}

export function normalizeInputBoxTranslationService(
    value: unknown,
    customProviders: readonly CustomOpenAIProvider[] = [],
    compositeProviders: readonly CompositeTranslationProvider[] = [],
): string {
    if (typeof value !== 'string') return '';
    const service = value.trim();
    if (isCompositeTranslationProviderId(service)) {
        return isConfiguredCompositeTranslationProvider(compositeProviders, service) ? service : '';
    }
    if (isCustomOpenAIProviderId(service)) {
        return isConfiguredCustomOpenAIProvider(customProviders, service) ? service : '';
    }
    return servicesType.machine.has(service) || servicesType.AI.has(service)
        ? service
        : '';
}

export function normalizeInputBoxTranslationModel(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

export function normalizeInputBoxTranslationPrompt(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/** 保留用户提示词原文，并在执行时补齐缺失的任务变量，避免只写风格要求时丢失原文。 */
export function completeInputBoxTranslationPrompt(value: unknown): string {
    const prompt = normalizeInputBoxTranslationPrompt(value).trim() || DEFAULT_INPUT_BOX_TRANSLATION_PROMPT;
    const missing: string[] = [];
    if (!prompt.includes('{{to}}')) missing.push('Target language: {{to}}');
    if (!prompt.includes('{{origin}}')) missing.push('Text to translate:\n{{origin}}');
    return missing.length > 0 ? `${prompt}\n\n${missing.join('\n\n')}` : prompt;
}

/** 仅通用提示词型 AI 服务消费输入框专用 prompt；机器翻译和原生 MT 模型必须忽略它。 */
export function supportsInputBoxTranslationPrompt(service: string, model = ''): boolean {
    return servicesType.isUseAIContext(service, model);
}
