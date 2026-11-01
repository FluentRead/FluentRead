/**
 * @file src/app/selection/page.ts
 * 文件职责：在扩展独立窗口中领取原生 PDF 右键选区，并以真实本页 Range 复用既有划词翻译卡片。
 * 主要内容：等待配置水合、消费一次性令牌、显示紧凑只读来源，严格限定唯一原文节点及其文本身份；卡片继续使用现有翻译、词典、复制和朗读链路，观察自有卡片根的直接子节点，在已显示卡片自行收起时关闭结果窗口，关闭或离开页面时取消组件请求并释放选区。
 * 模块边界：不下载或解析 PDF、不修改来源页面、不放宽普通网页选区规则；后台负责令牌与窗口身份，当前页面只把已领取文本适配成自有 DOM 选区，并以独立定时器回收已启动但未领取的结果页；不保证脚本未加载或页面冻结时的墙钟期限。
 */
import {createApp, nextTick, type Component} from 'vue';
import browser from 'webextension-polyfill';
import SelectionTranslator from '@/src/features/selection-translation/ui/SelectionTranslator.vue';
import {translateSelectionFromContextMenu} from '@/src/features/selection-translation/content/contextMenuBridge';
import {config, configReady, subscribeConfig} from '@/src/services/config/store';
import {isExtensionDisabledOnSite} from '@/src/core/site-rules/domain';
import {createUiI18nPlugin} from '@/src/ui/i18n';
import {observeNativePdfSelectionCard} from './cardVisibility';
import './selection-page.css';

export const NATIVE_PDF_SELECTION_PAGE_TIMEOUT_MS = 60_000;

export interface NativePdfSelectionPayload {text: string; sourceUrl: string; title: string}
export type NativePdfSelectionAdapter = NonNullable<InstanceType<typeof SelectionTranslator>['$props']['selectionAdapter']>;
export interface NativePdfSelectionCard {translate(text: string): boolean; focus(): Promise<void> | void; dispose(): void}
export interface NativePdfSelectionPageDependencies {
    ready: Promise<unknown>;
    enabled(sourceUrl?: string): boolean;
    subscribe?(listener: () => void): () => void;
    claim(token: string): Promise<unknown>;
    mountCard(host: HTMLElement, adapter: NativePdfSelectionAdapter, dismiss: () => void): NativePdfSelectionCard | Promise<NativePdfSelectionCard>;
    close(): void;
}

/** 令牌只允许随机标识字符；裸 hash 保留兼容，原文不通过 URL 交接。 */
export function readNativePdfSelectionToken(hash: string): string | null {
    const value = hash.replace(/^#/u, '');
    const token = new URLSearchParams(value).get('token') ?? value;
    return /^[A-Za-z0-9_-]{24,128}$/u.test(token) ? token : null;
}

/** 再次验证已领取的有限纯文本，来源上下文沿用文档页的去凭据、查询与片段规则。 */
export function parseNativePdfSelectionPayload(value: unknown): NativePdfSelectionPayload | null {
    if (!value || typeof value !== 'object') return null;
    const payload = value as Partial<NativePdfSelectionPayload>;
    if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 4096
        || typeof payload.sourceUrl !== 'string' || typeof payload.title !== 'string') return null;
    try {
        const url = new URL(payload.sourceUrl);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        url.username = ''; url.password = ''; url.search = ''; url.hash = '';
        return {text: payload.text, sourceUrl: url.href, title: payload.title.trim().slice(0, 512)};
    } catch {return null;}
}

/** 原文不可编辑，任何跨节点、脱离文档或文本被改动后的 Range 都不能成为翻译来源。 */
export function createNativePdfSelectionAdapter(source: Text, payload: NativePdfSelectionPayload, current: () => boolean): NativePdfSelectionAdapter {
    const acceptsRange = (range: Range): boolean => current() && source.isConnected && source.textContent === payload.text
        && range.startContainer === source && range.endContainer === source && !range.collapsed
        && range.startOffset >= 0 && range.endOffset <= payload.text.length && range.startOffset < range.endOffset;
    return {
        acceptsRange,
        extractText: range => acceptsRange(range) ? range.toString() : '',
        normalizeText: text => text,
        context: (range, _text, limit) => ({text: acceptsRange(range) && limit > 0 ? payload.text.slice(0, Math.min(4096, limit)) : '',
            title: payload.title, sourceUrl: payload.sourceUrl}),
        captureReading: (range, text, limit) => ({text, context: acceptsRange(range) && limit > 0 ? payload.text.slice(0, Math.min(4096, limit)) : '', sentence: text}),
        // 当前交接仅有选中文本，不伪造 PDF 页码、段落位置或材料关联。
        captureMaterial: () => undefined,
    };
}

function mountExistingSelectionCard(host: HTMLElement, adapter: NativePdfSelectionAdapter, dismiss: () => void): NativePdfSelectionCard {
    const app = createApp(SelectionTranslator as Component, {selectionAdapter: adapter, onFocusedCardDismiss: dismiss});
    let stopVisibility: (() => void) | undefined;
    try {
        app.use(createUiI18nPlugin({documentRoot: host, documentTitleKey: 'contextMenu.translateSelection'}));
        app.mount(host);
        const root = host.querySelector<HTMLElement>('.fr-selection-translator-root');
        if (root) stopVisibility = observeNativePdfSelectionCard(root, dismiss);
    } catch (error) {app.unmount(); throw error;}
    return {translate: translateSelectionFromContextMenu, async focus() {
        await nextTick();
        const card = host.querySelector<HTMLElement>('.fr-translation-tooltip');
        if (card) {card.tabIndex = -1; card.focus({preventScroll: true});}
    }, dispose: () => {stopVisibility?.(); app.unmount();}};
}

/** 依赖端口仅用于页面生命周期验证；生产始终装配同一配置客户端与 SelectionTranslator。 */
export function mountNativePdfSelectionApp(selector: string, dependencies: NativePdfSelectionPageDependencies = {
    ready: configReady,
    enabled: sourceUrl => config.on !== false && config.disableSelectionTranslator !== true && config.selectionTranslatorMode !== 'disabled'
        && (!sourceUrl || !isExtensionDisabledOnSite(sourceUrl, config.disabledExtensionDomains)),
    subscribe: listener => subscribeConfig(listener),
    claim: token => browser.runtime.sendMessage({type: 'claimNativePdfSelection', token}),
    mountCard: mountExistingSelectionCard,
    close: () => window.close(),
}): {ready: Promise<void>; dispose(): void} {
    const root = document.querySelector<HTMLElement>(selector);
    if (!root) throw new Error('找不到划词翻译窗口');
    root.classList.add('native-pdf-selection-page');
    const token = readNativePdfSelectionToken(window.location.hash);
    const tooLong = new URLSearchParams(window.location.hash.replace(/^#/u, '')).get('error') === 'too-long';
    if (window.location.hash) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    let disposed = false;
    let receivedPayload = false;
    let claimTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelClaimTimer = () => {
        if (claimTimer !== undefined) clearTimeout(claimTimer);
        claimTimer = undefined;
    };
    let card: NativePdfSelectionCard | null = null;
    let cardHost: HTMLElement | null = null;
    let sourceUrl: string | null = null;
    let generation = 0;
    let unsubscribe: (() => void) | undefined;
    let range: Range | null = null;
    let source: Text | null = null;
    const releaseCard = () => {
        generation += 1;
        card?.dispose(); card = null;
        cardHost = null; sourceUrl = null;
        const selection = window.getSelection();
        if (source && selection?.containsNode(source, true)) selection.removeAllRanges();
        range?.detach(); range = null; source = null;
    };
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        cancelClaimTimer();
        window.removeEventListener('pagehide', dispose);
        document.removeEventListener('pointerdown', keepSourcePassive, true);
        document.removeEventListener('pointerup', keepSourcePassive, true);
        unsubscribe?.(); unsubscribe = undefined;
        releaseCard();
        root.replaceChildren();
    };
    const close = () => {if (disposed) return; dispose(); dependencies.close();};
    const showMessage = (message: string) => {
        releaseCard();
        const status = document.createElement('p'); status.className = 'native-pdf-selection-status'; status.setAttribute('role', 'status'); status.textContent = message;
        const exit = document.createElement('button'); exit.className = 'native-pdf-selection-exit'; exit.type = 'button'; exit.textContent = '关闭窗口'; exit.addEventListener('click', close, {once: true});
        root.replaceChildren(status, exit);
    };
    // 来源摘要仅提供本页 Range，不能让卡片的外部点击监听把独立窗口留成空白。
    const keepSourcePassive = (event: Event) => {
        if (card && cardHost && !cardHost.contains(event.target as Node)) {event.preventDefault(); event.stopImmediatePropagation();}
    };
    // 页面定时器独立于 MV3 后台；配置水合或 claim 卡住时也能退出。
    // 不存正文或票据；已交付后的卡片生命周期仍由现有逻辑管理。
    if (token && !tooLong) claimTimer = setTimeout(() => {
        if (!receivedPayload) close();
    }, NATIVE_PDF_SELECTION_PAGE_TIMEOUT_MS);
    showMessage('正在打开划词翻译…');
    window.addEventListener('pagehide', dispose);
    document.addEventListener('pointerdown', keepSourcePassive, true);
    document.addEventListener('pointerup', keepSourcePassive, true);
    unsubscribe = dependencies.subscribe?.(() => {
        if (!disposed && sourceUrl && !dependencies.enabled(sourceUrl)) showMessage('此页面的划词翻译已关闭，请启用后重新选择文字。');
    });
    const ready = (async () => {
        if (!token) {showMessage(tooLong ? '单次最多翻译 4096 个字符，请缩小选区后重试。' : '选区已失效，请返回 PDF 重新选中文字并右键翻译。'); return;}
        try {
            await dependencies.ready;
            if (disposed) return;
            if (!dependencies.enabled()) {showMessage('划词翻译已关闭，请启用后重新选择文字。'); return;}
            const payload = parseNativePdfSelectionPayload(await dependencies.claim(token));
            if (disposed) return;
            if (!payload) {showMessage('选区已失效，请返回 PDF 重新选中文字并右键翻译。'); return;}
            receivedPayload = true;
            cancelClaimTimer();
            if (!dependencies.enabled(payload.sourceUrl)) {showMessage('此页面的划词翻译已关闭，请启用后重新选择文字。'); return;}
            const heading = document.createElement('header'); heading.className = 'native-pdf-selection-source'; heading.setAttribute('data-i18n-ignore', '');
            const origin = document.createElement('small'); origin.textContent = payload.title || new URL(payload.sourceUrl).hostname; origin.title = payload.sourceUrl;
            const quote = document.createElement('p'); quote.setAttribute('aria-label', '选中的原文'); quote.setAttribute('contenteditable', 'false');
            source = document.createTextNode(payload.text); quote.append(source); heading.append(origin, quote);
            const host = document.createElement('section'); host.id = 'fluent-read-selection-translator-container'; host.className = 'native-pdf-selection-card';
            root.replaceChildren(heading, host);
            cardHost = host; sourceUrl = payload.sourceUrl;
            const adapter = createNativePdfSelectionAdapter(source, payload, () => !disposed);
            const requestGeneration = generation;
            const mounted = await dependencies.mountCard(host, adapter, close);
            if (disposed || requestGeneration !== generation) {mounted.dispose(); return;}
            card = mounted;
            if (!dependencies.enabled(payload.sourceUrl)) {showMessage('此页面的划词翻译已关闭，请启用后重新选择文字。'); return;}
            const selection = window.getSelection();
            if (!selection) {showMessage('无法打开此选区，请返回 PDF 重新选中文字并右键翻译。'); return;}
            range = document.createRange(); range.selectNodeContents(source);
            selection.removeAllRanges(); selection.addRange(range);
            if (!card.translate(payload.text)) {showMessage('无法打开此选区，请返回 PDF 重新选中文字并右键翻译。'); return;}
            await card.focus();
        } catch {
            if (!disposed) showMessage('无法打开划词翻译，请返回 PDF 重新选中文字并右键翻译。');
        }
    })();
    return {ready, dispose};
}
