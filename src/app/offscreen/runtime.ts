/**
 * @file src/app/offscreen/runtime.ts
 * 文件职责：作为 Offscreen Document 的组合根，创建独占 TTS 播放器并安装一次 runtime 消息监听，把浏览器资源适配给各离屏用例。
 * 主要内容：将 base64 音频解码为 Uint8Array，注入 Audio、Blob URL 创建/释放和状态回传，组合 Chrome Translation、OCR、图片/区域翻译与语言包下载依赖，注册 message listener。
 * 模块边界：本文件只负责 Web API 资源与用例装配，不解析业务消息、不实现 OCR/翻译，也不创建 Offscreen document；文档生命周期由 platform/offscreen client 和 WXT 入口管理。
 */
import {
    downloadImageOcrLanguages,
    removeImageOcrLanguages,
    fetchImageInOffscreen,
    recognizeImage,
    translateAreaInOffscreen,
    translateImageInOffscreen,
} from './imageTranslation';
import {createOffscreenMessageListener} from './messageRouter';
import {createSelectionTtsPlayer} from './ttsPlayback';
import {translateWithChromeApi, type ChromeTranslationEnvironment} from './translation';
import {removeLocalVideoTranscriptionModel, cancelLocalVideoTranscription, prepareLocalVideoTranscriptionModel, transcribeLocalVideoAudio} from '@/src/features/video-subtitle/offscreen/transcription';

function decodeAudioBase64(audioBase64: string): Uint8Array {
    const binary = atob(audioBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

/** 组装 Offscreen 的实验 API、Audio/Blob 和图片 OCR 浏览器能力。 */
export function startOffscreenApp(): void {
    const ttsPlayer = createSelectionTtsPlayer({
        createAudio: () => new Audio(),
        decodeBase64: decodeAudioBase64,
        createObjectUrl: (bytes, contentType) => URL.createObjectURL(new Blob([bytes], {type: contentType})),
        revokeObjectUrl: (url) => URL.revokeObjectURL(url),
        notify: (request, state, error) => {
            void chrome.runtime.sendMessage({
                type: 'selectionTtsPlaybackState',
                tabId: request.tabId,
                clientRequestId: request.clientRequestId,
                state,
                error: error instanceof Error ? error.message : error ? String(error) : undefined,
            }).catch(() => undefined);
        },
    });
    const listener = createOffscreenMessageListener({
        translate: (data, signal) => translateWithChromeApi(data, self as ChromeTranslationEnvironment, signal),
        ttsPlayer,
        recognizeImage,
        translateImage: translateImageInOffscreen,
        translateArea: translateAreaInOffscreen,
        fetchImage: fetchImageInOffscreen,
        downloadOcrLanguages: downloadImageOcrLanguages,
        removeOcrLanguages: removeImageOcrLanguages,
        videoAi: {
            transcribe: (request) => transcribeLocalVideoAudio(request as any),
            prepare: (request) => prepareLocalVideoTranscriptionModel(request.model, {keepWarm: request.keepWarm === true, streamId: request.streamId}),
            cancel: cancelLocalVideoTranscription,
            removeModel: request => removeLocalVideoTranscriptionModel(request.model),
        },
    });

    chrome.runtime.onMessage.addListener(listener);
    window.addEventListener('pagehide', () => ttsPlayer.dispose(), {once: true});
}
