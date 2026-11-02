import {inflateWithPako} from '@/userscript/pakoRuntime';
import {decodeUserscriptData} from './dataEncoding';

/** 解开内嵌的 gzip 文本，兼容旧 Base64 与独立版静态数据编码；旧内核继续使用既有 pako。 */
export async function inflateGzipBase64(base64: string): Promise<string> {
    const bytes = decodeUserscriptData(base64);
    if (typeof DecompressionStream === 'function') {
        try {
            const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
            return await new Response(stream).text();
        } catch {
            // Safari Userscripts 的隔离世界会以 "Invalid type should be ArrayBuffer" 拒绝跨域块，改用 pako。
        }
    }
    return inflateWithPako(bytes);
}
