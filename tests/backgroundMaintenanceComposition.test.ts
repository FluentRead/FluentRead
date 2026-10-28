import 'fake-indexeddb/auto';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const ports = vi.hoisted(() => ({ready: Promise.resolve(), snapshot: vi.fn(), capture: vi.fn(), cleanup: vi.fn()}));
vi.mock('@/src/services/config/autoBackupStore', () => ({
    get configAutoBackupsReady() {return ports.ready;}, getConfigAutoBackupsSnapshot: ports.snapshot, captureConfigAutoBackup: ports.capture,
}));
vi.mock('@/src/app/translation/runtime', () => ({cleanupTranslationCache: ports.cleanup}));
import {installBackgroundMaintenance} from '@/src/app/background/maintenanceRuntime';
import {CONFIG_AUTO_BACKUP_ALARM} from '@/src/app/background/configAutoBackupRuntime';
import {TRANSLATION_CACHE_CLEANUP_ALARM} from '@/src/app/background/cacheCleanup';
import {RETIRED_DYNAMIC_CONTENT_SCRIPT_IDS} from '@/src/app/background/retiredContentScripts';
import {VOCABULARY_UNDO_ALARM} from '@/src/features/vocabulary/background/undoMaintenance';
import {vocabularyBookDb} from '@/src/features/vocabulary/repository';

type Listener = (alarm: {name: string}) => void;
const now = Date.parse('2026-10-27T08:00:00.000Z');
function deferred() {let resolve!: () => void;let reject!: (reason: unknown) => void;const promise = new Promise<void>((yes, no) => {resolve = yes;reject = no;});return {promise, resolve, reject};}
function browserFixture(scripting?: {getRegisteredContentScripts: ReturnType<typeof vi.fn>; unregisterContentScripts: ReturnType<typeof vi.fn>}) {
    const listeners: Listener[] = [];
    const alarms = {onAlarm: {addListener: (listener: Listener) => listeners.push(listener)}, get: vi.fn(async () => undefined), create: vi.fn(async () => undefined)};
    vi.stubGlobal('browser', {alarms, ...(scripting ? {scripting} : {})});
    return {alarms, listeners, fire: (name: string) => listeners.forEach(listener => listener({name}))};
}
beforeEach(() => {
    ports.ready = Promise.resolve();ports.snapshot.mockReset().mockReturnValue({schemaVersion: 1, entries: [], nextVersion: 1});
    ports.capture.mockReset().mockResolvedValue({schemaVersion: 1, entries: [], nextVersion: 1});ports.cleanup.mockReset().mockResolvedValue(undefined);
    vi.spyOn(Date, 'now').mockReturnValue(now);
});
afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('background maintenance composition', () => {
    it('runs real vocabulary undo cleanup at startup and on its alarm', async () => {
        const f = browserFixture();
        const record = (id: string, expiresAt: number) => ({id, createdAt: now - 1000, expiresAt, state: 'restored' as const});
        await vocabularyBookDb.undo.bulkPut([record('expired-on-start', now - 1), record('still-valid', now + 1000)]);
        try {
            installBackgroundMaintenance();
            await vi.waitFor(async () => expect(await vocabularyBookDb.undo.get('expired-on-start')).toBeUndefined());
            expect(await vocabularyBookDb.undo.get('still-valid')).toBeDefined();
            await vocabularyBookDb.undo.put(record('expired-on-alarm', now - 1));
            f.fire(VOCABULARY_UNDO_ALARM);
            await vi.waitFor(async () => expect(await vocabularyBookDb.undo.get('expired-on-alarm')).toBeUndefined());
            expect(await vocabularyBookDb.undo.get('still-valid')).toBeDefined();
        } finally {await vocabularyBookDb.undo.clear();}
    });
    it('reports a vocabulary cleanup failure without leaking the storage error', async () => {
        browserFixture();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const failure = vi.spyOn(vocabularyBookDb.undo, 'where').mockImplementationOnce(() => {throw new Error('private storage details');});
        try {
            installBackgroundMaintenance();
            await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[FluentRead] 词书撤销记录清理失败'));
            expect(JSON.stringify(warn.mock.calls)).not.toContain('private storage details');
        } finally {failure.mockRestore();}
    });
    it('installs both real maintenance paths without scripting and waits for backup readiness without delaying cache', async () => {
        const pending = deferred();ports.ready = pending.promise;const f = browserFixture();
        installBackgroundMaintenance();
        await vi.waitFor(() => expect(ports.cleanup).toHaveBeenCalledOnce());
        expect(ports.capture).not.toHaveBeenCalled();expect(f.listeners).toHaveLength(3);
        await vi.waitFor(() => expect(f.alarms.create).toHaveBeenCalledWith(TRANSLATION_CACHE_CLEANUP_ALARM, {delayInMinutes: 1, periodInMinutes: 1440}));
        await vi.waitFor(() => expect(f.alarms.create).toHaveBeenCalledWith(VOCABULARY_UNDO_ALARM, {periodInMinutes: 360}));
        pending.resolve();
        await vi.waitFor(() => expect(ports.capture).toHaveBeenCalledWith({savedAt: '2026-10-27T08:00:00.000Z'}));
        await vi.waitFor(() => expect(f.alarms.create).toHaveBeenCalledWith(CONFIG_AUTO_BACKUP_ALARM, {delayInMinutes: 360, periodInMinutes: 360}));
        f.fire('unrelated');await Promise.resolve();expect(ports.capture).toHaveBeenCalledOnce();expect(ports.cleanup).toHaveBeenCalledOnce();
        f.fire(CONFIG_AUTO_BACKUP_ALARM);f.fire(TRANSLATION_CACHE_CLEANUP_ALARM);
        await vi.waitFor(() => {expect(ports.capture).toHaveBeenCalledTimes(2);expect(ports.cleanup).toHaveBeenCalledTimes(2);});
    });
    it('removes only the registered retired script and leaves both maintenance alarms active', async () => {
        const retired = RETIRED_DYNAMIC_CONTENT_SCRIPT_IDS[0];
        const scripting = {getRegisteredContentScripts: vi.fn(async () => [{id: 'other'}, {id: retired}, {id: retired}]), unregisterContentScripts: vi.fn(async () => undefined)};
        const f = browserFixture(scripting);installBackgroundMaintenance();
        await vi.waitFor(() => expect(scripting.unregisterContentScripts).toHaveBeenCalledWith({ids: [retired]}));
        expect(scripting.getRegisteredContentScripts).toHaveBeenCalledWith({ids: [retired]});
        await vi.waitFor(() => expect(f.alarms.create).toHaveBeenCalledTimes(3));expect(ports.cleanup).toHaveBeenCalledOnce();expect(ports.capture).toHaveBeenCalledOnce();
    });
    it.each(['lookup', 'unregister'] as const)('reports retired-script %s failure without blocking alarms or future cleanup', async where => {
        const error = new Error(`${where} unavailable`), warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const scripting = {getRegisteredContentScripts: vi.fn(async () => [{id: RETIRED_DYNAMIC_CONTENT_SCRIPT_IDS[0]}]), unregisterContentScripts: vi.fn(async () => undefined)};
        if (where === 'lookup') scripting.getRegisteredContentScripts.mockRejectedValueOnce(error);else scripting.unregisterContentScripts.mockRejectedValueOnce(error);
        const f = browserFixture(scripting);installBackgroundMaintenance();
        await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[FluentRead] 清理退役动态内容脚本失败', error));
        await vi.waitFor(() => expect(f.alarms.create).toHaveBeenCalledTimes(3));
        f.fire(TRANSLATION_CACHE_CLEANUP_ALARM);await vi.waitFor(() => expect(ports.cleanup).toHaveBeenCalledTimes(2));
        expect(ports.capture).toHaveBeenCalledOnce();
    });
    it('reports backup and cache failures independently and both named alarms retry', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}), f = browserFixture();
        const backupFailure = new Error('backup failure');ports.capture.mockRejectedValueOnce(backupFailure);ports.cleanup.mockRejectedValueOnce(new Error('cache failure'));
        installBackgroundMaintenance();
        await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[FluentRead] 自动配置备份执行失败', backupFailure));
        await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[FluentRead] 翻译缓存清理失败，将在下次维护时重试'));
        await vi.waitFor(() => expect(f.alarms.create).toHaveBeenCalledTimes(3));
        f.fire(CONFIG_AUTO_BACKUP_ALARM);f.fire(TRANSLATION_CACHE_CLEANUP_ALARM);
        await vi.waitFor(() => {expect(ports.capture).toHaveBeenCalledTimes(2);expect(ports.cleanup).toHaveBeenCalledTimes(2);});
    });
    it('reports failed backup hydration while leaving cache maintenance usable', async () => {
        const ready = deferred();ports.ready = ready.promise;const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}), f = browserFixture();
        installBackgroundMaintenance();const error = new Error('backup hydration failed');ready.reject(error);
        await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[FluentRead] 自动配置备份任务安装失败', error));
        await vi.waitFor(() => expect(ports.cleanup).toHaveBeenCalledOnce());
        expect(ports.capture).not.toHaveBeenCalled();
        f.fire(TRANSLATION_CACHE_CLEANUP_ALARM);await vi.waitFor(() => expect(ports.cleanup).toHaveBeenCalledTimes(2));
    });
});
