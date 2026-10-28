import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {
    createFullPageScrollController,
    withFullPageViewportAnchor,
    withFullPageRestorationAnchors,
} from '@/src/features/full-page-translation/content/viewportStability';
import {beginTranslation, markTranslationComplete, restoreAllTranslations, setBilingualContent}
    from '@/src/features/full-page-translation/content/state';

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
        restoreAllTranslations();
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
        expect(withFullPageRestorationAnchors(() => 'no-hit-test', [document.body])).toBe('no-hit-test');
        expect(withFullPageViewportAnchor(() => 'no-local-hit-test', [document.body])).toBe('no-local-hit-test');
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

    it('普通祖先不读取会强制布局的滚动尺寸，且保留回调的同步行为', () => {
        const {document} = globalThis;
        const article = document.createElement('article');
        const target = document.createElement('p');
        article.append(target); document.body.append(article);
        const geometryRead = vi.fn(() => 100);
        Object.defineProperties(article, {scrollHeight: {get: geometryRead}, clientHeight: {get: geometryRead}});
        replaceGlobal('getComputedStyle', () => ({overflowY: 'visible'}));
        replaceGlobal('scrollY', 0);
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: vi.fn(() => target)});
        expect(withFullPageViewportAnchor(() => 'written', [target])).toBe('written');
        expect(geometryRead).not.toHaveBeenCalled();
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

    it('变化节点几何读取异常时放弃推测补偿，且不阻断写入', () => {
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
        expect(hitTest).not.toHaveBeenCalled();
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

    it('500 个变化节点与三个候选只测量一次共享滚动祖先，不跨滚动面补偿', () => {
        const changedScroller = document.createElement('div');
        const anchorScroller = document.createElement('div');
        const anchor = document.createElement('p');
        anchorScroller.append(anchor);
        document.body.append(changedScroller, anchorScroller);
        const changed = Array.from({length: 500}, () => {
            const node = document.createElement('p');
            node.getBoundingClientRect = vi.fn(() => ({width: 200, height: 40, bottom: 60} as DOMRect));
            changedScroller.append(node);
            return node;
        });
        for (const scroller of [changedScroller, anchorScroller]) {
            Object.defineProperties(scroller, {
                scrollHeight: {get: vi.fn(() => 1000)}, clientHeight: {get: vi.fn(() => 200)},
                clientTop: {value: 2}, getBoundingClientRect: {value: vi.fn(() => ({top: 100}))},
            });
            scroller.scrollTop = 100;
        }
        const styles = vi.fn(() => ({overflowY: 'auto'}));
        Object.defineProperty(window, 'getComputedStyle', {configurable: true, value: styles});
        const hitTest = vi.fn(() => anchor);
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: hitTest});
        anchor.getBoundingClientRect = vi.fn(() => ({width: 200, height: 40, top: 150} as DOMRect));
        const scrollBy = vi.fn();
        Object.defineProperty(window, 'scrollBy', {configurable: true, value: scrollBy});
        withFullPageViewportAnchor(() => 'written', changed);
        expect(hitTest).toHaveBeenCalledTimes(3);
        expect(styles.mock.calls.length).toBeLessThanOrEqual(2);
        expect(anchor.getBoundingClientRect).not.toHaveBeenCalled();
        expect(changedScroller.scrollTop).toBe(100);
        expect(anchorScroller.scrollTop).toBe(100);
        expect(scrollBy).not.toHaveBeenCalled();
    });

    it('捕获中共享来源与滚动面几何，写入和下次捕获仍读取最新布局', () => {
        const scroller = document.createElement('div');
        const changed = document.createElement('p');
        const anchor = document.createElement('p');
        scroller.append(changed, anchor);
        document.body.append(scroller);
        const readScrollHeight = vi.fn(() => 1000);
        const readClientHeight = vi.fn(() => 200);
        const readScrollerRect = vi.fn(() => ({top: 100}));
        Object.defineProperties(scroller, {
            scrollHeight: {get: readScrollHeight}, clientHeight: {get: readClientHeight},
            clientTop: {value: 2}, getBoundingClientRect: {value: readScrollerRect},
        });
        scroller.scrollTop = 100;
        let overflowY = 'auto';
        const styles = vi.fn(() => ({overflowY}));
        Object.defineProperty(window, 'getComputedStyle', {configurable: true, value: styles});
        let windowY = 250;
        Object.defineProperty(window, 'scrollY', {configurable: true, get: () => windowY});
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: () => anchor});
        const changedRect = vi.fn(() => ({width: 200, height: 40, bottom: 60} as DOMRect));
        changed.getBoundingClientRect = changedRect;
        let after = false;
        anchor.getBoundingClientRect = vi.fn(() => ({width: 200, height: 40,
            top: (after ? 195 : 150) - (overflowY === 'auto' ? scroller.scrollTop - 100 : windowY - 250)} as DOMRect));
        withFullPageViewportAnchor(() => {after = true;}, [changed]);
        expect(scroller.scrollTop).toBe(145);
        expect(styles).toHaveBeenCalledTimes(2);
        expect(readScrollHeight).toHaveBeenCalledTimes(2);
        expect(readClientHeight).toHaveBeenCalledTimes(2);
        expect(readScrollerRect).toHaveBeenCalledTimes(3);
        expect(changedRect).toHaveBeenCalledTimes(1);
        expect(anchor.getBoundingClientRect).toHaveBeenCalledTimes(3);

        // 下轮宿主解除内层滚动，按文档滚动面重新判断，不能沿用上一轮祖先缓存。
        overflowY = 'visible';
        changedRect.mockReturnValue({width: 200, height: 40, bottom: -10} as DOMRect);
        after = false;
        const scrollBy = vi.fn((_x: number, offset: number) => {windowY += offset;});
        Object.defineProperty(window, 'scrollBy', {configurable: true, value: scrollBy});
        withFullPageViewportAnchor(() => {after = true;}, [changed]);
        expect(scrollBy).toHaveBeenCalledWith(0, 45);
        expect(scroller.scrollTop).toBe(145);
        expect(styles).toHaveBeenCalledTimes(4);
        expect(changedRect).toHaveBeenCalledTimes(2);
        expect(anchor.getBoundingClientRect).toHaveBeenCalledTimes(6);
    });

    it.each([
        {documentY: 100, secondTop: 200}, {documentY: 0, secondTop: 200},
        {documentY: 100, secondTop: 0}, {documentY: 0, secondTop: 0},
    ])('全量恢复分别保护文档与两个内层滚动面，页首保持原位：%j', ({documentY, secondTop}) => {
        const rootOwner = document.createElement('p');
        const rootAnchor = document.createElement('p');
        const scrollers = [document.createElement('div'), document.createElement('div')];
        const owners = [rootOwner, ...scrollers.map(() => document.createElement('p'))];
        const anchors = scrollers.map(() => document.createElement('p'));
        document.body.append(rootOwner, rootAnchor, ...scrollers);
        scrollers.forEach((scroller, index) => scroller.append(owners[index + 1], anchors[index]));
        const wrappers = owners.map(owner => {
            owner.textContent = 'Source above the reading position.';
            const attempt = beginTranslation(owner, 'bilingual')!;
            markTranslationComplete(owner, attempt.state, attempt.generation);
            const wrapper = document.createElement('span');
            wrapper.className = 'fluent-read-bilingual-content';
            wrapper.setAttribute('data-fr-translation-owned', 'true');
            wrapper.textContent = '译文';
            owner.append(wrapper);setBilingualContent(owner, wrapper);
            return wrapper;
        });
        let windowY = documentY;
        Object.defineProperty(window, 'scrollY', {configurable: true, get: () => windowY});
        const scrollBy = vi.fn((_x: number, offset: number) => {windowY += offset;});
        Object.defineProperty(window, 'scrollBy', {configurable: true, value: scrollBy});
        Object.defineProperty(window, 'getComputedStyle', {configurable: true,
            value: (element: HTMLElement) => ({overflowY: scrollers.some(scroller => scroller === element) ? 'auto' : 'visible'})});
        const documentShift = () => (wrappers[0].isConnected ? 0 : -20) - (windowY - documentY);
        rootAnchor.getBoundingClientRect = () => ({width: 200, height: 40, top: 5 + documentShift()} as DOMRect);
        scrollers.forEach((scroller, index) => {
            scroller.scrollTop = index === 0 ? 200 : secondTop;
            const initial = scroller.scrollTop;
            Object.defineProperties(scroller, {scrollHeight: {value: 1000}, clientHeight: {value: 200}, clientTop: {value: 2}});
            scroller.getBoundingClientRect = () => {
                const top = (index === 0 ? 100 : 450) + documentShift();
                return {left: 0, right: 1000, width: 1000, height: 200, top, bottom: top + 200} as DOMRect;
            };
            anchors[index].getBoundingClientRect = () => ({width: 200, height: 40,
                top: scroller.getBoundingClientRect().top + 12 - (wrappers[index + 1].isConnected ? 0 : 40 + index * 20)
                    - (scroller.scrollTop - initial)} as DOMRect);
        });
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: (_x: number, y: number) =>
            y >= 450 ? anchors[1] : y >= 100 ? anchors[0] : rootAnchor});
        restoreAllTranslations();
        expect(windowY).toBe(documentY === 0 ? 0 : 80);
        expect(scrollers[0].scrollTop).toBe(160);
        expect(scrollers[1].scrollTop).toBe(secondTop === 0 ? 0 : 140);
        expect(owners.map(owner => owner.textContent)).toEqual(Array(3).fill('Source above the reading position.'));
        expect(rootAnchor.getBoundingClientRect().top).toBe(documentY === 0 ? -15 : 5);
        expect(anchors[0].getBoundingClientRect().top - scrollers[0].getBoundingClientRect().top).toBe(12);
    });

    it('恢复穿过开放 ShadowRoot 保护真实滚动面，且不为嵌套恢复重复取锚点', () => {
        const scroller = document.createElement('div');
        const host = document.createElement('div');
        const shadow = host.attachShadow({mode: 'open'});
        const changed = document.createElement('p');
        const anchor = document.createElement('p');
        shadow.append(changed, anchor);scroller.append(host);document.body.append(scroller);
        Object.defineProperties(scroller, {
            scrollHeight: {value: 1000}, clientHeight: {value: 200}, clientTop: {value: 2},
            getBoundingClientRect: {value: () => ({width: 700, height: 200, left: 0, right: 700, top: 100, bottom: 300})},
        });
        scroller.scrollTop = 100;
        Object.defineProperty(window, 'scrollY', {configurable: true, value: 0});
        Object.defineProperty(window, 'getComputedStyle', {configurable: true,
            value: (element: HTMLElement) => ({overflowY: element === scroller ? 'auto' : 'visible'})});
        const hit = vi.fn(() => host);
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: hit});
        Object.defineProperty(shadow, 'elementFromPoint', {configurable: true, value: () => anchor});
        let after = false;
        anchor.getBoundingClientRect = () => ({width: 200, height: 40, top: (after ? 70 : 110) - (scroller.scrollTop - 100)} as DOMRect);
        const result = withFullPageRestorationAnchors(() =>
            withFullPageRestorationAnchors(() => {after = true;return 'restored';}, [changed]), [changed]);
        expect(result).toBe('restored');
        expect(scroller.scrollTop).toBe(60);
        expect(hit).toHaveBeenCalledOnce();
    });

    it('全量恢复的命中或几何不可读、面在屏外、变化脱离页面时仍执行清理并释放深度', () => {
        const owner = document.createElement('p');
        const scroller = document.createElement('div');
        scroller.append(owner);document.body.append(scroller);
        scroller.scrollTop = 100;
        Object.defineProperties(scroller, {
            scrollHeight: {value: 1000}, clientHeight: {value: 200}, clientTop: {value: 0},
        });
        Object.defineProperty(window, 'getComputedStyle', {configurable: true, value: () => ({overflowY: 'auto'})});
        Object.defineProperty(window, 'scrollY', {configurable: true, value: 0});
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: () => {throw new Error('unreadable hit');}});
        scroller.getBoundingClientRect = () => ({left: 0, right: 700, top: 100, bottom: 300} as DOMRect);
        expect(withFullPageRestorationAnchors(() => 'hit failed', [owner])).toBe('hit failed');
        scroller.getBoundingClientRect = () => ({left: 2000, right: 2300, top: 100, bottom: 300} as DOMRect);
        expect(withFullPageRestorationAnchors(() => 'offscreen', [owner])).toBe('offscreen');
        scroller.getBoundingClientRect = () => ({left: 0, right: 700, top: 1000, bottom: 1300} as DOMRect);
        expect(withFullPageRestorationAnchors(() => 'below', [owner])).toBe('below');
        const hit = vi.fn(() => null);
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: hit});
        scroller.getBoundingClientRect = () => ({left: 0, right: 700, top: 100, bottom: 300} as DOMRect);
        expect(withFullPageRestorationAnchors(() => 'no anchor', [owner])).toBe('no anchor');
        expect(hit).toHaveBeenCalledTimes(3);
        owner.remove();
        expect(withFullPageRestorationAnchors(() => 'detached', [owner])).toBe('detached');
        expect(() => withFullPageRestorationAnchors(() => {throw new Error('cleanup failure');}, [owner])).toThrow('cleanup failure');
    });

    it('全量恢复锚点落到其它滚动面或被宿主重挂后不补偿旧滚动面', () => {
        const scroller = document.createElement('div');
        const owner = document.createElement('p');
        const anchor = document.createElement('p');
        const foreign = document.createElement('p');
        scroller.append(owner, anchor);document.body.append(scroller, foreign);
        scroller.scrollTop = 100;
        Object.defineProperties(scroller, {
            scrollHeight: {value: 1000}, clientHeight: {value: 200}, clientTop: {value: 0},
            getBoundingClientRect: {value: () => ({left: 0, right: 700, top: 100, bottom: 300})},
        });
        Object.defineProperty(window, 'getComputedStyle', {configurable: true,
            value: (element: HTMLElement) => ({overflowY: element === scroller ? 'auto' : 'visible'})});
        Object.defineProperty(window, 'scrollY', {configurable: true, value: 0});
        foreign.getBoundingClientRect = () => ({width: 200, height: 40, top: 110} as DOMRect);
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: () => foreign});
        expect(withFullPageRestorationAnchors(() => 'foreign', [owner])).toBe('foreign');
        anchor.getBoundingClientRect = () => ({width: 0, height: 0, top: 110} as DOMRect);
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: () => anchor});
        expect(withFullPageRestorationAnchors(() => 'zero geometry', [owner])).toBe('zero geometry');
        anchor.getBoundingClientRect = () => ({width: 200, height: 40, top: 110} as DOMRect);
        withFullPageRestorationAnchors(() => document.body.append(anchor), [owner]);
        expect(scroller.scrollTop).toBe(100);
    });

    it.each(['detached', 'connected', 'from-page'] as const)(
        '全局锚点变更滚动面（%s）时不滚动旧容器或页面', kind => {
            const scroller = document.createElement('div');
            const anchor = document.createElement('p');
            document.body.append(scroller);
            if (kind === 'from-page') document.body.append(anchor);
            else scroller.append(anchor);
            scroller.scrollTop = 100;
            Object.defineProperties(scroller, {scrollHeight: {value: 1000}, clientHeight: {value: 200}});
            Object.defineProperty(window, 'getComputedStyle', {configurable: true,
                value: (element: HTMLElement) => ({overflowY: element === scroller ? 'auto' : 'visible'})});
            Object.defineProperty(window, 'scrollY', {configurable: true, value: 200});
            Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: () => anchor});
            let moved = false;
            anchor.getBoundingClientRect = () => ({width: 200, height: 40, top: moved ? 160 : 110} as DOMRect);
            const scrollBy = vi.fn();
            Object.defineProperty(window, 'scrollBy', {configurable: true, value: scrollBy});
            withFullPageViewportAnchor(() => {
                moved = true;
                if (kind === 'from-page') scroller.append(anchor);
                else {
                    document.body.append(anchor);
                    if (kind === 'detached') scroller.remove();
                }
            });
            expect(scrollBy).not.toHaveBeenCalled();
            expect(scroller.scrollTop).toBe(100);
        });

    it('超过祖先预算时不把未知内层滚动面当作文档，局部捕获与全量恢复均安全放弃补偿', () => {
        let parent = document.body;
        for (let depth = 0; depth < 514; depth++) {
            const child = document.createElement('div');parent.append(child);parent = child;
        }
        const owners = [document.createElement('p'), document.createElement('p')];
        parent.append(...owners);
        owners[0].getBoundingClientRect = () => ({width: 200, height: 40, top: -100, bottom: -60} as DOMRect);
        const styles = vi.fn(() => ({overflowY: 'visible'}));
        Object.defineProperty(window, 'getComputedStyle', {configurable: true, value: styles});
        Object.defineProperty(window, 'scrollY', {configurable: true, value: 250});
        const hit = vi.fn(() => owners[0]);
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: hit});
        const scrollBy = vi.fn();
        Object.defineProperty(window, 'scrollBy', {configurable: true, value: scrollBy});
        expect(withFullPageViewportAnchor(() => 'local', owners)).toBe('local');
        expect(styles).toHaveBeenCalledTimes(512);
        expect(hit).not.toHaveBeenCalled();
        styles.mockClear();
        expect(withFullPageViewportAnchor(() => 'global')).toBe('global');
        expect(styles).toHaveBeenCalledTimes(512);
        expect(scrollBy).not.toHaveBeenCalled();
        styles.mockClear();hit.mockClear();
        expect(withFullPageRestorationAnchors(() => 'restore', owners)).toBe('restore');
        expect(styles).toHaveBeenCalledTimes(512);
        expect(scrollBy).not.toHaveBeenCalled();
    });

    it.each(['no-inner-hit', 'self-hit', 'translation-hit'])(
        '恢复锚点处理 %s，不循环穿透 ShadowRoot 或跟随译文工件', kind => {
            const scroller = document.createElement('div');
            const owner = document.createElement('p');
            const host = document.createElement('div');
            const anchor = document.createElement('p');
            const artifact = document.createElement('span');
            artifact.className = 'fluent-read-bilingual-content';anchor.append(artifact);
            scroller.append(owner, host, anchor);document.body.append(scroller);
            const shadow = host.attachShadow({mode: 'open'});
            Object.defineProperty(shadow, 'elementFromPoint', {value: () => kind === 'self-hit' ? host : null});
            host.getBoundingClientRect = () => ({width: 0, height: 0} as DOMRect);
            scroller.scrollTop = 100;
            Object.defineProperties(scroller, {
                scrollHeight: {value: 1000}, clientHeight: {value: 200}, clientTop: {value: 0},
                getBoundingClientRect: {value: () => ({left: 0, right: 700, top: 100, bottom: 300})},
            });
            Object.defineProperty(window, 'getComputedStyle', {configurable: true,
                value: (element: HTMLElement) => ({overflowY: element === scroller ? 'auto' : 'visible'})});
            Object.defineProperty(window, 'scrollY', {configurable: true, value: 0});
            Object.defineProperty(document, 'elementFromPoint', {configurable: true,
                value: () => kind === 'translation-hit' ? artifact : host});
            let after = false;
            anchor.getBoundingClientRect = () => ({width: 200, height: 40, top: after ? 70 : 110} as DOMRect);
            withFullPageRestorationAnchors(() => {after = true;}, [owner]);
            expect(scroller.scrollTop).toBe(kind === 'translation-hit' ? 60 : 100);
        },
    );

    it.each([
        {surface: 'document', rounding: 'floor'}, {surface: 'nested', rounding: 'floor'},
        {surface: 'document', rounding: 'nearest'}, {surface: 'nested', rounding: 'nearest'},
    ])('十轮翻译与恢复不累计浏览器小数滚动取整误差：%j', ({surface, rounding}) => {
        const scroller = document.createElement('div');
        const changed = document.createElement('p');
        const anchor = document.createElement('p');
        if (surface === 'nested') {scroller.append(changed, anchor);document.body.append(scroller);}
        else document.body.append(changed, anchor);
        let scrollPosition = 426.5;
        const round = (value: number) => (rounding === 'floor' ? Math.floor(value * 2) : Math.round(value * 2)) / 2;
        Object.defineProperty(window, 'scrollY', {configurable: true, get: () => surface === 'document' ? scrollPosition : 0});
        Object.defineProperty(window, 'scrollBy', {configurable: true, value: (_x: number, delta: number) => {
            scrollPosition = round(scrollPosition + delta);
        }});
        Object.defineProperties(scroller, {
            scrollTop: {get: () => scrollPosition, set: value => {scrollPosition = round(value);}},
            scrollHeight: {value: 2000}, clientHeight: {value: 650}, clientTop: {value: 0},
            getBoundingClientRect: {value: () => ({left: 0, right: 700, top: 100, bottom: 750})},
        });
        Object.defineProperty(window, 'getComputedStyle', {configurable: true,
            value: (element: HTMLElement) => ({overflowY: element === scroller ? 'auto' : 'visible'})});
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: () => anchor});
        let height = 0;
        anchor.getBoundingClientRect = () => ({width: 200, height: 40, top: 150 + height - (scrollPosition - 426.5)} as DOMRect);
        changed.getBoundingClientRect = () => ({width: 200, height: 40, bottom: -400 + height} as DOMRect);
        for (let roundIndex = 0; roundIndex < 10; roundIndex++) {
            withFullPageViewportAnchor(() => {height = rounding === 'floor' ? 307.1484375 : 307.3;}, [changed]);
            expect(Math.abs(anchor.getBoundingClientRect().top - 150)).toBeLessThanOrEqual(0.25);
            withFullPageRestorationAnchors(() => {height = 0;}, [changed]);
            expect(scrollPosition).toBe(426.5);
            expect(anchor.getBoundingClientRect().top).toBe(150);
        }
    });

    it.each([0.75, 1, 1.25, 2])('窄容器缩放 %s 时在本面命中，并按实际滚动响应连续十轮补偿', scale => {
        const scroller = document.createElement('div');
        const changed = document.createElement('p');
        const anchor = document.createElement('p');
        scroller.append(changed, anchor);document.body.append(scroller);
        let scrollPosition = 100, height = 0;
        Object.defineProperties(scroller, {
            scrollTop: {get: () => scrollPosition, set: value => {scrollPosition = Math.floor(value * 2) / 2;}},
            scrollHeight: {value: 2000}, clientHeight: {value: 650}, clientTop: {value: 3},
            getBoundingClientRect: {value: () => ({left: 50, right: 350, top: 100, bottom: 750})},
        });
        Object.defineProperty(window, 'scrollY', {configurable: true, value: 0});
        Object.defineProperty(window, 'getComputedStyle', {configurable: true,
            value: (element: HTMLElement) => ({overflowY: element === scroller ? 'auto' : 'visible'})});
        const hit = vi.fn((x: number) => x >= 50 && x <= 350 ? anchor : document.body);
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: hit});
        anchor.getBoundingClientRect = () => ({width: 200, height: 40,
            top: 200 + scale * (height - (scrollPosition - 100))} as DOMRect);
        changed.getBoundingClientRect = () => ({width: 200, height: 40, bottom: 80} as DOMRect);
        for (let cycle = 0; cycle < 10; cycle++) {
            withFullPageViewportAnchor(() => {height = 307.1484375;}, [changed]);
            expect(Math.abs(anchor.getBoundingClientRect().top - 200)).toBeLessThanOrEqual(0.5);
            withFullPageRestorationAnchors(() => {height = 0;}, [changed]);
            expect(scrollPosition).toBe(100);
            expect(anchor.getBoundingClientRect().top).toBe(200);
        }
        expect(hit.mock.calls.every(([x]) => x >= 50 && x <= 350)).toBe(true);
    });

    it.each([0, 100])('文档滚动量为 %s 且滚动 API 不可用时仍执行写入，页首不会被补偿', initial => {
        const anchor = document.createElement('p');document.body.append(anchor);
        let top = 100;
        anchor.getBoundingClientRect = () => ({width: 200, height: 40, top} as DOMRect);
        Object.defineProperty(window, 'scrollY', {configurable: true, value: initial});
        Object.defineProperty(window, 'scrollBy', {configurable: true, value: undefined});
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: () => anchor});
        expect(withFullPageViewportAnchor(() => {top += 40;return 'written';})).toBe('written');
        expect(window.scrollY).toBe(initial);
    });

    it('一次局部写入同时影响文档和内层上方时，面内补偿不重复抵消文档位移', () => {
        const rootChanged = document.createElement('p'), rootAnchor = document.createElement('p');
        const scroller = document.createElement('div');
        const innerChanged = document.createElement('p'), innerAnchor = document.createElement('p');
        scroller.append(innerChanged, innerAnchor);document.body.append(rootChanged, rootAnchor, scroller);
        let windowY = 100, after = false;
        scroller.scrollTop = 100;
        const documentShift = () => (after ? 40 : 0) - (windowY - 100);
        Object.defineProperty(window, 'scrollY', {configurable: true, get: () => windowY});
        Object.defineProperty(window, 'scrollBy', {configurable: true, value: (_x: number, delta: number) => {windowY += delta;}});
        Object.defineProperty(window, 'getComputedStyle', {configurable: true,
            value: (element: HTMLElement) => ({overflowY: element === scroller ? 'auto' : 'visible'})});
        Object.defineProperties(scroller, {scrollHeight: {value: 2000}, clientHeight: {value: 200}, clientTop: {value: 0}});
        scroller.getBoundingClientRect = () => ({left: 0, right: 700,
            top: 100 + documentShift(), bottom: 300 + documentShift()} as DOMRect);
        rootChanged.getBoundingClientRect = () => ({width: 200, height: 40, bottom: -50} as DOMRect);
        innerChanged.getBoundingClientRect = () => ({width: 200, height: 40, bottom: 70} as DOMRect);
        rootAnchor.getBoundingClientRect = () => ({width: 200, height: 40, top: 450 + documentShift()} as DOMRect);
        innerAnchor.getBoundingClientRect = () => ({width: 200, height: 40,
            top: 150 + documentShift() + (after ? 50 : 0) - (scroller.scrollTop - 100)} as DOMRect);
        Object.defineProperty(document, 'elementFromPoint', {configurable: true,
            value: (_x: number, y: number) => y < 300 ? innerAnchor : rootAnchor});
        withFullPageViewportAnchor(() => {after = true;}, [innerChanged, rootChanged]);
        expect(scroller.scrollTop).toBe(150);
        expect(windowY).toBe(140);
        expect(innerAnchor.getBoundingClientRect().top).toBe(150);
        expect(rootAnchor.getBoundingClientRect().top).toBe(450);
    });

    it('宿主命中测试抛错时无论显式来源还是全局锚点都继续执行写入', () => {
        const changed = document.createElement('p');document.body.append(changed);
        changed.getBoundingClientRect = () => ({width: 200, height: 40, bottom: -50} as DOMRect);
        Object.defineProperty(window, 'scrollY', {configurable: true, value: 100});
        Object.defineProperty(document, 'elementFromPoint', {configurable: true,
            value: () => {throw new Error('Host hit-test unavailable');}});
        const written = vi.fn(() => 'written');
        expect(() => withFullPageViewportAnchor(written)).not.toThrow();
        expect(withFullPageViewportAnchor(written, [changed])).toBe('written');
        expect(withFullPageRestorationAnchors(written, [changed])).toBe('written');
        expect(written).toHaveBeenCalledTimes(3);
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
