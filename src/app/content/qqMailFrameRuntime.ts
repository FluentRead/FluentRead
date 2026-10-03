/**
 * @file src/app/content/qqMailFrameRuntime.ts
 * 文件职责：为受支持邮箱的正文 frame 组装翻译，并把全文手势交给顶层会话。
 * 主要内容：QQ 旧版与网易免费邮箱各自使用受限消息协议，共享无凭据会话快照、样式和键盘生命周期。
 * 模块边界：只在经过后台认证的阅读 frame 激活，不挂载悬浮球等顶层 UI；翻译请求与异步状态由共享 feature 承担。
 */
import {installContentPageLifecycle} from './pageLifecycle';
import {ensureContentFeatureMounted} from './featureLifecycle';
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import {config, configReady, subscribeConfig} from '@/src/services/config/store';
import {ensureUiLanguageBundle} from '@/src/platform/i18n/uiLanguageBundles';
import {addRuntimeMessageListener} from '@/src/platform/browser/runtimeMessages';
import {constants} from '@/src/core/config/constants';
import {isExtensionDisabledOnSite} from '@/src/features/site-rules/domain';
import {createFrameSessionController} from '@/src/features/full-page-translation/content/frameSession';
import {isQqMailLegacyTopUrl, isQqMailReadmailUrl} from '@/src/features/full-page-translation/qqMailFrames';
import {
    isNeteaseMailChildUrl, isNeteaseMailReadUrl, isNeteaseMailTopUrl,
    NETEASE_MAIL_FRAME_CHANGED_MESSAGE_TYPE, NETEASE_MAIL_FRAME_COMMAND_MESSAGE_TYPE,
    NETEASE_MAIL_FRAME_REFRESH_MESSAGE_TYPE, NETEASE_MAIL_FRAME_REQUEST_MESSAGE_TYPE,
} from '@/src/features/full-page-translation/neteaseMailFrames';
import {
    autoTranslateEnglishPage, getFullPageTranslationFrameState, cancelPendingHoverTranslation,
    handleTranslation, noteBilingualHostGesture,
    invalidateFullPageTranslationSessionCache, restoreOriginalContent,
    type PageTranslationInvocation,
} from '@/src/features/full-page-translation/public';
import {cancelAllTranslations} from '@/src/app/translation/client';
import {getCenterPoint} from '@/src/shared/geometry/touch';
import {mountHoverTranslationContentFeature} from '@/src/features/hover-translation/public';
import {mountSelectionTranslator, unmountSelectionTranslator} from '@/src/features/selection-translation/public';
import {createContentHotkeyRuntime} from './hotkeyRuntime';
import {mountConfiguredQuickTranslation} from './quickTranslationRuntime';
import {installPageStyles} from './pageStyles';
import {syncBilingualSentenceHighlight} from './bilingualSentenceHighlight';
import {applyCoreTranslationPreferences, createContentSiteAdaptationRuntime} from './siteAdaptationRuntime';

type MailFrameKind = 'qq' | 'netease';
const messageTypes = {
    qq: {changed: 'qqMailFrameChanged', command: 'qqMailFrameCommand', refresh: 'qqMailFrameRefresh', request: 'qqMailFrameRequest'},
    netease: {changed: NETEASE_MAIL_FRAME_CHANGED_MESSAGE_TYPE, command: NETEASE_MAIL_FRAME_COMMAND_MESSAGE_TYPE,
        refresh: NETEASE_MAIL_FRAME_REFRESH_MESSAGE_TYPE, request: NETEASE_MAIL_FRAME_REQUEST_MESSAGE_TYPE},
} as const;

/** 顶层消息仅通过扩展后台到达；页面事件只提示读取真实会话，不能设置快照。 */
function installMailTopFrameBridge(kind: MailFrameKind, isEnabled: () => boolean, signal: AbortSignal): ((invocation?: PageTranslationInvocation) => void) | undefined {
    if (!(kind === 'qq' ? isQqMailLegacyTopUrl(window.location.href) : isNeteaseMailTopUrl(window.location.href))) return;
    const messages = messageTypes[kind];
    const available = () => isEnabled() && (kind === 'qq' || isNeteaseMailReadUrl(window.location.href));
    const notify = () => {
        try { void browser.runtime.sendMessage({type: messages.changed}).catch(() => undefined); }
        catch { /* 扩展更新使 runtime 同步失效时，文档恢复仍须完成。 */ }
    };
    const toggle = (invocation?: PageTranslationInvocation) => {
        if (!available()) return;
        const current = getFullPageTranslationFrameState();
        const snapshot = current.translationConfig;
        const sameProfile = invocation && snapshot && Object.entries(invocation).every(([key, value]) =>
            value === (key === 'fullPageMode' ? current.fullPageMode : key === 'scope' ? current.scope : snapshot[key as keyof typeof snapshot]));
        const stop = current.sessionId !== null && (!invocation || sameProfile);
        restoreOriginalContent();
        if (!stop) autoTranslateEnglishPage(invocation);
    };
    const listener = (message: any, sender: any, respond: (value: unknown) => void): boolean => {
        if (message?.type !== messages.command || sender?.id !== browser.runtime.id) return false;
        if (message.action !== 'state' && message.action !== 'toggle') return false;
        if (message.action === 'toggle') toggle(message.invocation);
        respond({...getFullPageTranslationFrameState(), enabled: available()});
        return true;
    };
    const removeMessageListener = addRuntimeMessageListener(browser.runtime, listener);
    signal.addEventListener('abort', removeMessageListener, {once: true});
    document.addEventListener('fluentread-translation-started', notify, {signal});
    document.addEventListener('fluentread-translation-ended', notify, {signal});
    if (kind === 'netease') {
        const routeChanged = () => {
            if (!isNeteaseMailReadUrl(window.location.href)) restoreOriginalContent();
            notify();
        };
        window.addEventListener('hashchange', routeChanged, {signal});
        document.addEventListener('fluentread-route-change', routeChanged, {signal});
    }
    notify();
    return toggle;
}

export function installQqMailTopFrameBridge(isEnabled: () => boolean, signal: AbortSignal): ((invocation?: PageTranslationInvocation) => void) | undefined {
    return installMailTopFrameBridge('qq', isEnabled, signal);
}

export function installNeteaseMailTopFrameBridge(isEnabled: () => boolean, signal: AbortSignal): ((invocation?: PageTranslationInvocation) => void) | undefined {
    return installMailTopFrameBridge('netease', isEnabled, signal);
}

/** 子 frame 先读取顶层授权状态，再挂载手势；未匹配的顶层或子页面没有 UI 和输入监听器。 */
async function startMailFrameApp(ctx: ContentScriptContext, kind: MailFrameKind): Promise<void> {
    if (window.top === window) return;
    const readTopHref = () => {
        if (kind === 'qq') return '';
        try { return window.top?.location.href ?? ''; } catch { return ''; }
    };
    const topHref = readTopHref();
    if (kind === 'qq' ? !isQqMailReadmailUrl(window.location.href)
        : !isNeteaseMailChildUrl(window.location.href, topHref)) return;
    const messages = messageTypes[kind];
    const siteHref = () => kind === 'qq' ? window.location.href : readTopHref() || topHref;
    const isReadableFrame = () => kind === 'qq' || (isNeteaseMailReadUrl(readTopHref())
        && document.designMode !== 'on' && document.body?.isContentEditable !== true
        && !/editor|compose|write|login|urs/iu.test(`${window.frameElement?.id ?? ''} ${window.frameElement?.className ?? ''}`));
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
    let selectionMountGeneration = 0;
    const enabled = () => !disposed && !pageLifecycle.isSuspended() && config.on !== false
        && isReadableFrame()
        && !isExtensionDisabledOnSite(siteHref(), config.disabledExtensionDomains);
    const toggle = (invocation?: PageTranslationInvocation) => {
        if (!enabled() || !authorized) return;
        try {
            void browser.runtime.sendMessage({type: messages.request, action: 'toggle', ...(invocation ? {invocation} : {})})
                .then(() => controller.refresh()).catch(() => controller.suspend());
        } catch { controller.suspend(); }
    };
    const hotkeys = createContentHotkeyRuntime(() => !enabled() || !authorized,
        {toggleFullPage: toggle, selectionAvailable: kind === 'netease'});
    const restore = () => { cancelPendingHoverTranslation(); restoreOriginalContent(); cancelAllTranslations(); };
    const syncSelectionTranslator = () => {
        if (kind !== 'netease' || !activation) return;
        const generation = ++selectionMountGeneration;
        if (config.disableSelectionTranslator === true || config.selectionTranslatorMode === 'disabled') {
            unmountSelectionTranslator();
            return;
        }
        const currentActivation = activation;
        void ensureContentFeatureMounted({
            mount: () => mountSelectionTranslator(ctx),
            isMounted: () => Boolean(document.getElementById('fluent-read-selection-translator-container')),
            isStillDesired: () => activation === currentActivation && authorized && enabled()
                && selectionMountGeneration === generation
                && (config.disableSelectionTranslator !== true && config.selectionTranslatorMode !== 'disabled'),
        }).catch(() => {
            if (activation === currentActivation && selectionMountGeneration === generation) unmountSelectionTranslator();
        });
    };
    const setAvailable = (available: boolean) => {
        authorized = available;
        if (!available) {
            selectionMountGeneration += 1;
            activation?.abort(); activation = null;
            if (kind === 'netease') unmountSelectionTranslator();
            removeStyles?.(); removeStyles = null;
            syncBilingualSentenceHighlight(document, false);
            return;
        }
        if (activation) { syncSelectionTranslator(); return; }
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
        syncSelectionTranslator();
        mountConfiguredQuickTranslation(config, hotkeys, () => !enabled() || !authorized, activation.signal,
            () => { resetHover(); resetFull(); }, toggle);
    };
    const controller = createFrameSessionController({
        readState: () => browser.runtime.sendMessage({type: messages.request, action: 'state'}),
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
        if (message?.type === messages.refresh && (kind === 'netease' || enabled())) void controller.refresh();
        if (message?.type === 'translationCacheCleared') invalidateFullPageTranslationSessionCache();
        return false;
    };
    const siteAdaptation = createContentSiteAdaptationRuntime(
        config.siteAdaptation, new URL(siteHref()), () => controller.suspend());
    document.addEventListener('fluentread-route-change', () => {
        if (siteAdaptation.routeChanged(new URL(siteHref())) && enabled()) void controller.refresh();
    }, {signal: lifetime.signal});
    const removeMessageListener = addRuntimeMessageListener(browser.runtime, listener);
    applyCoreTranslationPreferences(config);
    const unsubscribe = subscribeConfig(() => {
        applyCoreTranslationPreferences(config);
        siteAdaptation.update(config.siteAdaptation, new URL(siteHref()));
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

export function startQqMailFrameApp(ctx: ContentScriptContext): Promise<void> {
    return startMailFrameApp(ctx, 'qq');
}

export function startNeteaseMailFrameApp(ctx: ContentScriptContext): Promise<void> {
    return startMailFrameApp(ctx, 'netease');
}
