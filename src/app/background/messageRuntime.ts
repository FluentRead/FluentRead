/**
 * @file src/app/background/messageRuntime.ts
 * 文件职责：构建并安装后台消息总运行时，把配置、翻译、OCR、TTS、生词本和标签页状态等公开 handler 连接到 browser.runtime。
 * 主要内容：创建图片 OCR 语言仓库和能力门控传输，绑定图片与圈选事务的真实页面及术语版本；注入配置、翻译、模型用量和词典依赖，注册类型化 router 并管理响应与错误。
 * 模块边界：本文件是 composition root，只决定依赖装配和监听生命周期，不实现各 feature 的业务算法、provider 协议或存储事务；具体实现均来自 features、services、providers 与 platform。
 */
import {formatConnectionTestError, runTranslationServiceConnectionTestWithUsage, translateMicrosoftTexts} from './providerRuntime';
import {config, configReady} from '@/src/services/config/store';
import {synthesizeEdgeTts} from '@/src/features/selection-translation/services/edgeTts';
import {lookupWord} from '@/src/features/selection-translation/services/wordDictionary';
import {vocabularyBook} from '@/src/features/vocabulary/repository';
import {clearTranslationCache, getTranslationCacheStats, translateWithCache} from '@/src/app/translation/runtime';
import {serializeTranslationError} from '@/src/services/translation/errors';
import {createBackgroundMessageRouter, type BackgroundMessageHandler} from './messageRouter';
import {createAreaTranslationBackgroundHandlers, createAreaCaptureOwnershipVerifier, type AreaTranslationBackgroundContext} from './handlers/areaTranslation';
import {createTranslationCacheHandlers, createTranslationCacheInvalidationBroadcaster} from './handlers/translationCache';
import {type ConfigPersistenceContext} from './handlers/configPersistence';
import {createConnectionTestHandler} from './handlers/connectionTest';
import {
    createFullPageTranslationStateHandlers, createQqMailFrameBackgroundHandlers,
    type FullPageBackgroundContext, type QQMailFrameBackgroundContext,
} from './handlers/fullPageTranslationState';
import {createImageOcrLanguageRepository, createImageTranslationBackgroundHandlers} from './handlers/imageTranslation';
import {createInputBoxTranslationHandler} from './handlers/inputTranslation';
import {createModelUsageHandler} from './handlers/modelUsage';
import {createOpenOptionsPageHandler} from './handlers/openOptions';
import {createTranslationCancelHandler, createTranslationRequestFallback, createTranslationRequestRegistry} from './handlers/translation';
import {createSelectionTtsBackgroundHandlers, type SelectionTtsContext} from './handlers/selectionTts';
import {createSelectionWordLookupHandler} from './handlers/selectionWordLookup';
import {isBrowserTabId, type TabTranslationStateStore} from './tabTranslationState';
import {createBrowserVocabularyBookChangedBroadcaster, createVocabularyBackgroundHandlers, type VocabularyBackgroundContext} from './handlers/vocabulary';
import {browserCapabilities, type BrowserCapabilities} from '@/src/platform/browser/capabilities';
import {supportsTranslationBatch} from '@/src/services/translation/capabilities';
import {prepareAreaTextTranslation} from '@/src/features/area-translation/services/textTranslation';
import {areaTranslationOffscreenAdapter} from '@/src/features/area-translation/background/offscreenAdapter';
import {imageTranslationOffscreenAdapter, imageTranslationProgressTransport} from '@/src/features/image-translation/background/offscreenAdapter';
import {selectionTtsOffscreenAdapter} from '@/src/features/selection-translation/background/offscreenAdapter';
import {createCapabilityGatedBackgroundHandlers, createCapabilityGatedSelectionTtsTransport} from './capabilityRegistry';
import {createConfigBackgroundHandlers} from './configMessageHandlers';
import {createConfigImageOcrLanguageStorage, installBrowserConfigStorageBroadcast} from './configStorageRuntime';
import {modelUsageRepository} from '@/src/platform/storage/modelUsageRepository';
import {releaseVideoSubtitleOwnerForTab} from '@/src/features/video-subtitle/background/handlers';
import {createVideoSubtitleBackgroundRuntime} from '@/src/features/video-subtitle/background/runtime';
import {installWritingBackgroundRuntime} from './writingRuntime';
import {installHarnessBackgroundRuntime} from './harnessRuntime';
import {createImageGlossaryContext} from './imageGlossaryContext';
import {buildGlossaryRevision} from '@/src/core/glossary';
type BackgroundRuntimeContext = QQMailFrameBackgroundContext & ConfigPersistenceContext & VocabularyBackgroundContext & SelectionTtsContext
    & FullPageBackgroundContext & AreaTranslationBackgroundContext;
export interface BackgroundMessageRuntimeOptions {
    tabTranslationStates: TabTranslationStateStore;
    onFullPageStateChanged(tabId: number): void;
    capabilities?: BrowserCapabilities;
}
/** 用静态 handler registry 组装唯一的 runtime.onMessage 入口。 */
export function installBackgroundMessageRuntime(options: BackgroundMessageRuntimeOptions): void {
    installWritingBackgroundRuntime();
    const capabilities = options.capabilities ?? browserCapabilities;
    const translationRequestRegistry = createTranslationRequestRegistry();
    const imageOcrLanguageRepository = createImageOcrLanguageRepository(createConfigImageOcrLanguageStorage());
    const selectionTtsTransport = createCapabilityGatedSelectionTtsTransport(capabilities, selectionTtsOffscreenAdapter);
    const imageGlossaryContext = createImageGlossaryContext<BackgroundRuntimeContext>({
        ready: configReady,
        offscreenUrl: browser.runtime.getURL('/offscreen.html'),
        getSourceLanguage: () => config.from,
        getGlossaryRevision: () => buildGlossaryRevision(config.glossaryLibraries, config.glossaryEnabled),
    });
    const handlers: Array<BackgroundMessageHandler<BackgroundRuntimeContext>> = [
        createTranslationCancelHandler(translationRequestRegistry),
        installHarnessBackgroundRuntime(),
        ...createQqMailFrameBackgroundHandlers({sendTabMessage: (tabId, message, options) => browser.tabs.sendMessage(tabId, message, options)}),
        ...createTranslationCacheHandlers(clearTranslationCache, getTranslationCacheStats, createTranslationCacheInvalidationBroadcaster({
            queryTabs: () => browser.tabs.query({}) as Promise<Array<{id?: number}>>,
            sendTabMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
            warn: (message, error) => console.warn(message, error),
        })),
        createModelUsageHandler(modelUsageRepository, (url) => url.startsWith(browser.runtime.getURL('/options.html'))),
        ...createConfigBackgroundHandlers<BackgroundRuntimeContext>(),
        createConnectionTestHandler({
            ready: configReady,
            runConnectionTest: runTranslationServiceConnectionTestWithUsage,
            formatError: formatConnectionTestError,
        }),
        createInputBoxTranslationHandler({
            translateText: async (text, targetLanguage) => {
                const translations = await translateMicrosoftTexts([text], '', targetLanguage);
                return translations[0] || '';
            },
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
            areaTranslation: () => createAreaTranslationBackgroundHandlers({
                captureVisibleTab: (windowId) => browser.tabs.captureVisibleTab(windowId, {format: 'png'}),
                assertCaptureOwner: createAreaCaptureOwnershipVerifier(tabId => browser.tabs.get(tabId)),
                getDefaultSourceLanguage: () => config.from,
                assertLanguagesDownloaded: imageOcrLanguageRepository.assertDownloaded,
                translateArea: areaTranslationOffscreenAdapter.translateArea,
                prepareTextTranslation: (language, title, context) => prepareAreaTextTranslation(config, language, title,
                    {pageUrl: context.sender?.url, context: 'page'}, translateWithCache),
                sendProgress: imageTranslationProgressTransport.sendProgress,
            }),
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
            synthesize: synthesizeEdgeTts,
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
    ];
    const router = createBackgroundMessageRouter(
        handlers,
        createTranslationRequestFallback({
            translate: translateWithCache,
            serializeError: serializeTranslationError,
            requestRegistry: translationRequestRegistry,
        }),
    );
    browser.runtime.onMessage.addListener(async (message: unknown, sender: any) => {
        try {
            const dispatch = await router.dispatch(message, {sender});
            return dispatch.handled ? dispatch.response
                : {success: false, error: '不支持的后台消息'};
        } catch (error) {
            return {success: false, error: error instanceof Error ? error.message : String(error)};
        }
    });
    browser.tabs.onRemoved.addListener((tabId: number) => releaseVideoSubtitleOwnerForTab(Number(tabId)));
    installBrowserConfigStorageBroadcast();
}
