/**
 * @file src/features/video-subtitle/public.ts
 * 文件职责：定义 YouTube、X、B 站、Udemy、edX、Disney+ 与网页会议字幕的公共入口，并提供设置所需的本地模型与缓存契约；MAIN-world 桥由独立 app 入口装配。
 * 主要内容：导出支持页面判断、字幕挂载，以及 Tiny/Base/Small 模型选项、默认推荐模型、缓存状态键与查询消息、配置归一化函数和字幕缓存管理消息常量。
 * 模块边界：该 barrel 不执行自动挂载或模型下载，也不暴露内部 DOM 常量；应用层决定启停，桥、识别与 UI 各自管理资源清理。
 */
export {mountVideoSubtitleTranslation} from './content/runtime';
export {isSupportedVideoPage} from './content/ui';

export {
    VIDEO_LOCAL_TRANSCRIPTION_MODELS,
    VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY,
    VIDEO_LOCAL_TRANSCRIPTION_STATE_MESSAGE,
    normalizeVideoLocalTranscriptionModels,
    VIDEO_LOCAL_TRANSCRIPTION_RECOMMENDED_MODEL,
} from './transcription';

export type {VideoLocalTranscriptionModel} from './transcription';
export {
    VIDEO_AI_SUBTITLE_CACHE_CLEAR_MESSAGE,
    VIDEO_AI_SUBTITLE_CACHE_STATS_MESSAGE,
} from './transcriptionCache';
