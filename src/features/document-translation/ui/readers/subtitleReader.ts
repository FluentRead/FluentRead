/**
 * @file src/features/document-translation/ui/readers/subtitleReader.ts
 *
 * 文件职责：解析 SRT/VTT/ASS/LRC 字幕文档的时间戳、持续时长、语速指标、LRC 元数据、ASS 说话人样式及侧栏时间轴分桶导航。
 * 主要内容：导出 parseSubtitleTimestampMs、formatSubtitleDuration、extractSubtitleMetadata 与 buildSubtitleTimelineOutline，供字幕文档阅读视图消费。
 * 模块边界：无浏览器依赖的纯函数字幕阅读辅助模块，不负责字幕文件导出或 DOM 渲染。
 */

import {hasDistinctTranslation} from '@/src/core/translation/result';
import type {DocumentSegment, ParsedDocument} from '../../core/document';
import {clampPositiveInt} from './shared';

export interface SubtitleTimingMetrics {
    startMs: number | null;
    endMs: number | null;
    durationMs: number | null;
    durationLabel: string;
    cps: number | null;
}

export interface SubtitleLrcMeta {
    title?: string;
    artist?: string;
    album?: string;
    by?: string;
    offset?: string;
}

export interface SubtitleCueMeta {
    style?: string;
    actor?: string;
}

export interface SubtitleDocumentMetadata {
    lrc: SubtitleLrcMeta;
    cues: ReadonlyMap<number, SubtitleCueMeta>;
}

export interface SubtitleTimelineBucket {
    id: string;
    label: string;
    startMs: number;
    endMs: number;
    firstSegmentId: number;
    page: number;
    total: number;
    completed: number;
}

/** 解析 SRT / VTT / ASS / LRC 时间戳为毫秒；格式无效时返回 null。 */
export function parseSubtitleTimestampMs(value?: string): number | null {
    if (!value) return null;
    const trimmed = value.trim();
    const hms = trimmed.match(/^(\d{1,3}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/u);
    if (hms) {
        const hours = Number(hms[1]);
        const minutes = Number(hms[2]);
        const seconds = Number(hms[3]);
        const frac = hms[4] ?? '';
        const ms = frac.length === 1 ? Number(frac) * 100 : frac.length === 2 ? Number(frac) * 10 : Number(frac || 0);
        return ((hours * 60 + minutes) * 60 + seconds) * 1000 + ms;
    }
    const msOnly = trimmed.match(/^(\d{1,3}):(\d{2})(?:[.,](\d{1,3}))?$/u);
    if (msOnly) {
        const minutes = Number(msOnly[1]);
        const seconds = Number(msOnly[2]);
        const frac = msOnly[3] ?? '';
        const ms = frac.length === 1 ? Number(frac) * 100 : frac.length === 2 ? Number(frac) * 10 : Number(frac || 0);
        return (minutes * 60 + seconds) * 1000 + ms;
    }
    return null;
}

export function formatSubtitleDuration(
    timeStart?: string,
    timeEnd?: string,
    text?: string,
): SubtitleTimingMetrics {
    const startMs = parseSubtitleTimestampMs(timeStart);
    const endMs = parseSubtitleTimestampMs(timeEnd);
    if (startMs === null || endMs === null || endMs < startMs) {
        return {startMs, endMs, durationMs: null, durationLabel: '', cps: null};
    }
    const durationMs = endMs - startMs;
    const totalSeconds = durationMs / 1000;
    const durationLabel = totalSeconds >= 60
        ? `${Math.floor(totalSeconds / 60)}m ${(totalSeconds % 60).toFixed(1)}s`
        : `${totalSeconds.toFixed(1)}s`;
    const visibleLength = text ? text.replace(/\s+/gu, '').length : 0;
    const cps = durationMs > 0 && visibleLength > 0
        ? Math.round((visibleLength / totalSeconds) * 10) / 10
        : null;
    return {startMs, endMs, durationMs, durationLabel, cps};
}

export function extractSubtitleMetadata(document: ParsedDocument): SubtitleDocumentMetadata {
    const lrc: SubtitleLrcMeta = {};
    const cues = new Map<number, SubtitleCueMeta>();

    if (document.format === 'lrc') {
        const tagMap: Record<string, keyof SubtitleLrcMeta> = {
            ti: 'title',
            ar: 'artist',
            al: 'album',
            by: 'by',
            offset: 'offset',
        };
        for (const part of document.parts) {
            if (part.kind !== 'literal') continue;
            for (const match of part.value.matchAll(/\[(ti|ar|al|by|offset):([^\]\r\n]+)\]/giu)) {
                const field = tagMap[match[1].toLowerCase()];
                const content = match[2].trim();
                if (content && !lrc[field]) lrc[field] = content;
            }
        }
        return {lrc, cues};
    }

    if (document.format === 'ass') {
        for (let index = 0; index < document.parts.length; index += 1) {
            const part = document.parts[index];
            if (part.kind !== 'segment') continue;
            const prev = document.parts[index - 1];
            if (!prev || prev.kind !== 'literal') continue;
            const lastLine = prev.value.slice(prev.value.lastIndexOf('\n') + 1);
            const dialogueMatch = lastLine.match(/^\s*Dialogue\s*:(.*)$/iu);
            if (!dialogueMatch) continue;
            const fields = dialogueMatch[1].split(',');
            const style = fields[3]?.trim() || undefined;
            const actor = fields[4]?.trim() || undefined;
            if (style || actor) cues.set(part.segmentIndex, {...(style ? {style} : {}), ...(actor ? {actor} : {})});
        }
    }

    return {lrc, cues};
}

function formatClockLabel(ms: number): string {
    const totalMinutes = Math.floor(ms / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:00`
        : `${String(minutes).padStart(2, '0')}:00`;
}

export function buildSubtitleTimelineOutline(
    segments: readonly DocumentSegment[],
    translations: readonly string[],
    options?: {bucketMinutes?: number; pageSize?: number},
): SubtitleTimelineBucket[] {
    const timed = segments
        .map((segment, rowIndex) => ({segment, rowIndex, ms: parseSubtitleTimestampMs(segment.timeStart)}))
        .filter((entry): entry is {segment: DocumentSegment; rowIndex: number; ms: number} => entry.ms !== null);
    if (timed.length === 0) return [];

    const maxMs = timed.reduce((max, item) => Math.max(max, item.ms), 0);
    const bucketMinutes = options?.bucketMinutes !== undefined
        ? clampPositiveInt(options.bucketMinutes, 5)
        : maxMs > 60 * 60_000 ? 10 : 5;
    const bucketMs = bucketMinutes * 60_000;
    const pageSize = clampPositiveInt(options?.pageSize ?? 50, 50);

    const buckets: SubtitleTimelineBucket[] = [];
    const byBucket = new Map<number, SubtitleTimelineBucket>();
    for (const {segment, rowIndex, ms} of timed) {
        const bucketIndex = Math.floor(ms / bucketMs);
        const done = hasDistinctTranslation(segment.source, translations[segment.id]);
        const existing = byBucket.get(bucketIndex);
        if (existing) {
            existing.total += 1;
            if (done) existing.completed += 1;
            continue;
        }
        const startMs = bucketIndex * bucketMs;
        const endMs = startMs + bucketMs;
        const bucket: SubtitleTimelineBucket = {
            id: `t-${bucketIndex}`,
            label: `${formatClockLabel(startMs)} – ${formatClockLabel(endMs)}`,
            startMs,
            endMs,
            firstSegmentId: segment.id,
            page: Math.floor(rowIndex / pageSize) + 1,
            total: 1,
            completed: done ? 1 : 0,
        };
        byBucket.set(bucketIndex, bucket);
        buckets.push(bucket);
    }

    return buckets;
}
