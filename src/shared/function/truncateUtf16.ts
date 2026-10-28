/**
 * @file src/shared/function/truncateUtf16.ts
 * 文件职责：按 UTF-16 代码单元预算截取文本前缀，避免把完整代理对截开。
 * 主要内容：截断位置落在高、低代理项之间时向前退一位，保留原有短文本和孤立代理项。
 * 模块边界：纯文本工具，不改变字形簇或规范化输入，不访问 DOM、配置、网络和存储。
 */
export function truncateUtf16(value: string, max: number): string {
    const end = Math.max(0, Math.min(value.length, Math.floor(max)));
    if (end === value.length) return value;
    const before = value.charCodeAt(end - 1);
    const after = value.charCodeAt(end);
    const splitsPair = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
    return value.slice(0, splitsPair ? end - 1 : end);
}
