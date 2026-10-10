import JSZip from 'jszip';
import {describe, expect, it, vi} from 'vitest';
import {generateDocumentArchive, preserveStoredDocumentEntries} from '@/src/features/document-translation/services/archive';

function localEntries(bytes: Uint8Array): Map<string, {method: number; data: Uint8Array}> {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), entries = new Map();
    for (let offset = 0; offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50;) {
        const size = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true), extraLength = view.getUint16(offset + 28, true);
        const start = offset + 30 + nameLength + extraLength;
        entries.set(new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength)), {method: view.getUint16(offset + 8, true), data: bytes.subarray(start, start + size)});
        offset = start + size;
    }
    return entries;
}

describe('document archive stream lifecycle', () => {
    it('retains original stored media and compressed resources, while changed XML remains deflated', async () => {
        const zip = new JSZip();
        zip.file('media/图像.png', Uint8Array.from({length: 8_000}, (_, index) => index % 251), {compression: 'STORE'});
        zip.file('styles.xml', '<style>Original styles</style>'.repeat(30), {compression: 'DEFLATE'});
        zip.file('document.xml', '<p>Source</p>', {compression: 'STORE'});
        const source = await generateDocumentArchive(zip);
        const loaded = await JSZip.loadAsync(source);
        loaded.file('document.xml', '<p>中文译文</p>');
        preserveStoredDocumentEntries(loaded, source, new Set(['document.xml']));
        const output = await generateDocumentArchive(loaded, {compression: 'DEFLATE'});
        const before = localEntries(source), after = localEntries(output);
        expect(after.get('media/图像.png')).toEqual(before.get('media/图像.png'));
        expect(after.get('styles.xml')).toEqual(before.get('styles.xml'));
        expect(after.get('document.xml')?.method).toBe(8);
        expect(await (await JSZip.loadAsync(output)).file('document.xml')!.async('string')).toBe('<p>中文译文</p>');
    });

    it('ignores unsupported or truncated compression metadata without applying partial hints', async () => {
        const source = await generateDocumentArchive(new JSZip().file('stored.bin', 'Source', {compression: 'STORE'}));
        const end = source.length - 22;
        const variants = [new Uint8Array(), source.subarray(0, -1)];
        for (const [position, value] of [[end + 4, 1], [end + 6, 1], [end + 8, 2], [end + 10, 0xffff], [end + 16, 0xffffffff], [end + 12, 0xffffffff], [end + 12, source.length]] as const) {
            const bytes = source.slice(), view = new DataView(bytes.buffer);
            if (position < end + 12) view.setUint16(position, value, true);
            else view.setUint32(position, value, true);
            variants.push(bytes);
        }
        const invalidHeader = source.slice(), view = new DataView(invalidHeader.buffer);
        view.setUint32(view.getUint32(end + 16, true), 0, true);
        variants.push(invalidHeader);
        const central = view.getUint32(end + 16, true);
        for (const mutate of [
            (data: DataView) => data.setUint32(end + 12, 45, true),
            (data: DataView) => data.setUint16(central + 28, 0xffff, true),
            (data: DataView) => {data.setUint16(central + 28, 5, true); data.setUint16(central + 30, 4, true); data.setUint16(central + 51, 0x7075, true); data.setUint16(central + 53, 0xffff, true);},
            (data: DataView) => {data.setUint16(central + 28, 5, true); data.setUint16(central + 30, 4, true); data.setUint16(central + 51, 0x7075, true); data.setUint16(central + 53, 0, true);},
            (data: DataView) => data.setUint8(central + 46, 0xff),
            (data: DataView) => {data.setUint16(central + 8, 0x800, true); data.setUint8(central + 46, 0xff);},
        ]) {const bytes = source.slice(); mutate(new DataView(bytes.buffer)); variants.push(bytes);}
        for (const bytes of variants) {
            const loaded = await JSZip.loadAsync(source);
            expect(() => preserveStoredDocumentEntries(loaded, bytes, new Set())).not.toThrow();
            expect(loaded.file('stored.bin')!.options.compression).toBeNull();
        }
        const changed = await JSZip.loadAsync(source);
        preserveStoredDocumentEntries(changed, source, new Set(['stored.bin']));
        expect(changed.file('stored.bin')!.options.compression).toBeNull();
        changed.remove('stored.bin');
        expect(() => preserveStoredDocumentEntries(changed, source, new Set())).not.toThrow();
        const empty = new JSZip();
        expect(() => preserveStoredDocumentEntries(empty, new Uint8Array(), new Set())).not.toThrow();
        preserveStoredDocumentEntries(empty, await generateDocumentArchive(empty), new Set());
    });

    it('follows the final duplicate entry and avoids hints from paths sanitized onto another name', async () => {
        const source = await generateDocumentArchive(new JSZip()
            .file('one.bin', 'First stored bytes', {compression: 'STORE'})
            .file('two.bin', 'Final compressed bytes'.repeat(30), {compression: 'DEFLATE'}));
        // ZIP legitimately allows duplicate central-directory names; JSZip chooses the final entry.
        const duplicate = source.slice();
        for (let offset = 0; offset < duplicate.length - 7; offset += 1) {
            const name = new TextDecoder().decode(duplicate.subarray(offset, offset + 7));
            if (name === 'one.bin' || name === 'two.bin') duplicate.set(new TextEncoder().encode('dup.bin'), offset);
        }
        const loaded = await JSZip.loadAsync(duplicate);
        preserveStoredDocumentEntries(loaded, duplicate, new Set());
        const output = await generateDocumentArchive(loaded, {compression: 'DEFLATE'});
        expect(localEntries(output).get('dup.bin')).toEqual(localEntries(duplicate).get('dup.bin'));
        expect(await (await JSZip.loadAsync(output)).file('dup.bin')!.async('string')).toBe('Final compressed bytes'.repeat(30));
        const normalized = await generateDocumentArchive(new JSZip()
            .file('media.bin', 'Stored', {compression: 'STORE'})
            .file('folder/../media.bin', 'Deflated final', {compression: 'DEFLATE'}));
        const paths = await JSZip.loadAsync(normalized);
        preserveStoredDocumentEntries(paths, normalized, new Set());
        expect(paths.file('media.bin')!.unsafeOriginalName).toBe('folder/../media.bin');
        expect(paths.file('media.bin')!.options.compression).toBeNull();
    });
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

    it('handles cancellation while the encoder is created before subscribing to its abort event', async () => {
        const controller = new AbortController(), reason = new Error('Canceled during initialization');
        const stream = {on: () => stream, pause: vi.fn(), resume: vi.fn()};
        const zip = {generateInternalStream: () => {controller.abort(reason); return stream;}} as unknown as JSZip;
        await expect(generateDocumentArchive(zip, {}, {signal: controller.signal})).rejects.toBe(reason);
        expect(stream.pause).toHaveBeenCalledOnce();
        expect(stream.resume).not.toHaveBeenCalled();
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
