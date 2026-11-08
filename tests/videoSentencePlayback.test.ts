import {afterEach, describe, expect, it, vi} from 'vitest';
import {SentencePlaybackController, type SentencePlaybackScheduler, type SentencePlaybackState} from '@/src/features/video-subtitle/content/sentencePlayback';
import {buildVideoSentenceTimeline} from '@/src/features/video-subtitle/content/sentenceTimeline';

class MediaFixture extends EventTarget {
  private time = 0;
  paused = false;
  seeking = false;
  ended = false;
  isConnected = true;
  playbackRate = 1.75;
  failSeek = false;
  synchronousSeek = false;
  get currentTime(): number { return this.time; }
  set currentTime(value: number) {
    if (this.failSeek) throw new Error('media unavailable');
    this.time = value;
    if (this.synchronousSeek) {
      this.seeking = true;
      this.dispatchEvent(new Event('seeking'));
      this.seeking = false;
      this.dispatchEvent(new Event('seeked'));
    }
  }
  play = vi.fn(async () => {
    this.paused = false;
    this.ended = false;
    this.dispatchEvent(new Event('play'));
  });
  pause = vi.fn(() => {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  });
}

function harness() {
  const media = new MediaFixture();
  const callbacks = new Map<number, () => void>();
  let sequence = 0;
  const scheduler: SentencePlaybackScheduler = {
    request: vi.fn(callback => { callbacks.set(++sequence, callback); return sequence; }),
    cancel: vi.fn(id => { callbacks.delete(id); }),
  };
  const state = vi.fn<(state: SentencePlaybackState) => void>();
  const controller = new SentencePlaybackController(media, scheduler, state);
  const sentence = buildVideoSentenceTimeline([{text: 'A complete sentence.', startMs: 1000, durationMs: 2000}])[0];
  const frame = () => {
    const first = [...callbacks.entries()][0];
    if (!first) throw new Error('no queued frame');
    callbacks.delete(first[0]);
    first[1]();
  };
  return {media, scheduler, callbacks, state, controller, sentence, frame};
}

afterEach(() => vi.unstubAllGlobals());

describe('视频单句播放器控制器', () => {
  it('在已结束或尚未开始的固定句上启用辅助只准备模式，不跳回视频开头或隐式播放', () => {
    const h = harness();
    const first = {...h.sentence, startMs: 0, endMs: 1000};
    h.media.currentTime = 25;
    h.controller.select(first, 'loop', false);
    for (let i = 0; i < 10; i++) h.media.dispatchEvent(new Event('timeupdate'));
    expect(h.media.currentTime).toBe(25); expect(h.callbacks.size).toBe(0);
    h.controller.setMode('pause'); h.media.dispatchEvent(new Event('timeupdate'));
    expect(h.media.pause).not.toHaveBeenCalled(); expect(h.media.currentTime).toBe(25);
    h.controller.setMode('loop'); h.media.dispatchEvent(new Event('ended'));
    expect(h.media.play).not.toHaveBeenCalled(); expect(h.controller.getState().mode).toBe('off');
    h.media.currentTime = 0;
    h.controller.select(h.sentence, 'loop', false);
    expect(h.callbacks.size).toBe(0);
    h.media.currentTime = 1.5; h.media.dispatchEvent(new Event('timeupdate'));
    expect(h.callbacks.size).toBe(1);
    h.media.currentTime = 3; h.frame(); expect(h.media.currentTime).toBe(1);
    expect(h.media.playbackRate).toBe(1.75);
    h.controller.destroy();
  });

  it('等待异步 seek 落地期间不重复写入 currentTime；错误落点解除而不争抢播放器', () => {
    const h = harness();
    let time = 5; let requested = 0; const writes = vi.fn((value: number) => {requested = value;});
    Object.defineProperty(h.media, 'currentTime', {get: () => time, set: writes});
    h.controller.select(h.sentence, 'loop');
    expect(writes).toHaveBeenCalledOnce(); expect(requested).toBe(1); expect(h.callbacks.size).toBe(0);
    for (let i = 0; i < 30; i++) h.media.dispatchEvent(new Event('timeupdate'));
    expect(writes).toHaveBeenCalledOnce(); expect(h.callbacks.size).toBe(0);
    h.media.dispatchEvent(new Event('ended')); expect(writes).toHaveBeenCalledOnce(); expect(h.media.play).not.toHaveBeenCalled();
    time = 1; h.media.dispatchEvent(new Event('timeupdate'));
    expect(h.callbacks.size).toBe(1);
    h.media.dispatchEvent(new Event('seeked'));
    expect(h.callbacks.size).toBe(1);
    time = 3; h.frame(); expect(writes).toHaveBeenCalledTimes(2); expect(h.callbacks.size).toBe(0);
    time = 9; h.media.dispatchEvent(new Event('seeked'));
    expect(h.controller.getState().mode).toBe('off'); expect(writes).toHaveBeenCalledTimes(2);
    h.controller.destroy();
  });

  it('跳转待完成时允许同一时间范围切换辅助模式', () => {
    const h = harness();
    let time = 5;
    const seek = vi.fn((value: number) => {time = value; h.media.seeking = true;});
    Object.defineProperty(h.media, 'currentTime', {get: () => time, set: seek});
    h.controller.select(h.sentence, 'loop');
    const nextSentence = {...h.sentence, id: 'next-semantic-sentence'};
    h.controller.select(nextSentence, 'pause', false);
    h.media.dispatchEvent(new Event('seeking'));
    h.media.seeking = false;
    h.media.dispatchEvent(new Event('seeked'));
    expect(h.controller.getState()).toMatchObject({sentence: nextSentence, mode: 'pause'});
    expect(seek.mock.calls).toEqual([[1]]);
    h.controller.destroy();
  });

  it('重播已在起点的暂停媒体不产生多余 seek，准备中的非有限时间不创建循环', () => {
    const h = harness(); const setter = vi.spyOn(h.media, 'currentTime', 'set');
    h.media.currentTime = 1; setter.mockClear(); h.media.paused = true;
    h.controller.select(h.sentence, 'loop'); expect(setter).not.toHaveBeenCalled();
    expect(h.callbacks.size).toBe(0);
    h.media.paused = false; h.media.dispatchEvent(new Event('play')); h.frame();
    expect(h.callbacks.size).toBe(1);
    h.media.currentTime = NaN; h.controller.select(h.sentence, 'loop', false);
    h.media.dispatchEvent(new Event('timeupdate')); expect(h.callbacks.size).toBe(0); expect(Number.isNaN(h.media.currentTime)).toBe(true);
    h.controller.destroy();
  });

  it('快速换句自己的 seek 尚未落地时切辅助模式保留 seek 归属和范围，不重复写入', () => {
    const h = harness(); let time = 20; const write = vi.fn();
    Object.defineProperty(h.media, 'currentTime', {get: () => time, set: write});
    h.controller.select(h.sentence, 'off');
    h.controller.setMode('loop'); expect(h.callbacks.size).toBe(0); expect(write).toHaveBeenCalledOnce();
    time = 1; h.media.seeking = true; h.media.dispatchEvent(new Event('seeking'));
    expect(h.controller.getState().mode).toBe('loop');
    h.media.seeking = false; h.media.dispatchEvent(new Event('seeked'));
    expect(h.callbacks.size).toBe(1); expect(write).toHaveBeenCalledOnce();
    time = 3; h.frame(); expect(write).toHaveBeenCalledTimes(2); expect(write).toHaveBeenLastCalledWith(1);
    h.controller.destroy();
  });

  it('未选句及停止后的播放事件不读取媒体状态或重复通知，已有选句仍在脱离页面时解除', () => {
    const h = harness();
    const connected = vi.fn(() => false);
    Object.defineProperty(h.media, 'isConnected', {get: connected});
    for (let i = 0; i < 100; i += 1) h.media.dispatchEvent(new Event('timeupdate'));
    expect(connected).not.toHaveBeenCalled();
    expect(h.state).not.toHaveBeenCalled();
    h.controller.select(h.sentence, 'off', false);
    h.media.dispatchEvent(new Event('timeupdate'));
    expect(connected).toHaveBeenCalledOnce();
    expect(h.controller.getState().sentence).toBeNull();
    expect(h.state).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 100; i += 1) h.media.dispatchEvent(new Event('timeupdate'));
    expect(connected).toHaveBeenCalledOnce();
    expect(h.state).toHaveBeenCalledTimes(2);
    h.controller.destroy();
  });

  it('只在用户明确播放的原媒体上循环原始范围，保持倍速；外部 seek 立即解除', async () => {
    const h = harness();
    h.media.synchronousSeek = true;
    h.controller.select(h.sentence, 'loop');
    expect(h.media.currentTime).toBe(1);
    expect(h.media.play).not.toHaveBeenCalled();
    expect(h.controller.getState()).toEqual({mode: 'loop', sentence: h.sentence, pausedAtEnd: false});
    h.media.synchronousSeek = false;
    h.media.currentTime = 2.9;
    h.frame();
    expect(h.media.currentTime).toBe(2.9);
    h.media.currentTime = 3.04;
    h.frame();
    expect(h.media.currentTime).toBe(1);
    expect(h.media.playbackRate).toBe(1.75);
    h.media.seeking = true;
    h.media.dispatchEvent(new Event('seeking'));
    expect(h.controller.getState().mode).toBe('loop');
    expect(h.callbacks.size).toBe(0);
    h.media.seeking = false;
    h.media.dispatchEvent(new Event('seeked'));
    expect(h.callbacks.size).toBe(1);
    h.media.currentTime = 10;
    h.media.dispatchEvent(new Event('seeking'));
    expect(h.controller.getState().mode).toBe('off');
    expect(h.callbacks.size).toBe(0);
    h.controller.destroy();
  });

  it('用户暂停取消帧且不会自动播放，恢复后继续同一句循环', async () => {
    const h = harness();
    h.controller.select(h.sentence, 'loop');
    h.media.pause();
    expect(h.callbacks.size).toBe(0);
    h.media.currentTime = 4;
    h.media.dispatchEvent(new Event('timeupdate'));
    expect(h.media.currentTime).toBe(4);
    expect(h.media.play).not.toHaveBeenCalled();
    expect(h.controller.getState().mode).toBe('loop');
    await h.media.play();
    h.frame();
    expect(h.media.currentTime).toBe(1);
    expect(h.media.play).toHaveBeenCalledTimes(1);
    h.controller.destroy();
  });

  it('句末暂停停在真实终点，主动恢复播放后解除句末暂停', async () => {
    const h = harness();
    h.controller.select(h.sentence, 'pause');
    h.media.currentTime = 3.1;
    h.frame();
    expect(h.media.pause).toHaveBeenCalledOnce();
    expect(h.media.currentTime).toBe(3);
    expect(h.controller.getState().pausedAtEnd).toBe(true);
    expect(h.callbacks.size).toBe(0);
    h.media.paused = false;
    h.media.dispatchEvent(new Event('timeupdate'));
    expect(h.media.pause).toHaveBeenCalledOnce();
    await h.media.play();
    expect(h.controller.getState()).toEqual({mode: 'off', sentence: null, pausedAtEnd: false});
    h.media.currentTime = 4;
    h.media.dispatchEvent(new Event('timeupdate'));
    expect(h.media.currentTime).toBe(4);
    h.controller.destroy();
  });

  it('选句可以保持当前时间；关闭控制不暂停视频；无选句时模式保持关闭', () => {
    const h = harness();
    h.controller.setMode('loop');
    expect(h.controller.getState().mode).toBe('off');
    h.media.currentTime = 2;
    h.controller.select(h.sentence, 'off', false);
    expect(h.media.currentTime).toBe(2);
    expect(h.callbacks.size).toBe(0);
    h.controller.setMode('loop');
    expect(h.callbacks.size).toBe(1);
    h.controller.setMode('off');
    expect(h.callbacks.size).toBe(0);
    expect(h.media.pause).not.toHaveBeenCalled();
    h.controller.stop();
    h.media.dispatchEvent(new Event('seeking'));
    expect(h.controller.getState().sentence).toBeNull();
    h.controller.destroy();
  });

  it('用户原生 seek 期间不执行边界；无 seeking 事件的明显倒退也解除', () => {
    const h = harness();
    h.controller.select(h.sentence, 'loop');
    h.media.currentTime = 5;
    h.media.seeking = true;
    h.media.dispatchEvent(new Event('timeupdate'));
    expect(h.media.currentTime).toBe(5);
    h.media.dispatchEvent(new Event('seeking'));
    expect(h.controller.getState().mode).toBe('off');
    h.media.seeking = false;
    h.controller.select(h.sentence, 'loop');
    h.media.currentTime = 0.5;
    h.frame();
    expect(h.controller.getState().mode).toBe('off');
    h.controller.select(h.sentence, 'loop');
    h.media.currentTime = NaN;
    h.frame();
    expect(h.controller.getState().mode).toBe('off');
    h.controller.destroy();
  });

  it('重载、资源中止和播放器断开释放控制；销毁移除全部监听且后续调用无效', () => {
    const h = harness();
    for (const name of ['emptied', 'abort', 'loadstart']) {
      h.controller.select(h.sentence, 'loop');
      h.media.dispatchEvent(new Event(name));
      expect(h.controller.getState().mode).toBe('off');
      expect(h.callbacks.size).toBe(0);
    }
    h.controller.select(h.sentence, 'loop');
    h.media.isConnected = false;
    h.frame();
    expect(h.controller.getState().mode).toBe('off');
    const remove = vi.spyOn(h.media, 'removeEventListener');
    h.controller.destroy();
    expect(remove).toHaveBeenCalledTimes(9);
    const calls = h.state.mock.calls.length;
    h.controller.destroy();
    h.controller.select(h.sentence, 'loop');
    h.controller.setMode('pause');
    h.media.dispatchEvent(new Event('play'));
    h.media.dispatchEvent(new Event('timeupdate'));
    expect(h.state.mock.calls).toHaveLength(calls);
    expect(h.callbacks.size).toBe(0);
  });

  it('不接受伪造或损坏的时间；媒体拒绝跳转时解除并取消循环', () => {
    const h = harness();
    for (const invalid of [
      {...h.sentence, startMs: NaN}, {...h.sentence, endMs: Infinity},
      {...h.sentence, startMs: -1}, {...h.sentence, endMs: h.sentence.startMs},
    ]) {
      h.controller.select(invalid, 'loop');
      expect(h.controller.getState().mode).toBe('off');
    }
    h.media.failSeek = true;
    h.controller.select(h.sentence, 'loop');
    expect(h.controller.getState().mode).toBe('off');
    h.media.failSeek = false;
    h.controller.select(h.sentence, 'loop');
    h.media.currentTime = 3;
    h.media.failSeek = true;
    h.frame();
    expect(h.controller.getState().mode).toBe('off');
    h.media.failSeek = false;
    h.media.paused = false;
    h.controller.select(h.sentence, 'pause');
    h.media.currentTime = 3.1;
    h.media.failSeek = true;
    h.frame();
    expect(h.controller.getState().mode).toBe('off');
    h.controller.destroy();
  });

  it('自然视频结束可继续单句循环，但结束后的播放器失败不会重试', async () => {
    const h = harness();
    h.controller.select(h.sentence, 'loop');
    h.media.currentTime = 3;
    h.media.paused = true;
    h.media.ended = true;
    h.media.dispatchEvent(new Event('ended'));
    await Promise.resolve();
    expect(h.media.currentTime).toBe(1);
    expect(h.media.play).toHaveBeenCalledOnce();
    expect(h.controller.getState().mode).toBe('loop');
    h.media.play.mockRejectedValueOnce(new Error('not allowed'));
    h.media.currentTime = 3;
    h.media.dispatchEvent(new Event('ended'));
    await Promise.resolve();
    expect(h.controller.getState().mode).toBe('off');
    h.controller.destroy();
  });

  it('旧播放失败不覆盖新选择；结尾 seek 失败直接解除', async () => {
    const h = harness();
    let reject!: (reason: Error) => void;
    h.media.play.mockImplementationOnce(() => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; }));
    h.controller.select(h.sentence, 'loop');
    h.media.currentTime = 3;
    h.media.dispatchEvent(new Event('ended'));
    h.controller.select(h.sentence, 'pause');
    reject(new Error('old play'));
    await Promise.resolve();
    expect(h.controller.getState().mode).toBe('pause');
    h.controller.setMode('loop');
    h.media.currentTime = 3;
    h.media.failSeek = true;
    h.media.dispatchEvent(new Event('ended'));
    expect(h.controller.getState().mode).toBe('off');
    h.controller.destroy();
  });

  it('普通视频结束和句末暂停均不强制播放；提前 ended 不循环', () => {
    const h = harness();
    h.controller.select(h.sentence, 'pause');
    h.media.currentTime = 3;
    h.media.dispatchEvent(new Event('ended'));
    expect(h.controller.getState().pausedAtEnd).toBe(true);
    h.controller.setMode('loop');
    h.media.currentTime = 2;
    h.media.dispatchEvent(new Event('ended'));
    expect(h.controller.getState().mode).toBe('off');
    h.media.dispatchEvent(new Event('ended'));
    expect(h.media.play).not.toHaveBeenCalled();
    h.controller.destroy();
  });

  it('默认使用真实页面动画帧 API，暂停中选句不会创建循环帧', () => {
    const request = vi.fn(() => 19);
    const cancel = vi.fn();
    vi.stubGlobal('requestAnimationFrame', request);
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const media = new MediaFixture();
    const sentence = buildVideoSentenceTimeline([{text: 'Sentence.', startMs: 0, durationMs: 1000}])[0];
    const controller = new SentencePlaybackController(media);
    media.paused = true;
    controller.select(sentence, 'loop');
    expect(request).not.toHaveBeenCalled();
    media.paused = false;
    media.dispatchEvent(new Event('play'));
    expect(request).toHaveBeenCalledOnce();
    controller.destroy();
    expect(cancel).toHaveBeenCalledWith(19);
  });
});
