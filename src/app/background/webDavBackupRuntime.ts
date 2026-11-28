/**
 * @file src/app/background/webDavBackupRuntime.ts
 * 文件职责：在扩展后台装配 WebDAV 连接仓库、网络端口、学习数据同步、端到端口令仓库、自动同步调度与现有配置持久化。
 * 主要内容：复用完整凭据快照及导入历史，按设置页授权消息，安装默认关闭的 WebDAV 定时自动同步闹钟，并在所属页签关闭时清除预览。
 * 模块边界：只装配依赖；云备份与自动同步规则由服务实现；连接记录与自定义口令留在后台加密 IndexedDB 中。
 */
import {config, configReady, prepareHydratedConfigForExport, saveConfig} from '@/src/services/config/store';
import {prepareConfigForImport} from '@/src/core/config/transfer';
import {configStorage} from '@/src/platform/storage/configStorageRuntime';
import {PersonalCorrectionRepository} from '@/src/platform/storage/personalCorrectionRepository';
import {vocabularyBook} from '@/src/features/vocabulary/repository';
import {MaterialRepository} from '@/src/features/vocabulary/materialRepository';
import {createWebDavConnectionStore, WEBDAV_SYNC_STATE_KEY} from '@/src/platform/webdav/connection';
import {createWebDavApi} from '@/src/platform/webdav/api';
import {createWebDavBackup} from '@/src/services/config/webDavBackup';
import {createLearningCloudSync} from '@/src/services/config/learningCloudSync';
import {createCloudPassphraseStore, type CloudPassphraseSessionStorage} from '@/src/services/config/cloudPassphraseStore';
import {CLOUD_AUTO_SYNC_CLIENT_ID, createCloudAutoSync, type CloudAutoSyncAlarmApi} from '@/src/services/config/cloudAutoSync';
import {createWebDavBackupHandler} from './handlers/webDavBackup';
import {isTrustedSettingsSender} from './handlers/trustedSettingsSender';
import type {ConfigMutationCoordinator} from './handlers/configPersistence';

export function createWebDavBackupRuntime(mutations: ConfigMutationCoordinator) {
    const sessionStorage = (browser.storage as unknown as {session?: CloudPassphraseSessionStorage}).session;
    const passphrases = createCloudPassphraseStore({
        provider: 'webdav',
        deviceStorage: configStorage,
        sessionStorage,
    });
    const learning = createLearningCloudSync({
        vocabulary: vocabularyBook,
        personalCorrections: new PersonalCorrectionRepository(configStorage),
        materials: new MaterialRepository(),
    });
    const service = createWebDavBackup({
        connections: createWebDavConnectionStore(configStorage),
        api: createWebDavApi((...args) => fetch(...args)),
        snapshot: prepareHydratedConfigForExport,
        async apply(value) {
            await configReady;
            const imported = prepareConfigForImport({...value, videoServiceDefaultMigrated: true}, config, {credentialMode: 'replace'});
            if (!imported) throw new Error('配置导入失败');
            imported.uiLanguageSetupCompleted = config.uiLanguageSetupCompleted;
            await saveConfig(imported, {recordHistory: true, immediateHistory: true});
        },
        readState: () => configStorage.getItem(WEBDAV_SYNC_STATE_KEY),
        writeState: state => configStorage.setItem(WEBDAV_SYNC_STATE_KEY, state),
        removeState: () => configStorage.removeItem(WEBDAV_SYNC_STATE_KEY),
        now: Date.now,
        learning,
    });
    const autoSync = createCloudAutoSync({
        storage: configStorage,
        alarms: browser.alarms as unknown as CloudAutoSyncAlarmApi,
        isAvailable: async () => Boolean(await service.settings()),
        resolvePassphrase: () => passphrases.resolveForSync(),
        prepare: (passphrase, includeSensitive, options) => service.prepare(passphrase, undefined, CLOUD_AUTO_SYNC_CLIENT_ID, includeSensitive, options),
        commit: (id, passphrase, direction, choices, options) => mutations.run(() => service.commit(id, passphrase, direction, choices, undefined, CLOUD_AUTO_SYNC_CLIENT_ID, options)),
        cancel: id => service.cancel(id, undefined, CLOUD_AUTO_SYNC_CLIENT_ID),
        isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
        now: Date.now,
    });
    void autoSync.install().catch(() => undefined);
    browser.tabs.onRemoved.addListener((tabId: number) => {void service.cancelTab(tabId).catch(() => undefined);});
    browser.tabs.onUpdated.addListener((tabId: number, change: {status?: string}) => {if (change.status === 'loading') void service.cancelTab(tabId).catch(() => undefined);});
    return createWebDavBackupHandler(
        {...service, commit: (...args) => mutations.run(() => service.commit(...args))},
        sender => isTrustedSettingsSender(sender, browser.runtime.id, browser.runtime.getURL('options.html')),
        {passphrases, autoSync},
    );
}
