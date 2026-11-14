/**
 * @file entrypoints/youtubeEmbed.content.ts
 * 文件职责：在 X 卡片等页面中的 YouTube /embed/ 子 frame 挂载 FluentRead 视频字幕功能。
 * 主要内容：只为嵌入播放器启动视频字幕 runtime，并跟随扩展总开关、站点禁用和页面生命周期启停。
 * 模块边界：不在 X 帖子页重复启动完整内容 runtime，也不读取父 frame DOM。
 */
import {startYoutubeEmbedContentApp} from '@/src/app/content/youtubeEmbedFrameRuntime';

export default defineContentScript({
  matches: ['*://*.youtube.com/embed/*', '*://youtube.com/embed/*'],
  allFrames: true,
  runAt: 'document_start',
  cssInjectionMode: 'ui',
  main: startYoutubeEmbedContentApp,
});
