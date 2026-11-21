/**
 * @file src/features/document-translation/core/epubNavigation.ts
 * 文件职责：将已渲染的章节标题用于 EPUB 3 导航文档和旧版 NCX 的目录。
 * 主要内容：解析包内链接及片段锚点，匹配章首、标题或包含标题的容器；按原始 XML 的位置回填标签，保留目录的层级、链接和其他导航。
 * 模块边界：只处理已读入的 XML 与包内路径，不读取归档、不发起翻译请求，也不改变翻译片段和历史记录。
 */
import {decodeHTMLStrict, escapeUTF8} from 'entities';
import {SaxesParser, type SaxesTagNS} from 'saxes';
import {hasDistinctTranslation} from '@/src/core/translation/result';
import type {DocumentRenderMode} from './document';

const XHTML = 'http://www.w3.org/1999/xhtml';
const EPUB = 'http://www.idpf.org/2007/ops';
const NCX = 'http://www.daisy.org/z3986/2005/ncx/';
const headingTag = /^h[1-6]$/u;
const headingContainers = new Set(['article', 'aside', 'body', 'div', 'header', 'hgroup', 'main', 'section']);
type XmlParser = SaxesParser<{xmlns: true}>;

function readXml(source: string, isXhtml: boolean, configure: (parser: XmlParser) => void): boolean {
    const parser = new SaxesParser({xmlns: true});
    // 旧版 XHTML 可能通过标准 DTD 使用命名实体。只查内置的 HTML 字符表，不加载 DTD。
    if (isXhtml) parser.ENTITIES = new Proxy(parser.ENTITIES, {
        get(entities, name: string) {
            const reference = `&${name};`;
            const decoded = entities[name] ?? decodeHTMLStrict(reference);
            return decoded === reference ? undefined : decoded;
        },
    });
    let valid = true;
    parser.on('error', () => {valid = false;});
    configure(parser);
    parser.write(source).close();
    return valid;
}

const attr = (tag: SaxesTagNS, name: string) => tag.attributes[name]?.value;
const anchorId = (tag: SaxesTagNS) => attr(tag, 'id') ?? attr(tag, 'xml:id') ?? (tag.local === 'a' ? attr(tag, 'name') : undefined);
const visibleText = (text: string) => text.replace(/\s+/gu, ' ').trim();
const isTag = (tag: SaxesTagNS | undefined, namespace: string, name: string) => tag?.uri === namespace && tag.local === name;
const textAtTag = (tag: SaxesTagNS) => isTag(tag, XHTML, 'br') ? ' ' : isTag(tag, XHTML, 'img') ? ` ${attr(tag, 'alt') ?? ''} ` : '';

function readHeadings(source: string) {
    const texts: string[] = [];
    const anchors = new Map<string, number>();
    const containers = new Map<number, string>();
    let depth = 0;
    let heading: {depth: number; text: string} | undefined;
    const remember = (id: string) => {if (!anchors.has(id)) anchors.set(id, texts.length);};
    const append = (text: string) => {if (heading) heading.text += text;};
    const valid = readXml(source, true, parser => {
        parser.on('opentag', tag => {
            depth += 1;
            if (tag.uri !== XHTML && tag.uri !== '') return;
            const id = anchorId(tag);
            if (!heading && headingTag.test(tag.local)) {
                heading = {depth, text: ''};
                for (const id of containers.values()) remember(id);
                containers.clear();
            }
            if (heading) {
                if (id) remember(id);
                append(textAtTag(tag));
            } else if (id && headingContainers.has(tag.local)) {
                containers.set(depth, id);
            }
        });
        parser.on('text', append);
        parser.on('cdata', append);
        parser.on('closetag', () => {
            if (heading?.depth === depth) {
                texts.push(visibleText(heading.text));
                heading = undefined;
            }
            containers.delete(depth);
            depth -= 1;
        });
    });
    return valid ? {texts, anchors} : undefined;
}

export function readEpubHeadingTranslations(source: string, translated: string): Map<string, string> {
    const labels = new Map<string, string>();
    if (source === translated) return labels;
    const original = readHeadings(source);
    const localized = readHeadings(translated);
    if (!original || !localized || original.texts.length !== localized.texts.length) return labels;
    const add = (fragment: string, index: number) => {
        const value = localized.texts[index];
        if (hasDistinctTranslation(original.texts[index], value)) labels.set(fragment, value);
    };
    if (original.texts.length) add('', 0);
    for (const [id, index] of original.anchors) add(id, index);
    return labels;
}

export interface EpubNavigationTarget {path: string; fragment: string}

export function resolveEpubNavigationTarget(basePath: string, href: string): EpubNavigationTarget | undefined {
    if (!href.trim() || /[\\\u0000-\u001f\u007f]/u.test(href) || /^\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(href)) return undefined;
    const base = `https://epub.invalid/${basePath.split('/').map(encodeURIComponent).join('/')}`;
    try {
        const url = new URL(href, base);
        return {path: decodeURIComponent(url.pathname.slice(1)), fragment: decodeURIComponent(url.hash.slice(1))};
    } catch {
        return undefined;
    }
}

export type EpubNavigationKind = 'xhtml' | 'ncx';
interface LabelRange {start: number; end: number; text: string; containsAnchor: boolean}
export interface EpubNavigationEntry extends LabelRange {href: string}

function readXhtmlLinks(source: string): EpubNavigationEntry[] | undefined {
    let depth = 0, tocDepth = 0;
    let link: (EpubNavigationEntry & {depth: number}) | undefined;
    const links: EpubNavigationEntry[] = [];
    const append = (text: string) => {if (link) link.text += text;};
    const valid = readXml(source, true, parser => {
        parser.on('opentag', tag => {
            depth += 1;
            if (isTag(tag, XHTML, 'nav') && Object.values(tag.attributes).some(attribute =>
                attribute.uri === EPUB && attribute.local === 'type' && attribute.value.split(/\s+/u).includes('toc'))) {
                tocDepth = depth;
            }
            if (link) {
                link.containsAnchor ||= Boolean(anchorId(tag));
                append(textAtTag(tag));
            } else if (tocDepth && isTag(tag, XHTML, 'a') && !tag.isSelfClosing) {
                link = {href: attr(tag, 'href') ?? '', start: parser.position, end: 0, text: '', depth, containsAnchor: false};
            }
        });
        parser.on('text', append);
        parser.on('cdata', append);
        parser.on('closetag', () => {
            if (link?.depth === depth) {
                link.end = source.lastIndexOf('</', parser.position - 1);
                links.push(link);
                link = undefined;
            }
            if (depth === tocDepth) tocDepth = 0;
            depth -= 1;
        });
    });
    return valid ? links : undefined;
}

function readNcxLinks(source: string): EpubNavigationEntry[] | undefined {
    const ancestry: SaxesTagNS[] = [];
    const points: Array<{tag: SaxesTagNS; href: string; labels: LabelRange[]}> = [];
    const links: EpubNavigationEntry[] = [];
    let label: (LabelRange & {tag: SaxesTagNS}) | undefined;
    const append = (text: string) => {if (label) label.text += text;};
    const valid = readXml(source, false, parser => {
        parser.on('opentag', tag => {
            const parent = ancestry.at(-1);
            const point = points.at(-1);
            if (isTag(tag, NCX, 'navPoint') && (isTag(parent, NCX, 'navMap') || (point && parent === point.tag))) {
                points.push({tag, href: '', labels: []});
            } else if (point && isTag(tag, NCX, 'content') && parent === point.tag) {
                point.href = attr(tag, 'src') ?? '';
            } else if (point && isTag(tag, NCX, 'text') && isTag(parent, NCX, 'navLabel') && ancestry.at(-2) === point.tag && !tag.isSelfClosing) {
                label = {tag, start: parser.position, end: 0, text: '', containsAnchor: false};
                point.labels.push(label);
            }
            ancestry.push(tag);
        });
        parser.on('text', append);
        parser.on('cdata', append);
        parser.on('closetag', tag => {
            if (label?.tag === tag) {
                label.end = source.lastIndexOf('</', parser.position - 1);
                label = undefined;
            }
            const point = points.at(-1);
            if (point?.tag === tag) {
                for (const label of point.labels) links.push({...label, href: point.href});
                points.pop();
            }
            ancestry.pop();
        });
    });
    return valid ? links.sort((left, right) => left.start - right.start) : undefined;
}

export function readEpubNavigation(source: string, kind: EpubNavigationKind): EpubNavigationEntry[] | undefined {
    return kind === 'xhtml' ? readXhtmlLinks(source) : readNcxLinks(source);
}

export function renderEpubNavigation(
    source: string,
    original: readonly EpubNavigationEntry[],
    rendered: string,
    kind: EpubNavigationKind,
    mode: DocumentRenderMode,
    translations: readonly (string | undefined)[],
): string {
    if (!translations.some(Boolean)) return rendered;
    const current = source === rendered ? original : readEpubNavigation(rendered, kind);
    if (!current || original.length !== current.length || current.some((entry, index) => entry.href !== original[index].href)) return rendered;
    const parts: string[] = [];
    let cursor = 0;
    for (const [index, entry] of current.entries()) {
        const label = original[index];
        const translation = translations[index];
        if (!translation || !visibleText(label.text) || (mode === 'translated' && label.containsAnchor)) continue;
        const originalLabel = source.slice(label.start, label.end);
        let replacement = originalLabel;
        if (hasDistinctTranslation(label.text, translation)) {
            const escaped = escapeUTF8(translation);
            replacement = mode === 'bilingual' ? `${originalLabel} / ${escaped}` : escaped;
        }
        parts.push(rendered.slice(cursor, entry.start), replacement);
        cursor = entry.end;
    }
    return parts.join('') + rendered.slice(cursor);
}
