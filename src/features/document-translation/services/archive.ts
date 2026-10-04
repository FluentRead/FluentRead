/**
 * @file src/features/document-translation/services/archive.ts
 * 文件职责：为文档及批量 ZIP 导出提供可取消、可报告进度的归档编码边界。
 * 主要内容：消费 JSZip 的公开流接口，按块累积结果；取消时暂停流、释放已收集块并结束 Promise，避免在异步进度回调中抛出未处理异常。
 * 模块边界：只负责归档字节与资源生命周期，不解析文档、调用翻译或维护界面状态；文件内容与压缩兼容策略由调用方指定。
 */
import type JSZip from 'jszip';

export interface DocumentArchiveControls {
    signal?: AbortSignal;
    onProgress?: (percent: number) => void;
}

export function generateDocumentArchive(
    zip: JSZip,
    options: Omit<JSZip.JSZipGeneratorOptions<'uint8array'>, 'type'> = {},
    controls: DocumentArchiveControls = {},
): Promise<Uint8Array> {
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
