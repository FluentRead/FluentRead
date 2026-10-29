import 'fake-indexeddb/auto';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {MaterialDatabase, MaterialRepository} from '@/src/features/vocabulary/materialRepository';
import * as materialModel from '@/src/features/vocabulary/materialModel';
import {canonicalMaterialUrl, normalizeMaterialLocator, normalizeMaterialReference, normalizeMaterialSource, normalizeMaterialTopics} from '@/src/features/vocabulary/materialModel';
import {createMaterialBackgroundHandler} from '@/src/features/vocabulary/materialBackground';
import {MATERIAL_MESSAGE, type MaterialRequest} from '@/src/features/vocabulary/materialProtocol';
import type {VocabularyEntry} from '@/src/features/vocabulary/learningModel';
let db: MaterialDatabase;
let repository: MaterialRepository;
let sequence = 0;
const source = {kind: 'article' as const, url: 'https://example.test/read?id=1&utm_source=share', title: '相同标题'};
beforeEach(() => {db = new MaterialDatabase(`MaterialTest-${++sequence}`); repository = new MaterialRepository(db);});
afterEach(async () => {db.close(); await db.delete();});
describe('material identities and locators', () => {
    it('keeps semantic queries and SPA routes but strips tracking, fragments and resume ids', () => {
        expect(canonicalMaterialUrl('https://example.test/p?z=2&id=1&utm_medium=social&__fluentread_material=id#/article/1')).toBe('https://example.test/p?id=1&z=2#/article/1');
        expect(canonicalMaterialUrl('https://example.test/p#paragraph')).toBe('https://example.test/p');
        expect(normalizeMaterialSource(source).identityKey).not.toBe(normalizeMaterialSource({...source, url:'https://example.test/read?id=2'}).identityKey);
        for (const url of ['javascript:alert(1)', 'https://user:pass@example.test/', 'blob:https://example.test/a', 'invalid']) expect(canonicalMaterialUrl(url)).toBe('');
    });
    it('preserves long canonical URLs while bounding and rejecting noncanonical long inputs', () => {
        const path = 'https://example.test/' + '中'.repeat(1000);
        const canonical = canonicalMaterialUrl(path);
        expect(canonical.length).toBeGreaterThan(8192);
        expect(canonicalMaterialUrl(canonical)).toBe(canonical);
        const query = canonical + '?a=1&a=2&z=3#/chapter/一';
        // Routing fragments use the URL serializer's stored representation.
        const stored = new URL(query).href;
        expect(canonicalMaterialUrl(stored)).toBe(stored);
        for (const invalid of [
            canonical + '?z=1&a=1', canonical + '#paragraph', canonical + '?utm_source=x',
            canonical.replace('https://', 'https://user:pass@'),
            canonical.replace('https://', 'javascript:'),
            'https://example.test/' + 'a'.repeat(131100),
            'https://example.test/' + '中'.repeat(15000),
        ]) expect(canonicalMaterialUrl(invalid)).toBe('');
    });
    it('rejects an oversized tracking query before performing repeated deletions', () => {
        const input = 'https://example.test/?' + 'utm_source=x&'.repeat(8000);
        const remove = vi.spyOn(URLSearchParams.prototype, 'delete');
        try {expect(canonicalMaterialUrl(input)).toBe('');expect(remove).not.toHaveBeenCalled();}
        finally {remove.mockRestore();}
    });
    it('unifies YouTube platforms while preserving X multi-video identities', () => {
        const youtube = (url: string) => normalizeMaterialSource({kind:'video',url}).identityKey;
        expect(youtube('https://youtu.be/abcdefghijk?t=4')).toBe(youtube('https://music.youtube.com/watch?v=abcdefghijk&t=30'));
        expect(youtube('https://youtube.com/shorts/abcdefghijk')).toBe(youtube('https://www.youtube.com/watch?v=abcdefghijk'));
        expect(youtube('https://x.com/user/status/123/video/1')).not.toBe(youtube('https://x.com/user/status/123/video/2'));
        expect(youtube('https://twitter.com/user/status/123/video/1')).toBe(youtube('https://x.com/other/status/123/video/1'));
        expect(normalizeMaterialSource({kind:'video',url:'https://video.test/view?id=1&t=2'}).source.url).toBe('https://video.test/view?id=1');
    });
    it('uses document fingerprints independent of filenames and rejects location-less documents', () => {
        expect(normalizeMaterialSource({kind:'document',fingerprint:'sha256:a',title:'a.pdf'}).identityKey).toBe(normalizeMaterialSource({kind:'document',fingerprint:'sha256:a',title:'renamed.pdf'}).identityKey);
        expect(() => normalizeMaterialSource({kind:'document',url:'file:///a.pdf'})).toThrow('内容指纹');
        expect(() => normalizeMaterialSource({kind:'article'})).toThrow();
        expect(() => normalizeMaterialSource({kind:'bad'} as never)).toThrow();
    });
    it('bounds text, validates page/time ranges and rejects invalid themes and references', () => {
        expect(normalizeMaterialLocator({kind:'document',page:12,section:' 章节 ',quote:'x'.repeat(7000)})).toMatchObject({page:12,section:'章节',quote:'x'.repeat(6000)});
        expect(normalizeMaterialLocator(undefined)).toBeUndefined();
        expect(normalizeMaterialLocator({kind:'video',startMs:1234.8,endMs:2345.9})).toEqual({kind:'video',startMs:1234,endMs:2345});
        for (const locator of [{kind:'text',page:0},{kind:'video',startMs:-1},{kind:'video',startMs:30,endMs:20},{kind:'video',endMs:Infinity},{kind:'invalid'}]) expect(() => normalizeMaterialLocator(locator as never)).toThrow();
        expect(normalizeMaterialTopics([' ML ','ML',' AI '])).toEqual(['ML','AI']);
        for (const input of [null, [1], ['x'.repeat(81)], Array(31).fill('a')]) expect(() => normalizeMaterialTopics(input)).toThrow();
        expect(normalizeMaterialReference({kind:'note',id:'n',note:' hi ',createdAt:300},100)).toMatchObject({note:'hi',createdAt:100});
        expect(() => normalizeMaterialReference({kind:'unknown',id:'n'} as never,100)).toThrow();
    });
    it('normalizes each reference field once while preserving NFC, trimming and UTF-16 truncation', () => {
        const normalize = vi.spyOn(String.prototype, 'normalize');
        try {
            const reference = normalizeMaterialReference({
                kind: 'note', id: '  e\u0301\u0000  ',
                excerpt: `${'x'.repeat(5999)}😀 remaining`,
                note: `  ${'界'.repeat(12000)} more  `,
                createdAt: 150, updatedAt: 250,
            }, 200);
            expect(reference).toEqual({kind:'note',id:'é',excerpt:`${'x'.repeat(5999)}\ud83d`,note:'界'.repeat(12000),createdAt:150,updatedAt:200});
            expect(normalize).toHaveBeenCalledTimes(3);
        } finally {normalize.mockRestore();}
    });
    it('does not read private note content for non-note references or fields after an invalid identity', () => {
        const reference = {kind:'session' as const,id:'s',excerpt:' before '} as {kind:'session';id:string;excerpt:string;note?:string};
        Object.defineProperty(reference, 'note', {get() {throw Error('private note read');}});
        Object.defineProperty(reference, 'updatedAt', {get() {throw Error('private timestamp read');}});
        expect(normalizeMaterialReference(reference, 10)).toEqual({kind:'session',id:'s',excerpt:'before',createdAt:10});
        const invalid = {kind:'note' as const,id:'  '} as {kind:'note';id:string;excerpt?:string;note?:string};
        Object.defineProperty(invalid, 'excerpt', {get() {throw Error('unexpected excerpt read');}});
        Object.defineProperty(invalid, 'note', {get() {throw Error('unexpected note read');}});
        Object.defineProperty(invalid, 'updatedAt', {get() {throw Error('unexpected timestamp read');}});
        Object.defineProperty(invalid, 'createdAt', {get() {throw Error('unexpected timestamp read');}});
        expect(() => normalizeMaterialReference(invalid, 10)).toThrow('学习引用无效');
        expect(() => normalizeMaterialReference(null as never, 10)).toThrow('学习引用无效');
        expect(() => normalizeMaterialReference({kind:'unknown',id:'valid'} as never, 10)).toThrow('学习引用无效');
    });
    it('snapshots kind and timestamps before using them for validation and output', () => {
        let kinds = 0, createdReads = 0, updatedReads = 0;
        const reference = {
            get kind() {return ++kinds === 1 ? 'note' as const : 'session' as const;},
            id:'n', note:' private ',
            get createdAt() {return ++createdReads === 1 ? 5 : NaN;},
            get updatedAt() {return ++updatedReads === 1 ? 20 : NaN;},
        };
        expect(normalizeMaterialReference(reference, 10)).toEqual({kind:'note',id:'n',note:'private',updatedAt:10,createdAt:5});
        expect([kinds, createdReads, updatedReads]).toEqual([1, 1, 1]);

        let sessionKindReads = 0;
        const session = {
            get kind() {return ++sessionKindReads === 1 ? 'session' as const : 'note' as const;},
            id:'s', get note(): string {throw Error('private note read');},
            get updatedAt(): number {throw Error('private timestamp read');}, createdAt:0,
        };
        expect(normalizeMaterialReference(session, 10)).toEqual({kind:'session',id:'s',createdAt:0});
        expect(sessionKindReads).toBe(1);

        let invalidKindReads = 0;
        const invalid = {get kind() {return ++invalidKindReads === 1 ? 'invalid' : 'note';}, get id() {throw Error('unexpected id read');}};
        expect(() => normalizeMaterialReference(invalid as never, 10)).toThrow('学习引用无效');
        expect(invalidKindReads).toBe(1);
        for (const timestamp of [undefined, NaN, Infinity, -1, '5']) {
            expect(normalizeMaterialReference({kind:'note',id:'n',createdAt:timestamp,updatedAt:timestamp} as never, 10)).toEqual({kind:'note',id:'n',createdAt:10});
        }
        expect(normalizeMaterialReference({kind:'note',id:'n',createdAt:0,updatedAt:0}, 10)).toEqual({kind:'note',id:'n',createdAt:0,updatedAt:0});
    });
});
describe('local material lifecycle', () => {
    it('deduplicates sources atomically but keeps identical titles from different sources separate', async () => {
        const [a,b] = await Promise.all([repository.capture({source}), repository.capture({source:{...source,url:'https://example.test/read?id=1#p'}})]);
        expect(a.id).toBe(b.id);
        const other = await repository.capture({source:{...source,url:'https://other.test/read'}});
        expect(other.id).not.toBe(a.id);
        expect(await repository.list()).toHaveLength(2);
    });
    it('edits and removes notes by stable reference while preserving original capture time', async () => {
        const record = await repository.capture({source,reference:{kind:'note',id:'n',note:'first'}},100);
        await repository.capture({source,reference:{kind:'note',id:'n',note:'edited'}},200);
        expect((await repository.get(record.id))?.references).toEqual([{kind:'note',id:'n',note:'edited',createdAt:100,updatedAt:200}]);
        expect((await repository.removeReference(record.id,'note','n')).references).toEqual([]);
        await expect(repository.removeReference(record.id,'invalid' as never,'n')).rejects.toThrow();
    });
    it('does not resurrect a note deleted in another tab and rejects older edits while accepting fresh notes',async()=>{
        const otherTab = new MaterialRepository(db);
        const record = await repository.capture({source,reference:{kind:'note',id:'n',note:'original'},capturedAt:100},100);
        const generation = await repository.generation();
        const oldEdit = {source,reference:{kind:'note' as const,id:'n',note:'late edit'},referenceMode:'update-existing' as const,generation,capturedAt:150};
        await otherTab.removeReference(record.id,'note','n');
        await expect(repository.capture(oldEdit,300)).rejects.toMatchObject({code:'stale-operation'});
        expect((await repository.get(record.id))?.references).toEqual([]);
        expect(await repository.generation()).toBe(generation);
        await repository.capture({source,reference:{kind:'note',id:'fresh',note:'new'},capturedAt:400},400);
        await otherTab.capture({source,reference:{kind:'note',id:'fresh',note:'newer edit'},referenceMode:'update-existing',capturedAt:600},700);
        await expect(repository.capture({source,reference:{kind:'note',id:'fresh',note:'older edit'},referenceMode:'update-existing',capturedAt:500},800)).rejects.toMatchObject({code:'stale-operation'});
        expect((await repository.get(record.id))?.references).toEqual([{kind:'note',id:'fresh',note:'newer edit',createdAt:400,updatedAt:600}]);
        await repository.capture({source,reference:{kind:'session',id:'pending-session',excerpt:'Original'},generation,capturedAt:200},900);
        expect((await repository.get(record.id))?.references.some(reference=>reference.id==='pending-session')).toBe(true);
        await expect(repository.capture({source,referenceMode:'update-existing'})).rejects.toThrow('更新模式');
        await expect(repository.capture({source,reference:{kind:'note',id:'n'},referenceMode:'unknown'} as never)).rejects.toThrow('更新模式');
        const imported = (await repository.exportData()).materials[0];
        imported.references = [{kind:'note',id:'legacy',note:'old note',createdAt:100}];
        await db.materials.put(imported);
        await expect(repository.capture({source,reference:{kind:'note',id:'legacy',note:'older'},referenceMode:'update-existing',capturedAt:50},1000)).rejects.toThrow('更新的编辑');
        imported.references = [{kind:'note',id:'undated',note:'old note'}];
        await db.materials.put(imported);
        await repository.capture({source,reference:{kind:'note',id:'undated',note:'edited'},referenceMode:'update-existing',capturedAt:100},1000);
        expect((await repository.get(record.id))?.references[0].note).toBe('edited');
    });
    it('preserves note edit timestamps through private backups and discards untrusted edit clocks on other references',async()=>{
        expect(normalizeMaterialReference({kind:'note',id:'n',updatedAt:500},100)).toMatchObject({updatedAt:100});
        expect(normalizeMaterialReference({kind:'note',id:'n',updatedAt:-1},100).updatedAt).toBeUndefined();
        expect(normalizeMaterialReference({kind:'session',id:'s',updatedAt:100},200).updatedAt).toBeUndefined();
        const original = await repository.capture({source,reference:{kind:'note',id:'n',note:'current',updatedAt:999},capturedAt:100},200);
        expect(original.references[0].updatedAt).toBe(100);
        const backup = await repository.exportData(300);
        await repository.clear(400);
        await repository.importData(backup,500);
        expect((await repository.get(original.id))?.references[0].updatedAt).toBe(100);
    });
    it('restores a generated long hostname title after its source changes while keeping explicit titles bounded', async () => {
        const hostname = `${Array(4).fill('a'.repeat(60)).join('.')}.test`;
        const original = await repository.capture({source:{kind:'article',url:`https://${hostname}/article`}},100);
        expect(original.title).toBe(hostname);
        await repository.update(original.id,{source:{kind:'article',url:'https://moved.test/article'}},200);
        const explicit = await repository.capture({source:{kind:'article',url:'https://named.test/',title:'x'.repeat(300)}},100);
        expect(explicit.title).toBe('x'.repeat(240));
        expect((await repository.update(explicit.id,{title:'y'.repeat(300)},200)).title).toBe('y'.repeat(240));
        const directHost = `${Array(4).fill('b'.repeat(60)).join('.')}.test`;
        const direct = await repository.capture({source:{kind:'article',url:`https://${directHost}/article`}},100);

        const backup = await repository.exportData(300);
        const arbitrary = {...explicit,id:'arbitrary',source:{kind:'article' as const,url:'https://arbitrary.test/'},title:'not a host '.repeat(30)};
        const noncanonical = {...explicit,id:'noncanonical',source:{kind:'article' as const,url:'https://noncanonical.test/'},title:'A'.repeat(300)};
        const unrelated = {...explicit,id:'unrelated',source:{kind:'article' as const,url:'https://unrelated.test/'},title:`${Array(4).fill('c'.repeat(60)).join('.')}.test`};
        const missingHistory = {...original,id:'missing-history',source:{kind:'article' as const,url:'https://missing.test/'},aliases:[]};
        const oversized = {...explicit,id:'oversized',source:{kind:'article' as const,url:'https://oversized.test/'},title:'z'.repeat(8192 * 16 + 17)};
        await repository.clear(400);
        expect(await repository.importData({...backup,materials:[...backup.materials,arbitrary,noncanonical,unrelated,missingHistory,oversized]},500))
            .toEqual({inserted:8,updated:0,skipped:0});
        expect((await repository.get(original.id))?.title).toBe(hostname);
        expect((await repository.get(direct.id))?.title).toBe(directHost);
        expect((await repository.get(explicit.id))?.title).toBe('y'.repeat(240));
        expect((await repository.get('arbitrary'))?.title).toBe(arbitrary.title.trim().slice(0,240));
        expect((await repository.get('noncanonical'))?.title).toBe('A'.repeat(240));
        expect((await repository.get('unrelated'))?.title).toBe(unrelated.title.slice(0,240));
        expect((await repository.get('missing-history'))?.title).toBe(hostname.slice(0,240));
        expect((await repository.get('oversized'))?.title).toBe('z'.repeat(240));
        const secondBackup = await repository.exportData(600);
        await repository.clear(700);
        await repository.importData(secondBackup,800);
        expect((await repository.get(original.id))?.title).toBe(hostname);
        expect((await repository.get(direct.id))?.title).toBe(directHost);
    });
    it('bounds a document title when the previous URL cannot be proven from its fingerprint identity history', async () => {
        const hostname = `${Array(4).fill('d'.repeat(60)).join('.')}.test`;
        const original = await repository.capture({source:{kind:'document',fingerprint:'sha256:doc',url:`https://${hostname}/document`}},100);
        await repository.update(original.id,{source:{kind:'document',fingerprint:'sha256:doc',url:'https://moved.test/document'}},200);
        const backup = await repository.exportData(300);
        expect(backup.materials[0].aliases).toBeUndefined();
        await repository.clear(400);
        await repository.importData(backup,500);
        expect((await repository.get(original.id))?.title).toBe(hostname.slice(0,240));
    });
    it('filters topics/search/archive and preserves soft-deleted data during captures', async () => {
        const a = await repository.capture({source,locator:{kind:'text',quote:'原句'},reference:{kind:'note',id:'n',note:'a useful thought'}},100);
        await repository.update(a.id,{topics:['AI',' ML ','AI'],title:'Reading'});
        expect(await repository.list({topic:'ML',search:'thought'})).toHaveLength(1);
        expect(await repository.list({search:'absent'})).toHaveLength(0);
        await repository.archive(a.id);
        await repository.capture({source,locator:{kind:'text',quote:'迟到'},positionOnly:true},200);
        expect(await repository.list()).toHaveLength(0);
        expect((await repository.list({archived:true}))[0].locator?.quote).toBe('原句');
        const restored = await repository.restore(a.id);
        expect(restored.references[0].note).toBe('a useful thought');
        expect(restored.topics).toEqual(['AI','ML']);
    });
    it('preserves newer positions against delayed updates and refuses automatic creation', async () => {
        const a = await repository.capture({source,locator:{kind:'text',quote:'new'},capturedAt:200},300);
        await repository.capture({source,locator:{kind:'text',quote:'old'},capturedAt:100,positionOnly:true},400);
        expect((await repository.get(a.id))?.locator?.quote).toBe('new');
        await expect(repository.capture({source:{...source,url:'https://new.test/'},positionOnly:true})).rejects.toThrow('尚未收藏');
        await expect(repository.capture({source,capturedAt:Infinity})).rejects.toThrow();
        await expect(repository.capture({source,generation:-1})).rejects.toThrow();
    });
    it('relinks moved articles without losing links or allowing duplicate source takeover', async () => {
        const original = await repository.capture({source,reference:{kind:'vocabulary',id:'v',excerpt:'sentence'}});
        await repository.update(original.id,{topics:['AI']});
        const moved = await repository.update(original.id,{source:{...source,url:'https://new.test/moved'}});
        expect(moved.id).toBe(original.id); expect(moved.aliases).toContain(original.identityKey);
        expect((await repository.capture({source})).source.url).toBe('https://new.test/moved');
        expect(await repository.list()).toHaveLength(1);
        const other = await repository.capture({source:{...source,url:'https://other.test/'}});
        await expect(repository.update(other.id,{source})).rejects.toThrow('已属于另一份');
        await expect(repository.update(original.id,{source:{kind:'video',url:'https://video.test/a'}})).rejects.toThrow('类型不可更换');
        const doc = await repository.capture({source:{kind:'document',fingerprint:'a'}});
        await expect(repository.update(doc.id,{source:{kind:'document',fingerprint:'b'}})).rejects.toThrow('指纹相同');
    });
    it('does not revive cleared materials from delayed captures or legacy migration', async () => {
        const generation = await repository.generation();
        await repository.capture({source,generation},100);
        await repository.clear(200);
        expect(await repository.generation()).toBe(generation+1);
        await expect(repository.capture({source,generation},300)).rejects.toThrow('已清空');
        await expect(repository.capture({source,capturedAt:100},300)).rejects.toThrow('已清空');
        await repository.capture({source,capturedAt:301,generation:generation+1},301);
        expect(await repository.list()).toHaveLength(1);
    });
    it('lazily projects legacy contexts without modifying favorites or overwriting live reading position', async () => {
        const entry = {id:'v',contexts:[{sourceUrl:source.url,pageTitle:'Legacy',text:'Original',capturedAt:100},{sourceUrl:'invalid',text:'skip',capturedAt:100}]} as VocabularyEntry;
        const legacy = vi.fn(async () => [entry]);
        const r = new MaterialRepository(db,legacy);
        const current = await r.capture({source,locator:{kind:'text',quote:'Current'}},200);
        const result = await r.list();
        expect(result[0].id).toBe(current.id); expect(result[0].locator?.quote).toBe('Current');
        expect(result[0].references[0]).toMatchObject({kind:'vocabulary',id:'v',excerpt:'Original'});
        expect(entry.contexts[0].text).toBe('Original');
        await r.list(); expect(legacy).toHaveBeenCalledTimes(1);
        await r.clear(); await r.list(); expect(legacy).toHaveBeenCalledTimes(1);
    });
    it('indexes large existing materials one cursor record at a time and preserves source matching', async () => {
        const seed = await repository.capture({source}, 100);
        const records = Array.from({length:12}, (_, index) => ({...seed, id:`material-${String(index).padStart(2,'0')}`,
            identityKey:`article:https://example.test/read?id=${index}`, source:{...seed.source,url:`https://example.test/read?id=${index}`},
            references:[{kind:'vocabulary' as const,id:'shared',excerpt:'existing',createdAt:1},
                ...Array.from({length:80}, (_, n)=>({kind:'note' as const,id:`note-${n}`,note:'x'.repeat(12000),createdAt:1}))]})).reverse();
        await db.materials.clear(); await db.materials.bulkPut(records);
        const context = [{id:'shared',contexts:[{sourceUrl:'https://example.test/read',text:'duplicate',capturedAt:10},
            {sourceUrl:'https://another.test/source',text:'separate',capturedAt:11}]}] as VocabularyEntry[];
        const toCollection = db.materials.toCollection.bind(db.materials), seen:string[]=[];
        let eachCalls=0;
        const cursor = vi.spyOn(db.materials,'toCollection').mockImplementation(()=>{
            const collection=toCollection(), each=collection.each.bind(collection);
            collection.each=callback=>{eachCalls++;return each((value,cursor)=>{seen.push(value.id);return callback(value,cursor);});};
            return collection;
        });
        const all = vi.spyOn(db.materials,'toArray');
        try {
            const rows = await new MaterialRepository(db,async()=>context).list();
            expect(eachCalls).toBe(1); expect(all).toHaveBeenCalledOnce(); // Final list, not migration.
            expect(seen).toEqual(records.map(record=>record.id).sort());
            expect(rows).toHaveLength(13);
            for (const record of records) expect(rows.find(row=>row.id===record.id)).toEqual(record);
            expect(rows.find(row=>row.source.url==='https://another.test/source')?.references).toMatchObject([{kind:'vocabulary',id:'shared',excerpt:'separate'}]);
            expect(rows.some(row=>row.source.url==='https://example.test/read')).toBe(false);
        } finally {cursor.mockRestore();all.mockRestore();}
    });
    it('propagates corrupt cursor records and leaves migration uncommitted so repair can retry', async () => {
        const current=await repository.capture({source,reference:{kind:'vocabulary',id:'v'}},100);
        await db.materials.update(current.id,{references:null} as never);
        await db.materials.put({...current,id:'z-after-corrupt',identityKey:'article:https://after.test/',source:{kind:'article',url:'https://after.test/'}});
        const legacy=[{id:'new',contexts:[{sourceUrl:'https://legacy-retry.test/',text:'saved',capturedAt:10}]}] as VocabularyEntry[];
        const migrated=new MaterialRepository(db,async()=>legacy), seen:string[]=[];
        const toCollection=db.materials.toCollection.bind(db.materials);
        const cursor=vi.spyOn(db.materials,'toCollection').mockImplementation(()=>{
            const collection=toCollection(), each=collection.each.bind(collection);
            collection.each=callback=>each((value,key)=>{seen.push(value.id);return callback(value,key);});return collection;
        });
        try {await expect(migrated.list()).rejects.toBeInstanceOf(TypeError);} finally {cursor.mockRestore();}
        expect(seen).toEqual([current.id]);
        expect((await db.meta.get('state'))?.migrated).not.toBe(true);
        expect(await db.materials.count()).toBe(2);
        expect((await db.materials.get(current.id))?.references).toBeNull();
        await db.materials.update(current.id,{references:current.references});
        expect(await migrated.list()).toHaveLength(3);expect((await db.meta.get('state'))?.migrated).toBe(true);
    });
    it('preserves reading-hook transformations and propagates hook failures without committing migration', async () => {
        const current=await repository.capture({source,reference:{kind:'vocabulary',id:'v'}},100);
        const legacy=[{id:'v',contexts:[{sourceUrl:'https://alias-hook.test/',text:'matched alias',capturedAt:10}]}] as VocabularyEntry[];
        const migrated=new MaterialRepository(db,async()=>legacy);
        const error=Error('reading hook failed');
        const fail=()=>{throw error;};db.materials.hook('reading',fail);
        try {await expect(migrated.list()).rejects.toBe(error);} finally {db.materials.hook('reading').unsubscribe(fail);}
        expect((await db.meta.get('state'))?.migrated).not.toBe(true);expect(await db.materials.count()).toBe(1);
        const addAlias=(record:typeof current)=>({...record,aliases:[...(record.aliases??[]),'article:https://alias-hook.test/']});
        db.materials.hook('reading',addAlias);
        try {const rows=await migrated.list();expect(rows).toHaveLength(1);expect(rows[0].id).toBe(current.id);}
        finally {db.materials.hook('reading').unsubscribe(addAlias);}
        expect((await db.materials.get(current.id))?.aliases).toBeUndefined();
    });
    it('rolls back earlier migration writes and the migration marker after a later write fails', async () => {
        const legacy=[{id:'v',contexts:[{sourceUrl:'https://migration-rollback.test/first',text:'one',capturedAt:1},
            {sourceUrl:'https://migration-rollback.test/second',text:'two',capturedAt:2}]}] as VocabularyEntry[];
        const migrated=new MaterialRepository(db,async()=>legacy), put=db.materials.put.bind(db.materials);
        let writes=0;
        const failure=vi.spyOn(db.materials,'put').mockImplementation((...args)=>{if(++writes===2)return Promise.reject(Error('second write failed')) as ReturnType<typeof put>;return put(...args);});
        try {await expect(migrated.list()).rejects.toThrow('second write failed');} finally {failure.mockRestore();}
        expect(writes).toBe(2);expect(await db.materials.count()).toBe(0);expect((await db.meta.get('state'))?.migrated).not.toBe(true);
        expect(await migrated.list()).toHaveLength(2);
    });
    it('does not remigrate a newly linked vocabulary context under its privacy-stripped URL', async () => {
        const entry = {id:'new-vocabulary',contexts:[{sourceUrl:'https://example.test/read',text:'Original translated context',capturedAt:100}]} as VocabularyEntry;
        const r = new MaterialRepository(db,async () => [entry]);
        const current = await r.capture({source,locator:{kind:'text',quote:'Original'},reference:{kind:'vocabulary',id:entry.id,excerpt:'Original'}},100);
        const result = await r.list();
        expect(result).toHaveLength(1);expect(result[0].id).toBe(current.id);
        expect(result[0].locator?.quote).toBe('Original');
        expect(result[0].source.url).toBe('https://example.test/read?id=1');
    });
    it('does not suppress a legacy vocabulary entry just because another reference kind has the same id', async () => {
        const entry = {id:'shared-id',contexts:[{sourceUrl:'https://elsewhere.test/source',text:'Legacy original',capturedAt:100}]} as VocabularyEntry;
        const r = new MaterialRepository(db,async () => [entry]);
        await r.capture({source,reference:{kind:'session',id:entry.id,excerpt:'Legacy original'}},100);
        expect(await r.list()).toHaveLength(2);
    });
    it('indexes linked vocabulary sources once without swallowing another context or merging distinct query identities', async () => {
        const contexts = ['https://example.test/read','https://example.test/other','https://elsewhere.test/read','https://example.test/read?id=3'].map(sourceUrl => ({sourceUrl,text:'Same term',capturedAt:100}));
        const r = new MaterialRepository(db,async () => [{id:'v',contexts}] as VocabularyEntry[]);
        const first = await r.capture({source,locator:{kind:'text',quote:'Exact one'},reference:{kind:'vocabulary',id:'v'}},100);
        const second = await r.capture({source:{...source,url:'https://example.test/read?id=2'},locator:{kind:'text',quote:'Exact two'},reference:{kind:'vocabulary',id:'v'}},101);
        const rows = await r.list();expect(rows).toHaveLength(5);
        expect(rows.find(row => row.id === first.id)?.locator?.quote).toBe('Exact one');
        expect(rows.find(row => row.id === second.id)?.locator?.quote).toBe('Exact two');
        expect(rows.map(row => row.source.url)).toEqual(expect.arrayContaining(['https://example.test/other','https://elsewhere.test/read','https://example.test/read?id=3']));
    });
    it('matches linked aliases, canonical video identities and real document source URLs while retaining unrelated local contexts', async () => {
        const legacy = [
            {id:'article',contexts:[{sourceUrl:'https://example.test/read',text:'old article',capturedAt:100}]},
            {id:'video',contexts:[{sourceUrl:'https://youtu.be/abcdefghijk',text:'old video',capturedAt:100,video:{platform:'youtube',startMs:1000,endMs:2000}},{sourceUrl:'https://youtube.com/watch?v=bbbbbbbbbbb',text:'other video',capturedAt:100,video:{platform:'youtube',startMs:1000,endMs:2000}}]},
            {id:'document',contexts:[{sourceUrl:'https://files.test/book.pdf',text:'document excerpt',capturedAt:100}]},
            {id:'local',contexts:[{text:'local no source',capturedAt:100},{sourceUrl:'https://elsewhere.test/reading',text:'other reading',capturedAt:100}]},
        ] as VocabularyEntry[];
        const r = new MaterialRepository(db,async () => legacy);
        const article = await r.capture({source,reference:{kind:'vocabulary',id:'article'}},100);
        await r.update(article.id,{source:{...source,url:'https://moved.test/new'}});
        await r.capture({source:{kind:'video',url:'https://youtube.com/watch?v=abcdefghijk'},reference:{kind:'vocabulary',id:'video'}},100);
        await r.capture({source:{kind:'document',fingerprint:'remote',url:'https://files.test/book.pdf?edition=2'},reference:{kind:'vocabulary',id:'document'}},100);
        await r.capture({source:{kind:'document',fingerprint:'local'},reference:{kind:'vocabulary',id:'local'}},100);
        const rows = await r.list();expect(rows).toHaveLength(6);
        expect(rows.filter(row => row.references.some(ref => ref.id === 'document'))).toHaveLength(1);
        expect(rows.some(row => row.kind === 'article' && row.source.url === 'https://elsewhere.test/reading')).toBe(true);
    });
    it('ignores damaged stored article aliases without manufacturing a compatibility source', async () => {
        const r = new MaterialRepository(db,async () => [{id:'v',contexts:[{sourceUrl:'https://elsewhere.test/read',text:'Legacy original',capturedAt:100}]}] as VocabularyEntry[]);
        const current = await r.capture({source,reference:{kind:'vocabulary',id:'v'}},100);
        await db.materials.update(current.id,{aliases:['article:invalid']});
        expect(await r.list()).toHaveLength(2);
    });
    it('cancels in-flight migration after clear', async () => {
        let resolve!: (entries: VocabularyEntry[]) => void;
        const pending = new Promise<VocabularyEntry[]>(done => {resolve=done;});
        const r = new MaterialRepository(db,() => pending);
        const list = r.list();
        await new Promise(done=>setTimeout(done,10));
        await r.clear();
        resolve([{id:'v',contexts:[{sourceUrl:source.url,text:'Old',capturedAt:100}]} as VocabularyEntry]);
        expect(await list).toEqual([]);
    });
    it('retains locator excerpts but strips copied authority content from non-note references and imported backups',async()=>{
        const kinds = ['session','memory','vocabulary'] as const;
        for (const kind of kinds) {
            expect(normalizeMaterialReference({kind,id:kind,excerpt:'  Original source paragraph  ',note:'private authority content'},100)).toEqual({kind,id:kind,excerpt:'Original source paragraph',createdAt:100});
            await repository.capture({source,reference:{kind,id:kind,excerpt:'Original source paragraph',note:'private authority content'}},100);
        }
        const record = (await repository.list())[0];
        expect(record.references.every(reference=>reference.note===undefined)).toBe(true);
        expect(record.references.every(reference=>reference.excerpt==='Original source paragraph')).toBe(true);
        const backup = await repository.exportData(150);
        backup.materials[0].references = [
            ...kinds.map(kind=>({kind,id:kind,excerpt:'Original source paragraph',note:'old backup authority content'})),
            {kind:'note',id:'personal-note',note:'  Personal material note  ',excerpt:'Original source paragraph'},
        ];
        await repository.clear(200);
        expect(await repository.importData(backup,300)).toEqual({inserted:1,updated:0,skipped:0});
        const restored = (await repository.list())[0];
        expect(restored.references.filter(reference=>reference.kind!=='note').every(reference=>reference.note===undefined && reference.excerpt==='Original source paragraph')).toBe(true);
        expect(restored.references.find(reference=>reference.kind==='note')).toMatchObject({note:'Personal material note',excerpt:'Original source paragraph'});
    });
    it('round trips private material backups including topics, edited notes, archives and source history', async () => {
        const original = await repository.capture({source,reference:{kind:'note',id:'n',note:'private personal note'},locator:{kind:'text',quote:'private paragraph'}},100);
        await repository.update(original.id,{topics:['AI'],source:{...source,url:'https://moved.test/article'}},200);
        await repository.archive(original.id);
        const backup = await repository.exportData();
        expect(backup.materials[0]).toMatchObject({topics:['AI'],references:[{note:'private personal note'}],source:{url:'https://moved.test/article'}});
        await repository.clear();
        expect(await repository.importData(backup)).toEqual({inserted:1,updated:0,skipped:0});
        expect((await repository.list({archived:true}))[0]).toMatchObject({id:original.id,topics:['AI'],locator:{quote:'private paragraph'}});
        expect((await repository.capture({source})).id).toBe(original.id);
        expect(await repository.importData(backup)).toEqual({inserted:0,updated:0,skipped:1});
    });
    it('round trips long multilingual URLs and historical aliases through an actual backup',async()=>{
        const originalUrl = 'https://example.test/' + '中'.repeat(1000);
        const original = await repository.capture({source:{kind:'article',url:originalUrl,title:'中文材料'}},100);
        expect(original.source.url!.length).toBeGreaterThan(8192);
        const firstBackup = JSON.parse(JSON.stringify(await repository.exportData(150)));
        await repository.clear(200);
        expect(await repository.importData(firstBackup,250)).toEqual({inserted:1,updated:0,skipped:0});
        expect(await repository.get(original.id)).toMatchObject({source:{url:original.source.url},identityKey:original.identityKey});
        expect((await repository.capture({source:{kind:'article',url:originalUrl}},260)).id).toBe(original.id);

        await repository.update(original.id,{source:{kind:'article',url:'https://example.test/moved',title:'中文材料'}},300);
        const secondBackup = JSON.parse(JSON.stringify(await repository.exportData(350)));
        expect(secondBackup.materials[0].aliases).toContain(original.identityKey);
        await repository.clear(400);
        expect(await repository.importData(secondBackup,450)).toEqual({inserted:1,updated:0,skipped:0});
        expect((await repository.capture({source:{kind:'article',url:originalUrl}},460)).id).toBe(original.id);
        expect((await repository.get(original.id))?.aliases).toContain(original.identityKey);
        // 用户在已有材料上编辑来源后，其百分号编码地址也必须能再次导入。
        await repository.update(original.id,{source:{kind:'article',url:originalUrl,title:'中文材料'}},500);
        const thirdBackup = JSON.parse(JSON.stringify(await repository.exportData(550)));
        await repository.clear(600);
        expect(await repository.importData(thirdBackup,650)).toEqual({inserted:1,updated:0,skipped:0});
        expect(await repository.get(original.id)).toMatchObject({source:{url:original.source.url},identityKey:original.identityKey});
        expect((await repository.capture({source:{kind:'article',url:'https://example.test/moved'}},660)).id).toBe(original.id);
    });
    it('rejects a backup read started before clear while allowing a new explicit restore',async()=>{
        await repository.capture({source},100);
        const backup = await repository.exportData(150);
        const guard = {generation:await repository.generation(),capturedAt:150};
        await repository.clear(200);
        await expect(repository.importData(backup,300,guard)).rejects.toThrow('导入期间');
        await expect(repository.importData(backup,300,{generation:1,capturedAt:150})).rejects.toThrow('导入期间');
        expect(await repository.importData(backup,300,{generation:1,capturedAt:250})).toEqual({inserted:1,updated:0,skipped:0});
        for (const invalid of [null,{generation:-1,capturedAt:250},{generation:1.5,capturedAt:250},{generation:1,capturedAt:Infinity},{generation:1,capturedAt:-1},{generation:1,capturedAt:70000}]) await expect(repository.importData(backup,300,invalid as never)).rejects.toThrow('导入操作无效');
    });
    it('does not overwrite newer deletions with an old backup and validates imported identities', async () => {
        const a = await repository.capture({source,reference:{kind:'note',id:'n',note:'old'}},100);
        const backup = await repository.exportData(100);
        await repository.removeReference(a.id,'note','n');
        expect(await repository.importData(backup)).toEqual({inserted:0,updated:0,skipped:1});
        expect((await repository.get(a.id))?.references).toEqual([]);
        await expect(repository.importData({format:'unknown',materials:[]})).rejects.toThrow('备份格式');
        await expect(repository.importData(null)).rejects.toThrow('备份无效');
        const invalid = {...backup,materials:[{...backup.materials[0],aliases:['article:https://secret.test/?utm_source=not-canonical']}, {...backup.materials[0],references:[{kind:'unknown',id:'x'}]}]};
        expect(await repository.importData(invalid)).toEqual({inserted:0,updated:0,skipped:2});
    });
    it('imports newer snapshots and skips aliases owned by another material', async () => {
        const a = await repository.capture({source},100);
        const b = await repository.capture({source:{...source,url:'https://other.test/'}},100);
        const backup = await repository.exportData(200);
        backup.materials = [{...a,title:'New title',topics:['New'],updatedAt:300}];
        expect(await repository.importData(backup,400)).toEqual({inserted:0,updated:1,skipped:0});
        expect((await repository.get(a.id))?.title).toBe('New title');
        backup.materials = [{...a,aliases:[b.identityKey],updatedAt:500}];
        expect(await repository.importData(backup,600)).toEqual({inserted:0,updated:0,skipped:1});
        backup.materials = [{...b,id:a.id,source:{...source,url:'https://third.test/'},updatedAt:700}];
        expect(await repository.importData(backup,800)).toEqual({inserted:1,updated:0,skipped:0});
        expect((await repository.list()).find(record=>record.source.url==='https://third.test/')?.id).not.toBe(a.id);
    });
    it('returns typed invalid and missing-record errors instead of creating records', async () => {
        await expect(repository.get('')).rejects.toThrow('标识');
        expect(await repository.get('missing')).toBeNull();
        await expect(repository.update('missing',{})).rejects.toThrow('不存在');
        const record = await repository.capture({source});
        await expect(repository.update(record.id,{title:' '})).rejects.toThrow('不能为空');
        await expect(repository.update(record.id,null as never)).rejects.toThrow();
        await expect(repository.list([] as never)).rejects.toThrow();
    });
});
describe('material capacity, migration and backup edge contracts', () => {
    it('counts capacity once for a batch import while preserving every inserted material', async () => {
        const template = await repository.capture({source}, 100);
        await db.materials.clear();
        const materials = Array.from({length: 128}, (_, index) => ({...template,
            id: `batch-${index}`, source: {...source, url: `https://batch.test/${index}`},
        }));
        const count = vi.spyOn(db.materials, 'count');
        expect(await repository.importData({format: 'fluentread-learning-materials', version: 1, materials}, 200))
            .toEqual({inserted: 128, updated: 0, skipped: 0});
        expect(await db.materials.toArray()).toHaveLength(128);
        expect(count).toHaveBeenCalledTimes(1);
    });
    it('counts capacity once for legacy migration and preserves all references', async () => {
        const legacy = Array.from({length: 128}, (_, index) => ({id: `legacy-${index}`,
            contexts: [{sourceUrl: `https://legacy-batch.test/${index}`, text: 'saved phrase', capturedAt: 1}],
        })) as VocabularyEntry[];
        const count = vi.spyOn(db.materials, 'count');
        const records = await new MaterialRepository(db, async () => legacy).list();
        expect(records).toHaveLength(128);
        expect(records.every(record => record.references.length === 1)).toBe(true);
        expect(count).toHaveBeenCalledTimes(1);
    });
    it('tracks new identities within a nearly full import without counting updates twice', async () => {
        const template = await repository.capture({source}, 100);
        const count = vi.spyOn(db.materials, 'count').mockResolvedValue(10000).mockResolvedValueOnce(9999);
        const first = {...template, id: 'last-slot', source: {...source, url: 'https://batch.test/last'}, updatedAt: 200};
        const materials = [first, {...first, title: 'newer same source', updatedAt: 300},
            {...template, id: 'overflow', source: {...source, url: 'https://batch.test/overflow'}, updatedAt: 200},
            {...template, title: 'updated existing', updatedAt: 300}];
        expect(await repository.importData({format: 'fluentread-learning-materials', version: 1, materials}, 400))
            .toEqual({inserted: 1, updated: 2, skipped: 1});
        expect((await db.materials.toArray()).map(record => record.title).sort())
            .toEqual(['newer same source', 'updated existing']);
        expect(count).toHaveBeenCalledTimes(1);
    });
    it('keeps migration capacity local to its transaction and allows existing-reference updates', async () => {
        await repository.capture({source}, 100);
        const count = vi.spyOn(db.materials, 'count').mockResolvedValue(10000).mockResolvedValueOnce(9999);
        const legacy = [{id: 'legacy', contexts: [
            {sourceUrl: 'https://legacy-batch.test/last', text: 'first', capturedAt: 1},
            {sourceUrl: 'https://legacy-batch.test/last', text: 'duplicate', capturedAt: 2},
            {sourceUrl: 'https://legacy-batch.test/overflow', text: 'overflow', capturedAt: 3},
            {sourceUrl: source.url, text: 'existing', capturedAt: 4},
        ]}] as VocabularyEntry[];
        const records = await new MaterialRepository(db, async () => legacy).list();
        expect(records).toHaveLength(2);
        expect(records.every(record => record.references.length === 1)).toBe(true);
        expect(count).toHaveBeenCalledTimes(1);
    });
    it('rolls back a failed bulk import and recounts capacity on retry', async () => {
        const template = await repository.capture({source}, 100);
        await db.materials.clear();
        const materials = [0, 1].map(index => ({...template, id: `retry-${index}`,
            source: {...source, url: `https://retry.test/${index}`}}));
        const backup = {format: 'fluentread-learning-materials', version: 1, materials};
        const count = vi.spyOn(db.materials, 'count');
        const originalPut = db.materials.put.bind(db.materials);
        const put = vi.spyOn(db.materials, 'put').mockImplementationOnce(record => originalPut(record))
            .mockRejectedValueOnce(new Error('storage failed'));
        await expect(repository.importData(backup, 200)).rejects.toThrow('storage failed');
        expect(await db.materials.toArray()).toHaveLength(0);
        put.mockRestore();
        expect(await repository.importData(backup, 200)).toEqual({inserted: 2, updated: 0, skipped: 0});
        expect(count).toHaveBeenCalledTimes(2);
        expect(await db.materials.toArray()).toHaveLength(2);
    });
    it('does not read capacity for update-only or invalid imports', async () => {
        const template = await repository.capture({source}, 100);
        const count = vi.spyOn(db.materials, 'count');
        const materials = [{...template, title: 'new title', updatedAt: 200}, null];
        expect(await repository.importData({format: 'fluentread-learning-materials', version: 1, materials}, 300))
            .toEqual({inserted: 0, updated: 1, skipped: 1});
        expect(count).not.toHaveBeenCalled();
    });
    it('migrates missing-title articles and original video positions once, skipping location-free and duplicate contexts', async () => {
        const legacy = [{id:'v',contexts:[
            {text:'word only',capturedAt:1},
            {sourceUrl:'https://legacy.test/',text:'paragraph',capturedAt:2},
            {sourceUrl:'https://legacy.test/',text:'duplicate',capturedAt:3},
            {sourceUrl:'https://youtube.com/watch?v=abcdefghijk',pageTitle:'Video',text:'subtitle',capturedAt:4,video:{platform:'youtube',startMs:1000,endMs:2000}},
        ]}] as VocabularyEntry[];
        const r = new MaterialRepository(db,async()=>legacy);
        expect(await r.list()).toHaveLength(2);
        expect((await r.list()).find(record=>record.kind==='video')).toMatchObject({locator:{kind:'video',startMs:1000},title:'Video'});
        expect((await r.list()).find(record=>record.kind==='article')).toMatchObject({title:'legacy.test',references:[{excerpt:'paragraph'}]});
        expect(await r.list({search:'paragraph'})).toHaveLength(1);
    });
    it('enforces record, reference and source-history limits without discarding existing data', async () => {
        const record = await repository.capture({source});
        record.references = Array.from({length:1000},(_,i)=>({kind:'note' as const,id:`n${i}`,note:'existing'}));
        record.aliases = Array.from({length:100},(_,i)=>`article:https://old.test/${i}`);
        await db.materials.put(record);
        await expect(repository.capture({source,reference:{kind:'note',id:'overflow',note:'new'}})).rejects.toThrow('记录已达上限');
        await expect(repository.update(record.id,{source:{...source,url:'https://new.test/'}})).rejects.toThrow('恢复次数');
        const count = vi.spyOn(db.materials,'count').mockResolvedValue(10000);
        await expect(repository.capture({source:{...source,url:'https://overflow.test/'}})).rejects.toThrow('材料数量');
        const backup = {format:'fluentread-learning-materials',version:1,exportedAt:1,materials:[{...record,source:{...source,url:'https://import-overflow.test/'},aliases:[]}]};
        expect(await repository.importData(backup)).toEqual({inserted:0,updated:0,skipped:1});
        const r = new MaterialRepository(db,async()=>[{id:'extra',contexts:[{sourceUrl:'https://migration-overflow.test/',text:'skip',capturedAt:1},{sourceUrl:source.url,text:'skip reference',capturedAt:1}]}] as VocabularyEntry[]);
        expect(await r.list()).toHaveLength(1);
        expect((await r.get(record.id))?.references).toHaveLength(1000);
        count.mockRestore();
    });
    it('searches local document notes and orders equal positions deterministically', async()=>{
        const a = await repository.capture({source:{kind:'document',fingerprint:'local'},reference:{kind:'note',id:'n',note:'Note only'}},100);
        expect(a.title).toBe('本地文档');
        const b = await repository.capture({source:{...source,title:undefined}},100);
        expect(b.title).toBe('example.test');
        expect(await repository.list({search:'Note only'})).toHaveLength(1);
        expect(await repository.list({search:'not present'})).toHaveLength(0);
        expect(await repository.list({topic:'missing'})).toHaveLength(0);
        expect((await repository.list()).map(record=>record.id)).toEqual([a.id,b.id].sort());
        await repository.update(a.id,{locator:{kind:'document',page:3}},200);
        expect((await repository.get(a.id))?.lastReadAt).toBe(200);
        await expect(repository.capture(null as never)).rejects.toThrow('采集内容');
    });
    it('preserves aliases through another relink and allows a same-source metadata refresh', async()=>{
        const a = await repository.capture({source});
        await repository.update(a.id,{source});
        await repository.update(a.id,{source:{...source,url:'https://new.test/a'}});
        const returned = await repository.update(a.id,{source});
        expect(returned.aliases).toEqual(['article:https://new.test/a']);
        const backed = await repository.exportData();
        backed.materials[0].updatedAt = Date.now()+1;
        expect(await repository.importData(backed,Date.now()+2)).toMatchObject({updated:1});
    });
    it('rejects malformed backup records individually and restores video source history and absent ids safely', async()=>{
        const a = await repository.capture({source},100);
        const backup = await repository.exportData();
        const invalid = [null,{}, {...a,title:''},{...a,aliases:Array(101).fill('x')},{...a,aliases:['video:youtube:abcdefghijk']}, {...a,aliases:[5]}, {...a,references:[{kind:'note',id:'n'},{kind:'note',id:'n'}]}];
        expect(await repository.importData({...backup,materials:invalid})).toEqual({inserted:0,updated:0,skipped:7});
        const videos = [
            {...a,id:'',source:{kind:'video',url:'https://youtube.com/watch?v=abcdefghijk'},aliases:['video:youtube:zyxwvutsrqp'],updatedAt:undefined,createdAt:undefined,lastReadAt:undefined,archivedAt:undefined},
            {...a,id:'x-video',source:{kind:'video',url:'https://x.com/user/status/123'},aliases:['video:x:456/video/2']},
            {...a,id:'generic-video',source:{kind:'video',url:'https://media.test/video?id=1'},aliases:['video:https://media.test/video?id=2']},
        ];
        expect(await repository.importData({...backup,materials:videos})).toEqual({inserted:3,updated:0,skipped:0});
        expect((await repository.list({archived:true}))[0].id).not.toBe('');
        expect(normalizeMaterialSource({kind:'video',url:'https://x.com/user/status/123'}).identityKey).toBe('video:x:123');
        expect(normalizeMaterialLocator({kind:'video',endMs:100})).toEqual({kind:'video',endMs:100});
    });
    it('aborts imports whose generation changed before writing and propagates unexpected repository failures', async()=>{
        const a = await repository.capture({source},100);
        const backup = await repository.exportData();
        vi.spyOn(repository,'generation').mockResolvedValueOnce(99);
        await expect(repository.importData(backup)).rejects.toThrow('导入期间');
        const sourceError = vi.spyOn(materialModel,'normalizeMaterialSource').mockImplementationOnce(()=>{throw new Error('unexpected');});
        await expect(repository.importData({...backup,materials:[a]})).rejects.toThrow('unexpected');
        sourceError.mockRestore();
        const r = new MaterialRepository(db,async()=>[{id:'new',contexts:[{sourceUrl:'https://legacy-fail.test/',text:'source',capturedAt:1}]}] as VocabularyEntry[]);
        const put = vi.spyOn(db.materials,'put').mockRejectedValueOnce(new Error('storage unavailable'));
        await expect(r.list()).rejects.toThrow('storage unavailable');
        put.mockRestore();
    });
});
describe('material background privacy and source boundary', () => {
    function handler(overrides = {}) {
        return createMaterialBackgroundHandler({repository,ready:Promise.resolve(),isPrivateContext:()=>false,isExtensionUrl:(url:string)=>url.startsWith('chrome-extension://test/'),canCapture:()=>true,changed:vi.fn(),...overrides});
    }
    const ui = {sender:{url:'chrome-extension://test/options.html'}};
    const page = {sender:{url:'https://example.test/read?id=1',tab:{url:'https://example.test/read?id=1'}}};
    const message = (action:string,values={}) => ({type:MATERIAL_MESSAGE,action,...values} as MaterialRequest);
    it('prevents private windows reading or writing local learning records', async () => {
        for (const action of ['list','capture','generation','clear']) expect(await handler().handle(message(action,{input:{source}}),{sender:{...ui.sender,tab:{incognito:true}}})).toMatchObject({success:false,error:{code:'privacy-disabled'}});
        expect(await handler({isPrivateContext:()=>true}).handle(message('list'),ui)).toMatchObject({success:false,error:{code:'privacy-disabled'}});
        expect(await repository.list()).toEqual([]);
    });
    it('allows content capture and resolve only for its actual source', async () => {
        const saved = await handler().handle(message('capture',{input:{source}}),page);
        expect(saved.success).toBe(true);
        if (!saved.success) return;
        const id = (saved.data as {id:string}).id;
        expect(await handler().handle(message('resolve',{id}),page)).toMatchObject({success:true,data:{id}});
        const other = {sender:{url:'https://other.test/'}};
        expect(await handler().handle(message('resolve',{id}),other)).toMatchObject({success:false,error:{code:'privacy-disabled'}});
        expect(await handler().handle(message('capture',{input:{source}}),other)).toMatchObject({success:false,error:{code:'privacy-disabled'}});
        expect(await handler().handle(message('list'),page)).toMatchObject({success:false,error:{code:'privacy-disabled'}});
        expect(await handler().handle(message('get',{id}),page)).toMatchObject({success:false,error:{code:'privacy-disabled'}});
        expect(await handler().handle(message('resolve',{id:'missing'}),page)).toEqual({success:true,data:null});
        await repository.archive(id);
        expect(await handler().handle(message('resolve',{id}),page)).toEqual({success:true,data:null});
    });
    it('enforces capture settings, hides unexpected storage failure details and survives failed notifications', async () => {
        expect(await handler({canCapture:()=>false}).handle(message('capture',{input:{source}}),ui)).toMatchObject({success:false,error:{code:'privacy-disabled'}});
        expect(await handler({changed:()=>{throw Error('notify');}}).handle(message('capture',{input:{source}}),ui)).toMatchObject({success:true});
        const failed = handler({repository:{list:()=>{throw Error('private source secret');}} as unknown as MaterialRepository});
        expect(await failed.handle(message('list'),ui)).toEqual({success:false,error:{code:'storage-error',message:'本地学习材料暂时不可用，请重试'}});
        expect(await handler().handle(message('unknown'),ui)).toMatchObject({success:false,error:{code:'invalid-input'}});
    });
    it('connects an X feed video to its strict status source while rejecting other sites and article exceptions',async()=>{
        const h = handler();
        const videoSource = {kind:'video',url:'https://x.com/alice/status/123/video/2'};
        const feed = {sender:{url:'https://x.com/home'}};
        const saved = await h.handle(message('capture',{input:{source:videoSource,locator:{kind:'video',startMs:1000}}}),feed);
        expect(saved).toMatchObject({success:true,data:{identityKey:'video:x:123/video/2'}});
        if (!saved.success) return;
        const id = (saved.data as {id:string}).id;
        for (const url of ['https://x.com/home','https://twitter.com/home','https://mobile.twitter.com/search?q=video']) expect(await h.handle(message('resolve',{id}),{sender:{url}})).toMatchObject({success:true,data:{id}});
        expect(await h.handle(message('resolve',{id}),{sender:{url:'https://malicious.test/'}})).toMatchObject({success:false,error:{code:'privacy-disabled'}});
        expect(await h.handle(message('capture',{input:{source:videoSource}}),{sender:{url:'https://malicious.test/'}})).toMatchObject({success:false,error:{code:'privacy-disabled'}});
        expect(await h.handle(message('capture',{input:{source:{...videoSource,kind:'article'}}}),feed)).toMatchObject({success:false,error:{code:'privacy-disabled'}});
        expect(await h.handle(message('capture',{input:{source:{kind:'video',url:'https://youtube.com/watch?v=abcdefghijk'}}}),{sender:{url:'https://example.test/'}})).toMatchObject({success:false,error:{code:'privacy-disabled'}});
        for (const url of ['invalid','https://user:password@x.com/home','https://x.com:8080/home','file:///home']) expect(await h.handle(message('capture',{input:{source:videoSource}}),{sender:{url}})).toMatchObject({success:false});
        for (const url of ['https://x.com/home','https://youtube.com/results?search_query=video','https://youtu.be/short']) expect(()=>normalizeMaterialSource({kind:'video',url})).toThrow('具体的视频');
    });
    it('supports extension backup operations and sender tab-url fallback without exposing records to unidentified senders', async()=>{
        const h = handler();
        await repository.capture({source});
        const exported = await h.handle(message('exportData'),ui);
        expect(exported).toMatchObject({success:true,data:{format:'fluentread-learning-materials'}});
        expect(await h.handle(message('list',{options:{archived:false}}),ui)).toMatchObject({success:true});
        if (exported.success) expect(await h.handle(message('importData',{data:exported.data}),ui)).toMatchObject({success:true});
        const tabOnly = {sender:{tab:{url:'https://example.test/read?id=1'}}};
        expect(await h.handle(message('capture',{input:{source,reference:{kind:'note',id:'n',note:'n'}}}),tabOnly)).toMatchObject({success:true});
        expect(await h.handle(message('capture'),ui)).toMatchObject({success:false,error:{code:'invalid-input'}});
        expect(await h.handle(message('list'),{sender:{}})).toMatchObject({success:false,error:{code:'privacy-disabled'}});
        expect(await h.handle(message('list'),{})).toMatchObject({success:false,error:{code:'privacy-disabled'}});
    });
    it('manages full lifecycle only through extension pages', async () => {
        const record = await repository.capture({source});
        const h = handler();
        expect(await h.handle(message('update',{id:record.id,patch:{title:'Updated'}}),ui)).toMatchObject({success:true,data:{title:'Updated'}});
        expect(await h.handle(message('archive',{id:record.id}),ui)).toMatchObject({success:true});
        expect(await h.handle(message('restore',{id:record.id}),ui)).toMatchObject({success:true,data:{archivedAt:null}});
        expect(await h.handle(message('removeReference',{id:record.id,kind:'note',referenceId:'n'}),ui)).toMatchObject({success:true});
        expect(await h.handle(message('get',{id:record.id}),ui)).toMatchObject({success:true,data:{id:record.id}});
        expect(await h.handle(message('generation'),page)).toEqual({success:true,data:0});
        expect(await h.handle(message('clear'),ui)).toEqual({success:true,data:true});
    });
});
