/**
 * @file src/app/offscreen/videoPcmWorklet.ts
 * 文件职责：作为本地字幕音频渲染线程的静态组合入口。
 * 主要内容：向 WXT 入口提供视频 feature 的 PCM 采集器注册函数与专用全局环境类型。
 * 模块边界：不访问离屏文档或配置，不实现混音算法；AudioWorklet 的端口和 AudioContext 生命周期仍由视频采集控制器管理。
 */
export {registerVideoPcmWorklet as startVideoPcmWorkletApp, type PcmWorkletScope} from '@/src/features/video-subtitle/content/video-ai/pcmWorklet';
