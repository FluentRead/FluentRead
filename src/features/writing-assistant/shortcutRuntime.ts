/**
 * @file src/features/writing-assistant/shortcutRuntime.ts
 * 文件职责：在任意常规网页监听写作助手呼出快捷键，聚焦可编辑元素时按需挂载并交付写作打开目标。
 * 主要内容：提供无 Vue 依赖的按需打开桥接函数，校验可信非重复按键、全局开关、站点禁用名单与配置组合键，通过穿透 Shadow DOM 的焦点解析识别常规输入框与富文本编辑器；非一等网站不主动注入浮动按钮，仅在快捷键触发时通过注入的挂载回调按需挂载并在页面停用时释放。
 * 模块边界：不静态引入 Vue 或界面组件，只负责键盘触发、待打开目标队列与按需挂载协调；实际界面渲染与模型请求分别由 WritingSurface 与后台运行时承担。
 */
import {config} from '@/src/services/config/store';
import {isWritingEligibleUrl, matchesWritingHotkey} from '@/src/core/config/writing';
import {isExtensionDisabledOnSite} from '@/src/core/site-rules/domain';
import {deepActiveElement, resolveEditableTarget, resolveWritingSite} from './editors';

let pendingOpenTarget: HTMLElement | null = null;
let openHandler: ((element: HTMLElement) => void) | null = null;

export function registerWritingOpenHandler(handler: ((element: HTMLElement) => void) | null): void {
    openHandler = handler;
    if (handler && pendingOpenTarget) {
        const target = pendingOpenTarget;
        pendingOpenTarget = null;
        handler(target);
    }
}

export function requestOpenWritingForEditor(element: HTMLElement): void {
    if (openHandler) { openHandler(element); return; }
    pendingOpenTarget = element;
}

export function clearPendingWritingOpenTarget(): void {
    pendingOpenTarget = null;
}

export interface WritingShortcutDeps {
    document?: Document;
    getHref?: () => string;
    isSiteDisabled: () => boolean;
    mount: () => Promise<void>;
    unmount: () => void;
    isMounted: () => boolean;
}

export function mountWritingShortcut(
    signal: AbortSignal,
    deps: WritingShortcutDeps,
): void {
    if (signal.aborted) return;
    const doc = deps.document ?? document;
    const getHref = deps.getHref ?? (() => window.location.href);

    const onKeydown = (event: KeyboardEvent) => {
        if (!event.isTrusted || event.repeat) return;
        if (!config.on || !config.writing.enabled || deps.isSiteDisabled()) return;
        const href = getHref();
        if (!isWritingEligibleUrl(href)) return;
        if (isExtensionDisabledOnSite(href, [...config.disabledExtensionDomains, ...config.writing.disabledDomains])) return;
        if (!matchesWritingHotkey(event, config.writing)) return;

        const site = resolveWritingSite(href);
        const editor = resolveEditableTarget(deepActiveElement(doc), site);
        if (!editor) return;

        event.preventDefault();
        event.stopPropagation();
        requestOpenWritingForEditor(editor);
        if (!deps.isMounted()) {
            void deps.mount().catch(() => { clearPendingWritingOpenTarget(); });
        }
    };

    doc.addEventListener('keydown', onKeydown, {capture: true, signal});
    signal.addEventListener('abort', () => {
        clearPendingWritingOpenTarget();
        if (deps.isMounted()) deps.unmount();
    }, {once: true});
}
