import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {decodeMaterialSummaries, MATERIAL_SUMMARY_LINE_BYTES, type MaterialSummaryConsumer} from '@/src/features/vocabulary/materialReadDecoder';
import type {MaterialSummary} from '@/src/features/vocabulary/materialSummary';
import {streamMaterialSummaries} from '@/src/features/vocabulary/materialReadSource';
import type {MaterialRecord} from '@/src/features/vocabulary/materialProtocol';
import {MaterialDatabase, MaterialRepository} from '@/src/features/vocabulary/materialRepository';

const encoder = new TextEncoder();
const lines = (...messages: unknown[]) => encoder.encode(messages.map(message => JSON.stringify(message)).join('\n') + '\n');
const header = {type:'header',version:1,revision:4};
const complete = (count:number,total:number,topicCount:number) => ({type:'complete',count,total,topicCount});
const summary = (id: string, changes: Partial<MaterialSummary> = {}): MaterialSummary => ({
    id, kind:'article', title:`标题 ${id}`, sourceUrl:'https://example.test/', topics:[],
    lastReadAt:10, updatedAt:10, archivedAt:null, preview:'😀 文本', referenceCount:0, ...changes,
});
const msg = (value: MaterialSummary) => ({type:'summary',value});
const receive = (input: Uint8Array, size = input.length || 1): MaterialSummaryConsumer => async onChunk => {
    for (let index=0; index<input.length; index+=size) onChunk(input.subarray(index,index+size));
};
const decoded = (input: Uint8Array, size?: number) => decodeMaterialSummaries(receive(input,size));

describe('material summary stream decoder', () => {
    it('decodes across every UTF-8 byte boundary and sorts summaries and topics', async () => {
        const input = lines(header, {type:'topic',value:'主题乙'}, {type:'topic',value:'主题甲'},
            msg(summary('z',{lastReadAt:20,topics:['主题乙']})), msg(summary('b',{lastReadAt:30,updatedAt:5})),
            msg(summary('a',{lastReadAt:30,updatedAt:5})), complete(3,4,2));
        const output = await decoded(input,1);
        expect(output.revision).toBe(4); expect(output.total).toBe(4);
        expect(output.summaries.map(item => item.id)).toEqual(['a','b','z']);
        expect(output.topics).toEqual(['主题乙','主题甲'].sort((a,b)=>a.localeCompare(b)));
        expect(output.summaries[0].preview).toBe('😀 文本');
    });
    it('returns an empty result only when footer and transport both complete', async () => {
        expect(await decoded(lines(header,complete(0,0,0)))).toEqual({revision:4,summaries:[],topics:[],total:0});
        await expect(decoded(lines(header))).rejects.toThrow();
        await expect(decoded(encoder.encode(JSON.stringify(header)))).rejects.toThrow();
        const payload = lines(header,complete(0,0,0));
        await expect(decodeMaterialSummaries(async onChunk => {onChunk(payload); throw Error('transport failed');})).rejects.toThrow('transport failed');
        let release!:()=>void;
        const pending = decodeMaterialSummaries(async onChunk => {onChunk(payload); await new Promise<void>(resolve => {release=resolve;});});
        let settled = false; void pending.then(()=>{settled=true;});
        await Promise.resolve(); await Promise.resolve(); expect(settled).toBe(false);
        release(); expect((await pending).total).toBe(0);
    });
    it.each(['stale-operation','limit-exceeded','invalid-input','storage-error'] as const)('delivers %s only after transport verification', async code => {
        for (const prefix of [[], [header,msg(summary('partial'))]]) {
            const payload = lines(...prefix,{type:'error',code});
            let release!:()=>void, finished = false;
            const result = decodeMaterialSummaries(async onChunk => {onChunk(payload); await new Promise<void>(resolve=>{release=resolve;});});
            const assertion = expect(result).rejects.toMatchObject({code});
            void result.catch(()=>{finished=true;});
            await Promise.resolve(); await Promise.resolve(); expect(finished).toBe(false);
            release(); await assertion;
            await expect(decodeMaterialSummaries(async onChunk => {onChunk(payload);throw Error('transport disconnected');})).rejects.toThrow('transport disconnected');
        }
    });
    it('accepts the actual summary source with filtered results and all archive topics', async () => {
        const record: MaterialRecord = {id:'source',identityKey:'article:https://example.test/',kind:'article',
            source:{kind:'article',url:'https://example.test/'}, title:'标题', topics:['筛选'], references:[],
            createdAt:1,updatedAt:2,lastReadAt:3,archivedAt:null};
        const repo = {openSnapshot:async()=>({revision:7,ids:['source']}),readSnapshotRecord:async()=>record,checkSnapshot:async()=>{}};
        const output = await decodeMaterialSummaries(async (onChunk,signal) => {
            for await (const chunk of streamMaterialSummaries(repo,{search:'missing'},signal)) onChunk(chunk);
        });
        expect(output).toEqual({revision:7,summaries:[],topics:['筛选'],total:1});
    });
    it('accepts a real capture whose fallback hostname exceeds the explicit title limit', async () => {
        const db = new MaterialDatabase(`read-decoder-host-${crypto.randomUUID()}`), repo = new MaterialRepository(db);
        try {
            const host = `${'a'.repeat(300)}.example`, item = await repo.capture({source:{kind:'article',url:`https://${host}/`},capturedAt:10},10);
            expect(item.title).toBe(host); expect(item.title.length).toBeGreaterThan(240);
            const result = await decodeMaterialSummaries(async (onChunk,signal) => {
                for await (const chunk of streamMaterialSummaries(repo,{},signal)) onChunk(chunk);
            });
            expect(result.summaries).toHaveLength(1); expect(result.summaries[0].title).toBe(host);
        } finally {db.close(); await db.delete();}
    });
    it.each([
        [header,header,complete(0,0,0)],
        [{type:'topic',value:'x'},header,complete(0,0,1)],
        [header,complete(0,0,0),complete(0,0,0)],
        [header,{type:'topic',value:'x'},{type:'topic',value:'x'},complete(0,0,2)],
        [header,msg(summary('same')),msg(summary('same')),complete(2,2,0)],
        [header,msg(summary('x',{topics:['missing']})),complete(1,1,0)],
        [header,{type:'topic',value:'x'},msg(summary('x',{topics:['x','x']})),complete(1,1,1)],
        [header,msg(summary('x')),complete(0,1,0)],
        [header,msg(summary('x')),complete(1,0,0)],
        [header,{type:'topic',value:'x'},complete(0,0,0)],
        [header,complete(0,10001,0)],
        [header,{type:'topic',value:'x'},complete(0,0,1)],
        [{type:'header',version:1,revision:-1},complete(0,0,0)],
        [{type:'header',version:1,revision:4,extra:1},complete(0,0,0)],
        [{type:'error',code:'secret'}],
        [{type:'error',code:'storage-error',message:'private'}],
        [{type:'error',code:'stale-operation'},complete(0,0,0)],
        [header,{type:'error',code:'stale-operation'},{type:'error',code:'stale-operation'}],
        [header,complete(0,0,0),{type:'error',code:'storage-error'}],
        [header,{type:'other'},complete(0,0,0)],
        [header,msg(summary('x',{lastReadAt:NaN})),complete(1,1,0)],
        [header,msg(summary('x',{referenceCount:1001})),complete(1,1,0)],
    ])('rejects invalid order, duplicates, shape or counts %#',async (...messages)=>{
        await expect(decoded(lines(...messages),3)).rejects.toThrow();
    });
    it('rejects malformed JSON, invalid or truncated UTF-8, and bytes after footer', async () => {
        await expect(decoded(encoder.encode('{broken}\n'))).rejects.toThrow();
        const invalidBytes = Uint8Array.from([...encoder.encode('{"type":"'),0xff,...encoder.encode('"}\n')]);
        await expect(decoded(invalidBytes,1)).rejects.toThrow();
        const truncatedUtf8 = Uint8Array.from([...encoder.encode('{"type":"'),0xf0,0x9f,10]);
        await expect(decoded(truncatedUtf8,1)).rejects.toThrow();
        const trailing = Uint8Array.from([...lines(header,complete(0,0,0)),32]);
        await expect(decoded(trailing,1)).rejects.toThrow();
    });
    it('limits each line by encoded bytes before parsing', async () => {
        const tooLarge = encoder.encode('中'.repeat(Math.floor(MATERIAL_SUMMARY_LINE_BYTES/3)+1));
        expect(tooLarge.length).toBeGreaterThan(MATERIAL_SUMMARY_LINE_BYTES);
        await expect(decoded(tooLarge,1024)).rejects.toThrow('too large');
    });
    it('cannot publish partial results if the consumer swallows a parsing error', async () => {
        await expect(decodeMaterialSummaries(async onChunk => {
            onChunk(lines(header));
            try {onChunk(encoder.encode('bad\n'));} catch {}
        })).rejects.toThrow();
    });
    it('aborts a stalled transport and rejects late callbacks without publishing', async () => {
        const controller = new AbortController();
        let forwarded!:AbortSignal, push!:(chunk:Uint8Array)=>void, release!:()=>void;
        const result = decodeMaterialSummaries(async (onChunk,signal) => {
            push=onChunk; forwarded=signal; onChunk(lines(header,msg(summary('partial'))));
            await new Promise<void>(resolve => {release=resolve;});
        }, {signal:controller.signal});
        await Promise.resolve(); controller.abort();
        await expect(result).rejects.toMatchObject({name:'AbortError'});
        expect(forwarded.aborted).toBe(true); expect(()=>push(lines(complete(1,1,0)))).toThrow(); release();
    });
    it('does not start transport when already cancelled', async () => {
        const controller = new AbortController(); controller.abort(); let started = false;
        await expect(decodeMaterialSummaries(async()=>{started=true;},{signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
        expect(started).toBe(false);
    });
});
