import {describe, expect, it} from 'vitest';
import {Config} from '@/src/core/config/model';
import {createGlossaryLibrary} from '@/src/core/glossary';
import {getVideoTranslationConfigFingerprint, mergeBilingualVideoSubtitleCues, normalizeVideoCaptionText, revealVideoSubtitleTranslation, translateVideoSubtitleCues, selectYoutubeCaptionCue, selectVideoSubtitleCueAtOffset, selectVideoSubtitlePretranslationCues, findProgressiveVideoCaptionCue} from '@/src/features/video-subtitle/content/subtitleLogic';

describe('video subtitle logic', () => {
  it('预翻译把当前句放在首位，去重后提前八句，不被旧字幕或重复条目占满', () => {
    const current = {startMs: 900, durationMs: 1000, text: ' Current  sentence '};
    const older = {...current, startMs: 700, text: 'Older overlapping sentence'};
    const future = Array.from({length: 10}, (_, i) => ({startMs: 2000 + i * 500, durationMs: 300, text: `Next sentence ${i}`}));
    const repeated = future.flatMap(cue => [cue, {...cue, text: ` ${cue.text} `}]);
    const expired = Array.from({length: 8}, (_, i) => ({startMs: 500 + i * 40, durationMs: 20, text: `Expired ${i}`}));
    const cues = [...repeated.reverse(), older, ...expired, current, {...current, startMs: 1100}, {startMs: 1500, durationMs: 100, text: '  '}, {startMs: 1500, durationMs: 0, text: 'Empty cue'}];
    const before = JSON.stringify(cues);
    expect(selectVideoSubtitlePretranslationCues(cues, 1000, 10_000).map(cue => cue.text.trim())).toEqual(['Current  sentence', ...future.slice(0, 8).map(cue => cue.text)]);
    expect(JSON.stringify(cues)).toBe(before);
    expect(selectVideoSubtitlePretranslationCues([{...current, text: ' '}], 1000, 10_000)).toEqual([]);
  });

  it('预翻译窗口按墙钟与播放速度换算，支持空档、边界和无效输入', () => {
    const near = {startMs: 11_000, durationMs: 1000, text: 'Near cue'};
    const fast = {...near, startMs: 21_000, text: 'Fast cue'};
    const far = {...near, startMs: 21_001, text: 'Outside window'};
    expect(selectVideoSubtitlePretranslationCues([far, fast, near], 1000, 10_000, 2)).toEqual([near, fast]);
    for (const rate of [.5, 1, 0, -1, NaN, Infinity]) expect(selectVideoSubtitlePretranslationCues([near, fast], 1000, 10_000, rate)).toEqual([near]);
    for (const [time, window] of [[NaN, 10_000], [Infinity, 10_000], [0, NaN], [0, Infinity], [0, 0], [0, -1]]) {
      expect(selectVideoSubtitlePretranslationCues([near], time, window)).toEqual([]);
    }
    expect(selectVideoSubtitlePretranslationCues([], 0, 10_000)).toEqual([]);
  });

  it('继承默认的视频指纹随网页服务变更，独立服务不受影响', () => {
    const config = new Config();
    config.service = 'google';
    const inherited = getVideoTranslationConfigFingerprint(config);
    config.service = 'microsoft';
    expect(getVideoTranslationConfigFingerprint(config)).not.toBe(inherited);
    config.videoService = 'deepseek';
    const independent = getVideoTranslationConfigFingerprint(config);
    config.service = 'google';
    expect(getVideoTranslationConfigFingerprint(config)).toBe(independent);
  });

  it('长时间轴播放时只读取当前时段的文本，保持 seek 与原位编辑可见', () => {
    let reads = 0;
    const cues = Array.from({length: 6000}, (_, index) => ({
      startMs: index * 1000, durationMs: 1000,
      get text() { reads += 1; return `Caption ${index}`; },
    }));
    for (const index of [3000, 5999, 0, 1200]) {
      reads = 0;
      expect(selectYoutubeCaptionCue(cues, `Caption ${index}`, index * 1000 + 50))
        .toEqual({cue: cues[index], stale: false});
      expect(reads).toBe(1);
    }
    const edited = {startMs: 0, durationMs: 1000, text: 'Before'};
    expect(selectYoutubeCaptionCue([edited], 'Before', 10).cue).toBe(edited);
    edited.text = 'After';
    expect(selectYoutubeCaptionCue([edited], 'After', 10).cue).toBe(edited);
    expect(selectYoutubeCaptionCue([edited], 'Before', 10)).toEqual({cue: null, stale: false});
  });

  it('双语导出保留时间轴，把原文和译文分成两行，相同内容只保留一行', () => {
    const cues = [
      {startMs: 0, durationMs: 1000, text: ' Hello world '},
      {startMs: 1200, durationMs: 900, text: '這個東西'},
      {startMs: 2400, durationMs: 900, text: 'Missing translation'},
    ];
    const translated = [
      {...cues[0], text: '你好，世界'},
      {...cues[1], text: ' 這個東西 '},
      {...cues[2], text: '  '},
    ];

    expect(mergeBilingualVideoSubtitleCues(cues, translated)).toEqual([
      {startMs: 0, durationMs: 1000, text: 'Hello world\n你好，世界'},
      {startMs: 1200, durationMs: 900, text: '這個東西'},
      {startMs: 2400, durationMs: 900, text: 'Missing translation'},
    ]);
    expect(mergeBilingualVideoSubtitleCues(cues, [])).toEqual(cues.map(cue => ({...cue, text: cue.text.trim()})));
  });

  it('渐进字幕优先匹配当前时段，再按完整匹配、长度和开始时间消除歧义', () => {
    const previous = {startMs: 0, durationMs: 1000, text: 'Hello world'};
    const current = {startMs: 3000, durationMs: 1000, text: 'Hello world'};
    const future = {startMs: 6000, durationMs: 1000, text: 'Hello world'};
    expect(findProgressiveVideoCaptionCue([future, previous, current], ' HELLO ', 3200)).toBe(current);
    expect(findProgressiveVideoCaptionCue([future, previous], 'Hello', 4000)).toBe(future);
    const exact = {...current, text: 'Hello'};
    expect(findProgressiveVideoCaptionCue([current, exact], 'hello', 3200)).toBe(exact);
    expect(findProgressiveVideoCaptionCue([exact, current], 'hello', 3200)).toBe(exact);
    const shorter = {...current, text: 'Hello all'};
    expect(findProgressiveVideoCaptionCue([current, shorter], 'hello', 3200)).toBe(shorter);
    const earlier = {...current, startMs: 2900};
    expect(findProgressiveVideoCaptionCue([current, earlier], 'hello', 3200)).toBe(earlier);
    expect(findProgressiveVideoCaptionCue([current, {...current}], 'hello', 3200)).toBe(current);
    expect(findProgressiveVideoCaptionCue([current, exact], 'hello', NaN)).toBe(exact);
    expect(findProgressiveVideoCaptionCue([current], 'hello', 5000)).toBe(current);
  });

  it('渐进字幕单词反查受时间距离与最少字符约束，保留原始 cue', () => {
    const cue = {startMs: 3000, durationMs: 0, text: 'The moon rises'};
    const distant = {...cue, startMs: 9000};
    const unrelated = {...cue, text: 'The sun sets'};
    expect(findProgressiveVideoCaptionCue([distant, unrelated, cue], 'moon', 3200)).toBe(cue);
    expect(findProgressiveVideoCaptionCue([cue], 'Watching the moon rises now', 3200)).toBe(cue);
    expect(findProgressiveVideoCaptionCue([cue], 'moon', 4700)).toBe(cue);
    expect(findProgressiveVideoCaptionCue([cue], 'moon', 4701)).toBeNull();
    expect(findProgressiveVideoCaptionCue([cue], 'mo', 3200)).toBeNull();
    expect(findProgressiveVideoCaptionCue([cue], 'moon', NaN)).toBeNull();
    expect(findProgressiveVideoCaptionCue([cue], 'unrelated', 3200)).toBeNull();
    expect(findProgressiveVideoCaptionCue([cue], '  ', 3200)).toBeNull();
    expect(findProgressiveVideoCaptionCue([], 'moon', 3200)).toBeNull();
    expect(cue).toEqual({startMs: 3000, durationMs: 0, text: 'The moon rises'});
  });

  it('字幕手动提前和延后按半秒移动显示时间，保留短句、重叠、空档和原始数据', () => {
    const first = {startMs: 1000, durationMs: 100, text: 'First.'};
    const second = {startMs: 2000, durationMs: 1000, text: 'Second.'};
    const overlapping = {startMs: 2500, durationMs: 500, text: 'Latest.'};
    const cues = [first, overlapping, second, {startMs: 2500, durationMs: 0, text: 'Empty.'}];
    const before = JSON.stringify(cues);
    expect(selectVideoSubtitleCueAtOffset(cues, 500, -500)).toBe(first);
    expect(selectVideoSubtitleCueAtOffset(cues, 1500, 500)).toBe(first);
    expect(selectVideoSubtitleCueAtOffset(cues, 1600, 500)).toBeNull();
    expect(selectVideoSubtitleCueAtOffset(cues, 1500, -500)).toBe(second);
    expect(selectVideoSubtitleCueAtOffset(cues, 2500, 0)).toBe(overlapping);
    expect(selectVideoSubtitleCueAtOffset(cues, 0, 500)).toBeNull();
    expect(selectVideoSubtitleCueAtOffset(cues, 3500, 500)).toBeNull();
    expect(selectVideoSubtitleCueAtOffset(cues, NaN, 0)).toBeNull();
    expect(selectVideoSubtitleCueAtOffset([], 500, 0)).toBeNull();
    expect(JSON.stringify(cues)).toBe(before);
  });

  it('YouTube 滚动字幕末尾出现新句时立即匹配当前 cue，不等待上一行滚出', () => {
    const previous = {startMs: 1000, durationMs: 4000, text: 'They serve drinks.'};
    const current = {startMs: 3000, durationMs: 2000, text: "I thought I'd try out this beer."};
    const cues = [previous, current];
    expect(selectYoutubeCaptionCue(cues, "They serve drinks. I thought", 3000)).toEqual({cue: current, stale: false});
    expect(selectYoutubeCaptionCue(cues, "drinks. I thought I'd try", 3200).cue).toBe(current);
    expect(selectYoutubeCaptionCue(cues, "Old clipped line. They serve drinks. I thought", 3400).cue).toBe(current);
    expect(selectYoutubeCaptionCue(cues, "drinks. I thought", 2999).cue).toBeNull();
    expect(selectYoutubeCaptionCue(cues, "drinks. I thought", 5000).cue).toBeNull();
  });

  it('YouTube 滚动前缀不使用词中间、极短词或无关轨道猜测新句', () => {
    const current = {startMs: 3000, durationMs: 2000, text: 'Inside the lounge.'};
    const cues = [current];
    expect(selectYoutubeCaptionCue(cues, 'A native sentence. In', 3200)).toEqual({cue: null, stale: false});
    expect(selectYoutubeCaptionCue(cues, 'A native sentence. Ins', 3200).cue).toBeNull();
    expect(selectYoutubeCaptionCue(cues, 'A native sentence. Inside', 3200).cue).toBe(current);
    expect(selectYoutubeCaptionCue(cues, 'The building is outside', 3200).cue).toBeNull();
    expect(selectYoutubeCaptionCue(cues, '另一条字幕轨道。', 3200).cue).toBeNull();
    expect(selectYoutubeCaptionCue(cues, 'Old line. Inside the lounge.', 3200).cue).toBe(current);
  });

  it('YouTube 只匹配当前时间内的原文，不借用前后句或其他时段的同文字幕', () => {
    const first = {startMs: 1000, durationMs: 1000, text: 'Sea otters have strong teeth.'};
    const next = {startMs: 2000, durationMs: 1000, text: 'They open the shell.'};
    const repeated = {...first, startMs: 9000};
    const cues = [first, next, repeated];
    expect(selectYoutubeCaptionCue(cues, 'Sea otters', 1500)).toEqual({cue: first, stale: false});
    expect(selectYoutubeCaptionCue(cues, first.text, 2000)).toEqual({cue: null, stale: true});
    expect(selectYoutubeCaptionCue(cues, next.text, 1999)).toEqual({cue: null, stale: true});
    expect(selectYoutubeCaptionCue(cues, first.text, 9500)).toEqual({cue: repeated, stale: false});
    expect(selectYoutubeCaptionCue(cues, first.text, 8500)).toEqual({cue: null, stale: true});
    expect(selectYoutubeCaptionCue(cues, 'A different language track.', 2500)).toEqual({cue: null, stale: false});
    expect(selectYoutubeCaptionCue(cues, 'shell.', 2500)).toEqual({cue: next, stale: false});
    expect(selectYoutubeCaptionCue(cues, 'shell.', 3500)).toEqual({cue: null, stale: false});
  });

  it('YouTube 匹配处理空值、无时间轴、短 cue 和重叠 cue，严格遵守结束时间', () => {
    const cue = {startMs: 1000, durationMs: 100, text: 'Hello'};
    expect(selectYoutubeCaptionCue([cue], '', 1000)).toEqual({cue: null, stale: false});
    expect(selectYoutubeCaptionCue([cue], 'Hello', NaN)).toEqual({cue: null, stale: false});
    expect(selectYoutubeCaptionCue([cue], 'hello', 1099).cue).toBe(cue);
    expect(selectYoutubeCaptionCue([cue], 'hello', 1100)).toEqual({cue: null, stale: true});
    expect(selectYoutubeCaptionCue([{...cue, durationMs: 0}], 'hello', 1000).cue).toBeNull();
    const early = {...cue, durationMs: 1000};
    const late = {...early, startMs: 1100};
    const prefix = {...late, text: 'Hello there'};
    expect(selectYoutubeCaptionCue([{...early, text: ''}, late, early, prefix], '  HELLO  ', 1200).cue).toBe(late);
    expect(selectYoutubeCaptionCue([early, late], 'hello', 1200).cue).toBe(late);
    expect(selectYoutubeCaptionCue([{...early, text: 'say hello'}], 'he', 1200).cue).toBeNull();
    expect(selectYoutubeCaptionCue([cue], 'well hello', 1000).cue).toBe(cue);
  });

  it('原语言、字幕词库选择与术语修改均使旧字幕翻译失效', () => {
    const config = new Config();
    config.glossaryEnabled = true;
    config.glossaryLibraries = [{...createGlossaryLibrary([]), id: 'technical', entries: [
      {id: 'agent', source: 'agent', target: '智能体', caseSensitive: false},
    ]}];
    const initial = getVideoTranslationConfigFingerprint(config);
    config.videoSourceLanguage = 'ko';
    const languageChanged = getVideoTranslationConfigFingerprint(config);
    expect(languageChanged).not.toBe(initial);
    config.videoGlossaryIds = ['technical'];
    const selectionChanged = getVideoTranslationConfigFingerprint(config);
    expect(selectionChanged).not.toBe(languageChanged);
    config.glossaryLibraries[0].entries[0].target = '代理';
    const terminologyChanged = getVideoTranslationConfigFingerprint(config);
    expect(terminologyChanged).not.toBe(selectionChanged);
    config.glossaryEnabled = false;
    expect(getVideoTranslationConfigFingerprint(config)).not.toBe(terminologyChanged);
  });
  it('批译去重、保序、进度和并发配置', async () => {
    const progress: number[] = []; const cues = [{startMs: 0, durationMs: 1, text: ' a '}, {startMs: 1, durationMs: 1, text: 'a'}, {startMs: 2, durationMs: 1, text: 'b'}];
    await expect(translateVideoSubtitleCues(cues, async text => `译-${text.trim()}`, {concurrency: 2, onProgress: n => progress.push(n)})).resolves.toEqual([{...cues[0], text: '译-a'}, {...cues[1], text: '译-a'}, {...cues[2], text: '译-b'}]);
    expect(progress).toEqual([0, 1, 2]);
  });
  it('配置指纹保留免费回退与 Minimax、Mimo、DeepL 计费地区身份', () => {
    const config = new Config();
    const identities = ['free', 'minimax', 'mimo', 'deepl'].map(service => {
      config.videoService = service as Config['videoService'];
      return getVideoTranslationConfigFingerprint(config);
    });
    expect(new Set(identities).size).toBe(4);
  });

  it('空时间轴直接返回，空白 cue 保留原文', async () => {
    await expect(translateVideoSubtitleCues([], async text => text)).resolves.toEqual([]);
    const cues = [{startMs: 0, durationMs: 1, text: 'a'}, {startMs: 1, durationMs: 1, text: '   '}];
    await expect(translateVideoSubtitleCues(cues, async text => `译-${text}`)).resolves.toEqual([
      {...cues[0], text: '译-a'},
      cues[1],
    ]);
  });
  it('拒绝空译文、支持 abort、配置指纹包含动态 providers/thinking', async () => {
    await expect(translateVideoSubtitleCues([{startMs: 0, durationMs: 1, text: 'x'}], async () => '', {})).rejects.toThrow('为空');
    const controller = new AbortController(); controller.abort();
    await expect(translateVideoSubtitleCues([], async x => x, {signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
    expect(normalizeVideoCaptionText('  a\n b ')).toBe('a b');
    expect(revealVideoSubtitleTranslation('你好世界', '你', '你好世界')).toBe('你');
    const one = new Config(); const two = new Config(); two.customOpenAIProviders = [{id: 'custom:x', name: 'x', endpoint: 'https://x', models: ['m']}];
    expect(getVideoTranslationConfigFingerprint(one)).not.toBe(getVideoTranslationConfigFingerprint(two));
  });

  it('非字符串译文与未提供 failure 时使用公开错误回退', async () => {
    await expect(translateVideoSubtitleCues([{startMs: 0, durationMs: 1, text: 'x'}], async () => 1 as unknown as string))
      .rejects.toThrow('为空');
    await expect(translateVideoSubtitleCues([{startMs: 0, durationMs: 1, text: 'x'}], async () => { throw undefined; }))
      .rejects.toThrow('字幕翻译失败');
  });
  it('批译中途 abort 时拒绝且不写回部分结果', async () => {
    const controller = new AbortController();
    const pending = translateVideoSubtitleCues([{startMs: 0, durationMs: 1, text: 'x'}, {startMs: 1, durationMs: 1, text: 'y'}], async () => new Promise<string>(resolve => setTimeout(() => resolve('ok'), 20)), {signal: controller.signal});
    controller.abort();
    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
  });
  it('worker 在取下一项前观察到 abort', async () => {
    const controller = new AbortController();
    await expect(translateVideoSubtitleCues([{startMs: 0, durationMs: 1, text: 'x'}, {startMs: 1, durationMs: 1, text: 'y'}, {startMs: 2, durationMs: 1, text: 'z'}], async () => { controller.abort(); return 'ok'; }, {concurrency: 2, signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
  });
  it('覆盖渐进显示的空值、相等、非前缀和 Unicode 边界', () => {
    expect(revealVideoSubtitleTranslation('', 'a', 'abc')).toBe('');
    expect(revealVideoSubtitleTranslation('译文', '', 'abc')).toBe('译文');
    expect(revealVideoSubtitleTranslation('译文', 'abc', 'abc')).toBe('译文');
    expect(revealVideoSubtitleTranslation('译文', 'x', 'abc')).toBe('译文');
    expect(revealVideoSubtitleTranslation('你好世界', '你', '你好世界')).toBe('你');
  });

  it('配置指纹覆盖各服务端点与可选角色', () => {
    const cases = [
      {service: 'microsoft', mutate: (config: Config) => { config.proxy.microsoft = 'https://proxy.example'; }},
      {service: 'custom', mutate: (config: Config) => { config.custom = 'https://custom.example'; }},
      {service: 'newapi', mutate: (config: Config) => { config.newApiUrl = 'https://newapi.example'; }},
      {service: 'deeplx', mutate: (config: Config) => { config.deeplx = 'https://deeplx.example'; }},
      {service: 'azureOpenai', mutate: (config: Config) => {
        config.azureOpenaiEndpoint = 'https://azure.example';
        config.system_role.azureOpenai = '';
        config.user_role.azureOpenai = '';
      }},
    ];
    for (const entry of cases) {
      const config = new Config();
      config.videoService = entry.service;
      entry.mutate(config);
      expect(getVideoTranslationConfigFingerprint(config)).toContain(entry.service);
    }
  });
});
