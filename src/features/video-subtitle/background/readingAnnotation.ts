/**
 * @file src/features/video-subtitle/background/readingAnnotation.ts
 * 文件职责：将同扩展内容页面的读音标注请求按发送方绑定到共享离屏能力。
 * 主要内容：校验有界原文与语言，隔离 tab/frame/document 的请求与取消标识，以本地 AbortController 贯穿编号生成、离屏创建和排队；编号失败同样释放占位，记住有限的先取消后启动请求并限制同时挂起的工作。
 * 模块边界：不加载转写引擎或词典，不改变字幕及翻译配置，不关闭共享离屏文档；Worker 资源由离屏读音运行时拥有。
 */
import {isReadingAnnotationRequest, isReadingAnnotationCancellation} from '@/src/core/messaging/readingAnnotation';
import {parseMessage} from '@/src/core/messaging/validation';
import {sendOffscreenRequest} from '@/src/platform/offscreen/requests';
import type {OffscreenClient} from '@/src/platform/offscreen/client';
import type {BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';
import {READING_ANNOTATION_REQUEST_TIMEOUT_MS} from '@/src/core/readingAnnotation';

interface Context {sender?: {id?: string; tab?: {id?: number}; frameId?: number; documentId?: string}}
interface Dependencies {offscreen: OffscreenClient; runtimeId: string; createRequestId?: () => string}

export function createVideoReadingAnnotationHandlers(dependencies: Dependencies): readonly BackgroundMessageHandler<Context>[] {
  const pending = new Map<string, AbortController>();
  const cancelled = new Set<string>();
  const ownerKey = (requestId: string, context: Context) => {
    const sender = context.sender;
    if (sender?.id !== dependencies.runtimeId || !Number.isSafeInteger(sender.tab?.id) || sender.tab!.id! < 0) throw new Error('读音标注发送方无效');
    return JSON.stringify([sender.tab!.id, sender.frameId ?? 0, sender.documentId ?? '', requestId]);
  };
  return [{
    type: 'fluentReadAnnotateVideoReading',
    async handle(input: unknown, context) {
      const request = parseMessage(input, isReadingAnnotationRequest, '读音标注');
      const key = ownerKey(request.requestId, context);
      if (cancelled.delete(key)) return {success: false, error: '读音标注已取消'};
      if (pending.has(key)) throw new Error('读音标注请求标识重复');
      if (pending.size >= 32) throw new Error('读音标注队列已满，请稍后重试');
      const controller = new AbortController();
      pending.set(key, controller);
      try {
        const offscreenId = dependencies.createRequestId?.() ?? `reading:${crypto.randomUUID()}`;
        // 校验器保留信封中的额外字段；只挑选业务载荷，不能让 content 的 type 覆盖离屏路由。
        const response = await sendOffscreenRequest(dependencies.offscreen, {type: 'READING_ANNOTATION', text: request.text, language: request.language, requestId: offscreenId},
          {signal: controller.signal, timeoutMs: READING_ANNOTATION_REQUEST_TIMEOUT_MS, cancelMessage: {type: 'READING_ANNOTATION_CANCEL', requestId: offscreenId}});
        if (controller.signal.aborted) return {success: false, error: '读音标注已取消'};
        return response;
      // 同 key 在本轮结束前拒绝重入，取消只 abort；本轮负责释放唯一占位。
      } finally { pending.delete(key); }
    },
  }, {
    type: 'fluentReadCancelVideoReading',
    handle(input: unknown, context) {
      const request = parseMessage(input, isReadingAnnotationCancellation, '取消读音标注');
      const key = ownerKey(request.requestId, context);
      const controller = pending.get(key);
      if (controller) controller.abort();
      else {
        cancelled.add(key);
        if (cancelled.size > 256) cancelled.delete(cancelled.values().next().value!);
      }
      return {success: true, cancelled: Boolean(controller)};
    },
  }];
}
