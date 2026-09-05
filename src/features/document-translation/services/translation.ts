/**
 * @file src/features/document-translation/services/translation.ts
 * 文件职责：编排文档片段的批量翻译流程，在固定语言和服务快照下按数量及字符预算拆批，并向调用方持续报告确定性进度。
 * 主要内容：定义进度与逐段提交契约，复用已有译文继续未完成片段，提供文件解析所有权，固定文件级上下文，校验批次结果并阻止取消和失败后的迟到提交。
 * 模块边界：该层不解析文件、不持久化配置，也不直接绑定具体 provider；上层负责冻结用户设置并注入 gateway，文档结构由 core 提供，网络和缓存语义由应用翻译客户端承担。
 */
import type {DocumentSegment} from '@/src/features/document-translation/core/document';

export interface DocumentTranslationProgress {
    completed: number;
    total: number;
}

export interface DocumentTranslationOptions {
    glossaryIds?: readonly string[] | null;
    glossaryRevision?: string;
    fileName: string;
    pageContext?: string;
    serviceOverride?: string;
    modelOverride?: string;
    sourceLanguage?: string;
    targetLanguage?: string;
    signal?: AbortSignal;
    maxRetries?: number;
    /** 同一文档和设置下已完成或人工校订的译文；空白位置继续翻译。 */
    initialTranslations?: readonly string[];
    onSegment?: (segment: {id: number; translation: string}) => void;
    onProgress?: (progress: DocumentTranslationProgress) => void;
}

export interface DocumentTranslationRequestOptions {
    glossaryIds?: readonly string[] | null;
    glossaryRevision?: string;
    glossaryContext?: 'document';
    signal?: AbortSignal;
    pageContext: string;
    serviceOverride?: string;
    modelOverride?: string;
    sourceLanguage?: string;
    targetLanguage?: string;
    maxRetries?: number;
}

/**
 * 文档翻译只依赖这一组端口，不读取 WXT storage 或具体 provider。
 * 入口层负责把当前配置、批量能力和翻译客户端注入进来。
 */
export interface DocumentTranslationGateway {
    getGlossaryOptions?(): {glossaryIds?: readonly string[] | null; glossaryRevision?: string};
    waitUntilReady(): PromiseLike<unknown> | unknown;
    getDefaultService(): string;
    supportsBatch(service: string): boolean;
    translateText(
        source: string,
        context: string,
        options: DocumentTranslationRequestOptions,
    ): Promise<string>;
    translateTextBatch(
        sources: string[],
        context: string,
        options: DocumentTranslationRequestOptions,
    ): Promise<string[]>;
}

export type TranslateDocumentSegments = (
    segments: readonly DocumentSegment[],
    options: DocumentTranslationOptions,
) => Promise<string[]>;

export interface DocumentFileLoadRequest {
    /** 旧解析 Promise 完成时必须再次检查，只有当前请求可以提交页面状态。 */
    isCurrent(): boolean;
}

export interface DocumentFileLoadGuard {
    begin(): DocumentFileLoadRequest;
    invalidate(): void;
}

/**
 * 为无法真正中止的 PDF/ePub/DOCX 解析提供最新请求所有权。
 * 新文件或页面重置会推进代次，旧解析仍可自然结束，但不能覆盖较新的文档。
 */
export function createDocumentFileLoadGuard(): DocumentFileLoadGuard {
    let generation = 0;
    return {
        begin() {
            const requestGeneration = ++generation;
            return {isCurrent: () => requestGeneration === generation};
        },
        invalidate() {
            generation += 1;
        },
    };
}

const BATCH_ITEM_LIMIT = 16;
const BATCH_CHARACTER_LIMIT = 3_500;

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        const error = new Error('文档翻译已取消');
        error.name = 'AbortError';
        throw error;
    }
}

function splitBatches(segments: readonly DocumentSegment[]): DocumentSegment[][] {
    const batches: DocumentSegment[][] = [];
    let current: DocumentSegment[] = [];
    let currentCharacters = 0;

    segments.forEach((segment) => {
        const nextCharacters = currentCharacters + segment.source.length;
        if (current.length > 0 && (current.length >= BATCH_ITEM_LIMIT || nextCharacters > BATCH_CHARACTER_LIMIT)) {
            batches.push(current);
            current = [];
            currentCharacters = 0;
        }
        current.push(segment);
        currentCharacters += segment.source.length;
    });

    if (current.length > 0) batches.push(current);
    return batches;
}

function buildDocumentContext(segments: readonly DocumentSegment[], fileName: string, supplied?: string): string {
    if (supplied?.trim()) return supplied.trim().slice(0, 4_000);
    const preview = segments
        .slice(0, 24)
        .map((segment) => segment.source)
        .join('\n')
        .trim();
    return `Document: ${fileName}\n${preview}`.slice(0, 4_000);
}

export function createDocumentSegmentTranslator(
    gateway: DocumentTranslationGateway,
): TranslateDocumentSegments {
    return async (segments, options) => {
        await gateway.waitUntilReady();
        throwIfAborted(options.signal);
        const glossary = gateway.getGlossaryOptions?.();
        const selectedGlossaryIds = options.glossaryIds ?? glossary?.glossaryIds;
        const glossaryOptions = {
            glossaryContext: 'document' as const,
            glossaryIds: selectedGlossaryIds ? [...selectedGlossaryIds] : selectedGlossaryIds,
            glossaryRevision: options.glossaryRevision ?? glossary?.glossaryRevision,
        };

        if (segments.length === 0) return [];
        const translations = new Array<string>(segments.length).fill('');
        segments.forEach(({id}) => { translations[id] = options.initialTranslations?.[id] || ''; });
        const pending = segments.filter(({id}) => !translations[id].trim());
        const context = options.fileName || 'FluentRead 文档';
        const pageContext = buildDocumentContext(segments, context, options.pageContext);
        // 步骤 1：一次文档任务固定语言对，不能被设置页同步更新或用户中途改选污染后续批次。
        const sourceLanguage = options.sourceLanguage;
        const targetLanguage = options.targetLanguage;
        let completed = segments.length - pending.length;
        const reportProgress = () => options.onProgress?.({completed, total: segments.length});
        const commit = (id: number, translation: string) => {
            translations[id] = translation;
            completed += 1;
            options.onSegment?.({id, translation});
        };
        reportProgress();

        const service = options.serviceOverride || gateway.getDefaultService();
        if (gateway.supportsBatch(service)) {
            for (const batch of splitBatches(pending)) {
                throwIfAborted(options.signal);
                try {
                    const result = await gateway.translateTextBatch(
                        batch.map((segment) => segment.source),
                        context,
                        {
                            ...glossaryOptions,
                            signal: options.signal,
                            pageContext,
                            serviceOverride: options.serviceOverride,
                            modelOverride: options.modelOverride,
                            sourceLanguage,
                            targetLanguage,
                            maxRetries: options.maxRetries,
                        },
                    );
                    throwIfAborted(options.signal);
                    if (result.length !== batch.length || result.some((value) => typeof value !== 'string' || !value.trim())) {
                        throw new Error('翻译服务返回的片段不完整，请重试');
                    }
                    result.forEach((translation, index) => commit(batch[index].id, translation));
                    reportProgress();
                } catch (error) {
                    throwIfAborted(options.signal);
                    throw new Error(`第 ${batch[0].id + 1} 段文档翻译失败：${getErrorMessage(error)}`);
                }
            }
            return translations;
        }

        let nextIndex = 0;
        let stopped = false;
        const workerCount = Math.min(3, pending.length);
        const worker = async () => {
            while (true) {
                throwIfAborted(options.signal);
                const index = nextIndex;
                nextIndex += 1;
                if (index >= pending.length) return;
                const segment = pending[index];

                try {
                    const translation = await gateway.translateText(segment.source, context, {
                        ...glossaryOptions,
                        signal: options.signal,
                        pageContext,
                        serviceOverride: options.serviceOverride,
                        modelOverride: options.modelOverride,
                        sourceLanguage,
                        targetLanguage,
                        maxRetries: options.maxRetries,
                    });
                    // Promise.all 会在首个 worker 失败时立即 reject；其余在途请求仍会稍后结束。
                    // 步骤 1：失败后不再上报过期进度，也不继续认领新的文档片段。
                    if (stopped) return;
                    throwIfAborted(options.signal);
                    if (typeof translation !== 'string' || !translation.trim()) throw new Error('翻译服务返回空译文，请重试');
                    commit(segment.id, translation);
                    reportProgress();
                } catch (error) {
                    if (stopped) return;
                    stopped = true;
                    if (options.signal?.aborted) throwIfAborted(options.signal);
                    throw new Error(`第 ${segment.id + 1} 段文档翻译失败：${getErrorMessage(error)}`);
                }
            }
        };

        await Promise.all(Array.from({length: workerCount}, () => worker()));
        return translations;
    };
}
