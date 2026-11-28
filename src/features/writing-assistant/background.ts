/**
 * @file src/features/writing-assistant/background.ts
 * 文件职责：为写作流建立来源校验、请求限额与取消所有权。
 * 主要内容：每个端口只接收一个有界请求，向后台传递可信发送者以隔离隐私窗口，配置、导航、断连、超时后阻止迟到输出。
 * 模块边界：不读密钥或浏览器全局；由应用层注入配置就绪、资格和生成函数。
 */
import {isProtocolInputObject} from '@/src/core/messaging/validation';
import {WRITING_ACTIONS, WRITING_LENGTHS, WRITING_SITES, WRITING_STYLES, WRITING_ROLE_MAX_LENGTH, WRITING_TONE_MAX_LENGTH, isWritingLanguage, normalizeWritingLanguage, normalizeWritingLength} from '@/src/core/config/writing';
import type {WritingRequest, WritingResponse, WritingProgress, WritingStreamMessage} from './types';

export interface WritingSender {id?: string; url?: string; documentId?: string; tab?: {id?: number; url?: string; incognito?: boolean}; frameId?: number}
export interface WritingPort {
    name: string; sender?: WritingSender;
    onMessage: {addListener(fn: (message: unknown) => void): void; removeListener(fn: (message: unknown) => void): void};
    onDisconnect: {addListener(fn: () => void): void; removeListener(fn: () => void): void};
    postMessage(message: WritingStreamMessage): void;
}
const REQUEST_KEYS = new Set([
    'type', 'action', 'requestId', 'intent', 'instruction', 'draft', 'context',
    'language', 'tone', 'length', 'style', 'role', 'site', 'history',
]);
const REQUEST_ID_PATTERN = /^[\w.:-]{1,128}$/u;
const CONTROL_CHAR_FREE_PATTERN = /^[^\u0000-\u001f\u007f]*$/u;
// Keep the transport's UTF-16 code-unit limits without pulling a schema compiler into background.
const isBoundedText = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit;
const parseBoundedLabel = (value: unknown, limit: number): string | null => {
    if (!isBoundedText(value, limit) || !CONTROL_CHAR_FREE_PATTERN.test(value)) return null;
    const trimmed = value.trim();
    return trimmed.length >= 1 ? trimmed : null;
};
export const parseWritingRequest = (value: unknown): WritingRequest | null => {
    if (!isProtocolInputObject(value)) return null;
    for (const key in value) if (!REQUEST_KEYS.has(key)) return null;
    if (value.type !== 'fluentReadWriting' || value.action !== 'run') return null;
    if (typeof value.requestId !== 'string' || !REQUEST_ID_PATTERN.test(value.requestId)) return null;
    if (typeof value.intent !== 'string' || !WRITING_ACTIONS.some(item => item.id === value.intent)) return null;
    if (!isBoundedText(value.instruction, 2000) || !isBoundedText(value.draft, 12000) || !isBoundedText(value.context, 12000)) return null;
    if (!isBoundedText(value.language, 32) || !isWritingLanguage(value.language)) return null;
    const tone = parseBoundedLabel(value.tone, WRITING_TONE_MAX_LENGTH);
    if (!tone) return null;
    const rawLength = value.length === undefined ? 'short' : value.length;
    if (typeof rawLength !== 'string' || (rawLength !== 'auto' && !WRITING_LENGTHS.some(item => item.value === rawLength))) return null;
    const style = value.style === undefined ? 'auto' : value.style;
    if (typeof style !== 'string' || !WRITING_STYLES.some(item => item.value === style)) return null;
    const role = value.role === undefined ? 'auto' : parseBoundedLabel(value.role, WRITING_ROLE_MAX_LENGTH);
    if (!role) return null;
    if (value.site !== undefined && (typeof value.site !== 'string' || !WRITING_SITES.some(item => item === value.site))) return null;
    if (!Array.isArray(value.history) || value.history.length > 4) return null;
    const history: Array<{question: string; answer: string}> = [];
    for (const entry of value.history) {
        if (!isProtocolInputObject(entry)) return null;
        for (const key in entry) if (key !== 'question' && key !== 'answer') return null;
        if (!isBoundedText(entry.question, 2000) || !isBoundedText(entry.answer, 12000)) return null;
        history.push({question: entry.question, answer: entry.answer});
    }
    return {
        type: 'fluentReadWriting', action: 'run', requestId: value.requestId,
        intent: value.intent as WritingRequest['intent'],
        instruction: value.instruction, draft: value.draft, context: value.context,
        language: normalizeWritingLanguage(value.language), tone,
        length: normalizeWritingLength(rawLength),
        style: style as WritingRequest['style'], role,
        ...(value.site !== undefined ? {site: value.site as WritingRequest['site']} : {}),
        history,
    };
};
export function createWritingHandler(deps: {
    extensionId: string; optionsUrl: string; ready: Promise<unknown>;
    eligibility(sender: WritingSender): string | undefined;
    run(request: WritingRequest, signal: AbortSignal, progress: (value: WritingProgress) => void, sender: WritingSender): Promise<WritingResponse>;
}) {
    const active = new Set<{sender: WritingSender; owner: string; request: WritingRequest | undefined; cancel(mayRecover?: () => boolean): void}>();
    return {
        cancelAll(predicate?: (request: WritingRequest) => boolean, mayRecover?: () => boolean) {
            for (const entry of [...active]) if (!predicate || predicate(entry.request!)) entry.cancel(mayRecover);
        },
        cancelTab(tabId: number) { for (const entry of [...active]) if (entry.sender.tab?.id === tabId) entry.cancel(); },
        connect(port: WritingPort) {
            if (port.name !== 'fluentReadWritingStream') return;
            const sender = port.sender ?? {};
            const owner = JSON.stringify([sender.tab?.id ?? null, sender.frameId ?? 0, sender.documentId ?? sender.url ?? '']);
            const trusted = sender.id === deps.extensionId && (
                sender.url?.split(/[?#]/u)[0] === deps.optionsUrl
                || (Number.isSafeInteger(sender.tab?.id) && sender.tab!.id! >= 0 && /^https?:\/\//u.test(sender.url ?? '')));
            let finished = false;
            let cancelling = false;
            let started = false;
            let requestId = '';
            const controller = new AbortController();
            let timer: ReturnType<typeof setTimeout>;
            const cleanup = () => {
                finished = true; clearTimeout(timer); active.delete(entry);
                port.onMessage.removeListener(onMessage); port.onDisconnect.removeListener(disconnect);
            };
            const post = (value: WritingStreamMessage) => { try { port.postMessage(value); } catch { disconnect(); } };
            const finish = (response: WritingResponse) => {
                if (finished) return;
                post({type: 'result', requestId, response}); cleanup();
            };
            const disconnect = () => { cancelling = true; controller.abort(); cleanup(); };
            const entry = {sender, owner, request: undefined as WritingRequest | undefined, cancel(mayRecover?: () => boolean) {
                if (finished || cancelling) return;
                cancelling = true;
                controller.abort();
                let recover = false;
                try {recover = Boolean(mayRecover && entry.request?.intent === 'translate' && !deps.eligibility(sender) && mayRecover());} catch { /* 无法确认所有权时不重试。 */ }
                finish({success: false, error: '已停止生成', cancelled: true,
                    ...(recover ? {reason: 'configuration-changed' as const} : {})});
            }};
            const onMessage = (raw: unknown) => {
                if (started || finished) return;
                started = true;
                if (raw && typeof raw === 'object' && 'requestId' in raw && typeof raw.requestId === 'string') requestId = raw.requestId.slice(0, 128);
                const request = parseWritingRequest(raw);
                if (!trusted || !request) { finish({success: false, error: '无效的写作请求'}); return; }
                entry.request = request;
                // 同一 document 的新面板替换旧请求，其他页面互不影响。
                for (const other of [...active]) if (other.owner === owner) other.cancel();
                if (active.size >= 4) { finish({success: false, error: '正在处理其他写作请求，请稍后重试'}); return; }
                active.add(entry);
                timer = setTimeout(() => { cancelling = true; controller.abort(); finish({success: false, error: '生成超时，请重试'}); }, 60000);
                void (async () => {
                    try {
                        await deps.ready;
                        if (finished) return;
                        const blocked = deps.eligibility(sender);
                        if (blocked) { finish({success: false, error: blocked}); return; }
                        const response = await deps.run(request, controller.signal, progress => {
                            if (finished) return;
                            if (deps.eligibility(sender)) { entry.cancel(); return; }
                            post({type: 'progress', requestId, progress});
                        }, sender);
                        if (deps.eligibility(sender)) entry.cancel(); else finish(response);
                    } catch { finish({success: false, error: '生成未完成，请重试'}); }
                })();
            };
            port.onMessage.addListener(onMessage); port.onDisconnect.addListener(disconnect);
        },
    };
}
