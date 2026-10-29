/**
 * @file tests/videoAiSubtitleCache.test.ts
 * 文件职责：验证完整视频 AI 字幕持久缓存的稳定身份、规范化、TTL/LRU 和后台消息边界。
 * 主要内容：使用 fake-indexeddb 覆盖防临时 blob 键、模型/视频源语言隔离、完整 cue 白名单、统计和清空。
 * 模块边界：测试不启动浏览器、不读取音频、不调用 Whisper 或翻译服务。
 */
import 'fake-indexeddb/auto';
import {afterEach, describe, expect, it} from 'vitest';
import {
  VIDEO_AI_SUBTITLE_CACHE_CLEAR_MESSAGE,
  VIDEO_AI_SUBTITLE_CACHE_GET_MESSAGE,
  VIDEO_AI_SUBTITLE_CACHE_SET_MESSAGE,
  VIDEO_AI_SUBTITLE_CACHE_STATS_MESSAGE,
  createVideoAiSubtitleCacheHandlers,
} from '@/src/features/video-subtitle/background/cacheHandlers';
import {
  FluentReadVideoAiSubtitleCacheDatabase,
  VIDEO_AI_SUBTITLE_CACHE_TTL_MS,
  VideoAiSubtitleCacheRepository,
} from '@/src/features/video-subtitle/background/transcriptionCache';
import {
  buildVideoAiSubtitleCacheIdentity,
  buildVideoAiSubtitleVideoKey,
  normalizeCompletedVideoAiSubtitleCues,
} from '@/src/features/video-subtitle/transcriptionCache';

const databases: FluentReadVideoAiSubtitleCacheDatabase[] = [];
let sequence = 0;

afterEach(async () => {
  await Promise.all(databases.splice(0).map(async (database) => {
    database.close();
    await database.delete();
  }));
});

function repository(): VideoAiSubtitleCacheRepository {
  const database = new FluentReadVideoAiSubtitleCacheDatabase(`VideoAiSubtitleCacheTest-${++sequence}`);
  databases.push(database);
  return new VideoAiSubtitleCacheRepository(database);
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    source: {statusUrl: 'https://x.com/example/status/12345', mediaId: '67890', poster: 'https://pbs.twimg.com/ext_tw_video_thumb/67890/pu/img.jpg'},
    model: 'tiny',
    videoSourceLanguage: 'auto',
    ...overrides,
  };
}

function cue(text = 'A complete sentence.', overrides: Record<string, unknown> = {}) {
  return {startMs: 0, durationMs: 1_000, spokenEndMs: 1_000, text, ...overrides};
}

describe('video AI subtitle cache identity', () => {
  it('prefers stable status/media identity and rejects ephemeral sources', () => {
    expect(buildVideoAiSubtitleVideoKey({statusUrl: 'https://x.com/a/status/12345', mediaId: '67890', directSource: 'blob:https://x.com/temp'}))
      .toBe('media:67890');
    expect(buildVideoAiSubtitleVideoKey({poster: 'https://pbs.twimg.com/ext_tw_video_thumb/67890/pu/img.jpg'}))
      .toBe('media:67890');
    expect(buildVideoAiSubtitleVideoKey({directSource: 'https://video.twimg.com/ext_tw_video/67890/pu/vid.mp4?token=ephemeral'}))
      .toBe('media:67890');
    expect(buildVideoAiSubtitleVideoKey({poster: 'https://cdn.example.test/poster.jpg'}))
      .toBe('poster:https://cdn.example.test/poster.jpg');
    expect(buildVideoAiSubtitleVideoKey({statusUrl: 'https://x.com/a/status/12345'}))
      .toBeNull();
    expect(buildVideoAiSubtitleVideoKey({statusUrl: 'https://x.com/a/status/12345', videoIndex: '2'}))
      .toBe('tweet:12345:video:2');
    expect(buildVideoAiSubtitleVideoKey({directSource: 'https://cdn.example.test/video.mp4'}))
      .toBe('source:https://cdn.example.test/video.mp4');
    expect(buildVideoAiSubtitleVideoKey({directSource: 'ftp://cdn.example.test/video.mp4'})).toBeNull();
    expect(buildVideoAiSubtitleVideoKey({directSource: 'blob:https://x.com/temporary'})).toBeNull();
    expect(buildVideoAiSubtitleVideoKey({directSource: 'data:video/mp4;base64,abc'})).toBeNull();
    expect(buildVideoAiSubtitleVideoKey({directSource: 'not a URL'})).toBeNull();
  });

  it('isolates model and video source language in the schema key', () => {
    const tiny = buildVideoAiSubtitleCacheIdentity(request());
    const base = buildVideoAiSubtitleCacheIdentity(request({model: 'base'}));
    const korean = buildVideoAiSubtitleCacheIdentity(request({videoSourceLanguage: 'ko'}));
    expect(tiny?.videoKey).toBe('media:67890');
    expect(tiny?.sourceLanguage).toBe('auto');
    expect(base?.model).toBe('base');
    expect(korean?.sourceLanguage).toBe('ko');
    expect(buildVideoAiSubtitleCacheIdentity(request({videoSourceLanguage: undefined, sourceLanguage: 'EN'}))?.sourceLanguage).toBe('en');
    expect(buildVideoAiSubtitleCacheIdentity(request({videoSourceLanguage: undefined, sourceLanguage: ''}))?.sourceLanguage).toBe('auto');
    expect(tiny?.schemaFingerprint).not.toBe('video-ai-cues-v0');
  });
});

describe('video AI subtitle cache repository', () => {
  it('does not restore old fixed-language results after the recognition strategy changes, and separates Small', async () => {
    const cache = repository();
    for (const model of ['tiny', 'base']) {
      await cache.set(request({model}), [cue('Old fixed-language result.')], 1_000);
      const entry = (await cache.database.entries.toArray()).find(item => item.model === model)!;
      await cache.database.entries.delete(entry.key);
      const legacyKey = entry.key.replace('video-ai-cues-v2|', 'video-ai-cues-v1|');
      await cache.database.entries.put({...entry, key: legacyKey, schemaFingerprint: 'video-ai-cues-v1'} as never);
      await expect(cache.get(request({model}), 1_100)).resolves.toBeNull();
    }
    for (const model of ['tiny', 'base', 'small']) {
      const text = `Current ${model} result.`;
      await expect(cache.set(request({model}), [cue(text)], 1_200)).resolves.toBe(true);
      await expect(cache.get(request({model}), 1_300)).resolves.toEqual([cue(text)]);
    }
  });

  it('stores only complete normalized cues and returns defensive copies', async () => {
    const repositoryInstance = repository();
    const value = [cue('  Complete   sentence.  '), cue('Partial sentence.', {startMs: 2_000, partial: true})];
    await expect(repositoryInstance.set(request(), value, 1_000)).resolves.toBe(false);
    await expect(repositoryInstance.set(request(), [cue('  Complete   sentence.  ')], 1_000)).resolves.toBe(true);
    await expect(repositoryInstance.set(request(), [cue('Complete sentence updated.')], 1_500)).resolves.toBe(true);
    const loaded = await repositoryInstance.get(request(), 1_100);
    expect(loaded).toEqual([cue('Complete sentence updated.')]);
    loaded![0].text = 'mutated outside';
    expect((await repositoryInstance.get(request(), 1_600))![0].text).toBe('Complete sentence updated.');
    expect(normalizeCompletedVideoAiSubtitleCues([cue('bad', {partial: true})])).toEqual([]);
    const oversized = Array.from({length: 1_201}, (_, index) => cue(`Cue ${index}.`, {startMs: index * 1_000}));
    expect(normalizeCompletedVideoAiSubtitleCues(oversized)).toEqual([]);
    await expect(repositoryInstance.set(request(), oversized, 2_000)).resolves.toBe(false);
    expect((await repositoryInstance.stats(1_200)).bytes).toBeGreaterThan(0);
    expect(await repositoryInstance.get(request({source: {}}), 1_200)).toBeNull();
  });

  it('expires entries and evicts least recently used entries at the bound', async () => {
    const repositoryInstance = repository();
    const now = 10_000;
    await repositoryInstance.set(request({source: {mediaId: 'old'} }), [cue()], now - VIDEO_AI_SUBTITLE_CACHE_TTL_MS - 1);
    expect(await repositoryInstance.get(request({source: {mediaId: 'old'} }), now)).toBeNull();
    for (let index = 0; index < 33; index += 1) {
      await repositoryInstance.set(request({source: {mediaId: `m-${index}`} }), [cue(`Cue ${index}.`)], now + index);
    }
    expect((await repositoryInstance.stats(now + 100)).entries).toBe(32);
    expect(await repositoryInstance.get(request({source: {mediaId: 'm-0'} }), now + 100)).toBeNull();
    expect(await repositoryInstance.get(request({source: {mediaId: 'm-32'} }), now + 100)).toHaveLength(1);
    await repositoryInstance.clear();
    expect((await repositoryInstance.stats(now + 101)).entries).toBe(0);
  });
});

describe('video AI subtitle cache background handlers', () => {
  it('implements typed get/set/stats/clear messages without exposing audio', async () => {
    const repositoryInstance = repository();
    const handlers = createVideoAiSubtitleCacheHandlers(repositoryInstance);
    const find = (type: string) => handlers.find((handler) => handler.type === type)!;
    const invoke = (type: string, message: any) => find(type).handle(message, undefined);
    const input = request();
    await expect(invoke(VIDEO_AI_SUBTITLE_CACHE_SET_MESSAGE, {...input, cues: [cue()]})).resolves.toEqual({success: true, cached: true});
    const loaded = await invoke(VIDEO_AI_SUBTITLE_CACHE_GET_MESSAGE, input);
    expect(loaded).toMatchObject({success: true, hit: true, cues: [cue()]});
    expect(loaded).not.toHaveProperty('audio');
    expect(await invoke(VIDEO_AI_SUBTITLE_CACHE_STATS_MESSAGE, {})).toMatchObject({success: true, stats: {entries: 1}});
    expect(await invoke(VIDEO_AI_SUBTITLE_CACHE_CLEAR_MESSAGE, {})).toEqual({success: true});
    expect(await invoke(VIDEO_AI_SUBTITLE_CACHE_GET_MESSAGE, input)).toMatchObject({success: true, hit: false, cues: []});
    await expect(invoke(VIDEO_AI_SUBTITLE_CACHE_GET_MESSAGE, null)).rejects.toThrow('身份无效');
    await expect(invoke(VIDEO_AI_SUBTITLE_CACHE_GET_MESSAGE, {source: {}})).resolves.toMatchObject({success: true, hit: false, cacheKey: null});
    await expect(invoke(VIDEO_AI_SUBTITLE_CACHE_SET_MESSAGE, {...input, cues: {error: true}})).resolves.toEqual({success: true, cached: false});
    await expect(invoke(VIDEO_AI_SUBTITLE_CACHE_GET_MESSAGE, {source: 'bad'})).rejects.toThrow('source 无效');
  });
});

describe('native ASR cache identity isolation', () => {
  const native = {provider: 'native-qwen', model: 'Qwen/Qwen3-ASR-1.7B', nativeBaseUrl: 'http://127.0.0.1:8000/v1/'};
  it('normalizes native identity without conflating it with browser models', () => {
    const identity = buildVideoAiSubtitleCacheIdentity(request({...native, videoSourceLanguage: 'EN'}));
    expect(buildVideoAiSubtitleCacheIdentity(request({...native, videoSourceLanguage: undefined, sourceLanguage: 'EN'}))).toEqual(identity);
    expect(identity).toEqual({videoKey: 'media:67890', model: native.model, provider: 'native-qwen',
      nativeBaseUrl: 'http://127.0.0.1:8000', sourceLanguage: 'en', schemaFingerprint: 'video-native-qwen-text-v1'});
    expect(buildVideoAiSubtitleCacheIdentity(request({provider: 'browser'}))).toEqual(buildVideoAiSubtitleCacheIdentity(request()));
    expect(buildVideoAiSubtitleCacheIdentity(request({provider: 'unknown'}))).toBeNull();
    for (const nativeBaseUrl of [undefined, '', 'https://remote.example.com']) {
      expect(buildVideoAiSubtitleCacheIdentity(request({...native, nativeBaseUrl}))).toBeNull();
    }
    expect(buildVideoAiSubtitleCacheIdentity(request({...native, model: 'tiny'}))).toBeNull();
  });
});

it('native cache reuses only equivalent endpoint, language and provider identities', async () => {
  const cache = repository();
  const native = {provider: 'native-qwen', model: 'Qwen/Qwen3-ASR-1.7B',
    nativeBaseUrl: 'http://127.0.0.1:8000/v1/', videoSourceLanguage: 'en'};
  await expect(cache.set(request(native), [cue('Native result.')], 1000)).resolves.toBe(true);
  await expect(cache.get(request({...native, nativeBaseUrl: 'http://127.0.0.1:8000'}), 1100)).resolves.toEqual([cue('Native result.')]);
  await expect(cache.get(request({...native, nativeBaseUrl: 'http://127.0.0.1:9000'}), 1100)).resolves.toBeNull();
  await expect(cache.get(request({...native, videoSourceLanguage: 'ja'}), 1100)).resolves.toBeNull();
  await expect(cache.get(request({provider: 'browser', videoSourceLanguage: 'en'}), 1100)).resolves.toBeNull();
});
