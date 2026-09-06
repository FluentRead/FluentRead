/**
 * @file src/features/writing-assistant/background.ts
 * 文件职责：为写作流建立来源校验、请求限额与取消所有权。
 * 主要内容：每个端口只接收一个有界请求，配置、导航、断连、超时后阻止迟到输出。
 * 模块边界：不读密钥或浏览器全局；由应用层注入配置就绪、资格和生成函数。
 */
import {z} from 'zod';
import {WRITING_ACTIONS, WRITING_LANGUAGES, WRITING_TONES, WRITING_LENGTHS} from '@/src/core/config/writing';
import type {WritingRequest, WritingResponse, WritingProgress, WritingStreamMessage} from './types';

export interface WritingSender {id?: string; url?: string; documentId?: string; tab?: {id?: number; url?: string}; frameId?: number}
export interface WritingPort {
    name: string; sender?: WritingSender;
    onMessage: {addListener(fn: (message: unknown) => void): void; removeListener(fn: (message: unknown) => void): void};
    onDisconnect: {addListener(fn: () => void): void; removeListener(fn: () => void): void};
    postMessage(message: WritingStreamMessage): void;
}
const requestSchema = z.object({
    type: z.literal('fluentReadWriting'), action: z.literal('run'), requestId: z.string().regex(/^[\w.:-]{1,128}$/u),
    intent: z.string().refine(value => WRITING_ACTIONS.some(item => item.id === value)),
    instruction: z.string().max(2000), draft: z.string().max(12000), context: z.string().max(12000),
    language: z.string().refine(value => WRITING_LANGUAGES.some(item => item.value === value)),
    tone: z.string().refine(value => WRITING_TONES.some(item => item.value === value)),
    length: z.string().refine(value => WRITING_LENGTHS.some(item => item.value === value)).default('auto'),
    history: z.array(z.object({question: z.string().max(2000), answer: z.string().max(12000)}).strict()).max(4),
}).strict();
export const parseWritingRequest = (value: unknown): WritingRequest | null => {
    const parsed = requestSchema.safeParse(value);
    return parsed.success ? parsed.data as WritingRequest : null;
};
export function createWritingHandler(deps: {
    extensionId: string; optionsUrl: string; ready: Promise<unknown>;
    eligibility(sender: WritingSender): string | undefined;
    run(request: WritingRequest, signal: AbortSignal, progress: (value: WritingProgress) => void): Promise<WritingResponse>;
}) {
    const active = new Set<{sender: WritingSender; cancel(): void}>();
    return {
        cancelAll() { for (const entry of [...active]) entry.cancel(); },
        cancelTab(tabId: number) { for (const entry of [...active]) if (entry.sender.tab?.id === tabId) entry.cancel(); },
        connect(port: WritingPort) {
            if (port.name !== 'fluentReadWritingStream') return;
            const sender = port.sender ?? {};
            const trusted = sender.id === deps.extensionId && (
                sender.url?.split(/[?#]/u)[0] === deps.optionsUrl
                || (Number.isSafeInteger(sender.tab?.id) && sender.tab!.id! >= 0 && /^https?:\/\//u.test(sender.url ?? '')));
            let finished = false;
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
            const disconnect = () => { controller.abort(); cleanup(); };
            const entry = {sender, cancel() { controller.abort(); finish({success: false, error: '已停止生成', cancelled: true}); }};
            const onMessage = (raw: unknown) => {
                if (started || finished) return;
                started = true;
                if (raw && typeof raw === 'object' && 'requestId' in raw && typeof raw.requestId === 'string') requestId = raw.requestId.slice(0, 128);
                const request = parseWritingRequest(raw);
                if (!trusted || !request) { finish({success: false, error: '无效的写作请求'}); return; }
                if (active.size >= 4) { finish({success: false, error: '正在处理其他写作请求，请稍后重试'}); return; }
                // 同一 document 的新面板替换旧请求，其他页面互不影响。
                for (const other of [...active]) if (JSON.stringify(other.sender) === JSON.stringify(sender)) other.cancel();
                active.add(entry);
                timer = setTimeout(() => { controller.abort(); finish({success: false, error: '生成超时，请重试'}); }, 60000);
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
                        });
                        if (deps.eligibility(sender)) entry.cancel(); else finish(response);
                    } catch { finish({success: false, error: '生成未完成，请重试'}); }
                })();
            };
            port.onMessage.addListener(onMessage); port.onDisconnect.addListener(disconnect);
        },
    };
}
