/**
 * @file src/platform/google-drive/encryption.ts
 * 文件职责：使用应用兼容口令或用户自定义端到端口令在本机生成可跨设备解密的云备份密文。
 * 主要内容：以 PBKDF2-SHA256 六十万次迭代派生不可导出的 AES-256-GCM 密钥，
 * 支持 v1 兼容信封与绑定 keyMode 的 v2 自定义口令认证数据，提供信封探测、强度评估、随机盐与 IV、配置与预览独立容量上限，并拒绝任意版本或模式降级。
 * 模块边界：只处理 Web Crypto、口令校验与 JSON 信封，不访问配置、浏览器身份、存储或网络；
 * 固定应用口令与自定义口令的持久化策略由调用方服务层管理。
 */
import {GOOGLE_DRIVE_MAX_BYTES, GOOGLE_DRIVE_MAX_CONFIG_BYTES, GOOGLE_DRIVE_MAX_PREVIEW_BYTES} from './constants';

export const DRIVE_ENCRYPTION_FORMAT = 'fluentread-drive-encrypted';
export const DRIVE_ENCRYPTION_ITERATIONS = 600_000;
export type DriveEncryptionKeyMode = 'app' | 'custom';
export type DriveEncryptionErrorCode =
    | 'invalid-passphrase'
    | 'passphrase-required'
    | 'wrong-passphrase'
    | 'unsupported'
    | 'too-large'
    | 'corrupted'
    | 'unavailable';
export type PassphraseStrength = 'too-short' | 'weak' | 'fair' | 'strong';

const AAD_V1 = new TextEncoder().encode('fluentread-drive-encrypted:1:PBKDF2:SHA-256:600000:AES-256-GCM');
const AAD_V2_CUSTOM = new TextEncoder().encode('fluentread-drive-encrypted:2:custom:PBKDF2:SHA-256:600000:AES-256-GCM');

export class DriveEncryptionError extends Error {
    constructor(message: string, readonly code?: DriveEncryptionErrorCode) {
        super(message);
    }
}

export interface DriveEncryptedEnvelopeV1 {
    format: typeof DRIVE_ENCRYPTION_FORMAT;
    version: 1;
    keyMode?: 'app';
    kdf: 'PBKDF2-SHA256';
    iterations: typeof DRIVE_ENCRYPTION_ITERATIONS;
    cipher: 'AES-256-GCM';
    salt: string;
    iv: string;
    ciphertext: string;
}

export interface DriveEncryptedEnvelopeV2 {
    format: typeof DRIVE_ENCRYPTION_FORMAT;
    version: 2;
    keyMode: 'custom';
    kdf: 'PBKDF2-SHA256';
    iterations: typeof DRIVE_ENCRYPTION_ITERATIONS;
    cipher: 'AES-256-GCM';
    salt: string;
    iv: string;
    ciphertext: string;
}

export type DriveEncryptedEnvelope = DriveEncryptedEnvelopeV1 | DriveEncryptedEnvelopeV2;

export interface DriveEnvelopeMetadata {
    version: 1 | 2;
    keyMode: DriveEncryptionKeyMode;
}

export interface DriveEncryptOptions {
    keyMode?: DriveEncryptionKeyMode;
}

export interface DriveDecryptOptions {
    expectedKeyMode?: DriveEncryptionKeyMode;
}

export function validateDrivePassphrase(value: unknown): asserts value is string {
    if (typeof value !== 'string' || value.trim().length < 12 || value.length > 1024) {
        throw new DriveEncryptionError('同步口令至少需要 12 个字符，最多 1024 个字符', 'invalid-passphrase');
    }
}

export function evaluatePassphraseStrength(value: string): PassphraseStrength {
    const trimmed = value.trim();
    if (trimmed.length < 12) return 'too-short';
    let classes = 0;
    if (/[a-z]/u.test(trimmed)) classes++;
    if (/[A-Z]/u.test(trimmed)) classes++;
    if (/[0-9]/u.test(trimmed)) classes++;
    if (/[^a-zA-Z0-9]/u.test(trimmed)) classes++;
    if (trimmed.length >= 16 && classes >= 3) return 'strong';
    if (trimmed.length >= 14 && classes >= 2) return 'fair';
    return 'weak';
}

function encode(bytes: Uint8Array): string {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
    }
    return btoa(binary);
}

function decode(value: unknown, expectedLength?: number): Uint8Array<ArrayBuffer> {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw new DriveEncryptionError('云端密文编码无效', 'corrupted');
    let bytes: Uint8Array<ArrayBuffer>;
    try {
        bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
    } catch {
        throw new DriveEncryptionError('云端密文编码无效', 'corrupted');
    }
    if (encode(bytes) !== value || (expectedLength !== undefined && bytes.length !== expectedLength)) {
        throw new DriveEncryptionError('云端密文编码无效', 'corrupted');
    }
    return bytes;
}

function runtime(): Crypto {
    if (!globalThis.crypto?.subtle) throw new DriveEncryptionError('当前浏览器无法安全加密配置，请更新浏览器', 'unavailable');
    return globalThis.crypto;
}

async function deriveKey(crypto: Crypto, passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        {name: 'PBKDF2', hash: 'SHA-256', iterations: DRIVE_ENCRYPTION_ITERATIONS, salt},
        material, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt'],
    );
}

function parseEnvelope(content: string): {envelope: DriveEncryptedEnvelope; metadata: DriveEnvelopeMetadata; aad: Uint8Array<ArrayBuffer>} {
    if (typeof content !== 'string' || content.length > GOOGLE_DRIVE_MAX_BYTES) {
        throw new DriveEncryptionError('云端同步文件过大或内容无效', 'too-large');
    }
    let raw: Partial<DriveEncryptedEnvelope>;
    try {raw = JSON.parse(content);} catch {throw new DriveEncryptionError('云端同步文件不是有效密文', 'corrupted');}
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || raw.format !== DRIVE_ENCRYPTION_FORMAT
        || raw.kdf !== 'PBKDF2-SHA256'
        || raw.iterations !== DRIVE_ENCRYPTION_ITERATIONS
        || raw.cipher !== 'AES-256-GCM') {
        throw new DriveEncryptionError('云端同步文件格式或加密版本不受支持', 'unsupported');
    }
    if (raw.version === 1 && (raw.keyMode === undefined || raw.keyMode === 'app')) {
        return {envelope: raw as DriveEncryptedEnvelopeV1, metadata: {version: 1, keyMode: 'app'}, aad: AAD_V1};
    }
    if (raw.version === 2 && raw.keyMode === 'custom') {
        return {envelope: raw as DriveEncryptedEnvelopeV2, metadata: {version: 2, keyMode: 'custom'}, aad: AAD_V2_CUSTOM};
    }
    throw new DriveEncryptionError('云端同步文件格式或加密版本不受支持', 'unsupported');
}

/** 仅解析公开信封头以区分兼容模式与自定义端到端口令，不尝试解密密文。 */
export function inspectDriveEncryptedEnvelope(content: string): DriveEnvelopeMetadata {
    return parseEnvelope(content).metadata;
}

async function encrypt(value: unknown, passphrase: string, maxPlaintextBytes: number, options?: DriveEncryptOptions): Promise<string> {
    const keyMode: DriveEncryptionKeyMode = options?.keyMode ?? 'app';
    if (keyMode !== 'app' && keyMode !== 'custom') throw new DriveEncryptionError('不支持的加密口令模式', 'unsupported');
    validateDrivePassphrase(passphrase);
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    if (plaintext.length > maxPlaintextBytes) throw new DriveEncryptionError('同步配置过大，请减少自定义设置后重试', 'too-large');
    const crypto = runtime();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(crypto, passphrase, salt);
    const aad = keyMode === 'custom' ? AAD_V2_CUSTOM : AAD_V1;
    const encrypted = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: aad, tagLength: 128}, key, plaintext);
    const base = {
        format: DRIVE_ENCRYPTION_FORMAT as typeof DRIVE_ENCRYPTION_FORMAT,
        kdf: 'PBKDF2-SHA256' as const,
        iterations: DRIVE_ENCRYPTION_ITERATIONS as typeof DRIVE_ENCRYPTION_ITERATIONS,
        cipher: 'AES-256-GCM' as const,
        salt: encode(salt),
        iv: encode(iv),
        ciphertext: encode(new Uint8Array(encrypted)),
    };
    const envelope: DriveEncryptedEnvelope = keyMode === 'custom'
        ? {...base, version: 2, keyMode: 'custom'}
        : {...base, version: 1};
    return JSON.stringify(envelope);
}

async function decrypt(content: string, passphrase: string, maxPlaintextBytes: number, options?: DriveDecryptOptions): Promise<unknown> {
    validateDrivePassphrase(passphrase);
    const {envelope, metadata, aad} = parseEnvelope(content);
    if (options?.expectedKeyMode && options.expectedKeyMode !== metadata.keyMode) {
        throw new DriveEncryptionError(
            metadata.keyMode === 'custom'
                ? '云端备份使用自定义端到端加密口令保护，请先输入同步口令。'
                : '云端同步文件加密模式与预期不符',
            metadata.keyMode === 'custom' ? 'passphrase-required' : 'unsupported',
        );
    }
    const salt = decode(envelope.salt, 16);
    const iv = decode(envelope.iv, 12);
    const ciphertext = decode(envelope.ciphertext);
    if (ciphertext.length < 16) throw new DriveEncryptionError('云端密文内容不完整', 'corrupted');
    const crypto = runtime();
    const key = await deriveKey(crypto, passphrase, salt);
    let plaintext: ArrayBuffer;
    try {
        plaintext = await crypto.subtle.decrypt({name: 'AES-GCM', iv, additionalData: aad, tagLength: 128}, key, ciphertext);
    } catch {
        throw new DriveEncryptionError('同步口令不正确，或云端配置已损坏；本机配置未被修改', 'wrong-passphrase');
    }
    if (plaintext.byteLength > maxPlaintextBytes) throw new DriveEncryptionError('同步配置过大，请减少自定义设置后重试', 'too-large');
    try {return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(plaintext));}
    catch {throw new DriveEncryptionError('解密后的配置不是有效 JSON', 'corrupted');}
}

export function encryptDriveConfig(value: unknown, passphrase: string, options?: DriveEncryptOptions): Promise<string> {
    return encrypt(value, passphrase, GOOGLE_DRIVE_MAX_CONFIG_BYTES, options);
}
export function decryptDriveConfig(content: string, passphrase: string, options?: DriveDecryptOptions): Promise<unknown> {
    return decrypt(content, passphrase, GOOGLE_DRIVE_MAX_CONFIG_BYTES, options);
}
/** 仅用于本机预览事务：为元数据单独留空间，不放宽云端配置明文上限。 */
export function encryptDrivePreview(value: unknown, passphrase: string, options?: DriveEncryptOptions): Promise<string> {
    return encrypt(value, passphrase, GOOGLE_DRIVE_MAX_PREVIEW_BYTES, options);
}
export function decryptDrivePreview(content: string, passphrase: string, options?: DriveDecryptOptions): Promise<unknown> {
    return decrypt(content, passphrase, GOOGLE_DRIVE_MAX_PREVIEW_BYTES, options);
}
