/**
 * @file src/features/selection-translation/background/selectionTtsSynthesis.ts
 * 文件职责：按照用户选择编排多源在线 TTS（Edge/有道/Google/OpenAI）、本地 Kokoro TTS、内存 LRU 缓存、并发去重与熔断退避回退。
 * 主要内容：实现在线优先、本地优先、仅在线、仅本地四种策略；支持多在线源按优先级与熔断健康状态自动切换、命中内存音频缓存即时返回及严格保护仅本地隐私边界。
 * 模块边界：只决定合成来源与缓存编排，不播放音频也不访问 DOM；播放、暂停、变速和停止仍由 selectionTts handler 与 Offscreen 负责。
 */

import type {SelectionTtsAudio} from './ttsHandler';
import {normalizeLocalTtsMode, type LocalTtsMode} from '@/src/core/config/localTts';
import {
    normalizeSelectionTtsOnlineSources,
    normalizeSelectionTtsRate,
    normalizeSelectionTtsVoiceOrder,
    type SelectionTtsOnlineSourceId,
} from '@/src/core/config/selectionTts';
import {buildTtsAudioCacheKey, type TtsAudioCache} from '@/src/core/tts/audioCache';
import {classifyTtsError, type TtsCircuitBreaker, type TtsSourceId} from '@/src/core/tts/backoff';
import {
    LOCAL_TTS_LANGUAGE_UNSUPPORTED_CODE,
    LOCAL_TTS_MODEL_NOT_DOWNLOADED_CODE,
    LocalTtsModelNotDownloadedError,
    localTtsErrorCode,
    type LocalTtsAudio,
} from '@/src/features/local-tts/protocol';

export interface SelectionTtsOnlineContext {
    readonly preferredVoices: unknown;
    readonly rate: number;
}

export type SelectionTtsOnlineSourceSynthesizer = (
    text: string,
    language: string,
    context: SelectionTtsOnlineContext,
    signal?: AbortSignal,
) => Promise<SelectionTtsAudio>;

export interface SelectionTtsSynthesisDependencies {
    readonly getMode: () => unknown;
    readonly getLocalVoice: () => unknown;
    readonly getOnlineVoices: () => unknown;
    readonly getRate?: () => unknown;
    readonly getOnlineSources?: () => unknown;
    readonly getExtraVoiceCacheKey?: () => string;
    readonly synthesizeOnline?: (
        text: string,
        language: string,
        preferredVoices: unknown,
        signal?: AbortSignal,
        rate?: number,
    ) => Promise<SelectionTtsAudio>;
    readonly onlineSynthesizers?: Partial<Record<SelectionTtsOnlineSourceId, SelectionTtsOnlineSourceSynthesizer>>;
    readonly synthesizeLocal: (
        text: string,
        language: string,
        voice: string,
        signal?: AbortSignal,
        speed?: number,
    ) => Promise<LocalTtsAudio>;
    readonly cache?: TtsAudioCache;
    readonly breaker?: TtsCircuitBreaker;
    readonly now?: () => number;
}

export interface SelectionTtsSynthesisError extends Error {
    readonly code?: string;
}

/** 模型未下载或语言不支持表示本地来源不可用，而不是一次真正的合成失败。 */
function isLocalTtsUnavailable(error: unknown): boolean {
    const code = localTtsErrorCode(error);
    return code === LOCAL_TTS_MODEL_NOT_DOWNLOADED_CODE || code === LOCAL_TTS_LANGUAGE_UNSUPPORTED_CODE;
}

function localAudio(audio: LocalTtsAudio, fallbackFrom?: TtsSourceId): SelectionTtsAudio {
    return {
        audio: audio.audio,
        ...(audio.timings === undefined ? {} : {timings: audio.timings}),
        contentType: audio.contentType,
        voice: audio.voice,
        ...(fallbackFrom === undefined ? {} : {source: 'local' as const, fallbackFrom}),
    };
}

/** 模型未下载与语言不支持在各分支中已先行处理，这里只需给出真实失败原因。 */
function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function buildVoiceCacheKey(
    mode: string,
    onlineVoices: unknown,
    localVoice: string,
    extraKey: string,
): string {
    if (mode === 'local-only') return `local:${localVoice}`;
    const voices = normalizeSelectionTtsVoiceOrder(onlineVoices).join(',');
    return `online:${voices || 'auto'}|local:${localVoice}${extraKey ? `|${extraKey}` : ''}`;
}

/** 创建可注入的策略合成器，便于单元测试所有来源、缓存与熔断回退顺序。 */
export function createSelectionTtsSynthesizer(
    dependencies: SelectionTtsSynthesisDependencies,
) {
    const now = dependencies.now ?? (() => Date.now());

    async function synthesizeOnlineChain(
        text: string,
        language: string,
        preferredVoices: unknown,
        rate: number | undefined,
        signal?: AbortSignal,
    ): Promise<SelectionTtsAudio> {
        const synthesizers = dependencies.onlineSynthesizers;
        const callLegacyOnline = () => {
            const legacy = dependencies.synthesizeOnline!;
            return rate === undefined
                ? legacy(text, language, preferredVoices, signal)
                : legacy(text, language, preferredVoices, signal, rate);
        };
        if (!synthesizers) return callLegacyOnline();

        const configured = normalizeSelectionTtsOnlineSources(dependencies.getOnlineSources?.())
            .filter((source): source is SelectionTtsOnlineSourceId => typeof synthesizers[source] === 'function');
        if (configured.length === 0) return callLegacyOnline();

        const breaker = dependencies.breaker;
        const ordered = breaker ? (breaker.selectSources(configured) as SelectionTtsOnlineSourceId[]) : configured;
        const effectiveRate = normalizeSelectionTtsRate(rate);
        const failures: string[] = [];
        let firstFailedSource: TtsSourceId | undefined;
        let lastError: unknown;

        for (const source of ordered) {
            signal?.throwIfAborted();
            const run = synthesizers[source]!;
            const startedAt = now();
            breaker?.beginAttempt(source);
            try {
                const audio = await run(text, language, {preferredVoices, rate: effectiveRate}, signal);
                breaker?.recordSourceSuccess(source, now() - startedAt);
                return {
                    ...audio,
                    source: audio.source ?? source,
                    ...(firstFailedSource !== undefined ? {fallbackFrom: firstFailedSource} : {}),
                };
            } catch (error) {
                const classified = classifyTtsError(error);
                if (signal?.aborted || classified.kind === 'abort') {
                    breaker?.cancelAttempt(source);
                    throw error;
                }
                breaker?.recordSourceFailure(source, error);
                if (firstFailedSource === undefined && classified.kind !== 'unsupported') {
                    firstFailedSource = source;
                }
                lastError = error;
                failures.push(`${source}: ${errorText(error)}`);
            }
        }

        if (failures.length === 1 && lastError instanceof Error) throw lastError;
        throw new Error(`在线 TTS 多源均不可用（${failures.join('；')}）`);
    }

    async function synthesizeUncached(
        text: string,
        language: string,
        rate: number | undefined,
        mode: LocalTtsMode,
        signal?: AbortSignal,
    ): Promise<SelectionTtsAudio> {
        signal?.throwIfAborted();
        const onlineVoices = dependencies.getOnlineVoices();
        const localVoice = String(dependencies.getLocalVoice() || 'auto');
        const configuredOnline = normalizeSelectionTtsOnlineSources(dependencies.getOnlineSources?.());
        const primaryOnlineSource = configuredOnline[0]!;
        const online = () => synthesizeOnlineChain(text, language, onlineVoices, rate, signal);
        const local = async (fallbackFrom?: TtsSourceId) => {
            const result = rate === undefined
                ? await dependencies.synthesizeLocal(text, language, localVoice, signal)
                : await dependencies.synthesizeLocal(text, language, localVoice, signal, rate);
            return localAudio(result, fallbackFrom);
        };

        if (mode === 'online-only') return online();
        if (mode === 'local-only') {
            const audio = await local();
            return dependencies.onlineSynthesizers ? {...audio, source: 'local'} : audio;
        }

        if (mode === 'local-first') {
            try {
                const audio = await local();
                return dependencies.onlineSynthesizers ? {...audio, source: 'local'} : audio;
            } catch (localError) {
                signal?.throwIfAborted();
                // 本地错误经 Offscreen 消息重建为普通 Error，只能按错误码识别“不可用”。
                if (isLocalTtsUnavailable(localError)) return online();
                try {
                    const onlineAudio = await online();
                    return dependencies.onlineSynthesizers
                        ? {...onlineAudio, fallbackFrom: 'local'}
                        : onlineAudio;
                } catch (onlineError) {
                    throw new Error(`本地 TTS 和在线 TTS 均失败：${errorText(localError)}；${errorText(onlineError)}`);
                }
            }
        }

        // 默认在线优先。在线失败后才尝试本地，且本地没有模型时不自动下载。
        try {
            return await online();
        } catch (onlineError) {
            signal?.throwIfAborted();
            try {
                return await local(dependencies.onlineSynthesizers ? primaryOnlineSource : undefined);
            } catch (localError) {
                if (localTtsErrorCode(localError) === LOCAL_TTS_MODEL_NOT_DOWNLOADED_CODE) {
                    const error = new LocalTtsModelNotDownloadedError();
                    error.message = `在线 TTS 失败；${error.message}`;
                    throw error;
                }
                if (localTtsErrorCode(localError) === LOCAL_TTS_LANGUAGE_UNSUPPORTED_CODE) throw onlineError;
                throw new Error(`在线 TTS 和本地 TTS 均失败：${errorText(onlineError)}；${errorText(localError)}`);
            }
        }
    }

    return async function synthesizeSelectionTts(
        text: string,
        language: string,
        _preferredVoices: unknown,
        signal?: AbortSignal,
        requestedRate?: number,
        modeOverride?: LocalTtsMode,
    ): Promise<SelectionTtsAudio> {
        signal?.throwIfAborted();
        const mode = modeOverride !== undefined
            ? normalizeLocalTtsMode(modeOverride)
            : normalizeLocalTtsMode(dependencies.getMode());
        const explicitRate = requestedRate !== undefined
            ? normalizeSelectionTtsRate(requestedRate)
            : dependencies.getRate !== undefined
                ? normalizeSelectionTtsRate(dependencies.getRate())
                : undefined;

        const cache = dependencies.cache;
        if (!cache) {
            return synthesizeUncached(text, language, explicitRate, mode, signal);
        }

        const sourceScope = mode === 'local-only'
            ? 'local'
            : normalizeSelectionTtsOnlineSources(dependencies.getOnlineSources?.()).join(',');
        const localVoice = String(dependencies.getLocalVoice() || 'auto');
        const key = buildTtsAudioCacheKey({
            mode,
            sourceScope,
            language,
            voiceKey: buildVoiceCacheKey(mode, dependencies.getOnlineVoices(), localVoice, dependencies.getExtraVoiceCacheKey?.() ?? ''),
            rate: explicitRate ?? 1,
            text,
        });
        const {payload, cached} = await cache.getOrSynthesize(
            key,
            (sharedSignal) => synthesizeUncached(text, language, explicitRate, mode, sharedSignal),
            signal,
        );
        return {
            audio: payload.audio,
            contentType: payload.contentType,
            voice: payload.voice,
            ...(payload.timings === undefined ? {} : {timings: payload.timings}),
            ...(payload.source === undefined ? {} : {source: payload.source}),
            ...(!cached && payload.fallbackFrom !== undefined ? {fallbackFrom: payload.fallbackFrom} : {}),
            ...(cached ? {cached: true} : {}),
        };
    };
}
