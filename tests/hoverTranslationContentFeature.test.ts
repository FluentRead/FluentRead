import {afterEach, describe, expect, it, vi} from 'vitest';
import {setMaxListeners} from 'node:events';
import {matchesConfiguredHotkey} from '@/src/core/hotkey';
import {
    matchesPressedHotkeyParts,
    mountHoverTranslationContentFeature,
    normalizeHoverHotkeyParts,
    type HoverTranslationContentDependencies,
} from '@/src/features/hover-translation/content';

type Listener = (event: any) => unknown;

class FakeTarget {
    listeners = new Map<string, Listener[]>();
    animationFrames = new Map<number, FrameRequestCallback>();
    nextFrame = 1;
    hidden = false;
    location = {href: 'https://fixture.test/article'};

    addEventListener(type: string, listener: Listener, options?: AddEventListenerOptions): void {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
        expect(options).toBeTruthy();
        options?.signal?.addEventListener('abort', () => {
            this.listeners.set(type, (this.listeners.get(type) || []).filter(current => current !== listener));
        }, {once: true});
    }

    requestAnimationFrame(callback: FrameRequestCallback): number {
        const id = this.nextFrame++;
        this.animationFrames.set(id, callback);
        return id;
    }

    cancelAnimationFrame(id: number): void { this.animationFrames.delete(id); }

    flushAnimationFrame(): void {
        const callbacks = [...this.animationFrames.values()];
        this.animationFrames.clear();
        callbacks.forEach(callback => callback(0));
    }

    emit(type: string, event: Record<string, unknown> = {}): void {
        for (const listener of this.listeners.get(type) || []) listener(event);
    }
}

function trustedEvent(event: Record<string, unknown> = {}): any {
    return {
        isTrusted: true,
        key: '',
        code: '',
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
        button: 0,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        ...event,
    };
}

function mountHarness(overrides: Partial<HoverTranslationContentDependencies> = {}, pointerKnown = true) {
    const documentTarget = new FakeTarget();
    const windowTarget = new FakeTarget();
    const config = {
        on: true,
        hotkey: 'Control',
        customHotkey: '',
        mouseHoverTranslationDelay: 120,
    };
    const deps: HoverTranslationContentDependencies = {
        config,
        constants: {
            TwoFinger: 'twoFinger',
            ThreeFinger: 'threeFinger',
            FourFinger: 'fourFinger',
            DoubleClick: 'doubleClick',
            LongPress: 'longPress',
            MiddleClick: 'middleClick',
            DoubleClickScreen: 'doubleClickScreen',
            TripleClickScreen: 'tripleClickScreen',
        },
        document: documentTarget as unknown as Document,
        window: windowTarget as unknown as Window,
        navigator: {platform: 'MacIntel'} as Navigator,
        isSiteDisabled: () => false,
        getCenterPoint: vi.fn(() => ({x: 7, y: 9})),
        handleTranslation: vi.fn(),
        noteBilingualHostGesture: vi.fn(),
        cancelPendingHoverTranslation: vi.fn(),
        hasActiveSelectionTranslationCandidate: vi.fn(() => false),
        getConfiguredSelectionHotkey: () => 'Control',
        getCustomSelectionHotkey: () => '',
        matchesSelectionTranslatorShortcut: vi.fn(() => false),
        shouldReserveSelectionShortcut: vi.fn(() => false),
        ...overrides,
    };
    const controller = new AbortController();
    // 浏览器会为 signal 自动移除监听器；本机夹具通过 Node AbortSignal 模拟完整事件数量。
    setMaxListeners(50, controller.signal);

    const resetKeyboardGesture = mountHoverTranslationContentFeature(deps, controller.signal);
    if (pointerKnown) {
        documentTarget.emit('mousemove', trustedEvent({clientX: 0, clientY: 0}));
        if (vi.isMockFunction(deps.noteBilingualHostGesture)) deps.noteBilingualHostGesture.mockClear();
    }

    return {deps, documentTarget, windowTarget, controller, resetKeyboardGesture};
}

afterEach(() => {
    vi.useRealTimers();
});

describe('hover translation content feature', () => {
    it('空闲可信移动只记录坐标与宿主交互，不读取availability，后续快捷键使用最新位置', () => {
        const isSiteDisabled = vi.fn(() => false);
        const {deps, documentTarget, windowTarget} = mountHarness({isSiteDisabled}, false);
        const hidden = vi.fn(() => false);
        Object.defineProperty(documentTarget, 'hidden', {get: hidden});
        isSiteDisabled.mockClear();

        for (let index = 0; index < 200; index++) {
            documentTarget.emit('mousemove', trustedEvent({clientX: index, clientY: index + 10}));
        }
        expect(hidden).not.toHaveBeenCalled();
        expect(isSiteDisabled).not.toHaveBeenCalled();
        expect(deps.noteBilingualHostGesture).toHaveBeenCalledTimes(200);
        expect(deps.handleTranslation).not.toHaveBeenCalled();
        expect(deps.cancelPendingHoverTranslation).not.toHaveBeenCalled();
        expect(windowTarget.animationFrames.size).toBe(0);

        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(hidden).toHaveBeenCalled();
        expect(isSiteDisabled).toHaveBeenCalled();
        expect(deps.handleTranslation).toHaveBeenCalledWith(199, 209);
    });

    it.each(['disabled', 'hidden', 'site-disabled'])('释放按键后仍有悬浮工作时，%s 的mousemove完整取消并记录最新坐标', reason => {
        let siteDisabled = false;
        const {deps, documentTarget, windowTarget} = mountHarness({isSiteDisabled: () => siteDisabled});
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 11, clientY: 22}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(deps.handleTranslation).toHaveBeenCalledOnce();
        expect(windowTarget.animationFrames.size).toBe(0);
        if (reason === 'disabled') deps.config.on = false;
        if (reason === 'hidden') documentTarget.hidden = true;
        if (reason === 'site-disabled') siteDisabled = true;

        documentTarget.emit('mousemove', trustedEvent({clientX: 33, clientY: 44}));
        expect(deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
        expect(deps.handleTranslation).toHaveBeenCalledOnce();
        deps.config.on = true;
        documentTarget.hidden = false;
        siteDisabled = false;
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(deps.handleTranslation).toHaveBeenLastCalledWith(33, 44);
    });

    it('未收到可信指针坐标前不把默认左上角当成悬浮目标', () => {
        const {deps, documentTarget, windowTarget} = mountHarness({}, false);
        documentTarget.emit('mousemove', trustedEvent({isTrusted: false, clientX: 11, clientY: 22}));
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(deps.handleTranslation).not.toHaveBeenCalled();
        documentTarget.emit('mousemove', trustedEvent({clientX: 11, clientY: 22}));
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(deps.handleTranslation).toHaveBeenCalledWith(11, 22);
    });

    it('挂载后没有mousemove时，真实鼠标pointerdown提供位置并允许单次Control翻译', () => {
        const {deps, documentTarget, windowTarget} = mountHarness({}, false);
        documentTarget.emit('pointerdown', trustedEvent({pointerType: 'mouse', clientX: 31, clientY: 47}));
        expect(deps.handleTranslation).not.toHaveBeenCalled();
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(vi.mocked(deps.handleTranslation).mock.calls).toEqual([[31, 47]]);
    });

    it.each([[31, 47], [0, 0]])('可信mouseover在未移动时提供坐标(%s,%s)，合成事件不能替换它', (x, y) => {
        const {deps, documentTarget, windowTarget} = mountHarness({}, false);
        documentTarget.emit('mouseover', trustedEvent({isTrusted: false, clientX: 11, clientY: 22}));
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(deps.handleTranslation).not.toHaveBeenCalled();
        documentTarget.emit('mouseover', trustedEvent({clientX: x, clientY: y}));
        documentTarget.emit('mouseover', trustedEvent({isTrusted: false, clientX: 53, clientY: 71}));
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(vi.mocked(deps.handleTranslation).mock.calls).toEqual([[x, y]]);
    });

    it('卸载后迟到的mouseover不读取位置，不启动新工作', () => {
        const {deps, documentTarget, windowTarget, controller} = mountHarness({}, false);
        const listener = documentTarget.listeners.get('mouseover')![0];
        controller.abort();
        const clientX = vi.fn(() => 31);
        listener({...trustedEvent(), get clientX() { return clientX(); }, clientY: 47});
        expect(clientX).not.toHaveBeenCalled();
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it.each(['touch', 'pen', 'untrusted-mouse'])('%s 输入不会伪装成已知鼠标位置或使Control复活', pointer => {
        const {deps, documentTarget, windowTarget} = mountHarness({}, false);
        documentTarget.emit('pointerdown', trustedEvent({pointerType: pointer === 'untrusted-mouse' ? 'mouse' : pointer,
            isTrusted: pointer !== 'untrusted-mouse', clientX: 31, clientY: 47}));
        // 触摸后浏览器可能发送兼容 mousedown；该事件不应把触摸坐标提升为鼠标手势。
        documentTarget.emit('mousedown', trustedEvent({clientX: 31, clientY: 47}));
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it.each(['disabled', 'hidden', 'site-disabled'])('%s 时鼠标点击不排任务，也不为重新启用保留位置', reason => {
        let disabled = reason === 'site-disabled';
        const {deps, documentTarget, windowTarget} = mountHarness({isSiteDisabled: () => disabled}, false);
        if (reason === 'disabled') deps.config.on = false;
        if (reason === 'hidden') documentTarget.hidden = true;
        documentTarget.emit('pointerdown', trustedEvent({pointerType: 'mouse', clientX: 31, clientY: 47}));
        documentTarget.emit('mousedown', trustedEvent({clientX: 31, clientY: 47}));
        expect(deps.handleTranslation).not.toHaveBeenCalled();
        deps.config.on = true;
        disabled = false;
        documentTarget.hidden = false;
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(deps.handleTranslation).not.toHaveBeenCalled();
        documentTarget.emit('pointerdown', trustedEvent({pointerType: 'mouse', clientX: 53, clientY: 71}));
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(vi.mocked(deps.handleTranslation).mock.calls).toEqual([[53, 71]]);
    });

    it('首点立即响应，同帧鼠标洪峰只在下一帧提交最后位置，稳定坐标不重置延迟', () => {
        const {deps, documentTarget, windowTarget} = mountHarness();
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        for (let index = 0; index < 500; index++) {
            documentTarget.emit('mousemove', trustedEvent({clientX: index, clientY: 20}));
        }
        expect(deps.handleTranslation).toHaveBeenCalledTimes(1);
        expect(deps.handleTranslation).toHaveBeenLastCalledWith(0, 20, {delayMs: 120, continuous: true});
        windowTarget.flushAnimationFrame();
        expect(deps.handleTranslation).toHaveBeenCalledTimes(2);
        expect(deps.handleTranslation).toHaveBeenLastCalledWith(499, 20, {delayMs: 120, continuous: true});
        for (let index = 0; index < 100; index++) documentTarget.emit('mousemove', trustedEvent({clientX: 499, clientY: 20}));
        windowTarget.flushAnimationFrame();
        expect(deps.handleTranslation).toHaveBeenCalledTimes(2);
        expect(windowTarget.animationFrames.size).toBe(0);
    });

    it('快捷键释放提交尚未绘制的最新位置，保留原停留延迟且不让旧帧重复触发', () => {
        const {deps, documentTarget, windowTarget} = mountHarness();
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 10, clientY: 20}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 30, clientY: 40}));
        const obsoleteFrame = [...windowTarget.animationFrames.values()][0];
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(deps.handleTranslation).toHaveBeenCalledTimes(2);
        expect(deps.handleTranslation).toHaveBeenLastCalledWith(30, 40, {delayMs: 120, continuous: true});
        expect(deps.cancelPendingHoverTranslation).not.toHaveBeenCalled();
        expect(windowTarget.animationFrames.size).toBe(0);
        obsoleteFrame(0);
        expect(deps.handleTranslation).toHaveBeenCalledTimes(2);
    });

    it('翻译入口同步重置手势时不再排入绘制帧，卸载后迟到监听器也不会启动工作', () => {
        let reset = () => {};
        const {deps, documentTarget, windowTarget, resetKeyboardGesture, controller} = mountHarness({
            handleTranslation: vi.fn(() => reset()),
        });
        reset = resetKeyboardGesture;
        const obsoleteMouseListener = documentTarget.listeners.get('mousemove')?.at(-1);
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 10, clientY: 20}));
        expect(deps.handleTranslation).toHaveBeenCalledOnce();
        expect(windowTarget.animationFrames.size).toBe(0);
        expect(deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
        controller.abort();
        vi.mocked(deps.noteBilingualHostGesture).mockClear();
        obsoleteMouseListener?.(trustedEvent({clientX: 30, clientY: 40}));
        expect(deps.noteBilingualHostGesture).not.toHaveBeenCalled();
        expect(deps.handleTranslation).toHaveBeenCalledOnce();
    });

    it('同帧移回已经提交的位置不会在释放时重启相同目标', () => {
        const {deps, documentTarget, windowTarget} = mountHarness();
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 10, clientY: 20}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 30, clientY: 40}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 10, clientY: 20}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(deps.handleTranslation).toHaveBeenCalledOnce();
    });

    it.each(['blur', 'hidden', 'pagehide', 'mouseleave', 'mouseout', 'popstate', 'hashchange', 'route-change', 'pointercancel', 'touchcancel'])(
        '%s 取消帧和待执行翻译、废弃坐标，下一轮须取得新的可信指针', reason => {
            const {deps, documentTarget, windowTarget} = mountHarness();
            windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
            documentTarget.emit('mousemove', trustedEvent({clientX: 10, clientY: 20}));
            documentTarget.emit('mousemove', trustedEvent({clientX: 30, clientY: 40}));
            const obsoleteFrame = [...windowTarget.animationFrames.values()][0];
            if (reason === 'hidden') {
                documentTarget.hidden = true;
                documentTarget.emit('visibilitychange');
            } else if (reason === 'popstate' || reason === 'hashchange' || reason === 'route-change') {
                windowTarget.location.href = 'https://fixture.test/other';
                if (reason === 'route-change') documentTarget.emit('fluentread-route-change');
                else windowTarget.emit(reason);
            } else if (reason === 'mouseleave' || reason === 'pointercancel' || reason === 'touchcancel') {
                documentTarget.emit(reason, trustedEvent());
            } else if (reason === 'mouseout') {
                documentTarget.emit(reason, trustedEvent({relatedTarget: null}));
            } else windowTarget.emit(reason);
            expect(deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
            expect(windowTarget.animationFrames.size).toBe(0);
            windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
            windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
            obsoleteFrame(0);
            windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
            expect(deps.handleTranslation).toHaveBeenCalledOnce();
            documentTarget.hidden = false;
            documentTarget.emit('mousemove', trustedEvent({clientX: 50, clientY: 60}));
            windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
            windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
            expect(deps.handleTranslation).toHaveBeenLastCalledWith(50, 60);
        },
    );

    it('页面仍可见、路由地址未变及不可信离开事件不作废有效手势', () => {
        const {deps, documentTarget, windowTarget} = mountHarness();
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        documentTarget.emit('visibilitychange');
        documentTarget.emit('fluentread-route-change');
        windowTarget.emit('popstate');
        documentTarget.emit('mouseleave', trustedEvent({isTrusted: false}));
        documentTarget.emit('mouseout', trustedEvent({isTrusted: false, relatedTarget: null}));
        documentTarget.emit('mouseout', trustedEvent({relatedTarget: {}}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(deps.handleTranslation).toHaveBeenCalledWith(0, 0);
        expect(deps.cancelPendingHoverTranslation).not.toHaveBeenCalled();
    });

    it('滚动取消旧坐标的等待和帧，保留已按住的热键并在新移动重新识别', () => {
        const {deps, documentTarget, windowTarget} = mountHarness();
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 10, clientY: 20}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 30, clientY: 40}));
        documentTarget.emit('scroll', trustedEvent({isTrusted: false}));
        expect(deps.cancelPendingHoverTranslation).not.toHaveBeenCalled();
        documentTarget.emit('scroll', trustedEvent());
        expect(deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
        expect(windowTarget.animationFrames.size).toBe(0);
        windowTarget.flushAnimationFrame();
        documentTarget.emit('mousemove', trustedEvent({clientX: 30, clientY: 40}));
        expect(deps.handleTranslation).toHaveBeenCalledTimes(2);
        expect(deps.handleTranslation).toHaveBeenLastCalledWith(30, 40, {delayMs: 120, continuous: true});
    });

    it('长按遇到滚动会立即清除计时器，关闭功能时不再创建长按工作', () => {
        vi.useFakeTimers();
        const {deps, documentTarget} = mountHarness();
        deps.config.hotkey = deps.constants.LongPress;
        documentTarget.emit('mousedown', trustedEvent({clientX: 10, clientY: 20}));
        documentTarget.emit('scroll', trustedEvent());
        expect(vi.getTimerCount()).toBe(0);
        deps.config.on = false;
        documentTarget.emit('mousedown', trustedEvent({clientX: 10, clientY: 20}));
        expect(vi.getTimerCount()).toBe(0);
        deps.config.on = true;
        vi.advanceTimersByTime(500);
        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('功能关闭时按住的快捷键不会在重新启用后复活', () => {
        const {deps, documentTarget, windowTarget} = mountHarness();
        deps.config.on = false;
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        deps.config.on = true;
        documentTarget.emit('mousemove', trustedEvent({clientX: 10, clientY: 20}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it.each(['on', 'hotkey', 'customHotkey', 'mouseHoverTranslationDelay', 'site-disabled'])(
        '订阅发现 %s 改变会立即取消工作且reset幂等', property => {
            let listener: (() => void) | undefined;
            let disabled = false;
            const unsubscribe = vi.fn();
            const {deps, documentTarget, windowTarget, resetKeyboardGesture, controller} = mountHarness({
                subscribeConfig: vi.fn(callback => { listener = callback; return unsubscribe; }),
                isSiteDisabled: () => disabled,
            });
            windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
            documentTarget.emit('mousemove', trustedEvent({clientX: 10, clientY: 20}));
            documentTarget.emit('mousemove', trustedEvent({clientX: 30, clientY: 40}));
            listener?.();
            expect(deps.cancelPendingHoverTranslation).not.toHaveBeenCalled();
            if (property === 'on') deps.config.on = false;
            if (property === 'hotkey') deps.config.hotkey = 'Alt';
            if (property === 'customHotkey') deps.config.customHotkey = 'Alt';
            if (property === 'mouseHoverTranslationDelay') deps.config.mouseHoverTranslationDelay = 300;
            if (property === 'site-disabled') disabled = true;
            listener?.();
            expect(deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
            expect(windowTarget.animationFrames.size).toBe(0);
            listener?.();
            resetKeyboardGesture();
            controller.abort();
            expect(deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
            expect(unsubscribe).toHaveBeenCalledOnce();
        },
    );

    it('连续采样复用划词快捷键解析，配置更新后仍可交给新的共享划词手势', () => {
        let selectionHotkey = 'Control+Alt';
        const {deps, documentTarget, windowTarget} = mountHarness({
            getConfiguredSelectionHotkey: () => 'custom',
            getCustomSelectionHotkey: () => selectionHotkey,
            hasActiveSelectionTranslationCandidate: () => true,
        });
        const split = vi.spyOn(String.prototype, 'split');
        try {
            windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
            for (let index = 0; index < 100; index++) {
                documentTarget.emit('mousemove', trustedEvent({clientX: index, clientY: 20}));
                windowTarget.flushAnimationFrame();
            }
            expect(split.mock.contexts.filter(context => String(context) === 'Control+Alt')).toHaveLength(1);
            selectionHotkey = 'Control';
            documentTarget.emit('mousemove', trustedEvent({clientX: 101, clientY: 20}));
            windowTarget.flushAnimationFrame();
            expect(deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
            expect(deps.handleTranslation).toHaveBeenCalledTimes(100);
        } finally { split.mockRestore(); }
    });

    it('初始已中止时不挂监听器或配置订阅', () => {
        const {deps, controller, windowTarget, documentTarget} = mountHarness();
        controller.abort();
        const subscribeConfig = vi.fn();
        const ended = new AbortController();
        ended.abort();
        mountHoverTranslationContentFeature({...deps, subscribeConfig}, ended.signal)();
        expect(subscribeConfig).not.toHaveBeenCalled();
        expect([...windowTarget.listeners.values()].every(listeners => listeners.length === 0)).toBe(true);
        expect([...documentTarget.listeners.values()].every(listeners => listeners.length === 0)).toBe(true);
    });

    it.each(['reset', 'blur', 'selection-reserved', 'abort', 'route-change', 'hidden', 'mouseout'])(
        '长按在 %s 仲裁后不会发出迟到翻译', reason => {
            vi.useFakeTimers();
            const {deps, documentTarget, windowTarget, controller, resetKeyboardGesture} = mountHarness();
            deps.config.hotkey = deps.constants.LongPress;
            documentTarget.emit('mousedown', trustedEvent({clientX: 10, clientY: 20}));
            if (reason === 'reset') resetKeyboardGesture();
            if (reason === 'blur') windowTarget.emit('blur');
            if (reason === 'abort') controller.abort();
            if (reason === 'route-change') {
                windowTarget.location.href = 'https://fixture.test/other';
                documentTarget.emit('fluentread-route-change');
            }
            if (reason === 'hidden') {
                documentTarget.hidden = true;
                documentTarget.emit('visibilitychange');
            }
            if (reason === 'mouseout') documentTarget.emit('mouseout', trustedEvent({relatedTarget: null}));
            if (reason === 'selection-reserved') {
                vi.mocked(deps.shouldReserveSelectionShortcut).mockReturnValue(true);
                windowTarget.emit('keydown', trustedEvent({key: 'Control', ctrlKey: true}));
            }
            vi.advanceTimersByTime(500);
            expect(deps.handleTranslation).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it.each(['reset', 'blur', 'selection-reserved', 'route-change', 'hidden', 'mouseout'])(
        '触摸连击在 %s 后重新计数，不借用取消前的触摸', reason => {
            vi.useFakeTimers();
            const {deps, documentTarget, windowTarget, resetKeyboardGesture} = mountHarness();
            deps.config.hotkey = deps.constants.DoubleClickScreen;
            const tap = () => documentTarget.emit('touchstart', trustedEvent({touches: [{clientX: 10, clientY: 20}]}));
            tap();
            if (reason === 'reset') resetKeyboardGesture();
            if (reason === 'blur') windowTarget.emit('blur');
            if (reason === 'route-change') {
                windowTarget.location.href = 'https://fixture.test/other';
                documentTarget.emit('fluentread-route-change');
            }
            if (reason === 'hidden') {
                documentTarget.hidden = true;
                documentTarget.emit('visibilitychange');
                documentTarget.hidden = false;
            }
            if (reason === 'mouseout') documentTarget.emit('mouseout', trustedEvent({relatedTarget: null}));
            if (reason === 'selection-reserved') {
                vi.mocked(deps.shouldReserveSelectionShortcut).mockReturnValue(true);
                windowTarget.emit('keydown', trustedEvent({key: 'Control', ctrlKey: true}));
            }
            tap();
            expect(deps.handleTranslation).not.toHaveBeenCalled();
            tap();
            expect(deps.handleTranslation).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it('中止手势会取消已交给运行时的悬浮延迟，停止迟到上游工作', () => {
        vi.useFakeTimers();
        const upstream = vi.fn();
        let pending: ReturnType<typeof setTimeout> | undefined;
        const {documentTarget, windowTarget, controller, deps} = mountHarness({
            handleTranslation: vi.fn((_x, _y, invocation) => {
                pending = setTimeout(upstream, invocation?.delayMs ?? 0);
            }),
            cancelPendingHoverTranslation: vi.fn(() => clearTimeout(pending)),
        });
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 10, clientY: 20}));
        expect(deps.handleTranslation).toHaveBeenCalledOnce();
        controller.abort();
        vi.advanceTimersByTime(500);
        expect(upstream).not.toHaveBeenCalled();
        expect(deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
    });

    it.each(['hotkey-change', 'disabled', 'site-disabled'])(
        '触摸连击不会跨越 %s 混合前后手势', reason => {
            vi.useFakeTimers();
            let disabled = false;
            const {deps, documentTarget} = mountHarness({isSiteDisabled: () => disabled});
            deps.config.hotkey = deps.constants.DoubleClickScreen;
            const tap = () => documentTarget.emit('touchstart', trustedEvent({touches: [{clientX: 10, clientY: 20}]}));
            tap();
            if (reason === 'hotkey-change') deps.config.hotkey = deps.constants.TripleClickScreen;
            if (reason === 'disabled') deps.config.on = false;
            if (reason === 'site-disabled') disabled = true;
            tap();
            expect(deps.handleTranslation).not.toHaveBeenCalled();
            if (reason !== 'hotkey-change') {
                deps.config.on = true; disabled = false;
            }
            tap();
            expect(deps.handleTranslation).not.toHaveBeenCalled();
            tap();
            expect(deps.handleTranslation).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it('关闭时的触摸不为重新启用后的连击留下计数', () => {
        vi.useFakeTimers();
        const {deps, documentTarget} = mountHarness();
        deps.config.hotkey = deps.constants.DoubleClickScreen;
        const tap = () => documentTarget.emit('touchstart', trustedEvent({touches: [{clientX: 10, clientY: 20}]}));
        deps.config.on = false;
        tap();
        deps.config.on = true;
        tap();
        expect(deps.handleTranslation).not.toHaveBeenCalled();
        tap();
        expect(deps.handleTranslation).toHaveBeenCalledOnce();
    });

    it('持续移动复用鼠标快捷键解析，配置改变后仍按新组合判定', () => {
        const {deps, documentTarget, windowTarget} = mountHarness();
        deps.config.hotkey = 'custom';
        deps.config.customHotkey = 'Control+Shift';
        const split = vi.spyOn(String.prototype, 'split');
        try {
            windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
            windowTarget.emit('keydown', trustedEvent({key: 'Shift', code: 'ShiftLeft', ctrlKey: true, shiftKey: true}));
            for (let index = 0; index < 200; index++) {
                documentTarget.emit('mousemove', trustedEvent({clientX: index, clientY: 20}));
            }
            const mouseShortcutSplits = split.mock.contexts.filter(context => String(context) === 'Control+Shift').length;
            expect(mouseShortcutSplits).toBeLessThanOrEqual(2);
            expect(deps.handleTranslation).toHaveBeenCalledOnce();
            windowTarget.flushAnimationFrame();
            expect(deps.handleTranslation).toHaveBeenCalledTimes(2);
            expect(deps.handleTranslation).toHaveBeenLastCalledWith(199, 20, {delayMs: 120, continuous: true});
            deps.config.customHotkey = 'Control+Alt';
            documentTarget.emit('mousemove', trustedEvent({clientX: 201, clientY: 20}));
            expect(deps.handleTranslation).toHaveBeenCalledTimes(2);
            expect(deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
        } finally { split.mockRestore(); }
    });

    it.each(['blur', 'config-change', 'right-button', 'middle-button'])('长按在 %s 时保留宿主手势，不触发迟到翻译', reason => {
        vi.useFakeTimers();
        const {deps, documentTarget, windowTarget} = mountHarness();
        deps.config.hotkey = deps.constants.LongPress;
        documentTarget.emit('mousedown', trustedEvent({
            clientX: 10, clientY: 20,
            button: reason === 'right-button' ? 2 : reason === 'middle-button' ? 1 : 0,
        }));
        if (reason === 'blur') windowTarget.emit('blur');
        if (reason === 'config-change') deps.config.hotkey = deps.constants.DoubleClick;

        vi.advanceTimersByTime(500);

        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('可信 mousemove 与 scroll 即使未按热键也推进宿主手势代次', () => {
        const {deps, documentTarget} = mountHarness();

        documentTarget.emit('mousemove', trustedEvent());
        documentTarget.emit('scroll', trustedEvent());
        documentTarget.emit('mousemove', trustedEvent({isTrusted: false}));

        expect(deps.noteBilingualHostGesture).toHaveBeenCalledTimes(2);
        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('外部仲裁器可重置旧悬浮手势并取消其待执行翻译', () => {
        const {deps, resetKeyboardGesture, windowTarget} = mountHarness();
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));

        resetKeyboardGesture();
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));

        expect(deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('标准化组合键并要求按键集合精确匹配', () => {
        expect(normalizeHoverHotkeyParts(undefined)).toEqual([]);
        expect(normalizeHoverHotkeyParts('none')).toEqual([]);
        expect(normalizeHoverHotkeyParts(' Ctrl + Option + A ')).toEqual(['control', 'alt', 'a']);
        expect(normalizeHoverHotkeyParts(' Ctrl + Option ')).toEqual(['control', 'alt']);
        expect(normalizeHoverHotkeyParts('Control+Shift++')).toEqual(['control', 'shift', '+']);
        expect(matchesPressedHotkeyParts([], new Set())).toBe(false);
        expect(matchesPressedHotkeyParts(['control'], new Set(['control']))).toBe(true);
        expect(matchesPressedHotkeyParts(['control'], new Set(['control', 'c']))).toBe(false);
    });

    it('录制器合法的字面量加号快捷键保留普通键，不会误触发仅修饰键组合', () => {
        const {deps, documentTarget, windowTarget} = mountHarness();
        Object.assign(deps.config, {hotkey: 'custom', customHotkey: 'Control+Shift++'});
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        windowTarget.emit('keydown', trustedEvent({key: 'Shift', code: 'ShiftLeft', ctrlKey: true, shiftKey: true}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 10, clientY: 20}));
        expect(deps.handleTranslation).not.toHaveBeenCalled();
        windowTarget.emit('keydown', trustedEvent({key: '+', code: 'Equal', ctrlKey: true, shiftKey: true}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 30, clientY: 40}));
        windowTarget.emit('keyup', trustedEvent({key: '+', code: 'Equal', ctrlKey: true, shiftKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Shift', code: 'ShiftLeft', ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(deps.handleTranslation).toHaveBeenCalledOnce();
        expect(deps.handleTranslation).toHaveBeenCalledWith(30, 40, {delayMs: 120, continuous: true});
    });

    it.each([
        {platform: 'MacIntel', shortcut: 'Ctrl+Option+/',
            down: {key: '÷', code: 'Slash', ctrlKey: true, altKey: true},
            releases: [{key: '/', code: 'Slash', ctrlKey: true, altKey: true},
                {key: 'Alt', code: 'AltLeft', ctrlKey: true}, {key: 'Control', code: 'ControlLeft'}]},
        {platform: 'Win32', shortcut: 'Ctrl+Shift++',
            down: {key: '+', code: 'Equal', metaKey: true, shiftKey: true},
            releases: [{key: '=', code: 'Equal', metaKey: true, shiftKey: true},
                {key: 'Shift', code: 'ShiftLeft', metaKey: true}, {key: 'Meta', code: 'MetaLeft'}]},
    ])('$platform 的修饰键别名与字形回退在完整释放后执行一次 $shortcut', ({platform, shortcut, down, releases}) => {
        const {deps, windowTarget} = mountHarness({navigator: {platform} as Navigator});
        Object.assign(deps.config, {hotkey: 'custom', customHotkey: shortcut});
        windowTarget.emit('keydown', trustedEvent(down));
        releases.forEach(release => windowTarget.emit('keyup', trustedEvent(release)));
        expect(vi.mocked(deps.handleTranslation).mock.calls).toEqual([[0, 0]]);
    });

    it.each([
        {label: '0ms', delayMs: 0},
        {label: '120ms', delayMs: 120},
    ] as const)('$label 移动手势每次都显式传 continuous=true，keyup 不重复触发', ({delayMs}) => {
        const {deps, documentTarget, windowTarget} = mountHarness();
        deps.config.mouseHoverTranslationDelay = delayMs;
        const keydown = trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true});

        windowTarget.emit('keydown', keydown);
        documentTarget.emit('mousemove', trustedEvent({clientX: 10, clientY: 20}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 10, clientY: 26}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));

        expect(keydown.preventDefault).toHaveBeenCalledOnce();
        expect(deps.handleTranslation).toHaveBeenNthCalledWith(1, 10, 20, {
            delayMs,
            continuous: true,
        });
        expect(deps.handleTranslation).toHaveBeenNthCalledWith(2, 10, 26, {
            delayMs,
            continuous: true,
        });
        expect(deps.handleTranslation).toHaveBeenCalledTimes(2);
    });

    it('未移动时在释放完整快捷键后触发一次当前位置翻译', () => {
        const {deps, windowTarget} = mountHarness();

        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        const keyup = trustedEvent({key: 'Control', code: 'ControlLeft'});
        windowTarget.emit('keyup', keyup);

        expect(keyup.preventDefault).toHaveBeenCalledOnce();
        expect(keyup.stopPropagation).toHaveBeenCalledOnce();
        expect(deps.handleTranslation).toHaveBeenCalledWith(0, 0);
        expect(vi.mocked(deps.handleTranslation).mock.calls).toEqual([[0, 0]]);
    });

    it('站点禁用、非可信事件、重复按键和 macOS Command 都不会触发', () => {
        const {deps, documentTarget, windowTarget} = mountHarness({isSiteDisabled: () => true});

        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 1, clientY: 2}));
        documentTarget.emit('dblclick', trustedEvent({clientX: 1, clientY: 2}));
        expect(deps.handleTranslation).not.toHaveBeenCalled();

        const enabled = mountHarness();
        enabled.windowTarget.emit('keydown', {...trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}), isTrusted: false});
        enabled.windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true, repeat: true}));
        enabled.windowTarget.emit('keydown', trustedEvent({key: 'Meta', code: 'MetaLeft', metaKey: true}));
        enabled.documentTarget.emit('mousemove', {...trustedEvent({clientX: 1, clientY: 2}), isTrusted: false});
        enabled.windowTarget.emit('keyup', {...trustedEvent({key: 'Control', code: 'ControlLeft'}), isTrusted: false});
        enabled.windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(enabled.deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('额外按键、窗口失焦和有效选区会取消已进入候选态的悬浮翻译', () => {
        const hasSelection = vi.fn(() => true);
        const {deps, documentTarget, windowTarget} = mountHarness({hasActiveSelectionTranslationCandidate: hasSelection});

        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        windowTarget.emit('keydown', trustedEvent({key: 'c', code: 'KeyC', ctrlKey: true}));
        expect(deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
        documentTarget.emit('pointerdown', {...trustedEvent(), isTrusted: false});

        const pointerHarness = mountHarness({hasActiveSelectionTranslationCandidate: hasSelection});
        pointerHarness.windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        pointerHarness.documentTarget.emit('pointerdown', trustedEvent());
        expect(pointerHarness.deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();

        const idlePointer = mountHarness({hasActiveSelectionTranslationCandidate: hasSelection});
        idlePointer.documentTarget.emit('pointerdown', trustedEvent());
        expect(idlePointer.deps.cancelPendingHoverTranslation).not.toHaveBeenCalled();

        const customSelectionPointer = mountHarness({
            getConfiguredSelectionHotkey: () => 'custom',
            getCustomSelectionHotkey: () => 'Control',
            hasActiveSelectionTranslationCandidate: hasSelection,
        });
        customSelectionPointer.windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        customSelectionPointer.documentTarget.emit('pointerdown', trustedEvent());
        expect(customSelectionPointer.deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();

        const disabledPointer = mountHarness({
            isSiteDisabled: () => true,
            hasActiveSelectionTranslationCandidate: hasSelection,
        });
        disabledPointer.windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        disabledPointer.documentTarget.emit('pointerdown', trustedEvent());
        expect(disabledPointer.deps.cancelPendingHoverTranslation).not.toHaveBeenCalled();

        const selectionDragStart = mountHarness({
            hasActiveSelectionTranslationCandidate: () => false,
        });
        selectionDragStart.windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        selectionDragStart.documentTarget.emit('pointerdown', trustedEvent());
        expect(selectionDragStart.deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();

        const blurHarness = mountHarness({hasActiveSelectionTranslationCandidate: hasSelection});
        blurHarness.windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        blurHarness.windowTarget.emit('blur');
        expect(blurHarness.deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
    });

    it('额外组合键取消后，移动和先释放额外键都不能恢复本轮悬浮手势', () => {
        const {deps, documentTarget, windowTarget} = mountHarness();
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        windowTarget.emit('keydown', trustedEvent({key: 'c', code: 'KeyC', ctrlKey: true}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 10, clientY: 20, ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'c', code: 'KeyC', ctrlKey: true}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 30, clientY: 40, ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));

        expect(deps.handleTranslation).not.toHaveBeenCalled();
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 50, clientY: 60, ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(vi.mocked(deps.handleTranslation).mock.calls).toEqual([[50, 60, {delayMs: 120, continuous: true}]]);
    });

    it.each(['Control', 'Shift'])('释放 Control+Shift 的 %s 后，鼠标移动不再触发连续翻译', (released) => {
        const {deps, documentTarget, windowTarget} = mountHarness();
        deps.config.hotkey = 'Control+Shift';
        windowTarget.emit('keydown', trustedEvent({key: 'Shift', code: 'ShiftLeft', ctrlKey: true, shiftKey: true}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 10, clientY: 20, ctrlKey: true, shiftKey: true}));
        windowTarget.emit('keyup', trustedEvent({
            key: released,
            code: `${released}Left`,
            ctrlKey: released !== 'Control',
            shiftKey: released !== 'Shift',
        }));
        documentTarget.emit('mousemove', trustedEvent({clientX: 30, clientY: 40}));
        windowTarget.emit('keyup', trustedEvent({key: released === 'Control' ? 'Shift' : 'Control'}));

        expect(vi.mocked(deps.handleTranslation).mock.calls).toEqual([[10, 20, {delayMs: 120, continuous: true}]]);
    });

    it('macOS Command 打断已有 Control 手势，释放 Command 后也不能恢复翻译', () => {
        const {deps, documentTarget, windowTarget} = mountHarness();
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        const command = trustedEvent({key: 'Meta', code: 'MetaLeft', ctrlKey: true, metaKey: true});
        windowTarget.emit('keydown', command);
        documentTarget.emit('mousemove', trustedEvent({clientX: 10, clientY: 20, ctrlKey: true, metaKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Meta', code: 'MetaLeft', ctrlKey: true}));
        // 同时按另一侧 Control 也不能让已经取消的同轮手势重新进入候选。
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlRight', ctrlKey: true}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 30, clientY: 40, ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlRight', ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));

        expect(deps.cancelPendingHoverTranslation).toHaveBeenCalled();
        expect(command.preventDefault).not.toHaveBeenCalled();
        expect(command.stopPropagation).not.toHaveBeenCalled();
        expect(deps.handleTranslation).not.toHaveBeenCalled();
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(vi.mocked(deps.handleTranslation).mock.calls).toEqual([[30, 40]]);
    });

    it('纯 Control 组合的单次切换等到最后一个键释放，不因缺少 metaKey 提前触发', () => {
        const {deps, windowTarget} = mountHarness();
        deps.config.hotkey = 'Control+x';
        windowTarget.emit('keydown', trustedEvent({key: 'x', code: 'KeyX', ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'x', code: 'KeyX', ctrlKey: true}));
        expect(deps.handleTranslation).not.toHaveBeenCalled();
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(vi.mocked(deps.handleTranslation).mock.calls).toEqual([[0, 0]]);
    });

    it.each(['move', 'release'])('快捷键配置改变后，旧手势的 %s 不触发新配置翻译', (completion) => {
        const {deps, documentTarget, windowTarget} = mountHarness();
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        deps.config.hotkey = 'Alt';
        if (completion === 'move') documentTarget.emit('mousemove', trustedEvent({clientX: 30, clientY: 40}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('临时禁用期间释放按键后，再启用不能复活旧悬浮手势', () => {
        let disabled = false;
        const {deps, documentTarget, windowTarget} = mountHarness({isSiteDisabled: () => disabled});
        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        disabled = true;
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));
        disabled = false;
        documentTarget.emit('mousemove', trustedEvent({clientX: 30, clientY: 40}));
        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('划词快捷键未匹配时，有选区也不会取消 hover 候选', () => {
        const {deps, documentTarget, windowTarget} = mountHarness({
            getConfiguredSelectionHotkey: () => 'Alt',
            hasActiveSelectionTranslationCandidate: () => true,
        });

        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        documentTarget.emit('selectionchange', trustedEvent());
        documentTarget.emit('mousemove', trustedEvent({clientX: 12, clientY: 24}));

        expect(deps.cancelPendingHoverTranslation).not.toHaveBeenCalled();
        expect(deps.handleTranslation).toHaveBeenCalledWith(12, 24, {
            delayMs: 120,
            continuous: true,
        });
    });

    it('selectionchange 在划词快捷键匹配且存在有效选区时取消 hover 候选', () => {
        const {deps, documentTarget, windowTarget} = mountHarness({
            hasActiveSelectionTranslationCandidate: () => true,
        });

        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        documentTarget.emit('selectionchange', trustedEvent());
        documentTarget.emit('mousemove', trustedEvent({clientX: 12, clientY: 24}));

        expect(deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('mousemove 触发前发现有效选区时取消 hover 候选', () => {
        const {deps, documentTarget, windowTarget} = mountHarness({
            hasActiveSelectionTranslationCandidate: () => true,
        });

        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 12, clientY: 24}));

        expect(deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });


    it('支持字母、功能键、特殊键、非 macOS meta 映射和 selection shortcut stopPropagation 分支', () => {
        const functionKey = mountHarness({navigator: {platform: 'Win32'} as Navigator});
        functionKey.deps.config.hotkey = 'F1';
        functionKey.windowTarget.emit('keydown', trustedEvent({key: 'F1', code: 'F1'}));
        functionKey.windowTarget.emit('keyup', trustedEvent({key: 'F1', code: 'F1'}));
        expect(functionKey.deps.handleTranslation).toHaveBeenCalledWith(0, 0);

        const singleCharacter = mountHarness();
        singleCharacter.deps.config.hotkey = 'x';
        singleCharacter.windowTarget.emit('keydown', trustedEvent({key: 'x', code: ''}));
        singleCharacter.windowTarget.emit('keyup', trustedEvent({key: 'x', code: ''}));
        singleCharacter.windowTarget.emit('keydown', trustedEvent({key: 'x', code: 'KeyX'}));
        singleCharacter.windowTarget.emit('keyup', trustedEvent({key: 'x', code: 'KeyX'}));
        expect(singleCharacter.deps.handleTranslation).toHaveBeenCalledWith(0, 0);

        const specialKey = mountHarness();
        specialKey.deps.config.hotkey = 'Escape';
        specialKey.windowTarget.emit('keydown', trustedEvent({key: 'Escape', code: 'Escape'}));
        specialKey.windowTarget.emit('keyup', trustedEvent({key: 'Escape', code: 'Escape'}));
        expect(specialKey.deps.handleTranslation).toHaveBeenCalledWith(0, 0);

        const metaKey = mountHarness({navigator: {platform: 'Win32'} as Navigator});
        metaKey.deps.config.hotkey = 'Control';
        metaKey.windowTarget.emit('keydown', trustedEvent({key: 'Meta', code: 'MetaLeft', metaKey: true}));
        metaKey.windowTarget.emit('keyup', trustedEvent({key: 'Meta', code: 'MetaLeft'}));
        expect(metaKey.deps.handleTranslation).toHaveBeenCalledWith(0, 0);

        const selectionShortcut = mountHarness({matchesSelectionTranslatorShortcut: () => true});
        const event = trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true});
        selectionShortcut.windowTarget.emit('keydown', event);
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(event.stopPropagation).not.toHaveBeenCalled();

        const customCombo = mountHarness();
        customCombo.deps.config.hotkey = 'custom';
        customCombo.deps.config.customHotkey = 'Alt+Shift+x';
        customCombo.windowTarget.emit('keydown', trustedEvent({
            key: 'x',
            code: 'KeyX',
            altKey: true,
            shiftKey: true,
        }));
        customCombo.windowTarget.emit('keyup', trustedEvent({key: 'x', code: 'KeyX'}));
        expect(customCombo.deps.handleTranslation).toHaveBeenCalledWith(0, 0);
    });

    it('自定义悬浮快捷键与录制器使用同一逻辑按键：Shift 数字、Option 字形与非 QWERTY 字母', () => {
        const shiftDigit = mountHarness();
        Object.assign(shiftDigit.deps.config, {hotkey: 'custom', customHotkey: 'Alt+Shift+1'});
        shiftDigit.windowTarget.emit('keydown', trustedEvent({key: '!', code: 'Digit1', altKey: true, shiftKey: true}));
        // 先松开 Shift 时 keyup 的 key 变为 1，仍须按物理键移除，完整释放后触发一次。
        shiftDigit.windowTarget.emit('keyup', trustedEvent({key: 'Shift', code: 'ShiftLeft', altKey: true}));
        shiftDigit.windowTarget.emit('keyup', trustedEvent({key: '1', code: 'Digit1', altKey: true}));
        shiftDigit.windowTarget.emit('keyup', trustedEvent({key: 'Alt', code: 'AltLeft'}));
        expect(shiftDigit.deps.handleTranslation).toHaveBeenCalledOnce();

        const optionGlyph = mountHarness();
        Object.assign(optionGlyph.deps.config, {hotkey: 'custom', customHotkey: 'Alt+/'});
        optionGlyph.windowTarget.emit('keydown', trustedEvent({key: '÷', code: 'Slash', altKey: true}));
        optionGlyph.windowTarget.emit('keyup', trustedEvent({key: '÷', code: 'Slash', altKey: true}));
        optionGlyph.windowTarget.emit('keyup', trustedEvent({key: 'Alt', code: 'AltLeft'}));
        expect(optionGlyph.deps.handleTranslation).toHaveBeenCalledOnce();

        const dvorak = mountHarness();
        Object.assign(dvorak.deps.config, {hotkey: 'custom', customHotkey: 'Alt+T'});
        dvorak.windowTarget.emit('keydown', trustedEvent({key: 'y', code: 'KeyT', altKey: true}));
        dvorak.windowTarget.emit('keyup', trustedEvent({key: 'y', code: 'KeyT', altKey: true}));
        dvorak.windowTarget.emit('keyup', trustedEvent({key: 'Alt', code: 'AltLeft'}));
        expect(dvorak.deps.handleTranslation).not.toHaveBeenCalled();
        dvorak.windowTarget.emit('keydown', trustedEvent({key: 't', code: 'KeyK', altKey: true}));
        dvorak.windowTarget.emit('keyup', trustedEvent({key: 't', code: 'KeyK', altKey: true}));
        dvorak.windowTarget.emit('keyup', trustedEvent({key: 'Alt', code: 'AltLeft'}));
        expect(dvorak.deps.handleTranslation).toHaveBeenCalledOnce();
    });

    it('划词明确预留快捷键时清空 hover 状态并不阻止后续 selection 监听', () => {
        const {deps, windowTarget} = mountHarness({shouldReserveSelectionShortcut: () => true});

        windowTarget.emit('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));

        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('支持触摸、双击、长按、中键和屏幕连击触发，并在 abort 时清理计时器', () => {
        vi.useFakeTimers();
        const {deps, documentTarget, controller} = mountHarness();

        deps.config.hotkey = 'twoFinger';
        documentTarget.emit('touchstart', trustedEvent({touches: [{clientX: 1, clientY: 2}, {clientX: 3, clientY: 4}]}));
        deps.config.hotkey = 'threeFinger';
        documentTarget.emit('touchstart', trustedEvent({touches: [{clientX: 1, clientY: 2}, {clientX: 3, clientY: 4}, {clientX: 5, clientY: 6}]}));
        deps.config.hotkey = 'fourFinger';
        documentTarget.emit('touchstart', trustedEvent({touches: [{}, {}, {}, {}]}));
        deps.config.hotkey = 'disabledGesture';
        documentTarget.emit('touchstart', trustedEvent({touches: [{}, {}]}));
        expect(deps.getCenterPoint).toHaveBeenCalledTimes(3);

        deps.config.hotkey = 'doubleClick';
        documentTarget.emit('dblclick', {...trustedEvent({clientX: 0, clientY: 0}), isTrusted: false});
        documentTarget.emit('dblclick', trustedEvent({clientX: 8, clientY: 9}));
        deps.config.hotkey = 'middleClick';
        documentTarget.emit('mousedown', {...trustedEvent({button: 1, clientX: 0, clientY: 0}), isTrusted: false});
        documentTarget.emit('mousedown', trustedEvent({button: 0, clientX: 0, clientY: 0}));
        documentTarget.emit('mousedown', trustedEvent({button: 1, clientX: 11, clientY: 13}));
        deps.config.hotkey = 'longPress';
        documentTarget.emit('mousedown', trustedEvent({clientX: 21, clientY: 34}));
        vi.advanceTimersByTime(500);

        deps.config.hotkey = 'doubleClickScreen';
        documentTarget.emit('touchstart', trustedEvent({touches: [{clientX: 55, clientY: 89}]}));
        documentTarget.emit('touchstart', trustedEvent({touches: [{clientX: 55, clientY: 89}]}));
        deps.config.hotkey = 'tripleClickScreen';
        documentTarget.emit('touchstart', {...trustedEvent({touches: [{clientX: 0, clientY: 0}]}), isTrusted: false});
        documentTarget.emit('touchstart', trustedEvent({touches: [{clientX: 0, clientY: 0}, {clientX: 1, clientY: 1}]}));
        deps.config.hotkey = 'middleClick';
        documentTarget.emit('touchstart', trustedEvent({touches: [{clientX: 0, clientY: 0}]}));
        deps.config.hotkey = undefined;
        documentTarget.emit('touchstart', trustedEvent({touches: [{clientX: 0, clientY: 0}]}));
        deps.config.hotkey = 'tripleClickScreen';
        documentTarget.emit('touchstart', trustedEvent({touches: [{clientX: 5, clientY: 8}]}));
        documentTarget.emit('touchstart', trustedEvent({touches: [{clientX: 5, clientY: 8}]}));
        documentTarget.emit('touchstart', trustedEvent({touches: [{clientX: 5, clientY: 8}]}));

        documentTarget.emit('mousedown', trustedEvent({clientX: 1, clientY: 1}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 30, clientY: 30}));
        documentTarget.emit('mouseup', trustedEvent());
        controller.abort();

        expect(deps.handleTranslation).toHaveBeenCalledWith(7, 9);
        expect(deps.handleTranslation).toHaveBeenCalledWith(8, 9);
        expect(deps.handleTranslation).toHaveBeenCalledWith(11, 13);
        expect(deps.handleTranslation).toHaveBeenCalledWith(21, 34);
        expect(deps.handleTranslation).toHaveBeenCalledWith(55, 89);
        expect(deps.handleTranslation).toHaveBeenCalledWith(5, 8);
        expect(vi.mocked(deps.handleTranslation).mock.calls.every(call => call.length === 2)).toBe(true);
    });

    it('中键和屏幕连击在站点禁用时被 guard 拦截', () => {
        const {deps, documentTarget} = mountHarness({isSiteDisabled: () => true});

        deps.config.hotkey = 'middleClick';
        documentTarget.emit('mousedown', trustedEvent({button: 1, clientX: 1, clientY: 1}));
        deps.config.hotkey = 'doubleClickScreen';
        documentTarget.emit('touchstart', trustedEvent({touches: [{clientX: 1, clientY: 1}]}));

        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('双击和 mouseup 在站点禁用或非可信事件时被 guard 拦截', () => {
        const disabled = mountHarness({isSiteDisabled: () => true});
        disabled.deps.config.hotkey = 'doubleClick';
        disabled.documentTarget.emit('dblclick', trustedEvent({clientX: 1, clientY: 1}));
        disabled.documentTarget.emit('mouseup', trustedEvent());

        const untrusted = mountHarness();
        untrusted.documentTarget.emit('mouseup', {...trustedEvent(), isTrusted: false});

        expect(disabled.deps.handleTranslation).not.toHaveBeenCalled();
        expect(untrusted.deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('长按开始后移动超过阈值会取消本次长按翻译', () => {
        vi.useFakeTimers();
        const {deps, documentTarget} = mountHarness();

        deps.config.hotkey = 'longPress';
        documentTarget.emit('mousedown', trustedEvent({clientX: 1, clientY: 1}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 30, clientY: 30}));
        vi.advanceTimersByTime(500);

        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('长按开始后仅 Y 轴移动超过阈值也会取消本次长按翻译', () => {
        vi.useFakeTimers();
        const {deps, documentTarget} = mountHarness();

        deps.config.hotkey = 'longPress';
        documentTarget.emit('mousedown', trustedEvent({clientX: 1, clientY: 1}));
        documentTarget.emit('mousemove', trustedEvent({clientX: 5, clientY: 30}));
        vi.advanceTimersByTime(500);

        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('mouseup 会清理尚未触发的长按计时器', () => {
        vi.useFakeTimers();
        const {deps, documentTarget} = mountHarness();

        deps.config.hotkey = 'longPress';
        documentTarget.emit('mousedown', trustedEvent({clientX: 1, clientY: 1}));
        documentTarget.emit('mouseup', trustedEvent());
        vi.advanceTimersByTime(500);

        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('重复 mousedown 会替换上一轮长按计时器', () => {
        vi.useFakeTimers();
        const {deps, documentTarget} = mountHarness();

        deps.config.hotkey = 'longPress';
        documentTarget.emit('mousedown', trustedEvent({clientX: 1, clientY: 1}));
        documentTarget.emit('mousedown', trustedEvent({clientX: 2, clientY: 3}));
        vi.advanceTimersByTime(500);

        expect(deps.handleTranslation).toHaveBeenCalledOnce();
        expect(deps.handleTranslation).toHaveBeenCalledWith(2, 3);
    });

    it('abort 会清理尚未触发的长按计时器', () => {
        vi.useFakeTimers();
        const {deps, documentTarget, controller} = mountHarness();

        deps.config.hotkey = 'longPress';
        documentTarget.emit('mousedown', trustedEvent({clientX: 1, clientY: 1}));
        controller.abort();
        vi.advanceTimersByTime(500);

        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });

    it('配置关闭时不保留按键状态、不拦截事件、不触发翻译', () => {
        const {deps, windowTarget} = mountHarness();
        deps.config.on = false;
        const keydown = trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true});

        windowTarget.emit('keydown', keydown);
        windowTarget.emit('keyup', trustedEvent({key: 'Control', code: 'ControlLeft'}));

        expect(keydown.preventDefault).not.toHaveBeenCalled();
        expect(deps.handleTranslation).not.toHaveBeenCalled();
    });
});

function mountSharedHoverShortcutHarness(shortcut = 'F9', overrides: Partial<HoverTranslationContentDependencies> = {}) {
    const selectionShortcut = {value: shortcut};
    const harness = mountHarness({
        getConfiguredSelectionHotkey: () => 'custom',
        getCustomSelectionHotkey: () => selectionShortcut.value,
        matchesSelectionTranslatorShortcut: vi.fn(event => matchesConfiguredHotkey(event, 'custom', selectionShortcut.value)),
        ...overrides,
    });
    Object.assign(harness.deps.config, {hotkey: 'custom', customHotkey: shortcut});
    const documentKeydown = vi.fn();
    const documentKeyup = vi.fn();
    harness.documentTarget.addEventListener('keydown', documentKeydown, {capture: true});
    harness.documentTarget.addEventListener('keyup', documentKeyup, {capture: true});
    // 仅模拟 Window capture 到 Document 的交接；观察器不模拟 Vue 的 held 状态或卡片。
    const dispatch = (type: 'keydown' | 'keyup', event: ReturnType<typeof trustedEvent>) => {
        harness.windowTarget.emit(type, event);
        if (event.stopPropagation.mock.calls.length === 0) harness.documentTarget.emit(type, event);
    };
    return {...harness, selectionShortcut, documentKeydown, documentKeyup, dispatch};
}

describe('shared hover shortcut release ownership', () => {
    it('共享 custom F9 仍执行一次 hover，并将 keyup 交给 Document 清理；完整释放后不保留共享归属', () => {
        const {deps, selectionShortcut, documentKeydown, documentKeyup, dispatch} = mountSharedHoverShortcutHarness();
        const keydown = trustedEvent({key: 'F9', code: 'F9'});
        const keyup = trustedEvent({key: 'F9', code: 'F9'});
        dispatch('keydown', keydown);
        dispatch('keyup', keyup);

        expect(keydown.preventDefault).toHaveBeenCalledOnce();
        expect(keydown.stopPropagation).not.toHaveBeenCalled();
        expect(documentKeydown.mock.calls).toEqual([[keydown]]);
        expect(keyup.preventDefault).toHaveBeenCalledOnce();
        expect(keyup.stopPropagation).not.toHaveBeenCalled();
        expect(documentKeyup.mock.calls).toEqual([[keyup]]);
        expect(vi.mocked(deps.handleTranslation).mock.calls).toEqual([[0, 0]]);
        expect(deps.matchesSelectionTranslatorShortcut).toHaveBeenCalledOnce();

        dispatch('keyup', trustedEvent({key: 'F9', code: 'F9'}));
        expect(deps.handleTranslation).toHaveBeenCalledOnce();
        documentKeyup.mockClear();
        selectionShortcut.value = 'F10';
        const ordinaryDown = trustedEvent({key: 'F9', code: 'F9'});
        const ordinaryUp = trustedEvent({key: 'F9', code: 'F9'});
        dispatch('keydown', ordinaryDown);
        dispatch('keyup', ordinaryUp);
        expect(ordinaryDown.stopPropagation).toHaveBeenCalledOnce();
        expect(ordinaryUp.stopPropagation).toHaveBeenCalledOnce();
        expect(documentKeyup).not.toHaveBeenCalled();
        expect(vi.mocked(deps.handleTranslation).mock.calls).toEqual([[0, 0], [0, 0]]);
    });

    it.each(['modifier-first', 'primary-first'] as const)('共享 Control+Shift+F9 的 %s 释放顺序保持开始时归属', order => {
        const {deps, documentKeyup, dispatch} = mountSharedHoverShortcutHarness('Control+Shift+F9');
        dispatch('keydown', trustedEvent({key: 'Control', code: 'ControlLeft', ctrlKey: true}));
        dispatch('keydown', trustedEvent({key: 'Shift', code: 'ShiftLeft', ctrlKey: true, shiftKey: true}));
        dispatch('keydown', trustedEvent({key: 'F9', code: 'F9', ctrlKey: true, shiftKey: true}));
        const releases = order === 'modifier-first'
            ? [
                trustedEvent({key: 'Shift', code: 'ShiftLeft', ctrlKey: true}),
                trustedEvent({key: 'Control', code: 'ControlLeft'}),
                trustedEvent({key: 'F9', code: 'F9'}),
            ]
            : [
                trustedEvent({key: 'F9', code: 'F9', ctrlKey: true, shiftKey: true}),
                trustedEvent({key: 'Shift', code: 'ShiftLeft', ctrlKey: true}),
                trustedEvent({key: 'Control', code: 'ControlLeft'}),
            ];
        for (const [index, release] of releases.entries()) {
            dispatch('keyup', release);
            expect(release.stopPropagation).not.toHaveBeenCalled();
            expect(documentKeyup).toHaveBeenNthCalledWith(index + 1, release);
            expect(deps.handleTranslation).toHaveBeenCalledTimes(index === releases.length - 1 ? 1 : 0);
        }
        expect(matchesConfiguredHotkey(releases[2], 'custom', 'Control+Shift+F9')).toBe(false);
        expect(deps.matchesSelectionTranslatorShortcut).toHaveBeenCalledTimes(3);
        expect(vi.mocked(deps.handleTranslation).mock.calls).toEqual([[0, 0]]);
    });

    it.each([true, false])('划词配置改变不重算本轮共享归属 sharedAtStart=%s', sharedAtStart => {
        const {deps, selectionShortcut, documentKeyup, dispatch} = mountSharedHoverShortcutHarness();
        selectionShortcut.value = sharedAtStart ? 'F9' : 'F10';
        dispatch('keydown', trustedEvent({key: 'F9', code: 'F9'}));
        selectionShortcut.value = sharedAtStart ? 'F10' : 'F9';
        const keyup = trustedEvent({key: 'F9', code: 'F9'});
        dispatch('keyup', keyup);
        if (sharedAtStart) {
            expect(keyup.stopPropagation).not.toHaveBeenCalled();
            expect(documentKeyup.mock.calls).toEqual([[keyup]]);
        } else {
            expect(keyup.stopPropagation).toHaveBeenCalledOnce();
            expect(documentKeyup).not.toHaveBeenCalled();
        }
        expect(deps.matchesSelectionTranslatorShortcut).toHaveBeenCalledOnce();
        expect(vi.mocked(deps.handleTranslation).mock.calls).toEqual([[0, 0]]);
    });

    it.each([
        'reset', 'blur', 'selection-reserved', 'hover-config-change', 'disabled',
        'site-disabled', 'extra-key', 'pointerdown', 'selectionchange', 'abort',
    ])('共享手势在 %s 后释放不触发 hover，取消归属不泄漏到下一轮', reason => {
        let disabled = false;
        const {
            deps, selectionShortcut, documentTarget, windowTarget, controller,
            resetKeyboardGesture, documentKeyup, dispatch,
        } = mountSharedHoverShortcutHarness('F9', {isSiteDisabled: () => disabled});
        dispatch('keydown', trustedEvent({key: 'F9', code: 'F9'}));
        if (reason === 'reset') resetKeyboardGesture();
        if (reason === 'blur') windowTarget.emit('blur');
        if (reason === 'selection-reserved') {
            selectionShortcut.value = 'F10';
            vi.mocked(deps.shouldReserveSelectionShortcut).mockReturnValue(true);
            dispatch('keydown', trustedEvent({key: 'F10', code: 'F10'}));
        }
        if (reason === 'hover-config-change') deps.config.customHotkey = 'F10';
        if (reason === 'disabled') deps.config.on = false;
        if (reason === 'site-disabled') disabled = true;
        if (reason === 'extra-key') {
            dispatch('keydown', trustedEvent({key: 'x', code: 'KeyX'}));
            dispatch('keyup', trustedEvent({key: 'x', code: 'KeyX'}));
        }
        if (reason === 'pointerdown') documentTarget.emit('pointerdown', trustedEvent());
        if (reason === 'selectionchange') {
            vi.mocked(deps.hasActiveSelectionTranslationCandidate).mockReturnValue(true);
            documentTarget.emit('selectionchange', trustedEvent());
        }
        if (reason === 'abort') controller.abort();
        const keyup = trustedEvent({key: 'F9', code: 'F9'});
        dispatch('keyup', keyup);
        expect(deps.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
        expect(deps.handleTranslation).not.toHaveBeenCalled();
        expect(keyup.preventDefault).not.toHaveBeenCalled();
        expect(keyup.stopPropagation).not.toHaveBeenCalled();
        expect(documentKeyup).toHaveBeenLastCalledWith(keyup);
        if (reason === 'abort') return;

        Object.assign(deps.config, {on: true, customHotkey: 'F9'});
        disabled = false;
        selectionShortcut.value = 'F10';
        vi.mocked(deps.shouldReserveSelectionShortcut).mockReturnValue(false);
        vi.mocked(deps.hasActiveSelectionTranslationCandidate).mockReturnValue(false);
        documentTarget.emit('mousemove', trustedEvent({clientX: 0, clientY: 0}));
        documentKeyup.mockClear();
        dispatch('keydown', trustedEvent({key: 'F9', code: 'F9'}));
        const ordinaryUp = trustedEvent({key: 'F9', code: 'F9'});
        dispatch('keyup', ordinaryUp);
        expect(ordinaryUp.stopPropagation).toHaveBeenCalledOnce();
        expect(documentKeyup).not.toHaveBeenCalled();
        expect(vi.mocked(deps.handleTranslation).mock.calls).toEqual([[0, 0]]);
    });
});
