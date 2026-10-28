/**
 * @file src/features/vocabulary/background/handler.ts
 * 文件职责：实现本地学习收藏的后台消息处理器，对查询、收藏、解释更新、复习、撤销删除、列表、导入导出和清空进行严格输入校验与统一错误映射。
 * 主要内容：定义仓库和广播依赖，构造词书变更协议及兼容共享网页接收者端口的广播适配器，创建变更 ACK、主业务 handler 和组合 handlers，成功写操作后通知接收者。
 * 模块边界：本文件不直接操作 Dexie 表或 Vue UI；持久化由 repository contract 注入，消息形状来自 protocol，browser.tabs 广播通过适配器隔离，失败不会泄露内部数据。
 */
import type {BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';
import {reencounterSnapshot, reencounterTerm} from '../domain/reencounter';
import type {VocabularyEntry} from '../learningModel';
import {
    VOCABULARY_BOOK_CHANGED_MESSAGE,
    VOCABULARY_BOOK_MESSAGE,
    type VocabularyBookChangedMessage,
    type VocabularyBookErrorCode,
    type VocabularyBookResponse,
    type VocabularyBookRuntimeMessage,
    type VocabularyExportOptions,
    type VocabularyListOptions,
    type VocabularyScheduledReviewRating,
    type VocabularyUpsertInput,
} from '@/src/features/vocabulary/protocol';

export interface VocabularyBackgroundContext {
    sender?: {
        id?: string;
        url?: string;
        tab?: {
            id?: number;
            incognito?: boolean;
        };
    };
}

export interface VocabularyBookChangedBroadcaster {
    (reason: VocabularyBookChangedMessage['reason'], entryId?: string): void;
}

export interface VocabularyBookChangeBroadcastAdapter {
    broadcastTabMessage?(message: VocabularyBookChangedMessage): Promise<void>;
    sendRuntimeMessage(message: VocabularyBookChangedMessage): Promise<unknown>;
    queryTabs(): Promise<Array<{id?: number}>>;
    sendTabMessage(tabId: number, message: VocabularyBookChangedMessage): Promise<unknown>;
}

export interface VocabularyBookRepositoryContract {
    list(options?: VocabularyListOptions): Promise<unknown>;
    get(entryId: string): Promise<unknown>;
    getByTerm(sourceLanguage: string, term: string): Promise<unknown>;
    upsert(input: VocabularyUpsertInput): Promise<{id: string}>;
    updateNote(entryId: string, note: string): Promise<unknown>;
    review(entryId: string, rating: VocabularyScheduledReviewRating): Promise<unknown>;
    setMastery(entryId: string): Promise<unknown>;
    relearn(entryId: string): Promise<unknown>;
    getReviewLogs(entryId: string): Promise<unknown>;
    remove(entryId: string): Promise<unknown>;
    clear(): Promise<void>;
    exportData(options?: VocabularyExportOptions): Promise<unknown>;
    importData(data: Record<string, unknown>): Promise<unknown>;
}

export interface VocabularyUndoRepositoryContract {
    removeWithUndo(entryId: string): Promise<unknown>;
    listUndo(): Promise<unknown>;
    restoreUndo(undoId: string): Promise<'restored' | 'previously-restored' | 'expired' | 'missing'>;
    discardUndo(undoId: string): Promise<void>;
}

export interface VocabularyBookBackgroundDependencies {
    readonly configReady: Promise<void>;
    readonly isVocabularyBookEnabled: () => boolean;
    readonly isReencounterEnabled?: () => boolean;
    readonly vocabularyBook: VocabularyBookRepositoryContract;
    readonly vocabularyUndo?: VocabularyUndoRepositoryContract;
    readonly broadcastChanged: VocabularyBookChangedBroadcaster;
    readonly logOperationFailure: (error: unknown) => void;
    readonly isTrustedUndoSender?: (sender: VocabularyBackgroundContext['sender']) => boolean;
}

export const VOCABULARY_BOOK_CHANGED_ACK_RESPONSE = {success: true} as const;

class VocabularyBookHandlerError extends Error {
    constructor(
        readonly code: VocabularyBookErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'VocabularyBookHandlerError';
    }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value: unknown, message: string): string {
    if (typeof value !== 'string') throw new VocabularyBookHandlerError('invalid-input', message);
    const text = value.trim();
    if (!text) throw new VocabularyBookHandlerError('invalid-input', message);
    return text;
}

function vocabularyEntryId(value: unknown): string {
    return requiredText(value, '缺少有效的单词条目标识');
}

function vocabularyUndoId(value: unknown): string {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) {
        throw new VocabularyBookHandlerError('invalid-input', '删除恢复标识无效');
    }
    return value;
}

function validateGetByTermMessage(message: VocabularyBookRuntimeMessage): {sourceLanguage: string; term: string} {
    // 步骤 1：支持 beta 期间的 term/word 双字段，但必须至少提供一个非空字符串。
    const term = typeof message.term === 'string'
        ? requiredText(message.term, '缺少有效的查询单词')
        : requiredText(message.word, '缺少有效的查询单词');

    // 步骤 2：sourceLanguage 是词书 identity 的一部分，后台边界不再接受隐式空值。
    const sourceLanguage = requiredText(message.sourceLanguage, '缺少有效的源语言');
    return {sourceLanguage, term};
}

function validateUpsertInput(value: unknown): VocabularyUpsertInput {
    if (!isPlainRecord(value)) throw new VocabularyBookHandlerError('invalid-input', '缺少有效的单词保存内容');
    return {
        ...value,
        sourceLanguage: requiredText(value.sourceLanguage, '缺少有效的源语言'),
        targetLanguage: requiredText(value.targetLanguage, '缺少有效的目标语言'),
        term: requiredText(value.term, '缺少有效的单词'),
        translation: typeof value.translation === 'string' ? value.translation.trim() : requiredText(value.translation, '缺少有效的译文'),
    };
}

function validateReviewRating(value: unknown): VocabularyScheduledReviewRating {
    if (value === 'again' || value === 'good') return value;
    throw new VocabularyBookHandlerError('invalid-input', '缺少有效的复习评分');
}

function validateListOptions(value: unknown): VocabularyListOptions | undefined {
    if (value === undefined) return undefined;
    if (isPlainRecord(value)) return value as VocabularyListOptions;
    throw new VocabularyBookHandlerError('invalid-input', '查询选项无效');
}

function validateExportOptions(value: unknown): VocabularyExportOptions | undefined {
    if (value === undefined) return undefined;
    if (isPlainRecord(value)) return value as VocabularyExportOptions;
    throw new VocabularyBookHandlerError('invalid-input', '导出选项无效');
}

function validateImportData(value: unknown): Record<string, unknown> {
    if (isPlainRecord(value)) return value;
    throw new VocabularyBookHandlerError('invalid-input', '导入数据无效');
}

function vocabularyFailure(error: unknown, logOperationFailure: (error: unknown) => void): VocabularyBookResponse<never> {
    if (error instanceof VocabularyBookHandlerError) return {success: false, error: {code: error.code, message: error.message}};

    logOperationFailure(error);
    const message = error instanceof Error ? error.message : '本地单词本暂时不可用';
    return {success: false, error: {code: 'storage-error', message}};
}

function notifyVocabularyBookChanged(
    dependencies: VocabularyBookBackgroundDependencies,
    reason: VocabularyBookChangedMessage['reason'],
    entryId?: string,
): void {
    try {
        // 步骤 1：广播是附带通知，不能阻塞主操作响应。
        dependencies.broadcastChanged(reason, entryId);
    } catch (error) {
        // 步骤 2：注入的广播适配器同步失败时只记录，不回滚已完成的词书操作。
        dependencies.logOperationFailure(error);
    }
}

export function createVocabularyBookChangedMessage(
    reason: VocabularyBookChangedMessage['reason'],
    entryId?: string,
): VocabularyBookChangedMessage {
    const message: VocabularyBookChangedMessage = {type: VOCABULARY_BOOK_CHANGED_MESSAGE, reason};
    if (entryId) message.entryId = entryId;
    return message;
}

/** 创建真实 browser runtime/tabs 广播器；调用方负责注入隔离后的 browser API。 */
export function createBrowserVocabularyBookChangedBroadcaster(
    adapter: VocabularyBookChangeBroadcastAdapter,
): VocabularyBookChangedBroadcaster {
    return (reason, entryId) => {
        const message = createVocabularyBookChangedMessage(reason, entryId);

        // 步骤 1：扩展页通过 runtime 消息接收变更通知。
        void adapter.sendRuntimeMessage(message).catch(() => undefined);

        // 步骤 2：共享端口选择实际 content 接收者；旧适配器仍逐标签发送。
        if (adapter.broadcastTabMessage) {
            void adapter.broadcastTabMessage(message).catch(() => undefined);
            return;
        }
        void adapter.queryTabs()
            .then((tabs) => Promise.allSettled(
                tabs
                    .filter((tab) => typeof tab.id === 'number')
                    .map((tab) => adapter.sendTabMessage(tab.id!, message)),
            ))
            .catch(() => undefined);
    };
}

export function createVocabularyBookChangedAckHandler():
    BackgroundMessageHandler<VocabularyBackgroundContext, VocabularyBookChangedMessage, typeof VOCABULARY_BOOK_CHANGED_ACK_RESPONSE> {
    return {
        type: VOCABULARY_BOOK_CHANGED_MESSAGE,
        handle() {
            return VOCABULARY_BOOK_CHANGED_ACK_RESPONSE;
        },
    };
}

/** 创建词书后台 handler；存储、配置和广播都由 background composition root 注入。 */
export function createVocabularyBookHandler(
    dependencies: VocabularyBookBackgroundDependencies,
): BackgroundMessageHandler<VocabularyBackgroundContext, VocabularyBookRuntimeMessage, VocabularyBookResponse> {
    return {
        type: VOCABULARY_BOOK_MESSAGE,
        async handle(message, context) {
            try {
                // 步骤 1：先在后台信任边界收窄 action 与必要参数。
                switch (message.action) {
                    case 'reencounterList':
                    case 'reencounterGet': {
                        await dependencies.configReady;
                        if (context.sender?.tab?.incognito === true || dependencies.isReencounterEnabled?.() !== true) {
                            throw new VocabularyBookHandlerError('invalid-input', '再次遇见尚未开启，或当前为无痕窗口');
                        }
                        if (message.action === 'reencounterList') {
                            const entries = await dependencies.vocabularyBook.list({order: 'recent'}) as VocabularyEntry[];
                            return {success: true, data: entries.map(reencounterTerm)};
                        }
                        const entry = await dependencies.vocabularyBook.get(vocabularyEntryId(message.entryId)) as VocabularyEntry | null;
                        if (!entry) throw new VocabularyBookHandlerError('not-found', '这条表达已从收藏中删除');
                        return {success: true, data: reencounterSnapshot(entry)};
                    }
                    case 'list':
                        return {success: true, data: await dependencies.vocabularyBook.list(validateListOptions(message.options))};
                    case 'get':
                        return {success: true, data: await dependencies.vocabularyBook.get(vocabularyEntryId(message.entryId))};
                    case 'getByTerm': {
                        const {sourceLanguage, term} = validateGetByTermMessage(message);
                        return {success: true, data: await dependencies.vocabularyBook.getByTerm(sourceLanguage, term)};
                    }
                    case 'upsert': {
                        await dependencies.configReady;
                        if (!dependencies.isVocabularyBookEnabled()) throw new VocabularyBookHandlerError('invalid-input', '请先在单词本页面开启功能');
                        if (context.sender?.tab?.incognito === true) throw new VocabularyBookHandlerError('invalid-input', '无痕窗口不保存单词本数据');
                        const entry = await dependencies.vocabularyBook.upsert(validateUpsertInput(message.input));
                        notifyVocabularyBookChanged(dependencies, 'upsert', entry.id);
                        return {success: true, data: entry};
                    }
                    case 'updateNote': {
                        if (context.sender?.tab?.incognito === true) throw new VocabularyBookHandlerError('invalid-input', '无痕窗口不修改学习收藏');
                        if (typeof message.note !== 'string') throw new VocabularyBookHandlerError('invalid-input', '解释内容无效');
                        const entryId = vocabularyEntryId(message.entryId);
                        const entry = await dependencies.vocabularyBook.updateNote(entryId, message.note);
                        notifyVocabularyBookChanged(dependencies, 'note', entryId);
                        return {success: true, data: entry};
                    }
                    case 'review': {
                        const entryId = vocabularyEntryId(message.entryId);
                        const result = await dependencies.vocabularyBook.review(entryId, validateReviewRating(message.rating));
                        notifyVocabularyBookChanged(dependencies, 'review', entryId);
                        return {success: true, data: result};
                    }
                    case 'setMastery': {
                        const entryId = vocabularyEntryId(message.entryId);
                        const result = await dependencies.vocabularyBook.setMastery(entryId);
                        notifyVocabularyBookChanged(dependencies, 'manual-mastered', entryId);
                        return {success: true, data: result};
                    }
                    case 'relearn': {
                        const entryId = vocabularyEntryId(message.entryId);
                        const result = await dependencies.vocabularyBook.relearn(entryId);
                        notifyVocabularyBookChanged(dependencies, 'relearn', entryId);
                        return {success: true, data: result};
                    }
                    case 'getReviewLogs':
                        return {success: true, data: await dependencies.vocabularyBook.getReviewLogs(vocabularyEntryId(message.entryId))};
                    case 'remove': {
                        const entryId = vocabularyEntryId(message.entryId);
                        const removed = await dependencies.vocabularyBook.remove(entryId);
                        if (removed) notifyVocabularyBookChanged(dependencies, 'remove', entryId);
                        return {success: true, data: removed};
                    }
                    case 'removeWithUndo':
                    case 'listUndo':
                    case 'restoreUndo':
                    case 'discardUndo': {
                        if (import.meta.env.BROWSER === 'userscript') throw new VocabularyBookHandlerError('invalid-input', '操作不支持');
                        // 原文和复习历史只留在后台数据库；不能让网页内容脚本枚举或恢复删除记录。
                        if (context.sender?.tab?.incognito === true || !dependencies.vocabularyUndo || !dependencies.isTrustedUndoSender?.(context.sender)) {
                            throw new VocabularyBookHandlerError('invalid-input', '请从扩展设置页面管理删除恢复记录');
                        }
                        if (message.action === 'listUndo') return {success: true, data: await dependencies.vocabularyUndo.listUndo()};
                        if (message.action === 'removeWithUndo') {
                            const entryId = vocabularyEntryId(message.entryId);
                            const ticket = await dependencies.vocabularyUndo.removeWithUndo(entryId);
                            if (ticket) notifyVocabularyBookChanged(dependencies, 'remove', entryId);
                            return {success: true, data: ticket};
                        }
                        const undoId = vocabularyUndoId(message.undoId);
                        if (message.action === 'discardUndo') {
                            await dependencies.vocabularyUndo.discardUndo(undoId);
                            notifyVocabularyBookChanged(dependencies, 'undo');
                            return {success: true, data: true};
                        }
                        const result = await dependencies.vocabularyUndo.restoreUndo(undoId);
                        if (result === 'restored') notifyVocabularyBookChanged(dependencies, 'import');
                        return {success: true, data: result};
                    }
                    case 'clear':
                        await dependencies.vocabularyBook.clear();
                        notifyVocabularyBookChanged(dependencies, 'clear');
                        return {success: true, data: true};
                    case 'exportData':
                        return {success: true, data: await dependencies.vocabularyBook.exportData(validateExportOptions(message.options))};
                    case 'importData': {
                        const result = await dependencies.vocabularyBook.importData(validateImportData(message.data));
                        notifyVocabularyBookChanged(dependencies, 'import');
                        return {success: true, data: result};
                    }
                    default:
                        throw new VocabularyBookHandlerError('invalid-input', '不支持的单词本操作');
                }
            } catch (error) {
                // 步骤 2：保持旧 background 行为：词书错误转为结构化响应，未知错误转为 storage-error。
                if (message.action === 'clear' || (import.meta.env.BROWSER !== 'userscript' && typeof message.action === 'string' && ['removeWithUndo', 'listUndo', 'restoreUndo', 'discardUndo'].includes(message.action))) {
                    if (error instanceof VocabularyBookHandlerError) return {success: false, error: {code: error.code, message: error.message}};
                    if (error instanceof Error && error.name === 'VocabularyBookError' && 'code' in error) {
                        if (error.code === 'limit-exceeded') return {success: false, error: {code: 'limit-exceeded', message: '收藏或恢复记录空间已满，请先处理已有记录'}};
                        if (error.code === 'invalid-input') return {success: false, error: {code: 'invalid-input', message: '已有相同收藏或复习记录，请先检查现有数据'}};
                    }
                    // 存储异常不写出可能包含原文、URL 或其他私密字段的异常对象。
                    return {success: false, error: {code: 'storage-error', message: '收藏操作未确认，请检查收藏后重试'}};
                }
                return vocabularyFailure(error, dependencies.logOperationFailure);
            }
        },
    };
}

export function createVocabularyBackgroundHandlers(
    dependencies: VocabularyBookBackgroundDependencies,
): Array<BackgroundMessageHandler<VocabularyBackgroundContext>> {
    return [
        createVocabularyBookChangedAckHandler(),
        createVocabularyBookHandler(dependencies),
    ];
}
