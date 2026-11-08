/** 日语固定词典清单与真实锁定包保持一致，并通过同一数据层离线复用，不执行下载代码。 */
import {readFileSync} from 'node:fs';
import {asArrayBufferBytes} from '@/src/shared/function/arrayBufferBytes';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {sha256} from '@noble/hashes/sha256';
import {ensureJapaneseDictionary, readJapaneseDictionaryFile, JAPANESE_DICTIONARY_BYTES, JAPANESE_DICTIONARY_FILES, JAPANESE_DICTIONARY_VERSION} from '@/src/features/video-subtitle/reading/japaneseDictionary';

const packageRoot = dirname(createRequire(import.meta.url).resolve('@faanau/kuromoji/package.json'));

describe('pinned optional Japanese dictionary', () => {
    afterEach(() => vi.unstubAllGlobals());
    it('pins exactly the installed twelve data files, without including an executable resource', () => {
        expect(JAPANESE_DICTIONARY_VERSION).toBe('0.2.1');
        expect(JAPANESE_DICTIONARY_FILES).toHaveLength(12); expect(JAPANESE_DICTIONARY_BYTES).toBe(17_791_956);
        for (const file of JAPANESE_DICTIONARY_FILES) {
            const data = readFileSync(join(packageRoot, 'dict', file.name));
            expect(file.name).toMatch(/\.dat\.gz$/u); expect(data.byteLength).toBe(file.size);
            expect(Array.from(sha256(data), byte => byte.toString(16).padStart(2, '0')).join('')).toBe(file.sha256);
            expect(file.urls).toEqual([
                `https://cdn.jsdelivr.net/npm/@faanau/kuromoji@0.2.1/dict/${file.name}`,
                `https://unpkg.com/@faanau/kuromoji@0.2.1/dict/${file.name}`,
            ]);
        }
    });

    it('downloads all data on first use, accepts only known filenames, and works after network loss', async () => {
        const entries = new Map<string, Response>();
        const cache = {
            match: async (key: string) => entries.get(key)?.clone(),
            put: async (key: string, value: Response) => {entries.set(key, value.clone());},
            delete: async (key: string) => entries.delete(key),
        };
        vi.stubGlobal('caches', {open: vi.fn(async () => cache)});
        const fetcher = vi.fn(async (url: string) => new Response(asArrayBufferBytes(readFileSync(join(packageRoot, 'dict', url.slice(url.lastIndexOf('/') + 1))))));
        vi.stubGlobal('fetch', fetcher);
        await expect(readJapaneseDictionaryFile('https://arbitrary.test/script.js')).rejects.toThrow('Unknown');
        expect(fetcher).not.toHaveBeenCalled();
        const dictionary = await ensureJapaneseDictionary();
        expect(dictionary.size).toBe(12); expect(fetcher).toHaveBeenCalledTimes(12); expect(entries.size).toBe(12);
        fetcher.mockRejectedValue(new Error('offline'));
        const bytes = await readJapaneseDictionaryFile('https://extension.test/dict/unk_char.dat.gz');
        expect(new Uint8Array(bytes)).toEqual(new Uint8Array(readFileSync(join(packageRoot, 'dict/unk_char.dat.gz'))));
        expect(fetcher).toHaveBeenCalledTimes(12);
    });
});
