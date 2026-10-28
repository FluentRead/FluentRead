/**
 * @file tests/timedTextTrackCache.test.ts
 * 文件职责：验证视频字幕轨道身份和捕获缓存的资源预算。
 * 主要内容：覆盖同轨签名/格式、命名轨、分隔符冲突、非法地址、轨道数量/文本/cue 预算、当前轨与新轨保留及清空。
 * 模块边界：不访问真实 YouTube 或浏览器；生产接线由 videoSubtitleTrackPriorityRuntime 测试。
 */
import {describe, expect, it} from 'vitest';
import {TimedTextTrackCache, timedTextTrackKey} from '@/src/features/video-subtitle/content/timedTextTrackCache';
const base = 'https://www.youtube.com/watch?v=video';
const track = (text: string, url = 'u') => ({url, cues: [{startMs: 0, durationMs: 1000, text}]});

describe('timedtext track identity', () => {
    it('name 区分同语言字幕，签名、格式和 POT 更新保持同轨', () => {
        const url = '/api/timedtext?v=video&lang=en&kind=asr&name=Voice+A&sig=one&fmt=json3';
        expect(timedTextTrackKey(url, base)).toBe(timedTextTrackKey(url.replace('sig=one', 'sig=two').replace('fmt=json3', 'fmt=vtt') + '&pot=token', base));
        expect(timedTextTrackKey(url, base)).not.toBe(timedTextTrackKey(url.replace('Voice+A', 'Voice+B'), base));
        expect(timedTextTrackKey('/api/timedtext?v=video&lang=en', base)).toBe(timedTextTrackKey('/api/timedtext?v=video&lang=en&name=', base));
        expect(timedTextTrackKey('/api/timedtext?v=video&lang=en&kind=a%3Ab&name=c', base))
            .not.toBe(timedTextTrackKey('/api/timedtext?v=video&lang=en&kind=a&name=b%3Ac', base));
        expect(timedTextTrackKey('/api/timedtext?v=video&name=A&name=B', base)).not.toBe(timedTextTrackKey('/api/timedtext?v=video&name=A', base));
        expect(timedTextTrackKey('http://[bad', base)).toBe('http://[bad');
    });
});

describe('bounded captured subtitle cache', () => {
    it('保留新轨与当前轨，淘汰最老的其他轨，删除/清空同步释放预算', () => {
        let current = 'a';
        const cache = new TimedTextTrackCache(() => current, {tracks: 2, chars: 1000, cues: 100});
        cache.set('a', track('A')); cache.set('b', track('B')); cache.set('c', track('C'));
        expect([...cache.entries()].map(([key]) => key)).toEqual(['a', 'c']);
        expect([...cache.values()].map(value => value.cues[0].text)).toEqual(['A', 'C']);
        expect(cache.get('a')?.cues[0].text).toBe('A'); expect(cache.get('b')).toBeUndefined();
        current = 'a'; cache.set('d', track('D')); expect([...cache.entries()].map(([key]) => key)).toEqual(['a', 'd']);
        expect(cache.delete('missing')).toBe(false); expect(cache.delete('a')).toBe(true);
        cache.set('e', track('E')); expect([...cache.entries()].map(([key]) => key)).toEqual(['d', 'e']);
        cache.clear(); expect([...cache.values()]).toEqual([]); cache.set('z', track('Z')); expect(cache.get('z')).toEqual(track('Z'));
    });
    it.each(['chars', 'cues'] as const)('按 %s 预算淘汰非当前轨', budget => {
        const limits = budget === 'chars' ? {tracks: 9, chars: 9, cues: 99} : {tracks: 9, chars: 1000, cues: 1};
        const cache = new TimedTextTrackCache(() => '', limits);
        cache.set('a', track('aaa')); cache.set('b', track('bbb'));
        expect(cache.get('a')).toBeUndefined(); expect(cache.get('b')).toEqual(track('bbb'));
    });
    it('关闭翻译时当前轨与新轨即使超预算也不丢失，其他轨仍被淘汰', () => {
        const cache = new TimedTextTrackCache(() => 'a', {tracks: 2, chars: 4, cues: 1});
        cache.set('a', track('current')); cache.set('b', track('new'));
        expect([...cache.entries()].map(([key]) => key)).toEqual(['a', 'b']);
        cache.set('c', track('newer'));
        expect([...cache.entries()].map(([key]) => key)).toEqual(['a', 'c']);
    });
    it('大量不同名字的轨道始终有界，保留正在播放的旧轨和最新七轨', () => {
        const cache = new TimedTextTrackCache(() => '0');
        for (let i = 0; i < 1000; i++) cache.set(String(i), track(`caption ${i}`));
        const keys = [...cache.entries()].map(([key]) => key);
        expect(keys).toEqual(['0', '993', '994', '995', '996', '997', '998', '999']);
    });
    it('允许单条超预算轨保持播放；替换会正确扣除旧权重', () => {
        const cache = new TimedTextTrackCache(() => '', {tracks: 1, chars: 5, cues: 1});
        cache.set('a', track('long track')); expect(cache.get('a')).toBeDefined();
        cache.set('a', track('x')); cache.set('b', track('y')); expect([...cache.entries()].map(([key]) => key)).toEqual(['b']);
    });
});
