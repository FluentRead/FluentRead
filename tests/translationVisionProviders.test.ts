/**
 * @file tests/translationVisionProviders.test.ts
 *
 * 文件职责：用 mock runtime transport 验证各视觉 provider 的真实序列化请求。
 * 主要内容：覆盖 OpenAI-compatible SDK、DeepSeek Chat/Responses、Gemini、Claude、通义和智谱，并确认自定义 body 无法替换视觉模型、提示词与图片，服务配置快照和取消信号保持一致。
 * 模块边界：测试只截获本地 runtimeFetch，不访问真实供应商网络，也不验证 UI 或 OCR。
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {Config} from '@/src/core/config/model';
import {setRuntimeFetch} from '@/src/platform/http/runtime';
import {attachTranslationImageInput, attachTranslationProviderConfig, createTranslationProviderConfigSnapshot} from '@/src/services/translation/requestSnapshot';
import {translateWithOpenAICompatibleAiSdk} from '@/src/providers/translation/ai-sdk/openai-compatible';
import gemini from '@/src/providers/translation/gemini';
import claude from '@/src/providers/translation/claude';
import tongyi from '@/src/providers/translation/tongyi';
import zhipu from '@/src/providers/translation/zhipu';
import deepseek from '@/src/providers/translation/deepseek';
import doubaoSeedTranslation from '@/src/providers/translation/doubao-seed-translation';
import {withProviderSnapshot} from './helpers/providerSnapshot';

const image = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const response = (body: unknown) => new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}});

function request(config: Config, service: string, model: string) {
    const message: any = {origin: '读取图片', serviceOverride: service, modelOverride: model, targetLanguage: 'zh-Hans', requestTimeoutMs: 5000};
    attachTranslationImageInput(message, image);
    attachTranslationProviderConfig(message, createTranslationProviderConfigSnapshot(config as any));
    return {message, config};
}

describe('translation vision provider payloads', () => {
    afterEach(() => setRuntimeFetch());

    it.each([
        ['deepseek-chat', deepseek], ['deepseek-responses', deepseek], ['tongyi', tongyi],
        ['zhipu', zhipu], ['doubao', doubaoSeedTranslation],
    ] as const)('%s propagates abort during successful response JSON reading', async (name, adapter) => {
        const service = name.startsWith('deepseek') ? 'deepseek' : name;
        const config = new Config();
        config.service = service;
        config.model.doubao = 'doubao-seed-translation';
        config.token[service] = service === 'zhipu' ? 'id.secret' : 'synthetic-key';
        config.deepseekApiType = name === 'deepseek-responses' ? 'responses' : 'chat';
        const owner = new AbortController();
        let notifyRead!: () => void;
        const readStarted = new Promise<void>(resolve => {notifyRead = resolve;});
        setRuntimeFetch(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
            start(output) {init!.signal!.addEventListener('abort', () => output.error(new DOMException('aborted', 'AbortError')), {once: true});},
            pull() {notifyRead();},
        }, {highWaterMark: 0})));
        const pending = adapter(withProviderSnapshot({origin: 'hello', serviceOverride: service, abortSignal: owner.signal}, config)).catch(error => error);
        await readStarted;
        owner.abort();
        await expect(pending).resolves.toMatchObject({name: 'AbortError'});
    });

    it.each([
        ['deepseek-chat', deepseek], ['deepseek-responses', deepseek], ['tongyi', tongyi],
        ['zhipu', zhipu], ['doubao', doubaoSeedTranslation], ['gemini', gemini], ['claude', claude],
    ] as const)('%s keeps malformed JSON and credentials out of error text without cancellation', async (name, adapter) => {
        const service = name.startsWith('deepseek') ? 'deepseek' : name;
        const config = new Config(); config.service = service;
        config.model.doubao = 'doubao-seed-translation';
        config.token[service] = service === 'zhipu' ? 'private-id.private-secret' : 'private-secret';
        config.deepseekApiType = name === 'deepseek-responses' ? 'responses' : 'chat';
        setRuntimeFetch(async () => new Response('{private-secret'));
        const error = await adapter(withProviderSnapshot({origin: 'private-original', serviceOverride: service}, config)).catch(cause => cause);
        expect(error.message).toContain('不是有效 JSON');
        expect(error.message).not.toMatch(/private-secret|private-original/u);
    });

    it.each(['deepseek-chat', 'deepseek-responses', 'sdk', 'gemini', 'claude', 'tongyi', 'zhipu'])('preserves explicit image rejection through %s transport', async kind => {
        const config = new Config();
        const service = kind === 'sdk' ? 'openai' : kind.startsWith('deepseek') ? 'deepseek' : kind;
        config.token[service] = service === 'zhipu' ? 'id.secret' : 'synthetic-key';
        config.deepseekApiType = kind === 'deepseek-responses' ? 'responses' : 'chat';
        const adapter = kind === 'sdk' ? translateWithOpenAICompatibleAiSdk
            : service === 'deepseek' ? deepseek : service === 'gemini' ? gemini : service === 'claude' ? claude : service === 'tongyi' ? tongyi : zhipu;
        const rejectedResponse = new Response(JSON.stringify({error:{message:'This model does not support image input'}}), {status:400});
        setRuntimeFetch(async () => rejectedResponse);
        await expect(adapter(request(config, service, 'test-vision-model').message)).rejects.toMatchObject({statusCode:400,imageInputUnsupported:true});
        expect(rejectedResponse.bodyUsed).toBe(true);
        setRuntimeFetch(async () => new Response(JSON.stringify({error:{message:'unsupported image format'}}), {status:400}));
        try { await adapter(request(config, service, 'test-vision-model').message); throw new Error('expected failure'); }
        catch(error) { expect((error as {imageInputUnsupported?: boolean}).imageInputUnsupported).toBeUndefined(); }
    });

    it.each([
        ['gemini', gemini], ['claude', claude], ['tongyi', tongyi], ['zhipu', zhipu], ['deepseek', deepseek],
    ] as const)('%s cancels an unread rate-limit response without waiting for cancellation', async (service, adapter) => {
        const config = new Config();
        config.token[service] = service === 'zhipu' ? 'id.secret' : 'synthetic-key';
        const cancel = vi.fn(() => new Promise<void>(() => {}));
        const failedResponse = new Response(new ReadableStream({cancel}), {status: 429, headers: {'Retry-After': '2'}});
        setRuntimeFetch(async () => failedResponse);
        const message = withProviderSnapshot({origin: 'Translate a paragraph', serviceOverride: service}, config);
        await expect(adapter(message)).rejects.toMatchObject({statusCode: 429, retryAfterMs: 2000});
        expect(cancel).toHaveBeenCalledOnce();
    });

    it.each([
        ['gemini', gemini, {}], ['claude', claude, {}],
        ['deepseek-chat', deepseek, {choices: [{message: {content: '   '}}]}],
        ['deepseek-responses', deepseek, {output: [{type: 'reasoning', summary: []}]}],
    ] as const)('%s rejects missing final text instead of rendering an empty or reasoning-only success', async (name, adapter, payload) => {
        const config = new Config();config.service = name.startsWith('deepseek') ? 'deepseek' : name;
        config.token[config.service] = 'synthetic-key';config.deepseekApiType = name === 'deepseek-responses' ? 'responses' : 'chat';
        setRuntimeFetch(async () => response(payload));
        await expect(adapter(withProviderSnapshot({origin: 'Read this paragraph'}, config))).rejects.toThrow(/缺少/u);
    });

    it.each(['chat', 'responses'] as const)('sends DeepSeek %s images with frozen prompts, model and thinking', async apiType => {
        const config = new Config();
        config.service = 'deepseek';
        config.deepseekApiType = apiType;
        config.proxy.deepseek = 'https://deepseek.test/v1/chat/completions';
        config.token.deepseek = 'test-secret';
        config.model.deepseek = 'deepseek-flash';
        config.modelThinking = {deepseek: {'deepseek-flash': true}};
        config.system_role.deepseek = 'Transcribe only.';
        config.user_role.deepseek = 'Read only visible words: {{origin}}';
        config.customBody.deepseek = '{"model":"attacker","messages":[],"input":"wrong","instructions":"wrong","thinking":{"type":"disabled"},"reasoning":{"effort":"none"}}';
        const controller = new AbortController();
        const {message} = request(config, 'deepseek', 'deepseek-flash');
        message.abortSignal = controller.signal;
        config.token.deepseek = 'changed-secret';
        config.model.deepseek = 'changed-model';
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            expect(input).toBe(`https://deepseek.test/v1/${apiType === 'chat' ? 'chat/completions' : 'responses'}`);
            expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-secret');
            expect(init?.signal).toBe(controller.signal);
            const body = JSON.parse(String(init?.body));
            expect(body.model).toBe('deepseek-flash');
            const user = 'Read only visible words: 读取图片';
            if (apiType === 'chat') {
                expect(body.messages).toEqual([
                    {role: 'system', content: 'Transcribe only.'},
                    {role: 'user', content: [{type: 'text', text: user}, {type: 'image_url', image_url: {url: image}}]},
                ]);
                expect(body.thinking).toEqual({type: 'enabled'});
                return response({choices: [{message: {content: 'Visible text', reasoning_content: 'private reasoning'}}]});
            }
            expect(body.instructions).toBe('Transcribe only.');
            expect(body.input).toEqual([{role: 'user', content: [
                {type: 'input_text', text: user}, {type: 'input_image', image_url: image},
            ]}]);
            expect(body.reasoning).toEqual({effort: 'high'});
            return response({output: [{type: 'message', content: [{type: 'output_text', text: 'Visible text'}]}]});
        });
        setRuntimeFetch(fetchMock);
        await expect(deepseek(message)).resolves.toBe('Visible text');
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('sends OpenAI-compatible vision content and ignores customBody', async () => {
        const config = new Config();
        config.customOpenAIProviders = [{id: 'custom:vision', name: 'Vision', endpoint: 'https://vision.test/v1/chat/completions', models: ['vision-model']}];
        config.token['custom:vision'] = 'secret';
        config.customBody['custom:vision'] = '{"model":"attacker","messages":[]}';
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            expect(body.model).toBe('vision-model');
            expect(body.messages[1].content[1].image_url.url).toBe(image);
            return response({choices: [{message: {content: 'ok'}}]});
        });
        setRuntimeFetch(fetchMock);
        await expect(translateWithOpenAICompatibleAiSdk({...request(config, 'custom:vision', 'vision-model').message})).resolves.toBe('ok');
    });

    it.each([
        ['gemini', gemini, 'gemini-2.5-flash'],
        ['claude', claude, 'claude-test'],
        ['tongyi', tongyi, 'qwen-test'],
        ['zhipu', zhipu, 'glm-test'],
    ] as const)('serializes %s native image input', async (name, provider, model) => {
        const config = new Config();
        config.service = name;
        config.model[name] = model;
        config.token[name] = name === 'zhipu' ? 'id.secret' : 'secret';
        config.customBody[name] = '{"model":"attacker"}';
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            if (name === 'gemini') expect(body.contents[0].parts[1].inline_data.data).toContain('9j');
            if (name === 'claude') expect(body.messages[0].content[1].source.data).toContain('9j');
            if (name === 'tongyi' || name === 'zhipu') expect(body.messages[1].content[1].image_url.url).toBe(image);
            expect(body.model).not.toBe('attacker');
            return name === 'gemini'
                ? response({candidates: [{content: {parts: [{text: 'ok'}]}}]})
                : name === 'claude'
                    ? response({content: [{type: 'text', text: 'ok'}]})
                    : response({choices: [{message: {content: 'ok'}}]});
        });
        setRuntimeFetch(fetchMock);
        const {message} = request(config, name, model);
        await expect(provider(message)).resolves.toBe('ok');
        expect(fetchMock).toHaveBeenCalledOnce();
    });
});
