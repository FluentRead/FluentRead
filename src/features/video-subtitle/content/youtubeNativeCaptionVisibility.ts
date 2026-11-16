/**
 * @file src/features/video-subtitle/content/youtubeNativeCaptionVisibility.ts
 * 文件职责：独立拥有 FluentRead 接管期间 YouTube 播放器原生字幕的隐藏状态。
 * 主要内容：切换隐藏目标时先恢复旧播放器，再隐藏新播放器；空目标和销毁都会恢复宿主字幕。
 * 模块边界：只操作播放器上的 FluentRead 专属 class，不读取配置、不查找播放器，也不管理字幕轨或翻译。
 */
export const VIDEO_NATIVE_CAPTION_HIDDEN_CLASS = 'fluent-read-video-native-caption-hidden';

export function createYoutubeNativeCaptionVisibility() {
  let player: HTMLElement | null = null;

  const sync = (nextPlayer: HTMLElement | null): void => {
    if (player === nextPlayer) return;
    player?.classList.remove(VIDEO_NATIVE_CAPTION_HIDDEN_CLASS);
    player = nextPlayer;
    player?.classList.add(VIDEO_NATIVE_CAPTION_HIDDEN_CLASS);
  };

  return {
    sync,
    destroy(): void {sync(null);},
  };
}
