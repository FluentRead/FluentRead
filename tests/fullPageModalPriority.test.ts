/**
 * @file tests/fullPageModalPriority.test.ts
 * 文件职责：验证全文翻译 modal 检测的可见性、阻塞证据、开放 Shadow DOM、层级选择和 mutation 重探测边界。
 * 主要内容：使用 linkedom 构造纯 DOM 场景，不启动 observer、计时器、provider 或扩展运行时。
 * 模块边界：只验证 modalPriority.ts 的纯检测 API，不验证全文队列调度或真实浏览器 top layer 行为。
 */
import {parseHTML} from 'linkedom';
import {describe, expect, it} from 'vitest';
import {findActiveTranslationModal, isWithinTranslationModal, mayChangeTranslationModal} from '@/src/features/full-page-translation/content/modalPriority';

function dom(markup = '<html><body></body></html>') {
    const window = parseHTML(markup);
    Object.defineProperty(window, 'innerWidth', {configurable: true, value: 1000});
    Object.defineProperty(window, 'innerHeight', {configurable: true, value: 800});
    Object.assign(globalThis, {document: window.document, Node: window.Node});
    window.getComputedStyle = ((element: Element) => ({
        display: (element as HTMLElement).style.display || 'block',
        visibility: (element as HTMLElement).style.visibility || 'visible',
        opacity: (element as HTMLElement).style.opacity || '1',
        position: (element as HTMLElement).style.position || 'static',
        overflow: (element as HTMLElement).style.overflow || '',
        overflowY: (element as HTMLElement).style.overflowY || '',
        zIndex: (element as HTMLElement).style.zIndex || '',
        width: (element as HTMLElement).style.width || '',
        height: (element as HTMLElement).style.height || '',
        inset: '', top: '', left: '',
    })) as unknown as typeof window.getComputedStyle;
    return window;
}

function rect(element: HTMLElement, left = 200, top = 100, width = 600, height = 500): void {
    Object.defineProperty(element, 'getBoundingClientRect', {configurable: true, value: () => ({left, top, right: left + width, bottom: top + height, width, height})});
}

describe('full page modal priority', () => {
    it('selects a visible native dialog:modal and rejects a closed dialog', () => {
        const window = dom('<html><body><dialog id="closed"><p>x</p></dialog><dialog id="active"><p>y</p></dialog></body></html>');
        const closed = window.document.querySelector('#closed') as HTMLDialogElement;
        const active = window.document.querySelector('#active') as HTMLDialogElement;
        closed.open = false; active.open = true; active.setAttribute('aria-modal', 'false'); rect(active);
        Object.defineProperty(active, 'matches', {value: (selector: string) => selector.includes(':modal') || selector.includes('dialog')});
        expect(findActiveTranslationModal([window.document])).toBe(active);
    });

    it('fails closed when native modal pseudo-class matching is unavailable', () => {
        const window = dom('<html><body><dialog id="active"><p>x</p></dialog></body></html>');
        const active = window.document.querySelector('#active') as HTMLDialogElement;
        active.open = true; rect(active);
        Object.defineProperty(active, 'matches', {value: (selector: string) => { if (selector === ':modal') throw new Error('unsupported'); return selector.includes('dialog'); }});
        expect(findActiveTranslationModal([window.document])).toBeNull();
    });

    it('handles invalid selectors and unavailable computed styles without selecting a false modal', () => {
        const window = dom('<html><body><div id="aria" role="dialog" aria-modal="true">x</div></body></html>');
        const aria = window.document.querySelector('#aria') as HTMLElement;
        rect(aria);
        expect(findActiveTranslationModal([window.document])).toBe(aria);
        Object.defineProperty(aria, 'matches', {configurable: true, value: () => { throw new Error('invalid selector'); }});
        expect(findActiveTranslationModal([window.document])).toBeNull();
        Object.defineProperty(window, 'getComputedStyle', {configurable: true, value: () => { throw new Error('style unavailable'); }});
        Object.defineProperty(aria, 'matches', {configurable: true, value: (selector: string) => selector.includes('dialog')});
        expect(findActiveTranslationModal([window.document])).toBe(aria);
    });

    it('accepts explicit aria modal but requires strong evidence for implicit modal semantics', () => {
        const window = dom('<html><body><div id="aria" role="dialog" aria-modal="true">x</div><div id="plain" role="dialog">y</div></body></html>');
        const aria = window.document.querySelector('#aria') as HTMLElement;
        const plain = window.document.querySelector('#plain') as HTMLElement;
        rect(aria); rect(plain); plain.style.position = 'fixed';
        expect(findActiveTranslationModal([window.document])).toBe(aria);
        aria.setAttribute('aria-hidden', 'true');
        const mask = window.document.createElement('div'); mask.className = 'modal-backdrop'; mask.style.position = 'fixed'; mask.style.width = '100vw'; mask.style.height = '100vh'; rect(mask, 0, 0, 1000, 800); window.document.body.append(mask); window.document.body.style.overflow = 'hidden';
        rect(plain); plain.setAttribute('aria-modal', 'false'); expect(findActiveTranslationModal([window.document])).toBeNull();
        plain.removeAttribute('aria-modal'); expect(findActiveTranslationModal([window.document])).toBe(plain);
    });

    it('respects the live Bambu consent dialog until its explicit rejection action closes it', () => {
        const window = dom('<html><body><main><p>When switching between different filaments for printing.</p></main><div id="truste-consent-track" role="dialog" aria-modal="true" data-trustarc-focus-trapped="true"><a href="https://bambulab.com/policies/cookie-policy">Cookie Notice</a><button id="truste-consent-required">Reject All</button></div></body></html>');
        const dialog = window.document.querySelector('#truste-consent-track') as HTMLElement;
        const paragraph = window.document.querySelector('p')!;
        rect(dialog, 24, 614.65625, 420, 177.34375);
        rect(paragraph, 528, 264, 732, 136);
        const active = findActiveTranslationModal([window.document]);
        expect(active).toBe(dialog);
        expect(isWithinTranslationModal(active!, paragraph)).toBe(false);
        const reject = dialog.querySelector('button')!;
        reject.addEventListener('click', () => { dialog.style.display = 'none'; });
        reject.click();
        expect(findActiveTranslationModal([window.document])).toBeNull();
        expect(paragraph.textContent).toBe('When switching between different filaments for printing.');
    });

    it('supports common component modal classes only with mask and center obstruction', () => {
        const window = dom('<html><body><div id="modal" class="el-dialog">x</div><div id="other" class="modal">y</div></body></html>');
        const modal = window.document.querySelector('#modal') as HTMLElement;
        const other = window.document.querySelector('#other') as HTMLElement;
        modal.style.position = 'fixed';
        const mask = window.document.createElement('div'); mask.className = 'el-overlay'; mask.style.position = 'fixed'; mask.style.width = '100vw'; mask.style.height = '100vh'; window.document.body.append(mask);
        rect(modal); rect(other, 0, 0, 10, 10); rect(mask, 0, 0, 1000, 800); window.document.body.style.overflow = 'hidden';
        expect(findActiveTranslationModal([window.document])).toBe(modal);
    });

    it('checks implicit modal masks inside an open shadow root without requiring parentElement', () => {
        const window = dom('<html><body><div id="host"></div></body></html>');
        const host = window.document.querySelector('#host') as HTMLElement;
        const shadow = host.attachShadow({mode: 'open'});
        const modal = window.document.createElement('div'); modal.className = 'el-dialog'; modal.style.position = 'fixed'; rect(modal);
        const mask = window.document.createElement('div'); mask.className = 'el-overlay'; mask.style.position = 'fixed'; rect(mask, 0, 0, 1000, 800);
        shadow.append(mask, modal);
        expect(findActiveTranslationModal([shadow])).toBe(modal);
    });

    it('rejects masks that are self, owned, hidden, or non-positioned', () => {
        const window = dom('<html><body><div id="modal" class="el-dialog">x</div></body></html>');
        const modal = window.document.querySelector('#modal') as HTMLElement;
        modal.style.position = 'fixed'; rect(modal);
        window.document.body.className = 'modal-backdrop';
        modal.classList.add('modal-backdrop');
        expect(findActiveTranslationModal([window.document])).toBeNull();
        modal.innerHTML = '';
        const ownedMask = window.document.createElement('div'); ownedMask.className = 'modal-backdrop'; ownedMask.setAttribute('data-fluent-read-ui', 'true'); ownedMask.style.position = 'fixed'; rect(ownedMask, 0, 0, 1000, 800); window.document.body.append(ownedMask);
        expect(findActiveTranslationModal([window.document])).toBeNull();
        ownedMask.remove();
        const hiddenMask = window.document.createElement('div'); hiddenMask.className = 'modal-backdrop'; hiddenMask.style.position = 'fixed'; hiddenMask.style.display = 'none'; rect(hiddenMask, 0, 0, 1000, 800); window.document.body.append(hiddenMask);
        expect(findActiveTranslationModal([window.document])).toBeNull();
        hiddenMask.remove();
        const staticMask = window.document.createElement('div'); staticMask.className = 'modal-backdrop'; rect(staticMask, 0, 0, 1000, 800); window.document.body.append(staticMask);
        expect(findActiveTranslationModal([window.document])).toBeNull();
    });

    it('chooses nested and then higher z-index modal, while ignoring extension nodes and closed shadow roots', () => {
        const window = dom('<html><body><div id="outer" role="dialog" aria-modal="true"><div id="inner" role="dialog" aria-modal="true">x</div></div><div id="owned" role="dialog" aria-modal="true" data-fluent-read-ui="true">owned</div><div id="host"></div></body></html>');
        const outer = window.document.querySelector('#outer') as HTMLElement;
        const inner = window.document.querySelector('#inner') as HTMLElement;
        const owned = window.document.querySelector('#owned') as HTMLElement;
        rect(outer); rect(inner); rect(owned);
        const host = window.document.querySelector('#host') as HTMLElement;
        const shadow = host.attachShadow({mode: 'open'}); const shadowModal = window.document.createElement('div'); shadowModal.setAttribute('role', 'dialog'); shadowModal.setAttribute('aria-modal', 'true'); shadow.append(shadowModal); rect(shadowModal);
        expect(findActiveTranslationModal([window.document, shadow])).toBe(shadowModal);
        expect(isWithinTranslationModal(outer, inner)).toBe(true);
        expect(isWithinTranslationModal(outer, shadowModal)).toBe(false);
        expect(isWithinTranslationModal(shadowModal, shadowModal)).toBe(true);
        expect(findActiveTranslationModal([owned])).not.toBe(owned);
        expect(findActiveTranslationModal([inner, outer])).toBe(inner);
    });

    it('uses z-index and DOM order for unrelated modal candidates', () => {
        const window = dom('<html><body><div id="a" role="dialog" aria-modal="true">a</div><div id="b" role="dialog" aria-modal="true">b</div></body></html>');
        const a = window.document.querySelector('#a') as HTMLElement; const b = window.document.querySelector('#b') as HTMLElement;
        rect(a); rect(b); Object.defineProperty(window.document, 'elementsFromPoint', {configurable: true, value: () => [b]});
        a.style.zIndex = '2'; b.style.zIndex = '5'; expect(findActiveTranslationModal([window.document])).toBe(b);
        Object.defineProperty(window.document, 'elementsFromPoint', {configurable: true, value: () => []});
        b.style.zIndex = '2'; expect(findActiveTranslationModal([window.document])).toBe(b);
        b.style.zIndex = '1'; expect(findActiveTranslationModal([window.document])).toBe(a);
        expect(findActiveTranslationModal([b, a])).toBe(a);
    });

    it.each([false,true])('uses the first page hit for sibling native modals with first-hit=%s', firstHit => {
        const window = dom('<html><body><dialog id="first"><p>a</p></dialog><dialog id="second"><p>b</p></dialog></body></html>');
        const first = window.document.querySelector('#first') as HTMLDialogElement;
        const second = window.document.querySelector('#second') as HTMLDialogElement;
        first.open = true; second.open = true; rect(first); rect(second);
        const nativeMatches = (selector: string) => selector.includes(':modal') || selector.includes('dialog');
        Object.defineProperty(first, 'matches', {value: nativeMatches}); Object.defineProperty(second, 'matches', {value: nativeMatches});
        Object.defineProperty(window.document, 'elementsFromPoint', {configurable: true, value: () => firstHit?[first,second]:[second, first]});
        expect(findActiveTranslationModal([window.document])).toBe(firstHit?first:second);
    });

    it.each([false,true])('promotes a native modal over an aria modal with native-first=%s', nativeFirst => {
        const window = dom('<html><body><div id="aria" role="dialog" aria-modal="true">a</div><dialog id="native"><p>b</p></dialog></body></html>');
        const aria = window.document.querySelector('#aria') as HTMLElement;
        const native = window.document.querySelector('#native') as HTMLDialogElement;
        rect(aria); rect(native); native.open = true;
        Object.defineProperty(native, 'matches', {value: (selector: string) => selector.includes(':modal') || selector.includes('dialog')});
        if(nativeFirst)window.document.body.prepend(native);
        expect(findActiveTranslationModal([window.document])).toBe(native);
    });
    it.each([[500,800],[1000,300]])('does not treat a positioned %i by %i sibling as a viewport-blocking mask', (width,height) => {
        const window=dom('<html><body><div class="el-dialog" id="dialog">Body</div><div class="el-overlay" id="mask"></div></body></html>');
        const dialog=window.document.getElementById('dialog') as HTMLElement,mask=window.document.getElementById('mask') as HTMLElement;
        dialog.style.position='fixed';mask.style.position='fixed';rect(dialog);rect(mask,0,0,width,height);
        expect(findActiveTranslationModal([window.document])).toBeNull();
    });

    it('recognizes alertdialog and keeps hidden ancestors out of the result', () => {
        const window = dom('<html><body><section id="hidden"><div role="alertdialog" aria-modal="true">x</div></section><div id="alert" role="alertdialog" aria-modal="true">y</div></body></html>');
        const hidden = window.document.querySelector('#hidden') as HTMLElement;
        const alert = window.document.querySelector('#alert') as HTMLElement;
        hidden.style.display = 'none'; rect(hidden.querySelector('div') as HTMLElement);
        rect(alert); expect(findActiveTranslationModal([window.document])).toBe(alert);
    });

    it.each(['hidden', 'inert', 'aria-hidden'])('skips style reads inside an explicitly %s subtree until it is exposed', (attribute) => {
        const window = dom('<html><body><section id="ancestor"><div id="modal" role="dialog" aria-modal="true">x</div></section></body></html>');
        const ancestor = window.document.querySelector('#ancestor') as HTMLElement;
        const modal = window.document.querySelector('#modal') as HTMLElement;
        rect(modal);
        ancestor.setAttribute(attribute, attribute === 'aria-hidden' ? 'true' : '');
        const original = window.getComputedStyle;
        const reads: Element[] = [];
        window.getComputedStyle = ((element: Element) => {
            reads.push(element);
            return original(element);
        }) as typeof window.getComputedStyle;
        expect(findActiveTranslationModal([window.document])).toBeNull();
        expect(reads).toEqual([]);
        ancestor.removeAttribute(attribute);
        expect(findActiveTranslationModal([window.document])).toBe(modal);
        expect(reads).toContain(modal);
    });

    it('rejects explicit hidden state on the dialog before reading its styles', () => {
        const window = dom('<html><body><div id="modal" role="dialog" aria-modal="true" hidden>x</div></body></html>');
        const modal = window.document.querySelector('#modal') as HTMLElement;
        rect(modal);
        const reads: Element[] = [];
        window.getComputedStyle = ((element: Element) => { reads.push(element); return {}; }) as typeof window.getComputedStyle;
        expect(findActiveTranslationModal([window.document])).toBeNull();
        expect(reads).toEqual([]);
    });

    it('checks an explicitly hidden shadow host before reading its modal descendant styles', () => {
        const window = dom('<html><body><div id="host" aria-hidden="true"></div></body></html>');
        const host = window.document.querySelector('#host') as HTMLElement;
        const shadow = host.attachShadow({mode: 'open'});
        const modal = window.document.createElement('div');
        modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); shadow.append(modal); rect(modal);
        const original = window.getComputedStyle;
        const reads: Element[] = [];
        window.getComputedStyle = ((element: Element) => { reads.push(element); return original(element); }) as typeof window.getComputedStyle;
        expect(findActiveTranslationModal([shadow])).toBeNull();
        expect(reads).toEqual([]);
        host.removeAttribute('aria-hidden');
        expect(findActiveTranslationModal([shadow])).toBe(modal);
        expect(reads).toContain(modal);
    });

    it('reports only mutations that may change modal discovery', () => {
        const window = dom('<html><body><div id="modal" role="dialog" aria-modal="true"><p>x</p></div><p id="copy">copy</p></body></html>');
        const modal = window.document.querySelector('#modal') as HTMLElement; const copy = window.document.querySelector('#copy')!;
        const attribute = (target: Node, name: string) => ({type: 'attributes', target, attributeName: name} as unknown as MutationRecord);
        const child = (target: Node, addedNodes: Node[]) => ({type: 'childList', target, addedNodes, removedNodes: []} as unknown as MutationRecord);
        expect(mayChangeTranslationModal(attribute(modal, 'aria-hidden'), modal)).toBe(true);
        expect(mayChangeTranslationModal(child(modal, [window.document.createElement('span')]), modal)).toBe(true);
        expect(mayChangeTranslationModal(attribute(copy, 'title'), modal)).toBe(false);
        expect(mayChangeTranslationModal(child(window.document.body, [window.document.createElement('div')]), null)).toBe(false);
        expect(mayChangeTranslationModal(child(window.document.body, [window.document.createTextNode('text')]), null)).toBe(false);
        expect(mayChangeTranslationModal(child(modal, []), null)).toBe(true);
        const newModal = window.document.createElement('div'); newModal.setAttribute('role', 'dialog');
        expect(mayChangeTranslationModal(child(window.document.body, [newModal]), null)).toBe(true);
        expect(mayChangeTranslationModal(attribute(copy, 'class'), null)).toBe(false);
        expect(mayChangeTranslationModal({type: 'attributes', target: copy, attributeName: 'class'} as unknown as MutationRecord, modal)).toBe(false);
        expect(mayChangeTranslationModal({type: 'characterData', target: copy.firstChild} as unknown as MutationRecord, null)).toBe(false);
    });

    it('rechecks shadow host changes and hidden ancestors, while ignoring a detached shadow root', () => {
        const window = dom('<html><body><section id="ancestor"><div id="host"></div></section></body></html>');
        const ancestor = window.document.querySelector('#ancestor') as HTMLElement;
        const host = window.document.querySelector('#host') as HTMLElement;
        const shadow = host.attachShadow({mode: 'open'});
        const modal = window.document.createElement('div'); modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); shadow.append(modal); rect(modal);
        const child = (target: Node, addedNodes: Node[]) => ({type: 'childList', target, addedNodes, removedNodes: []} as unknown as MutationRecord);
        expect(mayChangeTranslationModal(child(window.document.body, [host]), null)).toBe(true);
        expect(mayChangeTranslationModal({type: 'attributes', target: ancestor, attributeName: 'hidden'} as unknown as MutationRecord, modal)).toBe(true);
        expect(findActiveTranslationModal([shadow])).toBe(modal);
        ancestor.remove();
        expect(findActiveTranslationModal([shadow])).toBeNull();
    });
});
