import {createVisionProbeHandlers} from '@/src/app/background/handlers/visionProbe';
import {modelVisionProbe} from '@/src/app/translation/visionProbeRuntime';
import {runTranslationServiceConnectionTest} from '@/src/providers/translation/connectionTest';
import {normalizeConfig} from '@/src/core/config/model';
import {
    applyConfigHistoryAction,
    config,
    configReady,
    CONFIG_HISTORY_MESSAGE,
    CONFIG_PERSIST_MESSAGE,
    CONFIG_PERSIST_BATCH_MESSAGE,
    CONFIG_STORAGE_KEY,
    getConfigRevision,
    prepareConfigPatchRequest,
    prepareConfigSaveRequest,
    parseStoredConfig,
    saveConfig,
} from '@/src/services/config/store';
import {extractConfigCredentials, LOCAL_CREDENTIALS_STORAGE_KEY, mergeConfigCredentials, parseStoredCredentials} from '@/src/core/config/credentials';
import {configStorage} from './storage';
import {
    createConfigPersistenceBatchHandler,
    createConfigPersistenceHandler,
} from '@/src/app/background/handlers/configPersistence';
import {
    CONFIG_COUNT_INCREMENT_MESSAGE,
    parseConfigCountIncrement,
    parseConfigCountOperationId,
} from '@/src/services/config/count';
import {incrementUserscriptConfigCount} from './count';
import {CONNECTION_TEST_MESSAGE} from '@/src/core/config/constants';
import {
    cleanupTranslationCache,
    clearTranslationCache,
    translateWithCache,
} from '@/src/app/translation/runtime';
import {lookupWord} from '@/src/features/selection-translation/services/wordDictionary';
import {createInputBoxTranslationHandler} from '@/src/features/input-translation/background';
import {dispatchContentMessage, UNHANDLED_RUNTIME_MESSAGE} from './browser';
import {attachTranslationGlossaryContext, createTranslationProviderConfigSnapshot} from '@/src/services/translation/requestSnapshot';
import {createModelUsageHandler, MODEL_USAGE_MESSAGE_TYPE} from '@/src/app/background/handlers/modelUsage';
import {modelUsageRepository} from '@/src/platform/storage/modelUsageRepository';
import {createVocabularyBookChangedMessage, createVocabularyBookHandler} from '@/src/features/vocabulary/background/handler';
import {VOCABULARY_BOOK_MESSAGE} from '@/src/features/vocabulary/protocol';
import {vocabularyBook} from '@/src/features/vocabulary/repository';
import {isUserscriptSettingsUrl} from './settingsPage';
import {createTranslationRequestRegistry} from '@/src/app/background/handlers/translation';
import {TRANSLATION_CANCEL_MESSAGE_TYPE} from '@/src/services/translation/types';

const UNSUPPORTED_CAPABILITY_MESSAGE = '该功能依赖浏览器扩展权限，userscript 版本暂不支持';

/**
 * 把扩展后台消息契约映射到同页 userscript 服务；需要扩展权限的能力会返回明确失败，
 * 其余翻译、配置和缓存请求仍复用共享业务实现。
 */
export function createPlatformMessageHandler(openSettings: (section?: string) => void) {
    const visionHandlers = createVisionProbeHandlers({ready: configReady, getConfig: () => config, isSettingsUrl: () => true, resolve: modelVisionProbe.resolve});
    const inputRequestRegistry = createTranslationRequestRegistry();
    const inputRequestContext = {sender: {url: globalThis.location?.href}};

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
    const inputBoxTranslationHandler = createInputBoxTranslationHandler({
        ready: configReady,
        getConfig: () => config,
        translate: translateWithCache,
        requestRegistry: inputRequestRegistry,
    });
    const modelUsageHandler = createModelUsageHandler(modelUsageRepository, (url) => isUserscriptSettingsUrl(url));
    const vocabularyBookHandler = createVocabularyBookHandler({
        configReady,
        isVocabularyBookEnabled: () => config.vocabularyBookEnabled === true,
        vocabularyBook,
        broadcastChanged: (reason, entryId) => {
            void dispatchContentMessage(createVocabularyBookChangedMessage(reason, entryId));
        },
        logOperationFailure: (error) => console.error('[FluentRead userscript] 单词本操作失败', error),
    });

    const handle = async (message: any): Promise<any> => {
        if (disposed) return UNHANDLED_RUNTIME_MESSAGE;
        if (!message || typeof message !== 'object') return UNHANDLED_RUNTIME_MESSAGE;
        const visionHandler = visionHandlers.find(handler => handler.type === message.type);
        if (visionHandler) {
            try { return await visionHandler.handle(message, {}); }
            catch { return {success: false, error: '识图检测失败，请检查服务配置后重试'}; }
        }

        if (message.type === 'openOptionsPage') {
            openSettings(typeof message.section === 'string' ? message.section : undefined);
            return {success: true};
        }

        if (message.type === MODEL_USAGE_MESSAGE_TYPE) {
            return modelUsageHandler.handle(message, {sender: {url: globalThis.location?.href || ''}});
        }

        if (message.type === VOCABULARY_BOOK_MESSAGE) {
            return vocabularyBookHandler.handle(message, {sender: {tab: {incognito: false}}});
        }

        if (message.type === 'fullPageTranslationState') return {success: true};

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

        if (message.type === CONFIG_COUNT_INCREMENT_MESSAGE) {
            const delta = parseConfigCountIncrement(message.delta);
            if (delta === null) return {success: false, error: '无效的翻译计数增量'};
            const operationId = parseConfigCountOperationId(message.operationId);
            if (operationId === null) return {success: false, error: '无效的翻译计数操作标识'};
            const count = await incrementUserscriptConfigCount(delta, operationId);
            // local:config.count 只是可重建投影。跨标签同时递增时，每个标签返回的
            // 瞬时总数都可能随后被另一个副本推进；热路径不能用整份配置把较旧投影
            // 反向覆盖。启动、聚焦和打开设置时会从专用副本重新聚合并落盘。
            config.count = count;
            return {success: true, count};
        }

        if (message.type === CONFIG_HISTORY_MESSAGE) {
            const action = message.action === 'undo' || message.action === 'redo' || message.action === 'restore'
                ? message.action
                : null;
            if (!action) return {success: false, error: '无效的配置历史操作'};
            const history = await applyConfigHistoryAction(action, typeof message.version === 'number' ? message.version : undefined);
            return {success: true, history};
        }

        if (message.type === CONNECTION_TEST_MESSAGE) {
            await configReady;
            try {
                const result = await runTranslationServiceConnectionTest(String(message.service || ''), {
                    configSnapshot: createTranslationProviderConfigSnapshot(config),
                    keyIndex: message.keyIndex,
                    keyRevision: message.keyRevision,
                    freeProviderId: message.freeProviderId,
                });
                return {success: true, ...result};
            } catch (error) {
                return {success: false, error: error instanceof Error ? error.message : String(error)};
            }
        }

        if (message.type === 'inputBoxTranslation') {
            try {
                return await inputBoxTranslationHandler.handle(message, inputRequestContext);
            } catch (error) {
                return {success: false, error: error instanceof Error ? error.message : String(error)};
            }
        }

        if (message.type === TRANSLATION_CANCEL_MESSAGE_TYPE) {
            try {return inputRequestRegistry.cancel(message.clientRequestId, inputRequestContext);}
            catch (error) {return {success: false, error: error instanceof Error ? error.message : String(error)};}
        }

        if (message.type === 'selectionWordLookup') {
            try {
                return {success: true, data: await lookupWord(String(message.word || ''))};
            } catch (error) {
                return {success: false, error: error instanceof Error ? error.message : String(error)};
            }
        }

        if (message.type === 'selectionTts' || message.type === 'selectionTtsGoogle' || message.type === 'selectionTtsStop') {
            // 当前 transport 报告不可用后，SelectionTranslator 会自动回退到
            // speechSynthesis 和页面音频播放。
            return {success: false, error: 'userscript 使用网页语音回退'};
        }

        if (message.type === 'clearTranslationCache') {
            await clearTranslationCache();
            return {success: true};
        }

        if (message.type === 'userscriptCacheMaintenance') {
            await cleanupTranslationCache();
            return {success: true};
        }

        if (typeof message.type === 'string' && (
            message.type === 'toggleSelectionAreaTranslator' ||
            message.type === 'toggleImageTranslator' ||
            message.type.startsWith('fluentReadImage') ||
            message.type.startsWith('fluentReadArea')
        )) {
            return {success: false, error: UNSUPPORTED_CAPABILITY_MESSAGE};
        }

        if (typeof message.origin === 'string' || Array.isArray(message.origin)) {
            return translateWithCache(attachTranslationGlossaryContext({...message}, {
                pageUrl: globalThis.location?.href,
                context: message.glossaryContext === 'video' ? 'video' : 'page',
            }));
        }

        return UNHANDLED_RUNTIME_MESSAGE;
    };
    return Object.assign(handle, {dispose() {
        if (disposed) return;
        disposed = true;
        let failed = false;
        let firstError: unknown;
        // 清空归属后再逐个释放，允许 stop 同步重入；首个异常不能阻断另一订阅。
        for (const stop of stopWatching.splice(0)) {
            try {stop();} catch (error) {
                if (!failed) {failed = true; firstError = error;}
            }
        }
        if (failed) throw firstError;
    }});
}
