import {afterEach, describe, expect, it, vi} from 'vitest';
import {configurePdfResources, getPdfResources, hasCustomPdfAssetRoot} from '../src/features/document-translation/services/pdfResources';

afterEach(() => {configurePdfResources(); vi.unstubAllGlobals();});
describe('PDF static resource application boundary', () => {
    it('uses no browser asset base in a non-DOM runtime', () => {
        vi.stubGlobal('window', undefined);
        expect(hasCustomPdfAssetRoot()).toBe(false);
        expect(getPdfResources().assetRoot).toBe('');
        expect(getPdfResources().workerUrl).toContain('pdf.worker.min.mjs');
    });
    it('retains extension default resource addresses', () => {
        vi.stubGlobal('window', {location: {origin: 'moz-extension://fixture'}});
        expect(getPdfResources().assetRoot).toBe('moz-extension://fixture/pdfjs');
    });
    it('shares immutable explicit desktop resources and can reset the application port', () => {
        const source = {assetRoot: 'chrome://fluentread/content/pdfjs///', workerUrl: 'chrome://fluentread/content/pdfjs/worker.mjs'};
        configurePdfResources(source);
        source.workerUrl = 'changed';
        expect(hasCustomPdfAssetRoot()).toBe(true);
        expect(getPdfResources()).toEqual({assetRoot: 'chrome://fluentread/content/pdfjs', workerUrl: 'chrome://fluentread/content/pdfjs/worker.mjs'});
        expect(Object.isFrozen(getPdfResources())).toBe(true);
        configurePdfResources();
        expect(hasCustomPdfAssetRoot()).toBe(false);
        expect(getPdfResources().workerUrl).not.toBe('changed');
    });
});
