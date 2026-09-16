import {describe, expect, it} from 'vitest';
import {measureImageDataUrlBytes, measureTranslationText} from '@/src/services/translation-stats/measure';

describe('翻译统计请求规模测量', () => {
    it('单条原文按 Unicode 码点计字符，并与 TextEncoder 的 UTF-8 字节数一致', () => {
        const text = 'Hi, é 中文 😀 \uD83D end';
        const size = measureTranslationText(text);

        expect(size.segmentCount).toBe(1);
        expect(size.chars).toBe([...text].length);
        expect(size.bytes).toBe(new TextEncoder().encode(text).byteLength);
    });

    it('批量原文累加段落、字符与字节，非字符串槽位只计段落', () => {
        const segments = ['abc', 'дом', '😀', '\uDC00', '\uD83Dx'];
        const size = measureTranslationText([...segments, 42 as unknown as string]);

        expect(size.segmentCount).toBe(6);
        expect(size.chars).toBe(segments.reduce((sum, value) => sum + [...value].length, 0));
        expect(size.bytes).toBe(segments.reduce((sum, value) => sum + new TextEncoder().encode(value).byteLength, 0));
        expect(measureTranslationText([])).toEqual({segmentCount: 0, chars: 0, bytes: 0});
    });

    it('图片输入按 base64 长度与补位推算解码字节数', () => {
        const encode = (bytes: number) => `data:image/png;base64,${Buffer.alloc(bytes, 7).toString('base64')}`;

        expect(measureImageDataUrlBytes(undefined)).toBe(0);
        expect(measureImageDataUrlBytes('')).toBe(0);
        expect(measureImageDataUrlBytes('not-a-data-url')).toBe(0);
        for (const bytes of [1, 2, 3, 4, 5, 1024]) expect(measureImageDataUrlBytes(encode(bytes))).toBe(bytes);
    });
});
