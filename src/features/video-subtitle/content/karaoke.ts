/**
 * @file src/features/video-subtitle/content/karaoke.ts
 * 文件职责：把 FluentRead 字幕行渲染成可逐字点亮的高亮单元，并在视频播放期间按句子时间驱动 KTV 式扫光。
 * 主要内容：统一字幕行写入（文本未变时不触碰 DOM）、构建与复用高亮单元、仅在单元切换时改写状态并每帧只更新当前单元的一个 CSS 变量；控制器自行监听播放、暂停与拖动事件，只在功能开启、视频播放且有字幕时保持帧循环，其余时间停在准确位置。
 * 模块边界：只操作传入的字幕行节点，时间轴与开关状态经端口注入；不读取配置、不发起翻译，样式由 ui.ts 的字幕样式表提供。
 */
import {
  estimateVideoKaraokeDurationMs,
  getVideoKaraokeProgress,
  locateVideoKaraokePosition,
  splitVideoKaraokeParts,
  type VideoKaraokeTiming,
} from './karaokeLogic';

export const VIDEO_KARAOKE_UNIT_CLASS = 'fluent-read-video-karaoke-unit';
export const VIDEO_KARAOKE_TEXT_ATTRIBUTE = 'data-fluent-read-karaoke-text';
export const VIDEO_KARAOKE_STATE_ATTRIBUTE = 'data-fluent-read-karaoke-state';
export const VIDEO_KARAOKE_FILL_PROPERTY = '--fluent-read-video-karaoke-fill';

interface VideoKaraokeLine {
  units: HTMLElement[];
  ends: number[];
  index: number;
  fill: string;
}

/** 这些事件之后要么需要重启帧循环，要么需要在静止画面上重画一次；媒体事件不冒泡，统一在捕获阶段监听。 */
const VIDEO_KARAOKE_EVENTS = ['play', 'playing', 'pause', 'seeked', 'ended'];

const lines = new WeakMap<Element, VideoKaraokeLine>();
let notifyLineChange: (() => void) | undefined;

function getVideoKaraokeLine(element: Element): VideoKaraokeLine | undefined {
  const line = lines.get(element);
  return line && line.units[0].parentNode === element ? line : undefined;
}

/**
 * 字幕行的唯一写入口：文本与渲染方式都没变时直接返回，避免播放期间反复重建节点；
 * 开启逐字高亮时拆成单元，关闭时退回纯文本。textContent 在两种方式下保持一致。
 */
export function setVideoCaptionText(element: Element, text: string, karaoke: boolean): void {
  const parts = karaoke ? splitVideoKaraokeParts(text) : [];
  const highlighted = parts.some(part => part.weight > 0);
  if (element.textContent === text && Boolean(getVideoKaraokeLine(element)) === highlighted) return;
  if (!highlighted) {
    lines.delete(element);
    element.textContent = text;
    return;
  }

  const document = element.ownerDocument;
  const fragment = document.createDocumentFragment();
  const line: VideoKaraokeLine = {units: [], ends: [], index: -1, fill: ''};
  let total = 0;
  for (const part of parts) {
    if (!part.weight) {
      fragment.appendChild(document.createTextNode(part.text));
      continue;
    }
    const unit = document.createElement('span');
    unit.className = VIDEO_KARAOKE_UNIT_CLASS;
    unit.setAttribute(VIDEO_KARAOKE_TEXT_ATTRIBUTE, part.text);
    unit.textContent = part.text;
    fragment.appendChild(unit);
    total += part.weight;
    line.units.push(unit);
    line.ends.push(total);
  }
  element.replaceChildren(fragment);
  lines.set(element, line);
  notifyLineChange?.();
}

/** 把一行字幕画到指定进度；返回该行是否处于逐字高亮状态。 */
export function paintVideoKaraokeLine(element: Element, progress: number): boolean {
  const line = getVideoKaraokeLine(element);
  if (!line) return false;
  const {index, fraction} = locateVideoKaraokePosition(line.ends, progress);
  const last = line.units.length - 1;
  if (line.index !== index) {
    const firstChanged = Math.max(0, Math.min(line.index, index));
    const lastChanged = Math.min(Math.max(line.index, index), last);
    for (let cursor = firstChanged; cursor <= lastChanged; cursor += 1) {
      const unit = line.units[cursor];
      if (cursor < index) unit.setAttribute(VIDEO_KARAOKE_STATE_ATTRIBUTE, 'sung');
      else if (cursor === index) unit.setAttribute(VIDEO_KARAOKE_STATE_ATTRIBUTE, 'active');
      else unit.removeAttribute(VIDEO_KARAOKE_STATE_ATTRIBUTE);
      if (cursor !== index) unit.style.removeProperty(VIDEO_KARAOKE_FILL_PROPERTY);
    }
  }
  const fill = index > last ? '' : `${(fraction * 100).toFixed(1)}%`;
  if (index !== line.index || fill !== line.fill) {
    if (fill) line.units[index].style.setProperty(VIDEO_KARAOKE_FILL_PROPERTY, fill);
    line.index = index;
    line.fill = fill;
  }
  return true;
}

interface VideoKaraokePorts {
  window: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'>;
  document: Pick<Document, 'addEventListener' | 'removeEventListener'>;
  isEnabled(): boolean;
  getVideo(): HTMLVideoElement | null;
  /** 当前的字幕行，原文在前；第一行高亮文本决定“同一句”。 */
  getLines(): Element[];
  /** 当前句在视频时间轴上的起止；没有时间轴时返回 null，由控制器按阅读速度估算。 */
  getTiming(): VideoKaraokeTiming | null;
}

export interface VideoKaraokeController {
  /** 开关等外部状态变化后调用：立即重画一次，并按需启动或停止帧循环；字幕写入与播放事件会自动触发。 */
  sync(): void;
  destroy(): void;
}

export function createVideoKaraokeController(ports: VideoKaraokePorts): VideoKaraokeController {
  let frame: number | undefined;
  let destroyed = false;
  let timing: VideoKaraokeTiming | null = null;
  let timingKey = '';
  let timingStale = true;

  const stop = () => {
    if (frame !== undefined) ports.window.cancelAnimationFrame(frame);
    frame = undefined;
  };

  /** 只在字幕行重建后重新确认句子；原文与译文共用同一段时间，先后到达也保持同步。 */
  const resolveTiming = (elements: Element[], currentMs: number): VideoKaraokeTiming => {
    if (timingStale || !timing) {
      const key = elements.find(element => getVideoKaraokeLine(element))!.textContent!;
      if (key !== timingKey || !timing) {
        timingKey = key;
        timing = ports.getTiming() || {startMs: currentMs, durationMs: estimateVideoKaraokeDurationMs(key)};
      }
      timingStale = false;
    } else if (currentMs < timing.startMs || currentMs >= timing.startMs + timing.durationMs) {
      // 连续两句文本相同时节点不会重建；时间轴给出新的一句就从头再扫，估算的时长不循环。
      const next = ports.getTiming();
      if (next && next.startMs !== timing.startMs) timing = next;
    }
    return timing;
  };

  const paint = (): boolean => {
    const video = ports.getVideo();
    const elements = ports.getLines();
    if (!ports.isEnabled() || !video || !elements.some(element => getVideoKaraokeLine(element))) {
      timing = null;
      return false;
    }
    const currentMs = video.currentTime * 1000;
    const progress = getVideoKaraokeProgress(resolveTiming(elements, currentMs), currentMs);
    for (const element of elements) paintVideoKaraokeLine(element, progress);
    return !video.paused && !video.ended;
  };

  const tick = () => {
    frame = undefined;
    if (paint()) frame = ports.window.requestAnimationFrame(tick);
  };

  const sync = () => {
    if (destroyed) return;
    stop();
    tick();
  };

  notifyLineChange = () => {
    timingStale = true;
    // 同一轮里原文与译文先后写入时合并到下一帧一起上色。
    if (frame === undefined) frame = ports.window.requestAnimationFrame(tick);
  };

  VIDEO_KARAOKE_EVENTS.forEach(name => ports.document.addEventListener(name, sync, true));

  return {
    sync,
    destroy: () => {
      destroyed = true;
      stop();
      notifyLineChange = undefined;
      VIDEO_KARAOKE_EVENTS.forEach(name => ports.document.removeEventListener(name, sync, true));
    },
  };
}
