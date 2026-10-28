import {afterEach, describe, expect, it, vi} from 'vitest';
import {XSubtitleLoader} from '@/src/features/video-subtitle/content/xSubtitleLoader';
import type {XSubtitleResource} from '@/src/features/video-subtitle/content/xVideoSubtitleData';

const cueText = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhello\n';
const resource = (id: string, languageCode?: string, offsetMs = 0): XSubtitleResource => ({
  url: `https://video.twimg.com/captions/${id}.vtt`, offsetMs, languageCode,
});
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
afterEach(() => vi.useRealTimers());

describe('XSubtitleLoader', () => {
  it('stalled requests time out, release all three slots and consume late responses without publishing old cues', async () => {
    vi.useFakeTimers();
    const pending: Array<{resolve(response: Response): void; signal: AbortSignal}> = [];
    const cues = vi.fn();
    const loader = new XSubtitleLoader({
      fetch: (_url, {signal}) => new Promise<Response>(resolve => pending.push({resolve, signal})),
      language: () => 'en', onCues: cues,
    });
    for (let index = 0; index < 3; index++) loader.load(resource(`stalled-${index}`));
    loader.load(resource('ready'), cueText);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(pending).toHaveLength(3);
    expect(pending.every(request => request.signal.aborted)).toBe(true);
    expect(cues).toHaveBeenCalledOnce();
    expect(cues.mock.calls[0][0]).toBe(resource('ready').url);
    const cancel = vi.fn();
    for (const request of pending) request.resolve(new Response(new ReadableStream({cancel})));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(3);
    expect(cues).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    loader.reset();
  });

  it('reset releases stalled old slots before loading the next media and cancels rejected response bodies', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const cues = vi.fn();
    const loader = new XSubtitleLoader({
      fetch: async url => url.includes('rejected')
        ? new Response(new ReadableStream({cancel}), {status: 403}) : new Promise<Response>(() => undefined),
      language: () => 'en', onCues: cues,
    });
    for (let index = 0; index < 3; index++) loader.load(resource(`stalled-${index}`));
    loader.reset();
    loader.load(resource('rejected'));
    loader.load(resource('next'), cueText);
    await vi.advanceTimersByTimeAsync(0);
    expect(cues).toHaveBeenCalledOnce();
    expect(cues.mock.calls[0][0]).toBe(resource('next').url);
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    loader.reset();
  });
  it('加载 inline cue，并从 master 只递归首选语言轨道', async () => {
    const calls: string[] = [];
    const cues: string[] = [];
    const loader = new XSubtitleLoader({
      fetch: async (url) => { calls.push(url); return new Response(cueText); },
      language: () => 'fr',
      onCues: url => cues.push(url),
    });
    loader.load(resource('inline'), cueText);
    loader.load({url: 'https://video.twimg.com/master.m3u8', offsetMs: 0}, '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,LANGUAGE="en",URI="captions/en.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,LANGUAGE="fr",URI="captions/fr.m3u8"');
    await tick();
    expect(cues).toContain(resource('inline').url);
    expect(calls).toEqual(['https://video.twimg.com/captions/fr.m3u8']);
  });

  it('桥接捕获无 EXTM3U 头的字幕 MEDIA 标签时仍可加载字幕', async () => {
    const cues = vi.fn();
    const fetch = vi.fn(async () => new Response(cueText));
    const loader = new XSubtitleLoader({fetch, language: () => 'en', onCues: cues});
    loader.load({url: 'https://video.twimg.com/master.m3u8', offsetMs: 0},
      '#EXT-X-MEDIA:TYPE=SUBTITLES,LANGUAGE="en",URI="captions/en.vtt"');
    await tick();
    expect(fetch).toHaveBeenCalledOnce();
    expect(cues).toHaveBeenCalledOnce();
    expect(cues.mock.calls[0][0]).toBe('https://video.twimg.com/captions/en.vtt');
  });

  it('限制并发为 3，任务完成后继续泵队列', async () => {
    const pending = new Map<string, (response: Response) => void>();
    const loader = new XSubtitleLoader({
      fetch: async (url) => new Promise<Response>(resolve => pending.set(url, resolve)),
      language: () => 'auto', onCues: () => undefined,
    });
    for (let i = 0; i < 5; i += 1) loader.load(resource(`concurrent-${i}`));
    await tick();
    expect(pending.size).toBe(3);
    [...pending.values()].slice(0, 1).forEach(resolve => resolve(new Response(cueText)));
    await tick();
    expect(pending.size).toBe(4);
    loader.reset();
    await tick();
  });

  it('限制已访问资源容量为 96，并忽略非法、重复和大响应', async () => {
    const calls: string[] = [];
    const loader = new XSubtitleLoader({
      fetch: async (url) => { calls.push(url); return new Response(cueText); },
      language: () => 'en', onCues: () => undefined,
    });
    loader.load(resource('bad'), cueText);
    loader.load({url: 'https://example.com/captions/no.vtt', offsetMs: 0}, cueText);
    loader.load(resource('bad'), cueText);
    for (let i = 0; i < 100; i += 1) loader.load(resource(`capacity-${i}`), '');
    await tick();
    expect(calls).toHaveLength(0);
    const responseLoader = new XSubtitleLoader({
      fetch: async (url) => { calls.push(url); return new Response('x', {status: 200, headers: {'content-length': '1000001'}}); },
      language: () => 'en', onCues: () => undefined,
    });
    responseLoader.load(resource('large'));
    await tick();
    expect(calls.at(-1)).toContain('large');
  });

  it('reset 会取消当前请求并丢弃迟到结果，之后允许重新加载相同 URL', async () => {
    let resolve!: (response: Response) => void;
    const cues: string[] = [];
    const loader = new XSubtitleLoader({
      fetch: async () => new Promise<Response>(r => { resolve = r; }),
      language: () => 'en', onCues: url => cues.push(url),
    });
    loader.load(resource('late'));
    await tick();
    loader.reset();
    resolve(new Response(cueText));
    await tick();
    expect(cues).toHaveLength(0);
    loader.load(resource('late'), cueText);
    await tick();
    expect(cues).toHaveLength(1);
  });
  it('读取失败后可消费桥接稍后回放的同一 URL 字幕，成功后继续去重', async () => {
    const cues = vi.fn();
    const fetch = vi.fn(async () => new Response('', {status: 503}));
    const loader = new XSubtitleLoader({fetch, language: () => 'en', onCues: cues});
    loader.load(resource('retry'));
    await tick();
    loader.load(resource('retry'), cueText);
    await tick();
    expect(fetch).toHaveBeenCalledOnce();
    expect(cues).toHaveBeenCalledOnce();
    expect(cues.mock.calls[0][0]).toBe(resource('retry').url);
    loader.load(resource('retry'), cueText);
    await tick();
    expect(cues).toHaveBeenCalledOnce();
  });

  it('网络请求期间收到同 URL 桥接正文时，失败后使用已捕获内容', async () => {
    let finish!: (response: Response) => void;
    const cues = vi.fn();
    const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    const loader = new XSubtitleLoader({fetch, language: () => 'en', onCues: cues});
    loader.load(resource('pending'));
    loader.load(resource('pending'), cueText);
    finish(new Response('', {status: 503}));
    await tick();
    expect(fetch).toHaveBeenCalledOnce();
    expect(cues).toHaveBeenCalledOnce();
    expect(cues.mock.calls[0][0]).toBe(resource('pending').url);
  });

  it.each(['', 'unrecognized body'])('读取成功但正文不可解析时，使用等待中捕获的有效正文：%j', async responseText => {
    let finish!: (response: Response) => void;
    const cues = vi.fn();
    const loader = new XSubtitleLoader({
      fetch: () => new Promise<Response>(resolve => { finish = resolve; }),
      language: () => 'en', onCues: cues,
    });
    loader.load(resource('empty-response'));
    loader.load(resource('empty-response'), cueText);
    loader.load(resource('empty-response'), '  ');
    finish(new Response(responseText));
    await tick();
    expect(cues).toHaveBeenCalledOnce();
    expect(cues.mock.calls[0][1]).toEqual(expect.arrayContaining([expect.objectContaining({text: 'hello'})]));
  });

  it('不可解析的响应不会永久阻止稍后回放同一 URL', async () => {
    const cues = vi.fn();
    const loader = new XSubtitleLoader({fetch: async () => new Response(''), language: () => 'en', onCues: cues});
    loader.load(resource('empty-before-replay'));
    await tick();
    loader.load(resource('empty-before-replay'), cueText);
    await tick();
    expect(cues).toHaveBeenCalledOnce();
  });

  it('旧代取消不能解除新代同一 URL 的去重资格', async () => {
    const cues = vi.fn();
    const loader = new XSubtitleLoader({
      fetch: () => new Promise<Response>(() => undefined), language: () => 'en', onCues: cues,
    });
    loader.load(resource('same'));
    loader.reset();
    loader.load(resource('same'), cueText);
    await tick();
    loader.load(resource('same'), cueText);
    await tick();
    expect(cues).toHaveBeenCalledOnce();
  });
  it('无 content-length 时仍按 1MB 实际流大小中止', async () => {
    const cues: string[] = [];
    const oversized = `${cueText}${'x'.repeat(1_000_001)}`;
    const loader = new XSubtitleLoader({
      fetch: async () => new Response(new ReadableStream({start(controller) { controller.enqueue(new TextEncoder().encode(oversized)); controller.close(); }})),
      language: () => 'en', onCues: url => cues.push(url),
    });
    loader.load(resource('stream-large'));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    loader.load(resource('inline-large'), oversized);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    // 有效 WEBVTT 头也不能让超限正文进入解析；同一加载器仍可处理正常字幕。
    expect(cues).toEqual([]);
    loader.load(resource('inline-normal'), cueText);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(cues).toEqual([resource('inline-normal').url]);
  });
});
