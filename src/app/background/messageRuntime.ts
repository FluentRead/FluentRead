/**
 * @file src/app/background/messageRuntime.ts
 * 文件职责：构建并安装后台消息总运行时，把配置、翻译、OCR、TTS、生词本、扩展面板导航和标签页状态等公开 handler 连接到 browser.runtime。
 * 主要内容：向图片与划词处理注入设置、语言仓库和能力门控，图片邻文由已启用的 AI 上下文开关及当前模型的提示词能力决定，绑定事务页面及术语版本；Safari 为后台 iframe 注册同源接收端，并从可信配置读取网页通知接收者；装配翻译、TTS、下载及文档导航等类型化 router 与生命周期。
 * 模块边界：本文件是 composition root，只决定依赖装配和监听生命周期，不实现各 feature 的业务算法、provider 协议或存储事务；具体实现均来自 features、services、providers 与 platform。
 */
import {getFreeTranslationWeightSnapshot, createProviderTestRuntimeHandlers} from './providerRuntime';
import {createPersonalCorrectionRuntimeHandlers} from './personalCorrectionRuntime';
import {createChatGPTPlanHandler} from './chatgptPlanRuntime';
import {config, configReady} from '@/src/services/config/store';
import {lookupSelectionDictionary, createDictionaryRuntimeHandler} from './dictionaryRuntime';
import {createSelectionPageZoomBrowserPort, createSelectionPageZoomHandler} from '@/src/features/selection-translation/background/pageZoomHandler';
import {synthesizeEdgeTts} from '@/src/features/selection-translation/services/edgeTts';
import {vocabularyBook} from '@/src/features/vocabulary/repository';
import {createBrowserMaterialHandler} from './handlers/vocabulary';
import {clearTranslationCache, getTranslationCacheStats, translateWithCache} from '@/src/app/translation/runtime';
import {serializeTranslationError} from '@/src/services/translation/errors';
import {createBackgroundMessageRouter, createBackgroundRuntimeMessageListener, type BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';
import {createAreaTranslationRuntime} from './areaRuntime';
import {createTranslationCacheHandlers, createTranslationCacheInvalidationBroadcaster} from './handlers/translationCache';
import {
    createFullPageTranslationStateHandlers, createQqMailFrameBackgroundHandlers,
} from './handlers/fullPageTranslationState';
import {createNeteaseMailFrameBackgroundHandlers} from '@/src/features/full-page-translation/background/neteaseMailFrameHandlers';
import {createImageOcrLanguageRepository} from './handlers/imageTranslation';
import {createImageTranslationRuntime} from './imageTranslationRuntime';
import {createInputBoxTranslationHandler} from './handlers/inputTranslation';
import {createLocalInsightsHandlers} from './localInsightsHandlers';
import {createFreeTranslationWeightsHandler} from './handlers/freeTranslationWeights';
import {createPopupNavigationHandlers} from './popupNavigation';
import {createDownloadProgressHandler, createDownloadProgressQueryHandler} from './handlers/downloadProgress';
import {createTranslationCancelHandler, createTranslationRequestFallback, createTranslationRequestRegistry} from './handlers/translation';
import {createSelectionTtsBackgroundHandlers} from './handlers/selectionTts';
import {createSelectionWordLookupHandler} from './handlers/selectionWordLookup';
import {isBrowserTabId} from './tabTranslationState';
import {createBrowserVocabularyBookChangedBroadcaster, createBrowserVocabularyUndoOptions, createVocabularyBackgroundHandlers} from './handlers/vocabulary';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {installExtensionPageMessageListener, type ExtensionPageMessageTarget} from '@/src/platform/offscreen/extensionPageMessaging';
import {selectionTtsOffscreenAdapter} from '@/src/features/selection-translation/background/offscreenAdapter';
import {createCapabilityGatedBackgroundHandlers, createCapabilityGatedSelectionTtsTransport} from './capabilityRegistry';
import {createConfigBackgroundHandlers} from './configMessageHandlers';
import {createConfigImageOcrLanguageStorage, installBrowserConfigStorageBroadcast, installBrowserTabBroadcastRuntime} from './configStorageRuntime';
import {releaseVideoSubtitleOwnerForTab} from '@/src/features/video-subtitle/background/handlers';
import {createVideoSubtitleBackgroundRuntime} from '@/src/features/video-subtitle/background/runtime';
import {createLocalModelMessageHandlers} from './localModelMessageRuntime';
import {localTtsOffscreenAdapter} from '@/src/features/local-tts/background/offscreenAdapter';
import {createSelectionTtsSynthesizer} from '@/src/features/selection-translation/background/selectionTtsSynthesis';
import {installWritingBackgroundRuntime} from './writingRuntime';
import {installHarnessBackgroundRuntime} from './harnessRuntime';
import {installMaterialRuntimes} from './materialRuntimes';
import {createImageGlossaryContext} from './imageGlossaryContext';
import {createEmbeddedFrameBackgroundHandlers} from '@/src/features/full-page-translation/background/embeddedFrameHandlers';
import {createDocumentNavigationHandlers} from './documentNavigation';
import {buildGlossaryRevision} from '@/src/core/glossary';
import type {BackgroundRuntimeContext, BackgroundMessageRuntimeOptions} from './messageRuntimeTypes';
export type {BackgroundMessageRuntimeOptions} from './messageRuntimeTypes';
export function installBackgroundMessageRuntime(options: BackgroundMessageRuntimeOptions): void {
    installMaterialRuntimes(configReady);
    const cancelWriting = installWritingBackgroundRuntime();
    const capabilities = options.capabilities ?? browserCapabilities;
    const tabBroadcast = installBrowserTabBroadcastRuntime(capabilities.browser);
    const translationRequestRegistry = createTranslationRequestRegistry();
    const imageOcrLanguageRepository = createImageOcrLanguageRepository(createConfigImageOcrLanguageStorage());
    const selectionTtsTransport = createCapabilityGatedSelectionTtsTransport(capabilities, selectionTtsOffscreenAdapter);
    const selectionPageZoom = createSelectionPageZoomBrowserPort(browser.tabs);
    const selectionTtsSynthesizer = createSelectionTtsSynthesizer({
        getMode: () => config.selectionTtsMode,
        getLocalVoice: () => config.selectionTtsLocalVoice,
        getOnlineVoices: () => config.selectionTtsVoices,
        synthesizeOnline: synthesizeEdgeTts,
        synthesizeLocal: (text, language, voice, signal) => localTtsOffscreenAdapter.synthesize(text, language, voice, signal),
    });
    const imageGlossaryContext = createImageGlossaryContext<BackgroundRuntimeContext>({
        ready: configReady,
        offscreenUrl: browser.runtime.getURL('/offscreen.html'),
        getSourceLanguage: () => config.from,
        getGlossaryRevision: () => buildGlossaryRevision(config.glossaryLibraries, config.glossaryEnabled),
    });
    const handlers: Array<BackgroundMessageHandler<BackgroundRuntimeContext>> = [
        createDictionaryRuntimeHandler(),
        ...createDocumentNavigationHandlers(options.tabTranslationStates),
        ...createPersonalCorrectionRuntimeHandlers<BackgroundRuntimeContext>(tabBroadcast),
        createChatGPTPlanHandler(),
        createTranslationCancelHandler(translationRequestRegistry),
        installHarnessBackgroundRuntime(cancelWriting),
        ...createQqMailFrameBackgroundHandlers({sendTabMessage: (tabId, message, options) => browser.tabs.sendMessage(tabId, message, options)}),
        ...createEmbeddedFrameBackgroundHandlers({sendTabMessage: (tabId, message, options) => browser.tabs.sendMessage(tabId, message, options)}),
        ...createNeteaseMailFrameBackgroundHandlers({sendTabMessage: (tabId, message, options) => browser.tabs.sendMessage(tabId, message, options)}),
        ...createTranslationCacheHandlers(clearTranslationCache, getTranslationCacheStats, createTranslationCacheInvalidationBroadcaster({
            ...tabBroadcast,
            warn: (message, error) => console.warn(message, error),
        })),
        ...createLocalInsightsHandlers<BackgroundRuntimeContext>((url) => url.startsWith(browser.runtime.getURL('/options.html'))),
        createFreeTranslationWeightsHandler({
            ready: configReady,
            getSnapshot: getFreeTranslationWeightSnapshot,
            isOptionsUrl: (url) => url.startsWith(browser.runtime.getURL('/options.html')),
        }),
        ...createConfigBackgroundHandlers<BackgroundRuntimeContext>(tabBroadcast.registerContentReceiver),
        ...createProviderTestRuntimeHandlers(),
        createInputBoxTranslationHandler({
            ready: configReady,
            getConfig: () => config,
            translate: translateWithCache,
            requestRegistry: translationRequestRegistry,
        }),
        ...createPopupNavigationHandlers(),
        ...createFullPageTranslationStateHandlers({
            stateStore: options.tabTranslationStates,
            isTabId: isBrowserTabId,
            onStateChanged: options.onFullPageStateChanged,
        }),
        createSelectionWordLookupHandler({
            lookupWord: lookupSelectionDictionary,
            getDefaultTargetLanguage: () => config.to,
            translate: (request) => translateWithCache({...request, serviceOverride: config.selectionTranslationService || config.service}),
            warn: (message, error) => console.warn(message, error),
        }),
        createSelectionPageZoomHandler(selectionPageZoom.getZoom),
        ...imageGlossaryContext.wrap(createCapabilityGatedBackgroundHandlers<BackgroundRuntimeContext>(capabilities, {
            areaTranslation: () => createAreaTranslationRuntime(imageOcrLanguageRepository.assertDownloaded),
            imageTranslation: () => createImageTranslationRuntime(imageOcrLanguageRepository),
        })),
        ...createSelectionTtsBackgroundHandlers({
            playbackStateSender: {runtimeId: browser.runtime.id, url: browser.runtime.getURL('/offscreen.html')},
            getPreferredVoices: () => config.selectionTtsVoices,
            synthesize: selectionTtsSynthesizer,
            fetchPageAudio: selectionTtsOffscreenAdapter.fetchPageAudio,
            playWithOffscreen: selectionTtsTransport.play,
            stopWithOffscreen: selectionTtsTransport.stop,
            seekWithOffscreen: selectionTtsOffscreenAdapter.seek,
            offscreenPlaybackEnabled: capabilities.selectionTtsExtensionPlayback,
            sendTabMessage: (tabId, message, options) => browser.tabs.sendMessage(tabId, message, options),
            warn: (message, error) => console.warn(message, error),
        }),
        createBrowserMaterialHandler({ready: configReady, config, vocabularyBook}),
        ...createVocabularyBackgroundHandlers({
            configReady, vocabularyBook,
            isVocabularyBookEnabled: () => config.vocabularyBookEnabled === true, isReencounterEnabled: () => config.on && config.vocabularyReencounterEnabled === true && !browser.extension.inIncognitoContext,
            ...createBrowserVocabularyUndoOptions(),
            broadcastChanged: createBrowserVocabularyBookChangedBroadcaster({
                sendRuntimeMessage: (message) => browser.runtime.sendMessage(message), ...tabBroadcast,
            }),
            logOperationFailure: (error) => console.error('[FluentRead] vocabulary book operation failed:', error),
        }),
        ...createVideoSubtitleBackgroundRuntime(),
        ...createLocalModelMessageHandlers<BackgroundRuntimeContext>(),
        createDownloadProgressHandler({runtimeId: browser.runtime.id, offscreenUrl: browser.runtime.getURL('/offscreen.html'), storage: browser.storage.local}), createDownloadProgressQueryHandler({runtimeId: browser.runtime.id, storage: browser.storage.local}),
    ];
    const router = createBackgroundMessageRouter(handlers,
        createTranslationRequestFallback({
            translate: translateWithCache,
            serializeError: serializeTranslationError,
            requestRegistry: translationRequestRegistry,
        }),
    );
    const listener = createBackgroundRuntimeMessageListener(router, (sender) => ({sender}) as BackgroundRuntimeContext);
    browser.runtime.onMessage.addListener(listener);
    if (capabilities.browser === 'safari') {
        const removePageListener = installExtensionPageMessageListener(window as unknown as ExtensionPageMessageTarget, listener);
        window.addEventListener('pagehide', removePageListener, {once: true});
    }
    selectionPageZoom.installZoomChangeListener();
    browser.tabs.onRemoved.addListener((tabId: number) => releaseVideoSubtitleOwnerForTab(Number(tabId)));
    installBrowserConfigStorageBroadcast(tabBroadcast);
}
