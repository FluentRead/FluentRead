import {parseHTML, Document, ShadowRoot} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import * as vue from 'vue';
import {Config} from '@/src/core/config/model';
import Settings from '@/src/features/settings/ui/PrivacyProtectionSettings.vue';
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({t: (key: string, vars?: {count?: number}) => vars?.count === undefined ? key === 'privacy.sampleText' ? 'Contact demo@example.test · 13800138000' : key : `${key}:${vars.count}`})}));
vi.mock('@/src/features/settings/ui/components/SettingsGroup.vue', () => ({default: {setup(_: unknown, {slots}: any) {return () => vue.h('section', [slots['heading-extra']?.(), slots.default?.()]);}}}));
vi.mock('@/src/features/settings/ui/components/FieldHelp.vue', () => ({default: {render: () => null}}));
vi.mock('@/src/features/settings/ui/components/SettingsItem.vue', () => ({default: {setup(_: unknown, {slots}: any) {return () => vue.h('div', slots.default?.());}}}));
let app: vue.App | undefined;
afterEach(() => {app?.unmount(); app = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals();});
async function settle() {await vue.nextTick(); await vue.nextTick();}

async function mount() {
  vi.stubGlobal('Document', Document); vi.stubGlobal('ShadowRoot', ShadowRoot);
  const document = parseHTML('<html><body><main id="app"></main></body></html>').document;
  const events = new Map<Element, Record<string, any>>();
  const props = vue.reactive({config: new Config(), active: true});
  const visible = vue.ref(true);
  const renderer = vue.createRenderer({
    patchProp(el: any, key: string, _before: unknown, value: any) {
      const handlers = events.get(el) ?? {}; events.set(el, handlers);
      if (/^on[A-Z]/u.test(key)) {handlers[key] = value; return;}
      if (value === false || value === undefined || value === null) el.removeAttribute(key);
      else el.setAttribute(key, String(value));
    },
    insert: (node: any, parent: any, anchor: any = null) => parent.insertBefore(node, anchor),
    remove: (node: any) => node.parentNode?.removeChild(node), createElement: tag => document.createElement(tag),
    createText: text => document.createTextNode(text), createComment: text => document.createComment(text),
    setText: (node: any, text) => {node.nodeValue = text;}, setElementText: (node: any, text) => {node.textContent = text;},
    parentNode: (node: any) => node.parentNode, nextSibling: (node: any) => node.nextSibling,
    querySelector: selector => document.querySelector(selector), setScopeId: () => {}, cloneNode: (node: any) => node.cloneNode(true),
    insertStaticContent: (html: string, parent: any, anchor: any) => {const template = document.createElement('template'); template.innerHTML = html;
      const first = template.content.firstChild!, last = template.content.lastChild!; parent.insertBefore(template.content, anchor); return [first, last];},
  });
  const component = vue.ref<any>();
  app = renderer.createApp({setup: () => () => vue.h(vue.KeepAlive, null, {default: () => visible.value
    ? vue.h(Settings, {...props, ref: component}) : vue.h({render: () => null}, {key: 'other'})})});
  app.component('el-switch', {setup(_: unknown, {attrs}: any) {return () => vue.h('input', attrs);}});
  app.component('el-button', {setup(_: unknown, {attrs, slots}: any) {return () => vue.h('button', attrs, slots.default?.());}});
  app.component('el-input', {props: ['modelValue'], setup(input: any, {attrs}: any) {return () => vue.h('textarea', {...attrs, value: input.modelValue});}});
  app.component('el-dialog', {props: ['modelValue'], setup(input: any, {attrs, slots}: any) {return () => input.modelValue ? vue.h('div', {...attrs, role: 'dialog'}, [slots.default?.(), slots.footer?.()]) : null;}});
  const root = document.getElementById('app')!; app.mount(root); await settle();
  const state = () => component.value.$.setupState as Record<string, any>;
  const control = (label: string) => root.querySelector(`[aria-label="${label}"]`)!;
  const invoke = (label: string, event: string, value: any) => events.get(control(label))![event](value);
  return {props, visible, root, state, invoke};
}

describe('privacy settings compact controls and lifecycle', () => {
  it('uses a header switch, compact choices and a modal for sensitive phrases', async () => {
    const {props, root, state, invoke} = await mount();
    expect(root.querySelector('[data-privacy-category]')).toBeNull();
    invoke('privacy.enabled', 'onUpdate:modelValue', 'true'); expect(props.config.privacyProtection.enabled).toBe(false);
    invoke('privacy.enabled', 'onUpdate:modelValue', true); await settle();
    expect(root.querySelectorAll('[data-privacy-category]')).toHaveLength(6);
    expect(root.querySelector('textarea')).toBeNull();
    state().actions.mode('invalid'); expect(props.config.privacyProtection.mode).toBe('mask');
    state().actions.mode('block'); await settle(); expect(props.config.privacyProtection.mode).toBe('block');
    expect(state().preview.blocked).toBe(true);
    state().actions.category.email(); await settle(); expect(props.config.privacyProtection.categories).not.toContain('email');
    state().actions.category.email(); await settle(); expect(props.config.privacyProtection.categories).toContain('email');
    state().actions.terms(); expect(props.config.privacyProtectionSecretTerms).toEqual([]);
    state().actions.manage(); await settle(); expect(root.querySelector('[role="dialog"]')).not.toBeNull();
    state().actions.draft(42); expect(state().termsDraft).toBe('');
    invoke('privacy.custom', 'onUpdate:modelValue', '  Private Example \nPrivate Example\nSecond'); await settle();
    expect(state().termsChanged).toBe(true); state().actions.terms(); await settle();
    expect(props.config.privacyProtectionSecretTerms).toEqual(['Private Example', 'Second']); expect(state().termsDraft).toBe('');
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    state().actions.manage(); await settle(); expect(state().termsChanged).toBe(false);
    state().actions.draft('x'.repeat(257)); await settle(); expect(state().termsValid).toBe(false);
    state().actions.terms(); expect(props.config.privacyProtectionSecretTerms).toEqual(['Private Example', 'Second']);
    expect(root.querySelector('[role="alert"]')).not.toBeNull();
    state().actions.draft(Array.from({length: 129}, (_, index) => `phrase-${index}`).join('\n')); await settle(); expect(state().termsValid).toBe(false);
    state().actions.cancel(); await settle(); expect(state().termsDraft).toBe('');
    state().actions.enabled(false); await settle(); expect(props.config.privacyProtection.mode).toBe('block');
  });
  it('shows only an automatic fixed preview, and never retains cancelled phrase drafts', async () => {
    const {props, state, root} = await mount();
    state().actions.enabled(true); await settle();
    expect(root.querySelectorAll('textarea')).toHaveLength(0);
    expect(root.querySelectorAll('details')).toHaveLength(0);
    expect(root.querySelector('[data-privacy-preview]')?.textContent).not.toContain('demo@example.test');
    state().actions.mode('block'); await settle(); expect(root.querySelector('[data-privacy-preview]')?.textContent).toBe('privacy.previewBlocked');
    props.config.privacyProtection.categories = []; await settle();
    expect(state().preview.blocked).toBe(false); expect(root.querySelector('[data-privacy-preview]')?.textContent).toContain('demo@example.test');
    props.config.privacyProtectionSecretTerms = ['Contact']; await settle(); expect(state().preview.blocked).toBe(true);
    state().actions.mode('mask'); await settle(); expect(root.querySelector('[data-privacy-preview]')?.textContent).toContain('privacy.category.custom');
    state().actions.manage(); await settle(); state().actions.draft('Unsaved private phrase'); await settle();
    state().actions.dialog(true); expect(state().termsOpen).toBe(true);
    state().actions.dialog(false); await settle(); expect(state().termsDraft).toBe(''); expect(props.config.privacyProtectionSecretTerms).toEqual(['Contact']);
    state().actions.draft('closed callback'); expect(state().termsDraft).toBe('');
    state().actions.manage(); await settle(); props.config.privacyProtectionSecretTerms = ['External update']; await settle();
    expect(state().termsDraft).toBe('External update');
    const old = state().actions; props.active = false; await settle();
    expect(state().termsOpen).toBe(false); expect(state().termsDraft).toBe('');
    old.enabled(false); old.category.email(); old.terms(); old.manage(); old.draft('late'); old.dialog(false); old.cancel(); old.mode('block');
    expect(props.config.privacyProtection.enabled).toBe(true); expect(props.config.privacyProtection.mode).toBe('mask');
    expect(state().termsDraft).toBe(''); props.active = true; await settle();
  });
  it('invalidates callbacks and closes the editor on configuration replacement, deactivation and unmount', async () => {
    const {props, state, visible} = await mount();
    state().actions.enabled(true); await settle(); state().actions.manage(); await settle();
    const before = state().actions; props.config = new Config(); await settle(); before.enabled(true);
    expect(props.config.privacyProtection.enabled).toBe(false); expect(state().termsOpen).toBe(false);
    state().actions.manage(); await settle(); state().actions.draft('Unsaved');
    const deactivate = state().actions; visible.value = false; await settle(); deactivate.enabled(true);
    visible.value = true; await settle(); expect(state().termsDraft).toBe(''); expect(props.config.privacyProtection.enabled).toBe(false);
    const after = state().actions; app!.unmount(); app = undefined; after.enabled(true); expect(props.config.privacyProtection.enabled).toBe(false);
  });
});
