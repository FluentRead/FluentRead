/**
 * @file src/features/video-subtitle/background/handlers.ts
 * 文件职责：承载视频字幕本地 Whisper 的后台所有权、代际取消和 Offscreen 调度。
 * 主要内容：按共享消息 DTO 校验外部输入与离屏回复，校验 tab/stream/generation 与预下载来源偏好，串行转发识别、预热与取消请求，在等待旧代取消后、向 Offscreen 派发前及响应返回后复验当前所有者，阻止已取消或被接管的旧代工作重新启动；用真实缓存键核对模型下载登记后的可用状态。
 * 模块边界：只编排视频字幕与平台 Offscreen client，不实现 Whisper 推理，也不关闭共享 Offscreen 文档。
 */
import {parseMessage} from '@/src/core/messaging/validation';
import {isVideoBackgroundInput, NATIVE_QWEN_ASR_MODEL, type VideoBackgroundInput} from '@/src/core/messaging/video';
import type {VideoTranscriptionProvider} from '@/src/core/config/model';
import {transcribeNativeQwenPcm16} from './nativeTranscription';
import {sendOffscreenRequest, sendOffscreenRequestIfPresent} from '@/src/platform/offscreen/requests';
import type {OffscreenClient} from '@/src/platform/offscreen/client';
import {VIDEO_LOCAL_TRANSCRIPTION_MODELS, VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY, VIDEO_LOCAL_TRANSCRIPTION_STATE_MESSAGE, getVideoLocalTranscriptionRequestTimeoutMs, normalizeVideoLocalTranscriptionModels, normalizeVideoLocalTranscriptionModel} from '@/src/features/video-subtitle/transcription';
import {VideoAiCanceledGenerationRegistry} from '@/src/features/video-subtitle/content/video-ai/generationRegistry';
import {readCachedVideoAiModels} from '@/src/features/video-subtitle/offscreen/modelCache';
import type {BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';

type Owner = {tabId: number; streamId: string; generation: number};
type ActiveOwner = Owner & {provider: VideoTranscriptionProvider; nativeBaseUrl: string; model: string; sourceLanguage: string; controller: AbortController};
type Context = {sender?: {tab?: {id?: number}}};
type Store = {get(key: string): Promise<Record<string, unknown>>; set(value: Record<string, unknown>): Promise<void>};
let releaseOwnerForTab: ((tabId: number) => void) | undefined;

export interface VideoSubtitleBackgroundDependencies {
    readonly offscreen: OffscreenClient;
    readonly storage: Store;
    readonly closeWhenIdle?: () => Promise<void>;
    readonly readNativeSettings?: () => {enabled: boolean; provider: VideoTranscriptionProvider; baseUrl: string; sourceLanguage: string};
    readonly nativeTranscribe?: typeof transcribeNativeQwenPcm16;
}

function tabId(context: Context): number { return typeof context.sender?.tab?.id === 'number' ? context.sender.tab.id : -1; }
function validGeneration(value: number | undefined): number { return value === undefined ? 0 : Math.max(0, Math.floor(value)); }
function stream(value: string | undefined): string { return value === undefined ? '' : value.trim(); }
function key(owner: Owner): string { return `${owner.tabId}:${owner.streamId}:${owner.generation}`; }
function workerStream(owner: Owner): string { return `tab:${owner.tabId}:${owner.streamId}:generation:${owner.generation}`; }
function ownerFrom(message: {streamId?: string; generation?: number}, context: Context): Owner {
    const result = {tabId: tabId(context), streamId: stream(message.streamId), generation: validGeneration(message.generation)};
    if (!result.streamId || result.generation <= 0) throw new Error('本地视频 AI 字幕缺少流标识');
    return result;
}

function parseVideoBackgroundMessage(value: unknown): VideoBackgroundInput {
    return parseMessage(value, isVideoBackgroundInput, '本地视频 AI');
}

export function createVideoSubtitleBackgroundHandlers(dependencies: VideoSubtitleBackgroundDependencies): readonly BackgroundMessageHandler<Context>[] {
    const offscreen = dependencies.offscreen;
    const cancelled = new VideoAiCanceledGenerationRegistry();
    let owner: ActiveOwner | null = null;
    let nativeWork: {owner: ActiveOwner; work: Promise<unknown>} | null = null;
    const nativeAdmissions = new Set<ActiveOwner>();
    let activeModelRequests = 0;
    let removingModel = false;
    releaseOwnerForTab = (tab: number) => {
        if (owner?.tabId !== tab) return;
        const previous = owner;
        owner = null;
        void cancelOwner(previous).catch(() => undefined);
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
    const cancelOwner = async (next: ActiveOwner) => {
        cancelled.mark(next);
        next.controller.abort();
        if (next.provider === 'native-qwen') {
            if (nativeWork?.owner === next) await nativeWork.work.catch(() => undefined);
            return;
        }
        await sendOffscreenRequestIfPresent(offscreen, {type: 'VIDEO_AI_CANCEL', streamId: workerStream(next)}, {timeoutMs: 5_000});
    };
    const claimOwner = (next: Owner, message: VideoBackgroundInput): ActiveOwner => {
        const provider = message.provider || 'browser';
        const nativeBaseUrl = provider === 'native-qwen' ? (message.nativeBaseUrl || '').trim() : '';
        const model = provider === 'native-qwen' ? NATIVE_QWEN_ASR_MODEL : normalizeVideoLocalTranscriptionModel(message.model);
        const sourceLanguage = message.sourceLanguage?.trim() || 'auto';
        if (provider === 'native-qwen' && message.model !== NATIVE_QWEN_ASR_MODEL) throw new Error('原生转写模型与请求不一致');
        if (owner && key(owner) === key(next)) {
            if (owner.provider !== provider || owner.nativeBaseUrl !== nativeBaseUrl
                || (provider === 'native-qwen' && (owner.model !== model || owner.sourceLanguage !== sourceLanguage))) {
                throw new Error('识别配置已改变，请重新请求 AI 字幕');
            }
            return owner;
        }
        return {...next, provider, nativeBaseUrl, model, sourceLanguage, controller: new AbortController()};
    };
    const assertNativeSettings = (target: ActiveOwner): void => {
        const settings = dependencies.readNativeSettings?.();
        if (!settings?.enabled || settings.provider !== 'native-qwen'
            || settings.baseUrl !== target.nativeBaseUrl || settings.sourceLanguage !== target.sourceLanguage) {
            throw new Error('本机转写选择、地址或语言已改变，请重新请求 AI 字幕');
        }
    };
    const assertCurrentOwner = (requestOwner: Owner): void => {
        if (cancelled.has(requestOwner) || owner !== requestOwner) throw new Error('本地视频 AI 字幕 generation 已取消');
    };
    const transcribe: BackgroundMessageHandler<Context> = {
        type: 'fluentReadTranscribeLocalVideoAudio',
        async handle(input: unknown, context) {
            const message = parseVideoBackgroundMessage(input);
            const next = ownerFrom(message, context);
            const previous = assertOwner(next);
            const requestOwner = claimOwner(next, message);
            if (requestOwner.provider === 'native-qwen' && nativeAdmissions.has(requestOwner)) {
                throw new Error('本机转写仍在进行，请等待当前音频窗口完成');
            }
            if (requestOwner.provider === 'native-qwen') nativeAdmissions.add(requestOwner);
            owner = requestOwner;
            try {
                if (previous) await cancelOwner(previous);
                assertCurrentOwner(requestOwner);
                if (requestOwner.provider === 'native-qwen') {
                    if (nativeWork) await nativeWork.work.catch(() => undefined);
                    assertCurrentOwner(requestOwner);
                    assertNativeSettings(requestOwner);
                    if (!message.audioPcm16Base64) throw new Error('原生转写需要 PCM16 音频');
                    // Serial fullCapture must not replace a pending audio window.
                    // Claim before invoking any transport callback.
                    const record = {owner: requestOwner, work: Promise.resolve().then(async () => {
                        assertCurrentOwner(requestOwner);
                        assertNativeSettings(requestOwner);
                        const result = await (dependencies.nativeTranscribe || transcribeNativeQwenPcm16)(message.audioPcm16Base64!, {
                            baseUrl: requestOwner.nativeBaseUrl, signal: requestOwner.controller.signal,
                            sourceLanguage: requestOwner.sourceLanguage.toLowerCase().replaceAll('_', '-').split('-')[0],
                        });
                        assertCurrentOwner(requestOwner);
                        assertNativeSettings(requestOwner);
                        return {...result, success: true, provider: 'native-qwen', timingSource: 'audio-window'};
                    })};
                    nativeWork = record;
                    try { return await record.work; }
                    finally { if (nativeWork === record) nativeWork = null; }
                }
                const response = await sendOffscreenRequest(offscreen, {type: 'VIDEO_AI_TRANSCRIBE', streamId: workerStream(next), model: normalizeVideoLocalTranscriptionModel(message.model), sourceLanguage: message.sourceLanguage, audioPcm16Base64: message.audioPcm16Base64, audioBase64: message.audioBase64}, {signal: requestOwner.controller.signal, timeoutMs: getVideoLocalTranscriptionRequestTimeoutMs(message.model), cancelMessage: {type: 'VIDEO_AI_CANCEL', streamId: workerStream(next)}});
                assertCurrentOwner(requestOwner);
                return response;
            } catch (error) {
                cancelled.mark(requestOwner);
                requestOwner.controller.abort();
                if (owner === requestOwner) owner = null;
                throw error;
            } finally {
                nativeAdmissions.delete(requestOwner);
            }
        },
    };
    const prepare: BackgroundMessageHandler<Context> = {
        type: 'fluentReadPrepareLocalVideoModel',
        async handle(input: unknown, context) {
            const message = parseVideoBackgroundMessage(input);
            const keepWarm = message.keepWarm === true;
            if (!keepWarm) {
                if (message.provider === 'native-qwen') throw new Error('原生模型由本机服务管理，不通过浏览器下载');
                const model = normalizeVideoLocalTranscriptionModel(message.model);
                const preference = message.preference === 'official' || message.preference === 'mirror' ? message.preference : 'auto';
                // 下载器总预算十分钟；RPC 留出关闭流和返回错误的余量，避免任务先丢失回包。
                const response = await sendOffscreenRequest(offscreen, {type: 'VIDEO_AI_PREPARE', model, keepWarm: false, preference}, {timeoutMs: 630_000});
                if (response?.success !== true) return response;
                const models = await rememberDownloadedModel(model);
                return {...response, model, models};
            }
            const next = ownerFrom(message, context);
            const previous = assertOwner(next);
            const requestOwner = claimOwner(next, message);
            owner = requestOwner;
            try {
                if (previous) await cancelOwner(previous);
                assertCurrentOwner(requestOwner);
                if (requestOwner.provider === 'native-qwen') {
                    assertNativeSettings(requestOwner);
                    return {success: true, model: NATIVE_QWEN_ASR_MODEL, provider: 'native-qwen', preparation: 'client-only'};
                }
                const model = normalizeVideoLocalTranscriptionModel(message.model);
                const response = await sendOffscreenRequest(offscreen, {type: 'VIDEO_AI_PREPARE', streamId: workerStream(next), model, keepWarm: true}, {signal: requestOwner.controller.signal, timeoutMs: model === 'small' ? 600_000 : 120_000, cancelMessage: {type: 'VIDEO_AI_CANCEL', streamId: workerStream(next)}});
                if (response?.success !== true) {
                    cancelled.mark(requestOwner);
                    requestOwner.controller.abort();
                    if (owner === requestOwner) owner = null;
                    return response;
                }
                assertCurrentOwner(requestOwner);
                const models = await rememberDownloadedModel(model);
                assertCurrentOwner(requestOwner);
                return {...response, model, models};
            } catch (error) {
                // Retire shared work before dropping the handle needed to cancel it.
                cancelled.mark(requestOwner);
                requestOwner.controller.abort();
                if (owner === requestOwner) owner = null;
                throw error;
            }
        },
    };
    const cancel: BackgroundMessageHandler<Context> = {
        type: 'fluentReadCancelLocalVideoTranscription',
        async handle(input: unknown, context) {
            const message = parseVideoBackgroundMessage(input);
            const next = ownerFrom(message, context);
            cancelled.mark(next);
            if (!owner || key(owner) !== key(next)) return {success: true, stale: true};
            const target = owner;
            owner = null;
            if (target.provider === 'native-qwen') {
                if (message.reason !== 'complete') target.controller.abort();
                if (nativeWork?.owner === target) await nativeWork.work.catch(() => undefined);
                return message.reason === 'complete' ? {success: true, completed: true} : {success: true};
            }
            if (message.reason === 'complete') {
                await sendOffscreenRequestIfPresent(offscreen, {type: 'VIDEO_AI_CANCEL', streamId: workerStream(next), reason: 'complete'}, {timeoutMs: 5_000});
                return {success: true, completed: true};
            }
            target.controller.abort();
            await sendOffscreenRequestIfPresent(offscreen, {type: 'VIDEO_AI_CANCEL', streamId: workerStream(next)}, {timeoutMs: 5_000});
            await dependencies.closeWhenIdle?.();
            return {success: true};
        },
    };
    const modelState: BackgroundMessageHandler<Context> = {
        type: VIDEO_LOCAL_TRANSCRIPTION_STATE_MESSAGE,
        async handle() {
            await stateWriteQueue;
            const stored = await readStore.get(VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY);
            const models = await readCachedVideoAiModels(stored[VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY]);
            return {
                success: true,
                models,
                available: Object.fromEntries(VIDEO_LOCAL_TRANSCRIPTION_MODELS.map(({value}) => [value, models.includes(value)])),
            };
        },
    };
    const removeModel: BackgroundMessageHandler<Context> = {
        type: 'fluentReadRemoveLocalVideoModel',
        async handle(input: unknown) {
            const message = parseVideoBackgroundMessage(input);
            if (!VIDEO_LOCAL_TRANSCRIPTION_MODELS.some(item => item.value === message.model)) throw new Error('无效的本地字幕模型');
            if (owner || activeModelRequests || removingModel) throw new Error('模型正在使用或下载，请结束后再清除');
            removingModel = true;
            const model = normalizeVideoLocalTranscriptionModel(message.model);
            let models: ReturnType<typeof normalizeVideoLocalTranscriptionModels> = [];
            const write = stateWriteQueue.then(async () => {
                const response = await sendOffscreenRequest(offscreen, {type: 'VIDEO_AI_REMOVE_MODEL', model}, {timeoutMs: 30_000});
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
