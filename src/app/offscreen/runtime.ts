/**
 * @file src/app/offscreen/runtime.ts
 * 文件职责：作为 Chrome Offscreen 与 Firefox 后台 iframe 共用 DOM 页面的组合根，创建独占 TTS 播放器并安装一次 runtime 消息监听，把浏览器资源适配给各离屏用例。
 * 主要内容：智能高亮消息携带所选模型，模型下载与状态互相独立、推理共用单 Worker 预算；将 base64 音频解码为 Uint8Array，注入 Audio、Blob URL 创建/释放和带 frame/page 路由的状态回传，向播放控制入口注入扩展 ID 校验，组合 Chrome Translation、OCR、图片/区域翻译与语言包下载依赖，把朗读模型、字幕模型和语言包的下载进度发布给后台，注册 message listener。
 * 模块边界：本文件只负责 Web API 资源与用例装配，不解析业务消息、不实现 OCR/翻译，也不创建 Offscreen document；两种浏览器容器的文档生命周期均由 platform/offscreen client 和 WXT 入口管理。
 */
import {
    downloadImageOcrLanguages,
    removeImageOcrLanguages,
    fetchImageInOffscreen,
    translateAreaInOffscreen,
    cropAreaInOffscreen,
    translateImageInOffscreen,
    mangaOcrModelStatus,
    removeMangaModels,
    disposeMangaModels,
} from './imageTranslation';
import {createOffscreenMessageListener} from './messageRouter';
import {createInformationHighlightModelsRuntime, probeInformationHighlightWebGpu} from '@/src/features/information-highlight/offscreen/runtime';
import {DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID} from '@/src/core/config/informationHighlightModel';
import {INFORMATION_HIGHLIGHT_DOWNLOAD_ID} from '@/src/features/information-highlight/protocol';
import {withLocalInferenceBudget} from '@/src/shared/onnx/resources';
import {parseSelectionTtsRoute} from '@/src/features/selection-translation/protocol';
import {createDownloadProgressPublisher, LOCAL_TTS_DOWNLOAD_ID, ocrLanguageDownloadId, videoModelDownloadId} from '@/src/core/download/progress';
import {normalizeVideoLocalTranscriptionModel} from '@/src/features/video-subtitle/transcription';
import {createSelectionTtsPlayer} from './ttsPlayback';
import {translateWithChromeApi, type ChromeTranslationEnvironment} from './translation';
import {removeLocalVideoTranscriptionModel, cancelLocalVideoTranscription, prepareLocalVideoTranscriptionModel, transcribeLocalVideoAudio} from '@/src/features/video-subtitle/offscreen/transcription';
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
    configureLocalTranslationDownloadNotifications((snapshot) => new Promise<void>((resolve) => {
        chrome.runtime.sendMessage({type: 'fluentReadLocalTranslationDownloadProgress', snapshot}, () => {
            void chrome.runtime.lastError;
            resolve();
        });
    }));
    // 离屏页面不能直接写扩展存储；进度交给后台转存，设置页与网页内界面再从存储变化事件读取。
    const downloads = createDownloadProgressPublisher((message) => {
        chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
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
        createObjectUrl: (bytes, contentType) => URL.createObjectURL(new Blob([bytes], {type: contentType})),
        revokeObjectUrl: (url) => URL.revokeObjectURL(url),
        notifyProgress: (request, progress, position) => {
            void chrome.runtime.sendMessage({type: 'selectionTtsPlaybackState', ...parseSelectionTtsRoute(request), state: 'progress', progress, position}, () => {void chrome.runtime.lastError;});
        },
        notify: (request, state, error) => {
            void chrome.runtime.sendMessage({
                type: 'selectionTtsPlaybackState',
                ...parseSelectionTtsRoute(request),
                state,
                error: error instanceof Error ? error.message : error ? String(error) : undefined,
            }, () => {
                // Firefox 的 chrome 命名空间只提供 callback；两种容器共用此通知路径。
                void chrome.runtime.lastError;
            });
        },
    });
    const listener = createOffscreenMessageListener({
        runtimeId: chrome.runtime.id,
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
        mangaModelStatus:mangaOcrModelStatus,
        removeMangaModels,
        videoAi: {
            transcribe: (request) => transcribeLocalVideoAudio(request as any),
            // 预热只加载已缓存的模型；只有预下载才有网络进度可发布。
            prepare: (request) => request.keepWarm === true
                ? prepareLocalVideoTranscriptionModel(request.model, {keepWarm: true, streamId: request.streamId})
                : downloads.track(
                    videoModelDownloadId(normalizeVideoLocalTranscriptionModel(request.model)),
                    onProgress => prepareLocalVideoTranscriptionModel(request.model, {keepWarm: false, onProgress, preference: request.preference}),
                ),
            cancel: cancelLocalVideoTranscription,
            removeModel: request => removeLocalVideoTranscriptionModel(request.model),
        },
        localTranslation: {
            translate: (request, signal) => translateLocalText(request as any, signal),
            prepare: (request) => prepareLocalTranslationModel(request.model),
            pause: (request) => pauseLocalTranslationModelDownload(request.model),
            status: getLocalTranslationModelStatus,
            removeModel: request => removeLocalTranslationModel(request.model),
            dispose: disposeLocalTranslationWorker,
        },
        localTts: {
            synthesize: (request, signal) => synthesizeLocalTts(
                String(request.text || ''),
                String(request.language || ''),
                request.voice,
                signal,
            ),
            prepare: (request) => downloads.track(LOCAL_TTS_DOWNLOAD_ID, report => prepareLocalTtsModel(request.keepWarm === true, report)),
            status: getLocalTtsModelStatus,
            removeModel: async () => { await removeLocalTtsModel(); },
            dispose: disposeLocalTtsWorker,
        },
    });

    chrome.runtime.onMessage.addListener(listener);
    window.addEventListener('pagehide', () => {
        ttsPlayer.dispose();
        disposeLocalTranslationWorker();
        disposeLocalTtsWorker();
        disposeMangaModels();
        informationHighlight.dispose();
    }, {once: true});
}
