import {afterEach, describe, expect, it, vi} from 'vitest';
import {createFullPageOutcomeRegistry} from '@/src/features/full-page-translation/core/outcomes';
import {finishFullPageTranslationProgress, getFullPageTranslationProgress, hasActiveFullPageTranslationWork,
  runFullPageFailureAction, setFullPageFailureActions, startFullPageTranslationProgress,
  updateFullPageTranslationProgress} from '@/src/features/full-page-translation/progress';

afterEach(() => { const state = getFullPageTranslationProgress(); finishFullPageTranslationProgress(state.sessionId); });

describe('全文失败恢复的目标与会话隔离', () => {
  it('阶段计数只包含当前目标，重复发布、移除、清空不会累积旧结果', () => {
    const registry = createFullPageOutcomeRegistry<string>();
    registry.update('unknown');
    expect(registry.has('unknown')).toBe(false);
    expect(registry.countFailures(() => true)).toBe(0);
    registry.setRetry('unknown', () => true);
    registry.update('a', 'loading');
    registry.update('a', 'loading');
    registry.update('b', 'error');
    registry.update('c', 'translated');
    expect(registry.snapshot()).toEqual({loading: 1, completed: 1, failed: 1});
    const snapshot = registry.snapshot(); snapshot.failed = 999;
    registry.update('a', 'translated');
    registry.update('b');
    expect(registry.snapshot()).toEqual({loading: 0, completed: 2, failed: 0});
    registry.clear();
    expect(registry.snapshot()).toEqual({loading: 0, completed: 0, failed: 0});
    expect(registry.firstFailure(() => true)).toBeUndefined();
    expect(registry.retry(() => true)).toBe(0);
  });

  it('只重试可恢复的失败，已成功目标不参与，恢复期间被替换的回调不执行', () => {
    const registry = createFullPageOutcomeRegistry<string>();
    for (const name of ['a', 'b', 'c', 'd']) registry.update(name, 'error');
    registry.update('ok', 'translated');
    const successful = vi.fn(() => true); registry.setRetry('ok', successful);
    const stale = vi.fn(() => true);
    registry.setRetry('a', () => {registry.update('a', 'loading'); registry.setRetry('b', () => true); return true;});
    registry.setRetry('b', stale);
    const rejected = vi.fn(() => false); registry.setRetry('c', rejected);
    const disconnected = vi.fn(() => true); registry.setRetry('d', disconnected);
    expect(registry.has('a')).toBe(true);
    expect(registry.countFailures(target => target !== 'a')).toBe(3);
    expect(registry.firstFailure(target => target !== 'a')).toBe('b');
    expect(registry.firstFailure(() => false)).toBeUndefined();
    expect(registry.retry(target => target !== 'd')).toBe(1);
    expect(stale).not.toHaveBeenCalled();
    expect(rejected).toHaveBeenCalledOnce();
    expect(disconnected).not.toHaveBeenCalled();
    expect(successful).not.toHaveBeenCalled();
    expect(registry.snapshot()).toEqual({loading: 1, completed: 1, failed: 3});
  });

  it('面板命令只交付当前会话，恢复后和新会话都拒绝旧操作', () => {
    const oldSession = startFullPageTranslationProgress();
    expect(runFullPageFailureAction(oldSession, 'retry')).toBe(0);
    const handle = vi.fn(() => 2);
    setFullPageFailureActions(oldSession - 1, handle);
    expect(runFullPageFailureAction(oldSession, 'retry')).toBe(0);
    setFullPageFailureActions(oldSession, handle);
    expect(runFullPageFailureAction(oldSession, 'retry')).toBe(2);
    expect(runFullPageFailureAction(oldSession, 'locate')).toBe(2);
    expect(handle.mock.calls).toEqual([['retry'], ['locate']]);
    finishFullPageTranslationProgress(oldSession);
    setFullPageFailureActions(oldSession, handle);
    expect(runFullPageFailureAction(oldSession, 'retry')).toBe(0);
    const currentSession = startFullPageTranslationProgress();
    expect(runFullPageFailureAction(oldSession, 'retry')).toBe(0);
    expect(runFullPageFailureAction(currentSession, 'retry')).toBe(0);
    setFullPageFailureActions(currentSession, () => {throw new Error('target left');});
    expect(runFullPageFailureAction(currentSession, 'locate')).toBe(0);
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it('失败摘要不会随空队列消失，非法计数归零且普通工作更新保留摘要', () => {
    const sessionId = startFullPageTranslationProgress();
    updateFullPageTranslationProgress(sessionId, {running: 0, queued: 0, offscreen: 0, completed: 8.7, failed: 2.9, retryable: 1.9});
    expect(getFullPageTranslationProgress()).toMatchObject({completed: 8, failed: 2, retryable: 1});
    expect(hasActiveFullPageTranslationWork(getFullPageTranslationProgress())).toBe(true);
    updateFullPageTranslationProgress(sessionId, {running: 1, queued: 0, offscreen: 0});
    expect(getFullPageTranslationProgress()).toMatchObject({completed: 8, failed: 2});
    updateFullPageTranslationProgress(sessionId, {running: 0, queued: 0, offscreen: 0, completed: NaN, failed: -2});
    expect(getFullPageTranslationProgress()).toMatchObject({completed: 0, failed: 0});
    expect(hasActiveFullPageTranslationWork(getFullPageTranslationProgress())).toBe(false);
  });
});
