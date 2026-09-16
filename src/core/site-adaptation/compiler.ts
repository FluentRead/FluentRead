/**
 * @file src/core/site-adaptation/compiler.ts
 * 文件职责：将网站适配 JSON 编译为既有候选引擎使用的适配器，并组合内置与用户规则。
 * 主要内容：展开单层模板、按域名和路径匹配规则、保护原文并执行自定义整条覆盖。
 * 模块边界：仅匹配 URL 与声明内容边界，不注入脚本或样式，不监听页面生命周期。
 */

import {isLiteralLabel, isLiteralToken} from './literalLabel';
import {createDeclarativeAdapter} from '@/src/core/translation/adapters/declarative';
import type {TranslationSiteAdapter} from '@/src/core/translation/types';
import type {SiteAdaptationSettings, SiteContentRule, SiteRecipe, SiteRule, SiteRulePack} from './types';

/** 只提取 CSS 的属性依赖；无法准确读取的语法使用全属性观察，不猜测其含义。 */
export function getSiteRuleObservedAttributes(recipe: SiteRecipe): string[] | null {
    const attributes = new Set(['id', 'class']);
    if (recipe.literalLabels?.length) attributes.add('data-fr-translation-owned');
    const selectors = [
        ...(recipe.content ?? []).flatMap((content) => content.css),
        ...(recipe.protect ?? []), ...(recipe.exclude ?? []), ...(recipe.watchIgnore ?? []),
        ...(recipe.omit ?? []), ...(recipe.literalLabels ?? []), ...(recipe.literalTokens ?? []),
    ];
    const structuralPseudos = new Set(['is', 'where', 'not', 'nth-child', 'nth-last-child',
        'nth-of-type', 'nth-last-of-type', 'first-child', 'last-child', 'only-child',
        'first-of-type', 'last-of-type', 'only-of-type', 'empty', 'root', 'scope']);
    for (const selector of selectors) {
        // CSS 转义、注释与反向关系选择器可隐藏属性名或扩大依赖范围。
        if (selector.includes('\\') || selector.includes('/*')) return null;
        for (let index = 0; index < selector.length; index += 1) {
            if (selector[index] === '[') {
                const attribute = /^\[\s*([a-zA-Z_][a-zA-Z0-9_-]*)(?:\s*[~|^$*]?=\s*(?:"[^"]*"|'[^']*'|[^\s\]"']+)\s*(?:[isIS]\s*)?)?\s*\]/u.exec(selector.slice(index));
                if (!attribute) return null;
                attributes.add(attribute[1]!.toLowerCase());
                index += attribute[0].length - 1;
            } else if (selector[index] === ']') {
                return null;
            } else if (selector[index] === ':') {
                const pseudo = /^:([a-z-]+)/iu.exec(selector.slice(index));
                if (!pseudo) return null;
                const name = pseudo[1]!.toLowerCase();
                if (name === 'lang' || name === 'dir') attributes.add(name);
                else if (!structuralPseudos.has(name)) return null;
                index += pseudo[0].length - 1;
            }
        }
    }
    return [...attributes];
}

/** 合并旧的通用观察范围；任一匹配规则不能穷举属性时保守地取消过滤。 */
export function getSiteAdapterAttributeFilter(
    adapters: readonly TranslationSiteAdapter[],
    defaults: readonly string[] = [],
): string[] | null {
    const attributes = new Set(defaults);
    for (const adapter of adapters) {
        if (adapter.observedAttributes === null) return null;
        adapter.observedAttributes?.forEach((attribute) => attributes.add(attribute));
    }
    return [...attributes];
}

function unique<T>(items: readonly T[], key: (item: T) => string): T[] {
    const seen = new Set<string>();
    return items.filter((item) => {
        const identity = key(item);
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
    });
}

function resolveRecipe(pack: SiteRulePack, rule: SiteRule): SiteRecipe {
    const profile = rule.profile ? pack.profiles?.[rule.profile] : undefined;
    const content = unique([...(profile?.content ?? []), ...(rule.content ?? [])],
        (item: SiteContentRule) => JSON.stringify([item.css, item.resolve ?? 'self', item.atomic ?? true, item.splitOnBr ?? false, item.key ?? '']));
    const result: SiteRecipe = {mode: rule.mode ?? profile?.mode ?? 'augment', content};
    for (const key of ['protect', 'exclude', 'watchIgnore', 'omit', 'literalLabels', 'literalTokens'] as const) {
        result[key] = [...new Set([...(profile?.[key] ?? []), ...(rule[key] ?? [])])];
    }
    return result;
}

/** 展开为可独立编辑的规则，不保留对原包模板的隐式依赖。 */
export function resolveSiteRule(pack: SiteRulePack, rule: SiteRule): SiteRule {
    const {profile: _profile, ...standalone} = rule;
    const recipe = resolveRecipe(pack, rule);
    const resolved: SiteRule = {...standalone, mode: recipe.mode};
    // JSON 的可选列表应省略空值，展开后的规则也能通过相同解析边界。
    for (const key of ['content', 'protect', 'exclude', 'watchIgnore', 'omit', 'literalLabels', 'literalTokens'] as const) {
        if (recipe[key]!.length) Object.assign(resolved, {[key]: recipe[key]});
        else delete resolved[key];
    }
    return JSON.parse(JSON.stringify(resolved)) as SiteRule;
}

/** 仅 * 具有特殊含义；其他字符按字面匹配，不构造用户提供的正则表达式。 */
function matchesPath(pathname: string, pattern: string): boolean {
    const parts = pattern.split('*');
    if (!pathname.startsWith(parts[0]!)) return false;
    if (parts.length === 1) return pathname === pattern;
    let offset = parts[0]!.length;
    for (let index = 1; index < parts.length - 1; index += 1) {
        const position = pathname.indexOf(parts[index]!, offset);
        if (position < 0) return false;
        offset = position + parts[index]!.length;
    }
    const suffix = parts[parts.length - 1]!;
    return pathname.length - suffix.length >= offset && pathname.endsWith(suffix);
}

function compileRule(pack: SiteRulePack, rule: SiteRule): TranslationSiteAdapter {
    const recipe = resolveRecipe(pack, rule);
    const adapter = createDeclarativeAdapter({
        id: rule.id,
        priority: rule.priority,
        hosts: rule.match.hosts.map((host) => host.startsWith('*.')
            ? {hostname: host.slice(2), includeSubdomains: true} : host),
        genericCandidatePolicy: recipe.mode === 'focus' ? 'targets-only' : 'allow',
        targets: recipe.content!.map((content) => ({
            selector: content.css, match: content.resolve, atomic: content.atomic, splitOnBr: content.splitOnBr,
            reason: content.key ?? `${rule.id}:content`,
        })),
        prune: [{selector: [...recipe.exclude!, ...recipe.omit!], reason: `${rule.id}:exclude`}],
        // 排除区域也必须进入文本保护，避免祖先候选的快照包含被裁剪子树。
        keepOriginal: [{selector: [...recipe.protect!, ...recipe.exclude!, ...recipe.omit!], reason: `${rule.id}:protect`}],
        omitFromTranslation: [{selector: recipe.omit!, reason: `${rule.id}:omit`}],
        mutationExclude: [{selector: recipe.watchIgnore!, reason: `${rule.id}:watch-ignore`}],
    });
    // 每个页面都会编译全部内置规则，但只有匹配当前 URL 的适配器会被 mutation 观察读取；
    // 选择器扫描延迟到首次读取，并缓存 null 这一“无法穷举属性”的合法结果。
    let observedAttributes: string[] | null | undefined;
    return {
        ...adapter,
        allScopes: rule.allScopes,
        get observedAttributes(): string[] | null {
            if (observedAttributes === undefined) observedAttributes = getSiteRuleObservedAttributes(recipe);
            return observedAttributes;
        },
        decide(element, context) {
            return isLiteralLabel(element, recipe.literalLabels!)
                ? {kind: 'prune-subtree', reason: `${rule.id}:literal-label`}
                : adapter.decide(element, context);
        },
        shouldStayOriginal(element, context) {
            return isLiteralLabel(element, recipe.literalLabels!) || isLiteralToken(element, recipe.literalTokens!)
                || adapter.shouldStayOriginal!(element, context);
        },
        shouldOmitFromTranslation(element, context) {
            return isLiteralLabel(element, recipe.literalLabels!) || adapter.shouldOmitFromTranslation!(element, context);
        },
        shouldIgnoreMutation(element, context) {
            return isLiteralLabel(element, recipe.literalLabels!) || adapter.shouldIgnoreMutation!(element, context);
        },
        matches(url: URL): boolean {
            return (url.protocol === 'https:' || url.protocol === 'http:') && adapter.matches(url)
                && (!rule.match.paths?.length || rule.match.paths.some((path) => matchesPath(url.pathname, path)))
                && !rule.match.excludePaths?.some((path) => matchesPath(url.pathname, path));
        },
    };
}

export function compileSiteRulePack(pack: SiteRulePack): TranslationSiteAdapter[] {
    return pack.rules.map((rule) => compileRule(pack, rule));
}

/** 用户同名规则整条替换，保留内置位置；新增规则按声明顺序追加。 */
export function composeSiteAdapters(builtinPack: SiteRulePack, settings: SiteAdaptationSettings): TranslationSiteAdapter[] {
    if (!settings.enabled) return [];
    const disabled = new Set(settings.disabledRuleIds);
    const adapters = new Map(compileSiteRulePack(builtinPack).map((adapter) => [adapter.id, adapter]));
    compileSiteRulePack(settings.custom).forEach((adapter) => adapters.set(adapter.id, adapter));
    return [...adapters.values()].filter((adapter) => !disabled.has(adapter.id));
}
