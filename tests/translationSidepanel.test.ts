import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {canOpenTranslationSidepanel, openTranslationSidepanel} from '@/src/platform/browser/translationSidepanel';

const ports = vi.hoisted(() => ({browser: 'chrome', sidebar: undefined as undefined | {open: () => Promise<void>}, query: vi.fn()}));
vi.mock('@/src/platform/browser/capabilities', () => ({browserCapabilities: {get browser() {return ports.browser;}}}));
vi.mock('webextension-polyfill', () => ({default: {get sidebarAction() {return ports.sidebar;}, tabs: {query: ports.query}}}));
beforeEach(() => {
    ports.browser = 'chrome';
    ports.sidebar = undefined;
    ports.query.mockReset().mockResolvedValue([]);
    vi.stubGlobal('chrome', undefined);
});
afterEach(() => vi.unstubAllGlobals());

function mockSidepanel() {
    const panel = {
        getOptions: vi.fn().mockResolvedValue({}),
        setOptions: vi.fn().mockResolvedValue(undefined),
        open: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal('chrome', {sidePanel: panel});
    return panel;
}

const openFor = (
    scope: 'tab' | 'window',
    tabId: number | null = null,
    windowId?: number,
    isCurrent = () => true,
) => openTranslationSidepanel({scope, tabId, windowId}, isCurrent);

describe('native translation sidepanel browser boundary', () => {
    it.each(['chrome', 'edge'])('registers and opens only the originating %s tab in the click turn', async target => {
        ports.browser = target;
        const {setOptions, open} = mockSidepanel();
        expect(canOpenTranslationSidepanel()).toBe(true);
        const pending = openFor('tab', 0, 5);
        expect(setOptions).toHaveBeenNthCalledWith(1, {enabled: false});
        expect(setOptions).toHaveBeenNthCalledWith(2, {tabId: 0, path: 'sidepanel.html', enabled: true});
        expect(open).toHaveBeenCalledWith({tabId: 0});
        expect(setOptions.mock.invocationCallOrder[1]).toBeLessThan(open.mock.invocationCallOrder[0]);
        expect(ports.query).not.toHaveBeenCalled();
        await pending;
    });
    it('removes old tab entries in the target window before opening a shared panel', async () => {
        const {getOptions, setOptions, open} = mockSidepanel();
        ports.query.mockResolvedValue([{id: 2}, {id: 3}, {id: 4}, {}]);
        getOptions.mockResolvedValueOnce({tabId: 2, path: 'sidepanel.html', enabled: true})
            .mockResolvedValueOnce({path: 'sidepanel.html', enabled: true})
            .mockResolvedValueOnce({tabId: 4, enabled: false});
        await openFor('window', 2, 0);
        expect(ports.query).toHaveBeenCalledWith({windowId: 0});
        expect(getOptions.mock.calls).toEqual([[{tabId: 2}], [{tabId: 3}], [{tabId: 4}]]);
        expect(setOptions.mock.calls).toEqual([
            [{tabId: 2, enabled: false}],
            [{path: 'sidepanel.html', enabled: true}],
        ]);
        expect(open).toHaveBeenCalledWith({windowId: 0});
        expect(setOptions.mock.invocationCallOrder[1]).toBeLessThan(open.mock.invocationCallOrder[0]);
    });
    it('restores Edge tab availability after closing its old contextual panel', async () => {
        ports.browser = 'edge';
        const {getOptions, setOptions, open} = mockSidepanel();
        ports.query.mockResolvedValue([{id: 2}, {id: 3}]);
        getOptions.mockResolvedValueOnce({tabId: 2, enabled: true}).mockResolvedValueOnce({});
        await openFor('window', 2, 5);
        expect(setOptions.mock.calls).toEqual([
            [{tabId: 2, enabled: false}],
            [{tabId: 2, enabled: true}],
            [{path: 'sidepanel.html', enabled: true}],
        ]);
        expect(setOptions.mock.invocationCallOrder[2]).toBeLessThan(open.mock.invocationCallOrder[0]);
        expect(open).toHaveBeenCalledWith({windowId: 5});
    });
    it('abandons a window opening when the popup changes scope or target during preparation', async () => {
        const {setOptions, open} = mockSidepanel();
        let current = true;
        const pending = openFor('window', 2, 5, () => current);
        current = false;
        await pending;
        expect(setOptions).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
    });
    it('uses Firefox sidebarAction within the original gesture without querying a tab', async () => {
        ports.browser = 'firefox';const open = vi.fn().mockResolvedValue(undefined);ports.sidebar = {open};
        expect(canOpenTranslationSidepanel()).toBe(true);
        const pending = openFor('tab');expect(open).toHaveBeenCalledOnce();await pending;
        expect(ports.query).not.toHaveBeenCalled();
    });
    it.each(['safari', 'thunderbird', 'unknown', 'chrome', 'firefox'])('hides unavailable APIs on %s and rejects rather than opening another page', async target => {
        ports.browser = target;
        expect(canOpenTranslationSidepanel()).toBe(false);
        await expect(openFor('tab', 3)).rejects.toThrow('unavailable');
    });
    it('does not mistake a Chromium sidePanel namespace without open for support', () => {
        vi.stubGlobal('chrome', {sidePanel: {}});expect(canOpenTranslationSidepanel()).toBe(false);
    });
    it.each([undefined, -1, 1.5, NaN])('rejects invalid Chromium tab and window identity %s', async id => {
        const {setOptions, open} = mockSidepanel();
        await expect(openFor('tab', id)).rejects.toThrow('current tab');
        await expect(openFor('window', 2, id)).rejects.toThrow('current window');
        expect(open).not.toHaveBeenCalled();
        expect(setOptions).not.toHaveBeenCalled();
    });
    it('propagates native failure to the calling popup for a visible retry', async () => {
        const {open, setOptions} = mockSidepanel();
        open.mockRejectedValueOnce(new Error('gesture rejected'));
        await expect(openFor('tab', 3)).rejects.toThrow('gesture rejected');
        setOptions.mockRejectedValueOnce(new Error('registration failed'));
        await expect(openFor('tab', 3)).rejects.toThrow('registration failed');
    });

});
