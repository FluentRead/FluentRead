import {ungzip} from 'pako/lib/inflate.js';

/** 无远程依赖构建在旧内核中使用随脚本打包的 pako。 */
export function inflateWithPako(bytes: Uint8Array): string {
    return String(ungzip(bytes, {to: 'string'}));
}
