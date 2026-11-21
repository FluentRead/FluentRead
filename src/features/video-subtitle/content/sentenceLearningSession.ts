/**
 * @file src/features/video-subtitle/content/sentenceLearningSession.ts
 * 文件职责：管理完整句学习面板的按需加载、单次打开归属与媒体会话生命周期。
 * 主要内容：加载前后检查资格、媒体连接与容器包含关系，加载期间全屏容器改变时使用同一媒体的最新挂载位置；关闭、连续打开和销毁淘汰旧结果与旧失败，复用 host 的节点移动、字幕更新和清理契约。
 * 模块边界：不导入 Vue 实现、不读取全局配置或字幕来源，不持有媒体播放控制；composition root 注入视图加载、挂载、可靠目标与业务 props。
 */
import {playerOwnsMedia} from './htmlMedia';
import {createVideoSentenceLearningHost, type MutableVideoSentenceLearningProps, type VideoSentenceLearningHost} from './sentenceLearningHost';

export interface VideoSentenceLearningTarget {
    video: HTMLMediaElement;
    player: HTMLElement;
}

export interface VideoSentenceLearningSession extends Omit<VideoSentenceLearningHost, 'open'> {
    open(): Promise<void>;
    destroy(): void;
}

function isConnectedTarget(target: VideoSentenceLearningTarget | null): target is VideoSentenceLearningTarget {
    return !!target && target.video.isConnected && target.player.isConnected && playerOwnsMedia(target.player, target.video);
}

export function createVideoSentenceLearningSession<View>(ports: {
    load(): Promise<View>;
    mount(view: View, host: HTMLElement, props: MutableVideoSentenceLearningProps): () => void;
    markUi(host: HTMLElement): void;
    place?: Parameters<typeof createVideoSentenceLearningHost>[0]['place'];
    readTarget(): VideoSentenceLearningTarget | null;
    canOpen(): boolean;
    readProps(target: VideoSentenceLearningTarget, onClose: () => void): MutableVideoSentenceLearningProps;
}): VideoSentenceLearningSession {
    let generation = 0;
    let destroyed = false;
    let view: View;
    const host = createVideoSentenceLearningHost({markUi: ports.markUi, place: ports.place,
        mount: (element, props) => ports.mount(view, element, props)});
    const close = (): void => {generation++; host.close();};
    return {
        ...host,
        close,
        async open() {
            if (destroyed || !ports.canOpen()) return;
            const target = ports.readTarget();
            if (!isConnectedTarget(target)) return;
            close();
            const owner = generation;
            let loaded: View;
            try {loaded = await ports.load();} catch (cause) {
                if (!destroyed && owner === generation) throw cause;
                return;
            }
            if (destroyed || owner !== generation || !ports.canOpen()) return;
            const current = ports.readTarget();
            if (!isConnectedTarget(current) || current.video !== target.video) return;
            view = loaded;
            host.open(current.player, ports.readProps(current, close));
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            close();
        },
    };
}
