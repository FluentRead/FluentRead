import {describe, expect, it, vi} from 'vitest';
import {
    TRANSLATION_STATS_MESSAGE_TYPE,
    createTranslationStatsHandler,
    parseTranslationStatsFilter,
    parseTranslationStatsRequestQuery,
    type TranslationStatsRepositoryContract,
} from '@/src/app/background/handlers/translationStats';
import {buildTranslationStatsSnapshot} from '@/src/services/translation-stats/aggregation';
import type {TranslationStatsRequestPage} from '@/src/services/translation-stats/types';

const trustedContext = {sender: {url: 'chrome-extension://fluentread/options.html#settings-translation-stats'}};
const isOptionsUrl = (url: string) => url.startsWith('chrome-extension://fluentread/options.html');

function createRepository() {
    return {
        getDashboard: vi.fn(async (filter) => buildTranslationStatsSnapshot([], filter, {now: 1_000})),
        getRequestLog: vi.fn(async (query): Promise<TranslationStatsRequestPage> => ({
            generatedAt: 1_000,
            filter: query.filter,
            sort: query.sort ?? 'recent',
            offset: query.offset ?? 0,
            limit: query.limit ?? 20,
            totalCount: 0,
            items: [],
        })),
        clear: vi.fn(async () => undefined),
    } satisfies TranslationStatsRepositoryContract;
}

describe('翻译统计后台消息协议', () => {
    it('解析时间范围、服务与模型筛选，并拒绝非法值', () => {
        expect(parseTranslationStatsFilter(undefined)).toEqual({range: '7d'});
        expect(parseTranslationStatsFilter({range: 'today'})).toEqual({range: 'today'});
        expect(parseTranslationStatsFilter({range: '30d', serviceId: ' openai ', model: ' gpt '}))
            .toEqual({range: '30d', serviceId: 'openai', model: 'gpt'});
        expect(parseTranslationStatsFilter({range: '7d', serviceId: 'google', model: ''}))
            .toEqual({range: '7d', serviceId: 'google', model: ''});

        for (const value of [
            null,
            [],
            new Date(),
            {},
            {range: 'year'},
            {range: '7d', serviceId: 3},
            {range: '7d', serviceId: '  '},
            {range: '7d', serviceId: 'x'.repeat(201)},
            {range: '7d', model: 'gpt'},
        ]) {
            expect(() => parseTranslationStatsFilter(value), JSON.stringify(value)).toThrow(TypeError);
        }
        expect(parseTranslationStatsFilter(Object.assign(Object.create(null), {range: 'today'}))).toEqual({range: 'today'});
    });

    it('解析请求记录的来源、结果、排序与分页', () => {
        expect(parseTranslationStatsRequestQuery(undefined)).toEqual({filter: {range: '7d'}});
        expect(parseTranslationStatsRequestQuery({})).toEqual({filter: {range: '7d'}});
        expect(parseTranslationStatsRequestQuery({
            filter: {range: 'today', serviceId: 'deepL', source: 'partial', outcome: 'timeout'},
            sort: 'slowest',
            offset: 40,
            limit: 100,
        })).toEqual({
            filter: {range: 'today', serviceId: 'deepL', source: 'partial', outcome: 'timeout'},
            sort: 'slowest',
            offset: 40,
            limit: 100,
        });

        for (const value of [
            'query',
            {filter: {range: '7d', source: 'disk'}},
            {filter: {range: '7d', outcome: 1}},
            {sort: 'fastest'},
            {offset: -1},
            {offset: 1.5},
            {limit: 0},
            {limit: 101},
        ]) {
            expect(() => parseTranslationStatsRequestQuery(value), JSON.stringify(value)).toThrow(TypeError);
        }
    });

    it('只允许设置页查询、分页和清除，并把异常转换为可传输错误', async () => {
        const repository = createRepository();
        const handler = createTranslationStatsHandler(repository, isOptionsUrl);
        expect(handler.type).toBe(TRANSLATION_STATS_MESSAGE_TYPE);

        const snapshot = await handler.handle({type: 'translationStats', action: 'query', filter: {range: 'today'}}, trustedContext);
        expect(snapshot).toMatchObject({success: true, data: {selected: {filter: {range: 'today'}}}});
        expect(repository.getDashboard).toHaveBeenCalledWith({range: 'today'});

        const page = await handler.handle({type: 'translationStats', action: 'list', query: {filter: {range: '30d'}, limit: 50}}, trustedContext);
        expect(page).toMatchObject({success: true, data: {limit: 50}});

        expect(await handler.handle({type: 'translationStats', action: 'reset'}, trustedContext))
            .toEqual({success: true, data: {cleared: true}});
        expect(repository.clear).toHaveBeenCalledOnce();

        expect(await handler.handle({type: 'translationStats', action: 'export'}, trustedContext))
            .toEqual({success: false, error: '不支持的翻译统计操作'});
        expect(await handler.handle({type: 'translationStats', action: 'query', filter: {range: 'bad'}}, trustedContext))
            .toEqual({success: false, error: '翻译统计筛选 range 无效'});

        repository.getDashboard.mockRejectedValueOnce('storage down');
        expect(await handler.handle({type: 'translationStats', action: 'query'}, trustedContext))
            .toEqual({success: false, error: '翻译统计暂时不可用'});
        repository.getRequestLog.mockRejectedValueOnce(new Error('   '));
        expect(await handler.handle({type: 'translationStats', action: 'list'}, trustedContext))
            .toEqual({success: false, error: '翻译统计暂时不可用'});

        for (const context of [{sender: {url: 'https://example.com/article'}}, {sender: {}}, {}]) {
            expect(await handler.handle({type: 'translationStats', action: 'reset'}, context as typeof trustedContext))
                .toEqual({success: false, error: '当前上下文无权访问翻译统计'});
        }
        expect(repository.clear).toHaveBeenCalledOnce();
    });
});
