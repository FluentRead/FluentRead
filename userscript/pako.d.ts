declare module 'pako' {
    export function ungzip(data: Uint8Array, options?: {to?: string}): string | Uint8Array;
}

declare module 'pako/lib/inflate.js' {
    export function ungzip(data: Uint8Array, options?: {to?: string}): string | Uint8Array;
}
