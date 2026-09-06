import { describe, expect, it } from 'vitest';
import {
  cleanSubtitleText,
  decodeHtmlEntities,
  createXSubtitleResourcePayload,
  isXSubtitleResourceUrl,
  parseWebVttSubtitleResponse,
  parseXSubtitleResource,
  parseTimestamp,
  readAttribute,
  resolveResourceUrl,
  languageCodeFromUrl,
  selectXSubtitleLanguageResources,
} from '@/src/features/video-subtitle/content/xVideoSubtitleData';

describe('X 视频字幕资源', () => {
  it('清理逐词元数据及其实体形式，保留正文和 cue 原始时间', () => {
    const tagged = '<X-word-ms ms=419,60,340 index=1 character_ranges=0-7,8-10,11-13>Teleport to SF</X-word-ms>';
    const encoded = tagged.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    for (const text of [tagged, encoded]) {
      expect(cleanSubtitleText(text)).toBe('Teleport to SF');
      expect(parseWebVttSubtitleResponse(`WEBVTT\n\n00:00:00.419 --> 00:00:01.159\n${text}`))
        .toEqual([{startMs: 419, durationMs: 740, text: 'Teleport to SF'}]);
    }
    expect(cleanSubtitleText('&lt;x-word-ms ms=10&gt;A &amp; B&lt;/x-word-ms&gt;')).toBe('A & B');
    expect(cleanSubtitleText('&lt;vector&gt; &amp; 1 &lt; 2')).toBe('<vector> & 1 < 2');
    expect(cleanSubtitleText('<v Speaker><b>Hello</b><br><00:00:01.000>world</v>')).toBe('Hello\nworld');
  });

  it('解析 WebVTT sidecar，并解码 HTML 文本', () => {
    const cues = parseWebVttSubtitleResponse(`WEBVTT\n\n1\n00:00:01.200 --> 00:00:03.400\nHello &amp; welcome<br>to X\n`);
    expect(cues).toEqual([{
      startMs: 1200,
      durationMs: 2200,
      text: 'Hello & welcome\nto X',
    }]);
  });

  it('按 RFC 8216 时间戳映射转换 cue，且不重复叠加分片时长', () => {
    const mapped = parseWebVttSubtitleResponse('WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:90000\n\n00:00:01.000 --> 00:00:02.000\nhello', 1_000);
    expect(mapped[0]).toMatchObject({startMs: 2_000, durationMs: 1_000});
    const media = parseXSubtitleResource('#EXTM3U\n#EXTINF:2.5,\npart-0.vtt\n#EXTINF:3.5,\npart-1.vtt', 'https://video.twimg.com/ext/pl/captions/en.m3u8', 10_000);
    expect(media.resources.map(resource => resource.offsetMs)).toEqual([0, 2_500]);
  });

  it('解析 HLS 字幕语言 playlist 和分片偏移', () => {
    const master = parseXSubtitleResource(`#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",URI="captions/en.m3u8"`, 'https://video.twimg.com/ext/pl/master.m3u8');
    expect(master.resources).toEqual([{
      url: 'https://video.twimg.com/ext/pl/captions/en.m3u8',
      offsetMs: 0,
      languageCode: 'en',
    }]);

    const media = parseXSubtitleResource(`#EXTM3U\n#EXTINF:2.5,\npart-0.vtt\n#EXTINF:3.5,\npart-1.vtt`, 'https://video.twimg.com/ext/pl/captions/en.m3u8');
    expect(media.resources).toEqual([
      { url: 'https://video.twimg.com/ext/pl/captions/part-0.vtt', offsetMs: 0, languageCode: undefined },
      { url: 'https://video.twimg.com/ext/pl/captions/part-1.vtt', offsetMs: 2500, languageCode: undefined },
    ]);
  });

  it('只把 video.twimg.com 的字幕或 HLS 地址交给资源桥', () => {
    expect(isXSubtitleResourceUrl('https://video.twimg.com/ext/pl/captions/en.m3u8')).toBe(true);
    expect(isXSubtitleResourceUrl('https://video.twimg.com/ext/vid/playlist.m3u8')).toBe(true);
    expect(isXSubtitleResourceUrl('https://video.twimg.com/ext/vid/720x720/video.mp4')).toBe(false);
    expect(isXSubtitleResourceUrl('https://example.com/captions/en.vtt')).toBe(false);
    expect(isXSubtitleResourceUrl('https://[bad')).toBe(false);
    expect(isXSubtitleResourceUrl(1 as unknown as string)).toBe(false);
  });

  it('按首选语言只选择一条轨道，auto 和缺失语言都不混合轨道', () => {
    const resources = [
      {url: 'https://video.twimg.com/en.m3u8', offsetMs: 0, languageCode: 'en'},
      {url: 'https://video.twimg.com/en-GB.m3u8', offsetMs: 0, languageCode: 'en-GB'},
      {url: 'https://video.twimg.com/fr.m3u8', offsetMs: 0, languageCode: 'fr'},
    ];
    expect(selectXSubtitleLanguageResources(resources, 'fr')).toEqual([resources[2]]);
    expect(selectXSubtitleLanguageResources(resources, 'en-US')).toEqual([resources[0]]);
    expect(selectXSubtitleLanguageResources(resources, 'auto')).toEqual([resources[0]]);
    expect(selectXSubtitleLanguageResources(resources, 'de')).toEqual([resources[0]]);
    expect(selectXSubtitleLanguageResources([])).toEqual([]);
    expect(selectXSubtitleLanguageResources(resources)).toEqual([resources[0]]);
  });

  it('不把 NOTE、STYLE、REGION 块或坏时间戳当作 cue，并限制输入边界', () => {
    const source = `WEBVTT\n\nNOTE\n00:00:00.000 --> 00:00:01.000\nnot a cue\n\nSTYLE\n::cue { color: red }\n\nREGION\nid:foo\n\n1\n00:00:01.000 --> 00:00:02.000\nreal cue\n\n2\n00:00:03.000 --> 00:00:02.000\nbad\n`;
    expect(parseWebVttSubtitleResponse(source)).toEqual([{startMs: 1000, durationMs: 1000, text: 'real cue'}]);
    expect(parseWebVttSubtitleResponse('x'.repeat(1_000_001))).toEqual([]);
    expect(parseWebVttSubtitleResponse('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n2\n00:00:02.000 --> 00:00:03.000\nb')).toHaveLength(1);
    expect(parseWebVttSubtitleResponse('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n00:00:02.000 --> 00:00:03.000\nb')).toHaveLength(1);
    expect(readAttribute('TYPE=SUBTITLES,URI="x"', 'LANGUAGE')).toBeUndefined();
    expect(readAttribute('TYPE=SUBTITLES,LANGUAGE=en,URI="x"', 'LANGUAGE')).toBe('en');
    expect(readAttribute('TYPE=SUBTITLES', 'URI')).toBeUndefined();
    expect(parseXSubtitleResource('#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES\n#EXT-X-MEDIA:TYPE=SUBTITLES,URI="captions/file.vtt"', 'https://video.twimg.com/a.m3u8')).toMatchObject({resources: [{languageCode: undefined}]});
    expect(parseXSubtitleResource('#EXTM3U\n#EXTINF:.,\npart.vtt\nnotes.txt', 'https://video.twimg.com/a.m3u8')).toMatchObject({resources: [{offsetMs: 0}]});
    expect(parseXSubtitleResource('#EXTM3U\npart.vtt', 'not a url')).toEqual({cues: [], resources: []});
  });

  it('限制 X resource payload 的 URL、页面地址和正文大小', () => {
    expect(createXSubtitleResourcePayload('https://video.twimg.com/master.m3u8', '#EXTM3U', 'https://x.com/status/1')).toMatchObject({type: 'fluent-read-x-video-subtitle-resource'});
    expect(createXSubtitleResourcePayload('https://video.twimg.com/captions/en.vtt', 'WEBVTT\n', 'https://x.com/status/1')).toMatchObject({type: 'fluent-read-x-video-subtitle-resource'});
    expect(createXSubtitleResourcePayload('https://video.twimg.com/captions/en.vtt', 'plain text', 'https://x.com/status/1')).toBeNull();
    expect(createXSubtitleResourcePayload('https://video.twimg.com/captions/en.vtt', 'WEBVTT', 'x'.repeat(8_193))).toBeNull();
    expect(createXSubtitleResourcePayload('https://video.twimg.com/captions/en.vtt', 'x'.repeat(1_000_001), 'https://x.com/status/1')).toBeNull();
    expect(createXSubtitleResourcePayload('https://[bad', 'WEBVTT', 'https://x.com/status/1')).toBeNull();
  });

  it('覆盖无效时间、无效属性、非法资源和无正文输入', () => {
    expect(parseWebVttSubtitleResponse('WEBVTT\n\n1\n00:xx --> 00:01.000\nx\n\n2\n00:00:01,000 --> 00:00:02,000\n')).toEqual([]);
    expect(parseXSubtitleResource('', 'https://video.twimg.com/a.m3u8')).toEqual({cues: [], resources: []});
    expect(parseXSubtitleResource('#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,URI="not a url"\n#EXTINF:x,\nnot-a-url', 'https://video.twimg.com/a.m3u8')).toEqual({cues: [], resources: []});
    expect(parseXSubtitleResource('#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,URI="captions/en.vtt"\n#EXTINF:1,\n#EXT-X-DISCONTINUITY\npart.vtt', 'http://video.twimg.com/a.m3u8')).toEqual({cues: [], resources: []});
    expect(parseXSubtitleResource('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\ncue', 'https://video.twimg.com/a.vtt', 500)).toMatchObject({cues: [{startMs: 1000}]});
    expect(parseXSubtitleResource(1 as unknown as string, 'https://video.twimg.com/a.vtt')).toEqual({cues: [], resources: []});
    expect(parseTimestamp('bad')).toBeNull();
    expect(parseTimestamp('00:01')).toBe(1000);
    expect(resolveResourceUrl('[', 'https://video.twimg.com/a.m3u8')).toBe('https://video.twimg.com/[');
    expect(resolveResourceUrl('x', 'not a url')).toBeNull();
    expect(languageCodeFromUrl('not a url')).toBeUndefined();
    expect(languageCodeFromUrl('https://video.twimg.com/file.vtt')).toBeUndefined();
    expect(languageCodeFromUrl('https://video.twimg.com/en.vtt')).toBe('en');
    expect(cleanSubtitleText('  a   b<br> c ')).toBe('a b\nc');
    const originalDocument = (globalThis as {document?: unknown}).document;
    (globalThis as {document?: unknown}).document = {
      createElement: () => ({innerHTML: '', value: '&decoded;'}),
    };
    expect(decodeHtmlEntities('&amp;')).toBe('&decoded;');
    if (originalDocument === undefined) Reflect.deleteProperty(globalThis, 'document');
    else (globalThis as {document?: unknown}).document = originalDocument;
    expect(decodeHtmlEntities('&amp; &lt; &gt; &quot; &#39;', false)).toBe('& < > " \'');
  });
});
