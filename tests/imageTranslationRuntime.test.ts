import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';

const client = vi.hoisted(() => ({translate: vi.fn(), prepare: vi.fn(), fetch: vi.fn()}));
const rawSettings = vi.hoisted(() => ({on: true, disableImageTranslator: false, from: 'auto', to: 'zh-Hans', service: 'google', useCache: true, animations: false}));
vi.mock('@/src/features/image-translation/services/client', () => ({
    translateImageInExtension: client.translate,
    prepareImageOcrLanguages: client.prepare,
    fetchImageInExtension: client.fetch,
}));
vi.mock('@/src/services/config/store', async () => {
    const {reactive, watch} = await import('vue');
    const config = reactive(rawSettings);
    return {config, subscribeConfig: (listener: (value: typeof config) => void) => watch(config, listener)};
});
import {config as settings} from '@/src/services/config/store';
import {mountImageTranslator, unmountImageTranslator, toggleContextMenuImage} from '@/src/features/image-translation/content/runtime';

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
    const getStyle = (element: Element) => element === image ? {...imageStyle, opacity: image.style.opacity || imageStyle.opacity} : element === parent ? parentStyle : {opacity: '1', overflowX: 'visible', overflowY: 'visible'};
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
    const resizeObservers: Array<{callback: ResizeObserverCallback; disconnect: ReturnType<typeof vi.fn>}> = [];
    vi.stubGlobal('MutationObserver', class {
        disconnect = vi.fn(); observe = vi.fn();
        constructor(public callback: MutationCallback) {observers.push(this);}
    });
    vi.stubGlobal('ResizeObserver', class {
        disconnect = vi.fn(); observe = vi.fn();
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
    const hover = () => dispatch(image, 'pointerover');
    const button = () => roots.at(-1)!.querySelector('.fluent-read-image-translation-button') as HTMLButtonElement;
    const click = (trusted = true) => dispatch(button(), 'click', trusted);
    const bitmap = () => roots.at(-1)?.querySelector('.fluent-read-image-translation-bitmap');
    const notify = (attributeName = 'src', type = 'attributes') => observers[0].callback([{type, attributeName, target: image} as unknown as MutationRecord], {} as MutationObserver);
    const runFrames = () => { const callbacks = Array.from(frames.values()); frames.clear(); callbacks.forEach(callback => callback(0)); };
    mountImageTranslator();
    return {image, parent, roots, decoded, canvases, draw, imageStyle, parentStyle, observers, resizeObservers, windowObject,
        hover, button, click, bitmap, dispatch, notify, runFrames,
        scroll: () => windowHandlers.get('scroll')?.(new domWindow.Event('scroll')),
        setRect: (next: typeof rect) => {rect = next;},
        setAutoDecode: (enabled: boolean) => {autoDecode = enabled;},
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    settings.imageTranslationHoverEnabled = true; settings.imageTranslationContextMenuEnabled = true;
    settings.on = true; settings.disableImageTranslator = false; settings.to = 'zh-Hans'; settings.useCache = true;
    settings.service = 'google'; settings.model = {}; settings.customModel = {}; settings.customBody = {}; settings.proxy = {}; settings.customOpenAIProviders = []; settings.token = {};
    client.translate.mockReset().mockResolvedValue(result);
    client.prepare.mockReset().mockResolvedValue(undefined);
    client.fetch.mockReset();
});
afterEach(() => {unmountImageTranslator(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();});

describe('图片翻译前台交互与生命周期', () => {
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

    it('同 URL 重新加载与目标语言变更都使已恢复的缓存失效', async () => {
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
            env.parent.append(image); env.dispatch(image, 'pointerover'); env.click(); await flush(); env.click();
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
        expect(env.roots[0].querySelector('.fr-image-controls')).toBeNull();
    });

    it('语言包准备从当前图片原地继续，并展示后台真实进度', async () => {
        client.translate.mockRejectedValueOnce(new Error('请先下载语言包'));
        const env = setup(); env.hover(); env.click(); await flush();
        const prepare = Array.from(env.roots[0].querySelectorAll('button')).find(button => button.textContent === '下载语言包并重试')!;
        expect(prepare.hidden).toBe(false);
        expect(env.roots[0].querySelector('[role="status"]')!.textContent).toBe('首次使用需准备识别语言包，下载后自动继续');
        env.dispatch(prepare, 'click'); await flush(); expect(client.prepare).toHaveBeenCalledWith('auto', expect.any(AbortSignal));
        expect(env.button().dataset.phase).toBe('translated');
        env.click(); settings.useCache = false; const pending = deferred<typeof result>(); client.translate.mockReturnValueOnce(pending.promise);
        env.click(); await flush(); client.translate.mock.calls.at(-1)![3].onProgress('translating');
        expect(env.roots[0].querySelector('[role="status"]')!.textContent).toBe('正在翻译文字…');
        pending.resolve(result); await flush();
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
        expect(env.windowObject.removeEventListener).toHaveBeenCalledTimes(2);
    });
});

describe('图片入口独立开关与右键身份', () => {
    it('覆盖层上的可信指针命中局部图片，移出后收起', () => {
        const env = setup();
        const cover = document.createElement('div'); env.parent.append(cover);
        env.dispatch(cover, 'pointermove', true, {clientX: 100, clientY: 100});
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
    env.dispatch(dialog, 'pointermove', true, {clientX: 100, clientY: 100}); expect(env.roots).toHaveLength(0);
    const duplicate = document.createElement('img'); duplicate.getBoundingClientRect = env.image.getBoundingClientRect; env.parent.append(duplicate);
    const cover = document.createElement('div'); env.parent.append(cover);
    env.dispatch(cover, 'pointerover', true, {clientX: 100, clientY: 100}); expect(env.roots).toHaveLength(0);
    env.dispatch(env.image, 'contextmenu'); env.image.remove(); expect(toggleContextMenuImage()).toBe(false);
});
