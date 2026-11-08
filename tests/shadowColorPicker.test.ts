/**
 * @file tests/shadowColorPicker.test.ts
 * 文件职责：验证实例局部取色器指令适配与锁版本真实 ColorPicker 客户端渲染的装配合同。
 * 主要内容：真实 setup、render、编译 slot、ClickOutside 和 Vue 生命周期；覆盖模型更新、确认/清空、普通 Document、闭合根、实例隔离、缓存恢复与卸载，以及明确的未来 render-shape 兼容端口。
 * 模块边界：Tooltip、Input、Button 和 slider 是展示/事件端口；Linkedom 的同 Event retarget 是受控 DOM 端口，不证明原生弹层、焦点陷阱、鼠标速度或存储持久化。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {DirectiveBinding, ObjectDirective, VNode} from 'vue';

const dom = await vi.hoisted(async () => {
    const {parseHTML} = await import('linkedom');
    const parsed = parseHTML('<html><body></body></html>');
    const window = parsed.window as unknown as Window & typeof globalThis;
    for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'ShadowRoot', 'Event']) {
        Object.defineProperty(globalThis, key, {configurable: true, writable: true, value: window[key as keyof typeof window]});
    }
    let active: Element | null = null;
    Object.defineProperty(parsed.document, 'activeElement', {configurable: true, get: () => active});
    window.HTMLElement.prototype.focus = function () {active = this;};
    window.HTMLElement.prototype.blur = function () {if (active === this) active = null;};
    return {document: parsed.document as unknown as Document, window, clearFocus: () => {active = null;}};
});
const ports = vi.hoisted(() => ({
    mode: 'actual',
    panels: [] as Array<{panel: VNode; bindings: DirectiveBinding[] | null}>,
    originalSetup: null as unknown,
    originalDirective: null as ObjectDirective | null,
    sourceRoots: [] as VNode[],
    exposed: [] as unknown[],
}));
// 外部依赖完全 call-through；仅为未来 render-shape 准入添加明确的 source presentation ports。
vi.mock('element-plus', async () => {
    const vendor = await vi.importActual<typeof import('element-plus')>('element-plus');
    const vue = await import('vue');
    ports.originalSetup = vendor.ElColorPicker.setup;
    ports.originalDirective = vendor.ClickOutside;
    const foreign: ObjectDirective = {mounted: vi.fn()};
    const Picker = {...vendor.ElColorPicker,
        render: () => vue.h('output', {'data-compatibility': ''}, 'vendor setup bindings'),
        setup(props: Parameters<NonNullable<typeof vendor.ElColorPicker.setup>>[0], context: Parameters<NonNullable<typeof vendor.ElColorPicker.setup>>[1]) {
            const render = vendor.ElColorPicker.setup!(props, context);
            if (ports.mode === 'setup-bindings') return {compatibility: true};
            if (typeof render !== 'function') throw new Error('locked ColorPicker must return a render function');
            return function (this: unknown, ...renderArgs: unknown[]) {
                const root = Reflect.apply(render, this, renderArgs) as VNode;
                ports.sourceRoots.push(root);
                if (ports.mode === 'text-root') return 'vendor text';
                if (ports.mode === 'other-root') return vue.h('output', 'vendor root');
                const slots = root.children as Record<string, (...args: unknown[]) => unknown>;
                if (ports.mode === 'missing-content') {root.children = {...slots, content: undefined};return root;}
                if (ports.mode === 'null-slots') return vue.h(vendor.ElTooltip, root.props);
                if (ports.mode === 'single-vnode') return vue.h(vendor.ElTooltip, root.props, {content: () => vue.h('output', 'vendor vnode')});
                if (ports.mode === 'text-content') {root.children = {...slots, content: () => ['vendor slot text']};return root;}
                const content = slots.content;
                root.children = {...slots, content: new Proxy(content, {apply(slot, receiver, slotArgs) {
                    const result = Reflect.apply(slot, receiver, slotArgs) as VNode[];
                    const panel = result[0];
                    if (ports.mode === 'many-content') result.push(vue.h('output', 'vendor sibling'));
                    if (ports.mode === 'other-panel') panel.type = 'section';
                    if (ports.mode === 'mounted-panel') panel.el = vue.markRaw(dom.document.createElement('div'));
                    if (ports.mode === 'no-directive') panel.dirs = null;
                    if (ports.mode === 'other-directive') panel.dirs = panel.dirs!.map(binding => ({...binding, dir: foreign}));
                    if (ports.mode === 'duplicate-directive') panel.dirs = [...panel.dirs!, {...panel.dirs![0]}];
                    if (ports.mode === 'extra-directive') panel.dirs = [...panel.dirs!, {...panel.dirs![0], dir: foreign}];
                    ports.panels.push({panel, bindings: panel.dirs});
                    return result;
                }})};
                return root;
            };
        },
    };
    return {...vendor, ElColorPicker: Picker};
});
import {createRenderer, defineComponent, h, isVNode, KeepAlive, markRaw, nextTick, ref, renderSlot, type App, type Ref} from 'vue';
import {ClickOutside, ElTooltip, ID_INJECTION_KEY, ZINDEX_INJECTION_KEY} from 'element-plus';
import {ShadowColorPicker} from '@/src/ui/shadowColorPicker';

const Input = defineComponent({props: ['modelValue'], emits: ['update:modelValue'], setup(props, {attrs, emit}) {
    return () => h('input', {...attrs, value: props.modelValue, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value)});
}});
const Button = defineComponent({setup: (_, {attrs, slots}) => () => h('button', attrs, slots.default?.())});
const Slider = defineComponent({setup(_, {expose}) {expose({update() {}});return () => h('i');}});
const Tooltip = defineComponent({props: ['visible'], setup: (props, {slots}) => () => h('section', {'data-tooltip-visible': String(props.visible)}, [renderSlot(slots, 'default'), renderSlot(slots, 'content')])});
function presentationPorts(node: VNode) {
    if (typeof node.type === 'object' && 'name' in node.type) {
        if (node.type.name === 'ElInput') node.type = Input;
        else if (node.type.name === 'ElButton') node.type = Button;
        else if (['ElSlPanel', 'ElColorHueSlider'].includes(node.type.name ?? '')) node.type = Slider;
    }
    if (Array.isArray(node.children)) for (const child of node.children) if (isVNode(child)) presentationPorts(child);
}
// 控制最终展示依赖，真实 owning 模块已经先转换原 ColorPicker 返回的 VNode。
const PresentedPicker = Object.assign({}, ShadowColorPicker, {
    // Proxy 保留 owning setup.length，真实 Vue 必须自行创建 context；不掩盖 arity 错误。
    setup: new Proxy(ShadowColorPicker.setup!, {apply(setup, receiver, setupArgs) {
        const render = Reflect.apply(setup, receiver, setupArgs);
        if (typeof render !== 'function') return render;
        return function (this: unknown, ...renderArgs: unknown[]) {
            const root = Reflect.apply(render, this, renderArgs);
            if (!isVNode(root) || root.type !== ElTooltip) return root;
            root.type = Tooltip;
            const slots = root.children as Record<string, (...args: unknown[]) => unknown> | null;
            if (slots?.content) root.children = {...slots, content: new Proxy(slots.content, {apply(slot, receiver, slotArgs) {
                const nodes: unknown = Reflect.apply(slot, receiver, slotArgs);
                if (Array.isArray(nodes)) for (const node of nodes) {if (isVNode(node)) presentationPorts(node);}
                else if (isVNode(nodes)) presentationPorts(nodes);
                return nodes;
            }})};
            return root;
        };
    }}),
});
const renderer = createRenderer<Node, Element>({
    insert: (node, parent, anchor) => parent.insertBefore(node, anchor ?? null),
    remove: node => node.parentNode?.removeChild(node),
    createElement: tag => markRaw(dom.document.createElement(tag)),
    createText: text => markRaw(dom.document.createTextNode(text)),
    createComment: text => markRaw(dom.document.createComment(text)),
    setText: (node, text) => {node.nodeValue = text;},
    setElementText: (node, text) => {node.textContent = text;},
    parentNode: node => node.parentNode as Element | null,
    nextSibling: node => node.nextSibling,
    patchProp(element, key, previous, value) {
        if (key.startsWith('on')) {
            const name = key.slice(2).toLowerCase();
            if (previous) element.removeEventListener(name, previous);
            if (value) element.addEventListener(name, value);
        } else if (key === 'class') element.className = value ?? '';
        else if (key === 'style') return;
        else if (key === 'value') (element as HTMLInputElement).value = value ?? '';
        else if (value == null) element.removeAttribute(key);
        else element.setAttribute(key, String(value));
    },
});
type PickerExposed = {color: {value: string}; show(): void; hide(): void; focus(): void; blur(): void};
const apps = new Set<App>();
async function settle() {await nextTick();await nextTick();await nextTick();}
async function fixture(options: {shadow?: boolean; keepAlive?: boolean; model?: string} = {}) {
    const host = markRaw(dom.document.createElement('div'));dom.document.body.append(host);
    const scope = options.shadow ? host.attachShadow({mode: 'closed'}) : host;
    const container = markRaw(dom.document.createElement('div'));scope.append(container);
    const model = ref(options.model ?? '#123456'), visible = ref(true), exposed: Ref<PickerExposed | null> = ref(null), updates = vi.fn();
    const other = defineComponent({render: () => h('aside', 'other page')});
    const errors: unknown[] = [], warnings: string[] = [];
    const app = renderer.createApp({render: () => {
        const picker = h(PresentedPicker, {modelValue: model.value, ref: exposed, 'onUpdate:modelValue': (value: string | null) => {updates(value);model.value = value ?? '';}});
        return options.keepAlive ? h(KeepAlive, null, {default: () => visible.value ? picker : h(other)}) : visible.value ? picker : h(other);
    }});
    app.provide(ID_INJECTION_KEY, {prefix: 0, current: 0});app.provide(ZINDEX_INJECTION_KEY, {current: 0});
    app.config.errorHandler = error => errors.push(error);app.config.warnHandler = warning => warnings.push(warning);
    app.mount(container);apps.add(app);await settle();
    const dispose = async () => {app.unmount();apps.delete(app);host.remove();await settle();expect(errors).toEqual([]);expect(warnings).toEqual([]);};
    return {app, host, container, model, visible, exposed, updates, errors, warnings, dispose,
        panel: () => container.querySelector<HTMLElement>('.el-color-dropdown__main-wrapper')!.parentElement!,
        input: () => container.querySelector<HTMLInputElement>('input')!,
        open: async () => {exposed.value!.show();await settle();},
        isOpen: () => container.querySelector('section')?.getAttribute('data-tooltip-visible') === 'true',
    };
}
function retainedMouse(target: Element, type: 'mousedown' | 'mouseup', bubbles: boolean) {
    const event = new dom.window.Event(type, {bubbles, cancelable: true});let current = target;
    Reflect.deleteProperty(event, 'target');
    Object.setPrototypeOf(event, Object.create(Object.getPrototypeOf(event), {target: {get: () => current, set() {}}}));
    return {event, retarget: (next: Element) => {current = next;}};
}
function ordinaryMouse(target: Element, type: 'mousedown' | 'mouseup') {const {event} = retainedMouse(target, type, true);target.dispatchEvent(event);return event;}
function shadowMouse(panel: Element, target: Element, host: Element, type: 'mousedown' | 'mouseup') {
    const {event, retarget} = retainedMouse(target, type, false);
    const stop = vi.spyOn(event, 'stopPropagation'), prevent = vi.spyOn(event, 'preventDefault');panel.dispatchEvent(event);
    retarget(host);dom.document.dispatchEvent(event);expect(stop).not.toHaveBeenCalled();expect(prevent).not.toHaveBeenCalled();return event;
}
function outside() {const node = dom.document.createElement('button');dom.document.body.append(node);return node;}
const mouseCalls = (spy: {mock: {calls: ReadonlyArray<readonly unknown[]>}}) => spy.mock.calls.filter(([name, , capture]) => (name === 'mousedown' || name === 'mouseup') && capture === true);
beforeEach(() => {ports.mode = 'actual';ports.panels = [];ports.sourceRoots = [];ports.exposed = [];vi.useFakeTimers();});
afterEach(async () => {for (const app of apps) app.unmount();apps.clear();await settle();vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();dom.clearFocus();dom.document.body.replaceChildren();});

describe('instance-local ColorPicker using the locked real setup and render', () => {
    it('retains fresh panel/block identity, original bindings/expose and repeated model updates', async () => {
        const original = await vi.importActual<typeof import('element-plus')>('element-plus');
        expect(ClickOutside).toBe(original.ClickOutside);expect(ports.originalSetup).toBe(original.ElColorPicker.setup);
        const f = await fixture({shadow: true});expect(Object.keys(f.exposed.value!).sort()).toEqual(['blur', 'color', 'focus', 'hide', 'show']);
        expect(f.input().value).toBe('#123456');f.model.value = '#abcdef';await settle();expect(f.input().value).toBe('#ABCDEF');
        f.model.value = '#fedcba';await settle();expect(f.input().value).toBe('#FEDCBA');expect(f.errors).toEqual([]);
        const panels = ports.panels.map(row => row.panel);expect(new Set(panels).size).toBe(panels.length);
        expect(panels.every(panel => panel.el === f.panel())).toBe(true);
        for (const row of ports.panels) {
            expect(row.bindings![0].dir).toBe(original.ClickOutside);expect(row.panel.dirs![0].dir).not.toBe(original.ClickOutside);
            for (const key of ['instance', 'value', 'arg', 'modifiers'] as const) expect(row.panel.dirs![0][key]).toBe(row.bindings![0][key]);
        }
        expect(original.ElColorPicker.setup).toBe(ports.originalSetup);await f.dispose();
    });
    it('keeps actual ColorPicker input/Enter/confirm and clear emissions through presentation ports', async () => {
        const f = await fixture({shadow: true});await f.open();f.input().value = '#12AB34';f.input().dispatchEvent(new dom.window.Event('input', {bubbles: true}));await settle();
        const enter = new dom.window.Event('keyup', {bubbles: true});Object.defineProperty(enter, 'key', {value: 'Enter'});f.input().dispatchEvent(enter);await settle();
        f.container.querySelector<HTMLButtonElement>('.el-color-dropdown__btn')!.click();await settle();expect(f.updates).toHaveBeenCalledOnce();expect(f.updates).toHaveBeenCalledWith('#12AB34');expect(f.model.value).toBe('#12AB34');
        await f.open();f.container.querySelector<HTMLButtonElement>('.el-color-dropdown__link-btn')!.click();await settle();expect(f.updates.mock.calls).toEqual([['#12AB34'], [null]]);expect(f.model.value).toBe('');await f.dispose();
    });
    it('preserves normal Document inside/outside behavior without adding capture listeners', async () => {
        const add = vi.spyOn(dom.window.HTMLElement.prototype, 'addEventListener');const f = await fixture();await f.open();
        ordinaryMouse(f.input(), 'mousedown');ordinaryMouse(f.input(), 'mouseup');await settle();expect(f.isOpen()).toBe(true);
        expect(mouseCalls(add)).toHaveLength(0);const other = outside();ordinaryMouse(other, 'mousedown');ordinaryMouse(other, 'mouseup');await settle();expect(f.isOpen()).toBe(false);await f.dispose();
    });
    it('retains a closed-root internal Event while permitting a real document observer and outside cancel', async () => {
        const f = await fixture({shadow: true}), observer = vi.fn();dom.document.addEventListener('mouseup', observer);
        try {await f.open();shadowMouse(f.panel(), f.input(), f.host, 'mousedown');const up = shadowMouse(f.panel(), f.input(), f.host, 'mouseup');await settle();expect(f.isOpen()).toBe(true);expect(observer).toHaveBeenCalledOnce();expect(observer).toHaveBeenCalledWith(up);
            const other = outside();ordinaryMouse(other, 'mousedown');ordinaryMouse(other, 'mouseup');await settle();expect(f.isOpen()).toBe(false);
        } finally {dom.document.removeEventListener('mouseup', observer);await f.dispose();}
    });
    it('keeps instances independent and an internal click in another picker closes only the first', async () => {
        const a = await fixture({shadow: true}), b = await fixture({shadow: true, model: '#abcdef'});await a.open();await b.open();
        shadowMouse(b.panel(), b.input(), b.host, 'mousedown');shadowMouse(b.panel(), b.input(), b.host, 'mouseup');await settle();expect(a.isOpen()).toBe(false);expect(b.isOpen()).toBe(true);
        expect(a.model.value).toBe('#123456');expect(b.model.value).toBe('#abcdef');await a.dispose();await b.dispose();
    });
    it('stops and restarts exact captures for KeepAlive and removes them at final unmount', async () => {
        const add = vi.spyOn(dom.window.HTMLElement.prototype, 'addEventListener'), remove = vi.spyOn(dom.window.HTMLElement.prototype, 'removeEventListener');
        const f = await fixture({shadow: true, keepAlive: true});await f.open();const instance = f.exposed.value;
        const initial = mouseCalls(add).length;expect(initial).toBeGreaterThan(0);f.visible.value = false;await settle();expect(mouseCalls(remove)).toHaveLength(initial);
        f.model.value = '#abcdef';f.visible.value = true;await settle();expect(f.exposed.value).toBe(instance);expect(f.input().value).toBe('#ABCDEF');
        await f.open();shadowMouse(f.panel(), f.input(), f.host, 'mousedown');shadowMouse(f.panel(), f.input(), f.host, 'mouseup');await settle();expect(f.isOpen()).toBe(true);
        await f.dispose();expect(mouseCalls(add)).toHaveLength(mouseCalls(remove).length);
        for (const [name, listener, capture] of mouseCalls(add)) expect(mouseCalls(remove).some(call => call[0] === name && call[1] === listener && call[2] === capture)).toBe(true);
    });
    it('removes captures on ordinary unmount and never calls the old picker again', async () => {
        const remove = vi.spyOn(dom.window.HTMLElement.prototype, 'removeEventListener');const f = await fixture({shadow: true});await f.open();const current = f.exposed.value!;await f.dispose();expect(mouseCalls(remove).length).toBeGreaterThan(0);
        const color = current.color.value;ordinaryMouse(outside(), 'mousedown');ordinaryMouse(outside(), 'mouseup');await settle();expect(current.color.value).toBe(color);expect(f.updates).not.toHaveBeenCalled();
    });
    it('preserves an additional unrelated directive rather than replacing its binding', async () => {
        ports.mode = 'extra-directive';const f = await fixture({shadow: true});const row = ports.panels[0];expect(row.panel.dirs![1]).toBe(row.bindings![1]);expect(row.panel.dirs![1].dir.mounted).toHaveBeenCalledOnce();await f.dispose();
    });
    it.each(['setup-bindings', 'text-root', 'other-root', 'missing-content', 'null-slots', 'single-vnode', 'text-content', 'many-content', 'other-panel', 'mounted-panel', 'no-directive', 'other-directive', 'duplicate-directive'])('passes through unsupported vendor render shape %s without taking ownership', async mode => {
        ports.mode = mode;const f = await fixture();expect(f.container.childNodes.length).toBeGreaterThan(0);
        for (const row of ports.panels) expect(row.panel.dirs).toBe(row.bindings);
        expect(f.errors).toEqual([]);await f.dispose();
    });
});
