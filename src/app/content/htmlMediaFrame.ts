/**
 * @file src/app/content/htmlMediaFrame.ts
 * 文件职责：在普通网页的子 frame 中按需装配 HTML 音视频字幕，避免嵌入播放器因顶层文档隔离而漏检。
 * 主要内容：跳过顶层及已有专用字幕适配的站点，遵循权威配置、frame 站点禁用和页面生命周期；发现媒体后才加载字幕运行时，异步加载完成时再次检查所有权，暂停或失效后拒绝迟到挂载。
 * 模块边界：不读取跨域父 frame、不注入 MAIN-world 桥、不启动全文翻译或申请额外权限；实际媒体、模型和 UI 生命周期仍归 video-subtitle。
 */
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import {config, configReady, subscribeConfig} from '@/src/services/config/store';
import {ensureUiLanguageBundle} from '@/src/platform/i18n/uiLanguageBundles';
import {isExtensionDisabledOnSite} from '@/src/features/site-rules/domain';
import {mountWhenHtmlMediaPresent} from '@/src/features/video-subtitle/content/htmlMedia';
import {getCaptionPlatform} from '@/src/features/video-subtitle/content/platforms';
import {installContentPageLifecycle, waitForContentDocument} from './pageLifecycle';

export async function startHtmlMediaFrameApp(ctx: ContentScriptContext): Promise<void> {
    const platform = getCaptionPlatform(window.location);
    if (window.top === window || ctx.isInvalid || !/^https?:$/.test(window.location.protocol)
        || /(^|\.)(youtube\.com|x\.com|twitter\.com)$/i.test(window.location.hostname)
        || (platform && platform !== 'coursera' && platform !== 'vimeo')) return;
    const lifetime = new AbortController();
    let disposed = false;
    let stop: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    const unmount = () => {const previous = stop; stop = undefined; previous?.();};
    const cleanup = () => {disposed = true; unmount(); unsubscribe?.(); unsubscribe = undefined; lifetime.abort();};
    const lifecycle = installContentPageLifecycle(window, lifetime.signal, {suspend: unmount, resume: () => reconcile(), dispose: cleanup}, ctx, document);
    const reconcile = () => {
        if (disposed || ctx.isInvalid || lifecycle.isSuspended() || !config.on || !config.videoTranslationEnabled
            || isExtensionDisabledOnSite(window.location.href, config.disabledExtensionDomains)
            || Boolean(document.referrer && isExtensionDisabledOnSite(document.referrer, config.disabledExtensionDomains))) {unmount(); return;}
        if (stop) return;
        stop = mountWhenHtmlMediaPresent(() => {
            let current = true;
            let dispose: (() => void) | undefined;
            void import('@/src/features/video-subtitle/public').then(module => {
                if (current && !disposed && !ctx.isInvalid) dispose = module.mountVideoSubtitleTranslation();
            }).catch(error => {if (current) console.warn('[FluentRead] HTML 媒体字幕加载失败', error);});
            return () => {current = false; dispose?.();};
        });
    };
    await configReady;
    if (disposed || ctx.isInvalid) {cleanup(); return;}
    await ensureUiLanguageBundle(config.uiLanguage);
    if (disposed || ctx.isInvalid) {cleanup(); return;}
    if (document.readyState === 'loading' && !await waitForContentDocument(document, lifetime.signal)) {cleanup(); return;}
    if (disposed || ctx.isInvalid) {cleanup(); return;}
    unsubscribe = subscribeConfig(reconcile);
    reconcile();
}
