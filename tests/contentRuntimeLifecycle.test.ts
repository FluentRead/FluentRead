import {describe, expect, it, vi} from 'vitest';
import {installContentPageLifecycle} from '@/src/app/content/pageLifecycle';

function transition(target: EventTarget, type: string, persisted = false): void {
    target.dispatchEvent(Object.assign(new Event(type), {persisted}));
}

describe('content runtime 页面生命周期', () => {
    it('取消离开不卸载，往返缓存暂停后可恢复，真正离开只销毁一次', () => {
        const target = new EventTarget();
        const controller = new AbortController();
        const actions = {suspend: vi.fn(), resume: vi.fn(), dispose: vi.fn()};
        installContentPageLifecycle(target, controller.signal, actions);
        transition(target, 'beforeunload');
        transition(target, 'pageshow');
        expect(actions.dispose).not.toHaveBeenCalled();
        expect(actions.suspend).not.toHaveBeenCalled();
        transition(target, 'pagehide', true);
        transition(target, 'pagehide', true);
        expect(actions.suspend).toHaveBeenCalledOnce();
        transition(target, 'pageshow');
        expect(actions.resume).not.toHaveBeenCalled();
        transition(target, 'pageshow', true);
        transition(target, 'pageshow', true);
        expect(actions.resume).toHaveBeenCalledOnce();
        transition(target, 'pagehide');
        transition(target, 'pagehide');
        transition(target, 'pageshow', true);
        expect(actions.dispose).toHaveBeenCalledOnce();
        expect(actions.resume).toHaveBeenCalledOnce();
    });

    it('运行时失效后移除页面监听，不允许迟到的 pageshow 复活扩展', () => {
        const target = new EventTarget();
        const controller = new AbortController();
        const actions = {suspend: vi.fn(), resume: vi.fn(), dispose: vi.fn()};
        installContentPageLifecycle(target, controller.signal, actions);
        transition(target, 'pagehide', true);
        controller.abort();
        transition(target, 'pageshow', true);
        transition(target, 'pagehide');
        expect(actions.resume).not.toHaveBeenCalled();
        expect(actions.dispose).not.toHaveBeenCalled();
    });
});
