import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
const mocks = vi.hoisted(() => ({config: {readingAppearanceSites: {} as Record<string, 'system' | 'original'> | undefined},
    patch: vi.fn(), controller: vi.fn(), setEnabled: vi.fn(), dispose: vi.fn(), send: vi.fn(),
    setReadingSystem: vi.fn()}));
vi.mock('@/src/services/config/store', () => ({config: mocks.config, requestConfigPatch: mocks.patch}));
vi.mock('@/src/features/reading-appearance/content', () => ({createReadingAppearanceController: mocks.controller}));
import {createContentReadingAppearance} from '@/src/app/content/readingAppearance';
beforeEach(() => {
    vi.clearAllMocks(); mocks.config.readingAppearanceSites = {};
    mocks.controller.mockReturnValue({setEnabled: mocks.setEnabled, dispose: mocks.dispose});
});
afterEach(() => vi.unstubAllGlobals());
describe('reading appearance content composition', () => {
    it('starts on HTTP pages without the secure-context randomUUID API', async () => {
        vi.stubGlobal('crypto', {getRandomValues: (values: Uint32Array) => values.fill(7)});
        const document = {location: {href: 'http://example.com'}} as Document;
        const runtime = createContentReadingAppearance(document, () => true, undefined, {setReadingSystem: mocks.setReadingSystem});
        expect(mocks.controller).toHaveBeenCalledTimes(1);
        expect(mocks.controller).toHaveBeenCalledWith(document);
        runtime.activate();
        expect(await runtime.handle({type: 'getReadingAppearanceState'})).toMatchObject({documentToken: '00000007000000070000000700000007'});
        runtime.dispose();
    });
    it('uses empty site preferences until config is ready and disposes the real runtime', async () => {
        mocks.config.readingAppearanceSites = undefined;
        vi.stubGlobal('crypto', {getRandomValues: (values: Uint32Array) => values.fill(9)});
        const document = {location: {href: 'https://example.com/unready'}} as Document;
        const runtime = createContentReadingAppearance(document, () => true, undefined, {setReadingSystem: mocks.setReadingSystem});
        runtime.activate();
        expect(await runtime.handle({type: 'getReadingAppearanceState'})).toMatchObject({
            status: 'success', font: 'original', remembered: false, domain: 'example.com',
        });
        expect(mocks.setEnabled).toHaveBeenLastCalledWith(false);
        expect(mocks.config.readingAppearanceSites).toBeUndefined();
        expect(mocks.patch).not.toHaveBeenCalled();
        runtime.dispose();
        expect(mocks.dispose).toHaveBeenCalledTimes(1);
        expect(mocks.setReadingSystem).toHaveBeenLastCalledWith(false);
        expect(await runtime.handle({type: 'getReadingAppearanceState'})).toEqual({status: 'disabled'});
    });
    it('uses existing config patch transport and page document', async () => {
        vi.stubGlobal('browser', {runtime: {sendMessage: mocks.send}});
        mocks.patch.mockImplementation(async (patch, send) => {await send(patch); mocks.config.readingAppearanceSites = patch.readingAppearanceSites;});
        const document = {location: {href: 'https://example.com/a'}} as Document;
        const runtime = createContentReadingAppearance(document, () => true, undefined, {setReadingSystem: mocks.setReadingSystem});
        runtime.activate();
        const state = await runtime.handle({type: 'getReadingAppearanceState'});
        await runtime.handle({type: 'setReadingAppearance', font: 'system', remember: true, documentToken: (state as {documentToken: string}).documentToken});
        expect(mocks.send).toHaveBeenCalledWith({readingAppearanceSites: {'example.com': 'system'}});
        expect(mocks.setEnabled).toHaveBeenLastCalledWith(true);
        expect(mocks.setReadingSystem).toHaveBeenLastCalledWith(true);
        runtime.dispose();
        vi.unstubAllGlobals();
    });
});
