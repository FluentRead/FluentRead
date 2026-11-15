import {describe, expect, it, vi} from 'vitest';
import {createSelectionPageZoomBrowserPort, createSelectionPageZoomHandler} from '@/src/features/selection-translation/background/pageZoomHandler';
import {normalizeSelectionPageZoom, SELECTION_PAGE_ZOOM_CHANGED, SELECTION_PAGE_ZOOM_REQUEST} from '@/src/features/selection-translation/pageZoom';

describe('selection page zoom', () => {
    it('settles a zoom notification after its content script has unloaded', async () => {
        const sendMessage = vi.fn().mockRejectedValue(new Error('Receiving end does not exist'));
        const addListener = vi.fn();
        createSelectionPageZoomBrowserPort({sendMessage, onZoomChange: {addListener}}).installZoomChangeListener();
        addListener.mock.calls[0][0]({tabId: 7, newZoomFactor: 1.5});
        await Promise.resolve();
        expect(sendMessage).toHaveBeenCalledOnce();
        expect(sendMessage).toHaveBeenCalledWith(7, {type: SELECTION_PAGE_ZOOM_CHANGED, zoom: 1.5});
    });
    it('reads only the sender tab zoom and ignores a tab id supplied in the message', async () => {
        const getZoom = vi.fn(async (_tabId: number) => 2);
        const handler = createSelectionPageZoomHandler(getZoom);
        const request = {type: SELECTION_PAGE_ZOOM_REQUEST, tabId: 99};

        await expect(handler.handle(request, {sender: {tab: {id: 7}}})).resolves.toEqual({success: true, zoom: 2});
        expect(getZoom).toHaveBeenCalledOnce();
        expect(getZoom).toHaveBeenCalledWith(7);
        await expect(handler.handle(request, {sender: {}})).resolves.toEqual({success: false});
        expect(getZoom).toHaveBeenCalledTimes(1);
    });

    it('rejects invalid browser zoom values before they reach CSS transforms', () => {
        expect(normalizeSelectionPageZoom(0.5)).toBe(0.5);
        expect(normalizeSelectionPageZoom(1)).toBe(1);
        expect(normalizeSelectionPageZoom(5)).toBe(5);
        for (const value of [0, -1, Infinity, NaN, '2', null]) {
            expect(normalizeSelectionPageZoom(value)).toBe(1);
        }
    });

    it('keeps the sender-scoped message handler usable without Firefox Android zoom APIs', async () => {
        const sendMessage = vi.fn();
        const port = createSelectionPageZoomBrowserPort({sendMessage});
        expect(() => port.installZoomChangeListener()).not.toThrow();
        const handler = createSelectionPageZoomHandler(port.getZoom);
        await expect(handler.handle({type: SELECTION_PAGE_ZOOM_REQUEST}, {sender: {tab: {id: 7}}}))
            .resolves.toEqual({success: true, zoom: 1});
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('keeps selection cards usable when a mobile browser rejects the zoom request', async () => {
        const getZoom = vi.fn(async () => { throw new Error('unsupported'); });
        const handler = createSelectionPageZoomHandler(getZoom);
        await expect(handler.handle({type: SELECTION_PAGE_ZOOM_REQUEST}, {sender: {tab: {id: 7}}}))
            .resolves.toEqual({success: true, zoom: 1});
        expect(getZoom).toHaveBeenCalledWith(7);
    });

    it('preserves desktop zoom readings and forwards only valid tab changes', async () => {
        const getZoom = vi.fn(async () => 2);
        const sendMessage = vi.fn().mockResolvedValue(undefined);
        const addListener = vi.fn();
        const port = createSelectionPageZoomBrowserPort({getZoom, sendMessage, onZoomChange: {addListener}});
        port.installZoomChangeListener();
        await expect(port.getZoom(7)).resolves.toBe(2);
        expect(getZoom).toHaveBeenCalledWith(7);
        const listener = addListener.mock.calls[0][0];
        listener({tabId: -1, newZoomFactor: 2});
        expect(sendMessage).not.toHaveBeenCalled();
        listener({tabId: 7, newZoomFactor: 2});
        expect(sendMessage).toHaveBeenCalledWith(7, {type: SELECTION_PAGE_ZOOM_CHANGED, zoom: 2});
    });
});
