/**
 * @file entrypoints/offscreen/main.ts
 * 文件职责：启动 Chrome/Edge MV3 与 Firefox/Safari MV2 共用的扩展 DOM 文档运行时。
 * 主要内容：调用 startOffscreenApp 注册图片处理、浏览器内置翻译和 TTS 播放消息。
 * 模块边界：入口本身不持有媒体资源或消息协议，能力探测、路由与释放由 src/app/offscreen 负责。
 */
import {startOffscreenApp} from '@/src/app/offscreen/runtime';

startOffscreenApp();
