/**
 * @file src/app/content/embeddedFrameRuntime.ts
 * 文件职责：让 OMG! Ubuntu 评论和 Kaggle 笔记本正文 iframe 跟随所属文章的翻译会话。
 * 主要内容：顶层提供无凭据会话快照，受限子 frame 经后台认证后挂载翻译手势、样式与会话控制。
 * 模块边界：不在广告或其他第三方 frame 挂载功能；URL 配对由后台验证，正文候选由共享翻译核心处理。
 */
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import {installContentPageLifecycle} from './pageLifecycle';
import {config, configReady, subscribeConfig} from '@/src/services/config/store';
import {ensureUiLanguageBundle} from '@/src/platform/i18n/uiLanguageBundles';
import {addRuntimeMessageListener} from '@/src/platform/browser/runtimeMessages';
import {constants} from '@/src/core/config/constants';
import {isExtensionDisabledOnSite} from '@/src/features/site-rules/domain';
import {createFrameSessionController} from '@/src/features/full-page-translation/content/frameSession';
import {
    EMBEDDED_FRAME_CHANGED, EMBEDDED_FRAME_COMMAND, EMBEDDED_FRAME_REFRESH,
    EMBEDDED_FRAME_REQUEST, isSupportedEmbeddedFrameUrl, isSupportedEmbeddedTopUrl,
} from '@/src/features/full-page-translation/embeddedFrames';
import {
    autoTranslateEnglishPage, getFullPageTranslationFrameState, cancelPendingHoverTranslation,
    handleTranslation, noteBilingualHostGesture,
    invalidateFullPageTranslationSessionCache, restoreOriginalContent,
    type PageTranslationInvocation,
} from '@/src/features/full-page-translation/public';
import {cancelAllTranslations} from '@/src/app/translation/client';
import {getCenterPoint} from '@/src/shared/geometry/touch';
import {mountHoverTranslationContentFeature} from '@/src/features/hover-translation/public';
import {createContentHotkeyRuntime} from './hotkeyRuntime';
import {mountConfiguredQuickTranslation} from './quickTranslationRuntime';
import {installPageStyles} from './pageStyles';
import {syncBilingualSentenceHighlight} from './bilingualSentenceHighlight';
import {applyCoreTranslationPreferences, createContentSiteAdaptationRuntime} from './siteAdaptationRuntime';

/** 页面事件只提示刷新；frame 必须经后台校验 tab、URL 和 frameId 后读取顶层真实状态。 */
export function installEmbeddedTopFrameBridge(isEnabled: () => boolean, signal: AbortSignal): void {
    if (window.top !== window || !isSupportedEmbeddedTopUrl(window.location.href)) return;
    const notify = () => {
        try { void browser.runtime.sendMessage({type: EMBEDDED_FRAME_CHANGED}).catch(() => undefined); }
        catch { /* 扩展更新后仍允许本页自行恢复。 */ }
    };
    const toggle = (invocation?: PageTranslationInvocation) => {
        if (!isEnabled()) return;
        const current = getFullPageTranslationFrameState();
        const snapshot = current.translationConfig;
        const sameProfile = invocation && snapshot && Object.entries(invocation).every(([key, value]) =>
            value === (key === 'fullPageMode' ? current.fullPageMode : key === 'scope' ? current.scope : snapshot[key as keyof typeof snapshot]));
        const stop = current.sessionId !== null && (!invocation || sameProfile);
        restoreOriginalContent();
        if (!stop) autoTranslateEnglishPage(invocation);
    };
    const listener = (message: any, sender: any, respond: (value: unknown) => void): boolean => {
        if (message?.type !== EMBEDDED_FRAME_COMMAND || sender?.id !== browser.runtime.id ||
            (message.action !== 'state' && message.action !== 'toggle')) return false;
        if (message.action === 'toggle') toggle(message.invocation);
        respond({...getFullPageTranslationFrameState(), enabled: isEnabled()});
        return true;
    };
    const removeMessageListener = addRuntimeMessageListener(browser.runtime, listener);
    signal.addEventListener('abort', removeMessageListener, {once: true});
    document.addEventListener('fluentread-translation-started', notify, {signal});
    document.addEventListener('fluentread-translation-ended', notify, {signal});
    notify();
}

/** 只在专用 content 入口的受限 frame 中安装翻译，不创建悬浮球或顶层菜单。 */
export async function startEmbeddedFrameApp(ctx: ContentScriptContext): Promise<void> {
    if (window.top === window || !isSupportedEmbeddedFrameUrl(window.location.href)) return;
    let disposed = false;
    const lifetime = new AbortController();
    let lifecycleController: ReturnType<typeof createFrameSessionController> | undefined;
    let cleanup = () => { disposed = true; lifetime.abort(); };
    ctx.onInvalidated(() => cleanup());
    const pageLifecycle = installContentPageLifecycle(window, lifetime.signal, {
        suspend: () => lifecycleController?.suspend(),
        resume: () => { void lifecycleController?.refresh(); },
        dispose: () => cleanup(),
    });
    await configReady;
    await ensureUiLanguageBundle(config.uiLanguage);
    if (ctx.isInvalid || disposed) { cleanup(); return; }

    let activation: AbortController | null = null;
    let removeStyles: (() => void) | null = null;
    let authorized = false;
    const enabled = () => !disposed && !pageLifecycle.isSuspended() && config.on !== false &&
        !isExtensionDisabledOnSite(window.location.href, config.disabledExtensionDomains);
    const toggle = (invocation?: PageTranslationInvocation) => {
        if (!enabled() || !authorized) return;
        try {
            void browser.runtime.sendMessage({type: EMBEDDED_FRAME_REQUEST, action: 'toggle',
                ...(invocation ? {invocation} : {})})
                .then(() => controller.refresh()).catch(() => controller.suspend());
        } catch { controller.suspend(); }
    };
    const hotkeys = createContentHotkeyRuntime(() => !enabled() || !authorized,
        {toggleFullPage: toggle, selectionAvailable: false});
    const restore = () => { cancelPendingHoverTranslation(); restoreOriginalContent(); cancelAllTranslations(); };
    const setAvailable = (available: boolean) => {
        authorized = available;
        if (!available) {
            activation?.abort(); activation = null;
            removeStyles?.(); removeStyles = null;
            syncBilingualSentenceHighlight(document, false);
            return;
        }
        if (activation) return;
        activation = new AbortController();
        removeStyles = installPageStyles(ctx);
        syncBilingualSentenceHighlight(document, config.bilingualSentenceHighlightEnabled === true, config.bilingualSentenceHighlightStyle, config.bilingualSentenceHighlightAppearance);
        const resetHover = mountHoverTranslationContentFeature({
            config, constants, document, window, navigator, getCenterPoint,
            isSiteDisabled: () => !enabled() || !authorized,
            handleTranslation, noteBilingualHostGesture, cancelPendingHoverTranslation,
            ...hotkeys.selectionShortcutPorts,
        }, activation.signal);
        const resetFull = hotkeys.installFloatingBallHotkey(activation.signal);
        mountConfiguredQuickTranslation(config, hotkeys, () => !enabled() || !authorized,
            activation.signal, () => { resetHover(); resetFull(); }, toggle);
    };
    const controller = createFrameSessionController({
        readState: () => browser.runtime.sendMessage({type: EMBEDDED_FRAME_REQUEST, action: 'state'}),
        isEnabled: enabled, setAvailable, restore,
        start: (state) => autoTranslateEnglishPage({
            service: state.translationConfig!.service, model: state.translationConfig!.model,
            targetLanguage: state.translationConfig!.targetLanguage, displayMode: state.translationConfig!.displayMode,
            profileId: state.translationConfig!.profileId, fullPageMode: state.fullPageMode, scope: state.scope,
        }, state.translationConfig),
    });
    lifecycleController = controller;
    const listener = (message: any, sender: any): false => {
        if (sender?.id !== browser.runtime.id) return false;
        if (message?.type === EMBEDDED_FRAME_REFRESH && enabled()) void controller.refresh();
        if (message?.type === 'translationCacheCleared') invalidateFullPageTranslationSessionCache();
        return false;
    };
    const siteAdaptation = createContentSiteAdaptationRuntime(
        config.siteAdaptation, new URL(window.location.href), () => controller.suspend());
    document.addEventListener('fluentread-route-change', () => {
        if (siteAdaptation.routeChanged(new URL(window.location.href)) && enabled()) void controller.refresh();
    }, {signal: lifetime.signal});
    const removeMessageListener = addRuntimeMessageListener(browser.runtime, listener);
    applyCoreTranslationPreferences(config);
    const unsubscribe = subscribeConfig(() => {
        applyCoreTranslationPreferences(config);
        siteAdaptation.update(config.siteAdaptation, new URL(window.location.href));
        syncBilingualSentenceHighlight(document, enabled() && authorized && config.bilingualSentenceHighlightEnabled === true, config.bilingualSentenceHighlightStyle, config.bilingualSentenceHighlightAppearance);
        if (!enabled()) controller.suspend();
        else void controller.refresh();
    });
    cleanup = () => {
        if (lifetime.signal.aborted) return;
        disposed = true; lifetime.abort(); controller.dispose(); unsubscribe();
        removeMessageListener();
    };
    if (enabled()) await controller.refresh();
}
