/**
 * @file src/core/config/writing.ts
 * 文件职责：定义写作助手的持久化偏好、动作目录与配置规范化。
 * 主要内容：限定服务、模型、输出语言、语气和篇幅，默认开启并移除旧的独立入口与网站偏好，以 HTTPS 和路径白名单限定网页回复入口。
 * 模块边界：仅处理纯数据；不读取编辑框、不调用模型、不保存配置。
 */
import {isHarnessService} from './harness';
import type {CustomOpenAIProvider} from './customOpenAI';

export const WRITING_ACTIONS = [
    {id: 'draft', label: '起草'}, {id: 'reply', label: '帮我回复'},
    {id: 'polish', label: '润色'}, {id: 'continue', label: '续写'},
    {id: 'shorten', label: '精简'}, {id: 'translate', label: '翻译'},
    {id: 'summarize', label: '总结'}, {id: 'chat', label: '自由对话'},
] as const;
export type WritingIntent = typeof WRITING_ACTIONS[number]['id'];
export const WRITING_LANGUAGES = [
    {value: 'auto', label: '自动'},
    {value: 'zh-CN', label: '简体中文'}, {value: 'zh-TW', label: '繁體中文'},
    {value: 'en', label: '英语'}, {value: 'ja', label: '日语'}, {value: 'ko', label: '韩语'},
    {value: 'fr', label: '法语'}, {value: 'de', label: '德语'}, {value: 'es', label: '西班牙语'},
] as const;
export const WRITING_TONES = [{value: 'natural', label: '自然'}, {value: 'professional', label: '专业'}, {value: 'friendly', label: '友好'}] as const;
export const WRITING_LENGTHS = [{value: 'auto', label: '自动'}, {value: 'short', label: '简短'}, {value: 'standard', label: '标准'}, {value: 'detailed', label: '详细'}] as const;
export type WritingLength = typeof WRITING_LENGTHS[number]['value'];
export interface WritingPreferences {
    enabled: boolean; service: string; model: string;
    language: string; tone: string; length: WritingLength;
}
export function normalizeWritingPreferences(value: unknown, providers: readonly CustomOpenAIProvider[] = []): WritingPreferences {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<WritingPreferences> : {};
    return {
        enabled: source.enabled !== false,
        service: isHarnessService(source.service, providers) ? source.service : '',
        model: typeof source.model === 'string' && source.model.trim() !== '自定义模型' ? source.model.trim().slice(0, 128) : '',
        language: WRITING_LANGUAGES.some(item => item.value === source.language) ? source.language! : 'auto',
        tone: WRITING_TONES.some(item => item.value === source.tone) ? source.tone! : 'natural',
        length: WRITING_LENGTHS.some(item => item.value === source.length) ? source.length! : 'auto',
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
