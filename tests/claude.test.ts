import {withProviderSnapshot} from './helpers/providerSnapshot';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const {mockConfig} = vi.hoisted(() => ({
    mockConfig: {
        service: 'claude',
        aiRequestTimeoutMs: undefined as number | undefined,
        to: 'zh-Hans',
        token: {claude: 'claude-secret'} as Record<string, string>,
        model: {claude: 'claude-haiku-4-5'} as Record<string, string>,
        customModel: {} as Record<string, string>,
        modelThinking: {claude: {'claude-haiku-4-5': true}} as Record<string, Record<string, boolean>>,
        customBody: {} as Record<string, string>,
        proxy: {} as Record<string, string>,
        system_role: {claude: 'You are a translator.'} as Record<string, string>,
        user_role: {claude: 'Translate to {{to}}: {{origin}}'} as Record<string, string>,
    },
}));

vi.mock('@/src/services/config/store', () => ({config: mockConfig}));

import claude from '@/src/providers/translation/claude';
import {attachTranslationModelUsageObserver} from '@/src/services/translation/requestSnapshot';

const fetchMock = vi.fn<typeof fetch>();

function response(content: unknown): Response {
    return new Response(JSON.stringify({
        model: 'claude-haiku-4-5',
        content,
        usage: {input_tokens: 2, output_tokens: 3},
    }), {status: 200, headers: {'content-type': 'application/json'}});
}

beforeEach(() => {
    fetchMock.mockReset();
    mockConfig.aiRequestTimeoutMs = undefined;
    mockConfig.modelThinking = {claude: {'claude-haiku-4-5': true}};
    mockConfig.customBody = {};
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('Claude Thinking 响应', () => {
    it('忽略思考块并拼接所有最终文本块', async () => {
        fetchMock.mockResolvedValue(response([
            {type: 'thinking', thinking: 'private reasoning'},
            {type: 'text', text: '译文'},
            {text: '结束'},
        ]));

        await expect(claude(withProviderSnapshot({origin: 'hello'}, mockConfig))).resolves.toBe('译文结束');
        const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
        expect(request.thinking).toEqual({type: 'enabled', budget_tokens: 1024});
    });

    it('没有最终文本块时返回明确错误', async () => {
        fetchMock.mockResolvedValue(response([{type: 'thinking', thinking: 'private reasoning'}]));

        await expect(claude(withProviderSnapshot({origin: 'hello'}, mockConfig))).rejects.toThrow('Claude 返回数据格式异常：缺少文本内容');
    });
});


describe('claude AI 请求超时预算', () => {
    it('直接调用默认允许 60 秒响应，完成后清理超时计时器', async () => {
        vi.useFakeTimers();
        let resolve!: (value: Response) => void;
        let signal!: AbortSignal;
        fetchMock.mockImplementation((_input, init) => {
            signal = init!.signal!;
            return new Promise<Response>(done => {resolve = done;});
        });
        const result = claude(withProviderSnapshot({origin: 'Slow native AI source'}, mockConfig));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(signal.aborted).toBe(false);
        resolve(response([{type: 'text', text: '缓慢模型译文'}]));
        await expect(result).resolves.toBe('缓慢模型译文');
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
        {configured: 10_000, explicit: undefined, deadline: 10_000},
        {configured: 600_000, explicit: 500, deadline: 500},
        {configured: 10_000, explicit: 180_000, deadline: 180_000},
    ])('配置与显式剩余预算在精确截止 abort：$deadline 毫秒', async ({configured, explicit, deadline}) => {
        vi.useFakeTimers();
        mockConfig.aiRequestTimeoutMs = configured;
        let signal!: AbortSignal;
        fetchMock.mockImplementation((_input, init) => {
            signal = init!.signal!;
            return new Promise((_, reject) => signal.addEventListener('abort',
                () => reject(new DOMException('aborted', 'AbortError')), {once: true}));
        });
        const outcome = claude(withProviderSnapshot({origin: 'Native AI deadline source', requestTimeoutMs: explicit}, mockConfig)).catch(error => error);
        await vi.advanceTimersByTimeAsync(deadline - 1);
        expect(signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(outcome).resolves.toMatchObject({kind: 'timeout', retryable: true});
        expect(signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('用户取消立即传播，与延长后的等待时间无关', async () => {
        vi.useFakeTimers();
        mockConfig.aiRequestTimeoutMs = 600_000;
        const controller = new AbortController();
        let signal!: AbortSignal;
        fetchMock.mockImplementation((_input, init) => {
            signal = init!.signal!;
            return new Promise((_, reject) => signal.addEventListener('abort',
                () => reject(new DOMException('aborted', 'AbortError')), {once: true}));
        });
        const outcome = claude(withProviderSnapshot({origin: 'Cancelled native AI source', abortSignal: controller.signal}, mockConfig)).catch(error => error);
        controller.abort();
        await expect(outcome).resolves.toMatchObject({name: 'AbortError'});
        expect(signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('Claude 响应正文的取消语义', () => {
    it('请求前取消不发送网络请求', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(claude(withProviderSnapshot({origin: 'hello', abortSignal: controller.signal}, mockConfig)))
            .rejects.toMatchObject({name: 'AbortError'});
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('不合作传输在取消后返回完整正文也不发布译文', async () => {
        const controller = new AbortController();
        const stream = new ReadableStream<Uint8Array>({
            pull(output) {
                controller.abort();
                output.enqueue(new TextEncoder().encode(JSON.stringify({content: [{type: 'text', text: '迟到译文'}]})));
                output.close();
            },
        }, {highWaterMark: 0});
        fetchMock.mockResolvedValue(new Response(stream));
        await expect(claude(withProviderSnapshot({origin: 'hello', abortSignal: controller.signal}, mockConfig)))
            .rejects.toMatchObject({name: 'AbortError'});
    });

    it('未取消的损坏 JSON 不泄露正文，仍报告格式错误', async () => {
        fetchMock.mockResolvedValue(new Response('{private text'));
        const outcome = await claude(withProviderSnapshot({origin: 'hello'}, mockConfig)).catch(error => error);
        expect(outcome.message).toBe('Claude 返回的不是有效 JSON');
        expect(outcome.message).not.toContain('private text');
    });

    it('正文读取截止时仍区分超时和用户取消', async () => {
        vi.useFakeTimers();
        let notifyRead!: () => void;
        const readStarted = new Promise<void>(resolve => {notifyRead = resolve;});
        fetchMock.mockImplementation(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
            start(output) {init!.signal!.addEventListener('abort', () => output.error(new DOMException('aborted', 'AbortError')), {once: true});},
            pull() {notifyRead();},
        }, {highWaterMark: 0})));
        const outcome = claude(withProviderSnapshot({origin: 'hello', requestTimeoutMs: 10}, mockConfig)).catch(error => error);
        await readStarted;
        await vi.advanceTimersByTimeAsync(10);
        await expect(outcome).resolves.toMatchObject({name: 'TimeoutError', kind: 'timeout', retryable: true});
        expect(vi.getTimerCount()).toBe(0);
    });

    it('响应已返回且 JSON 正在读取时用户取消，保留 AbortError 而非报格式错误', async () => {
        const controller = new AbortController();
        let notifyRead!: () => void;
        const readStarted = new Promise<void>(resolve => {notifyRead = resolve;});
        fetchMock.mockImplementation(async (_input, init) => {
            const stream = new ReadableStream<Uint8Array>({
                start(output) {
                    init!.signal!.addEventListener('abort', () => output.error(new DOMException('aborted', 'AbortError')), {once: true});
                },
                pull() {notifyRead();},
            }, {highWaterMark: 0});
            return new Response(stream, {headers: {'content-type': 'application/json'}});
        });
        const observed = vi.fn();
        const message = withProviderSnapshot(attachTranslationModelUsageObserver(
            {origin: 'private text', abortSignal: controller.signal}, observed,
        ), mockConfig);
        const result = claude(message).catch(error => error);
        await readStarted;
        controller.abort();
        await expect(result).resolves.toMatchObject({name: 'AbortError'});
        expect(observed).toHaveBeenCalledOnce();
        expect(observed.mock.calls[0]?.[0]).toMatchObject({outcome: 'cancelled', usageAvailability: 'unreported'});
    });
});
