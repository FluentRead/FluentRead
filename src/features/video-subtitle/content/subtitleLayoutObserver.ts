/**
 * @file src/features/video-subtitle/content/subtitleLayoutObserver.ts
 * 文件职责：拥有字幕布局的尺寸、同视频原生控件显隐和结构订阅，并将重排合并到单个动画帧。
 * 主要内容：移动控件观察只在验证后的同视频范围，排除自有字幕/菜单变更，仅响应学习面板宿主的挂载和关闭；重绑、关闭和销毁解除观察并取消未执行帧。
 * 模块边界：只调度注入的布局回调，不读取字幕内容或配置，不修改宿主/媒体状态。
 */
import {getYoutubeSubtitleControlsScope, YOUTUBE_SUBTITLE_CONTROLS_SELECTOR} from './youtubeControlsScope';

export function createSubtitleLayoutObserver(onLayout: () => void, isYoutubePage: () => boolean) {
  let destroyed = false;
  let layoutPlayer: HTMLElement | null = null;
  let layoutVideo: HTMLVideoElement | null = null;
  let layoutControlsScope: HTMLElement | null = null;
  let layoutControls: HTMLElement[] = [];
  let layoutFrame: number | undefined;
  const scheduleSubtitleLayout = () => {
    if (destroyed || layoutFrame !== undefined) return;
    layoutFrame = window.requestAnimationFrame(() => {
      layoutFrame = undefined;
      if (destroyed) return;
      onLayout();
    });
  };
  const layoutObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleSubtitleLayout) : null;
  // 移动端底控在播放器的兄弟分支中，显隐不改变 video 尺寸；只订阅同视频范围，忽略自有字幕/菜单写入。
  const controlsObserver = new MutationObserver(records => {
    const scope = layoutControlsScope;
    if (!scope || !layoutPlayer || !layoutVideo || destroyed) return;
    // 只响应真实学习宿主或其整块自有frame增删，不响应面板内部或字幕自己的布局写入。
    const learningSelector = '#fluent-read-video-learning-panel.fluent-read-video-ui[data-fluent-read-ui="video-subtitle"]';
    if (records.some(record => record.type === 'childList'
      && [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element
        && (node.matches(learningSelector) || node.matches('.fluent-read-video-learning-frame.fluent-read-video-ui[data-fluent-read-ui="video-subtitle"]')
          && node.querySelector(learningSelector))))) scheduleSubtitleLayout();
    const ownUi = (node: Node) => node instanceof Element && Boolean(node.closest('.fluent-read-video-ui'));
    const relevant = records.filter(record => !ownUi(record.target)
      && (record.type === 'attributes' || [...record.addedNodes, ...record.removedNodes].some(node => !ownUi(node))));
    if (!relevant.length) return;
    // 容器重绑或新增第二个视频后立即收回旧订阅，避免继续读取其它视频的控件。
    if (getYoutubeSubtitleControlsScope(layoutPlayer, layoutVideo) !== scope) {
      observeSubtitleLayout(layoutPlayer, layoutVideo);
      return;
    }
    const currentControls = Array.from(scope.querySelectorAll<HTMLElement>(YOUTUBE_SUBTITLE_CONTROLS_SELECTOR)).filter(node => !ownUi(node));
    const controls = [...layoutControls, ...currentControls];
    const related = (node: Node) => controls.some(control => node === control || node.contains(control) || control.contains(node));
    const changed = relevant.some(record => record.type === 'attributes' ? related(record.target)
      : [...record.addedNodes, ...record.removedNodes].some(node => !ownUi(node) && related(node)));
    layoutControls = currentControls;
    if (changed) scheduleSubtitleLayout();
  });
  const observeSubtitleLayout = (player: HTMLElement | null, video: HTMLVideoElement | null) => {
    const scope = player && video && isYoutubePage() ? getYoutubeSubtitleControlsScope(player, video) : null;
    if (layoutPlayer === player && layoutVideo === video && layoutControlsScope === scope) return;
    layoutObserver?.disconnect();
    controlsObserver.disconnect();
    layoutPlayer = player;
    layoutVideo = video;
    layoutControlsScope = scope;
    layoutControls = scope ? Array.from(scope.querySelectorAll<HTMLElement>(YOUTUBE_SUBTITLE_CONTROLS_SELECTOR)) : [];
    if (player) layoutObserver?.observe(player);
    if (video) layoutObserver?.observe(video);
    if (scope) controlsObserver.observe(scope, {subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'id']});
    if (player && video) scheduleSubtitleLayout();
    else if (layoutFrame !== undefined) {
      window.cancelAnimationFrame(layoutFrame);
      layoutFrame = undefined;
    }
  };
  return {schedule: scheduleSubtitleLayout, observe: observeSubtitleLayout, destroy() {
    destroyed = true; layoutObserver?.disconnect(); controlsObserver.disconnect();
    if (layoutFrame !== undefined) window.cancelAnimationFrame(layoutFrame);
    layoutFrame = undefined; layoutPlayer = null; layoutVideo = null; layoutControlsScope = null; layoutControls = [];
  }};
}
