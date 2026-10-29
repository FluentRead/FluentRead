import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {MaterialDatabase, MaterialRepository, type MaterialSnapshotVersion} from '@/src/features/vocabulary/materialRepository';
import {MATERIAL_DETAIL_PAGE_MAX_ITEMS, MATERIAL_DETAIL_PAGE_TARGET_BYTES, readMaterialDetailPage as readDetail} from '@/src/features/vocabulary/materialDetailPage';
import type {MaterialRecord, MaterialReference} from '@/src/features/vocabulary/materialProtocol';

let serial = 0;
const databases: MaterialDatabase[] = [];
function database(name = `material-detail-${++serial}`): MaterialDatabase {
    const db = new MaterialDatabase(name); databases.push(db); return db;
}
afterEach(async () => {
    const opened = databases.splice(0), names = new Set(opened.map(db => db.name));
    for (const db of opened) db.close();
    for (const name of names) await Dexie.delete(name);
});
function fixture(references: MaterialReference[] = []): MaterialRecord {
    const fingerprint = 'a'.repeat(32);
    return {id:'id-1', identityKey:'article:private-key', aliases:['article:private-alias'], kind:'document', title:'title',
        source:{kind:'document', fingerprint, title:'source title'},
        locator:{kind:'document', page:7, fingerprint, quote:'original',
            documentReference:{version:1, materialId:fingerprint, locator:{version:1,source:'original',scope:'pdf:7',position:'[1,2]',before:'previous',after:'next'},locatorOccurrences:2}},
        topics:['reading'], references, createdAt:1, updatedAt:2, lastReadAt:3, archivedAt:null};
}
function repository(record: MaterialRecord | null, revision = 3) {
    return {
        readSnapshotRecord: vi.fn(async (expected:MaterialSnapshotVersion,id:string) => {
            if (expected.revision !== revision) throw Object.assign(Error('stale'), {code:'stale-operation'});
            return record && record.id === id ? record : null;
        }),
        checkSnapshot: vi.fn(async (expected:MaterialSnapshotVersion) => {
            if (expected.revision !== revision) throw Object.assign(Error('stale'), {code:'stale-operation'});
        }),
    };
}
const request = (offset = 0) => ({revision:3,id:'id-1',offset});
function readMaterialDetailPage(repo:Parameters<typeof readDetail>[0], input:Parameters<typeof readDetail>[1], signal?:AbortSignal, snapshot:MaterialSnapshotVersion={revision:input?.revision,epoch:'fixture'}) {
    return readDetail(repo,input,signal,snapshot);
}

describe('bounded material detail pages', () => {
    it('preserves complete source and document position while excluding unrelated identity history', async () => {
        const record = fixture([{kind:'vocabulary',id:'entry',excerpt:'quoted',createdAt:1},
            {kind:'note',id:'note',note:'personal',createdAt:2,updatedAt:3}]);
        const repo = repository(record), page = await readMaterialDetailPage(repo,request());
        expect(page).toEqual({revision:3,id:record.id,metadata:{id:record.id,kind:record.kind,title:record.title,source:record.source,
            locator:record.locator,topics:record.topics,createdAt:1,updatedAt:2,lastReadAt:3,archivedAt:null},
            total:2,offset:0,nextOffset:null,references:record.references});
        expect(page.metadata).not.toHaveProperty('identityKey'); expect(page.metadata).not.toHaveProperty('aliases');
        expect(repo.readSnapshotRecord).toHaveBeenCalledOnce(); expect(repo.checkSnapshot).toHaveBeenCalledOnce();
    });
    it('returns ordered pages without omissions and supports the last empty page', async () => {
        const refs = Array.from({length:57}, (_,index) => ({kind:'note' as const,id:`note-${index}`,note:`original-${index}`}));
        const record = fixture(refs), repo = repository(record), found:MaterialReference[] = [];
        let offset:number|null = 0;
        while (offset !== null) {
            const page = await readMaterialDetailPage(repo,{...request(offset),limit:7});
            expect(page.references.length).toBeLessThanOrEqual(7);
            found.push(...page.references); offset = page.nextOffset;
        }
        expect(found).toEqual(refs); expect(new Set(found.map(ref => ref.id)).size).toBe(refs.length);
        expect(await readMaterialDetailPage(repo,request(refs.length))).toMatchObject({total:refs.length,offset:refs.length,nextOffset:null,references:[]});
    });
    it('keeps archive state and optional missing locator as stored', async () => {
        const record = {...fixture(),archivedAt:12,locator:undefined};
        const page = await readMaterialDetailPage(repository(record),request());
        expect(page.metadata.archivedAt).toBe(12); expect(page.metadata).not.toHaveProperty('locator');
    });
    it('counts encoded JSON bytes, splits pages before the soft limit, and never truncates references', async () => {
        const note = '\ud800'.repeat(12000);
        const refs = Array.from({length:24}, (_,index) => ({kind:'note' as const,id:`note-${index}`,note}));
        const repo = repository(fixture(refs)), first = await readMaterialDetailPage(repo,request());
        expect(first.references.length).toBeGreaterThan(0); expect(first.references.length).toBeLessThan(24);
        expect(first.nextOffset).toBe(first.references.length);
        const encoder = new TextEncoder(), bytes = encoder.encode(JSON.stringify(first.metadata)).length
            + first.references.reduce((sum, ref) => sum + encoder.encode(JSON.stringify(ref)).length,0);
        expect(bytes).toBeLessThanOrEqual(MATERIAL_DETAIL_PAGE_TARGET_BYTES);
        const second = await readMaterialDetailPage(repo,request(first.nextOffset!));
        expect([...first.references,...second.references]).toEqual(refs);
    });
    it('returns an individually over-budget reference intact on a page by itself', async () => {
        const note = 'x'.repeat(MATERIAL_DETAIL_PAGE_TARGET_BYTES + 1);
        const refs:MaterialReference[] = [{kind:'note',id:'large',note},{kind:'note',id:'small',note:'after'}];
        const repo = repository(fixture(refs)), page = await readMaterialDetailPage(repo,request());
        expect(page.references).toEqual([refs[0]]); expect(page.nextOffset).toBe(1);
        expect((await readMaterialDetailPage(repo,request(1))).references).toEqual([refs[1]]);
    });
    it('rejects invalid requests, missing records, wrong identity and corrupted reference arrays', async () => {
        const repo = repository(fixture());
        for (const value of [null, [], {...request(),extra:true}, {...request(),id:''}, {...request(),id:'a'.repeat(257)},
            {...request(),revision:-1}, {...request(),offset:-1}, {...request(),offset:1},
            {...request(),limit:0}, {...request(),limit:MATERIAL_DETAIL_PAGE_MAX_ITEMS+1}]) {
            await expect(readMaterialDetailPage(repo,value as never)).rejects.toMatchObject({code:'invalid-input'});
        }
        await expect(readMaterialDetailPage(repository(null),request())).rejects.toMatchObject({code:'not-found'});
        const wrong = {...repo,readSnapshotRecord:vi.fn(async()=>fixture())};
        await expect(readMaterialDetailPage(wrong,{...request(),id:'other'})).rejects.toMatchObject({code:'storage-error'});
        await expect(readMaterialDetailPage(repository({...fixture(),references:null} as never),request())).rejects.toMatchObject({code:'storage-error'});
        await expect(readMaterialDetailPage(repository(fixture(Array.from({length:1001},()=>({kind:'note',id:'x'})))),request())).rejects.toMatchObject({code:'storage-error'});
        for (const bad of [null, {}, {kind:'unknown',id:'x'}, {kind:'note',id:''}]) {
            await expect(readMaterialDetailPage(repository(fixture([bad as never])),request())).rejects.toMatchObject({code:'storage-error'});
        }
    });
    it('fails with stale-operation after a different connection edits or clears the material', async () => {
        const db = database(), otherDb = database(db.name), repo = new MaterialRepository(db), other = new MaterialRepository(otherDb);
        const item = await repo.capture({source:{kind:'article',url:'https://example.test/detail'},
            reference:{kind:'note',id:'n',note:'private'},capturedAt:10},10);
        const snapshot = await repo.openSnapshot(), revision = snapshot.revision;
        const first = await readMaterialDetailPage(repo,{revision,id:item.id,offset:0},undefined,snapshot);
        expect(first.references[0]).toMatchObject({id:'n',note:'private'});
        await other.update(item.id,{title:'changed'},20);
        await expect(readMaterialDetailPage(repo,{revision,id:item.id,offset:0},undefined,snapshot)).rejects.toMatchObject({code:'stale-operation'});
        const next = await repo.openSnapshot(); await other.clear(30);
        await expect(readMaterialDetailPage(repo,{revision:next.revision,id:item.id,offset:0},undefined,next)).rejects.toMatchObject({code:'stale-operation'});
    });
    it('does not publish a page when the revision changes after reading it', async () => {
        const repo = repository(fixture([{kind:'note',id:'n',note:'private'}]));
        repo.checkSnapshot.mockRejectedValueOnce(Object.assign(Error('changed'),{code:'stale-operation'}));
        await expect(readMaterialDetailPage(repo,request())).rejects.toMatchObject({code:'stale-operation'});
    });
    it('copies request parameters before awaiting the record', async () => {
        let finish!:(record:MaterialRecord|null)=>void;
        const pending = new Promise<MaterialRecord|null>(resolve=>{finish=resolve;});
        const repo = repository(fixture()); repo.readSnapshotRecord.mockImplementationOnce(()=>pending);
        const input = {...request(),limit:1}, result = readMaterialDetailPage(repo,input);
        input.offset = 42; input.id = 'changed'; input.revision = 99; finish(fixture());
        expect(await result).toMatchObject({revision:3,id:'id-1',offset:0});
        expect(repo.checkSnapshot).toHaveBeenCalledWith({revision:3,epoch:'fixture'},undefined);
    });
    it('honors cancellation before work and after an uncooperative read settles', async () => {
        const repo = repository(fixture()), already = new AbortController(); already.abort();
        await expect(readMaterialDetailPage(repo,request(),already.signal)).rejects.toMatchObject({name:'AbortError'});
        expect(repo.readSnapshotRecord).not.toHaveBeenCalled();
        let finish!:(record:MaterialRecord|null)=>void;
        const pending = new Promise<MaterialRecord|null>(resolve=>{finish=resolve;});
        repo.readSnapshotRecord.mockImplementationOnce(()=>pending);
        const controller = new AbortController(), result = readMaterialDetailPage(repo,request(),controller.signal);
        controller.abort(); finish(fixture());
        await expect(result).rejects.toMatchObject({name:'AbortError'}); expect(repo.checkSnapshot).not.toHaveBeenCalled();
    });
    it('does not publish when cancelled while the last version check is pending', async () => {
        let finish!:()=>void;
        const pending = new Promise<void>(resolve=>{finish=resolve;});
        const repo = repository(fixture()), controller = new AbortController();
        repo.checkSnapshot.mockImplementationOnce(()=>pending);
        const result = readMaterialDetailPage(repo,request(),controller.signal);
        await vi.waitFor(()=>expect(repo.checkSnapshot).toHaveBeenCalledOnce());
        controller.abort(); finish();
        await expect(result).rejects.toMatchObject({name:'AbortError'});
    });
});
