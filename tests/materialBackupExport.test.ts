/**
 * @file tests/materialBackupExport.test.ts
 * 文件职责：验证材料备份流的 JSON 兼容性、快照一致性和取消边界。
 * 主要内容：比较原有紧凑 JSON 的字节顺序，覆盖 Unicode、稀疏数组、数值与不可序列化数据，验证有界分块和不同连接写入后的失效。
 * 模块边界：使用模拟和 fake-indexeddb，不验证浏览器端口、磁盘保存或真实浏览器资源占用。
 */
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {MaterialDatabase, MaterialRepository} from '@/src/features/vocabulary/materialRepository';
import {streamMaterialBackup} from '@/src/features/vocabulary/materialBackupExport';
import {MATERIAL_READ_FRAME_BYTES} from '@/src/features/vocabulary/materialReadTransport';
import {prepareMaterialBackup, sendMaterialBackup} from '@/src/features/vocabulary/materialBackupReader';
import {createStage} from '@/src/features/vocabulary/materialImportStage';
import {createMaterialImportCapability} from '@/src/features/vocabulary/materialImportPort';
import type {MaterialRecord} from '@/src/features/vocabulary/materialProtocol';
import type {MaterialBackupExportStatistics} from '@/src/features/vocabulary/materialBackupExportProtocol';

let serial = 0;
const databases:MaterialDatabase[] = [];
function database():MaterialDatabase {
    const db = new MaterialDatabase(`material-export-${++serial}`); databases.push(db); return db;
}
afterEach(async () => {
    const opened = databases.splice(0), names = new Set(opened.map(db=>db.name));
    for (const db of opened) db.close();
    for (const name of names) await Dexie.delete(name);
});
function record(id:string, extras:Record<string,unknown> = {}):MaterialRecord {
    return {id,identityKey:`article:https://example.test/${id}`,kind:'article',title:id,
        source:{kind:'article',url:`https://example.test/${id}`},topics:[],references:[],
        createdAt:1,updatedAt:2,lastReadAt:3,archivedAt:null,...extras} as MaterialRecord;
}
function fake(records:MaterialRecord[]) {
    const map = new Map(records.map(item=>[item.id,item]));
    return {openSnapshot:vi.fn(async()=>({revision:3,epoch:'test-epoch',ids:[...map.keys()]})),
        readSnapshotRecord:vi.fn(async (_revision:{revision:number;epoch:string},id:string)=>map.get(id) ?? null),
        checkSnapshot:vi.fn(async()=>{})};
}
async function collect(source:AsyncIterable<Uint8Array>):Promise<Uint8Array> {
    const chunks:Uint8Array[] = []; let total = 0;
    for await (const chunk of source) {expect(chunk.byteLength).toBeGreaterThan(0);expect(chunk.byteLength).toBeLessThanOrEqual(MATERIAL_READ_FRAME_BYTES);chunks.push(chunk);total += chunk.byteLength;}
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) {bytes.set(chunk,offset);offset += chunk.byteLength;}
    return bytes;
}
const text = (bytes:Uint8Array) => new TextDecoder('utf-8',{fatal:true}).decode(bytes);
const backup = (materials:MaterialRecord[],exportedAt=123) => ({format:'fluentread-learning-materials',version:1,exportedAt,materials});

describe('streamed material backup', () => {
    it('matches compact JSON.stringify bytes, preserving fields and property order', async () => {
        const records = [record('one',{extra:{value:'中文😀\ud800\udc00\ud800',missing:undefined,empty:null},
            locator:{kind:'text',quote:'" \\ \n \t \u0001'}, topics:['one','two'],
            references:[{kind:'note',id:'n',excerpt:'hello',note:'world',createdAt:1}]}),record('two')];
        const repo = fake(records);
        const output = text(await collect(streamMaterialBackup(repo,{exportedAt:123})));
        expect(output).toBe(JSON.stringify(backup(records)));
        expect(JSON.parse(output)).toEqual(JSON.parse(JSON.stringify(backup(records))));
        expect(JSON.parse(output)).toEqual(JSON.parse(JSON.stringify(backup(records),null,2)));
        expect(repo.openSnapshot).toHaveBeenCalledOnce();expect(repo.checkSnapshot).toHaveBeenCalledOnce();
        expect(repo.readSnapshotRecord.mock.calls.map(call=>call[1])).toEqual(['one','two']);
    });
    it('matches object omission, sparse arrays, numbers, toJSON, boxed values and typed arrays', async () => {
        const sparse:unknown[] = [];sparse.length=4;sparse[0]=undefined;sparse[2]=Infinity;sparse[3]=Symbol('value');
        const records = [record('a',{extra:{sparse,number:NaN,minusZero:-0,date:new Date('2020-01-02T00:00:00Z'),
            boxed:new Number(3),typed:new Uint8Array([1,2]),object:{drop:undefined,symbol:Symbol('x')},
            custom:{toJSON:(key:string)=>({key,chosen:true})}}}),record('b',{toJSON:(key:string)=>({id:'b',key})}),
            record('c',{toJSON:()=>undefined})];
        const output = text(await collect(streamMaterialBackup(fake(records),{exportedAt:123})));
        expect(output).toBe(JSON.stringify(backup(records)));
    });
    it.each(['append','shrink'] as const)('uses the original array length when toJSON can %s it',async operation=>{
        const make=()=>{
            const values:unknown[]=[];
            values.push({toJSON(){if(operation==='append')values.push('late');else values.length=1;return 'first';}},'second');
            return [record('array',{extra:values})];
        };
        const expected=JSON.stringify(backup(make()));
        expect(text(await collect(streamMaterialBackup(fake(make()),{exportedAt:123})))).toBe(expected);
    });
    it('handles Unicode and escaping across string and frame boundaries without splitting encoded output', async () => {
        const value = 'a'.repeat(4095) + '😀' + ('\ud800' + '\udc00' + '😀' + '\ud800' + '\udfff' + '\udc00' + '"\\\n' + '长').repeat(4000);
        const records = [record('unicode',{references:[{kind:'note',id:'n',note:value}]})];
        const output = text(await collect(streamMaterialBackup(fake(records),{exportedAt:123})));
        expect(output).toBe(JSON.stringify(backup(records)));
        expect(JSON.parse(output).materials[0].references[0].note).toBe(value);
    });
    it('serializes large references in bounded chunks without stringifying a whole record or library', async () => {
        const note = '甲\ud800'.repeat(6000);
        const records = [record('large',{references:Array.from({length:1000},(_,i)=>({kind:'note',id:String(i),note}))})];
        const repo = fake(records), digest = sha256.create();let bytes=0,chunks=0;
        const stringify = JSON.stringify;
        const spy = vi.spyOn(JSON,'stringify').mockImplementation(((value:unknown,...args:unknown[])=>{
            if (value === records[0] || value === records || value === records[0].references) throw Error('unbounded serialization');
            return stringify(value,...args as []) as never;
        }) as typeof JSON.stringify);
        try {
            for await (const chunk of streamMaterialBackup(repo,{exportedAt:123})) {expect(chunk.length).toBeLessThanOrEqual(MATERIAL_READ_FRAME_BYTES);digest.update(chunk);bytes+=chunk.length;chunks++;}
        } finally {spy.mockRestore();}
        const expected = new TextEncoder().encode(stringify(backup(records)));
        expect(chunks).toBeGreaterThan(100);expect(bytes).toBe(expected.length);
        expect(bytesToHex(digest.digest())).toBe(bytesToHex(sha256(expected)));
    },30_000);
    it('checks revision even for an empty library and returns valid empty JSON', async () => {
        const repo = fake([]), output = text(await collect(streamMaterialBackup(repo,{exportedAt:123})));
        expect(output).toBe(JSON.stringify(backup([])));expect(repo.checkSnapshot).toHaveBeenCalledWith({revision:3,epoch:'test-epoch',ids:[]},undefined);
    });
    it('rejects invalid time, missing records, cyclic objects and BigInt without a complete result', async () => {
        await expect(collect(streamMaterialBackup(fake([]),{exportedAt:NaN}))).rejects.toMatchObject({code:'invalid-input'});
        await expect(collect(streamMaterialBackup(fake([]),{exportedAt:-1}))).rejects.toMatchObject({code:'invalid-input'});
        const missing = fake([record('a')]);missing.readSnapshotRecord.mockResolvedValueOnce(null);
        await expect(collect(streamMaterialBackup(missing,{exportedAt:1}))).rejects.toMatchObject({code:'storage-error'});
        const cycle:Record<string,unknown> = {};cycle.self = cycle;
        await expect(collect(streamMaterialBackup(fake([record('a',{cycle})]),{exportedAt:1}))).rejects.toThrow('循环引用');
        await expect(collect(streamMaterialBackup(fake([record('a',{big:1n})]),{exportedAt:1}))).rejects.toBeInstanceOf(TypeError);
        await expect(collect(streamMaterialBackup(fake([record('a',{big:Object(1n)})]),{exportedAt:1}))).rejects.toBeInstanceOf(TypeError);
    });
    it('fails closed without reporting statistics if a serializer unexpectedly returns no token', async () => {
        const sentinel=19_790_317, stringify=JSON.stringify, report=vi.fn();
        const repo=fake([record('serializer-failure',{extra:{prefix:'x'.repeat(MATERIAL_READ_FRAME_BYTES+1024),value:sentinel}})]);
        const emitted:Uint8Array[]=[];
        // Simulate a modified serializer; standard JSON.stringify does not return undefined for this number.
        const spy=vi.spyOn(JSON,'stringify').mockImplementation(((value:unknown,...args:unknown[])=>{
            if(value===sentinel)return undefined;
            return stringify(value,...args as []);
        }) as typeof JSON.stringify);
        try {
            const drain=async()=>{for await(const chunk of streamMaterialBackup(repo,{exportedAt:1,onStatistics:report}))emitted.push(chunk);};
            await expect(drain()).rejects.toThrow('无法序列化材料备份');
            expect(emitted.length).toBeGreaterThan(0);
            const partial=new Uint8Array(emitted.reduce((sum,chunk)=>sum+chunk.length,0));
            let offset=0;for(const chunk of emitted){partial.set(chunk,offset);offset+=chunk.length;}
            expect(()=>JSON.parse(text(partial))).toThrow(SyntaxError);
            expect(repo.checkSnapshot).not.toHaveBeenCalled();
            expect(report).not.toHaveBeenCalled();
        } finally {spy.mockRestore();}
    });
    it('uses the current time by default', async () => {
        const now=vi.spyOn(Date,'now').mockReturnValue(456);
        try {expect(text(await collect(streamMaterialBackup(fake([]))))).toBe(JSON.stringify(backup([],456)));}
        finally {now.mockRestore();}
    });
    it('aborts before open, during an in-flight read, and after a yielded frame', async () => {
        const before = new AbortController();before.abort();const unused = fake([]);
        await expect(collect(streamMaterialBackup(unused,{signal:before.signal}))).rejects.toMatchObject({name:'AbortError'});
        expect(unused.openSnapshot).not.toHaveBeenCalled();
        let finish!:(item:MaterialRecord|null)=>void, started!:()=>void;
        const waiting = new Promise<MaterialRecord|null>(resolve=>{finish=resolve;}), began = new Promise<void>(resolve=>{started=resolve;});
        const repo = fake([record('a')]);repo.readSnapshotRecord.mockImplementationOnce(()=>{started();return waiting;});
        const signal = new AbortController(), pending = collect(streamMaterialBackup(repo,{signal:signal.signal}));
        const result = pending.catch(error=>error);await began;signal.abort();finish(record('a'));
        await expect(result).resolves.toMatchObject({name:'AbortError'});
        const large = fake([record('large',{references:[{kind:'note',id:'n',note:'x'.repeat(100_000)}]})]);
        const controller = new AbortController(), stream = streamMaterialBackup(large,{signal:controller.signal});
        expect((await stream.next()).value?.length).toBe(MATERIAL_READ_FRAME_BYTES);
        controller.abort();await expect(stream.next()).rejects.toMatchObject({name:'AbortError'});
    });
    it('fails if a second connection modifies materials during the stream', async () => {
        const db = database(), other = new MaterialDatabase(db.name);databases.push(other);
        const repo = new MaterialRepository(db), peer = new MaterialRepository(other);
        const first = await repo.capture({source:{kind:'article',url:'https://example.test/first'},capturedAt:1},1);
        await repo.capture({source:{kind:'article',url:'https://example.test/second'},capturedAt:2},2);
        const source = streamMaterialBackup(repo,{exportedAt:3});
        const open = vi.spyOn(repo,'readSnapshotRecord').mockImplementationOnce(async (...args)=>{
            const result = await MaterialRepository.prototype.readSnapshotRecord.apply(repo,args);
            await peer.update(first.id,{title:'changed'},10);return result;
        });
        try {await expect(collect(source)).rejects.toMatchObject({code:'stale-operation'});} finally {open.mockRestore();}
    });
    it('does not complete a backup after another connection recreates state at the same revision', async () => {
        const db=database(),other=new MaterialDatabase(db.name);databases.push(other);
        const repo=new MaterialRepository(db),peer=new MaterialRepository(other),report=vi.fn();
        const item=await repo.capture({source:{kind:'article',url:'https://example.test/state-loss'},capturedAt:1},1);
        const read=vi.spyOn(repo,'readSnapshotRecord').mockImplementationOnce(async (...args)=>{
            const result=await MaterialRepository.prototype.readSnapshotRecord.apply(repo,args);
            await other.meta.delete('state');await peer.update(item.id,{title:'changed'},10);
            expect(await peer.revision()).toBe(args[0].revision);
            return result;
        });
        try {await expect(collect(streamMaterialBackup(repo,{exportedAt:3,onStatistics:report}))).rejects.toMatchObject({code:'stale-operation'});}
        finally {read.mockRestore();}
        expect(report).not.toHaveBeenCalled();
    });
    it('round trips the streamed backup through the production reader and atomic staging repository', async () => {
        const sourceDb=database(), source=new MaterialRepository(sourceDb);
        const first=await source.capture({source:{kind:'article',url:'https://example.test/one'},
            reference:{kind:'note',id:'n',excerpt:'原句😀',note:'笔记\ud800'},capturedAt:10},10);
        await source.update(first.id,{topics:['主题']},11);
        await source.capture({source:{kind:'video',url:'https://example.test/two'},
            locator:{kind:'video',startMs:1200,quote:'片段'},capturedAt:12},12);
        const bytes=await collect(streamMaterialBackup(source,{exportedAt:100}));
        const file=new Blob([bytes.buffer as ArrayBuffer],{type:'application/json'});
        const plan=await prepareMaterialBackup(file), targetDb=database(), target=new MaterialRepository(targetDb);
        const stage=createStage(targetDb,{clock:()=>100}), capability=createMaterialImportCapability();
        await stage.beginRecoverable(plan.manifest,{generation:0,capturedAt:100},capability,{deadline:1000});
        await sendMaterialBackup(file,plan,async frame=>{await stage.append(capability,frame);});
        await stage.seal(capability);
        expect(await stage.commit(capability)).toEqual({inserted:2,updated:0,skipped:0});
        const original=(await source.exportData(100)).materials.sort((a,b)=>a.id.localeCompare(b.id));
        const restored=(await target.exportData(100)).materials.sort((a,b)=>a.id.localeCompare(b.id));
        // 现有恢复路径为缺省 aliases/locator 显式补充空值；其他字段须一致。
        expect(restored).toEqual(original.map(item=>({...item,aliases:item.aliases ?? [],locator:item.locator})));
    });
    it('counts exact UTF-8 record sizes and per-record frames in the same way as the restore reader',async()=>{
        const records=[record('unicode',{title:'😀长\ud800',references:[{kind:'note',id:'one',note:'甲😀"\\'.repeat(18_000)}]}),
            record('ascii',{references:[{kind:'note',id:'two',note:'x'.repeat(132_000)}]})];
        let statistics:MaterialBackupExportStatistics|undefined;
        const bytes=await collect(streamMaterialBackup(fake(records),{exportedAt:123,onStatistics:value=>{statistics=value;}}));
        const plan=await prepareMaterialBackup(new Blob([bytes.buffer as ArrayBuffer]));
        const lengths=records.map(value=>new TextEncoder().encode(JSON.stringify(value)).length);
        expect(statistics).toEqual({records:2,recordBytes:plan.manifest.bytes,maxRecordBytes:Math.max(...lengths),frames:plan.manifest.frames});
        expect(plan.manifest.bytes).toBe(lengths.reduce((a,b)=>a+b,0));
    });
    it('does not report complete statistics when the stream is cancelled or abandoned',async()=>{
        const repo=fake([record('large',{title:'x'.repeat(100_000)})]),report=vi.fn(),controller=new AbortController();
        const source=streamMaterialBackup(repo,{signal:controller.signal,onStatistics:report});
        expect((await source.next()).done).toBe(false);controller.abort();await expect(source.next()).rejects.toMatchObject({name:'AbortError'});expect(report).not.toHaveBeenCalled();
        const abandoned=streamMaterialBackup(repo,{onStatistics:report});expect((await abandoned.next()).done).toBe(false);await abandoned.return(undefined);expect(report).not.toHaveBeenCalled();
    });
});
