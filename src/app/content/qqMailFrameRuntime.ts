/**
 * @file src/app/content/qqMailFrameRuntime.ts
 * 文件职责：为旧版 QQ 邮箱 readmail 子页面组装悬停翻译，并把全文手势交给顶层会话。
 * 主要内容：绑定受限后台桥、无凭据会话快照、公共样式与键盘生命周期，按配置和页面离开释放子页面翻译。
 * 模块边界：只在经过后台认证的旧版 QQ 邮件 frame 激活，不挂载悬浮球等顶层 UI；候选算法、请求和异步状态仲裁分别由共享 feature 承担。
 */
import {installContentPageLifecycle} from './pageLifecycle';
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import {config, configReady, subscribeConfig} from '@/src/services/config/store';
import {constants} from '@/src/core/config/constants';
import {isExtensionDisabledOnSite} from '@/src/features/site-rules/domain';
import {createFrameSessionController} from '@/src/features/full-page-translation/content/frameSession';
import {isQqMailLegacyTopUrl, isQqMailReadmailUrl} from '@/src/features/full-page-translation/qqMailFrames';
import {
    autoTranslateEnglishPage, getFullPageTranslationFrameState,
    invalidateFullPageTranslationSessionCache, restoreOriginalContent,
    type PageTranslationInvocation,
} from '@/src/features/full-page-translation/public';
import {cancelAllTranslations} from '@/src/app/translation/client';
import {getCenterPoint} from '@/src/shared/geometry/touch';
import {cancelPendingHoverTranslation, handleTranslation, mountHoverTranslationContentFeature, noteBilingualHostGesture} from './features';
import {createContentHotkeyRuntime} from './hotkeyRuntime';
import {mountConfiguredQuickTranslation} from './quickTranslationRuntime';
import {installPageStyles} from './pageStyles';
import {syncBilingualSentenceHighlight} from './bilingualSentenceHighlight';
import {createContentSiteAdaptationRuntime} from './siteAdaptationRuntime';

/** 顶层消息仅通过扩展后台到达；页面事件只提示读取真实会话，不能设置快照。 */
export function installQqMailTopFrameBridge(isEnabled: () => boolean, signal: AbortSignal): ((invocation?: PageTranslationInvocation) => void) | undefined {
    if (!isQqMailLegacyTopUrl(window.location.href)) return;
    const notify = () => {
        try { void browser.runtime.sendMessage({type: 'qqMailFrameChanged'}).catch(() => undefined); }
        catch { /* 扩展更新使 runtime 同步失效时，文档恢复仍须完成。 */ }
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
        if (message?.type !== 'qqMailFrameCommand' || sender?.id !== browser.runtime.id) return false;
        if (message.action !== 'state' && message.action !== 'toggle') return false;
        if (message.action === 'toggle') toggle(message.invocation);
        respond({...getFullPageTranslationFrameState(), enabled: isEnabled()});
        return true;
    };
    browser.runtime.onMessage.addListener(listener);
    signal.addEventListener('abort', () => browser.runtime.onMessage.removeListener(listener), {once: true});
    document.addEventListener('fluentread-translation-started', notify, {signal});
    document.addEventListener('fluentread-translation-ended', notify, {signal});
    notify();
    return toggle;
}

/** 子 frame 先读取顶层授权状态，再挂载手势；未匹配的顶层或子页面没有 UI 和输入监听器。 */
export async function startQqMailFrameApp(ctx: ContentScriptContext): Promise<void> {
    if (window.top === window || !isQqMailReadmailUrl(window.location.href)) return;
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
    if (ctx.isInvalid || disposed) { cleanup(); return; }
    let activation: AbortController | null = null;
    let removeStyles: (() => void) | null = null;
    let authorized = false;
    const enabled = () => !disposed && !pageLifecycle.isSuspended() && config.on !== false
        && !isExtensionDisabledOnSite(window.location.href, config.disabledExtensionDomains);
    const toggle = (invocation?: PageTranslationInvocation) => {
        if (!enabled() || !authorized) return;
        try {
            void browser.runtime.sendMessage({type: 'qqMailFrameRequest', action: 'toggle', ...(invocation ? {invocation} : {})})
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
        syncBilingualSentenceHighlight(document, config.bilingualSentenceHighlightEnabled === true);
        const resetHover = mountHoverTranslationContentFeature({
            config, constants, document, window, navigator, getCenterPoint,
            isSiteDisabled: () => !enabled() || !authorized,
            handleTranslation, noteBilingualHostGesture, cancelPendingHoverTranslation,
            hasActiveSelectionTranslationCandidate: hotkeys.hasActiveSelectionTranslationCandidate,
            getConfiguredSelectionHotkey: hotkeys.getConfiguredSelectionHotkey,
            getCustomSelectionHotkey: () => config.customSelectionTranslatorHotkey,
            matchesSelectionTranslatorShortcut: hotkeys.matchesSelectionTranslatorShortcut,
            shouldReserveSelectionShortcut: hotkeys.shouldReserveSelectionShortcut,
        }, activation.signal);
        const resetFull = hotkeys.installFloatingBallHotkey(activation.signal);
        mountConfiguredQuickTranslation(config, hotkeys, () => !enabled() || !authorized, activation.signal,
            () => { resetHover(); resetFull(); }, toggle);
    };
    const controller = createFrameSessionController({
        readState: () => browser.runtime.sendMessage({type: 'qqMailFrameRequest', action: 'state'}),
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
        if (message?.type === 'qqMailFrameRefresh' && enabled()) void controller.refresh();
        if (message?.type === 'translationCacheCleared') invalidateFullPageTranslationSessionCache();
        return false;
    };
    const siteAdaptation = createContentSiteAdaptationRuntime(
        config.siteAdaptation, new URL(window.location.href), () => controller.suspend());
    document.addEventListener('fluentread-route-change', () => {
        if (siteAdaptation.routeChanged(new URL(window.location.href)) && enabled()) void controller.refresh();
    }, {signal: lifetime.signal});
    browser.runtime.onMessage.addListener(listener);
    const unsubscribe = subscribeConfig(() => {
        siteAdaptation.update(config.siteAdaptation, new URL(window.location.href));
        syncBilingualSentenceHighlight(document, enabled() && authorized && config.bilingualSentenceHighlightEnabled === true);
        if (!enabled()) controller.suspend();
        else void controller.refresh();
    });
    cleanup = () => {
        if (lifetime.signal.aborted) return;
        disposed = true; lifetime.abort(); controller.dispose(); unsubscribe();
        browser.runtime.onMessage.removeListener(listener);
    };
    if (enabled()) await controller.refresh();
}
