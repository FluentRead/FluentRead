/**
 * @file src/app/content/bilibiliCaptionBridge.ts
 * 文件职责：为 B 站字幕提供 WXT MAIN 世界组合入口。
 * 主要内容：将当前 window 注入 feature 的只读播放器身份桥。
 * 模块边界：入口不读取配置、不请求字幕或调用翻译，协议与清理属于视频 feature。
 */
import {installBilibiliCaptionBridge} from '@/src/features/video-subtitle/content/bilibiliCaptionBridge';
export const startBilibiliCaptionBridgeApp = () => installBilibiliCaptionBridge(window);
