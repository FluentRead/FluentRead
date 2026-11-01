import {createVisionProbeHandlers} from '@/src/app/background/handlers/visionProbe';
import {modelVisionProbe} from '@/src/app/translation/visionProbeRuntime';
import {runTranslationServiceConnectionTest} from '@/src/providers/translation/connectionTest';
import {
    applyConfigHistoryAction,
    config,
    configReady,
    CONFIG_HISTORY_MESSAGE,
    CONFIG_PERSIST_MESSAGE,
    getConfigRevision,
    prepareConfigPatchRequest,
    saveConfig,
} from '@/src/services/config/store';
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
import {UNHANDLED_RUNTIME_MESSAGE} from './browser';
import {createUserscriptReadingRuntime} from './readingRuntime';
import {attachTranslationGlossaryContext, attachTranslationRequestControl, createTranslationProviderConfigSnapshot} from '@/src/services/translation/requestSnapshot';
import {createTranslationRequestRegistry, parseTranslationRequest} from '@/src/app/background/handlers/translation';
import {TRANSLATION_CANCEL_MESSAGE_TYPE} from '@/src/services/translation/types';

const UNSUPPORTED_CAPABILITY_MESSAGE = '该功能依赖浏览器扩展权限，userscript 版本暂不支持';

/**
 * 把扩展后台消息契约映射到同页 userscript 服务；需要扩展权限的能力会返回明确失败，
 * 其余翻译、配置和缓存请求仍复用共享业务实现。
 */
export function createPlatformMessageHandler(openSettings: () => void) {
    const visionHandlers = createVisionProbeHandlers({ready: configReady, getConfig: () => config, isSettingsUrl: () => true, resolve: modelVisionProbe.resolve});
    const requestRegistry = createTranslationRequestRegistry();
    let reading: ReturnType<typeof createUserscriptReadingRuntime> | undefined;
    const getReading = () => reading ??= createUserscriptReadingRuntime();
    let disposed = false;
    const requestContext = {sender: {url: globalThis.location?.href}};

    const inputBoxTranslationHandler = createInputBoxTranslationHandler({
        ready: configReady,
        getConfig: () => config,
        translate: translateWithCache,
        requestRegistry: requestRegistry,
    });

    const handle = async (message: any): Promise<any> => {
        if (disposed) return UNHANDLED_RUNTIME_MESSAGE;
        if (message?.type === 'fluentReadHarness') return getReading().handle(message);
        if (!message || typeof message !== 'object') return UNHANDLED_RUNTIME_MESSAGE;
        const visionHandler = visionHandlers.find(handler => handler.type === message.type);
        if (visionHandler) {
            try { return await visionHandler.handle(message, {}); }
            catch { return {success: false, error: '识图检测失败，请检查服务配置后重试'}; }
        }

        if (message.type === 'openOptionsPage') {
            openSettings();
            return {success: true};
        }

        if (message.type === 'fullPageTranslationState') return {success: true};

        if (message.type === CONFIG_PERSIST_MESSAGE) {
            await configReady;
            // userscript 没有独立后台 store：发送方已在同一份运行时 config 上乐观合并 patch，
            // message.config 只是字段子集，必须合并回当前配置，不能按整份配置归一化而重置其余设置和凭据。
            const next = message.mode === 'patch' && message.config && typeof message.config === 'object'
                ? prepareConfigPatchRequest(
                    message.config,
                    Object.fromEntries(Object.keys(message.config).map((key) => [key, config[key as keyof typeof config]])),
                    config,
                    true,
                )
                : message.config;
            await saveConfig(next, {recordHistory: true});
            // 与扩展后台契约一致返回提交 revision，发送方据此确认而不是回滚乐观状态。
            return {success: true, revision: getConfigRevision()};
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
                return await inputBoxTranslationHandler.handle(message, requestContext);
            } catch (error) {
                return {success: false, error: error instanceof Error ? error.message : String(error)};
            }
        }

        if (message.type === TRANSLATION_CANCEL_MESSAGE_TYPE) {
            try {return requestRegistry.cancel(message.clientRequestId, requestContext);}
            catch (error) {return {success: false, error: error instanceof Error ? error.message : String(error)};}
        }

        if (message.type === 'selectionWordLookup') {
            try {
                return {success: true, data: await lookupWord(String(message.word || ''), config.selectionDictionarySource)};
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

        // 普通翻译沿用无 type 协议；未知 typed 消息不能因携带 origin 而进入 provider。
        if (!Array.isArray(message) && !Object.hasOwn(message, 'type') && Object.hasOwn(message, 'origin')
            && (typeof message.origin === 'string' || Array.isArray(message.origin))) {
            const request = attachTranslationGlossaryContext(parseTranslationRequest(message), {
                pageUrl: globalThis.location?.href,
                context: message.glossaryContext === 'video' ? 'video' : 'page',
            });
            if (!message.clientRequestId) return translateWithCache(request);
            return requestRegistry.run(message.clientRequestId, requestContext, (signal, ownershipKey) => (
                translateWithCache(attachTranslationRequestControl(request, {signal, ownershipKey}))
            ));
        }

        return UNHANDLED_RUNTIME_MESSAGE;
    };
    return Object.assign(handle, {connect: (port: import('./browser').UserscriptRuntimePort) => {
        if (disposed) port.disconnect(); else getReading().connect(port);
    }, dispose() {
        if (disposed) return;
        disposed = true;
        reading?.dispose();
    }});
}
