/**
 * @file tests/pageTranslationFont.test.ts
 * 文件职责：验证当前页字体恢复的文档隔离、独立样式树覆盖与带文档身份的只读诊断查询。
 * 主要内容：使用真实 DOM 根与渲染器检查已有及后续双语和闭合仅译文样式，验证撤销不改原文或全局配置，并覆盖停用、伪造查询和旧单页写命令的拒绝。
 * 模块边界：供应商网络与扩展平台只提供受控端口；实际字体计算由隔离真实浏览器验收，不把 DOM 样式文本断言当成浏览器排版证明。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';

const mocks = vi.hoisted(() => ({config: {on: true, style: 1, to: 'zh-Hans'}, token: 'current-document'}));
vi.mock('@/src/services/config/store', () => ({config: mocks.config}));
vi.mock('@/src/core/config/catalog', () => ({options: {styles: []}}));
vi.mock('@/src/app/content/features', () => ({getFullPageTranslationDocumentToken: () => mocks.token}));

import {createPageTranslationFontRuntime, PAGE_TRANSLATION_FONT_CSS, PAGE_READING_SYSTEM_FONT_CSS, PAGE_TRANSLATION_FONT_STYLE_ID} from '@/src/app/content/pageTranslationFont';
import {handlePageTranslationFontMessage} from '@/src/app/content/pageTranslationFontMessage';
import {appendBilingualTranslation, appendSingleTranslationSlots} from '@/src/features/full-page-translation/content/renderer';
import {prepareTranslationFontStyleRoot} from '@/src/features/full-page-translation/content/fontStyleRoots';

afterEach(() => {vi.unstubAllGlobals(); mocks.config.on = true; mocks.token = 'current-document';});

function setupDocument() {
    const {document, window} = parseHTML('<html><head></head><body><p id="owner">Translate this text.</p></body></html>');
    const target = document as unknown as Document;
    vi.stubGlobal('document', target); vi.stubGlobal('window', window);
    for (const name of ['Node', 'HTMLElement', 'Element', 'ShadowRoot']) vi.stubGlobal(name, (window as unknown as Record<string, unknown>)[name]);
    vi.stubGlobal('DOMParser', class {
        parseFromString(value: string) {return parseHTML(`<html><head></head><body>${value}</body></html>`).document;}
    });
    return target;
}

function styleIn(root: Document | ShadowRoot) {return root.querySelector(`#${PAGE_TRANSLATION_FONT_STYLE_ID}`);}

describe('当前文档浏览器默认译文字体', () => {
    it('回放已有开放与闭合根并覆盖后续译文，关闭只撤下字体样式且保留原文和既有内联字体', () => {
        const document = setupDocument();
        const owner = document.getElementById('owner')!;
        const source = owner.firstChild as Text;
        const original = source.nodeValue;
        const bilingual = appendBilingualTranslation(owner, '<strong>已翻译</strong><code>code()</code>');
        bilingual.style.fontFamily = 'Fixture CJK';
        const openHost = document.createElement('section'); document.body.appendChild(openHost);
        const open = openHost.attachShadow({mode: 'open'});
        const nested = document.createElement('p'); open.appendChild(nested);
        appendBilingualTranslation(nested, '组件译文');
        const closedRoots: ShadowRoot[] = [];
        const nativeAttach = document.createElement('span').attachShadow;
        const spy = vi.spyOn(document.defaultView!.Element.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, options) {
            const root = nativeAttach.call(this, options);
            if (options.mode === 'closed') closedRoots.push(root);
            return root;
        });
        const hosts = appendSingleTranslationSlots(owner, [{node: source, text: '仅译文'}]);
        const closed = closedRoots[0]!;
        const snapshot = owner.innerHTML;
        const change = vi.fn();
        const runtime = createPageTranslationFontRuntime({document, onChange: change});
        const scan = vi.spyOn(document, 'querySelectorAll').mockImplementation(() => {throw new Error('不得扫描整个页面');});
        expect(runtime.read()).toBe(false);
        expect(runtime.set(true)).toBe(true);
        expect(runtime.read()).toBe(true);
        for (const root of [document, open, closed]) expect(styleIn(root)?.textContent).toBe(PAGE_TRANSLATION_FONT_CSS);
        expect(hosts[0]!.shadowRoot).toBeNull();
        expect(closed.querySelector('.fluent-read-single-content')?.textContent).toBe('仅译文');
        const nextOwner = document.createElement('p'); nextOwner.textContent = 'New source'; document.body.appendChild(nextOwner);
        appendSingleTranslationSlots(nextOwner, [{node: nextOwner.firstChild as Text, text: '后续译文'}]);
        expect(styleIn(closedRoots[1]!)).not.toBeNull();
        expect(runtime.set(true)).toBe(true);
        expect(document.querySelectorAll).toBe(scan);
        expect(change).toHaveBeenCalledOnce();
        runtime.reset();
        for (const root of [document, open, closed, closedRoots[1]!]) expect(styleIn(root)).toBeNull();
        expect(owner.innerHTML).toBe(snapshot);
        expect(source.nodeValue).toBe(original);
        expect(bilingual.style.fontFamily).toBe('Fixture CJK');
        expect(change).toHaveBeenLastCalledWith(false);
        runtime.dispose(); runtime.dispose();
        expect(runtime.set(true)).toBe(false);
        scan.mockRestore(); spy.mockRestore();
    });

    it('只向所属文档安装，根反复登记幂等，宿主删除自有style后可补装，停用后不再注入', () => {
        const document = setupDocument();
        const other = parseHTML('<html><head></head><body></body></html>').document as unknown as Document;
        const runtime = createPageTranslationFontRuntime({document}); runtime.set(true);
        prepareTranslationFontStyleRoot(other);
        expect(styleIn(other)).toBeNull();
        const host = document.createElement('section'); document.body.appendChild(host);
        const root = host.attachShadow({mode: 'open'});
        for (let count = 0; count < 128; count++) prepareTranslationFontStyleRoot(root);
        expect(root.querySelectorAll(`#${PAGE_TRANSLATION_FONT_STYLE_ID}`)).toHaveLength(1);
        const style = styleIn(root)!; style.remove();
        prepareTranslationFontStyleRoot(root); expect(styleIn(root)).toBe(style);
        runtime.dispose();
        prepareTranslationFontStyleRoot(root); expect(styleIn(root)).toBeNull();
        expect(styleIn(document)).toBeNull();
    });

    it('覆盖正文后代同时明确排除代码和公式字体，不改大小颜色或持久化配置', () => {
        expect(PAGE_TRANSLATION_FONT_CSS).toContain('font-family: initial !important');
        expect(PAGE_TRANSLATION_FONT_CSS).toContain('.fluent-read-bilingual-content');
        expect(PAGE_TRANSLATION_FONT_CSS).toContain('.fluent-read-single-content');
        for (const boundary of ['code', 'pre', 'kbd', 'samp', 'var', 'math', 'mjx-container', 'MathJax', '.katex', '.mwe-math-element', '.ltx_Math']) {
            expect(PAGE_TRANSLATION_FONT_CSS).toContain(boundary);
        }
        expect(PAGE_TRANSLATION_FONT_CSS).not.toMatch(/font-size|color|system-ui/);
    });

    it('document_start 缺少head仍能恢复字体并在销毁后清理', () => {
        const document = setupDocument();
        Object.defineProperty(document, 'head', {get: () => null});
        const runtime = createPageTranslationFontRuntime({document});
        runtime.set(true);
        expect(styleIn(document)?.parentNode).toBe(document.documentElement);
        runtime.dispose();
        expect(styleIn(document)).toBeNull();
    });

    it('根登记不持有卸载组件，回放与周期回收都会清除已经死亡的弱引用', async () => {
        vi.resetModules();
        const references: Array<{value: object | undefined}> = [];
        vi.stubGlobal('WeakRef', class {
            value: object | undefined;
            constructor(value: object) {this.value = value; references.push(this);}
            deref() {return this.value;}
        });
        const {prepareTranslationFontStyleRoot: register, subscribeTranslationFontStyleRoots: subscribe} =
            await import('@/src/features/full-page-translation/content/fontStyleRoots');
        const document = setupDocument();
        register(document);
        references[0]!.value = undefined;
        const listener = vi.fn(); const unsubscribe = subscribe(listener);
        expect(listener).not.toHaveBeenCalled();
        for (let index = 0; index < 63; index++) {
            const root = document.createElement('section').attachShadow({mode: 'open'});
            register(root);
            // 下次批量回收同时遇到存活与死亡引用。
            if (index === 0) references[1]!.value = undefined;
        }
        expect(listener).toHaveBeenCalledTimes(63);
        unsubscribe(); listener.mockClear();
        const remove = subscribe(listener);
        expect(listener).toHaveBeenCalledTimes(62);
        remove();
        vi.unstubAllGlobals();
    });

    it('字体开启后的无限滚动周期回收失去style的弱引用，销毁无需再次访问已回收项', async () => {
        vi.resetModules();
        const references: Array<{value: object | undefined; reads: number}> = [];
        vi.stubGlobal('WeakRef', class {
            reads = 0;
            value: object | undefined;
            constructor(value: object) {this.value = value; references.push(this);}
            deref() {this.reads++; return this.value;}
        });
        const {createPageTranslationFontRuntime: create} = await import('@/src/app/content/pageTranslationFont');
        const {prepareTranslationFontStyleRoot: register} = await import('@/src/features/full-page-translation/content/fontStyleRoots');
        const document = setupDocument();
        const runtime = create({document}); runtime.set(true);
        const dead = references.find(reference => (reference.value as Element)?.localName === 'style')!;
        styleIn(document)!.remove(); dead.value = undefined;
        for (let index = 0; index < 63; index++) register(document.createElement('section').attachShadow({mode: 'open'}));
        const readsAfterPrune = dead.reads;
        expect(readsAfterPrune).toBeGreaterThan(0);
        runtime.dispose();
        expect(dead.reads).toBe(readsAfterPrune);
        vi.unstubAllGlobals();
    });
});

describe('当前页译文字体消息身份与生命周期门禁', () => {
    function setup() {
        const document = setupDocument();
        vi.stubGlobal('window', {location: {href: 'https://example.com/article#section'}});
        vi.stubGlobal('browser', {runtime: {id: 'own-extension'}});
        const pageTranslationFont = createPageTranslationFontRuntime({document});
        const ctx = {isInvalid: false};
        const state = {isSiteDisabled: () => false, isPageSuspended: () => false, pageTranslationFont};
        const response = vi.fn();
        const handle = (payload: Record<string, unknown>, sender: unknown = {id: 'own-extension'}) =>
            handlePageTranslationFontMessage(payload, sender, ctx as never, state, response);
        return {pageTranslationFont, ctx, state, response, handle};
    }

    it('查询返回全局偏好已应用的实际状态和文档身份，不接受旧单页写命令', () => {
        const {pageTranslationFont, handle, response} = setup();
        expect(handle({type: 'unrelated'})).toBeUndefined();
        expect(handle({type: 'getPageTranslationFontState'})).toBe(true);
        const snapshot = {status: 'success', browserDefault: false, documentToken: mocks.token, pageUrl: 'https://example.com/article#section'};
        expect(response).toHaveBeenLastCalledWith(snapshot);
        pageTranslationFont.set(true);
        handle({type: 'getPageTranslationFontState'});
        expect(response).toHaveBeenLastCalledWith({...snapshot, browserDefault: true});
        response.mockClear();
        for (const oldCommand of [
            {type: 'setPageTranslationFont', ...snapshot, browserDefault: false},
            {type: 'setPageTranslationFont', browserDefault: 'yes'},
        ]) expect(handle(oldCommand)).toBeUndefined();
        expect(response).not.toHaveBeenCalled();
        expect(pageTranslationFont.read()).toBe(true);
        pageTranslationFont.dispose();
    });

    it('拒绝其他扩展、缺失sender、失效和停用上下文、缺失控制器及非法参数', () => {
        const {pageTranslationFont, handle, response, ctx, state} = setup();
        const get = {type: 'getPageTranslationFontState'};
        for (const sender of [null, {}, {id: 'other-extension'}]) {
            handle(get, sender); expect(response).toHaveBeenLastCalledWith({status: 'unavailable'});
        }
        ctx.isInvalid = true; handle(get); expect(response).toHaveBeenLastCalledWith({status: 'unavailable'}); ctx.isInvalid = false;
        mocks.config.on = false; handle(get); expect(response).toHaveBeenLastCalledWith({status: 'unavailable'}); mocks.config.on = true;
        state.isPageSuspended = () => true; handle(get); expect(response).toHaveBeenLastCalledWith({status: 'unavailable'}); state.isPageSuspended = () => false;
        state.isSiteDisabled = () => true; handle(get); expect(response).toHaveBeenLastCalledWith({status: 'disabled'}); state.isSiteDisabled = () => false;
        handlePageTranslationFontMessage(get, {id: 'own-extension'}, ctx as never, {isSiteDisabled: () => false}, response);
        expect(response).toHaveBeenLastCalledWith({status: 'unavailable'});
        Object.defineProperty(browser.runtime, 'id', {get: () => {throw new Error('Extension context invalidated');}});
        handle(get); expect(response).toHaveBeenLastCalledWith({status: 'unavailable'});
        expect(pageTranslationFont.read()).toBe(false);
        pageTranslationFont.dispose();
    });
});


describe('阅读系统字体与浏览器默认译文字体共享样式所有权', () => {
    it.each([[false, false], [false, true], [true, false], [true, true]])('default=%s reading=%s 的优先级及重置', (browserDefault, readingSystem) => {
        const document = setupDocument(); const runtime = createPageTranslationFontRuntime({document});
        runtime.setReadingSystem(readingSystem); runtime.set(browserDefault);
        const style = document.getElementById(PAGE_TRANSLATION_FONT_STYLE_ID);
        expect(style?.textContent ?? '').toBe(browserDefault ? PAGE_TRANSLATION_FONT_CSS : readingSystem ? PAGE_READING_SYSTEM_FONT_CSS : '');
        expect(runtime.read()).toBe(browserDefault);
        runtime.reset(); expect(document.getElementById(PAGE_TRANSLATION_FONT_STYLE_ID)).toBeNull();
        runtime.dispose(); expect(runtime.setReadingSystem(true)).toBe(false);
    });
    it('已有和后续样式根立即切换模式，关闭全局偏好后恢复仍开启的阅读字体', () => {
        const document = setupDocument(); const runtime = createPageTranslationFontRuntime({document});
        const host = document.createElement('span'); document.body.append(host);
        const root = host.attachShadow({mode: 'closed'}); prepareTranslationFontStyleRoot(root);
        runtime.setReadingSystem(true);
        expect(root.querySelector('style')!.textContent).toBe(PAGE_READING_SYSTEM_FONT_CSS);
        runtime.set(true); expect(root.querySelector('style')!.textContent).toBe(PAGE_TRANSLATION_FONT_CSS);
        runtime.setReadingSystem(false); expect(root.querySelector('style')!.textContent).toBe(PAGE_TRANSLATION_FONT_CSS);
        runtime.setReadingSystem(true); runtime.set(false);
        expect(root.querySelector('style')!.textContent).toBe(PAGE_READING_SYSTEM_FONT_CSS);
        const later = document.createElement('span').attachShadow({mode: 'open'});
        prepareTranslationFontStyleRoot(later); expect(later.querySelector('style')!.textContent).toBe(PAGE_READING_SYSTEM_FONT_CSS);
        runtime.setReadingSystem(false); expect(root.querySelector('style')).toBeNull(); expect(later.querySelector('style')).toBeNull();
        runtime.dispose();
    });
});
