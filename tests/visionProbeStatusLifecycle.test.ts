import {createRenderer, h, KeepAlive, nextTick, reactive, ref, type App, type Ref} from 'vue';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {Config} from '@/src/core/config/model';
import {createVisionProbeIdentity, resolveVisionCapabilityWithProbe, VISION_PROBE_TTL_MS} from '@/src/core/config/visionProbe';
import {useVisionProbeStatus} from '@/src/features/settings/ui/services/useVisionProbeStatus';

const ports = vi.hoisted(() => ({getItem: vi.fn(), subscriptions: [] as {callback: (value: unknown) => void; stop: ReturnType<typeof vi.fn>}[]}));
vi.mock('@wxt-dev/storage', () => ({storage: {getItem: ports.getItem, watch: (_key: string, callback: (value: unknown) => void) => {
    const stop = vi.fn();ports.subscriptions.push({callback, stop});return stop;
}}}));
vi.mock('@/src/core/config/visionProbe', async importOriginal => {
    const actual = await importOriginal<typeof import('@/src/core/config/visionProbe')>();
    return {...actual, resolveVisionCapabilityWithProbe: vi.fn(actual.resolveVisionCapabilityWithProbe)};
});
const renderer = createRenderer<Record<string, never>, Record<string, unknown>>({patchProp: () => {}, insert: () => {},
    remove: () => {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText: () => {},
    setElementText: () => {}, parentNode: () => null, nextSibling: () => null, querySelector: () => null,
    setScopeId: () => {}, cloneNode: () => ({}), insertStaticContent: () => [{}, {}]});
let app: App, source: Config, active: Ref<boolean>, visible: Ref<boolean>;
let status: ReturnType<typeof useVisionProbeStatus>;
function mount(initialActive = true, useDefault = false) {
    source = reactive(new Config());source.model.deepseek = 'future-vision';source.token.deepseek = 'fixture-private-key';
    active = ref(initialActive);visible = ref(true);
    const component = {setup() {
        status = useDefault ? useVisionProbeStatus(() => source, () => 'deepseek', () => source.model.deepseek)
            : useVisionProbeStatus(() => source, () => 'deepseek', () => source.model.deepseek, () => active.value);
        return () => {void status.result.value;return null;};
    }};
    app = renderer.createApp({setup: () => () => h(KeepAlive, null, {default: () => visible.value
        ? h(component) : h({render: () => null}, {key: 'other'})})});app.mount({});
}
async function settle() {await Promise.resolve();await nextTick();await nextTick();}
function records(capability: 'supported' | 'unsupported' = 'supported', checkedAt = Date.now()) {
    return [{identity: createVisionProbeIdentity(source, 'deepseek', 'future-vision'), capability, checkedAt}];
}
function pending() {let resolve!: (value: unknown) => void;const promise = new Promise<unknown>(done => {resolve = done;});return {promise, resolve};}
beforeEach(() => {vi.useFakeTimers();vi.setSystemTime(2_000_000_000);ports.getItem.mockReset().mockResolvedValue([]);ports.subscriptions.length = 0;
    vi.mocked(resolveVisionCapabilityWithProbe).mockClear();});
afterEach(() => {app?.unmount();vi.useRealTimers();});

describe('识图状态真实 Vue 生命周期与订阅预算', () => {
    it('已进入任务队列的过期计时回调在隐藏与重新激活后仍不能改写时钟', async () => {
        const timer = vi.spyOn(globalThis, 'setTimeout');
        try {
            mount(); await settle(); ports.subscriptions[0].callback(records()); await settle();
            const callback = timer.mock.calls.find(call => call[1] === VISION_PROBE_TTL_MS)![0] as () => void;
            active.value = false; await settle(); vi.mocked(resolveVisionCapabilityWithProbe).mockClear();
            vi.setSystemTime(Date.now() + 500); callback(); await settle();
            expect(resolveVisionCapabilityWithProbe).not.toHaveBeenCalled();
            active.value = true; await settle(); ports.subscriptions.at(-1)!.callback(records()); await settle();
            vi.mocked(resolveVisionCapabilityWithProbe).mockClear(); vi.setSystemTime(Date.now() + 500); callback(); await settle();
            expect(resolveVisionCapabilityWithProbe).not.toHaveBeenCalled();
            expect(status.result.value.capability).toBe('supported');
        } finally {timer.mockRestore();}
    });
    it('初始隐藏不读缓存、不订阅、不计算配置身份，激活才读取', async () => {
        mount(false);await settle();expect(ports.getItem).not.toHaveBeenCalled();expect(ports.subscriptions).toHaveLength(0);
        expect(resolveVisionCapabilityWithProbe).not.toHaveBeenCalled();expect(status.result.value).toEqual({capability: 'unknown', source: 'unknown'});
        active.value = true;await settle();expect(ports.getItem).toHaveBeenCalledOnce();expect(ports.subscriptions).toHaveLength(1);
    });
    it('新订阅通知先到时，迟到的初次读不能覆盖', async () => {
        const read = pending();ports.getItem.mockReturnValueOnce(read.promise);mount();
        ports.subscriptions[0].callback(records());await settle();read.resolve(records('unsupported'));await settle();
        expect(status.result.value.capability).toBe('supported');expect(vi.getTimerCount()).toBe(1);
    });
    it('隐藏释放订阅与到期任务，1000次旧通知和配置变化不再计算身份', async () => {
        mount();await settle();ports.subscriptions[0].callback(records());await settle();expect(vi.getTimerCount()).toBe(1);
        active.value = false;await settle();expect(ports.subscriptions[0].stop).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
        vi.mocked(resolveVisionCapabilityWithProbe).mockClear();
        for (let i = 0; i < 1000; i++) {source.token.deepseek = `fixture-${i}`;ports.subscriptions[0].callback([]);void status.result.value;}
        await settle();expect(resolveVisionCapabilityWithProbe).not.toHaveBeenCalled();expect(ports.getItem).toHaveBeenCalledOnce();
    });
    it('恢复使用新订阅和新读取，旧订阅的迟到回调无效', async () => {
        mount();await settle();const old = ports.subscriptions[0];active.value = false;await settle();
        active.value = true;await settle();expect(ports.subscriptions).toHaveLength(2);expect(ports.getItem).toHaveBeenCalledTimes(2);
        ports.subscriptions[1].callback(records());await settle();old.callback(records('unsupported'));await settle();
        expect(status.result.value.capability).toBe('supported');
    });
    it('跨激活代际的初次读取和手动刷新均不能覆盖当前结果', async () => {
        const first = pending(), manual = pending();ports.getItem.mockReturnValueOnce(first.promise).mockReturnValueOnce(manual.promise);
        mount();const refresh = status.refresh();active.value = false;await settle();active.value = true;await settle();
        ports.subscriptions.at(-1)!.callback(records());await settle();first.resolve(records('unsupported'));manual.resolve([]);await refresh;await settle();
        expect(status.result.value.capability).toBe('supported');
    });
    it('KeepAlive 停用也停止订阅，返回重新读缓存且清理幂等', async () => {
        mount(true, true);await settle();ports.subscriptions[0].callback(records());await settle();visible.value = false;await settle();
        expect(ports.subscriptions[0].stop).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
        visible.value = true;await settle();expect(ports.getItem).toHaveBeenCalledTimes(2);expect(ports.subscriptions).toHaveLength(2);
        app.unmount();expect(ports.subscriptions[1].stop).toHaveBeenCalledOnce();
    });
    it('卸载后读取、订阅通知与手动刷新不能产生新工作', async () => {
        const read = pending();ports.getItem.mockReturnValueOnce(read.promise);mount();app.unmount();
        read.resolve(records());ports.subscriptions[0].callback(records());await settle();await status.refresh();
        expect(ports.getItem).toHaveBeenCalledOnce();expect(ports.subscriptions[0].stop).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    });
    it('识图缓存只在有效期间支持模型，到期自动回到未知且计时器归零', async () => {
        mount();await settle();ports.subscriptions[0].callback(records('supported', Date.now() - VISION_PROBE_TTL_MS + 10));await settle();
        expect(status.result.value.source).toBe('probe');await vi.advanceTimersByTimeAsync(10);await settle();
        expect(status.result.value).toEqual({capability: 'unknown', source: 'unknown'});expect(vi.getTimerCount()).toBe(0);
    });
    it('读取失败被处理，后续手动刷新和有效通知仍可恢复', async () => {
        ports.getItem.mockRejectedValueOnce(new Error('fixture unavailable'));mount();await settle();
        ports.getItem.mockResolvedValueOnce(records());await status.refresh();await settle();expect(status.result.value.capability).toBe('supported');
        source.modelVision.deepseek = {'future-vision': false};await settle();expect(status.result.value.source).toBe('override');expect(vi.getTimerCount()).toBe(0);
    });
    it('同一激活代内通知使挂起的手动刷新失效，隐藏刷新不访问存储', async () => {
        mount();await settle();const read = pending();ports.getItem.mockReturnValueOnce(read.promise);const refresh = status.refresh();
        ports.subscriptions[0].callback(records());read.resolve([]);await refresh;await settle();expect(status.result.value.capability).toBe('supported');
        active.value = false;await settle();await status.refresh();expect(ports.getItem).toHaveBeenCalledTimes(2);
    });
    it('同一 tick 隐藏再显示保留一条到期任务，不丢失缓存到期更新', async () => {
        mount();await settle();ports.subscriptions[0].callback(records('supported', Date.now() - VISION_PROBE_TTL_MS + 10));await settle();
        active.value = false;active.value = true;await settle();ports.subscriptions.at(-1)!.callback(records('supported', Date.now() - VISION_PROBE_TTL_MS + 10));await settle();
        expect(vi.getTimerCount()).toBe(1);await vi.advanceTimersByTimeAsync(10);await settle();expect(status.result.value.capability).toBe('unknown');
    });
});
