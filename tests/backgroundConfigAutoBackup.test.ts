import {describe, expect, it, vi} from 'vitest';
import {installVocabularyUndoMaintenance, VOCABULARY_UNDO_ALARM} from '@/src/features/vocabulary/background/undoMaintenance';

describe('vocabulary undo expiry maintenance', () => {
    it('cleans at startup and its own alarm, never from unrelated alarms', async () => {
        let listener!: (alarm: {name:string}) => void;
        const create = vi.fn(); const prune = vi.fn(async () => undefined); const warn = vi.fn();
        installVocabularyUndoMaintenance({alarms:{onAlarm:{addListener: next => {listener = next;}},create},prune,warn});
        await vi.waitFor(() => expect(prune).toHaveBeenCalledOnce());
        expect(create).toHaveBeenCalledWith(VOCABULARY_UNDO_ALARM,{periodInMinutes:360});
        listener({name:'other'}); await Promise.resolve(); expect(prune).toHaveBeenCalledOnce();
        listener({name:VOCABULARY_UNDO_ALARM}); await vi.waitFor(() => expect(prune).toHaveBeenCalledTimes(2));
        expect(warn).not.toHaveBeenCalled();
    });
    it('reports fixed messages without including storage or scheduling errors', async () => {
        const warn = vi.fn();
        installVocabularyUndoMaintenance({alarms:{onAlarm:{addListener: () => {}},create: () => {throw new Error('private marker');}},
            prune: async () => {throw new Error('private marker');},warn});
        await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
        expect(JSON.stringify(warn.mock.calls)).not.toContain('private marker');
    });
});

import {
    CONFIG_AUTO_BACKUP_ALARM,
    CONFIG_AUTO_BACKUP_INTERVAL_MINUTES,
    installConfigAutoBackupRuntime,
    isConfigAutoBackupDue,
    type ConfigAutoBackupAlarm,
} from '@/src/app/background/configAutoBackupRuntime';
import {
    CONFIG_AUTO_BACKUP_RESTORE_MESSAGE_TYPE,
    createConfigAutoBackupRestoreHandler,
} from '@/src/app/background/handlers/configAutoBackup';
import {createBackgroundMessageRouter} from '@/src/services/messaging/backgroundRouter';
import {
    appendConfigAutoBackup,
    createBaselineConfigAutoBackups,
} from '@/src/services/config/autoBackup';

const baseConfig = {
    on: true,
    service: 'openai',
    from: 'auto',
    to: 'zh-Hans',
};

function createAlarmHarness(existing = false) {
    let listener: ((alarm: ConfigAutoBackupAlarm) => void) | undefined;
    return {
        api: {
            onAlarm: {
                addListener: vi.fn((nextListener: (alarm: ConfigAutoBackupAlarm) => void) => {
                    listener = nextListener;
                }),
            },
            get: vi.fn(async () => existing ? {name: CONFIG_AUTO_BACKUP_ALARM} : undefined),
            create: vi.fn(async () => undefined),
        },
        fire(name: string = CONFIG_AUTO_BACKUP_ALARM) {
            listener?.({name});
        },
    };
}

describe('background 自动配置备份', () => {
    it('恢复 handler 校验版本并返回 service 结果', async () => {
        const expected = {restored: 7};
        const restore = vi.fn(async () => expected);
        const router = createBackgroundMessageRouter([
            createConfigAutoBackupRestoreHandler(restore),
        ]);

        await expect(router.dispatch({
            type: CONFIG_AUTO_BACKUP_RESTORE_MESSAGE_TYPE,
            version: 7,
        }, undefined)).resolves.toEqual({
            handled: true,
            response: {success: true, result: expected},
        });
        expect(restore).toHaveBeenCalledWith(7);

        for (const version of [undefined, 0, -1, 1.5, Number.NaN, '7']) {
            await expect(router.dispatch({
                type: CONFIG_AUTO_BACKUP_RESTORE_MESSAGE_TYPE,
                version,
            }, undefined)).resolves.toEqual({
                handled: true,
                response: {success: false, error: '无效的自动配置备份版本'},
            });
        }
        expect(restore).toHaveBeenCalledOnce();
    });

    it('当前基线未到六小时时只安装持久化 alarm，不额外捕获', async () => {
        const now = Date.parse('2026-08-25T12:00:00.000Z');
        let state = createBaselineConfigAutoBackups(baseConfig, new Date(now).toISOString());
        const alarms = createAlarmHarness(false);
        const capture = vi.fn(async ({savedAt}: {savedAt: string}) => {
            state = appendConfigAutoBackup(state, baseConfig, savedAt);
            return state;
        });

        const installed = installConfigAutoBackupRuntime({
            alarms: alarms.api,
            ready: Promise.resolve(),
            getSnapshot: () => state,
            capture,
            now: () => now,
            warn: vi.fn(),
        });
        await installed.ready;

        expect(capture).not.toHaveBeenCalled();
        expect(alarms.api.create).toHaveBeenCalledWith(CONFIG_AUTO_BACKUP_ALARM, {
            delayInMinutes: CONFIG_AUTO_BACKUP_INTERVAL_MINUTES,
            periodInMinutes: CONFIG_AUTO_BACKUP_INTERVAL_MINUTES,
        });
    });

    it('alarm 缺失时按距上次备份满六小时的剩余时间首次调度', async () => {
        const now = Date.parse('2026-08-25T12:00:00.000Z');
        const state = createBaselineConfigAutoBackups(baseConfig, '2026-08-25T07:00:00.000Z');
        const alarms = createAlarmHarness(false);
        const capture = vi.fn();

        const installed = installConfigAutoBackupRuntime({
            alarms: alarms.api,
            ready: Promise.resolve(),
            getSnapshot: () => state,
            capture,
            now: () => now,
            warn: vi.fn(),
        });
        await installed.ready;

        expect(capture).not.toHaveBeenCalled();
        expect(alarms.api.create).toHaveBeenCalledWith(CONFIG_AUTO_BACKUP_ALARM, {
            delayInMinutes: 60,
            periodInMinutes: CONFIG_AUTO_BACKUP_INTERVAL_MINUTES,
        });
    });

    it('alarm 缺失且备份已到期时先补一份，再按完整六小时首次调度', async () => {
        const now = Date.parse('2026-08-25T12:00:00.000Z');
        let state = createBaselineConfigAutoBackups(baseConfig, '2026-08-25T06:00:00.000Z');
        const alarms = createAlarmHarness(false);
        const capture = vi.fn(async ({savedAt}: {savedAt: string}) => {
            state = appendConfigAutoBackup(state, baseConfig, savedAt);
            return state;
        });

        const installed = installConfigAutoBackupRuntime({
            alarms: alarms.api,
            ready: Promise.resolve(),
            getSnapshot: () => state,
            capture,
            now: () => now,
            warn: vi.fn(),
        });
        await installed.ready;

        expect(capture).toHaveBeenCalledOnce();
        expect(capture).toHaveBeenCalledWith({savedAt: '2026-08-25T12:00:00.000Z'});
        expect(state.entries).toHaveLength(2);
        expect(alarms.api.create).toHaveBeenCalledWith(CONFIG_AUTO_BACKUP_ALARM, {
            delayInMinutes: CONFIG_AUTO_BACKUP_INTERVAL_MINUTES,
            periodInMinutes: CONFIG_AUTO_BACKUP_INTERVAL_MINUTES,
        });
    });

    it('后台重启发现多个错过周期时最多补一份，紧邻 alarm 不重复捕获', async () => {
        let now = Date.parse('2026-08-25T18:00:00.000Z');
        let state = createBaselineConfigAutoBackups(baseConfig, '2026-08-22T00:00:00.000Z');
        const alarms = createAlarmHarness(true);
        const capture = vi.fn(async ({savedAt}: {savedAt: string}) => {
            state = appendConfigAutoBackup(state, baseConfig, savedAt);
            return state;
        });

        const installed = installConfigAutoBackupRuntime({
            alarms: alarms.api,
            ready: Promise.resolve(),
            getSnapshot: () => state,
            capture,
            now: () => now,
            warn: vi.fn(),
        });
        await installed.ready;

        expect(capture).toHaveBeenCalledOnce();
        expect(state.entries).toHaveLength(2);
        expect(alarms.api.create).not.toHaveBeenCalled();

        alarms.fire('unrelated-alarm');
        alarms.fire();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(capture).toHaveBeenCalledOnce();

        now += CONFIG_AUTO_BACKUP_INTERVAL_MINUTES * 60 * 1000;
        alarms.fire();
        await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(2));
        expect(state.entries).toHaveLength(3);
    });

    it('损坏或缺失时间视为到期', () => {
        const now = Date.parse('2026-08-25T12:00:00.000Z');
        expect(isConfigAutoBackupDue({schemaVersion: 1, entries: [], nextVersion: 1}, now)).toBe(true);
        const invalid = createBaselineConfigAutoBackups(baseConfig, 'not-a-date');
        expect(isConfigAutoBackupDue(invalid, now)).toBe(true);
        const future = createBaselineConfigAutoBackups(baseConfig, '2026-08-26T12:00:00.000Z');
        expect(isConfigAutoBackupDue(future, now)).toBe(true);
    });

    it('alarm 捕获失败与安装失败分别进入明确告警边界', async () => {
        const now = Date.parse('2026-08-25T12:00:00.000Z');
        const staleState = createBaselineConfigAutoBackups(baseConfig, '2026-08-25T00:00:00.000Z');
        const alarmFailure = createAlarmHarness(true);
        const alarmWarn = vi.fn();
        const capture = vi.fn()
            .mockResolvedValueOnce(appendConfigAutoBackup(staleState, baseConfig, new Date(now).toISOString()))
            .mockRejectedValueOnce(new Error('capture failed'));
        const installed = installConfigAutoBackupRuntime({
            alarms: alarmFailure.api,
            ready: Promise.resolve(),
            getSnapshot: () => staleState,
            capture,
            now: () => now + CONFIG_AUTO_BACKUP_INTERVAL_MINUTES * 60 * 1000,
            warn: alarmWarn,
        });
        await installed.ready;
        alarmFailure.fire();
        await vi.waitFor(() => expect(alarmWarn).toHaveBeenCalledWith(
            '[FluentRead] 自动配置备份执行失败',
            expect.objectContaining({message: 'capture failed'}),
        ));

        const installWarn = vi.fn();
        const installFailure = createAlarmHarness(true);
        const failed = installConfigAutoBackupRuntime({
            alarms: installFailure.api,
            ready: Promise.reject(new Error('ready failed')),
            getSnapshot: () => staleState,
            capture: vi.fn(),
            now: () => now,
            warn: installWarn,
        });
        await failed.ready;
        expect(installWarn).toHaveBeenCalledWith(
            '[FluentRead] 自动配置备份任务安装失败',
            expect.objectContaining({message: 'ready failed'}),
        );
    });
});
