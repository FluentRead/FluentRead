/**
 * @file src/app/content/runtime.ts
 * 文件职责：作为内容脚本应用的顶层 composition root，协调配置就绪、站点规则、公共样式、主世界桥、功能注册表、快捷键和消息监听生命周期。
 * 主要内容：安装内联 page.css，构建输入框与页面 feature registry，按 capability 和配置挂载全文周边、悬浮、划词、区域、图片、视频与写作助手等能力；订阅配置变化并处理停用、往返缓存暂停恢复与销毁。
 * 模块边界：本文件只负责依赖装配和页面激活所有权，不实现具体翻译算法、组件内部状态、provider 请求或配置存储；这些职责分别属于 features、services 与 platform。
 */
import {isWritingPage} from '@/src/core/config/writing';
import {mountWritingAssistant, unmountWritingAssistant, isWritingAssistantMounted} from '@/src/features/writing-assistant/public';
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import {createShadowRootUi} from 'wxt/utils/content-script-ui/shadow-root';
import {constants} from '@/src/core/config/constants';
import {isExtensionDisabledOnSite} from '@/src/features/site-rules/domain';
import {config, configReady, subscribeConfig} from '@/src/services/config/store';
import {cancelAllTranslations} from '@/src/app/translation/client';
import {resetPageTranslationContextCache} from '@/src/services/translation/context';
import {clearLegacyPageTranslationCache} from '@/src/services/translation/legacyPageCache';
import {getCenterPoint} from '@/src/shared/geometry/touch';
import {createContentFeatureRegistry, type ContentFeatureRegistry} from './featureRegistry';
import {createContentHotkeyRuntime} from './hotkeyRuntime';
import {createContentRuntimeMessageHandler, type ContentRuntimeMessageHandler} from './messageRuntime';
import {
    autoTranslateEnglishPage,
    cancelPendingHoverTranslation,
    createInputTranslationContentFeature,
    handleTranslation,
    inputBoxTranslationConfigKey,
    isAreaTranslatorMounted,
    isFullPageTranslationActive, noteBilingualHostGesture,
    mountAreaTranslator,
    mountFloatingBall,
    mountHoverTranslationContentFeature,
    mountImageTranslator,
    mountSelectionTranslator,
    mountTranslationProgressPanel,
    mountVideoSubtitleTranslation,
    isSupportedVideoPage,
    restoreOriginalContent, resetFullPageTranslationRouteState,
    unmountAreaTranslator,
    unmountFloatingBall,
    unmountImageTranslator,
    unmountSelectionTranslator,
    unmountTranslationProgressPanel,
} from './features';
import {mountConfiguredQuickTranslation} from './quickTranslationRuntime';
import {installPageStyles} from './pageStyles';
import {installQqMailTopFrameBridge} from './qqMailFrameRuntime';
import {browserCapabilities, type BrowserCapabilities} from '@/src/platform/browser/capabilities';
import {setMainWorldBridgesEnabled} from './mainWorldBridgeLifecycle';
import {
    createContentPageAvailabilityRuntime,
    shouldAutomaticallyTranslatePage,
    type ContentPageAvailabilityRuntime,
} from './pageAvailability';
import {installContentPageLifecycle} from './pageLifecycle';
import {syncBilingualSentenceHighlight} from './bilingualSentenceHighlight';
import {createContentSiteAdaptationRuntime} from './siteAdaptationRuntime';

export async function startContentApp(ctx: ContentScriptContext,
    capabilities: BrowserCapabilities = browserCapabilities): Promise<void> {
    await configReady;
    if (ctx.isInvalid) return;
    const siteAdaptation = createContentSiteAdaptationRuntime(config.siteAdaptation, new URL(window.location.href));
    clearLegacyPageTranslationCache();
    let currentPageSiteDisabled = isExtensionDisabledOnSite(
        window.location.href,
        config.disabledExtensionDomains,
    );
    let unsubscribeContentConfig: (() => void) | null = null;
    let runtimeMessageListener: ContentRuntimeMessageHandler | null = null;
    let cleanedUp = false, pageSuspended = false;
    let featureController: AbortController | null = null;
    let activePageFeatureRegistry: ContentFeatureRegistry | null = null;
    let removePageStyles: (() => void) | null = null;
    let inputBoxConfigGeneration = 0;
    let previousInputBoxConfigKey = inputBoxTranslationConfigKey(config);
    const pageEventController = new AbortController();
    const hotkeys = createContentHotkeyRuntime(() => currentPageSiteDisabled);
    const inputTranslationFeature = createInputTranslationContentFeature({
        context: ctx,
        config,
        document,
        isSiteDisabled: () => currentPageSiteDisabled,
        readConfigGeneration: () => inputBoxConfigGeneration,
        sendMessage: (message) => browser.runtime.sendMessage(message),
        createUi: createShadowRootUi,
        logger: console,
    });
    const reportSiteDisabledState = (): void => {
        void browser.runtime.sendMessage({
            type: 'siteExtensionDisabledState',
            isDisabled: currentPageSiteDisabled,
        }).catch(() => undefined);
    };
    const isPageRuntimeEnabled = (): boolean => !cleanedUp && !pageSuspended && !currentPageSiteDisabled && config.on !== false;
    const qqMailFullPageToggle = capabilities.browser !== 'userscript'
        ? installQqMailTopFrameBridge(isPageRuntimeEnabled, pageEventController.signal) : undefined;
    let pageAvailability: ContentPageAvailabilityRuntime | null = null;
    const disposePageFeatures = (): void => {
        featureController?.abort();
        featureController = null;
        restoreOriginalContent(); cancelAllTranslations();
        activePageFeatureRegistry?.unmountAll();
        activePageFeatureRegistry = null;
        pageAvailability?.disposeVideoSubtitlePage();
        inputTranslationFeature.invalidate(); removePageStyles?.();
        removePageStyles = null;
        syncBilingualSentenceHighlight(document, false);
    };

    const activatePageFeatures = async (): Promise<void> => {
        if (!isPageRuntimeEnabled() || featureController) return;
        removePageStyles = installPageStyles(ctx);
        syncBilingualSentenceHighlight(document, config.bilingualSentenceHighlightEnabled === true);
        const activationController = new AbortController();
        featureController = activationController;
        const isActivationCurrent = () => isPageRuntimeEnabled() && featureController === activationController
            && !activationController.signal.aborted;

        inputTranslationFeature.mount(activationController.signal);
        const resetHoverKeyboardGesture = mountHoverTranslationContentFeature({
            config,
            constants,
            document,
            window,
            navigator,
            isSiteDisabled: () => currentPageSiteDisabled,
            getCenterPoint,
            handleTranslation, noteBilingualHostGesture,
            cancelPendingHoverTranslation,
            hasActiveSelectionTranslationCandidate: hotkeys.hasActiveSelectionTranslationCandidate,
            getConfiguredSelectionHotkey: hotkeys.getConfiguredSelectionHotkey,
            getCustomSelectionHotkey: () => config.customSelectionTranslatorHotkey,
            matchesSelectionTranslatorShortcut: hotkeys.matchesSelectionTranslatorShortcut,
            shouldReserveSelectionShortcut: hotkeys.shouldReserveSelectionShortcut,
        }, activationController.signal);
        const resetFullPageKeyboardGesture = hotkeys.installFloatingBallHotkey(activationController.signal);
        mountConfiguredQuickTranslation(config, hotkeys, () => currentPageSiteDisabled, activationController.signal,
            () => { resetHoverKeyboardGesture(); resetFullPageKeyboardGesture(); }, qqMailFullPageToggle);

        const pageFeatureRegistry = createContentFeatureRegistry([
            {
                id: 'writing-assistant', mount: () => mountWritingAssistant(ctx),
                isEnabled: () => capabilities.browser !== 'userscript' && config.on && config.writing.enabled && isWritingPage(window.location.href),
                unmount: unmountWritingAssistant, isMounted: isWritingAssistantMounted,
            },
            {
                id: 'floating-ball',
                isEnabled: () => config.on && config.disableFloatingBall !== true,
                mount: () => mountFloatingBall(ctx),
                unmount: unmountFloatingBall,
                isMounted: () => Boolean(document.getElementById('fluent-read-floating-ball-container')),
            },
            {
                id: 'selection-translator',
                isEnabled: () => config.on && (config.disableSelectionTranslator !== true || config.harness?.enabled === true),
                mount: () => mountSelectionTranslator(ctx),
                unmount: unmountSelectionTranslator,
                isMounted: () => Boolean(document.getElementById('fluent-read-selection-translator-container')),
            },
            {
                id: 'selection-area-translator',
                requiredCapability: 'areaTranslation',
                isEnabled: () => config.on && config.selectionAreaEnabled === true,
                mount: () => mountAreaTranslator(ctx),
                unmount: unmountAreaTranslator,
                isMounted: isAreaTranslatorMounted,
            },
            {
                id: 'image-translator',
                requiredCapability: 'imageTranslation',
                isEnabled: () => config.on && config.disableImageTranslator !== true,
                mount: () => mountImageTranslator(),
                unmount: unmountImageTranslator,
            },
            {
                id: 'translation-progress-panel',
                isEnabled: () => config.on && config.translationProgressPanelEnabled === true,
                mount: () => mountTranslationProgressPanel(ctx),
                unmount: unmountTranslationProgressPanel,
                isMounted: () => Boolean(document.getElementById('fluent-read-translation-status-container')),
            },
        ], {
            capabilities,
            onError: (featureId, phase, error) => {
                console.error(`[FluentRead] 内容功能 ${featureId} ${phase} 失败:`, error);
            },
        });
        activePageFeatureRegistry = pageFeatureRegistry;
        await pageFeatureRegistry.mountEnabled({
            ctx,
            signal: activationController.signal,
            isCurrent: isActivationCurrent,
        });
    };

    pageAvailability = createContentPageAvailabilityRuntime({
        isEnabled: isPageRuntimeEnabled,
        isPageFeaturesActive: () => featureController !== null,
        isVideoPage: isSupportedVideoPage,
        shouldAutomaticallyTranslate: () => shouldAutomaticallyTranslatePage(window.location.href, config),
        isFullPageTranslationActive,
        setMainWorldBridgesEnabled: (enabled) => setMainWorldBridgesEnabled(document, enabled),
        activatePageFeatures,
        disposePageFeatures,
        mountVideoSubtitle: mountVideoSubtitleTranslation,
        autoTranslate: autoTranslateEnglishPage,
    });

    const applySiteDisabledState = async (disabled: boolean): Promise<void> => {
        if (cleanedUp) return;
        currentPageSiteDisabled = disabled;
        reportSiteDisabledState();
        await pageAvailability!.reconcile();
    };

    document.addEventListener('fluentread-route-change', () => {
        siteAdaptation.routeChanged(new URL(window.location.href));
        resetPageTranslationContextCache(); resetFullPageTranslationRouteState();
        pageAvailability!.syncVideoSubtitlePage();
        void activePageFeatureRegistry?.reconcileEnabled();
    }, {signal: pageEventController.signal});

    const cleanup = (): void => {
        if (cleanedUp) return;
        cleanedUp = true;
        pageEventController.abort();
        setMainWorldBridgesEnabled(document, false);
        if (runtimeMessageListener) browser.runtime.onMessage.removeListener(runtimeMessageListener);
        disposePageFeatures();
        unsubscribeContentConfig?.();
        unsubscribeContentConfig = null;
    };
    ctx.onInvalidated(cleanup);
    installContentPageLifecycle(window, pageEventController.signal, {
        suspend: () => { pageSuspended = true; void pageAvailability!.reconcile(); },
        resume: () => { pageSuspended = false; void pageAvailability!.reconcile(); },
        dispose: cleanup,
    });
    runtimeMessageListener = createContentRuntimeMessageHandler(ctx, {
        isSiteDisabled: () => currentPageSiteDisabled, updateSiteDisabled: applySiteDisabledState,
    }, capabilities);
    browser.runtime.onMessage.addListener(runtimeMessageListener);
    reportSiteDisabledState();
    unsubscribeContentConfig = subscribeConfig((nextConfig) => {
        siteAdaptation.update(nextConfig.siteAdaptation, new URL(window.location.href));
        syncBilingualSentenceHighlight(document, nextConfig.bilingualSentenceHighlightEnabled === true);
        const nextInputBoxConfigKey = inputBoxTranslationConfigKey(nextConfig);
        if (nextInputBoxConfigKey !== previousInputBoxConfigKey) {
            previousInputBoxConfigKey = nextInputBoxConfigKey;
            inputBoxConfigGeneration += 1;
            inputTranslationFeature.invalidate();
        }
        const nextSiteDisabled = isExtensionDisabledOnSite(
            window.location.href,
            nextConfig.disabledExtensionDomains,
        );
        if (nextSiteDisabled !== currentPageSiteDisabled) {
            void applySiteDisabledState(nextSiteDisabled);
            return;
        }

        // 总开关是 content 生命周期的权威边界；配置历史/导入/其他上下文同步
        // 不依赖 popup/options 的易丢广播，也必须完整恢复 DOM 和释放所有 feature。
        if (pageAvailability!.needsLifecycleReconcile()) {
            void pageAvailability!.reconcile();
            return;
        }
        if (!isPageRuntimeEnabled()) return;
        void activePageFeatureRegistry?.reconcileEnabled();

        // 关闭“始终翻译”不撤销当前会话；只处理 false -> true，避免 storage.watch 同值回声。
        pageAvailability!.refreshAutoTranslation();
    });

    // 先订阅再跨越首次 activation，避免初始化期间的总开关或站点规则写入永久漏同步。
    await pageAvailability.reconcile();
}
