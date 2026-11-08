import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {normalizeShareCardPreferences, SHARE_CARD_THEMES} from '@/src/core/config/shareCard';
import {renderShareCard} from '@/src/features/share-card/render';
let canvas: {width: number; height: number; getContext: Mock; toBlob: Mock};
let painted: Array<{text: string; x: number; y: number}>;
beforeEach(() => {
    painted = [];
    const ctx = {font: '', measureText(text: string) {return {width: Array.from(text).length * Number(this.font.match(/([\d.]+)px/)?.[1]) * .6};}, scale: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), bezierCurveTo: vi.fn(), closePath: vi.fn(), arc: vi.fn(), roundRect: vi.fn(), rect: vi.fn(), fill: vi.fn(), stroke: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), fillText(text: string, x: number, y: number) {painted.push({text, x, y});}, createRadialGradient: () => ({addColorStop: vi.fn()}), createLinearGradient: () => ({addColorStop: vi.fn()})};
    canvas = {width: 0, height: 0, getContext: vi.fn(() => ctx), toBlob: vi.fn(fn => fn(new Blob(['png'], {type: 'image/png'})))};
    vi.stubGlobal('document', {createElement: () => canvas});
});
afterEach(() => vi.unstubAllGlobals());
describe('卡片排版边界', () => {
    it.each(SHARE_CARD_THEMES)('%s 支持方形和隐藏页脚，超长摘录不会裁切导出', async theme => {
        const result = await renderShareCard({original: 'Hello', translation: '你好', source: 'private'}, normalizeShareCardPreferences({theme, format: 'square', showSource: false, showBrand: false}));
        expect(result.width).toBe(result.height); expect(painted.map(item => item.text)).not.toContain('private');
        await expect(renderShareCard({original: 'a\n'.repeat(90), translation: '译', source: ''}, normalizeShareCardPreferences({theme}))).rejects.toMatchObject({reason: 'long'});
    });
    it.each(SHARE_CARD_THEMES)('%s 原译文完整保留，高清导出且正文位于画面内', async theme => {
        const result = await renderShareCard({original: 'A sentence worth keeping.', translation: '一句值得珍藏的话。', source: 'example.com'}, normalizeShareCardPreferences({theme}));
        expect(result.width).toBe(960); expect(result.height).toBeGreaterThanOrEqual(450);
        const text = painted.map(item => item.text).join(' ');
        for (const expected of ['A sentence worth keeping.', '一句值得珍藏的话。', 'example.com', '流畅阅读']) expect(text).toContain(expected);
        expect(painted.every(item => item.y >= 0 && item.y < result.height / 1.5 - 24)).toBe(true);
    });
    it('没有 roundRect 的浏览器仍能生成月白图片', async () => {
        canvas.getContext().roundRect = undefined;
        const result = await renderShareCard({original: 'Hello', translation: '你好', source: ''}, normalizeShareCardPreferences({theme: 'pearl'}));
        expect(result.blob.type).toBe('image/png');
        expect(canvas.getContext().rect).toHaveBeenCalled();
    });
    it.each(['pearl', 'blueprint'] as const)('%s 双栏各自换行，译文在前时左右互换且来源不进入正文区', async theme => {
        await renderShareCard({original: 'Keep reading', translation: '继续阅读', source: 'example.com'}, normalizeShareCardPreferences({theme, translationFirst: true}));
        const first = painted.find(item => item.text === '继续阅读')!;
        const second = painted.find(item => item.text === 'Keep reading')!;
        expect(first.x).toBeLessThan(320); expect(second.x).toBeGreaterThan(320);
        expect(first.y).toBe(second.y);
        expect(painted.find(item => item.text === 'example.com')!.y).toBeGreaterThan(first.y + 80);
    });
    it('方形缩字后仍放不下明确失败，自适应过高也不能裁切', async () => {
        const text = {original: '字'.repeat(600), translation: '文'.repeat(600), source: ''};
        await expect(renderShareCard(text, normalizeShareCardPreferences({format: 'square'}))).rejects.toMatchObject({reason: 'square'});
        await expect(renderShareCard({original: 'a\n'.repeat(90), translation: '译', source: ''}, normalizeShareCardPreferences())).rejects.toMatchObject({reason: 'long'});
        expect(canvas.toBlob).not.toHaveBeenCalled();
    });
    it('译文在前且来源和署名关闭时不绘制隐藏内容', async () => {
        await renderShareCard({original: 'Hello', translation: '你好', source: 'PRIVATE'}, normalizeShareCardPreferences({translationFirst: true, showSource: false, showBrand: false, format: 'square'}));
        expect(canvas.width).toBe(canvas.height);
        const texts = painted.map(item => item.text);
        expect(texts.indexOf('你好')).toBeLessThan(texts.indexOf('Hello'));
        expect(texts).not.toContain('PRIVATE'); expect(texts).not.toContain('流畅阅读'); expect(texts).not.toContain('FluentRead');
    });
    it('Canvas 不可用或 PNG 生成失败时返回错误', async () => {
        const value = {original: 'Hello', translation: '你好', source: ''};
        canvas.toBlob.mockImplementation(fn => fn(null));
        await expect(renderShareCard(value, normalizeShareCardPreferences())).rejects.toMatchObject({reason: 'canvas'});
        canvas.getContext.mockReturnValue(null);
        await expect(renderShareCard(value, normalizeShareCardPreferences())).rejects.toMatchObject({reason: 'canvas'});
    });
    it('品牌默认中文与显式外语署名只改变页脚，尺寸和正文位置保持不变', async () => {
        const excerpt = {original: 'Literal FluentRead original', translation: '用户译文 FluentRead', source: 'example.test'};
        const preferences = normalizeShareCardPreferences();
        const chinese = await renderShareCard(excerpt, preferences);
        const first = [...painted]; painted = [];
        const foreign = await renderShareCard(excerpt, preferences, undefined, 'FluentRead');
        expect(painted.slice(0, -1)).toEqual(first.slice(0, -1));
        expect(first.at(-1)!.text).toBe('流畅阅读'); expect(painted.at(-1)!.text).toBe('FluentRead');
        expect(painted.at(-1)!.x).toBe(first.at(-1)!.x); expect(painted.at(-1)!.y).toBe(first.at(-1)!.y);
        expect({width: foreign.width, height: foreign.height}).toEqual({width: chinese.width, height: chinese.height});
        painted = [];
        await renderShareCard(excerpt, normalizeShareCardPreferences({showBrand: false}), undefined, 'PRIVATE BRAND');
        expect(painted.map(item => item.text)).not.toContain('PRIVATE BRAND');
    });
});

it.each(SHARE_CARD_THEMES)('相同译文在 %s 分享预览与导出只绘制一次', async theme => {
    await renderShareCard({original: 'Café', translation: 'Cafe\u0301', source: ''}, normalizeShareCardPreferences({theme, translationFirst: true, showBrand: false}));
    expect(painted.map(line => line.text)).toEqual(['Café']);
});
