/**
 * @file tests/videoNativeFullscreen.test.ts
 * 文件职责：验证 Safari 系统全屏字幕桥接的数据、轨道所有权与退出恢复契约。
 * 主要内容：覆盖显示模式、双语顺序与读音相邻、缓存空缺、转义与校时，系统全屏事件、手动关闭、迟到译文、失败、切视频和卸载。
 * 模块边界：以可控 TextTrack API 验证产品代码，不将 DOM 夹具当作 iOS AVKit 实机渲染验收。
 */
import {describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {createNativeFullscreenSubtitles, supportsNativeVideoFullscreen, supportsSafariNativeVideoFullscreen, type NativeFullscreenSubtitleState} from '@/src/features/video-subtitle/content/nativeFullscreen';

function setup() {
  const {document, window} = parseHTML('<html><body><video></video><video></video></body></html>');
  class Cue {
    constructor(public startTime: number, public endTime: number, public text: string) {}
  }
  Object.defineProperty(window, 'VTTCue', {value: Cue, configurable: true});
  const create = document.createElement.bind(document);
  const tracks: Array<{mode: TextTrackMode; kind: string; cues: Cue[] | null; stored: Cue[]; addCue: (cue: Cue) => void; removeCue: (cue: Cue) => void}> = [];
  document.createElement = ((name: string) => {
    const node = create(name);
    if (name === 'track') {
      let mode: TextTrackMode = 'disabled';
      const stored: Cue[] = [];
      const track = {get mode() { return mode; }, set mode(value: TextTrackMode) { mode = value; },
        kind: 'subtitles', get cues() { return mode === 'disabled' ? null : stored; }, stored,
        addCue(cue: Cue) {
          const index = stored.findIndex(item => item.startTime > cue.startTime);
          if (index === -1) stored.push(cue);
          else stored.splice(index, 0, cue);
        },
        removeCue(cue: Cue) { stored.splice(stored.indexOf(cue), 1); }};
      tracks.push(track);
      Object.defineProperty(node, 'track', {value: track, configurable: true});
    }
    return node;
  }) as typeof document.createElement;
  const videos = Array.from(document.querySelectorAll<HTMLVideoElement>('video'));
  const original = {kind: 'captions', mode: 'showing' as TextTrackMode};
  const sources = [original];
  const lists = videos.map(video => {
    const list = create('div');
    const current = () => [...sources, ...Array.from(video.querySelectorAll('track')).map(node => node.track)];
    Object.defineProperty(list, Symbol.iterator, {value: () => current()[Symbol.iterator](), configurable: true});
    Object.defineProperty(video, 'webkitEnterFullscreen', {value() {}, configurable: true});
    Object.defineProperty(video, 'webkitDisplayingFullscreen', {value: false, writable: true, configurable: true});
    Object.defineProperty(video, 'textTracks', {configurable: true, get: () => list});
    return list;
  });
  const state: NativeFullscreenSubtitleState = {video: videos[0], enabled: true, cues: [{startMs: 1000, durationMs: 2000, text: 'Original'}], mode: 'bilingual', offsetMs: 0, language: 'zh-Hans', translation: () => '译文'};
  const bridge = createNativeFullscreenSubtitles(() => state);
  const change = () => lists[videos.indexOf(state.video!)]?.dispatchEvent(new window.Event('change'));
  return {document, window, videos, original, sources, lists, tracks, state, bridge, change,
    select: (selected: typeof tracks[number] | typeof original | null) => {
      for (const track of [...sources, ...tracks]) track.mode = track === selected ? 'showing' : 'disabled';
      change();
    },
    enter: () => {
      Object.defineProperty(state.video!, 'webkitDisplayingFullscreen', {value: true, writable: true, configurable: true});
      state.video!.dispatchEvent(new window.Event('webkitbeginfullscreen'));
    },
    leave: () => {
      Object.defineProperty(state.video!, 'webkitDisplayingFullscreen', {value: false, writable: true, configurable: true});
      state.video!.dispatchEvent(new window.Event('webkitendfullscreen'));
    }};
}

/** 通过生产桥接创建真实轨道，快照后销毁；不再维护另一份只供测试的 cue 组合实现。 */
function readNativeFullscreenCues(state: NativeFullscreenSubtitleState) {
  const bridge = createNativeFullscreenSubtitles(() => state);
  try {
    bridge.sync();
    const track = state.video?.querySelector<HTMLTrackElement>('track[data-fluent-read-native-subtitles="true"]')?.track;
    return Array.from(track?.cues || []).map(cue => ({startMs: cue.startTime * 1000, durationMs: (cue.endTime - cue.startTime) * 1000, text: (cue as VTTCue).text}));
  } finally {bridge.destroy();}
}

describe('native fullscreen subtitles', () => {
  it('切换双语顺序时读音始终紧跟原文，单语和相同译文保留原有语义', () => {
    const {state} = setup();
    state.bilingualOrder = 'translation-first';
    state.cues = [{startMs: 0, durationMs: 2000, text: '<原文>\n原文第二行'}];
    state.translation = () => '译文 & <标记>\n译文第二行';
    state.reading = {enabled: true, source: '<原文>\n原文第二行', text: 'gen & bun'};
    expect(readNativeFullscreenCues(state)[0].text).toBe('译文 &amp; &lt;标记&gt;\n译文第二行\n&lt;原文&gt;\n原文第二行\ngen &amp; bun');
    state.bilingualOrder = 'original-first';
    expect(readNativeFullscreenCues(state)[0].text).toBe('&lt;原文&gt;\n原文第二行\ngen &amp; bun\n译文 &amp; &lt;标记&gt;\n译文第二行');
    state.bilingualOrder = 'translation-first';
    state.mode = 'original-only';
    expect(readNativeFullscreenCues(state)[0].text).toBe('&lt;原文&gt;\n原文第二行\ngen &amp; bun');
    state.mode = 'translation-only';
    expect(readNativeFullscreenCues(state)[0].text).toBe('译文 &amp; &lt;标记&gt;\n译文第二行');
    state.mode = 'bilingual'; state.translation = () => state.cues[0].text;
    expect(readNativeFullscreenCues(state)[0].text).toBe('&lt;原文&gt;\n原文第二行\ngen &amp; bun');
    state.translation = () => undefined;
    expect(readNativeFullscreenCues(state)[0].text).toBe('&lt;原文&gt;\n原文第二行\ngen &amp; bun');
  });

  it('顺序变化使已有原生轨道重新准备，保留当前选择和缓存读音，系统 Off 期间等待重新选择', () => {
    const f = setup();
    f.state.revision = 1;
    f.state.reading = {enabled: true, source: 'Original', text: 'orijinaru'};
    f.bridge.sync(); f.enter(); const track = f.tracks[0], node = f.document.querySelector('track'); f.select(track);
    f.state.reading.text = '';
    f.state.bilingualOrder = 'translation-first'; f.bridge.sync();
    expect(f.document.querySelector('track')).toBe(node);
    expect(track.mode).toBe('showing'); expect(f.original.mode).toBe('disabled');
    expect(track.cues![0].text).toBe('译文\nOriginal\norijinaru');
    f.state.reading.text = 'new reading'; f.bridge.sync();
    expect(track.cues![0].text).toBe('译文\nOriginal\nnew reading');
    f.select(null);
    const add = vi.spyOn(track, 'addCue'), remove = vi.spyOn(track, 'removeCue'), mode = vi.spyOn(track, 'mode', 'set');
    f.state.bilingualOrder = 'original-first'; f.bridge.sync();
    expect(add).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); expect(mode).not.toHaveBeenCalled();
    f.select(track); expect(track.cues![0].text).toBe('Original\nnew reading\n译文');
    f.bridge.destroy();
  });

  it('原生轨道按原文、读音、译文排序并转义WebVTT，仅译文模式不泄漏读音', () => {
    const {state} = setup();
    state.cues = [{startMs: 0, durationMs: 2000, text: '<原文>'}];
    state.reading = {enabled: true, source: ' <原文> ', text: 'gen & <bun>'};
    expect(readNativeFullscreenCues(state)[0].text).toBe('&lt;原文&gt;\ngen &amp; &lt;bun&gt;\n译文');
    state.mode = 'original-only'; expect(readNativeFullscreenCues(state)[0].text).toBe('&lt;原文&gt;\ngen &amp; &lt;bun&gt;');
    state.mode = 'translation-only'; expect(readNativeFullscreenCues(state)[0].text).toBe('译文');
    state.mode = 'bilingual'; state.reading.text = ''; expect(readNativeFullscreenCues(state)[0].text).toBe('&lt;原文&gt;\n译文');
    state.reading.text = 'genbun'; state.reading.source = 'other'; expect(readNativeFullscreenCues(state)[0].text).toBe('&lt;原文&gt;\n译文');
  });

  it('accepts a platform cue already updated to the desired reading without writing it again', () => {
    const f=setup();f.state.revision=1;f.state.reading={enabled:true,source:'Original',text:''};f.bridge.sync();
    const track=f.tracks[0];f.select(track);
    const cue=track.cues![0];let text='Original\norijinaru\n译文';const assign=vi.fn((value:string)=>{text=value;});
    Object.defineProperty(cue,'text',{configurable:true,get:()=>text,set:assign});
    f.state.reading.text='orijinaru';f.bridge.sync();
    expect(cue.text).toBe(text);expect(assign).not.toHaveBeenCalled();expect(track.cues![0]).toBe(cue);
    f.bridge.destroy();
  });

  it('新读音只patch重复原文对应的cue，不重读或重建两千句时间轴，等待态保留已完成读音', () => {
    const f = setup(); let reads = 0;
    f.state.revision = 1;
    f.state.cues = Array.from({length: 2000}, (_, index) => ({startMs: index * 2000, durationMs: 1800, text: index === 1000 ? 'Sentence 1' : `Sentence ${index}`}));
    f.state.translation = () => {reads += 1; return 'translated';};
    f.state.reading = {enabled: true, source: 'Sentence 1', text: ''}; f.bridge.sync();
    const track = f.tracks[0], originalCues = [...track.cues!], add = vi.spyOn(track, 'addCue'), remove = vi.spyOn(track, 'removeCue');
    f.state.reading.text = 'ichiban'; f.bridge.sync();
    expect(reads).toBe(2000); expect(add).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    expect(track.cues![1]).toBe(originalCues[1]); expect(track.cues![1].text).toBe('Sentence 1\nichiban\ntranslated');
    expect(track.cues![1000].text).toBe('Sentence 1\nichiban\ntranslated');
    f.state.reading.text = ''; f.bridge.sync(); expect(track.cues![1].text).toContain('ichiban');
    f.state.reading = {enabled: true, source: 'Sentence 2', text: 'niban'}; f.bridge.sync();
    expect(track.cues![2].text).toBe('Sentence 2\nniban\ntranslated'); expect(reads).toBe(2000);
    f.state.reading = {enabled: true, source: 'not in this track', text: 'unrelated'}; f.bridge.sync();
    expect(track.cues![2].text).toBe('Sentence 2\nniban\ntranslated'); expect(reads).toBe(2000);
    f.state.reading.enabled = false; f.bridge.sync(); expect(track.cues![1].text).toBe('Sentence 1\ntranslated');
    f.bridge.destroy();
  });

  it('系统Off期间只准备读音，不改轨道选择；重新选择后补当前读音，换轨清除旧缓存', () => {
    const f = setup(); f.state.revision = 1; f.state.reading = {enabled: true, source: 'Original', text: ''};
    f.bridge.sync(); const track = f.tracks[0]; f.enter(); f.select(null);
    const add = vi.spyOn(track, 'addCue'), remove = vi.spyOn(track, 'removeCue'), mode = vi.spyOn(track, 'mode', 'set');
    f.state.reading.text = 'orijinaru'; f.bridge.sync();
    expect(add).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); expect(mode).not.toHaveBeenCalled();
    f.select(track); expect(track.cues![0].text).toBe('Original\norijinaru\n译文');
    f.state.mode = 'translation-only'; f.bridge.sync(); expect(track.cues![0].text).toBe('译文');
    f.state.mode = 'original-only'; f.bridge.sync(); expect(track.cues![0].text).toBe('Original\norijinaru');
    f.state.cues = [...f.state.cues]; f.state.reading.text = ''; f.bridge.sync(); expect(track.cues![0].text).toBe('Original');
    f.bridge.destroy();
  });

  it('原生读音缓存条数和字符量有界，淘汰时只撤下对应的旧读音', () => {
    const f = setup(); f.state.revision = 1;
    f.state.cues = Array.from({length: 161}, (_, index) => ({startMs: index * 2000, durationMs: 1800, text: `Sentence ${index}`}));
    f.state.reading = {enabled: true, source: '', text: ''}; f.bridge.sync();
    for (let index = 0; index < 161; index += 1) {f.state.reading.source = `Sentence ${index}`; f.state.reading.text = `reading-${index}`; f.bridge.sync();}
    expect(f.tracks[0].cues![0].text).toBe('Sentence 0\n译文');
    expect(f.tracks[0].cues![160].text).toBe('Sentence 160\nreading-160\n译文');
    f.state.reading.text = 'x'.repeat(64_001); f.bridge.sync();
    expect(f.tracks[0].cues![160].text).toBe('Sentence 160\n译文'); f.bridge.destroy();
  });

  it('uses the chosen display mode without pretending missing translations exist', () => {
    const {state} = setup();
    expect(readNativeFullscreenCues(state)[0].text).toBe('Original\n译文');
    state.mode = 'translation-only'; expect(readNativeFullscreenCues(state)[0].text).toBe('译文');
    state.translation = () => undefined; expect(readNativeFullscreenCues(state)).toEqual([]);
    state.mode = 'bilingual'; expect(readNativeFullscreenCues(state)[0].text).toBe('Original');
    state.mode = 'original-only'; state.translation = () => { throw Error('must not translate'); };
    expect(readNativeFullscreenCues(state)[0].text).toBe('Original');
    state.mode = 'bilingual'; state.translation = () => 'Original'; expect(readNativeFullscreenCues(state)[0].text).toBe('Original');
  });

  it('escapes WebVTT markup, clips a shifted start, and removes invalid or expired cues', () => {
    const {state} = setup();
    state.mode = 'original-only'; state.offsetMs = -1500;
    state.cues = [{startMs: 1000, durationMs: 2000, text: '<b>A & B</b>'}, {startMs: 0, durationMs: 500, text: 'expired'}, {startMs: NaN, durationMs: 3, text: 'invalid'}, {startMs: 2000, durationMs: 1000, text: ' '}];
    expect(readNativeFullscreenCues(state)).toEqual([{startMs: 0, durationMs: 1500, text: '&lt;b&gt;A &amp; B&lt;/b&gt;'}]);
  });

  it('prepares hidden, waits for system selection, and restores the observed source only when leaving with FluentRead selected', () => {
    const f = setup(); f.bridge.sync(); const track = f.tracks[0];
    expect(track.mode).toBe('hidden'); expect(track.cues![0].text).toBe('Original\n译文');
    f.enter(); expect(track.mode).toBe('hidden'); expect(f.original.mode).toBe('showing');
    f.select(track); expect(track.mode).toBe('showing'); expect(f.original.mode).toBe('disabled');
    f.leave(); expect(track.mode).toBe('hidden'); expect(f.original.mode).toBe('showing');
    f.bridge.destroy(); expect(f.document.querySelector('track')).toBeNull();
    f.bridge.sync(); expect(f.document.querySelector('track')).toBeNull();
  });

  it('does not reopen Off after late cache changes, duplicate begin, leave and reentry', () => {
    const f = setup(); f.bridge.sync(); const track = f.tracks[0]; f.enter(); f.select(track); f.select(null);
    const add = vi.spyOn(track, 'addCue'), remove = vi.spyOn(track, 'removeCue'), mode = vi.spyOn(track, 'mode', 'set');
    f.state.translation = () => 'new'; f.state.offsetMs = 500; f.state.mode = 'translation-only';
    f.bridge.sync(); f.enter();
    const node = f.document.querySelector('track')!;
    node.dispatchEvent(new f.window.Event('error')); f.change();
    expect(track.mode).toBe('disabled'); expect(mode).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    f.leave(); expect(f.original.mode).toBe('disabled');
    f.enter(); expect(track.mode).toBe('hidden'); expect(f.original.mode).toBe('disabled');
    f.select(track); expect(track.cues![0].text).toBe('new'); expect(track.cues![0].startTime).toBe(1.5);
    f.bridge.destroy();
  });

  it('does not restore the previous source over another source selected in the system menu', () => {
    const f = setup(); const other = {kind: 'subtitles', mode: 'hidden' as TextTrackMode}; f.sources.push(other);
    f.bridge.sync(); f.enter(); f.select(f.tracks[0]); f.select(other); f.leave();
    expect(other.mode).toBe('showing'); expect(f.original.mode).toBe('disabled'); f.bridge.destroy();
  });

  it('freezes the source snapshot across duplicate begin and preserves a track already selected before entry', () => {
    const f = setup(); f.bridge.sync(); const track = f.tracks[0];
    track.mode = 'showing'; f.enter(); expect(track.mode).toBe('showing');
    f.original.mode = 'disabled'; f.enter(); f.leave();
    expect(f.original.mode).toBe('showing'); f.bridge.destroy();
  });

  it('keeps an existing track identity and selection while translations become empty and later return', () => {
    const f = setup(); f.state.mode = 'translation-only'; f.state.translation = () => undefined;
    f.bridge.sync(); f.enter(); expect(f.document.querySelector('track')).toBeNull(); expect(f.original.mode).toBe('showing');
    f.state.translation = () => 'ready'; f.bridge.sync(); const node = f.document.querySelector('track')!, track = f.tracks[0];
    expect(track.mode).toBe('hidden'); f.select(track);
    f.state.translation = () => undefined; f.bridge.sync();
    expect(f.document.querySelector('track')).toBe(node); expect(track.mode).toBe('showing'); expect(track.cues).toHaveLength(0);
    expect(f.original.mode).toBe('disabled');
    f.state.translation = () => 'returned'; f.bridge.sync();
    expect(f.document.querySelector('track')).toBe(node); expect(track.cues![0].text).toBe('returned');
    f.bridge.destroy(); expect(f.original.mode).toBe('showing');
  });

  it.each(['disable', 'switch', 'destroy'] as const)('restores the observed showing source on %s when FluentRead is still selected', action => {
    const f = setup(); f.bridge.sync(); f.enter(); f.select(f.tracks[0]);
    if (action === 'disable') { f.state.enabled = false; f.bridge.sync(); }
    else if (action === 'switch') { f.state.video = f.videos[1]; f.bridge.sync(); }
    else f.bridge.destroy();
    expect(f.original.mode).toBe('showing'); expect(f.tracks[0].mode).toBe('disabled');
    f.bridge.destroy();
  });

  it('does not invent an entry snapshot when attaching to an already fullscreen video', () => {
    const f = setup(); Object.defineProperty(f.videos[0], 'webkitDisplayingFullscreen', {value: true, configurable: true});
    f.bridge.sync(); expect(f.tracks[0].mode).toBe('hidden');
    f.select(f.tracks[0]); f.leave(); expect(f.original.mode).toBe('disabled'); f.bridge.destroy();
  });

  it('does not restore sources observed hidden or disabled and ignores metadata', () => {
    const f = setup(); f.original.mode = 'hidden';
    const disabled = {kind: 'captions', mode: 'disabled' as TextTrackMode};
    const metadata = {kind: 'metadata', mode: 'showing' as TextTrackMode}; f.sources.push(disabled, metadata);
    f.bridge.sync(); f.enter(); f.select(f.tracks[0]); f.leave();
    expect(f.original.mode).toBe('disabled'); expect(disabled.mode).toBe('disabled'); expect(metadata.mode).toBe('disabled');
    f.bridge.destroy();
  });

  it('ignores removed source tracks and does not add the old source beside a still showing source', () => {
    const f = setup(); f.bridge.sync(); f.enter(); f.select(f.tracks[0]);
    const other = {kind: 'captions', mode: 'showing' as TextTrackMode}; f.sources.push(other);
    f.leave(); expect(f.original.mode).toBe('disabled'); expect(other.mode).toBe('showing');
    f.enter(); f.select(f.tracks[0]); f.sources.splice(f.sources.indexOf(other), 1);
    f.leave(); expect(other.mode).toBe('disabled'); f.bridge.destroy();
  });

  it('refreshes prepared cues immediately on system selection after Off without writing disabled cues', () => {
    const f = setup(); f.bridge.sync(); f.enter(); const track = f.tracks[0]; f.select(track); f.select(null);
    const old = track.stored[0]; f.state.revision = 2; f.state.translation = () => 'updated'; f.bridge.sync();
    expect(track.cues).toBeNull(); expect(track.stored[0]).toBe(old);
    f.select(track); expect(track.cues).toHaveLength(1); expect(track.cues![0].text).toBe('Original\nupdated');
    f.bridge.destroy();
  });

  it('keeps the same disabled track across empty translation-only cache and fills only the latest cues on reselection', () => {
    const f = setup(); f.state.mode = 'translation-only'; f.bridge.sync(); f.enter();
    const node = f.document.querySelector('track')!, track = f.tracks[0]; f.select(track); f.select(null);
    const add = vi.spyOn(track, 'addCue'), remove = vi.spyOn(track, 'removeCue');
    f.state.translation = () => undefined; f.bridge.sync();
    expect(f.document.querySelector('track')).toBe(node); expect(track.mode).toBe('disabled');
    f.state.translation = () => 'latest'; f.bridge.sync();
    expect(add).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    f.select(track); expect(f.document.querySelector('track')).toBe(node);
    expect(track.cues).toHaveLength(1); expect(track.cues![0].text).toBe('latest'); f.bridge.destroy();
  });

  it('repairs browser-cleared cues on load and error without changing the selected mode or writing after destroy', () => {
    const f = setup(); f.state.revision = 1; f.bridge.sync(); const node = f.document.querySelector('track')!, track = f.tracks[0];
    const add = vi.spyOn(track, 'addCue'), remove = vi.spyOn(node, 'removeEventListener');
    f.enter(); f.select(track); track.stored.length = 0; node.dispatchEvent(new f.window.Event('error'));
    expect(track.cues).toHaveLength(1); expect(track.mode).toBe('showing');
    track.stored.length = 0; node.dispatchEvent(new f.window.Event('load')); expect(add).toHaveBeenCalledTimes(2);
    node.dispatchEvent(new f.window.Event('error')); expect(add).toHaveBeenCalledTimes(2);
    f.bridge.destroy(); expect(remove).toHaveBeenCalledWith('load', expect.any(Function)); expect(remove).toHaveBeenCalledWith('error', expect.any(Function));
    node.dispatchEvent(new f.window.Event('error')); f.change(); expect(add).toHaveBeenCalledTimes(2);
  });

  it('does not reenter sync on synchronous track-list change during cue writes and keeps its guard usable after a failure', () => {
    const f = setup(); f.bridge.sync(); const track = f.tracks[0], add = track.addCue;
    track.addCue = cue => { f.change(); add(cue); };
    f.state.translation = () => 'changed'; f.bridge.sync(); expect(track.cues).toHaveLength(1);
    track.addCue = () => { throw Error('platform rejected cue'); };
    f.enter(); f.select(track); f.state.translation = () => 'retry'; f.bridge.sync();
    expect(track.mode).toBe('showing'); expect(f.original.mode).toBe('disabled');
    track.addCue = add; f.bridge.sync(); expect(track.cues![0].text).toBe('Original\nretry'); f.bridge.destroy();
  });

  it('cleans a detached owned node, handles missing APIs, and attaches track-list listeners only to the current video', () => {
    const f = setup(); expect(supportsNativeVideoFullscreen(null)).toBe(false);
    delete (f.videos[1] as unknown as Record<string, unknown>).webkitEnterFullscreen;
    expect(supportsNativeVideoFullscreen(f.videos[1])).toBe(false);
    f.bridge.sync(); const old = f.document.querySelector('track')!; old.remove(); f.bridge.sync();
    expect(f.tracks[0].mode).toBe('disabled'); expect(f.tracks[1].mode).toBe('hidden');
    f.state.video = f.videos[1]; f.bridge.sync(); expect(f.document.querySelector('track')).toBeNull();
    const remove = vi.spyOn(f.lists[0], 'removeEventListener');
    f.state.video = f.videos[0]; f.bridge.sync(); f.state.enabled = false; f.bridge.sync();
    expect(remove).toHaveBeenCalledWith('change', expect.any(Function));
    f.state.enabled = true; Object.defineProperty(f.window, 'VTTCue', {value: undefined, configurable: true}); f.bridge.sync();
    expect(f.document.querySelector('track')).toBeNull(); f.bridge.destroy();
  });

  it('tolerates unavailable track lists and destroyed source getters without skipping cleanup', () => {
    const f = setup(); Object.defineProperty(f.videos[0], 'textTracks', {get: () => undefined});
    f.bridge.sync(); f.enter(); expect(f.tracks[0].mode).toBe('hidden'); f.bridge.destroy();
    const g = setup(); g.bridge.sync(); g.enter(); g.select(g.tracks[0]);
    Object.defineProperty(g.original, 'mode', {get: () => { throw Error('destroyed source'); }});
    expect(() => g.leave()).not.toThrow(); g.bridge.destroy();
    const h = setup(); Object.defineProperty(h.videos[0], 'textTracks', {get: () => { throw Error('destroyed list'); }});
    expect(() => { h.bridge.sync(); h.enter(); h.bridge.destroy(); }).not.toThrow();
  });

  it('ignores an invalid track-list iterator and an unreadable source at entry', () => {
    const f = setup(); f.bridge.sync();
    Object.defineProperty(f.lists[0], Symbol.iterator, {value: () => { throw Error('expired track list'); }, configurable: true});
    expect(() => f.enter()).not.toThrow(); f.bridge.destroy();
    const g = setup(); g.bridge.sync();
    Object.defineProperty(g.original, 'mode', {get: () => { throw Error('expired source'); }});
    expect(() => g.enter()).not.toThrow(); g.bridge.destroy();
  });

  it('repairs a temporarily unavailable cue list without changing the mode', () => {
    const f = setup(); f.bridge.sync(); const track = f.tracks[0];
    track.stored.length = 0; Object.defineProperty(track, 'cues', {configurable: true, get: () => null});
    f.bridge.sync(); expect(track.mode).toBe('hidden'); expect(track.stored[0].text).toBe('Original\n译文');
    f.bridge.destroy();
  });

  it('removes the node and all listeners even if its track getter or mode setter has become invalid', () => {
    for (const failingPart of ['getter', 'setter']) {
      const f = setup(); f.bridge.sync(); f.enter(); const node = f.document.querySelector('track')!, track = f.tracks[0];
      if (failingPart === 'getter') Object.defineProperty(node, 'track', {get: () => { throw Error('destroyed track'); }});
      else Object.defineProperty(track, 'mode', {set: () => { throw Error('destroyed setter'); }});
      const remove = vi.spyOn(f.lists[0], 'removeEventListener');
      expect(() => f.bridge.destroy()).not.toThrow(); expect(node.isConnected).toBe(false);
      expect(remove).toHaveBeenCalledWith('change', expect.any(Function)); f.bridge.destroy();
    }
  });

  it('does not rebuild unchanged long timelines and responds to language, display mode and cache revision changes', () => {
    const f = setup(); let reads = 0;
    f.state.cues = Array.from({length: 2000}, (_, index) => ({startMs: index * 2000, durationMs: 1800, text: `Sentence ${index}`}));
    f.state.revision = 1; f.state.translation = () => { reads += 1; return 'ready'; };
    f.bridge.sync(); f.bridge.sync(); f.enter(); f.select(f.tracks[0]); expect(reads).toBe(2000);
    f.state.revision = 2; f.bridge.sync(); expect(reads).toBe(4000);
    f.state.language = 'en'; f.bridge.sync(); expect(f.document.querySelector('track')?.srclang).toBe('en');
    f.bridge.destroy();
  });
});

describe('native source choice ownership after entry', () => {
  it.each(['leave', 'disable', 'destroy'] as const)('does not revive obsolete entry source after a newer choice then FluentRead on %s', action => {
    for (const choice of ['source-b', 'off'] as const) {
      const f = setup();
      const other = {kind: 'subtitles', mode: 'hidden' as TextTrackMode}; f.sources.push(other);
      f.bridge.sync(); f.enter();
      f.select(choice === 'source-b' ? other : null);
      f.select(f.tracks[0]);
      if (action === 'leave') f.leave();
      else if (action === 'disable') { f.state.enabled = false; f.bridge.sync(); }
      else f.bridge.destroy();
      expect(f.original.mode, `entry source must not return after ${choice}`).toBe('disabled');
      expect(other.mode).toBe(choice === 'source-b' ? 'showing' : 'disabled');
      f.bridge.destroy();
    }
  });
});


it('does not reassign source ownership during internal cue work or queued cleanup changes', () => {
  const f = setup();
  const other = {kind: 'subtitles', mode: 'hidden' as TextTrackMode}; f.sources.push(other);
  f.bridge.sync(); f.enter(); f.select(other); f.select(f.tracks[0]);
  const track = f.tracks[0], add = track.addCue;
  track.addCue = cue => { f.change(); add(cue); };
  f.state.translation = () => 'late cached translation';
  f.bridge.sync();
  expect(track.mode).toBe('showing');
  f.leave(); f.change();
  expect(other.mode).toBe('showing'); expect(f.original.mode).toBe('disabled');
  f.enter(); f.select(null); f.leave(); f.change(); f.enter();
  expect(other.mode).toBe('disabled'); expect(f.original.mode).toBe('disabled');
  f.bridge.destroy(); f.change();
  expect(f.document.querySelector('track')).toBeNull();
});

describe('PiP、元素级全屏与增量脏 cue 同步', () => {
  it('拒绝 <audio> 元素，精确区分 supportsSafariNativeVideoFullscreen 与通用支持能力', () => {
    const f = setup();
    const audio = f.document.createElement('audio') as unknown as HTMLVideoElement & {webkitEnterFullscreen?: () => void; requestFullscreen?: () => Promise<void>};
    audio.webkitEnterFullscreen = () => undefined;
    audio.requestFullscreen = async () => undefined;
    expect(supportsNativeVideoFullscreen(audio)).toBe(false);
    expect(supportsSafariNativeVideoFullscreen(audio)).toBe(false);
    expect(supportsSafariNativeVideoFullscreen(null)).toBe(false);
    expect(supportsSafariNativeVideoFullscreen(undefined)).toBe(false);
    expect(supportsSafariNativeVideoFullscreen(f.videos[0])).toBe(true);

    const nonSafari = f.videos[1] as unknown as HTMLVideoElement & {webkitEnterFullscreen?: () => void; requestPictureInPicture?: () => Promise<PictureInPictureWindow>};
    delete nonSafari.webkitEnterFullscreen;
    nonSafari.requestPictureInPicture = async () => ({} as PictureInPictureWindow);
    expect(supportsSafariNativeVideoFullscreen(nonSafari)).toBe(false);
    expect(supportsNativeVideoFullscreen(nonSafari)).toBe(true);
    f.bridge.destroy();
  });

  it('非 Safari 正常内联播放不提前注入轨道，进入画中画/元素全屏才懒挂载并临时移除/恢复 native-cue-hidden', () => {
    const f = setup();
    const video = f.videos[0] as unknown as HTMLVideoElement & {webkitEnterFullscreen?: () => void; requestPictureInPicture?: () => Promise<PictureInPictureWindow>; requestFullscreen?: () => Promise<void>};
    delete video.webkitEnterFullscreen;
    video.requestPictureInPicture = async () => ({} as PictureInPictureWindow);
    video.classList.add('fluent-read-video-native-cue-hidden');
    expect(supportsNativeVideoFullscreen(video)).toBe(true);
    expect(supportsSafariNativeVideoFullscreen(video)).toBe(false);

    // 捕获 fullscreenchange 监听器，验证 destroy 后迟到回调不抛错
    let capturedFsListener: (() => void) | undefined;
    const origAdd = f.document.addEventListener.bind(f.document);
    vi.spyOn(f.document, 'addEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (type === 'fullscreenchange' && typeof listener === 'function') capturedFsListener = listener as () => void;
      return origAdd(type, listener, options);
    });

    // 非 Safari 正常内联播放：不提前注入 <track>，保留 native-cue-hidden
    f.bridge.sync();
    expect(f.tracks).toHaveLength(0);
    expect(f.document.querySelector('track')).toBeNull();
    expect(video.classList.contains('fluent-read-video-native-cue-hidden')).toBe(true);
    expect(f.original.mode).toBe('showing');

    // 进入 Picture-in-Picture：懒创建轨道、自动切换 showing、关闭站点原轨并临时移除 native-cue-hidden
    Object.defineProperty(f.document, 'pictureInPictureElement', {configurable: true, value: video});
    video.dispatchEvent(new f.window.Event('enterpictureinpicture'));
    expect(f.tracks).toHaveLength(1);
    const track = f.tracks[0];
    expect(track.mode).toBe('showing');
    expect(f.original.mode).toBe('disabled');
    expect(video.classList.contains('fluent-read-video-native-cue-hidden')).toBe(false);

    // 同时进入元素级全屏后退出 PiP：仍处于元素全屏时不提前退出，且不重复恢复 native-cue-hidden
    Object.defineProperty(f.document, 'fullscreenElement', {configurable: true, value: video});
    f.document.dispatchEvent(new f.window.Event('fullscreenchange'));
    Object.defineProperty(f.document, 'pictureInPictureElement', {configurable: true, value: null});
    video.dispatchEvent(new f.window.Event('leavepictureinpicture'));
    expect(track.mode).toBe('showing');
    expect(video.classList.contains('fluent-read-video-native-cue-hidden')).toBe(false);

    // 容器级全屏（非 video 元素）退出元素全屏后恢复站点原轨并恢复 native-cue-hidden
    const container = f.document.createElement('div');
    f.document.body.appendChild(container);
    Object.defineProperty(f.document, 'fullscreenElement', {configurable: true, value: container});
    f.document.dispatchEvent(new f.window.Event('fullscreenchange'));
    expect(track.mode).toBe('hidden');
    expect(f.original.mode).toBe('showing');
    expect(video.classList.contains('fluent-read-video-native-cue-hidden')).toBe(true);

    // 通过 requestFullscreen + webkitFullscreenElement 进入元素级全屏并容忍只读源轨
    delete (video as {requestPictureInPicture?: unknown}).requestPictureInPicture;
    video.requestFullscreen = async () => undefined;
    expect(supportsNativeVideoFullscreen(video)).toBe(true);
    const readonlySource = {kind: 'captions', get mode() { return 'showing' as TextTrackMode; }, set mode(_value: TextTrackMode) { throw new Error('readonly'); }};
    f.sources.push(readonlySource as unknown as typeof f.original);
    Object.defineProperty(f.document, 'fullscreenElement', {configurable: true, value: null});
    Object.defineProperty(f.document, 'webkitFullscreenElement', {configurable: true, value: video});
    f.document.dispatchEvent(new f.window.Event('webkitfullscreenchange'));
    expect(track.mode).toBe('showing');
    expect(video.classList.contains('fluent-read-video-native-cue-hidden')).toBe(false);

    // 移除只读模拟轨道后验证手动关闭自有轨道不强行重启，并恢复 native-cue-hidden
    f.sources.pop();
    f.select(null);
    f.bridge.sync();
    expect(track.mode).toBe('disabled');
    expect(video.classList.contains('fluent-read-video-native-cue-hidden')).toBe(true);

    Object.defineProperty(f.document, 'webkitFullscreenElement', {configurable: true, value: null});
    f.document.dispatchEvent(new f.window.Event('webkitfullscreenchange'));
    // 未处于原生展示态时容器级全屏变化保持静默
    Object.defineProperty(f.document, 'fullscreenElement', {configurable: true, value: container});
    f.document.dispatchEvent(new f.window.Event('fullscreenchange'));
    expect(track.mode).toBe('hidden');

    // 原先没有 native-cue-hidden 类时，进入再退出 PiP 不会凭空添加该类
    video.classList.remove('fluent-read-video-native-cue-hidden');
    Object.defineProperty(f.document, 'fullscreenElement', {configurable: true, value: null});
    Object.defineProperty(f.document, 'pictureInPictureElement', {configurable: true, value: video});
    video.dispatchEvent(new f.window.Event('enterpictureinpicture'));
    expect(video.classList.contains('fluent-read-video-native-cue-hidden')).toBe(false);
    Object.defineProperty(f.document, 'pictureInPictureElement', {configurable: true, value: null});
    video.dispatchEvent(new f.window.Event('leavepictureinpicture'));
    expect(video.classList.contains('fluent-read-video-native-cue-hidden')).toBe(false);

    f.bridge.destroy();
    // 销毁后即便迟到触发已捕获的 fullscreenchange 回调也安全短路
    expect(() => capturedFsListener?.()).not.toThrow();
  });

  it('仅增删发生译文变化的脏 cue，避免长视频全量清空与重建', () => {
    const f = setup();
    const translations = new Map<string, string>();
    f.state.cues = Array.from({length: 500}, (_, index) => ({startMs: index * 2000, durationMs: 1800, text: `Cue ${index}`}));
    f.state.revision = 1;
    f.state.translation = source => translations.get(source);
    f.bridge.sync();
    const track = f.tracks[0];
    const add = vi.spyOn(track, 'addCue');
    const remove = vi.spyOn(track, 'removeCue');

    // 只更新 1 条译文
    translations.set('Cue 42', '第 42 句译文');
    f.state.revision = 2;
    f.bridge.sync();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
    expect(track.cues![42].text).toBe('Cue 42\n第 42 句译文');
    expect(track.cues![41].text).toBe('Cue 41');
    f.bridge.destroy();
  });
});
