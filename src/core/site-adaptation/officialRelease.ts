/**
 * @file src/core/site-adaptation/officialRelease.ts
 * 文件职责：验证官方网站规则发布的签名、扩展版本门槛及规则数据结构。
 * 主要内容：按既有站点规则包格式解析已验证的载荷，限制信封与载荷大小并返回发布序号。
 * 模块边界：不发起下载、不选择更新来源、不读取存储。调用方提供受信公钥及当前扩展版本。
 */
import {parseSiteRulePack, SITE_RULE_LIMITS} from './schema';
import type {SiteRulePack} from './types';

export const OFFICIAL_SITE_RULE_RELEASE_FORMAT = 1;
export const OFFICIAL_SITE_RULE_ENVELOPE_MAX_BYTES = SITE_RULE_LIMITS.bytes * 2 + 512;
const SIGNING_CONTEXT = 'FluentRead official site rules v1\n';

export interface OfficialSiteRuleRelease {
    revision: number;
    minimumVersion: string;
    pack: SiteRulePack;
}

function readRecord(json: string): Record<string, unknown> | null {
    try {
        const value: unknown = JSON.parse(json);
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

function readBase64(value: unknown, maxLength: number): Uint8Array<ArrayBuffer> | null {
    if (typeof value !== 'string' || !value.length || value.length > maxLength
        || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return null;
    const decoded = atob(value);
    // 拒绝不同编码指向相同字节的非规范表示。
    return btoa(decoded) === value ? Uint8Array.from(decoded, character => character.charCodeAt(0)) : null;
}

function isCompatibleVersion(current: string, minimum: string): boolean {
    const versionPattern = /^\d{1,5}(?:\.\d{1,5}){1,3}$/u;
    if (!versionPattern.test(current) || !versionPattern.test(minimum)) return false;
    const running = current.split('.').map(Number);
    const required = minimum.split('.').map(Number);
    for (let index = 0; index < 4; index++) {
        const difference = (running[index] ?? 0) - (required[index] ?? 0);
        if (difference !== 0) return difference > 0;
    }
    return true;
}

function readRelease(payload: string, extensionVersion: string): OfficialSiteRuleRelease | null {
    const release = readRecord(payload);
    if (!release || Object.keys(release).length !== 3) return null;
    const {revision, minimumVersion, pack} = release;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1
        || typeof minimumVersion !== 'string' || !isCompatibleVersion(extensionVersion, minimumVersion)) return null;
    const parsed = parseSiteRulePack(pack);
    return parsed.ok ? {revision, minimumVersion, pack: parsed.pack} : null;
}

/** 先验证原始载荷，再将数据交给已有站点规则解析器。任一校验失败时调用方保留原有规则。 */
export async function verifyOfficialSiteRuleRelease(
    envelope: string,
    trustedPublicKey: string,
    extensionVersion: string,
    subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle,
): Promise<OfficialSiteRuleRelease | null> {
    if (!subtle || !trustedPublicKey || envelope.length > OFFICIAL_SITE_RULE_ENVELOPE_MAX_BYTES) return null;
    const encoder = new TextEncoder();
    if (encoder.encode(envelope).byteLength > OFFICIAL_SITE_RULE_ENVELOPE_MAX_BYTES) return null;
    const fields = readRecord(envelope);
    if (!fields || Object.keys(fields).length !== 3 || fields.format !== OFFICIAL_SITE_RULE_RELEASE_FORMAT
        || typeof fields.payload !== 'string' || fields.payload.length > SITE_RULE_LIMITS.bytes
        || encoder.encode(fields.payload).byteLength > SITE_RULE_LIMITS.bytes) return null;
    const signature = readBase64(fields.signature, 88);
    const publicKey = readBase64(trustedPublicKey, 256);
    if (signature?.byteLength !== 64 || !publicKey) return null;
    try {
        const key = await subtle.importKey('spki', publicKey, {name: 'ECDSA', namedCurve: 'P-256'}, false, ['verify']);
        const verified = await subtle.verify({name: 'ECDSA', hash: 'SHA-256'}, key, signature, encoder.encode(SIGNING_CONTEXT + fields.payload));
        return verified ? readRelease(fields.payload, extensionVersion) : null;
    } catch {
        return null;
    }
}
