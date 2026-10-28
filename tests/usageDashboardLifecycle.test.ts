import * as runtime from 'vue';
import {parseHTML} from 'linkedom';
import {buildModelUsageDashboard} from '@/src/services/model-usage/aggregation';
import {buildTranslationStatsSnapshot, createTranslationStatsRollup, foldTranslationRequestEvent, createTranslationRouteRollup, foldTranslationRouteAttempt} from '@/src/services/translation-stats/aggregation';
import type {StoredModelUsageEvent} from '@/src/services/model-usage/types';
import type {StoredTranslationRequestEvent} from '@/src/services/translation-stats/types';
import ModelUsageDashboard from '@/src/features/model-usage/ui/ModelUsageDashboard.vue';
import TranslationStatsDashboard from '@/src/features/translation-stats/ui/TranslationStatsDashboard.vue';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// 挂载两个实际统计 SFC，验证数字规则、模板交互、迟到消息与缓存页面切换。
// 数据经真实聚合器生成；仅替换浏览器消息和选择器等环境端口，焦点布局另由生产浏览器验证。
const key = '__fluentReadUsageDashboardLifecycle';
const NativeNumberFormat = Intl.NumberFormat;
let app: import('vue').App | undefined;
let state: Record<string, any>;
let activeProps: {active: boolean};
let messages: Array<{message: Record<string, any>; resolve: (value: unknown) => void}>;
let attributes: Map<string, string>;
let listeners: Set<unknown>;
let subscriptions: Set<unknown>;

vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: (...args: unknown[]) => (globalThis as any).__fluentReadUsageDashboardLifecycle.sendMessage(...args)}}}));
vi.mock('element-plus', () => {const slots = {setup: (_: unknown, {slots}: any) => () => runtime.h('span', slots.default?.())}; return {ElOption: {props:['value','label'],setup:(props:any)=>()=>runtime.h('option',{value:props.value},props.label)}, ElPopover: slots, ElTooltip: slots};});
vi.mock('@/src/ui/components/UiIcon.vue', () => ({default: {render: () => null}}));
vi.mock('@/src/ui/components/UiSelect.vue', () => ({default: {inheritAttrs: false, props: ['modelValue', 'disabled'], emits: ['update:modelValue', 'change'], setup: (props: any, {attrs, emit, slots}: any) => () => runtime.h(runtime.Fragment, null, [runtime.h('input', {...attrs, value: props.modelValue, disabled: props.disabled, onInput: (event: any) => {const value=typeof props.modelValue==='number'?Number(event.target.value):event.target.value;emit('update:modelValue', value);emit('change', value);}}), runtime.h('span', {hidden:true},slots.default?.())])}}));
vi.mock('@/src/ui/components/ServiceIcon.vue', () => ({default: {render: () => null}}));
vi.mock('@/src/services/config/store', () => ({config: {customOpenAIProviders: []}, subscribeConfig: (...args: unknown[]) => (globalThis as any).__fluentReadUsageDashboardLifecycle.subscribeConfig(...args)}));
vi.mock('@/src/ui/i18n', async () => {const {ref} = await import('vue'); return {useUiI18n: () => ({language: ref('zh-CN'), t: (key: string) => key, translateLegacy: (text: string) => text})};});

async function settle(): Promise<void> {
    for (let index = 0; index < 8; index += 1) {await Promise.resolve(); await runtime.nextTick();}
}

async function mount(kind: 'model' | 'stats', active = true, renderTemplate = false): Promise<void> {
    const component = (renderTemplate ? (kind === 'model' ? ModelUsageDashboard : TranslationStatsDashboard) : {...(kind === 'model' ? ModelUsageDashboard : TranslationStatsDashboard), render: () => null}) as unknown as runtime.Component;
    const renderer = renderTemplate ? createDashboardDomRenderer() : runtime.createRenderer<any, any>({
        patchProp: () => undefined, insert: () => undefined, remove: () => undefined, createElement: () => ({}),
        createText: () => ({}), createComment: () => ({}), setText: () => undefined, setElementText: () => undefined,
        parentNode: () => null, nextSibling: () => null, querySelector: () => null, setScopeId: () => undefined,
        cloneNode: () => ({}), insertStaticContent: () => [{}, {}],
    });
    activeProps = runtime.reactive({active});
    app = renderer.createApp({setup: () => () => runtime.h(component, {...activeProps, ref: (vm: any) => {if (vm) state = vm.$.setupState;}})});
    app.component('ElSelect', {inheritAttrs: false, props: ['modelValue'], emits: ['update:modelValue', 'change'], setup: (props: any, {attrs, emit, slots}: any) => () => runtime.h(runtime.Fragment, null, [runtime.h('input', {...attrs, value: props.modelValue, onInput: (event: any) => {const value=typeof props.modelValue==='number'?Number(event.target.value):event.target.value;emit('update:modelValue', value);emit('change', value);}}), runtime.h('span',{hidden:true},slots.default?.())])});
    app.component('ElOption', {props:['value','label'],setup:(props:any)=>()=>runtime.h('option',{value:props.value},props.label)});
    app.provide(runtime.ssrContextKey, {modules: new Set<string>()});
    app.config.warnHandler = () => undefined;
    app.mount(renderTemplate ? document.querySelector('#dashboard')! : {});
    await settle();
}

function createDashboardDomRenderer() {
    const page = parseHTML('<html><body><div class="settings-app"><main id="dashboard"></main></div></body></html>');
    vi.stubGlobal('document', page.document);vi.stubGlobal('window', page.window);
    for (const name of ['HTMLElement','HTMLInputElement','HTMLButtonElement','SVGElement','Node','Element','Event']) vi.stubGlobal(name, (page.window as any)[name]);
    Object.defineProperty(page.document, 'visibilityState', {value:'visible', configurable:true});
    let focused: Element = page.document.body;
    Object.defineProperty(page.document, 'activeElement', {get: () => focused, configurable: true});
    vi.spyOn(page.window.HTMLElement.prototype, 'focus').mockImplementation(function(this: HTMLElement) {focused = this;this.dispatchEvent(new page.window.Event('focus'));});
    return runtime.createRenderer<any, any>({
        patchProp(node, name, previous, value) {
            if (/^on[A-Z]/u.test(name)) {
                const event = name.slice(2).toLowerCase();
                for (const fn of (Array.isArray(previous) ? previous : previous ? [previous] : [])) node.removeEventListener(event,fn);
                for (const fn of (Array.isArray(value) ? value : value ? [value] : [])) node.addEventListener(event,fn);
            } else if (name === 'style') {
                if (typeof value === 'string') node.style.cssText = value;
                else {node.style.cssText='';Object.assign(node.style,value || {});}
            } else if (name === 'value') node.value = value ?? '';
            else if (name.startsWith('aria-')) node.setAttribute(name, String(value));
            else if (value == null || value === false) node.removeAttribute(name);
            else node.setAttribute(name,value === true ? '' : String(value));
        },
        insert:(node,parent,anchor=null)=>parent.insertBefore(node,anchor), remove:node=>node.remove(),
        createElement:name=>runtime.markRaw(page.document.createElement(name)),createText:value=>page.document.createTextNode(value),createComment:value=>page.document.createComment(value),
        setText:(node,value)=>{node.nodeValue=value;},setElementText:(node,value)=>{node.textContent=value;},parentNode:node=>node.parentNode,nextSibling:node=>node.nextSibling,
        querySelector:selector=>page.document.querySelector(selector),setScopeId:(node,id)=>node.setAttribute(id,''),cloneNode:node=>node.cloneNode(true),
        insertStaticContent:(html,parent,anchor)=>{const template=page.document.createElement('template');template.innerHTML=html;const first=template.content.firstChild,last=template.content.lastChild;parent.insertBefore(template.content,anchor);return[first,last];},
    });
}

beforeEach(async () => {
    app = undefined;
    messages = []; attributes = new Map(); listeners = new Set(); subscriptions = new Set();
    const settings = {
        hasAttribute: (name: string) => attributes.has(name),
        setAttribute: (name: string, value: string) => attributes.set(name, value),
        removeAttribute: (name: string) => attributes.delete(name),
    };
    vi.stubGlobal('document', {visibilityState: 'visible', querySelector: () => settings,
        addEventListener: (_name: string, listener: unknown) => listeners.add(listener),
        removeEventListener: (_name: string, listener: unknown) => listeners.delete(listener)});
    Object.assign(globalThis, {[key]: {
        sendMessage: (message: Record<string, any>) => new Promise(resolve => messages.push({message, resolve})),
        subscribeConfig: (listener: unknown) => {subscriptions.add(listener); return () => subscriptions.delete(listener);},
    }});

});

afterEach(async () => {
    app?.unmount();
    delete (globalThis as any)[key];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('Model 用量真实 setup 的固定数字规则', () => {
    it('100 次速度与秒/分钟展示只构造三套规则，格式值仍逐次更新', async () => {
        await mount('model', false);
        const constructors = vi.spyOn(Intl, 'NumberFormat');
        const speed = new NativeNumberFormat('zh-CN', {maximumFractionDigits: 2});
        const second = new NativeNumberFormat('zh-CN', {style: 'unit', unit: 'second', unitDisplay: 'short', maximumFractionDigits: 2});
        const minute = new NativeNumberFormat('zh-CN', {style: 'unit', unit: 'minute', unitDisplay: 'short', maximumFractionDigits: 2});
        for (let index = 0; index < 100; index += 1) {
            expect(state.formatSpeed(index + .125)).toBe(speed.format(index + .125));
            expect(state.formatDuration(1_000 + index)).toBe(second.format(1 + index / 1_000));
            expect(state.formatDuration(60_000)).toBe(`${minute.format(1)} ${second.format(0)}`);
        }
        expect(constructors).toHaveBeenCalledTimes(3);
        expect(messages).toEqual([]);
    });

    it('七种界面语言切换与返回保留异常值、负零和单位阈值，规则按语言复用', async () => {
        await mount('model', false);
        const constructors = vi.spyOn(Intl, 'NumberFormat');
        const locales = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'];
        for (const locale of locales) {
            state.language = locale;
            const speed = new NativeNumberFormat(locale, {maximumFractionDigits: 2});
            const second = new NativeNumberFormat(locale, {style: 'unit', unit: 'second', unitDisplay: 'short', maximumFractionDigits: 2});
            const minute = new NativeNumberFormat(locale, {style: 'unit', unit: 'minute', unitDisplay: 'short', maximumFractionDigits: 2});
            for (const value of [null, undefined, NaN, Infinity, -Infinity]) expect(state.formatSpeed(value)).toBe('—');
            for (const value of [-123.45, -0, 0, 1.005, 1e12]) expect(state.formatSpeed(value)).toBe(speed.format(value));
            for (const value of [null, undefined, NaN, Infinity, -Infinity, -1]) expect(state.formatDuration(value)).toBe('—');
            expect(state.formatDuration(-0)).toBe('0 ms');
            expect(state.formatDuration(0)).toBe('0 ms');
            expect(state.formatDuration(999)).toBe('999 ms');
            expect(state.formatDuration(1_000)).toBe(second.format(1));
            // 原规则按毫秒阈值选单位：59,999.5 ms 显示舍入后的 60 秒，尚不进入分钟。
            expect(state.formatDuration(59_999.5)).toBe(second.format(59.9995));
            expect(state.formatDuration(60_000)).toBe(`${minute.format(1)} ${second.format(0)}`);
            expect(state.formatDuration(123_456_789)).toBe(`${minute.format(2057)} ${second.format(37)}`);
        }
        expect(constructors).toHaveBeenCalledTimes(21);
        constructors.mockClear();state.language = 'zh-CN';
        state.formatSpeed(12.34);state.formatDuration(1_000);state.formatDuration(60_000);
        expect(constructors).not.toHaveBeenCalled();
    });

    it('新组件实例保持懒构造且不会复用前一个实例的格式器', async () => {
        await mount('model', false);
        const constructors = vi.spyOn(Intl, 'NumberFormat');
        state.formatSpeed(12.34);state.formatDuration(1_000);state.formatDuration(60_000);
        expect(constructors).toHaveBeenCalledTimes(3);
        app!.unmount();app = undefined;constructors.mockClear();
        await mount('model', false);
        expect(constructors).not.toHaveBeenCalled();
        state.formatSpeed(12.34);state.formatDuration(1_000);state.formatDuration(60_000);
        expect(constructors).toHaveBeenCalledTimes(3);
    });

    it.each(['speed', 'second', 'minute'] as const)('%s 原生构造失败不污染缓存，下一调用重试后可复用', async (rule) => {
        await mount('model', false);state.language = 'en-US';
        const constructors = vi.spyOn(Intl, 'NumberFormat').mockImplementationOnce(() => {throw new RangeError('controlled native constructor failure');});
        const format = rule === 'speed' ? state.formatSpeed : state.formatDuration;
        const value = rule === 'speed' ? 12.34 : rule === 'second' ? 1_000 : 60_000;
        expect(() => format(value)).toThrow('controlled native constructor failure');
        constructors.mockClear();
        const first = format(value), next = format(value * 2);
        const expected = new NativeNumberFormat('en-US', rule === 'speed' ? {maximumFractionDigits: 2}
            : {style: 'unit', unit: rule, unitDisplay: 'short', maximumFractionDigits: 2});
        if (rule === 'speed') {expect(first).toBe(expected.format(12.34));expect(next).toBe(expected.format(24.68));}
        else if (rule === 'second') {expect(first).toBe(expected.format(1));expect(next).toBe(expected.format(2));}
        else {
            const second = new NativeNumberFormat('en-US', {style: 'unit', unit: 'second', unitDisplay: 'short', maximumFractionDigits: 2});
            expect(first).toBe(`${expected.format(1)} ${second.format(0)}`);expect(next).toBe(`${expected.format(2)} ${second.format(0)}`);
        }
        const targetCalls = constructors.mock.calls.filter(([, options]) => rule === 'speed' ? !options?.unit : options?.unit === rule);
        expect(targetCalls).toHaveLength(1);
    });
});

describe.each(['model', 'stats'] as const)('%s 统计面板真实组件生命周期', (kind) => {
    it('卸载后迟到的清除成功不得查询、写状态或解除新弹窗的背景禁用', async () => {
        await mount(kind);
        await state.openResetDialog();
        const pending = kind === 'model' ? state.resetUsage() : state.resetStats();
        const reset = messages.find(item => item.message.action === 'reset')!;
        expect(reset).toBeDefined();
        app!.unmount(); app = undefined;
        attributes.set('inert', 'new-dialog');
        reset.resolve({success: true, data: {cleared: true}});
        await settle();
        // 若错误实现继续查询，先放行才能收集完整失败而不留下悬挂任务。
        for (const item of messages) if (item !== reset) item.resolve({success: true, data: {selected: {totals: {requestCount: 0}}}});
        await pending;
        expect(messages.filter(item => item.message.action === 'query')).toHaveLength(1);
        expect(attributes.get('inert')).toBe('new-dialog');
        expect(state.resetMessage).toBe('');
        expect(listeners.size).toBe(0);
        expect(subscriptions.size).toBe(0);
    });

    it('卸载后迟到的清除失败不得修改组件错误状态', async () => {
        await mount(kind);
        await state.openResetDialog();
        const pending = kind === 'model' ? state.resetUsage() : state.resetStats();
        app!.unmount(); app = undefined;
        messages.find(item => item.message.action === 'reset')!.resolve({success: false, error: 'late-reset-error'});
        await pending;
        expect(state.resetError).toBe('');
    });

    it('未打开弹窗的隐藏面板卸载时不得解除已有背景禁用', async () => {
        attributes.set('inert', 'other-dialog');
        await mount(kind, false);
        app!.unmount(); app = undefined;
        expect(messages).toEqual([]);
        expect(attributes.get('inert')).toBe('other-dialog');
    });

    it('关闭弹窗保留原有 inert，自己设置的 inert 在卸载时释放', async () => {
        await mount(kind);
        attributes.set('inert', 'preexisting');
        await state.openResetDialog();
        state.closeResetDialog();
        expect(attributes.get('inert')).toBe('preexisting');
        attributes.delete('inert');
        await state.openResetDialog();
        expect(attributes.has('inert')).toBe(true);
        app!.unmount(); app = undefined;
        expect(attributes.has('inert')).toBe(false);
    });

    it('卸载后不再发送快照或请求列表查询', async () => {
        await mount(kind);
        messages[0].resolve({success: true, data: {selected: {totals: {requestCount: 0}}}});
        await settle();
        app!.unmount(); app = undefined;
        const snapshot = state.loadSnapshot();
        await settle();
        for (const item of messages.slice(1)) item.resolve({success: true, data: {selected: {totals: {requestCount: 0}}}});
        await snapshot;
        const page = state.loadRequestPage(0);
        await settle();
        for (const item of messages.slice(1)) item.resolve({success: true, data: {items: [], totalCount: 0, offset: 0}});
        await page;
        expect(messages).toHaveLength(1);
    });
});


describe.each(['model', 'stats'] as const)('%s cached dashboard deactivation', kind => {
    it('closes its confirmation and releases background interaction when navigation hides the cached panel', async () => {
        await mount(kind);
        await state.openResetDialog();
        expect(state.resetDialogOpen).toBe(true);
        expect(attributes.has('inert')).toBe(true);
        activeProps.active = false;await settle();
        expect(state.resetDialogOpen).toBe(false);
        expect(attributes.has('inert')).toBe(false);
        await state.openResetDialog();
        expect(state.resetDialogOpen).toBe(false);
        await (kind === 'model' ? state.resetUsage() : state.resetStats());
        expect(messages.filter(item => item.message.action === 'reset')).toHaveLength(0);
    });

    it.each(['success', 'failure'] as const)('does not apply an old clear %s to a reopened panel or its new confirmation', async outcome => {
        await mount(kind);
        await state.openResetDialog();
        const oldReset = kind === 'model' ? state.resetUsage() : state.resetStats();
        const pending = messages.find(item => item.message.action === 'reset')!;
        activeProps.active = false;await settle();
        activeProps.active = true;await settle();
        await state.openResetDialog();
        const queryCount = messages.filter(item => item.message.action === 'query').length;
        pending.resolve(outcome === 'success' ? {success: true, data: {cleared: true}} : {success: false, error: 'obsolete reset failure'});
        await settle();
        // 旧实现会再发快照查询；放行让断言而非挂起任务暴露错误。
        for (const item of messages.filter(item => item.message.action === 'query')) item.resolve({success: true, data: {selected: {totals: {requestCount: 0}}}});
        await oldReset;await settle();
        expect(messages.filter(item => item.message.action === 'query')).toHaveLength(queryCount);
        expect(state.resetDialogOpen).toBe(true);
        expect(attributes.has('inert')).toBe(true);
        expect(state.resetError).toBe('');
        expect(state.resetMessage).toBe('');
        expect(state.resetting).toBe(false);
    });
});


const dashboardNow = Date.UTC(2026, 9, 23, 4);
const modelEvents: StoredModelUsageEvent[] = Array.from({length: 65}, (_, index) => ({
    id: `model-${index}`, schemaVersion: 1, startedAt: dashboardNow - index * 60_000, durationMs: 1_500 + index * 300,
    serviceId: index % 2 ? 'deepseek' : 'gemini', configuredModel: `model-${index % 13}`, actualModel: `model-${index % 13}`, model: `model-${index % 13}`,
    purpose: (['reading','translation','writing','page-summary','connection-test'] as const)[index % 5], outcome: (['success','error','timeout','cancelled'] as const)[index % 4], usageAvailability: (['reported','unreported','malformed'] as const)[index % 3],
    inputTokens: index === 6 ? 0 : 120, outputTokens: 40, totalTokens: index === 6 ? 40 : 160, cachedInputTokens: index % 3 ? undefined : index % 2 || index === 6 ? 0 : 30, reasoningTokens: index % 2 ? 10 : undefined,
}));
const statsEvents: StoredTranslationRequestEvent[] = Array.from({length: 65}, (_, index) => ({
    id:`stats-${index}`,schemaVersion:1,startedAt:dashboardNow-index*60_000,durationMs:900+index*70,
    serviceId:index%3===2?'freeTranslation':index%2?'microsoft':'deepseek',model:index%2?'':`model-${index%13}`,mode: (['single','batch','image'] as const)[index%3],segmentCount:index%3?1:3,
    sourceChars:100+index,sourceBytes:200+index,resultChars:80,source:index%3?'network':'cache',cachedSegments:index%3?0:3,
    routes:index%3===2?['google','bing']:[],upstreamCalls:1,upstreamMs:600,outcome:index%5?'success':'error',errorKind:index%5?undefined:'network',
}));
async function answerDashboard(kind:'model'|'stats', answered:Set<object>, empty=false) {
    for(let round=0;round<4;round++) {
        for(const request of messages.filter(item=>!answered.has(item) && ['query','list'].includes(item.message.action))) {
            answered.add(request);
            if(request.message.action==='query') {
                const filter=request.message.filter;
                const data=kind==='model' ? buildModelUsageDashboard(empty?[]:modelEvents,filter,{now:dashboardNow})
                    : buildTranslationStatsSnapshot(empty?[]:statsEvents.map(event=>foldTranslationRequestEvent(createTranslationStatsRollup(event.startedAt,event.serviceId,event.model),event)),filter,{now:dashboardNow, routeRollups: empty ? [] : ['google','bing','fixture-unknown'].map((route,index)=>foldTranslationRouteAttempt(createTranslationRouteRollup(dashboardNow,'freeTranslation',route), {route,outcome:'success',durationMs:200+index*100,chars:100}))});
                request.resolve({success:true,data});
            } else {
                const source=kind==='model'?modelEvents:statsEvents;
                const {offset=0,limit=20}=request.message.query;
                request.resolve({success:true,data:{items:empty?[]:source.slice(offset,offset+limit),offset,totalCount:empty?0:source.length}});
            }
        }
        await settle();
    }
}
async function inputDashboard(label: string, value: string) {
    const input=document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
    expect(input,label).toBeTruthy();input.value=value;input.dispatchEvent(new window.Event('input',{bubbles:true}));await settle();
}

async function clickDashboard(selector:string) {
    const node=document.querySelector(selector);expect(node,selector).toBeTruthy();expect(node!.hasAttribute('disabled')).toBe(false);
    node!.dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));await settle();
}

async function keyDashboard(selector: string, key: string, shiftKey = false) {
    const node = document.querySelector(selector);expect(node, selector).toBeTruthy();
    const event = new window.Event('keydown', {bubbles: true, cancelable: true});
    Object.defineProperties(event, {key: {value: key}, shiftKey: {value: shiftKey}});
    node!.dispatchEvent(event);await settle();return event;
}

describe.each(['model','stats'] as const)('%s dashboard real DOM controls',kind=>{
    it('renders actual totals and request rows, changes range and service, and opens/cancels the clear dialog',async()=>{
        await mount(kind,true,true);const answered=new Set<object>();await answerDashboard(kind,answered);
        expect(document.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
        expect(document.body.textContent).toContain('65');
        await clickDashboard('[data-range-index="0"]');await answerDashboard(kind,answered);
        expect(messages.filter(item=>item.message.action==='query').at(-1)?.message.filter.range).toBe('today');
        const select=document.querySelector('input[aria-label="'+(kind==='stats'?'translationStats.filter.service':'模型用量服务')+'"]') as HTMLInputElement;
        expect(select).toBeTruthy();select.value='deepseek';select.dispatchEvent(new window.Event('input',{bubbles:true}));await settle();await answerDashboard(kind,answered);
        expect(messages.filter(item=>item.message.action==='query').at(-1)?.message.filter.serviceId).toBe('deepseek');
        await clickDashboard(kind==='stats'?'.stats-actions .stats-button-quiet':'.usage-reset-button');
        expect(state.resetDialogOpen).toBe(true);expect(document.querySelector('[role="alertdialog"]')).toBeTruthy();expect(document.querySelector('.settings-app')!.hasAttribute('inert')).toBe(true);
        await clickDashboard(kind==='stats'?'.stats-dialog-backdrop button':'.usage-dialog-backdrop button');
        expect(document.querySelector('[role="alertdialog"]')).toBeNull();expect(document.querySelector('.settings-app')!.hasAttribute('inert')).toBe(false);
    });
    it('keeps pending clear confirmation bounded to the visible page during real rendered navigation',async()=>{
        await mount(kind,true,true);const answered=new Set<object>();await answerDashboard(kind,answered,true);
        await clickDashboard(kind==='stats'?'.stats-actions .stats-button-quiet':'.usage-reset-button');
        await clickDashboard(kind==='stats'?'.stats-button-danger':'.usage-dialog-backdrop .danger');
        const pending=messages.find(item=>item.message.action==='reset')!;expect(pending).toBeDefined();
        activeProps.active=false;await settle();expect(document.querySelector('[role="alertdialog"]')).toBeNull();
        expect(document.querySelector('.settings-app')!.hasAttribute('inert')).toBe(false);
        pending.resolve({success:true,data:{cleared:true}});await settle();
        expect(state.resetMessage).toBe('');expect(state.resetting).toBe(false);
    });
    it('supports keyboard range selection, request paging and breakdown toggle without stale filters', async () => {
        await mount(kind,true,true);const answered=new Set<object>();await answerDashboard(kind,answered);
        const irrelevant=await keyDashboard('[data-range-index="0"]','a');expect(irrelevant.defaultPrevented).toBe(false);
        for (const key of ['End','Home','ArrowRight','ArrowLeft','ArrowUp','ArrowDown']) {
            const event=await keyDashboard('[data-range-index="0"]',key);expect(event.defaultPrevented).toBe(true);
            await answerDashboard(kind,answered);
            expect(document.activeElement?.getAttribute('role')).toBe('radio');
        }
        const next=kind==='stats'?'.stats-page-controls button:last-child':'.usage-request-pagination > button:last-of-type';
        await clickDashboard(next);await answerDashboard(kind,answered);
        expect(messages.filter(item=>item.message.action==='list').at(-1)?.message.query.offset).toBe(20);
        const jump=document.querySelector('input[aria-label="common.pagination.jump"]') as HTMLInputElement;
        jump.value='3';jump.dispatchEvent(new window.Event('input',{bubbles:true}));await settle();
        jump.closest('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle();await answerDashboard(kind,answered);
        expect(messages.filter(item=>item.message.action==='list').at(-1)?.message.query.offset).toBe(40);
        const row=kind==='stats'?'.stats-service-table tbody tr':'.usage-breakdown-list button';
        await clickDashboard(row);await answerDashboard(kind,answered);
        expect(messages.filter(item=>item.message.action==='query').at(-1)?.message.filter.serviceId).toBeTruthy();
        await clickDashboard(row);await answerDashboard(kind,answered);
        expect(messages.filter(item=>item.message.action==='query').at(-1)?.message.filter.serviceId).toBeUndefined();
        const sorts=kind==='stats'?'.stats-service-table .stats-sort':'.usage-breakdown-heading button';
        for(const button of document.querySelectorAll(sorts)) {button.dispatchEvent(new window.Event('click',{bubbles:true}));await settle();button.dispatchEvent(new window.Event('click',{bubbles:true}));await settle();}
        const metrics=kind==='stats'?'.stats-trend .stats-toggle button':'.usage-metric-toggle button';
        for(const button of document.querySelectorAll(metrics)) {button.dispatchEvent(new window.Event('click',{bubbles:true}));await settle();expect(button.getAttribute('aria-pressed')).toBe('true');}
    });
    it('keeps focus inside confirmation, handles Escape and ignores obsolete next-tick focus restoration', async () => {
        await mount(kind,true,true);const answered=new Set<object>();await answerDashboard(kind,answered);
        const opener=kind==='stats'?'.stats-actions .stats-button-quiet':'.usage-reset-button';
        await clickDashboard(opener);
        const dialog=document.querySelector('[role="alertdialog"]')!;
        const [cancel,confirm]=[...dialog.querySelectorAll('button')];
        expect(document.activeElement).toBe(cancel);
        await keyDashboard('[role="alertdialog"]','Tab',true);expect(document.activeElement).toBe(confirm);
        await keyDashboard('[role="alertdialog"]','Tab');expect(document.activeElement).toBe(cancel);
        await keyDashboard('[role="alertdialog"]','Escape');expect(document.querySelector('[role="alertdialog"]')).toBeNull();
        expect(document.activeElement).toBe(document.querySelector(opener));
        const first=state.openResetDialog();state.closeResetDialog();const second=state.openResetDialog();
        await Promise.all([first,second]);await settle();
        expect(document.activeElement).toBe(document.querySelector('[role="alertdialog"] button'));
        expect(document.querySelector('.settings-app')!.hasAttribute('inert')).toBe(true);
    });
    it('renders a load failure and recovers through the actual retry button', async () => {
        await mount(kind,true,true);
        const answered=new Set<object>([messages[0]]);messages[0].resolve({success:false,error:'controlled query failure'});await settle();
        expect(document.querySelector('[role="alert"]')?.textContent).toContain('controlled query failure');
        await clickDashboard('[role="alert"] button');await answerDashboard(kind,answered);
        expect(document.querySelector('[role="alert"]')).toBeNull();expect(document.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
    });
    it('shows clear failure, retries once and refreshes the visible empty dashboard after success', async () => {
        await mount(kind,true,true);const answered=new Set<object>();await answerDashboard(kind,answered);
        await clickDashboard(kind==='stats'?'.stats-actions .stats-button-quiet':'.usage-reset-button');
        const confirm=kind==='stats'?'.stats-button-danger':'.usage-dialog-backdrop .danger';
        await clickDashboard(confirm);messages.filter(item=>item.message.action==='reset').at(-1)!.resolve({success:false,error:'controlled clear failure'});await settle();
        expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('controlled clear failure');
        await clickDashboard(confirm);messages.filter(item=>item.message.action==='reset').at(-1)!.resolve({success:true,data:{cleared:true}});await settle();
        await answerDashboard(kind,answered,true);
        expect(document.querySelector('[role="alertdialog"]')).toBeNull();expect(state.resetMessage).toBeTruthy();
        expect(document.querySelector('.settings-app')!.hasAttribute('inert')).toBe(false);
        expect(document.querySelectorAll('tbody tr')).toHaveLength(0);
    });
    it('清除已确认后刷新挂起时恢复焦点并允许再次打开确认', async () => {
        await mount(kind,true,true);const answered=new Set<object>();await answerDashboard(kind,answered);
        const opener=kind==='stats'?'.stats-actions .stats-button-quiet':'.usage-reset-button';
        const confirm=kind==='stats'?'.stats-button-danger':'.usage-dialog-backdrop .danger';
        await clickDashboard(opener);await clickDashboard(confirm);
        messages.filter(item=>item.message.action==='reset').at(-1)!.resolve({success:true,data:{cleared:true}});await settle();
        const refresh=messages.filter(item=>item.message.action==='query').at(-1)!;
        expect(answered.has(refresh)).toBe(false);
        expect(state.resetting).toBe(false);expect(document.activeElement).toBe(document.querySelector(opener));
        await clickDashboard(opener);expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
        await clickDashboard(confirm);expect(state.resetting).toBe(true);
        refresh.resolve({success:false,error:'late refresh failure'});await settle();
        expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();expect(state.resetError).toBe('');expect(state.resetting).toBe(true);
        messages.filter(item=>item.message.action==='reset').at(-1)!.resolve({success:true,data:{cleared:true}});await settle();
        await answerDashboard(kind,answered,true);expect(state.resetting).toBe(false);
        expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    });

    it('updates model and record filters, expands distribution, and operates chart keyboard focus', async () => {
        await mount(kind,true,true);const answered=new Set<object>();await answerDashboard(kind,answered);
        const expanded=kind==='stats'?'.stats-show-all':'.usage-show-all';
        await clickDashboard(expanded);expect(document.querySelector(expanded)?.getAttribute('aria-expanded')).toBe('true');await clickDashboard(expanded);
        await inputDashboard(kind==='stats'?'translationStats.filter.service':'模型用量服务','deepseek');await answerDashboard(kind,answered);
        await inputDashboard(kind==='stats'?'translationStats.filter.model':'模型用量模型','model-1');await answerDashboard(kind,answered);
        expect(messages.filter(item=>item.message.action==='query').at(-1)?.message.filter.model).toBe('model-1');
        const filters: Array<[string,string]> = kind==='stats' ? [['translationStats.log.source','cache'],['translationStats.log.outcome','success'],['translationStats.log.pageSize','50']]
            : [['按调用场景筛选请求记录','reading'],['按调用状态筛选请求记录','timeout'],['按模型缓存状态筛选请求记录','unreported'],['每页请求记录数量','50']];
        for(const [label,value] of filters) {await inputDashboard(label,value);await answerDashboard(kind,answered);expect(messages.filter(item=>item.message.action==='list').at(-1)?.message.query.offset).toBe(0);}
        expect(messages.filter(item=>item.message.action==='list').at(-1)?.message.query.limit).toBe(50);
        if(kind==='model') {await clickDashboard('.usage-log-reset');await answerDashboard(kind,answered);expect(state.requestPurpose).toBe('');}
        else for(const button of document.querySelectorAll('[aria-label="translationStats.log.sort"] button')) {button.dispatchEvent(new window.Event('click',{bubbles:true}));await settle();await answerDashboard(kind,answered);expect(button.getAttribute('aria-pressed')).toBe('true');}
        await clickDashboard(kind==='stats'?'.stats-meta .stats-link':'.usage-active-filter button');await answerDashboard(kind,answered);
        expect(messages.filter(item=>item.message.action==='query').at(-1)?.message.filter.serviceId).toBeUndefined();
        const point=kind==='stats'?'.stats-trend-bar':'.usage-trend-point';
        await clickDashboard(point);(document.querySelector(point) as HTMLElement).focus();await settle();
        for(const key of ['ArrowRight','ArrowLeft','Home','End']) {expect((await keyDashboard(point,key)).defaultPrevented).toBe(true);expect(document.activeElement?.classList.contains(point.slice(1))).toBe(true);}
        expect((await keyDashboard(point,'a')).defaultPrevented).toBe(false);
        const previous=kind==='stats'?'.stats-page-controls button:first-child':'.usage-request-pagination > button:first-of-type';
        const next=kind==='stats'?'.stats-page-controls button:last-child':'.usage-request-pagination > button:last-of-type';
        await clickDashboard(next);await answerDashboard(kind,answered);await clickDashboard(previous);await answerDashboard(kind,answered);
        expect(messages.filter(item=>item.message.action==='list').at(-1)?.message.query.offset).toBe(0);
        const count=messages.length;document.dispatchEvent(new window.Event('visibilitychange'));await settle();expect(messages.length).toBeGreaterThan(count);await answerDashboard(kind,answered);
    });
    it('renders request failures with a working retry and preserves valid summary data', async () => {
        await mount(kind,true,true);const answered=new Set<object>();
        const first=messages[0];answered.add(first);first.resolve({success:true,data:kind==='model'?buildModelUsageDashboard(modelEvents,{range:'30d'},{now:dashboardNow}):buildTranslationStatsSnapshot(statsEvents.map(event=>foldTranslationRequestEvent(createTranslationStatsRollup(event.startedAt,event.serviceId,event.model),event)),{range:'7d'},{now:dashboardNow})});await settle();
        const list=messages.find(item=>item.message.action==='list')!;answered.add(list);list.resolve({success:false,error:'controlled list failure'});await settle();
        expect(document.querySelector('[role="alert"]')?.textContent).toContain('controlled list failure');
        await clickDashboard('[role="alert"] button');await answerDashboard(kind,answered);
        expect(document.querySelector('[role="alert"]')).toBeNull();expect(document.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
        for(const listener of subscriptions) (listener as Function)({customOpenAIProviders:[],compositeTranslationProviders:[]});await settle();
    });

    it('retains existing data after a failed refresh and retries through the inline notice', async () => {
        await mount(kind,true,true);const answered=new Set<object>();await answerDashboard(kind,answered);
        const rows=document.querySelectorAll('tbody tr').length;
        await clickDashboard(kind==='stats'?'.stats-actions .stats-button:first-child':'.usage-refresh-button');
        const query=messages.filter(item=>item.message.action==='query').at(-1)!;answered.add(query);
        query.resolve({success:false,error:'refresh interrupted'});await settle();
        const notice=kind==='stats'?'.stats-inline-error':'.usage-inline-error';
        expect(document.querySelector(notice)?.textContent).toContain('refresh interrupted');
        expect(document.querySelectorAll('tbody tr')).toHaveLength(rows);
        await clickDashboard(`${notice} button`);await answerDashboard(kind,answered);
        expect(document.querySelector(notice)).toBeNull();
    });

    it('keeps Tab inside a pending reset when both confirmation buttons are disabled', async () => {
        await mount(kind,true,true);const answered=new Set<object>();await answerDashboard(kind,answered);
        await clickDashboard(kind==='stats'?'.stats-actions .stats-button-quiet':'.usage-reset-button');
        expect((await keyDashboard('[role="alertdialog"]','a')).defaultPrevented).toBe(false);
        await clickDashboard(kind==='stats'?'.stats-button-danger':'.usage-dialog-backdrop .danger');
        expect([...document.querySelectorAll('[role="alertdialog"] button')].every(button=>button.hasAttribute('disabled'))).toBe(true);
        expect((await keyDashboard('[role="alertdialog"]','Tab')).defaultPrevented).toBe(true);
        if(kind==='model') expect(document.activeElement).toBe(document.querySelector('[role="alertdialog"]'));
    });

});

describe('dashboard configured provider names and cache detail', () => {
    it('distinguishes unreported cache usage and an empty filtered request page from an empty dashboard', async () => {
        await mount('model',true,true);
        const events=modelEvents.map(event=>({...event,cachedInputTokens:undefined}));
        messages[0].resolve({success:true,data:buildModelUsageDashboard(events,{range:'30d'},{now:dashboardNow})});await settle();
        const list=messages.find(item=>item.message.action==='list')!;
        list.resolve({success:true,data:{items:[],offset:0,totalCount:0}});await settle();
        expect(document.querySelector('.usage-average-footnote')?.textContent).toContain('缓存读取未上报');
        expect(document.querySelector('.usage-request-log-empty')?.textContent).toContain('当前记录筛选下没有请求');
        expect(document.querySelector('.usage-breakdown-list button')).not.toBeNull();
    });
    it.each(['model','stats'] as const)('%s updates custom and composite labels without retaining mutable configuration arrays', async kind => {
        await mount(kind,true,true);
        const provider={id:'custom:dashboard',name:'Research provider',endpoint:'https://provider.example.test/v1',models:['fixture-model']};
        const composite={id:'composite:dashboard',name:'Research pool',strategy:'sequential',services:['deepseek']};
        for(const listener of subscriptions) (listener as Function)({customOpenAIProviders:[provider],compositeTranslationProviders:[composite]});
        const events=modelEvents.map((event,index)=>({...event,serviceId:index%2?provider.id:composite.id}));
        const data=kind==='model'?buildModelUsageDashboard(events,{range:'30d'},{now:dashboardNow}):buildTranslationStatsSnapshot(statsEvents.map((event,index)=>{
            const adjusted={...event,serviceId:index%2?provider.id:composite.id};return foldTranslationRequestEvent(createTranslationStatsRollup(adjusted.startedAt,adjusted.serviceId,adjusted.model),adjusted);
        }),{range:'7d'},{now:dashboardNow});
        messages[0].resolve({success:true,data});await settle();
        provider.name='Mutated after notification';provider.models.push('mutated');composite.name='Mutated pool';
        const list=messages.find(item=>item.message.action==='list')!;
        list.resolve({success:true,data:{items:kind==='model'?events:statsEvents,offset:0,totalCount:65}});await settle();
        expect(document.querySelector('option[value="custom:dashboard"]')?.textContent).toBe('Research provider');
        expect(document.body.textContent).not.toContain('Mutated after notification');
        if(kind==='stats') expect(document.querySelector('option[value="composite:dashboard"]')?.textContent).toBe('Research pool');
        else {
            expect(document.querySelector('.usage-average-cache')?.textContent).toContain('缓存读取');
            expect(document.querySelector('.usage-request-table')?.textContent).toContain('输入命中率');
        }
    });
});


describe('translation statistics free route details', () => {
    it('supports Enter and Space when selecting and clearing a service row from the keyboard', async () => {
        await mount('stats',true,true);const answered=new Set<object>();await answerDashboard('stats',answered);
        expect((await keyDashboard('.stats-service-table tbody tr','Enter')).defaultPrevented).toBe(true);await answerDashboard('stats',answered);
        expect(messages.filter(item=>item.message.action==='query').at(-1)?.message.filter.serviceId).toBeTruthy();
        expect((await keyDashboard('.stats-service-table tbody tr',' ')).defaultPrevented).toBe(true);await answerDashboard('stats',answered);
        expect(messages.filter(item=>item.message.action==='query').at(-1)?.message.filter.serviceId).toBeUndefined();
    });
    it('keeps route identities, aliases and sort direction in the real table', async () => {
        await mount('stats',true,true);const answered=new Set<object>();await answerDashboard('stats',answered);
        await inputDashboard('translationStats.filter.service','freeTranslation');await answerDashboard('stats',answered);
        expect(document.querySelector('.stats-routes')?.textContent).toContain('fixture-unknown');
        expect(document.querySelectorAll('.stats-routes tbody tr')).toHaveLength(3);
        for(const button of document.querySelectorAll('.stats-routes .stats-sort')) {
            button.dispatchEvent(new window.Event('click',{bubbles:true}));await settle();
            const direction=button.closest('th')?.getAttribute('aria-sort');expect(['ascending','descending']).toContain(direction);
            button.dispatchEvent(new window.Event('click',{bubbles:true}));await settle();expect(button.closest('th')?.getAttribute('aria-sort')).not.toBe(direction);
        }
    });
});

describe.each(['model','stats'] as const)('%s 清除弹窗事件的会话归属',kind=>{
    it.each(['confirm','cancel','backdrop','escape'] as const)('上次弹窗的 %s 事件不能操作重新打开的确认会话',async action=>{
        await mount(kind,true,true);const answered=new Set<object>();await answerDashboard(kind,answered);
        const opener=kind==='stats'?'.stats-actions .stats-button-quiet':'.usage-reset-button';await clickDashboard(opener);
        const oldDialog=document.querySelector('[role="alertdialog"]')!,oldBackdrop=oldDialog.parentElement!;
        const [oldCancel,oldConfirm]=[...oldDialog.querySelectorAll('button')];
        activeProps.active=false;await settle();expect(oldDialog.isConnected).toBe(false);
        activeProps.active=true;await settle();await answerDashboard(kind,answered);await clickDashboard(opener);
        const current=document.querySelector('[role="alertdialog"]')!;expect(current).not.toBe(oldDialog);
        if(action==='escape'){
            const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.defineProperty(event,'key',{value:'Escape'});oldDialog.dispatchEvent(event);
        }else (action==='confirm'?oldConfirm:action==='cancel'?oldCancel:oldBackdrop).dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));
        await settle();expect(messages.filter(item=>item.message.action==='reset')).toHaveLength(0);
        expect(document.querySelector('[role="alertdialog"]')).toBe(current);expect(document.querySelector('.settings-app')!.hasAttribute('inert')).toBe(true);expect(state.resetting).toBe(false);
        // 当前按钮仍有效；保护旧事件不能把所有确认入口一并停用。
        await clickDashboard(kind==='stats'?'.stats-button-danger':'.usage-dialog-backdrop .danger');
        expect(messages.filter(item=>item.message.action==='reset')).toHaveLength(1);
        messages.find(item=>item.message.action==='reset')!.resolve({success:true,data:{cleared:true}});await settle();await answerDashboard(kind,answered,true);
        expect(document.querySelector('[role="alertdialog"]')).toBeNull();expect(document.querySelector('.settings-app')!.hasAttribute('inert')).toBe(false);
    });
});
