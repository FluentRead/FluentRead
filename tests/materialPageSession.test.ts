import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createMaterialPageSession, MATERIAL_PAGE_TARGET_BYTES, MATERIAL_TOPIC_PAGE_MAX_ITEMS} from '@/src/features/vocabulary/materialPageSession';
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
        openSnapshot:vi.fn(async () => ({revision,epoch:'test-epoch',ids:records.map(record => record.id)})),
        readSnapshotRecord:vi.fn(async (expected:{revision:number;epoch:string},id:string) => {
            if (expected.revision !== revision) throw Object.assign(Error('stale'), {code:'stale-operation'});
            return byId.get(id) ?? null;
        }),
        checkSnapshot:vi.fn(async (expected:{revision:number;epoch:string}) => {if (expected.revision !== revision) throw Object.assign(Error('stale'), {code:'stale-operation'});}),
    };
    return {repository, change() {revision++;}};
}
let serial = 0; const databases:MaterialDatabase[] = [];
afterEach(async () => {const entries = databases.splice(0); for (const db of entries) db.close(); for (const name of new Set(entries.map(db => db.name))) await Dexie.delete(name);});

describe('paged material query sessions', () => {
    it('keeps its internal snapshot identity immutable while exposing a numeric page revision', async () => {
        const session=await createMaterialPageSession(fake([material('x')]).repository);
        expect(Object.isFrozen(session.snapshot)).toBe(true);
        expect(Reflect.set(session.snapshot,'epoch','changed')).toBe(false);
        expect((await session.getPage({offset:0})).revision).toBe(1);
        await session.close();
    });
    it('closes a session if cancellation reenters while its revision is read', async () => {
        const f = fake([]), controller = new AbortController(), removed = vi.spyOn(controller.signal, 'removeEventListener');
        let reads = 0;
        f.repository.openSnapshot.mockResolvedValueOnce({ids:[],epoch:'test-epoch',get revision() {if (++reads === 2) controller.abort();return 1;}});
        await expect(createMaterialPageSession(f.repository,{},controller.signal)).rejects.toMatchObject({name:'AbortError'});
        expect(f.repository.checkSnapshot).toHaveBeenCalledOnce();
        expect(removed).toHaveBeenCalledWith('abort',expect.any(Function));
        const retry=await createMaterialPageSession(f.repository);expect(retry.total).toBe(0);await retry.close();
    });
    it('pages all archive topics in the previous stable locale order, independent of active filters', async () => {
        const records = [
            material('z',{lastReadAt:1,updatedAt:8,topics:['e\u0301','shared','beta']}),
            material('a',{lastReadAt:9,updatedAt:5,topics:['é','shared','Alpha']}),
            material('c',{lastReadAt:4,updatedAt:2,topics:['shared','gamma','']}),
            material('archived',{archivedAt:42,topics:['hidden']}),
        ];
        expect('é'.localeCompare('e\u0301')).toBe(0);
        const session = await createMaterialPageSession(fake(records).repository,{topic:'not-present',search:'not present'});
        expect(session.matched).toBe(0);
        const expected = [...new Set(records.filter(record=>record.archivedAt === null).sort((a,b) =>
            b.lastReadAt-a.lastReadAt || b.updatedAt-a.updatedAt || a.id.localeCompare(b.id)).flatMap(record=>record.topics))]
            .sort((a,b)=>a.localeCompare(b));
        const actual:string[] = []; let offset:number|null = 0;
        while (offset !== null) {
            const page = await session.getTopicsPage({offset,limit:2});
            expect(page.total).toBe(expected.length); expect(page.matched).toBe(expected.length);
            actual.push(...page.topics); offset=page.nextOffset;
        }
        expect(actual).toEqual(expected); expect(actual.indexOf('é')).toBeLessThan(actual.indexOf('e\u0301'));
        const archived = await createMaterialPageSession(fake(records).repository,{archived:true});
        expect((await archived.getTopicsPage({offset:0})).topics).toEqual(['hidden']);
        await archived.close(); await session.close();
    });
    it('preserves the old ordering across multiple sorted topic chunks and repeated values', async () => {
        const records=Array.from({length:240},(_,i)=>material(`id-${String(i).padStart(3,'0')}`,{
            lastReadAt:(i*13)%19,updatedAt:(i*7)%11,
            topics:Array.from({length:28},(_,n)=>`topic-${String((i*241+n*137)%5701).padStart(4,'0')}`),
        })).reverse();
        const expected=[...new Set(records.slice().sort((a,b)=>b.lastReadAt-a.lastReadAt || b.updatedAt-a.updatedAt || a.id.localeCompare(b.id))
            .flatMap(item=>item.topics))].sort((a,b)=>a.localeCompare(b));
        expect(expected.length).toBeGreaterThan(4096);
        const session=await createMaterialPageSession(fake(records).repository), output:string[]=[];
        let offset:number|null=0;
        while(offset !== null) {const page=await session.getTopicsPage({offset}); output.push(...page.topics); offset=page.nextOffset;}
        expect(output).toEqual(expected); await session.close();
    });
    it('keeps scan and intra-material order when distinct IDs and topics compare equal in the locale', async () => {
        expect('é'.localeCompare('e\u0301')).toBe(0);
        const records=[material('é',{topics:['é','e\u0301'],lastReadAt:3,updatedAt:2}),
            material('e\u0301',{topics:['é','e\u0301'],lastReadAt:3,updatedAt:2})];
        const session=await createMaterialPageSession(fake(records).repository);
        expect((await session.getPage({offset:0})).items.map(item=>item.id)).toEqual(['é','e\u0301']);
        expect((await session.getTopicsPage({offset:0})).topics).toEqual(['é','e\u0301']);
        await session.close();
    });
    it.each([['é','e\u0301'],['e\u0301','é']])('preserves scan order without progress callback for equivalent IDs and topics %s, %s', async (first,second) => {
        expect(first.localeCompare(second)).toBe(0);
        const records=[material(first,{lastReadAt:3,updatedAt:2,topics:['z','zz',first]}),
            material(second,{lastReadAt:3,updatedAt:2,topics:[second,first]})];
        const session=await createMaterialPageSession(fake(records).repository);
        const firstMaterial=await session.getPage({offset:0,limit:1});
        const secondMaterial=await session.getPage({offset:firstMaterial.nextOffset!,limit:1});
        expect([...firstMaterial.items,...secondMaterial.items].map(item=>item.id)).toEqual([first,second]);
        const firstTopics=await session.getTopicsPage({offset:0,limit:1});
        const nextTopics=await session.getTopicsPage({offset:firstTopics.nextOffset!,limit:1});
        expect([...firstTopics.topics,...nextTopics.topics]).toEqual([first,second]);
        await session.close();
    });
    it('searches within complete topics without changing material search and reports exact offsets', async () => {
        const records=[material('a',{topics:['Alpha','ALPine','beta']}),material('b',{topics:['alpha','Gamma']})];
        const session=await createMaterialPageSession(fake(records).repository,{search:'no material matches'});
        expect(session.matched).toBe(0);
        const first=await session.getTopicsPage({offset:0,limit:2,search:'  aLp  '});
        expect(first.total).toBe(5); expect(first.matched).toBe(3); expect(first.nextOffset).toBe(2);
        const next=await session.getTopicsPage({offset:first.nextOffset!,limit:2,search:'alp'});
        expect(next.matched).toBe(3); expect(next.nextOffset).toBeNull();
        expect([...first.topics,...next.topics]).toEqual(['alpha','Alpha','ALPine'].sort((a,b)=>a.localeCompare(b)));
        expect(await session.getTopicsPage({offset:3,search:'alp'})).toMatchObject({topics:[],nextOffset:null,matched:3});
        expect(await session.getTopicsPage({offset:0,search:'missing'})).toMatchObject({topics:[],nextOffset:null,matched:0,total:5});
        await session.close();
    });
    it('rejects invalid topic requests and corrupted stored topic data without partial results', async () => {
        const session=await createMaterialPageSession(fake([material('a',{topics:['A']})]).repository);
        for (const options of [null, [], {offset:-1},{offset:2},{offset:1,search:'missing'},{offset:0,limit:0},{offset:0,limit:MATERIAL_TOPIC_PAGE_MAX_ITEMS+1},
            {offset:0,search:'x'.repeat(128*1024+1)},{offset:0,search:2},{offset:0,extra:true}]) {
            await expect(session.getTopicsPage(options as never)).rejects.toMatchObject({code:'invalid-input'});
        }
        for (const topics of [null,Array(31).fill('x'),['x'.repeat(81)],[123]]) {
            const f=fake([material('a',{topics:topics as never})]);
            await expect(createMaterialPageSession(f.repository)).rejects.toMatchObject({code:'storage-error'});
        }
        await session.close();
    });
    it('rejects stale or cancelled topic pages and retains independent session ownership', async () => {
        const f=fake([material('a',{topics:['first','second']})]);
        const first=await createMaterialPageSession(f.repository), second=await createMaterialPageSession(f.repository);
        const cancelled=new AbortController(); cancelled.abort();
        await expect(first.getTopicsPage({offset:0,signal:cancelled.signal})).rejects.toMatchObject({name:'AbortError'});
        expect((await first.getTopicsPage({offset:0})).topics).toEqual(['first','second']);
        await first.close();
        await expect(first.getTopicsPage({offset:0})).rejects.toMatchObject({name:'AbortError'});
        expect((await second.getTopicsPage({offset:0})).topics).toEqual(['first','second']);
        f.change();
        await expect(second.getTopicsPage({offset:0})).rejects.toMatchObject({code:'stale-operation'});
        await second.close();
    });
    it('discards a topic page if the material version changes after filtering', async () => {
        const f=fake([material('a',{topics:['one','two']})]);
        const session=await createMaterialPageSession(f.repository);
        f.repository.checkSnapshot.mockImplementationOnce(async()=>{}).mockImplementationOnce(async()=>{
            f.change();throw Object.assign(Error('changed'),{code:'stale-operation'});
        });
        await expect(session.getTopicsPage({offset:0,search:'o'})).rejects.toMatchObject({code:'stale-operation'});
        await session.close();
    });
    it('yields the event loop during topic sort so cancellation and concurrent writes take effect', async () => {
        const records=Array.from({length:160},(_,i)=>material(String(i).padStart(3,'0'),{
            topics:Array.from({length:30},(_,n)=>`topic-${i}-${n}`),
        }));
        const cancelled=new AbortController(), abortFixture=fake(records), progress=vi.fn();
        const abortTimer=setTimeout(()=>cancelled.abort(),0);
        try {
            await expect(createMaterialPageSession(abortFixture.repository,{},cancelled.signal,progress)).rejects.toMatchObject({name:'AbortError'});
            expect(progress).toHaveBeenCalledTimes(records.length);
        } finally {clearTimeout(abortTimer);}
        const changed=fake(records), changeTimer=setTimeout(()=>changed.change(),0);
        try {await expect(createMaterialPageSession(changed.repository)).rejects.toMatchObject({code:'stale-operation'});}
        finally {clearTimeout(changeTimer);}
    });
    it('allows topic-search cancellation during large filtering and then permits retry', async () => {
        const records=Array.from({length:160},(_,i)=>material(String(i).padStart(3,'0'),{
            topics:Array.from({length:30},(_,n)=>`topic-${i}-${n}`),
        }));
        const session=await createMaterialPageSession(fake(records).repository), controller=new AbortController();
        const timer=setTimeout(()=>controller.abort(),0);
        try {await expect(session.getTopicsPage({offset:0,search:'topic',signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});}
        finally {clearTimeout(timer);}
        const page=await session.getTopicsPage({offset:0,search:'topic'});
        expect(page.total).toBe(4800); expect(page.matched).toBe(4800); expect(page.topics).toHaveLength(100);
        await session.close();
    });
    it('keeps topics and material page requests within one session lease', async () => {
        const f=fake([material('a')]), session=await createMaterialPageSession(f.repository);
        let finish!:()=>void, began!:()=>void;
        const pending=new Promise<void>(resolve=>{finish=resolve;}), started=new Promise<void>(resolve=>{began=resolve;});
        f.repository.checkSnapshot.mockImplementationOnce(()=>{began();return pending;});
        const materialPage=session.getPage({offset:0}); await started;
        await expect(session.getTopicsPage({offset:0})).rejects.toMatchObject({code:'limit-exceeded'});
        finish(); await materialPage;
        expect((await session.getTopicsPage({offset:0})).topics).toEqual(['alpha']);
        await session.close();
    });
    it('sorts and pages the full 10,000 by 30 topic bound without retaining material bodies', async () => {
        const count=10000, ids=Array.from({length:count},(_,i)=>String(i).padStart(5,'0'));
        const repo={openSnapshot:async()=>({revision:1,epoch:'test-epoch',ids}), checkSnapshot:async()=>{},
            readSnapshotRecord:async (_revision:{revision:number;epoch:string},id:string)=>material(id,{
                source:{kind:'article',url:`https://private.test/${id}`},
                topics:Array.from({length:30},(_,i)=>`${id}-${String(i).padStart(2,'0')}`.padEnd(80,'x')),
                references:[{kind:'note',id:'private-note',note:'personal body'}],
            })};
        const [session,peer]=await Promise.all([createMaterialPageSession(repo),createMaterialPageSession(repo)]);
        const first=await session.getTopicsPage({offset:0,limit:100});
        expect(first.total).toBe(300000); expect(first.matched).toBe(300000); expect(first.nextOffset).toBe(100);
        expect(first.topics).toHaveLength(100); expect(first.topics.every(value=>value.length===80)).toBe(true);
        expect(JSON.stringify(first)).not.toContain('private.test'); expect(JSON.stringify(first)).not.toContain('personal body');
        const end=await session.getTopicsPage({offset:299999});
        expect(end.topics).toHaveLength(1); expect(end.nextOffset).toBeNull();
        await session.close();
        expect((await peer.getTopicsPage({offset:299999})).topics).toHaveLength(1);
        await peer.close();
    }, 30000);
    it('reports actual scanned records, including excluded records, and stops when progress cancels', async () => {
        const records = [material('a'), material('b', {archivedAt: 2}), material('c')];
        const {repository} = fake(records), progress = vi.fn();
        const session = await createMaterialPageSession(repository, {search:'missing'}, undefined, progress);
        expect(progress.mock.calls).toEqual([[1,3],[2,3],[3,3]]);
        expect(session.matched).toBe(0);
        await session.close();
        const controller = new AbortController(), second = fake(records);
        await expect(createMaterialPageSession(second.repository, {}, controller.signal, () => controller.abort())).rejects.toMatchObject({name:'AbortError'});
        expect(second.repository.readSnapshotRecord).toHaveBeenCalledTimes(1);
    });
    it('stops a scan when its progress observer throws and allows a fresh session', async () => {
        const f = fake([material('a'), material('b')]), failure = Error('progress callback failed');
        await expect(createMaterialPageSession(f.repository, {}, undefined, () => {throw failure;})).rejects.toBe(failure);
        expect(f.repository.readSnapshotRecord).toHaveBeenCalledTimes(1);
        const retry = await createMaterialPageSession(f.repository);
        expect((await retry.getPage({offset:0})).items.map(item => item.id)).toEqual(['a','b']);
        await retry.close();
    });
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
    it('fails snapshot construction or a page if a record is missing or has the wrong identity', async () => {
        for (const invalid of [null, material('wrong')]) {
            const f = fake([material('a')]);
            f.repository.readSnapshotRecord.mockResolvedValueOnce(invalid);
            await expect(createMaterialPageSession(f.repository)).rejects.toMatchObject({code:'storage-error'});
            const session = await createMaterialPageSession(f.repository);
            f.repository.readSnapshotRecord.mockResolvedValueOnce(invalid);
            await expect(session.getPage({offset:0})).rejects.toMatchObject({code:'storage-error'});
            await session.close();
        }
    });
    it('rejects a changed snapshot during index construction without publishing a session', async () => {
        const f = fake([material('a'),material('b')]);
        f.repository.readSnapshotRecord.mockImplementationOnce(async (_revision,id) => {f.change();return material(id);});
        await expect(createMaterialPageSession(f.repository)).rejects.toMatchObject({code:'stale-operation'});
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
        const repository = {openSnapshot:async () => ({revision:1,epoch:'test-epoch',ids:['a']}),
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
    it('keeps a topic page lease while its snapshot check settles after close', async () => {
        const f = fake([material('a',{topics:['alpha']})]), session = await createMaterialPageSession(f.repository);
        let finish!:()=>void, began!:()=>void;
        const pending = new Promise<void>(resolve=>{finish=resolve;}), started = new Promise<void>(resolve=>{began=resolve;});
        f.repository.checkSnapshot.mockImplementationOnce(() => {began(); return pending;});
        const topics = session.getTopicsPage({offset:0}), outcome = topics.catch(error=>error);
        await started;
        await expect(session.getPage({offset:0})).rejects.toMatchObject({code:'limit-exceeded'});
        let closed=false; const closing=session.close().then(()=>{closed=true;});
        await Promise.resolve(); expect(closed).toBe(false);
        finish(); await expect(outcome).resolves.toMatchObject({name:'AbortError'}); await closing;
        expect(closed).toBe(true); await expect(session.getTopicsPage({offset:0})).rejects.toMatchObject({name:'AbortError'});
    });
    it('cancels one page through its caller signal and permits a later retry', async () => {
        const f = fake([material('a')]), session = await createMaterialPageSession(f.repository);
        const already = new AbortController(); already.abort();
        const before = f.repository.checkSnapshot.mock.calls.length;
        await expect(session.getPage({offset:0,signal:already.signal})).rejects.toMatchObject({name:'AbortError'});
        expect(f.repository.checkSnapshot).toHaveBeenCalledTimes(before);
        let finish!:(value:MaterialRecord|null)=>void, began!:()=>void;
        const pending = new Promise<MaterialRecord|null>(resolve => {finish=resolve;}), started = new Promise<void>(resolve => {began=resolve;});
        f.repository.readSnapshotRecord.mockImplementationOnce(() => {began();return pending;});
        const caller = new AbortController(), page = session.getPage({offset:0,signal:caller.signal});
        const outcome = page.catch(error => error);
        await started; caller.abort(); finish(material('a'));
        await expect(outcome).resolves.toMatchObject({name:'AbortError'});
        expect((await session.getPage({offset:0})).items.map(item => item.id)).toEqual(['a']);
        await session.close();
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
