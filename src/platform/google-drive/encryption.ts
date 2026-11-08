/**
 * @file src/platform/google-drive/encryption.ts
 * 文件职责：使用调用方提供的口令在本机生成可跨设备解密的 Google Drive 配置密文。
 * 主要内容：以 PBKDF2-SHA256 六十万次迭代派生不可导出的 AES-256-GCM 密钥，
 * 使用随机盐、随机 IV 和版本认证数据，分别限制配置与预览大小，分块编码大型密文并拒绝降级。
 * 模块边界：只处理 Web Crypto 与 JSON 信封，不访问配置、浏览器身份、存储或网络；
 * 不定义应用口令策略；当前生产后台传入公开固定口令，不要求设置页收集密码。
 */
import {GOOGLE_DRIVE_MAX_BYTES, GOOGLE_DRIVE_MAX_CONFIG_BYTES, GOOGLE_DRIVE_MAX_PREVIEW_BYTES} from './constants';

export const DRIVE_ENCRYPTION_FORMAT = 'fluentread-drive-encrypted';
export const DRIVE_ENCRYPTION_ITERATIONS = 600_000;
const AAD = new TextEncoder().encode('fluentread-drive-encrypted:1:PBKDF2:SHA-256:600000:AES-256-GCM');
export class DriveEncryptionError extends Error {}
export interface DriveEncryptedEnvelope {
    format: typeof DRIVE_ENCRYPTION_FORMAT;
    version: 1;
    kdf: 'PBKDF2-SHA256';
    iterations: typeof DRIVE_ENCRYPTION_ITERATIONS;
    cipher: 'AES-256-GCM';
    salt: string;
    iv: string;
    ciphertext: string;
}

export function validateDrivePassphrase(value: unknown): asserts value is string {
    if (typeof value !== 'string' || value.trim().length < 12 || value.length > 1024) {
        throw new DriveEncryptionError('同步口令至少需要 12 个字符，最多 1024 个字符');
    }
}

function encode(bytes: Uint8Array): string {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
    }
    return btoa(binary);
}

function decode(value: unknown, expectedLength?: number): Uint8Array<ArrayBuffer> {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw new DriveEncryptionError('云端密文编码无效');
    let bytes: Uint8Array<ArrayBuffer>;
    try {
        bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
    } catch {
        throw new DriveEncryptionError('云端密文编码无效');
    }
    if (encode(bytes) !== value || (expectedLength !== undefined && bytes.length !== expectedLength)) {
        throw new DriveEncryptionError('云端密文编码无效');
    }
    return bytes;
}

function runtime(): Crypto {
    if (!globalThis.crypto?.subtle) throw new DriveEncryptionError('当前浏览器无法安全加密配置，请更新浏览器');
    return globalThis.crypto;
}

async function deriveKey(crypto: Crypto, passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        {name: 'PBKDF2', hash: 'SHA-256', iterations: DRIVE_ENCRYPTION_ITERATIONS, salt},
        material, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt'],
    );
}

async function encrypt(value: unknown, passphrase: string, maxPlaintextBytes: number): Promise<string> {
    validateDrivePassphrase(passphrase);
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    if (plaintext.length > maxPlaintextBytes) throw new DriveEncryptionError('同步配置过大，请减少自定义设置后重试');
    const crypto = runtime();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(crypto, passphrase, salt);
    const encrypted = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: AAD, tagLength: 128}, key, plaintext);
    return JSON.stringify({
        format: DRIVE_ENCRYPTION_FORMAT, version: 1, kdf: 'PBKDF2-SHA256',
        iterations: DRIVE_ENCRYPTION_ITERATIONS, cipher: 'AES-256-GCM',
        salt: encode(salt), iv: encode(iv), ciphertext: encode(new Uint8Array(encrypted)),
    } satisfies DriveEncryptedEnvelope);
}

async function decrypt(content: string, passphrase: string, maxPlaintextBytes: number): Promise<unknown> {
    validateDrivePassphrase(passphrase);
    if (typeof content !== 'string' || content.length > GOOGLE_DRIVE_MAX_BYTES) throw new DriveEncryptionError('云端同步文件过大或内容无效');
    let envelope: Partial<DriveEncryptedEnvelope>;
    try { envelope = JSON.parse(content); } catch { throw new DriveEncryptionError('云端同步文件不是有效密文'); }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
        || envelope.format !== DRIVE_ENCRYPTION_FORMAT || envelope.version !== 1
        || envelope.kdf !== 'PBKDF2-SHA256' || envelope.iterations !== DRIVE_ENCRYPTION_ITERATIONS
        || envelope.cipher !== 'AES-256-GCM') throw new DriveEncryptionError('云端同步文件格式或加密版本不受支持');
    const salt = decode(envelope.salt, 16);
    const iv = decode(envelope.iv, 12);
    const ciphertext = decode(envelope.ciphertext);
    if (ciphertext.length < 16) throw new DriveEncryptionError('云端密文内容不完整');
    const crypto = runtime();
    const key = await deriveKey(crypto, passphrase, salt);
    let plaintext: ArrayBuffer;
    try {
        plaintext = await crypto.subtle.decrypt({name: 'AES-GCM', iv, additionalData: AAD, tagLength: 128}, key, ciphertext);
    } catch {
        throw new DriveEncryptionError('同步口令不正确，或云端配置已损坏；本机配置未被修改');
    }
    if (plaintext.byteLength > maxPlaintextBytes) throw new DriveEncryptionError('同步配置过大，请减少自定义设置后重试');
    try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(plaintext)); }
    catch { throw new DriveEncryptionError('解密后的配置不是有效 JSON'); }
}

export function encryptDriveConfig(value: unknown, passphrase: string): Promise<string> {
    return encrypt(value, passphrase, GOOGLE_DRIVE_MAX_CONFIG_BYTES);
}
export function decryptDriveConfig(content: string, passphrase: string): Promise<unknown> {
    return decrypt(content, passphrase, GOOGLE_DRIVE_MAX_CONFIG_BYTES);
}
/** 仅用于本机预览事务：为元数据单独留空间，不放宽云端配置明文上限。 */
export function encryptDrivePreview(value: unknown, passphrase: string): Promise<string> {
    return encrypt(value, passphrase, GOOGLE_DRIVE_MAX_PREVIEW_BYTES);
}
export function decryptDrivePreview(content: string, passphrase: string): Promise<unknown> {
    return decrypt(content, passphrase, GOOGLE_DRIVE_MAX_PREVIEW_BYTES);
}
