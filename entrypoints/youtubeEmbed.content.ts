/**
 * @file entrypoints/youtubeEmbed.content.ts
 * 文件职责：为 YouTube /embed/ 与普通 HTML 嵌入媒体共用字幕子 frame 入口，避免重复打包字幕系统。
 * 主要内容：组合根分别核验 YouTube 与通用 frame；普通 frame 只在发现媒体后加载运行时，并跟随配置与页面生命周期启停。
 * 模块边界：不在 X 帖子页重复启动完整内容 runtime，也不读取父 frame DOM。
 */
import {startYoutubeEmbedContentApp} from '@/src/app/content/youtubeEmbedFrameRuntime';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: true,
  runAt: 'document_start',
  cssInjectionMode: 'ui',
  main: startYoutubeEmbedContentApp,
});
