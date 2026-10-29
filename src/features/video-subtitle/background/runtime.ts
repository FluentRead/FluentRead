/**
 * @file src/features/video-subtitle/background/runtime.ts
 * 文件职责：提供视频字幕后台 handler 的浏览器组合根。
 * 主要内容：为视频转写和可取消的读音标注注入共享 Offscreen client、扩展身份与 browser storage，保持业务 handler 可在无浏览器环境穷举测试。
 * 模块边界：只负责平台依赖装配，所有 owner、generation 和消息行为由 handlers.ts 实现。
 */
import {createVideoSubtitleBackgroundHandlers} from './handlers';
import {extensionDomClient} from '@/src/platform/offscreen/extensionClient';
import {createVideoAiSubtitleCacheHandlers} from './cacheHandlers';
import {videoAiSubtitleCacheRepository} from './transcriptionCache';
import {config, configReady, getConfigHydrationStatus} from '@/src/services/config/store';
import {createVideoReadingAnnotationHandlers} from './readingAnnotation';

export function createVideoSubtitleBackgroundRuntime() {
    let hydrated = false;
    void configReady.then(() => { hydrated = true; }, () => undefined);
    return [
        ...createVideoReadingAnnotationHandlers({offscreen: extensionDomClient, runtimeId: browser.runtime.id}),
        ...createVideoSubtitleBackgroundHandlers({
            offscreen: extensionDomClient,
            readNativeSettings: () => {
                if (!hydrated || getConfigHydrationStatus() !== 'ready') throw new Error('字幕配置尚未安全加载，请稍后重试');
                return {enabled: config.on && config.videoTranslationEnabled, provider: config.videoTranscriptionProvider,
                    baseUrl: config.videoNativeAsrBaseUrl, sourceLanguage: config.videoSourceLanguage || 'auto'};
            },
            storage: {
                get: async (key) => browser.storage.local.get(key),
                set: async (value) => { await browser.storage.local.set(value); },
            },
        }),
        ...createVideoAiSubtitleCacheHandlers(videoAiSubtitleCacheRepository),
    ];
}
