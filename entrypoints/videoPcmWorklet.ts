/**
 * @file entrypoints/videoPcmWorklet.ts
 * 文件职责：声明本地音视频 PCM AudioWorklet 的独立 WXT 产物。
 * 主要内容：只在用户请求转写后由 AudioContext 加载并注册采集器。
 * 模块边界：不在内容脚本中执行，不加载模型或其他应用组合根。
 */
import {startVideoPcmWorkletApp, type PcmWorkletScope} from '@/src/app/offscreen/videoPcmWorklet';
export default defineUnlistedScript(() => startVideoPcmWorkletApp(globalThis as unknown as PcmWorkletScope));
