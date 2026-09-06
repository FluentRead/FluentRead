import { describe, expect, it } from 'vitest';
import { getOcrLanguages, normalizeOcrLines, scaleOcrBox, selectChangedTranslations } from '@/src/features/image-translation/core';
import { inpaintTextRegions } from '@/src/features/image-translation/services/inpainting';
import { IMAGE_OCR_LANGUAGE_PACKS, IMAGE_OCR_RECOMMENDED_LANGUAGES, normalizeImageOcrLanguageCodes } from '@/src/features/image-translation/ocrLanguages';
import { getImageTextBackgroundColor, getImageTextColor } from '@/src/features/image-translation/services/rendering';

describe('图片翻译 OCR 工具', () => {
    it('按源语言选择最小 OCR 语言集', () => {
        for (const source of ['es', 'es-ES', 'es-MX', ' ES_ar ']) expect(getOcrLanguages(source)).toEqual(['spa', 'eng']);
        expect(getOcrLanguages('esperanto')).toEqual(['chi_sim', 'chi_tra', 'eng', 'jpn']);
        for (const source of ['en', 'en-US', ' EN_gb ']) expect(getOcrLanguages(source)).toEqual(['eng']);
        for (const [language, code] of [['ko', 'kor'], ['fr', 'fra'], ['ru', 'rus'], ['ja', 'jpn']]) {
            for (const source of [language, `${language}-XX`, ` ${language.toUpperCase()}_xx `]) expect(getOcrLanguages(source)).toEqual([code, 'eng']);
        }
        expect(getOcrLanguages('constructor')).toEqual(IMAGE_OCR_RECOMMENDED_LANGUAGES);
        expect(normalizeImageOcrLanguageCodes(['kor', 'fra', 'rus', 'kor'])).toEqual(['kor', 'fra', 'rus']);
        expect(getOcrLanguages('zh-Hans')).toEqual(['chi_sim', 'eng']);
        expect(getOcrLanguages('zh-Hant')).toEqual(['chi_tra', 'eng']);
        expect(getOcrLanguages('zh-TW')).toEqual(['chi_tra', 'eng']);
        expect(getOcrLanguages('zh-Hans-TW')).toEqual(['chi_sim', 'eng']);
        expect(getOcrLanguages('ja')).toEqual(['jpn', 'eng']);
        expect(IMAGE_OCR_RECOMMENDED_LANGUAGES).toEqual(['chi_sim', 'chi_tra', 'eng', 'jpn']);
        expect(IMAGE_OCR_LANGUAGE_PACKS.filter(pack => pack.recommended).map(pack => pack.code)).toEqual(IMAGE_OCR_RECOMMENDED_LANGUAGES);
        expect(getOcrLanguages('auto')).toEqual(['chi_sim', 'chi_tra', 'eng', 'jpn']);
    });

    it('只接受支持的语言包并去重，保证下载状态可持久化', () => {
        expect(normalizeImageOcrLanguageCodes(['eng', 'jpn', 'eng', 'unsupported', null])).toEqual(['eng', 'jpn']);
        expect(normalizeImageOcrLanguageCodes(['chi_tra', 'eng', 'chi_tra'])).toEqual(['chi_tra', 'eng']);
        expect(normalizeImageOcrLanguageCodes(['spa', 'eng', 'spa'])).toEqual(['spa', 'eng']);
        expect(normalizeImageOcrLanguageCodes('eng')).toEqual([]);
    });

    it('把 OCR 坐标按图片显示尺寸缩放', () => {
        expect(scaleOcrBox(
            { x0: 100, y0: 50, x1: 500, y1: 150 },
            1000,
            500,
            500,
            250,
        )).toEqual({ left: 50, top: 25, width: 200, height: 50 });
        expect(scaleOcrBox(
            { x0: -10, y0: -10, x1: -9, y1: -9 },
            100,
            100,
            50,
            50,
        )).toEqual({ left: 0, top: 0, width: 1, height: 1 });
    });

    it('过滤空 OCR 行并保留文本框', () => {
        expect(normalizeOcrLines(null)).toEqual([]);
        expect(normalizeOcrLines([{paragraphs: undefined}, {paragraphs: [{lines: undefined}]}])).toEqual([]);
        const lines = normalizeOcrLines([
            {
                paragraphs: [{
                    lines: [
                        { text: ' Hello   world ', bbox: { x0: 0, y0: 0, x1: 20, y1: 10 } },
                        { text: '   ', bbox: { x0: 0, y0: 0, x1: 20, y1: 10 } },
                    ],
                }],
            } as never,
        ]);

        expect(lines).toEqual([{ text: 'Hello world', bbox: { x0: 0, y0: 0, x1: 20, y1: 10 } }]);
    });

    it('不为微软原样返回的 OCR 行生成翻译覆盖层', () => {
        const lines = [
            { text: '中文标题', bbox: { x0: 0, y0: 0, x1: 40, y1: 12 } },
            { text: 'Hello world', bbox: { x0: 0, y0: 20, x1: 80, y1: 32 } },
            { text: 'Missing translation', bbox: { x0: 0, y0: 40, x1: 80, y1: 52 } },
        ];

        expect(selectChangedTranslations(lines, ['中文标题', '你好世界'])).toEqual([{
            text: '你好世界',
            bbox: { x0: 0, y0: 20, x1: 80, y1: 32 },
        }]);
    });

    it('优先使用紧凑的 OCR word 框，避免整行控件被合并成一个大框', () => {
        const lines = normalizeOcrLines([
            {
                paragraphs: [{
                    lines: [{
                        text: 'ignored wide line',
                        bbox: { x0: 0, y0: 0, x1: 200, y1: 30 },
                        words: [
                            { text: 'Translate', confidence: 90, bbox: { x0: 20, y0: 8, x1: 75, y1: 20 } },
                            { text: 'the', confidence: 90, bbox: { x0: 80, y0: 8, x1: 100, y1: 20 } },
                            { text: 'following', confidence: 90, bbox: { x0: 106, y0: 8, x1: 164, y1: 20 } },
                            { text: 'button', confidence: 90, bbox: { x0: 240, y0: 8, x1: 280, y1: 20 } },
                        ],
                    }],
                }],
            },
        ]);

        expect(lines).toEqual([
            { text: 'Translate the following', bbox: { x0: 20, y0: 8, x1: 164, y1: 20 } },
            { text: 'button', bbox: { x0: 240, y0: 8, x1: 280, y1: 20 } },
        ]);
    });

    it('过滤低置信度和无效 word，并按 CJK 连写规则合并同一行', () => {
        const lines = normalizeOcrLines([
            {
                paragraphs: [{
                    lines: [{
                        text: 'ignored',
                        bbox: { x0: 0, y0: 0, x1: 80, y1: 20 },
                        words: [
                            { text: ' 你 ', bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } },
                            { text: ' 好 ', confidence: 90, bbox: { x0: 11, y0: 0, x1: 21, y1: 10 } },
                            { text: 'bad', confidence: 10, bbox: { x0: 22, y0: 0, x1: 32, y1: 10 } },
                            { text: 'flat', confidence: 90, bbox: { x0: 33, y0: 0, x1: 33, y1: 10 } },
                        ],
                    }],
                }],
            },
        ]);

        expect(lines).toEqual([
            {text: '你好', bbox: {x0: 0, y0: 0, x1: 21, y1: 10}},
        ]);
    });

    it('对无效输入原样复制，并为无法扩散的整图遮罩保留原像素', () => {
        const source = new Uint8ClampedArray([12, 34, 56, 255]);
        const line = {text: 'x', bbox: {x0: 0, y0: 0, x1: 1, y1: 1}};

        expect(inpaintTextRegions(source, 0, 1, [line])).toEqual(source);
        expect(inpaintTextRegions(source, 1, 0, [line])).toEqual(source);
        expect(inpaintTextRegions(new Uint8ClampedArray([1, 2, 3]), 1, 1, [line])).toEqual(new Uint8ClampedArray([1, 2, 3]));
        expect(inpaintTextRegions(source, 1, 1, [])).toEqual(source);
        expect(inpaintTextRegions(source, 1, 1, [line])).toEqual(source);
    });

    it('从 OCR 框外围选择主背景色并自动选择可读文字颜色', () => {
        const pixels = new Uint8ClampedArray(3 * 3 * 4);
        for (let index = 0; index < pixels.length; index += 4) {
            pixels[index] = 245;
            pixels[index + 1] = 245;
            pixels[index + 2] = 245;
            pixels[index + 3] = 255;
        }
        // 放入一个少数深色像素，确保主色选择不会被单个噪点覆盖。
        pixels[0] = 16;
        pixels[1] = 16;
        pixels[2] = 16;

        expect(getImageTextBackgroundColor(pixels, 3, 3, {x0: 1, y0: 1, x1: 2, y1: 2}))
            .toBe('rgb(240,240,240)');
        expect(getImageTextBackgroundColor(new Uint8ClampedArray(), 0, 0, {x0: 0, y0: 0, x1: 0, y1: 0}))
            .toBe('rgb(255,255,255)');
        expect(getImageTextColor('rgb(240,240,240)')).toBe('#111827');
        expect(getImageTextColor('rgb(16,16,16)')).toBe('#ffffff');
        expect(getImageTextColor('invalid')).toBe('#111827');
    });

    it('用周边像素修复文字区域，而不是用整块纯色覆盖', () => {
        const width = 9;
        const height = 5;
        const source = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                const offset = (y * width + x) * 4;
                source[offset] = x * 20;
                source[offset + 1] = y * 30;
                source[offset + 2] = 100;
                source[offset + 3] = 255;
            }
        }
        // 模拟文字像素：修复后不应继续保留这个明显的黑色残影。
        const textPixel = (2 * width + 4) * 4;
        source[textPixel] = 0;
        source[textPixel + 1] = 0;
        source[textPixel + 2] = 0;
        const result = inpaintTextRegions(source, width, height, [{
            text: 'text',
            bbox: { x0: 3, y0: 1, x1: 6, y1: 4 },
        }]);

        const centre = textPixel;
        expect(result[centre]).toBeGreaterThan(source[centre]);
        expect(result[centre + 1]).toBeGreaterThan(source[centre + 1]);
        expect(result[centre + 2]).toBe(100);
        expect(result[centre + 3]).toBe(255);
    });
});
