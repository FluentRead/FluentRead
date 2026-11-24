/**
 * @file tests/documentLiveTranslationDriver.test.ts
 * 文件职责：离线验证真实文档翻译工具的响应诊断截止与自有资源收尾，防止未完成正文掩盖产品失败或阻塞清理。
 * 主要内容：覆盖正常正文证据、拒绝与挂起、晚响应的文档归属、提前 drain、关闭或临时目录清理失败、Lingvanex 官方端点分类，可选内置词库的公开配置投影，以及新旧恢复提示、有界超时的收尾等待、总截止、逐位置译文保留与重试/继续主按钮操作契约。
 * 模块边界：只调用 driver 的离线端口和临时目录；词库测试由实际内置副本工厂提供数据，不另造术语预期。不创建浏览器、不访问网络、不模拟产品译文通过，也不更改真实翻译、格式或焦点断言。
 */
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {addBuiltinGlossary, BUILTIN_GLOSSARIES} from '@/src/core/glossary/builtins';
import type {GlossaryLibrary} from '@/src/core/glossary/model';

interface NetworkRecord {
    document: string;
    bodyObservation?: {state: string; elapsedMs?: number; reason?: string; errorName?: string};
    translations?: Array<{sha256: string; chars: number; tail: string}>;
    finishReasons?: unknown[];
}
interface BodyObserver {
    observe(response: {json(): Promise<unknown>}, record: NetworkRecord): Promise<void>;
    drain(options?: {timeoutMs?: number}): Promise<void>;
    stats: {timeoutMs: number; started: number; completed: number; timedOut: number; failed: number; active: number; drainTimeouts: number};
}
interface CleanupReport {cleanupErrors: string[]; retainedProfile?: string; focusFailure?: string; ok?: boolean}
interface PublicGlossaryState {
    glossaryEnabled: boolean;
    documentGlossaryIds: string[] | null;
    libraries: Array<{id: string; name: string; enabled: boolean; presetId: string | null; presetVersion: number | null; termCount: number}>;
}
interface ResumeSnapshot {
    name: string; format: string; parsedVersion: number; pages?: Array<{pageNumber: number}>;
    segments: Array<{id: number; source: string; translation: string}>;
}
interface TranslationStatus {status: string; error: string; progress: number; translating?: boolean}
interface ResumeSettings {name: string; glossary: PublicGlossaryState; documentBatchTranslation: boolean; from: string; to: string; inputSha256: string}
interface ResumePorts {
    readSnapshot(): Promise<ResumeSnapshot | null>;
    readSettings(): Promise<ResumeSettings>;
    saveFailure(failure: Record<string, unknown>, snapshot: ResumeSnapshot | null): Promise<void>;
    activateContinue(): Promise<string | void>;
    assertActive(): void;
    persist(): void;
}
interface ResumeGuard {
    failures: Array<Record<string, unknown>>; recoveries: Array<Record<string, unknown>>; deadline: number;
    tryResume(current: TranslationStatus, ports: ResumePorts): Promise<boolean>;
    verifyFinal(snapshot: ResumeSnapshot, readSettings: ResumePorts['readSettings']): Promise<Record<string, unknown> | null>;
}
interface AuditedPdfPage {
    label?: string; width: number; height: number; text: string; originalText?: string;
    webLinks: Array<{url: string; right: number}>;
}
const require = createRequire(import.meta.url);
const fileSystem = require('node:fs') as typeof import('node:fs');
const {createResponseBodyObserver, closeLiveSession, isProviderDomain, shouldObserveResponseBody, validateLayoutCopyText, validatePdf,
    parseBuiltinGlossaryArg, readPublicGlossaryState, selectPublicDocumentGlossary, installBuiltinGlossaryForLiveRun,
    parseTranslationResumesArg, readPublicResumeSettings, readProductionTranslationStatus, isResumableTranslationTimeout, isTranslationTimeoutSettling, assertPreservedTranslations, createTranslationResumeGuard,
    activateProductionTranslationContinue} = require(resolve(__dirname, '../scripts/testing/run-document-live-translation.cjs')) as {
    createResponseBodyObserver(options?: {timeoutMs?: number}): BodyObserver;
    closeLiveSession(options: {launched?: {close(): Promise<void>}; focusMonitor?: {stop(): Promise<void>}; profileDir: string; launchAttempted: boolean; report: CleanupReport; responseObserver?: BodyObserver}): Promise<void>;
    isProviderDomain(host: string): boolean;
    shouldObserveResponseBody(record: {providerCandidate: boolean}, response: {url(): string; headers(): Record<string, string>}): boolean;
    validateLayoutCopyText(snapshot: {pages: Array<{pageNumber: number; segmentIndexes: number[]}>; segments: ResumeSnapshot['segments']},
        output: Array<{label: string; translatedText?: string; continuationText?: string; notes?: string[]; text?: string}>): {
        ok: boolean; checkedSegments: number; checkedNotes: number; missingSegments: Array<{pageNumber: number; id: number; characters: number}>;
        missingContinuationText: Array<{pageNumber: number; characters: number}>; formatOnlyNotes: Array<{pageNumber: number; characters: number}>;
    };
    validatePdf(source: AuditedPdfPage[], output: AuditedPdfPage[]): {ok: boolean; pages: Array<{sourceOrderOk: boolean; missingWebLinks: number}>};
    parseBuiltinGlossaryArg(args: string[]): string | null;
    readPublicGlossaryState(presetId?: string | null): Promise<PublicGlossaryState>;
    selectPublicDocumentGlossary(value: {id: string; presetId: string}): Promise<void>;
    installBuiltinGlossaryForLiveRun(options: {page: unknown; origin: string; presetId: string; checkFocus(phase: string): Promise<void>}): Promise<{
        presetId: string; source: string; before: PublicGlossaryState; imported: PublicGlossaryState; selected: PublicGlossaryState; optionsUrl: string;
    }>;
    parseTranslationResumesArg(args: string[]): number;
    readPublicResumeSettings(): Promise<Record<string, unknown>>;
    readProductionTranslationStatus(): TranslationStatus & {retry: string};
    isResumableTranslationTimeout(current: TranslationStatus): boolean;
    isTranslationTimeoutSettling(current: TranslationStatus): boolean;
    assertPreservedTranslations(previous: ResumeSnapshot[], snapshot: ResumeSnapshot): number;
    createTranslationResumeGuard(options: {limit: number; started: number; timeout: number; settings: ResumeSettings | null; now?: () => number; sleep?: (ms: number) => Promise<void>}): ResumeGuard;
    activateProductionTranslationContinue(options: {page: unknown; checkFocus(phase: string): Promise<void>; number: number; deadline: number; readStatus(): Promise<TranslationStatus>}): Promise<string>;
};
const temporaryDirectories: string[] = [];
const profile = () => {
    const directory = fileSystem.mkdtempSync(resolve(tmpdir(), 'fluentread-live-driver-test-'));
    temporaryDirectories.push(directory); return directory;
};
const flushMicrotasks = async () => {for (let index = 0; index < 8; index++) await Promise.resolve();};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
    for (const directory of temporaryDirectories.splice(0)) fileSystem.rmSync(directory, {recursive: true, force: true});
});

describe('真实文档工具响应诊断有界收尾（离线）', () => {
    it('正常正文保留实际翻译 hash、尾部与结束原因，不保留任意响应字段', async () => {
        const observer = createResponseBodyObserver({timeoutMs: 25}), record: NetworkRecord = {document: 'first.md'};
        const translated = '这是正常响应的完整译文。';
        await observer.observe({json: async () => ({choices: [{message: {content: translated}, finish_reason: 'stop'}], privateField: 'not retained'})}, record);
        await observer.drain();
        expect(record.translations).toEqual([{sha256: createHash('sha256').update(translated).digest('hex'), chars: translated.length, tail: translated}]);
        expect(record.finishReasons).toEqual(['stop']); expect(record).not.toHaveProperty('privateField');
        expect(record.bodyObservation?.state).toBe('completed');
        expect(observer.stats).toMatchObject({started: 1, completed: 1, timedOut: 0, failed: 0, active: 0, drainTimeouts: 0});
    });

    it('挂起的 JSON 在读取截止后完成诊断，不能伪造上游译文匹配', async () => {
        const observer = createResponseBodyObserver({timeoutMs: 25}), record: NetworkRecord = {document: 'failed.pdf'};
        const completion = observer.observe({json: () => new Promise(() => {})}, record);
        await vi.advanceTimersByTimeAsync(24); expect(record.bodyObservation?.state).toBe('pending');
        await vi.advanceTimersByTimeAsync(1); await completion; await observer.drain();
        expect(record.bodyObservation).toMatchObject({state: 'timedOut', reason: 'body-deadline', elapsedMs: 25});
        expect(record.translations).toBeUndefined(); expect(record.finishReasons).toBeUndefined();
        expect(observer.stats).toMatchObject({timedOut: 1, completed: 0, active: 0});
    });

    it('读取拒绝和同步异常都记录失败类型，不泄露异常正文或重复等待', async () => {
        const observer = createResponseBodyObserver({timeoutMs: 25});
        const records: NetworkRecord[] = [{document: 'a'}, {document: 'b'}];
        await observer.observe({json: async () => {throw new SyntaxError('sensitive-response-text');}}, records[0]!);
        await observer.observe({json: () => {throw new Error('sensitive-response-text');}}, records[1]!);
        await observer.drain();
        expect(records.map(record => record.bodyObservation?.errorName)).toEqual(['SyntaxError', 'Error']);
        expect(records.every(record => record.bodyObservation?.state === 'failed')).toBe(true);
        expect(JSON.stringify(records)).not.toContain('sensitive-response-text');
        expect(observer.stats).toMatchObject({started: 2, failed: 2, active: 0});
    });

    it('晚正文不能回填超时记录或串到下一份文档，下一份正常证据保持独立', async () => {
        const observer = createResponseBodyObserver({timeoutMs: 25}), first: NetworkRecord = {document: 'first.pdf'}, next: NetworkRecord = {document: 'next.md'};
        let completeLate!: (value: unknown) => void;
        const completion = observer.observe({json: () => new Promise(resolve => {completeLate = resolve;})}, first);
        await vi.advanceTimersByTimeAsync(25); await completion;
        await observer.observe({json: async () => ({result: '下一份已完成'})}, next);
        const oldRecord = JSON.stringify(first), nextRecord = JSON.stringify(next), counts = {...observer.stats};
        completeLate({result: '上一份的晚正文'}); await flushMicrotasks(); await observer.drain();
        expect(JSON.stringify(first)).toBe(oldRecord); expect(JSON.stringify(next)).toBe(nextRecord); expect(observer.stats).toEqual(counts);
        expect(first.document).toBe('first.pdf'); expect(first.translations).toBeUndefined();
        expect(next.document).toBe('next.md'); expect(next.translations?.[0]?.tail).toBe('下一份已完成');
    });

    it('提前 drain 截止会结束当时挂起的读取，后续文档仍使用自己的正常读取时限', async () => {
        const observer = createResponseBodyObserver({timeoutMs: 5000}), first: NetworkRecord = {document: 'first'};
        observer.observe({json: () => new Promise(() => {})}, first);
        const draining = observer.drain({timeoutMs: 10});
        await vi.advanceTimersByTimeAsync(10); await draining;
        expect(first.bodyObservation).toMatchObject({state: 'timedOut', reason: 'drain-deadline'});
        const next: NetworkRecord = {document: 'next'};
        await observer.observe({json: async () => ({translation: '下一份译文'})}, next);
        expect(next.bodyObservation?.state).toBe('completed');
        expect(observer.stats).toMatchObject({drainTimeouts: 1, timedOut: 1, completed: 1, active: 0});
        expect(() => createResponseBodyObserver({timeoutMs: Infinity})).toThrow('finite deadline');
        await expect(observer.drain({timeoutMs: 0})).rejects.toThrow('finite deadline');
    });

    it('自有浏览器先关闭，挂起诊断最多再等一秒，原生观察器仍收尾且严格焦点失败保留', async () => {
        const observer = createResponseBodyObserver(), record: NetworkRecord = {document: 'failed'}, directory = profile();
        observer.observe({json: () => new Promise(() => {})}, record);
        const close = vi.fn(async () => {}), stop = vi.fn(async () => {});
        const report: CleanupReport = {cleanupErrors: [], focusFailure: 'Owned Edge activation', ok: false};
        const closing = closeLiveSession({launched: {close}, focusMonitor: {stop}, profileDir: directory, launchAttempted: true, report, responseObserver: observer});
        await flushMicrotasks(); expect(close).toHaveBeenCalledOnce(); expect(fileSystem.existsSync(directory)).toBe(false); expect(stop).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1000); await closing;
        expect(stop).toHaveBeenCalledOnce(); expect(observer.stats.active).toBe(0); expect(record.bodyObservation?.state).toBe('timedOut');
        expect(report).toEqual({cleanupErrors: [], focusFailure: 'Owned Edge activation', ok: false});
    });

    it('浏览器关闭失败保留专用 profile 和错误，仍关闭观察器', async () => {
        const directory = profile(), stop = vi.fn(async () => {}), report: CleanupReport = {cleanupErrors: []};
        await closeLiveSession({launched: {close: async () => {throw new Error('owned close failed');}}, focusMonitor: {stop}, profileDir: directory, launchAttempted: true, report});
        expect(report.retainedProfile).toBe(directory); expect(fileSystem.existsSync(directory)).toBe(true);
        expect(report.cleanupErrors).toEqual(['Error: owned close failed']); expect(stop).toHaveBeenCalledOnce();
    });

    it('profile 删除异常与 drain 异常各自记录，不能阻断原生观察器关闭', async () => {
        const directory = profile(), stop = vi.fn(async () => {}), report: CleanupReport = {cleanupErrors: []};
        vi.spyOn(fileSystem, 'rmSync').mockImplementation(() => {throw new Error('profile cleanup failed');});
        const observer = createResponseBodyObserver(); vi.spyOn(observer, 'drain').mockRejectedValue(new Error('diagnostic drain failed'));
        await closeLiveSession({launched: {close: async () => {}}, focusMonitor: {stop}, profileDir: directory, launchAttempted: true, report, responseObserver: observer});
        expect(report.retainedProfile).toBe(directory); expect(fileSystem.existsSync(directory)).toBe(true); expect(stop).toHaveBeenCalledOnce();
        expect(report.cleanupErrors).toEqual(['Error: profile cleanup failed', 'Error: diagnostic drain failed']);
    });

    it('只补 Lingvanex 官方固定翻译域，临时认证、CSRF 和非 JSON 正文继续排除', () => {
        expect(isProviderDomain('api-b2b.backenster.com')).toBe(true);
        for (const host of ['backenster.com', 'other.backenster.com', 'api-b2b.backenster.com.attacker.example']) expect(isProviderDomain(host)).toBe(false);
        const response = (pathname: string, type = 'application/json') => ({url: () => `https://api-b2b.backenster.com${pathname}`, headers: () => ({'content-type': type})});
        expect(shouldObserveResponseBody({providerCandidate: true}, response('/b1/api/v3/translate'))).toBe(true);
        for (const pathname of ['/csrf', '/token', '/auth']) expect(shouldObserveResponseBody({providerCandidate: true}, response(pathname))).toBe(false);
        expect(shouldObserveResponseBody({providerCandidate: true}, response('/translate', 'text/html'))).toBe(false);
        expect(shouldObserveResponseBody({providerCandidate: false}, response('/translate'))).toBe(false);
    });
});

const aiLibrary = () => {
    const added = addBuiltinGlossary('ai-en-zh-hans', [], '人工智能 · 英→简中');
    if (added.status !== 'added') throw new Error('Actual builtin factory must create its copy');
    return added.library;
};
const publicConfigPort = (libraries: GlossaryLibrary[] = [], glossaryEnabled = false) => {
    const config = {glossaryEnabled, glossaryLibraries: libraries, documentGlossaryIds: null as string[] | null,
        privateToken: 'private-token-not-for-report', userPrivateSetting: {text: 'private-config-not-for-report'}};
    const messages: Array<Record<string, unknown>> = [];
    const sendMessage = vi.fn(async (message: Record<string, unknown>) => {
        messages.push(structuredClone(message));
        if (message.type === 'configStorageRead') return {success: true, value: JSON.stringify(config)};
        if (message.type === 'persistConfig') {
            const patch = message.config as {documentGlossaryIds: string[]};
            expect(message.expected).toEqual({documentGlossaryIds: config.documentGlossaryIds});
            config.documentGlossaryIds = [...patch.documentGlossaryIds];
            return {success: true};
        }
        throw new Error('Unexpected public message');
    });
    vi.stubGlobal('chrome', {runtime: {sendMessage}});
    return {config, messages, sendMessage};
};
const builtinUiPort = (enabled = false) => {
    const port = publicConfigPort([], enabled), interactions: string[] = [];
    const waitFor = vi.fn(async () => {});
    const card = {
        waitFor,
        locator(selector: string) {
            interactions.push(selector);
            if (selector === 'h4') return {innerText: async () => '人工智能 · 英→简中'};
            if (selector === 'button.builtin-add') return {click: async () => {
                const added = addBuiltinGlossary('ai-en-zh-hans', port.config.glossaryLibraries, '人工智能 · 英→简中');
                if (added.status !== 'added') throw new Error('UI must add its actual builtin copy');
                port.config.glossaryLibraries = added.libraries;
            }};
            if (selector === '.builtin-added') return {waitFor: async () => {expect(port.config.glossaryLibraries).toHaveLength(1);}};
            throw new Error(`Unexpected card selector: ${selector}`);
        },
    };
    const master = {getAttribute: async (attribute: string) => {
        expect(attribute).toBe('aria-checked'); return String(port.config.glossaryEnabled);
    }, focus: async () => {interactions.push('master-focus');}};
    const glossary = {waitFor, getByTestId(id: string) {expect(id).toBe('builtin-ai-en-zh-hans'); interactions.push(id); return card;},
        locator(selector: string) {expect(selector).toBe('.feature-enable-card [role="switch"]'); return master;}};
    const page = {
        goto: vi.fn(async (url: string) => {interactions.push(url);}),
        getByTestId(id: string) {expect(id).toBe('glossary-settings'); interactions.push(id); return glossary;},
        evaluate<T, A>(callback: (argument: A) => Promise<T>, argument: A) {return callback(argument);},
        waitForFunction: async (callback: () => Promise<boolean>, _argument: null, options: {timeout: number}) => {
            expect(options.timeout).toBe(15000); expect(await callback()).toBe(true);
        },
        keyboard: {press: vi.fn(async (key: string) => {expect(key).toBe('Space'); port.config.glossaryEnabled = true;})},
    };
    return {...port, page, interactions};
};

describe('真实文档工具可选内置词库（离线端口，不运行翻译）', () => {
    it('无参数保持默认，唯一合法 AI 参数可用，拼错、缺值和重复在启动前拒绝', () => {
        expect(parseBuiltinGlossaryArg(['--service', 'freeTranslation'])).toBeNull();
        expect(parseBuiltinGlossaryArg(['--builtin-glossary', 'ai-en-zh-hans', '--service', 'freeTranslation'])).toBe('ai-en-zh-hans');
        for (const args of [['--builtin-glossary'], ['--builtin-glossary', '--service'], ['--builtin-glossary', 'unknown'],
            ['--builtin-glossary=ai-en-zh-hans'], ['--builtin-glossary', 'ai-en-zh-hans', '--builtin-glossary', 'ai-en-zh-hans']]) {
            expect(() => parseBuiltinGlossaryArg(args)).toThrow();
        }
    });

    it('投影真实内置副本版本、条目数量与选择状态，不带词表或私人配置', async () => {
        const library = aiLibrary(), port = publicConfigPort([library], true);
        port.config.documentGlossaryIds = [library.id];
        const before = structuredClone(port.config), state = await readPublicGlossaryState('ai-en-zh-hans');
        const actualPreset = BUILTIN_GLOSSARIES.find(preset => preset.id === 'ai-en-zh-hans')!;
        expect(state).toEqual({glossaryEnabled: true, documentGlossaryIds: [library.id], libraries: [{id: library.id,
            name: library.name, enabled: true, presetId: actualPreset.id, presetVersion: actualPreset.version, termCount: actualPreset.terms.length}]});
        expect(port.config).toEqual(before); expect(port.messages).toEqual([{type: 'configStorageRead', key: 'local:config'}]);
        const serialized = JSON.stringify(state);
        expect(serialized).not.toContain('private-'); expect(serialized).not.toContain('entries'); expect(serialized).not.toContain(actualPreset.terms[0]![0]);
    });

    it('默认模式只读真实继承/显式空选择，停用库与其它配置保持原样', async () => {
        const active = aiLibrary(), disabled = {...aiLibrary(), id: 'disabled-library', enabled: false};
        const port = publicConfigPort([active, disabled]);
        expect(await readPublicGlossaryState()).toMatchObject({glossaryEnabled: false, documentGlossaryIds: null, libraries: [{id: active.id}]});
        port.config.documentGlossaryIds = [];
        expect(await readPublicGlossaryState()).toEqual({glossaryEnabled: false, documentGlossaryIds: [], libraries: []});
        expect(port.messages.every(message => message.type === 'configStorageRead')).toBe(true);
    });

    it('公开端口读取失败或无效元数据立即失败，错误不带私人响应正文', async () => {
        const sendMessage = vi.fn(); vi.stubGlobal('chrome', {runtime: {sendMessage}});
        for (const [response, error] of [
            [{success: false, error: 'private-response'}, 'read failed'],
            [{success: true, value: 'private-invalid-json'}, 'Invalid public glossary configuration'],
            [{success: true, value: {glossaryLibraries: null}}, 'Invalid public glossary libraries'],
            [{success: true, value: {glossaryLibraries: [], documentGlossaryIds: [4]}}, 'Invalid public document glossary selection'],
            [{success: true, value: {glossaryLibraries: [{enabled: true, id: 'a', name: 'a', entries: null}]}}, 'Invalid selected glossary metadata'],
            [{success: true, value: {glossaryLibraries: [{enabled: true, id: 'a', name: 'a', entries: [], preset: {id: 'a', version: 0}}]}}, 'Invalid selected glossary preset'],
        ] as const) {
            sendMessage.mockResolvedValueOnce(response);
            await expect(readPublicGlossaryState()).rejects.toThrow(error);
        }
    });

    it('只 CAS 选择已经由 UI 导入且启用的真实 ID，词条和私人设置没有写入', async () => {
        const library = aiLibrary(), port = publicConfigPort([library], true), before = structuredClone(port.config);
        await selectPublicDocumentGlossary({id: library.id, presetId: 'ai-en-zh-hans'});
        expect(port.config).toEqual({...before, documentGlossaryIds: [library.id]});
        const writes = port.messages.filter(message => message.type === 'persistConfig'); expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({mode: 'patch', config: {documentGlossaryIds: [library.id]}, expected: {documentGlossaryIds: null}, sequence: 1});
        expect(Object.keys(writes[0]!)).toEqual(['type', 'mode', 'config', 'expected', 'clientId', 'sequence']);
        expect(writes[0]!.clientId).toMatch(/^document-live-glossary-/u);
    });

    it('不能替换未导入/停用/其它预设库，公开 CAS 拒绝也立即失败', async () => {
        const library = aiLibrary(), port = publicConfigPort([library]);
        const selection = {id: library.id, presetId: 'ai-en-zh-hans'};
        await expect(selectPublicDocumentGlossary(selection)).rejects.toThrow('not enabled');
        port.config.glossaryEnabled = true; library.enabled = false;
        await expect(selectPublicDocumentGlossary(selection)).rejects.toThrow('not enabled');
        library.enabled = true;
        await expect(selectPublicDocumentGlossary({...selection, id: 'not-imported'})).rejects.toThrow('not enabled');
        await expect(selectPublicDocumentGlossary({...selection, presetId: 'software-en-zh-hans'})).rejects.toThrow('Invalid builtin');
        expect(port.messages.every(message => message.type === 'configStorageRead')).toBe(true);
        port.sendMessage.mockImplementation(async message => message.type === 'configStorageRead'
            ? {success: true, value: JSON.stringify(port.config)} : {success: false, value: 'private-rejection'});
        await expect(selectPublicDocumentGlossary(selection)).rejects.toThrow('selection was rejected');
    });

    it('实际 UI 契约导入生产工厂副本，经 Space 启用并只选择其真实 ID，每步保留焦点检查', async () => {
        const port = builtinUiPort(), checkFocus = vi.fn(async (_phase: string) => {}), origin = 'chrome-extension://actual-build';
        const result = await installBuiltinGlossaryForLiveRun({page: port.page, origin, presetId: 'ai-en-zh-hans', checkFocus});
        const library = port.config.glossaryLibraries[0]!;
        expect(port.page.goto).toHaveBeenCalledWith(origin + '/options.html#settings-glossary', {waitUntil: 'domcontentloaded'});
        expect(port.interactions).toContain('builtin-ai-en-zh-hans'); expect(port.interactions).toContain('button.builtin-add');
        expect(port.interactions).toContain('master-focus'); expect(port.page.keyboard.press).toHaveBeenCalledOnce();
        expect(result.before).toEqual({glossaryEnabled: false, documentGlossaryIds: null, libraries: []});
        expect(result.selected).toEqual({...result.imported, glossaryEnabled: true, documentGlossaryIds: [library.id]});
        expect(result.selected.libraries[0]).toMatchObject({presetId: 'ai-en-zh-hans', presetVersion: library.preset!.version, termCount: library.entries.length});
        expect(port.messages.filter(message => message.type === 'persistConfig').map(message => message.config)).toEqual([{documentGlossaryIds: [library.id]}]);
        expect(checkFocus.mock.calls.map(([phase]) => phase)).toEqual(['builtin-glossary-options-open', 'builtin-glossary-import', 'builtin-glossary-enable', 'builtin-glossary-document-selection']);
    });

    it('已有开启的 master 不重复切换，已有副本或焦点检查失败不得继续导入或写配置', async () => {
        const enabled = builtinUiPort(true), checkFocus = vi.fn(async (_phase: string) => {});
        await installBuiltinGlossaryForLiveRun({page: enabled.page, origin: 'chrome-extension://actual-build', presetId: 'ai-en-zh-hans', checkFocus});
        expect(enabled.page.keyboard.press).not.toHaveBeenCalled();
        const existing = builtinUiPort(); existing.config.glossaryLibraries = [aiLibrary()];
        await expect(installBuiltinGlossaryForLiveRun({page: existing.page, origin: 'chrome-extension://actual-build', presetId: 'ai-en-zh-hans', checkFocus})).rejects.toThrow('Fresh profile');
        expect(existing.interactions).not.toContain('button.builtin-add');
        const stopped = builtinUiPort();
        await expect(installBuiltinGlossaryForLiveRun({page: stopped.page, origin: 'chrome-extension://actual-build', presetId: 'ai-en-zh-hans',
            checkFocus: async phase => {if (phase === 'builtin-glossary-import') throw new Error('Owned Edge activation');}})).rejects.toThrow('Owned Edge activation');
        expect(stopped.config.glossaryLibraries).toEqual([]); expect(stopped.messages.every(message => message.type === 'configStorageRead')).toBe(true);
    });
});

const resumeSnapshot = (completed = 1): ResumeSnapshot => ({name: 'public.pdf', format: 'pdf', parsedVersion: 13,
    pages: [{pageNumber: 1}], segments: Array.from({length: 4}, (_value, id) => ({id, source: `Saved source ${id}`,
        translation: id < completed ? `已完成 ${id}\u00a0` : ''}))});
const resumeSettings = (): ResumeSettings => ({name: 'public.pdf', from: 'en', to: 'zh-Hans', documentBatchTranslation: true,
    inputSha256: 'actual-input-sha', glossary: {glossaryEnabled: true, documentGlossaryIds: ['actual-library'],
        libraries: [{id: 'actual-library', name: 'AI', enabled: true, presetId: 'ai-en-zh-hans', presetVersion: 2, termCount: 65}]}});
const timeoutStatus = (completed = 1): TranslationStatus => ({status: `翻译中断 · ${completed} / 4`,
    error: '第 283 段文档翻译失败：请求超时', progress: Math.floor(completed / 4 * 100)});
const resumePort = (snapshot = resumeSnapshot(), settings = resumeSettings()) => {
    const captured: Array<{failure: Record<string, unknown>; snapshot: ResumeSnapshot | null}> = [];
    const ports = {readSnapshot: vi.fn(async () => structuredClone(snapshot)), readSettings: vi.fn(async () => structuredClone(settings)),
        saveFailure: vi.fn(async (failure: Record<string, unknown>, value: ResumeSnapshot | null) => {
            captured.push({failure: structuredClone(failure), snapshot: structuredClone(value)});
        }), activateContinue: vi.fn<ResumePorts['activateContinue']>(async () => {}), assertActive: vi.fn(), persist: vi.fn()};
    return {ports, captured};
};

describe('真实文档工具有界超时继续（离线守卫，不调用 MT）', () => {
    it('默认零次，整数 0..3 合法；缺值、重复、隐式转换和越界在启动前拒绝', () => {
        expect(parseTranslationResumesArg(['--service', 'freeTranslation'])).toBe(0);
        for (const value of ['0', '1', '2', '3']) expect(parseTranslationResumesArg(['--translation-resumes', value])).toBe(Number(value));
        for (const args of [['--translation-resumes'], ['--translation-resumes', '--service'], ['--translation-resumes', '4'],
            ['--translation-resumes', '-1'], ['--translation-resumes', '1.0'], ['--translation-resumes', '03'],
            ['--translation-resumes', 'Infinity'], ['--translation-resumes=1'], ['--translation-resumes', '1', '--translation-resumes', '2']]) {
            expect(() => parseTranslationResumesArg(args)).toThrow();
        }
        expect(() => createTranslationResumeGuard({limit: 4, started: 0, timeout: 1000, settings: null})).toThrow('limit');
    });

    it('仅已观察到的 terminal timeout 可恢复；暂停、取消、鉴权、配置及回显原样 fail-fast', async () => {
        expect(isResumableTranslationTimeout(timeoutStatus())).toBe(true);
        expect(isResumableTranslationTimeout({...timeoutStatus(), error: '翻译请求超时'})).toBe(true);
        for (const status of ['翻译中断已翻译12/27', '翻译中断已翻译 12 / 27 · 44%', '翻译中断']) {
            expect(isResumableTranslationTimeout({...timeoutStatus(), status})).toBe(true);
        }
        const excluded = [{status: '已暂停', error: '请求超时'}, {status: '正在翻译', error: '请求超时'},
            {status: '译文与原文相同，可换目标语言', error: '请求超时'}, {status: '翻译中断', error: '请求取消'},
            ...['401', '403', 'AUTH', 'bad config', '鉴权', '配置错误', '原文回显'].map(reason => ({status: '翻译中断', error: `${reason}：请求超时`})),
            {status: '翻译中断', error: '服务拒绝请求'}, {status: '翻译中断', error: '请求超时，将重试'},
            ...['翻译中断已翻译', '翻译中断已翻译12/27未知操作', '翻译中断待重译', '未翻译中断已翻译12/27'].map(status => ({status, error: '请求超时'}))];
        for (const value of excluded) {
            const current = {...value, progress: 25}, {ports} = resumePort();
            expect(isResumableTranslationTimeout(current)).toBe(false);
            const guard = createTranslationResumeGuard({limit: 3, started: Date.now(), timeout: 1000, settings: resumeSettings()});
            expect(await guard.tryResume(current, ports)).toBe(false);
            expect(ports.saveFailure).not.toHaveBeenCalled(); expect(ports.activateContinue).not.toHaveBeenCalled();
        }
        const {ports} = resumePort(), disabled = createTranslationResumeGuard({limit: 0, started: Date.now(), timeout: 1000, settings: null});
        expect(await disabled.tryResume(timeoutStatus(), ports)).toBe(false); expect(ports.readSnapshot).not.toHaveBeenCalled();
    });

    it('当前恢复提示按 alert/status 读取完整详情并保留原状态，不把摘要或切换服务文案当错误', () => {
        const elements: Record<string, {textContent?: string; getAttribute?(name: string): string}> = {
            '.document-status': {textContent: ' 翻译中断已翻译12/27 '},
            '.task-progress': {getAttribute: () => '44'}, '.taskbar-actions .pause-button': {},
            '.translation-recovery[role="alert"]': {textContent: '请求超时切换服务错误详情'},
            '.translation-recovery[role="alert"] .recovery-error-detail': {textContent: ' 第 13 段文档翻译失败：请求超时 '},
            '.translation-recovery[role="status"] .recovery-error-detail': {textContent: ' 服务暂时无响应，将自动重试 · 3s · 请求超时 '},
            '.taskbar-notices .notice.error': {textContent: '旧错误'}, '.taskbar-notices .notice.warning': {textContent: '旧重试'},
        };
        vi.stubGlobal('document', {querySelector: (selector: string) => elements[selector] ?? null});
        expect(readProductionTranslationStatus()).toEqual({status: '翻译中断已翻译12/27', progress: 44, translating: true,
            error: '第 13 段文档翻译失败：请求超时', retry: '服务暂时无响应，将自动重试 · 3s · 请求超时'});
        delete elements['.translation-recovery[role="alert"] .recovery-error-detail'];
        delete elements['.taskbar-actions .pause-button'];
        expect(readProductionTranslationStatus()).toMatchObject({translating: false, error: '旧错误', retry: '服务暂时无响应，将自动重试 · 3s · 请求超时'});
        delete elements['.translation-recovery[role="status"] .recovery-error-detail'];
        expect(readProductionTranslationStatus().retry).toBe('旧重试');
        for (const selector of Object.keys(elements)) delete elements[selector];
        expect(readProductionTranslationStatus()).toEqual({status: '', progress: 0, translating: false, error: '', retry: ''});
    });

    it('自动等待提示只有 retry 详情，不应当作 terminal 错误或触发手动恢复', async () => {
        const elements: Record<string, {textContent?: string}> = {
            '.document-status': {textContent: '正在翻译已翻译12/27'}, '.taskbar-actions .pause-button': {},
            '.translation-recovery[role="status"] .recovery-error-detail': {textContent: '服务暂时无响应，将自动重试 · 3s · 请求超时'},
        };
        vi.stubGlobal('document', {querySelector: (selector: string) => elements[selector] ?? null});
        const current = readProductionTranslationStatus();
        expect(current).toMatchObject({translating: true, error: '', retry: '服务暂时无响应，将自动重试 · 3s · 请求超时'});
        expect(isTranslationTimeoutSettling(current)).toBe(false); expect(isResumableTranslationTimeout(current)).toBe(false);
        const {ports} = resumePort(), guard = createTranslationResumeGuard({limit: 1, started: Date.now(), timeout: 1000, settings: resumeSettings()});
        expect(await guard.tryResume(current, ports)).toBe(false); expect(ports.activateContinue).not.toHaveBeenCalled();
    });

    it('收取已发结果期间只观察原 timeout，不提前捕获或点击；真正收尾后才允许恢复', async () => {
        for (const current of [{...timeoutStatus(), translating: true},
            {...timeoutStatus(), status: '翻译中断 · 正在收取已发出的结果已翻译1/4'},
            {...timeoutStatus(), status: '翻译中断 · 正在收取已发出的结果已翻译1/4', translating: true}]) {
            expect(isTranslationTimeoutSettling(current)).toBe(true);
            expect(isResumableTranslationTimeout(current)).toBe(false);
            const {ports} = resumePort(), guard = createTranslationResumeGuard({limit: 1, started: Date.now(), timeout: 1000, settings: resumeSettings()});
            expect(await guard.tryResume(current, ports)).toBe(false);
            expect(ports.readSnapshot).not.toHaveBeenCalled(); expect(ports.activateContinue).not.toHaveBeenCalled();
        }
        const terminal = {...timeoutStatus(), status: '翻译中断已翻译1/4', translating: false};
        expect(isTranslationTimeoutSettling(terminal)).toBe(false); expect(isResumableTranslationTimeout(terminal)).toBe(true);
        expect(isTranslationTimeoutSettling({...terminal, translating: true, error: '401：请求超时'})).toBe(false);
        const {ports} = resumePort(), disabled = createTranslationResumeGuard({limit: 0, started: Date.now(), timeout: 1000, settings: null});
        expect(await disabled.tryResume(terminal, ports)).toBe(false); expect(ports.activateContinue).not.toHaveBeenCalled();
    });

    it.each(['重试', '继续翻译', undefined])('恢复记录保留实际主按钮 %s 并兼容未回传名称的旧端口', async action => {
        const {ports, captured} = resumePort(), guard = createTranslationResumeGuard({limit: 1, started: Date.now(), timeout: 1000, settings: resumeSettings()});
        ports.activateContinue.mockResolvedValueOnce(action);
        const current = {...timeoutStatus(), status: '翻译中断已翻译1/4'};
        expect(await guard.tryResume(current, ports)).toBe(true);
        expect(captured[0]?.failure.status).toBe(current.status);
        expect(guard.failures[0]).toMatchObject({observedCompleted: 1, observedTotal: 4, resumed: true});
        expect(guard.recoveries[0]).toMatchObject({actualButtonName: action ?? null,
            actualAction: `Same production document: ${action ?? 'resume (legacy port; button name unreported)'}`});
    });

    it('恢复端口不能将重新翻译记录为合法恢复动作', async () => {
        const {ports} = resumePort(), guard = createTranslationResumeGuard({limit: 1, started: Date.now(), timeout: 1000, settings: resumeSettings()});
        ports.activateContinue.mockResolvedValueOnce('重新翻译');
        await expect(guard.tryResume(timeoutStatus(), ports)).rejects.toThrow('Unsupported production resume action');
        expect(guard.failures[0]).toMatchObject({resumed: false}); expect(guard.recoveries).toEqual([]);
    });

    it('公开恢复配置只保留文档、语言、免费池及合批设置，不带任何凭据', async () => {
        const port = publicConfigPort([aiLibrary()], true);
        Object.assign(port.config, {from: 'en', to: 'zh-Hans', service: 'freeTranslation', documentService: 'freeTranslation',
            freeTranslationOrder: ['microsoft'], freeTranslationMode: 'hedged', freeTranslationTimeoutMs: 20000, apiKey: 'private-api-key'});
        vi.stubGlobal('document', {querySelector: (selector: string) => selector === '.document-batch-translation:not([data-testid="document-ai-context-toggle"]) input'
            ? {checked: true} : {textContent: ' public.pdf '}});
        const state = await readPublicResumeSettings();
        expect(state).toEqual({name: 'public.pdf', from: 'en', to: 'zh-Hans', service: 'freeTranslation', documentService: 'freeTranslation',
            freeTranslationOrder: ['microsoft'], freeTranslationMode: 'hedged', freeTranslationTimeoutMs: 20000, documentBatchTranslation: true});
        expect(JSON.stringify(state)).not.toContain('private');
        port.sendMessage.mockResolvedValueOnce({success: false}); await expect(readPublicResumeSettings()).rejects.toThrow('read failed');
    });

    it('每次先保存原错误及完成目标，再继续同一文档；恢复上限耗尽仍保存失败且不能变成通过', async () => {
        const settings = resumeSettings(), {ports, captured} = resumePort(), guard = createTranslationResumeGuard({limit: 3, started: Date.now(), timeout: 10000, settings});
        ports.activateContinue.mockImplementation(async () => {expect(ports.saveFailure).toHaveBeenCalledTimes(guard.recoveries.length + 1);});
        for (let completed = 1; completed <= 3; completed++) {
            ports.readSnapshot.mockResolvedValueOnce(resumeSnapshot(completed));
            expect(await guard.tryResume(timeoutStatus(completed), ports)).toBe(true);
        }
        ports.readSnapshot.mockResolvedValueOnce(resumeSnapshot(3));
        expect(await guard.tryResume(timeoutStatus(3), ports)).toBe(false);
        expect(ports.activateContinue).toHaveBeenCalledTimes(3); expect(captured).toHaveLength(4);
        expect(captured.map(value => value.failure.completed)).toEqual([1, 2, 3, 3]);
        expect(captured.every(value => value.failure.resumed === false && value.failure.error === timeoutStatus().error)).toBe(true);
        expect(guard.failures[0]).toMatchObject({resumed: true, stoppedBatchFirstSegment: 283,
            stopNumberMeaning: 'Failed batch first segment; not evidence of the root-cause slot'});
        expect(guard.failures[3]).toMatchObject({resumed: false, resumeRefused: 'Resume limit or original deadline exhausted'});
        expect(guard.recoveries.map(value => value.completedBefore)).toEqual([1, 2, 3]);
    });

    it('原始总截止包含快照/截图/点击时间，挂起的后续快照只能等待剩余时间，不能重置预算', async () => {
        vi.setSystemTime(1000);
        const settings = resumeSettings(), {ports} = resumePort(), guard = createTranslationResumeGuard({limit: 3, started: Date.now(), timeout: 1000, settings});
        const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
        ports.readSnapshot.mockImplementationOnce(async () => {await delay(250); return resumeSnapshot();});
        ports.saveFailure.mockImplementationOnce(async () => {await delay(250);});
        ports.activateContinue.mockImplementationOnce(async () => {await delay(250);});
        const first = guard.tryResume(timeoutStatus(), ports);
        await vi.advanceTimersByTimeAsync(750); expect(await first).toBe(true);
        expect(guard.deadline).toBe(2000); expect(guard.recoveries[0]).toMatchObject({elapsedMs: 750, originalDeadline: 2000});
        ports.readSnapshot.mockImplementationOnce(() => new Promise(() => {}));
        const second = expect(guard.tryResume(timeoutStatus(), ports)).rejects.toThrow('original translation deadline');
        await vi.advanceTimersByTimeAsync(250); await second;
        expect(Date.now()).toBe(2000); expect(ports.activateContinue).toHaveBeenCalledOnce();
        expect(guard.failures).toHaveLength(2); expect(guard.failures[1]).toMatchObject({elapsedMs: 750, remainingMs: 250, resumed: false});
    });

    it('等到已保存完成数追上实际 UI 才捕获；五秒内仍滞后则保存失败且拒绝继续', async () => {
        const settings = resumeSettings(), {ports, captured} = resumePort(), guard = createTranslationResumeGuard({limit: 1, started: Date.now(), timeout: 10000, settings});
        ports.readSnapshot.mockResolvedValueOnce(resumeSnapshot(1)).mockResolvedValueOnce(resumeSnapshot(2));
        const completion = guard.tryResume(timeoutStatus(2), ports);
        await vi.advanceTimersByTimeAsync(100); expect(await completion).toBe(true);
        expect(captured[0]?.failure.completed).toBe(2); expect(ports.readSnapshot).toHaveBeenCalledTimes(2);
        const stale = resumePort(), other = createTranslationResumeGuard({limit: 1, started: Date.now(), timeout: 10000, settings});
        const rejected = expect(other.tryResume(timeoutStatus(2), stale.ports)).rejects.toThrow('visible completed count');
        await vi.advanceTimersByTimeAsync(5000); await rejected;
        expect(stale.captured[0]?.failure.completed).toBe(1); expect(stale.ports.activateContinue).not.toHaveBeenCalled();
    });

    it('文档、词库/条数、语言、合批或文件 SHA 发生变化会保留原失败证据并拒绝继续', async () => {
        const initial = resumeSettings();
        for (const next of [{...initial, from: 'auto'}, {...initial, documentBatchTranslation: false}, {...initial, inputSha256: 'changed'},
            {...initial, glossary: {...initial.glossary, glossaryEnabled: false}}, {...initial, glossary: {...initial.glossary,
                libraries: initial.glossary.libraries.map(library => ({...library, termCount: 66}))}}]) {
            const {ports, captured} = resumePort(resumeSnapshot(), next), guard = createTranslationResumeGuard({limit: 1, started: Date.now(), timeout: 10000, settings: initial});
            await expect(guard.tryResume(timeoutStatus(), ports)).rejects.toThrow('settings/input/library changed');
            expect(captured).toHaveLength(1); expect(ports.activateContinue).not.toHaveBeenCalled();
        }
        const wrong = resumePort({...resumeSnapshot(), name: 'other.pdf'}), guard = createTranslationResumeGuard({limit: 1, started: Date.now(), timeout: 10000, settings: initial});
        await expect(guard.tryResume(timeoutStatus(), wrong.ports)).rejects.toThrow('different input');
        expect(wrong.captured).toHaveLength(1); expect(wrong.ports.activateContinue).not.toHaveBeenCalled();
    });

    it('最终及下一次恢复逐位置保留已完成原始字符串，不能借归一化、重复 source 或改 ID 覆盖目标', async () => {
        const settings = resumeSettings(), {ports} = resumePort(), guard = createTranslationResumeGuard({limit: 2, started: Date.now(), timeout: 10000, settings});
        expect(await guard.tryResume(timeoutStatus(), ports)).toBe(true);
        expect(await guard.verifyFinal(resumeSnapshot(4), ports.readSettings)).toMatchObject({completedTargetsPreserved: true, recoveredAfterFailures: true, resumeCount: 1, initialCompletedCount: 1});
        const changed = resumeSnapshot(4); changed.segments[0]!.translation = '已完成 0 ';
        await expect(guard.verifyFinal(changed, ports.readSettings)).rejects.toThrow('changed completed translation 0');
        ports.readSnapshot.mockResolvedValueOnce(changed);
        await expect(guard.tryResume(timeoutStatus(3), ports)).rejects.toThrow('changed completed translation 0');
        expect(ports.activateContinue).toHaveBeenCalledOnce();
        const previous = resumeSnapshot(2); previous.segments[1]!.source = previous.segments[0]!.source;
        const swapped = structuredClone(previous); swapped.segments.reverse();
        expect(() => assertPreservedTranslations([previous], swapped)).toThrow('index/id');
        const newSource = structuredClone(previous); newSource.segments[0]!.source += ' ';
        expect(() => assertPreservedTranslations([previous], newSource)).toThrow('source text');
        expect(() => assertPreservedTranslations([previous], {...previous, pages: [{pageNumber: 2}]})).toThrow('pages');
    });

    it.each(['重试', '继续翻译'])('实际 %s 主按钮必须同工具栏且唯一/可见/启用，禁止重新翻译并保留焦点守卫', async action => {
        const button = {count: vi.fn(async () => 1), isVisible: vi.fn(async () => true), isEnabled: vi.fn(async () => true),
            innerText: vi.fn(async () => action), click: vi.fn(async () => {})};
        const primaryClass = {};
        const page = {locator: vi.fn((selector: string) => {
            if (selector === '.translate-document-button') return primaryClass;
            expect(selector).toBe('.taskbar-actions'); return {getByRole: (role: string, options: {name: RegExp; exact: boolean}) => {
                expect(role).toBe('button'); expect(options.exact).toBe(true); expect(options.name.test(action)).toBe(true);
                for (const excluded of ['重新翻译', '按新设置翻译', '开始翻译', '重试所有文档']) expect(options.name.test(excluded)).toBe(false);
                return {and: (locator: unknown) => {expect(locator).toBe(primaryClass); return button;}};
            }};
        })}, checkFocus = vi.fn(async (_phase: string) => {});
        const options = {page, checkFocus, number: 1, deadline: Date.now() + 1000, readStatus: async () => timeoutStatus()};
        expect(await activateProductionTranslationContinue(options)).toBe(action);
        expect(checkFocus).toHaveBeenCalledWith('translation-continue-1'); expect(button.click).toHaveBeenCalledWith({timeout: 1000});
        button.click.mockClear(); button.isEnabled.mockResolvedValueOnce(false);
        await expect(activateProductionTranslationContinue(options)).rejects.toThrow('visible and enabled'); expect(button.click).not.toHaveBeenCalled();
        button.count.mockResolvedValueOnce(0);
        await expect(activateProductionTranslationContinue(options)).rejects.toThrow('unique');
        button.count.mockResolvedValueOnce(2);
        await expect(activateProductionTranslationContinue(options)).rejects.toThrow('unique');
        button.isVisible.mockResolvedValueOnce(false);
        await expect(activateProductionTranslationContinue(options)).rejects.toThrow('visible and enabled');
        button.innerText.mockResolvedValueOnce('重新翻译');
        await expect(activateProductionTranslationContinue(options)).rejects.toThrow('Only production retry or continue');
        await expect(activateProductionTranslationContinue({...options, deadline: Date.now()})).rejects.toThrow('deadline exhausted');
        await expect(activateProductionTranslationContinue({...options, readStatus: async () => ({...timeoutStatus(), translating: true})})).rejects.toThrow('terminal timeout');
        await expect(activateProductionTranslationContinue({...options, readStatus: async () => ({...timeoutStatus(), status: '已暂停'})})).rejects.toThrow('terminal timeout');
        await expect(activateProductionTranslationContinue({...options, checkFocus: async () => {throw new Error('Owned Edge activation');}})).rejects.toThrow('Owned Edge activation');
        expect(button.click).not.toHaveBeenCalled();
    });

    it('恢复端口抛错仍保留原产品失败并由原 finally 关闭浏览器和原生监控，严格失败不变', async () => {
        const {ports, captured} = resumePort(), guard = createTranslationResumeGuard({limit: 1, started: Date.now(), timeout: 10000, settings: resumeSettings()});
        ports.activateContinue.mockRejectedValueOnce(new Error('Owned Edge activation'));
        const close = vi.fn(async () => {}), stop = vi.fn(async () => {}), directory = profile();
        const report: CleanupReport = {ok: false, focusFailure: 'Owned Edge activation', cleanupErrors: []};
        try {await expect(guard.tryResume(timeoutStatus(), ports)).rejects.toThrow('Owned Edge activation');}
        finally {await closeLiveSession({launched: {close}, focusMonitor: {stop}, profileDir: directory, launchAttempted: true, report});}
        expect(captured[0]?.failure.error).toBe(timeoutStatus().error); expect(guard.recoveries).toEqual([]);
        expect(close).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce(); expect(report.ok).toBe(false); expect(report.focusFailure).toBe('Owned Edge activation');
    });
});

describe('source page labels with visible translation continuations', () => {
    const {mapPdfLayoutPages} = createRequire(import.meta.url)('../scripts/testing/pdf-output-pages.cjs');
    const labelled = (...labels: string[]) => labels.map(label => ({label}));
    it('maps each source page and only its immediately following numbered continuations', () => {
        const result = mapPdfLayoutPages(2, labelled('1', '1 · 译文续页 1', '1 · 译文续页 2', '2', '2 · 译文续页 1'));
        expect(result.ok).toBe(true); expect(result.indices).toEqual([0, 3]); expect(result.continuations).toHaveLength(3);
        expect(mapPdfLayoutPages(2, [{}, {}]).ok).toBe(true);
    });
    it.each([
        ['1', '1 · 译文续页 2', '2'], ['1', '2', '1 · 译文续页 1'], ['1', '1', '2'], ['2', '1'],
        ['1', '1 · 译文续页 1'], ['1', '2', '3'], ['1', '2', '2 · 译文续页 1', '2 · 译文续页 1'],
    ])('rejects missing, repeated or misordered page labels: %j', (...labels) => {
        expect(mapPdfLayoutPages(2, labelled(...labels)).ok).toBe(false);
    });
    it('rejects unlabelled output with an extra or missing page', () => {
        expect(mapPdfLayoutPages(2, [{}, {}, {}]).ok).toBe(false);
        expect(mapPdfLayoutPages(2, [{}]).ok).toBe(false);
    });
    it('requires source text and every repeated web link to survive on the original side', () => {
        const url = 'https://example.org/papers/linked-material';
        const text = 'Unique source paragraph long enough to serve as a page-order anchor.';
        const links = [{url, right: 170}, {url, right: 240}];
        const source = [{width: 600, height: 800, text, webLinks: links}];
        const primary = {...source[0], label: '1', width: 1215, originalText: text};
        expect(validatePdf(source, [primary]).ok).toBe(true);
        expect(validatePdf(source, [{...primary, originalText: '', webLinks: [links[0], {url, right: 910}]}]))
            .toMatchObject({ok: false, pages: [{sourceOrderOk: false, missingWebLinks: 1}]});
    });
    it('checks actual translated-side text and joins a passage split across consecutive continuation pages', () => {
        const snapshot = {pages: [{pageNumber: 1, segmentIndexes: [0, 1]}, {pageNumber: 2, segmentIndexes: [2]}],
            segments: [{id: 0, source: 'Title', translation: '可复制标题'}, {id: 1, source: 'Long', translation: '完整长段与末尾'},
                {id: 2, source: '(a) 8-GPU', translation: '（a） 8-GPU'}]};
        const first = {label: '1', translatedText: '标题', text: '左侧恰巧包含可复制标题', notes: ['完整长段与末尾']};
        const output = [first, {label: '1 · 译文续页 1', continuationText: '完整长段'},
            {label: '1 · 译文续页 2', continuationText: '与末尾'}, {label: '2', notes: ['（a） 8-GPU']},
            {label: '2 · 译文续页 1', continuationText: '（a） 8-GPU'}];
        expect(validateLayoutCopyText(snapshot, output)).toMatchObject({ok: false, checkedSegments: 3, checkedNotes: 2,
            missingSegments: [{pageNumber: 1, id: 0}], missingContinuationText: [], formatOnlyNotes: [{pageNumber: 2}]});
        expect(validateLayoutCopyText(snapshot, [{...first, translatedText: '可复制标题'}, ...output.slice(1)]).ok).toBe(true);
        expect(validateLayoutCopyText(snapshot, [first, {...output[1], continuationText: '完整…'}, ...output.slice(2)]))
            .toMatchObject({ok: false, missingContinuationText: [{pageNumber: 1}]});
    });
});
