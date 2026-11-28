import {afterEach, describe, expect, it, vi} from 'vitest';
import {XHlsAudioReader} from '@/src/features/video-subtitle/content/hlsAudioRuntime';
import {audioInit, videoInit} from './fixtures/hlsAudio';

const media = (id: string) => `https://video.twimg.com/ext_tw_video/${id}/pu/pl/audio.m3u8`;
const manifest = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\naudio.m4s\n#EXT-X-ENDLIST';
class FakeContext {
  static closed = 0;
  state = 'running';
  async decodeAudioData(_bytes?: ArrayBuffer) {
    return {duration: 1, numberOfChannels: 1, sampleRate: 16_000, getChannelData: () => new Float32Array(16_000).fill(.04)};
  }
  async close() { this.state = 'closed'; FakeContext.closed++; }
}
function fixture(urls: string[]) {
  vi.stubGlobal('performance', {getEntriesByType: () => urls.map(name => ({name}))});
  vi.stubGlobal('AudioContext', FakeContext);
  const fetcher = vi.fn(async (url: string) => new Response(url.endsWith('.m3u8') ? manifest : url.endsWith('init.mp4') ? audioInit : new Uint8Array([1, 2, 3])));
  vi.stubGlobal('fetch', fetcher);
  const video = {currentSrc: 'blob:home-video', src: '', poster: 'https://pbs.twimg.com/ext_tw_video_thumb/111/pu/img/test.jpg', duration: 1} as HTMLVideoElement;
  return {reader: new XHlsAudioReader(), video, fetcher, signal: new AbortController().signal};
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); FakeContext.closed = 0; });

describe('X 首页音轨恢复', () => {
  it.each(['cancel', 'timeout'] as const)('releases a pending MP4 stream after %s without waiting for its cancellation handshake', async reason => {
    vi.useFakeTimers();
    const url = 'https://video.twimg.com/ext_tw_video/111/pu/vid/video.mp4';
    const {reader, video, fetcher} = fixture([url]);
    const controller = new AbortController();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({cancel});
    fetcher.mockResolvedValue(new Response(body));
    const reading = reader.read(video, controller.signal);
    await vi.advanceTimersByTimeAsync(0); expect(fetcher).toHaveBeenCalledOnce(); expect(body.locked).toBe(true);
    if (reason === 'cancel') controller.abort(); else await vi.advanceTimersByTimeAsync(20_000);
    await expect(reading).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false);
    expect(FakeContext.closed).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it('uses metadata MP4 when no manifest was observed, preferring low bitrate and matching the current media', async () => {
    const {reader, video, signal, fetcher} = fixture([]);
    const mp4 = (id: string, name: string) => `https://video.twimg.com/ext_tw_video/${id}/pu/vid/${name}.mp4`;
    reader.rememberMedia(mp4('111', 'large'), 2000000);
    reader.rememberMedia(mp4('222', 'other'), 100000);
    reader.rememberMedia(mp4('111', 'small'), 256000);
    reader.rememberMedia('https://example.com/unsafe.mp4', 1);
    fetcher.mockResolvedValue(new Response(audioInit));
    expect(await reader.read(video, signal)).toHaveLength(16000);
    expect(fetcher.mock.calls[0][0]).toBe(mp4('111', 'small'));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not assign the only timeline media candidate to a player whose identity is missing', async () => {
    const {reader, video, signal, fetcher} = fixture([]);
    video.poster = '';
    reader.rememberMedia('https://video.twimg.com/ext_tw_video/111/pu/vid/video.mp4', 256000);
    reader.rememberMedia(media('111'));
    expect(await reader.read(video, signal)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('tries the recovered low bitrate MP4 immediately after the primary HLS, ahead of another failing HLS', async () => {
    const {reader, video, signal, fetcher} = fixture([]);
    const mp4 = 'https://video.twimg.com/ext_tw_video/111/pu/vid/video.mp4';
    reader.rememberMedia(mp4, 256000);
    reader.remember(media('111'), manifest.replace('init.mp4', 'secondary-init.mp4'));
    reader.remember(media('111').replace('audio.m3u8', 'primary.m3u8'), manifest.replace('init.mp4', 'primary-init.mp4'));
    fetcher.mockImplementation(async url => new Response(url === mp4 ? audioInit : videoInit));
    expect(await reader.read(video, signal)).toHaveLength(16000);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([media('111').replace('audio.m3u8', 'primary-init.mp4'), mp4]);
  });
  it('rejects video-only MP4 initialization, duration mismatch and oversized MP4 before retaining them', async () => {
    const url = 'https://video.twimg.com/ext_tw_video/111/pu/vid/video.mp4';
    const {reader, video, signal, fetcher} = fixture([url]);
    fetcher.mockResolvedValueOnce(new Response(videoInit));
    expect(await reader.read(video, signal)).toBeNull();
    expect(FakeContext.closed).toBe(0);
    fetcher.mockResolvedValueOnce(new Response(audioInit, {headers: {'content-length': String(33 * 1024 * 1024)}}));
    expect(await reader.read(video, signal)).toBeNull();
    fetcher.mockResolvedValueOnce(new Response(audioInit));
    const decode = vi.spyOn(FakeContext.prototype, 'decodeAudioData').mockResolvedValueOnce({
      duration: 5, numberOfChannels: 1, sampleRate: 16000, getChannelData: () => new Float32Array(80000),
    });
    try { expect(await reader.read(video, signal)).toBeNull(); }
    finally { decode.mockRestore(); }
  });
  it('can discover a working manifest while another same-media discovery stalls', async () => {
    vi.useFakeTimers();
    const stalled = media('111').replace('audio.m3u8', 'stalled.m3u8');
    const {reader, video, signal, fetcher} = fixture([media('111'), stalled]);
    fetcher.mockImplementation((url, options?: RequestInit) => url === stalled
      ? new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError'))))
      : Promise.resolve(new Response(url.endsWith('.m3u8') ? manifest : url.endsWith('init.mp4') ? audioInit : new Uint8Array([1]))));
    const reading = reader.read(video, signal);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await reading).toHaveLength(16000);
    expect(fetcher.mock.calls.some(([url]) => url === media('111'))).toBe(true);
  });
  it('retains a second candidate after the first HLS download reaches its own timeout', async () => {
    vi.useFakeTimers();
    const {reader, video, signal, fetcher} = fixture([]);
    reader.remember(media('111'), manifest);
    reader.remember(media('111').replace('audio.m3u8', 'stalled.m3u8'), manifest.replace('init.mp4', 'stalled-init.mp4'));
    fetcher.mockImplementation((url, options?: RequestInit) => url.endsWith('stalled-init.mp4')
      ? new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError'))))
      : Promise.resolve(new Response(url.endsWith('init.mp4') ? audioInit : new Uint8Array([1]))));
    const reading = reader.read(video, signal);
    await vi.advanceTimersByTimeAsync(30000);
    expect(await reading).toHaveLength(16000);
    expect(FakeContext.closed).toBe(1);
  });
  it('cancels pending decoding immediately when the user leaves the current video', async () => {
    const {reader, video} = fixture([]);
    reader.remember(media('111'), manifest);
    const controller = new AbortController();
    let started!: () => void;
    const decoding = new Promise<void>(resolve => {started = resolve;});
    const decode = vi.spyOn(FakeContext.prototype, 'decodeAudioData').mockImplementation(() => {
      started(); return new Promise(() => undefined);
    });
    try {
      const reading = reader.read(video, controller.signal);
      await decoding;
      controller.abort();
      expect(await reading).toBeNull();
      expect(FakeContext.closed).toBe(1);
    } finally { decode.mockRestore(); }
  });

  it('prefers the audio master over the most recently captured video-only playlist', async () => {
    const {reader, video, signal, fetcher} = fixture([]);
    const master = media('111').replace('audio.m3u8', 'master.m3u8');
    const picture = media('111').replace('audio.m3u8', 'picture.m3u8');
    reader.remember(master, '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,DEFAULT=YES,URI="audio.m3u8"');
    reader.remember(picture, manifest.replaceAll('init.mp4', 'picture-init.mp4').replaceAll('audio.m4s', 'picture.m4s'));
    const decode = vi.spyOn(FakeContext.prototype, 'decodeAudioData').mockImplementation(async function (bytes?: ArrayBuffer) {
      if (bytes && new TextDecoder().decode(bytes).includes('vide')) throw new DOMException('No audio track', 'EncodingError');
      return {duration: 1, numberOfChannels: 1, sampleRate: 16_000, getChannelData: () => new Float32Array(16_000).fill(.04)};
    });
    fetcher.mockImplementation(async url => new Response(url.endsWith('.m3u8') ? manifest : url.endsWith('init.mp4') ? url.includes('picture') ? videoInit : audioInit : new Uint8Array([1])));
    try {
      expect(await reader.read(video, signal)).toHaveLength(16_000);
      expect(fetcher.mock.calls.some(([url]) => url.includes('picture'))).toBe(false);
    } finally { decode.mockRestore(); }
  });
  it('continues with another candidate after audio decoding fails', async () => {
    const {reader, video, signal} = fixture([]);
    reader.remember(media('111'), manifest);
    reader.remember(media('111').replace('audio.m3u8', 'bad.m3u8'), manifest);
    const decode = vi.spyOn(FakeContext.prototype, 'decodeAudioData')
      .mockRejectedValueOnce(new DOMException('Unsupported codec', 'EncodingError'));
    try {
      expect(await reader.read(video, signal)).toHaveLength(16_000);
      expect(decode).toHaveBeenCalledTimes(2);
      expect(FakeContext.closed).toBe(2);
    } finally { decode.mockRestore(); }
  });
  it('skips a video-only child and continues to a captured audio playlist without a master', async () => {
    const {reader, video, signal, fetcher} = fixture([]);
    reader.remember(media('111'), manifest);
    reader.remember(media('111').replace('audio.m3u8', 'picture.m3u8'), manifest.replaceAll('init.mp4', 'picture-init.mp4').replaceAll('audio.m4s', 'picture.m4s'));
    fetcher.mockImplementation(async url => new Response(url.endsWith('init.mp4') ? url.includes('picture') ? videoInit : audioInit : new Uint8Array([1])));
    expect(await reader.read(video, signal)).toHaveLength(16_000);
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('picture-init.mp4'))).toBe(true);
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('picture.m4s'))).toBe(false);
    expect(FakeContext.closed).toBe(1);
  });
  it('recovers other unknown manifests after finding a video-only resource', async () => {
    const picture = media('111').replace('audio.m3u8', 'picture.m3u8');
    const {reader, video, signal, fetcher} = fixture([media('111'), picture]);
    fetcher.mockImplementation(async url => new Response(url.endsWith('.m3u8') ? url === picture ? manifest.replaceAll('init.mp4', 'picture-init.mp4') : manifest : url.endsWith('init.mp4') ? url.includes('picture') ? videoInit : audioInit : new Uint8Array([1])));
    expect(await reader.read(video, signal)).toHaveLength(16_000);
    expect(fetcher.mock.calls.some(([url]) => url === media('111'))).toBe(true);
  });
  it('uses the current poster media ID among multiple preloaded Home videos', async () => {
    const {reader, video, signal, fetcher} = fixture([media('222'), media('111'), 'https://example.com/unsafe.m3u8']);
    const pcm = await reader.read(video, signal);
    expect(pcm).toHaveLength(16_000);
    expect(fetcher.mock.calls.every(([url]) => url.includes('/111/'))).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(media('111'), expect.objectContaining({credentials: 'omit', signal: expect.any(AbortSignal)}));
    expect(FakeContext.closed).toBe(1);
  });
  it('reuses a captured manifest without fetching it again', async () => {
    const {reader, video, signal, fetcher} = fixture([]);
    reader.remember(media('111'), manifest);
    expect(await reader.read(video, signal)).toHaveLength(16_000);
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('.m3u8'))).toBe(false);
  });
  it('uses a confirmed local media identity when the Home video poster is missing', async () => {
    const {reader, video, signal, fetcher} = fixture([media('222'), media('111')]);
    video.poster = '';
    expect(await reader.read(video, signal, {poster: 'https://pbs.twimg.com/ext_tw_video_thumb/111/pu/img/test.jpg'})).toHaveLength(16_000);
    expect(fetcher.mock.calls.every(([url]) => url.includes('/111/'))).toBe(true);
  });
  it('fetches a newer manifest even if an old cached manifest already exists', async () => {
    const newer = media('111').replace('audio.m3u8', 'new.m3u8');
    const {reader, video, signal, fetcher} = fixture([newer]);
    reader.remember(media('111'), manifest.replace('init.mp4', 'expired-init.mp4'));
    expect(await reader.read(video, signal)).toHaveLength(16_000);
    expect(fetcher).toHaveBeenCalledWith(newer, expect.anything());
    expect(fetcher.mock.calls.some(([url]) => url.includes('expired'))).toBe(false);
  });
  it('tries another captured rendition when a preferred master points to an expired URL', async () => {
    const {reader, video, signal, fetcher} = fixture([]);
    reader.remember(media('111'), manifest);
    reader.remember(media('111').replace('audio.m3u8', 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=10\nexpired.m3u8');
    fetcher.mockImplementation(async url => new Response(url.includes('expired') ? '' : url.endsWith('init.mp4') ? audioInit : new Uint8Array([1, 2]), {status: url.includes('expired') ? 403 : 200}));
    expect(await reader.read(video, signal)).toHaveLength(16_000);
    expect(fetcher.mock.calls.some(([url]) => url.includes('expired'))).toBe(true);
    expect(FakeContext.closed).toBe(1);
  });
  it('does not guess which video to recognize when multiple groups have no matching identity', async () => {
    const {reader, video, signal, fetcher} = fixture([media('111'), media('222')]);
    video.poster = '';
    expect(await reader.read(video, signal)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('recovers the unique group without a poster, and reset allows a fresh read', async () => {
    const {reader, video, signal, fetcher} = fixture([media('111')]);
    video.poster = '';
    expect(await reader.read(video, signal)).toHaveLength(16_000);
    reader.reset();
    expect(await reader.read(video, signal)).toHaveLength(16_000);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('.m3u8'))).toHaveLength(2);
  });
  it('tries another manifest of the same media when an old URL has expired', async () => {
    const valid = media('111');
    const expired = valid.replace('audio.m3u8', 'expired.m3u8');
    const {reader, video, signal, fetcher} = fixture([valid, expired]);
    fetcher.mockImplementation(async url => new Response(url === expired ? '' : url === valid ? manifest : url.endsWith('init.mp4') ? audioInit : new Uint8Array([1]), {status: url === expired ? 403 : 200}));
    expect(await reader.read(video, signal)).toHaveLength(16_000);
    expect(fetcher.mock.calls[0][0]).toBe(expired);
  });
  it('aborts a pending discovery immediately when the user changes videos', async () => {
    const {reader, video, fetcher} = fixture([media('111')]);
    const controller = new AbortController();
    fetcher.mockImplementation((_url, options?: RequestInit) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')));
    }));
    const reading = reader.read(video, controller.signal);
    controller.abort();
    expect(await reading).toBeNull();
    expect(FakeContext.closed).toBe(0);
  });
  it('limits discovery time and skips already cancelled requests', async () => {
    vi.useFakeTimers();
    const {reader, video, fetcher, signal} = fixture([media('111')]);
    fetcher.mockImplementation((_url, options?: RequestInit) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')));
    }));
    const reading = reader.read(video, signal);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await reading).toBeNull();
    const cancelled = new AbortController();
    cancelled.abort();
    fetcher.mockClear();
    expect(await reader.read(video, cancelled.signal)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('supports webkitAudioContext, falls back to default sampleRate, and returns null when AudioContext is unavailable', async () => {
    const {reader, video, signal} = fixture([]);
    reader.remember(media('111'), manifest);
    class WebkitFallbackContext extends FakeContext {
      constructor(options?: AudioContextOptions) {
        if (options?.sampleRate === 16_000) throw new DOMException('NotSupportedError');
        super();
      }
    }
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', WebkitFallbackContext);
    expect(await reader.read(video, signal)).toHaveLength(16_000);
    expect(FakeContext.closed).toBe(1);

    vi.stubGlobal('webkitAudioContext', undefined);
    expect(await reader.read(video, signal)).toBeNull();
  });
});
