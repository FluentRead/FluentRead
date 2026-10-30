/**
 * @file src/features/video-subtitle/background/semanticSegmentation.ts
 * 文件职责：将主动 AI 断句限制在可信普通窗口、显式配置与同文档请求所有者内。
 * 主要内容：验证有界 cue、重建候选集合、隔离取消、限制并发和截止时间，配置变化或迟到结果不返回。
 * 模块边界：生成能力通过依赖注入，不调用翻译 fallback、不存储字幕、不接受内容脚本提供凭据。
 */
import {SEMANTIC_ALGORITHM_VERSION, createSemanticDocument, parseSemanticBoundaryResponse, type SemanticDocument} from '../semanticSegmentation';
import type {VideoSubtitleCue} from '../content/youtubeSubtitleData';
import type {BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';
interface Context {sender?: {id?: string; tab?: {id?: number; incognito?: boolean; url?: string}; frameId?: number; documentId?: string; url?: string}}
interface Settings {enabled: boolean; revision: string}
interface Dependencies {
  allowedSite?: (url: string) => boolean;
  runtimeId: string; privateContext: () => boolean; settings: () => Settings;
  generate: (document: SemanticDocument, signal: AbortSignal) => Promise<unknown>;
}
function requestId(input: unknown): string {
  const id = (input as {requestId?: unknown})?.requestId;
  if (typeof id !== 'string' || !/^[\w:-]{1,100}$/u.test(id)) throw new Error('Invalid segmentation request');
  return id;
}
function sourceCues(input: unknown): VideoSubtitleCue[] {
  const cues = (input as {cues?: unknown})?.cues;
  if (!Array.isArray(cues) || cues.length > 2048) throw new Error('Invalid subtitle window');
  return cues.map(cue => {
    if (!cue || typeof cue !== 'object' || typeof cue.text !== 'string' || cue.text.length > 16000) throw new Error('Invalid subtitle cue');
    return {text: cue.text, startMs: cue.startMs, durationMs: cue.durationMs};
  });
}
export function createVideoSemanticHandlers(deps: Dependencies): readonly BackgroundMessageHandler<Context>[] & {cancelAll(): void; cancelTab(tabId: number): void} {
  const pending = new Map<string, AbortController>();
  const cancelled = new Set<string>();
  const consumed = new Set<string>();
  const consume = (key: string) => { consumed.add(key); if (consumed.size > 512) consumed.delete(consumed.values().next().value!); };
  const cancelAll = () => { for (const controller of pending.values()) controller.abort(); };
  const cancelTab = (tabId: number) => { for (const [key, controller] of pending) { if (JSON.parse(key)[0] === tabId) controller.abort(); } };
  const owner = (input: unknown, context: Context) => {
    const sender = context.sender;
    if (sender?.id !== deps.runtimeId || sender.tab?.incognito !== false || deps.privateContext()
      || !Number.isSafeInteger(sender.tab.id) || sender.tab.id! < 0
      || !Number.isSafeInteger(sender.frameId) || sender.frameId! < 0) throw new Error('Segmentation requires a trusted regular tab');
    return JSON.stringify([sender.tab.id, sender.frameId, sender.documentId || sender.url || '', requestId(input)]);
  };
  const handlers: BackgroundMessageHandler<Context>[] = [{type: 'fluentReadSegmentVideoSemantics', async handle(input: unknown, context) {
    const key = owner(input, context);
    if (deps.allowedSite && (!deps.allowedSite(context.sender?.url || '') || !deps.allowedSite(context.sender?.tab?.url || ''))) throw new Error('Site disabled');
    if (consumed.has(key) || cancelled.has(key)) throw new Error('Segmentation cancelled or consumed');
    if ((input as {algorithmVersion?: unknown}).algorithmVersion !== SEMANTIC_ALGORITHM_VERSION) throw new Error('Segmentation version mismatch');
    const settings = deps.settings();
    if (!settings.enabled) throw new Error('AI segmentation is not configured');
    if (pending.has(key) || pending.size >= 4) throw new Error('Segmentation busy');
    const document = createSemanticDocument(sourceCues(input));
    if (!document.text) throw new Error('Empty subtitle window');
    consume(key);
    const controller = new AbortController(); pending.set(key, controller);
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_, reject) => {rejectAbort = reject;});
    const abort = () => rejectAbort(new Error('Segmentation cancelled or expired'));
    controller.signal.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(() => controller.abort(), 30_000);
    const id = requestId(input);
    let response: unknown;
    try {
      const result = await Promise.race([deps.generate(document, controller.signal), aborted]);
      const latest = deps.settings();
      if (controller.signal.aborted || !latest.enabled || settings.revision !== latest.revision) throw new Error('Stale segmentation');
      response = {success: true, requestId: id, algorithmVersion: SEMANTIC_ALGORITHM_VERSION, result: {boundaries: parseSemanticBoundaryResponse(document, result)}};
    } catch {
      // 供应商原始错误可能含私密 URL、请求正文或凭据，不跨边界返回。
      response = {success: false, requestId: id, error: 'AI segmentation failed; original subtitles are unchanged'};
    } finally {
      clearTimeout(timer); controller.signal.removeEventListener('abort', abort);
      // 在 pending 中的 key 不允许再次启动，因此此处只可能属于本次调用。
      pending.delete(key);
    }
    return response;
  }}, {type: 'fluentReadCancelVideoSemantics', handle(input: unknown, context) {
    const key = owner(input, context); const controller = pending.get(key);
    if (controller) controller.abort();
    else {cancelled.add(key); if (cancelled.size > 256) cancelled.delete(cancelled.values().next().value!);}
    return {success: true};
  }}];
  return Object.assign(handlers, {cancelAll, cancelTab});
}
