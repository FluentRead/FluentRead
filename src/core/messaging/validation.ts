/**
 * @file src/core/messaging/validation.ts
 * 文件职责：在序列化边界按完整字段契约缩窄未知消息。
 * 主要内容：提供可组合的原始值、可选字段、数组与对象守卫；对象字段表必须覆盖目标类型所有键，使 DTO 字段变化触发编译检查。
 * 模块边界：只校验输入，不转换业务默认值、不读取环境，也不发送消息。
 */
export type Validator<T> = (value: unknown) => value is T;
export const isString: Validator<string> = (value): value is string => typeof value === 'string';
export const isBoolean: Validator<boolean> = (value): value is boolean => typeof value === 'boolean';
export const isFiniteNumber: Validator<number> = (value): value is number => typeof value === 'number' && Number.isFinite(value);
export const isNonEmptyString: Validator<string> = (value): value is string => isString(value) && value.trim().length > 0;
export function isMessageRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Reject non-record objects at protocol boundaries that use strict Zod schemas. */
export function isProtocolInputObject(value: unknown): value is Record<string, unknown> {
    if (!isMessageRecord(value) || value instanceof Date || value instanceof Map || value instanceof Set) return false;
    return typeof value.then !== 'function' || typeof value.catch !== 'function';
}
export function optional<T>(validator: Validator<T>): Validator<T | undefined> {
    return (value): value is T | undefined => value === undefined || validator(value);
}
export function arrayOf<T>(validator: Validator<T>): Validator<T[]> {
    return (value): value is T[] => Array.isArray(value) && value.every(validator);
}
export function oneOf<const T extends string | number | boolean>(...values: readonly T[]): Validator<T> {
    return (value): value is T => values.some(expected => expected === value);
}
export function shape<T extends object>(fields: {[K in keyof T]-?: Validator<T[K]>}): Validator<T> {
    return (value): value is T => {
        if (!isMessageRecord(value)) return false;
        for (const key in fields) if (!fields[key](value[key])) return false;
        return true;
    };
}
export function parseMessage<T>(value: unknown, validator: Validator<T>, name: string): T {
    if (!validator(value)) throw new TypeError(`${name}消息格式无效`);
    return value;
}
/** Worker 请求编号来自单调计数器；未知、非整数或非正编号不能关联任何在途任务。 */
export const isPositiveSafeInteger: Validator<number> = (value): value is number => isFiniteNumber(value) && Number.isSafeInteger(value) && value > 0;
export function readWorkerRequestId(value: unknown): number | undefined {
    return isMessageRecord(value) && isPositiveSafeInteger(value.requestId) ? value.requestId : undefined;
}
