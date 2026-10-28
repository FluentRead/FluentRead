import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createHash} from 'node:crypto';
import {parseHTML} from 'linkedom';
import {toRaw} from 'vue';

const client = vi.hoisted(() => ({translate: vi.fn(), prepare: vi.fn(), fetch: vi.fn(), settings: vi.fn()}));
vi.mock('@/src/platform/browser/runtimeMessages', () => ({sendRuntimeMessage: client.settings}));
const configNotifications = vi.hoisted(() => new Set<() => void>());
const rawSettings = vi.hoisted(() => ({on: true, disableImageTranslator: false, from: 'auto', to: 'zh-Hans', service: 'google', useCache: true, animations: false}));
vi.mock('@/src/features/image-translation/services/client', () => ({
    translateImageInExtension: client.translate,
    prepareImageOcrLanguages: client.prepare,
    fetchImageInExtension: client.fetch,
}));
vi.mock('@/src/services/config/store', async () => {
    const {reactive, watch} = await import('vue');
    const config = reactive(rawSettings);
    return {config, subscribeConfig: (listener: (value: typeof config) => void) => {
        const notify = () => listener(config); configNotifications.add(notify);
        const stop = watch(config, listener);
        return () => {stop(); configNotifications.delete(notify);};
    }};
});
import {createImageTranslationFailure} from '@/src/features/image-translation/failure';
import {config as settings} from '@/src/services/config/store';
import {mountImageTranslator, unmountImageTranslator, toggleContextMenuImage, toggleMangaTranslation, subscribeMangaTranslation} from '@/src/features/image-translation/content';
import type {MangaTranslationStatus} from '@/src/features/image-translation/content/mangaSession';
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';
import * as controlsModule from '@/src/features/image-translation/content/controls';

// 本文件断言非中文界面文案；扩展运行时按需加载，测试中一次注册全部语言资源包。
registerAllUiLanguageBundles();

const result = {image: 'data:image/png;base64,translated', lines: [{text: '完整译文', bbox: {x0: 0, y0: 0, x1: 100, y1: 20}, backgroundColor: '#fff'}]};
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
    return {promise, resolve, reject};
};
const flush = async () => { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); };
const restoreAnimationPorts: Array<() => void> = [];

function setup(bitmapSize = {width:400,height:200}) {
    const {document, window: domWindow} = parseHTML('<html><head><title>Image fixture</title></head><body><div id="clip"><img src="https://example.test/source.png" srcset="https://example.test/source.png 1x" /></div></body></html>');
    const prototype = domWindow.Element.prototype, animationPort = Object.getOwnPropertyDescriptor(prototype, 'getAnimations');
    Object.defineProperty(prototype, 'getAnimations', {configurable: true, value: () => []});
    restoreAnimationPorts.push(() => {if (animationPort) Object.defineProperty(prototype, 'getAnimations', animationPort);else Reflect.deleteProperty(prototype, 'getAnimations');});
    const originalCreate = document.createElement.bind(document);
    const image = document.querySelector('img') as HTMLImageElement;
    // linkedom 尚不实现 CSSStyleDeclaration priority；保留真实样式序列化并补足浏览器的单属性优先级语义。
    const decorateStyle = (element: HTMLElement) => {
        const actual = element.style;
        const priorities = new Map<string, string>();
        Object.defineProperty(element, 'style', {configurable: true, value: new Proxy(actual, {
            get(target, property) {
                if (property === 'getPropertyPriority') return (name: string) => priorities.get(name) || '';
                if (property === 'setProperty') return (name: string, value: string, priority = '') => {
                    priorities.set(name, priority); actual.setProperty(name, value);
                };
                if (property === 'removeProperty') return (name: string) => {priorities.delete(name); return actual.removeProperty(name);};
                const value = Reflect.get(target, property);
                return typeof value === 'function' ? value.bind(target) : value;
            },
            set(target, property, value) {priorities.delete(String(property)); return Reflect.set(target, property, value);},
        })});
    };
    decorateStyle(image);
    const parent = document.querySelector('#clip') as HTMLDivElement;
    const imageQuery = vi.spyOn(parent, 'querySelectorAll');
    let rect = {left: 20, top: 40, width: 400, height: 200, right: 420, bottom: 240};
    Object.defineProperties(image, {
        naturalWidth: {configurable: true, value: 400, writable: true},
        naturalHeight: {configurable: true, value: 200, writable: true},
        complete: {configurable: true, value: true, writable: true},
        currentSrc: {configurable: true, get: () => image.src},
        offsetWidth: {configurable: true, value: 400},
        offsetHeight: {configurable: true, value: 200},
    });
    image.getBoundingClientRect = () => rect as DOMRect;
    const imageStyle = {objectFit: 'contain', objectPosition: 'right 10px bottom 20px', paddingTop: '4px', paddingRight: '6px', paddingBottom: '8px', paddingLeft: '10px', borderTopWidth: '1px', borderRightWidth: '2px', borderBottomWidth: '3px', borderLeftWidth: '4px', borderRadius: '12px', opacity: '1', visibility: 'visible', display: 'block', filter: 'none'};
    const parentStyle = {overflowX: 'visible', overflowY: 'visible', opacity: '1'};
    const extraStyles = new Map<Element, Record<string, string>>();
    const getStyle = (element: Element) => extraStyles.has(element) ? {...extraStyles.get(element), opacity: (element as HTMLElement).style.opacity || extraStyles.get(element)!.opacity, backgroundImage: (element as HTMLElement).style.backgroundImage || extraStyles.get(element)!.backgroundImage} : element === image ? {...imageStyle, opacity: image.style.opacity || imageStyle.opacity} : element === parent ? parentStyle : {opacity: '1', overflowX: 'visible', overflowY: 'visible'};
    const draw = vi.fn();
    const canvases: HTMLCanvasElement[] = [];
    let autoEncode = true;
    const pendingPng: BlobCallback[] = [];
    const readers: Reader[] = [];
    class Reader {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readyState = 0;
        result: string | null = null;
        abort = vi.fn(() => {this.readyState = 2;});
        readAsDataURL = () => {
            this.readyState = 1;
            void Promise.resolve().then(() => {
                if (this.readyState !== 1) return;
                this.result = 'data:image/png;base64,source'; this.readyState = 2; this.onload?.();
            });
        };
        constructor() {readers.push(this);}
    }
    vi.stubGlobal('FileReader', Reader);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
        const element = originalCreate(tag);
        if (tag === 'img') decorateStyle(element as HTMLElement);
        if (tag === 'canvas') {
            const canvas = element as HTMLCanvasElement;
            decorateStyle(canvas);
            canvas.getContext = vi.fn(() => ({drawImage: draw, clearRect: vi.fn(), getImageData: vi.fn(() => ({data: new Uint8ClampedArray(8 * 8 * 4).fill(255)}))})) as never;
            canvas.toDataURL = () => 'data:image/png;base64,source';
            canvas.toBlob = vi.fn((callback: BlobCallback) => {
                if (autoEncode) callback(new Blob(['source'])); else pendingPng.push(callback);
            }) as never;
            canvases.push(canvas);
        }
        return element;
    }) as never);
    const roots: ShadowRoot[] = [];
    const originalAttach = domWindow.Element.prototype.attachShadow;
    vi.spyOn(domWindow.Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init: ShadowRootInit) {
        const root = originalAttach.call(this, init);
        roots.push(root);
        return root;
    });
    const decoded: HTMLImageElement[] = [];
    let autoDecode = true;
    vi.stubGlobal('Image', function () {
        const bitmap = originalCreate('img') as HTMLImageElement;
        Object.defineProperties(bitmap, {
            naturalWidth: {value: bitmapSize.width}, naturalHeight: {value: bitmapSize.height},
            src: {configurable: true, get: () => bitmap.getAttribute('src') || '', set: value => {
                bitmap.setAttribute('src', value);
                if (value && autoDecode) void Promise.resolve().then(() => bitmap.onload?.(new domWindow.Event('load')));
            }},
        });
        decoded.push(bitmap);
        return bitmap;
    });
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    const windowHandlers = new Map<string, EventListener>();
    const windowObject = {
        innerWidth: 1000, innerHeight: 800, devicePixelRatio: 2,
        setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
        clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
        requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {frames.set(++frameId, callback); return frameId;}),
        cancelAnimationFrame: vi.fn((id: number) => frames.delete(id)),
        addEventListener: vi.fn((name: string, callback: EventListener) => windowHandlers.set(name, callback)),
        removeEventListener: vi.fn((name: string) => windowHandlers.delete(name)),
    };
    const observers: Array<{callback: MutationCallback; disconnect: ReturnType<typeof vi.fn>; observe: ReturnType<typeof vi.fn>}> = [];
    const resizeObservers: Array<{callback: ResizeObserverCallback; disconnect: ReturnType<typeof vi.fn>; observe: ReturnType<typeof vi.fn>; unobserve: ReturnType<typeof vi.fn>}> = [];
    vi.stubGlobal('MutationObserver', class {
        disconnect = vi.fn(); observe = vi.fn();
        constructor(public callback: MutationCallback) {observers.push(this);}
    });
    vi.stubGlobal('ResizeObserver', class {
        disconnect = vi.fn(); observe = vi.fn(); unobserve = vi.fn();
        constructor(public callback: ResizeObserverCallback) {resizeObservers.push(this);}
    });
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', windowObject);
    vi.stubGlobal('Node', domWindow.Node);
    vi.stubGlobal('HTMLImageElement', domWindow.HTMLImageElement);
    vi.stubGlobal('getComputedStyle', getStyle);
    function dispatch(target: Element, name: string, trusted = true, properties = {}) {
        const event = new domWindow.Event(name, {bubbles: true});
        Object.assign(event, {isTrusted: trusted, pointerType: 'mouse', ...properties});
        target.dispatchEvent(event);
    }
    const hover = () => { dispatch(image, 'pointerover'); vi.advanceTimersByTime(600); };
    const button = () => roots.at(-1)!.querySelector('.fluent-read-image-translation-button') as HTMLButtonElement;
    const click = (trusted = true) => dispatch(button(), 'click', trusted);
    const bitmap = () => roots.at(-1)?.querySelector('.fluent-read-image-translation-bitmap');
    const notify = (attributeName = 'src', type = 'attributes') => observers[0].callback([{type, attributeName, target: image} as unknown as MutationRecord], {} as MutationObserver);
    const runFrames = () => { const callbacks = Array.from(frames.values()); frames.clear(); callbacks.forEach(callback => callback(0)); };
    mountImageTranslator();
    return {image, parent, roots, decoded, canvases, draw, readers, pendingPng, imageStyle, parentStyle, observers, resizeObservers, windowObject,
        hover, button, click, bitmap, dispatch, notify, runFrames, extraStyles, imageQuery,
        addBackground: () => {
            const background = document.createElement('div'); decorateStyle(background);
            background.getBoundingClientRect = () => rect as DOMRect;
            background.style.backgroundImage = `url("${image.src}")`;
            extraStyles.set(background, {backgroundImage: background.style.backgroundImage, backgroundSize: 'cover', backgroundPosition: 'right bottom', opacity: '1', visibility: 'visible', display: 'block'});
            parent.prepend(background); imageStyle.opacity = '0';
            return background;
        },
        scroll: () => windowHandlers.get('scroll')?.(new domWindow.Event('scroll')),
        setRect: (next: typeof rect) => {rect = next;},
        setAutoDecode: (enabled: boolean) => {autoDecode = enabled;},
        setAutoEncode: (enabled: boolean) => {autoEncode = enabled;},
    };
}

function addSecondHoverImage(env: ReturnType<typeof setup>, getRect: () => DOMRect): HTMLImageElement {
    const second = env.image.ownerDocument.createElement('img') as HTMLImageElement;
    second.src = 'https://example.test/second.png';
    Object.defineProperties(second, {
        naturalWidth: {value: 400}, naturalHeight: {value: 200}, complete: {value: true},
        currentSrc: {get: () => second.src}, offsetWidth: {value: 400}, offsetHeight: {value: 200},
    });
    second.getBoundingClientRect = getRect;
    env.parent.appendChild(second);
    return second;
}

beforeEach(() => {
    vi.useFakeTimers();
    settings.imageTranslationMangaEnabled = true; settings.imageTranslationHoverEnabled = true; settings.imageTranslationContextMenuEnabled = true;
    settings.imageTranslationMangaCachePages = 12;
    settings.imageTranslationOcrEngine = 'tesseract';
    settings.imageTranslationMangaDownloadConfirmed = false;
    settings.imageTranslationMangaSites = [];
    settings.from = 'auto';
    settings.uiLanguage = 'zh-CN';
    settings.on = true; settings.disableImageTranslator = false; settings.to = 'zh-Hans'; settings.useCache = true;
    settings.theme = 'auto'; settings.modelThinking = {}; settings.system_role = {}; settings.user_role = {};
    settings.imageTranslationService = ''; settings.service = 'google'; settings.model = {}; settings.customModel = {}; settings.customBody = {}; settings.proxy = {}; settings.customOpenAIProviders = []; settings.compositeTranslationProviders = []; settings.token = {};
    client.translate.mockReset().mockResolvedValue(result);
    client.prepare.mockReset().mockResolvedValue(undefined);
    client.fetch.mockReset();
    client.settings.mockReset().mockResolvedValue({success: true});
});
afterEach(() => {unmountImageTranslator();while (restoreAnimationPorts.length) restoreAnimationPorts.pop()!(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();});

describe('图片翻译前台交互与生命周期', () => {
    it('打开宿主大图后撤下被遮挡的缩略译图与文字面板，关闭后复用同一译图', async () => {
        const env = setup(); env.hover(); env.click(); await flush();
        const bitmap = env.bitmap()!;
        const overlay = bitmap.parentElement!;
        const reader = env.roots[0].querySelector<HTMLElement>('.fr-image-reader')!;
        env.dispatch(env.roots[0].querySelector('[aria-label="查看完整译文"]')!, 'click');
        expect(reader.hidden).toBe(false);
        const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog');
        document.body.append(dialog);
        Object.assign(document, {elementsFromPoint: vi.fn(() => [dialog, env.image, env.parent, document.body])});
        env.notify('', 'childList'); env.runFrames();
        expect(overlay.style.display).toBe('none');
        expect(env.image.style.opacity).not.toBe('0');
        expect(reader.hidden).toBe(true);
        expect(env.bitmap()).toBe(bitmap);
        dialog.remove();
        Object.assign(document, {elementsFromPoint: vi.fn(() => [env.image, env.parent, document.body])});
        env.notify('', 'childList'); env.runFrames();
        expect(overlay.style.display).toBe('block');
        expect(env.image.style.opacity).toBe('0');
        expect(env.bitmap()).toBe(bitmap);
        expect(client.translate).toHaveBeenCalledOnce();
    });

    it('宿主遮挡期间完成的请求保留结果，遮挡解除前不覆盖页面', async () => {
        const env = setup(); const pending = deferred<typeof result>();
        client.translate.mockReturnValueOnce(pending.promise);
        env.hover(); env.click(); await flush();
        const cover = document.createElement('div'); document.body.append(cover);
        Object.assign(document, {elementsFromPoint: () => [cover, env.image]});
        env.notify('', 'childList'); env.runFrames();
        pending.resolve(result); await flush();
        expect(env.bitmap()!.parentElement!.style.display).toBe('none');
        expect(env.image.style.opacity).not.toBe('0');
        cover.remove(); Object.assign(document, {elementsFromPoint: () => [env.image]});
        env.notify('', 'childList'); env.runFrames();
        expect(env.bitmap()!.parentElement!.style.display).toBe('block');
        expect(env.image.style.opacity).toBe('0');
        expect(client.translate).toHaveBeenCalledOnce();
    });

    it('图片滚出视口时仍可阅读独立文字面板', async () => {
        const env = setup(); env.hover(); env.click(); await flush();
        env.dispatch(env.roots[0].querySelector('[aria-label="查看完整译文"]')!, 'click');
        const reader = env.roots[0].querySelector<HTMLElement>('.fr-image-reader')!;
        expect(reader.hidden).toBe(false);
        env.setRect({left:20, top:-300, width:400, height:200, right:420, bottom:-100});
        env.scroll(); env.runFrames();
        expect(env.bitmap()!.parentElement!.style.display).toBe('none');
        expect(reader.hidden).toBe(false);
    });

    it('翻译后离开图片隐藏操作条，回到译图恢复入口且不重复翻译', async () => {
        const env = setup();env.hover();env.click();await flush();
        const controls = env.button().closest<HTMLElement>('.fr-image-controls')!;
        const bitmap = env.bitmap();
        env.dispatch(env.image,'pointerout');expect(controls.hidden).toBe(true);expect(env.bitmap()).toBe(bitmap);
        env.hover();expect(controls.hidden).toBe(false);
        env.dispatch(env.image,'pointerout');
        const host = document.getElementById('fluent-read-image-translation-root')!;
        env.dispatch(host,'pointerover',true,{clientX:40,clientY:80});expect(controls.hidden).toBe(false);
        env.dispatch(host,'pointermove',true,{clientX:40,clientY:80});env.runFrames();expect(controls.hidden).toBe(false);
        env.dispatch(document.body,'pointerover');expect(controls.hidden).toBe(true);
        expect(client.translate).toHaveBeenCalledOnce();
    });

    it('本地失败提供设置导航，用户修改图片服务后重试使用新配置', async () => {
        settings.imageTranslationService = 'localTranslation';
        client.translate.mockRejectedValueOnce(createImageTranslationFailure('图片第 2 段文字翻译失败：旧文案',{errorCode:'language'}));
        const env=setup();env.hover();env.click();await flush();
        const feedback = env.roots[0].querySelector<HTMLElement>('.fr-image-feedback')!;
        expect(feedback.querySelector('[role=status]')!.textContent).toContain('图片文字已识别');
        expect(feedback.querySelector('[role=status]')!.textContent).not.toContain('第 2 段');
        env.dispatch(feedback.querySelector('.fr-image-model-settings')!,'click');await flush();
        expect(client.settings).toHaveBeenLastCalledWith({type:'openOptionsPage',section:'settings-services',service:'localTranslation'});
        env.dispatch(feedback.querySelector('.fr-image-service-settings')!,'click');await flush();
        expect(client.settings).toHaveBeenLastCalledWith({type:'openOptionsPage',section:'settings-image-translation'});
        expect(settings.imageTranslationService).toBe('localTranslation');expect(client.translate).toHaveBeenCalledOnce();
        settings.imageTranslationService='microsoft';env.click();await flush();expect(env.button().dataset.phase).toBe('translated');
        expect(client.translate).toHaveBeenCalledTimes(2);expect(feedback.hidden).toBe(true);
    });

    it('打开设置失败保留原图并提供手动入口，卸载后的导航失败不重建控件', async () => {
        client.translate.mockRejectedValueOnce(createImageTranslationFailure('not downloaded',{errorCode:'notDownloaded'}));
        const env=setup();env.hover();env.click();await flush();
        client.settings.mockResolvedValueOnce({success:false});
        const button = env.roots[0].querySelector('.fr-image-model-settings')!;env.dispatch(button,'click');await flush();
        expect(env.roots[0].querySelector('[role=status]')!.textContent).toContain('扩展菜单');expect(env.bitmap()).toBeNull();
        const pending = deferred<unknown>();client.settings.mockReturnValueOnce(pending.promise);env.dispatch(button,'click');
        unmountImageTranslator();pending.reject(new Error('context invalidated'));await flush();expect(document.getElementById('fluent-read-image-translation-root')).toBeNull();
    });

    it('重复挂载不重复订阅，关闭错误入口归还状态和观察器且可重新悬停', async () => {
        const env = setup(), subscriptions = configNotifications.size;
        mountImageTranslator(); expect(configNotifications.size).toBe(subscriptions);
        client.translate.mockRejectedValueOnce(new Error('temporary failure')); env.hover(); env.click(); await flush();
        const dismiss = env.roots[0].querySelector('.fr-image-dismiss')!;
        env.dispatch(dismiss, 'click'); expect(env.button()).toBeNull(); expect(env.bitmap()).toBeNull();
        expect(env.observers[0].disconnect).toHaveBeenCalled(); expect(env.image.style.opacity).not.toBe('0');
        env.hover(); expect(env.button()).not.toBeNull(); env.click(); await flush();
        expect(env.bitmap()).not.toBeNull();
    });

    it('不同图片的译文阅读器互斥，关闭后再次打开仍可读完整译文', async () => {
        const env = setup(); env.hover(); env.click(); await flush();
        const one = env.roots[0].querySelector('[aria-label="查看完整译文"]')!;
        env.dispatch(one, 'click');
        const firstReader = env.roots[0].querySelector('.fr-image-reader') as HTMLElement;
        expect(firstReader.hidden).toBe(false);
        const second = addSecondHoverImage(env, env.image.getBoundingClientRect);
        env.dispatch(env.image, 'pointerout'); env.dispatch(second, 'pointerover'); vi.advanceTimersByTime(600);
        env.dispatch(env.roots[0].querySelectorAll('.fluent-read-image-translation-button')[1], 'click'); await flush();
        expect(client.translate).toHaveBeenCalledTimes(2);
        const buttons = env.roots[0].querySelectorAll('[aria-label="查看完整译文"]');
        env.dispatch(buttons[1], 'click');
        const readers = env.roots[0].querySelectorAll('.fr-image-reader') as unknown as HTMLElement[];
        expect(readers[0].hidden).toBe(true); expect(readers[1].hidden).toBe(false);
        env.dispatch(buttons[1], 'click'); expect(readers[1].hidden).toBe(true);
        env.dispatch(one, 'click'); expect(firstReader.hidden).toBe(false);
        expect(firstReader.textContent).toContain('完整译文');
    });

    it('迟到控件回调在卸载后不能重建状态、启动识别或读取器', async () => {
        const create = controlsModule.createImageControls;
        const port = vi.spyOn(controlsModule, 'createImageControls').mockImplementation(actions => create(actions));
        const env = setup(); env.hover(); const actions = port.mock.calls[0][0]; unmountImageTranslator();
        actions.onAction(); actions.onPrepare(); actions.onDismiss?.(); actions.onInspect?.(); await flush();
        expect(client.translate).not.toHaveBeenCalled(); expect(env.bitmap()).toBeNull(); expect(env.button()).toBeNull();
    });

    it.each([{theme: 'dark', matches: false, expected: 'dark'}, {theme: 'light', matches: true, expected: 'light'},
        {theme: 'auto', matches: true, expected: 'dark'}, {theme: 'auto', matches: false, expected: 'light'},
        {theme: 'auto', matches: undefined, expected: 'light'}] as const)(
        '阅读器主题 $theme 跟随媒体查询 $matches', ({theme, matches, expected}) => {
            const env = setup(); settings.theme = theme;
            if (matches !== undefined) Object.assign(env.windowObject, {matchMedia: () => ({matches})});
            env.hover(); expect((env.roots[0].querySelector('.fr-image-reader') as HTMLElement).dataset.theme).toBe(expected);
        },
    );

    it('没有 ResizeObserver 时仍随滚动更新，默认透明度与零布局尺寸安全回退', async () => {
        const env = setup(); vi.stubGlobal('ResizeObserver', undefined);
        env.imageStyle.opacity = ''; env.parentStyle.opacity = '';
        Object.defineProperties(env.parent, {offsetWidth: {value: 0}, offsetHeight: {value: 0}, clientLeft: {value: 0}, clientTop: {value: 0}, clientWidth: {value: 500}, clientHeight: {value: 300}});
        env.parentStyle.overflowX = 'hidden'; env.parentStyle.overflowY = 'hidden';
        env.parent.getBoundingClientRect = () => ({left: 0, top: 0, right: 500, bottom: 300, width: 500, height: 300}) as DOMRect;
        env.hover(); env.click(); await flush(); expect(env.bitmap()).not.toBeNull();
        expect(env.resizeObservers).toHaveLength(0); env.scroll(); env.runFrames();
        expect(env.bitmap()).not.toBeNull(); expect(env.image.style.opacity).toBe('0');
    });

    it('等待原图的 load 没有像素时报告加载错误，不发请求且可主动重试', async () => {
        const env = setup(); Object.defineProperties(env.image, {complete: {value: false, configurable: true}, naturalWidth: {value: 0, configurable: true}});
        env.hover(); env.click(); await flush(); env.dispatch(env.image, 'load'); await flush();
        expect(client.translate).not.toHaveBeenCalled(); expect(env.button().dataset.phase).toBe('error');
        Object.defineProperties(env.image, {complete: {value: true, configurable: true}, naturalWidth: {value: 400, configurable: true}});
        env.click(); await flush(); expect(client.translate).toHaveBeenCalledOnce();
    });

    it('角色与思考设置改变使译图身份失效，不复用其他语义的缓存', async () => {
        const env = setup(); settings.modelThinking = undefined as never; settings.system_role = undefined as never; settings.user_role = undefined as never;
        settings.customModel = {google: 'custom-model'}; settings.model = {google: 'model'};
        env.hover(); env.click(); await flush(); env.click();
        settings.modelThinking = {google: {'model': true, 'custom-model': false}};
        settings.system_role = {google: 'first role'}; settings.user_role = {google: 'first prompt'};
        env.click(); await flush(); expect(client.translate).toHaveBeenCalledTimes(2); env.click();
        settings.system_role.google = 'new role'; env.click(); await flush(); expect(client.translate).toHaveBeenCalledTimes(3);
        settings.modelThinking = undefined as never; settings.system_role = undefined as never; settings.user_role = undefined as never;
    });

    it('不可信移出、触摸移动和关闭悬浮不触发读取，非元素与 body 命中不扫描整页', () => {
        const env = setup(); env.hover(); env.dispatch(env.image, 'pointerout', false); vi.advanceTimersByTime(200);
        expect(env.button()).not.toBeNull();
        env.dispatch(document as never, 'pointerover'); env.dispatch(document.body, 'pointerover');
        const queries = vi.spyOn(document, 'querySelectorAll');
        env.dispatch(document.body, 'pointermove', true, {pointerType: 'touch'}); env.runFrames();
        settings.imageTranslationHoverEnabled = false;
        env.dispatch(env.image, 'pointermove'); env.runFrames(); vi.advanceTimersByTime(600);
        expect(client.translate).not.toHaveBeenCalled(); expect(queries).not.toHaveBeenCalled();
    });

    it('已有译图的入口切回时立即显示，不重复等待、请求或创建观察器', async () => {
        const env = setup(); env.hover(); env.click(); await flush(); const first = env.button();
        const second = addSecondHoverImage(env, env.image.getBoundingClientRect);
        env.dispatch(second, 'pointerover'); vi.advanceTimersByTime(600);
        const observed = env.resizeObservers.length;
        env.dispatch(env.image, 'pointerover'); expect(env.button()).toBe(first); expect(env.resizeObservers).toHaveLength(observed);
        expect(client.translate).toHaveBeenCalledOnce(); expect(env.bitmap()).not.toBeNull();
    });

    it('读取 PNG 期间取消不启动后台，迟到结果不覆盖原图且可正常重试', async () => {
        const env = setup(); env.setAutoEncode(false); env.hover(); env.click(); await flush();
        expect(env.button().textContent).toContain('取消'); expect(client.translate).not.toHaveBeenCalled();
        expect(env.canvases[0]).toMatchObject({width: 400, height: 200});
        expect(env.image.style.opacity).not.toBe('0');
        env.click(); await flush();
        expect(env.canvases[0]).toMatchObject({width: 0, height: 0});
        env.pendingPng.shift()!(new Blob(['late'])); await flush();
        expect(env.readers).toHaveLength(0); expect(env.bitmap()).toBeNull(); expect(client.translate).not.toHaveBeenCalled();
        expect(env.image.src).toBe('https://example.test/source.png');
        env.setAutoEncode(true); env.click(); await flush();
        expect(client.translate).toHaveBeenCalledOnce(); expect(env.bitmap()).not.toBeNull();
    });

    it.each(['换图', '卸载'])('读取 PNG 期间%s会释放画布且迟到结果不能发往后台', async action => {
        const env = setup(); env.setAutoEncode(false); env.hover(); env.click(); await flush();
        expect(env.pendingPng).toHaveLength(1);
        if (action === '换图') {env.image.src = 'https://example.test/next.png'; env.notify(); env.runFrames();}
        else unmountImageTranslator();
        await flush(); env.pendingPng.shift()!(new Blob(['late'])); await flush();
        expect(env.canvases[0]).toMatchObject({width: 0, height: 0}); expect(env.readers).toHaveLength(0);
        expect(client.translate).not.toHaveBeenCalled(); expect(env.image.style.opacity).not.toBe('0');
    });






    it('宿主持续移除 UI 根时停止恢复循环，归还原图且允许新的主动悬停', async () => {
        const env = setup(); const background = env.addBackground();
        env.hover(); env.click(); await flush();
        expect(background.style.opacity).toBe('0');
        const host = env.image.ownerDocument.getElementById('fluent-read-image-translation-root')!;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            host.remove(); env.notify('', 'childList'); env.runFrames();
            expect(host.isConnected).toBe(attempt < 2);
        }
        expect(background.style.opacity).not.toBe('0');
        expect(env.observers[0].disconnect).toHaveBeenCalled();
        const frames = env.windowObject.requestAnimationFrame.mock.calls.length;
        env.scroll(); env.runFrames();
        expect(env.windowObject.requestAnimationFrame).toHaveBeenCalledTimes(frames);
        env.hover();
        expect(env.image.ownerDocument.getElementById('fluent-read-image-translation-root')).not.toBeNull();
    });
    it('通过配置仓库通知即时更新品牌提示，不依赖配置对象的 Vue 响应式代理', () => {
        const env = setup(); env.hover();
        expect(env.button().title).toBe('流畅阅读 · 翻译图片');
        toRaw(settings).uiLanguage = 'en-US';
        configNotifications.forEach(notify => notify());
        expect(env.button().title).toBe('FluentRead · Translate image');
        expect(env.button().getAttribute('aria-label')).toBe(env.button().title);
        configNotifications.forEach(notify => notify());
        expect(env.button().title).toBe('FluentRead · Translate image');
        toRaw(settings).uiLanguage = 'zh-CN';
        configNotifications.forEach(notify => notify());
        expect(env.button().title).toBe('流畅阅读 · 翻译图片');
        expect(env.button().getAttribute('aria-label')).toBe(env.button().title);
        unmountImageTranslator(); expect(configNotifications.size).toBe(0);
    });

    it.each(['html', 'body-quirks', 'body-propagated'])('整页滚动 %s 后入口、加载和译图仍在视口内', async (mode) => {
        const env = setup();
        const doc = env.image.ownerDocument;
        const root = mode === 'html' ? doc.documentElement : doc.body;
        Object.defineProperty(doc, 'scrollingElement', {value: mode === 'body-quirks' ? doc.body : doc.documentElement});
        env.extraStyles.set(root, {overflowX: 'auto', overflowY: 'scroll', opacity: '1'});
        root.getBoundingClientRect = () => ({left: 0, top: -2622, width: 1000, height: 800, right: 1000, bottom: -1822}) as DOMRect;
        Object.defineProperties(root, {offsetWidth: {value: 1000}, offsetHeight: {value: 800}, clientWidth: {value: 1000}, clientHeight: {value: 800}, clientLeft: {value: 0}, clientTop: {value: 0}});
        const background = env.addBackground();
        const pending = deferred<typeof result>(); client.translate.mockReturnValue(pending.promise);
        env.hover();
        const overlay = env.roots[0].querySelector('.fluent-read-image-translation-overlay') as HTMLElement;
        expect(overlay.style.display).toBe('block');
        env.click(); await flush();
        expect(env.button().dataset.phase).toBe('loading');
        expect((env.roots[0].querySelector('.fr-image-feedback') as HTMLElement).hidden).toBe(false);
        expect(background.style.opacity).not.toBe('0');
        pending.resolve(result); await flush();
        expect(overlay.style.display).toBe('block');
        expect(overlay.style.clipPath).toBe('inset(0px 0px 0px 0px)');
        expect(env.bitmap()?.isConnected).toBe(true);
        expect(background.style.opacity).toBe('0');
        env.click(); expect(background.style.opacity).not.toBe('0');
    });

    it('译图在视口外完成时保留原图，重入视口再交接；宿主移除 UI 根节点后恢复挂载', async () => {
        const env = setup(); const background = env.addBackground();
        const pending = deferred<typeof result>(); client.translate.mockReturnValue(pending.promise);
        env.hover(); env.click(); await flush();
        env.setRect({left: 20, top: -400, width: 400, height: 200, right: 420, bottom: -200});
        pending.resolve(result); await flush();
        expect(background.style.opacity).not.toBe('0');
        env.setRect({left: 20, top: 40, width: 400, height: 200, right: 420, bottom: 240});
        env.scroll(); env.runFrames();
        expect(background.style.opacity).toBe('0');
        const host = env.image.ownerDocument.getElementById('fluent-read-image-translation-root')!;
        host.remove(); env.scroll(); env.runFrames();
        expect(host.isConnected).toBe(true); expect(env.bitmap()?.isConnected).toBe(true);
        env.setRect({left: 20, top: -400, width: 400, height: 200, right: 420, bottom: -200});
        env.scroll(); env.runFrames(); expect(background.style.opacity).not.toBe('0');
    });

    it('空闲不观察整页，首个覆盖层启用观察，移除后断开且下次悬停可重新启用', () => {
        const env = setup();
        expect(env.observers).toHaveLength(0);
        env.hover();
        expect(env.observers).toHaveLength(1);
        env.image.remove();
        env.notify('', 'childList');
        expect(env.observers[0].disconnect).toHaveBeenCalledOnce();
        env.parent.appendChild(env.image);
        env.hover();
        expect(env.observers).toHaveLength(2);
    });

    it('合成与触屏悬浮不创建入口，合成点击不能触发识别；小图不分配状态', async () => {
        const env = setup();
        env.dispatch(env.image, 'pointerover', false);
        env.dispatch(env.image, 'pointerover', true, {pointerType: 'touch'});
        expect(env.roots).toHaveLength(0);
        env.setRect({left: 0, top: 0, width: 20, height: 20, right: 20, bottom: 20}); env.hover();
        expect(env.roots).toHaveLength(0);
        env.setRect({left: 20, top: 40, width: 400, height: 200, right: 420, bottom: 240}); env.hover();
        env.click(false); await flush();
        expect(client.translate).not.toHaveBeenCalled();
        expect(env.image.ownerDocument.getElementById('fluent-read-image-translation-root')!.shadowRoot).toBeNull();
    });

    it('翻译、恢复、悬浮状态卸载后再翻译直接复用译图，保留原 src 与 srcset', async () => {
        const env = setup();
        const source = env.image.getAttribute('src');
        const sourceSet = env.image.getAttribute('srcset');
        env.hover(); env.click(); await flush();
        expect(env.bitmap()).toBe(env.decoded[0]);
        expect(env.button().dataset.phase).toBe('translated');
        expect(env.image.getAttribute('src')).toBe(source);
        expect(env.image.getAttribute('srcset')).toBe(sourceSet);
        env.click(); expect(env.bitmap()).toBeNull();
        env.dispatch(env.image, 'pointerout'); vi.advanceTimersByTime(200);
        expect(env.roots[0].querySelector('.fluent-read-image-translation-button')).toBeNull();
        env.hover(); env.click(); await flush();
        expect(env.bitmap()).toBe(env.decoded[0]);
        expect(client.translate).toHaveBeenCalledOnce();
        expect(env.draw).toHaveBeenCalledOnce();
    });

    it('透明译图完整替代原图且保持原透明度、背景和边框，恢复时归还原样式优先级', async () => {
        const env = setup();
        env.image.style.setProperty('opacity', '0.65', 'important');
        env.image.style.setProperty('transition', 'opacity 2s ease', 'important');
        Object.assign(env.imageStyle, {backgroundColor: 'rgb(255, 255, 255)', borderLeftColor: 'rgb(255, 0, 0)', borderLeftStyle: 'solid'});
        env.hover(); env.click(); await flush();
        const bitmap = env.bitmap() as HTMLImageElement;
        expect(env.image.style.opacity).toBe('0');
        expect(env.image.style.getPropertyPriority('opacity')).toBe('important');
        expect(env.image.style.transition).toBe('none');
        expect(bitmap.style.opacity).toBe('0.65'); expect(bitmap.parentElement!.style.display).toBe('block');
        expect(bitmap.style.backgroundColor).toBe('rgb(255, 255, 255)'); expect(bitmap.style.borderLeftColor).toBe('rgb(255, 0, 0)');
        expect(bitmap.style.borderLeftStyle).toBe('solid');
        env.hover(); expect(env.bitmap()).toBe(bitmap); expect(bitmap.parentElement!.style.display).toBe('block');
        env.image.style.color = 'blue'; env.click();
        expect(env.image.style.opacity).toBe('0.65'); expect(env.image.style.getPropertyPriority('opacity')).toBe('important');
        expect(env.image.style.transition).toBe('opacity 2s ease'); expect(env.image.style.getPropertyPriority('transition')).toBe('important');
        expect(env.image.style.color).toBe('blue');
    });

    it('换图、同 URL 重载和卸载时还原原图，不留下空 style 属性', async () => {
        const env = setup(); env.hover(); env.click(); await flush();
        expect(env.image.style.opacity).toBe('0');
        env.image.src = 'https://example.test/replaced.png'; env.notify();
        expect(env.image.hasAttribute('style')).toBe(false);
        env.dispatch(env.image, 'load'); // 替换图先完成首次加载，下面的 load 才是同地址重载。
        env.click(); await flush(); expect(env.image.style.opacity).toBe('0');
        env.dispatch(env.image, 'load'); expect(env.image.hasAttribute('style')).toBe(false);
        env.click(); await flush(); unmountImageTranslator();
        expect(env.image.hasAttribute('style')).toBe(false); expect(env.image.src).toBe('https://example.test/replaced.png');
    });

    it('原图仅声明 transition longhand 时也保留原声明和优先级', async () => {
        const env = setup();
        env.image.style.setProperty('transition-property', 'opacity', 'important');
        env.image.style.setProperty('transition-duration', '2s');
        env.hover(); env.click(); await flush(); env.click();
        expect(env.image.style.getPropertyValue('transition-property')).toBe('opacity');
        expect(env.image.style.getPropertyPriority('transition-property')).toBe('important');
        expect(env.image.style.getPropertyValue('transition-duration')).toBe('2s');
    });

    it('宿主修改 opacity 或 transition 时只归还仍属于自己的属性，不覆盖新样式', async () => {
        const env = setup(); env.image.style.setProperty('opacity', '0.8');
        env.hover(); env.click(); await flush();
        env.image.style.setProperty('opacity', '0.25'); env.image.style.setProperty('transition', 'color 1s');
        env.notify('style'); env.runFrames();
        expect(env.bitmap()).toBeNull(); expect(env.button().dataset.phase).toBe('idle');
        expect(env.image.style.opacity).toBe('0.25'); expect(env.image.style.getPropertyPriority('opacity')).toBe('');
        expect(env.image.style.transition).toBe('color 1s');
        env.click(); await flush(); env.image.style.setProperty('transition', 'transform 1s'); env.click();
        expect(env.image.style.opacity).toBe('0.25'); expect(env.image.style.transition).toBe('transform 1s');
    });

    it('取消旧请求后可以重试，旧请求的延迟返回不能覆盖新译图', async () => {
        const first = deferred<typeof result>();
        client.translate.mockReturnValueOnce(first.promise);
        const env = setup(); env.hover(); env.click(); await flush();
        const firstSignal = client.translate.mock.calls[0][3].signal as AbortSignal;
        env.click(); expect(firstSignal.aborted).toBe(true);
        env.click(); await flush();
        expect(env.button().dataset.phase).toBe('translated');
        first.resolve({...result, image: 'data:image/png;base64,obsolete'}); await flush();
        expect(env.decoded).toHaveLength(1);
        expect(env.bitmap()).toBe(env.decoded[0]);
    });

    it('src 改变立即取消在途任务并忽略旧结果，srcset 与 picture source 改变撤下译图', async () => {
        const first = deferred<typeof result>(); client.translate.mockReturnValueOnce(first.promise);
        const env = setup(); env.hover(); env.click(); await flush();
        env.image.setAttribute('src', 'https://example.test/new.png'); env.notify();
        expect(client.translate.mock.calls[0][3].signal.aborted).toBe(true);
        first.resolve(result); await flush(); expect(env.bitmap()).toBeNull();
        env.click(); await flush(); expect(env.bitmap()).not.toBeNull();
        env.image.setAttribute('srcset', 'https://example.test/new2.png 2x'); env.notify('srcset');
        expect(env.bitmap()).toBeNull(); expect(env.button().dataset.phase).toBe('idle');
        const picture = env.image.ownerDocument.createElement('picture');
        const source = env.image.ownerDocument.createElement('source'); source.setAttribute('srcset', 'https://example.test/other.png');
        env.parent.append(picture); picture.append(source, env.image); env.notify('srcset');
        env.click(); await flush(); expect(env.bitmap()).not.toBeNull();
        source.setAttribute('media', '(min-width: 800px)'); env.notify('media');
        expect(env.bitmap()).toBeNull();
    });

    it('图片独立服务切换使缓存失效，默认网页服务保持不变', async () => {
        const env = setup(); env.hover(); env.click(); await flush(); env.click();
        settings.imageTranslationService = 'microsoft'; env.click(); await flush();
        expect(client.translate).toHaveBeenCalledTimes(2);
        expect(settings.service).toBe('google');
        env.click(); settings.imageTranslationService = ''; env.click(); await flush();
        expect(client.translate).toHaveBeenCalledTimes(3);
    });

    it('切换单图识别方式使旧译图缓存失效，PaddleOCR 结果保留普通图片控件', async () => {
        const env = setup(); env.hover(); env.click(); await flush(); env.click();
        settings.imageTranslationOcrEngine = 'paddle'; env.click(); await flush();
        expect(client.translate).toHaveBeenCalledTimes(2);
        expect(client.translate.mock.calls.at(-1)?.[3]).not.toHaveProperty('manga');
        expect(env.button().dataset.phase).toBe('translated');
        expect(env.button().closest<HTMLElement>('.fr-image-controls')?.hidden).toBe(false);
        env.click();settings.imageTranslationOcrEngine = 'tesseract';env.click();await flush();
        expect(client.translate).toHaveBeenCalledTimes(3);
    });

    it('同 URL 重新加载与目标语言变更都使已恢复的缓存失效' , async () => {
        const env = setup(); env.hover(); env.click(); await flush(); env.click();
        env.dispatch(env.image, 'pointerout'); vi.advanceTimersByTime(200);
        env.dispatch(env.image, 'load'); env.hover(); env.click(); await flush();
        expect(client.translate).toHaveBeenCalledTimes(2);
        env.click(); settings.to = 'fr'; env.click(); await flush();
        expect(client.translate).toHaveBeenCalledTimes(3);
    });

    it('禁用缓存后恢复再翻译会重新请求，在途配置变更提示重试', async () => {
        settings.useCache = false;
        const env = setup(); env.hover(); env.click(); await flush(); env.click(); env.click(); await flush();
        expect(client.translate).toHaveBeenCalledTimes(2);
        env.click(); const pending = deferred<typeof result>(); client.translate.mockReturnValueOnce(pending.promise);
        env.click(); await flush(); settings.to = 'de'; pending.resolve(result); await flush();
        expect(env.bitmap()).toBeNull();
        expect(env.roots[0].querySelector('[role="status"]')!.textContent).toContain('翻译设置已更改');
    });

    it('图片服务变更立即取消旧识别，旧端口不响应时仍可按新配置重试', async () => {
        const pending = deferred<typeof result>(); client.translate.mockReturnValueOnce(pending.promise);
        const env = setup(); env.hover(); env.click(); await flush();
        const signal = client.translate.mock.calls[0][3].signal as AbortSignal;
        settings.to = 'de';
        expect(signal.aborted).toBe(true);
        expect(env.button().dataset.phase).toBe('error');
        expect(env.roots[0].querySelector('[role="status"]')!.textContent).toContain('翻译设置已更改');
        env.click(); await flush();
        expect(client.translate).toHaveBeenCalledTimes(2);
        expect(env.button().dataset.phase).toBe('translated');
        pending.resolve({...result, image: 'data:image/png;base64,old'}); await flush();
        expect(env.button().dataset.phase).toBe('translated');
        expect(env.bitmap()?.getAttribute('src')).not.toBe('data:image/png;base64,old');
    });

    it('自定义服务也能立即复用译图，只有模型、端点或请求体改变才清空缓存', async () => {
        settings.service = 'custom:fixture';
        settings.model[settings.service] = 'fixture-model';
        settings.customOpenAIProviders = [{id: settings.service, name: 'Fixture', endpoint: 'https://api.example.test/v1/chat/completions?key=private-value', models: ['fixture-model']}];
        const env = setup(); env.hover(); env.click(); await flush(); env.click();
        settings.token[settings.service] = 'a-new-key'; env.click(); await flush();
        expect(client.translate).toHaveBeenCalledOnce();
        for (const mutate of [
            () => {settings.customOpenAIProviders[0].endpoint = 'https://other.example.test/v1/chat/completions';},
            () => {settings.model[settings.service] = 'other-model';},
            () => {settings.customBody[settings.service] = '{"temperature":0.1}';},
        ]) {
            env.click(); mutate(); env.click(); await flush();
        }
        expect(client.translate).toHaveBeenCalledTimes(4);
        expect(env.button().dataset.phase).toBe('translated');
    });

    it('组合成员变化清空图片结果，未选服务修改仍可复用当前译图', async () => {
        settings.service = 'composite:image';
        settings.compositeTranslationProviders = [{id: settings.service, name: '图片组合', strategy: 'sequential', services: ['google', 'custom:fixture'], timeoutMs: 12_000}];
        settings.customOpenAIProviders = [{id: 'custom:fixture', name: 'Fixture', endpoint: 'https://api.example.test/v1', models: ['fixture']}];
        settings.token['custom:fixture'] = 'synthetic-private-member';
        const env = setup(); env.hover(); env.click(); await flush(); env.click();
        settings.token.openai = 'unrelated'; env.click(); await flush();
        expect(client.translate).toHaveBeenCalledOnce();
        for (const mutate of [
            () => {settings.customOpenAIProviders[0].endpoint += '/changed';},
            () => {settings.model.google = 'changed-model';},
            () => {settings.token['custom:fixture'] = 'changed-key';},
            () => {settings.compositeTranslationProviders[0].strategy = 'smart';},
        ]) {
            env.click(); mutate(); env.click(); await flush();
        }
        expect(client.translate).toHaveBeenCalledTimes(5);
        expect(env.button().dataset.phase).toBe('translated');
    });

    it('在途端点变更即使改回原值也拒绝旧结果，卸载后停止观察配置', async () => {
        settings.service = 'custom:fixture';
        let endpoint = 'https://api.example.test/v1/chat/completions';
        let endpointReads = 0;
        settings.customOpenAIProviders = [{id: settings.service, name: 'Fixture', models: ['fixture'],
            get endpoint() {endpointReads++; return endpoint;}, set endpoint(value) {endpoint = value;},
        }];
        const pending = deferred<typeof result>(); client.translate.mockReturnValueOnce(pending.promise);
        const env = setup(); env.hover(); env.click(); await flush();
        settings.customOpenAIProviders[0].endpoint = 'https://other.example.test/v1';
        settings.customOpenAIProviders[0].endpoint = 'https://api.example.test/v1/chat/completions';
        pending.resolve(result); await flush();
        expect(env.bitmap()).toBeNull(); expect(env.button().dataset.phase).toBe('error');
        unmountImageTranslator(); const stoppedReads = endpointReads;
        settings.model[settings.service] = 'new-model';
        expect(endpointReads).toBe(stoppedReads);
        mountImageTranslator(); expect(endpointReads).toBeGreaterThan(stoppedReads);
    });

    it('正在加载的 srcset 图片可以在首次 load 后继续，不误判为旧请求', async () => {
        const env = setup(); Object.defineProperty(env.image, 'complete', {value: false, configurable: true, writable: true});
        env.hover(); env.click(); await flush(); expect(client.translate).not.toHaveBeenCalled();
        Object.defineProperty(env.image, 'currentSrc', {get: () => 'https://example.test/selected@2x.png', configurable: true});
        Object.defineProperty(env.image, 'complete', {value: true, configurable: true});
        env.dispatch(env.image, 'load'); await flush(); expect(client.translate).toHaveBeenCalledOnce();
        expect(env.button().dataset.phase).toBe('translated');
    });

    it('等待原图加载超时后释放等待，迟到 load 不发起识别且用户仍可重试', async () => {
        const env = setup(); Object.defineProperty(env.image, 'complete', {value: false, configurable: true});
        env.hover(); env.click(); await flush(); vi.advanceTimersByTime(15_001); await flush();
        expect(env.button().dataset.phase).toBe('error');
        expect(env.roots[0].querySelector('[role="status"]')!.textContent).toContain('图片加载超时');
        expect(client.translate).not.toHaveBeenCalled();
        Object.defineProperty(env.image, 'complete', {value: true, configurable: true});
        env.dispatch(env.image, 'load'); await flush(); expect(client.translate).not.toHaveBeenCalled();
        env.click(); await flush(); expect(env.button().dataset.phase).toBe('translated');
    });

    it('已恢复译图缓存限制为六张，最早缓存淘汰后重新请求', async () => {
        const env = setup(); env.hover(); env.click(); await flush(); env.click();
        env.dispatch(env.image, 'pointerout'); vi.advanceTimersByTime(200);
        for (let index = 0; index < 6; index++) {
            const image = env.image.ownerDocument.createElement('img');
            image.src = `https://example.test/image-${index}.png`;
            Object.defineProperties(image, {
                naturalWidth: {value: 400}, naturalHeight: {value: 200}, complete: {value: true},
                currentSrc: {get: () => image.src}, offsetWidth: {value: 400}, offsetHeight: {value: 200},
            });
            image.getBoundingClientRect = env.image.getBoundingClientRect;
            env.parent.append(image); env.dispatch(image, 'pointerover'); vi.advanceTimersByTime(600); env.click(); await flush(); env.click();
            env.dispatch(image, 'pointerout'); vi.advanceTimersByTime(200);
        }
        expect(client.translate).toHaveBeenCalledTimes(7);
        env.hover(); env.click(); await flush(); expect(client.translate).toHaveBeenCalledTimes(8);
    });
    it('不足六张也按八百万译图像素淘汰；超预算单图只在当前显示、不留额外缓存',async()=>{
        const env=setup({width:2000,height:1500});env.hover();env.click();await flush();env.click();
        for(let i=0;i<2;i++) {
            const image=addSecondHoverImage(env,env.image.getBoundingClientRect);image.src+=`?${i}`;
            env.dispatch(image,'pointerover');vi.advanceTimersByTime(600);env.click();await flush();env.click();
        }
        expect(client.translate).toHaveBeenCalledTimes(3);
        env.hover();env.click();await flush();expect(client.translate).toHaveBeenCalledTimes(4);
        unmountImageTranslator();
        const oversized=setup({width:3000,height:3000});oversized.hover();oversized.click();await flush();
        expect(oversized.bitmap()).not.toBeNull();oversized.click();oversized.click();await flush();
        expect(client.translate).toHaveBeenCalledTimes(6);
    });

    it('解码期间取消和解码超时清理监听，迟到的 decode 不复活结果', async () => {
        const env = setup(); env.setAutoDecode(false); env.hover(); env.click(); await flush();
        const old = env.decoded[0]; const oldLoad = old.onload;
        env.click(); expect(old.onload).toBeNull(); expect(old.src).toBe('');
        oldLoad?.call(old, new Event('load')); await flush(); expect(env.bitmap()).toBeNull();
        env.click(); await flush(); vi.advanceTimersByTime(15_001); await flush();
        expect(env.button().dataset.phase).toBe('error'); expect(env.roots[0].querySelector('[role="status"]')!.textContent).toContain('译图加载超时');
        expect(env.decoded[1].onload).toBeNull();
    });

    it('原图加载错误清理等待监听，保留原图并允许加载完成后主动重试', async () => {
        const env = setup(); Object.defineProperty(env.image, 'complete', {value: false, configurable: true}); env.hover(); env.click(); await flush();
        env.dispatch(env.image, 'error'); await flush();
        expect(client.translate).not.toHaveBeenCalled(); expect(env.bitmap()).toBeNull();
        expect(env.button().dataset.phase).toBe('error');
        expect(env.roots[0].querySelector('[role="status"]')!.textContent).toContain('图片加载失败');
        Object.defineProperty(env.image, 'complete', {value: true, configurable: true}); env.dispatch(env.image, 'load'); await flush();
        expect(client.translate).not.toHaveBeenCalled();
        env.click(); await flush(); expect(client.translate).toHaveBeenCalledOnce();
        expect(env.button().dataset.phase).toBe('translated');
    });

    it('译图解码失败清理监听并保持原图可见，重试只安装当前译图', async () => {
        const env = setup(); env.setAutoDecode(false); env.hover(); env.click(); await flush();
        const failed = env.decoded[0]; failed.onerror?.call(failed, new Event('error'));
        await flush(); expect(env.bitmap()).toBeNull(); expect(env.image.style.opacity).not.toBe('0');
        expect(failed.onload).toBeNull(); expect(failed.onerror).toBeNull();
        expect(env.roots[0].querySelector('[role="status"]')!.textContent).toContain('图片数据无法解码');
        env.setAutoDecode(true); env.click(); await flush();
        expect(client.translate).toHaveBeenCalledTimes(2); expect(env.bitmap()).toBe(env.decoded[1]);
    });

    it('错误在悬浮时持续可见，支持重试并在离开后清理', async () => {
        client.translate.mockRejectedValueOnce(new Error('服务临时不可用'));
        const env = setup(); env.hover(); env.click(); await flush(); vi.advanceTimersByTime(4000);
        expect(env.button().dataset.phase).toBe('error');
        expect(env.roots[0].querySelector('[role="status"]')!.textContent).toContain('服务临时不可用');
        env.click(); await flush(); expect(env.button().dataset.phase).toBe('translated');
        env.click(); client.translate.mockRejectedValueOnce(new Error('请求失败')); settings.useCache = false;
        env.click(); await flush(); env.dispatch(env.image, 'pointerout'); vi.advanceTimersByTime(200);
        expect(env.roots[0].querySelector('.fr-image-controls')).not.toBeNull();
    });

    it('语言包准备从当前图片原地继续，并展示后台真实进度', async () => {
        client.translate.mockRejectedValueOnce(new Error('请先下载语言包'));
        const env = setup(); env.hover(); env.click(); await flush();
        const prepare = Array.from(env.roots[0].querySelectorAll('button')).find(button => button.textContent === '下载语言包并翻译')!;
        expect(prepare.hidden).toBe(false);
        expect(env.roots[0].querySelector('[role="status"]')!.textContent).toBe('首次使用需准备识别语言包，下载后自动继续');
        env.dispatch(prepare, 'click'); await flush(); expect(client.prepare).toHaveBeenCalledWith('auto', expect.any(AbortSignal), expect.any(Function));
        expect(env.button().dataset.phase).toBe('translated');
        env.click(); settings.useCache = false; const pending = deferred<typeof result>(); client.translate.mockReturnValueOnce(pending.promise);
        env.click(); await flush();
        client.translate.mock.calls.at(-1)![3].onProgress('recognizing', 37);
        expect(env.roots[0].querySelector('[role="status"]')!.textContent).toBe('正在识别图片文字… 37%');
        client.translate.mock.calls.at(-1)![3].onProgress('translating');
        expect(env.roots[0].querySelector('[role="status"]')!.textContent).toBe('正在翻译文字…');
        pending.resolve(result); await flush();
    });

    it('准备语言包期间操作条显示真实下载百分比，完成后迟到的进度不再改写图片状态', async () => {
        client.translate.mockRejectedValueOnce(new Error('请先下载语言包'));
        const env = setup(); env.hover(); env.click(); await flush();
        const prepare = env.roots[0].querySelector('.fr-image-prepare') as HTMLButtonElement;
        const wait = deferred<void>(); client.prepare.mockReturnValueOnce(wait.promise);
        env.dispatch(prepare, 'click'); await flush();
        const status = () => env.roots[0].querySelector('[role="status"]')!.textContent;
        expect(status()).toBe('正在准备识别语言包…');
        const report = client.prepare.mock.calls.at(-1)![2] as (percent: number) => void;
        report(43);
        expect(status()).toBe('正在准备识别语言包… 43%');
        report(80);
        expect(status()).toBe('正在准备识别语言包… 80%');
        wait.resolve(); await flush();
        expect(env.button().dataset.phase).toBe('translated');
        report(99);
        expect(env.button().dataset.phase).toBe('translated');
    });

    it('下载失败可再次准备，下载成功后的翻译失败直接重试而不重复下载', async () => {
        client.translate.mockRejectedValueOnce(new Error('请先下载语言包'));
        const env = setup(); env.hover(); env.click(); await flush();
        const prepare = env.roots[0].querySelector('.fr-image-prepare') as HTMLButtonElement;
        client.prepare.mockRejectedValueOnce(new Error('下载中断'));
        env.dispatch(prepare, 'click'); await flush();
        expect(prepare.hidden).toBe(false);
        expect(env.roots[0].querySelector('[role="status"]')!.textContent).toContain('下载中断');
        client.translate.mockRejectedValueOnce(new Error('翻译服务暂不可用'));
        env.dispatch(prepare, 'click'); await flush();
        expect(prepare.hidden).toBe(true);
        expect(env.button().textContent).toBe('重试');
        const preparations = client.prepare.mock.calls.length;
        env.click(); await flush();
        expect(client.prepare).toHaveBeenCalledTimes(preparations);
        expect(env.button().dataset.phase).toBe('translated');
    });

    it('滚动事件合并一帧，位图采用浏览器原生 object-fit 和盒模型，不重新读取或绘制 Canvas', async () => {
        const env = setup(); env.hover(); env.click(); await flush();
        const bitmap = env.bitmap() as HTMLImageElement;
        expect(bitmap.style.objectFit).toBe('contain'); expect(bitmap.style.objectPosition).toBe('right 10px bottom 20px');
        expect(bitmap.style.paddingLeft).toBe('10px'); expect(bitmap.style.borderBottomWidth).toBe('3px');
        for (let event = 0; event < 100; event++) env.scroll();
        expect(env.windowObject.requestAnimationFrame).toHaveBeenCalledOnce();
        env.setRect({left: 20, top: 10, width: 400, height: 200, right: 420, bottom: 210}); env.runFrames();
        expect(env.bitmap()).toBe(bitmap); expect(env.draw).toHaveBeenCalledOnce(); expect(env.canvases).toHaveLength(1);
        expect(bitmap.parentElement!.style.top).toBe('10px');
        env.imageStyle.objectFit = 'none'; env.resizeObservers[0].callback([], {} as ResizeObserver); env.runFrames();
        expect(bitmap.style.objectFit).toBe('none'); expect(env.draw).toHaveBeenCalledOnce();
    });

    it('祖先滚动裁切、隐藏、图片移除与卸载完整清理，未完成响应不能重新挂载', async () => {
        const env = setup();
        Object.assign(env.parentStyle, {overflowX: 'hidden', overflowY: 'auto'});
        Object.defineProperties(env.parent, {offsetWidth: {value: 300}, offsetHeight: {value: 100}, clientWidth: {value: 290}, clientHeight: {value: 90}, clientLeft: {value: 5}, clientTop: {value: 5}});
        env.parent.getBoundingClientRect = () => ({left: 50, top: 70, right: 350, bottom: 170, width: 300, height: 100}) as DOMRect;
        env.hover(); env.click(); await flush();
        const overlay = env.bitmap()!.parentElement!;
        expect(overlay.style.clipPath).toBe('inset(35px 75px 75px 35px)');
        env.parentStyle.opacity = '0'; env.scroll(); env.runFrames(); expect(overlay.style.display).toBe('none');
        env.parentStyle.opacity = '1'; env.click(); const pending = deferred<typeof result>(); client.translate.mockReturnValueOnce(pending.promise); settings.useCache = false;
        env.click(); await flush(); env.image.remove(); env.notify('', 'childList');
        expect(client.translate.mock.calls.at(-1)![3].signal.aborted).toBe(true);
        expect(env.resizeObservers[0].disconnect).toHaveBeenCalledOnce();
        unmountImageTranslator(); pending.resolve(result); await flush();
        expect(env.image.ownerDocument.getElementById('fluent-read-image-translation-root')).toBeNull();
        expect(env.observers[0].disconnect).toHaveBeenCalledOnce();
        expect(env.windowObject.removeEventListener).toHaveBeenCalledTimes(4);
    });
});

describe('图片入口独立开关与右键身份', () => {
    it('X inert 图片上对应的透明链接显示悬浮入口，翻译、弹窗遮挡和恢复后仍保留宿主链接', async () => {
        const env = setup();
        const inert = document.createElement('div'); inert.setAttribute('inert', '');
        const link = document.createElement('a'); link.setAttribute('href', 'https://x.com/a16z/status/2107176509928878490/photo/1');
        env.parent.append(inert); inert.append(link); link.append(env.image);
        const cover = document.createElement('a'); cover.setAttribute('href', link.getAttribute('href')!);
        cover.setAttribute('aria-label', '查看媒体'); cover.getBoundingClientRect = env.image.getBoundingClientRect;
        env.parent.append(cover);
        env.extraStyles.set(cover, {position: 'absolute', opacity: '1', backgroundImage: 'none', backgroundColor: 'rgba(0, 0, 0, 0)'});
        const hostMarkup = env.parent.innerHTML;
        Object.assign(document, {elementsFromPoint: () => [cover, env.parent]});
        env.dispatch(cover, 'pointermove', true, {clientX: 100, clientY: 100}); env.runFrames(); vi.advanceTimersByTime(600);
        const overlay = env.button().closest<HTMLElement>('.fluent-read-image-translation-overlay')!;
        expect(overlay.style.display).toBe('block');
        env.click(); await flush(); const bitmap = env.bitmap();
        expect(bitmap).toBeTruthy(); expect(overlay.style.display).toBe('block');
        const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); document.body.append(dialog);
        Object.assign(document, {elementsFromPoint: () => [dialog, cover, env.parent]}); env.scroll(); env.runFrames();
        expect(overlay.style.display).toBe('none'); expect(env.image.style.opacity).not.toBe('0');
        dialog.remove(); Object.assign(document, {elementsFromPoint: () => [cover, env.parent]}); env.scroll(); env.runFrames();
        expect(overlay.style.display).toBe('block'); expect(env.bitmap()).toBe(bitmap);
        env.click(); expect(env.bitmap()).toBeNull(); expect(env.parent.innerHTML).toBe(hostMarkup);
        env.click(); await flush(); expect(env.bitmap()).toBeTruthy(); expect(client.translate).toHaveBeenCalledOnce();
    });

    it.each([
        {name: '指针未覆盖图片', point: {clientX: 600, clientY: 300}, hidden: false},
        {name: '图片覆盖指针但不可见', point: {clientX: 100, clientY: 100}, hidden: true},
    ])('$name 时四层嵌套容器每张图片只读取一次几何与必要样式', ({point, hidden}) => {
        const env = setup();
        let scope: Element = env.parent;
        for (let depth = 0; depth < 3; depth++) {
            const wrapper = document.createElement('div');
            scope.parentNode!.insertBefore(wrapper, scope);
            wrapper.append(scope);
            scope = wrapper;
        }
        const imageRect = env.image.getBoundingClientRect;
        const rectReads = [vi.spyOn(env.image, 'getBoundingClientRect')];
        for (let index = 1; index < 64; index++) {
            const image = document.createElement('img') as HTMLImageElement;
            const readRect = vi.fn(imageRect);
            image.getBoundingClientRect = readRect;
            rectReads.push(readRect);
            env.parent.append(image);
            if (hidden) env.extraStyles.set(image, {visibility: 'hidden', display: 'block'});
        }
        if (hidden) env.imageStyle.visibility = 'hidden';
        const styleReads = vi.fn(globalThis.getComputedStyle);
        vi.stubGlobal('getComputedStyle', styleReads);
        env.dispatch(env.parent, 'pointermove', true, point); env.runFrames();
        expect(rectReads.reduce((total, read) => total + read.mock.calls.length, 0)).toBe(64);
        expect(styleReads).toHaveBeenCalledTimes(hidden ? 64 : 0);
        vi.advanceTimersByTime(600);
        expect(env.roots).toHaveLength(0);
    });

    it('命中缓存只属于一次检查，下一帧重新读取位置和显隐变化', () => {
        const env = setup();
        const wrapper = document.createElement('div');
        env.parent.parentNode!.insertBefore(wrapper, env.parent); wrapper.append(env.parent);
        const rectReads = vi.spyOn(env.image, 'getBoundingClientRect');
        env.dispatch(env.parent, 'pointermove', true, {clientX: 600, clientY: 100}); env.runFrames();
        expect(rectReads).toHaveBeenCalledOnce();
        env.dispatch(env.parent, 'pointermove', true, {clientX: 600, clientY: 100}); env.runFrames();
        expect(rectReads).toHaveBeenCalledTimes(2);
        env.setRect({left: 500, top: 40, width: 400, height: 200, right: 900, bottom: 240});
        env.imageStyle.visibility = 'hidden';
        env.dispatch(env.parent, 'pointermove', true, {clientX: 600, clientY: 100}); env.runFrames();
        expect(rectReads).toHaveBeenCalledTimes(3);
        env.imageStyle.visibility = 'visible';
        env.dispatch(env.parent, 'pointermove', true, {clientX: 600, clientY: 100}); env.runFrames();
        vi.advanceTimersByTime(600);
        expect(env.button()).toBeTruthy();
    });

    it('多图重叠时第二个命中立即停止几何和样式读取，保持不显示入口', () => {
        const env = setup();
        const imageRect = env.image.getBoundingClientRect;
        const rectReads = [vi.spyOn(env.image, 'getBoundingClientRect')];
        for (let index = 1; index < 64; index++) {
            const readRect = vi.fn(imageRect);
            addSecondHoverImage(env, readRect);
            rectReads.push(readRect);
        }
        const styleReads = vi.fn(globalThis.getComputedStyle);
        vi.stubGlobal('getComputedStyle', styleReads);
        env.dispatch(env.parent, 'pointermove', true, {clientX: 100, clientY: 100}); env.runFrames();
        expect(rectReads.reduce((total, read) => total + read.mock.calls.length, 0)).toBe(2);
        expect(styleReads).toHaveBeenCalledTimes(2);
        vi.advanceTimersByTime(600);
        expect(env.roots).toHaveLength(0);
    });

    it('同一目标下一帧新增重叠图片时取消入口，解除歧义后重新显示', () => {
        const env = setup();
        env.dispatch(env.parent, 'pointermove', true, {clientX: 100, clientY: 100}); env.runFrames();
        const overlapping = addSecondHoverImage(env, env.image.getBoundingClientRect);
        env.dispatch(env.parent, 'pointermove', true, {clientX: 100, clientY: 100}); env.runFrames();
        vi.advanceTimersByTime(600);
        expect(env.roots).toHaveLength(0);
        overlapping.remove();
        env.dispatch(env.parent, 'pointermove', true, {clientX: 100, clientY: 100}); env.runFrames();
        vi.advanceTimersByTime(600);
        expect(env.button()).toBeTruthy();
    });

    it('同一帧的指针事件合并扫描，跨相邻图片、pointerout 和卸载后重新定位', () => {
        const env = setup();
        env.dispatch(env.parent, 'pointermove', true, {clientX: 100, clientY: 100});
        env.dispatch(env.parent, 'pointermove', true, {clientX: 110, clientY: 110});
        expect(env.windowObject.requestAnimationFrame).toHaveBeenCalledOnce();
        expect(env.imageQuery).not.toHaveBeenCalled();
        env.runFrames();
        const firstScanCount = env.imageQuery.mock.calls.length;
        expect(firstScanCount).toBe(1);

        const adjacent = env.image.ownerDocument.createElement('img') as HTMLImageElement;
        adjacent.src = 'https://example.test/adjacent.png';
        Object.defineProperties(adjacent, {
            naturalWidth: {value: 400}, naturalHeight: {value: 200}, complete: {value: true},
            currentSrc: {get: () => adjacent.src}, offsetWidth: {value: 400}, offsetHeight: {value: 200},
        });
        adjacent.getBoundingClientRect = () => ({left: 500, top: 40, width: 400, height: 200, right: 900, bottom: 240}) as DOMRect;
        env.parent.append(adjacent);
        env.dispatch(env.parent, 'pointermove', true, {clientX: 600, clientY: 100});
        env.runFrames();
        expect(env.imageQuery).toHaveBeenCalledTimes(firstScanCount + 1);
        vi.advanceTimersByTime(600);
        expect(env.roots.at(-1)?.querySelector('.fluent-read-image-translation-button')).toBeTruthy();

        env.dispatch(env.parent, 'pointerout');
        env.dispatch(env.parent, 'pointermove', true, {clientX: 100, clientY: 100});
        env.runFrames();
        expect(env.imageQuery).toHaveBeenCalledTimes(firstScanCount + 2);

        const newTarget = env.image.ownerDocument.createElement('div');
        env.parent.append(newTarget);
        env.dispatch(newTarget, 'pointermove', true, {clientX: 100, clientY: 100});
        env.runFrames();
        expect(env.imageQuery).toHaveBeenCalledTimes(firstScanCount + 3);

        unmountImageTranslator();
        mountImageTranslator();
        env.dispatch(env.parent, 'pointermove', true, {clientX: 100, clientY: 100});
        env.runFrames();
        expect(env.imageQuery).toHaveBeenCalledTimes(firstScanCount + 4);
    });

    it('卸载或关闭悬浮入口会取消待处理的 pointermove 帧', () => {
        const env = setup();
        env.dispatch(env.parent, 'pointermove', true, {clientX: 100, clientY: 100});
        unmountImageTranslator();
        env.runFrames();
        expect(env.imageQuery).not.toHaveBeenCalled();

        mountImageTranslator();
        env.dispatch(env.parent, 'pointermove', true, {clientX: 100, clientY: 100});
        settings.imageTranslationHoverEnabled = false;
        configNotifications.forEach(notify => notify());
        env.runFrames();
        expect(env.imageQuery).not.toHaveBeenCalled();
    });

    it('覆盖层上的可信指针命中局部图片，移出后收起', () => {
        const env = setup();
        const cover = document.createElement('div'); env.parent.append(cover);
        env.dispatch(cover, 'pointermove', true, {clientX: 100, clientY: 100});
        env.runFrames();
        vi.advanceTimersByTime(600);
        expect(env.button()).toBeTruthy();
        env.dispatch(cover, 'pointerout'); vi.advanceTimersByTime(500);
        expect(env.roots.at(-1)?.querySelector('.fr-image-controls')).toBeNull();
    });
    it('只启用右键时悬浮不创建入口，右键支持翻译、恢复和缓存重显', async () => {
        const env = setup(); settings.imageTranslationHoverEnabled = false;
        env.hover(); expect(env.roots).toHaveLength(0);
        env.dispatch(env.image, 'contextmenu');
        expect(toggleContextMenuImage(env.image.src)).toBe(true); await flush();
        expect(env.bitmap()).toBeTruthy();
        env.dispatch(env.image, 'contextmenu'); toggleContextMenuImage(env.image.src);
        expect(env.bitmap()).toBeNull();
        env.dispatch(env.image, 'contextmenu'); toggleContextMenuImage(env.image.src); await flush();
        expect(env.bitmap()).toBeTruthy(); expect(client.translate).toHaveBeenCalledTimes(1);
    });
    it('关闭右键不影响悬浮，拒绝合成右键、换图和不匹配 URL', async () => {
        const env = setup(); settings.imageTranslationContextMenuEnabled = false;
        env.hover(); expect(env.button()).toBeTruthy();
        env.dispatch(env.image, 'contextmenu'); expect(toggleContextMenuImage()).toBe(false);
        settings.imageTranslationContextMenuEnabled = true;
        env.dispatch(env.image, 'contextmenu', false); expect(toggleContextMenuImage()).toBe(false);
        env.dispatch(env.image, 'contextmenu'); expect(toggleContextMenuImage('https://wrong.test')).toBe(false);
        env.dispatch(env.image, 'contextmenu'); env.image.src += '#new'; expect(toggleContextMenuImage()).toBe(false);
        expect(client.translate).not.toHaveBeenCalled();
    });
    it('关闭悬浮开关立即撤下空闲入口', async () => {
        const env = setup(); env.hover(); settings.imageTranslationHoverEnabled = false; await flush();
        expect(env.roots.at(-1)?.querySelector('.fr-image-controls')).toBeNull();
    });
});

it('悬浮不穿透按钮或弹窗，不在同一区域多图时猜测目标；移除右键目标后拒绝执行', () => {
    const env = setup();
    const button = document.createElement('button'); env.parent.append(button);
    env.dispatch(button, 'pointerover', true, {clientX: 100, clientY: 100}); expect(env.roots).toHaveLength(0);
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); env.parent.append(dialog);
    env.dispatch(dialog, 'pointermove', true, {clientX: 100, clientY: 100}); env.runFrames(); expect(env.roots).toHaveLength(0);
    const duplicate = document.createElement('img'); duplicate.getBoundingClientRect = env.image.getBoundingClientRect; env.parent.append(duplicate);
    const cover = document.createElement('div'); env.parent.append(cover);
    env.dispatch(cover, 'pointerover', true, {clientX: 100, clientY: 100}); expect(env.roots).toHaveLength(0);
    env.dispatch(env.image, 'contextmenu'); env.image.remove(); expect(toggleContextMenuImage()).toBe(false);
});

describe('X 透明 img 与可见背景层的图片翻译', () => {
    it('登录后的 X 由透明原 img 命中鼠标时，悬浮、翻译、遮挡恢复和再次翻译都保留背景显示权', async () => {
        const env = setup(); const background = env.addBackground();
        const original = env.parent.innerHTML;
        Object.assign(document, {elementsFromPoint: () => [env.image, background, env.parent]});
        env.hover();
        const overlay = env.button().closest<HTMLElement>('.fluent-read-image-translation-overlay')!;
        expect(overlay.style.display).toBe('block');
        env.click(); await flush(); const bitmap = env.bitmap();
        expect(bitmap).toBeTruthy(); expect(overlay.style.display).toBe('block');
        env.scroll(); env.runFrames(); expect(overlay.style.display).toBe('block');
        const dialog = document.createElement('div'); document.body.append(dialog);
        Object.assign(document, {elementsFromPoint: () => [dialog, env.image, background]});
        env.scroll(); env.runFrames(); expect(overlay.style.display).toBe('none');
        expect(background.style.opacity).not.toBe('0');
        dialog.remove(); Object.assign(document, {elementsFromPoint: () => [env.image, background]});
        env.scroll(); env.runFrames(); expect(overlay.style.display).toBe('block');
        expect(env.bitmap()).toBe(bitmap); expect(background.style.opacity).toBe('0');
        env.click(); expect(env.bitmap()).toBeNull(); expect(env.parent.innerHTML).toBe(original);
        env.dispatch(env.image, 'pointerout'); vi.advanceTimersByTime(600);
        env.hover(); expect(env.button().closest<HTMLElement>('.fluent-read-image-translation-overlay')!.style.display).toBe('block');
        env.click(); await flush(); expect(env.bitmap()).toBeTruthy(); expect(client.translate).toHaveBeenCalledOnce();
    });
    it('实际背景层承载入口、译图与还原，透明原 img 保持不变', async () => {
        const env = setup(); const background = env.addBackground(); const original = background.getAttribute('style');
        env.dispatch(background, 'pointerover', true, {clientX: 100, clientY: 100});
        vi.advanceTimersByTime(600);
        expect((env.button().closest('.fluent-read-image-translation-overlay') as HTMLElement).style.display).toBe('block');
        env.click(); await flush();
        const bitmap = env.bitmap() as HTMLImageElement;
        expect(bitmap.parentElement!.style.display).toBe('block'); expect(bitmap.style.opacity).toBe('1');
        expect(bitmap.style.objectFit).toBe('cover'); expect(bitmap.style.objectPosition).toBe('right bottom');
        expect(background.style.opacity).toBe('0'); expect(env.image.style.opacity).toBeUndefined();
        env.click(); expect(env.bitmap()).toBeNull(); expect(background.getAttribute('style')).toBe(original);
        env.click(); await flush(); expect(env.bitmap()).toBeTruthy(); expect(client.translate).toHaveBeenCalledTimes(1);
    });
    it('宿主独立换背景后撤下旧译图，不覆盖宿主的新背景或透明度', async () => {
        const env = setup(); const background = env.addBackground(); env.hover(); env.click(); await flush();
        background.style.backgroundImage = 'url("https://example.test/new.png")'; background.style.opacity = '0.8';
        env.notify('style'); env.runFrames();
        expect(env.bitmap()).toBeNull(); expect(background.style.opacity).toBe('0.8');
        expect(background.style.backgroundImage).toContain('new.png');
    });
    it('背景承载节点被替换后，下一帧前直接重新翻译使用新的承载节点', async () => {
        const env = setup(); const background = env.addBackground(); env.hover(); env.click(); await flush();
        env.image.src = 'https://example.test/replaced.png';
        background.remove();
        const replacement = env.addBackground();
        env.notify('src');
        env.click(); await flush();
        expect(env.bitmap()).toBeTruthy();
        expect(client.translate).toHaveBeenCalledTimes(2);
        expect(env.resizeObservers[0].unobserve).toHaveBeenCalledWith(background);
        expect(env.resizeObservers[0].observe).toHaveBeenCalledWith(replacement);
    });
    it('后台等待期间换背景，旧任务不得写入译图', async () => {
        const env = setup(); const background = env.addBackground(); const request = deferred<typeof result>(); client.translate.mockReturnValue(request.promise);
        env.hover(); env.click(); await flush(); background.style.backgroundImage = 'url("https://example.test/replaced.png")';
        request.resolve(result); await flush(); expect(env.bitmap()).toBeNull(); expect(background.style.opacity).toBeUndefined();
    });
    it('仅右键且缺模型时留下可见准备提示，下载完成继续翻译', async () => {
        const env = setup(); const background = env.addBackground(); settings.imageTranslationHoverEnabled = false;
        client.translate.mockRejectedValueOnce(new Error('图片文字识别需要先下载简体中文、繁体中文、英语语言包'));
        env.dispatch(background, 'contextmenu', true, {clientX: 100, clientY: 100}); expect(toggleContextMenuImage(env.image.src)).toBe(true);
        await flush(); env.dispatch(background, 'pointerout'); vi.advanceTimersByTime(1000);
        expect((env.roots[0].querySelector('.fr-image-feedback') as HTMLElement).hidden).toBe(false);
        expect(env.button().textContent).toBe('关闭');
        const download = Array.from(env.roots[0].querySelectorAll('button')).find(b => b.textContent === '下载语言包并翻译')!;
        env.dispatch(download, 'click'); await flush(); expect(client.prepare).toHaveBeenCalledOnce(); expect(env.bitmap()).toBeTruthy();
    });
});


it('同图停留 600ms 才出现入口，移动不重置等待，离开和卸载取消等待', () => {
    const env = setup();
    env.dispatch(env.image, 'pointerover');
    vi.advanceTimersByTime(300);
    env.dispatch(env.image, 'pointermove'); env.runFrames();
    vi.advanceTimersByTime(299);
    expect(env.roots).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(env.button()).toBeTruthy();
    env.dispatch(env.image, 'pointerout'); vi.advanceTimersByTime(200);
    env.dispatch(env.image, 'pointerover'); vi.advanceTimersByTime(300);
    env.dispatch(env.image, 'pointerout'); vi.advanceTimersByTime(600);
    expect(env.roots.at(-1)?.querySelector('.fr-image-controls')).toBeNull();
    env.dispatch(env.image, 'pointerover'); unmountImageTranslator(); vi.advanceTimersByTime(600);
    expect(document.getElementById('fluent-read-image-translation-root')).toBeNull();
    expect(client.translate).not.toHaveBeenCalled();
});

it('已有译图时无关 DOM 更新不取消另一张仍在指针下的图片入口', async () => {
    const env = setup();
    env.hover(); env.click(); await flush();
    const second = addSecondHoverImage(env, () => ({left: 500, top: 40, right: 900, bottom: 240, width: 400, height: 200}) as DOMRect);
    env.dispatch(second, 'pointerover', true, {clientX: 600, clientY: 100});
    vi.advanceTimersByTime(300);
    const unrelated = env.image.ownerDocument.createElement('span');
    env.observers[0].callback([{type: 'childList', target: env.parent, addedNodes: [unrelated], removedNodes: []} as unknown as MutationRecord], {} as MutationObserver);
    vi.advanceTimersByTime(300);
    expect(env.roots.at(-1)?.querySelectorAll('.fr-image-controls')).toHaveLength(2);
});

it('DOM 更新使待显示的图片移出指针或变成头像时不显示入口', async () => {
    const env = setup();
    env.hover(); env.click(); await flush();
    let rect = {left: 500, top: 40, right: 900, bottom: 240, width: 400, height: 200} as DOMRect;
    const second = addSecondHoverImage(env, () => rect);
    env.dispatch(second, 'pointerover', true, {clientX: 600, clientY: 100});
    rect = {left: 100, top: 300, right: 500, bottom: 500, width: 400, height: 200} as DOMRect;
    env.observers[0].callback([{type: 'childList', target: env.parent, addedNodes: [], removedNodes: []} as unknown as MutationRecord], {} as MutationObserver);
    vi.advanceTimersByTime(600);
    expect(env.roots.at(-1)?.querySelectorAll('.fr-image-controls')).toHaveLength(1);

    rect = {left: 500, top: 40, right: 900, bottom: 240, width: 400, height: 200} as DOMRect;
    env.dispatch(second, 'pointerover', true, {clientX: 600, clientY: 100});
    second.className = 'avatar';
    env.observers[0].callback([{type: 'attributes', attributeName: 'class', target: second} as unknown as MutationRecord], {} as MutationObserver);
    vi.advanceTimersByTime(600);
    expect(env.roots.at(-1)?.querySelectorAll('.fr-image-controls')).toHaveLength(1);
});

it('等待期间指针在图片内移动后以最新位置判断入口', async () => {
    const env = setup();
    env.hover(); env.click(); await flush();
    let rect = {left: 500, top: 40, right: 900, bottom: 240, width: 400, height: 200} as DOMRect;
    const second = addSecondHoverImage(env, () => rect);
    env.dispatch(second, 'pointerover', true, {clientX: 600, clientY: 100});
    env.dispatch(second, 'pointermove', true, {clientX: 800, clientY: 100});
    env.runFrames();
    rect = {left: 700, top: 40, right: 1100, bottom: 240, width: 400, height: 200} as DOMRect;
    vi.advanceTimersByTime(600);
    expect(env.roots.at(-1)?.querySelectorAll('.fr-image-controls')).toHaveLength(2);
});


it.each(['source', 'remove', 'disable', 'scroll'])('等待期间图片或设置变化不会冒出入口：%s', async change => {
    const env = setup();
    env.dispatch(env.image, 'pointerover'); vi.advanceTimersByTime(300);
    if (change === 'source') env.image.src += '#changed';
    if (change === 'remove') env.image.remove();
    if (change === 'scroll') env.scroll();
    if (change === 'disable') { settings.imageTranslationHoverEnabled = false; await flush(); }
    vi.advanceTimersByTime(600);
    expect(env.roots).toHaveLength(0);
    expect(client.translate).not.toHaveBeenCalled();
});


describe('图片悬浮入口过滤', () => {
    it('使用文档基地址解析尚无 currentSrc 的相对图标路径', () => {
        const env = setup();
        Object.defineProperty(document, 'baseURI', {value: 'https://example.test/assets/'});
        Object.defineProperty(env.image, 'currentSrc', {value: ''});
        env.image.src = 'icons/check.png'; env.hover();
        expect(env.roots).toHaveLength(0);
    });
    it.each([[96, 96], [119, 120], [179, 80], [600, 39], [79, 600], [0, 200]])('显示为 %s × %s 的小图不分配计时器或观察器', (width, height) => {
        const env = setup();
        env.setRect({left: 20, top: 40, width, height, right: 20 + width, bottom: 40 + height});
        env.dispatch(env.image, 'pointerover');
        expect(vi.getTimerCount()).toBe(0);
        expect(env.roots).toHaveLength(0); expect(env.observers).toHaveLength(0);
    });
    it.each([[120, 120], [180, 80], [80, 180], [400, 200]])('显示为 %s × %s 的正文图片仍可进入', (width, height) => {
        const env = setup();
        env.setRect({left: 20, top: 40, width, height, right: 20 + width, bottom: 40 + height});
        env.hover(); expect(env.button()).toBeTruthy();
    });
    it('CSS 放大的小图仍过滤，尚未加载的正文图不误当零尺寸图', () => {
        const env = setup();
        Object.assign(env.image, {naturalWidth: 64, naturalHeight: 64});
        env.hover(); expect(env.roots).toHaveLength(0);
        Object.assign(env.image, {naturalWidth: 0, naturalHeight: 0});
        env.hover(); expect(env.button()).toBeTruthy();
    });
    it.each([
        ['class', 'avatar avatar-user'], ['class', 'UserAvatar-root'], ['class', 'profileImage'],
        ['id', 'site-logo'], ['data-testid', 'UserAvatar-123'], ['itemprop', 'logo'],
        ['class', 'emoji'], ['class', 'icon-large'], ['class', 'badge'],
        ['alt', '头像'], ['alt', 'Profile picture'], ['aria-label', 'Logo'],
        ['aria-hidden', 'true'], ['role', 'presentation'], ['role', 'none'],
    ])('过滤图片的 %s=%s 标记', (attribute, value) => {
        const env = setup(); env.image.setAttribute(attribute, value);
        env.hover(); expect(env.roots).toHaveLength(0); expect(client.translate).not.toHaveBeenCalled();
    });
    it.each(['https://avatars.githubusercontent.com/u/123', 'https://www.gravatar.com/avatar/hash',
        'https://pbs.twimg.com/profile_images/123/photo.jpg', 'https://example.test/assets/icons/check.svg',
        'https://example.test/emoji/smile.png', 'https://example.test/logo.png'])('过滤明确资源地址 %s', source => {
        const env = setup(); env.image.src = source;
        env.hover(); expect(env.roots).toHaveLength(0);
    });
    it.each(['https://example.test/iconography.png?avatar=true', 'https://example.test/avatar-guide.png', 'http://[invalid'])('不按一般描述或查询参数误过滤 %s', source => {
        const env = setup(); env.image.src = source;
        env.image.className = 'iconography'; env.image.alt = 'How to change an avatar';
        env.imageStyle.borderRadius = '50%';
        env.hover(); expect(env.button()).toBeTruthy();
    });
    it.each(['avatar', 'UserAvatar', 'profile-photo'])('近邻 %s 容器内的覆盖层不能绕过过滤', className => {
        const env = setup(); env.parent.className = className;
        const cover = document.createElement('span'); env.parent.append(cover);
        env.dispatch(cover, 'pointermove', true, {clientX: 100, clientY: 100}); env.runFrames();
        vi.advanceTimersByTime(600); expect(env.roots).toHaveLength(0);
    });
    it('不使用 body 的宽泛标记过滤正文；按钮内图片不自动提示', () => {
        const env = setup(); document.body.className = 'avatar';
        env.hover(); expect(env.button()).toBeTruthy();
        env.dispatch(env.image, 'pointerout'); vi.advanceTimersByTime(500);
        const button = document.createElement('button'); env.parent.append(button); button.append(env.image);
        env.hover(); expect(env.roots.at(-1)?.querySelector('.fr-image-controls')).toBeNull();
    });
    it.each(['size', 'marker', 'intrinsic'])('600ms 等待中改变 %s 后不显示入口', mode => {
        const env = setup(); env.dispatch(env.image, 'pointerover');
        vi.advanceTimersByTime(300);
        if (mode === 'size') env.setRect({left: 20, top: 40, width: 64, height: 64, right: 84, bottom: 104});
        if (mode === 'marker') env.image.className = 'avatar';
        if (mode === 'intrinsic') {Object.assign(env.image, {naturalWidth: 32, naturalHeight: 32});}
        vi.advanceTimersByTime(300); expect(env.roots).toHaveLength(0);
    });
    it('已显示的空闲入口变为头像后撤下并释放观察器，去掉标记后可重入', () => {
        const env = setup(); env.hover(); env.image.className = 'avatar'; env.notify('class'); env.runFrames();
        expect(env.roots[0].querySelector('.fr-image-controls')).toBeNull();
        expect(env.observers[0].disconnect).toHaveBeenCalled();
        env.image.className = ''; env.hover(); expect(env.button()).toBeTruthy();
    });
    it('从正文图移动到图标取消旧等待', () => {
        const env = setup(); env.dispatch(env.image, 'pointerover');
        const icon = document.createElement('img'); icon.className = 'icon';
        icon.getBoundingClientRect = env.image.getBoundingClientRect; env.parent.append(icon);
        env.dispatch(icon, 'pointerover'); vi.advanceTimersByTime(600);
        expect(env.roots).toHaveLength(0);
    });
    it('头像可通过可信右键主动翻译、恢复、再翻译', async () => {
        const env = setup(); env.image.className = 'avatar'; env.hover(); expect(env.roots).toHaveLength(0);
        env.dispatch(env.image, 'contextmenu'); expect(toggleContextMenuImage(env.image.src)).toBe(true); await flush();
        expect(env.bitmap()).toBeTruthy();
        env.dispatch(env.image, 'contextmenu'); expect(toggleContextMenuImage()).toBe(true);
        expect(env.bitmap()).toBeNull();
        env.dispatch(env.image, 'contextmenu'); expect(toggleContextMenuImage()).toBe(true); await flush();
        expect(env.bitmap()).toBeTruthy(); expect(client.translate).toHaveBeenCalledTimes(1);
    });
    it('翻译期间新增头像标记不撤下进度或丢失恢复入口', async () => {
        const env = setup(); const pending = deferred<typeof result>(); client.translate.mockReturnValue(pending.promise);
        env.hover(); env.click(); await flush();
        env.image.className = 'avatar'; env.notify('class'); env.runFrames();
        expect(env.button().dataset.phase).toBe('loading');
        env.dispatch(env.image, 'pointermove'); env.runFrames();
        pending.resolve(result); await flush(); expect(env.bitmap()).toBeTruthy();
        env.click(); expect(env.bitmap()).toBeNull(); expect(env.button()).toBeTruthy();
    });
});

describe('视频预览不自动显示图片翻译', () => {
    it.each(['videoPlayer', 'videoComponent', 'video-poster', 'video-thumbnail', 'video-preview', 'video-cover', 'movie_player', 'ytp-cued-thumbnail-overlay'])('没有 video 元素时识别 %s 容器', marker => {
        const env = setup(); env.parent.setAttribute('data-testid', marker);
        env.hover(); expect(env.roots).toHaveLength(0);
    });
    it.each(['ytd-thumbnail', 'yt-thumbnail-view-model'])('识别 %s 中的视频缩略图', tag => {
        const env = setup(); const wrapper = document.createElement(tag); env.parent.append(wrapper); wrapper.append(env.image);
        env.hover(); expect(env.roots).toHaveLength(0);
    });
    it.each([
        'https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img/cover.jpg',
        'https://pbs.twimg.com/amplify_video_thumb/123/img/cover.jpg',
        'https://pbs.twimg.com/tweet_video_thumb/123.jpg',
        'https://i.ytimg.com/vi/123/hqdefault.jpg',
        'https://i.ytimg.com/vi_webp/123/maxresdefault.webp',
    ])('尚无播放器时按封面来源排除 %s', source => {
        const env = setup(); env.image.src = source; env.hover(); expect(env.roots).toHaveLength(0);
    });
    it.each([
        ['https://x.com/user/status/123/video/1', false],
        ['https://twitter.com/user/status/123/video/2', false],
        ['https://www.youtube.com/watch?v=123', false],
        ['https://www.youtube.com/shorts/123', false],
        ['https://youtu.be/123', false],
        ['https://x.com/user/status/123/photo/1', true],
        ['https://www.youtube.com/@user', true],
        ['https://youtu.be/', true],
        ['https://example.test/watch?v=123', true],
        ['http://[invalid', true],
        ['', true],
    ])('视频链接 %s 的入口预期为 %s', (href, expected) => {
        const env = setup(); const anchor = document.createElement('a'); anchor.setAttribute('href', href);
        env.parent.append(anchor); anchor.append(env.image);
        env.hover(); expect(env.roots.length > 0).toBe(expected);
    });
    it('未标记播放器内重叠的视频排除封面，但旁边的视频不影响配图', () => {
        const env = setup(); const video = document.createElement('video'); env.parent.append(video);
        video.getBoundingClientRect = env.image.getBoundingClientRect;
        env.hover(); expect(env.roots).toHaveLength(0);
        video.getBoundingClientRect = () => ({left: 500, top: 40, right: 900, bottom: 240, width: 400, height: 200}) as DOMRect;
        env.hover(); expect(env.button()).toBeTruthy();
    });
    it('帖子中相邻视频不影响图片，并且普通配图不按 URL 的查询参数误判', () => {
        const env = setup();
        const article = document.createElement('article'); document.body.append(article); article.append(env.parent);
        const player = document.createElement('div'); player.setAttribute('data-testid', 'videoPlayer'); article.append(player);
        player.append(document.createElement('video'));
        env.image.src = 'https://pbs.twimg.com/media/photo.jpg?label=ext_tw_video_thumb';
        env.hover(); expect(env.button()).toBeTruthy();
    });
    it('深层视频组件在播放器初始化前排除封面', () => {
        const env = setup(); env.parent.setAttribute('data-testid', 'videoPlayer');
        let parent: Element = env.parent;
        for (let index = 0; index < 3; index++) {const nested = document.createElement('div'); parent.append(nested); parent = nested;}
        parent.append(env.image); env.hover(); expect(env.roots).toHaveLength(0);
    });
    it('远层普通容器不导致扫描整页，正常图片可以显示', () => {
        const env = setup(); let parent: Element = env.parent;
        for (let index = 0; index < 6; index++) {const nested = document.createElement('div'); parent.append(nested); parent = nested;}
        parent.append(env.image); env.hover(); expect(env.button()).toBeTruthy();
    });
    it('播放器在等待中或提示显示后接管图片时撤下自动入口', () => {
        const env = setup(); env.dispatch(env.image, 'pointerover');
        env.parent.setAttribute('data-testid', 'videoPlayer'); vi.advanceTimersByTime(600);
        expect(env.roots).toHaveLength(0);
        env.parent.removeAttribute('data-testid'); env.hover(); expect(env.button()).toBeTruthy();
        const video = document.createElement('video'); video.getBoundingClientRect = env.image.getBoundingClientRect; env.parent.append(video);
        env.notify('', 'childList'); env.runFrames();
        expect(env.roots[0].querySelector('.fr-image-controls')).toBeNull();
        video.remove(); env.hover(); expect(env.button()).toBeTruthy();
    });
    it('视频预览覆盖层不能借局部图片发现重新显示入口', () => {
        const env = setup(); env.parent.setAttribute('data-testid', 'videoPlayer');
        const cover = document.createElement('span'); env.parent.append(cover);
        env.dispatch(cover, 'pointermove', true, {clientX: 100, clientY: 100}); env.runFrames(); vi.advanceTimersByTime(600);
        expect(env.roots).toHaveLength(0);
    });
});

 describe('漫画模式复用单图翻译与显示权', () => {
    function readerPage() {
        const env = setup();
        vi.stubGlobal('Element', env.image.ownerDocument.defaultView!.Element);
        Object.assign(env.windowObject, {location: {href: 'https://mangaplus.shueisha.co.jp/viewer/1024050'}});
        env.image.className = 'zao-image'; env.parent.className = 'zao-image-container';
        return env;
    }
    function cacheChapter(env: ReturnType<typeof readerPage>, count: number) {
        let current = 0, nearby = -1;
        const rect = (index: number) => ({left:20,right:420,top:current===index?40:nearby===index?900:5000,
            bottom:current===index?240:nearby===index?1100:5200,width:400,height:200}) as DOMRect;
        env.image.getBoundingClientRect=()=>rect(0);
        const pages=[env.image];
        for(let i=1;i<count;i++){const image=addSecondHoverImage(env,()=>rect(i));image.src+=`?${i}`;image.className='zao-image';pages.push(image);}
        const scroll=()=>{for(const [name,callback] of env.windowObject.addEventListener.mock.calls)if(name==='scroll')(callback as EventListener)(new Event('scroll'));env.runFrames();};
        const arrive = async (index: number, near = -1) => {current=index;nearby=near;scroll();await flush();env.runFrames();await flush();};
        // visit 表示到达后停稳；同检查点返页与附近预合成仍使用 arrive/near，不推进阅读器的停留窗口。
        return {pages, arrive, visit:async(index:number,near=-1)=>{
            await arrive(index,near);vi.advanceTimersByTime(180);env.runFrames();await flush();
        }, near:(index:number)=>{nearby=index;scroll();}};
    }
    function canvasChapter() {
        const env = readerPage();
        // 该 DOM 夹具以微任务驱动编码；原生摘要需要宿主事件循环，故仅在此控制异步端口。
        // 仍对完整 BufferSource 求真实 SHA-256，并保留子视图范围及独立的 32 字节结果。
        vi.stubGlobal('crypto', {subtle: {digest: vi.fn(async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
            expect(algorithm).toBe('SHA-256');
            const bytes = ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : new Uint8Array(data);
            return Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer;
        })}});
        Object.assign(env.windowObject, {location: {href: 'https://manga.bilibili.com/mc123/456', origin: 'https://manga.bilibili.com'}});
        env.parent.innerHTML = '<div class="images-container"><div class="view-container"><div class="image-container"><div class="bullet-screen"><div class="bullet-container"></div></div></div></div></div>';
        const page = document.createElement('canvas'); page.width = 400; page.height = 200; page.getBoundingClientRect = env.image.getBoundingClientRect;
        env.parent.querySelector('.image-container')!.prepend(page);
        const interaction = env.parent.querySelector('.bullet-container')!;
        Object.assign(document, {elementFromPoint: () => interaction});
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({width: 10, height: 20, close: vi.fn()})));
        return {...env, page, interaction};
    }
    it('完整入口把画布准备、阶段进度、交互遮罩和缓存复用接到同一漫画会话', async () => {
        const env = canvasChapter(), statuses: MangaTranslationStatus[] = [];
        const stop = subscribeMangaTranslation(status => statuses.push(status));
        settings.from = 'ko'; settings.imageTranslationMangaDownloadConfirmed = true;
        const packet = {...result, image: '', mangaPatches: {width: 400, height: 200, patches: [{x: 0, y: 0, width: 10, height: 20, image: 'data:image/png;base64,AQID'}]}};
        client.prepare.mockImplementation(async (_source, _signal, progress) => {progress(20);});
        client.translate.mockImplementation(async (_image, _source, _title, options) => {options.onProgress('recognizing', 50); return packet;});
        expect(toggleMangaTranslation()).toBe(true); await flush(); env.runFrames(); await flush();
        expect(client.prepare).toHaveBeenCalledWith('ko', expect.any(AbortSignal), expect.any(Function));
        expect(client.translate).toHaveBeenCalledWith(expect.any(String), 'ko', 'Image fixture', expect.objectContaining({manga: true, timeoutMs: 300_000}));
        expect(statuses).toContainEqual(expect.objectContaining({stage: 'preparing', progress: 20}));
        expect(statuses).toContainEqual(expect.objectContaining({stage: 'recognizing', progress: 50}));
        const surface = env.roots.at(-1)!.querySelector('canvas')!;
        expect(surface.style.display).toBe('block'); expect(env.page.width).toBe(400);
        toggleMangaTranslation(); await flush(); expect(surface.style.display).toBe('none');
        toggleMangaTranslation(); await flush(); expect(surface.style.display).toBe('block'); expect(client.translate).toHaveBeenCalledOnce();
        Object.assign(document, {elementFromPoint: () => document.createElement('aside')});
        for (const [name, listener] of env.windowObject.addEventListener.mock.calls) if (name === 'scroll') (listener as EventListener)(new Event('scroll'));
        env.runFrames(); await flush();
        expect(surface.style.display).toBe('none');
        stop(); unmountImageTranslator(); expect(surface).toMatchObject({width: 0, height: 0});
    });
    it('漫画画布在语言包准备期间暂停后拒绝迟到进度和翻译启动', async () => {
        const env = canvasChapter(), prepared = deferred<void>(), statuses: MangaTranslationStatus[] = [];
        const stop = subscribeMangaTranslation(status => statuses.push(status));
        settings.from = 'ru'; settings.imageTranslationMangaDownloadConfirmed = true;
        client.prepare.mockReturnValue(prepared.promise);
        toggleMangaTranslation(); await flush(); expect(client.prepare).toHaveBeenCalledOnce();
        const signal = client.prepare.mock.calls[0][1] as AbortSignal, progress = client.prepare.mock.calls[0][2];
        toggleMangaTranslation(); await flush(); const count = statuses.length;
        expect(signal.aborted).toBe(true); progress(99); prepared.resolve(); await flush();
        expect(statuses.slice(count).every(status => !status.active && status.progress !== 99)).toBe(true);
        expect(client.translate).not.toHaveBeenCalled();
        expect(env.page).toMatchObject({width: 400, height: 200}); stop();
    });
    it('完整入口探测同源背景漫画并在快照识别后复用页面缓存', async () => {
        const env = readerPage();
        Object.assign(env.windowObject, {location: {href: 'https://comic.pixiv.net/viewer/stories/123', origin: 'https://comic.pixiv.net'}});
        vi.stubGlobal('DOMRect', class {constructor(public x: number, public y: number, public width: number, public height: number) {} get left() {return this.x;} get top() {return this.y;} get right() {return this.x + this.width;} get bottom() {return this.y + this.height;}});
        env.image.remove(); const page = document.createElement('div'); page.id = 'page-1'; page.style.backgroundImage = 'url("blob:https://comic.pixiv.net/fixture")'; page.getBoundingClientRect = env.image.getBoundingClientRect; env.parent.append(page);
        env.extraStyles.set(page, {display: 'block', visibility: 'visible', opacity: '1', backgroundImage: page.style.backgroundImage, backgroundSize: 'contain', backgroundRepeat: 'no-repeat', backgroundOrigin: 'padding-box', backgroundPosition: '50% 50%'});
        Object.assign(document, {elementFromPoint: () => page});
        client.translate.mockResolvedValue({...result, lines: []});
        // The first discovery starts the image probe; its ready callback schedules the actual reader entry.
        toggleMangaTranslation(); await flush(); env.runFrames(); await flush();
        expect(toggleMangaTranslation()).toBe(true); await flush(); env.runFrames(); await flush();
        expect(client.translate).toHaveBeenCalledWith(expect.any(String), 'auto', 'Image fixture', expect.objectContaining({manga: true}));
        toggleMangaTranslation(); await flush(); toggleMangaTranslation(); await flush(); expect(client.translate).toHaveBeenCalledOnce();
        expect(page.style.backgroundImage).toContain('blob:https://comic.pixiv.net/fixture');
        unmountImageTranslator(); expect(env.canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
    });
    it.each(['canvas','background','segment'] as const)('漫画 %s 失败复用紧凑恢复条，单页重试进入会话且暂停/卸载清理', async surface => {
        const env=surface==='canvas'?canvasChapter():readerPage(),statuses:MangaTranslationStatus[]=[];
        const stop=subscribeMangaTranslation(status=>statuses.push(status));settings.imageTranslationMangaPrefetchPages=0;
        vi.stubGlobal('DOMRect',class {constructor(public x:number,public y:number,public width:number,public height:number){}get left(){return this.x;}get top(){return this.y;}get right(){return this.x+this.width;}get bottom(){return this.y+this.height;}});
        if(surface==='background') {
            Object.assign(env.windowObject,{location:{href:'https://comic.pixiv.net/viewer/stories/123',origin:'https://comic.pixiv.net'}});
            env.image.remove();const page=document.createElement('div');page.id='page-1';page.style.backgroundImage='url("blob:https://comic.pixiv.net/recovery")';page.getBoundingClientRect=env.image.getBoundingClientRect;env.parent.append(page);
            env.extraStyles.set(page,{display:'block',visibility:'visible',opacity:'1',backgroundImage:page.style.backgroundImage,backgroundSize:'contain',backgroundRepeat:'no-repeat',backgroundOrigin:'padding-box',backgroundPosition:'50% 50%'});
            Object.assign(document,{elementFromPoint:()=>page});
            toggleMangaTranslation();await flush();env.runFrames();await flush();
        }
        if(surface==='segment') {
            Object.defineProperty(env.image,'naturalHeight',{value:6000});env.setRect({left:20,top:40,width:400,height:6000,right:420,bottom:6040});
            Object.assign(env.imageStyle,{paddingTop:'0px',paddingRight:'0px',paddingBottom:'0px',paddingLeft:'0px',borderTopWidth:'0px',borderRightWidth:'0px',borderBottomWidth:'0px',borderLeftWidth:'0px',objectFit:'fill'});
            Object.assign(document,{elementFromPoint:()=>env.image});
        }
        client.translate.mockRejectedValueOnce(createImageTranslationFailure('provider error detail',{errorCode:'language'}));
        expect(toggleMangaTranslation()).toBe(true);await flush();env.runFrames();await flush();
        const feedback=env.roots.at(-1)!.querySelector<HTMLElement>('.fr-image-feedback')!;
        expect(feedback.hidden).toBe(false);expect(feedback.querySelector('details')!.textContent).toContain('provider error detail');
        expect(statuses.at(-1)).toMatchObject({errors:1,pending:false});
        env.dispatch(feedback.querySelector('.fr-image-model-settings')!,'click');await flush();
        expect(client.settings).toHaveBeenLastCalledWith({type:'openOptionsPage',section:'settings-services',service:'localTranslation'});
        settings.uiLanguage='en-US';await flush();expect(feedback.querySelector('.fluent-read-image-translation-button')!.textContent).toBe('Retry');
        const pending=deferred<typeof result>();client.translate.mockReturnValueOnce(pending.promise);
        env.dispatch(feedback.querySelector('.fluent-read-image-translation-button')!,'click');await flush();
        expect(client.translate).toHaveBeenCalledTimes(2);expect(statuses.at(-1)).toMatchObject({pending:true,errors:0});expect(feedback.isConnected).toBe(false);
        pending.resolve({...result,lines:[]});await flush();env.runFrames();await flush();
        expect(statuses.at(-1)).toMatchObject({pending:false,errors:0,completed:1});
        toggleMangaTranslation();await flush();expect(env.roots.at(-1)!.querySelector('.fr-image-feedback')).toBeNull();
        const originalCanvas=surface==='canvas'?(env as ReturnType<typeof canvasChapter>).page:undefined;
        unmountImageTranslator();expect(env.canvases.filter(canvas=>canvas!==originalCanvas).every(canvas=>canvas.width===0 && canvas.height===0)).toBe(true);
        if(originalCanvas)expect(originalCanvas).toMatchObject({width:400,height:200});stop();
    });
    it.each([
        ['https://mangalib.me/ru/1--title/read/v22/c129?p=2','ru','<div data-reader-mode="vertical"><main data-reader-info-visible="true"><div><div data-page="2" data-target></div></div></main></div>'],
        ['https://mangahub.ru/read/123?page=2','ru','<reader-viewer><reader-scan class="reader-viewer-scan" data-target></reader-scan></reader-viewer>'],
        ['https://comic.naver.com/webtoon/detail?titleId=855297&no=1','ko','<div id="sectionContWide" data-target></div>'],
    ])('自动漫画路径 %s 在下载确认后使用 %s，缓存复用并尊重手动源语言', async (href,source,markup) => {
        const env=readerPage();Object.assign(env.windowObject,{location:{href}});env.parent.innerHTML=markup;
        env.parent.querySelector('[data-target]')!.appendChild(env.image);env.image.className='reader-viewer-img';env.image.id='content_image_0';
        settings.from='auto';settings.imageTranslationMangaDownloadConfirmed=true;settings.imageTranslationOcrEngine='paddle';
        toggleMangaTranslation();await flush();
        expect(client.prepare).toHaveBeenCalledWith(source,expect.any(AbortSignal),expect.any(Function));
        expect(client.translate).toHaveBeenCalledWith(expect.any(String),source,expect.any(String),expect.objectContaining({manga:true}));
        expect(settings.from).toBe('auto');expect(env.bitmap()).not.toBeNull();
        toggleMangaTranslation();await flush();expect(env.bitmap()).toBeNull();toggleMangaTranslation();await flush();
        expect(client.translate).toHaveBeenCalledOnce();expect(client.prepare).toHaveBeenCalledOnce();
        settings.from='en';await flush();env.runFrames();await flush();
        expect(client.translate.mock.calls.at(-1)?.[1]).toBe('en');expect(client.prepare).toHaveBeenCalledOnce();
    });
    it('已知俄语漫画页的普通图片翻译仍遵循全局自动源语言', async () => {
        const env=readerPage();Object.assign(env.windowObject,{location:{href:'https://mangalib.me/ru/1--title/read/v22/c129'}});
        env.hover();env.click();await flush();
        expect(client.translate).toHaveBeenCalledWith(expect.any(String),'auto',expect.any(String),expect.not.objectContaining({manga:true}));
    });
    it('活动的自动俄语漫画被用户规则接管后使用全局自动语言，不复用旧语言译图', async () => {
        const env=readerPage(),href='https://mangalib.me/ru/1--title/read/v22/c129';Object.assign(env.windowObject,{location:{href}});
        env.parent.innerHTML='<div data-reader-mode="vertical"><main data-reader-info-visible="true"><div><div data-page="1" data-target></div></div></main></div>';
        env.parent.querySelector('[data-target]')!.appendChild(env.image);settings.imageTranslationMangaDownloadConfirmed=true;
        toggleMangaTranslation();await flush();expect(client.translate.mock.calls.at(-1)?.[1]).toBe('ru');
        settings.imageTranslationMangaSites=[{hostname:'mangalib.me',pathPrefix:'/ru/1--title/read/v22/c129',selector:'.zao-image'}];
        await flush();env.runFrames();await flush();
        expect(client.translate).toHaveBeenCalledTimes(2);expect(client.translate.mock.calls.at(-1)?.[1]).toBe('auto');
        expect(settings.from).toBe('auto');expect(client.prepare).toHaveBeenCalledOnce();
    });
    it('自动韩语漫画的长图分段快照共用有效语言，原图尺寸保留', async () => {
        vi.stubGlobal('DOMRect',class {constructor(public x:number,public y:number,public width:number,public height:number){}get left(){return this.x;}get top(){return this.y;}get right(){return this.x+this.width;}get bottom(){return this.y+this.height;}});
        const env=readerPage();Object.assign(env.windowObject,{location:{href:'https://comic.naver.com/webtoon/detail?titleId=855297&no=1'}});
        env.parent.id='sectionContWide';env.image.id='content_image_0';Object.defineProperty(env.image,'naturalHeight',{value:6000});
        Object.assign(env.imageStyle,{paddingTop:'0px',paddingRight:'0px',paddingBottom:'0px',paddingLeft:'0px',borderTopWidth:'0px',borderRightWidth:'0px',borderBottomWidth:'0px',borderLeftWidth:'0px',objectFit:'fill'});
        env.setRect({left:20,top:40,width:400,height:6000,right:420,bottom:6040});
        settings.from='auto';settings.imageTranslationMangaDownloadConfirmed=true;settings.imageTranslationMangaPrefetchPages=0;
        client.translate.mockResolvedValue({...result,lines:[]});toggleMangaTranslation();await flush();
        expect(client.prepare).toHaveBeenCalledWith('ko',expect.any(AbortSignal),expect.any(Function));
        expect(client.translate).toHaveBeenCalledWith(expect.any(String),'ko',expect.any(String),expect.objectContaining({manga:true}));
        expect(settings.from).toBe('auto');expect(env.image.naturalHeight).toBe(6000);
        unmountImageTranslator();expect(env.image.style.opacity).not.toBe('0');
    });
    it.each(['ru', 'ko-KR'])('漫画 %s 已确认后准备语言包，暂停再开复用译图，单图引擎不影响准备', async source => {
        const env = readerPage();settings.from = source;settings.imageTranslationOcrEngine = 'paddle';settings.imageTranslationMangaDownloadConfirmed = true;
        toggleMangaTranslation();await flush();
        expect(client.prepare).toHaveBeenCalledWith(source, expect.any(AbortSignal), expect.any(Function));
        expect(client.prepare.mock.invocationCallOrder[0]).toBeLessThan(client.translate.mock.invocationCallOrder[0]);
        expect(client.translate).toHaveBeenCalledWith(expect.any(String), source, expect.any(String), expect.objectContaining({manga: true}));
        expect(env.bitmap()).not.toBeNull();toggleMangaTranslation();await flush();expect(env.bitmap()).toBeNull();
        toggleMangaTranslation();await flush();expect(env.bitmap()).not.toBeNull();
        expect(client.prepare).toHaveBeenCalledOnce();expect(client.translate).toHaveBeenCalledOnce();
    });
    it('漫画未确认下载时不自动准备俄语包，失败保留原图与重试能力', async () => {
        const env = readerPage();settings.from = 'ru';client.translate.mockRejectedValueOnce(new Error('请先下载语言包'));
        const listener = vi.fn(), stop = subscribeMangaTranslation(listener);
        toggleMangaTranslation();await flush();expect(client.prepare).not.toHaveBeenCalled();
        expect(env.bitmap()).toBeNull();expect(env.image.style.opacity).not.toBe('0');
        expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({errors: 1}));
        settings.imageTranslationMangaDownloadConfirmed = true;
        toggleMangaTranslation();await flush();toggleMangaTranslation();await flush();
        expect(client.prepare).toHaveBeenCalledWith('ru', expect.any(AbortSignal), expect.any(Function));expect(env.bitmap()).not.toBeNull();stop();
    });
    it.each(['pause', 'language', 'unmount'])('准备漫画语言包期间 %s 后不发起旧识别、不改原图', async action => {
        const env = readerPage();settings.from = 'ko';settings.imageTranslationMangaDownloadConfirmed = true;
        const wait = deferred<void>();client.prepare.mockReturnValueOnce(wait.promise);
        toggleMangaTranslation();await flush();expect(client.prepare).toHaveBeenCalledOnce();expect(client.translate).not.toHaveBeenCalled();
        const signal = client.prepare.mock.calls[0][1] as AbortSignal;
        if (action === 'pause') toggleMangaTranslation();
        if (action === 'language') settings.from = 'ru';
        if (action === 'unmount') unmountImageTranslator();
        await flush();wait.resolve();await flush();
        expect(client.translate).not.toHaveBeenCalled();expect(env.bitmap()).toBeNull();expect(env.image.style.opacity).not.toBe('0');
        if (action !== 'language') expect(signal.aborted).toBe(true);
    });
    it('漫画语言包准备失败后暂停再开可以重试，已确认状态不丢失', async () => {
        const env = readerPage();settings.from = 'ru';settings.imageTranslationMangaDownloadConfirmed = true;
        client.prepare.mockRejectedValueOnce(new Error('download failed'));
        toggleMangaTranslation();await flush();expect(client.translate).not.toHaveBeenCalled();expect(env.bitmap()).toBeNull();
        toggleMangaTranslation();await flush();toggleMangaTranslation();await flush();
        expect(client.prepare).toHaveBeenCalledTimes(2);expect(env.bitmap()).not.toBeNull();
    });

    it('漫画右键恢复只卸下显示层，缓存画布保留；来源失效时才释放旧画布', async () => {
        const env = readerPage(); settings.imageTranslationMangaPrefetchPages = 0;
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({width: 10, height: 20, close: vi.fn()})));
        client.translate.mockResolvedValue({...result, image: '', mangaPatches: {width: 400, height: 200, patches: [{x: 0, y: 0, width: 10, height: 20, image: 'data:image/png;base64,AQID'}]}});
        toggleMangaTranslation(); await flush(); const canvas = env.bitmap() as HTMLCanvasElement;
        env.dispatch(env.image, 'contextmenu'); expect(toggleContextMenuImage(env.image.src)).toBe(true);
        expect(canvas).toMatchObject({width: 400, height: 200}); expect(canvas.isConnected).toBe(false);
        env.dispatch(env.image, 'contextmenu'); expect(toggleContextMenuImage(env.image.src)).toBe(true); await flush();
        expect(env.bitmap()).toBe(canvas); expect(client.translate).toHaveBeenCalledOnce();
        env.image.src = 'https://example.test/new-page.png';
        // Both reader and overlay observers now watch style; deliver this source mutation
        // to the actual overlay observer, whose public filter also owns opacity/alt changes.
        const layout = env.observers.find(observer => observer.observe.mock.calls[0]?.[1]?.attributeFilter?.includes('alt'))!;
        layout.callback([{type: 'attributes', attributeName: 'src', target: env.image} as unknown as MutationRecord], {} as MutationObserver);
        expect(canvas).toMatchObject({width: 0, height: 0}); expect(env.image.style.opacity).not.toBe('0');
    });

    it.each([new Error('warm decode failed'), 'warm decode failed'])('附近预合成失败=%s不自动重试，返回页面仍可主动恢复', async failure => {
        const env = readerPage(); settings.imageTranslationMangaPrefetchPages = 0; settings.imageTranslationMangaCachePages = 2;
        const chapter = cacheChapter(env, 10), decode = vi.fn(async () => ({width: 10, height: 20, close: vi.fn()}));
        vi.stubGlobal('createImageBitmap', decode);
        client.translate.mockResolvedValue({...result, image: '', mangaPatches: {width: 400, height: 200, patches: [{x: 0, y: 0, width: 10, height: 20, image: 'data:image/png;base64,AQID'}]}});
        toggleMangaTranslation(); await flush(); await chapter.visit(3); await chapter.visit(6); await chapter.visit(9);
        decode.mockRejectedValueOnce(failure); const count = decode.mock.calls.length;
        await chapter.visit(9, 0); expect(decode).toHaveBeenCalledTimes(count + 1);
        for (let index = 0; index < 3; index++) {await chapter.visit(9, 0);}
        expect(decode).toHaveBeenCalledTimes(count + 1); expect(client.translate).toHaveBeenCalledTimes(4);
        await chapter.visit(0); expect(client.translate).toHaveBeenCalledTimes(5); expect(chapter.pages[0].style.opacity).toBe('0');
    });
    it('漫画状态订阅者抛错不打断卸载，原图和全部监听仍归还且能重新挂载', async () => {
        const env = readerPage(); toggleMangaTranslation(); await flush();
        expect(env.image.style.opacity).toBe('0');
        let broken = false;
        const stopBroken = subscribeMangaTranslation(() => {if (broken) throw new Error('observer failed');});
        const healthy = vi.fn(), stopHealthy = subscribeMangaTranslation(healthy);
        try {
            broken = true;
            expect(() => unmountImageTranslator()).not.toThrow();
            expect(env.image.style.opacity).not.toBe('0'); expect(env.bitmap()).toBeNull();
            expect(healthy).toHaveBeenLastCalledWith(expect.objectContaining({available: false, active: false}));
            expect(env.windowObject.removeEventListener).toHaveBeenCalled();
        } finally {
            broken = false; stopBroken(); stopHealthy();
            // 故障基线在卸载中途退出；允许此隔离用例归还残留资源后结束。
            mountImageTranslator(); unmountImageTranslator();
        }
        mountImageTranslator(); toggleMangaTranslation(); await flush();
        expect(env.image.style.opacity).toBe('0'); unmountImageTranslator();
        expect(env.image.style.opacity).not.toBe('0');
    });

    it('状态通知期间新订阅者只收到一次当前快照，不重复进入正在发送的通知', async () => {
        const env = readerPage(); const pending = deferred<typeof result>(); client.translate.mockReturnValueOnce(pending.promise);
        toggleMangaTranslation(); await flush(); const nested = vi.fn(); let stopNested: (() => void) | undefined;
        const stop = subscribeMangaTranslation(status => {
            if (status.stage === 'recognizing' && !stopNested) stopNested = subscribeMangaTranslation(nested);
        });
        try {
            client.translate.mock.calls[0][3].onProgress('recognizing', 0.42);
            expect(nested).toHaveBeenCalledOnce();
            expect(nested).toHaveBeenLastCalledWith(expect.objectContaining({stage: 'recognizing', progress: 0.42}));
        } finally {stop(); stopNested?.(); pending.resolve(result); await flush();}
        expect(env.bitmap()).not.toBeNull();
    });

    it('初始状态接收失败仍返回退订函数，不泄漏无法退订的订阅', () => {
        let broken = true, stop: (() => void) | undefined;
        const listener = () => {if (broken) throw new Error('initial observer failed');};
        try {
            expect(() => {stop = subscribeMangaTranslation(listener);}).not.toThrow();
            expect(stop).toBeTypeOf('function'); stop!();
        } finally {broken = false; (stop || subscribeMangaTranslation(listener))();}
    });

    it('发送期间退订尚未接收的监听器，不再向它交付当前状态', async () => {
        const env = readerPage(), pending = deferred<typeof result>(); client.translate.mockReturnValueOnce(pending.promise);
        toggleMangaTranslation(); await flush(); let stopNext!: () => void;
        const stopFirst = subscribeMangaTranslation(status => {if (status.stage === 'cleaning') stopNext();});
        const next = vi.fn(); stopNext = subscribeMangaTranslation(next); next.mockClear();
        try {
            client.translate.mock.calls[0][3].onProgress('cleaning', 0.5);
            expect(next).not.toHaveBeenCalled();
        } finally {stopFirst(); stopNext(); pending.resolve(result); await flush();}
        expect(env.bitmap()).not.toBeNull();
    });

    it('每个订阅获得独立状态，修改自身快照不改变其他订阅和漫画显示', async () => {
        const env = readerPage(), pending = deferred<typeof result>(); client.translate.mockReturnValueOnce(pending.promise);
        toggleMangaTranslation(); await flush();
        const stopMutator = subscribeMangaTranslation(status => {status.active = false; status.stage = 'preparing'; status.progress = -99;});
        const healthy = vi.fn(), stopHealthy = subscribeMangaTranslation(healthy);
        try {
            client.translate.mock.calls[0][3].onProgress('cleaning', 0.5);
            expect(healthy).toHaveBeenLastCalledWith(expect.objectContaining({active: true, stage: 'cleaning', progress: 0.5}));
        } finally {stopMutator(); stopHealthy(); pending.resolve(result); await flush();}
        expect(env.image.style.opacity).toBe('0');
    });
    it('漫画默认快速缓存可保留十二张正常页，第十三张才淘汰最早结果',async()=>{
        const env=readerPage();settings.imageTranslationMangaPrefetchPages=0;const chapter=cacheChapter(env,13);
        toggleMangaTranslation();await flush();
        for(let i=1;i<13;i++)await chapter.visit(i);
        expect(client.translate).toHaveBeenCalledTimes(13);await chapter.visit(1);expect(client.translate).toHaveBeenCalledTimes(13);
        await chapter.visit(0);expect(client.translate).toHaveBeenCalledTimes(14);
    });
    it('局部结果直接显示画布，越过快速缓存后重建只解码图块，不重做 OCR 或翻译',async()=>{
        const env=readerPage();settings.imageTranslationMangaPrefetchPages=0;settings.imageTranslationMangaCachePages=1;
        const chapter=cacheChapter(env,7),decode=vi.fn().mockImplementation(async()=>({width:10,height:20,close:vi.fn()}));vi.stubGlobal('createImageBitmap',decode);
        client.translate.mockResolvedValue({...result,image:'',mangaPatches:{width:400,height:200,patches:[{x:0,y:0,width:10,height:20,image:'data:image/png;base64,AQID'}]}});
        toggleMangaTranslation();await flush();expect(env.bitmap()?.tagName).toBe('CANVAS');expect(env.decoded).toHaveLength(0);
        await chapter.visit(3);await chapter.visit(6);expect(client.translate).toHaveBeenCalledTimes(3);
        const before=decode.mock.calls.length;await chapter.visit(0);expect(decode).toHaveBeenCalledTimes(before+1);expect(client.translate).toHaveBeenCalledTimes(3);
        expect(env.bitmap()?.tagName).toBe('CANVAS');expect(chapter.pages[0].style.opacity).toBe('0');
        unmountImageTranslator();expect(env.canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);
    });
    it('预译挤出快速缓存后预合成不能撤下当前页，另一页处理期间仍可对照原文',async()=>{
        const env=readerPage();settings.imageTranslationMangaPrefetchPages=0;settings.imageTranslationMangaCachePages=1;
        const chapter=cacheChapter(env,4),decode=vi.fn().mockImplementation(async()=>({width:10,height:20,close:vi.fn()}));vi.stubGlobal('createImageBitmap',decode);
        const translated={...result,image:'',mangaPatches:{width:400,height:200,patches:[{x:0,y:0,width:10,height:20,image:'data:image/png;base64,AQID'}]}};
        const next=deferred<typeof translated>(),third=deferred<typeof translated>();
        client.translate.mockResolvedValueOnce(translated).mockReturnValueOnce(next.promise).mockReturnValueOnce(third.promise);
        settings.imageTranslationMangaPrefetchPages=3;toggleMangaTranslation();await flush();
        expect(chapter.pages[0].style.opacity).toBe('0');
        next.resolve(translated);await flush();
        const displayed=env.roots.at(-1)!.querySelector('.fluent-read-image-translation-bitmap');
        for(let i=0;i<3;i++){env.scroll();env.runFrames();await flush();env.runFrames();await flush();expect(chapter.pages[0].style.opacity).toBe('0');}
        expect(displayed!.isConnected).toBe(true);expect(client.translate).toHaveBeenCalledTimes(3);
        toggleMangaTranslation();expect(chapter.pages[0].style.opacity).not.toBe('0');
        toggleMangaTranslation();expect(chapter.pages[0].style.opacity).toBe('0');expect(client.translate).toHaveBeenCalledTimes(3);
        third.resolve(translated);await flush();
    });
    it('接近视口时预合成历史页，即使关闭预译也不会额外调用翻译服务',async()=>{
        const env=readerPage();settings.imageTranslationMangaPrefetchPages=0;settings.imageTranslationMangaCachePages=2;
        const chapter=cacheChapter(env,10),decode=vi.fn().mockImplementation(async()=>({width:10,height:20,close:vi.fn()}));vi.stubGlobal('createImageBitmap',decode);
        client.translate.mockResolvedValue({...result,image:'',mangaPatches:{width:400,height:200,patches:[{x:0,y:0,width:10,height:20,image:'data:image/png;base64,AQID'}]}});
        toggleMangaTranslation();await flush();await chapter.visit(3);await chapter.visit(6);await chapter.visit(9);
        const before=decode.mock.calls.length;await chapter.visit(9,0);expect(decode).toHaveBeenCalledTimes(before+1);expect(chapter.pages[0].style.opacity).not.toBe('0');
        await chapter.visit(0);expect(decode).toHaveBeenCalledTimes(before+1);expect(client.translate).toHaveBeenCalledTimes(4);expect(chapter.pages[0].style.opacity).toBe('0');
    });
    it('预合成离开附近窗口后同一检查点返页，不复用已取消任务而停留在加载状态', async () => {
        const env = readerPage(); settings.imageTranslationMangaPrefetchPages = 0; settings.imageTranslationMangaCachePages = 2;
        const chapter = cacheChapter(env, 10), decode = vi.fn(async () => ({width: 10, height: 20, close: vi.fn()}));
        vi.stubGlobal('createImageBitmap', decode);
        client.translate.mockResolvedValue({...result, image: '', mangaPatches: {width: 400, height: 200, patches: [{x: 0, y: 0, width: 10, height: 20, image: 'data:image/png;base64,AQID'}]}});
        toggleMangaTranslation(); await flush(); await chapter.visit(3); await chapter.visit(6); await chapter.visit(9);
        const pending = deferred<{width: number; height: number; close: ReturnType<typeof vi.fn>}>(); decode.mockReturnValueOnce(pending.promise);
        chapter.near(0); await flush(); const before = decode.mock.calls.length;
        chapter.near(-1); const returned = chapter.arrive(0); await returned;
        const late = {width: 10, height: 20, close: vi.fn()}; pending.resolve(late); await flush();
        expect(chapter.pages[0].style.opacity).toBe('0'); expect(decode).toHaveBeenCalledTimes(before + 1);
        expect(client.translate).toHaveBeenCalledTimes(4);
        expect(late.close).toHaveBeenCalledOnce(); expect(chapter.pages[0].style.opacity).toBe('0');
        for (let frame = 0; frame < 3; frame++) await chapter.visit(0);
        expect(decode).toHaveBeenCalledTimes(before + 1); expect(client.translate).toHaveBeenCalledTimes(4);
    });
    it('已取消的旧预合成结束不清除新任务，同页连续靠近只重建一次', async () => {
        const env = readerPage(); settings.imageTranslationMangaPrefetchPages = 0; settings.imageTranslationMangaCachePages = 2;
        const chapter = cacheChapter(env, 10), decode = vi.fn(async () => ({width: 10, height: 20, close: vi.fn()}));
        vi.stubGlobal('createImageBitmap', decode);
        client.translate.mockResolvedValue({...result, image: '', mangaPatches: {width: 400, height: 200, patches: [{x: 0, y: 0, width: 10, height: 20, image: 'data:image/png;base64,AQID'}]}});
        toggleMangaTranslation(); await flush(); await chapter.visit(3); await chapter.visit(6); await chapter.visit(9);
        const old = deferred<{width: number; height: number; close: ReturnType<typeof vi.fn>}>(), current = deferred<{width: number; height: number; close: ReturnType<typeof vi.fn>}>();
        decode.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
        chapter.near(0); await flush(); const before = decode.mock.calls.length;
        chapter.near(-1); chapter.near(0); await flush();
        for (let frame = 0; frame < 3; frame++) {chapter.near(0); await flush();}
        const stale = {width: 10, height: 20, close: vi.fn()}, valid = {width: 10, height: 20, close: vi.fn()};
        old.resolve(stale); current.resolve(valid); await flush();
        expect(decode).toHaveBeenCalledTimes(before + 1); expect(stale.close).toHaveBeenCalledOnce(); expect(valid.close).toHaveBeenCalledOnce();
        await chapter.visit(0); expect(chapter.pages[0].style.opacity).toBe('0'); expect(decode).toHaveBeenCalledTimes(before + 1);
        expect(client.translate).toHaveBeenCalledTimes(4);
    });
    it.each(['pause','source','language','route','unmount'] as const)('预合成期间 %s，迟到结果不能复活且位图释放',async change=>{
        const env=readerPage();settings.imageTranslationMangaPrefetchPages=0;settings.imageTranslationMangaCachePages=2;
        const chapter=cacheChapter(env,10),decode=vi.fn().mockImplementation(async()=>({width:10,height:20,close:vi.fn()}));vi.stubGlobal('createImageBitmap',decode);
        client.translate.mockResolvedValue({...result,image:'',mangaPatches:{width:400,height:200,patches:[{x:0,y:0,width:10,height:20,image:'data:image/png;base64,AQID'}]}});
        toggleMangaTranslation();await flush();await chapter.visit(3);await chapter.visit(6);await chapter.visit(9);
        const pending=deferred<{width:number;height:number;close:ReturnType<typeof vi.fn>}>();decode.mockReturnValueOnce(pending.promise);
        chapter.near(0);await flush();
        if(change==='pause')toggleMangaTranslation();
        if(change==='source'){chapter.pages[0].src+='?new';env.scroll();env.runFrames();}
        if(change==='language')settings.to='en';
        if(change==='route'){(env.windowObject as typeof env.windowObject & {location:{href:string}}).location.href='https://mangaplus.shueisha.co.jp/viewer/1024051';document.dispatchEvent(new document.defaultView!.Event('fluentread-route-change'));env.runFrames();}
        if(change==='unmount')unmountImageTranslator();
        const bitmap={width:10,height:20,close:vi.fn()};pending.resolve(bitmap);await flush();expect(bitmap.close).toHaveBeenCalledOnce();
        expect(chapter.pages[0].style.opacity).not.toBe('0');unmountImageTranslator();expect(env.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);
    });
    it('同地址重载撤下旧译图并重新识别，不能停在已完成状态',async()=>{
        const env=readerPage();settings.imageTranslationMangaPrefetchPages=0;
        toggleMangaTranslation();await flush();expect(env.bitmap()).not.toBeNull();
        env.image.dispatchEvent(new env.image.ownerDocument.defaultView!.Event('load',{bubbles:true}));
        env.runFrames();await flush();
        expect(client.translate).toHaveBeenCalledTimes(2);expect(env.bitmap()).not.toBeNull();
    });
    it('新源已经处理后到达首次 load 保留译图与缓存，后续同地址 load 才重新识别',async()=>{
        const env=readerPage();settings.useCache=true;settings.imageTranslationMangaPrefetchPages=0;
        toggleMangaTranslation();await flush();env.image.src='https://example.test/new-loaded.png';env.notify();env.runFrames();await flush();
        expect(client.translate).toHaveBeenCalledTimes(2);const translated=env.bitmap();expect(translated).not.toBeNull();
        env.image.dispatchEvent(new env.image.ownerDocument.defaultView!.Event('load',{bubbles:true}));env.runFrames();await flush();
        expect(client.translate).toHaveBeenCalledTimes(2);expect(env.bitmap()).toBe(translated);
        env.image.dispatchEvent(new env.image.ownerDocument.defaultView!.Event('load',{bubbles:true}));env.runFrames();await flush();
        expect(client.translate).toHaveBeenCalledTimes(3);
    });
    it('无文字页离开附近窗口后上下左右返回可复用零位图结果',async()=>{
        const env=readerPage();settings.useCache=true;settings.imageTranslationMangaPrefetchPages=0;
        client.translate.mockResolvedValueOnce({...result,lines:[]});
        for(let i=0;i<3;i++){const p=document.createElement('img');p.className='zao-image';env.parent.append(p);}
        let secondLeft=1400;const second=addSecondHoverImage(env,()=>({left:secondLeft,right:secondLeft+400,top:40,bottom:240,width:400,height:200}) as DOMRect);second.className='zao-image';
        const scroll=()=>{for(const [name,callback] of env.windowObject.addEventListener.mock.calls)if(name==='scroll')(callback as EventListener)(new Event('scroll'));env.runFrames();};
        toggleMangaTranslation();await flush();expect(env.bitmap()).toBeNull();
        env.setRect({left:-600,right:-200,top:40,bottom:240,width:400,height:200});secondLeft=20;scroll();await flush();
        expect(client.translate).toHaveBeenCalledOnce();vi.advanceTimersByTime(180);env.runFrames();await flush();
        env.setRect({left:20,right:420,top:40,bottom:240,width:400,height:200});secondLeft=1400;scroll();await flush();
        expect(client.translate).toHaveBeenCalledTimes(2);expect(env.bitmap()).toBeNull();
        expect(env.image.style.opacity).not.toBe('0');
    });
    it.each([true,false])('无文字页暂停后重开保留已完成结果，缓存=%s',async useCache=>{
        const env=readerPage();settings.useCache=useCache;settings.imageTranslationMangaPrefetchPages=0;
        client.translate.mockResolvedValue({...result,lines:[]});toggleMangaTranslation();await flush();
        toggleMangaTranslation();toggleMangaTranslation();await flush();
        expect(client.translate).toHaveBeenCalledTimes(1);expect(env.bitmap()).toBeNull();
    });
    it('无文字完成标记在目标语言变化和同地址重载后失效',async()=>{
        const env=readerPage();settings.useCache=true;settings.imageTranslationMangaPrefetchPages=0;
        client.translate.mockResolvedValue({...result,lines:[]});toggleMangaTranslation();await flush();
        settings.to='en';await flush();env.runFrames();await flush();
        expect(client.translate).toHaveBeenCalledTimes(2);
        env.image.dispatchEvent(new env.image.ownerDocument.defaultView!.Event('load',{bubbles:true}));env.runFrames();await flush();
        expect(client.translate).toHaveBeenCalledTimes(3);expect(env.bitmap()).toBeNull();
    });
    it('已有单图译图切到漫画处理后暂停，仍取消新请求并禁止迟到结果复活',async()=>{
        const env=readerPage();settings.imageTranslationMangaPrefetchPages=0;
        env.hover();env.click();await flush();expect(env.bitmap()).not.toBeNull();
        const pending=deferred<typeof result>();client.translate.mockReturnValueOnce(pending.promise);
        toggleMangaTranslation();await flush();expect(client.translate).toHaveBeenCalledTimes(2);
        toggleMangaTranslation();expect(client.translate.mock.calls[1][3].signal.aborted).toBe(true);
        pending.resolve(result);await flush();expect(env.bitmap()).toBeNull();expect(env.image.style.opacity).not.toBe('0');
    });
    it.each([true,false])('另一张处理时快速往返，最近已翻译页面保持稳定且不重做，缓存=%s', async useCache => {
        const env=readerPage();settings.useCache=useCache;settings.imageTranslationMangaPrefetchPages=0;
        let secondTop=1000;
        const second=addSecondHoverImage(env,()=>({left:20,right:420,top:secondTop,bottom:secondTop+200,width:400,height:200}) as DOMRect);second.className='zao-image';
        const scroll=()=>{for(const [name,callback] of env.windowObject.addEventListener.mock.calls) if(name==='scroll') (callback as EventListener)(new Event('scroll'));env.runFrames();};
        toggleMangaTranslation();await flush();expect(env.image.style.opacity).toBe('0');
        const pending=deferred<typeof result>();client.translate.mockReturnValueOnce(pending.promise);
        const decodedBeforeScroll=env.decoded.length;
        env.setRect({left:20,right:420,top:-300,bottom:-100,width:400,height:200});secondTop=40;scroll();await flush();
        vi.advanceTimersByTime(179);env.runFrames();await flush();
        expect(client.translate).toHaveBeenCalledOnce();expect(env.decoded).toHaveLength(decodedBeforeScroll);
        vi.advanceTimersByTime(1);env.runFrames();await flush();
        expect(client.translate).toHaveBeenCalledTimes(2);
        for(const stage of ['preparing','recognizing','translating','cleaning','rendering'] as const) {
            env.setRect({left:20,right:420,top:40,bottom:240,width:400,height:200});secondTop=1000;scroll();await flush();
            client.translate.mock.calls[1][3].onProgress(stage,50);scroll();await flush();
            expect(env.image.style.opacity).toBe('0');expect(env.bitmap()).not.toBeNull();expect(client.translate).toHaveBeenCalledTimes(2);
            env.setRect({left:20,right:420,top:-300,bottom:-100,width:400,height:200});secondTop=40;scroll();await flush();
        }
        pending.resolve(result);await flush();env.runFrames();toggleMangaTranslation();await flush();
        expect(env.image.style.opacity).not.toBe('0');expect(second.style.opacity).not.toBe('0');
    });
    it('超过最近两张保留窗口后返回缓存页，立即显示，不等待正在识别的另一张', async () => {
        const env=readerPage();settings.useCache=true;settings.imageTranslationMangaPrefetchPages=0;
        for(let i=0;i<3;i++) {const placeholder=document.createElement('img');placeholder.className='zao-image';env.parent.append(placeholder);}
        let secondTop=1000;const second=addSecondHoverImage(env,()=>({left:20,right:420,top:secondTop,bottom:secondTop+200,width:400,height:200}) as DOMRect);second.className='zao-image';
        const scroll=()=>{for(const [name,callback] of env.windowObject.addEventListener.mock.calls) if(name==='scroll') (callback as EventListener)(new Event('scroll'));env.runFrames();};
        toggleMangaTranslation();await flush();const bitmap=env.bitmap();
        const pending=deferred<typeof result>();client.translate.mockReturnValueOnce(pending.promise);
        env.setRect({left:20,right:420,top:-300,bottom:-100,width:400,height:200});secondTop=40;scroll();await flush();
        expect(client.translate).toHaveBeenCalledOnce();vi.advanceTimersByTime(180);env.runFrames();await flush();
        expect(client.translate).toHaveBeenCalledTimes(2);
        env.setRect({left:20,right:420,top:40,bottom:240,width:400,height:200});secondTop=1000;scroll();await flush();
        expect(env.image.style.opacity).toBe('0');expect(env.bitmap()).toBe(bitmap);expect(client.translate).toHaveBeenCalledTimes(2);
        pending.resolve(result);await flush();unmountImageTranslator();expect(env.image.style.opacity).not.toBe('0');
    });
    it.each(['source','language','cache','remove'] as const)('另一张尚在处理时，失效的返页结果不会被同步复用：%s', async change => {
        const env=readerPage();settings.useCache=true;settings.imageTranslationMangaPrefetchPages=0;
        for(let i=0;i<3;i++) {const placeholder=document.createElement('img');placeholder.className='zao-image';env.parent.append(placeholder);}
        let secondTop=1000;const second=addSecondHoverImage(env,()=>({left:20,right:420,top:secondTop,bottom:secondTop+200,width:400,height:200}) as DOMRect);second.className='zao-image';
        const scroll=()=>{for(const [name,callback] of env.windowObject.addEventListener.mock.calls) if(name==='scroll') (callback as EventListener)(new Event('scroll'));env.runFrames();};
        toggleMangaTranslation();await flush();
        const pending=deferred<typeof result>(),fresh=deferred<typeof result>();client.translate.mockReturnValueOnce(pending.promise).mockReturnValue(fresh.promise);
        env.setRect({left:20,right:420,top:-300,bottom:-100,width:400,height:200});secondTop=40;scroll();await flush();
        expect(client.translate).toHaveBeenCalledOnce();vi.advanceTimersByTime(180);env.runFrames();await flush();
        if(change==='source')env.image.src+='?new-source';
        if(change==='language')settings.to='en';
        if(change==='cache')settings.useCache=false;
        if(change==='remove')env.image.remove();
        env.setRect({left:20,right:420,top:40,bottom:240,width:400,height:200});secondTop=1000;scroll();await flush();
        expect(env.image.style.opacity).not.toBe('0');expect(env.bitmap()).toBeNull();
        unmountImageTranslator();pending.resolve(result);fresh.resolve(result);await flush();expect(env.bitmap()).toBeNull();
    });
    it('漫画每个处理阶段保持原图可见，提示真实进度且无操作弹窗，暂停即清除', async () => {
        const env = readerPage();const pending = deferred<typeof result>();client.translate.mockReturnValueOnce(pending.promise);
        const listener=vi.fn(),stop=subscribeMangaTranslation(listener);
        toggleMangaTranslation();await flush();
        const feedback=env.roots[0].querySelector('.fr-image-feedback') as HTMLElement;
        const controls=env.roots[0].querySelector('.fr-image-controls') as HTMLElement;
        for (const stage of ['preparing','recognizing','translating','cleaning','rendering'] as const) {
            client.translate.mock.calls[0][3].onProgress(stage,42);await flush();
            expect(feedback.hidden).toBe(false);expect(controls.hidden).toBe(true);expect(env.image.style.opacity).not.toBe('0');
            expect(feedback.querySelector('button')).toBeNull();
            expect(feedback.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe(['preparing','recognizing','cleaning'].includes(stage)?'42':null);
            expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({pending:true,stage}));
        }
        toggleMangaTranslation();pending.resolve(result);await flush();
        expect(env.bitmap()).toBeNull();expect(feedback.hidden).toBe(true);expect(env.image.style.opacity).not.toBe('0');stop();
    });
    it('连续漫画进度不反复读取布局，异步失败无需滚动或额外DOM变化即可定位边缘恢复条', async () => {
        const env=readerPage(),pending=deferred<typeof result>();client.translate.mockReturnValueOnce(pending.promise);
        toggleMangaTranslation();await flush();env.runFrames();
        const bounds=vi.spyOn(env.image,'getBoundingClientRect');
        for(let index=0;index<100;index++)client.translate.mock.calls[0][3].onProgress('recognizing',index);
        expect(bounds).not.toHaveBeenCalled();
        pending.reject(new Error('translation unavailable'));await flush();
        expect(bounds).toHaveBeenCalledOnce();
        const feedback=env.roots[0].querySelector<HTMLElement>('.fr-image-feedback')!;
        expect(feedback.hidden).toBe(false);expect(feedback.style.left).toBe('8px');expect(feedback.style.top).toBe('8px');
        expect(env.image.style.opacity).not.toBe('0');
    });
    it.each(['button','contextmenu'] as const)('漫画失败保持原图可读，%s 重试进入会话并清除错误', async action => {
        const env=readerPage();client.translate.mockRejectedValueOnce(new Error('翻译服务暂时不可用'));
        const listener=vi.fn(),stop=subscribeMangaTranslation(listener);toggleMangaTranslation();await flush();
        const feedback = env.roots[0].querySelector('.fr-image-feedback') as HTMLElement;
        env.runFrames();
        expect(feedback.hidden).toBe(false);expect(feedback.style.left).toBe('8px');expect(feedback.style.top).toBe('8px');
        expect(feedback.contains(env.button())).toBe(true);
        expect(env.image.style.opacity).not.toBe('0');expect(env.button().textContent).toBe('重试');
        expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({errors:1,pending:false}));
        const pending=deferred<typeof result>();client.translate.mockReturnValueOnce(pending.promise);
        if(action==='button') env.click();
        else {env.dispatch(env.image,'contextmenu');expect(toggleContextMenuImage(env.image.src)).toBe(true);}
        await flush();expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({errors:0,pending:true}));
        expect(feedback.querySelector('button')).toBeNull();
        pending.resolve(result);await flush();env.runFrames();await flush();expect(env.bitmap()).not.toBeNull();
        expect(feedback.hidden).toBe(true);
        expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({errors:0,pending:false}));stop();
    });
    it.each(['pause','dismiss'] as const)('漫画失败提示跟随可见边缘，%s 后撤下且不自动重复请求', async action => {
        const env=readerPage();client.translate.mockRejectedValueOnce(new Error('翻译服务暂时不可用'));
        toggleMangaTranslation();await flush();
        const feedback=env.roots[0].querySelector('.fr-image-feedback') as HTMLElement;
        env.setRect({left:-40,right:360,top:-80,bottom:120,width:400,height:200});env.scroll();env.runFrames();
        expect(feedback.style.left).toBe('48px');expect(feedback.style.top).toBe('88px');
        expect(feedback.hidden).toBe(false);expect(env.image.style.opacity).not.toBe('0');
        if(action==='pause') {toggleMangaTranslation();expect(feedback.hidden).toBe(true);}
        else {env.dispatch(feedback.querySelector('.fr-image-dismiss')!,'click');expect(feedback.isConnected).toBe(false);}
        env.runFrames();vi.advanceTimersByTime(1000);await flush();expect(client.translate).toHaveBeenCalledOnce();
        expect(env.bitmap()).toBeNull();expect(env.image.style.opacity).not.toBe('0');
    });
    it('一次开启、原图暂停、重新开启复用已解码结果，即使持久缓存关闭', async () => {
        const env = readerPage(); settings.useCache = false;
        const listener = vi.fn(); const stop = subscribeMangaTranslation(listener);
        expect(toggleMangaTranslation()).toBe(true); await flush();
        expect(client.translate).toHaveBeenCalledTimes(1); expect(env.bitmap()).not.toBeNull();
        expect(env.image.style.opacity).toBe('0');
        toggleMangaTranslation(); await flush();
        expect(env.bitmap()).toBeNull(); expect(env.image.style.opacity).not.toBe('0');
        toggleMangaTranslation(); await flush();
        expect(env.bitmap()).not.toBeNull(); expect(client.translate).toHaveBeenCalledTimes(1);
        unmountImageTranslator(); expect(env.image.style.opacity).not.toBe('0');
        expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({available: false, active: false, pending: false, errors: 0, pageCount: 0}));
        expect(toggleMangaTranslation()).toBe(false); stop();
    });
    it('漫画未检测到文字时保留原图和说明，不创建空译图也不作为会话失败', async () => {
        const env=readerPage();client.translate.mockResolvedValueOnce({...result,lines:[]});
        const listener=vi.fn(),stop=subscribeMangaTranslation(listener);toggleMangaTranslation();await flush();
        expect(env.bitmap()).toBeNull();expect(env.image.style.opacity).not.toBe('0');
        expect(env.roots[0].querySelector('.fr-image-status')!.textContent).toContain('未检测到文字，已保留原图');
        expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({errors:0,completed:1,pending:false}));stop();
    });
    it('漫画使用独立模型，不准备普通图片语言包，关闭入口后恢复原图', async () => {
        const env = readerPage();
        toggleMangaTranslation(); await flush();
        expect(client.prepare).not.toHaveBeenCalled(); expect(client.translate).toHaveBeenCalledTimes(1);
        expect(client.translate.mock.calls[0][3]).toMatchObject({manga:true});
        expect(env.bitmap()).not.toBeNull();
        settings.imageTranslationMangaEnabled = false; await flush(); env.runFrames(); await flush();
        expect(env.bitmap()).toBeNull(); expect(env.image.style.opacity).not.toBe('0');
        expect(toggleMangaTranslation()).toBe(false);
    });
    it('关闭时取消未完成任务，晚到译图不能隐藏原图', async () => {
        const env = readerPage(); const pending = deferred<typeof result>(); client.translate.mockReturnValue(pending.promise);
        toggleMangaTranslation(); await flush(); toggleMangaTranslation(); pending.resolve(result); await flush();
        expect(env.bitmap()).toBeNull(); expect(env.image.style.opacity).not.toBe('0');
    });
 });

it('正文文本新增不重复读取图片资源身份，但 picture 新 source 与移除仍立即失效', async () => {
    const env = setup();
    const picture = document.createElement('picture');
    env.parent.append(picture); picture.append(env.image);
    env.hover(); env.click(); await flush();
    expect(env.bitmap()).not.toBeNull();
    const read = vi.spyOn(env.image, 'getAttribute');
    const unrelated = document.createElement('div'); document.body.append(unrelated);
    const record = {type: 'childList', target: unrelated, addedNodes: [document.createTextNode('update')], removedNodes: []} as unknown as MutationRecord;
    for (let count = 0; count < 1000; count++) env.observers[0].callback([record], {} as MutationObserver);
    expect(read.mock.calls.filter(([name]) => name === 'srcset')).toHaveLength(0);
    expect(env.bitmap()).not.toBeNull();
    const source = document.createElement('source'); source.setAttribute('srcset', 'https://example.test/other.png'); picture.prepend(source);
    env.observers[0].callback([{type: 'childList', target: picture, addedNodes: [source], removedNodes: []} as unknown as MutationRecord], {} as MutationObserver);
    expect(env.bitmap()).toBeNull();
    expect(env.image.style.opacity).not.toBe('0');
    env.click(); await flush(); expect(env.bitmap()).not.toBeNull();
    picture.remove();
    env.observers[0].callback([{type: 'childList', target: env.parent, addedNodes: [], removedNodes: [picture]} as unknown as MutationRecord], {} as MutationObserver);
    expect(env.observers[0].disconnect).toHaveBeenCalled();
});

it('正文文本触发的响应式换图在下一帧复核并恢复原图', async () => {
    const env = setup(); env.hover(); env.click(); await flush();
    expect(env.bitmap()).not.toBeNull();
    Object.defineProperty(env.image, 'currentSrc', {configurable: true, get: () => 'https://example.test/reselected.png'});
    const paragraph = document.createElement('p'); document.body.append(paragraph);
    env.observers[0].callback([{type: 'childList', target: paragraph, addedNodes: [document.createTextNode('content')], removedNodes: []} as unknown as MutationRecord], {} as MutationObserver);
    env.runFrames();
    expect(env.bitmap()).toBeNull(); expect(env.image.style.opacity).not.toBe('0');
});

it('正文文本更新后在途结果即使先于帧返回也不能覆盖已换源的图片', async () => {
    const pending = deferred<typeof result>(); client.translate.mockReturnValueOnce(pending.promise);
    const env = setup(); env.hover(); env.click(); await flush();
    Object.defineProperty(env.image, 'currentSrc', {configurable: true, get: () => 'https://example.test/reselected.png'});
    const paragraph = document.createElement('p'); document.body.append(paragraph);
    env.observers[0].callback([{type: 'childList', target: paragraph, addedNodes: [document.createTextNode('content')], removedNodes: []} as unknown as MutationRecord], {} as MutationObserver);
    pending.resolve(result); await flush();
    expect(env.bitmap()).toBeNull(); expect(env.image.style.opacity).not.toBe('0');
});

it.each(['head', 'style'] as const)('%s 中新增文本仍同步复核图片资源', async tag => {
    const env = setup(); env.hover(); env.click(); await flush(); expect(env.bitmap()).not.toBeNull();
    Object.defineProperty(env.image, 'currentSrc', {configurable: true, get: () => 'https://example.test/reselected.png'});
    const target = tag === 'head' ? document.head : document.createElement('style');
    if (tag === 'style') document.body.append(target);
    env.observers[0].callback([{type: 'childList', target, addedNodes: [document.createTextNode('content')], removedNodes: []} as unknown as MutationRecord], {} as MutationObserver);
    expect(env.bitmap()).toBeNull(); expect(env.image.style.opacity).not.toBe('0');
});

it.each(['throw', 'missing'] as const)('正文元素 closest %s 时保守复核并继续调度布局', async mode => {
    const env = setup(); env.hover(); env.click(); await flush(); expect(env.bitmap()).not.toBeNull();
    Object.defineProperty(env.image, 'currentSrc', {configurable: true, get: () => 'https://example.test/reselected.png'});
    const target = document.createElement('p'); document.body.append(target);
    Object.defineProperty(target, 'closest', {configurable: true, value: mode === 'throw' ? () => {throw new Error('host override');} : undefined});
    expect(() => env.observers[0].callback([{type: 'childList', target, addedNodes: [document.createTextNode('content')], removedNodes: []} as unknown as MutationRecord], {} as MutationObserver)).not.toThrow();
    expect(env.bitmap()).toBeNull(); expect(env.windowObject.requestAnimationFrame).toHaveBeenCalled();
});

it('大量文本节点的批量更新采用有界保守检查', async () => {
    const env = setup(); env.hover(); env.click(); await flush(); expect(env.bitmap()).not.toBeNull();
    Object.defineProperty(env.image, 'currentSrc', {configurable: true, get: () => 'https://example.test/reselected.png'});
    const target = document.createElement('p'); document.body.append(target);
    env.observers[0].callback([{type: 'childList', target, addedNodes: Array.from({length: 9}, () => document.createTextNode('x')), removedNodes: []} as unknown as MutationRecord], {} as MutationObserver);
    expect(env.bitmap()).toBeNull();
});
