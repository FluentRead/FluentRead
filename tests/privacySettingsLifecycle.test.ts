import {parseHTML, Document, ShadowRoot} from 'linkedom';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import * as vue from 'vue';
import {Config} from '@/src/core/config/model';
import {createEmptyPrivacyActivitySnapshot, PRIVACY_ACTIVITY_MESSAGE_TYPE, type PrivacyActivitySnapshot} from '@/src/core/privacy/activity';

const runtimeMock = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}));

vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: runtimeMock.sendMessage}}}));
vi.mock('@/src/ui/i18n', () => ({
  useUiI18n: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      if (key === 'privacy.sampleText') return 'Contact demo@example.test · 13800138000';
      if (!vars) return key;
      return `${key}:${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')}`;
    },
    translateLegacy: (label: string) => `legacy:${label}`,
  }),
}));
vi.mock('@/src/features/settings/ui/components/SettingsGroup.vue', () => ({default: {setup(_: unknown, {slots}: any) {return () => vue.h('section', [slots['heading-extra']?.(), slots.default?.()]);}}}));
vi.mock('@/src/features/settings/ui/components/FieldHelp.vue', () => ({default: {render: () => null}}));
vi.mock('@/src/features/settings/ui/components/SettingsItem.vue', () => ({default: {setup(_: unknown, {slots}: any) {return () => vue.h('div', slots.default?.());}}}));

import Settings from '@/src/features/settings/ui/PrivacyProtectionSettings.vue';
import ActivityLog from '@/src/features/settings/ui/PrivacyActivityLog.vue';

let app: vue.App | undefined;
beforeEach(() => {
  runtimeMock.sendMessage.mockReset();
  runtimeMock.sendMessage.mockResolvedValue({success: true, data: createEmptyPrivacyActivitySnapshot()});
});
afterEach(() => {app?.unmount(); app = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals();});
async function settle() {await vue.nextTick(); await Promise.resolve(); await vue.nextTick();}

async function mount(initialConfig?: Config) {
  vi.stubGlobal('Document', Document); vi.stubGlobal('ShadowRoot', ShadowRoot);
  const document = parseHTML('<html><body><main id="app"></main></body></html>').document;
  const events = new Map<Element, Record<string, any>>();
  const props = vue.reactive({config: initialConfig ?? new Config(), active: true});
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
  const settingsComponent = vue.ref<any>();
  const logComponent = vue.ref<any>();
  app = renderer.createApp({setup: () => () => vue.h(vue.KeepAlive, null, {default: () => visible.value
    ? vue.h(Settings, {...props, ref: settingsComponent}, {
      activity: () => vue.h(ActivityLog, {...props, ref: logComponent}),
    }) : vue.h({render: () => null}, {key: 'other'})})});
  app.component('el-switch', {setup(_: unknown, {attrs}: any) {return () => vue.h('input', attrs);}});
  app.component('el-button', {setup(_: unknown, {attrs, slots}: any) {return () => vue.h('button', attrs, slots.default?.());}});
  app.component('el-input', {props: ['modelValue'], setup(input: any, {attrs}: any) {return () => vue.h('textarea', {...attrs, value: input.modelValue});}});
  app.component('el-dialog', {props: ['modelValue'], setup(input: any, {attrs, slots}: any) {return () => input.modelValue ? vue.h('div', {...attrs, role: 'dialog'}, [slots.default?.(), slots.footer?.()]) : null;}});
  const root = document.getElementById('app')!; app.mount(root); await settle();
  const state = () => settingsComponent.value.$.setupState as Record<string, any>;
  const logState = () => logComponent.value.$.setupState as Record<string, any>;
  const control = (label: string) => root.querySelector(`[aria-label="${label}"]`)!;
  const invoke = (label: string, event: string, value: any) => events.get(control(label))![event](value);
  return {props, visible, root, state, logState, invoke};
}

function sampleSnapshot(): PrivacyActivitySnapshot {
  const now = Date.now();
  const yesterday = now - 24 * 60 * 60 * 1000;
  return {
    stats: {
      totalEvents: 10,
      maskedEvents: 7,
      blockedEvents: 2,
      stoppedEvents: 1,
      totalHits: 14,
      categoryCounts: {email: 8, phone: 4, secret: 2, identity: 0, payment: 0, network: 0, custom: 0},
      lastOccurredAt: now,
    },
    records: [
      {
        id: 'r-1',
        occurredAt: now,
        action: 'masked',
        serviceId: 'openai',
        hitCount: 3,
        categoryCounts: {email: 2, phone: 1},
        samples: [
          {category: 'email', masked: 'd***@e***.test'},
          {category: 'phone', masked: '138****00'},
        ],
      },
      {
        id: 'r-2',
        occurredAt: yesterday,
        action: 'blocked',
        serviceId: 'composite-1',
        hitCount: 1,
        categoryCounts: {secret: 1},
        samples: [{category: 'secret', masked: 'sk-***'}],
      },
      {
        id: 'r-3',
        occurredAt: yesterday - 1000,
        action: 'restore-failed',
        serviceId: 'custom:internal-1',
        hitCount: 1,
        categoryCounts: {email: 1},
        samples: [{category: 'email', masked: 'a***@b***.com'}],
      },
      ...Array.from({length: 7}, (_, index) => ({
        id: `r-more-${index}`,
        occurredAt: yesterday - (index + 2) * 1000,
        action: 'masked' as const,
        serviceId: 'unknown-service',
        hitCount: 0,
        categoryCounts: {email: 1},
        samples: [],
      })),
    ],
  };
}

describe('privacy settings compact controls and lifecycle', () => {
  it('uses a header switch, compact choices and a modal for sensitive phrases with usage counter and clear', async () => {
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
    expect(root.querySelector('[data-privacy-terms-usage]')?.textContent).toContain('used=3');
    expect(state().termsChanged).toBe(true); state().actions.terms(); await settle();
    expect(props.config.privacyProtectionSecretTerms).toEqual(['Private Example', 'Second']); expect(state().termsDraft).toBe('');
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    state().actions.manage(); await settle(); expect(state().termsChanged).toBe(false);
    state().actions.clearDraft(); await settle(); expect(state().termsDraft).toBe('');
    state().actions.draft('x'.repeat(257)); await settle(); expect(state().termsValid).toBe(false);
    state().actions.terms(); expect(props.config.privacyProtectionSecretTerms).toEqual(['Private Example', 'Second']);
    expect(root.querySelector('[role="alert"]')).not.toBeNull();
    state().actions.draft(Array.from({length: 129}, (_, index) => `phrase-${index}`).join('\n')); await settle(); expect(state().termsValid).toBe(false);
    state().actions.cancel(); await settle(); expect(state().termsDraft).toBe('');
    state().actions.clearDraft(); expect(state().termsDraft).toBe('');
    state().actions.enabled(false); await settle(); expect(props.config.privacyProtection.mode).toBe('block');
  });

  it('shows masked *** preview, empty-rules warning, and never retains cancelled phrase drafts', async () => {
    const {props, state, logState, root} = await mount();
    state().actions.enabled(true); await settle();
    expect(root.querySelectorAll('textarea')).toHaveLength(0);
    const previewText = root.querySelector('[data-privacy-preview]')?.textContent ?? '';
    expect(previewText).not.toContain('demo@example.test');
    expect(previewText).toContain('d***@e***.test');
    expect(previewText).toContain('138****00');
    state().actions.mode('block'); await settle(); expect(root.querySelector('[data-privacy-preview]')?.textContent).toBe('privacy.previewBlocked');
    props.config.privacyProtection.categories = []; await settle();
    expect(root.querySelector('[data-privacy-empty-rules]')).not.toBeNull();
    expect(state().preview.blocked).toBe(false); expect(root.querySelector('[data-privacy-preview]')?.textContent).toContain('demo@example.test');
    props.config.privacyProtectionSecretTerms = ['Contact']; await settle();
    expect(root.querySelector('[data-privacy-empty-rules]')).toBeNull();
    expect(state().preview.blocked).toBe(true);
    state().actions.mode('mask'); await settle(); expect(root.querySelector('[data-privacy-preview]')?.textContent).toContain('privacy.category.custom');
    state().actions.manage(); await settle(); state().actions.draft('Unsaved private phrase'); await settle();
    state().actions.dialog(true); expect(state().termsOpen).toBe(true);
    state().actions.dialog(false); await settle(); expect(state().termsDraft).toBe(''); expect(props.config.privacyProtectionSecretTerms).toEqual(['Contact']);
    state().actions.draft('closed callback'); expect(state().termsDraft).toBe('');
    state().actions.manage(); await settle(); props.config.privacyProtectionSecretTerms = ['External update']; await settle();
    expect(state().termsDraft).toBe('External update');
    const old = state().actions;
    const oldLog = logState().actions;
    props.active = false; await settle();
    expect(state().termsOpen).toBe(false); expect(state().termsDraft).toBe('');
    old.enabled(false); old.category.email(); old.terms(); old.manage(); old.draft('late'); old.clearDraft();
    old.dialog(false); old.cancel(); old.mode('block');
    oldLog.toggleLog({target: {open: true}} as unknown as Event);
    oldLog.refreshLog(); oldLog.requestClearLog(); oldLog.cancelClearLog(); oldLog.confirmClearLog(); oldLog.showMoreLog();
    oldLog.actionFilter.all(); oldLog.categoryFilter.email();
    expect(props.config.privacyProtection.enabled).toBe(true); expect(props.config.privacyProtection.mode).toBe('mask');
    expect(state().termsDraft).toBe(''); props.active = true; await settle();
  });

  it('renders a default-collapsed redaction & block log with stats, filters, pagination, clear confirmation, and error handling', async () => {
    const initial = new Config();
    initial.privacyProtection.enabled = true;
    initial.compositeTranslationProviders = [{id: 'composite-1', name: 'Smart Pool', services: ['openai'], strategy: 'smart', timeoutMs: 10_000}];
    initial.customOpenAIProviders = [{id: 'custom:internal-1', name: 'Internal LLM', endpoint: 'https://llm.invalid/v1', models: ['m1']}];
    runtimeMock.sendMessage.mockResolvedValue({success: true, data: sampleSnapshot()});

    const {root, logState} = await mount(initial);
    const details = root.querySelector('[data-privacy-log]');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);
    expect(root.querySelector('[data-privacy-log-stats]')?.textContent).toContain('masked=7,blocked=3,hits=14');

    // 展开抽屉触发刷新并展示脱敏摘要与分页
    logState().actions.toggleLog({target: {open: true}} as unknown as Event);
    await settle();
    expect(logState().logOpen).toBe(true);
    expect(runtimeMock.sendMessage).toHaveBeenCalledWith({type: PRIVACY_ACTIVITY_MESSAGE_TYPE, action: 'query'});
    expect(root.querySelectorAll('[data-privacy-log-list] > li')).toHaveLength(8);
    expect(root.querySelector('[data-privacy-log-list]')?.textContent).toContain('d***@e***.test');
    expect(root.querySelector('[data-privacy-log-list]')?.textContent).toContain('138****00');
    expect(root.querySelector('[data-privacy-log-list]')?.textContent).toContain('Smart Pool');
    expect(root.querySelector('[data-privacy-log-list]')?.textContent).toContain('Internal LLM');
    expect(root.querySelector('[data-privacy-log-more]')).not.toBeNull();

    // 展开更多
    logState().actions.showMoreLog(); await settle();
    expect(root.querySelectorAll('[data-privacy-log-list] > li')).toHaveLength(10);
    expect(root.querySelector('[data-privacy-log-more]')).toBeNull();

    // 按动作与类别筛选
    logState().actions.actionFilter.blocked(); await settle();
    expect(root.querySelectorAll('[data-privacy-log-list] > li')).toHaveLength(2);
    logState().actions.actionFilter.masked(); await settle();
    expect(root.querySelectorAll('[data-privacy-log-list] > li')).toHaveLength(8);
    logState().actions.categoryFilter.secret(); await settle();
    expect(root.querySelector('[data-privacy-log-empty]')?.textContent).toContain('privacy.log.emptyFiltered');
    logState().actions.categoryFilter.secret(); await settle();
    logState().actions.actionFilter.all(); await settle();

    // 手动刷新失败与异常分支
    runtimeMock.sendMessage.mockResolvedValueOnce({success: false, error: 'denied'});
    logState().actions.refreshLog(); await settle();
    expect(root.querySelector('[data-privacy-log-error]')).not.toBeNull();

    runtimeMock.sendMessage.mockRejectedValueOnce(new Error('port closed'));
    logState().actions.refreshLog(); await settle();
    expect(root.querySelector('[data-privacy-log-error]')).not.toBeNull();

    // 二次确认清空：取消 -> 失败 -> 异常 -> 成功
    logState().actions.requestClearLog(); await settle();
    expect(root.querySelector('[data-privacy-log-clear-confirm]')).not.toBeNull();
    logState().actions.cancelClearLog(); await settle();
    expect(root.querySelector('[data-privacy-log-clear-confirm]')).toBeNull();

    logState().actions.requestClearLog(); await settle();
    runtimeMock.sendMessage.mockResolvedValueOnce({success: false, error: 'fail'});
    logState().actions.confirmClearLog(); await settle();
    expect(logState().logError).toBe(true);

    runtimeMock.sendMessage.mockRejectedValueOnce(new Error('fail'));
    logState().actions.confirmClearLog(); await settle();
    expect(logState().logError).toBe(true);

    runtimeMock.sendMessage.mockResolvedValueOnce({success: true, data: {cleared: true}});
    logState().actions.confirmClearLog(); await settle();
    expect(root.querySelector('[data-privacy-log-stats]')?.textContent).toBe('privacy.log.summaryEmpty');
    expect(root.querySelector('[data-privacy-log-empty]')?.textContent).toContain('privacy.log.empty');

    // 收起抽屉
    logState().actions.toggleLog({target: {open: false}} as unknown as Event); await settle();
    expect(logState().logOpen).toBe(false);
  });

  it('invalidates callbacks and discards stale async log responses on deactivation, config replacement, and unmount', async () => {
    let resolveQuery!: (value: unknown) => void;
    let resolveClear!: (value: unknown) => void;
    let rejectQuery!: (error: Error) => void;
    let rejectClear!: (error: Error) => void;
    const initial = new Config();
    initial.privacyProtection.enabled = true;
    runtimeMock.sendMessage.mockImplementationOnce(() => new Promise(resolve => {resolveQuery = resolve;}));

    const {props, state, logState, visible} = await mount(initial);
    // 失活丢弃旧 query 响应与错误
    props.active = false; await settle();
    resolveQuery({success: true, data: sampleSnapshot()});
    await settle();
    expect(logState().logSnapshot.stats.totalEvents).toBe(0);

    runtimeMock.sendMessage.mockImplementationOnce(() => new Promise((_resolve, reject) => {rejectQuery = reject;}));
    props.active = true; await settle();
    props.active = false; await settle();
    rejectQuery(new Error('late query error'));
    await settle();
    expect(logState().logError).toBe(false);

    // 重新激活并测试失活丢弃旧 clear 响应、旧 clear 错误以及并发 clear 保护
    runtimeMock.sendMessage.mockResolvedValueOnce({success: true, data: sampleSnapshot()});
    props.active = true; await settle();
    expect(logState().logSnapshot.stats.totalEvents).toBe(10);

    runtimeMock.sendMessage.mockImplementationOnce(() => new Promise(resolve => {resolveClear = resolve;}));
    logState().actions.requestClearLog();
    logState().actions.confirmClearLog();
    logState().actions.confirmClearLog(); // 并发清空时应被忽略
    props.active = false; await settle();
    resolveClear({success: true, data: {cleared: true}});
    await settle();
    expect(logState().logSnapshot.stats.totalEvents).toBe(10);

    runtimeMock.sendMessage.mockResolvedValueOnce({success: true, data: sampleSnapshot()});
    props.active = true; await settle();
    runtimeMock.sendMessage.mockImplementationOnce(() => new Promise((_resolve, reject) => {rejectClear = reject;}));
    logState().actions.requestClearLog();
    logState().actions.confirmClearLog();
    props.active = false; await settle();
    rejectClear(new Error('late clear error'));
    await settle();
    expect(logState().logError).toBe(false);

    // 配置替换与 KeepAlive 失活和卸载清理
    props.active = true;
    runtimeMock.sendMessage.mockResolvedValue({success: true, data: createEmptyPrivacyActivitySnapshot()});
    await settle();
    state().actions.manage(); await settle();
    const before = state().actions; props.config = new Config(); await settle(); before.enabled(true);
    expect(props.config.privacyProtection.enabled).toBe(false); expect(state().termsOpen).toBe(false);
    state().actions.manage(); await settle(); state().actions.draft('Unsaved');
    const deactivate = state().actions; visible.value = false; await settle(); deactivate.enabled(true);
    visible.value = true; await settle(); expect(state().termsDraft).toBe(''); expect(props.config.privacyProtection.enabled).toBe(false);
    const after = state().actions; app!.unmount(); app = undefined; after.enabled(true); expect(props.config.privacyProtection.enabled).toBe(false);
  });
});
