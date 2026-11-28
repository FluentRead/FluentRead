/**
 * @file src/shared/crypto/lightCrypto.ts
 * 文件职责：提供同步、零膨胀的轻量密码学原语（MD5、HMAC-SHA256 Base64URL 与 AES-128-ECB/PKCS#7），完全替代扩展源码中的 crypto-js 依赖。
 * 主要内容：实现 RFC 1321 UTF-8 MD5 十六进制摘要、基于项目已有 @noble/hashes 的同步 HMAC-SHA256 Base64URL 签名（用于智谱 JWT 鉴权），以及标准 FIPS-197 AES-128-ECB PKCS#7 UTF-8/Base64 加解密（用于金山词霸匿名网页协议签名与响应解码）。
 * 模块边界：位于 src/shared 无业务语义基础层，只处理传入字符串并返回编码结果；不缓存密钥、不发起网络请求、不依赖浏览器扩展 API 或业务配置。
 */
import {hmac} from '@noble/hashes/hmac';
import {sha256} from '@noble/hashes/sha2';
import {bytesToHex} from '@noble/hashes/utils';

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', {fatal: true});

const MD5_K = Uint32Array.from({length: 64}, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0);
const MD5_SHIFTS = [
    7, 12, 17, 22,
    5, 9, 14, 20,
    4, 11, 16, 23,
    6, 10, 15, 21,
] as const;

const AES_SBOX = new Uint8Array(256);
const AES_INV_SBOX = new Uint8Array(256);
{
    let p = 1;
    let q = 1;
    do {
        p = (p ^ (p << 1) ^ (p & 0x80 ? 0x1b : 0)) & 0xff;
        q ^= q << 1;
        q ^= q << 2;
        q ^= q << 4;
        q ^= q & 0x80 ? 0x09 : 0;
        q &= 0xff;
        const s = (
            q
            ^ ((q << 1) | (q >>> 7))
            ^ ((q << 2) | (q >>> 6))
            ^ ((q << 3) | (q >>> 5))
            ^ ((q << 4) | (q >>> 4))
            ^ 0x63
        ) & 0xff;
        AES_SBOX[p] = s;
        AES_INV_SBOX[s] = p;
    } while (p !== 1);
    AES_SBOX[0] = 0x63;
    AES_INV_SBOX[0x63] = 0;
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let index = 0; index < bytes.length; index += 1) {
        binary += String.fromCharCode(bytes[index]!);
    }
    return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

function xtime(value: number): number {
    return ((value << 1) ^ (value & 0x80 ? 0x1b : 0)) & 0xff;
}

function gfMul(a: number, b: number): number {
    let result = 0;
    let factor = a;
    let multiplier = b;
    while (multiplier > 0) {
        if (multiplier & 1) result ^= factor;
        factor = xtime(factor);
        multiplier >>>= 1;
    }
    return result;
}

function expandAes128Key(utf8Key: string): Uint8Array {
    const key = utf8Encoder.encode(utf8Key);
    if (key.length !== 16) throw new Error('AES-128 key must be 16 UTF-8 bytes');
    const roundKeys = new Uint8Array(176);
    roundKeys.set(key);
    let rcon = 1;
    for (let offset = 16; offset < 176; offset += 4) {
        let b0 = roundKeys[offset - 4]!;
        let b1 = roundKeys[offset - 3]!;
        let b2 = roundKeys[offset - 2]!;
        let b3 = roundKeys[offset - 1]!;
        if ((offset & 15) === 0) {
            const rotated = b0;
            b0 = AES_SBOX[b1]! ^ rcon;
            b1 = AES_SBOX[b2]!;
            b2 = AES_SBOX[b3]!;
            b3 = AES_SBOX[rotated]!;
            rcon = xtime(rcon);
        }
        roundKeys[offset] = roundKeys[offset - 16]! ^ b0;
        roundKeys[offset + 1] = roundKeys[offset - 15]! ^ b1;
        roundKeys[offset + 2] = roundKeys[offset - 14]! ^ b2;
        roundKeys[offset + 3] = roundKeys[offset - 13]! ^ b3;
    }
    return roundKeys;
}

function addRoundKey(state: Uint8Array, roundKeys: Uint8Array, roundOffset: number): void {
    for (let index = 0; index < 16; index += 1) {
        state[index] ^= roundKeys[roundOffset + index]!;
    }
}

function encryptAes128Block(input: Uint8Array, offset: number, roundKeys: Uint8Array, output: Uint8Array): void {
    const state = input.slice(offset, offset + 16);
    addRoundKey(state, roundKeys, 0);
    for (let round = 1; round <= 10; round += 1) {
        for (let index = 0; index < 16; index += 1) {
            state[index] = AES_SBOX[state[index]!]!;
        }
        // ShiftRows
        let tmp = state[1]!;
        state[1] = state[5]!;
        state[5] = state[9]!;
        state[9] = state[13]!;
        state[13] = tmp;

        tmp = state[2]!;
        state[2] = state[10]!;
        state[10] = tmp;
        tmp = state[6]!;
        state[6] = state[14]!;
        state[14] = tmp;

        tmp = state[15]!;
        state[15] = state[11]!;
        state[11] = state[7]!;
        state[7] = state[3]!;
        state[3] = tmp;

        if (round < 10) {
            for (let col = 0; col < 16; col += 4) {
                const s0 = state[col]!;
                const s1 = state[col + 1]!;
                const s2 = state[col + 2]!;
                const s3 = state[col + 3]!;
                const t = s0 ^ s1 ^ s2 ^ s3;
                state[col] = s0 ^ t ^ xtime(s0 ^ s1);
                state[col + 1] = s1 ^ t ^ xtime(s1 ^ s2);
                state[col + 2] = s2 ^ t ^ xtime(s2 ^ s3);
                state[col + 3] = s3 ^ t ^ xtime(s3 ^ s0);
            }
        }
        addRoundKey(state, roundKeys, round * 16);
    }
    output.set(state, offset);
}

function decryptAes128Block(input: Uint8Array, offset: number, roundKeys: Uint8Array, output: Uint8Array): void {
    const state = input.slice(offset, offset + 16);
    addRoundKey(state, roundKeys, 160);
    for (let round = 9; round >= 0; round -= 1) {
        // InvShiftRows
        let tmp = state[13]!;
        state[13] = state[9]!;
        state[9] = state[5]!;
        state[5] = state[1]!;
        state[1] = tmp;

        tmp = state[2]!;
        state[2] = state[10]!;
        state[10] = tmp;
        tmp = state[6]!;
        state[6] = state[14]!;
        state[14] = tmp;

        tmp = state[3]!;
        state[3] = state[7]!;
        state[7] = state[11]!;
        state[11] = state[15]!;
        state[15] = tmp;

        for (let index = 0; index < 16; index += 1) {
            state[index] = AES_INV_SBOX[state[index]!]!;
        }
        addRoundKey(state, roundKeys, round * 16);
        if (round > 0) {
            for (let col = 0; col < 16; col += 4) {
                const s0 = state[col]!;
                const s1 = state[col + 1]!;
                const s2 = state[col + 2]!;
                const s3 = state[col + 3]!;
                state[col] = gfMul(s0, 14) ^ gfMul(s1, 11) ^ gfMul(s2, 13) ^ gfMul(s3, 9);
                state[col + 1] = gfMul(s0, 9) ^ gfMul(s1, 14) ^ gfMul(s2, 11) ^ gfMul(s3, 13);
                state[col + 2] = gfMul(s0, 13) ^ gfMul(s1, 9) ^ gfMul(s2, 14) ^ gfMul(s3, 11);
                state[col + 3] = gfMul(s0, 11) ^ gfMul(s1, 13) ^ gfMul(s2, 9) ^ gfMul(s3, 14);
            }
        }
    }
    output.set(state, offset);
}

/** 计算 UTF-8 字符串的 RFC 1321 MD5 摘要，返回 32 位小写十六进制字符串。 */
export function md5Hex(input: string): string {
    const message = utf8Encoder.encode(input);
    const paddedLength = (message.length + 9 + 63) & ~63;
    const padded = new Uint8Array(paddedLength);
    padded.set(message);
    padded[message.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 8, (message.length * 8) >>> 0, true);
    view.setUint32(paddedLength - 4, Math.floor(message.length / 0x20000000) >>> 0, true);

    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;
    const words = new Uint32Array(16);

    for (let offset = 0; offset < paddedLength; offset += 64) {
        for (let wordIndex = 0; wordIndex < 16; wordIndex += 1) {
            words[wordIndex] = view.getUint32(offset + wordIndex * 4, true);
        }
        let a = a0;
        let b = b0;
        let c = c0;
        let d = d0;
        for (let step = 0; step < 64; step += 1) {
            let f: number;
            let g: number;
            if (step < 16) {
                f = (b & c) | (~b & d);
                g = step;
            } else if (step < 32) {
                f = (d & b) | (~d & c);
                g = (5 * step + 1) & 15;
            } else if (step < 48) {
                f = b ^ c ^ d;
                g = (3 * step + 5) & 15;
            } else {
                f = c ^ (b | ~d);
                g = (7 * step) & 15;
            }
            const shift = MD5_SHIFTS[(step >>> 4) * 4 + (step & 3)]!;
            const sum = (a + f + MD5_K[step]! + words[g]!) >>> 0;
            const rotated = ((sum << shift) | (sum >>> (32 - shift))) >>> 0;
            a = d;
            d = c;
            c = b;
            b = (b + rotated) >>> 0;
        }
        a0 = (a0 + a) >>> 0;
        b0 = (b0 + b) >>> 0;
        c0 = (c0 + c) >>> 0;
        d0 = (d0 + d) >>> 0;
    }

    const digest = new Uint8Array(16);
    const digestView = new DataView(digest.buffer);
    digestView.setUint32(0, a0, true);
    digestView.setUint32(4, b0, true);
    digestView.setUint32(8, c0, true);
    digestView.setUint32(12, d0, true);
    return bytesToHex(digest);
}

/** 同步计算 UTF-8 字符串的 HMAC-SHA256，并返回无填充 Base64URL 编码结果。 */
export function hmacSha256Base64Url(data: string, secret: string): string {
    const mac = hmac(sha256, utf8Encoder.encode(secret), utf8Encoder.encode(data));
    return bytesToBase64(mac).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}

/** 使用 AES-128-ECB + PKCS#7 加密 UTF-8 明文，返回标准 Base64 密文。 */
export function aesEcbEncryptUtf8Base64(plaintext: string, utf8Key: string): string {
    const roundKeys = expandAes128Key(utf8Key);
    const plain = utf8Encoder.encode(plaintext);
    const padLength = 16 - (plain.length % 16);
    const padded = new Uint8Array(plain.length + padLength);
    padded.set(plain);
    padded.fill(padLength, plain.length);
    const output = new Uint8Array(padded.length);
    for (let offset = 0; offset < padded.length; offset += 16) {
        encryptAes128Block(padded, offset, roundKeys, output);
    }
    return bytesToBase64(output);
}

/** 使用 AES-128-ECB + PKCS#7 解密标准 Base64 密文，校验填充与 UTF-8 合法性后返回明文。 */
export function aesEcbDecryptBase64Utf8(ciphertextBase64: string, utf8Key: string): string {
    const roundKeys = expandAes128Key(utf8Key);
    const cipher = base64ToBytes(ciphertextBase64);
    if (cipher.length === 0 || cipher.length % 16 !== 0) {
        throw new Error('Invalid AES-ECB ciphertext length');
    }
    const plain = new Uint8Array(cipher.length);
    for (let offset = 0; offset < cipher.length; offset += 16) {
        decryptAes128Block(cipher, offset, roundKeys, plain);
    }
    const padLength = plain[plain.length - 1]!;
    if (padLength < 1 || padLength > 16) {
        throw new Error('Invalid PKCS#7 padding');
    }
    for (let index = plain.length - padLength; index < plain.length; index += 1) {
        if (plain[index] !== padLength) {
            throw new Error('Invalid PKCS#7 padding');
        }
    }
    return utf8Decoder.decode(plain.subarray(0, plain.length - padLength));
}
