/**
 * @file scripts/wasm/kokoro-phonemizer-build.ts
 * 文件职责：在构建期确定性裁剪 `phonemizer@1.2.1` 内嵌的 `espeak-ng-data` 虚拟文件系统，大幅缩减 `localTtsWorker.js` 体积。
 * 主要内容：
 * - 严格校验锁定的 `phonemizer@1.2.1` 版本、gzip 魔数、Emscripten 文件表、`phondata` 头魔数/采样率及 `phontab` 字节对齐；
 * - 保留 `en_dict`、`intonations`、`phonindex` 与全部英语 `lang/gmw/en*` 定义，确保 `en-us`、`en`、`en-gb` 及所有 8 个英语声线列表与 IPA 输出逐字节一致；
 * - 裁剪 126 个非英语 `lang/*`、104 个 `voices/!v/*`、90 个 `voices/mb/*` 与 117 个非英语 `phontab` 音素表（重映射保留表的 `includes` 索引）；
 * - 保留 `phondata` 8 字节合法头与原始字节长度并将声学共振峰/波形主体清零：espeak-ng 的 `synth_ipa_` 仅读取该头并丢弃波形输出，清零主体在保证零越界的同时将 550 KB 音频数据压缩至约 540 字节。
 * 模块边界：纯构建期 Vite/Rolldown 插件，仅拦截 `@uzen/kokoro-js` 导入的 `phonemizer`，不引入外部资源、嵌套压缩文件或运行时 `eval`。
 */
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import zlib from 'node:zlib';
import type {Plugin} from 'vite';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const EXPECTED_PHONEMIZER_VERSION = '1.2.1';
const VIRTUAL_PHONEMIZER_ID = '\0fluentread-kokoro-phonemizer';

const ESPEAK_DATA_ROOT = '/usr/share/espeak-ng-data';
const ESPEAK_PHDATA_VERSION = 0x00014801;
const ESPEAK_PHDATA_SAMPLE_RATE = 22050;
const PHONEME_TAB_HEADER_BYTES = 36;
const PHONEME_TAB_ENTRY_BYTES = 16;

const DATA_PREAMBLE = 'const e="/usr/share/espeak-ng-data",C=e+"/lang",a=e+"/voices";';
const GZIP_STREAM_SUFFIX = '"),e=new Blob([A]).stream().pipeThrough(new DecompressionStream("gzip"))';

interface EmscriptenFileEntry {
    readonly filename: string;
    readonly start: number;
    readonly end: number;
}

export interface PrunedPhonemizerStats {
    readonly originalSourceBytes: number;
    readonly prunedSourceBytes: number;
    readonly originalGzipBytes: number;
    readonly prunedGzipBytes: number;
    readonly originalFileCount: number;
    readonly keptFileCount: number;
}

function normalizePath(filePath: string): string {
    return filePath.split('?')[0]!.replace(/\\/g, '/');
}

function isKokoroJsImporter(importer: string | undefined): boolean {
    if (!importer) return false;
    const normalized = normalizePath(importer);
    return normalized.includes('/@uzen/kokoro-js/') || normalized.includes('/@uzen+kokoro-js@');
}

/**
 * 保留 `phondata` 的 8 字节头（版本 + 采样率）与原始长度，并将音频合成主体清零。
 * `espeak-ng` 的 `synth_ipa_` 仅用该头通过 `LoadPhData()` 校验，后续被丢弃的波形合成阶段按原偏移读取零帧后直接早退。
 */
export function zeroEspeakPhondata(phondataBuffer: Uint8Array): Buffer {
    if (phondataBuffer.length < 8) {
        throw new Error(`Invalid espeak-ng phondata length: ${phondataBuffer.length}`);
    }
    const view = Buffer.from(phondataBuffer.buffer, phondataBuffer.byteOffset, phondataBuffer.byteLength);
    const version = view.readUInt32LE(0);
    const sampleRate = view.readUInt32LE(4);
    if (version !== ESPEAK_PHDATA_VERSION || sampleRate !== ESPEAK_PHDATA_SAMPLE_RATE) {
        throw new Error(
            `Unexpected espeak-ng phondata header: version=0x${version.toString(16)} sampleRate=${sampleRate}`,
        );
    }
    const out = Buffer.alloc(view.length, 0);
    view.copy(out, 0, 0, 8);
    return out;
}

/**
 * 解析 espeak-ng `phontab`，仅保留 `base`、`en`、`en-*` 及其传递 `includes` 祖先表，并重映射 1-based `includes` 索引。
 */
export function pruneEspeakPhontab(phontabBuffer: Uint8Array): Buffer {
    if (phontabBuffer.length < 4) {
        throw new Error(`Invalid espeak-ng phontab length: ${phontabBuffer.length}`);
    }
    const view = Buffer.from(phontabBuffer.buffer, phontabBuffer.byteOffset, phontabBuffer.byteLength);
    const tableCount = view.readUInt32LE(0);
    if (tableCount <= 0) {
        throw new Error(`Invalid espeak-ng phontab table count: ${tableCount}`);
    }

    const tables: Array<{
        readonly idx: number;
        readonly name: string;
        readonly includes: number;
        readonly bytes: Buffer;
    }> = [];
    let offset = 4;
    for (let idx = 0; idx < tableCount; idx += 1) {
        if (offset + PHONEME_TAB_HEADER_BYTES > view.length) {
            throw new Error(`Truncated espeak-ng phontab header at table ${idx}`);
        }
        const phonemeCount = view[offset]!;
        const includes = view[offset + 1]!;
        const name = view.subarray(offset + 4, offset + PHONEME_TAB_HEADER_BYTES).toString('ascii').replace(/\0.*$/u, '');
        const tableSize = PHONEME_TAB_HEADER_BYTES + phonemeCount * PHONEME_TAB_ENTRY_BYTES;
        if (offset + tableSize > view.length) {
            throw new Error(`Truncated espeak-ng phontab table "${name}" at index ${idx}`);
        }
        tables.push({
            idx,
            name,
            includes,
            bytes: Buffer.from(view.subarray(offset, offset + tableSize)),
        });
        offset += tableSize;
    }
    if (offset !== view.length) {
        throw new Error(`Unexpected trailing bytes in espeak-ng phontab: parsed ${offset} of ${view.length}`);
    }

    const keepSet = new Set<number>();
    const includeWithAncestors = (idx: number): void => {
        if (keepSet.has(idx)) return;
        const table = tables[idx];
        if (!table) {
            throw new Error(`Invalid espeak-ng phontab include target index: ${idx}`);
        }
        keepSet.add(idx);
        if (table.includes > 0) {
            includeWithAncestors(table.includes - 1);
        }
    };

    for (const table of tables) {
        if (table.name === 'base' || table.name === 'en' || table.name.startsWith('en-')) {
            includeWithAncestors(table.idx);
        }
    }

    const keptIndices = [...keepSet].sort((left, right) => left - right);
    const keptNames = new Set(keptIndices.map((idx) => tables[idx]!.name));
    for (const required of ['base', 'en', 'en-us']) {
        if (!keptNames.has(required)) {
            throw new Error(`Missing required English phoneme table in espeak-ng phontab: ${required}`);
        }
    }

    const oldToNewOneBased = new Map<number, number>();
    keptIndices.forEach((oldIdx, newIdx) => {
        oldToNewOneBased.set(oldIdx + 1, newIdx + 1);
    });

    const header = Buffer.alloc(4);
    header.writeUInt32LE(keptIndices.length, 0);
    const parts: Buffer[] = [header];
    for (const oldIdx of keptIndices) {
        const table = tables[oldIdx]!;
        const copy = Buffer.from(table.bytes);
        if (copy[1]! !== 0) {
            const remapped = oldToNewOneBased.get(copy[1]!);
            if (!remapped) {
                throw new Error(`Missing remapped include index for espeak-ng table "${table.name}": ${copy[1]}`);
            }
            copy[1] = remapped;
        }
        parts.push(copy);
    }
    return Buffer.concat(parts);
}

function parseEmscriptenFileTable(source: string): {
    readonly filesStart: number;
    readonly filesEnd: number;
    readonly files: readonly EmscriptenFileEntry[];
    readonly remotePackageSize: number;
} {
    if (!source.includes(DATA_PREAMBLE)) {
        throw new Error('Unexpected phonemizer.js layout: missing espeak-ng path preamble');
    }

    const filesStart = source.indexOf('{files:[');
    if (filesStart < 0) {
        throw new Error('Unexpected phonemizer.js layout: missing Emscripten files metadata');
    }

    let depth = 0;
    let filesEnd = -1;
    for (let index = filesStart; index < source.length; index += 1) {
        const ch = source[index];
        if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                filesEnd = index + 1;
                break;
            }
        }
    }
    if (filesEnd < 0) {
        throw new Error('Unexpected phonemizer.js layout: unterminated Emscripten files metadata');
    }

    const metadataBlock = source.slice(filesStart, filesEnd);
    const outerMatch = /^\{files:\[([\s\S]*)\],remote_package_size:(\d+)\}$/u.exec(metadataBlock);
    if (!outerMatch) {
        throw new Error('Unexpected phonemizer.js layout: malformed Emscripten package metadata');
    }
    const entriesBody = outerMatch[1]!;
    const remotePackageSize = Number(outerMatch[2]!);
    const prefixes: Readonly<Record<string, string>> = {
        e: ESPEAK_DATA_ROOT,
        C: `${ESPEAK_DATA_ROOT}/lang`,
        a: `${ESPEAK_DATA_ROOT}/voices`,
    };

    const entryPattern = /\{filename:([eCa])\+"([^"]+)",start:(\d+),end:(\d+)\}/gu;
    const files: EmscriptenFileEntry[] = [];
    let consumed = 0;
    for (const match of entriesBody.matchAll(entryPattern)) {
        const expectedStart = files.length === 0 ? 0 : consumed + 1;
        if (match.index !== expectedStart || (files.length > 0 && entriesBody[consumed] !== ',')) {
            throw new Error(`Unexpected token in phonemizer.js file table near offset ${consumed}`);
        }
        const prefix = prefixes[match[1]!]!;
        const start = Number(match[3]!);
        const end = Number(match[4]!);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
            throw new Error(`Invalid byte range [${start}, ${end}) for ${prefix}${match[2]}`);
        }
        files.push({filename: `${prefix}${match[2]!}`, start, end});
        consumed = match.index + match[0].length;
    }
    if (files.length === 0 || consumed !== entriesBody.length) {
        throw new Error('Failed to parse complete Emscripten file table in phonemizer.js');
    }

    return {filesStart, filesEnd, files, remotePackageSize};
}

function locateGzipDataLiteral(source: string): {
    readonly literalStart: number;
    readonly literalEnd: number;
    readonly base64: string;
} {
    const suffixIndex = source.indexOf(GZIP_STREAM_SUFFIX);
    if (suffixIndex < 0) {
        throw new Error('Unexpected phonemizer.js layout: missing gzip DecompressionStream loader');
    }
    const openQuoteIndex = source.lastIndexOf('("', suffixIndex);
    if (openQuoteIndex < 0) {
        throw new Error('Unexpected phonemizer.js layout: missing base64 data literal opening delimiter');
    }
    const literalStart = openQuoteIndex + 2;
    const literalEnd = suffixIndex;
    const base64 = source.slice(literalStart, literalEnd);
    if (base64.length < 10_000 || !/^[A-Za-z0-9+/=]+$/u.test(base64)) {
        throw new Error('Unexpected phonemizer.js layout: invalid base64 espeak-ng data literal');
    }
    return {literalStart, literalEnd, base64};
}

function shouldKeepEspeakFile(relativePath: string): boolean {
    return relativePath === 'en_dict'
        || relativePath === 'intonations'
        || relativePath === 'phonindex'
        || relativePath === 'phontab'
        || relativePath === 'phondata'
        || relativePath === 'lang/gmw/en'
        || relativePath.startsWith('lang/gmw/en-');
}

function deterministicGzip(rawBuffer: Buffer): Buffer {
    const gz = zlib.gzipSync(rawBuffer, {level: 9});
    // 清零 gzip 头的 MTIME（字节 4..7）并固定 OS 为 Unix（0x03），确保跨平台构建产物逐字节确定。
    gz[4] = 0;
    gz[5] = 0;
    gz[6] = 0;
    gz[7] = 0;
    gz[9] = 0x03;
    return gz;
}

/**
 * 对 `phonemizer@1.2.1` 源码执行纯内存、确定性的 `espeak-ng-data` 裁剪，并返回源码与体积统计。
 */
export function prunePhonemizerSource(source: string): {
    readonly code: string;
    readonly stats: PrunedPhonemizerStats;
} {
    const {literalStart, literalEnd, base64} = locateGzipDataLiteral(source);
    const {filesStart, filesEnd, files, remotePackageSize} = parseEmscriptenFileTable(source);
    if (literalEnd >= filesStart) {
        throw new Error('Unexpected phonemizer.js layout: data literal overlaps file table');
    }

    const originalGzip = Buffer.from(base64, 'base64');
    if (originalGzip.length < 2 || originalGzip[0] !== 0x1f || originalGzip[1] !== 0x8b) {
        throw new Error('Invalid gzip header in phonemizer.js espeak-ng-data payload');
    }
    const originalRaw = zlib.gunzipSync(originalGzip);
    if (originalRaw.length !== remotePackageSize) {
        throw new Error(
            `Mismatched espeak-ng-data size: gunzipped ${originalRaw.length} !== remote_package_size ${remotePackageSize}`,
        );
    }

    const keptFiles: EmscriptenFileEntry[] = [];
    const keptChunks: Buffer[] = [];
    const seenRequired = new Set<string>();
    let offset = 0;

    for (const file of files) {
        if (file.end > originalRaw.length) {
            throw new Error(`Out-of-bounds slice [${file.start}, ${file.end}) for ${file.filename}`);
        }
        if (!file.filename.startsWith(`${ESPEAK_DATA_ROOT}/`)) {
            continue;
        }
        const relativePath = file.filename.slice(ESPEAK_DATA_ROOT.length + 1);
        if (!shouldKeepEspeakFile(relativePath)) {
            continue;
        }
        const rawSlice = originalRaw.subarray(file.start, file.end);
        let nextData: Buffer;
        if (relativePath === 'phondata') {
            nextData = zeroEspeakPhondata(rawSlice);
        } else if (relativePath === 'phontab') {
            nextData = pruneEspeakPhontab(rawSlice);
        } else {
            nextData = Buffer.from(rawSlice);
        }
        seenRequired.add(relativePath);
        keptFiles.push({filename: file.filename, start: offset, end: offset + nextData.length});
        keptChunks.push(nextData);
        offset += nextData.length;
    }

    for (const required of ['en_dict', 'intonations', 'phonindex', 'phontab', 'phondata', 'lang/gmw/en', 'lang/gmw/en-US']) {
        if (!seenRequired.has(required)) {
            throw new Error(`Missing required espeak-ng file after pruning: ${required}`);
        }
    }

    const prunedRaw = Buffer.concat(keptChunks);
    const prunedGzip = deterministicGzip(prunedRaw);
    const prunedBase64 = prunedGzip.toString('base64');
    const prunedMetadata = `{files:${JSON.stringify(keptFiles)},remote_package_size:${prunedRaw.length}}`;

    const code = [
        source.slice(0, literalStart),
        prunedBase64,
        source.slice(literalEnd, filesStart),
        prunedMetadata,
        source.slice(filesEnd),
    ].join('');

    return {
        code,
        stats: {
            originalSourceBytes: Buffer.byteLength(source, 'utf8'),
            prunedSourceBytes: Buffer.byteLength(code, 'utf8'),
            originalGzipBytes: originalGzip.length,
            prunedGzipBytes: prunedGzip.length,
            originalFileCount: files.length,
            keptFileCount: keptFiles.length,
        },
    };
}

export function resolvePhonemizerEntry(projectRoot = PROJECT_ROOT): string {
    const kokoroPackageJsonPath = fs.realpathSync(resolve(projectRoot, 'node_modules/@uzen/kokoro-js/package.json'));
    const kokoroRequire = createRequire(kokoroPackageJsonPath);
    const resolvedEntry = kokoroRequire.resolve('phonemizer');
    const distDir = dirname(resolvedEntry);
    const packageRoot = dirname(distDir);
    const packageJsonPath = join(packageRoot, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {version?: unknown};
    if (packageJson.version !== EXPECTED_PHONEMIZER_VERSION) {
        throw new Error(
            `Unsupported phonemizer version ${String(packageJson.version)} (expected ${EXPECTED_PHONEMIZER_VERSION}): review espeak-ng-data pruning rules`,
        );
    }
    const esmEntry = join(distDir, 'phonemizer.js');
    if (!fs.existsSync(esmEntry)) {
        throw new Error(`Missing phonemizer ESM entry: ${esmEntry}`);
    }
    return esmEntry;
}

/**
 * 为本地 Kokoro TTS 构建期裁剪 `phonemizer@1.2.1` 内嵌的 `espeak-ng-data`，
 * 移除非英语语言/音素表/变声配置并清零未使用的声学合成波形数据。
 */
export function kokoroPhonemizerBuildPlugin(projectRoot = PROJECT_ROOT): Plugin {
    const phonemizerEntry = resolvePhonemizerEntry(projectRoot);
    let cachedPrunedCode: string | null = null;

    return {
        name: 'fluentread-kokoro-phonemizer',
        enforce: 'pre',
        resolveId(source, importer) {
            if (source === 'phonemizer' && isKokoroJsImporter(importer)) {
                return VIRTUAL_PHONEMIZER_ID;
            }
            return null;
        },
        load(id) {
            if (id !== VIRTUAL_PHONEMIZER_ID) return null;
            if (cachedPrunedCode === null) {
                const rawSource = fs.readFileSync(phonemizerEntry, 'utf8');
                cachedPrunedCode = prunePhonemizerSource(rawSource).code;
            }
            return cachedPrunedCode;
        },
    };
}
