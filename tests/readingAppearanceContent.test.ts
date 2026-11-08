/**
 * @file tests/readingAppearanceContent.test.ts
 * 文件职责：验证阅读字体会话的正文选择、非正文继承保护和可逆生命周期。
 * 主要内容：用真实 DOM 节点及可控样式/观察器端口覆盖动态译文、闭合根、宿主样式更新、移除、反复启停和释放。
 * 模块边界：不模拟浏览器排版或声称验证像素效果；样式端口显式补齐 linkedom 未实现的级联和 important 优先级。
 */
import {parseHTML} from 'linkedom';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {registerVisibleTranslationRoot} from '@/src/features/full-page-translation/content/visibleTranslation';
import {createReadingAppearanceController, READING_APPEARANCE_FONT} from '@/src/features/reading-appearance/content';

const patchedPriorityPrototypes = new Set<object>();
function fixture(html: string) {
    const {document, window} = parseHTML(`<html><head></head><body>${html}</body></html>`);
    const observers: Array<{callback: MutationCallback; roots: Node[]; active: boolean}> = [];
    const priorities = new WeakMap<object, Map<string, string>>();
    const prototype = Object.getPrototypeOf(document.body.style) as Pick<CSSStyleDeclaration,
        'getPropertyValue' | 'setProperty' | 'removeProperty' | 'getPropertyPriority'>;
    if (!prototype.getPropertyPriority) {
        Object.defineProperty(prototype, 'getPropertyPriority', {configurable: true, value() {return '';}});
        patchedPriorityPrototypes.add(prototype);
    }
    const nativeGet = prototype.getPropertyValue, nativeSet = prototype.setProperty, nativeRemove = prototype.removeProperty;
    // CSSOM returns an empty string for a missing property; linkedom may return undefined.
    vi.spyOn(prototype, 'getPropertyValue').mockImplementation(function(this: object, key: string) {
        return nativeGet.call(this, key) ?? '';
    });
    vi.spyOn(prototype, 'setProperty').mockImplementation(function(this: object, key: string, value: string | null, priority?: string) {
        let map = priorities.get(this); if (!map) {map = new Map(); priorities.set(this, map);} map.set(key, priority || '');
        return nativeSet.call(this, key, value);
    });
    vi.spyOn(prototype, 'removeProperty').mockImplementation(function(this: object, key: string) {
        priorities.get(this)?.delete(key);
        return nativeRemove.call(this, key) ?? '';
    });
    vi.spyOn(prototype, 'getPropertyPriority').mockImplementation(function(this: object, key: string) {return priorities.get(this)?.get(key) || '';});
    const Observer = class {
        entry: typeof observers[number];
        constructor(callback: MutationCallback) {this.entry = {callback, roots: [], active: false}; observers.push(this.entry);}
        observe(root: Node) {this.entry.active = true; this.entry.roots.push(root);}
        disconnect() {this.entry.active = false; this.entry.roots = [];}
    };
    const family = (element: Element | null): string => element?.hasAttribute('data-empty-family') ? '' : element ? (element as HTMLElement).style.fontFamily || element.getAttribute('data-family') || family(element.parentElement) : 'Georgia';
    const view = new Proxy(window, {get(target, key) {
        if (key === 'MutationObserver') return Observer;
        if (key === 'getComputedStyle') return (element: HTMLElement, pseudo?: string) => ({fontFamily: family(element), display: element.style.display || 'block', visibility: 'visible', content: pseudo ? element.getAttribute('data-pseudo') || 'none' : 'normal'});
        if (key === 'setTimeout') return (callback: () => void, ms: number) => setTimeout(callback, ms);
        if (key === 'clearTimeout') return (id: number) => clearTimeout(id);
        return Reflect.get(target, key);
    }});
    Object.defineProperty(document, 'defaultView', {value: view});
    const element = (id: string) => document.getElementById(id)! as unknown as HTMLElement;
    const mutate = () => {for (const observer of observers) if (observer.active) observer.callback([], {} as MutationObserver); vi.advanceTimersByTime(60);};
    return {document: document as unknown as Document, element, observers, mutate};
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
    vi.restoreAllMocks(); vi.useRealTimers();
    for (const prototype of patchedPriorityPrototypes) Reflect.deleteProperty(prototype, 'getPropertyPriority');
    patchedPriorityPrototypes.clear();
});

describe('reading appearance content controller', () => {
    it('delegates real font writes and reversible style cleanup through the injected port', () => {
        const f = fixture('<article><p id="normal" style="font-family: Georgia; color: red">Normal-priority reading text.</p><p id="important" style="font-family: Times New Roman; color: green">Important-priority reading text.</p><p id="colored" style="color: blue">Reading text with an unrelated style.</p><p id="clean">Reading text without an inline style.</p></article>');
        const normal = f.element('normal'), important = f.element('important');
        const colored = f.element('colored'), clean = f.element('clean');
        normal.style.setProperty('font-family', 'Georgia', '');
        important.style.setProperty('font-family', 'Times New Roman', 'important');
        expect(clean.hasAttribute('style')).toBe(false);
        expect(colored.hasAttribute('style')).toBe(true);
        const originals = [normal, important, colored, clean].map(element => element.firstChild);
        // The injected port must perform the actual DOM write; an empty spy cannot satisfy these assertions.
        const writeFontFamily = vi.fn((element: HTMLElement, value: string, priority: string, removeEmptyStyle: boolean) => {
            if (value) element.style.setProperty('font-family', value, priority);
            else element.style.removeProperty('font-family');
            if (removeEmptyStyle && !element.getAttribute('style')) element.removeAttribute('style');
        });
        const controller = createReadingAppearanceController(f.document, {writeFontFamily});
        try {
            expect(writeFontFamily).not.toHaveBeenCalled();
            controller.setEnabled(true);
            expect(writeFontFamily).toHaveBeenCalledTimes(4);
            for (const element of [normal, important, colored, clean]) {
                expect(writeFontFamily).toHaveBeenCalledWith(element, READING_APPEARANCE_FONT, 'important', false);
                expect(element.style.fontFamily).toBe(READING_APPEARANCE_FONT);
                expect(element.style.getPropertyPriority('font-family')).toBe('important');
            }
            expect(normal.style.color).toBe('red'); expect(important.style.color).toBe('green');
            expect(colored.style.color).toBe('blue');
            writeFontFamily.mockClear();
            controller.setEnabled(false);
            expect(writeFontFamily).toHaveBeenCalledTimes(4);
            expect(writeFontFamily).toHaveBeenCalledWith(normal, 'Georgia', '', false);
            expect(writeFontFamily).toHaveBeenCalledWith(important, 'Times New Roman', 'important', false);
            expect(writeFontFamily).toHaveBeenCalledWith(colored, '', '', false);
            expect(writeFontFamily).toHaveBeenCalledWith(clean, '', '', true);
            expect(normal.style.fontFamily).toBe('Georgia');
            expect(normal.style.getPropertyPriority('font-family')).toBe('');
            expect(important.style.fontFamily).toBe('Times New Roman');
            expect(important.style.getPropertyPriority('font-family')).toBe('important');
            expect(normal.style.color).toBe('red'); expect(important.style.color).toBe('green');
            expect(colored.style.fontFamily).toBeFalsy(); expect(colored.style.color).toBe('blue');
            expect(colored.hasAttribute('style')).toBe(true); expect(clean.hasAttribute('style')).toBe(false);
            [normal, important, colored, clean].forEach((element, index) => expect(element.firstChild).toBe(originals[index]));
            expect(f.observers.every(observer => !observer.active)).toBe(true);
        } finally {controller.dispose();}
    });
    it('starts disabled and restores original inline families, priority, unrelated styles and text identity', () => {
        const f = fixture('<article><p id="p" style="font-family: Georgia; color: red">Readable paragraph <em id="em">with emphasis</em>.</p><p id="clean">Another paragraph.</p></article>');
        const p = f.element('p'), original = p.firstChild;
        p.style.setProperty('font-family', 'Georgia', 'important');
        const controller = createReadingAppearanceController(f.document);
        expect(f.observers).toHaveLength(0);
        expect(p.style.fontFamily).toBe('Georgia');
        controller.setEnabled(true);
        expect(p.style.fontFamily).toBe(READING_APPEARANCE_FONT);
        expect(f.element('em').style.fontFamily).toBe(READING_APPEARANCE_FONT);
        expect(p.firstChild).toBe(original);
        expect(p.style.color).toBe('red');
        controller.setEnabled(false);
        expect(p.style.fontFamily).toBe('Georgia');
        expect(p.style.getPropertyPriority('font-family')).toBe('important');
        expect(f.element('clean').hasAttribute('style')).toBe(false);
        expect(f.observers.every(observer => !observer.active)).toBe(true);
        controller.dispose();
    });
    it('protects icons, private glyphs, monospace, formulas, controls and nested UI from changed inheritance', () => {
        const f = fixture('<p id="p">Ordinary readable text <span id="icon" data-family="Material Symbols Rounded">settings</span><span id="private">&#xe001;</span><code id="code">const x = 1</code><span id="mono" data-family="Consolas">fixed width</span><span class="katex" id="math">a + b</span><button id="button">Press me</button><span data-fluent-read-ui id="ui">Extension UI</span></p><nav><p id="nav">Navigation text</p></nav><div contenteditable="true"><p id="edit">Editable paragraph</p></div>');
        const controller = createReadingAppearanceController(f.document);
        controller.setEnabled(true);
        expect(f.element('p').style.fontFamily).toBe(READING_APPEARANCE_FONT);
        expect(f.element('icon').style.fontFamily).toBe('Material Symbols Rounded');
        expect(f.element('mono').style.fontFamily).toBe('Consolas');
        for (const id of ['private', 'code', 'math', 'button', 'ui']) expect(f.element(id).style.fontFamily).toBe('Georgia');
        for (const id of ['nav', 'edit']) expect(f.element(id).style.fontFamily).toBeFalsy();
        controller.dispose();
        expect(f.element('icon').hasAttribute('style')).toBe(false);
    });
    it('conservatively skips pseudo-element hosts and symbol/monospace prose', () => {
        const f = fixture('<p id="pseudo" data-pseudo="&#34;home&#34;">Text with generated icon</p><p id="symbols" data-family="Custom Icons">An icon ligature</p><p id="mono" data-family="monospace">Text in a monospace font</p>');
        const controller = createReadingAppearanceController(f.document); controller.setEnabled(true);
        for (const id of ['pseudo', 'symbols', 'mono']) expect(f.element(id).style.fontFamily).toBeFalsy();
        controller.dispose();
    });
    it('leaves owned translations to the shared font stylesheet while observing source changes', () => {
        const f = fixture('<p id="p">Original paragraph</p><span id="host"></span>');
        const host = f.element('host'), root = host.attachShadow({mode: 'closed'});
        host.className = 'fluent-read-single-slot'; host.setAttribute('data-fr-translation-owned', 'true'); host.setAttribute('translate', 'no');
        registerVisibleTranslationRoot(host, root);
        root.innerHTML = '<span>Translated words</span>';
        const controller = createReadingAppearanceController(f.document);
        controller.setEnabled(true);
        expect((root.firstChild as HTMLElement).style.fontFamily).toBeFalsy();
        expect(f.observers[0].roots).not.toContain(root);
        const translated = f.document.createElement('span'); translated.className = 'fluent-read-bilingual-content'; translated.textContent = '译文正文';
        f.document.body.append(translated); f.mutate();
        expect(translated.style.fontFamily).toBeFalsy();
        f.element('p').style.setProperty('font-family', 'Courier New'); f.mutate();
        expect(f.element('p').style.fontFamily).toBe('Courier New');
        translated.remove(); f.mutate();
        expect(translated.style.fontFamily).toBeFalsy();
        host.remove(); f.mutate();
        expect(f.observers[0].roots).not.toContain(root);
        controller.dispose();
        expect(f.element('p').style.fontFamily).toBe('Courier New');
    });
    it('ignores layout-only style changes from translation observers', () => {
        const f = fixture('<p id="p">Original paragraph</p>');
        const controller = createReadingAppearanceController(f.document); controller.setEnabled(true);
        const p = f.element('p'), oldValue = p.getAttribute('style');
        p.style.height = '100px';
        f.observers[0].callback([{type: 'attributes', attributeName: 'style', target: p, oldValue} as unknown as MutationRecord], {} as MutationObserver);
        expect(vi.getTimerCount()).toBe(0);
        p.style.fontFamily = 'Arial';
        f.observers[0].callback([{type: 'attributes', attributeName: 'style', target: p, oldValue} as unknown as MutationRecord], {} as MutationObserver);
        expect(vi.getTimerCount()).toBe(1);
        controller.dispose();
    });
    it('supports generic long prose, empty computed families and non-style mutations', () => {
        const f = fixture('<div id="long">This is a long ordinary prose container outside a semantic article element.</div><div id="short">Menu</div><p id="p">Text <code id="empty" data-empty-family>code</code></p>');
        const controller = createReadingAppearanceController(f.document); controller.setEnabled(true);
        expect(f.element('long').style.fontFamily).toBe(READING_APPEARANCE_FONT);
        expect(f.element('short').style.fontFamily).toBeFalsy();
        expect(f.element('empty').style.fontFamily).toBeFalsy();
        f.observers[0].callback([{type: 'childList', target: f.document.body, addedNodes: [], removedNodes: []} as unknown as MutationRecord], {} as MutationObserver);
        vi.advanceTimersByTime(60);
        f.observers[0].callback([{type: 'attributes', attributeName: 'class', target: f.element('p')} as unknown as MutationRecord], {} as MutationObserver);
        vi.advanceTimersByTime(60);
        f.observers[0].callback([{type: 'attributes', attributeName: 'style', target: f.element('short'), oldValue: null} as unknown as MutationRecord], {} as MutationObserver);
        expect(vi.getTimerCount()).toBe(0);
        controller.dispose();
    });
    it('ignores protected clock and hover changes and styles new paragraphs without rewriting unrelated prose', () => {
        const f = fixture('<nav><span id="clock">12:00</span></nav><article><p id="stable">An unchanged reading paragraph.</p></article>');
        const controller = createReadingAppearanceController(f.document); controller.setEnabled(true);
        const stable = f.element('stable'), set = vi.mocked(stable.style.setProperty);
        set.mockClear();
        const callback = f.observers[0].callback;
        callback([{type: 'characterData', target: f.element('clock').firstChild} as unknown as MutationRecord], {} as MutationObserver);
        callback([{type: 'attributes', attributeName: 'class', target: f.element('clock')} as unknown as MutationRecord], {} as MutationObserver);
        expect(vi.getTimerCount()).toBe(0);
        expect(set).not.toHaveBeenCalled();
        const added = f.document.createElement('p'); added.textContent = 'A newly inserted reading paragraph.';
        stable.parentElement!.append(added);
        callback([{type: 'childList', target: stable.parentElement!, addedNodes: [added], removedNodes: []} as unknown as MutationRecord], {} as MutationObserver);
        vi.advanceTimersByTime(60);
        expect(added.style.fontFamily).toBe(READING_APPEARANCE_FONT);
        expect(set.mock.contexts.some(context => context === stable.style)).toBe(false);
        expect(stable.style.fontFamily).toBe(READING_APPEARANCE_FONT);
        controller.dispose();
    });
    it('recomputes affected text containers and collapses overlapping dirty subtrees', () => {
        const f = fixture('<article id="article"><div id="empty"></div><p id="p">A paragraph <em id="em">emphasis</em></p></article><span role="button" id="control">Action</span>');
        const controller = createReadingAppearanceController(f.document); controller.setEnabled(true);
        const callback = f.observers[0].callback;
        callback([{type: 'attributes', attributeName: 'class', target: f.element('article')}, {type: 'attributes', attributeName: 'class', target: f.element('p')}, {type: 'attributes', attributeName: 'class', target: f.element('em')}] as unknown as MutationRecord[], {} as MutationObserver);
        vi.advanceTimersByTime(60);
        const added = f.document.createTextNode('Newly added text'), comment = f.document.createComment('comment');
        f.element('empty').append(added, comment);
        callback([{type: 'childList', target: f.element('empty'), addedNodes: [added, comment], removedNodes: []}] as unknown as MutationRecord[], {} as MutationObserver);
        vi.advanceTimersByTime(60);
        expect(f.element('empty').style.fontFamily).toBe(READING_APPEARANCE_FONT);
        const text = f.document.createTextNode('temporary'); f.element('article').append(text); text.remove();
        callback([{type: 'childList', target: f.element('article'), addedNodes: [], removedNodes: [text]}] as unknown as MutationRecord[], {} as MutationObserver);
        vi.advanceTimersByTime(60);
        callback([{type: 'characterData', target: f.element('control').firstChild}, {type: 'childList', target: f.document}] as unknown as MutationRecord[], {} as MutationObserver);
        expect(vi.getTimerCount()).toBe(0);
        controller.dispose();
    });
    it('handles stylesheet invalidation, global events and a document without a body', () => {
        const f = fixture('<p id="p">A paragraph</p>');
        const controller = createReadingAppearanceController(f.document); controller.setEnabled(true);
        const callback = f.observers[0].callback;
        const style = f.document.createElement('style'); f.document.head.append(style);
        callback([{type: 'childList', target: f.document.head, addedNodes: [style], removedNodes: []}] as unknown as MutationRecord[], {} as MutationObserver);
        vi.advanceTimersByTime(60);
        f.document.dispatchEvent(new f.document.defaultView!.Event('fluentread-translation-started'));
        expect(vi.getTimerCount()).toBe(1); vi.advanceTimersByTime(60);
        callback([{type: 'attributes', attributeName: 'class', target: f.document.documentElement}] as unknown as MutationRecord[], {} as MutationObserver);
        vi.advanceTimersByTime(60);
        controller.setEnabled(false); Object.defineProperty(f.document, 'body', {value: null}); controller.setEnabled(true);
        expect(f.observers.at(-1)!.active).toBe(true);
        controller.dispose();
    });
    it('never pins owned closed-root hosts and preserves newly protected source fonts', () => {
        const f = fixture('<p id="p">Original paragraph <span id="changing">Inline prose</span><span id="host"></span></p>');
        const host = f.element('host'), root = host.attachShadow({mode: 'closed'});
        host.className = 'fluent-read-single-slot'; host.setAttribute('data-fr-translation-owned', 'true');
        registerVisibleTranslationRoot(host, root);
        const controller = createReadingAppearanceController(f.document); controller.setEnabled(true);
        expect(host.style.fontFamily).toBeFalsy();
        const translated = f.document.createElement('span'); translated.textContent = 'Later translated text'; root.append(translated);
        f.observers[0].callback([{type: 'childList', target: root, addedNodes: [translated], removedNodes: []}] as unknown as MutationRecord[], {} as MutationObserver);
        vi.advanceTimersByTime(60);
        expect(translated.style.fontFamily).toBeFalsy();
        f.element('changing').setAttribute('role', 'button');
        f.observers[0].callback([{type: 'attributes', attributeName: 'role', target: f.element('changing')}] as unknown as MutationRecord[], {} as MutationObserver);
        vi.advanceTimersByTime(60);
        expect(f.element('changing').style.fontFamily).toBe('Georgia');
        const added = f.document.createElement('span'); added.textContent = 'New prose'; f.element('p').append(added);
        f.observers[0].callback([{type: 'attributes', attributeName: 'class', target: added}] as unknown as MutationRecord[], {} as MutationObserver);
        vi.advanceTimersByTime(60);
        expect(added.style.fontFamily).toBe(READING_APPEARANCE_FONT);
        controller.dispose();
    });
    it('restores the affected inherited-font ancestor before recomputing nested controls and inherited code', () => {
        const f = fixture('<p id="p">Text <span id="scope">prose <span role="button" id="action">Action</span><code id="code">x</code></span></p><p id="unrelated">Other paragraph</p>');
        const controller = createReadingAppearanceController(f.document); controller.setEnabled(true);
        expect(f.element('code').style.fontFamily).toBe('Georgia');
        expect(f.element('action').style.fontFamily).toBe('Georgia');
        const set = vi.mocked(f.element('p').style.setProperty); set.mockClear();
        f.element('scope').className = 'changed';
        f.observers[0].callback([{type: 'attributes', attributeName: 'class', target: f.element('scope')}] as unknown as MutationRecord[], {} as MutationObserver);
        vi.advanceTimersByTime(60);
        expect(f.element('code').style.fontFamily).toBe('Georgia');
        expect(f.element('action').style.fontFamily).toBe('Georgia');
        expect(set.mock.contexts.some(context => context === f.element('unrelated').style)).toBe(false);
        controller.dispose();
    });
    it('rechecks eligibility and author styles, coalesces work, cancels pending updates and cannot restart after disposal', () => {
        const f = fixture('<p id="p">Original paragraph</p>');
        const controller = createReadingAppearanceController(f.document);
        controller.setEnabled(true); controller.setEnabled(true);
        expect(f.observers).toHaveLength(1);
        f.element('p').setAttribute('role', 'button'); f.mutate();
        expect(f.element('p').style.fontFamily).toBeFalsy();
        f.element('p').removeAttribute('role'); f.mutate();
        expect(f.element('p').style.fontFamily).toBe(READING_APPEARANCE_FONT);
        f.observers[0].callback([], {} as MutationObserver); f.observers[0].callback([], {} as MutationObserver);
        expect(vi.getTimerCount()).toBe(1);
        controller.setEnabled(false); expect(vi.getTimerCount()).toBe(0);
        controller.setEnabled(true); controller.dispose(); controller.setEnabled(true);
        expect(f.element('p').style.fontFamily).toBeFalsy();
        expect(f.observers.every(observer => !observer.active)).toBe(true);
    });
});

describe('dynamic protection regressions', () => {
    it('restores nodes moved into protected navigation', () => {
        const f = fixture('<article id="article"><p id="p">Readable paragraph</p></article><nav id="nav"></nav>');
        const controller = createReadingAppearanceController(f.document); controller.setEnabled(true);
        const p = f.element('p'), article = f.element('article'), nav = f.element('nav');
        nav.append(p);
        f.observers[0].callback([
            {type: 'childList', target: article, addedNodes: [], removedNodes: [p]},
            {type: 'childList', target: nav, addedNodes: [p], removedNodes: []},
        ] as unknown as MutationRecord[], {} as MutationObserver);
        vi.advanceTimersByTime(60);
        expect(p.style.fontFamily).toBeFalsy();
        controller.dispose();
    });
    it('allows protected code font to change with an author class', () => {
        const f = fixture('<p id="p">Readable paragraph <code id="code">snippet</code></p>');
        const controller = createReadingAppearanceController(f.document); controller.setEnabled(true);
        const code = f.element('code');
        code.setAttribute('data-family', 'Consolas'); code.className = 'code-theme';
        f.observers[0].callback([{type: 'attributes', target: code, attributeName: 'class'}] as unknown as MutationRecord[], {} as MutationObserver);
        vi.advanceTimersByTime(60);
        expect(f.document.defaultView!.getComputedStyle(code).fontFamily).toBe('Consolas');
        controller.dispose();
    });
    it.each(['nav', 'form', 'div'])('reclassifies a moved subtree through a newly created %s boundary and back', tag => {
        const f = fixture('<main id="main"><article id="moving"><p id="p">Moving paragraph</p></article><p id="stable">Stable paragraph</p></main><nav id="outer"></nav>');
        const controller = createReadingAppearanceController(f.document); controller.setEnabled(true);
        const moving = f.element('moving'), main = f.element('main'), p = f.element('p');
        const wrapper = f.document.createElement(tag); f.element('outer').append(wrapper); wrapper.append(moving);
        const callback = f.observers[0].callback;
        const writes = vi.mocked(p.style.setProperty); writes.mockClear();
        callback([
            {type: 'childList', target: main, addedNodes: [], removedNodes: [moving]},
            {type: 'childList', target: f.element('outer'), addedNodes: [wrapper], removedNodes: []},
            {type: 'childList', target: wrapper, addedNodes: [moving], removedNodes: []},
        ] as unknown as MutationRecord[], {} as MutationObserver);
        vi.advanceTimersByTime(60);
        expect(p.style.fontFamily).toBeFalsy();
        expect(writes.mock.contexts.some(context => context === f.element('stable').style)).toBe(false);
        main.append(moving);
        callback([
            {type: 'childList', target: wrapper, addedNodes: [], removedNodes: [moving]},
            {type: 'childList', target: main, addedNodes: [moving], removedNodes: []},
        ] as unknown as MutationRecord[], {} as MutationObserver);
        vi.advanceTimersByTime(60);
        expect(p.style.fontFamily).toBe(READING_APPEARANCE_FONT);
        expect(vi.getTimerCount()).toBe(0);
        moving.remove();
        callback([{type: 'childList', target: main, addedNodes: [], removedNodes: [moving]}] as unknown as MutationRecord[], {} as MutationObserver);
        vi.advanceTimersByTime(60);
        expect(p.hasAttribute('style')).toBe(false);
        controller.dispose();
    });
    it('coalesces protected font changes without touching unrelated prose or losing host inline updates', () => {
        const f = fixture('<p id="p">Text <button id="button">Action</button><code id="code">snippet</code></p><p id="stable">Stable paragraph</p>');
        const controller = createReadingAppearanceController(f.document); controller.setEnabled(true);
        const button = f.element('button'), code = f.element('code'), callback = f.observers[0].callback;
        const oldValue = button.getAttribute('style'); button.style.height = '20px';
        callback([{type: 'attributes', target: button, attributeName: 'style', oldValue}] as unknown as MutationRecord[], {} as MutationObserver);
        expect(vi.getTimerCount()).toBe(0);
        const writes = vi.mocked(button.style.setProperty); writes.mockClear();
        button.setAttribute('data-family', 'Material Icons'); button.className = 'icon-button';
        code.setAttribute('data-family', 'Consolas'); code.className = 'code-theme';
        const records = Array.from({length: 100}, () => [button, code].map(target => ({type: 'attributes', target, attributeName: 'class'}))).flat();
        callback(records as unknown as MutationRecord[], {} as MutationObserver);
        expect(vi.getTimerCount()).toBe(1); vi.advanceTimersByTime(60);
        expect(button.style.fontFamily).toBe('Material Icons'); expect(code.style.fontFamily).toBe('Consolas');
        expect(writes.mock.contexts.filter(context => context === f.element('p').style)).toHaveLength(1);
        expect(writes.mock.contexts.some(context => context === f.element('stable').style)).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        const previous = button.getAttribute('style'); button.style.setProperty('font-family', 'Arial', 'important');
        callback([{type: 'attributes', target: button, attributeName: 'style', oldValue: previous}] as unknown as MutationRecord[], {} as MutationObserver);
        vi.advanceTimersByTime(60); controller.dispose();
        expect(button.style.fontFamily).toBe('Arial'); expect(button.style.height).toBe('20px');
        expect(code.hasAttribute('style')).toBe(false);
    });

    it('ignores replacements inside untouched protected controls', () => {
        const f = fixture('<nav id="nav"><span id="clock">12:00</span></nav><p id="p">Readable paragraph</p>');
        const controller = createReadingAppearanceController(f.document); controller.setEnabled(true);
        const clock = f.element('clock'); clock.remove();
        const next = f.document.createElement('span'); next.textContent = '12:01'; f.element('nav').append(next);
        f.observers[0].callback([{type: 'childList', target: f.element('nav'), addedNodes: [next], removedNodes: [clock]}] as unknown as MutationRecord[], {} as MutationObserver);
        expect(vi.getTimerCount()).toBe(0);
        controller.dispose();
    });

    it('tracks a previously covered subtree through successive new containers', () => {
        const f = fixture('<main id="main"><article id="moving"><p id="p">Moving paragraph</p></article></main><div id="destination"></div><nav id="nav"></nav>');
        const controller = createReadingAppearanceController(f.document); controller.setEnabled(true);
        const moving = f.element('moving'), main = f.element('main'), destination = f.element('destination');
        const callback = f.observers[0].callback;
        destination.append(moving);
        callback([
            {type: 'childList', target: main, addedNodes: [], removedNodes: [moving]},
            {type: 'childList', target: destination, addedNodes: [moving], removedNodes: []},
        ] as unknown as MutationRecord[], {} as MutationObserver);
        vi.advanceTimersByTime(60);
        f.element('nav').append(destination);
        callback([
            {type: 'childList', target: f.document.body, addedNodes: [], removedNodes: [destination]},
            {type: 'childList', target: f.element('nav'), addedNodes: [destination], removedNodes: []},
        ] as unknown as MutationRecord[], {} as MutationObserver);
        vi.advanceTimersByTime(60);
        expect(f.element('p').style.fontFamily).toBeFalsy();
        controller.dispose();
    });

    it('preserves source prose in ordinary open shadow roots without entering owned translations', () => {
        const f = fixture('<span id="host"></span>');
        const host = f.element('host'), root = host.attachShadow({mode: 'open'});
        root.innerHTML = '<p>Source prose in a component</p><span class="fluent-read-bilingual-content" data-fr-translation-owned="true">Translation</span>';
        const controller = createReadingAppearanceController(f.document); controller.setEnabled(true);
        expect((root.querySelector('p') as HTMLElement).style.fontFamily).toBe(READING_APPEARANCE_FONT);
        expect((root.querySelector('span') as HTMLElement).hasAttribute('style')).toBe(false);
        expect(f.observers[0].roots).toContain(root);
        host.remove(); f.mutate(); controller.dispose();
        expect((root.querySelector('p') as HTMLElement).style.fontFamily).toBeFalsy();
    });

});
