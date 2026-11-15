/**
 * @file tests/writingSurfaceLifecycle.test.ts
 * 文件职责：执行真实写作入口 SFC 的动态文档和异步保存生命周期，复验入口只属于当前挂载。
 * 主要内容：通过真实 DOM MutationObserver 置换 body，验证入口恢复、去重与卸载；验证 Shadow DOM 事件路径区分面板内外，外部点击收起不抢焦点且重开复用会话；延迟保存响应不能在卸载后重建入口，失败仍保留给下一次有效挂载显示。
 * 模块边界：只替换配置、浏览器消息和子面板端口；编辑器发现、入口创建及真实 Vue setup/watch/lifecycle 均执行生产代码，不请求在线服务。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
const dom = await vi.hoisted(async () => {
    const {parseHTML} = await import('linkedom');
    const {document, window} = parseHTML('<html><head></head><body></body></html>');
    for (const key of ['window', 'document', 'Element', 'HTMLElement', 'Node', 'SVGElement', 'MutationObserver']) {
        Object.defineProperty(globalThis, key, {configurable: true, value: key === 'window' ? window : (window as any)[key]});
    }
    const rect = {x: 0, y: 0, width: 400, height: 100, left: 0, top: 0, right: 400, bottom: 100, toJSON: () => ({})};
    window.HTMLElement.prototype.getBoundingClientRect = () => rect;
    window.HTMLElement.prototype.getClientRects = () => [rect] as any;
    const style = () => ({display: 'block', visibility: 'visible'});
    Object.defineProperty(window, 'getComputedStyle', {configurable: true, value: style});
    Object.defineProperty(globalThis, 'getComputedStyle', {configurable: true, value: style});
    Object.defineProperty(globalThis, 'location', {configurable: true, value: {href: 'https://github.com/fluent/read/issues/1'}});
    Object.defineProperty(globalThis, 'matchMedia', {configurable: true, value: () => ({matches: false})});
    return {document, window};
});
const ports = vi.hoisted(() => ({config: {} as any, subscribers: new Set<(next: any) => void>(), patch: vi.fn(), send: vi.fn()}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {getURL: (path: string) => `chrome-extension://test${path}`, sendMessage: ports.send}}}));
vi.mock('@/src/services/config/store', () => ({config: ports.config, requestConfigPatch: ports.patch,
    subscribeConfig: (listener: (next: any) => void) => {ports.subscribers.add(listener); return () => ports.subscribers.delete(listener);}}));
vi.mock('@/src/ui/i18n', async () => {const {ref} = await import('vue'); return {useUiI18n: () => ({t: (key: string) => key,
    translateLegacy: (text: string) => text, language: ref('zh-CN'), bundleRevision: ref(0)})};});
vi.mock('@/src/features/writing-assistant/ui/WritingPanel.vue', async () => {
    const {h} = await import('vue');
    return {default: {render: () => h('section', {'data-writing-panel-fixture': ''}, [h('button', 'Panel action')])}};
});
vi.mock('@/src/features/writing-assistant/ui/WritingEntrySettings.vue', () => ({default: {render: () => null}}));
import {createApp, nextTick, type App} from 'vue';
import WritingSurface from '@/src/features/writing-assistant/ui/WritingSurface.vue';
import {writingEntrySaveFailure} from '@/src/features/writing-assistant/entrySession';
let app: App | undefined;
const markup = '<main><form><textarea name="comment[body]">Draft</textarea><button type="submit">Comment</button></form></main>';
function entries() {return dom.document.querySelectorAll('[data-fluent-read-ui="writing-entry"]');}
async function settle() {for (let index = 0; index < 6; index++) await Promise.resolve(); await nextTick();}
function mount() {
    const host = dom.document.createElement('div');
    host.setAttribute('data-fluent-read-ui', 'writing-test'); dom.document.documentElement.append(host);
    app = createApp(WritingSurface); app.config.warnHandler = () => {};
    const vm = app.mount(host);
    return (vm as any).$.setupState as Record<string, any>;
}
beforeEach(() => {
    vi.useFakeTimers();
    ports.patch.mockReset().mockResolvedValue(undefined); ports.send.mockReset().mockResolvedValue(undefined);
    Object.assign(location, {href: 'https://github.com/fluent/read/issues/1'});
    Object.assign(ports.config, {on: true, theme: 'light', disabledExtensionDomains: [], writing: {enabled: true, disabledDomains: []}});
    Object.defineProperty(globalThis, 'getComputedStyle', {configurable: true, value: () => ({display: 'block', visibility: 'visible'})});
    dom.document.body.innerHTML = markup;
    writingEntrySaveFailure.value = false;
});
afterEach(async () => {
    app?.unmount(); app = undefined;
    await settle(); vi.useRealTimers();
    dom.document.querySelectorAll('[data-fluent-read-ui="writing-test"]').forEach(node => node.remove());
    Reflect.deleteProperty(dom.window, 'visualViewport');
});
describe('写作入口真实组件生命周期', () => {
    it('saves the site exclusion through the shared configuration message transport', async () => {
        ports.patch.mockImplementationOnce(async (_patch,send)=>{await send({type:'persistConfig',fixture:'site-exclusion'});});
        const state=mount();await state.saveEntrySetting('site');
        expect(ports.patch).toHaveBeenCalledWith({writing:{enabled:true,disabledDomains:['github.com']}},expect.any(Function));
        expect(ports.send).toHaveBeenCalledWith({type:'persistConfig',fixture:'site-exclusion'});expect(state.menuError).toBe('');
    });
    it('整 body 替换后自动恢复原生操作行入口，后续编辑器变化仍被观察且不重复创建', async () => {
        mount(); expect(entries()).toHaveLength(1);
        const previous = entries()[0];
        const body = dom.document.createElement('body'); body.innerHTML = markup;
        dom.document.body.replaceWith(body);
        await settle(); await vi.advanceTimersByTimeAsync(100); await settle();
        expect(entries()).toHaveLength(1);
        expect(entries()[0]).not.toBe(previous);
        expect(entries()[0].nextElementSibling?.textContent).toBe('Comment');
        body.querySelector('textarea')!.remove();
        await settle(); await vi.advanceTimersByTimeAsync(100); await settle();
        expect(entries()).toHaveLength(0);
        body.innerHTML = markup;
        await settle(); await vi.advanceTimersByTimeAsync(100); await settle();
        expect(entries()).toHaveLength(1);
        app!.unmount(); app = undefined;
        body.innerHTML = markup;
        await settle(); await vi.advanceTimersByTimeAsync(100); await settle();
        expect(entries()).toHaveLength(0);
        expect(ports.subscribers.size).toBe(0);
    });
    it.each(['success', 'failure'] as const)('卸载后保存 %s 不重建入口，失败提示留给后续有效实例', async outcome => {
        let resolve!: () => void, reject!: (error: Error) => void;
        ports.patch.mockImplementationOnce(() => new Promise<void>((done, fail) => {resolve = done; reject = fail;}));
        const state = mount(); expect(entries()).toHaveLength(1);
        const pending = state.saveEntrySetting('site');
        app!.unmount(); app = undefined;
        expect(entries()).toHaveLength(0);
        if (outcome === 'success') resolve(); else reject(new Error('fixture failure'));
        await pending; await settle(); await vi.advanceTimersByTimeAsync(100); await settle();
        expect(entries()).toHaveLength(0);
        expect(writingEntrySaveFailure.value).toBe(outcome === 'failure');
        const next = mount();
        expect(entries()).toHaveLength(1);
        expect(next.menuOpened).toBe(outcome === 'failure');
        expect(writingEntrySaveFailure.value).toBe(false);
    });
    it('clicks open the matching draft, reuse an unchanged session, and refuse to overwrite newer user edits', async () => {
        const state = mount();
        const editor = dom.document.querySelector<HTMLTextAreaElement>('textarea')!;
        const focus = vi.spyOn(editor, 'focus');
        const button = entries()[0].shadowRoot!.querySelector<HTMLButtonElement>('button')!;
        button.click(); await settle();
        expect(state.opened).toBe(true); expect(state.draft).toBe('Draft'); expect(state.intent).toBe('polish');
        expect(state.canInsert).toBe(true);
        expect(state.context).toContain('当前项目：fluent/read');
        state.scan(); await settle();
        expect(button.getAttribute('aria-expanded')).toBe('true');
        const session = state.sessionKey;
        state.close(); await settle(); expect(focus).toHaveBeenCalledWith({preventScroll: true});
        button.click(); await settle(); expect(state.sessionKey).toBe(session);
        editor.value = 'More recent user text';
        expect(state.fillDraft('Outdated generated text')).toContain('已被修改');
        expect(editor.value).toBe('More recent user text');
        state.close(false); button.click(); await settle();
        expect(state.sessionKey).toBe(session + 1);
        const changed = vi.fn(); editor.addEventListener('input', changed);
        expect(state.fillDraft('Accepted draft')).toBeUndefined();
        expect(editor.value).toBe('Accepted draft'); expect(changed).toHaveBeenCalledOnce();
        expect(state.opened).toBe(false);
        Object.assign(ports.config, {on: false}); state.scan();
        expect(state.fillDraft('Disabled')).toContain('已禁用'); expect(entries()).toHaveLength(0);
    });

    it('dismisses on outside pointerdown without stealing focus and reopens the unchanged editor session', async () => {
        const listen = vi.spyOn(dom.document, 'addEventListener');
        const state = mount();
        const editor = dom.document.querySelector<HTMLTextAreaElement>('textarea')!;
        const focus = vi.spyOn(editor, 'focus');
        const entry = entries()[0] as HTMLElement;
        const trigger = entry.shadowRoot!.querySelector<HTMLButtonElement>('button')!;
        trigger.click(); await settle();
        const session = state.sessionKey;
        const panel = dom.document.querySelector('[data-writing-panel-fixture]')!;
        const action = panel.querySelector('button')!;
        const pointer = (path: EventTarget[]) => {
            const event = new dom.window.Event('pointerdown', {bubbles: true, cancelable: true});
            Object.defineProperty(event, 'composedPath', {value: () => path});
            dom.document.dispatchEvent(event);
            return event;
        };
        // 同一 Shadow DOM 内的按钮以及被重定向为入口 host 的事件均属于当前面板。
        pointer([action, panel, dom.document.documentElement, dom.document]);
        pointer([trigger, entry.shadowRoot!, entry, dom.document]);
        expect(state.opened).toBe(true); expect(state.sessionKey).toBe(session);
        const outside = dom.document.createElement('button'); dom.document.body.append(outside);
        const clicked = vi.fn(); outside.addEventListener('click', clicked);
        const event = pointer([outside, dom.document.body, dom.document]);
        outside.click(); await settle();
        expect(state.opened).toBe(false); expect(focus).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false); expect(clicked).toHaveBeenCalledOnce();
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        trigger.click(); await settle();
        expect(state.opened).toBe(true); expect(state.sessionKey).toBe(session);
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        const listener = listen.mock.calls.find(([type]) => type === 'pointerdown')!;
        expect(listener[2]).toEqual(expect.objectContaining({capture: true, signal: expect.any(AbortSignal)}));
        app!.unmount(); app = undefined;
        expect((listener[2] as AddEventListenerOptions).signal!.aborted).toBe(true);
    });

    it('keeps entry settings mutually exclusive with writing, toggles by trigger, and reports options failures', async () => {
        const state = mount();
        const host = entries()[0] as HTMLElement;
        const [button, menu] = host.shadowRoot!.querySelectorAll<HTMLButtonElement>('button');
        const focus = vi.spyOn(menu, 'focus');
        button.click(); menu.click(); await settle();
        expect(state.opened).toBe(false); expect(state.menuOpened).toBe(true);
        expect(menu.getAttribute('aria-expanded')).toBe('true');
        menu.click(); await settle(); expect(state.menuOpened).toBe(false);
        menu.click(); await state.openSettings(); await settle();
        expect(ports.send).toHaveBeenCalledWith({type: 'openOptionsPage', section: 'settings-writing'});
        expect(state.menuOpened).toBe(false); expect(focus).toHaveBeenCalledWith({preventScroll: true});
        menu.click(); ports.send.mockRejectedValueOnce(new Error('unavailable'));
        await state.openSettings(); expect(state.menuOpened).toBe(true); expect(state.menuError).toBe('writing.entry.openError');
        const outside = new dom.window.Event('pointerdown', {bubbles: true});
        dom.document.body.dispatchEvent(outside); await settle(); expect(state.menuOpened).toBe(false);
        menu.click(); dom.window.dispatchEvent(new dom.window.Event('pagehide')); await settle();
        expect(state.menuOpened).toBe(false); expect(state.opened).toBe(false);
    });

    it('a route change closes old sessions and recomputes reply versus new issue draft intent', async () => {
        const state = mount();
        const editor = dom.document.querySelector<HTMLTextAreaElement>('textarea')!;
        editor.value = '';
        state.open(editor); expect(state.intent).toBe('reply');
        const previousSession = state.sessionKey;
        location.href = 'https://github.com/fluent/read/issues/new';
        editor.name = 'issue[body]'; editor.setAttribute('name', 'issue[body]');
        dom.document.dispatchEvent(new dom.window.Event('fluentread-route-change'));
        expect(state.opened).toBe(false); expect(state.snapshot).toBeUndefined();
        state.open(editor); expect(state.intent).toBe('draft'); expect(state.sessionKey).toBeGreaterThan(previousSession);
        state.close(false);
        location.href = 'https://example.com/'; dom.window.dispatchEvent(new dom.window.Event('hashchange'));
        expect(entries()).toHaveLength(0);
        expect(state.opened).toBe(false);
    });

    it('config updates hide or restore entries and apply theme without leaving stale settings anchors', async () => {
        const state = mount();
        const first = entries()[0] as HTMLElement;
        state.openMenu(first);
        for (const listener of ports.subscribers) listener({...ports.config, theme: 'dark'});
        await settle(); expect(entries()[0].getAttribute('data-theme')).toBe('dark');
        for (const listener of ports.subscribers) listener({...ports.config, on: false});
        await settle(); expect(entries()).toHaveLength(0); expect(state.menuOpened).toBe(false);
        for (const listener of ports.subscribers) listener({...ports.config, theme: 'auto'});
        await settle(); expect(entries()).toHaveLength(1); expect(entries()[0]).not.toBe(first);
        state.openMenu(entries()[0]); dom.document.querySelector('textarea')!.remove();
        await settle(); await vi.advanceTimersByTimeAsync(100); await settle();
        expect(entries()).toHaveLength(0); expect(state.menuOpened).toBe(false);
    });

    it.each(['site', 'forever'] as const)('saves %s only once while pending and retains its menu until the save completes', async scope => {
        let resolve!: () => void;
        ports.patch.mockImplementationOnce(() => new Promise<void>(done => {resolve = done;}));
        const state = mount(); state.openMenu(entries()[0]);
        const pending = state.saveEntrySetting(scope);
        await state.saveEntrySetting(scope);
        expect(ports.patch).toHaveBeenCalledOnce();
        const patch = ports.patch.mock.calls[0][0];
        if (scope === 'site') expect(patch.writing.disabledDomains).toEqual(['github.com']);
        else expect(patch.writing.enabled).toBe(false);
        dom.document.body.dispatchEvent(new dom.window.Event('pointerdown', {bubbles: true}));
        expect(state.menuOpened).toBe(true);
        for (const listener of ports.subscribers) listener({...ports.config, on: false});
        await settle(); expect(entries()).toHaveLength(1);
        resolve(); await pending; await settle();
        expect(entries()).toHaveLength(0); expect(state.menuOpened).toBe(false);
    });

    it('hides writing when an editor disappears and recreates a removed entry without duplicate buttons', async () => {
        const state = mount();
        state.open(dom.document.querySelector('textarea'));
        const first = entries()[0]; first.remove();
        await settle(); await vi.advanceTimersByTimeAsync(100); await settle();
        expect(entries()).toHaveLength(1); expect(entries()[0]).not.toBe(first);
        const editor = dom.document.querySelector('textarea')!;
        editor.setAttribute('hidden', '');
        dom.document.dispatchEvent(new dom.window.Event('focusin'));
        dom.window.dispatchEvent(new dom.window.Event('resize'));
        dom.document.dispatchEvent(new dom.window.Event('transitionend'));
        await settle(); await vi.advanceTimersByTimeAsync(100); await settle();
        expect(entries()).toHaveLength(0); expect(state.opened).toBe(false);
    });

    it('rejects a site-save on an invalid route and never persists an empty domain', async () => {
        const state = mount(); location.href = 'invalid route';
        await state.saveEntrySetting('site');
        expect(ports.patch).not.toHaveBeenCalled();
        expect(state.menuError).toBe('writing.entry.saveError'); expect(entries()).toHaveLength(0);
    });

    it('hides zero-layout editors, refuses an unowned target, and follows the visual viewport resize', async () => {
        const viewport = new dom.window.EventTarget();
        Object.defineProperty(dom.window, 'visualViewport', {configurable: true, value: viewport});
        const listen = vi.spyOn(viewport, 'addEventListener');
        const state = mount();
        expect(listen).toHaveBeenCalledWith('resize', expect.any(Function), expect.objectContaining({signal: expect.any(AbortSignal)}));
        const unowned = dom.document.createElement('textarea'); dom.document.body.append(unowned);
        state.open(unowned); expect(state.opened).toBe(false);
        const editor = dom.document.querySelector('textarea')!;
        editor.getClientRects = () => [] as any;
        viewport.dispatchEvent(new dom.window.Event('resize'));
        await settle(); await vi.advanceTimersByTimeAsync(100); await settle();
        expect(entries()).toHaveLength(0);
    });

    it('uses Gmail conversation context for reply intent and blocks rich drafts from direct replacement', async () => {
        location.href = 'https://mail.google.com/mail/u/0/#inbox/fixture';
        dom.document.body.innerHTML = '<main role="main"><div class="a3s">Selected conversation</div><form><div contenteditable="true" role="textbox"></div><button type="submit">Send</button></form></main>';
        const state = mount();
        const editor = dom.document.querySelector<HTMLElement>('[contenteditable]')!;
        state.open(editor);
        expect(state.intent).toBe('reply'); expect(state.context).toBe('当前邮件：Selected conversation');
        state.close(false); editor.innerHTML = '<a href="https://example.com">Existing link</a>';
        state.open(editor);
        expect(state.canInsert).toBe(false);
        expect(state.fillDraft('New text')).toContain('复杂格式');
        expect(editor.querySelector('a')).not.toBeNull();
    });

    it('dismisses writing for this visit without a config write, including after remount', async () => {
        const state = mount();
        await state.saveEntrySetting('visit');
        expect(entries()).toHaveLength(0); expect(ports.patch).not.toHaveBeenCalled();
        app!.unmount(); app = undefined; mount();
        expect(entries()).toHaveLength(0);
    });

});
