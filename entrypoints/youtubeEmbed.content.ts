/**
 * @file entrypoints/youtubeEmbed.content.ts
 * 文件职责：作为 YouTube /embed/ 与普通 HTML 嵌入媒体的超轻量 document_start 引导入口，避免在顶层页面与无媒体 iframe 解析完整字幕包。
 * 主要内容：仅包含零配置、零 Vue 的轻量 URL 与音视频存在检测，确认存在真实媒体后按需请求后台向当前子 frame 注入完整字幕运行时。
 * 模块边界：不静态引入视频字幕、配置 store 或语言包，不产生 CSS 资产，也不读取父 frame DOM。
 */
import {startYoutubeEmbedBootstrap} from '@/src/app/content/youtubeEmbedBootstrap';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: true,
  runAt: 'document_start',
  main: startYoutubeEmbedBootstrap,
});
