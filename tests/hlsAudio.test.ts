import {describe, expect, it, vi} from 'vitest';
import {
  isXMediaUrl,
  hasMp4AudioTrack,
  parseHlsAudioManifest,
  readBoundedMediaResponse,
  readXHlsAudio,
} from '@/src/features/video-subtitle/content/hlsAudio';
import {audioInit, videoInit, joinBytes, mp4Box} from './fixtures/hlsAudio';

const base = 'https://video.twimg.com/ext/audio/master.m3u8';
function response(bytes: Uint8Array, init: ResponseInit = {}): Response {
  return new Response(new ReadableStream({start(controller) { controller.enqueue(bytes); controller.close(); }}), {
    status: 200, headers: {'content-length': String(bytes.length), ...(init.headers || {})}, ...init,
  });
}
const textBytes = (value: string) => new TextEncoder().encode(value);
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('HLS audio', () => {
  it.each([{status: 503}, {headers: {'content-length': '11'}}])('releases rejected media response headers without awaiting stream cancellation: %j', async init => {
    let rejectCancel!: (error: Error) => void;
    const cancellation = new Promise<void>((_resolve, reject) => {rejectCancel = reject;});
    const cancel = vi.fn(() => cancellation);
    const result = new Response(new ReadableStream({cancel}), init);
    await expect(readBoundedMediaResponse(result, 10, new AbortController().signal)).rejects.toThrow('无效');
    expect(cancel).toHaveBeenCalledOnce();
    expect(result.body!.locked).toBe(false);
    rejectCancel(new Error('Late media cancellation failure'));
    await Promise.resolve();
  });
  it('checks actual MP4 track metadata, including multiple tracks and extended box sizes', () => {
    expect(hasMp4AudioTrack(audioInit)).toBe(true);
    expect(hasMp4AudioTrack(videoInit)).toBe(false);
    expect(hasMp4AudioTrack(joinBytes(mp4Box('ftyp'), videoInit, audioInit))).toBe(true);
    expect(hasMp4AudioTrack(mp4Box('moov', audioInit.slice(8), 'large'))).toBe(true);
    expect(hasMp4AudioTrack(mp4Box('moov', audioInit.slice(8), 'rest'))).toBe(true);
    expect(hasMp4AudioTrack(mp4Box('free', audioInit))).toBe(false);
    expect(hasMp4AudioTrack(new Uint8Array())).toBe(false);
    expect(hasMp4AudioTrack(audioInit.slice(0, -1))).toBe(false);
    expect(hasMp4AudioTrack(mp4Box('moov', mp4Box('trak', mp4Box('mdia', mp4Box('hdlr')))))).toBe(false);
    const short = mp4Box('moov');
    new DataView(short.buffer).setUint32(0, 4);
    expect(hasMp4AudioTrack(short)).toBe(false);
    new DataView(short.buffer).setUint32(0, 1);
    expect(hasMp4AudioTrack(short)).toBe(false);
    const unsafe = mp4Box('moov', new Uint8Array(), 'large');
    new DataView(unsafe.buffer).setBigUint64(8, 2n ** 63n);
    expect(hasMp4AudioTrack(unsafe)).toBe(false);
  });

  it('rejects a video-only playlist after its initialization segment without downloading picture fragments', async () => {
    const playlist = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\npicture.m4s\n#EXT-X-ENDLIST';
    const fetchResource = vi.fn(async (_url: string) => response(videoInit));
    expect(await readXHlsAudio(base, playlist, new AbortController().signal, fetchResource)).toBeNull();
    expect(fetchResource).toHaveBeenCalledTimes(1);
    expect(fetchResource.mock.calls[0][0]).toContain('init.mp4');
  });
  it('validates X media URLs and selects default AUDIO rendition', () => {
    expect(isXMediaUrl(base)).toBe(true);
    expect(isXMediaUrl('http://video.twimg.com/x')).toBe(false);
    expect(isXMediaUrl('https://example.com/x')).toBe(false);
    expect(isXMediaUrl('https://[bad')).toBe(false);
    expect(isXMediaUrl('https://user:pass@video.twimg.com/x')).toBe(false);
    const parsed = parseHlsAudioManifest('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",DEFAULT=NO,URI="no.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",DEFAULT=YES,URI="yes.m3u8"', base);
    expect(parsed).toEqual({next: 'https://video.twimg.com/ext/audio/yes.m3u8', alternatives: ['https://video.twimg.com/ext/audio/no.m3u8'], durationMs: 0});
  });

  it('uses another rendition declared by the master when the default is expired or contains only video', async () => {
    const audio = '#EXTM3U\n#EXT-X-MAP:URI="audio-init.mp4"\n#EXTINF:1,\naudio.m4s\n#EXT-X-ENDLIST';
    const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,DEFAULT=YES,URI="expired.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,URI="picture.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,URI="good.m3u8"';
    const fetchResource = vi.fn(async (url: string) => {
      if (url.endsWith('expired.m3u8')) return response(new Uint8Array(), {status: 403});
      if (url.endsWith('picture.m3u8')) return response(textBytes(audio.replace('audio-init', 'picture-init')));
      if (url.endsWith('good.m3u8')) return response(textBytes(audio));
      if (url.endsWith('picture-init.mp4')) return response(videoInit);
      return response(url.endsWith('audio-init.mp4') ? audioInit : textBytes('A'));
    });
    expect(await readXHlsAudio(base, master, new AbortController().signal, fetchResource)).toMatchObject({durationMs: 1000, bytes: joinBytes(audioInit, textBytes('A'))});
    expect(fetchResource.mock.calls.some(([url]) => url.endsWith('good.m3u8'))).toBe(true);
  });

  it('does not spend the complete media budget on a stalled default rendition header', async () => {
    vi.useFakeTimers();
    const child = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\na.m4s\n#EXT-X-ENDLIST';
    const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,DEFAULT=YES,URI="stalled.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,URI="good.m3u8"';
    const fetcher = vi.fn((url: string, options: {signal: AbortSignal}) => url.endsWith('stalled.m3u8')
      ? new Promise<Response>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError'))))
      : Promise.resolve(response(url.endsWith('.m3u8') ? textBytes(child) : url.endsWith('init.mp4') ? audioInit : textBytes('A'))));
    try {
      const reading = readXHlsAudio(base, master, new AbortController().signal, fetcher);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await reading).toMatchObject({durationMs: 1000});
    } finally { vi.useRealTimers(); }
  });

  it('bounds master nesting and returns the final error when all declared renditions fail', async () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8';
    const nested = vi.fn(async (url: string) => response(textBytes(master.replace('child.m3u8', `${url.split('/').pop()}-child.m3u8`))));
    expect(await readXHlsAudio(base, master, new AbortController().signal, nested)).toBeNull();
    expect(nested).toHaveBeenCalledTimes(3);
    await expect(readXHlsAudio(base, master, new AbortController().signal, async () => {throw new Error('all expired');})).rejects.toThrow('all expired');
    expect(parseHlsAudioManifest('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,DEFAULT=YES\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8', base)?.next).toContain('child.m3u8');
    expect(await readXHlsAudio(base, '#EXTM3U', new AbortController().signal, nested)).toBeNull();
    const wideMaster = '#EXTM3U\n' + Array.from({length: 6}, (_, index) => `#EXT-X-STREAM-INF:BANDWIDTH=${index + 1}\ngroup-${index}.m3u8`).join('\n');
    const wide = vi.fn(async (url: string) => response(textBytes(url.includes('group-')
      ? wideMaster.replaceAll('group-', 'leaf-') : '#EXTM3U')));
    expect(await readXHlsAudio(base, wideMaster, new AbortController().signal, wide)).toBeNull();
    expect(wide.mock.calls.length).toBeLessThanOrEqual(11);
  });

  it('cancels a pending initialization request and releases all scopes', async () => {
    const controller = new AbortController();
    const manifest = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\na.m4s\n#EXT-X-ENDLIST';
    const reading = readXHlsAudio(base, manifest, controller.signal, (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')));
    }));
    controller.abort();
    expect(await reading).toBeNull();
  });

  it('selects lowest bandwidth variant and parses complete fMP4 playlist in order', () => {
    const variant = parseHlsAudioManifest('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900\nhi.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8', base);
    expect(variant?.next).toContain('low.m3u8');
    const media = parseHlsAudioManifest('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1.5,\na.m4s\n#EXTINF:2,\nb.m4s\n#EXT-X-ENDLIST', base);
    expect(media).toEqual({segments: [expect.stringContaining('init.mp4'), expect.stringContaining('a.m4s'), expect.stringContaining('b.m4s')], durationMs: 3500});
  });

  it('拒绝加密、byterange、discontinuity、开放或超限清单', () => {
    const reject = (extra: string) => expect(parseHlsAudioManifest(`#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\na.m4s\n#EXT-X-ENDLIST\n${extra}`, base)).toBeNull();
    reject('#EXT-X-KEY:METHOD=AES-128,URI="key"');
    reject('#EXT-X-BYTERANGE:10@0');
    reject('#EXT-X-DISCONTINUITY');
    expect(parseHlsAudioManifest('#EXTM3U\n#EXTINF:1,\na.m4s', base)).toBeNull();
    expect(parseHlsAudioManifest('#EXTM3U\n#EXT-X-ENDLIST', base)).toBeNull();
    expect(parseHlsAudioManifest('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\na.m4s\n#EXT-X-ENDLIST', 'https://example.com/master.m3u8')).toBeNull();
    expect(parseHlsAudioManifest('#EXTM3U' + 'x'.repeat(1_000_001), base)).toBeNull();
    expect(parseHlsAudioManifest('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=\n', base)).toBeNull();
    expect(parseHlsAudioManifest('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n#EXT-X-ENDLIST', base)).toBeNull();
    expect(parseHlsAudioManifest('#EXTM3U\n#EXT-X-STREAM-INF:\nlow.m3u8', base)?.next).toContain('low.m3u8');
    const tooMany = ['#EXTM3U', '#EXT-X-MAP:URI="init.mp4"', ...Array.from({length: 257}, (_, i) => `#EXTINF:1,\nseg-${i}.m4s`), '#EXT-X-ENDLIST'].join('\n');
    expect(parseHlsAudioManifest(tooMany, base)).toBeNull();
    expect(parseHlsAudioManifest('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1201,\na.m4s\n#EXT-X-ENDLIST', base)).toBeNull();
  });

  it('读取 bounded stream，拒绝空体、非 OK、声明超限和实际超限', async () => {
    const controller = new AbortController();
    await expect(readBoundedMediaResponse(response(textBytes('abc')), 10, controller.signal)).resolves.toEqual(textBytes('abc'));
    await expect(readBoundedMediaResponse(new Response(null, {status: 500}), 10, controller.signal)).rejects.toThrow('无效');
    await expect(readBoundedMediaResponse(response(textBytes('abc'), {headers: {'content-length': '11'}}), 10, controller.signal)).rejects.toThrow('无效');
    await expect(readBoundedMediaResponse(new Response(null, {status: 200}), 10, controller.signal)).rejects.toThrow('为空');
    const oversized = new Response(new ReadableStream({start(c) { c.enqueue(textBytes('1234')); c.close(); }}), {status: 200});
    await expect(readBoundedMediaResponse(oversized, 3, controller.signal)).rejects.toThrow('读取上限');
  });

  it('在流读取等待期间收到 abort 时拒绝取消错误', async () => {
    const controller = new AbortController();
    const pending = readBoundedMediaResponse(new Response(new ReadableStream({
      pull() { return new Promise<void>(() => undefined); },
      cancel() { return Promise.reject(new Error('late reader cancel rejection')); },
    })), 10, controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow('读取已取消');
  });

  it('读取音轨时保持段落顺序、并发为 3，并传递 omit credentials', async () => {
    const manifest = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\na.m4s\n#EXTINF:1,\nb.m4s\n#EXT-X-ENDLIST';
    const calls: string[] = [];
    const fetchResource = vi.fn(async (url: string, options: {signal: AbortSignal; credentials: 'omit'}) => {
      calls.push(url); expect(options.credentials).toBe('omit');
      return response(url.endsWith('init.mp4') ? audioInit : textBytes(url.endsWith('a.m4s') ? 'A' : 'B'));
    });
    await expect(readXHlsAudio(base, manifest, new AbortController().signal, fetchResource)).resolves.toMatchObject({bytes: joinBytes(audioInit, textBytes('AB')), durationMs: 2000});
    expect(calls).toEqual(expect.arrayContaining(['https://video.twimg.com/ext/audio/init.mp4', 'https://video.twimg.com/ext/audio/a.m4s', 'https://video.twimg.com/ext/audio/b.m4s']));
  });

  it('并发读取时共享 64 MiB 音频预算，避免三个响应各自通过单段上限', async () => {
    const manifest = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\na.m4s\n#EXTINF:1,\nb.m4s\n#EXTINF:1,\nc.m4s\n#EXT-X-ENDLIST';
    const chunk = new Uint8Array(22 * 1024 * 1024);
    const fetchResource = vi.fn(async (url: string) => response(url.endsWith('init.mp4') ? audioInit : chunk));

    await expect(readXHlsAudio(base, manifest, new AbortController().signal, fetchResource)).rejects.toThrow('读取上限');
    expect(fetchResource).toHaveBeenCalledTimes(4);
  });

  it('跟随最多三层 manifest，拒绝循环、失败和外站 redirect 资源', async () => {
    const child = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\na.m4s\n#EXTINF:1,\nb.m4s\n#EXT-X-ENDLIST';
    const fetchResource = vi.fn(async (url: string) => response(url.endsWith('child.m3u8') ? textBytes(child) : url.endsWith('init.mp4') ? audioInit : textBytes('x')));
    await expect(readXHlsAudio(base, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8', new AbortController().signal, fetchResource)).resolves.toMatchObject({durationMs: 2000});
    const failing = vi.fn(async () => { throw new Error('network'); });
    await expect(readXHlsAudio(base, child, new AbortController().signal, failing)).rejects.toThrow('network');
    const external = '#EXTM3U\n#EXT-X-MAP:URI="https://example.com/init.mp4"\n#EXTINF:1,\na.m4s\n#EXT-X-ENDLIST';
    await expect(readXHlsAudio(base, external, new AbortController().signal, fetchResource)).rejects.toThrow('视频音轨地址');
    const cycle = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmaster.m3u8';
    await expect(readXHlsAudio(base, cycle, new AbortController().signal, fetchResource)).resolves.toBeNull();
    const segmentFailure = vi.fn(async (url: string) => {
      if (url.endsWith('a.m4s')) throw new Error('segment failed');
      return response(url.endsWith('init.mp4') ? audioInit : textBytes('I'));
    });
    await expect(readXHlsAudio(base, child, new AbortController().signal, segmentFailure)).rejects.toThrow('segment failed');
  });

  it('外部 abort 会取消读取并返回 null', async () => {
    const signal = new AbortController();
    const fetchResource = vi.fn(async (_url: string, options: {signal: AbortSignal}) => {
      await new Promise<void>(resolve => setTimeout(resolve, 10));
      if (options.signal.aborted) throw new Error('aborted');
      return response(textBytes('x'));
    });
    const pending = readXHlsAudio(base, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8', signal.signal, fetchResource);
    signal.abort();
    await expect(pending).resolves.toBeNull();
    await flush();
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(readXHlsAudio(base, '#EXTM3U', alreadyAborted.signal, fetchResource)).resolves.toBeNull();
  });

  it('清单请求完成后才收到 abort 时返回 null', async () => {
    const controller = new AbortController();
    const child = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\na.m4s\n#EXTINF:1,\nb.m4s\n#EXT-X-ENDLIST';
    const releaseLock = vi.fn(() => {
      queueMicrotask(() => queueMicrotask(() => controller.abort()));
    });
    const doneResponse = (onRelease: () => void = () => undefined) => {
      const result = new Response(null, {status: 200});
      Object.defineProperty(result, 'body', {
        value: {
          getReader: () => ({
            read: async () => ({done: true, value: undefined}),
            cancel: async () => undefined,
            releaseLock: onRelease,
          }),
        },
      });
      return result;
    };
    const abortingResponse = doneResponse(releaseLock);
    const completedResponse = doneResponse();
    /* The delayed abort lets all workers finish their current read before the
       Promise.all continuation observes the cancelled scope. */
    const fetchResource = vi.fn(async (url: string) => {
      if (url.endsWith('child.m3u8')) {
        return response(textBytes(child));
      }
      if (url.endsWith('init.mp4')) return response(audioInit);
      if (url.endsWith('b.m4s')) return abortingResponse;
      return completedResponse;
    });
    const pending = readXHlsAudio(base, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8', controller.signal, fetchResource);
    await expect(pending).resolves.toBeNull();
    expect(releaseLock).toHaveBeenCalled();
  });

  it('retries transient 5xx, 429, network and per-segment timeouts while refunding partial bytes and failing immediately on 4xx', async () => {
    vi.useFakeTimers();
    const manifest = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nflaky.m4s\n#EXTINF:1,\nsteady.m4s\n#EXT-X-ENDLIST';
    let flakyAttempts = 0;
    const flakyFetcher = vi.fn((url: string, options: {signal: AbortSignal}) => {
      if (url.endsWith('init.mp4')) return Promise.resolve(response(audioInit));
      if (url.endsWith('steady.m4s')) return Promise.resolve(response(textBytes('S')));
      flakyAttempts += 1;
      if (flakyAttempts === 1) return Promise.resolve(new Response('busy', {status: 503}));
      if (flakyAttempts === 2) {
        return new Promise<Response>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new DOMException('segment timeout', 'AbortError')), {once: true});
        });
      }
      return Promise.resolve(response(textBytes('F')));
    });
    try {
      const reading = readXHlsAudio(base, manifest, new AbortController().signal, flakyFetcher);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(reading).resolves.toMatchObject({bytes: joinBytes(audioInit, textBytes('FS')), durationMs: 2000});
      expect(flakyAttempts).toBe(3);

      // 403 on a segment must fail immediately without wasting retries.
      const forbiddenFetcher = vi.fn(async (url: string) => url.endsWith('init.mp4')
        ? response(audioInit)
        : new Response('denied', {status: 403}));
      await expect(readXHlsAudio(base, manifest, new AbortController().signal, forbiddenFetcher)).rejects.toThrow('无效');
      expect(forbiddenFetcher.mock.calls.filter(([url]) => url.endsWith('flaky.m4s'))).toHaveLength(1);

      // Aborting during retry backoff stops immediately without issuing another fetch or leaving dangling timers.
      const singleSegmentManifest = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nflaky.m4s\n#EXT-X-ENDLIST';
      const abortController = new AbortController();
      let retryCalls = 0;
      const retryingFetcher = vi.fn(async (url: string) => {
        if (url.endsWith('init.mp4')) return response(audioInit);
        retryCalls += 1;
        return new Response('rate limited', {status: 429});
      });
      const aborted = readXHlsAudio(base, singleSegmentManifest, abortController.signal, retryingFetcher);
      for (let i = 0; i < 30 && retryCalls === 0; i += 1) await Promise.resolve();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      expect(retryCalls).toBe(1);
      abortController.abort();
      await expect(aborted).resolves.toBeNull();
      expect(retryCalls).toBe(1);
      expect(vi.getTimerCount()).toBe(0);

      // Aborting synchronously during attempt cleanup before backoff skips timer scheduling and stops cleanly.
      const syncAbortController = new AbortController();
      let syncCalls = 0;
      const syncAbortFetcher = vi.fn(async (url: string, options: {signal: AbortSignal}) => {
        if (url.endsWith('init.mp4')) return response(audioInit);
        syncCalls += 1;
        options.signal.addEventListener('abort', () => syncAbortController.abort(), {once: true});
        return new Response('rate limited', {status: 429});
      });
      await expect(readXHlsAudio(base, singleSegmentManifest, syncAbortController.signal, syncAbortFetcher)).resolves.toBeNull();
      expect(syncCalls).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
