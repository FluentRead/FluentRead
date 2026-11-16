/**
 * @file src/features/hypothesis/client.ts
 * 文件职责：拥有当前文档中由 FluentRead 明确开启的官方 Hypothesis 客户端。
 * 主要内容：按需准备本地页面端、固定官方侧栏来源与隔离属性，等待来源校验后的通信握手，串行开关并释放自身资源；保留其他扩展或网站已有实例。
 * 模块边界：只操作注入端口和当前 DOM，不读取登录凭据、不请求批注 API、不上传文件；官方 HTTPS 侧栏独立处理账户和服务请求。
 */
export type HypothesisResult = {status: 'success' | 'failed' | 'external'; active: boolean};
export interface HypothesisClientPorts {
    document: Document;
    window: Window;
    assetUrl(path: string): string;
    inject(): Promise<void>;
    prepare?(signal: AbortSignal): Promise<() => void>;
}

const ORIGIN = 'https://hypothes.is';
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads';
const SELECTOR = 'link[type="application/annotator+html"][rel="sidebar"]';

/** 只控制自身创建的实例，快速关闭使在途注入的本地脚本守卫立即失效。 */
export function createHypothesisClient(ports: HypothesisClientPorts) {
    const {document, window} = ports;
    let active = false, wanted = false, disposed = false;
    let pending: Promise<HypothesisResult> | undefined;
    let assets: Element[] = [], sidebar: HTMLLinkElement | undefined;
    let cleanupPrepared: (() => void) | undefined;
    let cancelReady: (() => void) | undefined;
    let resetConfig: (() => void) | undefined;
    let preparing: AbortController | undefined;
    let observeFrames: (() => void) | undefined;

    async function unload(): Promise<void> {
        cancelReady?.(); cancelReady = undefined;
        observeFrames?.(); observeFrames = undefined;
        preparing?.abort(); preparing = undefined;
        sidebar?.dispatchEvent(new Event('destroy'));
        // 官方客户端的 destroy 通过微任务清理监听、端口、标记和侧栏。
        await Promise.resolve();
        assets.forEach(asset => asset.remove()); assets = []; sidebar = undefined;
        cleanupPrepared?.(); cleanupPrepared = undefined;
        resetConfig?.(); resetConfig = undefined;
        active = false;
    }
    function add<T extends Element>(element: T): T {
        element.setAttribute('data-hypothesis-asset', '');
        assets.push(element); document.head.append(element); return element;
    }
    function readiness(): Promise<boolean> {
        return new Promise(resolve => {
            let done = false;
            const roots = new Set<Node>();
            const frames = new Set<HTMLIFrameElement>();
            const observer = new MutationObserver(scan);
            const finish = (ok: boolean) => {
                if (done) return;
                done = true; clearTimeout(timer);
                if (!ok) observer.disconnect();
                window.removeEventListener('message', onMessage);
                cancelReady = undefined; resolve(ok);
            };
            function scan(): void {
                for (const host of document.querySelectorAll('hypothesis-sidebar, hypothesis-notebook, hypothesis-profile')) visit(host);
            }
            function visit(root: Element | ShadowRoot): void {
                if (!roots.has(root)) {roots.add(root); observer.observe(root, {subtree: true, childList: true});}
                if (root instanceof Element && root.shadowRoot) visit(root.shadowRoot);
                for (const element of root.querySelectorAll('*')) {
                    if (element.shadowRoot) visit(element.shadowRoot);
                    if (element instanceof HTMLIFrameElement && element.src.startsWith(`${ORIGIN}/`)) {
                        if (element.getAttribute('sandbox') !== SANDBOX) element.setAttribute('sandbox', SANDBOX);
                        if (element.referrerPolicy !== 'no-referrer') element.referrerPolicy = 'no-referrer';
                        frames.add(element);
                    }
                }
            }
            function onMessage(event: MessageEvent): void {
                if (event.origin !== ORIGIN || ![...frames].some(frame => frame.contentWindow === event.source)) return;
                const message = event.data;
                if (message && message.type === 'request' && message.frame1 === 'sidebar' && message.frame2 === 'host') finish(true);
            }
            const timer = setTimeout(() => finish(false), 15_000);
            observeFrames = () => observer.disconnect();
            cancelReady = () => finish(false);
            window.addEventListener('message', onMessage);
            observer.observe(document.body, {childList: true}); scan();
        });
    }
    async function start(): Promise<HypothesisResult> {
        if (document.querySelector(SELECTOR) || document.querySelector('hypothesis-sidebar')) {wanted = false; return {status: 'external', active: false};}
        try {
            preparing = new AbortController();
            cleanupPrepared = await ports.prepare?.(preparing.signal);
            if (!wanted || disposed) {await unload(); return {status: 'success', active: false};}
            const scope = window as Window & {hypothesisConfig?: () => unknown};
            const previous = scope.hypothesisConfig;
            scope.hypothesisConfig = () => ({ignoreOtherConfiguration: true, openSidebar: true, sideBySide: {mode: 'manual'}});
            resetConfig = () => {if (previous === undefined) delete scope.hypothesisConfig; else scope.hypothesisConfig = previous;};
            for (const [rel, type, href] of [
                ['sidebar', 'html', `${ORIGIN}/app.html`], ['notebook', 'html', `${ORIGIN}/notebook`],
                ['profile', 'html', `${ORIGIN}/user-profile.html`], ['hypothesis-client', 'javascript', ports.assetUrl('hypothesis/build/boot.js')],
            ]) {
                const link = document.createElement('link'); link.rel = rel; link.type = `application/annotator+${type}`; link.href = href;
                if (rel === 'sidebar') {sidebar = link; link.dataset.fluentreadHypothesis = 'on';}
                add(link);
            }
            const preload = document.createElement('link'); preload.rel = 'preload'; preload.as = 'style'; preload.crossOrigin = 'anonymous'; preload.href = ports.assetUrl('hypothesis/build/styles/annotator.css'); add(preload);
            for (const file of ['highlights.css', ...('PDFViewerApplication' in window ? ['pdfjs-overrides.css'] : [])]) {
                const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = ports.assetUrl(`hypothesis/build/styles/${file}`); add(link);
            }
            const ready = readiness();
            await ports.inject();
            if (!wanted || disposed) cancelReady?.();
            active = await ready && wanted && !disposed;
            const failed = !active && wanted && !disposed;
            if (!active) await unload();
            if (failed) wanted = false;
            return {status: failed ? 'failed' : 'success', active};
        } catch {
            wanted = false;
            await unload(); return {status: 'failed', active: false};
        }
    }
    function setEnabled(enabled: boolean): Promise<HypothesisResult> {
        wanted = enabled && !disposed;
        if (!wanted) {preparing?.abort(); sidebar?.setAttribute('data-fluentread-hypothesis', 'off'); cancelReady?.();}
        if (pending) return pending.then(() => setEnabled(wanted));
        if (wanted === active) return Promise.resolve({status: 'success', active});
        const operation = wanted ? start() : unload().then((): HypothesisResult => ({status: 'success', active: false}));
        pending = operation.finally(() => {pending = undefined;});
        return pending;
    }
    return {isActive: () => active, toggle: () => setEnabled(!wanted), setEnabled,
        dispose: () => {disposed = true; return setEnabled(false);}};
}

/** 扩展阅读器只能加载随包静态脚本；网页由后台 executeScript 在隔离世界执行同一文件。 */
export function injectHypothesisDocumentScript(document: Document, src: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script'); script.src = src; script.dataset.hypothesisAsset = '';
        script.onload = () => {script.remove(); resolve();};
        script.onerror = () => {script.remove(); reject(new Error('Hypothesis client could not load'));};
        document.head.append(script);
    });
}
