/** Revision-checked material list source for the bounded read transport.
 * A receiver must discard partial data unless both the complete record and
 * transport completion have been verified. Records are read one at a time. */
import {MaterialError} from './materialModel';
import type {MaterialRepository} from './materialRepository';
import type {MaterialErrorCode} from './materialProtocol';
import {matchesMaterialSearch, summarizeMaterial, type MaterialSummary} from './materialSummary';

export interface MaterialSummaryQuery {archived?: boolean; topic?: string; search?: string}
export type MaterialSummaryReadErrorCode = Extract<MaterialErrorCode, 'stale-operation'|'limit-exceeded'|'invalid-input'|'storage-error'>;
export type MaterialSummaryReadMessage =
    | {type: 'header'; version: 1; revision: number}
    | {type: 'topic'; value: string}
    | {type: 'summary'; value: MaterialSummary}
    | {type: 'complete'; count: number; total: number; topicCount: number}
    | {type: 'error'; code: MaterialSummaryReadErrorCode};
type SnapshotRepository = Pick<MaterialRepository, 'openSnapshot' | 'readSnapshotRecord' | 'checkSnapshot'>;

function checkCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('材料读取已取消', 'AbortError');
}
function encode(message: MaterialSummaryReadMessage): Uint8Array {
    return new TextEncoder().encode(`${JSON.stringify(message)}\n`);
}

/** Summary and topic ordering is left to the receiver. `total` and the unique
 * topic records cover the selected archive before topic and search filtering. */
async function* readSummaries(repository: SnapshotRepository, options: MaterialSummaryQuery, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    if (!options || typeof options !== 'object' || Array.isArray(options)
        || (options.archived !== undefined && typeof options.archived !== 'boolean')
        || (options.topic !== undefined && typeof options.topic !== 'string')
        || (options.search !== undefined && typeof options.search !== 'string')) {
        throw new MaterialError('invalid-input', '材料筛选无效');
    }
    // Copy inputs before the first await so a caller cannot change a query mid-read.
    const archived = options.archived === true, topic = options.topic ?? '', search = options.search ?? '';
    checkCancelled(signal);
    const snapshot = await repository.openSnapshot(signal);
    checkCancelled(signal);
    yield encode({type: 'header', version: 1, revision: snapshot.revision});
    checkCancelled(signal);
    let count = 0, total = 0;
    const topics = new Set<string>();
    for (const id of snapshot.ids) {
        checkCancelled(signal);
        const item = await repository.readSnapshotRecord(snapshot.revision, id, signal);
        checkCancelled(signal);
        if (!item || item.id !== id) throw new MaterialError('storage-error', '材料快照记录不存在');
        if ((item.archivedAt !== null) !== archived) continue;
        total++;
        for (const value of item.topics) {
            if (topics.has(value)) continue;
            topics.add(value);
            yield encode({type: 'topic', value});
            checkCancelled(signal);
        }
        if ((topic && !item.topics.includes(topic)) || !matchesMaterialSearch(item, search)) continue;
        count++;
        yield encode({type: 'summary', value: summarizeMaterial(item)});
        checkCancelled(signal);
    }
    checkCancelled(signal);
    await repository.checkSnapshot(snapshot.revision, signal);
    checkCancelled(signal);
    yield encode({type: 'complete', count, total, topicCount: topics.size});
    checkCancelled(signal);
}

/** Only fixed error codes cross the port; transport cancellation remains distinct. */
export async function* streamMaterialSummaries(repository: SnapshotRepository, options: MaterialSummaryQuery = {}, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    try {yield* readSummaries(repository, options, signal);}
    catch (error) {
        if (signal?.aborted || error instanceof DOMException && error.name === 'AbortError') throw error;
        const allowed: MaterialSummaryReadErrorCode[] = ['stale-operation','limit-exceeded','invalid-input','storage-error'];
        const code = error instanceof MaterialError && allowed.includes(error.code as MaterialSummaryReadErrorCode)
            ? error.code as MaterialSummaryReadErrorCode : 'storage-error';
        yield encode({type:'error',code});
    }
}
