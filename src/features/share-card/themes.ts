/**
 * @file src/features/share-card/themes.ts
 * 文件职责：定义分享卡片的八套视觉语言，并绘制不承载用户内容的背景材质。
 * 主要内容：珊瑚、晴空、流光、月白及抹茶、书页、落日、蓝图；组合上下分区、居中与双栏排版，保留文字对比度，装饰随内容高度适配。
 * 模块边界：只在已确定尺寸的 Canvas 上绘图，不测量或裁切正文，不访问配置存储、网络及宿主页面，也不加载外部设计素材。
 */
import type {ShareCardTheme} from '@/src/core/config/shareCard';

const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
const SERIF = 'Georgia, "Songti SC", "Noto Serif CJK SC", "SimSun", serif';
export const CARD_THEMES = {
    coral: {background: '#eb4635', ink: '#fff8ea', secondary: '#573a30', accent: '#c53325', muted: '#8b6854', font: `500 {size}px ${SERIF}`, inset: 48},
    sky: {background: '#eaf5ff', ink: '#153d65', secondary: '#315e80', accent: '#306fa3', muted: '#47728f', font: `600 {size}px ${SANS}`, inset: 48},
    prism: {background: '#12131a', ink: '#b6b7ff', secondary: '#e1e2e9', accent: '#bcb4e7', muted: '#a8aabf', font: `600 {size}px ${SANS}`, inset: 48},
    pearl: {background: '#eaeaf0', ink: '#292b34', secondary: '#5e6270', accent: '#777d96', muted: '#7b7e8c', font: `600 {size}px ${SANS}`, inset: 48},
    moss: {background: '#edf3e6', ink: '#2d4935', secondary: '#4b6351', accent: '#54734a', muted: '#62735d', font: `500 {size}px ${SERIF}`, inset: 56},
    linen: {background: '#faf4e8', ink: '#493b30', secondary: '#6b5948', accent: '#9a6740', muted: '#857361', font: `500 {size}px ${SERIF}`, inset: 56},
    sunset: {background: '#ffe5d6', ink: '#63372e', secondary: '#774e43', accent: '#a35242', muted: '#8d6254', font: `600 {size}px ${SANS}`, inset: 48},
    blueprint: {background: '#15324d', ink: '#eef7ff', secondary: '#c7dceb', accent: '#b5d9ed', muted: '#a5c1d4', font: `500 {size}px ${SANS}`, inset: 48},
} as const satisfies Record<ShareCardTheme, unknown>;
export const CARD_SECONDARY_FONT = SANS;

function glow(context: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string, width: number, height: number): void {
    const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, color); gradient.addColorStop(1, `${color.slice(0, 7)}00`);
    context.fillStyle = gradient; context.fillRect(0, 0, width, height);
}
export function paintCardBackground(context: CanvasRenderingContext2D, theme: ShareCardTheme, width: number, height: number, split: number): void {
    context.fillStyle = CARD_THEMES[theme].background;
    context.fillRect(0, 0, width, height);
    context.save();
    if (theme === 'coral') {
        // 已选定的默认版式保持红白比例、字体和细节不变。
        context.fillStyle = '#fff3dd'; context.fillRect(0, split, width, height - split);
        context.strokeStyle = '#fff8ea38'; context.lineWidth = 1;
        for (const radius of [27, 35, 43]) {context.beginPath(); context.arc(width - 21, 10, radius, 0, Math.PI * 2); context.stroke();}
        context.fillStyle = '#f4ce94'; context.fillRect(48, 22, 22, 3);
        context.fillStyle = '#c53325'; context.fillRect(width - 33, height - 45, 7, 7);
    } else if (theme === 'sky') {
        const gradient = context.createLinearGradient(0, 0, width * .25, height);
        gradient.addColorStop(0, '#f5faff'); gradient.addColorStop(.6, '#d8edff'); gradient.addColorStop(1, '#9bcbf2');
        context.fillStyle = gradient; context.fillRect(0, 0, width, height);
        glow(context, width * .65, -10, 330, '#ffffff', width, height);
        // 光线只落在下沿，避免在正文背后堆叠图形。
        context.beginPath(); context.moveTo(0, height - 57);
        context.bezierCurveTo(width * .38, height - 115, width * .7, height + 30, width, height - 70);
        context.lineTo(width, height); context.lineTo(0, height); context.closePath();
        context.fillStyle = '#ffffff52'; context.fill();
        context.strokeStyle = '#ffffff80'; context.lineWidth = 1; context.stroke();
    } else if (theme === 'prism') {
        glow(context, 90, height + 140, 290, '#3759c945', width, height);
        glow(context, width - 30, height + 140, 290, '#c1478c38', width, height);
    } else if (theme === 'pearl') {
        const gradient = context.createLinearGradient(0, 0, width, height);
        gradient.addColorStop(0, '#e6effc'); gradient.addColorStop(.45, '#f4eaf1'); gradient.addColorStop(1, '#dcebed');
        context.fillStyle = gradient; context.fillRect(0, 0, width, height);
        context.shadowColor = '#47436e1a'; context.shadowBlur = 16; context.shadowOffsetY = 5;
        context.fillStyle = '#ffffffed'; context.strokeStyle = '#ffffff'; context.lineWidth = 1;
        context.beginPath();
        // 老浏览器缺少 roundRect 时使用直角面板，装饰不会阻断导出。
        if (typeof context.roundRect === 'function') context.roundRect(12, 12, width - 24, height - 24, 18);
        else context.rect(12, 12, width - 24, height - 24);
        context.fill(); context.shadowColor = 'transparent'; context.stroke();
    } else if (theme === 'moss') {
        context.fillStyle = '#dce8cd'; context.fillRect(0, 0, 18, height);
        context.fillStyle = '#739063'; context.fillRect(32, 46, 3, height - 100);
        context.strokeStyle = '#9aaf833d'; context.lineWidth = 1;
        for (const radius of [24, 38, 52]) { context.beginPath(); context.arc(width - 12, height + 12, radius, 0, Math.PI * 2); context.stroke(); }
    } else if (theme === 'linen') {
        context.strokeStyle = '#c9b89b'; context.lineWidth = 1;
        context.strokeRect(20, 20, width - 40, height - 40);
        context.fillStyle = '#9a6740'; context.fillRect(56, 30, 28, 3);
        // 装饰仅位于边缘，不在正文背后制造纹理噪声。
        context.fillStyle = '#c9b89b'; context.fillRect(width - 76, height - 26, 20, 1);
    } else if (theme === 'sunset') {
        const gradient = context.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, '#fff1df'); gradient.addColorStop(.55, '#ffe2cf'); gradient.addColorStop(1, '#efb5ad');
        context.fillStyle = gradient; context.fillRect(0, 0, width, height);
        glow(context, width / 2, -100, 240, '#ffffff', width, height);
        context.fillStyle = '#ffffff26'; context.beginPath(); context.arc(width + 12, height + 100, 170, 0, Math.PI * 2); context.fill();
    } else {
        // CARD_THEMES 的穷尽类型已在入口取色；剩余主题必为 blueprint。
        context.strokeStyle = '#aacde012'; context.lineWidth = .5;
        for (let x = 16; x < width; x += 32) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke(); }
        for (let y = 16; y < height; y += 32) { context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke(); }
        context.strokeStyle = '#90bcd177'; context.strokeRect(20, 20, width - 40, height - 40);
    }
    context.restore();
}
export function cardPrismInk(context: CanvasRenderingContext2D, width: number, top: number): CanvasGradient {
    const gradient = context.createLinearGradient(48, top, width - 48, top + 80);
    gradient.addColorStop(0, '#77b7ff'); gradient.addColorStop(.36, '#b09cff');
    gradient.addColorStop(.7, '#ef9dcd'); gradient.addColorStop(1, '#ffc3a3');
    return gradient;
}
