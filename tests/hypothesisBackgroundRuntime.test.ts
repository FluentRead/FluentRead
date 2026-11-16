import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createBrowserHypothesisHandler, withHypothesisDocumentPassthrough} from '@/src/app/background/hypothesisRuntime';
const settings = vi.hoisted(() => ({on: true, disabledExtensionDomains: [] as string[]}));
vi.mock('@/src/services/config/store', () => ({config: settings, configReady: Promise.resolve()}));
afterEach(() => {vi.unstubAllGlobals(); vi.unstubAllEnvs();});
beforeEach(() => {settings.on = true; settings.disabledExtensionDomains = [];});
describe('Hypothesis browser assembly', () => {
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
    it('lets only the matching reader respond while preserving all ordinary router responses', async () => {
        const next = vi.fn(async () => ({status: 'success'})), handler = withHypothesisDocumentPassthrough(next);
        expect(handler({type: 'toggleDocumentHypothesis'}, {})).toBe(false); expect(next).not.toHaveBeenCalled();
        for (const request of [null, {}, {type: 'ordinary'}]) expect(await handler(request, 'sender')).toEqual({status: 'success'});
        expect(next).toHaveBeenCalledTimes(3);
    });
});
