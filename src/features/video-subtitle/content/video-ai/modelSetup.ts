/**
 * @file src/features/video-subtitle/content/video-ai/modelSetup.ts
 * 文件职责：编排 X 本地 AI 字幕首次下载与播放器内主动换模型的确认，确认后复用缓存或下载并启动识别。
 * 主要内容：维护检查中、下载中与待确认选择三种状态，主动选模型时保留当前选择并等待明确确认；下载记录真实字节进度，重置立即停止旧界面订阅，后台下载仍可完成；视频、语言或模型变化作废旧结果，失败时交给运行时展示错误。
 * 模块边界：只通过注入的消息端口、进度订阅与回调工作，不读写 DOM、配置存储或播放器；菜单渲染、焦点和识别会话由 runtime 与 playerMenu 负责。
 */
import {
    requestDownloadedLocalVideoModels,
    requestLocalVideoModelDownload,
    type LocalVideoModelDownloadSender,
    type LocalVideoModelStatusSender,
} from '../localModelReadiness';
import {
    VIDEO_LOCAL_TRANSCRIPTION_RECOMMENDED_MODEL,
    type VideoLocalTranscriptionModel,
} from '@/src/features/video-subtitle/transcription';
import type {DownloadProgress} from '@/src/core/download/progress';

export interface VideoAiModelChoice {
    readonly downloaded: readonly VideoLocalTranscriptionModel[];
    readonly recommended: VideoLocalTranscriptionModel;
    readonly selected: VideoLocalTranscriptionModel;
    /** 主动换模型沿用同一确认视图，但不能误写成模型缺失或自动开始识别。 */
    readonly purpose?: 'selection';
}

export interface VideoAiModelSetupDependencies {
    readonly sendMessage: LocalVideoModelStatusSender & LocalVideoModelDownloadSender;
    readonly getConfiguredModel: () => VideoLocalTranscriptionModel;
    readonly isNative?: () => boolean;
    /** 记录发起请求时的视频与语言，返回的函数在异步结果到达时判断请求是否仍然有效。 */
    readonly captureRequest: () => () => boolean;
    readonly persistModel: (model: VideoLocalTranscriptionModel) => void;
    readonly startGeneration: () => void;
    readonly setError: (message: string) => void;
    readonly formatDownloadError: (message: string) => string;
    /** 订阅指定模型的下载进度；结束事件以 undefined 回报，返回取消订阅函数。 */
    readonly watchDownload: (model: VideoLocalTranscriptionModel, listener: (progress: DownloadProgress | undefined) => void) => () => void;
    readonly onChange: () => void;
}

export interface VideoAiModelSetup {
    readonly revision: number;
    readonly checking: boolean;
    readonly downloading: boolean;
    /** 下载中且已收到首个进度时可用；总量未知时 total 为 0。 */
    readonly downloadProgress: DownloadProgress | undefined;
    readonly choice: VideoAiModelChoice | null;
    /** 常规请求复用已下载模型；chooseModel 时始终等待用户确认当前或其他模型。 */
    request(canShowChoice: () => boolean, chooseModel?: boolean): Promise<void>;
    select(model: VideoLocalTranscriptionModel): void;
    cancel(): void;
    /** 换视频时隔离旧检查/下载；后台下载可完成，旧状态不占用新视频菜单。 */
    reset(): void;
    confirm(): Promise<void>;
}

export function createVideoAiModelSetup(dependencies: VideoAiModelSetupDependencies): VideoAiModelSetup {
    let requestEpoch = 0;
    let checking = false;
    let downloading = false;
    let downloadProgress: DownloadProgress | undefined;
    let choice: VideoAiModelChoice | null = null;
    let activeWatchStop: (() => void) | undefined;

    return {
        get revision() { return requestEpoch; },
        get checking() { return checking; },
        get downloading() { return downloading; },
        get downloadProgress() { return downloadProgress; },
        get choice() { return choice; },

        async request(canShowChoice, chooseModel = false) {
            if (checking || downloading) return;
            if (dependencies.isNative?.()) {
                requestEpoch += 1;
                if (chooseModel) {
                    dependencies.setError('请在设置中切换识别方式');
                    dependencies.onChange();
                } else if (canShowChoice() && dependencies.captureRequest()()) {
                    dependencies.setError('');
                    dependencies.startGeneration();
                }
                return;
            }
            const captured = dependencies.captureRequest();
            const epoch = ++requestEpoch;
            const isCurrent = () => epoch === requestEpoch && captured();
            const model = dependencies.getConfiguredModel();
            checking = true;
            dependencies.setError('');
            dependencies.onChange();
            let downloaded: VideoLocalTranscriptionModel[];
            try {
                downloaded = await requestDownloadedLocalVideoModels(dependencies.sendMessage);
            } catch (error) {
                // 状态端口只抛出带可展示文案的 Error；失效请求不覆盖新视频的状态。
                if (isCurrent()) dependencies.setError((error as Error).message);
                return;
            } finally {
                if (epoch === requestEpoch) {
                    checking = false;
                    dependencies.onChange();
                }
            }
            if (!isCurrent() || model !== dependencies.getConfiguredModel()) return;
            if (!chooseModel && downloaded.includes(model)) {
                dependencies.startGeneration();
                return;
            }
            if (!canShowChoice()) return;
            // 已下载的其他模型无需等待下载；否则沿用设置中的模型，不覆盖现有偏好。
            choice = {
                downloaded, recommended: VIDEO_LOCAL_TRANSCRIPTION_RECOMMENDED_MODEL,
                selected: chooseModel ? model : downloaded[0] ?? model,
                ...(chooseModel ? {purpose: 'selection' as const} : {}),
            };
            dependencies.onChange();
        },

        select(model) {
            if (!choice) return;
            choice = {...choice, selected: model};
            dependencies.onChange();
        },

        cancel() {
            // 检查中关闭菜单也要作废迟到结果；已明确确认的模型下载可在后台完成。
            if (checking || choice) requestEpoch += 1;
            checking = false;
            if (!choice) return;
            choice = null;
            dependencies.onChange();
        },

        reset() {
            requestEpoch += 1;
            const stopWatching = activeWatchStop;
            activeWatchStop = undefined;
            stopWatching?.();
            checking = false;
            downloading = false;
            downloadProgress = undefined;
            choice = null;
            dependencies.onChange();
        },

        async confirm() {
            const confirmed = choice;
            if (!confirmed) return;
            choice = null;
            const model = confirmed.selected;
            const captured = dependencies.captureRequest();
            const epoch = ++requestEpoch;
            const isCurrent = () => epoch === requestEpoch && captured();
            if (model !== dependencies.getConfiguredModel()) dependencies.persistModel(model);
            if (!confirmed.downloaded.includes(model)) {
                downloading = true;
                downloadProgress = undefined;
                dependencies.setError('');
                dependencies.onChange();
                // 结束事件先于下载响应到达时保留最后一次进度，避免进度条在收尾阶段退回不确定状态。
                let releaseWatch: (() => void) | undefined = dependencies.watchDownload(model, (progress) => {
                    if (!progress || epoch !== requestEpoch) return;
                    downloadProgress = progress;
                    dependencies.onChange();
                });
                const stopWatching = () => {
                    const release = releaseWatch;
                    releaseWatch = undefined;
                    release?.();
                };
                activeWatchStop = stopWatching;
                try {
                    await requestLocalVideoModelDownload(model, dependencies.sendMessage);
                } catch (error) {
                    if (isCurrent()) dependencies.setError(dependencies.formatDownloadError((error as Error).message));
                    return;
                } finally {
                    stopWatching();
                    if (activeWatchStop === stopWatching) activeWatchStop = undefined;
                    if (epoch === requestEpoch) {
                        downloading = false;
                        downloadProgress = undefined;
                        dependencies.onChange();
                    }
                }
            } else {
                dependencies.onChange();
            }
            // 下载期间可能换视频、改源语言、改模型或关闭翻译；此时只保留已下载的模型，不启动识别。
            if (isCurrent() && model === dependencies.getConfiguredModel()) dependencies.startGeneration();
        },
    };
}
