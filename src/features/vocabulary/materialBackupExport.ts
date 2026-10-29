/**
 * @file src/features/vocabulary/materialBackupExport.ts
 * 文件职责：按一致的材料库快照增量生成可恢复的本地备份。
 * 主要内容：逐条读取材料、按 JSON.stringify 的紧凑格式顺序转义字段并输出有界 UTF-8 块，结束前再次检查版本；取消、存储变化和序列化失败均不会生成完整尾部。
 * 模块边界：不安装消息监听或选择下载位置，不承担传输完整性和文件落盘；调用方必须校验完整传输并在失败时取消目标写入。单条记录仍由 IndexedDB 整体读取。
 */
import {MaterialError} from './materialModel';
import type {MaterialRepository} from './materialRepository';
import {MATERIAL_READ_FRAME_BYTES} from './materialReadTransport';
import {MATERIAL_IMPORT_FRAME_BYTES} from './materialProtocol';
import type {MaterialBackupExportStatistics} from './materialBackupExportProtocol';

type Repository = Pick<MaterialRepository, 'openSnapshot'|'readSnapshotRecord'|'checkSnapshot'>;
export interface MaterialBackupExportOptions {exportedAt?:number; signal?:AbortSignal; onStatistics?:(statistics:MaterialBackupExportStatistics)=>void}
const RECORD_START=Symbol('record-start'), RECORD_END=Symbol('record-end');

function check(signal?:AbortSignal):void {
    if (signal?.aborted) throw new DOMException('材料导出已取消', 'AbortError');
}

/** 在有限字符串片段中保持 JSON.stringify 的转义与未配对代理项语义。 */
function* quote(value:string):Generator<string> {
    yield '"';
    for (let start = 0; start < value.length;) {
        let end = Math.min(value.length,start + 4096);
        // 不能在合法代理对中间切开，否则两端会被 JSON.stringify 分别转义。
        const previous = value.charCodeAt(end - 1), next = value.charCodeAt(end);
        if (end < value.length && previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
        const quoted = JSON.stringify(value.slice(start,end));
        yield quoted.slice(1,-1);
        start = end;
    }
    yield '"';
}

/** JSON.stringify 在对象属性上略过 undefined、函数与 symbol，在数组中写 null。 */
function prepared(holder:Record<string,unknown>|unknown[], key:string):unknown {
    let value = (holder as Record<string,unknown>)[key];
    if (value !== null && (typeof value === 'object' || typeof value === 'bigint')) {
        const toJSON = (value as {toJSON?:unknown}).toJSON;
        if (typeof toJSON === 'function') value = toJSON.call(value,key);
    }
    if (value instanceof Number || value instanceof String || value instanceof Boolean) value = value.valueOf();
    if (typeof value === 'object' && value !== null && Object.prototype.toString.call(value) === '[object BigInt]') value = (value as {valueOf():unknown}).valueOf();
    return value;
}
function omitted(value:unknown):boolean {return value === undefined || typeof value === 'function' || typeof value === 'symbol';}

function* jsonValue(value:unknown, ancestors:Set<object>):Generator<string> {
    if (typeof value === 'string') {yield* quote(value); return;}
    if (value === null || typeof value !== 'object') {
        const token = JSON.stringify(value);
        if (token === undefined) throw new TypeError('无法序列化材料备份');
        yield token; return;
    }
    if (ancestors.has(value)) throw new TypeError('材料备份包含循环引用');
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            // JSON.stringify 快照数组长度，子元素的 toJSON 即使改变数组也不改变本次遍历范围。
            const length = value.length;
            yield '[';
            for (let index = 0; index < length; index++) {
                if (index) yield ',';
                const child = prepared(value,String(index));
                if (omitted(child)) yield 'null'; else yield* jsonValue(child,ancestors);
            }
            yield ']';
        } else {
            yield '{';
            let first = true;
            const object = value as Record<string,unknown>;
            for (const key of Object.keys(object)) {
                const child = prepared(object,key);
                if (omitted(child)) continue;
                if (!first) yield ',';
                first = false;
                yield* quote(key); yield ':'; yield* jsonValue(child,ancestors);
            }
            yield '}';
        }
    } finally {ancestors.delete(value);}
}

async function* tokens(repository:Repository, exportedAt:number, signal?:AbortSignal):AsyncGenerator<string|typeof RECORD_START|typeof RECORD_END> {
    check(signal);
    const snapshot = await repository.openSnapshot(signal);
    check(signal);
    yield `{"format":"fluentread-learning-materials","version":1,"exportedAt":${JSON.stringify(exportedAt)},"materials":[`;
    for (let index = 0; index < snapshot.ids.length; index++) {
        check(signal);
        const id = snapshot.ids[index];
        const record = await repository.readSnapshotRecord(snapshot,id,signal);
        check(signal);
        if (!record || record.id !== id) throw new MaterialError('storage-error','材料快照记录不存在');
        if (index) yield ',';
        yield RECORD_START;
        const key = String(index), holder:Record<string,unknown> = {[key]:record};
        const value = prepared(holder,key);
        if (omitted(value)) yield 'null'; else yield* jsonValue(value,new Set());
        yield RECORD_END;
    }
    check(signal);
    await repository.checkSnapshot(snapshot,signal);
    check(signal);
    yield ']}';
}

/** 紧凑 JSON 与 JSON.stringify(备份) 一致；原界面的两空格缩进仅影响展示空白。 */
export async function* streamMaterialBackup(repository:Repository, options:MaterialBackupExportOptions = {}):AsyncGenerator<Uint8Array> {
    const {signal} = options, exportedAt = options.exportedAt ?? Date.now();
    if (!Number.isFinite(exportedAt) || exportedAt < 0) throw new MaterialError('invalid-input','材料导出时间无效');
    const encoder = new TextEncoder(), buffer = new Uint8Array(MATERIAL_READ_FRAME_BYTES);
    let used = 0, recordSize:number|undefined;
    const statistics:MaterialBackupExportStatistics={records:0,recordBytes:0,maxRecordBytes:0,frames:0};
    for await (const token of tokens(repository,exportedAt,signal)) {
        check(signal);
        if(token===RECORD_START){recordSize=0;continue;}
        if(token===RECORD_END){
            const size=recordSize!;
            statistics.records++;statistics.recordBytes+=size;statistics.maxRecordBytes=Math.max(statistics.maxRecordBytes,size);
            statistics.frames+=Math.ceil(size/MATERIAL_IMPORT_FRAME_BYTES);recordSize=undefined;
            if(!Number.isSafeInteger(statistics.recordBytes)||!Number.isSafeInteger(statistics.frames))throw new MaterialError('limit-exceeded','材料备份统计超出安全范围');
            continue;
        }
        const encoded = encoder.encode(token);
        if(recordSize!==undefined){recordSize+=encoded.length;if(!Number.isSafeInteger(recordSize))throw new MaterialError('limit-exceeded','材料备份统计超出安全范围');}
        for (let offset = 0; offset < encoded.length;) {
            const length = Math.min(buffer.length-used,encoded.length-offset);
            buffer.set(encoded.subarray(offset,offset+length),used); used += length; offset += length;
            if (used === buffer.length) {yield buffer.slice(); used = 0; check(signal);}
        }
    }
    check(signal);
    if (used) yield buffer.slice(0,used);
    check(signal);
    options.onStatistics?.(statistics);
}
