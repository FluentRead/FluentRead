/**
 * @file src/features/vocabulary/materialSource.ts
 * 文件职责：为本地学习材料生成继续阅读入口，并从主动选择的原文捕获来源与位置。
 * 主要内容：网页保留语义地址与 SPA 路由，链接仅传递本地材料标识而不泄漏个人原句；视频保留原始时间，文档按文件指纹恢复本机记录，丢失文件时明确提示重新选择。
 * 模块边界：只处理来源快照和纯链接，不读个人数据库、不发送正文、不创建窗口；DOM 捕获严格限制于用户当前选择。
 */
import type {MaterialCaptureInput, MaterialRecord} from './materialProtocol';
import {canonicalMaterialUrl} from './materialModel';
import {locateMaterialOriginalQuote, projectMaterialOriginalText} from './materialOriginalText';

export const MATERIAL_RESUME_PARAMETER = '__fluentread_material';
export interface MaterialResumeLink {href?: string; label: string; recovery?: string}

/** 个人原句和文件字节永不写入地址；恢复时由本地仓库核对来源身份。 */
export function materialResumeLink(record: Pick<MaterialRecord, 'id'|'kind'|'source'|'locator'>, documentPageUrl?: string): MaterialResumeLink {
    if (record.kind === 'document') {
        if (!documentPageUrl || !record.source.fingerprint) return {label: '重新打开文件', recovery: '请选择原文件；将按内容指纹找回材料与阅读位置。'};
        const target = new URL(documentPageUrl);
        target.searchParams.set(MATERIAL_RESUME_PARAMETER, record.id);
        return {href: target.href, label: record.locator?.page ? `继续第 ${record.locator.page} 页` : '继续阅读', recovery: '本机文件记录若已移除，请重新选择原文件；同名文件会核对内容指纹。'};
    }
    const source = canonicalMaterialUrl(record.source.url);
    if (!source || !/^https?:/u.test(source)) return {label: '找回来源', recovery: '来源地址已失效。可更新地址，或按材料标题找到原文。'};
    const target = new URL(source);
    target.searchParams.set(MATERIAL_RESUME_PARAMETER, record.id);
    const start = record.locator?.startMs;
    if (record.kind === 'video' && start !== undefined && /(?:^|\.)youtube\.com$/u.test(target.hostname)) target.searchParams.set('t', `${start / 1000}s`);
    return {href: target.href, label: record.kind === 'video' ? '继续观看' : '继续阅读'};
}

/** 文件页由组合根提供稳定文件指纹，不能把随机渲染身份误作文件身份。 */
export function captureMaterialSelection(range: Range, quote: string): Pick<MaterialCaptureInput, 'source' | 'locator'> | undefined {
    if (!range.startContainer.isConnected || !range.endContainer.isConnected) return;
    const element = range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement;
    const doc = range.startContainer.ownerDocument;
    if (!doc || !element) return;
    const file = element.closest<HTMLElement>('[data-fluentread-material-fingerprint]');
    const fingerprint = file?.dataset.fluentreadMaterialFingerprint;
    if (file && fingerprint) {
        const pageOwner = element.closest('[data-page-number],[data-pdf-page-number],[data-pdf-reading-page]');
        const page = Number(pageOwner?.getAttribute('data-page-number') || pageOwner?.getAttribute('data-pdf-page-number') || pageOwner?.getAttribute('data-pdf-reading-page') || file.dataset.fluentreadMaterialPage);
        const sourceUrl = file.dataset.fluentreadMaterialSource;
        return {source: {kind: 'document', fingerprint, title: file.dataset.fluentreadMaterialTitle || doc.title, ...(sourceUrl ? {url: sourceUrl} : {})},
            locator: {kind: 'document', fingerprint, quote: quote.slice(0, 6000), ...(Number.isSafeInteger(page) && page > 0 ? {page} : {}), ...(file.dataset.fluentreadMaterialSection ? {section: file.dataset.fluentreadMaterialSection} : {})}};
    }
    const url = canonicalMaterialUrl(doc.location?.href);
    if (!url || !/^https?:/u.test(url)) return;
    const paragraph = element.closest<HTMLElement>('p,li,blockquote,dd,dt,figcaption,h1,h2,h3,h4,h5,h6') || element;
    const projection = projectMaterialOriginalText(paragraph, range);
    const original = projection && locateMaterialOriginalQuote(projection, quote);
    if (!original) return;
    return {source: {kind: 'article', url, title: doc.title}, locator: {kind: 'text', quote: original.quote,
        ...(paragraph.id && paragraph.id.length < 256 ? {paragraphId: paragraph.id} : {}),
        prefix: original.prefix, suffix: original.suffix}};
}
