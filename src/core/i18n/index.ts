/**
 * @file src/core/i18n/index.ts
 *
 * 文件职责：提供与 UI 框架无关的界面语言注册表、归一化和翻译函数。
 * 主要内容：内置简体中文默认目录；English、日本語、한국어、Français、Русский 与 Español 以资源包形式注册，
 * 仅匹配字典自身登记项，支持稳定 key 参数插值、中文旧文案迁移适配、按语言惰性建立的旧文案反查表，以及资源包携带的旧文案模板的惰性编译。
 * 旧文案适配仅用于扩展自己的 UI，不会翻译网页内容或用户输入。
 * 模块边界：本文件不读写 browser.storage、不发起资源请求，也不依赖 Vue；非中文资源包由 bundles.ts 静态汇总
 * （构建期生成、userscript 与测试使用）或由 platform/i18n 在扩展运行时按需加载后注册。
 */

import {zhCNMessages} from './messages/zh-CN';
import {normalizeUiLanguage} from './language';
import type {
    LegacyPatternEntry,
    MessageCatalog,
    RegisteredUiLanguage,
    TranslationParams,
    UiLanguage,
    UiLanguageBundle,
} from './types';

export * from './types';
export * from './language';

const defaultMessages: MessageCatalog = zhCNMessages;
const registeredBundles = new Map<UiLanguage, UiLanguageBundle>();
/** 中文稳定资源也可供旧模板精确复用；反查表只在该语言首次使用旧文案时建立一次。 */
const messageLegacyCatalogs = new Map<UiLanguage, MessageCatalog>();
const pluralRules = new Map<UiLanguage, Intl.PluralRules>();

/** 注册一种非中文界面语言的资源包；重复注册会替换旧包并丢弃基于旧包建立的反查表。 */
export function registerUiLanguageBundle(language: RegisteredUiLanguage, bundle: UiLanguageBundle): void {
    registeredBundles.set(language, bundle);
    messageLegacyCatalogs.delete(language);
    compiledLegacyPatterns.delete(language);
}

/** 中文目录始终内置；其他语言只有注册后才会返回本地化结果，未注册时回退中文。 */
export function hasUiLanguageBundle(language: UiLanguage): boolean {
    return language === 'zh-CN' || registeredBundles.has(language);
}

/** 资源字典只匹配自身条目，避免 constructor 等普通文本命中 Object 原型。 */
function ownMessage(catalog: MessageCatalog | undefined, key: string): string | undefined {
    return catalog && Object.hasOwn(catalog, key) ? catalog[key] : undefined;
}

function getMessageLegacyCatalog(language: UiLanguage, bundle: UiLanguageBundle): MessageCatalog {
    let catalog = messageLegacyCatalogs.get(language);
    if (!catalog) {
        const built = Object.create(null) as Record<string, string>;
        for (const key of Object.keys(defaultMessages)) {
            const source = defaultMessages[key]!;
            built[source] = ownMessage(bundle.messages, key) ?? source;
        }
        catalog = built;
        messageLegacyCatalogs.set(language, catalog);
    }
    return catalog;
}

function formatMessage(template: string, params?: TranslationParams): string {
    if (!params || !template.includes('{')) return template;
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (placeholder, name: string) => {
        const value = Object.hasOwn(params, name) ? params[name] : undefined;
        return value === undefined || value === null ? placeholder : String(value);
    });
}

/** 翻译稳定资源 key；当前语言缺失或资源包尚未加载时回退到中文，再缺失时返回 key 便于发现漏翻。 */
export function translate(key: string, language: UiLanguage, params?: TranslationParams): string {
    const count = params && Object.hasOwn(params, 'count') ? params.count : undefined;
    let category: Intl.LDMLPluralRule | undefined;
    if (typeof count === 'number' && Number.isFinite(count)) {
        const locale = normalizeUiLanguage(language);
        let rules = pluralRules.get(locale);
        if (!rules) {
            rules = new Intl.PluralRules(locale);
            pluralRules.set(locale, rules);
        }
        category = rules.select(count);
    }
    const message = (catalog: MessageCatalog | undefined): string | undefined => (
        category === undefined ? undefined : ownMessage(catalog, `${key}.plural.${category}`)
            ?? ownMessage(catalog, `${key}.plural.other`)
    ) ?? ownMessage(catalog, key);
    const template = message(registeredBundles.get(language)?.messages) ?? message(defaultMessages) ?? key;
    return formatMessage(template, params);
}

function preserveWhitespace(value: string, trimmed: string, translated: string): string {
    if (value.length === trimmed.length) return translated;
    const leading = value.match(/^\s*/u)![0];
    const trailing = value.match(/\s*$/u)![0];
    // Only nonblank source text reaches this helper; both zero-or-more patterns always match.
    return `${leading}${translated}${trailing}`;
}

interface CompiledLegacyPattern {
    readonly pattern: RegExp;
    readonly template: string;
    readonly localizedCaptures: readonly number[];
}

interface CompiledLegacyPatternSet {
    readonly early: readonly CompiledLegacyPattern[];
    readonly late: readonly CompiledLegacyPattern[];
}

const LEGACY_CLAUSE_SEPARATORS: Readonly<Record<UiLanguage, string>> = {
    'zh-CN': '；',
    'zh-TW': '；',
    'ja-JP': '；',
    'en-US': '; ',
    'ko-KR': '; ',
    'ru-RU': '; ',
    'es-ES': '; ',
    'fr-FR': ' ; ',
};

/** 资源包只携带正则源码；每种语言首次命中旧文案时编译一次，重复注册资源包时丢弃。 */
const compiledLegacyPatterns = new Map<UiLanguage, CompiledLegacyPatternSet>();

function compileLegacyPatterns(entries: readonly LegacyPatternEntry[]): CompiledLegacyPattern[] {
    const compiled: CompiledLegacyPattern[] = [];
    for (const [source, template, localizedCaptures = []] of entries) {
        try {
            compiled.push({pattern: new RegExp(source, 'u'), template, localizedCaptures});
        } catch {
            // 资源包来自构建产物；单条损坏的模板只让对应文案保持原文，不能中断整个界面。
        }
    }
    return compiled;
}

function getCompiledLegacyPatterns(language: UiLanguage, bundle: UiLanguageBundle): CompiledLegacyPatternSet {
    let compiled = compiledLegacyPatterns.get(language);
    if (!compiled) {
        compiled = {
            early: compileLegacyPatterns(bundle.legacyPatterns.early),
            late: compileLegacyPatterns(bundle.legacyPatterns.late),
        };
        compiledLegacyPatterns.set(language, compiled);
    }
    return compiled;
}

function getExactLegacyText(value: string, language: UiLanguage): string | undefined {
    const bundle = registeredBundles.get(language);
    return bundle && (ownMessage(bundle.legacyText, value) ?? ownMessage(getMessageLegacyCatalog(language, bundle), value));
}

const LEGACY_PLACEHOLDER_PATTERN = /\{(\d+)\}/gu;

function* applyLegacyPatterns(patterns: readonly CompiledLegacyPattern[], value: string, language: UiLanguage): Generator<string, string | undefined, string> {
    for (const {pattern, template, localizedCaptures} of patterns) {
        const match = pattern.exec(value);
        if (!match) continue;
        if (!template.includes('{')) return template;
        let translated = '';
        let cursor = 0;
        for (const placeholder of template.matchAll(LEGACY_PLACEHOLDER_PATTERN)) {
            const capture = match[Number(placeholder[1])] ?? '';
            translated += template.slice(cursor, placeholder.index);
            cursor = placeholder.index + placeholder[0].length;
            if (!localizedCaptures.includes(Number(placeholder[1])) || capture.trim() === value) {
                // 损坏资源若把完整匹配声明为嵌套捕获，保持原捕获，不能无限自我翻译。
                translated += capture;
                continue;
            }
            // 嵌套错误可能用中文分号串联多段原因；整句已登记时直接使用，否则逐段翻译并换成目标语言的分号写法。
            if (!capture.includes('；') || getExactLegacyText(capture, language) !== undefined) translated += yield capture;
            else {
                const clauses: string[] = [];
                for (const part of capture.split('；')) clauses.push(yield part);
                translated += clauses.join(LEGACY_CLAUSE_SEPARATORS[language]);
            }
        }
        return translated + template.slice(cursor);
    }
    return undefined;
}

/**
 * 将尚未完成 key 化的扩展 UI 文案翻译成所选界面语言。
 *
 * 这个适配器是有边界的迁移工具：调用方必须只把扩展自己的文本节点/属性传入，
 * 并且 UI directive 会跳过 textarea、pre、code 和用户内容，避免误伤网页正文或译文。
 */
export function translateLegacyText(value: string, language: UiLanguage): string {
    if (language === 'zh-CN' || !value.trim()) return value;
    const bundle = registeredBundles.get(language);
    if (!bundle) return value;
    function* evaluate(text: string): Generator<string, string, string> {
        if (!text.trim()) return text;
        const trimmed = text.trim();
        const exact = getExactLegacyText(trimmed, language);
        if (exact) return preserveWhitespace(text, trimmed, exact);
        const patterns = getCompiledLegacyPatterns(language, bundle!);
        const dynamic = yield* applyLegacyPatterns(patterns.early, trimmed, language);
        if (dynamic !== undefined) return preserveWhitespace(text, trimmed, dynamic);
        for (const separator of [' · ', ' → ']) {
            const compound = trimmed.split(separator);
            if (compound.length <= 1) continue;
            const translatedParts: string[] = [];
            for (const part of compound) translatedParts.push(yield part);
            const translatedCompound = translatedParts.join(separator);
            if (translatedCompound !== trimmed) return preserveWhitespace(text, trimmed, translatedCompound);
        }
        // 复合状态先于 late 兜底；子句逐次交给显式工作栈，保留深嵌套语义而不增长 JS 调用栈。
        const fallback = yield* applyLegacyPatterns(patterns.late, trimmed, language);
        return fallback === undefined ? text : preserveWhitespace(text, trimmed, fallback);
    }
    const pending = [evaluate(value)];
    let result: string | undefined;
    while (pending.length) {
        const step = pending[pending.length - 1].next(result ?? '');
        result = undefined;
        if (step.done) {result = step.value; pending.pop();}
        else pending.push(evaluate(step.value));
    }
    // The root generator always completes with a string before the work stack becomes empty.
    return result!;
}
