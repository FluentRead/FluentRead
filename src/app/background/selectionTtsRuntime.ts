/**
 * @file src/app/background/selectionTtsRuntime.ts
 * 文件职责：在后台组合根中装配划词朗读的多源合成器、LRU 音频缓存、熔断退避器和 Offscreen 播放/控制处理器。
 * 主要内容：组合 Edge/有道/Google/OpenAI 在线多源与本地 Kokoro 合成器，绑定语速、音色偏好与加密 OpenAI 凭据，并把播放、停止、跳转、暂停、继续与实时变速路由接入后台消息总线。
 * 模块边界：本文件属于 app/background 装配层，只负责依赖组装与能力门控，不实现具体 TTS 供应商协议、熔断算法或 Audio 播放逻辑。
 */
import browser from 'webextension-polyfill';
import type {BrowserCapabilities} from '@/src/platform/browser/capabilities';
import type {BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';
import {config} from '@/src/services/config/store';
import {getServiceApiKeys} from '@/src/core/config/apiKeys';
import {TtsAudioCache} from '@/src/core/tts/audioCache';
import {TtsCircuitBreaker} from '@/src/core/tts/backoff';
import {localTtsOffscreenAdapter} from '@/src/features/local-tts/background/offscreenAdapter';
import {selectionTtsOffscreenAdapter} from '@/src/features/selection-translation/background/offscreenAdapter';
import {createSelectionTtsSynthesizer} from '@/src/features/selection-translation/background/selectionTtsSynthesis';
import {synthesizeEdgeTts} from '@/src/features/selection-translation/services/edgeTts';
import {synthesizeYoudaoTts} from '@/src/features/selection-translation/services/youdaoTts';
import {synthesizeGoogleTts} from '@/src/features/selection-translation/services/googleTts';
import {synthesizeOpenAiTts} from '@/src/features/selection-translation/services/openAiTts';
import {createCapabilityGatedSelectionTtsTransport} from './capabilityRegistry';
import {createSelectionTtsBackgroundHandlers} from './handlers/selectionTts';
import type {BackgroundRuntimeContext} from './messageRuntimeTypes';

export function createSelectionTtsRuntimeHandlers(
    capabilities: BrowserCapabilities,
): Array<BackgroundMessageHandler<BackgroundRuntimeContext>> {
    const selectionTtsTransport = createCapabilityGatedSelectionTtsTransport(capabilities, selectionTtsOffscreenAdapter);
    const ttsCircuitBreaker = new TtsCircuitBreaker();
    const ttsAudioCache = new TtsAudioCache();
    const selectionTtsSynthesizer = createSelectionTtsSynthesizer({
        getMode: () => config.selectionTtsMode,
        getLocalVoice: () => config.selectionTtsLocalVoice,
        getOnlineVoices: () => config.selectionTtsVoices,
        getRate: () => config.selectionTtsRate,
        getOnlineSources: () => config.selectionTtsOnlineSources,
        getExtraVoiceCacheKey: () => `${config.selectionTtsOpenAiModel}:${config.selectionTtsOpenAiVoice}:${config.proxy.openai || ''}:${getServiceApiKeys(config, 'openai').length > 0 ? 'k1' : 'k0'}`,
        onlineSynthesizers: {
            edge: (text, language, context, signal) =>
                synthesizeEdgeTts(text, language, context.preferredVoices, signal, {rate: context.rate, breaker: ttsCircuitBreaker}),
            youdao: (text, language, _context, signal) => synthesizeYoudaoTts(text, language, signal),
            google: (text, language, _context, signal) => synthesizeGoogleTts(text, language, signal),
            openai: (text, _language, context, signal) => synthesizeOpenAiTts(text, {
                apiKey: getServiceApiKeys(config, 'openai')[0] ?? '',
                baseUrl: config.proxy.openai || undefined,
                model: config.selectionTtsOpenAiModel,
                voice: config.selectionTtsOpenAiVoice,
                rate: context.rate,
            }, signal),
        },
        synthesizeLocal: (text, language, voice, signal, speed) =>
            localTtsOffscreenAdapter.synthesize(text, language, voice, signal, speed),
        cache: ttsAudioCache,
        breaker: ttsCircuitBreaker,
    });

    return createSelectionTtsBackgroundHandlers({
        playbackStateSender: {runtimeId: browser.runtime.id, url: browser.runtime.getURL('/offscreen.html')},
        getPreferredVoices: () => config.selectionTtsVoices,
        getMode: () => config.selectionTtsMode,
        getDefaultRate: () => config.selectionTtsRate,
        synthesize: selectionTtsSynthesizer,
        fetchPageAudio: selectionTtsOffscreenAdapter.fetchPageAudio,
        playWithOffscreen: selectionTtsTransport.play,
        stopWithOffscreen: selectionTtsTransport.stop,
        seekWithOffscreen: selectionTtsOffscreenAdapter.seek,
        pauseWithOffscreen: selectionTtsOffscreenAdapter.pause,
        resumeWithOffscreen: selectionTtsOffscreenAdapter.resume,
        setRateWithOffscreen: selectionTtsOffscreenAdapter.setRate,
        offscreenPlaybackEnabled: capabilities.selectionTtsExtensionPlayback,
        sendTabMessage: (tabId, message, options) => browser.tabs.sendMessage(tabId, message, options),
        warn: (message, error) => console.warn(message, error),
    });
}
