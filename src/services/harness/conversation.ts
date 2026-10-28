/**
 * @file src/services/harness/conversation.ts
 * 文件职责：协调阅读请求、流式正文与最近三十天会话的持久化，恢复时以后台保存的问答为准。
 * 主要内容：签发会话和问答标识，按可见回答锚点校验并恢复同动作的真实追问上下文；独立分析动作共享记录但不携带旧回答，节流保存并隔离隐私窗口、删除代次和存储失败。
 * 模块边界：只依赖注入的模型运行器及会话仓库接口，不访问浏览器、网页、密钥或具体 IndexedDB。
 */
import {HARNESS_ACTIONS, type HarnessPreferences} from '@/src/core/config/harness';
import type {ReadingProgress, ReadingRequest, ReadingResponse} from '@/src/features/reading-assistant/types';
import type {HarnessRuntime} from './runtime';
import type {HarnessSession, HarnessSessionStore, HarnessStoredTurn} from './sessionTypes';
import {truncateUtf16} from '@/src/shared/function/truncateUtf16';

interface ConversationDependencies {
    runtime: HarnessRuntime;
    store: HarnessSessionStore;
    preferences(): Pick<HarnessPreferences, 'contextMode' | 'maxContextChars'>;
    now?: () => number;
    id?: () => string;
}
const SAVE_WARNING = '本次会话未能保存，仍可继续阅读。请稍后检查本机存储。';
const CANCELLED: ReadingResponse = {success: false, error: '已停止理解', cancelled: true};
const INVALID_ANCHOR: ReadingResponse = {success: false, error: '当前回答已过期或不属于这个学习动作，请重新生成后追问'};
const clip = (value: unknown, limit: number) => typeof value === 'string' ? truncateUtf16(value.trim(), limit) : '';

export function createHarnessConversationRuntime(deps: ConversationDependencies) {
    const now = deps.now ?? Date.now;
    const id = deps.id ?? (() => crypto.randomUUID());
    return {
        async run(request: ReadingRequest, signal: AbortSignal, onProgress?: (progress: ReadingProgress) => void, privateContext = false): Promise<ReadingResponse> {
            if (signal.aborted) return CANCELLED;
            if (privateContext && request.sessionId) return {success: false, error: '隐私窗口不读取已保存的会话'};
            if (request.anchorTurnId !== undefined && !request.sessionId) return INVALID_ANCHOR;
            const question = clip(request.question, 1000);
            const notify = (progress: ReadingProgress) => {
                try { onProgress?.(progress); } catch { /* 页面断开不影响最后一份回答落盘。 */ }
            };
            // 读取快照期间也可能发生删除，恢复请求必须沿用读取开始前的代次。
            const restoredGeneration = request.sessionId ? deps.store.captureGeneration(request.sessionId) : undefined;
            let previous: HarnessSession | null = null;
            let historyTurns: HarnessStoredTurn[] = [];
            if (request.sessionId) {
                try { previous = await deps.store.get(request.sessionId); }
                catch { return {success: false, error: '暂时无法读取会话，请稍后重试'}; }
                if (!previous) return {success: false, error: '此会话已删除或超过三十天，请开始新的阅读'};
                historyTurns = previous.turns;
                if (question && request.anchorTurnId !== undefined) {
                    const anchorIndex = previous.turns.findIndex(turn => turn.id === request.anchorTurnId && turn.intent === request.intent);
                    if (anchorIndex < 0) return INVALID_ANCHOR;
                    historyTurns = previous.turns.slice(0, anchorIndex + 1).filter(turn => turn.intent === request.intent);
                }
            }
            if (signal.aborted) return CANCELLED;
            const preferences = deps.preferences();
            const timestamp = now();
            const text = previous?.text ?? clip(request.selection.text, 4096);
            const context = previous?.context ?? (preferences.contextMode === 'paragraph' ? clip(request.selection.context, preferences.maxContextChars) : '');
            if (!text) return {success: false, error: '没有可理解的选中文本'};
            const session: Omit<HarnessSession, 'turns'> = {
                id: previous?.id ?? id(), text, context,
                createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp, intent: request.intent,
            };
            const turn: HarnessStoredTurn = {
                id: id(), question: question || HARNESS_ACTIONS.find(action => action.id === request.intent)!.label,
                answer: '', intent: request.intent, status: 'streaming', createdAt: timestamp, service: '', model: '',
            };
            let persistent = !privateContext;
            let warning: string | undefined;
            const generation = privateContext ? undefined : restoredGeneration ?? deps.store.captureGeneration(session.id);
            let pending = Promise.resolve();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const persistenceFailed = () => {
                persistent = false;
                warning = SAVE_WARNING;
                notify({kind: 'session', persistent: false, warning});
            };
            const save = () => {
                if (!persistent) return pending;
                const snapshot = {...turn};
                pending = pending.then(async () => {
                    if (!persistent) return;
                    const saved = await deps.store.upsertTurn(session, snapshot, generation!);
                    if (!saved) persistenceFailed();
                }).catch(persistenceFailed);
                return pending;
            };
            await save();
            notify({kind: 'session', ...(persistent ? {sessionId: session.id, turnId: turn.id} : {}), persistent, warning});
            if (signal.aborted) {
                turn.status = 'stopped';
                await save();
                return CANCELLED;
            }
            // 切换学习动作仍保存到同一条阅读记录，但不能把旧回答混入新的原文分析。
            const history = !question ? [] : previous ? historyTurns.filter(entry => entry.answer.trim()).slice(-4).map(entry => ({
                question: entry.question,
                answer: entry.status === 'completed' ? entry.answer : `[上次回答未完成，以下为已生成部分]\n${entry.answer}`,
            })) : request.history;
            const restoredRequest: ReadingRequest = {
                ...request, question, selection: {text, context: preferences.contextMode === 'paragraph' ? context : '', sentence: ''}, history,
            };
            let finished = false;
            const publish = (progress: ReadingProgress) => {
                if (finished || signal.aborted) return;
                if (progress.kind === 'text') turn.answer = truncateUtf16(progress.text, 16000);
                if (progress.kind === 'model') { turn.service = progress.service; turn.model = progress.model; }
                notify(progress);
                if (persistent && !timer) timer = setTimeout(() => { timer = undefined; void save(); }, 500);
            };
            let response: ReadingResponse;
            try { response = await deps.runtime.run(restoredRequest, signal, publish, privateContext); }
            catch { response = {success: false, error: '理解请求未完成，请重试'}; }
            finished = true;
            clearTimeout(timer);
            if (signal.aborted) response = CANCELLED;
            turn.status = response.success ? 'completed' : response.cancelled ? 'stopped' : 'error';
            if (response.success) { turn.answer = response.text; turn.service = response.service; turn.model = response.model; }
            await save();
            return response.success ? {
                ...response, ...(persistent ? {sessionId: session.id, turnId: turn.id} : {}), ...(warning ? {persistenceWarning: warning} : {}),
            } : response;
        },
    };
}
