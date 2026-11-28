/**
 * @file src/features/video-subtitle/content/youtubeEmbedUrl.ts
 * 文件职责：为 YouTube 内嵌播放器 iframe 提供零依赖的主机与路径识别函数，避免轻量引导入口拉入完整字幕 UI 与配置树。
 * 主要内容：定义 youtube.com 与 youtube-nocookie.com 的共享主机正则，以及仅接受标准 11 位视频 ID 的 /embed/{videoId} 路径判定逻辑。
 * 模块边界：纯字符串与正则判断，不访问 DOM、配置、语言包或浏览器扩展 API；完整字幕 UI 与轻量引导层共用此模块保持判定一致。
 */
export const YOUTUBE_HOST_PATTERN = /(^|\.)youtube(?:-nocookie)?\.com$/i;
const YOUTUBE_EMBED_PATH_PATTERN = /^\/embed\/[\w-]{11}\/?$/u;

/** YouTube iframe 播放器使用独立 /embed/{videoId} 文档（含 youtube-nocookie.com）；只接受真实视频 ID。 */
export function isYouTubeEmbedPage(locationLike: Pick<Location, 'hostname' | 'pathname'> = window.location): boolean {
    return YOUTUBE_HOST_PATTERN.test(locationLike.hostname)
        && YOUTUBE_EMBED_PATH_PATTERN.test(locationLike.pathname);
}
