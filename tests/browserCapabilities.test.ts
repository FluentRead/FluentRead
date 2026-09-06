import {describe, expect, it} from 'vitest';
import {
    applyRuntimeBrowserConstraints,
    browserBuildTargetFromEnv,
    browserBuildTargetFromImportMeta,
    browserCapabilityBuildMarker,
    browserCapabilities,
    readRuntimeUserAgent,
    resolveBrowserCapabilities,
} from '@/src/platform/browser/capabilities';
import {services} from '@/src/core/config/catalog';
import {
    CHROME_TRANSLATOR_UNAVAILABLE_MESSAGE,
    filterAvailableTranslationServices,
    getTranslationServiceUnavailableMessage,
    isTranslationServiceAvailable,
    supportsTranslationBatch,
} from '@/src/services/translation/capabilities';

describe('browser capability contract', () => {
    it('normalizes Chrome MV3 and keeps Translation API separate from generic Offscreen support', () => {
        const chrome = resolveBrowserCapabilities({browser: ' Chrome ', manifestVersion: 3});
        expect(chrome).toEqual({
            browser: 'chrome',
            manifestVersion: 3,
            offscreenDocument: true,
            extensionDom: true,
            chromeTranslation: true,
            imageOcr: true,
            imageTranslation: true,
            areaTranslation: true,
            selectionTtsExtensionPlayback: true,
            selectionTtsPageFallback: true,
        });
        expect(Object.isFrozen(chrome)).toBe(true);

        expect(resolveBrowserCapabilities({browser: 'EDGE', manifestVersion: 3})).toMatchObject({
            browser: 'edge',
            offscreenDocument: true,
            chromeTranslation: false,
            imageOcr: true,
            imageTranslation: true,
            areaTranslation: true,
            selectionTtsExtensionPlayback: true,
        });
    });

    it('keeps unsupported Firefox MV3, Opera, Chromium MV2 and unknown targets disabled', () => {
        for (const target of [
            {browser: 'firefox', manifestVersion: 3 as const},
            {browser: 'opera', manifestVersion: 3 as const},
            {browser: 'chrome', manifestVersion: 2 as const},
            {browser: '   ', manifestVersion: 3 as const},
        ]) {
            expect(resolveBrowserCapabilities(target)).toMatchObject({
                offscreenDocument: false,
                chromeTranslation: false,
                imageOcr: false,
                imageTranslation: false,
                areaTranslation: false,
                selectionTtsExtensionPlayback: false,
                selectionTtsPageFallback: true,
            });
        }
    });

    it('Firefox MV2 uses shared DOM features without claiming native Offscreen or Chrome Translator', () => {
        expect(resolveBrowserCapabilities({browser: 'firefox', manifestVersion: 2})).toMatchObject({
            offscreenDocument: false,
            extensionDom: true,
            chromeTranslation: false,
            imageOcr: true,
            imageTranslation: true,
            areaTranslation: true,
            selectionTtsExtensionPlayback: true,
            selectionTtsPageFallback: true,
        });
    });

    it('runtime-gates Chrome Translation when a Chrome build is loaded by Edge', () => {
        const chrome = resolveBrowserCapabilities({browser: 'chrome', manifestVersion: 3});
        const edge = applyRuntimeBrowserConstraints(
            chrome,
            'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
        );
        expect(edge).toMatchObject({
            browser: 'edge',
            manifestVersion: 3,
            offscreenDocument: true,
            chromeTranslation: false,
            imageTranslation: true,
        });
        expect(Object.isFrozen(edge)).toBe(true);
        expect(applyRuntimeBrowserConstraints(chrome, 'Mozilla/5.0 Chrome/131.0.0.0')).toBe(chrome);
        const firefox = resolveBrowserCapabilities({browser: 'firefox', manifestVersion: 2});
        expect(applyRuntimeBrowserConstraints(firefox, 'EdgA/131.0')).toBe(firefox);
        expect(applyRuntimeBrowserConstraints(chrome, 'EdgiOS/131.0').browser).toBe('edge');
        expect(readRuntimeUserAgent({navigator: {userAgent: 'Edg/131'}})).toBe('Edg/131');
        expect(readRuntimeUserAgent({})).toBe('');
        expect(readRuntimeUserAgent({navigator: {userAgent: 1}})).toBe('');
    });

    it('derives safe defaults when WXT compile-time env fields are missing or invalid', () => {
        expect(browserBuildTargetFromEnv()).toEqual({browser: 'unknown', manifestVersion: 2});
        expect(browserBuildTargetFromEnv({BROWSER: ''})).toEqual({browser: 'unknown', manifestVersion: 2});
        expect(browserBuildTargetFromEnv({BROWSER: ' Chrome '})).toEqual({browser: 'chrome', manifestVersion: 3});
        expect(browserBuildTargetFromEnv({BROWSER: 'edge'})).toEqual({browser: 'edge', manifestVersion: 3});
        expect(browserBuildTargetFromEnv({BROWSER: 'firefox'})).toEqual({browser: 'firefox', manifestVersion: 2});
        expect(browserBuildTargetFromEnv({BROWSER: 'chrome', MANIFEST_VERSION: 2})).toEqual({
            browser: 'chrome', manifestVersion: 2,
        });
        expect(browserBuildTargetFromEnv({BROWSER: 'firefox', MANIFEST_VERSION: 3})).toEqual({
            browser: 'firefox', manifestVersion: 3,
        });
        expect(browserBuildTargetFromEnv({
            BROWSER: 1,
            MANIFEST_VERSION: 4,
        } as unknown as Partial<ImportMetaEnv>)).toEqual({browser: 'unknown', manifestVersion: 2});
        expect(browserBuildTargetFromImportMeta()).toEqual({browser: 'unknown', manifestVersion: 2});
        expect(browserBuildTargetFromImportMeta({})).toEqual({browser: 'unknown', manifestVersion: 2});
        expect(browserBuildTargetFromImportMeta({env: {BROWSER: 'chrome', MANIFEST_VERSION: 3}}))
            .toEqual({browser: 'chrome', manifestVersion: 3});
        expect(browserCapabilities).toMatchObject({
            browser: 'unknown',
            manifestVersion: 2,
            offscreenDocument: false,
            chromeTranslation: false,
        });
        expect(browserCapabilityBuildMarker).toBe('__FLUENTREAD_BROWSER_CAPABILITY_BUILD__:undefined:mvundefined__');
        expect(browserCapabilities.buildTargetMarker).toBe(browserCapabilityBuildMarker);
        expect(Object.isFrozen(browserCapabilities)).toBe(true);
    });
});

describe('translation service capability contract', () => {
    const chrome = resolveBrowserCapabilities({browser: 'chrome', manifestVersion: 3});
    const firefox = resolveBrowserCapabilities({browser: 'firefox', manifestVersion: 2});

    it('keeps normal providers available and gates only Chrome built-in translation', () => {
        expect(isTranslationServiceAvailable(services.microsoft, firefox)).toBe(true);
        expect(isTranslationServiceAvailable(services.chromeTranslator, chrome)).toBe(true);
        expect(isTranslationServiceAvailable(services.chromeTranslator, firefox)).toBe(false);
        expect(isTranslationServiceAvailable(services.chromeTranslator)).toBe(false);
    });

    it('returns a stable user-facing reason only for unavailable services', () => {
        expect(getTranslationServiceUnavailableMessage(services.microsoft, firefox)).toBeNull();
        expect(getTranslationServiceUnavailableMessage(services.chromeTranslator, chrome)).toBeNull();
        expect(getTranslationServiceUnavailableMessage(services.chromeTranslator, firefox))
            .toBe(CHROME_TRANSLATOR_UNAVAILABLE_MESSAGE);
        expect(getTranslationServiceUnavailableMessage(services.chromeTranslator))
            .toBe(CHROME_TRANSLATOR_UNAVAILABLE_MESSAGE);
    });

    it('filters unsupported Chrome translation without mutating the caller options', () => {
        const options = [
            {value: services.microsoft, label: 'Microsoft'},
            {value: services.chromeTranslator, label: 'Chrome'},
        ] as const;
        expect(filterAvailableTranslationServices(options, firefox)).toEqual([options[0]]);
        expect(filterAvailableTranslationServices(options, chrome)).toEqual(options);
        expect(filterAvailableTranslationServices(options)).toEqual([options[0]]);
        expect(options).toHaveLength(2);
    });

    it('只把明确实现数组协议的 provider 标记为可批量翻译', () => {
        expect(supportsTranslationBatch(services.microsoft)).toBe(true);
        expect(supportsTranslationBatch(services.freeTranslation)).toBe(true);
        expect(supportsTranslationBatch(services.openai)).toBe(true);
        expect(supportsTranslationBatch(services.google)).toBe(false);
        expect(supportsTranslationBatch(services.deeplx)).toBe(false);
        expect(supportsTranslationBatch(services.chromeTranslator)).toBe(false);
        expect(supportsTranslationBatch(services.tongyi)).toBe(false);
    });
});
