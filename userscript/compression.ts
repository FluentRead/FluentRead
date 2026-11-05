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
            // Safari Userscripts 隔离世界中创建的数据块过不了 WebKit 的 ArrayBuffer 检查；
            // 有意吞掉错误，落到下方的 pako 回退。独立版体积已贴近上限，不再缓存失败状态。
        }
    }
    return inflateWithPako(bytes);
}
