/**
 * @file src/features/video-subtitle/background/runtime.ts
 * 文件职责：提供视频字幕后台 handler 的浏览器组合根。
 * 主要内容：注入共享 Offscreen client 与 browser storage，保持业务 handler 可在无浏览器环境穷举测试。
 * 模块边界：只负责平台依赖装配，所有 owner、generation 和消息行为由 handlers.ts 实现。
 */
import {createVideoSubtitleBackgroundHandlers} from './handlers';
import {extensionDomClient} from '@/src/platform/offscreen/extensionClient';
import {createVideoAiSubtitleCacheHandlers} from './cacheHandlers';
import {videoAiSubtitleCacheRepository} from './transcriptionCache';

export function createVideoSubtitleBackgroundRuntime() {
    return [
        ...createVideoSubtitleBackgroundHandlers({
            offscreen: extensionDomClient,
            storage: {
                get: async (key) => browser.storage.local.get(key),
                set: async (value) => { await browser.storage.local.set(value); },
            },
        }),
        ...createVideoAiSubtitleCacheHandlers(videoAiSubtitleCacheRepository),
    ];
}
