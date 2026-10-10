/**
 * @file tests/backgroundMessageRuntimePrivacy.test.ts
 * 文件职责：从真实后台总消息安装入口验证无 tab 的扩展页面不继承后台自身隐私状态。
 * 主要内容：真实 messageRuntime→router→typed input/fallback→可信 symbol；只替换本用例无关的 feature 构造器和翻译外部端口。
 * 模块边界：不手工调用 context factory，不启动浏览器，不读取用户配置或访问网络。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
const state = vi.hoisted(() => ({config: {} as Record<string, any>, translate: vi.fn()}));
vi.mock('@/src/services/config/store', () => ({config: state.config, configReady: Promise.resolve()}));
vi.mock('@/src/app/translation/runtime', () => ({translateWithCache: state.translate, clearTranslationCache: vi.fn(), getTranslationCacheStats: vi.fn()}));
vi.mock('@/src/app/background/providerRuntime', () => ({getFreeTranslationWeightSnapshot: vi.fn(), createProviderTestRuntimeHandlers: () => []}));
vi.mock('@/src/features/selection-translation/services/wordDictionary', () => ({lookupWord: vi.fn()}));
vi.mock('@/src/features/selection-translation/background/pageZoomHandler', () => ({createSelectionPageZoomBrowserPort: () => ({getZoom: vi.fn(), installZoomChangeListener: vi.fn()}), createSelectionPageZoomHandler: () => ({type: 'fixture-zoom', handle: vi.fn()})}));
vi.mock('@/src/features/selection-translation/services/edgeTts', () => ({synthesizeEdgeTts: vi.fn()}));
vi.mock('@/src/features/vocabulary/repository', () => ({vocabularyBook: {}}));
vi.mock('@/src/app/background/areaRuntime', () => ({createAreaTranslationRuntime: () => []}));
vi.mock('@/src/app/background/handlers/translationCache', () => ({createTranslationCacheHandlers: () => [], createTranslationCacheInvalidationBroadcaster: vi.fn()}));
vi.mock('@/src/app/background/handlers/fullPageTranslationState', () => ({createFullPageTranslationStateHandlers: () => [], createQqMailFrameBackgroundHandlers: () => []}));
vi.mock('@/src/features/full-page-translation/background/neteaseMailFrameHandlers', () => ({createNeteaseMailFrameBackgroundHandlers: () => []}));
vi.mock('@/src/app/background/handlers/imageTranslation', () => ({createImageOcrLanguageRepository: () => ({assertDownloaded: vi.fn(), getDownloaded: vi.fn(), markDownloaded: vi.fn(), markRemoved: vi.fn()}), createImageTranslationBackgroundHandlers: () => []}));
vi.mock('@/src/app/background/localInsightsHandlers', () => ({createLocalInsightsHandlers: () => []}));
vi.mock('@/src/app/background/handlers/freeTranslationWeights', () => ({createFreeTranslationWeightsHandler: () => ({type: 'fixture-weights', handle: vi.fn()})}));
vi.mock('@/src/app/background/handlers/openOptions', () => ({createOpenOptionsPageHandler: () => ({type: 'fixture-options', handle: vi.fn()})}));
vi.mock('@/src/app/background/handlers/downloadProgress', () => ({createDownloadProgressHandler: () => ({type: 'fixture-download', handle: vi.fn()}), createDownloadProgressQueryHandler: () => ({type: 'fixture-download-query', handle: vi.fn()})}));
vi.mock('@/src/app/background/handlers/selectionTts', () => ({createSelectionTtsBackgroundHandlers: () => []}));
vi.mock('@/src/app/background/handlers/selectionWordLookup', () => ({createSelectionWordLookupHandler: () => ({type: 'fixture-word', handle: vi.fn()})}));
vi.mock('@/src/app/background/handlers/vocabulary', () => ({createBrowserVocabularyBookChangedBroadcaster: vi.fn(), createVocabularyBackgroundHandlers: () => []}));
vi.mock('@/src/platform/browser/capabilities', () => ({browserCapabilities: {}}));
vi.mock('@/src/features/image-translation/background/offscreenAdapter', () => ({imageTranslationOffscreenAdapter: {}, imageTranslationProgressTransport: {}, imageTranslationSourceTransport: {}}));
vi.mock('@/src/features/selection-translation/background/offscreenAdapter', () => ({selectionTtsOffscreenAdapter: {}}));
vi.mock('@/src/app/background/capabilityRegistry', () => ({createCapabilityGatedBackgroundHandlers: () => [], createCapabilityGatedSelectionTtsTransport: () => ({})}));
vi.mock('@/src/app/background/configMessageHandlers', () => ({createConfigBackgroundHandlers: () => []}));
vi.mock('@/src/app/background/configStorageRuntime', () => ({createConfigImageOcrLanguageStorage: vi.fn(), installBrowserConfigStorageBroadcast: vi.fn()}));
vi.mock('@/src/features/video-subtitle/background/handlers', () => ({releaseVideoSubtitleOwnerForTab: vi.fn()}));
vi.mock('@/src/features/video-subtitle/background/runtime', () => ({createVideoSubtitleBackgroundRuntime: () => []}));
vi.mock('@/src/features/local-translation/background/runtime', () => ({createLocalTranslationBackgroundRuntime: () => []}));
vi.mock('@/src/features/local-tts/background/runtime', () => ({createLocalTtsBackgroundRuntime: () => []}));
vi.mock('@/src/features/local-tts/background/offscreenAdapter', () => ({localTtsOffscreenAdapter: {synthesize: vi.fn()}}));
vi.mock('@/src/features/selection-translation/background/selectionTtsSynthesis', () => ({createSelectionTtsSynthesizer: vi.fn()}));
vi.mock('@/src/app/background/writingRuntime', () => ({installWritingBackgroundRuntime: () => vi.fn()}));
vi.mock('@/src/app/background/harnessRuntime', () => ({installHarnessBackgroundRuntime: () => ({type: 'fixture-harness', handle: vi.fn()})}));
vi.mock('@/src/features/full-page-translation/background/embeddedFrameHandlers', () => ({createEmbeddedFrameBackgroundHandlers: () => []}));
import {installBackgroundMessageRuntime} from '@/src/app/background/messageRuntime';
import {TabTranslationStateStore} from '@/src/app/background/tabTranslationState';
import {getTranslationGlossaryContext} from '@/src/services/translation/requestSnapshot';
import {Config} from '@/src/core/config/model';
beforeEach(() => {Object.assign(state.config, new Config()); state.translate.mockReset().mockResolvedValue('synthetic translated');});
afterEach(() => {vi.unstubAllGlobals();});
function installed(backgroundPrivate: boolean) {
    let listener!: (message: unknown, sender: unknown) => Promise<unknown>;
    vi.stubGlobal('browser', {extension: {inIncognitoContext: backgroundPrivate},
        runtime: {id: 'controlled', getURL: (path: string) => 'chrome-extension://controlled/' + path.replace(/^\//u, ''), onMessage: {addListener: (value: typeof listener) => {listener = value;}}},
        tabs: {onRemoved: {addListener: vi.fn()}}, storage: {local: {}}});
    installBackgroundMessageRuntime({tabTranslationStates: new TabTranslationStateStore(), onFullPageStateChanged: vi.fn()});
    return listener;
}
function request(kind: string, claimed: boolean) {
    const forged = {privateContext: claimed, incognito: claimed, sender: {tab: {incognito: claimed}}, quotaScope: 'page-forged'};
    return kind === 'typed' ? {type: 'inputBoxTranslation', text: 'synthetic input', targetLang: 'zh-Hans', ...forged}
        : {origin: 'synthetic fallback', useCache: false, ...forged};
}
describe('actual messageRuntime privacy mapping', () => {
    it.each([false, true].flatMap(backgroundPrivate => ['typed', 'fallback'].map(kind => [backgroundPrivate, kind] as const)))
    ('keeps a no-tab extension sender unknown when background is %s through %s', async (backgroundPrivate, kind) => {
        const listener = installed(backgroundPrivate);
        const result = await listener(request(kind, backgroundPrivate), {id: 'controlled', url: 'chrome-extension://controlled/popup.html'});
        expect(result).toBeDefined(); expect(state.translate).toHaveBeenCalledOnce();
        expect(getTranslationGlossaryContext(state.translate.mock.calls[0]![0])?.privateContext).toBeUndefined();
    });
    it.each([false, true].flatMap(senderPrivate => ['typed', 'fallback'].map(kind => [senderPrivate, kind] as const)))
    ('uses the actual sender tab %s rather than background or payload through %s', async (senderPrivate, kind) => {
        const listener = installed(!senderPrivate);
        await listener(request(kind, !senderPrivate), {id: 'controlled', url: 'https://synthetic.test/', tab: {id: 4, incognito: senderPrivate}});
        expect(state.translate).toHaveBeenCalledOnce();
        expect(getTranslationGlossaryContext(state.translate.mock.calls[0]![0])?.privateContext).toBe(senderPrivate);
    });
});
