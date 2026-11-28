/**
 * @file src/features/document-translation/ui/docxPreviewAssets.ts
 * 文件职责：按需惰性读取 DOCX 压缩包内的部件超链接关系与编号定义，为富文本阅读视图提供外链目标与有序列表判定。
 * 主要内容：使用 WeakMap 按原始二进制字节缓存 JSZip 实例及各部件解析结果；提供 loadDocxPartMetadata 定位 `word/_rels/<basename>.rels` 与 `word/numbering.xml`，委托 formatReaders 的纯 XML 解析器提取安全外链映射和有序列表 numId 集合，在压缩包损坏或部件缺失时安全回退为空元数据。
 * 模块边界：本模块只负责只读 DOCX 压缩包辅助元数据加载与缓存，不修改原始文档字节、不操作 DOM 也不参与翻译导出；XML 规则归 ui/formatReaders，主解析与导出归 services/binary。
 */
import type JSZip from 'jszip';
import {parseDocxOrderedNumberingXml, parseDocxRelationshipsXml} from './formatReaders';

export interface DocxPartMetadata {
    rels: Record<string, string>;
    orderedNumIds: ReadonlySet<string>;
}

const docxZipCache = new WeakMap<Uint8Array, Promise<JSZip>>();
const docxMetadataCache = new WeakMap<Uint8Array, Map<string, Promise<DocxPartMetadata>>>();

function loadDocxZip(bytes: Uint8Array): Promise<JSZip> {
    const cached = docxZipCache.get(bytes);
    if (cached) return cached;
    const loading = import('jszip')
        .then(({default: JSZipCtor}) => JSZipCtor.loadAsync(bytes))
        .catch((error) => {
            docxZipCache.delete(bytes);
            throw error;
        });
    docxZipCache.set(bytes, loading);
    return loading;
}

function findZipEntry(zip: JSZip, targetPath: string): JSZip.JSZipObject | null {
    const direct = zip.file(targetPath);
    if (direct) return direct;
    const lowered = targetPath.toLowerCase();
    for (const key of Object.keys(zip.files)) {
        if (key.toLowerCase() === lowered) return zip.files[key];
    }
    return null;
}

function resolveDocxRelsPath(partPath: string): string {
    const normalized = partPath.replace(/\\/gu, '/');
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash < 0) return `_rels/${normalized}.rels`;
    return `${normalized.slice(0, lastSlash)}/_rels/${normalized.slice(lastSlash + 1)}.rels`;
}

/**
 * 惰性加载并缓存指定 DOCX 部件的超链接关系与有序编号集合；
 * 当压缩包无效或关系/编号部件不存在时，优雅返回空集合而不抛出异常。
 */
export function loadDocxPartMetadata(bytes: Uint8Array, partPath: string): Promise<DocxPartMetadata> {
    let byPart = docxMetadataCache.get(bytes);
    if (!byPart) {
        byPart = new Map<string, Promise<DocxPartMetadata>>();
        docxMetadataCache.set(bytes, byPart);
    }
    const cached = byPart.get(partPath);
    if (cached) return cached;

    const pending = (async (): Promise<DocxPartMetadata> => {
        try {
            const zip = await loadDocxZip(bytes);
            const relsEntry = findZipEntry(zip, resolveDocxRelsPath(partPath));
            const numberingEntry = findZipEntry(zip, 'word/numbering.xml');
            const [relsXml, numberingXml] = await Promise.all([
                relsEntry ? relsEntry.async('string') : Promise.resolve(''),
                numberingEntry ? numberingEntry.async('string') : Promise.resolve(''),
            ]);
            return {
                rels: relsXml ? parseDocxRelationshipsXml(relsXml) : {},
                orderedNumIds: numberingXml ? parseDocxOrderedNumberingXml(numberingXml) : new Set<string>(),
            };
        } catch {
            return {rels: {}, orderedNumIds: new Set<string>()};
        }
    })();

    byPart.set(partPath, pending);
    return pending;
}
