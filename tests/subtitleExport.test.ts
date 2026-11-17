import {describe, expect, it} from 'vitest';
import {serializeSubtitleFile} from '@/src/features/video-subtitle/content/subtitleExport';

describe('portable subtitle exports', () => {
    const cues = [{startMs: 3600123, durationMs: 1567, text: 'Original <text> & [link]\n原文译文'}];
    it('preserves bilingual lines and millisecond timestamps in SRT', () => {
        expect(serializeSubtitleFile(cues, 'srt')).toEqual({text: '1\n01:00:00,123 --> 01:00:01,690\nOriginal <text> & [link]\n原文译文\n', extension: 'srt', mime: 'application/x-subrip;charset=utf-8'});
    });
    it('escapes cue markup and uses WebVTT timestamps', () => {
        const result = serializeSubtitleFile(cues, 'vtt');
        expect(result).toMatchObject({extension: 'vtt', mime: 'text/vtt;charset=utf-8'});
        expect(result.text).toBe('WEBVTT\n\n01:00:00.123 --> 01:00:01.690\nOriginal &lt;text&gt; &amp; [link]\n原文译文\n');
    });
    it('makes readable Markdown without interpreting recognized text as markup', () => {
        expect(serializeSubtitleFile(cues, 'md')).toEqual({text: '### 01:00:00.123 – 01:00:01.690\n\nOriginal \\<text\\> & \\[link\\]  \n原文译文\n', extension: 'md', mime: 'text/markdown;charset=utf-8'});
        expect(serializeSubtitleFile([], 'md').text).toBe('');
    });
});
