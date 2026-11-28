/**
 * @file src/features/local-translation/background/handlers.ts
 *
 * 文件职责：连接设置页的模型操作和离屏下载任务，并广播持久进度。
 * 主要内容：从未知入站数据逐字段校验试译、取消、模型和进度消息，即时转发下载、暂停和删除命令；只接受可信离屏页面的进度，将快照保存到扩展存储供所有设置页订阅。
 * 模块边界：后台不持有下载 Promise 或模型文件，不以页面是否打开决定任务生命周期。
 */
import {isMessageRecord} from '@/src/core/messaging/validation';
import type {LocalTranslationOffscreenOptions, LocalTranslationRequest} from '@/src/platform/offscreen/localTranslation';
import type {LocalTranslationDownloadOptions, LocalTranslationDownloadSnapshot, LocalTranslationModelId} from '@/src/core/config/localTranslation';
import type {LocalTranslationStatus} from '@/src/core/messaging/offscreen';
import type {BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';
import {
    LOCAL_TRANSLATION_MODEL_STATE_KEY, LOCAL_TRANSLATION_DOWNLOAD_STATE_KEY,
    isLocalTranslationModel, normalizeLocalTranslationDownloadSnapshot,
    normalizeLocalTranslationMirrorUrl, normalizeLocalTranslationSourcePreference,
} from '@/src/core/config/localTranslation';

export const LOCAL_TRANSLATION_MODEL_STATE_MESSAGE = 'fluentReadGetLocalTranslationModelState' as const;
export const LOCAL_TRANSLATION_MODEL_PREPARE_MESSAGE = 'fluentReadPrepareLocalTranslationModel' as const;
export const LOCAL_TRANSLATION_MODEL_REMOVE_MESSAGE = 'fluentReadRemoveLocalTranslationModel' as const;
export const LOCAL_TRANSLATION_MODEL_PAUSE_MESSAGE = 'fluentReadPauseLocalTranslationModel' as const;
export const LOCAL_TRANSLATION_PROGRESS_MESSAGE = 'fluentReadLocalTranslationDownloadProgress' as const;

export interface LocalTranslationBackgroundDependencies {
    readonly offscreen: {
        prepare(model: LocalTranslationModelId, keepWarm?: boolean, options?: LocalTranslationDownloadOptions): Promise<LocalTranslationDownloadSnapshot>;
        status(): Promise<LocalTranslationStatus>;
        remove(model: LocalTranslationModelId): Promise<void>;
        pause(model: LocalTranslationModelId): Promise<LocalTranslationDownloadSnapshot>;
        translate(request: LocalTranslationRequest, options?: LocalTranslationOffscreenOptions): Promise<string>;
    };
    readonly storage: {
        get(key: string): Promise<Record<string, unknown>>;
        set(value: Record<string, unknown>): Promise<void>;
    };
    isTrustedProgress(context: unknown): boolean;
}

export function createLocalTranslationBackgroundHandlers(
    dependencies: LocalTranslationBackgroundDependencies,
): readonly BackgroundMessageHandler<unknown>[] {
    let writes = Promise.resolve();
    const trials = new Map<string, AbortController>();
    const modelFrom = (message: unknown) => {
        if (!isMessageRecord(message) || !isLocalTranslationModel(message.model)) throw new Error('LOCAL_TRANSLATION_INVALID_MODEL');
        return message.model;
    };
    return [
        {
            type: 'fluentReadTryLocalTranslation',
            async handle(message: unknown) {
                if (!isMessageRecord(message)) throw new Error('LOCAL_TRANSLATION_INVALID_REQUEST');
                const input = message;
                const model = modelFrom(input);
                if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/u.test(input.requestId)
                    || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000
                    || typeof input.targetLanguage !== 'string') throw new Error('LOCAL_TRANSLATION_INVALID_REQUEST');
                if (trials.has(input.requestId)) throw new Error('LOCAL_TRANSLATION_INVALID_REQUEST');
                const controller = new AbortController();
                trials.set(input.requestId, controller);
                try {
                    const result = await dependencies.offscreen.translate({model, text: input.text, sourceLanguage: 'auto', targetLanguage: input.targetLanguage}, {signal: controller.signal, timeoutMs: 120_000});
                    return {success: true, result};
                } finally { trials.delete(input.requestId); }
            },
        },
        {
            type: 'fluentReadCancelLocalTranslationTrial',
            handle(message: unknown) {
                if (isMessageRecord(message) && typeof message.requestId === 'string' && message.requestId) {
                    trials.get(message.requestId)?.abort();
                }
                return {success: true};
            },
        },
        {
            type: LOCAL_TRANSLATION_MODEL_STATE_MESSAGE,
            async handle() { return {...await dependencies.offscreen.status(), success: true}; },
        },
        {
            type: LOCAL_TRANSLATION_MODEL_PREPARE_MESSAGE,
            async handle(message) {
                const model = modelFrom(message);
                const record = message as unknown as Record<string, unknown>;
                const options: LocalTranslationDownloadOptions = {};
                if (record.preference !== undefined) options.preference = normalizeLocalTranslationSourcePreference(record.preference);
                const mirrorUrl = normalizeLocalTranslationMirrorUrl(record.mirrorUrl);
                if (mirrorUrl) options.mirrorUrl = mirrorUrl;
                const hasOptions = options.preference !== undefined || options.mirrorUrl !== undefined;
                return {...await (hasOptions ? dependencies.offscreen.prepare(model, false, options) : dependencies.offscreen.prepare(model, false)), success: true};
            },
        },
        {
            type: LOCAL_TRANSLATION_MODEL_PAUSE_MESSAGE,
            async handle(message) { return {...await dependencies.offscreen.pause(modelFrom(message)), success: true}; },
        },
        {
            type: LOCAL_TRANSLATION_MODEL_REMOVE_MESSAGE,
            async handle(message) {
                await dependencies.offscreen.remove(modelFrom(message));
                return {...await dependencies.offscreen.status(), success: true};
            },
        },
        {
            type: LOCAL_TRANSLATION_PROGRESS_MESSAGE,
            async handle(message: unknown, context) {
                if (!dependencies.isTrustedProgress(context)) return {success: false};
                const snapshot = normalizeLocalTranslationDownloadSnapshot(isMessageRecord(message) ? message.snapshot : undefined);
                if (!snapshot) return {success: false};
                const write = writes.then(async () => {
                    const stored = await dependencies.storage.get(LOCAL_TRANSLATION_DOWNLOAD_STATE_KEY);
                    const previous = normalizeLocalTranslationDownloadSnapshot(stored[LOCAL_TRANSLATION_DOWNLOAD_STATE_KEY]);
                    const tasks = snapshot.tasks.map((task) => {
                        const prior = previous?.tasks.find((item) => item.model === task.model);
                        return prior && prior.updatedAt > task.updatedAt ? prior : task;
                    });
                    await dependencies.storage.set({
                        [LOCAL_TRANSLATION_DOWNLOAD_STATE_KEY]: {version: 2, tasks},
                        [LOCAL_TRANSLATION_MODEL_STATE_KEY]: tasks.filter((task) => task.phase === 'ready').map((task) => task.model),
                    });
                });
                writes = write.catch(() => undefined);
                await write;
                return {success: true};
            },
        },
    ];
}
