/**
 * @file src/features/video-subtitle/model-sharing/public.ts
 * 文件职责：向设置功能公开 Whisper 共享目录的用户授权操作。
 * 主要内容：导出目录能力查询、选择、断开和状态类型，保持文件缓存及推理接口在视频功能内部。
 * 模块边界：只重导出共享目录的设置契约，不初始化存储、不装配播放器或执行模型下载。
 */
export {
  chooseSharedVideoAiDirectory,
  disconnectSharedVideoAiDirectory,
  getSharedVideoAiDirectoryStatus,
  supportsSharedVideoAiDirectory,
  type SharedVideoAiDirectoryStatus,
} from '../sharedModelDirectory';
