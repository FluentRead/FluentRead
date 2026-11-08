/**
 * @file tests/videoKaraoke.test.ts
 * 文件职责：验证视频字幕逐字高亮的切分、时间换算、节点写入与播放控制器。
 * 主要内容：覆盖中英文与标点的无损切分、时长估算和进度定位；字幕行在开关两种状态下的写入与复用；逐帧上色只改动变化的单元；控制器在播放、暂停、拖动、无时间轴和销毁时的行为。
 * 模块边界：使用 linkedom 与手动帧队列，不启动播放器运行时、翻译或真实浏览器。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {
  estimateVideoKaraokeDurationMs,
  getVideoKaraokeProgress,
  locateVideoKaraokePosition,
  splitVideoKaraokeParts,
} from '@/src/features/video-subtitle/content/karaokeLogic';
import {
  createVideoKaraokeController,
  paintVideoKaraokeLine,
  setVideoCaptionText,
  VIDEO_KARAOKE_FILL_PROPERTY,
  VIDEO_KARAOKE_STATE_ATTRIBUTE,
  VIDEO_KARAOKE_TEXT_ATTRIBUTE,
  VIDEO_KARAOKE_UNIT_CLASS,
  type VideoKaraokeController,
} from '@/src/features/video-subtitle/content/karaoke';

const texts = (value: string) => splitVideoKaraokeParts(value).map(part => part.text);

function createLine(): HTMLElement {
  const {document} = parseHTML('<!doctype html><html><body><div id="line"></div></body></html>');
  return document.getElementById('line') as unknown as HTMLElement;
}

const units = (line: Element) => Array.from(line.querySelectorAll<HTMLElement>(`.${VIDEO_KARAOKE_UNIT_CLASS}`));
const states = (line: Element) => units(line).map(unit => unit.getAttribute(VIDEO_KARAOKE_STATE_ATTRIBUTE));
const fills = (line: Element) => units(line).map(unit => unit.style.getPropertyValue(VIDEO_KARAOKE_FILL_PROPERTY) || '');

describe('逐字高亮切分与时间换算', () => {
  it('中文按字、英文按词切分，并保持原文可无损拼回', () => {
    expect(texts('你好，世界！')).toEqual(['你', '好，', '世', '界！']);
    expect(texts('Hello, big  world.')).toEqual(['Hello,', ' ', 'big', '  ', 'world.']);
    const mixed = '「AI」 说：“ok” —— 😀 好';
    expect(texts(mixed).join('')).toBe(mixed);
  });

  it('起始括号跟随后一个字，句首与空白后的标点不会丢失', () => {
    expect(texts('他说「你好」')).toEqual(['他', '说', '「你', '好」']);
    expect(texts('…等等')).toEqual(['…等', '等']);
    expect(texts('好 —— 好')).toEqual(['好', ' ', '——', ' ', '好']);
    expect(texts('走吧（')).toEqual(['走', '吧', '（']);
    expect(texts('')).toEqual([]);
  });

  it('按字词数量与停顿分配权重，空白不占时间', () => {
    const [short, space, long, , emoji] = splitVideoKaraokeParts('a internationalization, 😀');
    expect(space.weight).toBe(0);
    expect(short.weight).toBeCloseTo(.6);
    expect(long.weight).toBeCloseTo(20 * .4 + .6);
    expect(emoji.weight).toBeCloseTo(.6);
    expect(splitVideoKaraokeParts('好')[0].weight).toBe(1);
  });

  it('估算时长限制在合理范围内', () => {
    expect(estimateVideoKaraokeDurationMs('好')).toBe(1200);
    expect(estimateVideoKaraokeDurationMs('今天天气不错我们出去走走')).toBe(12 * 230);
    expect(estimateVideoKaraokeDurationMs('字'.repeat(80))).toBe(7000);
  });

  it('进度在句子内线性前进并提前收尾', () => {
    const timing = {startMs: 1000, durationMs: 2000};
    expect(getVideoKaraokeProgress(timing, 500)).toBe(0);
    expect(getVideoKaraokeProgress(timing, 1920)).toBeCloseTo(.5);
    expect(getVideoKaraokeProgress(timing, 2900)).toBe(1);
    expect(getVideoKaraokeProgress(timing, Number.NaN)).toBe(0);
    expect(getVideoKaraokeProgress({startMs: 0, durationMs: 0}, 10)).toBe(0);
  });

  it('把进度定位到单元与单元内比例', () => {
    expect(locateVideoKaraokePosition([1, 2, 4], 0)).toEqual({index: 0, fraction: 0});
    expect(locateVideoKaraokePosition([1, 2, 4], .25)).toEqual({index: 1, fraction: 0});
    expect(locateVideoKaraokePosition([1, 2, 4], .75)).toEqual({index: 2, fraction: .5});
    expect(locateVideoKaraokePosition([1, 2, 4], 1)).toEqual({index: 3, fraction: 0});
    expect(locateVideoKaraokePosition([], .5)).toEqual({index: 0, fraction: 0});
  });
});

describe('字幕行写入与上色', () => {
  it('关闭时写入纯文本，开启时拆成单元且 textContent 不变', () => {
    const line = createLine();
    setVideoCaptionText(line, 'Hello world', false);
    expect(line.childNodes.length).toBe(1);
    expect(units(line)).toHaveLength(0);
    expect(paintVideoKaraokeLine(line, .5)).toBe(false);

    setVideoCaptionText(line, 'Hello world', true);
    expect(line.textContent).toBe('Hello world');
    expect(units(line).map(unit => unit.getAttribute(VIDEO_KARAOKE_TEXT_ATTRIBUTE))).toEqual(['Hello', 'world']);

    setVideoCaptionText(line, 'Hello world', false);
    expect(units(line)).toHaveLength(0);
    expect(line.textContent).toBe('Hello world');
  });

  it('文本与方式都没变时复用节点，清空和纯空白不生成单元', () => {
    const line = createLine();
    setVideoCaptionText(line, '你好', true);
    const first = units(line)[0];
    setVideoCaptionText(line, '你好', true);
    expect(units(line)[0]).toBe(first);

    setVideoCaptionText(line, '', true);
    expect(line.childNodes.length).toBe(0);
    setVideoCaptionText(line, '   ', true);
    expect(units(line)).toHaveLength(0);
    expect(line.textContent).toBe('   ');
  });

  it('外部改写节点后不再把旧单元当作当前行', () => {
    const line = createLine();
    setVideoCaptionText(line, '你好', true);
    line.textContent = '你好';
    expect(paintVideoKaraokeLine(line, .5)).toBe(false);
    setVideoCaptionText(line, '你好', true);
    expect(units(line)).toHaveLength(2);
  });

  it('向前、向后与唱完时只更新变化的单元', () => {
    const line = createLine();
    setVideoCaptionText(line, '一二三四', true);

    expect(paintVideoKaraokeLine(line, 0)).toBe(true);
    expect(states(line)).toEqual(['active', null, null, null]);
    expect(fills(line)).toEqual(['0.0%', '', '', '']);

    paintVideoKaraokeLine(line, .625);
    expect(states(line)).toEqual(['sung', 'sung', 'active', null]);
    expect(fills(line)).toEqual(['', '', '50.0%', '']);
    const active = units(line)[2];
    const writeState = vi.spyOn(active, 'setAttribute');
    for (let frame = 1; frame <= 20; frame++) paintVideoKaraokeLine(line, .625 + frame * .001);
    expect(writeState.mock.calls.filter(([name]) => name === VIDEO_KARAOKE_STATE_ATTRIBUTE)).toHaveLength(0);
    expect(fills(line)).toEqual(['', '', '58.0%', '']);
    writeState.mockRestore();

    paintVideoKaraokeLine(line, .3);
    expect(states(line)).toEqual(['sung', 'active', null, null]);
    expect(fills(line)).toEqual(['', '20.0%', '', '']);

    paintVideoKaraokeLine(line, 1);
    expect(states(line)).toEqual(['sung', 'sung', 'sung', 'sung']);
    expect(fills(line)).toEqual(['', '', '', '']);

    paintVideoKaraokeLine(line, 0);
    expect(states(line)).toEqual(['active', null, null, null]);
  });
});

describe('逐字高亮控制器', () => {
  let controller: VideoKaraokeController | undefined;
  afterEach(() => {
    controller?.destroy();
    controller = undefined;
  });

  function setup(options: {timing?: {startMs: number; durationMs: number} | null} = {}) {
    const original = createLine();
    const translation = original.ownerDocument.createElement('div') as unknown as HTMLElement;
    const frames = new Map<number, () => void>();
    let frameId = 0;
    const state = {
      enabled: true,
      video: {currentTime: 0, paused: false, ended: false} as HTMLVideoElement | null,
      timing: options.timing === undefined ? {startMs: 0, durationMs: 4000} : options.timing,
      timingCalls: 0,
    };
    controller = createVideoKaraokeController({
      window: {
        requestAnimationFrame: (callback: FrameRequestCallback) => {
          frameId += 1;
          frames.set(frameId, () => callback(0));
          return frameId;
        },
        cancelAnimationFrame: (id: number) => { frames.delete(id); },
      },
      document: original.ownerDocument,
      isEnabled: () => state.enabled,
      getVideo: () => state.video,
      getLines: () => [original, translation],
      getTiming: () => { state.timingCalls += 1; return state.timing; },
    });
    const runFrame = () => {
      const pending = Array.from(frames.values());
      frames.clear();
      pending.forEach(run => run());
    };
    return {original, translation, frames, state, runFrame, controller};
  }

  it('写入字幕后在下一帧上色，播放期间持续跟随，原文与译文同步', () => {
    const {original, translation, frames, state, runFrame} = setup();
    setVideoCaptionText(original, 'one two', true);
    setVideoCaptionText(translation, '一二', true);
    expect(frames.size).toBe(1);

    state.video!.currentTime = 1.84;
    runFrame();
    expect(states(original)).toEqual(['sung', 'active']);
    expect(states(translation)).toEqual(['sung', 'active']);
    expect(frames.size).toBe(1);
    expect(state.timingCalls).toBe(1);

    state.video!.currentTime = 3.9;
    runFrame();
    expect(states(translation)).toEqual(['sung', 'sung']);
    expect(state.timingCalls).toBe(1);
  });

  it('暂停与播放结束时停在当前位置，不保留帧循环', () => {
    const {original, frames, state, runFrame, controller} = setup();
    setVideoCaptionText(original, '一二', true);
    state.video!.currentTime = .92;
    Object.assign(state.video!, {paused: true});
    runFrame();
    expect(states(original)).toEqual(['active', null]);
    expect(frames.size).toBe(0);

    Object.assign(state.video!, {paused: false, ended: true});
    controller.sync();
    expect(frames.size).toBe(0);

    Object.assign(state.video!, {ended: false});
    controller.sync();
    expect(frames.size).toBe(1);
    controller.sync();
    expect(frames.size).toBe(1);
  });

  it('关闭、没有视频或没有高亮行时不工作', () => {
    const {original, frames, state, controller} = setup();
    setVideoCaptionText(original, '一二', false);
    controller.sync();
    expect(frames.size).toBe(0);

    setVideoCaptionText(original, '一二', true);
    state.enabled = false;
    controller.sync();
    expect(states(original)).toEqual([null, null]);
    expect(frames.size).toBe(0);

    state.enabled = true;
    state.video = null;
    controller.sync();
    expect(frames.size).toBe(0);
  });

  it('没有时间轴时从出现的时刻起按估算时长扫光，译文稍后到达仍保持同步', () => {
    const {original, translation, state, runFrame} = setup({timing: null});
    state.video!.currentTime = 10;
    setVideoCaptionText(original, '一二三四', true);
    runFrame();
    expect(states(original)).toEqual(['active', null, null, null]);

    state.video!.currentTime = 10.6;
    setVideoCaptionText(translation, 'ab cd', true);
    runFrame();
    expect(states(original)[2]).toBe('active');
    expect(states(translation)).toEqual(['sung', 'active']);

    // 估算时长结束后保持点亮，不循环重扫。
    state.video!.currentTime = 30;
    runFrame();
    expect(states(original)).toEqual(['sung', 'sung', 'sung', 'sung']);
  });

  it('相同文本的下一句从头再扫，新句子重新取时间', () => {
    const {original, state, runFrame} = setup({timing: {startMs: 0, durationMs: 1000}});
    setVideoCaptionText(original, '好的', true);
    state.video!.currentTime = 2;
    runFrame();
    expect(states(original)).toEqual(['sung', 'sung']);
    runFrame();
    expect(states(original)).toEqual(['sung', 'sung']);

    state.timing = {startMs: 2000, durationMs: 1000};
    runFrame();
    expect(states(original)).toEqual(['active', null]);

    state.timing = {startMs: 5000, durationMs: 1000};
    state.video!.currentTime = 5.5;
    setVideoCaptionText(original, '走吧', true);
    runFrame();
    expect(states(original)).toEqual(['sung', 'active']);

    setVideoCaptionText(original, '', true);
    runFrame();
    state.timing = {startMs: 5000, durationMs: 4000};
    setVideoCaptionText(original, '走吧', true);
    runFrame();
    expect(states(original)).toEqual(['active', null]);
  });

  it('拖动进度条后在暂停画面上重画，销毁后不再响应播放事件', () => {
    const {original, frames, state, runFrame, controller} = setup();
    const {Event} = original.ownerDocument.defaultView!;
    Object.assign(state.video!, {paused: true});
    setVideoCaptionText(original, '一二', true);
    runFrame();
    expect(states(original)).toEqual(['active', null]);

    state.video!.currentTime = 2.5;
    original.dispatchEvent(new Event('seeked', {bubbles: true}));
    expect(states(original)).toEqual(['sung', 'active']);
    expect(frames.size).toBe(0);

    controller.destroy();
    state.video!.currentTime = 0;
    original.dispatchEvent(new Event('seeked', {bubbles: true}));
    expect(states(original)).toEqual(['sung', 'active']);
  });

  it('销毁后取消帧循环并忽略后续调用', () => {
    const {original, frames, controller} = setup();
    setVideoCaptionText(original, '一二', true);
    expect(frames.size).toBe(1);
    controller.destroy();
    expect(frames.size).toBe(0);
    controller.sync();
    setVideoCaptionText(original, '三四', true);
    expect(frames.size).toBe(0);
  });
});
