import {describe, expect, it, vi} from 'vitest';
import {createExtensionPageRuntime, installExtensionPageMessageListener, type ExtensionPageMessageTarget} from '@/src/platform/offscreen/extensionPageMessaging';

const senderUrl = 'safari-web-extension://fixture/offscreen.html';
const nativeRuntime = {id: 'fixture'};
const runtimeFor = (getTarget: () => ExtensionPageMessageTarget | undefined) => createExtensionPageRuntime(() => nativeRuntime, getTarget, () => senderUrl);

describe('Safari 同源扩展页面消息', () => {
    it('只移除所属接收端，旧页面退出不会删除替换后的接收端', () => {
        const target: ExtensionPageMessageTarget = {};
        const first = installExtensionPageMessageListener(target, () => undefined);
        const listener = vi.fn();
        const second = installExtensionPageMessageListener(target, listener);
        first();
        expect(target.__fluentReadExtensionPageMessage).toBe(listener);
        second();
        expect(target.__fluentReadExtensionPageMessage).toBeUndefined();
        second();
    });

    it('传递真实来源，保留异步 callback 回复并丢弃重复回复', async () => {
        const target: ExtensionPageMessageTarget = {};
        const listener = vi.fn((_message, _sender, reply) => {
            queueMicrotask(() => {reply({success: true}); reply({success: false});});
            return true;
        });
        installExtensionPageMessageListener(target, listener);
        const runtime = runtimeFor(() => target);
        const callback = vi.fn();
        runtime.sendMessage({type: 'FLUENT_READ_OFFSCREEN_READY'}, callback);
        expect(callback).not.toHaveBeenCalled();
        await Promise.resolve();
        expect(callback).toHaveBeenCalledExactlyOnceWith({success: true});
        expect(listener.mock.calls[0][1]).toEqual({id: 'fixture', url: senderUrl});
        expect(runtime.lastError).toBeUndefined();
    });

    it('适配后台 Promise 回复，并保持 callback 在返回值之前完成的结果', async () => {
        const target: ExtensionPageMessageTarget = {};
        const runtime = runtimeFor(() => target);
        installExtensionPageMessageListener(target, async () => ({success: true}));
        await expect(new Promise(resolve => runtime.sendMessage({}, resolve))).resolves.toEqual({success: true});
        installExtensionPageMessageListener(target, (_message, _sender, reply) => {reply('callback'); return Promise.resolve('promise');});
        const callback = vi.fn();
        runtime.sendMessage({}, callback);
        await Promise.resolve();
        expect(callback).toHaveBeenCalledExactlyOnceWith('callback');
        for (const value of [undefined, false]) {
            installExtensionPageMessageListener(target, () => value);
            await expect(new Promise(resolve => runtime.sendMessage({}, resolve))).resolves.toBeUndefined();
        }
    });

    it('缺失、尚未安装或跨源接收端按原 client 的缺失接收端契约失败，随后可重试', () => {
        const target: ExtensionPageMessageTarget = {};
        for (const getTarget of [() => undefined, () => target, () => {throw new Error('Blocked cross-origin Window access');}]) {
            const runtime = runtimeFor(getTarget);
            runtime.sendMessage({}, response => {
                expect(response).toBeUndefined();
                expect(runtime.lastError?.message).toMatch(/Receiving end does not exist|cross-origin Window/u);
            });
            expect(runtime.lastError).toBeUndefined();
        }
        const runtime = runtimeFor(() => target);
        installExtensionPageMessageListener(target, (_message, _sender, reply) => {reply('ready');});
        runtime.sendMessage({}, response => expect(response).toBe('ready'));
    });

    it('把同步抛错和 Promise 拒绝传给当前 callback，嵌套失败后恢复外层 lastError', async () => {
        const target: ExtensionPageMessageTarget = {};
        const runtime = runtimeFor(() => target);
        installExtensionPageMessageListener(target, () => {throw new Error('outer');});
        runtime.sendMessage({}, () => {
            expect(runtime.lastError?.message).toBe('outer');
            installExtensionPageMessageListener(target, () => {throw 'inner';});
            runtime.sendMessage({}, () => expect(runtime.lastError?.message).toBe('inner'));
            expect(runtime.lastError?.message).toBe('outer');
        });
        expect(runtime.lastError).toBeUndefined();
        installExtensionPageMessageListener(target, () => Promise.reject('rejected'));
        await new Promise<void>(resolve => runtime.sendMessage({}, () => {expect(runtime.lastError?.message).toBe('rejected'); resolve();}));
        expect(runtime.lastError).toBeUndefined();
    });
});
