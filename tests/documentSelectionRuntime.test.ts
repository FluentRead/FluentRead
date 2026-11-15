/**
 * @file tests/documentSelectionRuntime.test.ts
 * 文件职责：验证文档页 PDF 划词适配的来源边界、上下文和按需生命周期。
 * 主要内容：覆盖跨页原文、校订与译文排除、排版清理、来源 URL 凭据裁剪、配置水合、快速禁用重启、迟到挂载、页面隐藏和资源释放。
 * 模块边界：使用隔离 DOM 与可控挂载端口，不把确定性测试视为真实浏览器或在线供应商结果。
 */
import {parseHTML} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
    acceptsPdfSourceRange, createPdfSelectionAdapter, extractPdfSelectionText, installDocumentSelectionContextMenu, mountDocumentSelectionTranslation,
    normalizePdfSelectionText, PDF_SELECTION_RANGE_CHANGE,
    type DocumentSelectionRuntimeDependencies,
} from '@/src/app/document-translation/selectionRuntime';

const ports = vi.hoisted(() => ({createApp: vi.fn(), translateSelection: vi.fn(() => true),
    config: {on: true, disableSelectionTranslator: false, selectionTranslatorMode: 'bilingual'},
    subscribeConfig: vi.fn(() => () => {}),
}));
vi.mock('vue', async original => ({...await original<object>(), createApp: ports.createApp}));
vi.mock('@/src/services/config/store', () => ({config: ports.config, configReady: Promise.resolve(), subscribeConfig: ports.subscribeConfig}));
vi.mock('@/src/ui/i18n', () => ({createUiI18nPlugin: () => ({install() {}})}));
vi.mock('webextension-polyfill', () => ({default: {}}));
vi.mock('@/src/features/selection-translation/ui/SelectionTranslator.vue', () => ({default: {name: 'ExistingSelectionTranslator'}}));
vi.mock('@/src/features/selection-translation/content/contextMenuBridge', () => ({translateSelectionFromContextMenu: ports.translateSelection}));

const cleanups: Array<() => void> = [];
afterEach(() => {cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); vi.restoreAllMocks();});
const tick = async () => {await Promise.resolve(); await Promise.resolve(); await Promise.resolve();};
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => {resolve = done; reject = fail;});
    return {promise, resolve, reject};
}
function dom(body = '') {
    const {document, window} = parseHTML(`<html><head></head><body>${body}</body></html>`);
    vi.stubGlobal('MutationObserver', window.MutationObserver);
    vi.stubGlobal('CustomEvent', window.CustomEvent);
    return {document, window, root: document.body as unknown as HTMLElement};
}
function range(start: Node, end = start, html = ''): Range {
    return {startContainer: start, endContainer: end,
        cloneContents: () => {
            const fragment = start.ownerDocument!.createDocumentFragment();
            const wrapper = start.ownerDocument!.createElement('div');
            wrapper.innerHTML = html;
            fragment.append(...Array.from(wrapper.childNodes));
            return fragment;
        },
    } as unknown as Range;
}

describe('PDF source selection adapter', () => {
    it('releases an invalidation subscription independently and makes repeated release harmless', () => {
        const {root}=dom(),adapter=createPdfSelectionAdapter(root),first=vi.fn(),second=vi.fn();
        const stop=adapter.subscribeInvalidation!(first);adapter.subscribeInvalidation!(second);
        adapter.invalidate();expect(first).toHaveBeenCalledOnce();expect(second).toHaveBeenCalledOnce();
        stop();stop();adapter.invalidate();expect(first).toHaveBeenCalledOnce();expect(second).toHaveBeenCalledTimes(2);
    });
    it('accepts source glyphs and rejects document controls, translated text and disconnected ranges', () => {
        const {root} = dom('<section data-fluentread-pdf-text><span>Source words</span></section><textarea>Editor words</textarea><div data-fluentread-pdf-translation>Translated words</div>');
        const source = root.querySelector('span')!.firstChild!;
        expect(acceptsPdfSourceRange(range(source), root)).toBe(true);
        expect(acceptsPdfSourceRange(range(root.querySelector('textarea')!.firstChild!), root)).toBe(false);
        expect(acceptsPdfSourceRange(range(root.querySelector('[data-fluentread-pdf-translation]')!.firstChild!), root)).toBe(false);
        expect(acceptsPdfSourceRange(range(source, root.querySelector('textarea')!.firstChild!), root)).toBe(false);
        root.querySelector('section')!.remove();
        expect(acceptsPdfSourceRange(range(source), root)).toBe(false);
    });

    it('permits cross-page source ranges through canvases while excluding intermediary editor or translation text', () => {
        const {root} = dom('<section data-fluentread-pdf-text><span>First</span></section><section data-fluentread-pdf-text><span>Second</span></section>');
        const glyphs = root.querySelectorAll('span');
        const pdfRange = (middle: string) => range(glyphs[0].firstChild!, glyphs[1].firstChild!,
            `<section data-fluentread-pdf-text>First</section>${middle}<canvas></canvas><section data-fluentread-pdf-text>Second</section>`);
        expect(acceptsPdfSourceRange(pdfRange(''), root)).toBe(true);
        expect(acceptsPdfSourceRange(pdfRange('<figcaption data-fluentread-pdf-decoration>第 1 页</figcaption>'), root)).toBe(true);
        expect(acceptsPdfSourceRange(pdfRange('<textarea>Manual correction</textarea>'), root)).toBe(false);
        expect(acceptsPdfSourceRange(pdfRange('<div data-fluentread-pdf-translation>Translation</div>'), root)).toBe(false);
        expect(acceptsPdfSourceRange(pdfRange('<div data-fluentread-pdf-text><input value="control"/> <span data-notranslate="true">Protected</span></div>'), root)).toBe(false);
        expect(acceptsPdfSourceRange(pdfRange(`<div data-fluentread-pdf-text>${'<span>x</span>'.repeat(5001)}</div>`), root)).toBe(false);
    });

    it('normalizes layout whitespace and discretionary hyphens without changing authored compound words', () => {
        expect(normalizePdfSelectionText('  Trans\u00adformer\n  self-\nattention\u00a0 models  ')).toBe('Transformer self-attention models');
        expect(normalizePdfSelectionText('state-of-the-art\ntranslation')).toBe('state-of-the-art translation');
    });

    it('extracts only PDF source spans and line boundaries from a cross-page range containing reader labels', () => {
        const {root} = dom('<section data-fluentread-pdf-text><span>First</span></section><section data-fluentread-pdf-text><span>Second</span></section><p>Outside</p>');
        const glyphs = root.querySelectorAll('span');
        const selected = range(glyphs[0].firstChild!, glyphs[1].firstChild!,
            '<section data-fluentread-pdf-text><span>First </span><span>page</span><br><span>footer.</span><span></span></section>'
            + '<figcaption data-fluentread-pdf-decoration>原文 · 第 1 页</figcaption><h3 data-fluentread-pdf-decoration>第 2 页</h3><canvas></canvas>'
            + '<section data-fluentread-pdf-text><span>Second page title.</span></section>');
        const nativeText = 'First page\nfooter.\n原文 · 第 1 页\n第 2 页\nSecond page title.';
        expect(acceptsPdfSourceRange(selected, root)).toBe(true);
        const adapter = createPdfSelectionAdapter(root);
        expect(adapter.normalizeText(adapter.extractText(selected, nativeText))).toBe('First page footer. Second page title.');
        expect(extractPdfSelectionText(range(glyphs[0].firstChild!), 'browser glyph spacing', root)).toBe('browser glyph spacing');
        expect(extractPdfSelectionText(range(root.querySelector('p')!.firstChild!), 'Outside', root)).toBe('');
        expect(extractPdfSelectionText(range(glyphs[0].firstChild!, root.querySelector('p')!.firstChild!), 'Outside', root)).toBe('');
        const protectedRange = range(glyphs[0].firstChild!, glyphs[1].firstChild!,
            'outside fragment text<section data-fluentread-pdf-text><span data-notranslate="true">Protected</span><span data-fluentread-pdf-decoration>Decoration</span><br><span>Source</span></section>');
        expect(adapter.normalizeText(adapter.extractText(protectedRange, 'Protected Decoration Source'))).toBe('Source');
    });

    it('uses the file title and selected page context, excludes query credentials and has no fabricated URL for imported files', () => {
        const {root} = dom('<section data-fluentread-pdf-title="Attention Is All You Need" data-fluentread-pdf-source-url="https://user:password@arxiv.org/pdf/1706.03762?access_token=hidden#page=2"><div data-fluentread-pdf-text data-fluentread-pdf-page-text="The Transformer is based solely on attention. It avoids recurrence."><span>Transformer</span></div></section>');
        const adapter = createPdfSelectionAdapter(root);
        const selected = range(root.querySelector('span')!.firstChild!);
        expect(adapter.context(selected, 'Transformer', 500)).toEqual({
            text: 'The Transformer is based solely on attention. It avoids recurrence.',
            title: 'Attention Is All You Need', sourceUrl: 'https://arxiv.org/pdf/1706.03762',
        });
        expect(adapter.captureReading(selected, 'Transformer', 500).sentence).toBe('The Transformer is based solely on attention.');
        expect(adapter.context(selected, 'Transformer', 0).text).toBe('');
        root.querySelector('section')!.removeAttribute('data-fluentread-pdf-source-url');
        expect(adapter.context(selected, 'Transformer', 500).sourceUrl).toBe('');
        root.querySelector('section')!.setAttribute('data-fluentread-pdf-source-url', 'invalid-url');
        expect(adapter.context(selected, 'Transformer', 500).sourceUrl).toBe('');
        root.querySelector('section')!.setAttribute('data-fluentread-pdf-source-url', 'chrome-extension://id/document-translation.html');
        expect(adapter.context(selected, 'Transformer', 500).sourceUrl).toBe('');
        expect(adapter.captureReading(selected, 'Transformer', 0)).toEqual({text: 'Transformer', context: '', sentence: 'Transformer'});
    });

    it('falls back to page text safely when an imported PDF has no metadata or an empty text layer', () => {
        const {root} = dom('<div data-fluentread-pdf-text><span>Source words</span></div>');
        const source = root.firstElementChild as HTMLElement;
        const selected = range(source.firstChild!.firstChild!);
        const adapter = createPdfSelectionAdapter(root);
        expect(adapter.context(selected, 'Source', 500)).toEqual({text: 'Source words', title: '', sourceUrl: ''});
        Object.defineProperty(source, 'innerText', {get: () => '', configurable: true});
        expect(adapter.context(selected, 'Source', 500).text).toBe('Source words');
        Object.defineProperty(source, 'textContent', {get: () => '', configurable: true});
        expect(adapter.context(selected, 'Source', 500).text).toBe('');
    });
});

function lifecycleFixture(source = true) {
    const {root, window} = dom(source ? '<div data-fluentread-pdf-text>Source text</div>' : '');
    const ready = deferred<void>();
    let enabled = true;
    let notify!: () => void;
    const unsubscribe = vi.fn();
    const mounts: Array<{options: Parameters<DocumentSelectionRuntimeDependencies['mountOverlay']>[0]; pending: ReturnType<typeof deferred<{dispose: () => void} | null>>}> = [];
    const mountOverlay = vi.fn((options: Parameters<DocumentSelectionRuntimeDependencies['mountOverlay']>[0]) => {
        const pending = deferred<{dispose: () => void} | null>();
        mounts.push({options, pending});
        return pending.promise;
    });
    const onError = vi.fn(), onSelectionRangeChange = vi.fn();
    const dependencies: DocumentSelectionRuntimeDependencies = {
        ready: ready.promise, enabled: () => enabled,
        subscribe: listener => {notify = listener; return unsubscribe;}, mountOverlay, onError,
    };
    const runtime = mountDocumentSelectionTranslation({root, onSelectionRangeChange}, dependencies);
    cleanups.push(runtime.dispose);
    return {root, window, ready, mounts, mountOverlay, runtime, unsubscribe, onError, onSelectionRangeChange,
        setEnabled: (next: boolean) => {enabled = next; notify();}};
}

describe('document selection lazy lifecycle', () => {
    it('does not report a rejected overlay mount after disposal has revoked its owner', async () => {
        const f=lifecycleFixture();f.ready.resolve();await tick();expect(f.mountOverlay).toHaveBeenCalledOnce();
        f.runtime.dispose();f.mounts[0].pending.reject(new Error('late overlay module failure'));await tick();
        expect(f.onError).not.toHaveBeenCalled();expect(f.unsubscribe).toHaveBeenCalledOnce();
    });
    it.each([false,true])('reports rejected config readiness only for a live owner (disposed=%s)', async disposed => {
        const f=lifecycleFixture(),failure=new Error('configuration hydration unavailable');
        if(disposed)f.runtime.dispose();f.ready.reject(failure);await tick();
        expect(f.mountOverlay).not.toHaveBeenCalled();
        if(disposed)expect(f.onError).not.toHaveBeenCalled();else expect(f.onError).toHaveBeenCalledWith(failure);
    });
    it('does not load the card before config hydration or while the page has no PDF source text', async () => {
        const fixture = lifecycleFixture(false);
        fixture.runtime.refresh();
        expect(fixture.mountOverlay).not.toHaveBeenCalled();
        fixture.ready.resolve(); await tick();
        expect(fixture.mountOverlay).not.toHaveBeenCalled();
        const source = fixture.root.ownerDocument.createElement('div');
        source.setAttribute('data-fluentread-pdf-text', '');
        fixture.root.append(source); await tick();
        fixture.runtime.refresh();
        expect(fixture.mountOverlay).toHaveBeenCalledOnce();
        fixture.runtime.refresh();
        expect(fixture.mountOverlay).toHaveBeenCalledOnce();
    });

    it('disposes a late disabled generation and does not overwrite a newer enabled mount', async () => {
        const fixture = lifecycleFixture();
        fixture.ready.resolve(); await tick();
        fixture.setEnabled(false);
        expect(fixture.mounts[0].options.isCurrent()).toBe(false);
        fixture.setEnabled(true);
        expect(fixture.mountOverlay).toHaveBeenCalledTimes(2);
        const oldDispose = vi.fn(), currentDispose = vi.fn();
        fixture.mounts[1].pending.resolve({dispose: currentDispose}); await tick();
        fixture.mounts[0].pending.resolve({dispose: oldDispose}); await tick();
        expect(oldDispose).toHaveBeenCalledOnce();
        expect(currentDispose).not.toHaveBeenCalled();
        fixture.runtime.dispose();
        fixture.runtime.dispose();
        expect(currentDispose).toHaveBeenCalledOnce();
        expect(fixture.unsubscribe).toHaveBeenCalledOnce();
    });

    it('releases a mounted overlay when source text disappears and ignores selection callbacks from old mounts', async () => {
        const fixture = lifecycleFixture();
        fixture.ready.resolve(); await tick();
        const dispose = vi.fn();
        fixture.mounts[0].pending.resolve({dispose}); await tick();
        const observed = vi.fn();
        fixture.root.addEventListener(PDF_SELECTION_RANGE_CHANGE, observed);
        const selected = range(fixture.root.querySelector('[data-fluentread-pdf-text]')!.firstChild!);
        fixture.mounts[0].options.onSelectionRangeChange(selected);
        expect(observed).toHaveBeenCalledOnce();
        fixture.root.replaceChildren(); await tick(); fixture.runtime.refresh();
        expect(dispose).toHaveBeenCalledOnce();
        expect(fixture.onSelectionRangeChange).toHaveBeenLastCalledWith(null);
        fixture.mounts[0].options.onSelectionRangeChange(selected);
        expect(observed).toHaveBeenCalledTimes(2); // 当前范围通知和卸载后的 null；旧回调不再通知。
    });

    it('handles pagehide and pending load failures without resurrecting resources', async () => {
        const fixture = lifecycleFixture();
        fixture.ready.resolve(); await tick();
        fixture.window.dispatchEvent(new fixture.window.Event('pagehide'));
        expect(fixture.unsubscribe).toHaveBeenCalledOnce();
        const lateDispose = vi.fn();
        fixture.mounts[0].pending.resolve({dispose: lateDispose}); await tick();
        expect(lateDispose).toHaveBeenCalledOnce();
        fixture.runtime.refresh();
        expect(fixture.mountOverlay).toHaveBeenCalledOnce();
    });

    it('invalidates the old card when a PDF owner changes without an empty DOM frame and when source view is hidden', async () => {
        const fixture = lifecycleFixture();
        const source = fixture.root.querySelector('[data-fluentread-pdf-text]') as HTMLElement;
        source.setAttribute('data-fluentread-pdf-document-id', 'first');
        fixture.ready.resolve(); await tick();
        const dispose = vi.fn();
        fixture.mounts[0].pending.resolve({dispose}); await tick();
        const invalidated = vi.fn();
        fixture.mounts[0].options.adapter.subscribeInvalidation(invalidated);
        const selected = range(source.firstChild!);
        fixture.mounts[0].options.onSelectionRangeChange(selected);
        source.setAttribute('data-fluentread-pdf-document-id', 'second');
        await tick(); fixture.runtime.refresh();
        expect(invalidated).toHaveBeenCalledOnce();
        expect(fixture.onSelectionRangeChange).toHaveBeenLastCalledWith(null);
        expect(dispose).not.toHaveBeenCalled();
        source.style.display = 'none';
        await tick(); fixture.runtime.refresh();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it('reports a current failed mount once and can retry after an explicit refresh', async () => {
        const fixture = lifecycleFixture();
        fixture.ready.resolve(); await tick();
        fixture.mounts[0].pending.reject(new Error('component unavailable')); await tick();
        expect(fixture.onError).toHaveBeenCalledOnce();
        fixture.runtime.refresh();
        expect(fixture.mountOverlay).toHaveBeenCalledTimes(2);
    });

    it('keeps a valid range through unrelated PDF changes but invalidates changed selected characters', async () => {
        const fixture = lifecycleFixture();
        fixture.ready.resolve(); await tick();
        fixture.mounts[0].pending.resolve({dispose: vi.fn()}); await tick();
        const invalidated = vi.fn();
        fixture.mounts[0].options.adapter.subscribeInvalidation(invalidated);
        const selected = range(fixture.root.querySelector('[data-fluentread-pdf-text]')!.firstChild!);
        let selectedText = 'Source text';
        selected.toString = () => selectedText;
        fixture.mounts[0].options.onSelectionRangeChange(selected);
        fixture.runtime.refresh();
        expect(invalidated).not.toHaveBeenCalled();
        selectedText = 'Other file text';
        fixture.runtime.refresh();
        expect(invalidated).toHaveBeenCalledOnce();
    });

    it('keeps a cross-page card when reader labels change but invalidates changed selected source text', async () => {
        const fixture = lifecycleFixture();
        const first = fixture.root.querySelector('[data-fluentread-pdf-text]')!;
        const last = fixture.root.ownerDocument.createElement('div');
        last.setAttribute('data-fluentread-pdf-text', ''); last.textContent = 'Second source'; fixture.root.append(last);
        fixture.ready.resolve(); await tick();
        fixture.mounts[0].pending.resolve({dispose: vi.fn()}); await tick();
        const invalidated = vi.fn();
        fixture.mounts[0].options.adapter.subscribeInvalidation(invalidated);
        let label = '原文 · 第 1 页', text = 'Second source';
        const selected = range(first.firstChild!, last.firstChild!);
        selected.cloneContents = () => {
            const fragment = fixture.root.ownerDocument.createDocumentFragment();
            const wrapper = fixture.root.ownerDocument.createElement('div');
            wrapper.innerHTML = `<div data-fluentread-pdf-text>First source</div><figcaption data-fluentread-pdf-decoration>${label}</figcaption><div data-fluentread-pdf-text>${text}</div>`;
            fragment.append(...Array.from(wrapper.childNodes));
            return fragment;
        };
        selected.toString = () => `First source ${label} ${text}`;
        fixture.mounts[0].options.onSelectionRangeChange(selected);
        label = 'Source · Page 1'; fixture.runtime.refresh();
        expect(invalidated).not.toHaveBeenCalled();
        text = 'Changed source'; fixture.runtime.refresh();
        expect(invalidated).toHaveBeenCalledOnce();
    });

    it('waits for hydration and pending overlay before context-menu translation, then cleans up its message adapter', async () => {
        const {root} = dom('<div data-fluentread-pdf-text>Source text</div>');
        const ready = deferred<void>(), mounting = deferred<{dispose(): void; translateSelection(): boolean}>();
        let translate!: () => Promise<boolean>;
        const stopMenu = vi.fn(), shown = vi.fn(() => true), remove = vi.fn();
        const runtime = mountDocumentSelectionTranslation({root}, {ready: ready.promise, enabled: () => true,
            subscribe: () => () => {}, mountOverlay: () => mounting.promise, onError: vi.fn(),
            installContextMenu: callback => {translate = callback; return stopMenu;}});
        cleanups.push(runtime.dispose);
        const pending = translate();
        expect(shown).not.toHaveBeenCalled();
        ready.resolve(); await tick();
        expect(shown).not.toHaveBeenCalled();
        mounting.resolve({dispose: remove, translateSelection: shown});
        await expect(pending).resolves.toBe(true);
        expect(shown).toHaveBeenCalledOnce();
        runtime.dispose();
        await expect(translate()).resolves.toBe(false);
        expect(stopMenu).toHaveBeenCalledOnce();
        expect(remove).toHaveBeenCalledOnce();
    });
});

describe('extension-page closed shadow mount', () => {
    function prepare() {
        const fixture = dom('<section data-fluentread-pdf-text>Source text</section>');
        const pageStyle = fixture.document.createElement('style');
        pageStyle.textContent = '.fr-translation-tooltip{color:red}';
        const pageLink = fixture.document.createElement('link');
        pageLink.setAttribute('rel', 'stylesheet');
        pageLink.setAttribute('href', 'chrome-extension://fluentread/assets/document.css');
        fixture.document.head.append(pageStyle, pageLink);
        const mounted = {use: vi.fn(), mount: vi.fn(), unmount: vi.fn()};
        ports.createApp.mockReset().mockReturnValue(mounted);
        ports.config.on = true; ports.config.disableSelectionTranslator = false; ports.config.selectionTranslatorMode = 'bilingual';
        return {...fixture, pageStyle, pageLink, mounted};
    }

    it('mounts the reused card with current built styles, keeps a closed root and releases copied styles and app', async () => {
        const fixture = prepare();
        const runtime = mountDocumentSelectionTranslation({root: fixture.root});
        cleanups.push(runtime.dispose);
        await tick(); await vi.dynamicImportSettled(); await tick();
        expect(ports.createApp).toHaveBeenCalledOnce();
        expect(ports.createApp.mock.calls[0][0]).toEqual({name: 'ExistingSelectionTranslator'});
        expect(ports.createApp.mock.calls[0][1].selectionAdapter.acceptsRange).toBeTypeOf('function');
        const host = fixture.root.querySelector('#fluent-read-selection-translator-container')!;
        expect(host.shadowRoot).toBeNull();
        const container = fixture.mounted.mount.mock.calls[0][0];
        const shadow = container.getRootNode() as ShadowRoot;
        expect(shadow.querySelectorAll('link')).toHaveLength(1);
        expect(shadow.querySelectorAll('style')).toHaveLength(2); // 基础隔离加已有构建 CSS。
        fixture.pageStyle.textContent = '.fr-translation-tooltip{color:blue}';
        fixture.pageLink.setAttribute('href', 'chrome-extension://fluentread/assets/current.css');
        await tick();
        expect(Array.from(shadow.querySelectorAll('style')).map(style => style.textContent).join('')).toContain('color:blue');
        expect(shadow.querySelector('link')!.getAttribute('href')).toContain('current.css');
        fixture.pageLink.remove(); await tick();
        expect(shadow.querySelector('link')).toBeNull();
        const lateStyle = fixture.document.createElement('style');
        lateStyle.textContent = '.fr-reading-panel{display:flex}';
        fixture.document.head.append(lateStyle); await tick();
        expect(shadow.querySelectorAll('style')).toHaveLength(3);
        const event = new fixture.window.Event('keydown', {bubbles: true});
        const outside = vi.fn();
        host.addEventListener('keydown', outside);
        container.dispatchEvent(event);
        expect(outside).not.toHaveBeenCalled();
        runtime.dispose(); runtime.dispose();
        expect(fixture.mounted.unmount).toHaveBeenCalledOnce();
        expect(host.isConnected).toBe(false);
        expect(shadow.querySelectorAll('link')).toHaveLength(0);
        expect(shadow.querySelectorAll('style')).toHaveLength(1);
    });

    it('unmounts and removes the shadow host if Vue mounting throws', async () => {
        const fixture = prepare();
        const error = new Error('render failed');
        fixture.mounted.mount.mockImplementation(() => {throw error;});
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        const runtime = mountDocumentSelectionTranslation({root: fixture.root});
        cleanups.push(runtime.dispose);
        await tick(); await vi.dynamicImportSettled(); await tick();
        expect(log).toHaveBeenCalledWith('[FluentRead] PDF 划词卡片挂载失败', error);
        expect(fixture.mounted.unmount).toHaveBeenCalledOnce();
        expect(fixture.root.querySelector('#fluent-read-selection-translator-container')).toBeNull();
    });

    it('does not construct an overlay if the config is disabled while its module is loading', async () => {
        const fixture = prepare();
        let reads = 0;
        Object.defineProperty(ports.config, 'on', {configurable: true, get: () => ++reads === 1});
        cleanups.push(() => Object.defineProperty(ports.config, 'on', {configurable: true, writable: true, value: true}));
        const runtime = mountDocumentSelectionTranslation({root: fixture.root});
        cleanups.push(runtime.dispose);
        await tick(); await vi.dynamicImportSettled(); await tick();
        expect(ports.createApp).not.toHaveBeenCalled();
        expect(fixture.root.querySelector('#fluent-read-selection-translator-container')).toBeNull();
    });

    it('removes a mount disabled synchronously by its Vue setup', async () => {
        const fixture = prepare();
        fixture.mounted.mount.mockImplementation(() => {ports.config.on = false;});
        const runtime = mountDocumentSelectionTranslation({root: fixture.root});
        cleanups.push(runtime.dispose);
        await tick(); await vi.dynamicImportSettled(); await tick();
        expect(fixture.mounted.unmount).toHaveBeenCalledOnce();
        expect(fixture.root.querySelector('#fluent-read-selection-translator-container')).toBeNull();
    });

    it('makes overlay cleanup idempotent if synchronous config notification reenters during app teardown', async () => {
        const fixture = prepare();
        const runtime = mountDocumentSelectionTranslation({root: fixture.root});
        cleanups.push(runtime.dispose);
        await tick(); await vi.dynamicImportSettled(); await tick();
        fixture.mounted.unmount.mockImplementation(runtime.refresh);
        ports.config.on = false;
        runtime.refresh();
        expect(fixture.mounted.unmount).toHaveBeenCalledOnce();
        expect(fixture.root.querySelector('#fluent-read-selection-translator-container')).toBeNull();
    });
});

describe('document-page context menu routing', () => {
    function fixture() {
        const current = deferred<{id?: number} | undefined>();
        const event = {addListener: vi.fn(), removeListener: vi.fn()};
        const runtime = {id: 'fluentread', getURL: (path: string) => `chrome-extension://fluentread${path}`, onMessage: event};
        const translate = vi.fn().mockResolvedValue(true);
        const dispose = installDocumentSelectionContextMenu(translate, {runtime, getCurrentTab: () => current.promise});
        cleanups.push(dispose);
        return {current, event, runtime, translate, dispose};
    }
    const request = {type: 'documentSelectionTranslate', tabId: 18};
    const background = {id: 'fluentread', url: 'chrome-extension://fluentread/background.js'};

    it('registers only for a resolved own tab and rejects other tabs, pages and forged sender identities', async () => {
        const test = fixture();
        expect(test.event.addListener).not.toHaveBeenCalled();
        test.current.resolve({id: 18}); await tick();
        const listener = test.event.addListener.mock.calls[0][0];
        const reply = vi.fn();
        for (const [message, sender] of [
            [null, background], [{type: 'other', tabId: 18}, background], [{...request, tabId: 99}, background],
            [request, {...background, id: 'other'}], [request, {...background, tab: {id: 18}}],
            [request, {...background, url: 'chrome-extension://fluentread/document.html'}],
            [request, {...background, url: 'https://fluentread/background.js'}],
            [request, {...background, url: 'invalid'}],
        ]) expect(listener(message, sender, reply)).toBeUndefined();
        expect(test.translate).not.toHaveBeenCalled();
        expect(listener(request, background, reply)).toBe(true); await tick();
        expect(reply).toHaveBeenCalledWith({status: 'success'});
        reply.mockClear();
        expect(listener(request, {id: 'fluentread'}, reply)).toBe(true); await tick();
        expect(reply).toHaveBeenCalledWith({status: 'success'});
        (test.runtime as {getURL?: (path: string) => string}).getURL = undefined;
        expect(listener(request, background, reply)).toBeUndefined();
        test.dispose(); test.dispose();
        expect(test.event.removeListener).toHaveBeenCalledOnce();
        expect(listener(request, background, reply)).toBeUndefined();
    });

    it.each(['fulfilled','rejected'] as const)('responds accurately and ignores a %s result after disposal', async outcome => {
        const test = fixture();
        test.current.resolve({id: 18}); await tick();
        const listener = test.event.addListener.mock.calls[0][0], reply = vi.fn();
        test.translate.mockResolvedValue(false);
        listener(request, background, reply); await tick();
        expect(reply).toHaveBeenLastCalledWith({status: 'disabled'});
        test.translate.mockRejectedValue(new Error('card unavailable'));
        listener(request, background, reply); await tick();
        expect(reply).toHaveBeenLastCalledWith({status: 'failed'});
        const late = deferred<boolean>();
        test.translate.mockImplementation(() => late.promise);
        reply.mockClear(); listener(request, background, reply);
        test.dispose(); if(outcome==='fulfilled')late.resolve(true);else late.reject(new Error('late translation failure')); await tick();
        expect(reply).not.toHaveBeenCalled();
    });

    it.each([undefined, {}, {id: -1}, {id: 1.5}])('does not install for an unavailable or invalid tab %j', async tab => {
        const test = fixture();
        test.current.resolve(tab); await tick();
        expect(test.event.addListener).not.toHaveBeenCalled();
    });

    it('ignores a late current-tab query after disposal and a failed browser query', async () => {
        const test = fixture();
        test.dispose(); test.current.resolve({id: 18}); await tick();
        expect(test.event.addListener).not.toHaveBeenCalled();
        const failed = fixture();
        failed.current.reject(new Error('tab closed')); await tick();
        expect(failed.event.addListener).not.toHaveBeenCalled();
    });
});

it('allows translated/reflow selection only with the document model owner and forwards capture without generic inference', () => {
    const {root} = dom('<article data-page-number="1"><div data-fluentread-pdf-translation><p class="pdf-translation-text">译文</p></div><p class="pdf-reading-paragraph" data-pdf-segment-index="1">重排</p><button>Control</button></article>');
    const selection = {source: {kind: 'document' as const, fingerprint: 'a'.repeat(32)}, locator: {kind: 'document' as const, page: 1}};
    const capture = vi.fn(() => selection), adapter = createPdfSelectionAdapter(root, capture);
    for (const node of [root.querySelector('.pdf-translation-text')!.firstChild!, root.querySelector('.pdf-reading-paragraph')!.firstChild!]) {
        const picked = range(node); expect(adapter.acceptsRange(picked)).toBe(true); expect(adapter.captureMaterial?.(picked, '选中')).toBe(selection);
    }
    expect(adapter.captureMaterial?.(range(root.querySelector('button')!.firstChild!), 'Control')).toBeUndefined();
    expect(capture).toHaveBeenCalledTimes(2);
});
