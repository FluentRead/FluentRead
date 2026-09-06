/**
 * @file src/platform/offscreen/client.ts
 *
 * 文件职责：统一管理扩展自有 DOM 的创建、复用与消息发送，为 OCR、内置翻译和音频等后台能力提供基础设施客户端。
 * 主要内容：定义 runtime/document 依赖端口和 OffscreenClient，createOffscreenClient 串行创建文档、等待接收端 ready 握手，并在接收端丢失时受控重建一次，默认 chromeOffscreenClient 连接浏览器 API。 可核对的公开符号包括 OffscreenMessage、OffscreenMessageEnvelope、OffscreenRuntimeApi、OffscreenDocumentApi、OffscreenClientDependencies、OffscreenClient、createOffscreenClient、chromeOffscreenClient。
 * 模块边界：只封装文档生命周期与消息可靠性；默认连接 Chrome Offscreen，Firefox 注入文档容器与查询端口，不复制任务调度或业务逻辑。
 */

export interface OffscreenMessage {
    readonly type: string;
    readonly [field: string]: unknown;
}

export const OFFSCREEN_READY_MESSAGE_TYPE = 'FLUENT_READ_OFFSCREEN_READY' as const;
export const OFFSCREEN_CANCEL_CHROME_TRANSLATION_MESSAGE_TYPE = 'CANCEL_CHROME_TRANSLATE_OFFSCREEN' as const;
export const OFFSCREEN_CANCEL_IMAGE_OPERATION_MESSAGE_TYPE = 'CANCEL_IMAGE_OPERATION_OFFSCREEN' as const;

export type OffscreenMessageEnvelope<TMessage extends OffscreenMessage> = TMessage & {
    readonly target: 'offscreen';
};

export interface OffscreenRuntimeApi {
    readonly lastError?: {readonly message?: string};
    getContexts?(filter: {contextTypes: ['OFFSCREEN_DOCUMENT']}): Promise<unknown[]>;
    sendMessage(
        message: unknown,
        callback: (response: unknown) => void,
    ): void;
}

export interface OffscreenDocumentApi {
    createDocument(options: {
        url: string;
        reasons: string[];
        justification: string;
    }): Promise<void>;
    closeDocument?(): Promise<void>;
}

export interface OffscreenClientDependencies {
    readonly getRuntime: () => OffscreenRuntimeApi;
    readonly getOffscreen: () => OffscreenDocumentApi | undefined;
    /** 替代文档容器的查询端口；未提供时使用 Chrome runtime.getContexts。 */
    readonly getDocumentContexts?: () => Promise<unknown[]>;
    readonly documentUrl?: string;
    readonly readyRetryAttempts?: number;
    readonly readyRetryDelay?: () => Promise<void>;
    readonly preparationTimeoutMs?: number;
    readonly messageTimeoutMs?: number;
}

export interface OffscreenSendOptions {
    /** AbortSignal 只留在后台进程，绝不能进入 runtime message 的结构化克隆边界。 */
    readonly signal?: AbortSignal;
    /** 整次 prepare/rebuild/send 共用的相对预算，client 会在入口换算成绝对截止时间。 */
    readonly timeoutMs?: number;
    /** 请求取消或超时时尽力发送的纯数据清理消息。 */
    readonly cancelMessage?: OffscreenMessage;
}

export interface OffscreenClient {
    hasDocument(): Promise<boolean>;
    ensureDocument(options?: Omit<OffscreenSendOptions, 'cancelMessage'>): Promise<void>;
    send<
        TResponse,
        TMessage extends OffscreenMessage = OffscreenMessage & Readonly<Record<string, unknown>>,
    >(message: TMessage, options?: OffscreenSendOptions): Promise<TResponse>;
    sendIfPresent<
        TResponse,
        TMessage extends OffscreenMessage = OffscreenMessage & Readonly<Record<string, unknown>>,
    >(
        message: TMessage,
        options?: Omit<OffscreenSendOptions, 'cancelMessage'>,
    ): Promise<TResponse | undefined>;
}

const DEFAULT_PREPARATION_TIMEOUT_MS = 10_000;
const MAX_OFFSCREEN_TIMEOUT_MS = 300_000;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isMissingReceiverError(error: unknown): boolean {
    const message = errorMessage(error);
    return message.includes('Receiving end does not exist')
        || message.includes('Could not establish connection');
}

function normalizeTimeoutMs(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(MAX_OFFSCREEN_TIMEOUT_MS, Math.max(1, Math.floor(value)));
}

function createAbortError(): Error {
    const error = new Error('Offscreen 请求已取消');
    error.name = 'AbortError';
    return error;
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw createAbortError();
}

/** 原生 Offscreen 与 Firefox 后台容器共享的生命周期和 callback 消息客户端。 */
export function createOffscreenClient(dependencies: OffscreenClientDependencies): OffscreenClient {
    type DocumentPreparationResult = {createdDocument: boolean};
    let preparingDocument: {
        forceRecreate: boolean;
        promise: Promise<DocumentPreparationResult>;
    } | null = null;
    const readyRetryAttempts = Math.max(1, Math.floor(dependencies.readyRetryAttempts ?? 40));
    const readyRetryDelay = dependencies.readyRetryDelay
        ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
    const preparationTimeoutMs = normalizeTimeoutMs(
        dependencies.preparationTimeoutMs,
        DEFAULT_PREPARATION_TIMEOUT_MS,
    );
    const messageTimeoutMs = dependencies.messageTimeoutMs === undefined
        ? undefined
        : normalizeTimeoutMs(dependencies.messageTimeoutMs, MAX_OFFSCREEN_TIMEOUT_MS);

    const runWithinDeadline = <T>(
        operation: () => Promise<T>,
        deadlineAt: number | undefined,
        timeoutMessage: string,
        signal?: AbortSignal,
        onCancel?: () => void,
    ): Promise<T> => new Promise((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
            if (timer !== undefined) clearTimeout(timer);
            signal?.removeEventListener('abort', handleAbort);
        };
        const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback();
        };
        const cancel = (error: Error) => finish(() => {
            onCancel?.();
            reject(error);
        });
        const handleAbort = () => cancel(createAbortError());

        if (signal?.aborted) {
            handleAbort();
            return;
        }
        if (deadlineAt !== undefined) {
            const remainingMs = deadlineAt - Date.now();
            if (remainingMs <= 0) {
                cancel(new Error(timeoutMessage));
                return;
            }
            timer = setTimeout(() => cancel(new Error(timeoutMessage)), remainingMs);
        }
        signal?.addEventListener('abort', handleAbort, {once: true});
        try {
            void operation().then(
                (value) => finish(() => resolve(value)),
                (error) => finish(() => reject(error)),
            );
        } catch (error) {
            finish(() => reject(error));
        }
    });

    const getExistingContexts = async (): Promise<unknown[]> => {
        if (dependencies.getDocumentContexts) return dependencies.getDocumentContexts();
        const getContexts = dependencies.getRuntime().getContexts;
        if (typeof getContexts !== 'function') {
            throw new Error('当前浏览器不支持查询 Offscreen 文档');
        }
        return getContexts.call(dependencies.getRuntime(), {contextTypes: ['OFFSCREEN_DOCUMENT']});
    };

    const hasDocumentWithoutDeadline = async (): Promise<boolean> => {
        const runtime = dependencies.getRuntime();
        if (!dependencies.getOffscreen()
            || (!dependencies.getDocumentContexts && typeof runtime.getContexts !== 'function')) return false;
        const contexts = await getExistingContexts();
        return contexts.length > 0;
    };

    const hasDocument = (): Promise<boolean> => runWithinDeadline(
        hasDocumentWithoutDeadline,
        Date.now() + preparationTimeoutMs,
        '查询 Offscreen 文档超时',
    );

    const dispatchMessage = <TResponse, TMessage extends OffscreenMessage>(
        message: TMessage,
    ): Promise<TResponse> => new Promise((resolve, reject) => {
        const runtime = dependencies.getRuntime();
        try {
            runtime.sendMessage({...message, target: 'offscreen'}, (response) => {
                const runtimeError = dependencies.getRuntime().lastError;
                if (runtimeError) {
                    reject(new Error(runtimeError.message || 'Offscreen 消息发送失败'));
                } else {
                    resolve(response as TResponse);
                }
            });
        } catch (error) {
            reject(error);
        }
    });

    const sendWithoutCreating = <TResponse, TMessage extends OffscreenMessage>(
        message: TMessage,
        deadlineAt: number | undefined,
        signal?: AbortSignal,
        onCancel?: () => void,
    ): Promise<TResponse> => runWithinDeadline(
        () => dispatchMessage<TResponse, TMessage>(message),
        deadlineAt,
        'Offscreen 消息响应超时',
        signal,
        onCancel,
    );

    const waitForReceiver = async (signal: AbortSignal, deadlineAt: number): Promise<void> => {
        let lastError: unknown = new Error('Offscreen 文档尚未就绪');
        for (let attempt = 0; attempt < readyRetryAttempts; attempt += 1) {
            try {
                const response = await sendWithoutCreating<{
                    success?: boolean;
                    ready?: boolean;
                }, OffscreenMessage>({type: OFFSCREEN_READY_MESSAGE_TYPE}, deadlineAt, signal);
                if (response?.success === true && response.ready === true) return;
                lastError = new Error('Offscreen 文档未确认接收端就绪');
            } catch (error) {
                if (!isMissingReceiverError(error)) throw error;
                lastError = error;
            }
            if (attempt + 1 < readyRetryAttempts) {
                await runWithinDeadline(readyRetryDelay, deadlineAt, 'Offscreen 文档准备超时', signal);
            }
        }
        throw lastError;
    };

    const prepareDocument = async (
        forceRecreate: boolean,
        signal: AbortSignal,
        deadlineAt: number,
    ): Promise<DocumentPreparationResult> => {
        const offscreen = dependencies.getOffscreen();
        if (!offscreen || typeof offscreen.createDocument !== 'function') {
            throw new Error('当前浏览器不支持扩展 Offscreen 文档');
        }

        const contexts = await getExistingContexts();
        throwIfAborted(signal);
        if (forceRecreate && contexts.length > 0) {
            if (typeof offscreen.closeDocument !== 'function') {
                throw new Error('当前浏览器无法重建失去接收端的 Offscreen 文档');
            }
            await offscreen.closeDocument();
            throwIfAborted(signal);
        }
        const createdDocument = forceRecreate || contexts.length === 0;
        if (createdDocument) {
            await offscreen.createDocument({
                url: dependencies.documentUrl || 'offscreen.html',
                reasons: ['DOM_SCRAPING', 'AUDIO_PLAYBACK', 'WORKERS'],
                justification: 'FluentRead needs an extension-owned DOM for Translation API, OCR, local video transcription workers, and CSP-independent TTS playback',
            });
            throwIfAborted(signal);
        }
        await waitForReceiver(signal, deadlineAt);
        return {createdDocument};
    };

    const runDocumentPreparation = async (
        forceRecreate: boolean,
    ): Promise<DocumentPreparationResult> => {
        const currentPreparation = preparingDocument;
        if (currentPreparation) {
            // 强制重建可以同时满足普通探测，但业务消息丢失接收端后，普通探测绝不能
            // 消耗其重建请求。
            if (!forceRecreate || currentPreparation.forceRecreate) return currentPreparation.promise;
            try {
                const result = await currentPreparation.promise;
                // 如果普通准备流程已经创建并确认新 document，就已完成排队的重建。
                // 再次关闭它可能中断由同一次准备流程释放的调用方。
                if (result.createdDocument) return result;
            } catch {
                // 下方的强制重建会取代已失败的普通就绪探测。
            }
            return runDocumentPreparation(true);
        }

        const controller = new AbortController();
        // 文档准备是共享资源，不能继承首个调用方可能只剩数毫秒的业务预算。
        const deadlineAt = Date.now() + preparationTimeoutMs;
        const promise = runWithinDeadline(
            () => prepareDocument(forceRecreate, controller.signal, deadlineAt),
            deadlineAt,
            'Offscreen 文档准备超时',
            undefined,
            () => controller.abort(),
        ).finally(() => {
            if (preparingDocument?.promise === promise) preparingDocument = null;
        });
        preparingDocument = {forceRecreate, promise};
        return promise;
    };

    const rebuildDocument = async (): Promise<void> => {
        await runDocumentPreparation(true);
    };

    const ensureDocumentWithin = async (
        deadlineAt: number,
        signal?: AbortSignal,
        onCancel?: () => void,
    ): Promise<void> => {
        try {
            await runWithinDeadline(
                () => runDocumentPreparation(false),
                deadlineAt,
                'Offscreen 文档准备超时',
                signal,
                onCancel,
            );
        } catch (error) {
            if (isAbortError(error)) throw error;
            if (!isMissingReceiverError(error)) {
                throw new Error(`无法创建 Offscreen 文档：${errorMessage(error)}`);
            }
            try {
                await runWithinDeadline(
                    rebuildDocument,
                    deadlineAt,
                    'Offscreen 文档准备超时',
                    signal,
                    onCancel,
                );
            } catch (rebuildError) {
                if (isAbortError(rebuildError)) throw rebuildError;
                throw new Error(`无法创建 Offscreen 文档：${errorMessage(rebuildError)}`);
            }
        }
    };

    const ensureDocument = (options: Omit<OffscreenSendOptions, 'cancelMessage'> = {}): Promise<void> => {
        const timeoutMs = normalizeTimeoutMs(options.timeoutMs, preparationTimeoutMs);
        return ensureDocumentWithin(Date.now() + timeoutMs, options.signal);
    };

    const sendCancellation = (message: OffscreenMessage | undefined): void => {
        if (!message) return;
        try {
            dependencies.getRuntime().sendMessage({...message, target: 'offscreen'}, () => {
                // 读取 lastError 可避免 Chrome 为“取消时文档已消失”输出未处理告警。
                void dependencies.getRuntime().lastError;
            });
        } catch {
            // 取消消息是尽力而为；调用方仍必须按本地 AbortSignal 立即结束等待。
        }
    };

    return {
        hasDocument,
        ensureDocument,
        async send<TResponse, TMessage extends OffscreenMessage>(
            message: TMessage,
            options: OffscreenSendOptions = {},
        ): Promise<TResponse> {
            const timeoutMs = options.timeoutMs === undefined
                ? messageTimeoutMs
                : normalizeTimeoutMs(options.timeoutMs, MAX_OFFSCREEN_TIMEOUT_MS);
            const deadlineAt = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
            const preparationDeadlineAt = deadlineAt ?? Date.now() + preparationTimeoutMs;
            const cancel = () => sendCancellation(options.cancelMessage);
            await ensureDocumentWithin(preparationDeadlineAt, options.signal, cancel);
            try {
                return await sendWithoutCreating<TResponse, TMessage>(message, deadlineAt, options.signal, cancel);
            } catch (error) {
                if (options.signal?.aborted || isAbortError(error)) throw error;
                if (!isMissingReceiverError(error)) throw error;
                const rebuildDeadlineAt = deadlineAt ?? Date.now() + preparationTimeoutMs;
                await runWithinDeadline(
                    rebuildDocument,
                    rebuildDeadlineAt,
                    'Offscreen 文档准备超时',
                    options.signal,
                    cancel,
                );
                return sendWithoutCreating<TResponse, TMessage>(message, deadlineAt, options.signal, cancel);
            }
        },
        async sendIfPresent<TResponse, TMessage extends OffscreenMessage>(
            message: TMessage,
            options: Omit<OffscreenSendOptions, 'cancelMessage'> = {},
        ): Promise<TResponse | undefined> {
            const timeoutMs = options.timeoutMs === undefined
                ? messageTimeoutMs
                : normalizeTimeoutMs(options.timeoutMs, MAX_OFFSCREEN_TIMEOUT_MS);
            const deadlineAt = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
            const lookupDeadlineAt = deadlineAt ?? Date.now() + preparationTimeoutMs;
            const present = await runWithinDeadline(
                hasDocumentWithoutDeadline,
                lookupDeadlineAt,
                '查询 Offscreen 文档超时',
                options.signal,
            );
            if (!present) return undefined;
            return sendWithoutCreating<TResponse, TMessage>(message, deadlineAt, options.signal);
        },
    };
}

export const chromeOffscreenClient = createOffscreenClient({
    getRuntime: () => chrome.runtime as OffscreenRuntimeApi,
    getOffscreen: () => chrome.offscreen as unknown as OffscreenDocumentApi | undefined,
});
