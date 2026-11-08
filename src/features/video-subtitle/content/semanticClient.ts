/**
 * @file src/features/video-subtitle/content/semanticClient.ts
 * 文件职责：把显式 AI 断句操作传递给可信后台，并核对请求身份。
 * 主要内容：重建源 cue 消息、独立请求 ID、取消通知和响应检查；后台拥有配置与供应商凭据。
 * 模块边界：不持久缓存、不读取密钥、不自动发起调用；迟到结果由外层材料会话继续拒绝。
 */
import {sendRuntimeMessage} from '@/src/platform/browser/runtimeMessages';
import {SEMANTIC_ALGORITHM_VERSION} from '../semanticSegmentation';
import type {SemanticTransport} from './semanticSession';
export const requestVideoSemanticBoundaries: SemanticTransport = async (document, signal) => {
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  const requestId = `semantic:${crypto.randomUUID()}`;
  const cancel = () => {void sendRuntimeMessage({type: 'fluentReadCancelVideoSemantics', requestId}).catch(() => undefined);};
  signal.addEventListener('abort', cancel, {once: true});
  try {
    const response = await sendRuntimeMessage({type: 'fluentReadSegmentVideoSemantics', requestId, algorithmVersion: SEMANTIC_ALGORITHM_VERSION,
      cues: document.spans.map(span => ({text: document.text.slice(span.start, span.end), startMs: span.startMs, durationMs: span.endMs - span.startMs})),
    }) as {success?: boolean; requestId?: string; algorithmVersion?: number; result?: unknown};
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (response?.success !== true || response.requestId !== requestId || response.algorithmVersion !== SEMANTIC_ALGORITHM_VERSION) throw new Error('AI segmentation failed');
    return response.result;
  } finally {signal.removeEventListener('abort', cancel);}
};
