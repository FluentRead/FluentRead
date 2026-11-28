/**
 * @file tests/lightCrypto.test.ts
 * 文件职责：以 crypto-js 4.2.0 与 Node crypto 为双基准，验证 src/shared/crypto/lightCrypto.ts 的字节级等价性与全分支覆盖。
 * 主要内容：覆盖 MD5（空串、RFC 1321 向量、块边界、CJK/Emoji、长串、厂商签名）、HMAC-SHA256 Base64URL（智谱 JWT、长密钥、UTF-8）与 AES-128-ECB/PKCS#7（词霸加解密、块边界、无效密钥/密文/填充/UTF-8 错误路径）。
 * 模块边界：仅验证纯密码学工具模块，不发起网络请求或修改全局状态。
 */
import {createCipheriv, createHash, createHmac} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import AES from 'crypto-js/aes';
import encBase64 from 'crypto-js/enc-base64';
import encUtf8 from 'crypto-js/enc-utf8';
import hmacSha256 from 'crypto-js/hmac-sha256';
import MD5 from 'crypto-js/md5';
import modeECB from 'crypto-js/mode-ecb';
import padPkcs7 from 'crypto-js/pad-pkcs7';
import {
    aesEcbDecryptBase64Utf8,
    aesEcbEncryptUtf8Base64,
    hmacSha256Base64Url,
    md5Hex,
} from '@/src/shared/crypto/lightCrypto';

function legacyHmacBase64Url(data: string, secret: string): string {
    return hmacSha256(data, secret)
        .toString(encBase64)
        .replace(/\+/gu, '-')
        .replace(/\//gu, '_')
        .replace(/=+$/gu, '');
}

function legacyAesEncrypt(plain: string, key: string): string {
    return AES.encrypt(plain, encUtf8.parse(key), {mode: modeECB, padding: padPkcs7}).toString();
}

function legacyAesDecrypt(cipherBase64: string, key: string): string {
    return AES.decrypt(cipherBase64, encUtf8.parse(key), {mode: modeECB, padding: padPkcs7}).toString(encUtf8);
}

describe('lightCrypto', () => {
    describe('md5Hex', () => {
        const rfc1321Vectors: readonly [string, string][] = [
            ['', 'd41d8cd98f00b204e9800998ecf8427e'],
            ['a', '0cc175b9c0f1b6a831c399e269772661'],
            ['abc', '900150983cd24fb0d6963f7d28e17f72'],
            ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
            ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
            ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'd174ab98d277d9f5a5611c2c9f419d9f'],
            ['1234567890'.repeat(8), '57edf4a22be3c955ac49da2e2107b67a'],
        ];

        it.each(rfc1321Vectors)('matches RFC 1321 & crypto-js for %j', (input, expected) => {
            expect(md5Hex(input)).toBe(expected);
            expect(md5Hex(input)).toBe(MD5(input).toString());
        });

        it('matches crypto-js and Node crypto across block boundaries, UTF-8 CJK/emoji, and provider payloads', () => {
            const samples = [
                'x'.repeat(54),
                'x'.repeat(55),
                'x'.repeat(56),
                'x'.repeat(57),
                'x'.repeat(63),
                'x'.repeat(64),
                'x'.repeat(65),
                'x'.repeat(119),
                'x'.repeat(120),
                'x'.repeat(128),
                '你好，世界！FluentRead 🚀 α+β=γ',
                'webkey_E3sTuMjpP8Jez49GcYpDVH7r#1735689600000#Hello 世界',
                '6key_web_new_fanyi6dVjYLFyzfkFkk翻译测试长段落'.repeat(30),
                'A'.repeat(12_345),
            ];
            for (const sample of samples) {
                const actual = md5Hex(sample);
                expect(actual).toBe(MD5(sample).toString());
                expect(actual).toBe(createHash('md5').update(sample, 'utf8').digest('hex'));
            }
        });
    });

    describe('hmacSha256Base64Url', () => {
        it('matches crypto-js and Node crypto for Zhipu JWT, UTF-8, empty inputs, and long keys', () => {
            const header = btoa(JSON.stringify({alg: 'HS256', sign_type: 'SIGN', typ: 'JWT'}))
                .replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
            const payload = btoa(JSON.stringify({api_key: 'id-123', exp: 1767312000, timestamp: 1767225600}))
                .replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');

            const cases: readonly [string, string][] = [
                [`${header}.${payload}`, 'api-secret-value'],
                ['', ''],
                ['', 'secret'],
                ['data-only', ''],
                ['你好世界 🚀', '中文密钥-🔐'],
                ['long-key-payload', 'k'.repeat(128)],
                ['padding-and-url-safe-chars-check-0123456789', 'secret-producing-plus-and-slash-chars'],
            ];

            for (const [data, secret] of cases) {
                const actual = hmacSha256Base64Url(data, secret);
                const expectedCryptoJs = legacyHmacBase64Url(data, secret);
                const expectedNode = createHmac('sha256', Buffer.from(secret, 'utf8'))
                    .update(Buffer.from(data, 'utf8'))
                    .digest('base64url');
                expect(actual).toBe(expectedCryptoJs);
                expect(actual).toBe(expectedNode);
                expect(actual).not.toMatch(/[+/=]/u);
            }
        });
    });

    describe('AES-128-ECB + PKCS#7', () => {
        const icibaSignKey = 'L4fBtD5fLC9FQw22';
        const icibaResponseKey = 'aahc3TfyfCEmER33';

        it('matches crypto-js and Node crypto byte-for-byte on encrypt and decrypt across block lengths and UTF-8', () => {
            const payloads = [
                '',
                'a',
                '0123456789abcdef', // exact 16-byte iciba MD5 slice (triggers full 16-byte padding block)
                '0123456789abcde', // 15 bytes
                '0123456789abcdef0', // 17 bytes
                '0123456789abcdef'.repeat(2), // 32 bytes
                JSON.stringify({err_no: 0, out: '你好，金山词霸译文 🚀 α + β = γ'}),
                JSON.stringify({err_no: 0, out: '多块长段落测试 '.repeat(250)}),
            ];

            for (const key of [icibaSignKey, icibaResponseKey]) {
                for (const plain of payloads) {
                    const encrypted = aesEcbEncryptUtf8Base64(plain, key);
                    const legacyEncrypted = legacyAesEncrypt(plain, key);
                    const cipher = createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null);
                    const nodeEncrypted = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]).toString('base64');

                    expect(encrypted).toBe(legacyEncrypted);
                    expect(encrypted).toBe(nodeEncrypted);
                    expect(aesEcbDecryptBase64Utf8(encrypted, key)).toBe(plain);
                    expect(aesEcbDecryptBase64Utf8(legacyEncrypted, key)).toBe(plain);
                    expect(legacyAesDecrypt(encrypted, key)).toBe(plain);
                }
            }
        });

        it('rejects invalid key lengths, malformed/unaligned ciphertext, invalid PKCS#7 padding, and invalid UTF-8', () => {
            // Key length validation
            expect(() => aesEcbEncryptUtf8Base64('hello', 'short-key')).toThrow('AES-128 key must be 16 UTF-8 bytes');
            expect(() => aesEcbEncryptUtf8Base64('hello', 'this-key-is-longer-than-16-bytes')).toThrow('AES-128 key must be 16 UTF-8 bytes');
            expect(() => aesEcbDecryptBase64Utf8('AAAAAAAAAAAAAAAAAAAAAA==', '中文密钥')).toThrow('AES-128 key must be 16 UTF-8 bytes');

            // Empty / unaligned / invalid base64 ciphertext
            expect(() => aesEcbDecryptBase64Utf8('', icibaResponseKey)).toThrow('Invalid AES-ECB ciphertext length');
            expect(() => aesEcbDecryptBase64Utf8(btoa('not-16-bytes'), icibaResponseKey)).toThrow('Invalid AES-ECB ciphertext length');
            expect(() => aesEcbDecryptBase64Utf8('***not-valid-base64***', icibaResponseKey)).toThrow();

            // Helper to encrypt raw unpadded 16-byte blocks with Node crypto (autoPadding disabled)
            const encryptRawBlock = (block: Uint8Array, key: string): string => {
                const rawCipher = createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null);
                rawCipher.setAutoPadding(false);
                return Buffer.concat([rawCipher.update(block), rawCipher.final()]).toString('base64');
            };

            // padLength = 0 (< 1)
            const padZero = new Uint8Array(16).fill(0x41);
            padZero[15] = 0x00;
            expect(() => aesEcbDecryptBase64Utf8(encryptRawBlock(padZero, icibaResponseKey), icibaResponseKey))
                .toThrow('Invalid PKCS#7 padding');

            // padLength = 17 (> 16)
            const padTooLarge = new Uint8Array(16).fill(0x41);
            padTooLarge[15] = 0x11;
            expect(() => aesEcbDecryptBase64Utf8(encryptRawBlock(padTooLarge, icibaResponseKey), icibaResponseKey))
                .toThrow('Invalid PKCS#7 padding');

            // Inconsistent padding bytes (last byte says 4, preceding byte is 3)
            const padMismatch = new Uint8Array(16).fill(0x41);
            padMismatch.set([0x04, 0x03, 0x04, 0x04], 12);
            expect(() => aesEcbDecryptBase64Utf8(encryptRawBlock(padMismatch, icibaResponseKey), icibaResponseKey))
                .toThrow('Invalid PKCS#7 padding');

            // Valid PKCS#7 padding wrapping invalid UTF-8 byte sequence (0xff, 0xfe)
            const invalidUtf8 = new Uint8Array(16).fill(0x0e);
            invalidUtf8[0] = 0xff;
            invalidUtf8[1] = 0xfe;
            expect(() => aesEcbDecryptBase64Utf8(encryptRawBlock(invalidUtf8, icibaResponseKey), icibaResponseKey))
                .toThrow();
        });
    });
});
