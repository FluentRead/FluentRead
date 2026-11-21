/**
 * @file src/features/selection-translation/dictionary/mdictKeys.ts
 * 文件职责：解开 MDict v2 公开索引的标准字节混淆，兼容常见 Encrypted=2 词库。
 * 主要内容：按 RIPEMD-128 算法规范独立实现索引密钥摘要和字节变换；不支持受密码保护的正文，不将此旧摘要用于凭据安全。
 * 模块边界：纯字节算法，不接触用户密码、浏览器、网络或文件；算法依据见官方 RIPEMD-128 伪代码与公开测试向量。
 */
const order = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8],
    [3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12],
    [1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2],
    [5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12],
    [6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2],
    [15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13],
    [8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14],
];
const shifts = [
    [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8],
    [7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12],
    [11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5],
    [11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12],
    [8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6],
    [9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11],
    [9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5],
    [15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8],
];
const constants = [0, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0];
export function mdictKeyDigest(input: Uint8Array): Uint8Array {
    const bytes = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
    bytes.set(input); bytes[input.length] = 0x80;
    const view = new DataView(bytes.buffer);
    view.setBigUint64(bytes.length - 8, BigInt(input.length) * 8n, true);
    let h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
    for (let block = 0; block < bytes.length; block += 64) {
        const result: number[][] = [];
        for (let lane = 0; lane < 2; lane++) {
            let [a, b, c, d] = h;
            for (let round = 0; round < 4; round++) for (let step = 0; step < 16; step++) {
                const functionId = lane === 0 ? round : 3 - round;
                const f = functionId === 0 ? b ^ c ^ d : functionId === 1 ? (b & c) | (~b & d) : functionId === 2 ? (b | ~c) ^ d : (b & d) | (c & ~d);
                const row = lane * 4 + round;
                const sum = (a + f + view.getUint32(block + order[row][step] * 4, true) + constants[row]) | 0;
                const rotate = shifts[row][step];
                const next = (sum << rotate) | (sum >>> (32 - rotate));
                a = d; d = c; c = b; b = next;
            }
            result.push([a, b, c, d]);
        }
        const [left, right] = result;
        h = [(h[1] + left[2] + right[3]) | 0, (h[2] + left[3] + right[0]) | 0, (h[3] + left[0] + right[1]) | 0, (h[0] + left[1] + right[2]) | 0];
    }
    const digest = new Uint8Array(16); const output = new DataView(digest.buffer);
    h.forEach((word, index) => output.setUint32(index * 4, word, true));
    return digest;
}
export function decodeMdictKeyInfo(bytes: Uint8Array): Uint8Array {
    if (bytes.length < 8) throw new Error('Invalid MDict key index');
    const seed = new Uint8Array(8); seed.set(bytes.subarray(4, 8)); seed.set([0x95, 0x36, 0, 0], 4);
    const key = mdictKeyDigest(seed);
    const output = bytes.slice(); let previous = 0x36;
    for (let i = 8; i < bytes.length; i++) {
        const byte = bytes[i];
        output[i] = ((byte >>> 4) | (byte << 4)) ^ previous ^ ((i - 8) & 255) ^ key[(i - 8) % 16];
        previous = byte;
    }
    return output;
}
