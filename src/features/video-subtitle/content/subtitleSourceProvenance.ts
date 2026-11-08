/**
 * @file src/features/video-subtitle/content/subtitleSourceProvenance.ts
 * 文件职责：为 JSON3 字幕保留有界、独立于可翻译 cue 的原始 segment 与来源关系。
 * 主要内容：记录原始 UTF-16 范围、未经语义验证的白名单字段、规范化转换及精确 cue 快照；用轻量转换树延迟生成最终来源集合，避免长增量前缀重复复制；超预算时仅退回原有 cues。
 * 模块边界：不把来源偏移解释成词级时间，不将原始范围映射到清洗后或翻译后的文字，不请求网络或模型。
 */
import {sha256Hex} from '@/src/shared/function/sha256';
import {finalizeVideoSubtitleCues, parseYoutubeTimedTextResponse, type VideoSubtitleCue, type SubtitleCueRecorder, type SubtitleCueTransformation as Transformation} from './youtubeSubtitleData';

type SourceScalar = string | number | boolean | null;
export interface SourceSegment {
    readonly index: number;
    readonly text: string;
    /** UTF-16 indices in the original event's joined text, never normalized cue.text. */
    readonly rawStart: number;
    readonly rawEnd: number;
    readonly sourceFields: Readonly<Partial<Record<'tOffsetMs', SourceScalar>>>;
}
export interface SourceEvent {
    readonly index: number;
    readonly segments: readonly SourceSegment[];
    readonly sourceFields: Readonly<Partial<Record<'tStartMs' | 'dDurationMs', SourceScalar>>>;
}
interface Lineage {
    readonly contributors: readonly number[];
    readonly textEvents: readonly number[];
    readonly supersededEvents: readonly number[];
    readonly transformations: readonly Transformation[];
}
export interface SubtitleSourceProvenance {
    readonly version: 1;
    readonly format: 'youtube-json3';
    readonly sourceRevision: string;
    readonly offsetScope: 'raw-event-utf16-only';
    readonly timingEvidence: 'unverified-source-metadata';
    readonly events: readonly SourceEvent[];
    readonly cues: readonly (Lineage & {readonly snapshot: Readonly<VideoSubtitleCue>})[];
}
const MAX_SOURCE_CHARS = 250_000, MAX_EVENTS = 2048, MAX_SEGMENTS = 8192;
function fields<K extends string>(input: unknown, keys: readonly K[]): Readonly<Partial<Record<K, SourceScalar>>> {
    const result: Partial<Record<K, SourceScalar>> = {};
    if (input && typeof input === 'object') for (const key of keys) {
        if (!Object.hasOwn(input, key)) continue;
        const value = (input as Record<string, unknown>)[key];
        if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
            || typeof value === 'string' && value.length <= 128) result[key] = value;
    }
    return Object.freeze(result);
}
type TraceNode = {event: number} | {
    inputs: readonly TraceNode[];
    operation: Transformation | 'duration-preserved';
    winner?: TraceNode;
};
function collectEvents(root: TraceNode, mode: 'all' | 'text' | 'superseded'): number[] {
    const events = new Set<number>();
    const pending: Array<{node: TraceNode; mode: typeof mode}> = [{node: root, mode}];
    while (pending.length) {
        const task = pending.pop()!, node = task.node;
        if ('event' in node) {if (task.mode !== 'superseded') events.add(node.event); continue;}
        if (task.mode === 'superseded' && node.winner) {
            // Inputs partition source events. Losing text can be emitted without rescanning the winner's growing set.
            for (let index = node.inputs.length - 1; index >= 0; index--) {
                if (node.inputs[index] !== node.winner) pending.push({node: node.inputs[index], mode: 'text'});
            }
        }
        const inputs = task.mode === 'text' && node.winner ? [node.winner] : node.inputs;
        // Existing superseded inputs precede the newly losing text, preserving the previous stable order.
        for (let index = inputs.length - 1; index >= 0; index--) pending.push({node: inputs[index], mode: task.mode});
    }
    return [...events];
}
/** Keep transform nodes cheap; materialize source sets once per final cue, without recursive stack growth. */
function materializeTrace(root: TraceNode): Lineage {
    const contributors = collectEvents(root, 'all'), textEvents = collectEvents(root, 'text');
    const transformations = new Set<Transformation>();
    const pending: Array<[TraceNode, boolean]> = [[root, false]];
    while (pending.length) {
        const [node, visited] = pending.pop()!;
        if ('event' in node) continue;
        if (visited) {
            if (node.operation !== 'duration-preserved') transformations.add(node.operation);
        } else {
            pending.push([node, true]);
            for (let index = node.inputs.length - 1; index >= 0; index--) pending.push([node.inputs[index], false]);
        }
    }
    return {contributors: Object.freeze(contributors), textEvents: Object.freeze(textEvents),
        supersededEvents: Object.freeze(collectEvents(root, 'superseded')),
        transformations: Object.freeze([...transformations])};
}

/** The legacy parser and finalizer remain the sole owners of cue transformation decisions. */
export function parseYoutubeTimedTextDocument(source: string): {cues: VideoSubtitleCue[]; provenance?: SubtitleSourceProvenance} {
    let events: readonly SourceEvent[] | undefined;
    const traces = new WeakMap<VideoSubtitleCue, TraceNode>();
    const recorder: SubtitleCueRecorder = {
        begin(raw) {
            if (source.length > MAX_SOURCE_CHARS || raw.length > MAX_EVENTS) return;
            let segmentCount = 0;
            const captured: SourceEvent[] = [];
            for (let index = 0; index < raw.length; index++) {
                const event = raw[index] as {segs?: unknown} | null;
                const segments: SourceSegment[] = [];
                let offset = 0;
                if (event && Array.isArray(event.segs)) for (let at = 0; at < event.segs.length; at++) {
                    if (++segmentCount > MAX_SEGMENTS) return;
                    const segment = event.segs[at];
                    const text = segment && typeof segment.utf8 === 'string' ? segment.utf8 : '';
                    segments.push(Object.freeze({index: at, text, rawStart: offset, rawEnd: offset + text.length,
                        sourceFields: fields(segment, ['tOffsetMs'])}));
                    offset += text.length;
                }
                captured.push(Object.freeze({index, segments: Object.freeze(segments), sourceFields: fields(event, ['tStartMs', 'dDurationMs'])}));
            }
            events = Object.freeze(captured);
        },
        parsed(cue, eventIndex) {
            if (events) traces.set(cue, {event: eventIndex});
        },
        derived(cue, inputs, operation, winner) {
            // Only finalized after every parsed cue has a trace, so all input owners are present.
            const nodes = inputs.map(input => traces.get(input)!);
            // Legacy finalization can revisit unary word merges while another group still shrinks.
            // Identity duration copies and repeated unary operations add no new provenance.
            if (nodes.length === 1 && (operation === 'duration-preserved'
                || !('event' in nodes[0]) && nodes[0].operation === operation)) {
                traces.set(cue, nodes[0]); return;
            }
            traces.set(cue, {inputs: nodes, operation, ...(winner ? {winner: traces.get(winner)!} : {})});
        },
    };
    const parsed = parseYoutubeTimedTextResponse(source, recorder);
    // A JSON payload with no accepted cues can enter the existing XML fallback; it has no JSON3 lineage.
    if (!parsed.length || parsed.some(cue => !traces.has(cue))) return {cues: finalizeVideoSubtitleCues(parsed)};
    const cues = finalizeVideoSubtitleCues(parsed, recorder);
    const lineage = cues.map(cue => Object.freeze({...materializeTrace(traces.get(cue)!), snapshot: Object.freeze({...cue})}));
    const provenance: SubtitleSourceProvenance = Object.freeze({version: 1, format: 'youtube-json3',
        sourceRevision: sha256Hex(source), offsetScope: 'raw-event-utf16-only', timingEvidence: 'unverified-source-metadata',
        events: events!, cues: Object.freeze(lineage)});
    return {cues, provenance};
}
export function provenanceMatchesCues(provenance: SubtitleSourceProvenance, cues: readonly VideoSubtitleCue[]): boolean {
    return provenance.cues.length === cues.length && provenance.cues.every(({snapshot}, index) => {
        const cue = cues[index];
        return snapshot.text === cue.text && snapshot.startMs === cue.startMs && snapshot.durationMs === cue.durationMs;
    });
}
/** Character-equivalent budget includes structural records, including empty segments, not just visible text. */
export function provenanceWeight(provenance: SubtitleSourceProvenance): {chars: number; records: number} {
    let chars = provenance.sourceRevision.length, records = 0;
    for (const event of provenance.events) {
        records++; chars += 32 + JSON.stringify(event.sourceFields).length;
        for (const segment of event.segments) {records++; chars += 32 + segment.text.length + JSON.stringify(segment.sourceFields).length;}
    }
    for (const cue of provenance.cues) chars += cue.snapshot.text.length + 32
        + 8 * (cue.contributors.length + cue.textEvents.length + cue.supersededEvents.length);
    return {chars, records};
}
