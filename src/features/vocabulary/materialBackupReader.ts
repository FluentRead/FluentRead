/**
 * @file src/features/vocabulary/materialBackupReader.ts
 * 文件职责：流式校验材料备份并为后台原子恢复生成有界分片。
 * 主要内容：保留 JSON 原始词法和重复键语义，三遍读取验证源文件与材料摘要，支持取消和顺序背压。
 * 模块边界：不写数据库、不打开端口、不提交材料；调用方须仅在完整发送成功后封存和提交。
 */
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {MATERIAL_IMPORT_FRAME_BYTES, MATERIAL_IMPORT_MAX_FRAMES, MATERIAL_IMPORT_MAX_RECORD_BYTES} from './materialProtocol';
import type {Frame, Manifest} from './materialImportStage';

const CHUNK_BYTES = 64 * 1024;
const CAPTURE_LIMIT = 1024;
const MAX_RECORDS = 10000;
const MAX_RECORD_LENGTH = 0xffffffff;
// 此读取器只处理原有 20 MiB 路径之外的文件；限制异常元数据和嵌套，
// 避免单个未受信文件在 JSON.parse 或结构栈中占用无界内存。
const MAX_VERSION_TOKEN_BYTES = 1024 * 1024;
const MAX_NESTING_DEPTH = 1024;
const utf8Decoder = () => new TextDecoder('utf-8', {ignoreBOM: true});
const isWhite = (byte: number) => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
const isDigit = (byte: number) => byte >= 48 && byte <= 57;
const isHex = (byte: number) => isDigit(byte) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102);
const invalid = (): never => {throw new SyntaxError('备份文件不是有效的 JSON');};
const capacityError = (message: string) => Object.assign(new Error(message), {name: 'MaterialBackupCapacityError'});
const hash = () => sha256.create();
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

type Token = {type: string; start: number; end: number; raw: number[] | null};
type Metadata = {value?: unknown; oversize?: boolean; type?: string; start?: number; end?: number};
type RecordPlan = {start: number; end: number; length: number};
type SourcePlan = {records: RecordPlan[]; fileDigest: string; size: number};
export type PreparedMaterialBackup = {readonly manifest: Manifest; readonly plan: SourcePlan};
type ReadOptions = {signal?: AbortSignal};

type StackEntry = {kind: 'object' | 'array'; state: string; isRoot: boolean; isMaterials: boolean; key?: unknown; recordStart?: number};

/** 在替换解码之前识别 ASCII 语法，逐字节校验转义和数字。 */
class Lexer {
  private mode = 'default';
  private offset = 0;
  private bom: number[] = [];
  private bomDone = false;
  private raw: number[] | null = null;
  private start = 0;
  private num = '';
  private word: number[] = [];
  private wordAt = 0;
  private unicodeLeft = 0;
  constructor(private readonly emit: (token: Token) => void, private readonly begin: (offset: number, byte: number) => void) {}
  private capture(byte: number) {if (this.raw !== null) {if (this.raw.length < CAPTURE_LIMIT) this.raw.push(byte); else this.raw = null;}}
  private token(type: string, end: number) {this.emit({type, start: this.start, end, raw: this.raw}); this.mode = 'default'; this.raw = null;}
  feed(bytes: Uint8Array) {
    for (const byte of bytes) {
      const at = this.offset++;
      if (!this.bomDone) {
        this.bom.push(byte);
        const bom = [0xef, 0xbb, 0xbf];
        if (this.bom.every((value, i) => value === bom[i])) {
          if (this.bom.length === 3) {this.bomDone = true; this.bom = [];}
          continue;
        }
        this.bomDone = true;
        for (let i = 0; i < this.bom.length; i++) this.byte(this.bom[i], i);
        this.bom = [];
        continue;
      }
      this.byte(byte, at);
    }
  }
  private byte(byte: number, at: number): void {
    if (this.mode === 'number') {
      let next: string | undefined;
      switch (this.num) {
        case 'sign': if (byte === 48) next = 'zero'; else if (byte >= 49 && byte <= 57) next = 'int'; else invalid(); break;
        case 'zero': if (byte === 46) next = 'dot'; else if (byte === 69 || byte === 101) next = 'exp'; break;
        case 'int': if (isDigit(byte)) next = 'int'; else if (byte === 46) next = 'dot'; else if (byte === 69 || byte === 101) next = 'exp'; break;
        case 'dot': if (isDigit(byte)) next = 'frac'; else invalid(); break;
        case 'frac': if (isDigit(byte)) next = 'frac'; else if (byte === 69 || byte === 101) next = 'exp'; break;
        case 'exp': if (byte === 43 || byte === 45) next = 'expsign'; else if (isDigit(byte)) next = 'expdigits'; else invalid(); break;
        case 'expsign': if (isDigit(byte)) next = 'expdigits'; else invalid(); break;
        case 'expdigits': if (isDigit(byte)) next = 'expdigits'; break;
      }
      if (next) {this.num = next; this.capture(byte); return;}
      // 未完成的数字状态已在上面的状态转换中直接拒绝当前字节。
      this.token('number', at); this.byte(byte, at); return;
    }
    if (this.mode === 'literal') {
      if (byte !== this.word[this.wordAt++]) invalid();
      this.capture(byte);
      if (this.wordAt === this.word.length) this.token('literal', at + 1);
      return;
    }
    if (this.mode === 'string') {
      this.capture(byte);
      if (byte === 34) this.token('string', at + 1);
      else if (byte === 92) this.mode = 'escape';
      else if (byte < 32) invalid();
      return;
    }
    if (this.mode === 'escape') {
      this.capture(byte);
      if (byte === 117) {this.mode = 'unicode'; this.unicodeLeft = 4;}
      else if ([34, 92, 47, 98, 102, 110, 114, 116].includes(byte)) this.mode = 'string';
      else invalid();
      return;
    }
    if (this.mode === 'unicode') {
      this.capture(byte); if (!isHex(byte)) invalid();
      if (--this.unicodeLeft === 0) this.mode = 'string';
      return;
    }
    if (isWhite(byte)) return;
    this.start = at; this.raw = [byte];
    if (byte === 123 || byte === 91 || byte === 34 || byte === 45 || isDigit(byte) || byte === 116 || byte === 102 || byte === 110) this.begin(at, byte);
    if ('{}[]:,'.includes(String.fromCharCode(byte))) {this.token(String.fromCharCode(byte), at + 1); return;}
    if (byte === 34) {this.mode = 'string'; return;}
    if (byte === 45 || isDigit(byte)) {this.mode = 'number'; this.num = byte === 45 ? 'sign' : byte === 48 ? 'zero' : 'int'; return;}
    const word = byte === 116 ? 'true' : byte === 102 ? 'false' : byte === 110 ? 'null' : '';
    if (!word) invalid();
    this.mode = 'literal'; this.word = [...new TextEncoder().encode(word)]; this.wordAt = 1;
  }
  finish() {
    if (!this.bomDone && this.bom.length) for (let i = 0; i < this.bom.length; i++) this.byte(this.bom[i], i);
    if (this.mode === 'number' && ['zero', 'int', 'frac', 'expdigits'].includes(this.num)) this.token('number', this.offset);
    if (this.mode !== 'default') invalid();
  }
}

const scalar = (token: Token): Metadata => {
  if (!token.raw) return {oversize: true, type: token.type, start: token.start, end: token.end};
  return {value: JSON.parse(utf8Decoder().decode(Uint8Array.from(token.raw)))};
};

type CollectedRecord = {start: number; end?: number; hash?: ReturnType<typeof hash>; decoder: TextDecoder; length: number; digest?: string; complete: boolean};
class RecordCollector {
  private pending: CollectedRecord[] = [];
  values: CollectedRecord[] = [];
  private active?: CollectedRecord;
  private count = 0;
  private readonly encoder = new TextEncoder();
  constructor(private readonly maxLength = MATERIAL_IMPORT_MAX_RECORD_BYTES, private readonly hashToken = false) {}
  reset() {this.pending = []; this.values = []; this.active = undefined; this.count = 0;}
  start(at: number) {
    this.count++;
    if (this.count > MAX_RECORDS) {this.active = undefined; return;}
    const row: CollectedRecord = {start: at, hash: this.hashToken ? hash() : undefined, decoder: utf8Decoder(), length: 0, complete: false};
    this.values.push(row); this.pending.push(row); this.active = row;
  }
  end(at: number) {if (this.active) {this.active.end = at; this.active = undefined;}}
  process(bytes: Uint8Array, at: number) {
    const end = at + bytes.length;
    for (const row of this.pending) {
      const start = Math.max(at, row.start), stop = Math.min(end, row.end ?? end);
      // 超限材料已无法进入恢复协议；保留哨兵并继续验证全文，使后续重复键仍可覆盖它。
      // 版本数值另需完整摘要，不能跳过或饱和其解码。
      if (stop > start && (this.hashToken || row.length <= this.maxLength)) {
        const text = row.decoder.decode(bytes.subarray(start - at, stop - at), {stream: true});
        if (text) {
          const encoded = this.encoder.encode(text); row.hash?.update(encoded); row.length += encoded.length;
          if (!this.hashToken && row.length > this.maxLength) row.length = this.maxLength + 1;
        }
      }
      // JSON 记录结束字节始终为 ASCII；不完整 UTF-8 已在遇到该字节时替换。
      if (row.end !== undefined && row.end <= end) {if (row.hash) row.digest = bytesToHex(row.hash.digest()); row.complete = true;}
      // 版本 token 的上限为 MAX_SAFE_INTEGER；安全整数检查已包含超上限的情况。
      if (this.hashToken && !Number.isSafeInteger(row.length)) throw capacityError('材料记录超过恢复大小限制');
    }
    this.pending = this.pending.filter(row => !row.complete);
  }
  get incomplete() {return this.pending.length > 0;}
}

class Parser {
  private stack: StackEntry[] = [];
  private root = 'value';
  private rootObject = false;
  private format: Metadata = {};
  version: Metadata = {};
  private materialsValid = false;
  private records: Array<{start: number; end: number}> = [];
  private recordCount = 0;
  constructor(private readonly collector: RecordCollector, private readonly versionCollector: RecordCollector) {}
  begin(at: number, byte: number) {
    const top = this.stack.at(-1);
    if (top?.isMaterials && ['value', 'valueOrEnd'].includes(top.state)) this.collector.start(at);
    if (top?.isRoot && top.key === 'version' && top.state === 'value') {
      this.versionCollector.reset();
      if (byte === 45 || isDigit(byte)) this.versionCollector.start(at);
    }
  }
  token(t: Token): void {
    const top = this.stack.at(-1);
    if (top?.kind === 'object' && (top.state === 'keyOrEnd' || top.state === 'key')) {
      if (t.type === '}' && top.state === 'keyOrEnd') return this.close(t);
      if (t.type !== 'string') invalid();
      top.key = t.raw ? scalar(t).value : undefined; top.state = 'colon'; return;
    }
    if (top?.kind === 'object' && top.state === 'colon') {if (t.type !== ':') invalid(); top.state = 'value'; return;}
    if (top && top.state === 'commaOrEnd') {
      if (t.type === (top.kind === 'array' ? ']' : '}')) return this.close(t);
      if (t.type !== ',') invalid(); top.state = top.kind === 'array' ? 'value' : 'key'; return;
    }
    if (top?.kind === 'array' && top.state === 'valueOrEnd' && t.type === ']') return this.close(t);
    if ((top && !['value', 'valueOrEnd'].includes(top.state)) || (!top && this.root !== 'value')) invalid();
    const isCompound = t.type === '{' || t.type === '[';
    if (!isCompound && !['string', 'number', 'literal'].includes(t.type)) invalid();
    const isRoot = !top, isRecord = !!top?.isMaterials, key = top?.isRoot ? top.key : undefined;
    if (isRoot) {this.rootObject = t.type === '{'; this.root = 'pending';}
    if (top) top.state = 'commaOrEnd';
    if (key === 'materials') {this.materialsValid = t.type === '['; this.records = []; this.recordCount = 0; this.collector.reset();}
    if (key === 'format' || key === 'version') {
      this[key] = isCompound ? {} : scalar(t);
      if (key === 'version' && t.type === 'number') this.versionCollector.end(t.end);
    }
    if (isRecord) this.recordCount++;
    if (isCompound) {
      if (this.stack.length >= MAX_NESTING_DEPTH) throw capacityError('备份文件嵌套层级超过恢复限制');
      this.stack.push({kind: t.type === '{' ? 'object' : 'array', state: t.type === '{' ? 'keyOrEnd' : 'valueOrEnd', isRoot, isMaterials: key === 'materials' && t.type === '[', recordStart: isRecord ? t.start : undefined});
    } else {
      if (isRecord) {if (this.recordCount <= MAX_RECORDS) this.records.push({start: t.start, end: t.end}); this.collector.end(t.end);}
      if (isRoot) this.root = 'done';
    }
  }
  private close(t: Token) {
    // 只有 token() 验证了栈顶种类和结束符之后才会调用。
    const top = this.stack.pop()!;
    if (top.recordStart !== undefined) {if (this.recordCount <= MAX_RECORDS) this.records.push({start: top.recordStart, end: t.end}); this.collector.end(t.end);}
    if (top.isRoot) this.root = 'done';
  }
  finish() {
    if (this.stack.length || this.root !== 'done') invalid();
    if (!this.rootObject || this.format.oversize || this.format.value !== 'fluentread-learning-materials' || (!this.version.oversize && this.version.value !== 1) || !this.materialsValid || this.recordCount > MAX_RECORDS) throw Error('不支持的材料备份格式或超过材料上限');
    return this.records;
  }
}

const cancelled = () => Object.assign(new Error('材料恢复已取消'), {name: 'AbortError'});
function check(signal?: AbortSignal) {if (signal?.aborted) throw cancelled();}
function wait<T>(value: T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  const work = Promise.resolve(value);
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => {try {signal.removeEventListener('abort', onAbort);} catch {/* Preserve the observed result. */}};
    const finish = (ok: boolean, result: T | unknown) => {if (done) return; done = true; cleanup(); if (ok) resolve(result as T); else reject(result);};
    const onAbort = () => finish(false, cancelled());
    // Observe the read even when listener registration fails or cancellation wins.
    void work.then(result => finish(true, result), error => finish(false, error));
    try {
      if (signal.aborted) {onAbort(); return;}
      try {signal.addEventListener('abort', onAbort, {once: true});}
      catch (error) {
        if (done) {cleanup(); return;}
        let aborted = false;
        try {aborted = signal.aborted;} catch {/* Preserve the registration failure. */}
        finish(false, aborted ? cancelled() : error);
        return;
      }
      // A custom signal can synchronously cancel before actually adding the listener.
      if (done) {cleanup(); return;}
      if (signal.aborted) onAbort();
    } catch (error) {finish(false, error);}
  });
}
async function yieldControl(signal?: AbortSignal) {await wait(new Promise<void>(resolve => setTimeout(resolve, 0)), signal); check(signal);}
async function slice(blob: Blob, start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
  check(signal);
  const bytes = new Uint8Array(await wait(blob.slice(start, end).arrayBuffer(), signal));
  check(signal);
  if (bytes.length !== end - start) throw Error('备份文件读取长度改变');
  return bytes;
}

async function inspect(blob: Blob, signal?: AbortSignal): Promise<SourcePlan> {
  if (!(blob instanceof Blob)) throw TypeError('无效的备份文件');
  const size = blob.size;
  if (!Number.isSafeInteger(size) || size < 0) throw TypeError('无效的备份文件');
  const collector = new RecordCollector(), versionCollector = new RecordCollector(Number.MAX_SAFE_INTEGER, true);
  const parser = new Parser(collector, versionCollector), lexer = new Lexer(token => parser.token(token), (at, byte) => parser.begin(at, byte)), sourceHash = hash();
  check(signal);
  for (let at = 0; at < size; at += CHUNK_BYTES) {
    const bytes = await slice(blob, at, Math.min(size, at + CHUNK_BYTES), signal);
    sourceHash.update(bytes); lexer.feed(bytes); collector.process(bytes, at); versionCollector.process(bytes, at);
    if ((at / CHUNK_BYTES + 1) % 16 === 0) await yieldControl(signal);
  }
  if (blob.size !== size) throw Error('备份文件在读取过程中改变');
  lexer.finish(); const records = parser.finish();
  if (parser.version.oversize) {
    const {type, start, end} = parser.version;
    if (type !== 'number' || start === undefined || end === undefined) throw Error('不支持的材料备份格式或超过材料上限');
    if (end - start > MAX_VERSION_TOKEN_BYTES) throw capacityError('备份版本字段超过恢复大小限制');
    const pieces: string[] = [], tokenHash = hash();
    for (let at = start; at < end; at += CHUNK_BYTES) {
      const bytes = await slice(blob, at, Math.min(end, at + CHUNK_BYTES), signal);
      tokenHash.update(bytes); pieces.push(new TextDecoder().decode(bytes));
      if ((Math.floor((at - start) / CHUNK_BYTES) + 1) % 16 === 0) await yieldControl(signal);
    }
    const expected = versionCollector.values[0];
    if (!expected || expected.digest !== bytesToHex(tokenHash.digest()) || expected.length !== end - start) throw Error('备份文件在读取过程中改变');
    const text = pieces.join(''); check(signal);
    if (JSON.parse(text) !== 1) throw Error('不支持的材料备份格式或超过材料上限');
  }
  check(signal);
  if (blob.size !== size) throw Error('备份文件在读取过程中改变');
  if (collector.incomplete || collector.values.length !== records.length) throw Error('材料记录不完整');
  return {records: records.map((record, index) => {
    const row = collector.values[index];
    return {...record, length: row.length};
  }), fileDigest: bytesToHex(sourceHash.digest()), size};
}

type Visitor = {start(index: number): void | Promise<void>; chunk(bytes: Uint8Array, index: number): void | Promise<void>; end(index: number): void | Promise<void>};
async function traverse(blob: Blob, input: SourcePlan, visitor: Visitor, signal?: AbortSignal): Promise<void> {
  check(signal);
  // 此处只接收 inspect 的结果或 sendMaterialBackup 的有界快照。
  const {size, fileDigest} = input;
  if (!Number.isSafeInteger(size) || size < 0 || typeof fileDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(fileDigest)) throw TypeError('无效的备份计划');
  let lastEnd = 0;
  const records = input.records.map(row => {
    const {start, end, length} = row;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < lastEnd || end <= start || end > size || !Number.isSafeInteger(length) || length < 1 || length > MAX_RECORD_LENGTH) throw TypeError('无效的备份计划');
    lastEnd = end; return {start, end, length};
  });
  if (!(blob instanceof Blob) || blob.size !== size) throw Error('备份文件在读取过程中改变');
  const sourceHash = hash(), encoder = new TextEncoder(); let index = 0, decoder: TextDecoder | undefined;
  for (let at = 0; at < size; at += CHUNK_BYTES) {
    const bytes = await slice(blob, at, Math.min(size, at + CHUNK_BYTES), signal); sourceHash.update(bytes);
    while (index < records.length && records[index].start < at + bytes.length) {
      const record = records[index];
      if (!decoder) {decoder = utf8Decoder(); await wait(visitor.start(index), signal); check(signal);}
      const start = Math.max(record.start, at) - at, end = Math.min(record.end, at + bytes.length) - at;
      if (end > start) {const text = decoder.decode(bytes.subarray(start, end), {stream: true}); if (text) {await wait(visitor.chunk(encoder.encode(text), index), signal); check(signal);}}
      if (record.end > at + bytes.length) break;
      const tail = decoder.decode(); if (tail) {await wait(visitor.chunk(encoder.encode(tail), index), signal); check(signal);}
      await wait(visitor.end(index), signal); check(signal); decoder = undefined; index++;
    }
    if ((at / CHUNK_BYTES + 1) % 16 === 0) await yieldControl(signal);
  }
  check(signal);
  if (index !== records.length || bytesToHex(sourceHash.digest()) !== fileDigest || blob.size !== size) throw Error('备份文件在读取过程中改变');
}

/** 前两遍完整检查和计算 stage 使用的原始记录摘要。 */
export async function prepareMaterialBackup(blob: Blob, options: ReadOptions = {}): Promise<PreparedMaterialBackup> {
  const signal = options.signal, plan = await inspect(blob, signal), lengths = plan.records.map(record => record.length);
  const bytes = lengths.reduce((a, b) => a + b, 0), frames = lengths.reduce((a, b) => a + Math.ceil(b / MATERIAL_IMPORT_FRAME_BYTES), 0);
  // 帧数及单条上限是协议边界；设备可用暂存额度由后台在事务中判断。
  if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(frames) || frames > MATERIAL_IMPORT_MAX_FRAMES || lengths.some(length => length > MATERIAL_IMPORT_MAX_RECORD_BYTES)) throw capacityError('材料备份超过当前恢复容量限制');
  const digest = hash();
  await traverse(blob, plan, {start(index) {digest.update(u32(lengths[index]));}, chunk(data) {digest.update(data);}, end() {}}, signal);
  return {plan, manifest: {records: lengths.length, bytes, frames, digest: bytesToHex(digest.digest())}};
}

/** 第三遍发送后核验整个文件；失败时调用方不得封存或提交。 */
export async function sendMaterialBackup(blob: Blob, prepared: PreparedMaterialBackup, emit: (frame: Frame) => Promise<unknown>, options: ReadOptions = {}): Promise<void> {
  if (!prepared || typeof prepared !== 'object' || typeof emit !== 'function') throw TypeError('无效的备份计划');
  const {plan: sourcePlan, manifest} = prepared;
  if (!sourcePlan || !manifest || typeof manifest !== 'object') throw TypeError('无效的备份计划');
  const {size, fileDigest, records: sourceRecords} = sourcePlan;
  // 在复制或读取记录前拒绝过量计划，稀疏数组也不能绕过逐项校验。
  if (!Array.isArray(sourceRecords)) throw TypeError('无效的备份计划');
  const recordCount = sourceRecords.length;
  if (!Number.isSafeInteger(recordCount) || recordCount < 0 || recordCount > MAX_RECORDS) throw TypeError('无效的备份计划');
  const recordsSnapshot: RecordPlan[] = [];
  for (let i = 0; i < recordCount; i++) {
    const record = sourceRecords[i];
    if (!record || typeof record !== 'object') throw TypeError('无效的备份计划');
    const {start, end, length} = record; recordsSnapshot.push({start, end, length});
  }
  const plan = {size, fileDigest, records: recordsSnapshot};
  const {records, bytes, frames, digest: expectedDigest} = manifest, lengths = recordsSnapshot.map(record => record.length);
  if (records !== lengths.length || lengths.some(n => !Number.isSafeInteger(n) || n < 1 || n > MATERIAL_IMPORT_MAX_RECORD_BYTES) ||
    !Number.isSafeInteger(bytes) || bytes !== lengths.reduce((a, b) => a + b, 0) || !Number.isSafeInteger(frames) || frames !== lengths.reduce((a, b) => a + Math.ceil(b / MATERIAL_IMPORT_FRAME_BYTES), 0) ||
    frames > MATERIAL_IMPORT_MAX_FRAMES ||
    typeof expectedDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(expectedDigest)) throw TypeError('无效的备份计划');
  const digest = hash(); let frame = new Uint8Array(MATERIAL_IMPORT_FRAME_BYTES), used = 0, part = 0, seq = 0, recordBytes = 0;
  const signal = options.signal;
  await traverse(blob, plan, {
    start(index) {digest.update(u32(lengths[index])); frame = new Uint8Array(MATERIAL_IMPORT_FRAME_BYTES); used = 0; part = 0; recordBytes = 0;},
    async chunk(data, index) {
      digest.update(data); recordBytes += data.length; let at = 0;
      if (recordBytes > lengths[index]) throw Error('材料记录在读取过程中改变');
      while (at < data.length) {
        const count = Math.min(data.length - at, MATERIAL_IMPORT_FRAME_BYTES - used); frame.set(data.subarray(at, at + count), used); at += count; used += count;
        if (used === MATERIAL_IMPORT_FRAME_BYTES) {await wait(emit({seq: seq++, record: index, part: part++, total: Math.ceil(lengths[index] / MATERIAL_IMPORT_FRAME_BYTES), recordBytes: lengths[index], bytes: frame}), signal); check(signal); frame = new Uint8Array(MATERIAL_IMPORT_FRAME_BYTES); used = 0;}
      }
    },
    async end(index) {
      if (recordBytes !== lengths[index]) throw Error('材料记录在读取过程中改变');
      if (used) await wait(emit({seq: seq++, record: index, part: part++, total: Math.ceil(lengths[index] / MATERIAL_IMPORT_FRAME_BYTES), recordBytes: lengths[index], bytes: frame.slice(0, used)}), signal);
    },
  }, signal);
  if (seq !== frames || bytesToHex(digest.digest()) !== expectedDigest) throw Error('材料记录在读取过程中改变');
}
