import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {compileScript, parse} from 'vue/compiler-sfc';
import ts from 'typescript';
import * as vue from 'vue';
import * as progressApi from '@/src/features/full-page-translation/progress';
import {createProgressPanelVisibility} from '@/src/features/full-page-translation/ui/progressPanelVisibility';

import {
  finishFullPageTranslationProgress,
  getFullPageTranslationProgress,
  hasActiveFullPageTranslationWork,
  shouldShowCompactFullPageTranslationStatus,
  startFullPageTranslationProgress,
  subscribeFullPageTranslationProgress,
  updateFullPageTranslationProgress,
} from '@/src/features/full-page-translation/progress';

afterEach(() => {
  const current = getFullPageTranslationProgress();
  if (current.active) finishFullPageTranslationProgress(current.sessionId);
  vi.useRealTimers();
});

describe('全文翻译进度面板显隐稳定性', () => {
  function setup(floatingBallEnabled = true) {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const visibility = createProgressPanelVisibility(onChange);
    const progress = {
      sessionId: 1, active: true, modalPhase: 'none' as 'none' | 'translating' | 'waiting',
      deferred: 0, running: 1, remaining: 13, queued: 1, offscreen: 12,
    };
    const update = (patch: Partial<typeof progress> = {}, dismissed = false) => {
      Object.assign(progress, patch);
      visibility.update({...progress}, floatingBallEnabled, dismissed);
    };
    update();
    return {onChange, visibility, update};
  }

  it('缓存等短任务结束后不会迟到弹出面板', () => {
    const {onChange, visibility, update} = setup();
    vi.advanceTimersByTime(100);
    update({running: 0, queued: 0});
    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    visibility.dispose();
  });

  it('计数持续变化也能按时显示，队列间隙不会导致反复显隐', () => {
    const {onChange, visibility, update} = setup();
    vi.advanceTimersByTime(100);
    update({running: 2, queued: 0});
    vi.advanceTimersByTime(80);
    expect(onChange.mock.calls).toEqual([['expanded']]);
    for (let index = 0; index < 10; index += 1) {
      update({running: 0, queued: 0});
      vi.advanceTimersByTime(100);
      update({running: 1});
      vi.advanceTimersByTime(100);
    }
    expect(onChange.mock.calls).toEqual([['expanded']]);
    update({running: 0});
    vi.advanceTimersByTime(300);
    update({offscreen: 11, remaining: 11});
    vi.advanceTimersByTime(299);
    expect(onChange.mock.calls).toEqual([['expanded']]);
    vi.advanceTimersByTime(1);
    expect(onChange.mock.calls).toEqual([['expanded'], ['hidden']]);
    visibility.dispose();
  });

  it('关闭悬浮球时只在连续空闲后退化为紧凑勾选，再次工作也不抖动', () => {
    const {onChange, visibility, update} = setup(false);
    vi.advanceTimersByTime(180);
    update({running: 0, queued: 0});
    vi.advanceTimersByTime(600);
    expect(onChange.mock.calls).toEqual([['expanded'], ['compact']]);
    update({running: 1});
    vi.advanceTimersByTime(100);
    update({running: 0});
    vi.advanceTimersByTime(1000);
    expect(onChange.mock.calls).toEqual([['expanded'], ['compact']]);
    update({running: 1});
    vi.advanceTimersByTime(180);
    expect(onChange).toHaveBeenLastCalledWith('expanded');
    visibility.dispose();
  });

  it.each([100, 200])('手动关闭在 %sms 时取消等待或立即隐藏，并保持本会话关闭', elapsed => {
    const {onChange, visibility, update} = setup();
    vi.advanceTimersByTime(elapsed);
    update({}, true);
    vi.advanceTimersByTime(1000);
    update({running: 3}, true);
    expect(onChange.mock.calls).toEqual(elapsed < 180 ? [] : [['expanded'], ['hidden']]);
    expect(vi.getTimerCount()).toBe(0);
    update({sessionId: 2}, false);
    vi.advanceTimersByTime(180);
    expect(onChange).toHaveBeenLastCalledWith('expanded');
    visibility.dispose();
  });

  it('恢复原文立即隐藏，不等待空闲计时器', () => {
    const {onChange, visibility, update} = setup();
    vi.advanceTimersByTime(180);
    update({running: 0, queued: 0});
    vi.advanceTimersByTime(100);
    update({active: false});
    expect(onChange.mock.calls).toEqual([['expanded'], ['hidden']]);
    expect(vi.getTimerCount()).toBe(0);
    visibility.dispose();
  });

  it('新会话不会继承旧会话的展开计时器', () => {
    const {onChange, visibility, update} = setup();
    vi.advanceTimersByTime(100);
    update({sessionId: 2});
    vi.advanceTimersByTime(80);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(onChange).toHaveBeenLastCalledWith('expanded');
    update({sessionId: 3, running: 0, queued: 0});
    expect(onChange).toHaveBeenLastCalledWith('hidden');
    visibility.dispose();
  });

  it('原生弹窗等待提示立即出现，不被短任务过滤', () => {
    const {onChange, visibility, update} = setup();
    update({modalPhase: 'waiting', running: 0, queued: 0});
    expect(onChange.mock.calls).toEqual([['expanded']]);
    expect(vi.getTimerCount()).toBe(0);
    update({modalPhase: 'translating', running: 1});
    update({modalPhase: 'waiting', running: 0});
    expect(onChange.mock.calls).toEqual([['expanded']]);
    visibility.dispose();
  });

  it('设置变化取消或替换收起目标，卸载后不再发布', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const visibility = createProgressPanelVisibility(onChange);
    const progress = {sessionId: 1, active: true, modalPhase: 'none' as const,
      deferred: 0, running: 0, queued: 0, offscreen: 12, remaining: 12};
    visibility.update(progress, false, false);
    visibility.update(progress, true, false);
    visibility.update({...progress, running: 1}, true, false);
    vi.advanceTimersByTime(180);
    visibility.update(progress, true, false);
    vi.advanceTimersByTime(100);
    visibility.update(progress, false, false);
    vi.advanceTimersByTime(600);
    expect(onChange.mock.calls).toEqual([['compact'], ['hidden'], ['expanded'], ['compact']]);
    visibility.update({...progress, running: 1}, false, false);
    visibility.dispose();
    visibility.dispose();
    visibility.update({...progress, sessionId: 2}, false, false);
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('已排入事件队列的过期回调不能在关闭或卸载后重新显示', () => {
    const {onChange, visibility, update} = setup();
    const clearTimeout = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
    update({}, true);
    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalled();
    update({sessionId: 2}, false);
    visibility.dispose();
    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalled();
    clearTimeout.mockRestore();
  });
});

describe('全文翻译进度', () => {
  it('仅把请求中或已排队任务视为需要展开面板的活动工作', () => {
    const offscreenOnly = {
      sessionId: 1,
      active: true,
      running: 0,
      remaining: 6,
      queued: 0,
      offscreen: 6,
    };
    expect(hasActiveFullPageTranslationWork(offscreenOnly)).toBe(false);
    expect(hasActiveFullPageTranslationWork({active: true, running: 1, queued: 0})).toBe(true);
    expect(hasActiveFullPageTranslationWork({active: true, running: 0, queued: 2})).toBe(true);
    expect(hasActiveFullPageTranslationWork({active: true, running: 0, queued: 0, modalPhase: 'waiting', deferred: 3})).toBe(true);
    expect(hasActiveFullPageTranslationWork({active: false, running: 3, queued: 4})).toBe(false);
    expect(hasActiveFullPageTranslationWork({active: true, running: Number.NaN, queued: -1})).toBe(false);

    expect(shouldShowCompactFullPageTranslationStatus(offscreenOnly, false)).toBe(true);
    expect(shouldShowCompactFullPageTranslationStatus(offscreenOnly, true)).toBe(false);
    expect(shouldShowCompactFullPageTranslationStatus({active: true, running: 1, queued: 0}, false)).toBe(false);
    expect(shouldShowCompactFullPageTranslationStatus({active: false, running: 0, queued: 0}, false)).toBe(false);
  });

  it('立即提供快照，并发布进行中、队列与离屏任务数量', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeFullPageTranslationProgress(listener);
    const sessionId = startFullPageTranslationProgress();

    updateFullPageTranslationProgress(sessionId, {
      running: 3,
      queued: 4,
      offscreen: 7,
    });

    expect(listener).toHaveBeenLastCalledWith({
      sessionId,
      active: true,
      modalPhase: 'none',
      deferred: 0,
      running: 3,
      remaining: 11,
      queued: 4,
      offscreen: 7,
      completed: 0,
      failed: 0,
      retryable: 0,
    });
    expect(getFullPageTranslationProgress()).toEqual(listener.mock.lastCall?.[0]);
    unsubscribe();
  });

  it('忽略旧会话的迟到更新和结束通知', () => {
    const staleSessionId = startFullPageTranslationProgress();
    const currentSessionId = startFullPageTranslationProgress();

    updateFullPageTranslationProgress(staleSessionId, {running: 99, queued: 99, offscreen: 99});
    finishFullPageTranslationProgress(staleSessionId);

    expect(getFullPageTranslationProgress()).toEqual({
      sessionId: currentSessionId,
      active: true,
      modalPhase: 'none',
      deferred: 0,
      running: 0,
      remaining: 0,
      queued: 0,
      offscreen: 0,
      completed: 0,
      failed: 0,
      retryable: 0,
    });
  });

  it('结束当前会话时清零计数并通知订阅者', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeFullPageTranslationProgress(listener);
    const sessionId = startFullPageTranslationProgress();
    updateFullPageTranslationProgress(sessionId, {running: 2, queued: 1, offscreen: 5});

    finishFullPageTranslationProgress(sessionId);

    expect(listener).toHaveBeenLastCalledWith({
      sessionId,
      active: false,
      modalPhase: 'none',
      deferred: 0,
      running: 0,
      remaining: 0,
      queued: 0,
      offscreen: 0,
      completed: 0,
      failed: 0,
      retryable: 0,
    });
    unsubscribe();
  });

  it('规范化异常计数，并对相同快照去重', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeFullPageTranslationProgress(listener);
    const sessionId = startFullPageTranslationProgress();
    listener.mockClear();

    updateFullPageTranslationProgress(sessionId, {running: 2.9, queued: -1, offscreen: Number.NaN});
    updateFullPageTranslationProgress(sessionId, {running: 2, queued: 0, offscreen: 0});

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({
      running: 2,
      remaining: 0,
      queued: 0,
      offscreen: 0,
    }));
    unsubscribe();
  });

  it('把弹窗阶段和被阻塞候选纳入剩余数量，并允许阶段切换', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeFullPageTranslationProgress(listener);
    const sessionId = startFullPageTranslationProgress();
    listener.mockClear();

    updateFullPageTranslationProgress(sessionId, {
      modalPhase: 'translating',
      deferred: 4,
      running: 1,
      queued: 2,
      offscreen: 3,
    });
    expect(getFullPageTranslationProgress()).toMatchObject({
      modalPhase: 'translating',
      deferred: 4,
      running: 1,
      queued: 2,
      offscreen: 3,
      remaining: 9,
    });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({modalPhase: 'translating', deferred: 4, remaining: 9}));

    updateFullPageTranslationProgress(sessionId, {
      modalPhase: 'waiting',
      deferred: 5,
      running: 0,
      queued: 0,
      offscreen: 3,
    });
    expect(getFullPageTranslationProgress()).toMatchObject({modalPhase: 'waiting', deferred: 5, remaining: 8});
    expect(hasActiveFullPageTranslationWork(getFullPageTranslationProgress())).toBe(true);
    unsubscribe();
  });

  it('新会话重置弹窗阶段与 deferred 状态，并拒绝旧会话字段', () => {
    const oldSessionId = startFullPageTranslationProgress();
    updateFullPageTranslationProgress(oldSessionId, {
      modalPhase: 'waiting', deferred: 7, running: 0, queued: 0, offscreen: 1,
    });
    const newSessionId = startFullPageTranslationProgress();
    updateFullPageTranslationProgress(oldSessionId, {
      modalPhase: 'translating', deferred: 99, running: 9, queued: 9, offscreen: 9,
    });
    expect(getFullPageTranslationProgress()).toEqual({
      sessionId: newSessionId,
      active: true,
      modalPhase: 'none',
      deferred: 0,
      running: 0,
      remaining: 0,
      queued: 0,
      offscreen: 0,
      completed: 0,
      failed: 0,
      retryable: 0,
    });
  });

  it('隔离订阅者快照与异常，取消订阅后不再通知', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = vi.fn((snapshot: ReturnType<typeof getFullPageTranslationProgress>) => {
      snapshot.running = 999;
      throw new Error('listener failed');
    });
    const healthy = vi.fn();
    const unsubscribeBroken = subscribeFullPageTranslationProgress(broken);
    const unsubscribeHealthy = subscribeFullPageTranslationProgress(healthy);
    healthy.mockClear();

    const sessionId = startFullPageTranslationProgress();

    expect(healthy).toHaveBeenLastCalledWith(expect.objectContaining({sessionId, running: 0}));
    expect(consoleError).toHaveBeenCalledWith(
      '[FluentRead] 全文翻译进度订阅者执行失败',
      expect.any(Error),
    );

    unsubscribeBroken();
    unsubscribeHealthy();
    broken.mockClear();
    healthy.mockClear();
    updateFullPageTranslationProgress(sessionId, {running: 1, queued: 0, offscreen: 0});
    expect(broken).not.toHaveBeenCalled();
    expect(healthy).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('在未激活时忽略更新和结束', () => {
    const current = getFullPageTranslationProgress();
    if (current.active) finishFullPageTranslationProgress(current.sessionId);
    const before = getFullPageTranslationProgress();

    updateFullPageTranslationProgress(before.sessionId, {running: 1, queued: 2, offscreen: 3});
    finishFullPageTranslationProgress(before.sessionId);

    expect(getFullPageTranslationProgress()).toEqual(before);
  });
});

describe('进度通知重入与订阅所有权', () => {
  const subscriptions: (() => void)[] = [];
  const subscribe = (listener: Parameters<typeof subscribeFullPageTranslationProgress>[0]) => {
    const unsubscribe = subscribeFullPageTranslationProgress(listener);
    subscriptions.push(unsubscribe);
    return unsubscribe;
  };
  afterEach(() => subscriptions.splice(0).forEach(unsubscribe => unsubscribe()));

  it('订阅者重启会话不会递归回调自己，其他观察者取得最新会话', () => {
    let starts = 0, depth = 0, maximumDepth = 0;
    subscribe(snapshot => {
      if (!snapshot.active) return;
      depth += 1;
      maximumDepth = Math.max(maximumDepth, depth);
      if (starts++ < 25) startFullPageTranslationProgress();
      depth -= 1;
    });
    const observer = vi.fn();
    subscribe(observer);
    const first = startFullPageTranslationProgress();
    expect(starts).toBe(1);
    expect(maximumDepth).toBe(1);
    expect(getFullPageTranslationProgress().sessionId).toBe(first + 1);
    expect(observer).toHaveBeenLastCalledWith(getFullPageTranslationProgress());
    startFullPageTranslationProgress();
    expect(starts).toBe(2);
    expect(observer).toHaveBeenLastCalledWith(getFullPageTranslationProgress());
  });

  it('两个订阅者互相发布时迭代交付一次写入，并让只读观察者追上最终状态', () => {
    const observer = vi.fn();
    subscribe(observer);
    let writes = 0, depth = 0, maximumDepth = 0;
    const writer = () => (snapshot: ReturnType<typeof getFullPageTranslationProgress>) => {
      if (!snapshot.active || writes >= 20) return;
      depth += 1;
      maximumDepth = Math.max(maximumDepth, depth);
      writes += 1;
      updateFullPageTranslationProgress(snapshot.sessionId, {running: writes, queued: 0, offscreen: 0});
      depth -= 1;
    };
    subscribe(writer());
    subscribe(writer());
    startFullPageTranslationProgress();
    expect(writes).toBe(2);
    expect(maximumDepth).toBe(1);
    expect(observer).toHaveBeenLastCalledWith(getFullPageTranslationProgress());
    expect(getFullPageTranslationProgress().running).toBe(2);
  });

  it('通知中新增订阅只初始化一次，不重复投递同一快照', () => {
    const added = vi.fn();
    subscribe(snapshot => {if (snapshot.active) subscribe(added);});
    startFullPageTranslationProgress();
    expect(added).toHaveBeenCalledTimes(1);
    expect(added).toHaveBeenLastCalledWith(getFullPageTranslationProgress());
  });

  it('通知中取消尚未交付的订阅，不会调用已卸载的 UI', () => {
    let remove = () => {};
    subscribe(snapshot => {if (snapshot.active) remove();});
    const removed = vi.fn();
    remove = subscribe(removed);
    removed.mockClear();
    startFullPageTranslationProgress();
    expect(removed).not.toHaveBeenCalled();
  });

  it('只读订阅者在回调内重新订阅自己也不会重复初始化', () => {
    let calls = 0;
    const reader = () => {if (++calls < 20) subscribe(reader);};
    subscribe(reader);
    expect(calls).toBe(1);
    startFullPageTranslationProgress();
    expect(calls).toBe(2);
  });

  it('相互重新订阅的观察者不会循环，已写入者也不会因重新订阅收到回声', () => {
    let calls = 0;
    const first = (snapshot: ReturnType<typeof getFullPageTranslationProgress>) => {
      if (!snapshot.active || ++calls > 20) return;
      subscribe(second);
      updateFullPageTranslationProgress(snapshot.sessionId, {running: calls, queued: 0, offscreen: 0});
    };
    const second = (snapshot: ReturnType<typeof getFullPageTranslationProgress>) => {
      if (!snapshot.active) return;
      subscribe(first);
      subscribe(second);
    };
    subscribe(first);
    subscribe(second);
    startFullPageTranslationProgress();
    expect(calls).toBe(1);
    expect(getFullPageTranslationProgress().running).toBe(1);
  });

  it('首次订阅中的更新也按队列交付，批量写入只读观察者只收到最后值', () => {
    const sessionId = startFullPageTranslationProgress();
    const observer = vi.fn();
    subscribe(observer);
    observer.mockClear();
    let calls = 0;
    subscribe(snapshot => {
      if (++calls > 20) return;
      updateFullPageTranslationProgress(snapshot.sessionId, {running: 1, queued: 2, offscreen: 3});
      updateFullPageTranslationProgress(snapshot.sessionId, {running: 4, queued: 5, offscreen: 6});
    });
    expect(calls).toBe(1);
    expect(observer.mock.calls).toEqual([[{sessionId, active: true, modalPhase: 'none', deferred: 0, running: 4, queued: 5, offscreen: 6, remaining: 11, completed: 0, failed: 0, retryable: 0}]]);
  });

  it('写入后重新订阅自己和抛出异常不会反馈循环，后续外部发布仍可使用', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let calls = 0;
    const writer = (snapshot: ReturnType<typeof getFullPageTranslationProgress>) => {
      if (!snapshot.active || ++calls > 20) return;
      finishFullPageTranslationProgress(snapshot.sessionId);
      subscribe(writer);
      throw new Error('failed after finish');
    };
    try {
      subscribe(writer);
      const observer = vi.fn();
      subscribe(observer);
      startFullPageTranslationProgress();
      expect(calls).toBe(1);
      expect(observer).toHaveBeenLastCalledWith(getFullPageTranslationProgress());
      expect(getFullPageTranslationProgress().active).toBe(false);
      startFullPageTranslationProgress();
      expect(calls).toBe(2);
      expect(consoleError).toHaveBeenCalledTimes(2);
    } finally {consoleError.mockRestore();}
  });
});

describe('进度面板组件实时订阅与显隐', () => {
  const filename = 'src/features/full-page-translation/ui/TranslationProgressPanel.vue';
  const {descriptor} = parse(readFileSync(filename, 'utf8'), {filename});
  const compiled = ts.transpileModule(compileScript(descriptor, {id: 'progress-panel-test'}).content, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  let scope: vue.EffectScope;
  let state: Record<string, any>;
  let unmount: (() => void)[];
  let publishConfig: (value: typeof config) => void;
  let config: {animations: boolean; theme: string; disableFloatingBall: boolean};

  beforeEach(() => {
    vi.useFakeTimers();
    config = {animations: true, theme: 'auto', disableFloatingBall: false};
    const mounted: (() => void)[] = [];
    unmount = [];
    vi.stubGlobal('window', {matchMedia: () => ({matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn()})});
    const exports: Record<string, any> = {};
    new Function('require', 'exports', compiled)((id: string) => {
      if (id === 'vue') return {...vue, onMounted: (fn: () => void) => mounted.push(fn), onBeforeUnmount: (fn: () => void) => unmount.push(fn)};
      if (id.endsWith('/progress')) return progressApi;
      if (id === './progressPanelVisibility') return {createProgressPanelVisibility};
      if (id.endsWith('/store')) return {config, subscribeConfig: (fn: typeof publishConfig) => {publishConfig = fn; return vi.fn();}};
      if (id.endsWith('/i18n')) return {useUiI18n: () => ({t: (key: string) => key})};
      throw new Error(`Unexpected import: ${id}`);
    }, exports);
    scope = vue.effectScope();
    state = scope.run(() => vue.proxyRefs(exports.default.setup({}, {expose: () => {}})))!;
    mounted.forEach(fn => fn());
  });

  afterEach(() => {
    unmount.forEach(fn => fn());
    scope.stop();
    vi.unstubAllGlobals();
  });

  it('组件不展示不足 180ms 的短任务', () => {
    const sessionId = startFullPageTranslationProgress();
    updateFullPageTranslationProgress(sessionId, {running: 1, queued: 0, offscreen: 12});
    vi.advanceTimersByTime(100);
    expect(state.isVisible).toBe(false);
    updateFullPageTranslationProgress(sessionId, {running: 0, queued: 0, offscreen: 12});
    vi.advanceTimersByTime(1000);
    expect(state.isVisible).toBe(false);
  });

  it('快速工作与离屏等待交替时保持展开，计数仍实时刷新', () => {
    const sessionId = startFullPageTranslationProgress();
    updateFullPageTranslationProgress(sessionId, {running: 1, queued: 0, offscreen: 12});
    vi.advanceTimersByTime(180);
    expect(state.isVisible).toBe(true);
    for (let index = 0; index < 10; index += 1) {
      updateFullPageTranslationProgress(sessionId, {running: 0, queued: 0, offscreen: 12 - index});
      expect(state.progress.running).toBe(0);
      expect(state.progress.remaining).toBe(12 - index);
      expect(state.isVisible).toBe(true);
      vi.advanceTimersByTime(100);
      updateFullPageTranslationProgress(sessionId, {running: 1, queued: 0, offscreen: 12 - index});
      expect(state.progress.running).toBe(1);
      expect(state.isVisible).toBe(true);
      vi.advanceTimersByTime(100);
    }
    updateFullPageTranslationProgress(sessionId, {running: 0, queued: 0, offscreen: 2});
    vi.advanceTimersByTime(600);
    expect(state.isVisible).toBe(false);
  });

  it('收起、恢复原文和再次翻译立即更新展示所有权', () => {
    const sessionId = startFullPageTranslationProgress();
    updateFullPageTranslationProgress(sessionId, {running: 1, queued: 0, offscreen: 12});
    vi.advanceTimersByTime(180);
    state.dismiss();
    expect(state.isVisible).toBe(false);
    updateFullPageTranslationProgress(sessionId, {running: 2, queued: 0, offscreen: 12});
    vi.advanceTimersByTime(1000);
    expect(state.isVisible).toBe(false);
    const nextSessionId = startFullPageTranslationProgress();
    updateFullPageTranslationProgress(nextSessionId, {running: 1, queued: 0, offscreen: 12});
    vi.advanceTimersByTime(180);
    expect(state.isVisible).toBe(true);
    finishFullPageTranslationProgress(nextSessionId);
    expect(state.isVisible).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('配置订阅保持紧凑状态契约，卸载取消显隐计时器', () => {
    const sessionId = startFullPageTranslationProgress();
    updateFullPageTranslationProgress(sessionId, {running: 1, queued: 0, offscreen: 12});
    vi.advanceTimersByTime(180);
    publishConfig({...config, disableFloatingBall: true});
    updateFullPageTranslationProgress(sessionId, {running: 0, queued: 0, offscreen: 12});
    expect(state.isCompact).toBe(false);
    vi.advanceTimersByTime(600);
    expect(state.isCompact).toBe(true);
    expect(state.isVisible).toBe(true);
    updateFullPageTranslationProgress(sessionId, {running: 1, queued: 0, offscreen: 12});
    unmount.forEach(fn => fn());
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(state.isCompact).toBe(true);
  });

  it('其他订阅者在发布中结束任务时取消旧面板计时器，新会话仍可展开', () => {
    let shouldFinish = true;
    const unsubscribe = subscribeFullPageTranslationProgress(snapshot => {
      if (shouldFinish && snapshot.running > 0) finishFullPageTranslationProgress(snapshot.sessionId);
    });
    try {
      const sessionId = startFullPageTranslationProgress();
      updateFullPageTranslationProgress(sessionId, {running: 1, queued: 1, offscreen: 0});
      expect(state.progress.active).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(1000);
      expect(state.isVisible).toBe(false);
      shouldFinish = false;
      const next = startFullPageTranslationProgress();
      updateFullPageTranslationProgress(next, {running: 1, queued: 0, offscreen: 0});
      vi.advanceTimersByTime(180);
      expect(state.progress.sessionId).toBe(next);
      expect(state.isVisible).toBe(true);
    } finally {unsubscribe();}
  });
  it('失败摘要在空队列中保留，恢复动作按当前会话交付，弹窗等待时不发出动作', () => {
    const sessionId = startFullPageTranslationProgress();
    const action = vi.fn(() => 1);
    progressApi.setFullPageFailureActions(sessionId, action);
    updateFullPageTranslationProgress(sessionId, {running: 0, queued: 0, offscreen: 0, completed: 12, failed: 2});
    vi.advanceTimersByTime(180);
    expect(state.isVisible).toBe(true);
    expect(state.hasFailures).toBe(true);
    expect(state.panelTitle).toBe('fullPage.progress.failuresTitle');
    vi.advanceTimersByTime(2000);
    expect(state.isVisible).toBe(true);
    state.runFailureAction('retry'); state.runFailureAction('locate');
    expect(action.mock.calls).toEqual([['retry'], ['locate']]);
    updateFullPageTranslationProgress(sessionId, {running: 0, queued: 0, offscreen: 0, modalPhase: 'waiting', retryable: 0});
    state.runFailureAction('retry');
    expect(action).toHaveBeenCalledTimes(2);
    finishFullPageTranslationProgress(sessionId);
    state.runFailureAction('retry');
    expect(action).toHaveBeenCalledTimes(2);
    expect(state.isVisible).toBe(false);
  });

});
