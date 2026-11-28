/**
 * @file src/features/document-translation/ui/presentation.ts
 * 文件职责：提供文档翻译界面使用的纯展示派生规则，把 ParsedDocument 转换成空状态提示、格式特定的文本标签与安全字幕富文本片段。
 * 主要内容：相同译文保留原文且不重复展示；包含小型本地范例、有界导出预览、格式判断、DOCX 部件名称映射、按二进制结构生成可本地化的位置索引、阅读器文本清理、译文占位符判断，以及将 VTT 说话人标签与 SRT/VTT/ASS 粗斜体下划线样式解析为安全结构化文本节点的 parseSubtitleRichText。
 * 模块边界：本文件不创建 DOM、不解析文件也不调用翻译；它只消费 core 模型并返回 UI 可直接使用的值，实际预览 HTML 归 core/preview，PDF 位图和导出分别归 pdfPreview 与 binary。
 */
import {hasDistinctTranslation} from '@/src/core/translation/result';
import {getDocxPartLabel, renderDocument, resolveDocumentTranslation, type DocumentFormat, type DocumentRenderMode, type ParsedDocument} from '@/src/features/document-translation/core/document';
import {stripDocumentInlineMarkers} from '@/src/core/translation/documentInlineMarkers';

/** 小型本地范例只走正常导入流程，不预填译文或自动发起翻译。 */
export const DOCUMENT_QUICK_SAMPLES = [
    {name: 'reading-sample.md', label: '文章', description: '标题、段落与列表', content: '# A small reading guide\n\nA good book opens a window to another world.\n\n- Read a little every day.\n- Keep the words that matter to you.\n'},
    {name: 'subtitle-sample.srt', label: '字幕文件', description: '时间轴与多行字幕', content: '1\n00:00:01,000 --> 00:00:03,000\nWelcome to a new story.\n\n2\n00:00:04,000 --> 00:00:07,000\nTake your time.\nEnjoy every moment.\n'},
    {name: 'language-sample.json', label: '语言文件', description: '字符串与嵌套结构', content: '{\n  "title": "A new beginning",\n  "actions": {"read": "Start reading", "save": "Save for later"},\n  "version": 1,\n  "enabled": true\n}\n'},
] as const;

/** 大型 JSON 与二进制格式使用文字摘录，避免为了弹窗复制整棵 JSON 数据。 */
export function isDocumentExportExcerpt(document: ParsedDocument): boolean {
    return Boolean(document.binary) || (document.format === 'json' && document.segments.length > 200);
}

/** 文本格式使用有界导出编码，摘录格式仅访问前几个片段。 */
export function getDocumentExportPreview(document: ParsedDocument, translations: readonly string[], mode: DocumentRenderMode): string {
    const text = isDocumentExportExcerpt(document)
        ? document.segments.slice(0, 3).map(segment => {
            const clean = segment.docxInline ? stripDocumentInlineMarkers : (value: string) => value;
            const translation = clean(resolveDocumentTranslation(segment.source, translations[segment.id])).slice(0, 1601);
            return mode === 'bilingual' && hasDistinctTranslation(segment.source, translations[segment.id])
                ? `${clean(segment.source).slice(0, 1601)}\n${translation}` : translation;
        }).join('\n\n')
        : renderDocument(document, translations, mode, 1601);
    return text.length > 1600 ? `${text.slice(0, 1600)}\n…` : text;
}

const SUBTITLE_FORMATS = new Set<DocumentFormat>(['srt', 'vtt', 'ass', 'lrc']);
const RICH_FORMATS = new Set<DocumentFormat>(['epub', 'html', 'markdown', 'txt']);

export function isSubtitleDocumentFormat(format?: DocumentFormat): boolean {
    return format !== undefined && SUBTITLE_FORMATS.has(format);
}

export function isRichDocumentFormat(format?: DocumentFormat): boolean {
    return format !== undefined && RICH_FORMATS.has(format);
}

export function getDocumentEmptyReaderHint(document: ParsedDocument | null): string {
    if (document?.binary?.kind === 'pdf') {
        return 'document.pdfReading.startHint';
    }
    if (isSubtitleDocumentFormat(document?.format)) {
        return '点击“开始翻译”，译文会出现在对应时间轴行中。';
    }
    if (document?.format === 'json') {
        return '点击“开始翻译”，只会填充每个 JSON 路径对应的字符串译文。';
    }
    return '点击“开始翻译”，译文会按当前文档的阅读结构显示。';
}

export {getDocxPartLabel};

/** 只本地化有解析结构证明的位置，不能根据中文形状猜测或改写用户章节、JSON 路径和历史标题。 */
export function getDocumentGeneratedPositionLabels(
    document: ParsedDocument,
    pageLabel: (page: number) => string,
    localize: (label: string) => string,
): ReadonlyMap<number, string> {
    const labels = new Map<number, string>();
    if (document.binary?.kind === 'pdf') {
        for (const page of document.binary.pages) {
            const label = pageLabel(page.pageNumber);
            for (const index of page.segmentIndexes) {
                const segment = document.segments[index];
                if (segment) labels.set(segment.id, label);
            }
        }
    } else if (document.binary?.kind === 'docx') {
        for (const part of document.binary.parts) {
            const label = localize(getDocxPartLabel(part.path));
            for (const {segmentIndex} of part.paragraphSegments) {
                const segment = document.segments[segmentIndex];
                if (segment) labels.set(segment.id, label);
            }
        }
    }
    return labels;
}

/** 整句送翻时代替行内标签和 Markdown 语法的编号占位符：`<g1>`、`</g1>`、`<g2/>`。 */
const DOCUMENT_PLACEHOLDER = /<\/?g\d+\/?>/gu;

/** 译文里是否带有编号占位符；带有时校订视图提示保留它们才能保留原来的格式。 */
export function hasDocumentPlaceholder(value: string | undefined): boolean {
    return Boolean(value) && /<\/?g\d+\/?>/u.test(value!);
}

export function formatDocumentReaderText(format: DocumentFormat | undefined, value: string, docxInline?: true): string {
    if (docxInline) return stripDocumentInlineMarkers(value).trim();
    if (format === 'html' || format === 'epub') return value.replace(/<[^>]+>/gu, '').trim();
    if (format === 'markdown') {
        return value
            .replace(DOCUMENT_PLACEHOLDER, '')
            .replace(/^\s{0,3}#{1,6}\s+/u, '')
            .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
            .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
            .replace(/`{1,3}([^`]+)`{1,3}/gu, '$1')
            .replace(/(\*\*|__)(.*?)\1/gu, '$2')
            .trim();
    }
    if (format !== undefined && ['srt', 'vtt', 'ass'].includes(format)) {
        // ASS 用 \N、\n 表示换行、\h 表示不换行空格：阅读时显示成真正的换行和空格，而不是这几个字符。
        // 被翻译服务转成实体的样式标签（&lt;i&gt;）同样不属于可见文字。
        const text = value.replace(/<[^>]+>/gu, '').replace(/&lt;\s*\/?\s*[a-z][^&<>]*&gt;/giu, '').replace(/\{\\[^}]+\}/gu, '');
        return (format === 'ass' ? text.replace(/\\[Nn]/gu, '\n').replace(/\\h/gu, ' ') : text).trim();
    }
    return value.trim();
}

export interface SubtitleTextRun {
    text: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
}

export interface ParsedSubtitleRichText {
    speaker?: string;
    runs: SubtitleTextRun[];
}

/**
 * 安全解析字幕里的 VTT 说话人标签与 SRT/VTT/ASS 粗体/斜体/下划线标记，返回纯数据片段数组，
 * 避免上层使用 innerHTML 触发脚本注入。
 */
export function parseSubtitleRichText(
    format: DocumentFormat | undefined,
    value: string,
): ParsedSubtitleRichText {
    let source = value;
    let speaker: string | undefined;
    if (format === 'vtt') {
        const voice = source.match(/^\s*<v(?:\.[^>\s]+)*\s+([^>]+)>/iu);
        if (voice) {
            const candidate = voice[1].trim();
            if (candidate) speaker = candidate;
            source = source.slice(voice[0].length);
        }
    }
    if (format === 'ass') {
        source = source.replace(/\\[Nn]/gu, '\n').replace(/\\h/gu, ' ');
    }
    // 把翻译服务实体化的常见样式标签归一化后再交给安全状态机，未知标签仍会被剥离。
    source = source.replace(/&lt;\s*(\/?)\s*([biu])\s*&gt;/giu, '<$1$2>')
        .replace(/&lt;\s*\/?\s*[a-z][^&<>]*&gt;/giu, '');

    let bold = false;
    let italic = false;
    let underline = false;
    const rawRuns: SubtitleTextRun[] = [];
    const pushRun = (text: string) => {
        if (!text) return;
        const prev = rawRuns.at(-1);
        if (prev && Boolean(prev.bold) === bold && Boolean(prev.italic) === italic && Boolean(prev.underline) === underline) {
            prev.text += text;
            return;
        }
        rawRuns.push({
            text,
            ...(bold ? {bold: true} : {}),
            ...(italic ? {italic: true} : {}),
            ...(underline ? {underline: true} : {}),
        });
    };

    const tokenPattern = /<(\/?)([a-z][a-z0-9.-]*)(?:\s[^>]*)?>|\{(\\[^}]+)\}/giu;
    let cursor = 0;
    for (const match of source.matchAll(tokenPattern)) {
        pushRun(source.slice(cursor, match.index));
        cursor = match.index + match[0].length;
        if (match[2]) {
            const closing = Boolean(match[1]);
            const tag = match[2].toLowerCase();
            if (tag === 'b') bold = !closing;
            else if (tag === 'i') italic = !closing;
            else if (tag === 'u') underline = !closing;
        } else {
            const overrides = match[3];
            for (const code of overrides.matchAll(/\\(?:(b|i|u)(\d*)|(r))(?![a-z])/giu)) {
                if (code[3]) {
                    bold = false;
                    italic = false;
                    underline = false;
                } else {
                    const name = code[1].toLowerCase();
                    const active = code[2] !== '0';
                    if (name === 'b') bold = active;
                    else if (name === 'i') italic = active;
                    else underline = active;
                }
            }
        }
    }
    pushRun(source.slice(cursor));

    while (rawRuns.length && !rawRuns[0].text.trim()) rawRuns.shift();
    while (rawRuns.length && !rawRuns[rawRuns.length - 1].text.trim()) rawRuns.pop();
    if (rawRuns.length) {
        rawRuns[0].text = rawRuns[0].text.trimStart();
        rawRuns[rawRuns.length - 1].text = rawRuns[rawRuns.length - 1].text.trimEnd();
    }

    return speaker ? {speaker, runs: rawRuns} : {runs: rawRuns};
}
