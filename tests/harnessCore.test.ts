import {describe, expect, it, vi} from 'vitest';
import {HarnessLedger, deriveEventMessage, deriveMessages, foldSurface, isSurfaceEvent} from '@/src/core/harness/surface';
import {runHarnessLoop, type HarnessGenerateResult, type HarnessToolDefinition} from '@/src/core/harness/loop';
import {z} from 'zod';
import {isReadContextInput} from '@/src/services/harness/readContext';

const tools: readonly HarnessToolDefinition[] = [{name: 'read_context', description: 'read', input: {type: 'object'}}];
const result = (text: string, toolCalls: HarnessGenerateResult['toolCalls'] = []): HarnessGenerateResult => ({
    assistant: {role: 'assistant', content: text ? [{type: 'text', text}] : toolCalls.map(call => ({type: 'tool-call', toolCallId: call.id, toolName: call.name, input: call.input}))}, text, toolCalls,
});

describe('tool-free reading generation', () => {
    it('does not require an unused executor when the original text is already supplied', async () => {
        const generate = vi.fn().mockResolvedValue(result('direct answer'));
        const output = await runHarnessLoop({generate, system: '', user: 'supplied source', tools: [], signal: new AbortController().signal});
        expect(output.text).toBe('direct answer');
        expect(generate).toHaveBeenCalledOnce();
        await expect(runHarnessLoop({generate, system: '', user: 'source', tools, signal: new AbortController().signal})).rejects.toThrow('已声明的阅读工具缺少执行器');
        expect(generate).toHaveBeenCalledOnce();
    });

    it('clears streamed text before a tool result starts another model answer', async () => {
        const text: string[] = [];
        const generate = vi.fn().mockImplementationOnce(async input => {
            input.onText('preface');
            return result('', [{id: 'context', name: 'read_context', input: {}}]);
        }).mockImplementationOnce(async input => {input.onText('final');return result('final');});
        await runHarnessLoop({generate, executeTool: async () => 'authorized paragraph', system: '', user: 'source', tools,
            signal: new AbortController().signal, onText: value => text.push(value)});
        expect(text).toEqual(['preface', '', 'final']);
    });
});

describe('shared read_context wire validation', () => {
    it('matches the installed native strict schema for JSON boundaries, inherited keys and non-JSON tool values', () => {
        const native = z.object({reason: z.string().max(200).optional()}).strict();
        const inputs: unknown[] = [undefined, null, true, 0, NaN, '', [], ['reason'], () => undefined,
            {}, {reason: undefined}, {reason: ''}, {reason: 'x'.repeat(200)}, {reason: 'x'.repeat(201)},
            {reason: '🙂'.repeat(100)}, {reason: '🙂'.repeat(101)}, {reason: null}, {reason: 1}, {reason: false},
            {reason: {}}, {extra: ''}, {reason: 'ok', extra: false}, new Date(), new Map(), new Set(), Promise.resolve(),
            {then() {}, catch() {}}, Object.create(null), Object.create({reason: 'inherited'}),
            Object.create({other: 'inherited'}), Object.defineProperty({}, 'extra', {value: true}),
            {[Symbol('private')]: true}, new (class {reason = 'class field';})(),
        ];
        for (const value of inputs) expect(isReadContextInput(value)).toBe(native.safeParse(value).success);
        for (let size = 0; size <= 220; size++) {
            const value = {reason: 'x'.repeat(size)};
            expect(isReadContextInput(value)).toBe(native.safeParse(value).success);
        }
    });
});

describe('Harness browser core', () => {
    it('ports upstream surface eligibility and projection rules', () => {
        const ledger = new HarnessLedger();
        ledger.append('turn/start', {turn: 1});
        const user = ledger.appendUser({role: 'user', content: 'hello'});
        const empty = ledger.appendAssistant({role: 'assistant', content: []});
        ledger.appendAssistant({role: 'assistant', content: [{type: 'text', text: 'hi'}]});
        expect(isSurfaceEvent(user)).toBe(true);
        expect(deriveEventMessage(empty)).toBeNull();
        expect(deriveMessages(ledger.eventsSnapshot())).toHaveLength(2);
        expect(deriveEventMessage({seq: 3, type: 'step/end', data: {}})).toBeNull();
        expect(deriveEventMessage({seq: 4, type: 'tool/result', data: {}})).toBeNull();
        expect(ledger.length).toBe(4);
    });

    it('requires contiguous append events and rejects unmarked surface events', () => {
        const ledger = new HarnessLedger();
        ledger.appendUser({role: 'user', content: 'x'});
        expect(() => foldSurface([{seq: 1, type: 'user/message', data: {role: 'user', content: 'x'}, surfaceOp: 'append'}])).toThrow('contiguous');
        expect(() => foldSurface([{seq: 0, type: 'user/message', data: {role: 'user', content: 'x'}}])).toThrow('requires a surfaceOp');
        expect(() => foldSurface([{seq: 0, type: 'step/end', data: {}, surfaceOp: 'append'}])).toThrow('not surface-eligible');
    });

    it('records real history and tool result before the next generated step', async () => {
        const generate = vi.fn()
            .mockResolvedValueOnce(result('', [{id: 't1', name: 'read_context', input: {reason: 'explain'}}]))
            .mockResolvedValueOnce(result('done'));
        const output = await runHarnessLoop({generate, executeTool: async () => 'paragraph', system: 's', user: 'new', history: [
            {role: 'user', content: 'old question'}, {role: 'assistant', content: [{type: 'text', text: 'old answer'}]},
        ], tools, signal: new AbortController().signal});
        expect(output.text).toBe('done');
        expect(generate).toHaveBeenCalledTimes(2);
        expect(generate.mock.calls[1][0].messages.map((message: {role: string}) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'tool']);
        expect(output.ledger.some(event => event.type === 'tool/result')).toBe(true);
    });

    it('preserves an existing tool event in the derived history', async () => {
        const generate = vi.fn().mockResolvedValue(result('done'));
        const output = await runHarnessLoop({generate, executeTool: async () => 'unused', system: 's', user: 'new', history: [
            {role: 'tool', content: [{type: 'tool-result', toolCallId: 'old', output: {type: 'text', value: 'old'}}]},
        ], tools, signal: new AbortController().signal});
        expect(generate.mock.calls[0][0].messages.map((message: {role: string}) => message.role)).toEqual(['tool', 'user']);
        expect(output.text).toBe('done');
    });

    it('does not append or return after cancellation and enforces tool validation/budget', async () => {
        const canceled = new AbortController();
        canceled.abort();
        await expect(runHarnessLoop({generate: vi.fn(), executeTool: vi.fn(), system: '', user: 'x', tools, signal: canceled.signal})).rejects.toThrow('取消');
        const generate = vi.fn().mockResolvedValue(result('', [{id: 't', name: 'write_file', input: {}}]));
        await expect(runHarnessLoop({generate, executeTool: vi.fn(), system: '', user: 'x', tools, signal: new AbortController().signal})).rejects.toThrow('不支持');
        const over = vi.fn().mockResolvedValue(result('', [{id: '1', name: 'read_context', input: {}}, {id: '2', name: 'read_context', input: {}}]));
        await expect(runHarnessLoop({generate: over, executeTool: vi.fn(), system: '', user: 'x', tools, maxTools: 1, signal: new AbortController().signal})).rejects.toThrow('上限');
    });

    it('relays an abort that arrives during generation before committing output', async () => {
        const controller = new AbortController();
        const generate = vi.fn(async () => { controller.abort(); return result('late'); });
        await expect(runHarnessLoop({generate, executeTool: vi.fn(), system: '', user: 'x', tools, signal: controller.signal})).rejects.toThrow('取消');
    });

    it('rejects mismatched, duplicate and malformed tool pairs', async () => {
        const mismatch = vi.fn().mockResolvedValue({assistant: {role: 'assistant', content: [{type: 'tool-call', toolCallId: 'x', toolName: 'read_context'}]}, text: '', toolCalls: []});
        await expect(runHarnessLoop({generate: mismatch, executeTool: vi.fn(), system: '', user: 'x', tools, signal: new AbortController().signal})).rejects.toThrow('不匹配');
        const duplicate = vi.fn().mockResolvedValueOnce(result('', [{id: 'x', name: 'read_context', input: {}}])).mockResolvedValueOnce(result('', [{id: 'x', name: 'read_context', input: {}}]));
        await expect(runHarnessLoop({generate: duplicate, executeTool: async () => 'ok', system: '', user: 'x', tools, maxModelCalls: 2, signal: new AbortController().signal})).rejects.toThrow('重复');
        const invalidRole = vi.fn().mockResolvedValue({assistant: {role: 'user', content: [{type: 'text', text: 'bad'}]}, text: 'bad', toolCalls: []});
        await expect(runHarnessLoop({generate: invalidRole, executeTool: vi.fn(), system: '', user: 'x', tools, signal: new AbortController().signal})).rejects.toThrow('助手消息');
    });

    it('enforces model call budget and rejects empty final output', async () => {
        const calls = vi.fn().mockResolvedValue(result('', [{id: 'a', name: 'read_context', input: {}}]));
        await expect(runHarnessLoop({generate: calls, executeTool: async () => 'ok', system: '', user: 'x', tools, maxModelCalls: 1, maxTools: 1, signal: new AbortController().signal})).rejects.toThrow('请求次数');
        const empty = vi.fn().mockResolvedValue(result('   '));
        await expect(runHarnessLoop({generate: empty, executeTool: vi.fn(), system: '', user: 'x', tools, signal: new AbortController().signal})).rejects.toThrow('没有返回');
    });

    it('passes cancellation to a noncooperative tool and preserves immutable snapshots', async () => {
        const ledger = new HarnessLedger();
        const data = {nested: {value: 1}};
        ledger.appendUser({role: 'user', content: data});
        data.nested.value = 2;
        expect(JSON.stringify(ledger.messagesSnapshot())).toContain('"value":1');
        const controller = new AbortController();
        const execute = vi.fn(() => new Promise<string>(() => undefined));
        const pending = runHarnessLoop({generate: vi.fn().mockResolvedValue(result('', [{id: 't', name: 'read_context', input: {}}])), executeTool: execute, system: '', user: 'x', tools, signal: controller.signal});
        await Promise.resolve();
        await Promise.resolve();
        controller.abort();
        await expect(pending).rejects.toThrow('取消');
        expect(execute).not.toHaveBeenCalled();
    });

    it('times out a noncooperative generator', async () => {
        vi.useFakeTimers();
        try {
            const pending = runHarnessLoop({generate: vi.fn(() => new Promise<HarnessGenerateResult>(() => undefined)), executeTool: vi.fn(), system: '', user: 'x', tools, timeoutMs: 1_000, signal: new AbortController().signal});
            const assertion = expect(pending).rejects.toThrow('超时');
            await vi.advanceTimersByTimeAsync(1_000);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });
    it('does not expose its stored event through append return values', () => {
        const ledger = new HarnessLedger();
        const returned = ledger.appendUser({role: 'user', content: 'original'});
        (returned.data as {content: string}).content = 'mutated';
        expect(ledger.messagesSnapshot()).toEqual([{role: 'user', content: 'original'}]);
    });

});
