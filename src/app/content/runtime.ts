/**
 * @file src/app/content/runtime.ts
 * 文件职责：作为内容脚本应用的顶层 composition root，协调配置就绪、站点规则、公共样式、主世界桥、功能注册表、快捷键和消息监听生命周期。
 * 主要内容：先排除原始 XML 文档与失效扩展上下文，再安装内联 page.css 并按 capability 和配置挂载页面功能；订阅配置变化并处理停用、往返缓存暂停恢复与销毁，低频检查扩展重载以主动释放旧页面，消息端口失效不能中断清理。
 * 模块边界：本文件只负责依赖装配和页面激活所有权，不实现具体翻译算法、组件内部状态、provider 请求或配置存储；这些职责分别属于 features、services 与 platform。
 */
import {isWritingPage} from '@/src/core/config/writing';
import {mountWritingAssistant, unmountWritingAssistant, isWritingAssistantMounted} from '@/src/features/writing-assistant/public';
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import {createShadowRootUi} from 'wxt/utils/content-script-ui/shadow-root';
import {constants} from '@/src/core/config/constants';
import {isExtensionDisabledOnSite} from '@/src/features/site-rules/domain';
import {config, configReady, subscribeConfig} from '@/src/services/config/store';
import {ensureUiLanguageBundle} from '@/src/platform/i18n/uiLanguageBundles';
import {cancelAllTranslations} from '@/src/app/translation/client';
import {resetPageTranslationContextCache} from '@/src/services/translation/context';
import {clearLegacyPageTranslationCache} from '@/src/services/translation/legacyPageCache';
import {getCenterPoint} from '@/src/shared/geometry/touch';
import {isRawXmlContentDocument} from '@/src/shared/dom/documentType';
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
    mountAreaTranslator, mountFloatingBall, isFloatingBallAllowedOnPage,
    mountHoverTranslationContentFeature, mountImageTranslator, mountParagraphCopyContentFeature, mountSectionTranslationContentFeature,
    mountSelectionTranslator, mountTranslationProgressPanel, mountShareCard, unmountShareCard, isShareCardMounted,
    mountVideoSubtitleTranslation,
    isSupportedVideoPage,
    restoreOriginalContent, resetFullPageTranslationRouteState,
    unmountAreaTranslator, unmountFloatingBall, unmountImageTranslator,
    unmountSelectionTranslator,
    unmountTranslationProgressPanel,
} from './features';
import {mountConfiguredQuickTranslation} from './quickTranslationRuntime';
import {installPageStyles} from './pageStyles';
import {installNeteaseMailTopFrameBridge, installQqMailTopFrameBridge} from './qqMailFrameRuntime';
import {installEmbeddedTopFrameBridge} from './embeddedFrameRuntime';
import {browserCapabilities, type BrowserCapabilities} from '@/src/platform/browser/capabilities';
import {setMainWorldBridgesEnabled} from './mainWorldBridgeLifecycle';
import {
    createContentPageAvailabilityRuntime,
    shouldAutomaticallyTranslatePage,
    type ContentPageAvailabilityRuntime,
} from './pageAvailability';
import {installContentPageLifecycle, waitForContentDocument} from './pageLifecycle';
import {syncBilingualSentenceHighlight} from './bilingualSentenceHighlight';
import {applyCoreTranslationPreferences, createContentSiteAdaptationRuntime} from './siteAdaptationRuntime';
import {createOptionalContentFeatureRuntime, type OptionalContentFeatureRuntime} from './optionalFeatures';
export async function startContentApp(ctx: ContentScriptContext,
    capabilities: BrowserCapabilities = browserCapabilities): Promise<void> {
    if (isRawXmlContentDocument(document) || ctx.isInvalid) return;
    const pageEventController = new AbortController();
    let cleanedUp = false;
    let pageAvailability: ContentPageAvailabilityRuntime | null = null;
    let cleanup = (): void => { cleanedUp = true; pageEventController.abort(); };
    ctx.onInvalidated(() => cleanup());
    const pageLifecycle = installContentPageLifecycle(window, pageEventController.signal, {
        suspend: () => { void pageAvailability?.reconcile(); },
        resume: () => { void pageAvailability?.reconcile(); },
        dispose: () => cleanup(),
    }, capabilities.browser === 'userscript' ? undefined : ctx);
    // 非中文界面资源是扩展内本地文件，挂载前取得可避免非响应式浮层先以中文回退渲染；中文同步命中。
    await configReady; await ensureUiLanguageBundle(config.uiLanguage);
    if (ctx.isInvalid || cleanedUp || (document.readyState === 'loading' && !await waitForContentDocument(document, pageEventController.signal))) { cleanup(); return; }
    const siteAdaptation = createContentSiteAdaptationRuntime(config.siteAdaptation, new URL(window.location.href));
    applyCoreTranslationPreferences(config); clearLegacyPageTranslationCache();
    let currentRouteHref = window.location.href;
    let currentPageSiteDisabled = isExtensionDisabledOnSite(currentRouteHref, config.disabledExtensionDomains);
    let unsubscribeContentConfig: (() => void) | null = null;
    let runtimeMessageListener: ContentRuntimeMessageHandler | null = null;
    const runtimeMessages = browser.runtime.onMessage;
    let featureController: AbortController | null = null;
    let optionalContentFeatures: OptionalContentFeatureRuntime | null = null;
    let activePageFeatureRegistry: ContentFeatureRegistry | null = null;
    let removePageStyles: (() => void) | null = null;
    let inputBoxConfigGeneration = 0;
    let previousInputBoxConfigKey = inputBoxTranslationConfigKey(config);
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
    const reportSiteDisabledState = async (): Promise<void> => {
        try { await browser.runtime.sendMessage({
            type: 'siteExtensionDisabledState',
            isDisabled: currentPageSiteDisabled,
        }); } catch { /* 站点状态广播不能阻断失效后的页面清理。 */ }
    };
    const isPageRuntimeEnabled = (): boolean => !cleanedUp && !ctx.isInvalid && !pageLifecycle.isSuspended() && !currentPageSiteDisabled && config.on !== false;
    const mailFullPageToggle = capabilities.browser !== 'userscript'
        ? installQqMailTopFrameBridge(isPageRuntimeEnabled, pageEventController.signal)
            ?? installNeteaseMailTopFrameBridge(isPageRuntimeEnabled, pageEventController.signal)
        : undefined;
    if (capabilities.browser !== 'userscript') {
        installEmbeddedTopFrameBridge(isPageRuntimeEnabled, pageEventController.signal);
    }
    const disposePageFeatures = (): void => {
        featureController?.abort(); featureController = null;
        optionalContentFeatures?.dispose(); optionalContentFeatures = null;
        restoreOriginalContent(); cancelAllTranslations();
        activePageFeatureRegistry?.unmountAll(); activePageFeatureRegistry = null;
        pageAvailability?.disposeVideoSubtitlePage(); removePageStyles?.();
        removePageStyles = null;
        syncBilingualSentenceHighlight(document, false);
    };
    const activatePageFeatures = async (): Promise<void> => {
        if (!isPageRuntimeEnabled() || featureController) return;
        removePageStyles = installPageStyles(ctx);
        syncBilingualSentenceHighlight(document, config.bilingualSentenceHighlightEnabled === true, config.bilingualSentenceHighlightStyle, config.bilingualSentenceHighlightAppearance);
        const activationController = new AbortController();
        featureController = activationController;
        const isActivationCurrent = () => isPageRuntimeEnabled() && featureController === activationController
            && !activationController.signal.aborted;

        optionalContentFeatures = createOptionalContentFeatureRuntime({
            activationSignal: activationController.signal,
            config,
            isSiteDisabled: () => currentPageSiteDisabled,
            inputTranslationFeature,
            mountParagraphCopyContentFeature, mountSectionTranslationContentFeature,
        });
        optionalContentFeatures.sync();
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
            ...hotkeys.selectionShortcutPorts,
        }, activationController.signal);
        const resetFullPageKeyboardGesture = hotkeys.installFloatingBallHotkey(activationController.signal);
        mountConfiguredQuickTranslation(config, hotkeys, () => currentPageSiteDisabled, activationController.signal,
            () => { resetHoverKeyboardGesture(); resetFullPageKeyboardGesture(); }, mailFullPageToggle);
        const pageFeatureRegistry = createContentFeatureRegistry([
            {id: 'share-card', isEnabled: () => config.on, mount: () => mountShareCard(ctx), unmount: unmountShareCard, isMounted: isShareCardMounted},
            {
                id: 'writing-assistant', mount: () => mountWritingAssistant(ctx),
                isEnabled: () => capabilities.browser !== 'userscript' && config.on && config.writing.enabled && isWritingPage(window.location.href),
                unmount: unmountWritingAssistant, isMounted: isWritingAssistantMounted,
            },
            {
                id: 'floating-ball',
                isEnabled: () => config.on && config.disableFloatingBall !== true && isFloatingBallAllowedOnPage(),
                mount: () => mountFloatingBall(ctx),
                unmount: unmountFloatingBall,
                isMounted: () => Boolean(document.getElementById('fluent-read-floating-ball-container')),
            },
            {
                id: 'selection-translator',
                isEnabled: () => config.on && config.disableSelectionTranslator !== true && config.selectionTranslatorMode !== 'disabled',
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
        void reportSiteDisabledState();
        await pageAvailability!.reconcile();
    };
    document.addEventListener('fluentread-route-change', () => {
        if (currentRouteHref === window.location.href) return;
        currentRouteHref = window.location.href;
        siteAdaptation.routeChanged(new URL(window.location.href));
        resetPageTranslationContextCache(); resetFullPageTranslationRouteState();
        pageAvailability!.syncVideoSubtitlePage();
        void activePageFeatureRegistry?.reconcileEnabled();
    }, {signal: pageEventController.signal});

    cleanup = (): void => {
        if (cleanedUp) return;
        cleanedUp = true;
        pageEventController.abort();
        setMainWorldBridgesEnabled(document, false);
        // 扩展重载后 browser.runtime 可能已被撤销；使用注册时的事件端口，
        // 即使旧端口拒绝注销，也必须继续恢复宿主页面和释放配置订阅。
        try {
            if (runtimeMessageListener) runtimeMessages.removeListener(runtimeMessageListener);
        } catch { /* 失效上下文的监听由浏览器释放，页面清理仍由本运行时负责。 */ }
        disposePageFeatures();
        unsubscribeContentConfig?.(); unsubscribeContentConfig = null;
    };
    runtimeMessageListener = createContentRuntimeMessageHandler(ctx, {
        isSiteDisabled: () => currentPageSiteDisabled, updateSiteDisabled: applySiteDisabledState,
        isPageSuspended: pageLifecycle.isSuspended,
    }, capabilities);
    runtimeMessages.addListener(runtimeMessageListener);
    void reportSiteDisabledState();
    unsubscribeContentConfig = subscribeConfig((nextConfig) => {
        void ensureUiLanguageBundle(nextConfig.uiLanguage); applyCoreTranslationPreferences(nextConfig);
        siteAdaptation.update(nextConfig.siteAdaptation, new URL(window.location.href));
        syncBilingualSentenceHighlight(document, isPageRuntimeEnabled() && nextConfig.bilingualSentenceHighlightEnabled === true, nextConfig.bilingualSentenceHighlightStyle, nextConfig.bilingualSentenceHighlightAppearance);
        const nextInputBoxConfigKey = inputBoxTranslationConfigKey(nextConfig);
        if (nextInputBoxConfigKey !== previousInputBoxConfigKey) {
            previousInputBoxConfigKey = nextInputBoxConfigKey;
            inputBoxConfigGeneration += 1;
            inputTranslationFeature.invalidate();
        }
        optionalContentFeatures?.sync();
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
