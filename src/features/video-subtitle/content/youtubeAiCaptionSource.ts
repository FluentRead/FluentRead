/**
 * @file src/features/video-subtitle/content/youtubeAiCaptionSource.ts
 * 文件职责：为 YouTube 本地识别时间轴建立独立合成字幕容器，隔离广告与旧视频。
 * 主要内容：仅在当前播放器、当前稳定身份和有效 AI 时间轴一致时显示 cue；隐藏/停止/广告/导航立即移除自有容器，原生字幕状态完全归宿主所有。
 * 模块边界：不切换 CC 或 TextTrack，不改变播放状态，不触发识别或翻译；runtime 负责 AI 与原生时间轴仲裁。
 */
import {getVisibleVideoAiCue} from './video-ai/cueTimeline';
import type {VideoSubtitleCue} from './youtubeSubtitleData';

const CONTAINER_ID = 'fluent-read-video-ai-caption-container';
export function isYoutubeAdvertisement(player: HTMLElement | null | undefined): boolean {
    return Boolean(player?.matches('.ad-showing, .ad-interrupting'));
}

export class YoutubeAiCaptionSource {
    private player: HTMLElement | null = null;
    private container: HTMLElement | null = null;
    sync(state: {video: HTMLVideoElement | null; player: HTMLElement | null; enabled: boolean; active: boolean; videoId: string; generationVideoId: string; cues: VideoSubtitleCue[]}): HTMLElement | null {
        const {video, player, enabled, active, videoId, generationVideoId, cues} = state;
        if (!video || !player || !enabled || !active || !videoId || videoId !== generationVideoId
            || isYoutubeAdvertisement(player) || !cues.length) { this.clear(); return null; }
        if (!this.container) {
            this.container = player.ownerDocument.createElement('div');
            this.container.id = CONTAINER_ID;
            this.container.className = 'fluent-read-video-ai-caption-container fluent-read-video-ui notranslate';
            this.container.setAttribute('data-fluent-read-ui', 'video-subtitle');
            this.container.setAttribute('translate', 'no');
            const segment = player.ownerDocument.createElement('span');
            segment.className = 'ytp-caption-segment';
            this.container.appendChild(segment);
            const style = player.ownerDocument.createElement('style');
            style.textContent = '.fluent-read-youtube-ai-source #ytp-caption-window-container,.fluent-read-youtube-ai-source .ytp-caption-window-container{visibility:hidden!important}';
            this.container.appendChild(style);
        }
        if (this.player !== player) {
            this.player?.classList.remove('fluent-read-youtube-ai-source');
            this.player = player;
        }
        player.classList.add('fluent-read-youtube-ai-source');
        if (this.container.parentElement !== player) player.appendChild(this.container);
        const text = getVisibleVideoAiCue(cues, video.currentTime * 1000)?.text || '';
        const segment = this.container.firstElementChild!;
        if (segment.textContent !== text) segment.textContent = text;
        return this.container;
    }
    clear(): void {
        this.container?.remove(); this.container = null;
        this.player?.classList.remove('fluent-read-youtube-ai-source'); this.player = null;
    }
}
