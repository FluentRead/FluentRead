/**
 * @file src/core/config/diffFormatters.ts
 *
 * 文件职责：实现配置差异预览的值格式化函数与递归敏感内容脱敏清洗器，确保差异展示安全可读且不泄露凭据或超深嵌套内容。
 * 主要内容：提供敏感文本/JSON 递归脱敏 sanitizeSensitiveValue、基础标量与容器格式化，以及自定义服务、组合服务、快捷翻译方案、弹窗布局与术语库摘要格式化器。
 * 模块边界：仅服务于 src/core/config/diff.ts，依赖 diffLabels 与 credentials 的敏感键判定，不直接构建分组差异或接触浏览器存储。
 */

import {isSensitiveConfigKey} from './credentials';
import {
    LANGUAGE_LABELS,
    POPUP_MODULE_LABELS,
    POPUP_QUICK_FEATURE_LABELS,
    SERVICE_LABELS,
    TRANSLATION_APPEARANCE_VALUE_LABELS,
    serviceName,
} from './diffLabels';
import {interfaceVisibilityOptions, popupQuickFeatureOptions} from './interfaceAppearance';

export type ConfigRecord = Record<string, unknown>;
export type ValueFormatter = (value: unknown) => string;

export const SENSITIVE_SUMMARY_PREFIX = '敏感内容已隐藏';
const MAX_INLINE_ITEMS = 4;
const MAX_INLINE_TEXT_LENGTH = 120;
const MAX_PREVIEW_DEPTH = 32;
export const DEPTH_LIMITED_PREVIEW = Symbol('depth-limited-preview');
export const DEPTH_LIMITED_SUMMARY = '已配置（内容已摘要）';

export function isRecord(value: unknown): value is ConfigRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function configRecord(value: unknown): ConfigRecord {
    return isRecord(value) ? value : {};
}

function containsSensitiveContent(value: string): boolean {
    return /(?:authorization|bearer\s+[a-z0-9._~+/=-]+|(?:api[-_ ]?key|token|password|passwd|secret)\s*["']?\s*[:=])/iu.test(value)
        || /:\/\/[^/\s:@]+:[^/\s@]+@/u.test(value);
}

function sensitiveSummary(value: string): string {
    return `${SENSITIVE_SUMMARY_PREFIX}（${value.length} 字符）`;
}

function sanitizeSensitiveContent(value: unknown, seen: WeakSet<object>, depth: number, preview: {depthLimited: boolean}): unknown {
    if (depth >= MAX_PREVIEW_DEPTH) {
        preview.depthLimited = true;
        return DEPTH_LIMITED_PREVIEW;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                const parsed = JSON.parse(trimmed) as unknown;
                if (isRecord(parsed) || Array.isArray(parsed)) {
                    return sanitizeSensitiveContent(parsed, seen, depth + 1, preview);
                }
            } catch {
                // 非 JSON 的 prompt 或模板会在下方按普通文本处理。
            }
        }
        return containsSensitiveContent(value) ? sensitiveSummary(value) : value;
    }
    if (Array.isArray(value)) {
        if (seen.has(value)) return '[循环引用]';
        seen.add(value);
        const result = value.map((item) => sanitizeSensitiveContent(item, seen, depth + 1, preview));
        seen.delete(value);
        return result;
    }
    if (!isRecord(value)) return value;
    if (seen.has(value)) return '[循环引用]';
    seen.add(value);

    const result: ConfigRecord = {};
    for (const [key, item] of Object.entries(value)) {
        if (isSensitiveConfigKey(key)) continue;
        Object.defineProperty(result, key, {
            value: sanitizeSensitiveContent(item, seen, depth + 1, preview),
            enumerable: true, configurable: true, writable: true,
        });
    }
    seen.delete(value);
    return result;
}

export function sanitizeSensitiveValue(value: unknown): unknown {
    const preview = {depthLimited: false};
    const sanitized = sanitizeSensitiveContent(value, new WeakSet<object>(), 0, preview);
    // 整个字段使用已翻译的摘要，避免嵌套键和值拼接后无法命中旧文案翻译。
    return preview.depthLimited ? DEPTH_LIMITED_PREVIEW : sanitized;
}

export function formatEnum(value: unknown, labels: Map<unknown, string>): string {
    return labels.get(value) ?? formatValue(value);
}

export function formatBoolean(value: unknown, inverted = false): string {
    if (typeof value !== 'boolean') return formatValue(value);
    return (inverted ? !value : value) ? '开启' : '关闭';
}

export function formatNumber(value: unknown, suffix = ''): string {
    return typeof value === 'number' && Number.isFinite(value)
        ? `${value}${suffix}`
        : formatValue(value);
}

export function formatTranslationAppearanceValue(value: unknown): string {
    if (typeof value === 'number') return formatNumber(value, '%');
    return TRANSLATION_APPEARANCE_VALUE_LABELS.get(value) ?? formatValue(value);
}

export function formatRequestRate(value: unknown): string {
    return value === 0 ? '不限速' : formatNumber(value, ' 次');
}

export function formatString(value: string): string {
    if (!value.trim()) return '未设置';
    if (value.startsWith(SENSITIVE_SUMMARY_PREFIX)) return value;
    if (value.length > MAX_INLINE_TEXT_LENGTH) return `长文本（${value.length} 字符）`;
    return value.replace(/\s+/gu, ' ').trim();
}

export function formatArray(value: unknown[], itemFormatter: ValueFormatter = formatValue): string {
    if (value.length === 0) return '无';
    const visible = value.slice(0, MAX_INLINE_ITEMS).map(itemFormatter).join('、');
    return value.length > MAX_INLINE_ITEMS
        ? `${value.length} 项：${visible} 等`
        : visible;
}

export function formatRecord(value: ConfigRecord): string {
    const entries = Object.entries(value).filter(([key]) => !isSensitiveConfigKey(key));
    if (entries.length === 0) return '无';
    const visible = entries.slice(0, MAX_INLINE_ITEMS).map(([key, item]) => {
        const displayKey = SERVICE_LABELS.get(key) ?? key;
        return `${displayKey}：${formatValue(item)}`;
    }).join('；');
    return entries.length > MAX_INLINE_ITEMS ? `${entries.length} 项：${visible} 等` : visible;
}

export function formatValue(value: unknown): string {
    if (value === undefined || value === null || value === '') return '未设置';
    if (typeof value === 'boolean') return formatBoolean(value);
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '未设置';
    if (typeof value === 'string') return formatString(value);
    if (Array.isArray(value)) return formatArray(value);
    if (isRecord(value)) return formatRecord(value);
    return String(value);
}

export function formatPrompt(value: unknown): string {
    if (value === undefined || value === null || value === '') return '未设置';
    if (typeof value === 'string') {
        if (value.startsWith(SENSITIVE_SUMMARY_PREFIX)) return value;
        return `已配置（${value.length} 字符）`;
    }
    return formatValue(value);
}

export function formatCustomBody(value: unknown): string {
    if (value === undefined || value === null || value === '') return '未设置';
    if (typeof value === 'string' && value.startsWith(SENSITIVE_SUMMARY_PREFIX)) return value;
    if (Array.isArray(value)) return `${value.length} 项 JSON（内容已摘要）`;
    if (isRecord(value)) return `${Object.keys(value).length} 个公开字段（内容已摘要）`;
    if (typeof value === 'string') return `文本请求体（${value.length} 字符，内容已摘要）`;
    return '已配置（内容已摘要）';
}

export function formatService(value: unknown): string {
    return typeof value === 'string' ? serviceName(value) : formatValue(value);
}

export function formatInterfaceVisibility(value: unknown): string {
    if (!isRecord(value)) return formatValue(value);
    return interfaceVisibilityOptions
        .map(({key, label}) => `${label}${value[key] === false ? '关闭' : '开启'}`)
        .join('、');
}

export function formatPopupModuleOrder(value: unknown): string {
    if (!Array.isArray(value)) return formatValue(value);
    if (value.length === 0) return '无';
    return value.map((item) => typeof item === 'string'
        ? POPUP_MODULE_LABELS.get(item) ?? item
        : formatValue(item)).join(' → ');
}

export function formatPopupQuickFeatureVisibility(value: unknown): string {
    if (!isRecord(value)) return formatValue(value);
    return popupQuickFeatureOptions
        .map(({id, label}) => `${label}：${value[id] === false ? '隐藏' : '显示'}`)
        .join('、');
}

export function formatPopupQuickFeatureOrder(value: unknown): string {
    if (!Array.isArray(value)) return formatValue(value);
    if (value.length === 0) return '无';
    return value.map((item) => typeof item === 'string'
        ? POPUP_QUICK_FEATURE_LABELS.get(item) ?? item
        : formatValue(item)).join(' → ');
}

export function formatCustomOpenAIProviders(value: unknown): string {
    if (!Array.isArray(value) || value.length === 0) return '无';
    return formatArray(value, (item) => {
        if (!isRecord(item)) return formatValue(item);
        const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '未命名服务';
        const endpoint = formatValue(item.endpoint);
        const models = Array.isArray(item.models) ? formatArray(item.models) : '无';
        return `${name}（接口：${endpoint}；模型：${models}）`;
    });
}

export function formatCompositeTranslationProviders(value: unknown): string {
    if (!Array.isArray(value) || value.length === 0) return '无';
    return formatArray(value, (item) => {
        if (!isRecord(item)) return formatValue(item);
        const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '未命名组合';
        const strategy = item.strategy === 'random' ? '随机' : item.strategy === 'smart' ? '智能' : '轮流';
        const members = Array.isArray(item.services) ? formatArray(item.services, formatService) : '无';
        return `${name}（${strategy}；成员：${members}；单次超时：${formatValue(item.timeoutMs)} ms）`;
    });
}

/** 历史预览只显示规模，避免把用户保存的专业词句展开到配置差异中。 */
export function formatGlossaryLibraries(value: unknown): string {
    if (!Array.isArray(value)) return formatValue(value);
    const libraries = value.filter(isRecord);
    const entries = libraries.reduce((count, library) => count + (Array.isArray(library.entries) ? library.entries.length : 0), 0);
    return `${libraries.length} 套词库，${entries} 条术语`;
}

export function formatGlossarySelection(value: unknown): string {
    if (value == null) return '跟随全局词库';
    if (!Array.isArray(value)) return formatValue(value);
    return value.length ? `指定 ${value.length} 套词库` : '不使用术语库';
}

export function formatQuickTranslationProfiles(value: unknown): string {
    if (!Array.isArray(value) || value.length === 0) return '无';
    return value.map((item) => {
        if (!isRecord(item)) return formatValue(item);
        const action = item.action === 'full-page' ? '全文' : item.action === 'section' ? '局部' : '悬停';
        const hotkey = typeof item.hotkey === 'string' && item.hotkey ? item.hotkey : '未设置';
        const service = typeof item.service === 'string' && item.service
            ? serviceName(item.service)
            : '默认服务';
        const model = typeof item.model === 'string' && item.model ? ` · ${item.model}` : '';
        const language = typeof item.targetLanguage === 'string' && item.targetLanguage
            ? formatEnum(item.targetLanguage, LANGUAGE_LABELS)
            : '默认语言';
        const display = item.displayMode === 'bilingual'
            ? '双语'
            : item.displayMode === 'translation-only' ? '仅译文' : '默认显示';
        const range = item.action === 'full-page'
            ? `，${item.fullPageMode === 'viewport'
                ? '按阅读进度'
                : item.fullPageMode === 'all' ? '立即翻译到网页底部' : '默认范围'}`
            : '';
        const disabled = item.enabled === false ? '（已停用）' : '';
        const glossary = item.glossaryIds === undefined ? '' : `，术语库：${formatGlossarySelection(item.glossaryIds)}`;
        return `${action} ${hotkey}${disabled}：${service}${model}，${language}，${display}${range}${glossary}`;
    }).join('；');
}
