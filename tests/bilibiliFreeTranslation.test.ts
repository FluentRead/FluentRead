import {withProviderSnapshot} from './helpers/providerSnapshot';
/**
 * @file tests/bilibiliFreeTranslation.test.ts
 * 文件职责：验证 B站匿名 API 协议、字幕以外的纯文本边界和免费池所需错误契约。
 * 主要内容：覆盖语言、分块、槽与空白保留、取消、思考输出、截断、HTTP 限流和损坏响应；验证错误正文主动取消且取消确认不阻塞跨服务共享调度，成功正文仍持有并发许可直到读取完成。
 * 模块边界：使用共享 HTTP 端口注入响应，不连接真实服务，不读取用户配置。
 */
import {protectedDocumentLongMathParagraph} from './fixtures/documentLongMathParagraph';
import {afterEach, describe, expect, it, vi} from 'vitest';
import bilibili, {translateBilibiliFree, BILIBILI_FREE_TRANSLATION_URL} from '@/src/providers/translation/bilibili-free';
import {setRuntimeFetch} from '@/src/platform/http/runtime';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {services, servicesType, options} from '@/src/core/config/catalog';
import {getMissingCredentialMessage} from '@/src/core/config/validation';
import {attachTranslationProviderConfig, createTranslationProviderConfigSnapshot} from '@/src/services/translation/requestSnapshot';
import {parseTranslationSlots, serializeTranslationSlots} from '@/src/core/translation/slotProtocol';
import {createTranslationRequestScheduler} from '@/src/services/translation/requestScheduler';
import {translateMicrosoftTextsWithTransport} from '@/src/providers/translation/microsoftTransport';

vi.mock('@/src/services/config/store', () => ({config: {from: 'auto', to: 'zh-Hans'}}));

const request = (origin = 'Hello', extra = {}) => ({origin, sourceLanguage: 'en', targetLanguage: 'zh-Hans', ...extra});
const reply = (content: unknown = '你好', finish_reason = 'stop') => Response.json({choices: [{message: {content}, finish_reason}]});
afterEach(() => {setRuntimeFetch(); vi.restoreAllMocks();});

describe('B站官方免费翻译', () => {
    it('实际长数学段按2000码点分块时不拆开52个术语标记', async () => {
        const packet = protectedDocumentLongMathParagraph(), observed: string[] = [];
        setRuntimeFetch(vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
            const text = JSON.parse(String(init?.body)).messages[0].content.split('\n\n')[1];
            observed.push(text); return reply(text);
        }));
        const slots = serializeTranslationSlots([packet.text, 'tail'], 'protected-bili');
        expect(parseTranslationSlots(slots, await translateBilibiliFree(withProviderSnapshot(request(slots.payload), {from: 'auto', to: 'zh-Hans'})))).toEqual([packet.text, 'tail']);
        expect(observed.every(text => [...text].length <= 2000 && !text.includes('___FLUENTREAD'))).toBe(true);
        for (const token of packet.tokens) expect(observed.filter(text => text.includes(token))).toHaveLength(1);
    });

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
        expect(await bilibili(withProviderSnapshot(frozen, {from: 'auto', to: 'zh-Hans'}))).toEqual(['翻譯', '翻譯']);
        expect(JSON.parse(fetch.mock.calls[0][1].body).messages[0].content).toContain('繁體中文');
        await bilibili(withProviderSnapshot({...frozen, origin: 'Hello', targetLanguage: 'ja'}, {from: 'auto', to: 'zh-Hans'}));
        expect(JSON.parse(fetch.mock.calls[2][1].body).messages[0].content).toContain('日本語');
        await expect(bilibili(withProviderSnapshot({...frozen, origin: 42 as any}, {from: 'auto', to: 'zh-Hans'}))).rejects.toMatchObject({statusCode: 400});
        await expect(bilibili(withProviderSnapshot({...frozen, origin: [42] as any}, {from: 'auto', to: 'zh-Hans'}))).rejects.toMatchObject({statusCode: 400});
    });
    it('匿名直连固定官方模型，关闭思考，忽略用户凭据和服务覆盖', async () => {
        const fetch = vi.fn().mockResolvedValue(reply());
        setRuntimeFetch(fetch);
        expect(await translateBilibiliFree(withProviderSnapshot(request(' Hello ', {token: 'private', serviceOverride: 'other'}), {from: 'auto', to: 'zh-Hans'}))).toBe(' 你好 ');
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
        await translateBilibiliFree(withProviderSnapshot({origin: 'Hello'}, {from: 'auto', to: 'zh-Hans'}));
        expect(JSON.parse(fetch.mock.calls[0][1].body).messages[0].content).toContain('以下文本');
        await translateBilibiliFree(withProviderSnapshot(request('Hello', {sourceLanguage: 'auto', targetLanguage: 'zh-Hant'}), {from: 'auto', to: 'zh-Hans'}));
        expect(JSON.parse(fetch.mock.calls[1][1].body).messages[0].content).toContain('繁體中文');
        for (const extra of [{sourceLanguage: 'invalid'}, {targetLanguage: 'auto'}, {targetLanguage: 'invalid'}]) {
            await expect(translateBilibiliFree(withProviderSnapshot(request('Hello', extra), {from: 'auto', to: 'zh-Hans'}))).rejects.toMatchObject({statusCode: 400});
        }
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('纯空白和相同语种不联网，长行按 Unicode 码点有界分块并保留换行', async () => {
        const fetch = vi.fn().mockImplementation(async () => reply('译文'));
        setRuntimeFetch(fetch);
        expect(await translateBilibiliFree(withProviderSnapshot(request(' \r\n\t'), {from: 'auto', to: 'zh-Hans'}))).toBe(' \r\n\t');
        expect(await translateBilibiliFree(withProviderSnapshot(request('Hello', {targetLanguage: 'en'}), {from: 'auto', to: 'zh-Hans'}))).toBe('Hello');
        expect(fetch).not.toHaveBeenCalled();
        expect(await translateBilibiliFree(withProviderSnapshot(request(`  ${'😀'.repeat(2001)} \r\n\tWorld\n`), {from: 'auto', to: 'zh-Hans'}))).toBe('  译文译文 \r\n\t译文\n');
        expect(fetch).toHaveBeenCalledTimes(3);
        const texts = fetch.mock.calls.map(([, init]) => JSON.parse(init.body).messages[0].content.split('\n\n')[1]);
        expect(texts.map(text => Array.from(text).length)).toEqual([1998, 3, 5]);
    });

    it('预算内的多段帖子只请求一次，按原顺序恢复段落间距与边缘空白', async () => {
        const paragraphs = [
            'このページには複数の段落があります。',
            '翻訳したあとも、段落の順序と空白を保ちます。',
            '最後にもう一度、表示を確認します。',
        ];
        const source = ` ${paragraphs[0]}\r\n\r\n\t${paragraphs[1]}  \n \n${paragraphs[2]}\n`;
        const fetch = vi.fn().mockImplementation(async () => reply('本页包含多个段落。\n\n译后保留段落顺序和空白。\n最后再检查一次显示效果。'));
        setRuntimeFetch(fetch);

        await expect(translateBilibiliFree(request(source, {sourceLanguage: 'ja'})))
            .resolves.toBe(' 本页包含多个段落。\r\n\r\n\t译后保留段落顺序和空白。  \n \n最后再检查一次显示效果。\n');
        expect(fetch).toHaveBeenCalledOnce();
        const prompt = JSON.parse(fetch.mock.calls[0][1].body).messages[0].content;
        expect(prompt).toContain(source.trim());
    });

    it.each([
        {case: '行数不匹配', content: '合在一起的译文。', finish: 'stop'},
        {case: '截断', content: '未译完', finish: 'length'},
        {case: '空译文', content: ' \n ', finish: 'stop'},
    ])('整段响应为 $case 时回退逐行翻译并保留空行', async ({content, finish}) => {
        const fetch = vi.fn().mockResolvedValueOnce(reply(content, finish))
            .mockResolvedValueOnce(reply('第一段。')).mockResolvedValueOnce(reply('第二段。'));
        setRuntimeFetch(fetch);

        await expect(translateBilibiliFree(request('First paragraph.\n\nSecond paragraph.')))
            .resolves.toBe('第一段。\n\n第二段。');
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('整段请求遇到限流时保留原错误，不拆出更多请求', async () => {
        const fetch = vi.fn().mockResolvedValue(new Response('rate limited', {status: 429, headers: {'Retry-After': '12'}}));
        setRuntimeFetch(fetch);

        await expect(translateBilibiliFree(request('First paragraph.\nSecond paragraph.')))
            .rejects.toMatchObject({statusCode: 429, retryAfterMs: 12000});
        expect(fetch).toHaveBeenCalledOnce();
    });

    it('内部文本槽保留原命名空间，标记不发送给模型', async () => {
        const fetch = vi.fn().mockResolvedValueOnce(reply('一')).mockResolvedValueOnce(reply('二'));
        setRuntimeFetch(fetch);
        const packet = serializeTranslationSlots([' One ', '', 'Two'], 'test-nonce');
        const result = await translateBilibiliFree(withProviderSnapshot(request(packet.payload), {from: 'auto', to: 'zh-Hans'}));
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
        await expect(translateBilibiliFree(withProviderSnapshot(request(), {from: 'auto', to: 'zh-Hans'}))).rejects.toThrow('B站翻译');
    });

    it('只返回译文，完整思考块不进入展示', async () => {
        setRuntimeFetch(async () => reply('<think>private thought</think>\n你好'));
        expect(await translateBilibiliFree(withProviderSnapshot(request(), {from: 'auto', to: 'zh-Hans'}))).toBe('你好');
    });

    it('HTTP 状态和 Retry-After 供换线使用，外部正文与 JSON 解析预览不泄露', async () => {
        setRuntimeFetch(async () => new Response('private response', {status: 429, headers: {'Retry-After': '12'}}));
        await expect(translateBilibiliFree(withProviderSnapshot(request(), {from: 'auto', to: 'zh-Hans'}))).rejects.toMatchObject({statusCode: 429, retryAfterMs: 12000, message: 'B站翻译请求失败: 429'});
        setRuntimeFetch(async () => new Response('private broken JSON'));
        await expect(translateBilibiliFree(withProviderSnapshot(request(), {from: 'auto', to: 'zh-Hans'}))).rejects.toThrow('B站翻译返回的不是有效 JSON');
    });

    it('开始前、HTTP 后及解析后取消均拒绝结果，保留取消原因', async () => {
        const fetch = vi.fn(); setRuntimeFetch(fetch);
        const before = new AbortController(); const reason = new Error('cancelled'); before.abort(reason);
        await expect(translateBilibiliFree(withProviderSnapshot(request('Hello', {abortSignal: before.signal}), {from: 'auto', to: 'zh-Hans'}))).rejects.toBe(reason);
        expect(fetch).not.toHaveBeenCalled();
        const after = new AbortController();
        setRuntimeFetch(async (_, init) => {expect(init?.signal).toBe(after.signal); after.abort(reason); return reply();});
        await expect(translateBilibiliFree(withProviderSnapshot(request('Hello', {abortSignal: after.signal}), {from: 'auto', to: 'zh-Hans'}))).rejects.toBe(reason);
        const parsing = new AbortController();
        setRuntimeFetch(async () => ({ok: true, json: async () => {parsing.abort(); return {};}} as Response));
        await expect(translateBilibiliFree(withProviderSnapshot(request('Hello', {abortSignal: parsing.signal}), {from: 'auto', to: 'zh-Hans'}))).rejects.toMatchObject({name: 'AbortError'});
    });
    it.each(['http', 'abort'] as const)('B站 %s headers 后取消未读正文，不等待取消确认且保留错误分类', async mode => {
        const cancel = vi.fn(() => new Promise<void>(() => undefined));
        const response = new Response(new ReadableStream<Uint8Array>({cancel}),
            {status: mode === 'http' ? 504 : 200, headers: {'Retry-After': '12'}});
        const signal = new AbortController();
        const reason = new Error('cancelled after headers');
        setRuntimeFetch(async () => {if (mode === 'abort') signal.abort(reason); return response;});
        const error = await translateBilibiliFree(withProviderSnapshot(request('Hello', {abortSignal: signal.signal}), {from: 'auto', to: 'zh-Hans'})).catch(error => error);
        expect(cancel).toHaveBeenCalledOnce();
        if (mode === 'abort') expect(error).toBe(reason);
        else expect(error).toMatchObject({statusCode: 504, retryAfterMs: 12000});
    });

    it.each(['throw', 'reject'] as const)('B站 错误正文取消%s不覆盖原 HTTP 状态', async mode => {
        const response = new Response(new ReadableStream<Uint8Array>({}), {status: 503});
        vi.spyOn(response.body!, 'cancel').mockImplementation(() => {
            if (mode === 'throw') throw new Error('cancel failed');
            return Promise.reject(new Error('cancel failed'));
        });
        setRuntimeFetch(async () => response);
        await expect(translateBilibiliFree(withProviderSnapshot(request(), {from: 'auto', to: 'zh-Hans'})))
            .rejects.toMatchObject({statusCode: 503});
    });

    it('B站504的未结束正文和取消确认不挡住同一global调度器里的微软翻译', async () => {
        const scheduler = createTranslationRequestScheduler(() => ({
            maxConcurrentTranslations: 1, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0,
        }));
        const cancel = vi.fn(() => new Promise<void>(() => undefined));
        setRuntimeFetch(async () => new Response(new ReadableStream<Uint8Array>({cancel}), {status: 504, headers: {'Retry-After': '12'}}));
        const first = scheduler.schedule(lease => {
            const operation = translateBilibiliFree(withProviderSnapshot(request(), {from: 'auto', to: 'zh-Hans'}));
            lease.holdUntil(operation);
            return operation;
        }, {identity: {service: services.bilibili}}).catch(error => error);
        const microsoft = vi.fn(async () => Response.json([{translations: [{text: '微软译文'}]}]));
        const next = scheduler.schedule(lease => translateMicrosoftTextsWithTransport(
            microsoft, ['Next paragraph'], 'en', 'zh-Hans', undefined, true, lease,
        ), {identity: {service: services.microsoft}});
        await expect(first).resolves.toMatchObject({statusCode: 504, retryAfterMs: 12000});
        await expect(next).resolves.toEqual(['微软译文']);
        expect(cancel).toHaveBeenCalledOnce();
        expect(microsoft).toHaveBeenCalledOnce();
    });

    it('B站成功正文读取完成前仍持有global并发槽', async () => {
        const scheduler = createTranslationRequestScheduler(() => ({
            maxConcurrentTranslations: 1, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0,
        }));
        let body!: ReadableStreamDefaultController<Uint8Array>;
        const cancel = vi.fn();
        setRuntimeFetch(async () => new Response(new ReadableStream<Uint8Array>({start(controller) {body = controller;}, cancel})));
        const first = scheduler.schedule(lease => {
            const operation = translateBilibiliFree(withProviderSnapshot(request(), {from: 'auto', to: 'zh-Hans'}));
            lease.holdUntil(operation);
            return operation;
        }, {identity: {service: services.bilibili}});
        const nextTask = vi.fn(async () => 'next');
        const next = scheduler.schedule(nextTask, {identity: {service: services.microsoft}});
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(nextTask).not.toHaveBeenCalled();
        body.enqueue(new TextEncoder().encode(JSON.stringify({choices: [{message: {content: '你好'}, finish_reason: 'stop'}]})));
        body.close();
        await expect(first).resolves.toBe('你好');
        await expect(next).resolves.toBe('next');
        expect(cancel).not.toHaveBeenCalled();
    });

});
