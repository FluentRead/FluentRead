import {describe, expect, it, vi} from 'vitest';
import {
    createFreeTranslationWeightsHandler,
} from '@/src/app/background/handlers/freeTranslationWeights';
import {FREE_TRANSLATION_WEIGHTS_MESSAGE_TYPE} from '@/src/services/translation/freeWeights';

const trustedContext = {sender: {url: 'chrome-extension://fluentread/options.html'}};
const snapshot = {total: 100, observedAt: 123, entries: []} as const;

describe('free translation weights background handler', () => {
    it('waits for config readiness and returns the current snapshot to Options', async () => {
        let release!: () => void;
        const ready = new Promise<void>(resolve => { release = resolve; });
        const getSnapshot = vi.fn(async () => snapshot);
        const handler = createFreeTranslationWeightsHandler({
            ready,
            getSnapshot,
            isOptionsUrl: url => url.startsWith('chrome-extension://fluentread/options.html'),
        });
        const pending = handler.handle({type: FREE_TRANSLATION_WEIGHTS_MESSAGE_TYPE}, trustedContext);

        expect(getSnapshot).not.toHaveBeenCalled();
        release();
        await expect(pending).resolves.toEqual({success: true, snapshot});
        expect(getSnapshot).toHaveBeenCalledOnce();
    });

    it('rejects content pages and malformed sender contexts before reading health', async () => {
        const getSnapshot = vi.fn(async () => snapshot);
        const handler = createFreeTranslationWeightsHandler({
            ready: Promise.resolve(),
            getSnapshot,
            isOptionsUrl: url => url.startsWith('chrome-extension://fluentread/options.html'),
        });

        for (const context of [{sender: {url: 'https://example.com'}}, {sender: {url: 42}}, {sender: 'options'}, {}, undefined]) {
            await expect(handler.handle({type: FREE_TRANSLATION_WEIGHTS_MESSAGE_TYPE}, context)).rejects.toThrow('无权访问');
        }
        expect(getSnapshot).not.toHaveBeenCalled();
    });
});
