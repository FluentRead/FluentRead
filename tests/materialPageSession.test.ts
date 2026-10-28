import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createMaterialPageSession, MATERIAL_PAGE_TARGET_BYTES} from '@/src/features/vocabulary/materialPageSession';
import {MaterialDatabase, MaterialRepository} from '@/src/features/vocabulary/materialRepository';
import type {MaterialRecord} from '@/src/features/vocabulary/materialProtocol';

function material(id:string, patch:Partial<MaterialRecord> = {}):MaterialRecord {
    return {id,identityKey:`identity-${id}`,kind:'article',title:`Title ${id}`,source:{kind:'article',url:`https://example.test/${id}`},
        topics:['alpha'],references:[{kind:'note',id:`note-${id}`,excerpt:'Greek ΟΣ',note:'second'}],
        createdAt:1,updatedAt:2,lastReadAt:3,archivedAt:null,...patch};
}
function fake(records:MaterialRecord[]) {
    let revision = 1;
    const byId = new Map(records.map(record => [record.id,record]));
    const repository = {
        openSnapshot:vi.fn(async () => ({revision,ids:records.map(record => record.id)})),
        readSnapshotRecord:vi.fn(async (expected:number,id:string) => {
            if (expected !== revision) throw Object.assign(Error('stale'), {code:'stale-operation'});
            return byId.get(id) ?? null;
        }),
        checkSnapshot:vi.fn(async (expected:number) => {if (expected !== revision) throw Object.assign(Error('stale'), {code:'stale-operation'});}),
    };
    return {repository, change() {revision++;}};
}
let serial = 0; const databases:MaterialDatabase[] = [];
afterEach(async () => {const entries = databases.splice(0); for (const db of entries) db.close(); for (const name of new Set(entries.map(db => db.name))) await Dexie.delete(name);});

describe('paged material query sessions', () => {
    it('sorts once and returns every matching item without duplication across pages', async () => {
        const records = Array.from({length:71}, (_,i) => material(`id-${String(i).padStart(3,'0')}`,
            {lastReadAt:i % 5, updatedAt:i % 3, archivedAt:i % 13 === 0 ? 5 : null}));
        const {repository} = fake(records), session = await createMaterialPageSession(repository, {search:'ος SECOND'});
        const expected = records.filter(record => record.archivedAt === null).sort((a,b) =>
            b.lastReadAt-a.lastReadAt || b.updatedAt-a.updatedAt || a.id.localeCompare(b.id)).map(record => record.id);
        expect(session.matched).toBe(expected.length); expect(session.total).toBe(expected.length);
        expect(JSON.stringify(session)).not.toContain('example.test'); expect(JSON.stringify(session)).not.toContain('Greek');
        const found:string[] = []; let offset:number|null = 0;
        while (offset !== null) {
            const page = await session.getPage({offset,limit:7});
            found.push(...page.items.map(item => item.id)); offset = page.nextOffset;
        }
        expect(found).toEqual(expected); expect(new Set(found).size).toBe(expected.length);
        expect(repository.readSnapshotRecord).toHaveBeenCalledTimes(records.length + expected.length);
        await session.close();
    });
    it('preserves archive, exact topic, cross-field whitespace and empty query semantics', async () => {
        const records = [material('a',{title:'A',source:{kind:'article'},topics:[],references:[{kind:'note',id:'x',note:'B'}]}),
            material('b',{topics:['beta']}), material('c',{archivedAt:42})];
        const {repository} = fake(records);
        const search = await createMaterialPageSession(repository,{search:'a   b'});
        expect(search.total).toBe(2); expect(search.matched).toBe(1); expect((await search.getPage({offset:0})).items.map(x => x.id)).toEqual(['a']);
        await search.close();
        const topic = await createMaterialPageSession(repository,{topic:'beta',search:'  '});
        expect(topic.matched).toBe(1); expect((await topic.getPage({offset:0})).items[0].id).toBe('b'); await topic.close();
        const archived = await createMaterialPageSession(repository,{archived:true});
        expect(archived.total).toBe(1); expect((await archived.getPage({offset:0})).items[0].id).toBe('c'); await archived.close();
    });
    it('normalizes the query once while retaining joined-field Unicode search semantics', async () => {
        const records = [material('a'),material('b'),material('c',{references:[]})], query = '  ΟΣ SECOND  ';
        const lower = vi.spyOn(String.prototype,'toLocaleLowerCase');
        try {
            const session = await createMaterialPageSession(fake(records).repository,{search:query});
            const calls = lower.mock.contexts.filter(value => String(value) === query.trim());
            expect(calls).toHaveLength(1);
            expect((await session.getPage({offset:0})).items.map(item=>item.id)).toEqual(['a','b']);
            await session.close();
        } finally {lower.mockRestore();}
    });
    it('bounds ordinary page bytes without truncating any summary', async () => {
        const records = Array.from({length:12},(_,i) => material(String(i),{source:{kind:'article',url:'x'.repeat(130_000)}}));
        const session = await createMaterialPageSession(fake(records).repository);
        const first = await session.getPage({offset:0});
        expect(first.items.length).toBeLessThan(12); expect(first.nextOffset).toBe(first.items.length);
        expect(first.items.reduce((n,item) => n + new TextEncoder().encode(JSON.stringify(item)).length,0)).toBeLessThanOrEqual(MATERIAL_PAGE_TARGET_BYTES);
        expect(first.items.every(item => item.sourceUrl === 'x'.repeat(130_000))).toBe(true);
        const second = await session.getPage({offset:first.nextOffset!});
        expect(first.items.length + second.items.length).toBe(12); expect(second.nextOffset).toBeNull();
        await session.close();
    });
    it('returns an individually oversized summary intact alone', async () => {
        const sourceUrl = 'x'.repeat(MATERIAL_PAGE_TARGET_BYTES+1), records = [material('a',{source:{kind:'article',url:sourceUrl}}), material('b')];
        const session = await createMaterialPageSession(fake(records).repository);
        const page = await session.getPage({offset:0});
        expect(page.items).toHaveLength(1); expect(page.items[0].sourceUrl).toBe(sourceUrl); expect(page.nextOffset).toBe(1);
        await session.close();
    });
    it('rejects stale pages after another connection writes to the repository', async () => {
        const db = new MaterialDatabase(`page-session-${++serial}`); databases.push(db);
        const peer = new MaterialDatabase(db.name); databases.push(peer);
        const repo = new MaterialRepository(db), other = new MaterialRepository(peer);
        const item = await repo.capture({source:{kind:'article',url:'https://example.test/one'},capturedAt:10},10);
        const session = await createMaterialPageSession(repo);
        await other.update(item.id,{title:'changed'},20);
        await expect(session.getPage({offset:0})).rejects.toMatchObject({code:'stale-operation'}); await session.close();
    });
    it('does not return a partially read page if a change occurs during it', async () => {
        const f = fake([material('a'),material('b')]), session = await createMaterialPageSession(f.repository);
        const read = f.repository.readSnapshotRecord;
        read.mockImplementationOnce(async (_rev,id) => material(id)).mockImplementationOnce(async (_rev,id) => {f.change();return material(id);});
        await expect(session.getPage({offset:0})).rejects.toMatchObject({code:'stale-operation'}); await session.close();
    });
    it('validates query and page bounds, including empty results', async () => {
        const {repository} = fake([]);
        for (const value of [{search:'x'.repeat(131073)},{topic:'x'.repeat(81)},{archived:'yes'},{extra:true}])
            await expect(createMaterialPageSession(repository,value as never)).rejects.toMatchObject({code:'invalid-input'});
        const session = await createMaterialPageSession(repository);
        expect(await session.getPage({offset:0})).toMatchObject({items:[],total:0,matched:0,nextOffset:null});
        for (const value of [{offset:-1},{offset:1},{offset:0,limit:0},{offset:0,limit:31},{offset:0,other:1}])
            await expect(session.getPage(value as never)).rejects.toMatchObject({code:'invalid-input'});
        await session.close(); await expect(session.getPage({offset:0})).rejects.toMatchObject({name:'AbortError'});
    });
    it('cancels during index construction after the actual pending read settles', async () => {
        let finish!: (value:MaterialRecord|null)=>void; const pending = new Promise<MaterialRecord|null>(resolve => {finish = resolve;});
        let began!:()=>void; const started = new Promise<void>(resolve => {began=resolve;});
        const repository = {openSnapshot:async () => ({revision:1,ids:['a']}),
            readSnapshotRecord:() => {began();return pending;}, checkSnapshot:async () => {}};
        const controller = new AbortController(), operation = createMaterialPageSession(repository,{},controller.signal);
        await started; controller.abort(); finish(material('a'));
        await expect(operation).rejects.toMatchObject({name:'AbortError'});
    });
    it('rejects concurrent pages and close waits for an uncooperative pending read', async () => {
        const f = fake([material('a')]), session = await createMaterialPageSession(f.repository);
        let finish!: (value:MaterialRecord|null)=>void; const pending = new Promise<MaterialRecord|null>(resolve => {finish = resolve;});
        let began!:()=>void; const started = new Promise<void>(resolve => {began=resolve;});
        f.repository.readSnapshotRecord.mockImplementationOnce(() => {began();return pending;});
        const page = session.getPage({offset:0}); const outcome = page.catch(error => error);
        await started;
        await expect(session.getPage({offset:0})).rejects.toMatchObject({code:'limit-exceeded'});
        let closed = false; const close = session.close().then(() => {closed=true;});
        await Promise.resolve(); expect(closed).toBe(false);
        finish(material('a')); await expect(outcome).resolves.toMatchObject({name:'AbortError'}); await close; expect(closed).toBe(true);
    });
    it('binds the creation signal to the session and waits for an active read after abort', async () => {
        const f = fake([material('a')]), controller = new AbortController();
        const session = await createMaterialPageSession(f.repository,{},controller.signal);
        let finish!: (value:MaterialRecord|null)=>void; const pending = new Promise<MaterialRecord|null>(resolve => {finish=resolve;});
        let began!:()=>void; const started = new Promise<void>(resolve => {began=resolve;});
        f.repository.readSnapshotRecord.mockImplementationOnce(() => {began();return pending;});
        const page = session.getPage({offset:0}), outcome = page.catch(error=>error);
        await started; controller.abort();
        await expect(session.getPage({offset:0})).rejects.toMatchObject({name:'AbortError'});
        let closed = false; const close = session.close().then(()=>{closed=true;});
        await Promise.resolve(); expect(closed).toBe(false);
        finish(material('a')); await expect(outcome).resolves.toMatchObject({name:'AbortError'});
        await close; expect(closed).toBe(true);
        await expect(session.getPage({offset:0})).rejects.toMatchObject({name:'AbortError'});
    });
    it('registers the page lease before a synchronous abort inside the first snapshot check', async () => {
        const f = fake([material('a')]), controller = new AbortController();
        const session = await createMaterialPageSession(f.repository,{},controller.signal);
        let finish!:()=>void, began!:()=>void;
        const pending = new Promise<void>(resolve=>{finish=resolve;}), started = new Promise<void>(resolve=>{began=resolve;});
        f.repository.checkSnapshot.mockImplementationOnce(() => {controller.abort(); began(); return pending;});
        const page = session.getPage({offset:0}), outcome = page.catch(error=>error);
        await started;
        let closed = false; const close = session.close().then(()=>{closed=true;});
        await Promise.resolve(); await Promise.resolve(); expect(closed).toBe(false);
        expect(f.repository.readSnapshotRecord).toHaveBeenCalledTimes(1);
        finish(); await expect(outcome).resolves.toMatchObject({name:'AbortError'}); await close;
        expect(closed).toBe(true); await expect(session.getPage({offset:0})).rejects.toMatchObject({name:'AbortError'});
    });
});
