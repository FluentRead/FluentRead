/**
 * @file src/app/background/messageRuntime.ts
 * 文件职责：构建并安装后台消息总运行时，把配置、翻译、OCR、TTS、生词本和标签页状态等公开 handler 连接到 browser.runtime。
 * 主要内容：创建图片 OCR 语言仓库和能力门控传输，绑定图片与圈选事务的真实页面及术语版本；注入配置、翻译、本机统计（模型用量与翻译统计）和词典依赖，注册类型化 router 并管理响应与错误。
 * 模块边界：本文件是 composition root，只决定依赖装配和监听生命周期，不实现各 feature 的业务算法、provider 协议或存储事务；具体实现均来自 features、services、providers 与 platform。
 */
import {formatConnectionTestError, runTranslationServiceConnectionTestWithUsage} from './providerRuntime';
import {config, configReady} from '@/src/services/config/store';
import {lookupWord} from '@/src/features/selection-translation/services/wordDictionary';
import {synthesizeEdgeTts} from '@/src/features/selection-translation/services/edgeTts';
import {vocabularyBook} from '@/src/features/vocabulary/repository';
import {clearTranslationCache, getTranslationCacheStats, translateWithCache} from '@/src/app/translation/runtime';
import {serializeTranslationError} from '@/src/services/translation/errors';
import {createBackgroundMessageRouter, createBackgroundRuntimeMessageListener, type BackgroundMessageHandler} from './messageRouter';
import {type AreaTranslationBackgroundContext} from './handlers/areaTranslation';
import {createAreaTranslationRuntime} from './areaRuntime';
import {createTranslationCacheHandlers, createTranslationCacheInvalidationBroadcaster} from './handlers/translationCache';
import {type ConfigPersistenceContext} from './handlers/configPersistence';
import {createConnectionTestHandler} from './handlers/connectionTest';
import {
    createFullPageTranslationStateHandlers, createQqMailFrameBackgroundHandlers,
    type FullPageBackgroundContext, type QQMailFrameBackgroundContext,
} from './handlers/fullPageTranslationState';
import {createImageOcrLanguageRepository, createImageTranslationBackgroundHandlers} from './handlers/imageTranslation';
import {createInputBoxTranslationHandler} from './handlers/inputTranslation';
import {createLocalInsightsHandlers} from './localInsightsHandlers';
import {createFreeTranslationWeightsHandler} from './handlers/freeTranslationWeights';
import {createOpenOptionsPageHandler} from './handlers/openOptions';
import {createTranslationCancelHandler, createTranslationRequestFallback, createTranslationRequestRegistry} from './handlers/translation';
import {createSelectionTtsBackgroundHandlers, type SelectionTtsContext} from './handlers/selectionTts';
import {createSelectionWordLookupHandler} from './handlers/selectionWordLookup';
import {isBrowserTabId, type TabTranslationStateStore} from './tabTranslationState';
import {createBrowserVocabularyBookChangedBroadcaster, createVocabularyBackgroundHandlers, type VocabularyBackgroundContext} from './handlers/vocabulary';
import {browserCapabilities, type BrowserCapabilities} from '@/src/platform/browser/capabilities';
import {supportsTranslationBatch} from '@/src/services/translation/capabilities';
import {imageTranslationOffscreenAdapter, imageTranslationProgressTransport} from '@/src/features/image-translation/background/offscreenAdapter';
import {selectionTtsOffscreenAdapter} from '@/src/features/selection-translation/background/offscreenAdapter';
import {createCapabilityGatedBackgroundHandlers, createCapabilityGatedSelectionTtsTransport} from './capabilityRegistry';
import {createConfigBackgroundHandlers} from './configMessageHandlers';
import {createConfigImageOcrLanguageStorage, installBrowserConfigStorageBroadcast} from './configStorageRuntime';
import {releaseVideoSubtitleOwnerForTab} from '@/src/features/video-subtitle/background/handlers';
import {createVideoSubtitleBackgroundRuntime} from '@/src/features/video-subtitle/background/runtime';
import {createLocalTranslationBackgroundRuntime} from '@/src/features/local-translation/background/runtime';
import {createLocalTtsBackgroundRuntime} from '@/src/features/local-tts/background/runtime';
import {localTtsOffscreenAdapter} from '@/src/features/local-tts/background/offscreenAdapter';
import {createSelectionTtsSynthesizer} from '@/src/features/selection-translation/background/selectionTtsSynthesis';
import {installWritingBackgroundRuntime} from './writingRuntime';
import {installHarnessBackgroundRuntime} from './harnessRuntime';
import {createImageGlossaryContext} from './imageGlossaryContext';
import {buildGlossaryRevision} from '@/src/core/glossary';
import {getFreeTranslationWeightSnapshot} from '@/src/providers/translation/free-translation';
type BackgroundRuntimeContext = QQMailFrameBackgroundContext & ConfigPersistenceContext & VocabularyBackgroundContext & SelectionTtsContext
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
        createConnectionTestHandler({
            ready: configReady,
            runConnectionTest: runTranslationServiceConnectionTestWithUsage,
            formatError: formatConnectionTestError,
        }),
        createInputBoxTranslationHandler({
            ready: configReady,
            getConfig: () => config,
            translate: translateWithCache,
        }),
        createOpenOptionsPageHandler({
            openDefaultPage: () => browser.runtime.openOptionsPage(),
            openSection: async (section) => {
                await browser.tabs.create({url: `${browser.runtime.getURL('/options.html')}#${section}`});
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
            translate: translateWithCache,
            warn: (message, error) => console.warn(message, error),
        }),
        ...imageGlossaryContext.wrap(createCapabilityGatedBackgroundHandlers<BackgroundRuntimeContext>(capabilities, {
            areaTranslation: () => createAreaTranslationRuntime(imageOcrLanguageRepository.assertDownloaded),
            imageTranslation: () => createImageTranslationBackgroundHandlers({
                assertLanguagesDownloaded: imageOcrLanguageRepository.assertDownloaded,
                ...imageTranslationOffscreenAdapter,
                translateTexts: translateWithCache,
                getTranslationService: () => config.service,
                supportsBatchTranslation: supportsTranslationBatch,
                markLanguagesDownloaded: imageOcrLanguageRepository.markDownloaded,
                markLanguagesRemoved: imageOcrLanguageRepository.markRemoved,
                ...imageTranslationProgressTransport,
            }),
        })),
        ...createSelectionTtsBackgroundHandlers({
            getPreferredVoices: () => config.selectionTtsVoices,
            synthesize: selectionTtsSynthesizer,
            playWithOffscreen: selectionTtsTransport.play,
            stopWithOffscreen: selectionTtsTransport.stop,
            offscreenPlaybackEnabled: capabilities.selectionTtsExtensionPlayback,
            sendTabMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
            warn: (message, error) => console.warn(message, error),
        }),
        ...createVocabularyBackgroundHandlers({
            configReady,
            isVocabularyBookEnabled: () => config.vocabularyBookEnabled === true,
            vocabularyBook,
            broadcastChanged: createBrowserVocabularyBookChangedBroadcaster({
                sendRuntimeMessage: (message) => browser.runtime.sendMessage(message),
                queryTabs: () => browser.tabs.query({}) as Promise<Array<{id?: number}>>,
                sendTabMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
            }),
            logOperationFailure: (error) => console.error('[FluentRead] vocabulary book operation failed:', error),
        }),
        ...createVideoSubtitleBackgroundRuntime(),
        ...createLocalTranslationBackgroundRuntime(),
        ...createLocalTtsBackgroundRuntime(),
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
    browser.tabs.onRemoved.addListener((tabId: number) => releaseVideoSubtitleOwnerForTab(Number(tabId)));
    installBrowserConfigStorageBroadcast();
}
