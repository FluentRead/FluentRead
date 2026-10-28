/**
 * @file src/app/background/materialImportRuntime.ts
 * 文件职责：组装学习材料分片恢复端口的后台边界。
 * 主要内容：校验设置页来源和隐私上下文，按需创建暂存服务并广播材料变更。
 * 模块边界：不读取文件、不管理界面，也不改变现有恢复大小限制。
 */
import browser from 'webextension-polyfill';
import {createStage} from '@/src/features/vocabulary/materialImportStage';
import {MaterialDatabase} from '@/src/features/vocabulary/materialRepository';
import {makePortBridge, PORT_NAME, type MaterialImportPort} from '@/src/features/vocabulary/materialImportPort';
import {MATERIAL_CHANGED_MESSAGE} from '@/src/features/vocabulary/materialProtocol';
import {isTrustedSettingsSender} from './handlers/trustedSettingsSender';

type Runtime = {
    id: string;
    getURL(path: string): string;
    onConnect: {
        addListener(listener: (port: MaterialImportPort) => void): void;
        removeListener(listener: (port: MaterialImportPort) => void): void;
    };
    sendMessage(message: unknown): Promise<unknown>;
};
type Service = {stage: ReturnType<typeof createStage>; close(): void};
type Options = {runtime: Runtime; isPrivateContext(): boolean; createStage(): Service; ready: Promise<unknown>};
const installed = new WeakMap<Runtime, () => void>();

/** 同步安装监听；仅在可信设置页连接后创建暂存服务。 */
export function installMaterialImportRuntime(options: Options): () => void {
    const prior = installed.get(options.runtime);
    if (prior) return prior;
    let service: Service | undefined;
    let bridge: ReturnType<typeof makePortBridge> | undefined;
    let cleanup: Promise<unknown> | undefined;
    const cleanupController = new AbortController();
    let disposed = false;
    let readyState: 'pending' | 'ready' | 'failed' = 'pending';
    const readyWaiters = new Set<(ok: boolean) => void>();
    void options.ready.then(() => {
        readyState = 'ready';
        for (const finish of [...readyWaiters]) finish(true);
    }, () => {
        readyState = 'failed';
        for (const finish of [...readyWaiters]) finish(false);
    });
    const waitReady = (signal?: AbortSignal): Promise<void> => {
        if (signal?.aborted || disposed) return Promise.reject(Error('unavailable'));
        if (readyState !== 'pending') return readyState === 'ready' ? Promise.resolve() : Promise.reject(Error('unavailable'));
        return new Promise<void>((resolve, reject) => {
            const finish = (ok: boolean) => {
                readyWaiters.delete(finish);signal?.removeEventListener('abort', abort);clearTimeout(timer);
                if (ok) resolve(); else reject(Error('unavailable'));
            };
            const abort = () => finish(false);
            const timer = setTimeout(abort, 30_000);
            readyWaiters.add(finish);signal?.addEventListener('abort', abort, {once: true});
            if (signal?.aborted) abort();
        });
    };
    const assertAvailable = (signal?: AbortSignal) => {
        if (disposed || signal?.aborted || options.isPrivateContext()) throw Error('unavailable');
    };
    const wait = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
        if (!signal) return promise;
        if (signal.aborted) return Promise.reject(Error('unavailable'));
        return new Promise<T>((resolve, reject) => {
            const abort = () => { signal.removeEventListener('abort', abort); reject(Error('unavailable')); };
            signal.addEventListener('abort', abort, {once: true});
            promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
            if (signal.aborted) abort();
        });
    };
    const isTrustedSender = (sender: MaterialImportPort['sender']) =>
        isTrustedSettingsSender(sender, options.runtime.id, options.runtime.getURL('/options.html'));
    const onConnect = (port: MaterialImportPort) => {
        if (port.name !== PORT_NAME) return;
        let trusted = false;
        try {
            trusted = !disposed && !options.isPrivateContext() && port.sender?.incognito !== true
                && port.sender?.tab?.incognito !== true && isTrustedSender(port.sender);
        } catch { /* 拒绝无法验证的来源。 */ }
        if (!trusted) {
            try { port.disconnect(); } catch { /* 端口可能已经关闭。 */ }
            return;
        }
        if (!bridge) {
            try {
                service = options.createStage();
                const stage = service.stage;
                const gate = async <T>(signal: AbortSignal | undefined, task: () => Promise<T>, needsCleanup = false): Promise<T> => {
                    await waitReady(signal);
                    assertAvailable(signal);
                    if (needsCleanup) {
                        if (!cleanup) {
                            const controller = new AbortController();
                            const abort = () => controller.abort();
                            cleanupController.signal.addEventListener('abort', abort, {once: true});
                            const timer = setTimeout(abort, 30_000);
                            const pending = wait(Promise.resolve().then(() => {
                                assertAvailable();
                                return stage.cleanup({signal: controller.signal});
                            }), controller.signal);
                            cleanup = pending;
                            void pending.then(() => { if (cleanup === pending) cleanup = undefined; }, () => { if (cleanup === pending) cleanup = undefined; })
                                .finally(() => { clearTimeout(timer); cleanupController.signal.removeEventListener('abort', abort); });
                        }
                        await wait(cleanup, signal);
                        assertAvailable(signal);
                    }
                    return task();
                };
                bridge = makePortBridge({
                    ...stage,
                    beginRecoverable: (manifest, guard, capability, request) => gate(request.signal, () => stage.beginRecoverable(manifest, guard, capability, request), true),
                    resume: (capability, request) => gate(request.signal, () => stage.resume(capability, request)),
                    append: (capability, frame, request) => gate(request.signal, () => stage.append(capability, frame, request)),
                    seal: (capability, request) => gate(request.signal, () => stage.seal(capability, request)),
                    commit: (capability, request) => gate(request.signal, () => stage.commit(capability, request)),
                    status: (capability, request) => gate(request.signal, () => stage.status(capability, request)),
                    discard: (capability, request) => gate(request.signal, () => stage.discard(capability, request)),
                    acknowledge: (capability, request) => gate(request.signal, () => stage.acknowledge(capability, request)),
                }, {
                    isTrustedSender,
                    isPrivateContext: options.isPrivateContext,
                    onCommitted: () => {
                        try { void options.runtime.sendMessage({type: MATERIAL_CHANGED_MESSAGE}).catch(() => undefined); }
                        catch { /* 通知失败不改变已提交的事务。 */ }
                    },
                });
            } catch {
                try { service?.close(); } catch { /* 尽力释放初始化失败的服务。 */ }
                service = undefined;
                try { port.disconnect(); } catch { /* 端口可能已经关闭。 */ }
                return;
            }
        }
        bridge.attach(port);
    };
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        cleanupController.abort();
        try { options.runtime.onConnect.removeListener(onConnect); }
        finally {
            try { bridge?.dispose(); }
            finally {
                try { service?.close(); }
                finally { installed.delete(options.runtime); }
            }
        }
    };
    options.runtime.onConnect.addListener(onConnect);
    installed.set(options.runtime, dispose);
    return dispose;
}

/** 浏览器 composition root，数据库只会在可信连接后构造。 */
export function installBrowserMaterialImportRuntime(ready: Promise<unknown>): void {
    installMaterialImportRuntime({
        runtime: browser.runtime as unknown as Runtime,
        isPrivateContext: () => browser.extension.inIncognitoContext === true,
        ready,
        createStage: () => {
            const database = new MaterialDatabase();
            try { return {stage: createStage(database), close: () => database.close()}; }
            catch (error) { database.close(); throw error; }
        },
    });
}
