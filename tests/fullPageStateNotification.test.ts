import {afterEach, describe, expect, it, vi} from 'vitest';
import {getFullPageTranslationStateRevision, notifyFullPageTranslationState, getTranslationToolbarStatus, notifyTranslationToolbarStatus, subscribeTranslationToolbarStatus} from '@/src/features/full-page-translation/content/stateNotification';

const install = (value: Record<string, unknown> | undefined) => {if (value === undefined) delete (globalThis as Record<string, unknown>).browser; else (globalThis as Record<string, unknown>).browser = value;};
afterEach(() => vi.unstubAllGlobals());
describe('full-page state notification', () => {
    it('两个同步写入者互相切换状态时不会递归，只读入口追上最新结果', () => {
        const sendMessage = vi.fn(); vi.stubGlobal('browser', {runtime: {sendMessage}});
        notifyFullPageTranslationState(false);
        const first = vi.fn<(status: string) => void>(status => {if (status === 'translating' || status === 'translated') notifyTranslationToolbarStatus('error');});
        const second = vi.fn<(status: string) => void>(status => {if (status === 'error') notifyTranslationToolbarStatus('translated');});
        const observer = vi.fn();
        const stops = [subscribeTranslationToolbarStatus(first), subscribeTranslationToolbarStatus(second), subscribeTranslationToolbarStatus(observer)];
        try {
            expect(() => notifyFullPageTranslationState(true)).not.toThrow();
            expect(first.mock.calls).toEqual([['idle'], ['translating']]);
            expect(second.mock.calls).toEqual([['idle'], ['error']]);
            expect(observer.mock.calls).toEqual([['idle'], ['translated']]);
            expect(getTranslationToolbarStatus()).toBe('translated');
            expect(sendMessage).toHaveBeenLastCalledWith({type: 'fullPageTranslationState', isTranslated: true, toolbarStatus: 'translated'});
        } finally {stops.forEach(stop => stop()); notifyFullPageTranslationState(false);}
    });

    it('发布中重新订阅同一写入者不会重放自身回声，新订阅者只接当前结果', () => {
        const sendMessage = vi.fn(); vi.stubGlobal('browser', {runtime: {sendMessage}});
        notifyFullPageTranslationState(false);
        const stops: Array<() => void> = [];
        const observer = vi.fn();
        const writer = vi.fn<(status: string) => void>(status => {
            if (status !== 'translating') return;
            notifyTranslationToolbarStatus('error');
            stops.push(subscribeTranslationToolbarStatus(writer));
            stops.push(subscribeTranslationToolbarStatus(observer));
            stops.push(subscribeTranslationToolbarStatus(observer));
        });
        stops.push(subscribeTranslationToolbarStatus(writer));
        try {
            notifyFullPageTranslationState(true);
            expect(writer.mock.calls).toEqual([['idle'], ['translating']]);
            expect(observer.mock.calls).toEqual([['error']]);
            expect(getTranslationToolbarStatus()).toBe('error');
            expect(sendMessage).toHaveBeenLastCalledWith({type: 'fullPageTranslationState', isTranslated: true, toolbarStatus: 'error'});
        } finally {stops.forEach(stop => stop()); notifyFullPageTranslationState(false);}
    });
    it('同步订阅当前结果，去重更新并释放监听；异常不阻断其余入口', () => {
        const sendMessage = vi.fn(); vi.stubGlobal('browser', {runtime: {sendMessage}});
        notifyFullPageTranslationState(false);
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        const broken = vi.fn(() => {throw new Error('broken view');});
        const observer = vi.fn();
        const stopBroken = subscribeTranslationToolbarStatus(broken);
        const stopObserver = subscribeTranslationToolbarStatus(observer);
        try {
            expect(observer.mock.calls).toEqual([['idle']]);
            notifyFullPageTranslationState(true);
            notifyTranslationToolbarStatus('translating');
            notifyTranslationToolbarStatus('error');
            notifyTranslationToolbarStatus('translated');
            expect(observer.mock.calls).toEqual([['idle'], ['translating'], ['error'], ['translated']]);
            expect(log).toHaveBeenCalledTimes(4);
            stopObserver(); stopBroken();
            notifyFullPageTranslationState(false);
            expect(observer).toHaveBeenCalledTimes(4);
        } finally {stopObserver(); stopBroken(); log.mockRestore();}
    });

    it('订阅者同步恢复时只发送结束状态，后续入口不会收到迟到开始结果', () => {
        const sendMessage = vi.fn(); vi.stubGlobal('browser', {runtime: {sendMessage}});
        notifyFullPageTranslationState(false); sendMessage.mockClear();
        const restore = subscribeTranslationToolbarStatus(status => {
            if (status === 'translating') notifyFullPageTranslationState(false);
        });
        const observer = vi.fn(); const stop = subscribeTranslationToolbarStatus(observer);
        try {
            notifyFullPageTranslationState(true);
            expect(getTranslationToolbarStatus()).toBe('idle');
            expect(observer.mock.calls).toEqual([['idle'], ['idle']]);
            expect(sendMessage.mock.calls).toEqual([[{type: 'fullPageTranslationState', isTranslated: false, toolbarStatus: 'idle'}]]);
        } finally {restore(); stop();}
    });

    it('订阅者在结束时重新开始会话，只交付当前新会话并隔离过期结束通知', () => {
        const sendMessage = vi.fn(); vi.stubGlobal('browser', {runtime: {sendMessage}});
        notifyFullPageTranslationState(true); sendMessage.mockClear();
        let restarted = false;
        const restart = subscribeTranslationToolbarStatus(status => {
            if (status === 'idle' && !restarted) {restarted = true; notifyFullPageTranslationState(true);}
        });
        const observer = vi.fn(); const stop = subscribeTranslationToolbarStatus(observer);
        try {
            notifyFullPageTranslationState(false);
            expect(getTranslationToolbarStatus()).toBe('translating');
            expect(observer.mock.calls).toEqual([['translating'], ['translating']]);
            expect(sendMessage.mock.calls).toEqual([[{type: 'fullPageTranslationState', isTranslated: true, toolbarStatus: 'translating'}]]);
        } finally {restart(); stop(); notifyFullPageTranslationState(false);}
    });

    it('结束会话中的结果写入不能重新标记为正在翻译，发布中取消的订阅不再交付', () => {
        const sendMessage = vi.fn(); vi.stubGlobal('browser', {runtime: {sendMessage}});
        notifyFullPageTranslationState(true); sendMessage.mockClear();
        let removeObserver = () => {};
        const writer = subscribeTranslationToolbarStatus(status => {
            if (status === 'idle') {removeObserver(); notifyTranslationToolbarStatus('error');}
        });
        const observer = vi.fn(); removeObserver = subscribeTranslationToolbarStatus(observer);
        try {
            notifyFullPageTranslationState(false);
            expect(getTranslationToolbarStatus()).toBe('idle');
            expect(observer.mock.calls).toEqual([['translating']]);
            expect(sendMessage.mock.calls).toEqual([[{type: 'fullPageTranslationState', isTranslated: false, toolbarStatus: 'idle'}]]);
        } finally {writer(); removeObserver();}
    });

    it('结果订阅者同步恢复会话后，不再发送原先的失败结果', () => {
        const sendMessage = vi.fn(); vi.stubGlobal('browser', {runtime: {sendMessage}});
        notifyFullPageTranslationState(true); sendMessage.mockClear();
        const restore = subscribeTranslationToolbarStatus(status => {
            if (status === 'error') notifyFullPageTranslationState(false);
        });
        try {
            notifyTranslationToolbarStatus('error');
            expect(getTranslationToolbarStatus()).toBe('idle');
            expect(sendMessage.mock.calls).toEqual([[{type: 'fullPageTranslationState', isTranslated: false, toolbarStatus: 'idle'}]]);
        } finally {restore();}
    });
    it.each(['constructor', 'dispatch', 'defaultView'] as const)('continues background synchronization when document %s throws', (failure) => {
        const Custom = vi.fn(function() {if (failure === 'constructor') throw new Error('unavailable constructor'); return {type: 'event'};});
        const dispatchEvent = vi.fn(() => {if (failure === 'dispatch') throw new Error('unavailable dispatch');});
        const document = {dispatchEvent, get defaultView() {if (failure === 'defaultView') throw new Error('detached document'); return {CustomEvent: Custom};}};
        const sendMessage = vi.fn();
        vi.stubGlobal('document', document);
        vi.stubGlobal('browser', {runtime: {sendMessage}});
        const before = getFullPageTranslationStateRevision();
        expect(() => notifyFullPageTranslationState(true)).not.toThrow();
        expect(getFullPageTranslationStateRevision()).toBe(before + 1);
        expect(sendMessage).toHaveBeenLastCalledWith({type: 'fullPageTranslationState', isTranslated: true, toolbarStatus: 'translating'});
        expect(() => notifyFullPageTranslationState(false)).not.toThrow();
        expect(getFullPageTranslationStateRevision()).toBe(before + 2);
        expect(sendMessage).toHaveBeenLastCalledWith({type: 'fullPageTranslationState', isTranslated: false, toolbarStatus: 'idle'});
    });
    it.each([false, true])('does not send an obsolete state after a lifecycle listener changes the session (throw=%s)', (throwAfterRestore) => {
        const Custom = vi.fn(function(_this: unknown) {return {};});
        let dispatched = false;
        vi.stubGlobal('document', {defaultView: {CustomEvent: Custom}, dispatchEvent: () => {
            if (dispatched) return;
            dispatched = true;
            notifyFullPageTranslationState(false);
            if (throwAfterRestore) throw new Error('listener dispatch failed');
        }});
        const sendMessage = vi.fn();
        vi.stubGlobal('browser', {runtime: {sendMessage}});
        const before = getFullPageTranslationStateRevision();
        expect(() => notifyFullPageTranslationState(true)).not.toThrow();
        expect(getFullPageTranslationStateRevision()).toBe(before + 2);
        expect(sendMessage.mock.calls).toEqual([[{type: 'fullPageTranslationState', isTranslated: false, toolbarStatus: 'idle'}]]);
    });
    it('deduplicates result updates without replaying lifecycle events or advancing session revision', () => {
        const sendMessage = vi.fn(); install({runtime: {sendMessage}});
        notifyFullPageTranslationState(true); const revision = getFullPageTranslationStateRevision();
        notifyTranslationToolbarStatus('translating'); expect(sendMessage).toHaveBeenCalledTimes(1);
        notifyTranslationToolbarStatus('error'); expect(getTranslationToolbarStatus()).toBe('error');
        expect(sendMessage).toHaveBeenLastCalledWith({type: 'fullPageTranslationState', isTranslated: true, toolbarStatus: 'error'});
        expect(getFullPageTranslationStateRevision()).toBe(revision);
        notifyFullPageTranslationState(false); expect(getTranslationToolbarStatus()).toBe('idle'); install(undefined);
    });
    it('increments private revision before dispatch and sends started/ended messages', async () => {
        const dispatch = vi.fn(); const Custom = vi.fn(function(this: unknown, type: string) {return {type};}); const previous = (globalThis as Record<string, unknown>).document;
        (globalThis as Record<string, unknown>).document = {dispatchEvent: dispatch, defaultView: {CustomEvent: Custom}};
        const sendMessage = vi.fn(async () => undefined); install({runtime: {sendMessage}});
        const before = getFullPageTranslationStateRevision(); notifyFullPageTranslationState(true); expect(getFullPageTranslationStateRevision()).toBe(before + 1); expect(Custom).toHaveBeenCalledWith('fluentread-translation-started'); expect(dispatch).toHaveBeenCalled(); expect(sendMessage).toHaveBeenCalledWith({type: 'fullPageTranslationState', isTranslated: true, toolbarStatus: 'translating'});
        notifyFullPageTranslationState(false); expect(Custom).toHaveBeenLastCalledWith('fluentread-translation-ended'); expect(sendMessage).toHaveBeenLastCalledWith({type: 'fullPageTranslationState', isTranslated: false, toolbarStatus: 'idle'}); (globalThis as Record<string, unknown>).document = previous;
    });
    it('uses global CustomEvent, skips when document cannot dispatch, and tolerates browser failures', async () => {
        const previousDocument = (globalThis as Record<string, unknown>).document; const previousCustom = (globalThis as Record<string, unknown>).CustomEvent;
        const dispatch = vi.fn(); const Custom = vi.fn(function(this: unknown, type: string) {return {type};}); (globalThis as Record<string, unknown>).document = {dispatchEvent: dispatch}; (globalThis as Record<string, unknown>).CustomEvent = Custom;
        install({runtime: {sendMessage: vi.fn(() => Promise.reject(new Error('reload')))}}); notifyFullPageTranslationState(true); expect(Custom).toHaveBeenCalled();
        (globalThis as Record<string, unknown>).document = {}; install({runtime: {sendMessage: vi.fn(() => {throw new Error('invalidated');})}}); expect(() => notifyFullPageTranslationState(false)).not.toThrow();
        (globalThis as Record<string, unknown>).document = previousDocument; if (previousCustom === undefined) delete (globalThis as Record<string, unknown>).CustomEvent; else (globalThis as Record<string, unknown>).CustomEvent = previousCustom; install(undefined);
    });
    it('falls back to the global CustomEvent when document.defaultView has none', () => {
        const previousDocument = (globalThis as Record<string, unknown>).document; const previousCustom = (globalThis as Record<string, unknown>).CustomEvent;
        const dispatch = vi.fn(); const Custom = vi.fn(function(this: unknown, type: string) {return {type};});
        (globalThis as Record<string, unknown>).document = {dispatchEvent: dispatch, defaultView: {CustomEvent: undefined}}; (globalThis as Record<string, unknown>).CustomEvent = Custom; install(undefined);
        notifyFullPageTranslationState(true); expect(Custom).toHaveBeenCalledWith('fluentread-translation-started'); expect(dispatch).toHaveBeenCalled();
        (globalThis as Record<string, unknown>).document = previousDocument; if (previousCustom === undefined) delete (globalThis as Record<string, unknown>).CustomEvent; else (globalThis as Record<string, unknown>).CustomEvent = previousCustom;
    });
    it('skips dispatch when neither document nor global supplies CustomEvent', () => {
        const previousDocument = (globalThis as Record<string, unknown>).document; const previousCustom = (globalThis as Record<string, unknown>).CustomEvent;
        const dispatch = vi.fn(); (globalThis as Record<string, unknown>).document = {dispatchEvent: dispatch, defaultView: {CustomEvent: undefined}}; delete (globalThis as Record<string, unknown>).CustomEvent; install(undefined);
        expect(() => notifyFullPageTranslationState(false)).not.toThrow(); expect(dispatch).not.toHaveBeenCalled();
        (globalThis as Record<string, unknown>).document = previousDocument; if (previousCustom !== undefined) (globalThis as Record<string, unknown>).CustomEvent = previousCustom;
    });
    it('handles missing browser/runtime and a rejected promise without unhandled errors', () => {const previous = (globalThis as Record<string, unknown>).document; (globalThis as Record<string, unknown>).document = undefined; install(undefined); expect(() => notifyFullPageTranslationState(true)).not.toThrow(); install({}); expect(() => notifyFullPageTranslationState(false)).not.toThrow(); (globalThis as Record<string, unknown>).document = previous;});
});
