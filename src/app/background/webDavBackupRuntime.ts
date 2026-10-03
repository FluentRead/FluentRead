/**
 * @file src/app/background/webDavBackupRuntime.ts
 * 文件职责：在扩展后台装配 WebDAV 连接仓库、网络端口与现有配置持久化。
 * 主要内容：复用完整凭据快照及导入历史，按设置页授权消息，并在所属页签关闭时清除预览。
 * 模块边界：只装配依赖；云备份规则由服务实现；连接记录留在后台加密 IndexedDB 中。
 */
import {config, configReady, prepareHydratedConfigForExport, saveConfig} from '@/src/services/config/store';
import {prepareConfigForImport} from '@/src/core/config/transfer';
import {configStorage} from '@/src/platform/storage/configStorageRuntime';
import {createWebDavConnectionStore, WEBDAV_SYNC_STATE_KEY} from '@/src/platform/webdav/connection';
import {createWebDavApi} from '@/src/platform/webdav/api';
import {createWebDavBackup} from '@/src/services/config/webDavBackup';
import {createWebDavBackupHandler} from './handlers/webDavBackup';
import {isGoogleDriveSettingsSender} from './handlers/googleDriveSync';
import type {ConfigMutationCoordinator} from './handlers/configPersistence';

export function createWebDavBackupRuntime(mutations: ConfigMutationCoordinator) {
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
    });
    browser.tabs.onRemoved.addListener((tabId: number) => {void service.cancelTab(tabId).catch(() => undefined);});
    browser.tabs.onUpdated.addListener((tabId: number, change: {status?: string}) => {if (change.status === 'loading') void service.cancelTab(tabId).catch(() => undefined);});
    return createWebDavBackupHandler({...service, commit: (...args) => mutations.run(() => service.commit(...args))}, sender => isGoogleDriveSettingsSender(sender, browser.runtime.id, browser.runtime.getURL('options.html')));
}
