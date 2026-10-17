/**
 * @file src/features/video-subtitle/content/youtubeControlsScope.ts
 * 文件职责：只读确定 YouTube 字幕避让控件所属的同视频范围。
 * 主要内容：移动端仅允许扩展到已知 player-container 容器，并验证它与当前播放器共享唯一 video；同范围收集顶部、中部、底部和进度控件，桌面及身份不明确时保留播放器范围。
 * 模块边界：只提供查询范围和原生控件选择器，不改变播放器定位、菜单挂载、宿主样式或媒体状态。
 */

export const YOUTUBE_SUBTITLE_CONTROLS_SELECTOR = '.ytp-chrome-bottom, .player-controls-bottom, .ytm-player-controls, .ytp-right-controls, .player-controls-top, .player-controls-middle-core-buttons, player-middle-controls.player-controls-middle, .ytPlayerProgressBarDragContainer';

/** 移动 YouTube 将控件放在 movie_player 外；不能因此把其他视频或整页纳入字幕安全区。 */
export function getYoutubeSubtitleControlsScope(player: HTMLElement, video: HTMLVideoElement | null = player.querySelector('video')): HTMLElement {
  if (!video || !player.contains(video) || !player.matches('div#movie_player.html5-video-player.ytp-mweb-player')) return player;
  const scope = player.closest<HTMLElement>('div#player-container-id.player-container');
  if (!scope) return player;
  const videos = scope.querySelectorAll('video');
  return videos.length === 1 && videos[0] === video ? scope : player;
}
