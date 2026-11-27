/**
 * @file src/core/config/model/clone.ts
 *
 * 文件职责：提供配置归一化边界使用的迭代深克隆、安全自有属性检查与字符串/布尔映射规范化纯工具函数。
 * 主要内容：导出 cloneConfigValue、hasOwn、isRecord、isBooleanMapping、configuredString、normalizeStringMapping 与 normalizeStringList；迭代克隆避免深层嵌套栈溢出并保留共享引用、稀疏数组与普通数据原型。
 * 模块边界：本文件为 config/model 内部基础工具模块，零外部运行时依赖，不涉及具体配置字段语义或业务迁移规则。
 */

import type {IMapping} from './types';

export function hasOwn(value: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

export function isRecord(value: unknown): value is Record<string, string> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isBooleanMapping(value: unknown): value is Record<string, boolean> {
    return typeof value === 'object'
        && value !== null
        && !Array.isArray(value)
        && Object.values(value).every((item) => typeof item === 'boolean');
}

export function configuredString(mapping: unknown, key: string): string {
    if (!isRecord(mapping)) return '';
    const value = mapping[key];
    return typeof value === 'string' ? value.trim() : '';
}

export function normalizeStringMapping(value: unknown): IMapping {
    if (!isRecord(value)) return {};
    return Object.fromEntries(
        Object.entries(value).filter(([, item]) => typeof item === 'string'),
    );
}

export function normalizeStringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean))];
}

export function cloneConfigValue(value: unknown): unknown {
    type Container = Record<string, unknown> | unknown[];
    const clones = new WeakMap<object, Container>();
    const pending: Array<{source: object; target: Container}> = [];
    const copy = (item: unknown): unknown => {
        if (item === null || typeof item !== 'object') return item;
        const existing = clones.get(item);
        if (existing) return existing;
        // 与原规则一致：对象落成普通数据对象，数组保留长度和稀疏位置。
        const target: Container = Array.isArray(item) ? new Array(item.length) : {};
        clones.set(item, target);
        pending.push({source: item, target});
        return target;
    };
    const result = copy(value);
    // 每个对象只展开一次；深层 JSON 不消耗调用栈，循环和共享引用也能终止。
    while (pending.length > 0) {
        const {source, target} = pending.pop()!;
        if (Array.isArray(source)) {
            for (let index = 0; index < source.length; index++) {
                // 保持 Array.map 的 HasProperty 语义，包括非枚举或继承的数组项。
                if (index in source) Object.defineProperty(target, index, {
                    value: copy(source[index]), enumerable: true, writable: true, configurable: true,
                });
            }
        } else {
            for (const key of Object.keys(source)) Object.defineProperty(target, key, {
                value: copy((source as Record<string, unknown>)[key]), enumerable: true, writable: true, configurable: true,
            });
        }
    }
    return result;
}
