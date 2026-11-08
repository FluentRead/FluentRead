/**
 * @file src/features/video-subtitle/content/sentencePlayback.ts
 * 文件职责：在现有网页媒体元素上提供可解除的单句循环与句末暂停控制。
 * 主要内容：只在选句期间检查媒体状态，按原文毫秒范围识别自身跳转与用户 seek；尚未进入所选范围时只准备辅助模式，待 seek 完成再检查边界，尊重暂停和倍速，并在媒体重载、卸载或销毁时取消监听与动画帧。
 * 模块边界：不创建播放器、不修改倍速/全屏/画中画，不进行字幕翻译或隐式播放；媒体与帧调度边界可注入，UI 只在用户明确播放时调用原媒体 play。
 */
import type {VideoSentence} from './sentenceTimeline';

export type SentencePlaybackMode = 'off' | 'loop' | 'pause';

export interface SentencePlaybackState {
  mode: SentencePlaybackMode;
  sentence: VideoSentence | null;
  pausedAtEnd: boolean;
}

export type SentencePlaybackMedia = Pick<HTMLMediaElement,
  'currentTime' | 'paused' | 'seeking' | 'ended' | 'isConnected' | 'play' | 'pause' | 'addEventListener' | 'removeEventListener'>;

export interface SentencePlaybackScheduler {
  request(callback: () => void): number;
  cancel(id: number): void;
}

const browserScheduler: SentencePlaybackScheduler = {
  request: callback => requestAnimationFrame(callback),
  cancel: id => cancelAnimationFrame(id),
};

/** 所有播放动作都沿用原媒体；用户暂停不被循环恢复，用户跳转直接解除控制。 */
export class SentencePlaybackController {
  private mode: SentencePlaybackMode = 'off';
  private sentence: VideoSentence | null = null;
  private pausedAtEnd = false;
  private frame: number | null = null;
  private expectedSeekMs: number | null = null;
  private seekPending = false;
  private boundaryArmed = false;
  private destroyed = false;
  private operation = 0;
  private readonly listeners: Array<[string, () => void]>;

  constructor(
    private readonly media: SentencePlaybackMedia,
    private readonly scheduler: SentencePlaybackScheduler = browserScheduler,
    private readonly onStateChange: (state: SentencePlaybackState) => void = () => {},
  ) {
    this.listeners = [
      ['play', this.handlePlay], ['pause', this.handlePause], ['seeking', this.handleSeeking],
      ['seeked', this.handleSeeked], ['timeupdate', this.tick], ['ended', this.handleEnded],
      ['emptied', this.stop], ['abort', this.stop], ['loadstart', this.stop],
    ];
    this.listeners.forEach(([name, listener]) => this.media.addEventListener(name, listener));
  }

  getState(): SentencePlaybackState {
    return {mode: this.mode, sentence: this.sentence, pausedAtEnd: this.pausedAtEnd};
  }

  /** 选择范围可以跳到起点，但绝不代替用户按下播放。 */
  select(sentence: VideoSentence, mode: SentencePlaybackMode, seekToStart = true): void {
    if (this.destroyed) return;
    if (!Number.isFinite(sentence.startMs) || !Number.isFinite(sentence.endMs)
      || sentence.startMs < 0 || sentence.endMs <= sentence.startMs) {
      this.stop();
      return;
    }
    // 同一字幕时间范围内换句时，迟到的 seeking 事件仍属于已发起的跳转。
    if (!seekToStart && this.expectedSeekMs !== null && this.sentence?.startMs === sentence.startMs
      && this.sentence.endMs === sentence.endMs) {
      this.sentence = sentence;
      if (mode === this.mode) this.notify();
      else this.setMode(mode);
      return;
    }
    this.cancelFrame();
    this.operation += 1;
    this.sentence = sentence;
    this.mode = mode;
    this.pausedAtEnd = false;
    this.expectedSeekMs = null;
    this.seekPending = false;
    this.boundaryArmed = seekToStart || this.isInsideSentence();
    if (seekToStart && !this.seek(sentence.startMs)) return;
    this.notify();
    this.schedule();
  }

  setMode(mode: SentencePlaybackMode): void {
    if (this.destroyed) return;
    this.mode = this.sentence ? mode : 'off';
    this.pausedAtEnd = false;
    this.boundaryArmed = this.seekPending || this.isInsideSentence();
    this.operation += 1;
    this.cancelFrame();
    this.notify();
    this.schedule();
  }

  stop = (): void => {
    this.cancelFrame();
    this.operation += 1;
    this.mode = 'off';
    this.sentence = null;
    this.pausedAtEnd = false;
    this.expectedSeekMs = null;
    this.seekPending = false;
    this.boundaryArmed = false;
    this.notify();
  };

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    this.listeners.forEach(([name, listener]) => this.media.removeEventListener(name, listener));
  }

  private notify(): void {
    this.onStateChange(this.getState());
  }

  private cancelFrame(): void {
    if (this.frame !== null) this.scheduler.cancel(this.frame);
    this.frame = null;
  }

  private schedule(): void {
    if (this.frame === null && this.mode !== 'off' && this.boundaryArmed
      && !this.seekPending
      && !this.media.paused && !this.media.seeking) {
      this.frame = this.scheduler.request(this.handleFrame);
    }
  }

  private handleFrame = (): void => {
    this.frame = null;
    this.tick();
  };

  private seek(milliseconds: number): boolean {
    if (!this.media.seeking && Math.abs(this.media.currentTime * 1000 - milliseconds) < 1) {
      this.expectedSeekMs = null;
      this.seekPending = false;
      return true;
    }
    this.expectedSeekMs = milliseconds;
    try {
      this.media.currentTime = milliseconds / 1000;
      this.seekPending = this.media.seeking || Math.abs(this.media.currentTime * 1000 - milliseconds) > 75;
      return true;
    } catch {
      this.stop();
      return false;
    }
  }

  private handleSeeking = (): void => {
    this.cancelFrame();
    if (this.expectedSeekMs === null || Math.abs(this.media.currentTime * 1000 - this.expectedSeekMs) > 75) this.stop();
  };

  private handleSeeked = (): void => {
    if (this.expectedSeekMs !== null && Math.abs(this.media.currentTime * 1000 - this.expectedSeekMs) > 75) {
      this.stop();
      return;
    }
    this.expectedSeekMs = null;
    this.seekPending = false;
    this.schedule();
  };

  private handlePlay = (): void => {
    if (this.pausedAtEnd) this.stop();
    else this.schedule();
  };

  private handlePause = (): void => {
    this.cancelFrame();
  };

  private handleEnded = (): void => {
    if (this.seekPending) return;
    if (!this.sentence) {
      this.stop();
      return;
    }
    if (this.mode === 'loop' && this.boundaryArmed && this.media.currentTime * 1000 >= this.sentence.endMs) {
      const operation = this.operation;
      if (this.seek(this.sentence.startMs)) {
        void this.media.play().catch(() => {
          if (this.operation === operation) this.stop();
        });
      }
    } else if (this.mode === 'pause' && this.boundaryArmed) {
      this.pausedAtEnd = true;
      this.cancelFrame();
      this.notify();
    } else this.stop();
  };

  private tick = (): void => {
    if (!this.sentence) return;
    if (!this.media.isConnected) {
      this.stop();
      return;
    }
    if (this.mode === 'off' || this.media.paused || this.media.seeking || this.pausedAtEnd) return;
    const currentMs = this.media.currentTime * 1000;
    // currentTime 写入后播放器可能还停在旧画面；等待自己的 seek 落地，不能重复跳转。
    if (this.seekPending && this.expectedSeekMs !== null) {
      if (Math.abs(currentMs - this.expectedSeekMs) > 75) return;
      this.seekPending = false;
    }
    if (!this.boundaryArmed) {
      if (!this.isInsideSentence()) return;
      this.boundaryArmed = true;
    }
    if (!Number.isFinite(currentMs) || currentMs < this.sentence.startMs - 150) {
      this.stop();
      return;
    }
    if (currentMs >= this.sentence.endMs) {
      if (this.mode === 'loop') this.seek(this.sentence.startMs);
      else {
        this.pausedAtEnd = true;
        this.media.pause();
        if (!this.seek(this.sentence.endMs)) return;
        this.notify();
      }
    }
    this.schedule();
  };

  private isInsideSentence(): boolean {
    const currentMs = this.media.currentTime * 1000;
    return !!this.sentence && Number.isFinite(currentMs)
      && currentMs >= this.sentence.startMs && currentMs < this.sentence.endMs;
  }
}
