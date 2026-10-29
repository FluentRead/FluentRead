/**
 * @file src/core/config/credentials.ts
 *
 * 文件职责：定义配置中的敏感凭据边界，并提供从完整配置提取、解析、比较和清除凭据的纯函数。
 * 主要内容：列出敏感字段和专用存储契约，只提取自有凭据字段；使用迭代复制清洗深层对象、循环及重复引用，网站与局部区域规则按专用结构校验且移除未知字段，并按内容比较凭据，避免对象键顺序导致重复保存。
 * 模块边界：本文件属于 core 领域层，只定义规则、类型与纯转换；不直接读写浏览器存储、不发起网络请求、不挂载 Vue/WXT 入口，持久化、协议调用和界面编排分别由 services、providers 与 features 承担。
 */

import type { Config } from './model';
import {normalizeNativeAsrBaseUrl} from './nativeAsr';
import {isSensitiveConfigKey} from './sensitiveKeys';
import {normalizeApiKeys} from './apiKeys';
import {normalizeSiteAdaptationSettings} from '@/src/core/site-adaptation/schema';
import {normalizeSectionTranslationRules} from './sectionTranslationRules';

export {isSensitiveConfigKey} from './sensitiveKeys';

export const SESSION_CREDENTIALS_STORAGE_KEY = 'session:credentials' as const;
export const LOCAL_CREDENTIALS_STORAGE_KEY = 'local:credentials' as const;
export const CREDENTIALS_SCHEMA_VERSION = 1 as const;

export const CONFIG_CREDENTIAL_FIELDS = [
    'token',
    'apiKeys',
    'secret',
    'customHeaders',
    'ak',
    'sk',
    'appid',
    'key',
    'youdaoAppKey',
    'youdaoAppSecret',
    'tencentSecretId',
    'tencentSecretKey',
    'extra',
] as const;

export type ConfigCredentialField = typeof CONFIG_CREDENTIAL_FIELDS[number];
export type PublicConfig = Omit<Config, ConfigCredentialField>;

export interface ConfigCredentials {
    schemaVersion: typeof CREDENTIALS_SCHEMA_VERSION;
    token: Record<string, string>;
    apiKeys: Record<string, string[]>;
    secret: Record<string, string>;
    customHeaders: Record<string, string>;
    ak: string;
    sk: string;
    appid: string;
    key: string;
    youdaoAppKey: string;
    youdaoAppSecret: string;
    tencentSecretId: string;
    tencentSecretKey: string;
    extra: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneValue(value: unknown, stripSensitive = false): unknown {
    if (value === null || typeof value !== 'object') return value;
    const createCopy = (input: object): object => Array.isArray(input) ? new Array(input.length) : {};
    const cloned = createCopy(value);
    const copies = new WeakMap<object, object>([[value, cloned]]);
    const pending = [{source: value, target: cloned}];
    while (pending.length > 0) {
        const {source, target} = pending.pop()!;
        for (const key of Object.keys(source)) {
            // 数组的自定义属性不属于原先 Array.map 复制的配置值。
            if (Array.isArray(source) && (!/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= source.length)) continue;
            if (!Array.isArray(source) && stripSensitive
                && (CONFIG_CREDENTIAL_FIELDS.includes(key as ConfigCredentialField) || isSensitiveConfigKey(key))) continue;
            const item = (source as Record<string, unknown>)[key];
            let copy = item;
            if (item !== null && typeof item === 'object') {
                let objectCopy = copies.get(item);
                if (objectCopy === undefined) {
                    objectCopy = createCopy(item);
                    copies.set(item, objectCopy);
                    pending.push({source: item, target: objectCopy});
                }
                copy = objectCopy;
            }
            // 使用数据属性写入，不能让 __proto__ 触发原型 setter。
            Object.defineProperty(target, key, {value: copy, enumerable: true, configurable: true, writable: true});
        }
    }
    return cloned;
}

function ownCredentialValue(source: Record<string, unknown>, field: ConfigCredentialField): unknown {
    return Object.prototype.hasOwnProperty.call(source, field) ? source[field] : undefined;
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function stringMapping(value: unknown): Record<string, string> {
    if (!isRecord(value)) return {};
    return Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
}

function extraMapping(value: unknown): Record<string, unknown> {
    return isRecord(value) ? cloneValue(value) as Record<string, unknown> : {};
}

export function extractConfigCredentials(value: unknown): ConfigCredentials {
    const source = isRecord(value) ? value : {};
    return {
        schemaVersion: CREDENTIALS_SCHEMA_VERSION,
        token: stringMapping(ownCredentialValue(source, 'token')),
        apiKeys: normalizeApiKeys(ownCredentialValue(source, 'apiKeys')),
        secret: stringMapping(ownCredentialValue(source, 'secret')),
        customHeaders: stringMapping(ownCredentialValue(source, 'customHeaders')),
        ak: stringValue(ownCredentialValue(source, 'ak')),
        sk: stringValue(ownCredentialValue(source, 'sk')),
        appid: stringValue(ownCredentialValue(source, 'appid')),
        key: stringValue(ownCredentialValue(source, 'key')),
        youdaoAppKey: stringValue(ownCredentialValue(source, 'youdaoAppKey')),
        youdaoAppSecret: stringValue(ownCredentialValue(source, 'youdaoAppSecret')),
        tencentSecretId: stringValue(ownCredentialValue(source, 'tencentSecretId')),
        tencentSecretKey: stringValue(ownCredentialValue(source, 'tencentSecretKey')),
        extra: extraMapping(ownCredentialValue(source, 'extra')),
    };
}

export function parseStoredCredentials(value: unknown): ConfigCredentials | null {
    if (!hasCredentialFields(value)) return null;
    return extractConfigCredentials(value);
}

export function hasCredentialFields(value: unknown): boolean {
    return isRecord(value) && CONFIG_CREDENTIAL_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(value, field));
}

export function hasCredentialData(value: ConfigCredentials): boolean {
    return Object.keys(value.token).length > 0
        || Object.keys(value.apiKeys).length > 0
        || Object.keys(value.secret).length > 0
        || Object.keys(value.customHeaders).length > 0
        || Boolean(value.ak || value.sk || value.appid || value.key)
        || Boolean(value.youdaoAppKey || value.youdaoAppSecret)
        || Boolean(value.tencentSecretId || value.tencentSecretKey)
        || Object.keys(value.extra).length > 0;
}

/** 与本地 JSON 保存的值语义一致，忽略对象中的不可序列化字段和键顺序。 */
function jsonCredentialValue(value: unknown): unknown {
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    if (typeof value === 'function' || typeof value === 'symbol') return undefined;
    return value;
}

export function credentialsEqual(left: ConfigCredentials, right: ConfigCredentials): boolean {
    const pending: Array<[unknown, unknown]> = [[left, right]];
    const compared = new WeakMap<object, WeakSet<object>>();
    while (pending.length > 0) {
        const [rawA, rawB] = pending.pop()!;
        const a = jsonCredentialValue(rawA), b = jsonCredentialValue(rawB);
        if (a === b) continue;
        if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
        if (Array.isArray(a) !== Array.isArray(b)) return false;
        if (Array.isArray(a) && a.length !== (b as unknown[]).length) return false;
        let pairs = compared.get(a);
        if (pairs?.has(b)) continue;
        if (!pairs) {pairs = new WeakSet<object>(); compared.set(a, pairs);}
        pairs.add(b);
        if (Array.isArray(a)) {
            for (let i = 0; i < a.length; i += 1) {
                pending.push([jsonCredentialValue(a[i]) ?? null, jsonCredentialValue((b as unknown[])[i]) ?? null]);
            }
            continue;
        }
        const keys = Object.keys(a).filter((key) => jsonCredentialValue((a as Record<string, unknown>)[key]) !== undefined);
        if (keys.length !== Object.keys(b).filter((key) => jsonCredentialValue((b as Record<string, unknown>)[key]) !== undefined).length) return false;
        for (const key of keys) {
            if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
            pending.push([(a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]]);
        }
    }
    return true;
}

export function sanitizeConfigCredentials(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) return {};
    const sanitized = cloneValue(value, true) as Record<string, unknown>;
    // Imported/history records can reach this boundary before Config normalization.
    if (Object.hasOwn(value, 'videoNativeAsrBaseUrl')) {
        sanitized.videoNativeAsrBaseUrl = normalizeNativeAsrBaseUrl(value.videoNativeAsrBaseUrl);
    }
    // 仅配置根字段采用严格网站规则 schema；content.key 是标签，其他位置仍按凭据清洗。
    if (Object.hasOwn(value, 'siteAdaptation')) sanitized.siteAdaptation = normalizeSiteAdaptationSettings(value.siteAdaptation);
    if (Object.hasOwn(value, 'sectionTranslationRules')) sanitized.sectionTranslationRules = normalizeSectionTranslationRules(value.sectionTranslationRules);
    return sanitized;
}

export function mergeConfigCredentials(value: unknown, credentials: ConfigCredentials): Record<string, unknown> {
    const {schemaVersion: _schemaVersion, ...credentialFields} = credentials;
    return {
        ...sanitizeConfigCredentials(value),
        ...cloneValue(credentialFields) as Omit<ConfigCredentials, 'schemaVersion'>,
    };
}

export function sanitizeConfigHistoryCredentials(value: unknown): unknown {
    let parsed = value;
    if (typeof parsed === 'string') {
        try {
            parsed = JSON.parse(parsed);
        } catch {
            // 损坏的旧历史无法可靠判断哪些片段属于凭据；继续保留原字符串会让
            // 已知敏感信息永久滞留在 local storage，因此按不可恢复历史丢弃。
            return null;
        }
    }
    const sanitized = cloneValue(parsed);
    if (!isRecord(sanitized) || !Array.isArray(sanitized.entries)) return sanitized;

    sanitized.entries = sanitized.entries.map((entry) => {
        if (!isRecord(entry)) return entry;
        return {
            ...entry,
            config: sanitizeConfigCredentials(entry.config),
        };
    });
    return sanitized;
}
