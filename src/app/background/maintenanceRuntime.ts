/**
 * @file src/app/background/maintenanceRuntime.ts
 * 文件职责：把浏览器运行时能力接入后台维护任务，统一安装配置自动备份、翻译缓存清理与退役动态脚本回收生命周期。
 * 主要内容：清理已删除功能的持久注册，将 browser.alarms、当前时间、备份 store 和告警输出适配给可测试的自动备份 runtime，并继续注册缓存维护。
 * 模块边界：本文件是后台组合层，不实现注册筛选、到期算法、快照格式或缓存清理策略；具体行为分别留在相邻纯模块和 services/config。
 */
import {installTranslationCacheCleanup} from './cacheCleanup';
import {vocabularyBookDb} from '@/src/features/vocabulary/repository';
import {VocabularyPersistentUndo} from '@/src/features/vocabulary/background/persistentUndo';
import {installVocabularyUndoMaintenance} from '@/src/features/vocabulary/background/undoMaintenance';
import {
    installConfigAutoBackupRuntime,
    type ConfigAutoBackupAlarmApi,
} from './configAutoBackupRuntime';
import {
    captureConfigAutoBackup,
    configAutoBackupsReady,
    getConfigAutoBackupsSnapshot,
} from '@/src/services/config/autoBackupStore';
import {
    unregisterRetiredContentScripts,
    type RetiredContentScriptsPort,
} from './retiredContentScripts';

/** 把浏览器 alarm/storage 适配到可独立测试的后台维护任务。 */
export function installBackgroundMaintenance(): void {
    installVocabularyUndoMaintenance({alarms: browser.alarms, prune: () => new VocabularyPersistentUndo(vocabularyBookDb).pruneUndo(), warn: message => console.warn(message)});
    const scripting = (browser as unknown as {scripting?: RetiredContentScriptsPort}).scripting;
    if (scripting) {
        void unregisterRetiredContentScripts(scripting).catch((error) => {
            console.warn('[FluentRead] 清理退役动态内容脚本失败', error);
        });
    }
    installConfigAutoBackupRuntime({
        alarms: browser.alarms as unknown as ConfigAutoBackupAlarmApi,
        ready: configAutoBackupsReady,
        getSnapshot: getConfigAutoBackupsSnapshot,
        capture: (options) => captureConfigAutoBackup(options),
        now: () => Date.now(),
        warn: (message, error) => console.warn(message, error),
    });
    installTranslationCacheCleanup();
}
