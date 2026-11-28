/**
 * @file src/features/document-translation/services/epubBinary.ts
 * 文件职责：负责 ePub 电子书压缩包的受限解析、章节与 OPF 清单读取、XHTML 双语导出、目录标题本地化及 mimetype 首项无压缩归档。
 * 主要内容：校验 ePub 签名与 META-INF 容器结构，按 spine 顺序提取章节文本片段；导出时保持 EPUB2/XHTML 格式兼容、同步更新 NCX/NAV 目录并保留未修改资源的原始压缩方式。
 * 模块边界：仅承担 ePub 二进制压缩包的读写编排，HTML 分段与目录规则分别委托 core/document 与 core/epubNavigation。
 */
import {hasDistinctTranslation} from '@/src/core/translation/result';
import type JSZip from 'jszip';
import {generateDocumentArchive, preserveStoredDocumentEntries} from './archive';
import type {EpubNavigationEntry, EpubNavigationKind, EpubNavigationTarget} from '../core/epubNavigation';
import {
    getDocumentFormatLabel,
    parseDocument,
    renderDocument,
    type DocumentRenderMode,
    type DocumentSegment,
    type EpubDocumentChapter,
    type ParsedDocument,
} from '@/src/features/document-translation/core/document';
import {
    assertArchiveSafety,
    awaitDocumentRead,
    parseXmlAttributes,
    readArchiveText,
    resolveZipPath,
    xmlDecode,
    yieldDocumentTask,
    type CreateDocumentDownloadOptions,
} from './binaryShared';

export function chapterTitle(source: string, fallback: string): string {
    const rawTitle = source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1];
    if (!rawTitle) return fallback;
    const title = xmlDecode(rawTitle.replace(/<[^>]+>/gu, '')).replace(/\s+/gu, ' ').trim();
    return title || fallback;
}

interface EpubManifestItem {
    path: string;
    mediaType: string;
    properties: string[];
}

async function readEpubPackage(zip: JSZip, container: JSZip.JSZipObject, signal?: AbortSignal) {
    const containerXml = await readArchiveText(container, signal);
    const rootfileMatch = containerXml.match(/<rootfile\b([^>]*)\/?\s*>/iu);
    const opfPath = rootfileMatch ? parseXmlAttributes(rootfileMatch[1])['full-path'] : '';
    if (!opfPath || !zip.file(opfPath)) return undefined;

    const opfXml = await readArchiveText(zip.file(opfPath)!, signal);
    const manifest = new Map<string, EpubManifestItem>();
    for (const [, item] of opfXml.matchAll(/<item\b([^>]*)\/?\s*>/giu)) {
        const attributes = parseXmlAttributes(item);
        if (attributes.id && attributes.href) {
            manifest.set(attributes.id, {
                path: resolveZipPath(opfPath, attributes.href),
                mediaType: attributes['media-type'] || '',
                properties: (attributes.properties || '').split(/\s+/u),
            });
        }
    }
    return {opfXml, manifest};
}

export async function parseEpub(fileName: string, bytes: Uint8Array, signal?: AbortSignal): Promise<ParsedDocument> {
    let zip: JSZip;
    try {
        const {default: JSZip} = await import('jszip');
        zip = await awaitDocumentRead(JSZip.loadAsync(bytes), signal);
    } catch (error) {
        signal?.throwIfAborted();
        throw new Error(`ePub 解析失败：${String(error)}`);
    }
    signal?.throwIfAborted();
    assertArchiveSafety(zip, 'ePub');

    const mimetypeEntry = zip.file('mimetype');
    const containerEntry = zip.file('META-INF/container.xml');
    if (!mimetypeEntry || !containerEntry) {
        throw new Error('ePub 文件结构无效：缺少 mimetype 或 META-INF/container.xml');
    }
    const mimetype = (await readArchiveText(mimetypeEntry, signal)).trim();
    if (mimetype !== 'application/epub+zip') {
        throw new Error('ePub 文件签名无效，文件可能已损坏或扩展名不正确');
    }

    const epub = await readEpubPackage(zip, containerEntry, signal);
    if (!epub) throw new Error('ePub 文件结构无效：找不到内容清单 OPF');
    const {opfXml, manifest} = epub;

    const orderedChapters: Array<{path: string; mediaType: string}> = [];
    const itemrefPattern = /<itemref\b([^>]*)\/?\s*>/giu;
    let itemrefMatch = itemrefPattern.exec(opfXml);
    while (itemrefMatch) {
        const idref = parseXmlAttributes(itemrefMatch[1]).idref;
        const entry = idref ? manifest.get(idref) : undefined;
        if (entry && /^(?:application\/xhtml\+xml|text\/html)$/iu.test(entry.mediaType)) orderedChapters.push(entry);
        itemrefMatch = itemrefPattern.exec(opfXml);
    }
    if (orderedChapters.length === 0) {
        manifest.forEach((entry) => {
            if (/^(?:application\/xhtml\+xml|text\/html)$/iu.test(entry.mediaType)) orderedChapters.push(entry);
        });
    }

    const segments: DocumentSegment[] = [];
    const chapters: EpubDocumentChapter[] = [];
    for (const [chapterIndex, {path, mediaType}] of orderedChapters.entries()) {
        const entry = zip.file(path);
        if (!entry) continue;
        const source = await readArchiveText(entry, signal);
        const parsed = parseDocument('chapter.html', source);
        if (parsed.segments.length === 0) continue;
        const title = chapterTitle(source, `第 ${chapterIndex + 1} 章`);
        const segmentOffset = segments.length;
        parsed.segments.forEach((segment, segmentIndex) => {
            segments.push({
                id: segments.length,
                source: segment.source,
                contextLabel: segmentIndex === 0 ? title : undefined,
            });
        });
        chapters.push({path, source, segmentOffset, segmentCount: parsed.segments.length, title, mediaType});
    }

    if (segments.length === 0) throw new Error('ePub 中没有找到可翻译的章节文字');
    return {
        fileName,
        format: 'epub',
        label: getDocumentFormatLabel('epub'),
        parts: [],
        segments,
        binary: {kind: 'epub', bytes, chapters},
    };
}

export async function renderEpub(
    document: ParsedDocument,
    translations: readonly string[],
    mode: DocumentRenderMode,
    options: CreateDocumentDownloadOptions,
): Promise<Uint8Array> {
    if (document.binary?.kind !== 'epub') throw new Error('ePub 文档状态无效，请重新打开文件');
    const {default: JSZip} = await import('jszip');
    options.signal?.throwIfAborted();
    const zip = await awaitDocumentRead(JSZip.loadAsync(document.binary.bytes), options.signal);
    options.signal?.throwIfAborted();
    assertArchiveSafety(zip, 'ePub');
    const {readEpubHeadingTranslations, readEpubNavigation, renderEpubNavigation, resolveEpubNavigationTarget} = await import('../core/epubNavigation');
    const container = zip.file('META-INF/container.xml');
    const epub = container && await readEpubPackage(zip, container, options.signal);
    const packageTag = epub?.opfXml.match(/<package\b([^>]*)>/iu);
    const epub2 = packageTag && parseXmlAttributes(packageTag[1]).version === '2.0';
    const navigation = new Map<string, {
        source: string;
        kind: EpubNavigationKind;
        links: EpubNavigationEntry[];
        targets: Array<EpubNavigationTarget | undefined>;
        rendered?: string;
    }>();
    if (epub) {
        const {opfXml, manifest} = epub;
        const navFiles = [...manifest.values()]
            .filter(item => item.mediaType === 'application/xhtml+xml' && item.properties.includes('nav'))
            .map(item => ({path: item.path, kind: 'xhtml' as const}));
        const spine = opfXml.match(/<spine\b([^>]*)>/iu);
        const ncx = spine ? manifest.get(parseXmlAttributes(spine[1]).toc) : undefined;
        for (const {path, kind} of [
            ...navFiles,
            ...(ncx?.mediaType === 'application/x-dtbncx+xml' ? [{path: ncx.path, kind: 'ncx' as const}] : []),
        ]) {
            const entry = zip.file(path);
            if (!entry) continue;
            const source = await readArchiveText(entry, options.signal);
            const links = readEpubNavigation(source, kind);
            if (links?.length) navigation.set(path, {source, kind, links, targets: links.map(link => resolveEpubNavigationTarget(path, link.href))});
        }
    }
    const destinations = new Set([...navigation.values()].flatMap(file => file.targets.map(target => target?.path)));
    const headings = new Map<string, Map<string, string>>();
    const changedPaths = new Set<string>();
    for (const chapter of document.binary.chapters) {
        await yieldDocumentTask();
        options.signal?.throwIfAborted();
        const parsedChapter = parseDocument('chapter.html', chapter.source);
        const chapterTranslations = translations.slice(chapter.segmentOffset, chapter.segmentOffset + chapter.segmentCount);
        // XHTML chapters must remain XML; do not rewrite literal source/script text while fixing generated line breaks.
        const xhtml = chapter.mediaType === 'application/xhtml+xml' || !chapter.mediaType && /xmlns\s*=\s*["']http:\/\/www\.w3\.org\/1999\/xhtml["']/iu.test(chapter.source);
        const renderOptions = {xhtml: xhtml && epub2 ? 'epub2' as const : xhtml};
        const rendered = renderDocument(parsedChapter, chapterTranslations, mode, Infinity, renderOptions);
        const nav = navigation.get(chapter.path);
        if (nav) nav.rendered = rendered;
        headings.delete(chapter.path);
        if (destinations.has(chapter.path) && parsedChapter.segments.some(({id, source}) => hasDistinctTranslation(source, chapterTranslations[id]))) {
            const localized = mode === 'translated' ? rendered : renderDocument(parsedChapter, chapterTranslations, 'translated', Infinity, renderOptions);
            headings.set(chapter.path, readEpubHeadingTranslations(chapter.source, localized));
        }
        zip.file(chapter.path, rendered);
        changedPaths.add(chapter.path);
    }
    for (const [path, {source, kind, links, targets, rendered = source}] of navigation) {
        options.signal?.throwIfAborted();
        const labels = targets.map(target => target && headings.get(target.path)?.get(target.fragment));
        const updated = renderEpubNavigation(source, links, rendered, kind, mode, labels);
        if (updated !== rendered) {
            zip.file(path, updated);
            changedPaths.add(path);
        }
    }
    preserveStoredDocumentEntries(zip, document.binary.bytes, changedPaths);
    zip.file('mimetype', 'application/epub+zip', {compression: 'STORE'});
    // 更新文件不会改变 JSZip 的键顺序；EPUB 要求 mimetype 是第一条本地记录。
    const {mimetype, ...resources} = zip.files;
    // 整数形资源名也会被普通对象枚举提前；显式枚举顺序保证 mimetype 始终第一。
    zip.files = new Proxy({mimetype, ...resources}, {ownKeys: files => ['mimetype', ...Reflect.ownKeys(files).filter(path => path !== 'mimetype')]});
    return generateDocumentArchive(zip, {
        mimeType: 'application/epub+zip',
        compression: 'DEFLATE',
        compressionOptions: {level: 3},
    }, {signal: options.signal, onProgress: options.onArchiveProgress});
}
