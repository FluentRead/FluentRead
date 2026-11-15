import {describe, expect, it, vi} from 'vitest';
import {buildChatGPTPlanHarnessPayload, createChatGPTPlanHarnessModel, readChatGPTPlanHarnessResult} from '@/src/services/harness/chatgptPlanModel';
import type {ChatGPTPlanPayload} from '@/src/platform/chatgpt-plan/bridge';

const event = (type: string, fields: Record<string, unknown> = {}) => `data: ${JSON.stringify({type, ...fields})}\n\n`;
const result = (output: unknown[], extra = {}) => ({id: 'fixture-response', status: 'completed', model: 'fixture-account-model', output, ...extra});
const textItem = (text: string) => ({type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text}]});
const completion = (response: unknown) => event('response.completed', {response});
const response = (body: string) => new Response(body, {headers: {'Content-Type': 'text/event-stream'}});
const options = (prompt: unknown[] = [{role: 'user', content: [{type: 'text', text: '选中文本'}]}], extra = {}) => ({prompt, ...extra}) as any;
const collect = async (stream: ReadableStream<unknown>) => {
    const values: unknown[] = [], reader = stream.getReader();
    try {while (true) {const next = await reader.read();if (next.done) return values;values.push(next.value);}}
    finally {reader.releaseLock();}
};

describe('ChatGPT 套餐 Harness 协议', () => {
    it('keeps only the user-facing answer when completed output also contains reasoning metadata', () => {
        const generated = readChatGPTPlanHarnessResult(result([
            {type:'reasoning',summary:[{type:'summary_text',text:'private reasoning summary'}]},
            textItem('visible answer'),
        ]));
        expect(generated.content).toEqual([{type:'text',text:'visible answer'}]);
        expect(generated.finishReason.unified).toBe('stop');
    });
    it('保留系统、文本多轮、函数调用与工具结果，仅使用本地namespace', () => {
        const payload = buildChatGPTPlanHarnessPayload('account-model', options([
            {role: 'system', content: '系统一'}, {role: 'system', content: '系统二'},
            {role: 'user', content: [{type: 'text', text: '第一轮原文'}]},
            {role: 'assistant', content: [{type: 'text', text: '第一轮回答'}, {type: 'reasoning', text: '不要重发推理'},
                {type: 'tool-call', toolCallId: 'call-1', toolName: 'read_context', input: {paragraph: 1}}]},
            {role: 'tool', content: [{type: 'tool-result', toolCallId: 'call-1', toolName: 'read_context', output: {type: 'text', value: '授权段落'}}]},
            {role: 'user', content: [{type: 'text', text: '追问'}]},
        ], {tools: [{type: 'function', name: 'read_context', description: '读取本次授权段落', inputSchema: {type: 'object'}}],
            temperature: 9, providerOptions: {token: 'ignored'}}));
        expect(payload.instructions).toBe('系统一\n\n系统二');
        expect(payload.input).toContainEqual({role: 'assistant', content: [{type: 'output_text', text: '第一轮回答'}]});
        expect(payload.input).toContainEqual({type: 'function_call', call_id: 'call-1', namespace: 'fluentread', name: 'read_context', arguments: '{"paragraph":1}'});
        expect(payload.input).toContainEqual({type: 'function_call_output', call_id: 'call-1', output: '授权段落'});
        expect(payload.tools).toEqual([{type: 'namespace', name: 'fluentread', description: expect.any(String), tools: [
            {type: 'function', name: 'read_context', description: '读取本次授权段落', parameters: {type: 'object'}, strict: false},
        ]}]);
        expect(JSON.stringify(payload)).not.toMatch(/不要重发推理|ignored|temperature|providerOptions/);
    });

    it('可信图片支持URL、base64及二进制，拒绝非图片文件或助手附件', () => {
        for (const data of [new URL('https://fixture.test/image.png'), 'YQ==', new Uint8Array([97])]) {
            const payload = buildChatGPTPlanHarnessPayload('m', options([{role: 'user', content: [{type: 'file', data, mediaType: 'image/png'}]}]));
            expect(payload.input).toEqual([{role: 'user', content: [{type: 'input_image', image_url: data instanceof URL ? data.href : 'data:image/png;base64,YQ=='}]}]);
        }
        for (const role of ['assistant', 'user']) expect(() => buildChatGPTPlanHarnessPayload('m', options([{role, content: [{type: 'file', data: 'YQ==', mediaType: role === 'user' ? 'application/pdf' : 'image/png'}]}]))).toThrow();
    });

    it('保留工具成功、错误与拒绝执行结果，toolChoice none不发送工具', () => {
        for (const [output, expected] of [
            [{type: 'json', value: {n: 1}}, '{"n":1}'], [{type: 'error-json', value: {error: true}}, '{"error":true}'],
            [{type: 'error-text', value: '失败'}, '失败'], [{type: 'execution-denied', reason: '用户拒绝'}, '用户拒绝'],
            [{type: 'execution-denied'}, 'Tool execution was declined.'],
            [{type: 'content', value: []}, '{"type":"content","value":[]}'],
        ] as const) {
            expect(buildChatGPTPlanHarnessPayload('m', options([{role: 'tool', content: [{type: 'tool-result', toolCallId: 'id', toolName: 't', output}]}])).input).toEqual([{type: 'function_call_output', call_id: 'id', output: expected}]);
        }
        expect(buildChatGPTPlanHarnessPayload('m', options(undefined, {tools: [{type: 'function', name: 't', inputSchema: {}}], toolChoice: {type: 'none'}})).tools).toBeUndefined();
    });

    it('缺失输入、未知内容、provider工具和强制toolChoice均拒绝', () => {
        expect(() => createChatGPTPlanHarnessModel(' ')).toThrow();
        expect(() => buildChatGPTPlanHarnessPayload('m', options([{role: 'system', content: 'only system'}]))).toThrow();
        expect(() => buildChatGPTPlanHarnessPayload('m', options([{role: 'user', content: [{type: 'unsupported'}]}]))).toThrow();
        expect(() => buildChatGPTPlanHarnessPayload('m', options(undefined, {tools: [{type: 'provider', name: 'web'}]}))).toThrow();
        for (const type of ['required', 'tool']) expect(() => buildChatGPTPlanHarnessPayload('m', options(undefined, {toolChoice: {type}}))).toThrow();
    });

    it('doGenerate提交完整文字、工具调用、模型和用量，保留调用方signal', async () => {
        const body = result([textItem('完整回答'), {type: 'function_call', namespace: 'fluentread', call_id: 'call', name: 'fluentread.read_context', arguments: '{}'}],
            {usage: {input_tokens: 10, output_tokens: 4, input_tokens_details: {cached_tokens: 3}, output_tokens_details: {reasoning_tokens: 1}}});
        const respond = vi.fn<(payload: ChatGPTPlanPayload, signal?: AbortSignal) => Promise<Response>>(async () => response(completion(body)));
        const signal = new AbortController().signal;
        const model = createChatGPTPlanHarnessModel(' account-model ', respond);
        const generated = await model.doGenerate(options(undefined, {abortSignal: signal}));
        expect(model.modelId).toBe('account-model');
        expect(respond.mock.calls[0][1]).toBe(signal);
        expect(generated.content).toEqual([{type: 'text', text: '完整回答'}, {type: 'tool-call', toolCallId: 'call', toolName: 'read_context', input: '{}'}]);
        expect(generated.finishReason.unified).toBe('tool-calls');
        expect(generated.usage.inputTokens).toMatchObject({total: 10, noCache: 7, cacheRead: 3});
        expect(generated.usage.outputTokens).toMatchObject({total: 4, text: 3, reasoning: 1});
        expect(generated.response).toEqual({id: 'fixture-response', modelId: 'fixture-account-model'});
    });

    it('doStream实时文字只在完整响应后finish，工具同时交给已有执行器', async () => {
        const tool = {type: 'function_call', namespace: 'fluentread', call_id: 'call', name: 'read_context', arguments: '{}'};
        const respond = vi.fn(async () => response(event('response.output_text.delta', {delta: '完整'}) + event('response.output_text.delta', {delta: '回答'}) + completion(result([textItem('完整回答'), tool]))));
        const model = createChatGPTPlanHarnessModel('m', respond);
        const parts = await collect((await model.doStream(options())).stream) as any[];
        expect(parts.map(part => part.type)).toEqual(['stream-start', 'text-start', 'text-delta', 'text-delta', 'text-end', 'tool-call', 'finish']);
        expect(parts.at(-1).finishReason.unified).toBe('tool-calls');
        expect(parts[5]).toMatchObject({toolName: 'read_context', input: '{}'});
    });

    it('没有delta的完成响应仍发文字；只有工具完成不会制造文字', async () => {
        for (const [output, expected] of [[ [textItem('回答')], ['stream-start', 'text-start', 'text-delta', 'text-end', 'finish'] ],
            [[{type: 'function_call', call_id: 'c', name: 't', arguments: '{}'}], ['stream-start', 'tool-call', 'finish'] ]] as const) {
            const model = createChatGPTPlanHarnessModel('m', async () => response(completion(result([...output]))));
            expect((await collect((await model.doStream(options())).stream) as any[]).map(part => part.type)).toEqual(expected);
        }
    });

    it.each([
        event('response.output_text.delta', {delta: 'partial'}),
        event('response.failed', {response: {status: 'failed'}}),
        event('response.incomplete', {response: {status: 'incomplete'}}),
        event('error', {code: 'subscription_sharing_usage_limit_exceeded'}),
    ])('failed/incomplete/截断/额度错误阻止generate与stream成功', async body => {
        const model = createChatGPTPlanHarnessModel('m', async () => response(body));
        await expect(model.doGenerate(options())).rejects.toThrow();
        await expect(collect((await model.doStream(options())).stream)).rejects.toThrow();
    });

    it('delta与completed内容冲突拒绝，空输出、refusal、外部namespace和畸形工具拒绝', async () => {
        const model = createChatGPTPlanHarnessModel('m', async () => response(event('response.output_text.delta', {delta: 'partial'}) + completion(result([textItem('other')]))));
        await expect(collect((await model.doStream(options())).stream)).rejects.toThrow();
        for (const output of [[], [{type: 'message', content: [{type: 'refusal'}]}], [{type: 'function_call', call_id: 'c', name: 't', arguments: '{}', namespace: 'external'}], [{type: 'function_call', name: 't'}]]) {
            expect(() => readChatGPTPlanHarnessResult(result(output))).toThrow();
        }
        expect(() => readChatGPTPlanHarnessResult({})).toThrow();
    });

    it('未知或畸形usage不编造token，文本finishReason为stop', () => {
        const generated = readChatGPTPlanHarnessResult(result([textItem('text')], {usage: {input_tokens: '8', output_tokens: -1}, id: null, model: null}));
        expect(generated.finishReason.unified).toBe('stop');
        expect(generated.usage.inputTokens.total).toBeUndefined();
        expect(generated.usage.outputTokens.total).toBeUndefined();
        expect(generated.response).toEqual({id: undefined, modelId: undefined});
        const minimal = readChatGPTPlanHarnessResult(result([textItem('text')], {usage: {input_tokens: 8, output_tokens: 2}}));
        expect(minimal.usage.inputTokens.noCache).toBe(8);
        expect(minimal.usage.outputTokens.text).toBe(2);
    });

    it('取消stream会中止等待中的reader与助手signal，无需新上游chunk', async () => {
        const cancel = vi.fn(), respond = vi.fn<(payload: ChatGPTPlanPayload, signal?: AbortSignal) => Promise<Response>>(async () => new Response(new ReadableStream({cancel}), {headers: {'Content-Type': 'text/event-stream'}}));
        const model = createChatGPTPlanHarnessModel('m', respond);
        const reader = (await model.doStream(options())).stream.getReader();
        expect((await reader.read()).value).toMatchObject({type: 'stream-start'});
        await reader.cancel();
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(respond.mock.calls[0][1]?.aborted).toBe(true);
    });

    it('调用方abort与传输启动失败被保留，监听在失败后释放', async () => {
        const controller = new AbortController(), remove = vi.spyOn(controller.signal, 'removeEventListener');
        const model = createChatGPTPlanHarnessModel('m', async (_payload, signal) => {
            if (signal?.aborted) throw signal.reason;
            throw new Error('fixture-failure');
        });
        await expect(model.doStream(options(undefined, {abortSignal: controller.signal}))).rejects.toThrow('fixture-failure');
        expect(remove).toHaveBeenCalled();
        controller.abort();
        await expect(model.doStream(options(undefined, {abortSignal: controller.signal}))).rejects.toMatchObject({name: 'AbortError'});
        await expect(model.doGenerate(options(undefined, {abortSignal: controller.signal}))).rejects.toMatchObject({name: 'AbortError'});
    });
});
