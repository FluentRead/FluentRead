/**
 * @file src/features/image-translation/services/imageTextFont.ts
 * 文件职责：为普通图片和漫画提供一致的 Canvas 字体顺序，并按需准备扩展汉字字形。
 * 主要内容：优先使用设备字体，在扩展离屏文档中为译文共享一次包内字体加载；准备超时或失败后保持系统回退，取消请求不等待共享字体。
 * 模块边界：资源和注册都局限于当前扩展文档，不读取宿主页字体、不发送译文、不改变清字或绘制范围。
 */
const RARE_IDEOGRAPH_FONT = 'FluentRead Rare Ideographs';
const RARE_IDEOGRAPH_FONT_URL = '/fluent-read-image-fonts/FluentReadRareIdeographs-Regular.woff2';
const FONT_LOAD_TIMEOUT_MS = 1_200;

export const IMAGE_TEXT_FONT = `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK TC", "Noto Sans CJK JP", "Noto Sans CJK KR", sans-serif, "${RARE_IDEOGRAPH_FONT}"`;

export function mightNeedRareImageFont(text: string): boolean {
    return /[\u{20000}-\u{2EBEF}]/u.test(text);
}

let fontPreparation: Promise<void> | undefined;

async function installRareImageFont(): Promise<void> {
    let timeout: number | ReturnType<typeof setTimeout> | undefined;
    try {
        const face = new FontFace(RARE_IDEOGRAPH_FONT, `url("${RARE_IDEOGRAPH_FONT_URL}")`, {
            style: 'normal', weight: '400', unicodeRange: 'U+20000-2EBEF',
        });
        const deadline = new Promise<undefined>(resolve => {
            timeout = setTimeout(resolve, FONT_LOAD_TIMEOUT_MS);
        });
        const loaded = await Promise.race([face.load(), deadline]);
        if (loaded) document.fonts.add(loaded);
    } catch {
        // 不可用时使用设备字体。当前文档保持该决定，避免一张图量字和绘字之间切换字体。
    } finally {
        clearTimeout(timeout);
    }
}

/** 超时后不注册迟到字体，所有并发排版共享同一次成功或回退。 */
export async function prepareRareImageFont(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const preparation = fontPreparation ??= installRareImageFont();
    if (!signal) return preparation;
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, {once: true});
    });
    try {
        await Promise.race([preparation, cancelled]);
    } finally {
        signal.removeEventListener('abort', abort);
    }
}
