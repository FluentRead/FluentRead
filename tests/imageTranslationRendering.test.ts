import {afterEach, describe, expect, it, vi} from 'vitest';
import {
    drawTranslatedImageText,
    getImageTextBackgroundColor,
    getImageTextColor,
    layoutImageTranslationText,
} from '@/src/features/image-translation/services/rendering';

const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
const measure = (text: string, fontSize: number) => Array.from(segmenter.segment(text)).length * fontSize;

function canvasContext() {
    const context = {
        font: '', save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
        measureText: vi.fn((text: string) => ({width: measure(text, Number(context.font.match(/([\d.]+)px/)![1]))})),
        fillText: vi.fn(), strokeText: vi.fn(),
    };
    return context;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

describe('图片译文排版与绘制', () => {
    it('重复长段落减少测宽次数，完整单词换行后无需逐字测量', () => {
        const text = 'Translate each complete paragraph and keep the original reading order. '.repeat(30);
        const countedMeasure = vi.fn((value: string, size: number) => Array.from(value).length * size * 0.55);
        const layout = layoutImageTranslationText(text, 200, 100, countedMeasure, 16);
        expect(layout.lines.join(' ').replace(/\s+/g, ' ').trim()).toBe(text.trim());
        expect(countedMeasure.mock.calls.length).toBeLessThan(1200);
        expect(layout.lineHeight * layout.lines.length).toBeLessThanOrEqual(100);
    });

    it('长单词字素只分割一次，多个字号搜索仍保留组合字符', () => {
        const split = vi.spyOn(Intl.Segmenter.prototype, 'segment');
        const text = 'e\u0301'.repeat(600) + '👨‍👩‍👧‍👦'.repeat(50);
        const layout = layoutImageTranslationText(text, 200, 100, (value, size) => Array.from(value).length * size * 0.55, 16);
        expect(layout.lines.join('')).toBe(text);
        expect(split).toHaveBeenCalledOnce();
    });

    it('零宽度也命中缓存，超过缓存容量的唯一文字仍完整排版', () => {
        const zero = vi.fn(() => 0);
        expect(layoutImageTranslationText('zero', 10, 10, zero).lines).toEqual(['zero']);
        expect(zero).toHaveBeenCalledOnce();
        const text = Array.from({length: 600}, (_, i) => `word${i}`).join(' ');
        const layout = layoutImageTranslationText(text, 100_000, 100, (value, size) => value.length * size, 1);
        expect(layout.lines).toEqual([text]);
    });
    it.each(['left', 'right', 'center'] as const)('整段回填保留 %s 对齐、常规字重和源文字字号上限', alignment => {
        const context = canvasContext();
        drawTranslatedImageText(context as unknown as CanvasRenderingContext2D, '完整段落回填文字', 10, 20, 100, 60, 'rgb(255,255,255)', 12, alignment);
        expect(context.font.startsWith('400 ')).toBe(true);
        expect(Number(context.font.match(/([\d.]+)px/)![1])).toBeLessThanOrEqual(12);
        for (const [, x, y] of context.fillText.mock.calls) {
            expect(x).toBe(alignment === 'left' ? 12 : alignment === 'right' ? 108 : 60);
            expect(y).toBeGreaterThan(20); expect(y).toBeLessThan(80);
        }
    });
    it('中英日混排保留空格、词语和标点，大字号不再固定限制为 30px', () => {
        const text = '使用 FluentRead 翻译 AI images；こんにちは';
        const layout = layoutImageTranslationText(text, 3000, 100, measure);
        expect(layout.lines).toEqual([text]);
        expect(layout.fontSize).toBeGreaterThan(30);
        expect(layout.lineHeight).toBeLessThanOrEqual(100);
    });

    it('长段落允许超过三行且全部保留，每一行和总高度均在 OCR 框内', () => {
        const text = '这是用于验证完整译文不会被三行上限截掉的一段长文字。'.repeat(5);
        const layout = layoutImageTranslationText(text, 80, 80, measure);
        expect(layout.lines.length).toBeGreaterThan(3);
        expect(layout.lines.join('')).toBe(text);
        expect(layout.lines.every(line => measure(line, layout.fontSize) <= 80)).toBe(true);
        expect(layout.lineHeight * layout.lines.length).toBeLessThanOrEqual(80);
    });

    it('长单词按字素换行，组合字符和家庭 emoji 不会被拆散', () => {
        const text = 'e\u0301'.repeat(8) + '👨‍👩‍👧‍👦'.repeat(8);
        const layout = layoutImageTranslationText(text, 20, 60, measure);
        expect(layout.lines.join('')).toBe(text);
        expect(layout.lines.every(line => !line.startsWith('\u0301') && !line.includes('\ufffd'))).toBe(true);
        expect(layout.lines.every(line => Array.from(segmenter.segment(line)).every(part => ['e\u0301', '👨‍👩‍👧‍👦'].includes(part.segment))))
            .toBe(true);
    });

    it('日文组合浊点保持与原假名相连，不在换行时拆开', () => {
        const text = 'か\u3099'.repeat(12);
        const layout = layoutImageTranslationText(text, 20, 50, measure);
        expect(layout.lines.join('')).toBe(text);
        expect(layout.lines.every(line => !line.startsWith('\u3099') && line.endsWith('\u3099'))).toBe(true);
    });

    it('保留显式段落和空行，合并段落内多余空白', () => {
        const layout = layoutImageTranslationText('  Hello   world\r\n\rNext\n\nlast  ', 200, 80, measure);
        expect(layout.lines).toEqual(['Hello world', '', 'Next', '', 'last']);
        expect(layout.lineHeight * layout.lines.length).toBeLessThanOrEqual(80);
    });

    it('小框也能完整容纳长译文，不强加导致越界的最小字号', () => {
        const text = 'longword'.repeat(30);
        const layout = layoutImageTranslationText(text, 8, 4, measure);
        expect(layout.fontSize).toBeLessThan(1);
        expect(layout.lines.join('')).toBe(text);
        expect(layout.lines.every(line => measure(line, layout.fontSize) <= 8)).toBe(true);
        expect(layout.lineHeight * layout.lines.length).toBeLessThanOrEqual(4);
    });

    it('拒绝空文字和无效绘制尺寸', () => {
        expect(layoutImageTranslationText(' ', 10, 10, measure).lines).toEqual([]);
        for (const [width, height] of [[NaN, 10], [10, Infinity], [0, 10], [10, -1]]) {
            expect(layoutImageTranslationText('text', width, height, measure)).toEqual({lines: [], fontSize: 0, lineHeight: 0});
        }
    });

    it('旧环境缺少字素分割器时仍按完整 Unicode 码点换行', async () => {
        vi.stubGlobal('Intl', {Segmenter: undefined});
        const {layoutImageTranslationText: fallbackLayout} = await import('@/src/features/image-translation/services/rendering');
        const text = '😀'.repeat(10);
        const layout = fallbackLayout(text, 15, 30, (value, size) => Array.from(value).length * size);
        expect(layout.lines.join('')).toBe(text);
        expect(layout.lines.every(line => !line.includes('\ufffd'))).toBe(true);
    });

    it('真实字号绘制和裁剪限制在原区域内，绘制后恢复上下文状态', () => {
        const context = canvasContext();
        drawTranslatedImageText(context as unknown as CanvasRenderingContext2D, '一个较长的译文 Mixed words', 10, 20, 100, 30, 'rgb(240,240,240)');
        expect(context.save).toHaveBeenCalledOnce();
        expect(context.rect).toHaveBeenCalledWith(10, 20, 100, 30);
        expect(context.clip).toHaveBeenCalledOnce();
        expect(context.restore).toHaveBeenCalledOnce();
        expect(context.fillText).toHaveBeenCalled();
        for (const call of context.fillText.mock.calls as unknown as Array<[string, number, number]>) {
            expect(call).toHaveLength(3);
            expect(call[1]).toBe(60);
            expect(call[2]).toBeGreaterThanOrEqual(20);
            expect(call[2]).toBeLessThanOrEqual(50);
        }
        expect(context.strokeText.mock.calls).toEqual(context.fillText.mock.calls);
    });

    it('无可绘文字和绘制异常都会释放 Canvas 状态', () => {
        const empty = canvasContext();
        drawTranslatedImageText(empty as unknown as CanvasRenderingContext2D, ' ', 0, 0, 10, 10, 'rgb(0,0,0)');
        expect(empty.fillText).not.toHaveBeenCalled();
        expect(empty.restore).toHaveBeenCalledOnce();
        const failing = canvasContext();
        failing.fillText.mockImplementation(() => {throw new Error('render failed');});
        expect(() => drawTranslatedImageText(failing as unknown as CanvasRenderingContext2D, 'text', 0, 0, 100, 10, 'rgb(0,0,0)'))
            .toThrow('render failed');
        expect(failing.restore).toHaveBeenCalledOnce();
    });
});

describe('图片译文颜色', () => {
    it('透明外围不会把背景主色误判为黑色，整图没有外围时使用可读兜底', () => {
        const pixels = new Uint8ClampedArray(8 * 8 * 4);
        pixels.set([200, 220, 240, 255], 0);
        expect(getImageTextBackgroundColor(pixels, 8, 8, {x0: 3, y0: 3, x1: 5, y1: 5})).toBe('rgb(208,224,240)');
        expect(getImageTextBackgroundColor(pixels, 8, 8, {x0: 0, y0: 0, x1: 8, y1: 8})).toBe('rgb(255,255,255)');
        expect(getImageTextBackgroundColor(new Uint8ClampedArray(16), 2, 2, {x0: 1, y0: 1, x1: 2, y1: 2}))
            .toBe('rgb(255,255,255)');
    });

    it('限制无效尺寸和坐标，避免无限循环或读取越界像素', () => {
        const pixels = new Uint8ClampedArray(16);
        for (const [width, height] of [[Infinity, 2], [0, 2], [2, 0], [3, 3], [1.5, 2], [2, 1.5]]) {
            expect(getImageTextBackgroundColor(pixels, width, height, {x0: 0, y0: 0, x1: 1, y1: 1})).toBe('rgb(255,255,255)');
        }
        expect(getImageTextBackgroundColor(pixels, 2, 2, {x0: NaN, y0: 0, x1: 1, y1: 1})).toBe('rgb(255,255,255)');
    });

    it('使用相对亮度比较真实对比度，绿色选择深色、蓝色选择白色', () => {
        expect(getImageTextColor('rgb(0,255,0)')).toBe('#111827');
        expect(getImageTextColor('rgb(0,0,255)')).toBe('#ffffff');
        expect(getImageTextColor('rgb(0,0,0)')).toBe('#ffffff');
        expect(getImageTextColor('invalid')).toBe('#111827');
        expect(getImageTextColor('rgb(12,34)')).toBe('#111827');
    });
});
