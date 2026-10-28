/**
 * @file tests/nativePdfSelectionPage.test.ts
 * 文件职责：验证原生 PDF 右键结果页的一次性领取、严格本页来源和异步生命周期。
 * 主要内容：覆盖令牌清理、配置水合与禁用、文本和来源校验、真实节点范围、领取和挂载迟到、卡片关闭及失败提示，不发起翻译服务请求。
 * 模块边界：以隔离 DOM 和卡片端口测试页面编排；卡片自身、原生 PDF 右键与浏览器窗口联动由现有组件测试及隔离真实浏览器验证。
 */
import {parseHTML} from 'linkedom';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createNativePdfSelectionAdapter, mountNativePdfSelectionApp, parseNativePdfSelectionPayload, readNativePdfSelectionToken,
    type NativePdfSelectionPageDependencies} from '@/src/app/selection/page';
import {observeNativePdfSelectionCard} from '@/src/app/selection/cardVisibility';
import {createNativePdfSelectionBridge, NATIVE_PDF_SELECTION_TTL_MS} from '@/src/features/selection-translation/background/nativePdfSelection';

const ports = vi.hoisted(() => ({createApp: vi.fn(), plugin: vi.fn(), sendMessage: vi.fn(), translate: vi.fn(), subscribeConfig: vi.fn(),
    config: {on: true, disableSelectionTranslator: false, selectionTranslatorMode: 'bilingual', disabledExtensionDomains: [] as string[]}}));
vi.mock('vue', async original => ({...await original<object>(), createApp: ports.createApp}));
vi.mock('@/src/services/config/store', () => ({config: ports.config, configReady: Promise.resolve(), subscribeConfig: ports.subscribeConfig}));
vi.mock('@/src/ui/i18n', () => ({createUiI18nPlugin: ports.plugin}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: ports.sendMessage}}}));
vi.mock('@/src/features/selection-translation/ui/SelectionTranslator.vue', () => ({default: {name: 'ExistingSelectionTranslator'}}));
vi.mock('@/src/features/selection-translation/content/contextMenuBridge', () => ({translateSelectionFromContextMenu: ports.translate}));

const token = 'f48feab4-089c-4b92-9bfb-516531f6fa37';
const payload = {text: 'Selected PDF words', sourceUrl: 'https://papers.test/paper.pdf?signature=private#page=2', title: 'A paper'};
const cleanups: Array<() => void> = [];
beforeEach(() => {ports.createApp.mockReset(); ports.plugin.mockReset(); ports.sendMessage.mockReset(); ports.translate.mockReset();
    ports.subscribeConfig.mockReset(); ports.subscribeConfig.mockReturnValue(() => {});
    Object.assign(ports.config, {on: true, disableSelectionTranslator: false, selectionTranslatorMode: 'bilingual', disabledExtensionDomains: []});});
afterEach(() => {cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); vi.restoreAllMocks();});
const tick = async () => {for (let index = 0; index < 8; index++) await Promise.resolve();};
function deferred<T>() {let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => {resolve = done; reject = fail;}); return {promise, resolve, reject};}
function fixture(hash = `#token=${token}`, selected = true) {
    const {document} = parseHTML('<html><body><main id="app"></main><p id="other">Other text</p></body></html>');
    let activeRange: Range | null = null;
    const selection = {removeAllRanges: vi.fn(() => {activeRange = null;}), addRange: vi.fn((range: Range) => {activeRange = range;}),
        containsNode: (node: Node) => activeRange?.startContainer === node};
    const detach = vi.fn();
    document.createRange = (() => {
        const value = {startContainer: null as Text | null, endContainer: null as Text | null, startOffset: 0, endOffset: 0, collapsed: true,
            selectNodeContents(node: Text) {value.startContainer = node; value.endContainer = node; value.endOffset = node.length; value.collapsed = false;},
            toString: () => value.startContainer?.textContent?.slice(value.startOffset, value.endOffset) ?? '', detach};
        return value;
    }) as unknown as typeof document.createRange;
    const window = Object.assign(new EventTarget(), {location: {hash, pathname: '/selection.html', search: ''}, history: {replaceState: vi.fn()},
        getSelection: () => selected ? selection : null, close: vi.fn()});
    vi.stubGlobal('document', document); vi.stubGlobal('window', window);
    vi.stubGlobal('MutationObserver', document.defaultView!.MutationObserver);
    const card = {translate: vi.fn(() => true), focus: vi.fn(), dispose: vi.fn()};
    const listeners = new Set<() => void>(); const unsubscribe = vi.fn();
    let enabled = true;
    const dependencies: NativePdfSelectionPageDependencies = {ready: Promise.resolve(), enabled: () => enabled,
        subscribe: vi.fn(listener => {listeners.add(listener); return () => {listeners.delete(listener); unsubscribe();};}),
        claim: vi.fn(async () => payload), mountCard: vi.fn(() => card), close: vi.fn()};
    return {document, window, dependencies, card, detach, selection, unsubscribe, notify() {listeners.forEach(listener => listener());}, setEnabled(value: boolean) {enabled = value;},
        get range() {return activeRange;}, start() {const app = mountNativePdfSelectionApp('#app', dependencies); cleanups.push(app.dispose); return app;}};
}

describe('原生 PDF 选区交接验证', () => {
    it('后台主动过期后结果页显示重新选择提示并保留用户关闭入口', async () => {
        vi.useFakeTimers();
        try {
            let now = 0;const key = 'a'.repeat(32), url = 'chrome-extension://test/selection.html';
            const bridge = createNativePdfSelectionBridge({extensionId:'test', resultUrl:url, now:() => now, wallNow:() => now,
                randomToken:() => key, openWindow:async () => ({id:12,tabs:[{id:21}]})});
            expect(await bridge.open(payload)).toBe(true);now += NATIVE_PDF_SELECTION_TTL_MS;
            await vi.advanceTimersByTimeAsync(NATIVE_PDF_SELECTION_TTL_MS);
            const f = fixture(`#token=${key}`);
            f.dependencies.claim = requested => bridge.claim(requested, {id:'test',url,frameId:0,tab:{id:21,windowId:12}});
            await f.start().ready;
            expect(f.document.querySelector('[role="status"]')!.textContent).toBe('选区已失效，请返回 PDF 重新选中文字并右键翻译。');
            expect(f.dependencies.mountCard).not.toHaveBeenCalled();f.document.querySelector('button')!.click();expect(f.dependencies.close).toHaveBeenCalledOnce();
        } finally {vi.useRealTimers();}
    });
    it('只读取随机令牌，不把原文放进 URL', () => {
        expect(readNativePdfSelectionToken(`#token=${token}`)).toBe(token);
        expect(readNativePdfSelectionToken(`#${token}`)).toBe(token);
        for (const value of ['', '#token=', '#short', '#token=Selected%20PDF%20words', `#${'x'.repeat(129)}`]) expect(readNativePdfSelectionToken(value)).toBeNull();
    });
    it('只接受有限纯文本及公网来源，去除来源凭据、查询和片段', () => {
        expect(parseNativePdfSelectionPayload({...payload, sourceUrl: 'https://user:secret@papers.test/paper.pdf?signature=private#page=2'}))
            .toEqual({...payload, sourceUrl: 'https://papers.test/paper.pdf'});
        expect(parseNativePdfSelectionPayload({...payload, text: 'x'.repeat(4096), title: 'x'.repeat(600)})?.title).toHaveLength(512);
        for (const value of [null, '', {}, {...payload, text: ' '}, {...payload, text: 'x'.repeat(4097)}, {...payload, text: 1},
            {...payload, sourceUrl: 1}, {...payload, sourceUrl: 'invalid'}, {...payload, sourceUrl: 'file:///private.pdf'}, {...payload, title: null}]) {
            expect(parseNativePdfSelectionPayload(value)).toBeNull();
        }
    });
    it('适配器只接受原文节点内未变更且仍连接的 Range，上下文不会读取其他 DOM', () => {
        const f = fixture(); const source = f.document.createTextNode(payload.text); f.document.querySelector('#app')!.append(source);
        let current = true; const adapter = createNativePdfSelectionAdapter(source as unknown as Text, payload, () => current);
        const range = {startContainer: source, endContainer: source, startOffset: 0, endOffset: payload.text.length, collapsed: false,
            toString: () => payload.text} as unknown as Range;
        expect(adapter.acceptsRange(range)).toBe(true); expect(adapter.extractText!(range, '')).toBe(payload.text);
        expect(adapter.normalizeText!(payload.text)).toBe(payload.text);
        expect(adapter.context!(range, payload.text, 8)).toMatchObject({text: 'Selected', title: payload.title});
        expect(adapter.context!(range, payload.text, 0).text).toBe('');
        expect(adapter.captureReading!(range, payload.text, 8)).toEqual({text: payload.text, context: 'Selected', sentence: payload.text});
        expect(adapter.captureMaterial!(range, payload.text)).toBeUndefined();
        for (const changes of [{startContainer: f.document.querySelector('#other')!.firstChild}, {endContainer: f.document.body},
            {collapsed: true}, {startOffset: -1}, {endOffset: payload.text.length + 1}, {startOffset: 2, endOffset: 1}]) {
            expect(adapter.acceptsRange({...range, ...changes} as Range)).toBe(false);
        }
        source.textContent = 'Changed'; expect(adapter.acceptsRange(range)).toBe(false); source.textContent = payload.text;
        current = false; expect(adapter.extractText!(range, '')).toBe(''); expect(adapter.captureReading!(range, payload.text, 8).context).toBe('');
        current = true; source.remove(); expect(adapter.acceptsRange(range)).toBe(false);
    });
});

describe('原生 PDF 划词窗口生命周期', () => {
    it('超长原生选区仅显示有限错误码对应的提示，不领取或翻译正文', async () => {
        const f = fixture('#error=too-long'); await f.start().ready;
        expect(f.document.querySelector('[role="status"]')!.textContent).toBe('单次最多翻译 4096 个字符，请缩小选区后重试。');
        expect(f.dependencies.claim).not.toHaveBeenCalled(); expect(f.dependencies.mountCard).not.toHaveBeenCalled();
        f.document.querySelector('button')!.click(); expect(f.dependencies.close).toHaveBeenCalledOnce();
    });
    it('来源摘要拦截外部指针事件，卡片内部事件保留，卸载清理监听', async () => {
        const f = fixture(); const outside = vi.fn();
        f.dependencies.mountCard = vi.fn(host => {host.append(f.document.createElement('button')); return f.card;});
        const page = f.start(); await page.ready;
        f.document.addEventListener('pointerdown', outside, true); f.document.addEventListener('pointerup', outside, true);
        for (const type of ['pointerdown', 'pointerup']) {
            const event = new f.document.defaultView!.Event(type, {bubbles: true, cancelable: true});
            f.document.querySelector('.native-pdf-selection-source p')!.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
        }
        expect(outside).not.toHaveBeenCalled(); expect(f.card.dispose).not.toHaveBeenCalled();
        f.document.querySelector('.native-pdf-selection-card button')!.dispatchEvent(new f.document.defaultView!.Event('pointerdown', {bubbles: true}));
        expect(outside).toHaveBeenCalledOnce();
        page.dispose(); f.document.body.dispatchEvent(new f.document.defaultView!.Event('pointerdown', {bubbles: true}));
        expect(outside).toHaveBeenCalledTimes(2); expect(f.unsubscribe).toHaveBeenCalledOnce();
    });
    it('配置同步禁用源站时立即卸载卡片并显示提示，重新启用不复活旧选区', async () => {
        const f = fixture(); const page = f.start(); await page.ready; f.notify(); expect(f.card.dispose).not.toHaveBeenCalled();
        f.setEnabled(false); f.notify(); expect(f.card.dispose).toHaveBeenCalledOnce(); expect(f.range).toBeNull();
        expect(f.document.querySelector('[role="status"]')!.textContent).toContain('此页面的划词翻译已关闭');
        f.setEnabled(true); f.notify(); expect(f.dependencies.mountCard).toHaveBeenCalledOnce();
        page.dispose(); f.notify(); expect(f.unsubscribe).toHaveBeenCalledOnce();
    });
    it('挂载期间禁用后重新启用，迟到卡片仍释放且不复活', async () => {
        const f = fixture(); const mounted = deferred<typeof f.card>(); f.dependencies.mountCard = vi.fn(() => mounted.promise);
        const page = f.start(); await tick(); f.setEnabled(false); f.notify(); f.setEnabled(true); mounted.resolve(f.card); await page.ready;
        expect(f.card.dispose).toHaveBeenCalledOnce(); expect(f.card.translate).not.toHaveBeenCalled();
        expect(f.document.querySelector('[role="status"]')!.textContent).toContain('此页面的划词翻译已关闭');
    });
    it('不提供可选订阅端口时仍可正常开卡和卸载', async () => {
        const f = fixture(); delete f.dependencies.subscribe; const page = f.start(); await page.ready; page.dispose(); expect(f.card.dispose).toHaveBeenCalledOnce();
    });
    it('来源标题缺失时仅显示原站主机名', async () => {
        const f = fixture(); f.dependencies.claim = vi.fn(async () => ({...payload, title: '  '})); await f.start().ready;
        expect(f.document.querySelector('.native-pdf-selection-source small')!.textContent).toBe('papers.test');
    });
    it('配置就绪后只领取一次，使用真实只读原文节点开卡，关闭取消卡片并清理 Range', async () => {
        const f = fixture(); const ready = deferred<void>(); f.dependencies.ready = ready.promise;
        const app = f.start(); expect(f.window.history.replaceState).toHaveBeenCalledWith(null, '', '/selection.html'); expect(f.dependencies.claim).not.toHaveBeenCalled();
        ready.resolve(); await app.ready;
        expect(f.dependencies.claim).toHaveBeenCalledOnce(); expect(f.dependencies.claim).toHaveBeenCalledWith(token);
        expect(f.card.translate).toHaveBeenCalledWith(payload.text); expect(f.card.focus).toHaveBeenCalledOnce();
        expect(f.document.querySelector('[contenteditable="false"]')!.textContent).toBe(payload.text);
        const [host, adapter, dismiss] = vi.mocked(f.dependencies.mountCard).mock.calls[0];
        expect(host.id).toBe('fluent-read-selection-translator-container'); expect(adapter.acceptsRange(f.range!)).toBe(true);
        expect(adapter.context!(f.range!, payload.text, 500).sourceUrl).toBe('https://papers.test/paper.pdf');
        dismiss(); dismiss(); expect(f.dependencies.close).toHaveBeenCalledOnce(); expect(f.card.dispose).toHaveBeenCalledOnce(); expect(f.detach).toHaveBeenCalledOnce();
        expect(f.range).toBeNull(); expect(f.document.querySelector('#app')!.textContent).toBe('');
    });
    it.each(['before-ready', 'claim-pending', 'mount-pending'])('在 %s 离开后不再打开迟到卡片', async stage => {
        const f = fixture(); const ready = deferred<void>(), claim = deferred<unknown>(), mounted = deferred<typeof f.card>();
        if (stage === 'before-ready') f.dependencies.ready = ready.promise;
        if (stage === 'claim-pending') f.dependencies.claim = vi.fn(() => claim.promise);
        if (stage === 'mount-pending') f.dependencies.mountCard = vi.fn(() => mounted.promise);
        const app = f.start(); await tick(); f.window.dispatchEvent(new Event('pagehide'));
        ready.resolve(); claim.resolve(payload); mounted.resolve(f.card); await app.ready;
        expect(f.card.translate).not.toHaveBeenCalled(); expect(f.dependencies.close).not.toHaveBeenCalled();
        expect(f.document.querySelector('#app')!.textContent).toBe('');
        if (stage === 'mount-pending') expect(f.card.dispose).toHaveBeenCalledOnce();
    });
    it.each(['before-ready', 'claim-pending', 'mount-pending'])('在 %s 关闭划词后不请求翻译并显示提示', async stage => {
        const f = fixture(); const claim = deferred<unknown>(), mounted = deferred<typeof f.card>();
        if (stage === 'before-ready') f.setEnabled(false);
        if (stage === 'claim-pending') f.dependencies.claim = vi.fn(() => claim.promise);
        if (stage === 'mount-pending') f.dependencies.mountCard = vi.fn(() => mounted.promise);
        const app = f.start(); await tick(); f.setEnabled(false); claim.resolve(payload); mounted.resolve(f.card); await app.ready;
        expect(f.card.translate).not.toHaveBeenCalled(); expect(f.document.querySelector('[role="status"]')!.textContent).toContain('划词翻译已关闭');
        if (stage === 'before-ready') expect(f.dependencies.claim).not.toHaveBeenCalled();
    });
    it.each(['missing-token', 'invalid-payload', 'claim-error', 'no-selection', 'rejected-range'])('对 %s 显示可退出提示，不伪造来源或重复请求', async failure => {
        const f = fixture(failure === 'missing-token' ? '' : `#token=${token}`, failure !== 'no-selection');
        if (failure === 'invalid-payload') f.dependencies.claim = vi.fn(async () => null);
        if (failure === 'claim-error') f.dependencies.claim = vi.fn(async () => {throw new Error('offline');});
        if (failure === 'rejected-range') f.card.translate.mockReturnValue(false);
        await f.start().ready;
        expect(f.document.querySelector('[role="status"]')!.textContent).toMatch(/失效|无法/);
        f.document.querySelector('button')!.click(); expect(f.dependencies.close).toHaveBeenCalledOnce();
        if (failure === 'missing-token') expect(f.dependencies.claim).not.toHaveBeenCalled();
        expect(f.card.focus).not.toHaveBeenCalled();
    });
    it.each(['claimed', 'mounted'])('在 %s 阶段根据真实 PDF 来源复核源站禁用状态', async stage => {
        const f = fixture(); let sourceChecks = 0;
        f.dependencies.enabled = vi.fn(sourceUrl => !sourceUrl || (++sourceChecks < (stage === 'claimed' ? 1 : 2)));
        await f.start().ready;
        expect(f.dependencies.enabled).toHaveBeenCalledWith('https://papers.test/paper.pdf');
        expect(f.card.translate).not.toHaveBeenCalled();
        expect(f.document.querySelector('[role="status"]')!.textContent).toContain('此页面的划词翻译已关闭');
        if (stage === 'claimed') expect(f.dependencies.mountCard).not.toHaveBeenCalled();
        else expect(f.card.dispose).toHaveBeenCalledOnce();
    });
    it('拒绝缺少自有挂载点的页面', () => {const f = fixture(); f.document.querySelector('#app')!.remove(); expect(() => f.start()).toThrow('找不到划词翻译窗口');});
});

describe('既有划词卡片的生产默认装配', () => {
    it('曾显示的真实卡片自行移除后关闭窗口一次，初次空根不会误关', async () => {
        const f = fixture(); const root = f.document.createElement('div'); root.className = 'fr-selection-translator-root';
        const app = {use: vi.fn(), mount: vi.fn((host: HTMLElement) => host.append(root)), unmount: vi.fn(() => root.remove())};
        ports.createApp.mockReturnValue(app); ports.sendMessage.mockResolvedValue(payload); ports.translate.mockReturnValue(true);
        const page = mountNativePdfSelectionApp('#app'); cleanups.push(page.dispose); await page.ready; await tick();
        expect(f.window.close).not.toHaveBeenCalled();
        const card = f.document.createElement('section'); card.className = 'fr-translation-tooltip'; root.append(card); await tick();
        card.remove(); await tick();
        expect(f.window.close).toHaveBeenCalledOnce(); expect(app.unmount).toHaveBeenCalledOnce();
        root.append(card); card.remove(); await tick(); expect(f.window.close).toHaveBeenCalledOnce();
    });
    it.each(['disabled', 'dispose'])('默认卡片在 %s 销毁前停止观察，不把页面提示误作窗口关闭', async reason => {
        const f = fixture(); const root = f.document.createElement('div'); root.className = 'fr-selection-translator-root';
        const card = f.document.createElement('section'); card.className = 'fr-translation-tooltip'; root.append(card);
        const app = {use: vi.fn(), mount: vi.fn((host: HTMLElement) => host.append(root)), unmount: vi.fn(() => card.remove())};
        let notify!: () => void; ports.subscribeConfig.mockImplementation(listener => {notify = listener; return () => {};});
        ports.createApp.mockReturnValue(app); ports.sendMessage.mockResolvedValue(payload); ports.translate.mockReturnValue(true);
        const page = mountNativePdfSelectionApp('#app'); cleanups.push(page.dispose); await page.ready;
        if (reason === 'disabled') {ports.config.on = false; notify();} else page.dispose();
        await tick(); expect(app.unmount).toHaveBeenCalledOnce(); expect(f.window.close).not.toHaveBeenCalled();
        if (reason === 'disabled') expect(f.document.querySelector('[role="status"]')!.textContent).toContain('划词翻译已关闭');
    });
    it.each(['plugin', 'mount'])('默认 %s 挂载失败时立即释放已创建应用', async failure => {
        const f = fixture(); const app = {use: vi.fn(), mount: vi.fn(), unmount: vi.fn()};
        ports.createApp.mockReturnValue(app); ports.sendMessage.mockResolvedValue(payload);
        (failure === 'plugin' ? app.use : app.mount).mockImplementation(() => {throw new Error('Mount failed');});
        const page = mountNativePdfSelectionApp('#app'); cleanups.push(page.dispose); await page.ready;
        expect(app.unmount).toHaveBeenCalledOnce(); expect(ports.translate).not.toHaveBeenCalled();
        expect(f.document.querySelector('[role="status"]')!.textContent).toContain('无法打开划词翻译');
    });
    it.each([true, false])('复用组件、i18n、右键桥与窗口关闭端口，实际 dialog 存在：%s', async withDialog => {
        const f = fixture(); const focus = vi.fn();
        const app = {use: vi.fn(), mount: vi.fn((host: HTMLElement) => {
            if (!withDialog) return;
            const dialog = f.document.createElement('section'); dialog.className = 'fr-translation-tooltip'; dialog.focus = focus; host.append(dialog);
        }), unmount: vi.fn()};
        ports.createApp.mockReturnValue(app); ports.plugin.mockReturnValue({install() {}}); ports.sendMessage.mockResolvedValue(payload); ports.translate.mockReturnValue(true);
        const page = mountNativePdfSelectionApp('#app'); cleanups.push(page.dispose); await page.ready;
        expect(ports.sendMessage).toHaveBeenCalledWith({type: 'claimNativePdfSelection', token});
        expect(ports.createApp.mock.calls[0][0]).toEqual({name: 'ExistingSelectionTranslator'});
        expect(ports.plugin).toHaveBeenCalledWith(expect.objectContaining({documentTitleKey: 'contextMenu.translateSelection'}));
        expect(ports.translate).toHaveBeenCalledWith(payload.text);
        if (withDialog) expect(focus).toHaveBeenCalledWith({preventScroll: true}); else expect(focus).not.toHaveBeenCalled();
        ports.createApp.mock.calls[0][1].onFocusedCardDismiss(); expect(app.unmount).toHaveBeenCalledOnce(); expect(f.window.close).toHaveBeenCalledOnce();
        const adapter = ports.createApp.mock.calls[0][1].selectionAdapter;
        expect(adapter.acceptsRange({})).toBe(false);
    });
    it.each(['master', 'selection', 'mode', 'site'])('生产配置 %s 禁用时保留既有门禁', async setting => {
        const f = fixture(); ports.sendMessage.mockResolvedValue(payload);
        if (setting === 'master') ports.config.on = false;
        if (setting === 'selection') ports.config.disableSelectionTranslator = true;
        if (setting === 'mode') ports.config.selectionTranslatorMode = 'disabled';
        if (setting === 'site') ports.config.disabledExtensionDomains = ['papers.test'];
        const page = mountNativePdfSelectionApp('#app'); cleanups.push(page.dispose); await page.ready;
        expect(ports.createApp).not.toHaveBeenCalled(); expect(ports.translate).not.toHaveBeenCalled();
        expect(f.document.querySelector('[role="status"]')!.textContent).toContain('划词翻译已关闭');
        if (setting === 'site') expect(ports.sendMessage).toHaveBeenCalledOnce(); else expect(ports.sendMessage).not.toHaveBeenCalled();
    });
});

describe('结果窗口的自有卡片可见性观察', () => {
    it('首次 tooltip 在同一批中加入后又移除时也退出，不依赖最终 DOM 仍保留卡片', () => {
        const f = fixture(); let notify!: MutationCallback;
        vi.stubGlobal('MutationObserver', class {constructor(callback: MutationCallback) {notify = callback;} observe() {} disconnect() {}});
        const root = f.document.createElement('div'), card = f.document.createElement('section'); card.className = 'fr-translation-tooltip';
        const dismiss = vi.fn(); const stop = observeNativePdfSelectionCard(root as unknown as HTMLElement, dismiss);
        root.append(card); card.remove();
        notify([{addedNodes: [card]}, {addedNodes: []}] as unknown as MutationRecord[], {} as MutationObserver);
        expect(dismiss).toHaveBeenCalledOnce(); stop();
    });
    it('只观察直接子节点，初次注释和流式正文变化不关闭，同批出现并移除也退出一次', () => {
        const f = fixture(); let notify!: MutationCallback; const disconnect = vi.fn(); const observe = vi.fn();
        vi.stubGlobal('MutationObserver', class {constructor(callback: MutationCallback) {notify = callback;} observe = observe; disconnect = disconnect;});
        const root = f.document.createElement('div'), card = f.document.createElement('section'); card.className = 'fr-translation-tooltip';
        const dismiss = vi.fn(); const stop = observeNativePdfSelectionCard(root as unknown as HTMLElement, dismiss);
        expect(observe).toHaveBeenCalledWith(root, {childList: true});
        const records = (nodes: Node[]) => [{addedNodes: nodes}] as unknown as MutationRecord[];
        notify(records([f.document.createComment('v-if'), f.document.createElement('p')]), {} as MutationObserver);
        expect(dismiss).not.toHaveBeenCalled();
        root.append(card); notify(records([card]), {} as MutationObserver);
        card.textContent = 'Streamed text'; notify([], {} as MutationObserver); expect(dismiss).not.toHaveBeenCalled();
        card.remove(); notify(records([card]), {} as MutationObserver); expect(dismiss).toHaveBeenCalledOnce();
        notify([], {} as MutationObserver); expect(dismiss).toHaveBeenCalledOnce(); stop(); stop();
        notify(records([card]), {} as MutationObserver); expect(dismiss).toHaveBeenCalledOnce(); expect(disconnect).toHaveBeenCalledTimes(2);
    });
});
