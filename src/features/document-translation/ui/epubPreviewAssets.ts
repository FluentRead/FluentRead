/**
 * @file src/features/document-translation/ui/epubPreviewAssets.ts
 * 文件职责：按需惰性解压 ePub 归档，将当前章节引用的包内图片解析为可释放的 blob URL、内联净化后的章节样式表，并从 nav.xhtml 或 toc.ncx 加载真实嵌套目录。
 * 主要内容：使用 WeakMap 按原始字节缓存 JSZip 实例；提供 sanitizeEpubCss 剥离远程 @import、外链 url() 与脚本表达式；提供 resolveEpubChapterAssets 解析章节 HTML 内的 img/image 资源与 link 样式表并返回幂等 revoke() 释放函数；提供 loadEpubNestedToc 结合 core/epubNavigation 与 SaxesParser 解析嵌套层级并映射到章节序号与片段锚点。
 * 模块边界：本模块只做只读归档资源提取与展示安全净化，不修改原始 ePub 字节、不发起网络请求也不直接操作 iframe DOM；导出打包归 services/binary 与 services/archive，导航回填归 core/epubNavigation。
 */
import type JSZip from 'jszip';
import {decodeHTMLStrict} from 'entities/lib/decode.js';
import {SaxesParser, type SaxesTagNS} from 'saxes';
import type {EpubDocumentChapter} from '../core/document';
import {readEpubNavigation, resolveEpubNavigationTarget} from '../core/epubNavigation';

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const EPUB_NS = 'http://www.idpf.org/2007/ops';
const NCX_NS = 'http://www.daisy.org/z3986/2005/ncx/';

const epubZipCache = new WeakMap<Uint8Array, Promise<JSZip>>();

/** 按 Uint8Array 引用惰性加载并缓存 JSZip 实例；失败时清除缓存以便重试。 */
export function loadEpubZip(bytes: Uint8Array): Promise<JSZip> {
    const cached = epubZipCache.get(bytes);
    if (cached) return cached;
    const loading = import('jszip')
        .then(({default: JSZipCtor}) => JSZipCtor.loadAsync(bytes))
        .catch((error) => {
            epubZipCache.delete(bytes);
            throw error;
        });
    epubZipCache.set(bytes, loading);
    return loading;
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    avif: 'image/avif',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
};

function mimeTypeForAsset(path: string): string {
    const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/u)?.[1] ?? '';
    return IMAGE_MIME_BY_EXT[ext] ?? 'application/octet-stream';
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

const ALLOWED_CSS_URL_PATTERN = /^(?:data:image\/(?:png|jpeg|jpg|gif|webp|avif|bmp|x-icon);base64,|data:font\/|blob:)/iu;

function decodeCssEscapes(value: string): string {
    return value.replace(/\\([0-9a-f]{1,6})[ \t\r\n\f]?|\\([^\r\n\f])/giu, (_, hex: string | undefined, literal: string | undefined) => {
        if (literal !== undefined) return literal;
        const code = Number.parseInt(hex!, 16);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });
}

/**
 * 净化包内 CSS：先剥离注释并解码反斜杠转义，再按引号感知规则移除 `@import`、脚本表达式与遗留绑定；
 * `url(...)` 仅白名单放行安全位图/字体 data URI 与 blob URL，并无条件转义所有 `<` 防止 `</style>` 逃逸。
 */
export function sanitizeEpubCss(css: string): string {
    const uncommented = css.replace(/\/\*[\s\S]*?\*\//gu, '');
    const normalized = decodeCssEscapes(uncommented);
    return normalized
        .replace(/@import\b(?:[^;"'\r\n}]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')*(?:;|\r?\n|(?=\})|$)/giu, '')
        .replace(/expression\s*\((?:[^;"'\r\n}]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')*/giu, 'none')
        .replace(/(?:-moz-binding|behavior)\s*:(?:[^;"'\r\n}]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')*;?/giu, '')
        .replace(/url\s*\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)]*))\s*\)/giu, (_, dq: string | undefined, sq: string | undefined, bare: string | undefined) => {
            const raw = (dq ?? sq ?? bare!).trim();
            return ALLOWED_CSS_URL_PATTERN.test(raw) ? `url("${raw.replace(/"/gu, '\\"')}")` : 'none';
        })
        .replace(/</gu, '\\3c ');
}

function parseAttributes(source: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (const match of source.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
        attrs[match[1].toLowerCase()] = match[2] ?? match[3]!;
    }
    return attrs;
}

export interface ResolvedEpubChapterAssets {
    html: string;
    inlineCss: string;
    blobUrls: string[];
    revoke: () => void;
}

const SKIPPED_ASSET_URL = /^(?:data:|blob:|https?:|\/\/|#)/iu;

/**
 * 解析当前 ePub 章节引用的包内图片与样式表：
 * - `<link rel="stylesheet">` 读入并经 `sanitizeEpubCss` 净化后内联注入 `<style data-epub-stylesheet="true">`；
 * - `<img src>` 与 SVG `<image href/xlink:href>` 解压并生成 `blob:` URL；
 * - 返回幂等 `revoke()` 清理函数，切换章节或卸载时释放全部对象 URL。
 */
export async function resolveEpubChapterAssets(
    bytes: Uint8Array,
    chapterPath: string,
    chapterHtml: string,
): Promise<ResolvedEpubChapterAssets> {
    const zip = await loadEpubZip(bytes);
    const cssChunks: string[] = [];

    const linkMatches = Array.from(chapterHtml.matchAll(/<link\b([^>]*)\/?\s*>/giu));
    let html = chapterHtml;
    for (const match of linkMatches) {
        const attrs = parseAttributes(match[1]);
        const relTokens = (attrs.rel ?? '').toLowerCase().split(/\s+/u);
        if (!relTokens.includes('stylesheet') || !attrs.href) continue;
        const resolved = resolveEpubNavigationTarget(chapterPath, attrs.href);
        if (resolved) {
            const entry = findZipEntry(zip, resolved.path);
            if (entry) {
                const rawCss = await entry.async('string');
                const safeCss = sanitizeEpubCss(rawCss).trim();
                if (safeCss) cssChunks.push(safeCss);
            }
        }
        html = html.replace(match[0], () => '');
    }

    const inlineCss = cssChunks.join('\n');
    if (inlineCss) {
        const styleTag = `<style data-epub-stylesheet="true">${inlineCss}</style>`;
        html = /<\/head\s*>/iu.test(html)
            ? html.replace(/<\/head\s*>/iu, () => `${styleTag}</head>`)
            : `${styleTag}${html}`;
    }

    const urlByAssetPath = new Map<string, string>();
    const blobUrls: string[] = [];
    let revoked = false;
    const revoke = () => {
        if (revoked) return;
        revoked = true;
        for (const url of blobUrls) URL.revokeObjectURL(url);
        blobUrls.length = 0;
    };

    const resolveImageUrl = async (rawSrc: string): Promise<string | null> => {
        const trimmed = rawSrc.trim();
        if (!trimmed || SKIPPED_ASSET_URL.test(trimmed)) return null;
        const resolved = resolveEpubNavigationTarget(chapterPath, trimmed);
        if (!resolved) return null;
        const existing = urlByAssetPath.get(resolved.path);
        if (existing) return existing;
        const entry = findZipEntry(zip, resolved.path);
        if (!entry) return null;
        const data = await entry.async('uint8array');
        const blob = new Blob([data.slice()], {type: mimeTypeForAsset(resolved.path)});
        const objectUrl = URL.createObjectURL(blob);
        urlByAssetPath.set(resolved.path, objectUrl);
        blobUrls.push(objectUrl);
        return objectUrl;
    };

    const imageTagPattern = /<(img|image)\b([^>]*?)(\/?)>/giu;
    const tagMatches = Array.from(html.matchAll(imageTagPattern));
    if (tagMatches.length > 0) {
        try {
            const pieces: string[] = [];
            let cursor = 0;
            for (const match of tagMatches) {
                pieces.push(html.slice(cursor, match.index));
                cursor = match.index + match[0].length;
                const tagName = match[1];
                const attrSource = match[2];
                const selfClose = match[3];
                const attrPattern = tagName.toLowerCase() === 'img'
                    ? /(\bsrc\s*=\s*)(?:"([^"]*)"|'([^']*)')/iu
                    : /(\b(?:xlink:href|href)\s*=\s*)(?:"([^"]*)"|'([^']*)')/iu;
                const attrMatch = attrSource.match(attrPattern);
                if (!attrMatch) {
                    pieces.push(match[0]);
                    continue;
                }
                const rawUrl = attrMatch[2] ?? attrMatch[3]!;
                const blobUrl = await resolveImageUrl(rawUrl);
                if (!blobUrl) {
                    pieces.push(match[0]);
                    continue;
                }
                const updatedAttrs = attrSource.replace(attrPattern, () => `${attrMatch[1]}"${blobUrl}"`);
                pieces.push(`<${tagName}${updatedAttrs}${selfClose}>`);
            }
            pieces.push(html.slice(cursor));
            html = pieces.join('');
        } catch (error) {
            revoke();
            throw error;
        }
    }

    return {html, inlineCss, blobUrls, revoke};
}

export interface EpubTocItem {
    id: string;
    title: string;
    level: number;
    chapterIndex: number;
    fragment: string;
    href: string;
}

function runTocXmlParser(
    source: string,
    isXhtml: boolean,
    configure: (parser: SaxesParser<{xmlns: true}>) => void,
): boolean {
    const parser = new SaxesParser({xmlns: true});
    if (isXhtml) {
        parser.ENTITIES = new Proxy(parser.ENTITIES, {
            get(entities, name: string) {
                const reference = `&${name};`;
                const decoded = entities[name] ?? decodeHTMLStrict(reference);
                return decoded === reference ? undefined : decoded;
            },
        });
    }
    let valid = true;
    parser.on('error', () => {valid = false;});
    configure(parser);
    parser.write(source).close();
    return valid;
}

/** 解析 ePub 导航文档的 1-based 嵌套层级，支持 XHTML 命名实体与异常安全回退。 */
export function readEpubTocLevels(source: string, kind: 'xhtml' | 'ncx'): number[] {
    if (kind === 'xhtml') {
        const levels: number[] = [];
        let depth = 0;
        let tocDepth = 0;
        let olDepth = 0;
        let inLink = false;
        const valid = runTocXmlParser(source, true, (parser) => {
            parser.on('opentag', (tag: SaxesTagNS) => {
                depth += 1;
                if (tag.uri === XHTML_NS && tag.local === 'nav' && Object.values(tag.attributes).some((attr) =>
                    attr.uri === EPUB_NS && attr.local === 'type' && attr.value.split(/\s+/u).includes('toc'))) {
                    tocDepth = depth;
                }
                if (!tocDepth) return;
                if (tag.uri === XHTML_NS && tag.local === 'ol') olDepth += 1;
                else if (!inLink && tag.uri === XHTML_NS && tag.local === 'a' && !tag.isSelfClosing) {
                    inLink = true;
                    levels.push(Math.max(1, olDepth));
                }
            });
            parser.on('closetag', (tag: SaxesTagNS) => {
                if (tocDepth) {
                    if (tag.uri === XHTML_NS && tag.local === 'a') inLink = false;
                    else if (tag.uri === XHTML_NS && tag.local === 'ol') olDepth = Math.max(0, olDepth - 1);
                    if (depth === tocDepth) tocDepth = 0;
                }
                depth -= 1;
            });
        });
        return valid ? levels : [];
    }

    const entries: Array<{start: number; level: number}> = [];
    const ancestry: SaxesTagNS[] = [];
    const points: SaxesTagNS[] = [];
    const valid = runTocXmlParser(source, false, (parser) => {
        parser.on('opentag', (tag: SaxesTagNS) => {
            const parent = ancestry.at(-1);
            const point = points.at(-1);
            if (tag.uri === NCX_NS && tag.local === 'navPoint'
                && ((parent?.uri === NCX_NS && parent.local === 'navMap') || (point && parent === point))) {
                points.push(tag);
            } else if (point && tag.uri === NCX_NS && tag.local === 'text'
                && parent?.uri === NCX_NS && parent.local === 'navLabel'
                && ancestry.at(-2) === point && !tag.isSelfClosing) {
                entries.push({start: parser.position, level: points.length});
            }
            ancestry.push(tag);
        });
        parser.on('closetag', (tag: SaxesTagNS) => {
            if (points.at(-1) === tag) points.pop();
            ancestry.pop();
        });
    });
    return valid ? entries.sort((left, right) => left.start - right.start).map((item) => item.level) : [];
}

/** 把解析出的导航项与嵌套层级映射为章节索引与片段锚点；缺失层级安全回退到 1。 */
export function buildEpubTocItems(
    navPath: string,
    entries: readonly {text: string; href: string}[],
    levels: readonly number[],
    chapters: readonly EpubDocumentChapter[],
): EpubTocItem[] {
    const chapterIndexByPath = new Map<string, number>();
    const chapterIndexByLowerPath = new Map<string, number>();
    chapters.forEach((chapter, index) => {
        chapterIndexByPath.set(chapter.path, index);
        chapterIndexByLowerPath.set(chapter.path.toLowerCase(), index);
    });

    const items: EpubTocItem[] = [];
    entries.forEach((entry, index) => {
        const title = entry.text.replace(/\s+/gu, ' ').trim();
        if (!title) return;
        const target = resolveEpubNavigationTarget(navPath, entry.href);
        const chapterIndex = target
            ? (chapterIndexByPath.get(target.path) ?? chapterIndexByLowerPath.get(target.path.toLowerCase()) ?? -1)
            : -1;
        items.push({
            id: `toc-${index}`,
            title,
            level: levels[index] ?? 1,
            chapterIndex,
            fragment: target?.fragment ?? '',
            href: entry.href,
        });
    });
    return items;
}

/**
 * 读取 ePub 的真实嵌套目录（优先 EPUB 3 `nav.xhtml`，回退 EPUB 2 `toc.ncx`），
 * 并将每项映射到 `chapters` 数组中的章节索引与片段锚点。
 */
export async function loadEpubNestedToc(
    bytes: Uint8Array,
    chapters: readonly EpubDocumentChapter[],
): Promise<EpubTocItem[]> {
    const zip = await loadEpubZip(bytes);
    const containerEntry = findZipEntry(zip, 'META-INF/container.xml');
    if (!containerEntry) return [];
    const containerXml = await containerEntry.async('string');
    const rootfileMatch = containerXml.match(/<rootfile\b([^>]*)\/?\s*>/iu);
    const opfPath = rootfileMatch ? parseAttributes(rootfileMatch[1])['full-path'] : '';
    const opfEntry = opfPath ? findZipEntry(zip, opfPath) : null;
    if (!opfEntry) return [];

    const opfXml = await opfEntry.async('string');
    const manifest = new Map<string, {path: string; mediaType: string; properties: string[]}>();
    for (const match of opfXml.matchAll(/<item\b([^>]*)\/?\s*>/giu)) {
        const attrs = parseAttributes(match[1]);
        if (!attrs.id || !attrs.href) continue;
        const resolved = resolveEpubNavigationTarget(opfPath, attrs.href);
        if (!resolved) continue;
        manifest.set(attrs.id, {
            path: resolved.path,
            mediaType: attrs['media-type'] ?? '',
            properties: (attrs.properties ?? '').split(/\s+/u),
        });
    }

    let navPath = '';
    let navKind: 'xhtml' | 'ncx' = 'xhtml';
    for (const item of manifest.values()) {
        if (item.properties.includes('nav')) {
            navPath = item.path;
            navKind = 'xhtml';
            break;
        }
    }
    if (!navPath) {
        const spineTocId = opfXml.match(/<spine\b([^>]*)>/iu)?.[1]
            ? parseAttributes(opfXml.match(/<spine\b([^>]*)>/iu)![1]).toc
            : undefined;
        const ncxItem = (spineTocId ? manifest.get(spineTocId) : undefined)
            ?? Array.from(manifest.values()).find((item) => item.mediaType.toLowerCase() === 'application/x-dtbncx+xml');
        if (!ncxItem) return [];
        navPath = ncxItem.path;
        navKind = 'ncx';
    }

    const navEntry = findZipEntry(zip, navPath);
    if (!navEntry) return [];
    const navSource = await navEntry.async('string');
    const entries = readEpubNavigation(navSource, navKind);
    if (!entries || entries.length === 0) return [];
    const levels = readEpubTocLevels(navSource, navKind);
    return buildEpubTocItems(navPath, entries, levels, chapters);
}
