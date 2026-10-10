/**
 * @file src/features/document-translation/services/archive.ts
 * 文件职责：为文档及批量 ZIP 导出提供可取消、可报告进度的归档编码边界。
 * 主要内容：消费 JSZip 的公开流接口，按块累积结果；取消时暂停流并释放块；读取中央目录的压缩方式，只给未修改且名称可确认的原 STORE 条目保留无压缩提示，避免媒体重压；重复名称以最后条目为准，未知编码或 ZIP64 元数据退回普通生成。
 * 模块边界：只负责归档字节、压缩提示和资源生命周期，不解析文档、调用翻译或维护界面状态；调用方提供已修改的路径并保留原有大小/条目安全检查，不依赖 JSZip 私有压缩数据。
 */
import type JSZip from 'jszip';

export interface DocumentArchiveControls {
    signal?: AbortSignal;
    onProgress?: (percent: number) => void;
}

/** Keep unchanged STORE entries in their original compression mode, without inflating media just to deflate it again. */
export function preserveStoredDocumentEntries(zip: JSZip, bytes: Uint8Array, changedPaths: ReadonlySet<string>): void {
    // Compression hints come from the ZIP central directory, not JSZip's private compressed-data objects.
    // Unsupported/malformed metadata is left to JSZip's normal generation path and the caller's archive safety checks.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index -= 1) {
        if (view.getUint32(index, true) === 0x06054b50 && index + 22 + view.getUint16(index + 20, true) === bytes.length) {end = index; break;}
    }
    if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) return;
    const count = view.getUint16(end + 10, true), length = view.getUint32(end + 12, true), start = view.getUint32(end + 16, true);
    if (count === 0xffff || start === 0xffffffff || length === 0xffffffff || start + length > end || view.getUint16(end + 8, true) !== count) return;
    const methods = new Map<string, number>();
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let offset = start;
    for (let index = 0; index < count; index += 1) {
        if (offset + 46 > start + length || view.getUint32(offset, true) !== 0x02014b50) return;
        const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true);
        const nameLength = view.getUint16(offset + 28, true), extraLength = view.getUint16(offset + 30, true), commentLength = view.getUint16(offset + 32, true);
        const next = offset + 46 + nameLength + extraLength + commentLength;
        if (next > start + length) return;
        const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
        let unicodeOverride = false;
        for (let extra = offset + 46 + nameLength; extra + 4 <= offset + 46 + nameLength + extraLength;) {
            const size = view.getUint16(extra + 2, true);
            if (extra + 4 + size > offset + 46 + nameLength + extraLength) return;
            if (view.getUint16(extra, true) === 0x7075) unicodeOverride = true;
            extra += 4 + size;
        }
        // Unknown name decoders could alias a later entry onto an earlier path; leave the whole archive to JSZip.
        if (!(flags & 0x800) && (unicodeOverride || rawName.some(value => value >= 0x80))) return;
        try {methods.set(decoder.decode(rawName), method);} catch {return;}
        offset = next;
    }
    for (const [name, method] of methods) {
        const entry = zip.file(name);
        // JSZip keeps the final duplicate and sanitizes path components; hints must identify that exact original name.
        if (method === 0 && entry?.unsafeOriginalName === name && !changedPaths.has(name)) entry.options.compression = 'STORE';
    }
}

export function generateDocumentArchive(
    zip: JSZip,
    options: Omit<JSZip.JSZipGeneratorOptions<'uint8array'>, 'type'> = {},
    controls: DocumentArchiveControls = {},
): Promise<Uint8Array> {
    if (controls.signal?.aborted) return Promise.reject(controls.signal.reason);
    return new Promise((resolve, reject) => {
        const stream = zip.generateInternalStream({ ...options, type: 'uint8array' });
        let chunks: Uint8Array[] = [];
        let length = 0;
        let finished = false;
        const cleanup = () => {
            chunks = [];
            controls.signal?.removeEventListener('abort', abort);
        };
        const fail = (error: unknown) => {
            if (finished) return;
            finished = true;
            stream.pause();
            cleanup();
            reject(error);
        };
        const abort = () => fail(controls.signal!.reason);
        stream.on('data', (chunk, metadata) => {
            if (finished) return;
            try {
                chunks.push(chunk);
                length += chunk.length;
                controls.onProgress?.(metadata.percent);
            } catch (error) {
                fail(error);
            }
        });
        stream.on('error', fail);
        stream.on('end', () => {
            if (finished) return;
            try {
                const bytes = new Uint8Array(length);
                let offset = 0;
                for (const chunk of chunks) {
                    bytes.set(chunk, offset);
                    offset += chunk.length;
                }
                finished = true;
                cleanup();
                resolve(bytes);
            } catch (error) {
                fail(error);
            }
        });
        controls.signal?.addEventListener('abort', abort, {once: true});
        if (controls.signal?.aborted) abort();
        else stream.resume();
    });
}
