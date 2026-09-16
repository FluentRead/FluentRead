import {describe, expect, it} from 'vitest';
import {XSubtitleLoader} from '@/src/features/video-subtitle/content/xSubtitleLoader';
import type {XSubtitleResource} from '@/src/features/video-subtitle/content/xVideoSubtitleData';

const cueText = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhello\n';
const resource = (id: string, languageCode?: string, offsetMs = 0): XSubtitleResource => ({
  url: `https://video.twimg.com/captions/${id}.vtt`, offsetMs, languageCode,
});
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('XSubtitleLoader', () => {
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
