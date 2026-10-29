/**
 * @file src/features/video-subtitle/content/video-ai/modelMenu.ts
 * 文件职责：协调播放器内 AI 字幕请求、缓存恢复和主动选择模型的菜单入口。
 * 主要内容：等待缓存时校验媒体所有权与既有模型设置代际，主动换模型只作废旧缓存读取并保留当前字幕；确认视图打开后将焦点交给可操作按钮。
 * 模块边界：通过注入端口访问运行时状态，不持有视频、配置或识别会话；下载与确认由 modelSetup 负责。
 */
import type {VideoAiModelSetup} from './modelSetup';
import {focusVideoModelPromptReturn} from '../playerMenu';
import {normalizeVideoLocalTranscriptionModel} from '@/src/features/video-subtitle/transcription';

export interface VideoAiModelMenuDependencies {
    readonly setup: VideoAiModelSetup;
    readonly isCurrent: () => boolean;
    readonly mediaEpoch: () => number;
    readonly restoreCache: () => Promise<boolean>;
    readonly invalidateCache: () => void;
    readonly setRegenerating: (regenerate: boolean) => void;
    readonly ensureEnabled: () => void;
    readonly supportsLocal: () => boolean;
    readonly setError: (message: string) => void;
    readonly canSelect: () => boolean;
}

export function createVideoAiModelMenu(dependencies: VideoAiModelMenuDependencies) {
    return {
        choose(menu: HTMLElement, value: unknown): void {
            const model = normalizeVideoLocalTranscriptionModel(value);
            dependencies.setup.select(model);
            menu.querySelector<HTMLButtonElement>(`[data-model-choice="${model}"]`)?.focus();
        },
        finish(menu: HTMLElement, confirmed: boolean): void {
            const purpose = dependencies.setup.choice?.purpose;
            if (confirmed) void dependencies.setup.confirm();
            else dependencies.setup.cancel();
            focusVideoModelPromptReturn(menu, purpose);
        },
        async request(menu: HTMLElement, regenerate = false): Promise<void> {
            dependencies.setRegenerating(regenerate);
            dependencies.ensureEnabled();
            const epoch = dependencies.mediaEpoch();
            const revision = dependencies.setup.revision;
            if (!regenerate && await dependencies.restoreCache()) return;
            if (!dependencies.isCurrent() || menu.hidden || epoch !== dependencies.mediaEpoch()
                || revision !== dependencies.setup.revision) return;
            if (!dependencies.supportsLocal()) {
                dependencies.setError('当前浏览器不支持本地 AI 字幕');
                return;
            }
            await dependencies.setup.request(() => !menu.hidden);
            if (dependencies.setup.choice) menu.querySelector<HTMLButtonElement>('[data-action="model-prompt-confirm"]')?.focus();
        },
        async select(menu: HTMLElement): Promise<void> {
            if (!dependencies.isCurrent() || menu.hidden || !dependencies.supportsLocal() || !dependencies.canSelect()) return;
            // 只有确认后才保存选择并重新识别；取消仍保留原字幕时间轴。
            dependencies.invalidateCache();
            dependencies.setRegenerating(true);
            await dependencies.setup.request(() => !menu.hidden, true);
            const selected = dependencies.setup.choice?.selected;
            if (selected) menu.querySelector<HTMLButtonElement>(`[data-model-choice="${selected}"]`)?.focus();
        },
    };
}
