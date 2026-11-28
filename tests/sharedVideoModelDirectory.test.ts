import {afterEach, describe, expect, it, vi} from 'vitest';
import {
    chooseSharedVideoAiDirectory, createSharedVideoAiModelCache, disconnectSharedVideoAiDirectory,
    getSharedVideoAiDirectoryStatus, readSharedVideoAiModels, sharedModelFileUrl, supportsSharedVideoAiDirectory,
} from '@/src/features/video-subtitle/sharedModelDirectory';
import {getVideoAiModelFileSets} from '@/src/features/video-subtitle/modelFiles';
import {sharedDirectoryFixture} from './helpers/sharedVideoModelDirectory';
import {translateSharedVideoModelText} from '@/src/features/settings/model/sharedVideoModelText';

afterEach(() => {vi.unstubAllGlobals();});

const url = sharedModelFileUrl('tiny', 'config.json');
const data = () => new Response('valid model bytes', {headers: {'Content-Length': '17'}});

describe('user-authorized shared Whisper directory', () => {
    it.each(['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const)('keeps shared-directory copy local to the extension settings in %s', language => {
        expect(translateSharedVideoModelText('跨浏览器共享模型', language)).toBeTruthy();
        expect(translateSharedVideoModelText('existing unrelated label', language)).toBeUndefined();
        if (language === 'en-US') expect(translateSharedVideoModelText('跨浏览器共享模型', language)).toBe('Share models across browsers');
        if (language === 'zh-TW') expect(translateSharedVideoModelText('跨浏览器共享模型', language)).toBe('跨瀏覽器共享模型');
    });
    it.each(['open', 'request', 'transaction', 'abort'].flatMap(phase => [false, true].map(withError => [phase, withError] as const)))('surfaces IndexedDB %s failures (%s) and closes opened connections', async (phase, withError) => {
        const f = sharedDirectoryFixture();
        f.database.objectStoreNames.contains = () => true;
        f.faults.idb = {phase, error: withError ? new Error('storage disconnected') : undefined};
        await expect(chooseSharedVideoAiDirectory()).rejects.toThrow(withError ? 'storage disconnected' : /共享模型目录/);
        if (phase !== 'open') expect(f.database.close).toHaveBeenCalled();
    });
    it('keeps unsupported browsers and unconfigured instances on their own cache', async () => {
        vi.stubGlobal('indexedDB', undefined); vi.stubGlobal('window', undefined);
        expect(supportsSharedVideoAiDirectory()).toBe(false);
        await expect(createSharedVideoAiModelCache()).resolves.toBeUndefined();
        await expect(getSharedVideoAiDirectoryStatus()).resolves.toMatchObject({supported: false, configured: false});
        await expect(chooseSharedVideoAiDirectory()).rejects.toThrow('不支持');
        await expect(disconnectSharedVideoAiDirectory()).rejects.toThrow('不支持保存');
        await expect(readSharedVideoAiModels(undefined)).resolves.toEqual([]);
        const f = sharedDirectoryFixture();
        await expect(createSharedVideoAiModelCache()).resolves.toBeUndefined();
        await expect(getSharedVideoAiDirectoryStatus()).resolves.toEqual({supported: true, configured: false, read: 'unavailable', write: 'unavailable'});
        f.setStored({kind: 'file'});
        await expect(createSharedVideoAiModelCache()).resolves.toBeUndefined();
        expect(f.picker).not.toHaveBeenCalled();
    });
    it('stores the explicit picker grant and disconnects without removing user files', async () => {
        const f = sharedDirectoryFixture();
        await expect(chooseSharedVideoAiDirectory()).resolves.toEqual({supported: true, configured: true, read: 'granted', write: 'granted'});
        expect(f.picker).toHaveBeenCalledWith({mode: 'readwrite'});
        await expect(getSharedVideoAiDirectoryStatus()).resolves.toMatchObject({configured: true});
        const cache = (await createSharedVideoAiModelCache())!;
        await cache.put(url, data());
        const response = await cache.match(new Request(url));
        expect(await response!.text()).toBe('valid model bytes');
        await disconnectSharedVideoAiDirectory();
        expect(f.files.size).toBe(2); expect(f.removed).toEqual([]);
        await expect(createSharedVideoAiModelCache()).resolves.toBeUndefined();
        expect(f.database.close).toHaveBeenCalled();
    });
    it('never prompts for permissions from status checks or background cache access', async () => {
        const f = sharedDirectoryFixture(); f.setStored(f.handle); f.permissions('prompt', 'denied');
        await expect(getSharedVideoAiDirectoryStatus()).resolves.toMatchObject({configured: true, read: 'prompt', write: 'denied'});
        const cache = (await createSharedVideoAiModelCache())!;
        await expect(cache.match(url)).resolves.toBeUndefined();
        await expect(cache.put(url, data())).rejects.toThrow('需要重新授权');
        expect(f.picker).not.toHaveBeenCalled(); expect(f.files.size).toBe(0);
        f.handle.queryPermission = undefined;
        await expect(getSharedVideoAiDirectoryStatus()).resolves.toMatchObject({read: 'unavailable', write: 'unavailable'});
        f.handle.queryPermission = async () => {throw new Error('revoked');};
        await expect(getSharedVideoAiDirectoryStatus()).resolves.toMatchObject({read: 'unavailable'});
    });
    it.each([
        'invalid url', url.replace('modelscope.cn', 'example.test'), url.replace('onnx-community', 'untrusted-model'), url.replace('/master/', '/old/'),
        url.replace('/config.json', '/%XX'), url.replace('/master/', '/%XX/'), url.replace('/config.json', '/not-a-weight'),
        `${url}?revision=old`, `${url}#other`, url.replace('https://', 'https://user:secret@'),
    ])('rejects noncanonical cache key %s before touching files', async key => {
        const f = sharedDirectoryFixture(); f.setStored(f.handle);
        const cache = (await createSharedVideoAiModelCache())!;
        await expect(cache.match(key)).resolves.toBeUndefined();
        await expect(cache.put(key, data())).rejects.toThrow('不支持写入');
        expect(f.files.size).toBe(0);
    });
    it('streams a read to its hash boundary and invalidates same-length corrupt bytes', async () => {
        const f = sharedDirectoryFixture(); f.setStored(f.handle);
        const cache = (await createSharedVideoAiModelCache())!;
        const progress = vi.fn();
        await cache.putWithProgress!(new URL(url), data(), progress);
        expect(progress).toHaveBeenLastCalledWith(17, 17);
        const key = [...f.files.keys()].find(key => key.endsWith('/config.json'))!;
        f.files.set(key, new TextEncoder().encode('wrong model bytes'));
        await expect((await cache.match(url))!.text()).rejects.toThrow('校验失败');
        expect(f.removed).toEqual([`${key}.fluentread.json`]);
        await expect(cache.match(url)).resolves.toBeUndefined();
        await cache.put(url, data());
        expect(await (await cache.match(url))!.text()).toBe('valid model bytes');
        const cancel = await cache.match(url); await cancel!.body!.cancel('closed status view');
    });
    it('keeps a valid completion record when a status read cancels while the file stream is pending', async () => {
        const f = sharedDirectoryFixture(); f.setStored(f.handle);
        const cache = (await createSharedVideoAiModelCache())!; await cache.put(url, data());
        f.faults.pendingRead = true;
        const response = (await cache.match(url))!;
        await Promise.resolve(); await response.body!.cancel('status needs file metadata only');
        await Promise.resolve(); expect(f.removed).toEqual([]);
        f.faults.pendingRead = false;
        expect(await (await cache.match(url))!.text()).toBe('valid model bytes');
    });
    it.each(['tiny', 'base', 'small'] as const)('requires a complete %s precision set and keeps other models separate', async model => {
        const f = sharedDirectoryFixture(); f.setStored(f.handle);
        const cache = (await createSharedVideoAiModelCache())!;
        const sets = getVideoAiModelFileSets(model);
        const files = sets.at(-1)!;
        for (const file of files.slice(0, -1)) await cache.put(sharedModelFileUrl(model, file), data());
        await expect(readSharedVideoAiModels(cache)).resolves.toEqual([]);
        await cache.put(sharedModelFileUrl(model, files.at(-1)!), data());
        await expect(readSharedVideoAiModels(cache)).resolves.toEqual([model]);
    });
    it.each([
        {schema: 2}, {modelId: 'other'}, {revision: 'old'}, {file: 'wrong'}, {bytes: 0}, {bytes: 1.5},
        {bytes: 384 * 1024 * 1024 + 1}, {sha256: 12}, {sha256: 'bad'},
    ])('treats invalid metadata %j as a cache miss', async patch => {
        const f = sharedDirectoryFixture(); f.setStored(f.handle);
        const cache = (await createSharedVideoAiModelCache())!;
        await cache.put(url, data());
        const key = [...f.files.keys()].find(key => key.endsWith('.fluentread.json'))!;
        const metadata = JSON.parse(new TextDecoder().decode(f.files.get(key)));
        f.files.set(key, new TextEncoder().encode(JSON.stringify({...metadata, ...patch})));
        await expect(cache.match(url)).resolves.toBeUndefined();
    });
    it('handles absent, truncated and malformed shared files without claiming availability', async () => {
        const f = sharedDirectoryFixture(); f.setStored(f.handle);
        const cache = (await createSharedVideoAiModelCache())!;
        await expect(cache.match(url)).resolves.toBeUndefined();
        await cache.put(url, data());
        const key = [...f.files.keys()].find(key => key.endsWith('/config.json'))!;
        f.files.set(key, new Uint8Array(0));
        await expect(cache.match(url)).resolves.toBeUndefined();
        f.files.set(key, new Uint8Array(1));
        await expect(cache.match(url)).resolves.toBeUndefined();
        f.files.delete(key);
        await expect(cache.match(url)).resolves.toBeUndefined();
        f.files.set(`${key}.fluentread.json`, new TextEncoder().encode('{'));
        await expect(cache.match(url)).resolves.toBeUndefined();
        f.failFiles(new Error('disk disconnected'));
        await expect(cache.match(url)).rejects.toThrow('disk disconnected');
    });
    it.each([
        () => new Response('html', {headers: {'Content-Type': 'text/html'}}),
        () => new Response('failed', {status: 503}), () => new Response(null), () => new Response(''),
        () => new Response('short', {headers: {'Content-Length': '6'}}),
        () => new Response('long', {headers: {'Content-Length': '1'}}),
        () => new Response('large', {headers: {'Content-Length': String(256 * 1024 * 1024 + 1)}}),
        () => new Response(new ReadableStream({start(controller) {controller.error(new Error('source disconnected'));}})),
    ])('does not commit incomplete or invalid downloads (%#)', async response => {
        const f = sharedDirectoryFixture(); f.setStored(f.handle);
        const cache = (await createSharedVideoAiModelCache())!;
        await expect(cache.put(url, response())).rejects.toThrow();
        expect([...f.files.keys()].some(key => key.endsWith('.fluentread.json'))).toBe(false);
    });
    it('checks decoded bytes without trusting encoded Content-Length', async () => {
        const f = sharedDirectoryFixture(); f.setStored(f.handle);
        const cache = (await createSharedVideoAiModelCache())!;
        await cache.put(url, new Response('decoded', {headers: {'Content-Length': '2', 'Content-Encoding': 'gzip'}}));
        expect(await (await cache.match(url))!.text()).toBe('decoded');
    });
    it.each(['metadataWrite', 'bodyWrite'] as const)('aborts %s failures without publishing a completion record', async fault => {
        const f = sharedDirectoryFixture(); f.setStored(f.handle); f.faults[fault] = true;
        const cache = (await createSharedVideoAiModelCache())!;
        await expect(cache.put(url, data())).rejects.toThrow('write disconnected');
        expect([...f.files.keys()].some(key => key.endsWith('.fluentread.json'))).toBe(false);
    });
    it('propagates a disconnected file stream and keeps read-only corruption from deleting files', async () => {
        const f = sharedDirectoryFixture(); f.setStored(f.handle);
        const cache = (await createSharedVideoAiModelCache())!;
        await cache.put(url, data());
        f.faults.read = true;
        await expect((await cache.match(url))!.text()).rejects.toThrow('read disconnected');
        f.faults.read = false;
        const key = [...f.files.keys()].find(key => key.endsWith('/config.json'))!;
        f.files.set(key, new TextEncoder().encode('wrong model bytes'));
        f.permissions('granted', 'denied');
        const readOnly = (await createSharedVideoAiModelCache())!;
        await expect((await readOnly.match(url))!.text()).rejects.toThrow('校验失败');
        expect(f.removed).toEqual([]);
        f.permissions('granted', 'granted'); f.faults.remove = true;
        const failedRemoval = (await createSharedVideoAiModelCache())!;
        await expect((await failedRemoval.match(url))!.text()).rejects.toThrow('校验失败');
        expect(f.files.has(key)).toBe(true);
    });
    it('rejects an oversized streaming body before allocation or a completion record', async () => {
        const f = sharedDirectoryFixture(); f.setStored(f.handle);
        const cache = (await createSharedVideoAiModelCache())!;
        const response = new Response(new ReadableStream({start(controller) {controller.enqueue({byteLength: 256 * 1024 * 1024 + 1}); controller.close();}}));
        await expect(cache.put(url, response)).rejects.toThrow('超过大小限制');
        expect(f.files.size).toBe(0);
    });
});
