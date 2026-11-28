/**
 * @file src/services/site-adaptation/officialClient.ts
 * 文件职责：让扩展页面和内容脚本向后台读取已通过验证的官方规则发布。
 * 主要内容：在受信公钥已接入的扩展构建中请求当前发布，限制等候时间并提供空结果回退。
 * 模块边界：不下载远程数据，不接触签名私钥；规则的验证与存储由后台负责。
 */
import type {OfficialSiteRuleRelease} from '@/src/core/site-adaptation/officialRelease';

export const OFFICIAL_SITE_RULE_READ_MESSAGE = 'readOfficialSiteRuleRelease';
export const OFFICIAL_SITE_RULE_REFRESH_MESSAGE = 'refreshOfficialSiteRuleRelease';
export const officialSiteRulePublicKey = typeof import.meta.env.WXT_SITE_RULES_PUBLIC_KEY === 'string'
    ? import.meta.env.WXT_SITE_RULES_PUBLIC_KEY.trim()
    : '';
export const officialSiteRuleUpdatesEnabled = import.meta.env.BROWSER !== 'userscript' && Boolean(officialSiteRulePublicKey);

async function requestOfficialRelease(type: string, timeoutMs: number): Promise<OfficialSiteRuleRelease | null> {
    if (!officialSiteRuleUpdatesEnabled) return null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        const reply = await Promise.race([
            browser.runtime.sendMessage({type}) as Promise<OfficialSiteRuleRelease | null>,
            new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), timeoutMs); }),
        ]);
        return reply?.pack && Number.isSafeInteger(reply.revision) ? reply : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

export const readOfficialSiteRuleRelease = () => requestOfficialRelease(OFFICIAL_SITE_RULE_READ_MESSAGE, 1200);
export const refreshOfficialSiteRuleRelease = () => requestOfficialRelease(OFFICIAL_SITE_RULE_REFRESH_MESSAGE, 15_000);
