/**
 * @file src/services/config/autoBackupStore.ts
 * 文件职责：在配置 store 与后台加密 IndexedDB 之间持久化自动备份，并为设置页提供订阅、捕获和安全恢复入口。
 * 主要内容：按端口原子能力初始化备份基线，保留回读和写入期间的外部更新，串行捕获最多十份快照，统一隔离初次回放与后续通知中的监听者异常和快照修改，并优先通过后台消息恢复后返回最新历史状态。
 * 模块边界：本文件编排存储和跨上下文通信，不定义快照领域规则或定时周期；纯状态转换位于 autoBackup，alarm 调度位于 app/background runtime。
 */
import {configStorage as storage} from '@/src/platform/storage/configStorageRuntime';
import {
    appendConfigAutoBackup,
    cloneConfigAutoBackups,
    createBaselineConfigAutoBackups,
    findConfigAutoBackup,
    parseConfigAutoBackups,
    restoreRestorableConfig,
    serializeConfigAutoBackups,
    type ConfigAutoBackupState,
} from './autoBackup';
import {
    config,
    configHistoryReady,
    configReady,
    getConfigHistorySnapshot,
    saveConfig,
    type ConfigHistoryState,
} from './store';

export const CONFIG_AUTO_BACKUP_STORAGE_KEY = 'local:configAutoBackups' as const;
export const CONFIG_AUTO_BACKUP_RESTORE_MESSAGE = 'configAutoBackupRestore' as const;

export interface CaptureConfigAutoBackupOptions {
    config?: unknown;
    savedAt?: string;
}

export interface ConfigAutoBackupRestoreResult {
    backups: ConfigAutoBackupState;
    history: ConfigHistoryState;
}

type ConfigAutoBackupListener = (nextBackups: ConfigAutoBackupState) => void;
type ConfigAutoBackupMessageResponse = {
    success?: boolean;
    error?: string;
    result?: ConfigAutoBackupRestoreResult;
} | undefined;
type ConfigAutoBackupMessageSender = (message: {
    type: typeof CONFIG_AUTO_BACKUP_RESTORE_MESSAGE;
    version: number;
}) => Promise<ConfigAutoBackupMessageResponse>;

const listeners = new Set<ConfigAutoBackupListener>();
let backupState: ConfigAutoBackupState;
let initialized = false;
let lastSerialized = '';
let storedChangeRevision = 0;
let pendingWrite: {serialized: string; revision: number} | undefined;
let writeQueue: Promise<void> = Promise.resolve();
let captureQueue: Promise<void> = Promise.resolve();

function notifyListener(listener: ConfigAutoBackupListener, snapshot: ConfigAutoBackupState): void {
    try {listener(snapshot);}
    catch (error) {console.warn('[FluentRead] 自动配置备份订阅通知失败', error);}
}

function notifyListeners(): void {
    const snapshot = cloneConfigAutoBackups(backupState);
    listeners.forEach((listener) => notifyListener(listener, cloneConfigAutoBackups(snapshot)));
}

function setBackupState(nextState: ConfigAutoBackupState, notify = true): void {
    const next = cloneConfigAutoBackups(nextState);
    const serialized = serializeConfigAutoBackups(next);
    const changed = serialized !== lastSerialized;
    backupState = next;
    lastSerialized = serialized;
    if (notify && changed) notifyListeners();
}

function handleStoredBackupsChange(value: unknown): void {
    const parsed = parseConfigAutoBackups(value);
    if (!parsed) return;
    const serialized = serializeConfigAutoBackups(parsed);
    // GM setItem 完成后会回声通知旧写入。已有不同的外部 watch 时，
    // 不能让该回声或 await 后的内存安装撤销较新的观察结果。
    if (pendingWrite?.serialized === serialized) {
        if (pendingWrite.revision === storedChangeRevision) setBackupState(parsed);
        return;
    }
    storedChangeRevision += 1;
    if (serialized === lastSerialized) return;
    setBackupState(parsed);
}

storage.watch(CONFIG_AUTO_BACKUP_STORAGE_KEY, handleStoredBackupsChange);

async function persistBackupState(nextState: ConfigAutoBackupState): Promise<void> {
    const next = cloneConfigAutoBackups(nextState);
    writeQueue = writeQueue
        .catch(() => undefined)
        .then(async () => {
            const revision = storedChangeRevision;
            pendingWrite = {serialized: serializeConfigAutoBackups(next), revision};
            try {
                await storage.setItem<ConfigAutoBackupState>(CONFIG_AUTO_BACKUP_STORAGE_KEY, next);
                if (revision === storedChangeRevision) setBackupState(next);
            } finally {
                pendingWrite = undefined;
            }
        });
    await writeQueue;
}

async function initializeConfigAutoBackups(): Promise<void> {
    const initialRevision = storedChangeRevision;
    try {
        await configReady;
        const stored = await storage.getItem<unknown>(CONFIG_AUTO_BACKUP_STORAGE_KEY);
        // 初始回读期间的 watch 已提供较新的权威快照，不能再采用旧读结果，
        // 更不能把旧投影迁移写回存储，覆盖外部已提交的时间检查点。
        if (backupState && storedChangeRevision !== initialRevision) {
            initialized = true;
            return;
        }
        const parsed = parseConfigAutoBackups(stored);
        if (parsed) {
            initialized = true;
            setBackupState(parsed);
            // 有原子条件提交才自动清理旧存储；GM 等 get/set-only 端口
            // 保留脱敏内存投影，等显式捕获再持久化，避免迟到迁移覆盖新值。
            if (storage.setItemIfUnchanged && JSON.stringify(stored) !== serializeConfigAutoBackups(parsed)) {
                try {
                    const written = await storage.setItemIfUnchanged(CONFIG_AUTO_BACKUP_STORAGE_KEY, stored, parsed);
                    if (!written) {
                        const revision = storedChangeRevision;
                        const latest = parseConfigAutoBackups(await storage.getItem(CONFIG_AUTO_BACKUP_STORAGE_KEY));
                        if (latest && revision === storedChangeRevision) setBackupState(latest);
                    }
                } catch (error) {
                    console.warn('[FluentRead] 自动配置备份可恢复投影迁移暂未落盘', error);
                }
            }
            return;
        }

        const baseline = createBaselineConfigAutoBackups(config);
        if (storage.setItemIfUnchanged) {
            const written = await storage.setItemIfUnchanged(CONFIG_AUTO_BACKUP_STORAGE_KEY, stored, baseline);
            if (!written) {
                // 真实后台在密文加密期间也可能收到另一个写入；失败的条件提交
                // 不写任何数据。watch 已安装状态时直接沿用，否则重新读取胜出值。
                if (!backupState) {
                    const latest = parseConfigAutoBackups(await storage.getItem(CONFIG_AUTO_BACKUP_STORAGE_KEY));
                    if (!backupState) setBackupState(latest || baseline);
                }
                initialized = true;
                return;
            }
        }
        // 无 CAS 时自动初始化只建立可用内存基线；普通 get/set 或重读
        // 无法保障跨上下文原子性，不能自动发出可能覆盖较新快照的写入。
        initialized = true;
        if (!backupState || storedChangeRevision === initialRevision) setBackupState(baseline);
    } catch (error) {
        initialized = true;
        if (!backupState) setBackupState(createBaselineConfigAutoBackups(config));
        console.error('[FluentRead] 自动配置备份初始读取失败，保留可用备份状态', error);
    }
}

export const configAutoBackupsReady = initializeConfigAutoBackups();

export function getConfigAutoBackupsSnapshot(): ConfigAutoBackupState {
    return cloneConfigAutoBackups(backupState || createBaselineConfigAutoBackups(config));
}

export function subscribeConfigAutoBackups(listener: ConfigAutoBackupListener): () => void {
    listeners.add(listener);
    if (initialized && backupState) notifyListener(listener, getConfigAutoBackupsSnapshot());
    return () => listeners.delete(listener);
}

/** 串行捕获时间检查点，保证重叠 alarm 不会复用 version 或丢失其中一份。 */
export function captureConfigAutoBackup(
    options: CaptureConfigAutoBackupOptions = {},
): Promise<ConfigAutoBackupState> {
    const capture = captureQueue
        .catch(() => undefined)
        .then(async () => {
            await configAutoBackupsReady;
            const next = appendConfigAutoBackup(
                backupState,
                options.config === undefined ? config : options.config,
                options.savedAt,
            );
            await persistBackupState(next);
            return getConfigAutoBackupsSnapshot();
        });
    captureQueue = capture.then(() => undefined, () => undefined);
    return capture;
}

export async function restoreConfigAutoBackup(version: number): Promise<ConfigAutoBackupRestoreResult> {
    await Promise.all([configAutoBackupsReady, configHistoryReady]);
    const entry = findConfigAutoBackup(backupState, version);
    if (!entry) throw new Error(`自动备份 v${version} 不存在`);

    const restored = restoreRestorableConfig(entry.config, config);
    await saveConfig(restored, {recordHistory: true, immediateHistory: true});
    return {
        backups: getConfigAutoBackupsSnapshot(),
        history: getConfigHistorySnapshot(),
    };
}

export async function requestConfigAutoBackupRestore(
    version: number,
    sendMessage?: ConfigAutoBackupMessageSender,
): Promise<ConfigAutoBackupRestoreResult> {
    if (!sendMessage) return restoreConfigAutoBackup(version);

    let response: ConfigAutoBackupMessageResponse;
    try {
        response = await sendMessage({
            type: CONFIG_AUTO_BACKUP_RESTORE_MESSAGE,
            version,
        });
    } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('Receiving end')) throw error;
        return restoreConfigAutoBackup(version);
    }
    if (response?.success === false) throw new Error(response.error || '自动配置备份恢复失败');
    if (!response?.result) throw new Error('自动配置备份恢复没有返回结果');
    return response.result;
}
