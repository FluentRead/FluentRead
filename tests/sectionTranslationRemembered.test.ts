import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {createRememberedSectionRuntime, type RememberedSectionPorts} from '@/src/features/section-translation/content/remembered';
import type {SectionTranslationRule} from '@/src/core/config/sectionTranslationRules';

class ControlledObserver {
    static instances: ControlledObserver[] = [];
    readonly roots = new Set<Node>();
    observe = vi.fn((root: Node, _options: MutationObserverInit) => { this.roots.add(root); });
    disconnect = vi.fn(() => { this.roots.clear(); });
    constructor(readonly callback: MutationCallback) { ControlledObserver.instances.push(this); }
    fire(record: MutationRecord): void {
        if ([...this.roots].some(root => root === record.target || root.contains(record.target))) this.callback([record], this as unknown as MutationObserver);
    }
}

interface Fixture {
    document: Document;
    region: Element;
    outside: Element;
    controller: AbortController;
    ports: RememberedSectionPorts & {translate: ReturnType<typeof vi.fn>; resolve: ReturnType<typeof vi.fn>; remind: ReturnType<typeof vi.fn>};
    state: {href: string; rules: SectionTranslationRule[]; enabled: boolean};
    runtime: ReturnType<typeof createRememberedSectionRuntime>;
    emit(target: Node, type?: MutationRecordType, added?: Node[], removed?: Node[]): void;
    event(type: string): void;
    visibility(value: 'hidden' | 'visible'): void;
}

const lifetimes: AbortController[] = [];
const rule = (id = 'remembered', mode: 'auto' | 'remind' = 'auto', selectors = [['#region']], site = 'example.com'): SectionTranslationRule => ({id, enabled: true, site, selectors, mode});

function fixture(rules: SectionTranslationRule[] = [rule()], visible = true, initiallyAborted = false): Fixture {
    const {document, window} = parseHTML('<html><body><article id="region"><p>Foreign source</p></article><aside id="outside">Unrelated counter</aside></body></html>');
    Object.defineProperty(document, 'visibilityState', {value: visible ? 'visible' : 'hidden', writable: true, configurable: true});
    const controller = new AbortController();
    lifetimes.push(controller);
    if (initiallyAborted) controller.abort();
    const state = {href: 'https://example.com/docs/one', rules, enabled: true};
    const ports = {
        document: document as unknown as Document,
        href: () => state.href,
        rules: () => state.rules,
        enabled: () => state.enabled,
        resolve: vi.fn((selectors: readonly (readonly string[])[], doc: Document): Element[] => selectors.flatMap(path => {
            let root: Document | ShadowRoot = doc;
            let target: Element | null = null;
            for (let index = 0; index < path.length; index += 1) {
                const matches: NodeListOf<Element> = root.querySelectorAll(path[index]);
                if (matches.length !== 1) return [];
                const matched: Element = matches[0];
                target = matched;
                if (index < path.length - 1) {
                    if (!matched.shadowRoot) return [];
                    root = matched.shadowRoot;
                }
            }
            return target ? [target] : [];
        })),
        translate: vi.fn(async () => undefined),
        remind: vi.fn(),
    };
    const runtime = createRememberedSectionRuntime(ports, controller.signal);
    const emit: Fixture['emit'] = (target, type = 'childList', added = [], removed = []) => {
        const record = {target, type, addedNodes: added, removedNodes: removed} as unknown as MutationRecord;
        for (const observer of ControlledObserver.instances) observer.fire(record);
    };
    const event = (type: string): void => { document.dispatchEvent(new window.Event(type)); };
    return {document: ports.document, region: document.getElementById('region') as unknown as Element,
        outside: document.getElementById('outside') as unknown as Element, controller, ports, state, runtime, emit, event,
        visibility(value) { Object.defineProperty(document, 'visibilityState', {value, writable: true, configurable: true}); event('visibilitychange'); }};
}

beforeEach(() => {
    vi.useFakeTimers();
    ControlledObserver.instances = [];
    vi.stubGlobal('MutationObserver', ControlledObserver);
});
afterEach(() => {
    lifetimes.splice(0).forEach(controller => controller.abort());
    expect(vi.getTimerCount()).toBe(0);
    expect(ControlledObserver.instances.every(observer => observer.roots.size === 0)).toBe(true);
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

const tick = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(180); };

function reminder(f: Fixture, index = -1): {count: number; translate(): Promise<void>; dismiss(): void; signal: AbortSignal} {
    const [count, translate, dismiss, signal] = f.ports.remind.mock.calls.at(index)!;
    return {count, translate, dismiss, signal};
}

describe('记忆区域规则调度', () => {
    it.each([{rules: []}, {rules: [rule('other', 'auto', [['#region']], 'other.example')]}, {rules: [{...rule(), enabled: false}]}])('无命中规则时不创建观察器或计时器：%j', ({rules}) => {
        const f = fixture(rules);
        expect(ControlledObserver.instances).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(f.ports.resolve).not.toHaveBeenCalled();
        expect(f.ports.translate).not.toHaveBeenCalled();
    });

    it('已取消的生命周期不创建任何任务，后续refresh也无副作用', () => {
        const f = fixture([rule()], true, true);
        f.runtime.refresh(); f.visibility('visible');
        expect(ControlledObserver.instances).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('合并短时间变更并委托幂等ensure端口，动态段落只引发一轮补齐', async () => {
        const f = fixture();
        f.runtime.refresh(); f.runtime.refresh();
        expect(ControlledObserver.instances).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(1);
        await tick();
        expect(f.ports.translate).toHaveBeenCalledWith([f.region], f.state.rules[0], expect.any(AbortSignal));
        const next = f.document.createElement('p'); next.textContent = 'A newly appended paragraph'; f.region.append(next);
        for (let index = 0; index < 100; index++) f.emit(f.region, 'childList', [next]);
        expect(vi.getTimerCount()).toBe(1);
        await tick();
        expect(f.ports.translate).toHaveBeenCalledTimes(2);
        expect(f.ports.resolve).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('扩展工件变化和区域外计数不重新查询；区域正文或祖先可见性改变才调度', async () => {
        const f = fixture(); await tick();
        const owned = f.document.createElement('span'); owned.className = 'fluent-read-bilingual-content'; owned.setAttribute('data-fr-translation-owned', 'true');
        owned.textContent = '译文'; f.region.append(owned);
        f.emit(f.region, 'childList', [owned]); f.emit(owned.firstChild!, 'characterData'); f.emit(owned, 'attributes');
        f.emit(f.outside.firstChild!, 'characterData'); f.emit(f.outside, 'attributes');
        f.emit(f.outside, 'childList', [f.document.createTextNode('updated count')]);
        await tick(); expect(f.ports.resolve).toHaveBeenCalledOnce();
        f.emit(f.region.firstChild!.firstChild!, 'characterData'); await tick();
        expect(f.ports.resolve).toHaveBeenCalledTimes(2);
        f.emit(f.document.body, 'attributes'); await tick();
        expect(f.ports.resolve).toHaveBeenCalledTimes(3);
    });

    it('目标尚未出现时，插入元素或改写为目标id后会重新定位', async () => {
        const f = fixture([rule('late', 'auto', [['#late']])]); await tick();
        expect(f.ports.translate).not.toHaveBeenCalled();
        f.outside.id = 'late'; f.emit(f.outside, 'attributes'); await tick();
        expect(f.ports.translate).toHaveBeenCalledWith([f.outside], expect.anything(), expect.any(AbortSignal));
        f.outside.remove(); f.emit(f.document.body, 'childList', [], [f.outside]); await tick();
        const replacement = f.document.createElement('section'); replacement.id = 'late'; f.document.body.append(replacement);
        f.emit(f.document.body, 'childList', [replacement]); await tick();
        expect(f.ports.translate).toHaveBeenLastCalledWith([replacement], expect.anything(), expect.any(AbortSignal));
    });

    it('rechecks a saved child path when an existing parent gains its locator anchor', async () => {
        const f = fixture([rule('late-child', 'auto', [['[id="late"] > p:nth-of-type(1)']])]);
        await tick(); expect(f.ports.translate).not.toHaveBeenCalled();
        f.region.id = 'late';
        const record = {target:f.region, type:'attributes', attributeName:'id', oldValue:'region', addedNodes:[], removedNodes:[]} as unknown as MutationRecord;
        for (const observer of ControlledObserver.instances) observer.fire(record);
        await tick();
        expect(f.ports.translate).toHaveBeenCalledWith([f.region.firstElementChild], expect.anything(), expect.any(AbortSignal));
    });

    it('rechecks an ambiguous saved locator when one duplicate loses its id', async () => {
        const f = fixture(); f.outside.id = 'region'; await tick();
        expect(f.ports.translate).not.toHaveBeenCalled();
        f.outside.id = 'other';
        const record = {target:f.outside, type:'attributes', attributeName:'id', oldValue:'region', addedNodes:[], removedNodes:[]} as unknown as MutationRecord;
        for (const observer of ControlledObserver.instances) observer.fire(record);
        await tick(); expect(f.ports.translate).toHaveBeenCalledWith([f.region], expect.anything(), expect.any(AbortSignal));
    });

    it.each(['"', "'"])('rechecks ambiguity when a duplicate loses an empty attribute value quoted %s', async quote => {
        const f = fixture([rule('empty', 'auto', [[`[data-slot=${quote}${quote}]`]])]);
        f.region.setAttribute('data-slot', '');f.outside.setAttribute('data-slot', '');await tick();
        expect(f.ports.translate).not.toHaveBeenCalled();
        f.outside.setAttribute('data-slot', 'other');
        const record = {target:f.outside, type:'attributes', attributeName:'data-slot', oldValue:'', addedNodes:[], removedNodes:[]} as unknown as MutationRecord;
        for (const observer of ControlledObserver.instances) observer.fire(record);
        await tick();expect(f.ports.translate).toHaveBeenCalledWith([f.region], expect.anything(), expect.any(AbortSignal));
    });

    it('does not rescan for unrelated attribute churn while the saved path is missing', async () => {
        const f = fixture([rule('late', 'auto', [['[id="late"] > p:nth-of-type(1)']])]);
        await tick();expect(f.ports.resolve).toHaveBeenCalledOnce();
        for (let index = 0; index < 100; index++) {
            const record = {target:f.outside, type:'attributes', attributeName:'class', oldValue:'unrelated', addedNodes:[], removedNodes:[]} as unknown as MutationRecord;
            for (const observer of ControlledObserver.instances) observer.fire(record);
        }
        await tick();expect(f.ports.resolve).toHaveBeenCalledOnce();
    });

    it('does not mistake an unrelated short old class for a substring of the saved class', async () => {
        const f = fixture([rule('late', 'auto', [['article[class~="late"] > p:nth-of-type(1)']])]);
        await tick();
        const record = {target:f.outside, type:'attributes', attributeName:'class', oldValue:'a', addedNodes:[], removedNodes:[]} as unknown as MutationRecord;
        for (const observer of ControlledObserver.instances) observer.fire(record);
        await tick();expect(f.ports.resolve).toHaveBeenCalledOnce();
    });

    it.each([
        {selector:'article[class~="late"] > p', attribute:'class', old:' a '},
        {selector:'article[data-slot="late"] > p', attribute:'data-slot', old:'unrelated'},
    ])('ignores an unrelated old $attribute value while preserving its saved path', async ({selector, attribute, old}) => {
        const f = fixture([rule('late', 'auto', [[selector]])]);await tick();
        const record = {target:f.outside, type:'attributes', attributeName:attribute, oldValue:old, addedNodes:[], removedNodes:[]} as unknown as MutationRecord;
        for (const observer of ControlledObserver.instances) observer.fire(record);
        await tick();expect(f.ports.resolve).toHaveBeenCalledOnce();
    });

    it('rechecks a descendant when a previously hidden ancestor becomes visible', async () => {
        const f = fixture([rule('late', 'auto', [['[id="region"] > p:nth-of-type(1)']])]);
        const wrapper = f.document.createElement('div');wrapper.setAttribute('hidden', '');f.region.parentNode!.insertBefore(wrapper, f.region);wrapper.append(f.region);
        f.ports.resolve.mockImplementation((selectors, doc) => wrapper.hasAttribute('hidden') ? [] : [doc.querySelector(selectors[0][0])!]);
        await tick();expect(f.ports.translate).not.toHaveBeenCalled();
        wrapper.removeAttribute('hidden');
        const record = {target:wrapper, type:'attributes', attributeName:'hidden', oldValue:'', addedNodes:[], removedNodes:[]} as unknown as MutationRecord;
        for (const observer of ControlledObserver.instances) observer.fire(record);
        await tick();expect(f.ports.translate).toHaveBeenCalledWith([f.region.firstElementChild], expect.anything(), expect.any(AbortSignal));
    });

    it('keeps escaped locator anchors intact while detecting a parent attribute change', async () => {
        const f = fixture([rule('escaped', 'auto', [['#late\\-anchor > p:nth-of-type(1)']])]);
        await tick();expect(f.ports.translate).not.toHaveBeenCalled();
        f.region.id = 'late-anchor';
        const record = {target:f.region, type:'attributes', attributeName:'id', oldValue:'region', addedNodes:[], removedNodes:[]} as unknown as MutationRecord;
        for (const observer of ControlledObserver.instances) observer.fire(record);
        await tick();expect(f.ports.translate).toHaveBeenCalledWith([f.region.firstElementChild], expect.anything(), expect.any(AbortSignal));
    });

    it('按具体路径优先，重叠区域仅交给先命中的规则', async () => {
        const f = fixture([rule('wide', 'auto', [['#region']]), rule('specific', 'auto', [['#region > p']], 'example.com/docs/')]);
        await tick();
        expect(f.ports.translate).toHaveBeenCalledOnce();
        expect(f.ports.translate.mock.calls[0][1].id).toBe('specific');
        expect(f.ports.translate.mock.calls[0][0]).toEqual([f.region.firstElementChild]);
    });

    it('提醒模式不自动发请求，重复扫描不重复提示，点击期间不重入且失败可显式重试', async () => {
        const f = fixture([rule('remind', 'remind')]); await tick();
        expect(f.ports.translate).not.toHaveBeenCalled();
        const notice = reminder(f); expect(notice.count).toBe(1);
        f.emit(f.region.firstChild!.firstChild!, 'characterData'); await tick();
        expect(f.ports.remind).toHaveBeenCalledOnce();
        let finish!: () => void;
        f.ports.translate.mockImplementationOnce(() => new Promise<void>(resolve => {finish = resolve;}));
        const click = notice.translate(); await notice.translate();
        expect(f.ports.translate).toHaveBeenCalledOnce(); finish(); await click;
        f.ports.translate.mockRejectedValueOnce(new Error('provider failure'));
        await expect(notice.translate()).rejects.toThrow('provider failure');
        f.ports.translate.mockResolvedValue(undefined); await notice.translate();
        expect(f.ports.translate).toHaveBeenCalledTimes(3);
        expect(notice.signal.aborted).toBe(false);
    });

    it('提醒数量变化先撤旧提示，区域消失撤销提示且旧点击无效', async () => {
        const f = fixture([rule('remind', 'remind', [['#region'], ['#second']])]); await tick();
        const first = reminder(f);
        const second = f.document.createElement('section'); second.id = 'second'; f.document.body.append(second);
        f.emit(f.document.body, 'childList', [second]); await tick();
        expect(first.signal.aborted).toBe(true); expect(reminder(f).count).toBe(2);
        const latest = reminder(f); f.region.remove(); second.remove();
        f.emit(f.document.body, 'childList', [], [f.region, second]); await tick();
        expect(latest.signal.aborted).toBe(true); await first.translate(); await latest.translate();
        expect(f.ports.translate).not.toHaveBeenCalled();
    });

    it('关闭提醒在当前路由保持，进入新路由后可以再次提醒', async () => {
        const f = fixture([rule('remind', 'remind')]); await tick();
        const notice = reminder(f); notice.dismiss();
        expect(notice.signal.aborted).toBe(true);
        f.emit(f.region.firstChild!.firstChild!, 'characterData'); await tick();
        f.state.rules = [{...f.state.rules[0], site: 'example.com/docs/'}]; f.runtime.refresh(); await tick();
        expect(f.ports.remind).toHaveBeenCalledOnce();
        f.state.href = 'https://example.com/docs/two'; f.event('fluentread-route-change'); await tick();
        expect(f.ports.remind).toHaveBeenCalledTimes(2);
    });

    it.each(['pause', 'restore', 'full-page'] as const)('手动%s暂停本页规则，配置变化和显隐不能重新启动，新路由可恢复', async mode => {
        const f = fixture(); await tick();
        if (mode === 'pause') f.runtime.pause(); else f.event(mode === 'restore' ? 'fluentread-translation-ended' : 'fluentread-translation-started');
        const signal = f.ports.translate.mock.calls[0][2] as AbortSignal; expect(signal.aborted).toBe(true);
        f.state.rules = [{...rule(), selectors: [['#region > p']]}]; f.runtime.refresh();
        f.visibility('hidden'); f.visibility('visible'); await tick();
        expect(f.ports.translate).toHaveBeenCalledOnce();
        f.state.href = 'https://example.com/docs/two'; f.event('fluentread-route-change'); await tick();
        expect(f.ports.translate).toHaveBeenCalledTimes(2);
    });

    it('路由或保存规则变化立即取消旧代次，过期未决操作完成后仅运行最新规则', async () => {
        const f = fixture();
        let finish!: () => void; f.ports.translate.mockImplementationOnce(() => new Promise<void>(resolve => {finish = resolve;}));
        await tick(); const firstSignal = f.ports.translate.mock.calls[0][2] as AbortSignal;
        f.state.href = 'https://example.com/docs/two'; f.event('fluentread-route-change');
        expect(firstSignal.aborted).toBe(true);
        f.state.rules = [rule('latest', 'auto', [['#outside']])]; f.runtime.refresh();
        await tick(); expect(f.ports.translate).toHaveBeenCalledOnce();
        finish(); await Promise.resolve(); await tick();
        expect(f.ports.translate).toHaveBeenCalledTimes(2);
        expect(f.ports.translate.mock.calls[1][1].id).toBe('latest');
        expect(f.ports.translate.mock.calls[1][2].aborted).toBe(false);
    });

    it('隐藏时取消正在派发的区域和提醒，显示后使用新信号重新补齐', async () => {
        const f = fixture([rule(), rule('remind', 'remind', [['#outside']])]); await tick();
        const signal = f.ports.translate.mock.calls[0][2] as AbortSignal, notice = reminder(f);
        f.visibility('hidden'); expect(signal.aborted).toBe(true); expect(notice.signal.aborted).toBe(true);
        f.emit(f.region, 'attributes'); await tick(); expect(f.ports.translate).toHaveBeenCalledOnce();
        f.visibility('visible'); f.visibility('visible'); await tick();
        expect(f.ports.translate).toHaveBeenCalledTimes(2);
        expect(f.ports.translate.mock.calls[1][2]).not.toBe(signal);
        expect(ControlledObserver.instances.filter(observer => observer.roots.size > 0)).toHaveLength(1);
    });

    it('初始隐藏不创建观察器，显示后才首次派发；总开关的refresh参与生命周期身份', async () => {
        const f = fixture([rule()], false); expect(ControlledObserver.instances).toHaveLength(0); await tick();
        f.visibility('visible'); await tick(); expect(f.ports.translate).toHaveBeenCalledOnce();
        f.state.enabled = false; f.runtime.refresh(); await tick();
        expect((f.ports.translate.mock.calls[0][2] as AbortSignal).aborted).toBe(true);
        f.state.enabled = true; f.runtime.refresh(); await tick(); expect(f.ports.translate).toHaveBeenCalledTimes(2);
    });

    it('执行期间的多次变化只标记一轮后续补齐，卸载断开观察和所有计时器', async () => {
        const f = fixture();
        let finish!: () => void; f.ports.translate.mockImplementationOnce(() => new Promise<void>(resolve => {finish = resolve;}));
        await tick();
        for (let index = 0; index < 20; index++) f.emit(f.region.firstChild!.firstChild!, 'characterData');
        await tick(); expect(f.ports.translate).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
        finish(); await Promise.resolve(); await tick(); expect(f.ports.translate).toHaveBeenCalledTimes(2);
        f.emit(f.region, 'attributes'); expect(vi.getTimerCount()).toBe(1);
        f.controller.abort(); expect(vi.getTimerCount()).toBe(0);
        f.runtime.refresh(); f.event('fluentread-route-change'); await tick(); expect(f.ports.translate).toHaveBeenCalledTimes(2);
    });

    it('现有开放ShadowRoot中的正文晚插入可发现，组件替换后释放旧根观察', async () => {
        const f = fixture([rule('shadow', 'auto', [['#component', '#inside']])]);
        const host = f.document.createElement('custom-article'); host.id = 'component';
        const shadow = host.attachShadow({mode: 'open'}); f.document.body.append(host);
        await tick(); expect(f.ports.translate).not.toHaveBeenCalled();
        expect(ControlledObserver.instances[0].roots.has(shadow)).toBe(true);
        const text = f.document.createElement('article'); text.id = 'inside'; shadow.append(text);
        f.emit(shadow, 'childList', [text]); await tick(); expect(f.ports.translate.mock.calls[0][0]).toEqual([text]);
        const replacement = f.document.createElement('custom-article'); replacement.id = 'component';
        const nextShadow = replacement.attachShadow({mode: 'open'}); nextShadow.innerHTML = '<article id="inside">Next</article>';
        host.replaceWith(replacement); f.emit(f.document.body, 'childList', [replacement], [host]); await tick();
        const active = ControlledObserver.instances.find(observer => observer.roots.size > 0)!;
        expect(active.roots.has(shadow)).toBe(false); expect(active.roots.has(nextShadow)).toBe(true);
        expect(f.ports.translate).toHaveBeenCalledTimes(2);
    });

    it('自动端口失败不会产生未处理拒绝或无变更重试循环', async () => {
        const f = fixture(); f.ports.translate.mockRejectedValue(new Error('failed'));
        await tick(); await tick(); expect(f.ports.translate).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    });
    it('规则路径属性会被观察，错误CSS安全忽略，尚无ShadowRoot的host等待宿主拓扑变化', async () => {
        const f = fixture([rule('attr', 'auto', [['[data-slot="content"]']]), rule('broken', 'auto', [['[', '#missing']])]);
        f.ports.resolve.mockReturnValue([]);
        await tick();
        expect(ControlledObserver.instances[0].observe.mock.calls[0][1].attributeFilter).toContain('data-slot');
        f.emit(f.outside, 'attributes'); await tick();
        expect(f.ports.translate).not.toHaveBeenCalled();
        f.state.rules = [rule('missing-shadow', 'auto', [['#absent', '#inner']])]; f.runtime.refresh(); await tick();
        f.state.rules = [rule('missing-shadow', 'auto', [['#outside', '#inner']])]; f.runtime.refresh(); await tick();
        expect(f.ports.translate).not.toHaveBeenCalled();
    });

    it('区域外Shadow文本越过host时仍不触发查询，关联祖先属性跨ShadowRoot可触发', async () => {
        const f = fixture([rule('shadow', 'auto', [['#component', '#inside']])]);
        const host = f.document.createElement('custom-article'); host.id = 'component';
        const shadow = host.attachShadow({mode: 'open'}); shadow.innerHTML = '<p id="inside">inside</p><p id="unused">outside</p>'; f.document.body.append(host);
        await tick(); expect(f.ports.resolve).toHaveBeenCalledOnce();
        f.emit(shadow.querySelector('#unused')!.firstChild!, 'characterData'); await tick(); expect(f.ports.resolve).toHaveBeenCalledOnce();
        f.emit(f.document.body, 'attributes'); await tick(); expect(f.ports.resolve).toHaveBeenCalledTimes(2);
    });

    it('提醒未刷新前目标已经消失时点击不请求；多条提醒中路由变化取消剩余规则', async () => {
        const f = fixture([rule('remind-a', 'remind'), rule('remind-b', 'remind', [['#outside']])]); await tick();
        const notice = reminder(f); f.region.remove(); f.outside.remove(); await notice.translate();
        expect(f.ports.translate).not.toHaveBeenCalled();
        f.document.body.append(f.region, f.outside);
        let finish!: () => void; f.ports.translate.mockImplementationOnce(() => new Promise<void>(resolve => {finish = resolve;}));
        const click = notice.translate(); f.state.href = 'https://example.com/new'; f.runtime.refresh(); finish(); await click;
        expect(f.ports.translate).toHaveBeenCalledOnce();
    });

    it.each([false, true])('耗时规则会让出事件循环，卸载可取消让帧计时器：%s', async cancel => {
        const f = fixture([rule('first'), rule('second', 'auto', [['#outside']])]);
        let stamp = 0; vi.spyOn(performance, 'now').mockImplementation(() => stamp += 9);
        await tick(); expect(f.ports.translate).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(1);
        if (cancel) f.controller.abort();
        await vi.runAllTimersAsync();
        expect(f.ports.translate).toHaveBeenCalledTimes(cancel ? 1 : 2);
    });

    it('未同步的禁用状态阻止已排队与新观察触发的操作', async () => {
        const f = fixture(); f.state.enabled = false; await tick(); expect(f.ports.resolve).not.toHaveBeenCalled();
        f.emit(f.region, 'attributes'); await tick(); expect(f.ports.resolve).not.toHaveBeenCalled();
    });

    it('多规则自动执行中变更路由不派发旧列表后续区域', async () => {
        const f = fixture([rule('first'), rule('second', 'auto', [['#outside']])]);
        let finish!: () => void; f.ports.translate.mockImplementationOnce(() => new Promise<void>(resolve => {finish = resolve;}));
        await tick(); f.state.href = 'https://other.example/'; f.runtime.refresh(); finish(); await Promise.resolve(); await tick();
        expect(f.ports.translate).toHaveBeenCalledOnce();
    });

    it('耗时区域结束前页面隐藏时不再安排下一时间片', async () => {
        const f = fixture(); let stamp = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => stamp += 9);
        f.ports.translate.mockImplementation(async () => { f.visibility('hidden'); });
        await tick(); expect(f.ports.translate).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    });

});
