/**
 * @file src/app/offscreen/runtime.ts
 * 文件职责：作为 Chrome Offscreen 与 Firefox/Safari MV2 后台 iframe 共用 DOM 页面的组合根，创建独占 TTS 播放器并安装一次 runtime 消息监听，把浏览器资源适配给各离屏用例。
 * 主要内容：装配按需创建、空闲释放的字幕读音 Worker；智能高亮消息携带所选模型，模型下载与状态互相独立、推理共用单 Worker 预算；将 base64 音频解码为 Uint8Array，注入 Audio、Blob URL 创建/释放和带 frame/page 路由的状态回传，向播放控制入口注入扩展 ID 校验，组合 Chrome Translation、OCR、图片/区域翻译与语言包下载依赖，把朗读模型、字幕模型和语言包的下载进度发布给后台，注册 message listener 并在 pagehide 时统一释放包括本地视频转写 Worker 在内的离屏资源。
 * 模块边界：本文件只负责 Web API 资源与用例装配，不解析业务消息、不实现 OCR/翻译，也不创建 Offscreen document；两种浏览器容器的文档生命周期均由 platform/offscreen client 和 WXT 入口管理。
 */
import {asArrayBufferBytes} from '@/src/shared/function/arrayBufferBytes';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {createExtensionPageRuntime, installExtensionPageMessageListener, type ExtensionPageMessageTarget} from '@/src/platform/offscreen/extensionPageMessaging';
import {
    downloadImageOcrLanguages,
    removeImageOcrLanguages,
    disposeImageOcrWorker,
    fetchImageInOffscreen,
    translateAreaInOffscreen,
    cropAreaInOffscreen,
    translateImageInOffscreen,
    mangaOcrModelStatus,
    mangaInferenceClient,
    removeMangaModels,
    disposeMangaModels,
} from './imageTranslation';
import {createOffscreenMessageListener} from './messageRouter';
import {createReadingAnnotationRuntime} from '@/src/features/video-subtitle/offscreen/readingAnnotation';
import {createInformationHighlightModelsRuntime, probeInformationHighlightWebGpu} from '@/src/features/information-highlight/offscreen/runtime';
import {DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID} from '@/src/core/config/informationHighlightModel';
import {INFORMATION_HIGHLIGHT_DOWNLOAD_ID} from '@/src/features/information-highlight/protocol';
import {withLocalInferenceBudget} from '@/src/shared/onnx/resources';
import {parseSelectionTtsRoute} from '@/src/features/selection-translation/protocol';
import {createCoalescedDownloadNotifier, createDownloadProgressPublisher, LOCAL_TTS_DOWNLOAD_ID, ocrLanguageDownloadId, videoModelDownloadId} from '@/src/core/download/progress';
import {normalizeVideoLocalTranscriptionModel} from '@/src/features/video-subtitle/transcription';
import {createSelectionTtsPlayer} from './ttsPlayback';
import {disposeChromeTranslationModels, translateWithChromeApi, type ChromeTranslationEnvironment} from './translation';
import {moveVideoAiModelToSharedDirectory} from '@/src/features/video-subtitle/offscreen/modelCache';
import * as localVideoTranscription from '@/src/features/video-subtitle/offscreen/transcription';
import {
    disposeLocalTtsWorker,
    getLocalTtsModelStatus,
    prepareLocalTtsModel,
    removeLocalTtsModel,
    synthesizeLocalTts,
} from '@/src/features/local-tts/offscreen/tts';
import {
    disposeLocalTranslationWorker,
    configureLocalTranslationDownloadNotifications,
    pauseLocalTranslationModelDownload,
    getLocalTranslationModelStatus,
    prepareLocalTranslationModel,
    removeLocalTranslationModel,
    translateLocalText,
} from '@/src/features/local-translation/offscreen/translation';

function decodeAudioBase64(audioBase64: string): Uint8Array {
    const binary = atob(audioBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

/** 组装 Offscreen 的实验 API、Audio/Blob 和图片 OCR 浏览器能力。 */
export function startOffscreenApp(): void {
    const runtime = browserCapabilities.browser === 'safari'
        ? createExtensionPageRuntime(() => chrome.runtime, () => window.parent === window ? undefined : window.parent as unknown as ExtensionPageMessageTarget, () => window.location.href)
        : chrome.runtime;
    const readingAnnotation = createReadingAnnotationRuntime({createWorker: () => new Worker(chrome.runtime.getURL('readingAnnotationWorker.js'), {type: 'module'})});
    const downloadNotifications = createCoalescedDownloadNotifier((snapshot) => new Promise<void>((resolve) => {
        try {
            runtime.sendMessage({type: 'fluentReadLocalTranslationDownloadProgress', snapshot}, () => {
                try {void runtime.lastError;} catch { /* 已失效的 runtime 无需再次通知。 */ }
                resolve();
            });
        } catch {resolve();}
    }));
    configureLocalTranslationDownloadNotifications(downloadNotifications.notify);
    // 离屏页面不能直接写扩展存储；进度交给后台转存，设置页与网页内界面再从存储变化事件读取。
    const downloads = createDownloadProgressPublisher((message) => {
        runtime.sendMessage(message, () => void runtime.lastError);
    });
    const informationHighlight = createInformationHighlightModelsRuntime({
        createWorker: () => new Worker(chrome.runtime.getURL('informationHighlightWorker.js'), {type: 'module'}),
        probe: probeInformationHighlightWebGpu,
        budget: withLocalInferenceBudget,
        notify: (progress, modelId) => {
            const id = modelId === DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID ? INFORMATION_HIGHLIGHT_DOWNLOAD_ID : `${INFORMATION_HIGHLIGHT_DOWNLOAD_ID}:${modelId}`;
            if (progress) downloads.report(id, progress); else downloads.finish(id);
        },
    });
    const ttsPlayer = createSelectionTtsPlayer({
        createAudio: () => new Audio(),
        decodeBase64: decodeAudioBase64,
        createObjectUrl: (bytes, contentType) => URL.createObjectURL(new Blob([asArrayBufferBytes(bytes)], {type: contentType})),
        revokeObjectUrl: (url) => URL.revokeObjectURL(url),
        notifyProgress: (request, progress, position) => {
            void runtime.sendMessage({type: 'selectionTtsPlaybackState', ...parseSelectionTtsRoute(request), state: 'progress', progress, position}, () => {void runtime.lastError;});
        },
        notify: (request, state, error) => {
            void runtime.sendMessage({
                type: 'selectionTtsPlaybackState',
                ...parseSelectionTtsRoute(request),
                state,
                error: error instanceof Error ? error.message : error ? String(error) : undefined,
            }, () => {
                // Firefox 的 chrome 命名空间只提供 callback；两种容器共用此通知路径。
                void runtime.lastError;
            });
        },
    });
    const listener = createOffscreenMessageListener({
        runtimeId: chrome.runtime.id,
        readingAnnotation,
        informationHighlight,
        translate: (data, signal) => translateWithChromeApi(data, self as ChromeTranslationEnvironment, signal),
        ttsPlayer,
        translateImage: translateImageInOffscreen,
        translateArea: translateAreaInOffscreen,
        cropArea: cropAreaInOffscreen,
        fetchImage: fetchImageInOffscreen,
        // 后台按语言逐个请求；标识与界面按语言订阅的键一致。
        downloadOcrLanguages: (languages) => downloads.track(
            ocrLanguageDownloadId(languages.join('-')),
            onProgress => downloadImageOcrLanguages(languages, undefined, onProgress),
        ),
        removeOcrLanguages: removeImageOcrLanguages,
        mangaModelStatus:async () => ({...await mangaOcrModelStatus(mangaInferenceClient.getDownloadState()), inference:mangaInferenceClient.getDiagnostics()}),
        removeMangaModels,
        videoAi: {
            transcribe: (request) => localVideoTranscription.transcribeLocalVideoAudio(request),
            // 预热只加载已缓存的模型；只有预下载才有网络进度可发布。
            prepare: (request) => request.keepWarm === true
                ? localVideoTranscription.prepareLocalVideoTranscriptionModel(request.model, {keepWarm: true, streamId: request.streamId})
                : downloads.track(
                    videoModelDownloadId(normalizeVideoLocalTranscriptionModel(request.model)),
                    onProgress => localVideoTranscription.prepareLocalVideoTranscriptionModel(request.model, {keepWarm: false, onProgress, preference: request.preference}),
                ),
            cancel: localVideoTranscription.cancelLocalVideoTranscription,
            removeModel: request => localVideoTranscription.removeLocalVideoTranscriptionModel(request.model),
            shareModel: request => downloads.track(
                videoModelDownloadId(normalizeVideoLocalTranscriptionModel(request.model)),
                onProgress => moveVideoAiModelToSharedDirectory(request.model, onProgress, localVideoTranscription.removeLocalVideoTranscriptionModel),
            ),
        },
        localTranslation: {
            translate: (request, signal) => translateLocalText(request, signal),
            prepare: (request) => {
                const options = request.preference || request.mirrorUrl ? {
                    ...(request.preference ? {preference: request.preference} : {}),
                    ...(request.mirrorUrl ? {mirrorUrl: request.mirrorUrl} : {}),
                } : undefined;
                return options ? prepareLocalTranslationModel(request.model, options) : prepareLocalTranslationModel(request.model);
            },
            pause: (request) => pauseLocalTranslationModelDownload(request.model),
            status: getLocalTranslationModelStatus,
            removeModel: request => removeLocalTranslationModel(request.model),
            dispose: disposeLocalTranslationWorker,
        },
        localTts: {
            synthesize: (request, signal) => synthesizeLocalTts(
                request.text,
                request.language,
                request.voice,
                signal,
                request.speed,
            ),
            prepare: (request) => downloads.track(LOCAL_TTS_DOWNLOAD_ID, report => prepareLocalTtsModel(request.keepWarm === true, report)),
            status: getLocalTtsModelStatus,
            removeModel: async () => { await removeLocalTtsModel(); },
            dispose: disposeLocalTtsWorker,
        },
    });

    chrome.runtime.onMessage.addListener(listener);
    const removePageListener = browserCapabilities.browser === 'safari'
        ? installExtensionPageMessageListener(window as unknown as ExtensionPageMessageTarget, listener)
        : undefined;
    window.addEventListener('pagehide', () => {
        removePageListener?.();
        downloadNotifications.dispose();
        readingAnnotation.dispose();
        ttsPlayer.dispose();
        disposeChromeTranslationModels(self as ChromeTranslationEnvironment);
        disposeImageOcrWorker();
        disposeLocalTranslationWorker();
        disposeLocalTtsWorker();
        if ('disposeLocalVideoTranscriber' in localVideoTranscription) {
            localVideoTranscription.disposeLocalVideoTranscriber();
        }
        disposeMangaModels();
        informationHighlight.dispose();
    }, {once: true});
}
