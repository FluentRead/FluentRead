/**
 * @file entrypoints/bilibiliCaptionBridge.content.ts
 * 文件职责：在 B 站 MAIN 世界预装只读播放器身份桥，支持首页经 SPA 进入视频。
 * 主要内容：使用锁定 WXT 版本的 MAIN world 和 document_start 声明，交由 app 组合启动。
 * 模块边界：仅声明浏览器入口，不读取账号、字幕或扩展配置。
 */
import {startBilibiliCaptionBridgeApp} from '@/src/app/content/bilibiliCaptionBridge';
export default defineContentScript({
    matches: ['https://www.bilibili.com/*', 'https://bilibili.com/*'],
    runAt: 'document_start', world: 'MAIN', globalName: false,
    main: startBilibiliCaptionBridgeApp,
});
