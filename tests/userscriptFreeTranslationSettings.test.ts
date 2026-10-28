import {afterEach, describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import * as vueRuntime from 'vue';
import SettingsPanel from '@/userscript/SettingsPanel.vue';
import {parseHTML} from 'linkedom';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {customModelString} from '@/src/core/config/catalog';

// 在 Vitest 管线内执行生产 SFC；存储、浏览器和子控件仍使用原有受控端口。
vi.mock('@/src/services/config/store', () => ({
    get config() {return (globalThis as any).__frUserscriptTimeoutSettings.config;},
    get configReady() {return (globalThis as any).__frUserscriptTimeoutSettings.readiness;},
    requestConfigPatch: (...args: unknown[]) => (globalThis as any).__frUserscriptTimeoutSettings.saved(...args),
    subscribeConfig: (...args: unknown[]) => (globalThis as any).__frUserscriptTimeoutSettings.subscribe(...args),
}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({t: (key: string) => key})}));
vi.mock('webextension-polyfill', () => ({default: {tabs: {sendMessage: (...args: unknown[]) => (globalThis as any).__frUserscriptTimeoutSettings.sent(...args)}}}));
vi.mock('element-plus', () => ({ElOption: {props: ['value','label'], setup: (props: any) => () => vueRuntime.h('option', {value: props.value}, props.label)}}));
vi.mock('@/src/ui/components/TranslationLoadingPreview.vue', () => ({default: {render: () => null}}));
vi.mock('@/src/ui/components/UiSelect.vue', async () => {
    const {h} = await import('vue');
    return {default: {inheritAttrs: false, props: ['modelValue', 'disabled'], emits: ['update:modelValue', 'change'],
        setup(props: any, {attrs, emit, slots}: any) {return () => h('span', [h('input', {...attrs, value: props.modelValue, disabled: props.disabled, 'data-select-port': '', onInput: (event: any) => {
            const value = typeof props.modelValue === 'number' ? Number(event.target.value) : event.target.value;
            emit('update:modelValue', value);emit('change', value);
        }}), h('span', {hidden: true}, slots.default?.())]);}}};
});

const source = readFileSync(resolve(process.cwd(), 'userscript/SettingsPanel.vue'), 'utf8');

describe('userscript free translation settings', () => {
    it('keeps narrow-screen fallback rows bounded and wrapped', () => {
        expect(source).toContain('.fallback-order-row { flex-wrap: wrap; }');
        expect(source).toContain('.fallback-order-row input[type=\'number\'] { flex: 1 1 96px; width: auto; }');
    });

    it('normalizes saved mode and selected fallback order without accepting user weights', () => {
        const normalized = normalizeConfig({
            service: 'freeTranslation',
            freeTranslationMode: 'unexpected',
            freeTranslationOrder: ['sogouFree', 'myMemory', 'myMemory', 'unknown'],
            freeTranslationWeights: {sogouFree: 99},
            // 首次升级插入 B站；下面再验证已升级配置保留用户关闭选择。
            freeTranslationBilibiliDefaultApplied: false,
        });
        expect(normalized.freeTranslationMode).toBe('balanced');
        expect(normalized.freeTranslationOrder).toEqual(['bilibiliFree', 'myMemory']);
        expect(normalized.freeTranslationBilibiliDefaultApplied).toBe(true);
        expect(normalized).not.toHaveProperty('freeTranslationWeights');
        expect(new Config().freeTranslationMode).toBe('balanced');

        const saved = normalizeConfig({
            ...normalized,
            freeTranslationOrder: ['unknown', 'sogouFree', null, 'microsoft', 'microsoft', 42],
        });
        expect(saved.freeTranslationOrder).toEqual(['microsoft']);
    });
});

const fixtureKey = '__frUserscriptTimeoutSettings';
let timeoutApp: import('vue').App | undefined;
const saveReleases: Array<() => void> = [];
function pendingSave() {
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => {resolve = yes;reject = no;});
    saveReleases.push(resolve);
    return {promise, resolve, reject};
}
async function settleSettings() {
    for (let index = 0; index < 16; index++) await Promise.resolve();
    await vueRuntime.nextTick();await vueRuntime.nextTick();
}
async function editSetting(label: string, value: string | boolean): Promise<void> {
    const row = [...document.querySelectorAll('label')].find(item => item.querySelector('span')?.textContent === label);
    const input = row?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea');
    expect(input, label).toBeTruthy();
    if (typeof value === 'boolean') {
        (input as HTMLInputElement).checked = value;
        input!.dispatchEvent(new window.Event('change', {bubbles: true}));
    } else {input!.value = value;input!.dispatchEvent(new window.Event('input', {bubbles: true}));}
    await settleSettings();
}
async function pressSetting(text: string): Promise<void> {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === text)!;
    expect(button, text).toBeTruthy();expect(button.hasAttribute('disabled'), text).toBe(false);
    button.dispatchEvent(new window.Event('click', {bubbles: true}));await settleSettings();
}
afterEach(async () => {
    timeoutApp?.unmount();timeoutApp = undefined;
    for (const release of saveReleases.splice(0)) release();
    await settleSettings();
    delete (globalThis as Record<string, unknown>)[fixtureKey];
    vi.unstubAllGlobals();
});

async function mountCompactSettings(initial: Partial<Config> = {}, readiness: Promise<void> = Promise.resolve()) {
    const dom = parseHTML('<html><body><main id="settings"></main></body></html>');
    vi.stubGlobal('document', dom.document);
    vi.stubGlobal('window', Object.assign(dom.window, {matchMedia: () => ({matches: false})}));
    vi.stubGlobal('HTMLInputElement', dom.window.HTMLInputElement);
    const authority = normalizeConfig(initial);
    const listeners = new Set<(snapshot: Config) => void>();
    const broadcast = (value: Config) => {
        Object.assign(authority, normalizeConfig(value));
        for (const listener of listeners) listener(normalizeConfig(authority));
    };
    const saved = vi.fn(async (snapshot: Config) => {broadcast(snapshot);});
    const sent = vi.fn(async (_tab: number, _message: {type: string; isEnabled?: boolean; mode?: string}): Promise<unknown> => ({status: 'success'}));
    const subscribe = (listener: (snapshot: Config) => void) => {listeners.add(listener);return () => {listeners.delete(listener);};};
    (globalThis as Record<string, unknown>)[fixtureKey] = {config: authority, saved, sent, subscribe, readiness};
    const component = SettingsPanel;
    const renderer = vueRuntime.createRenderer({patchProp(element: any, name, previous: any, next: any) {
        if (name === 'value') {element.value = next ?? '';return;}
        if (name === 'checked') {element.checked = !!next;return;}
        if (/^on[A-Z]/u.test(name)) {
            const event = name.slice(2).toLowerCase();
            if (previous) element.removeEventListener(event, previous);
            if (next) element.addEventListener(event, next);
        } else if (next === undefined || next === null || next === false) element.removeAttribute(name);
        else element.setAttribute(name, String(next));
    }, insert: (child: any, parent: any, anchor: any = null) => parent.insertBefore(child, anchor),
    remove: (node: any) => node.parentNode?.removeChild(node), createElement: name => dom.document.createElement(name),
    createText: value => dom.document.createTextNode(value), createComment: value => dom.document.createComment(value),
    setText: (node: any, value) => {node.nodeValue = value;}, setElementText: (node: any, value) => {node.textContent = value;},
    parentNode: (node: any) => node.parentNode, nextSibling: (node: any) => node.nextSibling,
    querySelector: value => dom.document.querySelector(value), setScopeId: () => {}, cloneNode: (node: any) => node.cloneNode(true),
    insertStaticContent: (content, parent: any, anchor) => {
        const fragment = dom.document.createElement('template');fragment.innerHTML = content;
        const first = fragment.content.firstChild, last = fragment.content.lastChild;
        parent.insertBefore(fragment.content, anchor);return [first, last];
    }});
    let state!: Record<string, any>;
    const closed = vi.fn(), errors: unknown[] = [];
    timeoutApp = renderer.createApp({setup: () => () => vueRuntime.h(component, {onClose: closed, ref: (vm: any) => {if (vm) state = vm.$.setupState;}})});
    timeoutApp.provide(vueRuntime.ssrContextKey, {modules: new Set<string>()});timeoutApp.config.warnHandler = () => {};
    timeoutApp.config.errorHandler = error => {errors.push(error);};
    timeoutApp.mount(dom.document.querySelector('#settings')!);
    await settleSettings();
    const input = () => dom.document.querySelector('[data-testid="ai-request-timeout-settings"] input') as unknown as HTMLInputElement;
    const type = async (value: string) => {input().value = value;input().dispatchEvent(new dom.window.Event('input', {bubbles: true}));await vueRuntime.nextTick();};
    const confirm = async (event = 'change') => {input().dispatchEvent(new dom.window.Event(event, {bubbles: true}));await vueRuntime.nextTick();};
    const control = (label: string) => dom.document.querySelector(`[aria-label="${label}"]`) as unknown as HTMLInputElement;
    const change = async (label: string, value: string) => {
        control(label).value = value;
        control(label).dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        await settleSettings();
    };
    const restore = async () => {
        const button = [...dom.document.querySelectorAll('button')].find(item => item.textContent === '恢复默认')!;
        button.dispatchEvent(new dom.window.Event('click', {bubbles: true}));await settleSettings();
    };
    const unmount = () => {timeoutApp?.unmount();timeoutApp = undefined;};
    return {state, saved, sent, authority, broadcast, listeners, input, type, confirm, control, change, restore, unmount, closed, errors};
}

describe('userscript color preset selection', () => {
    it('clears old color overrides only on a real preset choice while preserving fonts, saving and external hydration', async () => {
        const appearance = {...new Config().translationAppearance, textColor: '#ef4776', fontScale: 117,
            fontWeight: 'bold' as const, fontFamily: 'serif' as const,
            customCss: 'color: pink; -webkit-text-fill-color: pink; font-size: 123%; border-radius: 6px'};
        const fixture = await mountCompactSettings({style: 54, translationAppearance: appearance, activeTranslationStyleProfileId: 'previous-profile'});
        expect(fixture.state.draft.translationAppearance.textColor).toBe('#ef4776');
        await fixture.change('双语样式', '49');
        expect(fixture.state.draft.style).toBe(49);
        expect(fixture.state.draft.translationAppearance).toMatchObject({textColor: '', fontScale: 117, fontWeight: 'bold', fontFamily: 'serif',
            customCss: ' font-size: 123%; border-radius: 6px'});
        expect(fixture.state.draft.activeTranslationStyleProfileId).toBe('');
        await pressSetting('保存设置');
        expect(fixture.saved).toHaveBeenCalledOnce();
        expect(fixture.authority.style).toBe(49);
        expect(fixture.authority.translationAppearance).toEqual(fixture.state.draft.translationAppearance);
        const selectedAppearance = JSON.parse(JSON.stringify(fixture.state.draft.translationAppearance));
        await fixture.change('双语样式', '6');
        expect(fixture.state.draft.translationAppearance).toEqual(selectedAppearance);
        fixture.state.selectTranslationStyle('invalid');
        expect(fixture.state.draft.style).toBe(6);
        fixture.state.selectTranslationStyle('55');
        expect(fixture.state.draft.style).toBe(55);
        await pressSetting('保存设置');
        fixture.broadcast(normalizeConfig({...fixture.authority, style: 54, translationAppearance: appearance}));
        await settleSettings();
        expect(fixture.state.draft.style).toBe(54);
        expect(fixture.state.draft.translationAppearance).toEqual(appearance);
        expect(fixture.errors).toEqual([]);
    });
});

describe('userscript AI timeout actual input', () => {
    it('keeps each typed digit until confirmation, permits clear and retype, and saves milliseconds', async () => {
        const fixture = await mountCompactSettings();
        expect(fixture.input().value).toBe('120');
        for (const value of ['3', '30', '300']) {
            await fixture.type(value);
            expect(fixture.input().value).toBe(value);
            expect(fixture.state.draft.aiRequestTimeoutMs).toBe(120_000);
        }
        await fixture.confirm();
        expect(fixture.state.draft.aiRequestTimeoutMs).toBe(300_000);
        for (const value of ['', '6', '60', '600']) {
            await fixture.type(value);expect(fixture.input().value).toBe(value);
        }
        await fixture.state.save();
        expect(fixture.saved).toHaveBeenCalledWith(expect.objectContaining({aiRequestTimeoutMs: 600_000}));
        expect(fixture.state.draft.aiRequestTimeoutMs).toBe(600_000);
    });

    it('bounds only on blur, retains the saved value for empty input, and rejects stale draft callbacks', async () => {
        const fixture = await mountCompactSettings();
        await fixture.type('3');expect(fixture.input().value).toBe('3');await fixture.confirm('blur');
        expect(fixture.input().value).toBe('10');expect(fixture.state.draft.aiRequestTimeoutMs).toBe(10_000);
        await fixture.type('900');await fixture.confirm('blur');
        expect(fixture.input().value).toBe('600');expect(fixture.state.draft.aiRequestTimeoutMs).toBe(600_000);
        await fixture.type('');await fixture.confirm();
        expect(fixture.input().value).toBe('600');expect(fixture.state.draft.aiRequestTimeoutMs).toBe(600_000);
        const staleCommit = fixture.state.aiRequestTimeoutActions.commit;
        fixture.state.restoreDefaults();await vueRuntime.nextTick();
        await fixture.type('300');staleCommit();
        expect(fixture.state.draft.aiRequestTimeoutMs).toBe(120_000);
        fixture.state.restoreDefaults();await vueRuntime.nextTick();
        expect(fixture.input().value).toBe('120');
        await fixture.type('400');
        const currentCommit = fixture.state.aiRequestTimeoutActions.commit;
        timeoutApp!.unmount();timeoutApp = undefined;
        currentCommit();expect(fixture.state.draft.aiRequestTimeoutMs).toBe(120_000);
    });
});


describe('compact userscript shared model editing', () => {
    it('rechecks the model limit when another settings surface fills the last slot while the add form is open', async () => {
        const initial = initialCompactConfig();
        initial.customModels.deepseek = ['base-model', ...Array.from({length: 48}, (_, i) => `saved-${i}`)];
        const fixture = await mountCompactSettings(initial);
        const button = (text: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === text)!;
        button('+ 添加模型').dispatchEvent(new window.Event('click', {bubbles: true}));await settleSettings();
        const input = document.querySelector('input[placeholder="输入模型标识"]') as HTMLInputElement;
        input.value = 'pending-model';input.dispatchEvent(new window.Event('input', {bubbles: true}));await settleSettings();
        const external = normalizeConfig(initial);
        external.customModels.deepseek.push('external-last-slot');
        fixture.broadcast(external);await settleSettings();
        button('添加').dispatchEvent(new window.Event('click', {bubbles: true}));await settleSettings();
        expect(fixture.state.draft.customModels.deepseek).toEqual(external.customModels.deepseek);
        expect(fixture.state.draft.customModel.deepseek).toBe('base-model');
        expect(fixture.state.draft.modelThinking.deepseek?.['pending-model']).toBeUndefined();
        expect(document.querySelector('.model-add-error')?.textContent).toContain('50');
    });

    it('removes the current custom model through the visible button and clears its request preferences before saving', async () => {
        const fixture = await mountCompactSettings();
        const draft = fixture.state.draft;
        draft.service = 'deepseek'; draft.customModels.deepseek = ['obsolete-model', 'retained-model'];
        draft.model.deepseek = '自定义模型'; draft.customModel.deepseek = 'obsolete-model';
        draft.documentModel.deepseek = '自定义模型'; draft.documentCustomModel.deepseek = 'obsolete-model';
        draft.modelRequestLimits.deepseek = {'obsolete-model': {enabled: true, limits: {maxConcurrentTranslations: 1, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0}}};
        await vueRuntime.nextTick();
        const remove = document.querySelector('button.inline-action.is-danger');
        expect(remove).not.toBeNull();
        remove!.dispatchEvent(new window.Event('click', {bubbles: true})); await vueRuntime.nextTick();
        expect(draft.customModels.deepseek).toEqual(['retained-model']);
        expect(draft.customModel.deepseek).toBe('retained-model'); expect(draft.documentCustomModel.deepseek).toBe('retained-model');
        expect(draft.modelRequestLimits.deepseek).toBeUndefined();
        await fixture.state.save(); expect(fixture.saved).toHaveBeenCalledOnce();
        expect(fixture.saved.mock.calls[0][0].modelRequestLimits.deepseek).toBeUndefined();
    });
});

function initialCompactConfig(): Config {
    return normalizeConfig({to: 'es', service: 'deepseek', theme: 'light',
        model: {deepseek: customModelString}, customModel: {deepseek: 'base-model'},
        customModels: {deepseek: ['base-model', 'first-model', 'later-model']}});
}

describe('compact userscript manual save ownership in the actual SFC', () => {
    it.each((['success', 'failure'] as const).flatMap(outcome =>
        (['language', 'model', 'defaults'] as const).map(edit => ({outcome, edit})),
    ))('retains the later $edit draft after an older save $outcome and establishes the next baseline', async ({outcome, edit}) => {
        const fixture = await mountCompactSettings(initialCompactConfig());
        const baseline = normalizeConfig(fixture.authority);
        await fixture.change('目标语言', 'de');await fixture.change('模型', 'first-model');
        const gate = pendingSave();fixture.saved.mockReturnValueOnce(gate.promise);
        const saving = fixture.state.save();await settleSettings();
        expect(fixture.saved).toHaveBeenCalledOnce();expect(fixture.state.saving).toBe(true);
        // 模拟真实 patch 端口在 ACK 前发出的乐观快照；editor 仍持有在途字段。
        fixture.broadcast(fixture.saved.mock.calls[0][0]);await settleSettings();
        expect(fixture.control('目标语言').hasAttribute('disabled')).toBe(false);
        expect(fixture.control('模型').hasAttribute('disabled')).toBe(false);
        if (edit === 'language') await fixture.change('目标语言', 'ja');
        if (edit === 'model') await fixture.change('模型', 'later-model');
        if (edit === 'defaults') await fixture.restore();
        const laterDraft = normalizeConfig(fixture.state.draft);
        const restoreFeedback = fixture.state.status;
        await fixture.state.save();expect(fixture.saved).toHaveBeenCalledOnce();
        if (outcome === 'success') gate.resolve();
        else {
            // requestConfigPatch 在拒绝前已回读权威；此处只控制这个已有端口契约。
            fixture.broadcast(baseline);gate.reject(new Error('fixture persistence failed'));
        }
        await saving;await settleSettings();
        expect(normalizeConfig(fixture.state.draft)).toEqual(laterDraft);
        expect(fixture.control('目标语言').value).toBe(laterDraft.to);
        if (edit === 'model') expect(fixture.control('模型').value).toBe('later-model');
        expect(fixture.state.saving).toBe(false);
        if (edit === 'defaults') {
            expect(fixture.state.status).toBe(restoreFeedback);expect(fixture.state.statusIsError).toBe(false);
        } else if (outcome === 'failure') expect(fixture.state.status).toContain('fixture persistence failed');
        await fixture.state.save();await settleSettings();
        expect(fixture.saved).toHaveBeenCalledTimes(2);
        expect(fixture.saved.mock.calls[1][0]).toEqual(laterDraft);
        expect(fixture.state.statusIsError).toBe(false);
        expect(fixture.state.status).toContain('本次提交已保存');
        // 成功后无变化保存只重新应用页面，不把已确认字段当成脏草稿再次持久化。
        await fixture.state.save();expect(fixture.saved).toHaveBeenCalledTimes(2);
    });

    it('does not auto-save edits, applies only the accepted runtime snapshot, and re-applies unchanged settings', async () => {
        const fixture = await mountCompactSettings(initialCompactConfig());
        fixture.state.draft.on = false;await settleSettings();expect(fixture.saved).not.toHaveBeenCalled();
        const gate = pendingSave();fixture.saved.mockReturnValueOnce(gate.promise);
        const saving = fixture.state.save();await settleSettings();
        fixture.broadcast(fixture.saved.mock.calls[0][0]);fixture.state.draft.on = true;await settleSettings();
        gate.resolve();await saving;
        expect(fixture.state.draft.on).toBe(true);
        expect(fixture.sent.mock.calls.map(([, message]) => message)).toEqual([{type: 'reconcileUserscriptPage'}]);
        await fixture.state.save();expect(fixture.authority.on).toBe(true);
        fixture.sent.mockClear();await fixture.state.save();
        expect(fixture.saved).toHaveBeenCalledTimes(2);
        expect(fixture.sent.mock.calls.map(([, message]) => message.type))
            .toEqual(['reconcileUserscriptPage']);
    });

    it.each(['unavailable', 'rejected'])('页面应用 %s 时已保存状态与页面应用结果分别提示', async outcome => {
        const fixture = await mountCompactSettings(initialCompactConfig());
        if (outcome === 'unavailable') fixture.sent.mockResolvedValueOnce({status: 'failed'});
        else fixture.sent.mockRejectedValueOnce(new Error('controlled page failure'));
        fixture.state.draft.on = false; await settleSettings();
        await fixture.state.save(); await settleSettings();
        expect(fixture.saved).toHaveBeenCalledOnce(); expect(fixture.authority.on).toBe(false);
        expect(fixture.state.status).toContain('设置已保存');
        expect(fixture.state.status).toContain('应用状态未确认');
        expect(fixture.state.statusIsError).toBe(true);
        expect(fixture.sent.mock.calls.map(([, message]) => message)).toEqual([{type: 'reconcileUserscriptPage'}]);
    });

    it('页面协调未结束时及时提示未确认，迟到回复不更改结果', async () => {
        const fixture = await mountCompactSettings(initialCompactConfig());
        vi.useFakeTimers();
        try {
            const gate = pendingSave(); fixture.sent.mockReturnValueOnce(gate.promise);
            fixture.state.draft.on = false; await settleSettings();
            const saving = fixture.state.save(); await settleSettings();
            await vi.advanceTimersByTimeAsync(2000); await saving;
            expect(fixture.state.status).toContain('设置已保存');
            expect(fixture.state.status).toContain('应用状态未确认');
            expect(fixture.state.statusIsError).toBe(true);
            gate.resolve(); await settleSettings();
            expect(fixture.state.status).toContain('应用状态未确认');
        } finally {vi.useRealTimers();}
    });

    it('adopts external untouched fields while preserving pending and later edits without making a request', async () => {
        const fixture = await mountCompactSettings(initialCompactConfig());
        await fixture.change('目标语言', 'fr');
        const gate = pendingSave();fixture.saved.mockReturnValueOnce(gate.promise);
        const saving = fixture.state.save();await settleSettings();
        fixture.broadcast(fixture.saved.mock.calls[0][0]);
        fixture.broadcast(normalizeConfig({...fixture.authority, to: 'ja', theme: 'dark'}));
        await fixture.change('目标语言', 'de');
        expect(fixture.state.draft.theme).toBe('dark');expect(fixture.saved).toHaveBeenCalledOnce();
        gate.resolve();await saving;expect(fixture.state.draft.to).toBe('de');
        await fixture.state.save();expect(fixture.saved.mock.calls[1][0]).toMatchObject({to: 'de', theme: 'dark'});
    });

    it.each(['edit-success', 'edit-failure', 'restore-success', 'restore-failure'])('ignores unchanged reapply feedback superseded by %s', async scenario => {
        const h = await mountCompactSettings(initialCompactConfig());
        const gate = pendingSave();h.sent.mockReturnValueOnce(gate.promise);
        const saving = h.state.save();await settleSettings();expect(h.saved).not.toHaveBeenCalled();
        if (scenario.startsWith('edit')) await h.change('目标语言', 'de');else await h.restore();
        const status = h.state.status;
        if (scenario.endsWith('failure')) gate.reject(new Error('obsolete page application'));else gate.resolve();
        await saving;expect(h.state.status).toBe(status);expect(h.state.statusIsError).toBe(false);
    });

    it.each([new Error('current application failed'), 'current application failed'])('reports a current unchanged apply failure and retries without extra persistence: %s', async failure => {
        const h = await mountCompactSettings(initialCompactConfig());h.sent.mockRejectedValueOnce(failure);
        await h.state.save();expect(h.state.status).toContain('设置已保存');expect(h.state.status).toContain('应用状态未确认');expect(h.state.statusIsError).toBe(true);expect(h.saved).not.toHaveBeenCalled();
        await h.state.save();expect(h.state.status).toContain('本次提交已保存');expect(h.state.statusIsError).toBe(false);expect(h.saved).not.toHaveBeenCalled();
    });

    it('retries a failed page application with the saved authority and keeps a newer draft', async () => {
        const fixture = await mountCompactSettings(initialCompactConfig());
        await fixture.change('目标语言', 'fr');fixture.sent.mockRejectedValueOnce(new Error('page channel unavailable'));
        await fixture.state.save();
        expect(fixture.state.status).toContain('设置已保存');expect(fixture.state.status).toContain('应用状态未确认');expect(fixture.state.draft.to).toBe('fr');
        await fixture.state.save();expect(fixture.saved).toHaveBeenCalledOnce();
        expect(fixture.state.statusIsError).toBe(false);expect(fixture.state.status).toContain('本次提交已保存');
    });

    it.each(['success', 'failure'] as const)('disposes its subscription and ignores late %s feedback or page commands after unmount', async outcome => {
        const fixture = await mountCompactSettings(initialCompactConfig());
        await fixture.change('目标语言', 'fr');const gate = pendingSave();fixture.saved.mockReturnValueOnce(gate.promise);
        const saving = fixture.state.save();await settleSettings();expect(fixture.listeners.size).toBe(1);
        fixture.unmount();const draft = normalizeConfig(fixture.state.draft), status = fixture.state.status;
        expect(fixture.listeners.size).toBe(0);fixture.broadcast(normalizeConfig({...fixture.authority, to: 'ja'}));
        if (outcome === 'success') gate.resolve();else gate.reject(new Error('late persistence failure'));
        await saving;await settleSettings();
        expect(normalizeConfig(fixture.state.draft)).toEqual(draft);expect(fixture.state.status).toBe(status);
        expect(fixture.sent).not.toHaveBeenCalled();expect(fixture.state.saving).toBe(false);
        await fixture.state.save();expect(fixture.saved).toHaveBeenCalledOnce();
    });

    it('does not hydrate a closed instance and reports readiness failures without enabling edits', async () => {
        const first = pendingSave(), fixture = await mountCompactSettings(initialCompactConfig(), first.promise);
        expect(fixture.state.hydrated).toBe(false);await fixture.state.save();fixture.state.restoreDefaults();
        expect(fixture.saved).not.toHaveBeenCalled();fixture.unmount();first.resolve();await settleSettings();
        expect(fixture.state.hydrated).toBe(false);
        const failed = pendingSave(), second = await mountCompactSettings(initialCompactConfig(), failed.promise);
        failed.reject(new Error('read unavailable'));await settleSettings();
        expect(second.state.hydrated).toBe(false);expect(second.state.statusIsError).toBe(true);
        expect(second.state.status).toContain('read unavailable');expect(second.saved).not.toHaveBeenCalled();
    });
});

describe('compact userscript real settings controls', () => {
    it('changes fallback order only in sequential mode, keeps one provider and can re-enable an omitted provider', async () => {
        const h = await mountCompactSettings({service:'freeTranslation',freeTranslationOrder:['sogouFree','microsoft','google'],freeTranslationBilibiliDefaultApplied:true});
        expect(h.state.draft.freeTranslationOrder).toEqual(['microsoft','google']);
        expect(document.body.textContent).not.toContain('搜狗翻译');
        expect(document.querySelector('[aria-label="下移 微软翻译"]')).toBeNull();
        const mode = document.querySelector<HTMLSelectElement>('[aria-label="免费翻译选择模式"]')!;
        for(const option of mode.options) option.selected=option.value==='sequential';mode.dispatchEvent(new window.Event('change',{bubbles:true}));await settleSettings();
        expect(h.state.draft.freeTranslationMode).toBe('sequential');
        document.querySelector<HTMLButtonElement>('[aria-label="下移 微软翻译"]')!.click();await settleSettings();expect(h.state.draft.freeTranslationOrder).toEqual(['google','microsoft']);
        document.querySelector<HTMLButtonElement>('[aria-label="上移 微软翻译"]')!.click();await settleSettings();expect(h.state.draft.freeTranslationOrder).toEqual(['microsoft','google']);
        document.querySelector<HTMLButtonElement>('.fallback-order-row button:last-child')!.click();await settleSettings();
        expect(h.state.draft.freeTranslationOrder).toEqual(['google']);expect(document.querySelector('.fallback-order-row button:last-child')!.hasAttribute('disabled')).toBe(true);
        const omitted=[...document.querySelectorAll('label')].find(label=>label.querySelector('span')?.textContent==='微软翻译')!;
        omitted.querySelector<HTMLButtonElement>('button')!.click();await settleSettings();
        await editSetting('MyMemory 邮箱（可选）','reader@example.test');await editSetting('每路超时（ms）','7000');await pressSetting('保存设置');
        expect(h.saved.mock.calls[0][0]).toMatchObject({freeTranslationMode:'sequential',freeTranslationOrder:['google','microsoft'],freeTranslationTimeoutMs:7000,myMemoryEmail:'reader@example.test'});
        expect(document.body.textContent).not.toContain('freeTranslationWeights');expect(h.errors).toEqual([]);
    });

    it('edits an OpenAI-compatible connection and request preferences without changing another profile', async () => {
        const providers=[{id:'custom:reader',name:'Reader',endpoint:'https://reader.example.test/v1',models:['reader-a','reader-b']},{id:'custom:other',name:'Other',endpoint:'https://other.example.test/v1',models:['other-a']}];
        const h=await mountCompactSettings({service:'custom:reader',customOpenAIProviders:providers});
        await editSetting('自定义接口地址','https://changed.example.test/v1');await editSetting('API Key / Token','fixture-token');await editSetting('代理地址（可选）','https://proxy.example.test/v1');
        await h.change('模型','reader-b');await editSetting('当前模型需要 API Key',false);await editSetting('当前模型 Thinking（仅在已适配接口生效，默认关闭）',true);await editSetting('AI 网页上下文',true);
        await editSetting('自定义请求体（JSON）','{"temperature":0.2}');await editSetting('System 提示词','Reader system');await editSetting('User 提示词','Reader {{origin}}');
        await h.change('段落加载样式','none');await pressSetting('保存设置');
        const saved=h.saved.mock.calls[0][0];expect(saved.customOpenAIProviders).toEqual([{...providers[0],endpoint:'https://changed.example.test/v1'},providers[1]]);
        expect(saved.model['custom:reader']).toBe('reader-b');expect(saved.token['custom:reader']).toBe('fixture-token');expect(saved.proxy['custom:reader']).toBe('https://proxy.example.test/v1');
        expect(saved.modelThinking['custom:reader']?.['reader-b']).toBe(true);expect(saved.enableAIContext).toBe(true);
        expect(saved.customBody['custom:reader']).toBe('{"temperature":0.2}');expect(saved.system_role['custom:reader']).toBe('Reader system');expect(saved.user_role['custom:reader']).toBe('Reader {{origin}}');
        expect(h.errors).toEqual([]);
    });

    it.each(['deepseek','custom:reader'] as const)('validates and adds a model through the %s form, then removes it', async service => {
        const h=await mountCompactSettings({service,customOpenAIProviders:[{id:'custom:reader',name:'Reader',endpoint:'https://reader.example.test/v1',models:['reader-a']},{id:'custom:untouched',name:'Untouched',endpoint:'https://untouched.example.test/v1',models:['untouched-model']}]});
        await pressSetting('+ 添加模型');await pressSetting('添加');expect(document.querySelector('.model-add-error')?.textContent).toContain('请输入模型标识');
        const type=async(value:string)=>{const input=document.querySelector<HTMLInputElement>('[placeholder="输入模型标识"]')!;input.value=value;input.dispatchEvent(new window.Event('input',{bubbles:true}));await settleSettings();};
        await type('自定义模型');await pressSetting('添加');expect(document.querySelector('.model-add-error')?.textContent).toContain('保留名称');
        await type(h.control('模型').value);await pressSetting('添加');expect(document.querySelector('.model-add-error')?.textContent).toContain('已经存在');
        await type('new-user-model');await pressSetting('添加');expect(h.control('模型').value).toBe('new-user-model');expect(document.querySelector('.model-add-error')).toBeNull();
        await pressSetting('保存设置');const saved=h.saved.mock.calls[0][0];
        if(service==='deepseek') expect(saved.customModels.deepseek).toContain('new-user-model');else expect(saved.customOpenAIProviders[0].models).toContain('new-user-model');
        await pressSetting(service==='deepseek'?'删除当前自定义模型':'删除当前模型');expect(h.control('模型').value).not.toBe('new-user-model');
        await pressSetting('+ 添加模型');await pressSetting('取消');expect(document.querySelector('[placeholder="输入模型标识"]')).toBeNull();
        expect(h.errors).toEqual([]);
    });

    it('retains legacy custom endpoint mirroring, DeepL plan and paired service credentials', async () => {
        const h=await mountCompactSettings({service:'custom'});await editSetting('自定义接口地址','https://legacy.example.test/v1');
        await h.change('服务','deepL');await h.change('DeepL API 套餐','pro');await h.change('服务','youdao');await editSetting('有道 App Secret','fixture-youdao-secret');
        await h.change('服务','tencent');await editSetting('腾讯 Secret Key','fixture-tencent-key');await pressSetting('保存设置');
        expect(h.saved.mock.calls[0][0]).toMatchObject({custom:'https://legacy.example.test/v1',deeplApiPlan:'pro',youdaoAppSecret:'fixture-youdao-secret',tencentSecretKey:'fixture-tencent-key'});
        expect(h.errors).toEqual([]);
    });
    it('persists the edited page controls and request budget together only after Save', async () => {
        const h = await mountCompactSettings({service: 'microsoft'});
        for (const [label, value] of [['启用流畅阅读',false],['打开网页后自动翻译',true],['使用翻译缓存',false],['显示全文翻译悬浮球',false],['显示翻译进度面板',false]] as const) await editSetting(label,value);
        for (const [label,value] of [['源语言','en'],['目标语言','fr'],['译文显示','0'],['双语样式','2'],['全文快捷键','Alt+A'],['全文翻译范围','all'],['悬浮翻译触发','Shift'],['划词翻译','translation-only'],['划词触发','icon'],['主题','dark']] as const) await h.change(label,value);
        for (const [label,value] of [['并发翻译数','4'],['每秒最多请求（0=不限）','2'],['每分钟最多请求（0=不限）','90'],['失败后最多重试','3'],['退避初始间隔（ms）','500'],['退避最大间隔（ms）','5000']] as const) await editSetting(label,value);
        expect(h.saved).not.toHaveBeenCalled();expect(h.authority.on).toBe(true);
        await pressSetting('保存设置');
        expect(h.saved).toHaveBeenCalledOnce();expect(h.saved.mock.calls[0][0]).toMatchObject({on:false,autoTranslate:true,useCache:false,disableFloatingBall:true,translationProgressPanelEnabled:false,
            from:'en',to:'fr',display:0,style:2,floatingBallHotkey:'Alt+A',fullPageTranslationMode:'all',hotkey:'Shift',selectionTranslatorMode:'translation-only',selectionTranslatorTrigger:'icon',theme:'dark',
            maxConcurrentTranslations:4,translationRequestsPerSecond:2,translationRequestsPerMinute:90,translationMaxRetries:3,translationBackoffBaseMs:500,translationBackoffMaxMs:5000});
        expect(document.querySelector('.fr-userscript-settings-backdrop')?.classList.contains('dark')).toBe(true);expect(h.errors).toEqual([]);
    });

    it('keeps the input translator service, model, interval and prompts independent from the page service', async () => {
        const h = await mountCompactSettings({service:'microsoft'});
        await h.change('输入框翻译触发方式','triple_equal');await editSetting('三击间隔（毫秒）','350');
        await h.change('输入框目标语言','ja');await h.change('输入框翻译服务','deepseek');await editSetting('输入框翻译模型','deepseek-chat');
        await editSetting('系统提示词','Input system');await editSetting('翻译提示词','Translate {{origin}} to {{to}}');
        await pressSetting('保存设置');
        expect(h.saved.mock.calls[0][0]).toMatchObject({service:'microsoft',inputBoxTranslationTrigger:'triple_equal',inputBoxTranslationInterval:350,inputBoxTranslationTarget:'ja',inputBoxTranslationService:'deepseek',inputBoxTranslationModel:'deepseek-chat',inputBoxTranslationSystemPrompt:'Input system',inputBoxTranslationPrompt:'Translate {{origin}} to {{to}}'});
        await pressSetting('恢复默认间隔');await pressSetting('恢复默认系统提示词');await pressSetting('恢复默认翻译提示词');
        await h.change('输入框翻译服务','microsoft');expect(h.state.draft.inputBoxTranslationModel).toBe('');
        await pressSetting('保存设置');expect(h.saved.mock.calls[1][0]).toMatchObject({inputBoxTranslationInterval:1000,inputBoxTranslationSystemPrompt:'',inputBoxTranslationPrompt:'',inputBoxTranslationService:'microsoft',inputBoxTranslationModel:''});
    });

    it.each([
        ['deeplx','DeepLX 地址','deeplx','https://translate.example.test'],
        ['newapi','New API 地址','newApiUrl','https://newapi.example.test/v1'],
        ['azureOpenai','Azure 地址','azureOpenaiEndpoint','https://fixture.services.ai.azure.com/openai/v1/'],
        ['myMemory','MyMemory 邮箱（可选）','myMemoryEmail','reader@example.test'],
        ['youdao','有道 App Key','youdaoAppKey','fixture-key'],
        ['tencent','腾讯 Secret ID','tencentSecretId','fixture-id'],
    ] as const)('stores the %s connection form in its own configuration field', async (service,label,field,value) => {
        const h = await mountCompactSettings({service});await editSetting(label,`  ${value}  `);await pressSetting('保存设置');
        expect(h.saved.mock.calls[0][0][field]).toBe(value);expect(h.saved.mock.calls[0][0].service).toBe(service);expect(h.errors).toEqual([]);
    });

    it('shows a page-action failure and allows a retry instead of emitting an unhandled component error', async () => {
        const h = await mountCompactSettings();h.sent.mockRejectedValueOnce(new Error('page action failed'));
        await pressSetting('翻译 / 恢复当前页');
        expect(h.errors).toEqual([]);expect(document.querySelector('.status.error')?.textContent).toContain('page action failed');expect(h.closed).not.toHaveBeenCalled();
        await pressSetting('翻译 / 恢复当前页');expect(h.closed).toHaveBeenCalledOnce();
    });

    it('prevents a second toggle while its first page action is pending', async () => {
        const h = await mountCompactSettings();const pending = pendingSave();h.sent.mockReturnValueOnce(pending.promise);
        await pressSetting('翻译 / 恢复当前页');
        const button = [...document.querySelectorAll('button')].find(item=>item.textContent?.trim()==='翻译 / 恢复当前页')!;
        expect(button.hasAttribute('disabled')).toBe(true);expect(h.sent).toHaveBeenCalledOnce();
        pending.resolve();await settleSettings();expect(h.closed).toHaveBeenCalledOnce();
    });

    it.each((['edit','save','unmount'] as const).flatMap(action => (['success','failure'] as const).map(outcome=>({action,outcome}))))
    ('keeps a late page-action $outcome from replacing a newer $action or closing its editor', async ({action,outcome}) => {
        const h = await mountCompactSettings();const pending = pendingSave();h.sent.mockReturnValueOnce(pending.promise);
        await pressSetting('翻译 / 恢复当前页');
        if (action==='edit') await h.change('目标语言','ja');
        if (action==='save') {await h.change('目标语言','fr');await pressSetting('保存设置');}
        if (action==='unmount') h.unmount();
        const status=h.state.status;
        if(outcome==='success') pending.resolve();else pending.reject(new Error('obsolete page action'));
        await settleSettings();expect(h.state.status).toBe(status);expect(h.closed).not.toHaveBeenCalled();expect(h.errors).toEqual([]);
        if(action==='edit') expect(h.state.draft.to).toBe('ja');
        if(action==='save') expect(h.authority.to).toBe('fr');
    });
});
