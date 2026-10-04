import JSZip from 'jszip';
import {describe, expect, it, vi} from 'vitest';
import {generateDocumentArchive} from '@/src/features/document-translation/services/archive';

describe('document archive stream lifecycle', () => {
    it.each([false, true])('round-trips archives with streamed entries = %s', async streamFiles => {
        const zip = new JSZip();
        zip.file('folder/large.txt', 'A translated paragraph.\n'.repeat(20_000));
        const progress = vi.fn();
        const bytes = await generateDocumentArchive(zip, {streamFiles, compression: 'DEFLATE', compressionOptions: {level: 3}}, {
            signal: new AbortController().signal, onProgress: progress,
        });
        expect(await (await JSZip.loadAsync(bytes)).file('folder/large.txt')!.async('string')).toBe('A translated paragraph.\n'.repeat(20_000));
        expect(progress).toHaveBeenLastCalledWith(100);
    });

    it('settles cancellation during compression without throwing out of an asynchronous callback', async () => {
        const zip = new JSZip();
        zip.file('long.txt', 'Translation '.repeat(100_000));
        const controller = new AbortController();
        await expect(generateDocumentArchive(zip, {compression: 'DEFLATE'}, {
            signal: controller.signal, onProgress: () => controller.abort(),
        })).rejects.toMatchObject({name: 'AbortError'});
        const bytes = await generateDocumentArchive(zip);
        expect((await JSZip.loadAsync(bytes)).file('long.txt')).not.toBeNull();
    });

    it('rejects an already canceled archive and a failing progress observer', async () => {
        const zip = new JSZip().file('a.txt', 'A');
        const controller = new AbortController();
        controller.abort();
        await expect(generateDocumentArchive(zip, {}, {signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
        await expect(generateDocumentArchive(zip, {}, {onProgress: () => {throw new Error('observer failed');}})).rejects.toThrow('observer failed');
    });

    it('rejects stream errors and invalid final allocation instead of hanging', async () => {
        const callbacks: Record<string, Function> = {};
        const stream = {on: (name: string, fn: Function) => {callbacks[name] = fn; return stream;}, pause: vi.fn(), resume: vi.fn()};
        const zip = {generateInternalStream: () => stream} as unknown as JSZip;
        const work = generateDocumentArchive(zip);
        callbacks.error(new Error('broken archive'));
        callbacks.error(new Error('late error'));
        callbacks.data(new Uint8Array([1]), {percent: 50});
        callbacks.end();
        await expect(work).rejects.toThrow('broken archive');
        const allocation = generateDocumentArchive(zip);
        callbacks.data({length: Infinity}, {percent: 50});
        callbacks.end();
        await expect(allocation).rejects.toBeInstanceOf(RangeError);
    });
});
