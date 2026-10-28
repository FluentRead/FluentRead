/**
 * @file tests/googleErrorBody.test.ts
 * 文件职责：验证 Google 非成功响应的增量正文标记识别与流资源边界。
 * 主要内容：比较完整字符串与跨 UTF-8/任意字节边界的识别，并覆盖大块、流错误和旧响应端口。
 * 模块边界：真实 ReadableStream 和 TextDecoder 配合受控输入；不访问 Google 或证明线上协议内容。
 */
import {describe, expect, it, vi} from 'vitest';
import {runInNewContext} from 'node:vm';
import {inspectGoogleErrorBody, isGoogleHtmlResponse} from '@/src/providers/translation/googleErrorBody';

function responseChunks(bytes: Uint8Array, widths: number[], status = 400): Response {
    let offset = 0, index = 0;
    return new Response(new ReadableStream<Uint8Array>({pull(controller) {
        if (offset >= bytes.length) {controller.close(); return;}
        const end = Math.min(bytes.length, offset + widths[index++ % widths.length]!);
        controller.enqueue(bytes.subarray(offset, end)); offset = end;
    }}), {status});
}

describe('Google 失败正文增量识别', () => {
    it.each([
        '', 'plain private body', '<!DoCtYpE HtMl>', '<HTML>', '<html\nlang="en">',
        '"xsrf"', '<html>"xsrf"', '<htmlx>"XSRF"', '中文🙂<!doctype html>\ufffd"xsrf"',
    ])('按全部单字节边界读取时与完整文本保持一致：%s', async value => {
        const response = responseChunks(new TextEncoder().encode(value), [1]);
        expect(await inspectGoogleErrorBody(response)).toEqual({html: /<!doctype html|<html[\s>]/i.test(value), xsrf: /"xsrf"/u.test(value)});
        expect(response.body?.locked).toBe(false);
    });
    it('单块超过数 MiB 时每次解码仍限于 8192 字节，末尾标记完整识别', async () => {
        const value = `${'x'.repeat(4 * 1024 * 1024)}<!doctype html>${'y'.repeat(100)}"xsrf"`;
        const bytes = new TextEncoder().encode(value);
        const decode = vi.spyOn(TextDecoder.prototype, 'decode');
        try {
            expect(await inspectGoogleErrorBody(responseChunks(bytes, [bytes.length]))).toEqual({html: true, xsrf: true});
            const inputLengths = decode.mock.calls.flatMap(([input]) => input ? [input.byteLength] : []);
            expect(inputLengths.length).toBeGreaterThan(1); expect(Math.max(...inputLengths)).toBeLessThanOrEqual(8192);
        } finally {decode.mockRestore();}
    });
    it('两个标记齐全后继续读取到 EOF，但不再解码多余正文', async () => {
        const first = new TextEncoder().encode('<html>"xsrf"'); const later = new TextEncoder().encode('z'.repeat(30000));
        let reads = 0; const response = new Response(new ReadableStream({pull(controller) {
            reads++; if (reads === 1) controller.enqueue(first); else if (reads < 4) controller.enqueue(later); else controller.close();
        }}), {status: 403});
        const decode = vi.spyOn(TextDecoder.prototype, 'decode');
        try {expect(await inspectGoogleErrorBody(response)).toEqual({html: true, xsrf: true}); expect(reads).toBe(4); expect(decode).toHaveBeenCalledOnce();}
        finally {decode.mockRestore();}
    });
    it('非字节流按原生 Response.text 语义失败，且释放读取锁', async () => {
        const make = () => new Response(new ReadableStream({start(controller) {controller.enqueue('not bytes'); controller.close();}}), {status: 500});
        const response = make(); await expect(make().text()).rejects.toThrow();
        await expect(inspectGoogleErrorBody(response)).rejects.toThrow('Invalid response body chunk');
        expect(response.body?.locked).toBe(false);
    });
    it('接收其他 JavaScript realm 创建的 Uint8Array 分块', async () => {
        const foreign = runInNewContext('new Uint8Array([60, 72, 84, 77, 76, 62])') as Uint8Array;
        expect(foreign instanceof Uint8Array).toBe(false);
        const response = new Response(new ReadableStream({start(controller) {controller.enqueue(foreign); controller.close();}}), {status: 403});
        expect(await inspectGoogleErrorBody(response)).toEqual({html: true, xsrf: false});
    });
    it('无效 UTF-8、BOM 和大小写对检测的作用与原生完整 text 一致', async () => {
        const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0xff, 0x3c, 0x48, 0x54, 0x4d, 0x4c, 0x20, 0xf0, 0x9f, 0x99, 0x82, 0x3e, 0x22, 0x78, 0x73, 0x72, 0x66, 0x22]);
        const expected = await responseChunks(bytes, [3, 1, 2]).text();
        expect(await inspectGoogleErrorBody(responseChunks(bytes, [1, 4, 2]))).toEqual({html: /<!doctype html|<html[\s>]/i.test(expected), xsrf: /"xsrf"/u.test(expected)});
    });
    it('无 body 的旧响应端口仍读取一次，流拒绝时释放锁并向调用者传播', async () => {
        const fallback = {body: null, text: vi.fn(async () => '<HTML>"xsrf"')} as unknown as Response;
        expect(await inspectGoogleErrorBody(fallback)).toEqual({html: true, xsrf: true}); expect(fallback.text).toHaveBeenCalledOnce();
        const failure = new Error('private fixture');
        const response = new Response(new ReadableStream({start(controller) {controller.error(failure);}}), {status: 503});
        await expect(inspectGoogleErrorBody(response)).rejects.toBe(failure); expect(response.body?.locked).toBe(false);
        expect(isGoogleHtmlResponse('<htmly>')).toBe(false);
    });
});
