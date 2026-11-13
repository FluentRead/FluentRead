/**
 * @file src/app/content/courseCaptionFrame.ts
 * 文件职责：在 edX 的课程子 frame 中仅装配视频字幕，不重复挂载顶层网页功能。
 * 主要内容：等待权威配置与本地语言包，复用配置订阅、站点禁用规则及页面生命周期，暂停、关闭或上下文失效时释放字幕。
 * 模块边界：限定 courses.edx.org 子 frame，不读取父 frame DOM，不实现字幕来源、翻译 provider 或平行配置存储。
 */
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import {config, configReady, subscribeConfig, requestConfigPatch} from '@/src/services/config/store';
import {ensureUiLanguageBundle} from '@/src/platform/i18n/uiLanguageBundles';
import {sendRuntimeMessage} from '@/src/platform/browser/runtimeMessages';
import {translateLegacyText} from '@/src/core/i18n';
import {translateVideoText} from '@/src/services/translation/client';
import {isExtensionDisabledOnSite} from '@/src/features/site-rules/domain';
import {mountPlatformCaptions} from '@/src/features/video-subtitle/content/platformRuntime';
import {sanitizeSubtitleFilename} from '@/src/features/video-subtitle/content/youtubeSubtitleData';
import {downloadTextFile} from '@/src/shared/dom/downloadTextFile';
import {installContentPageLifecycle} from './pageLifecycle';

export async function startCourseCaptionFrameApp(ctx: ContentScriptContext): Promise<void> {
    if (window.top === window || window.location.hostname !== 'courses.edx.org' || ctx.isInvalid) return;
    const lifetime = new AbortController();
    let disposed = false;
    let unmount: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    const stop = () => { unmount?.(); unmount = undefined; };
    const cleanup = () => { disposed = true; stop(); unsubscribe?.(); lifetime.abort(); };
    const lifecycle = installContentPageLifecycle(window, lifetime.signal, {
        suspend: stop, resume: () => reconcile(), dispose: cleanup,
    }, ctx, document);
    const reconcile = () => {
        if (disposed || ctx.isInvalid || lifecycle.isSuspended() || !config.on || !config.videoTranslationEnabled
            || isExtensionDisabledOnSite(window.location.href, config.disabledExtensionDomains)) { stop(); return; }
        if (unmount) return;
        unmount = mountPlatformCaptions({document, window, config, subscribe: subscribeConfig, translate: translateVideoText,
            patch: patch => { void requestConfigPatch(patch, sendRuntimeMessage).catch(() => undefined); },
            label: text => translateLegacyText(text, config.uiLanguage),
            download: (srt, language) => { downloadTextFile(`${sanitizeSubtitleFilename(document.title)}-${sanitizeSubtitleFilename(language)}.srt`, srt, 'application/x-subrip;charset=utf-8'); },
        });
    };
    await configReady;
    if (disposed || ctx.isInvalid) { cleanup(); return; }
    await ensureUiLanguageBundle(config.uiLanguage);
    if (disposed || ctx.isInvalid) { cleanup(); return; }
    unsubscribe = subscribeConfig(() => {
        reconcile();
        void ensureUiLanguageBundle(config.uiLanguage).then(reconcile);
    });
    reconcile();
}
