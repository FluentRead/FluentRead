import {afterEach, describe, expect, it, vi} from 'vitest';

const ports = vi.hoisted(() => ({
    config: {from: 'en'},
    handlers: vi.fn((options: any) => options),
    ownership: vi.fn((getTab: (id: number) => Promise<unknown>) => getTab),
    resolveRoute: vi.fn(() => 'vision-route'),
    prepareRoute: vi.fn(() => 'prepared-route'),
    prepareVision: vi.fn(() => 'vision-transaction'),
    prepareText: vi.fn(() => 'text-transaction'),
    translate: vi.fn(), crop: vi.fn(), translateArea: vi.fn(), progress: vi.fn(),
    probe: vi.fn(),
}));
vi.mock('@/src/services/config/store', () => ({config: ports.config}));
vi.mock('@/src/app/translation/runtime', () => ({translateWithCache: ports.translate}));
vi.mock('@/src/core/config/vision', () => ({resolveAreaRecognitionRoute: ports.resolveRoute}));
vi.mock('@/src/app/translation/visionProbeRuntime', () => ({modelVisionProbe: {resolve: ports.probe}}));
vi.mock('@/src/services/translation/visionProbe', () => ({prepareModelVisionRoute: ports.prepareRoute}));
vi.mock('@/src/app/background/handlers/areaTranslation', () => ({
    createAreaTranslationBackgroundHandlers: ports.handlers,
    createAreaCaptureOwnershipVerifier: ports.ownership,
}));
vi.mock('@/src/features/area-translation/services/textTranslation', () => ({
    prepareAreaVisionRecognition: ports.prepareVision, prepareAreaTextTranslation: ports.prepareText,
}));
vi.mock('@/src/features/area-translation/background/offscreenAdapter', () => ({
    areaTranslationOffscreenAdapter: {cropArea: ports.crop, translateArea: ports.translateArea},
}));
vi.mock('@/src/features/image-translation/background/offscreenAdapter', () => ({
    imageTranslationProgressTransport: {sendProgress: ports.progress},
}));

import {createAreaTranslationRuntime} from '@/src/app/background/areaRuntime';

afterEach(() => {vi.unstubAllGlobals(); vi.clearAllMocks(); ports.config.from = 'en';});

describe('圈选翻译后台组合入口', () => {
    it('捕获使用请求窗口和标签所有权，并传递真实语言及识别端口', async () => {
        const capture = vi.fn(async () => 'image');
        const get = vi.fn(async (id: number) => ({id, windowId: 4, active: true}));
        vi.stubGlobal('browser', {tabs: {captureVisibleTab: capture, get}});
        const assertLanguagesDownloaded = vi.fn(async () => undefined);
        const handlers = createAreaTranslationRuntime(assertLanguagesDownloaded) as any;
        expect(await handlers.captureVisibleTab(4)).toBe('image');
        expect(capture).toHaveBeenCalledWith(4, {format: 'png'});
        expect(await handlers.assertCaptureOwner(7)).toEqual({id: 7, windowId: 4, active: true});
        expect(handlers.assertLanguagesDownloaded).toBe(assertLanguagesDownloaded);
        expect(handlers.translateArea).toBe(ports.translateArea);
        expect(handlers.sendProgress).toBe(ports.progress);
        expect(handlers.getDefaultSourceLanguage()).toBe('en');
        ports.config.from = 'fr';
        expect(handlers.getDefaultSourceLanguage()).toBe('fr');
        expect(handlers.getVisionRoute()).toBe('vision-route');
        expect(handlers.prepareVisionRoute()).toBe('prepared-route');
        expect(ports.prepareRoute).toHaveBeenCalledWith(ports.config, ports.probe);
    });

    it('文字与识图事务保留可信 sender 的隐私范围，不将未知状态虚构为普通窗口', () => {
        vi.stubGlobal('browser', {tabs: {captureVisibleTab: vi.fn(), get: vi.fn()}});
        const handlers = createAreaTranslationRuntime(vi.fn()) as any;
        const privateContext = {sender: {url: 'https://example.org/article', tab: {incognito: true}}};
        const normalContext = {sender: {url: 'https://example.org/article', tab: {incognito: false}}};
        const unknownContext = {sender: {url: 'https://example.org/article'}};
        for (const [context, expected] of [[privateContext, {privateContext: true}], [normalContext, {privateContext: false}], [unknownContext, {}]] as const) {
            expect(handlers.prepareVisionTranslation('en', 'title', context)).toBe('vision-transaction');
            expect(ports.prepareVision).toHaveBeenLastCalledWith(ports.config, 'en', 'title', ports.crop, ports.translate, Date.now, expected);
            expect(handlers.prepareTextTranslation('en', 'title', context)).toBe('text-transaction');
            expect(ports.prepareText).toHaveBeenLastCalledWith(ports.config, 'en', 'title',
                {pageUrl: 'https://example.org/article', context: 'page', ...expected}, ports.translate);
        }
    });
});
