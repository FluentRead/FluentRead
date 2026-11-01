/**
 * @file src/core/site-adaptation/compiler.ts
 * 文件职责：将网站适配 JSON 编译为既有候选引擎使用的适配器，并组合内置与用户规则。
 * 主要内容：展开单层模板、匹配域名和路径并执行自定义整条覆盖；内置 Mastodon 发现应用外壳正文，man7 授予手册准备能力，BBC 保护纯署名图注，Facebook 核验帖子控件，X 保护 GIF 播放器标签；用户覆盖与停用会撤销内置能力。
 * 模块边界：仅匹配 URL 与声明内容边界，不注入脚本或样式，不监听页面生命周期。
 */

import {isLiteralLabel, isLiteralToken} from './literalLabel';
import {withBbcCreditCaptionProtection} from './bbcCreditCaption';
import {withXGifLabelProtection} from './xGifLabel';
import {withFacebookPublicPostDialogLabelProtection} from './facebookPublicPostDialogLabel';
import {withFacebookPublicPostReplySummaryProtection} from './facebookPublicPostReplySummary';
import {withFacebookPublicPostControlsProtection} from './facebookPublicPostControls';
import {createDeclarativeAdapter} from '@/src/core/translation/adapters/declarative';
import {hasContentEditableMarker, isHiddenTranslationElement} from '@/src/core/translation/dom';
import type {AdapterContext, TranslationSiteAdapter} from '@/src/core/translation/types';
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
    // 专站选择器必须先于宽泛的 profile 规则。两者都匹配同一正文节点时，
    // 由专站决定 atomic/splitOnBr，否则 profile 的 main p 会吞掉专站决策。
    const content = unique([...(rule.content ?? []), ...(profile?.content ?? [])],
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

/** 公开页实测结构的窄例外；不赋予 JSON 规则取消任意 no-translate 保护的能力。 */
function* discoverMastodonApplicationShellTargets(root: Node, {url}: AdapterContext): Iterable<Element> {
    if (url.hostname !== 'mastodon.social' || !/^\/@[^/]+(?:\/\d+)?\/?$/u.test(url.pathname)) return;
    const document = root.nodeType === 9 ? root as Document : root.ownerDocument;
    const shell = document?.getElementById('mastodon');
    const validShell = () => Boolean(shell && shell.id === 'mastodon' && shell.parentElement === document?.body &&
        shell.matches('div.app-holder.notranslate') && shell.getAttribute('translate')?.toLowerCase() !== 'no' &&
        shell.getAttribute('data-notranslate') !== 'true' && !hasContentEditableMarker(shell) &&
        !isHiddenTranslationElement(shell));
    if (!validShell() || !shell || (!root.contains(shell) && !shell.contains(root))) return;
    // 已通过 light-DOM 包含关系；外壳内的非元素节点必有元素父级。
    const scanRoot = root.contains(shell) ? shell : root.nodeType === 1 ? root as Element : root.parentElement!;
    const closestParagraph = scanRoot.closest('p');
    const paragraphs = closestParagraph ? [closestParagraph] : scanRoot.querySelectorAll('p');
    for (const paragraph of paragraphs) {
        // 生成器让出后重新读取外壳，不能把刚被宿主移动或重新保护的节点继续放行。
        if (!validShell()) return;
        if (shell.contains(paragraph) && paragraph.matches('.status__content .status__content__text.translate p') &&
            !paragraph.closest('form, nav, aside, header, footer, [role="navigation"], [role="banner"], [role="complementary"]')) {
            yield paragraph;
        }
    }
}

/** 用户同名规则整条替换，保留内置位置；新增规则按声明顺序追加。 */
export function composeSiteAdapters(builtinPack: SiteRulePack, settings: SiteAdaptationSettings): TranslationSiteAdapter[] {
    if (!settings.enabled) return [];
    const disabled = new Set(settings.disabledRuleIds);
    const adapters = new Map(compileSiteRulePack(builtinPack).map((adapter) => [adapter.id, adapter]));
    const mastodon = adapters.get('mastodon');
    if (mastodon) mastodon.discoverApplicationShellTargets = discoverMastodonApplicationShellTargets;
    const manpage = adapters.get('man7');
    if (manpage) manpage.preformattedProse = 'manpage';
    const bbc = adapters.get('bbc-news');
    if (bbc) adapters.set('bbc-news', withBbcCreditCaptionProtection(bbc));
    const x = adapters.get('x');
    if (x) adapters.set('x', withXGifLabelProtection(x));
    const facebook = adapters.get('facebook-public-post');
    if (facebook) adapters.set('facebook-public-post', withFacebookPublicPostControlsProtection(
        withFacebookPublicPostReplySummaryProtection(withFacebookPublicPostDialogLabelProtection(facebook))));
    compileSiteRulePack(settings.custom).forEach((adapter) => adapters.set(adapter.id, adapter));
    return [...adapters.values()].filter((adapter) => !disabled.has(adapter.id));
}
