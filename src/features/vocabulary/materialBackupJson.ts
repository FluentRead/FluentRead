/**
 * @file src/features/vocabulary/materialBackupJson.ts
 * 文件职责：增量校验材料备份 JSON，并独立收集记录边界、解码长度与版本摘要。
 * 主要内容：有界词法状态、格式与重复键语义、分块记录收集及完成性状态。
 * 模块边界：仅供备份读取器编排；不读取 Blob、不处理取消、不发送数据或写入存储。
 */
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {MATERIAL_IMPORT_MAX_RECORD_BYTES} from './materialProtocol';

const CAPTURE_LIMIT = 1024;
export const MAX_RECORDS = 10000;
// 此读取器只处理原有 20 MiB 路径之外的文件；限制异常元数据和嵌套，
// 避免单个未受信文件在 JSON.parse 或结构栈中占用无界内存。
export const MAX_VERSION_TOKEN_BYTES = 1024 * 1024;
const MAX_NESTING_DEPTH = 1024;
export const utf8Decoder = () => new TextDecoder('utf-8', {ignoreBOM: true});
const isWhite = (byte: number) => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
const isDigit = (byte: number) => byte >= 48 && byte <= 57;
const isHex = (byte: number) => isDigit(byte) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102);
const invalid = (): never => {throw new SyntaxError('备份文件不是有效的 JSON');};
export const capacityError = (message: string) => Object.assign(new Error(message), {name: 'MaterialBackupCapacityError'});
export const hash = () => sha256.create();

type Token = {type: string; start: number; end: number; raw: number[] | null};
type Metadata = {value?: unknown; oversize?: boolean; type?: string; start?: number; end?: number};
type StackEntry = {kind: 'object' | 'array'; state: string; isRoot: boolean; isMaterials: boolean; key?: unknown; recordStart?: number};

/** 在替换解码之前识别 ASCII 语法，逐字节校验转义和数字。 */
export class Lexer {
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
export class RecordCollector {
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
      // 超限值无法进入恢复协议；保留哨兵并继续验证全文，使后续重复键仍可覆盖它。
      // 未超限的版本数值需要完整摘要，以验证再次读取时未被修改。
      if (stop > start && row.length <= this.maxLength) {
        const text = row.decoder.decode(bytes.subarray(start - at, stop - at), {stream: true});
        if (text) {
          const encoded = this.encoder.encode(text); row.hash?.update(encoded); row.length += encoded.length;
          if (row.length > this.maxLength) row.length = this.maxLength + 1;
        }
      }
      // JSON 记录结束字节始终为 ASCII；不完整 UTF-8 已在遇到该字节时替换。
      if (row.end !== undefined && row.end <= end) {if (row.hash && row.length <= this.maxLength) row.digest = bytesToHex(row.hash.digest()); row.complete = true;}
    }
    this.pending = this.pending.filter(row => !row.complete);
  }
  get incomplete() {return this.pending.length > 0;}
}

export class Parser {
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
