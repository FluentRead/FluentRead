import { describe, expect, it, vi } from 'vitest';
import {readFileSync} from 'node:fs';

import { ensureContentFeatureMounted } from '@/src/app/content/featureLifecycle';
import {
    createContentPageAvailabilityRuntime, reconcileCurrentContentPage,
    createContentRouteChangeHandler,
    getAutoTranslationPageIdentity,
} from '@/src/app/content/pageAvailability';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
    return {promise, resolve};
}

describe('content feature activation lifecycle', () => {
    it('retries after a restored activation reused the disabled activation pending mount', async () => {
        const staleMount = deferred<void>();
        let mounted = false;
        let callCount = 0;
        const mount = vi.fn(() => {
            callCount += 1;
            if (callCount === 1) return staleMount.promise;
            mounted = true;
            return Promise.resolve();
        });

        const activation = ensureContentFeatureMounted({
            mount,
            isMounted: () => mounted,
            isStillDesired: () => true,
        });
        staleMount.resolve();
        await activation;

        expect(mount).toHaveBeenCalledTimes(2);
        expect(mounted).toBe(true);
    });

    it('does not retry a settled mount after the activation was disabled again', async () => {
        const staleMount = deferred<void>();
        let desired = true;
        const mount = vi.fn(() => staleMount.promise);

        const activation = ensureContentFeatureMounted({
            mount,
            isMounted: () => false,
            isStillDesired: () => desired,
        });
        desired = false;
        staleMount.resolve();
        await activation;

        expect(mount).toHaveBeenCalledTimes(1);
    });
});

describe('content 页面总开关与 SPA 路由生命周期', () => {
    it('页面身份保留路径和查询，只排除阅读锚点，异常地址保持可比较', () => {
        expect(getAutoTranslationPageIdentity('https://example.com/article?q=one#section'))
            .toBe('https://example.com/article?q=one');
        expect(getAutoTranslationPageIdentity('https://example.com/article?q=two'))
            .not.toBe(getAutoTranslationPageIdentity('https://example.com/article?q=one'));
        expect(getAutoTranslationPageIdentity('invalid-page#section')).toBe('invalid-page');
        expect(getAutoTranslationPageIdentity('https://example.com/#/article/1'))
            .not.toBe(getAutoTranslationPageIdentity('https://example.com/#/article/2'));
        expect(getAutoTranslationPageIdentity('https://example.com/#!/article/1'))
            .toBe('https://example.com/#!/article/1');
    });

    it('始终翻译的新 SPA 页面会重启，同页恢复和锚点跳转保持用户的原文意图', () => {
        let href = 'https://example.com/first';
        let fullPageActive = false;
        let automatic = true;
        const autoTranslate = vi.fn(() => { fullPageActive = true; });
        const runtime = createContentPageAvailabilityRuntime({
            isEnabled: () => true, isPageFeaturesActive: () => true,
            isVideoPage: () => false, getPageIdentity: () => href,
            shouldAutomaticallyTranslate: () => automatic,
            isFullPageTranslationActive: () => fullPageActive,
            setMainWorldBridgesEnabled: vi.fn(), activatePageFeatures: vi.fn(async () => undefined),
            disposePageFeatures: vi.fn(), mountVideoSubtitle: () => vi.fn(), autoTranslate,
        });
        runtime.refreshAutoTranslation();
        expect(autoTranslate).toHaveBeenCalledOnce();
        fullPageActive = false; // 用户恢复原文。
        runtime.refreshAutoTranslation();
        href += '#details';
        runtime.refreshAutoTranslation();
        expect(autoTranslate).toHaveBeenCalledOnce();
        href = 'https://example.com/second';
        runtime.refreshAutoTranslation();
        runtime.refreshAutoTranslation();
        expect(autoTranslate).toHaveBeenCalledTimes(2);
        href = 'https://example.com/third';
        runtime.refreshAutoTranslation(); // 活跃会话继续观察新 DOM，不能重复创建。
        expect(autoTranslate).toHaveBeenCalledTimes(2);
        fullPageActive = false;
        runtime.refreshAutoTranslation();
        expect(autoTranslate).toHaveBeenCalledTimes(2);
        automatic = false;
        runtime.refreshAutoTranslation();
        automatic = true;
        runtime.refreshAutoTranslation();
        expect(autoTranslate).toHaveBeenCalledTimes(3);
        fullPageActive = false;
        href = 'https://example.com/#/article/1';
        runtime.refreshAutoTranslation();
        expect(autoTranslate).toHaveBeenCalledTimes(4);
        fullPageActive = false;
        href = 'https://example.com/#/article/2';
        runtime.refreshAutoTranslation();
        expect(autoTranslate).toHaveBeenCalledTimes(5);
    });

    it('非必要 UI 挂载尚未结束时已经启动翻译，禁用同步取消且迟到 activation 不重启', async () => {
        let enabled = true;
        let featuresActive = false;
        let fullPageActive = false;
        let href = 'https://example.com/first';
        const activation = deferred<void>();
        const autoTranslate = vi.fn(() => { fullPageActive = true; });
        const dispose = vi.fn(() => { featuresActive = false; fullPageActive = false; });
        const runtime = createContentPageAvailabilityRuntime({
            isEnabled: () => enabled, isPageFeaturesActive: () => featuresActive,
            isVideoPage: () => false, getPageIdentity: () => href,
            shouldAutomaticallyTranslate: () => true,
            isFullPageTranslationActive: () => fullPageActive,
            setMainWorldBridgesEnabled: vi.fn(),
            activatePageFeatures: async () => { featuresActive = true; await activation.promise; },
            disposePageFeatures: dispose, mountVideoSubtitle: () => vi.fn(), autoTranslate,
        });
        const pending = runtime.reconcile();
        await Promise.resolve();
        expect(autoTranslate).toHaveBeenCalledOnce();
        expect(fullPageActive).toBe(true);
        enabled = false;
        const disabling = runtime.reconcile();
        expect(fullPageActive).toBe(false);
        href = 'https://example.com/second';
        runtime.refreshAutoTranslation();
        activation.resolve();
        await Promise.all([pending, disabling]);
        expect(autoTranslate).toHaveBeenCalledOnce();
        expect(dispose).toHaveBeenCalledOnce();
        enabled = true;
        await runtime.reconcile();
        expect(autoTranslate).toHaveBeenCalledTimes(2);
    });
    it('同一 tick 的 100 次协调共享一个批次，下一次独立请求仍可协调', async () => {
        let active = false;
        let fullPageActive = false;
        const activate = vi.fn(async () => { active = true; });
        const setBridges = vi.fn();
        const shouldAutomaticallyTranslate = vi.fn(() => true);
        const autoTranslate = vi.fn(() => { fullPageActive = true; });
        const runtime = createContentPageAvailabilityRuntime({
            isEnabled: () => true, isPageFeaturesActive: () => active,
            isVideoPage: () => false, shouldAutomaticallyTranslate,
            isFullPageTranslationActive: () => fullPageActive,
            setMainWorldBridgesEnabled: setBridges, activatePageFeatures: activate,
            disposePageFeatures: vi.fn(), mountVideoSubtitle: () => vi.fn(), autoTranslate,
        });

        const batch = Array.from({length: 100}, () => runtime.reconcile());
        expect(batch.every((pending) => pending === batch[0])).toBe(true);
        await Promise.all(batch);
        expect(activate).toHaveBeenCalledOnce();
        expect(setBridges).toHaveBeenCalledTimes(2);
        expect(shouldAutomaticallyTranslate).toHaveBeenCalledTimes(2);
        expect(autoTranslate).toHaveBeenCalledOnce();

        const next = runtime.reconcile();
        expect(next).not.toBe(batch[0]);
        await next;
        expect(activate).toHaveBeenCalledTimes(2);
        expect(autoTranslate).toHaveBeenCalledOnce();
    });
    it('挂载期间的 100 次通知只增加一次最新状态核对，保持自动翻译幂等', async () => {
        let active = false;
        let fullPageActive = false;
        const activation = deferred<void>();
        const activate = vi.fn(async () => { active = true; await activation.promise; });
        const setBridges = vi.fn();
        const autoTranslate = vi.fn(() => { fullPageActive = true; });
        const runtime = createContentPageAvailabilityRuntime({
            isEnabled: () => true, isPageFeaturesActive: () => active,
            isVideoPage: () => false, shouldAutomaticallyTranslate: () => true,
            isFullPageTranslationActive: () => fullPageActive,
            setMainWorldBridgesEnabled: setBridges, activatePageFeatures: activate,
            disposePageFeatures: vi.fn(), mountVideoSubtitle: () => vi.fn(), autoTranslate,
        });

        const initial = runtime.reconcile();
        await Promise.resolve();
        expect(activate).toHaveBeenCalledOnce();
        expect(autoTranslate).toHaveBeenCalledOnce();
        const burst = Array.from({length: 100}, () => runtime.reconcile());
        expect(burst.every((pending) => pending === initial)).toBe(true);
        activation.resolve();
        await Promise.all([initial, ...burst]);
        expect(activate).toHaveBeenCalledTimes(2);
        expect(setBridges).toHaveBeenCalledTimes(4);
        expect(autoTranslate).toHaveBeenCalledOnce();
    });
    it('完成微任务窗口中的关闭再开启不会丢失，同步清理后按最新状态重新激活', async () => {
        let enabled = true;
        let active = false;
        let fullPageActive = false;
        let flipQueued = false;
        const reentrantRequests: Promise<void>[] = [];
        const activate = vi.fn(async () => { active = true; });
        const dispose = vi.fn(() => { active = false; fullPageActive = false; });
        const autoTranslate = vi.fn(() => { fullPageActive = true; });
        const runtime = createContentPageAvailabilityRuntime({
            isEnabled: () => enabled, isPageFeaturesActive: () => active,
            isVideoPage: () => {
                if (!flipQueued) {
                    flipQueued = true;
                    queueMicrotask(() => {
                        enabled = false;
                        reentrantRequests.push(runtime.reconcile());
                        expect(active).toBe(false);
                        expect(fullPageActive).toBe(false);
                        enabled = true;
                        reentrantRequests.push(runtime.reconcile());
                    });
                }
                return false;
            },
            shouldAutomaticallyTranslate: () => true,
            isFullPageTranslationActive: () => fullPageActive,
            setMainWorldBridgesEnabled: vi.fn(), activatePageFeatures: activate,
            disposePageFeatures: dispose, mountVideoSubtitle: () => vi.fn(), autoTranslate,
        });

        const initial = runtime.reconcile();
        await initial;
        expect(reentrantRequests).toEqual([initial, initial]);
        expect(dispose).toHaveBeenCalledOnce();
        expect(activate).toHaveBeenCalledTimes(2);
        expect(active).toBe(true);
        expect(fullPageActive).toBe(true);
        expect(autoTranslate).toHaveBeenCalledTimes(2);
    });
    it('caps non-progressing activations and permits recovery on the next explicit reconciliation', async () => {
        let active = false;
        let recover = false;
        const activate = vi.fn(async () => {
            // 原实现无限微任务重试时也要快速失败，不能让回归测试本身饿死超时器。
            if (activate.mock.calls.length > 5) throw new Error('unbounded activation');
            active = recover;
        });
        const dispose = vi.fn(() => { active = false; });
        const autoTranslate = vi.fn();
        const runtime = createContentPageAvailabilityRuntime({
            isEnabled: () => true, isPageFeaturesActive: () => active,
            isVideoPage: () => false, shouldAutomaticallyTranslate: () => true,
            isFullPageTranslationActive: () => false, setMainWorldBridgesEnabled: vi.fn(),
            activatePageFeatures: activate, disposePageFeatures: dispose,
            mountVideoSubtitle: () => vi.fn(), autoTranslate,
        });
        await Promise.all(Array.from({length: 100}, () => runtime.reconcile()));
        expect(activate).toHaveBeenCalledTimes(2);
        expect(dispose).toHaveBeenCalledOnce();
        expect(autoTranslate).not.toHaveBeenCalled();
        recover = true;
        await runtime.reconcile();
        expect(active).toBe(true);
        expect(autoTranslate).toHaveBeenCalledOnce();
    });

    it('单次页面挂载异常不会毒化后续协调，重试成功才启动自动翻译', async () => {
        let active = false;
        const activate = vi.fn<() => Promise<void>>()
            .mockRejectedValueOnce(new Error('transient feature activation'))
            .mockImplementation(async () => { active = true; });
        const autoTranslate = vi.fn();
        const runtime = createContentPageAvailabilityRuntime({
            isEnabled: () => true, isPageFeaturesActive: () => active,
            isVideoPage: () => false, shouldAutomaticallyTranslate: () => true,
            isFullPageTranslationActive: () => false, setMainWorldBridgesEnabled: vi.fn(),
            activatePageFeatures: activate, disposePageFeatures: vi.fn(),
            mountVideoSubtitle: () => vi.fn(), autoTranslate,
        });

        await expect(runtime.reconcile()).rejects.toThrow('transient feature activation');
        expect(autoTranslate).not.toHaveBeenCalled();
        await runtime.reconcile();
        expect(active).toBe(true);
        expect(activate).toHaveBeenCalledTimes(2);
        expect(autoTranslate).toHaveBeenCalledOnce();
    });
    it('同一批次挂载失败向所有调用方报告异常，后续独立批次可以恢复', async () => {
        let active = false;
        const error = new Error('shared activation failure');
        const activate = vi.fn<() => Promise<void>>()
            .mockRejectedValueOnce(error)
            .mockImplementation(async () => { active = true; });
        const autoTranslate = vi.fn();
        const runtime = createContentPageAvailabilityRuntime({
            isEnabled: () => true, isPageFeaturesActive: () => active,
            isVideoPage: () => false, shouldAutomaticallyTranslate: () => true,
            isFullPageTranslationActive: () => false, setMainWorldBridgesEnabled: vi.fn(),
            activatePageFeatures: activate, disposePageFeatures: vi.fn(),
            mountVideoSubtitle: () => vi.fn(), autoTranslate,
        });

        const results = await Promise.allSettled(Array.from({length: 100}, () => runtime.reconcile()));
        expect(results).toEqual(Array.from({length: 100}, () => ({status: 'rejected', reason: error})));
        expect(activate).toHaveBeenCalledOnce();
        expect(autoTranslate).not.toHaveBeenCalled();
        await runtime.reconcile();
        expect(activate).toHaveBeenCalledTimes(2);
        expect(active).toBe(true);
        expect(autoTranslate).toHaveBeenCalledOnce();
    });
    it('首次 activation 之前已经安装配置订阅，初始化异步窗口不会漏掉写入', () => {
        const source = readFileSync(new URL('../src/app/content/runtime.ts', import.meta.url), 'utf8');
        expect(source.indexOf('unsubscribeContentConfig = subscribeConfig'))
            .toBeLessThan(source.lastIndexOf('await pageAvailability.reconcile();'));
    });

    it('把总开关作为 bridge、全文恢复和所有页面 feature 的权威清理边界', async () => {
        let enabled = true;
        let pageFeaturesActive = false;
        const setBridges = vi.fn();
        const activate = vi.fn(async () => { pageFeaturesActive = true; });
        const dispose = vi.fn(() => { pageFeaturesActive = false; });
        const autoTranslate = vi.fn();
        const runtime = createContentPageAvailabilityRuntime({
            isEnabled: () => enabled,
            isPageFeaturesActive: () => pageFeaturesActive,
            isVideoPage: () => false,
            shouldAutomaticallyTranslate: () => true,
            isFullPageTranslationActive: () => false,
            setMainWorldBridgesEnabled: setBridges,
            activatePageFeatures: activate,
            disposePageFeatures: dispose,
            mountVideoSubtitle: () => vi.fn(),
            autoTranslate,
        });

        expect(runtime.needsLifecycleReconcile()).toBe(true);
        await runtime.reconcile();
        expect(setBridges).toHaveBeenLastCalledWith(true);
        expect(activate).toHaveBeenCalledOnce();
        expect(autoTranslate).toHaveBeenCalledOnce();
        expect(runtime.needsLifecycleReconcile()).toBe(false);

        enabled = false;
        expect(runtime.needsLifecycleReconcile()).toBe(true);
        await runtime.reconcile();
        expect(setBridges).toHaveBeenLastCalledWith(false);
        expect(dispose).toHaveBeenCalledOnce();
        expect(pageFeaturesActive).toBe(false);
        runtime.refreshAutoTranslation();

        enabled = true;
        await runtime.reconcile();
        expect(activate).toHaveBeenCalledTimes(2);
        expect(autoTranslate).toHaveBeenCalledTimes(2);
    });

    it('自动翻译在全文已运行或激活途中失效时不重复启动', async () => {
        let enabled = true;
        let fullPageActive = true;
        const autoTranslate = vi.fn();
        const activation = deferred<void>();
        const runtime = createContentPageAvailabilityRuntime({
            isEnabled: () => enabled,
            isPageFeaturesActive: () => false,
            isVideoPage: () => false,
            shouldAutomaticallyTranslate: () => true,
            isFullPageTranslationActive: () => fullPageActive,
            setMainWorldBridgesEnabled: vi.fn(),
            activatePageFeatures: () => activation.promise,
            disposePageFeatures: vi.fn(),
            mountVideoSubtitle: () => vi.fn(),
            autoTranslate,
        });
        const pending = runtime.reconcile();
        enabled = false;
        activation.resolve();
        await pending;
        expect(autoTranslate).not.toHaveBeenCalled();

        enabled = true;
        fullPageActive = true;
        runtime.refreshAutoTranslation();
        expect(autoTranslate).not.toHaveBeenCalled();
    });

    it('进入 watch/shorts 才挂载字幕，离开播放页立即卸载且重复路由幂等', () => {
        let videoPage = false;
        const unmount = vi.fn();
        const mount = vi.fn(() => unmount);
        const runtime = createContentPageAvailabilityRuntime({
            isEnabled: () => true,
            isPageFeaturesActive: () => true,
            isVideoPage: () => videoPage,
            shouldAutomaticallyTranslate: () => false,
            isFullPageTranslationActive: () => false,
            setMainWorldBridgesEnabled: vi.fn(),
            activatePageFeatures: vi.fn(async () => undefined),
            disposePageFeatures: vi.fn(),
            mountVideoSubtitle: mount,
            autoTranslate: vi.fn(),
        });

        runtime.syncVideoSubtitlePage();
        expect(mount).not.toHaveBeenCalled();
        videoPage = true;
        runtime.syncVideoSubtitlePage();
        runtime.syncVideoSubtitlePage();
        expect(mount).toHaveBeenCalledOnce();
        videoPage = false;
        runtime.syncVideoSubtitlePage();
        expect(unmount).toHaveBeenCalledOnce();
    });

    it('总开关在 deferred activation 中关闭会立即回收 bridge、视频和页面功能', async () => {
        let enabled = true;
        let active = false;
        const activation = deferred<void>();
        const setBridges = vi.fn();
        const disposeVideo = vi.fn();
        const disposeFeatures = vi.fn(() => { active = false; });
        const runtime = createContentPageAvailabilityRuntime({
            isEnabled: () => enabled,
            isPageFeaturesActive: () => active,
            isVideoPage: () => true,
            shouldAutomaticallyTranslate: () => true,
            isFullPageTranslationActive: () => false,
            setMainWorldBridgesEnabled: setBridges,
            activatePageFeatures: vi.fn(async () => {
                active = true;
                await activation.promise;
            }),
            disposePageFeatures: disposeFeatures,
            mountVideoSubtitle: () => disposeVideo,
            autoTranslate: vi.fn(),
        });

        const activating = runtime.reconcile();
        await vi.waitFor(() => expect(active).toBe(true));
        enabled = false;
        const disabling = runtime.reconcile();
        expect(active).toBe(false);
        expect(setBridges).toHaveBeenLastCalledWith(false);
        expect(disposeFeatures).toHaveBeenCalled();
        expect(disposeVideo).not.toHaveBeenCalled();

        activation.resolve();
        await Promise.all([activating, disabling]);
        expect(active).toBe(false);
        expect(setBridges).toHaveBeenLastCalledWith(false);
    });

    it('disabledDomains 在 deferred activation 中命中时同样保证最终停用', async () => {
        let siteDisabled = false;
        let active = false;
        const activation = deferred<void>();
        const setBridges = vi.fn();
        const disposeFeatures = vi.fn(() => { active = false; });
        const runtime = createContentPageAvailabilityRuntime({
            isEnabled: () => !siteDisabled,
            isPageFeaturesActive: () => active,
            isVideoPage: () => false,
            shouldAutomaticallyTranslate: () => false,
            isFullPageTranslationActive: () => false,
            setMainWorldBridgesEnabled: setBridges,
            activatePageFeatures: vi.fn(async () => {
                active = true;
                await activation.promise;
            }),
            disposePageFeatures: disposeFeatures,
            mountVideoSubtitle: () => vi.fn(),
            autoTranslate: vi.fn(),
        });

        const activating = runtime.reconcile();
        await vi.waitFor(() => expect(active).toBe(true));
        siteDisabled = true;
        const disabling = runtime.reconcile();
        expect(active).toBe(false);
        activation.resolve();
        await Promise.all([activating, disabling]);
        expect(setBridges).toHaveBeenLastCalledWith(false);
        expect(disposeFeatures).toHaveBeenCalled();
    });

    it('false → true 快速反转会丢弃失效 activation 并重新激活到最新状态', async () => {
        let enabled = true;
        let active = false;
        let activationStarts = 0;
        const firstActivation = deferred<void>();
        const setBridges = vi.fn();
        const disposeFeatures = vi.fn(() => { active = false; });
        const autoTranslate = vi.fn();
        const activate = vi.fn(async () => {
            if (active) return;
            active = true;
            activationStarts += 1;
            if (activationStarts === 1) await firstActivation.promise;
        });
        const runtime = createContentPageAvailabilityRuntime({
            isEnabled: () => enabled,
            isPageFeaturesActive: () => active,
            isVideoPage: () => false,
            shouldAutomaticallyTranslate: () => true,
            isFullPageTranslationActive: () => false,
            setMainWorldBridgesEnabled: setBridges,
            activatePageFeatures: activate,
            disposePageFeatures: disposeFeatures,
            mountVideoSubtitle: () => vi.fn(),
            autoTranslate,
        });

        const initial = runtime.reconcile();
        await vi.waitFor(() => expect(activationStarts).toBe(1));
        enabled = false;
        const disabled = runtime.reconcile();
        enabled = true;
        const restored = runtime.reconcile();
        firstActivation.resolve();

        await Promise.all([initial, disabled, restored]);
        expect(activationStarts).toBe(2);
        expect(active).toBe(true);
        expect(setBridges).toHaveBeenLastCalledWith(true);
        expect(autoTranslate).toHaveBeenCalledTimes(2);
    });
});


describe('content 路由协调边界', () => {
    it('激活状态未同步时先重建生命周期，下一条路由才继续同步功能和自动翻译', () => {
        let href = 'https://example.com/first';
        let needsReconcile = true;
        let siteDisabled = false;
        const dependencies = {
            getHref: () => href, routeChanged: vi.fn(), resetTranslationRoute: vi.fn(),
            siteDisabled: () => siteDisabled, currentSiteDisabled: () => false,
            applySiteDisabledState: vi.fn(async () => undefined), reconcileFeatures: vi.fn(),
            pageAvailability: {
                needsLifecycleReconcile: () => needsReconcile,
                reconcile: vi.fn(async () => undefined), refreshAutoTranslation: vi.fn(),
                syncVideoSubtitlePage: vi.fn(), disposeVideoSubtitlePage: vi.fn(),
            },
        };
        const changed = createContentRouteChangeHandler(dependencies);
        changed();
        expect(dependencies.routeChanged).not.toHaveBeenCalled();
        href = 'https://example.com/second'; changed();
        expect(dependencies.pageAvailability.reconcile).toHaveBeenCalledOnce();
        expect(dependencies.pageAvailability.refreshAutoTranslation).not.toHaveBeenCalled();
        needsReconcile = false;
        href = 'https://example.com/second#section'; changed();
        expect(dependencies.resetTranslationRoute).toHaveBeenCalledOnce();
        expect(dependencies.reconcileFeatures).toHaveBeenCalledOnce();
        expect(dependencies.pageAvailability.refreshAutoTranslation).toHaveBeenCalledOnce();
        siteDisabled = true;
        href = 'https://example.com/private'; changed();
        expect(dependencies.applySiteDisabledState).toHaveBeenCalledOnce();
        expect(dependencies.applySiteDisabledState).toHaveBeenCalledWith(true);
        expect(dependencies.reconcileFeatures).toHaveBeenCalledOnce();
        expect(dependencies.pageAvailability.refreshAutoTranslation).toHaveBeenCalledOnce();
    });
});


describe('当前配置的页面重协调', () => {
    it('已停用、页面失效或无注册表时不启动功能', async () => {
        const reconcile = vi.fn(async () => {}), apply = vi.fn(async () => [{status: 'mounted'}]);
        const registry = {reconcileEnabled: apply};
        expect(await reconcileCurrentContentPage(reconcile, () => registry, () => false, () => true)).toBe(false);
        expect(await reconcileCurrentContentPage(reconcile, () => registry, () => true, () => false)).toBe(true);
        expect(await reconcileCurrentContentPage(reconcile, () => null, () => true, () => true)).toBe(false);
        expect(apply).not.toHaveBeenCalled();
    });
    it.each(['success', 'failed', 'invalidated', 'disabled', 'owner-changed'] as const)('等待功能挂载期间 %s 后只确认当前所有权', async outcome => {
        const gate = deferred<readonly {status: string}[]>(); let available = true, enabled = true;
        const owner = {reconcileEnabled: vi.fn(() => gate.promise)};
        let current: typeof owner | null = owner;
        const result = reconcileCurrentContentPage(async () => {}, () => current, () => available, () => enabled);
        await Promise.resolve();
        if (outcome === 'invalidated') available = false;
        if (outcome === 'disabled') enabled = false;
        if (outcome === 'owner-changed') current = {reconcileEnabled: vi.fn(() => gate.promise)};
        gate.resolve([{status: outcome === 'failed' ? 'failed' : 'mounted'}]);
        expect(await result).toBe(outcome === 'success');
    });
    it('协调抛错原样交由消息处理器判断，不报告成功', async () => {
        await expect(reconcileCurrentContentPage(async () => {throw new Error('unavailable');}, () => null, () => true, () => true)).rejects.toThrow('unavailable');
    });
});
