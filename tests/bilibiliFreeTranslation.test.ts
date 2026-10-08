/**
 * @file tests/bilibiliFreeTranslation.test.ts
 * 文件职责：验证 B站匿名 API 协议、字幕以外的纯文本边界和免费池所需错误契约。
 * 主要内容：覆盖语言、分块、槽与空白保留、取消、思考输出、截断、HTTP 限流和损坏响应。
 * 模块边界：使用共享 HTTP 端口注入响应，不连接真实服务，不读取用户配置。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import bilibili, {translateBilibiliFree, BILIBILI_FREE_TRANSLATION_URL} from '@/src/providers/translation/bilibili-free';
import {setRuntimeFetch} from '@/src/platform/http/runtime';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {services, servicesType, options} from '@/src/core/config/catalog';
import {getMissingCredentialMessage} from '@/src/core/config/validation';
import {attachTranslationProviderConfig, createTranslationProviderConfigSnapshot} from '@/src/services/translation/requestSnapshot';
import {parseTranslationSlots, serializeTranslationSlots} from '@/src/core/translation/slotProtocol';

vi.mock('@/src/services/config/store', () => ({config: {from: 'auto', to: 'zh-Hans'}}));

const request = (origin = 'Hello', extra = {}) => ({origin, sourceLanguage: 'en', targetLanguage: 'zh-Hans', ...extra});
const reply = (content: unknown = '你好', finish_reason = 'stop') => Response.json({choices: [{message: {content}, finish_reason}]});
afterEach(() => {setRuntimeFetch(); vi.restoreAllMocks();});

describe('B站官方免费翻译', () => {
    it('独立服务归属机器翻译、无需密钥并可保存为默认服务', () => {
        expect(options.services.find(item => item.value === services.bilibili)?.label).toBe('B站翻译');
        expect(servicesType.isMachine(services.bilibili)).toBe(true);
        expect(servicesType.isAI(services.bilibili)).toBe(false);
        expect(normalizeConfig({...new Config(), service: services.bilibili}).service).toBe(services.bilibili);
        expect(getMissingCredentialMessage(services.bilibili, new Config())).toBeNull();
    });
    it('独立入口遵守冻结配置中的繁体目标与批量顺序，覆盖语言优先', async () => {
        const fetch = vi.fn().mockImplementation(async () => reply('翻譯'));
        setRuntimeFetch(fetch);
        const current = new Config(); current.from = 'en'; current.to = 'zh-Hant';
        const frozen = attachTranslationProviderConfig({origin: ['Hello', 'World']}, createTranslationProviderConfigSnapshot(current));
        expect(await bilibili(frozen)).toEqual(['翻譯', '翻譯']);
        expect(JSON.parse(fetch.mock.calls[0][1].body).messages[0].content).toContain('繁體中文');
        await bilibili({...frozen, origin: 'Hello', targetLanguage: 'ja'});
        expect(JSON.parse(fetch.mock.calls[2][1].body).messages[0].content).toContain('日本語');
        await expect(bilibili({...frozen, origin: 42 as any})).rejects.toMatchObject({statusCode: 400});
        await expect(bilibili({...frozen, origin: [42] as any})).rejects.toMatchObject({statusCode: 400});
    });
    it('匿名直连固定官方模型，关闭思考，忽略用户凭据和服务覆盖', async () => {
        const fetch = vi.fn().mockResolvedValue(reply());
        setRuntimeFetch(fetch);
        expect(await translateBilibiliFree(request(' Hello ', {token: 'private', serviceOverride: 'other'}))).toBe(' 你好 ');
        const [url, init] = fetch.mock.calls[0];
        expect(url).toBe(BILIBILI_FREE_TRANSLATION_URL);
        expect(init).toMatchObject({credentials: 'omit', headers: {'Content-Type': 'application/json'}});
        const body = JSON.parse(init.body);
        expect(body).toMatchObject({model: 'Index-Translate-35B-A3B', stream: false, chat_template_kwargs: {enable_thinking: false}});
        expect(JSON.stringify(init)).not.toContain('private');
        expect(body.messages[0].content).toContain('简体中文');
    });

    it('自动源语言与默认目标可用，繁体目标不会降为简体', async () => {
        const fetch = vi.fn().mockImplementation(async () => reply('翻譯'));
        setRuntimeFetch(fetch);
        await translateBilibiliFree({origin: 'Hello'});
        expect(JSON.parse(fetch.mock.calls[0][1].body).messages[0].content).toContain('以下文本');
        await translateBilibiliFree(request('Hello', {sourceLanguage: 'auto', targetLanguage: 'zh-Hant'}));
        expect(JSON.parse(fetch.mock.calls[1][1].body).messages[0].content).toContain('繁體中文');
        for (const extra of [{sourceLanguage: 'invalid'}, {targetLanguage: 'auto'}, {targetLanguage: 'invalid'}]) {
            await expect(translateBilibiliFree(request('Hello', extra))).rejects.toMatchObject({statusCode: 400});
        }
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('纯空白和相同语种不联网，长行按 Unicode 码点有界分块并保留换行', async () => {
        const fetch = vi.fn().mockImplementation(async () => reply('译文'));
        setRuntimeFetch(fetch);
        expect(await translateBilibiliFree(request(' \r\n\t'))).toBe(' \r\n\t');
        expect(await translateBilibiliFree(request('Hello', {targetLanguage: 'en'}))).toBe('Hello');
        expect(fetch).not.toHaveBeenCalled();
        expect(await translateBilibiliFree(request(`  ${'😀'.repeat(2001)} \r\n\tWorld\n`))).toBe('  译文译文 \r\n\t译文\n');
        expect(fetch).toHaveBeenCalledTimes(3);
        const texts = fetch.mock.calls.map(([, init]) => JSON.parse(init.body).messages[0].content.split('\n\n')[1]);
        expect(texts.map(text => Array.from(text).length)).toEqual([1998, 3, 5]);
    });

    it('内部文本槽保留原命名空间，标记不发送给模型', async () => {
        const fetch = vi.fn().mockResolvedValueOnce(reply('一')).mockResolvedValueOnce(reply('二'));
        setRuntimeFetch(fetch);
        const packet = serializeTranslationSlots([' One ', '', 'Two'], 'test-nonce');
        const result = await translateBilibiliFree(request(packet.payload));
        expect(parseTranslationSlots(packet, result)).toEqual([' 一 ', '', '二']);
        expect(JSON.stringify(fetch.mock.calls)).not.toContain('___FLUENTREAD_');
    });

    it.each([
        {choices: [{message: {content: 'partial'}, finish_reason: 'length'}]},
        {choices: [{message: {content: 42}}]}, {choices: []}, {choices: [{}]}, {}, null,
        {choices: [{message: {content: ''}}]},
        {choices: [{message: {content: '<think>private thought'}}]},
        {choices: [{message: {content: '</think>broken'}}]},
        {choices: [{message: {content: '<think>private thought</think>'}}]},
    ])('拒绝截断、空值和未闭合思考响应 %#', async body => {
        setRuntimeFetch(async () => Response.json(body));
        await expect(translateBilibiliFree(request())).rejects.toThrow('B站翻译');
    });

    it('只返回译文，完整思考块不进入展示', async () => {
        setRuntimeFetch(async () => reply('<think>private thought</think>\n你好'));
        expect(await translateBilibiliFree(request())).toBe('你好');
    });

    it('HTTP 状态和 Retry-After 供换线使用，外部正文与 JSON 解析预览不泄露', async () => {
        setRuntimeFetch(async () => new Response('private response', {status: 429, headers: {'Retry-After': '12'}}));
        await expect(translateBilibiliFree(request())).rejects.toMatchObject({statusCode: 429, retryAfterMs: 12000, message: 'B站翻译请求失败: 429'});
        setRuntimeFetch(async () => new Response('private broken JSON'));
        await expect(translateBilibiliFree(request())).rejects.toThrow('B站翻译返回的不是有效 JSON');
    });

    it('开始前、HTTP 后及解析后取消均拒绝结果，保留取消原因', async () => {
        const fetch = vi.fn(); setRuntimeFetch(fetch);
        const before = new AbortController(); const reason = new Error('cancelled'); before.abort(reason);
        await expect(translateBilibiliFree(request('Hello', {abortSignal: before.signal}))).rejects.toBe(reason);
        expect(fetch).not.toHaveBeenCalled();
        const after = new AbortController();
        setRuntimeFetch(async (_, init) => {expect(init?.signal).toBe(after.signal); after.abort(reason); return reply();});
        await expect(translateBilibiliFree(request('Hello', {abortSignal: after.signal}))).rejects.toBe(reason);
        const parsing = new AbortController();
        setRuntimeFetch(async () => ({ok: true, json: async () => {parsing.abort(); return {};}} as Response));
        await expect(translateBilibiliFree(request('Hello', {abortSignal: parsing.signal}))).rejects.toMatchObject({name: 'AbortError'});
    });
});
