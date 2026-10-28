/**
 * @file userscript/dataEncoding.ts
 * 文件职责：恢复脚本内嵌静态资源的二进制编码，兼容原有 Base64 和 Base85 数据。
 * 主要内容：识别 standalone 的 Base91 与带填充标记的 Base85，校验字符与尾部，逐字节恢复构建期的 gzip 数据。
 * 模块边界：只处理字节表示，不解压、不解析或执行内容，不改变 UTF-8、pako、浏览器解压及资源加载语义。
 */

export const USERSCRIPT_DATA_PREFIX = '~85:';
export const USERSCRIPT_COMPACT_DATA_PREFIX = '~91:';
// The alphabet excludes double quotes, backslash, slash and whitespace; slash exclusion prevents HTML closing tags.
export const USERSCRIPT_COMPACT_DATA_ALPHABET = "!#$%&'()*+,-.0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~";
// 可直接写入单引号或双引号的 JavaScript 字符串；不包含反斜杠、空白或非 ASCII 字符。
export const USERSCRIPT_DATA_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';

const digits = new Int16Array(128).fill(-1);
const digits91 = new Int16Array(128).fill(-1);
for (let index = 0; index < USERSCRIPT_COMPACT_DATA_ALPHABET.length; index += 1) digits91[USERSCRIPT_COMPACT_DATA_ALPHABET.charCodeAt(index)] = index;
for (let index = 0; index < USERSCRIPT_DATA_ALPHABET.length; index += 1) {
    digits[USERSCRIPT_DATA_ALPHABET.charCodeAt(index)] = index;
}

/** Base91 仅用于 gzip 静态资源；保留每个字节，拒绝非字母字符。 */
function decode91(value: string): Uint8Array {
    const bytes = new Uint8Array(Math.ceil((value.length - USERSCRIPT_COMPACT_DATA_PREFIX.length) * 7 / 8));
    let pending = -1, buffer = 0, bits = 0, offset = 0;
    for (let index = USERSCRIPT_COMPACT_DATA_PREFIX.length; index < value.length; index++) {
        const digit = digits91[value.charCodeAt(index)];
        if (digit === undefined || digit < 0) throw new Error('Invalid userscript resource encoding');
        if (pending < 0) {pending = digit;continue;}
        const pair = pending + digit * 91;
        buffer |= pair << bits;
        bits += (pair & 8191) > 88 ? 13 : 14;
        while (bits >= 8) {bytes[offset++] = buffer & 255;buffer >>>= 8;bits -= 8;}
        pending = -1;
    }
    if (pending >= 0) {
        if (bits === 0 || pending >= 1 << (8 - bits)) throw new Error('Invalid userscript resource padding');
        bytes[offset++] = (buffer | pending << bits) & 255;
    } else if (buffer !== 0) throw new Error('Invalid userscript resource padding');
    // Check the canonical representation too: redundant final digits can otherwise
    // decode to the same bytes even when the residual bits happen to be zero.
    let encodedIndex = USERSCRIPT_COMPACT_DATA_PREFIX.length, mismatch = 0, checkBuffer = 0, checkBits = 0;
    const checkDigit = (digit: number) => {mismatch |= +(value[encodedIndex++] !== USERSCRIPT_COMPACT_DATA_ALPHABET[digit]);};
    for (let index = 0; index < offset; index++) {
        checkBuffer |= bytes[index]! << checkBits; checkBits += 8;
        if (checkBits > 13) {
            let block = checkBuffer & 8191;
            if (block > 88) {checkBuffer >>>= 13;checkBits -= 13;}
            else {block = checkBuffer & 16383;checkBuffer >>>= 14;checkBits -= 14;}
            checkDigit(block % 91);checkDigit(Math.floor(block / 91));
        }
    }
    if (checkBits) {checkDigit(checkBuffer % 91);if (checkBits > 7 || checkBuffer > 90) checkDigit(Math.floor(checkBuffer / 91));}
    mismatch |= +(encodedIndex !== value.length);
    if (mismatch) throw new Error('Invalid userscript resource padding');
    return bytes.subarray(0, offset);
}

/** 解码构建生成的资源；既有 Base64 的合法空白与异常行为继续由浏览器 atob 决定。 */
export function decodeUserscriptData(value: string): Uint8Array {
    if (value.startsWith(USERSCRIPT_COMPACT_DATA_PREFIX)) return decode91(value);
    if (!value.startsWith(USERSCRIPT_DATA_PREFIX)) {
        return Uint8Array.from(atob(value), character => character.charCodeAt(0));
    }
    const padding = value.charCodeAt(4) - 48;
    const encodedLength = value.length - 5;
    if (!Number.isInteger(padding) || padding < 0 || padding > 3
        || encodedLength % 5 !== 0 || (encodedLength === 0 && padding !== 0)) {
        throw new Error('Invalid userscript resource encoding');
    }
    const bytes = new Uint8Array(encodedLength / 5 * 4 - padding);
    let offset = 0;
    for (let index = 5; index < value.length; index += 5) {
        let block = 0;
        for (let digitIndex = index; digitIndex < index + 5; digitIndex += 1) {
            const digit = digits[value.charCodeAt(digitIndex)];
            if (digit === undefined || digit < 0) throw new Error('Invalid userscript resource character');
            block = block * 85 + digit;
        }
        if (block > 0xffffffff) throw new Error('Invalid userscript resource block');
        for (let shift = 24; shift >= 0; shift -= 8) {
            const byte = (block >>> shift) & 0xff;
            if (offset < bytes.length) bytes[offset] = byte;
            else if (byte !== 0) throw new Error('Invalid userscript resource padding');
            offset += 1;
        }
    }
    return bytes;
}
