/**
 * @file src/features/document-translation/core/paperPdfSites.ts
 * 文件职责：识别已适配的公开论文摘要页，并核对原生 PDF 链接是否指向同一篇论文。
 * 主要内容：严格匹配官方 HTTPS 主机和正文路由，保留 arXiv 版本校验，识别会议归档的旧链接，剥离不参与论文身份的查询与锚点。
 * 模块边界：只解析调用方提供的绝对 URL，不合成页面链接、不探测网络、不打开阅读器；页面入口和后台消息共用该校验。
 */
import {isSameArxivPaper, readArxivPaperUrl} from './arxivPaperUrl';

export type PaperPdfSite = 'arxiv' | 'huggingface' | 'acl' | 'cvf' | 'neurips';

const huggingFacePaper = /^\/papers\/(\d{4}\.\d{4,5})\/?$/u;
const aclAbstract = /^\/(?:\d{4}\.[a-z0-9]+(?:-[a-z0-9]+)*\.\d+|[A-Z]\d{2}-\d{4})\/?$/u;
const cvfAbstract = /^\/(?:content\/(?:CVPR|ICCV|WACV)\d{4}(?:W\/[\w-]+)?|content_(?:cvpr|iccv|wacv)_\d{4})\/html\/[\w.-]+\.html$/iu;
const neuripsAbstract = /^\/(?:paper_files\/)?paper\/\d{4}\/hash\/[a-f0-9]{32}-Abstract(?:-[\w-]+)?\.html$/u;

function readHttpsUrl(href: string): URL | null {
    try {
        const url = new URL(href);
        return url.protocol === 'https:' && !url.username && !url.password ? url : null;
    } catch { return null; }
}

function classifyPaperPdfSite(url: URL): PaperPdfSite | null {
    switch (url.host) {
        case 'arxiv.org':
        case 'www.arxiv.org':
            return readArxivPaperUrl(url)?.kind === 'abs' ? 'arxiv' : null;
        case 'huggingface.co':
            return huggingFacePaper.test(url.pathname) ? 'huggingface' : null;
        case 'aclanthology.org':
            return aclAbstract.test(url.pathname) ? 'acl' : null;
        case 'openaccess.thecvf.com':
            return cvfAbstract.test(url.pathname) ? 'cvf' : null;
        case 'proceedings.neurips.cc':
        case 'papers.nips.cc':
            return neuripsAbstract.test(url.pathname) ? 'neurips' : null;
        default:
            return null;
    }
}

export function getPaperPdfSite(href: string): PaperPdfSite | null {
    const url = readHttpsUrl(href);
    return url ? classifyPaperPdfSite(url) : null;
}

function matchesPaperPdf(site: PaperPdfSite | null, source: URL, target: URL): boolean {
    switch (site) {
        case 'arxiv': {
            const paper = readArxivPaperUrl(source)!;
            const pdf = readArxivPaperUrl(target);
            return pdf?.kind === 'pdf' && isSameArxivPaper(paper, pdf);
        }
        case 'huggingface': {
            const id = huggingFacePaper.exec(source.pathname)![1];
            const pdf = readArxivPaperUrl(target);
            return pdf?.kind === 'pdf' && pdf.id === id;
        }
        case 'acl':
            return source.host === target.host && target.pathname === `${source.pathname.replace(/\/$/u, '')}.pdf`;
        case 'cvf':
            return source.host === target.host && target.pathname === source.pathname.replace(/\/html\/([^/]+)\.html$/iu, '/papers/$1.pdf');
        case 'neurips': {
            const abstractPath = source.pathname.replace(/^\/paper_files/u, '');
            const pdfPath = abstractPath.replace('/hash/', '/file/').replace('-Abstract', '-Paper').replace(/\.html$/u, '.pdf');
            return (target.host === 'proceedings.neurips.cc' || target.host === 'papers.nips.cc')
                && target.pathname.replace(/^\/paper_files/u, '') === pdfPath;
        }
        default:
            return false;
    }
}

export function resolvePaperPdfUrl(sourceHref: string, targetHref: string): string | null {
    const source = readHttpsUrl(sourceHref);
    const target = readHttpsUrl(targetHref);
    if (!source || !target || !matchesPaperPdf(classifyPaperPdfSite(source), source, target)) return null;
    return target.origin + target.pathname;
}
