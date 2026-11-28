/**
 * @file src/features/video-subtitle/frameProtocol.ts
 * 文件职责：定义视频字幕子 frame 按需注入协议的共享消息名、脚本路径与隔离世界幂等启动标记。
 * 主要内容：导出轻量引导脚本与后台注入处理器共用的消息类型常量、运行时内容脚本相对路径、单次启动状态键及请求响应类型契约。
 * 模块边界：仅声明协议常量与类型接口，不包含浏览器 API 调用、DOM 操作或业务状态；供 app/content 与 app/background 单向复用。
 */
export const VIDEO_SUBTITLE_FRAME_INJECT_MESSAGE = 'injectVideoSubtitleFrame' as const;
export const VIDEO_SUBTITLE_FRAME_SCRIPT = 'content-scripts/videoSubtitleFrame.js' as const;
export const VIDEO_SUBTITLE_FRAME_STARTED_KEY = '__fluentReadVideoSubtitleFrameStarted' as const;

export interface VideoSubtitleFrameInjectRequest {
    readonly type: typeof VIDEO_SUBTITLE_FRAME_INJECT_MESSAGE;
}

export interface VideoSubtitleFrameInjectResponse {
    readonly injected: boolean;
    readonly error?: string;
    readonly retryable?: boolean;
}
