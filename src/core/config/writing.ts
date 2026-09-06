/**
 * @file src/core/config/writing.ts
 * 文件职责：定义写作助手的持久化偏好、动作目录与配置规范化。
 * 主要内容：默认跟随翻译目标语言并使用简短自然回复，限定风格、身份和自定义语气边界，迁移旧偏好，以 HTTPS 和路径白名单限定网页回复入口。
 * 模块边界：仅处理纯数据；不读取编辑框、不调用模型、不保存配置。
 */
import {isHarnessService} from './harness';
import type {CustomOpenAIProvider} from './customOpenAI';
import {options} from './catalog';
import {normalizeChineseLanguageCode} from '../language/chinese';

export const WRITING_ACTIONS = [
    {id: 'draft', label: '起草'}, {id: 'reply', label: '帮我回复'},
    {id: 'polish', label: '润色'}, {id: 'continue', label: '续写'},
    {id: 'shorten', label: '精简'}, {id: 'translate', label: '翻译'},
    {id: 'summarize', label: '总结'}, {id: 'chat', label: '自由对话'},
] as const;
export type WritingIntent = typeof WRITING_ACTIONS[number]['id'];
export const WRITING_LANGUAGES = [
    {value: 'target', label: '跟随目标语言'},
    ...Array.from(new Map([...options.to, {value: 'de', label: '德语'}].map(item => [item.value, item])).values()),
] as const;
export const WRITING_TONES = [
    {value: 'natural', label: '自然'}, {value: 'professional', label: '专业'}, {value: 'friendly', label: '友好'},
    {value: 'warm', label: '温暖'}, {value: 'sincere', label: '真诚'}, {value: 'empathetic', label: '体谅'}, {value: 'firm', label: '坚定'},
] as const;
export const WRITING_STYLES = [{value: 'auto', label: '自动'}, {value: 'formal', label: '正式'}, {value: 'neutral', label: '中性'}, {value: 'casual', label: '随意'}] as const;
export const WRITING_ROLES = [
    {value: 'auto', label: '自动'}, {value: 'maintainer', label: '维护者'}, {value: 'developer', label: '开发者'},
    {value: 'user', label: '用户'}, {value: 'colleague', label: '同事'}, {value: 'support', label: '客服'},
    {value: 'leader', label: '领导'}, {value: 'subordinate', label: '下属'},
] as const;
export const WRITING_ROLE_MAX_LENGTH = 200;
export const WRITING_TONE_MAX_LENGTH = 100;
export const WRITING_LENGTHS = [{value: 'short', label: '简短'}, {value: 'standard', label: '标准'}, {value: 'detailed', label: '详细'}] as const;
export type WritingLength = typeof WRITING_LENGTHS[number]['value'];
export type WritingStyle = typeof WRITING_STYLES[number]['value'];
export interface WritingPreferences {
    enabled: boolean; service: string; model: string;
    language: string; tone: string; length: WritingLength; style: WritingStyle; role: string;
}
/** 旧自动语言随新默认迁移，中文地区别名统一为书写体系。 */
export function normalizeWritingLanguage(value: unknown): string {
    const language = typeof value === 'string' ? normalizeChineseLanguageCode(value) : '';
    return WRITING_LANGUAGES.some(item => item.value === language) ? language : 'target';
}
/** 只接受目录语言与旧自动值，协议不能靠规范化把任意语言静默变成合法值。 */
export function isWritingLanguage(value: string): boolean {
    return value === 'auto' || WRITING_LANGUAGES.some(item => item.value === normalizeChineseLanguageCode(value));
}
export function resolveWritingLanguage(value: string, target: string): string {
    const language = normalizeWritingLanguage(value);
    if (language !== 'target') return language;
    const resolvedTarget = normalizeWritingLanguage(target);
    return resolvedTarget === 'target' ? 'zh-Hans' : resolvedTarget;
}
export function normalizeWritingLength(value: unknown): WritingLength {
    return WRITING_LENGTHS.some(item => item.value === value) ? value as WritingLength : 'short';
}
function normalizeDescription(value: unknown, limit: number, fallback: string): string {
    return typeof value === 'string' ? value.trim().replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, limit).trim() || fallback : fallback;
}
export function normalizeWritingPreferences(value: unknown, providers: readonly CustomOpenAIProvider[] = []): WritingPreferences {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<WritingPreferences> : {};
    return {
        enabled: source.enabled !== false,
        service: isHarnessService(source.service, providers) ? source.service : '',
        model: typeof source.model === 'string' && source.model.trim() !== '自定义模型' ? source.model.trim().slice(0, 128) : '',
        language: normalizeWritingLanguage(source.language),
        tone: normalizeDescription(source.tone, WRITING_TONE_MAX_LENGTH, 'natural'),
        length: normalizeWritingLength(source.length),
        style: WRITING_STYLES.some(item => item.value === source.style) ? source.style! : 'auto',
        role: normalizeDescription(source.role, WRITING_ROLE_MAX_LENGTH, 'auto'),
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
