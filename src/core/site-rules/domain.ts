/**
 * @file src/core/site-rules/domain.ts
 *
 * 文件职责：实现站点规则所需的域名规范化、eTLD+1 匹配和自动翻译决策，统一处理 URL、主机名与配置列表。
 * 主要内容：基于 tldts 解析基础域，清洗始终翻译和禁用站点列表，计算当前页自动翻译状态与上下文菜单展示，同时拒绝非 HTTP 或无效域名输入。 可核对的公开符号包括 AutoTranslatePageConfig、FullPageContextMenuPresentation、getSiteBaseDomain、normalizeSiteDomains、normalizeAlwaysTranslateDomains、normalizeDisabledExtensionDomains、isAlwaysTranslateSite、isExtensionDisabledOnSite。
 * 模块边界：本文件属于 core 领域层，只定义规则、类型与纯转换；不直接读写浏览器存储、不发起网络请求、不挂载 Vue/WXT 入口，持久化、协议调用和界面编排分别由 services、providers 与 features 承担。
 */

import { getDomain, parse } from 'tldts';

const DOMAIN_PARSE_OPTIONS = {
    allowPrivateDomains: true,
    extractHostname: false,
} as const;

const SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/iu;
const HTTP_SCHEME_PATTERN = /^https?:/iu;
const HOST_PORT_PATTERN = /^(?:\[[^\]]+\]|[^/?#:@]+):\d+(?:[/?#]|$)/u;
const DNS_LABEL_PATTERN = /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/u;

export interface AutoTranslatePageConfig {
    on: boolean;
    autoTranslate: boolean;
    alwaysTranslateDomains: readonly string[];
    disabledExtensionDomains?: readonly string[];
}

export interface FullPageContextMenuPresentation {
    enabled: boolean;
    title: string;
}

function parseSiteUrl(input: string | URL): URL | null {
    if (input instanceof URL) {
        return input.protocol === 'http:' || input.protocol === 'https:'
            ? new URL(input.href)
            : null;
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
        const url = new URL(candidate);
        return url;
    } catch {
        return null;
    }
}

function normalizeHostname(url: URL): string | null {
    const hostname = url.hostname.toLowerCase().replace(/\.+$/u, '');
    return hostname && !hostname.includes('*') ? hostname : null;
}

function isValidDnsHostname(hostname: string): boolean {
    if (hostname.length > 253) return false;
    return hostname.split('.').every((label) =>
        label.length > 0 && label.length <= 63 && DNS_LABEL_PATTERN.test(label));
}

/**
 * 将网页 URL 或裸域名归一化为可注册域名（eTLD+1）。
 * localhost、单标签主机和 IP 没有可注册域名，保留精确 hostname。
 */
export function getSiteBaseDomain(input: string | URL): string | null {
    const url = parseSiteUrl(input);
    if (!url) return null;

    const hostname = normalizeHostname(url);
    if (!hostname) return null;

    const registrableDomain = getDomain(hostname, DOMAIN_PARSE_OPTIONS);
    if (registrableDomain && isValidDnsHostname(hostname)) {
        return registrableDomain.toLowerCase();
    }

    const parsed = parse(hostname, DOMAIN_PARSE_OPTIONS);
    if (parsed.isIp) return hostname;
    if (!hostname.includes('.')
        && parsed.isIcann !== true
        && parsed.isPrivate !== true
        && isValidDnsHostname(hostname)) {
        return hostname;
    }

    // 纯 public suffix（例如 com、co.uk、github.io）和非法主机名不能成为规则。
    return null;
}

/** 将存储或导入值转换为稳定、有序且去重的可注册域名列表。 */
export function normalizeSiteDomains(value: unknown): string[] {
    if (!Array.isArray(value)) return [];

    const domains: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        if (typeof item !== 'string') continue;
        const domain = getSiteBaseDomain(item);
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

function isSiteInDomainList(input: string | URL, domains: unknown): boolean {
    const currentDomain = getSiteBaseDomain(input);
    if (!currentDomain) return false;
    return normalizeSiteDomains(domains).includes(currentDomain);
}

export function isAlwaysTranslateSite(
    input: string | URL,
    domains: unknown,
): boolean {
    return isSiteInDomainList(input, domains);
}

export function isExtensionDisabledOnSite(
    input: string | URL,
    domains: unknown,
): boolean {
    return isSiteInDomainList(input, domains);
}

/** 悬浮球按网站名单隐藏；扩展其余能力仍然可用。 */
export function isFloatingBallDisabledOnSite(
    input: string | URL,
    domains: unknown,
): boolean {
    return isSiteInDomainList(input, domains);
}

export function shouldAutoTranslatePage(
    input: string | URL,
    config: AutoTranslatePageConfig,
): boolean {
    if (config.on !== true) return false;
    if (isExtensionDisabledOnSite(input, config.disabledExtensionDomains)) return false;
    // 保留旧的全局自动翻译语义：只要内容脚本能在该页面运行，全局开关
    // 就应生效。HTTP(S) 与可注册域名限制只属于新增的网站名单。
    if (config.autoTranslate === true) return true;
    return isAlwaysTranslateSite(input, config.alwaysTranslateDomains);
}

/** 让右键菜单的可用性与当前站点生命周期状态保持一致。 */
export function getFullPageContextMenuPresentation(
    isTranslated: boolean,
    isSiteDisabled: boolean,
): FullPageContextMenuPresentation {
    if (isSiteDisabled) {
        return {enabled: false, title: '流畅阅读（当前网站已禁用）'};
    }
    return {
        enabled: true,
        title: isTranslated ? '流畅阅读取消翻译' : '流畅阅读翻译',
    };
}
