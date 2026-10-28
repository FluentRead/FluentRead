/**
 * @file src/features/vocabulary/materialPageSession.ts
 * 文件职责：在固定材料版本内建立可取消、可分页的材料与主题索引。
 * 主要内容：逐条扫描材料，保留材料排序键及去重主题，按原顺序稳定排序，并在每页前后核对版本。
 * 模块边界：不保存材料全文与来源地址，不处理消息鉴权或帧传输；当前存储仍须逐次物化单条材料记录。
 */
import {MaterialError} from './materialModel';
import type {MaterialRepository} from './materialRepository';
import {matchesNormalizedMaterialSearch, normalizeMaterialSearch, summarizeMaterial, type MaterialSummary, type MaterialSummaryQuery} from './materialSummary';

type Repository = Pick<MaterialRepository, 'openSnapshot'|'readSnapshotRecord'|'checkSnapshot'>;
type SortKey = {id:string; lastReadAt:number; updatedAt:number; ordinal:number};
type TopicEntry = {value:string; first:SortKey; position:number};
export const MATERIAL_PAGE_MAX_ITEMS = 30;
export const MATERIAL_TOPIC_PAGE_MAX_ITEMS = 100;
/** Target for serialized summary values; a larger individual value is returned intact alone. */
export const MATERIAL_PAGE_TARGET_BYTES = 1024 * 1024;
const MAX_SEARCH_LENGTH = 128 * 1024;
export interface MaterialPage {revision:number; total:number; matched:number; offset:number; nextOffset:number|null; items:MaterialSummary[]}
export interface MaterialTopicPage {revision:number; total:number; matched:number; offset:number; nextOffset:number|null; topics:string[]}
export interface MaterialPageSession {
    readonly revision:number;
    readonly total:number;
    readonly matched:number;
    getPage(options:{offset:number; limit?:number; signal?:AbortSignal}):Promise<MaterialPage>;
    getTopicsPage(options:{offset:number; limit?:number; search?:string; signal?:AbortSignal}):Promise<MaterialTopicPage>;
    close():Promise<void>;
}
function cancelled():DOMException {return new DOMException('材料读取已取消', 'AbortError');}
function check(signal?:AbortSignal):void {if (signal?.aborted) throw cancelled();}
/** 本次扫描的主键顺序是稳定排序完全相同时的原始次序。 */
function compareKeys(a:SortKey,b:SortKey):number {
    return b.lastReadAt-a.lastReadAt || b.updatedAt-a.updatedAt || a.id.localeCompare(b.id) || a.ordinal-b.ordinal;
}
function compareTopics(a:TopicEntry,b:TopicEntry):number {
    return a.value.localeCompare(b.value) || compareKeys(a.first,b.first) || a.position-b.position;
}
/** 将控制权交还浏览器任务队列，使大主题库的取消事件可以真正执行。 */
async function yieldTask(signal?:AbortSignal):Promise<void> {
    check(signal);
    await new Promise<void>(resolve => setTimeout(resolve,0));
    check(signal);
}
/** 每段排序后以最小堆合并，避免 30 万个主题的一次长同步排序。 */
async function sortTopics(entries:TopicEntry[], signal?:AbortSignal):Promise<TopicEntry[]> {
    const chunkSize = 4096, chunks:TopicEntry[][] = [];
    for (let offset = 0; offset < entries.length; offset += chunkSize) {
        check(signal);
        chunks.push(entries.slice(offset,offset+chunkSize).sort(compareTopics));
        await yieldTask(signal);
    }
    entries.length = 0;
    type Cursor = {chunk:TopicEntry[]; index:number};
    const heap:Cursor[] = [];
    const less = (a:Cursor,b:Cursor) => compareTopics(a.chunk[a.index],b.chunk[b.index]) < 0;
    const push = (cursor:Cursor) => {
        let index = heap.length; heap.push(cursor);
        while (index > 0) {
            const parent = Math.floor((index-1)/2);
            if (!less(heap[index],heap[parent])) break;
            [heap[index],heap[parent]] = [heap[parent],heap[index]]; index = parent;
        }
    };
    for (const chunk of chunks) push({chunk,index:0});
    const sorted:TopicEntry[] = [];
    while (heap.length) {
        const first = heap[0]; sorted.push(first.chunk[first.index++]);
        if (first.index === first.chunk.length) {
            const last = heap.pop()!;
            if (heap.length) heap[0] = last;
        }
        let index = 0;
        while (index < heap.length) {
            const left = index*2+1, right = left+1;
            if (left >= heap.length) break;
            const smaller = right < heap.length && less(heap[right],heap[left]) ? right : left;
            if (!less(heap[smaller],heap[index])) break;
            [heap[index],heap[smaller]] = [heap[smaller],heap[index]]; index = smaller;
        }
        if (sorted.length % chunkSize === 0) await yieldTask(signal);
    }
    check(signal);
    return sorted;
}
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
export async function createMaterialPageSession(repository:Repository, input:MaterialSummaryQuery = {}, signal?:AbortSignal, onProgress?:(processed:number,total:number)=>void):Promise<MaterialPageSession> {
    const query = parseQuery(input), index:SortKey[] = [], uniqueTopics = new Map<string,TopicEntry>();
    check(signal);
    const search = normalizeMaterialSearch(query.search);
    try {
        const snapshot = await repository.openSnapshot(signal);
        check(signal);
        let total = 0;
        let processed = 0;
        for (const id of snapshot.ids) {
            check(signal);
            const item = await repository.readSnapshotRecord(snapshot.revision, id, signal);
            check(signal);
            if (!item || item.id !== id) throw new MaterialError('storage-error', '材料快照记录不存在');
            processed++;
            onProgress?.(processed, snapshot.ids.length);
            check(signal);
            if ((item.archivedAt !== null) !== query.archived) continue;
            total++;
            if (!Array.isArray(item.topics) || item.topics.length > 30) throw new MaterialError('storage-error', '材料主题不可用');
            const key:SortKey = {id:item.id, lastReadAt:item.lastReadAt, updatedAt:item.updatedAt, ordinal:processed-1};
            for (let position=0; position<item.topics.length; position++) {
                const value = item.topics[position];
                if (typeof value !== 'string' || value.length > 80) throw new MaterialError('storage-error', '材料主题不可用');
                const existing = uniqueTopics.get(value);
                if (!existing || compareKeys(key,existing.first) < 0) uniqueTopics.set(value,{value,first:key,position});
            }
            if ((query.topic && !item.topics.includes(query.topic)) || !matchesNormalizedMaterialSearch(item, search)) continue;
            index.push(key);
        }
        index.sort(compareKeys);
        const topicEntries = [...uniqueTopics.values()]; uniqueTopics.clear();
        const orderedTopics = await sortTopics(topicEntries,signal);
        // 首次来源排序键只用于确定相同 locale 顺序；之后只保留主题字符串。
        const topics = orderedTopics.map(entry=>entry.value); orderedTopics.length = 0;
        check(signal);
        await repository.checkSnapshot(snapshot.revision, signal);
        check(signal);
        const revision = snapshot.revision, matched = index.length, controller = new AbortController();
        let closed = false, pending:Promise<unknown>|undefined, closePromise:Promise<void>|undefined;
        const close = ():Promise<void> => {
            if (closePromise) return closePromise;
            closed = true; signal?.removeEventListener('abort', abortSession); controller.abort();
            closePromise = (async () => {try {await pending;} catch {/* 等待底层读取完成后释放索引。 */} index.length = 0; topics.length = 0;})();
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
            getTopicsPage(options) {
                if (closed) return Promise.reject(cancelled());
                if (!options || typeof options !== 'object' || Array.isArray(options)
                    || Object.keys(options).some(key => !['offset','limit','search','signal'].includes(key))
                    || !Number.isSafeInteger(options.offset) || options.offset < 0
                    || (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > MATERIAL_TOPIC_PAGE_MAX_ITEMS))
                    || (options.search !== undefined && (typeof options.search !== 'string' || options.search.length > MAX_SEARCH_LENGTH))) {
                    return Promise.reject(new MaterialError('invalid-input', '材料主题分页无效'));
                }
                if (pending) return Promise.reject(new MaterialError('limit-exceeded', '材料分页读取正在进行'));
                const offset=options.offset, limit=options.limit ?? MATERIAL_TOPIC_PAGE_MAX_ITEMS;
                const search=normalizeMaterialSearch(options.search ?? ''), combined=combine(controller.signal,options.signal);
                const work=Promise.resolve().then(async ():Promise<MaterialTopicPage> => {
                    try {
                        check(combined.signal);
                        await repository.checkSnapshot(revision,combined.signal);
                        check(combined.signal);
                        const page:string[] = [];
                        let matched=0;
                        if (!search) {
                            matched=topics.length;
                            if (offset > matched) throw new MaterialError('invalid-input', '材料主题分页无效');
                            for (let at=offset; at<Math.min(matched,offset+limit); at++) page.push(topics[at]);
                        } else {
                            for (let at=0; at<topics.length; at++) {
                                if (topics[at].toLocaleLowerCase().includes(search)) {
                                    if (matched >= offset && page.length < limit) page.push(topics[at]);
                                    matched++;
                                }
                                if ((at+1)%4096 === 0) await yieldTask(combined.signal);
                            }
                            if (offset > matched) throw new MaterialError('invalid-input', '材料主题分页无效');
                        }
                        await repository.checkSnapshot(revision,combined.signal);
                        check(combined.signal);
                        const next=offset+page.length;
                        return {revision,total:topics.length,matched,offset,nextOffset:next < matched ? next : null,topics:page};
                    } finally {combined.release();}
                });
                pending=work;
                void work.then(() => {if (pending === work) pending=undefined;}, () => {if (pending === work) pending=undefined;});
                return work;
            },
            close,
        };
    } catch (error) {index.length = 0; uniqueTopics.clear(); throw error;}
}
