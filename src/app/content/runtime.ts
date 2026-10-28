/**
 * @file src/app/content/runtime.ts
 * 文件职责：作为内容脚本应用的顶层 composition root，协调配置就绪、站点规则、公共样式、主世界桥、功能注册表、快捷键和消息监听生命周期。
 * 主要内容：通过既有配置订阅即时重排网页双语与仅译文工件，不重发翻译请求；按全局配置同步当前文档的译文字体，刷新与路由变化保留选择，停用、挂起和销毁只撤销文档样式，恢复时重新应用；装配学习材料继续阅读的来源校验、定位与自动位置更新生命周期；先排除原始 XML 文档与失效扩展上下文，再安装内联 page.css 并按 capability 和配置挂载页面功能；配置变更时更新页面私有网站名单索引，按已提交地址检查自动翻译与站点禁用，锚点跳转保留请求，协调停用、往返缓存暂停恢复与销毁。
 * 模块边界：本文件只负责依赖装配和页面激活所有权，不实现具体翻译算法、组件内部状态、provider 请求或配置存储；这些职责分别属于 features、services 与 platform。
 */
import {createLearningContentFeatures} from './learningFeatures';
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import {createShadowRootUi} from 'wxt/utils/content-script-ui/shadow-root';
import {constants} from '@/src/core/config/constants';
import {createSiteRuleMatcher} from '@/src/features/site-rules/domain';
import {config, configReady, subscribeConfig} from '@/src/services/config/store';
import {ensureUiLanguageBundle} from '@/src/platform/i18n/uiLanguageBundles';
import {cancelAllTranslations} from '@/src/services/translation/client';
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
    mountAreaTranslator, startAreaTranslationFromContextMenu, mountFloatingBall, isFloatingBallAllowedOnPage,
    mountHoverTranslationContentFeature, mountImageTranslator, mountParagraphCopyContentFeature, mountSectionTranslationContentFeature,
    isImageTranslatorNeeded, isMangaReaderPage, mountMangaEntry, unmountMangaEntry,
    mountSelectionTranslator, mountTranslationProgressPanel,
    mountVideoSubtitleTranslation,
    isSupportedVideoPage,
    restoreOriginalContent, resetFullPageTranslationRouteState, createPageTranslationDisplayModeSync,
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
    createContentPageAvailabilityRuntime, reconcileCurrentContentPage,
    createContentRouteChangeHandler,
    type ContentPageAvailabilityRuntime,
} from './pageAvailability';
import {installContentPageLifecycle, waitForContentDocument} from './pageLifecycle';
import {syncBilingualSentenceHighlight} from './bilingualSentenceHighlight';
import {applyCoreTranslationPreferences, createContentSiteAdaptationRuntime} from './siteAdaptationRuntime';
import {createOptionalContentFeatureRuntime, type OptionalContentFeatureRuntime} from './optionalFeatures';
import {createPageInformationHighlightRuntime} from './informationHighlight';
import {createHoverTranslationConfigSubscription} from './hoverTranslationConfig';
import {createPageTranslationFontRuntime} from './pageTranslationFont';
export async function startContentApp(ctx: ContentScriptContext,
    capabilities: BrowserCapabilities = browserCapabilities): Promise<void> {
    if (isRawXmlContentDocument(document) || ctx.isInvalid) return;
    const pageEventController = new AbortController();
    let cleanedUp = false;
    let pageAvailability: ContentPageAvailabilityRuntime | null = null;
    let cleanup = (): void => { cleanedUp = true; pageEventController.abort(); };
    const pageLifecycle = installContentPageLifecycle(window, pageEventController.signal, {
        suspend: () => { void pageAvailability?.reconcile(); },
        resume: () => { void pageAvailability?.reconcile(); },
        dispose: () => cleanup(),
    }, ctx, document, capabilities.browser !== 'userscript');
    // 非中文界面资源是扩展内本地文件，挂载前取得可避免非响应式浮层先以中文回退渲染；中文同步命中。
    await configReady;
    if (ctx.isInvalid || cleanedUp) { cleanup(); return; }
    await ensureUiLanguageBundle(config.uiLanguage);
    if (ctx.isInvalid || cleanedUp || (document.readyState === 'loading' && !await waitForContentDocument(document, pageEventController.signal))) { cleanup(); return; }
    const siteAdaptation = createContentSiteAdaptationRuntime(config.siteAdaptation, new URL(window.location.href));
    applyCoreTranslationPreferences(config); clearLegacyPageTranslationCache();
    const siteRules = createSiteRuleMatcher(config);
    let currentPageSiteDisabled = siteRules.isExtensionDisabled(window.location.href);
    let unsubscribeContentConfig: (() => void) | null = null;
    const runtimeMessages = browser.runtime.onMessage;
    let featureController: AbortController | null = null;
    let optionalContentFeatures: OptionalContentFeatureRuntime | null = null;
    let activePageFeatureRegistry: ContentFeatureRegistry | null = null;
    let removePageStyles: (() => void) | null = null;
    let inputBoxConfigGeneration = 0;
    let previousInputBoxConfigKey = inputBoxTranslationConfigKey(config);
    const pageTranslationFont = import.meta.env.BROWSER === 'userscript' ? undefined : createPageTranslationFontRuntime({document, onChange: () => document.dispatchEvent(new Event('fluentread-page-translation-font-changed'))});
    const informationHighlight = import.meta.env.BROWSER === 'userscript' ? undefined : createPageInformationHighlightRuntime({document, config, send: message => browser.runtime.sendMessage(message), canToggle: () => !currentPageSiteDisabled && !pageLifecycle.isSuspended()});
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
    const mailFullPageToggle = import.meta.env.BROWSER !== 'userscript' && capabilities.browser !== 'userscript'
        ? installQqMailTopFrameBridge(isPageRuntimeEnabled, pageEventController.signal, () => pageTranslationFont?.read() === true)
            ?? installNeteaseMailTopFrameBridge(isPageRuntimeEnabled, pageEventController.signal, () => pageTranslationFont?.read() === true)
        : undefined;
    if (import.meta.env.BROWSER !== 'userscript' && capabilities.browser !== 'userscript') {
        installEmbeddedTopFrameBridge(isPageRuntimeEnabled, pageEventController.signal, () => pageTranslationFont?.read() === true);
    }
    const disposePageFeatures = (): void => {
        if (import.meta.env.BROWSER !== 'userscript') pageTranslationFont?.reset(); featureController?.abort(); featureController = null;
        optionalContentFeatures?.dispose(); optionalContentFeatures = null;
        restoreOriginalContent(); cancelAllTranslations();
        activePageFeatureRegistry?.unmountAll(); activePageFeatureRegistry = null;
        pageAvailability?.disposeVideoSubtitlePage(); removePageStyles?.(); removePageStyles = null;
        syncBilingualSentenceHighlight(document, false);
    };
    const activatePageFeatures = async (): Promise<void> => {
        if (!isPageRuntimeEnabled() || featureController) return;
        removePageStyles = installPageStyles(ctx);
        pageTranslationFont?.set(config.browserDefaultTranslationFont === true);
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
            config, subscribeConfig: createHoverTranslationConfigSubscription(config, subscribeConfig, cancelPendingHoverTranslation),
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
        activePageFeatureRegistry = createContentFeatureRegistry([
            ...createLearningContentFeatures(ctx, config, capabilities),
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
            {id: 'image-translator', requiredCapability: 'imageTranslation', isEnabled: isImageTranslatorNeeded,
                mount: () => mountImageTranslator(), unmount: unmountImageTranslator},
            {id: 'manga-entry', requiredCapability: 'imageTranslation',
                isEnabled: () => config.on && config.imageTranslationMangaEnabled && isMangaReaderPage(),
                mount: () => mountMangaEntry(ctx, {startAreaTranslation: startAreaTranslationFromContextMenu}), unmount: unmountMangaEntry},
            {
                id: 'translation-progress-panel',
                isEnabled: () => config.on && config.translationProgressPanelEnabled === true,
                mount: () => mountTranslationProgressPanel(ctx),
                unmount: unmountTranslationProgressPanel,
                isMounted: () => Boolean(document.getElementById('fluent-read-translation-status-container')),
            },
            ...(import.meta.env.BROWSER === 'userscript' ? [] : [informationHighlight!.feature]),
        ], {capabilities,
            onError: (featureId, phase, error) => {
                console.error(`[FluentRead] 内容功能 ${featureId} ${phase} 失败:`, error);
            },
        });
        await activePageFeatureRegistry.mountEnabled({
            ctx,
            signal: activationController.signal,
            isCurrent: isActivationCurrent,
        });
    };
    pageAvailability = createContentPageAvailabilityRuntime({
        isEnabled: isPageRuntimeEnabled,
        isPageFeaturesActive: () => featureController !== null,
        isVideoPage: isSupportedVideoPage,
        shouldAutomaticallyTranslate: () => siteRules.shouldAutoTranslate(window.location.href),
        getPageIdentity: () => window.location.href,
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
    document.addEventListener('fluentread-route-change', createContentRouteChangeHandler({
        getHref: () => window.location.href,
        routeChanged: href => { informationHighlight?.routeChanged(); siteAdaptation.routeChanged(new URL(href)); },
        resetTranslationRoute: () => { resetPageTranslationContextCache(); resetFullPageTranslationRouteState(); },
        siteDisabled: href => siteRules.isExtensionDisabled(href),
        currentSiteDisabled: () => currentPageSiteDisabled,
        applySiteDisabledState, pageAvailability,
        reconcileFeatures: () => { void activePageFeatureRegistry?.reconcileEnabled(); },
    }), {signal: pageEventController.signal});
    const runtimeMessageListener: ContentRuntimeMessageHandler = createContentRuntimeMessageHandler(ctx, {
        ...(import.meta.env.BROWSER === 'userscript' ? {} : {pageTranslationFont}), isSiteDisabled: () => currentPageSiteDisabled, updateSiteDisabled: applySiteDisabledState,
        isPageSuspended: pageLifecycle.isSuspended, ...(import.meta.env.BROWSER === 'userscript' ? {reconcileUserscriptPage: () => reconcileCurrentContentPage(
            () => pageAvailability!.reconcile(), () => activePageFeatureRegistry, () => !cleanedUp && !ctx.isInvalid && !pageLifecycle.isSuspended() && !currentPageSiteDisabled, () => config.on)} : {informationHighlight}),
    }, capabilities);
    cleanup = (): void => {
        if (cleanedUp) return;
        cleanedUp = true;
        pageEventController.abort();
        setMainWorldBridgesEnabled(document, false);
        // 扩展重载后 browser.runtime 可能已被撤销；使用注册时的事件端口，
        // 即使旧端口拒绝注销，也必须继续恢复宿主页面和释放配置订阅。
        try {
            runtimeMessages.removeListener(runtimeMessageListener);
        } catch { /* 失效上下文的监听由浏览器释放，页面清理仍由本运行时负责。 */ }
        disposePageFeatures(); if (import.meta.env.BROWSER !== 'userscript') pageTranslationFont?.dispose();
        unsubscribeContentConfig?.(); unsubscribeContentConfig = null;
    };
    runtimeMessages.addListener(runtimeMessageListener);
    void reportSiteDisabledState();
    unsubscribeContentConfig = subscribeConfig(createPageTranslationDisplayModeSync(config, (nextConfig) => {
        siteRules.update(nextConfig);
        void ensureUiLanguageBundle(nextConfig.uiLanguage); applyCoreTranslationPreferences(nextConfig);
        siteAdaptation.update(nextConfig.siteAdaptation, new URL(window.location.href));
        informationHighlight?.updatePreferences(nextConfig.informationHighlight);
        syncBilingualSentenceHighlight(document, isPageRuntimeEnabled() && nextConfig.bilingualSentenceHighlightEnabled === true, nextConfig.bilingualSentenceHighlightStyle, nextConfig.bilingualSentenceHighlightAppearance);
        const nextInputBoxConfigKey = inputBoxTranslationConfigKey(nextConfig);
        if (nextInputBoxConfigKey !== previousInputBoxConfigKey) {
            previousInputBoxConfigKey = nextInputBoxConfigKey;
            inputBoxConfigGeneration += 1;
            inputTranslationFeature.invalidate();
        }
        optionalContentFeatures?.sync();
        const nextSiteDisabled = siteRules.isExtensionDisabled(window.location.href);
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
        pageTranslationFont?.set(nextConfig.browserDefaultTranslationFont === true);
        void activePageFeatureRegistry?.reconcileEnabled();
        // 关闭“始终翻译”不撤销当前会话；同页同值回声不会再次启动。
        pageAvailability!.refreshAutoTranslation();
    }));
    // 先订阅再跨越首次 activation，避免初始化期间的总开关或站点规则写入永久漏同步。
    await pageAvailability.reconcile();
}
