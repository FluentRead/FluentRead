import {buildVideoAiSubtitleVideoKey} from '@/src/features/video-subtitle/transcriptionCache';
import {describe, expect, it, vi} from 'vitest';
import {getVideoTranscriptionCacheRequest, VideoTranscriptionCacheClient} from '@/src/features/video-subtitle/content/transcriptionCacheClient';

describe('内容页完整识别缓存', () => {
  const cues = [{startMs: 200, durationMs: 1000, text: '안녕하세요.'}];
  const request = {source: {poster: 'https://pbs.twimg.com/ext_tw_video_thumb/123/a.jpg'}, model: 'tiny', videoSourceLanguage: 'auto'};
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
