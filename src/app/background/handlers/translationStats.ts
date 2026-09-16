/**
 * @file src/app/background/handlers/translationStats.ts
 * 文件职责：为设置页提供类型化的翻译统计快照、请求记录分页与清除统计后台消息协议。
 * 主要内容：校验 query/list/reset 动作、时间范围、服务与模型筛选、来源与结果、排序和分页上限，只允许扩展设置页访问，并把仓库结果或存储错误转换成可传输响应。
 * 模块边界：本文件不直接访问 IndexedDB、不采集翻译请求，也不格式化界面文案；仓库由后台组合根注入。
 */

import type {BackgroundMessageHandler} from '../messageRouter';
import {
    TRANSLATION_REQUEST_OUTCOMES,
    TRANSLATION_REQUEST_SOURCES,
    TRANSLATION_STATS_REQUEST_MAX_PAGE_SIZE,
    type TranslationRequestOutcome,
    type TranslationRequestSource,
    type TranslationStatsFilter,
    type TranslationStatsRange,
    type TranslationStatsRequestPage,
    type TranslationStatsRequestQuery,
    type TranslationStatsSnapshot,
} from '@/src/services/translation-stats/types';
import type {ConfigPersistenceContext} from './configPersistence';

export const TRANSLATION_STATS_MESSAGE_TYPE = 'translationStats' as const;

export interface TranslationStatsMessage {
    type: typeof TRANSLATION_STATS_MESSAGE_TYPE;
    action?: unknown;
    filter?: unknown;
    query?: unknown;
}

export type TranslationStatsResponse =
    | {success: true; data: TranslationStatsSnapshot}
    | {success: true; data: TranslationStatsRequestPage}
    | {success: true; data: {cleared: true}}
    | {success: false; error: string};

export interface TranslationStatsRepositoryContract {
    getDashboard(filter: TranslationStatsFilter): Promise<TranslationStatsSnapshot>;
    getRequestLog(query: TranslationStatsRequestQuery): Promise<TranslationStatsRequestPage>;
    clear(): Promise<void>;
}

const VALID_RANGES: readonly TranslationStatsRange[] = ['today', '7d', '30d'];
const MAX_FILTER_LENGTH = 200;
const MAX_OFFSET = 1_000_000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function optionalText(value: unknown, field: string, allowEmpty: boolean): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new TypeError(`翻译统计筛选 ${field} 必须是字符串`);
    const normalized = value.trim();
    if ((!normalized && !allowEmpty) || normalized.length > MAX_FILTER_LENGTH) {
        throw new TypeError(`翻译统计筛选 ${field} 无效`);
    }
    return normalized;
}

function optionalMember<T extends string>(value: unknown, values: readonly T[], field: string): T | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !values.includes(value as T)) {
        throw new TypeError(`翻译统计筛选 ${field} 无效`);
    }
    return value as T;
}

function optionalInteger(value: unknown, minimum: number, maximum: number, field: string): number | undefined {
    if (value === undefined) return undefined;
    if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
        throw new TypeError(`翻译统计请求记录 ${field} 必须是 ${minimum}-${maximum} 的整数`);
    }
    return value as number;
}

export function parseTranslationStatsFilter(value: unknown): TranslationStatsFilter {
    if (value === undefined) return {range: '7d'};
    if (!isPlainRecord(value)) throw new TypeError('翻译统计筛选必须是对象');
    const range = optionalMember(value.range, VALID_RANGES, 'range');
    if (!range) throw new TypeError('翻译统计筛选 range 无效');
    const serviceId = optionalText(value.serviceId, 'serviceId', false);
    // 机器翻译没有模型维度，空串表示该服务的无模型分组，因此必须和服务一起出现。
    const model = optionalText(value.model, 'model', true);
    if (model !== undefined && !serviceId) throw new TypeError('翻译统计筛选 model 需要同时指定 serviceId');
    return {
        range,
        ...(serviceId ? {serviceId} : {}),
        ...(model !== undefined ? {model} : {}),
    };
}

export function parseTranslationStatsRequestQuery(value: unknown): TranslationStatsRequestQuery {
    if (value === undefined) return {filter: {range: '7d'}};
    if (!isPlainRecord(value)) throw new TypeError('翻译统计请求记录查询必须是对象');
    const filter = parseTranslationStatsFilter(value.filter);
    const record = isPlainRecord(value.filter) ? value.filter : {};
    const source = optionalMember<TranslationRequestSource>(record.source, TRANSLATION_REQUEST_SOURCES, 'source');
    const outcome = optionalMember<TranslationRequestOutcome>(record.outcome, TRANSLATION_REQUEST_OUTCOMES, 'outcome');
    const sort = optionalMember(value.sort, ['recent', 'slowest'] as const, 'sort');
    const offset = optionalInteger(value.offset, 0, MAX_OFFSET, 'offset');
    const limit = optionalInteger(value.limit, 1, TRANSLATION_STATS_REQUEST_MAX_PAGE_SIZE, 'limit');
    return {
        filter: {
            ...filter,
            ...(source ? {source} : {}),
            ...(outcome ? {outcome} : {}),
        },
        ...(sort ? {sort} : {}),
        ...(offset !== undefined ? {offset} : {}),
        ...(limit !== undefined ? {limit} : {}),
    };
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message.trim()
        ? error.message
        : '翻译统计暂时不可用';
}

export function createTranslationStatsHandler(
    repository: TranslationStatsRepositoryContract,
    isOptionsUrl: (url: string) => boolean,
): BackgroundMessageHandler<ConfigPersistenceContext, TranslationStatsMessage, TranslationStatsResponse> {
    return {
        type: TRANSLATION_STATS_MESSAGE_TYPE,
        async handle(message, context) {
            try {
                const senderUrl = typeof context.sender?.url === 'string' ? context.sender.url : '';
                if (!isOptionsUrl(senderUrl)) throw new Error('当前上下文无权访问翻译统计');
                if (message.action === 'query') {
                    return {success: true, data: await repository.getDashboard(parseTranslationStatsFilter(message.filter))};
                }
                if (message.action === 'list') {
                    return {success: true, data: await repository.getRequestLog(parseTranslationStatsRequestQuery(message.query))};
                }
                if (message.action === 'reset') {
                    await repository.clear();
                    return {success: true, data: {cleared: true}};
                }
                return {success: false, error: '不支持的翻译统计操作'};
            } catch (error) {
                return {success: false, error: errorMessage(error)};
            }
        },
    };
}
