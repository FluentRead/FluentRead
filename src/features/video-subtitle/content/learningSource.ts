/**
 * @file src/features/video-subtitle/content/learningSource.ts
 * 文件职责：识别当前视频对应的可靠材料来源，不加载播放器或学习面板。
 * 主要内容：规范 YouTube 视频身份，按当前 X 媒体祖先链接和单视频帖子消歧，多视频保留编号。
 * 模块边界：只读取注入的媒体节点和来源地址，不依赖 Vue、字幕加载、播放状态或个人存储。
 */
import {sanitizeVocabularyVideoUrl} from '@/src/features/vocabulary/public';

export interface VideoLearningSource {
    platform: 'youtube' | 'x' | 'html';
    sourceUrl?: string;
    title: string;
}

type SourceLocation = Pick<Location, 'href' | 'hostname'>;

/** 单视频只接受同一帖子内的无歧义候选；编号视频页面与多视频必须由当前 video 的祖先链接给出编号。 */
export function getVideoLearningSource(video: HTMLMediaElement, location: SourceLocation, document: Document): VideoLearningSource {
    const platform = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(location.hostname) ? 'youtube' : 'x';
    if (platform === 'youtube') return {platform, sourceUrl: sanitizeVocabularyVideoUrl(location.href, platform), title: document.title};
    if (!/(^|\.)(x|twitter)\.com$/i.test(location.hostname)) {
        const url = new URL(location.href); url.username = ''; url.password = ''; url.hash = '';
        return {platform: 'html', sourceUrl: /^https?:$/.test(url.protocol) ? url.href : undefined, title: document.title};
    }
    const article = video.closest('article');
    const title = article?.querySelector('[data-testid="tweetText"]')?.textContent?.slice(0, 300) || document.title;
    const linkSource = (link: HTMLAnchorElement): string | undefined => {
        try { return sanitizeVocabularyVideoUrl(new URL(link.getAttribute('href')!, location.href).href, 'x'); } catch { return; }
    };
    let sourceUrl: string | undefined;
    const pageSource = sanitizeVocabularyVideoUrl(location.href, 'x');
    const indexedPage = !!pageSource && /\/video\/[1-9]\d*$/u.test(pageSource);
    const explicit = video.closest<HTMLAnchorElement>('a[href*="/video/"]');
    const explicitSource = explicit ? linkSource(explicit) : undefined;
    if (explicitSource && /\/video\/[1-9]\d*$/u.test(explicitSource)) sourceUrl = explicitSource;
    else if (article && article.querySelectorAll('video').length === 1 && !indexedPage) {
        const candidates = Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]'))
            .map(linkSource).filter((source): source is string => !!source);
        if (candidates.length && candidates.every(source => !/\/video\/[1-9]\d*$/u.test(source) && source === candidates[0])) sourceUrl = candidates[0];
    } else if (!article && document.querySelectorAll('video').length === 1 && document.querySelector('video') === video) {
        sourceUrl = pageSource && !indexedPage ? pageSource : undefined;
    }
    return {platform, sourceUrl, title};
}
