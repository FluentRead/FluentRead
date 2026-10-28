/**
 * @file src/providers/translation/googleErrorBody.ts
 * 文件职责：增量识别 Google 匿名接口错误正文中的 CAPTCHA HTML 和 XSRF 标记。
 * 主要内容：按固定大小解码字节、跨分块保留标记边界，并继续消费正文至 EOF 或错误；不保存错误正文或改变传输租约。
 * 模块边界：不发送请求、不设超时、不自行取消流；调用者负责 HTTP 状态、信号和传输许可。
 */
const HTML_ERROR = /<!doctype html|<html[\s>]/i;
const XSRF_ERROR = /"xsrf"/u;
const MAX_MARKER_OVERLAP = 13;
const DECODE_CHUNK_BYTES = 8192;

export interface GoogleErrorMarkers {html: boolean; xsrf: boolean}

/** 兼容完整字符串解析路径和跨块扫描，保持原有标记判断语义。 */
export function isGoogleHtmlResponse(value: string): boolean {return HTML_ERROR.test(value);}

/** 错误体无译文；扫描固定窗口并排空原流，避免聚合完整错误字符串。 */
export async function inspectGoogleErrorBody(response: Response): Promise<GoogleErrorMarkers> {
    if (!response.body) {
        const body = await response.text();
        return {html: isGoogleHtmlResponse(body), xsrf: XSRF_ERROR.test(body)};
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let html = false, xsrf = false, overlap = '';
    const scan = (text: string) => {
        const window = overlap + text;
        html ||= isGoogleHtmlResponse(window);
        xsrf ||= XSRF_ERROR.test(window);
        overlap = window.slice(-MAX_MARKER_OVERLAP);
    };
    try {
        while (true) {
            const part = await reader.read();
            if (part.done) break;
            if (!ArrayBuffer.isView(part.value) || Object.prototype.toString.call(part.value) !== '[object Uint8Array]') throw new TypeError('Invalid response body chunk');
            for (let offset = 0; offset < part.value.length && !(html && xsrf); offset += DECODE_CHUNK_BYTES) {
                scan(decoder.decode(part.value.subarray(offset, offset + DECODE_CHUNK_BYTES), {stream: true}));
            }
        }
        if (!html || !xsrf) scan(decoder.decode());
        return {html, xsrf};
    } finally {reader.releaseLock();}
}
