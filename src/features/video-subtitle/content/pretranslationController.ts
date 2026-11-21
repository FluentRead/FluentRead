/**
 * @file src/features/video-subtitle/content/pretranslationController.ts
 * 文件职责：管理视频字幕预取的有界计时器和原生轨道就绪监听。
 * 主要内容：普通播放事件合并为 120ms 一次预取，轨道加载、加入或换句时立即通知运行时并预取；换句不重绑监听，轨道增删只更新变化项，更换视频和卸载时释放轨道、媒体监听器与计时器。
 * 模块边界：只观察注入的 video 并调用回调，不读取全局配置、不选择字幕文本，也不调用翻译服务。
 */
export class VideoPretranslationController {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private video: HTMLMediaElement | null = null;
  private tracks: TextTrack[] = [];
  private destroyed = false;
  constructor(private readonly prime: () => void, private readonly onTrackChange: () => void) {}

  schedule(immediate = false): void {
    if (this.destroyed) return;
    if (immediate) { this.clear(); this.prime(); return; }
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.prime(); }, 120);
  }
  clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
  observe(video: HTMLMediaElement | null): void {
    if (this.destroyed || this.video === video) return;
    this.video?.removeEventListener('load', this.handleLoad, true);
    for (const type of ['addtrack', 'removetrack', 'change']) this.video?.textTracks.removeEventListener(type, this.handleChange);
    this.tracks.forEach(track => track.removeEventListener('cuechange', this.handleCueChange));
    this.tracks = [];
    this.video = video;
    video?.addEventListener('load', this.handleLoad, true);
    for (const type of ['addtrack', 'removetrack', 'change']) video?.textTracks.addEventListener(type, this.handleChange);
    this.syncTracks();
  }
  destroy(): void {
    this.clear();
    this.observe(null);
    this.destroyed = true;
  }
  private syncTracks(): void {
    const next = Array.from(this.video?.textTracks || []).filter(track => track.kind === 'captions' || track.kind === 'subtitles');
    const previousSet = new Set(this.tracks), nextSet = new Set(next);
    this.tracks.forEach(track => {if (!nextSet.has(track)) track.removeEventListener('cuechange', this.handleCueChange);});
    next.forEach(track => {if (!previousSet.has(track)) track.addEventListener('cuechange', this.handleCueChange);});
    this.tracks = next;
  }
  private readonly handleCueChange = () => {
    this.onTrackChange();
    this.schedule(true);
  };
  private readonly handleChange = () => {
    this.syncTracks();
    this.handleCueChange();
  };
  private readonly handleLoad = (event: Event) => {
    const track = event.target as HTMLTrackElement | null;
    if (track?.tagName === 'TRACK' && track.parentElement === this.video) this.handleChange();
  };
}
