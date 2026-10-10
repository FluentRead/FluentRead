import {describe, expect, it, vi} from 'vitest';
import {
    NativeBatchResponseError,
    isNativeBatchResponseError,
    validateNativeBatchResults,
} from '@/src/core/translation/nativeBatch';
import {readNativeBatchJson, translateNativeTextBatch} from '@/src/providers/translation/native-batch';

describe('原生批次 JSON 与读取故障分类', () => {
    it('有效 JSON 原样返回，语法损坏可识别为结构错误', async () => {
        await expect(readNativeBatchJson(new Response('["译文"]'), '坏 JSON')).resolves.toEqual(['译文']);
        await expect(readNativeBatchJson(new Response('["译文"'), '坏 JSON'))
            .rejects.toMatchObject({kind: 'response', code: 'NATIVE_BATCH_RESPONSE_INVALID', message: '坏 JSON'});
    });

    it('读取失败不触发拆批也不暴露响应内容，取消优先返回取消状态', async () => {
        const broken = {json: async () => {throw new TypeError('private upstream response');}};
        await expect(readNativeBatchJson(broken, '坏 JSON')).rejects.toMatchObject({message: '翻译响应读取失败'});
        try {await readNativeBatchJson(broken, '坏 JSON');} catch (error) {
            expect(isNativeBatchResponseError(error)).toBe(false);
        }
        const controller = new AbortController();controller.abort();
        await expect(readNativeBatchJson(broken, '坏 JSON', controller.signal))
            .rejects.toMatchObject({name: 'AbortError'});
    });
});

describe('原生机器批量响应契约', () => {
    it('跨 runtime 传输后的错误字段仍可识别，其他错误不会被降级处理', () => {
        const error = new NativeBatchResponseError();
        expect(error).toMatchObject({name: 'NativeBatchResponseError', kind: 'response', code: 'NATIVE_BATCH_RESPONSE_INVALID', retryable: false});
        expect(isNativeBatchResponseError(error)).toBe(true);
        expect(isNativeBatchResponseError({kind: 'response', code: error.code})).toBe(true);
        for (const other of [null, undefined, 'error', new Error(), {}, {kind: 'timeout', code: error.code}, {kind: 'response', code: 'OTHER'}]) {
            expect(isNativeBatchResponseError(other)).toBe(false);
        }
    });

    it('保留有效译文的字面符号、换行、首尾空白与合法空来源', () => {
        const values = [' <b>译文 &amp;</b>\n下一行 ', '', '\u200b'];
        expect(validateNativeBatchResults(['<b>Hello</b>', '', '\u200b'], values)).toEqual(values);
        expect(validateNativeBatchResults([], [])).toEqual([]);
    });

    it.each([null, {}, [], ['译文'], ['甲', '乙', '多余'], ['甲', 2], ['甲', ''], ['甲', '\u200b'], new Array(2)].map(values => ({values})))(
        '拒绝异常或不完整数组 $values', ({values}) => {
            expect(() => validateNativeBatchResults(['a', 'b'], values, 'fixture invalid')).toThrow('fixture invalid');
        },
    );
});

describe('原生机器分包的取消与完整发布', () => {
    it('保留重复 ordinal 槽、本地空白与单条/数组结果形状', async () => {
        const translate = vi.fn(async (sources: readonly string[]) => sources.map((text, index) => `${index}:${text}`));
        await expect(translateNativeTextBatch(['same', '', ' \r\n', 'same', '\u200b'], translate))
            .resolves.toEqual(['0:same', '', ' \r\n', '1:same', '\u200b']);
        expect(translate).toHaveBeenCalledOnce();
        expect(translate.mock.calls[0][0]).toEqual(['same', 'same']);
        await expect(translateNativeTextBatch('single', translate)).resolves.toBe('0:single');
        translate.mockClear();
        await expect(translateNativeTextBatch([], translate)).resolves.toEqual([]);
        await expect(translateNativeTextBatch(' \n', translate)).resolves.toBe(' \n');
        expect(translate).not.toHaveBeenCalled();
    });

    it('同时限制条数与字符数，超长单槽独立保留完整正文', async () => {
        const translate = vi.fn(async (sources: readonly string[]) => sources.map(text => `译:${text}`));
        const sources = Array.from({length: 33}, (_, index) => `slot ${index}`);
        await expect(translateNativeTextBatch(sources, translate)).resolves.toEqual(sources.map(text => `译:${text}`));
        expect(translate.mock.calls.map(([group]) => group.length)).toEqual([32, 1]);
        translate.mockClear();
        const long = `正文\n${'a'.repeat(4_001)}`;
        const characterSources = ['a'.repeat(2_001), 'b'.repeat(1_999), 'c', long, 'tail'];
        await expect(translateNativeTextBatch(characterSources, translate)).resolves.toEqual(characterSources.map(text => `译:${text}`));
        expect(translate.mock.calls.map(([group]) => group.map(text => text.length))).toEqual([[2_001, 1_999], [1], [long.length], [4]]);
    });

    it('输入在等待第一组时变化不影响后续源槽，后组异常不返回半批结果', async () => {
        const sources = Array.from({length: 33}, (_, index) => `slot ${index}`);
        const translate = vi.fn(async (group: readonly string[]) => {
            sources[32] = 'changed';
            return group.length === 32 ? group.map(text => `译:${text}`) : [];
        });
        await expect(translateNativeTextBatch(sources, translate)).rejects.toMatchObject({code: 'NATIVE_BATCH_RESPONSE_INVALID'});
        expect(translate).toHaveBeenCalledTimes(2);
        expect(translate.mock.calls[1][0]).toEqual(['slot 32']);
    });

    it('预先取消不启动请求，首组取消后不启动剩余分包', async () => {
        const controller = new AbortController();
        controller.abort();
        const translate = vi.fn(async () => ['译文']);
        await expect(translateNativeTextBatch(['first'], translate, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(translate).not.toHaveBeenCalled();
        const active = new AbortController();
        translate.mockImplementation(async () => { active.abort(); return Array.from({length: 32}, () => '译文'); });
        await expect(translateNativeTextBatch(Array.from({length: 33}, () => 'source'), translate, active.signal))
            .rejects.toMatchObject({name: 'AbortError'});
        expect(translate).toHaveBeenCalledOnce();
    });
});
