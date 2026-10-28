import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createContext, runInContext} from 'node:vm';
import type {Config} from '@/src/core/config/model';

// 使用真实 Vue runtime-dom 和 SFC；linkedom 只提供受控 DOM 外部端口。
const dom = await vi.hoisted(async () => {
    const {parseHTML} = await import('linkedom');
    const parsed = parseHTML('<html><body></body></html>');
    Object.defineProperty(parsed.window.Node.prototype, Symbol.toStringTag, {
        configurable: true, get() { return this.constructor.name; },
    });
    for (const key of ['document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'ShadowRoot', 'Event', 'CustomEvent']) {
        Object.defineProperty(globalThis, key, {configurable: true, writable: true, value: (parsed.window as any)[key]});
    }
    Object.defineProperty(parsed.document, 'contentType', {configurable: true, value: 'text/html'});
    Object.defineProperty(parsed.document, 'readyState', {configurable: true, value: 'complete'});
    const location = {href: 'https://fixture.test/article', hash: ''};
    const window = {document: parsed.document, location,
        matchMedia: () => ({matches: false}),
        addEventListener: parsed.document.addEventListener.bind(parsed.document),
        removeEventListener: parsed.document.removeEventListener.bind(parsed.document),
        dispatchEvent: parsed.document.dispatchEvent.bind(parsed.document)};
    Object.defineProperty(globalThis, 'window', {configurable: true, writable: true, value: window});
    Object.defineProperty(globalThis, 'location', {configurable: true, writable: true, value: location});
    Object.defineProperty(globalThis, 'NodeFilter', {configurable: true, value: {SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2}});
    // linkedom 没有标准 acceptNode 剪枝；这里只实现 DOM 遍历端口，不包含任何产品筛选规则。
    parsed.document.createTreeWalker = ((root: Node, mask: number, filter?: NodeFilter | ((node: Node) => number)) => {
        const stack: Node[] = [...root.childNodes].reverse();
        return {nextNode() {
            while (stack.length) {
                const node = stack.pop()!;
                const shown = (mask & (1 << (node.nodeType - 1))) !== 0;
                const accepted = shown ? (typeof filter === 'function' ? filter(node) : filter?.acceptNode(node) ?? 1) : 3;
                if (accepted === 2) continue;
                stack.push(...[...node.childNodes].reverse());
                if (accepted === 1) return node;
            }
            return null;
        }} as TreeWalker;
    }) as typeof document.createTreeWalker;
    return {document: parsed.document as unknown as Document, location};
});

const ports = vi.hoisted(() => ({config: null as any, save: vi.fn(), send: vi.fn(), patch: vi.fn(), subscribe: vi.fn(), ready: Promise.resolve()}));
const compilerPort = vi.hoisted(() => ({programs: 0}));
vi.mock('typescript', async importOriginal => {
    const actual = await importOriginal<typeof import('typescript')>();
    const implementation = (actual as unknown as {default?: typeof actual}).default ?? actual;
    return {...actual, default: {...implementation, createProgram: (...args: any[]) => {
        compilerPort.programs += 1;
        return (implementation.createProgram as any)(...args);
    }}};
});
vi.mock('@/src/services/config/store', async () => {
    const {Config} = await import('@/src/core/config/model');
    ports.config = new Config();
    return {config: ports.config, configReady: ports.ready, saveConfig: ports.save, subscribeConfig: ports.subscribe, requestConfigPatch: ports.patch, getConfigRevision: () => 0};
});
vi.mock('webextension-polyfill', () => ({default: {tabs: {sendMessage: ports.send}, runtime: {sendMessage: ports.send}}}));
vi.mock('element-plus/es/components/select/style/css', () => ({}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({translateLegacy: (text: string) => text, t: (key: string) => key}), createUiI18nPlugin: () => ({install() {}})}));
// Element Plus 是 UI 外部端口；SettingsPanel、UiSelect、模板事件和配置归一化均为真实实现。
vi.mock('element-plus', async () => {
    const {defineComponent, h} = await import('vue');
    return {
        ClickOutside: {},
        ElSelect: defineComponent({props: ['modelValue', 'disabled'], emits: ['update:modelValue', 'change'],
            setup: (props, {slots, attrs, emit}) => () => h('div', {...attrs, 'data-value': props.modelValue, 'aria-disabled': props.disabled,
                onChange: (event: Event) => {const value = (event.target as HTMLSelectElement).value; emit('update:modelValue', value); emit('change', value);}}, slots.default?.())}),
        ElOption: defineComponent({props: ['value', 'label', 'disabled'], setup: props => () => h('span', {'data-option': props.value, 'aria-disabled': props.disabled}, props.label)}),
    };
});

import {createApp, nextTick, type App} from 'vue';
import SettingsPanel from '@/userscript/SettingsPanel.vue';
import {userscriptFetch} from '@/userscript/http';
import {createShadowRootUi} from '@/userscript/shadow-root';
import {getPageTranslationContext, resetPageTranslationContextCache} from '@/userscript/pageContext';

let app: App | undefined;
beforeEach(() => {
    dom.document.body.replaceChildren();
    dom.document.body.removeAttribute('hidden');
    dom.document.body.removeAttribute('translate');
    dom.location.href = 'https://fixture.test/article';
    resetPageTranslationContextCache();
    vi.stubGlobal('GM', undefined);
    vi.stubGlobal('GM_xmlhttpRequest', undefined);
    ports.save.mockReset().mockResolvedValue(undefined);
    ports.send.mockReset().mockResolvedValue({success: true});
    ports.patch.mockReset().mockResolvedValue(undefined);
    ports.subscribe.mockReset().mockReturnValue(vi.fn());
});

// 只控制外部 Promise/事件端口，产品算法和生命周期均从真实公共模块执行。
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => {resolve = done; reject = fail;});
    return {promise, resolve, reject};
}

function trackWindowListeners(): () => void {
    const added: Array<[string, EventListenerOrEventListenerObject]> = [];
    const add = window.addEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
        added.push([type, listener]); add(type, listener, options);
    });
    const documentAdded: Array<[string, EventListenerOrEventListenerObject]> = [];
    const documentAdd = document.addEventListener.bind(document);
    vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
        documentAdded.push([type, listener]); documentAdd(type, listener, options);
    });
    return () => {
        for (const [type, listener] of added) window.removeEventListener(type, listener);
        for (const [type, listener] of documentAdded) document.removeEventListener(type, listener);
    };
}

describe('49F storage observation through the real browser adapter', () => {
    it('keeps stored null and falsy values distinct from missing-key defaults across batch reads', async () => {
        const releaseEvents = trackWindowListeners(), values = new Map<string, unknown>();
        vi.stubGlobal('GM', {getValue: (key: string, fallback: unknown) => values.has(key) ? values.get(key) : fallback,
            setValue: (key: string, value: unknown) => {values.set(key, value);}, listValues: () => [...values.keys()]});
        const {default: adapter} = await import('@/userscript/browser');
        const observed = vi.fn();adapter.storage.onChanged.addListener(observed);
        try {
            expect(adapter.storage.onChanged.hasListener(observed)).toBe(true);
            const stored = {'local:null': null, 'local:false': false, 'local:zero': 0, 'local:empty': ''};
            await adapter.storage.local.set(stored);
            expect(await adapter.storage.local.get({...Object.fromEntries(Object.keys(stored).map(key => [key, 'fallback'])), 'local:missing': 'null'}))
                .toEqual({...stored, 'local:missing': 'null'});
            expect(await adapter.storage.local.get(Object.keys(stored))).toEqual(stored);
            expect(await adapter.storage.local.get()).toEqual(stored);
            expect(observed).toHaveBeenCalledTimes(4);
        } finally {adapter.storage.onChanged.removeListener(observed);expect(adapter.storage.onChanged.hasListener(observed)).toBe(false);releaseEvents();}
    });

    it('opens settings through its owned DOM event and maps tab/icon adapters without extension privileges', async () => {
        const {default: adapter, chrome} = await import('@/userscript/browser');
        const settings = vi.fn(), open = vi.fn();window.addEventListener('fluentread-userscript-open-settings', settings);
        vi.stubGlobal('window', {...window, open});vi.stubGlobal('__FLUENTREAD_ICON_DATA__', 'data:image/png;base64,fixture');
        try {
            await adapter.runtime.openOptionsPage();expect(settings).toHaveBeenCalledOnce();
            expect(chrome.runtime).toBe(adapter.runtime);expect(chrome.storage).toBe(adapter.storage);
            expect(await adapter.tabs.query()).toEqual([{id:1,windowId:1,active:true}]);
            await adapter.tabs.create({});expect(open).not.toHaveBeenCalled();await adapter.tabs.create({url:'https://fixture.test/new'});
            expect(open).toHaveBeenCalledWith('https://fixture.test/new','_blank','noopener,noreferrer');
            expect(adapter.runtime.getURL('icon/64.png')).toBe('data:image/png;base64,fixture');expect(adapter.runtime.getURL('other/file.wasm')).toBe('');
            vi.stubGlobal('__FLUENTREAD_ICON_DATA__', undefined);expect(adapter.runtime.getURL('icon/32.png')).toBe('');
        } finally {window.removeEventListener('fluentread-userscript-open-settings', settings);}
    });

    it('keeps later browser storage observers running when an earlier observer throws after a committed write', async () => {
        const releaseEvents = trackWindowListeners();
        const values = new Map<string, unknown>();
        vi.stubGlobal('GM', {getValue: (key: string, fallback: unknown) => values.has(key) ? values.get(key) : fallback, setValue: (key: string, value: unknown) => {values.set(key, value);}});
        const {default: adapter} = await import('@/userscript/browser');
        const failed = vi.fn(() => {throw new Error('observer unavailable');});
        const observed = vi.fn();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        adapter.storage.onChanged.addListener(failed);adapter.storage.onChanged.addListener(observed);
        try {
            await adapter.storage.local.set({'local:release-observer': {version: 1}});
            expect(await adapter.storage.local.get('local:release-observer')).toEqual({'local:release-observer': {version: 1}});
            expect(observed).toHaveBeenCalledWith({'local:release-observer': {oldValue: null, newValue: {version: 1}}}, 'local');
            expect(failed).toHaveBeenCalledOnce();expect(warn).toHaveBeenCalledOnce();
        } finally {
            adapter.storage.onChanged.removeListener(failed);adapter.storage.onChanged.removeListener(observed);
            releaseEvents();warn.mockRestore();
        }
    });

    it.each(['initial', 'focus'] as const)('does not publish a stale %s read after a committed local write', async phase => {
        const releaseEvents = trackWindowListeners();
        const key = `local:audit49f-${phase}`;
        const heldRead = deferred<unknown>();
        let value: unknown = JSON.stringify({version: 1});
        let holdNextRead = phase === 'initial';
        const getValue = vi.fn(() => {
            if (holdNextRead) {holdNextRead = false; return heldRead.promise;}
            return value;
        });
        vi.stubGlobal('GM', {getValue, setValue: (_key: string, next: unknown) => {value = next;}});
        const {default: adapter} = await import('@/userscript/browser');
        const changes: unknown[] = [];
        const observe = (change: unknown) => {changes.push(change);};
        adapter.storage.onChanged.addListener(observe);
        try {
            await adapter.storage.local.get(key);
            await Promise.resolve();
            if (phase === 'focus') {
                value = JSON.stringify({version: 0});
                holdNextRead = true;
                window.dispatchEvent(new Event('focus'));
                await Promise.resolve();
            }
            await adapter.storage.local.set({[key]: {version: 2}});
            heldRead.resolve(JSON.stringify({version: phase === 'focus' ? 0 : 1}));
            await new Promise(resolve => setTimeout(resolve, 0));
            window.dispatchEvent(new Event('focus'));
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(await adapter.storage.local.get(key)).toEqual({[key]: {version: 2}});
            expect(changes).toEqual([{[key]: {oldValue: {version: phase === 'focus' ? 0 : 1}, newValue: {version: 2}}}]);
        } finally {adapter.storage.onChanged.removeListener(observe); releaseEvents();}
    });

    it('handles rejected initial/focus/visible reads and recovers the actual public subscription', async () => {
        const releaseEvents = trackWindowListeners();
        const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
        Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'visible'});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        let fail = true;
        vi.stubGlobal('GM', {getValue: () => fail ? Promise.reject(new Error('controlled GM read failure')) : JSON.stringify({version: 3})});
        const {storage} = await import('@/userscript/storage');
        const changes: unknown[] = [];
        const stop = storage.watch('local:audit49f-refresh-error', value => {changes.push(value);});
        try {
            await new Promise(resolve => setTimeout(resolve, 0));
            window.dispatchEvent(new Event('focus'));
            await new Promise(resolve => setTimeout(resolve, 0));
            document.dispatchEvent(new Event('visibilitychange'));
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(warn).toHaveBeenCalledTimes(3);
            expect(changes).toEqual([]);
            fail = false;
            window.dispatchEvent(new Event('focus'));
            await vi.waitFor(() => expect(changes).toEqual([{version: 3}]));
            stop();
            window.dispatchEvent(new Event('focus'));
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(changes).toEqual([{version: 3}]);
        } finally {
            stop(); releaseEvents();
            if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
            else delete (document as any).visibilityState;
        }
    });
});

describe('49F actual invalidation consumers', () => {
    it('returns WXT-compatible invalidation unsubscribe and a safe handle after synchronous expiry', async () => {
        const {createUserscriptContentContext} = await import('@/userscript/context');
        const context = createUserscriptContentContext();
        const removed = vi.fn(), retained = vi.fn();
        const unsubscribe = context.onInvalidated(removed);
        context.onInvalidated(retained);
        expect(typeof unsubscribe).toBe('function');
        unsubscribe(); unsubscribe();
        context.invalidate();
        expect(removed).not.toHaveBeenCalled();
        expect(retained).toHaveBeenCalledOnce();
        const late = vi.fn();
        const unsubscribeLate = context.onInvalidated(late);
        expect(late).toHaveBeenCalledOnce();
        expect(typeof unsubscribeLate).toBe('function');
        unsubscribeLate(); context.invalidate();
        expect(late).toHaveBeenCalledOnce();
    });

    it('still disposes installed page styles and all callbacks after an earlier cleanup throws', async () => {
        const {createUserscriptContentContext} = await import('@/userscript/context');
        const {installPageStyles} = await import('@/src/app/content/pageStyles');
        const context = createUserscriptContentContext();
        const first = new Error('first cleanup');
        const second = new Error('second cleanup');
        context.onInvalidated(() => {throw first;});
        const unsubscribe = vi.fn(); ports.subscribe.mockReturnValue(unsubscribe);
        const removeStyles = installPageStyles(context as never);
        context.onInvalidated(() => {throw second;});
        const last = vi.fn(); context.onInvalidated(last);
        try {
            expect(document.getElementById('fluent-read-page-styles')).not.toBeNull();
            expect(() => context.invalidate()).toThrow(first);
            expect(context.isInvalid).toBe(true);
            expect(document.getElementById('fluent-read-page-styles')).toBeNull();
            expect(unsubscribe).toHaveBeenCalledOnce(); expect(last).toHaveBeenCalledOnce();
            expect(() => context.invalidate()).not.toThrow(); expect(last).toHaveBeenCalledOnce();
            const late = vi.fn(); context.onInvalidated(late); expect(late).toHaveBeenCalledOnce();
        } finally {removeStyles();}
    });
});

describe('49F asynchronous responses from the actual content message consumer', () => {
    it('retains an immediate callback response when the listener also returns a Promise without a value', async () => {
        const {default: adapter} = await import('@/userscript/browser');
        const listener = (_message: unknown, _sender: unknown, send: (value: unknown) => void) => {
            send({status: 'callback accepted'});
            return Promise.resolve();
        };
        adapter.runtime.onMessage.addListener(listener);
        try {
            expect(await adapter.tabs.sendMessage(1, {type: 'controlled-callback-and-promise'}))
                .toEqual({status: 'callback accepted'});
        } finally {adapter.runtime.onMessage.removeListener(listener);}
    });

    it.each(['resolved', 'rejected'] as const)('retains an accepted Promise response after removal, matching the installed polyfill (%s)', async outcome => {
        const nativeListeners = new Set<(...args: any[]) => unknown>();
        const native = {runtime: {id: 'controlled-extension', onMessage: {
            addListener: (listener: (...args: any[]) => unknown) => {nativeListeners.add(listener);},
            removeListener: (listener: (...args: any[]) => unknown) => {nativeListeners.delete(listener);},
            hasListener: (listener: (...args: any[]) => unknown) => nativeListeners.has(listener),
        }, sendMessage: (message: unknown, respond: (value?: unknown) => void) => {
            if (!nativeListeners.size) {respond(); return;}
            for (const listener of nativeListeners) listener(message, {}, respond);
        }}};
        // 执行仓库实际安装的 polyfill；受控 chrome 只提供事件和消息通道端口。
        const realm = createContext({chrome: native, console, Promise, Error});
        runInContext(readFileSync(resolve(process.cwd(), 'node_modules/webextension-polyfill/dist/browser-polyfill.js'), 'utf8'), realm, {timeout: 1000});
        const polyfill = realm.browser as {runtime: {
            sendMessage(message: unknown): Promise<unknown>;
            onMessage: {addListener(listener: () => Promise<unknown>): void; removeListener(listener: () => Promise<unknown>): void; hasListener(listener: () => Promise<unknown>): boolean};
        }};
        const {default: adapter} = await import('@/userscript/browser');
        const operations = [deferred<unknown>(), deferred<unknown>()];
        const listeners = operations.map(operation => vi.fn(() => operation.promise));
        const message = {type: 'controlled-promise-response'};
        const accepted = [polyfill.runtime.sendMessage.bind(polyfill.runtime), adapter.tabs.sendMessage.bind(adapter.tabs, 1)];
        const events = [polyfill.runtime.onMessage, adapter.runtime.onMessage];
        const results: Array<Array<{value?: unknown; error?: unknown}>> = [[], []];
        const pending = events.map((event, index) => {
            event.addListener(listeners[index]);
            const promise = accepted[index](message).then(value => {results[index].push({value});}, error => {results[index].push({error});});
            event.removeListener(listeners[index]);
            return promise;
        });
        try {
            await Promise.resolve(); await Promise.resolve();
            expect(results).toEqual([[], []]);
            for (let index = 0; index < events.length; index += 1) {
                expect(events[index].hasListener(listeners[index])).toBe(false);
                expect(await accepted[index](message)).toBeUndefined();
                expect(listeners[index]).toHaveBeenCalledOnce();
            }
            const error = new Error('controlled returned Promise rejection');
            for (const operation of operations) {
                if (outcome === 'resolved') operation.resolve({status: 'accepted before removal'});
                else operation.reject(error);
            }
            await Promise.all(pending);
            if (outcome === 'resolved') expect(results).toEqual([[{value: {status: 'accepted before removal'}}], [{value: {status: 'accepted before removal'}}]]);
            else {
                expect((results[0][0].error as Error).message).toBe(error.message);
                expect(results[1][0].error).toBe(error);
            }
        } finally {
            operations.forEach(operation => operation.resolve(undefined));
            events.forEach((event, index) => event.removeListener(listeners[index]));
            await Promise.all(pending);
        }
    });

    it.each(['success', 'failed'] as const)('waits for updateSiteDisabled %s after the zero-delay turn', async outcome => {
        vi.useFakeTimers();
        const features = ['autoTranslateEnglishPage', 'invalidateFullPageTranslationSessionCache', 'isFullPageTranslationActive', 'getTranslationToolbarStatus',
            'mountAreaTranslator', 'mountFloatingBall', 'startAreaTranslationFromContextMenu', 'startSectionTranslationPicker', 'translateSelectionFromContextMenu',
            'toggleContextMenuImage', 'mountImageTranslator', 'mountSelectionTranslator', 'mountTranslationProgressPanel', 'restoreOriginalContent',
            'unmountAreaTranslator', 'unmountFloatingBall', 'unmountImageTranslator', 'unmountSelectionTranslator', 'unmountTranslationProgressPanel'];
        vi.doMock('@/src/app/content/features', () => Object.fromEntries(features.map(name => [name, vi.fn()])));
        const {createContentRuntimeMessageHandler} = await import('@/src/app/content/messageRuntime');
        const {default: adapter} = await import('@/userscript/browser');
        const operation = deferred<void>();
        const update = vi.fn(() => operation.promise);
        const listener = createContentRuntimeMessageHandler({} as never, {isSiteDisabled: () => false, updateSiteDisabled: update});
        adapter.runtime.onMessage.addListener(listener);
        const responses: unknown[] = [];
        const pending = adapter.tabs.sendMessage(1, {type: 'updateSiteExtensionDisabled', isDisabled: true}).then(value => {responses.push(value); return value;});
        try {
            await vi.advanceTimersByTimeAsync(1);
            expect(update).toHaveBeenCalledWith(true); expect(responses).toEqual([]);
            if (outcome === 'success') operation.resolve(); else operation.reject(new Error('controlled update failure'));
            expect(await pending).toEqual({status: outcome});
        } finally {
            operation.resolve(); adapter.runtime.onMessage.removeListener(listener);
            await pending; vi.useRealTimers(); vi.doUnmock('@/src/app/content/features');
        }
    });

    it('releases a pending true-response channel on listener removal and ignores its late callback', async () => {
        const {default: adapter} = await import('@/userscript/browser');
        let respond!: (value: unknown) => void;
        const listener = (_message: unknown, _sender: unknown, send: (value: unknown) => void) => {respond = send; return true;};
        adapter.runtime.onMessage.addListener(listener);
        const pending = adapter.tabs.sendMessage(1, {type: 'controlled-pending-response'});
        adapter.runtime.onMessage.removeListener(listener);
        expect(await pending).toBeUndefined();
        respond({status: 'too late'});
        expect(await adapter.tabs.sendMessage(1, {type: 'controlled-pending-response'})).toBeUndefined();
    });
});

describe('49F concurrent settings through the actual Vue client adapter', () => {
    it.each(['close-after-mount', 'close-before-mount'] as const)('owns one actual SettingsPanel for concurrent opens (%s)', async timing => {
        const creation = deferred<void>();
        const created: Awaited<ReturnType<typeof createShadowRootUi>>[] = [];
        const create = vi.fn(async (context, options) => {
            await creation.promise;
            const ui = await createShadowRootUi(context, options); created.push(ui); return ui;
        });
        vi.doMock('wxt/utils/content-script-ui/shadow-root', () => ({createShadowRootUi: create}));
        const settings = await import('@/userscript/settings');
        try {
            const first = settings.openUserscriptSettings({isInvalid: false});
            const second = settings.openUserscriptSettings({isInvalid: false});
            if (timing === 'close-before-mount') settings.closeUserscriptSettings();
            creation.resolve(); await Promise.all([first, second]); await nextTick(); await nextTick();
            expect(create).toHaveBeenCalledOnce();
            const ui = created[0];
            expect(ui.shadowHost.isConnected).toBe(timing === 'close-after-mount');
            if (timing === 'close-after-mount') {
                expect(ui.uiContainer.querySelector('[role="dialog"]')).not.toBeNull();
                const close = ui.uiContainer.querySelector<HTMLButtonElement>('button.close')!;
                close.dispatchEvent(Object.assign(new Event('click', {bubbles: true}), {_vts: Date.now()+1}));
                await nextTick(); expect(ui.shadowHost.isConnected).toBe(false);
            }
        } finally {
            creation.resolve(); settings.closeUserscriptSettings(); for (const ui of created) ui.remove();
            vi.doUnmock('wxt/utils/content-script-ui/shadow-root');
        }
    });

    it('retries a failed asynchronous creation with the actual settings SFC', async () => {
        const created: Awaited<ReturnType<typeof createShadowRootUi>>[] = [];
        const create = vi.fn().mockRejectedValueOnce(new Error('controlled creation failure')).mockImplementation(async (context, options) => {
            const ui = await createShadowRootUi(context, options); created.push(ui); return ui;
        });
        vi.doMock('wxt/utils/content-script-ui/shadow-root', () => ({createShadowRootUi: create}));
        const settings = await import('@/userscript/settings');
        try {
            await expect(settings.openUserscriptSettings({isInvalid: false})).rejects.toThrow('controlled creation failure');
            await settings.openUserscriptSettings({isInvalid: false}); await nextTick(); await nextTick();
            expect(create).toHaveBeenCalledTimes(2);
            expect(created[0].uiContainer.querySelector('[role="dialog"]')).not.toBeNull();
            settings.closeUserscriptSettings(); expect(created[0].shadowHost.isConnected).toBe(false);
        } finally {settings.closeUserscriptSettings(); for (const ui of created) ui.remove(); vi.doUnmock('wxt/utils/content-script-ui/shadow-root');}
    });
});
afterEach(async () => {
    app?.unmount(); app = undefined;
    await nextTick();
    vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules();
});

describe('49F real public transport cancellation', () => {
    it.each(['load', 'error'] as const)('keeps AbortError when handle.abort synchronously reports %s', async kind => {
        let details!: UserscriptXmlHttpRequestDetails;
        const abort = vi.fn(() => kind === 'load'
            ? details.onload?.({status: 200, responseText: 'late translation'})
            : details.onerror?.({status: 500, statusText: 'late manager error'}));
        vi.stubGlobal('GM_xmlhttpRequest', (value: UserscriptXmlHttpRequestDetails) => {details = value; return {abort};});
        const controller = new AbortController();
        const pending = userscriptFetch('https://fixture.test/translation', {signal: controller.signal});
        const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError'});
        await Promise.resolve(); controller.abort();
        await rejected;
        expect(abort).toHaveBeenCalledOnce();
        details.onload?.({status: 200, responseText: 'later result'});
    });

    it('aborts a handle returned after a synchronous cancellation inside the GM port', async () => {
        const controller = new AbortController();
        const abort = vi.fn();
        vi.stubGlobal('GM_xmlhttpRequest', () => {controller.abort(); return {abort};});
        await expect(userscriptFetch('https://fixture.test/translation', {signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
        expect(abort).toHaveBeenCalledOnce();
    });

    it('preserves POST bodies, duplicate headers, and null-body status through the public entry', async () => {
        let details!: UserscriptXmlHttpRequestDetails;
        vi.stubGlobal('GM_xmlhttpRequest', (value: UserscriptXmlHttpRequestDetails) => {
            details = value; queueMicrotask(() => value.onload?.({status: 205, responseText: 'ignored', responseHeaders: 'x-fixture: one\r\nx-fixture: two'}));
        });
        const response = await userscriptFetch(new Request('https://fixture.test/translation', {method: 'POST', body: 'fixture', headers: {'x-request': 'yes'}}));
        expect(new TextDecoder().decode(details.data as ArrayBuffer)).toBe('fixture');
        expect(details.headers).toMatchObject({'x-request': 'yes'});
        expect(response.headers.get('x-fixture')).toBe('one, two');
        expect(await response.text()).toBe('');
    });
});

describe('49F actual Shadow DOM lifetime', () => {
    it('detaches the host and clears mounted state even if the external disposer throws', async () => {
        const ui = await createShadowRootUi({}, {name: 'audit49f', onMount: () => ({id: 1}), onRemove: () => {throw new Error('external disposer');}});
        ui.mount(); expect(ui.shadowHost.isConnected).toBe(true);
        expect(() => ui.remove()).toThrow('external disposer');
        expect(ui.shadowHost.isConnected).toBe(false);
        expect(ui.mounted).toBeUndefined();
        expect(() => ui.remove()).not.toThrow();
    });

    it('rolls back failed mounting and permits a later successful mount', async () => {
        const onMount = vi.fn().mockImplementationOnce(() => {throw new Error('external mount');}).mockReturnValue({id: 2});
        const ui = await createShadowRootUi({}, {name: 'audit49f', onMount});
        expect(() => ui.mount()).toThrow('external mount');
        expect(ui.shadowHost.isConnected).toBe(false);
        ui.mount(); expect(ui.mounted).toEqual({id: 2});
        expect(onMount).toHaveBeenCalledTimes(2); ui.remove();
    });

    it('isolates composed keyboard bubbling after the actual internal listener runs, then remounts cleanly', async () => {
        const ui = await createShadowRootUi({}, {name: 'audit49f', isolateEvents: ['keydown'], onMount: container => {
            const button = document.createElement('button'); container.append(button); return button;
        }});
        const internal = vi.fn(), outside = vi.fn();
        ui.mount(); ui.mounted!.addEventListener('keydown', internal);
        document.addEventListener('keydown', outside);
        try {
            ui.mounted!.dispatchEvent(new Event('keydown', {bubbles: true, composed: true}));
            expect(internal).toHaveBeenCalledOnce(); expect(outside).not.toHaveBeenCalled();
            ui.remove(); ui.mount(); expect(ui.shadowHost.isConnected).toBe(true); ui.remove();
            expect(ui.shadowHost.isConnected).toBe(false);
        } finally {document.removeEventListener('keydown', outside);}
    });

    it.each(['return', 'throw'] as const)('preserves a newer mount created synchronously by the removal hook (%s)', async outcome => {
        let ui!: Awaited<ReturnType<typeof createShadowRootUi<HTMLElement>>>;
        let mounts = 0;
        const removed: HTMLElement[] = [];
        ui = await createShadowRootUi({}, {name: 'audit49f', onMount: container => {
            const button = document.createElement('button');
            button.textContent = `mount ${++mounts}`; container.append(button); return button;
        }, onRemove: mounted => {
            if (!mounted) return;
            removed.push(mounted); mounted.remove();
            if (removed.length === 1) {
                ui.mount();
                if (outcome === 'throw') throw new Error('old removal hook');
            }
        }});
        ui.mount(); const first = ui.mounted!;
        try {
            if (outcome === 'throw') expect(() => ui.remove()).toThrow('old removal hook');
            else ui.remove();
            expect(ui.shadowHost.isConnected).toBe(true);
            expect(ui.mounted!.textContent).toBe('mount 2');
            expect(ui.mounted!.isConnected).toBe(true);
            expect(removed).toEqual([first]);
            ui.mount(); expect(mounts).toBe(2);
            const second = ui.mounted!;
            ui.remove(); expect(removed).toEqual([first, second]);
            expect(ui.shadowHost.isConnected).toBe(false); expect(ui.mounted).toBeUndefined();
        } finally {ui.remove();}
    });

    it('disposes the value returned after a synchronous removal during mounting exactly once', async () => {
        let ui!: Awaited<ReturnType<typeof createShadowRootUi<HTMLElement>>>;
        let mounts = 0;
        const removed: Array<HTMLElement | undefined> = [];
        let first!: HTMLElement;
        ui = await createShadowRootUi({}, {name: 'audit49f', onMount: container => {
            const button = document.createElement('button'); container.append(button);
            if (++mounts === 1) {first = button; ui.remove();}
            return button;
        }, onRemove: mounted => {removed.push(mounted); mounted?.remove();}});
        try {
            ui.mount();
            expect(ui.shadowHost.isConnected).toBe(false); expect(ui.mounted).toBeUndefined();
            expect(removed).toEqual([first]); expect(ui.uiContainer.childNodes.length).toBe(0);
            ui.remove(); expect(removed).toEqual([first]);
            ui.mount(); const second = ui.mounted!;
            expect(second.isConnected).toBe(true);
            ui.remove(); expect(removed).toEqual([first, second]);
            expect(ui.shadowHost.isConnected).toBe(false);
        } finally {ui.remove();}
    });

    it.each(['return', 'throw'] as const)('keeps the newer owner when an interrupted mount completes later (%s)', async outcome => {
        let ui!: Awaited<ReturnType<typeof createShadowRootUi<HTMLElement>>>;
        let mounts = 0;
        const removed: HTMLElement[] = [];
        ui = await createShadowRootUi({}, {name: 'audit49f', onMount: container => {
            const button = document.createElement('button');
            button.textContent = `mount ${++mounts}`; container.append(button);
            if (mounts === 1) {
                ui.remove(); ui.mount();
                if (outcome === 'throw') {button.remove(); throw new Error('old mount hook');}
            }
            return button;
        }, onRemove: mounted => {if (mounted) {removed.push(mounted); mounted.remove();}}});
        try {
            if (outcome === 'throw') expect(() => ui.mount()).toThrow('old mount hook');
            else ui.mount();
            expect(ui.shadowHost.isConnected).toBe(true);
            expect(ui.mounted!.textContent).toBe('mount 2'); expect(ui.mounted!.isConnected).toBe(true);
            expect(ui.uiContainer.childNodes.length).toBe(1);
            expect(removed.length).toBe(outcome === 'return' ? 1 : 0);
            ui.mount(); expect(mounts).toBe(2);
            const second = ui.mounted!;
            ui.remove(); expect(removed.at(-1)).toBe(second);
            expect(ui.shadowHost.isConnected).toBe(false); expect(ui.mounted).toBeUndefined();
        } finally {ui.remove();}
    });
});

describe('49F page context capture root boundaries', () => {
    it.each(['hidden', 'translate'] as const)('does not collect text from an excluded fallback body (%s)', async attribute => {
        document.body.setAttribute(attribute, attribute === 'translate' ? 'no' : '');
        document.body.innerHTML = '<p>EXCLUDED_FIXTURE_TEXT</p>';
        expect(await getPageTranslationContext()).not.toContain('EXCLUDED_FIXTURE_TEXT');
    });

    it('keeps original DOM and bounded readable output across cache reset and repeated requests', async () => {
        document.body.innerHTML = '<main><p>Visible fixture text</p><textarea>PRIVATE_FIXTURE</textarea><div translate="no">SKIPPED_FIXTURE</div></main>';
        const original = document.body.innerHTML;
        const first = await getPageTranslationContext();
        expect(first).toContain('Visible fixture text'); expect(first).not.toMatch(/PRIVATE_FIXTURE|SKIPPED_FIXTURE/u);
        resetPageTranslationContextCache(); expect(await getPageTranslationContext()).toBe(first);
        expect(document.body.innerHTML).toBe(original);
    });
});

describe('49F malformed resource boundaries through real loaders', () => {
    it.each([['number', 7], ['object', {invalid: true}], ['array', []]] as const)('rejects %s message values before extension registration and permits retry', async (_label, value) => {
        const {createUiLanguageBundleLoader} = await import('@/src/platform/i18n/uiLanguageBundles');
        const i18n = await import('@/src/core/i18n');
        const invalid = {messages: {'audit.value': value}, legacyText: {}, legacyPatterns: {early: [], late: []}};
        const valid = {messages: {'audit.value': 'Hello {name}'}, legacyText: {}, legacyPatterns: {early: [], late: []}};
        const fetch = vi.fn().mockResolvedValueOnce({ok: true, status: 200, json: async () => invalid}).mockResolvedValue({ok: true, status: 200, json: async () => valid});
        const warn = vi.fn();
        const ensure = createUiLanguageBundleLoader({resolveUrl: path => path, fetch, warn});
        expect(await ensure('fr-FR')).toBe(false); expect(i18n.hasUiLanguageBundle('fr-FR')).toBe(false);
        expect(await ensure('fr-FR')).toBe(true); expect(i18n.translate('audit.value', 'fr-FR', {name: 'fixture'})).toBe('Hello fixture');
        expect(fetch).toHaveBeenCalledTimes(2); expect(warn).toHaveBeenCalledOnce();
    });

    it.each([
        ['array catalog', {messages: [], legacyText: {}, legacyPatterns: {early: [], late: []}}],
        ['object message', {messages: {broken: {}}, legacyText: {}, legacyPatterns: {early: [], late: []}}],
        ['non tuple pattern', {messages: {}, legacyText: {}, legacyPatterns: {early: [null], late: []}}],
    ])('replaces a corrupt GM cache (%s) using a controlled manager response', async (_label, invalid) => {
        const valid = {messages: {'audit.value': 'Bonjour {name}'}, legacyText: {}, legacyPatterns: {early: [], late: []}};
        const requests = vi.fn(() => Promise.resolve({status: 200, responseText: JSON.stringify(valid)}));
        const writes = vi.fn();
        vi.stubGlobal('GM', {getValue: () => invalid, setValue: writes, xmlHttpRequest: requests});
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_LANGUAGE_BUNDLES__', {});
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_REMOTE_LANGUAGES__', {'fr-FR': 'controlled-fixture.json'});
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_RESOURCE_COMMIT__', 'controlled-fixture');
        const loader = await import('@/userscript/uiLanguageBundles');
        const i18n = await import('@/src/core/i18n');
        expect(await loader.ensureUiLanguageBundle('fr-FR')).toBe(true);
        expect(i18n.translate('audit.value', 'fr-FR', {name: 'fixture'})).toBe('Bonjour fixture');
        expect(requests).toHaveBeenCalledOnce(); expect(writes).toHaveBeenCalledOnce();
    });
});

describe('49F actual settings client template', () => {
    it('hydrates, edits a native control, saves normalized config, and applies the current-page messages', async () => {
        ports.config.on = true;
        const subscribers = new Set<(snapshot: Config) => void>();
        ports.subscribe.mockImplementation(callback => {subscribers.add(callback);return () => subscribers.delete(callback);});
        // ACK 前发布已接受的权威快照，与真实 store 的 patch/订阅契约一致。
        ports.patch.mockImplementation(async (snapshot: Config) => {
            Object.assign(ports.config, snapshot);
            for (const subscriber of subscribers) subscriber(ports.config);
        });
        const root = document.createElement('div'); document.body.append(root);
        app = createApp(SettingsPanel); app.mount(root);
        await nextTick(); await nextTick();
        ports.send.mockResolvedValue({status: 'success'});
        const input = root.querySelector<HTMLInputElement>('.toggle input')!;
        expect(input.checked).toBe(true);
        input.checked = false; input.dispatchEvent(new Event('change', {bubbles: true}));
        await nextTick();
        const save = root.querySelector<HTMLButtonElement>('button.primary')!;
        save.dispatchEvent(Object.assign(new Event('click', {bubbles: true}), {_vts: Date.now() + 1}));
        await vi.waitFor(() => expect(root.querySelector('.status')!.textContent).toBe('本次提交已保存，并已应用到当前页面。'));
        expect(ports.patch).toHaveBeenCalledOnce();
        expect(ports.patch.mock.calls[0][0]).toMatchObject({on: false, contextMenuEnabled: false, disableImageTranslator: true});
        expect(ports.send.mock.calls.map(call => call[1])).toEqual([{type: 'reconcileUserscriptPage'}]);
    });
});

describe('49F actual build symbol detector', () => {
    it('preserves free, bound, property, and escaped-identifier semantics at the production entry', async () => {
        const {findFreeBrowserGlobals} = await import('@/userscript/vite.config');
        const id = resolve(process.cwd(), 'userscript/audit49f-fixture.ts');
        for (const [source, expected] of [
            ['const data = {value: 1}; data.value;', []],
            ['browser.runtime.sendMessage({}); chrome.runtime.getURL("icon");', ['browser', 'chrome']],
            ['function f(browser) { return browser.runtime; }', []],
            ['const data = {browser: 1, chrome: 2}; data.browser;', []],
            ['br\\u006fwser.runtime.sendMessage({});', ['browser']],
            ['chr\\u006fme.runtime.getURL("icon");', ['chrome']],
            ['const br\\u006fwser = {}; br\\u006fwser.runtime;', []],
            ['const mybrowser = {}; const chromed = {};', []],
        ] as const) expect(findFreeBrowserGlobals(source, id)).toEqual(expected);
    });

    it('avoids creating compiler programs for the same bounded source batch without global candidates', async () => {
        const {findFreeBrowserGlobals} = await import('@/userscript/vite.config');
        compilerPort.programs = 0;
        const sources = Array.from({length: 128}, (_, index) => `export const value${index} = ${index};\n${'/* bounded fixture data */\n'.repeat(128)}`);
        const start = performance.now();
        const output = sources.map((source, index) => findFreeBrowserGlobals(source, resolve(process.cwd(), `src/audit49f-${index}.ts`)));
        const evidence = {inputs: sources.length, inputBytes: Buffer.byteLength(sources.join('')), programs: compilerPort.programs,
            output, outputHash: createHash('sha256').update(JSON.stringify(output)).digest('hex'), elapsedMs: performance.now() - start};
        const evidenceDirectory = process.env.FLUENTREAD_AUDIT49F_EVIDENCE_DIR;
        if (evidenceDirectory) {
            mkdirSync(evidenceDirectory, {recursive: true});
            writeFileSync(resolve(evidenceDirectory, `performance-${process.env.AUDIT49F_BASELINE === '1' ? 'baseline' : 'current'}.json`), JSON.stringify(evidence, null, 2));
        }
        expect(output).toEqual(Array.from({length: 128}, () => []));
        expect(compilerPort.programs).toBe(0);
    });
});

describe('49F real config-store ownership through the full platform public handler', () => {
    it.each(['hydrated', 'external-public', 'external-credentials'] as const)('uses committed %s state for an actual optimistic patch', async source => {
        const releaseEvents = trackWindowListeners();
        const {normalizeConfig} = await import('@/src/core/config/model');
        const {toPublicConfig} = await import('@/src/services/config/history');
        const {CONFIG_REVISION_FIELD} = await import('@/src/services/config/schema');
        const {extractConfigCredentials} = await import('@/src/core/config/credentials');
        const initial = normalizeConfig({on: false, count: 73, token: {qwen: 'controlled-fixture-old'}});
        const values = new Map<string, unknown>([
            ['local:config', JSON.stringify({...toPublicConfig(initial), [CONFIG_REVISION_FIELD]: 4})],
            ['local:credentials', JSON.stringify(extractConfigCredentials(initial))],
        ]);
        vi.stubGlobal('GM', {
            getValue: (key: string, fallback: unknown) => values.has(key) ? values.get(key) : fallback,
            setValue: (key: string, value: unknown) => {values.set(key, value);},
            deleteValue: (key: string) => {values.delete(key);},
        });
        const storageModule = await import('@/userscript/storage');
        vi.doMock('@/src/platform/storage/configStorageRuntime', () => ({configStorage: storageModule.configStorage}));
        vi.doMock('@/src/platform/storage/credentialContext', () => ({isTrustedCredentialStorageContext: () => true}));
        const store = await vi.importActual<typeof import('@/src/services/config/store')>('@/src/services/config/store');
        vi.doMock('@/src/services/config/store', () => store);
        // 这些未执行的供应商/数据库端口隔离真实账户和 IndexedDB；实际 store、协议 handler 和 GM adapter 不替换。
        vi.doMock('@/src/app/translation/visionProbeRuntime', () => ({modelVisionProbe: {resolve: vi.fn()}}));
        vi.doMock('@/src/app/translation/runtime', () => ({cleanupTranslationCache: vi.fn(), clearTranslationCache: vi.fn(), translateWithCache: vi.fn()}));
        vi.doMock('@/src/platform/storage/modelUsageRepository', () => ({getModelUsageRepository: () => ({})}));
        vi.doMock('@/src/features/vocabulary/repository', () => ({vocabularyBook: {pruneUndo: async () => undefined}}));
        const {default: adapter, setPlatformMessageHandler, resetPlatformMessageHandler} = await import('@/userscript/browser');
        let ready = false;
        try {
            storageModule.completeUserscriptConfigPreparation(); await store.configReady; ready = true;
            const {createPlatformMessageHandler} = await import('@/userscript/platformFull');
            const stops: ReturnType<typeof vi.fn>[] = [];
            const watch = storageModule.configStorage.watch.bind(storageModule.configStorage);
            vi.spyOn(storageModule.configStorage, 'watch').mockImplementation((key, callback) => {
                const stop = vi.fn(watch(key, callback)); stops.push(stop); return stop;
            });
            const handler = createPlatformMessageHandler(vi.fn());
            // 只记录该同步公开创建调用拥有的订阅；shared history 随后的订阅另有生命周期。
            const handlerStops = stops.slice();
            setPlatformMessageHandler(handler);
            if (source !== 'hydrated') await Promise.resolve();
            if (source === 'external-public') {
                const updated = normalizeConfig({...initial, on: true, translationFontSize: 19});
                values.set('local:config', JSON.stringify({...toPublicConfig(updated), [CONFIG_REVISION_FIELD]: 5}));
                window.dispatchEvent(new Event('focus'));
                await vi.waitFor(() => expect(store.config.on).toBe(true));
                expect(store.getConfigRevision()).toBe(5);
            } else if (source === 'external-credentials') {
                const credentials = extractConfigCredentials(normalizeConfig({...initial, apiKeys: {qwen: ['controlled-fixture-new']}}));
                values.set('local:credentials', JSON.stringify(credentials));
                window.dispatchEvent(new Event('focus'));
                await vi.waitFor(() => expect(store.config.token.qwen).toBe('controlled-fixture-new'));
            }
            const nextOn = source !== 'external-public';
            await store.requestConfigPatch({on: nextOn}, adapter.runtime.sendMessage);
            expect(store.config.on).toBe(nextOn);
            expect(store.config.count).toBe(73);
            const stored = JSON.parse(values.get('local:config') as string);
            expect(stored.on).toBe(nextOn); expect(stored.count).toBe(73);
            if (source === 'external-public') expect(stored.translationFontSize).toBe(19);
            expect(JSON.parse(values.get('local:credentials') as string).token.qwen)
                .toBe(source === 'external-credentials' ? 'controlled-fixture-new' : 'controlled-fixture-old');
            resetPlatformMessageHandler();
            if ('dispose' in handler) {
                expect(handlerStops).toHaveLength(2);
                for (const stop of handlerStops) expect(stop).toHaveBeenCalledOnce();
                (handler as typeof handler & {dispose(): void}).dispose();
                for (const stop of handlerStops) expect(stop).toHaveBeenCalledOnce();
                expect(await handler({type: 'openOptionsPage'})).toBe((await import('@/userscript/browser')).UNHANDLED_RUNTIME_MESSAGE);
            }
        } finally {
            resetPlatformMessageHandler(); if (ready) await store.flushConfigHistory(); releaseEvents();
            vi.doUnmock('@/src/platform/storage/configStorageRuntime'); vi.doUnmock('@/src/platform/storage/credentialContext');
            vi.doUnmock('@/src/app/translation/visionProbeRuntime'); vi.doUnmock('@/src/app/translation/runtime');
            vi.doUnmock('@/src/platform/storage/modelUsageRepository'); vi.doUnmock('@/src/features/vocabulary/repository');
            vi.doMock('@/src/services/config/store', () => ({config: ports.config, configReady: ports.ready, saveConfig: ports.save, subscribeConfig: ports.subscribe, requestConfigPatch: ports.patch, getConfigRevision: () => 0}));
        }
    });
});

describe('49F full platform cleanup through the public browser owner', () => {
    async function platformFixture() {
        const releaseEvents = trackWindowListeners();
        const {normalizeConfig} = await import('@/src/core/config/model');
        const {toPublicConfig} = await import('@/src/services/config/history');
        const initial = normalizeConfig({on: false, count: 73});
        const values = new Map<string, unknown>([['local:config', JSON.stringify(toPublicConfig(initial))]]);
        vi.stubGlobal('GM', {getValue: (key: string, fallback: unknown) => values.get(key) ?? fallback,
            setValue: (key: string, value: unknown) => {values.set(key, value);}, deleteValue: (key: string) => {values.delete(key);}});
        const storage = await import('@/userscript/storage');
        vi.doMock('@/src/platform/storage/configStorageRuntime', () => ({configStorage: storage.configStorage}));
        vi.doMock('@/src/platform/storage/credentialContext', () => ({isTrustedCredentialStorageContext: () => true}));
        const store = await vi.importActual<typeof import('@/src/services/config/store')>('@/src/services/config/store');
        storage.completeUserscriptConfigPreparation(); await store.configReady;
        // 真实解析/CAS/队列执行；save 是受控持久化出口，观察提交值而不复制业务算法。
        vi.doMock('@/src/services/config/store', () => ({...store, saveConfig: ports.save}));
        vi.doMock('@/src/app/translation/visionProbeRuntime', () => ({modelVisionProbe: {resolve: vi.fn()}}));
        vi.doMock('@/src/app/translation/runtime', () => ({cleanupTranslationCache: vi.fn(), clearTranslationCache: vi.fn(), translateWithCache: vi.fn()}));
        vi.doMock('@/src/platform/storage/modelUsageRepository', () => ({getModelUsageRepository: () => ({})}));
        vi.doMock('@/src/features/vocabulary/repository', () => ({vocabularyBook: {pruneUndo: async () => undefined}}));
        const browser = await import('@/userscript/browser');
        const platform = await import('@/userscript/platformFull');
        type OwnedWatch = {key: string; callback: (value: any) => void; stop: ReturnType<typeof vi.fn>; release(): void; error?: Error; onStop?: () => void};
        const owned: OwnedWatch[] = [];
        let acquiring = false;
        const watch = storage.configStorage.watch.bind(storage.configStorage);
        vi.spyOn(storage.configStorage, 'watch').mockImplementation((key, callback) => {
            const release = watch(key, callback);
            if (!acquiring) return release;
            const resource: OwnedWatch = {key, callback, release, stop: vi.fn(() => {
                release(); resource.onStop?.(); if (resource.error) throw resource.error;
            })};
            owned.push(resource); return resource.stop;
        });
        const create = () => {
            const start = owned.length; acquiring = true;
            try {
                const open = vi.fn(); const handler = platform.createPlatformMessageHandler(open);
                return {handler, open, watches: owned.slice(start)};
            } finally {acquiring = false;}
        };
        return {browser, create, initial, normalizeConfig, toPublicConfig, initialRevision: store.getConfigRevision(), async close() {
            // 即使基线中首个 stop 抛错，fixture 也独立释放全部真实 watch 和事件。
            owned.forEach(resource => {resource.error = undefined; resource.onStop = undefined;});
            try {browser.resetPlatformMessageHandler();}
            finally {
                owned.forEach(resource => resource.release()); await store.flushConfigHistory(); releaseEvents();
                vi.doUnmock('@/src/platform/storage/configStorageRuntime'); vi.doUnmock('@/src/platform/storage/credentialContext');
                vi.doUnmock('@/src/app/translation/visionProbeRuntime'); vi.doUnmock('@/src/app/translation/runtime');
                vi.doUnmock('@/src/platform/storage/modelUsageRepository'); vi.doUnmock('@/src/features/vocabulary/repository');
                vi.doMock('@/src/services/config/store', () => ({config: ports.config, configReady: ports.ready, saveConfig: ports.save, subscribeConfig: ports.subscribe, requestConfigPatch: ports.patch, getConfigRevision: () => 0}));
            }
        }};
    }

    it.each(['reset', 'replace'] as const)('releases both actual owned watches and retires the old handler when %s cleanup throws', async transition => {
        const fixture = await platformFixture();
        const old = fixture.create();
        const first = new Error('first owned unsubscribe failure');
        fixture.browser.setPlatformMessageHandler(old.handler);
        const replacement = transition === 'replace' ? fixture.create() : undefined;
        try {
            expect(old.watches).toHaveLength(2);
            old.watches[0].error = first; old.watches[1].error = new Error('second owned unsubscribe failure');
            let cleanupError: unknown;
            try {if (replacement) fixture.browser.setPlatformMessageHandler(replacement.handler); else fixture.browser.resetPlatformMessageHandler();}
            catch (error) {cleanupError = error;}
            expect(cleanupError).toBe(first);
            old.watches.forEach(resource => expect(resource.stop).toHaveBeenCalledOnce());
            expect(() => old.handler.dispose()).not.toThrow();
            old.watches.forEach(resource => expect(resource.stop).toHaveBeenCalledOnce());
            expect(await old.handler({type: 'openOptionsPage'})).toBe(fixture.browser.UNHANDLED_RUNTIME_MESSAGE);
            expect(await fixture.browser.default.runtime.sendMessage({type: 'openOptionsPage'})).toEqual(replacement ? {success: true} : undefined);
            expect(old.open).not.toHaveBeenCalled();
            if (replacement) {
                expect(replacement.open).toHaveBeenCalledOnce();
                fixture.browser.setPlatformMessageHandler(replacement.handler);
                replacement.watches.forEach(resource => expect(resource.stop).not.toHaveBeenCalled());
            }
            fixture.browser.resetPlatformMessageHandler(); fixture.browser.resetPlatformMessageHandler();
            replacement?.watches.forEach(resource => expect(resource.stop).toHaveBeenCalledOnce());
        } finally {await fixture.close();}
    });

    it.each(['reset', 'replace'] as const)('preserves a newer public owner installed reentrantly by a %s unsubscribe port', async transition => {
        const fixture = await platformFixture();
        const old = fixture.create(); const next = fixture.create(); const newer = fixture.create();
        fixture.browser.setPlatformMessageHandler(old.handler);
        const failure = new Error('old owner cleanup failure after reentry');
        try {
            expect(old.watches).toHaveLength(2);
            old.watches[0].onStop = () => fixture.browser.setPlatformMessageHandler(newer.handler);
            old.watches[0].error = failure;
            let cleanupError: unknown;
            try {if (transition === 'replace') fixture.browser.setPlatformMessageHandler(next.handler); else fixture.browser.resetPlatformMessageHandler();}
            catch (error) {cleanupError = error;}
            expect(cleanupError).toBe(failure);
            old.watches.forEach(resource => expect(resource.stop).toHaveBeenCalledOnce());
            expect(await fixture.browser.default.runtime.sendMessage({type: 'openOptionsPage'})).toEqual({success: true});
            expect(newer.open).toHaveBeenCalledOnce(); expect(old.open).not.toHaveBeenCalled(); expect(next.open).not.toHaveBeenCalled();
            newer.watches.forEach(resource => expect(resource.stop).not.toHaveBeenCalled());
            if (transition === 'replace') next.watches.forEach(resource => expect(resource.stop).toHaveBeenCalledOnce());
            fixture.browser.resetPlatformMessageHandler(); fixture.browser.resetPlatformMessageHandler();
            newer.watches.forEach(resource => expect(resource.stop).toHaveBeenCalledOnce());
        } finally {await fixture.close();}
    });

    it('ignores retired watch delivery without changing an already accepted real persistence request', async () => {
        const fixture = await platformFixture(); const old = fixture.create();
        fixture.browser.setPlatformMessageHandler(old.handler);
        try {
            expect(old.watches).toHaveLength(2);
            const failure = new Error('controlled unsubscribe failure'); old.watches[0].error = failure;
            const accepted = fixture.browser.default.runtime.sendMessage({type: 'persistConfig', mode: 'patch',
                config: {on: true}, expected: {on: false}, clientId: 'controlled-old-owner', sequence: 1});
            // 接受消息后立即移交 owner；真实配置队列将在 microtask 中运行，没有复制队列或私有 helper。
            const settled = accepted.then(value => ({value}), error => ({error}));
            try {
                let cleanupError: unknown;
                try {fixture.browser.resetPlatformMessageHandler();} catch (error) {cleanupError = error;}
                expect(cleanupError).toBe(failure);
                for (const resource of old.watches) resource.callback(resource.key === 'local:config'
                    ? fixture.toPublicConfig(fixture.normalizeConfig({...fixture.initial, on: true, selectionTranslatorDelay: 444}))
                    : {token: {qwen: 'controlled-retired-watch'}});
                expect(await settled).toEqual({value: {success: true, revision: fixture.initialRevision}});
                expect(ports.save).toHaveBeenCalledOnce();
                const committed = ports.save.mock.calls[0][0];
                expect(committed.on).toBe(true); expect(committed.count).toBe(73);
                expect(committed.selectionTranslatorDelay).toBe(fixture.initial.selectionTranslatorDelay);
                expect(committed.token.qwen).toBe(fixture.initial.token.qwen);
                expect(await fixture.browser.default.runtime.sendMessage({type: 'persistConfig', config: {on: false}})).toBeUndefined();
                expect(ports.save).toHaveBeenCalledOnce();
            } finally {await settled;}
        } finally {await fixture.close();}
    });
});

describe('49F concrete Vue mount-failure ownership boundary', () => {
    it('releases the real i18n plugin subscription and partial SettingsPanel DOM when the client renderer port throws', async () => {
        vi.doUnmock('@/src/ui/i18n');
        ports.config.uiLanguage = 'zh-CN';
        const subscribed = new Set<unknown>();
        const stops: Array<() => void> = [];
        ports.subscribe.mockImplementation(callback => {
            subscribed.add(callback); const stop = vi.fn(() => {subscribed.delete(callback);}); stops.push(stop); return stop;
        });
        let failedUi!: Awaited<ReturnType<typeof createShadowRootUi>>;
        vi.doMock('wxt/utils/content-script-ui/shadow-root', () => ({createShadowRootUi: async (context: unknown, options: Parameters<typeof createShadowRootUi>[1]) => {
            failedUi = await createShadowRootUi(context, options);
            const insert = failedUi.uiContainer.insertBefore.bind(failedUi.uiContainer);
            failedUi.uiContainer.insertBefore = ((node: Node, reference: Node | null) => {
                insert(node, reference); throw new Error('controlled client DOM insertion failure');
            }) as typeof failedUi.uiContainer.insertBefore;
            return failedUi;
        }}));
        const {createVueShadowUi} = await import('@/src/platform/shadow-ui');
        try {
            await expect(createVueShadowUi({isInvalid: false} as never, {name:'audit49f-failed-real-vue',hostId:'audit49f-failed-real-vue',component:SettingsPanel}))
                .rejects.toThrow('controlled client DOM insertion failure');
            expect(failedUi.shadowHost.isConnected).toBe(false); expect(failedUi.mounted).toBeUndefined();
            expect(failedUi.uiContainer.querySelector('[role="dialog"]')).toBeNull();
            expect(stops).toHaveLength(2); expect(subscribed.size).toBe(0);
            for (const stop of stops) expect(stop).toHaveBeenCalledOnce();
            failedUi.remove(); expect(subscribed.size).toBe(0);
            for (const stop of stops) expect(stop).toHaveBeenCalledOnce();
        } finally {
            for (const stop of stops) stop(); failedUi?.uiContainer.replaceChildren(); failedUi?.remove();
            vi.doUnmock('wxt/utils/content-script-ui/shadow-root');
            vi.doMock('@/src/ui/i18n', () => ({useUiI18n: () => ({translateLegacy: (text: string) => text,t:(key:string)=>key}),createUiI18nPlugin:()=>({install(){}})}));
        }
    });
});


describe('49F real Vue partial construction disposal and retry', () => {
    async function clientPorts(observeFailure?: Error, disconnectFailure?: Error) {
        vi.doUnmock('@/src/ui/i18n');
        vi.useFakeTimers();
        const bundle = deferred<boolean>();
        vi.doMock('@/src/platform/i18n/uiLanguageBundles', () => ({ensureUiLanguageBundle: () => bundle.promise}));
        const callbacks: Array<(config: any) => void> = [];
        const subscribed = new Set<unknown>();
        const stops: ReturnType<typeof vi.fn>[] = [];
        let cleanupError: Error | undefined;
        ports.subscribe.mockImplementation(callback => {
            callbacks.push(callback); subscribed.add(callback);
            const stop = vi.fn(() => {subscribed.delete(callback); if (cleanupError) throw cleanupError;});
            stops.push(stop); return stop;
        });
        const observers: Array<{callback: MutationCallback; active: boolean; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>}> = [];
        vi.stubGlobal('MutationObserver', class {
            active = false;
            observe = vi.fn(() => {this.active = true; if (observeFailure) throw observeFailure;});
            disconnect = vi.fn(() => {this.active = false; if (disconnectFailure) throw disconnectFailure;});
            constructor(public callback: MutationCallback) {observers.push(this);}
        });
        const fixture = document.createElement('main');
        fixture.innerHTML = '<p data-i18n-ignore>用户内容不应改动</p><p>保存设置</p>';
        document.body.appendChild(fixture);
        const {default: Panel} = await import('@/userscript/SettingsPanel.vue');
        const store = await import('@/src/services/config/store');
        store.config.uiLanguage = 'zh-CN';
        const i18n = await import('@/src/ui/i18n');
        return {Panel, fixture, i18n, subscribed, stops, observers, callbacks, bundle,
            failCleanup(error: Error) {cleanupError = error;},
            async deliverLateWork(context?: ReturnType<typeof i18n.useUiI18n>) {
                const language = context?.language.value;
                const revision = context?.bundleRevision.value;
                const pending = context?.setLanguage('ja-JP');
                for (const callback of callbacks) callback({...store.config, uiLanguage: 'en-US'});
                for (const observer of observers) observer.callback([{type: 'childList', target: fixture, addedNodes: []} as unknown as MutationRecord], observer as unknown as MutationObserver);
                bundle.resolve(true); await Promise.resolve(); await nextTick();
                if (pending) expect(await pending).toBe(false);
                if (context) {expect(context.language.value).toBe(language); expect(context.bundleRevision.value).toBe(revision);}
                expect(subscribed.size).toBe(0);
                expect(observers.every(observer => !observer.active)).toBe(true);
                expect(vi.getTimerCount()).toBe(0);
                expect(fixture.querySelector('[data-i18n-ignore]')?.textContent).toBe('用户内容不应改动');
            },
        };
    }
    afterEach(() => {
        vi.useRealTimers();
        vi.doUnmock('wxt/utils/content-script-ui/shadow-root');
        vi.doUnmock('@/src/platform/i18n/uiLanguageBundles');
        vi.doMock('@/src/ui/i18n', () => ({useUiI18n: () => ({translateLegacy: (text: string) => text, t: (key: string) => key}), createUiI18nPlugin: () => ({install() {}})}));
    });

    it('cleans a configureApp failure before plugin installation and retries the same actual SettingsPanel UI', async () => {
        const client = await clientPorts();
        let ui!: Awaited<ReturnType<typeof createShadowRootUi>>;
        vi.doMock('wxt/utils/content-script-ui/shadow-root', () => ({createShadowRootUi: async (ctx: unknown, options: Parameters<typeof createShadowRootUi>[1]) => ui = await createShadowRootUi(ctx, options)}));
        const first = new Error('configure before install');
        let fail = true;
        const close = vi.fn();
        const unmounts: ReturnType<typeof vi.spyOn>[] = [];
        try {
            await expect((await import('@/src/platform/shadow-ui')).createVueShadowUi({isInvalid: false} as never, {name:'audit49f-configure-before',hostId:'audit49f-configure-before',component:client.Panel,props:{onClose:close},configureApp(vueApp) {
                unmounts.push(vi.spyOn(vueApp, 'unmount'));
                if (fail) throw first;
                vueApp.use(client.i18n.createUiI18nPlugin());
            }})).rejects.toBe(first);
            expect(ui.shadowHost.isConnected).toBe(false); expect(ui.uiContainer.childNodes.length).toBe(0);
            expect(client.subscribed.size).toBe(0); expect(unmounts[0]).toHaveBeenCalledOnce();
            fail = false; ui.mount(); await nextTick(); await nextTick();
            expect(ui.shadowHost.isConnected).toBe(true); expect(ui.uiContainer.querySelector('[role="dialog"]')).not.toBeNull();
            ui.uiContainer.querySelector<HTMLButtonElement>('button.close')!.click(); expect(close).toHaveBeenCalledOnce();
            ui.remove(); expect(unmounts[1]).toHaveBeenCalledOnce();
            // 正常重试各自拥有一个 i18n 与一个 editor 订阅，均只能释放一次。
            expect(client.stops).toHaveLength(2); for (const stop of client.stops) expect(stop).toHaveBeenCalledOnce();
            await client.deliverLateWork();
        } finally {ui?.remove();}
    });

    it.each([false, true])('releases real plugin resources after configureApp throws, preserving its error when unsubscribe throws=%s', async cleanupThrows => {
        const client = await clientPorts();
        let ui!: Awaited<ReturnType<typeof createShadowRootUi>>;
        let context!: ReturnType<typeof client.i18n.useUiI18n>;
        vi.doMock('wxt/utils/content-script-ui/shadow-root', () => ({createShadowRootUi: async (ctx: unknown, options: Parameters<typeof createShadowRootUi>[1]) => ui = await createShadowRootUi(ctx, options)}));
        const first = new Error('configure after real plugin');
        if (cleanupThrows) client.failCleanup(new Error('unsubscribe cleanup failure'));
        try {
            await expect((await import('@/src/platform/shadow-ui')).createVueShadowUi({isInvalid:false} as never,{name:'audit49f-configure-after',hostId:'audit49f-configure-after',component:client.Panel,configureApp(vueApp) {
                vueApp.use(client.i18n.createUiI18nPlugin({documentRoot:client.fixture}));
                context = vueApp.runWithContext(client.i18n.useUiI18n);
                throw first;
            }})).rejects.toBe(first);
            expect(ui.shadowHost.isConnected).toBe(false); expect(ui.uiContainer.childNodes.length).toBe(0);
            expect(client.observers).toHaveLength(1); expect(client.stops[0]).toHaveBeenCalledOnce();
            await client.deliverLateWork(context); ui.remove(); expect(client.stops[0]).toHaveBeenCalledOnce();
        } finally {ui?.remove();}
    });

    it('ignores actual pending hydration and bundle completion after plugin disposal before client mount', async () => {
        const hydration = deferred<void>();
        ports.ready = hydration.promise;
        const client = await clientPorts();
        let context!: ReturnType<typeof client.i18n.useUiI18n>;
        let ui!: Awaited<ReturnType<typeof createShadowRootUi>>;
        const first = new Error('configure with pending hydration');
        vi.doMock('wxt/utils/content-script-ui/shadow-root', () => ({createShadowRootUi: async (ctx: unknown, options: Parameters<typeof createShadowRootUi>[1]) => ui = await createShadowRootUi(ctx, options)}));
        try {
            ports.config.uiLanguage = 'ja-JP';
            await expect((await import('@/src/platform/shadow-ui')).createVueShadowUi({isInvalid:false} as never,{name:'audit49f-pending-dispose',hostId:'audit49f-pending-dispose',component:client.Panel,configureApp(vueApp) {
                vueApp.use(client.i18n.createUiI18nPlugin({documentRoot:client.fixture}));
                context = vueApp.runWithContext(client.i18n.useUiI18n); throw first;
            }})).rejects.toBe(first);
            expect(context.language.value).toBe('ja-JP'); expect(context.bundleRevision.value).toBe(0);
            const metadata = document.documentElement.lang;
            ports.config.uiLanguage = 'en-US'; hydration.resolve();
            await client.deliverLateWork(context);
            expect(document.documentElement.lang).toBe(metadata); expect(client.stops[0]).toHaveBeenCalledOnce();
            expect(ui.shadowHost.isConnected).toBe(false); expect(ui.uiContainer.childNodes.length).toBe(0);
        } finally {hydration.resolve(); ports.ready = Promise.resolve(); ui?.remove();}
    });

    it('disposes failed real document observation even when its disconnect port also throws', async () => {
        const first = new Error('observe install failure');
        const client = await clientPorts(first, new Error('disconnect cleanup failure'));
        let ui!: Awaited<ReturnType<typeof createShadowRootUi>>;
        vi.doMock('wxt/utils/content-script-ui/shadow-root', () => ({createShadowRootUi: async (ctx: unknown, options: Parameters<typeof createShadowRootUi>[1]) => ui = await createShadowRootUi(ctx, options)}));
        try {
            await expect((await import('@/src/platform/shadow-ui')).createVueShadowUi({isInvalid:false} as never,{name:'audit49f-observe-failure',hostId:'audit49f-observe-failure',component:client.Panel,configureApp(vueApp) {
                vueApp.use(client.i18n.createUiI18nPlugin({documentRoot:client.fixture}));
            }})).rejects.toBe(first);
            expect(ui.shadowHost.isConnected).toBe(false); expect(client.stops[0]).toHaveBeenCalledOnce();
            expect(client.observers[0].disconnect).toHaveBeenCalledOnce();
            await client.deliverLateWork();
        } finally {ui?.remove();}
    });

    it('releases document watches and subscriptions when real plugin registration throws', async () => {
        const client = await clientPorts();
        const first = new Error('directive registration port');
        let ui!: Awaited<ReturnType<typeof createShadowRootUi>>;
        vi.doMock('wxt/utils/content-script-ui/shadow-root', () => ({createShadowRootUi: async (ctx: unknown, options: Parameters<typeof createShadowRootUi>[1]) => ui = await createShadowRootUi(ctx, options)}));
        try {
            await expect((await import('@/src/platform/shadow-ui')).createVueShadowUi({isInvalid:false} as never,{name:'audit49f-register-failure',hostId:'audit49f-register-failure',component:client.Panel,configureApp(vueApp) {
                vi.spyOn(vueApp, 'directive').mockImplementation(() => {throw first;});
                vueApp.use(client.i18n.createUiI18nPlugin({documentRoot:client.fixture}));
            }})).rejects.toBe(first);
            expect(ui.shadowHost.isConnected).toBe(false); expect(client.stops[0]).toHaveBeenCalledOnce();
            await client.deliverLateWork();
        } finally {ui?.remove();}
    });

    it.each([false, true])('cleans the actual mounted SettingsPanel after ui.mount throws, preserving the first error with remove failure=%s', async removalThrows => {
        const client = await clientPorts();
        const first = new Error('ui mount port after client mount');
        let ui!: Awaited<ReturnType<typeof createShadowRootUi>>;
        let context!: ReturnType<typeof client.i18n.useUiI18n>;
        vi.doMock('wxt/utils/content-script-ui/shadow-root', () => ({createShadowRootUi: async (ctx: unknown, options: Parameters<typeof createShadowRootUi>[1]) => {
            ui = await createShadowRootUi(ctx, options);
            const mount = ui.mount.bind(ui); ui.mount = () => {mount(); throw first;};
            if (removalThrows) {const remove = ui.remove.bind(ui); ui.remove = () => {remove(); throw new Error('ui remove port after cleanup');};}
            return ui;
        }}));
        try {
            await expect((await import('@/src/platform/shadow-ui')).createVueShadowUi({isInvalid:false} as never,{name:'audit49f-port-failure',hostId:'audit49f-port-failure',component:client.Panel,configureApp(vueApp) {
                vueApp.use(client.i18n.createUiI18nPlugin({documentRoot:client.fixture})); context = vueApp.runWithContext(client.i18n.useUiI18n);
            }})).rejects.toBe(first);
            expect(ui.shadowHost.isConnected).toBe(false); expect(ui.mounted).toBeUndefined();
            expect(ui.uiContainer.querySelector('[role="dialog"]')).toBeNull(); expect(client.stops[0]).toHaveBeenCalledOnce();
            await client.deliverLateWork(context);
        } finally {try {ui?.remove();} catch { /* 故障端口本身必然抛错，实际 remove 已执行。 */ }}
    });

    it('allows the actual WXT adapter to release its host after client unmount cleanup throws', async () => {
        const client = await clientPorts();
        const cleanupFailure = new Error('actual app unmount cleanup port');
        client.failCleanup(cleanupFailure);
        vi.doMock('wxt/browser', () => ({browser:{runtime:{getURL:(path:string) => `https://fixture.invalid/${path}`}}}));
        const actual = await vi.importActual<typeof import('wxt/utils/content-script-ui/shadow-root')>('wxt/utils/content-script-ui/shadow-root');
        vi.doMock('wxt/utils/content-script-ui/shadow-root', () => actual);
        const {createUserscriptContentContext} = await import('@/userscript/context');
        const ctx = createUserscriptContentContext();
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        let ui: Awaited<ReturnType<typeof actual.createShadowRootUi>> | undefined;
        try {
            ui = await (await import('@/src/platform/shadow-ui')).createVueShadowUi(ctx as never,{name:'audit49f-native-wxt-remove',hostId:'audit49f-native-wxt-remove',component:client.Panel});
            await nextTick(); await nextTick();
            expect(ui.uiContainer.querySelector('[role="dialog"]')).not.toBeNull();
            expect(() => ui!.remove()).not.toThrow();
            expect(ui.shadowHost.isConnected).toBe(false); expect(ui.uiContainer.childNodes.length).toBe(0);
            expect(client.stops[0]).toHaveBeenCalledOnce(); expect(error).toHaveBeenCalledWith('[FluentRead] Vue UI 卸载失败', cleanupFailure);
            ctx.invalidate(); expect(client.stops[0]).toHaveBeenCalledOnce();
            await client.deliverLateWork();
        } finally {try {ui?.remove();} catch {} try {ctx.invalidate();} catch {} vi.doUnmock('wxt/browser');}
    });

    it('preserves a newly mounted actual SettingsPanel owner when the older ui.mount port throws', async () => {
        const client = await clientPorts();
        const first = new Error('old ui mount owner');
        const close = vi.fn();
        let ui!: Awaited<ReturnType<typeof createShadowRootUi>>;
        let newer: unknown;
        vi.doMock('wxt/utils/content-script-ui/shadow-root', () => ({createShadowRootUi: async (ctx: unknown, options: Parameters<typeof createShadowRootUi>[1]) => {
            ui = await createShadowRootUi(ctx, options);
            const mount = ui.mount.bind(ui); ui.mount = () => {mount(); ui.remove(); mount(); newer = ui.mounted; throw first;};
            return ui;
        }}));
        try {
            await expect((await import('@/src/platform/shadow-ui')).createVueShadowUi({isInvalid:false} as never,{name:'audit49f-new-owner',hostId:'audit49f-new-owner',component:client.Panel,props:{onClose:close}})).rejects.toBe(first);
            await nextTick(); await nextTick();
            expect(ui.mounted).toBe(newer); expect(ui.shadowHost.isConnected).toBe(true); expect(client.subscribed.size).toBe(2);
            expect(client.stops).toHaveLength(4);
            for (const stop of client.stops.slice(0, 2)) expect(stop).toHaveBeenCalledOnce();
            for (const stop of client.stops.slice(2)) expect(stop).not.toHaveBeenCalled();
            ui.uiContainer.querySelector<HTMLButtonElement>('button.close')!.click(); expect(close).toHaveBeenCalledOnce();
            ui.remove(); for (const stop of client.stops) expect(stop).toHaveBeenCalledOnce(); await client.deliverLateWork();
        } finally {ui?.remove();}
    });

    it('does not remove a reentrant new SettingsPanel owner after its predecessor configureApp throws', async () => {
        const client = await clientPorts();
        const first = new Error('abandoned configure owner');
        let ui!: Awaited<ReturnType<typeof createShadowRootUi>>;
        let newer: unknown;
        let configuring = 0;
        vi.doMock('wxt/utils/content-script-ui/shadow-root', () => ({createShadowRootUi: async (ctx: unknown, options: Parameters<typeof createShadowRootUi>[1]) => ui = await createShadowRootUi(ctx, options)}));
        try {
            await expect((await import('@/src/platform/shadow-ui')).createVueShadowUi({isInvalid:false} as never,{name:'audit49f-configure-new-owner',hostId:'audit49f-configure-new-owner',component:client.Panel,configureApp(vueApp) {
                vueApp.use(client.i18n.createUiI18nPlugin());
                if (++configuring === 1) {ui.remove(); ui.mount(); newer = ui.mounted; throw first;}
            }})).rejects.toBe(first);
            await nextTick(); await nextTick();
            expect(ui.mounted).toBe(newer); expect(ui.shadowHost.isConnected).toBe(true); expect(client.subscribed.size).toBe(2);
            expect(client.stops).toHaveLength(3);
            expect(ui.uiContainer.querySelectorAll('[role="dialog"]')).toHaveLength(1); expect(client.stops[0]).toHaveBeenCalledOnce();
            for (const stop of client.stops.slice(1)) expect(stop).not.toHaveBeenCalled();
            ui.remove(); for (const stop of client.stops) expect(stop).toHaveBeenCalledOnce(); await client.deliverLateWork();
        } finally {ui?.remove();}
    });

    it('does not acquire observers from Vue mounted hooks queued by a failed real SettingsPanel fragment when the UI retries', async () => {
        const client = await clientPorts();
        const {defineComponent, h, withDirectives, resolveDirective} = await import('vue');
        const first = new Error('fragment sibling insertion failure');
        const close = vi.fn();
        const Panel = defineComponent({setup: () => () => [withDirectives(h(client.Panel, {onClose:close}), [[resolveDirective('ui-i18n')!]]), h('span', {'data-audit-failure-sibling':'true'})]});
        let ui!: Awaited<ReturnType<typeof createShadowRootUi>>;
        let fail = true;
        vi.doMock('wxt/utils/content-script-ui/shadow-root', () => ({createShadowRootUi: async (ctx: unknown, options: Parameters<typeof createShadowRootUi>[1]) => {
            ui = await createShadowRootUi(ctx, options);
            const insert = ui.uiContainer.insertBefore.bind(ui.uiContainer);
            ui.uiContainer.insertBefore = ((node: Node, reference: Node | null) => {
                const value = insert(node, reference);
                if (fail && node instanceof Element && node.hasAttribute('data-audit-failure-sibling')) {fail = false; throw first;}
                return value;
            }) as typeof ui.uiContainer.insertBefore;
            return ui;
        }}));
        try {
            await expect((await import('@/src/platform/shadow-ui')).createVueShadowUi({isInvalid:false} as never,{name:'audit49f-late-directive',hostId:'audit49f-late-directive',component:Panel})).rejects.toBe(first);
            expect(ui.shadowHost.isConnected).toBe(false); expect(ui.uiContainer.childNodes.length).toBe(0);
            expect(client.subscribed.size).toBe(0); for (const stop of client.stops) expect(stop).toHaveBeenCalledOnce();
            expect(client.observers).toHaveLength(0);
            ui.mount(); await nextTick(); await nextTick();
            // 重试的真实 Vue render 会 flush 旧 fragment 已排队的 mounted hook；旧插件不能再获取资源。
            expect(client.observers).toHaveLength(1); expect(client.subscribed.size).toBe(2);
            expect(ui.uiContainer.querySelectorAll('[role="dialog"]')).toHaveLength(1);
            ui.uiContainer.querySelector<HTMLButtonElement>('button.close')!.click(); expect(close).toHaveBeenCalledOnce();
            ui.remove(); for (const stop of client.stops) expect(stop).toHaveBeenCalledOnce(); await client.deliverLateWork();
        } finally {ui?.remove();}
    });

    it('releases failed directive observation through the actual client error handler and later normal disposal', async () => {
        const first = new Error('directive observation failure');
        const handled = vi.fn();
        const client = await clientPorts(first);
        const {defineComponent, h, withDirectives, resolveDirective} = await import('vue');
        const Panel = defineComponent({setup: () => () => withDirectives(h(client.Panel), [[resolveDirective('ui-i18n')!]])});
        let ui!: Awaited<ReturnType<typeof createShadowRootUi>>;
        vi.doMock('wxt/utils/content-script-ui/shadow-root', () => ({createShadowRootUi: async (ctx: unknown, options: Parameters<typeof createShadowRootUi>[1]) => ui = await createShadowRootUi(ctx, options)}));
        try {
            await (await import('@/src/platform/shadow-ui')).createVueShadowUi({isInvalid:false} as never,{name:'audit49f-directive-failure',hostId:'audit49f-directive-failure',component:Panel,configureApp(vueApp) {
                vueApp.config.errorHandler = handled;
                vueApp.use(client.i18n.createUiI18nPlugin());
            }});
            expect(handled).toHaveBeenCalledOnce(); expect(handled.mock.calls[0][0]).toBe(first);
            expect(ui.shadowHost.isConnected).toBe(true); expect(ui.uiContainer.querySelector('[role="dialog"]')).not.toBeNull();
            expect(client.subscribed.size).toBe(2);
            expect(client.observers).toHaveLength(1); expect(client.observers[0].active).toBe(false); expect(client.observers[0].disconnect).toHaveBeenCalledOnce();
            ui.remove(); expect(ui.shadowHost.isConnected).toBe(false); expect(ui.uiContainer.childNodes.length).toBe(0);
            expect(client.stops[0]).toHaveBeenCalledOnce(); await client.deliverLateWork();
        } finally {ui?.remove();}
    });

    it('releases real document and directive observers, queued watches and late callbacks on normal client unmount exactly once', async () => {
        const client = await clientPorts();
        const {defineComponent, h, withDirectives, resolveDirective} = await import('vue');
        const close = vi.fn();
        // 使用真实 SettingsPanel 根 DOM 和真实插件指令，不用空组件替代渲染。
        const Panel = defineComponent({setup: () => () => withDirectives(h(client.Panel, {onClose:close}), [[resolveDirective('ui-i18n')!]])});
        let ui!: Awaited<ReturnType<typeof createShadowRootUi>>;
        let context!: ReturnType<typeof client.i18n.useUiI18n>;
        vi.doMock('wxt/utils/content-script-ui/shadow-root', () => ({createShadowRootUi: async (ctx: unknown, options: Parameters<typeof createShadowRootUi>[1]) => ui = await createShadowRootUi(ctx, options)}));
        try {
            await (await import('@/src/platform/shadow-ui')).createVueShadowUi({isInvalid:false} as never,{name:'audit49f-normal-dispose',hostId:'audit49f-normal-dispose',component:Panel,configureApp(vueApp) {
                vueApp.use(client.i18n.createUiI18nPlugin({documentRoot:client.fixture})); context = vueApp.runWithContext(client.i18n.useUiI18n);
            }});
            await nextTick(); await nextTick(); expect(client.observers).toHaveLength(2);
            ui.uiContainer.querySelector<HTMLButtonElement>('button.close')!.click(); expect(close).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBeGreaterThan(0);
            const ownedApp = (ui.mounted as {app: App}).app;
            ui.remove(); ownedApp.unmount();
            expect(client.stops[0]).toHaveBeenCalledOnce(); expect(ui.shadowHost.isConnected).toBe(false); expect(ui.uiContainer.querySelector('[role="dialog"]')).toBeNull();
            for (const observer of client.observers) expect(observer.disconnect).toHaveBeenCalledOnce();
            await client.deliverLateWork(context);
        } finally {ui?.remove();}
    });
});

describe('49F bounded legacy text through real language bundles', () => {
    it.each(['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const)('preserves all 512 nested causes in %s without growing the JS call stack', async language => {
        const {registerAllUiLanguageBundles} = await import('./helpers/uiLanguageBundles');
        const {translateLegacyText} = await import('@/src/core/i18n');
        registerAllUiLanguageBundles();
        const cause = translateLegacyText('未知原因', language);
        const prefix = translateLegacyText('图片翻译失败：__controlled_cause__', language).replace('__controlled_cause__', '');
        const input = `  ${'图片翻译失败：'.repeat(512)}未知原因\n`;
        expect(translateLegacyText(input, language)).toBe(`  ${prefix.repeat(512)}${cause}\n`);
    });

    it('keeps the captured text when a damaged resource declares its entire match as a localized capture', async () => {
        const {registerUiLanguageBundle, translateLegacyText} = await import('@/src/core/i18n');
        registerUiLanguageBundle('en-US', {messages: {}, legacyText: {}, legacyPatterns: {early: [['^(.+)$', 'Failure: {1}', [1]]], late: []}});
        expect(translateLegacyText('controlled cause', 'en-US')).toBe('Failure: controlled cause');
    });
});

describe('49F actual pinned-data virtual catalog consumer', () => {
    async function loadCatalogs() {
        vi.stubEnv('FLUENTREAD_USERSCRIPT_GREASYFORK_SOURCE', '1');
        vi.stubEnv('FLUENTREAD_USERSCRIPT_VENDOR_URL', 'https://fixture.invalid/vendor.js');
        vi.stubEnv('FLUENTREAD_USERSCRIPT_DATA_URL', 'https://fixture.invalid/data.js');
        const {createUserscriptCatalogCompressionPlugin} = await import('@/userscript/vite.config');
        const {transformWithEsbuild} = await import('vite');
        const plugin = createUserscriptCatalogCompressionPlugin();
        const realm = createContext({});
        runInContext(readFileSync(resolve(process.cwd(), 'userscript/resources/fluentread-data.v1.js'), 'utf8'), realm, {timeout: 5_000});
        const original = realm.__FLUENTREAD_USERSCRIPT_DATA__.siteCatalogs;
        const originalSnapshot = JSON.stringify(original);
        const catalogs: Record<string, any> = {};
        for (const name of ['established', 'websites', 'profiles']) {
            const resolver = typeof plugin.resolveId === 'function' ? plugin.resolveId : plugin.resolveId!.handler;
            const loader = typeof plugin.load === 'function' ? plugin.load : plugin.load!.handler;
            const id = await Reflect.apply(resolver, {}, [`./catalog/${name}.json`, resolve(process.cwd(), 'src/core/site-adaptation/pack.ts')]);
            const module = await Reflect.apply(loader, {}, [id]);
            const compiled = await transformWithEsbuild(module, `${name}.js`, {format: 'cjs', target: 'es2018'});
            realm.module = {exports: {}};
            runInContext(`(function(module, exports) {${compiled.code}\n})(module, module.exports);`, realm, {timeout: 5_000});
            catalogs[name] = realm.module.exports.default;
        }
        return {catalogs, original, originalSnapshot};
    }

    afterEach(() => vi.unstubAllEnvs());

    it('reconciles authoritative established rules without mutating pinned data and reuses every unchanged rule', async () => {
        const {catalogs, original, originalSnapshot} = await loadCatalogs();
        const originalLength = original.established.length;
        expect(originalLength).toBeGreaterThan(0);
        for (const name of ['established', 'websites', 'profiles']) {
            const authoritative = JSON.parse(readFileSync(resolve(process.cwd(), `src/core/site-adaptation/catalog/${name}.json`), 'utf8'));
            expect(catalogs[name]).toEqual(authoritative);
            // 完全未变的目录保留整体身份；更新目录仍复用每条未变的固定资源规则。
            if (JSON.stringify(authoritative) === JSON.stringify(original[name])) expect(catalogs[name]).toBe(original[name]);
            else expect(catalogs[name]).not.toBe(original[name]);
            if (Array.isArray(authoritative)) for (const rule of original[name]) {
                const expected = authoritative.find((current: any) => current.id === rule.id);
                const actual = catalogs[name].find((current: any) => current.id === rule.id);
                if (JSON.stringify(expected) === JSON.stringify(rule)) expect(actual).toBe(rule);
                else {expect(actual).not.toBe(rule);expect(actual).toEqual(expected);}
            }
        }
        const github = catalogs.established.find((rule: any) => rule.id === 'github');
        expect(github.content.flatMap((entry: any) => entry.css)).toContain('a[data-testid="issue-listitem-title-link"]');
        expect(github.protect).toContain('[data-testid="issues-list-surface"] [class*="Description-module__container"]');
        expect(original.established.find((rule: any) => rule.id === 'github').protect)
            .toContain('[data-testid="issues-list-surface"] [class*="Description-module__container"]');
        expect(JSON.stringify(original)).toBe(originalSnapshot);
        expect(original.established).toHaveLength(originalLength);
    });

    it.each(['https://meet.google.com/fixture', 'https://github.com/fixture'] as const)('excludes native captions or code through the actual virtual catalog and real engine at %s', async url => {
        const {catalogs} = await loadCatalogs();
        const {compileSiteRulePack} = await import('@/src/core/site-adaptation/compiler');
        const {TranslationCandidateCore} = await import('@/src/core/translation/engine');
        const pack = {version: 1 as const, profiles: catalogs.profiles, rules: [...catalogs.established, ...catalogs.websites]};
        document.body.innerHTML = '<p id="caption" data-caption-text>Native subtitle text.</p><div class="markdown-body"><p id="code" class="blob-code">const nativeCode = 42;</p><p id="prose">An ordinary article paragraph.</p></div>';
        const engine = new TranslationCandidateCore({url: new URL(url), adapters: compileSiteRulePack(pack)});
        const ids = engine.discover(document).map(candidate => candidate.element.id);
        expect(ids).toContain('prose');
        expect(ids).not.toContain(url.includes('meet.google.com') ? 'caption' : 'code');
    });
});

describe('49F actual userscript main module lifecycle ownership', () => {
    async function mainFixture(startFailure?: Error, cleanupFailure?: Error, contentMessages = false) {
        delete globalThis.__fluentReadUserscriptBootstrapped;
        vi.stubGlobal('__FLUENTREAD_FULL_OPTIONS__', false);
        vi.stubGlobal('defineContentScript', (entry: unknown) => entry);
        const originalShadow = Element.prototype.attachShadow;
        const historyPort = {pushState: vi.fn(), replaceState: vi.fn()};
        vi.stubGlobal('history', historyPort);
        const originalPush = historyPort.pushState;
        const originalReplace = historyPort.replaceState;
        const menus = new Map<string, () => void>();
        let realApp: Awaited<ReturnType<typeof import('@/src/services/config/application')['createConfigApplication']>> | undefined;
        let storedConfig: () => unknown = () => undefined;
        let pendingConfigWrite: {gate: Promise<void>; entered: () => void} | undefined;
        const blockNextConfigWrite = () => {const gate = deferred<void>(), started = deferred<void>(); pendingConfigWrite = {gate: gate.promise, entered: started.resolve}; return {...gate, entered: started.promise};};
        if (contentMessages) {
            const {createConfigApplication} = await import('@/src/services/config/application');
            const {sanitizeConfigCredentials, extractConfigCredentials} = await import('@/src/core/config/credentials');
            const records = new Map<string, unknown>([['local:config', {...sanitizeConfigCredentials(ports.config), __fluentConfigRevision: 1}], ['local:credentials', extractConfigCredentials(ports.config)]]);
            const watchers = new Map<string, Set<(value: unknown) => void>>();
            const notify = (key: string) => {for (const callback of watchers.get(key) ?? []) callback(structuredClone(records.get(key) ?? null));};
            const storage = {
                writeOwner: true,
                getItem: async <T>(key: string) => structuredClone(records.get(key) ?? null) as T | null,
                setItem: async <T>(key: string, value: T) => {records.set(key, structuredClone(value)); notify(key);},
                setItems: async (entries: Map<string, unknown>, removeKeys: string[] = []) => {if (entries.has('local:config') && pendingConfigWrite) {const wait = pendingConfigWrite; pendingConfigWrite = undefined; wait.entered(); await wait.gate;} for (const [key, value] of entries) records.set(key, structuredClone(value)); for (const key of removeKeys) records.delete(key); for (const key of [...entries.keys(), ...removeKeys]) notify(key);},
                removeItem: async (key: string) => {records.delete(key); notify(key);},
                watch: (key: string, callback: (value: any) => void) => {const set = watchers.get(key) ?? new Set(); set.add(callback); watchers.set(key, set); return () => set.delete(callback);},
            };
            realApp = createConfigApplication({storage, trustedContext: true}); await realApp.start();
            ports.config = realApp.config;
            const app = realApp;
            vi.doMock('@/src/services/config/store', () => app);
            storedConfig = () => records.get('local:config');
        }
        const values = new Map<string, unknown>([['local:config', JSON.stringify(ports.config)]]);
        vi.stubGlobal('GM', {
            getValue: (key: string, fallback: unknown) => values.has(key) ? values.get(key) : fallback,
            setValue: (key: string, value: unknown) => {values.set(key, value);},
            listValues: () => [...values.keys()],
            registerMenuCommand: (label: string, callback: () => void) => {menus.set(label, callback);},
        });
        const events = new Map<string, Set<EventListenerOrEventListenerObject>>();
        const nativeAdd = window.addEventListener.bind(window);
        const nativeRemove = window.removeEventListener.bind(window);
        vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
            let set = events.get(type); if (!set) events.set(type, set = new Set()); set.add(listener); nativeAdd(type, listener, options);
        });
        vi.spyOn(window, 'removeEventListener').mockImplementation((type, listener, options) => {events.get(type)?.delete(listener); nativeRemove(type, listener, options);});
        const closes = vi.fn();
        const notice = vi.fn();
        if (contentMessages) vi.doMock('@/src/features/page-notice/public', () => ({showPageNotice: notice, dismissPageNotice: vi.fn(), sendErrorMessage: vi.fn()}));
        const opens = vi.fn().mockResolvedValue(undefined);
        vi.doMock('@/userscript/settings', () => ({openUserscriptSettings:opens,closeUserscriptSettings:closes}));
        const sentinel = (await import('@/userscript/browser')).UNHANDLED_RUNTIME_MESSAGE;
        const platform = vi.fn(async (message: any) => message?.type === 'audit49f-platform-owned' ? {success:true} : sentinel);
        vi.doMock('@/userscript/platform', () => ({createPlatformMessageHandler: () => platform}));
        const contentActions = {mountFloatingBall: vi.fn(), unmountFloatingBall: vi.fn(), mountSelectionTranslator: vi.fn(), unmountSelectionTranslator: vi.fn()};
        vi.doMock('@/src/app/content/features', () => ({isFullPageTranslationActive: () => false,restoreOriginalContent:vi.fn(),autoTranslateEnglishPage:vi.fn(), ...contentActions}));
        const cleanup = vi.fn(() => {if (cleanupFailure) throw cleanupFailure;});
        const laterCleanup = vi.fn();
        let context!: import('@/userscript/context').UserscriptContentContext;
        let loaded = false;
        const start = vi.fn(async (ctx: typeof context) => {
            loaded = true; context = ctx;
            ctx.onInvalidated(cleanup); ctx.onInvalidated(laterCleanup);
            if (contentMessages) {
                const {createContentRuntimeMessageHandler} = await import('@/src/app/content/messageRuntime');
                const handler = createContentRuntimeMessageHandler(ctx as never, {isSiteDisabled: () => false, updateSiteDisabled: async () => undefined});
                adapter.runtime.onMessage.addListener(handler as never);
                ctx.onInvalidated(() => adapter.runtime.onMessage.removeListener(handler as never));
            }
            if (startFailure) throw startFailure;
        });
        // 真实 entrypoints/content 仍经 defineContentScript 加载；只控制它调用的内容应用启动端口。
        vi.doMock('@/src/app/content/runtime', () => ({startContentApp:start}));
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const adapter = (await import('@/userscript/browser')).default;
        await import('@/userscript/main');
        try { await vi.waitFor(() => expect(start).toHaveBeenCalledOnce(), {timeout:1500}); } catch { throw new Error(`main entry not loaded: ${errors.mock.calls.map(call => call.map(value => value instanceof Error ? value.stack : String(value)).join(' ')).join(' | ')}`); }
        expect(loaded).toBe(true); // 明确区分入口加载成功与 runtime 故障。
        if (contentMessages) await start.mock.results[0]?.value;
        await new Promise(resolve => setTimeout(resolve, 0));
        const bridge = await import('@/src/platform/shadow-ui/pageBridgeCore');
        return {context, loaded, start, cleanup, laterCleanup, errors, adapter, closes, opens, events, bridge, platform, menus, contentActions, realApp, storedConfig, blockNextConfigWrite, notice,
            pagehide(persisted: boolean, isTrusted = true) {
                const listeners = [...(events.get('pagehide') ?? [])];
                for (const listener of listeners) {
                    const event = {type:'pagehide',persisted,isTrusted} as PageTransitionEvent;
                    if (typeof listener === 'function') listener(event); else listener.handleEvent(event);
                }
            },
            assertBridgeDisposed() {
                expect(Element.prototype.attachShadow).toBe(originalShadow);
                expect(historyPort.pushState).toBe(originalPush); expect(historyPort.replaceState).toBe(originalReplace);
                expect((window as any)[bridge.SHADOW_BRIDGE_STATE_KEY]).toBeUndefined();
                expect((window as any)[bridge.SHADOW_BRIDGE_LIFECYCLE_STATE_KEY]).toBeUndefined();
                for (const type of ['popstate','hashchange','pagehide','focus','fluentread-userscript-open-settings','fluentread-userscript-close-settings']) expect(events.get(type)?.size ?? 0).toBe(0);
            },
            disposeFixture() {
                // 原入口失败的 baseline 也不能把桥补丁或本地端口留给下一例。
                try {context?.invalidate();} catch {}
                (window as any)[bridge.SHADOW_BRIDGE_LIFECYCLE_STATE_KEY]?.dispose();
                for (const [type, listeners] of events) for (const listener of listeners) nativeRemove(type, listener);
                delete globalThis.__fluentReadUserscriptBootstrapped;
            },
        };
    }
    afterEach(() => {
        for (const path of ['@/userscript/settings','@/userscript/platform','@/src/app/content/features','@/src/app/content/runtime','@/src/features/page-notice/public']) vi.doUnmock(path);
        vi.doMock('@/src/services/config/store', () => ({config: ports.config, configReady: ports.ready, saveConfig: ports.save, subscribeConfig: ports.subscribe, requestConfigPatch: ports.patch, getConfigRevision: () => 0}));
    });

    it('userscript 菜单暂停再启用，真实配置权威通知并持久化且不改变功能偏好', async () => {
        const fixture = await mainFixture(undefined, undefined, true);
        const app = fixture.realApp!;
        try {
            await app.requestConfigPatch({on: true, disableFloatingBall: false, selectionTranslatorMode: 'bilingual', translationProgressPanelEnabled: true});
            const observed: boolean[] = [];
            const unsubscribe = app.subscribeConfig(next => {observed.push(next.on);});
            const menu = fixture.menus.get('流畅阅读：启用 / 暂停')!;
            expect(menu).toBeTypeOf('function');
            menu();
            await vi.waitFor(() => expect(fixture.storedConfig()).toMatchObject({on: false}));
            expect(app.config).toMatchObject({on: false, disableFloatingBall: false, selectionTranslatorMode: 'bilingual', disableSelectionTranslator: false, translationProgressPanelEnabled: true});
            menu();
            await vi.waitFor(() => expect(fixture.storedConfig()).toMatchObject({on: true}));
            expect(fixture.storedConfig()).toMatchObject({on: true, disableFloatingBall: false, selectionTranslatorMode: 'bilingual', translationProgressPanelEnabled: true});
            expect(observed).toContain(false); expect(observed.at(-1)).toBe(true);
            unsubscribe();
        } finally {await app.flushConfigHistory(); fixture.disposeFixture();}
    });

    it('userscript 菜单快速暂停再启用，迟到保存不覆盖新状态或功能偏好', async () => {
        const fixture = await mainFixture(undefined, undefined, true); const app = fixture.realApp!;
        try {
            await app.requestConfigPatch({on: true, disableFloatingBall: false, selectionTranslatorMode: 'bilingual'});
            const gate = fixture.blockNextConfigWrite(), menu = fixture.menus.get('流畅阅读：启用 / 暂停')!;
            menu(); await gate.entered; expect(app.config.on).toBe(false);
            menu(); expect(app.config.on).toBe(true);
            gate.resolve(); await app.waitForConfigPersistenceQueue();
            await vi.waitFor(() => expect(fixture.storedConfig()).toMatchObject({on: true, disableFloatingBall: false, selectionTranslatorMode: 'bilingual'}));
            expect(app.config).toMatchObject({on: true, disableFloatingBall: false, selectionTranslatorMode: 'bilingual'});
        } finally {await app.flushConfigHistory(); fixture.disposeFixture();}
    });

    it('旧暂停请求迟到失败时不覆盖或误报之后的启用', async () => {
        const fixture = await mainFixture(undefined, undefined, true); const app = fixture.realApp!;
        try {
            await app.requestConfigPatch({on: true, disableFloatingBall: false, selectionTranslatorMode: 'bilingual'});
            const priorRevision = (fixture.storedConfig() as {__fluentConfigRevision: number}).__fluentConfigRevision;
            const gate = fixture.blockNextConfigWrite(), menu = fixture.menus.get('流畅阅读：启用 / 暂停')!;
            menu(); await gate.entered; menu(); expect(app.config.on).toBe(true);
            gate.reject(new Error('obsolete-private-error'));
            await app.waitForConfigPersistenceQueue().catch(() => undefined);
            await vi.waitFor(() => {
                expect(fixture.storedConfig()).toMatchObject({on: true});
                expect((fixture.storedConfig() as {__fluentConfigRevision: number}).__fluentConfigRevision).toBeGreaterThan(priorRevision);
            });
            expect(app.config.on).toBe(true); expect(fixture.notice).not.toHaveBeenCalled();
            expect(fixture.errors).not.toHaveBeenCalledWith('[FluentRead userscript] 启停设置结果未确认，请检查设置。');
        } finally {await app.flushConfigHistory(); fixture.disposeFixture();}
    });

    it('userscript 菜单保存失败后回读权威状态并给出不含原始异常的错误', async () => {
        const fixture = await mainFixture(undefined, undefined, true); const app = fixture.realApp!;
        try {
            await app.requestConfigPatch({on: true, disableFloatingBall: false, selectionTranslatorMode: 'bilingual'});
            const gate = fixture.blockNextConfigWrite(); fixture.menus.get('流畅阅读：启用 / 暂停')!();
            await gate.entered; expect(app.config.on).toBe(false);
            gate.reject(new Error('private-storage-detail'));
            await vi.waitFor(() => expect(fixture.errors).toHaveBeenCalledWith('[FluentRead userscript] 启停设置结果未确认，请检查设置。'));
            expect(app.config).toMatchObject({on: true, disableFloatingBall: false, selectionTranslatorMode: 'bilingual'});
            expect(fixture.storedConfig()).toMatchObject({on: true});
            expect(fixture.notice).toHaveBeenCalledWith(expect.any(String), 'error', {key: 'userscript-toggle'});
            expect(JSON.stringify(fixture.errors.mock.calls)).not.toContain('private-storage-detail');
        } finally {await app.flushConfigHistory(); fixture.disposeFixture();}
    });

    it.each([false, true])('cleans the actual main bridge and listeners on trusted non-BFcache pagehide with invalidation failure=%s', async throws => {
        const fixture = await mainFixture(undefined, throws ? new Error('controlled invalidate callback') : undefined);
        try {
            expect(globalThis.__fluentReadUserscriptBootstrapped).toBe(true);
            expect(fixture.context.isInvalid).toBe(false);
            expect(() => fixture.pagehide(false)).not.toThrow();
            expect(fixture.context.isInvalid).toBe(true); fixture.assertBridgeDisposed();
            expect(fixture.cleanup).toHaveBeenCalledOnce(); expect(fixture.laterCleanup).toHaveBeenCalledOnce(); expect(fixture.closes).toHaveBeenCalledOnce();
            // 离页仍保留 handler，供同页最后一次计数 flush 使用。
            expect(await fixture.adapter.runtime.sendMessage({type:'audit49f-platform-owned'})).toEqual({success:true});
            fixture.pagehide(false); fixture.context.invalidate();
            expect(fixture.cleanup).toHaveBeenCalledOnce(); expect(fixture.closes).toHaveBeenCalledOnce();
        } finally {fixture.disposeFixture();}
    });

    it('keeps the real main runtime on persisted BFcache or untrusted pagehide, then disposes on true page exit', async () => {
        const fixture = await mainFixture();
        try {
            fixture.pagehide(true); fixture.pagehide(false, false);
            expect(fixture.context.isInvalid).toBe(false); expect(fixture.closes).not.toHaveBeenCalled();
            expect((window as any)[fixture.bridge.SHADOW_BRIDGE_LIFECYCLE_STATE_KEY]).toBeDefined();
            await import('@/userscript/main'); expect(fixture.start).toHaveBeenCalledOnce();
            fixture.pagehide(false); fixture.assertBridgeDisposed(); expect(fixture.cleanup).toHaveBeenCalledOnce();
        } finally {fixture.disposeFixture();}
    });

    it.each([false, true])('releases boot ownership after real content start fails with cleanup failure=%s and permits retry', async throws => {
        const initial = new Error('controlled original content startup failure');
        const fixture = await mainFixture(initial, throws ? new Error('controlled startup cleanup failure') : undefined);
        try {
            expect(fixture.loaded).toBe(true); fixture.assertBridgeDisposed();
            expect(globalThis.__fluentReadUserscriptBootstrapped).toBe(false);
            expect(fixture.cleanup).toHaveBeenCalledOnce(); expect(fixture.laterCleanup).toHaveBeenCalledOnce();
            expect(fixture.errors).toHaveBeenCalledWith('[FluentRead userscript] 初始化失败', initial);
            expect(await fixture.adapter.runtime.sendMessage({type:'audit49f-platform-owned'})).toBeUndefined();
            fixture.start.mockImplementationOnce(async ctx => {ctx.onInvalidated(fixture.laterCleanup);});
            vi.resetModules();
            await import('@/userscript/main');
            await vi.waitFor(() => expect(fixture.start).toHaveBeenCalledTimes(2), {timeout:1500});
            expect(globalThis.__fluentReadUserscriptBootstrapped).toBe(true);
            await new Promise(resolve => setTimeout(resolve, 0));
            fixture.pagehide(false); fixture.assertBridgeDisposed();
            expect(fixture.cleanup).toHaveBeenCalledOnce(); expect(fixture.laterCleanup).toHaveBeenCalledTimes(2);
        } finally {fixture.disposeFixture();}
    });
});

// 独立的 owned-root 准入夹具。实际 Vue 客户端模板、配置模型、i18n context 和扫描器保持真实；
// 存储传输、MutationObserver delivery 及无关颜色控件是外部端口，不代替用户名称保存/选择算法。
describe('49F owned settings i18n client admission', () => {
    async function ownedStyleClient(initialStyle?: number) {
        vi.doUnmock('@/src/ui/i18n');
        const bundleGates = new Map<string, ReturnType<typeof deferred<boolean>>>();
        vi.doMock('@/src/platform/i18n/uiLanguageBundles', () => ({ensureUiLanguageBundle: (language: string) => bundleGates.get(language)?.promise ?? Promise.resolve(true)}));
        const Vue = await import('vue');
        const {Config} = await import('@/src/core/config/model');
        const appearance = await import('@/src/core/config/translationAppearance');
        const core = await import('@/src/core/i18n');
        const {registerAllUiLanguageBundles} = await import('./helpers/uiLanguageBundles');
        registerAllUiLanguageBundles();
        const i18n = await import('@/src/ui/i18n');
        ports.config.uiLanguage = 'zh-CN';
        const subscriptions = new Set<(config: any) => void>(), callbacks: Array<(config: any) => void> = [], stops: ReturnType<typeof vi.fn>[] = [];
        ports.subscribe.mockImplementation(callback => {
            subscriptions.add(callback);callbacks.push(callback);
            const stop = vi.fn(() => subscriptions.delete(callback));stops.push(stop);return stop;
        });
        ports.patch.mockImplementation(async value => {
            Object.assign(ports.config, value);
            for (const callback of subscriptions) callback(ports.config);
        });
        const observers: Array<{callback: MutationCallback; root?: Node; active: boolean; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>}> = [];
        vi.stubGlobal('MutationObserver', class {
            root?: Node;active = false;
            observe = vi.fn((root: Node) => {this.root = root;this.active = true;});
            disconnect = vi.fn(() => {this.active = false;});
            constructor(public callback: MutationCallback) {observers.push(this);}
        });
        const colorPort = Vue.defineComponent({props: ['modelValue', 'fieldId', 'label'], emits:['update:modelValue'], setup: (props,{emit}) => () => Vue.h('input', {'data-color-port': props.fieldId, 'aria-label':props.label, value:props.modelValue, onInput:(event:Event)=>emit('update:modelValue',(event.target as HTMLInputElement).value)})});
        vi.doMock('@/src/features/settings/ui/components/TranslationColorField.vue', () => ({default: colorPort}));
        const {default: Style} = await import('@/src/features/settings/ui/TranslationStyleSettings.vue');
        const config = Vue.reactive(new Config());
        if (initialStyle !== undefined) config.style = initialStyle;
        const beforeMetadata = {lang: document.documentElement.getAttribute('lang'), title: document.title};
        document.documentElement.lang = 'fixture-host-language';document.title = 'Synthetic host title';
        const outside = document.createElement('aside');outside.innerHTML = '<p title="设置" aria-label="设置">设置</p>';document.body.append(outside);
        const shadowHost = document.createElement('div');document.body.append(shadowHost);
        const shadow = shadowHost.attachShadow({mode: 'closed'}), root = document.createElement('main'), sibling = document.createElement('aside');
        sibling.innerHTML = '<p title="设置">设置</p>';shadow.append(root, sibling);
        const shown = Vue.ref(true), errors: unknown[] = [], Other = {render: () => null};
        const renderer = Vue.createRenderer<Node, Element>({
            createElement: tag => document.createElement(tag), createText: text => document.createTextNode(text), createComment: text => document.createComment(text),
            insert: (node, parent, anchor) => parent.insertBefore(node, anchor ?? null), remove: node => node.parentNode?.removeChild(node),
            setText: (node, value) => {node.nodeValue = value;}, setElementText: (element, value) => {element.textContent = value;},
            parentNode: node => node.parentNode as Element | null, nextSibling: node => node.nextSibling,
            querySelector: selector => document.querySelector(selector),
            patchProp: (element, key, _before, value) => {
                if (key.startsWith('onUpdate:')) return;
                if (/^on[A-Z]/u.test(key)) {
                    const target = element as Element & {__ownedEvents?: Map<string, EventListener>};target.__ownedEvents ??= new Map();
                    const name = key.slice(2).toLowerCase(), previous = target.__ownedEvents.get(name);if (previous) element.removeEventListener(name, previous);
                    if (value) {const listener: EventListener = event => {for (const handler of Array.isArray(value) ? value : [value]) handler(event);};target.__ownedEvents.set(name, listener);element.addEventListener(name, listener);}
                } else if (key === 'value') (element as HTMLInputElement).value = value ?? '';
                else if (key === 'style' && value && typeof value === 'object') {
                    const style = (element as HTMLElement).style;
                    for (const property of Object.keys(_before ?? {})) if (!(property in value)) style.removeProperty(property);
                    Object.assign(style, value);
                }
                else if (key.startsWith('aria-') && value != null) element.setAttribute(key, String(value));
                else if (value == null || value === false) element.removeAttribute(key);
                else element.setAttribute(key, value === true ? '' : String(value));
            }, setScopeId: (element, id) => element.setAttribute(id, ''), insertStaticContent: (content, parent, anchor) => {
                const fragment = document.createElement('div');fragment.innerHTML = content;
                const first = fragment.firstChild!, last = fragment.lastChild!;
                for (const child of [...fragment.childNodes]) parent.insertBefore(child, anchor);return [first, last];
            },
        });
        const Parent = Vue.defineComponent({setup: () => () => [
            Vue.h('p', {'data-owned-legacy': '', title: '设置', 'aria-label': '设置'}, '设置'),
            Vue.h('pre', {title: '设置', 'data-user-pre': ''}, '设置'),
            Vue.h('p', {'data-i18n-ignore': '', title: '设置', 'data-user-ignore': ''}, '设置'),
            Vue.h(Vue.KeepAlive, null, {default: () => shown.value ? Vue.h(Style, {config}) : Vue.h(Other)}),
            Vue.h(Vue.Teleport, {to: outside}, Vue.h('span', {'data-outside-teleport': '', title: '设置'}, '设置')),
        ]});
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
        const ownedApp = renderer.createApp(Parent);ownedApp.config.errorHandler = error => errors.push(error);ownedApp.config.warnHandler = () => undefined;
        ownedApp.use(i18n.createUiI18nPlugin({documentRoot: null, uiRoot: root}));
        const context = ownedApp.runWithContext(i18n.useUiI18n);
        ownedApp.mount(root);
        let mounted = true;
        const settle = async () => {for (let index = 0; index < 4; index++) {await Vue.nextTick();await Promise.resolve();await vi.advanceTimersByTimeAsync(0);}};
        const notify = () => {for (const observer of observers) observer.callback([{type: 'childList', target: root, addedNodes: []} as unknown as MutationRecord], observer as unknown as MutationObserver);};
        const click = async (selector: string) => {const element = root.querySelector(selector);expect(element, selector).not.toBeNull();element!.dispatchEvent(Object.assign(new Event('click', {bubbles: true}), {_vts: Date.now() + 1}));await settle();};
        const input = async (selector: string, value: string) => {const element = root.querySelector<HTMLInputElement>(selector);expect(element, selector).not.toBeNull();element!.value = value;element!.dispatchEvent(new Event('input', {bubbles: true}));await settle();};
        const language = async (value: import('@/src/core/i18n').UiLanguage) => {expect(await context.setLanguage(value)).toBe(true);await settle();};
        const unmount = () => {if (mounted) {ownedApp.unmount();mounted = false;}};
        await settle();
        return {root, config, context, core, preset: appearance.getTranslationStylePreset, bundleGates, callbacks, observers, subscriptions, stops, shown, outside, sibling, errors, settle, notify, click, input, language, unmount,
            async saveName(name: string) {await click('.translation-appearance-disclosure');await input('#translation-profile-name', name);await click('.translation-profile-save');},
            async close() {
                unmount();for (const gate of bundleGates.values()) gate.resolve(true);await settle();shadowHost.remove();outside.remove();
                if (beforeMetadata.lang == null) document.documentElement.removeAttribute('lang');else document.documentElement.setAttribute('lang', beforeMetadata.lang);
                document.title = beforeMetadata.title;vi.useRealTimers();vi.doUnmock('@/src/platform/i18n/uiLanguageBundles');vi.doUnmock('@/src/features/settings/ui/components/TranslationColorField.vue');
                vi.doMock('@/src/ui/i18n', () => ({useUiI18n: () => ({translateLegacy: (text: string) => text,t:(key:string)=>key}),createUiI18nPlugin:()=>({install(){}})}));
            },
        };
    }

    it('keeps colored styles in a separate category between Text and Lines and restores their selection', async () => {
        const client = await ownedStyleClient(54);
        let savedStyle: number;
        try {
            expect([...client.root.querySelectorAll('.translation-style-categories button')].map(button => button.textContent!.trim()))
                .toEqual(['文字', '颜色', '线条', '标记', '卡片', '趣味']);
            expect(client.root.querySelector('.translation-style-categories button[aria-checked="true"]')!.textContent!.trim()).toBe('颜色');
            expect([...client.root.querySelectorAll('.translation-style-card')].map(card => Number(card.getAttribute('data-style-value'))))
                .toEqual([49, 50, 51, 52, 53, 54, 55, 56, 57, 40, 41, 42]);
            expect(client.root.querySelector('[data-style-value="54"]')!.getAttribute('aria-checked')).toBe('true');
            await client.click('.translation-style-categories button[data-option-index="0"]');
            expect(client.root.querySelectorAll('.translation-style-card')).toHaveLength(12);
            expect(client.root.querySelector('[data-style-value="49"]')).toBeNull();
            expect(client.config.style).toBe(54);
            await client.click('.translation-style-categories button[data-option-index="1"]');
            await client.click('[data-style-value="49"]');
            expect(client.config.style).toBe(49);
            await client.click('.translation-style-categories button[data-option-index="2"]');
            expect(client.root.querySelectorAll('.translation-style-card')).toHaveLength(14);
            expect(client.config.style).toBe(49);
            savedStyle = JSON.parse(JSON.stringify(client.config)).style;
            expect(client.errors).toEqual([]);
        } finally {await client.close();}
        const restored = await ownedStyleClient(savedStyle!);
        try {
            expect(restored.root.querySelector('.translation-style-categories button[aria-checked="true"]')!.textContent!.trim()).toBe('颜色');
            expect(restored.root.querySelectorAll('.translation-style-card')).toHaveLength(12);
            expect(restored.root.querySelector('[data-style-value="49"]')!.getAttribute('aria-checked')).toBe('true');
            expect(restored.errors).toEqual([]);
        } finally {await restored.close();}
    });

    it('shows native color cards despite old pink overrides and applies a selected hue without losing font tweaks', async () => {
        const client = await ownedStyleClient(54);
        try {
            client.config.translationAppearance = {...client.config.translationAppearance, textColor: '#ef4776', fontScale: 117,
                fontWeight: 'bold', fontFamily: 'serif', customCss: 'color: pink; -webkit-text-fill-color: pink; font-size: 123%; border-radius: 6px'};
            await client.settle();
            const nativeCards = () => {
                const samples = [...client.root.querySelectorAll<HTMLElement>('.translation-style-card .fluent-read-bilingual-content')];
                expect(samples).toHaveLength(12);
                for (const sample of samples) {
                    expect(sample.style.getPropertyValue('color')).toBeFalsy();
                    expect(sample.style.getPropertyValue('-webkit-text-fill-color')).toBeFalsy();
                    expect(sample.style.getPropertyValue('font-family')).toContain('serif');
                    expect(sample.style.getPropertyValue('font-size')).toBe('123%');
                }
            };
            nativeCards();
            const preview = () => client.root.querySelector<HTMLElement>('[data-testid="bilingual-highlight-preview-translation"]')!;
            expect(preview().style.getPropertyValue('color')).toBe('pink');
            await client.click('[data-style-value="49"]');
            expect(client.config.style).toBe(49);
            expect(client.config.translationAppearance).toMatchObject({textColor: '', fontScale: 117, fontWeight: 'bold', fontFamily: 'serif',
                customCss: ' font-size: 123%; border-radius: 6px'});
            expect(preview().classList.contains(client.preset(49)!.className)).toBe(true);
            expect(preview().style.getPropertyValue('color')).toBeFalsy();
            nativeCards();
            await client.click('.translation-appearance-disclosure');
            await client.input('[data-color-port="translation-text-color"]', '#1d4ed8');
            expect(client.config.translationAppearance.textColor).toBe('#1d4ed8');
            expect(preview().style.getPropertyValue('color')).toBe('#1d4ed8');
            expect(preview().style.getPropertyValue('-webkit-text-fill-color')).toBe('currentColor');
            nativeCards();
            await client.click('.translation-style-categories button[data-option-index="0"]');
            expect(client.root.querySelector<HTMLElement>('.translation-style-card .fluent-read-bilingual-content')!.style.getPropertyValue('color')).toBe('#1d4ed8');
            expect(client.errors).toEqual([]);
        } finally {await client.close();}
    });

    it('applies native appearance controls, category and preview choices, then restores appearance defaults',async()=>{
        const client=await ownedStyleClient();
        try{
            const defaults={...client.config.translationAppearance};client.config.display=0;await client.settle();await client.click('.translation-style-mode-note button');expect(client.config.display).toBe(1);
            await client.click('.translation-style-preview-theme button:last-child');expect(client.root.querySelector('.translation-style-preview')!.getAttribute('data-page-theme')).toBe('dark');expect(client.config.theme).toBe('auto');
            for (const [categoryIndex, newestStyle] of [[4, 64], [5, 70]] as const) {
                const oldStyle = client.config.style;
                await client.click(`.translation-style-categories button[data-option-index="${categoryIndex}"]`);
                expect(client.root.querySelectorAll('.translation-style-card')).toHaveLength(12);
                expect(client.config.style).toBe(oldStyle);
                await client.click(`[data-style-value="${newestStyle}"]`);
                expect(client.config.style).toBe(newestStyle);
                expect(client.root.querySelector(`[data-style-value="${newestStyle}"]`)!.getAttribute('aria-checked')).toBe('true');
                expect(client.root.querySelector('[data-testid="bilingual-highlight-preview-translation"]')!.classList.contains(client.preset(newestStyle)!.className)).toBe(true);
            }
            await client.click('.translation-appearance-disclosure');
            for(const [field,color] of [['textColor','#123456'],['backgroundColor','#ffffcc'],['lineColor','#654321'],['fillColor','#e0e0e0']] as const){const id=field.replace(/[A-Z]/g,letter=>`-${letter.toLowerCase()}`);await client.input(`[data-color-port="translation-${id}"]`,color);expect(client.config.translationAppearance[field]).toBe(color);}
            await client.click('.translation-appearance-choice:nth-of-type(2) button:last-child');expect(client.config.translationAppearance.fontWeight).not.toBe('default');
            await client.click('.translation-appearance-choice:nth-of-type(3) button:last-child');expect(client.config.translationAppearance.fontFamily).not.toBe('default');
            const scale=client.root.querySelector<HTMLInputElement>('[data-testid="translation-font-scale-value"]')!;
            for(const [raw,expected] of [['117',117],['999',250],['',250],['-10',50]] as const){scale.value=raw;scale.dispatchEvent(new Event('change',{bubbles:true}));await client.settle();expect(client.config.translationAppearance.fontScale).toBe(expected);expect(scale.value).toBe(String(expected));}
            await client.input('#translation-custom-css','position: fixed; color: red');expect(client.root.querySelector('[role="alert"]')).not.toBeNull();
            await client.click('.translation-appearance-reset');expect(client.config.translationAppearance).toEqual(defaults);expect(client.root.querySelector('[role="alert"]')).toBeNull();expect(client.errors).toEqual([]);
        }finally{await client.close()}
    });

    it('saves independent style snapshots, updates only the active profile, and deletes it without changing the others',async()=>{
        const client=await ownedStyleClient();
        try{
            await client.saveName('First style');const first=JSON.parse(JSON.stringify(client.config.translationStyleProfiles[0]));
            await client.input('[data-color-port="translation-text-color"]','#123456');await client.input('#translation-profile-name','Second style');await client.click('.translation-profile-save');
            expect(client.config.translationStyleProfiles).toHaveLength(2);expect(client.config.translationStyleProfiles[0]).toEqual(first);const secondId=client.config.activeTranslationStyleProfileId;
            await client.input('[data-color-port="translation-text-color"]','#654321');await client.input('#translation-profile-name','Updated style');expect(client.root.querySelector('.translation-appearance-status')!.textContent).toBe(client.core.translate('settings.translationStyle.unsavedChanges','zh-CN'));
            await client.click('.translation-profile-actions button:first-child');expect(client.config.translationStyleProfiles[0]).toEqual(first);expect(client.config.translationStyleProfiles[1]).toMatchObject({id:secondId,name:'Updated style',appearance:{textColor:'#654321'}});
            await client.click('.translation-profile-delete');expect(client.config.activeTranslationStyleProfileId).toBe('');expect(client.config.translationStyleProfiles).toEqual([first]);
            await client.click('.translation-style-saved-card');expect(client.config.translationAppearance).toEqual(first.appearance);expect(client.config.translationAppearance).not.toBe(client.config.translationStyleProfiles[0].appearance);
            await client.input('#translation-profile-name','   ');expect(client.root.querySelector('.translation-profile-save')!.hasAttribute('disabled')).toBe(true);expect(client.root.querySelector('.translation-profile-actions button')!.hasAttribute('disabled')).toBe(true);expect(client.errors).toEqual([]);
        }finally{await client.close()}
    });

    it.each(['设置', '设置 · 设置'])('keeps the actual saved user name %s in text, attributes and preview across seven UI languages', async name => {
        const client = await ownedStyleClient();
        try {
            await client.saveName(name);
            expect(client.config.translationStyleProfiles).toHaveLength(1);
            const profile = client.config.translationStyleProfiles[0];expect(profile.name).toBe(name);
            expect(client.core.translateLegacyText(name, 'en-US')).not.toBe(name);
            await client.click('.translation-style-card');await client.click('.translation-style-saved-card');
            const original = JSON.stringify(client.config);
            for (const language of ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES', 'zh-CN'] as const) {
                await client.language(language);
                const card = client.root.querySelector('.translation-style-saved-card')!;
                expect.soft(card.querySelector('strong')!.textContent).toBe(name);
                expect.soft(card.getAttribute('title')).toBe(name);expect.soft(card.getAttribute('aria-label')).toBe(name);
                expect.soft(client.root.querySelector('.translation-style-preview-caption strong')!.textContent)
                    .toBe(client.core.translate('settings.translationStyle.currentPreset', language, {name}));
                expect(client.root.querySelector('.settings-group-heading h2')!.textContent).toBe(client.core.translate('settings.translationStyle.title', language));
                expect(card.querySelector('small')!.textContent).toBe(client.core.translate('settings.translationStyle.profileBase', language,
                    {name: client.core.translateLegacyText(client.preset(profile.style)!.label, language)}));
                expect(JSON.stringify(client.config)).toBe(original);
            }
            expect(client.errors).toEqual([]);expect(client.observers).toHaveLength(1);
        } finally {await client.close();}
    });

    it('scans one owned root while preserving actual inputs, user prose, outside Teleport and host metadata', async () => {
        const client = await ownedStyleClient();
        try {
            const walker = vi.spyOn(document, 'createTreeWalker');
            client.notify();await client.settle();expect(walker).not.toHaveBeenCalled();
            await client.click('.translation-appearance-disclosure');await client.input('#translation-profile-name', '设置');
            const css = 'color: rebeccapurple; /* 设置 · 设置 */';await client.input('#translation-custom-css', css);
            for (const language of ['en-US', 'ja-JP', 'fr-FR', 'zh-CN'] as const) {
                await client.language(language);
                expect(client.root.querySelector('[data-owned-legacy]')!.textContent).toBe(client.core.translateLegacyText('设置', language));
                expect(client.root.querySelector('[data-owned-legacy]')!.getAttribute('aria-label')).toBe(client.core.translateLegacyText('设置', language));
                expect((client.root.querySelector('#translation-profile-name') as HTMLInputElement).value).toBe('设置');
                expect((client.root.querySelector('#translation-custom-css') as HTMLTextAreaElement).value).toBe(css);
                expect(client.config.translationAppearance.customCss).toBe(css);
                expect(client.root.querySelector('[data-user-pre]')!.textContent).toBe('设置');
                expect(client.root.querySelector('[data-user-pre]')!.getAttribute('title')).toBe(client.core.translateLegacyText('设置', language));
                expect(client.root.querySelector('[data-user-ignore]')!.getAttribute('title')).toBe('设置');
                expect(client.outside.querySelector('p')!.outerHTML).toBe('<p title="设置" aria-label="设置">设置</p>');
                expect(client.outside.querySelector('[data-outside-teleport]')!.textContent).toBe('设置');
                expect(client.outside.querySelector('[data-outside-teleport]')!.getAttribute('title')).toBe('设置');
                expect(client.sibling.innerHTML).toBe('<p title="设置">设置</p>');
                expect(document.documentElement.lang).toBe('fixture-host-language');expect(document.title).toBe('Synthetic host title');
            }
            walker.mockClear();client.notify();await client.settle();expect(walker).not.toHaveBeenCalled();
            expect(client.observers).toHaveLength(1);expect(client.observers[0].root).toBe(client.root);
            expect(client.errors).toEqual([]);
        } finally {await client.close();}
    });

    it('keeps one owned scanner through cached views and releases queued callbacks and subscriptions on unmount', async () => {
        const client = await ownedStyleClient();
        try {
            await client.language('en-US');client.shown.value = false;await client.settle();
            expect(client.observers).toHaveLength(1);expect(client.subscriptions.size).toBe(1);
            client.shown.value = true;await client.settle();client.notify();await client.settle();
            expect(client.observers).toHaveLength(1);
            const held = deferred<boolean>();client.bundleGates.set('ja-JP', held);
            const pending = client.context.setLanguage('ja-JP');await client.settle();
            expect(client.context.language.value).toBe('en-US');
            const patchCount = ports.patch.mock.calls.length;
            client.notify();client.unmount();await client.settle();
            const owned = client.root.innerHTML, outside = client.outside.innerHTML;
            client.notify();for (const callback of client.callbacks) callback({...ports.config, uiLanguage: 'ja-JP'});
            held.resolve(true);expect(await pending).toBe(false);
            expect(await client.context.setLanguage('ja-JP')).toBe(false);await client.settle();
            expect(ports.patch).toHaveBeenCalledTimes(patchCount);expect(client.context.language.value).toBe('en-US');
            expect(client.root.innerHTML).toBe(owned);expect(client.outside.innerHTML).toBe(outside);
            expect(client.subscriptions.size).toBe(0);expect(client.observers.every(observer => !observer.active)).toBe(true);
            for (const stop of client.stops) expect(stop).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
            expect(client.errors).toEqual([]);
        } finally {await client.close();}
    });
});
