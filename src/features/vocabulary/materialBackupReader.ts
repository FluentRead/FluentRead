/**
 * @file src/features/vocabulary/materialBackupReader.ts
 * 文件职责：流式校验材料备份并为后台原子恢复生成有界分片。
 * 主要内容：保留 JSON 原始词法和重复键语义，三遍读取验证源文件与材料摘要，支持取消和顺序背压。
 * 模块边界：不写数据库、不打开端口、不提交材料；调用方须仅在完整发送成功后封存和提交。
 */
import {bytesToHex} from '@noble/hashes/utils';
import {MATERIAL_IMPORT_FRAME_BYTES, MATERIAL_IMPORT_MAX_FRAMES, MATERIAL_IMPORT_MAX_RECORD_BYTES} from './materialProtocol';
import type {Frame, Manifest} from './materialImportStage';
import {Lexer, Parser, RecordCollector, MAX_RECORDS, MAX_VERSION_TOKEN_BYTES, utf8Decoder, capacityError, hash} from './materialBackupJson';

const CHUNK_BYTES = 64 * 1024;
const MAX_RECORD_LENGTH = 0xffffffff;
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

type RecordPlan = {start: number; end: number; length: number};
type SourcePlan = {records: RecordPlan[]; fileDigest: string; size: number};
export type PreparedMaterialBackup = {readonly manifest: Manifest; readonly plan: SourcePlan};
type ReadOptions = {signal?: AbortSignal};

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
  const collector = new RecordCollector(), versionCollector = new RecordCollector(MAX_VERSION_TOKEN_BYTES, true);
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
