/**
 * @file src/platform/storage/configEncryption.ts
 *
 * 文件职责：使用 FluentRead 固定对称密钥把配置存储值封装为带完整性校验的 AES-GCM 密文，并在读取时恢复运行态明文。
 * 主要内容：以 SHA-256 派生 256 位 AES 密钥，为每次写入生成独立 96 位 IV，拒绝无法序列化的 JSON 根值，分块执行 Base64 编码，并严格校验密文版本与算法后再解析 JSON。
 * 模块边界：本文件只处理配置值的可逆加解密与密文格式，不访问 IndexedDB、浏览器 storage、runtime 消息或配置领域模型；持久化和迁移由 configRepository 负责。
 */

export const FLUENTREAD_CONFIG_ENCRYPTION_KEY = 'FluentReadEncryption' as const;
export const CONFIG_ENCRYPTION_FORMAT = 'fluentread-config' as const;
export const CONFIG_ENCRYPTION_VERSION = 1 as const;
export const CONFIG_ENCRYPTION_ALGORITHM = 'AES-GCM' as const;

export interface EncryptedConfigPayload {
    format: typeof CONFIG_ENCRYPTION_FORMAT;
    version: typeof CONFIG_ENCRYPTION_VERSION;
    algorithm: typeof CONFIG_ENCRYPTION_ALGORITHM;
    iv: string;
    ciphertext: string;
}

export interface ConfigCryptoRuntime {
    readonly crypto: Crypto;
    readonly encoder: TextEncoder;
    readonly decoder: TextDecoder;
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
    }
    return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
    const binary = atob(value);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export function isEncryptedConfigPayload(value: unknown): value is EncryptedConfigPayload {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as Partial<EncryptedConfigPayload>;
    return candidate.format === CONFIG_ENCRYPTION_FORMAT
        && candidate.version === CONFIG_ENCRYPTION_VERSION
        && candidate.algorithm === CONFIG_ENCRYPTION_ALGORITHM
        && typeof candidate.iv === 'string'
        && candidate.iv.length > 0
        && typeof candidate.ciphertext === 'string'
        && candidate.ciphertext.length > 0;
}

function createDefaultRuntime(): ConfigCryptoRuntime {
    if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不支持配置加密');
    return {
        crypto: globalThis.crypto,
        encoder: new TextEncoder(),
        decoder: new TextDecoder(),
    };
}

async function deriveEncryptionKey(runtime: ConfigCryptoRuntime, keyMaterial: string): Promise<CryptoKey> {
    const digest = await runtime.crypto.subtle.digest(
        'SHA-256',
        runtime.encoder.encode(keyMaterial),
    );
    return runtime.crypto.subtle.importKey('raw', digest, CONFIG_ENCRYPTION_ALGORITHM, false, ['encrypt', 'decrypt']);
}

export async function encryptConfigValue(
    value: unknown,
    runtime: ConfigCryptoRuntime = createDefaultRuntime(),
    keyMaterial: string = FLUENTREAD_CONFIG_ENCRYPTION_KEY,
    additionalData = '',
): Promise<EncryptedConfigPayload> {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('配置值不是可序列化 JSON');
    const iv = runtime.crypto.getRandomValues(new Uint8Array(12));
    const plaintext = runtime.encoder.encode(serialized);
    const key = await deriveEncryptionKey(runtime, keyMaterial);
    const ciphertext = await runtime.crypto.subtle.encrypt(
        {
            name: CONFIG_ENCRYPTION_ALGORITHM,
            iv,
            ...(additionalData ? {additionalData: runtime.encoder.encode(additionalData)} : {}),
        },
        key,
        plaintext,
    );
    return {
        format: CONFIG_ENCRYPTION_FORMAT,
        version: CONFIG_ENCRYPTION_VERSION,
        algorithm: CONFIG_ENCRYPTION_ALGORITHM,
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    };
}

export async function decryptConfigValue(
    value: unknown,
    runtime: ConfigCryptoRuntime = createDefaultRuntime(),
    keyMaterial: string = FLUENTREAD_CONFIG_ENCRYPTION_KEY,
    additionalData = '',
): Promise<unknown> {
    if (!isEncryptedConfigPayload(value)) throw new TypeError('配置密文格式无效或版本不受支持');
    const key = await deriveEncryptionKey(runtime, keyMaterial);
    let plaintext: ArrayBuffer;
    try {
        plaintext = await runtime.crypto.subtle.decrypt(
            {
                name: CONFIG_ENCRYPTION_ALGORITHM,
                iv: base64ToBytes(value.iv),
                ...(additionalData ? {additionalData: runtime.encoder.encode(additionalData)} : {}),
            },
            key,
            base64ToBytes(value.ciphertext),
        );
    } catch {
        throw new Error('配置密文校验失败');
    }
    try {
        return JSON.parse(runtime.decoder.decode(plaintext));
    } catch {
        throw new Error('配置明文不是有效 JSON');
    }
}
