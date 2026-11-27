/**
 * @file src/features/share-card/themes.ts
 * 文件职责：定义分享卡片的八套单层现代编排视觉语言，并绘制克制、无套娃边框的背景材质。
 * 主要内容：珊瑚、晴空、流光、月白（双栏）、抹茶、书页、落日、蓝图（双栏）；单一纯净画布承载双语正文，避免多层套框。
 * 模块边界：只在已确定尺寸的 Canvas 上绘图，不测量或裁切正文，不访问配置存储、网络及宿主页面，也不加载外部设计素材。
 */
import type {ShareCardTheme} from '@/src/core/config/shareCard';

const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
const SERIF = 'Georgia, "Songti SC", "Noto Serif CJK SC", "SimSun", serif';

export const CARD_THEMES = {
    coral: {
        background: '#fff7f9',
        ink: '#172033',
        secondary: '#4d576b',
        accent: '#ef4776',
        muted: '#7d8699',
        divider: 'rgba(239, 71, 118, 0.30)',
        footerLine: 'rgba(23, 32, 51, 0.08)',
        font: `600 {size}px ${SERIF}`,
        inset: 48,
    },
    sky: {
        background: '#eaf3ff',
        ink: '#142d4c',
        secondary: '#3d5c7e',
        accent: '#3b82c4',
        muted: '#617f9e',
        divider: 'rgba(59, 130, 196, 0.34)',
        footerLine: 'rgba(20, 45, 76, 0.09)',
        font: `600 {size}px ${SANS}`,
        inset: 48,
    },
    prism: {
        background: '#111520',
        ink: '#f3f5fa',
        secondary: '#b6c1d6',
        accent: '#f46590',
        muted: '#8692a8',
        divider: 'rgba(244, 101, 144, 0.55)',
        footerLine: 'rgba(255, 255, 255, 0.10)',
        font: `600 {size}px ${SANS}`,
        inset: 48,
    },
    pearl: {
        background: '#ffffff',
        ink: '#172033',
        secondary: '#525c70',
        accent: '#78849e',
        muted: '#7e889b',
        divider: '#e2e6ef',
        footerLine: 'rgba(23, 32, 51, 0.08)',
        font: `600 {size}px ${SANS}`,
        inset: 48,
    },
    moss: {
        background: '#eff4ea',
        ink: '#1f3528',
        secondary: '#4c6254',
        accent: '#567a58',
        muted: '#718677',
        divider: 'rgba(86, 122, 88, 0.34)',
        footerLine: 'rgba(31, 53, 40, 0.09)',
        font: `500 {size}px ${SERIF}`,
        inset: 54,
    },
    linen: {
        background: '#f8f3e8',
        ink: '#2d241c',
        secondary: '#655647',
        accent: '#a67247',
        muted: '#8a7a69',
        divider: 'rgba(166, 114, 71, 0.36)',
        footerLine: 'rgba(45, 36, 28, 0.09)',
        font: `500 {size}px ${SERIF}`,
        inset: 50,
    },
    sunset: {
        background: '#fdf0e6',
        ink: '#3d2222',
        secondary: '#6e4945',
        accent: '#d46a59',
        muted: '#8f6862',
        divider: 'rgba(212, 106, 89, 0.36)',
        footerLine: 'rgba(61, 34, 34, 0.09)',
        font: `600 {size}px ${SANS}`,
        inset: 48,
    },
    blueprint: {
        background: '#112338',
        ink: '#eff7ff',
        secondary: '#b8d3e8',
        accent: '#6db5e3',
        muted: '#89aec9',
        divider: 'rgba(148, 198, 232, 0.28)',
        footerLine: 'rgba(148, 198, 232, 0.16)',
        font: `500 {size}px ${SANS}`,
        inset: 48,
    },
} as const satisfies Record<ShareCardTheme, unknown>;

export const CARD_SECONDARY_FONT = SANS;

function drawRoundedRect(context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number): void {
    context.beginPath();
    if (typeof context.roundRect === 'function') context.roundRect(x, y, w, h, radius);
    else context.rect(x, y, w, h);
}

function glow(context: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string, width: number, height: number): void {
    const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, `${color.slice(0, 7)}00`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
}

export function paintCardBackground(context: CanvasRenderingContext2D, theme: ShareCardTheme, width: number, height: number, _split: number): void {
    context.fillStyle = CARD_THEMES[theme].background;
    context.fillRect(0, 0, width, height);
    context.save();

    if (theme === 'coral') {
        const bg = context.createLinearGradient(0, 0, width, height);
        bg.addColorStop(0, '#fffbfc');
        bg.addColorStop(1, '#fff0f4');
        context.fillStyle = bg;
        context.fillRect(0, 0, width, height);

        const bar = context.createLinearGradient(48, 30, 80, 30);
        bar.addColorStop(0, '#f45686');
        bar.addColorStop(1, '#e53268');
        context.fillStyle = bar;
        drawRoundedRect(context, 48, 30, 28, 3, 2);
        context.fill();
    } else if (theme === 'sky') {
        const gradient = context.createLinearGradient(0, 0, width * 0.4, height);
        gradient.addColorStop(0, '#f4f9ff');
        gradient.addColorStop(0.55, '#e5f1ff');
        gradient.addColorStop(1, '#d3e7fd');
        context.fillStyle = gradient;
        context.fillRect(0, 0, width, height);
        glow(context, width * 0.82, 20, 260, '#ffffffb0', width, height);
    } else if (theme === 'prism') {
        const bg = context.createLinearGradient(0, 0, width, height);
        bg.addColorStop(0, '#10141e');
        bg.addColorStop(1, '#161b29');
        context.fillStyle = bg;
        context.fillRect(0, 0, width, height);
        glow(context, 90, 28, 250, '#4f6cf032', width, height);
        glow(context, width - 64, height - 20, 260, '#e84d852c', width, height);

        const prismBar = context.createLinearGradient(48, 30, 92, 30);
        prismBar.addColorStop(0, '#77b7ff');
        prismBar.addColorStop(0.5, '#b09cff');
        prismBar.addColorStop(1, '#f46590');
        context.fillStyle = prismBar;
        drawRoundedRect(context, 48, 30, 40, 3, 2);
        context.fill();
    } else if (theme === 'pearl') {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.strokeStyle = '#e5e8f0';
        context.lineWidth = 1;
        drawRoundedRect(context, 0.5, 0.5, width - 1, height - 1, 2);
        context.stroke();
    } else if (theme === 'moss') {
        const bg = context.createLinearGradient(0, 0, 0, height);
        bg.addColorStop(0, '#f4f7f0');
        bg.addColorStop(1, '#e9f0e2');
        context.fillStyle = bg;
        context.fillRect(0, 0, width, height);

        context.fillStyle = '#6b8f6d';
        drawRoundedRect(context, 30, 44, 2.5, Math.max(40, height - 88), 2);
        context.fill();
    } else if (theme === 'linen') {
        const bg = context.createLinearGradient(0, 0, 0, height);
        bg.addColorStop(0, '#fbf8f1');
        bg.addColorStop(1, '#f4ecdc');
        context.fillStyle = bg;
        context.fillRect(0, 0, width, height);

        context.fillStyle = '#a67247';
        drawRoundedRect(context, 50, 30, 24, 2.5, 2);
        context.fill();
    } else if (theme === 'sunset') {
        const gradient = context.createLinearGradient(0, 0, width * 0.3, height);
        gradient.addColorStop(0, '#fff8f1');
        gradient.addColorStop(0.55, '#fce7db');
        gradient.addColorStop(1, '#f6d2c7');
        context.fillStyle = gradient;
        context.fillRect(0, 0, width, height);
        glow(context, width * 0.5, 10, 260, '#ffffffa8', width, height);
    } else {
        // blueprint：建筑深靛微网格 + 四角极细校准十字（无套娃内框）
        const bg = context.createLinearGradient(0, 0, width, height);
        bg.addColorStop(0, '#102136');
        bg.addColorStop(1, '#152c47');
        context.fillStyle = bg;
        context.fillRect(0, 0, width, height);

        context.strokeStyle = 'rgba(165, 208, 238, 0.055)';
        context.lineWidth = 0.5;
        for (let x = 20; x < width; x += 28) {
            context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke();
        }
        for (let y = 20; y < height; y += 28) {
            context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
        }

        context.strokeStyle = 'rgba(148, 198, 232, 0.45)';
        context.lineWidth = 1;
        for (const [cx, cy] of [[18, 18], [width - 18, 18], [18, height - 18], [width - 18, height - 18]] as const) {
            context.beginPath();
            context.moveTo(cx - 4, cy); context.lineTo(cx + 4, cy);
            context.moveTo(cx, cy - 4); context.lineTo(cx, cy + 4);
            context.stroke();
        }
    }

    context.restore();
}

export function cardPrismInk(context: CanvasRenderingContext2D, width: number, top: number): CanvasGradient {
    const gradient = context.createLinearGradient(48, top, width - 48, top + 64);
    gradient.addColorStop(0, '#f5f8ff');
    gradient.addColorStop(0.55, '#eef2ff');
    gradient.addColorStop(1, '#ffeef5');
    return gradient;
}
