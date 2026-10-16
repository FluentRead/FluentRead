/**
 * @file src/app/background/configStorageBroadcast.ts
 *
 * 文件职责：把后台加密配置仓库的键级变化通知给已打开的扩展页面和网页 content，使各上下文重新向后台拉取授权后的明文快照。
 * 主要内容：监听配置、凭据、历史、备份与 OCR 元数据键，向 extension runtime 广播无值通知，通过共享网页接收者端口投递主配置与阅读模型失效事件并兼容旧适配器；凭据比较仅在后台进行，安装或解绑失败保留清理错误。
 * 模块边界：本文件不携带配置值、不判断凭据读取权限、不写 IndexedDB；读取授权由 configStorage handler 承担，运行时装配由 messageRuntime 调用。
 */

import {
    CONFIG_INDEXED_DB_KEYS,
    CONFIG_STORAGE_CHANGED_MESSAGE,
    type ConfigStoragePort,
} from '@/src/platform/storage/configStorage';
import {config} from '@/src/services/config/store';
import {normalizeConfig} from '@/src/core/config/model';
import {extractConfigCredentials, mergeConfigCredentials, parseStoredCredentials} from '@/src/core/config/credentials';
import {getHarnessModelCacheKey} from '@/src/core/config/harness';

export interface ConfigStorageBroadcastRuntime {
    broadcastTabMessage?(message: unknown, signal?: AbortSignal): Promise<void>;
    sendRuntimeMessage(message: unknown): Promise<unknown>;
    queryTabs(): Promise<Array<{id?: number}>>;
    sendTabMessage(tabId: number, message: unknown): Promise<unknown>;
    warn(message: string, error: unknown): void;
}

export function installConfigStorageBroadcast(
    storage: ConfigStoragePort,
    runtime: ConfigStorageBroadcastRuntime,
): () => void {
    let disposed = false;
    const lifetime = new AbortController();
    const unsubscribers: Array<() => void> = [];
    const dispose = () => {
        disposed = true;
        lifetime.abort();
        const errors: unknown[] = [];
        // 成功解绑的句柄不再执行；失败句柄留给下一次 dispose 重试。
        for (const unsubscribe of unsubscribers.splice(0)) {
            try {unsubscribe();}
            catch (error) {unsubscribers.push(unsubscribe); errors.push(error);}
        }
        if (errors.length) throw new AggregateError(errors, '配置变化广播订阅解绑失败');
    };
    try {
        for (const key of CONFIG_INDEXED_DB_KEYS) {
            unsubscribers.push(storage.watch(key, (value, previousValue) => {
                if (disposed) return;
                const message = {type: CONFIG_STORAGE_CHANGED_MESSAGE, key};
                void runtime.sendRuntimeMessage(message).catch(error => {
                    // 没有打开的扩展页面时 Chrome 会报告 Receiving end；这是正常空广播。
                    if (!(error instanceof Error) || !error.message.includes('Receiving end')) {
                        runtime.warn('[FluentRead] 扩展配置变化广播失败', error);
                    }
                });
                let tabMessage: unknown = message;
                if (key !== 'local:config') {
                    if (key !== 'local:credentials' && key !== 'session:credentials') return;
                    // 专用凭据不会进入 content 快照。复用真实模型输入投影在后台比较，
                    // 只广播无值事件，删除或无效记录与 store 的空凭据语义一致。
                    if (getHarnessModelCacheKey(normalizeConfig(mergeConfigCredentials(
                        config, parseStoredCredentials(value) || extractConfigCredentials({}),
                    ))) === getHarnessModelCacheKey(normalizeConfig(mergeConfigCredentials(
                        config, parseStoredCredentials(previousValue) || extractConfigCredentials({}),
                    )))) return;
                    tabMessage = {type: 'fluentReadReadingModelInputsChanged'};
                }
                if (runtime.broadcastTabMessage) {
                    void runtime.broadcastTabMessage(tabMessage, lifetime.signal)
                        .catch(error => runtime.warn('[FluentRead] 网页配置变化广播失败', error));
                    return;
                }
                void runtime.queryTabs().then(tabs => disposed ? undefined : Promise.all(tabs.map(tab => (
                    typeof tab.id === 'number'
                        ? runtime.sendTabMessage(tab.id, tabMessage).catch(() => undefined)
                        : Promise.resolve()
                )))).catch(error => runtime.warn('[FluentRead] 网页配置变化广播失败', error));
            }));
        }
    } catch (error) {
        try {dispose();}
        catch (cleanupError) {
            throw new AggregateError([error, cleanupError], '配置变化广播安装与订阅回收失败');
        }
        throw error;
    }
    return dispose;
}
