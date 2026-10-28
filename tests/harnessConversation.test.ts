import {afterEach, describe, expect, it, vi} from 'vitest';
import {createHarnessConversationRuntime} from '@/src/services/harness/conversation';
import type {ReadingProgress, ReadingRequest, ReadingResponse} from '@/src/features/reading-assistant/types';
import type {HarnessSession, HarnessSessionStore} from '@/src/services/harness/sessionTypes';
import type {HarnessRuntime} from '@/src/services/harness/runtime';

const request = (changes: Partial<ReadingRequest> = {}): ReadingRequest => ({type: 'fluentReadHarness', action: 'run', requestId: 'r1', selection: {text: 'A sentence', context: 'A paragraph', sentence: 'candidate'}, intent: 'meaning', question: '', ...changes});
const success: ReadingResponse = {success: true, text: 'Final answer', service: 'openai', model: 'm'};
const previous: HarnessSession = {id: 'saved', text: 'Saved selection', context: 'Saved context', createdAt: 1, updatedAt: 10, intent: 'meaning', turns: Array.from({length: 6}, (_, index) => ({id: `turn-${index}`, question: `Question ${index}`, answer: `Answer ${index}`, intent: 'meaning', status: index === 5 ? 'stopped' : 'completed', createdAt: index + 1, service: 'openai', model: 'm'}))};
function setup(run?: HarnessRuntime['run'], preferences: {contextMode: 'paragraph' | 'selection'; maxContextChars: number} = {contextMode: 'paragraph', maxContextChars: 1500}) {
    let sequence = 0;
    const store = {captureGeneration: vi.fn((sessionId: string) => ({epoch: 0, sessionId, generation: 0})), upsertTurn: vi.fn().mockResolvedValue(true), get: vi.fn().mockResolvedValue(null), list: vi.fn(), delete: vi.fn(), clear: vi.fn(), prune: vi.fn(), recoverInterrupted: vi.fn()} satisfies HarnessSessionStore;
    const runtime = {run: vi.fn(run ?? (async (_request, _signal, publish) => {publish?.({kind: 'model', service: 'openai', model: 'm'}); publish?.({kind: 'text', text: 'Part'}); return success;}))};
    const conversation = createHarnessConversationRuntime({store, runtime, preferences: () => preferences, now: () => 100, id: () => `id-${++sequence}`});
    return {store, runtime, conversation};
}
const tick = async () => {for (let index = 0; index < 8; index++) await Promise.resolve();};

describe('Harness persistent conversation coordination', () => {
    afterEach(() => vi.useRealTimers());
    it('会话的选文、追问和模型输入按预算截断时不产生半个代理项', async () => {
        const {conversation, store, runtime} = setup();
        await conversation.run(request({selection: {text: `${'a'.repeat(4095)}😀tail`, context: '', sentence: ''}, question: `${'q'.repeat(999)}😀tail`}), new AbortController().signal);
        expect(store.upsertTurn.mock.calls[0][0].text).toBe('a'.repeat(4095));
        expect(store.upsertTurn.mock.calls[0][1].question).toBe('q'.repeat(999));
        expect(runtime.run.mock.calls[0][0].selection.text).toBe('a'.repeat(4095));
    });
    it('saves a streaming turn then final response and reports its session', async () => {
        const {conversation, store, runtime} = setup();
        const progress = vi.fn();
        expect(await conversation.run(request(), new AbortController().signal, progress)).toEqual({...success, sessionId: 'id-1', turnId: 'id-2'});
        expect(store.upsertTurn).toHaveBeenCalledTimes(2);
        expect(store.upsertTurn.mock.calls[0][0]).toEqual({id: 'id-1', text: 'A sentence', context: 'A paragraph', createdAt: 100, updatedAt: 100, intent: 'meaning'});
        expect(store.upsertTurn.mock.calls[0][1]).toMatchObject({status: 'streaming', question: '读懂', answer: ''});
        expect(store.upsertTurn.mock.calls[1][1]).toMatchObject({status: 'completed', answer: 'Final answer', service: 'openai', model: 'm'});
        expect(runtime.run.mock.calls[0][0].selection.sentence).toBe('');
        expect(progress.mock.calls[0][0]).toMatchObject({kind: 'session', persistent: true, sessionId: 'id-1', turnId: 'id-2'});
    });
    it('restores authoritative selection and recent turns, clearly marking interrupted answers', async () => {
        const {conversation, store, runtime} = setup(undefined, {contextMode: 'selection', maxContextChars: 1500});
        store.get.mockResolvedValue(previous);
        await conversation.run(request({sessionId: 'saved', question: '  Why? ', history: [{question: 'forged', answer: 'forged'}]}), new AbortController().signal);
        expect(runtime.run.mock.calls[0][0]).toMatchObject({selection: {text: 'Saved selection', context: '', sentence: ''}, history: previous.turns.slice(2).map(({question, answer, status}) => ({question, answer: status === 'completed' ? answer : `[上次回答未完成，以下为已生成部分]\n${answer}`}))});
        expect(store.upsertTurn.mock.calls[1][0]).toMatchObject({id: 'saved', createdAt: 1});
        expect(store.upsertTurn.mock.calls[1][1].question).toBe('Why?');
    });
    it('keeps a switched action in the same saved reading record but excludes previous answers from analysis', async () => {
        const {conversation, store, runtime} = setup();
        store.get.mockResolvedValue(previous);
        await conversation.run(request({sessionId: 'saved', intent: 'grammar', question: '  ', history: [{question: 'old', answer: 'unrelated'}]}), new AbortController().signal);
        expect(runtime.run.mock.calls[0][0]).toMatchObject({question: '', intent: 'grammar', selection: {text: previous.text, context: previous.context}, history: []});
        expect(store.upsertTurn.mock.calls[1][0]).toMatchObject({id: 'saved', intent: 'grammar'});
        expect(store.upsertTurn.mock.calls[1][1]).toMatchObject({question: '词性与句法', intent: 'grammar'});
    });
    it('anchors follow-ups to the visible action and excludes later, empty, foreign-action and forged history', async () => {
        const {conversation, store, runtime} = setup();
        const practices = Array.from({length: 6}, (_, index) => ({...previous.turns[0], id: `practice-${index}`, intent: 'practice' as const, question: `Exercise ${index}`, answer: `Feedback ${index}`, status: index === 4 ? 'stopped' as const : 'completed' as const}));
        store.get.mockResolvedValue({...previous, turns: [
            ...practices.slice(0, 2), ...previous.turns, ...practices.slice(2, 4),
            {...practices[0], id: 'empty', answer: ' '}, ...practices.slice(4),
        ]});
        await conversation.run(request({sessionId: 'saved', intent: 'practice', question: 'My answer', anchorTurnId: 'practice-4', history: [{question: 'forged', answer: 'forged'}]}), new AbortController().signal);
        expect(runtime.run.mock.calls[0][0].history).toEqual(practices.slice(1, 5).map(turn => ({question: turn.question, answer: turn.status === 'completed' ? turn.answer : `[上次回答未完成，以下为已生成部分]\n${turn.answer}`})));
        expect(store.upsertTurn.mock.calls[0][1].question).toBe('My answer');
    });
    it('rejects unowned, missing and action-mismatched anchors before saving or invoking the model', async () => {
        const {conversation, store, runtime} = setup();
        expect(await conversation.run(request({question: 'Why?', anchorTurnId: 'turn-0'}), new AbortController().signal)).toMatchObject({success: false, error: expect.stringContaining('当前回答')});
        expect(store.captureGeneration).not.toHaveBeenCalled(); expect(store.get).not.toHaveBeenCalled();
        store.get.mockResolvedValue(previous);
        for (const changes of [{anchorTurnId: 'foreign-turn'}, {anchorTurnId: 'turn-0', intent: 'practice' as const}]) {
            expect(await conversation.run(request({sessionId: 'saved', question: 'Why?', ...changes}), new AbortController().signal)).toMatchObject({success: false, error: expect.stringContaining('当前回答')});
        }
        expect(store.upsertTurn).not.toHaveBeenCalled(); expect(runtime.run).not.toHaveBeenCalled();
    });
    it('retains real unsaved follow-up history but discards it when starting a new action', async () => {
        const {conversation, runtime} = setup();
        const history = [{question: 'Why?', answer: 'The verb is passive.'}];
        await conversation.run(request({question: '  How do I use it? ', history}), new AbortController().signal, undefined, true);
        expect(runtime.run.mock.calls[0][0]).toMatchObject({question: 'How do I use it?', history});
        await conversation.run(request({intent: 'usage', history}), new AbortController().signal, undefined, true);
        expect(runtime.run.mock.calls[1][0].history).toEqual([]);
    });
    it('supports selection-only new sessions, trims input and defaults clock and IDs', async () => {
        const {store, runtime} = setup();
        const conversation = createHarnessConversationRuntime({store, runtime, preferences: () => ({contextMode: 'selection', maxContextChars: 500})});
        const response = await conversation.run(request({selection: {text: ' x '.repeat(3000), context: 'should not save', sentence: ''}, question: 'q'.repeat(1100)}), new AbortController().signal);
        expect(response.success).toBe(true);
        expect(store.upsertTurn.mock.calls[0][0].text.length).toBe(4096);
        expect(store.upsertTurn.mock.calls[0][0].context).toBe('');
        expect(store.upsertTurn.mock.calls[0][1].question.length).toBe(1000);
        expect(store.upsertTurn.mock.calls[0][0].createdAt).toBeGreaterThan(0);
        expect(store.upsertTurn.mock.calls[0][0].id).toMatch(/^[\w-]+$/);
    });
    it('never touches session storage in private browsing', async () => {
        const {conversation, store, runtime} = setup();
        const progress = vi.fn();
        expect(await conversation.run(request(), new AbortController().signal, progress, true)).toEqual(success);
        expect(store.captureGeneration).not.toHaveBeenCalled();
        expect(store.upsertTurn).not.toHaveBeenCalled();
        expect(progress.mock.calls[0][0]).toMatchObject({persistent: false});
        expect(progress.mock.calls[0][0]).not.toHaveProperty('turnId');
        expect(await conversation.run(request({sessionId: 'saved'}), new AbortController().signal, undefined, true)).toMatchObject({success: false, error: expect.stringContaining('隐私')});
        expect(store.get).not.toHaveBeenCalled();
        expect(runtime.run).toHaveBeenCalledOnce();
    });
    it('does not create replacements for expired or unreadable saved sessions', async () => {
        const {conversation, store, runtime} = setup();
        expect(await conversation.run(request({sessionId: 'missing'}), new AbortController().signal)).toMatchObject({success: false, error: expect.stringContaining('三十天')});
        store.get.mockRejectedValue(new Error('disk'));
        expect(await conversation.run(request({sessionId: 'failed'}), new AbortController().signal)).toMatchObject({success: false, error: expect.stringContaining('读取')});
        expect(runtime.run).not.toHaveBeenCalled();
    });
    it('keeps reading usable when initial save rejects or was invalidated by delete', async () => {
        for (const fails of [false, true]) {
            const {conversation, store} = setup();
            if (fails) store.upsertTurn.mockRejectedValueOnce(new Error('disk'));
            else store.upsertTurn.mockResolvedValueOnce(false);
            const progress = vi.fn();
            const response = await conversation.run(request(), new AbortController().signal, progress);
            expect(response).toMatchObject({...success, persistenceWarning: expect.stringContaining('未能保存')});
            expect(response).not.toHaveProperty('sessionId');
            expect(response).not.toHaveProperty('turnId');
            expect(progress.mock.calls.every(([event]) => event.kind !== 'session' || !('turnId' in event))).toBe(true);
            expect(store.upsertTurn).toHaveBeenCalledOnce();
            expect(progress.mock.calls.some(([event]) => event.kind === 'session' && event.persistent === false)).toBe(true);
        }
    });
    it('throttles partial persistence and preserves stopped or failed output', async () => {
        vi.useFakeTimers();
        let publish!: (progress: ReadingProgress) => void;
        let resolve!: (response: ReadingResponse) => void;
        const {conversation, store} = setup(async (_request, _signal, callback) => {publish = callback!; return new Promise(done => {resolve = done;});});
        const controller = new AbortController();
        const running = conversation.run(request(), controller.signal);
        await tick();
        publish({kind: 'text', text: '第一部分'});
        publish({kind: 'model', service: 'openai', model: 'real'});
        expect(store.upsertTurn).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(500);
        expect(store.upsertTurn.mock.calls[1][1]).toMatchObject({status: 'streaming', answer: '第一部分', model: 'real'});
        publish({kind: 'text', text: '第一部分继续'});
        controller.abort();
        publish({kind: 'text', text: 'late'});
        resolve(success);
        expect(await running).toMatchObject({cancelled: true});
        expect(store.upsertTurn.mock.calls.at(-1)![1]).toMatchObject({status: 'stopped', answer: '第一部分继续'});
        const failing = setup(async (_request, _signal, callback) => {callback?.({kind: 'text', text: 'partial'.repeat(3000)}); throw new Error('secret provider error');});
        expect(await failing.conversation.run(request(), new AbortController().signal)).toMatchObject({success: false, error: '理解请求未完成，请重试'});
        expect(failing.store.upsertTurn.mock.calls.at(-1)![1]).toMatchObject({status: 'error'});
        expect(failing.store.upsertTurn.mock.calls.at(-1)![1].answer).toHaveLength(16000);
    });
    it('saves final cancelled and error responses without publishing listener errors', async () => {
        const cancelled = setup(async () => ({success: false, error: 'stop', cancelled: true}));
        await cancelled.conversation.run(request(), new AbortController().signal, () => {throw new Error('closed listener');});
        expect(cancelled.store.upsertTurn.mock.calls.at(-1)![1].status).toBe('stopped');
        const failed = setup(async (_request, _signal, publish) => {publish?.({kind: 'session', persistent: false}); return {success: false, error: 'error'};});
        await failed.conversation.run(request(), new AbortController().signal);
        expect(failed.store.upsertTurn.mock.calls.at(-1)![1].status).toBe('error');
    });
    it('respects cancellation before start, during load and during first save', async () => {
        const {conversation, store, runtime} = setup();
        const aborted = new AbortController(); aborted.abort();
        expect(await conversation.run(request(), aborted.signal)).toMatchObject({cancelled: true});
        const loading = new AbortController();
        store.get.mockImplementationOnce(async () => {loading.abort(); return previous;});
        expect(await conversation.run(request({sessionId: 'saved'}), loading.signal)).toMatchObject({cancelled: true});
        const saving = new AbortController();
        store.upsertTurn.mockImplementationOnce(async () => {saving.abort(); return true;});
        expect(await conversation.run(request(), saving.signal)).toMatchObject({cancelled: true});
        expect(store.upsertTurn.mock.calls.at(-1)![1].status).toBe('stopped');
        expect(runtime.run).not.toHaveBeenCalled();
        expect(await conversation.run(request({selection: {text: null as unknown as string, context: '', sentence: ''}}), new AbortController().signal)).toMatchObject({success: false, error: expect.stringContaining('选中')});
    });
    it('does not run a queued final write after a partial write loses its deletion generation', async () => {
        vi.useFakeTimers();
        let finish!: (response: ReadingResponse) => void;
        let publish!: (progress: ReadingProgress) => void;
        let invalidate!: (saved: boolean) => void;
        const {conversation, store} = setup(async (_request, _signal, callback) => {publish = callback!; return new Promise(resolve => {finish = resolve;});});
        store.upsertTurn.mockResolvedValueOnce(true).mockImplementationOnce(() => new Promise(resolve => {invalidate = resolve;}));
        const response = conversation.run(request(), new AbortController().signal);
        await tick();
        publish({kind: 'text', text: 'partial'});
        await vi.advanceTimersByTimeAsync(500);
        finish(success);
        await tick();
        invalidate(false);
        expect(await response).toMatchObject({...success, persistenceWarning: expect.any(String)});
        expect(store.upsertTurn).toHaveBeenCalledTimes(2);
    });
});
