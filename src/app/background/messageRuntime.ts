/**
 * @file src/app/background/messageRuntime.ts
 * 文件职责：构建并安装后台消息总运行时，把配置、翻译、OCR、TTS、生词本和标签页状态等公开 handler 连接到 browser.runtime。
 * 主要内容：只转交真实 sender 隐私，无 tab 来源保持未知，不把后台自身的隐私状态当成发送者；向图片处理注入已保存的单图识别方式；创建图片 OCR 语言仓库和能力门控传输，绑定图片与圈选事务的真实页面及术语版本；为图片和划词释义注入独立服务选择，注入配置、翻译、本机统计、划词卡片页面缩放和词典依赖，为 TTS 状态注入离屏发送方校验与 frame 投递端口，接入离屏下载进度转存，注册类型化 router 并管理响应与错误。
 * 模块边界：本文件是 composition root，只决定依赖装配和监听生命周期，不实现各 feature 的业务算法、provider 协议或存储事务；具体实现均来自 features、services、providers 与 platform。
 */
import {getFreeTranslationWeightSnapshot, createProviderTestRuntimeHandlers} from './providerRuntime';
import {config, configReady} from '@/src/services/config/store';
import {lookupWord} from '@/src/features/selection-translation/services/wordDictionary';
import {createSelectionPageZoomBrowserPort, createSelectionPageZoomHandler} from '@/src/features/selection-translation/background/pageZoomHandler';
import {synthesizeEdgeTts} from '@/src/features/selection-translation/services/edgeTts';
import {vocabularyBook} from '@/src/features/vocabulary/repository';
import {clearTranslationCache, getTranslationCacheStats, translateWithCache} from '@/src/app/translation/runtime';
import {serializeTranslationError} from '@/src/services/translation/errors';
import {createBackgroundMessageRouter, createBackgroundRuntimeMessageListener, type BackgroundMessageHandler} from './messageRouter';
import {type AreaTranslationBackgroundContext} from './handlers/areaTranslation';
import {createAreaTranslationRuntime} from './areaRuntime';
import {createTranslationCacheHandlers, createTranslationCacheInvalidationBroadcaster} from './handlers/translationCache';
import {type ConfigPersistenceContext} from './handlers/configPersistence';
import {
    createFullPageTranslationStateHandlers, createQqMailFrameBackgroundHandlers,
    type FullPageBackgroundContext, type QQMailFrameBackgroundContext,
} from './handlers/fullPageTranslationState';
import {createNeteaseMailFrameBackgroundHandlers, type NeteaseMailFrameBackgroundContext} from '@/src/features/full-page-translation/background/neteaseMailFrameHandlers';
import {createImageOcrLanguageRepository, createImageTranslationBackgroundHandlers} from './handlers/imageTranslation';
import {createInputBoxTranslationHandler} from './handlers/inputTranslation';
import {createLocalInsightsHandlers} from './localInsightsHandlers';
import {createFreeTranslationWeightsHandler} from './handlers/freeTranslationWeights';
import {createOpenOptionsPageHandler} from './handlers/openOptions';
import {createDownloadProgressHandler, createDownloadProgressQueryHandler} from './handlers/downloadProgress';
import {createTranslationCancelHandler, createTranslationRequestFallback, createTranslationRequestRegistry} from './handlers/translation';
import {createSelectionTtsBackgroundHandlers, type SelectionTtsContext} from './handlers/selectionTts';
import {createSelectionWordLookupHandler} from './handlers/selectionWordLookup';
import {isBrowserTabId, type TabTranslationStateStore} from './tabTranslationState';
import {createBrowserVocabularyBookChangedBroadcaster, createVocabularyBackgroundHandlers, type VocabularyBackgroundContext} from './handlers/vocabulary';
import {browserCapabilities, type BrowserCapabilities} from '@/src/platform/browser/capabilities';
import {supportsTranslationBatch} from '@/src/services/translation/capabilities';
import {imageTranslationOffscreenAdapter, imageTranslationProgressTransport, imageTranslationSourceTransport} from '@/src/features/image-translation/background/offscreenAdapter';
import {selectionTtsOffscreenAdapter} from '@/src/features/selection-translation/background/offscreenAdapter';
import {createCapabilityGatedBackgroundHandlers, createCapabilityGatedSelectionTtsTransport} from './capabilityRegistry';
import {createConfigBackgroundHandlers} from './configMessageHandlers';
import {createConfigImageOcrLanguageStorage, installBrowserConfigStorageBroadcast} from './configStorageRuntime';
import {releaseVideoSubtitleOwnerForTab} from '@/src/features/video-subtitle/background/handlers';
import {createVideoSubtitleBackgroundRuntime} from '@/src/features/video-subtitle/background/runtime';
import {createLocalModelMessageHandlers} from './localModelMessageRuntime';
import {localTtsOffscreenAdapter} from '@/src/features/local-tts/background/offscreenAdapter';
import {createSelectionTtsSynthesizer} from '@/src/features/selection-translation/background/selectionTtsSynthesis';
import {installWritingBackgroundRuntime} from './writingRuntime';
import {installHarnessBackgroundRuntime} from './harnessRuntime';
import {createImageGlossaryContext} from './imageGlossaryContext';
import {createEmbeddedFrameBackgroundHandlers, type EmbeddedFrameBackgroundContext} from '@/src/features/full-page-translation/background/embeddedFrameHandlers';
import {buildGlossaryRevision} from '@/src/core/glossary';
type BackgroundRuntimeContext = QQMailFrameBackgroundContext & NeteaseMailFrameBackgroundContext
    & EmbeddedFrameBackgroundContext & ConfigPersistenceContext & VocabularyBackgroundContext & SelectionTtsContext
    & FullPageBackgroundContext & AreaTranslationBackgroundContext;
export interface BackgroundMessageRuntimeOptions {
    tabTranslationStates: TabTranslationStateStore;
    onFullPageStateChanged(tabId: number): void;
    capabilities?: BrowserCapabilities;
}
/** 用静态 handler registry 组装唯一的 runtime.onMessage 入口。 */
export function installBackgroundMessageRuntime(options: BackgroundMessageRuntimeOptions): void {
    const cancelWriting = installWritingBackgroundRuntime();
    const capabilities = options.capabilities ?? browserCapabilities;
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
        createTranslationCancelHandler(translationRequestRegistry),
        installHarnessBackgroundRuntime(cancelWriting),
        ...createQqMailFrameBackgroundHandlers({sendTabMessage: (tabId, message, options) => browser.tabs.sendMessage(tabId, message, options)}),
        ...createEmbeddedFrameBackgroundHandlers({sendTabMessage: (tabId, message, options) => browser.tabs.sendMessage(tabId, message, options)}),
        ...createNeteaseMailFrameBackgroundHandlers({sendTabMessage: (tabId, message, options) => browser.tabs.sendMessage(tabId, message, options)}),
        ...createTranslationCacheHandlers(clearTranslationCache, getTranslationCacheStats, createTranslationCacheInvalidationBroadcaster({
            queryTabs: () => browser.tabs.query({}) as Promise<Array<{id?: number}>>,
            sendTabMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
            warn: (message, error) => console.warn(message, error),
        })),
        ...createLocalInsightsHandlers<BackgroundRuntimeContext>((url) => url.startsWith(browser.runtime.getURL('/options.html'))),
        createFreeTranslationWeightsHandler({
            ready: configReady,
            getSnapshot: getFreeTranslationWeightSnapshot,
            isOptionsUrl: (url) => url.startsWith(browser.runtime.getURL('/options.html')),
        }),
        ...createConfigBackgroundHandlers<BackgroundRuntimeContext>(),
        ...createProviderTestRuntimeHandlers(),
        createInputBoxTranslationHandler({
            ready: configReady,
            getConfig: () => config,
            translate: translateWithCache,
        }),
        createOpenOptionsPageHandler({
            openDefaultPage: () => browser.runtime.openOptionsPage(),
            openSection: async (section, destination) => {
                const query = destination ? `?${section === 'settings-vocabulary' ? 'learningTab' : 'service'}=${encodeURIComponent(destination)}` : '';
                await browser.tabs.create({url: `${browser.runtime.getURL('/options.html')}${query}#${section}`});
            },
        }),
        ...createFullPageTranslationStateHandlers({
            stateStore: options.tabTranslationStates,
            isTabId: isBrowserTabId,
            onStateChanged: options.onFullPageStateChanged,
        }),
        createSelectionWordLookupHandler({
            lookupWord,
            getDefaultTargetLanguage: () => config.to,
            translate: (request) => translateWithCache({...request, serviceOverride: config.selectionTranslationService || config.service}),
            warn: (message, error) => console.warn(message, error),
        }),
        createSelectionPageZoomHandler(selectionPageZoom.getZoom),
        ...imageGlossaryContext.wrap(createCapabilityGatedBackgroundHandlers<BackgroundRuntimeContext>(capabilities, {
            areaTranslation: () => createAreaTranslationRuntime(imageOcrLanguageRepository.assertDownloaded),
            imageTranslation: () => createImageTranslationBackgroundHandlers({
                assertLanguagesDownloaded: imageOcrLanguageRepository.assertDownloaded, getDownloadedLanguages: imageOcrLanguageRepository.getDownloaded,
                ...imageTranslationOffscreenAdapter, ...imageTranslationSourceTransport,
                translateTexts: translateWithCache,
                getTranslationService: () => config.imageTranslationService || config.service, getGlossaryConfig: () => config,
                getImageOcrEngine: () => config.imageTranslationOcrEngine,
                supportsBatchTranslation: supportsTranslationBatch,
                markLanguagesDownloaded: imageOcrLanguageRepository.markDownloaded,
                markLanguagesRemoved: imageOcrLanguageRepository.markRemoved,
                ...imageTranslationProgressTransport,
            }),
        })),
        ...createSelectionTtsBackgroundHandlers({
            playbackStateSender: {runtimeId: browser.runtime.id, url: browser.runtime.getURL('/offscreen.html')},
            getPreferredVoices: () => config.selectionTtsVoices,
            synthesize: selectionTtsSynthesizer,
            playWithOffscreen: selectionTtsTransport.play,
            stopWithOffscreen: selectionTtsTransport.stop,
            seekWithOffscreen: selectionTtsOffscreenAdapter.seek,
            offscreenPlaybackEnabled: capabilities.selectionTtsExtensionPlayback,
            sendTabMessage: (tabId, message, options) => browser.tabs.sendMessage(tabId, message, options),
            warn: (message, error) => console.warn(message, error),
        }),
        ...createVocabularyBackgroundHandlers({
            configReady,
            isVocabularyBookEnabled: () => config.vocabularyBookEnabled === true, isReencounterEnabled: () => config.on && config.vocabularyReencounterEnabled === true && !browser.extension.inIncognitoContext,
            vocabularyBook,
            broadcastChanged: createBrowserVocabularyBookChangedBroadcaster({
                sendRuntimeMessage: (message) => browser.runtime.sendMessage(message),
                queryTabs: () => browser.tabs.query({}) as Promise<Array<{id?: number}>>,
                sendTabMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
            }),
            logOperationFailure: (error) => console.error('[FluentRead] vocabulary book operation failed:', error),
        }),
        ...createVideoSubtitleBackgroundRuntime(),
        ...createLocalModelMessageHandlers<BackgroundRuntimeContext>(),
        createDownloadProgressHandler({runtimeId: browser.runtime.id, offscreenUrl: browser.runtime.getURL('/offscreen.html'), storage: browser.storage.local}), createDownloadProgressQueryHandler({runtimeId: browser.runtime.id, storage: browser.storage.local}),
    ];
    const router = createBackgroundMessageRouter(
        handlers,
        createTranslationRequestFallback({
            translate: translateWithCache,
            serializeError: serializeTranslationError,
            requestRegistry: translationRequestRegistry,
        }),
    );
    browser.runtime.onMessage.addListener(createBackgroundRuntimeMessageListener(router, (sender) => ({sender}) as BackgroundRuntimeContext));
    selectionPageZoom.installZoomChangeListener();
    browser.tabs.onRemoved.addListener((tabId: number) => releaseVideoSubtitleOwnerForTab(Number(tabId)));
    installBrowserConfigStorageBroadcast();
}
