/**
 * @file src/providers/translation/ai-sdk/boundedErrorResponse.ts
 * 文件职责：为 OpenAI 兼容接口的失败响应提供单次、有界的正文读取。
 * 主要内容：完整短正文保持原字节和 HTTP 元信息；超限、超时或读取失败时返回固定诊断并请求终止原传输，同时持续排空未合作流以保留真实并发租约。
 * 模块边界：只包装非成功响应，不决定重试与图像能力；不能限制传输已创建的单个大数据块或保证自定义传输接受取消。
 */
import {abortErrorFromSignal} from '@/src/platform/http/runtime';

export const OPENAI_ERROR_BODY_LIMIT = Object.freeze({
  maxBytes: 32_768,
  replacement: '{"error":{"message":"上游错误响应过大、读取超时或无法读取。"}}',
});
const ERROR_BODY_TIMEOUT_MS = 1_000;

function copyResponse(response: Response, bytes: Uint8Array | null, synthetic: boolean): Response {
  const headers = new Headers(response.headers);
  if (synthetic) {
    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.set('content-type', 'application/json');
  }
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * `result` may settle before `drained`: the latter remains pending until the
 * original stream actually ends or errors, even if its producer ignores abort.
 */
export function boundErrorResponse(
  response: Response,
  signal: AbortSignal | undefined,
  abortTransport: () => void,
): {result: Promise<Response>; drained: Promise<void>} {
  // Opaque/error responses (status 0) and 304 responses have no readable
  // body in the Fetch API and are passed through without reconstruction.
  if (!response.body) {
    return {result: signal?.aborted ? Promise.reject(abortErrorFromSignal(signal)) : Promise.resolve(response), drained: Promise.resolve()};
  }
  const reader = response.body.getReader();
  let resolveResult!: (value: Response) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<Response>((resolve, reject) => {resolveResult = resolve; rejectResult = reject;});
  const bytes = new Uint8Array(OPENAI_ERROR_BODY_LIMIT.maxBytes);
  let count = 0, readChunks = 0, decided = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  };
  const onAbort = () => {
    decided = true;
    finish();
    rejectResult(abortErrorFromSignal(signal));
    abortTransport();
  };
  const fallback = () => {
    if (decided) return;
    decided = true;
    finish();
    resolveResult(copyResponse(response, new TextEncoder().encode(OPENAI_ERROR_BODY_LIMIT.replacement), true));
    abortTransport();
  };
  if (signal?.aborted) onAbort();
  else {
    signal?.addEventListener('abort', onAbort, {once: true});
    timer = setTimeout(fallback, ERROR_BODY_TIMEOUT_MS);
  }
  const drained = (async () => {
    try {
      for (;;) {
        let part: ReadableStreamReadResult<Uint8Array> | undefined = await reader.read();
        if (part.done) {
          if (!decided) {
            decided = true;
            finish();
            resolveResult(copyResponse(response, bytes.slice(0, count), false));
          }
          return;
        }
        if (!decided) {
          if (part.value.byteLength > OPENAI_ERROR_BODY_LIMIT.maxBytes - count) fallback();
          else {
            bytes.set(part.value, count);
            count += part.value.byteLength;
          }
        }
        // Do not retain an oversized upstream chunk while the next read waits;
        // some engines keep the previous async-loop local alive across awaits.
        part = undefined;
        // A custom producer can continuously enqueue empty or tiny chunks,
        // including before the byte limit is reached. Let deadline and abort
        // events run both before a result and while draining after cancellation.
        if (++readChunks % 64 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    } catch {
      // On read failure preserve the HTTP status but do not expose partial data.
      fallback();
    } finally {
      finish();
      try {reader.releaseLock();} catch { /* A transport may own its lock. */ }
    }
  })();
  return {result, drained};
}
