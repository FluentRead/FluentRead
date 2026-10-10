import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const fixture = vi.hoisted(() => ({
    config: {on: true},
    document: {visibilityState: 'visible'},
    session: {renderCommitGeneration: 0},
}));
vi.mock('@/src/services/config/store', () => ({config: fixture.config}));
vi.mock('@/src/features/full-page-translation/content/requestSession', () => ({
    getHoverTranslationRequestSession: () => fixture.session,
}));
import {
    cancelPendingHoverTranslation,
    isHoverTranslationAvailable,
    scheduleHoverTranslation,
} from '@/src/features/full-page-translation/content/hoverScheduling';

beforeEach(() => {
    vi.useFakeTimers();
    fixture.config.on = true;
    fixture.document.visibilityState = 'visible';
    fixture.session = {renderCommitGeneration: 0};
    vi.stubGlobal('document', fixture.document);
});
afterEach(() => {
    cancelPendingHoverTranslation();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('悬浮翻译会话内延时调度', () => {
    it.each([0, 120])('%dms 调度只在期限届满时执行一次，执行后可取消或重新调度', delayMs => {
        const first = vi.fn(), next = vi.fn();
        expect(isHoverTranslationAvailable()).toBe(true);
        scheduleHoverTranslation(first, delayMs);
        expect(first).not.toHaveBeenCalled();
        if (delayMs > 0) {
            vi.advanceTimersByTime(delayMs - 1);
            expect(first).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1);
        } else vi.advanceTimersByTime(0);
        expect(first).toHaveBeenCalledOnce();
        cancelPendingHoverTranslation();
        scheduleHoverTranslation(next, 0);
        vi.runAllTimers();
        expect(next).toHaveBeenCalledOnce();
        expect(first).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('快速换目标替换未执行的工作，重复取消不让已取消任务复活', () => {
        const first = vi.fn(), second = vi.fn(), cancelled = vi.fn();
        scheduleHoverTranslation(first, 120);
        vi.advanceTimersByTime(50);
        scheduleHoverTranslation(second, 90);
        vi.advanceTimersByTime(70);
        expect(first).not.toHaveBeenCalled();
        expect(second).not.toHaveBeenCalled();
        vi.advanceTimersByTime(20);
        expect(second).toHaveBeenCalledOnce();
        scheduleHoverTranslation(cancelled, 120);
        cancelPendingHoverTranslation();
        cancelPendingHoverTranslation();
        vi.runAllTimers();
        expect(cancelled).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['hidden', 'disabled'])('%s 状态不能排队，并撤回此前目标，恢复状态也不执行旧工作', reason => {
        const old = vi.fn(), unavailable = vi.fn(), fresh = vi.fn();
        scheduleHoverTranslation(old, 120);
        if (reason === 'hidden') fixture.document.visibilityState = 'hidden';
        else fixture.config.on = false;
        expect(isHoverTranslationAvailable()).toBe(false);
        scheduleHoverTranslation(unavailable, 0);
        expect(vi.getTimerCount()).toBe(0);
        fixture.document.visibilityState = 'visible';
        fixture.config.on = true;
        vi.runAllTimers();
        expect(old).not.toHaveBeenCalled();
        expect(unavailable).not.toHaveBeenCalled();
        scheduleHoverTranslation(fresh, 0);
        vi.runAllTimers();
        expect(fresh).toHaveBeenCalledOnce();
    });

    it.each(['hidden', 'disabled', 'replaced-session', 'route-generation'])(
        '已排队工作在 %s 后失效，新会话可正常调度', reason => {
            const stale = vi.fn(), fresh = vi.fn();
            scheduleHoverTranslation(stale, 120);
            if (reason === 'hidden') fixture.document.visibilityState = 'hidden';
            if (reason === 'disabled') fixture.config.on = false;
            if (reason === 'replaced-session') fixture.session = {renderCommitGeneration: 0};
            if (reason === 'route-generation') fixture.session.renderCommitGeneration += 1;
            vi.runAllTimers();
            expect(stale).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
            fixture.document.visibilityState = 'visible';
            fixture.config.on = true;
            scheduleHoverTranslation(fresh, 0);
            vi.runAllTimers();
            expect(fresh).toHaveBeenCalledOnce();
        },
    );
});
