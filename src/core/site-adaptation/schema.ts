/**
 * @file src/core/site-adaptation/schema.ts
 * 文件职责：严格校验网站适配 JSON，并归一化持久设置与选择器诊断。
 * 主要内容：校验版本、字段（含强制翻译选择器）、容量和模板引用，提供纯解析器及显式 DOM 选择器检查。
 * 模块边界：只处理输入数据；DOM 选择器校验必须显式传入 document，不读取页面全局变量。
 */

import type {
    SiteAdaptationSettings,
    SiteContentRule,
    SiteRecipe,
    SiteRule,
    SiteRuleIssue,
    SiteRulePack,
    SiteRulePackParseResult,
} from './types';

export const SITE_RULE_LIMITS = Object.freeze({
    bytes: 2 * 1024 * 1024, rules: 2000, profiles: 100, selectors: 128,
    selectorLength: 1024, content: 128, hosts: 128, paths: 128,
});

const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor']);
const recipeKeys = ['mode', 'content', 'protect', 'exclude', 'watchIgnore', 'forceTranslate', 'omit', 'literalLabels', 'literalTokens'];
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/u;
const emptyPack = (): SiteRulePack => ({version: 1, rules: []});

function isRecord(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/** 一次解析只返回新建的已知字段对象，未知字段不进入运行时或导出。 */
export function parseSiteRulePack(value: unknown): SiteRulePackParseResult {
    const issues: SiteRuleIssue[] = [];
    const issue = (path: string, message: string): void => { issues.push({path, message}); };
    const record = (input: unknown, path: string, allowed: readonly string[]): Record<string, unknown> => {
        if (!isRecord(input)) {
            issue(path, '应为 JSON 对象');
            return {};
        }
        const result: Record<string, unknown> = {};
        for (const key of Object.getOwnPropertyNames(input)) {
            const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
            if (dangerousKeys.has(key) || !allowed.includes(key)) {
                issue(`${path}.${key}`, '不支持的字段');
            } else if (!('value' in descriptor)) {
                issue(`${path}.${key}`, '只接受 JSON 数据字段');
            } else result[key] = descriptor.value;
        }
        if (Object.getOwnPropertySymbols(input).length) issue(path, '不接受 Symbol 字段');
        return result;
    };
    const string = (input: unknown, path: string, maximum: number): string => {
        if (typeof input !== 'string' || !input.trim() || input.length > maximum || /[\u0000-\u001f\u007f]/u.test(input)) {
            issue(path, `应为 1–${maximum} 字符的非空文本`);
            return '';
        }
        return input.trim();
    };
    const identifier = (input: unknown, path: string): string => {
        const id = string(input, path, 96);
        if (id && (!idPattern.test(id) || dangerousKeys.has(id))) issue(path, '标识只能包含字母、数字、点、冒号、下划线和连字符');
        return id;
    };
    const list = (input: unknown, path: string, maximum: number, length: number): string[] => {
        if (!Array.isArray(input) || input.length === 0 || input.length > maximum) {
            issue(path, `应包含 1–${maximum} 个条目`);
            return [];
        }
        return [...new Set(input.map((item, index) => string(item, `${path}[${index}]`, length)))];
    };
    const recipe = (input: unknown, path: string, additional: readonly string[] = []): SiteRecipe & Record<string, unknown> => {
        const source = record(input, path, [...recipeKeys, ...additional]);
        const result: SiteRecipe & Record<string, unknown> = {};
        if (source.mode !== undefined) {
            if (source.mode === 'augment' || source.mode === 'focus') result.mode = source.mode;
            else issue(`${path}.mode`, '应为 augment 或 focus');
        }
        for (const key of ['protect', 'exclude', 'watchIgnore', 'forceTranslate', 'omit', 'literalLabels', 'literalTokens'] as const) {
            if (source[key] !== undefined) result[key] = list(source[key], `${path}.${key}`, SITE_RULE_LIMITS.selectors, SITE_RULE_LIMITS.selectorLength);
        }
        if (source.content !== undefined) {
            if (!Array.isArray(source.content) || source.content.length === 0 || source.content.length > SITE_RULE_LIMITS.content) {
                issue(`${path}.content`, `应包含 1–${SITE_RULE_LIMITS.content} 个内容规则`);
            } else {
                result.content = source.content.map((input, index): SiteContentRule => {
                    const itemPath = `${path}.content[${index}]`;
                    const item = record(input, itemPath, ['css', 'resolve', 'atomic', 'splitOnBr', 'key']);
                    const content: SiteContentRule = {css: list(item.css, `${itemPath}.css`, SITE_RULE_LIMITS.selectors, SITE_RULE_LIMITS.selectorLength)};
                    if (item.resolve !== undefined) {
                        if (item.resolve === 'self' || item.resolve === 'closest') content.resolve = item.resolve;
                        else issue(`${itemPath}.resolve`, '应为 self 或 closest');
                    }
                    if (item.atomic !== undefined) {
                        if (typeof item.atomic === 'boolean') content.atomic = item.atomic;
                        else issue(`${itemPath}.atomic`, '应为布尔值');
                    }
                    if (item.splitOnBr !== undefined) {
                        if (typeof item.splitOnBr === 'boolean') content.splitOnBr = item.splitOnBr;
                        else issue(`${itemPath}.splitOnBr`, '应为布尔值');
                    }
                    if (item.key !== undefined) content.key = string(item.key, `${itemPath}.key`, 128);
                    return content;
                });
            }
        }
        for (const key of additional) if (source[key] !== undefined) result[key] = source[key];
        return result;
    };
    const source = record(value, '$', ['version', 'profiles', 'rules']);
    if (source.version !== 1) issue('$.version', '仅支持版本 1');
    const pack: SiteRulePack = emptyPack();
    if (source.profiles !== undefined) {
        if (!isRecord(source.profiles) || Object.keys(source.profiles).length > SITE_RULE_LIMITS.profiles) {
            issue('$.profiles', `应为不超过 ${SITE_RULE_LIMITS.profiles} 项的对象`);
        } else {
            const profiles = record(source.profiles, '$.profiles', Object.keys(source.profiles));
            pack.profiles = {};
            for (const [key, input] of Object.entries(profiles)) {
                identifier(key, `$.profiles.${key}`);
                pack.profiles[key] = recipe(input, `$.profiles.${key}`);
            }
        }
    }
    if (!Array.isArray(source.rules) || source.rules.length > SITE_RULE_LIMITS.rules) {
        issue('$.rules', `应为不超过 ${SITE_RULE_LIMITS.rules} 项的数组`);
    } else {
        const ids = new Set<string>();
        pack.rules = source.rules.map((input, index): SiteRule => {
            const path = `$.rules[${index}]`;
            const data = recipe(input, path, ['id', 'name', 'match', 'profile', 'priority', 'allScopes']);
            const id = identifier(data.id, `${path}.id`);
            if (ids.has(id)) issue(`${path}.id`, '规则标识重复');
            ids.add(id);
            const match = record(data.match, `${path}.match`, ['hosts', 'paths', 'excludePaths']);
            const hosts = list(match.hosts, `${path}.match.hosts`, SITE_RULE_LIMITS.hosts, 255).map((host, hostIndex) => {
                const normalized = host.toLowerCase().replace(/\.$/u, '');
                const domain = normalized.startsWith('*.') ? normalized.slice(2) : normalized;
                if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u.test(domain)) {
                    issue(`${path}.match.hosts[${hostIndex}]`, '应为域名或 *.域名，不包含协议、端口或路径');
                }
                return normalized;
            });
            const rule: SiteRule = {...data, id, name: string(data.name, `${path}.name`, 160), match: {hosts: [...new Set(hosts)]}};
            for (const key of ['paths', 'excludePaths'] as const) {
                if (match[key] !== undefined) {
                    rule.match[key] = list(match[key], `${path}.match.${key}`, SITE_RULE_LIMITS.paths, 2048).map((pattern, patternIndex) => {
                        if (!pattern.startsWith('/') || /[?#\\]/u.test(pattern)) issue(`${path}.match.${key}[${patternIndex}]`, '路径应以 / 开头，仅使用 * 通配符，不包含查询或片段');
                        return pattern;
                    });
                }
            }
            if (data.profile !== undefined) {
                rule.profile = identifier(data.profile, `${path}.profile`);
                if (!Object.hasOwn(pack.profiles ?? {}, rule.profile)) issue(`${path}.profile`, '找不到引用的配置模板');
            }
            if (data.priority !== undefined) {
                if (!Number.isInteger(data.priority) || Number(data.priority) < -10000 || Number(data.priority) > 10000) issue(`${path}.priority`, '优先级应为 -10000 到 10000 的整数');
                else rule.priority = Number(data.priority);
            }
            if (data.allScopes !== undefined) {
                if (typeof data.allScopes === 'boolean') rule.allScopes = data.allScopes;
                else issue(`${path}.allScopes`, '应为布尔值');
            }
            const profile = rule.profile ? pack.profiles?.[rule.profile] : undefined;
            if ((rule.mode ?? profile?.mode) === 'focus' && !rule.content?.length && !profile?.content?.length) {
                issue(`${path}.content`, 'focus 模式至少需要一条内容规则，可直接声明或通过模板提供');
            }
            return rule;
        });
    }
    if (issues.length) return {ok: false, issues};
    if (new TextEncoder().encode(JSON.stringify(pack)).byteLength > SITE_RULE_LIMITS.bytes) {
        return {ok: false, issues: [{path: '$', message: '规则包不能超过 2 MB'}]};
    }
    return {ok: true, pack};
}

export function normalizeSiteAdaptationSettings(value: unknown): SiteAdaptationSettings {
    const source = isRecord(value) ? value : {};
    const parsed = parseSiteRulePack(source.custom);
    return {
        enabled: source.enabled !== false,
        disabledRuleIds: Array.isArray(source.disabledRuleIds)
            ? [...new Set(source.disabledRuleIds.filter((id): id is string =>
                typeof id === 'string' && idPattern.test(id) && !dangerousKeys.has(id)))].slice(0, SITE_RULE_LIMITS.rules)
            : [],
        custom: parsed.ok ? parsed.pack : emptyPack(),
    };
}

/** 浏览器支持的 CSS 语法在保存时检查；运行时仍由安全选择器封装隔离故障。 */
export function validateSelectors(pack: SiteRulePack, document: Document): SiteRuleIssue[] {
    const issues: SiteRuleIssue[] = [];
    const probe = document.createElement('div');
    const inspect = (recipe: SiteRecipe, path: string): void => {
        const check = (selector: string, selectorPath: string): void => {
            try { probe.matches(selector); }
            catch { issues.push({path: selectorPath, message: '当前浏览器不支持此 CSS 选择器'}); }
        };
        for (const key of ['protect', 'exclude', 'watchIgnore', 'forceTranslate', 'omit', 'literalLabels', 'literalTokens'] as const) {
            recipe[key]?.forEach((selector, index) => check(selector, `${path}.${key}[${index}]`));
        }
        recipe.content?.forEach((content, index) => content.css.forEach((selector, cssIndex) =>
            check(selector, `${path}.content[${index}].css[${cssIndex}]`)));
    };
    Object.entries(pack.profiles ?? {}).forEach(([id, recipe]) => inspect(recipe, `$.profiles.${id}`));
    pack.rules.forEach((rule, index) => inspect(rule, `$.rules[${index}]`));
    return issues;
}
