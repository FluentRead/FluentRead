import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {deflateRawSync} from 'node:zlib';
import {runInNewContext} from 'node:vm';
import JSZip from 'jszip';
import {compactExtensionZip, verifyExtensionZipPreservation} from '@/scripts/wasm/compact-extension-zip';

interface WorkerDouble {
    emit(name: string, value: unknown): void;
    listenerCount(name: string): number;
    terminate: ReturnType<typeof vi.fn>;
}
const control = vi.hoisted(() => ({
    instances: [] as WorkerDouble[],
    start: undefined as ((worker: WorkerDouble, data: Buffer) => void) | undefined,
    constructError: undefined as Error | undefined,
    terminateError: undefined as Error | undefined,
}));
vi.mock('node:fs/promises', async importOriginal => ({...await importOriginal<typeof import('node:fs/promises')>()}));
vi.mock('node:worker_threads', async () => {
    const {EventEmitter} = await import('node:events');
    return {Worker: class extends EventEmitter {
        terminate = vi.fn(async () => {if (control.terminateError) throw control.terminateError; return 0;});
        constructor(_file: string, options: {workerData: Buffer}) {
            super();
            if (control.constructError) throw control.constructError;
            control.instances.push(this);
            queueMicrotask(() => control.start?.(this, options.workerData));
        }
    }};
});

const names = ['fluent-read-ai/ort-wasm-simd-threaded.asyncify.wasm', 'fluent-read-ai/wllama.wasm',
    'fluent-read-ocr/core/tesseract-core-simd-lstm.wasm'];
const root = process.cwd(), date = new Date('2001-02-03T04:05:06Z');
const source = (index: number) => Buffer.from((`WASM fixture ${index}: reusable lossless byte sequence.\0`).repeat(2000));
let directory: string, zipPath: string, cache: string;
beforeEach(async () => {
    directory = await fs.mkdtemp(resolve(tmpdir(), 'fluentread-zip-test-'));
    zipPath = resolve(directory, 'extension.zip'); cache = resolve(directory, 'cache');
    control.instances.length = 0; control.constructError = undefined; control.terminateError = undefined;
    control.start = (worker, data) => worker.emit('message', deflateRawSync(data, {level: 9}));
});
afterEach(async () => {vi.restoreAllMocks(); await fs.rm(directory, {recursive: true, force: true});});

async function fixture(options: {store?: boolean; first?: Buffer; extra?: boolean; fileComment?: string; zipComment?: string; level?: number; streaming?: boolean} = {}) {
    const zip = new JSZip();
    names.forEach((name, index) => zip.file(name, index === 0 && options.first ? options.first : source(index), {
        createFolders: false, date, comment: options.fileComment ?? 'Preserve this entry comment',
        unixPermissions: 0o100640, compression: options.store ? 'STORE' : 'DEFLATE',
    }));
    for (const name of ['a.txt', 'b.txt', ...(options.extra ? ['extra.txt'] : [])]) {
        zip.file(name, `License and unchanged content: ${name}`.repeat(100), {date, comment: 'metadata', createFolders: false, compression: 'DEFLATE'});
    }
    const bytes = await zip.generateAsync({type: 'nodebuffer', platform: 'UNIX', compression: 'DEFLATE',
        compressionOptions: {level: options.level ?? 1}, comment: options.zipComment ?? 'Preserve the archive comment', streamFiles: options.streaming});
    await fs.writeFile(zipPath, bytes, {mode: 0o640});
    return bytes;
}
function positions(bytes: Buffer) {
    const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const entries = [];
    for (let offset = bytes.readUInt32LE(end + 16); offset < end;) {
        const nameLength = bytes.readUInt16LE(offset + 28), local = bytes.readUInt32LE(offset + 42);
        const next = offset + 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
        entries.push({central: offset, local, next, name: bytes.subarray(offset + 46, offset + 46 + nameLength).toString(),
            data: local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)});
        offset = next;
    }
    return {end, entries, first: entries[0]!};
}
async function compact(options: {workerTimeoutMs?: number} = {}) {
    return compactExtensionZip(zipPath, root, {cacheDirectory: cache, ...options});
}
function released() {
    for (const worker of control.instances) {
        expect(worker.terminate).toHaveBeenCalledOnce();
        for (const event of ['message', 'error', 'exit']) expect(worker.listenerCount(event)).toBe(0);
    }
}

describe('扩展 ZIP 无损 WASM 压缩', () => {
    it('默认选项将带版本和参数的缓存留在隔离项目的 .wxt 中', async () => {
        await fixture(); const packageDirectory = resolve(directory, 'node_modules/@gfx/zopfli');
        await fs.mkdir(packageDirectory, {recursive: true}); await fs.writeFile(resolve(packageDirectory, 'package.json'), JSON.stringify({version: '1.0.15'}));
        await expect(compactExtensionZip(zipPath, directory)).resolves.toMatchObject({savedBytes: expect.any(Number)});
        expect(await fs.readdir(resolve(directory, '.wxt/zip-wasm-deflate/sha256-zopfli-1.0.15-deflate-iterations-1'))).toHaveLength(3);
        released();
    });
    it('仅重压固定 WASM，所有文件、元数据和非目标本地记录不变，并复用校验缓存', async () => {
        const original = await fixture();
        const result = await compact(), output = await fs.readFile(zipPath);
        expect(result.savedBytes).toBeGreaterThan(0); expect(output.length).toBe(result.afterBytes);
        expect(result.entries).toHaveLength(3); expect(result.entries.every(entry => !entry.cacheHit)).toBe(true);
        expect(control.instances).toHaveLength(3); released();
        const before = await JSZip.loadAsync(original, {checkCRC32: true}), after = await JSZip.loadAsync(output, {checkCRC32: true});
        expect(Object.keys(after.files)).toEqual(Object.keys(before.files));
        for (const name of Object.keys(before.files)) {
            const a = before.files[name]!, b = after.files[name]!;
            expect([b.name, b.dir, b.date, b.comment, b.unixPermissions, b.dosPermissions]).toEqual(
                [a.name, a.dir, a.date, a.comment, a.unixPermissions, a.dosPermissions]);
            expect(await b.async('nodebuffer')).toEqual(await a.async('nodebuffer'));
            if (!names.includes(name)) {
                const old = positions(original).entries.find(entry => entry.name === name)!;
                const next = positions(output).entries.find(entry => entry.name === name)!;
                const oldSize = original.readUInt32LE(old.central + 20), nextSize = output.readUInt32LE(next.central + 20);
                expect(output.subarray(next.local, next.data + nextSize)).toEqual(original.subarray(old.local, old.data + oldSize));
            }
        }
        expect((await fs.stat(zipPath)).mode & 0o777).toBe(0o640);
        await fs.writeFile(zipPath, original);
        const cached = await compact();
        expect(cached.entries.every(entry => entry.cacheHit)).toBe(true); expect(control.instances).toHaveLength(3);
        expect(await fs.readFile(zipPath)).toEqual(output);
    });
    it('压缩结果更大时保留原始 ZIP 字节，不因为重打包而变大', async () => {
        const original = await fixture();
        control.start = (worker, data) => worker.emit('message', deflateRawSync(data, {level: 0}));
        expect((await compact()).savedBytes).toBe(0);
        expect(await fs.readFile(zipPath)).toEqual(original); released();
    });
    it('只有一个条目获益时保留另外两个 WASM 的原压缩数据', async () => {
        const original = await fixture(); let count = 0;
        control.start = (worker, data) => worker.emit('message', deflateRawSync(data, {level: count++ === 0 ? 9 : 0}));
        const result = await compact(); expect(result.entries.filter(entry => entry.afterBytes < entry.beforeBytes)).toHaveLength(1);
        const output = await fs.readFile(zipPath);
        for (const name of names.slice(1)) {
            const a = positions(original).entries.find(entry => entry.name === name)!, b = positions(output).entries.find(entry => entry.name === name)!;
            expect(output.subarray(b.data, b.data + output.readUInt32LE(b.central + 20))).toEqual(
                original.subarray(a.data, a.data + original.readUInt32LE(a.central + 20)));
        }
    });
    it.each(['short', 'checksum', 'different-source'] as const)('缓存损坏明确失败并保留原包（%s）', async mode => {
        const original = await fixture(), first = await compact(); await fs.writeFile(zipPath, original);
        const file = resolve(cache, `${first.entries[0]!.sha256}.deflate-cache`);
        let damaged: Buffer = Buffer.from('broken');
        if (mode === 'checksum') {damaged = await fs.readFile(file); damaged[32] = damaged[32]! ^ 1;}
        if (mode === 'different-source') {const compressed = deflateRawSync(Buffer.from('different bytes')); damaged = Buffer.concat([createHash('sha256').update(compressed).digest(), compressed]);}
        await fs.writeFile(file, damaged);
        await expect(compact()).rejects.toThrow(mode === 'different-source' ? '解压字节' : '缓存校验');
        expect(await fs.readFile(zipPath)).toEqual(original); expect(control.instances).toHaveLength(3);
    });
    it.each(['invalid-stream', 'different-source'] as const)('worker 的错误压缩结果不能进入缓存或 ZIP（%s）', async mode => {
        const original = await fixture(); control.start = worker => worker.emit('message', mode === 'invalid-stream' ? Buffer.from('invalid') : deflateRawSync(Buffer.from('different')));
        await expect(compact()).rejects.toThrow(); expect(await fs.readFile(zipPath)).toEqual(original); released();
        await expect(fs.readdir(cache)).rejects.toMatchObject({code: 'ENOENT'});
    });
    it.each(['error', 'undefined', 'exit', 'invalid', 'timeout', 'construct', 'terminate-success', 'terminate-failure'] as const)(
        'worker 失败完整释放并保留原包（%s）', async mode => {
            const original = await fixture(), failure = Error('worker failure');
            if (mode === 'construct') control.constructError = failure;
            if (mode.startsWith('terminate')) control.terminateError = failure;
            control.start = (worker, data) => {
                if (mode === 'error' || mode === 'terminate-failure') worker.emit('error', failure);
                if (mode === 'undefined') worker.emit('error', undefined);
                if (mode === 'exit') worker.emit('exit', 0);
                if (mode === 'invalid') worker.emit('message', {bytes: 'invalid'});
                if (mode === 'terminate-success') worker.emit('message', deflateRawSync(data));
            };
            const result = compact({workerTimeoutMs: 5});
            if (mode === 'undefined') await expect(result).rejects.toBeUndefined();
            else if (mode.startsWith('terminate')) await expect(result).rejects.toBeInstanceOf(AggregateError);
            else if (mode === 'error' || mode === 'construct') await expect(result).rejects.toBe(failure);
            else await expect(result).rejects.toThrow();
            expect(await fs.readFile(zipPath)).toEqual(original); released();
        });
    it('worker 完成后到达的重复消息、error、exit 不改变已选结果或留下监听', async () => {
        await fixture(); control.start = (worker, data) => {
            worker.emit('message', deflateRawSync(data)); worker.emit('error', Error('late')); worker.emit('exit', 1); worker.emit('message', null);
        };
        await expect(compact()).resolves.toMatchObject({savedBytes: expect.any(Number)}); released();
    });
    it.each(['cache-read', 'cache-mkdir', 'cache-rename', 'zip-write', 'zip-rename', 'cleanup', 'changed', 'temp-collision'] as const)(
        '文件系统失败或源包变化不能覆盖原文件（%s）', async mode => {
            const original = await fixture(), failure = Error('filesystem failure');
            const nativeRename = fs.rename, nativeWrite = fs.writeFile, nativeRemove = fs.rm, nativeOpen = fs.open;
            if (mode === 'cache-read') await fs.writeFile(cache, 'not a directory');
            if (mode === 'cache-mkdir') vi.spyOn(fs, 'mkdir').mockRejectedValue(failure);
            if (mode === 'cache-rename' || mode === 'zip-rename' || mode === 'cleanup') vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
                if ((mode === 'cache-rename' && String(to).endsWith('.deflate-cache')) || (mode !== 'cache-rename' && to === zipPath)) throw failure;
                await nativeRename(from, to);
            });
            if (mode === 'zip-write' || mode === 'temp-collision') vi.spyOn(fs, 'open').mockImplementation(async (file, flags, permissions) => {
                if (mode === 'temp-collision') await nativeWrite(file, 'unrelated temporary file');
                const handle = await nativeOpen(file, flags, permissions);
                if (String(file).startsWith(zipPath + '.')) vi.spyOn(handle, 'writeFile').mockImplementation(async () => {await nativeWrite(file, 'partial'); throw failure;});
                return handle;
            });
            if (mode === 'cleanup') vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
                if (String(file).startsWith(zipPath + '.')) throw Error('cleanup failure');
                await nativeRemove(file, options);
            });
            if (mode === 'changed') control.start = (worker, data) => {void nativeWrite(zipPath, 'replacement').then(() => worker.emit('message', deflateRawSync(data)));};
            await expect(compact()).rejects.toThrow();
            expect(await fs.readFile(zipPath)).toEqual(mode === 'changed' ? Buffer.from('replacement') : original); released();
            if (mode !== 'cleanup') expect((await fs.readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
            if (mode === 'temp-collision') expect(await fs.readFile(resolve(cache, (await fs.readdir(cache)).find(name => name.endsWith('.tmp'))!), 'utf8')).toBe('unrelated temporary file');
        });
    it('固定 WASM 必须使用 DEFLATE', async () => {const original = await fixture({store: true}); await expect(compact()).rejects.toThrow('不是 DEFLATE'); expect(await fs.readFile(zipPath)).toEqual(original);});
    it('对 JSZip 实际生成且 CRC 正常的数据描述符 ZIP 在变更前受控拒绝', async () => {
        const original = await fixture({streaming: true});
        await expect(JSZip.loadAsync(original, {checkCRC32: true})).resolves.toBeInstanceOf(JSZip);
        expect(original.readUInt16LE(positions(original).first.central + 8) & 8).toBe(8);
        await expect(compact()).rejects.toThrow('数据描述符');
        expect(await fs.readFile(zipPath)).toEqual(original); expect(control.instances).toHaveLength(0);
    });
    it('拒绝不匹配的压缩器版本', async () => {
        const original = await fixture(), native = fs.readFile;
        vi.spyOn(fs, 'readFile').mockImplementation((async (file, options) => String(file).endsWith('/@gfx/zopfli/package.json') || String(file).endsWith('/zopfli/package.json')
            ? JSON.stringify({version: 'other'}) : native(file, options)) as typeof fs.readFile);
        // pnpm 包路径最后仍以 @gfx/zopfli/package.json 结尾。
        await expect(compact()).rejects.toThrow('版本'); expect(await fs.readFile(zipPath)).toEqual(original);
    });
    it('worker 脚本只调用锁定参数的 raw DEFLATE 并传回原压缩字节', async () => {
        const script = await fs.readFile(resolve(root, 'scripts/wasm/zip-deflate-worker.cjs'), 'utf8');
        const bytes = Uint8Array.from([1, 2, 3]), postMessage = vi.fn(), deflateAsync = vi.fn(async () => bytes);
        runInNewContext(script, {require: (name: string) => name === 'node:worker_threads'
            ? {parentPort: {postMessage}, workerData: Uint8Array.from([7])} : {deflateAsync}}, {filename: resolve(root, 'scripts/wasm/zip-deflate-worker.cjs')});
        await Promise.resolve(); expect(deflateAsync).toHaveBeenCalledWith(Uint8Array.from([7]), {numiterations: 1}); expect(postMessage).toHaveBeenCalledWith(bytes);
    });
});

type Mutator = (bytes: Buffer, p: ReturnType<typeof positions>) => void;
const corruptions: Array<[string, string, Mutator]> = [
    ['EOCD comment', 'EOCD', (b, p) => b.writeUInt16LE(0xffff, p.end + 20)],
    ['disk', '多盘', (b, p) => b.writeUInt16LE(1, p.end + 4)],
    ['central disk', '多盘', (b, p) => b.writeUInt16LE(1, p.end + 6)],
    ['disk count', '多盘', (b, p) => b.writeUInt16LE(1, p.end + 8)],
    ['ZIP64 count', 'ZIP64', (b, p) => {b.writeUInt16LE(0xffff, p.end + 8); b.writeUInt16LE(0xffff, p.end + 10);}],
    ['ZIP64 central size', 'ZIP64', (b, p) => b.writeUInt32LE(0xffffffff, p.end + 12)],
    ['ZIP64 central offset', 'ZIP64', (b, p) => b.writeUInt32LE(0xffffffff, p.end + 16)],
    ['central bounds', '目录位置', (b, p) => b.writeUInt32LE(1, p.end + 12)],
    ['central count overflow', '目录记录', (b, p) => {const count = b.readUInt16LE(p.end + 10) + 1; b.writeUInt16LE(count, p.end + 8); b.writeUInt16LE(count, p.end + 10);}],
    ['central signature', '目录签名', (b, p) => b.writeUInt32LE(0, p.first.central)],
    ['central field length', '可变字段', (b, p) => b.writeUInt16LE(0xffff, p.first.central + 28)],
    ['encrypted', '加密', (b, p) => b.writeUInt16LE(1, p.first.central + 8)],
    ['entry disk', '多盘条目', (b, p) => b.writeUInt16LE(1, p.first.central + 34)],
    ...[20, 24, 42].map(offset => [`ZIP64 entry ${offset}`, 'ZIP64', (b: Buffer, p: ReturnType<typeof positions>) => b.writeUInt32LE(0xffffffff, p.first.central + offset)] as [string, string, Mutator]),
    ['filename encoding', '文件名编码', (b, p) => {b[p.first.central + 46] = 255;}],
    ['duplicate name', '重复', (b, p) => {const a = p.entries.find(e => e.name === 'a.txt')!, z = p.entries.find(e => e.name === 'b.txt')!; b.copy(b, z.central + 46, a.central + 46, a.central + 51);}],
    ['extra header', '附加字段不完整', (b, p) => b.writeUInt16LE(1, p.first.central + 30)],
    ['extra size', '附加字段长度', (b, p) => {b.writeUInt16LE(4, p.first.central + 30); const x = p.first.central + 46 + b.readUInt16LE(p.first.central + 28); b.writeUInt16LE(2, x); b.writeUInt16LE(8, x + 2);}],
    ['ZIP64 extra', 'ZIP64', (b, p) => {b.writeUInt16LE(4, p.first.central + 30); const x = p.first.central + 46 + b.readUInt16LE(p.first.central + 28); b.writeUInt16LE(1, x); b.writeUInt16LE(0, x + 2);}],
    ['local bounds', '本地记录位置', (b, p) => b.writeUInt32LE(p.end, p.first.central + 42)],
    ['local signature', '本地记录签名', (b, p) => b.writeUInt32LE(0, p.first.local)],
    ['local data bounds', '本地数据', (b, p) => b.writeUInt16LE(0xffff, p.first.local + 26)],
    ...[6, 8, 14, 18, 22].map(offset => [`local mismatch ${offset}`, '本地记录与目录', (b: Buffer, p: ReturnType<typeof positions>) => {b[p.first.local + offset] = b[p.first.local + offset]! ^ 1;}] as [string, string, Mutator]),
    ['local name', '本地文件名', (b, p) => {b[p.first.local + 30] = 65;}],
    ['local extra', '附加字段不完整', (b, p) => b.writeUInt16LE(1, p.first.local + 28)],
    ['entry overlap', '重叠', (b, p) => {const size = b.readUInt32LE(p.first.central + 20) + 1; b.writeUInt32LE(size, p.first.central + 20); b.writeUInt32LE(size, p.first.local + 18);}],
    ['central count underflow', '数量', (b, p) => {const count = b.readUInt16LE(p.end + 10) - 1; b.writeUInt16LE(count, p.end + 8); b.writeUInt16LE(count, p.end + 10);}],
    ['missing target', '缺少固定 WASM', (b, p) => {b[p.first.central + 46] = 65; b[p.first.local + 30] = 65;}],
];
describe('ZIP 结构边界', () => {
    it.each(corruptions)('拒绝 %s，任何失败不修改原包', async (_name, reason, mutate) => {
        const original = await fixture(); mutate(original, positions(original)); await fs.writeFile(zipPath, original);
        await expect(compact()).rejects.toThrow(reason); expect(await fs.readFile(zipPath)).toEqual(original); expect(control.instances).toHaveLength(0);
    });
    it('截断的文件没有可用 EOCD', async () => {await fs.writeFile(zipPath, Buffer.from('PK')); await expect(compact()).rejects.toThrow('EOCD');});
});

/** 插入不属于文件内容的前缀/对齐字节，按标准目录偏移重定位夹具。 */
function insertArchiveBytes(bytes: Buffer, at: number, extra: Buffer): Buffer {
    const p = positions(bytes), output = Buffer.concat([bytes.subarray(0, at), extra, bytes.subarray(at)]);
    for (const entry of p.entries) output.writeUInt32LE(entry.local + (entry.local >= at ? extra.length : 0), entry.central + extra.length + 42);
    output.writeUInt32LE(bytes.readUInt32LE(p.end + 16) + extra.length, p.end + extra.length + 16);
    return output;
}

describe('完整 ZIP 保留契约', () => {
    it.each(['count', 'central', 'local', 'end', 'prefix', 'suffix', 'non-target-stream'] as const)(
        '独立校验拒绝元数据或非目标字节变化（%s）', async kind => {
            let original = await fixture(), output: Buffer, reason: string;
            if (kind === 'count') {output = await fixture({extra: true}); reason = '条目数量';}
            else if (kind === 'central') {output = await fixture({fileComment: 'preserve this entry comment'}); reason = 'ZIP 元数据';}
            else if (kind === 'local') {output = Buffer.from(original); output[positions(output).first.local + 10] ^= 1; reason = '本地元数据';}
            else if (kind === 'end') {output = await fixture({zipComment: 'preserve the archive comment'}); reason = 'EOCD 元数据';}
            else if (kind === 'prefix') {
                original = insertArchiveBytes(original, 0, Buffer.from('PREFIX')); output = Buffer.from(original); output[0] ^= 1; reason = '前缀';
            } else if (kind === 'suffix') {
                const p = positions(original); output = insertArchiveBytes(original, p.first.data + original.readUInt32LE(p.first.central + 20), Buffer.from('PADDING')); reason = '尾部字节';
            } else {output = await fixture({level: 9}); reason = '非 WASM 条目字节';}
            await expect(verifyExtensionZipPreservation(original, output)).rejects.toThrow(reason);
        });
    it('重压保留标准 ZIP 的前缀及目标文件之后的对齐字节', async () => {
        let original = await fixture(); original = insertArchiveBytes(original, 0, Buffer.from('PREFIX'));
        const p = positions(original); original = insertArchiveBytes(original, p.first.data + original.readUInt32LE(p.first.central + 20), Buffer.from('PADDING'));
        await fs.writeFile(zipPath, original); await compact();
        await expect(verifyExtensionZipPreservation(original, await fs.readFile(zipPath))).resolves.toBeUndefined();
    });
    it('CRC32 相同仍逐字节拒绝不同的 WASM 内容', async () => {
        const crc32 = (bytes: Buffer) => {
            let crc = -1;
            for (const byte of bytes) {crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);}
            return (crc ^ -1) >>> 0;
        };
        const first = Buffer.alloc(8), different = Buffer.alloc(8); different[0] = 1;
        const base = crc32(different), basis = new Map<number, {value: number; mask: number}>();
        for (let column = 0; column < 32; column += 1) {
            const trial = Buffer.from(different); trial[4 + Math.floor(column / 8)]! ^= 1 << (column % 8);
            let value = (crc32(trial) ^ base) >>> 0, mask = (1 << column) >>> 0;
            for (let bit = 31; bit >= 0; bit -= 1) if (value & (1 << bit)) {
                const previous = basis.get(bit);
                if (!previous) {basis.set(bit, {value, mask}); break;}
                value = (value ^ previous.value) >>> 0; mask = (mask ^ previous.mask) >>> 0;
            }
        }
        let needed = (crc32(first) ^ base) >>> 0, mask = 0;
        for (let bit = 31; bit >= 0; bit -= 1) if (needed & (1 << bit)) {const entry = basis.get(bit)!; needed = (needed ^ entry.value) >>> 0; mask = (mask ^ entry.mask) >>> 0;}
        expect(needed).toBe(0);
        for (let bit = 0; bit < 32; bit += 1) if (mask & (1 << bit)) different[4 + Math.floor(bit / 8)]! ^= 1 << (bit % 8);
        expect(different).not.toEqual(first); expect(crc32(different)).toBe(crc32(first));
        const original = await fixture({first}), output = await fixture({first: different});
        await expect(verifyExtensionZipPreservation(original, output)).rejects.toThrow('解压内容');
    });
});
