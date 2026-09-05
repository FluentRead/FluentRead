/**
 * @file src/features/document-translation/ui/presentation.ts
 * 文件职责：提供文档翻译界面使用的纯展示派生规则，把 ParsedDocument 转换成预览统计、空状态提示、色调和格式特定的文本/样式标签。
 * 主要内容：包含字幕与富文本格式判断、页数章节数片段数等元数据、DOCX 部件名称映射、不同格式的阅读器文本清理，以及 source 节点 class 的选择。
 * 模块边界：本文件不创建 DOM、不解析文件也不调用翻译；它只消费 core 模型并返回 UI 可直接使用的值，实际预览 HTML 归 core/preview，PDF 位图和导出分别归 pdfPreview 与 binary。
 */
import type {DocumentFormat, ParsedDocument} from '@/src/features/document-translation/core/document';

export interface DocumentPreviewMeta {
    eyebrow: string;
    title: string;
    hint: string;
}

const SUBTITLE_FORMATS = new Set<DocumentFormat>(['srt', 'vtt', 'ass', 'lrc']);
const RICH_FORMATS = new Set<DocumentFormat>(['epub', 'html', 'markdown', 'txt']);

export function isSubtitleDocumentFormat(format?: DocumentFormat): boolean {
    return format !== undefined && SUBTITLE_FORMATS.has(format);
}

export function isRichDocumentFormat(format?: DocumentFormat): boolean {
    return format !== undefined && RICH_FORMATS.has(format);
}

export function getDocumentPreviewMeta(document: ParsedDocument | null): DocumentPreviewMeta {
    if (document?.binary?.kind === 'pdf') return {
        eyebrow: '版式阅读',
        title: 'PDF 原页与译页',
        hint: '逐页连续阅读，双语模式并排对照；可在校订区修改文字',
    };
    if (document?.binary?.kind === 'epub') return {
        eyebrow: '电子书阅读',
        title: 'ePub 章节双语阅读',
        hint: '按目录切换章节，保留正文层级并导出可继续阅读的双语 ePub',
    };
    if (document?.binary?.kind === 'docx') return {
        eyebrow: '页面阅读',
        title: 'Word 文档原文与译文',
        hint: '按正文、页眉、页脚和注释分区校对，下载结果仍为原生 DOCX',
    };
    if (isSubtitleDocumentFormat(document?.format)) return {
        eyebrow: '时间轴校对',
        title: '字幕时间轴与译文',
        hint: '保留时间轴，切换到校订区修改文字后按原格式下载',
    };
    if (document?.format === 'json') return {
        eyebrow: '结构化翻译',
        title: 'JSON 路径与字符串译文',
        hint: '只翻译字符串值，键名、数组、数字、布尔值和嵌套结构保持不变',
    };
    if (document?.format === 'markdown') return {
        eyebrow: '排版阅读',
        title: 'Markdown 双语文章',
        hint: '标题、段落、列表、引用和代码块按文章样式呈现，而不是文本片段表格',
    };
    if (document?.format === 'html') return {
        eyebrow: '网页文档阅读',
        title: 'HTML 双语排版预览',
        hint: '在隔离阅读器中保留标题、段落、列表与表格，脚本和外部请求不会运行',
    };
    return {
        eyebrow: '流畅阅读',
        title: '原文与译文',
        hint: '按自然段连续阅读和校对，下载时保留原文件换行结构',
    };
}

export function getDocumentEmptyReaderHint(document: ParsedDocument | null): string {
    if (document?.binary?.kind === 'pdf') {
        return '点击“开始翻译”，译文会按原页面坐标写回并生成可下载 PDF。';
    }
    if (isSubtitleDocumentFormat(document?.format)) {
        return '点击“开始翻译”，译文会出现在对应时间轴行中。';
    }
    if (document?.format === 'json') {
        return '点击“开始翻译”，只会填充每个 JSON 路径对应的字符串译文。';
    }
    return '点击“开始翻译”，译文会按当前文档的阅读结构显示。';
}

export function getDocumentFormatTone(format?: DocumentFormat): 'coral' | 'teal' | 'violet' | 'sand' | 'slate' {
    if (format === 'pdf' || format === 'html') return 'coral';
    if (format === 'epub' || format === 'json') return 'teal';
    if (isSubtitleDocumentFormat(format)) return 'violet';
    if (format === 'markdown') return 'sand';
    return 'slate';
}

export function getDocxPartLabel(path: string): string {
    if (path === 'word/document.xml') return '正文';
    if (/header/iu.test(path)) return '页眉';
    if (/footer/iu.test(path)) return '页脚';
    if (/footnotes/iu.test(path)) return '脚注';
    if (/endnotes/iu.test(path)) return '尾注';
    return '文档内容';
}

export function formatDocumentReaderText(format: DocumentFormat | undefined, value: string): string {
    if (format === 'html') return value.replace(/<[^>]+>/gu, '').trim();
    if (format === 'markdown') {
        return value
            .replace(/^\s{0,3}#{1,6}\s+/u, '')
            .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
            .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
            .replace(/`{1,3}([^`]+)`{1,3}/gu, '$1')
            .replace(/(\*\*|__)(.*?)\1/gu, '$2')
            .trim();
    }
    if (format !== undefined && ['srt', 'vtt', 'ass'].includes(format)) {
        return value.replace(/<[^>]+>/gu, '').replace(/\{\\[^}]+\}/gu, '').trim();
    }
    return value.trim();
}

export function getDocumentReaderSourceClass(format: DocumentFormat | undefined, value: string): string {
    return format === 'markdown' && /^\s{0,3}#{1,6}\s+/u.test(value)
        ? 'reader-heading'
        : '';
}
