/**
 * @file src/features/video-subtitle/content/semanticSession.ts
 * 文件职责：为主动 AI 断句提供单一材料所有者与可取消、有截止时间的会话。
 * 主要内容：冻结请求材料、绑定外部配置和视频版本，拒绝取消后的迟到结果，验证边界后才交给共享优化器。
 * 模块边界：不决定供应商、不读配置、不持久缓存；调用方在导航、换轨、关闭及配置变化时取消。
 */
import {createSemanticDocument, parseSemanticBoundaryResponse, segmentSemanticDocument, type SemanticDocument, type SemanticUnit} from '../semanticSegmentation';
import type {VideoSubtitleCue} from './youtubeSubtitleData';

export type SemanticTransport = (document: SemanticDocument, signal: AbortSignal) => Promise<unknown>;
export class VideoSemanticSession {
  private controller?: AbortController;
  constructor(private readonly transport: SemanticTransport, private readonly currentRevision: () => string,
    private readonly timeoutMs = 30_000) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid segmentation deadline');
  }
  cancel(): void { this.controller?.abort(); this.controller = undefined; }
  async request(cues: readonly VideoSubtitleCue[]): Promise<SemanticUnit[]> {
    this.cancel();
    const document = createSemanticDocument(cues);
    if (!document.text) return [];
    const revision = this.currentRevision();
    const controller = new AbortController();
    this.controller = controller;
    let rejectAbort!: (error: unknown) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const abort = () => rejectAbort(controller.signal.reason);
    controller.signal.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(() => controller.abort(new DOMException('Segmentation deadline exceeded', 'TimeoutError')), this.timeoutMs);
    try {
      const response = await Promise.race([this.transport(document, controller.signal), aborted]);
      if (controller.signal.aborted || this.controller !== controller || revision !== this.currentRevision()) {
        throw new DOMException('Stale segmentation result', 'AbortError');
      }
      return segmentSemanticDocument(document, parseSemanticBoundaryResponse(document, response));
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
      if (this.controller === controller) this.controller = undefined;
    }
  }
}
