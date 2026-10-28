/** Decode a single material-summary stream without exposing partial results. */
import {compareMaterialSummaries, type MaterialSummary} from './materialSummary';
import {MaterialError} from './materialModel';
import type {MaterialSummaryReadErrorCode} from './materialReadSource';

export const MATERIAL_SUMMARY_LINE_BYTES = 512 * 1024;
const MAX_MATERIALS = 10_000;
const MAX_TOPICS = MAX_MATERIALS * 30;
const MAX_URL_LENGTH = 8192 * 16 + 16;

export interface DecodedMaterialSummaries {
    revision: number;
    summaries: MaterialSummary[];
    topics: string[];
    total: number;
}
export type MaterialSummaryConsumer = (onChunk: (chunk: Uint8Array) => void, signal: AbortSignal) => Promise<void>;

function invalid(): never {throw Error('Invalid material summary stream');}
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    const record = value as Record<string, unknown>, keys = Object.keys(record);
    if (required.some(key => !Object.hasOwn(record, key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) return invalid();
    return record;
}
function boundedString(value: unknown, max: number, empty = false): value is string {
    return typeof value === 'string' && value.length <= max && (empty || value.length > 0);
}
function count(value: unknown, max: number): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
function time(value: unknown): value is number {return typeof value === 'number' && Number.isFinite(value) && value >= 0;}
function summary(value: unknown, topics: Set<string>): MaterialSummary {
    const item = object(value, ['id','kind','title','topics','lastReadAt','updatedAt','archivedAt','preview','referenceCount'], ['sourceUrl']);
    if (!boundedString(item.id,256) || !['article','document','video'].includes(item.kind as string)
        // Untitled captures fall back to the URL hostname, which is not limited
        // by the 240-character limit used for explicit titles.
        || !boundedString(item.title,MAX_URL_LENGTH) || (item.sourceUrl !== undefined && !boundedString(item.sourceUrl,MAX_URL_LENGTH,true))
        || !Array.isArray(item.topics) || item.topics.length > 30
        || !time(item.lastReadAt) || !time(item.updatedAt) || (item.archivedAt !== null && !time(item.archivedAt))
        || !boundedString(item.preview,12000,true) || !count(item.referenceCount,1000)) return invalid();
    const topicSet = new Set<string>();
    for (const topic of item.topics) {
        if (!boundedString(topic,80) || topicSet.has(topic) || !topics.has(topic)) return invalid();
        topicSet.add(topic);
    }
    return item as unknown as MaterialSummary;
}

/**
 * The caller supplies the transport and must resolve it only after transport
 * completion is verified. A footer alone never makes partial data observable.
 */
export async function decodeMaterialSummaries(consume: MaterialSummaryConsumer, options: {signal?: AbortSignal} = {}): Promise<DecodedMaterialSummaries> {
    const controller = new AbortController(), signal = options.signal;
    const summaries: MaterialSummary[] = [], topics: string[] = [];
    const ids = new Set<string>(), seenTopics = new Set<string>();
    let phase: 'header' | 'body' | 'complete' | 'error' = 'header', revision = 0, total = 0;
    let sourceError: MaterialSummaryReadErrorCode | undefined;
    let decoder = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}), line = '', lineBytes = 0, active = true;
    let failure: unknown;
    const cancelled = () => new DOMException('材料读取已取消', 'AbortError');
    const abort = () => {controller.abort();};
    const discard = () => {summaries.length = 0; topics.length = 0; ids.clear(); seenTopics.clear(); line = '';};
    const acceptLine = (text: string) => {
        let parsed: unknown;
        try {parsed = JSON.parse(text);} catch {return invalid();}
        const message = object(parsed, ['type'], ['version','revision','value','count','total','topicCount','code']);
        if ((phase === 'header' || phase === 'body') && message.type === 'error') {
            object(parsed, ['type','code']);
            if (!['stale-operation','limit-exceeded','invalid-input','storage-error'].includes(message.code as string)) return invalid();
            sourceError = message.code as MaterialSummaryReadErrorCode;
            phase = 'error'; discard(); return;
        }
        if (phase === 'header') {
            object(parsed, ['type','version','revision']);
            if (message.type !== 'header' || message.version !== 1 || !count(message.revision,Number.MAX_SAFE_INTEGER)) return invalid();
            revision = message.revision; phase = 'body'; return;
        }
        if (phase !== 'body') return invalid();
        if (message.type === 'topic') {
            object(parsed, ['type','value']);
            if (!boundedString(message.value,80) || seenTopics.has(message.value) || topics.length >= MAX_TOPICS) return invalid();
            seenTopics.add(message.value); topics.push(message.value); return;
        }
        if (message.type === 'summary') {
            object(parsed, ['type','value']);
            if (summaries.length >= MAX_MATERIALS) return invalid();
            const item = summary(message.value, seenTopics);
            if (ids.has(item.id)) return invalid();
            ids.add(item.id); summaries.push(item); return;
        }
        if (message.type === 'complete') {
            object(parsed, ['type','count','total','topicCount']);
            if (!count(message.count,MAX_MATERIALS) || !count(message.total,MAX_MATERIALS) || !count(message.topicCount,MAX_TOPICS)
                || message.count !== summaries.length || message.topicCount !== topics.length || message.count > message.total
                || message.topicCount > message.total * 30) return invalid();
            total = message.total; phase = 'complete'; return;
        }
        return invalid();
    };
    const onChunk = (chunk: Uint8Array) => {
        if (!active) throw failure ?? Error('Material summary stream is closed');
        try {
            if (controller.signal.aborted) throw cancelled();
            if (!(chunk instanceof Uint8Array)) return invalid();
            for (let start = 0; start < chunk.length;) {
                if (phase === 'complete' || phase === 'error') return invalid();
                const end = chunk.indexOf(10,start), stop = end < 0 ? chunk.length : end;
                lineBytes += stop - start;
                if (lineBytes > MATERIAL_SUMMARY_LINE_BYTES) throw Error('Material summary line is too large');
                line += decoder.decode(chunk.subarray(start,stop), {stream:true});
                if (end < 0) break;
                line += decoder.decode();
                acceptLine(line); line = ''; lineBytes = 0;
                decoder = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true});
                start = end + 1;
            }
        } catch (error) {
            failure = error; active = false; controller.abort(); discard(); throw error;
        }
    };
    // The transport callback updates phase asynchronously from this function's perspective.
    const isComplete = () => phase === 'complete';
    let rejectAbort: ((reason: unknown) => void) | undefined;
    const onAbort = () => {abort(); rejectAbort?.(cancelled());};
    const interrupted = new Promise<never>((_, reject) => {rejectAbort = reject;});
    void interrupted.catch(() => {});
    try {
        if (signal?.aborted) throw cancelled();
        signal?.addEventListener('abort', onAbort, {once:true});
        const completion = Promise.resolve().then(() => {
            if (controller.signal.aborted) throw cancelled();
            return consume(onChunk, controller.signal);
        });
        await (signal ? Promise.race([completion, interrupted]) : completion);
        if (signal?.aborted) throw cancelled();
        if (failure !== undefined) throw failure;
        if (sourceError !== undefined) throw new MaterialError(sourceError, '材料读取失败');
        if (!isComplete() || lineBytes !== 0) return invalid();
        summaries.sort(compareMaterialSummaries); topics.sort((a,b) => a.localeCompare(b));
        return {revision, summaries, topics, total};
    } catch (error) {
        abort(); discard(); throw failure ?? error;
    } finally {
        active = false; signal?.removeEventListener('abort',onAbort);
    }
}
