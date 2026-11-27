/**
 * @file src/core/site-rules/subframeDomain.ts
 * 文件职责：为受限子 frame 内容脚本提供不依赖完整 Public Suffix 表（tldts）的轻量站点域名匹配实现。
 * 主要内容：保持与 core/site-rules/domain 相同的公开函数签名与语义；子 frame 消费的配置列表已由后台使用完整 tldts 规范化为可注册域名，本模块通过点对齐后缀匹配与主机名校验完成零额外数据表的 O(1) 判定。
 * 模块边界：仅通过构建插件替换受限子 frame 入口（youtubeEmbed、supportedFrame、neteaseMailFrame）中的 domain.ts；后台、顶层内容脚本与扩展设置页继续使用完整 tldts 实现。
 */

const SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/iu;
const HTTP_SCHEME_PATTERN = /^https?:/iu;
const HOST_PORT_PATTERN = /^(?:\[[^\]]+\]|[^/?#:@]+):\d+(?:[/?#]|$)/u;
const DNS_LABEL_PATTERN = /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/u;
const CLEAN_ASCII_HOSTNAME_PATTERN = /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}$/u;
const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/u;

export interface AutoTranslatePageConfig {
    on: boolean;
    autoTranslate: boolean;
    alwaysTranslateDomains: readonly string[];
    disabledExtensionDomains?: readonly string[];
}

export interface SiteTranslationDisplayConfig {
    display: number;
    translationOnlyDomains?: readonly string[];
}

function parseSiteUrl(input: string | URL): URL | null {
    if (input instanceof URL) {
        return input.protocol === 'http:' || input.protocol === 'https:' ? input : null;
    }
    if (typeof input !== 'string') return null;
    const value = input.trim();
    if (!value) return null;
    let candidate: string;
    if (HTTP_SCHEME_PATTERN.test(value)) {
        candidate = value;
    } else if (SCHEME_PATTERN.test(value) && !HOST_PORT_PATTERN.test(value)) {
        return null;
    } else {
        candidate = `https://${value}`;
    }
    try {
        return new URL(candidate);
    } catch {
        return null;
    }
}

function isIpHostname(hostname: string): boolean {
    if (hostname.startsWith('[') && hostname.endsWith(']')) return true;
    if (!IPV4_PATTERN.test(hostname)) return false;
    return hostname.split('.').every(part => Number(part) <= 255);
}

function isValidDnsHostname(hostname: string): boolean {
    if (hostname.length > 253) return false;
    return hostname.split('.').every(label =>
        label.length > 0 && label.length <= 63 && DNS_LABEL_PATTERN.test(label));
}

function extractNormalizedHostname(input: string | URL): string | null {
    if (typeof input === 'string' && input.length > 0 && input.length <= 253
        && CLEAN_ASCII_HOSTNAME_PATTERN.test(input)) {
        return input;
    }
    const url = parseSiteUrl(input);
    if (!url) return null;
    const hostname = url.hostname.toLowerCase().replace(/\.+$/u, '');
    if (!hostname || hostname.includes('*')) return null;
    if (isIpHostname(hostname)) return hostname;
    return isValidDnsHostname(hostname) ? hostname : null;
}

/** 后台已通过完整 tldts 将名单规范化为可注册域名；子 frame 侧只提取规范主机名用于点对齐匹配。 */
export function getSiteBaseDomain(input: string | URL): string | null {
    return extractNormalizedHostname(input);
}

export function normalizeSiteDomains(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const domains: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        if (typeof item !== 'string') continue;
        const domain = extractNormalizedHostname(item);
        if (!domain || seen.has(domain)) continue;
        seen.add(domain);
        domains.push(domain);
    }
    return domains;
}

export function normalizeAlwaysTranslateDomains(value: unknown): string[] {
    return normalizeSiteDomains(value);
}

export function normalizeDisabledExtensionDomains(value: unknown): string[] {
    return normalizeSiteDomains(value);
}

export function normalizeFloatingBallDisabledDomains(value: unknown): string[] {
    return normalizeSiteDomains(value);
}

function hostnameMatchesDomain(hostname: string, domain: string): boolean {
    if (hostname === domain) return true;
    if (isIpHostname(hostname) || isIpHostname(domain)) return false;
    return hostname.endsWith(`.${domain}`);
}

function isSiteInDomainList(input: string | URL, domains: unknown): boolean {
    if (!Array.isArray(domains) || domains.length === 0) return false;
    const hostname = extractNormalizedHostname(input);
    if (!hostname) return false;
    for (const item of domains) {
        if (typeof item !== 'string') continue;
        const normalized = extractNormalizedHostname(item);
        if (normalized && hostnameMatchesDomain(hostname, normalized)) return true;
    }
    return false;
}

export function isAlwaysTranslateSite(input: string | URL, domains: unknown): boolean {
    return isSiteInDomainList(input, domains);
}

export function isExtensionDisabledOnSite(input: string | URL, domains: unknown): boolean {
    return isSiteInDomainList(input, domains);
}

export function isFloatingBallDisabledOnSite(input: string | URL, domains: unknown): boolean {
    return isSiteInDomainList(input, domains);
}

export function resolveSiteTranslationDisplay(config: SiteTranslationDisplayConfig, input: string | URL): number {
    return config.translationOnlyDomains?.length && isSiteInDomainList(input, config.translationOnlyDomains)
        ? 0 : config.display;
}

export function shouldAutoTranslatePage(input: string | URL, config: AutoTranslatePageConfig): boolean {
    if (config.on !== true) return false;
    if (isExtensionDisabledOnSite(input, config.disabledExtensionDomains)) return false;
    if (config.autoTranslate === true) return true;
    return isAlwaysTranslateSite(input, config.alwaysTranslateDomains);
}

function createSubframeDomainIndex() {
    let entries: unknown[] = [];
    let domains = new Set<string>();
    return {
        update(value: unknown): void {
            const next = Array.isArray(value) ? value : [];
            if (next.length === entries.length) {
                let unchanged = true;
                for (let index = 0; index < next.length; index += 1) {
                    if (next[index] !== entries[index]) { unchanged = false; break; }
                }
                if (unchanged) return;
            }
            entries = next.slice();
            domains = new Set(normalizeSiteDomains(next));
        },
        isEmpty: () => domains.size === 0,
        matches(hostname: string | null): boolean {
            if (!hostname || domains.size === 0) return false;
            if (domains.has(hostname)) return true;
            if (isIpHostname(hostname)) return false;
            let dot = hostname.indexOf('.');
            while (dot >= 0) {
                const suffix = hostname.slice(dot + 1);
                if (domains.has(suffix)) return true;
                dot = hostname.indexOf('.', dot + 1);
            }
            return false;
        },
    };
}

export function createSiteRuleMatcher(initialConfig: AutoTranslatePageConfig) {
    const always = createSubframeDomainIndex();
    const disabled = createSubframeDomainIndex();
    let enabled = false;
    let automatic = false;
    let lastInput: string | undefined;
    let lastHostname: string | null = null;
    const resolveHost = (input: string | URL): string | null => {
        const key = input instanceof URL ? input.href : input;
        if (key !== lastInput) { lastInput = key; lastHostname = extractNormalizedHostname(input); }
        return lastHostname;
    };
    const update = (config: AutoTranslatePageConfig): void => {
        enabled = config.on === true;
        automatic = config.autoTranslate === true;
        always.update(config.alwaysTranslateDomains);
        disabled.update(config.disabledExtensionDomains);
    };
    const isExtensionDisabled = (input: string | URL): boolean => !disabled.isEmpty() && disabled.matches(resolveHost(input));
    update(initialConfig);
    return {
        update,
        isExtensionDisabled,
        shouldAutoTranslate: (input: string | URL): boolean => enabled && !isExtensionDisabled(input)
            && (automatic || (!always.isEmpty() && always.matches(resolveHost(input)))),
    };
}
