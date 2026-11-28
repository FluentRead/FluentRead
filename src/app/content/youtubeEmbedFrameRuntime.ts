/**
 * @file src/app/content/youtubeEmbedFrameRuntime.ts
 * 文件职责：在字幕子 frame 共用入口分派通用 HTML 媒体，并为跨站 YouTube iframe 装配既有字幕 runtime。
 * 主要内容：等待权威配置与语言资源，跟随扩展开关、站点禁用、BFCache 和上下文失效启停字幕与 MAIN-world bridge。
 * 模块边界：YouTube 字幕与桥只接受 youtube.com/embed/{videoId} 子 frame，其他 frame 委托通用媒体组合根，不读取父 frame DOM，也不实现字幕或翻译业务。
 */
import {startHtmlMediaFrameApp} from './htmlMediaFrame';
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import {config, configReady, subscribeConfig} from '@/src/services/config/store';
import {ensureUiLanguageBundle} from '@/src/platform/i18n/uiLanguageBundles';
import {isExtensionDisabledOnSite} from '@/src/features/site-rules/domain';
import {isYouTubeEmbedPage, mountVideoSubtitleTranslation} from '@/src/features/video-subtitle/public';
import {VIDEO_SUBTITLE_FRAME_STARTED_KEY} from '@/src/features/video-subtitle/frameProtocol';
import {setMainWorldBridgesEnabled} from './mainWorldBridgeLifecycle';
import {installContentPageLifecycle} from './pageLifecycle';

export async function startYoutubeEmbedContentApp(ctx: ContentScriptContext): Promise<void> {
    // X loads its share card and the YouTube player in nested frames. The regular
    // content entrypoint is top-frame only, so keep this bootstrap scoped to embeds.
    const frameState = window as unknown as Record<string, unknown>;
    if (window.top === window || ctx.isInvalid || frameState[VIDEO_SUBTITLE_FRAME_STARTED_KEY] === true) return;
    if (!isYouTubeEmbedPage(window.location)) return startHtmlMediaFrameApp(ctx);
    frameState[VIDEO_SUBTITLE_FRAME_STARTED_KEY] = true;

    const lifetime = new AbortController();
    let disposed = false;
    let unmountVideo: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    const stopVideo = () => { unmountVideo?.(); unmountVideo = undefined; };
    const setBridgeEnabled = (enabled: boolean) => setMainWorldBridgesEnabled(document, enabled);
    const cleanup = () => {
        disposed = true;
        delete frameState[VIDEO_SUBTITLE_FRAME_STARTED_KEY];
        stopVideo();
        setBridgeEnabled(false);
        unsubscribe?.();
        unsubscribe = undefined;
        lifetime.abort();
    };
    const lifecycle = installContentPageLifecycle(window, lifetime.signal, {
        suspend: () => { stopVideo(); setBridgeEnabled(false); },
        resume: () => reconcile(),
        dispose: cleanup,
    }, ctx, document);
    const reconcile = () => {
        const enabled = !disposed && !ctx.isInvalid && !lifecycle.isSuspended() && config.on !== false
            && !isExtensionDisabledOnSite(window.location.href, config.disabledExtensionDomains);
        if (!enabled) {
            stopVideo();
            setBridgeEnabled(false);
            return;
        }
        setBridgeEnabled(true);
        if (!unmountVideo) unmountVideo = mountVideoSubtitleTranslation();
    };

    try {
        await configReady;
        if (disposed || ctx.isInvalid) { cleanup(); return; }
        await ensureUiLanguageBundle(config.uiLanguage);
        if (disposed || ctx.isInvalid) { cleanup(); return; }
        unsubscribe = subscribeConfig(nextConfig => {
            reconcile();
            void ensureUiLanguageBundle(nextConfig.uiLanguage).then(reconcile);
        });
        reconcile();
    } catch (error) {
        cleanup();
        throw error;
    }
}
