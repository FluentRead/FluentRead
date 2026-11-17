/**
 * @file src/features/document-translation/core/pdfAnnotations.ts
 * 文件职责：定义与原始 PDF 页面绑定的本地批注，以及安全、有限的历史恢复边界。
 * 主要内容：以展示方向的归一矩形保存高亮与下划线，校验条数、页号、颜色、摘录和备注；重排批注仍指向原页段落；公开 PDF 可显式前往 Hypothesis 官方代理，本地地址和带查询凭据的链接不被转交。
 * 模块边界：纯数据与 URL 计算，不访问 DOM、存储、网络或 PDF 编码器。
 */
export const PDF_ANNOTATION_LIMIT = 1000;
export const PDF_ANNOTATION_COLORS = {yellow: '#f5cf46', green: '#63c69a', pink: '#ef91b5'} as const;
export interface PdfAnnotationRect {x: number; y: number; width: number; height: number}
export interface PdfAnnotation {
    id: string;
    page: number;
    kind: 'highlight' | 'underline';
    color: keyof typeof PDF_ANNOTATION_COLORS;
    quote: string;
    note: string;
    rects: PdfAnnotationRect[];
    /** 重排时用稳定的原块标识显示批注；导出始终消费原页矩形。 */
    sourceId?: string;
}

export function normalizePdfAnnotations(input: unknown, pageCount: number): PdfAnnotation[] {
    if (!Array.isArray(input)) return [];
    const result: PdfAnnotation[] = [], ids = new Set<string>();
    for (const item of input.slice(0, PDF_ANNOTATION_LIMIT)) {
        if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || item.id.length > 100 || ids.has(item.id)
            || !Number.isInteger(item.page) || item.page < 1 || item.page > pageCount || !['highlight', 'underline'].includes(item.kind)
            || !Object.hasOwn(PDF_ANNOTATION_COLORS, item.color) || typeof item.quote !== 'string' || !item.quote.trim()
            || typeof item.note !== 'string' || !Array.isArray(item.rects) || !item.rects.length || item.rects.length > 128) continue;
        const rects: PdfAnnotationRect[] = [];
        for (const rect of item.rects) {
            if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(value => typeof value === 'number' && Number.isFinite(value))) continue;
            const x = Math.max(0, rect.x), y = Math.max(0, rect.y), right = Math.min(1, rect.x + rect.width), bottom = Math.min(1, rect.y + rect.height);
            if (right > x && bottom > y) rects.push({x, y,
                width: x === rect.x && rect.x + rect.width <= 1 ? rect.width : right - x,
                height: y === rect.y && rect.y + rect.height <= 1 ? rect.height : bottom - y});
        }
        if (!rects.length) continue;
        ids.add(item.id);
        result.push({id: item.id, page: item.page, kind: item.kind, color: item.color, quote: item.quote.slice(0, 4000), note: item.note.slice(0, 4000), rects,
            ...(typeof item.sourceId === 'string' && item.sourceId.length <= 100 ? {sourceId: item.sourceId} : {})});
    }
    return result;
}

/** 不自动上传文件、不转交登录态链接；查询参数可能含临时访问令牌，留给用户在官方入口自行选择。 */
export function pdfHypothesisUrl(source: string): string | undefined {
    try {
        const url = new URL(source);
        const host = url.hostname.toLowerCase();
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search
            || !host.includes('.') || host.includes(':') || /^[\d.]+$/u.test(host) || host.endsWith('.local') || host.endsWith('.localhost')
            || host === 'localhost' || host === 'via.hypothes.is') return;
        url.hash = '';
        return `https://via.hypothes.is/${url.href}`;
    } catch {return;}
}
