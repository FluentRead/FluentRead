import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createRenderer, defineComponent, h, KeepAlive, nextTick, ref, type App, type Ref} from 'vue';
import {renderToString} from 'vue/server-renderer';
import {useRenderDateFormatter} from '@/src/ui/dateFormat';

// 执行真实 Vue renderer/update/KeepAlive 和 SSR 生命周期；仅原生 Intl 系统默认值受控。
// 空 host port 不模拟 formatter 算法，不读取浏览器配置或用户日期。
const NativeDateTimeFormat = Intl.DateTimeFormat;
const rules: Intl.DateTimeFormatOptions = {month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit'};
const timestamp = Date.UTC(2026, 9, 11, 10, 23);
let defaults: {locale: string; timeZone: string};
function createConstructorSpy() {
    return vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locales, options) {
        return new NativeDateTimeFormat(locales ?? defaults.locale, {...options, timeZone: options?.timeZone || defaults.timeZone});
    });
}
let constructor: ReturnType<typeof createConstructorSpy>;
const apps = new Set<App>();
const renderer = createRenderer<Record<string, never>, Record<string, unknown>>({
    patchProp: () => undefined, insert: () => undefined, remove: () => undefined, createElement: () => ({}),
    createText: () => ({}), createComment: () => ({}), setText: () => undefined, setElementText: () => undefined,
    parentNode: () => null, nextSibling: () => null, querySelector: () => null, setScopeId: () => undefined,
    cloneNode: () => ({}), insertStaticContent: () => [{}, {}],
});
async function settle() {await nextTick();await nextTick();}
function expected(locales: Intl.LocalesArgument = defaults.locale, value = timestamp, options = rules) {
    return new NativeDateTimeFormat(locales, {...options, timeZone: options.timeZone || defaults.timeZone}).format(value);
}
function fixture(rows = 100, getLocales?: () => Intl.LocalesArgument | undefined, options = rules) {
    const count = ref(rows), revision = ref(0), visible = ref(true), childValue = ref(0);
    const renders: string[][] = [], errors: unknown[] = [];
    let format!: (value: number) => string;
    const Child = defineComponent({setup: () => () => h('i', String(childValue.value))});
    const Owner = defineComponent({setup() {
        format = useRenderDateFormatter(options, getLocales);
        return () => {
            revision.value;
            const values = Array.from({length: count.value}, (_, index) => format(timestamp + index * 1000));
            renders.push(values);
            return h('div', [values.join('|'), h(Child)]);
        };
    }});
    const app = renderer.createApp({setup: () => () => h(KeepAlive, {}, {default: () => visible.value ? h(Owner, {key: 'owner'}) : h('span', {key: 'hidden'})})});
    app.config.errorHandler = error => {errors.push(error);};
    app.mount({});apps.add(app);
    return {app, count, revision, visible, childValue, renders, errors, format: (value: number) => format(value)};
}
beforeEach(() => {
    defaults = {locale: 'en-US', timeZone: 'UTC'};
    constructor = createConstructorSpy();
});
afterEach(() => {
    for (const app of apps) app.unmount();apps.clear();vi.restoreAllMocks();
});

describe('per-render native date formatting through Vue lifecycle', () => {
    it('stays lazy for an empty render and formats 100 rows with one native formatter when populated', async () => {
        const owner = fixture(0);
        expect(constructor).not.toHaveBeenCalled();expect(owner.renders.at(-1)).toEqual([]);
        owner.count.value = 100;await settle();
        expect(constructor).toHaveBeenCalledOnce();expect(owner.renders.at(-1)).toHaveLength(100);
        expect(owner.renders.at(-1)![0]).toBe(expected());
    });
    it('shares one formatter within each update and does not retain it into the next update', async () => {
        const owner = fixture();expect(constructor).toHaveBeenCalledOnce();
        constructor.mockClear();owner.revision.value++;await settle();
        expect(constructor).toHaveBeenCalledOnce();
        constructor.mockClear();owner.revision.value++;await settle();
        expect(constructor).toHaveBeenCalledOnce();expect(owner.renders).toHaveLength(3);
    });
    it('re-reads default OS locale and timezone on the next real render', async () => {
        const owner = fixture(2);const before = owner.renders.at(-1)![0];
        defaults = {locale: 'ja-JP', timeZone: 'Asia/Tokyo'};
        constructor.mockClear();owner.revision.value++;await settle();
        expect(constructor).toHaveBeenCalledOnce();
        expect(constructor).toHaveBeenCalledWith(undefined, rules);
        expect(owner.renders.at(-1)![0]).toBe(expected());expect(owner.renders.at(-1)![0]).not.toBe(before);
    });
    it('tracks an explicit reactive locale getter and preserves the original second and hour12 rules', async () => {
        const locale: Ref<string> = ref('zh-CN');
        const options: Intl.DateTimeFormatOptions = {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false};
        const owner = fixture(100, () => locale.value, options);
        expect(constructor).toHaveBeenCalledOnce();expect(owner.renders.at(-1)![0]).toBe(expected(locale.value, timestamp, options));
        constructor.mockClear();locale.value = 'fr-FR';await settle();
        expect(constructor).toHaveBeenCalledOnce();expect(constructor).toHaveBeenCalledWith('fr-FR', options);
        expect(owner.renders.at(-1)![0]).toBe(expected('fr-FR', timestamp, options));
    });
    it('accepts a locale list or undefined from the getter and keeps explicitly fixed timezone options', async () => {
        const locales = ref<Intl.LocalesArgument | undefined>(['fr-FR', 'en-US']);
        const options = {...rules, timeZone: 'America/New_York'};
        const owner = fixture(2, () => locales.value, options);
        expect(owner.renders.at(-1)![0]).toBe(expected(['fr-FR', 'en-US'], timestamp, options));
        constructor.mockClear();locales.value = undefined;defaults.locale = 'ja-JP';defaults.timeZone = 'Asia/Tokyo';await settle();
        expect(constructor).toHaveBeenCalledOnce();expect(owner.renders.at(-1)![0]).toBe(expected(defaults.locale, timestamp, options));
    });
    it('keeps formatter instances local to independent owners and rebuilds only the updating owner', async () => {
        const first = fixture(2), second = fixture(2);
        expect(constructor).toHaveBeenCalledTimes(2);
        expect(constructor.mock.results[0].value).not.toBe(constructor.mock.results[1].value);
        constructor.mockClear();first.revision.value++;await settle();
        expect(constructor).toHaveBeenCalledOnce();expect(first.renders).toHaveLength(2);expect(second.renders).toHaveLength(1);
    });
    it('does no date work when only a nested child updates', async () => {
        const owner = fixture(2);constructor.mockClear();owner.childValue.value++;await settle();
        expect(constructor).not.toHaveBeenCalled();expect(owner.renders).toHaveLength(1);
    });
    it('preserves laziness while deactivated and resolves fresh defaults when KeepAlive renders again', async () => {
        const owner = fixture(2);owner.visible.value = false;await settle();constructor.mockClear();
        defaults = {locale: 'fr-FR', timeZone: 'Europe/Paris'};
        expect(constructor).not.toHaveBeenCalled();
        owner.revision.value++;await settle();
        expect(constructor).toHaveBeenCalledOnce();expect(owner.renders.at(-1)![0]).toBe(expected());
        constructor.mockClear();owner.visible.value = true;await settle();owner.revision.value++;await settle();
        expect(constructor.mock.calls.length).toBeGreaterThanOrEqual(1);
        expect(owner.renders.at(-1)![0]).toBe(expected());expect(owner.errors).toEqual([]);
    });
    it('retries a failed constructor later within the same synchronous render', () => {
        const failure = new RangeError('controlled Intl constructor failure');
        constructor.mockImplementationOnce(function () {throw failure;});
        let recovered = '';
        const Owner = defineComponent({setup() {
            const format = useRenderDateFormatter(rules);
            return () => {expect(() => format(timestamp)).toThrow(failure);recovered = format(timestamp);format(timestamp + 1000);return h('span', recovered);};
        }});
        const app = renderer.createApp(Owner);app.mount({});apps.add(app);
        expect(constructor).toHaveBeenCalledTimes(2);expect(recovered).toBe(expected());
    });
    it('recovers after a constructor error escapes a render without keeping a failed cache', async () => {
        constructor.mockImplementationOnce(function () {throw new RangeError('controlled failure');});
        const owner = fixture(2);expect(owner.errors).toHaveLength(1);
        constructor.mockClear();owner.revision.value++;await settle();
        expect(constructor).toHaveBeenCalledOnce();expect(owner.renders.at(-1)![0]).toBe(expected());
    });
    it('keeps native invalid timestamp errors and formats changed values without caching strings', async () => {
        const value = ref(timestamp), outputs: string[] = [], revision = ref(0);
        let format!: (value: number) => string;
        const Owner = defineComponent({setup() {
            format = useRenderDateFormatter(rules);
            return () => {revision.value;outputs.push(format(value.value));expect(() => format(NaN)).toThrow(RangeError);return h('span', outputs.at(-1));};
        }});
        const app = renderer.createApp(Owner);app.mount({});apps.add(app);expect(constructor).toHaveBeenCalledOnce();
        constructor.mockClear();value.value += 60_000;await settle();
        expect(constructor).toHaveBeenCalledOnce();expect(outputs.at(-1)).toBe(expected(defaults.locale, value.value));expect(outputs[0]).not.toBe(outputs.at(-1));
    });
    it('does not format after its component unmounts', async () => {
        const owner = fixture(2);owner.app.unmount();apps.delete(owner.app);constructor.mockClear();owner.revision.value++;await settle();
        expect(constructor).not.toHaveBeenCalled();
    });
    it('creates an independent lazy formatter for each SSR request and preserves defaults', async () => {
        const Owner = defineComponent({setup() {
            const format = useRenderDateFormatter(rules);
            return () => h('div', Array.from({length: 100}, () => format(timestamp)).join('|'));
        }});
        const first = await renderToString(h(Owner));expect(first).toContain(expected());expect(constructor).toHaveBeenCalledOnce();
        const firstFormatter = constructor.mock.results[0].value;
        defaults = {locale: 'ja-JP', timeZone: 'Asia/Tokyo'};constructor.mockClear();
        const second = await renderToString(h(Owner));expect(second).toContain(expected());expect(constructor).toHaveBeenCalledOnce();
        expect(constructor.mock.results[0].value).not.toBe(firstFormatter);expect(second).not.toBe(first);
    });
    it('does not construct a formatter for a server-rendered owner with no dates', async () => {
        const Owner = defineComponent({setup() {useRenderDateFormatter(rules);return () => h('span', 'Empty');}});
        await expect(renderToString(h(Owner))).resolves.toBe('<span>Empty</span>');expect(constructor).not.toHaveBeenCalled();
    });
});
