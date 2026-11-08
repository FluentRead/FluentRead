/**
 * @file src/features/document-translation/core/arxivPaperUrl.ts
 * 文件职责：解析 arXiv 正式论文地址，供摘要入口和后台 PDF 阅读器共同核对论文身份。
 * 主要内容：限制为官方 HTTPS 论文路由，识别新旧编号及具体版本，允许最新摘要链接指向已明确的同篇版本。
 * 模块边界：纯 URL 校验，无 DOM、网络或浏览器权限副作用；入口挂载和新标签页导航分别由内容脚本和后台负责。
 */
export interface ArxivPaperUrl {
    url: URL;
    kind: 'abs' | 'html' | 'pdf';
    id: string;
    version: string | undefined;
}

const paperPath = /^\/(abs|html|pdf)\/(\d{4}\.\d{4,5}|[a-z]+(?:-[a-z]+)*(?:\.[A-Z]{2})?\/\d{7})(?:v([1-9]\d*))?(\.pdf)?\/?$/u;

export function readArxivPaperUrl(value: string | URL): ArxivPaperUrl | null {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || (url.host !== 'arxiv.org' && url.host !== 'www.arxiv.org')
            || url.username || url.password) return null;
        const match = paperPath.exec(url.pathname);
        if (!match) return null;
        const [, route, id, version, pdfExtension] = match;
        const kind = route as ArxivPaperUrl['kind'];
        if (pdfExtension && kind !== 'pdf') return null;
        return {url, kind, id: id!, version};
    } catch {
        return null;
    }
}

export function isSameArxivPaper(source: ArxivPaperUrl, target: ArxivPaperUrl): boolean {
    return source.id === target.id && (source.version === undefined || source.version === target.version);
}
