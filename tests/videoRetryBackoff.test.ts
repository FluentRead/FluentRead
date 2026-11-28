import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {
  classifyVideoError,
  computeBackoffDelayMs,
  createCaptionFetchBackoff,
} from '@/src/features/video-subtitle/content/retryBackoff';
import {readVideoCaptionText} from '@/src/features/video-subtitle/content/subtitleTransport';
import {YoutubeHumanCaptions} from '@/src/features/video-subtitle/content/youtubeHumanCaptions';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('video retry backoff', () => {
  it('准确分类永久错误、限流错误与瞬态错误', () => {
    expect(classifyVideoError({kind: 'authentication', message: 'Invalid API key'})).toEqual({
      category: 'permanent',
      message: 'Invalid API key',
    });
    expect(classifyVideoError({kind: 'bad-request', message: 'Bad model'})).toEqual({
      category: 'permanent',
      message: 'Bad model',
    });
    expect(classifyVideoError({code: 'TRANSLATION_SERVICE_DISABLED', message: 'Disabled'})).toEqual({
      category: 'permanent',
      message: 'Disabled',
    });
    for (const statusCode of [401, 403, 404, 410]) {
      expect(classifyVideoError(Object.assign(new Error(`HTTP ${statusCode}`), {statusCode}))).toEqual({
        category: 'permanent',
        statusCode,
        message: `HTTP ${statusCode}`,
      });
    }
    expect(classifyVideoError({statusCode: 403, retryAfterMs: 10_000, message: 'Forbidden'})).toEqual({
      category: 'permanent',
      statusCode: 403,
      retryAfterMs: 10_000,
      message: 'Forbidden',
    });
    expect(classifyVideoError({retryable: false, message: 'No retry'})).toEqual({
      category: 'permanent',
      message: 'No retry',
    });
    expect(classifyVideoError({retryable: false, statusCode: 422, message: 'Unprocessable'})).toEqual({
      category: 'permanent',
      statusCode: 422,
      message: 'Unprocessable',
    });
    expect(classifyVideoError(new Error('Extension context invalidated.'))).toEqual({
      category: 'permanent',
      message: 'Extension context invalidated.',
    });
    expect(classifyVideoError('扩展上下文已失效')).toEqual({
      category: 'permanent',
      message: '扩展上下文已失效',
    });

    // FreePoolExhaustedError 同时携带 rate-limit 信号与 retryable: false，仍须归类为 rate-limit 而非 permanent。
    expect(classifyVideoError({
      kind: 'rate-limit',
      retryable: false,
      code: 'FREE_TRANSLATION_TEMPORARILY_UNAVAILABLE',
      retryAfterMs: 30_000,
      message: 'Free pool exhausted',
    })).toEqual({
      category: 'rate-limit',
      retryAfterMs: 30_000,
      message: 'Free pool exhausted',
    });
    expect(classifyVideoError({kind: 'rate-limit', message: 'Too many requests'})).toEqual({
      category: 'rate-limit',
      message: 'Too many requests',
    });
    expect(classifyVideoError({statusCode: 429, retryAfterMs: 12_000, message: '429'})).toEqual({
      category: 'rate-limit',
      statusCode: 429,
      retryAfterMs: 12_000,
      message: '429',
    });
    expect(classifyVideoError({code: 'FREE_TRANSLATION_TEMPORARILY_UNAVAILABLE', message: 'Busy'})).toEqual({
      category: 'rate-limit',
      message: 'Busy',
    });
    expect(classifyVideoError({retryAfterMs: 3_000, message: 'Slow down'})).toEqual({
      category: 'rate-limit',
      retryAfterMs: 3_000,
      message: 'Slow down',
    });

    // AttemptTimeoutError 及其他显式瞬态 kind 即使携带 retryable: false 也不得熔断为 permanent。
    for (const kind of ['timeout', 'network', 'provider', 'response']) {
      expect(classifyVideoError({kind, retryable: false, message: `Transient ${kind}`})).toEqual({
        category: 'transient',
        message: `Transient ${kind}`,
      });
    }

    expect(classifyVideoError(Object.assign(new Error('Service unavailable'), {statusCode: 503}))).toEqual({
      category: 'transient',
      statusCode: 503,
      message: 'Service unavailable',
    });
    expect(classifyVideoError(new Error('Network failed'))).toEqual({
      category: 'transient',
      message: 'Network failed',
    });
    expect(classifyVideoError({statusCode: NaN, retryAfterMs: 0})).toEqual({
      category: 'transient',
      message: '',
    });
    expect(classifyVideoError(null)).toEqual({category: 'transient', message: ''});
    expect(classifyVideoError(undefined)).toEqual({category: 'transient', message: ''});
    expect(classifyVideoError('plain transient error')).toEqual({
      category: 'transient',
      message: 'plain transient error',
    });
  });

  it('按有界抖动、最大上限和 Retry-After 计算退避延迟', () => {
    expect(computeBackoffDelayMs(1, {random: () => 0})).toBe(2_000);
    expect(computeBackoffDelayMs(1, {random: () => 1})).toBe(2_400);
    expect(computeBackoffDelayMs(2, {random: () => 0.5})).toBe(5_500);
    expect(computeBackoffDelayMs(99, {random: () => 0})).toBe(30_000);
    expect(computeBackoffDelayMs(0, {random: () => 0})).toBe(2_000);
    expect(computeBackoffDelayMs(NaN, {baseDelaysMs: [], random: () => NaN})).toBe(2_000);

    // 默认基础退避受 60_000ms 上限限制，但显式 Retry-After 更大时优先遵循。
    expect(computeBackoffDelayMs(5, {
      baseDelaysMs: [5_000, 5_000, 15_000, 30_000, 60_000],
      jitterRatio: 0.2,
      random: () => 1,
    })).toBe(60_000);
    expect(computeBackoffDelayMs(1, {retryAfterMs: 90_000, random: () => 0})).toBe(90_000);
    expect(computeBackoffDelayMs(1, {retryAfterMs: 500, random: () => 0})).toBe(2_000);
    expect(computeBackoffDelayMs(1, {retryAfterMs: 90_000, maxDelayMs: 30_000, random: () => 0})).toBe(30_000);
    expect(computeBackoffDelayMs(1, {jitterRatio: 5, random: () => 2})).toBe(4_000);
    expect(computeBackoffDelayMs(1, {jitterRatio: -1, random: () => -1})).toBe(2_000);
    // 无 random 参数时回退到 Math.random。
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(computeBackoffDelayMs(1)).toBe(2_200);
    randomSpy.mockRestore();
  });

  it('字幕轨道退避状态机在前两次保持 5 秒，随后递增并在 429/永久错误/超限时正确收口', () => {
    let clock = 1_000;
    const backoff = createCaptionFetchBackoff({now: () => clock, random: () => 0.5});
    expect(backoff.canAttempt()).toBe(true);
    expect(backoff.getState()).toEqual({
      attempts: 0, retryAt: 0, exhausted: false, lastCategory: null, lastMessage: '',
    });

    // 第 1、2 次保持精确 5_000ms（无抖动），兼容既有 5001ms 契约。
    expect(backoff.recordFailure(new Error('503'))).toMatchObject({
      attempts: 1, retryAt: 6_000, exhausted: false, lastCategory: 'transient',
    });
    expect(backoff.canAttempt()).toBe(false);
    clock = 6_000;
    expect(backoff.canAttempt()).toBe(true);

    expect(backoff.recordFailure(new Error('empty'))).toMatchObject({
      attempts: 2, retryAt: 11_000, exhausted: false,
    });
    clock = 11_000;

    // 第 3 次起 15s → 30s → 60s 带抖动（random=0.5, jitter=0.2 => *1.1）。
    expect(backoff.recordFailure(new Error('503'))).toMatchObject({
      attempts: 3, retryAt: 11_000 + 16_500, exhausted: false,
    });
    clock = 11_000 + 16_500;
    expect(backoff.recordFailure(new Error('503'))).toMatchObject({
      attempts: 4, retryAt: clock + 33_000, exhausted: false,
    });
    clock += 33_000;
    expect(backoff.recordFailure(new Error('503'))).toMatchObject({
      attempts: 5, retryAt: clock + 60_000, exhausted: false,
    });
    clock += 60_000;
    expect(backoff.recordFailure(new Error('503'))).toMatchObject({
      attempts: 6, retryAt: Infinity, exhausted: true,
    });
    expect(backoff.canAttempt(clock + 999_999)).toBe(false);

    backoff.recordSuccess();
    expect(backoff.canAttempt()).toBe(true);
    expect(backoff.getState().attempts).toBe(0);

    // 429 立即遵循 Retry-After。
    const rateLimited = createCaptionFetchBackoff({now: () => 5_000, jitterRatio: 0, maxAttempts: 4});
    expect(rateLimited.recordFailure({statusCode: 429, retryAfterMs: 25_000, message: '429'})).toMatchObject({
      attempts: 1, retryAt: 30_000, exhausted: false, lastCategory: 'rate-limit',
    });

    // 永久错误（403/404/410）立即停止自动重试直到 reset。
    expect(rateLimited.recordFailure({statusCode: 403, message: 'Forbidden'})).toMatchObject({
      exhausted: true, retryAt: Infinity, lastCategory: 'permanent',
    });
    expect(rateLimited.canAttempt(999_999)).toBe(false);
    rateLimited.reset();
    expect(rateLimited.canAttempt(5_000)).toBe(true);
  });

  it('subtitleTransport 在非 2xx 错误上保留原文案并附加 statusCode 与可选 retryAfterMs', async () => {
    const rateLimited = await readVideoCaptionText(
      'https://www.youtube.com/api/timedtext?v=abc',
      async () => new Response('', {status: 429, headers: {'retry-after': '12'}}),
      {credentials: 'include'},
    ).catch(error => error);
    expect(rateLimited).toBeInstanceOf(Error);
    expect(rateLimited.message).toBe('字幕轨道请求失败（429）');
    expect(rateLimited.statusCode).toBe(429);
    expect(rateLimited.retryAfterMs).toBe(12_000);

    const serverError = await readVideoCaptionText(
      'https://www.youtube.com/api/timedtext?v=abc',
      async () => new Response('', {status: 503}),
      {credentials: 'include'},
    ).catch(error => error);
    expect(serverError.message).toBe('字幕轨道请求失败（503）');
    expect(serverError.statusCode).toBe(503);
    expect('retryAfterMs' in serverError).toBe(false);

    const headerlessError = await readVideoCaptionText(
      'https://www.youtube.com/api/timedtext?v=abc',
      async () => ({ok: false, status: 502, body: null}) as unknown as Response,
      {credentials: 'include'},
    ).catch(error => error);
    expect(headerlessError.message).toBe('字幕轨道请求失败（502）');
    expect(headerlessError.statusCode).toBe(502);
    expect('retryAfterMs' in headerlessError).toBe(false);
  });
});

function createYoutubeDoc(tracks: unknown[]) {
  const {document} = parseHTML('<html><body></body></html>');
  const script = document.createElement('script');
  script.textContent = `var ytInitialPlayerResponse=${JSON.stringify({
    videoDetails: {videoId: 'abc'},
    captions: {playerCaptionsTracklistRenderer: {captionTracks: tracks}},
  })};`;
  document.body.appendChild(script);
  return document;
}

describe('YoutubeHumanCaptions 退避与负缓存优化', () => {
  const location = new URL('https://www.youtube.com/watch?v=abc');
  const validBody = JSON.stringify({events: [{tStartMs: 0, dDurationMs: 1500, segs: [{utf8: '人工译文'}]}]});

  it('已加载、退避中及无人工轨视频不重复扫描和解析页面脚本', async () => {
    vi.useFakeTimers();
    const emptyDoc = createYoutubeDoc([]);
    const emptyQuerySpy = vi.spyOn(emptyDoc, 'querySelectorAll');
    const parseSpy = vi.spyOn(JSON, 'parse');
    const fetch = vi.fn().mockResolvedValue(new Response(validBody));
    const source = new YoutubeHumanCaptions(fetch, vi.fn(), {random: () => 0});

    // 无人工轨缓存：连续 10 次 sync 只 JSON.parse 一次。
    for (let i = 0; i < 10; i += 1) {
      source.sync(emptyDoc, location, 'zh-Hans', true);
    }
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(emptyQuerySpy).toHaveBeenCalled();

    // 注入新 script 后 scriptCount 变化，缓存自动失效并发现轨道。
    const newScript = emptyDoc.createElement('script');
    newScript.textContent = `var ytInitialPlayerResponse=${JSON.stringify({
      videoDetails: {videoId: 'abc'},
      captions: {playerCaptionsTracklistRenderer: {captionTracks: [{baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=zh-CN', languageCode: 'zh-CN'}]}},
    })};`;
    emptyDoc.body.appendChild(newScript);
    source.sync(emptyDoc, location, 'zh-Hans', true);
    await source.ready();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(source.at(500)).toBe('人工译文');

    // 已加载后同视频/语言/开关的 sync 在查询 script 前直接返回。
    emptyQuerySpy.mockClear();
    parseSpy.mockClear();
    for (let i = 0; i < 10; i += 1) {
      source.sync(emptyDoc, location, 'zh-Hans', true);
    }
    expect(emptyQuerySpy).not.toHaveBeenCalled();
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it('遵守 429 Retry-After、在 403/404/410 停止自动重试并在切轨或换视频后恢复', async () => {
    vi.useFakeTimers();
    const doc = createYoutubeDoc([{baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=zh-CN', languageCode: 'zh-CN'}]);
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('', {status: 429, headers: {'retry-after': '20'}}))
      .mockResolvedValueOnce(new Response('', {status: 403}))
      .mockResolvedValue(new Response(validBody));
    const source = new YoutubeHumanCaptions(fetch, vi.fn(), {random: () => 0});

    source.sync(doc, location, 'zh-Hans', true);
    await source.ready();
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(19_000);
    source.sync(doc, location, 'zh-Hans', true);
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_001);
    source.sync(doc, location, 'zh-Hans', true);
    await source.ready();
    expect(fetch).toHaveBeenCalledTimes(2);

    // 403 永久错误后即使推进很久也不再自动请求。
    await vi.advanceTimersByTimeAsync(600_000);
    source.sync(doc, location, 'zh-Hans', true);
    expect(fetch).toHaveBeenCalledTimes(2);

    // 切换目标语言后再切回，或更换视频后恢复重试。
    source.sync(doc, location, 'en', true);
    source.sync(doc, location, 'zh-Hans', true);
    await source.ready();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(source.at(100)).toBe('人工译文');
  });

  it('退避期间脚本轨道 URL 变化时重置退避并请求新轨道，轨道消失时清理状态', async () => {
    vi.useFakeTimers();
    const doc1 = createYoutubeDoc([{baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=zh-CN&v=1', languageCode: 'zh-CN'}]);
    const doc2 = createYoutubeDoc([{baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=zh-CN&v=2', languageCode: 'zh-CN'}]);
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('', {status: 503}))
      .mockResolvedValue(new Response(validBody));
    const source = new YoutubeHumanCaptions(fetch, vi.fn(), {random: () => 0});

    source.sync(doc1, location, 'zh-Hans', true);
    await source.ready();
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_001);
    source.sync(doc2, location, 'zh-Hans', true);
    await source.ready();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(source.at(100)).toBe('人工译文');

    source.clear();
    const emptyDoc = createYoutubeDoc([]);
    source.sync(emptyDoc, location, 'zh-Hans', true);
    expect(source.at(100)).toBe('');
  });
});
