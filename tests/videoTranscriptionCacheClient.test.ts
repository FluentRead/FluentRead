import {parseHTML} from 'linkedom';
import {buildVideoAiSubtitleVideoKey} from '@/src/features/video-subtitle/transcriptionCache';
import {describe, expect, it, vi} from 'vitest';
import {getVideoTranscriptionCacheRequest, getVideoTranscriptionMediaTransition, isSameVideoTranscriptionMedia, mergeVideoTranscriptionMediaIdentity, VideoTranscriptionCacheClient} from '@/src/features/video-subtitle/content/transcriptionCacheClient';

describe('内容页完整识别缓存', () => {
  const cues = [{startMs: 200, durationMs: 1000, text: '안녕하세요.'}];
  const request = {source: {poster: 'https://pbs.twimg.com/ext_tw_video_thumb/123/a.jpg'}, model: 'tiny', videoSourceLanguage: 'auto'};
  it('YouTube 身份仅保留规范 video ID，忽略广告/MSE/签名地址并隔离其他视频', () => {
    const video = {closest: () => null, poster: 'https://example.com/ad.jpg', currentSrc: 'https://rr1.googlevideo.com/videoplayback?fake=do-not-forward'} as unknown as HTMLVideoElement;
    const first = getVideoTranscriptionCacheRequest(video, 'tiny', 'auto', 'https://www.youtube.com/watch?v=abcdefghijk')!;
    expect(first.source).toEqual({directSource: 'https://www.youtube.com/embed/abcdefghijk'});
    const second = getVideoTranscriptionCacheRequest(video, 'tiny', 'auto', 'https://www.youtube.com/watch?v=XXXXXXXXXXX')!;
    expect(getVideoTranscriptionMediaTransition(first.source, second.source, true, 'blob:same', 'blob:same').sameMedia).toBe(false);
    expect(getVideoTranscriptionCacheRequest(video, 'tiny', 'auto', 'bad')?.source.statusUrl).toBe('bad');
  });
  it('信息流从所属帖子读取身份，不用 profile 路径作为视频身份', () => {
    const video = {closest: () => ({querySelectorAll: () => [
      {pathname: '/someone', href: 'https://x.com/someone'},
      {pathname: '/someone/status/12/video/1', href: 'https://x.com/someone/status/12/video/1'},
    ]}), poster: request.source.poster, currentSrc: 'blob:https://x.com/random', src: ''} as unknown as HTMLVideoElement;
    expect(getVideoTranscriptionCacheRequest(video, 'base', 'ko', 'https://x.com/someone')).toEqual({
      source: {statusUrl: 'https://x.com/someone/status/12/video/1', videoIndex: '1', poster: request.source.poster, directSource: 'blob:https://x.com/random'},
      model: 'base', videoSourceLanguage: 'ko',
    });
    expect(getVideoTranscriptionCacheRequest(null, 'tiny', 'auto', '')).toBeNull();
    expect(getVideoTranscriptionCacheRequest({closest: () => null, src: 'https://video.twimg.com/a.mp4'} as unknown as HTMLVideoElement, 'tiny', 'auto', 'https://x.com/u/status/1'))
      .toMatchObject({source: {statusUrl: 'https://x.com/u/status/1', directSource: 'https://video.twimg.com/a.mp4'}});
  });
  it('缩略图尚未挂载时使用明确的视频序号，区分同帖的多段视频', () => {
    const first = {poster: '', currentSrc: 'blob:first'} as unknown as HTMLVideoElement;
    const second = {poster: '', currentSrc: 'blob:second'} as unknown as HTMLVideoElement;
    for (const video of [first, second]) video.closest = (() => ({querySelectorAll: (selector: string) => selector === 'video' ? [first, second] : []})) as any;
    expect(buildVideoAiSubtitleVideoKey(getVideoTranscriptionCacheRequest(first, 'tiny', 'auto', 'https://x.com/u/status/12')!.source)).toBe('tweet:12:video:1');
    expect(buildVideoAiSubtitleVideoKey(getVideoTranscriptionCacheRequest(second, 'tiny', 'auto', 'https://x.com/u/status/12')!.source)).toBe('tweet:12:video:2');
  });
  it('媒体信息补全、poster 暂时缺失仍属于同一视频，实际换媒体必须隔离', () => {
    const post = {statusUrl: 'https://x.com/u/status/12', videoIndex: '1', directSource: 'blob:one'};
    const media = {...post, poster: 'https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img/a.jpg'};
    expect(isSameVideoTranscriptionMedia(post, media)).toBe(true);
    expect(isSameVideoTranscriptionMedia(media, post)).toBe(true);
    expect(isSameVideoTranscriptionMedia(media, {...media, directSource: 'blob:two'})).toBe(true);
    expect(isSameVideoTranscriptionMedia(media, {...media, poster: 'https://pbs.twimg.com/ext_tw_video_thumb/456/pu/img/b.jpg'})).toBe(false);
    expect(isSameVideoTranscriptionMedia(post, {...post, videoIndex: '2'})).toBe(false);
    expect(isSameVideoTranscriptionMedia({}, {})).toBe(false);
    expect(isSameVideoTranscriptionMedia({poster: 'https://site.test/old.jpg'}, {poster: 'https://site.test/new.jpg'})).toBe(false);
    expect(isSameVideoTranscriptionMedia({directSource: 'https://site.test/old.mp4'}, {directSource: 'https://site.test/new.mp4'})).toBe(false);
    expect(isSameVideoTranscriptionMedia({poster: 'https://site.test/same.jpg'}, {poster: 'https://site.test/same.jpg', directSource: 'https://site.test/new.mp4'})).toBe(true);
  });
  it('从当前唯一视频的相邻缩略图恢复媒体 ID，不跨入其他视频的容器', () => {
    const {document} = parseHTML('<article><div><img src="https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img/a.jpg"><video></video></div><div><img src="https://pbs.twimg.com/ext_tw_video_thumb/456/pu/img/b.jpg"><video></video></div></article>');
    const first = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(first, 'poster', {value: ''});
    expect(getVideoTranscriptionCacheRequest(first, 'tiny', 'auto', 'https://x.com/home')!.source.poster).toContain('/123/');
    first.parentElement!.querySelector('img')!.remove();
    expect(getVideoTranscriptionCacheRequest(first, 'tiny', 'auto', 'https://x.com/home')!.source.poster).toBe('');
    const solo = parseHTML('<article><div><video></video></div><img src="https://pbs.twimg.com/ext_tw_video_thumb/789/pu/img/c.jpg"></article>').document.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(solo, 'poster', {value: ''});
    expect(getVideoTranscriptionCacheRequest(solo, 'tiny', 'auto', 'https://x.com/home')!.source.poster).toContain('/789/');
  });
  it('属性暂时消失时保留已确认身份，换视频及首次挂载不继承旧属性', () => {
    const old = {poster: 'old.jpg', directSource: 'blob:old'};
    expect(mergeVideoTranscriptionMediaIdentity(old, {poster: '', directSource: ''}, true)).toEqual(old);
    expect(mergeVideoTranscriptionMediaIdentity(old, {poster: 'new.jpg', directSource: 'blob:new'}, true)).toEqual({poster: 'new.jpg', directSource: 'blob:new'});
    expect(mergeVideoTranscriptionMediaIdentity(old, {}, false)).toEqual({});
    expect(mergeVideoTranscriptionMediaIdentity(null, {}, true)).toEqual({});
    expect(mergeVideoTranscriptionMediaIdentity(old, null, true)).toBeNull();
  });
  it('媒体切换判定支持首次挂载、同节点补全、跨节点恢复和缺失窗口', () => {
    const post = {statusUrl: 'https://x.com/u/status/12', videoIndex: '1', directSource: 'blob:one'};
    const media = {...post, poster: 'https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img/a.jpg'};
    expect(getVideoTranscriptionMediaTransition(null, post, false, '', 'blob:one')).toMatchObject({sameMedia: false, key: 'tweet:12:video:1'});
    expect(getVideoTranscriptionMediaTransition({}, post, true, '', '').sameMedia).toBe(true);
    expect(getVideoTranscriptionMediaTransition({directSource: 'blob:one'}, media, true, 'blob:one', 'blob:one').sameMedia).toBe(true);
    expect(getVideoTranscriptionMediaTransition(post, media, true, 'blob:one', 'blob:one')).toMatchObject({sameMedia: true, key: 'media:123'});
    expect(getVideoTranscriptionMediaTransition(media, post, false, 'blob:one', 'blob:two')).toMatchObject({sameMedia: true, key: 'media:123'});
    expect(getVideoTranscriptionMediaTransition(media, null, false, 'blob:one', '')).toEqual({sameMedia: false, identity: null, key: ''});
    expect(getVideoTranscriptionMediaTransition(null, {}, false, '', '').key).toBe('');
    expect(getVideoTranscriptionMediaTransition({directSource: 'blob:one'}, {directSource: 'blob:two'}, false, 'blob:one', 'blob:two').sameMedia).toBe(false);
    expect(getVideoTranscriptionMediaTransition({directSource: 'blob:one'}, {directSource: 'blob:two'}, false, 'blob:one', 'blob:two').key).toBe('blob:two');
    expect(getVideoTranscriptionCacheRequest({} as HTMLVideoElement, 'base', 'zh', '', media)).toEqual({source: media, model: 'base', videoSourceLanguage: 'zh'});
  });
  it('已有缓存中的异常重复不会自动恢复到字幕画面', async () => {
    const send = vi.fn().mockResolvedValue({success: true, hit: true, cues: [{startMs: 0, durationMs: 1000, text: '吻'.repeat(50)}]});
    expect(await new VideoTranscriptionCacheClient(send).get(request)).toBeNull();
  });
  it('命中只返回有效时间轴，缺失、损坏和存储故障均安全回退', async () => {
    const send = vi.fn().mockResolvedValue({success: true, hit: true, cues});
    const cache = new VideoTranscriptionCacheClient(send);
    expect(await cache.get(request)).toEqual([{...cues[0], spokenEndMs: 1200}]);
    expect(send).toHaveBeenCalledWith({type: 'fluentReadGetVideoAiSubtitleCache', ...request});
    for (const response of [undefined, {success: false}, {success: true, hit: false}, {success: true, hit: true, cues: 'bad'}, {success: true, hit: true, cues: []}]) {
      send.mockResolvedValue(response);
      expect(await cache.get(request)).toBeNull();
    }
    send.mockRejectedValue(new Error('unavailable'));
    expect(await cache.get(request)).toBeNull();
  });
  it('只向后台发送文本结果，写入失败不影响当前字幕', async () => {
    const send = vi.fn().mockResolvedValue({success: true});
    const cache = new VideoTranscriptionCacheClient(send);
    await cache.set(request, cues);
    expect(send).toHaveBeenCalledWith({type: 'fluentReadSetVideoAiSubtitleCache', ...request, cues});
    send.mockRejectedValue(new Error('quota'));
    await expect(cache.set(request, cues)).resolves.toBeUndefined();
  });
});
