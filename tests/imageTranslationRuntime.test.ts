import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {toRaw} from 'vue';

const client = vi.hoisted(() => ({translate: vi.fn(), prepare: vi.fn(), fetch: vi.fn()}));
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
import {config as settings} from '@/src/services/config/store';
import {mountImageTranslator, unmountImageTranslator, toggleContextMenuImage, toggleMangaTranslation, subscribeMangaTranslation} from '@/src/features/image-translation/content/runtime';
import {registerAllUiLanguageBundles} from '@/src/core/i18n/bundles';

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

function setup() {
    const {document, window: domWindow} = parseHTML('<html><head><title>Image fixture</title></head><body><div id="clip"><img src="https://example.test/source.png" srcset="https://example.test/source.png 1x" /></div></body></html>');
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
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
        const element = originalCreate(tag);
        if (tag === 'img') decorateStyle(element as HTMLElement);
        if (tag === 'canvas') {
            const canvas = element as HTMLCanvasElement;
            canvas.getContext = vi.fn(() => ({drawImage: draw, getImageData: vi.fn()})) as never;
            canvas.toDataURL = () => 'data:image/png;base64,source';
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
            naturalWidth: {value: 400}, naturalHeight: {value: 200},
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
    const observers: Array<{callback: MutationCallback; disconnect: ReturnType<typeof vi.fn>}> = [];
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
    return {image, parent, roots, decoded, canvases, draw, imageStyle, parentStyle, observers, resizeObservers, windowObject,
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
    settings.uiLanguage = 'zh-CN';
    settings.on = true; settings.disableImageTranslator = false; settings.to = 'zh-Hans'; settings.useCache = true;
    settings.imageTranslationService = ''; settings.service = 'google'; settings.model = {}; settings.customModel = {}; settings.customBody = {}; settings.proxy = {}; settings.customOpenAIProviders = []; settings.token = {};
    client.translate.mockReset().mockResolvedValue(result);
    client.prepare.mockReset().mockResolvedValue(undefined);
    client.fetch.mockReset();
});
afterEach(() => {unmountImageTranslator(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();});

describe('图片翻译前台交互与生命周期', () => {
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
        expect(env.button().title).toBe('FluentRead · 翻译图片');
        toRaw(settings).uiLanguage = 'en-US';
        configNotifications.forEach(notify => notify());
        expect(env.button().title).toBe('FluentRead · Translate image');
        expect(env.button().getAttribute('aria-label')).toBe(env.button().title);
        configNotifications.forEach(notify => notify());
        expect(env.button().title).toBe('FluentRead · Translate image');
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

    it('解码期间取消和解码超时清理监听，迟到的 decode 不复活结果', async () => {
        const env = setup(); env.setAutoDecode(false); env.hover(); env.click(); await flush();
        const old = env.decoded[0]; const oldLoad = old.onload;
        env.click(); expect(old.onload).toBeNull(); expect(old.src).toBe('');
        oldLoad?.call(old, new Event('load')); await flush(); expect(env.bitmap()).toBeNull();
        env.click(); await flush(); vi.advanceTimersByTime(15_001); await flush();
        expect(env.button().dataset.phase).toBe('error'); expect(env.roots[0].querySelector('[role="status"]')!.textContent).toContain('译图加载超时');
        expect(env.decoded[1].onload).toBeNull();
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
        env.dispatch(prepare, 'click'); await flush(); expect(client.prepare).toHaveBeenCalledWith('auto', expect.any(AbortSignal));
        expect(env.button().dataset.phase).toBe('translated');
        env.click(); settings.useCache = false; const pending = deferred<typeof result>(); client.translate.mockReturnValueOnce(pending.promise);
        env.click(); await flush();
        client.translate.mock.calls.at(-1)![3].onProgress('recognizing', 37);
        expect(env.roots[0].querySelector('[role="status"]')!.textContent).toBe('正在识别图片文字… 37%');
        client.translate.mock.calls.at(-1)![3].onProgress('translating');
        expect(env.roots[0].querySelector('[role="status"]')!.textContent).toBe('正在翻译文字…');
        pending.resolve(result); await flush();
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
    it('同一目标且仍在当前图片内时不重复扫描，跨相邻图片、pointerout 和卸载后仍重新定位', () => {
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
    it.each([true,false])('另一张处理时快速往返，最近已翻译页面保持稳定且不重做，缓存=%s', async useCache => {
        const env=readerPage();settings.useCache=useCache;settings.imageTranslationMangaPrefetchPages=0;
        let secondTop=1000;
        const second=addSecondHoverImage(env,()=>({left:20,right:420,top:secondTop,bottom:secondTop+200,width:400,height:200}) as DOMRect);second.className='zao-image';
        const scroll=()=>{for(const [name,callback] of env.windowObject.addEventListener.mock.calls) if(name==='scroll') (callback as EventListener)(new Event('scroll'));env.runFrames();};
        toggleMangaTranslation();await flush();expect(env.image.style.opacity).toBe('0');
        const pending=deferred<typeof result>();client.translate.mockReturnValueOnce(pending.promise);
        env.setRect({left:20,right:420,top:-300,bottom:-100,width:400,height:200});secondTop=40;scroll();await flush();
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
        if(change==='source')env.image.src+='?new-source';
        if(change==='language')settings.to='en';
        if(change==='cache')settings.useCache=false;
        if(change==='remove')env.image.remove();
        env.setRect({left:20,right:420,top:40,bottom:240,width:400,height:200});secondTop=1000;scroll();await flush();
        expect(env.image.style.opacity).not.toBe('0');expect(env.bitmap()).toBeNull();
        unmountImageTranslator();pending.resolve(result);fresh.resolve(result);await flush();expect(env.bitmap()).toBeNull();
    });
    it('漫画每个处理阶段都保持原图可见且无逐图弹窗，会话仍发布进度并支持暂停', async () => {
        const env = readerPage();const pending = deferred<typeof result>();client.translate.mockReturnValueOnce(pending.promise);
        const listener=vi.fn(),stop=subscribeMangaTranslation(listener);
        toggleMangaTranslation();await flush();
        const feedback=env.roots[0].querySelector('.fr-image-feedback') as HTMLElement;
        const controls=env.roots[0].querySelector('.fr-image-controls') as HTMLElement;
        for (const stage of ['preparing','recognizing','translating','cleaning','rendering'] as const) {
            client.translate.mock.calls[0][3].onProgress(stage,42);await flush();
            expect(feedback.hidden).toBe(true);expect(controls.hidden).toBe(true);expect(env.image.style.opacity).not.toBe('0');
            expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({pending:true,stage}));
        }
        toggleMangaTranslation();pending.resolve(result);await flush();
        expect(env.bitmap()).toBeNull();expect(feedback.hidden).toBe(true);expect(env.image.style.opacity).not.toBe('0');stop();
    });
    it('漫画失败不弹出卡片，原图可读，图片重试仍恢复翻译', async () => {
        const env=readerPage();client.translate.mockRejectedValueOnce(new Error('翻译服务暂时不可用'));
        const listener=vi.fn(),stop=subscribeMangaTranslation(listener);toggleMangaTranslation();await flush();
        expect((env.roots[0].querySelector('.fr-image-feedback') as HTMLElement).hidden).toBe(true);
        expect(env.image.style.opacity).not.toBe('0');expect(env.button().textContent).toBe('重试');
        expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({errors:1,pending:false}));
        env.click();await flush();expect(env.bitmap()).not.toBeNull();stop();
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
