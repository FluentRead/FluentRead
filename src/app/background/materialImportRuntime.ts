/**
 * @file src/app/background/materialImportRuntime.ts
 * 文件职责：组装学习材料分片恢复端口的后台边界。
 * 主要内容：校验设置页来源和隐私上下文，按需创建暂存服务、广播材料变更，并安排恢复暂存的周期清理。
 * 模块边界：只在本地保存清理标记，不读取文件、不管理界面，也不改变恢复容量策略。
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
    onStartup?: {addListener(listener: () => void): void; removeListener(listener: () => void): void};
    onInstalled?: {addListener(listener: () => void): void; removeListener(listener: () => void): void};
    onConnect: {
        addListener(listener: (port: MaterialImportPort) => void): void;
        removeListener(listener: (port: MaterialImportPort) => void): void;
    };
    sendMessage(message: unknown): Promise<unknown>;
};
type Service = {stage: ReturnType<typeof createStage>; close(): void};
type Maintenance = {
    alarms: {
        onAlarm: {addListener(listener: (alarm: {name: string}) => void): void; removeListener(listener: (alarm: {name: string}) => void): void};
        get(name: string): Promise<{periodInMinutes?: number} | undefined>;
        create(name: string, options: {periodInMinutes: number}): Promise<void>;
    };
    storage: {get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void>};
    warn(message: string): void;
};
type Options = {runtime: Runtime; isPrivateContext(): boolean; createStage(): Service; ready: Promise<unknown>; maintenance?: Maintenance};
export const MATERIAL_IMPORT_CLEANUP_ALARM = 'fluentread-material-import-cleanup';
const MAINTENANCE_MARKER = 'fluentreadMaterialImportMaintenance';
const MAINTENANCE_PERIOD_MINUTES = 60;
const MAX_MAINTENANCE_OPERATIONS = 8;
const installed = new WeakMap<Runtime, () => void>();

/** 同步安装监听；首次可信恢复后按本地标记恢复周期维护。 */
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
    const ensureService = (): Service => service ??= options.createStage();
    const runCleanup = (stage: Service['stage']): Promise<unknown> => {
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
        return cleanup;
    };
    const maintenance = options.maintenance;
    let scheduled: Promise<void> = Promise.resolve(), maintenanceAvailable = false, scheduledCount = 0, warnedBackpressure = false;
    const warnMaintenance = (error?: unknown) => {
        if (error instanceof Error && error.name === 'MaterialMaintenanceBusyError') {
            if (warnedBackpressure) return;
            warnedBackpressure = true;
        }
        try {maintenance?.warn('[FluentRead] 材料恢复暂存清理失败，将在下次维护时重试');} catch {/* 诊断不可改变清理状态。 */}
    };
    const serialize = <T>(task: () => Promise<T>): Promise<T> => {
        if (scheduledCount >= MAX_MAINTENANCE_OPERATIONS) return Promise.reject(Object.assign(Error('maintenance busy'), {name: 'MaterialMaintenanceBusyError'}));
        scheduledCount++;
        const result = scheduled.then(task);
        const release = () => {scheduledCount--; if (scheduledCount < MAX_MAINTENANCE_OPERATIONS) warnedBackpressure = false;};
        scheduled = result.then(release, release); return result;
    };
    const bounded = async <T>(work: Promise<T>): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {return await Promise.race([work, new Promise<never>((_, reject) => {timer = setTimeout(() => reject(Error('maintenance timeout')), 30_000);})]);}
        finally {if (timer !== undefined) clearTimeout(timer);}
    };
    // 修改扩展持久状态的请求即使等待方超时或取消也可能迟到生效；
    // 排程串行租约须一直持有到真实 Promise 结束，避免旧操作覆盖新计划。
    const mutation = async <T>(work: Promise<T>): Promise<T> => {
        const timer = setTimeout(warnMaintenance, 30_000);
        try {return await work;} finally {clearTimeout(timer);}
    };
    const schedule = async (): Promise<void> => {
        const existing = await bounded(Promise.resolve().then(() => maintenance!.alarms.get(MATERIAL_IMPORT_CLEANUP_ALARM)));
        if (!existing || existing.periodInMinutes !== MAINTENANCE_PERIOD_MINUTES)
            await mutation(Promise.resolve().then(() => maintenance!.alarms.create(MATERIAL_IMPORT_CLEANUP_ALARM, {periodInMinutes: MAINTENANCE_PERIOD_MINUTES})));
    };
    const prepareMaintenance = (signal?: AbortSignal): Promise<void> => serialize(async () => {
        assertAvailable(signal);
        if (!maintenanceAvailable) throw Error('maintenance unavailable');
        // 标记必须先于恢复事务持久化，alarm 失败时禁止开始写入。
        await mutation(Promise.resolve().then(() => maintenance!.storage.set({[MAINTENANCE_MARKER]: true})));
        assertAvailable(signal); await schedule(); assertAvailable(signal);
    });
    const maintain = async (): Promise<void> => {
        assertAvailable();
        const marker = await bounded(Promise.resolve().then(() => maintenance!.storage.get(MAINTENANCE_MARKER)));
        if (marker[MAINTENANCE_MARKER] !== true) return;
        // 标记与同一周期 alarm 只创建、不删除，避免旧 worker 的迟到操作撤销新会话的计划。
        await schedule();
        await waitReady(); assertAvailable();
        await runCleanup(ensureService().stage);
    };
    const onAlarm = (alarm: {name: string}) => {
        if (!maintenance || alarm.name !== MATERIAL_IMPORT_CLEANUP_ALARM || disposed) return;
        try {if (options.isPrivateContext()) return;} catch {return;}
        void serialize(maintain).catch(warnMaintenance);
    };
    const onStartup = () => {
        if (!maintenanceAvailable || disposed) return;
        try {if (options.isPrivateContext()) return;} catch {return;}
        void serialize(maintain).catch(warnMaintenance);
    };
    if (maintenance) {
        try {
            maintenance.alarms.onAlarm.addListener(onAlarm);
            options.runtime.onStartup?.addListener(onStartup);
            options.runtime.onInstalled?.addListener(onStartup);
            maintenanceAvailable = true;
            if (!options.isPrivateContext()) void serialize(maintain).catch(warnMaintenance);
        } catch {warnMaintenance(); /* 无法安装监听时不得开始暂存。 */ }
    }
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
                service = ensureService();
                const stage = service.stage;
                const gate = async <T>(signal: AbortSignal | undefined, task: () => Promise<T>, needsCleanup = false): Promise<T> => {
                    await waitReady(signal);
                    assertAvailable(signal);
                    if (needsCleanup) {
                        await wait(runCleanup(stage), signal);
                        assertAvailable(signal);
                    }
                    return task();
                };
                bridge = makePortBridge({
                    ...stage,
                    beginRecoverable: (manifest, guard, capability, request) => gate(request.signal, async () => {
                        if (!maintenance) return stage.beginRecoverable(manifest, guard, capability, request);
                        try {await wait(prepareMaintenance(request.signal), request.signal);}
                        catch (error) {if (!request.signal?.aborted) warnMaintenance(error); throw error;}
                        assertAvailable(request.signal);
                        return stage.beginRecoverable(manifest, guard, capability, request);
                    }, true),
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
        try {maintenance?.alarms.onAlarm.removeListener(onAlarm);} catch {/* 仍须释放端口和数据库。 */}
        try {options.runtime.onStartup?.removeListener(onStartup);} catch {/* 继续释放其他资源。 */}
        try {options.runtime.onInstalled?.removeListener(onStartup);} catch {/* 继续释放其他资源。 */}
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

/** 浏览器 composition root；仅可信恢复或已启用的维护会打开材料库。 */
export function installBrowserMaterialImportRuntime(ready: Promise<unknown>): void {
    installMaterialImportRuntime({
        runtime: browser.runtime as unknown as Runtime,
        isPrivateContext: () => browser.extension.inIncognitoContext === true,
        ready,
        maintenance: {
            alarms: browser.alarms as unknown as Maintenance['alarms'],
            storage: browser.storage.local as unknown as Maintenance['storage'],
            warn: message => console.warn(message),
        },
        createStage: () => {
            const database = new MaterialDatabase();
            try { return {stage: createStage(database), close: () => database.close()}; }
            catch (error) { database.close(); throw error; }
        },
    });
}
