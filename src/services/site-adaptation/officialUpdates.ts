/**
 * @file src/services/site-adaptation/officialUpdates.ts
 * 文件职责：下载和保存最近一次通过校验的官方站点规则发布。
 * 主要内容：从固定 HTTPS 端点限量读取，验证签名、版本和发布序号，合并同时发生的更新请求。
 * 模块边界：由后台提供网络与存储端口，失败时返回此前已验证的发布，由消费方决定如何应用规则。
 */
import {
    OFFICIAL_SITE_RULE_ENVELOPE_MAX_BYTES,
    verifyOfficialSiteRuleRelease,
    type OfficialSiteRuleRelease,
} from '@/src/core/site-adaptation/officialRelease';

const OFFICIAL_SITE_RULES_URL = 'https://read.thinkstu.com/site-rules/v1/official.json';
const DOWNLOAD_TIMEOUT_MS = 12_000;

interface OfficialSiteRuleUpdatePorts {
    trustedPublicKey: string;
    extensionVersion: string;
    readCachedEnvelope(): Promise<unknown>;
    writeCachedEnvelope(envelope: string): Promise<void>;
    fetch: typeof globalThis.fetch;
}

async function readBoundedEnvelope(response: Response): Promise<string | null> {
    if (!response.body) return null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let bytes = 0;
    let document = '';
    try {
        if (Number(response.headers.get('content-length')) > OFFICIAL_SITE_RULE_ENVELOPE_MAX_BYTES) {
            await reader.cancel();
            return null;
        }
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) return document + decoder.decode();
            bytes += chunk.value.byteLength;
            if (bytes > OFFICIAL_SITE_RULE_ENVELOPE_MAX_BYTES) {
                await reader.cancel();
                return null;
            }
            document += decoder.decode(chunk.value, {stream: true});
        }
    } catch {
        await reader.cancel().catch(() => undefined);
        return null;
    } finally {
        reader.releaseLock();
    }
}

export function createOfficialSiteRuleUpdates(ports: OfficialSiteRuleUpdatePorts) {
    let current: Promise<OfficialSiteRuleRelease | null> | undefined;
    let inFlight: Promise<OfficialSiteRuleRelease | null> | undefined;
    const verify = (envelope: unknown) => typeof envelope === 'string'
        ? verifyOfficialSiteRuleRelease(envelope, ports.trustedPublicKey, ports.extensionVersion) : null;

    const readCurrent = (): Promise<OfficialSiteRuleRelease | null> => current ??= (
        ports.trustedPublicKey
            ? Promise.resolve().then(ports.readCachedEnvelope).then(verify).catch(() => null)
            : Promise.resolve(null)
    );

    const update = async (): Promise<OfficialSiteRuleRelease | null> => {
        const previous = await readCurrent();
        if (!ports.trustedPublicKey) return previous;
        try {
            const response = await ports.fetch(OFFICIAL_SITE_RULES_URL, {
                method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store',
                referrerPolicy: 'no-referrer', headers: {Accept: 'application/json'},
                signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
            });
            if (!response.ok || response.redirected) {
                await response.body?.cancel();
                return previous;
            }
            const envelope = await readBoundedEnvelope(response);
            const next = await verify(envelope);
            if (!envelope || !next || (previous && next.revision <= previous.revision)) return previous;
            await ports.writeCachedEnvelope(envelope);
            current = Promise.resolve(next);
            return next;
        } catch {
            // 临时网络、解析或存储故障不替换最后一次通过验证的发布。
            return previous;
        }
    };

    return {
        readCurrent,
        refresh: () => inFlight ??= update().finally(() => { inFlight = undefined; }),
    };
}
