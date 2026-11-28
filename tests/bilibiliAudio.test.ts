import {afterEach, describe, expect, it, vi} from 'vitest';
import {chooseBilibiliAudio, readBilibiliAudio} from '@/src/features/video-subtitle/content/bilibiliAudio';

const part = 'BV193s56tEx2:1';
const url = 'https://audio.bilivideo.com/test.m4s';
const track = (extra = {}) => ({codecs: 'mp4a.40.2', baseUrl: url, bandwidth: 64000, ...extra});
const data = (audio: unknown = [track()]) => ({dash: {audio, duration: 1}});
afterEach(() => vi.useRealTimers());
function fixture(duration = 1) {
    const decoded = {duration, numberOfChannels: 1, sampleRate: 16000, getChannelData: () => new Float32Array([.1, .2])};
    const decode = vi.fn(async (_audio: ArrayBuffer) => decoded);
    const fetch = vi.fn<typeof globalThis.fetch>(async input => String(input).includes('api.bilibili.com')
        ? new Response(JSON.stringify({code: 0, data: data()})) : new Response(new Uint8Array([1, 2])));
    const ports = {fetch, manifest: vi.fn(async () => 123), decode: decode as unknown as (audio: ArrayBuffer) => Promise<AudioBuffer>};
    const abort = new AbortController();
    const run = (id = part, length = 1) => readBilibiliAudio(id, {duration: length} as HTMLVideoElement, abort.signal, ports);
    return {ports, abort, run, decode, decoded, fetch};
}
describe('B 站独立音轨读取', () => {
    it('选择最小 AAC 音轨并拒绝伪造域名、非 HTTPS、凭据和端口', () => {
        expect(chooseBilibiliAudio(data([track({bandwidth: 200000, baseUrl: 'https://a.hdslb.com/large'}), track()]))).toBe(url);
        expect(chooseBilibiliAudio(data([track({baseUrl: '', base_url: 'https://a.bilivideo.cn/audio'})]))).toContain('bilivideo.cn');
        for (const baseUrl of ['https://bilivideo.com.evil.test/a', 'http://a.bilivideo.com/a', 'https://u:p@a.bilivideo.com/a', 'https://a.bilivideo.com:8080/a', 'invalid']) {
            expect(() => chooseBilibiliAudio(data([track({baseUrl})]))).toThrow('官方 AAC');
        }
        expect(() => chooseBilibiliAudio(data([null, track({codecs: 'avc1'}), track({baseUrl: 123})]))).toThrow('官方 AAC');
        for (const value of [null, {}, data(null)]) expect(() => chooseBilibiliAudio(value)).toThrow('独立音轨');
    });
    it.each([part, 'av123:2'])('读取 %s 的音轨，API 携带站点凭据而 CDN 不携带', async id => {
        const f = fixture();
        expect(await f.run(id)).toEqual(new Float32Array([.1, .2]));
        const request = new URL(String(f.fetch.mock.calls[0][0]));
        expect(request.searchParams.get(id.startsWith('av') ? 'avid' : 'bvid')).toBe(id.split(':')[0].replace(/^av/, ''));
        expect(f.fetch.mock.calls[0][1]?.credentials).toBe('include');
        expect(f.fetch.mock.calls[1][1]?.credentials).toBe('omit');
        expect(f.fetch.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true);
        expect(f.decode).toHaveBeenCalledWith(new Uint8Array([1, 2]).buffer);
    });
    it.each(['ep123', 'ss456'])('读取无 DRM 的 B 站番剧 %s 音轨，并拒绝受 DRM 保护的番剧流', async id => {
        const f = fixture();
        f.fetch.mockImplementation(async input => String(input).includes('api.bilibili.com')
            ? new Response(JSON.stringify({code: 0, result: data()})) : new Response(new Uint8Array([1, 2])));
        expect(await f.run(id)).toEqual(new Float32Array([.1, .2]));
        const request = new URL(String(f.fetch.mock.calls[0][0]));
        expect(request.pathname).toBe('/pgc/player/web/playurl');
        expect(request.searchParams.get(id.startsWith('ep') ? 'ep_id' : 'season_id')).toBe(id.slice(2));
        f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({code: 0, result: {...data(), is_drm: true}})));
        await expect(f.run(id)).rejects.toThrow('DRM');
        f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({code: 0, data: {...data(), drm_tech_type: 2}})));
        await expect(f.run(id)).rejects.toThrow('DRM');
    });
    it('在访问媒体前拒绝无效分 P、时长、CID、接口错误和过大的响应', async () => {
        const f = fixture();
        await expect(f.run('bad')).rejects.toThrow('分 P');
        for (const duration of [0, NaN, Infinity, 1201]) await expect(f.run(part, duration)).rejects.toThrow('20 分钟');
        f.ports.manifest.mockResolvedValueOnce(-1);
        await expect(f.run()).rejects.toThrow('身份');
        f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({code: -403})));
        await expect(f.run()).rejects.toThrow('可播放');
        f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({code: 0, data: data()})))
            .mockResolvedValueOnce(new Response('large', {headers: {'content-length': String(49 * 1024 * 1024)}}));
        await expect(f.run()).rejects.toThrow('过大');
        expect(f.decode).not.toHaveBeenCalled();
    });
    it('下载前校验 DASH 报告的时长，优先使用毫秒级结果', async () => {
        const f = fixture();
        for (const timelength of [0, -1000, 4000, 1_200_001]) {
            f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({code: 0, data: {...data(), timelength}})));
            await expect(f.run()).rejects.toThrow('接口音轨时长');
        }
        f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({code: 0, data: {dash: {audio: [track()]}}})));
        await expect(f.run()).rejects.toThrow('接口音轨时长');
        expect(f.fetch.mock.calls.every(([url]) => String(url).includes('api.bilibili.com'))).toBe(true);
        expect(f.decode).not.toHaveBeenCalled();
        f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({code: 0, data: {timelength: 1000, dash: {audio: [track()]}}})));
        await expect(f.run()).resolves.toEqual(new Float32Array([.1, .2]));
    });
    it.each([1201, 5])('拒绝时长不匹配或超限的解码结果 %s', async duration => {
        const f = fixture(duration);
        await expect(f.run()).rejects.toThrow('时长不匹配');
    });
    it('保留 16 kHz 单声道原缓冲区，混合立体声并拒绝其他声道数', async () => {
        const f = fixture(), samples = new Float32Array([.1, .2]);
        f.decoded.getChannelData = () => samples;
        await expect(f.run()).resolves.toBe(samples);
        f.decoded.numberOfChannels = 2;
        await expect(f.run()).resolves.toEqual(samples);
        for (const channels of [0, 6]) {
            f.decoded.numberOfChannels = channels;
            await expect(f.run()).rejects.toThrow('单声道或立体声');
        }
    });
    it('取消和超时不等待解码完成，不提交迟到 PCM', async () => {
        vi.useFakeTimers();
        for (const timeout of [false, true]) {
            const f = fixture();
            let resolve!: (value: typeof f.decoded) => void;
            f.decode.mockImplementation(() => new Promise(done => {resolve = done;}));
            const result = f.run().catch(error => error);
            await vi.advanceTimersByTimeAsync(0);
            if (timeout) await vi.advanceTimersByTimeAsync(90_000);
            else f.abort.abort(new Error('cancel'));
            expect((await result).message).toContain(timeout ? '超时' : 'cancel');
            resolve(f.decoded); await Promise.resolve();
        }
    });
    it('预先取消、身份等待取消和解码失败保留错误并清理', async () => {
        const f = fixture(); f.abort.abort(new Error('already canceled'));
        await expect(f.run()).rejects.toThrow('already canceled');
        const g = fixture(); g.ports.manifest.mockImplementation(async () => {g.abort.abort(new Error('changed')); return 123;});
        await expect(g.run()).rejects.toThrow('changed'); expect(g.fetch).not.toHaveBeenCalled();
        const h = fixture(); h.decode.mockRejectedValueOnce(new Error('decode failed'));
        await expect(h.run()).rejects.toThrow('decode failed');
    });
});
