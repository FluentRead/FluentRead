/**
 * @file src/features/vocabulary/materialDetailPage.ts
 * 文件职责：在一致的材料快照中按需读取详情和学习引用。
 * 主要内容：保留完整来源与定位信息，按条数和序列化字节软预算分页，不截断单条引用；材料改变或请求取消时不返回部分页面。
 * 模块边界：仓库仍需物化一条完整 IndexedDB 记录；本模块不安装消息端口、不负责来源权限、界面状态或将页面切分成传输帧。
 */
import {MaterialError} from './materialModel';
import type {MaterialRecord, MaterialReference} from './materialProtocol';
import type {MaterialRepository, MaterialSnapshotVersion} from './materialRepository';

/** 显示和继续阅读所需的元信息；历史身份别名不属于详情内容。 */
export type MaterialDetailMetadata = Pick<MaterialRecord, 'id'|'kind'|'title'|'source'|'locator'|'topics'|'createdAt'|'updatedAt'|'lastReadAt'|'archivedAt'>;
export const MATERIAL_DETAIL_PAGE_MAX_ITEMS = 24;
/** JSON 载荷的软预算；单项超预算时独立返回，发送端仍必须分帧。 */
export const MATERIAL_DETAIL_PAGE_TARGET_BYTES = 1024 * 1024;
export interface MaterialDetailPage {
    revision: number;
    id: string;
    metadata: MaterialDetailMetadata;
    total: number;
    offset: number;
    nextOffset: number | null;
    references: MaterialReference[];
}
export interface MaterialDetailRequest {revision: number; id: string; offset: number; limit?: number}
type Repository = Pick<MaterialRepository, 'readSnapshotRecord'|'checkSnapshot'>;

function check(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('材料读取已取消', 'AbortError');
}

/** 只在最后一次版本检查完成后返回整页，调用方须在传输完整性验证后再展示。 */
export async function readMaterialDetailPage(repository: Repository, input: MaterialDetailRequest, signal: AbortSignal | undefined, snapshot: MaterialSnapshotVersion): Promise<MaterialDetailPage> {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['revision','id','offset','limit'].includes(key))
        || !Number.isSafeInteger(input.revision) || input.revision < 0 || !snapshot || snapshot.revision !== input.revision
        || typeof input.id !== 'string' || !input.id || input.id.length > 256
        || !Number.isSafeInteger(input.offset) || input.offset < 0
        || (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MATERIAL_DETAIL_PAGE_MAX_ITEMS))) {
        throw new MaterialError('invalid-input', '材料详情分页无效');
    }
    // 在异步读取前快照调用者输入，避免等待时被修改。
    const {revision, id, offset} = input, limit = input.limit ?? MATERIAL_DETAIL_PAGE_MAX_ITEMS;
    check(signal);
    const record = await repository.readSnapshotRecord(snapshot, id, signal);
    check(signal);
    if (!record) throw new MaterialError('not-found', '这份材料已不存在');
    if (record.id !== id || !Array.isArray(record.references) || record.references.length > 1000) throw new MaterialError('storage-error', '材料详情不可用');
    const total = record.references.length;
    if (offset > total) throw new MaterialError('invalid-input', '材料详情分页无效');
    const metadata: MaterialDetailMetadata = {id:record.id, kind:record.kind, title:record.title, source:record.source,
        ...(record.locator === undefined ? {} : {locator:record.locator}), topics:record.topics, createdAt:record.createdAt,
        updatedAt:record.updatedAt, lastReadAt:record.lastReadAt, archivedAt:record.archivedAt};
    const references: MaterialReference[] = [], encoder = new TextEncoder();
    let bytes = encoder.encode(JSON.stringify(metadata)).length, next = offset;
    while (next < total && references.length < limit) {
        const reference = record.references[next];
        if (!reference || typeof reference !== 'object' || Array.isArray(reference)
            || !['vocabulary','session','memory','note'].includes(reference.kind)
            || typeof reference.id !== 'string' || !reference.id) throw new MaterialError('storage-error', '材料引用不可用');
        const size = encoder.encode(JSON.stringify(reference)).length;
        if (references.length && bytes + size > MATERIAL_DETAIL_PAGE_TARGET_BYTES) break;
        references.push(reference);
        bytes += size;
        next++;
    }
    check(signal);
    await repository.checkSnapshot(snapshot, signal);
    check(signal);
    return {revision, id, metadata, total, offset, nextOffset:next < total ? next : null, references};
}
