/**
 * @file src/services/translation/queue.ts
 *
 * 文件职责：提供带会话取消、并发上限和公平调度的翻译任务队列，供全文等批量场景控制 provider 压力。
 * 主要内容：定义会话、等待和传输租约。重试在延迟期归还并发槽，仍归原会话管理；撤销会话或达到入场期限时清理对应计时器与监听。
 * 模块边界：本文件位于翻译 application service 层，负责用例编排和端口契约；不挂载页面 UI，且不应把某家供应商的网络细节扩散到 feature，具体 HTTP 协议由 providers/platform 实现。
 */

/**
 * 翻译队列管理模块
 * 控制并发翻译任务的数量，避免同时进行过多翻译请求
 */

import {config} from '@/src/services/config/store';
import {normalizeMaxConcurrentTranslations} from '@/src/core/config/model';
import {createTranslationAbortError as createQueueAbortError} from './errors';

const COMPACTION_HEAD_THRESHOLD = 1024;

export interface TranslationQueueSession {
  readonly generation: number;
}

/**
 * 任务可能在其启动的传输真正结束前停止等待，例如恢复已翻译 DOM 时。继续持有队列租约
 * 可让真实传输仍受配置的并发上限约束，同时不延迟返回给调用方的取消结果。
 */
export interface TranslationQueueLease {
  holdUntil(settlement: PromiseLike<unknown>): void;
}

type TranslationQueueSessionState =
  | {cancelled: false}
  | {cancelled: true; cancellationError: TranslationQueueCancelledError};

interface PendingTranslation {
  session: TranslationQueueSession;
  /** 在 pendingTranslations 中的槽位；压缩队列时统一平移，保证取消是 O(1) 定位。 */
  slot: number | undefined;
  delayTimer?: ReturnType<typeof setTimeout>;
  expiryTimer?: ReturnType<typeof setTimeout>;
  execute: () => Promise<void>;
  cancel: (error: Error) => void;
  removeAbortListener?: () => void;
}

export class TranslationQueueCancelledError extends Error {
  readonly code = 'TRANSLATION_QUEUE_CANCELLED';

  constructor(message = '翻译任务已取消') {
    super(message);
    this.name = 'TranslationQueueCancelledError';
  }
}

let activeTranslations = 0;
let pendingTranslations: Array<PendingTranslation | undefined> = [];
let pendingHead = 0;
let pendingCount = 0;
let queueGeneration = 0;
const sessionStates = new WeakMap<TranslationQueueSession, TranslationQueueSessionState>();
/**
 * 每个会话自己的等待项索引。全文翻译为每个候选创建独立会话，恢复原文或滚动
 * 抖动会连续取消数百个会话；若每次取消都线性扫描整条队列，整页取消就是 O(N²)。
 */
const pendingBySession = new Map<TranslationQueueSession, Set<PendingTranslation>>();

function sessionPendingEntries(session: TranslationQueueSession): Set<PendingTranslation> {
  let entries = pendingBySession.get(session);
  if (!entries) {
    entries = new Set();
    pendingBySession.set(session, entries);
  }
  return entries;
}

function forgetPendingTranslation(entry: PendingTranslation): void {
  const entries = sessionPendingEntries(entry.session);
  entries.delete(entry);
  if (entries.size === 0) pendingBySession.delete(entry.session);
  entry.slot = undefined;
  clearTimeout(entry.delayTimer);
  clearTimeout(entry.expiryTimer);
  entry.delayTimer = undefined;
  entry.removeAbortListener?.();
}

/**
 * 摘除一个仍在等待的条目。索引只登记仍占用数组槽位的条目——出队与取消都会
 * 同步移除索引——因此这里不需要再复验槽位归属。
 */
function detachPendingTranslation(entry: PendingTranslation): void {
  if (entry.slot !== undefined) {
    pendingTranslations[entry.slot] = undefined;
    pendingCount -= 1;
  }
  forgetPendingTranslation(entry);
}

function resetPendingQueue(): void {
  pendingTranslations = [];
  pendingHead = 0;
  pendingCount = 0;
  pendingBySession.clear();
}

function createSession(): TranslationQueueSession {
  const session = Object.freeze({generation: queueGeneration});
  sessionStates.set(session, {cancelled: false});
  return session;
}

let defaultSession = createSession();

function getMaxConcurrentTranslations(): number {
  // config 通常已经在存储边界归一化；这里仍防御运行时污染和旧上下文中的畸形值，
  // 确保队列至少推进一个任务，也绝不会突破设置页公开的 100 并发上限。
  return normalizeMaxConcurrentTranslations(config.maxConcurrentTranslations);
}

function normalizeCancellationError(reason?: unknown): TranslationQueueCancelledError {
  if (reason instanceof TranslationQueueCancelledError) return reason;
  if (reason instanceof Error) return new TranslationQueueCancelledError(reason.message);
  return new TranslationQueueCancelledError(typeof reason === 'string' ? reason : undefined);
}

function getSessionCancellationError(session: TranslationQueueSession): TranslationQueueCancelledError | null {
  const state = sessionStates.get(session);
  if (!state) throw new TypeError('无效的翻译队列会话');
  if (state.cancelled) return state.cancellationError;
  if (session.generation !== queueGeneration) return new TranslationQueueCancelledError('翻译队列会话已过期');
  return null;
}

function compactPendingQueue(force = false): void {
  // 队列已排空时无条件回收，取消整页候选后不再保留数千个空槽。
  if (pendingCount === 0) {
    if (pendingTranslations.length > 0 || pendingHead > 0) resetPendingQueue();
    return;
  }
  if (pendingHead === 0) return;
  if (force || (pendingHead >= COMPACTION_HEAD_THRESHOLD && pendingHead * 2 >= pendingTranslations.length)) {
    const offset = pendingHead;
    pendingTranslations = pendingTranslations.slice(offset);
    pendingHead = 0;
    for (const entry of pendingTranslations) if (entry) entry.slot! -= offset;
  }
}

function dequeuePendingTranslation(): PendingTranslation | undefined {
  while (pendingHead < pendingTranslations.length) {
    const entry = pendingTranslations[pendingHead];
    pendingTranslations[pendingHead] = undefined;
    pendingHead += 1;
    if (entry) {
      pendingCount -= 1;
      forgetPendingTranslation(entry);
    }
    compactPendingQueue();
    if (entry) return entry;
  }
  compactPendingQueue(true);
  return undefined;
}

function processQueue(): void {
  const maxConcurrent = getMaxConcurrentTranslations();
  while (activeTranslations < maxConcurrent) {
    const entry = dequeuePendingTranslation();
    if (!entry) return;

    // 步骤 1：enqueue 会同步校验会话；取消操作也会在同一事件循环内把等待项移出数组。
    // 因此能被 dequeue 取出的条目必然仍是有效的 pending 工作。
    activeTranslations += 1;
    void entry.execute().finally(() => {
      activeTranslations -= 1;
      processQueue();
    });
  }
}

/**
 * 创建一个可单独取消的队列会话。取消只会阻止尚未开始的任务；已经发送的
 * 请求仍会自然结束，真正中止网络请求需要调用方额外接入 AbortSignal。
 */
export function createTranslationQueueSession(): TranslationQueueSession {
  return createSession();
}

/** 绑定隐式会话，避免延迟重试在清空队列后进入新的 generation。 */
export function getDefaultTranslationQueueSession(): TranslationQueueSession {
  return defaultSession;
}

/** 取消指定会话中所有尚未开始的任务。 */
export function cancelTranslationQueueSession(session: TranslationQueueSession, reason?: unknown): void {
  const state = sessionStates.get(session);
  if (!state) throw new TypeError('无效的翻译队列会话');
  if (state.cancelled) return;

  const error = normalizeCancellationError(reason);
  sessionStates.set(session, {cancelled: true, cancellationError: error});
  const entries = pendingBySession.get(session);
  if (entries) {
    // 先快照再摘除：detach 会改写同一个 Set。
    for (const entry of [...entries]) {
      detachPendingTranslation(entry);
      entry.cancel(error);
    }
  }
  compactPendingQueue();
}

/**
 * 添加翻译任务到队列。
 * @param translationTask 翻译任务函数，需要返回 Promise
 * @param session 可选的取消会话；默认使用当前全局队列 generation
 * @param signal 仅负责本条等待项的取消；出队后交由任务自己的传输取消逻辑处理
 */
export function enqueueTranslation<T>(
  translationTask: (lease: TranslationQueueLease) => Promise<T>,
  session: TranslationQueueSession = defaultSession,
  signal?: AbortSignal,
  retry?: {delayMs: number; deadlineAt: number; error: unknown},
): Promise<T> {
  try {
    const cancellationError = getSessionCancellationError(session);
    if (cancellationError) return Promise.reject(cancellationError);
    if (signal?.aborted) return Promise.reject(createQueueAbortError());
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise<T>((resolve, reject) => {
    const entry: PendingTranslation = {
      session,
      slot: undefined,
      cancel: (error) => {
        entry.slot = undefined;
        clearTimeout(entry.delayTimer);
        clearTimeout(entry.expiryTimer);
        entry.removeAbortListener?.();
        reject(error);
      },
      execute: async () => {
        const heldSettlements: Promise<void>[] = [];
        let acceptsHolds = true;
        const lease: TranslationQueueLease = {
          holdUntil: (settlement) => {
            if (!acceptsHolds) {
              throw new Error('翻译队列任务已结束，无法继续占用并发槽');
            }
            heldSettlements.push(Promise.resolve(settlement).then(
              () => undefined,
              () => undefined,
            ));
          },
        };
        try {
          resolve(await translationTask(lease));
        } catch (error) {
          reject(error);
        } finally {
          acceptsHolds = false;
          // 调用方可能已经收到 AbortError，但队列槽位仍需保持占用，直到该任务启动的
          // 每项传输均已结束或达到各自的传输超时。
          await Promise.all(heldSettlements);
        }
      },
    };

    const submit = () => {
      entry.delayTimer = undefined;
      entry.slot = pendingTranslations.length;
      pendingTranslations.push(entry);
      pendingCount += 1;
      processQueue();
    };
    sessionPendingEntries(session).add(entry);
    if (retry) {
      const expire = () => {
        detachPendingTranslation(entry);
        reject(retry.error);
        compactPendingQueue();
      };
      const remaining = retry.deadlineAt - Date.now();
      if (remaining <= retry.delayMs) return expire();
      entry.expiryTimer = setTimeout(expire, remaining);
    }
    if (signal) {
      const onAbort = () => {
        if (!pendingBySession.get(session)?.has(entry)) return;
        detachPendingTranslation(entry);
        entry.cancel(createQueueAbortError());
        compactPendingQueue();
      };
      entry.removeAbortListener = () => {
        signal.removeEventListener('abort', onAbort);
        entry.removeAbortListener = undefined;
      };
      signal.addEventListener('abort', onAbort, {once: true});
      // 注册边界可能同步触发取消；既处理漏过的事件，也保持已处理事件的幂等性。
      if (signal.aborted) return onAbort();
    }
    if (retry && retry.delayMs > 0) entry.delayTimer = setTimeout(submit, retry.delayMs);
    else submit();
  });
}

/**
 * 清空所有等待中的任务并推进全局 generation。活跃任务保持原有语义，仍会
 * 自然完成；之后入队的任务使用新的 generation，不会被旧会话误取消。
 */
export function clearTranslationQueue(): void {
  const error = new TranslationQueueCancelledError('翻译队列已清空');
  // 默认会话只由 createSession 创建并持有强引用，始终具有已注册的状态。
  sessionStates.set(defaultSession, {cancelled: true, cancellationError: error});

  queueGeneration += 1;
  const cancelled = [...pendingBySession.values()];
  resetPendingQueue();
  for (const entries of cancelled) for (const entry of entries) entry.cancel(error);
  defaultSession = createSession();
}
