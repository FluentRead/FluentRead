import {describe, expect, it, vi} from 'vitest';

import {
    AREA_CAPTURE_MESSAGE_TYPE,
    AREA_CANCEL_MESSAGE_TYPE,
    AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE,
    createAreaTranslationBackgroundHandlers,
    createAreaCaptureOwnershipVerifier,
    isAreaTranslationSelection,
} from '@/src/features/area-translation/background/handlers';
import {
    createFullPageTranslationStateHandlers,
    FULL_PAGE_TRANSLATION_STATE_MESSAGE_TYPE,
    SITE_EXTENSION_DISABLED_STATE_MESSAGE_TYPE,
} from '@/src/features/full-page-translation/background/stateHandlers';
import {
    createImageTranslationBackgroundHandlers,
    createImageOperationRegistry,
    IMAGE_CANCEL_MESSAGE_TYPE,
    IMAGE_FETCH_MESSAGE_TYPE,
    IMAGE_TEXT_TRANSLATION_TIMEOUT_MS,
    IMAGE_OCR_DOWNLOAD_MESSAGE_TYPE,
    IMAGE_OCR_MESSAGE_TYPE,
    IMAGE_TRANSLATE_MESSAGE_TYPE,
    IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
} from '@/src/features/image-translation/background/handlers';
import {
    createInputBoxTranslationHandler,
    INPUT_BOX_TRANSLATION_MESSAGE_TYPE,
} from '@/src/features/input-translation/background/handler';
import {
    createSelectionWordLookupHandler,
    SELECTION_WORD_LOOKUP_MESSAGE_TYPE,
    translateVisibleWordCardFields,
    type WordCardData,
} from '@/src/features/selection-translation/background/wordLookupHandler';
import {
    createOpenOptionsPageHandler,
    OPEN_OPTIONS_PAGE_MESSAGE_TYPE,
    OPTIONS_SECTION_IDS,
} from '@/src/features/settings/background/openOptionsHandler';
import {navigationItems, NAVIGATION_SECTION_ALIASES} from '@/src/features/settings/model/navigation';
import {isBrowserTabId, TabTranslationStateStore} from '@/src/app/background/tabTranslationState';
import {getTranslationRequestControl} from '@/src/services/translation/requestSnapshot';

function wordCard(definitions: Array<{definition: string; example?: string; translatedDefinition?: string; translatedExample?: string}> = [
    {definition: 'to move quickly', example: 'Run home.'},
]): WordCardData {
    return {
        word: 'run',
        normalizedWord: 'run',
        phonetics: [{text: '/rʌn/'}],
        meanings: [{partOfSpeech: '动词', definitions}],
        origin: 'old english',
        sources: [{id: 'free-dictionary', label: 'Test', url: 'https://example.com'}],
    };
}

describe('后台 feature handlers', () => {
    it('输入框翻译严格验证 payload，并保留原文本与 provider 结果', async () => {
        const translateText = vi.fn(async () => ' 译文 ');
        const handler = createInputBoxTranslationHandler({translateText});

        await expect(handler.handle({
            type: INPUT_BOX_TRANSLATION_MESSAGE_TYPE,
            text: ' hello ',
            targetLang: 'zh',
        })).resolves.toEqual({success: true, translatedText: ' 译文 '});
        expect(translateText).toHaveBeenCalledWith(' hello ', 'zh');

        await expect(handler.handle({type: INPUT_BOX_TRANSLATION_MESSAGE_TYPE, text: 1, targetLang: 'zh'}))
            .rejects.toThrow('text 必须是字符串');
        await expect(handler.handle({type: INPUT_BOX_TRANSLATION_MESSAGE_TYPE, text: ' ', targetLang: 'zh'}))
            .rejects.toThrow('text 不能为空');
        await expect(handler.handle({type: INPUT_BOX_TRANSLATION_MESSAGE_TYPE, text: 'hello', targetLang: null}))
            .rejects.toThrow('targetLang 必须是字符串');
        await expect(handler.handle({type: INPUT_BOX_TRANSLATION_MESSAGE_TYPE, text: 'hello', targetLang: ''}))
            .rejects.toThrow('targetLang 不能为空');

        translateText.mockResolvedValueOnce('');
        await expect(handler.handle({type: INPUT_BOX_TRANSLATION_MESSAGE_TYPE, text: 'hello', targetLang: 'zh'}))
            .rejects.toThrow('微软翻译未返回译文');
        translateText.mockResolvedValueOnce(undefined as unknown as string);
        await expect(handler.handle({type: INPUT_BOX_TRANSLATION_MESSAGE_TYPE, text: 'hello', targetLang: 'zh'}))
            .rejects.toThrow('微软翻译未返回译文');
    });

    it('设置页 handler 区分默认入口与白名单 section', async () => {
        const openDefaultPage = vi.fn(async () => undefined);
        const openSection = vi.fn(async () => undefined);
        const handler = createOpenOptionsPageHandler({openDefaultPage, openSection});

        await expect(handler.handle({type: OPEN_OPTIONS_PAGE_MESSAGE_TYPE})).resolves.toEqual({success: true});
        await expect(handler.handle({type: OPEN_OPTIONS_PAGE_MESSAGE_TYPE, section: 'settings-video'}))
            .resolves.toEqual({success: true});
        await expect(handler.handle({type: OPEN_OPTIONS_PAGE_MESSAGE_TYPE, section: 'settings-webpage'}))
            .resolves.toEqual({success: true});
        await expect(handler.handle({type: OPEN_OPTIONS_PAGE_MESSAGE_TYPE, section: 'settings-shortcuts'}))
            .resolves.toEqual({success: true});
        await expect(handler.handle({type: OPEN_OPTIONS_PAGE_MESSAGE_TYPE, section: 'settings-area-translation'}))
            .resolves.toEqual({success: true});
        expect(openDefaultPage).toHaveBeenCalledOnce();
        expect(openSection).toHaveBeenNthCalledWith(1, 'settings-video');
        expect(openSection).toHaveBeenNthCalledWith(2, 'settings-translation');
        expect(openSection).toHaveBeenNthCalledWith(3, 'settings-translation');
        expect(openSection).toHaveBeenNthCalledWith(4, 'settings-area-translation');

        await expect(handler.handle({type: OPEN_OPTIONS_PAGE_MESSAGE_TYPE, section: 'settings-secret'}))
            .rejects.toThrow('无效的设置页面');
        await expect(handler.handle({type: OPEN_OPTIONS_PAGE_MESSAGE_TYPE, section: 1}))
            .rejects.toThrow('无效的设置页面');
    });

    it('所有真实导航分区与兼容别名均能从页面打开，未知目标没有导航副作用', async () => {
        const openDefaultPage = vi.fn(async () => undefined);
        const openSection = vi.fn(async () => undefined);
        const handler = createOpenOptionsPageHandler({openDefaultPage, openSection});
        expect(OPTIONS_SECTION_IDS).toEqual(navigationItems.map(item => item.id));
        for (const item of navigationItems) {
            await expect(handler.handle({type: OPEN_OPTIONS_PAGE_MESSAGE_TYPE, section: item.id})).resolves.toEqual({success: true});
            expect(openSection).toHaveBeenLastCalledWith(item.id);
        }
        for (const [alias, canonical] of NAVIGATION_SECTION_ALIASES) {
            await expect(handler.handle({type: OPEN_OPTIONS_PAGE_MESSAGE_TYPE, section: alias})).resolves.toEqual({success: true});
            expect(openSection).toHaveBeenLastCalledWith(canonical);
        }
        const expectedCalls = navigationItems.length + NAVIGATION_SECTION_ALIASES.size;
        for (const section of [null, {}, [], '', 'settings-missing', '#settings-harness', 'https://example.com']) {
            await expect(handler.handle({type: OPEN_OPTIONS_PAGE_MESSAGE_TYPE, section})).rejects.toThrow('无效的设置页面');
        }
        expect(openSection).toHaveBeenCalledTimes(expectedCalls);
        expect(openDefaultPage).not.toHaveBeenCalled();
    });

    it('全文状态 handler 复用状态仓库且不丢失 tabId=0', () => {
        const stateStore = new TabTranslationStateStore();
        const onStateChanged = vi.fn();
        const [translationHandler, disabledHandler] = createFullPageTranslationStateHandlers({
            stateStore,
            isTabId: isBrowserTabId,
            onStateChanged,
        });

        expect(translationHandler.type).toBe(FULL_PAGE_TRANSLATION_STATE_MESSAGE_TYPE);
        expect(translationHandler.handle(
            {type: FULL_PAGE_TRANSLATION_STATE_MESSAGE_TYPE, isTranslated: true},
            {sender: {tab: {id: 0}}},
        )).toEqual({success: true});
        expect(stateStore.get(0)).toEqual({isTranslated: true, isSiteDisabled: false});

        expect(disabledHandler.type).toBe(SITE_EXTENSION_DISABLED_STATE_MESSAGE_TYPE);
        expect(disabledHandler.handle(
            {type: SITE_EXTENSION_DISABLED_STATE_MESSAGE_TYPE, isDisabled: true},
            {sender: {tab: {id: 0}}},
        )).toEqual({success: true});
        expect(stateStore.get(0)).toEqual({isTranslated: false, isSiteDisabled: true});
        expect(onStateChanged).toHaveBeenNthCalledWith(1, 0);
        expect(onStateChanged).toHaveBeenNthCalledWith(2, 0);
    });

    it('全文状态 handler 拒绝非布尔值，并对非标签页发送者保持兼容 no-op', () => {
        const stateStore = new TabTranslationStateStore();
        const onStateChanged = vi.fn();
        const [translationHandler, disabledHandler] = createFullPageTranslationStateHandlers({
            stateStore,
            isTabId: isBrowserTabId,
            onStateChanged,
        });

        expect(() => translationHandler.handle(
            {type: FULL_PAGE_TRANSLATION_STATE_MESSAGE_TYPE, isTranslated: 'yes'},
            {},
        )).toThrow('isTranslated 必须是布尔值');
        expect(() => disabledHandler.handle(
            {type: SITE_EXTENSION_DISABLED_STATE_MESSAGE_TYPE, isDisabled: 1},
            {},
        )).toThrow('isDisabled 必须是布尔值');

        expect(translationHandler.handle(
            {type: FULL_PAGE_TRANSLATION_STATE_MESSAGE_TYPE, isTranslated: false},
            {sender: {}},
        )).toEqual({success: true});
        expect(disabledHandler.handle(
            {type: SITE_EXTENSION_DISABLED_STATE_MESSAGE_TYPE, isDisabled: false},
            {sender: {tab: {id: -1}}},
        )).toEqual({success: true});
        expect(onStateChanged).not.toHaveBeenCalled();
    });

    it('全文状态 handler 忽略 legacy QQ 子 frame，避免覆盖 top frame 状态', () => {
        const stateStore = new TabTranslationStateStore();
        const onStateChanged = vi.fn();
        const [translationHandler, disabledHandler] = createFullPageTranslationStateHandlers({
            stateStore,
            isTabId: isBrowserTabId,
            onStateChanged,
        });
        const context = {sender: {frameId: 3, tab: {id: 42}}};
        expect(translationHandler.handle(
            {type: FULL_PAGE_TRANSLATION_STATE_MESSAGE_TYPE, isTranslated: true}, context,
        )).toEqual({success: true});
        expect(disabledHandler.handle(
            {type: SITE_EXTENSION_DISABLED_STATE_MESSAGE_TYPE, isDisabled: true}, context,
        )).toEqual({success: true});
        expect(stateStore.get(42)).toEqual({isTranslated: false, isSiteDisabled: false});
        expect(onStateChanged).not.toHaveBeenCalled();
    });

    it('区域选区守卫覆盖尺寸、视口和数值边界', () => {
        const valid = {left: 0, top: 0, width: 12, height: 12, viewportWidth: 100, viewportHeight: 80};
        expect(isAreaTranslationSelection(valid)).toBe(true);
        expect(isAreaTranslationSelection(null)).toBe(false);
        expect(isAreaTranslationSelection([])).toBe(false);
        expect(isAreaTranslationSelection({...valid, left: '0'})).toBe(false);
        expect(isAreaTranslationSelection({...valid, top: Number.NaN})).toBe(false);
        expect(isAreaTranslationSelection({...valid, width: 11})).toBe(false);
        expect(isAreaTranslationSelection({...valid, height: 11})).toBe(false);
        expect(isAreaTranslationSelection({...valid, viewportWidth: 0})).toBe(false);
        expect(isAreaTranslationSelection({...valid, viewportHeight: 0})).toBe(false);
    });

    it('区域截图 handler 接受 windowId=0 并拒绝空截图与非法窗口', async () => {
        const captureVisibleTab = vi.fn(async () => 'data:image/png;base64,AA==');
        const [captureHandler] = createAreaTranslationBackgroundHandlers({
            captureVisibleTab,
            getDefaultSourceLanguage: () => 'auto',
            assertLanguagesDownloaded: vi.fn(async () => undefined),
            translateArea: vi.fn(async () => ({image: 'translated', lines: []})),
        });

        await expect(captureHandler.handle(
            {type: AREA_CAPTURE_MESSAGE_TYPE},
            {sender: {tab: {windowId: 0}}},
        )).resolves.toEqual({success: true, image: 'data:image/png;base64,AA=='});
        expect(captureVisibleTab).toHaveBeenCalledWith(0);

        for (const windowId of [undefined, '1', -1, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
            await expect(captureHandler.handle(
                {type: AREA_CAPTURE_MESSAGE_TYPE},
                {sender: {tab: {windowId: windowId as number | undefined}}},
            )).rejects.toThrow('无法确定当前页面窗口');
        }
        captureVisibleTab.mockResolvedValueOnce('');
        await expect(captureHandler.handle(
            {type: AREA_CAPTURE_MESSAGE_TYPE},
            {sender: {tab: {windowId: 1}}},
        )).rejects.toThrow('当前页面截图为空');
        captureVisibleTab.mockResolvedValueOnce(undefined as unknown as string);
        await expect(captureHandler.handle(
            {type: AREA_CAPTURE_MESSAGE_TYPE},
            {sender: {tab: {windowId: 1}}},
        )).rejects.toThrow('当前页面截图为空');
    });

    it('圈选截图必须属于sender的当前活动标签页，并在捕获完成后再次核对', async () => {
        let active = false;
        const getTab = vi.fn(async (id: number) => ({id, windowId: 0, active}));
        const captureVisibleTab = vi.fn(async () => 'data:image/png,original-page');
        const assertCaptureOwner = createAreaCaptureOwnershipVerifier(getTab);
        const [handler] = createAreaTranslationBackgroundHandlers({
            captureVisibleTab, assertCaptureOwner, getDefaultSourceLanguage: () => 'en',
            assertLanguagesDownloaded: vi.fn(), translateArea: vi.fn(),
        });
        const context = {sender: {tab: {windowId: 0, id: 7}}};
        await expect(handler.handle({type: AREA_CAPTURE_MESSAGE_TYPE}, context)).rejects.toThrow('页面已切换');
        expect(captureVisibleTab).not.toHaveBeenCalled();
        active = true;
        await expect(handler.handle({type: AREA_CAPTURE_MESSAGE_TYPE}, context)).resolves.toEqual({success: true, image: 'data:image/png,original-page'});
        expect(getTab).toHaveBeenCalledTimes(3);
        captureVisibleTab.mockImplementationOnce(async () => {active = false; return 'data:image/png,other-page';});
        await expect(handler.handle({type: AREA_CAPTURE_MESSAGE_TYPE}, context)).rejects.toThrow('页面已切换');
    });

    it('连续圈选截图跨窗口共享600ms启动间隔，首次立即且空闲后不补偿突发额度', async () => {
        let now = 0;
        const starts: Array<{time: number; windowId: number}> = [];
        const waitForCapture = vi.fn(async (milliseconds: number) => {now += milliseconds;});
        const [handler] = createAreaTranslationBackgroundHandlers({
            captureNow: () => now, waitForCapture,
            captureVisibleTab: async (windowId) => {starts.push({time: now, windowId}); return 'data:image/png,crop';},
            getDefaultSourceLanguage: () => 'en', assertLanguagesDownloaded: vi.fn(), translateArea: vi.fn(),
        });
        const capture = (windowId: number) => handler.handle({type: AREA_CAPTURE_MESSAGE_TYPE}, {sender: {tab: {windowId}}});
        await Promise.all([capture(1), capture(2), capture(1)]);
        expect(starts).toEqual([{time: 0, windowId: 1}, {time: 600, windowId: 2}, {time: 1200, windowId: 1}]);
        expect(waitForCapture.mock.calls).toEqual([[600], [600]]);
        now = 3000;
        await Promise.all([capture(2), capture(1)]);
        expect(starts.slice(-2)).toEqual([{time: 3000, windowId: 2}, {time: 3600, windowId: 1}]);
    });

    it('截图本身严格串行，失败也保持启动间隔且释放后续队列', async () => {
        let now = 0;
        let failFirst!: (reason: Error) => void;
        const starts: number[] = [];
        const captureVisibleTab = vi.fn(() => {
            starts.push(now);
            return starts.length === 1 ? new Promise<string>((_resolve, reject) => {failFirst = reject;}) : Promise.resolve('data:image/png,retry');
        });
        const [handler] = createAreaTranslationBackgroundHandlers({
            captureNow: () => now, waitForCapture: async (milliseconds) => {now += milliseconds;}, captureVisibleTab,
            getDefaultSourceLanguage: () => 'en', assertLanguagesDownloaded: vi.fn(), translateArea: vi.fn(),
        });
        const context = {sender: {tab: {windowId: 1}}};
        const first = handler.handle({type: AREA_CAPTURE_MESSAGE_TYPE}, context);
        const rejection = expect(first).rejects.toThrow('capture failed');
        const second = handler.handle({type: AREA_CAPTURE_MESSAGE_TYPE}, context);
        for (let index = 0; index < 5; index += 1) await Promise.resolve();
        expect(captureVisibleTab).toHaveBeenCalledOnce();
        now = 200;
        failFirst(new Error('capture failed'));
        await rejection;
        await expect(second).resolves.toEqual({success: true, image: 'data:image/png,retry'});
        expect(starts).toEqual([0, 600]);
    });

    it('截图节流等待结束后重新核验标签页，已切换则不截图且不消耗下一次额度', async () => {
        let now = 0;
        let active = true;
        const captureVisibleTab = vi.fn(async () => 'data:image/png,crop');
        const waitForCapture = vi.fn(async (milliseconds: number) => {now += milliseconds; active = false;});
        const [handler] = createAreaTranslationBackgroundHandlers({
            captureNow: () => now, waitForCapture, captureVisibleTab,
            assertCaptureOwner: createAreaCaptureOwnershipVerifier(async () => ({id: 3, windowId: 1, active})),
            getDefaultSourceLanguage: () => 'en', assertLanguagesDownloaded: vi.fn(), translateArea: vi.fn(),
        });
        const context = {sender: {tab: {windowId: 1, id: 3}}};
        await handler.handle({type: AREA_CAPTURE_MESSAGE_TYPE}, context);
        await expect(handler.handle({type: AREA_CAPTURE_MESSAGE_TYPE}, context)).rejects.toThrow('页面已切换');
        expect(captureVisibleTab).toHaveBeenCalledOnce();
        active = true;
        await expect(handler.handle({type: AREA_CAPTURE_MESSAGE_TYPE}, context)).resolves.toHaveProperty('success', true);
        expect(captureVisibleTab).toHaveBeenCalledTimes(2);
        expect(waitForCapture).toHaveBeenCalledOnce();
    });

    it('圈选截图所有权拒绝伪造或失效tabId、错误窗口及已关闭标签页', async () => {
        const getTab = vi.fn(async () => ({id: 2, windowId: 3, active: true}));
        const verify = createAreaCaptureOwnershipVerifier(getTab);
        for (const id of [undefined, '2', -1, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
            await expect(verify(3, id)).rejects.toThrow('无法确定');
        }
        expect(getTab).not.toHaveBeenCalled();
        await expect(verify(3, 1)).rejects.toThrow('页面已切换');
        await expect(verify(4, 2)).rejects.toThrow('页面已切换');
        getTab.mockRejectedValueOnce(new Error('tab closed'));
        await expect(verify(3, 2)).rejects.toThrow('tab closed');
    });

    it('区域翻译 handler 校验协议、默认语言并依序调用语言包与 offscreen', async () => {
        const events: string[] = [];
        const assertLanguagesDownloaded = vi.fn(async (language: string) => {
            events.push(`assert:${language}`);
        });
        const translateArea = vi.fn(async (_image: string, language: string, title: string) => {
            events.push(`translate:${language}:${title}`);
            return {image: 'data:image/png;base64,BB==', lines: []};
        });
        const [, handler] = createAreaTranslationBackgroundHandlers({
            captureVisibleTab: vi.fn(async () => 'unused'),
            getDefaultSourceLanguage: () => 'auto',
            assertLanguagesDownloaded,
            translateArea,
        });
        const selection = {left: 1, top: 2, width: 20, height: 30, viewportWidth: 100, viewportHeight: 200};

        await expect(handler.handle({
            type: AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE,
            image: 'data:image/png;base64,AA==',
            selection,
        }, {})).resolves.toEqual({success: true, image: 'data:image/png;base64,BB==', lines: []});
        expect(events).toEqual(['assert:auto', 'translate:auto:']);
        expect(translateArea).toHaveBeenCalledWith(
            'data:image/png;base64,AA==',
            'auto',
            '',
            selection,
            expect.objectContaining({
                requestId: expect.stringMatching(/^legacy-area-/),
                signal: expect.any(AbortSignal),
                timeoutMs: 180_000,
            }),
        );

        await handler.handle({
            type: AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE,
            image: 'data:image/png;base64,AA==',
            selection,
            sourceLanguage: 'en',
            title: 'Page',
        }, {});
        expect(translateArea).toHaveBeenLastCalledWith(
            'data:image/png;base64,AA==', 'en', 'Page', selection, expect.any(Object),
        );

        await expect(handler.handle({type: AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE, image: 1, selection}, {}))
            .rejects.toThrow('圈选截图数据无效');
        await expect(handler.handle({type: AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE, image: 'https://x', selection}, {}))
            .rejects.toThrow('圈选截图数据无效');
        await expect(handler.handle({type: AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE, image: 'data:image/png,x', selection: {}}, {}))
            .rejects.toThrow('圈选区域无效');
        await expect(handler.handle({
            type: AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE,
            image: 'data:image/png,x',
            selection,
            sourceLanguage: 1,
        }, {})).rejects.toThrow('sourceLanguage 必须是非空字符串');
        await expect(handler.handle({
            type: AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE,
            image: 'data:image/png,x',
            selection,
            sourceLanguage: ' ',
        }, {})).rejects.toThrow('sourceLanguage 必须是非空字符串');
        await expect(handler.handle({
            type: AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE,
            image: 'data:image/png,x',
            selection,
            title: false,
        }, {})).rejects.toThrow('title 必须是字符串');
    });

    it('圈选开始前冻结文本事务，OCR结束后发送独立翻译阶段并返回文字结果', async () => {
        const events: string[] = [];
        const recognized = {image: 'data:image/png,crop', lines: []};
        const translateText = vi.fn(async () => ({...recognized, sourceText: 'Hello', translatedText: '你好'}));
        const context = {sender: {url: 'https://example.org', tab: {id: 1, windowId: 0}}};
        const prepareTextTranslation = vi.fn(() => {events.push('snapshot'); return translateText;});
        const sendProgress = vi.fn(async (_context, message) => {events.push(message.stage);});
        const [, handler] = createAreaTranslationBackgroundHandlers({
            captureVisibleTab: vi.fn(), getDefaultSourceLanguage: () => 'en',
            assertLanguagesDownloaded: async () => {events.push('languages');},
            translateArea: async () => {events.push('ocr'); return recognized;},
            prepareTextTranslation, sendProgress,
        });
        const result = await handler.handle({type: AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE, image: 'data:image/png,full',
            selection: {left: 0, top: 0, width: 20, height: 20, viewportWidth: 100, viewportHeight: 100},
            requestId: 'area-separate', timeoutMs: 5_000, title: 'Page',
        }, context);
        expect(events).toEqual(['snapshot', 'languages', 'recognizing', 'ocr', 'translating']);
        expect(prepareTextTranslation).toHaveBeenCalledWith('en', 'Page', context);
        expect(translateText).toHaveBeenCalledWith(recognized, expect.objectContaining({requestId: 'area-separate'}));
        expect(result).toEqual({success: true, ...recognized, sourceText: 'Hello', translatedText: '你好'});
        expect(sendProgress).toHaveBeenCalledTimes(2);
    });

    it('区域翻译取消会把 signal 传播给 Offscreen adapter', async () => {
        let resolveArea!: (value: {image: string; lines: never[]}) => void;
        const translateArea = vi.fn(() => new Promise<{image: string; lines: never[]}>((resolve) => {
            resolveArea = resolve;
        }));
        const [, translateHandler, cancelHandler] = createAreaTranslationBackgroundHandlers({
            captureVisibleTab: vi.fn(async () => 'unused'),
            getDefaultSourceLanguage: () => 'auto',
            assertLanguagesDownloaded: vi.fn(async () => undefined),
            translateArea,
        });
        const pending = translateHandler.handle({
            type: AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE,
            image: 'data:image/png,x',
            selection: {left: 0, top: 0, width: 20, height: 20, viewportWidth: 100, viewportHeight: 100},
            requestId: 'area-pending',
            timeoutMs: 5_000,
        }, {});
        await vi.waitFor(() => expect(translateArea).toHaveBeenCalledOnce());
        const signal = ((translateArea.mock.calls as unknown[][])[0]?.[4] as {
            signal?: AbortSignal;
        } | undefined)?.signal;

        await expect(cancelHandler.handle({
            type: AREA_CANCEL_MESSAGE_TYPE,
            requestId: 'area-pending',
        }, {})).resolves.toEqual({success: true, cancelled: true, requestId: 'area-pending'});
        expect(signal?.aborted).toBe(true);
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});

        resolveArea({image: 'data:image/png,late', lines: []});
        await Promise.resolve();
    });

    it('区域翻译在语言包等待期间取消后不会进入 Offscreen', async () => {
        let releaseLanguages!: () => void;
        const assertLanguagesDownloaded = vi.fn(() => new Promise<void>(resolve => {
            releaseLanguages = resolve;
        }));
        const translateArea = vi.fn(async () => ({image: 'translated', lines: []}));
        const [, translateHandler, cancelHandler] = createAreaTranslationBackgroundHandlers({
            captureVisibleTab: vi.fn(async () => 'unused'),
            getDefaultSourceLanguage: () => 'auto',
            assertLanguagesDownloaded,
            translateArea,
        });
        const pending = translateHandler.handle({
            type: AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE,
            image: 'data:image/png,x',
            selection: {left: 0, top: 0, width: 20, height: 20, viewportWidth: 100, viewportHeight: 100},
            requestId: 'area-language-wait',
            timeoutMs: 5_000,
        }, {});
        await vi.waitFor(() => expect(assertLanguagesDownloaded).toHaveBeenCalledOnce());

        await cancelHandler.handle({type: AREA_CANCEL_MESSAGE_TYPE, requestId: 'area-language-wait'}, {});
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
        releaseLanguages();
        await Promise.resolve();
        await Promise.resolve();
        expect(translateArea).not.toHaveBeenCalled();
    });

    it('划词词典 handler 使用默认/显式目标语言并处理无条目', async () => {
        const lookupWord = vi.fn(async () => null as WordCardData | null);
        const translate = vi.fn(async () => [] as string[]);
        const warn = vi.fn();
        const handler = createSelectionWordLookupHandler({
            lookupWord,
            getDefaultTargetLanguage: () => 'zh-Hans',
            translate,
            warn,
        });

        await expect(handler.handle({type: SELECTION_WORD_LOOKUP_MESSAGE_TYPE, word: ''}))
            .resolves.toEqual({success: true, data: null});
        expect(lookupWord).toHaveBeenCalledWith('');
        expect(translate).not.toHaveBeenCalled();

        lookupWord.mockResolvedValueOnce(wordCard([]));
        const cardWithoutDefinitions = await handler.handle({
            type: SELECTION_WORD_LOOKUP_MESSAGE_TYPE,
            word: 'run',
            targetLanguage: 'ja',
        });
        expect(cardWithoutDefinitions.data?.meanings[0].definitions).toEqual([]);

        await expect(handler.handle({type: SELECTION_WORD_LOOKUP_MESSAGE_TYPE, word: 7}))
            .rejects.toThrow('word 必须是字符串');
        await expect(handler.handle({type: SELECTION_WORD_LOOKUP_MESSAGE_TYPE, word: 'run', targetLanguage: ''}))
            .rejects.toThrow('targetLanguage 必须是非空字符串');
        await expect(handler.handle({type: SELECTION_WORD_LOOKUP_MESSAGE_TYPE, word: 'run', targetLanguage: 1}))
            .rejects.toThrow('targetLanguage 必须是非空字符串');
    });

    it('词典卡翻译去重、深拷贝并只写入有效译文', async () => {
        const card = wordCard([
            {definition: 'same', example: 'same'},
            {definition: 'empty', example: 'number'},
            {definition: 'unchanged', example: ''},
            {definition: '', example: 'valid'},
            {definition: 'hidden'},
        ]);
        const translate = vi.fn(async () => [' 相同 ', ' ', 7, 'unchanged', '有效'] as unknown as string[]);
        const result = await translateVisibleWordCardFields(card, 'zh-Hans', translate, vi.fn());

        expect(translate).toHaveBeenCalledWith({
            origin: ['same', 'empty', 'number', 'unchanged', 'valid'],
            context: '',
            pageContext: '',
            useCache: true,
            targetLanguage: 'zh-Hans',
        });
        expect(result).not.toBe(card);
        expect(result.phonetics[0]).not.toBe(card.phonetics[0]);
        expect(result.meanings[0]).not.toBe(card.meanings[0]);
        expect(result.meanings[0].definitions[0]).not.toBe(card.meanings[0].definitions[0]);
        expect(result.sources[0]).not.toBe(card.sources[0]);
        expect(result.meanings[0].definitions[0]).toMatchObject({
            translatedDefinition: '相同',
            translatedExample: '相同',
        });
        expect(result.meanings[0].definitions[1].translatedDefinition).toBeUndefined();
        expect(result.meanings[0].definitions[1].translatedExample).toBeUndefined();
        expect(result.meanings[0].definitions[2].translatedDefinition).toBeUndefined();
        expect(result.meanings[0].definitions[3].translatedExample).toBe('有效');
        expect(result.meanings[0].definitions[4].translatedDefinition).toBeUndefined();
    });

    it('词典卡翻译在 provider 结果不匹配或失败时保留原卡', async () => {
        const card = wordCard();
        const warn = vi.fn();
        await expect(translateVisibleWordCardFields(card, 'zh', async () => 'single', warn)).resolves.toBe(card);
        await expect(translateVisibleWordCardFields(card, 'zh', async () => ['only-one'], warn)).resolves.toBe(card);
        const failure = new Error('offline');
        await expect(translateVisibleWordCardFields(card, 'zh', async () => {
            throw failure;
        }, warn)).resolves.toBe(card);
        expect(warn).toHaveBeenCalledWith(
            '[FluentRead] word definition translation unavailable; keeping dictionary text',
            failure,
        );

        const translatedHandler = createSelectionWordLookupHandler({
            lookupWord: async () => card,
            getDefaultTargetLanguage: () => 'zh',
            translate: async () => ['移动', '跑回家'],
            warn,
        });
        const response = await translatedHandler.handle({type: SELECTION_WORD_LOOKUP_MESSAGE_TYPE, word: 'run'});
        expect(response.data?.meanings[0].definitions[0]).toMatchObject({
            translatedDefinition: '移动',
            translatedExample: '跑回家',
        });
    });

    it('图片 handlers 完成 OCR、图片翻译、文字翻译和语言包下载', async () => {
        const dependencies = {
            assertLanguagesDownloaded: vi.fn(async () => undefined),
            recognizeImage: vi.fn(async () => [{text: 'hello'}]),
            translateImage: vi.fn(async () => ({image: 'data:image/png;base64,BB==', lines: []})),
            fetchImage: vi.fn(async () => 'data:image/png;base64,remote'),
            translateTexts: vi.fn(async () => ['你好', '世界']),
            getTranslationService: vi.fn(() => 'microsoft'),
            supportsBatchTranslation: vi.fn(() => true),
            downloadLanguages: vi.fn(async () => undefined),
            markLanguagesDownloaded: vi.fn(async () => ['eng' as const, 'chi_sim' as const]),
            now: () => 0,
        };
        const removeLanguages=vi.fn(async()=>{});
        const markLanguagesRemoved=vi.fn(async()=>['jpn' as const]);
        const removalHandlers=createImageTranslationBackgroundHandlers({...dependencies,removeLanguages,markLanguagesRemoved});
        await expect(removalHandlers.find(h=>h.type==='fluentReadImageOcrRemove')!.handle({type:'fluentReadImageOcrRemove',languages:['eng']})).resolves.toEqual({success:true,languages:['jpn']});
        expect(removeLanguages).toHaveBeenCalledWith(['eng']);
        await expect(createImageTranslationBackgroundHandlers(dependencies).find(h=>h.type==='fluentReadImageOcrRemove')!.handle({type:'fluentReadImageOcrRemove',languages:['eng']})).rejects.toThrow('不可用');
        const handlers = createImageTranslationBackgroundHandlers(dependencies);
        const find = (type: string) => handlers.find((handler) => handler.type === type)!;

        await expect(find(IMAGE_OCR_MESSAGE_TYPE).handle({
            type: IMAGE_OCR_MESSAGE_TYPE,
            image: 'data:image/png;base64,AA==',
            sourceLanguage: 'en',
        })).resolves.toEqual({success: true, lines: [{text: 'hello'}]});
        await expect(find(IMAGE_TRANSLATE_MESSAGE_TYPE).handle({
            type: IMAGE_TRANSLATE_MESSAGE_TYPE,
            image: 'data:image/png;base64,AA==',
            sourceLanguage: 'auto',
        })).resolves.toEqual({success: true, image: 'data:image/png;base64,BB==', lines: []});
        expect(dependencies.translateImage).toHaveBeenCalledWith(
            'data:image/png;base64,AA==',
            'auto',
            '',
            expect.objectContaining({
                requestId: expect.stringMatching(/^legacy-image-/),
                signal: expect.any(AbortSignal),
                timeoutMs: 180_000,
            }),
        );

        await expect(find(IMAGE_FETCH_MESSAGE_TYPE).handle({
            type: IMAGE_FETCH_MESSAGE_TYPE,
            url: 'https://pbs.twimg.com/media/demo.png',
            requestId: 'image-fetch-1',
            timeoutMs: 15_000,
        })).resolves.toEqual({success: true, image: 'data:image/png;base64,remote'});
        expect(dependencies.fetchImage).toHaveBeenCalledWith(
            'https://pbs.twimg.com/media/demo.png',
            expect.objectContaining({
                requestId: 'image-fetch-1',
                signal: expect.any(AbortSignal),
                timeoutMs: 15_000,
            }),
        );

        dependencies.fetchImage.mockResolvedValueOnce('not-an-image');
        await expect(find(IMAGE_FETCH_MESSAGE_TYPE).handle({
            type: IMAGE_FETCH_MESSAGE_TYPE,
            url: 'https://pbs.twimg.com/media/invalid.png',
        })).rejects.toThrow('远程图片结果无效');

        await expect(find(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE).handle({
            type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
            texts: ['hello', 'world'],
            title: 'Page',
        })).resolves.toEqual({success: true, translations: ['你好', '世界']});
        expect(dependencies.translateTexts).toHaveBeenCalledWith({
            origin: ['hello', 'world'],
            context: 'Page',
            pageContext: '',
            useCache: true,
            serviceOverride: 'microsoft',
            requestTimeoutMs: IMAGE_TEXT_TRANSLATION_TIMEOUT_MS,
        });

        await expect(find(IMAGE_OCR_DOWNLOAD_MESSAGE_TYPE).handle({
            type: IMAGE_OCR_DOWNLOAD_MESSAGE_TYPE,
            languages: ['eng', 'eng'],
        })).resolves.toEqual({success: true, languages: ['eng', 'chi_sim']});
        expect(dependencies.downloadLanguages).toHaveBeenCalledWith(['eng']);
    });

    it('图片取消消息会中止同 requestId 的后台操作并忽略迟到结果', async () => {
        let resolveImage!: (value: {image: string; lines: never[]}) => void;
        const dependencies = {
            assertLanguagesDownloaded: vi.fn(async () => undefined),
            recognizeImage: vi.fn(async () => []),
            translateImage: vi.fn(() => new Promise<{image: string; lines: never[]}>((resolve) => {
                resolveImage = resolve;
            })),
            fetchImage: vi.fn(async () => 'data:image/png;base64,remote'),
            translateTexts: vi.fn(async () => []),
            getTranslationService: vi.fn(() => 'microsoft'),
            supportsBatchTranslation: vi.fn(() => true),
            downloadLanguages: vi.fn(async () => undefined),
            markLanguagesDownloaded: vi.fn(async () => []),
        };
        const handlers = createImageTranslationBackgroundHandlers(dependencies);
        const find = (type: string) => handlers.find(handler => handler.type === type)!;
        const pending = find(IMAGE_TRANSLATE_MESSAGE_TYPE).handle({
            type: IMAGE_TRANSLATE_MESSAGE_TYPE,
            image: 'data:image/png,x',
            sourceLanguage: 'en',
            requestId: 'image-pending',
            timeoutMs: 5_000,
        });
        await vi.waitFor(() => expect(dependencies.translateImage).toHaveBeenCalledOnce());
        const signal = ((dependencies.translateImage.mock.calls as unknown[][])[0]?.[3] as {
            signal?: AbortSignal;
        } | undefined)?.signal;

        await expect(find(IMAGE_CANCEL_MESSAGE_TYPE).handle({
            type: IMAGE_CANCEL_MESSAGE_TYPE,
            requestId: 'image-pending',
        })).resolves.toEqual({success: true, cancelled: true, requestId: 'image-pending'});
        expect(signal?.aborted).toBe(true);
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});

        resolveImage({image: 'data:image/png,late', lines: []});
        await Promise.resolve();
        await expect(find(IMAGE_CANCEL_MESSAGE_TYPE).handle({
            type: IMAGE_CANCEL_MESSAGE_TYPE,
            requestId: 'image-pending',
        })).resolves.toEqual({success: true, cancelled: false, requestId: 'image-pending'});
    });

    it('图片操作注册表覆盖非法协议、重复 ID、超时和有界取消墓碑', async () => {
        const registry = createImageOperationRegistry('coverage');
        await expect(registry.run({requestId: 'bad request'}, async () => 'unused'))
            .rejects.toThrow('requestId 格式无效');
        for (const [index, timeoutMs] of [null, Number.NaN, 0].entries()) {
            await expect(registry.run({requestId: `bad-timeout-${index}`, timeoutMs}, async () => 'unused'))
                .rejects.toThrow('timeoutMs 必须是正数');
        }

        let resolveActive!: (value: string) => void;
        const active = registry.run({requestId: 'duplicate-active', timeoutMs: 5_000}, () =>
            new Promise<string>(resolve => { resolveActive = resolve; }));
        await Promise.resolve();
        await expect(registry.run({requestId: 'duplicate-active'}, async () => 'duplicate'))
            .rejects.toThrow('requestId 正在执行');
        resolveActive('done');
        await expect(active).resolves.toBe('done');

        await expect(registry.run({requestId: 'times-out', timeoutMs: 1}, () =>
            new Promise<string>(() => undefined))).rejects.toMatchObject({name: 'TimeoutError'});

        expect(registry.cancel('repeat-cancel').cancelled).toBe(false);
        expect(registry.cancel('repeat-cancel').cancelled).toBe(false);
        for (let index = 0; index <= 512; index += 1) registry.cancel(`bounded-${index}`);
        await expect(registry.run({requestId: 'bounded-0'}, async () => 'released'))
            .resolves.toBe('released');

    });

    it('图片 OCR 与整图翻译在语言包等待期间取消后不进入 Offscreen', async () => {
        const languageWaits: Array<() => void> = [];
        const dependencies = {
            assertLanguagesDownloaded: vi.fn(() => new Promise<void>(resolve => languageWaits.push(resolve))),
            recognizeImage: vi.fn(async () => []),
            translateImage: vi.fn(async () => ({image: 'translated', lines: []})),
            fetchImage: vi.fn(async () => 'data:image/png;base64,remote'),
            translateTexts: vi.fn(async () => []),
            getTranslationService: vi.fn(() => 'microsoft'),
            supportsBatchTranslation: vi.fn(() => true),
            downloadLanguages: vi.fn(async () => undefined),
            markLanguagesDownloaded: vi.fn(async () => []),
        };
        const handlers = createImageTranslationBackgroundHandlers(dependencies);
        const find = (type: string) => handlers.find(handler => handler.type === type)!;
        const ocr = find(IMAGE_OCR_MESSAGE_TYPE).handle({
            type: IMAGE_OCR_MESSAGE_TYPE,
            image: 'data:image/png,x',
            sourceLanguage: 'en',
            requestId: 'ocr-language-wait',
            timeoutMs: 5_000,
        });
        await vi.waitFor(() => expect(languageWaits).toHaveLength(1));
        await find(IMAGE_CANCEL_MESSAGE_TYPE).handle({
            type: IMAGE_CANCEL_MESSAGE_TYPE,
            requestId: 'ocr-language-wait',
        });
        await expect(ocr).rejects.toMatchObject({name: 'AbortError'});
        languageWaits.shift()?.();
        await Promise.resolve();
        await Promise.resolve();
        expect(dependencies.recognizeImage).not.toHaveBeenCalled();

        const translated = find(IMAGE_TRANSLATE_MESSAGE_TYPE).handle({
            type: IMAGE_TRANSLATE_MESSAGE_TYPE,
            image: 'data:image/png,x',
            sourceLanguage: 'en',
            requestId: 'translate-language-wait',
            timeoutMs: 5_000,
        });
        await vi.waitFor(() => expect(languageWaits).toHaveLength(1));
        await find(IMAGE_CANCEL_MESSAGE_TYPE).handle({
            type: IMAGE_CANCEL_MESSAGE_TYPE,
            requestId: 'translate-language-wait',
        });
        await expect(translated).rejects.toMatchObject({name: 'AbortError'});
        languageWaits.shift()?.();
        await Promise.resolve();
        await Promise.resolve();
        expect(dependencies.translateImage).not.toHaveBeenCalled();
    });

    it('Offscreen 文字翻译取消会中止同所有权的 broker 请求并忽略迟到结果', async () => {
        let resolveTexts!: (value: string[]) => void;
        const dependencies = {
            assertLanguagesDownloaded: vi.fn(async () => undefined),
            recognizeImage: vi.fn(async () => []),
            translateImage: vi.fn(async () => ({image: 'data:image/png,x', lines: []})),
            fetchImage: vi.fn(async () => 'data:image/png;base64,remote'),
            translateTexts: vi.fn(() => new Promise<string[]>((resolve) => { resolveTexts = resolve; })),
            getTranslationService: vi.fn(() => 'microsoft'),
            supportsBatchTranslation: vi.fn(() => true),
            downloadLanguages: vi.fn(async () => undefined),
            markLanguagesDownloaded: vi.fn(async () => []),
        };
        const handlers = createImageTranslationBackgroundHandlers(dependencies);
        const find = (type: string) => handlers.find(handler => handler.type === type)!;
        const pending = find(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE).handle({
            type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
            texts: ['hello'],
            title: 'Page',
            requestId: 'image-text-pending',
            timeoutMs: 5_000,
        });
        await vi.waitFor(() => expect(dependencies.translateTexts).toHaveBeenCalledOnce());
        const request = (dependencies.translateTexts.mock.calls as unknown[][])[0]?.[0];
        const control = getTranslationRequestControl(request);
        expect(control).toMatchObject({ownershipKey: 'image:image-text-pending'});

        await expect(find(IMAGE_CANCEL_MESSAGE_TYPE).handle({
            type: IMAGE_CANCEL_MESSAGE_TYPE,
            requestId: 'image-text-pending',
        })).resolves.toEqual({success: true, cancelled: true, requestId: 'image-text-pending'});
        expect(control?.signal.aborted).toBe(true);
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});

        resolveTexts(['迟到译文']);
        await Promise.resolve();
    });

    it('取消先于 Offscreen 文字消息到达时，后到请求 fail closed 且不启动 broker', async () => {
        const dependencies = {
            assertLanguagesDownloaded: vi.fn(async () => undefined),
            recognizeImage: vi.fn(async () => []),
            translateImage: vi.fn(async () => ({image: 'data:image/png,x', lines: []})),
            fetchImage: vi.fn(async () => 'data:image/png;base64,remote'),
            translateTexts: vi.fn(async () => ['不应调用']),
            getTranslationService: vi.fn(() => 'microsoft'),
            supportsBatchTranslation: vi.fn(() => true),
            downloadLanguages: vi.fn(async () => undefined),
            markLanguagesDownloaded: vi.fn(async () => []),
        };
        const handlers = createImageTranslationBackgroundHandlers(dependencies);
        const find = (type: string) => handlers.find(handler => handler.type === type)!;

        await expect(find(IMAGE_CANCEL_MESSAGE_TYPE).handle({
            type: IMAGE_CANCEL_MESSAGE_TYPE,
            requestId: 'image-cancelled-before-text',
        })).resolves.toEqual({
            success: true,
            cancelled: false,
            requestId: 'image-cancelled-before-text',
        });
        await expect(find(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE).handle({
            type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
            texts: ['hello'],
            requestId: 'image-cancelled-before-text',
            timeoutMs: 5_000,
        })).rejects.toMatchObject({name: 'AbortError'});
        expect(dependencies.translateTexts).not.toHaveBeenCalled();
    });

    it('图片 handlers 严格拒绝非法页面 payload 和 provider 结果', async () => {
        const dependencies = {
            assertLanguagesDownloaded: vi.fn(async () => undefined),
            recognizeImage: vi.fn(async () => [] as unknown),
            translateImage: vi.fn(async () => ({} as unknown)),
            fetchImage: vi.fn(async () => 'data:image/png;base64,remote'),
            translateTexts: vi.fn(async () => [] as string[] | string),
            getTranslationService: vi.fn(() => 'microsoft'),
            supportsBatchTranslation: vi.fn(() => true),
            downloadLanguages: vi.fn(async () => undefined),
            markLanguagesDownloaded: vi.fn(async () => []),
            now: () => 0,
        };
        const handlers = createImageTranslationBackgroundHandlers(dependencies);
        const find = (type: string) => handlers.find((handler) => handler.type === type)!;
        const ocr = find(IMAGE_OCR_MESSAGE_TYPE);
        const imageTranslate = find(IMAGE_TRANSLATE_MESSAGE_TYPE);
        const texts = find(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE);
        const download = find(IMAGE_OCR_DOWNLOAD_MESSAGE_TYPE);

        await expect(ocr.handle({type: IMAGE_OCR_MESSAGE_TYPE, image: 1, sourceLanguage: 'en'}))
            .rejects.toThrow('图片数据无效');
        await expect(ocr.handle({type: IMAGE_OCR_MESSAGE_TYPE, image: 'https://x', sourceLanguage: 'en'}))
            .rejects.toThrow('图片数据无效');
        await expect(ocr.handle({type: IMAGE_OCR_MESSAGE_TYPE, image: 'data:image/png,x', sourceLanguage: 1}))
            .rejects.toThrow('sourceLanguage 必须是非空字符串');
        await expect(ocr.handle({type: IMAGE_OCR_MESSAGE_TYPE, image: 'data:image/png,x', sourceLanguage: ' '}))
            .rejects.toThrow('sourceLanguage 必须是非空字符串');
        dependencies.recognizeImage.mockResolvedValueOnce('bad');
        await expect(ocr.handle({type: IMAGE_OCR_MESSAGE_TYPE, image: 'data:image/png,x', sourceLanguage: 'en'}))
            .rejects.toThrow('图片 OCR 结果无效');

        await expect(imageTranslate.handle({
            type: IMAGE_TRANSLATE_MESSAGE_TYPE,
            image: 'data:image/png,x',
            sourceLanguage: 'en',
            title: 1,
        })).rejects.toThrow('title 必须是字符串');
        dependencies.translateImage.mockResolvedValueOnce(null);
        await expect(imageTranslate.handle({
            type: IMAGE_TRANSLATE_MESSAGE_TYPE,
            image: 'data:image/png,x',
            sourceLanguage: 'en',
            title: 'Page',
        })).rejects.toThrow('图片翻译结果无效');
        dependencies.translateImage.mockResolvedValueOnce([]);
        await expect(imageTranslate.handle({
            type: IMAGE_TRANSLATE_MESSAGE_TYPE,
            image: 'data:image/png,x',
            sourceLanguage: 'en',
        })).rejects.toThrow('图片翻译结果无效');

        await expect(texts.handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: null}))
            .rejects.toThrow('图片中没有可翻译文字');
        await expect(texts.handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: []}))
            .rejects.toThrow('图片中没有可翻译文字');
        await expect(texts.handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: [1]}))
            .rejects.toThrow('texts 只能包含非空字符串');
        await expect(texts.handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: [' ']}))
            .rejects.toThrow('texts 只能包含非空字符串');
        dependencies.translateTexts.mockResolvedValueOnce('single');
        await expect(texts.handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: ['a']}))
            .rejects.toThrow('图片文字批量翻译失败：provider 未返回等长非空字符串数组');
        dependencies.translateTexts.mockResolvedValueOnce([]);
        await expect(texts.handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: ['a']}))
            .rejects.toThrow('图片文字批量翻译失败：provider 未返回等长非空字符串数组');
        dependencies.translateTexts.mockResolvedValueOnce([1] as unknown as string[]);
        await expect(texts.handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: ['a']}))
            .rejects.toThrow('图片文字批量翻译失败：provider 未返回等长非空字符串数组');

        await expect(download.handle({type: IMAGE_OCR_DOWNLOAD_MESSAGE_TYPE, languages: null}))
            .rejects.toThrow('OCR 语言包列表不能为空');
        await expect(download.handle({type: IMAGE_OCR_DOWNLOAD_MESSAGE_TYPE, languages: []}))
            .rejects.toThrow('OCR 语言包列表不能为空');
        await expect(download.handle({type: IMAGE_OCR_DOWNLOAD_MESSAGE_TYPE, languages: [1]}))
            .rejects.toThrow('包含不支持的语言');
        await expect(download.handle({type: IMAGE_OCR_DOWNLOAD_MESSAGE_TYPE, languages: ['unsupported']}))
            .rejects.toThrow('包含不支持的语言');

    });

    it('图片文字对不支持 batch 的 provider 并发保序，并标明失败段号', async () => {
        const translateTexts = vi.fn(async (request: {origin: string | string[]}) => {
            if (Array.isArray(request.origin)) throw new Error('legacy provider 不接受数组');
            return `译:${request.origin}`;
        });
        const dependencies = {
            assertLanguagesDownloaded: vi.fn(async () => undefined),
            recognizeImage: vi.fn(async () => []),
            translateImage: vi.fn(async () => ({image: 'data:image/png,x', lines: []})),
            fetchImage: vi.fn(async () => 'data:image/png;base64,remote'),
            translateTexts,
            getTranslationService: vi.fn(() => 'google'),
            supportsBatchTranslation: vi.fn(() => false),
            downloadLanguages: vi.fn(async () => undefined),
            markLanguagesDownloaded: vi.fn(async () => []),
            now: () => 0,
        };
        const handler = createImageTranslationBackgroundHandlers(dependencies)
            .find((candidate) => candidate.type === IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE)!;

        await expect(handler.handle({
            type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
            texts: ['first', 'second', 'third'],
            title: 'Page',
        })).resolves.toEqual({
            success: true,
            translations: ['译:first', '译:second', '译:third'],
        });
        expect(translateTexts.mock.calls.map(([request]) => request)).toEqual([
            {origin: 'first', context: 'Page', pageContext: '', useCache: true, serviceOverride: 'google', requestTimeoutMs: IMAGE_TEXT_TRANSLATION_TIMEOUT_MS},
            {origin: 'second', context: 'Page', pageContext: '', useCache: true, serviceOverride: 'google', requestTimeoutMs: IMAGE_TEXT_TRANSLATION_TIMEOUT_MS},
            {origin: 'third', context: 'Page', pageContext: '', useCache: true, serviceOverride: 'google', requestTimeoutMs: IMAGE_TEXT_TRANSLATION_TIMEOUT_MS},
        ]);

        translateTexts.mockReset()
            .mockResolvedValueOnce('译:first')
            .mockRejectedValueOnce(new Error('provider down'));
        await expect(handler.handle({
            type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
            texts: ['first', 'second', 'third'],
        })).rejects.toThrow('图片第 2 段文字翻译失败：provider down');
        expect(translateTexts).toHaveBeenCalledTimes(3);

        translateTexts.mockReset()
            .mockRejectedValueOnce('字符串错误');
        await expect(handler.handle({
            type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
            texts: ['first'],
        })).rejects.toThrow('图片第 1 段文字翻译失败：字符串错误');

        translateTexts.mockReset()
            .mockResolvedValueOnce(['错误数组'] as unknown as string);
        await expect(handler.handle({
            type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
            texts: ['first'],
        })).rejects.toThrow('图片第 1 段文字翻译失败：provider 未返回字符串译文');
    });

    it('图片 legacy 并发窗口共享绝对预算，超时后不再启动后续段', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        try {
            const translateTexts = vi.fn((request: {origin: string | string[]; requestTimeoutMs: number}) => (
                new Promise<string | string[]>((resolve, reject) => {
                    if (Array.isArray(request.origin)) {
                        reject(new Error('legacy provider 不应收到批量请求'));
                        return;
                    }
                    if (request.origin === 'first') {
                        setTimeout(() => resolve('译:first'), 70_000);
                        return;
                    }
                    setTimeout(() => reject(new Error('翻译请求超时')), request.requestTimeoutMs);
                })
            ));
            const dependencies = {
                assertLanguagesDownloaded: vi.fn(async () => undefined),
                recognizeImage: vi.fn(async () => []),
                translateImage: vi.fn(async () => ({image: 'data:image/png,x', lines: []})),
                fetchImage: vi.fn(async () => 'data:image/png;base64,remote'),
                translateTexts,
                getTranslationService: vi.fn(() => 'google'),
                supportsBatchTranslation: vi.fn(() => false),
                downloadLanguages: vi.fn(async () => undefined),
                markLanguagesDownloaded: vi.fn(async () => []),
            };
            const handler = createImageTranslationBackgroundHandlers(dependencies)
                .find((candidate) => candidate.type === IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE)!;
            const request = handler.handle({
                type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
                texts: ['first', 'second', 'third', 'fourth', 'fifth'],
            });
            const rejection = expect(request).rejects.toThrow('图片第 2 段文字翻译失败：翻译请求超时');

            await vi.advanceTimersByTimeAsync(70_000);
            expect(translateTexts).toHaveBeenCalledTimes(4);
            expect(translateTexts.mock.calls.map(([entry]) => entry.requestTimeoutMs))
                .toEqual([120_000, 120_000, 120_000, 50_000]);

            await vi.advanceTimersByTimeAsync(50_000);
            await rejection;
            expect(translateTexts).toHaveBeenCalledTimes(4);
        } finally {
            vi.useRealTimers();
        }
    });

    it('图片文字事务在首个 provider 调用前预算耗尽时立即停止', async () => {
        const translateTexts = vi.fn();
        let nowCalls = 0;
        const dependencies = {
            assertLanguagesDownloaded: vi.fn(async () => undefined),
            recognizeImage: vi.fn(async () => []),
            translateImage: vi.fn(async () => ({image: 'data:image/png,x', lines: []})),
            fetchImage: vi.fn(async () => 'data:image/png;base64,remote'),
            translateTexts,
            getTranslationService: vi.fn(() => 'microsoft'),
            supportsBatchTranslation: vi.fn(() => true),
            downloadLanguages: vi.fn(async () => undefined),
            markLanguagesDownloaded: vi.fn(async () => []),
            now: () => nowCalls++ === 0 ? 0 : IMAGE_TEXT_TRANSLATION_TIMEOUT_MS,
        };
        const handler = createImageTranslationBackgroundHandlers(dependencies)
            .find((candidate) => candidate.type === IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE)!;

        await expect(handler.handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: ['first']}))
            .rejects.toThrow('图片文字批量翻译失败：图片文字翻译总时间已耗尽');
        expect(translateTexts).not.toHaveBeenCalled();
    });
});


describe('繁体词典辅助内容只采用本次成功翻译', () => {
    const originalCard = () => wordCard([
        {definition: 'to move quickly', example: 'Run home.', translatedDefinition: '快速移动', translatedExample: '跑回家。'},
    ]);
    const assertOriginalPreserved = (card: WordCardData) => {
        expect(card.meanings[0].definitions[0]).toEqual({definition: 'to move quickly', example: 'Run home.', translatedDefinition: '快速移动', translatedExample: '跑回家。'});
    };
    it.each(['single', ['only-one'], null])('繁体目标无效批量结果 %j 清除旧辅助内容且不改词典缓存', async (response) => {
        const card = originalCard();
        const result = await translateVisibleWordCardFields(card, 'zh-HK', async () => response as string | string[], vi.fn());
        expect(result).not.toBe(card);
        expect(result.meanings[0].definitions[0]).toEqual({definition: 'to move quickly', example: 'Run home.'});
        assertOriginalPreserved(card);
    });
    it('繁体目标翻译异常仍保留词典原文，但不能回退旧简体辅助内容', async () => {
        const card = originalCard();
        const warn = vi.fn();
        const result = await translateVisibleWordCardFields(card, 'zh-Hant', async () => { throw new Error('offline'); }, warn);
        expect(result.meanings[0].definitions[0]).toEqual({definition: 'to move quickly', example: 'Run home.'});
        expect(warn).toHaveBeenCalledOnce();
        assertOriginalPreserved(card);
    });
    it('零可翻译槽位也清除旧辅助字段，不触发请求且不修改原卡', async () => {
        const card = wordCard([{definition: '', translatedDefinition: '旧释义', translatedExample: '旧例句'}]);
        const translate = vi.fn();
        const result = await translateVisibleWordCardFields(card, 'zh-Hant-TW', translate, vi.fn());
        expect(result.meanings[0].definitions[0]).toEqual({definition: ''});
        expect(card.meanings[0].definitions[0].translatedDefinition).toBe('旧释义');
        expect(translate).not.toHaveBeenCalled();
    });
    it('空值、非字符串、原样返回都不能保留简体旧辅助，只填成功槽位', async () => {
        const card = wordCard([
            {definition: 'first', example: 'second', translatedDefinition: '旧释义一', translatedExample: '旧例句一'},
            {definition: 'third', example: 'fourth', translatedDefinition: '旧释义二', translatedExample: '旧例句二'},
            {definition: 'fifth', translatedDefinition: '旧释义三'},
        ]);
        const result = await translateVisibleWordCardFields(card, 'zh-Hant', async () => [' ', 7, 'third', ' 第四句 ', '第五義'] as unknown as string[], vi.fn());
        expect(result.meanings[0].definitions).toEqual([
            {definition: 'first', example: 'second'},
            {definition: 'third', example: 'fourth', translatedExample: '第四句'},
            {definition: 'fifth', translatedDefinition: '第五義'},
        ]);
        expect(card.meanings[0].definitions[0].translatedDefinition).toBe('旧释义一');
    });
    it('规范化繁体别名，成功翻译回填目标译文并保持所有原始卡片字段独立', async () => {
        const card = originalCard();
        const translate = vi.fn(async () => ['快速移動', '跑回家。']);
        const handler = createSelectionWordLookupHandler({lookupWord: async () => card, getDefaultTargetLanguage: () => 'zh-TW', translate, warn: vi.fn()});
        const {data} = await handler.handle({type: SELECTION_WORD_LOOKUP_MESSAGE_TYPE, word: 'run'});
        expect(translate).toHaveBeenCalledWith(expect.objectContaining({targetLanguage: 'zh-Hant'}));
        expect(data?.meanings[0].definitions[0]).toMatchObject({translatedDefinition: '快速移動', translatedExample: '跑回家。'});
        expect(data?.sources[0]).not.toBe(card.sources[0]);
        assertOriginalPreserved(card);
    });
    it('简体目标继续保留原卡中的可用简体失败回退', async () => {
        const card = originalCard();
        await expect(translateVisibleWordCardFields(card, 'zh-CN', async () => { throw new Error('offline'); }, vi.fn())).resolves.toBe(card);
        assertOriginalPreserved(card);
    });
});
