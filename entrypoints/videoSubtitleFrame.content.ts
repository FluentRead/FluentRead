/**
 * @file entrypoints/videoSubtitleFrame.content.ts
 * 文件职责：作为 YouTube /embed/ 与通用 HTML 音视频子 frame 的按需运行时内容脚本，仅由后台在确认媒体存在后注入目标 frame。
 * 主要内容：使用 WXT runtime 注册模式生成独立内容脚本产物但不写入 manifest.content_scripts，复用既有字幕组合根与完整页面生命周期。
 * 模块边界：不主动匹配任意网页；由 youtubeEmbed 轻量引导入口按需请求后台注入，并在隔离世界保持幂等单次启动。
 */
import {startYoutubeEmbedContentApp} from '@/src/app/content/youtubeEmbedFrameRuntime';

export default defineContentScript({
  registration: 'runtime',
  cssInjectionMode: 'manual',
  // 同步返回 undefined，避免 MV2 tabs.executeScript 等待长生命周期异步启动或在 Safari 中序列化 Promise 失败。
  main: (ctx) => {
    void startYoutubeEmbedContentApp(ctx).catch((error) => {
      if (!ctx.isInvalid) console.warn('[FluentRead] 视频字幕子 frame 启动失败', error);
    });
  },
});
