/**
 * @file tests/imageTranslationClientRecovery.test.ts
 * 文件职责：验证图片翻译客户端在运行时消息通道短暂断开时的单次恢复协议。
 * 主要内容：覆盖断线响应重试、新 requestId、旧请求取消、共享截止时间、取消与进度隔离，以及不可重试错误；撤销或更换监听端口、注册失败和登记期间取消必须结束等待，兼容缺失 crypto 并拒绝不可用的图片读取响应。
 * 模块边界：本文件只测试 services/client 的消息客户端，不启动浏览器、不触碰 Offscreen 或 provider 实现。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {IMAGE_PROGRESS_MESSAGE_TYPE} from '@/src/features/image-translation/progress';
import {fetchImageInExtension, sendCancellableImageOperation, translateImageInExtension} from '@/src/features/image-translation/services/client';

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
    return {promise, resolve, reject};
};

describe('图片翻译客户端断线恢复', () => {
    let listeners: Set<(value: unknown) => void>;
    let sendMessage: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        listeners = new Set();
        sendMessage = vi.fn();
        vi.stubGlobal('browser', {
            runtime: {
                sendMessage,
                onMessage: {
                    addListener: vi.fn((listener: (value: unknown) => void) => listeners.add(listener)),
                    removeListener: vi.fn((listener: (value: unknown) => void) => listeners.delete(listener)),
                },
            },
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('漫画局部结果通过既有消息通道，普通图片不能误接受仅图块响应',async()=>{
        const mangaPatches={width:100,height:100,patches:[{x:0,y:0,width:20,height:20,image:'data:image/png;base64,AQID'}]};
        sendMessage.mockResolvedValue({success:true,image:'',lines:[],mangaPatches});
        await expect(translateImageInExtension('source','en','Page',{manga:true})).resolves.toEqual({image:'',lines:[],mangaPatches});
        await expect(translateImageInExtension('source','en','Page')).rejects.toThrow('不可用');
        expect(listeners.size).toBe(0);
        sendMessage.mockResolvedValue({success:true,image:'',lines:[],mangaPatches:{...mangaPatches,width:0}});
        await expect(translateImageInExtension('source','en','Page',{manga:true})).rejects.toThrow('无效');expect(listeners.size).toBe(0);
    });
    it('普通图片未绘制结果不加载重编码输入，并拒绝不一致的消息形态',async()=>{
        const lines=[{text:'你好',sourceText:'Hello',renderSkipped:true,bbox:{x0:0,y0:0,x1:5,y1:5},backgroundColor:'transparent'}];
        sendMessage.mockResolvedValue({success:true,image:'',imageUnchanged:true,lines});
        await expect(translateImageInExtension('source','en','Page')).resolves.toEqual({image:'',imageUnchanged:true,lines});
        await expect(translateImageInExtension('source','en','Page',{manga:true})).rejects.toThrow();
        for (const response of [
            {success:true,image:'data:image/png,encoded',imageUnchanged:true,lines},
            {success:true,image:'',imageUnchanged:false,lines},
            {success:true,image:'',imageUnchanged:'true',lines},
            {success:true,image:'',imageUnchanged:true,lines:[]},
            {success:true,image:'',imageUnchanged:true,lines,mangaPatches:{width:1,height:1,patches:[]}},
        ]) {sendMessage.mockResolvedValueOnce(response);await expect(translateImageInExtension('source','en','Page')).rejects.toThrow();}
        expect(listeners.size).toBe(0);
    });
    it('嵌套 Offscreen 断线响应只重试一次，保留首个 ID 并为重试生成新 ID', async () => {
        sendMessage
            .mockResolvedValueOnce({success: false, error: 'The message port closed before a response was received.'})
            .mockResolvedValueOnce({success: true, cancelled: true})
            .mockResolvedValueOnce({success: true, image: 'translated', lines: []});

        await expect(translateImageInExtension('source', 'en', 'Page', {
            requestId: 'image-original', timeoutMs: 5_000,
        })).resolves.toEqual({image: 'translated', lines: []});

        expect(sendMessage).toHaveBeenCalledTimes(3);
        expect(sendMessage.mock.calls[0][0]).toMatchObject({type: 'fluentReadImageTranslate', requestId: 'image-original'});
        expect(sendMessage.mock.calls[1][0]).toEqual({type: 'fluentReadImageCancel', requestId: 'image-original'});
        expect(sendMessage.mock.calls[2][0]).toMatchObject({type: 'fluentReadImageTranslate'});
        expect(sendMessage.mock.calls[2][0].requestId).not.toBe('image-original');
    });

    it('第二次仍断线时返回可操作错误，provider 错误不触发重试', async () => {
        sendMessage
            .mockResolvedValueOnce({success: false, error: 'Receiving end does not exist.'})
            .mockResolvedValueOnce({success: true, cancelled: true})
            .mockResolvedValueOnce({success: false, error: 'Could not establish connection. Receiving end does not exist.'});
        await expect(translateImageInExtension('source', 'en', 'Page', {requestId: 'retry'}))
            .rejects.toThrow('图片翻译连接中断，请重试；如果仍然失败，请刷新页面后再试');
        expect(sendMessage).toHaveBeenCalledTimes(3);

        sendMessage.mockReset().mockResolvedValue({success:false,error:'model language failure',errorCode:'language'});
        await expect(translateImageInExtension('source','en','Page')).rejects.toMatchObject({errorCode:'language'});
        expect(sendMessage).toHaveBeenCalledOnce();

        sendMessage.mockReset().mockResolvedValue({success: false, error: 'provider rejected request'});
        await expect(translateImageInExtension('source', 'en', 'Page')).rejects.toThrow('provider rejected request');
        expect(sendMessage).toHaveBeenCalledOnce();
    });

    it('上下文失效、AbortError 和预取消都不重试', async () => {
        sendMessage.mockRejectedValueOnce(new Error('Extension context invalidated.'));
        await expect(translateImageInExtension('source', 'en', 'Page', {requestId: 'context'}))
            .rejects.toThrow('扩展上下文已失效，请刷新页面后再试');
        expect(sendMessage).toHaveBeenCalledOnce();

        sendMessage.mockReset().mockRejectedValueOnce(Object.assign(new Error('aborted'), {name: 'AbortError'}));
        await expect(translateImageInExtension('source', 'en', 'Page', {requestId: 'abort'})).rejects.toThrow('aborted');
        expect(sendMessage).toHaveBeenCalledOnce();

        sendMessage.mockReset();
        const controller = new AbortController();
        controller.abort();
        await expect(translateImageInExtension('source', 'en', 'Page', {signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('拒绝型 runtime 断线后可以恢复，结构化上下文失效直接提示刷新', async () => {
        sendMessage
            .mockRejectedValueOnce(new Error('The message channel closed before a response was received.'))
            .mockRejectedValueOnce(new Error('cancel unavailable'))
            .mockResolvedValueOnce({success: true, image: 'translated', lines: []});
        await expect(translateImageInExtension('source', 'en', 'Page', {requestId: 'rejected'}))
            .resolves.toEqual({image: 'translated', lines: []});
        expect(sendMessage).toHaveBeenCalledTimes(3);

        sendMessage.mockReset().mockResolvedValue({success: false, error: 'Extension context invalidated.'});
        await expect(translateImageInExtension('source', 'en', 'Page', {requestId: 'structured-context'}))
            .rejects.toThrow('扩展上下文已失效，请刷新页面后再试');
        expect(sendMessage).toHaveBeenCalledOnce();
    });

    it('第二次请求等待期间取消时清理监听，并使用当前重试 ID 发送取消', async () => {
        const second = deferred<unknown>();
        sendMessage
            .mockResolvedValueOnce({success: false, error: 'Receiving end does not exist'})
            .mockResolvedValueOnce({success: true, cancelled: true})
            .mockReturnValueOnce(second.promise)
            .mockResolvedValueOnce({success: true, cancelled: true});
        const controller = new AbortController();
        const pending = translateImageInExtension('source', 'en', 'Page', {
            requestId: 'first-id', signal: controller.signal, onProgress: vi.fn(), timeoutMs: 5_000,
        });
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(3));
        const retryId = sendMessage.mock.calls[2][0].requestId;
        controller.abort();
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
        expect(sendMessage).toHaveBeenNthCalledWith(4, {type: 'fluentReadImageCancel', requestId: retryId});
        expect(listeners.size).toBe(0);
        second.resolve({success: true, image: 'late', lines: []});
    });

    it('旧请求取消通知同步触发取消时不再启动重试', async () => {
        const controller = new AbortController();
        sendMessage
            .mockResolvedValueOnce({success: false, error: 'Receiving end does not exist'})
            .mockImplementationOnce(() => { controller.abort(); throw new Error('cancel unavailable'); });
        await expect(translateImageInExtension('source', 'en', 'Page', {
            requestId: 'sync-cancel', signal: controller.signal,
        })).rejects.toMatchObject({name: 'AbortError'});
        expect(sendMessage).toHaveBeenCalledTimes(2);
    });

    it('截止时间在恢复前耗尽时不发送第二次业务请求', async () => {
        vi.useFakeTimers();
        const monotonicNow = vi.spyOn(performance, 'now').mockReturnValue(0);
        try {
            sendMessage.mockImplementationOnce(async () => {
                // 模拟回复回调耗时，不先触发定时器，独立验证恢复前的剩余预算检查。
                monotonicNow.mockReturnValue(20);
                throw new Error('Receiving end does not exist');
            });
            const pending = translateImageInExtension('source', 'en', 'Page', {requestId: 'expired', timeoutMs: 10});
            const rejected = expect(pending).rejects.toMatchObject({name: 'TimeoutError'});
            await rejected;
            expect(sendMessage).toHaveBeenCalledOnce();
            expect(sendMessage.mock.calls[0][0]).toMatchObject({timeoutMs: 10});
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            monotonicNow.mockRestore();
        }
    });

    it('TimeoutError 即使错误文本包含 channel closed 也不重试', async () => {
        sendMessage.mockRejectedValueOnce(Object.assign(new Error('message channel closed'), {name: 'TimeoutError'}));
        await expect(translateImageInExtension('source', 'en', 'Page', {requestId: 'timeout-name'}))
            .rejects.toThrow('message channel closed');
        expect(sendMessage).toHaveBeenCalledOnce();
    });

    it('旧任务清理消耗完剩余预算后不再启动恢复请求', async () => {
        vi.useFakeTimers();
        const monotonicNow = vi.spyOn(performance, 'now').mockReturnValue(0);
        try {
            sendMessage.mockRejectedValueOnce(new Error('The message channel closed'))
                .mockImplementationOnce(async () => { monotonicNow.mockReturnValue(20); });
            await expect(translateImageInExtension('source', 'en', 'Page', {timeoutMs: 10}))
                .rejects.toMatchObject({name: 'TimeoutError'});
            expect(sendMessage.mock.calls.map(([message]) => message.type))
                .toEqual(['fluentReadImageTranslate', 'fluentReadImageCancel']);
            expect(sendMessage.mock.calls[0][0]).toMatchObject({timeoutMs: 10});
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            monotonicNow.mockRestore();
        }
    });

    it('通道回复断开与用户取消同时发生时优先取消', async () => {
        const first = deferred<unknown>();
        const controller = new AbortController();
        sendMessage.mockReturnValueOnce(first.promise);
        const pending = translateImageInExtension('source', 'en', 'Page', {signal: controller.signal});
        const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError'});
        first.reject(new Error('The message channel closed'));
        queueMicrotask(() => controller.abort());
        await rejected;
        expect(sendMessage).toHaveBeenCalledOnce();
    });

    it('迟到的旧进度不会污染重试请求', async () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance']});
        const first = deferred<unknown>();
        const second = deferred<unknown>();
        sendMessage.mockReturnValueOnce(first.promise)
            .mockResolvedValueOnce({success: true, cancelled: true})
            .mockReturnValueOnce(second.promise);
        const progress = vi.fn();
        const pending = translateImageInExtension('source', 'en', 'Page', {
            requestId: 'progress-old', timeoutMs: 20, onProgress: progress,
        });
        expect(listeners.size).toBe(1);
        setTimeout(() => first.reject(new Error('Receiving end does not exist')), 15);
        await vi.advanceTimersByTimeAsync(15);
        expect(sendMessage).toHaveBeenCalledTimes(3);
        expect(sendMessage.mock.calls[1][0]).toEqual({type: 'fluentReadImageCancel', requestId: 'progress-old'});
        const retryRequest = sendMessage.mock.calls[2][0];
        expect(retryRequest).toMatchObject({type: 'fluentReadImageTranslate', timeoutMs: 5});
        expect(retryRequest.requestId).not.toBe('progress-old');
        for (const listener of listeners) listener({type: IMAGE_PROGRESS_MESSAGE_TYPE, requestId: 'progress-old', stage: 'rendering'});
        expect(progress).not.toHaveBeenCalled();
        const rejected = expect(pending).rejects.toMatchObject({name: 'TimeoutError'});
        await vi.advanceTimersByTimeAsync(5);
        await rejected;
        second.resolve({success: true, image: 'late', lines: []});
        expect(progress).not.toHaveBeenCalled();
        expect(listeners.size).toBe(0);
    });
    it.each(['missing', 'without-uuid'] as const)('crypto=%s 时读取仍生成不同的合法请求身份', async kind => {
        vi.resetModules();
        vi.stubGlobal('crypto', kind === 'missing' ? undefined : {getRandomValues: (bytes: Uint32Array) => bytes.fill(7)});
        const fresh = await import('@/src/features/image-translation/services/client');
        sendMessage.mockResolvedValue({success: true, image: 'data:image/png;base64,AQID'});
        await fresh.fetchImageInExtension('https://example.test/first.png');
        await fresh.fetchImageInExtension('https://example.test/second.png');
        const ids = sendMessage.mock.calls.map(([message]) => message.requestId);
        expect(ids).toHaveLength(2); expect(new Set(ids).size).toBe(2);
        for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9._:-]{1,128}$/u);
    });

    it('读取拒绝空响应、非图片或服务失败，并保留明确的失败原因', async () => {
        for (const response of [undefined, {success: false}, {success: true, image: 'https://example.test/image.png'},
            {success: false, error: 'specific fetch failure'}]) {
            sendMessage.mockResolvedValueOnce(response);
            await expect(fetchImageInExtension('https://example.test/image.png'))
                .rejects.toThrow(response?.error ?? '远程图片读取失败');
        }
        expect(listeners.size).toBe(0);
    });

    it('独立读取预先取消时不发送消息，也不登记进度或超时', async () => {
        vi.useFakeTimers();
        const controller = new AbortController(); controller.abort();
        await expect(fetchImageInExtension('https://example.test/image.png', {signal: controller.signal, onProgress: vi.fn()}))
            .rejects.toMatchObject({name: 'AbortError'});
        expect(sendMessage).not.toHaveBeenCalled(); expect(listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    });

    describe('图片客户端清理端口与操作归属', () => {
        beforeEach(() => {vi.useFakeTimers();});
        afterEach(() => {vi.clearAllTimers(); vi.restoreAllMocks();});

        function pendingOperation(options: Parameters<typeof sendCancellableImageOperation>[1] = {}, retainOptions = false) {
            let resolve!: (value: unknown) => void;
            let reject!: (value: unknown) => void;
            // 传输端口只保存真实客户端的完成回调；由测试同步调用，便于捕获旧清理异常，避免制造全局未处理拒绝。
            sendMessage.mockImplementation((message: {type?: string}) => message.type === 'fluentReadImageCancel'
                ? Promise.resolve({success: true})
                : {then: (onResolve: typeof resolve, onReject: typeof reject) => {resolve = onResolve; reject = onReject;}});
            const promise = sendCancellableImageOperation({type: 'fluentReadImageTranslate'},
                retainOptions ? options : {requestId: 'cleanup-owner', timeoutMs: 25, onProgress: vi.fn(), ...options}, 'bounded timeout');
            return {promise, complete: (value: unknown) => resolve(value), fail: (error: unknown) => reject(error)};
        }

        it.each(['success', 'rejection', 'timeout', 'abort'] as const)('%s 时原端口取消监听失败仍结束等待且忽略迟到进度', async kind => {
            const port = browser.runtime.onMessage;
            const controller = new AbortController();
            let abort!: () => void;
            const add = controller.signal.addEventListener.bind(controller.signal);
            vi.spyOn(controller.signal, 'addEventListener').mockImplementation((type, listener, options) => {
                if (type === 'abort') abort = listener as () => void;
                add(type, listener, options);
            });
            const removeAbort = vi.spyOn(controller.signal, 'removeEventListener');
            const progress = vi.fn();
            const operation = pendingOperation({signal: controller.signal, onProgress: progress});
            const oldProgress = [...listeners][0];
            vi.mocked(port.removeListener).mockImplementation(() => {throw new Error('revoked listener port');});
            const error = new Error('provider failure');
            const result = kind === 'success' ? expect(operation.promise).resolves.toEqual({success: true})
                : kind === 'rejection' ? expect(operation.promise).rejects.toBe(error)
                    : expect(operation.promise).rejects.toMatchObject({name: kind === 'timeout' ? 'TimeoutError' : 'AbortError'});
            expect(() => {
                if (kind === 'success') operation.complete({success: true});
                else if (kind === 'rejection') operation.fail(error);
                else if (kind === 'timeout') vi.advanceTimersByTime(25);
                else abort();
            }).not.toThrow();
            await result;
            expect(vi.getTimerCount()).toBe(0); expect(removeAbort).toHaveBeenCalledWith('abort', abort);
            oldProgress({type: IMAGE_PROGRESS_MESSAGE_TYPE, requestId: 'cleanup-owner', stage: 'rendering'});
            expect(progress).not.toHaveBeenCalled();
            operation.complete({success: true, image: 'late'}); expect(port.removeListener).toHaveBeenCalledOnce();
        });

        it('完成前 runtime 的监听端口 getter 被撤销仍移除已注册端口并结束等待', async () => {
            const port = browser.runtime.onMessage;
            const operation = pendingOperation();
            Object.defineProperty(browser.runtime, 'onMessage', {configurable: true, get: () => {throw new Error('Extension context invalidated');}});
            expect(() => operation.complete({success: true})).not.toThrow();
            await expect(operation.promise).resolves.toEqual({success: true});
            expect(port.removeListener).toHaveBeenCalledOnce(); expect(listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
        });

        it('替换 runtime 事件端口时只清理原有注册，不碰新端口', async () => {
            const original = browser.runtime.onMessage;
            const operation = pendingOperation();
            const replacement = {addListener: vi.fn(), removeListener: vi.fn()};
            Object.defineProperty(browser.runtime, 'onMessage', {configurable: true, value: replacement});
            operation.complete({success: true}); await operation.promise;
            expect(original.removeListener).toHaveBeenCalledOnce(); expect(replacement.removeListener).not.toHaveBeenCalled();
            expect(listeners.size).toBe(0);
        });

        it('调用方修改 options 后仍由开始时的信号和进度回调拥有本次操作', async () => {
            const original = new AbortController(), replacement = new AbortController();
            const removeOriginal = vi.spyOn(original.signal, 'removeEventListener');
            const removeReplacement = vi.spyOn(replacement.signal, 'removeEventListener');
            const progress = vi.fn();
            const options = {signal: original.signal, onProgress: progress as (() => void) | undefined,
                requestId: 'cleanup-owner', timeoutMs: 25};
            const operation = pendingOperation(options, true);
            const handler = [...listeners][0];
            options.signal = replacement.signal; options.onProgress = undefined;
            handler({type: IMAGE_PROGRESS_MESSAGE_TYPE, requestId: 'cleanup-owner', stage: 'recognizing'});
            operation.complete({success: true}); await operation.promise;
            expect(progress).toHaveBeenCalledOnce(); expect(removeOriginal).toHaveBeenCalledOnce();
            expect(removeReplacement).not.toHaveBeenCalled(); expect(listeners.size).toBe(0);
        });

        it('进度端口登记异常时也清理已登记部分，不发送业务消息或留下计时器', async () => {
            vi.mocked(browser.runtime.onMessage.addListener).mockImplementation((listener: (value: unknown) => void) => {
                listeners.add(listener as (value: unknown) => void); throw new Error('registration failed');
            });
            const operation = pendingOperation();
            await expect(operation.promise).rejects.toThrow('registration failed');
            expect(listeners.size).toBe(0); expect(sendMessage).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
        });

        it('登记进度期间已取消时不发送业务请求，并归还刚登记的监听器', async () => {
            const controller = new AbortController();
            vi.mocked(browser.runtime.onMessage.addListener).mockImplementation((listener: (value: unknown) => void) => {
                listeners.add(listener as (value: unknown) => void); controller.abort();
            });
            const operation = pendingOperation({signal: controller.signal});
            const rejected = expect(operation.promise).rejects.toMatchObject({name: 'AbortError'});
            expect(sendMessage.mock.calls.every(([message]) => message.type === 'fluentReadImageCancel')).toBe(true);
            await rejected; expect(listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
        });
    });
});
