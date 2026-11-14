/**
 * @file entrypoints/youtubeEmbedBridge.content.ts
 * 文件职责：在 YouTube iframe 播放器 MAIN world 捕获 timedtext 响应，供 X 分享卡片等嵌入字幕翻译使用。
 * 主要内容：只匹配 YouTube /embed/ 路径并在匹配 frame 中预注入可恢复的字幕网络桥。
 * 模块边界：不处理播放器 UI 或翻译；消息会由对应 embed frame 的 content runtime 校验视频 ID 与负载大小。
 */
import {startYoutubeTimedTextBridgeApp} from '@/src/app/content/youtubeTimedTextBridge';

export default defineContentScript({
  matches: ['*://*.youtube.com/embed/*', '*://youtube.com/embed/*'],
  allFrames: true,
  runAt: 'document_start',
  world: 'MAIN',
  globalName: false,
  main: startYoutubeTimedTextBridgeApp,
});
