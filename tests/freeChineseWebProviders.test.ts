/**
 * @file tests/freeChineseWebProviders.test.ts
 * 文件职责：验证有道网页和金山词霸匿名 adapter 的协议、方向、槽位格式、错误状态和取消行为。
 * 主要内容：使用可替换 runtime fetch 检查请求不带凭据，构造词霸 AES 响应，并覆盖边缘空白、换行、多槽和失败分支。
 * 模块边界：测试 provider 适配器，不把 mock 响应当作真实服务可用性或浏览器扩展端到端证据。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import AES from 'crypto-js/aes';
import encUtf8 from 'crypto-js/enc-utf8';
import modeECB from 'crypto-js/mode-ecb';
import padPkcs7 from 'crypto-js/pad-pkcs7';
import {translateFreeChineseWebText} from '@/src/providers/translation/free-chinese-web';
import {setRuntimeFetch} from '@/src/platform/http/runtime';
import {serializeTranslationSlots, parseTranslationSlots} from '@/src/core/translation/serialization';
import {detectChineseScript} from '@/src/core/language/detect';

const fetchMock = vi.fn<typeof fetch>();
const responseKey = 'aahc3TfyfCEmER33';
const encryptedIciba = (value: unknown) => AES.encrypt(JSON.stringify(value), encUtf8.parse(responseKey), {mode: modeECB, padding: padPkcs7}).toString();
const icibaResponse = (value: unknown = {err_no: 0, out: '译文'}) => Response.json({content: encryptedIciba(value)});
beforeEach(() => { fetchMock.mockReset(); setRuntimeFetch(fetchMock); });
afterEach(() => setRuntimeFetch());

describe('free Chinese web providers', () => {
    it('uses anonymous Youdao GET query data and reads fanyi.tran', async () => {
        fetchMock.mockResolvedValue(Response.json({fanyi: {tran: '译文'}}));
        await expect(translateFreeChineseWebText('youdaoFree', ' Hello ', 'en', 'zh-Hans')).resolves.toBe(' 译文 ');
        expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({credentials: 'omit', method: 'GET'});
        expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
        const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
        expect(url.searchParams.get('keyfrom')).toBe('webfanyi.webmain');
        expect(url.searchParams.get('from')).toBe('en');
        expect(url.searchParams.get('to')).toBe('zh-CHS');
    });

    it('keeps the end of long Youdao paragraphs when the upstream silently truncates oversized requests', async () => {
        // 真实匿名接口对 685 字符段落返回了在约 600 字符处截止的结果；此端口模拟该边界。
        fetchMock.mockImplementation(async input => Response.json({fanyi: {tran: new URL(String(input)).searchParams.get('q')!.slice(0, 598)}}));
        const source = `${'x'.repeat(600)} The final prediction depends only on earlier positions.`;
        await expect(translateFreeChineseWebText('youdaoFree', source, 'en', 'zh-Hans')).resolves.toBe(source);
        const queries = fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('q')!);
        expect(queries).toHaveLength(2);
        expect(queries.map(query => query.length)).toEqual([500, source.length - 500]);
        expect(queries.join('')).toBe(source);
    });

    it('respects the Youdao boundary without splitting non-BMP characters and keeps Iciba chunks at 1000 codepoints', async () => {
        fetchMock.mockImplementation(async input => Response.json({fanyi: {tran: new URL(String(input)).searchParams.get('q')!}}));
        const source = '😀'.repeat(501);
        await expect(translateFreeChineseWebText('youdaoFree', source, 'en', 'zh-Hans')).resolves.toBe(source);
        const queries = fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('q')!);
        expect(queries.map(query => Array.from(query).length)).toEqual([500, 1]);
        expect(queries.every(query => !/[\uD800-\uDBFF]$/u.test(query) && !/^[\uDC00-\uDFFF]/u.test(query))).toBe(true);

        fetchMock.mockClear();
        fetchMock.mockImplementation(async (_input, init) => icibaResponse({err_no: 0, out: new URLSearchParams(String(init?.body)).get('q')}));
        const icibaSource = '😀'.repeat(1001);
        await expect(translateFreeChineseWebText('icibaFree', icibaSource, 'en', 'zh-Hans', new AbortController().signal)).resolves.toBe(icibaSource);
        const icibaQueries = fetchMock.mock.calls.map(([_input, init]) => new URLSearchParams(String(init?.body)).get('q')!);
        expect(icibaQueries.map(query => Array.from(query).length)).toEqual([1000, 1]);
    });

    it('does not start a second Youdao request after cancellation at its safe chunk boundary', async () => {
        const controller = new AbortController();
        fetchMock.mockImplementationOnce(async input => {
            expect(new URL(String(input)).searchParams.get('q')).toHaveLength(500);
            controller.abort();
            return Response.json({fanyi: {tran: 'first'}});
        });
        await expect(translateFreeChineseWebText('youdaoFree', 'a'.repeat(501), 'en', 'zh-Hans', controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('prefers sentence endings and then whitespace within the safe bound without losing source characters', async () => {
        fetchMock.mockImplementation(async input => Response.json({fanyi: {tran: new URL(String(input)).searchParams.get('q')!}}));
        const sentence = `${'x'.repeat(480)}. `;
        const source = `${sentence}This masking keeps the final complete prediction. ${'z'.repeat(150)}`;
        await expect(translateFreeChineseWebText('youdaoFree', source, 'en', 'zh-Hans')).resolves.toBe(source);
        expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get('q')).toBe(sentence.trim());

        fetchMock.mockClear();
        const words = 'longword '.repeat(75);
        await expect(translateFreeChineseWebText('youdaoFree', words, 'en', 'zh-Hans')).resolves.toBe(words);
        expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get('q')).toBe('longword '.repeat(55).trim());

        fetchMock.mockClear();
        const chinese = `${'中'.repeat(480)}。${'文'.repeat(100)}`;
        await expect(translateFreeChineseWebText('youdaoFree', chinese, 'zh-Hans', 'en')).resolves.toBe(chinese);
        expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get('q')).toBe(`${'中'.repeat(480)}。`);
    });

    it('decrypts Iciba out and preserves multiple slots and line whitespace', async () => {
        const slots = serializeTranslationSlots([' Hello  ', '第二行'], 'iciba-test');
        fetchMock.mockImplementation(async () => icibaResponse());
        const output = await translateFreeChineseWebText('icibaFree', `${slots.payload}\r\n`, 'en', 'zh-Hans');
        expect(parseTranslationSlots(slots, output.trim())).toEqual([' 译文  ', '译文']);
    });

    it('rejects unsupported or implicit traditional directions before network', async () => {
        expect(detectChineseScript('這是一個完整的繁體中文測試句子。')).toBe('Hant');
        await expect(translateFreeChineseWebText('youdaoFree', 'Hello', 'en', 'zh-Hant')).rejects.toMatchObject({statusCode: 400, freeFailure: 'request'});
        await expect(translateFreeChineseWebText('icibaFree', '這是一個完整的繁體中文測試句子。', 'auto', 'zh-Hans')).rejects.toMatchObject({statusCode: 400});
        await expect(translateFreeChineseWebText('icibaFree', 'Hello', 'en', 'en')).rejects.toMatchObject({statusCode: 400});
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('resolves auto direction from local Chinese script evidence', async () => {
        fetchMock.mockResolvedValue(Response.json({fanyi: {tran: 'English'}}));
        await translateFreeChineseWebText('youdaoFree', '这是一个完整的中文测试句子。', 'auto', 'auto');
        const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
        expect(url.searchParams.get('from')).toBe('zh-CHS');
        expect(url.searchParams.get('to')).toBe('en');
        fetchMock.mockResolvedValueOnce(Response.json({fanyi: {tran: '中文'}}));
        await translateFreeChineseWebText('youdaoFree', 'Hello from auto detection', 'auto', 'zh-Hans');
        const fallbackUrl = new URL(String(fetchMock.mock.calls.at(-1)?.[0]));
        expect(fallbackUrl.searchParams.get('from')).toBe('en');
        await expect(translateFreeChineseWebText('youdaoFree', 'Plain auto text', 'auto', 'en')).rejects.toMatchObject({statusCode: 400});
    });

    it('propagates abort and classifies HTTP rate limits', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(translateFreeChineseWebText('youdaoFree', 'Hello', 'en', 'zh-Hans', controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        fetchMock.mockResolvedValue(new Response('', {status: 429}));
        await expect(translateFreeChineseWebText('youdaoFree', 'Hello', 'en', 'zh-Hans')).rejects.toMatchObject({statusCode: 429, freeFailure: 'rate-limit'});
    });

    it('classifies every HTTP status family without exposing response text', async () => {
        for (const [status, freeFailure] of [[401, 'blocked'], [403, 'blocked'], [404, 'blocked'], [410, 'blocked'], [408, 'unavailable'], [429, 'rate-limit'], [402, 'quota'], [456, 'quota'], [500, 'unavailable'], [400, 'request']] as const) {
            fetchMock.mockResolvedValueOnce(new Response('private response body', {status}));
            await expect(translateFreeChineseWebText('youdaoFree', 'Hello', 'en', 'zh-Hans')).rejects.toMatchObject({statusCode: status, freeFailure});
        }
    });

    it('classifies transport and malformed responses as unavailable', async () => {
        fetchMock.mockRejectedValueOnce(new Error('network detail')); 
        await expect(translateFreeChineseWebText('youdaoFree', 'Hello', 'en', 'zh-Hans')).rejects.toMatchObject({freeFailure: 'unavailable'});
        fetchMock.mockResolvedValueOnce(new Response('{broken', {headers: {'Content-Type': 'application/json'}}));
        await expect(translateFreeChineseWebText('youdaoFree', 'Hello', 'en', 'zh-Hans')).rejects.toThrow('有道返回的不是有效 JSON');
        fetchMock.mockResolvedValueOnce(Response.json({fanyi: {tran: '   '}}));
        await expect(translateFreeChineseWebText('youdaoFree', 'Hello', 'en', 'zh-Hans')).rejects.toMatchObject({freeFailure: 'unavailable'});
        fetchMock.mockResolvedValueOnce(Response.json({content: 'bad cipher'}));
        await expect(translateFreeChineseWebText('icibaFree', 'Hello', 'en', 'zh-Hans')).rejects.toMatchObject({freeFailure: 'unavailable'});
        fetchMock.mockResolvedValueOnce(Response.json({content: ''}));
        await expect(translateFreeChineseWebText('icibaFree', 'Hello', 'en', 'zh-Hans')).rejects.toMatchObject({freeFailure: 'unavailable'});
        fetchMock.mockResolvedValueOnce(Response.json({content: encryptedIciba([])}));
        await expect(translateFreeChineseWebText('icibaFree', 'Hello', 'en', 'zh-Hans')).rejects.toMatchObject({freeFailure: 'unavailable'});
        fetchMock.mockResolvedValueOnce(Response.json({content: encryptedIciba({err_no: 0, out: ''})}));
        await expect(translateFreeChineseWebText('icibaFree', 'Hello', 'en', 'zh-Hans')).rejects.toMatchObject({freeFailure: 'unavailable'});
    });

    it('classifies Iciba business statuses and sends no credential headers', async () => {
        for (const [errNo, freeFailure] of [[429, 'rate-limit'], [403, 'blocked'], [402, 'quota'], [7, 'request']] as const) {
            fetchMock.mockResolvedValueOnce(icibaResponse({err_no: errNo, out: ''}));
            await expect(translateFreeChineseWebText('icibaFree', 'Hello', 'en', 'zh-Hans')).rejects.toMatchObject({statusCode: errNo, freeFailure});
        }
        fetchMock.mockResolvedValueOnce(icibaResponse({err_no: 'unknown', out: ''}));
        await expect(translateFreeChineseWebText('icibaFree', 'Hello', 'en', 'zh-Hans')).rejects.toMatchObject({freeFailure: 'request'});
        fetchMock.mockResolvedValueOnce(icibaResponse());
        await translateFreeChineseWebText('icibaFree', '中文测试句子', 'zh-Hans', 'en');
        fetchMock.mockResolvedValueOnce(icibaResponse());
        await translateFreeChineseWebText('icibaFree', 'Hello', 'en', 'zh-Hans');
        const [, init] = fetchMock.mock.calls.at(-1)!;
        expect(init?.credentials).toBe('omit');
        expect(init?.headers).toEqual({'Content-Type': 'application/x-www-form-urlencoded'});
    });

    it('handles non-string and blank input without a request', async () => {
        await expect(translateFreeChineseWebText('youdaoFree', 42 as unknown as string, 'en', 'zh-Hans')).rejects.toMatchObject({statusCode: 400, freeFailure: 'request'});
        await expect(translateFreeChineseWebText('youdaoFree', ' \r\n\t ', 'en', 'zh-Hans')).resolves.toBe(' \r\n\t ');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('preserves cancellation during transport and between long chunks', async () => {
        const rejectedController = new AbortController();
        fetchMock.mockImplementationOnce(async () => {
            rejectedController.abort();
            throw new Error('cancelled transport');
        });
        await expect(translateFreeChineseWebText('youdaoFree', 'Hello', 'en', 'zh-Hans', rejectedController.signal)).rejects.toMatchObject({name: 'AbortError'});

        const chunkController = new AbortController();
        fetchMock.mockImplementationOnce(async () => {
            chunkController.abort();
            return Response.json({fanyi: {tran: '译文'}});
        });
        await expect(translateFreeChineseWebText('youdaoFree', '😀'.repeat(1001), 'en', 'zh-Hans', chunkController.signal)).rejects.toMatchObject({name: 'AbortError'});
    });

    it('preserves empty lines, empty slots, edge whitespace and non-BMP chunks', async () => {
        fetchMock.mockImplementation(async () => Response.json({fanyi: {tran: '译文'}}));
        const source = `  ${'😀'.repeat(1101)}  `;
        const packet = serializeTranslationSlots(['', source, '\n\t'], 'format-test');
        const output = await translateFreeChineseWebText('youdaoFree', packet.payload, 'en', 'zh-Hans');
        expect(parseTranslationSlots(packet, output)).toEqual(['', `  ${'译文'.repeat(3)}  `, '\n\t']);
        expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
        for (const [, init] of fetchMock.mock.calls) expect(init?.credentials).toBe('omit');
    });

    it('serializes slots so a pending slot does not start the next slot', async () => {
        let resolveFirst!: (value: Response) => void;
        fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveFirst = resolve; }));
        const packet = serializeTranslationSlots(['first', 'second'], 'ordered-slots');
        const request = translateFreeChineseWebText('youdaoFree', packet.payload, 'en', 'zh-Hans');
        await Promise.resolve();
        expect(fetchMock).toHaveBeenCalledOnce();
        resolveFirst(Response.json({fanyi: {tran: 'one'}}));
        fetchMock.mockResolvedValueOnce(Response.json({fanyi: {tran: 'two'}}));
        await expect(request).resolves.toContain('two');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not start later slots or chunks after cancellation', async () => {
        const controller = new AbortController();
        fetchMock.mockImplementationOnce(async () => { controller.abort(); return Response.json({fanyi: {tran: 'one'}}); });
        const packet = serializeTranslationSlots(['first', 'second'], 'cancel-slots');
        await expect(translateFreeChineseWebText('youdaoFree', packet.payload, 'en', 'zh-Hans', controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('checks cancellation after JSON parsing before starting the next chunk', async () => {
        const controller = new AbortController();
        const response = Response.json({fanyi: {tran: '第一段'}});
        response.json = async () => {
            controller.abort();
            return {fanyi: {tran: '第一段'}};
        };
        fetchMock.mockResolvedValueOnce(response);
        await expect(translateFreeChineseWebText('youdaoFree', 'a'.repeat(1001), 'en', 'zh-Hans', controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('does not decrypt or request the remaining Iciba chunks when response parsing is cancelled', async () => {
        const controller = new AbortController();
        const response = icibaResponse();
        response.json = async () => {
            controller.abort();
            return {content: encryptedIciba({err_no: 0, out: 'first'})};
        };
        fetchMock.mockResolvedValueOnce(response);
        await expect(translateFreeChineseWebText('icibaFree', 'a'.repeat(1001), 'en', 'zh-Hans', controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('stops at the next chunk if the caller cancels as the first parsed response settles', async () => {
        const controller = new AbortController();
        const response = Response.json({fanyi: {tran: 'first'}});
        response.json = async () => {
            queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => controller.abort())));
            return {fanyi: {tran: 'first'}};
        };
        fetchMock.mockResolvedValueOnce(response);
        await expect(translateFreeChineseWebText('youdaoFree', 'a'.repeat(501), 'en', 'zh-Hans', controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(fetchMock).toHaveBeenCalledOnce();
    });
});
