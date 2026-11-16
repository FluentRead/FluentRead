/**
 * @file src/features/selection-translation/dictionary/archiveTypes.d.ts
 * 文件职责：补足现有压缩依赖在流式词典导入中使用的最小类型。
 * 主要内容：声明 pako 的有界输出回调，不改变包行为或为任意导入放宽类型。
 * 模块边界：仅类型扩展，不加载压缩器、不读取文件或注册运行时副作用。
 */
import 'pako';
declare module 'pako' {
    export function deflate(data: Uint8Array): Uint8Array;
    export function gzip(data: Uint8Array): Uint8Array;
    export class Inflate {
        err: number;
        ended: boolean;
        onData(chunk: Uint8Array): void;
        push(data: Uint8Array, final: boolean): boolean;
    }
}
