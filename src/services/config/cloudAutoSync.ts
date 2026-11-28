/**
 * @file src/services/config/cloudAutoSync.ts
 * 文件职责：为非交互式云备份后端提供默认关闭的定时自动同步调度与无损三方合并守护。
 * 主要内容：支持可配置同步周期、MV3 闹钟注册与注销、与手动预览事务串行互斥、离线跳过、指数退避重试，以及遇冲突或自定义口令未解锁时暂停写入并记录待用户审阅状态。
 * 模块边界：通过依赖注入消费云同步端口、口令解析器与闹钟接口，不直接访问浏览器全局对象、凭据存储或网络实现。
 */
import {CloudSyncError} from '@/src/core/config/cloudSync';
import {DEFAULT_LEARNING_SYNC_SCOPE, normalizeLearningSyncScope, type LearningSyncScope} from '@/src/core/config/learningSync';
import {DriveEncryptionError} from '@/src/platform/google-drive/encryption';
import type {ConfigStoragePort} from '@/src/platform/storage/configStorage';
import type {ResolvedCloudPassphrase} from './cloudPassphraseStore';
import type {DriveSyncDirection, DriveSyncPreview, DriveSyncStatus, RemoteSyncCommitOptions, RemoteSyncPrepareOptions} from './remoteConfigSync';

export const CLOUD_AUTO_SYNC_ALARM = 'fluentread-cloud-auto-sync' as const;
export const CLOUD_AUTO_SYNC_STATE_KEY = 'local:cloudAutoSyncState' as const;
export const CLOUD_AUTO_SYNC_CLIENT_ID = 'cloud-auto-sync-scheduler' as const;
export const CLOUD_AUTO_SYNC_INTERVALS = [30, 60, 360, 1440] as const;
export type CloudAutoSyncIntervalMinutes = (typeof CLOUD_AUTO_SYNC_INTERVALS)[number];
export type CloudAutoSyncRunState = 'idle' | 'synced' | 'conflict' | 'passphrase-locked' | 'offline' | 'error';

export interface CloudAutoSyncSettings {
    enabled: boolean;
    intervalMinutes: CloudAutoSyncIntervalMinutes;
    includeSensitive: boolean;
    learningScope: LearningSyncScope;
}

export interface CloudAutoSyncStatus extends CloudAutoSyncSettings {
    state: CloudAutoSyncRunState;
    lastAttemptAt: number | null;
    lastSyncedAt: number | null;
    nextRetryAt: number | null;
    consecutiveFailures: number;
    conflictCount: number;
    lastErrorKey?: string;
}

export interface CloudAutoSyncConfigPatch {
    enabled?: boolean;
    intervalMinutes?: CloudAutoSyncIntervalMinutes;
    includeSensitive?: boolean;
    learningScope?: Partial<LearningSyncScope>;
}

export interface CloudAutoSyncAlarmApi {
    onAlarm: {
        addListener(listener: (alarm: {name: string}) => void): void;
    };
    get(name: string): Promise<{name: string; periodInMinutes?: number} | undefined>;
    create(name: string, info: {delayInMinutes: number; periodInMinutes: number}): void | Promise<void>;
    clear(name: string): Promise<boolean> | void;
}

export interface CloudAutoSyncPorts {
    storage: Pick<ConfigStoragePort, 'getItem' | 'setItem'>;
    alarms?: CloudAutoSyncAlarmApi;
    isAvailable(): Promise<boolean>;
    resolvePassphrase(): Promise<ResolvedCloudPassphrase>;
    prepare(passphrase: string, includeSensitive: boolean, options: RemoteSyncPrepareOptions): Promise<DriveSyncPreview>;
    commit(id: string, passphrase: string, direction: DriveSyncDirection, choices: Record<string, unknown>, options: RemoteSyncCommitOptions): Promise<DriveSyncStatus>;
    cancel(id?: string): Promise<void>;
    isOnline(): boolean;
    now(): number;
}

const MAX_BACKOFF_MS = 24 * 60 * 60_000;

export function isValidAutoSyncInterval(value: unknown): value is CloudAutoSyncIntervalMinutes {
    return typeof value === 'number' && (CLOUD_AUTO_SYNC_INTERVALS as readonly number[]).includes(value);
}

function defaultStatus(): CloudAutoSyncStatus {
    return {
        enabled: false,
        intervalMinutes: 60,
        includeSensitive: false,
        learningScope: {...DEFAULT_LEARNING_SYNC_SCOPE},
        state: 'idle',
        lastAttemptAt: null,
        lastSyncedAt: null,
        nextRetryAt: null,
        consecutiveFailures: 0,
        conflictCount: 0,
    };
}

function readStoredStatus(raw: unknown): CloudAutoSyncStatus {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultStatus();
    const record = raw as Partial<CloudAutoSyncStatus>;
    const validStates: readonly CloudAutoSyncRunState[] = ['idle', 'synced', 'conflict', 'passphrase-locked', 'offline', 'error'];
    const state = validStates.includes(record.state as CloudAutoSyncRunState) ? record.state as CloudAutoSyncRunState : 'idle';
    let learningScope = {...DEFAULT_LEARNING_SYNC_SCOPE};
    try {learningScope = normalizeLearningSyncScope(record.learningScope);} catch {learningScope = {...DEFAULT_LEARNING_SYNC_SCOPE};}
    return {
        enabled: record.enabled === true,
        intervalMinutes: isValidAutoSyncInterval(record.intervalMinutes) ? record.intervalMinutes : 60,
        includeSensitive: record.includeSensitive === true,
        learningScope,
        state,
        lastAttemptAt: typeof record.lastAttemptAt === 'number' && Number.isFinite(record.lastAttemptAt) ? record.lastAttemptAt : null,
        lastSyncedAt: typeof record.lastSyncedAt === 'number' && Number.isFinite(record.lastSyncedAt) ? record.lastSyncedAt : null,
        nextRetryAt: typeof record.nextRetryAt === 'number' && Number.isFinite(record.nextRetryAt) ? record.nextRetryAt : null,
        consecutiveFailures: typeof record.consecutiveFailures === 'number' && Number.isSafeInteger(record.consecutiveFailures) && record.consecutiveFailures >= 0 ? record.consecutiveFailures : 0,
        conflictCount: typeof record.conflictCount === 'number' && Number.isSafeInteger(record.conflictCount) && record.conflictCount >= 0 ? record.conflictCount : 0,
        ...(typeof record.lastErrorKey === 'string' && record.lastErrorKey ? {lastErrorKey: record.lastErrorKey} : {}),
    };
}

export function createCloudAutoSync(ports: CloudAutoSyncPorts) {
    let queue: Promise<unknown> = Promise.resolve();
    function exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const result = queue.then(operation);
        queue = result.catch(() => undefined);
        return result;
    }

    async function load(): Promise<CloudAutoSyncStatus> {
        return readStoredStatus(await ports.storage.getItem(CLOUD_AUTO_SYNC_STATE_KEY));
    }

    async function save(next: CloudAutoSyncStatus): Promise<CloudAutoSyncStatus> {
        await ports.storage.setItem(CLOUD_AUTO_SYNC_STATE_KEY, next);
        return next;
    }

    async function syncAlarm(current: CloudAutoSyncStatus): Promise<void> {
        if (!ports.alarms) return;
        if (!current.enabled) {
            await ports.alarms.clear(CLOUD_AUTO_SYNC_ALARM);
            return;
        }
        await ports.alarms.create(CLOUD_AUTO_SYNC_ALARM, {
            delayInMinutes: current.intervalMinutes,
            periodInMinutes: current.intervalMinutes,
        });
    }

    async function configure(patch: CloudAutoSyncConfigPatch): Promise<CloudAutoSyncStatus> {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            throw new CloudSyncError('自动同步设置无效');
        }
        if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
            throw new CloudSyncError('自动同步开关必须为布尔值');
        }
        if (patch.intervalMinutes !== undefined && !isValidAutoSyncInterval(patch.intervalMinutes)) {
            throw new CloudSyncError('不支持的自动同步周期');
        }
        if (patch.includeSensitive !== undefined && typeof patch.includeSensitive !== 'boolean') {
            throw new CloudSyncError('敏感配置自动同步选项必须为布尔值');
        }
        const current = await load();
        const learningScope = patch.learningScope !== undefined
            ? normalizeLearningSyncScope({...current.learningScope, ...patch.learningScope})
            : current.learningScope;
        const enabled = patch.enabled ?? current.enabled;
        const intervalMinutes = patch.intervalMinutes ?? current.intervalMinutes;
        const includeSensitive = patch.includeSensitive ?? current.includeSensitive;
        const next: CloudAutoSyncStatus = {
            ...current,
            enabled,
            intervalMinutes,
            includeSensitive,
            learningScope,
            ...(!enabled ? {state: 'idle' as const, nextRetryAt: null, consecutiveFailures: 0, conflictCount: 0} : {nextRetryAt: null}),
        };
        if (!enabled) delete next.lastErrorKey;
        await save(next);
        await syncAlarm(next);
        return next;
    }

    async function safeCancel(id: string): Promise<void> {
        try {await ports.cancel(id);} catch { /* 清理失败不影响状态记录。 */ }
    }

    async function runOnce(options: {force?: boolean; signal?: AbortSignal} = {}): Promise<CloudAutoSyncStatus> {
        const current = await load();
        const now = ports.now();
        if (!current.enabled && !options.force) return current;
        if (options.signal?.aborted) return current;
        if (!options.force && (current.state === 'passphrase-locked' || current.state === 'conflict')) return current;
        if (!options.force && current.nextRetryAt !== null && now < current.nextRetryAt) return current;
        if (!ports.isOnline()) {
            const offline: CloudAutoSyncStatus = {...current, state: 'offline', lastAttemptAt: now};
            return save(offline);
        }
        if (!await ports.isAvailable()) {
            const idle: CloudAutoSyncStatus = {...current, state: 'idle', lastAttemptAt: now};
            return save(idle);
        }
        let resolved: ResolvedCloudPassphrase;
        try {
            resolved = await ports.resolvePassphrase();
        } catch (error) {
            if (error instanceof DriveEncryptionError && (error.code === 'passphrase-required' || error.code === 'invalid-passphrase')) {
                return save({
                    ...current,
                    state: 'passphrase-locked',
                    lastAttemptAt: now,
                    lastErrorKey: 'settings.cloud.e2ee.passphraseRequired',
                });
            }
            throw error;
        }
        if (options.signal?.aborted) return current;

        let preview: DriveSyncPreview | null = null;
        try {
            preview = await ports.prepare(resolved.passphrase, current.includeSensitive, {
                keyMode: resolved.keyMode,
                legacyPassphrase: resolved.legacyPassphrase,
                learningScope: current.learningScope,
                interactive: false,
            });
            if (options.signal?.aborted) {
                await safeCancel(preview.id);
                return current;
            }
            const commitOptions: RemoteSyncCommitOptions = {
                keyMode: resolved.keyMode,
                legacyPassphrase: resolved.legacyPassphrase,
            };
            if (!preview.hasRemote) {
                await ports.commit(preview.id, resolved.passphrase, 'upload', {}, commitOptions);
            } else {
                const configConflicts = preview.changes.filter(change => change.conflict || change.recommended === null);
                const missingBaselineConflict = !preview.hasBaseline && (
                    preview.changes.length > 0
                    || preview.includeSensitive !== preview.remoteIncludesSensitive
                );
                const readOnlyUploadNeeded = preview.canUpload === false && (
                    preview.changes.some(change => change.recommended === 'local')
                    || Boolean(preview.learningSummary?.hasAnyChanges)
                    || (preview.keyMode === 'custom' && preview.remoteKeyMode === 'app')
                );
                if (missingBaselineConflict || configConflicts.length > 0 || readOnlyUploadNeeded) {
                    const previewId = preview.id;
                    preview = null;
                    await safeCancel(previewId);
                    return save({
                        ...current,
                        state: 'conflict',
                        lastAttemptAt: now,
                        conflictCount: Math.max(1, configConflicts.length),
                        lastErrorKey: 'settings.cloud.autoSync.statusConflict',
                    });
                }
                const choices = Object.fromEntries(
                    preview.changes.map(change => [change.id, change.recommended!]),
                );
                const direction: DriveSyncDirection = preview.canUpload === false ? 'download' : 'merge';
                await ports.commit(preview.id, resolved.passphrase, direction, choices, commitOptions);
            }
            preview = null;
            const synced: CloudAutoSyncStatus = {
                ...current,
                state: 'synced',
                lastAttemptAt: now,
                lastSyncedAt: now,
                nextRetryAt: null,
                consecutiveFailures: 0,
                conflictCount: 0,
            };
            delete synced.lastErrorKey;
            return save(synced);
        } catch (error) {
            if (preview) await safeCancel(preview.id);
            if (error instanceof DriveEncryptionError && (error.code === 'passphrase-required' || error.code === 'wrong-passphrase')) {
                return save({
                    ...current,
                    state: 'passphrase-locked',
                    lastAttemptAt: now,
                    lastErrorKey: error.code === 'wrong-passphrase'
                        ? 'settings.cloud.e2ee.wrongPassphrase'
                        : 'settings.cloud.e2ee.passphraseRequired',
                });
            }
            if (error instanceof CloudSyncError && error.message.includes('另一个设置页面正在确认同步')) {
                return current;
            }
            const failures = current.consecutiveFailures + 1;
            const backoffMs = Math.min(current.intervalMinutes * 60_000 * (2 ** (failures - 1)), MAX_BACKOFF_MS);
            return save({
                ...current,
                state: 'error',
                lastAttemptAt: now,
                consecutiveFailures: failures,
                nextRetryAt: now + backoffMs,
                lastErrorKey: 'settings.cloud.autoSync.statusError',
            });
        }
    }

    async function resetAfterManualSync(syncedAt?: number): Promise<CloudAutoSyncStatus> {
        const current = await load();
        const now = syncedAt ?? ports.now();
        const next: CloudAutoSyncStatus = {
            ...current,
            state: current.enabled ? 'synced' : 'idle',
            lastSyncedAt: now,
            nextRetryAt: null,
            consecutiveFailures: 0,
            conflictCount: 0,
        };
        delete next.lastErrorKey;
        return save(next);
    }

    async function notifyPassphraseChanged(): Promise<CloudAutoSyncStatus> {
        const current = await load();
        if (current.state !== 'passphrase-locked') return current;
        const next: CloudAutoSyncStatus = {
            ...current,
            state: 'idle',
            nextRetryAt: null,
            consecutiveFailures: 0,
        };
        delete next.lastErrorKey;
        return save(next);
    }

    function install(): Promise<void> {
        ports.alarms?.onAlarm.addListener(alarm => {
            if (alarm.name !== CLOUD_AUTO_SYNC_ALARM) return;
            void exclusive(() => runOnce()).catch(() => undefined);
        });
        return exclusive(async () => {
            const current = await load();
            if (!ports.alarms) return;
            if (!current.enabled) {
                await ports.alarms.clear(CLOUD_AUTO_SYNC_ALARM);
                return;
            }
            const existing = await ports.alarms.get(CLOUD_AUTO_SYNC_ALARM);
            if (!existing || (existing.periodInMinutes !== undefined && existing.periodInMinutes !== current.intervalMinutes)) {
                await syncAlarm(current);
            }
        });
    }

    return {
        status: () => exclusive(load),
        configure: (patch: CloudAutoSyncConfigPatch) => exclusive(() => configure(patch)),
        runNow: (signal?: AbortSignal) => exclusive(() => runOnce({force: true, signal})),
        runScheduled: (signal?: AbortSignal) => exclusive(() => runOnce({force: false, signal})),
        resetAfterManualSync: (syncedAt?: number) => exclusive(() => resetAfterManualSync(syncedAt)),
        notifyPassphraseChanged: () => exclusive(notifyPassphraseChanged),
        install,
    };
}
