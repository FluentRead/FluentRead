/**
 * @file src/features/full-page-translation/progress.ts
 * 文件职责：提供全文翻译进度的独立内存状态源，以 sessionId 隔离新旧翻译任务，并向多个 UI 订阅者安全发布发现、完成和失败计数。
 * 主要内容：定义进度、会话与订阅 API、完成及失败计数与会话限定的失败操作端口；数值归一化，通知以队列交付独立快照并隔离异常，同一轮内写入状态的订阅者不再接收更新回声，其他观察者取得最新状态。
 * 模块边界：该模块不访问 DOM、配置或浏览器存储，也不决定任务调度；content/runtime 负责更新进度，TranslationProgressPanel.vue 订阅快照并通过会话限定端口请求失败操作，状态仅存活于当前运行上下文。
 */
export interface FullPageTranslationProgress {
  sessionId: number;
  active: boolean;
  modalPhase: 'none' | 'translating' | 'waiting';
  deferred: number;
  running: number;
  remaining: number;
  queued: number;
  offscreen: number;
  completed?: number;
  failed?: number;
  retryable?: number;
}

export type FullPageFailureAction = 'retry' | 'locate';
let failureActions: {sessionId: number; handle: (action: FullPageFailureAction) => number} | null = null;

/** UI 只能操作仍然活跃的同一会话；已恢复或新会话不能消费旧面板命令。 */
export function setFullPageFailureActions(sessionId: number, handle: (action: FullPageFailureAction) => number): void {
  if (progress.active && progress.sessionId === sessionId) failureActions = {sessionId, handle};
}
export function runFullPageFailureAction(sessionId: number, action: FullPageFailureAction): number {
  if (!progress.active || progress.sessionId !== sessionId || failureActions?.sessionId !== sessionId) return 0;
  try { return failureActions.handle(action); } catch { return 0; }
}

type FullPageTranslationProgressListener = (progress: FullPageTranslationProgress) => void;

const listeners = new Set<FullPageTranslationProgressListener>();
const pendingListeners = new Set<FullPageTranslationProgressListener>();
const publishingListeners = new Set<FullPageTranslationProgressListener>();
const deliveredSnapshots = new Map<FullPageTranslationProgressListener, FullPageTranslationProgress>();
let notifying = false;
let currentListener: FullPageTranslationProgressListener | null = null;
let nextSessionId = 0;
let progress: FullPageTranslationProgress & {completed: number; failed: number; retryable: number} = {
  sessionId: 0,
  active: false,
  modalPhase: 'none',
  deferred: 0,
  running: 0,
  remaining: 0,
  queued: 0,
  offscreen: 0,
  completed: 0,
  failed: 0,
  retryable: 0,
};

function cloneProgress(): FullPageTranslationProgress {
  return {...progress};
}

function deliverProgress(listener: FullPageTranslationProgressListener): void {
  try {
    // 每个订阅者都获得独立快照，一个 UI 的误修改或异常不会污染其他 UI。
    listener(cloneProgress());
  } catch (error) {
    console.error('[FluentRead] 全文翻译进度订阅者执行失败', error);
  }
}

function flushProgressListeners(): void {
  if (notifying) return;
  notifying = true;
  try {
    while (pendingListeners.size > 0) {
      const listener = pendingListeners.values().next().value!;
      pendingListeners.delete(listener);
      currentListener = listener;
      deliveredSnapshots.set(listener, progress);
      deliverProgress(listener);
      currentListener = null;
    }
  } finally {
    currentListener = null;
    pendingListeners.clear();
    publishingListeners.clear();
    deliveredSnapshots.clear();
    notifying = false;
  }
}

function notifyProgressListeners(): void {
  // 订阅者通常只读；发生同步写入时允许更新状态，但不向本轮写入者回送通知，
  // 从而截断自身及多个订阅者间的反馈。只读 UI 仍会按最新快照追上变更。
  if (currentListener) publishingListeners.add(currentListener);
  for (const listener of listeners) {
    if (!publishingListeners.has(listener) && deliveredSnapshots.get(listener) !== progress) pendingListeners.add(listener);
  }
  flushProgressListeners();
}

function normalizeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** 只有正在请求或已经进入队列的工作才需要展开进度面板；离屏候选不应让大面板常驻。 */
export function hasActiveFullPageTranslationWork(
  value: Pick<FullPageTranslationProgress, 'active' | 'running' | 'queued'>
    & Partial<Pick<FullPageTranslationProgress, 'modalPhase' | 'deferred' | 'failed'>>,
): boolean {
  return value.active && (
    normalizeCount(value.running) > 0
    || normalizeCount(value.queued) > 0
    || value.modalPhase === 'waiting'
    || normalizeCount(value.deferred ?? 0) > 0
    || normalizeCount(value.failed ?? 0) > 0
  );
}

/** 悬浮球不可用且会话暂时没有活动工作时，以淡勾选替代常驻的大进度面板。 */
export function shouldShowCompactFullPageTranslationStatus(
  value: Pick<FullPageTranslationProgress, 'active' | 'running' | 'queued'>
    & Partial<Pick<FullPageTranslationProgress, 'modalPhase' | 'deferred' | 'failed'>>,
  floatingBallEnabled: boolean,
): boolean {
  return !floatingBallEnabled && value.active && !hasActiveFullPageTranslationWork(value);
}

export function startFullPageTranslationProgress(): number {
  const sessionId = ++nextSessionId;
  failureActions = null;
  progress = {
    sessionId,
    active: true,
    modalPhase: 'none',
    deferred: 0,
    running: 0,
    remaining: 0,
    queued: 0,
    offscreen: 0,
    completed: 0,
    failed: 0,
    retryable: 0,
  };
  notifyProgressListeners();
  return sessionId;
}

export function updateFullPageTranslationProgress(
  sessionId: number,
  value: Partial<Pick<FullPageTranslationProgress, 'modalPhase' | 'deferred' | 'completed' | 'failed' | 'retryable'>>
    & Pick<FullPageTranslationProgress, 'running' | 'queued' | 'offscreen'>,
): void {
  if (!progress.active || progress.sessionId !== sessionId) return;

  const running = normalizeCount(value.running);
  const queued = normalizeCount(value.queued);
  const offscreen = normalizeCount(value.offscreen);
  const modalPhase = value.modalPhase ?? 'none';
  const deferred = normalizeCount(value.deferred ?? 0);
  const completed = normalizeCount(value.completed ?? progress.completed);
  const failed = normalizeCount(value.failed ?? progress.failed);
  const retryable = normalizeCount(value.retryable ?? failed);
  const remaining = queued + offscreen + deferred;
  if (
    progress.modalPhase === modalPhase &&
    progress.deferred === deferred &&
    progress.running === running &&
    progress.remaining === remaining &&
    progress.queued === queued &&
    progress.offscreen === offscreen && progress.completed === completed && progress.failed === failed && progress.retryable === retryable
  ) return;

  progress = {...progress, modalPhase, deferred, running, remaining, queued, offscreen, completed, failed, retryable};
  notifyProgressListeners();
}

export function finishFullPageTranslationProgress(sessionId: number): void {
  if (!progress.active || progress.sessionId !== sessionId) return;
  failureActions = null;
  progress = {
    sessionId,
    active: false,
    modalPhase: 'none',
    deferred: 0,
    running: 0,
    remaining: 0,
    queued: 0,
    offscreen: 0,
    completed: 0,
    failed: 0,
    retryable: 0,
  };
  notifyProgressListeners();
}

export function getFullPageTranslationProgress(): FullPageTranslationProgress {
  return cloneProgress();
}

/** 空闲时同步交付初始快照；通知中的订阅加入当前队列，同一状态不重复初始化。 */
export function subscribeFullPageTranslationProgress(
  listener: FullPageTranslationProgressListener,
): () => void {
  listeners.add(listener);
  if (deliveredSnapshots.get(listener) !== progress && !publishingListeners.has(listener)) pendingListeners.add(listener);
  flushProgressListeners();
  return () => {
    listeners.delete(listener);
    pendingListeners.delete(listener);
  };
}
