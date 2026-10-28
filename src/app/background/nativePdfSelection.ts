/**
 * @file src/app/background/nativePdfSelection.ts
 * 文件职责：为原生 PDF 右键结果窗口装配浏览器端口，并向唯一后台路由提供票据兑换处理器。
 * 主要内容：首次显式菜单动作或兑换时才创建内存单例，以加密随机数签票并打开独立小窗口；超长选区用不携原文的错误窗口反馈，正文不进入地址、磁盘或日志。
 * 模块边界：只装配窗口与身份，不安装新监听器、不下载 PDF、不执行翻译；输入和票据生命周期由 selection-translation feature 管理。
 */
import {createNativePdfSelectionBridge, NATIVE_PDF_SELECTION_MAX_PENDING, type NativePdfSelectionInput, type NativePdfSelectionSender} from '@/src/features/selection-translation/background/nativePdfSelection';
import type {BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';

let bridge: ReturnType<typeof createNativePdfSelectionBridge> | undefined;
let unfinishedWindows = 0;
async function openSelectionWindow(url: string) {
    if (unfinishedWindows >= NATIVE_PDF_SELECTION_MAX_PENDING) throw new Error('PDF selection window capacity');
    unfinishedWindows += 1;
    try {return await browser.windows.create({url, type: 'popup', width: 520, height: 680});}
    finally {unfinishedWindows -= 1;}
}
function getBridge() {
    if (bridge) return bridge;
    bridge = createNativePdfSelectionBridge({
        extensionId: browser.runtime.id,
        resultUrl: browser.runtime.getURL('/selection.html'),
        // 独立记录两个截止点；任一到期即失效，兼顾时间回拨和休眠。
        now: () => performance.now(),
        wallNow: Date.now,
        randomToken: () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''),
        openWindow: options => openSelectionWindow(options.url),
    });
    return bridge;
}

export async function openNativePdfSelection(input: NativePdfSelectionInput): Promise<boolean> {
    if (typeof input.text === 'string' && input.text.trim().length > 4096) {
        try {await openSelectionWindow(`${browser.runtime.getURL('/selection.html')}#error=too-long`); return true;}
        catch {return false;}
    }
    return getBridge().open(input);
}

export function createNativePdfSelectionHandler<Context>(): BackgroundMessageHandler<Context> {
    return {type: 'claimNativePdfSelection', handle(message, context) {
        const token = (message as {token?: unknown}).token;
        const sender = (context as {sender?: NativePdfSelectionSender} | undefined)?.sender;
        return getBridge().claim(token, sender);
    }};
}
