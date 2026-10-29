// Focused native-ASR transport contracts; not real service or device acceptance.
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {normalizeNativeAsrBaseUrl} from '../src/core/config/nativeAsr';
import {transcribeNativeQwenPcm16} from '../src/features/video-subtitle/background/nativeTranscription';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllTimers(); vi.useRealTimers(); });

describe('native ASR loopback boundary', () => {
    it.each([
        ['http://127.0.0.1:8000', 'http://127.0.0.1:8000'],
        ['http://127.0.0.1:8000/v1/', 'http://127.0.0.1:8000'],
        ['https://[::1]:8443/v1', 'https://[::1]:8443'],
    ])('canonicalizes %s', (input, expected) => {
        expect(normalizeNativeAsrBaseUrl(input)).toBe(expected);
    });
    it.each([
        undefined, null, '', 123, 'not-a-url', 'http://:secret@127.0.0.1', 'http://example.com', 'http://localhost:8000',
        'http://user@127.0.0.1:8000', 'http://user:secret@127.0.0.1',
        'http://127.0.0.1/?auth=secret', 'http://127.0.0.1/#secret',
        'http://127.0.0.1/private', 'ftp://127.0.0.1',
        'http://127.0.0.1\t:8000', 'x'.repeat(513),
    ])('leaves invalid explicit input disabled: %s', (input) => {
        expect(normalizeNativeAsrBaseUrl(input)).toBe('');
    });
});

const options = () => ({baseUrl: 'http://127.0.0.1:8000', signal: new AbortController().signal});
const pcm = 'AAA='; // One PCM16 sample, not real audio acceptance evidence.

describe('native ASR failure cleanup and transmission', () => {
    it('preserves HTTP error without awaiting a stalled cancellation handshake', async () => {
        const cancel = vi.fn(() => new Promise<void>(() => {}));
        const body = new ReadableStream<Uint8Array>({cancel});
        vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body, {status: 503})));
        await expect(transcribeNativeQwenPcm16(pcm, options())).rejects.toThrow('HTTP 503');
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('preserves the size-limit error and releases the reader despite stalled cancel', async () => {
        const cancel = vi.fn(() => new Promise<void>(() => {}));
        const body = new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new Uint8Array(128 * 1024 + 1)); }, cancel,
        });
        vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body)));
        await expect(transcribeNativeQwenPcm16(pcm, options())).rejects.toThrow('响应超过大小限制');
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(body.locked).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('returns text without inventing timestamps or device evidence', async () => {
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({text: 'hello'})));
        vi.stubGlobal('fetch', fetch);
        const result = await transcribeNativeQwenPcm16(pcm, options());
        expect(result).toEqual({text: 'hello', model: 'Qwen/Qwen3-ASR-1.7B', audioDurationMs: 0.0625});
        expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:8000/v1/audio/transcriptions', expect.objectContaining({
            method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
        }));
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects pre-aborted work before fetch', async () => {
        const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
        const controller = new AbortController(); controller.abort();
        await expect(transcribeNativeQwenPcm16(pcm, {...options(), signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each(['', 'AA==', 'A===', 'AA A'])('rejects malformed or non-PCM16 base64 %s before fetch', async (encoded) => {
        const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
        await expect(transcribeNativeQwenPcm16(encoded, options())).rejects.toThrow();
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('native ASR remaining transport boundaries', () => {
    it.each(['https://example.com', ''])('rejects invalid transport endpoint %s before fetch', async baseUrl => {
        const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
        await expect(transcribeNativeQwenPcm16(pcm, {...options(), baseUrl})).rejects.toThrow('本机回环地址');
        expect(fetch).not.toHaveBeenCalled();
    });
    it.each(['eng', 'EN', 'zh-CN'])('rejects unsupported language %s before fetch', async sourceLanguage => {
        const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
        await expect(transcribeNativeQwenPcm16(pcm, {...options(), sourceLanguage})).rejects.toThrow('ISO 639-1');
        expect(fetch).not.toHaveBeenCalled();
    });
    it.each([undefined, '', 'auto', ' en '])('encodes WAV and only sends explicit language %s', async sourceLanguage => {
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{"text":"ok"}'));
        vi.stubGlobal('fetch', fetch);
        await transcribeNativeQwenPcm16(pcm, {...options(), sourceLanguage});
        const form = fetch.mock.calls[0][1]!.body as FormData;
        expect(form.get('language')).toBe(sourceLanguage === ' en ' ? 'en' : null);
        expect(form.get('model')).toBe('Qwen/Qwen3-ASR-1.7B');
        expect(form.get('response_format')).toBe('json');
        expect(form.get('stream')).toBe('false');
        const file = form.get('file') as File;
        expect(file.type).toBe('audio/wav');
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer), view = new DataView(buffer);
        expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('RIFF');
        expect(new TextDecoder().decode(bytes.subarray(8, 16))).toBe('WAVEfmt ');
        expect(view.getUint32(24, true)).toBe(16000);
        expect(view.getUint16(22, true)).toBe(1);
        expect(view.getUint16(34, true)).toBe(16);
        expect(view.getUint32(40, true)).toBe(2);
        expect([...bytes.subarray(44)]).toEqual([0, 0]);
    });
    it.each(['A', 'AAB=', 'A'.repeat(1280004)])('rejects noncanonical or oversized PCM (%#)', async encoded => {
        const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
        await expect(transcribeNativeQwenPcm16(encoded, options())).rejects.toThrow();
        expect(fetch).not.toHaveBeenCalled();
    });
    it('accepts the exact thirty-second PCM limit', async () => {
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{"text":"bounded"}'));
        vi.stubGlobal('fetch', fetch);
        const result = await transcribeNativeQwenPcm16('A'.repeat(1280000), options());
        expect(result.audioDurationMs).toBe(30000);
        const form = fetch.mock.calls[0][1]!.body as FormData;
        expect((form.get('file') as File).size).toBe(960044);
    });
    it('rejects absent response body', async () => {
        vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null)));
        await expect(transcribeNativeQwenPcm16(pcm, options())).rejects.toThrow('响应为空');
        expect(vi.getTimerCount()).toBe(0);
    });
    it.each(['null', '1', '{}', '{"text":2}', '"string"', 'not-json'])('rejects invalid response %s', async body => {
        vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body)));
        await expect(transcribeNativeQwenPcm16(pcm, options())).rejects.toThrow();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('rejects invalid streaming UTF-8 and releases the body lock', async () => {
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({start(c) {c.enqueue(new Uint8Array([255]));}, cancel});
        vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body)));
        await expect(transcribeNativeQwenPcm16(pcm, options())).rejects.toThrow();
        expect(cancel).toHaveBeenCalledOnce();
        expect(body.locked).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('rejects incomplete UTF-8 at end of stream', async () => {
        const body = new ReadableStream<Uint8Array>({start(c) {c.enqueue(new Uint8Array([0xe4])); c.close();}});
        vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body)));
        await expect(transcribeNativeQwenPcm16(pcm, options())).rejects.toThrow();
        expect(body.locked).toBe(false);
    });
    it('preserves ordinary transport errors and clears its timer', async () => {
        const error = new Error('controlled network failure');
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
        await expect(transcribeNativeQwenPcm16(pcm, options())).rejects.toBe(error);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('reports the deadline when cooperative fetch aborts', async () => {
        vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason), {once: true});
        })));
        const pending = expect(transcribeNativeQwenPcm16(pcm, options())).rejects.toThrow('原生转写超时');
        await vi.advanceTimersByTimeAsync(90000);
        await pending;
        expect(vi.getTimerCount()).toBe(0);
    });
    it('propagates caller cancellation during fetch', async () => {
        const controller = new AbortController();
        vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason), {once: true});
        })));
        const pending = expect(transcribeNativeQwenPcm16(pcm, {...options(), signal: controller.signal})).rejects.toThrow('caller stopped');
        controller.abort(new Error('caller stopped'));
        await pending;
        expect(vi.getTimerCount()).toBe(0);
    });
    it('does not deliver a parsed result after caller cancellation', async () => {
        const controller = new AbortController();
        const body = new ReadableStream<Uint8Array>({
            start(c) {c.enqueue(new TextEncoder().encode('{"text":"late"}'));},
            pull(c) {controller.abort(new Error('late cancellation')); c.close();},
        });
        vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body)));
        await expect(transcribeNativeQwenPcm16(pcm, {...options(), signal: controller.signal})).rejects.toThrow('late cancellation');
        expect(vi.getTimerCount()).toBe(0);
    });
});
