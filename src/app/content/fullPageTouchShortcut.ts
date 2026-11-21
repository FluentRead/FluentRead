/**
 * @file src/app/content/fullPageTouchShortcut.ts
 * 文件职责：识别全文翻译的三指轻点与浏览器触摸取消事件。
 * 主要内容：根据当前设置和页面可用性跟踪触点，等待最后一个触点松开，超时、移动、新增触点和可编辑区域撤销本轮手势。
 * 模块边界：仅装配可信触摸事件和配置门禁，页面翻译、恢复原文与快捷键总体生命周期归调用方。
 */
import {config} from '@/src/services/config/store';
import {constants} from '@/src/core/config/constants';
import {isEditingInPage} from '@/src/shared/dom/editingTarget';

export function installFullPageTouchShortcut(signal: AbortSignal, isSiteDisabled: () => boolean, toggleFullPage: () => void): () => void {
    let touchGesture: TouchEvent | false | undefined;
    const reset = () => {touchGesture = undefined;};
    const touchShortcutEnabled = () => !signal.aborted && config.on
        && config.floatingBallHotkey === constants.ThreeFinger && !isSiteDisabled();
    const touchOptions = {signal, capture: true, passive: true};
    document.addEventListener('touchstart', event => {
        if (!event.isTrusted || !touchShortcutEnabled()) return;
        if (touchGesture || event.touches.length > 3 || isEditingInPage(event)) {
            touchGesture = false;
        } else if (touchGesture === undefined && event.touches.length === 3) {
            touchGesture = event;
        }
    }, touchOptions);
    const moved = (start: TouchEvent, current: TouchEvent) => Array.from(current.changedTouches).some(touch => {
        const origin = Array.from(start.touches).find(item => item.identifier === touch.identifier);
        return !origin || Math.hypot(touch.clientX - origin.clientX, touch.clientY - origin.clientY) > 12;
    });
    document.addEventListener('touchmove', event => {
        if (event.isTrusted && touchGesture && moved(touchGesture, event)) touchGesture = false;
    }, touchOptions);
    document.addEventListener('touchend', event => {
        if (!event.isTrusted) return;
        const start = touchGesture;
        if (event.touches.length === 0) touchGesture = undefined;
        if (!start) return;
        const valid = touchShortcutEnabled() && event.timeStamp - start.timeStamp <= 500 && !moved(start, event);
        if (!event.touches.length && valid) toggleFullPage();
        else if (event.touches.length && !valid) touchGesture = false;
    }, touchOptions);
    document.addEventListener('touchcancel', event => {
        if (event.isTrusted) touchGesture = event.touches.length ? false : undefined;
    }, touchOptions);

    window.addEventListener('pagehide', reset, {signal});
    return reset;
}
