/**
 * @file src/features/video-subtitle/content/sentenceLearningHost.ts
 * 文件职责：封装视频句子学习面板的节点所有权、可靠来源选择和收藏片段的单次定位恢复。
 * 主要内容：只从当前视频的明确链接或无歧义帖子识别 X 来源；保存完整 video/N 身份，恢复时核对同一来源与安全时间范围；向组件同步逻辑player与来源语言，物理挂载可交给placement；同媒体全屏迁移保留原节点，关闭和失联先释放所有权避免卸载重入，只在原媒体及已验证的同视频控件范围内归还入口焦点。
 * 模块边界：不静态导入 Vue 或组件实现、不加载字幕和调用翻译服务；composition root 注入挂载与界面标记，原始媒体与 cue 数据仍由既有运行时持有。
 */
import type VideoSentenceLearning from '../ui/VideoSentenceLearning.vue';
import type {VideoSubtitleCue} from './youtubeSubtitleData';
import {sanitizeVocabularyVideoSource, sanitizeVocabularyVideoUrl} from '@/src/features/vocabulary/public';
import {getYoutubeSubtitleControlsScope} from './youtubeControlsScope';

export type MutableVideoSentenceLearningProps = {
    -readonly [Key in keyof InstanceType<typeof VideoSentenceLearning>['$props']]: InstanceType<typeof VideoSentenceLearning>['$props'][Key]
};

export {getVideoLearningSource} from './learningSource';
export type {VideoLearningSource} from './learningSource';
import {getVideoLearningSource} from './learningSource';
type SourceLocation = Pick<Location, 'href' | 'hostname'>;

export interface VideoSentenceLearningHost {
    open(player: HTMLElement, props: MutableVideoSentenceLearningProps): void;
    close(): void;
    isOpen(): boolean;
    isConnected(player?: HTMLElement): boolean;
    syncPlayer(player: HTMLElement, video: HTMLVideoElement): boolean;
    updateCues(cues: VideoSubtitleCue[], sourceLanguage?: string): void;
    hasCues(): boolean;
}

type LearningPlacement = {syncPlayer(player: HTMLElement): void; isConnected?(player: HTMLElement): boolean; destroy(): void};

/** Vue 的加载与响应式 props 由调用方注入，此模块只拥有节点和同步卸载回调。 */
export function createVideoSentenceLearningHost(ports: {
    mount(host: HTMLElement, props: MutableVideoSentenceLearningProps): () => void;
    markUi(host: HTMLElement): void;
    place?(host: HTMLElement, player: HTMLElement): LearningPlacement;
}): VideoSentenceLearningHost {
    let owner: {host: HTMLElement; player: HTMLElement; props: MutableVideoSentenceLearningProps; unmount?: () => void;
        placement?: LearningPlacement} | undefined;
    const close = (): void => {
        const previous = owner; owner = undefined;
        const focused = previous?.host.ownerDocument.activeElement;
        const returnFocus = focused && previous!.host.contains(focused)
            ? getYoutubeSubtitleControlsScope(previous!.player, previous!.props.video).querySelector<HTMLElement>('#fluent-read-video-subtitle-button') : null;
        try { previous?.unmount?.(); } finally {
            try { previous?.placement?.destroy(); } finally {
                previous?.host.remove();
                if (!owner && returnFocus?.isConnected) returnFocus.focus({preventScroll: true});
            }
        }
    };
    return {
        open(player, props) {
            close();
            props.player = player;
            const host = player.ownerDocument.createElement('div'); host.id = 'fluent-read-video-learning-panel';
            ports.markUi(host);
            Object.assign(host.style, {position: 'absolute', top: '8px', bottom: '56px', right: '8px', width: 'min(390px, calc(100% - 16px))', maxHeight: 'calc(100% - 56px)', overflow: 'auto', zIndex: '2147483646', pointerEvents: 'none'});
            player.appendChild(host);
            const next = {host, player, props, unmount: undefined as (() => void) | undefined,
                placement: undefined as LearningPlacement | undefined}; owner = next;
            try {
                const unmount = ports.mount(host, props);
                if (owner !== next) { unmount(); return; }
                next.unmount = unmount;
                const placement = ports.place?.(host, player);
                if (owner !== next) { placement?.destroy(); return; }
                next.placement = placement;
                host.querySelector<HTMLElement>('section')?.focus({preventScroll: true});
            } catch (cause) { if (owner === next) close(); throw cause; }
        },
        close,
        isOpen: () => !!owner,
        isConnected: player => !!owner && owner.host.isConnected && (!player || owner.player === player)
            && (owner.placement?.isConnected ? owner.placement.isConnected(owner.player) : owner.host.parentElement === owner.player),
        syncPlayer(player, video) {
            if (!owner || owner.props.video !== video || !video.isConnected || !player.isConnected || !player.contains(video)) return false;
            owner.props.player = player;
            // 支持物理宿主的placement独立持有挂载；媒体归属仍由此处的player/video资格约束。
            if (owner.placement?.isConnected) {
                owner.player = player;
                owner.placement.syncPlayer(player);
                return owner.host.isConnected && owner.placement.isConnected(player);
            }
            if (owner.player !== player || owner.host.parentElement !== player) {
                const focused = owner.host.ownerDocument.activeElement;
                const restoreFocus = focused && owner.host.contains(focused) ? focused as HTMLElement : null;
                player.appendChild(owner.host);
                owner.player = player;
                owner.placement?.syncPlayer(player);
                restoreFocus?.focus({preventScroll: true});
            }
            return owner.host.isConnected;
        },
        updateCues(cues, sourceLanguage) {
            if (owner) {
                owner.props.cues = cues;
                if (sourceLanguage !== undefined) owner.props.sourceLanguage = sourceLanguage;
            }
        },
        hasCues: () => !!owner && owner.props.cues.length > 0,
    };
}

/** 只在可靠 X 来源完全一致时恢复一次；元数据未就绪、时长未知或 seek 失败均保留重试机会。 */
export function createSavedVideoPositionRestorer(): {
    restore(video: HTMLVideoElement, location: SourceLocation & Pick<Location, 'hash'>, document: Document): boolean;
} {
    const restored = new WeakMap<HTMLVideoElement, Set<string>>();
    return {
        restore(video, location, document) {
            if (video.readyState < 1) return false;
            const match = /^#fluentread-video=(\d+),(\d+)$/u.exec(location.hash);
            if (!match) return false;
            const range = sanitizeVocabularyVideoSource({platform: 'x', startMs: Number(match[1]), endMs: Number(match[2])});
            const source = sanitizeVocabularyVideoUrl(location.href, 'x');
            if (!range || !source || getVideoLearningSource(video, location, document).sourceUrl !== source) return false;
            const key = source + location.hash;
            if (restored.get(video)?.has(key)) return false;
            if (!Number.isFinite(video.duration) || video.duration <= 0 || range.startMs >= video.duration * 1_000) return false;
            try { video.pause(); video.currentTime = range.startMs / 1_000; } catch { return false; }
            const keys = restored.get(video) || new Set<string>(); keys.add(key); restored.set(video, keys);
            return true;
        },
    };
}
