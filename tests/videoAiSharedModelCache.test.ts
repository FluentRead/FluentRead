import {afterEach, describe, expect, it, vi} from 'vitest';
import {createVideoAiModelCache, cacheVideoAiQ4ModelFiles, getVideoAiModelFileUrl, moveVideoAiModelToSharedDirectory, readCachedVideoAiModelState, removeVideoAiModelFiles} from '@/src/features/video-subtitle/offscreen/modelCache';
import * as sharedDirectory from '@/src/features/video-subtitle/sharedModelDirectory';
import {createSharedVideoAiModelCache} from '@/src/features/video-subtitle/sharedModelDirectory';
import {VIDEO_AI_Q4_MODEL_FILES} from '@/src/features/video-subtitle/modelFiles';
import {sharedDirectoryFixture} from './helpers/sharedVideoModelDirectory';

afterEach(() => {vi.unstubAllGlobals();});

function localFixture(complete = true) {
    const files = new Map(VIDEO_AI_Q4_MODEL_FILES.slice(0, complete ? undefined : -1).map(file => [getVideoAiModelFileUrl('tiny', file), `original:${file}`]));
    const cache = {
        keys: vi.fn(async () => [...files.keys()].map(url => new Request(url))),
        match: vi.fn(async (url: string) => files.has(url) ? new Response(files.get(url)) : undefined),
        put: vi.fn(async (url: string, response: Response) => {files.set(url, await response.text());}),
        delete: vi.fn(async (request: Request) => files.delete(request.url)),
    };
    vi.stubGlobal('caches', {has: async () => true, open: async () => cache});
    return {files, cache};
}

describe('shared model and browser-cache integration', () => {
    it('does not replace or delete another complete shared copy during migration', async () => {
        const f = sharedDirectoryFixture(); f.setStored(f.handle); const local = localFixture();
        await cacheVideoAiQ4ModelFiles('tiny');
        const before = new Map(f.files);
        await moveVideoAiModelToSharedDirectory('tiny');
        expect(f.files).toEqual(before); expect(local.files.size).toBe(0);
    });
    it.each(['during verification', 'after manifest survey'])('preserves local files if shared metadata disappears %s', async phase => {
        const f = sharedDirectoryFixture(); f.setStored(f.handle); const local = localFixture();
        let removed = false;
        f.faults.onRead = key => {
            if (removed) return;
            if (phase === 'during verification' && key.endsWith('/config.json.fluentread.json')) {
                const body = key.replace('.fluentread.json', ''); f.files.delete(body); removed = true;
            }
            if (phase === 'after manifest survey' && key.endsWith('/decoder_model_merged_q4.onnx.fluentread.json')) {
                const first = [...f.files.keys()].find(item => item.endsWith('/config.json.fluentread.json'))!;
                f.files.delete(first); removed = true;
            }
        };
        await expect(moveVideoAiModelToSharedDirectory('tiny')).rejects.toThrow('校验失败');
        expect(local.cache.delete).not.toHaveBeenCalled();
    });
    it('preserves remaining local files if CacheStorage evicts a file after the completeness survey', async () => {
        const f = sharedDirectoryFixture(); f.setStored(f.handle); const local = localFixture();
        let requests = 0;
        local.cache.match.mockImplementation(async key => {
            if (key.endsWith('/config.json') && ++requests > 1) return undefined;
            return new Response(local.files.get(key));
        });
        await expect(moveVideoAiModelToSharedDirectory('tiny')).rejects.toThrow('不完整');
        expect(local.cache.delete).not.toHaveBeenCalled();
        await expect(removeVideoAiModelFiles('unknown')).rejects.toThrow('无效');
    });
    it('preserves quota errors and rejects bodyless shared responses before reusing them', async () => {
        const f = sharedDirectoryFixture(); f.setStored(f.handle); localFixture();
        f.failFiles(new DOMException('quota full', 'QuotaExceededError'));
        await expect(cacheVideoAiQ4ModelFiles('tiny')).rejects.toMatchObject({name: 'QuotaExceededError'});
        f.failFiles();
        const cache = (await createSharedVideoAiModelCache())!;
        cache.match = async () => new Response(null);
        const mock = vi.spyOn(sharedDirectory, 'createSharedVideoAiModelCache').mockResolvedValueOnce(cache);
        try {await cacheVideoAiQ4ModelFiles('tiny');} finally {mock.mockRestore();}
        expect(f.files.size).toBe(VIDEO_AI_Q4_MODEL_FILES.length * 2);
    });
    it('prefers shared files, reads local files as fallback, and writes new bytes only to the chosen directory', async () => {
        const f = sharedDirectoryFixture(); f.setStored(f.handle);
        const local = localFixture();
        const result = await createVideoAiModelCache();
        const url = getVideoAiModelFileUrl('tiny', 'config.json');
        expect(await (await result.cache.match(url))!.text()).toBe('original:config.json');
        await result.cache.put(url, new Response('shared config'));
        expect(await (await result.cache.match(url))!.text()).toBe('shared config');
        await result.cache.putWithProgress!(url, new Response('new shared config'), vi.fn());
        expect(local.cache.put).not.toHaveBeenCalled();
        expect(await (await result.cache.match(url))!.text()).toBe('new shared config');
    });
    it('makes another browser discover a complete shared model without a local download receipt', async () => {
        const f = sharedDirectoryFixture(); f.setStored(f.handle); localFixture();
        await expect(readCachedVideoAiModelState(['tiny'])).resolves.toMatchObject({models: ['tiny'], localModels: ['tiny'], sharedModels: []});
        await cacheVideoAiQ4ModelFiles('tiny');
        const other = localFixture(false); other.files.clear();
        await expect(readCachedVideoAiModelState([])).resolves.toEqual({models: ['tiny'], localModels: [], sharedModels: ['tiny']});
    });
    it('validates the copied bytes before deleting local originals and leaves shared files on local removal', async () => {
        const f = sharedDirectoryFixture(); f.setStored(f.handle);
        const local = localFixture();
        local.files.set('https://modelscope.cn/other-model', 'other model');
        await moveVideoAiModelToSharedDirectory('tiny', vi.fn());
        expect([...local.files.keys()]).toEqual(['https://modelscope.cn/other-model']);
        expect(f.files.size).toBe(VIDEO_AI_Q4_MODEL_FILES.length * 2);
        await expect(readCachedVideoAiModelState([])).resolves.toMatchObject({models: ['tiny'], sharedModels: ['tiny']});
    });
    it('replaces same-size corrupt shared files from the local copy before migration can delete it', async () => {
        const f = sharedDirectoryFixture(); f.setStored(f.handle);
        const local = localFixture();
        const shared = (await createSharedVideoAiModelCache())!;
        const url = getVideoAiModelFileUrl('tiny', 'config.json');
        await shared.put(url, new Response('original:config.json'));
        const key = [...f.files.keys()].find(key => key.endsWith('/config.json'))!;
        f.files.set(key, new TextEncoder().encode('corrupt!:config.json'));
        await moveVideoAiModelToSharedDirectory('tiny');
        expect(await (await shared.match(url))!.text()).toBe('original:config.json');
        expect(local.files.size).toBe(0);
        expect(f.removed).toContain(`${key}.fluentread.json`);
    });
    it('never deletes local files if a directory write or grant fails', async () => {
        const f = sharedDirectoryFixture(); f.setStored(f.handle);
        const local = localFixture();
        f.failFiles(new Error('disk full'));
        await expect(moveVideoAiModelToSharedDirectory('tiny')).rejects.toThrow('disk full');
        expect(local.cache.delete).not.toHaveBeenCalled(); expect(local.files.size).toBe(VIDEO_AI_Q4_MODEL_FILES.length);
        f.failFiles(); f.permissions('granted', 'prompt');
        await expect(cacheVideoAiQ4ModelFiles('tiny')).rejects.toThrow('需要重新授权');
        expect(local.cache.delete).not.toHaveBeenCalled();
    });
    it('keeps the original intact when migration is unconfigured, unsupported or incomplete', async () => {
        const f = sharedDirectoryFixture(); const local = localFixture(false);
        await expect(moveVideoAiModelToSharedDirectory('tiny')).rejects.toThrow('先在');
        f.setStored(f.handle);
        await expect(moveVideoAiModelToSharedDirectory('tiny')).rejects.toThrow('不完整');
        expect(local.cache.delete).not.toHaveBeenCalled();
        vi.stubGlobal('caches', undefined);
        await expect(moveVideoAiModelToSharedDirectory('tiny')).rejects.toThrow('不支持');
    });
    it('downloads only shared files missing from both caches and repairs corruption before reusing them', async () => {
        const f = sharedDirectoryFixture(); f.setStored(f.handle);
        const local = localFixture(); local.files.clear();
        const fetcher = vi.fn(async () => new Response('network model'));
        vi.stubGlobal('fetch', fetcher);
        await cacheVideoAiQ4ModelFiles('tiny');
        expect(fetcher).toHaveBeenCalledTimes(VIDEO_AI_Q4_MODEL_FILES.length);
        fetcher.mockClear();
        await cacheVideoAiQ4ModelFiles('tiny'); expect(fetcher).not.toHaveBeenCalled();
        const key = [...f.files.keys()].find(key => key.endsWith('/config.json'))!;
        f.files.set(key, new TextEncoder().encode('corrupt model'));
        await cacheVideoAiQ4ModelFiles('tiny');
        expect(fetcher).toHaveBeenCalledOnce(); expect(local.cache.put).not.toHaveBeenCalled();
    });
});
