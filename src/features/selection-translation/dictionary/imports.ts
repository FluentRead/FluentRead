/**
 * @file src/features/selection-translation/dictionary/imports.ts
 * 文件职责：在导入 Worker 中读取用户选择的离线词典文件，生成统一索引记录。
 * 主要内容：解析 UTF-8/UTF-16 DSL、StarDict 索引及正文、Yomitan ZIP 和 MDict MDX/MDD；限制解压、词条与资源容量，拒绝损坏和不支持的加密版本。
 * 模块边界：只处理用户文件，不访问网络、配置或数据库；调用方负责事务提交和取消 Worker。
 */
import JSZip from 'jszip';
import {Inflate} from 'pako';
import {lzo1xDecompress as decompress} from 'lzo1x';
import {dictionaryPlainText, normalizeDictionaryWord} from './model';
import {decodeMdictKeyInfo} from './mdictKeys';

export const DICTIONARY_IMPORT_BYTES = 128 * 1024 * 1024;
const DICTIONARY_EXPANDED_BYTES = 256 * 1024 * 1024;
const DICTIONARY_ENTRY_LIMIT = 500_000;
export interface ImportedDictionaryEntry {key: string; word: string; html: string; definition: string; phonetic: string}
export interface ImportedDictionaryResource {path: string; bytes: Uint8Array}
export interface ImportedDictionary {name: string; format: string; entries: ImportedDictionaryEntry[]; resources: ImportedDictionaryResource[]; css: string}
export interface DictionaryFile {name: string; bytes: Uint8Array}
const utf8 = new TextDecoder('utf-8', {fatal: true});
const decoder = (bytes: Uint8Array) => new TextDecoder(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8', {fatal: true}).decode(bytes).replace(/^\uFEFF/, '');
export function dictionaryResourcePath(path: string): string {
    const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '');
    if (!normalized || normalized.length > 512 || normalized.split('/').some(part => part === '..') || /^[a-z]+:/i.test(normalized)) throw new Error('Invalid dictionary resource path');
    return normalized;
}
export function inflateDictionary(bytes: Uint8Array, expected?: number, limit = DICTIONARY_EXPANDED_BYTES): Uint8Array {
    if (expected !== undefined && (expected < 0 || expected > DICTIONARY_EXPANDED_BYTES)) throw new Error('Dictionary block is too large');
    const chunks: Uint8Array[] = [];
    let size = 0;
    const stream = new Inflate();
    stream.onData = (chunk: Uint8Array) => {
        size += chunk.length;
        if (size > Math.min(expected ?? DICTIONARY_EXPANDED_BYTES, limit)) throw new Error('Dictionary decompression limit exceeded');
        chunks.push(chunk);
    };
    stream.push(bytes, true);
    if (stream.err || !stream.ended || (expected !== undefined && size !== expected)) throw new Error('Invalid compressed dictionary block');
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {result.set(chunk, offset); offset += chunk.length;}
    return result;
}
function entry(word: string, html: string, phonetic = ''): ImportedDictionaryEntry | null {
    const key = normalizeDictionaryWord(word);
    if (!key) return null;
    if (html.length > 262144) throw new Error('Dictionary entry is too large');
    return {key, word, html, definition: dictionaryPlainText(html), phonetic};
}
function addEntry(entries: ImportedDictionaryEntry[], word: string, html: string, phonetic = ''): void {
    const result = entry(word, html, phonetic);
    if (result) entries.push(result);
    if (entries.length > DICTIONARY_ENTRY_LIMIT) throw new Error('Too many dictionary entries');
}
function escape(value: string): string {return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');}
function parseDsl(bytes: Uint8Array): ImportedDictionaryEntry[] {
    const entries: ImportedDictionaryEntry[] = [];
    let words: string[] = [];
    let body: string[] = [];
    const flush = () => {
        const html = body.map(line => escape(line).replace(/\[(b|i|u|sup|sub)\]/gi, '<$1>').replace(/\[\/(b|i|u|sup|sub)\]/gi, '</$1>')
            .replace(/\[s\]([^[]+)\[\/s\]/g, (_match, path: string) => `<audio controls src="${escape(path.trim())}"></audio>`)
            .replace(/\[(?:\/?[a-z*]+\d*(?: [^\]]*)?)\]/gi, '')).join('<br>');
        for (const word of words) addEntry(entries, word, html);
        words = []; body = [];
    };
    for (const line of decoder(bytes).replace(/\{\{[\s\S]*?\}\}/g, '').split(/\r?\n/)) {
        if (!line.trim() || line.startsWith('#')) continue;
        if (/^\s/.test(line)) body.push(line.trim());
        else {if (body.length) flush(); words.push(line.replace(/\\([\[\]{}()])/g, '$1').trim());}
    }
    flush();
    return entries;
}
class Reader {
    position = 0;
    constructor(readonly bytes: Uint8Array) {}
    take(size: number): Uint8Array {
        if (!Number.isSafeInteger(size) || size < 0 || this.position + size > this.bytes.length) throw new Error('Truncated dictionary file');
        const value = this.bytes.subarray(this.position, this.position + size); this.position += size; return value;
    }
    number(size: 1 | 2 | 4 | 8): number {
        const bytes = this.take(size);
        let result = 0;
        for (const byte of bytes) result = result * 256 + byte;
        if (!Number.isSafeInteger(result)) throw new Error('Dictionary offset exceeds supported size');
        return result;
    }
    zero(unit = 1): Uint8Array {
        const start = this.position;
        while (this.position + unit <= this.bytes.length) {
            const next = this.take(unit);
            if (next.every(byte => byte === 0)) return this.bytes.subarray(start, this.position - unit);
        }
        throw new Error('Unterminated dictionary key');
    }
}
function parseStarDict(files: DictionaryFile[]): ImportedDictionaryEntry[] {
    const infoFile = files.find(file => /\.ifo$/i.test(file.name));
    const idxFile = files.find(file => /\.idx(?:\.gz)?$/i.test(file.name));
    const dictFile = files.find(file => /\.dict(?:\.dz|\.gz)?$/i.test(file.name));
    if (!infoFile || !idxFile || !dictFile) throw new Error('Select the matching .ifo, .idx and .dict files together');
    const info = utf8.decode(infoFile.bytes);
    const sequence = /^sametypesequence=(.*)$/m.exec(info)?.[1].trim() || '';
    const width = /^idxoffsetbits=64\s*$/m.test(info) ? 8 : 4;
    const index = new Reader(/\.gz$/i.test(idxFile.name) ? inflateDictionary(idxFile.bytes) : idxFile.bytes);
    const dictionary = /\.(dz|gz)$/i.test(dictFile.name) ? inflateDictionary(dictFile.bytes, undefined, DICTIONARY_EXPANDED_BYTES - index.bytes.length) : dictFile.bytes;
    const entries: ImportedDictionaryEntry[] = [];
    while (index.position < index.bytes.length) {
        const word = utf8.decode(index.zero());
        const offset = index.number(width), length = index.number(4);
        const fields = new Reader(dictionary.subarray(offset, offset + length));
        if (offset + length > dictionary.length) throw new Error('Invalid StarDict offset');
        const parts: string[] = [];
        let phonetic = '';
        let fieldIndex = 0;
        while (fields.position < fields.bytes.length) {
            const type = sequence ? sequence[fieldIndex++] : String.fromCharCode(fields.take(1)[0]);
            const last = sequence && fieldIndex === sequence.length;
            const value = last ? fields.take(fields.bytes.length - fields.position) : /[A-Z]/.test(type) ? fields.take(fields.number(4)) : fields.zero();
            if (/[A-Z]/.test(type)) continue;
            const text = utf8.decode(value).replace(/\0$/, '');
            if (type === 't') phonetic = text;
            else parts.push(['h', 'g', 'x'].includes(type) ? text : escape(text).replaceAll('\n', '<br>'));
        }
        addEntry(entries, word, parts.join('<br>'), phonetic);
    }
    return entries;
}
function mdictBlock(bytes: Uint8Array, expected: number): Uint8Array {
    if (bytes.length < 8) throw new Error('Invalid MDict block');
    const method = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    const body = bytes.subarray(8);
    const result = method === 0 ? body : method === 2 ? inflateDictionary(body, expected) : method === 1 ? decompress(body, expected) : null;
    if (!result || result.length !== expected) throw new Error('Invalid MDict compression');
    return result;
}
function parseMdict(bytes: Uint8Array, media: boolean, limit = DICTIONARY_EXPANDED_BYTES): {keys: string[]; records: Uint8Array[]; encoding: string; expanded: number} {
    let expanded = 0;
    const block = (bytes: Uint8Array, size: number) => {
        expanded += size;
        if (expanded > limit) throw new Error('Dictionary decompression limit exceeded');
        return mdictBlock(bytes, size);
    };
    const reader = new Reader(bytes);
    const header = new TextDecoder('utf-16le', {fatal: true}).decode(reader.take(reader.number(4)));
    reader.take(4);
    const attribute = (name: string) => new RegExp(`${name}="([^"]*)"`, 'i').exec(header)?.[1] || '';
    const version = Number(attribute('GeneratedByEngineVersion'));
    if (!(version >= 1 && version < 3)) throw new Error('Unsupported MDict version');
    const encryption = attribute('Encrypted');
    if (encryption && !['0', 'No', '2'].includes(encryption)) throw new Error('Password-protected MDict dictionaries are not supported; use an unencrypted export or a local dictionary server');
    const width = version >= 2 ? 8 : 4;
    const encoding = media ? 'utf-16le' : attribute('Encoding') || 'utf-8';
    const decode = new TextDecoder(encoding, {fatal: true});
    const unit = /utf-?16/i.test(encoding) ? 2 : 1;
    const blockCount = reader.number(width), count = reader.number(width);
    if (count > DICTIONARY_ENTRY_LIMIT || blockCount > count) throw new Error('Too many dictionary entries');
    const infoDecodedSize = version >= 2 ? reader.number(width) : 0;
    const infoSize = reader.number(width), keyBlocksSize = reader.number(width);
    if (version >= 2) reader.take(4);
    const rawInfo = reader.take(infoSize);
    const infoBytes = encryption === '2' ? decodeMdictKeyInfo(rawInfo) : rawInfo;
    const info = new Reader(version >= 2 ? block(infoBytes, infoDecodedSize) : infoBytes);
    const keyBlocks = new Reader(reader.take(keyBlocksSize));
    const keys: string[] = [], offsets: number[] = [];
    for (let i = 0; i < blockCount; i++) {
        const size = info.number(width);
        for (let j = 0; j < 2; j++) {const length = info.number(version >= 2 ? 2 : 1); info.take((length + (version >= 2 ? 1 : 0)) * unit);}
        const compressed = info.number(width), expanded = info.number(width);
        const keyBlock = new Reader(block(keyBlocks.take(compressed), expanded));
        for (let j = 0; j < size; j++) {offsets.push(keyBlock.number(width)); keys.push(decode.decode(keyBlock.zero(unit)));}
    }
    if (keys.length !== count) throw new Error('MDict entry count mismatch');
    const recordBlockCount = reader.number(width), recordCount = reader.number(width), recordInfoSize = reader.number(width), recordsSize = reader.number(width);
    if (recordCount !== count || recordBlockCount > count || recordInfoSize !== recordBlockCount * width * 2) throw new Error('Invalid MDict record index');
    const recordInfo = new Reader(reader.take(recordInfoSize));
    const recordBlocks = new Reader(reader.take(recordsSize));
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (let i = 0; i < recordBlockCount; i++) {
        const compressed = recordInfo.number(width), expanded = recordInfo.number(width);
        total += expanded; if (total > DICTIONARY_EXPANDED_BYTES) throw new Error('Dictionary decompression limit exceeded');
        chunks.push(block(recordBlocks.take(compressed), expanded));
    }
    const all = new Uint8Array(total); let position = 0;
    for (const chunk of chunks) {all.set(chunk, position); position += chunk.length;}
    const records = offsets.map((offset, index) => {
        const end = offsets[index + 1] ?? total;
        if (offset > end || end > total) throw new Error('Invalid MDict record offset');
        return all.slice(offset, end);
    });
    return {keys, records, encoding, expanded};
}
function structuredYomitan(value: unknown): string {
    if (typeof value === 'string') return escape(value);
    if (Array.isArray(value)) return value.map(structuredYomitan).join('<br>');
    if (!value || typeof value !== 'object') return '';
    const item = value as Record<string, unknown>;
    if (item.tag === 'img' && typeof item.path === 'string') return `<img src="${escape(dictionaryResourcePath(item.path))}" alt="">`;
    return structuredYomitan(item.content);
}
async function parseYomitan(bytes: Uint8Array): Promise<ImportedDictionary> {
    const zip = await JSZip.loadAsync(bytes, {checkCRC32: false});
    const entries: ImportedDictionaryEntry[] = [], resources: ImportedDictionaryResource[] = [];
    let expanded = 0;
    const read = async (file: JSZip.JSZipObject) => {
        const chunks: Uint8Array[] = [];
        await new Promise<void>((resolve, reject) => {
            // JSZip 3.10.1 的浏览器流接口存在于运行时，但上游声明遗漏此只读方法。
            const stream = (file as unknown as {internalStream(type: 'uint8array'): {on(event: 'data', listener: (chunk: Uint8Array) => void): void; on(event: 'error', listener: (error: Error) => void): void; on(event: 'end', listener: () => void): void; pause(): void; resume(): void}}).internalStream('uint8array');
            stream.on('data', (chunk: Uint8Array) => {expanded += chunk.length; if (expanded > DICTIONARY_EXPANDED_BYTES) {stream.pause(); reject(new Error('Dictionary decompression limit exceeded'));} else chunks.push(chunk);});
            stream.on('error', reject); stream.on('end', resolve); stream.resume();
        });
        const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0)); let at = 0;
        for (const chunk of chunks) {result.set(chunk, at); at += chunk.length;}
        return result;
    };
    const index = zip.file('index.json');
    if (!index) throw new Error('Yomitan dictionary needs index.json');
    const metadata = JSON.parse(utf8.decode(await read(index)));
    let css = '';
    for (const file of Object.values(zip.files)) {
        if (file.dir || file.name === 'index.json') continue;
        if (/^term_bank_\d+\.json$/.test(file.name)) {
            const rows: unknown = JSON.parse(utf8.decode(await read(file)));
            if (!Array.isArray(rows)) throw new Error('Invalid Yomitan term bank');
            for (const row of rows) {
                if (!Array.isArray(row) || typeof row[0] !== 'string') throw new Error('Invalid Yomitan entry');
                const html = structuredYomitan(row[5]);
                for (const word of new Set([row[0], typeof row[1] === 'string' ? row[1] : ''])) {
                    addEntry(entries, word, html, typeof row[1] === 'string' ? row[1] : '');
                }
            }
        } else if (file.name === 'styles.css') css = utf8.decode(await read(file)).slice(0, 262144);
        else if (/\.(png|jpe?g|gif|webp|svg|mp3|ogg|wav|woff2?)$/i.test(file.name)) {
            if (resources.length >= 5000) throw new Error('Too many dictionary resources');
            resources.push({path: dictionaryResourcePath(file.name), bytes: await read(file)});
        }
    }
    return checkImportedDictionary({name: typeof metadata.title === 'string' ? metadata.title : 'Yomitan', format: 'Yomitan', entries, resources, css});
}
function checkImportedDictionary(dictionary: ImportedDictionary): ImportedDictionary {
    if (!dictionary.entries.length) throw new Error('No supported dictionary entries found');
    let bytes = dictionary.resources.reduce((sum, resource) => sum + resource.bytes.length, 0);
    const encoder = new TextEncoder();
    for (const item of dictionary.entries) {
        bytes += encoder.encode(item.html).length + encoder.encode(item.definition).length + encoder.encode(item.word).length;
        if (bytes > DICTIONARY_EXPANDED_BYTES) throw new Error('Dictionary index size limit exceeded');
    }
    return dictionary;
}
export async function parseDictionaryFiles(files: DictionaryFile[]): Promise<ImportedDictionary> {
    if (!files.length || files.length > 64 || files.reduce((sum, file) => sum + file.bytes.length, 0) > DICTIONARY_IMPORT_BYTES) throw new Error('Select dictionary files up to 128 MiB');
    const main = files.find(file => /\.(dsl(?:\.dz|\.gz)?|ifo|mdx|zip)$/i.test(file.name));
    if (!main) throw new Error('Select DSL, StarDict, MDX or Yomitan files');
    if (/\.zip$/i.test(main.name)) return parseYomitan(main.bytes);
    let entries: ImportedDictionaryEntry[], format: string;
    const resources: ImportedDictionaryResource[] = [];
    if (/\.dsl(?:\.dz|\.gz)?$/i.test(main.name)) {entries = parseDsl(/\.(dz|gz)$/i.test(main.name) ? inflateDictionary(main.bytes) : main.bytes); format = 'DSL';}
    else if (/\.ifo$/i.test(main.name)) {entries = parseStarDict(files); format = 'StarDict';}
    else {
        const mdict = parseMdict(main.bytes, false);
        let expanded = mdict.expanded;
        const decode = new TextDecoder(mdict.encoding, {fatal: true});
        entries = [];
        mdict.keys.forEach((word, index) => addEntry(entries, word, decode.decode(mdict.records[index]).replace(/\0+$/, '')));
        for (const file of files.filter(file => /\.mdd$/i.test(file.name))) {
            const media = parseMdict(file.bytes, true, DICTIONARY_EXPANDED_BYTES - expanded);
            expanded += media.expanded;
            media.keys.forEach((path, index) => resources.push({path: dictionaryResourcePath(path), bytes: media.records[index]}));
        }
        format = 'MDict';
    }
    for (const file of files) if (/\.(png|jpe?g|gif|webp|svg|mp3|ogg|wav|woff2?)$/i.test(file.name)) resources.push({path: dictionaryResourcePath(file.name), bytes: file.bytes});
    return checkImportedDictionary({name: main.name.replace(/\.(dsl(?:\.dz|\.gz)?|ifo|mdx)$/i, ''), format, entries, resources, css: files.filter(file => /\.css$/i.test(file.name)).map(file => utf8.decode(file.bytes)).join('\n').slice(0, 262144)});
}
