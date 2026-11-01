/**
 * @file src/features/vocabulary/materialModel.ts
 * 文件职责：规范化本地学习材料身份与定位信息，防止 URL、片段和媒体时间相互混同。
 * 主要内容：保留语义查询和 SPA hash 路由，去除追踪与时间参数；视频平台身份与本地文件指纹优先。
 * 模块边界：纯函数不访问 DOM、浏览器或存储；仓库是写入和并发控制的唯一入口。
 */
import {sanitizeVocabularyVideoUrl} from './source';
import {normalizeDocumentMaterialReference} from '@/src/features/document-translation/material/public';
import type {MaterialErrorCode, MaterialLocator, MaterialReference, MaterialSource} from './materialProtocol';
const MAX_RAW_MATERIAL_URL = 8192;
// UTF-8 百分号编码与域名 ASCII 化可能使旧版已保存的规范地址显著增长。
// 保留明确的上限，长地址仅接受已经规范化的形态，避免反复扩张。
const MAX_CANONICAL_MATERIAL_URL = MAX_RAW_MATERIAL_URL * 16 + 16;
export class MaterialError extends Error {
    constructor(readonly code: MaterialErrorCode, message: string) {super(message); this.name = 'MaterialError';}
}
export function materialText(value: unknown, max: number): string {
    return typeof value === 'string' ? value.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '').trim().slice(0, max) : '';
}
/** URL 仅剥离已知追踪参数，保留 id、语言、章节等语义查询与 hash 路由。 */
export function canonicalMaterialUrl(value: unknown): string {
    if (typeof value !== 'string' || value.length > MAX_CANONICAL_MATERIAL_URL) return '';
    try {
        const url = new URL(value);
        if (!['http:', 'https:', 'file:'].includes(url.protocol) || url.username || url.password) return '';
        const long = value.length > MAX_RAW_MATERIAL_URL;
        // 短输入删除时需要快照；长输入不删除，直接迭代可提前拒绝。
        const keys = long ? url.searchParams.keys() : [...url.searchParams.keys()];
        for (const key of keys) {
            if (/^(?:utm_.+|fbclid|gclid|msclkid|__fluentread_material)$/iu.test(key)) {
                // 长输入只接受已规范化的地址；无需逐个删除大量追踪键。
                if (long) return '';
                url.searchParams.delete(key);
            }
        }
        url.searchParams.sort();
        // 原文锚点不是新材料；hash 路由仍然属于页面身份。
        if (!/^#(?:\/|!\/)/u.test(url.hash)) url.hash = '';
        const result = url.href;
        if (result.length > MAX_CANONICAL_MATERIAL_URL || (long && result !== value)) return '';
        return result;
    } catch {return '';}
}
export function normalizeMaterialSource(input: MaterialSource): {source: MaterialSource; identityKey: string} {
    if (!input || !['article', 'document', 'video'].includes(input.kind)) throw new MaterialError('invalid-input', '材料来源类型无效');
    let url = canonicalMaterialUrl(input.url);
    const fingerprint = materialText(input.fingerprint, 256);
    const title = materialText(input.title, 240);
    let identity = url;
    if (input.kind === 'video' && url) {
        const youtube = sanitizeVocabularyVideoUrl(url, 'youtube');
        const x = sanitizeVocabularyVideoUrl(url, 'x');
        if (youtube) {url = youtube; identity = `youtube:${new URL(youtube).searchParams.get('v')}`;}
        else if (x) {
            url = x;
            const match = new URL(x).pathname.match(/\/status\/(\d+)(\/video\/[1-9]\d*)?/u)!;
            identity = `x:${match[1]}${match[2] ?? ''}`;
        } else {
            const parsed = new URL(url);
            if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(parsed.hostname)) throw new MaterialError('invalid-input', '请选择具体的视频，而不是平台首页或搜索页');
            // 其他视频站点使用完整语义地址，时间坐标独立存储。
            for (const key of ['t', 'start', 'end', 'time_continue']) parsed.searchParams.delete(key);
            identity = parsed.href; url = parsed.href;
        }
    }
    if (input.kind === 'document' && fingerprint) identity = `fingerprint:${fingerprint}`;
    if (!identity || (url.startsWith('file:') && !fingerprint)) throw new MaterialError('invalid-input', '本地文件需要内容指纹；网页材料需要有效来源地址');
    return {source: {kind: input.kind, ...(url ? {url} : {}), ...(title ? {title} : {}), ...(fingerprint ? {fingerprint} : {})}, identityKey: `${input.kind}:${identity}`};
}
export function normalizeMaterialLocator(input: MaterialLocator | undefined, source?: Pick<MaterialSource, 'kind' | 'fingerprint'>): MaterialLocator | undefined {
    if (input === undefined) return undefined;
    if (!input || !['text', 'document', 'video'].includes(input.kind)) throw new MaterialError('invalid-input', '材料位置无效');
    const locator: MaterialLocator = {kind: input.kind};
    for (const [key, max] of [['quote', 6000], ['prefix', 160], ['suffix', 160], ['paragraphId', 256], ['section', 240], ['fingerprint', 256]] as const) {
        const value = materialText(input[key], max); if (value) locator[key] = value;
    }
    if (input.page !== undefined) {
        if (!Number.isSafeInteger(input.page) || input.page < 1 || input.page > 1_000_000) throw new MaterialError('invalid-input', '文档页码无效');
        locator.page = input.page;
    }
    if (input.startMs !== undefined) {
        if (!Number.isFinite(input.startMs) || input.startMs < 0 || input.startMs > 315_360_000_000) throw new MaterialError('invalid-input', '视频时间无效');
        locator.startMs = Math.floor(input.startMs);
    }
    if (input.endMs !== undefined) {
        if (!Number.isFinite(input.endMs) || input.endMs < (locator.startMs ?? 0) || input.endMs > 315_360_000_000) throw new MaterialError('invalid-input', '视频结束时间无效');
        locator.endMs = Math.floor(input.endMs);
    }
    if (source?.kind === 'document' && locator.fingerprint && locator.fingerprint !== source.fingerprint) throw new MaterialError('invalid-input', '文档位置与材料内容指纹不一致');
    if (input.documentReference !== undefined) {
        if (input.kind !== 'document' || source && source.kind !== 'document') throw new MaterialError('invalid-input', '精确文档位置只能用于文档材料');
        const fingerprint = source?.fingerprint ?? locator.fingerprint;
        const reference = fingerprint ? normalizeDocumentMaterialReference(input.documentReference, fingerprint) : undefined;
        if (!reference || locator.fingerprint && locator.fingerprint !== reference.materialId) throw new MaterialError('invalid-input', '文档精确位置无效、超出预算或属于其他文件');
        locator.fingerprint = reference.materialId;
        locator.documentReference = reference;
    }
    return locator;
}
/** 原句只用于定位；回答与长期记忆由权威仓库管理，材料仅对个人笔记保留 note 正文。 */
export function normalizeMaterialReference(input: MaterialReference, now: number): MaterialReference {
    if (!input) throw new MaterialError('invalid-input', '学习引用无效');
    const kind = input.kind;
    if (!['vocabulary', 'session', 'memory', 'note'].includes(kind)) throw new MaterialError('invalid-input', '学习引用无效');
    const id = materialText(input.id, 256);
    if (!id) throw new MaterialError('invalid-input', '学习引用无效');
    const excerpt = materialText(input.excerpt, 6000);
    // 非笔记引用不读取、也不保存其他存储域的私有正文。
    const note = kind === 'note' ? materialText(input.note, 12000) : '';
    const updatedAt = kind === 'note' ? input.updatedAt : undefined;
    const createdAt = input.createdAt;
    return {kind, id, ...(excerpt ? {excerpt} : {}), ...(note ? {note} : {}), ...(Number.isFinite(updatedAt) && updatedAt! >= 0 ? {updatedAt: Math.min(updatedAt!, now)} : {}), createdAt: Number.isFinite(createdAt) && createdAt! >= 0 ? Math.min(createdAt!, now) : now};
}
export function normalizeMaterialTopics(input: unknown): string[] {
    if (!Array.isArray(input) || input.length > 30 || input.some(value => typeof value !== 'string' || value.length > 80)) throw new MaterialError('invalid-input', '主题最多 30 个，每个最多 80 字');
    return [...new Set(input.map(value => materialText(value, 80)).filter(Boolean))];
}
