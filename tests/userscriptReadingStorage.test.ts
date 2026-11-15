import {afterEach, describe, expect, it, vi} from 'vitest';
import {createUserscriptReadingStorage, type UserscriptReadingStoragePort} from '@/userscript/readingStorage';
import {HARNESS_SESSION_TTL_MS} from '@/src/services/harness/sessions';
import type {HarnessStoredTurn} from '@/src/services/harness/sessionTypes';

const NOW = 1_800_000_000_000;
const prefix = 'fluentread:reading:v1:operation:';
const memoryId = (number: number) => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
function deferred() {let resolve!: () => void; const promise = new Promise<void>(yes => {resolve = yes;}); return {promise, resolve};}
function fixture() {
    const values = new Map<string, unknown>();
    let sequence = 0, clock = NOW, memorySequence = 0;
    const storage: UserscriptReadingStoragePort = {
        get: vi.fn(async key => values.has(key) ? structuredClone(values.get(key)) : null),
        set: vi.fn(async (key, value) => {values.set(key, structuredClone(value));}),
        remove: vi.fn(async key => {values.delete(key);}),
        list: vi.fn(async () => [...values.keys()]),
    };
    const create = (extra: Parameters<typeof createUserscriptReadingStorage>[0] = {}) => createUserscriptReadingStorage({
        storage, now: () => clock, operationId: () => `operation-${++sequence}`, id: () => memoryId(++memorySequence), ...extra,
    });
    return {values, storage, create, time: (value: number) => {clock = value;}};
}
const header = (id = 'session-1', updatedAt = NOW) => ({id, text: 'Readable source', context: 'Context', createdAt: NOW, updatedAt, intent: 'meaning' as const});
const turn = (id = 'turn-1', patch: Partial<HarnessStoredTurn> = {}): HarnessStoredTurn => ({id, question: 'Meaning?', answer: 'An answer',
    intent: 'meaning', status: 'completed', createdAt: NOW, service: 'openai', model: 'fixture-model', ...patch});
const tick = async () => {for (let count = 0; count < 20; count++) await Promise.resolve();};
afterEach(() => {vi.unstubAllGlobals(); vi.restoreAllMocks();});

describe('userscript GM 阅读会话', () => {
    it('does not revive a stale previous snapshot across clear when a current edit loses a duplicate-content conflict',async()=>{
        const f=fixture(),api=f.create();await api.ready;await api.memories.clear();
        const winner=await api.memories.save({kind:'note',content:'original B'});
        const losing=await api.memories.save({kind:'note',content:'original A'});
        await api.memories.save({id:losing.id,kind:'note',content:'shared'});
        const rows=[...f.values.values()] as any[];
        expect(rows.some(row=>row.kind==='memories-clear')).toBe(true);
        const current=rows.find(row=>row.kind==='memory-save'&&row.memory.id===losing.id&&row.memory.content==='shared');
        const other=rows.find(row=>row.kind==='memory-save'&&row.memory.id===winner.id);
        expect(current.previous).toBeDefined();current.previous.fence=[];other.memory.content='shared';
        const visible=await api.memories.list();expect(visible.map(memory=>memory.id)).toEqual([winner.id]);
        expect(visible[0].content).toBe('shared');
    });
    it('只写专用GM命名空间和白名单，保持更新合并、摘要分页及读取对象隔离', async () => {
        const f = fixture(); const api = f.create(); await api.ready;
        f.values.set('local:config', {credential: 'must-stay-outside-reading'});
        const token = api.sessions.captureGeneration('session-1');
        await expect(api.sessions.upsertTurn({...header(), credential: 'discard'} as never, {...turn(), url: 'discard'} as never, token)).resolves.toBe(true);
        await expect(api.sessions.upsertTurn(header(), turn('turn-2', {status: 'streaming', answer: 'partial'}), token)).resolves.toBe(true);
        const saved = await api.sessions.get('session-1');
        expect(saved).toMatchObject({text: 'Readable source', turns: [{id: 'turn-1', status: 'completed'}, {id: 'turn-2', status: 'stopped'}]});
        saved!.turns[0].answer = 'mutated reader';
        expect((await api.sessions.get('session-1'))!.turns[0].answer).toBe('An answer');
        await api.sessions.upsertTurn(header(), turn('turn-1', {answer: 'replacement'}), token);
        expect((await api.sessions.get('session-1'))!.turns).toHaveLength(2);
        expect([...f.values.values()].filter(row => (row as any).kind === 'session-turn')).toHaveLength(2);
        const other = header('session-2', NOW + 1);
        await api.sessions.upsertTurn(other, turn('turn-3'), api.sessions.captureGeneration(other.id));
        expect(await api.sessions.list(0, 1)).toEqual({sessions: [{id: other.id, text: other.text, intent: other.intent, updatedAt: NOW + 1, turnCount: 1}], hasMore: true});
        expect((await api.sessions.list(1, 1)).sessions[0].id).toBe('session-1');
        expect((await api.sessions.list(-1, 0)).sessions).toHaveLength(2);
        expect((await api.sessions.list(0, 101)).hasMore).toBe(false);
        expect(await api.sessions.get('missing')).toBeNull();
        expect(JSON.stringify([...f.values.entries()].filter(([key]) => key.startsWith(prefix)))).not.toContain('discard');
        expect(f.values.get('local:config')).toEqual({credential: 'must-stay-outside-reading'});
    });

    it('两个独立标签并发写入同会话不同turn不互相覆盖，分隔符ID也保持独立', async () => {
        const f = fixture(); const a = f.create(), b = f.create(); await Promise.all([a.ready, b.ready]);
        const start = deferred(); const originalSet = f.storage.set;
        f.storage.set = vi.fn(async (key, value) => {await start.promise; await originalSet(key, value);});
        const writes = [a.sessions.upsertTurn(header(), turn('a'), a.sessions.captureGeneration('session-1')),
            b.sessions.upsertTurn(header(), turn('b'), b.sessions.captureGeneration('session-1'))];
        await tick(); start.resolve();
        expect(await Promise.all(writes)).toEqual([true, true]);
        expect((await a.sessions.get('session-1'))!.turns.map(item => item.id)).toEqual(['a', 'b']);
        await a.sessions.upsertTurn(header('a:b'), turn('c'), a.sessions.captureGeneration('a:b'));
        await a.sessions.upsertTurn(header('a'), turn('b:c'), a.sessions.captureGeneration('a'));
        expect((await a.sessions.get('a:b'))!.turns[0].id).toBe('c');
        expect((await a.sessions.get('a'))!.turns[0].id).toBe('b:c');
        expect((await a.sessions.list()).sessions.map(item => item.id)).toEqual(['a', 'a:b', 'session-1']);
    });

    it.each(['delete', 'clear'] as const)('%s 同步废弃本地token且跨标签墓碑阻止GM迟到提交复活', async action => {
        const f = fixture(); const a = f.create(), b = f.create(); await Promise.all([a.ready, b.ready]);
        const token = a.sessions.captureGeneration('session-1');
        await a.sessions.upsertTurn(header(), turn(), token);
        const held = deferred(), entered = deferred(); const originalSet = f.storage.set;
        f.storage.set = vi.fn(async (key, value) => {
            if ((value as any).kind === 'session-turn' && (value as any).turn.answer === 'late') {entered.resolve(); await held.promise;}
            await originalSet(key, value);
        });
        const late = a.sessions.upsertTurn(header(), turn('late', {answer: 'late'}), token);
        await entered.promise;
        await (action === 'delete' ? b.sessions.delete('session-1') : b.sessions.clear());
        held.resolve(); await expect(late).resolves.toBe(false);
        expect(await b.sessions.get('session-1')).toBeNull();
        await expect(a.sessions.upsertTurn(header(), turn(), token)).resolves.toBe(false);
        const next = a.sessions.captureGeneration('session-1');
        await expect(a.sessions.upsertTurn(header(), turn(), next)).resolves.toBe(true);
        const old = a.sessions.captureGeneration('session-1');
        const removed = action === 'delete' ? a.sessions.delete('session-1') : a.sessions.clear();
        await expect(a.sessions.upsertTurn(header(), turn('stale'), old)).resolves.toBe(false); await removed;
        expect(await a.sessions.get('session-1')).toBeNull();
        const reopened = f.create(); await reopened.ready;
        await expect(reopened.sessions.upsertTurn(header(), turn(), reopened.sessions.captureGeneration('session-1'))).resolves.toBe(true);
    });

    it('逐turn执行30天边界，过期不会随新的问答续期，热写不读取别的会话正文', async () => {
        const f = fixture(); const api = f.create(); await api.ready;
        const token = api.sessions.captureGeneration('session-1');
        await api.sessions.upsertTurn(header(), turn('old'), token);
        f.time(NOW + HARNESS_SESSION_TTL_MS - 1);
        await api.sessions.upsertTurn(header('session-1', NOW + HARNESS_SESSION_TTL_MS - 1), turn('fresh', {createdAt: NOW + HARNESS_SESSION_TTL_MS - 1}), token);
        f.time(NOW + HARNESS_SESSION_TTL_MS);
        expect(await api.sessions.prune()).toBe(1);
        expect((await api.sessions.get('session-1'))!.turns.map(item => item.id)).toEqual(['fresh']);
        await expect(api.sessions.upsertTurn(header(), turn(), token)).resolves.toBe(false);
        expect(await api.sessions.prune()).toBe(0);
        for (let index = 0; index < 10; index++) await api.sessions.upsertTurn(header('other-' + index), turn('other', {createdAt: NOW + HARNESS_SESSION_TTL_MS}), api.sessions.captureGeneration('other-' + index));
        vi.mocked(f.storage.get).mockClear();
        await api.sessions.upsertTurn(header('session-1', NOW + HARNESS_SESSION_TTL_MS), turn('fresh', {createdAt: NOW + HARNESS_SESSION_TTL_MS}), token);
        expect(vi.mocked(f.storage.get).mock.calls.every(([key]) => !key.includes('other-'))).toBe(true);
    });

    it('拒绝伪造或串会话token、非法输入，并在GM失败后允许后续任务重试', async () => {
        const f = fixture(); const api = f.create(); await api.ready;
        const token = api.sessions.captureGeneration('session-1');
        await expect(api.sessions.upsertTurn(header(), turn(), {...token})).resolves.toBe(false);
        await expect(api.sessions.upsertTurn(header('other'), turn(), token)).resolves.toBe(false);
        await expect(api.sessions.upsertTurn({...header(), text: ''}, turn(), token)).rejects.toThrow();
        await expect(api.sessions.delete('bad id')).rejects.toThrow();
        vi.mocked(f.storage.set).mockRejectedValueOnce(new Error('GM unavailable'));
        await expect(api.sessions.upsertTurn(header(), turn(), token)).rejects.toThrow('GM unavailable');
        await expect(api.sessions.upsertTurn(header(), turn(), token)).resolves.toBe(true);
        f.values.clear();
        expect(await api.sessions.get('session-1')).toBeNull();
        await expect(api.sessions.upsertTurn(header(), turn(), api.sessions.captureGeneration('session-1'))).resolves.toBe(true);
    });

    it('较旧动作的迟到turn不覆盖更新的会话标题，其他会话删除不作废本会话', async () => {
        const f = fixture(); const api = f.create(); await api.ready;
        const token = api.sessions.captureGeneration('session-1');
        await api.sessions.upsertTurn({...header(), intent: 'grammar', updatedAt: NOW + 5}, turn('new', {createdAt: NOW + 5}), token);
        await api.sessions.delete('unrelated');
        await expect(api.sessions.upsertTurn(header(), turn('old'), token)).resolves.toBe(true);
        expect(await api.sessions.get('session-1')).toMatchObject({intent: 'grammar', updatedAt: NOW + 5});
        expect((await api.sessions.get('session-1'))!.turns.map(item => item.id)).toEqual(['old', 'new']);
    });
});

describe('userscript GM 学习笔记', () => {
    it('无关删除仍改变公开代次，但不会让新笔记正文随历史删除次数膨胀', async () => {
        const f = fixture(); const a = f.create(), b = f.create(); await Promise.all([a.ready, b.ready]);
        const persisted = (id: string) => [...f.values.values()].find((row: any) => row.kind === 'memory-save' && row.memory.id === id) as {fence: string[]};
        for (let index = 0; index < 20; index++) await b.memories.delete(memoryId(1000 + index));
        const first = await a.memories.save({kind: 'note', content: 'first note'});
        expect(persisted(first.id).fence).toEqual([]);
        const firstBytes = JSON.stringify(persisted(first.id)).length;
        const generation = await a.memories.captureGeneration(); expect(generation).toBe(20);
        for (let index = 0; index < 100; index++) await b.memories.delete(memoryId(2000 + index));
        await expect(a.memories.save({kind: 'note', content: 'stale note'}, generation)).rejects.toThrow('已变更');
        const second = await a.memories.save({kind: 'note', content: 'other note'}, await a.memories.captureGeneration());
        expect(persisted(second.id).fence).toEqual([]);
        expect(JSON.stringify(persisted(second.id)).length - firstBytes).toBeLessThan(10);
        expect(await a.memories.list()).toHaveLength(2);
    });

    it('精简fence仍保留当前ID、相同内容及清空标记，明确重新添加后可正常编辑', async () => {
        const f = fixture(); const a = f.create(), b = f.create(); await Promise.all([a.ready, b.ready]);
        const first = await a.memories.save({kind: 'note', content: 'same content'});
        await b.memories.delete(first.id);
        const duplicate = await a.memories.save({kind: 'note', content: 'same content'});
        const rows = () => [...f.values.values()] as Array<{id: string; kind: string; target?: string; fence: string[]; memory?: {id: string}}>;
        const firstDelete = rows().find(row => row.kind === 'memory-delete' && row.target === first.id)!.id;
        expect(rows().find(row => row.memory?.id === duplicate.id)!.fence).toEqual([firstDelete]);
        await b.memories.delete(duplicate.id); await b.memories.clear();
        const secondDelete = rows().find(row => row.kind === 'memory-delete' && row.target === duplicate.id)!.id;
        const clear = rows().find(row => row.kind === 'memories-clear')!.id;
        const reopened = f.create({id: () => first.id}); await reopened.ready;
        const added = await reopened.memories.save({kind: 'note', content: 'different content'});
        expect(new Set(rows().find(row => row.memory?.id === added.id)!.fence)).toEqual(new Set([firstDelete, clear]));
        await reopened.memories.save({id: added.id, kind: 'note', content: 'same content'});
        expect(new Set(rows().find(row => row.memory?.id === added.id)!.fence)).toEqual(new Set([firstDelete, secondDelete, clear]));
        expect(await a.memories.list()).toMatchObject([{id: first.id, content: 'same content'}]);
    });

    it('字段校验、幂等重复、编辑冲突、代次删除、重新打开与白名单保持扩展合同', async () => {
        const f = fixture(); const api = f.create(); await api.ready;
        const first = await api.memories.save({kind: 'note', content: '  note  ', credential: 'discard'} as never);
        expect(first).toEqual({id: memoryId(1), kind: 'note', content: 'note', createdAt: NOW, updatedAt: NOW});
        expect(await api.memories.save({kind: 'note', content: 'note'})).toEqual(first);
        const second = await api.memories.save({kind: 'lesson', content: 'lesson'});
        const generation = await api.memories.captureGeneration();
        f.time(NOW - 1);
        const changed = await api.memories.save({id: first.id, kind: 'note', content: 'updated'}, generation);
        expect(changed.createdAt).toBe(NOW); expect(changed.updatedAt).toBe(NOW);
        await expect(api.memories.save({id: second.id, kind: 'note', content: 'updated'})).rejects.toThrow('相同内容');
        await api.memories.delete(first.id);
        await expect(api.memories.save({kind: 'note', content: 'late'}, generation)).rejects.toThrow('已变更');
        await expect(api.memories.save({id: first.id, kind: 'note', content: 'restore'})).rejects.toThrow('已被删除');
        expect((await api.memories.list()).map(item => item.id)).toEqual([second.id]);
        const reopened = f.create(); await reopened.ready;
        expect(await reopened.memories.captureGeneration()).toBe(1);
        expect((await reopened.memories.list())[0]).toEqual(second);
        await reopened.memories.clear();
        expect(await api.memories.list()).toEqual([]);
        expect(JSON.stringify([...f.values.values()])).not.toContain('discard');
        await expect(api.memories.save({kind: 'bad', content: 'x'} as never)).rejects.toThrow();
        await expect(api.memories.save({kind: 'note', content: 'x'}, -1)).rejects.toThrow('已变更');
        await expect(api.memories.delete('bad')).rejects.toThrow('标识');
    });

    it('两个独立标签并发保存不同笔记不覆盖，并发同项编辑确定性择新', async () => {
        const f = fixture(); const a = f.create(), b = f.create(); await Promise.all([a.ready, b.ready]);
        const [left, right] = await Promise.all([a.memories.save({kind: 'note', content: 'left'}), b.memories.save({kind: 'note', content: 'right'})]);
        expect(new Set((await a.memories.list()).map(item => item.id))).toEqual(new Set([left.id, right.id]));
        f.time(NOW + 1);
        const edits = await Promise.allSettled([a.memories.save({id: left.id, kind: 'note', content: 'edit A'}), b.memories.save({id: left.id, kind: 'note', content: 'edit B'})]);
        expect(edits.some(result => result.status === 'fulfilled')).toBe(true);
        expect(await a.memories.list()).toEqual(await b.memories.list());
        expect((await a.memories.list())).toHaveLength(2);
    });

    it('并发重复创建幂等，删除后迟到重复正文即使没有完成回调也不复活', async () => {
        const f = fixture(); const a = f.create(), b = f.create(); await Promise.all([a.ready, b.ready]);
        const entered = deferred(), write = deferred(), committed = deferred(), release = deferred();
        const originalSet = f.storage.set;
        f.storage.set = vi.fn(async (key, value) => {
            if ((value as any).kind === 'memory-save' && (value as any).memory.id === memoryId(2)) {
                entered.resolve(); await write.promise; await originalSet(key, value); committed.resolve(); await release.promise;
            } else await originalSet(key, value);
        });
        const saves = [a.memories.save({kind: 'note', content: 'same note'}), b.memories.save({kind: 'note', content: 'same note'})];
        const late = saves[1].catch(error => error);
        await entered.promise; const first = await saves[0];
        await a.memories.delete(first.id); write.resolve(); await committed.promise;
        expect(await a.memories.list()).toEqual([]);
        release.resolve(); expect(await late).toMatchObject({message: '学习笔记已变更，请重新保存'});
        expect(JSON.stringify([...f.values.values()])).not.toContain('same note');
        const duplicate = await Promise.all([a.memories.save({kind: 'note', content: 'new duplicate'}), b.memories.save({kind: 'note', content: 'new duplicate'})]);
        expect(duplicate[0].id).toBe(duplicate[1].id);
        expect(await a.memories.list()).toHaveLength(1);
        await a.memories.delete(duplicate[0].id); expect(await b.memories.list()).toEqual([]);
    });

    it.each(['delete', 'clear'] as const)('%s 跨标签发生在GM提交等待中仍拒绝迟到保存', async action => {
        const f = fixture(); const a = f.create(), b = f.create(); await Promise.all([a.ready, b.ready]);
        const first = await a.memories.save({kind: 'note', content: 'first'});
        const generation = await a.memories.captureGeneration();
        const held = deferred(), entered = deferred(); const originalSet = f.storage.set;
        f.storage.set = vi.fn(async (key, value) => {
            if ((value as any).kind === 'memory-save' && (value as any).memory.content === 'late') {entered.resolve(); await held.promise;}
            await originalSet(key, value);
        });
        const pending = a.memories.save({id: first.id, kind: 'note', content: 'late'}, generation);
        const failed = pending.catch(error => error);
        await entered.promise; await (action === 'delete' ? b.memories.delete(first.id) : b.memories.clear()); held.resolve();
        expect(await failed).toMatchObject({message: '学习笔记已变更，请重新保存'});
        expect(await a.memories.list()).toEqual([]);
        expect([...f.values.values()].every(row => (row as any).kind !== 'memory-save')).toBe(true);
    });

    it('已知200条上限拒绝新增但允许编辑、重复保存与删除后新增', async () => {
        const f = fixture(); const api = f.create(); await api.ready;
        for (let index = 0; index < 200; index++) await api.memories.save({kind: 'note', content: 'note ' + index});
        expect(await api.memories.list()).toHaveLength(200);
        await expect(api.memories.save({kind: 'note', content: 'overflow'})).rejects.toThrow('最多保存 200');
        const first = (await api.memories.list())[0];
        expect(await api.memories.save({kind: 'note', content: first.content})).toEqual(first);
        await api.memories.save({id: first.id, kind: 'note', content: 'edited at limit'});
        await api.memories.delete(first.id);
        await expect(api.memories.save({kind: 'note', content: 'replacement'})).resolves.toMatchObject({content: 'replacement'});
    });

    it('两个标签竞争最后一个名额时保持200条且不挤掉已确认笔记', async () => {
        const f = fixture(); const a = f.create(); await a.ready;
        for (let index = 0; index < 199; index++) await a.memories.save({kind: 'note', content: 'existing ' + index});
        const existing = (await a.memories.list()).map(item => item.id);
        const b = f.create(); await b.ready;
        f.time(NOW - 1); // 系统时钟回调也不能把新笔记排到已占用名额之前。
        const added = await Promise.allSettled([a.memories.save({kind: 'note', content: 'last A'}), b.memories.save({kind: 'note', content: 'last B'})]);
        expect(added.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        const all = await a.memories.list(); expect(all).toHaveLength(200);
        expect(existing.every(id => all.some(item => item.id === id))).toBe(true);
        expect(await b.memories.list()).toEqual(all);
    });

    it('时间和ID冲突报错，不把已提交正文的压缩失败改判为保存失败', async () => {
        const f = fixture(); const api = f.create({id: () => memoryId(1)}); await api.ready;
        const first = await api.memories.save({kind: 'note', content: 'first'});
        await expect(api.memories.save({kind: 'note', content: 'collision'})).rejects.toThrow('标识冲突');
        f.time(-1);
        await expect(api.memories.save({id: first.id, kind: 'note', content: 'bad time'})).rejects.toThrow('保存时间');
        f.time(NOW + 1); vi.mocked(f.storage.remove).mockRejectedValue(new Error('cleanup unavailable'));
        await expect(api.memories.save({id: first.id, kind: 'note', content: 'updated'})).resolves.toMatchObject({content: 'updated'});
        expect(await api.memories.list()).toHaveLength(1);
    });
});

describe('阅读存储边界', () => {
    it.each([
        ['null', null], ['array', []], ['clock', {clock: -1}], ['fence', {fence: ['bad fence']}],
        ['memory-id', {memory: {kind: 'note', content: 'body', createdAt: NOW, updatedAt: NOW}}],
        ['created-time', {memory: {id: memoryId(1), kind: 'note', content: 'body', createdAt: -1, updatedAt: NOW}}],
        ['updated-time', {memory: {id: memoryId(1), kind: 'note', content: 'body', createdAt: NOW, updatedAt: NaN}}],
        ['admission', {admission: {clock: -1, id: 'bad'}}], ['missing-admission', {admission: undefined}],
        ['delete-target', {kind: 'session-delete', target: 'bad target'}],
        ['delete-id', {kind: 'memory-delete', target: 'invalid'}],
        ['duplicate-type', {kind: 'memory-delete', target: memoryId(1), duplicate: 1}],
        ['duplicate-hash', {kind: 'memory-delete', target: memoryId(1), duplicate: 'bad'}],
        ['unknown', {kind: 'future-action'}],
    ] as const)('GM中的 %s 损坏记录不进入公开历史或笔记', async (_label, patch) => {
        const f = fixture();
        const base = {version: 1, id: 'bad', clock: 1, fence: [], admission: {clock: 1, id: 'bad'}, kind: 'memory-save',
            memory: {id: memoryId(1), kind: 'note', content: 'body', createdAt: NOW, updatedAt: NOW}};
        const value = patch && !Array.isArray(patch) ? {...base, ...patch} : patch;
        const kind = value && 'kind' in value && value.kind !== 'future-action' ? value.kind : 'memory-save';
        const target = kind === 'session-delete' ? 'bad%20target' : memoryId(1);
        f.values.set(prefix + kind + ':' + target + ':bad', value);
        const api = f.create(); await api.ready;
        expect(await api.memories.list()).toEqual([]);
        expect(await api.sessions.list()).toEqual({sessions: [], hasMore: false});
    });

    it('删除未知笔记只更新代次且操作时钟溢出明确失败', async () => {
        const f = fixture();
        f.values.set(prefix + 'memory-save:' + memoryId(1) + ':legacy', {version: 1, id: 'legacy', clock: 1, fence: [], admission: {clock: 1, id: 'legacy'}, kind: 'memory-save',
            memory: {id: memoryId(1), kind: 'note', content: 'legacy', createdAt: NOW, updatedAt: NOW}});
        const api = f.create(); await api.ready;
        expect(await api.memories.list()).toHaveLength(1);
        await api.memories.delete(memoryId(99));
        expect(await api.memories.captureGeneration()).toBe(1);
        expect(await api.memories.list()).toHaveLength(1);
        f.values.set(prefix + 'memories-clear:overflow', {version: 1, id: 'overflow', clock: Number.MAX_SAFE_INTEGER, fence: [], kind: 'memories-clear'});
        await expect(api.memories.save({kind: 'note', content: 'new'})).rejects.toThrow('标识');
    });

    it('隐私模式初始化和所有入口均不读取或写入GM', async () => {
        const f = fixture(); const api = f.create({privateContext: true}); await api.ready;
        expect(() => api.sessions.captureGeneration('session')).toThrow('隐私');
        const denied = [api.sessions.get('session'), api.sessions.list(), api.sessions.clear(), api.sessions.delete('session'), api.sessions.prune(),
            api.memories.captureGeneration(), api.memories.list(), api.memories.save({kind: 'note', content: 'private'}), api.memories.delete(memoryId(1)), api.memories.clear()];
        expect((await Promise.allSettled(denied)).every(result => result.status === 'rejected')).toBe(true);
        for (const method of Object.values(f.storage)) expect(method).not.toHaveBeenCalled();
    });

    it('损坏或未来版本记录不进入历史、不误删除其他命名空间，并拒绝复用操作ID', async () => {
        const f = fixture();
        f.values.set(prefix + 'session-turn:session-1:bad', {version: 2});
        f.values.set(prefix + 'session-turn:session-1:malformed', {version: 1, id: 'malformed', clock: 1, fence: [], kind: 'session-turn', session: header(), turn: {}});
        f.values.set(prefix + 'session-turn:session-1:%FF', {});
        f.values.set('foreign:data', {secret: 'untouched'});
        const api = f.create({operationId: () => 'repeat'}); await api.ready;
        expect(await api.sessions.list()).toEqual({sessions: [], hasMore: false});
        const token = api.sessions.captureGeneration('session-1');
        await api.sessions.upsertTurn(header(), turn(), token);
        await expect(api.sessions.upsertTurn(header(), turn(), token)).rejects.toThrow('冲突');
        expect(f.values.get('foreign:data')).toEqual({secret: 'untouched'});
        const invalid = f.create({operationId: () => 'bad op'}); await invalid.ready;
        await expect(invalid.memories.save({kind: 'note', content: 'note'})).rejects.toThrow('标识');
    });

    it('默认适配器只通过实际GM端口落盘并能在独立实例恢复', async () => {
        const values = new Map<string, string>();
        const get = vi.fn((key: string, fallback: unknown) => values.has(key) ? values.get(key) : fallback);
        vi.stubGlobal('GM_getValue', get); vi.stubGlobal('GM_listValues', () => [...values.keys()]);
        vi.stubGlobal('GM_setValue', (key: string, value: string) => {values.set(key, value);});
        vi.stubGlobal('GM_deleteValue', (key: string) => {values.delete(key);});
        const one = createUserscriptReadingStorage(); await one.ready;
        const saved = await one.memories.save({kind: 'lesson', content: 'from actual GM adapter'});
        const two = createUserscriptReadingStorage(); await two.ready;
        expect(await two.memories.list()).toEqual([saved]);
        expect([...values.keys()].every(key => key.startsWith(prefix))).toBe(true);
        expect(get).toHaveBeenCalled();
        await two.memories.clear(); expect(await one.memories.list()).toEqual([]);
    });
});

describe('跨页面读取GC与保存确认的交错', () => {
    it('未确认编辑被无关删除取消时保留早已确认的原笔记', async () => {
        const f = fixture(), a = f.create(), b = f.create(); await Promise.all([a.ready, b.ready]);
        const first = await a.memories.save({kind: 'note', content: 'confirmed original'});
        const unrelated = await a.memories.save({kind: 'note', content: 'unrelated'});
        const entered = deferred(), release = deferred(), originalSet = f.storage.set;
        let intercepted = false;
        f.storage.set = vi.fn(async (key, value: any) => {
            await originalSet(key, value);
            if (!intercepted && value.memory?.content === 'pending edit') {intercepted = true; entered.resolve(); await release.promise;}
        });
        const edit = a.memories.save({id: first.id, kind: 'note', content: 'pending edit'}).catch(error => error);
        await entered.promise;
        await b.memories.list(); // 另一个页面在确认前读取，不能把可能回滚的正文当作GC依据。
        await b.memories.delete(unrelated.id);
        release.resolve(); expect(await edit).toBeInstanceOf(Error);
        expect(await b.memories.list()).toEqual([first]);
    });

    it.each(['prepare', 'commit'] as const)('different existing IDs retain their confirmed original after concurrent duplicate edits at %s ACK', async stage => {
        const f = fixture(), a = f.create(), b = f.create(), reader = f.create(); await Promise.all([a.ready, b.ready, reader.ready]);
        const first = await a.memories.save({kind: 'note', content: 'original A'});
        const second = await b.memories.save({kind: 'note', content: 'original B'});
        const both = deferred(), committed = deferred(), release = deferred(), originalSet = f.storage.set;
        const held = new Set<string>(); let committedCount = 0;
        f.storage.set = vi.fn(async (key, value: any) => {
            if (value.memory?.content !== 'shared edited' || held.has(value.memory.id)
                || stage === 'commit' && !(value.kind === 'memory-save' && value.version === 2)) return originalSet(key, value);
            held.add(value.memory.id); if (held.size === 2) both.resolve(); await both.promise;
            await originalSet(key, value); if (++committedCount === 2) committed.resolve(); await release.promise;
        });
        const edits = [a.memories.save({id: first.id, kind: 'note', content: 'shared edited'}), b.memories.save({id: second.id, kind: 'note', content: 'shared edited'})];
        const settled = Promise.allSettled(edits);
        await committed.promise; await reader.memories.list(); release.resolve(); await settled;
        const after = await reader.memories.list();
        expect(new Set(after.map(item => item.id))).toEqual(new Set([first.id, second.id]));
        expect(after.filter(item => item.content === 'shared edited')).toHaveLength(1);
        const unchanged = after.find(item => item.content !== 'shared edited')!;
        expect(unchanged.content).toBe(unchanged.id === first.id ? 'original A' : 'original B');
        await reader.memories.delete(after.find(item => item.content === 'shared edited')!.id);
        expect(await reader.memories.list()).toEqual([unchanged]);
        await reader.memories.delete(unchanged.id); expect(await reader.memories.list()).toEqual([]);
    });
});

describe('GM不可回滚发布与旧标签兼容', () => {
    it('已发布commit的ACK等待中发生无关删除仍成功，ACK失败也不能撤销已发布正文', async () => {
        const f = fixture(), a = f.create(), b = f.create(); await Promise.all([a.ready, b.ready]);
        const first = await a.memories.save({kind: 'note', content: 'first'}), other = await a.memories.save({kind: 'note', content: 'other'});
        const entered = deferred(), release = deferred(), originalSet = f.storage.set;
        f.storage.set = vi.fn(async (key, value: any) => {await originalSet(key, value);
            if (value.kind === 'memory-save' && value.memory.content === 'published') {entered.resolve(); await release.promise;}
            if (value.kind === 'memory-save' && value.memory.content === 'ack failed') throw new Error('lost acknowledgment');
        });
        const edit = a.memories.save({id: first.id, kind: 'note', content: 'published'});
        await entered.promise; expect((await b.memories.list()).find(item => item.id === first.id)?.content).toBe('published');
        await b.memories.delete(other.id); release.resolve(); await expect(edit).resolves.toMatchObject({id: first.id, content: 'published'});
        await expect(a.memories.save({id: first.id, kind: 'note', content: 'ack failed'})).rejects.toThrow('lost acknowledgment');
        expect(await b.memories.list()).toMatchObject([{id: first.id, content: 'ack failed'}]);
    });

    it('准备副本过期被其他页面回收不影响RAM候选，顺序编辑只保留一个正文及一层前值', async () => {
        const f = fixture(), a = f.create(), b = f.create(); await Promise.all([a.ready, b.ready]);
        const first = await a.memories.save({kind: 'note', content: 'first'});
        const entered = deferred(), release = deferred(), originalSet = f.storage.set;
        f.storage.set = vi.fn(async (key, value: any) => {await originalSet(key, value);
            if (value.kind === 'memory-pending' && value.memory.content === 'slow') {entered.resolve(); await release.promise;}
        });
        const edit = a.memories.save({id: first.id, kind: 'note', content: 'slow'});
        await entered.promise; f.time(NOW + 300_001); expect(await b.memories.list()).toEqual([first]);
        expect([...f.values.values()].some((row: any) => row.kind === 'memory-pending')).toBe(false);
        release.resolve(); await expect(edit).resolves.toMatchObject({content: 'slow'});
        for (let index = 0; index < 10; index++) await a.memories.save({id: first.id, kind: 'note', content: 'edit ' + index});
        const bodies = [...f.values.values()].filter((row: any) => row.kind === 'memory-save') as any[];
        expect(bodies).toHaveLength(1); expect(bodies[0]).toMatchObject({version: 2, memory: {content: 'edit 9'}, previous: {memory: {content: 'edit 8'}}});
        expect(bodies[0].previous.previous).toBeUndefined();
    });

    it('v1可回滚新版不能让新reader删除v1或v2已确认前值，v2后继可安全回收legacy', async () => {
        const f = fixture(), api = f.create(); await api.ready;
        const first = await api.memories.save({kind: 'note', content: 'stable v2'});
        const stable = [...f.values.entries()].find(([, row]: any) => row.kind === 'memory-save')!;
        const draft = {...structuredClone(stable[1]) as any, version: 1, id: 'legacy-draft', clock: 100,
            memory: {...first, content: 'unconfirmed v1'}, previous: undefined};
        const key = prefix + 'memory-save:' + first.id + ':legacy-draft'; f.values.set(key, draft);
        await api.memories.list(); expect(f.values.has(stable[0])).toBe(true);
        f.values.delete(key); expect(await api.memories.list()).toEqual([first]);
        (stable[1] as any).version = 1; f.values.set(stable[0], stable[1]); f.values.set(key, draft);
        await api.memories.list(); expect(f.values.has(stable[0])).toBe(true);
        f.values.delete(key); expect(await api.memories.list()).toEqual([first]);
        await api.memories.save({id: first.id, kind: 'note', content: 'converted'});
        expect(f.values.has(stable[0])).toBe(false); expect(await api.memories.list()).toMatchObject([{content: 'converted'}]);
    });
});

describe('GM发布前复验与已确认回退身份', () => {
    it.each([false, true])('prepare等待中相同内容被另一ID先提交时只取消未发布写入（编辑=%s）', async editing => {
        const f = fixture(), a = f.create(), b = f.create(); await Promise.all([a.ready, b.ready]);
        const first = editing ? await a.memories.save({kind: 'note', content: 'original'}) : undefined;
        const entered = deferred(), release = deferred(), originalSet = f.storage.set; let held = false;
        f.storage.set = vi.fn(async (key, value: any) => {await originalSet(key, value);
            if (!held && value.kind === 'memory-pending' && value.memory.content === 'collision') {held = true; entered.resolve(); await release.promise;}
        });
        const saving = a.memories.save({kind: 'note', content: 'collision', ...(first ? {id: first.id} : {})}).catch(error => error);
        await entered.promise; const winner = await b.memories.save({kind: 'note', content: 'collision'}); release.resolve();
        const result = await saving;
        if (editing) {expect(result).toBeInstanceOf(Error); expect(await b.memories.list()).toEqual(expect.arrayContaining([first, winner]));}
        else expect(result).toEqual(winner);
        expect([...f.values.values()].some((row: any) => row.kind === 'memory-pending')).toBe(false);
    });

    it('准备等待中最后一个名额被提交时拒绝新笔记且保留全部已确认项', async () => {
        const f = fixture(), a = f.create(), b = f.create(); await Promise.all([a.ready, b.ready]);
        for (let i = 0; i < 199; i++) await a.memories.save({kind: 'note', content: 'existing ' + i});
        const entered = deferred(), release = deferred(), originalSet = f.storage.set;
        f.storage.set = vi.fn(async (key, value: any) => {await originalSet(key, value);
            if (value.kind === 'memory-pending' && value.memory.content === 'too late') {entered.resolve(); await release.promise;}
        });
        const pending = a.memories.save({kind: 'note', content: 'too late'}).catch(error => error);
        await entered.promise; const last = await b.memories.save({kind: 'note', content: 'last accepted'}); release.resolve();
        expect(await pending).toBeInstanceOf(Error); const all = await a.memories.list(); expect(all).toHaveLength(200); expect(all).toContainEqual(last);
    });

    it.each(['created', 'edited', 'delete-winner-first'] as const)('迟到编辑出现fallback不能删除第三个已确认ID（%s），删除相同内容只删除指定ID', async mode => {
        const f = fixture(), a = f.create(), b = f.create(), c = f.create(); await Promise.all([a.ready, b.ready, c.ready]);
        const existingThird = mode === 'edited' ? await c.memories.save({kind: 'note', content: 'original C'}) : undefined;
        const first = await a.memories.save({kind: 'note', content: 'original A'}), second = await b.memories.save({kind: 'note', content: 'original B'});
        const entered = deferred(), release = deferred(), originalSet = f.storage.set;
        f.storage.set = vi.fn(async (key, value: any) => {
            if (value.kind === 'memory-save' && value.version === 2 && value.memory.id === first.id && value.memory.content === 'shared') {entered.resolve(); await release.promise;}
            await originalSet(key, value);
        });
        const slow = a.memories.save({id: first.id, kind: 'note', content: 'shared'}).catch(error => error);
        await entered.promise; await b.memories.save({id: second.id, kind: 'note', content: 'shared'});
        const third = await c.memories.save({kind: 'note', content: 'original B', ...(existingThird ? {id: existingThird.id} : {})});
        release.resolve(); await slow;
        const after = await c.memories.list(); expect(new Set(after.map(item => item.id))).toEqual(new Set([first.id, second.id, third.id]));
        expect(after.filter(item => item.content === 'original B')).toHaveLength(2);
        if (mode === 'delete-winner-first') {
            await c.memories.delete(first.id);
            expect(new Set((await c.memories.list()).map(item => item.id))).toEqual(new Set([second.id, third.id]));
            await c.memories.delete(third.id); expect(await c.memories.list()).toMatchObject([{id: second.id, content: 'original B'}]); return;
        }
        await c.memories.delete(third.id); expect((await c.memories.list()).map(item => item.id)).toEqual(expect.arrayContaining([first.id, second.id]));
        await c.memories.delete(first.id); expect(await c.memories.list()).toMatchObject([{id: second.id, content: 'original B'}]);
        await c.memories.delete(second.id); expect(await c.memories.list()).toEqual([]);
    });

    it.each(['previous-fence', 'pending-time'] as const)('损坏的%s不会被解析成确认记录或误删现有正文', async field => {
        const f = fixture(), api = f.create(); await api.ready; const saved = await api.memories.save({kind: 'note', content: 'stable'});
        const row = structuredClone([...f.values.values()].find((item: any) => item.kind === 'memory-save')) as any;
        row.id = 'damaged'; row.clock += 100;
        if (field === 'previous-fence') row.previous = {memory: saved, fence: ['invalid fence']};
        else {row.kind = 'memory-pending'; row.version = 1; row.pendingAt = -1;}
        f.values.set(prefix + row.kind + ':' + saved.id + ':damaged', row);
        expect(await api.memories.list()).toEqual([saved]);
    });
});

it('准备等待期间同ID新编辑已经发布时，旧候选不再覆盖已确认的新正文', async () => {
    const f = fixture(), a = f.create(), b = f.create(); await Promise.all([a.ready, b.ready]);
    const first = await a.memories.save({kind: 'note', content: 'original'});
    const entered = deferred(), release = deferred(), originalSet = f.storage.set;
    f.storage.set = vi.fn(async (key, value: any) => {await originalSet(key, value);
        if (value.kind === 'memory-pending' && value.memory.content === 'older candidate') {entered.resolve(); await release.promise;}
    });
    const older = a.memories.save({id: first.id, kind: 'note', content: 'older candidate'}).catch(error => error);
    await entered.promise; const newer = await b.memories.save({id: first.id, kind: 'note', content: 'newer confirmed'}); release.resolve();
    expect(await older).toBeInstanceOf(Error); expect(await a.memories.list()).toEqual([newer]);
});
