/**
 * @file tests/personalCorrectionMemory.test.ts
 * 文件职责：验证个人校订的精确范围、原子加密持久化、显式管理和消息边界。
 * 主要内容：覆盖显式开启与关闭门控、配置备份隔离、语言/语境/大小写/数字隔离、近似建议、冲突、撤销、删除失效、重复触发、重启和竞争写入。
 * 模块边界：使用虚构网页和 fake IndexedDB，不调用真实 provider，不接触用户阅读历史或日常浏览器。
 */
import 'fake-indexeddb/auto';
import {afterEach, describe, expect, it, vi} from 'vitest';
const mocked = vi.hoisted(() => {
    let value: unknown = null;
    return {
        config: {on: true, personalCorrectionsEnabled: true},
        storage: {writeOwner: true, getItem: vi.fn(async () => value), setItem: vi.fn(async (_key: string, next: unknown) => {value = next;}),
            setItemIfUnchanged: vi.fn(async (_key: string, expected: unknown, next: unknown) => {if (JSON.stringify(expected) !== JSON.stringify(value)) return false; value = structuredClone(next); return true;}),
            removeItem: vi.fn(async () => {value = null;}), watch: vi.fn(() => () => undefined)},
        browser: {runtime: {id: 'ext', getURL: vi.fn((path: string) => `chrome-extension://ext${path}`), sendMessage: vi.fn(async () => undefined),
            onMessage: {addListener: vi.fn(), removeListener: vi.fn()}}, extension: {inIncognitoContext: false},
            tabs: {query: vi.fn(async () => [{id: 1}, {id: undefined}]), sendMessage: vi.fn(async () => undefined)}},
        clear: () => {value = null;},
    };
});
vi.mock('webextension-polyfill', () => ({default: mocked.browser}));
vi.mock('@/src/platform/storage/configStorageRuntime', () => ({configStorage: mocked.storage}));
vi.mock('@/src/services/config/store', () => ({config: mocked.config}));
import {Config, normalizeConfig} from '@/src/core/config/model';
import {buildConfigDiff, configDiffFieldLabel} from '@/src/core/config/diff';
import {prepareConfigForExport, prepareConfigForImport} from '@/src/core/config/transfer';
import {projectDriveSyncConfig} from '@/src/core/config/driveSync';
import {toRestorableConfig, restoreRestorableConfig} from '@/src/services/config/history';
import {createBaselineConfigAutoBackups} from '@/src/services/config/autoBackup';
import {createMaterialId, correctionId, correctionMaterialId, correctionObject, correctionRevision, correctionText, emptyCorrectionState, lookupPersonalCorrection,
    PERSONAL_CORRECTION_LIMIT, PERSONAL_CORRECTION_PROJECT_LIMIT, PersonalCorrectionError, validateCorrectionInput, validateCorrectionQuery, validateCorrectionRecord, validateCorrectionScope, validateCorrectionState,
    type PersonalCorrectionInput, type PersonalCorrectionRecord, type PersonalCorrectionState} from '@/src/core/personal-corrections/public';
import {emptyCorrectionSnapshot, validateCorrectionSnapshot, type PersonalCorrectionSnapshot, type PersonalCorrectionStore} from '@/src/services/personal-corrections/store';
import {PersonalCorrectionService} from '@/src/services/personal-corrections/service';
import {PersonalCorrectionRepository, PERSONAL_CORRECTION_STORAGE_KEY} from '@/src/platform/storage/personalCorrectionRepository';
import {createBackgroundConfigStorage, type ConfigStoragePort} from '@/src/platform/storage/configStorage';
import {EncryptedConfigRepository, FluentReadConfigDatabase} from '@/src/platform/storage/configRepository';
import {createPersonalCorrectionsClient} from '@/src/services/personal-corrections/client';
import {personalCorrections, PERSONAL_CORRECTIONS_MESSAGE, PERSONAL_CORRECTIONS_CHANGED} from '@/src/services/personal-corrections/public';
import type {PersonalCorrectionMessage} from '@/src/services/personal-corrections/protocol';
import {createPersonalCorrectionHandler, createPersonalCorrectionRuntimeHandlers, type PersonalCorrectionContext} from '@/src/app/background/personalCorrectionRuntime';
const url = 'https://article.test/book?chapter=1';
const materialId = createMaterialId(url);
const otherMaterial = createMaterialId('https://article.test/book?chapter=2');
const uuid = (value: number) => `a0000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const input = (source = 'They found the bank beside the river.'): PersonalCorrectionInput => ({scope: {kind: 'material', id: materialId, label: '本材料'}, source,
    translation: '他们找到了河边的岸。', sourceLanguage: 'en', targetLanguage: 'zh-CN', context: 'River crossing'});
const query = (source = input().source) => ({source, sourceLanguage: 'en', targetLanguage: 'zh-CN', context: 'River crossing', materialId});
const record = (id = 1, extra: Partial<PersonalCorrectionRecord> = {}): PersonalCorrectionRecord => ({...input(), id: uuid(id), revision: id, ...extra});
function memoryStore(value = emptyCorrectionSnapshot()) {
    let current = structuredClone(value);
    const store: PersonalCorrectionStore = {read: vi.fn(async () => ({value: structuredClone(current), expected: structuredClone(current)})),
        write: vi.fn(async (expected, next) => {if (JSON.stringify(expected) !== JSON.stringify(current)) return false; current = structuredClone(next); return true;})};
    return {store, current: () => structuredClone(current), replace: (value: PersonalCorrectionSnapshot) => {current = structuredClone(value);}};
}
function setup(initial = emptyCorrectionSnapshot(), generator?: () => string) {
    let sequence = 0; const memory = memoryStore(initial);
    return {...memory, service: new PersonalCorrectionService(memory.store, generator || (() => uuid(++sequence)))};
}
const databases: FluentReadConfigDatabase[] = [];
afterEach(async () => {
    for (const database of databases.splice(0)) {database.close(); await database.delete();}
    mocked.clear(); mocked.browser.extension.inIncognitoContext = false;
    mocked.config.on = true; mocked.config.personalCorrectionsEnabled = true;
    vi.clearAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe('personal correction explicit configuration consent', () => {
    it('defaults old or malformed configuration to off and enables only literal true', () => {
        expect(new Config().personalCorrectionsEnabled).toBe(false);
        expect(normalizeConfig({}).personalCorrectionsEnabled).toBe(false);
        for (const invalid of [undefined, null, 'true', 'false', 1, 0, {}, [], false]) {
            expect(normalizeConfig({personalCorrectionsEnabled: invalid}).personalCorrectionsEnabled).toBe(false);
        }
        const enabled = normalizeConfig({personalCorrectionsEnabled: true});
        expect(enabled.personalCorrectionsEnabled).toBe(true);
        const old: Partial<Config> = {...new Config()}; delete old.personalCorrectionsEnabled;
        expect(prepareConfigForImport(old, enabled).personalCorrectionsEnabled).toBe(false);
        expect(restoreRestorableConfig(old, enabled).personalCorrectionsEnabled).toBe(false);
    });
    it('backs up only the opt-in preference and shows human-readable changes while memory stays separate', async () => {
        const {service, current} = setup(); const saved = await service.save(input());
        const preference = normalizeConfig({personalCorrectionsEnabled: true});
        const exported = prepareConfigForExport(preference);
        const history = toRestorableConfig(preference);
        const backup = createBaselineConfigAutoBackups(preference);
        const cloud = projectDriveSyncConfig(exported);
        expect([exported, history, backup.entries[0]!.config, cloud].every(value => value.personalCorrectionsEnabled === true)).toBe(true);
        for (const value of [exported, history, backup, cloud]) {
            expect(JSON.stringify(value)).not.toContain(input().source);
            expect(JSON.stringify(value)).not.toContain(input().translation);
            expect(JSON.stringify(value)).not.toContain(saved.record.id);
            expect(JSON.stringify(value)).not.toContain(PERSONAL_CORRECTION_STORAGE_KEY);
        }
        expect(prepareConfigForImport(exported, new Config()).personalCorrectionsEnabled).toBe(true);
        expect(configDiffFieldLabel('personalCorrectionsEnabled')).toBe('个人校订');
        expect(buildConfigDiff({personalCorrectionsEnabled: false}, preference).groups.find(group => group.id === 'tools')?.changes)
            .toContainEqual({key: 'personalCorrectionsEnabled', label: '个人校订', before: '关闭', after: '开启'});
        expect(normalizeConfig({personalCorrectionsEnabled: false}).personalCorrectionsEnabled).toBe(false);
        expect(current().state.entries).toEqual([saved.record]);
    });
    it('omits unsupported userscript preferences and diff semantics even when importing an extension setting', async () => {
        vi.stubEnv('BROWSER', 'userscript');
        expect(Object.hasOwn(new Config(), 'personalCorrectionsEnabled')).toBe(false);
        expect(Object.hasOwn(normalizeConfig({personalCorrectionsEnabled: true}), 'personalCorrectionsEnabled')).toBe(false);
        vi.resetModules();
        const userscriptDiff = await import('@/src/core/config/diff');
        expect(userscriptDiff.configDiffFieldLabel('personalCorrectionsEnabled')).toBeUndefined();
        vi.resetModules();
    });
});

describe('personal correction input and material identity', () => {
    it('hashes full canonical material URLs, isolates query and hash routes and discards userinfo', () => {
        expect(createMaterialId(`${url}#page-2`)).not.toBe(materialId);
        expect(createMaterialId('https://article.test/#/book1')).not.toBe(createMaterialId('https://article.test/#/book2'));
        expect(createMaterialId('https://name:password@article.test/book?chapter=1')).toBe(materialId);
        expect(otherMaterial).not.toBe(materialId);
        expect(materialId).not.toContain('article');
        expect(createMaterialId('file:///tmp/book.html')).toMatch(/^material-/);
        for (const invalid of ['bad address', 'javascript:alert(1)', 'chrome-extension://ext/options.html']) expect(() => createMaterialId(invalid)).toThrow('材料地址无效');
    });
    it('copies only explicit fields, preserving exact source text and context', () => {
        const valid = validateCorrectionInput({...input('  They found Bank 12.\r\n  '), context: '', apiKey: 'secret', history: [url]});
        expect(valid).toEqual({...input('  They found Bank 12.\r\n  '), context: ''});
        expect(validateCorrectionInput({...input(), id: uuid(1).toUpperCase(), expectedRevision: 1})).toEqual({...input(), id: uuid(1), expectedRevision: 1});
        expect(validateCorrectionQuery({...query(), unknown: 'discard'})).toEqual(query());
        expect(correctionText(' ', '语境', 1, true)).toBe(' ');
        expect(validateCorrectionScope({kind: 'project', id: uuid(3), label: '项目'})).toEqual({kind: 'project', id: uuid(3), label: '项目'});
        expect(validateCorrectionRecord({...record(), secret: 'secret'})).toEqual(record());
        expect(new PersonalCorrectionError('message').name).toBe('PersonalCorrectionError');
    });
    it('rejects malformed input without truncation or accepting credentials as record fields', () => {
        for (const invalid of [null, [], 1, '', undefined]) expect(() => correctionObject(invalid)).toThrow('校订内容无效');
        for (const invalid of [3, '', ' ', 'x'.repeat(20001)]) expect(() => validateCorrectionInput({...input(), source: invalid})).toThrow('原文');
        expect(() => validateCorrectionInput({...input(), translation: ''})).toThrow('译文');
        expect(() => validateCorrectionInput({...input(), context: 'x'.repeat(4001)})).toThrow('语境');
        for (const language of [3, '', 'english', 'zh-<script>']) expect(() => validateCorrectionQuery({...query(), sourceLanguage: language})).toThrow('语言');
        expect(validateCorrectionQuery({...query(), sourceLanguage: 'auto', targetLanguage: 'es'}).sourceLanguage).toBe('auto');
        for (const invalid of [null, 3, 'not-uuid', 'a0000000-0000-4000-1000-000000000001']) expect(() => correctionId(invalid)).toThrow('标识无效');
        for (const invalid of [3, 'material-no', materialId.toUpperCase()]) expect(() => correctionMaterialId(invalid)).toThrow('材料标识');
        for (const invalid of [NaN, -1, 0, 1.1, '1']) expect(() => correctionRevision(invalid)).toThrow('版本');
        expect(correctionRevision(0, true)).toBe(0);
        expect(() => validateCorrectionScope({kind: 'global', id: materialId, label: '所有'})).toThrow('范围');
        expect(() => validateCorrectionScope({kind: 'material', id: materialId, label: 'x'.repeat(81)})).toThrow('范围名称');
        expect(() => validateCorrectionInput({...input(), expectedRevision: 1})).toThrow('新校订');
        expect(() => validateCorrectionInput({...input(), id: uuid(1)})).toThrow('版本');
    });
    it('validates persisted white lists and relationships before lookup', () => {
        const valid: PersonalCorrectionState = {version: 1, revision: 2, entries: [record()], projects: [{id: uuid(2), label: 'Project'}], memberships: [{materialId, projectId: uuid(2)}]};
        expect(validateCorrectionState({...valid, extra: 'secret'})).toEqual(valid);
        for (const invalid of [null, {...valid, version: 2}, {...valid, entries: null}, {...valid, entries: new Array(1001)}, {...valid, projects: null}, {...valid, projects: new Array(101)}, {...valid, memberships: null}, {...valid, memberships: new Array(1001)}]) expect(() => validateCorrectionState(invalid)).toThrow();
        const invalidRelations = [
            {...valid, entries: [record(), record()]}, {...valid, projects: [valid.projects[0], valid.projects[0]]},
            {...valid, memberships: [valid.memberships[0], valid.memberships[0]]}, {...valid, memberships: [{materialId, projectId: uuid(99)}]},
            {...valid, entries: [record(3)]}, {...valid, entries: [record(1, {scope: {kind: 'project', id: uuid(99), label: 'missing'}})]},
        ];
        for (const invalid of invalidRelations) expect(() => validateCorrectionState(invalid)).toThrow('关系');
        const projectRecord = record(1, {scope: {kind: 'project', id: uuid(2), label: 'Project'}});
        expect(validateCorrectionState({...valid, entries: [projectRecord]}).entries).toEqual([projectRecord]);
    });
    it('validates bounded durable undo entries and their record identity', () => {
        const state = {...emptyCorrectionState(), revision: 1, entries: [record()]};
        const undo = {token: uuid(2), id: uuid(1), before: null, after: record()};
        expect(validateCorrectionSnapshot({state, undo: [undo], key: 'secret'})).toEqual({state, undo: [undo]});
        expect(validateCorrectionSnapshot({state, undo: [{...undo, before: record(), after: null}]}).undo[0].before).toEqual(record());
        for (const invalid of [null, {state, undo: null}, {state, undo: new Array(31)}, {state, undo: [{...undo, before: null, after: null}]},
            {state, undo: [{...undo, before: record(3)}]}, {state, undo: [{...undo, after: record(3)}]}, {state, undo: [undo, undo]}]) expect(() => validateCorrectionSnapshot(invalid)).toThrow();
    });
});

describe('precise reuse and reviewed suggestions', () => {
    it('isolates material, selected project, context, source and target language, case and numbers', () => {
        const state: PersonalCorrectionState = {...emptyCorrectionState(), revision: 1, entries: [record()]};
        expect(lookupPersonalCorrection(state, query()).exact).toEqual(record());
        for (const change of [{materialId: otherMaterial}, {sourceLanguage: 'EN'}, {targetLanguage: 'zh-TW'}, {context: 'Other heading'}, {source: input().source.toUpperCase()}, {source: input().source + '\n'}]) expect(lookupPersonalCorrection(state, {...query(), ...change}).exact).toBeUndefined();
        const numbered = {...state, entries: [record(1, {source: 'He scored 12 points in the final game.'})]};
        expect(lookupPersonalCorrection(numbered, query('He scored 13 points in the final game.')).exact).toBeUndefined();
        expect(lookupPersonalCorrection(numbered, query('He scored 13 points in the final game.')).suggestions).toHaveLength(1);
        expect(lookupPersonalCorrection(state, query('Unrelated')).suggestions).toEqual([]);
        expect(lookupPersonalCorrection(state, query('!!!')).suggestions).toEqual([]);
        expect(lookupPersonalCorrection({...state, entries: [record(1, {source: '???'})]}, query('!!!')).suggestions).toEqual([]);
    });
    it('requires explicit project membership and refuses competing confirmed translations', () => {
        const project = {id: uuid(10), label: 'Reading'};
        const projectRecord = record(2, {scope: {kind: 'project', ...project}, translation: '项目译法'});
        const state: PersonalCorrectionState = {...emptyCorrectionState(), revision: 2, projects: [project], entries: [projectRecord]};
        expect(lookupPersonalCorrection(state, query()).exact).toBeUndefined();
        state.memberships.push({materialId, projectId: project.id});
        expect(lookupPersonalCorrection(state, query()).exact).toEqual(projectRecord);
        state.entries.push(record());
        expect(lookupPersonalCorrection(state, query())).toEqual({exact: undefined, conflicts: [projectRecord, record()], suggestions: []});
        state.entries[0] = {...projectRecord, translation: record().translation};
        expect(lookupPersonalCorrection(state, query()).exact?.scope.kind).toBe('material');
        state.entries = [record(), record(2, {translation: '冲突译法'})];
        expect(lookupPersonalCorrection(state, query()).conflicts).toHaveLength(2);
    });
    it('bounds lexical suggestions, ranks similarity then recency, and never emits them as exact', () => {
        const entries = [record(1, {source: 'They found the bank beside the large river.'}), record(2, {source: 'They found the bank beside the broad river.'}),
            record(3, {source: 'They found the bank beside the quiet river.'}), record(4, {source: 'They found the bank beside the dark river.'}),
            record(5, {source: 'They found the bank beside the green river.'}), record(6, {source: 'They found the bank beside the blue river.'}),
            record(7, {source: 'They found the bank beside the river!'})];
        const result = lookupPersonalCorrection({...emptyCorrectionState(), revision: 7, entries}, query());
        expect(result.exact).toBeUndefined(); expect(result.suggestions).toHaveLength(5);
        expect(result.suggestions.map(entry => entry.id)).toEqual([uuid(7), uuid(6), uuid(5), uuid(4), uuid(3)]);
    });
});

describe('personal correction service and durable undo', () => {
    it('confirms only requested input, repeats idempotently and deletes without stale reuse', async () => {
        const {service, current} = setup();
        const saved = await service.save({...input(), secret: 'unused'} as PersonalCorrectionInput);
        expect(saved.record).toEqual(record()); expect(saved.undoToken).toBe(uuid(2));
        expect(current().state.entries[0]).not.toHaveProperty('secret');
        expect(await service.save({...input(), scope: {...input().scope, label: 'renamed material'}})).toEqual({record: saved.record, undoToken: ''});
        expect(await service.save({...input(), id: saved.record.id, expectedRevision: saved.record.revision})).toEqual({record: saved.record, undoToken: ''});
        expect((await service.lookup(query())).exact).toEqual(saved.record);
        const removed = await service.remove(saved.record.id, saved.record.revision);
        expect((await service.lookup(query())).exact).toBeUndefined();
        expect((await service.list()).entries).toEqual([]);
        await service.undo(removed.undoToken);
        const restored = (await service.lookup(query())).exact!;
        expect(restored.translation).toBe(saved.record.translation); expect(restored.revision).toBe(3);
        await expect(service.remove(restored.id, 1)).rejects.toThrow('已变更');
        await expect(service.undo(saved.undoToken)).rejects.toThrow('失效');
        await expect(service.undo(removed.undoToken)).rejects.toThrow('失效');
    });
    it('edits and reverses an unchanged successor, rejecting stale undo or stale editors', async () => {
        const {service} = setup(); const saved = await service.save(input());
        const edited = await service.save({...input(), id: saved.record.id, expectedRevision: 1, translation: '修订后的岸。'});
        await expect(service.undo(saved.undoToken)).rejects.toThrow('后续变更');
        await expect(service.save({...input(), id: saved.record.id, expectedRevision: 1, translation: '迟到'})).rejects.toThrow('已变更');
        await service.undo(edited.undoToken);
        expect((await service.list()).entries[0]).toMatchObject({translation: input().translation, revision: 3});
        const created = await service.save(input('Second sentence'));
        await service.undo(created.undoToken);
        expect((await service.list()).entries).toHaveLength(1);
        await service.remove(saved.record.id, 3);
        await expect(service.save({...input(), id: saved.record.id, expectedRevision: 3})).rejects.toThrow('被删除');
        await expect(service.remove(saved.record.id, 3)).rejects.toThrow('被删除');
    });
    it('retains conflicting translations instead of silently overwriting and maintains explicit projects', async () => {
        const {service} = setup(); const saved = await service.save(input());
        const alternate = await service.save({...input(), translation: '银行译法'});
        expect((await service.lookup(query())).conflicts).toHaveLength(2);
        await expect(service.save({...input(), id: alternate.record.id, expectedRevision: alternate.record.revision})).rejects.toThrow('已有相同');
        const project = await service.createProject('  阅读组  ');
        expect(project.label).toBe('阅读组'); expect(await service.createProject('阅读组')).toEqual(project);
        await service.selectProject(materialId, project.id); await service.selectProject(materialId, project.id);
        const projectCorrection = await service.save({...input(), scope: {kind: 'project', id: project.id, label: 'untrusted label'}});
        expect(projectCorrection.record.scope.label).toBe('阅读组');
        expect((await service.lookup({...query(), materialId: otherMaterial})).exact).toBeUndefined();
        await service.selectProject(otherMaterial, project.id);
        expect((await service.lookup({...query(), materialId: otherMaterial})).exact).toEqual(projectCorrection.record);
        await service.selectProject(otherMaterial, null); await service.selectProject(otherMaterial, null);
        expect((await service.lookup({...query(), materialId: otherMaterial})).exact).toBeUndefined();
        await expect(service.selectProject(otherMaterial, uuid(99))).rejects.toThrow('不存在');
        await expect(service.save({...input(), scope: {kind: 'project', id: uuid(99), label: 'missing'}})).rejects.toThrow('不存在');
        expect((await service.list()).entries).toContainEqual(saved.record);
    });
    it('serializes repeated writes and resolves CAS races between independent service instances', async () => {
        const {service, store} = setup(); let next = 100;
        const other = new PersonalCorrectionService(store, () => uuid(++next));
        const repeated = await Promise.all([service.save(input()), other.save(input()), service.save(input()), other.save(input())]);
        expect(new Set(repeated.map(result => result.record.id)).size).toBe(1);
        await Promise.all([service.save(input('one')), other.save(input('two'))]);
        expect((await other.list()).entries).toHaveLength(3);
        expect((await other.list()).revision).toBe(3);
    });
    it('rejects exhausted atomic retries and permits retry after failed storage', async () => {
        const {service, store} = setup(); vi.mocked(store.write).mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(false);
        await expect(service.save(input())).rejects.toThrow('其他窗口');
        await expect(service.save(input())).resolves.toHaveProperty('record');
        vi.mocked(store.read).mockRejectedValueOnce(new Error('storage unavailable'));
        await expect(service.createProject('project')).rejects.toThrow('storage unavailable');
        await expect(service.createProject('project')).resolves.toMatchObject({label: 'project'});
    });
    it('rejects identifier collisions and invalid clocks or versions without a partial write', async () => {
        const existing = record(); const snapshot = {state: {...emptyCorrectionState(), revision: 1, entries: [existing]}, undo: []};
        await expect(setup(snapshot, () => uuid(1)).service.save(input('new'))).rejects.toThrow('校订标识冲突');
        await expect(setup(emptyCorrectionSnapshot(), () => 'bad').service.save(input())).rejects.toThrow('标识无效');
        const journal = {token: uuid(9), id: existing.id, before: null, after: existing};
        const collision = setup({...snapshot, undo: [journal]}, () => uuid(9));
        await expect(collision.service.save(input('new'))).rejects.toThrow('撤销标识冲突');
        expect(collision.current()).toEqual({...snapshot, undo: [journal]});
        const project = {id: uuid(1), label: 'first'};
        await expect(setup({state: {...emptyCorrectionState(), projects: [project]}, undo: []}, () => uuid(1)).service.createProject('second')).rejects.toThrow('项目标识冲突');
        await expect(setup({state: {...emptyCorrectionState(), revision: Number.MAX_SAFE_INTEGER}, undo: []}).service.createProject('overflow')).rejects.toThrow('版本无效');
        await expect(setup().service.createProject(' ')).rejects.toThrow('项目名称');
        await expect(setup().service.undo('invalid')).rejects.toThrow('标识无效');
    });
    it('enforces entry, project and material membership quotas without evicting user corrections', async () => {
        const entries = Array.from({length: PERSONAL_CORRECTION_LIMIT}, (_, index) => record(index + 1, {source: `Sentence ${index}`}));
        const {service} = setup({state: {...emptyCorrectionState(), revision: 1000, entries}, undo: []});
        await expect(service.save(input('overflow'))).rejects.toThrow('最多保存 1000');
        expect((await service.save({...input('Sentence 0'), id: entries[0].id, expectedRevision: 1, translation: 'edit'})).record.translation).toBe('edit');
        const projects = Array.from({length: PERSONAL_CORRECTION_PROJECT_LIMIT}, (_, index) => ({id: uuid(index + 1), label: `project ${index}`}));
        const {service: projectService} = setup({state: {...emptyCorrectionState(), projects}, undo: []});
        await expect(projectService.createProject('overflow')).rejects.toThrow('最多保存 100');
        expect(await projectService.createProject('project 0')).toEqual(projects[0]);
        const memberships = Array.from({length: 1000}, (_, index) => ({materialId: createMaterialId(`https://article.test/${index}`), projectId: projects[0].id}));
        const {service: membershipService} = setup({state: {...emptyCorrectionState(), projects, memberships}, undo: []});
        await expect(membershipService.selectProject(materialId, projects[0].id)).rejects.toThrow('数量已满');
        await membershipService.selectProject(memberships[0].materialId, projects[1].id);
        expect((await membershipService.list()).memberships).toHaveLength(1000);
        const deleted = record(1001, {source: 'deleted'});
        const token = uuid(9000);
        const {service: undoService} = setup({state: {...emptyCorrectionState(), revision: 1001, entries}, undo: [{token, id: deleted.id, before: deleted, after: null}]});
        await expect(undoService.undo(token)).rejects.toThrow('容量已满');
    });
    it('bounds undo history and rejects snapshots whose successor was independently changed', async () => {
        const {service} = setup(); const tokens: string[] = [];
        for (let index = 0; index < 31; index++) tokens.push((await service.save(input(`sentence ${index}`))).undoToken);
        await expect(service.undo(tokens[0])).rejects.toThrow('失效');
        await service.undo(tokens[1]);
        const saved = record(1); const changed = {...saved, translation: 'new translation', revision: 2};
        const {service: conflicting} = setup({state: {...emptyCorrectionState(), revision: 2, entries: [changed]}, undo: [{token: uuid(99), id: saved.id, before: null, after: saved}]});
        await expect(conflicting.undo(uuid(99))).rejects.toThrow('后续变更');
    });
    it('uses the default secure ID generator when no factory is injected', async () => {
        const service = new PersonalCorrectionService(memoryStore().store);
        expect((await service.save(input())).record.id).toMatch(/^[a-f0-9-]{36}$/);
    });
});

describe('encrypted personal correction repository', () => {
    it('persists in the independent encrypted key and reloads deletion/undo after service worker restart', async () => {
        const database = new FluentReadConfigDatabase(`personal-corrections-${crypto.randomUUID()}`); databases.push(database);
        const encrypted = new EncryptedConfigRepository({database});
        const legacy = {getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined};
        const storage = createBackgroundConfigStorage({repository: encrypted, legacy});
        const service = new PersonalCorrectionService(new PersonalCorrectionRepository(storage));
        const saved = await service.save(input());
        const raw = await encrypted.getRawRecord(PERSONAL_CORRECTION_STORAGE_KEY);
        expect(JSON.stringify(raw)).not.toContain(input().source); expect(JSON.stringify(raw)).not.toContain(input().translation);
        expect(await encrypted.has('local:config')).toBe(false); expect(await encrypted.has('local:configHistory')).toBe(false);
        const reopened = new PersonalCorrectionService(new PersonalCorrectionRepository(createBackgroundConfigStorage({repository: new EncryptedConfigRepository({database}), legacy})));
        expect((await reopened.lookup(query())).exact).toEqual(saved.record);
        const removed = await reopened.remove(saved.record.id, saved.record.revision);
        const restarted = new PersonalCorrectionService(new PersonalCorrectionRepository(storage));
        expect((await restarted.lookup(query())).exact).toBeUndefined();
        await restarted.undo(removed.undoToken);
        expect((await restarted.lookup(query())).exact?.translation).toBe(input().translation);
    });
    it('requires background write ownership and atomic storage, rejecting oversized or corrupt snapshots', async () => {
        const storage = {...mocked.storage, writeOwner: false} as ConfigStoragePort;
        const remote = new PersonalCorrectionRepository(storage);
        await expect(remote.read()).rejects.toThrow('只能由后台');
        await expect(remote.write(null, emptyCorrectionSnapshot())).rejects.toThrow('原子提交');
        await expect(new PersonalCorrectionRepository({...storage, writeOwner: true, setItemIfUnchanged: undefined}).write(null, emptyCorrectionSnapshot())).rejects.toThrow('原子提交');
        const repository = new PersonalCorrectionRepository(mocked.storage as unknown as ConfigStoragePort);
        expect((await repository.read()).value).toEqual(emptyCorrectionSnapshot());
        await mocked.storage.setItem('local:personalCorrections', {bad: true});
        await expect(repository.read()).rejects.toThrow('撤销格式');
        mocked.clear();
        const large = Array.from({length: 120}, (_, index) => record(index + 1, {source: 'a'.repeat(20000), translation: 'b'.repeat(20000)}));
        await expect(repository.write(null, {state: {...emptyCorrectionState(), revision: 120, entries: large}, undo: []})).rejects.toThrow('4 MiB');
        expect((await repository.read()).value).toEqual(emptyCorrectionSnapshot());
        await expect(repository.write(null, emptyCorrectionSnapshot())).resolves.toBe(true);
        await expect(repository.write(null, emptyCorrectionSnapshot())).resolves.toBe(false);
    });
    it('expires older undo snapshots before quota can block a newly confirmed deletion', async () => {
        const repository = new PersonalCorrectionRepository(mocked.storage as unknown as ConfigStoragePort);
        const entries = Array.from({length: 80}, (_, index) => record(index + 1, {source: 'a'.repeat(20000), translation: 'b'.repeat(20000)}));
        const undo = Array.from({length: 30}, (_, index) => {
            const before = record(index + 100, {revision: 1, source: 'a'.repeat(20000), translation: 'b'.repeat(20000)});
            return {token: uuid(2000 + index), id: before.id, before, after: null};
        });
        await expect(repository.write(null, {state: {...emptyCorrectionState(), revision: 80, entries}, undo})).resolves.toBe(true);
        const stored = (await repository.read()).value;
        expect(stored.undo.length).toBeLessThan(30); expect(stored.undo.at(-1)?.token).toBe(undo[29].token);
        expect(new TextEncoder().encode(JSON.stringify(stored)).length).toBeLessThanOrEqual(4 * 1024 * 1024);
    });
});

describe('personal correction client and scoped runtime', () => {
    function runtime() {
        return {sendMessage: vi.fn(async (_message: unknown): Promise<unknown> => ({success: true, data: 'returned'})), onMessage: {addListener: vi.fn(), removeListener: vi.fn()}};
    }
    it('sends typed lookup and management requests through only the existing runtime port', async () => {
        const port = runtime(); const client = createPersonalCorrectionsClient(() => port);
        expect(await client.lookup(query())).toBe('returned'); await client.list(); await client.save(input()); await client.remove(uuid(1), 1);
        await client.undo(uuid(2)); await client.createProject('project'); await client.selectProject(materialId, null);
        expect(port.sendMessage.mock.calls.map(call => call[0])).toEqual([
            {type: PERSONAL_CORRECTIONS_MESSAGE, action: 'lookup', query: query()}, {type: PERSONAL_CORRECTIONS_MESSAGE, action: 'list'},
            {type: PERSONAL_CORRECTIONS_MESSAGE, action: 'save', input: input()}, {type: PERSONAL_CORRECTIONS_MESSAGE, action: 'remove', id: uuid(1), expectedRevision: 1},
            {type: PERSONAL_CORRECTIONS_MESSAGE, action: 'undo', token: uuid(2)}, {type: PERSONAL_CORRECTIONS_MESSAGE, action: 'createProject', label: 'project'},
            {type: PERSONAL_CORRECTIONS_MESSAGE, action: 'selectProject', materialId, projectId: null},
        ]);
        vi.stubGlobal('browser', mocked.browser);
        mocked.browser.runtime.sendMessage.mockResolvedValueOnce({success: true, data: emptyCorrectionState()} as never);
        expect(await personalCorrections.list()).toEqual(emptyCorrectionState());
        vi.unstubAllGlobals();
        await expect(personalCorrections.list()).rejects.toThrow('运行时不可用');
        vi.stubGlobal('browser', {});
        await expect(personalCorrections.list()).rejects.toThrow('运行时不可用');
    });
    it('rejects malformed and safe error replies, leaving ordinary translation fallback to caller', async () => {
        const port = runtime(); const client = createPersonalCorrectionsClient(() => port);
        for (const response of [null, 3, {}, {success: false}, {success: false, error: 3}]) {
            port.sendMessage.mockResolvedValueOnce(response as never); await expect(client.list()).rejects.toThrow('暂不可用');
        }
        port.sendMessage.mockResolvedValueOnce({success: false, error: '校订被删除'} as never); await expect(client.list()).rejects.toThrow('被删除');
        port.sendMessage.mockRejectedValueOnce(new Error('No receiving end')); await expect(client.lookup(query())).rejects.toThrow('No receiving end');
    });
    it('bounds queries and explicit mutations, clears timers and never retries an uncertain write', async () => {
        vi.useFakeTimers();
        try {
            const port = runtime(); const client = createPersonalCorrectionsClient(() => port);
            port.sendMessage.mockImplementation(() => new Promise(() => undefined));
            const lookup = expect(client.lookup(query())).rejects.toThrow('查询超时');
            await vi.advanceTimersByTimeAsync(1500); await lookup;
            const list = expect(client.list()).rejects.toThrow('读取超时');
            await vi.advanceTimersByTimeAsync(5000); await list;
            const save = expect(client.save(input())).rejects.toThrow('结果未确认');
            await vi.advanceTimersByTimeAsync(5000); await save;
            expect(port.sendMessage).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0);
            port.sendMessage.mockResolvedValueOnce({success: true, data: 'done'});
            await client.list(); expect(vi.getTimerCount()).toBe(0);
        } finally {vi.useRealTimers();}
    });
    it('subscribes only to invalidation signals and releases listeners once on abort or cleanup', () => {
        const port = runtime(); const client = createPersonalCorrectionsClient(() => port); const listener = vi.fn(); const abort = new AbortController();
        const cleanup = client.subscribe(listener, abort.signal); const receive = port.onMessage.addListener.mock.calls[0][0] as (message: unknown) => void;
        for (const message of [null, 2, {type: 'other'}]) receive(message);
        receive({type: PERSONAL_CORRECTIONS_CHANGED}); expect(listener).toHaveBeenCalledOnce();
        abort.abort(); cleanup(); expect(port.onMessage.removeListener).toHaveBeenCalledOnce();
        client.subscribe(listener, abort.signal)(); expect(port.onMessage.addListener).toHaveBeenCalledOnce();
        client.subscribe(listener)(); expect(port.onMessage.removeListener).toHaveBeenCalledTimes(2);
        const unavailable = createPersonalCorrectionsClient(() => {throw new Error('not extension');}); unavailable.subscribe(listener)();
    });
    function background() {
        const {service, store} = setup();
        const dependencies = {service, extensionId: 'ext', isExtensionUrl: (url: string) => url.startsWith('chrome-extension://ext/'), privateContext: vi.fn(() => false), enabled: vi.fn(() => true), changed: vi.fn(async () => undefined)};
        const handler = createPersonalCorrectionHandler<PersonalCorrectionContext>(dependencies);
        const sender = {id: 'ext', url, tab: {id: 1}};
        const extension = {id: 'ext', url: 'chrome-extension://ext/options.html'};
        const call = (action: string, fields: object = {}, current = sender as PersonalCorrectionContext['sender']) => handler.handle({type: PERSONAL_CORRECTIONS_MESSAGE, action, ...fields}, {sender: current});
        return {service, store, dependencies, handler, sender, extension, call};
    }
    it('allows active page confirmation and explicit project selection, then broadcasts each mutation', async () => {
        const {call, dependencies, extension} = background();
        const saved = await call('save', {input: input()}) as {success: true; data: {record: PersonalCorrectionRecord; undoToken: string}};
        expect(saved.success).toBe(true);
        expect(await call('lookup', {query: query()})).toMatchObject({success: true, data: {exact: saved.data.record}});
        expect(await call('list', {}, extension)).toMatchObject({success: true});
        const project = await call('createProject', {label: 'Group'}) as {data: {id: string}};
        const projectInput = {...input(), scope: {kind: 'project', id: project.data.id, label: 'Group'}};
        expect(await call('save', {input: projectInput})).toMatchObject({success: false, error: expect.stringContaining('先明确选择')});
        expect(await call('selectProject', {materialId, projectId: project.data.id})).toMatchObject({success: true});
        expect(await call('save', {input: projectInput})).toMatchObject({success: true});
        expect(await call('save', {input: {...projectInput, source: 'Explicit extension-page correction'}}, extension)).toMatchObject({success: true});
        expect(await call('save', {input: {...input(), scope: {kind: 'material', id: otherMaterial, label: 'other'}}}, extension)).toMatchObject({success: true});
        const removed = await call('remove', {id: saved.data.record.id, expectedRevision: saved.data.record.revision}) as {data: {undoToken: string}};
        expect(await call('undo', {token: removed.data.undoToken})).toMatchObject({success: true});
        dependencies.changed.mockRejectedValueOnce(new Error('tab gone'));
        expect(await call('selectProject', {materialId, projectId: null})).toMatchObject({success: true});
        expect(dependencies.changed).toHaveBeenCalledTimes(9);
    });
    it('disabled lookup and confirmation perform zero memory IO, preserve sender checks and retain explicit management', async () => {
        const {call, dependencies, service, store, sender} = background();
        const saved = await service.save(input());
        vi.mocked(store.read).mockClear(); vi.mocked(store.write).mockClear();
        dependencies.enabled.mockReturnValue(false);
        const miss = {success: true, data: {suggestions: [], conflicts: []}};
        expect(await call('lookup', {query: query()})).toEqual(miss);
        expect(await call('save', {input: input('Late confirmation')})).toMatchObject({success: false, error: expect.stringContaining('已关闭')});
        expect(await call('lookup', {query: query()}, {...sender, id: 'foreign'})).toMatchObject({success: false});
        expect(await call('lookup', {query: {...query(), materialId: otherMaterial}})).toMatchObject({success: false});
        expect(await call('lookup', {query: {}})).toMatchObject({success: false});
        expect(store.read).not.toHaveBeenCalled(); expect(store.write).not.toHaveBeenCalled();
        expect(await call('list')).toMatchObject({success: true, data: {entries: [saved.record]}});
        const removed = await call('remove', {id: saved.record.id, expectedRevision: saved.record.revision}) as {data: {undoToken: string}};
        expect(await call('undo', {token: removed.data.undoToken})).toMatchObject({success: true});
        expect(await call('list')).toMatchObject({success: true, data: {entries: [expect.objectContaining({id: saved.record.id, translation: saved.record.translation})]}});
        expect(await call('lookup', {query: query()})).toEqual(miss);
    });
    it('discards a lookup finishing after closure and refuses a project save whose scope check finishes after closure', async () => {
        const {call, dependencies, service, store} = background();
        const saved = await service.save(input());
        let finishLookup!: (value: {exact: PersonalCorrectionRecord; suggestions: never[]; conflicts: never[]}) => void;
        const lookup = vi.spyOn(service, 'lookup').mockImplementationOnce(() => new Promise(resolve => {finishLookup = resolve;}));
        const pendingLookup = call('lookup', {query: query()});
        await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
        dependencies.enabled.mockReturnValue(false);
        finishLookup({exact: saved.record, suggestions: [], conflicts: []});
        expect(await pendingLookup).toEqual({success: true, data: {suggestions: [], conflicts: []}});

        const project = await service.createProject('Explicit project');
        await service.selectProject(materialId, project.id);
        const state = await service.list();
        let finishScope!: (value: PersonalCorrectionState) => void;
        const list = vi.spyOn(service, 'list').mockImplementationOnce(() => new Promise(resolve => {finishScope = resolve;}));
        const save = vi.spyOn(service, 'save');
        vi.mocked(store.write).mockClear();
        dependencies.enabled.mockReturnValue(true);
        const pendingSave = call('save', {input: {...input(), scope: {kind: 'project', id: project.id, label: project.label}}});
        await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
        dependencies.enabled.mockReturnValue(false); finishScope(state);
        expect(await pendingSave).toMatchObject({success: false, error: expect.stringContaining('已关闭')});
        expect(save).not.toHaveBeenCalled(); expect(store.write).not.toHaveBeenCalled();
    });
    it('rejects foreign senders, incognito, malformed commands and mismatched materials before storage', async () => {
        const {handler, call, sender, dependencies, store} = background();
        for (const current of [undefined, {}, {...sender, id: 'foreign'}, {...sender, url: undefined}, {...sender, tab: undefined}, {...sender, tab: {id: -1}}, {...sender, tab: {id: 1.5}}, {...sender, tab: {id: 1, incognito: true}}, {...sender, url: 'javascript:alert(1)'}]) {
            expect(await handler.handle({type: PERSONAL_CORRECTIONS_MESSAGE, action: 'list'}, {sender: current})).toMatchObject({success: false});
        }
        dependencies.privateContext.mockReturnValueOnce(true);
        expect(await call('list')).toMatchObject({success: false});
        expect(await call('lookup', {query: {...query(), materialId: otherMaterial}})).toMatchObject({success: false, error: expect.stringContaining('不一致')});
        expect(await call('save', {input: {...input(), scope: {...input().scope, id: otherMaterial}}})).toMatchObject({success: false});
        expect(await call('selectProject', {materialId: otherMaterial, projectId: null})).toMatchObject({success: false});
        expect(await call('unknown')).toMatchObject({success: false, error: expect.stringContaining('操作无效')});
        expect(await handler.handle({type: 'other'} as never, {sender})).toMatchObject({success: false, error: expect.stringContaining('消息无效')});
        expect(await handler.handle(null as never, {sender})).toMatchObject({success: false, error: expect.stringContaining('未完成')});
        expect(store.read).not.toHaveBeenCalled(); expect(store.write).not.toHaveBeenCalled();
        vi.mocked(store.read).mockRejectedValueOnce(new Error('sensitive storage internals'));
        expect(await call('list')).toEqual({success: false, error: '个人校订操作未完成，请稍后重试'});
    });
    it('registers one shared handler and broadcasts no user text through tabs and runtime', async () => {
        const sendTabMessage: (tabId: number, message: unknown) => Promise<unknown> = mocked.browser.tabs.sendMessage;
        const broadcastTabMessage = vi.fn(async (message: unknown) => {
            await Promise.allSettled([sendTabMessage(1, message)]);
        });
        const handlers = createPersonalCorrectionRuntimeHandlers<PersonalCorrectionContext>({broadcastTabMessage});
        expect(handlers).toHaveLength(1);
        mocked.browser.tabs.sendMessage.mockRejectedValueOnce(new Error('tab gone'));
        mocked.browser.runtime.sendMessage.mockRejectedValueOnce(new Error('no listener'));
        const sender = {id: 'ext', url, tab: {id: 1}};
        expect(await handlers[0].handle({type: PERSONAL_CORRECTIONS_MESSAGE, action: 'save', input: input()} as never, {sender})).toMatchObject({success: true});
        expect(broadcastTabMessage).toHaveBeenCalledWith({type: PERSONAL_CORRECTIONS_CHANGED});
        await vi.waitFor(() => expect(mocked.browser.tabs.sendMessage).toHaveBeenCalledWith(1, {type: PERSONAL_CORRECTIONS_CHANGED}));
        await vi.waitFor(() => expect(mocked.browser.runtime.sendMessage).toHaveBeenCalledWith({type: PERSONAL_CORRECTIONS_CHANGED}));
        expect(await handlers[0].handle({type: PERSONAL_CORRECTIONS_MESSAGE, action: 'list'} as PersonalCorrectionMessage, {sender: {id: 'ext', url: 'chrome-extension://ext/options.html'}})).toMatchObject({success: true});
        for (const preference of [{on: false, personalCorrectionsEnabled: true}, {on: true, personalCorrectionsEnabled: false}]) {
            Object.assign(mocked.config, preference); mocked.storage.getItem.mockClear();
            expect(await handlers[0].handle({type: PERSONAL_CORRECTIONS_MESSAGE, action: 'lookup', query: query()} as PersonalCorrectionMessage, {sender})).toEqual({success: true, data: {suggestions: [], conflicts: []}});
            expect(mocked.storage.getItem).not.toHaveBeenCalled();
            expect(await handlers[0].handle({type: PERSONAL_CORRECTIONS_MESSAGE, action: 'save', input: input()} as PersonalCorrectionMessage, {sender})).toMatchObject({success: false, error: expect.stringContaining('已关闭')});
        }
        Object.assign(mocked.config, {on: true, personalCorrectionsEnabled: true});
        expect(await handlers[0].handle({type: PERSONAL_CORRECTIONS_MESSAGE, action: 'lookup', query: query()} as PersonalCorrectionMessage, {sender})).toMatchObject({success: true, data: {exact: expect.objectContaining({translation: input().translation})}});
        mocked.browser.extension.inIncognitoContext = true;
        expect(await handlers[0].handle({type: PERSONAL_CORRECTIONS_MESSAGE, action: 'list'} as PersonalCorrectionMessage, {sender})).toMatchObject({success: false});
    });
});
