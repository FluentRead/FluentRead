/**
 * @file src/features/document-translation/services/pdfOutline.ts
 * 文件职责：将原生 PDF 章节书签或阅读器识别的标题写入译文 PDF 的标准目录树。
 * 主要内容：有界读取原生书签及命名目的地，保留章节层级；按源页和实际绘制片段记录输出落点，兼容双语左右排版、重排分页与光栅回退；标题有明确片段对应时采用当前译文，否则保留原题。
 * 模块边界：只操作调用方拥有的 pdf-lib 文档和导出几何，不读取文件、网络或浏览器状态，不复制原 PDF 的外部动作；由二进制导出器按需加载。
 */
import {PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, type PDFDocument, type PDFPage} from 'pdf-lib';
import {hasDistinctTranslation} from '@/src/core/translation/result';
import type {ParsedDocument, PdfDocumentPage} from '../core/document';

interface OutlineEntry {title: string; level: number; pageNumber: number; segmentIndex?: number}
interface Destination {page: PDFPage; x: number; y: number}
const MAX_OUTLINE_ITEMS = 10_000;
const MAX_OUTLINE_DEPTH = 64;
const name = PDFName.of;
const text = (value: unknown) => value instanceof PDFString || value instanceof PDFHexString || value instanceof PDFName ? value.decodeText() : undefined;

/** 不指定预期类型的 lookup 对缺失引用返回 undefined；所有可选目录对象随后显式核验类型。 */
function lookup(pdf: PDFDocument, value: unknown): unknown {
    return pdf.context.lookup(value as PDFRef);
}
function get(pdf: PDFDocument, dictionary: unknown, key: string): unknown {
    return dictionary instanceof PDFDict ? lookup(pdf, dictionary.get(name(key))) : undefined;
}

function sourceOutline(pdf: PDFDocument): OutlineEntry[] {
    const pages = new Map(pdf.getPages().map((page, index) => [page.ref.toString(), index + 1]));
    const destinations = new Map<string, unknown>();
    const legacy = get(pdf, pdf.catalog, 'Dests');
    if (legacy instanceof PDFDict) for (const [key, value] of legacy.entries().slice(0, MAX_OUTLINE_ITEMS)) destinations.set(key.decodeText(), value);
    const pending = [get(pdf, get(pdf, pdf.catalog, 'Names'), 'Dests')];
    const seenNames = new Set<unknown>();
    while (pending.length && seenNames.size < MAX_OUTLINE_ITEMS) {
        const node = pending.pop();
        if (!(node instanceof PDFDict) || seenNames.has(node)) continue;
        seenNames.add(node);
        const names = get(pdf, node, 'Names'), kids = get(pdf, node, 'Kids');
        if (names instanceof PDFArray) for (let index = 0; index + 1 < names.size() && destinations.size < MAX_OUTLINE_ITEMS; index += 2) {
            const key = text(lookup(pdf, names.get(index)));
            if (key !== undefined) destinations.set(key, names.get(index + 1));
        }
        if (kids instanceof PDFArray) for (let index = kids.size() - 1; index >= 0 && pending.length < MAX_OUTLINE_ITEMS; index--) pending.push(lookup(pdf, kids.get(index)));
    }
    const pageNumber = (value: unknown): number | undefined => {
        let destination = lookup(pdf, value);
        const key = text(destination);
        if (key !== undefined) destination = lookup(pdf, destinations.get(key));
        if (destination instanceof PDFDict) destination = get(pdf, destination, 'D');
        if (!(destination instanceof PDFArray) || !destination.size()) return undefined;
        const target = destination.get(0);
        return target instanceof PDFRef ? pages.get(target.toString()) : undefined;
    };
    const result: OutlineEntry[] = [];
    const ancestors: OutlineEntry[] = [];
    const stack = [{node: get(pdf, get(pdf, pdf.catalog, 'Outlines'), 'First'), level: 1}];
    const seen = new Set<unknown>();
    while (stack.length && seen.size < MAX_OUTLINE_ITEMS) {
        const {node, level} = stack.pop()!;
        if (!(node instanceof PDFDict) || seen.has(node)) continue;
        seen.add(node);
        while (ancestors.length && ancestors.at(-1)!.level >= level) ancestors.pop();
        stack.push({node: get(pdf, node, 'Next'), level});
        if (level < MAX_OUTLINE_DEPTH) stack.push({node: get(pdf, node, 'First'), level: level + 1});
        const action = get(pdf, node, 'A');
        const target = pageNumber(get(pdf, node, 'Dest')) ?? (get(pdf, action, 'S') === name('GoTo') ? pageNumber(get(pdf, action, 'D')) : undefined);
        const title = text(get(pdf, node, 'Title'));
        if (target !== undefined) for (const ancestor of ancestors) if (!ancestor.pageNumber) ancestor.pageNumber = target;
        if (title?.trim()) {
            const entry = {title, level, pageNumber: target ?? 0};
            result.push(entry); ancestors.push(entry);
        }
    }
    // 无目的地的章节分组跳转到第一个有效子章节，空分组或损坏书签不输出。
    return result.filter(entry => entry.pageNumber > 0);
}

/** 阅读器的标题筛选规则；原生书签缺失时，下载仍包含阅读界面已有的章节。 */
function headingOutline(document: ParsedDocument): OutlineEntry[] {
    if (document.binary?.kind !== 'pdf') return [];
    return document.binary.pages.flatMap(page => page.blocks.flatMap(block => {
        const title = document.segments[block.segmentIndex]?.source.trim();
        if (block.kind !== 'heading' || !title || title.length > 140) return [];
        const numbering = /^(\d+(?:\.\d+)*)\.?\s/u.exec(title)?.[1];
        return [{title, level: Math.min(3, numbering ? numbering.split('.').length : 1), pageNumber: page.pageNumber, segmentIndex: block.segmentIndex}];
    })).slice(0, MAX_OUTLINE_ITEMS);
}

export function createPdfExportOutline(source: PDFDocument, output: PDFDocument, document: ParsedDocument, translations: readonly string[]) {
    const headings = headingOutline(document), native = sourceOutline(source);
    const headingSegments = new Map<string, number | undefined>();
    const headingKey = (entry: OutlineEntry) => JSON.stringify([entry.pageNumber, entry.title.trim()]);
    for (const heading of headings) {
        const key = headingKey(heading);
        headingSegments.set(key, headingSegments.has(key) ? undefined : heading.segmentIndex);
    }
    const entries = native.length ? native.map(entry => {
        const segmentIndex = headingSegments.get(headingKey(entry));
        return segmentIndex === undefined ? entry : {...entry, segmentIndex};
    }) : headings;
    const pageDestinations = new Map<number, Destination>();
    const segmentDestinations = new Map<number, Destination>();
    const setPage = (pageData: PdfDocumentPage, page: PDFPage, x = 0) => {
        if (!pageDestinations.has(pageData.pageNumber)) pageDestinations.set(pageData.pageNumber, {page, x, y: page.getHeight()});
    };
    return {
        layoutPage(pageData: PdfDocumentPage, page: PDFPage, offsetX = 0) {
            setPage(pageData, page, offsetX);
            for (const block of pageData.blocks) {
                if (block.segmentIndex < 0 || segmentDestinations.has(block.segmentIndex)) continue;
                const rotation = pageData.rotation ?? 0;
                const x = rotation === 90 ? pageData.width - block.y - block.height : rotation === 180 ? pageData.width - block.x - block.width : rotation === 270 ? block.y : block.x;
                const y = rotation === 90 ? block.x : rotation === 180 ? pageData.height - block.y - block.height : rotation === 270 ? pageData.height - block.x - block.width : block.y;
                segmentDestinations.set(block.segmentIndex, {page, x: offsetX + x, y: page.getHeight() - y});
            }
        },
        readingPage(pageData: PdfDocumentPage, page: PDFPage, items: readonly {segmentIndex: number; x: number; y: number}[]) {
            setPage(pageData, page);
            for (const item of items) if (item.segmentIndex >= 0 && !segmentDestinations.has(item.segmentIndex)) {
                segmentDestinations.set(item.segmentIndex, {page, x: item.x, y: page.getHeight() - item.y});
            }
        },
        write() {
            const root = output.context.obj({Type: 'Outlines'}), rootRef = output.context.register(root);
            const parents: Array<{level: number; dict: PDFDict; ref: PDFRef; last?: {dict: PDFDict; ref: PDFRef}; count: number}> = [{level: 0, dict: root, ref: rootRef, count: 0}];
            const finish = () => {const parent = parents.pop()!; if (parent.count) parent.dict.set(name('Count'), PDFNumber.of(parent.count));};
            for (const entry of entries) {
                const target = (entry.segmentIndex === undefined ? undefined : segmentDestinations.get(entry.segmentIndex)) ?? pageDestinations.get(entry.pageNumber);
                if (!target) continue;
                while (parents.at(-1)!.level >= entry.level) finish();
                const parent = parents.at(-1)!;
                const translation = entry.segmentIndex === undefined ? undefined : translations[entry.segmentIndex];
                const title = hasDistinctTranslation(entry.title, translation) ? translation! : entry.title;
                const dict = output.context.obj({Title: PDFHexString.fromText(title), Parent: parent.ref,
                    Dest: [target.page.ref, name('XYZ'), Math.max(0, Math.min(target.page.getWidth(), target.x)), Math.max(0, Math.min(target.page.getHeight(), target.y)), null]});
                const ref = output.context.register(dict);
                if (parent.last) {parent.last.dict.set(name('Next'), ref); dict.set(name('Prev'), parent.last.ref);}
                else parent.dict.set(name('First'), ref);
                parent.dict.set(name('Last'), ref); parent.last = {dict, ref};
                for (const ancestor of parents) ancestor.count++;
                parents.push({level: entry.level, dict, ref, count: 0});
            }
            while (parents.length > 1) finish();
            if (parents[0].count) {
                finish();
                output.catalog.set(name('Outlines'), rootRef);
                output.catalog.set(name('PageMode'), name('UseOutlines'));
            }
        },
    };
}
