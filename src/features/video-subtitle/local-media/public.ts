/**
 * @file src/features/video-subtitle/local-media/public.ts
 * 文件职责：暴露本地音视频导入、离线转写会话与双语学习工作台组件的公共契约，隔离内部编排实现。
 * 主要内容：重导出文件格式与边界校验、16 kHz PCM 解码切片、离线转写翻译会话及 LocalMediaTranscriptionPanel 界面组件。
 * 模块边界：纯 barrel 模块，不持有运行时状态或执行副作用；外部 feature 仅通过此公开路径接入本地音视频能力。
 */
export {
    LOCAL_MEDIA_ACCEPT_ATTRIBUTE,
    LOCAL_MEDIA_SUPPORTED_EXTENSIONS,
    MAX_LOCAL_MEDIA_DURATION_SECONDS,
    MAX_LOCAL_MEDIA_FILE_BYTES,
    classifyLocalMediaKind,
    formatMediaBytes,
    formatMediaTimestamp,
    validateLocalMediaFile,
    type LocalMediaExtension,
    type LocalMediaFileLike,
    type LocalMediaKind,
    type LocalMediaValidationErrorCode,
    type LocalMediaValidationResult,
} from './mediaValidation';
export {
    decodeLocalMediaToPcm16k,
    sliceLocalMediaWindows,
    type DecodedLocalMediaPcm,
    type LocalMediaAudioSource,
    type LocalMediaDecodePorts,
    type LocalMediaPcmWindow,
} from './audioDecoder';
export {
    LocalMediaTranscriptionSession,
    buildLocalMediaExport,
    type LocalMediaCue,
    type LocalMediaExportMode,
    type LocalMediaSessionSnapshot,
    type LocalMediaTranscriptionPhase,
    type LocalMediaTranscriptionPorts,
} from './transcriptionService';
export {default as LocalMediaTranscriptionPanel} from './LocalMediaTranscriptionPanel.vue';
