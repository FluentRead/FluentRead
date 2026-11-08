/**
 * @file src/shared/function/arrayBufferBytes.ts
 * 文件职责：为仅接受非共享字节视图的浏览器接口准备输入。
 * 主要内容：保留普通 ArrayBuffer 视图的偏移及长度，仅复制无法确认使用普通缓冲区的视图。
 * 模块边界：只转换二进制视图，不处理编码、协议或输入的生命周期。
 */
export function asArrayBufferBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const {buffer, byteOffset, byteLength} = bytes;
    return buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer, byteOffset, byteLength)
        : new Uint8Array(bytes);
}
