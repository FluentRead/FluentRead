import { describe, expect, it } from 'vitest';
import {
  buildYoutubeTimedTextUrl,
  chooseYoutubeCaptionTrack,
  chooseYoutubeCaptionTrackForLocation,
  cuesToSrt,
  extractYoutubeCaptionTracks,
  finalizeVideoSubtitleCues,
  getYoutubeVideoId,
  parseYoutubeTimedTextResponse,
  sanitizeSubtitleFilename,
} from '@/src/features/video-subtitle/content/youtubeSubtitleData';

describe('YouTube 字幕轨道数据', () => {
  it('从初始化脚本提取字幕轨道并优先选择指定语言的人工作品', () => {
    const playerResponse = {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { baseUrl: 'https://www.youtube.com/api/timedtext?lang=en', languageCode: 'en', kind: 'asr' },
            { baseUrl: 'https://www.youtube.com/api/timedtext?lang=zh-CN', languageCode: 'zh-CN', name: { simpleText: '中文' } },
          ],
        },
      },
    };
    const script = { textContent: `var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};` };
    const root = { querySelectorAll: () => [script] } as unknown as ParentNode;

    const tracks = extractYoutubeCaptionTracks(root);

    expect(tracks).toHaveLength(2);
    expect(chooseYoutubeCaptionTrack(tracks, 'zh-CN')).toMatchObject({ languageCode: 'zh-CN', name: '中文' });
    expect(chooseYoutubeCaptionTrack(tracks, 'auto')).toMatchObject({ languageCode: 'zh-CN' });
  });

  it('SPA 导航后跳过旧视频初始化脚本并找到当前视频轨道', () => {
    const playerResponse = (videoId: string, languageCode: string) => ({
      videoDetails: {videoId},
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{
            baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${languageCode}`,
            languageCode,
          }],
        },
      },
    });
    const root = {
      querySelectorAll: () => [
        {textContent: `var ytInitialPlayerResponse = ${JSON.stringify(playerResponse('video-a', 'en'))};`},
        {textContent: `var ytInitialPlayerResponse = ${JSON.stringify(playerResponse('video-b', 'ja'))};`},
      ],
    } as unknown as ParentNode;

    expect(extractYoutubeCaptionTracks(root, 'video-b')).toEqual([
      expect.objectContaining({languageCode: 'ja', baseUrl: expect.stringContaining('v=video-b')}),
    ]);
    expect(chooseYoutubeCaptionTrackForLocation(root, {
      hostname: 'www.youtube.com',
      pathname: '/watch',
      search: '?v=video-b',
    })).toMatchObject({
      languageCode: 'ja',
    });
    expect(extractYoutubeCaptionTracks(root, 'video-c')).toEqual([]);
  });

  it('缺少 videoDetails 时只接受 timedtext URL 明确绑定的当前视频', () => {
    const root = {
      querySelectorAll: () => [{
        textContent: `var ytInitialPlayerResponse = ${JSON.stringify({
          captions: {playerCaptionsTracklistRenderer: {captionTracks: [
            {baseUrl: 'https://www.youtube.com/api/timedtext?v=video-a&lang=en', languageCode: 'en'},
            {baseUrl: 'https://www.youtube.com/api/timedtext?v=video-b&lang=zh', languageCode: 'zh'},
          ]}},
        })};`,
      }],
    } as unknown as ParentNode;

    expect(extractYoutubeCaptionTracks(root, 'video-b')).toEqual([
      expect.objectContaining({languageCode: 'zh', baseUrl: expect.stringContaining('v=video-b')}),
    ]);
  });

  it('缺失或损坏 timedtext video id 时 fail closed，非播放地址不选择 fallback', () => {
    const root = {
      querySelectorAll: () => [{
        textContent: `var ytInitialPlayerResponse = ${JSON.stringify({
          captions: {playerCaptionsTracklistRenderer: {captionTracks: [
            {baseUrl: 'https://www.youtube.com/api/timedtext?lang=en', languageCode: 'en'},
            {baseUrl: 'http://[', languageCode: 'ja'},
          ]}},
        })};`,
      }],
    } as unknown as ParentNode;

    expect(extractYoutubeCaptionTracks(root, 'video-b')).toEqual([]);
    expect(chooseYoutubeCaptionTrackForLocation(root, {
      hostname: 'www.youtube.com',
      pathname: '/',
      search: '',
    })).toBeNull();
  });

  it('解析 JSON3 和 XML timedtext，并补齐缺失的结束时间', () => {
    const json3 = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 900, segs: [{ utf8: 'Hello &amp; welcome' }] },
        { tStartMs: 1200, segs: [{ utf8: 'Next<br>line' }] },
      ],
    });
    const jsonCues = finalizeVideoSubtitleCues(parseYoutubeTimedTextResponse(json3));
    expect(jsonCues).toEqual([
      { startMs: 0, durationMs: 900, text: 'Hello & welcome' },
      { startMs: 1200, durationMs: 2000, text: 'Next\nline' },
    ]);

    const xmlCues = parseYoutubeTimedTextResponse('<transcript><text start="1.5" dur="2">&lt;hello&gt;</text></transcript>');
    expect(xmlCues).toEqual([{ startMs: 1500, durationMs: 2000, text: '<hello>' }]);
  });

  it('合并同一时间点逐步增长的 cue，只保留完整版本', () => {
    const cues = finalizeVideoSubtitleCues([
      { startMs: 0, durationMs: 600, text: 'I' },
      { startMs: 0, durationMs: 1200, text: 'I think' },
      { startMs: 0, durationMs: 2200, text: 'I think this works.' },
    ]);

    expect(cues).toEqual([{ startMs: 0, durationMs: 2200, text: 'I think this works.' }]);
  });

  it('把连续逐词 cue 合并成一段短句，避免播放器按单词闪动', () => {
    const cues = finalizeVideoSubtitleCues([
      { startMs: 0, durationMs: 650, text: 'This' },
      { startMs: 600, durationMs: 650, text: 'is' },
      { startMs: 1200, durationMs: 650, text: 'a' },
      { startMs: 1800, durationMs: 900, text: 'test.' },
      { startMs: 4000, durationMs: 1200, text: 'Next sentence.' },
    ]);

    expect(cues).toEqual([
      { startMs: 0, durationMs: 2700, text: 'This is a test.' },
      { startMs: 4000, durationMs: 1200, text: 'Next sentence.' },
    ]);
  });

  it('生成可被播放器使用的 SRT 时间轴和 timedtext URL', () => {
    const srt = cuesToSrt([{ startMs: 0, durationMs: 1250, text: '第一句' }]);
    expect(srt).toContain('00:00:00,000 --> 00:00:01,250');
    expect(srt).toContain('第一句');

    const url = buildYoutubeTimedTextUrl({
      baseUrl: 'https://www.youtube.com/api/timedtext?v=video-1&lang=en',
      languageCode: 'en',
    });
    expect(url).toContain('fmt=json3');
    expect(url).toContain('xorb=2');
    expect(url).toContain('cplayer=UNIPLAYER');
  });

  it('对异常 YouTube 初始化脚本和轨道选择输入安全降级', () => {
    const root = {
      querySelectorAll: () => [
        { textContent: 'var unrelated = true;' },
        { textContent: 'playerCaptionsTracklistRenderer ytInitialPlayerResponse = {"captions":' },
        { textContent: 'playerCaptionsTracklistRenderer ytInitialPlayerResponse = {"captions":};' },
        { textContent: 'playerCaptionsTracklistRenderer ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"","languageCode":"en"},{"baseUrl":"https://example.com/t","languageCode":""},{"baseUrl":"https://example.com/ok","languageCode":"ja","kind":4,"name":{"simpleText":7}}]}}};' },
      ],
    } as unknown as ParentNode;

    expect(extractYoutubeCaptionTracks({querySelectorAll: () => []} as unknown as ParentNode)).toEqual([]);
    expect(extractYoutubeCaptionTracks(root)).toEqual([{
      baseUrl: 'https://example.com/ok',
      languageCode: 'ja',
      kind: undefined,
      name: undefined,
    }]);
    expect(chooseYoutubeCaptionTrack([], 'en')).toBeNull();
    expect(chooseYoutubeCaptionTrack([
      {baseUrl: 'https://example.com/asr', languageCode: 'en', kind: 'asr'},
      {baseUrl: 'https://example.com/human', languageCode: 'fr'},
    ], 'en')).toMatchObject({languageCode: 'fr'});
    expect(chooseYoutubeCaptionTrack([
      {baseUrl: 'https://example.com/asr', languageCode: 'en', kind: 'asr'},
    ])).toMatchObject({languageCode: 'en', kind: 'asr'});
  });

  it('初始化脚本扫描兼容空文本、无 marker、转义字符串和损坏轨道字段', () => {
    const escapedResponse = {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{
            baseUrl: 'https://example.com/timedtext?value=\\path',
            languageCode: 'en',
            name: {simpleText: 'A "quoted" track'},
          }],
        },
      },
    };
    const escapedRoot = {
      querySelectorAll: () => [
        {textContent: null},
        {textContent: `playerCaptionsTracklistRenderer ${JSON.stringify(escapedResponse)}`},
      ],
    } as unknown as ParentNode;
    expect(extractYoutubeCaptionTracks(escapedRoot)).toEqual([expect.objectContaining({
      languageCode: 'en',
      name: 'A "quoted" track',
    })]);

    const malformedRoot = {
      querySelectorAll: () => [
        {textContent: 'playerCaptionsTracklistRenderer ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":{}}}};'},
        {textContent: 'playerCaptionsTracklistRenderer ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":7,"languageCode":"en"},{"baseUrl":"https://example.com","languageCode":9}]}}};'},
      ],
    } as unknown as ParentNode;
    expect(extractYoutubeCaptionTracks(malformedRoot)).toEqual([]);
  });

  it('解析空响应、无效 JSON3、DOMParser XML 和正则 XML 回退的边界输入', () => {
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    try {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
          createElement: () => {
            const textarea = {value: ''};
            Object.defineProperty(textarea, 'innerHTML', {
              set: (value: string) => {
                textarea.value = value.replace(/&amp;/g, '&');
              },
            });
            return textarea;
          },
        },
      });
      expect(parseYoutubeTimedTextResponse(JSON.stringify({
        events: [{tStartMs: 0, dDurationMs: 100, segs: [{utf8: 'A &amp; B'}]}],
      }))).toEqual([{startMs: 0, durationMs: 100, text: 'A & B'}]);
    } finally {
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
      else Reflect.deleteProperty(globalThis, 'document');
    }

    expect(parseYoutubeTimedTextResponse('   ')).toEqual([]);
    expect(parseYoutubeTimedTextResponse('null')).toEqual([]);
    expect(parseYoutubeTimedTextResponse('{}')).toEqual([]);
    expect(parseYoutubeTimedTextResponse(JSON.stringify({
      events: [
        {tStartMs: 'bad', segs: [{utf8: 'ignored'}]},
        {tStartMs: 100, segs: 'bad'},
        {tStartMs: '200', dDurationMs: '450', segs: [{utf8: 7}, {utf8: ' Valid &quot;text&quot;'}]},
        {tStartMs: 300, segs: [{utf8: '<b></b>'}]},
      ],
    }))).toEqual([{startMs: 200, durationMs: 450, text: 'Valid "text"'}]);

    const previousParser = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
    class FixtureDOMParser {
      parseFromString() {
        return {
          querySelectorAll: () => [
            {
              getAttribute: () => null,
              textContent: null,
            },
            {
              getAttribute: (name: string) => name === 'start' ? 'not-finite' : '1',
              textContent: 'ignored',
            },
            {
              getAttribute: (name: string) => name === 'start' ? '2.5' : null,
              textContent: 'DOM &amp; XML',
            },
          ],
        };
      }
    }

    try {
      Object.defineProperty(globalThis, 'DOMParser', {
        configurable: true,
        value: FixtureDOMParser,
      });
      expect(parseYoutubeTimedTextResponse('<transcript><text start="2.5">DOM &amp; XML</text></transcript>')).toEqual([
        {startMs: 2500, durationMs: 0, text: 'DOM & XML'},
      ]);
    } finally {
      if (previousParser) Object.defineProperty(globalThis, 'DOMParser', previousParser);
      else Reflect.deleteProperty(globalThis, 'DOMParser');
    }

    expect(parseYoutubeTimedTextResponse('<text dur="1">missing start</text><text start="bad">bad</text><text start="3">&lt;regex&gt;</text>')).toEqual([
      {startMs: 3000, durationMs: 0, text: '<regex>'},
    ]);
  });

  it('整理异常时间轴、视频 id 和字幕文件名', () => {
    expect(finalizeVideoSubtitleCues([
      {startMs: Number.NaN, durationMs: 100, text: 'bad'},
      {startMs: 5000, durationMs: 0, text: '   '},
      {startMs: 0, durationMs: 0, text: 'First'},
      {startMs: 0, durationMs: 100, text: 'First'},
      {startMs: 12000, durationMs: -1, text: 'Last'},
    ])).toEqual([
      {startMs: 0, durationMs: 500, text: 'First'},
      {startMs: 12000, durationMs: 2000, text: 'Last'},
    ]);

    expect(finalizeVideoSubtitleCues([
      {startMs: 0, durationMs: 600, text: '你好'},
      {startMs: 550, durationMs: 600, text: '世界'},
      {startMs: 1100, durationMs: 600, text: '再见'},
      {startMs: 1650, durationMs: 600, text: '。'},
      {startMs: 7000, durationMs: 400, text: 'one'},
      {startMs: 9000, durationMs: 400, text: 'go'},
      {startMs: 9300, durationMs: 400, text: 'too'},
      {startMs: 9600, durationMs: 400, text: 'far'},
      {startMs: 9900, durationMs: 400, text: 'merge.'},
    ])).toEqual([
      {startMs: 0, durationMs: 2250, text: '你好世界再见。'},
      {startMs: 7000, durationMs: 400, text: 'one'},
      {startMs: 9000, durationMs: 1400, text: 'go too far merge.'},
    ]);

    expect(cuesToSrt([{startMs: -100, durationMs: 20, text: 'early'}])).toBe('');
    expect(getYoutubeVideoId({hostname: 'www.youtube.com', pathname: '/watch', search: '?v=abc123'} as Location)).toBe('abc123');
    expect(getYoutubeVideoId({hostname: 'www.youtube.com', pathname: '/shorts/short-id', search: ''} as Location)).toBe('short-id');
    expect(getYoutubeVideoId({hostname: 'www.youtube.com', pathname: '/', search: ''} as Location)).toBe('');
    expect(getYoutubeVideoId({
      hostname: 'www.youtube.com',
      get pathname() {
        throw new Error('bad location');
      },
      search: '',
    } as unknown as Location)).toBe('');
    expect(sanitizeSubtitleFilename('  bad:/name*with?spaces  ')).toBe('bad_name_with_spaces');
    expect(sanitizeSubtitleFilename('   ')).toBe('youtube-subtitles');
  });

  it('逐词流在回退、超间隔、非终止长 cue、词数与总时长边界停止合并', () => {
    expect(finalizeVideoSubtitleCues([
      {startMs: 0, durationMs: 500, text: 'A complete terminal sentence.'},
      {startMs: 700, durationMs: 500, text: 'tail'},
    ])).toHaveLength(2);
    expect(finalizeVideoSubtitleCues([
      {startMs: 0, durationMs: 500, text: 'word'},
      {startMs: 500, durationMs: 500, text: 'A complete terminal sentence.'},
    ])).toHaveLength(2);
    expect(finalizeVideoSubtitleCues([
      {startMs: 0, durationMs: 500, text: 'one'},
      {startMs: 450, durationMs: 500, text: 'two'},
      {startMs: 900, durationMs: 500, text: 'three'},
      {startMs: 4000, durationMs: 500, text: 'far'},
    ])).toHaveLength(2);
    expect(finalizeVideoSubtitleCues([
      {startMs: 0, durationMs: 500, text: 'one'},
      {startMs: 450, durationMs: 500, text: 'two'},
      {startMs: 900, durationMs: 500, text: 'three'},
      {startMs: 1350, durationMs: 500, text: 'this is a long continuation without punctuation'},
    ])).toHaveLength(2);

    const wordLimit = finalizeVideoSubtitleCues(Array.from({length: 8}, (_, index) => ({
      startMs: index * 450,
      durationMs: 500,
      text: `w${index} x${index}`,
    })));
    expect(wordLimit.length).toBeGreaterThan(1);

    const durationLimit = finalizeVideoSubtitleCues(Array.from({length: 8}, (_, index) => ({
      startMs: index * 1500,
      durationMs: 1000,
      text: `w${index}`,
    })));
    expect(durationLimit.length).toBeGreaterThan(1);
  });

  it('同起点增量 cue 在较短版本迟到时仍保留较长 winner', () => {
    expect(finalizeVideoSubtitleCues([
      {startMs: 0, durationMs: 2000, text: 'complete phrase'},
      {startMs: 0, durationMs: 500, text: 'complete'},
    ])).toEqual([{startMs: 0, durationMs: 2000, text: 'complete phrase'}]);
  });

  it.each([
    [['Hel', 'lo', '  ', 'w', 'orld'], 'Hello world'],
    [['中', '文', '无空格'], '中文无空格'],
    [['今天', '学习', 'Type', 'Script'], '今天学习TypeScript'],
    [['caf', 'é', ' ', 'déjà'], 'café déjà'],
    [['The ', 'U.S. ', 'Army'], 'The U.S. Army'],
  ])('JSON3 原始 segment 保留空白及无空白子词：%j', (segments, text) => {
    expect(parseYoutubeTimedTextResponse(JSON.stringify({events: [{
      tStartMs: 0, dDurationMs: 500, segs: segments.map((utf8) => ({utf8})),
    }]}))).toEqual([{startMs: 0, durationMs: 500, text}]);
  });

  it.each([
    [['café', 'déjà', 'très', 'bien.'], 'café déjà très bien.'],
    [['cafe\u0301', 'de\u0301ja\u0300', 'très', 'bien.'], 'cafe\u0301 de\u0301ja\u0300 très bien.'],
    [['中文', '没有', '空格', '。'], '中文没有空格。'],
    [['今天', '学习', 'TypeScript', '字幕。'], '今天学习TypeScript字幕。'],
  ])('事件级词流使用 Unicode 词边界并保留中英混合：%j', (words, text) => {
    const cues = words.map((word, index) => ({startMs: index * 450, durationMs: 500, text: word}));
    expect(finalizeVideoSubtitleCues(cues)).toEqual([{startMs: 0, durationMs: 1850, text}]);
  });

  it.each([
    [['Dr.', 'Smith', 'is', 'here.'], 'Dr. Smith is here.'],
    [['Mr.', 'Smith', 'is', 'here.'], 'Mr. Smith is here.'],
    [['Mrs.', 'Smith', 'is', 'here.'], 'Mrs. Smith is here.'],
    [['Ms.', 'Smith', 'is', 'here.'], 'Ms. Smith is here.'],
    [['Prof.', 'Élodie', 'is', 'here.'], 'Prof. Élodie is here.'],
    [['Value', '3.14', 'is', 'ready.'], 'Value 3.14 is ready.'],
    [['Use', 'v1.2', 'again', 'today.'], 'Use v1.2 again today.'],
    [['Visit', 'example.com', 'again', 'today.'], 'Visit example.com again today.'],
  ])('可靠称谓后继及完整词内的小数、版本、域名保持文本：%j', (words, text) => {
    const cues = words.map((word, index) => ({startMs: index * 450, durationMs: 500, text: word}));
    const finalized = finalizeVideoSubtitleCues(cues);
    expect(finalized).toEqual([{startMs: 0, durationMs: 1850, text}]);
    expect(finalizeVideoSubtitleCues(finalized)).toEqual(finalized);
    expect(cuesToSrt(cues)).toBe(cuesToSrt(finalized));
  });

  it.each([
    ['Value', '3.', '14', 'works.'],
    ['Use', 'v1.', '2', 'today.'],
    ['Visit', 'example.', 'com', 'today.'],
    ['The', 'U.S.', 'has', 'rules.'],
    ['The', 'U.S.', 'Army', 'arrived.'],
    ['Things', 'etc.', 'are', 'listed.'],
    ['Visit', 'St.', 'Louis', 'today.'],
  ])('无词内连续性证据时保守保留点号事件边界：%j / %j / %j / %j', (...words) => {
    const cues = words.map((text, index) => ({startMs: index * 450, durationMs: 500, text}));
    expect(finalizeVideoSubtitleCues(cues)).toEqual(cues);
    expect(cuesToSrt(cues)).toBe(cuesToSrt(finalizeVideoSubtitleCues(cues)));
  });

  it.each(['smith', '42'])('称谓没有可靠人名式后继时保留事件边界：%s', (next) => {
    const cues = ['Dr.', next, 'is', 'here.'].map((text, index) => ({
      startMs: index * 450, durationMs: 500, text,
    }));
    expect(finalizeVideoSubtitleCues(cues)).toEqual(cues);
  });

  it.each(['Hello.', '"Hello."', '(Hello.)', '“Hello!”', '「你好。」'])('保留真正句末及闭引号/括号边界：%s', (terminal) => {
    const words = ['one', 'two', 'three', terminal, 'tail', 'is', 'next', 'end.'];
    const cues = words.map((text, index) => ({startMs: index * 450, durationMs: 500, text}));
    expect(finalizeVideoSubtitleCues(cues)).toEqual([
      {startMs: 0, durationMs: 1850, text: `one two three${terminal.startsWith('「') ? '' : ' '}${terminal}`},
      {startMs: 1800, durationMs: 1850, text: 'tail is next end.'},
    ]);
  });

  it.each([-1, null, '', ' ', true, [], {}, 'NaN', 'Infinity'])('JSON3 拒绝无效起点：%j', (start) => {
    expect(parseYoutubeTimedTextResponse(JSON.stringify({events: [
      {tStartMs: start, dDurationMs: 500, segs: [{utf8: 'invalid'}]},
      {tStartMs: '1000', dDurationMs: '500', segs: [{utf8: 'valid'}]},
    ]}))).toEqual([{startMs: 1000, durationMs: 500, text: 'valid'}]);
  });

  it.each([-1, null, '', ' ', true, [], {}, 'NaN', 'Infinity'])('JSON3 拒绝无效已提供 duration：%j', (duration) => {
    expect(parseYoutubeTimedTextResponse(JSON.stringify({events: [
      {tStartMs: 0, dDurationMs: duration, segs: [{utf8: 'invalid'}]},
      {tStartMs: 1000, dDurationMs: 500, segs: [{utf8: 'valid'}]},
    ]}))).toEqual([{startMs: 1000, durationMs: 500, text: 'valid'}]);
  });

  it('缺失或零 duration 仍按下一个有效起点推断，最后一条保留默认时长', () => {
    const parsed = parseYoutubeTimedTextResponse(JSON.stringify({events: [
      {tStartMs: 0, segs: [{utf8: 'A complete first cue'}]},
      {tStartMs: 1500, dDurationMs: 0, segs: [{utf8: 'A complete final cue'}]},
    ]}));
    expect(parsed).toEqual([
      {startMs: 0, durationMs: 0, text: 'A complete first cue'},
      {startMs: 1500, durationMs: 0, text: 'A complete final cue'},
    ]);
    expect(finalizeVideoSubtitleCues(parsed)).toEqual([
      {startMs: 0, durationMs: 1500, text: 'A complete first cue'},
      {startMs: 1500, durationMs: 2000, text: 'A complete final cue'},
    ]);
  });

  it('XML 正则与 DOM 解析都拒绝无效时间字段，缺失 duration 保持回退', () => {
    const rows: Array<{start: string | null; duration: string | null; text: string}> = [
      {start: null, duration: '1', text: 'missing start'},
      {start: '', duration: '1', text: 'empty start'},
      {start: '-1', duration: '1', text: 'negative start'},
      {start: 'NaN', duration: '1', text: 'NaN start'},
      {start: 'Infinity', duration: '1', text: 'infinite start'},
      {start: '1', duration: '', text: 'empty duration'},
      {start: '1', duration: '-1', text: 'negative duration'},
      {start: '1', duration: 'Infinity', text: 'infinite duration'},
      {start: '1', duration: 'NaN', text: 'NaN duration'},
      {start: '1e308', duration: '1', text: 'overflow start conversion'},
      {start: '1', duration: '1e308', text: 'overflow duration conversion'},
      {start: '1', duration: '1', text: ''},
      {start: '2', duration: null, text: 'valid missing duration'},
    ];
    const xml = '<transcript>' + rows.map(({start, duration, text}) =>
      `<text${start === null ? '' : ` start="${start}"`}${duration === null ? '' : ` dur="${duration}"`}>${text}</text>`,
    ).join('') + '</transcript>';
    const previousParser = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
    const expected = [{startMs: 2000, durationMs: 0, text: 'valid missing duration'}];
    try {
      Reflect.deleteProperty(globalThis, 'DOMParser');
      expect(parseYoutubeTimedTextResponse(xml)).toEqual(expected);
      Object.defineProperty(globalThis, 'DOMParser', {
        configurable: true,
        value: class {
          parseFromString() {
            return {querySelectorAll: () => rows.map(({start, duration, text}) => ({
              getAttribute: (name: string) => name === 'start' ? start : duration,
              textContent: text,
            }))};
          }
        },
      });
      expect(parseYoutubeTimedTextResponse(xml)).toEqual(expected);
    } finally {
      if (previousParser) Object.defineProperty(globalThis, 'DOMParser', previousParser);
      else Reflect.deleteProperty(globalThis, 'DOMParser');
    }
  });

  it('finalize 排除无效起点和非有限 duration，重叠 cue 保留实际最晚结束时间', () => {
    const invalid = [
      ...[-1, null, '', Number.NaN, Number.POSITIVE_INFINITY].map((startMs) => ({startMs, durationMs: 500, text: 'bad start'})),
      ...[null, '', Number.NaN, Number.POSITIVE_INFINITY].map((durationMs) => ({startMs: 0, durationMs, text: 'bad duration'})),
    ] as Parameters<typeof finalizeVideoSubtitleCues>[0];
    const cues = [
      {startMs: 0, durationMs: 2000, text: 'one'},
      {startMs: 350, durationMs: 500, text: 'two'},
      {startMs: 700, durationMs: 500, text: 'three'},
      {startMs: 1050, durationMs: 100, text: 'done.'},
    ];
    expect(finalizeVideoSubtitleCues([...invalid, ...cues])).toEqual([
      {startMs: 0, durationMs: 2000, text: 'one two three done.'},
    ]);
  });

  it('词流合并后新出现的增量前缀关系一次收敛，重复 finalize 和 SRT 导出幂等', () => {
    const cues = [
      {startMs: 0, durationMs: 500, text: 'alpha'},
      {startMs: 30, durationMs: 500, text: 'beta'},
      {startMs: 60, durationMs: 500, text: 'gamma'},
      {startMs: 90, durationMs: 500, text: 'alpha beta gamma and a much longer continuation'},
    ];
    const snapshot = cues.map((cue) => ({...cue}));
    const finalized = finalizeVideoSubtitleCues(cues);
    expect(finalized).toEqual([cues[3]]);
    expect(finalizeVideoSubtitleCues(finalized)).toEqual(finalized);
    expect(finalizeVideoSubtitleCues(finalizeVideoSubtitleCues(finalized))).toEqual(finalized);
    expect(cuesToSrt(cues)).toBe(cuesToSrt(finalized));
    expect(cues).toEqual(snapshot);
  });

  it('有限数值相加溢出时也拒绝无效结束时间，避免导出 Infinity', () => {
    const cue = {startMs: 1e308, durationMs: 1e308, text: 'overflow'};
    expect(finalizeVideoSubtitleCues([cue])).toEqual([]);
    expect(cuesToSrt([cue])).toBe('');
    expect(parseYoutubeTimedTextResponse(JSON.stringify({events: [{
      tStartMs: cue.startMs, dDurationMs: cue.durationMs, segs: [{utf8: cue.text}],
    }]}))).toEqual([]);
  });

  it('普通完整长句及之后的短 cue 不误识别为连续逐词流', () => {
    const cues = [
      {startMs: 0, durationMs: 500, text: 'word'},
      {startMs: 450, durationMs: 500, text: 'A complete terminal sentence.'},
      {startMs: 900, durationMs: 500, text: 'tail'},
    ];
    expect(finalizeVideoSubtitleCues(cues)).toEqual(cues);
  });

  it('普通句末之后的 AI 保留事件句界，不推测为域名后缀', () => {
    const cues = ['It', 'works', 'today.', 'AI', 'is', 'useful.'].map((text, index) => ({
      startMs: index * 450, durationMs: 500, text,
    }));
    expect(finalizeVideoSubtitleCues(cues)).toEqual([
      {startMs: 0, durationMs: 1400, text: 'It works today.'},
      ...cues.slice(3),
    ]);
  });

  it('apostrophe 缩写 it 和单独的后缀事件连接成完整词', () => {
    const cues = ['it', "'s", 'a', 'test.'].map((text, index) => ({
      startMs: index * 450, durationMs: 500, text,
    }));
    expect(finalizeVideoSubtitleCues(cues)).toEqual([
      {startMs: 0, durationMs: 1850, text: "it's a test."},
    ]);
  });

  it('歧义缩写 U.S. 保守保留句界，不跨到后续 We 句子', () => {
    const cues = ['I', 'live', 'in', 'U.S.', 'We', 'agree.'].map((text, index) => ({
      startMs: index * 450, durationMs: 500, text,
    }));
    expect(finalizeVideoSubtitleCues(cues)).toEqual([
      {startMs: 0, durationMs: 1850, text: 'I live in U.S.'},
      {startMs: 1800, durationMs: 500, text: 'We'},
      {startMs: 2250, durationMs: 500, text: 'agree.'},
    ]);
  });

  it('带点的数字事件之后出现新数字时保留句界，不推测为小数', () => {
    const cues = ['I', 'chose', '1.', '2', 'was', 'wrong.'].map((text, index) => ({
      startMs: index * 450, durationMs: 500, text,
    }));
    expect(finalizeVideoSubtitleCues(cues)).toEqual([
      {startMs: 0, durationMs: 1400, text: 'I chose 1.'},
      ...cues.slice(3),
    ]);
  });

  it.each([
    [['we', "'re", 'all', 'ready.'], "we're all ready."],
    [['they', "'ve", 'just', 'arrived.'], "they've just arrived."],
    [['he', "'ll", 'come', 'tomorrow.'], "he'll come tomorrow."],
    [['she', "'d", 'prefer', 'tea.'], "she'd prefer tea."],
    [['I', "'m", 'here', 'today.'], "I'm here today."],
    [['it', '’s', 'a', 'test.'], 'it’s a test.'],
    [['we', '’re', 'all', 'ready.'], 'we’re all ready.'],
    [['they', '’ve', 'just', 'arrived.'], 'they’ve just arrived.'],
    [['he', '’ll', 'come', 'tomorrow.'], 'he’ll come tomorrow.'],
    [['she', '’d', 'prefer', 'tea.'], 'she’d prefer tea.'],
    [['I', '’m', 'here', 'today.'], 'I’m here today.'],
  ])('事件间直/弯 apostrophe 缩写后缀不插入空格：%j', (words, text) => {
    const cues = words.map((word, index) => ({startMs: index * 450, durationMs: 500, text: word}));
    const finalized = finalizeVideoSubtitleCues(cues);
    expect(finalized).toEqual([{startMs: 0, durationMs: 1850, text}]);
    expect(finalizeVideoSubtitleCues(finalized)).toEqual(finalized);
  });

  it.each(["'ready'", '‘ready’', "'s'", '‘s’'])('真正引用词保留前后词间空格：%s', (quoted) => {
    const cues = ['we', 'say', quoted, 'now.'].map((text, index) => ({
      startMs: index * 450, durationMs: 500, text,
    }));
    expect(finalizeVideoSubtitleCues(cues)).toEqual([
      {startMs: 0, durationMs: 1850, text: `we say ${quoted} now.`},
    ]);
  });

  it('被引用的称谓末点仍保留句界，不借后继人名越过闭引号', () => {
    const cues = ['one', 'two', 'three', '"Dr."', 'Smith', 'is', 'here.'].map((text, index) => ({
      startMs: index * 450, durationMs: 500, text,
    }));
    expect(finalizeVideoSubtitleCues(cues)).toEqual([
      {startMs: 0, durationMs: 1850, text: 'one two three "Dr."'},
      ...cues.slice(4),
    ]);
  });

  it('否定后缀 don 和 apostrophe t 事件连接为完整词', () => {
    const cues = ['don', "'t", 'do', 'that.'].map((text, index) => ({
      startMs: index * 450, durationMs: 500, text,
    }));
    expect(finalizeVideoSubtitleCues(cues)).toEqual([
      {startMs: 0, durationMs: 1850, text: "don't do that."},
    ]);
  });

  it('后缀后的逗号和空格续文仍连接缩写词', () => {
    const cues = ['we', "'re, in", 'fact, ready', 'today.'].map((text, index) => ({
      startMs: index * 450, durationMs: 500, text,
    }));
    expect(finalizeVideoSubtitleCues(cues)).toEqual([
      {startMs: 0, durationMs: 1850, text: "we're, in fact, ready today."},
    ]);
  });

  const suffixForms = [
    ['it', 's'], ['we', 're'], ['they', 've'], ['he', 'll'],
    ['she', 'd'], ['I', 'm'], ['don', 't'],
  ] as const;
  const apostrophes = ["'", '’'] as const;
  const suffixPunctuation = ['', ',', '.', ';', ':', '!', '?'] as const;

  it.each(suffixForms.flatMap(([stem, suffix]) => apostrophes.flatMap((apostrophe) =>
    suffixPunctuation.map((punctuation) => [stem, suffix, apostrophe, punctuation] as const),
  )))('七种后缀及标点保留词形和真实事件句界：%s / %s / %s / %s', (stem, suffix, apostrophe, punctuation) => {
    const cues = ['The', 'caption', 'reads', stem, `${apostrophe}${suffix}${punctuation}`, 'next.'].map((text, index) => ({
      startMs: index * 450, durationMs: 500, text,
    }));
    const sentence = `The caption reads ${stem}${apostrophe}${suffix}${punctuation}`;
    const finalized = finalizeVideoSubtitleCues(cues);
    const endsSentence = ['.', ';', ':', '!', '?'].includes(punctuation);
    expect(finalized).toEqual(endsSentence ? [
      {startMs: 0, durationMs: 2300, text: sentence},
      {startMs: 2250, durationMs: 500, text: 'next.'},
    ] : [{startMs: 0, durationMs: 2750, text: `${sentence} next.`}]);
    expect(finalizeVideoSubtitleCues(finalized)).toEqual(finalized);
    expect(cuesToSrt(cues)).toBe(cuesToSrt(finalized));
  });

  it.each(suffixForms.flatMap(([stem, suffix]) => apostrophes.flatMap((apostrophe) =>
    suffixPunctuation.filter(Boolean).map((punctuation) => [stem, suffix, apostrophe, punctuation] as const),
  )))('后缀消费标点后遇空格续文仍保持词形：%s / %s / %s / %s', (stem, suffix, apostrophe, punctuation) => {
    const cues = ['The', 'caption', 'reads', stem, `${apostrophe}${suffix}${punctuation} in`, 'fact, ready', 'today.'].map((text, index) => ({
      startMs: index * 450, durationMs: 500, text,
    }));
    const finalized = finalizeVideoSubtitleCues(cues);
    expect(finalized).toEqual([{
      startMs: 0, durationMs: 3200,
      text: `The caption reads ${stem}${apostrophe}${suffix}${punctuation} in fact, ready today.`,
    }]);
    expect(finalizeVideoSubtitleCues(finalized)).toEqual(finalized);
    expect(cuesToSrt(cues)).toBe(cuesToSrt(finalized));
  });

  it.each([["'", "'"], ['‘', '’'], ['’', '’']].flatMap(([open, close]) =>
    ['s', 's,', 's!', 's?', 'ready'].map((word) => [`${open}${word}${close}`, word] as const),
  ))('完整引用词及引用标点不误识别为缩写：%s', (quoted, word) => {
    const cues = ['The', 'caption', 'reads', quoted, 'next.'].map((text, index) => ({
      startMs: index * 450, durationMs: 500, text,
    }));
    const finalized = finalizeVideoSubtitleCues(cues);
    expect(finalized).toEqual(word.endsWith('!') || word.endsWith('?') ? [
      {startMs: 0, durationMs: 1850, text: `The caption reads ${quoted}`},
      {startMs: 1800, durationMs: 500, text: 'next.'},
    ] : [{startMs: 0, durationMs: 2300, text: `The caption reads ${quoted} next.`}]);
    expect(finalizeVideoSubtitleCues(finalized)).toEqual(finalized);
    expect(cuesToSrt(cues)).toBe(cuesToSrt(finalized));
  });

  it.each(apostrophes.flatMap((apostrophe) => ['some', 'remainder', 'team'].map((word) => `${apostrophe}${word}`)))('相似开引号词不能按后缀前缀匹配：%s', (word) => {
    const cues = ['The', 'caption', 'reads', word, 'next.'].map((text, index) => ({
      startMs: index * 450, durationMs: 500, text,
    }));
    const finalized = finalizeVideoSubtitleCues(cues);
    expect(finalized).toEqual([{startMs: 0, durationMs: 2300, text: `The caption reads ${word} next.`}]);
    expect(finalizeVideoSubtitleCues(finalized)).toEqual(finalized);
    expect(cuesToSrt(cues)).toBe(cuesToSrt(finalized));
  });
});
