import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {canOpenTranslationSidepanel, openTranslationSidepanel} from '@/src/platform/browser/translationSidepanel';

const ports = vi.hoisted(() => ({browser: 'chrome', sidebar: undefined as undefined | {open: () => Promise<void>}}));
vi.mock('@/src/platform/browser/capabilities', () => ({browserCapabilities: {get browser() {return ports.browser;}}}));
vi.mock('webextension-polyfill', () => ({default: {get sidebarAction() {return ports.sidebar;}}}));
beforeEach(() => {ports.browser = 'chrome';ports.sidebar = undefined;vi.stubGlobal('chrome', undefined);});
afterEach(() => vi.unstubAllGlobals());

describe('native translation sidepanel browser boundary', () => {
    it.each(['chrome', 'edge'])('opens %s synchronously in the originating window', async target => {
        ports.browser = target;
        const open = vi.fn().mockResolvedValue(undefined);vi.stubGlobal('chrome', {sidePanel: {open}});
        expect(canOpenTranslationSidepanel()).toBe(true);
        const pending = openTranslationSidepanel(0);
        expect(open).toHaveBeenCalledWith({windowId: 0});
        await pending;
    });
    it('uses Firefox sidebarAction within the original gesture without querying a tab', async () => {
        ports.browser = 'firefox';const open = vi.fn().mockResolvedValue(undefined);ports.sidebar = {open};
        expect(canOpenTranslationSidepanel()).toBe(true);
        const pending = openTranslationSidepanel();expect(open).toHaveBeenCalledOnce();await pending;
    });
    it.each(['safari', 'thunderbird', 'unknown', 'chrome', 'firefox'])('hides unavailable APIs on %s and rejects rather than opening another page', async target => {
        ports.browser = target;
        expect(canOpenTranslationSidepanel()).toBe(false);
        await expect(openTranslationSidepanel(3)).rejects.toThrow('unavailable');
    });
    it('does not mistake a Chromium sidePanel namespace without open for support', () => {
        vi.stubGlobal('chrome', {sidePanel: {}});expect(canOpenTranslationSidepanel()).toBe(false);
    });
    it.each([undefined, -1, 1.5, NaN])('rejects invalid Chromium window identity %s', async windowId => {
        const open = vi.fn();vi.stubGlobal('chrome', {sidePanel: {open}});
        await expect(openTranslationSidepanel(windowId)).rejects.toThrow('current window');expect(open).not.toHaveBeenCalled();
    });
    it('propagates native failure to the calling popup for a visible retry', async () => {
        vi.stubGlobal('chrome', {sidePanel: {open: vi.fn().mockRejectedValue(new Error('gesture rejected'))}});
        await expect(openTranslationSidepanel(3)).rejects.toThrow('gesture rejected');
    });

});
