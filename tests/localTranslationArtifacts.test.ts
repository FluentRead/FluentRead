import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {sha256} from '@noble/hashes/sha256';
import {
  MODEL_CHUNK_SIZE, artifactComplete, artifactDownloadedBytes, artifactUrl,
  downloadTranslationArtifact, invalidateTranslationArtifactReceipt, removeTranslationArtifact,
  resetTranslationDownloadOriginMemory, translationArtifactBlob, translationArtifactDownloadUrls,
  getTranslationArtifacts, type TranslationArtifact,
  matchTranslationArtifact,
} from '@/src/features/local-translation/offscreen/artifactStore';
import {LOCAL_TRANSLATION_MODELS, LOCAL_TRANSLATION_MODEL_IDS} from '@/src/core/config/localTranslation';
import {createLocalTranslationDownloadManager} from '@/src/features/local-translation/offscreen/downloads';

function fileFor(bytes: Uint8Array): TranslationArtifact {
  return {repo: 'test/model', revision: 'pinned-revision', path: 'weights.bin', size: bytes.length,
    sha256: Array.from(sha256(bytes), (value) => value.toString(16).padStart(2, '0')).join('')};
}
const entries = new Map<string, Response>();
const cache = {
  match: vi.fn(async (key: string) => entries.get(key)?.clone()),
  put: vi.fn(async (key: string, value: Response) => { entries.set(key, value.clone()); }),
  delete: vi.fn(async (key: string) => entries.delete(key)),
  keys: vi.fn(async (key: string, options?: {ignoreSearch?: boolean}) => [...entries.keys()]
    .filter(value => options?.ignoreSearch ? value.split('?')[0] === key.split('?')[0] : value === key)
    .map(value => new Request(value))),
};
beforeEach(() => {
  entries.clear();
  vi.clearAllMocks();
  resetTranslationDownloadOriginMemory();
  vi.stubGlobal('caches', {open: vi.fn(async () => cache)});
  vi.stubGlobal('navigator', {language: 'en-US'});
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('verified resumable model downloads', () => {
  it('retries the next origin after fetch fails before producing a response',async()=>{
    const bytes=new Uint8Array([9]),file=fileFor(bytes),fetcher=vi.fn().mockRejectedValueOnce(Error('temporary network failure')).mockResolvedValueOnce(new Response(bytes));
    vi.stubGlobal('fetch',fetcher);await downloadTranslationArtifact(file,new AbortController().signal,()=>undefined);
    expect(fetcher).toHaveBeenCalledTimes(2);expect(await artifactComplete(file)).toBe(true);
  });
  it('assembles partial network chunks before writing and verifying the complete model chunk',async()=>{
    const bytes=new Uint8Array([1,2,3,4,5]),file=fileFor(bytes),progress=vi.fn();
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(bytes.subarray(0,2));controller.enqueue(bytes.subarray(2));controller.close();}}))));
    await downloadTranslationArtifact(file,new AbortController().signal,progress);
    expect(await artifactComplete(file)).toBe(true);expect(new Uint8Array(await (await translationArtifactBlob(file)).arrayBuffer())).toEqual(bytes);
    expect(progress).toHaveBeenCalledWith(2,false);expect(progress).toHaveBeenCalledWith(5,true);
  });
  it('releases rejected response bodies before a reader was acquired and successfully retries the next origin',async()=>{
    const bytes=new Uint8Array([9]),file=fileFor(bytes),cancel=vi.fn(async()=>undefined);
    const body={getReader(){throw Error('reader unavailable');},cancel};
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce({ok:true,status:200,body}).mockResolvedValueOnce(new Response(bytes)));
    await downloadTranslationArtifact(file,new AbortController().signal,()=>undefined);
    expect(cancel).toHaveBeenCalledOnce();expect(await artifactComplete(file)).toBe(true);
  });
  it.each(['http', 'range', 'overflow'])('releases a rejected %s response before falling back even when cancel never settles', async stage => {
    const bytes = new Uint8Array([7]);
    const file = fileFor(bytes);
    let rejectCancel!: (reason: unknown) => void;
    const cancel = vi.fn(() => new Promise<void>((_resolve, reject) => {rejectCancel = reject;}));
    const body = new ReadableStream<Uint8Array>({start(controller) {
      if (stage === 'overflow') controller.enqueue(new Uint8Array([7, 8]));
    }, cancel});
    const rejected = new Response(body, {status: stage === 'http' ? 503 : stage === 'range' ? 206 : 200});
    const fetcher = vi.fn().mockResolvedValueOnce(rejected).mockResolvedValueOnce(new Response(bytes));
    vi.stubGlobal('fetch', fetcher);
    await downloadTranslationArtifact(file, new AbortController().signal, () => undefined);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(await artifactComplete(file)).toBe(true);
    rejectCancel(new Error('late cleanup failure'));
    await Promise.resolve();
  });

  it('reads only catalogued verified files and detects missing or inconsistent chunks', async () => {
    expect(getTranslationArtifacts(LOCAL_TRANSLATION_MODEL_IDS.m2m100)).toEqual([]);
    const file = getTranslationArtifacts(LOCAL_TRANSLATION_MODEL_IDS.opusZhEn).find((file) => file.path === 'config.json')!;
    const url = artifactUrl(file);
    expect(await matchTranslationArtifact('https://example.com/model')).toBeUndefined();
    expect(await matchTranslationArtifact(url)).toBeUndefined();
    await expect(translationArtifactBlob(file)).rejects.toThrow('NOT_DOWNLOADED');
    entries.set(`${url}?fluent-read-verified=${file.sha256}`, new Response('{}'));
    await expect(translationArtifactBlob(file)).rejects.toThrow('NOT_DOWNLOADED');
    await expect(matchTranslationArtifact(url)).rejects.toThrow('NOT_DOWNLOADED');
    entries.set(`${url}?fluent-read-part=0`, new Response('wrong size'));
    await expect(translationArtifactBlob(file)).rejects.toThrow('INTEGRITY');
    entries.set(`${url}?fluent-read-part=0`, new Response(new Uint8Array(file.size), {headers: {'Content-Length': String(file.size)}}));
    expect((await translationArtifactBlob(file)).type).toBe('application/json');
    expect((await matchTranslationArtifact(new Request(url)))?.headers.get('Content-Length')).toBe(String(file.size));
  });

  it('rejects a verified receipt with a missing chunk and repairs the file on retry', async () => {
    const bytes = new Uint8Array(MODEL_CHUNK_SIZE + 1).fill(7);
    const file = fileFor(bytes);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)));
    await downloadTranslationArtifact(file, new AbortController().signal, () => undefined);
    entries.delete(`${artifactUrl(file)}?fluent-read-part=1`);
    expect(await artifactComplete(file)).toBe(false);
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const retry = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => {
      await gate;
      return new Response(bytes.subarray(MODEL_CHUNK_SIZE), {
        status: 206, headers: {'Content-Range': `bytes ${MODEL_CHUNK_SIZE}-${bytes.length - 1}/${bytes.length}`},
      });
    });
    vi.stubGlobal('fetch', retry);
    const repair = downloadTranslationArtifact(file, new AbortController().signal, () => undefined);
    await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
    expect(entries.has(`${artifactUrl(file)}?fluent-read-verified=${file.sha256}`)).toBe(false);
    await expect(translationArtifactBlob(file)).rejects.toThrow('NOT_DOWNLOADED');
    release();await repair;
    expect(retry).toHaveBeenCalledOnce();
    expect(await artifactComplete(file)).toBe(true);
    expect((await translationArtifactBlob(file)).size).toBe(bytes.length);
  });

  it('restores a damaged model as paused instead of ready after offscreen restart', async () => {
    const model = LOCAL_TRANSLATION_MODEL_IDS.opusZhEn;
    const files = getTranslationArtifacts(model);
    for (const file of files) {
      entries.set(`${artifactUrl(file)}?fluent-read-verified=${file.sha256}`, new Response('{}'));
      for (let index = 0; index < Math.ceil(file.size / MODEL_CHUNK_SIZE); index++) {
        const size = Math.min(MODEL_CHUNK_SIZE, file.size - index * MODEL_CHUNK_SIZE);
        entries.set(`${artifactUrl(file)}?fluent-read-part=${index}`, new Response('', {headers: {'Content-Length': String(size)}}));
      }
    }
    const damaged = files.find(file => file.size > MODEL_CHUNK_SIZE)!;
    entries.delete(`${artifactUrl(damaged)}?fluent-read-part=0`);
    const state = (await createLocalTranslationDownloadManager().status()).tasks.find(task => task.model === model)!;
    expect(state.phase).toBe('paused');
    expect(state.downloadedBytes).toBeLessThan(state.totalBytes);
  });

  it('propagates cache read failures instead of interpreting them as missing model data', async () => {
    const file = fileFor(new Uint8Array([7]));
    entries.set(`${artifactUrl(file)}?fluent-read-verified=${file.sha256}`, new Response('{}'));
    cache.match.mockRejectedValueOnce(new Error('cache unavailable'));
    await expect(artifactComplete(file)).rejects.toThrow('cache unavailable');
  });

  it('reverifies existing bytes and redownloads a truncated chunk after integrity retry', async () => {
    const bytes = new Uint8Array([7, 8]);const file = fileFor(bytes), url = artifactUrl(file);
    entries.set(`${url}?fluent-read-verified=${file.sha256}`, new Response('{}'));
    entries.set(`${url}?fluent-read-part=0`, new Response(new Uint8Array([7]), {headers: {'Content-Length': '2'}}));
    await expect(translationArtifactBlob(file)).rejects.toThrow('LOCAL_TRANSLATION_INTEGRITY');
    await invalidateTranslationArtifactReceipt(file);
    const fetcher = vi.fn(async () => new Response(bytes));vi.stubGlobal('fetch', fetcher);
    await downloadTranslationArtifact(file, new AbortController().signal, () => undefined);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await artifactComplete(file)).toBe(true);
    expect(Array.from(new Uint8Array(await (await translationArtifactBlob(file)).arrayBuffer()))).toEqual([7, 8]);
  });

  it('does not delete a receipt when the cache key listing fails', async () => {
    const file = fileFor(new Uint8Array([7]));
    const receipt = `${artifactUrl(file)}?fluent-read-verified=${file.sha256}`;
    entries.set(receipt, new Response('{}'));cache.keys.mockRejectedValueOnce(new Error('cache offline'));
    await expect(downloadTranslationArtifact(file, new AbortController().signal, () => undefined)).rejects.toThrow('cache offline');
    expect(entries.has(receipt)).toBe(true);expect(cache.delete).not.toHaveBeenCalled();
  });

  it('finishes verification from disk without redownloading after interruption', async () => {
    const file = fileFor(new Uint8Array([7]));
    entries.set(`${artifactUrl(file)}?fluent-read-part=0`, new Response(new Uint8Array([7]), {headers: {'Content-Length': '1'}}));
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await downloadTranslationArtifact(file, new AbortController().signal, () => undefined);
    expect(await artifactComplete(file)).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('restarts a partial file if the mirror ignores Range', async () => {
    const bytes = new Uint8Array(MODEL_CHUNK_SIZE + 1).fill(3);
    const file = fileFor(bytes);
    entries.set(`${artifactUrl(file)}?fluent-read-part=0`, new Response(bytes.subarray(0, MODEL_CHUNK_SIZE), {headers: {'Content-Length': String(MODEL_CHUNK_SIZE)}}));
    vi.stubGlobal('navigator', {language: 'zh-CN'});
    const fetcher = vi.fn(async () => new Response(bytes));
    vi.stubGlobal('fetch', fetcher);
    await downloadTranslationArtifact(file, new AbortController().signal, () => undefined);
    expect(fetcher.mock.calls).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('hf-mirror.com'), expect.anything());
    expect(await artifactComplete(file)).toBe(true);
  });

  it.each([
    ['missing response body', () => new Response(null, {status: 204}), 'NETWORK'],
    ['unexpected status', () => new Response('x', {status: 202}), 'NETWORK'],
    ['missing Content-Range', () => new Response('x', {status: 206}), 'INTEGRITY'],
    ['too many bytes', () => new Response('xx'), 'INTEGRITY'],
    ['truncated body', () => new Response(''), 'NETWORK'],
  ])('rejects %s without a ready receipt', async (_label, response, error) => {
    const file = fileFor(new Uint8Array([1]));
    vi.stubGlobal('fetch', vi.fn(async () => response()));
    await expect(downloadTranslationArtifact(file, new AbortController().signal, () => undefined)).rejects.toThrow(error);
    expect(await artifactComplete(file)).toBe(false);
  });

  it('fails verification if a chunk disappears, and never writes a completion receipt after cancellation', async () => {
    const bytes = new Uint8Array([8]);
    const file = fileFor(bytes);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)));
    await expect(downloadTranslationArtifact(file, new AbortController().signal, (_bytes, verifying) => {
      if (verifying) entries.delete(`${artifactUrl(file)}?fluent-read-part=0`);
    })).rejects.toThrow('INTEGRITY');
    const controller = new AbortController();
    await expect(downloadTranslationArtifact(file, controller.signal, (_bytes, verifying) => {
      if (verifying) controller.abort();
    })).rejects.toMatchObject({name: 'AbortError'});
    expect(await artifactComplete(file)).toBe(false);
  });
  it('falls back between sources using the same pinned revision and verifies before exposing the file', async () => {
    const body = new TextEncoder().encode('verified model');
    const file = fileFor(body);
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, {status: 503})).mockResolvedValueOnce(new Response(body));
    vi.stubGlobal('fetch', fetcher);
    const progress = vi.fn();
    await downloadTranslationArtifact(file, new AbortController().signal, progress);
    expect(fetcher.mock.calls.map((call) => new URL(call[0]).origin)).toEqual(['https://huggingface.co', 'https://hf-mirror.com']);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({credentials: 'omit', referrerPolicy: 'no-referrer'});
    expect(fetcher.mock.calls[1]![0]).toContain('/resolve/pinned-revision/weights.bin');
    expect(await artifactComplete(file)).toBe(true);
    expect(await (await translationArtifactBlob(file)).text()).toBe('verified model');
    expect(progress).toHaveBeenCalledWith(body.length, true);
    await downloadTranslationArtifact(file, new AbortController().signal, progress);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps completed chunks on pause and resumes at their byte offset after a new caller attaches', async () => {
    const body = new Uint8Array(MODEL_CHUNK_SIZE + 17).fill(42);
    const file = fileFor(body);
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({start(stream) {
      stream.enqueue(body.subarray(0, MODEL_CHUNK_SIZE));
      controller.signal.addEventListener('abort', () => stream.error(new DOMException('Paused', 'AbortError')));
    }}))));
    await expect(downloadTranslationArtifact(file, controller.signal, (bytes) => {
      if (bytes >= MODEL_CHUNK_SIZE) controller.abort();
    })).rejects.toMatchObject({name: 'AbortError'});
    expect(await artifactDownloadedBytes(file)).toBe(MODEL_CHUNK_SIZE);
    expect(await artifactComplete(file)).toBe(false);
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _options?: RequestInit) => new Response(body.subarray(MODEL_CHUNK_SIZE), {
      status: 206, headers: {'Content-Range': `bytes ${MODEL_CHUNK_SIZE}-${body.length - 1}/${body.length}`},
    }));
    vi.stubGlobal('fetch', fetcher);
    await downloadTranslationArtifact(file, new AbortController().signal, () => undefined);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({headers: {Range: `bytes=${MODEL_CHUNK_SIZE}-`}});
    expect(await artifactComplete(file)).toBe(true);
    expect((await translationArtifactBlob(file)).size).toBe(body.length);
  });

  it('rejects corrupt model bytes and downloads a verified replacement from the next source', async () => {
    const body = new TextEncoder().encode('good');
    const file = fileFor(body);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('evil')).mockResolvedValueOnce(new Response(body)));
    await downloadTranslationArtifact(file, new AbortController().signal, () => undefined);
    expect(await (await translationArtifactBlob(file)).text()).toBe('good');
    expect(cache.delete).toHaveBeenCalledWith(expect.stringContaining('fluent-read-verified'));
  });

  it('rejects an invalid resume range without treating a partial file as ready', async () => {
    const body = new Uint8Array(MODEL_CHUNK_SIZE + 1).fill(1);
    const file = fileFor(body);
    entries.set(`${artifactUrl(file)}?fluent-read-part=0`, new Response(body.subarray(0, MODEL_CHUNK_SIZE), {headers: {'Content-Length': String(MODEL_CHUNK_SIZE)}}));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', {status: 206, headers: {'Content-Range': 'bytes 0-0/1'}})));
    await expect(downloadTranslationArtifact(file, new AbortController().signal, () => undefined)).rejects.toThrow('INTEGRITY');
    expect(await artifactComplete(file)).toBe(false);
  });

  it('does not retry a quota failure and removes only the requested artifact', async () => {
    const file = fileFor(new Uint8Array([1]));
    const other = fileFor(new Uint8Array([2, 3]));
    other.path = 'other.bin';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([2, 3]))));
    await downloadTranslationArtifact(other, new AbortController().signal, () => undefined);
    cache.put.mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'));
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1])));
    vi.stubGlobal('fetch', fetcher);
    await expect(downloadTranslationArtifact(file, new AbortController().signal, () => undefined)).rejects.toMatchObject({name: 'QuotaExceededError'});
    expect(fetcher).toHaveBeenCalledOnce();
    await removeTranslationArtifact(file);
    expect(await artifactComplete(other)).toBe(true);
  });

  it('pins the real lightweight and Hunyuan artifacts with content hashes', () => {
    const nonLegacy = LOCAL_TRANSLATION_MODELS.filter((model) => !model.legacy);
    expect(nonLegacy.map((model) => model.value)).toEqual([
      LOCAL_TRANSLATION_MODEL_IDS.opusZhEn,
      LOCAL_TRANSLATION_MODEL_IDS.hunyuan3,
      LOCAL_TRANSLATION_MODEL_IDS.opusJaEn,
      LOCAL_TRANSLATION_MODEL_IDS.opusFrEn,
      LOCAL_TRANSLATION_MODEL_IDS.opusDeEn,
      LOCAL_TRANSLATION_MODEL_IDS.opusEsEn,
      LOCAL_TRANSLATION_MODEL_IDS.opusRuEn,
      LOCAL_TRANSLATION_MODEL_IDS.hunyuan,
    ]);
    for (const model of nonLegacy) {
      const files = getTranslationArtifacts(model.value);
      expect(files.length).toBeGreaterThan(0);
      expect(files.every((file) => /^[a-f0-9]{40}$/u.test(file.revision) && /^[a-f0-9]{64}$/u.test(file.sha256) && file.size > 0)).toBe(true);
      const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
      expect(model.downloadSizeMb).toBe(Math.round(totalBytes / 1_000_000));
    }
    const light = getTranslationArtifacts(LOCAL_TRANSLATION_MODEL_IDS.opusZhEn);
    const hy = getTranslationArtifacts(LOCAL_TRANSLATION_MODEL_IDS.hunyuan);
    expect(light.reduce((sum, file) => sum + file.size, 0)).toBe(238991573);
    expect(hy[0]).toMatchObject({repo: 'tencent/Hy-MT2-1.8B-GGUF', path: 'Hy-MT2-1.8B-Q4_K_M.gguf', size: 1133080448});
  });

  it('cancels fulfilled sibling unread response bodies when a cache.match batch partially rejects', async () => {
    const file: TranslationArtifact = {repo: 'test/batch', revision: 'pinned', path: 'weights.bin', size: MODEL_CHUNK_SIZE * 3, sha256: '0'.repeat(64)};
    const url = artifactUrl(file);
    for (let index = 0; index < 3; index++) {
      entries.set(`${url}?fluent-read-part=${index}`, new Response('', {headers: {'Content-Length': String(MODEL_CHUNK_SIZE)}}));
    }
    const cancel = vi.fn(async () => undefined);
    const body = new ReadableStream<Uint8Array>({cancel});
    const matched = new Response(body, {headers: {'Content-Length': String(MODEL_CHUNK_SIZE)}});
    cache.match
      .mockResolvedValueOnce(matched)
      .mockRejectedValueOnce(new Error('first batch read failure'))
      .mockRejectedValueOnce(new Error('second batch read failure'));
    await expect(artifactDownloadedBytes(file)).rejects.toThrow('first batch read failure');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('counts downloaded bytes via keys first, batches validation across >16 chunks, and handles races or mismatches', async () => {
    const file: TranslationArtifact = {repo: 'test/large', revision: 'pinned', path: 'model.bin', size: MODEL_CHUNK_SIZE * 17 + 123, sha256: '0'.repeat(64)};
    expect(await artifactDownloadedBytes(file)).toBe(0);
    expect(cache.match).not.toHaveBeenCalled();

    const url = artifactUrl(file);
    for (let index = 0; index < 18; index++) {
      const size = index < 17 ? MODEL_CHUNK_SIZE : 123;
      entries.set(`${url}?fluent-read-part=${index}`, new Response('', {headers: {'Content-Length': String(size)}}));
    }
    expect(await artifactDownloadedBytes(file)).toBe(file.size);

    entries.set(`${url}?fluent-read-part=2`, new Response('', {headers: {'Content-Length': '99'}}));
    expect(await artifactDownloadedBytes(file)).toBe(MODEL_CHUNK_SIZE * 2);

    cache.match.mockResolvedValueOnce(undefined);
    expect(await artifactDownloadedBytes(file)).toBe(0);
  });

  it('reconstructs multi-chunk blobs in exact index order and verifies streaming downloads without re-reading parts', async () => {
    const bytes = new Uint8Array(MODEL_CHUNK_SIZE + 5);
    bytes.fill(1, 0, MODEL_CHUNK_SIZE);
    bytes.set([10, 20, 30, 40, 50], MODEL_CHUNK_SIZE);
    const file = fileFor(bytes);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)));
    cache.match.mockClear();
    await downloadTranslationArtifact(file, new AbortController().signal, () => undefined);
    expect(cache.match.mock.calls.some(([key]) => String(key).includes('fluent-read-part='))).toBe(false);
    const reconstructed = new Uint8Array(await (await translationArtifactBlob(file)).arrayBuffer());
    expect(reconstructed.length).toBe(bytes.length);
    expect(reconstructed[0]).toBe(1);
    expect(Array.from(reconstructed.subarray(MODEL_CHUNK_SIZE))).toEqual([10, 20, 30, 40, 50]);
  });

  it('fails disk verification if a chunk vanishes before reading during pre-downloaded verification', async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    const file = fileFor(bytes);
    entries.set(`${artifactUrl(file)}?fluent-read-part=0`, new Response(bytes, {headers: {'Content-Length': String(bytes.length)}}));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('should not fetch'); }));
    await expect(downloadTranslationArtifact(file, new AbortController().signal, (_bytes, verifying) => {
      if (verifying) entries.delete(`${artifactUrl(file)}?fluent-read-part=0`);
    })).rejects.toThrow();
    expect(await artifactComplete(file)).toBe(false);
  });

  it('orders ModelScope, custom HTTPS mirrors, and remembers working origins while demoting failed sources', async () => {
    const hunyuanFile: TranslationArtifact = {
      repo: 'tencent/Hy-MT3-1.8B-GGUF',
      revision: 'rev1',
      path: 'Hy-MT3-1.8B-Q4_K_M.gguf',
      size: 3,
      sha256: fileFor(new Uint8Array([1, 2, 3])).sha256,
    };
    expect(translationArtifactDownloadUrls(hunyuanFile, {preference: 'official'})).toEqual([
      'https://huggingface.co/tencent/Hy-MT3-1.8B-GGUF/resolve/rev1/Hy-MT3-1.8B-Q4_K_M.gguf',
      'https://hf-mirror.com/tencent/Hy-MT3-1.8B-GGUF/resolve/rev1/Hy-MT3-1.8B-Q4_K_M.gguf',
      'https://modelscope.cn/models/Tencent-Hunyuan/Hy-MT3-1.8B-GGUF/resolve/master/Hy-MT3-1.8B-Q4_K_M.gguf',
    ]);
    expect(translationArtifactDownloadUrls(hunyuanFile, {preference: 'mirror'})).toEqual([
      'https://hf-mirror.com/tencent/Hy-MT3-1.8B-GGUF/resolve/rev1/Hy-MT3-1.8B-Q4_K_M.gguf',
      'https://modelscope.cn/models/Tencent-Hunyuan/Hy-MT3-1.8B-GGUF/resolve/master/Hy-MT3-1.8B-Q4_K_M.gguf',
      'https://huggingface.co/tencent/Hy-MT3-1.8B-GGUF/resolve/rev1/Hy-MT3-1.8B-Q4_K_M.gguf',
    ]);
    expect(translationArtifactDownloadUrls(hunyuanFile, {
      preference: 'mirror',
      mirrorUrl: 'https://proxy.example.com/hf/',
    })[0]).toBe('https://proxy.example.com/hf/tencent/Hy-MT3-1.8B-GGUF/resolve/rev1/Hy-MT3-1.8B-Q4_K_M.gguf');
    expect(translationArtifactDownloadUrls(hunyuanFile, {
      preference: 'mirror',
      mirrorUrl: 'https://hf-mirror.com/',
    })).toHaveLength(3);

    const bytesA = new Uint8Array([1, 2, 3]);
    const fileA = fileFor(bytesA);
    const bytesB = new Uint8Array([4, 5, 6]);
    const fileB = {...fileFor(bytesB), path: 'weights-2.bin'};
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('<html>blocked</html>', {status: 200, headers: {'Content-Type': 'text/html'}}))
      .mockResolvedValueOnce(new Response(bytesA, {status: 200, headers: {'Content-Length': String(bytesA.length)}}))
      .mockResolvedValueOnce(new Response(bytesB, {status: 200, headers: {'Content-Length': String(bytesB.length)}}));
    vi.stubGlobal('fetch', fetcher);

    await downloadTranslationArtifact(fileA, new AbortController().signal, () => undefined);
    await downloadTranslationArtifact(fileB, new AbortController().signal, () => undefined);
    expect(fetcher.mock.calls.map(([input]) => new URL(String(input)).origin)).toEqual([
      'https://huggingface.co',
      'https://hf-mirror.com',
      'https://hf-mirror.com',
    ]);
  });

  it('rejects mismatched uncompressed Content-Length immediately before streaming and falls back', async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const file = fileFor(bytes);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([9]), {status: 200, headers: {'Content-Length': '999'}}))
      .mockResolvedValueOnce(new Response(bytes, {status: 200, headers: {'Content-Encoding': 'gzip', 'Content-Length': '999'}}));
    vi.stubGlobal('fetch', fetcher);
    await downloadTranslationArtifact(file, new AbortController().signal, () => undefined);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await artifactComplete(file)).toBe(true);
  });
});
