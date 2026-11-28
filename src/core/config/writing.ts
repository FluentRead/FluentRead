/**
 * @file src/core/config/writing.ts
 * 文件职责：定义写作助手的持久化偏好、动作目录、呼出快捷键与配置规范化。
 * 主要内容：默认跟随翻译目标语言并使用简短自然回复，独立选择阅读对照语言，限定风格、身份、自定义语气与呼出组合键边界，迁移旧偏好并规范化写作专用网站禁用名单，以 HTTPS 与域名路径白名单识别一等协作平台并校验通用网页地址。
 * 模块边界：仅处理纯数据与快捷键匹配；不读取编辑框、不调用模型、不保存配置。
 */
import {isHarnessService} from './harness';
import type {CustomOpenAIProvider} from './customOpenAI';
import {options} from './catalog';
import {canonicalizeHotkey, matchesHotkey, parseHotkey} from '../hotkey';
import {normalizeChineseLanguageCode} from '../language/chinese';
import type {UiLanguage} from '../i18n/types';
import {normalizeSiteDomains} from '../site-rules/domain';

export const FIRST_CLASS_WRITING_SITES = [
    'gmail', 'github', 'outlook', 'x', 'reddit', 'linkedin', 'slack', 'discord', 'notion',
] as const;
export type FirstClassWritingSite = typeof FIRST_CLASS_WRITING_SITES[number];
export const WRITING_SITES = [...FIRST_CLASS_WRITING_SITES, 'generic'] as const;
export type WritingSiteId = typeof WRITING_SITES[number];

export const DEFAULT_WRITING_HOTKEY = 'Alt+Shift+W';

export const WRITING_ACTIONS = [
    {id: 'draft', label: '起草'}, {id: 'reply', label: '帮我回复'},
    {id: 'polish', label: '润色'}, {id: 'continue', label: '续写'},
    {id: 'shorten', label: '精简'}, {id: 'translate', label: '翻译'},
    {id: 'summarize', label: '总结'}, {id: 'chat', label: '自由对话'},
] as const;
export type WritingIntent = typeof WRITING_ACTIONS[number]['id'];
export const WRITING_LANGUAGES = [
    {value: 'target', label: '跟随目标语言'},
    ...options.to,
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
    enabled: boolean; disabledDomains: string[]; service: string; model: string;
    language: string; referenceLanguage: string; tone: string; length: WritingLength; style: WritingStyle; role: string;
    writingHotkey: string;
}
/** 呼出快捷键必须带修饰键且不含 Meta，显式空值或 none 表示关闭快捷键呼出。 */
export function normalizeWritingHotkey(value: unknown): string {
    if (value === '' || value === 'none') return '';
    if (typeof value !== 'string') return DEFAULT_WRITING_HOTKEY;
    const parsed = parseHotkey(value);
    return parsed.isValid && parsed.modifiers.length > 0 && !parsed.modifiers.includes('meta')
        ? canonicalizeHotkey(value) : DEFAULT_WRITING_HOTKEY;
}
export function resolveWritingHotkey(writing: Partial<Pick<WritingPreferences, 'enabled' | 'writingHotkey'>> | undefined): string {
    if (!writing || writing.enabled === false) return '';
    return normalizeWritingHotkey(writing.writingHotkey);
}
export function writingHotkeyDisplayName(value: unknown): string {
    const hotkey = normalizeWritingHotkey(value);
    return hotkey ? parseHotkey(hotkey).displayName : '';
}
export function matchesWritingHotkey(event: KeyboardEvent, writing: Pick<WritingPreferences, 'enabled' | 'writingHotkey'> | undefined): boolean {
    const hotkey = resolveWritingHotkey(writing);
    return Boolean(hotkey) && matchesHotkey(event, parseHotkey(hotkey));
}
/** 旧自动语言随新默认迁移，中文地区别名统一为书写体系。 */
export function normalizeWritingLanguage(value: unknown): string {
    const language = typeof value === 'string' ? normalizeChineseLanguageCode(value) : '';
    return WRITING_LANGUAGES.some(item => item.value === language) ? language : 'target';
}
/** 对照语言独立于回复目标；缺省跟随界面，显式关闭与具体语言保持持久化。 */
export function normalizeWritingReferenceLanguage(value: unknown): string {
    if (value === 'off' || value === 'ui') return value;
    const language = normalizeWritingLanguage(value);
    return language === 'target' ? 'ui' : language;
}
/** 将界面语言转换为生成语言代码；关闭时不发送对照请求。 */
export function resolveWritingReferenceLanguage(value: unknown, uiLanguage: UiLanguage): string {
    const language = normalizeWritingReferenceLanguage(value);
    if (language === 'off') return '';
    if (language !== 'ui') return language;
    const uiTargets: Record<UiLanguage, string> = {'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant', 'en-US': 'en', 'ja-JP': 'ja', 'ko-KR': 'ko', 'fr-FR': 'fr', 'ru-RU': 'ru', 'es-ES': 'es'};
    return uiTargets[uiLanguage];
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
        disabledDomains: normalizeSiteDomains(source.disabledDomains),
        service: isHarnessService(source.service, providers) ? source.service : '',
        model: typeof source.model === 'string' && source.model.trim() !== '自定义模型' ? source.model.trim().slice(0, 128) : '',
        language: normalizeWritingLanguage(source.language),
        referenceLanguage: normalizeWritingReferenceLanguage(source.referenceLanguage),
        tone: normalizeDescription(source.tone, WRITING_TONE_MAX_LENGTH, 'natural'),
        length: normalizeWritingLength(source.length),
        style: WRITING_STYLES.some(item => item.value === source.style) ? source.style! : 'auto',
        role: normalizeDescription(source.role, WRITING_ROLE_MAX_LENGTH, 'auto'),
        writingHotkey: normalizeWritingHotkey(source.writingHotkey),
    };
}

const FIRST_CLASS_HOSTS = new Set([
    'outlook.live.com', 'outlook.office.com', 'outlook.office365.com',
    'x.com', 'twitter.com',
    'reddit.com', 'www.reddit.com', 'old.reddit.com', 'sh.reddit.com',
    'linkedin.com', 'www.linkedin.com',
    'app.slack.com',
    'discord.com', 'ptb.discord.com', 'canary.discord.com',
    'notion.so', 'www.notion.so',
]);

/** 一等支持站点自动呈现原生操作行入口；Gmail 与 GitHub 保留精确路径白名单。 */
export function isWritingPage(url: string): boolean {
    try {
        const location = new URL(url);
        if (location.protocol !== 'https:') return false;
        if (location.hostname === 'mail.google.com') return /^\/mail(?:\/|$)/u.test(location.pathname);
        if (location.hostname === 'github.com') return /^\/[^/]+\/[^/]+\/(?:issues\/new\/?$|(?:issues|pull)\/\d+(?:\/|$))/u.test(location.pathname);
        return FIRST_CLASS_HOSTS.has(location.hostname);
    } catch { return false; }
}

/** 通用快捷键写作允许任何常规 HTTP/HTTPS 网页，拒绝扩展页、本地文件与无效地址。 */
export function isWritingEligibleUrl(url: string): boolean {
    try {
        const location = new URL(url);
        return (location.protocol === 'https:' || location.protocol === 'http:') && Boolean(location.hostname);
    } catch { return false; }
}
