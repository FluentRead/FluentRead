/**
 * @file src/app/content/youtubeEmbedFrameRuntime.ts
 * 文件职责：在跨站 YouTube iframe 中仅装配现有视频字幕 runtime，不重复启动网页翻译等顶层功能。
 * 主要内容：等待权威配置与语言资源，跟随扩展开关、站点禁用、BFCache 和上下文失效启停字幕与 MAIN-world bridge。
 * 模块边界：只接受 youtube.com/embed/{videoId} 子 frame，经视频公共入口装配，不载入其他顶层功能的聚合模块；不读取父 frame DOM，也不实现字幕或翻译业务。
 */
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import {config, configReady, subscribeConfig} from '@/src/services/config/store';
import {ensureUiLanguageBundle} from '@/src/platform/i18n/uiLanguageBundles';
import {isExtensionDisabledOnSite} from '@/src/features/site-rules/domain';
import {isYouTubeEmbedPage, mountVideoSubtitleTranslation} from '@/src/features/video-subtitle/public';
import {setMainWorldBridgesEnabled} from './mainWorldBridgeLifecycle';
import {installContentPageLifecycle} from './pageLifecycle';

export async function startYoutubeEmbedContentApp(ctx: ContentScriptContext): Promise<void> {
    // X loads its share card and the YouTube player in nested frames. The regular
    // content entrypoint is top-frame only, so keep this bootstrap scoped to embeds.
    if (window.top === window || !isYouTubeEmbedPage(window.location) || ctx.isInvalid) return;

    const lifetime = new AbortController();
    let disposed = false;
    let unmountVideo: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    const stopVideo = () => { unmountVideo?.(); unmountVideo = undefined; };
    const setBridgeEnabled = (enabled: boolean) => setMainWorldBridgesEnabled(document, enabled);
    const cleanup = () => {
        disposed = true;
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

    await configReady;
    if (disposed || ctx.isInvalid) { cleanup(); return; }
    await ensureUiLanguageBundle(config.uiLanguage);
    if (disposed || ctx.isInvalid) { cleanup(); return; }
    unsubscribe = subscribeConfig(nextConfig => {
        reconcile();
        void ensureUiLanguageBundle(nextConfig.uiLanguage).then(reconcile);
    });
    reconcile();
}
