/**
 * @file src/app/background/configMessageHandlers.ts
 * 文件职责：集中组装后台配置消息处理器，使保存、翻译计数、历史恢复和自动备份恢复共享同一条修改队列。
 * 主要内容：连接配置 store 与配置消息 handler，让保存与补丁批次复用持久化实例；同时登记官方规则的读取及更新入口。
 * 模块边界：本文件属于后台 composition root，只负责依赖接线；消息参数校验位于 handlers，配置归一化、持久化和恢复规则位于 services/config。
 */
import {
    applyConfigHistoryAction,
    config,
    configHistoryReady,
    configReady,
    getConfigRevision,
    incrementConfigCount,
    prepareConfigPatchRequest,
    prepareConfigSaveRequest,
    saveConfig,
} from '@/src/services/config/store';
import {
    configAutoBackupsReady,
    restoreConfigAutoBackup,
} from '@/src/services/config/autoBackupStore';
import {configStorage} from '@/src/platform/storage/configStorageRuntime';
import type {BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';
import {createGoogleDriveSyncRuntime} from './googleDriveSyncRuntime';
import {createWebDavBackupRuntime} from './webDavBackupRuntime';
import {createConfigAutoBackupRestoreHandler} from './handlers/configAutoBackup';
import {createConfigStorageReadHandler, createPopupStartupHandler} from './handlers/configStorage';
import {createConfigCountIncrementHandler} from './handlers/configCount';
import {createConfigHistoryHandler} from './handlers/configHistory';
import {createOfficialSiteRuleHandlers} from './officialSiteRuleRuntime';
import {backgroundConfigMutations} from './configMutationQueue';
import {
    createConfigPersistenceBatchHandler,
    createConfigPersistenceHandler,
    type ConfigPersistenceContext,
} from './handlers/configPersistence';

/** 把配置保存、计数、历史与备份恢复放入同一 mutation 队列。 */
export function createConfigBackgroundHandlers<TContext extends ConfigPersistenceContext>(
    registerContentReceiver?: (sender: ConfigPersistenceContext['sender']) => Promise<void>,
): Array<BackgroundMessageHandler<TContext>> {
    // 与右键菜单等后台内部写入共用同一条队列，防止并发保存相互覆盖。
    const mutations = backgroundConfigMutations;
    const persistence = createConfigPersistenceHandler({
        ready: configReady,
        getCurrentConfig: () => config,
        prepareConfigPatchRequest,
        prepareConfigSaveRequest,
        saveConfig,
        getCurrentRevision: getConfigRevision,
        runMutation: mutations.run,
        isExtensionUrl: (url) => url.startsWith(browser.runtime.getURL('/')),
    });
    return [
        ...createOfficialSiteRuleHandlers<TContext>(),
        createGoogleDriveSyncRuntime(mutations),
        createWebDavBackupRuntime(mutations),
        createPopupStartupHandler({
            ready: configReady,
            getSetupCompleted: () => config.uiLanguageSetupCompleted,
            isExtensionUrl: (url) => url.startsWith(browser.runtime.getURL('/')),
        }),
        createConfigStorageReadHandler({
            ready: configReady,
            registerContentReceiver,
            read: async key => {
                if (key === 'local:configHistory') await configHistoryReady;
                if (key === 'local:configAutoBackups') await configAutoBackupsReady;
                return configStorage.getItem(key);
            },
            isExtensionUrl: (url) => url.startsWith(browser.runtime.getURL('/')),
        }),
        createConfigCountIncrementHandler((delta, operationId) => (
            mutations.run(() => incrementConfigCount(delta, operationId))
        )),
        createConfigHistoryHandler((action, version) => (
            mutations.run(() => applyConfigHistoryAction(action, version))
        )),
        createConfigAutoBackupRestoreHandler((version) => (
            mutations.run(() => restoreConfigAutoBackup(version))
        )),
        persistence,
        createConfigPersistenceBatchHandler(persistence),
    ] as Array<BackgroundMessageHandler<TContext>>;
}
