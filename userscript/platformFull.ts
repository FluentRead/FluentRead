import {createPlatformMessageHandler as createCompactPlatformMessageHandler} from './platform';
import {normalizeConfig} from '@/src/core/config/model';
import {
    config, configReady, CONFIG_PERSIST_MESSAGE, CONFIG_PERSIST_BATCH_MESSAGE, CONFIG_STORAGE_KEY,
    getConfigRevision, prepareConfigPatchRequest, prepareConfigSaveRequest, parseStoredConfig, saveConfig,
} from '@/src/services/config/store';
import {extractConfigCredentials, LOCAL_CREDENTIALS_STORAGE_KEY, mergeConfigCredentials, parseStoredCredentials} from '@/src/core/config/credentials';
import {configStorage} from './storage';
import {createConfigPersistenceBatchHandler, createConfigPersistenceHandler} from '@/src/app/background/handlers/configPersistence';
import {dispatchContentNotification, UNHANDLED_RUNTIME_MESSAGE} from './browser';
import {createModelUsageHandler, MODEL_USAGE_MESSAGE_TYPE} from '@/src/app/background/handlers/modelUsage';
import {getModelUsageRepository} from '@/src/platform/storage/modelUsageRepository';
import {createVocabularyBookChangedMessage, createVocabularyBookHandler} from '@/src/features/vocabulary/background/handler';
import {VOCABULARY_BOOK_MESSAGE} from '@/src/features/vocabulary/protocol';
import {vocabularyBook} from '@/src/features/vocabulary/repository';
import {isUserscriptSettingsUrl} from './settingsPage';
import {isUserscriptPrivateContext} from './api';
import {createMemoryVocabularyUndo} from './memoryVocabularyUndo';

/** 完整设置的权威快照、CAS、批量持久化和本地管理消息；通用翻译/取消/缓存契约共用 compact 适配器。 */
export function createPlatformMessageHandler(openSettings: (section?: string) => void) {
    const handleCommonMessage = createCompactPlatformMessageHandler(openSettings);

    // Options 表单可能先乐观更新同一 realm 的 config；CAS 必须以已提交快照为准。
    let committedConfig = normalizeConfig(config);
    let disposed = false;
    const stopWatching: Array<() => void> = [];
    // bootstrap 已等待 configReady；同步取得基线，后续只消费 GM 权威记录，避开乐观 UI 通知。
    stopWatching.push(configStorage.watch(CONFIG_STORAGE_KEY, (value) => {
        if (disposed) return;
        const parsed = parseStoredConfig(value);
        if (parsed) committedConfig = normalizeConfig(mergeConfigCredentials(parsed, extractConfigCredentials(committedConfig)));
    }));
    stopWatching.push(configStorage.watch(LOCAL_CREDENTIALS_STORAGE_KEY, (value) => {
        if (disposed) return;
        committedConfig = normalizeConfig(mergeConfigCredentials(committedConfig, parseStoredCredentials(value) || extractConfigCredentials({})));
    }));
    const configPersistenceHandler = createConfigPersistenceHandler({
        ready: configReady,
        getCurrentConfig: () => committedConfig,
        prepareConfigPatchRequest,
        prepareConfigSaveRequest,
        saveConfig,
        getCurrentRevision: getConfigRevision,
        isExtensionUrl: (url) => isUserscriptSettingsUrl(url),
    });
    const configPersistenceBatchHandler = createConfigPersistenceBatchHandler(configPersistenceHandler);
    const modelUsageHandler = createModelUsageHandler(getModelUsageRepository(), (url) => isUserscriptSettingsUrl(url));
    const vocabularyBookHandler = createVocabularyBookHandler({
        configReady,
        isVocabularyBookEnabled: () => config.vocabularyBookEnabled === true,
        vocabularyBook,
        broadcastChanged: (reason, entryId) => {
            dispatchContentNotification(createVocabularyBookChangedMessage(reason, entryId));
        },
        logOperationFailure: (error) => console.error('[FluentRead userscript] 单词本操作失败', error),
    });

    // 旧脚本环境不创建明文持久撤销；关闭页面后只保留既有收藏数据。
    const memoryUndo = createMemoryVocabularyUndo(vocabularyBook, (reason, entryId) => {
        dispatchContentNotification(createVocabularyBookChangedMessage(reason, entryId));
    });

    const handle = async (message: any): Promise<any> => {
        if (disposed) return UNHANDLED_RUNTIME_MESSAGE;
        if (!message || typeof message !== 'object') return UNHANDLED_RUNTIME_MESSAGE;
        if (message.type === 'openOptionsPage') {
            openSettings(typeof message.section === 'string' ? message.section : undefined);
            return {success: true};
        }

        if (message.type === MODEL_USAGE_MESSAGE_TYPE) {
            return modelUsageHandler.handle(message, {sender: {url: globalThis.location?.href || ''}});
        }

        if (message.type === VOCABULARY_BOOK_MESSAGE) {
            if (['removeWithUndo','listUndo','restoreUndo','discardUndo'].includes(message.action)) {
                if (isUserscriptPrivateContext()) return {success:false,error:{code:'invalid-input',message:'无痕窗口不能管理撤销记录'}};
                return memoryUndo(message);
            }
            if (message.action === 'clear') {
                if (!memoryUndo.beginClear()) return {success:false,error:{code:'invalid-input',message:'操作进行中，请稍后重试'}};
                let success=false;
                try {const result=await vocabularyBookHandler.handle(message, {sender:{tab:{incognito:isUserscriptPrivateContext()}}});success=result.success;return result;}
                finally {memoryUndo.endClear(success);}
            }
            return vocabularyBookHandler.handle(message, {sender: {tab: {incognito: isUserscriptPrivateContext()}}});
        }

        if (message.type === CONFIG_PERSIST_MESSAGE) {
            return configPersistenceHandler.handle(message, {
                sender: {url: globalThis.location?.href || '', tab: {id: 1}, frameId: 0},
            });
        }

        if (message.type === CONFIG_PERSIST_BATCH_MESSAGE) {
            return configPersistenceBatchHandler.handle(message, {
                sender: {url: globalThis.location?.href || '', tab: {id: 1}, frameId: 0},
            });
        }

        return handleCommonMessage(message);
    };
    return Object.assign(handle, {connect: handleCommonMessage.connect, dispose() {
        if (disposed) return;
        disposed = true;
        memoryUndo.dispose();
        let failed = false;
        let firstError: unknown;
        // 清空归属后再逐个释放，允许 stop 同步重入；首个异常不能阻断另一订阅。
        for (const stop of [...stopWatching.splice(0), () => handleCommonMessage.dispose()]) {
            try {stop();} catch (error) {
                if (!failed) {failed = true; firstError = error;}
            }
        }
        if (failed) throw firstError;
    }});
}
