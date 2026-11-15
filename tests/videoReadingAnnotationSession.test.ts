import {describe, expect, it, vi} from 'vitest';
import {VideoReadingAnnotationSession, type VideoReadingAnnotation} from '@/src/features/video-subtitle/content/readingAnnotationSession';
import {normalizeVideoSubtitleAppearance} from '@/src/core/config/videoSubtitleAppearance';

const result = (text: string, language = 'ja'): VideoReadingAnnotation => ({text, language, scheme: 'hepburn'});
const flush = async () => { for (let index = 0; index < 6; index += 1) await Promise.resolve(); };
const deferred = () => {
  let resolve!: (value: VideoReadingAnnotation | null) => void, reject!: (error?: unknown) => void;
  return {promise: new Promise<VideoReadingAnnotation | null>((yes, no) => { resolve = yes; reject = no; }),
    resolve: (value: VideoReadingAnnotation | null) => resolve(value), reject: (error?: unknown) => reject(error)};
};

describe('视频读音标注会话', () => {
  it.each([false, true])('同句重复请求保留当前或预取归属，不重复运行引擎（prefetch=%s）', async prefetch => {
    const pending = deferred(), annotate = vi.fn(() => pending.promise), session = new VideoReadingAnnotationSession(annotate);
    const first = session.request('same', 'ja', prefetch); await flush();
    expect(session.request(' same ', 'JA', prefetch)).toBe(first); expect(annotate).toHaveBeenCalledOnce();
    pending.resolve(result('same')); await expect(first).resolves.toEqual(result('same')); session.destroy();
  });
  it('读音偏好默认关闭，只接受显式布尔值且独立于逐字高亮', () => {
    expect(normalizeVideoSubtitleAppearance(undefined).readingAnnotation).toBe(false);
    expect(normalizeVideoSubtitleAppearance({readingAnnotation: 'true'}).readingAnnotation).toBe(false);
    expect(normalizeVideoSubtitleAppearance({readingAnnotation: true, karaoke: false})).toMatchObject({readingAnnotation: true, karaoke: false});
  });

  it('规范化同文同语言，缓存无需标注结果，区分语言且不调用空输入或过长输入', async () => {
    const annotate = vi.fn(async (text: string, language: string) => text === 'none' ? null : result(text, language));
    const session = new VideoReadingAnnotationSession(annotate);
    await expect(session.request('', 'ja')).resolves.toBeNull();
    await expect(session.request('text', ' ')).resolves.toBeNull();
    await expect(session.request('a'.repeat(3001), 'ja')).resolves.toBeNull();
    expect(session.peek('none', 'ja')).toBeUndefined();
    await expect(session.request('none', 'ja')).resolves.toBeNull();
    expect(session.peek('none', 'ja')).toBeNull();
    await session.request(' none ', 'ja');
    await expect(session.request(' おはよう\n 世界 ', ' JA_JP ')).resolves.toEqual(result('おはよう 世界', 'ja-jp'));
    await expect(session.request('おはよう 世界', 'zh')).resolves.toEqual(result('おはよう 世界', 'zh'));
    expect(annotate).toHaveBeenCalledTimes(3);
    expect(session.revision).toBe(3);
  });

  it('同句在途合并，已经开始的预取提升为当前句后不会重复运行或阻塞下一句', async () => {
    const pending = deferred();
    const annotate = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(result('next'));
    const session = new VideoReadingAnnotationSession(annotate);
    const first = session.request('same', 'ja', true); await flush();
    const second = session.request(' same ', 'JA');
    expect(second).toBe(first);
    pending.resolve(result('same')); await first;
    await expect(session.request('next', 'ja')).resolves.toEqual(result('next'));
    expect(annotate).toHaveBeenCalledTimes(2);
  });

  it('最新当前句中止旧句，不合作引擎的迟到结果不能覆盖新任务或缓存', async () => {
    const old = deferred(), fresh = deferred();
    const annotate = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const session = new VideoReadingAnnotationSession(annotate);
    const a = session.request('a', 'ja'); const aRejected = expect(a).rejects.toMatchObject({name: 'AbortError'}); await flush();
    const b = session.request('b', 'ja'); await aRejected; await flush();
    expect(annotate.mock.calls[0][2].aborted).toBe(true);
    old.resolve(result('late')); await flush();
    expect(session.peek('a', 'ja')).toBeUndefined();
    fresh.resolve(result('b')); await expect(b).resolves.toEqual(result('b'));
    expect(session.peek('b', 'ja')).toEqual(result('b'));
  });

  it('当前缓存命中也中止旧任务，取消后保留成功缓存且clear清空', async () => {
    const annotate = vi.fn().mockResolvedValueOnce(result('saved')).mockImplementation(() => new Promise(() => undefined));
    const session = new VideoReadingAnnotationSession(annotate);
    await session.request('saved', 'ja');
    const pending = session.request('pending', 'ja'); const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError'}); await flush();
    await expect(session.request('saved', 'ja')).resolves.toEqual(result('saved'));
    await rejected;
    session.cancelPending(); expect(session.peek('saved', 'ja')).toEqual(result('saved'));
    session.clear(); expect(session.peek('saved', 'ja')).toBeUndefined(); expect(session.revision).toBe(2);
    session.clear(); expect(session.revision).toBe(2);
  });

  it('排队预取提升当前优先级，中止旧在途预取并只保留四个排队预取', async () => {
    const running = deferred();
    const annotate = vi.fn().mockReturnValueOnce(running.promise).mockImplementation(async (text: string) => result(text));
    const session = new VideoReadingAnnotationSession(annotate);
    const active = session.request('active', 'ja', true); const activeRejected = expect(active).rejects.toMatchObject({name: 'AbortError'}); await flush();
    const obsolete = session.request('obsolete', 'ja', true); const obsoleteRejected = expect(obsolete).rejects.toMatchObject({name: 'AbortError'});
    const queued = ['q1', 'q2', 'q3', 'q4'].map(text => session.request(text, 'ja', true));
    await obsoleteRejected;
    expect(session.request('q3', 'ja')).toBe(queued[2]);
    await activeRejected; await Promise.all(queued);
    expect(annotate.mock.calls.map(call => call[0])).toEqual(['active', 'q3', 'q1', 'q2', 'q4']);
    running.reject(new Error('late')); await flush();
  });

  it('播放窗口丢弃过期预取但不取消当前句，并跳过同轮就失效的昂贵引擎调用', async () => {
    const annotate = vi.fn(async (text: string) => result(text));
    const session = new VideoReadingAnnotationSession(annotate);
    const obsolete = session.request('old', 'ja', true); const rejected = expect(obsolete).rejects.toMatchObject({name: 'AbortError'});
    const current = session.request('current', 'ja');
    const kept = session.request('kept', 'ja', true);
    const removed = session.request('removed', 'ja', true); const removedRejected = expect(removed).rejects.toMatchObject({name: 'AbortError'});
    session.retainPrefetches([{text: ' kept ', language: 'JA'}]);
    await rejected; await removedRejected; await Promise.all([current, kept]);
    expect(annotate.mock.calls.map(call => call[0])).toEqual(['current', 'kept']);
  });

  it('clear使相同输入的旧响应失效，destroy永久拒绝新请求并清空缓存', async () => {
    const old = deferred(), next = deferred();
    const annotate = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const session = new VideoReadingAnnotationSession(annotate);
    const first = session.request('same', 'ja'); const rejected = expect(first).rejects.toMatchObject({name: 'AbortError'}); await flush();
    session.clear(); await rejected;
    const second = session.request('same', 'ja'); await flush();
    old.resolve(result('old')); await flush(); expect(session.peek('same', 'ja')).toBeUndefined();
    next.resolve(result('new')); await second;
    session.destroy(); session.destroy();
    expect(session.peek('same', 'ja')).toBeUndefined();
    await expect(session.request('same', 'ja')).rejects.toMatchObject({name: 'AbortError'});
  });

  it('引擎抛错与无值拒绝均原样失败，失败不进入缓存且下一次可以重试', async () => {
    const annotate = vi.fn().mockRejectedValueOnce(new Error('failed')).mockRejectedValueOnce(undefined).mockResolvedValue(result('ok'));
    const session = new VideoReadingAnnotationSession(annotate);
    await expect(session.request('same', 'ja')).rejects.toThrow('failed');
    await expect(session.request('same', 'ja')).rejects.toBeUndefined();
    expect(session.peek('same', 'ja')).toBeUndefined();
    await expect(session.request('same', 'ja')).resolves.toEqual(result('ok'));
  });

  it('LRU读取保留近期条目，条数和字符量独立有界，超预算结果不留存', async () => {
    const annotate = vi.fn(async (text: string) => result(text));
    const session = new VideoReadingAnnotationSession(annotate, {maxEntries: 2});
    await session.request('a', 'ja'); await session.request('b', 'ja'); session.peek('a', 'ja'); await session.request('c', 'ja');
    expect(session.peek('a', 'ja')).toEqual(result('a')); expect(session.peek('b', 'ja')).toBeUndefined();
    const bounded = new VideoReadingAnnotationSession(annotate, {maxCharacters: 15});
    await bounded.request('a', 'ja'); await bounded.request('b', 'ja');
    expect(bounded.peek('a', 'ja')).toBeUndefined(); expect(bounded.peek('b', 'ja')).toEqual(result('b'));
    await bounded.request('too-long-to-cache', 'ja'); expect(bounded.peek('too-long-to-cache', 'ja')).toBeUndefined();
    const invalid = new VideoReadingAnnotationSession(annotate, {maxEntries: NaN, maxCharacters: 0});
    await invalid.request('a', 'ja'); expect(invalid.peek('a', 'ja')).toEqual(result('a'));
  });
});
