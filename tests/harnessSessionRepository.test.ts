/**
 * @file tests/harnessSessionRepository.test.ts
 * 文件职责：验证 Harness 会话规范化、Dexie 持久化、过期清理、并发合并与 generation 防复活。
 * 主要内容：使用 fake-indexeddb 覆盖真实 repository 的读写、分页、删除和清空契约。
 * 模块边界：测试不启动模型、不访问网络、不依赖 app/runtime/UI。
 */
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {FluentReadHarnessSessionDatabase, HarnessSessionRepository} from '@/src/platform/storage/harnessSessionRepository';
import {HARNESS_SESSION_TTL_MS, normalizeHarnessSession, normalizeHarnessStoredTurn} from '@/src/services/harness/sessions';
import type {HarnessSession, HarnessStoredTurn} from '@/src/services/harness/sessionTypes';

const databases: FluentReadHarnessSessionDatabase[] = [];
let sequence = 0;

afterEach(async () => {
    await Promise.all(databases.splice(0).map(async database => {
        database.close();
        await database.delete();
    }));
});

function repo(): HarnessSessionRepository {
    sequence += 1;
    const database = new FluentReadHarnessSessionDatabase(`FluentReadHarnessSession-test-${sequence}`);
    databases.push(database);
    return new HarnessSessionRepository(database);
}

function session(id = 'session-1', now = Date.now()): Omit<HarnessSession, 'turns'> {
    return {id, text: 'Selected sentence', context: 'Paragraph context', createdAt: now, updatedAt: now, intent: 'meaning'};
}

function turn(id: string, createdAt = Date.now(), overrides: Partial<HarnessStoredTurn> = {}): HarnessStoredTurn {
    return {id, question: 'What does this mean?', answer: 'It means this.', intent: 'meaning', status: 'completed', createdAt, service: 'openai', model: 'reader', ...overrides};
}

describe('Harness session normalization', () => {
    it('截断边界拆开代理对时，非法会话及问答 ID 保持拒绝', () => {
        const invalid = `${'a'.repeat(199)}😀tail`;
        expect(() => normalizeHarnessSession({...session(invalid), turns: []})).toThrow('格式无效');
        expect(() => normalizeHarnessStoredTurn(turn(invalid))).toThrow('格式无效');
        expect(normalizeHarnessSession({...session('a'.repeat(200)), turns: []}).id).toHaveLength(200);
    });
    it('限制会话和回答长度时不把完整的 Unicode 字符拆开', () => {
        const value = normalizeHarnessSession({...session(), text: `${'x'.repeat(4095)}😀tail`, context: `${'c'.repeat(3999)}😀tail`, turns: [turn('t', 10, {question: `${'q'.repeat(999)}😀tail`, answer: `${'a'.repeat(15999)}😀tail`})]});
        expect(value.text).toBe('x'.repeat(4095)); expect(value.context).toBe('c'.repeat(3999));
        expect(value.turns[0].question).toBe('q'.repeat(999)); expect(value.turns[0].answer).toBe('a'.repeat(15999));
    });
    it('bounds and cleans all user text without altering valid fields', () => {
        const value = normalizeHarnessSession({...session(), text: `  ${'x'.repeat(5000)}  `, context: ` ${'c'.repeat(5000)} `, turns: [turn('t', 10, {question: ` ${'q'.repeat(2000)} `, answer: ` ${'a'.repeat(17000)} `})]});
        expect(value.text).toHaveLength(4096);
        expect(value.context).toHaveLength(4000);
        expect(value.turns[0].question).toHaveLength(1000);
        expect(value.turns[0].answer).toHaveLength(16000);
        const multiline = normalizeHarnessStoredTurn(turn('multiline', 10, {question: 'line 1\n\tline 2', answer: 'a\r\nb'}));
        expect(multiline.question).toBe('line 1\n\tline 2');
        expect(multiline.answer).toBe('a\r\nb');
        expect(normalizeHarnessStoredTurn(turn('t', 10, {status: 'streaming'})).status).toBe('streaming');
        expect(() => normalizeHarnessSession({...session(), intent: 'bad' as never, turns: []})).toThrow('intent');
        expect(() => normalizeHarnessStoredTurn(turn('bad id', 10))).toThrow('格式无效');
        expect(normalizeHarnessSession({...session(), context: undefined as unknown as string, turns: []}).context).toBe('');
        expect(() => normalizeHarnessSession({...session(), createdAt: Number.NaN, turns: []})).toThrow('createdAt');
        expect(() => normalizeHarnessStoredTurn(turn('t', 10, {service: undefined as unknown as string}))).toThrow('service');
        expect(normalizeHarnessStoredTurn(turn('stream-empty', 10, {status: 'streaming', service: '', model: ''}))).toMatchObject({service: '', model: ''});
        expect(() => normalizeHarnessSession({...session(), text: '', turns: []})).toThrow('text');
        expect(() => normalizeHarnessStoredTurn(null as never)).toThrow('对象');
        expect(() => normalizeHarnessStoredTurn(turn('t', 10, {intent: 'bad' as never}))).toThrow('intent');
        expect(() => normalizeHarnessStoredTurn(turn('t', 10, {status: 'bad' as never}))).toThrow('status');
        expect(() => normalizeHarnessSession(null as never)).toThrow('对象');
        expect(normalizeHarnessSession({...session(), turns: undefined as unknown as HarnessStoredTurn[]}).turns).toEqual([]);
    });
});

describe('Harness session repository', () => {
    it('atomically merges turns and returns defensive copies and summaries', async () => {
        const repository = repo();
        const base = session();
        const token = repository.captureGeneration(base.id);
        await expect(repository.upsertTurn(base, turn('t1'), token)).resolves.toBe(true);
        await expect(repository.upsertTurn(base, turn('t2', Date.now(), {status: 'streaming'}), token)).resolves.toBe(true);
        await expect(repository.upsertTurn(base, turn('t1', Date.now(), {answer: 'updated'}), token)).resolves.toBe(true);
        const loaded = await repository.get(base.id);
        expect(loaded?.turns.map(item => item.id)).toEqual(['t1', 't2']);
        expect(loaded?.turns[0].answer).toBe('updated');
        loaded!.text = 'mutated outside repository';
        expect((await repository.get(base.id))?.text).toBe('Selected sentence');
        await expect(repository.list(0, 1)).resolves.toMatchObject({hasMore: false, sessions: [{id: base.id, turnCount: 2}]});
    });

    it('persists an initial streaming turn before service/model resolution', async () => {
        const repository = repo();
        const base = session('initial-stream');
        await expect(repository.upsertTurn(base, turn('stream', Date.now(), {status: 'streaming', service: '', model: ''}), repository.captureGeneration(base.id))).resolves.toBe(true);
        expect((await repository.get(base.id))?.turns[0]).toMatchObject({status: 'streaming', service: '', model: ''});
    });

    it('expires turns by their own creation time and removes empty sessions on read/write', async () => {
        const repository = repo();
        const now = Date.now();
        const base = session('expiry', now);
        const token = repository.captureGeneration(base.id);
        await expect(repository.upsertTurn(base, turn('old', now - HARNESS_SESSION_TTL_MS - 1), token)).resolves.toBe(false);
        expect(await repository.get(base.id)).toBeNull();
        await repository.upsertTurn(base, turn('fresh', now), repository.captureGeneration(base.id));
        expect((await repository.get(base.id))?.turns).toHaveLength(1);
        expect(await repository.prune()).toBe(0);
        const boundary = session('boundary', now);
        await expect(repository.upsertTurn(boundary, turn('exact-boundary', now - HARNESS_SESSION_TTL_MS), repository.captureGeneration(boundary.id))).resolves.toBe(false);
        const mixed = normalizeHarnessSession({...session('mixed', now), turns: [turn('expired', now - HARNESS_SESSION_TTL_MS - 1), turn('kept', now)]});
        await repository.database.sessions.put({...mixed, oldestTurnAt: now - HARNESS_SESSION_TTL_MS - 1} as never);
        expect((await repository.get('mixed'))?.turns.map(item => item.id)).toEqual(['kept']);
    });

    it('backfills the oldest turn index when opening a version-one database', async () => {
        sequence += 1;
        const name = `FluentReadHarnessSession-legacy-${sequence}`;
        const legacy = new Dexie(name);
        legacy.version(1).stores({sessions: '&id, updatedAt, createdAt'});
        await legacy.open();
        const now = Date.now();
        await legacy.table('sessions').add({...session('legacy', now), turns: [turn('old', now - HARNESS_SESSION_TTL_MS - 1)]});
        legacy.close();
        const upgraded = new FluentReadHarnessSessionDatabase(name);
        databases.push(upgraded);
        const repository = new HarnessSessionRepository(upgraded);
        expect(await repository.get('legacy')).toBeNull();
    });

    it('rejects stale writes after delete and clear, while allowing a new generation', async () => {
        const repository = repo();
        const base = session('stale');
        const other = session('other');
        const stale = repository.captureGeneration(base.id);
        const otherToken = repository.captureGeneration(other.id);
        await repository.delete(base.id);
        await expect(repository.upsertTurn(base, turn('late'), stale)).resolves.toBe(false);
        await expect(repository.upsertTurn(other, turn('other-turn'), otherToken)).resolves.toBe(true);
        expect(await repository.get(base.id)).toBeNull();
        const fresh = repository.captureGeneration(base.id);
        await expect(repository.upsertTurn(base, turn('new'), fresh)).resolves.toBe(true);
        const beforeClear = repository.captureGeneration(base.id);
        await repository.clear();
        await expect(repository.upsertTurn(base, turn('resurrect'), beforeClear)).resolves.toBe(false);
        expect(await repository.get(base.id)).toBeNull();
    });

    it('does not silently cap recent sessions and normalizes invalid pagination safely', async () => {
        const repository = repo();
        const now = Date.now();
        for (let index = 0; index < 3; index += 1) {
            const current = session(`s-${index}`, now + index);
            await repository.upsertTurn(current, turn(`t-${index}`, now + index), repository.captureGeneration(current.id));
        }
        expect((await repository.list(-1, 0)).sessions).toHaveLength(3);
        expect((await repository.list(1, 1)).sessions).toHaveLength(1);
    });

    it('recovers interrupted streaming turns after a worker restart', async () => {
        const repository = repo();
        const base = session('restart');
        await repository.upsertTurn(base, turn('stream', Date.now(), {status: 'streaming'}), repository.captureGeneration(base.id));
        await repository.upsertTurn(base, turn('done', Date.now(), {status: 'completed'}), repository.captureGeneration(base.id));
        await repository.recoverInterrupted();
        expect((await repository.get(base.id))?.turns.map(item => item.status)).toEqual(['stopped', 'completed']);
        const empty = normalizeHarnessSession({...session('empty'), turns: []});
        await repository.database.sessions.put({...empty, oldestTurnAt: Date.now() - HARNESS_SESSION_TTL_MS - 1} as never);
        expect(await repository.get('empty')).toBeNull();
        const expired = normalizeHarnessSession({...session('expired-restart', Date.now()), turns: [turn('expired-turn', Date.now() - HARNESS_SESSION_TTL_MS - 1)]});
        await repository.database.sessions.put({...expired, oldestTurnAt: Date.now() - HARNESS_SESSION_TTL_MS - 1} as never);
        await repository.recoverInterrupted();
        expect(await repository.get('expired-restart')).toBeNull();
    });

    it('rejects a write when its generation changes during transaction cleanup or read', async () => {
        const cleanupRace = repo();
        const cleanupSession = session('cleanup-race');
        const cleanupToken = cleanupRace.captureGeneration(cleanupSession.id);
        const originalClean = (cleanupRace as unknown as {cleanExpired: () => Promise<number>}).cleanExpired;
        (cleanupRace as unknown as {cleanExpired: () => Promise<number>}).cleanExpired = async () => {
            await cleanupRace.delete(cleanupSession.id);
            return 0;
        };
        await expect(cleanupRace.upsertTurn(cleanupSession, turn('late-cleanup'), cleanupToken)).resolves.toBe(false);
        (cleanupRace as unknown as {cleanExpired: () => Promise<number>}).cleanExpired = originalClean;

        const transactionRace = repo();
        const transactionSession = session('transaction-race');
        const transactionToken = transactionRace.captureGeneration(transactionSession.id);
        const transaction = transactionRace.database.transaction.bind(transactionRace.database);
        (vi.spyOn(transactionRace.database, 'transaction') as any).mockImplementation(async (...args: any[]) => {
            await transactionRace.delete(transactionSession.id);
            return Reflect.apply(transaction, transactionRace.database, args);
        });
        await expect(transactionRace.upsertTurn(transactionSession, turn('late-transaction'), transactionToken)).resolves.toBe(false);

        const readRace = repo();
        const readSession = session('read-race');
        const readToken = readRace.captureGeneration(readSession.id);
        const get = readRace.database.sessions.get.bind(readRace.database.sessions);
        (vi.spyOn(readRace.database.sessions, 'get') as any).mockImplementation(async (key: string) => {
            await readRace.delete(readSession.id);
            return get(key);
        });
        await expect(readRace.upsertTurn(readSession, turn('late-read'), readToken)).resolves.toBe(false);
    });
});

describe('Harness concurrent conversation recency', () => {
    it('an older stream checkpoint cannot move a newer turn out of recent order', async () => {
        const store = repo();
        const now = Date.now();
        const token = store.captureGeneration('shared');
        await store.upsertTurn({...session('shared', now - 1000), intent: 'grammar'}, turn('old', now - 1000, {intent: 'grammar', status: 'streaming', answer: 'part'}), token);
        await store.upsertTurn({...session('shared', now), intent: 'practice'}, turn('new', now, {intent: 'practice'}), token);
        await store.upsertTurn({...session('shared', now - 1000), intent: 'grammar'}, turn('old', now - 1000, {intent: 'grammar', answer: 'finished'}), token);
        expect(await store.get('shared')).toMatchObject({updatedAt: now, intent: 'practice', turns: [{id: 'old', answer: 'finished'}, {id: 'new'}]});
    });
});
