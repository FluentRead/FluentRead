import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {MaterialDatabase, MaterialRepository} from '@/src/features/vocabulary/materialRepository';
import {createStage} from '@/src/features/vocabulary/materialImportStage';
import {createMaterialImportCapability} from '@/src/features/vocabulary/materialImportPort';
import type {VocabularyEntry} from '@/src/features/vocabulary/learningModel';
import type {MaterialRecord} from '@/src/features/vocabulary/materialProtocol';

let serial = 0;
const databases: Dexie[] = [];
const names = new Set<string>();
function database(name = `material-revision-${++serial}`) {
    const db = new MaterialDatabase(name); databases.push(db); names.add(name); return db;
}
const source = (name: string) => ({kind: 'article' as const, url: `https://example.test/${name}`, title: name});
const capture = (repo: MaterialRepository, name: string, time = 10) => repo.capture({source: source(name), capturedAt: time}, time);
afterEach(async () => {for (const db of databases.splice(0)) db.close(); for (const name of names) await Dexie.delete(name); names.clear();});

it('native versionchange can rename stores without copying and isolate old Dexie writes', async () => {
    const name = `material-version-experiment-${++serial}`; names.add(name);
    const schema = {materials:'id,&identityKey,*aliases,updatedAt',meta:'key',stageFrames:'[session+seq]',stageSessions:'id,expiresAt',stageReceipts:'id,expiresAt',stageBudget:'key',stageStarts:'id,expiresAt'};
    const old = new Dexie(name); old.version(2).stores(schema); databases.push(old);
    const frame = {session:'session', seq:0, bytes:new Uint8Array([1,2,3])};
    await old.table('stageFrames').put(frame);
    await old.table('stageSessions').put({id:'session',expiresAt:500});
    await old.table('stageReceipts').put({id:'receipt',expiresAt:500});
    await old.table('stageBudget').put({key:'stage',slots:1,reserved:3,reservedFrames:1});
    await old.table('meta').put({key:'state',generation:3,migrated:true,clearedAt:1});
    let versionChanges = 0;
    old.on('versionchange', () => {versionChanges++;});
    await old.table('materials').put({id:'old-material',identityKey:'article:old'});
    // Dexie encodes schema version 3 as native IndexedDB version 30.
    await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(name, 30);
        request.onupgradeneeded = () => {
            request.transaction!.objectStore('materials').name = 'materialsV3';
            request.transaction!.objectStore('meta').name = 'metaV3';
        };
        request.onsuccess = () => {request.result.close(); resolve();};
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(Error('upgrade blocked'));
    });
    const newer = new Dexie(name);
    newer.version(2).stores(schema);
    newer.version(3).stores({...schema,materials:null,meta:null,materialsV3:schema.materials,metaV3:schema.meta});
    databases.push(newer);
    await newer.open();
    expect(versionChanges).toBe(1); expect(old.isOpen()).toBe(false);
    expect(await newer.table('stageFrames').get(['session',0])).toEqual(frame);
    expect(await newer.table('stageSessions').get('session')).toMatchObject({expiresAt:500});
    expect(await newer.table('stageReceipts').get('receipt')).toMatchObject({expiresAt:500});
    expect(await newer.table('stageBudget').get('stage')).toMatchObject({reserved:3});
    expect(await newer.table('metaV3').get('state')).toMatchObject({generation:3});
    expect(await newer.table('materialsV3').get('old-material')).toEqual({id:'old-material',identityKey:'article:old'});
    expect(await newer.table('materialsV3').where('identityKey').equals('article:old').first()).toMatchObject({id:'old-material'});
    // Dexie 自动补建缺失旧表：旧 worker 看不到原数据，却可能错误地报告写入成功。
    expect(await old.table('materials').get('old-material')).toBeUndefined();
    await old.table('meta').put({key:'state',generation:4});
    await old.table('materials').put({id:'extra',identityKey:'article:extra'});
    expect(await newer.table('materialsV3').get('extra')).toBeUndefined();
    expect(await newer.table('materialsV3').get('old-material')).toEqual({id:'old-material',identityKey:'article:old'});
    expect(await newer.table('metaV3').get('state')).toMatchObject({generation:3});
    await newer.table('metaV3').put({key:'state',generation:5});
    expect(await newer.table('metaV3').get('state')).toMatchObject({generation:5});
});

it('a sealed staging session survives an experimental native rename and can commit atomically', async () => {
    const name = `material-version-stage-${++serial}`; names.add(name);
    const schema = {materials:'id,&identityKey,*aliases,updatedAt',meta:'key',stageFrames:'[session+seq]',stageSessions:'id,expiresAt',stageReceipts:'id,expiresAt',stageBudget:'key',stageStarts:'id,expiresAt'};
    const old = new Dexie(name); old.version(2).stores(schema); databases.push(old);
    const item = await capture(new MaterialRepository(database()), 'stage-upgrade');
    const encoded = new TextEncoder().encode(JSON.stringify(item));
    const prefix = new Uint8Array([(encoded.length >>> 24) & 255, (encoded.length >>> 16) & 255, (encoded.length >>> 8) & 255, encoded.length & 255]);
    const digest = bytesToHex(sha256.create().update(prefix).update(encoded).digest());
    const token = createMaterialImportCapability(), oldToken = createMaterialImportCapability(), oldStage = createStage(old as MaterialDatabase, {clock:() => 100});
    await oldStage.beginRecoverable({records:1,frames:1,bytes:encoded.length,digest}, {generation:0,capturedAt:100}, token, {deadline:1000});
    await oldStage.append(token, {seq:0,record:0,part:0,total:1,recordBytes:encoded.length,bytes:encoded});
    await oldStage.seal(token);
    await oldStage.beginRecoverable({records:1,frames:1,bytes:encoded.length,digest}, {generation:0,capturedAt:100}, oldToken, {deadline:1000});
    await oldStage.append(oldToken, {seq:0,record:0,part:0,total:1,recordBytes:encoded.length,bytes:encoded});
    await oldStage.seal(oldToken);
    await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(name, 30);
        request.onupgradeneeded = () => {request.transaction!.objectStore('materials').name = 'materialsV3'; request.transaction!.objectStore('meta').name = 'metaV3';};
        request.onsuccess = () => {request.result.close(); resolve();};
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(Error('upgrade blocked'));
    });
    const newer = new Dexie(name); newer.version(2).stores(schema);
    newer.version(3).stores({...schema,materials:null,meta:null,materialsV3:schema.materials,metaV3:schema.meta});
    Object.assign(newer, {materials:newer.table('materialsV3'),meta:newer.table('metaV3')}); databases.push(newer);
    const repo = new MaterialRepository(newer as MaterialDatabase), stage = createStage(newer as MaterialDatabase, {clock:() => 100});
    // 旧 stage 重开后会对旧影子表提交，却共同消费新库仍在使用的回执。
    expect(await oldStage.commit(oldToken)).toEqual({inserted:1,updated:0,skipped:0});
    expect(await stage.status(oldToken)).toMatchObject({state:'committed',result:{inserted:1}});
    expect(await repo.get(item.id)).toBeNull(); expect(await repo.revision()).toBe(0);
    expect(await stage.commit(token)).toEqual({inserted:1,updated:0,skipped:0});
    expect(await repo.revision()).toBe(1); expect((await repo.get(item.id))?.title).toBe('stage-upgrade');
    expect(await stage.commit(token)).toEqual({inserted:1,updated:0,skipped:0}); expect(await repo.revision()).toBe(1);
});

describe('material snapshot revisions', () => {
    it('increments once for each material write and explicit clear, including conservative writes', async () => {
        const db = database(), repo = new MaterialRepository(db);
        expect(await repo.revision()).toBe(0);
        const item = await capture(repo, 'one'); expect(await repo.revision()).toBe(1);
        await repo.capture({source: source('one'), positionOnly: true, capturedAt: 9}, 20);
        expect(await repo.revision()).toBe(1);
        await repo.update(item.id, {title: 'new'}, 30); expect(await repo.revision()).toBe(2);
        await repo.removeReference(item.id, 'note', 'missing'); expect(await repo.revision()).toBe(3);
        await repo.archive(item.id); expect(await repo.revision()).toBe(4);
        await repo.restore(item.id); expect(await repo.revision()).toBe(5);
        await expect(repo.update('missing', {title: 'missing'})).rejects.toThrow();
        expect(await repo.revision()).toBe(5);
        await repo.clear(100); expect(await repo.revision()).toBe(6); expect(await repo.generation()).toBe(1);
        await repo.clear(101); expect(await repo.revision()).toBe(7); expect(await repo.generation()).toBe(2);
    });
    it('increments for a migration only when it writes and preserves old state', async () => {
        const db = database();
        await db.meta.put({key: 'state', generation: 4, migrated: false, clearedAt: 2});
        const entries = [{id:'v', contexts:[{sourceUrl:'https://example.test/legacy',text:'text',capturedAt:5}]}] as VocabularyEntry[];
        const repo = new MaterialRepository(db, async () => entries);
        expect(await repo.revision()).toBe(0);
        expect(await repo.list()).toHaveLength(1); expect(await repo.revision()).toBe(1);
        expect(await db.meta.get('state')).toMatchObject({generation:4,clearedAt:2,migrated:true,revision:1});
        await repo.list(); expect(await repo.revision()).toBe(1);
        const empty = database(), noEntries = new MaterialRepository(empty, async () => []);
        await noEntries.list(); expect(await noEntries.revision()).toBe(0);
        expect(await empty.meta.get('state')).toMatchObject({migrated:true});
    });
    it('fails migration on a damaged existing record without silently losing a private source association', async () => {
        const db = database(), seed = new MaterialRepository(db);
        const existing = await seed.capture({source:{kind:'article',url:'https://example.test/read?private=1'},
            reference:{kind:'vocabulary',id:'v',excerpt:'text'},capturedAt:10},10);
        const entries = [{id:'v',contexts:[{sourceUrl:'https://example.test/read',text:'text',capturedAt:5}]}] as VocabularyEntry[];
        const repo = new MaterialRepository(db, async () => entries);
        await db.materials.put({...existing,references:null} as never);
        await expect(repo.list()).rejects.toThrow();
        expect(await db.materials.count()).toBe(1);
        expect(await db.meta.get('state')).toMatchObject({migrated:false,revision:1});
        await db.materials.put(existing);
        const materials = await repo.list();
        expect(materials.map(item=>item.id)).toEqual([existing.id]);
        expect(await db.meta.get('state')).toMatchObject({migrated:true,revision:1});
    });
    it('propagates reading-hook failures and honors reading transformations without committing them', async () => {
        const db = database(), seed = new MaterialRepository(db);
        const existing = await seed.capture({source:{kind:'article',url:'https://example.test/original'},
            reference:{kind:'vocabulary',id:'v'},capturedAt:10},10);
        const entries = [{id:'v',contexts:[{sourceUrl:'https://alias-hook.test/',text:'text',capturedAt:5}]}] as VocabularyEntry[];
        const repo = new MaterialRepository(db,async()=>entries), failure = Error('reading hook failure');
        const fail = () => {throw failure;};
        db.materials.hook('reading',fail);
        try {await expect(repo.openSnapshot()).rejects.toBe(failure);}
        finally {db.materials.hook('reading').unsubscribe(fail);}
        expect(await db.materials.count()).toBe(1);
        expect(await db.meta.get('state')).toMatchObject({migrated:false,revision:1});
        const transform = (record: MaterialRecord) => ({...record,aliases:[...(record.aliases??[]),'article:https://alias-hook.test/']});
        db.materials.hook('reading',transform);
        try {
            const snapshot = await repo.openSnapshot();
            expect(snapshot.ids).toEqual([existing.id]); expect(snapshot.revision).toBe(1);
        } finally {db.materials.hook('reading').unsubscribe(transform);}
        expect((await db.materials.get(existing.id))?.aliases).toBeUndefined();
        expect(await db.meta.get('state')).toMatchObject({migrated:true,revision:1});
    });
    it('rolls back migrated records and revision when the meta write fails, then retries', async () => {
        const db = database(), entries = [{id:'v',contexts:[{sourceUrl:'https://example.test/legacy',text:'text',capturedAt:5}]}] as VocabularyEntry[];
        const repo = new MaterialRepository(db, async () => entries);
        const fail = () => {throw Error('injected meta storage failure');};
        db.meta.hook('creating', fail);
        try {await expect(repo.list()).rejects.toThrow('injected meta storage failure');}
        finally {db.meta.hook('creating').unsubscribe(fail);}
        expect(await db.materials.count()).toBe(0); expect(await db.meta.get('state')).toBeUndefined();
        expect(await repo.revision()).toBe(0);
        expect(await repo.list()).toHaveLength(1);
        expect(await db.meta.get('state')).toMatchObject({migrated:true,revision:1});
    });
    it('upgrades a version 1 database without changing its materials or generation', async () => {
        const name = `material-revision-old-${++serial}`; names.add(name);
        const existing = await capture(new MaterialRepository(database()), 'old-record');
        const old = new Dexie(name); old.version(1).stores({materials:'id,&identityKey,*aliases,updatedAt',meta:'key'});
        await old.table('meta').put({key:'state',generation:3,migrated:true,clearedAt:20});
        await old.table('materials').put(existing); old.close();
        const db = database(name), repo = new MaterialRepository(db);
        expect(await repo.revision()).toBe(0); expect(await repo.generation()).toBe(3);
        expect(await repo.get(existing.id)).toEqual(existing);
        await capture(repo, 'upgraded', 30);
        expect(await db.meta.get('state')).toEqual({key:'state',generation:3,migrated:true,clearedAt:20,revision:1});
    });
    it('updates an old material database that never had a metadata row', async () => {
        const name = `material-revision-no-meta-${++serial}`; names.add(name);
        const original = await capture(new MaterialRepository(database()), 'old-without-meta');
        const old = new Dexie(name); old.version(1).stores({materials:'id,&identityKey,*aliases,updatedAt',meta:'key'});
        try {
            await old.table('materials').put(original); expect(await old.table('meta').get('state')).toBeUndefined();
        } finally {old.close();}
        const db = database(name), repo = new MaterialRepository(db);
        const snapshot = await repo.openSnapshot();
        expect(snapshot).toMatchObject({revision:0,ids:[original.id],epoch:expect.any(String)});
        expect(await db.meta.get('state')).toMatchObject({snapshotEpoch:snapshot.epoch});
        await repo.update(original.id, {title:'updated after upgrade'}, 30);
        expect(await repo.get(original.id)).toMatchObject({title:'updated after upgrade',identityKey:original.identityKey});
        expect(await db.meta.get('state')).toMatchObject({generation:0,revision:1});
        await expect(repo.readSnapshotRecord(snapshot, original.id)).rejects.toMatchObject({code:'stale-operation'});
    });
    it('migrates legacy entries from an old database with no state before assigning the snapshot epoch', async () => {
        const name=`material-revision-migrate-no-meta-${++serial}`; names.add(name);
        const original=await capture(new MaterialRepository(database()),'legacy-without-state');
        const old=new Dexie(name);old.version(1).stores({materials:'id,&identityKey,*aliases,updatedAt',meta:'key'});
        await old.table('materials').put(original);old.close();
        const db=database(name), entries=[{id:'old-v',contexts:[{sourceUrl:'https://example.test/legacy-without-state',text:'legacy text',capturedAt:5}]}] as VocabularyEntry[];
        const repo=new MaterialRepository(db,async()=>entries);
        const snapshot=await repo.openSnapshot();
        expect(snapshot).toMatchObject({revision:1,ids:[original.id],epoch:expect.any(String)});
        expect(await db.meta.get('state')).toMatchObject({migrated:true,revision:1,snapshotEpoch:snapshot.epoch});
        expect((await repo.readSnapshotRecord(snapshot,original.id))?.references).toEqual(expect.arrayContaining([expect.objectContaining({id:'old-v'})]));
    });
    it('invalidates old snapshots when another connection recreates deleted state at the same revision', async () => {
        const db=database(), peer=database(db.name), repo=new MaterialRepository(db), other=new MaterialRepository(peer);
        const item=await capture(repo,'epoch-reuse');
        const before=await repo.openSnapshot();
        await peer.meta.delete('state');
        await other.update(item.id,{title:'changed after state loss'},30);
        expect(await other.revision()).toBe(before.revision);
        await expect(repo.readSnapshotRecord(before,item.id)).rejects.toMatchObject({code:'stale-operation'});
        await expect(repo.checkSnapshot(before)).rejects.toMatchObject({code:'stale-operation'});
        const after=await other.openSnapshot();
        expect(after.epoch).not.toBe(before.epoch);
        expect(await repo.readSnapshotRecord(after,item.id)).toMatchObject({title:'changed after state loss'});
        await expect(repo.checkSnapshot(before)).rejects.toMatchObject({code:'stale-operation'});
    });
    it('initializes one epoch for concurrent snapshots of a legacy state without one', async () => {
        const db=database(), peer=database(db.name), repo=new MaterialRepository(db), other=new MaterialRepository(peer);
        const item=await capture(repo,'concurrent-epoch');
        const [left,right]=await Promise.all([repo.openSnapshot(),other.openSnapshot()]);
        expect(left.epoch).toBe(right.epoch);
        expect(await other.readSnapshotRecord(left,item.id)).toEqual(item);
        expect(await repo.readSnapshotRecord(right,item.id)).toEqual(item);
    });
    it('opens later snapshots in a read-only transaction without rewriting metadata', async () => {
        const db=database(),repo=new MaterialRepository(db);
        await capture(repo,'readonly-epoch');const initial=await repo.openSnapshot();
        const put=vi.spyOn(db.meta,'put'),get=db.meta.get.bind(db.meta);let mode:string|undefined;
        const spy=vi.spyOn(db.meta,'get').mockImplementation((...args)=>{mode=Dexie.currentTransaction?.mode;return get(...args);});
        try {
            const next=await repo.openSnapshot();
            expect(next.epoch).toBe(initial.epoch);expect(mode).toBe('readonly');expect(put).not.toHaveBeenCalled();
        } finally {put.mockRestore();spy.mockRestore();}
    });
    it.each([null,'','x'.repeat(129),42])('rejects malformed stored snapshot identity %s',async epoch=>{
        const db=database(),repo=new MaterialRepository(db);
        await db.meta.put({key:'state',generation:0,migrated:true,clearedAt:0,revision:0,snapshotEpoch:epoch} as never);
        await expect(repo.openSnapshot()).rejects.toMatchObject({code:'storage-error'});
        expect(await db.meta.get('state')).toMatchObject({snapshotEpoch:epoch});
    });
    it('serializes writes from separate database connections', async () => {
        const a = database(), b = database(a.name), left = new MaterialRepository(a), right = new MaterialRepository(b);
        await Promise.all(Array.from({length:20}, (_, index) => capture(index % 2 ? left : right, `parallel-${index}`, 100)));
        expect(await left.revision()).toBe(20); expect(await right.revision()).toBe(20);
        expect(await a.materials.count()).toBe(20);
        await a.transaction('r', a.materials, a.meta, async () => {
            expect(await left.revision()).toBe(20); expect(await a.materials.count()).toBe(20);
        });
    });
    it('opens a migrated key-only snapshot and reads one record per checked transaction', async () => {
        const db = database(), seed = new MaterialRepository(db);
        const existing = await capture(seed, 'existing');
        const entries = [{id:'v',contexts:[{sourceUrl:'https://example.test/legacy',text:'text',capturedAt:5}]}] as VocabularyEntry[];
        const repo = new MaterialRepository(db, async () => entries);
        const noArray = vi.spyOn(db.materials, 'toArray').mockImplementation(() => {throw Error('full table read');});
        try {
            const snapshot = await repo.openSnapshot();
            expect(snapshot.revision).toBe(2); expect(snapshot.ids).toHaveLength(2);
            expect(snapshot.ids).toContain(existing.id);
            expect(await repo.readSnapshotRecord(snapshot, existing.id)).toEqual(existing);
            expect(await repo.readSnapshotRecord(snapshot, 'missing')).toBeNull();
            await repo.checkSnapshot(snapshot);
        } finally {noArray.mockRestore();}
    });
    it('invalidates snapshot reads and final checks after concurrent edit and clear', async () => {
        const db = database(), peer = database(db.name), repo = new MaterialRepository(db), other = new MaterialRepository(peer);
        const first = await capture(repo, 'first'), second = await capture(repo, 'second');
        const snapshot = await repo.openSnapshot();
        expect(await repo.readSnapshotRecord(snapshot, first.id)).toEqual(first);
        await other.update(second.id, {title:'changed'}, 30);
        await expect(repo.readSnapshotRecord(snapshot, second.id)).rejects.toMatchObject({code:'stale-operation'});
        await expect(repo.checkSnapshot(snapshot)).rejects.toMatchObject({code:'stale-operation'});
        const next = await repo.openSnapshot();
        await other.clear(100);
        await expect(repo.readSnapshotRecord(next, first.id)).rejects.toMatchObject({code:'stale-operation'});
        await expect(repo.checkSnapshot(next)).rejects.toMatchObject({code:'stale-operation'});
        const empty = await repo.openSnapshot(); expect(empty.ids).toEqual([]); await repo.checkSnapshot(empty);
    });
    it('bounds snapshot primary keys and validates snapshot arguments', async () => {
        const db = database(), repo = new MaterialRepository(db);
        await db.materials.bulkPut(Array.from({length:10001}, (_, i) => ({id:`id-${i}`,identityKey:`identity-${i}`})) as never);
        await expect(repo.openSnapshot()).rejects.toMatchObject({code:'limit-exceeded'});
        expect(await db.meta.get('state')).toBeUndefined();
        await expect(repo.checkSnapshot({revision:-1,epoch:'test'})).rejects.toMatchObject({code:'invalid-input'});
        await expect(repo.readSnapshotRecord({revision:0,epoch:'test'}, '')).rejects.toMatchObject({code:'invalid-input'});
    });
    it.each(['', 'x'.repeat(257)])('rejects a damaged stored snapshot key without exposing its record', async id => {
        const db = database(), repo = new MaterialRepository(db);
        await db.materials.put({id,identityKey:'article:damaged',title:'private damaged record'} as never);
        await expect(repo.openSnapshot()).rejects.toMatchObject({code:'storage-error'});
        expect(await db.materials.count()).toBe(1);
    });
    it('increments once per import, skips unchanged input and rolls back nested failures', async () => {
        const sourceDb = database(), sourceRepo = new MaterialRepository(sourceDb);
        const first = await capture(sourceRepo, 'first'), second = await capture(sourceRepo, 'second');
        const db = database(), repo = new MaterialRepository(db);
        expect(await repo.importRecords(async apply => {await apply(first); await apply(second);}, 100)).toEqual({inserted:2,updated:0,skipped:0});
        expect(await repo.revision()).toBe(1);
        await repo.importRecords(async apply => {await apply(first); await apply(null);}, 100);
        expect(await repo.revision()).toBe(1);
        await expect(db.transaction('rw', [db.materials, db.meta, db.table('stageReceipts')], async () => {
            await repo.importRecords(async apply => {await apply({...first, updatedAt:50, title:'changed'});}, 100);
            expect(await repo.revision()).toBe(2);
            throw Error('outer rollback');
        })).rejects.toThrow('outer rollback');
        expect(await repo.revision()).toBe(1); expect((await repo.get(first.id))?.title).toBe('first');
        await expect(repo.importRecords(async apply => {await apply({...first, updatedAt:50}); throw Error('abort');}, 100)).rejects.toThrow('abort');
        expect(await repo.revision()).toBe(1);
    });
    it('commits staged imports with the revision and does not increment on receipt replay', async () => {
        const origin = database(), item = await capture(new MaterialRepository(origin), 'staged');
        const db = database(), repo = new MaterialRepository(db), stage = createStage(db, {clock: () => 100});
        const encoded = new TextEncoder().encode(JSON.stringify(item));
        const prefix = new Uint8Array([(encoded.length >>> 24) & 255, (encoded.length >>> 16) & 255, (encoded.length >>> 8) & 255, encoded.length & 255]);
        const digest = bytesToHex(sha256.create().update(prefix).update(encoded).digest());
        const token = createMaterialImportCapability();
        await stage.beginRecoverable({records:1,frames:1,bytes:encoded.length,digest}, {generation:0,capturedAt:100}, token, {deadline:1000});
        await stage.append(token, {seq:0,record:0,part:0,total:1,recordBytes:encoded.length,bytes:encoded});
        await stage.seal(token);
        const receipts = db.table('stageReceipts');
        const fail = () => {throw Error('receipt failure');};
        receipts.hook('creating', fail);
        try {await expect(stage.commit(token)).rejects.toThrow('receipt failure');}
        finally {receipts.hook('creating').unsubscribe(fail);}
        expect(await repo.revision()).toBe(0); expect(await db.materials.count()).toBe(0);
        expect(await stage.commit(token)).toEqual({inserted:1,updated:0,skipped:0});
        expect(await repo.revision()).toBe(1);
        await stage.commit(token); expect(await repo.revision()).toBe(1);
    });
    it('rejects an import guarded before a clear on another connection without changing revision', async () => {
        const origin = database(), item = await capture(new MaterialRepository(origin), 'guarded');
        const db = database(), peer = database(db.name), repo = new MaterialRepository(db);
        const guard = {generation: await repo.generation(), capturedAt: 100};
        await new MaterialRepository(peer).clear(101);
        await expect(repo.importRecords(async apply => {await apply(item);}, 102, guard)).rejects.toMatchObject({code:'stale-operation'});
        expect(await repo.generation()).toBe(1); expect(await repo.revision()).toBe(1);
        expect(await db.materials.count()).toBe(0);
    });
    it('fails closed on invalid or exhausted versions and rolls back writes and clear', async () => {
        const db = database(), repo = new MaterialRepository(db), item = await capture(repo, 'one');
        for (const revision of [null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            await db.meta.put({key:'state',generation:0,migrated:true,clearedAt:0,revision} as never);
            await expect(repo.revision()).rejects.toThrow('材料版本无效');
            await expect(repo.update(item.id, {title:'changed'}, 30)).rejects.toThrow('材料版本无效');
            expect((await repo.get(item.id))?.title).toBe('one');
        }
        await db.meta.put({key:'state',generation:0,migrated:true,clearedAt:0,revision:Number.MAX_SAFE_INTEGER});
        await expect(repo.clear(100)).rejects.toThrow('材料版本已耗尽');
        expect(await db.materials.count()).toBe(1); expect(await repo.generation()).toBe(0);
    });
});

describe('snapshot transaction cancellation', () => {
    it.each(['before','after'] as const)('preserves snapshot success, failure and cancellation if signal cleanup throws %s removal',async mode=>{
        const db=database(),repo=new MaterialRepository(db),snapshot=await repo.openSnapshot(),controller=new AbortController();
        const native=controller.signal.removeEventListener.bind(controller.signal),original=Error('snapshot read failed');
        const remove=vi.spyOn(controller.signal,'removeEventListener').mockImplementation((type,listener,options)=>{
            if(mode==='after')native(type,listener,options);
            throw Error('signal cleanup failed');
        });
        try {
            await expect(repo.checkSnapshot(snapshot,controller.signal)).resolves.toBeUndefined();
            const get=vi.spyOn(db.meta,'get').mockRejectedValue(original as never);
            try {await expect(repo.checkSnapshot(snapshot,controller.signal)).rejects.toBe(original);}
            finally {get.mockRestore();}
            const cancelGet=vi.spyOn(db.meta,'get').mockImplementation(()=>{controller.abort();return Promise.reject(original) as never;});
            try {await expect(repo.checkSnapshot(snapshot,controller.signal)).rejects.toMatchObject({name:'AbortError'});}
            finally {cancelGet.mockRestore();}
            expect(remove).toHaveBeenCalled();
        } finally {remove.mockRestore();}
        await expect(repo.checkSnapshot(snapshot)).resolves.toBeUndefined();
    });
    it.each(['before','after'] as const)('cleans a listener when snapshot signal registration throws %s installation',async mode=>{
        const db=database(),repo=new MaterialRepository(db),snapshot=await repo.openSnapshot(),controller=new AbortController(),original=Error('signal registration failed');
        const nativeAdd=controller.signal.addEventListener.bind(controller.signal),nativeRemove=controller.signal.removeEventListener.bind(controller.signal);
        let installed=false;
        const add=vi.spyOn(controller.signal,'addEventListener').mockImplementation((type,listener,options)=>{
            if(mode==='after'){nativeAdd(type,listener,options);installed=true;}
            throw original;
        });
        const remove=vi.spyOn(controller.signal,'removeEventListener').mockImplementation((type,listener,options)=>{
            nativeRemove(type,listener,options);installed=false;
        });
        const transaction=vi.spyOn(db,'transaction');
        try {
            await expect(repo.checkSnapshot(snapshot,controller.signal)).rejects.toBe(original);
            expect(remove).toHaveBeenCalledWith('abort',expect.any(Function));expect(installed).toBe(false);
            expect(transaction).not.toHaveBeenCalled();
        } finally {add.mockRestore();remove.mockRestore();transaction.mockRestore();}
        await expect(repo.checkSnapshot(snapshot)).resolves.toBeUndefined();
    });
    it.each(['return','throw'] as const)('releases a snapshot listener installed after synchronous cancellation when registration will %s',async mode=>{
        const db=database(),repo=new MaterialRepository(db),snapshot=await repo.openSnapshot(),controller=new AbortController();
        const nativeAdd=controller.signal.addEventListener.bind(controller.signal),nativeRemove=controller.signal.removeEventListener.bind(controller.signal);
        let installed=false;
        const add=vi.spyOn(controller.signal,'addEventListener').mockImplementation((type,listener,options)=>{
            controller.abort();nativeAdd(type,listener,options);installed=true;
            if(mode==='throw')throw Error('signal registration failed');
        });
        const remove=vi.spyOn(controller.signal,'removeEventListener').mockImplementation((type,listener,options)=>{
            nativeRemove(type,listener,options);installed=false;
        });
        try {
            await expect(repo.checkSnapshot(snapshot,controller.signal)).rejects.toMatchObject({name:'AbortError'});
            expect(remove).toHaveBeenCalledWith('abort',expect.any(Function));expect(installed).toBe(false);
        } finally {add.mockRestore();remove.mockRestore();}
        await expect(repo.checkSnapshot(snapshot)).resolves.toBeUndefined();
    });
    it('preserves a snapshot registration error if inspecting cancellation also throws',async()=>{
        const db=database(),repo=new MaterialRepository(db),snapshot=await repo.openSnapshot(),controller=new AbortController(),original=Error('signal registration failed');
        const getter=vi.spyOn(controller.signal,'aborted','get').mockReturnValueOnce(false).mockImplementation(()=>{throw Error('signal state failed');});
        const add=vi.spyOn(controller.signal,'addEventListener').mockImplementation(()=>{throw original;});
        const remove=vi.spyOn(controller.signal,'removeEventListener');
        try {
            await expect(repo.checkSnapshot(snapshot,controller.signal)).rejects.toBe(original);
            expect(remove).toHaveBeenCalledWith('abort',expect.any(Function));
        } finally {getter.mockRestore();add.mockRestore();remove.mockRestore();}
    });
    it.each(['storage failure','cancellation'] as const)('releases the listener after a snapshot %s and allows retry',async outcome=>{
        const db=database(),repo=new MaterialRepository(db),controller=new AbortController();
        const snapshot=await repo.openSnapshot(),error=Error('snapshot storage failed');
        const remove=vi.spyOn(controller.signal,'removeEventListener');
        const get=vi.spyOn(db.meta,'get').mockImplementation(()=>{
            if(outcome==='cancellation')controller.abort();
            return Promise.reject(error) as never;
        });
        try {
            const read=repo.checkSnapshot(snapshot,controller.signal);
            if(outcome==='cancellation')await expect(read).rejects.toMatchObject({name:'AbortError'});
            else await expect(read).rejects.toBe(error);
            expect(remove).toHaveBeenCalledTimes(1);
            expect(remove).toHaveBeenCalledWith('abort',expect.any(Function));
        } finally {get.mockRestore();remove.mockRestore();}
        await expect(repo.checkSnapshot(snapshot)).resolves.toBeUndefined();
    });
    it('rolls back a first epoch initialization when its transaction is cancelled', async () => {
        const db=database(),repo=new MaterialRepository(db),controller=new AbortController();
        const put=db.meta.put.bind(db.meta);
        const spy=vi.spyOn(db.meta,'put').mockImplementation((...args)=>{
            const write=put(...args);
            Dexie.ignoreTransaction(()=>controller.abort());
            return write;
        });
        try {await expect(repo.openSnapshot(controller.signal)).rejects.toMatchObject({name:'AbortError'});}
        finally {spy.mockRestore();}
        expect(await db.meta.get('state')).toBeUndefined();
        const snapshot=await repo.openSnapshot();
        expect(await db.meta.get('state')).toMatchObject({snapshotEpoch:snapshot.epoch});
    });
    it('cancels at fake IndexedDB transaction completion without leaving the reader unusable', async () => {
        const db=database(),repo=new MaterialRepository(db),controller=new AbortController();
        const snapshot=await repo.openSnapshot();
        await db.open();
        const get=db.meta.get.bind(db.meta);let observedCompletion=false;
        const spy=vi.spyOn(db.meta,'get').mockImplementation((...args)=>{
            const native=Dexie.currentTransaction?.idbtrans;
            native?.addEventListener('complete',()=>{observedCompletion=true;controller.abort();},{capture:true,once:true});
            return get(...args);
        });
        try {
            await expect(repo.checkSnapshot(snapshot,controller.signal)).rejects.toMatchObject({name:'AbortError'});
            expect(observedCompletion).toBe(true);
        } finally {spy.mockRestore();}
        await expect(repo.checkSnapshot(snapshot)).resolves.toBeUndefined();
    });
    it('cancels a snapshot check while its database transaction is starting', async () => {
        const db=database(),repo=new MaterialRepository(db),controller=new AbortController();
        const snapshot=await repo.openSnapshot();
        const pending=repo.checkSnapshot(snapshot,controller.signal);
        controller.abort();
        await expect(pending).rejects.toMatchObject({name:'AbortError'});
        await expect(repo.checkSnapshot(snapshot)).resolves.toBeUndefined();
    });
    it.each(['open', 'record', 'check'] as const)('aborts a %s read blocked by a real IndexedDB writer and permits retry', async operation => {
        const db = database(), peer = database(db.name), repo = new MaterialRepository(db);
        const item = await capture(repo, `cancel-${operation}`), snapshot = await repo.openSnapshot();
        await peer.open();
        const writer = peer.backendDB().transaction(['materials','meta'], 'readwrite');
        const store = writer.objectStore('meta');
        let holding = true, first!:()=>void;
        const writerActive = new Promise<void>(resolve => {first=resolve;});
        const pump = () => {const request=store.get('state');request.onsuccess=()=>{first();if(holding)pump();};};
        pump();await writerActive;
        let requested!:()=>void;
        const queued = new Promise<void>(resolve => {requested=resolve;});
        const get = db.meta.get.bind(db.meta);
        const spy = vi.spyOn(db.meta,'get').mockImplementation((...args) => {Dexie.ignoreTransaction(requested);return get(...args);});
        const controller=new AbortController();
        const read = operation==='open' ? repo.openSnapshot(controller.signal)
            : operation==='record' ? repo.readSnapshotRecord(snapshot,item.id,controller.signal)
            : repo.checkSnapshot(snapshot,controller.signal);
        try {
            await queued;controller.abort();
            const outcome = await Promise.race([read.then(()=>'unexpected',error=>error.name),new Promise<string>(resolve=>setTimeout(()=>resolve('timeout'),1000))]);
            expect(outcome).toBe('AbortError');
        } finally {holding=false;try {writer.abort();} catch {} spy.mockRestore();}
        const retried=await repo.openSnapshot();
        expect(await repo.readSnapshotRecord(retried,item.id)).toEqual(item);
        await repo.checkSnapshot(retried);
    });
    it('waits for non-cooperative legacy storage and skips migration after cancellation', async () => {
        const db=database();let finish!:(value:VocabularyEntry[])=>void,started!:()=>void;
        const legacy=new Promise<VocabularyEntry[]>(resolve=>{finish=resolve;});
        const began=new Promise<void>(resolve=>{started=resolve;});
        const repo=new MaterialRepository(db,()=>{started();return legacy;});
        const controller=new AbortController();let settled=false;
        const result=repo.openSnapshot(controller.signal).finally(()=>{settled=true;});
        await began;controller.abort();await Promise.resolve();expect(settled).toBe(false);
        finish([{id:'v',contexts:[{sourceUrl:'https://example.test/legacy',text:'text',capturedAt:5}]}] as VocabularyEntry[]);
        await expect(result).rejects.toMatchObject({name:'AbortError'});
        expect(await db.materials.count()).toBe(0);expect((await db.meta.get('state'))?.migrated).not.toBe(true);
        const retried=await repo.openSnapshot();expect(retried.ids).toHaveLength(1);
    });
    it('rolls back an in-progress migration on cancellation and migrates on retry', async () => {
        const db=database(),controller=new AbortController();
        const entries=[{id:'v',contexts:[{sourceUrl:'https://example.test/migration',text:'text',capturedAt:5}]}] as VocabularyEntry[];
        const repo=new MaterialRepository(db,async()=>entries);
        const abort=()=>{Dexie.ignoreTransaction(()=>controller.abort());};
        db.materials.hook('creating',abort);
        try {await expect(repo.openSnapshot(controller.signal)).rejects.toMatchObject({name:'AbortError'});}
        finally {db.materials.hook('creating').unsubscribe(abort);}
        expect(await db.materials.count()).toBe(0);expect((await db.meta.get('state'))?.migrated).not.toBe(true);
        const retried=await repo.openSnapshot();expect(retried.ids).toHaveLength(1);expect(retried.revision).toBe(1);
    });
    it('fails before accessing a database when the signal is already aborted', async () => {
        const db=database(),repo=new MaterialRepository(db),controller=new AbortController();controller.abort();
        await expect(repo.openSnapshot(controller.signal)).rejects.toMatchObject({name:'AbortError'});
        await expect(repo.readSnapshotRecord({revision:0,epoch:'test'},'id',controller.signal)).rejects.toMatchObject({name:'AbortError'});
        await expect(repo.checkSnapshot({revision:0,epoch:'test'},controller.signal)).rejects.toMatchObject({name:'AbortError'});
        expect(db.isOpen()).toBe(false);
    });
});
