import {parseHTML} from 'linkedom';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import * as vue from 'vue';
import {Config} from '@/src/core/config/model';
import Settings from '@/src/features/settings/ui/PrivateTranslationSettings.vue';
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({t: (key: string) => key})}));
vi.mock('@/src/features/settings/ui/components/FieldHelp.vue', () => ({default: {render: () => null}}));
let app: vue.App | undefined, document: Document, root: HTMLElement;
let props: {config: Config; serviceOptions: {value: string; label: string; disabled?: boolean}[]; active?: boolean}, shown: vue.Ref<boolean>;
let events: Map<Element, Record<string, any>>;
async function settle() {await vue.nextTick();await Promise.resolve();await vue.nextTick();}
beforeEach(() => {document = parseHTML('<html><body><div id="app"></div></body></html>').document as unknown as Document;events = new Map();});
afterEach(async () => {app?.unmount();app = undefined;await settle();vi.unstubAllGlobals();});
async function mount(source: Partial<Config> = {}, active?: boolean, realInput = false) {
    expect(Settings).toHaveProperty('render', expect.any(Function));
    props = vue.reactive({config: Object.assign(new Config(), source), serviceOptions: [
        {value: 'openai', label: 'OpenAI'}, {value: 'microsoft', label: 'Microsoft'},
        {value: 'custom:private', label: 'Private'}, {value: 'custom:disabled', label: 'Disabled', disabled: true},
    ], ...(active === undefined ? {} : {active})});
    shown = vue.ref(true);
    const renderer = vue.createRenderer({
        patchProp(el: any, key: string, _before: unknown, value: any) {
            const handlers = events.get(el) ?? {};events.set(el, handlers);
            if (/^on[A-Z]/u.test(key)) {
                if (realInput && !key.includes(':')) {
                    const name = key.slice(2).toLowerCase();
                    if (handlers[key]) el.removeEventListener(name, handlers[key]);
                    if (value) el.addEventListener(name, value);
                }
                handlers[key] = value;return;
            }
            if (realInput && key === 'value') {el.value = value ?? '';return;}
            if (value === false || value === undefined || value === null) el.removeAttribute(key);
            else el.setAttribute(key, String(value));
        },
        insert: (child: any, parent: any, anchor: any = null) => parent.insertBefore(child, anchor),
        remove: (node: any) => node.parentNode?.removeChild(node),
        createElement: tag => document.createElement(tag), createText: value => document.createTextNode(value), createComment: value => document.createComment(value),
        setText: (node: any, value) => {node.nodeValue = value;}, setElementText: (el: any, value) => {el.textContent = value;},
        parentNode: (node: any) => node.parentNode, nextSibling: (node: any) => node.nextSibling, querySelector: selector => document.querySelector(selector),
        setScopeId: () => {}, cloneNode: (node: any) => node.cloneNode(true),
        insertStaticContent: (html: string, parent: any, anchor: any) => {
            const template = document.createElement('template');template.innerHTML = html;
            const first = template.content.firstChild!, last = template.content.lastChild!;
            parent.insertBefore(template.content, anchor);return [first, last];
        },
    });
    app = renderer.createApp({setup: () => () => vue.h(vue.KeepAlive, null, {default: () => shown.value
        ? vue.h(Settings, props) : vue.h({render: () => null}, {key: 'other'})})});
    for (const name of ['el-switch', 'el-select', 'el-input', 'el-option'].filter(name => !realInput || name !== 'el-input')) app.component(name, {
        setup(_: unknown, {attrs, slots}: any) {return () => vue.h('div', attrs, slots.default?.());},
    });
    if (realInput) {
        const win = document.defaultView!;
        for (const [key, value] of Object.entries({document, window: win, HTMLElement: win.HTMLElement,
            HTMLInputElement: win.HTMLInputElement, Element: win.Element, Node: win.Node, Event: win.Event, CompositionEvent: win.Event})) vi.stubGlobal(key, value);
        const {ElInput} = await import('element-plus');
        app.component('el-input', ElInput);
    }
    root = document.getElementById('app')!;app.mount(root);await settle();
}
function handler(field: string) {
    const el = root.querySelector(`[aria-label="privateTranslation.${field}"]`)!;
    expect(el).not.toBeNull();return events.get(el)!['onUpdate:modelValue'] as (value: unknown) => void;
}
async function change(field: string, value: unknown) {handler(field)(value);await settle();}
describe('private translation settings real template and lifecycle', () => {
    it('real ElInput discards delayed composition updates across config replacement without rebuilding for typing', async () => {
        await mount({privateTranslation: {enabled: true, service: 'openai', model: 'initial'}}, true, true);
        const input = root.querySelector('input')!;
        expect(input).not.toBeNull();
        let focused: Element | null = null;
        Object.defineProperty(document, 'activeElement', {configurable: true, get: () => focused});
        input.focus = () => {focused = input;};input.focus();
        const send = (el: HTMLInputElement, type: string) => {
            const event = new document.defaultView!.Event(type, {bubbles: true});el.dispatchEvent(event);
            // Linkedom deletes target after dispatch; browsers retain it for nextTick consumers.
            Object.defineProperty(event, 'target', {value: el, configurable: true});
        };
        for (const text of ['p', 'pr', 'private']) {
            input.value = text;send(input, 'input');await settle();
            expect(props.config.privateTranslation.model).toBe(text);
            expect(root.querySelector('input')).toBe(input);expect(document.activeElement).toBe(input);
        }
        const oldConfig = props.config;
        send(input, 'compositionstart');input.value = '迟到模型';send(input, 'input');
        expect(oldConfig.privateTranslation.model).toBe('private');
        // Queue the parent update first, then the real Element Plus composition-end nextTick.
        // Keep the same model value so a native-value watcher cannot erase the IME buffer.
        // Without keyed controls, this old component reads the replacement's fresh handler.
        props.config = Object.assign(new Config(), {privateTranslation: {enabled: true, service: 'openai', model: 'private'}});
        send(input, 'compositionend');await settle();
        expect(props.config.privateTranslation.model).toBe('private');
        expect(root.querySelector('input')).not.toBe(input);
        expect(oldConfig.privateTranslation.model).toBe('private');
        const fresh = root.querySelector('input')!;fresh.value = 'fresh edit';send(fresh, 'input');await settle();
        expect(props.config.privateTranslation.model).toBe('fresh edit');
        expect(root.querySelector('input')).toBe(fresh);
    });
    it('starts disabled, filters supported connections, requires explicit model, preserves settings when disabled', async () => {
        await mount();expect(root.querySelector('[aria-label="privateTranslation.model"]')).toBeNull();
        await change('title', 'true');expect(props.config.privateTranslation.enabled).toBe(false);
        await change('title', true);
        expect(root.querySelector('[value="microsoft"]')).toBeNull();
        expect(root.querySelector('[value="custom:private"]')).toBeNull();
        expect(root.querySelector('[value="custom:disabled"]')).toBeNull();
        expect(root.querySelector('[role="status"]')).not.toBeNull();
        await change('service', 1);await change('service', 'microsoft');expect(props.config.privateTranslation.service).toBe('');
        await change('service', 'openai');await change('model', false);expect(props.config.privateTranslation.model).toBe('');
        await change('model', 'private-model');await change('service', 'openai');expect(props.config.privateTranslation.model).toBe('private-model');expect(root.querySelector('[role="status"]')).toBeNull();
        await change('title', false);expect(props.config.privateTranslation.model).toBe('private-model');
        await change('title', true);await change('model', 'x'.repeat(257));expect(props.config.privateTranslation.model).toHaveLength(256);
    });
    it('preserves unavailable saved choices and clears model only when selecting a new connection', async () => {
        await mount({privateTranslation: {enabled: true, service: 'custom:deleted', model: 'old'}, customOpenAIProviders: [
            {id: 'custom:private', name: 'Private', endpoint: 'https://test.invalid/v1', models: []},
        ]});
        expect(root.querySelector('[value="custom:deleted"]')).not.toBeNull();expect(root.querySelector('[role="status"]')).not.toBeNull();
        await change('service', 'custom:private');expect(props.config.privateTranslation.model).toBe('');
        await change('model', 'new');expect(props.config.privateTranslation.model).toBe('new');
    });
    it('rejects callbacks after disabled, config replacement, service change, hidden, KeepAlive deactivation or unmount', async () => {
        await mount({privateTranslation: {enabled: true, service: 'openai', model: 'first'}});
        let stale = handler('model');await change('title', false);stale('bad');expect(props.config.privateTranslation.model).toBe('first');
        await change('title', true);stale = handler('service');props.config = new Config();stale('openai');await settle();expect(props.config.privateTranslation.service).toBe('');
        await change('title', true);stale = handler('model');await change('service', 'openai');stale('bad');expect(props.config.privateTranslation.model).toBe('');
        stale = handler('model');props.active = false;await settle();stale('bad');expect(props.config.privateTranslation.model).toBe('');
        props.active = true;await settle();stale = handler('model');shown.value = false;await settle();stale('bad');expect(props.config.privateTranslation.model).toBe('');
        shown.value = true;await settle();stale = handler('model');app!.unmount();app = undefined;stale('bad');expect(props.config.privateTranslation.model).toBe('');
    });
    it('does not accept edits while explicitly inactive', async () => {
        await mount({privateTranslation: {enabled: true, service: 'openai', model: 'first'}}, false);
        await change('title', false);await change('service', 'openai');await change('model', 'bad');expect(props.config.privateTranslation).toEqual({enabled: true, service: 'openai', model: 'first'});
    });
});
