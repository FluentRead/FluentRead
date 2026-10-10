/**
 * @file src/features/page-notice/content/notice.ts
 * 文件职责：在任意宿主页面的隔离 Shadow Root 中显示 FluentRead 成功或错误通知，并把缺少 API 凭据的错误转换为可直接前往设置的提醒。
 * 主要内容：包含凭据文案识别、通知标题与详情生成、扩展上下文失效时的本地品牌占位、宿主抗样式污染与设置主题、堆栈复用、有界停留时长、悬停和键盘焦点暂停、局部 Escape 关闭与焦点返回，导出 showPageNotice、按功能 key 撤销的 dismissPageNotice 与一秒节流的 sendErrorMessage。
 * 模块边界：本文件只拥有通知 DOM 和打开设置消息，不记录凭据、不处理翻译重试；外观来自 notice.css，后台 openOptions handler 处理导航，调用方传入的文本一律通过 textContent 展示。
 */
import {throttle} from '@/src/shared/function/throttle';
import {config} from '@/src/services/config/store';
import {normalizeUiLanguage, translate, translateLegacyText} from '@/src/core/i18n';
import noticeStyles from './notice.css?inline';
import {deepActiveElement} from '@/src/shared/dom/editingTarget';

type NoticeType = 'error' | 'success';

interface MissingCredentialNotice {
    service: string;
    credentialLabel: string;
}

const PAGE_NOTICE_HOST_ID = 'fluent-read-page-notice-host';
const NOTICE_EXIT_DURATION = 180;
const MAX_PAGE_NOTICES = 3;
const MIN_READING_REMAINDER = 1500;

export interface PageNoticeOptions {
    /** 同一功能的反馈原地更新；独立提示仍保留自己的内容。 */
    key?: string;
    /** 功能结束时立即撤销它拥有的反馈。 */
    signal?: AbortSignal;
    /** 明确的阅读时长；有限正数限制在 1–30 秒，无效值沿用默认时长。 */
    durationMs?: number;
}
interface NoticeEntry {
    node: HTMLElement;
    stack: HTMLElement;
    key?: string;
    message: string;
    type: NoticeType;
    language: Parameters<typeof translate>[1];
    brand: HTMLElement;
    title: HTMLElement;
    detail: HTMLElement;
    body: HTMLElement;
    mark: HTMLElement;
    close: HTMLButtonElement;
    action?: HTMLButtonElement;
    dismissTimer?: number;
    exitTimer?: number;
    revealFrame?: number;
    reveal?: () => void;
    remainingMs: number;
    dismissAt: number;
    hovered: boolean;
    focused: boolean;
    returnFocus: HTMLElement | null;
    interactions: Array<readonly [string, EventListener]>;
    signal?: AbortSignal;
    abort?: () => void;
}
const entries = new Map<HTMLElement, NoticeEntry>();
let noticeHost: HTMLElement | null = null;
let noticeStack: HTMLElement | null = null;

function getMissingCredentialNotice(message: string): MissingCredentialNotice | null {
    const match = message.match(/^(.+?)\s+需要\s+(.+?)，当前尚未(?:完整)?配置(?:[；。]|$)/u);
    if (match) {
        const [, service, credentialLabel] = match;
        if (/(?:API Key|访问令牌|App Key|App Secret|SecretId|SecretKey)/iu.test(credentialLabel)) {
            return {service, credentialLabel};
        }
    }

    // 兼容只返回笼统“未配置”文案的旧适配器，同时绝不把无效或过期密钥误判成缺少凭据。
    if (!/(?:尚未(?:完整)?配置|还没有配置|未配置|请先配置)/u.test(message)) return null;
    const credentialLabel = message.match(
        /API Key(?:（访问令牌）)?|App Key(?:\s*和\s*App Secret)?|SecretId(?:\s*和\s*SecretKey)?/iu,
    )?.[0];
    return credentialLabel
        ? {service: '当前翻译服务', credentialLabel}
        : null;
}

function getNoticeTitle(type: NoticeType, credential: boolean, language: Parameters<typeof translate>[1]): string {
    if (credential) return translate('notice.configurationReminder', language);
    return translate(type === 'success' ? 'notice.operationComplete' : 'notice.translationNotice', language);
}

function getNoticeDetail(message: string, missingCredential: MissingCredentialNotice | null, language: Parameters<typeof translate>[1]): string {
    if (!missingCredential) return translateLegacyText(message, language);
    return translate('notice.missingCredential', language, {
        service: translateLegacyText(missingCredential.service, language),
        credential: translateLegacyText(missingCredential.credentialLabel, language),
    });
}

function resolveNoticeIconUrl(): string | null {
    try {
        if (typeof browser === 'undefined') return null;
        const runtime = browser.runtime;
        if (typeof runtime?.getURL !== 'function') return null;
        const url = runtime.getURL('/icon/48.png');
        return typeof url === 'string' && url ? url : null;
    } catch {
        // 扩展更新后旧内容脚本仍可能存活；通知必须继续可见，提醒用户刷新页面。
        return null;
    }
}

function createNoticeMark(language: Parameters<typeof translate>[1]): HTMLElement {
    const iconUrl = resolveNoticeIconUrl();
    if (iconUrl) {
        const mark = document.createElement('img');
        mark.className = 'notice-mark';
        mark.src = iconUrl;
        mark.alt = translate('common.brand', language);
        mark.setAttribute('aria-hidden', 'true');
        return mark;
    }

    const fallback = document.createElement('span');
    fallback.className = 'notice-mark notice-mark-fallback';
    fallback.setAttribute('aria-hidden', 'true');
    fallback.textContent = '流';
    return fallback;
}

function applyHostStyles(host: HTMLElement): void {
    // 宿主页样式不能把通知重新放回文档流，也不能用 transform/overflow
    // 截断它。关键布局使用 inline !important，具体外观留在 Shadow Root。
    const importantStyles: Record<string, string> = {
        display: 'block',
        position: 'fixed',
        top: '0',
        left: '0',
        width: '0',
        height: '0',
        margin: '0',
        padding: '0',
        border: '0',
        overflow: 'visible',
        opacity: '1',
        visibility: 'visible',
        transform: 'none',
        'pointer-events': 'none',
        'z-index': '2147483647',
    };
    Object.entries(importantStyles).forEach(([property, value]) => {
        host.style.setProperty(property, value, 'important');
    });
}

function getNoticeStack(): HTMLElement {
    if (noticeHost?.isConnected && noticeHost.ownerDocument === document && noticeStack?.isConnected && noticeStack.parentNode === noticeHost.shadowRoot) {
        for (const entry of entries.values()) {
            if (entry.node.parentElement !== noticeStack) disposeNotice(entry);
        }
        if (noticeStack) return noticeStack;
    }

    // 宿主移除 host、内部堆栈或更换文档后，先释放旧实例持有的任务和 signal。
    for (const entry of entries.values()) disposeNotice(entry);
    noticeHost = null;
    noticeStack = null;
    const host = document.createElement('fluent-read-page-notice');
    host.id = PAGE_NOTICE_HOST_ID;
    host.setAttribute('data-fr-page-notice-host', 'true');
    host.setAttribute('data-fluent-read-ui', '');
    host.setAttribute('translate', 'no');
    applyHostStyles(host);

    const shadow = host.attachShadow({mode: 'open'});
    const style = document.createElement('style');
    style.textContent = noticeStyles;
    const stack = document.createElement('div');
    stack.className = 'notice-stack';
    shadow.append(style, stack);

    document.documentElement.appendChild(host);
    noticeHost = host;
    noticeStack = stack;
    return stack;
}

function appendTextElement(
    parent: HTMLElement,
    tag: 'span' | 'strong',
    className: string,
    text: string,
): HTMLElement {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    parent.appendChild(element);
    return element;
}

function clearNoticeTasks(entry: NoticeEntry): void {
    if (entry.dismissTimer !== undefined) window.clearTimeout(entry.dismissTimer);
    if (entry.exitTimer !== undefined) window.clearTimeout(entry.exitTimer);
    if (entry.revealFrame !== undefined) window.cancelAnimationFrame(entry.revealFrame);
    entry.dismissTimer = entry.exitTimer = entry.revealFrame = undefined;
    entry.reveal = undefined;
}

function disposeNotice(entry: NoticeEntry): void {
    if (entries.get(entry.node) !== entry) return;
    clearNoticeTasks(entry);
    for (const [type, listener] of entry.interactions) entry.node.removeEventListener(type, listener);
    if (entry.abort) entry.signal?.removeEventListener('abort', entry.abort);
    entries.delete(entry.node);
    restoreNoticeFocus(entry);
    entry.node.remove();
    if (entries.size === 0 && entry.stack === noticeStack) {
        noticeHost?.remove();
        noticeHost = null;
        noticeStack = null;
    }
}

function removeNotice(entry: NoticeEntry): void {
    if (entries.get(entry.node) !== entry || entry.exitTimer !== undefined) return;
    clearNoticeTasks(entry);
    entry.node.classList.remove('is-visible');
    entry.node.classList.add('is-leaving');
    entry.exitTimer = window.setTimeout(() => disposeNotice(entry), NOTICE_EXIT_DURATION);
    restoreNoticeFocus(entry);
}

function restoreNoticeFocus(entry: NoticeEntry): void {
    if (!entry.node.contains(deepActiveElement(document))) return;
    const target = entry.returnFocus;
    if (target?.isConnected && target.ownerDocument === document && typeof target.focus === 'function') {
        target.focus({preventScroll: true});
    }
}

function scheduleNoticeDismissal(entry: NoticeEntry): void {
    if (entry.hovered || entry.focused) return;
    entry.dismissAt = Date.now() + entry.remainingMs;
    entry.dismissTimer = window.setTimeout(() => removeNotice(entry), entry.remainingMs);
}

function updateNoticeInteraction(entry: NoticeEntry, kind: 'hovered' | 'focused', active: boolean): void {
    if (entries.get(entry.node) !== entry) return;
    entry[kind] = active;
    if (entry.exitTimer !== undefined) return;
    if (entry.hovered || entry.focused) {
        if (entry.dismissTimer !== undefined) {
            entry.remainingMs = Math.max(0, entry.dismissAt - Date.now());
            window.clearTimeout(entry.dismissTimer);
            entry.dismissTimer = undefined;
        }
    } else if (entry.dismissTimer === undefined) {
        entry.remainingMs = Math.max(MIN_READING_REMAINDER, entry.remainingMs);
        scheduleNoticeDismissal(entry);
    }
}

function bindNoticeInteractions(entry: NoticeEntry): void {
    const focusWithin = (target: EventTarget | null) => target !== null && entry.node.contains(target as Node);
    const listeners: Array<readonly [string, EventListener]> = [
        ['mouseenter', () => updateNoticeInteraction(entry, 'hovered', true)],
        ['mouseleave', () => updateNoticeInteraction(entry, 'hovered', false)],
        ['focusin', event => {
            const previous = (event as FocusEvent).relatedTarget;
            if (previous && !focusWithin(previous)) entry.returnFocus = previous as HTMLElement;
            updateNoticeInteraction(entry, 'focused', true);
        }],
        ['focusout', event => {
            if (!focusWithin((event as FocusEvent).relatedTarget)) updateNoticeInteraction(entry, 'focused', false);
        }],
        ['keydown', event => {
            if ((event as KeyboardEvent).key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            removeNotice(entry);
        }],
    ];
    for (const [type, listener] of listeners) entry.node.addEventListener(type, listener);
    entry.interactions = listeners;
}

function bindNoticeSignal(entry: NoticeEntry, signal?: AbortSignal): void {
    if (entry.signal === signal) return;
    if (entry.abort) entry.signal?.removeEventListener('abort', entry.abort);
    entry.signal = signal;
    entry.abort = signal ? () => {
        if (entry.signal === signal) disposeNotice(entry);
    } : undefined;
    if (entry.abort) signal!.addEventListener('abort', entry.abort, {once: true});
}

function paintNotice(entry: NoticeEntry, message: string, type: NoticeType, durationMs?: number): void {
    const language = normalizeUiLanguage(config.uiLanguage);
    const missingCredential = getMissingCredentialNotice(message);
    const credential = missingCredential !== null;
    const tone = credential ? 'warning' : type;
    const node = entry.node;
    const theme = config.theme === 'light' || config.theme === 'dark' ? config.theme : 'auto';
    if (noticeHost!.getAttribute('data-fr-theme') !== theme) noticeHost!.setAttribute('data-fr-theme', theme);
    const visible = node.classList.contains('is-visible');
    const className = `page-notice page-notice-${tone}${visible ? ' is-visible' : ''}`;
    if (node.className !== className) node.className = className;
    const role = tone === 'success' ? 'status' : 'alert';
    if (node.getAttribute('role') !== role) node.setAttribute('role', role);
    const brand = translate('common.brand', language);
    for (const [element, text] of [
        [entry.brand, brand],
        [entry.title, getNoticeTitle(type, credential, language)],
        [entry.detail, getNoticeDetail(message, missingCredential, language)],
    ] as const) {
        if (element.textContent !== text) element.textContent = text;
    }
    if (entry.mark.tagName === 'IMG' && (entry.mark as HTMLImageElement).alt !== brand) (entry.mark as HTMLImageElement).alt = brand;
    const closeLabel = translate('notice.close', language);
    if (entry.close.getAttribute('aria-label') !== closeLabel) entry.close.setAttribute('aria-label', closeLabel);
    if (credential) {
        if (!entry.action) {
            const action = document.createElement('button');
            action.className = 'notice-action';
            action.type = 'button';
            action.addEventListener('click', () => {
                if (entries.get(node) !== entry || entry.action !== action || !action.isConnected) return;
                const reportFailure = (error: unknown) => console.error('[FluentRead] 打开设置页失败', error);
                try {
                    void Promise.resolve(browser.runtime.sendMessage({type: 'openOptionsPage'})).catch(reportFailure);
                } catch (error) {
                    reportFailure(error);
                }
            });
            entry.body.appendChild(action);
            entry.action = action;
        }
        const actionLabel = translate('notice.openSettings', language);
        if (entry.action.textContent !== actionLabel) entry.action.textContent = actionLabel;
    } else if (entry.action) {
        const ownedFocus = deepActiveElement(document) === entry.action;
        entry.action.remove();
        entry.action = undefined;
        if (ownedFocus) entry.close.focus({preventScroll: true});
    }
    entry.message = message;
    entry.type = type;
    entry.language = language;
    if (entry.dismissTimer !== undefined) window.clearTimeout(entry.dismissTimer);
    if (entry.exitTimer !== undefined) window.clearTimeout(entry.exitTimer);
    entry.exitTimer = undefined;
    entry.dismissTimer = undefined;
    entry.remainingMs = typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
        ? Math.min(30_000, Math.max(1000, durationMs)) : credential ? 6500 : 3500;
    scheduleNoticeDismissal(entry);
    if (visible || entry.reveal) return;
    const reveal = () => {
        if (entry.reveal !== reveal) return;
        entry.reveal = undefined;
        entry.revealFrame = undefined;
        if (entries.get(node) === entry && entry.exitTimer === undefined && node.isConnected) node.classList.add('is-visible');
    };
    entry.reveal = reveal;
    if (typeof window.requestAnimationFrame === 'function') entry.revealFrame = window.requestAnimationFrame(reveal);
    else void Promise.resolve().then(reveal);
}

/**
 * 最多显示三条隔离通知；同 key 或相同文案原地更新并重新计时。
 * 返回本次反馈节点；signal 已结束时只返回未挂载节点，不产生页面副作用。
 */
export function showPageNotice(message: string, type: NoticeType, options: PageNoticeOptions = {}): HTMLElement {
    if (options.signal?.aborted) return document.createElement('section');
    const stack = getNoticeStack();
    const language = normalizeUiLanguage(config.uiLanguage);
    for (const entry of entries.values()) {
        // getNoticeStack 已清除脱离当前堆栈的条目。
        const sameFeedback = options.key
            ? entry.key === options.key
            : !entry.key && entry.message === message && entry.type === type && entry.language === language;
        if (!sameFeedback) continue;
        bindNoticeSignal(entry, options.signal);
        paintNotice(entry, message, type, options.durationMs);
        return entry.node;
    }
    if (entries.size >= MAX_PAGE_NOTICES) {
        const focused = deepActiveElement(document);
        const oldest = [...entries.values()].find(entry => !entry.node.contains(focused))!;
        disposeNotice(oldest);
    }
    const notice = document.createElement('section');
    notice.setAttribute('aria-atomic', 'true');
    const mark = createNoticeMark(language);
    const copy = document.createElement('span');copy.className = 'notice-copy';
    const heading = document.createElement('span');heading.className = 'notice-heading';
    const brand = appendTextElement(heading, 'strong', 'notice-brand', '');
    appendTextElement(heading, 'span', 'notice-divider', '·');
    const title = appendTextElement(heading, 'span', 'notice-title', '');
    const body = document.createElement('span');body.className = 'notice-body';
    const detail = appendTextElement(body, 'span', 'notice-detail', '');
    copy.append(heading, body);
    const close = document.createElement('button');close.className = 'notice-close';close.type = 'button';close.textContent = '×';
    notice.append(mark, copy, close);stack.appendChild(notice);
    const entry: NoticeEntry = {node: notice, stack, key: options.key, message, type, language, brand, title, detail, body, mark, close,
        remainingMs: 0, dismissAt: 0, hovered: false, focused: false, returnFocus: deepActiveElement(document) as HTMLElement | null, interactions: []};
    entries.set(notice, entry);
    bindNoticeInteractions(entry);
    close.addEventListener('click', () => removeNotice(entry));
    bindNoticeSignal(entry, options.signal);
    paintNotice(entry, message, type, options.durationMs);
    return notice;
}

/** 功能成功开始后撤销它的旧反馈，保留页面上其他功能拥有的通知。 */
export function dismissPageNotice(key: string): void {
    if (!key) return;
    for (const entry of entries.values()) {
        if (entry.key === key) removeNotice(entry);
    }
}

function _sendErrorMessage(message: string): void {
    showPageNotice(message, 'error');
}

// 1s 内只显示一次，避免全文翻译中多个失败节点同时堆叠通知。
export const sendErrorMessage = throttle(_sendErrorMessage, 1000);
