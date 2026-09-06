import {describe, expect, it, vi} from 'vitest';
import {
    createCapabilityGatedBackgroundHandlers,
    createCapabilityGatedSelectionTtsTransport,
} from '@/src/app/background/capabilityRegistry';
import {resolveBrowserCapabilities} from '@/src/platform/browser/capabilities';
import type {BackgroundMessageHandler} from '@/src/app/background/messageRouter';

const handler = (type: string): BackgroundMessageHandler<object> => ({
    type,
    handle: vi.fn(async () => ({success: true})),
});

describe('background capability registry', () => {
    it.each([{browser: 'chrome', manifestVersion: 3 as const}, {browser: 'firefox', manifestVersion: 2 as const}])('registers the same feature handlers for $browser', (target) => {
        const areaHandlers = [handler('area-a'), handler('area-b')];
        const imageHandlers = [handler('image')];
        const areaTranslation = vi.fn(() => areaHandlers);
        const imageTranslation = vi.fn(() => imageHandlers);

        expect(createCapabilityGatedBackgroundHandlers(
            resolveBrowserCapabilities(target),
            {areaTranslation, imageTranslation},
        )).toEqual([...areaHandlers, ...imageHandlers]);
        expect(areaTranslation).toHaveBeenCalledOnce();
        expect(imageTranslation).toHaveBeenCalledOnce();
    });

    it('does not instantiate unsupported Firefox MV3 feature factories', () => {
        const areaTranslation = vi.fn(() => [handler('area')]);
        const imageTranslation = vi.fn(() => [handler('image')]);

        expect(createCapabilityGatedBackgroundHandlers(
            resolveBrowserCapabilities({browser: 'firefox', manifestVersion: 3}),
            {areaTranslation, imageTranslation},
        )).toEqual([]);
        expect(areaTranslation).not.toHaveBeenCalled();
        expect(imageTranslation).not.toHaveBeenCalled();
    });

    it('can gate the two feature families independently', () => {
        const area = handler('area');
        const image = handler('image');
        const baseline = resolveBrowserCapabilities({browser: 'firefox', manifestVersion: 3});

        expect(createCapabilityGatedBackgroundHandlers(
            {...baseline, areaTranslation: true},
            {areaTranslation: () => [area], imageTranslation: () => [image]},
        )).toEqual([area]);
        expect(createCapabilityGatedBackgroundHandlers(
            {...baseline, imageTranslation: true},
            {areaTranslation: () => [area], imageTranslation: () => [image]},
        )).toEqual([image]);
    });

    it('preserves Offscreen transport on supported targets and makes page-only stop a no-op', async () => {
        const play = vi.fn(async (_request: {id: string}) => undefined);
        const stop = vi.fn(async (_route: {id: string}) => undefined);
        const transport = {play, stop};
        const chromeTransport = createCapabilityGatedSelectionTtsTransport(
            resolveBrowserCapabilities({browser: 'chrome', manifestVersion: 3}),
            transport,
        );
        expect(chromeTransport).toBe(transport);
        await chromeTransport.play({id: 'chrome'});
        await chromeTransport.stop({id: 'chrome'});
        expect(play).toHaveBeenCalledWith({id: 'chrome'});
        expect(stop).toHaveBeenCalledWith({id: 'chrome'});

        const pageOnlyTransport = createCapabilityGatedSelectionTtsTransport(
            resolveBrowserCapabilities({browser: 'firefox', manifestVersion: 3}),
            transport,
        );
        expect(pageOnlyTransport.play).toBe(play);
        await pageOnlyTransport.stop({id: 'firefox'});
        expect(stop).toHaveBeenCalledTimes(1);
    });
});
