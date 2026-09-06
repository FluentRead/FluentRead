/**
 * @file src/core/config/writing.ts
 * 文件职责：定义写作助手的持久化偏好、动作目录与配置规范化。
 * 主要内容：限定服务、模型、输出语言、语气、快捷键和禁用网站，旧配置默认关闭，并以 HTTPS 和路径白名单限定网页回复入口。
 * 模块边界：仅处理纯数据；不读取编辑框、不调用模型、不保存配置。
 */
import {isHarnessService} from './harness';
import type {CustomOpenAIProvider} from './customOpenAI';
import {normalizeSiteDomains} from '../site-rules/domain';
import {parseHotkey, validateHotkeyConflicts} from '../hotkey';

export const WRITING_ACTIONS = [
    {id: 'draft', label: '起草'}, {id: 'reply', label: '帮我回复'},
    {id: 'polish', label: '润色'}, {id: 'continue', label: '续写'},
    {id: 'shorten', label: '精简'}, {id: 'translate', label: '翻译'},
    {id: 'summarize', label: '总结'}, {id: 'chat', label: '自由对话'},
] as const;
export type WritingIntent = typeof WRITING_ACTIONS[number]['id'];
export const WRITING_LANGUAGES = [
    {value: 'zh-CN', label: '简体中文'}, {value: 'zh-TW', label: '繁體中文'},
    {value: 'en', label: '英语'}, {value: 'ja', label: '日语'}, {value: 'ko', label: '韩语'},
    {value: 'fr', label: '法语'}, {value: 'de', label: '德语'}, {value: 'es', label: '西班牙语'},
] as const;
export const WRITING_TONES = [{value: 'natural', label: '自然'}, {value: 'professional', label: '专业'}, {value: 'friendly', label: '友好'}] as const;
export interface WritingPreferences {
    enabled: boolean; replyButtons: boolean; service: string; model: string;
    language: string; tone: string; hotkey: string; disabledDomains: string[];
}
export function normalizeWritingPreferences(value: unknown, providers: readonly CustomOpenAIProvider[] = []): WritingPreferences {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<WritingPreferences> : {};
    const hotkey = typeof source.hotkey === 'string' ? parseHotkey(source.hotkey) : null;
    return {
        enabled: source.enabled === true, replyButtons: source.replyButtons !== false,
        service: isHarnessService(source.service, providers) ? source.service : '',
        model: typeof source.model === 'string' && source.model.trim() !== '自定义模型' ? source.model.trim().slice(0, 128) : '',
        language: WRITING_LANGUAGES.some(item => item.value === source.language) ? source.language! : 'zh-CN',
        tone: WRITING_TONES.some(item => item.value === source.tone) ? source.tone! : 'natural',
        hotkey: source.hotkey === '' ? '' : hotkey?.isValid && hotkey.modifiers.length > 0 && !validateHotkeyConflicts(hotkey).hasConflict ? hotkey.displayName : 'Alt+W',
        disabledDomains: normalizeSiteDomains(source.disabledDomains).slice(0, 200),
    };
}

/** 网页写作仅在 Gmail 邮件与 GitHub Issue/PR 的回复场景提供。 */
export function isWritingPage(url: string): boolean {
    try {
        const location = new URL(url);
        if (location.protocol !== 'https:') return false;
        if (location.hostname === 'mail.google.com') return /^\/mail(?:\/|$)/u.test(location.pathname);
        return location.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+(?:\/|$)/u.test(location.pathname);
    } catch { return false; }
}
