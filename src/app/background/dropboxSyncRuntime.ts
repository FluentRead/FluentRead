/**
 * @file src/app/background/dropboxSyncRuntime.ts
 * 文件职责：装配 Dropbox 的授权、应用文件夹与现有配置同步事务。
 * 主要内容：临时令牌仅保存在扩展 session storage；配置变更进入共享队列，账号基线
 * 与 Google Drive 分开持久化；所属页签关闭或重载会取消待确认同步。
 * 模块边界：只装配端口，不自行实现差异算法或向设置页返回令牌。
 */
import browser from 'webextension-polyfill';
import {config, configReady, prepareHydratedConfigForExport, saveConfig} from '@/src/services/config/store';
import {prepareConfigForImport} from '@/src/core/config/transfer';
import {createDropboxAuth} from '@/src/platform/dropbox/auth';
import {createDropboxApi} from '@/src/platform/dropbox/api';
import {DROPBOX_APP_KEY, DROPBOX_AUTH_SESSION_KEY, DROPBOX_SYNC_STATE_KEY} from '@/src/platform/dropbox/constants';
import {configStorage} from '@/src/platform/storage/configStorageRuntime';
import {createRemoteConfigSync} from '@/src/services/config/remoteConfigSync';
import {createGoogleDriveSyncHandler, isGoogleDriveSettingsSender} from './handlers/googleDriveSync';
import type {ConfigMutationCoordinator} from './handlers/configPersistence';

export function createDropboxSyncRuntime(mutations: ConfigMutationCoordinator) {
    const session = browser.storage?.session;
    const service = createRemoteConfigSync({
        accountChangedError: 'settings.dropbox.error.accountChanged',
        auth: createDropboxAuth({
            appKey: DROPBOX_APP_KEY,
            identity: session ? browser.identity : undefined,
            async readSession() {return (await session.get(DROPBOX_AUTH_SESSION_KEY))[DROPBOX_AUTH_SESSION_KEY];},
            async writeSession(value) {await session.set({[DROPBOX_AUTH_SESSION_KEY]: value});},
            async clearSession() {if (session) await session.remove(DROPBOX_AUTH_SESSION_KEY);},
            fetch: (...args) => fetch(...args), now: Date.now,
        }),
        api: createDropboxApi((...args) => fetch(...args)),
        snapshot: prepareHydratedConfigForExport,
        async apply(value) {
            await configReady;
            const imported = prepareConfigForImport({...value, videoServiceDefaultMigrated: true}, config, {credentialMode: 'replace'});
            if (!imported) throw new Error('配置导入失败');
            imported.uiLanguageSetupCompleted = config.uiLanguageSetupCompleted;
            await saveConfig(imported, {recordHistory: true, immediateHistory: true});
        },
        async readState() {await configReady; return configStorage.getItem(DROPBOX_SYNC_STATE_KEY);},
        writeState: state => configStorage.setItem(DROPBOX_SYNC_STATE_KEY, state), now: Date.now,
    });
    browser.tabs.onRemoved.addListener((tabId: number) => {void service.cancelTab(tabId).catch(() => undefined);});
    browser.tabs.onUpdated.addListener((tabId: number, change: {status?: string}) => {if (change.status === 'loading') void service.cancelTab(tabId).catch(() => undefined);});
    return createGoogleDriveSyncHandler({...service, commit: (...args) => mutations.run(() => service.commit(...args))}, sender => isGoogleDriveSettingsSender(sender, browser.runtime.id, browser.runtime.getURL('options.html')), 'dropbox');
}
