/**
 * @file src/features/video-subtitle/background/handlers.ts
 * 文件职责：承载视频字幕本地 Whisper 的后台所有权、代际取消和 Offscreen 调度。
 * 主要内容：校验 tab/stream/generation，串行转发识别、预热与取消请求，并同步模型缓存状态。
 * 模块边界：只编排视频字幕与平台 Offscreen client，不实现 Whisper 推理，也不关闭共享 Offscreen 文档。
 */
import type {OffscreenClient} from '@/src/platform/offscreen/client';
import {VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY, VIDEO_LOCAL_TRANSCRIPTION_STATE_MESSAGE, normalizeVideoLocalTranscriptionModels, normalizeVideoLocalTranscriptionModel} from '@/src/features/video-subtitle/transcription';
import {VideoAiCanceledGenerationRegistry} from '@/src/features/video-subtitle/content/video-ai/generationRegistry';
import type {BackgroundMessageHandler} from '@/src/app/background/messageRouter';

type Owner = {tabId: number; streamId: string; generation: number};
type Context = {sender?: {tab?: {id?: number}}};
type Store = {get(key: string): Promise<Record<string, unknown>>; set(value: Record<string, unknown>): Promise<void>};
let releaseOwnerForTab: ((tabId: number) => void) | undefined;

export interface VideoSubtitleBackgroundDependencies {
    readonly offscreen: OffscreenClient;
    readonly storage: Store;
    readonly closeWhenIdle?: () => Promise<void>;
}

function tabId(context: Context): number { return typeof context.sender?.tab?.id === 'number' ? context.sender.tab.id : -1; }
function validGeneration(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0; }
function stream(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function key(owner: Owner): string { return `${owner.tabId}:${owner.streamId}:${owner.generation}`; }
function workerStream(owner: Owner): string { return `tab:${owner.tabId}:${owner.streamId}:generation:${owner.generation}`; }
function ownerFrom(message: Record<string, unknown>, context: Context): Owner {
    const result = {tabId: tabId(context), streamId: stream(message.streamId), generation: validGeneration(message.generation)};
    if (!result.streamId || result.generation <= 0) throw new Error('本地视频 AI 字幕缺少流标识');
    return result;
}

export function createVideoSubtitleBackgroundHandlers(dependencies: VideoSubtitleBackgroundDependencies): readonly BackgroundMessageHandler<Context>[] {
    const offscreen = dependencies.offscreen;
    const cancelled = new VideoAiCanceledGenerationRegistry();
    let owner: Owner | null = null;
    let activeModelRequests = 0;
    let removingModel = false;
    releaseOwnerForTab = (tab: number) => {
        if (owner?.tabId !== tab) return;
        const previous = owner;
        owner = null;
        cancelled.mark(previous);
        void offscreen.sendIfPresent({type: 'VIDEO_AI_CANCEL', streamId: workerStream(previous)}, {timeoutMs: 5_000}).catch(() => undefined);
    };
    const readStore = dependencies.storage;
    let stateWriteQueue: Promise<void> = Promise.resolve();
    const rememberDownloadedModel = async (model: ReturnType<typeof normalizeVideoLocalTranscriptionModel>): Promise<ReturnType<typeof normalizeVideoLocalTranscriptionModels>> => {
        let models: ReturnType<typeof normalizeVideoLocalTranscriptionModels> = [];
        const write = stateWriteQueue.then(async () => {
            const stored = await readStore.get(VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY);
            models = normalizeVideoLocalTranscriptionModels([
                ...normalizeVideoLocalTranscriptionModels(stored[VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY]),
                model,
            ]);
            await readStore.set({[VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY]: models});
        });
        stateWriteQueue = write.then(() => undefined, () => undefined);
        await write;
        return models;
    };

    const assertOwner = (next: Owner) => {
        if (cancelled.has(next)) throw new Error('本地视频 AI 字幕 generation 已取消');
        if (owner && (owner.tabId !== next.tabId || owner.streamId !== next.streamId)) throw new Error('另一个标签页正在使用本地 AI 字幕，请先停止后再试');
        if (owner && owner.generation !== next.generation) return owner;
        return null;
    };
    const cancelOwner = async (next: Owner) => {
        cancelled.mark(next);
        await offscreen.sendIfPresent<{success?: boolean}>({type: 'VIDEO_AI_CANCEL', streamId: workerStream(next)}, {timeoutMs: 5_000});
    };
    const transcribe: BackgroundMessageHandler<Context> = {
        type: 'fluentReadTranscribeLocalVideoAudio',
        async handle(message: any, context) {
            const next = ownerFrom(message, context);
            const previous = assertOwner(next);
            const requestOwner = owner && key(owner) === key(next) ? owner : next;
            owner = requestOwner;
            try {
                if (previous) await cancelOwner(previous);
                const response = await offscreen.send<any>({type: 'VIDEO_AI_TRANSCRIBE', streamId: workerStream(next), model: normalizeVideoLocalTranscriptionModel(message.model), sourceLanguage: message.sourceLanguage, audioPcm16Base64: message.audioPcm16Base64, audioBase64: message.audioBase64}, {timeoutMs: 40_000, cancelMessage: {type: 'VIDEO_AI_CANCEL', streamId: workerStream(next)}});
                if (cancelled.has(next) || owner !== requestOwner) throw new Error('本地视频 AI 字幕 generation 已取消');
                return {success: true, ...response};
            } catch (error) {
                if (owner === requestOwner) owner = null;
                throw error;
            }
        },
    };
    const prepare: BackgroundMessageHandler<Context> = {
        type: 'fluentReadPrepareLocalVideoModel',
        async handle(message: any, context) {
            const keepWarm = message.keepWarm === true;
            if (!keepWarm) {
                const model = normalizeVideoLocalTranscriptionModel(message.model);
                const response = await offscreen.send<any>({type: 'VIDEO_AI_PREPARE', model, keepWarm: false}, {timeoutMs: 120_000});
                if (response?.success !== true) return response;
                const models = await rememberDownloadedModel(model);
                return {...response, model, models};
            }
            const next = ownerFrom(message, context);
            const previous = assertOwner(next);
            const requestOwner = owner && key(owner) === key(next) ? owner : next;
            owner = requestOwner;
            try {
                if (previous) await cancelOwner(previous);
                const model = normalizeVideoLocalTranscriptionModel(message.model);
                const response = await offscreen.send<any>({type: 'VIDEO_AI_PREPARE', streamId: workerStream(next), model, keepWarm: true}, {timeoutMs: 120_000, cancelMessage: {type: 'VIDEO_AI_CANCEL', streamId: workerStream(next)}});
                if (response?.success !== true) {
                    if (owner === requestOwner) owner = null;
                    return response;
                }
                if (cancelled.has(next) || owner !== requestOwner) throw new Error('本地视频 AI 字幕 generation 已取消');
                const models = await rememberDownloadedModel(model);
                if (cancelled.has(next) || owner !== requestOwner) throw new Error('本地视频 AI 字幕 generation 已取消');
                return {success: true, ...response, model, models};
            } catch (error) {
                if (owner === requestOwner) owner = null;
                throw error;
            }
        },
    };
    const cancel: BackgroundMessageHandler<Context> = {
        type: 'fluentReadCancelLocalVideoTranscription',
        async handle(message: any, context) {
            const next = ownerFrom(message, context);
            if (!owner || key(owner) !== key(next)) return {success: true, stale: true};
            cancelled.mark(next);
            owner = null;
            if (message.reason === 'complete') {
                await offscreen.sendIfPresent({type: 'VIDEO_AI_CANCEL', streamId: workerStream(next), reason: 'complete'}, {timeoutMs: 5_000});
                return {success: true, completed: true};
            }
            await offscreen.sendIfPresent<{success?: boolean}>({type: 'VIDEO_AI_CANCEL', streamId: workerStream(next)}, {timeoutMs: 5_000});
            await dependencies.closeWhenIdle?.();
            return {success: true};
        },
    };
    const modelState: BackgroundMessageHandler<Context> = {
        type: VIDEO_LOCAL_TRANSCRIPTION_STATE_MESSAGE,
        async handle() {
            await stateWriteQueue;
            const stored = await readStore.get(VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY);
            const models = normalizeVideoLocalTranscriptionModels(stored[VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY]);
            return {
                success: true,
                models,
                available: Object.fromEntries(['tiny', 'base'].map((model) => [model, models.includes(model as 'tiny' | 'base')])),
            };
        },
    };
    const removeModel: BackgroundMessageHandler<Context> = {
        type: 'fluentReadRemoveLocalVideoModel',
        async handle(message: any) {
            if (message.model !== 'tiny' && message.model !== 'base') throw new Error('无效的本地字幕模型');
            if (owner || activeModelRequests || removingModel) throw new Error('模型正在使用或下载，请结束后再清除');
            removingModel = true;
            const model = message.model;
            let models: ReturnType<typeof normalizeVideoLocalTranscriptionModels> = [];
            const write = stateWriteQueue.then(async () => {
                const response = await offscreen.send<any>({type: 'VIDEO_AI_REMOVE_MODEL', model}, {timeoutMs: 30_000});
                if (!response?.success) throw new Error(response?.error || '模型清除失败');
                const stored = await readStore.get(VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY);
                models = normalizeVideoLocalTranscriptionModels(stored[VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY]).filter(item => item !== model);
                await readStore.set({[VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY]: models});
            });
            stateWriteQueue = write.then(() => undefined, () => undefined);
            try { await write; return {success: true, models}; }
            finally { removingModel = false; }
        },
    };
    const guardModelRequest = (handler: BackgroundMessageHandler<Context>): BackgroundMessageHandler<Context> => ({
        ...handler,
        async handle(message, context) {
            if (removingModel) throw new Error('正在清除模型，请稍后重试');
            activeModelRequests += 1;
            try { return await handler.handle(message, context); }
            finally { activeModelRequests -= 1; }
        },
    });
    return [guardModelRequest(transcribe), guardModelRequest(prepare), cancel, modelState, removeModel];
}

export function releaseVideoSubtitleOwnerForTab(tabId: number): void {
    releaseOwnerForTab?.(tabId);
}
