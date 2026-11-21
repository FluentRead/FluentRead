import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

function installFontMocks() {
    const load = vi.fn<() => Promise<unknown>>();
    const add = vi.fn();
    const create = vi.fn();
    vi.stubGlobal('FontFace', class {
        constructor(...args: unknown[]) { create(...args); }
        load() { return load(); }
    });
    vi.stubGlobal('document', {fonts: {add}});
    return {load, add, create};
}

beforeEach(() => vi.resetModules());
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('image translation canvas font', () => {
    it('only prepares the fallback for supplementary Han and gives system fonts priority', async () => {
        const {IMAGE_TEXT_FONT, mightNeedRareImageFont} = await import('@/src/features/image-translation/services/imageTextFont');
        expect(IMAGE_TEXT_FONT.endsWith('sans-serif, "FluentRead Rare Ideographs"')).toBe(true);
        expect(mightNeedRareImageFont('中 日 한글 café 🙂')).toBe(false);
        expect(mightNeedRareImageFont('店主 𠮷川')).toBe(true);
        expect(mightNeedRareImageFont('𠀀\u{E0101}')).toBe(true);
        expect(mightNeedRareImageFont('\u{E0101}')).toBe(false);
    });

    it('shares one bundled face and only registers it after the browser makes it available', async () => {
        const {load, add, create} = installFontMocks();
        const {prepareRareImageFont} = await import('@/src/features/image-translation/services/imageTextFont');
        let finish!: (face: unknown) => void;
        load.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
        const first = prepareRareImageFont();
        const second = prepareRareImageFont(new AbortController().signal);
        expect(create).toHaveBeenCalledExactlyOnceWith('FluentRead Rare Ideographs',
            'url("/fluent-read-image-fonts/FluentReadRareIdeographs-Regular.woff2")',
            {style: 'normal', weight: '400', unicodeRange: 'U+20000-2EBEF'});
        expect(load).toHaveBeenCalledTimes(1);
        expect(add).not.toHaveBeenCalled();
        const loaded = {status: 'loaded'};
        finish(loaded);
        await Promise.all([first, second]);
        await prepareRareImageFont();
        expect(add).toHaveBeenCalledExactlyOnceWith(loaded);
    });

    it('allows one image to cancel without delaying or cancelling a second image', async () => {
        const {load, create, add} = installFontMocks();
        const {prepareRareImageFont} = await import('@/src/features/image-translation/services/imageTextFont');
        const first = new AbortController();
        first.abort();
        await expect(prepareRareImageFont(first.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(create).not.toHaveBeenCalled();
        let finish!: (face: unknown) => void;
        load.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
        const second = new AbortController();
        const subscriber = prepareRareImageFont(second.signal);
        const anotherImage = prepareRareImageFont();
        second.abort();
        await expect(subscriber).rejects.toMatchObject({name: 'AbortError'});
        expect(add).not.toHaveBeenCalled();
        const loaded = {status: 'loaded'};
        finish(loaded);
        await anotherImage;
        expect(add).toHaveBeenCalledExactlyOnceWith(loaded);
    });

    it('uses a stable system fallback when the font fails to load', async () => {
        const {load, add} = installFontMocks();
        load.mockRejectedValue(new Error('missing bundled font'));
        const {prepareRareImageFont} = await import('@/src/features/image-translation/services/imageTextFont');
        await prepareRareImageFont();
        await prepareRareImageFont();
        expect(load).toHaveBeenCalledTimes(1);
        expect(add).not.toHaveBeenCalled();
    });

    it('does not register a late font that could change an image already being rendered', async () => {
        vi.useFakeTimers();
        const {load, add} = installFontMocks();
        let finish!: (face: unknown) => void;
        load.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
        const {prepareRareImageFont} = await import('@/src/features/image-translation/services/imageTextFont');
        const pending = prepareRareImageFont();
        await vi.advanceTimersByTimeAsync(1_200);
        await pending;
        finish({status: 'loaded'});
        await prepareRareImageFont();
        expect(load).toHaveBeenCalledTimes(1);
        expect(add).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});
