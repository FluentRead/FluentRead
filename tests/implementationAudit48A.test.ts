/**
 * @file tests/implementationAudit48A.test.ts
 * 文件职责：通过 A 组生产公共入口验证消息归属、配置水合、持久化闹钟及取消历史。
 * 主要内容：以受控浏览器/存储端口重现后台异步边界，并可在私有 baseline 模块上执行同一用例。
 * 模块边界：不启动浏览器、不使用账号；不复制生产业务逻辑或访问私有 helper。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';

const state = vi.hoisted(() => ({
    ready: Promise.resolve() as Promise<void>,
    config: {requestHeaderRules: [] as Array<{domain: string; removeOrigin: boolean; removeReferer: boolean}>, disabledExtensionDomains: [] as string[]},
    subscribe: vi.fn(),
    currentFrame: 0,
    frameTranslations: new Map<number, boolean>(),
    frameActions: [] as Array<{frameId: number; action: string}>,
}));
vi.mock('@/src/services/config/store', () => ({
    config: state.config, get configReady() {return state.ready;}, subscribeConfig: state.subscribe,
}));
vi.mock('@/src/app/content/features', () => ({
    autoTranslateEnglishPage: () => {state.frameActions.push({frameId: state.currentFrame, action: 'fullPage'}); state.frameTranslations.set(state.currentFrame, true);},
    restoreOriginalContent: () => {state.frameActions.push({frameId: state.currentFrame, action: 'restore'}); state.frameTranslations.set(state.currentFrame, false);},
    isFullPageTranslationActive: () => state.frameTranslations.get(state.currentFrame) === true,
    getTranslationToolbarStatus: () => 'idle',
}));
import {runContextMenuAction} from '@/src/app/background/contextMenuActions';
import {CONFIG_AUTO_BACKUP_ALARM, CONFIG_AUTO_BACKUP_INTERVAL_MINUTES, installConfigAutoBackupRuntime} from '@/src/app/background/configAutoBackupRuntime';
import {createConfigMutationCoordinator, createConfigPersistenceHandler} from '@/src/app/background/handlers/configPersistence';
import {createTranslationCancelHandler, createTranslationRequestFallback, createTranslationRequestRegistry} from '@/src/app/background/handlers/translation';
import {installRequestHeaderRuntime} from '@/src/app/background/requestHeaderRuntime';
import {runtimeFetch, setRuntimeFetch} from '@/src/platform/http/runtime';
import {installConfigStorageBroadcast} from '@/src/app/background/configStorageBroadcast';
import type {ConfigStoragePort} from '@/src/platform/storage/configStorage';
import {createBaselineConfigAutoBackups} from '@/src/services/config/autoBackup';
import {createBackgroundMessageRouter} from '@/src/app/background/messageRouter';
import {createContentRuntimeMessageHandler} from '@/src/app/content/messageRuntime';
import {createTabTranslationStateReader} from '@/src/app/background/tabTranslationQuery';
import {TabTranslationStateStore} from '@/src/app/background/tabTranslationState';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(release => {resolve = release;});
    return {promise, resolve};
}
async function flush() {for (let i = 0; i < 30; i++) await Promise.resolve();}
beforeEach(() => {state.ready = Promise.resolve(); state.subscribe.mockReset(); state.config.requestHeaderRules = [];});
afterEach(() => {setRuntimeFetch(); vi.unstubAllGlobals(); vi.restoreAllMocks();});

describe('audit48 A controlled public boundaries', () => {
    it.each([false, true])('full-page frame delivery keeps child state untouched (translated=%s)', async translated => {
        state.frameTranslations = new Map([[0, translated], [2, false]]); state.frameActions = [];
        const frames = state.frameTranslations;
        const deliveries: number[] = [];
        const responses: Array<{frameId: number; response: unknown}> = [];
        const receiver = createContentRuntimeMessageHandler({} as never, {isSiteDisabled: () => false, updateSiteDisabled: async () => undefined});
        const sendMessage = vi.fn(async (_tab: number, message: {action: string}, options?: {frameId: number}) => {
            const recipients = options ? [options.frameId] : [...frames.keys()];
            for (const id of recipients) {
                deliveries.push(id); state.currentFrame = id;
                expect(receiver(message, {id: 'controlled-extension'}, response => {responses.push({frameId: id, response});})).toBe(true);
            }
            // A child may answer first when the browser broadcasts to every frame.
            return responses.at(-1)?.response;
        });
        vi.stubGlobal('browser', {tabs: {sendMessage}});
        const result = await runContextMenuAction('translatePage', 4, {frameId: 2}, {id: 4}, translated);
        if (process.env.AUDIT48_FRAME_PROOF) writeFileSync(`${process.env.AUDIT48_FRAME_PROOF}.${translated ? 'restore' : 'translate'}.json`, JSON.stringify({entry: 'runContextMenuAction', consumer: 'createContentRuntimeMessageHandler', clickedFrame: 2, translatedBefore: translated, transportCalls: sendMessage.mock.calls, deliveries, featureActions: state.frameActions, responses, finalFrames: [...frames], result}, null, 2));
        expect(result).toEqual({handled: true, isTranslated: !translated});
        expect(deliveries).toEqual([0]);
        expect(frames.get(2)).toBe(false);
        expect(state.frameActions).toEqual([{frameId: 0, action: translated ? 'restore' : 'fullPage'}]);
    });

    it('full-page actions preserve missing-response failure and legacy inferred state', async () => {
        const sendMessage = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue({status: 'success'});
        vi.stubGlobal('browser', {tabs: {sendMessage}});
        await expect(runContextMenuAction('translatePage', 4, {}, {id: 4}, false)).resolves.toEqual({handled: false});
        await expect(runContextMenuAction('translatePage', 4, {}, {id: 4}, true)).resolves.toEqual({handled: true, isTranslated: false});
        expect(sendMessage.mock.calls.at(-1)?.[1]).toEqual({type: 'contextMenuTranslate', action: 'restore'});
    });

    it('the real tab reader caches top-frame truth when a child replies first, then forces fresh top-frame state', async () => {
        state.frameTranslations = new Map([[0, true], [2, false]]);
        const receiver = createContentRuntimeMessageHandler({} as never, {isSiteDisabled: () => false, updateSiteDisabled: async () => undefined});
        const deliveries: number[][] = [], responses: unknown[] = [];
        const sendMessage = vi.fn(async (_tab: number, message: unknown, options?: {frameId: number}) => {
            const recipients = options ? [options.frameId] : [2, 0]; deliveries.push(recipients);
            const replies: unknown[] = [];
            for (const id of recipients) {state.currentFrame = id; expect(receiver(message, {}, reply => {replies.push(reply);})).toBe(true);}
            responses.push(replies);
            return replies[0];
        });
        vi.stubGlobal('browser', {tabs: {sendMessage}});
        const store = new TabTranslationStateStore(), read = createTabTranslationStateReader(store);
        const first = await read(12), cached = await read(12), callsAfterCached = sendMessage.mock.calls.length;
        state.frameTranslations.set(0, false); state.frameTranslations.set(2, true);
        const forced = await read(12, true), finalState = store.get(12);
        if (process.env.AUDIT48_FRAME_PROOF) writeFileSync(`${process.env.AUDIT48_FRAME_PROOF}.state-reader.json`, JSON.stringify({entry: 'createTabTranslationStateReader', consumer: 'createContentRuntimeMessageHandler', store: 'TabTranslationStateStore', transportCalls: sendMessage.mock.calls, deliveries, responses, first, cached, callsAfterCached, forced, finalState}, null, 2));
        expect(first).toEqual({toolbarStatus: 'idle', isTranslated: true, isSiteDisabled: false});
        expect(cached).toEqual(first); expect(callsAfterCached).toBe(1);
        expect(forced).toEqual({toolbarStatus: 'idle', isTranslated: false, isSiteDisabled: false});
        expect(finalState).toEqual(forced); expect(store.hasCompleteState(12)).toBe(true);
        expect(deliveries).toEqual([[0], [0]]);
        expect(sendMessage).toHaveBeenCalledTimes(2);
        expect(sendMessage).toHaveBeenLastCalledWith(12, {type: 'getFullPageTranslationState'}, {frameId: 0});
    });

    it('failed startup capture still installs an alarm that retries successfully', async () => {
        const now = Date.parse('2026-10-06T12:00:00Z');
        let snapshot = createBaselineConfigAutoBackups({on: true}, '2026-10-01T00:00:00Z');
        let fire!: (alarm: {name: string}) => void;
        const capture = vi.fn().mockRejectedValueOnce(new Error('controlled storage failure')).mockImplementation(async ({savedAt}) => {
            snapshot = createBaselineConfigAutoBackups({on: true}, savedAt); return snapshot;
        });
        const create = vi.fn(async () => undefined), warn = vi.fn();
        const installed = installConfigAutoBackupRuntime({
            ready: Promise.resolve(), getSnapshot: () => snapshot, capture, now: () => now, warn,
            alarms: {onAlarm: {addListener: callback => {fire = callback;}}, get: async () => undefined, create},
        });
        await installed.ready;
        expect(create).toHaveBeenCalledWith(CONFIG_AUTO_BACKUP_ALARM, {delayInMinutes: 1, periodInMinutes: CONFIG_AUTO_BACKUP_INTERVAL_MINUTES});
        expect(warn).toHaveBeenCalledWith('[FluentRead] 自动配置备份执行失败', expect.objectContaining({message: 'controlled storage failure'}));
        fire({name: CONFIG_AUTO_BACKUP_ALARM});
        await flush();
        expect(capture).toHaveBeenCalledTimes(2);
        expect(snapshot.entries.at(-1)?.savedAt).toBe(new Date(now).toISOString());
    });

    it.each(['empty', 'invalid', 'future'])('alarm lookup tolerates an externally changed backup snapshot: %s', async kind => {
        const now = Date.parse('2026-10-06T12:00:00Z');
        let snapshot = createBaselineConfigAutoBackups({on: true}, new Date(now).toISOString());
        const create = vi.fn(async () => undefined), warn = vi.fn();
        await installConfigAutoBackupRuntime({
            ready: Promise.resolve(), getSnapshot: () => snapshot, capture: vi.fn(), now: () => now, warn,
            alarms: {onAlarm: {addListener: vi.fn()}, create, get: async () => {
                snapshot = kind === 'empty' ? {...snapshot, entries: []} : createBaselineConfigAutoBackups({on: true}, kind === 'invalid' ? 'invalid-date' : '2026-10-07T12:00:00Z');
                return undefined;
            }},
        }).ready;
        expect(create).toHaveBeenCalledWith(CONFIG_AUTO_BACKUP_ALARM, {delayInMinutes: 1, periodInMinutes: CONFIG_AUTO_BACKUP_INTERVAL_MINUTES});
        expect(warn).not.toHaveBeenCalled();
    });

    it('hydration supersedes an old replace before revision checking and storage writes', async () => {
        const gate = deferred<void>();
        let readyEntered = false, current = {marker: 'baseline'}, revision = 0;
        const ready = {then(resolve: () => void, reject: (e: unknown) => void) {readyEntered = true; return gate.promise.then(resolve, reject);}} as Promise<void>;
        const save = vi.fn(async (next: typeof current) => {current = next; revision++;});
        const handler = createConfigPersistenceHandler({
            ready, getCurrentConfig: () => current, getCurrentRevision: () => revision,
            prepareConfigSaveRequest: incoming => ({marker: String(incoming.marker)}), prepareConfigPatchRequest: vi.fn(),
            saveConfig: save, isExtensionUrl: () => false,
        });
        const router = createBackgroundMessageRouter([handler]);
        const first = router.dispatch({type: 'persistConfig', config: {marker: 'stale'}, clientId: 'hydrating', sequence: 1, baseRevision: 0}, {});
        // Attach rejection handling before releasing the hydration gate.
        const firstResult = first.then(value => ({value}), error => ({error: String(error)}));
        await flush(); expect(readyEntered).toBe(true);
        const latest = router.dispatch({type: 'persistConfig', config: {marker: 'latest'}, clientId: 'hydrating', sequence: 2, baseRevision: 7}, {});
        revision = 7; gate.resolve();
        expect(await firstResult).toEqual({value: {handled: true, response: {success: true, revision: 7}}});
        await expect(latest).resolves.toEqual({handled: true, response: {success: true, revision: 8}});
        expect(save).toHaveBeenCalledOnce(); expect(current).toEqual({marker: 'latest'});
    });

    it('bounded hydration burst retains final output with only the latest write', async () => {
        const gate = deferred<void>(); let current = {marker: 'baseline'};
        const save = vi.fn(async (value: typeof current) => {current = value;});
        const prepare = vi.fn((incoming: Record<string, unknown>) => ({marker: String(incoming.marker)}));
        const handler = createConfigPersistenceHandler({ready: gate.promise, getCurrentConfig: () => current,
            prepareConfigSaveRequest: prepare, prepareConfigPatchRequest: vi.fn(), saveConfig: save, isExtensionUrl: () => false});
        const started = performance.now();
        const pending = [handler.handle({type: 'persistConfig', clientId: 'burst', sequence: 1, config: {marker: '1'}}, {})];
        await flush();
        for (let n = 2; n <= 128; n++) pending.push(handler.handle({type: 'persistConfig', clientId: 'burst', sequence: n, config: {marker: String(n)}}, {}));
        gate.resolve(); await Promise.all(pending);
        const sample = {inputCount: 128, output: current, outputSha256: createHash('sha256').update(JSON.stringify(current)).digest('hex'), prepareCalls: prepare.mock.calls.length, storageCalls: save.mock.calls.length, elapsedMs: performance.now() - started};
        if (process.env.AUDIT48_PERFORMANCE_OUTPUT) writeFileSync(process.env.AUDIT48_PERFORMANCE_OUTPUT, JSON.stringify(sample, null, 2));
        expect(current).toEqual({marker: '128'}); expect(save).toHaveBeenCalledOnce(); expect(prepare).toHaveBeenCalledOnce();
    });

    it('a recycled cancelled ID keeps its new cancellation for the full distinct-ID capacity', async () => {
        const registry = createTranslationRequestRegistry();
        const translate = vi.fn(async () => 'translated');
        const router = createBackgroundMessageRouter([createTranslationCancelHandler(registry)], createTranslationRequestFallback({translate, serializeError: e => ({error: (e as Error).name}), requestRegistry: registry}));
        const context = {sender: {id: 'extension', tab: {id: 8}, frameId: 0, documentId: 'controlled'}};
        const cancel = (clientRequestId: string) => router.dispatch({type: 'fluentReadTranslationCancel', clientRequestId}, context);
        const run = (clientRequestId: string) => router.dispatch({origin: 'hello', clientRequestId}, context);
        await cancel('recycled'); await expect(run('recycled')).resolves.toEqual({handled: true, response: {error: 'AbortError'}});
        for (let n = 0; n < 512; n++) await run(`completed-${n}`);
        await cancel('recycled');
        for (let n = 0; n < 511; n++) await cancel(`waiting-${n}`);
        translate.mockClear();
        await expect(run('recycled')).resolves.toEqual({handled: true, response: {error: 'AbortError'}});
        expect(translate).not.toHaveBeenCalled();
    });

    it('consumed cancel records do not evict an earlier outstanding cancellation', async () => {
        const registry = createTranslationRequestRegistry(), context = {sender: {tab: {id: 2}, frameId: 0}};
        const translate = vi.fn(async () => 'translated');
        const fallback = createTranslationRequestFallback<typeof context>({translate, serializeError: e => (e as Error).name, requestRegistry: registry});
        registry.cancel('still-pending', context);
        for (let n = 0; n < 512; n++) {
            registry.cancel(`consumed-${n}`, context);
            await expect(fallback.handle({origin: 'hello', clientRequestId: `consumed-${n}`}, context)).resolves.toBe('AbortError');
        }
        await expect(fallback.handle({origin: 'hello', clientRequestId: 'still-pending'}, context)).resolves.toBe('AbortError');
        expect(translate).not.toHaveBeenCalled();
    });

    it('startup removes persisted obsolete request-header rules without an HTTP request', async () => {
        const gate = deferred<void>(); state.ready = gate.promise;
        const api = {getDynamicRules: vi.fn(async () => [{id: 2_763_000}, {id: 42}]), updateDynamicRules: vi.fn(async () => undefined)};
        const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
        vi.stubGlobal('browser', {runtime: {getURL: () => 'chrome-extension://controlled/'}, declarativeNetRequest: api});
        installRequestHeaderRuntime(); await flush(); expect(api.getDynamicRules).not.toHaveBeenCalled();
        gate.resolve(); await flush();
        expect(api.updateDynamicRules).toHaveBeenCalledWith({removeRuleIds: [2_763_000], addRules: [{
            id: 2_763_000, priority: 2,
            action: {type: 'modifyHeaders', requestHeaders: [{header: 'Origin', operation: 'remove'}]},
            condition: {regexFilter: '^https?://index-translate\\.bilibili\\.com(?::[0-9]+)?/', initiatorDomains: ['controlled'], resourceTypes: ['xmlhttprequest']},
        }]});
        expect(fetch).not.toHaveBeenCalled();
    });

    it('startup applies hydrated rules and a failed install is retryable at the HTTP boundary', async () => {
        const gate = deferred<void>(); state.ready = gate.promise;
        const api = {getDynamicRules: vi.fn(async () => []), updateDynamicRules: vi.fn().mockRejectedValueOnce(new Error('fixture install failed')).mockResolvedValue(undefined)};
        const fetch = vi.fn(async () => new Response('controlled')); vi.stubGlobal('fetch', fetch);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.stubGlobal('browser', {runtime: {getURL: () => 'moz-extension://controlled/'}, declarativeNetRequest: api});
        installRequestHeaderRuntime();
        state.config.requestHeaderRules = [{domain: 'controlled.example', removeOrigin: true, removeReferer: false}];
        gate.resolve(); await flush();
        expect(warn).toHaveBeenCalledWith('[FluentRead] 请求头规则更新失败；下次请求将重试。');
        expect(fetch).not.toHaveBeenCalled();
        await expect(runtimeFetch('https://controlled.example/')).resolves.toHaveProperty('status', 200);
        expect(api.updateDynamicRules).toHaveBeenCalledTimes(2); expect(fetch).toHaveBeenCalledOnce();
        expect(api.updateDynamicRules.mock.calls[1][0].addRules[0].condition.initiatorDomains).toEqual(['controlled']);
    });

    it('disposing config broadcast prevents pending tab queries and retained watch callbacks from sending', async () => {
        const callbacks = new Map<string, () => void>();
        const unsubscribe = vi.fn();
        const storage: ConfigStoragePort = {getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), watch: vi.fn((key, callback) => {callbacks.set(key, () => callback(null)); return unsubscribe;})};
        const tabs = deferred<Array<{id: number}>>();
        const sendRuntimeMessage = vi.fn(async () => undefined), sendTabMessage = vi.fn(), queryTabs = vi.fn(() => tabs.promise);
        const dispose = installConfigStorageBroadcast(storage, {sendRuntimeMessage, sendTabMessage, queryTabs, warn: vi.fn()});
        callbacks.get('local:config')!();
        expect(queryTabs).toHaveBeenCalledOnce();
        dispose(); dispose(); tabs.resolve([{id: 8}]); await flush();
        callbacks.get('local:config')!(); await flush();
        expect(sendTabMessage).not.toHaveBeenCalled(); expect(sendRuntimeMessage).toHaveBeenCalledOnce();
        expect(unsubscribe).toHaveBeenCalledTimes(callbacks.size);
    });

    it('shared mutation coordinator recovers a rejected mutation before the next save', async () => {
        const coordinator = createConfigMutationCoordinator(), order: string[] = [];
        const first = coordinator.run(async () => {order.push('first'); throw new Error('controlled rejection');});
        const second = coordinator.run(async () => {order.push('second'); return 7;});
        await expect(first).rejects.toThrow('controlled rejection'); await expect(second).resolves.toBe(7);
        expect(order).toEqual(['first', 'second']);
    });

    it('broadcast dispose attempts every owned unsubscribe, exposes failures and retries only failed handles', () => {
        const callbacks = new Map<string, () => void>(), owned = new Set<string>();
        const handles: Array<ReturnType<typeof vi.fn>> = [];
        const failure = new Error('first controlled unsubscribe failed');
        const storage: ConfigStoragePort = {getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), watch: vi.fn((key, callback) => {
            owned.add(key); callbacks.set(key, () => callback(null));
            const handle = vi.fn(() => {owned.delete(key);});
            if (handles.length === 0) handle.mockImplementationOnce(() => {throw failure;});
            handles.push(handle); return handle;
        })};
        const sendRuntimeMessage = vi.fn(async () => undefined);
        const dispose = installConfigStorageBroadcast(storage, {sendRuntimeMessage, queryTabs: vi.fn(async () => []), sendTabMessage: vi.fn(), warn: vi.fn()});
        let caught: unknown; try {dispose();} catch (error) {caught = error;}
        expect(caught).toBeInstanceOf(AggregateError);
        expect((caught as AggregateError).errors).toEqual([failure]);
        expect(handles.every(handle => handle.mock.calls.length === 1)).toBe(true);
        expect(owned.size).toBe(1);
        for (const callback of callbacks.values()) callback();
        expect(sendRuntimeMessage).not.toHaveBeenCalled();
        dispose(); dispose();
        expect(owned.size).toBe(0); expect(handles[0]).toHaveBeenCalledTimes(2);
        expect(handles.slice(1).every(handle => handle.mock.calls.length === 1)).toBe(true);
    });

    it.each([false, true])('a later watch failure rolls back all earlier subscriptions and retains cleanup errors (%s)', cleanupFails => {
        const registrationFailure = new Error('fourth controlled watch failed'), cleanupFailure = new Error('controlled rollback failed');
        const owned = new Set<string>(), callbacks: Array<() => void> = [], handles: Array<ReturnType<typeof vi.fn>> = [];
        const storage: ConfigStoragePort = {getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), watch: vi.fn((key, callback) => {
            if (handles.length === 3) throw registrationFailure;
            owned.add(key); callbacks.push(() => callback(null));
            const handle = vi.fn(() => {owned.delete(key);});
            if (cleanupFails && handles.length === 0) handle.mockImplementation(() => {throw cleanupFailure;});
            handles.push(handle); return handle;
        })};
        const sendRuntimeMessage = vi.fn(async () => undefined);
        let caught: unknown;
        try {installConfigStorageBroadcast(storage, {sendRuntimeMessage, queryTabs: vi.fn(async () => []), sendTabMessage: vi.fn(), warn: vi.fn()});} catch (error) {caught = error;}
        expect(handles.every(handle => handle.mock.calls.length === 1)).toBe(true);
        expect(owned.size).toBe(cleanupFails ? 1 : 0);
        if (cleanupFails) {
            expect(caught).toBeInstanceOf(AggregateError);
            expect((caught as AggregateError).errors[0]).toBe(registrationFailure);
            expect((caught as AggregateError).errors[1]).toBeInstanceOf(AggregateError);
            expect(((caught as AggregateError).errors[1] as AggregateError).errors).toEqual([cleanupFailure]);
        } else expect(caught).toBe(registrationFailure);
        for (const callback of callbacks) callback();
        expect(sendRuntimeMessage).not.toHaveBeenCalled();
    });
});
