/**
 * @file src/features/selection-translation/background/ttsHandler.ts
 * 文件职责：编排划词朗读的后台消息路由，按标签页、frame、document 与客户端请求编号管理当前播放所有权，把本地 AbortSignal 贯穿播放传输，在多源在线、本地、Google 与页面回退之间传递音频、来源元数据或播放控制。
 * 主要内容：定义 TTS 消息与音频契约，解析标签页、文本、语言、语速及媒体时钟，采用分块 Base64 编码减少大音频 GC；编排播放、停止、5 秒跳转、暂停、继续、实时变速及状态转发；持续进度不释放路由，终态按精确请求清理。
 * 模块边界：本文件不操作页面 Audio 或 speechSynthesis，也不实现具体 TTS 供应商协议；合成由 services 注入，Offscreen 播放由 adapter 注入，内容页控制器负责忽略迟到状态。
 */
import {parseSpeechProgress, parseSpeechPlaybackPosition, type SpeechCue} from '@/src/core/tts/speechProgress';
import type {TtsSourceId} from '@/src/core/tts/backoff';
import {normalizeLocalTtsMode, type LocalTtsMode} from '@/src/core/config/localTts';
import {normalizeSelectionTtsRate, SELECTION_TTS_RATE_LIMITS} from '@/src/core/config/selectionTts';
import {
    parseSelectionTtsClientRequestId,
    parseSelectionTtsPlaybackState,
    parseSelectionTtsRoute,
    parseSelectionTtsTabId,
    sameSelectionTtsRoute,
    type SelectionTtsRoute,
} from '@/src/features/selection-translation/protocol';

export const SELECTION_TTS_PLAYBACK_STATE_MESSAGE_TYPE = 'selectionTtsPlaybackState' as const;
export const SELECTION_TTS_STOP_MESSAGE_TYPE = 'selectionTtsStop' as const;
export const SELECTION_TTS_SEEK_MESSAGE_TYPE = 'selectionTtsSeek' as const;
export const SELECTION_TTS_PAUSE_MESSAGE_TYPE = 'selectionTtsPause' as const;
export const SELECTION_TTS_RESUME_MESSAGE_TYPE = 'selectionTtsResume' as const;
export const SELECTION_TTS_SET_RATE_MESSAGE_TYPE = 'selectionTtsSetRate' as const;
export const SELECTION_TTS_MESSAGE_TYPE = 'selectionTts' as const;
export const SELECTION_TTS_GOOGLE_MESSAGE_TYPE = 'selectionTtsGoogle' as const;

export interface SelectionTtsContext {
    sender?: {
        id?: string;
        frameId?: number;
        documentId?: string;
        url?: string;
        tab?: {
            id?: number;
        };
    };
}

export interface SelectionTtsAudio {
    timings?: SpeechCue[];
    audio: ArrayBuffer;
    contentType: string;
    voice: string;
    source?: TtsSourceId;
    cached?: boolean;
    fallbackFrom?: TtsSourceId;
}

export interface SelectionTtsPlaybackStateMessage {
    type: typeof SELECTION_TTS_PLAYBACK_STATE_MESSAGE_TYPE;
    tabId?: unknown;
    clientRequestId?: unknown;
    state?: unknown;
    error?: unknown;
    progress?: unknown;
    position?: unknown;
}

export interface SelectionTtsSeekMessage {
    type: typeof SELECTION_TTS_SEEK_MESSAGE_TYPE;
    clientRequestId?: unknown;
    offsetSeconds?: unknown;
}

export interface SelectionTtsPauseMessage {
    type: typeof SELECTION_TTS_PAUSE_MESSAGE_TYPE;
    clientRequestId?: unknown;
}

export interface SelectionTtsResumeMessage {
    type: typeof SELECTION_TTS_RESUME_MESSAGE_TYPE;
    clientRequestId?: unknown;
}

export interface SelectionTtsSetRateMessage {
    type: typeof SELECTION_TTS_SET_RATE_MESSAGE_TYPE;
    clientRequestId?: unknown;
    rate?: unknown;
}

export interface SelectionTtsStopMessage {
    type: typeof SELECTION_TTS_STOP_MESSAGE_TYPE;
    clientRequestId?: unknown;
}

export interface SelectionTtsMessage {
    type: typeof SELECTION_TTS_MESSAGE_TYPE;
    text?: unknown;
    language?: unknown;
    clientRequestId?: unknown;
    rate?: unknown;
    modeOverride?: unknown;
}

export interface SelectionTtsGoogleMessage {
    type: typeof SELECTION_TTS_GOOGLE_MESSAGE_TYPE;
    text?: unknown;
    language?: unknown;
    clientRequestId?: unknown;
    rate?: unknown;
}

export type SelectionTtsRuntimeMessage =
    | SelectionTtsPlaybackStateMessage
    | SelectionTtsStopMessage
    | SelectionTtsSeekMessage
    | SelectionTtsPauseMessage
    | SelectionTtsResumeMessage
    | SelectionTtsSetRateMessage
    | SelectionTtsMessage
    | SelectionTtsGoogleMessage;

export interface SelectionTtsPlayAudioRequest extends SelectionTtsRoute {
    text?: string;
    timings?: SpeechCue[];
    audioBase64: string;
    contentType: string;
    rate?: number;
}

export interface SelectionTtsPlaySourceRequest extends SelectionTtsRoute {
    text?: string;
    sourceUrl: string;
    rate?: number;
}

export interface SelectionTtsBackgroundDependencies {
    /** 生产组合根必须注入；省略时保留既有独立 handler 端口契约。 */
    readonly playbackStateSender?: {readonly runtimeId: string; readonly url: string};
    readonly getPreferredVoices: () => unknown;
    readonly getMode?: () => unknown;
    readonly getDefaultRate?: () => unknown;
    readonly synthesize: (
        text: string,
        language: string,
        preferredVoices: unknown,
        signal?: AbortSignal,
        rate?: number,
        modeOverride?: LocalTtsMode,
    ) => Promise<SelectionTtsAudio>;
    readonly playWithOffscreen: (request: SelectionTtsPlayAudioRequest | SelectionTtsPlaySourceRequest, signal?: AbortSignal) => Promise<void>;
    readonly stopWithOffscreen: (route: SelectionTtsRoute) => Promise<void>;
    readonly seekWithOffscreen: (route: SelectionTtsRoute, offsetSeconds: -5 | 5) => Promise<boolean>;
    readonly pauseWithOffscreen?: (route: SelectionTtsRoute) => Promise<boolean>;
    readonly resumeWithOffscreen?: (route: SelectionTtsRoute) => Promise<boolean>;
    readonly setRateWithOffscreen?: (route: SelectionTtsRoute, rate: number) => Promise<boolean>;
    readonly offscreenPlaybackEnabled?: boolean;
    /** 扩展页面没有 tab 路由时，下载 Google 音频并返回调用页面播放。 */
    readonly fetchPageAudio?: (url: string, signal: AbortSignal) => Promise<{audio: ArrayBuffer; contentType: string}>;
    readonly sendTabMessage: (tabId: number, message: unknown, options?: {frameId: number}) => Promise<unknown>;
    readonly warn?: (message: string, error: unknown) => void;
}

export type SelectionTtsResponse =
    | {success: true; transport: 'offscreen'; voice?: string; source?: TtsSourceId; cached?: boolean; fallbackFrom?: TtsSourceId; synthesizedRate?: number}
    | {success: true; transport: 'page'; audioBase64: string; contentType: string; voice: string; timings?: SpeechCue[]; source?: TtsSourceId; cached?: boolean; fallbackFrom?: TtsSourceId; synthesizedRate?: number}
    | {success: false; error: string};

export interface SelectionTtsBackgroundHandler<TMessage extends SelectionTtsRuntimeMessage = SelectionTtsRuntimeMessage> {
    readonly type: TMessage['type'];
    handle(message: TMessage, context: SelectionTtsContext): Promise<unknown>;
}

interface ActiveSelectionTts extends SelectionTtsRoute {
    controller: AbortController;
    playbackStarted: boolean;
}

interface ActivePageSelectionTts {
    owner: string;
    clientRequestId: string;
    controller: AbortController;
}

function pageSenderOwner(context: SelectionTtsContext): string | null {
    if (typeof context.sender?.url !== 'string') return null;
    try {
        const url = new URL(context.sender.url);
        // Options hash navigation can unmount the book before STOP is sent.
        url.hash = '';
        return url.href;
    } catch {
        return null;
    }
}

function parseTabId(context: SelectionTtsContext): number | null {
    const tabId = context.sender?.tab?.id;
    try {
        return parseSelectionTtsTabId(tabId);
    } catch {
        return null;
    }
}

/** 控制路由只能来自浏览器 sender，不能采信 payload 的 tab/frame/page 字段。 */
function senderRoute(context: SelectionTtsContext, tabId: number, clientRequestId: string): SelectionTtsRoute {
    const documentId = context.sender?.documentId;
    const ownerUrl = pageSenderOwner(context);
    return parseSelectionTtsRoute({
        tabId, clientRequestId,
        ...(context.sender?.frameId === undefined ? {} : {frameId: context.sender.frameId}),
        ...(documentId === undefined ? {} : {documentId}),
        // 不支持 documentId 的 Firefox 使用 frame + 每次播放的新 CSPRNG UUID。
        // URL 不是 document 身份；否则 pushState/replaceState 后 STOP/SEEK 会丢失。
        ...(documentId === undefined || ownerUrl === null ? {} : {ownerUrl}),
    });
}

function parseText(value: unknown): string {
    if (typeof value !== 'string') throw new TypeError('TTS 文本为空');
    const text = value.trim();
    if (!text) throw new TypeError('TTS 文本为空');
    return text;
}

function parseLanguage(value: unknown): string {
    return typeof value === 'string' && value.trim() ? value : 'en-US';
}

function parseOptionalRate(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)
        || value < SELECTION_TTS_RATE_LIMITS.min || value > SELECTION_TTS_RATE_LIMITS.max) {
        throw new TypeError('TTS 语速必须在 0.5 到 2.0 之间');
    }
    return Math.round(value * 100) / 100;
}

function parsePlaybackRate(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.25 || value > 4) {
        throw new TypeError('TTS 播放倍速必须在 0.25 到 4.0 之间');
    }
    return Math.round(value * 100) / 100;
}

function parsePreviewModeOverride(value: unknown, isExtensionPage: boolean): LocalTtsMode | undefined {
    if (!isExtensionPage || (value !== 'online-only' && value !== 'local-only')) return undefined;
    return value;
}

/** 分块编码大音频缓冲，避免逐字节拼接字符串造成的 GC 抖动，同时不超过参数上限。 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

export function googleSelectionTtsUrl(text: string, language: string): string {
    return `https://translate.google.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(language)}&client=tw-ob&q=${encodeURIComponent(text)}`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function responseMeta(result: SelectionTtsAudio): {source?: TtsSourceId; cached?: boolean; fallbackFrom?: TtsSourceId} {
    return {
        ...(result.source === undefined ? {} : {source: result.source}),
        ...(result.cached === true ? {cached: true} : {}),
        ...(result.fallbackFrom === undefined ? {} : {fallbackFrom: result.fallbackFrom}),
    };
}

/**
 * 创建划词朗读后台 handlers。状态封装在 factory 作用域内，避免 background
 * 继续持有跨请求状态机。
 */
export function createSelectionTtsBackgroundHandlers(
    dependencies: SelectionTtsBackgroundDependencies,
): SelectionTtsBackgroundHandler[] {
    let activeSelectionTts: ActiveSelectionTts | null = null;
    // Page-audio synthesis has no offscreen playback route. Keep its abort
    // ownership separate from content tabs, even if a client UUID is reused.
    const activePageRequests = new Map<string, Map<string, ActivePageSelectionTts>>();
    const beginPageRequest = (owner: string, clientRequestId: string): ActivePageSelectionTts => {
        const requests = activePageRequests.get(owner) ?? new Map<string, ActivePageSelectionTts>();
        requests.get(clientRequestId)?.controller.abort();
        const request = {owner, clientRequestId, controller: new AbortController()};
        requests.set(clientRequestId, request);
        activePageRequests.set(owner, requests);
        return request;
    };
    const isCurrentPageRequest = (request: ActivePageSelectionTts): boolean =>
        activePageRequests.get(request.owner)?.get(request.clientRequestId) === request;
    const releasePageRequest = (request: ActivePageSelectionTts): void => {
        const requests = activePageRequests.get(request.owner);
        if (!requests || requests.get(request.clientRequestId) !== request) return;
        requests.delete(request.clientRequestId);
        if (requests.size === 0) activePageRequests.delete(request.owner);
    };

    const beginSelectionTts = (route: SelectionTtsRoute): ActiveSelectionTts => {
        const request: ActiveSelectionTts = {
            ...route,
            controller: new AbortController(),
            playbackStarted: false,
        };
        activeSelectionTts = request;
        return request;
    };

    const stopActiveSelectionTts = async (): Promise<void> => {
        const active = activeSelectionTts;
        activeSelectionTts = null;
        if (!active) return;
        active.controller.abort();
        if (active.playbackStarted) {
            await dependencies.stopWithOffscreen(active).catch(() => undefined);
        }
    };

    const stopLatePlayback = async (active: ActiveSelectionTts): Promise<SelectionTtsResponse> => {
        await dependencies.stopWithOffscreen(active).catch(() => undefined);
        return {success: false, error: '语音播放已取消'};
    };

    const playbackStateHandler: SelectionTtsBackgroundHandler<SelectionTtsPlaybackStateMessage> = {
        type: SELECTION_TTS_PLAYBACK_STATE_MESSAGE_TYPE,
        async handle(message, context) {
                const expected = dependencies.playbackStateSender;
                if (expected && (context.sender?.id !== expected.runtimeId
                    || context.sender.url !== expected.url || context.sender.tab !== undefined)) return {success: false};
                let route: SelectionTtsRoute;
                let state: ReturnType<typeof parseSelectionTtsPlaybackState>;
                try {
                    route = parseSelectionTtsRoute(message);
                    state = parseSelectionTtsPlaybackState(message.state);
                } catch {
                    return {success: true};
                }

                // MV3 worker 重建后仍可仅凭 offscreen 自描述消息转发结果。
                if (state !== 'progress' && activeSelectionTts && sameSelectionTtsRoute(activeSelectionTts, route)) {
                    activeSelectionTts = null;
                }
                const payload = {
                    type: 'selectionTtsState',
                    clientRequestId: route.clientRequestId,
                    state,
                    ...(state === 'progress' ? {progress:parseSpeechProgress(message.progress)} : {}),
                    ...(state === 'progress' && message.position !== undefined ? {position:parseSpeechPlaybackPosition(message.position)} : {}),
                    error: typeof message.error === 'string' ? message.error : undefined,
                };
                const delivery = route.frameId === undefined
                    ? dependencies.sendTabMessage(route.tabId, payload)
                    : dependencies.sendTabMessage(route.tabId, payload, {frameId: route.frameId});
                await delivery.catch(() => undefined);
                return {success: true};
        },
    };

    const seekHandler: SelectionTtsBackgroundHandler<SelectionTtsSeekMessage> = {
        type: SELECTION_TTS_SEEK_MESSAGE_TYPE,
        async handle(message, context) {
            const tabId = parseTabId(context);
            if (tabId === null || dependencies.offscreenPlaybackEnabled === false) return {success: false};
            const route = senderRoute(context, tabId, parseSelectionTtsClientRequestId(message.clientRequestId));
            if (message.offsetSeconds !== -5 && message.offsetSeconds !== 5) throw new TypeError('TTS 跳转必须为前进或后退 5 秒');
            // worker 重启后仍交给播放器按精确 route 校验；不建立新的合成或播放请求。
            return {success: await dependencies.seekWithOffscreen(route, message.offsetSeconds)};
        },
    };

    const pauseHandler: SelectionTtsBackgroundHandler<SelectionTtsPauseMessage> = {
        type: SELECTION_TTS_PAUSE_MESSAGE_TYPE,
        async handle(message, context) {
            const tabId = parseTabId(context);
            if (tabId === null || dependencies.offscreenPlaybackEnabled === false || !dependencies.pauseWithOffscreen) {
                return {success: false};
            }
            const route = senderRoute(context, tabId, parseSelectionTtsClientRequestId(message.clientRequestId));
            return {success: await dependencies.pauseWithOffscreen(route)};
        },
    };

    const resumeHandler: SelectionTtsBackgroundHandler<SelectionTtsResumeMessage> = {
        type: SELECTION_TTS_RESUME_MESSAGE_TYPE,
        async handle(message, context) {
            const tabId = parseTabId(context);
            if (tabId === null || dependencies.offscreenPlaybackEnabled === false || !dependencies.resumeWithOffscreen) {
                return {success: false};
            }
            const route = senderRoute(context, tabId, parseSelectionTtsClientRequestId(message.clientRequestId));
            return {success: await dependencies.resumeWithOffscreen(route)};
        },
    };

    const setRateHandler: SelectionTtsBackgroundHandler<SelectionTtsSetRateMessage> = {
        type: SELECTION_TTS_SET_RATE_MESSAGE_TYPE,
        async handle(message, context) {
            const tabId = parseTabId(context);
            if (tabId === null || dependencies.offscreenPlaybackEnabled === false || !dependencies.setRateWithOffscreen) {
                return {success: false};
            }
            const route = senderRoute(context, tabId, parseSelectionTtsClientRequestId(message.clientRequestId));
            const rate = parsePlaybackRate(message.rate);
            return {success: await dependencies.setRateWithOffscreen(route, rate)};
        },
    };

    const stopHandler: SelectionTtsBackgroundHandler<SelectionTtsStopMessage> = {
        type: SELECTION_TTS_STOP_MESSAGE_TYPE,
        async handle(message, context) {
                const tabId = parseTabId(context);
                if (message.clientRequestId === undefined) return {success: true};
                if (tabId === null) {
                    const owner = pageSenderOwner(context);
                    if (owner === null) return {success: true};
                    const requestId = parseSelectionTtsClientRequestId(message.clientRequestId);
                    const active = activePageRequests.get(owner)?.get(requestId);
                    if (active) {active.controller.abort(); releasePageRequest(active);}
                    return {success: true};
                }
                const route = senderRoute(context, tabId, parseSelectionTtsClientRequestId(message.clientRequestId));
                if (activeSelectionTts && sameSelectionTtsRoute(activeSelectionTts, route)) {
                    activeSelectionTts.controller.abort();
                    activeSelectionTts = null;
                }
                // 不依赖 active 内存：worker 重启后 STOP 仍能直达 offscreen。
                await dependencies.stopWithOffscreen(route).catch(() => undefined);
                return {success: true};
        },
    };

    const edgeTtsHandler: SelectionTtsBackgroundHandler<SelectionTtsMessage> = {
        type: SELECTION_TTS_MESSAGE_TYPE,
        async handle(message, context): Promise<SelectionTtsResponse> {
                const text = parseText(message.text);
                const language = parseLanguage(message.language);
                const clientRequestId = parseSelectionTtsClientRequestId(message.clientRequestId);
                const requestedRate = parseOptionalRate(message.rate);
                const tabId = parseTabId(context);
                const modeOverride = parsePreviewModeOverride(message.modeOverride, tabId === null);

                // Content tabs retain one offscreen playback owner. A page
                // request owns only its URL/UUID synthesis and returns page audio.
                const owner = tabId === null ? pageSenderOwner(context) : null;
                const pageRequest = owner === null ? null : beginPageRequest(owner, clientRequestId);
                const route = tabId === null ? null : senderRoute(context, tabId, clientRequestId);
                const stopping = route === null ? Promise.resolve() : stopActiveSelectionTts();
                const active = route === null ? null : beginSelectionTts(route);
                // 停止旧播放可能等待 Offscreen；等待前登记新所有权，让新请求和 STOP
                // 能立即使本次失效，避免旧等待恢复后覆盖已经开始的下一次朗读。
                await stopping;
                if ((active && activeSelectionTts !== active) || (pageRequest && !isCurrentPageRequest(pageRequest))) {
                    return {success: false, error: '语音合成已取消'};
                }
                let result: SelectionTtsAudio;
                const signal = active?.controller.signal ?? pageRequest?.controller.signal;
                try {
                    result = modeOverride !== undefined
                        ? await dependencies.synthesize(text, language, dependencies.getPreferredVoices(), signal, requestedRate, modeOverride)
                        : requestedRate === undefined
                            ? await dependencies.synthesize(text, language, dependencies.getPreferredVoices(), signal)
                            : await dependencies.synthesize(text, language, dependencies.getPreferredVoices(), signal, requestedRate);
                } catch (synthesisError) {
                    if (active && activeSelectionTts === active) {
                        activeSelectionTts = null;
                    }
                    if (pageRequest) releasePageRequest(pageRequest);
                    throw synthesisError;
                }

                const pageStillCurrent = !pageRequest || isCurrentPageRequest(pageRequest);
                if (pageRequest) releasePageRequest(pageRequest);
                if ((active && activeSelectionTts !== active) || !pageStillCurrent) {
                    return {success: false, error: '语音合成已取消'};
                }

                // 仅编码一次 Base64，若 Offscreen 播放失败回退到 page 时直接复用。
                const audioBase64 = arrayBufferToBase64(result.audio);
                const effectiveRate = requestedRate ?? (
                    dependencies.getDefaultRate !== undefined
                        ? normalizeSelectionTtsRate(dependencies.getDefaultRate())
                        : undefined
                );
                // Edge / Local Kokoro / OpenAI 已在合成阶段按语速生成波形，不能再叠加 playbackRate（避免 rate²）。
                const speedAppliedInAudio = result.source !== 'youdao' && result.source !== 'google';
                const playbackRate = !speedAppliedInAudio ? effectiveRate : undefined;
                const synthesizedRateMeta = effectiveRate !== undefined
                    ? {synthesizedRate: speedAppliedInAudio ? effectiveRate : 1}
                    : {};

                if (tabId !== null && active && dependencies.offscreenPlaybackEnabled !== false) {
                    active.playbackStarted = true;
                    try {
                        await dependencies.playWithOffscreen({
                            audioBase64,
                            text,
                            ...(result.timings === undefined ? {} : {timings: result.timings}),
                            ...(playbackRate === undefined ? {} : {rate: playbackRate}),
                            contentType: result.contentType,
                            ...parseSelectionTtsRoute(active),
                        }, active.controller.signal);
                        if (activeSelectionTts !== active) {
                            // 步骤 2：STOP 可能早于 PLAY 生效；PLAY 成功返回后必须二次 STOP 清理 late playback。
                            return stopLatePlayback(active);
                        }
                        return {success: true, transport: 'offscreen', voice: result.voice, ...responseMeta(result), ...synthesizedRateMeta};
                    } catch (offscreenError) {
                        const stillCurrent = activeSelectionTts === active;
                        if (stillCurrent) {
                            activeSelectionTts = null;
                        }
                        if (!stillCurrent) return stopLatePlayback(active);
                        dependencies.warn?.('Offscreen TTS playback unavailable, returning page audio:', offscreenError);
                    }
                }

                if (activeSelectionTts === active) activeSelectionTts = null;

                return {
                    success: true,
                    audioBase64,
                    contentType: result.contentType,
                    voice: result.voice,
                    transport: 'page',
                    ...(result.timings === undefined ? {} : {timings: result.timings}),
                    ...responseMeta(result),
                    ...synthesizedRateMeta,
                };
        },
    };

    const googleTtsHandler: SelectionTtsBackgroundHandler<SelectionTtsGoogleMessage> = {
        type: SELECTION_TTS_GOOGLE_MESSAGE_TYPE,
        async handle(message, context): Promise<SelectionTtsResponse> {
                const text = parseText(message.text);
                const language = parseLanguage(message.language);
                const clientRequestId = parseSelectionTtsClientRequestId(message.clientRequestId);
                const requestedRate = parseOptionalRate(message.rate);
                // 仅本地模式作为后台硬隐私边界，阻止来自陈旧标签页配置的 Google 外发请求。
                if (dependencies.getMode !== undefined && normalizeLocalTtsMode(dependencies.getMode()) === 'local-only') {
                    return {success: false, error: '当前处于仅本地朗读模式'};
                }
                const tabId = parseTabId(context);
                if (tabId === null) {
                    const owner = pageSenderOwner(context);
                    if (owner === null) return {success: false, error: '无法确定当前标签页'};
                    if (!dependencies.fetchPageAudio) return {success: false, error: '扩展页面 Google TTS 不可用'};
                    const request = beginPageRequest(owner, clientRequestId);
                    try {
                        const result = await dependencies.fetchPageAudio(googleSelectionTtsUrl(text, language), request.controller.signal);
                        if (!isCurrentPageRequest(request)) return {success: false, error: '语音播放已取消'};
                        releasePageRequest(request);
                        return {success: true, transport: 'page', audioBase64: arrayBufferToBase64(result.audio), contentType: result.contentType, voice: 'Google TTS'};
                    } catch (error) {
                        releasePageRequest(request);
                        return {success: false, error: errorMessage(error)};
                    }
                }

                // 步骤 1：Google fallback 与 Edge 共用单例播放状态，新请求同样先取消旧播放。
                const route = senderRoute(context, tabId, clientRequestId);
                const stopping = stopActiveSelectionTts();
                const active = beginSelectionTts(route);
                await stopping;
                if (activeSelectionTts !== active) return {success: false, error: '语音播放已取消'};
                if (dependencies.offscreenPlaybackEnabled === false) {
                    activeSelectionTts = null;
                    return {success: false, error: '当前浏览器暂不支持 Google TTS 扩展播放'};
                }

                active.playbackStarted = true;
                try {
                    await dependencies.playWithOffscreen({
                        sourceUrl: googleSelectionTtsUrl(text, language),
                        text,
                        ...(requestedRate === undefined ? {} : {rate: requestedRate}),
                        ...parseSelectionTtsRoute(active),
                    }, active.controller.signal);
                    if (activeSelectionTts !== active) return stopLatePlayback(active);
                    return {success: true, transport: 'offscreen'};
                } catch (offscreenError) {
                    const stillCurrent = activeSelectionTts === active;
                    if (stillCurrent) {
                        activeSelectionTts = null;
                    } else {
                        await dependencies.stopWithOffscreen(active).catch(() => undefined);
                    }
                    return stillCurrent
                        ? {success: false, error: errorMessage(offscreenError)}
                        : {success: false, error: '语音播放已取消'};
                }
        },
    };

    return [playbackStateHandler, stopHandler, seekHandler, pauseHandler, resumeHandler, setRateHandler, edgeTtsHandler, googleTtsHandler];
}
