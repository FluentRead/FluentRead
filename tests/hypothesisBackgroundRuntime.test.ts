import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createBrowserHypothesisHandler, createToolbarHypothesisMenu, handleToolbarHypothesisClick} from '@/src/app/background/hypothesisRuntime';
import {TabTranslationStateStore} from '@/src/app/background/tabTranslationState';
const settings = vi.hoisted(() => ({on: true, disabledExtensionDomains: [] as string[]}));
vi.mock('@/src/services/config/store', () => ({config: settings, configReady: Promise.resolve()}));
afterEach(() => {vi.unstubAllGlobals(); vi.unstubAllEnvs();});
beforeEach(() => {settings.on = true; settings.disabledExtensionDomains = [];});
describe('Hypothesis browser assembly', () => {
    it.each([[3, 'action'], [2, 'browser_action']])('registers the annotation shortcut for MV%d', async (version, context) => {
        const create = vi.fn();
        vi.stubGlobal('browser', {runtime: {getManifest: () => ({manifest_version: version})}, contextMenus: {create}});

        await createToolbarHypothesisMenu('zh-CN');

        expect(create).toHaveBeenCalledExactlyOnceWith({
            id: 'fluentread-toolbar-hypothesis',
            title: expect.stringContaining('Hypothesis'),
            contexts: [context],
            documentUrlPatterns: ['http://*/*', 'https://*/*', 'file:///*'],
        });
    });

    it.each([3, 2])('uses packaged static files and exact source ownership in MV%d', async version => {
        const script = vi.fn(async () => {}), legacy = vi.fn(async () => {});
        vi.stubGlobal('browser', {runtime: {id: 'owned'}, scripting: {executeScript: script}, tabs: {get: async () => ({url: 'https://paper.example/read'}), executeScript: legacy}});
        expect(createBrowserHypothesisHandler().type).toBe('installHypothesisClient');
        const handler = createBrowserHypothesisHandler(version as 2 | 3); const context = {sender: {id: 'owned', frameId: 0, url: 'https://paper.example/read', documentId: 'doc-1', tab: {id: 7}}};
        expect(await handler.handle({type: handler.type}, context)).toEqual({status: 'success'});
        if (version === 3) {expect(script).toHaveBeenLastCalledWith({target: {tabId: 7, documentIds: ['doc-1']}, files: ['hypothesis/build/scripts/annotator.bundle.js']});expect(legacy).not.toHaveBeenCalled();}
        else {expect(legacy).toHaveBeenLastCalledWith(7, {file: '/hypothesis/build/scripts/annotator.bundle.js', frameId: 0, runAt: 'document_idle'});expect(script).not.toHaveBeenCalled();}
        settings.on = false; expect(await handler.handle({type: handler.type}, context)).toEqual({status: 'disabled'});
        settings.on = true; settings.disabledExtensionDomains = ['paper.example']; expect(await handler.handle({type: handler.type}, context)).toEqual({status: 'disabled'});
        settings.disabledExtensionDomains = []; const noDocument = {sender: {...context.sender, documentId: undefined}}; await handler.handle({type: handler.type}, noDocument);
        if (version === 3) expect(script).toHaveBeenLastCalledWith({target: {tabId: 7, frameIds: [0]}, files: ['hypothesis/build/scripts/annotator.bundle.js']});
    });
    it('targets the clicked web tab or opens an online PDF with explicit annotation intent', async () => {
        const sendMessage = vi.fn().mockResolvedValue({status: 'success'}), create = vi.fn().mockResolvedValue({});
        vi.stubGlobal('browser', {runtime: {getURL: (path: string) => `chrome-extension://fixture${path}`}, tabs: {sendMessage, create}});
        const states = new TabTranslationStateStore();
        const web = {id: 7, url: 'https://paper.example/article'};
        expect(handleToolbarHypothesisClick('other', web, states)).toBe(false);
        expect(handleToolbarHypothesisClick('fluentread-toolbar-hypothesis', web, states)).toBe(true);
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledExactlyOnceWith(7, {type: 'toggleHypothesis'}, {frameId: 0}));
        expect(create).not.toHaveBeenCalled();

        handleToolbarHypothesisClick('fluentread-toolbar-hypothesis', {id: 8, url: 'https://paper.example/full.pdf'}, states);
        await vi.waitFor(() => expect(create).toHaveBeenCalledExactlyOnceWith({
            url: 'chrome-extension://fixture/document.html#pdf=https%3A%2F%2Fpaper.example%2Ffull.pdf&hypothesis=1',
        }));
        expect(sendMessage).toHaveBeenCalledOnce();
    });

    it('drops stale or unsupported clicks and keeps disabled-site feedback in the originating tab', async () => {
        const sendMessage = vi.fn().mockResolvedValue({status: 'success'});
        vi.stubGlobal('browser', {tabs: {sendMessage}});
        const states = new TabTranslationStateStore(), menu = 'fluentread-toolbar-hypothesis';
        const web = {id: 7, url: 'https://paper.example/article'};
        expect(handleToolbarHypothesisClick(menu, undefined, states)).toBe(true);
        handleToolbarHypothesisClick(menu, {id: 8, url: 'chrome-extension://fixture/document.html'}, states);
        handleToolbarHypothesisClick(menu, web, states);
        states.reset(web.id);
        await Promise.resolve();
        expect(sendMessage).not.toHaveBeenCalled();

        settings.disabledExtensionDomains = ['paper.example'];
        handleToolbarHypothesisClick(menu, web, states);
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledExactlyOnceWith(7, {type: 'contextMenuNotice', reason: 'disabled'}, {frameId: 0}));
        settings.on = false;
        handleToolbarHypothesisClick(menu, web, states);
        await Promise.resolve();
        expect(sendMessage).toHaveBeenCalledOnce();
    });

    it('reports a failed toggle in the tab that owns the click', async () => {
        const sendMessage = vi.fn().mockRejectedValueOnce(new Error('Content script unavailable')).mockResolvedValue(undefined);
        vi.stubGlobal('browser', {tabs: {sendMessage}});
        const states = new TabTranslationStateStore();
        const tab = {id: 7, url: 'https://paper.example/article'};

        expect(handleToolbarHypothesisClick('fluentread-toolbar-hypothesis', tab, states)).toBe(true);
        await vi.waitFor(() => expect(sendMessage.mock.calls).toEqual([
            [7, {type: 'toggleHypothesis'}, {frameId: 0}],
            [7, {type: 'contextMenuNotice', reason: 'unavailable'}, {frameId: 0}],
        ]));
    });
});
