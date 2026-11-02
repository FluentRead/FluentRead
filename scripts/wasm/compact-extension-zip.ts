/**
 * @file scripts/wasm/compact-extension-zip.ts
 * 文件职责：在 WXT 完成扩展 ZIP 后，无损重压三个固定 WASM 条目的 DEFLATE 流。
 * 主要内容：解析标准单盘 ZIP 的公开目录及本地记录，原样复制非目标跨度与元数据；隔离 worker 使用锁定 Zopfli 参数，按原文摘要缓存并复验，逐条校验 CRC/解压字节后原子替换更小的完整 ZIP。
 * 模块边界：仅供构建 hook，不改变 WASM、模型、文件名或运行时解码方式；不支持 ZIP64、加密、数据描述符或多盘，所有拒绝均在替换原 ZIP 之前。
 */
import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile, open, mkdir, rename, rm, stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Worker} from 'node:worker_threads';
import {inflateRawSync} from 'node:zlib';
import JSZip from 'jszip';

const WASM_FILES = [
    'fluent-read-ai/ort-wasm-simd-threaded.asyncify.wasm',
    'fluent-read-ai/wllama.wasm',
    'fluent-read-ocr/core/tesseract-core-simd-lstm.wasm',
] as const;
const COMPRESSOR_VERSION = '1.0.15';
const CACHE_FORMAT = `sha256-zopfli-${COMPRESSOR_VERSION}-deflate-iterations-1`;

interface ZipEntry {
    name: string;
    central: Buffer;
    localOffset: number;
    dataOffset: number;
    compressedSize: number;
    originalSize: number;
    spanEnd: number;
}
interface ZipLayout {entries: ZipEntry[]; centralOffset: number; endOffset: number; localStart: number}
export interface CompactExtensionZipResult {
    beforeBytes: number;
    afterBytes: number;
    savedBytes: number;
    entries: Array<{name: string; originalBytes: number; beforeBytes: number; afterBytes: number; sha256: string; cacheHit: boolean}>;
}

function requireZip(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Error(`无法无损压缩扩展 ZIP：${message}`);
}
function inspectExtra(extra: Buffer): void {
    for (let offset = 0; offset < extra.length;) {
        requireZip(offset + 4 <= extra.length, '附加字段不完整');
        const tag = extra.readUInt16LE(offset), size = extra.readUInt16LE(offset + 2);
        requireZip(offset + 4 + size <= extra.length, '附加字段长度无效');
        requireZip(tag !== 1, '不支持 ZIP64');
        offset += 4 + size;
    }
}
function parseZip(bytes: Buffer): ZipLayout {
    let endOffset = -1;
    for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
        if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) {
            endOffset = offset; break;
        }
    }
    requireZip(endOffset >= 0, '缺少完整的 EOCD');
    const count = bytes.readUInt16LE(endOffset + 10), centralSize = bytes.readUInt32LE(endOffset + 12);
    const centralOffset = bytes.readUInt32LE(endOffset + 16);
    requireZip(bytes.readUInt16LE(endOffset + 4) === 0 && bytes.readUInt16LE(endOffset + 6) === 0 &&
        bytes.readUInt16LE(endOffset + 8) === count, '不支持多盘 ZIP');
    requireZip(count !== 0xffff && centralSize !== 0xffffffff && centralOffset !== 0xffffffff, '不支持 ZIP64');
    requireZip(centralOffset + centralSize === endOffset, '目录位置或长度无效');
    const entries: ZipEntry[] = [], names = new Set<string>();
    let cursor = centralOffset;
    for (let index = 0; index < count; index += 1) {
        requireZip(cursor + 46 <= endOffset, '目录记录不完整');
        requireZip(bytes.readUInt32LE(cursor) === 0x02014b50, '目录签名无效');
        const flags = bytes.readUInt16LE(cursor + 8), compressedSize = bytes.readUInt32LE(cursor + 20);
        const originalSize = bytes.readUInt32LE(cursor + 24), localOffset = bytes.readUInt32LE(cursor + 42);
        const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30);
        const length = 46 + nameLength + extraLength + bytes.readUInt16LE(cursor + 32);
        requireZip(cursor + length <= endOffset, '目录可变字段不完整');
        requireZip((flags & 0x41) === 0, '不支持加密 ZIP');
        requireZip((flags & 8) === 0, '不支持数据描述符');
        requireZip(bytes.readUInt16LE(cursor + 34) === 0, '不支持多盘条目');
        requireZip(compressedSize !== 0xffffffff && originalSize !== 0xffffffff && localOffset !== 0xffffffff, '不支持 ZIP64');
        const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength), name = nameBytes.toString('utf8');
        requireZip(Buffer.from(name, 'utf8').equals(nameBytes) && !names.has(name), '文件名编码无效或重复');
        names.add(name);
        inspectExtra(bytes.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength));
        requireZip(localOffset + 30 <= centralOffset, '本地记录位置无效');
        requireZip(bytes.readUInt32LE(localOffset) === 0x04034b50, '本地记录签名无效');
        const localNameLength = bytes.readUInt16LE(localOffset + 26), localExtraLength = bytes.readUInt16LE(localOffset + 28);
        const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
        requireZip(dataOffset + compressedSize <= centralOffset, '本地数据越过目录');
        requireZip(bytes.readUInt16LE(localOffset + 6) === flags &&
            bytes.readUInt16LE(localOffset + 8) === bytes.readUInt16LE(cursor + 10) &&
            bytes.readUInt32LE(localOffset + 14) === bytes.readUInt32LE(cursor + 16) &&
            bytes.readUInt32LE(localOffset + 18) === compressedSize && bytes.readUInt32LE(localOffset + 22) === originalSize,
        '本地记录与目录不一致');
        requireZip(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes), '本地文件名不一致');
        inspectExtra(bytes.subarray(localOffset + 30 + localNameLength, dataOffset));
        entries.push({name, central: bytes.subarray(cursor, cursor + length), localOffset, dataOffset,
            compressedSize, originalSize, spanEnd: 0});
        cursor += length;
    }
    requireZip(cursor === endOffset, '目录条目数量不一致');
    const localOrder = [...entries].sort((left, right) => left.localOffset - right.localOffset);
    localOrder.forEach((entry, index) => {
        entry.spanEnd = localOrder[index + 1]?.localOffset ?? centralOffset;
        requireZip(entry.dataOffset + entry.compressedSize <= entry.spanEnd, '本地条目重叠');
    });
    for (const name of WASM_FILES) requireZip(entries.some(entry => entry.name === name), `缺少固定 WASM 条目 ${name}`);
    return {entries, centralOffset, endOffset, localStart: localOrder[0]!.localOffset};
}

async function compressInWorker(data: Buffer, root: string, timeoutMs: number): Promise<Buffer> {
    return new Promise((resolveResult, reject) => {
        const worker = new Worker(resolve(root, 'scripts/wasm/zip-deflate-worker.cjs'), {workerData: data});
        let settled = false;
        const detach = () => {worker.off('message', message); worker.off('error', fail); worker.off('exit', exited);};
        const finish = (success: boolean, value: unknown) => {
            if (settled) return;
            settled = true; clearTimeout(timer);
            void worker.terminate().then(() => {
                detach();
                if (success) resolveResult(value as Buffer); else reject(value);
            }, error => {detach(); reject(new AggregateError(success ? [error] : [value, error], 'WASM 压缩 worker 无法释放'));});
        };
        const fail = (error: unknown) => finish(false, error);
        const exited = (code: number) => fail(new Error(`WASM 压缩 worker 提前退出：${code}`));
        const message = (value: unknown) => {
            if (value instanceof Uint8Array) finish(true, Buffer.from(value));
            else fail(new Error('WASM 压缩 worker 返回了无效数据'));
        };
        const timer = setTimeout(() => fail(new Error('WASM 压缩 worker 超时')), timeoutMs);
        worker.on('message', message); worker.on('error', fail); worker.on('exit', exited);
    });
}
function verifyDeflate(compact: Buffer, original: Buffer): void {
    requireZip(inflateRawSync(compact, {maxOutputLength: original.length + 1}).equals(original), '压缩流解压字节不一致');
}
async function atomicWrite(file: string, bytes: Buffer, validate: () => Promise<void>, mode = 0o666): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    // 只有成功独占创建后才拥有清理权；碰撞时不能删除别的构建写下的临时文件。
    const handle = await open(temporary, 'wx', mode);
    try {
        try {await handle.writeFile(bytes);} finally {await handle.close();}
        await validate();
        await rename(temporary, file);
    } catch (error) {
        try {await rm(temporary, {force: true});}
        catch (cleanup) {throw new AggregateError([error, cleanup], '无法清理 ZIP 压缩临时文件');}
        throw error;
    }
}
async function cachedDeflate(original: Buffer, root: string, cache: string, timeoutMs: number) {
    const sha256 = createHash('sha256').update(original).digest('hex'), file = resolve(cache, `${sha256}.deflate-cache`);
    let cached: Buffer;
    try {cached = await readFile(file);}
    catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
        const compact = await compressInWorker(original, root, timeoutMs);
        verifyDeflate(compact, original);
        await mkdir(cache, {recursive: true});
        await atomicWrite(file, Buffer.concat([createHash('sha256').update(compact).digest(), compact]), async () => {});
        return {compact, sha256, cacheHit: false};
    }
    const compact = cached.subarray(32);
    requireZip(cached.length >= 32 && cached.subarray(0, 32).equals(createHash('sha256').update(compact).digest()), 'WASM 压缩缓存校验失败');
    verifyDeflate(compact, original);
    return {compact, sha256, cacheHit: true};
}
function repack(bytes: Buffer, layout: ZipLayout, replacements: Map<string, Buffer>): Buffer {
    const localOrder = [...layout.entries].sort((left, right) => left.localOffset - right.localOffset);
    const chunks: Buffer[] = [bytes.subarray(0, layout.localStart)], offsets = new Map<string, number>();
    let offset = chunks[0]!.length;
    for (const entry of localOrder) {
        offsets.set(entry.name, offset);
        const replacement = replacements.get(entry.name);
        if (replacement) {
            const header = Buffer.from(bytes.subarray(entry.localOffset, entry.dataOffset));
            header.writeUInt32LE(replacement.length, 18);
            const suffix = bytes.subarray(entry.dataOffset + entry.compressedSize, entry.spanEnd);
            chunks.push(header, replacement, suffix); offset += header.length + replacement.length + suffix.length;
        } else {const span = bytes.subarray(entry.localOffset, entry.spanEnd); chunks.push(span); offset += span.length;}
    }
    const centralOffset = offset;
    for (const entry of layout.entries) {
        const central = Buffer.from(entry.central);
        central.writeUInt32LE(offsets.get(entry.name)!, 42);
        const replacement = replacements.get(entry.name);
        if (replacement) central.writeUInt32LE(replacement.length, 20);
        chunks.push(central);
    }
    const end = Buffer.from(bytes.subarray(layout.endOffset)); end.writeUInt32LE(centralOffset, 16); chunks.push(end);
    return Buffer.concat(chunks);
}

/** 独立验证完整 ZIP 的保留契约，也可用于构建产物复核；只允许压缩大小与记录偏移变化。 */
export async function verifyExtensionZipPreservation(original: Buffer, output: Buffer): Promise<void> {
    const layout = parseZip(original), next = parseZip(output);
    requireZip(next.entries.length === layout.entries.length, '重打包改变了条目数量');
    const end = Buffer.from(output.subarray(next.endOffset)); end.writeUInt32LE(layout.centralOffset, 16);
    requireZip(end.equals(original.subarray(layout.endOffset)), '重打包改变了 EOCD 元数据');
    requireZip(original.subarray(0, layout.localStart).equals(output.subarray(0, next.localStart)), '重打包改变了 ZIP 前缀');
    const before = await JSZip.loadAsync(original, {checkCRC32: true}), after = await JSZip.loadAsync(output, {checkCRC32: true});
    for (let index = 0; index < layout.entries.length; index += 1) {
        const entry = layout.entries[index]!, rebuilt = next.entries[index]!;
        const metadata = Buffer.from(rebuilt.central); metadata.writeUInt32LE(entry.compressedSize, 20); metadata.writeUInt32LE(entry.localOffset, 42);
        requireZip(metadata.equals(entry.central), '重打包改变了 ZIP 元数据');
        const local = Buffer.from(output.subarray(rebuilt.localOffset, rebuilt.dataOffset)); local.writeUInt32LE(entry.compressedSize, 18);
        requireZip(local.equals(original.subarray(entry.localOffset, entry.dataOffset)), '重打包改变了本地元数据');
        if (!(WASM_FILES as readonly string[]).includes(entry.name)) requireZip(
            original.subarray(entry.localOffset, entry.spanEnd).equals(output.subarray(rebuilt.localOffset, rebuilt.spanEnd)),
            '重打包改变了非 WASM 条目字节');
        requireZip(original.subarray(entry.dataOffset + entry.compressedSize, entry.spanEnd).equals(
            output.subarray(rebuilt.dataOffset + rebuilt.compressedSize, rebuilt.spanEnd)), '重打包改变了条目尾部字节');
        requireZip(Buffer.from(await after.files[entry.name]!.async('uint8array')).equals(Buffer.from(await before.files[entry.name]!.async('uint8array'))),
            `重打包改变了解压内容：${entry.name}`);
    }
}

/** WXT zip:extension:done 调用；返回体积测量，不增加运行时依赖或更改任何条目的解压内容。 */
export async function compactExtensionZip(zipPath: string, root: string,
    options: {cacheDirectory?: string; workerTimeoutMs?: number} = {}): Promise<CompactExtensionZipResult> {
    const original = await readFile(zipPath), layout = parseZip(original);
    const before = await JSZip.loadAsync(original, {checkCRC32: true});
    const require = createRequire(resolve(root, 'package.json'));
    const version = JSON.parse(await readFile(require.resolve('@gfx/zopfli/package.json'), 'utf8')).version;
    requireZip(version === COMPRESSOR_VERSION, '压缩器版本与缓存格式不一致');
    const cache = options.cacheDirectory ?? resolve(root, '.wxt/zip-wasm-deflate', CACHE_FORMAT);
    const replacements = new Map<string, Buffer>(), entries: CompactExtensionZipResult['entries'] = [];
    for (const name of WASM_FILES) {
        const entry = layout.entries.find(candidate => candidate.name === name)!;
        requireZip(entry.central.readUInt16LE(10) === 8, `固定 WASM 条目不是 DEFLATE：${name}`);
        const file = before.files[name]; requireZip(Boolean(file), 'ZIP 解码后的文件名发生变化');
        const bytes = await file.async('nodebuffer');
        const {compact, sha256, cacheHit} = await cachedDeflate(bytes, root, cache, options.workerTimeoutMs ?? 180_000);
        if (compact.length < entry.compressedSize) replacements.set(name, compact);
        entries.push({name, originalBytes: bytes.length, beforeBytes: entry.compressedSize,
            afterBytes: Math.min(compact.length, entry.compressedSize), sha256, cacheHit});
    }
    const output = replacements.size > 0 ? repack(original, layout, replacements) : original;
    await verifyExtensionZipPreservation(original, output);
    const validate = async () => requireZip((await readFile(zipPath)).equals(original), '压缩期间 ZIP 已被其他任务改写');
    if (output !== original) {
        const mode = (await stat(zipPath)).mode;
        await atomicWrite(zipPath, output, validate, mode);
    } else await validate();
    return {beforeBytes: original.length, afterBytes: output.length, savedBytes: original.length - output.length, entries};
}
