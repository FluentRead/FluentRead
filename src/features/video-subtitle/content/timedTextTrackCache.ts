/**
 * @file src/features/video-subtitle/content/timedTextTrackCache.ts
 * 文件职责：区分同视频的 timedtext 轨道，并约束捕获轨道的保留量。
 * 主要内容：轨道身份忽略传输签名与格式，保留视频、语言、目标语言、种类和字幕名称；缓存按数量、cue 数量和文本长度淘汰旧轨，优先保留新轨和当前轨；来源附表的原文与结构记录一并计费，返回前校验 cue 快照以丢弃过期附表。
 * 模块边界：不读取网络或播放器，不证明页面桥消息可信；允许当前轨与新轨超预算以保留播放身份，输入大小由各采集入口限制。
 */
import {provenanceMatchesCues, provenanceWeight, type SubtitleSourceProvenance} from './subtitleSourceProvenance';
import type {VideoSubtitleCue} from './youtubeSubtitleData';

export function timedTextTrackKey(url: string, baseHref: string): string {
    try {
        const params = new URL(url, baseHref).searchParams;
        return JSON.stringify(['v', 'lang', 'tlang', 'kind', 'name'].map(key => {
            const values = params.getAll(key);
            return values.length ? values : [''];
        }));
    } catch {return url;}
}

export interface CapturedSubtitleTrack {url: string; cues: VideoSubtitleCue[]; provenance?: SubtitleSourceProvenance}

export class TimedTextTrackCache {
    private readonly tracks = new Map<string, CapturedSubtitleTrack>();
    private readonly weights = new Map<string, {chars: number; cues: number}>();
    private chars = 0;
    private cues = 0;
    constructor(private readonly currentKey: () => string,
        private readonly limits = {tracks: 8, chars: 8_000_000, cues: 80_000}) {}
    private validated(entry: CapturedSubtitleTrack): CapturedSubtitleTrack {
        return entry.provenance && !provenanceMatchesCues(entry.provenance, entry.cues) ? {url: entry.url, cues: entry.cues} : entry;
    }
    get(key: string): CapturedSubtitleTrack | undefined {const entry = this.tracks.get(key); return entry && this.validated(entry);}
    *entries(): IterableIterator<[string, CapturedSubtitleTrack]> {for (const [key, entry] of this.tracks) yield [key, this.validated(entry)];}
    *values(): IterableIterator<CapturedSubtitleTrack> {for (const entry of this.tracks.values()) yield this.validated(entry);}
    delete(key: string): boolean {
        const weight = this.weights.get(key);
        if (!weight) return false;
        this.weights.delete(key); this.chars -= weight.chars; this.cues -= weight.cues;
        return this.tracks.delete(key);
    }
    clear(): void {this.tracks.clear(); this.weights.clear(); this.chars = 0; this.cues = 0;}
    set(key: string, entry: CapturedSubtitleTrack): void {
        this.delete(key);
        entry = this.validated(entry);
        const weight = {chars: entry.url.length + key.length, cues: entry.cues.length};
        for (const cue of entry.cues) weight.chars += cue.text.length;
        if (entry.provenance) {const extra = provenanceWeight(entry.provenance); weight.chars += extra.chars; weight.cues += extra.records;}
        this.weights.set(key, weight); this.tracks.set(key, entry);
        this.chars += weight.chars; this.cues += weight.cues;
        while (this.tracks.size > 1 && (this.tracks.size > this.limits.tracks || this.chars > this.limits.chars || this.cues > this.limits.cues)) {
            const current = this.currentKey();
            const candidates = this.tracks.keys();
            let oldest: string | undefined;
            for (const candidate of candidates) {
                if (candidate !== key && candidate !== current) {oldest = candidate; break;}
            }
            // 两条受保护轨超预算时允许超额，后续插入再检查，避免关闭译文期间丢失当前轨。
            if (oldest === undefined) break;
            this.delete(oldest);
        }
    }
}
