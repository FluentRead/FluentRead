import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {MaterialDatabase, MaterialRepository} from '@/src/features/vocabulary/materialRepository';
import {streamMaterialSummaries, type MaterialSummaryReadMessage} from '@/src/features/vocabulary/materialReadSource';
import type {MaterialRecord} from '@/src/features/vocabulary/materialProtocol';
import {MaterialError} from '@/src/features/vocabulary/materialModel';

let serial = 0;
const databases: MaterialDatabase[] = [];
function repository(): MaterialRepository {
    const db = new MaterialDatabase(`material-read-source-${++serial}`); databases.push(db);
    return new MaterialRepository(db);
}
afterEach(async () => {for (const db of databases.splice(0)) {db.close(); await Dexie.delete(db.name);}});
async function seed(repo: MaterialRepository, name: string, topics: string[], archived = false): Promise<MaterialRecord> {
    const item = await repo.capture({source: {kind: 'article', url: `https://example.test/${name}`, title: name},
        reference: {kind: 'note', id: `note-${name}`, excerpt: 'Greek ΟΣ', note: 'second'}, capturedAt: 10}, 10);
    const updated = await repo.update(item.id, {topics}, 20);
    return archived ? repo.archive(updated.id) : updated;
}
const parse = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as MaterialSummaryReadMessage;
async function collect(source: AsyncIterable<Uint8Array>): Promise<MaterialSummaryReadMessage[]> {
    const output: MaterialSummaryReadMessage[] = [];
    for await (const chunk of source) output.push(parse(chunk));
    return output;
}

describe('revision-checked material summary source', () => {
    it('streams an empty snapshot with a complete footer', async () => {
        const repo = repository();
        expect(await collect(streamMaterialSummaries(repo))).toEqual([
            {type: 'header', version: 1, revision: 0},
            {type: 'complete', count: 0, total: 0, topicCount: 0},
        ]);
    });
    it('preserves archive, topic and complete joined-text search semantics without reading all records at once', async () => {
        const repo = repository();
        const first = await seed(repo, 'first', ['alpha', 'shared']);
        await seed(repo, 'second', ['beta']);
        await seed(repo, 'archived', ['hidden'], true);
        const noArray = vi.spyOn(repo.db.materials, 'toArray').mockImplementation(() => {throw Error('full table read');});
        const read = vi.spyOn(repo, 'readSnapshotRecord');
        try {
            const output = await collect(streamMaterialSummaries(repo, {topic: 'shared', search: 'ος SECOND'}));
            expect(output[0]).toMatchObject({type:'header', version:1});
            const summary = output.find(message => message.type === 'summary');
            expect(summary).toMatchObject({type:'summary', value:{id:first.id, referenceCount:1, preview:'Greek ΟΣ', topics:['alpha','shared']}});
            expect(summary).not.toHaveProperty('value.references');
            expect(output.filter(message => message.type === 'topic').map(message => message.value).sort()).toEqual(['alpha','beta','shared']);
            expect(output.at(-1)).toEqual({type:'complete', count:1, total:2, topicCount:3});
            expect(read).toHaveBeenCalledTimes(3);
            const archived = await collect(streamMaterialSummaries(repo, {archived:true}));
            expect(archived.find(message => message.type === 'summary')).toMatchObject({type:'summary', value:{title:'archived'}});
            expect(archived.at(-1)).toEqual({type:'complete', count:1, total:1, topicCount:1});
            const none = await collect(streamMaterialSummaries(repo, {topic:'missing'}));
            expect(none.at(-1)).toEqual({type:'complete', count:0, total:2, topicCount:3});
        } finally {noArray.mockRestore(); read.mockRestore();}
    });
    it('fails without a complete footer when a record disappears or has a different id', async () => {
        for (const record of [null, {id:'wrong'}]) {
            const source = streamMaterialSummaries({
                openSnapshot: async () => ({revision:1,ids:['expected']}),
                readSnapshotRecord: async () => record as MaterialRecord | null,
                checkSnapshot: async () => {},
            });
            expect(parse((await source.next()).value!)).toMatchObject({type:'header'});
            expect(parse((await source.next()).value!)).toEqual({type:'error',code:'storage-error'});
            expect((await source.next()).done).toBe(true);
        }
    });
    it('fails after a concurrent mutation instead of completing a mixed snapshot', async () => {
        const repo = repository(), item = await seed(repo, 'before', []);
        const source = streamMaterialSummaries(repo);
        expect(parse((await source.next()).value!)).toMatchObject({type:'header'});
        expect(parse((await source.next()).value!)).toMatchObject({type:'summary'});
        await repo.update(item.id, {title:'after'}, 30);
        expect(parse((await source.next()).value!)).toEqual({type:'error',code:'stale-operation'});
        expect((await source.next()).done).toBe(true);
    });
    it('honors cancellation before opening and after an in-flight read', async () => {
        const before = new AbortController(); before.abort();
        const repo = repository(), open = vi.spyOn(repo, 'openSnapshot');
        await expect(streamMaterialSummaries(repo, {}, before.signal).next()).rejects.toMatchObject({name:'AbortError'});
        expect(open).not.toHaveBeenCalled();
        let resolve!: (item: MaterialRecord | null) => void;
        const pending = new Promise<MaterialRecord | null>(accept => {resolve = accept;});
        const controller = new AbortController();
        const source = streamMaterialSummaries({openSnapshot: async () => ({revision:1,ids:['x']}),
            readSnapshotRecord: () => pending, checkSnapshot: async () => {}}, {}, controller.signal);
        await source.next();
        const next = source.next(); controller.abort(); resolve(null);
        await expect(next).rejects.toMatchObject({name:'AbortError'});
    });
    it('does not emit a header or completion if cancellation happens during snapshot checks', async () => {
        let finishOpen!: (value: {revision: number; ids: string[]}) => void;
        const opening = new Promise<{revision: number; ids: string[]}>(resolve => {finishOpen = resolve;});
        const firstAbort = new AbortController();
        const firstSource = streamMaterialSummaries({openSnapshot: () => opening, readSnapshotRecord: async () => null,
            checkSnapshot: async () => {}}, {}, firstAbort.signal);
        const header = firstSource.next(); firstAbort.abort(); finishOpen({revision:0,ids:[]});
        await expect(header).rejects.toMatchObject({name:'AbortError'});
        let finishCheck!: () => void;
        const checking = new Promise<void>(resolve => {finishCheck = resolve;});
        const secondAbort = new AbortController();
        const secondSource = streamMaterialSummaries({openSnapshot: async () => ({revision:0,ids:[]}),
            readSnapshotRecord: async () => null, checkSnapshot: () => checking}, {}, secondAbort.signal);
        await secondSource.next();
        const complete = secondSource.next(); secondAbort.abort(); finishCheck();
        await expect(complete).rejects.toMatchObject({name:'AbortError'});
    });
    it('copies query options before asynchronous work, and rejects invalid options', async () => {
        const repo = repository(); await seed(repo, 'first', ['alpha']);
        const options = {topic:'alpha'};
        const source = streamMaterialSummaries(repo, options);
        const first = source.next(); options.topic = 'other';
        await first;
        expect(parse((await source.next()).value!)).toMatchObject({type:'topic', value:'alpha'});
        expect(parse((await source.next()).value!)).toMatchObject({type:'summary'});
        expect(await collect(streamMaterialSummaries(repo, {archived: 'yes'} as never))).toEqual([{type:'error',code:'invalid-input'}]);
    });
    it('returns only allowed error codes, with no private exception text, before or after the header', async () => {
        const codes = ['stale-operation','limit-exceeded','invalid-input','storage-error'] as const;
        for (const code of codes) {
            const error = new MaterialError(code, 'private secret');
            const repo = {openSnapshot:async()=>{throw error;},readSnapshotRecord:async()=>null,checkSnapshot:async()=>{}};
            expect(await collect(streamMaterialSummaries(repo))).toEqual([{type:'error',code}]);
        }
        const repo = {openSnapshot:async()=>({revision:1,ids:['one']}),readSnapshotRecord:async()=>{throw Error('private secret');},checkSnapshot:async()=>{}};
        expect(await collect(streamMaterialSummaries(repo))).toEqual([{type:'header',version:1,revision:1},{type:'error',code:'storage-error'}]);
    });
    it('emits many unique topics incrementally, including topics from filtered materials', async () => {
        const count = 300;
        const records = Array.from({length:count}, (_, index): MaterialRecord => ({
            id:String(index), identityKey:`identity-${index}`, kind:'article', title:'title', source:{kind:'article'},
            topics:Array.from({length:30}, (_, n) => `topic-${index}-${n}-${'\ud800'.repeat(50)}`), references:[],
            createdAt:1, updatedAt:1, lastReadAt:1, archivedAt:null,
        }));
        records[1].topics[0] = records[0].topics[0];
        const fake = {openSnapshot:async () => ({revision:1,ids:records.map(record => record.id)}),
            readSnapshotRecord:async (_revision:number, id:string) => records[Number(id)], checkSnapshot:async () => {}};
        const source = streamMaterialSummaries(fake, {search:'no match'});
        let topicCount = 0, maxBytes = 0;
        const topics = new Set<string>();
        let final: MaterialSummaryReadMessage | undefined;
        for await (const chunk of source) {
            maxBytes = Math.max(maxBytes, chunk.length);
            const message = parse(chunk);
            if (message.type === 'topic') {topicCount++; topics.add(message.value);}
            final = message;
        }
        expect(topicCount).toBe(count * 30 - 1);
        expect(topics.size).toBe(topicCount);
        expect(maxBytes).toBeLessThan(24 * 1024);
        expect(final).toEqual({type:'complete', count:0, total:count, topicCount});
    });
    it('stops after cancellation during topic emission without a complete footer', async () => {
        const repo = repository(); await seed(repo, 'first', ['alpha', 'beta']);
        const controller = new AbortController(), source = streamMaterialSummaries(repo, {}, controller.signal);
        expect(parse((await source.next()).value!)).toMatchObject({type:'header'});
        expect(parse((await source.next()).value!)).toMatchObject({type:'topic',value:'alpha'});
        controller.abort();
        await expect(source.next()).rejects.toMatchObject({name:'AbortError'});
    });
});

it('passes the same cancellation signal to each snapshot transaction', async () => {
    const controller = new AbortController();
    const record: MaterialRecord = {id:'one',identityKey:'one',kind:'article',title:'one',source:{kind:'article'},topics:[],references:[],createdAt:1,updatedAt:1,lastReadAt:1,archivedAt:null};
    const repo = {openSnapshot:vi.fn(async () => ({revision:1,ids:['one']})),
        readSnapshotRecord:vi.fn(async () => record),checkSnapshot:vi.fn(async () => {})};
    await collect(streamMaterialSummaries(repo, {}, controller.signal));
    expect(repo.openSnapshot).toHaveBeenCalledWith(controller.signal);
    expect(repo.readSnapshotRecord).toHaveBeenCalledWith(1,'one',controller.signal);
    expect(repo.checkSnapshot).toHaveBeenCalledWith(1,controller.signal);
});
