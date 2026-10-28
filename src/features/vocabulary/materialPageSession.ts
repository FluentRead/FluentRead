/** Query-scoped material page index. It retains IDs and sort keys, not content. */
import {MaterialError} from './materialModel';
import type {MaterialRepository} from './materialRepository';
import {matchesNormalizedMaterialSearch, normalizeMaterialSearch, summarizeMaterial, type MaterialSummary} from './materialSummary';
import type {MaterialSummaryQuery} from './materialReadSource';

type Repository = Pick<MaterialRepository, 'openSnapshot'|'readSnapshotRecord'|'checkSnapshot'>;
type SortKey = {id:string; lastReadAt:number; updatedAt:number};
export const MATERIAL_PAGE_MAX_ITEMS = 30;
/** Target for serialized summary values; a larger individual value is returned intact alone. */
export const MATERIAL_PAGE_TARGET_BYTES = 1024 * 1024;
const MAX_SEARCH_LENGTH = 128 * 1024;
export interface MaterialPage {revision:number; total:number; matched:number; offset:number; nextOffset:number|null; items:MaterialSummary[]}
export interface MaterialPageSession {
    readonly revision:number;
    readonly total:number;
    readonly matched:number;
    getPage(options:{offset:number; limit?:number; signal?:AbortSignal}):Promise<MaterialPage>;
    close():Promise<void>;
}
function cancelled():DOMException {return new DOMException('材料读取已取消', 'AbortError');}
function check(signal?:AbortSignal):void {if (signal?.aborted) throw cancelled();}
function combine(owned:AbortSignal, caller?:AbortSignal):{signal:AbortSignal; release():void} {
    const controller = new AbortController();
    const abort = () => controller.abort();
    owned.addEventListener('abort', abort, {once:true});
    caller?.addEventListener('abort', abort, {once:true});
    if (owned.aborted || caller?.aborted) abort();
    return {signal:controller.signal, release() {owned.removeEventListener('abort', abort); caller?.removeEventListener('abort', abort);}};
}
function parseQuery(options:MaterialSummaryQuery):Required<MaterialSummaryQuery> {
    if (!options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some(key => !['archived','topic','search'].includes(key))
        || (options.archived !== undefined && typeof options.archived !== 'boolean')
        || (options.topic !== undefined && (typeof options.topic !== 'string' || options.topic.length > 80))
        || (options.search !== undefined && (typeof options.search !== 'string' || options.search.length > MAX_SEARCH_LENGTH))) {
        throw new MaterialError('invalid-input', '材料筛选无效');
    }
    return {archived:options.archived === true, topic:options.topic ?? '', search:options.search ?? ''};
}

/** Scan once, then reread only the requested page. The caller must close the session;
 * aborting the creation signal also closes it and cancels any active page. */
export async function createMaterialPageSession(repository:Repository, input:MaterialSummaryQuery = {}, signal?:AbortSignal):Promise<MaterialPageSession> {
    const query = parseQuery(input), index:SortKey[] = [];
    check(signal);
    const search = normalizeMaterialSearch(query.search);
    try {
        const snapshot = await repository.openSnapshot(signal);
        check(signal);
        let total = 0;
        for (const id of snapshot.ids) {
            check(signal);
            const item = await repository.readSnapshotRecord(snapshot.revision, id, signal);
            check(signal);
            if (!item || item.id !== id) throw new MaterialError('storage-error', '材料快照记录不存在');
            if ((item.archivedAt !== null) !== query.archived) continue;
            total++;
            if ((query.topic && !item.topics.includes(query.topic)) || !matchesNormalizedMaterialSearch(item, search)) continue;
            index.push({id:item.id, lastReadAt:item.lastReadAt, updatedAt:item.updatedAt});
        }
        index.sort((a,b) => b.lastReadAt - a.lastReadAt || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
        check(signal);
        await repository.checkSnapshot(snapshot.revision, signal);
        check(signal);
        const revision = snapshot.revision, matched = index.length, controller = new AbortController();
        let closed = false, pending:Promise<MaterialPage>|undefined, closePromise:Promise<void>|undefined;
        const close = ():Promise<void> => {
            if (closePromise) return closePromise;
            closed = true; signal?.removeEventListener('abort', abortSession); controller.abort();
            closePromise = (async () => {try {await pending;} catch {/* Await actual read cleanup. */} index.length = 0;})();
            return closePromise;
        };
        const abortSession = () => {void close();};
        signal?.addEventListener('abort', abortSession, {once:true});
        if (signal?.aborted) {abortSession(); check(signal);}
        return {
            revision, total, matched,
            getPage(options) {
                if (closed) return Promise.reject(cancelled());
                if (!options || typeof options !== 'object' || Array.isArray(options)
                    || Object.keys(options).some(key => !['offset','limit','signal'].includes(key))
                    || !Number.isSafeInteger(options.offset) || options.offset < 0 || options.offset > matched
                    || (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > MATERIAL_PAGE_MAX_ITEMS))) {
                    return Promise.reject(new MaterialError('invalid-input', '材料分页无效'));
                }
                if (pending) return Promise.reject(new MaterialError('limit-exceeded', '材料分页读取正在进行'));
                const offset = options.offset, limit = options.limit ?? MATERIAL_PAGE_MAX_ITEMS;
                const combined = combine(controller.signal, options.signal);
                // Register pending before starting any repository call: a read
                // can synchronously abort the owning signal before it settles.
                const work = Promise.resolve().then(async ():Promise<MaterialPage> => {
                    const page:MaterialSummary[] = [], encoder = new TextEncoder();
                    let bytes = 0, next = offset;
                    try {
                        check(combined.signal);
                        await repository.checkSnapshot(revision, combined.signal);
                        check(combined.signal);
                        while (next < matched && page.length < limit) {
                            const entry = index[next];
                            const item = await repository.readSnapshotRecord(revision, entry.id, combined.signal);
                            check(combined.signal);
                            if (!item || item.id !== entry.id) throw new MaterialError('storage-error', '材料快照记录不存在');
                            const summary = summarizeMaterial(item), size = encoder.encode(JSON.stringify(summary)).length;
                            if (page.length && bytes + size > MATERIAL_PAGE_TARGET_BYTES) break;
                            page.push(summary); bytes += size; next++;
                        }
                        await repository.checkSnapshot(revision, combined.signal);
                        check(combined.signal);
                        return {revision, total, matched, offset, nextOffset:next < matched ? next : null, items:page};
                    } finally {combined.release();}
                });
                pending = work;
                void work.then(() => {if (pending === work) pending = undefined;}, () => {if (pending === work) pending = undefined;});
                return work;
            },
            close,
        };
    } catch (error) {index.length = 0; throw error;}
}
