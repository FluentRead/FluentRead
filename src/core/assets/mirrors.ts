/**
 * @file src/core/assets/mirrors.ts
 * 文件职责：为扩展按需下载的固定版本纯数据资产构造国内外多镜像冗余来源与会话级优选排序。
 * 主要内容：提供 npm 锁定版本与 GitHub 固定提交的四路镜像链接（国内 jsdmirror、onmicrosoft 与海外 jsDelivr、GitHub Raw/unpkg），按界面语言给出默认尝试顺序，并在会话内记住最近成功的镜像源以减少重复超时。
 * 模块边界：本文件属于 core 纯规则层，只处理不可变资产 URL 构造与会话内来源排序，不发起网络请求、不访问存储、不加载任何可执行脚本或 WASM。
 */

const CHINA_LOCALE_PATTERN = /^zh(?:$|-CN|-Hans)/iu;
const DEFAULT_DEMOTE_COOLDOWN_MS = 5 * 60_000;
const MAX_TRACKED_ORIGINS = 16;

const preferredOrigins: string[] = [];
const demotedOrigins = new Map<string, number>();

function normalizeRelativePath(value: string): string {
    return value.replace(/^\/+/u, '');
}

function encodePathSegments(relativePath: string): string {
    return normalizeRelativePath(relativePath)
        .split('/')
        .map(segment => encodeURIComponent(segment))
        .join('/');
}

/** 根据语言偏好返回中国大陆优先或全球优先的镜像列表。 */
export function isChinaPreferredLocale(locale: string | undefined): boolean {
    return Boolean(locale && CHINA_LOCALE_PATTERN.test(locale.trim()));
}

/** 读取当前运行时语言偏好；无 navigator 环境默认回退简体中文。 */
export function detectPreferredMirrorLocale(): string {
    return typeof navigator === 'undefined' ? 'zh-CN' : navigator.language;
}

/** 构造 GitHub 固定提交纯数据文件的国内 + 海外四路冗余镜像地址。 */
export function buildGithubAssetMirrorUrls(
    repository: string,
    revision: string,
    relativePath: string,
    locale?: string,
): readonly string[] {
    const encodedPath = encodePathSegments(relativePath);
    const ghSpec = `${repository}@${revision}/${encodedPath}`;
    const china = [
        `https://cdn.jsdmirror.com/gh/${ghSpec}`,
        `https://jsd.onmicrosoft.cn/gh/${ghSpec}`,
    ];
    const global = [
        `https://cdn.jsdelivr.net/gh/${ghSpec}`,
        `https://raw.githubusercontent.com/${repository}/${revision}/${encodedPath}`,
    ];
    return isChinaPreferredLocale(locale) ? [...china, ...global] : [...global, ...china];
}

/** 构造 npm 锁定版本纯数据文件的国内 + 海外四路冗余镜像地址。 */
export function buildNpmAssetMirrorUrls(
    packageName: string,
    version: string,
    relativePath: string,
    locale?: string,
): readonly string[] {
    const encodedPath = encodePathSegments(relativePath);
    const npmSpec = `${packageName}@${version}/${encodedPath}`;
    const china = [
        `https://cdn.jsdmirror.com/npm/${npmSpec}`,
        `https://jsd.onmicrosoft.cn/npm/${npmSpec}`,
    ];
    const global = [
        `https://cdn.jsdelivr.net/npm/${npmSpec}`,
        `https://unpkg.com/${npmSpec}`,
    ];
    return isChinaPreferredLocale(locale) ? [...china, ...global] : [...global, ...china];
}

/** 记录本会话中校验通过的镜像源，让后续同源资产优先命中可用节点以降低首包延迟。 */
export function rememberPreferredMirrorOrigin(url: string): void {
    try {
        const origin = new URL(url).origin;
        demotedOrigins.delete(origin);
        const existingIndex = preferredOrigins.indexOf(origin);
        if (existingIndex === 0) return;
        if (existingIndex > 0) preferredOrigins.splice(existingIndex, 1);
        preferredOrigins.unshift(origin);
        if (preferredOrigins.length > 8) preferredOrigins.length = 8;
    } catch {
        // 无效地址忽略，不污染优选表。
    }
}

/** 暂时降权近期连续失败或超时的镜像源，避免多文件下载反复在同一失效源上等待超时。 */
export function demoteMirrorOrigin(url: string, cooldownMs = DEFAULT_DEMOTE_COOLDOWN_MS): void {
    try {
        const origin = new URL(url).origin;
        const existingIndex = preferredOrigins.indexOf(origin);
        if (existingIndex >= 0) preferredOrigins.splice(existingIndex, 1);
        demotedOrigins.delete(origin);
        demotedOrigins.set(origin, Date.now() + cooldownMs);
        while (demotedOrigins.size > MAX_TRACKED_ORIGINS) {
            const oldest = demotedOrigins.keys().next().value!;
            demotedOrigins.delete(oldest);
        }
    } catch {
        // 无效地址忽略，不污染降权表。
    }
}

/** 按会话内最近成功的镜像源提前排序、近期失败源后置，同时保留全部候选源与同优先级原始顺序。 */
export function orderMirrorUrls(urls: readonly string[]): string[] {
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const url of urls) {
        if (!seen.has(url)) {
            seen.add(url);
            unique.push(url);
        }
    }
    if ((preferredOrigins.length === 0 && demotedOrigins.size === 0) || unique.length <= 1) return unique;
    const now = Date.now();
    for (const [origin, until] of demotedOrigins) {
        if (until <= now) demotedOrigins.delete(origin);
    }
    const rank = (url: string): number => {
        try {
            const origin = new URL(url).origin;
            const preferredIndex = preferredOrigins.indexOf(origin);
            if (preferredIndex >= 0) return preferredIndex;
            if (demotedOrigins.has(origin)) return preferredOrigins.length + 1;
            return preferredOrigins.length;
        } catch {
            return preferredOrigins.length;
        }
    };
    return unique
        .map((url, index) => ({url, index, priority: rank(url)}))
        .sort((left, right) => left.priority - right.priority || left.index - right.index)
        .map(item => item.url);
}

/** 仅供测试重置会话级镜像优选与降权状态。 */
export function resetPreferredMirrorOrigins(): void {
    preferredOrigins.length = 0;
    demotedOrigins.clear();
}
