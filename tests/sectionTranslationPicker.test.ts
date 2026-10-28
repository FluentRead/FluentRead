import {parseHTML} from 'linkedom';
import {isEditingInPage} from '@/src/shared/dom/editingTarget';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {SectionLabelSummary} from '@/src/features/section-translation/core';

type Listener = {type: string; listener: (event: any) => void; signal?: AbortSignal};

const PAGE = `<html><body>
<article id="readme"><p id="para">Hello <b id="bold">world</b></p><p id="second">Second paragraph</p></article>
<div id="ball" data-fluent-read-ui="floating-ball"></div>
<div id="shadow-host"></div>
</body></html>`;

interface PickerHarness {
    document: Document;
    view: Record<string, unknown>;
    byId(id: string): HTMLElement;
    hit: {current: Element | null};
    frames: (() => void)[];
    flushFrames(): void;
    emit(type: string, event?: Record<string, unknown>): Record<string, any>;
    emitDocument(type: string, event?: Record<string, unknown>): void;
    host(): HTMLElement | null;
    shadow(): ShadowRoot;
    inspect: ReturnType<typeof vi.fn>;
    onPick: ReturnType<typeof vi.fn>;
    options: Record<string, unknown>;
    windowListeners: Listener[];
    mutationObserver: {observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>};
    emitMutation(target: Node, addedNodes?: Node[]): void;
    emitAttribute(target: Element): void;
    resizeObserver: {observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>};
    emitResize(): void;
}

const summary = (overrides: Partial<SectionLabelSummary> = {}): SectionLabelSummary => ({
    total: 2, active: 0, pending: 2, truncated: false, action: 'translate', ...overrides,
});

it('自有封闭操作条聚焦时不被通用输入保护挡住方向键和 Enter，网页输入仍让行',async()=>{
    const harness=await createHarness();
    harness.picker.startSectionPicker({...harness.options,isEditing:(event:KeyboardEvent)=>isEditingInPage(event,harness.document)} as any);
    harness.flushFrames();
    const bar=query(harness.shadow(),'.fr-section-bar');
    Object.defineProperty(harness.document,'activeElement',{configurable:true,get:()=>harness.host()});
    Object.defineProperty(harness.shadow(),'activeElement',{configurable:true,get:()=>bar});
    const path=()=>[harness.host(),harness.document.body];
    expect(isEditingInPage({composedPath:path} as unknown as KeyboardEvent,harness.document)).toBe(true);
    const larger=harness.emit('keydown',{key:'ArrowUp',composedPath:path});
    expect(larger.preventDefault).toHaveBeenCalledOnce();
    const smaller=harness.emit('keydown',{key:'ArrowDown',composedPath:path});
    expect(smaller.preventDefault).toHaveBeenCalledOnce();
    const outside=harness.emit('keydown',{key:'Enter'});
    expect(outside.preventDefault).not.toHaveBeenCalled();expect(harness.onPick).not.toHaveBeenCalled();
    const enter=harness.emit('keydown',{key:'Enter',composedPath:path});
    expect(enter.preventDefault).toHaveBeenCalledOnce();expect(harness.onPick).toHaveBeenCalledOnce();expect(harness.onPick).toHaveBeenCalledWith(harness.byId('para'));
});

function rect(left: number, top: number, width: number, height: number) {
    return {left, top, width, height, right: left + width, bottom: top + height, x: left, y: top};
}

async function createHarness(options: {withAnimationFrame?: boolean; withObservers?: boolean; initialPoint?: {x: number; y: number} | null} = {}): Promise<PickerHarness & {picker: typeof import('@/src/features/section-translation/content/picker')}> {
    vi.resetModules();
    const {window: view, document} = parseHTML(PAGE);
    const byId = (id: string) => document.getElementById(id)! as HTMLElement;
    const inline = new Set<Element>([byId('bold')]);
    (view as unknown as {getComputedStyle: (element: Element) => {display: string}}).getComputedStyle = (element) => ({
        display: inline.has(element) ? 'inline' : 'block',
    });
    byId('readme').getBoundingClientRect = () => rect(20, 40, 800, 600) as DOMRect;
    byId('para').getBoundingClientRect = () => rect(30, 60, 400, 40) as DOMRect;
    byId('second').getBoundingClientRect = () => rect(30, 120, 400, 40) as DOMRect;

    const windowListeners: Listener[] = [];
    const documentListeners: Listener[] = [];
    const frames: (() => void)[] = [];
    const fakeWindow: Record<string, unknown> = {
        innerHeight: 800,
        innerWidth: 1200,
        addEventListener: (type: string, listener: (event: any) => void, init?: {signal?: AbortSignal}) => {
            windowListeners.push({type, listener, signal: init?.signal});
        },
        setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
        clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
    };
    if (options.withAnimationFrame !== false) {
        fakeWindow.requestAnimationFrame = (callback: () => void) => frames.push(callback);
        fakeWindow.cancelAnimationFrame = vi.fn();
    }
    const documentTarget = document as unknown as Record<string, unknown>;
    documentTarget.addEventListener = (type: string, listener: (event: any) => void, init?: {signal?: AbortSignal}) => {
        documentListeners.push({type, listener, signal: init?.signal});
    };
    const hit = {current: byId('bold') as Element | null};
    documentTarget.elementFromPoint = () => hit.current;
    let visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => visibility});

    let shadowRoot: ShadowRoot | null = null;
    const createElement = document.createElement.bind(document);
    documentTarget.createElement = (tag: string) => {
        const element = createElement(tag) as HTMLElement;
        // linkedom 不实现监听器的 AbortSignal 清理；保持与浏览器一致，验证迟到按钮事件无回调。
        const addListener = element.addEventListener.bind(element);
        element.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, init?: boolean | AddEventListenerOptions) => {
            addListener(type, listener, init);
            if (typeof init === 'object' && init.signal) {
                init.signal.addEventListener('abort', () => element.removeEventListener(type, listener, init), {once: true});
            }
        }) as typeof element.addEventListener;
        if (tag === 'fluent-read-section-picker') {
            const attach = element.attachShadow.bind(element);
            element.attachShadow = (init: ShadowRootInit) => {
                shadowRoot = attach(init);
                return shadowRoot;
            };
        }
        return element;
    };

    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('document', document);
    // linkedom 的 childList 记录使用观察根作为 target；注入浏览器语义的记录，DOM 仍真实变更。
    const mutationObserver = {observe: vi.fn(), disconnect: vi.fn()};
    let mutationCallback: MutationCallback;
    vi.stubGlobal('MutationObserver', class {
        observe = mutationObserver.observe;
        disconnect = mutationObserver.disconnect;
        constructor(callback: MutationCallback) {
            mutationCallback = callback;
        }
    });
    const resizeObserver = {observe: vi.fn(), disconnect: vi.fn()};
    let resizeCallback: ResizeObserverCallback;
    vi.stubGlobal('ResizeObserver', class {
        observe = resizeObserver.observe;
        disconnect = resizeObserver.disconnect;
        constructor(callback: ResizeObserverCallback) {
            resizeCallback = callback;
        }
    });
    if (options.withObservers === false) {
        vi.stubGlobal('MutationObserver', undefined);
        vi.stubGlobal('ResizeObserver', undefined);
    }

    const picker = await import('@/src/features/section-translation/content/picker');
    const inspect = vi.fn(() => summary());
    const onPick = vi.fn();
    const pickerOptions = {
        initialPoint: options.initialPoint === undefined ? {x: 50, y: 70} : options.initialPoint,
        inspect,
        onPick,
        text: (key: string, params?: Record<string, unknown>) => params ? `${key}:${JSON.stringify(params)}` : key,
        isExitHotkey: (event: KeyboardEvent) => event.altKey === true && event.key === 'r',
        isEditing: (event: KeyboardEvent) => event.target === byId('para'),
    };

    const run = (store: Listener[], type: string, event: Record<string, any>) => {
        for (const entry of store.filter((item) => item.type === type && !item.signal?.aborted)) entry.listener(event);
    };
    const createEvent = (type: string, event: Record<string, unknown> = {}) => ({
        type,
        isTrusted: true,
        button: 0,
        clientX: 0,
        clientY: 0,
        preventDefault: vi.fn(),
        stopImmediatePropagation: vi.fn(),
        composedPath: () => [document.body, document.documentElement, document],
        ...event,
    });
    return {
        picker,
        document,
        view: view as unknown as Record<string, unknown>,
        byId,
        hit,
        frames,
        flushFrames: () => {
            while (frames.length > 0) frames.shift()!();
        },
        emit: (type, event) => {
            const created = createEvent(type, event);
            run(windowListeners, type, created);
            return created;
        },
        emitDocument: (type, event) => run(documentListeners, type, createEvent(type, event)),
        host: () => document.documentElement.querySelector('[data-fluent-read-ui="section-picker"]') as HTMLElement | null,
        shadow: () => shadowRoot!,
        inspect,
        onPick,
        options: pickerOptions,
        windowListeners,
        mutationObserver,
        emitMutation: (target, addedNodes = []) => mutationCallback([{type: target.nodeType === 3 ? 'characterData' : 'childList', target, addedNodes} as unknown as MutationRecord], mutationObserver as unknown as MutationObserver),
        emitAttribute: target => mutationCallback([{type: 'attributes', target, addedNodes: []} as unknown as MutationRecord], mutationObserver as unknown as MutationObserver),
        resizeObserver,
        emitResize: () => resizeCallback([], resizeObserver as unknown as ResizeObserver),
    };
}

function query(root: ShadowRoot, selector: string): HTMLElement {
    return root.querySelector(selector) as HTMLElement;
}

function button(harness: PickerHarness, name: string): HTMLButtonElement {
    return query(harness.shadow(), `.fr-section-${name}`) as HTMLButtonElement;
}

/** 沿用关闭按钮的 Event 套路；dispatchEvent 可同时验证 disabled 与 isTrusted 防线。 */
function clickButton(harness: PickerHarness, name: string, trusted = true): Event {
    const event = new (harness.document.defaultView as unknown as {Event: typeof Event}).Event('click', {cancelable: true});
    Object.defineProperty(event, 'isTrusted', {value: trusted});
    button(harness, name).dispatchEvent(event);
    return event;
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('局部翻译选择模式', () => {
    it('扩大大量独立区域时避免逐对读取父级，并可缩回原选区', async () => {
        const h = await createHarness({initialPoint: {x: 50, y: 2}});
        const count = 120;
        const paragraphs: HTMLElement[] = [];
        const wrappers: HTMLElement[] = [];
        let parentReads = 0;
        for (let index = 0; index < count; index++) {
            const wrapper = h.document.createElement('section');
            const paragraph = h.document.createElement('p');
            paragraph.textContent = `Readable paragraph ${index}`;
            wrapper.getBoundingClientRect = () => rect(20, index * 4, 500, 30) as DOMRect;
            paragraph.getBoundingClientRect = () => rect(30, index * 4, 400, 20) as DOMRect;
            wrapper.append(paragraph); h.document.body.append(wrapper);
            const parent = wrapper.parentElement;
            Object.defineProperty(wrapper, 'parentElement', {configurable: true, get() { parentReads++; return parent; }});
            wrappers.push(wrapper); paragraphs.push(paragraph);
        }
        h.document.elementFromPoint = (_x, y) => paragraphs[Math.min(count - 1, Math.max(0, Math.floor(y / 4)))]!;
        h.picker.startSectionPicker(h.options as never); h.flushFrames();
        h.emit('pointerdown', {pointerId: 1, clientX: 50, clientY: 2});
        for (let index = 1; index < count; index++) h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 50, clientY: index * 4 + 2});
        h.emit('pointerup', {pointerId: 1, clientX: 50, clientY: (count - 1) * 4 + 2});
        h.flushFrames(); vi.advanceTimersByTime(90);
        expect(h.host()!.getAttribute('data-selection-count')).toBe(String(count - 1));
        parentReads = 0;
        clickButton(h, 'expand');
        expect(parentReads).toBeLessThan(25_000);
        h.flushFrames(); vi.advanceTimersByTime(90);
        expect(h.inspect).toHaveBeenLastCalledWith(wrappers.filter((_wrapper, index) => index !== 1));
        clickButton(h, 'shrink'); h.flushFrames(); vi.advanceTimersByTime(90);
        expect(h.inspect).toHaveBeenLastCalledWith(paragraphs.filter((_paragraph, index) => index !== 1));
        h.picker.stopSectionPicker();
    });

    it.each([511, 512])('扩大选区时保留 %i 层 composed 祖先边界', async distance => {
        const h = await createHarness({initialPoint: {x: 50, y: 70}});
        const outer = h.document.createElement('article');
        outer.getBoundingClientRect = () => rect(10, 30, 700, 300) as DOMRect;
        h.document.body.append(outer);
        let inner = outer;
        for (let depth = 0; depth < distance; depth++) {
            const next = h.document.createElement('section'); inner.append(next); inner = next;
        }
        inner.getBoundingClientRect = () => rect(20, 50, 500, 100) as DOMRect;
        const first = h.document.createElement('p'); first.textContent = 'First readable paragraph';
        first.getBoundingClientRect = () => rect(30, 60, 400, 40) as DOMRect; inner.append(first);
        const second = h.document.createElement('p'); second.textContent = 'Second readable paragraph';
        second.getBoundingClientRect = () => rect(30, 120, 400, 40) as DOMRect; outer.append(second);
        h.document.elementFromPoint = (_x, y) => y < 110 ? first : second;
        h.picker.startSectionPicker(h.options as never); h.flushFrames();
        h.emit('pointerdown', {pointerId: 1, clientX: 50, clientY: 70});
        h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 50, clientY: 130});
        h.emit('pointerup', {pointerId: 1, clientX: 50, clientY: 130}); h.flushFrames(); vi.advanceTimersByTime(90);
        expect(h.inspect).toHaveBeenLastCalledWith([first, second]);
        clickButton(h, 'expand'); h.flushFrames(); vi.advanceTimersByTime(90);
        expect(h.inspect).toHaveBeenLastCalledWith(distance === 511 ? outer : [inner, outer]);
        h.picker.stopSectionPicker();
    });

    it('扩大跨开放 ShadowRoot 的多选时只保留已选组合祖先', async () => {
        const h = await createHarness({initialPoint: {x: 50, y: 70}});
        const outer = h.document.createElement('article');
        outer.getBoundingClientRect = () => rect(10, 30, 700, 300) as DOMRect;
        h.document.body.append(outer);
        const host = h.document.createElement('div'); outer.append(host);
        const shadow = host.attachShadow({mode: 'open'});
        const inner = h.document.createElement('section');
        inner.getBoundingClientRect = () => rect(20, 50, 500, 100) as DOMRect; shadow.append(inner);
        const first = h.document.createElement('p'); first.textContent = 'First readable paragraph';
        first.getBoundingClientRect = () => rect(30, 60, 400, 40) as DOMRect; inner.append(first);
        const second = h.document.createElement('p'); second.textContent = 'Second readable paragraph';
        second.getBoundingClientRect = () => rect(30, 120, 400, 40) as DOMRect; outer.append(second);
        h.document.elementFromPoint = (_x, y) => y < 110 ? host : second;
        shadow.elementFromPoint = () => first;
        h.picker.startSectionPicker(h.options as never); h.flushFrames();
        h.emit('pointerdown', {pointerId: 1, clientX: 50, clientY: 70});
        h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 50, clientY: 130});
        h.emit('pointerup', {pointerId: 1, clientX: 50, clientY: 130}); h.flushFrames(); vi.advanceTimersByTime(90);
        expect(h.inspect).toHaveBeenLastCalledWith([first, second]);
        clickButton(h, 'expand'); h.flushFrames(); vi.advanceTimersByTime(90);
        expect(h.inspect).toHaveBeenLastCalledWith(outer);
        clickButton(h, 'shrink'); h.flushFrames(); vi.advanceTimersByTime(90);
        expect(h.inspect).toHaveBeenLastCalledWith([first, second]);
        h.picker.stopSectionPicker();
    });
    it('真实选择器在指针会话交接时退出未确认选择，旧释放不影响新模式', async () => {
        const h = await createHarness();
        // createHarness 重置模块后再加载，必须与真实 picker 使用同一份会话身份。
        const {claimPointerSelectionSession} = await import('@/src/shared/dom/pointerSelectionSession');
        const previous = vi.fn(), next = vi.fn(), latest = vi.fn();
        const releasePrevious = claimPointerSelectionSession(previous);
        expect(h.picker.startSectionPicker(h.options as never)).toBe(true);
        h.flushFrames();
        expect(previous).toHaveBeenCalledOnce();
        expect(h.picker.isSectionPickerActive()).toBe(true);
        expect(h.host()).not.toBeNull();
        const releaseNext = claimPointerSelectionSession(next);
        expect(h.host()).toBeNull();
        expect(h.picker.isSectionPickerActive()).toBe(false);
        expect(h.onPick).not.toHaveBeenCalled();
        releasePrevious();
        h.picker.stopSectionPicker();
        const releaseLatest = claimPointerSelectionSession(latest);
        expect(next).toHaveBeenCalledOnce();
        releaseNext();
        releaseLatest();
        expect(latest).not.toHaveBeenCalled();
    });

    it('从段落间隙起划时收窄到实际经过的段落，往返经过外壳不扩大或丢失已选块', async () => {
        const h = await createHarness({initialPoint: {x: 50, y: 110}});
        h.document.elementFromPoint = (_x, y) => y >= 60 && y <= 100 ? h.byId('para')
            : y >= 120 && y <= 160 ? h.byId('second') : h.byId('readme');
        h.picker.startSectionPicker(h.options as never); h.flushFrames();
        h.emit('pointerdown', {pointerId: 1, clientX: 50, clientY: 110});
        h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 50, clientY: 80});
        h.flushFrames(); vi.advanceTimersByTime(90);
        expect(h.inspect).not.toHaveBeenCalled();
        expect(h.host()!.getAttribute('data-selection-count')).toBe('1');
        expect(query(h.shadow(), '.fr-section-label-action').textContent).toBe('sectionTranslation.picker.dragging');
        h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 50, clientY: 140});
        h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 50, clientY: 110});
        h.emit('pointerup', {pointerId: 1, clientX: 50, clientY: 110});
        h.flushFrames(); vi.advanceTimersByTime(90);
        expect(h.host()!.getAttribute('data-selection-count')).toBe('2');
        expect(h.host()!.getAttribute('data-selection-state')).toBe('locked');
        expect(h.shadow().querySelectorAll('.fr-section-box.is-visible')).toHaveLength(2);
        expect(h.onPick).not.toHaveBeenCalled();
        h.emit('keydown', {key: 'Enter'});
        expect(h.onPick).toHaveBeenCalledWith([h.byId('para'), h.byId('second')]);
    });

    it('单击间隙仍可锁定文章，段落的方向键扩大和缩小保留原范围语义', async () => {
        const h = await createHarness({initialPoint: null});
        h.hit.current = h.byId('readme');
        h.picker.startSectionPicker(h.options as never); h.flushFrames();
        h.emit('pointerdown', {pointerId: 1, clientX: 50, clientY: 110});
        h.emit('pointerup', {pointerId: 1, clientX: 50, clientY: 110});
        h.emit('click', {clientX: 50, clientY: 110}); h.flushFrames(); vi.advanceTimersByTime(90);
        expect(h.inspect).toHaveBeenLastCalledWith(h.byId('readme'));
        expect(h.host()!.getAttribute('data-selection-state')).toBe('locked');
        clickButton(h, 'reselect');
        h.hit.current = h.byId('para');
        h.emit('pointermove', {clientX: 50, clientY: 80}); h.flushFrames(); vi.advanceTimersByTime(90);
        h.emit('keydown', {key: 'ArrowUp'}); h.flushFrames(); vi.advanceTimersByTime(90);
        expect(h.inspect).toHaveBeenLastCalledWith(h.byId('readme'));
        h.emit('keydown', {key: 'ArrowDown'}); h.flushFrames(); vi.advanceTimersByTime(90);
        expect(h.inspect).toHaveBeenLastCalledWith(h.byId('para'));
        h.emit('keydown', {key: 'Enter'});
        expect(h.onPick).toHaveBeenCalledWith(h.byId('para'));
    });

    it('按住左键划过两段逐块高亮并去重，松开只锁定，确认一次交付精确区域', async () => {
        const h = await createHarness();
        h.picker.startSectionPicker(h.options as never); h.flushFrames();
        h.emit('pointerdown', {pointerId: 1, pointerType: 'mouse', clientX: 50, clientY: 70});
        h.emit('pointermove', {pointerId: 2, buttons: 1, clientX: 52, clientY: 71});
        h.flushFrames();
        expect(h.host()!.getAttribute('data-selection-state')).toBe('preview');
        h.hit.current = h.byId('second');
        h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 50, clientY: 130}); h.flushFrames();
        expect(h.host()!.getAttribute('data-selection-state')).toBe('dragging');
        expect(h.host()!.getAttribute('data-selection-count')).toBe('2');
        expect(h.shadow().querySelectorAll('.fr-section-box.is-visible')).toHaveLength(2);
        h.hit.current = h.byId('readme');
        h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 50, clientY: 112});
        h.hit.current = h.byId('para');
        h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 50, clientY: 70});
        expect(h.host()!.getAttribute('data-selection-count')).toBe('2');
        h.emit('keydown', {key: 'Enter'}); expect(h.onPick).not.toHaveBeenCalled();
        h.emit('pointerup', {pointerId: 2, clientX: 50, clientY: 70});
        expect(h.host()!.getAttribute('data-selection-state')).toBe('dragging');
        h.emit('pointerup', {pointerId: 1, clientX: 50, clientY: 70});
        h.emit('click', {clientX: 50, clientY: 70}); h.flushFrames(); vi.advanceTimersByTime(90);
        expect(h.host()!.getAttribute('data-selection-state')).toBe('locked');
        expect(h.onPick).not.toHaveBeenCalled();
        expect(h.inspect).toHaveBeenLastCalledWith([h.byId('para'), h.byId('second')]);
        expect(query(h.shadow(), '.fr-section-label-meta').textContent).toBe('sectionTranslation.scope.selected:{"count":2}');
        expect(query(h.shadow(), '.fr-section-bar-instruction').textContent).toBe('sectionTranslation.label.translate:{"count":2}');
        expect(query(h.shadow(), '.fr-section-bar-heading').classList.contains('is-locked')).toBe(true);
        expect(h.shadow().querySelector('.fr-section-bar-preview')).toBeNull();
        expect(h.shadow().querySelector('.fr-section-bar-keys')).toBeNull();
        clickButton(h, 'confirm');
        expect(h.onPick).toHaveBeenCalledOnce();
        expect(h.onPick).toHaveBeenCalledWith([h.byId('para'), h.byId('second')]);
        expect(h.shadow().querySelectorAll('.fr-section-box.is-confirmed')).toHaveLength(2);
    });

    it('同帧划选复用命中解析，下一帧重新读取布局与父级', async () => {
        const h = await createHarness(); h.picker.startSectionPicker(h.options as never); h.flushFrames();
        h.emit('pointerdown', {pointerId: 1, clientX: 50, clientY: 70});
        const paragraph = h.byId('second');
        const display = vi.spyOn(h.document.defaultView!, 'getComputedStyle');
        const bounds = vi.spyOn(paragraph, 'getBoundingClientRect');
        const elementAtPoint = vi.fn(() => paragraph);
        h.document.elementFromPoint = elementAtPoint;
        h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 50, clientY: 838});
        expect(elementAtPoint).not.toHaveBeenCalled();
        h.flushFrames();
        expect(elementAtPoint).toHaveBeenCalledTimes(64);
        // 解析读取 display 一次；绘制可以另外读取 visibility 与实际矩形。
        const paragraphDisplayReads = display.mock.calls.filter(([element]) => element === paragraph).length;
        expect(paragraphDisplayReads).toBeLessThan(6);
        expect(bounds.mock.calls.length).toBeLessThan(6);
        // 缓存只属于当前帧；页面下一帧把原命中块改成行内后，必须重新找到父级。
        const parent = h.document.createElement('section');
        parent.getBoundingClientRect = () => rect(25, 110, 500, 100) as DOMRect;
        paragraph.replaceWith(parent); parent.append(paragraph);
        display.mockImplementation(element => ({display: element === paragraph ? 'inline' : 'block'}) as CSSStyleDeclaration);
        display.mockClear();
        h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 50, clientY: 70});
        h.flushFrames();
        expect(display.mock.calls.filter(([element]) => element === paragraph).length).toBeGreaterThan(0);
        expect(display.mock.calls.filter(([element]) => element === parent).length).toBeGreaterThan(0);
        h.emit('pointerup', {pointerId: 1, clientX: 50, clientY: 70}); h.flushFrames(); vi.advanceTimersByTime(90);
        clickButton(h, 'confirm');
        // 已选中的具体段落不会因后续命中更宽父级而被扩大。
        expect(h.onPick).toHaveBeenCalledWith([h.byId('para'), paragraph]);
    });

    it('同次事件保留途经的不同段落、间隙与折返命中', async () => {
        const h = await createHarness(); h.picker.startSectionPicker(h.options as never); h.flushFrames();
        const third = h.document.createElement('p'); third.textContent = 'Third paragraph';
        third.getBoundingClientRect = () => rect(30, 180, 400, 40) as DOMRect;
        h.byId('readme').append(third);
        h.emit('pointerdown', {pointerId: 1, clientX: 50, clientY: 70});
        h.document.elementFromPoint = (_x, y) => y < 100 ? h.byId('para') : y < 120 ? null
            : y < 160 ? h.byId('second') : y < 180 ? h.byId('readme') : y < 220 ? third : h.byId('para');
        h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 50, clientY: 300});
        h.emit('pointerup', {pointerId: 1, clientX: 50, clientY: 300}); h.flushFrames(); vi.advanceTimersByTime(90);
        clickButton(h, 'confirm');
        expect(h.onPick).toHaveBeenCalledWith([h.byId('para'), h.byId('second'), third]);
    });

    it('同帧折线路径保留转角途经区域，只合并提交一次且松手前不盘点正文', async () => {
        const h = await createHarness(); h.picker.startSectionPicker(h.options as never); h.flushFrames();
        const third = h.document.createElement('p'); third.textContent = 'Third corner paragraph';
        third.getBoundingClientRect = () => rect(500, 120, 200, 40) as DOMRect;
        h.byId('readme').append(third);
        h.document.elementFromPoint = (x, y) => y < 110 ? h.byId('para') : x < 450 ? h.byId('second') : third;
        h.emit('pointerdown', {pointerId: 1, clientX: 50, clientY: 70});
        h.mutationObserver.disconnect.mockClear();
        h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 50, clientY: 140});
        for (let x = 60; x <= 550; x += 10) h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: x, clientY: 140});
        h.flushFrames();
        expect(h.host()!.getAttribute('data-selection-count')).toBe('3');
        // 开始划选一次，整批新范围一次；不会按五十多个事件反复重建观察。
        expect(h.mutationObserver.disconnect).toHaveBeenCalledTimes(2);
        vi.advanceTimersByTime(500);
        expect(h.inspect).not.toHaveBeenCalled();
        h.emit('pointerup', {pointerId: 1, clientX: 550, clientY: 140});
        vi.advanceTimersByTime(90);
        expect(h.inspect).toHaveBeenCalledOnce();
        expect(h.inspect).toHaveBeenCalledWith([h.byId('para'), h.byId('second'), third]);
        clickButton(h, 'confirm');
        expect(h.onPick).toHaveBeenCalledWith([h.byId('para'), h.byId('second'), third]);
    });

    it('松手在绘制帧之前到达时同步收齐路径，滚动后不把旧坐标落点误加入', async () => {
        const h = await createHarness(); h.picker.startSectionPicker(h.options as never); h.flushFrames();
        h.document.elementFromPoint = (_x, y) => y < 110 ? h.byId('para') : h.byId('second');
        h.emit('pointerdown', {pointerId: 1, clientX: 50, clientY: 70});
        h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 50, clientY: 140});
        h.emit('pointerup', {pointerId: 1, clientX: 50, clientY: 140});
        vi.advanceTimersByTime(90);
        expect(h.inspect).toHaveBeenCalledWith([h.byId('para'), h.byId('second')]);
        h.picker.stopSectionPicker();

        h.picker.startSectionPicker(h.options as never); h.flushFrames();
        h.inspect.mockClear();
        h.emit('pointerdown', {pointerId: 2, clientX: 50, clientY: 70});
        h.emit('pointermove', {pointerId: 2, buttons: 1, clientX: 50, clientY: 140});
        h.emit('scroll');
        h.emit('pointerup', {pointerId: 2, clientX: 50, clientY: 140});
        vi.advanceTimersByTime(90);
        expect(h.inspect).toHaveBeenCalledWith(h.byId('para'));
        h.picker.stopSectionPicker();
    });

    it('稳定窗结束前收到新位置但尚未绘制时，旧候选和迟到回调不会闪现', async () => {
        const h = await createHarness();
        const timers = vi.spyOn(globalThis, 'setTimeout');
        h.picker.startSectionPicker(h.options as never); h.flushFrames();
        h.hit.current = h.byId('second');
        h.emit('pointermove', {clientX: 50, clientY: 140}); h.flushFrames();
        const obsolete = timers.mock.calls.find(([, delay]) => delay === 80)![0] as () => void;
        vi.advanceTimersByTime(79);
        h.hit.current = h.byId('para');
        h.emit('pointermove', {clientX: 50, clientY: 70});
        vi.advanceTimersByTime(1); h.flushFrames();
        expect(query(h.shadow(), '.fr-section-box').style.transform).toBe('translate(27px, 57px)');
        h.hit.current = h.byId('second');
        h.emit('pointermove', {clientX: 50, clientY: 140}); h.flushFrames();
        obsolete(); h.flushFrames();
        expect(query(h.shadow(), '.fr-section-box').style.transform).toBe('translate(27px, 57px)');
        vi.advanceTimersByTime(80); h.flushFrames();
        expect(query(h.shadow(), '.fr-section-box').style.transform).toBe('translate(27px, 117px)');
        h.picker.stopSectionPicker();
    });

    it('无关侧栏滚动保留待绘制路径，路径所在的嵌套滚动区变化才撤销旧坐标', async () => {
        const h = await createHarness();
        const side = h.document.createElement('aside');
        side.getBoundingClientRect = () => rect(800, 0, 200, 700) as DOMRect;
        h.document.body.append(side);
        const start = () => {
            h.hit.current = h.byId('para');
            h.picker.startSectionPicker(h.options as never); h.flushFrames(); h.inspect.mockClear();
            h.emit('pointerdown', {pointerId: 1, clientX: 50, clientY: 70});
            h.hit.current = h.byId('second');
            h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 50, clientY: 140});
        };
        start();
        h.emit('scroll', {target: side});
        h.emit('pointerup', {pointerId: 1, clientX: 50, clientY: 140});
        vi.advanceTimersByTime(90);
        expect(h.inspect).toHaveBeenCalledWith([h.byId('para'), h.byId('second')]);
        h.picker.stopSectionPicker();
        start();
        h.emit('scroll', {target: h.byId('readme')});
        h.emit('pointerup', {pointerId: 1, clientX: 50, clientY: 140});
        vi.advanceTimersByTime(90);
        expect(h.inspect).toHaveBeenCalledWith(h.byId('para'));
        h.picker.stopSectionPicker();
    });

    it('划选整组支持扩大、缩回原来的两个区域和重新选择', async () => {
        const h = await createHarness(); h.picker.startSectionPicker(h.options as never); h.flushFrames();
        h.emit('pointerdown', {pointerId: 1, clientX: 50, clientY: 70});
        h.hit.current = h.byId('second');
        h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 50, clientY: 130});
        h.emit('pointerup', {pointerId: 1, clientX: 50, clientY: 130}); h.flushFrames(); vi.advanceTimersByTime(90);
        clickButton(h, 'expand'); h.flushFrames(); vi.advanceTimersByTime(90);
        expect(h.host()!.getAttribute('data-selection-count')).toBe('1');
        clickButton(h, 'shrink'); h.flushFrames(); vi.advanceTimersByTime(90);
        expect(h.host()!.getAttribute('data-selection-count')).toBe('2');
        clickButton(h, 'reselect'); h.flushFrames();
        expect(h.host()!.getAttribute('data-selection-state')).toBe('preview');
        expect(h.shadow().querySelectorAll('.fr-section-box.is-visible')).toHaveLength(0);
        h.emit('pointermove', {clientX: 50, clientY: 130}); h.flushFrames(); vi.advanceTimersByTime(90);
        h.emit('keydown', {key: 'Enter'});
        expect(h.onPick).toHaveBeenCalledWith(h.byId('second'));
    });

    it('划选非首段的正文变化刷新摘要，隐藏或移除该段使整组无法确认', async () => {
        for (const invalidation of ['remove', 'hidden']) {
            const h = await createHarness();
            h.inspect.mockImplementation((regions: Element | readonly Element[]) => summary({
                total: 3, pending: Array.isArray(regions) && regions.some(region => region.textContent === 'Updated paragraph') ? 3 : 2,
            }));
            h.picker.startSectionPicker(h.options as never); h.flushFrames();
            h.emit('pointerdown', {pointerId: 1, clientX: 50, clientY: 70});
            h.hit.current = h.byId('second');
            h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 50, clientY: 130});
            h.emit('pointerup', {pointerId: 1, clientX: 50, clientY: 130}); h.flushFrames(); vi.advanceTimersByTime(90);
            const second = h.byId('second'); second.textContent = 'Updated paragraph';
            h.emitMutation(second); vi.advanceTimersByTime(90); h.flushFrames();
            expect(query(h.shadow(), '.fr-section-bar-instruction').textContent).toBe('sectionTranslation.label.translate:{"count":3}');
            expect(h.inspect).toHaveBeenLastCalledWith([h.byId('para'), second]);
            h.emitResize(); h.flushFrames();
            if (invalidation === 'remove') { second.remove(); h.hit.current = null; h.emitMutation(h.byId('readme')); }
            else second.getBoundingClientRect = () => rect(30, 120, 0, 0) as DOMRect;
            h.emit('keydown', {key: 'Enter'}); h.flushFrames();
            expect(h.onPick).not.toHaveBeenCalled();
            expect(h.host()!.getAttribute('data-selection-state')).toBe('preview');
            h.picker.stopSectionPicker();
        }
    });

    it('指针取消、窗口失焦和 Esc 中止划选，迟到的松开不翻译', async () => {
        for (const exit of ['pointercancel', 'blur', 'Escape']) {
            const h = await createHarness(); h.picker.startSectionPicker(h.options as never); h.flushFrames();
            h.emit('pointerdown', {pointerId: 1, clientX: 50, clientY: 70});
            h.hit.current = h.byId('second'); h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 50, clientY: 130});
            h.emit('pointercancel', {pointerId: 2});
            if (exit === 'Escape') h.emit('keydown', {key: 'Escape'});
            else h.emit(exit, {pointerId: 1, target: exit === 'blur' ? window : undefined});
            h.emit('pointerup', {pointerId: 1, clientX: 50, clientY: 130}); h.flushFrames();
            expect(h.onPick).not.toHaveBeenCalled();
            if (h.host()) expect(h.host()!.getAttribute('data-selection-state')).toBe('preview');
            h.picker.stopSectionPicker();
        }
    });

    it('捕获到网页元素或旧选择器的失焦时保留划选，松开仍只锁定等待确认', async () => {
        const h = await createHarness(); h.picker.startSectionPicker(h.options as never); h.flushFrames();
        h.emit('pointerdown', {pointerId: 1, clientX: 50, clientY: 70});
        h.hit.current = h.byId('second');
        h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 50, clientY: 130}); h.flushFrames();
        const oldHost = h.document.createElement('fluent-read-section-picker');
        for (const target of [h.byId('para'), oldHost]) h.emit('blur', {target});
        h.flushFrames(); vi.advanceTimersByTime(320);
        expect(h.host()!.getAttribute('data-selection-state')).toBe('dragging');
        expect(h.host()!.getAttribute('data-selection-count')).toBe('2');
        h.emit('pointerup', {pointerId: 1, clientX: 50, clientY: 130});
        h.emit('click', {clientX: 50, clientY: 130}); h.flushFrames(); vi.advanceTimersByTime(90);
        expect(h.host()!.getAttribute('data-selection-state')).toBe('locked');
        expect(h.onPick).not.toHaveBeenCalled();
        clickButton(h, 'confirm');
        expect(h.onPick).toHaveBeenCalledOnce();
        expect(h.onPick).toHaveBeenCalledWith([h.byId('para'), h.byId('second')]);
    });

    it('伪造、非左键、非主指针和触屏拖动不启动划选，普通点击与触屏滚动保持原行为', async () => {
        const h = await createHarness(); h.picker.startSectionPicker(h.options as never); h.flushFrames();
        for (const properties of [{isTrusted: false}, {button: 1}, {isPrimary: false}, {pointerType: 'touch'}]) {
            const down = h.emit('pointerdown', {pointerId: 1, clientX: 50, clientY: 70, ...properties});
            expect(down.preventDefault).not.toHaveBeenCalled();
            h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 52, clientY: 72});
            h.emit('pointerup', {pointerId: 1, isTrusted: false});
            expect(h.host()!.getAttribute('data-selection-state')).toBe('preview');
        }
        h.emit('pointerdown', {pointerId: 1, clientX: 50, clientY: 70});
        h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 51, clientY: 71});
        h.emit('pointerup', {pointerId: 1, clientX: 51, clientY: 71});
        h.emit('click', {clientX: 51, clientY: 71}); h.flushFrames(); vi.advanceTimersByTime(90);
        h.emit('keydown', {key: 'Enter'}); expect(h.onPick).toHaveBeenCalledWith(h.byId('para'));
    });

    it('在区域外松开后回到网页的零按钮指针锁定已划过区域，下一次真实按下仍能确认', async () => {
        const h = await createHarness(); h.picker.startSectionPicker(h.options as never); h.flushFrames();
        h.emit('pointerdown', {pointerId: 1, clientX: 50, clientY: 70});
        h.hit.current = h.byId('second'); h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 50, clientY: 130});
        h.emit('pointermove', {pointerId: 1, buttons: 0, clientX: 50, clientY: 130}); h.flushFrames(); vi.advanceTimersByTime(90);
        expect(h.host()!.getAttribute('data-selection-state')).toBe('locked');
        h.emit('pointerdown', {composedPath: () => [h.host(), h.document.body]});
        clickButton(h, 'confirm'); expect(h.onPick).toHaveBeenCalledWith([h.byId('para'), h.byId('second')]);
    });

    it('划选单段仍可扩大和缩回，跨不同顶层区域时到顶提示不改变精确选区', async () => {
        const h = await createHarness(); h.picker.startSectionPicker(h.options as never); h.flushFrames();
        h.emit('pointerdown', {pointerId: 1, clientX: 50, clientY: 70});
        h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 70, clientY: 70});
        h.emit('pointerup', {pointerId: 1, clientX: 70, clientY: 70}); h.flushFrames(); vi.advanceTimersByTime(90);
        clickButton(h, 'expand'); h.flushFrames(); vi.advanceTimersByTime(90);
        expect(h.inspect).toHaveBeenLastCalledWith(h.byId('readme'));
        clickButton(h, 'shrink'); h.flushFrames(); vi.advanceTimersByTime(90);
        expect(h.inspect).toHaveBeenLastCalledWith(h.byId('para'));
        clickButton(h, 'reselect');
        h.document.body.appendChild(h.byId('second')); h.hit.current = h.byId('para');
        h.emit('pointerdown', {pointerId: 1, clientX: 50, clientY: 70});
        h.hit.current = h.byId('second'); h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 50, clientY: 130});
        h.emit('pointerup', {pointerId: 1, clientX: 50, clientY: 130}); h.flushFrames(); vi.advanceTimersByTime(90);
        h.emit('keydown', {key: 'ArrowUp'}); h.flushFrames(); vi.advanceTimersByTime(90);
        expect(h.inspect).toHaveBeenLastCalledWith([h.byId('readme'), h.byId('second')]);
        h.emit('keydown', {key: 'ArrowUp'});
        expect(query(h.shadow(), '.fr-section-label-action').textContent).toBe('sectionTranslation.label.topmost');
        vi.advanceTimersByTime(1200); h.emit('keydown', {key: 'Enter'});
        expect(h.onPick).toHaveBeenCalledWith([h.byId('readme'), h.byId('second')]);
    });

    it('划选扩大时去掉被祖先覆盖的包装层，原选区可完整缩回', async () => {
        const h = await createHarness();
        const wrapper = h.document.createElement('section'); wrapper.getBoundingClientRect = () => rect(25, 110, 500, 100) as DOMRect;
        h.byId('readme').appendChild(wrapper); wrapper.appendChild(h.byId('second'));
        h.picker.startSectionPicker(h.options as never); h.flushFrames();
        h.emit('pointerdown', {pointerId: 1, clientX: 50, clientY: 70});
        h.hit.current = h.byId('second'); h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 50, clientY: 130});
        h.emit('pointerup', {pointerId: 1, clientX: 50, clientY: 130}); h.flushFrames(); vi.advanceTimersByTime(90);
        clickButton(h, 'expand'); h.flushFrames(); vi.advanceTimersByTime(90);
        expect(h.inspect).toHaveBeenLastCalledWith(h.byId('readme'));
        clickButton(h, 'shrink'); h.flushFrames(); vi.advanceTimersByTime(90);
        expect(h.inspect).toHaveBeenLastCalledWith([h.byId('para'), h.byId('second')]);
    });

    it('划选从页面空白开始仍可收集段落；渲染时拒绝已隐藏或断开的非首段', async () => {
        for (const disconnected of [false, true]) {
            const h = await createHarness(); h.picker.startSectionPicker(h.options as never); h.flushFrames();
            h.hit.current = null; h.emit('pointerdown', {pointerId: 1, clientX: 0, clientY: 0});
            h.hit.current = h.byId('para'); h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 50, clientY: 70});
            h.hit.current = h.byId('second'); h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 50, clientY: 130});
            h.emit('pointerup', {pointerId: 1, clientX: 50, clientY: 130}); h.flushFrames(); vi.advanceTimersByTime(90);
            const second = h.byId('second');
            if (disconnected) second.remove(); else second.getBoundingClientRect = () => rect(30, 120, 0, 0) as DOMRect;
            h.hit.current = null; h.emit('scroll'); h.flushFrames();
            expect(h.host()!.getAttribute('data-selection-state')).toBe('preview');
            expect(h.shadow().querySelectorAll('.fr-section-box.is-visible')).toHaveLength(0);
            h.emit('pointercancel', {pointerId: 1}); h.emit('pointercancel', {isTrusted: false}); h.emit('blur', {target: window}); h.emit('blur', {isTrusted: false, target: window});
            h.picker.stopSectionPicker();
        }
    });

    it('在封闭 Shadow Root 中即时高亮初始段落，用自然语言范围和区域操作条显示预览', async () => {
        const harness = await createHarness();
        expect(harness.picker.startSectionPicker(harness.options as never)).toBe(true);
        expect(harness.picker.isSectionPickerActive()).toBe(true);
        const host = harness.host()!;
        expect(host.getAttribute('translate')).toBe('no');
        expect(host.shadowRoot).toBeNull();
        expect(host.style.getPropertyValue('pointer-events')).toBe('none');

        harness.flushFrames();
        const shadow = harness.shadow();
        const box = query(shadow, '.fr-section-box');
        expect(box.classList.contains('is-visible')).toBe(true);
        expect(box.classList.contains('is-following')).toBe(false);
        expect(box.style.transform).toBe('translate(27px, 57px)');
        expect(box.style.width).toBe('406px');
        expect(query(shadow, '.fr-section-label-action').textContent).toBe('sectionTranslation.label.inspecting');
        expect(query(shadow, '.fr-section-label-meta').textContent).toBe('sectionTranslation.scope.paragraph');
        expect(query(shadow, '.fr-section-bar').getAttribute('role')).toBe('region');
        expect(query(shadow, '.fr-section-bar').getAttribute('aria-label')).toBe('sectionTranslation.picker.title');
        expect(query(shadow, '.fr-section-bar-instruction').getAttribute('role')).toBe('status');
        expect(query(shadow, '.fr-section-bar-instruction').getAttribute('aria-live')).toBe('polite');
        expect(query(shadow, '.fr-section-bar-actions').getAttribute('role')).toBe('toolbar');
        expect(shadow.querySelector('.fr-section-bar-preview')).toBeNull();
        expect(shadow.querySelector('.fr-section-bar-keys')).toBeNull();
        expect(query(shadow, '.fr-section-bar').textContent).not.toContain('Hello world');
        expect(query(shadow, '.fr-section-bar-close').getAttribute('aria-label')).toBe('sectionTranslation.picker.close');

        vi.advanceTimersByTime(90);
        expect(harness.inspect).toHaveBeenCalledWith(harness.byId('para'));
        expect(query(shadow, '.fr-section-label-action').textContent).toBe('sectionTranslation.label.translate:{"count":2}');

        harness.inspect.mockReturnValueOnce(summary({active: 2, pending: 0, action: 'restore'}));
        harness.hit.current = harness.byId('second');
        harness.emit('pointermove', {clientX: 60, clientY: 130});
        harness.flushFrames();
        expect(box.style.transform).toBe('translate(27px, 57px)');
        vi.advanceTimersByTime(80);
        harness.flushFrames();
        expect(box.classList.contains('is-following')).toBe(true);
        vi.advanceTimersByTime(90);
        expect(box.classList.contains('tone-restore')).toBe(true);
        expect(query(shadow, '.fr-section-label').classList.contains('tone-restore')).toBe(true);

        // 回到已盘点过的区域时即时复用结果，后续延时刷新避免缓存过期。
        harness.hit.current = harness.byId('para');
        harness.emit('pointermove', {clientX: 50, clientY: 70});
        harness.flushFrames();
        vi.advanceTimersByTime(80);
        harness.flushFrames();
        expect(harness.inspect).toHaveBeenCalledTimes(2);
        expect(query(shadow, '.fr-section-label-action').textContent).toBe('sectionTranslation.label.translate:{"count":2}');
        harness.picker.stopSectionPicker();
    });

    it('快速划过时只盘点最终停留的区域', async () => {
        const harness = await createHarness();
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        harness.hit.current = harness.byId('second');
        harness.emit('pointermove', {clientX: 60, clientY: 130});
        harness.flushFrames();
        vi.advanceTimersByTime(80);
        harness.flushFrames();
        expect(harness.inspect).not.toHaveBeenCalled();
        vi.advanceTimersByTime(89);
        expect(harness.inspect).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(harness.inspect).toHaveBeenCalledOnce();
        expect(harness.inspect).toHaveBeenCalledWith(harness.byId('second'));
        harness.picker.stopSectionPicker();
    });

    it('候选段落与祖先来回切换会重新计时，同一候选的连续移动在第 80ms 换区', async () => {
        const harness = await createHarness();
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        const box = query(harness.shadow(), '.fr-section-box');
        const move = (id: string, x: number, y: number) => {
            harness.hit.current = harness.byId(id);
            harness.emit('pointermove', {clientX: x, clientY: y});
            harness.flushFrames();
        };

        move('second', 60, 130);
        vi.advanceTimersByTime(79);
        expect(box.style.transform).toBe('translate(27px, 57px)');
        move('readme', 600, 200);
        vi.advanceTimersByTime(79);
        harness.flushFrames();
        expect(box.style.transform).toBe('translate(27px, 57px)');
        move('second', 60, 130);
        vi.advanceTimersByTime(79);
        harness.flushFrames();
        expect(box.style.transform).toBe('translate(27px, 57px)');
        // 同一候选内继续移动不能不断重置稳定窗口，造成永远选不中。
        move('second', 65, 135);
        vi.advanceTimersByTime(1);
        harness.flushFrames();
        expect(box.style.transform).toBe('translate(27px, 117px)');
        expect(box.classList.contains('is-following')).toBe(true);
        vi.advanceTimersByTime(90);
        expect(harness.inspect).toHaveBeenLastCalledWith(harness.byId('second'));
        expect(harness.inspect).not.toHaveBeenCalledWith(harness.byId('readme'));

        move('readme', 600, 200);
        vi.advanceTimersByTime(79);
        move('second', 60, 130);
        vi.advanceTimersByTime(100);
        harness.flushFrames();
        expect(box.style.transform).toBe('translate(27px, 117px)');
        expect(harness.onPick).not.toHaveBeenCalled();
        harness.picker.stopSectionPicker();
    });

    it.each([
        ['左', 24, 70, 23, 70],
        ['右', 436, 70, 437, 70],
        ['上', 50, 54, 50, 53],
        ['下', 50, 106, 50, 107],
    ])('%s边 6px 内命中父容器仍保持段落，超过容差才启动稳定窗口', async (_edge, x, y, outsideX, outsideY) => {
        const harness = await createHarness();
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        const box = query(harness.shadow(), '.fr-section-box');
        harness.hit.current = harness.byId('readme');
        harness.emit('pointermove', {clientX: x, clientY: y});
        harness.flushFrames();
        vi.advanceTimersByTime(200);
        harness.flushFrames();
        expect(box.style.transform).toBe('translate(27px, 57px)');
        expect(box.style.width).toBe('406px');

        harness.emit('pointermove', {clientX: outsideX, clientY: outsideY});
        harness.flushFrames();
        vi.advanceTimersByTime(79);
        harness.flushFrames();
        expect(box.style.width).toBe('406px');
        vi.advanceTimersByTime(1);
        harness.flushFrames();
        expect(box.style.width).toBe('806px');
        expect(query(harness.shadow(), '.fr-section-label-meta').textContent).toBe('sectionTranslation.scope.article');
        harness.picker.stopSectionPicker();
    });

    it('段落 bottom + 3px 命中祖先时，点击仍锁定高亮段落，确认也只传入该段落', async () => {
        const harness = await createHarness();
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        harness.hit.current = harness.byId('readme');
        harness.emit('pointermove', {clientX: 50, clientY: 103});
        harness.flushFrames();
        vi.advanceTimersByTime(80);
        expect(query(harness.shadow(), '.fr-section-box').style.height).toBe('46px');
        harness.emit('click', {clientX: 50, clientY: 103});
        harness.flushFrames();
        expect(harness.host()!.getAttribute('data-selection-state')).toBe('locked');
        expect(query(harness.shadow(), '.fr-section-box').style.height).toBe('46px');
        expect(harness.onPick).not.toHaveBeenCalled();
        vi.advanceTimersByTime(90);
        expect(harness.inspect).toHaveBeenLastCalledWith(harness.byId('para'));
        clickButton(harness, 'confirm');
        expect(harness.onPick).toHaveBeenCalledOnce();
        expect(harness.onPick).toHaveBeenCalledWith(harness.byId('para'));
        expect(harness.inspect).not.toHaveBeenCalledWith(harness.byId('readme'));
    });

    it('从容器 padding 进入内部段落时 80ms 后缩回段落，容差不吞掉后代候选', async () => {
        const harness = await createHarness({initialPoint: {x: 600, y: 200}});
        harness.hit.current = harness.byId('readme');
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        const box = query(harness.shadow(), '.fr-section-box');
        expect(box.style.width).toBe('806px');
        harness.hit.current = harness.byId('bold');
        harness.emit('pointermove', {clientX: 50, clientY: 70});
        harness.flushFrames();
        vi.advanceTimersByTime(79);
        harness.flushFrames();
        expect(box.style.width).toBe('806px');
        vi.advanceTimersByTime(1);
        harness.flushFrames();
        expect(box.style.width).toBe('406px');
        expect(query(harness.shadow(), '.fr-section-label-meta').textContent).toBe('sectionTranslation.scope.paragraph');
        harness.picker.stopSectionPicker();
    });

    it('容器高亮期间点击内部段落即时重解析并锁定段落，不误锁祖先', async () => {
        const harness = await createHarness({initialPoint: {x: 600, y: 200}});
        harness.hit.current = harness.byId('readme');
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        harness.hit.current = harness.byId('bold');
        harness.emit('click', {clientX: 50, clientY: 70});
        harness.flushFrames();
        expect(query(harness.shadow(), '.fr-section-box').style.width).toBe('406px');
        expect(harness.host()!.getAttribute('data-selection-state')).toBe('locked');
        expect(harness.onPick).not.toHaveBeenCalled();
        harness.emit('keydown', {key: 'Enter'});
        expect(harness.onPick).toHaveBeenCalledWith(harness.byId('para'));
    });

    it('旧 empty 段落在扩大期间填入原文，缩回后延时刷新缓存并启用确认', async () => {
        const harness = await createHarness();
        const para = harness.byId('para');
        para.textContent = '';
        harness.hit.current = para;
        harness.inspect.mockImplementation((element: Element) => summary({action: element.textContent?.trim() ? 'translate' : 'empty'}));
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        vi.advanceTimersByTime(90);
        expect(query(harness.shadow(), '.fr-section-label-action').textContent).toBe('sectionTranslation.label.empty');
        harness.emit('keydown', {key: 'ArrowUp'});
        harness.hit.current = harness.byId('readme');
        harness.emit('click', {clientX: 600, clientY: 200});
        vi.advanceTimersByTime(90);
        para.textContent = 'New English source';
        harness.emitMutation(para);
        clickButton(harness, 'shrink');
        harness.flushFrames();
        expect(query(harness.shadow(), '.fr-section-box').style.width).toBe('406px');
        expect(query(harness.shadow(), '.fr-section-label-action').textContent).toBe('sectionTranslation.label.empty');
        expect(button(harness, 'confirm').disabled).toBe(true);
        vi.advanceTimersByTime(89);
        expect(button(harness, 'confirm').disabled).toBe(true);
        vi.advanceTimersByTime(1);
        expect(button(harness, 'confirm').disabled).toBe(false);
        expect(harness.inspect).toHaveBeenLastCalledWith(para);
        expect(query(harness.shadow(), '.fr-section-bar-instruction').textContent).toBe('sectionTranslation.label.translate:{"count":2}');
        clickButton(harness, 'confirm');
        expect(harness.onPick).toHaveBeenCalledWith(para);
    });

    it.each(['hover', 'click'])('Shadow host padding 高亮后 %s 内部段落，按组合祖先缩小而不被容差保留宿主', async (mode) => {
        const harness = await createHarness({initialPoint: {x: 10, y: 290}});
        const host = harness.byId('shadow-host');
        const root = host.attachShadow({mode: 'open'});
        const inner = harness.document.createElement('p');
        inner.textContent = 'English source in shadow';
        root.appendChild(inner);
        host.getBoundingClientRect = () => rect(0, 280, 600, 120) as DOMRect;
        inner.getBoundingClientRect = () => rect(100, 300, 300, 80) as DOMRect;
        let innerHit: Element | null = null;
        (root as unknown as {elementFromPoint: () => Element | null}).elementFromPoint = () => innerHit;
        harness.hit.current = host;
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        expect(query(harness.shadow(), '.fr-section-box').style.width).toBe('606px');
        innerHit = inner;
        if (mode === 'hover') {
            harness.emit('pointermove', {clientX: 120, clientY: 320});
            harness.flushFrames();
            vi.advanceTimersByTime(79);
            harness.flushFrames();
            expect(query(harness.shadow(), '.fr-section-box').style.width).toBe('606px');
            vi.advanceTimersByTime(1);
        } else {
            harness.emit('click', {clientX: 120, clientY: 320});
            expect(harness.host()!.getAttribute('data-selection-state')).toBe('locked');
        }
        harness.flushFrames();
        expect(query(harness.shadow(), '.fr-section-box').style.width).toBe('306px');
        expect(query(harness.shadow(), '.fr-section-label-meta').textContent).toBe('sectionTranslation.scope.paragraph');
        expect(harness.onPick).not.toHaveBeenCalled();
        harness.emit('keydown', {key: 'Enter'});
        expect(harness.onPick).toHaveBeenCalledWith(inner);
    });

    it('锁定宿主或祖先后观察内部 ShadowRoot，影子原文变化会刷新所锁范围摘要', async () => {
        for (const useAncestor of [false, true]) {
            const harness = await createHarness({initialPoint: {x: 10, y: 290}});
            const host = harness.byId('shadow-host');
            const root = host.attachShadow({mode: 'open'});
            const inner = harness.document.createElement('p');
            root.appendChild(inner);
            const ancestor = harness.document.createElement('section');
            harness.document.body.appendChild(ancestor);
            ancestor.appendChild(host);
            host.getBoundingClientRect = () => rect(0, 280, 600, 120) as DOMRect;
            ancestor.getBoundingClientRect = () => rect(0, 260, 800, 180) as DOMRect;
            (root as unknown as {elementFromPoint: () => null}).elementFromPoint = () => null;
            harness.hit.current = host;
            harness.inspect.mockImplementation(() => summary({action: root.querySelector('p')?.textContent ? 'translate' : 'empty'}));
            harness.picker.startSectionPicker(harness.options as never);
            harness.flushFrames();
            // 预览宿主时不扫描内部树；只有锁定范围后才观察开放的 ShadowRoot。
            expect(harness.mutationObserver.observe).not.toHaveBeenCalledWith(root, expect.anything());
            if (useAncestor) harness.emit('keydown', {key: 'ArrowUp'});
            harness.emit('click', {clientX: 10, clientY: useAncestor ? 270 : 290});
            vi.advanceTimersByTime(90);
            expect(button(harness, 'confirm').disabled).toBe(true);
            expect(harness.mutationObserver.observe).toHaveBeenCalledWith(root, expect.objectContaining({childList: true, characterData: true, subtree: true, attributes: true}));
            // innerHTML 替换的 childList target 是 ShadowRoot 本身，不能依赖 parentElement。
            root.innerHTML = '<p>Shadow content became translatable</p>';
            harness.emitMutation(root);
            vi.advanceTimersByTime(90);
            expect(button(harness, 'confirm').disabled).toBe(false);
            expect(harness.inspect).toHaveBeenLastCalledWith(useAncestor ? ancestor : host);
            clickButton(harness, 'confirm');
            expect(harness.onPick).toHaveBeenCalledWith(useAncestor ? ancestor : host);
        }
    });

    it('锁定后新插入的嵌套 ShadowRoot 持续刷新摘要，扫描只检查新增子树', async () => {
        const harness = await createHarness();
        const region = harness.byId('para');
        region.textContent = '';
        harness.hit.current = region;
        let text = '';
        harness.inspect.mockImplementation(() => summary({action: text ? 'translate' : 'empty'}));
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        harness.emit('click', {clientX: 50, clientY: 70});
        harness.flushFrames();
        vi.advanceTimersByTime(90);
        expect(button(harness, 'confirm').disabled).toBe(true);
        const createWalker = vi.spyOn(harness.document, 'createTreeWalker');
        const host = harness.document.createElement('section');
        const root = host.attachShadow({mode: 'open'});
        const nested = harness.document.createElement('div');
        const innerRoot = nested.attachShadow({mode: 'open'});
        const source = harness.document.createElement('p');
        innerRoot.appendChild(source);
        root.appendChild(nested);
        region.appendChild(host);
        harness.emitMutation(region, [host]);
        harness.flushFrames();
        expect(harness.mutationObserver.observe).toHaveBeenCalledWith(root, expect.anything());
        expect(harness.mutationObserver.observe).toHaveBeenCalledWith(innerRoot, expect.anything());
        expect(createWalker.mock.calls.every(([node]) => node !== region && node !== harness.document.documentElement)).toBe(true);
        vi.advanceTimersByTime(90);
        expect(button(harness, 'confirm').disabled).toBe(true);
        text = source.textContent = 'New source inside a newly inserted web component';
        harness.emitMutation(source.firstChild!);
        vi.advanceTimersByTime(90);
        expect(button(harness, 'confirm').disabled).toBe(false);
        expect(harness.inspect).toHaveBeenLastCalledWith(region);
        createWalker.mockClear();
        for (let index = 0; index < 50; index++) harness.emitMutation(source.firstChild!);
        vi.advanceTimersByTime(90);
        expect(createWalker).not.toHaveBeenCalled();
        harness.picker.stopSectionPicker();
    });

    it('大选区的开放 ShadowRoot 发现每帧最多检查 150 个元素，退出后迟到扫描不再工作', async () => {
        const harness = await createHarness();
        const region = harness.byId('para');
        region.textContent = '';
        harness.hit.current = region;
        let reads = 0;
        let lastRoot: ShadowRoot | undefined;
        for (let index = 0; index < 450; index++) {
            const child = harness.document.createElement('section');
            const root = index === 449 ? child.attachShadow({mode: 'open'}) : null;
            Object.defineProperty(child, 'shadowRoot', {configurable: true, get: () => {reads++; return root;}});
            region.appendChild(child);
            if (root) lastRoot = root;
        }
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        reads = 0;
        harness.emit('click', {clientX: 50, clientY: 70});
        expect(reads).toBeLessThanOrEqual(150);
        // 用身份布尔值断言，避免 Chai 格式化整棵 DOM 时额外执行 shadowRoot getter。
        expect(harness.mutationObserver.observe.mock.calls.some(([node]) => node === lastRoot)).toBe(false);
        while (harness.frames.length) {
            const before = reads;
            harness.frames.shift()!();
            expect(reads - before).toBeLessThanOrEqual(150);
        }
        expect(harness.mutationObserver.observe.mock.calls.some(([node]) => node === lastRoot)).toBe(true);
        expect(reads).toBe(450);
        const added = harness.document.createElement('div');
        for (let index = 0; index < 450; index++) added.appendChild(harness.document.createElement('span'));
        region.appendChild(added);
        harness.emitMutation(region, [added]);
        const lateFrames = [...harness.frames];
        harness.picker.stopSectionPicker();
        const completed = reads;
        const observations = harness.mutationObserver.observe.mock.calls.length;
        lateFrames.forEach(callback => callback());
        expect(reads).toBe(completed);
        expect(harness.mutationObserver.observe.mock.calls).toHaveLength(observations);
        expect(harness.host()).toBeNull();
    });

    it('锁定正文插入文本和注释只刷新摘要，不为非元素节点扫描影子树', async () => {
        const harness = await createHarness();
        const region = harness.byId('para');
        harness.inspect.mockImplementation(() => summary({
            total: 3, pending: region.textContent?.includes('Additional original text') ? 3 : 2,
        }));
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        harness.emit('click', {clientX: 50, clientY: 70});
        harness.flushFrames();
        vi.advanceTimersByTime(90);
        harness.inspect.mockClear();
        const walker = vi.spyOn(harness.document, 'createTreeWalker');
        const text = harness.document.createTextNode(' Additional original text');
        const comment = harness.document.createComment('not translated');
        region.append(text, comment);
        harness.emitMutation(region, [text, comment]);
        vi.advanceTimersByTime(90);
        expect(walker).not.toHaveBeenCalled();
        expect(harness.inspect).toHaveBeenCalledOnce();
        expect(harness.inspect).toHaveBeenLastCalledWith(region);
        expect(query(harness.shadow(), '.fr-section-bar-instruction').textContent).toBe('sectionTranslation.label.translate:{"count":3}');
        harness.picker.stopSectionPicker();
    });

    it.each(['Enter', 'Escape'])('锁定把焦点移到操作条，操作条支持范围键，%s 退出时还原网页输入焦点', async (exitKey) => {
        const harness = await createHarness();
        const input = harness.document.createElement('input');
        harness.document.body.appendChild(input);
        input.focus = vi.fn();
        let activeElement: Element = input;
        Object.defineProperty(harness.document, 'activeElement', {configurable: true, get: () => activeElement});
        harness.options.isEditing = isEditingInPage;
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        const bar = query(harness.shadow(), '.fr-section-bar');
        expect(bar.tabIndex).toBe(-1);
        const focus = vi.fn(() => {
            activeElement = harness.host()!;
            Object.defineProperty(harness.shadow(), 'activeElement', {configurable: true, value: bar});
        });
        bar.focus = focus;
        expect(harness.emit('keydown', {key: 'Enter', target: input}).preventDefault).not.toHaveBeenCalled();
        harness.emit('click', {clientX: 50, clientY: 70});
        expect(focus).toHaveBeenCalledWith({preventScroll: true});
        expect(isEditingInPage({composedPath: () => [harness.host()!]} as unknown as KeyboardEvent)).toBe(true);
        // 封闭 ShadowRoot 在 window 上只暴露宿主；通用输入保护会将这个宿主视为不透明输入场景。
        const keys = (key: string) => harness.emit('keydown', {key, target: harness.host(), composedPath: () => [harness.host(), harness.document.body]});
        expect(keys('ArrowUp').preventDefault).toHaveBeenCalled();
        harness.flushFrames();
        expect(query(harness.shadow(), '.fr-section-box').style.width).toBe('806px');
        expect(keys('ArrowDown').preventDefault).toHaveBeenCalled();
        harness.flushFrames();
        expect(query(harness.shadow(), '.fr-section-box').style.width).toBe('406px');
        expect(keys(exitKey).preventDefault).toHaveBeenCalled();
        expect(input.focus).toHaveBeenCalledOnce();
        expect(input.focus).toHaveBeenCalledWith({preventScroll: true});
        expect(harness.picker.isSectionPickerActive()).toBe(false);
        if (exitKey === 'Enter') expect(harness.onPick).toHaveBeenCalledWith(harness.byId('para'));
        else expect(harness.onPick).not.toHaveBeenCalled();
    });

    it('工具按钮焦点下方向键调整范围、Enter 保留原生激活，退出不还原已经断开的旧焦点', async () => {
        const harness = await createHarness();
        const input = harness.document.createElement('input');
        harness.document.body.appendChild(input);
        input.focus = vi.fn();
        let activeElement: Element = input;
        Object.defineProperty(harness.document, 'activeElement', {configurable: true, get: () => activeElement});
        harness.options.isEditing = isEditingInPage;
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        harness.emit('click', {clientX: 50, clientY: 70});
        const confirm = button(harness, 'confirm');
        activeElement = harness.host()!;
        Object.defineProperty(harness.shadow(), 'activeElement', {configurable: true, value: confirm});
        const keys = (key: string) => harness.emit('keydown', {key, target: harness.host(), composedPath: () => [harness.host(), harness.document.body]});
        expect(keys('ArrowUp').preventDefault).toHaveBeenCalled();
        harness.flushFrames();
        expect(query(harness.shadow(), '.fr-section-box').style.width).toBe('806px');
        expect(keys('ArrowDown').preventDefault).toHaveBeenCalled();
        harness.flushFrames();
        expect(query(harness.shadow(), '.fr-section-box').style.width).toBe('406px');
        const enter = keys('Enter');
        expect(enter.preventDefault).not.toHaveBeenCalled();
        expect(enter.stopImmediatePropagation).not.toHaveBeenCalled();
        expect(harness.onPick).not.toHaveBeenCalled();
        input.remove();
        harness.emit('keydown', {key: 'Escape'});
        expect(input.focus).not.toHaveBeenCalled();
    });

    it('没有 MutationObserver 与 ResizeObserver 的环境仍可锁定、滚动贴合并确认', async () => {
        const harness = await createHarness({withObservers: false});
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        harness.emit('click', {clientX: 50, clientY: 70});
        harness.hit.current = harness.byId('second');
        harness.byId('para').getBoundingClientRect = () => rect(30, 200, 400, 50) as DOMRect;
        harness.emit('scroll');
        harness.flushFrames();
        expect(query(harness.shadow(), '.fr-section-box').style.transform).toBe('translate(27px, 197px)');
        vi.advanceTimersByTime(90);
        clickButton(harness, 'confirm');
        expect(harness.onPick).toHaveBeenCalledWith(harness.byId('para'));
        expect(harness.picker.isSectionPickerActive()).toBe(false);
        expect(harness.mutationObserver.observe).not.toHaveBeenCalled();
        expect(harness.resizeObserver.observe).not.toHaveBeenCalled();
        expect(harness.mutationObserver.disconnect).not.toHaveBeenCalled();
        expect(harness.resizeObserver.disconnect).not.toHaveBeenCalled();
        vi.advanceTimersByTime(320);
        expect(harness.host()).toBeNull();
    });

    it('停止后平台迟到的捕获关闭回调不会重复释放观察器，也不会影响新会话', async () => {
        const harness = await createHarness();
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        const oldClose = harness.windowListeners.find(entry => entry.type === 'contextmenu')!.listener;
        harness.mutationObserver.disconnect.mockClear();
        harness.resizeObserver.disconnect.mockClear();
        harness.picker.stopSectionPicker();
        // 保留旧平台回调模拟取消边界上的迟到事件，正常 emit 仍严格尊重 AbortSignal。
        oldClose(harness.emit('contextmenu'));
        expect(harness.mutationObserver.disconnect).toHaveBeenCalledOnce();
        expect(harness.resizeObserver.disconnect).toHaveBeenCalledOnce();
        expect(harness.onPick).not.toHaveBeenCalled();
        harness.picker.startSectionPicker(harness.options as never);
        const nextHost = harness.host();
        oldClose(harness.emit('mouseover'));
        expect(harness.host()).toBe(nextHost);
        expect(harness.picker.isSectionPickerActive()).toBe(true);
        harness.picker.stopSectionPicker();
    });

    it('已经排队的稳定回调在锁定或退出后到达时，不换区也不影响后续会话', async () => {
        const harness = await createHarness();
        const timers = vi.spyOn(globalThis, 'setTimeout');
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        harness.hit.current = harness.byId('second');
        harness.emit('pointermove', {clientX: 60, clientY: 130});
        harness.flushFrames();
        const settle = timers.mock.calls.find(([, delay]) => delay === 80)![0] as () => void;
        harness.emit('click', {clientX: 50, clientY: 70});
        // 正常计时已被取消，单独模拟平台已经排队的旧回调。
        settle();
        harness.flushFrames();
        expect(harness.host()!.getAttribute('data-selection-state')).toBe('locked');
        expect(query(harness.shadow(), '.fr-section-box').style.width).toBe('406px');
        expect(query(harness.shadow(), '.fr-section-box').style.transform).toBe('translate(27px, 57px)');
        harness.picker.stopSectionPicker();
        settle();
        expect(harness.host()).toBeNull();
        harness.hit.current = harness.byId('para');
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        const nextHost = harness.host();
        settle();
        expect(harness.host()).toBe(nextHost);
        expect(query(harness.shadow(), '.fr-section-box').style.transform).toBe('translate(27px, 57px)');
        expect(harness.onPick).not.toHaveBeenCalled();
        harness.picker.stopSectionPicker();
    });

    it('迟到的已脱离原文文本 mutation 只触发重绘，不重新盘点当前锁定范围', async () => {
        const harness = await createHarness();
        const para = harness.byId('para');
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        harness.emit('click', {clientX: 50, clientY: 70});
        vi.advanceTimersByTime(90);
        harness.inspect.mockClear();
        const removed = para.firstChild!;
        para.removeChild(removed);
        removed.textContent = 'Late update to removed source';
        harness.emitMutation(removed);
        harness.flushFrames();
        vi.advanceTimersByTime(90);
        expect(harness.inspect).not.toHaveBeenCalled();
        expect(harness.host()!.getAttribute('data-selection-state')).toBe('locked');
        expect(harness.onPick).not.toHaveBeenCalled();
        harness.picker.stopSectionPicker();
    });

    it('移向自身界面、锁定和退出均取消待稳定候选，迟到的计时不会改选区', async () => {
        const harness = await createHarness();
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        const box = query(harness.shadow(), '.fr-section-box');
        harness.hit.current = harness.byId('second');
        harness.emit('pointermove', {clientX: 60, clientY: 130});
        harness.flushFrames();
        vi.advanceTimersByTime(40);
        harness.hit.current = harness.byId('ball');
        harness.emit('pointermove', {clientX: 900, clientY: 700});
        harness.flushFrames();
        vi.advanceTimersByTime(100);
        harness.flushFrames();
        expect(box.style.transform).toBe('translate(27px, 57px)');

        harness.hit.current = harness.byId('second');
        harness.emit('pointermove', {clientX: 60, clientY: 130});
        harness.flushFrames();
        vi.advanceTimersByTime(40);
        harness.emit('click', {clientX: 50, clientY: 70});
        vi.advanceTimersByTime(100);
        harness.flushFrames();
        expect(box.style.transform).toBe('translate(27px, 57px)');
        expect(harness.host()!.getAttribute('data-selection-state')).toBe('locked');

        clickButton(harness, 'reselect');
        harness.hit.current = harness.byId('para');
        harness.emit('pointermove', {clientX: 50, clientY: 70});
        harness.flushFrames();
        harness.hit.current = harness.byId('second');
        harness.emit('pointermove', {clientX: 60, clientY: 130});
        harness.flushFrames();
        harness.inspect.mockClear();
        harness.picker.stopSectionPicker();
        vi.advanceTimersByTime(200);
        harness.flushFrames();
        expect(harness.inspect).not.toHaveBeenCalled();
        expect(harness.onPick).not.toHaveBeenCalled();
        expect(harness.host()).toBeNull();
    });

    it('锁定后鼠标、滚动、缩放和再次点击都不换区，只重新贴合锁定框', async () => {
        const harness = await createHarness();
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        harness.emit('click', {clientX: 50, clientY: 70});
        harness.hit.current = harness.byId('second');
        harness.emit('pointermove', {clientX: 60, clientY: 130});
        harness.emit('click', {clientX: 60, clientY: 130});
        harness.byId('para').getBoundingClientRect = () => rect(40, 200, 420, 50) as DOMRect;
        harness.emit('scroll');
        harness.emit('resize');
        harness.flushFrames();
        vi.advanceTimersByTime(200);
        harness.flushFrames();
        const box = query(harness.shadow(), '.fr-section-box');
        expect(box.style.transform).toBe('translate(37px, 197px)');
        expect(box.style.width).toBe('426px');
        expect(box.classList.contains('is-following')).toBe(false);
        expect(harness.inspect).toHaveBeenCalledOnce();
        expect(harness.inspect).toHaveBeenCalledWith(harness.byId('para'));
        expect(harness.onPick).not.toHaveBeenCalled();
        harness.emit('keydown', {key: 'Enter'});
        expect(harness.onPick).toHaveBeenCalledWith(harness.byId('para'));
    });

    it('可见的扩大、缩小和重新选择按钮调整锁定范围，重新选择清空范围链并恢复预览', async () => {
        const harness = await createHarness();
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        for (const name of ['expand', 'shrink', 'reselect', 'confirm']) {
            if (name === 'expand' || name === 'shrink') {
                expect(button(harness, name).textContent).toBe(name === 'expand' ? '＋' : '−');
                expect(button(harness, name).getAttribute('aria-label')).toBe(`sectionTranslation.picker.${name}`);
                expect(button(harness, name).title).toBe(`sectionTranslation.picker.${name}`);
            } else expect(button(harness, name).textContent).toBe(`sectionTranslation.picker.${name}`);
            expect(button(harness, name).hidden).toBe(false);
            expect(button(harness, name).type).toBe('button');
        }
        expect(button(harness, 'expand').disabled).toBe(false);
        expect(button(harness, 'shrink').disabled).toBe(true);
        expect(button(harness, 'reselect').disabled).toBe(true);
        expect(button(harness, 'confirm').disabled).toBe(true);
        clickButton(harness, 'expand');
        harness.flushFrames();
        expect(harness.host()!.getAttribute('data-selection-state')).toBe('locked');
        expect(query(harness.shadow(), '.fr-section-box').style.width).toBe('806px');
        expect(query(harness.shadow(), '.fr-section-label-meta').textContent).toBe('sectionTranslation.scope.article');
        expect(button(harness, 'expand').disabled).toBe(true);
        expect(button(harness, 'shrink').disabled).toBe(false);
        expect(button(harness, 'reselect').disabled).toBe(false);
        vi.advanceTimersByTime(90);
        expect(button(harness, 'confirm').disabled).toBe(false);
        clickButton(harness, 'shrink');
        harness.flushFrames();
        expect(query(harness.shadow(), '.fr-section-box').style.width).toBe('406px');
        expect(button(harness, 'shrink').disabled).toBe(true);
        expect(harness.host()!.getAttribute('data-selection-state')).toBe('locked');
        clickButton(harness, 'expand');
        clickButton(harness, 'reselect');
        harness.flushFrames();
        expect(harness.host()!.getAttribute('data-selection-state')).toBe('preview');
        expect(query(harness.shadow(), '.fr-section-box').classList.contains('is-visible')).toBe(false);
        expect(query(harness.shadow(), '.fr-section-bar-instruction').textContent).toBe('sectionTranslation.picker.preview');
        expect(query(harness.shadow(), '.fr-section-bar-heading').classList.contains('is-locked')).toBe(false);
        for (const name of ['expand', 'shrink', 'reselect', 'confirm']) expect(button(harness, name).disabled).toBe(true);
        expect(harness.onPick).not.toHaveBeenCalled();

        harness.hit.current = harness.byId('second');
        harness.emit('pointermove', {clientX: 60, clientY: 130});
        harness.flushFrames();
        expect(query(harness.shadow(), '.fr-section-box').style.transform).toBe('translate(27px, 117px)');
        expect(harness.resizeObserver.observe).toHaveBeenLastCalledWith(harness.byId('second'));
        harness.emit('keydown', {key: 'ArrowDown'});
        expect(query(harness.shadow(), '.fr-section-box').style.width).toBe('406px');
        expect(button(harness, 'confirm').disabled).toBe(true);
        harness.picker.stopSectionPicker();
    });

    it('伪造工具按钮点击不锁定、不调整、不重新选择或确认，disabled 按钮同样不执行', async () => {
        const harness = await createHarness();
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        for (const name of ['expand', 'shrink', 'reselect', 'confirm', 'bar-close']) {
            expect(clickButton(harness, name, false).defaultPrevented).toBe(false);
        }
        for (const name of ['shrink', 'reselect', 'confirm']) clickButton(harness, name);
        expect(harness.host()!.getAttribute('data-selection-state')).toBe('preview');
        expect(query(harness.shadow(), '.fr-section-box').style.width).toBe('406px');
        harness.emit('click', {clientX: 50, clientY: 70});
        vi.advanceTimersByTime(90);
        for (const name of ['expand', 'reselect', 'confirm']) clickButton(harness, name, false);
        expect(harness.host()!.getAttribute('data-selection-state')).toBe('locked');
        expect(query(harness.shadow(), '.fr-section-box').style.width).toBe('406px');
        expect(harness.onPick).not.toHaveBeenCalled();
        expect(harness.picker.isSectionPickerActive()).toBe(true);
        harness.picker.stopSectionPicker();
    });

    it.each(['empty', 'settled'] as const)('%s 摘要禁用确认按钮，Enter 重新盘点后也保持选择', async (action) => {
        const harness = await createHarness();
        harness.inspect.mockReturnValue(summary({action, pending: 0}));
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        harness.emit('click', {clientX: 50, clientY: 70});
        vi.advanceTimersByTime(90);
        expect(button(harness, 'confirm').disabled).toBe(true);
        expect(query(harness.shadow(), '.fr-section-label-action').textContent).toBe(`sectionTranslation.label.${action}`);
        const calls = harness.inspect.mock.calls.length;
        clickButton(harness, 'confirm');
        expect(harness.inspect).toHaveBeenCalledTimes(calls);
        harness.emit('keydown', {key: 'Enter'});
        expect(harness.inspect).toHaveBeenCalledTimes(calls + 1);
        expect(harness.onPick).not.toHaveBeenCalled();
        expect(harness.picker.isSectionPickerActive()).toBe(true);
        expect(button(harness, 'confirm').disabled).toBe(true);
        harness.picker.stopSectionPicker();
    });

    it.each(['empty', 'settled'] as const)('确认前 DOM 已变为 %s 时重新盘点，拒绝旧的可翻译摘要并禁用按钮', async (action) => {
        const harness = await createHarness();
        const para = harness.byId('para');
        harness.inspect.mockImplementation((element: Element) => element.textContent === 'Changed' ? summary({action, pending: 0}) : summary());
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        harness.emit('click', {clientX: 50, clientY: 70});
        vi.advanceTimersByTime(90);
        expect(button(harness, 'confirm').disabled).toBe(false);
        // 在观察器回调之前立即确认，仍必须读最新 DOM 而不是信任缓存。
        para.textContent = 'Changed';
        clickButton(harness, 'confirm');
        expect(harness.inspect).toHaveBeenCalledTimes(2);
        expect(harness.inspect).toHaveBeenLastCalledWith(para);
        expect(harness.onPick).not.toHaveBeenCalled();
        expect(button(harness, 'confirm').disabled).toBe(true);
        expect(query(harness.shadow(), '.fr-section-bar-instruction').textContent).toBe(`sectionTranslation.label.${action}`);
        expect(query(harness.shadow(), '.fr-section-label-action').textContent).toBe(`sectionTranslation.label.${action}`);
        expect(harness.picker.isSectionPickerActive()).toBe(true);
        harness.picker.stopSectionPicker();
    });

    it('确认前区域出现译文时刷新为恢复文案，随后确认仍只执行一次', async () => {
        const harness = await createHarness();
        const para = harness.byId('para');
        harness.inspect.mockImplementation((element: Element) => element.querySelector('.fluent-read-bilingual-content')
            ? summary({action: 'restore', active: 2, pending: 0}) : summary());
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        harness.emit('click', {clientX: 50, clientY: 70});
        vi.advanceTimersByTime(90);
        const translation = harness.document.createElement('span');
        translation.className = 'fluent-read-bilingual-content';
        translation.textContent = '译文';
        para.appendChild(translation);
        harness.emitMutation(para);
        expect(button(harness, 'confirm').disabled).toBe(false);
        expect(query(harness.shadow(), '.fr-section-bar-instruction').textContent).toBe('sectionTranslation.label.translate:{"count":2}');
        vi.advanceTimersByTime(90);
        expect(button(harness, 'confirm').textContent).toBe('sectionTranslation.picker.restore');
        expect(button(harness, 'confirm').classList.contains('tone-restore')).toBe(true);
        expect(button(harness, 'confirm').disabled).toBe(false);
        expect(query(harness.shadow(), '.fr-section-bar-instruction').textContent).toBe('sectionTranslation.label.restore:{"count":2}');
        expect(query(harness.shadow(), '.fr-section-bar').textContent).not.toContain('译文');
        clickButton(harness, 'confirm');
        expect(harness.inspect).toHaveBeenCalledTimes(3);
        expect(harness.onPick).toHaveBeenCalledOnce();
        expect(harness.onPick).toHaveBeenCalledWith(para);
    });

    it('确认前目标已脱离 DOM 时立即解锁，按钮和 Enter 都不能把失效节点交给翻译', async () => {
        for (const confirm of [
            (harness: PickerHarness) => clickButton(harness, 'confirm'),
            (harness: PickerHarness) => harness.emit('keydown', {key: 'Enter'}),
        ]) {
            const harness = await createHarness();
            harness.picker.startSectionPicker(harness.options as never);
            harness.flushFrames();
            harness.emit('click', {clientX: 50, clientY: 70});
            vi.advanceTimersByTime(90);
            harness.byId('para').remove();
            confirm(harness);
            expect(harness.onPick).not.toHaveBeenCalled();
            expect(harness.inspect).toHaveBeenCalledOnce();
            harness.flushFrames();
            expect(harness.host()!.getAttribute('data-selection-state')).toBe('preview');
            expect(button(harness, 'confirm').disabled).toBe(true);
            expect(query(harness.shadow(), '.fr-section-box').classList.contains('is-visible')).toBe(false);
            harness.picker.stopSectionPicker();
        }
    });

    it('观察锁定目标的尺寸和区域外结构变化时重绘，区域内变化重新盘点，退出清理观察器', async () => {
        const harness = await createHarness();
        const para = harness.byId('para');
        harness.inspect.mockImplementation(() => summary({
            total: 3, pending: para.textContent?.startsWith('Updated source ') ? 3 : 2,
        }));
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        expect(harness.mutationObserver.observe).toHaveBeenCalledWith(harness.document.documentElement, expect.objectContaining({childList: true, characterData: true, subtree: true, attributes: true}));
        expect(harness.resizeObserver.observe).toHaveBeenCalledWith(para);
        harness.emit('click', {clientX: 50, clientY: 70});
        vi.advanceTimersByTime(90);
        harness.flushFrames();
        harness.inspect.mockClear();
        harness.hit.current = harness.byId('second');
        para.getBoundingClientRect = () => rect(30, 100, 500, 90) as DOMRect;
        harness.emitResize();
        harness.flushFrames();
        const box = query(harness.shadow(), '.fr-section-box');
        expect(box.style.transform).toBe('translate(27px, 97px)');
        expect(box.style.width).toBe('506px');
        expect(box.style.height).toBe('96px');
        expect(box.classList.contains('is-following')).toBe(false);
        expect(harness.host()!.getAttribute('data-selection-state')).toBe('locked');
        expect(harness.inspect).not.toHaveBeenCalled();

        const banner = harness.document.createElement('aside');
        harness.document.body.prepend(banner);
        para.getBoundingClientRect = () => rect(30, 180, 500, 90) as DOMRect;
        harness.emitMutation(harness.document.body);
        harness.flushFrames();
        expect(box.style.transform).toBe('translate(27px, 177px)');
        vi.advanceTimersByTime(90);
        expect(harness.inspect).not.toHaveBeenCalled();
        expect(button(harness, 'confirm').disabled).toBe(false);

        const source = para.firstChild!;
        source.textContent = 'Updated source ';
        harness.emitMutation(source);
        expect(button(harness, 'confirm').disabled).toBe(false);
        expect(query(harness.shadow(), '.fr-section-bar-instruction').textContent).toBe('sectionTranslation.label.translate:{"count":2}');
        vi.advanceTimersByTime(90);
        expect(harness.inspect).toHaveBeenCalledOnce();
        expect(harness.inspect).toHaveBeenCalledWith(para);
        expect(button(harness, 'confirm').disabled).toBe(false);
        expect(query(harness.shadow(), '.fr-section-bar-instruction').textContent).toBe('sectionTranslation.label.translate:{"count":3}');
        harness.mutationObserver.disconnect.mockClear();
        harness.resizeObserver.disconnect.mockClear();
        harness.picker.stopSectionPicker();
        expect(harness.mutationObserver.disconnect).toHaveBeenCalledOnce();
        expect(harness.resizeObserver.disconnect).toHaveBeenCalledOnce();
        harness.flushFrames();
        harness.emitMutation(para);
        harness.emitResize();
        expect(harness.frames).toHaveLength(0);
        vi.advanceTimersByTime(200);
        expect(harness.inspect).toHaveBeenCalledOnce();
        expect(harness.host()).toBeNull();
    });

    it.each(['mutation', 'resize'])('未锁定时 %s 改变指针下内容便即时换选，不把新布局下的旧框交给 Enter', async mode => {
        const harness = await createHarness();
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        harness.hit.current = harness.byId('second');
        harness.byId('para').getBoundingClientRect = () => rect(30, 200, 400, 40) as DOMRect;
        harness.byId('second').getBoundingClientRect = () => rect(30, 60, 400, 40) as DOMRect;
        if (mode === 'mutation') harness.emitMutation(harness.document.body);
        else harness.emitResize();
        harness.flushFrames();
        expect(query(harness.shadow(), '.fr-section-box').style.transform).toBe('translate(27px, 57px)');
        expect(harness.resizeObserver.observe).toHaveBeenLastCalledWith(harness.byId('second'));
        expect(query(harness.shadow(), '.fr-section-box').classList.contains('is-following')).toBe(false);
        harness.emit('keydown', {key: 'Enter'});
        expect(harness.inspect).toHaveBeenLastCalledWith(harness.byId('second'));
        expect(harness.onPick).toHaveBeenCalledWith(harness.byId('second'));
    });

    it('ResizeObserver 的初始或重复通知不提前结束 hover 稳定窗', async () => {
        const harness = await createHarness();
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        harness.hit.current = harness.byId('second');
        harness.emit('pointermove', {clientX: 60, clientY: 130});
        harness.flushFrames();
        harness.emitResize();
        harness.flushFrames();
        vi.advanceTimersByTime(79);
        expect(query(harness.shadow(), '.fr-section-box').style.transform).toBe('translate(27px, 57px)');
        vi.advanceTimersByTime(1);
        harness.flushFrames();
        expect(query(harness.shadow(), '.fr-section-box').style.transform).toBe('translate(27px, 117px)');
        harness.picker.stopSectionPicker();
    });

    it('指针在空白处保持静止时，网页插入新的内容仍会显示可选预览', async () => {
        const harness = await createHarness({initialPoint: {x: 50, y: 70}});
        harness.hit.current = harness.document.body;
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        expect(query(harness.shadow(), '.fr-section-box').classList.contains('is-visible')).toBe(false);
        harness.hit.current = harness.byId('para');
        harness.emitMutation(harness.document.body, [harness.byId('para')]);
        harness.flushFrames();
        expect(query(harness.shadow(), '.fr-section-box').classList.contains('is-visible')).toBe(true);
        expect(harness.resizeObserver.observe).toHaveBeenLastCalledWith(harness.byId('para'));
        expect(harness.host()!.getAttribute('data-selection-count')).toBe('1');
        vi.advanceTimersByTime(90);
        expect(harness.inspect).toHaveBeenLastCalledWith(harness.byId('para'));
        expect(query(harness.shadow(), '.fr-section-label-action').textContent).toBe('sectionTranslation.label.translate:{"count":2}');
        harness.picker.stopSectionPicker();
    });

    it('观察可改变布局和原文保护的属性，祖先变化刷新锁定摘要，自有浮层样式不形成重绘循环', async () => {
        const harness = await createHarness();
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        expect(harness.mutationObserver.observe).toHaveBeenCalledWith(harness.document.documentElement,
            expect.objectContaining({attributes: true, attributeFilter: expect.arrayContaining(['class', 'style', 'hidden', 'translate', 'contenteditable'])}));
        harness.emit('click', {clientX: 50, clientY: 70});
        vi.advanceTimersByTime(90);
        harness.flushFrames();
        harness.inspect.mockClear();
        harness.byId('readme').setAttribute('translate', 'no');
        harness.inspect.mockReturnValue(summary({action: 'empty', pending: 0}));
        harness.emitAttribute(harness.byId('readme'));
        vi.advanceTimersByTime(90);
        harness.flushFrames();
        expect(harness.inspect).toHaveBeenCalledOnce();
        expect(button(harness, 'confirm').disabled).toBe(true);
        harness.emitAttribute(harness.byId('second'));
        harness.flushFrames();
        vi.advanceTimersByTime(90);
        // 范围外 class/style 也可能改变布局，但无需重复盘点锁定正文。
        expect(harness.inspect).toHaveBeenCalledOnce();
        harness.emitAttribute(harness.host()!);
        expect(harness.frames).toHaveLength(0);
        vi.advanceTimersByTime(90);
        expect(harness.inspect).toHaveBeenCalledOnce();
        harness.picker.stopSectionPicker();
    });

    it('选择器不为辅助摘录扫描正文，仅在延时盘点和确认复核时通过摘要端口读取', async () => {
        const harness = await createHarness();
        const source = harness.byId('para').firstChild!;
        const originalText = source.textContent;
        const reads = vi.fn(() => originalText);
        Object.defineProperty(source, 'textContent', {get: reads});
        harness.inspect.mockImplementation(() => summary({action: source.textContent ? 'translate' : 'empty'}));
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        expect(reads).not.toHaveBeenCalled();
        harness.emit('click', {clientX: 50, clientY: 70});
        vi.advanceTimersByTime(90);
        harness.flushFrames();
        expect(reads).toHaveBeenCalledOnce();
        harness.emitMutation(source);
        expect(reads).toHaveBeenCalledOnce();
        vi.advanceTimersByTime(90);
        expect(reads).toHaveBeenCalledTimes(2);
        clickButton(harness, 'confirm');
        expect(reads).toHaveBeenCalledTimes(3);
        expect(harness.onPick).toHaveBeenCalledWith(harness.byId('para'));
    });

    it.each([['attribute', 0, 0], ['resize', 400, 0]] as const)('锁定目标被隐藏时 %s 更新解除锁定并清理空框，不能确认不可见区域', async (mode, width, height) => {
        const harness = await createHarness();
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        harness.emit('click', {clientX: 50, clientY: 70});
        vi.advanceTimersByTime(90);
        harness.flushFrames();
        expect(button(harness, 'confirm').disabled).toBe(false);
        harness.byId('para').setAttribute('hidden', '');
        harness.byId('para').getBoundingClientRect = () => rect(0, 0, width, height) as DOMRect;
        harness.hit.current = harness.document.body;
        if (mode === 'attribute') harness.emitAttribute(harness.byId('para'));
        else harness.emitResize();
        harness.flushFrames();
        expect(harness.host()!.getAttribute('data-selection-state')).toBe('preview');
        expect(button(harness, 'confirm').disabled).toBe(true);
        expect(query(harness.shadow(), '.fr-section-box').classList.contains('is-visible')).toBe(false);
        harness.emit('keydown', {key: 'Enter'});
        expect(harness.onPick).not.toHaveBeenCalled();
        harness.picker.stopSectionPicker();
    });

    it('隐藏之后尚未收到观察回调时确认仍同步拒绝，不沿用可翻译摘要', async () => {
        const harness = await createHarness();
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        harness.emit('click', {clientX: 50, clientY: 70});
        vi.advanceTimersByTime(90);
        harness.byId('para').getBoundingClientRect = () => rect(0, 0, 0, 0) as DOMRect;
        clickButton(harness, 'confirm');
        expect(harness.onPick).not.toHaveBeenCalled();
        expect(harness.host()!.getAttribute('data-selection-state')).toBe('preview');
        expect(button(harness, 'confirm').disabled).toBe(true);
        harness.picker.stopSectionPicker();
    });

    it.each([['hidden', 'attribute'], ['collapse', 'confirm']] as const)('visibility:%s 保留非零盒子时 %s 仍拒绝隐藏正文及其继承状态', async (visibility, mode) => {
        const harness = await createHarness();
        const originalStyle = harness.view.getComputedStyle as (element: Element) => Record<string, unknown>;
        harness.view.getComputedStyle = (element: Element) => ({
            ...originalStyle(element),
            visibility: harness.byId('readme').style.visibility || 'visible',
        });
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        harness.emit('click', {clientX: 50, clientY: 70});
        vi.advanceTimersByTime(90);
        harness.flushFrames();
        expect(button(harness, 'confirm').disabled).toBe(false);
        harness.byId('readme').style.visibility = visibility;
        // 两类 CSS 都保留原几何；属性来自祖先，目标自身没有 hidden 标记。
        expect(harness.byId('para').getBoundingClientRect().width).toBe(400);
        harness.hit.current = harness.document.body;
        if (mode === 'attribute') {
            harness.emitAttribute(harness.byId('readme'));
            harness.flushFrames();
        } else clickButton(harness, 'confirm');
        expect(harness.host()!.getAttribute('data-selection-state')).toBe('preview');
        expect(button(harness, 'confirm').disabled).toBe(true);
        expect(harness.onPick).not.toHaveBeenCalled();
        harness.picker.stopSectionPicker();
    });

    it('观察器发现锁定节点被替换时立即解锁并禁用确认，重绘后只能选择新的连接节点', async () => {
        const harness = await createHarness();
        const old = harness.byId('para');
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        harness.emit('click', {clientX: 50, clientY: 70});
        vi.advanceTimersByTime(90);
        const replacement = harness.document.createElement('p');
        replacement.textContent = 'Replacement source';
        replacement.getBoundingClientRect = () => rect(30, 60, 400, 40) as DOMRect;
        old.replaceWith(replacement);
        harness.hit.current = replacement;
        harness.emitMutation(harness.byId('readme'));
        expect(harness.resizeObserver.disconnect).toHaveBeenCalledTimes(2);
        clickButton(harness, 'confirm');
        expect(harness.onPick).not.toHaveBeenCalled();
        harness.flushFrames();
        expect(harness.host()!.getAttribute('data-selection-state')).toBe('preview');
        expect(button(harness, 'confirm').disabled).toBe(true);
        expect(harness.resizeObserver.observe).toHaveBeenLastCalledWith(replacement);
        expect(harness.host()!.getAttribute('data-selection-count')).toBe('1');
        expect(query(harness.shadow(), '.fr-section-bar-instruction').textContent).toBe('sectionTranslation.picker.preview');
        expect(button(harness, 'reselect').disabled).toBe(true);
        harness.emit('click', {clientX: 50, clientY: 70});
        harness.emit('keydown', {key: 'Enter'});
        expect(harness.onPick).toHaveBeenCalledOnce();
        expect(harness.onPick).toHaveBeenCalledWith(replacement);
        expect(harness.onPick).not.toHaveBeenCalledWith(old);
        expect(harness.inspect).toHaveBeenLastCalledWith(replacement);
    });

    it('持续每 50ms 更新 DOM 不会使 90ms 盘点饥饿，保留摘要且确认仍同步复核', async () => {
        const harness = await createHarness();
        const para = harness.byId('para');
        harness.inspect.mockImplementation(() => summary({pending: Number.parseInt(para.textContent ?? '', 10) || 2}));
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        harness.emit('click', {clientX: 50, clientY: 70});
        vi.advanceTimersByTime(50);
        para.textContent = '3';
        harness.emitMutation(para);
        vi.advanceTimersByTime(40);
        expect(harness.inspect).toHaveBeenCalledOnce();
        expect(button(harness, 'confirm').disabled).toBe(false);
        expect(query(harness.shadow(), '.fr-section-label-action').textContent).toBe('sectionTranslation.label.translate:{"count":3}');

        vi.advanceTimersByTime(10);
        para.textContent = '4';
        harness.emitMutation(para);
        expect(button(harness, 'confirm').disabled).toBe(false);
        vi.advanceTimersByTime(50);
        para.textContent = '5';
        harness.emitMutation(para);
        vi.advanceTimersByTime(40);
        expect(harness.inspect).toHaveBeenCalledTimes(2);
        expect(query(harness.shadow(), '.fr-section-label-action').textContent).toBe('sectionTranslation.label.translate:{"count":5}');
        para.textContent = '';
        harness.inspect.mockImplementation(() => summary({action: para.textContent ? 'translate' : 'empty', pending: 0}));
        harness.emitMutation(para);
        expect(button(harness, 'confirm').disabled).toBe(false);
        clickButton(harness, 'confirm');
        expect(harness.inspect).toHaveBeenCalledTimes(3);
        expect(button(harness, 'confirm').disabled).toBe(true);
        expect(harness.onPick).not.toHaveBeenCalled();
        harness.picker.stopSectionPicker();
    });

    it('额外观察 ShadowRoot 树，同尺寸空容器填入英文后刷新摘要，换区与退出清理两个观察器', async () => {
        const harness = await createHarness({initialPoint: {x: 120, y: 320}});
        const shadowHost = harness.byId('shadow-host');
        const root = shadowHost.attachShadow({mode: 'open'});
        const inner = harness.document.createElement('section');
        root.appendChild(inner);
        inner.getBoundingClientRect = () => rect(100, 300, 300, 80) as DOMRect;
        (root as unknown as {elementFromPoint: () => Element}).elementFromPoint = () => inner;
        harness.hit.current = shadowHost;
        harness.inspect.mockImplementation((element: Element) => summary({action: element.textContent ? 'translate' : 'empty'}));
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        harness.emit('click', {clientX: 120, clientY: 320});
        vi.advanceTimersByTime(90);
        expect(button(harness, 'confirm').disabled).toBe(true);
        expect(harness.mutationObserver.observe).toHaveBeenCalledWith(root, expect.objectContaining({childList: true, characterData: true, subtree: true, attributes: true}));
        expect(harness.resizeObserver.observe).toHaveBeenLastCalledWith(inner);
        inner.textContent = 'New English source inside shadow DOM';
        harness.emitMutation(inner);
        vi.advanceTimersByTime(90);
        harness.flushFrames();
        expect(query(harness.shadow(), '.fr-section-box').style.width).toBe('306px');
        expect(query(harness.shadow(), '.fr-section-box').style.height).toBe('86px');
        expect(button(harness, 'confirm').disabled).toBe(false);
        expect(harness.inspect).toHaveBeenLastCalledWith(inner);
        expect(query(harness.shadow(), '.fr-section-bar-instruction').textContent).toBe('sectionTranslation.label.translate:{"count":2}');
        harness.mutationObserver.disconnect.mockClear();
        harness.resizeObserver.disconnect.mockClear();
        clickButton(harness, 'reselect');
        expect(harness.mutationObserver.disconnect).toHaveBeenCalledOnce();
        expect(harness.resizeObserver.disconnect).toHaveBeenCalledOnce();
        expect(harness.mutationObserver.observe).toHaveBeenLastCalledWith(harness.document.documentElement, expect.objectContaining({childList: true, characterData: true, subtree: true, attributes: true}));
        harness.picker.stopSectionPicker();
        expect(harness.mutationObserver.disconnect).toHaveBeenCalledTimes(2);
        expect(harness.resizeObserver.disconnect).toHaveBeenCalledTimes(2);
        harness.emitMutation(inner);
        harness.emitResize();
        expect(harness.onPick).not.toHaveBeenCalled();
        expect(harness.host()).toBeNull();
    });

    it('方向键扩大与缩小范围，扩大后鼠标仍在范围内时保持选择', async () => {
        const harness = await createHarness();
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        const box = query(harness.shadow(), '.fr-section-box');

        const up = harness.emit('keydown', {key: 'ArrowUp'});
        expect(up.preventDefault).toHaveBeenCalled();
        expect(up.stopImmediatePropagation).toHaveBeenCalled();
        harness.flushFrames();
        expect(box.style.transform).toBe('translate(17px, 37px)');

        // 在扩大后的范围内移动鼠标不会跳回段落。
        harness.hit.current = harness.byId('second');
        harness.emit('pointermove', {clientX: 60, clientY: 130});
        harness.flushFrames();
        expect(box.style.width).toBe('806px');

        // 已到最大范围时提示用户，稍后恢复原标签。
        harness.emit('keydown', {key: 'ArrowUp'});
        harness.flushFrames();
        const action = query(harness.shadow(), '.fr-section-label-action');
        expect(action.textContent).toBe('sectionTranslation.label.topmost');
        vi.advanceTimersByTime(1200);
        expect(action.textContent).toBe('sectionTranslation.label.translate:{"count":2}');

        harness.emit('keydown', {key: 'ArrowDown'});
        harness.flushFrames();
        expect(box.style.width).toBe('406px');
        // 已是最小范围时再缩小没有变化。
        harness.emit('keydown', {key: 'ArrowDown'});
        harness.flushFrames();
        expect(box.style.width).toBe('406px');

        // 扩大后鼠标离开扩大范围，回到鼠标下的基础区域。
        harness.emit('keydown', {key: 'ArrowUp'});
        harness.flushFrames();
        harness.hit.current = harness.byId('second');
        harness.emit('pointermove', {clientX: 900, clientY: 700});
        harness.flushFrames();
        vi.advanceTimersByTime(80);
        harness.flushFrames();
        expect(box.style.transform).toBe('translate(27px, 117px)');
        harness.picker.stopSectionPicker();
    });

    it('点击只锁定区域，确认按钮才退出并回调，清理监听后短暂保留收束动画', async () => {
        const harness = await createHarness();
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();

        const down = harness.emit('pointerdown');
        expect(down.stopImmediatePropagation).toHaveBeenCalled();
        expect(down.preventDefault).not.toHaveBeenCalled();
        const click = harness.emit('click', {clientX: 50, clientY: 70});
        expect(click.preventDefault).toHaveBeenCalled();
        expect(click.stopImmediatePropagation).toHaveBeenCalled();
        expect(harness.onPick).not.toHaveBeenCalled();
        expect(harness.picker.isSectionPickerActive()).toBe(true);
        expect(harness.host()!.getAttribute('data-selection-state')).toBe('locked');
        expect(button(harness, 'confirm').disabled).toBe(true);
        vi.advanceTimersByTime(90);
        expect(button(harness, 'confirm').disabled).toBe(false);
        harness.mutationObserver.disconnect.mockClear();
        const confirm = clickButton(harness, 'confirm');
        expect(confirm.defaultPrevented).toBe(true);
        expect(harness.onPick).toHaveBeenCalledOnce();
        expect(harness.onPick).toHaveBeenCalledWith(harness.byId('para'));
        expect(harness.picker.isSectionPickerActive()).toBe(false);
        expect(harness.windowListeners.every((entry) => entry.signal?.aborted)).toBe(true);
        expect(harness.mutationObserver.disconnect).toHaveBeenCalledOnce();
        clickButton(harness, 'confirm');
        expect(harness.onPick).toHaveBeenCalledOnce();

        const box = query(harness.shadow(), '.fr-section-box');
        expect(box.classList.contains('is-confirmed')).toBe(true);
        expect(query(harness.shadow(), '.fr-section-bar').classList.contains('is-hidden')).toBe(true);
        expect(harness.host()).not.toBeNull();
        vi.advanceTimersByTime(320);
        expect(harness.host()).toBeNull();
    });

    it('触屏点按即时锁定落点而不执行，非左键与空白处不会锁定，Enter 可确认未绘制的区域', async () => {
        const harness = await createHarness({initialPoint: null});
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        expect(query(harness.shadow(), '.fr-section-box').classList.contains('is-visible')).toBe(false);

        const middle = harness.emit('auxclick', {button: 1});
        expect(middle.preventDefault).toHaveBeenCalled();
        harness.emit('click', {button: 1, clientX: 50, clientY: 70});
        expect(harness.host()!.getAttribute('data-selection-state')).toBe('preview');
        harness.hit.current = null;
        harness.emit('click', {clientX: 5000, clientY: 5000});
        harness.hit.current = harness.document.body;
        harness.emit('click', {clientX: 5, clientY: 5});
        expect(harness.onPick).not.toHaveBeenCalled();

        harness.hit.current = harness.byId('second');
        harness.emit('click', {clientX: 60, clientY: 130});
        expect(harness.host()!.getAttribute('data-selection-state')).toBe('locked');
        expect(harness.host()!.getAttribute('data-selection-count')).toBe('1');
        expect(harness.resizeObserver.observe).toHaveBeenLastCalledWith(harness.byId('second'));
        expect(query(harness.shadow(), '.fr-section-bar-instruction').textContent).toBe('sectionTranslation.label.inspecting');
        expect(harness.onPick).not.toHaveBeenCalled();
        harness.emit('keydown', {key: 'Enter'});
        expect(harness.inspect).toHaveBeenLastCalledWith(harness.byId('second'));
        expect(harness.onPick).toHaveBeenCalledWith(harness.byId('second'));
        // 高亮框尚未绘制时直接移除界面，不播放收束动画。
        expect(harness.host()).toBeNull();
    });

    it('Enter 确认当前区域；Esc、右键、再次按进入快捷键和关闭按钮都会退出且不翻译', async () => {
        const enter = await createHarness();
        enter.picker.startSectionPicker(enter.options as never);
        enter.flushFrames();
        enter.emit('keydown', {key: 'Enter'});
        expect(enter.onPick).toHaveBeenCalledWith(enter.byId('para'));

        for (const exit of [
            (harness: PickerHarness) => harness.emit('keydown', {key: 'Escape'}),
            (harness: PickerHarness) => harness.emit('contextmenu'),
            (harness: PickerHarness) => harness.emit('keydown', {key: 'r', altKey: true}),
            (harness: PickerHarness) => clickButton(harness, 'bar-close'),
            (harness: PickerHarness) => {
                Object.defineProperty(harness.document, 'visibilityState', {configurable: true, get: () => 'hidden'});
                harness.emitDocument('visibilitychange');
            },
        ]) {
            const harness = await createHarness();
            harness.picker.startSectionPicker(harness.options as never);
            harness.flushFrames();
            harness.mutationObserver.disconnect.mockClear();
            exit(harness);
            expect(harness.picker.isSectionPickerActive()).toBe(false);
            expect(harness.host()).toBeNull();
            expect(harness.onPick).not.toHaveBeenCalled();
            expect(harness.windowListeners.every((entry) => entry.signal?.aborted)).toBe(true);
            expect(harness.mutationObserver.disconnect).toHaveBeenCalledOnce();
            // 退出是幂等的：迟到的关闭点击不会重复清理或抛错。
            clickButton(harness, 'bar-close');
            expect(harness.host()).toBeNull();
        }
    });

    it('页面仍可见时的 visibilitychange、未确认的 Enter 与伪造事件不会改变选择', async () => {
        const harness = await createHarness({initialPoint: null});
        harness.picker.startSectionPicker(harness.options as never);
        harness.emitDocument('visibilitychange');
        harness.emitDocument('visibilitychange', {isTrusted: false});
        harness.emit('keydown', {key: 'Enter'});
        for (const type of ['pointermove', 'pointerdown', 'click', 'mouseover', 'contextmenu', 'keydown', 'scroll']) {
            const event = harness.emit(type, {isTrusted: false, key: 'Escape'});
            expect(event.preventDefault).not.toHaveBeenCalled();
            expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
        }
        const close = query(harness.shadow(), '.fr-section-bar-close');
        close.dispatchEvent(new (harness.document.defaultView as unknown as {Event: typeof Event}).Event('click'));
        // 还没有指针位置时，滚动不会凭空选中区域。
        harness.emit('scroll');
        harness.flushFrames();
        expect(query(harness.shadow(), '.fr-section-box').classList.contains('is-visible')).toBe(false);
        harness.emit('scroll');
        expect(harness.picker.isSectionPickerActive()).toBe(true);
        expect(harness.onPick).not.toHaveBeenCalled();
        harness.picker.stopSectionPicker();
        // 退出后迟到的帧不再绘制。
        harness.flushFrames();
        expect(harness.host()).toBeNull();
    });

    it('焦点在输入框或事件落在 FluentRead 界面上时，按键和点击交还原处理者', async () => {
        const harness = await createHarness();
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();

        const typing = harness.emit('keydown', {key: 'ArrowUp', target: harness.byId('para')});
        expect(typing.preventDefault).not.toHaveBeenCalled();
        const ownUi = (event: Record<string, unknown>) => harness.emit(event.type as string, {
            ...event,
            composedPath: () => [harness.byId('ball'), harness.document.body],
        });
        for (const key of ['ArrowUp', 'ArrowDown', 'Enter']) {
            expect(ownUi({type: 'keydown', key}).preventDefault).not.toHaveBeenCalled();
        }
        for (const type of ['pointerdown', 'mousedown', 'click', 'mouseover', 'contextmenu']) {
            const event = ownUi({type});
            expect(event.preventDefault).not.toHaveBeenCalled();
            expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
        }
        const enterOnClose = harness.emit('keydown', {key: 'Enter', composedPath: () => [harness.host(), harness.document.body]});
        expect(enterOnClose.preventDefault).not.toHaveBeenCalled();
        // 没有 composedPath 的旧事件按网页事件处理。
        const legacy = harness.emit('mouseover', {composedPath: undefined});
        expect(legacy.stopImmediatePropagation).toHaveBeenCalled();
        const pageHover = harness.emit('pointerover');
        expect(pageHover.stopImmediatePropagation).toHaveBeenCalled();
        expect(pageHover.preventDefault).not.toHaveBeenCalled();
        expect(harness.picker.isSectionPickerActive()).toBe(true);
        expect(harness.onPick).not.toHaveBeenCalled();
        harness.picker.stopSectionPicker();
    });

    it('滚动、缩放后按指针重新选择，指针停在提示条上时保持当前区域', async () => {
        const harness = await createHarness();
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        const box = query(harness.shadow(), '.fr-section-box');

        harness.hit.current = harness.byId('second');
        harness.emit('scroll');
        harness.flushFrames();
        expect(box.style.transform).toBe('translate(27px, 117px)');
        // 滚动带来的换选立即贴合内容，不播放跟随动画。
        expect(box.classList.contains('is-following')).toBe(false);

        harness.hit.current = harness.host();
        harness.emit('resize');
        harness.flushFrames();
        expect(box.style.transform).toBe('translate(27px, 117px)');

        // 指针移到页面空白处时取消高亮。
        harness.hit.current = harness.document.body;
        harness.emit('pointermove', {clientX: 5, clientY: 790});
        harness.flushFrames();
        vi.advanceTimersByTime(80);
        harness.flushFrames();
        expect(box.classList.contains('is-visible')).toBe(false);
        harness.picker.stopSectionPicker();
    });

    it('网页替换当前区域后丢弃失效节点，并按指针重新选择', async () => {
        const harness = await createHarness();
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        const box = query(harness.shadow(), '.fr-section-box');

        harness.byId('para').remove();
        harness.hit.current = harness.document.body;
        harness.emit('keydown', {key: 'ArrowDown'});
        harness.flushFrames();
        harness.emit('scroll');
        harness.flushFrames();
        expect(box.classList.contains('is-visible')).toBe(false);
        expect(query(harness.shadow(), '.fr-section-label').classList.contains('is-visible')).toBe(false);
        // 没有区域时方向键与 Enter 都不会生效。
        harness.emit('keydown', {key: 'ArrowUp'});
        harness.emit('keydown', {key: 'Enter'});
        expect(harness.onPick).not.toHaveBeenCalled();
        harness.picker.stopSectionPicker();
    });

    it('区域在盘点前失效时不会写回过期标签', async () => {
        const harness = await createHarness();
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        harness.byId('para').remove();
        vi.advanceTimersByTime(90);
        expect(harness.inspect).not.toHaveBeenCalled();
        harness.picker.stopSectionPicker();
        vi.advanceTimersByTime(1000);
        expect(harness.inspect).not.toHaveBeenCalled();
    });

    it('选择模式单例：重复进入复用现有浮层，停止后可再次进入；没有文档根时拒绝进入', async () => {
        const harness = await createHarness();
        harness.picker.stopSectionPicker();
        expect(harness.picker.startSectionPicker(harness.options as never)).toBe(true);
        expect(harness.picker.startSectionPicker(harness.options as never)).toBe(true);
        expect(harness.document.documentElement.querySelectorAll('[data-fluent-read-ui="section-picker"]')).toHaveLength(1);
        harness.picker.stopSectionPicker();
        expect(harness.host()).toBeNull();
        expect(harness.picker.startSectionPicker(harness.options as never)).toBe(true);
        harness.picker.stopSectionPicker();

        vi.stubGlobal('document', {documentElement: null});
        expect(harness.picker.startSectionPicker(harness.options as never)).toBe(false);
        expect(harness.picker.isSectionPickerActive()).toBe(false);
    });

    it('没有 requestAnimationFrame 时回退到定时器，并能穿过开放的 ShadowRoot 命中内部元素', async () => {
        const harness = await createHarness({withAnimationFrame: false});
        const shadowHost = harness.byId('shadow-host');
        const openRoot = shadowHost.attachShadow({mode: 'open'});
        const inner = harness.document.createElement('section');
        openRoot.appendChild(inner);
        inner.getBoundingClientRect = () => rect(100, 300, 300, 80) as DOMRect;
        (openRoot as unknown as {elementFromPoint: () => Element}).elementFromPoint = () => inner;
        harness.hit.current = shadowHost;

        harness.picker.startSectionPicker(harness.options as never);
        vi.advanceTimersByTime(16);
        expect(query(harness.shadow(), '.fr-section-box').style.transform).toBe('translate(97px, 297px)');

        // ShadowRoot 命中自身宿主时停止下钻。
        (openRoot as unknown as {elementFromPoint: () => Element}).elementFromPoint = () => shadowHost;
        shadowHost.getBoundingClientRect = () => rect(0, 280, 600, 120) as DOMRect;
        harness.emit('pointermove', {clientX: 10, clientY: 290});
        vi.advanceTimersByTime(16);
        expect(query(harness.shadow(), '.fr-section-box').style.transform).toBe('translate(97px, 297px)');
        vi.advanceTimersByTime(96);
        expect(query(harness.shadow(), '.fr-section-box').style.transform).toBe('translate(-3px, 277px)');

        // ShadowRoot 内没有命中元素时停留在宿主上。
        (openRoot as unknown as {elementFromPoint: () => null}).elementFromPoint = () => null;
        harness.emit('pointermove', {clientX: 12, clientY: 292});
        vi.advanceTimersByTime(16);
        expect(query(harness.shadow(), '.fr-section-box').style.transform).toBe('translate(-3px, 277px)');
        // 待绘制的回退定时器在退出时一并取消。
        harness.emit('pointermove', {clientX: 14, clientY: 294});
        harness.picker.stopSectionPicker();
        vi.advanceTimersByTime(16);
        expect(harness.host()).toBeNull();
    });

    it('“已是最大范围”提示按时恢复，期间完成的盘点不覆盖提示，退出时清理计时器', async () => {
        const harness = await createHarness();
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        harness.emit('keydown', {key: 'ArrowUp'});
        harness.emit('keydown', {key: 'ArrowUp'});
        harness.flushFrames();
        const action = query(harness.shadow(), '.fr-section-label-action');
        expect(action.textContent).toBe('sectionTranslation.label.topmost');
        vi.advanceTimersByTime(90);
        expect(harness.inspect).toHaveBeenCalledWith(harness.byId('readme'));
        expect(action.textContent).toBe('sectionTranslation.label.topmost');
        // 连续到顶只保留最后一次提示的计时。
        harness.emit('keydown', {key: 'ArrowUp'});
        vi.advanceTimersByTime(1199);
        expect(action.textContent).toBe('sectionTranslation.label.topmost');
        // 换选区域时立即结束提示，改为盘点新的区域。
        harness.emit('keydown', {key: 'ArrowDown'});
        expect(action.textContent).toBe('sectionTranslation.label.inspecting');

        // 提示期间区域被网页移除：计时结束时没有区域可更新。
        harness.emit('keydown', {key: 'ArrowUp'});
        harness.emit('keydown', {key: 'ArrowUp'});
        harness.byId('readme').remove();
        harness.hit.current = harness.document.body;
        harness.emit('scroll');
        harness.flushFrames();
        vi.advanceTimersByTime(1200);
        expect(action.textContent).toBe('sectionTranslation.label.topmost');

        harness.hit.current = harness.byId('shadow-host');
        harness.byId('shadow-host').getBoundingClientRect = () => rect(0, 700, 500, 50) as DOMRect;
        harness.emit('pointermove', {clientX: 10, clientY: 710});
        harness.flushFrames();
        harness.emit('keydown', {key: 'ArrowUp'});
        harness.picker.stopSectionPicker();
        vi.advanceTimersByTime(2000);
        expect(harness.host()).toBeNull();
    });

    it('未提供退出快捷键与输入判断时仍可用 Esc 退出；取不到计算样式时按块级处理', async () => {
        const harness = await createHarness();
        harness.view.getComputedStyle = () => {
            throw new Error('no view');
        };
        harness.byId('bold').getBoundingClientRect = () => rect(80, 62, 60, 20) as DOMRect;
        const {isExitHotkey: _exit, isEditing: _editing, ...options} = harness.options;
        harness.picker.startSectionPicker(options as never);
        harness.flushFrames();
        expect(query(harness.shadow(), '.fr-section-label-meta').textContent).toBe('sectionTranslation.scope.region');
        harness.emit('keydown', {key: 'r', altKey: true});
        harness.emit('keydown', {key: 'ArrowUp'});
        harness.flushFrames();
        expect(query(harness.shadow(), '.fr-section-label-meta').textContent).toBe('sectionTranslation.scope.paragraph');
        harness.emit('keydown', {key: 'Escape'});
        expect(harness.picker.isSectionPickerActive()).toBe(false);
    });

    it('标签在区域上方放不下时贴在区域内侧，并始终留在视口内', async () => {
        const harness = await createHarness();
        harness.byId('para').getBoundingClientRect = () => rect(-50, 2, 400, 40) as DOMRect;
        harness.picker.startSectionPicker(harness.options as never);
        harness.flushFrames();
        expect(query(harness.shadow(), '.fr-section-label').style.transform).toBe('translate(4px, 8px)');

        harness.byId('second').getBoundingClientRect = () => rect(30, 300, 400, 40) as DOMRect;
        harness.hit.current = harness.byId('second');
        harness.emit('pointermove', {clientX: 60, clientY: 310});
        harness.flushFrames();
        vi.advanceTimersByTime(80);
        harness.flushFrames();
        expect(query(harness.shadow(), '.fr-section-label').style.transform).toBe('translate(30px, 291px)');
        harness.picker.stopSectionPicker();
    });
});

describe('局部区域记忆交互', () => {
    const setupRemember = async (onRemember: ReturnType<typeof vi.fn>, rememberScopes = {site: 'example.com', path: 'example.com/articles/'}) => {
        const h = await createHarness();
        h.picker.startSectionPicker({...h.options, rememberScopes, onRemember} as never);
        h.flushFrames();
        expect(query(h.shadow(), '.fr-section-remember').hidden).toBe(true);
        h.emit('click', {clientX: 50, clientY: 70}); h.flushFrames(); vi.advanceTimersByTime(90);
        const checkbox = query(h.shadow(), '.fr-section-remember-checkbox') as HTMLInputElement;
        const change = () => {
            const event = new (h.document.defaultView as unknown as {Event: typeof Event}).Event('change');
            Object.defineProperty(event, 'isTrusted', {value: true});
            checkbox.dispatchEvent(event);
        };
        expect(query(h.shadow(), '.fr-section-remember').hidden).toBe(false);
        expect(checkbox.checked).not.toBe(true);
        checkbox.checked = true; change();
        return h;
    };
    const settle = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };

    it('必要选择保留可访问名称，完整范围经描述关联并在切换网站时更新', async () => {
        const h = await setupRemember(vi.fn());
        const scope = query(h.shadow(), '.fr-section-remember-scope') as HTMLSelectElement;
        const mode = query(h.shadow(), '.fr-section-remember-mode') as HTMLSelectElement;
        expect(scope.parentElement!.hidden).toBe(false);
        expect(scope.getAttribute('aria-label')).toBe('sectionTranslation.rules.scope');
        expect(mode.getAttribute('aria-label')).toBe('sectionTranslation.rules.nextVisit');
        expect(scope.parentElement!.children).toHaveLength(1);
        expect(mode.parentElement!.children).toHaveLength(1);
        const address = query(h.shadow(), `#${scope.getAttribute('aria-describedby')}`);
        expect(address.className).toBe('fr-section-remember-address');
        expect(address.hidden).toBe(false);
        expect(address.textContent).toBe('example.com/articles/');
        expect(scope.title).toBe('example.com/articles/');
        Object.defineProperty(scope, 'value', {configurable: true, value: 'site'});
        const change = new (h.document.defaultView as unknown as {Event: typeof Event}).Event('change');
        Object.defineProperty(change, 'isTrusted', {value: true});
        scope.dispatchEvent(change);
        expect(address.textContent).toBe('example.com');
        expect(scope.title).toBe('example.com');
        expect(query(h.shadow(), '.fr-section-bar-instruction').textContent).toBe('sectionTranslation.label.translate:{"count":2}');
        h.picker.stopSectionPicker();
    });

    it('根路径等于网站时只显示下次动作，确认仍保存精确的网站范围', async () => {
        const onRemember = vi.fn().mockResolvedValue(true);
        const h = await setupRemember(onRemember, {site: 'example.com', path: 'example.com'});
        const scope = query(h.shadow(), '.fr-section-remember-scope') as HTMLSelectElement;
        const mode = query(h.shadow(), '.fr-section-remember-mode') as HTMLSelectElement;
        expect(scope.parentElement!.hidden).toBe(true);
        expect(mode.parentElement!.hidden).toBe(false);
        const fields = query(h.shadow(), '.fr-section-remember-fields');
        expect([...fields.children].filter(field => !(field as HTMLElement).hidden)).toEqual([mode.parentElement]);
        expect(scope.title).toBe('example.com');
        expect(query(h.shadow(), `#${scope.getAttribute('aria-describedby')}`).textContent).toBe('example.com');
        clickButton(h, 'confirm'); await settle();
        expect(onRemember).toHaveBeenCalledWith(h.byId('para'), {site: 'example.com', mode: 'remind'});
        expect(h.onPick).toHaveBeenCalledOnce();
    });

    it('显式记住默认当前路径并提醒，等待保存后才退出翻译，重复确认不重复保存', async () => {
        let finish!: (value: boolean) => void;
        const onRemember = vi.fn(() => new Promise<boolean>(resolve => {finish = resolve;}));
        const h = await setupRemember(onRemember);
        expect(button(h, 'confirm').textContent).toBe('sectionTranslation.rules.confirm');
        clickButton(h, 'confirm'); clickButton(h, 'confirm'); h.emit('keydown', {key: 'Enter'});
        await settle();
        expect(onRemember).toHaveBeenCalledOnce();
        expect(onRemember).toHaveBeenCalledWith(h.byId('para'), {site: 'example.com/articles/', mode: 'remind'});
        expect(h.onPick).not.toHaveBeenCalled(); expect(button(h, 'confirm').disabled).toBe(true);
        finish(true); await settle();
        expect(h.onPick).toHaveBeenCalledOnce(); expect(h.picker.isSectionPickerActive()).toBe(false);
    });

    it('网站自动模式保存失败保留选区与选项，允许重试', async () => {
        const onRemember = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('write failed')).mockResolvedValueOnce(true);
        const h = await setupRemember(onRemember);
        const scope = query(h.shadow(), '.fr-section-remember-scope') as HTMLSelectElement;
        const mode = query(h.shadow(), '.fr-section-remember-mode') as HTMLSelectElement;
        Object.defineProperty(scope, 'value', {configurable: true, value: 'site'});
        Object.defineProperty(mode, 'value', {configurable: true, value: 'auto'});
        for (let attempt = 0; attempt < 2; attempt += 1) {
            clickButton(h, 'confirm'); await settle();
            expect(h.picker.isSectionPickerActive()).toBe(true); expect(h.onPick).not.toHaveBeenCalled();
            expect(query(h.shadow(), '.fr-section-remember-status').textContent).toBe('sectionTranslation.rules.saveFailed');
            expect(button(h, 'confirm').disabled).toBe(false);
        }
        clickButton(h, 'confirm'); await settle();
        expect(onRemember).toHaveBeenCalledTimes(3); expect(onRemember).toHaveBeenLastCalledWith(h.byId('para'), {site: 'example.com', mode: 'auto'});
        expect(h.onPick).toHaveBeenCalledOnce();
    });

    it('退出或选区移除后忽略迟到保存结果，保存前立即退出不发送请求', async () => {
        for (const action of ['exit', 'remove', 'immediate-exit']) {
            let finish!: (value: boolean) => void;
            const onRemember = vi.fn(() => new Promise<boolean>(resolve => {finish = resolve;}));
            const h = await setupRemember(onRemember);
            clickButton(h, 'confirm');
            if (action === 'immediate-exit') h.emit('keydown', {key: 'Escape'});
            await settle();
            if (action === 'immediate-exit') expect(onRemember).not.toHaveBeenCalled();
            else {
                if (action === 'exit') h.emit('keydown', {key: 'Escape'});
                else {h.byId('para').remove(); h.emitMutation(h.byId('readme')); h.flushFrames();}
                finish(true); await settle();
            }
            expect(h.onPick).not.toHaveBeenCalled(); h.picker.stopSectionPicker();
        }
    });

    it('记忆原生控件保留方向键、Enter 和空格，恢复模式隐藏记忆入口', async () => {
        const h = await setupRemember(vi.fn());
        for (const selector of ['.fr-section-remember-checkbox', '.fr-section-remember-scope', '.fr-section-remember-mode']) {
            Object.defineProperty(h.shadow(), 'activeElement', {configurable: true, get: () => query(h.shadow(), selector)});
            for (const key of ['ArrowUp', 'ArrowDown', 'Enter', ' ']) {
                const event = h.emit('keydown', {key, composedPath: () => [h.host(), h.document.body]});
                expect(event.preventDefault).not.toHaveBeenCalled();
            }
        }
        h.inspect.mockReturnValue(summary({action: 'restore', active: 2, pending: 0}));
        h.emitMutation(h.byId('para')); vi.advanceTimersByTime(90); h.flushFrames();
        expect(query(h.shadow(), '.fr-section-remember').hidden).toBe(true);
        h.picker.stopSectionPicker();
    });
    it('保存期间方向键和已排队的控件变化不修改确认中的区域或清除保存状态', async () => {
        let finish!: (value: boolean) => void;
        const onRemember = vi.fn(() => new Promise<boolean>(resolve => {finish = resolve;}));
        const h = await setupRemember(onRemember);
        clickButton(h, 'confirm'); await settle();
        for (const key of ['ArrowUp', 'ArrowDown']) {
            const event = h.emit('keydown', {key, repeat: true});
            expect(event.preventDefault).toHaveBeenCalledOnce();
        }
        for (const trusted of [false, true]) {
            for (const selector of ['.fr-section-remember-checkbox', '.fr-section-remember-scope', '.fr-section-remember-mode']) {
                const event = new (h.document.defaultView as unknown as {Event: typeof Event}).Event('change');
                Object.defineProperty(event, 'isTrusted', {value: trusted});
                query(h.shadow(), selector).dispatchEvent(event);
            }
        }
        expect(query(h.shadow(), '.fr-section-remember-status').textContent).toBe('sectionTranslation.rules.saving');
        expect(button(h, 'confirm').disabled).toBe(true);
        expect(onRemember).toHaveBeenCalledOnce();
        finish(true); await settle();
        expect(h.onPick).toHaveBeenCalledOnce(); expect(h.onPick).toHaveBeenCalledWith(h.byId('para'));
    });

    it.each(['退出', '节点移除'] as const)('保存拒绝迟到时不对已失效选择继续报错或翻译：%s', async action => {
        let fail!: (error: Error) => void;
        const onRemember = vi.fn(() => new Promise<boolean>((_resolve, reject) => {fail = reject;}));
        const h = await setupRemember(onRemember);
        clickButton(h, 'confirm'); await settle();
        if (action === '退出') h.emit('keydown', {key: 'Escape'});
        else { h.byId('para').remove(); h.emitMutation(h.byId('readme')); h.flushFrames(); }
        fail(new Error('Late storage rejection')); await settle();
        expect(h.onPick).not.toHaveBeenCalled();
        expect(query(h.shadow(), '.fr-section-remember-status').textContent).not.toBe('sectionTranslation.rules.saveFailed');
        h.picker.stopSectionPicker();
    });

});

describe('局部高亮绘制的布局读写边界', () => {
    function watchStyles(element: HTMLElement, name: string, actions: string[]): void {
        const style = element.style;
        Object.defineProperty(element, 'style', {configurable: true, value: new Proxy(style, {
            set(target, property, value) {
                if (['transform', 'width', 'height'].includes(String(property))) actions.push(`write:${name}:${String(property)}`);
                return Reflect.set(target, property, value);
            },
        })});
    }

    it('静止区域的重复绘制不改写边框或标签的位置尺寸，真实布局变化仍立即更新', async () => {
        const h = await createHarness();
        h.picker.startSectionPicker(h.options as never); h.flushFrames();
        vi.advanceTimersByTime(90); h.flushFrames();
        const actions: string[] = [];
        const box = query(h.shadow(), '.fr-section-box');
        const label = query(h.shadow(), '.fr-section-label');
        watchStyles(box, 'box', actions); watchStyles(label, 'label', actions);
        for (let index = 0; index < 60; index++) { h.emit('scroll'); h.flushFrames(); }
        expect(actions).toEqual([]);
        h.byId('para').getBoundingClientRect = () => rect(50, 80, 450, 60) as DOMRect;
        h.emit('scroll'); h.flushFrames();
        expect(box.style.transform).toBe('translate(47px, 77px)');
        expect(box.style.width).toBe('456px');
        expect(box.style.height).toBe('66px');
        expect(actions).toEqual(['write:box:transform', 'write:box:width', 'write:box:height', 'write:label:transform']);
        h.picker.stopSectionPicker();
    });

    it('多选重绘先读取全部选区和标签几何，再写任一高亮框，每个选区每帧只测量一次', async () => {
        const h = await createHarness();
        h.document.elementFromPoint = (_x, y) => y < 110 ? h.byId('para') : h.byId('second');
        h.picker.startSectionPicker(h.options as never); h.flushFrames();
        h.emit('pointerdown', {pointerId: 1, clientX: 50, clientY: 70});
        h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 50, clientY: 130});
        h.emit('pointerup', {pointerId: 1, clientX: 50, clientY: 130});
        h.flushFrames(); vi.advanceTimersByTime(90); h.flushFrames();
        expect(h.shadow().querySelectorAll('.fr-section-box.is-visible')).toHaveLength(2);
        const actions: string[] = [];
        for (const id of ['para', 'second']) h.byId(id).getBoundingClientRect = () => {
            actions.push(`read:${id}`);
            return rect(40, id === 'para' ? 80 : 160, 440, 50) as DOMRect;
        };
        const label = query(h.shadow(), '.fr-section-label');
        Object.defineProperty(label, 'offsetWidth', {configurable: true, get: () => {actions.push('read:label-width'); return 160;}});
        Object.defineProperty(label, 'offsetHeight', {configurable: true, get: () => {actions.push('read:label-height'); return 24;}});
        Array.from(h.shadow().querySelectorAll<HTMLElement>('.fr-section-box')).forEach((box, index) => watchStyles(box, `box-${index}`, actions));
        watchStyles(label, 'label', actions);
        h.emit('scroll'); h.flushFrames();
        expect(actions.filter(action => action === 'read:para')).toHaveLength(1);
        expect(actions.filter(action => action === 'read:second')).toHaveLength(1);
        const firstWrite = actions.findIndex(action => action.startsWith('write:'));
        expect(firstWrite).toBeGreaterThan(0);
        expect(actions.slice(firstWrite).every(action => action.startsWith('write:'))).toBe(true);
        expect(label.style.transform).toBe('translate(40px, 47px)');
        h.picker.stopSectionPicker();
    });
});

describe('划选路径与独立滚动容器的几何边界', () => {
    it.each([
        {name: '路径左侧的滚动容器', bounds: [-200, 0, 100, 700], affected: false},
        {name: '路径下方的滚动容器', bounds: [0, 700, 100, 100], affected: false},
        {name: '路径上方的滚动容器', bounds: [0, -200, 100, 100], affected: false},
        {name: '端点之外但穿过划线路径的滚动容器', bounds: [0, 100, 100, 20], affected: true},
    ])('$name 只在路径相交时丢弃滚动前待绘制采样', async ({bounds, affected}) => {
        const h = await createHarness();
        const scroller = h.document.createElement('div');
        scroller.getBoundingClientRect = () => rect(...bounds as [number, number, number, number]) as DOMRect;
        h.document.body.append(scroller);
        h.document.elementFromPoint = (_x, y) => y < 110 ? h.byId('para') : h.byId('second');
        h.picker.startSectionPicker(h.options as never); h.flushFrames(); h.inspect.mockClear();
        h.emit('pointerdown', {pointerId: 1, clientX: 50, clientY: 70});
        h.emit('pointermove', {pointerId: 1, buttons: 1, clientX: 50, clientY: 140});
        // 没有刷新绘制帧：滚动必须判断完整线段，不能只判断两个端点或 DOM 祖先。
        h.emit('scroll', {target: scroller});
        h.emit('pointerup', {pointerId: 1, clientX: 50, clientY: 140});
        vi.advanceTimersByTime(90); h.flushFrames();
        const expected = affected ? h.byId('para') : [h.byId('para'), h.byId('second')];
        expect(h.inspect).toHaveBeenLastCalledWith(expected);
        expect(h.host()!.getAttribute('data-selection-state')).toBe('locked');
        expect(h.host()!.getAttribute('data-selection-count')).toBe(affected ? '1' : '2');
        h.emit('keydown', {key: 'Enter'});
        expect(h.onPick).toHaveBeenCalledOnce();
        expect(h.onPick).toHaveBeenCalledWith(expected);
    });
});
