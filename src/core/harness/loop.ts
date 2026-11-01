/**
 * @file src/core/harness/loop.ts
 * 文件职责：以供应商无关的循环串联会话消息、只读工具与最终回答，保持 DeepSeek Harness 的事件先记录后投影顺序。
 * 主要内容：注入模型生成和可选工具执行，无工具请求无需执行器；记录每步事件并约束次数、重复编号、取消和总超时。
 * 模块边界：本模块不依赖 AI SDK、浏览器、配置或网络；FluentRead 服务层负责把实际模型协议适配为这里的纯类型端口。
 */
import {HarnessLedger, type HarnessEvent, type HarnessMessage} from './surface';

export interface HarnessToolCall {id: string; name: string; input: unknown}
export interface HarnessToolDefinition {name: string; description: string; input: unknown}
export interface HarnessGenerateInput {system: string; messages: readonly HarnessMessage[]; tools: readonly HarnessToolDefinition[]; signal: AbortSignal; onText?: (text: string) => void}
export interface HarnessGenerateResult {assistant: HarnessMessage; text: string; toolCalls: readonly HarnessToolCall[]}
export type HarnessGenerate = (input: HarnessGenerateInput) => Promise<HarnessGenerateResult>;
export type HarnessToolExecutor = (call: HarnessToolCall, signal: AbortSignal) => Promise<string>;
export interface HarnessLoopInput {
    generate: HarnessGenerate;
    executeTool?: HarnessToolExecutor;
    system: string;
    user: string;
    history?: readonly HarnessMessage[];
    tools: readonly HarnessToolDefinition[];
    signal: AbortSignal;
    maxModelCalls?: number;
    maxTools?: number;
    timeoutMs?: number;
    onText?: (text: string) => void;
}
export interface HarnessLoopResult {text: string; ledger: HarnessEvent[]}

export async function runHarnessLoop(input: HarnessLoopInput): Promise<HarnessLoopResult> {
    if (input.tools.length && !input.executeTool) throw new Error('已声明的阅读工具缺少执行器');
    const ledger = new HarnessLedger();
    const maxModelCalls = Math.min(6, Math.max(1, input.maxModelCalls ?? 4));
    const maxTools = Math.min(6, Math.max(0, input.maxTools ?? 2));
    const controller = new AbortController();
    const relayAbort = () => controller.abort(input.signal.reason);
    input.signal.addEventListener('abort', relayAbort, {once: true});
    const timer = setTimeout(() => controller.abort(new Error('阅读助手请求超时')), Math.min(60_000, Math.max(1_000, input.timeoutMs ?? 40_000)));
    const signal = controller.signal;
    let finished = false;
    const onText = input.onText ? (text: string) => {
        if (!finished && !signal.aborted && !input.signal.aborted) input.onText!(text);
    } : undefined;
    const ensureActive = () => {
        if (input.signal.aborted) throw new Error('阅读助手请求已取消');
        if (signal.aborted) throw new Error('阅读助手请求超时');
    };
    const wait = async <T>(work: Promise<T>): Promise<T> => {
        let abort!: () => void;
        const cancelled = new Promise<never>((_, reject) => {
            abort = () => { try { ensureActive(); } catch (error) { reject(error); } };
            if (signal.aborted || input.signal.aborted) abort();
            else signal.addEventListener('abort', abort, {once: true});
        });
        try { return await Promise.race([work, cancelled]); }
        finally { signal.removeEventListener('abort', abort); }
    };
    try {
        ensureActive();
        ledger.append('turn/start', {maxModelCalls, maxTools});
        for (const message of input.history ?? []) {
            if (message.role === 'user') ledger.appendUser(message);
            else if (message.role === 'assistant') ledger.appendAssistant(message);
            else ledger.appendToolResult(message);
        }
        ledger.appendUser({role: 'user', content: input.user});
        let toolCount = 0;
        const callIds = new Set<string>();
        for (let step = 0; step < maxModelCalls; step += 1) {
            ensureActive();
            if (step > 0 && onText) onText('');
            ledger.append('step/start', {step});
            const result = await wait(input.generate({system: input.system, messages: ledger.messagesSnapshot(), tools: input.tools, signal, onText}));
            ensureActive();
            if (result.assistant.role !== 'assistant') throw new Error('模型返回了无效的助手消息');
            if (toolCount + result.toolCalls.length > maxTools) throw new Error('阅读助手工具调用次数已达上限');
            const parts = Array.isArray(result.assistant.content) ? result.assistant.content : [];
            const pending = parts.filter(part => part?.type === 'tool-call');
            if (pending.length !== result.toolCalls.length) throw new Error('模型的工具调用与消息不匹配');
            for (const call of result.toolCalls) {
                if (!call.id || callIds.has(call.id) || !pending.some(part => part.toolCallId === call.id && part.toolName === call.name)) throw new Error('模型的工具调用编号无效或重复');
                if (!input.tools.some(tool => tool.name === call.name)) throw new Error(`不支持的阅读助手工具: ${call.name}`);
                callIds.add(call.id);
            }
            ledger.appendAssistant(result.assistant);
            if (result.toolCalls.length === 0) {
                if (!result.text.trim()) throw new Error('模型已响应，但没有返回可显示的内容');
                ledger.append('step/end', {step, status: 'complete'});
                return {text: result.text.trim(), ledger: ledger.eventsSnapshot()};
            }
            for (const call of result.toolCalls) {
                ensureActive();
                toolCount += 1;
                const output = await wait(input.executeTool!(call, signal));
                ensureActive();
                ledger.appendToolResult({role: 'tool', content: [{type: 'tool-result', toolCallId: call.id, toolName: call.name, output: {type: 'text', value: output}}]});
            }
            ledger.append('step/end', {step, status: 'tools-complete'});
        }
        throw new Error('模型请求次数已达上限，请缩短问题后重试');
    } finally {
        finished = true;
        controller.abort();
        clearTimeout(timer);
        input.signal.removeEventListener('abort', relayAbort);
    }
}
