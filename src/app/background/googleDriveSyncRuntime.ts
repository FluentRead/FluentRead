/**
 * @file src/app/background/googleDriveSyncRuntime.ts
 * 文件职责：为后台加密同步服务连接现有完整配置与浏览器身份端口。
 * 主要内容：完整凭据读写、密文基线、设置页校验，以及由后台处理所属页签关闭或重新加载。
 * 模块边界：按云端提供商隔离状态；仅装配依赖；配置写入复用现有持久化与修改队列，不向内容脚本公开密文基线。
 */
import {config, configReady, prepareHydratedConfigForExport, saveConfig} from '@/src/services/config/store';
import {prepareConfigForImport} from '@/src/core/config/transfer';
import {createDriveAuth, type DriveIdentity} from '@/src/platform/google-drive/auth';
import {createDriveApi} from '@/src/platform/google-drive/api';
import {GOOGLE_DRIVE_SYNC_STATE_KEY} from '@/src/platform/google-drive/constants';
import {configStorage} from '@/src/platform/storage/configStorageRuntime';
import {createCloudConfigSync} from '@/src/services/config/googleDriveSync';
import {createGoogleDriveSyncHandler, isGoogleDriveSettingsSender} from './handlers/googleDriveSync';
import {createOneDriveAuth} from '@/src/platform/onedrive/auth';
import {createOneDriveApi} from '@/src/platform/onedrive/api';
import {ONEDRIVE_CLIENT_ID, ONEDRIVE_STATE_KEY, ONEDRIVE_MESSAGE_TYPE} from '@/src/platform/onedrive/constants';
import type {ConfigMutationCoordinator} from './handlers/configPersistence';

export function createGoogleDriveSyncRuntime(mutations: ConfigMutationCoordinator, provider: 'google-drive' | 'onedrive' = 'google-drive') {
    const nativeChrome = (globalThis as unknown as {chrome?: {identity?: DriveIdentity}}).chrome;
    const oneDrive = provider === 'onedrive';
    const stateKey = oneDrive ? ONEDRIVE_STATE_KEY : GOOGLE_DRIVE_SYNC_STATE_KEY;
    const service = createCloudConfigSync({
        auth: oneDrive ? createOneDriveAuth({clientId: ONEDRIVE_CLIENT_ID, identity: browser.identity, fetch: (...args) => fetch(...args), now: Date.now}) : createDriveAuth({userAgent: () => navigator.userAgent, identity: nativeChrome?.identity, runtime: browser.runtime, fetch: (...args) => fetch(...args)}),
        api: oneDrive ? createOneDriveApi((...args) => fetch(...args)) : createDriveApi((...args) => fetch(...args)),
        ...(oneDrive ? {accountChangedMessage: 'settings.onedrive.accountChanged'} : {}),
        snapshot: prepareHydratedConfigForExport,
        async apply(value) {
            await configReady;
            const imported = prepareConfigForImport({...value, videoServiceDefaultMigrated: true}, config, {credentialMode: 'replace'});
            if (!imported) throw new Error('配置导入失败');
            imported.uiLanguageSetupCompleted = config.uiLanguageSetupCompleted;
            await saveConfig(imported, {recordHistory: true, immediateHistory: true});
        },
        async readState() {await configReady; return configStorage.getItem(stateKey);},
        writeState: state => configStorage.setItem(stateKey, state),
        now: Date.now,
    });
    browser.tabs.onRemoved.addListener((tabId: number) => {void service.cancelTab(tabId).catch(() => undefined);});
    browser.tabs.onUpdated.addListener((tabId: number, change: {status?: string}) => {if (change.status === 'loading') void service.cancelTab(tabId).catch(() => undefined);});
    return createGoogleDriveSyncHandler({...service, commit: (...args) => mutations.run(() => service.commit(...args))}, sender => isGoogleDriveSettingsSender(sender, browser.runtime.id, browser.runtime.getURL('options.html')), oneDrive ? ONEDRIVE_MESSAGE_TYPE : undefined);
}
