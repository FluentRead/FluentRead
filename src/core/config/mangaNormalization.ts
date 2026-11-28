/**
 * @file src/core/config/mangaNormalization.ts
 * 文件职责：归一化漫画阅读偏好的数值与用户网站规则，使完整配置读取无需初始化内置网站目录或阅读器匹配表。
 * 主要内容：保留提前翻译和快速缓存容量的原默认值与范围、总像素预算，以及用户规则的 URL、经标签及 IPv4 八位段校验的本机与局域网显式端口白名单、选择器、顺序、去重和二十项边界。
 * 模块边界：只定义类型与同步纯配置转换，不导入漫画目录、阅读器匹配或浏览器存储；真实用户规则仍在每次归一化时通过当前 URL 构造器校验。
 * 验证归属：现有 tests/mangaSites.test.ts 与漫画读取 owner 继续调用同一实现，本模块纳入 vitest.coverage.config.ts 的四维 100% 门禁。
 */
export interface MangaSiteRule {hostname: string; pathPrefix: string; selector: string}

const LOCAL_MANGA_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.local$/i;

/** 自托管漫画阅读器常运行在本机或内网自定义端口；仅允许回环、合法 IPv4 RFC1918 私有网段与合法 .local 主机携带显式端口。 */
export function isLocalMangaHost(hostname: string): boolean {
    if (hostname === 'localhost' || hostname === '[::1]') return true;
    if (LOCAL_MANGA_DOMAIN.test(hostname)) return true;
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
    if (!ipv4 || !ipv4.slice(1).every(part => Number(part) <= 255)) return false;
    const a = Number(ipv4[1]), b = Number(ipv4[2]);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** 旧配置默认提前三页；限制窗口，避免整章推理、内存和服务请求失控。 */
export function normalizeMangaPrefetchPages(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(5, Math.max(0, Math.floor(value))) : 3;
}

export function createMangaSiteRule(href: string, selector: string): MangaSiteRule | null {
    try {
        const url = new URL(href);
        const query = selector.trim();
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
            || (url.port && (!isLocalMangaHost(url.hostname) || url.port === '0'))
            || !query || query.length > 256 || query.includes(':has(')) return null;
        return {hostname: url.port ? url.host : url.hostname, pathPrefix: url.pathname, selector: query};
    } catch { return null; }
}

export function normalizeMangaSiteRules(value: unknown): MangaSiteRule[] {
    if (!Array.isArray(value)) return [];
    const result: MangaSiteRule[] = [];
    const seen = new Set<string>();
    for (const item of value.slice(0, 20)) {
        if (!item || typeof item !== 'object' || typeof item.hostname !== 'string'
            || typeof item.pathPrefix !== 'string' || !item.pathPrefix.startsWith('/')
            || typeof item.selector !== 'string') continue;
        const scheme = item.hostname.endsWith(':443') ? 'http' : 'https';
        const rule = createMangaSiteRule(`${scheme}://${item.hostname}${item.pathPrefix}`, item.selector);
        if (!rule || rule.hostname !== item.hostname || rule.pathPrefix !== item.pathPrefix) continue;
        const key = `${rule.hostname}${rule.pathPrefix}`;
        if (seen.has(key)) continue;
        seen.add(key); result.push(rule);
    }
    return result;
}

/** 正常页快速复用的容量；总像素预算另行约束超长、超大图片。 */
export function normalizeMangaCachePages(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(24, Math.floor(value))) : 12;
}
export function mangaCachePixelBudget(value: unknown): number {
    return normalizeMangaCachePages(value) * 2_000_000;
}
