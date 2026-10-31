import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import claude from '@/src/providers/translation/claude';
import deepseek from '@/src/providers/translation/deepseek';
import {attachTranslationModelUsageObserver, createTranslationProviderConfigSnapshot} from '@/src/services/translation/requestSnapshot';
import {claudeMsgTemplate, deepseekResponsesMsgTemplate, deepseekMsgTemplate, commonMsgTemplate} from '@/src/services/translation/templates';
import {providerConfigFixture, withProviderSnapshot} from './helpers/providerSnapshot';

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock);});
afterEach(() => vi.unstubAllGlobals());

function config(service: 'claude' | 'deepseek') {
    return providerConfigFixture({service, model: {[service]: 'configured-model'}, token: {}, proxy: {},
        deepseekApiType: 'responses', system_role: {[service]: 'Translate.'}, user_role: {[service]: '{{origin}}'}});
}
function reply(value: unknown) {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(value), {status: 200, headers: {'content-type': 'application/json'}}));
}
const usage = {input_tokens: 2, output_tokens: 3};
const text = {type: 'message', content: [{type: 'output_text', text: 'translation'}]};

describe('Claude translation completeness', () => {
    const partial = {model: 'actual-model', content: [{type: 'text', text: 'partial'}], usage};
    it.each(['max_tokens', 'tool_use', 'refusal', 'pause_turn', 'unknown', null])('rejects explicit nonfinal stop reason %s', async stop_reason => {
        reply({...partial, stop_reason});
        const observe = vi.fn();
        const request = attachTranslationModelUsageObserver(withProviderSnapshot({origin: 'source'}, config('claude')), observe);
        await expect(claude(request)).rejects.toMatchObject({kind: 'response', retryable: false, statusCode: 200});
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(observe).toHaveBeenCalledOnce();
        expect(observe).toHaveBeenCalledWith(expect.objectContaining({outcome: 'error', actualModel: 'actual-model', inputTokens: 2, outputTokens: 3}));
    });
    it.each([
        {type: 'error'}, {error: {type: 'overloaded'}},
        ...['tool_use', 'refusal', 'error'].map(type => ({stop_reason: 'end_turn', content: [...partial.content, {type}]})),
    ])('rejects error and mixed text/control payload %#', async patch => {
        reply({...partial, ...patch});
        const observe = vi.fn();
        await expect(claude(attachTranslationModelUsageObserver(withProviderSnapshot({origin: 'source'}, config('claude')), observe))).rejects.toMatchObject({kind: 'response'});
        expect(observe).toHaveBeenCalledOnce();
        expect(observe.mock.calls[0][0]).toMatchObject({outcome: 'error', actualModel: 'actual-model', inputTokens: 2, outputTokens: 3});
    });
    it.each([undefined, 'end_turn', 'stop_sequence'])('preserves compatible successful stop %s', async stop_reason => {
        reply({...partial, stop_reason, content: [{type: 'thinking', thinking: 'private'}, {type: 'text', text: 'one'}, {type: 'text', text: 'two'}]});
        await expect(claude(withProviderSnapshot({origin: 'source'}, config('claude')))).resolves.toBe('onetwo');
    });
});

describe('DeepSeek Responses translation completeness', () => {
    const partial = {model: 'actual-model', status: 'completed', output: [text], usage};
    it.each([
        {status: 'incomplete'}, {status: 'failed'}, {status: 'in_progress'}, {status: null},
        {error: {code: 'bad'}}, {incomplete_details: {reason: 'max_output_tokens'}},
        {output: [{...text, status: 'incomplete'}]},
        {output: [{type: 'message', content: [...text.content, {type: 'refusal', refusal: 'no'}]}]},
        {output: [{type: 'error'}, text]},
    ])('rejects incomplete/error/refusal even with plausible text %#', async patch => {
        reply({...partial, ...patch});
        const observe = vi.fn();
        await expect(deepseek(attachTranslationModelUsageObserver(withProviderSnapshot({origin: 'source'}, config('deepseek')), observe))).rejects.toMatchObject({kind: 'response', retryable: false, statusCode: 200});
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(observe).toHaveBeenCalledOnce();
        expect(observe.mock.calls[0][0]).toMatchObject({outcome: 'error', actualModel: 'actual-model', inputTokens: 2, outputTokens: 3});
    });
    it.each(['function_call', 'web_search_call', 'computer_call', 'mcp_call', 'unknown', undefined])('rejects mixed tool/unknown output type %s before extracting text', async type => {
        for (const status of [undefined, 'completed']) {
            fetchMock.mockClear();
            reply({...partial, output_text: 'tempting top-level text', output: [{type, status}, text]});
            const observe = vi.fn();
            await expect(deepseek(attachTranslationModelUsageObserver(withProviderSnapshot({origin: 'source'}, config('deepseek')), observe))).rejects.toMatchObject({kind: 'response'});
            expect(observe).toHaveBeenCalledOnce();
            expect(fetchMock).toHaveBeenCalledOnce();
            expect(observe.mock.calls[0][0]).toMatchObject({outcome: 'error', actualModel: 'actual-model', inputTokens: 2, outputTokens: 3});
        }
    });
    it.each([
        {status: 'completed', output: [{type: 'reasoning', status: 'completed'}, {...text, status: 'completed'}]},
        {output: [{type: 'reasoning'}, text]},
        {output_text: 'translation'},
    ])('preserves completed and legacy compatible responses %#', async payload => {
        reply({...payload, model: 'actual-model', usage});
        const observe = vi.fn();
        await expect(deepseek(attachTranslationModelUsageObserver(withProviderSnapshot({origin: 'source'}, config('deepseek')), observe))).resolves.toBe('translation');
        expect(observe).toHaveBeenCalledOnce();
        expect(observe.mock.calls[0][0].outcome).toBe('success');
    });
    it('does not reinterpret Chat Completions through the Responses guard', async () => {
        reply({status: 'incomplete', choices: [{message: {content: 'chat translation'}}]});
        await expect(deepseek(withProviderSnapshot({origin: 'source'}, {...config('deepseek'), deepseekApiType: 'chat_completions'}))).resolves.toBe('chat translation');
    });
});

describe('JSON-only translation protocols own streaming flags', () => {
    it.each(['claude', 'deepseek'] as const)('forces %s nonstreaming after custom fields/model replacement', service => {
        for (const replaceModel of [false, true]) {
            const source = config(service);
            source.customBody = {[service]: JSON.stringify({stream: true, stream_options: {include_usage: true}, temperature: 0.2,
                ...(replaceModel ? {model: 'custom-model'} : {})})};
            const current = createTranslationProviderConfigSnapshot(source);
            const render = service === 'claude' ? claudeMsgTemplate : deepseekResponsesMsgTemplate;
            const body = JSON.parse(render({origin: 'source', current}));
            expect(body.stream).toBe(false);
            expect(body).not.toHaveProperty('stream_options');
            expect(body.temperature).toBe(0.2);
            expect(body.model).toBe(replaceModel ? 'custom-model' : 'configured-model');
        }
    });
    it('does not newly force streaming fields on Chat protocol templates', () => {
        const source = config('deepseek');
        source.customBody = {deepseek: '{"stream":true,"stream_options":{"include_usage":true}}'};
        const current = createTranslationProviderConfigSnapshot(source);
        for (const render of [deepseekMsgTemplate, commonMsgTemplate]) {
            const body = JSON.parse(render({origin: 'source', current}));
            expect(body.stream).toBe(true);
            expect(body.stream_options).toEqual({include_usage: true});
        }
    });
});

it.each(['claude', 'deepseek'] as const)('retains protected %s vision model/image while forcing nonstreaming', service => {
    const source = config(service);
    source.customBody = {[service]: '{"model":"hostile-replacement","stream":true,"stream_options":{"include_usage":true}}'};
    const current = createTranslationProviderConfigSnapshot(source);
    const imageInput = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
    const render = service === 'claude' ? claudeMsgTemplate : deepseekResponsesMsgTemplate;
    const body = JSON.parse(render({origin: 'source', current, imageInput}));
    expect(body.model).toBe('configured-model');
    expect(body.stream).toBe(false);
    expect(body).not.toHaveProperty('stream_options');
    expect(JSON.stringify(body)).toContain('/9j/4AAQSkZJRg==');
});
