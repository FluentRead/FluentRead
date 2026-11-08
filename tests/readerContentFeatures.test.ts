import {afterEach, describe, expect, it, vi} from 'vitest';
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import {Config} from '@/src/core/config/model';
import {createReaderContentFeatures} from '@/src/app/content/readerFeatures';

const mocks = vi.hoisted(() => ({
    isAreaTranslatorMounted: vi.fn(),
    isFloatingBallAllowedOnPage: vi.fn(),
    isImageTranslatorNeeded: vi.fn(),
    isMangaReaderPage: vi.fn(),
    mountAreaTranslator: vi.fn(),
    mountFloatingBall: vi.fn(),
    mountImageTranslator: vi.fn(),
    mountMangaEntry: vi.fn(),
    mountSelectionTranslator: vi.fn(),
    mountTranslationProgressPanel: vi.fn(),
    startAreaTranslationFromContextMenu: vi.fn(),
    unmountAreaTranslator: vi.fn(),
    unmountFloatingBall: vi.fn(),
    unmountImageTranslator: vi.fn(),
    unmountMangaEntry: vi.fn(),
    unmountSelectionTranslator: vi.fn(),
    unmountTranslationProgressPanel: vi.fn(),
}));
vi.mock('@/src/app/content/features', () => mocks);
afterEach(() => {vi.unstubAllGlobals(); vi.resetAllMocks();});

describe('reading UI registry bindings', () => {
    const ctx = {} as ContentScriptContext;
    function preferences() {
        return Object.assign(new Config(), {
            on: true, disableFloatingBall: false, disableSelectionTranslator: false,
            selectionTranslatorMode: 'bilingual', selectionAreaEnabled: true,
            imageTranslationMangaEnabled: true, translationProgressPanelEnabled: true,
        });
    }

    it('keeps activation order, browser capability gates and mount ownership', () => {
        const features = createReaderContentFeatures(ctx, preferences());
        expect(features.map(({id, requiredCapability}) => [id, requiredCapability])).toEqual([
            ['floating-ball', undefined], ['selection-translator', undefined],
            ['selection-area-translator', 'areaTranslation'], ['image-translator', 'imageTranslation'],
            ['manga-entry', 'imageTranslation'], ['translation-progress-panel', undefined],
        ]);
        const runtime = {ctx, signal: new AbortController().signal, isCurrent: () => true};
        features.forEach(feature => {feature.mount(runtime); feature.unmount?.();});
        expect(mocks.mountFloatingBall).toHaveBeenCalledWith(ctx);
        expect(mocks.mountSelectionTranslator).toHaveBeenCalledWith(ctx);
        expect(mocks.mountAreaTranslator).toHaveBeenCalledWith(ctx);
        expect(mocks.mountImageTranslator).toHaveBeenCalledWith();
        expect(mocks.mountMangaEntry).toHaveBeenCalledWith(ctx, {startAreaTranslation: mocks.startAreaTranslationFromContextMenu});
        expect(mocks.mountTranslationProgressPanel).toHaveBeenCalledWith(ctx);
        for (const unmount of [mocks.unmountFloatingBall, mocks.unmountSelectionTranslator, mocks.unmountAreaTranslator,
            mocks.unmountImageTranslator, mocks.unmountMangaEntry, mocks.unmountTranslationProgressPanel]) {
            expect(unmount).toHaveBeenCalledOnce();
        }
        const getElementById = vi.fn(() => ({}));
        vi.stubGlobal('document', {getElementById});
        mocks.isAreaTranslatorMounted.mockReturnValue(true);
        expect(features.map(feature => feature.isMounted?.())).toEqual([true, true, true, undefined, undefined, true]);
        expect(getElementById.mock.calls).toEqual([
            ['fluent-read-floating-ball-container'], ['fluent-read-selection-translator-container'],
            ['fluent-read-translation-status-container'],
        ]);
    });

    it('reads current config and page-specific guards whenever the registry reconciles', () => {
        const config = preferences();
        const features = createReaderContentFeatures(ctx, config);
        const enabled = () => features.map(feature => feature.isEnabled());
        mocks.isFloatingBallAllowedOnPage.mockReturnValue(true);
        mocks.isMangaReaderPage.mockReturnValue(true);
        mocks.isImageTranslatorNeeded.mockReturnValue(true);
        expect(enabled()).toEqual([true, true, true, true, true, true]);
        config.on = false;
        expect(enabled()).toEqual([false, false, false, true, false, false]);
        Object.assign(config, {
            on: true, disableFloatingBall: true, disableSelectionTranslator: true,
            selectionAreaEnabled: false, imageTranslationMangaEnabled: false, translationProgressPanelEnabled: false,
        });
        mocks.isImageTranslatorNeeded.mockReturnValue(false);
        expect(enabled()).toEqual([false, false, false, false, false, false]);
        Object.assign(config, {
            disableFloatingBall: false, disableSelectionTranslator: false,
            selectionTranslatorMode: 'disabled', imageTranslationMangaEnabled: true,
        });
        mocks.isFloatingBallAllowedOnPage.mockReturnValue(false);
        mocks.isMangaReaderPage.mockReturnValue(false);
        expect(enabled()).toEqual([false, false, false, false, false, false]);
    });
});
