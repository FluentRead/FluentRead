/**
 * @file src/features/share-card/render.ts
 * 文件职责：用本地 Canvas 排版双语摘录，生成预览与导出共用的高清 2x PNG（无品牌水印标记）。
 * 主要内容：相同译文保留原文且不重复展示；按八套主题字体真实度量换行，月白与蓝图双栏，晴空与落日居中，珊瑚/流光/抹茶/书页采用精致现代编排；容量不足时拒绝裁切，取消或失败时释放位图与编码监听。
 * 模块边界：不截图宿主页面、不加载远程字体或图片、不上传文字；消费摘录与外观，装饰委托 themes，剪贴板及下载由导出适配器负责。
 */
import type {ShareCardPreferences} from '@/src/core/config/shareCard';
import {hasDistinctTranslation} from '@/src/core/translation/result';
import {cardGraphemes, cleanCardText, SHARE_CARD_MAX_HEIGHT, validateCardExcerpt, wrapCardText, type ShareCardExcerpt} from './core';
import {CARD_SECONDARY_FONT, CARD_THEMES, cardPrismInk, paintCardBackground} from './themes';

export class ShareCardRenderError extends Error {
    constructor(public readonly reason: 'empty' | 'long' | 'square' | 'canvas') { super(reason); }
}

const WIDTH = 640;
const SCALE = 2;

export interface RenderedShareCard {canvas: HTMLCanvasElement; blob: Blob; width: number; height: number}

function drawPillRule(context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    context.beginPath();
    if (typeof context.roundRect === 'function') context.roundRect(x, y, w, h, h / 2);
    else context.rect(x, y, w, h);
    context.fill();
}

export async function renderShareCard(excerpt: ShareCardExcerpt, preferences: ShareCardPreferences, signal?: AbortSignal, _brandName = ''): Promise<RenderedShareCard> {
    signal?.throwIfAborted();
    const invalid = validateCardExcerpt(excerpt);
    if (invalid) throw new ShareCardRenderError(invalid);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) { canvas.width = 0; canvas.height = 0; throw new ShareCardRenderError('canvas'); }
    try {
        const theme = CARD_THEMES[preferences.theme];
        const {inset} = theme;
        const fullWidth = WIDTH - inset * 2;
        const distinct = hasDistinctTranslation(excerpt.original, excerpt.translation);
        const columns = distinct && (preferences.theme === 'pearl' || preferences.theme === 'blueprint');
        const centered = preferences.theme === 'sky' || preferences.theme === 'sunset';
        const columnGap = 44;
        const textWidth = columns ? (fullWidth - columnGap) / 2 : fullWidth;
        const firstFont = (size: number) => theme.font.replace('{size}', String(size));
        const secondFont = (size: number) => `400 ${size}px ${CARD_SECONDARY_FONT}`;
        const firstText = cleanCardText(distinct && preferences.translationFirst ? excerpt.translation : excerpt.original);
        const secondText = distinct ? cleanCardText(preferences.translationFirst ? excerpt.original : excerpt.translation) : '';
        let fontSize = {small: 22, medium: 26, large: 30}[preferences.fontSize];
        const wrap = (text: string, font: string) => {
            context.font = font;
            return wrapCardText(text, textWidth, value => context.measureText(value).width);
        };
        let first: string[] = [], second: string[] = [], contentHeight = 0;
        let footer = '';
        if (preferences.showSource && excerpt.source.trim()) {
            // 保持原有 160 个 UTF-16 单元上限，边界只落在完整字素之后。
            for (const grapheme of cardGraphemes(cleanCardText(excerpt.source))) {
                if (footer.length + grapheme.length > 160) break;
                footer += grapheme;
            }
        }
        context.font = secondFont(11.5);
        const footerLines = footer ? wrapCardText(footer, fullWidth, value => context.measureText(value).width) : [];
        const footerBlockHeight = footerLines.length ? footerLines.length * 18 + 20 : 0;
        const gap = distinct ? 34 : 0;
        const baseTop = 58;
        const baseBottom = footerBlockHeight ? 42 : 54;
        const padding = baseTop + baseBottom + (columns ? 0 : gap) + footerBlockHeight;
        while (true) {
            first = wrap(firstText, firstFont(fontSize));
            const secondSize = Math.max(15, fontSize - 7);
            second = distinct ? wrap(secondText, secondFont(secondSize)) : [];
            const firstHeight = first.length * fontSize * 1.46;
            const secondHeight = second.length * secondSize * 1.66;
            contentHeight = columns ? Math.max(firstHeight, secondHeight) : firstHeight + secondHeight;
            if (preferences.format !== 'square' || contentHeight + padding <= WIDTH) break;
            fontSize -= 1;
            if (fontSize < 20) throw new ShareCardRenderError('square');
        }
        const height = preferences.format === 'square' ? WIDTH : Math.max(300, Math.ceil(contentHeight + padding));
        if (height > SHARE_CARD_MAX_HEIGHT) throw new ShareCardRenderError('long');
        canvas.width = WIDTH * SCALE;
        canvas.height = Math.ceil(height * SCALE);
        context.scale(SCALE, SCALE);

        const extraSpace = Math.max(0, height - contentHeight - padding);
        const top = baseTop + extraSpace / 2;
        const split = top + first.length * fontSize * 1.46 + 18;
        paintCardBackground(context, preferences.theme, WIDTH, height, split);

        context.textBaseline = 'top';
        let y = top;
        const drawLines = (lines: string[], font: string, lineHeight: number, color: string | CanvasGradient, x: number = inset) => {
            context.font = font;
            context.fillStyle = color;
            // 以每段首个强方向字符判定方向，数字前缀不会强制阿拉伯语变成从左到右。
            const strong = lines.join('').match(/[\p{L}]/u)?.[0] ?? '';
            const rtl = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u.test(strong);
            context.direction = rtl ? 'rtl' : 'ltr';
            context.textAlign = centered ? 'center' : rtl ? 'right' : 'left';
            for (const line of lines) {
                context.fillText(line, centered ? WIDTH / 2 : rtl ? x + textWidth : x, y);
                y += lineHeight;
            }
            context.direction = 'ltr';
            context.textAlign = 'left';
        };

        const ink = preferences.theme === 'prism' ? cardPrismInk(context, WIDTH, top) : theme.ink;
        drawLines(first, firstFont(fontSize), fontSize * 1.46, ink);

        const secondSize = Math.max(15, fontSize - 7);
        if (columns) {
            context.fillStyle = theme.divider;
            context.fillRect(WIDTH / 2, top + 2, 1, Math.max(24, contentHeight - 4));
            y = top;
        } else if (distinct) {
            context.fillStyle = theme.divider;
            drawPillRule(context, centered ? WIDTH / 2 - 14 : inset, y + 12, 28, 2.5);
            y += gap;
        }

        drawLines(second, secondFont(secondSize), secondSize * 1.66, theme.secondary, columns ? WIDTH / 2 + columnGap / 2 : inset);

        if (footerLines.length) {
            const footerStart = height - baseBottom - footerLines.length * 18;
            context.fillStyle = theme.footerLine;
            context.fillRect(inset, footerStart - 12, fullWidth, 1);
            context.font = secondFont(11.5);
            context.fillStyle = theme.muted;
            context.textAlign = centered ? 'center' : 'left';
            let fy = footerStart;
            for (const line of footerLines) {
                context.fillText(line, centered ? WIDTH / 2 : inset, fy);
                fy += 18;
            }
            context.textAlign = 'left';
        }

        const blob = await new Promise<Blob>((resolve, reject) => {
            const abort = () => { signal?.removeEventListener('abort', abort); reject(signal?.reason); };
            signal?.addEventListener('abort', abort, {once: true});
            try {
                canvas.toBlob(value => {
                    signal?.removeEventListener('abort', abort);
                    if (value) resolve(value);
                    else reject(new ShareCardRenderError('canvas'));
                }, 'image/png');
            } catch (error) { signal?.removeEventListener('abort', abort); reject(error); }
        });
        return {canvas, blob, width: canvas.width, height: canvas.height};
    } catch (error) {
        // toBlob 已取得快照；失败/取消后释放本地位图，迟到回调不能重建资源。
        canvas.width = 0; canvas.height = 0;
        throw error;
    }
}
