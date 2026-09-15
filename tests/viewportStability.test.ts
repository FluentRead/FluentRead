import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {
    createFullPageScrollController,
    withFullPageViewportAnchor,
} from '@/src/features/full-page-translation/content/viewportStability';

const replacedGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>();

function replaceGlobal(name: PropertyKey, value: unknown): void {
    if (!replacedGlobals.has(name)) replacedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
}

describe('全文翻译视口稳定性', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        const {window, document} = parseHTML('<html><body></body></html>');
        replaceGlobal('window', window);
        replaceGlobal('document', document);
        replaceGlobal('Node', window.Node);
        replaceGlobal('Element', window.Element);
        replaceGlobal('HTMLElement', window.HTMLElement);
        Object.defineProperty(window, 'setTimeout', {configurable: true, value: globalThis.setTimeout});
        Object.defineProperty(window, 'clearTimeout', {configurable: true, value: globalThis.clearTimeout});
        Object.defineProperty(window, 'innerWidth', {configurable: true, value: 1280});
        Object.defineProperty(window, 'innerHeight', {configurable: true, value: 900});
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        for (const [name, descriptor] of replacedGlobals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
        replacedGlobals.clear();
    });

    it('没有命中测试 API 时保持 callback，并在文档滚动中补偿锚点位移', () => {
        const {document, window} = globalThis as unknown as {document: Document; window: Window & typeof globalThis};
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: undefined});
        expect(withFullPageViewportAnchor(() => 'ok')).toBe('ok');
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: () => undefined});
        expect(withFullPageViewportAnchor(() => 'no-anchor')).toBe('no-anchor');
        Object.defineProperty(document, 'elementFromPoint', {
            configurable: true,
            value: () => ({nodeType: 1, tagName: 'P', style: undefined}),
        });
        expect(withFullPageViewportAnchor(() => 'invalid-anchor')).toBe('invalid-anchor');

        const anchor = document.createElement('p');
        document.body.appendChild(anchor);
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: () => anchor});
        let reads = 0;
        Object.defineProperty(anchor, 'getBoundingClientRect', {
            configurable: true,
            value: () => {
                reads += 1;
                const top = reads % 2 === 1 ? 120 : 156;
                return {width: 400, height: 40, top, right: 400, bottom: top + 40, left: 0, x: 0, y: top};
            },
        });
        const scrollBy = vi.fn();
        Object.defineProperty(window, 'scrollBy', {configurable: true, value: scrollBy});

        expect(withFullPageViewportAnchor(() => 7)).toBe(7);
        expect(scrollBy).toHaveBeenCalledWith(0, 36);
    });

    it('优先调整可滚动祖先，并跳过被排除、扩展产物、零尺寸和异常锚点', () => {
        const {document, window} = globalThis as unknown as {document: Document; window: Window & typeof globalThis};
        const scroller = document.createElement('div');
        scroller.style.overflowY = 'auto';
        Object.defineProperty(scroller, 'scrollHeight', {configurable: true, value: 300});
        Object.defineProperty(scroller, 'clientHeight', {configurable: true, value: 100});
        scroller.scrollTop = 10;
        const anchor = document.createElement('p');
        scroller.appendChild(anchor);
        document.body.appendChild(scroller);
        Object.defineProperty(window, 'getComputedStyle', {
            configurable: true,
            value: (element: Element) => ({overflowY: element === scroller ? 'auto' : ''}),
        });
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: () => anchor});
        let reads = 0;
        Object.defineProperty(anchor, 'getBoundingClientRect', {
            configurable: true,
            value: () => {
                reads += 1;
                const top = reads % 2 === 1 ? 80 : 125;
                return {width: 400, height: 40, top, right: 400, bottom: top + 40, left: 0, x: 0, y: top};
            },
        });
        const scrollBy = vi.fn();
        Object.defineProperty(window, 'scrollBy', {configurable: true, value: scrollBy});
        withFullPageViewportAnchor(() => undefined);
        expect(scroller.scrollTop).toBe(55);
        expect(scrollBy).not.toHaveBeenCalled();

        const wrapper = document.createElement('div');
        const nestedAnchor = document.createElement('p');
        wrapper.appendChild(nestedAnchor);
        document.body.appendChild(wrapper);
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: () => nestedAnchor});
        Object.defineProperty(nestedAnchor, 'getBoundingClientRect', {
            configurable: true,
            value: () => ({width: 300, height: 30, top: 80, right: 300, bottom: 110, left: 0, x: 0, y: 80}),
        });
        expect(withFullPageViewportAnchor(() => undefined)).toBeUndefined();

        const brokenStyleWrapper = document.createElement('div');
        const brokenStyleAnchor = document.createElement('p');
        brokenStyleWrapper.appendChild(brokenStyleAnchor);
        document.body.appendChild(brokenStyleWrapper);
        // 只有溢出的祖先才会去取计算样式，异常必须被祖先查找吞掉。
        Object.defineProperty(brokenStyleWrapper, 'scrollHeight', {configurable: true, value: 300});
        Object.defineProperty(brokenStyleWrapper, 'clientHeight', {configurable: true, value: 100});
        Object.defineProperty(window, 'getComputedStyle', {
            configurable: true,
            value: () => { throw new Error('style'); },
        });
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: () => brokenStyleAnchor});
        Object.defineProperty(brokenStyleAnchor, 'getBoundingClientRect', {
            configurable: true,
            value: () => ({width: 200, height: 20, top: 60, right: 200, bottom: 80, left: 0, x: 0, y: 60}),
        });
        expect(withFullPageViewportAnchor(() => undefined)).toBeUndefined();

        const zero = document.createElement('p');
        document.body.appendChild(zero);
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: () => zero});
        Object.defineProperty(zero, 'getBoundingClientRect', {
            configurable: true,
            value: () => ({width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, x: 0, y: 0}),
        });
        expect(withFullPageViewportAnchor(() => undefined)).toBeUndefined();

        const excludedParent = document.createElement('div');
        const excluded = document.createElement('span');
        excludedParent.appendChild(excluded);
        document.body.appendChild(excludedParent);
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: () => excluded});
        Object.defineProperty(excludedParent, 'getBoundingClientRect', {
            configurable: true,
            value: () => ({width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, x: 0, y: 0}),
        });
        expect(withFullPageViewportAnchor(() => undefined, [excluded])).toBeUndefined();

        const artifact = document.createElement('span');
        artifact.setAttribute('data-fr-translation-owned', 'true');
        document.body.appendChild(artifact);
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: () => artifact});
        expect(withFullPageViewportAnchor(() => undefined)).toBeUndefined();

        const broken = document.createElement('p');
        document.body.appendChild(broken);
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: () => broken});
        Object.defineProperty(broken, 'getBoundingClientRect', {configurable: true, value: () => { throw new Error('layout'); }});
        expect(withFullPageViewportAnchor(() => undefined)).toBeUndefined();
    });

    it('innerHeight 为零时仍安全计算 elementFromPoint 的回退坐标', () => {
        const {document, window} = globalThis as unknown as {document: Document; window: Window & typeof globalThis};
        const anchor = document.createElement('p');
        document.body.appendChild(anchor);
        Object.defineProperty(window, 'innerHeight', {configurable: true, value: 0});
        Object.defineProperty(window, 'innerWidth', {configurable: true, value: 0});
        const hitTest = vi.fn(() => anchor);
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: hitTest});
        Object.defineProperty(anchor, 'getBoundingClientRect', {
            configurable: true,
            value: () => ({width: 300, height: 30, top: 90, right: 300, bottom: 120, left: 0, x: 0, y: 90}),
        });

        expect(withFullPageViewportAnchor(() => 'safe')).toBe('safe');
        expect(hitTest).toHaveBeenCalledWith(0, 0);
    });

    it('异常/无位移/无 scrollBy 时不阻断翻译 callback', () => {
        const {document, window} = globalThis as unknown as {document: Document; window: Window & typeof globalThis};
        const anchor = document.createElement('p');
        document.body.appendChild(anchor);
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: () => anchor});
        Object.defineProperty(anchor, 'getBoundingClientRect', {
            configurable: true,
            value: () => ({width: 300, height: 30, top: 90, right: 300, bottom: 120, left: 0, x: 0, y: 90}),
        });
        Object.defineProperty(window, 'scrollBy', {configurable: true, value: undefined});
        expect(withFullPageViewportAnchor(() => 1)).toBe(1);

        Object.defineProperty(anchor, 'getBoundingClientRect', {
            configurable: true,
            value: () => ({width: 300, height: 30, top: 90, right: 300, bottom: 120, left: 0, x: 0, y: 90}),
        });
        expect(withFullPageViewportAnchor(() => anchor.remove())).toBeUndefined();

        document.body.appendChild(anchor);
        Object.defineProperty(anchor, 'getBoundingClientRect', {
            configurable: true,
            value: () => {
                if ((anchor as unknown as {reads?: number}).reads) throw new Error('restore layout');
                (anchor as unknown as {reads: number}).reads = 1;
                return {width: 300, height: 30, top: 90, right: 300, bottom: 120, left: 0, x: 0, y: 90};
            },
        });
        expect(withFullPageViewportAnchor(() => undefined)).toBeUndefined();
    });

    it('嵌套锚点只测量一次，内层写入沿用最外层补偿', () => {
        const {document, window} = globalThis as unknown as {document: Document; window: Window & typeof globalThis};
        const anchor = document.createElement('p');
        document.body.appendChild(anchor);
        let hits = 0;
        Object.defineProperty(document, 'elementFromPoint', {
            configurable: true,
            value: () => { hits += 1; return anchor; },
        });
        let reads = 0;
        Object.defineProperty(anchor, 'getBoundingClientRect', {
            configurable: true,
            value: () => {
                reads += 1;
                const top = reads === 1 ? 80 : 130;
                return {width: 400, height: 40, top, right: 400, bottom: top + 40, left: 0, x: 0, y: top};
            },
        });
        const scrollBy = vi.fn();
        Object.defineProperty(window, 'scrollBy', {configurable: true, value: scrollBy});

        const result = withFullPageViewportAnchor(() =>
            withFullPageViewportAnchor(() => withFullPageViewportAnchor(() => 'nested')));

        expect(result).toBe('nested');
        // 命中测试与补偿各只发生一次，内层调用不再重复捕获锚点。
        expect(hits).toBe(1);
        expect(scrollBy).toHaveBeenCalledTimes(1);
        expect(scrollBy).toHaveBeenCalledWith(0, 50);

        // 嵌套结束后深度归零，后续顶层调用仍正常捕获。
        withFullPageViewportAnchor(() => undefined);
        expect(hits).toBe(2);
    });

    it.each([
        {name: '页首', scrollY: 0, top: 50, bottom: 90, expected: 0},
        {name: '可见正文', scrollY: 250, top: 50, bottom: 90, expected: 0},
        {name: '跨过视口上沿的正文', scrollY: 250, top: -20, bottom: 90, expected: 0},
        {name: '视口下方', scrollY: 250, top: 1000, bottom: 1040, expected: 0},
        {name: '完全位于视口上方', scrollY: 250, top: -100, bottom: -60, expected: 1},
    ])('$name 的译文插入只在影响屏外上方内容时补偿', ({scrollY, top, bottom, expected}) => {
        const changed = document.createElement('p');
        const anchor = document.createElement('p');
        document.body.append(changed, anchor);
        Object.defineProperty(window, 'scrollY', {configurable: true, value: scrollY});
        const hitTest = vi.fn(() => anchor);
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: hitTest});
        Object.defineProperty(changed, 'getBoundingClientRect', {value: () => ({width: 200, height: 40, top, bottom})});
        let after = false;
        Object.defineProperty(anchor, 'getBoundingClientRect', {value: () => ({width: 200, height: 40, top: after ? 445 : 400})});
        const scrollBy = vi.fn();
        Object.defineProperty(window, 'scrollBy', {configurable: true, value: scrollBy});
        withFullPageViewportAnchor(() => { after = true; }, [changed]);
        expect(scrollBy).toHaveBeenCalledTimes(expected);
        if (expected) expect(scrollBy).toHaveBeenCalledWith(0, 45);
        // 页面内逐段写入最常见；不可能补偿时不能为每次写入付出命中测试与强制布局。
        expect(hitTest).toHaveBeenCalledTimes(expected);
    });

    it('可能补偿的变化仍需锚点与变化同属一个已滚动视口，命中变化自身时不以其祖先为锚点', () => {
        const scroller = document.createElement('div');
        const changed = document.createElement('p');
        const documentAnchor = document.createElement('p');
        scroller.append(changed);
        document.body.append(scroller, documentAnchor);
        Object.defineProperties(scroller, {
            scrollHeight: {value: 1000}, clientHeight: {value: 200}, clientTop: {value: 0},
            getBoundingClientRect: {value: () => ({top: 100})},
        });
        scroller.scrollTop = 300;
        Object.defineProperty(window, 'getComputedStyle', {configurable: true, value: (element: Element) => ({overflowY: element === scroller ? 'auto' : 'visible'})});
        Object.defineProperty(window, 'scrollY', {configurable: true, value: 0});
        Object.defineProperty(changed, 'getBoundingClientRect', {value: () => ({width: 200, height: 40, top: 20, bottom: 60})});
        let after = false;
        Object.defineProperty(documentAnchor, 'getBoundingClientRect', {value: () => ({width: 200, height: 40, top: after ? 480 : 400})});
        const scrollBy = vi.fn();
        Object.defineProperty(window, 'scrollBy', {configurable: true, value: scrollBy});

        // 变化在内层滚动面上方，但锚点属于尚在页首的文档滚动面：不能跨滚动面补偿。
        const documentHit = vi.fn(() => documentAnchor);
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: documentHit});
        withFullPageViewportAnchor(() => { after = true; }, [changed]);
        expect(documentHit).toHaveBeenCalled();
        expect(scrollBy).not.toHaveBeenCalled();
        expect(scroller.scrollTop).toBe(300);

        // 命中的就是变化节点时，其祖先都包含该变化，不能作为稳定锚点。
        after = false;
        const changedHit = vi.fn(() => changed);
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: changedHit});
        withFullPageViewportAnchor(() => { after = true; }, [changed]);
        expect(changedHit).toHaveBeenCalledTimes(3);
        expect(scroller.scrollTop).toBe(300);
        expect(scrollBy).not.toHaveBeenCalled();
    });

    it('变化节点几何读取异常时回到完整锚点路径，且不阻断写入', () => {
        const changed = document.createElement('p');
        const anchor = document.createElement('p');
        document.body.append(changed, anchor);
        Object.defineProperty(window, 'scrollY', {configurable: true, value: 250});
        const hitTest = vi.fn(() => anchor);
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: hitTest});
        Object.defineProperty(changed, 'getBoundingClientRect', {value: () => { throw new Error('detached layout'); }});
        Object.defineProperty(anchor, 'getBoundingClientRect', {value: () => ({width: 200, height: 40, top: 400})});
        const scrollBy = vi.fn();
        Object.defineProperty(window, 'scrollBy', {configurable: true, value: scrollBy});
        expect(withFullPageViewportAnchor(() => 'written', [changed])).toBe('written');
        expect(hitTest).toHaveBeenCalled();
        expect(scrollBy).not.toHaveBeenCalled();
    });

    it('整页恢复保住上沿原文，不抵消屏幕下半部译文的收缩', () => {
        const topAnchor = document.createElement('p');
        const middleAnchor = document.createElement('p');
        document.body.append(topAnchor, middleAnchor);
        Object.defineProperty(window, 'scrollY', {configurable: true, value: 250});
        Object.defineProperty(document, 'elementFromPoint', {
            configurable: true, value: (_x: number, y: number) => y < 40 ? topAnchor : middleAnchor,
        });
        let restored = false;
        Object.defineProperty(topAnchor, 'getBoundingClientRect', {value: () => ({width: 200, height: 40, top: 5})});
        Object.defineProperty(middleAnchor, 'getBoundingClientRect', {
            value: () => ({width: 200, height: 40, top: restored ? 250 : 400}),
        });
        const scrollBy = vi.fn();
        Object.defineProperty(window, 'scrollBy', {configurable: true, value: scrollBy});
        withFullPageViewportAnchor(() => { restored = true; });
        expect(scrollBy).not.toHaveBeenCalled();
    });

    it('内层滚动面只补偿同一容器上方的变化，并按边框内沿判断可见性', () => {
        const scroller = document.createElement('div');
        const changed = document.createElement('p');
        const anchor = document.createElement('p');
        const outside = document.createElement('p');
        scroller.append(changed, anchor);
        document.body.append(scroller, outside);
        Object.defineProperties(scroller, {
            scrollHeight: {value: 1000}, clientHeight: {value: 200}, clientTop: {value: 2},
            getBoundingClientRect: {value: () => ({top: 100})},
        });
        Object.defineProperty(window, 'getComputedStyle', {configurable: true, value: () => ({overflowY: 'auto'})});
        Object.defineProperty(window, 'scrollY', {configurable: true, value: 0});
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: () => anchor});
        let after = false;
        let bottom = 102;
        Object.defineProperty(changed, 'getBoundingClientRect', {value: () => ({width: 200, height: 40, bottom})});
        Object.defineProperty(outside, 'getBoundingClientRect', {configurable: true, value: () => ({width: 200, height: 40, bottom: -10})});
        Object.defineProperty(anchor, 'getBoundingClientRect', {value: () => ({width: 200, height: 40, top: after ? 195 : 150})});
        const mutate = (nodes: Node[], initial = 100) => {
            after = false;
            scroller.scrollTop = initial;
            withFullPageViewportAnchor(() => { after = true; }, nodes);
            return scroller.scrollTop;
        };
        expect(mutate([changed])).toBe(145);
        expect(mutate([changed], 0)).toBe(0);
        bottom = 103;
        expect(mutate([changed])).toBe(100);
        expect(mutate([outside])).toBe(100);
        // 文本节点按所在段落判断；脱离页面和无尺寸内容不能触发补偿。
        changed.textContent = 'A paragraph above the viewport';
        bottom = 102;
        expect(mutate([changed.firstChild!])).toBe(145);
        expect(mutate([document.createTextNode('detached')])).toBe(100);
        expect(mutate([document.createElement('p')])).toBe(100);
        Object.defineProperty(outside, 'getBoundingClientRect', {value: () => ({width: 0, height: 0, bottom: -10})});
        scroller.append(outside);
        expect(mutate([outside])).toBe(100);
    });

    it('滚动控制器只在活动会话中延迟目标，并在空闲时释放', async () => {
        let active = true;
        const onIdle = vi.fn();
        const afterIdle = vi.fn();
        const controller = createFullPageScrollController({
            isActive: () => active,
            onIdle,
            afterIdle,
        });
        const {document} = globalThis as unknown as {document: Document};
        const target = document.createElement('p');
        document.body.appendChild(target);

        expect(controller.isScrolling).toBe(false);
        expect(controller.defer(target)).toBe(false);
        controller.note();
        controller.note();
        expect(controller.isScrolling).toBe(true);
        expect(controller.defer(target)).toBe(true);
        expect(controller.defer(document.createElement('p'))).toBe(false);
        await vi.advanceTimersByTimeAsync(219);
        expect(onIdle).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(controller.isScrolling).toBe(false);
        expect(onIdle).toHaveBeenCalledWith([target]);
        expect(afterIdle).toHaveBeenCalledOnce();
        expect(controller.defer(target)).toBe(false);
        controller.dispose();
    });

    it('会话在滚动空闲前失活时不执行回调，dispose 可清理定时器', async () => {
        let active = true;
        const onIdle = vi.fn();
        const afterIdle = vi.fn();
        const controller = createFullPageScrollController({
            isActive: () => active,
            onIdle,
            afterIdle,
        });
        controller.note();
        active = false;
        await vi.advanceTimersByTimeAsync(220);
        expect(onIdle).not.toHaveBeenCalled();
        expect(afterIdle).not.toHaveBeenCalled();
        expect(controller.isScrolling).toBe(true);
        controller.dispose();
        active = true;
        controller.note();
        controller.dispose();
        expect(controller.isScrolling).toBe(false);
        active = false;
        controller.note();
        expect(controller.isScrolling).toBe(false);
    });
});
