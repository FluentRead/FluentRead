/**
 * @file tests/implementationAudit48I.test.ts
 * 文件职责：通过配置公共 store、授权读取 handler、真实远程端口和客户端阅读模板验证第 48 批 I 的缓存归属与有界初始化。
 * 主要内容：受控存储 watch、无值后台事件、真实 ReadingPanel 动作缓存与 runtime stream 端口，检验凭据变化、无关更新、迟到回复和退出清理。
 * 模块边界：不访问私有 setup，不复制缓存逻辑，不连接账号或外网，所有凭据只为运行时生成的合成值。
 */
import {parseHTML} from 'linkedom';
import {createRenderer, markRaw, nextTick, type App} from 'vue';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {extractConfigCredentials, sanitizeConfigCredentials} from '@/src/core/config/credentials';
import {createRemoteConfigStorage, type ConfigStoragePort} from '@/src/platform/storage/configStorage';
import {createConfigStorageReadHandler} from '@/src/app/background/handlers/configStorage';

const ports = vi.hoisted(() => ({storage: null as ConfigStoragePort | null,
    messages: new Set<(message: unknown) => unknown>(), send: vi.fn(), connect: vi.fn(), translate: vi.fn()}));
vi.mock('@/src/platform/storage/configStorageRuntime', () => ({configStorage: new Proxy({}, {get(_target, key) {
    const value = ports.storage![key as keyof ConfigStoragePort];
    return typeof value === 'function' ? value.bind(ports.storage) : value;
}})}));
vi.mock('webextension-polyfill', () => ({default: {extension: {inIncognitoContext: false}, runtime: {
    getURL: (path: string) => path, sendMessage: ports.send, connect: ports.connect,
    onMessage: {addListener: (fn: (message: unknown) => unknown) => ports.messages.add(fn),
        removeListener: (fn: (message: unknown) => unknown) => ports.messages.delete(fn)},
}}}));
vi.mock('@/src/services/translation/client', () => ({translateText: ports.translate, translateTextBatch: ports.translate}));
vi.mock('@/src/features/share-card/public', () => ({isShareCardMounted: () => false, openShareCard: vi.fn()}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({t: (key: string) => key, translateLegacy: (text: string) => text})}));
// public 同时静态导出设置页历史视图；其外部确认弹窗/CSS 不参与本次阅读缓存链。
vi.mock('element-plus', () => ({ElMessageBox: {confirm: vi.fn()}}));
vi.mock('element-plus/es/components/message-box/style/css', () => ({}));

let app: App | undefined;
let disposeBroadcast: (() => void) | undefined;
const cleanups: Array<() => void> = [];
async function settle() {for (let i = 0; i < 16; i++) {await Promise.resolve(); await nextTick();}}
afterEach(async () => {
    app?.unmount(); app = undefined; disposeBroadcast?.(); disposeBroadcast = undefined;
    await settle(); cleanups.splice(0).forEach(fn => fn());
    ports.messages.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
function memoryPort(initial: Config, owner = false) {
    const records = new Map<string, unknown>([['local:config', {...sanitizeConfigCredentials(initial), __fluentConfigRevision: 10}],
        ['local:credentials', extractConfigCredentials(initial)]]);
    const watchers = new Map<string, Set<(value: unknown, previous?: unknown) => void>>();
    function emit(key: string, value: unknown) {
        const previous = records.get(key) ?? null; records.set(key, value);
        for (const fn of watchers.get(key) ?? []) fn(value, previous);
    }
    const port: ConfigStoragePort = {writeOwner: owner,
        async getItem<T>(key: string): Promise<T | null> {return (records.get(key) ?? null) as T | null;},
        setItem: vi.fn(async (key, value) => {emit(key, value);}), removeItem: vi.fn(async key => {emit(key, null);}),
        watch<T>(key: string, fn: (nextValue: T | null, previousValue?: T | null) => void) {
            const callback = (value: unknown, previous?: unknown) => fn(value as T | null, previous as T | null | undefined);
            const bucket = watchers.get(key) ?? new Set<(value: unknown, previous?: unknown) => void>();
            bucket.add(callback); watchers.set(key, bucket);
            return () => {bucket.delete(callback); if (!bucket.size) watchers.delete(key);};},
    };
    cleanups.push(() => watchers.clear());
    return {port, records, emit, watchers};
}
async function loadStore(port: ConfigStoragePort, trusted = false) {
    vi.resetModules(); ports.storage = port;
    vi.stubGlobal('location', {protocol: trusted ? 'chrome-extension:' : 'https:', href: 'https://controlled.example/page'});
    return import('@/src/services/config/store');
}

describe('audit48 I configReady bounded public initialization', () => {
    it.each([false, true])('finishes repeated public watch changes with the latest valid snapshot (trusted=%s)', async trusted => {
        const state = memoryPort(normalizeConfig({service: 'openai', from: 'en', to: 'ja'}));
        let reads = 0;
        vi.spyOn(state.port, 'getItem').mockImplementation(async (key: string) => {
            const old = state.records.get(key) ?? null;
            if (key === 'local:config' && ++reads <= 8) {
                state.emit(key, {...old as object, to: 'ko', count: reads, __fluentConfigRevision: 10 + reads});
            }
            return old;
        });
        const store = await loadStore(state.port, trusted); await store.configReady;
        expect(reads).toBeLessThanOrEqual(4);
        expect(store.config).toMatchObject({to: 'ko', count: reads});
        expect(store.getConfigRevision()).toBe(10 + reads);
        expect(state.port.setItem).not.toHaveBeenCalled();
    });
    it.each([false, true])('finishes continuous credential watch with latest credentials and no migration write (owner=%s)', async owner => {
        const initial = normalizeConfig({service: 'openai', from: 'en', to: 'ja'});
        const state = memoryPort(initial, owner); let reads = 0;
        vi.spyOn(state.port, 'getItem').mockImplementation(async (key: string) => {
            const old = state.records.get(key) ?? null;
            if (key === 'local:credentials' && ++reads <= 8) {
                state.emit(key, extractConfigCredentials({apiKeys: {openai: ['synthetic-' + reads]}}));
                state.emit('local:config', {...state.records.get('local:config') as object,
                    to: 'ko', count: reads, __fluentConfigRevision: 10 + reads});
            }
            return old;
        });
        const store = await loadStore(state.port, true); await store.configReady;
        expect(reads).toBeLessThanOrEqual(2);
        expect(store.config.apiKeys.openai?.[0] === 'synthetic-' + reads).toBe(true);
        expect(store.config).toMatchObject({to: 'ko', count: reads});
        expect(store.getConfigRevision()).toBe(10 + reads);
        expect(state.port.setItem).not.toHaveBeenCalled(); expect(state.port.removeItem).not.toHaveBeenCalled();
        if (owner) {
            const blockedExport = store.prepareHydratedConfigForExport();
            await expect(blockedExport).rejects.toThrow('配置或凭据安全水合未完成，无法导出完整备份；请重新加载扩展后重试');
            // 后续有效 watch 可继续刷新内存，不能据此声称迁移已完成或自动解除写入保护。
            state.emit('local:config', {...state.records.get('local:config') as object,
                to: 'fr', count: reads + 1, __fluentConfigRevision: 11 + reads});
            state.emit('local:credentials', extractConfigCredentials({apiKeys: {openai: ['synthetic-follow']}}));
            expect(store.config).toMatchObject({to: 'fr', count: reads + 1});
            expect(store.getConfigRevision()).toBe(11 + reads);
            expect(store.config.apiKeys.openai?.[0] === 'synthetic-follow').toBe(true);
            await expect(store.prepareHydratedConfigForExport()).rejects.toThrow('水合未完成');
            const blockedSave = store.saveConfig({...store.config, theme: 'dark'});
            await expect(blockedSave).rejects.toThrow('配置安全迁移未完成，暂不写入存储；请重新加载扩展后重试');
            await expect(store.saveConfig({...store.config, theme: 'light'})).rejects.toThrow('安全迁移未完成');
            expect(state.port.setItem).not.toHaveBeenCalled(); expect(state.port.removeItem).not.toHaveBeenCalled();
            console.info('AUDIT48I_SAFETY_FALLBACK', JSON.stringify({mode: 'background-owner',
                publicCount: store.config.count, publicTarget: store.config.to, publicRevision: store.getConfigRevision(),
                latestCredentialWatchMatches: store.config.apiKeys.openai?.[0] === 'synthetic-follow',
                exportError: await blockedExport.catch(error => error.message), saveError: await blockedSave.catch(error => error.message),
                writes: 0, removals: 0, validFollowupWatchDidNotUnlock: true}));
        } else expect((await store.prepareHydratedConfigForExport()).apiKeys).toEqual(store.config.apiKeys);
    });
    it('uses the latest valid watch after repeated credential read failure and rejects export/save', async () => {
        const state = memoryPort(normalizeConfig({service: 'openai', from: 'en', to: 'ja'})); let attempts = 0;
        vi.spyOn(state.port, 'getItem').mockImplementation(async (key: string) => {
            if (key === 'local:credentials') {
                if (++attempts <= 8) state.emit('local:config', {...state.records.get('local:config') as object,
                    to: 'ko', count: attempts, __fluentConfigRevision: 10 + attempts});
                throw new Error('controlled unavailable credentials');
            }
            return state.records.get(key) ?? null;
        });
        const store = await loadStore(state.port, true); await store.configReady;
        expect(attempts).toBe(2); expect(store.config).toMatchObject({to: 'ko', count: attempts});
        expect(store.getConfigRevision()).toBe(10 + attempts);
        const blockedExport = store.prepareHydratedConfigForExport();
        await expect(blockedExport).rejects.toThrow('水合未完成');
        const blockedSave = store.requestConfigPatch({theme: 'dark'});
        await expect(blockedSave).rejects.toThrow('水合未完成');
        expect(state.port.setItem).not.toHaveBeenCalled();
        console.info('AUDIT48I_SAFETY_FALLBACK', JSON.stringify({mode: 'credential-read-failure',
            publicCount: store.config.count, publicTarget: store.config.to, publicRevision: store.getConfigRevision(),
            exportError: await blockedExport.catch(error => error.message), saveError: await blockedSave.catch(error => error.message), writes: 0}));
    });
    it('ignores repeated invalid watch records without discarding a valid read snapshot', async () => {
        const initial = normalizeConfig({from: 'en', to: 'ja', count: 22});
        const state = memoryPort(initial); let reads = 0;
        vi.spyOn(state.port, 'getItem').mockImplementation(async (key: string) => {
            if (key === 'local:config' && ++reads <= 8) state.emit(key, {invalid: true});
            return key === 'local:config' ? {...sanitizeConfigCredentials(initial), __fluentConfigRevision: 10} : null;
        });
        const store = await loadStore(state.port); await store.configReady;
        expect(reads).toBeLessThanOrEqual(4); expect(store.config).toMatchObject({to: 'ja', count: 22});
    });
    it('keeps a higher valid watch revision even when the subsequent stable read is stale', async () => {
        const initial = normalizeConfig({from: 'en', to: 'ja', count: 22});
        const state = memoryPort(initial); const stale = state.records.get('local:config'); let reads = 0;
        vi.spyOn(state.port, 'getItem').mockImplementation(async () => {
            if (++reads === 1) state.emit('local:config', {...stale as object, to: 'ko', count: 23, __fluentConfigRevision: 11});
            return stale;
        });
        const store = await loadStore(state.port); await store.configReady;
        expect(store.config).toMatchObject({to: 'ko', count: 23}); expect(store.getConfigRevision()).toBe(11);
        expect(reads).toBe(2);
    });
    it('does not prefer an older valid watch over a newer read when invalid events continue', async () => {
        const initial = normalizeConfig({from: 'en', to: 'ja', count: 22});
        const state = memoryPort(initial); const stale = state.records.get('local:config'); let reads = 0;
        vi.spyOn(state.port, 'getItem').mockImplementation(async () => {
            if (++reads === 1) state.emit('local:config', stale);
            else if (reads <= 8) state.emit('local:config', {invalid: true});
            return {...stale as object, to: 'ko', count: 23, __fluentConfigRevision: 11};
        });
        const store = await loadStore(state.port); await store.configReady;
        expect(reads).toBeLessThanOrEqual(4); expect(store.config).toMatchObject({to: 'ko', count: 23});
        expect(store.getConfigRevision()).toBe(11);
    });
});

interface StreamCall {request: any; messages: Set<(message: unknown) => void>; disconnect: ReturnType<typeof vi.fn>;}
async function mountReading(service = 'openai') {
    vi.useFakeTimers();
    const initial = normalizeConfig({service, from: 'en', to: 'zh-Hans', theme: 'light', vocabularyBookEnabled: false,
        selectionTranslatorMode: 'bilingual', selectionTranslatorTrigger: 'contextMenu', selectionTranslatorDelay: 0,
        selectionTranslatorPresentation: 'card', harness: {...new Config().harness, enabled: true, contextMode: 'selection', service},
        customOpenAIProviders: service === 'openai' ? [] : [{id: service, name: 'Controlled', endpoint: 'https://controlled.invalid/v1', models: ['controlled-model']}],
        apiKeys: {[service]: ['synthetic-a', 'synthetic-pool']}, apiKeyRotationEnabled: {[service]: false},
        customHeaders: {[service]: JSON.stringify({'X-Test': 'synthetic-header'})}});
    const background = memoryPort(initial);
    const reads = createConfigStorageReadHandler({ready: Promise.resolve(), read: key => background.port.getItem(key), isExtensionUrl: url => url.startsWith('chrome-extension:')});
    ports.messages.clear(); ports.send.mockReset().mockImplementation(async message => {
        if (message.type === 'configStorageRead') return reads.handle(message, {sender: {url: 'https://controlled.example/page'}} as never);
        if (message.type === 'fluentReadSelectionPageZoom') return {success: true, zoom: 1};
        return {success: true};
    });
    const remote = createRemoteConfigStorage({sendMessage: ports.send, onMessage: {addListener: fn => {ports.messages.add(fn);}}});
    const store = await loadStore(remote); await store.configReady;
    const {installConfigStorageBroadcast} = await import('@/src/app/background/configStorageBroadcast');
    const tabMessages: unknown[] = [];
    const broadcastRuntime = {sendRuntimeMessage: vi.fn(async () => undefined), queryTabs: vi.fn(async () => [{id: 1}]),
        sendTabMessage: vi.fn(async (_id: number, message: unknown) => {tabMessages.push(message); for (const fn of ports.messages) fn(message);}), warn: vi.fn()};
    disposeBroadcast = installConfigStorageBroadcast(background.port, broadcastRuntime);
    const streams: StreamCall[] = [];
    ports.connect.mockReset().mockImplementation(() => {
        const messages = new Set<(message: unknown) => void>(), disconnects = new Set<() => void>();
        const stream: StreamCall = {request: undefined, messages, disconnect: vi.fn(() => {for (const fn of disconnects) fn();})};
        return {onMessage: {addListener: (fn: (message: unknown) => void) => messages.add(fn)},
            onDisconnect: {addListener: (fn: () => void) => disconnects.add(fn)}, disconnect: stream.disconnect,
            postMessage: (request: unknown) => {stream.request = request; streams.push(stream);}};
    });
    ports.translate.mockReset().mockResolvedValue('受控译文');
    const parsed = parseHTML('<html><body><p id="source">Practice helps.</p><div id="fluent-read-selection-translator-container"></div></body></html>');
    const doc = parsed.document as unknown as Document, win = parsed.window;
    // 防止 Vue 开发工具的外部等待计时器污染组件资源断言。
    vi.stubGlobal('__VUE_DEVTOOLS_GLOBAL_HOOK__', {enabled: true, emit() {}});
    vi.stubGlobal('document', doc); vi.stubGlobal('window', win);
    for (const key of ['Node', 'Element', 'HTMLElement'] as const) vi.stubGlobal(key, win[key]);
    const frames = new Map<number, () => void>(); let frameId = 0;
    const requestFrame = (fn: () => void) => {frames.set(++frameId, fn); return frameId;};
    const cancelFrame = (id: number) => {frames.delete(id);};
    Object.assign(win, {innerWidth: 1000, innerHeight: 800,
        matchMedia: () => ({matches: false, addEventListener() {}, removeEventListener() {}}),
        requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame});
    vi.stubGlobal('requestAnimationFrame', requestFrame); vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    const node = doc.querySelector('#source')!.firstChild!, text = node.textContent!;
    const rect = {top: 100, bottom: 120, left: 100, right: 200, width: 100, height: 20};
    const range = markRaw({startContainer: node, endContainer: node, commonAncestorContainer: node, startOffset: 0, endOffset: text.length,
        cloneRange() {return this;}, getClientRects: () => [rect], getBoundingClientRect: () => rect});
    win.getSelection = () => ({rangeCount: 1, isCollapsed: false, getRangeAt: () => range, anchorNode: node, anchorOffset: 0,
        containsNode: () => false, toString: () => text}) as unknown as Selection;
    win.HTMLElement.prototype.getBoundingClientRect = () => ({...rect, width: 388, height: 200}) as DOMRect;
    const handlers = new WeakMap<Element, Record<string, any>>();
    const renderer = createRenderer<any, any>({createElement: tag => markRaw(doc.createElement(tag)),
        createText: text => doc.createTextNode(text), createComment: text => doc.createComment(text),
        insert: (node, parent, anchor) => parent.insertBefore(node, anchor || null), remove: node => node.remove(),
        setText: (node, text) => {node.nodeValue = text;}, setElementText: (node, text) => {node.textContent = text;},
        parentNode: node => node.parentNode, nextSibling: node => node.nextSibling, setScopeId: (node, id) => node.setAttribute(id, ''),
        patchProp(node, key, _old, value) {
            if (key.startsWith('on')) {const saved = handlers.get(node) || {}; saved[key] = value; handlers.set(node, saved);}
            else if (key === 'style') Object.assign(node.style, value || {});
            else if (value === false || value == null) node.removeAttribute(key);
            else node.setAttribute(key, value === true ? '' : String(value));
        },
        insertStaticContent(html, parent, anchor) {const box = doc.createElement('div'); box.innerHTML = html;
            const first = box.firstChild!, last = box.lastChild!; while (box.firstChild) parent.insertBefore(box.firstChild, anchor || null); return [first, last];},
    });
    const component = (await import('@/src/features/selection-translation/ui/SelectionTranslator.vue')).default;
    const {translateSelectionFromContextMenu} = await import('@/src/features/selection-translation/content/contextMenuBridge');
    expect((component as any).render).toBeTypeOf('function');
    app = renderer.createApp(component); app.directive('ui-i18n', {}); app.mount(doc.querySelector('#fluent-read-selection-translator-container')!);
    await settle(); expect(translateSelectionFromContextMenu()).toBe(true); await settle();
    function click(selector: string, index: number | string = 0) {
        const targets = Array.from(doc.querySelectorAll(selector));
        const target = typeof index === 'number' ? targets[index] : targets.find(node => node.textContent?.trim() === index);
        if (!target) throw new Error(`Missing public control ${selector} (${index})`);
        const fn = handlers.get(target)?.onClick; expect(fn).toBeTypeOf('function');
        fn({target, currentTarget: target, stopPropagation() {}, preventDefault() {}});
    }
    click('.fr-study-toolbar button', '读懂'); await settle();
    expect(doc.querySelector('[data-reading-panel]')).not.toBeNull(); expect(streams).toHaveLength(1);
    function finish(answer: string, stream = streams.at(-1)!) {
        for (const fn of stream.messages) fn({type: 'result', requestId: stream.request.requestId,
            response: {success: true, text: answer, service: 'openai', model: 'controlled-model'}});
    }
    async function choose(index: number) {
        // SelectionTranslator owns main's visible action navigation; its real
        // ReadingPanel receives the action through the public initialAction prop.
        const label = ['读懂', '句法', '用法', '练习'][index];
        expect(label).toBeTypeOf('string');
        click('.fr-study-toolbar button', label); await settle();
    }
    function updateCredentials(change: (value: any) => any) {background.emit('local:credentials', change(background.records.get('local:credentials')));}
    return {background, store, doc, streams, tabMessages, broadcastRuntime, finish, choose, click, updateCredentials, frames};
}

describe('audit48 I actual authorized config -> SelectionTranslator -> ReadingPanel -> runtime stream', () => {
    it.each(['key', 'pool', 'headers', 'delete', 'rotation'])('invalidates cached actions after selected %s input changes without exposing credentials', async kind => {
        const service = kind === 'headers' ? 'custom' : 'openai';
        const ctx = await mountReading(service); ctx.finish('old meaning'); await ctx.choose(1); ctx.finish('old grammar');
        await ctx.choose(0); expect(ctx.streams).toHaveLength(2); expect(ctx.doc.querySelector('.fr-reading-answer')?.textContent).toContain('old meaning');
        ctx.background.emit('local:config', {...ctx.background.records.get('local:config') as object, animations: false}); await settle();
        await ctx.choose(1); await ctx.choose(0); expect(ctx.streams).toHaveLength(2);
        if (kind === 'rotation') ctx.background.emit('local:config', {...ctx.background.records.get('local:config') as object, apiKeyRotationEnabled: {openai: true}});
        else ctx.updateCredentials(value => kind === 'delete' ? null : extractConfigCredentials({...value,
            ...(kind === 'key' ? {apiKeys: {...value.apiKeys, openai: ['synthetic-b', 'synthetic-pool']}} : {}),
            ...(kind === 'pool' ? {apiKeys: {...value.apiKeys, openai: ['synthetic-a', 'synthetic-second']}} : {}),
            ...(kind === 'headers' ? {customHeaders: {[service]: JSON.stringify({'X-Test': 'synthetic-new'})}} : {}),
        }));
        await settle(); await ctx.choose(1); expect(ctx.streams).toHaveLength(3); ctx.finish('new grammar');
        await ctx.choose(0); expect(ctx.streams).toHaveLength(4); ctx.finish('new meaning'); await settle();
        expect(ctx.doc.querySelector('.fr-reading-answer')?.textContent).toContain('new meaning');
        expect(ctx.store.config.apiKeys).toEqual({}); expect(ctx.store.config.customHeaders).toEqual({});
        expect(JSON.stringify(ctx.tabMessages).includes('synthetic')).toBe(false);
        expect(ctx.tabMessages.every(message => Object.keys(message as object).every(key => key === 'type' || key === 'key'))).toBe(true);
        expect(ports.send.mock.calls.filter(([message]) => message.type === 'configStorageRead').every(([message]) => message.key === 'local:config')).toBe(true);
        expect(ctx.broadcastRuntime.warn).not.toHaveBeenCalled();
    });
    it('keeps cached actions after equal credentials and a different service credential update', async () => {
        const ctx = await mountReading(); ctx.finish('meaning'); await ctx.choose(1); ctx.finish('grammar');
        ctx.updateCredentials(value => structuredClone(value));
        ctx.updateCredentials(value => extractConfigCredentials({...value, apiKeys: {...value.apiKeys, deepseek: ['synthetic-unrelated']}}));
        await settle(); await ctx.choose(0);
        expect(ctx.streams).toHaveLength(2); expect(ctx.doc.querySelector('.fr-reading-answer')?.textContent).toContain('meaning');
        expect(ctx.tabMessages).toEqual([]);
    });
    it('cancels active reading and ignores a late stream result after input invalidation', async () => {
        const ctx = await mountReading(); const old = ctx.streams[0];
        ctx.updateCredentials(value => extractConfigCredentials({...value, apiKeys: {openai: ['synthetic-new']}}));
        await settle(); expect(old.disconnect).toHaveBeenCalledOnce(); ctx.finish('late stale', old); await settle();
        expect(ctx.doc.querySelector('.fr-reading-answer')).toBeNull();
        await ctx.choose(1); ctx.finish('current grammar'); await ctx.choose(0); expect(ctx.streams).toHaveLength(3);
    });
    it('releases component listeners, stream ownership, timers and all broadcast watches on unmount/dispose', async () => {
        const ctx = await mountReading(); const runtimeBeforeUnmount = ports.messages.size;
        app!.unmount(); app = undefined; disposeBroadcast!(); disposeBroadcast = undefined; await settle();
        await vi.advanceTimersByTimeAsync(0);
        expect(ctx.streams[0].disconnect).toHaveBeenCalledOnce();
        expect(ports.messages.size).toBe(1); expect(runtimeBeforeUnmount).toBeGreaterThan(1);
        expect(ctx.background.watchers.size).toBe(0); expect(ctx.frames.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        const sent = ctx.broadcastRuntime.sendTabMessage.mock.calls.length;
        ctx.updateCredentials(() => null); await settle();
        expect(ctx.broadcastRuntime.sendTabMessage.mock.calls).toHaveLength(sent);
    });
});
