import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {parseHTML} from 'linkedom';
import type {VideoAiFullCaptureOptions} from '@/src/features/video-subtitle/content/video-ai/fullCapture';
import {Config} from '@/src/core/config/model';
import {BilibiliAiSource} from '@/src/features/video-subtitle/content/bilibiliAiSource';
import {mountPlatformCaptions} from '@/src/features/video-subtitle/content/platformRuntime';
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';
registerAllUiLanguageBundles();

const readingPort = vi.hoisted(() => ({annotate: vi.fn()}));
vi.mock('@/src/features/video-subtitle/content/readingAnnotationClient', () => ({annotateVideoReading: readingPort.annotate}));
vi.mock('@/src/platform/browser/capabilities', () => ({browserCapabilities: {extensionDom: true}}));
vi.mock('@/src/services/config/store', () => ({config: {uiLanguage: 'zh-CN'}}));
const bilibiliCapture = vi.hoisted(() => ({options: null as VideoAiFullCaptureOptions | null, start: vi.fn(), cancel: vi.fn(), destroy: vi.fn()}));
vi.mock('@/src/features/video-subtitle/content/video-ai/fullCapture', () => ({VideoAiFullCaptureController: class {
    constructor(options: VideoAiFullCaptureOptions) {bilibiliCapture.options = options;}
    start = bilibiliCapture.start; cancel = bilibiliCapture.cancel; destroy = bilibiliCapture.destroy; getSessionId = () => 1;
}}));
const disposals: Array<() => void> = [];
beforeEach(() => {
    vi.useFakeTimers(); bilibiliCapture.start.mockReset(); bilibiliCapture.cancel.mockReset(); bilibiliCapture.destroy.mockReset();
    readingPort.annotate.mockReset().mockImplementation(async (text, language) => ({text: `Reading: ${text}`, language, scheme: 'fixture'}));
});
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); vi.useRealTimers(); vi.unstubAllGlobals(); });

function fixture(url: string, html: string, translate = vi.fn().mockResolvedValue('测试译文')) {
    const {document, window} = parseHTML(`<html><body>${html}</body></html>`);
    // linkedom 不实现 CSS priority；补齐浏览器的标准接口，以验证精确恢复而非削弱产品逻辑。
    const stylePrototype = Object.getPrototypeOf(document.body.style);
    if (!stylePrototype.getPropertyPriority) {
        const priorities = new WeakMap<object, Map<string, string>>();
        const set = stylePrototype.setProperty, remove = stylePrototype.removeProperty, get = stylePrototype.getPropertyValue;
        stylePrototype.getPropertyValue = function (key: string) { return get.call(this, key) || ''; };
        stylePrototype.getPropertyPriority = function (key: string) { return priorities.get(this)?.get(key) || ''; };
        stylePrototype.setProperty = function (key: string, value: string, priority = '') {
            if (!priorities.has(this)) priorities.set(this, new Map());
            priorities.get(this)!.set(key, priority); return set.call(this, key, value);
        };
        stylePrototype.removeProperty = function (key: string) { priorities.get(this)?.delete(key); return remove.call(this, key); };
    }
    const selectedValues = new WeakMap<object, string>();
    Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
        configurable: true,
        get() { return selectedValues.get(this) || ''; },
        set(value) { selectedValues.set(this, value); },
    });
    const config = new Config(); config.to = 'zh-Hans'; config.on = true;
    Object.defineProperty(window, 'location', {value: new URL(url), configurable: true});
    Object.defineProperty(window, 'innerWidth', {value: 1280, configurable: true});
    Object.defineProperty(window, 'innerHeight', {value: 900, configurable: true});
    window.getComputedStyle = () => ({display: 'block', visibility: 'visible'}) as CSSStyleDeclaration;
    vi.stubGlobal('MutationObserver', window.MutationObserver);
    vi.stubGlobal('document', document); vi.stubGlobal('window', window);
    vi.stubGlobal('Node', window.Node); vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('Element', window.Element);
    let subscription: (() => void) | undefined;
    const patch = vi.fn((value: Partial<Config>) => { Object.assign(config, value); subscription?.(); });
    const subscribe = vi.fn((listener: () => void) => { subscription = listener; return vi.fn(); });
    const ports = {document: document as unknown as Document, window: window as unknown as Window, config, translate, patch, subscribe, iconUrl: 'chrome-extension://fixture/icon/128.png', openSettings: vi.fn(), label: (text: string) => text};
    const start = () => { const dispose = mountPlatformCaptions(ports); disposals.push(dispose); return dispose; };
    const shadow = () => document.getElementById('fluent-read-platform-captions')?.shadowRoot;
    return {document, window, config, translate, patch, subscribe, ports, start, shadow, change: () => subscription?.()};
}
const sentence = 'This is the first sentence in the meeting.';

describe('平台字幕双语顺序', () => {
    it('顺序立即切换并让读音紧跟原文，保持节点、缓存和单语偏好', async () => {
        const f = fixture('https://meet.google.com/abc-defg-hij', '<span data-caption-text>今日はいい天気です。</span>');
        f.config.from = 'ja'; f.config.videoSubtitleAppearance.readingAnnotation = true;
        f.start(); await vi.advanceTimersByTimeAsync(0);
        const panel = f.shadow()!.querySelector<HTMLElement>('.panel')!;
        const source = panel.querySelector<HTMLElement>('.source')!, reading = panel.querySelector<HTMLElement>('.reading')!, translated = panel.querySelector<HTMLElement>('.translation')!;
        const order = () => Array.from(panel.children).map(node => node.className);
        expect(order()).toEqual(['source fluent-read-video-subtitle-original', 'reading', 'translation', 'tools']);
        expect(reading.textContent).toBe('Reading: 今日はいい天気です。'); expect(reading.hidden).toBe(false);
        f.config.videoSubtitleAppearance.bilingualOrder = 'translation-first'; f.change();
        expect(order()).toEqual(['translation', 'source fluent-read-video-subtitle-original', 'reading', 'tools']);
        expect(panel.querySelector('.source')).toBe(source); expect(panel.querySelector('.reading')).toBe(reading); expect(panel.querySelector('.translation')).toBe(translated);
        expect(translated.textContent).toBe('测试译文');
        f.config.videoSubtitleDisplayMode = 'translation-only'; f.change(); await vi.advanceTimersByTimeAsync(0);
        expect(source.hidden).toBe(true); expect(reading.hidden).toBe(true);
        expect(f.config.videoSubtitleAppearance.bilingualOrder).toBe('translation-first');
        f.config.videoSubtitleDisplayMode = 'original-only'; f.change(); await vi.advanceTimersByTimeAsync(0);
        expect(source.hidden).toBe(false); expect(reading.hidden).toBe(false); expect(translated.textContent).toBe('');
        f.config.videoSubtitleDisplayMode = 'bilingual'; f.change(); await vi.advanceTimersByTimeAsync(0);
        expect(translated.textContent).toBe('测试译文'); expect(order()[0]).toBe('translation');
        f.config.videoSubtitleAppearance.bilingualOrder = 'original-first'; f.change();
        expect(order()).toEqual(['source fluent-read-video-subtitle-original', 'reading', 'translation', 'tools']);
        expect(f.translate).toHaveBeenCalledOnce(); expect(readingPort.annotate).toHaveBeenCalledOnce();
    });

    it('翻译等待时切换顺序不会重启请求，迟到结果写入相同译文节点', async () => {
        let finish!: (value: string) => void;
        const translate = vi.fn(() => new Promise<string>(resolve => {finish = resolve;}));
        const f = fixture('https://meet.google.com/abc-defg-hij', `<span data-caption-text>${sentence}</span>`, translate);
        f.start(); await vi.advanceTimersByTimeAsync(0);
        const panel = f.shadow()!.querySelector<HTMLElement>('.panel')!, translated = panel.querySelector('.translation');
        f.config.videoSubtitleAppearance.bilingualOrder = 'translation-first'; f.change();
        expect(panel.firstElementChild).toBe(translated); expect(translate).toHaveBeenCalledOnce();
        finish('Late translation'); await vi.advanceTimersByTimeAsync(0);
        expect(panel.firstElementChild).toBe(translated); expect(translated?.textContent).toBe('Late translation');
        expect(translate).toHaveBeenCalledOnce();
    });
});

describe('平台字幕外观配置', () => {
    it('把自定义字体描边和无背景变量应用到隔离的字幕面板', async () => {
        const f = fixture('https://meet.google.com/abc-defg-hij', '<span data-caption-text>Hello from the platform caption.</span>');
        Object.assign(f.config.videoSubtitleAppearance, {outlineStyle: 'stroke', outlineColor: '#ff1020', outlineWidth: 2.4, backgroundVisible: false});
        f.start(); await vi.advanceTimersByTimeAsync(0);
        const host = f.document.getElementById('fluent-read-platform-captions')!;
        const css = f.shadow()!.querySelector('style')!.textContent!;
        expect(host.style.getPropertyValue('--fluent-read-video-subtitle-text-stroke')).toBe('2.4px #ff1020');
        expect(host.style.getPropertyValue('--fluent-read-video-subtitle-background')).toBe('transparent');
        expect(host.style.getPropertyValue('--fluent-read-video-subtitle-border')).toBe('transparent');
        expect(host.style.getPropertyValue('--fluent-read-video-subtitle-backdrop-filter')).toBe('none');
        expect(css).toContain('.source,.translation{-webkit-text-stroke:var(--fluent-read-video-subtitle-text-stroke);paint-order:stroke fill}');
        expect(css).toContain('.tools{display:flex;justify-content:center;gap:8px;margin-top:4px;opacity:.8;pointer-events:auto;text-shadow:none;-webkit-text-stroke:0}');
    });
});

describe('平台字幕独立读音生命周期', () => {
    it('默认不计算，原文模式不等待翻译，当前句结果只适配一次并在仅译文时隐藏', async () => {
        let finish!: (value: {text: string; language: string; scheme: string}) => void;
        readingPort.annotate.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
        const f = fixture('https://meet.google.com/abc-defg-hij', '<span data-caption-text>今日はいい天気です。</span>');
        f.config.from = 'ja'; f.config.videoSubtitleDisplayMode = 'original-only';
        f.start(); await vi.advanceTimersByTimeAsync(100);
        expect(readingPort.annotate).not.toHaveBeenCalled();
        const panel = f.shadow()!.querySelector<HTMLElement>('.panel')!;
        const measure = vi.fn(() => 90); Object.defineProperty(panel, 'scrollHeight', {get: measure});
        f.config.videoSubtitleAppearance.readingAnnotation = true; f.change(); await vi.advanceTimersByTimeAsync(0);
        expect(readingPort.annotate).toHaveBeenCalledWith('今日はいい天気です。', 'ja', expect.any(AbortSignal));
        expect(f.shadow()?.querySelector('.source')?.textContent).toBe('今日はいい天気です。');
        expect(f.translate).not.toHaveBeenCalled(); measure.mockClear();
        finish({text: 'kyō wa ii tenki desu.', language: 'ja', scheme: 'fixture'}); await vi.advanceTimersByTimeAsync(0);
        expect(f.shadow()?.querySelector<HTMLElement>('.reading')?.hidden).toBe(false);
        expect(f.shadow()?.querySelector('.reading')?.textContent).toBe('kyō wa ii tenki desu.');
        expect(measure).toHaveBeenCalledTimes(2); measure.mockClear();
        f.config.uiLanguage = 'en-US'; f.change();
        expect(f.shadow()?.querySelector('.reading')?.getAttribute('aria-label')).toBe('Japanese romaji');
        expect(measure).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1000); expect(measure).not.toHaveBeenCalled(); expect(readingPort.annotate).toHaveBeenCalledOnce();
        f.config.videoSubtitleDisplayMode = 'translation-only'; f.change(); await vi.advanceTimersByTimeAsync(0);
        expect(f.shadow()?.querySelector<HTMLElement>('.reading')?.hidden).toBe(true);
        expect(f.config.videoSubtitleAppearance.readingAnnotation).toBe(true);
        f.config.videoSubtitleDisplayMode = 'original-only'; f.change(); await vi.advanceTimersByTimeAsync(0);
        expect(f.shadow()?.querySelector('.reading')?.textContent).toBe('kyō wa ii tenki desu.');
        expect(readingPort.annotate).toHaveBeenCalledOnce();
    });

    it('长读音保留最低可读字号，在自有区域滚动且关闭与卸载恢复交互', async () => {
        let finish!: (value: {text: string; language: string; scheme: string}) => void;
        readingPort.annotate.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
        const f = fixture('https://meet.google.com/abc-defg-hij', '<span data-caption-text>長い説明です。</span>');
        Object.defineProperty(f.window, 'innerHeight', {value: 200, configurable: true});
        f.config.from = 'ja'; f.config.videoSubtitleDisplayMode = 'original-only';
        f.config.videoSubtitleAppearance.fontScale = 500; f.config.videoSubtitleAppearance.readingAnnotation = true;
        const dispose = f.start(); await vi.advanceTimersByTimeAsync(0);
        const panel = f.shadow()!.querySelector<HTMLElement>('.panel')!, reading = f.shadow()!.querySelector<HTMLElement>('.reading')!;
        const measure = vi.fn(() => reading.hidden ? 60 : 600);
        Object.defineProperty(panel, 'scrollHeight', {get: measure});
        Object.defineProperty(panel, 'clientHeight', {get: () => 168}); panel.scrollTop = 0;
        finish({text: 'nagai setsumei desu. '.repeat(300), language: 'ja', scheme: 'fixture'}); await vi.advanceTimersByTimeAsync(0);
        expect(panel.style.fontSize).toBe('16px'); expect(f.config.videoSubtitleAppearance.fontScale).toBe(500);
        expect(panel.dataset.fluentReadSubtitleScrollable).toBe('true'); expect(panel.getAttribute('tabindex')).toBe('0');
        expect(panel.getAttribute('role')).toBe('region'); expect(panel.getAttribute('aria-label')).toBe('双语字幕');
        const key = (name: string) => {const event = new f.window.Event('keydown', {bubbles: true, cancelable: true}); Object.defineProperty(event, 'key', {value: name}); return event;};
        const pageKey = vi.fn(); f.shadow()!.addEventListener('keydown', pageKey);
        const down = key('ArrowDown'); panel.dispatchEvent(down);
        expect(panel.scrollTop).toBe(40); expect(down.defaultPrevented).toBe(true); expect(pageKey).not.toHaveBeenCalled();
        const selectDown = key('ArrowDown'); f.shadow()!.querySelector('select')!.dispatchEvent(selectDown);
        expect(panel.scrollTop).toBe(40); expect(selectDown.defaultPrevented).toBe(false); expect(pageKey).not.toHaveBeenCalled();
        measure.mockClear(); await vi.advanceTimersByTimeAsync(1000); expect(measure).not.toHaveBeenCalled();
        f.config.videoSubtitleAppearance.readingAnnotation = false; f.change();
        expect(panel.dataset.fluentReadSubtitleScrollable).toBeUndefined(); expect(panel.hasAttribute('tabindex')).toBe(false);
        expect(panel.scrollTop).toBe(0); expect(panel.style.fontSize).toBe('100px'); expect(panel.getAttribute('role')).toBe('region');
        f.config.videoSubtitleAppearance.readingAnnotation = true; f.change(); await vi.advanceTimersByTimeAsync(0);
        expect(panel.dataset.fluentReadSubtitleScrollable).toBe('true'); expect(readingPort.annotate).toHaveBeenCalledOnce();
        dispose(); panel.scrollTop = 0; const removedDown = key('ArrowDown'); panel.dispatchEvent(removedDown);
        expect(panel.scrollTop).toBe(0); expect(removedDown.defaultPrevented).toBe(false);
    });

    it('换句、停用、切会议和卸载拒绝迟到读音，失败独立于翻译且能重新开启', async () => {
        let firstFinish!: (value: {text: string; language: string; scheme: string}) => void;
        readingPort.annotate.mockImplementationOnce(() => new Promise(resolve => {firstFinish = resolve;}));
        const f = fixture('https://teams.microsoft.com/v2/', '<span data-tid="closed-caption-text">最初の文。</span>');
        f.config.from = 'ja'; f.config.videoSubtitleAppearance.readingAnnotation = true;
        const dispose = f.start(); await vi.advanceTimersByTimeAsync(0);
        const firstSignal = readingPort.annotate.mock.calls[0][2] as AbortSignal;
        f.document.querySelector('span')!.textContent = '次の文。'; await vi.advanceTimersByTimeAsync(300);
        expect(firstSignal.aborted).toBe(true);
        expect(f.shadow()?.querySelector('.reading')?.textContent).toBe('Reading: 次の文。');
        firstFinish({text: '遅れた読み', language: 'ja', scheme: 'fixture'}); await vi.advanceTimersByTimeAsync(0);
        expect(f.shadow()?.querySelector('.reading')?.textContent).toBe('Reading: 次の文。');
        f.config.videoSubtitleAppearance.readingAnnotation = false; f.change();
        readingPort.annotate.mockRejectedValueOnce(new Error('dictionary unavailable'));
        f.document.querySelector('span')!.textContent = '最後の文。'; f.config.videoSubtitleAppearance.readingAnnotation = true; f.change();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.shadow()?.querySelector<HTMLElement>('.reading')?.hidden).toBe(true);
        expect(f.shadow()?.querySelector('.translation')?.textContent).toBe('测试译文');
        f.config.videoSubtitleAppearance.readingAnnotation = false; f.change();
        f.config.videoSubtitleAppearance.readingAnnotation = true; f.change(); await vi.advanceTimersByTimeAsync(0);
        expect(f.shadow()?.querySelector('.reading')?.textContent).toBe('Reading: 最後の文。');
        const count = readingPort.annotate.mock.calls.length;
        Object.defineProperty(f.window, 'location', {value: new URL('https://teams.microsoft.com/v2/another'), configurable: true});
        await vi.advanceTimersByTimeAsync(300); expect(readingPort.annotate).toHaveBeenCalledTimes(count + 1);
        dispose(); const after = readingPort.annotate.mock.calls.length;
        await vi.advanceTimersByTimeAsync(500); expect(readingPort.annotate).toHaveBeenCalledTimes(after);
        expect(f.document.getElementById('fluent-read-platform-captions')).toBeNull();
    });
});

describe('网页会议字幕生命周期', () => {
    it('失败句在退避期重新出现时保留失败反馈与重试入口，主动重试可恢复', async () => {
        const translate = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('重试成功');
        const f = fixture('https://meet.google.com/abc-defg-hij', `<span data-caption-text>${sentence}</span>`, translate);
        const native = f.document.querySelector('span')!;
        const dispose = f.start(); await vi.advanceTimersByTimeAsync(0);
        const retry = f.shadow()!.querySelector<HTMLButtonElement>('button')!;
        expect(retry.hidden).toBe(false);
        expect(f.shadow()!.querySelector('.translation')!.textContent).toBe('这句翻译失败');
        native.textContent = 'A different participant is speaking.'; await vi.advanceTimersByTimeAsync(300);
        native.textContent = sentence; await vi.advanceTimersByTimeAsync(300);
        expect(translate).toHaveBeenCalledTimes(2);
        expect(retry.hidden).toBe(false);
        expect(f.shadow()!.querySelector('.translation')!.textContent).toBe('这句翻译失败');
        retry.click(); await vi.advanceTimersByTimeAsync(100);
        expect(translate).toHaveBeenCalledTimes(3);
        expect(retry.hidden).toBe(true);
        expect(f.shadow()!.querySelector('.translation')!.textContent).toBe('重试成功');
        dispose();
    });

    it.each([
        ['https://meet.google.com/abc-defg-hij', '<span class="ygicle VbkSUe">'],
        ['https://teams.microsoft.com/v2/', '<span data-tid="closed-caption-text">'],
        ['https://us02web.zoom.us/wc/1/join', '<span class="live-transcription-subtitle__item">'],
    ])('在 %s 翻译、换句、关闭、恢复且不改字幕文本', async (url, open) => {
        const f = fixture(url, `${open}${sentence}</span>`), native = f.document.querySelector('span')!;
        native.style.setProperty('visibility', 'visible', 'important');
        f.start(); await vi.advanceTimersByTimeAsync(100);
        expect(f.shadow()?.querySelector('.translation')?.textContent).toBe('测试译文');
        expect(native.textContent).toBe(sentence); expect(native.style.visibility).toBe('hidden');
        native.textContent = 'Now another participant is speaking.'; await vi.advanceTimersByTimeAsync(300);
        expect(f.shadow()?.querySelector('.source')?.textContent).toBe(native.textContent);
        f.config.videoSubtitleVisible = false; f.change();
        expect(native.style.visibility).toBe('visible'); expect(native.style.getPropertyPriority('visibility')).toBe('important');
        expect(f.document.getElementById('fluent-read-platform-captions')?.hidden).toBe(true);
        f.config.videoSubtitleVisible = true; f.change(); await vi.advanceTimersByTimeAsync(100);
        expect(f.shadow()?.querySelector('.translation')?.textContent).toBe('测试译文');
        expect(f.document.querySelectorAll('#fluent-read-platform-captions')).toHaveLength(1);
    });

    it('自动开启明确字幕控件只点击一次，关闭插件恢复；原先已开启的不操作', async () => {
        const f = fixture('https://meet.google.com/abc-defg-hij', '<button aria-label="Turn on captions"></button>');
        const button = f.document.querySelector('button')!;
        const click = vi.fn(() => button.setAttribute('aria-label', button.getAttribute('aria-label') === 'Turn on captions' ? 'Turn off captions' : 'Turn on captions'));
        button.addEventListener('click', click);
        const dispose = f.start(); await vi.advanceTimersByTimeAsync(1000);
        expect(click).toHaveBeenCalledTimes(1);
        f.config.videoTranslationEnabled = false; f.change(); expect(click).toHaveBeenCalledTimes(2);
        dispose();
        const manual = fixture('https://meet.google.com/abc-defg-hij', '<button aria-label="Turn off captions"></button>');
        const manualClick = vi.fn(); manual.document.querySelector('button')!.addEventListener('click', manualClick);
        manual.start()(); expect(manualClick).not.toHaveBeenCalled();
    });

    it('自动开关关闭时仍可翻译手动开启字幕，不操作禁用和隐藏控件', async () => {
        const f = fixture('https://meet.google.com/abc-defg-hij', `<button aria-label="Turn on captions"></button><span data-caption-text>${sentence}</span>`);
        const click = vi.fn(); f.document.querySelector('button')!.addEventListener('click', click);
        f.config.videoMeetingAutoEnabled = false; f.start(); await vi.advanceTimersByTimeAsync(100);
        expect(click).not.toHaveBeenCalled(); expect(f.translate).toHaveBeenCalledOnce();
        f.config.videoMeetingAutoEnabled = true;
        f.window.getComputedStyle = () => ({display: 'none', visibility: 'hidden'}) as CSSStyleDeclaration;
        f.change(); expect(click).not.toHaveBeenCalled();
    });

    it('用户手动关闭再开启后，停用插件保留用户选择的原生字幕状态', async () => {
        const f = fixture('https://meet.google.com/abc-defg-hij', '<button aria-label="Turn on captions"></button>');
        const button = f.document.querySelector('button')!;
        button.addEventListener('click', () => button.setAttribute('aria-label', button.getAttribute('aria-label') === 'Turn on captions' ? 'Turn off captions' : 'Turn on captions'));
        const dispose = f.start();
        expect(button.getAttribute('aria-label')).toBe('Turn off captions');
        for (let i = 0; i < 2; i++) {
            const click = new f.window.Event('click', {bubbles: true});
            Object.defineProperty(click, 'isTrusted', {value: true});
            button.dispatchEvent(click);
            await vi.advanceTimersByTimeAsync(300);
            expect(button.getAttribute('aria-label')).toBe(i === 0 ? 'Turn on captions' : 'Turn off captions');
        }
        dispose();
        expect(button.getAttribute('aria-label')).toBe('Turn off captions');
    });

    it('Teams 会议菜单按更多操作、语言和语音、字幕开启顺序只执行一次', async () => {
        const f = fixture('https://teams.cloud.microsoft/v2/', '<button id="callingButtons-showMoreBtn" aria-expanded="false">More actions</button>');
        const actions: string[] = [];
        f.document.getElementById('callingButtons-showMoreBtn')!.addEventListener('click', () => {
            actions.push('more');
            f.document.getElementById('callingButtons-showMoreBtn')!.setAttribute('aria-expanded', 'true');
            const language = f.document.createElement('div'); language.setAttribute('role', 'menuitem'); language.textContent = 'Language and speech';
            language.addEventListener('click', () => {
                actions.push('language'); language.remove();
                const enable = f.document.createElement('button'); enable.dataset.tid = 'closed-caption-button'; enable.textContent = 'Turn on live captions';
                enable.addEventListener('click', () => {
                    actions.push('captions'); enable.textContent = 'Turn off live captions';
                    const caption = f.document.createElement('span'); caption.dataset.tid = 'closed-caption-text'; caption.textContent = sentence;
                    f.document.body.appendChild(caption);
                });
                f.document.body.appendChild(enable);
            });
            f.document.body.appendChild(language);
        });
        f.start(); await vi.advanceTimersByTimeAsync(1200);
        expect(actions).toEqual(['more', 'language', 'captions']);
        expect(f.shadow()?.querySelector('.translation')?.textContent).toBe('测试译文');
    });

    it('逐词连续变化有界更新；晚到的上句结果和关闭后的结果不会写回', async () => {
        let finish!: (text: string) => void;
        const translate = vi.fn().mockImplementationOnce(() => new Promise<string>(yes => { finish = yes; })).mockResolvedValue('新的译文');
        const f = fixture('https://teams.live.com/meet/1', `<span data-tid="closed-caption-text">${sentence}</span>`, translate);
        const native = f.document.querySelector('span')!;
        const dispose = f.start(); await vi.advanceTimersByTimeAsync(0);
        native.textContent = 'Another sentence about the project.'; await vi.advanceTimersByTimeAsync(300);
        expect(f.shadow()?.querySelector('.translation')?.textContent).toBe('新的译文');
        finish('过期译文'); await vi.advanceTimersByTimeAsync(1);
        expect(f.shadow()?.querySelector('.translation')?.textContent).toBe('新的译文');
        dispose(); expect(f.document.getElementById('fluent-read-platform-captions')).toBeNull();
        expect(native.style.getPropertyValue('visibility')).toBe('');
        const count = translate.mock.calls.length;
        native.textContent = 'Changed after disposal'; await vi.advanceTimersByTimeAsync(1000);
        expect(translate).toHaveBeenCalledTimes(count);
    });

    it('原文模式、同语言、失败重试与显示菜单复用配置端口', async () => {
        const translate = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('重试译文');
        const f = fixture('https://teams.microsoft.com/v2/', `<span data-tid="closed-caption-text">${sentence}</span>`, translate);
        f.start(); await vi.advanceTimersByTimeAsync(100);
        expect(f.shadow()?.querySelector('.translation')?.textContent).toBe('这句翻译失败');
        f.shadow()?.querySelector('button')!.click(); await vi.advanceTimersByTimeAsync(100);
        expect(f.shadow()?.querySelector('.translation')?.textContent).toBe('重试译文');
        const select = f.shadow()!.querySelector('select')!;
        select.value = 'original-only'; select.dispatchEvent(new f.window.Event('change'));
        expect(f.patch).toHaveBeenLastCalledWith({videoSubtitleDisplayMode: 'original-only'});
        await vi.advanceTimersByTimeAsync(100); expect(f.shadow()?.querySelector('.translation')?.textContent).toBe('');
        select.value = 'off'; select.dispatchEvent(new f.window.Event('change'));
        expect(f.config.videoSubtitleVisible).toBe(false);
        const same = fixture('https://meet.google.com/abc-defg-hij', '<span data-caption-text>这是当前会议的中文字幕内容。</span>');
        same.start(); await vi.advanceTimersByTimeAsync(100);
        expect(same.translate).not.toHaveBeenCalled(); expect(same.shadow()?.querySelector('.translation')?.textContent).toBe('');
        same.config.videoSubtitleDisplayMode = 'translation-only'; same.change(); await vi.advanceTimersByTimeAsync(100);
        expect(same.shadow()?.querySelector<HTMLElement>('.source')?.hidden).toBe(true);
        expect(same.shadow()?.querySelector('.translation')?.textContent).toBe('这是当前会议的中文字幕内容。');
    });

    it('动态节点、空档、换会议、全屏和宿主修改后保持所有权', async () => {
        const f = fixture('https://meet.google.com/abc-defg-hij', '<div id="fullscreen"></div>');
        const dispose = f.start();
        const native = f.document.createElement('span'); native.dataset.captionText = ''; native.textContent = sentence;
        f.document.body.appendChild(native); await vi.advanceTimersByTimeAsync(300);
        expect(f.shadow()?.querySelector('.translation')?.textContent).toBe('测试译文');
        Object.defineProperty(f.document, 'fullscreenElement', {configurable: true, value: f.document.getElementById('fullscreen')});
        f.document.dispatchEvent(new f.window.Event('fullscreenchange')); await vi.advanceTimersByTimeAsync(100);
        expect(f.document.getElementById('fluent-read-platform-captions')?.parentElement?.id).toBe('fullscreen');
        native.textContent = ''; await vi.advanceTimersByTimeAsync(300);
        expect(f.document.getElementById('fluent-read-platform-captions')?.hidden).toBe(true);
        expect(native.style.getPropertyValue('visibility')).toBe('');
        native.textContent = sentence; f.window.location.href = 'https://meet.google.com/xxx-yyyy-zzz'; await vi.advanceTimersByTimeAsync(300);
        expect(f.translate).toHaveBeenCalledTimes(2);
        native.style.setProperty('visibility', 'collapse'); dispose();
        expect(native.style.getPropertyValue('visibility')).toBe('collapse');
    });
});

function videoFixture(url: string, translate?: Mock) {
    const f = fixture(url, `<div class="video-player"><video src="one.mp4"></video><span data-purpose="captions-cue-text">${sentence}</span></div>`, translate);
    const video = f.document.querySelector('video')! as unknown as HTMLVideoElement;
    video.getBoundingClientRect = () => ({left: 50, top: 50, width: 800, height: 450}) as DOMRect;
    Object.assign(video, {currentTime: 1, paused: true, ended: false, seeking: false});
    const source = {kind: 'subtitles', language: 'en', label: 'English', mode: 'showing', cues: [{startTime: 0, endTime: 2, text: sentence}]} as unknown as TextTrack;
    const target = {kind: 'subtitles', language: 'zh-CN', label: 'Chinese', mode: 'disabled', cues: [{startTime: 0, endTime: 2, text: '人工字幕'}]} as unknown as TextTrack;
    Object.defineProperty(video, 'textTracks', {value: [source, target], configurable: true});
    return {...f, video, source, target};
}

function courseFixture(platform: 'bilibili' | 'udemy' | 'edx') {
    const url = {bilibili: 'https://www.bilibili.com/video/BV1xx411c7mD/?p=1',
        udemy: 'https://business.udemy.com/course/demo/learn/lecture/123/', edx: 'https://courses.edx.org/courseware/unit'}[platform];
    const metadata = JSON.stringify({transcriptLanguage: 'en', transcriptTranslationUrl: '/transcript/__lang__'});
    const html = platform === 'bilibili' ? '<main class="bpx-player-container"><video src="one.mp4"></video><div class="bpx-player-subtitle-wrap">Native caption</div><div class="bpx-player-control-bottom-right"></div></main>'
        : platform === 'udemy' ? '<main data-purpose="shaka-video-player"><video src="one.mp4"></video><div data-purpose="captions-cue-text">Machine translated caption</div><div data-purpose="video-control-bar"></div></main>'
        : `<main class="video" data-block-id="first" data-metadata='${metadata}'><video src="one.mp4"></video><div class="closed-captions">Native caption</div><div class="secondary-controls"></div></main>`;
    const f = fixture(url, html);
    const video = f.document.querySelector('video')! as unknown as HTMLVideoElement;
    video.getBoundingClientRect = () => ({left: 50, top: 50, width: 800, height: 450}) as DOMRect;
    Object.assign(video, {currentTime: .5, paused: true, ended: false, seeking: false, playbackRate: 1});
    Object.defineProperty(video, 'textTracks', {value: []});
    const source = 'This is the original course sentence.';
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const data = platform === 'bilibili' ? url.includes('hdslb.com') ? {body: [{from: 0, to: 1, content: source}]}
            : {code: 0, data: {cid: 456, subtitle: {subtitles: [{lan: 'en', subtitle_url: '//aisubtitle.hdslb.com/subtitles.json'}]}}}
            : platform === 'udemy' ? url.includes('/courses/') ? {id: 77, locale: {locale: 'en_US'}}
                : {asset: {captions: [{status: 1, source: 'manual', locale_id: 'en_US', url: 'https://captions.udemycdn.com/source.vtt'}]}}
                : {start: [0], end: [1000], text: [source]};
        return platform === 'udemy' && url.includes('udemycdn.com') ? new Response(`WEBVTT\n\n00:00.000 --> 00:01.000\n${source}\n`) : new Response(JSON.stringify(data));
    });
    const download = vi.fn(), manifest = vi.fn(async () => 456);
    Object.assign(f.ports, {captionSource: {fetch, manifest, resources: () => []}, download});
    const menu = () => f.document.getElementById('fluent-read-course-controls')!.shadowRoot!;
    const choose = (value: string) => menu().querySelector<HTMLButtonElement>(`[data-mode="${value}"]`)!.click();
    return {...f, video, fetch, manifest, download, source, menu, choose};
}

describe('完整课程字幕公共挂载', () => {
    it.each(['bilibili', 'udemy', 'edx'] as const)('%s 从完整字幕轨按原时间轴导出双语', async platform => {
        const f = courseFixture(platform);
        f.config.videoCourseAutoStart[platform] = true;
        f.start();
        await vi.advanceTimersByTimeAsync(350);
        const root = f.menu();
        root.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click();
        root.querySelector<HTMLButtonElement>('[data-action="toggle-subtitle-downloads"]')!.click();
        const format = root.querySelector<HTMLSelectElement>('[data-subtitle-format]')!;
        format.value = 'vtt';
        const download = root.querySelector<HTMLButtonElement>('[data-action="download-bilingual-subtitles"]')!;
        expect(download.disabled).toBe(false);
        download.click();
        await vi.advanceTimersByTimeAsync(1);
        expect(f.download).not.toHaveBeenCalled();
        format.value = 'md';
        const confirm = Object.assign(new f.window.Event('click', {bubbles: true, cancelable: true}), {isTrusted: true});
        root.querySelector<HTMLButtonElement>('[data-export-choice="complete"]')!.dispatchEvent(confirm);
        await vi.advanceTimersByTimeAsync(1);
        expect(f.download).toHaveBeenCalledWith(
            expect.stringContaining('00:00:00,000 --> 00:00:01,000'), 'zh-Hans-bilingual',
            [{startMs: 0, durationMs: 1000, text: `${f.source}\n测试译文`}], 'vtt',
        );
    });

    it('B 站中文人工轨排在英文前时显示英中双语，模式切换复用原文而语言变化重新选轨', async () => {
        const f = courseFixture('bilibili');
        const chinese = '这是视频的中文字幕。';
        f.fetch.mockImplementation(async input => {
            const url = String(input);
            return new Response(JSON.stringify(url.includes('hdslb.com')
                ? {body: [{from: 0, to: 1, content: url.includes('/en.json') ? f.source : chinese}]}
                : {code: 0, data: {cid: 456, subtitle: {subtitles: [
                    {lan: 'zh-Hans', subtitle_url: '//aisubtitle.hdslb.com/zh.json'},
                    {lan: 'en-US', subtitle_url: '//aisubtitle.hdslb.com/en.json'},
                ]}}}));
        });
        f.config.from = 'auto';
        const dispose = f.start(); f.choose('bilingual'); await vi.advanceTimersByTimeAsync(350);
        const source = () => f.shadow()!.querySelector<HTMLElement>('.source')!;
        const translated = () => f.shadow()!.querySelector<HTMLElement>('.translation')!;
        expect(source().textContent).toBe(f.source); expect(source().hidden).toBe(false);
        expect(translated().textContent).toBe('测试译文');
        expect(f.translate).toHaveBeenCalledWith(f.source, expect.any(AbortSignal));
        const count = f.fetch.mock.calls.length;
        f.choose('translation-only'); await vi.advanceTimersByTimeAsync(100);
        expect(source().hidden).toBe(true); expect(translated().textContent).toBe('测试译文');
        f.choose('original-only'); await vi.advanceTimersByTimeAsync(100);
        expect(source().hidden).toBe(false); expect(source().textContent).toBe(f.source); expect(translated().textContent).toBe('');
        f.choose('bilingual'); await vi.advanceTimersByTimeAsync(100);
        expect(source().hidden).toBe(false); expect(translated().textContent).toBe('测试译文');
        expect(f.fetch).toHaveBeenCalledTimes(count); expect(f.translate).toHaveBeenCalledOnce();
        f.config.to = 'en'; f.change(); await vi.advanceTimersByTimeAsync(350);
        expect(source().textContent).toBe(chinese);
        f.config.from = 'en'; f.change(); await vi.advanceTimersByTimeAsync(350);
        expect(source().textContent).toBe(f.source);
        f.choose('off'); expect(f.document.getElementById('fluent-read-platform-captions')?.hidden).toBe(true);
        f.config.from = 'auto'; f.config.to = 'zh-Hans'; f.change();
        f.choose('bilingual'); await vi.advanceTimersByTimeAsync(350);
        expect(source().textContent).toBe(f.source); expect(translated().textContent).toBe('测试译文');
        dispose(); expect(f.document.getElementById('fluent-read-platform-captions')).toBeNull();
    });

    it('B 站自动开关默认关闭且不请求，手动开启后严格遵循空档、校时和关闭后的入口', async () => {
        const f = courseFixture('bilibili'); const dispose = f.start();
        expect(f.fetch).not.toHaveBeenCalled(); expect(f.manifest).not.toHaveBeenCalled();
        const button = f.menu().querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!; expect(button.classList.contains('fluent-read-video-subtitle-active')).toBe(false);
        expect(button.querySelector('img')?.getAttribute('src')).toBe('chrome-extension://fixture/icon/128.png');
        expect(button.textContent).toBe('');
        expect(f.menu().querySelector('[data-subtitle-format]')).not.toBeNull();
        expect(f.menu().querySelector<HTMLButtonElement>('[data-action="open-sentence-learning"]')!.disabled).toBe(true);
        button.click(); expect(button.getAttribute('aria-expanded')).toBe('true');
        f.choose('bilingual'); await vi.advanceTimersByTimeAsync(350);
        expect(f.shadow()?.querySelector('.source')?.textContent).toBe(f.source);
        expect(f.shadow()?.querySelector('.translation')?.textContent).toBe('测试译文');
        expect(f.menu().querySelector('[data-mode="bilingual"]')?.getAttribute('aria-checked')).toBe('true'); expect(f.translate).toHaveBeenCalledOnce();
        const native = f.document.querySelector<HTMLElement>('.bpx-player-subtitle-wrap')!;
        expect(native.style.getPropertyValue('visibility')).toBe('hidden');
        f.video.currentTime = 1; await vi.advanceTimersByTimeAsync(300);
        expect(f.document.getElementById('fluent-read-platform-captions')?.hidden).toBe(true);
        expect(native.style.getPropertyValue('visibility')).toBe('');
        f.config.videoSubtitleOffsetMs = 500; f.change(); await vi.advanceTimersByTimeAsync(100);
        expect(f.shadow()?.querySelector('.source')?.textContent).toBe(f.source);
        f.menu().querySelector<HTMLButtonElement>('[data-action="toggle-subtitle-downloads"]')!.click();
        f.menu().querySelector<HTMLButtonElement>('[data-action="download-subtitles"]')!.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.download).toHaveBeenCalledWith(expect.stringContaining('00:00:00,000 --> 00:00:01,000'), 'en', expect.any(Array), 'srt');
        f.choose('off'); expect(f.config.videoSubtitleVisible).toBe(true); expect(f.document.getElementById('fluent-read-course-controls')).not.toBeNull();
        expect(native.style.getPropertyValue('visibility')).toBe('');
        f.choose('original-only'); await vi.advanceTimersByTimeAsync(350);
        expect(f.shadow()?.querySelector('.translation')?.textContent).toBe('');
        expect(f.translate).toHaveBeenCalledOnce();
        f.menu().querySelector<HTMLButtonElement>('[data-action="open-subtitle-tools"]')!.click();
        f.menu().querySelector<HTMLButtonElement>('[data-action="toggle-course-auto"]')!.click();
        expect(f.config.videoCourseAutoStart).toEqual({bilibili: true, udemy: true, edx: false});
        dispose(); expect(f.document.getElementById('fluent-read-course-controls')).toBeNull();
    });

    it('Udemy 原文从完整轨加载，不翻译页面的机器译文；切课取消旧字幕并保留菜单', async () => {
        const f = courseFixture('udemy'); f.start(); await vi.advanceTimersByTimeAsync(350);
        expect(f.shadow()?.querySelector('.source')?.textContent).toBe(f.source);
        expect(f.translate).toHaveBeenCalledWith(f.source, expect.any(AbortSignal));
        const count = f.fetch.mock.calls.length;
        f.window.location.hash = '#overview'; await vi.advanceTimersByTimeAsync(300); expect(f.fetch).toHaveBeenCalledTimes(count);
        f.video.currentTime = .8; await vi.advanceTimersByTimeAsync(300); expect(f.fetch).toHaveBeenCalledTimes(count);
        f.video.currentTime = 2; await vi.advanceTimersByTimeAsync(300);
        f.video.currentTime = .5; await vi.advanceTimersByTimeAsync(300); expect(f.translate).toHaveBeenCalledOnce();
        f.window.location.pathname = '/course/demo/learn/lecture/124/'; f.video.setAttribute('src', 'two.mp4');
        await vi.advanceTimersByTimeAsync(350);
        expect(f.fetch.mock.calls.some(([url]) => String(url).includes('/lectures/124/'))).toBe(true);
        expect(f.document.querySelectorAll('#fluent-read-course-controls')).toHaveLength(1);
        f.config.videoTranslationEnabled = false; f.change(); expect(f.document.getElementById('fluent-read-course-controls')).toBeNull();
        f.config.videoTranslationEnabled = true; f.change(); await vi.advanceTimersByTimeAsync(350);
        expect(f.document.querySelectorAll('#fluent-read-course-controls')).toHaveLength(1);
    });

    it('edX 跟随最后开始播放的视频，暂停保持归属，切字幕语言重新读取', async () => {
        const f = courseFixture('edx'); f.config.videoCourseAutoStart.edx = true;
        const other = f.document.createElement('main'); other.className = 'video'; other.dataset.blockId = 'second';
        other.dataset.metadata = JSON.stringify({transcriptLanguage: 'en', transcriptTranslationUrl: '/second/__lang__'});
        other.innerHTML = '<video src="second.mp4"></video><div class="closed-captions">Other caption</div><div class="secondary-controls"></div><div class="langs-list"><button class="is-active" data-lang-code="en"></button></div>';
        const video = other.querySelector('video') as unknown as HTMLVideoElement;
        Object.assign(video, {currentTime: .5, paused: true, ended: false, seeking: false, playbackRate: 1});
        video.getBoundingClientRect = () => ({left: 50, top: 500, width: 500, height: 281}) as DOMRect;
        Object.defineProperty(video, 'textTracks', {value: []}); f.document.body.appendChild(other);
        f.start(); await vi.advanceTimersByTimeAsync(350);
        video.dispatchEvent(new f.window.Event('play', {bubbles: true})); await vi.advanceTimersByTimeAsync(350);
        expect(f.document.getElementById('fluent-read-course-controls')?.parentElement?.parentElement).toBe(other);
        const count = f.fetch.mock.calls.length; await vi.advanceTimersByTimeAsync(1000); expect(f.fetch).toHaveBeenCalledTimes(count);
        other.querySelector('button')!.setAttribute('data-lang-code', 'es'); await vi.advanceTimersByTimeAsync(350);
        expect(f.fetch.mock.calls.at(-1)![0]).toBe('https://courses.edx.org/second/es');
        other.remove(); await vi.advanceTimersByTimeAsync(350);
        expect(f.document.getElementById('fluent-read-course-controls')?.parentElement?.parentElement?.dataset.blockId).toBe('first');
    });

    it('课程请求失败就地重试；原文模式不调用翻译，切换显示不会重复读取轨道', async () => {
        const f = courseFixture('edx'); f.config.videoCourseAutoStart.edx = true; f.config.videoSubtitleDisplayMode = 'original-only';
        f.fetch.mockRejectedValueOnce(new Error('offline'));
        f.start(); await vi.advanceTimersByTimeAsync(350);
        expect(f.menu().querySelector('[data-source-status]')?.textContent).toContain('失败'); expect(f.translate).not.toHaveBeenCalled();
        f.menu().querySelector<HTMLButtonElement>('[data-action="retry-course-source"]')!.click(); await vi.advanceTimersByTimeAsync(350);
        expect(f.shadow()?.querySelector('.source')?.textContent).toBe(f.source); expect(f.translate).not.toHaveBeenCalled();
        const count = f.fetch.mock.calls.length; f.choose('bilingual'); await vi.advanceTimersByTimeAsync(100);
        expect(f.translate).toHaveBeenCalledOnce(); expect(f.fetch).toHaveBeenCalledTimes(count);
        f.config.uiLanguage = 'en-US'; f.change();
        expect(f.menu().querySelector('.fluent-read-video-menu-source')?.hasAttribute('hidden')).toBe(true);
        expect(f.menu().querySelector('[data-mode="bilingual"]')?.textContent).toBe('Both');
    });

    it('复用播放器菜单的分段按钮和折叠层级，Escape 逐层返回，外部点击关闭', async () => {
        const f = courseFixture('edx'); f.config.videoCourseAutoStart.edx = true;
        f.start(); await vi.advanceTimersByTimeAsync(350);
        const button = f.menu().querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
        const menu = f.menu().querySelector<HTMLElement>('#fluent-read-video-subtitle-menu')!;
        button.click();
        expect(menu.classList.contains('fluent-read-video-subtitle-menu')).toBe(true);
        expect(menu.querySelectorAll('[role="menuitemradio"][data-mode]')).toHaveLength(4);
        expect(menu.querySelector('[data-action="toggle-ai-subtitle"]')).toBeNull();
        expect(menu.querySelector<HTMLButtonElement>('[data-action="open-sentence-learning"]')!.disabled).toBe(false);
        expect(menu.querySelector<HTMLElement>('[data-subtitle-downloads]')!.hidden).toBe(true);
        expect(menu.querySelector<HTMLElement>('.fluent-read-video-menu-tools')!.hidden).toBe(true);
        menu.querySelector<HTMLButtonElement>('[data-action="open-subtitle-tools"]')!.click();
        expect(menu.querySelector<HTMLElement>('.fluent-read-video-menu-tools')!.hidden).toBe(false);
        menu.dispatchEvent(Object.assign(new f.window.Event('keydown', {bubbles: true}), {key: 'Escape'}));
        expect(menu.hidden).toBe(false); expect(menu.dataset.panel).toBe('watch');
        menu.querySelector<HTMLButtonElement>('[data-action="toggle-subtitle-downloads"]')!.click();
        expect(menu.querySelector<HTMLElement>('[data-subtitle-downloads]')!.hidden).toBe(false);
        menu.dispatchEvent(Object.assign(new f.window.Event('keydown', {bubbles: true}), {key: 'Escape'}));
        expect(menu.hidden).toBe(false); expect(menu.querySelector<HTMLElement>('[data-subtitle-downloads]')!.hidden).toBe(true);
        menu.dispatchEvent(Object.assign(new f.window.Event('keydown', {bubbles: true}), {key: 'Escape'})); expect(menu.hidden).toBe(true);
        button.click(); f.document.dispatchEvent(new f.window.Event('pointerdown', {bubbles: true})); expect(menu.hidden).toBe(true);
    });

    it('课程翻译失败在菜单重试，字幕画面保留原文并按原句复用重试结果', async () => {
        const f = courseFixture('edx'); f.config.videoCourseAutoStart.edx = true;
        f.translate.mockRejectedValueOnce(new Error('offline'));
        f.start(); await vi.advanceTimersByTimeAsync(350);
        expect(f.shadow()?.querySelector('.source')?.textContent).toBe(f.source);
        expect(f.shadow()?.querySelector('.translation')?.textContent).toBe('');
        expect(f.shadow()?.querySelector<HTMLElement>('.tools')?.hidden).toBe(true);
        expect(f.menu().querySelector('[data-source-status]')?.textContent).toBe('这句翻译失败');
        f.menu().querySelector<HTMLButtonElement>('[data-action="retry-subtitle-translation"]')!.click();
        await vi.advanceTimersByTimeAsync(350);
        expect(f.shadow()?.querySelector('.translation')?.textContent).toBe('测试译文');
        expect(f.menu().querySelector<HTMLElement>('.fluent-read-video-menu-source')!.hidden).toBe(true);
        expect(f.translate).toHaveBeenCalledTimes(2);
    });

    it.each(['bilibili', 'udemy', 'edx'] as const)('%s 挂到字幕按钮的同一父容器并保持原控件顺序和高度', platform => {
        const f = courseFixture(platform);
        const bar = f.document.querySelector(platform === 'bilibili' ? '.bpx-player-control-bottom-right' : platform === 'udemy' ? '[data-purpose="video-control-bar"]' : '.secondary-controls')!;
        const row = f.document.createElement('div');
        const caption = f.document.createElement('button'), fullscreen = f.document.createElement('button');
        if (platform === 'bilibili') caption.className = 'bpx-player-ctrl-subtitle';
        else if (platform === 'udemy') caption.dataset.purpose = 'captions-dropdown-button';
        else caption.className = 'toggle-captions';
        // B 站悬停命中外框增加留白，可见文字仍是 22px。
        let visualHeight = 40;
        if (platform === 'bilibili') {
            const label = f.document.createElement('span'); label.className = 'bpx-player-ctrl-subtitle-result'; label.textContent = '字幕'; caption.appendChild(label);
            Object.defineProperty(label, 'getBoundingClientRect', {value: () => ({top: 0, height: 22})});
            Object.defineProperty(caption, 'getBoundingClientRect', {value: () => ({top: 0, height: 35})});
            Object.defineProperty(caption, 'offsetHeight', {value: 35}); visualHeight = 22;
        } else Object.defineProperty(caption, 'offsetHeight', {value: visualHeight});
        row.append(caption, fullscreen); bar.appendChild(row); f.start();
        const host = f.document.getElementById('fluent-read-course-controls')!;
        expect(host.parentElement).toBe(row); expect(host.nextSibling).toBe(caption); expect(caption.nextSibling).toBe(fullscreen);
        expect(Number.parseFloat(f.menu().querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.style.height)).toBe(visualHeight);
        expect(host.style.position).not.toBe('absolute');
    });

    it('单语隐藏顺序及说明，读音图标只保留短标题，双语恢复顺序', async () => {
        const f = courseFixture('edx'); f.config.videoCourseAutoStart.edx = true;
        f.config.videoSubtitleDisplayMode = 'original-only'; f.start(); await vi.advanceTimersByTimeAsync(350);
        const order = f.menu().querySelector<HTMLElement>('.fluent-read-video-menu-order-setting')!;
        const reading = f.menu().querySelector<HTMLButtonElement>('[data-action="toggle-reading-annotation"]')!;
        expect(order.hidden).toBe(true);
        expect(f.menu().querySelector('[data-subtitle-order-hint]')).toBeNull();
        expect(f.menu().querySelector('[data-reading-help]')!.hasAttribute('popover')).toBe(false);
        expect(reading.title).toBe(reading.getAttribute('aria-label'));
        expect(reading.hasAttribute('aria-describedby')).toBe(false);
        f.choose('bilingual'); expect(order.hidden).toBe(false);
    });

    it('原生 video 控件不把入口挂到空的伪控制栏', () => {
        const f = courseFixture('bilibili'); f.video.controls = true; f.start();
        const host = f.document.getElementById('fluent-read-course-controls')!;
        expect(host.parentElement).toBe(f.video.parentElement);
        expect(f.document.querySelectorAll('#fluent-read-course-controls')).toHaveLength(1);
    });

    it('退出全屏保留隐藏旧栏时，将同一入口迁入新原生控件所在行', async () => {
        const f = courseFixture('bilibili');
        const old = f.document.querySelector<HTMLElement>('.bpx-player-control-bottom-right')!;
        const caption = f.document.createElement('button'); caption.className = 'bpx-player-ctrl-subtitle'; old.appendChild(caption);
        f.start(); const host = f.document.getElementById('fluent-read-course-controls')!;
        const next = f.document.createElement('div'); next.className = old.className; old.after(next);
        next.appendChild(caption); old.style.display = 'none'; await vi.advanceTimersByTimeAsync(350);
        expect(f.document.getElementById('fluent-read-course-controls')).toBe(host);
        expect(host.parentElement).toBe(next); expect(host.nextSibling).toBe(caption);
        expect(f.document.querySelectorAll('#fluent-read-course-controls')).toHaveLength(1);
    });

    it('B 站主视频暂停时，自动播放的推荐预览不能抢走入口', async () => {
        const f = courseFixture('bilibili'); f.video.parentElement!.id = 'bilibili-player'; f.start();
        const preview = f.document.createElement('aside'); preview.className = 'v-recommend-inline-player';
        const root = f.document.createElement('div'); root.className = 'bpx-player-container';
        const clip = f.document.createElement('video') as unknown as HTMLVideoElement;
        clip.getBoundingClientRect = () => ({width: 142, height: 80}) as DOMRect;
        Object.assign(clip, {paused: false, currentTime: .5, ended: false, seeking: false});
        const controls = f.document.createElement('div'); controls.className = 'bpx-player-control-bottom-right';
        root.append(clip, controls); preview.append(root); f.document.body.appendChild(preview);
        clip.dispatchEvent(new f.window.Event('play', {bubbles: true})); await vi.advanceTimersByTimeAsync(500);
        const host = f.document.getElementById('fluent-read-course-controls')!;
        expect(host.closest('#bilibili-player')).toBe(f.video.parentElement);
        expect(preview.querySelector('#fluent-read-course-controls')).toBeNull();
    });
});

describe('Udemy 与 Disney+ 原生人工字幕', () => {
    it('读音优先使用原轨语言，人工译文与读音分别显示且更换媒体清空读音缓存', async () => {
        const f = videoFixture('https://www.udemy.com/course/demo/learn/');
        Object.assign(f.source, {language: 'ja', cues: [{startTime: 0, endTime: 2, text: '今日はいい天気です。'}]});
        f.config.from = 'en'; f.config.videoSubtitleAppearance.readingAnnotation = true;
        f.start(); await vi.advanceTimersByTimeAsync(100);
        expect(readingPort.annotate).toHaveBeenCalledWith('今日はいい天気です。', 'ja', expect.any(AbortSignal));
        expect(f.shadow()?.querySelector('.translation')?.textContent).toBe('人工字幕');
        expect(f.shadow()?.querySelector('.reading')?.textContent).toBe('Reading: 今日はいい天気です。');
        expect(f.shadow()?.querySelector('.reading')?.getAttribute('lang')).toBe('ja-Latn');
        expect(f.shadow()?.querySelector('.reading')?.getAttribute('aria-label')).toBe('日语罗马音');
        f.video.setAttribute('src', 'two.mp4'); await vi.advanceTimersByTimeAsync(300);
        expect(readingPort.annotate).toHaveBeenCalledTimes(2);
        expect(f.translate).not.toHaveBeenCalled();
    });

    it.each(['https://www.udemy.com/course/demo/learn/', 'https://www.disneyplus.com/video/demo'])('在 %s 优先人工轨，不请求服务并恢复轨道模式', async url => {
        const f = videoFixture(url); const dispose = f.start(); await vi.advanceTimersByTimeAsync(100);
        expect(f.shadow()?.querySelector('.source')?.textContent).toBe(sentence);
        expect(f.shadow()?.querySelector('.translation')?.textContent).toBe('人工字幕');
        expect(f.translate).not.toHaveBeenCalled(); expect(f.target.mode).toBe('hidden'); expect(f.source.mode).toBe('hidden');
        f.config.videoPreferHumanSubtitles = false; f.change(); await vi.advanceTimersByTimeAsync(100);
        expect(f.shadow()?.querySelector('.translation')?.textContent).toBe('测试译文');
        expect(f.target.mode).toBe('disabled'); dispose(); expect(f.source.mode).toBe('showing');
    });

    it('人工字幕空档回退翻译；视频空档、拖动和换片不留旧句', async () => {
        const f = videoFixture('https://www.udemy.com/course/demo/learn/');
        f.target.cues![0].startTime = 1.5;
        f.start(); await vi.advanceTimersByTimeAsync(100);
        expect(f.shadow()?.querySelector('.translation')?.textContent).toBe('测试译文');
        f.video.currentTime = 1.6; await vi.advanceTimersByTimeAsync(250);
        expect(f.shadow()?.querySelector('.translation')?.textContent).toBe('人工字幕');
        Object.assign(f.video, {seeking: true}); await vi.advanceTimersByTimeAsync(250);
        expect(f.document.getElementById('fluent-read-platform-captions')?.hidden).toBe(true);
        Object.assign(f.video, {seeking: false}); f.video.setAttribute('src', 'two.mp4'); f.target.cues![0].endTime = 3;
        await vi.advanceTimersByTimeAsync(250); expect(f.shadow()?.querySelector('.translation')?.textContent).toBe('人工字幕');
        f.document.querySelector('span')!.textContent = ''; f.video.currentTime = 4;
        await vi.advanceTimersByTimeAsync(250); expect(f.document.getElementById('fluent-read-platform-captions')?.hidden).toBe(true);
    });

    it('没有可读轨道时从字幕 DOM 回退，结束时恢复，非目标页不挂载', async () => {
        const f = videoFixture('https://www.udemy.com/course/demo/learn/');
        Object.defineProperty(f.video, 'textTracks', {value: []});
        const dispose = f.start(); await vi.advanceTimersByTimeAsync(100);
        expect(f.shadow()?.querySelector('.translation')?.textContent).toBe('测试译文');
        Object.assign(f.video, {ended: true}); await vi.advanceTimersByTimeAsync(250);
        expect(f.document.querySelector('span')!.style.getPropertyValue('visibility')).toBe(''); dispose();
        const unknown = fixture('https://example.com/', '<span data-caption-text>Unrelated text</span>'); unknown.start()();
        expect(unknown.document.getElementById('fluent-read-platform-captions')).toBeNull();
    });

    it('多视频只读取当前播放器字幕，卸载保留用户后来选择的轨道模式', async () => {
        const f = videoFixture('https://www.udemy.com/course/demo/learn/');
        Object.defineProperty(f.video, 'textTracks', {value: []});
        const other = f.document.createElement('div'); other.className = 'video-player';
        other.innerHTML = '<video></video><span data-purpose="captions-cue-text">Unrelated recommendation caption.</span>';
        const otherVideo = other.querySelector('video')! as unknown as HTMLVideoElement;
        otherVideo.getBoundingClientRect = () => ({width: 300, height: 180}) as DOMRect;
        Object.assign(otherVideo, {paused: true, ended: false, seeking: false});
        f.document.body.appendChild(other);
        f.start(); await vi.advanceTimersByTimeAsync(100);
        expect(f.shadow()?.querySelector('.source')?.textContent).toBe(sentence);
        expect(other.querySelector('span')!.style.getPropertyValue('visibility')).toBe('');
        const native = videoFixture('https://www.disneyplus.com/video/demo'); const dispose = native.start();
        await vi.advanceTimersByTimeAsync(100); native.target.mode = 'showing'; dispose();
        expect(native.target.mode).toBe('showing'); expect(native.source.mode).toBe('showing');
    });
});

describe('平台字幕布局操作预算与失效边界', () => {
    it('64 个视频每轮各测量一次，优先播放中视频且复用所选尺寸定位字幕', async () => {
        const f = videoFixture('https://www.udemy.com/course/demo/learn/');
        Object.defineProperty(f.video, 'textTracks', {value: []});
        const measurements = [vi.fn(() => ({left: 50, top: 50, width: 2000, height: 1200}) as DOMRect)];
        f.video.getBoundingClientRect = measurements[0];
        for (let index = 1; index < 64; index += 1) {
            const player = f.document.createElement('div'); player.className = 'video-player';
            player.innerHTML = `<video src="${index}.mp4"></video><span data-purpose="captions-cue-text">Caption from player ${index}.</span>`;
            const video = player.querySelector('video')! as unknown as HTMLVideoElement;
            Object.assign(video, {paused: index !== 11 && index !== 23, ended: false, seeking: false, currentTime: 1});
            const measure = vi.fn(() => ({left: index, top: 20, width: 100 + index, height: 100}) as DOMRect);
            video.getBoundingClientRect = measure; measurements.push(measure);
            f.document.body.appendChild(player);
        }
        f.start();
        expect(measurements.map(measure => measure.mock.calls.length)).toEqual(Array(64).fill(1));
        expect(f.shadow()?.querySelector('.source')?.textContent).toBe('Caption from player 23.');
        expect(f.document.getElementById('fluent-read-platform-captions')?.style.width).toBe('118.08px');
        await vi.advanceTimersByTimeAsync(100);
        measurements.forEach(measure => measure.mockClear());
        await vi.advanceTimersByTimeAsync(1000);
        expect(measurements.map(measure => measure.mock.calls.length)).toEqual(Array(64).fill(4));
    });

    it('尺寸相同时保持 DOM 顺序，隐藏祖先与零尺寸视频不参与选择', () => {
        const f = videoFixture('https://www.udemy.com/course/demo/learn/');
        Object.defineProperty(f.video, 'textTracks', {value: []});
        for (const [attribute, width] of [['', 800], ['hidden', 2000], ['aria-hidden="true"', 2000], ['', 0]] as const) {
            const player = f.document.createElement('div'); player.className = 'video-player';
            player.innerHTML = `<video></video><span data-purpose="captions-cue-text">Other caption.</span>`;
            if (attribute === 'hidden') player.hidden = true;
            if (attribute.startsWith('aria')) player.setAttribute('aria-hidden', 'true');
            const video = player.querySelector('video')! as unknown as HTMLVideoElement;
            Object.assign(video, {paused: attribute === '' && width > 0, ended: false, seeking: false});
            video.getBoundingClientRect = () => ({width, height: 450}) as DOMRect;
            f.document.body.appendChild(player);
        }
        f.start();
        expect(f.shadow()?.querySelector('.source')?.textContent).toBe(sentence);
    });

    it('稳定长字幕每秒保留四次位置读取，但不写样式、替换文本或重复测量高度', async () => {
        const f = videoFixture('https://www.udemy.com/course/demo/learn/');
        const measureVideo = vi.fn(f.video.getBoundingClientRect);
        f.video.getBoundingClientRect = measureVideo;
        f.start(); await vi.advanceTimersByTimeAsync(100);
        const host = f.document.getElementById('fluent-read-platform-captions')!;
        const panel = f.shadow()!.querySelector<HTMLElement>('.panel')!;
        const source = f.shadow()!.querySelector('.source')!;
        const measureHeight = vi.fn(() => Number.parseFloat(panel.style.fontSize) * 5 + 16);
        Object.defineProperty(panel, 'scrollHeight', {get: measureHeight});
        const panelWrite = vi.spyOn(panel.style, 'setProperty');
        f.config.videoSubtitleAppearance.fontScale = 500; f.change();
        expect(measureHeight).toHaveBeenCalledTimes(10);
        expect(panelWrite.mock.calls.filter(([property]) => property === 'font-size')).toHaveLength(11);
        expect(measureHeight()).toBeLessThanOrEqual(378);
        const requestedFontScale = f.config.videoSubtitleAppearance.fontScale;
        const sourceNode = source.firstChild;
        const hostWrite = vi.spyOn(host.style, 'setProperty');
        const nativeWrite = vi.spyOn(f.document.querySelector('span')!.style, 'setProperty');
        measureHeight.mockClear(); panelWrite.mockClear(); measureVideo.mockClear();
        await vi.advanceTimersByTimeAsync(1000);
        expect(measureVideo).toHaveBeenCalledTimes(4);
        expect(measureHeight).not.toHaveBeenCalled();
        expect(panelWrite).not.toHaveBeenCalled(); expect(hostWrite).not.toHaveBeenCalled(); expect(nativeWrite).not.toHaveBeenCalled();
        expect(source.firstChild).toBe(sourceNode);
        expect(f.config.videoSubtitleAppearance.fontScale).toBe(requestedFontScale);
    });

    it('播放器移动更新坐标，宽高、外观、全屏和字体加载分别重新适配并清理监听', async () => {
        const f = videoFixture('https://www.udemy.com/course/demo/learn/');
        let bounds = {left: 50, top: 50, width: 800, height: 450};
        f.video.getBoundingClientRect = () => bounds as DOMRect;
        const fonts = new f.window.EventTarget();
        Object.defineProperty(f.document, 'fonts', {value: fonts});
        const removeFontListener = vi.spyOn(fonts, 'removeEventListener');
        const dispose = f.start(); await vi.advanceTimersByTimeAsync(100);
        const host = f.document.getElementById('fluent-read-platform-captions')!;
        const panel = f.shadow()!.querySelector<HTMLElement>('.panel')!;
        const measureHeight = vi.fn(() => Number.parseFloat(panel.style.fontSize) * 5 + 16);
        Object.defineProperty(panel, 'scrollHeight', {get: measureHeight});
        f.config.videoSubtitleAppearance.fontScale = 500; f.change(); measureHeight.mockClear();
        bounds = {...bounds, left: 90, top: 70}; await vi.advanceTimersByTimeAsync(250);
        expect(host.style.left).toBe('106px'); expect(host.style.top).toBe('475px');
        expect(measureHeight).not.toHaveBeenCalled();
        bounds = {...bounds, width: 600}; await vi.advanceTimersByTimeAsync(250);
        expect(host.style.width).toBe('576px'); expect(measureHeight).toHaveBeenCalledTimes(10); measureHeight.mockClear();
        bounds = {...bounds, height: 700}; await vi.advanceTimersByTimeAsync(250);
        expect(panel.style.maxHeight).toBe('588px'); expect(panel.style.fontSize).toBe('100px');
        expect(measureHeight).toHaveBeenCalledTimes(1); measureHeight.mockClear();
        for (const change of [() => { f.config.videoSubtitleAppearance.skin = 'paper'; },
            () => { f.config.videoSubtitleAppearance.lineSpacing = 1.6; },
            () => { f.config.videoSubtitleAppearance.fontScale = 450; },
            () => { f.config.videoSubtitleDisplayMode = 'translation-only'; }]) {
            change(); f.change(); expect(measureHeight).toHaveBeenCalledTimes(1); measureHeight.mockClear();
        }
        expect(host.style.getPropertyValue('--fluent-read-video-subtitle-font-family')).toBe('Georgia, serif');
        const fullscreen = f.document.createElement('div'); f.document.body.appendChild(fullscreen);
        Object.defineProperty(f.document, 'fullscreenElement', {configurable: true, value: fullscreen});
        f.document.dispatchEvent(new f.window.Event('fullscreenchange')); await vi.advanceTimersByTimeAsync(100);
        expect(host.parentElement).toBe(fullscreen); expect(measureHeight).toHaveBeenCalledTimes(1); measureHeight.mockClear();
        fonts.dispatchEvent(new f.window.Event('loadingdone')); await vi.advanceTimersByTimeAsync(100);
        expect(measureHeight).toHaveBeenCalledTimes(1); measureHeight.mockClear();
        dispose(); expect(removeFontListener).toHaveBeenCalledWith('loadingdone', expect.any(Function));
        fonts.dispatchEvent(new f.window.Event('loadingdone')); await vi.advanceTimersByTimeAsync(1000);
        expect(measureHeight).not.toHaveBeenCalled(); expect(f.document.getElementById(host.id)).toBeNull();
    });

    it('清空后相同字幕再次出现重新适配，异步译文使用到达时的最新高度', async () => {
        let finish!: (text: string) => void;
        const translate = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
        const f = videoFixture('https://www.udemy.com/course/demo/learn/', translate);
        f.config.videoPreferHumanSubtitles = false;
        let bounds = {left: 50, top: 50, width: 800, height: 450};
        f.video.getBoundingClientRect = () => bounds as DOMRect;
        f.start(); await vi.advanceTimersByTimeAsync(100);
        const panel = f.shadow()!.querySelector<HTMLElement>('.panel')!;
        const measureHeight = vi.fn(() => Number.parseFloat(panel.style.fontSize) * (f.shadow()!.querySelector('.translation')!.textContent ? 8 : 3) + 16);
        Object.defineProperty(panel, 'scrollHeight', {get: measureHeight});
        f.config.videoSubtitleAppearance.fontScale = 500; f.change(); measureHeight.mockClear();
        bounds = {...bounds, height: 700}; await vi.advanceTimersByTimeAsync(250); measureHeight.mockClear();
        finish('到达时需要两行的大字号译文'); await vi.advanceTimersByTimeAsync(0);
        expect(measureHeight).toHaveBeenCalledTimes(10); expect(measureHeight()).toBeLessThanOrEqual(588);
        expect(Number.parseFloat(panel.style.fontSize)).toBeGreaterThan(60);
        measureHeight.mockClear(); f.video.currentTime = 3; await vi.advanceTimersByTimeAsync(250);
        expect(f.document.getElementById('fluent-read-platform-captions')?.hidden).toBe(true);
        f.video.currentTime = 1; await vi.advanceTimersByTimeAsync(250);
        expect(f.shadow()?.querySelector('.translation')?.textContent).toBe('到达时需要两行的大字号译文');
        // 同步命中缓存直接写入译文并只执行一次排版测量，消除原先空闪导致的额外 1 次测量。
        expect(measureHeight).toHaveBeenCalledTimes(10);
        measureHeight.mockClear(); await vi.advanceTimersByTimeAsync(1000); expect(measureHeight).not.toHaveBeenCalled();
    });

    it('失败文字和重试工具到达后重新适配，重试成功收起工具并稳定复用布局', async () => {
        let fail!: (reason: Error) => void, finish!: (text: string) => void;
        const translate = vi.fn().mockImplementationOnce(() => new Promise<string>((_, reject) => { fail = reject; }))
            .mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
        const f = videoFixture('https://www.disneyplus.com/video/demo', translate);
        f.config.videoPreferHumanSubtitles = false;
        f.start(); await vi.advanceTimersByTimeAsync(100);
        const panel = f.shadow()!.querySelector<HTMLElement>('.panel')!;
        const retry = f.shadow()!.querySelector('button')!;
        const measureHeight = vi.fn(() => Number.parseFloat(panel.style.fontSize) * (retry.hidden ? 3 : 6) + 16);
        Object.defineProperty(panel, 'scrollHeight', {get: measureHeight});
        f.config.videoSubtitleAppearance.fontScale = 500; f.change(); measureHeight.mockClear();
        fail(new Error('offline')); await vi.advanceTimersByTimeAsync(0);
        expect(retry.hidden).toBe(false); expect(f.shadow()?.querySelector('.translation')?.textContent).toBe('这句翻译失败');
        expect(measureHeight).toHaveBeenCalledTimes(10); expect(measureHeight()).toBeLessThanOrEqual(378); measureHeight.mockClear();
        await vi.advanceTimersByTimeAsync(1000); expect(measureHeight).not.toHaveBeenCalled();
        retry.click(); await vi.advanceTimersByTimeAsync(100);
        expect(retry.hidden).toBe(true); expect(measureHeight).toHaveBeenCalledTimes(1); measureHeight.mockClear();
        finish('重试成功'); await vi.advanceTimersByTimeAsync(0);
        expect(f.shadow()?.querySelector('.translation')?.textContent).toBe('重试成功');
        expect(panel.style.fontSize).toBe('100px'); expect(measureHeight).toHaveBeenCalledTimes(1); measureHeight.mockClear();
        await vi.advanceTimersByTimeAsync(1000); expect(measureHeight).not.toHaveBeenCalled();
    });
});


describe('B 站无字幕本地识别接入', () => {
    function aiFixture() {
        const f = courseFixture('bilibili');
        Object.defineProperty(f.video, 'readyState', {value: 4, configurable: true});
        const send = vi.fn(async () => ({success: true, models: ['small']}));
        f.config.videoLocalModel = 'small';
        Object.assign(f.ports, {createBilibiliAi: (getVideo: () => HTMLVideoElement | null, changed: () => void) => new BilibiliAiSource({
            send, getVideo, changed, getAudio: async () => new Float32Array(), getModel: () => f.config.videoLocalModel,
            getLanguage: () => f.config.videoSourceLanguage, getProvider: () => f.config.videoTranscriptionProvider,
            getNativeBaseUrl: () => f.config.videoNativeAsrBaseUrl,
        })});
        f.fetch.mockImplementation(async () => new Response(JSON.stringify({code: 0, data: {cid: 456, subtitle: {subtitles: []}}})));
        const generate = () => f.menu().querySelector<HTMLButtonElement>('[data-action="generate-bilibili-ai"]')!;
        const click = (button: HTMLButtonElement) => {
            const event = new f.window.Event('click', {bubbles: true});
            Object.defineProperty(event, 'isTrusted', {value: true});
            button.dispatchEvent(event);
        };
        const choose = (mode: string) => click(f.menu().querySelector<HTMLButtonElement>(`[data-mode="${mode}"]`)!);
        return {...f, send, generate, clickGenerate: () => click(generate()), choose};
    }
    it('页面合成点击无法生成字幕或打开自动识别', async () => {
        const f = aiFixture(); f.start(); await vi.advanceTimersByTimeAsync(100);
        f.generate().click();
        f.menu().querySelector<HTMLButtonElement>('[data-action="toggle-course-auto"]')!.click();
        await vi.advanceTimersByTimeAsync(500);
        expect(f.config.videoCourseAutoStart.bilibili).toBe(false);
        expect(f.send).not.toHaveBeenCalled();
        expect(bilibiliCapture.start).not.toHaveBeenCalled();
    });
    it('后台页不自动读取音轨，切回当前页后启动', async () => {
        const f = aiFixture();
        Object.defineProperty(f.document, 'hidden', {value: true, configurable: true});
        f.config.videoCourseAutoStart.bilibili = true; f.start(); await vi.advanceTimersByTimeAsync(500);
        expect(f.send).not.toHaveBeenCalled();
        Object.defineProperty(f.document, 'hidden', {value: false});
        await vi.advanceTimersByTimeAsync(500);
        expect(bilibiliCapture.start).toHaveBeenCalledOnce();
    });
    it('默认不读音频，自动开启只在明确空字幕后启动且逐句翻译，完整后可导出', async () => {
        const f = aiFixture(); f.start(); await vi.advanceTimersByTimeAsync(100);
        expect(f.send).not.toHaveBeenCalled(); expect(bilibiliCapture.start).not.toHaveBeenCalled();
        f.config.videoCourseAutoStart.bilibili = true; f.change(); await vi.advanceTimersByTimeAsync(500);
        expect(bilibiliCapture.start).toHaveBeenCalledOnce(); expect(f.send).toHaveBeenCalledOnce();
        expect(f.generate().textContent).toBe('停止生成');
        const cues = [{startMs: 0, durationMs: 1000, text: 'Hello from the Bilibili audio.', availableAtMs: 0, spokenEndMs: 1000}];
        bilibiliCapture.options!.onCuesProgress!(cues, 1); await vi.advanceTimersByTimeAsync(200);
        expect(f.shadow()!.querySelector('.source')!.textContent).toBe(cues[0].text);
        expect(f.translate).toHaveBeenCalledWith(cues[0].text, expect.any(AbortSignal), f.config.videoSourceLanguage);
        const download = f.menu().querySelector<HTMLButtonElement>('[data-action="download-subtitles"]')!;
        expect(download.disabled).toBe(true);
        expect(f.menu().querySelector<HTMLButtonElement>('[data-action="open-sentence-learning"]')!.disabled).toBe(true);
        await bilibiliCapture.options!.onTranscriptionComplete(cues, 1);
        bilibiliCapture.options!.onProgress!({phase: 'ready', progress: 1, capturedMs: 1, durationMs: 1, transcribedMs: 1, windowIndex: 1, windowCount: 1});
        await vi.advanceTimersByTimeAsync(200); expect(download.disabled).toBe(false);
        expect(f.menu().querySelector<HTMLButtonElement>('[data-action="open-sentence-learning"]')!.disabled).toBe(false);
        download.click(); await vi.advanceTimersByTimeAsync(0);
        expect(f.download).toHaveBeenCalledWith(expect.stringContaining(cues[0].text), 'ai', expect.any(Array), 'srt');
    });
    it('BV1wRWX6SEmX 标题已声明中文字幕时，即使接口空列表也不自动生成', async () => {
        const f = aiFixture();
        Object.defineProperty(f.window, 'location', {value: new URL('https://www.bilibili.com/video/BV1wRWX6SEmX/'), configurable: true});
        const title = f.document.createElement('h1'); title.textContent = '【CoRL 2026】中文字幕｜Reed Lu - Sharpa 的三条路径，一套技术栈';
        f.document.body.appendChild(title); f.config.videoCourseAutoStart.bilibili = true;
        f.start(); await vi.advanceTimersByTimeAsync(500);
        expect(f.fetch).toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(bilibiliCapture.start).not.toHaveBeenCalled();
        f.clickGenerate(); await vi.advanceTimersByTimeAsync(100);
        expect(bilibiliCapture.start).toHaveBeenCalledOnce();
        title.textContent = '【中英字幕】另一个带字幕的视频'; f.change(); await vi.advanceTimersByTimeAsync(100);
        expect(f.generate().textContent).toBe('停止生成');
    });
    it('标题迟到时停止自动生成；切换到未标注字幕的视频可再次自动生成', async () => {
        const f = aiFixture(); f.config.videoCourseAutoStart.bilibili = true;
        f.start(); await vi.advanceTimersByTimeAsync(500); expect(bilibiliCapture.start).toHaveBeenCalledOnce();
        const title = f.document.createElement('h1'); title.textContent = '【中英字幕】talk'; f.document.body.appendChild(title);
        const before = bilibiliCapture.cancel.mock.calls.length;
        f.change(); await vi.advanceTimersByTimeAsync(100);
        expect(bilibiliCapture.cancel.mock.calls.length).toBeGreaterThan(before);
        expect(f.generate().textContent).toBe('生成 AI 字幕');
        title.textContent = 'SuperMimic CoRL 发布会';
        Object.defineProperty(f.window, 'location', {value: new URL('https://www.bilibili.com/video/BV193s56tEx2/'), configurable: true});
        f.change(); await vi.advanceTimersByTimeAsync(500); expect(bilibiliCapture.start).toHaveBeenCalledTimes(2);
    });
    it('存在平台字幕或字幕内容解析失败时均不触发自动识别', async () => {
        const f = aiFixture(); let valid = true;
        f.fetch.mockImplementation(async input => new Response(JSON.stringify(String(input).includes('hdslb.com')
            ? valid ? {body: [{from: 0, to: 1, content: f.source}]} : {body: []}
            : {code: 0, data: {cid: 456, subtitle: {subtitles: [{lan: 'en', subtitle_url: '//aisubtitle.hdslb.com/a.json'}]}}})));
        f.config.videoCourseAutoStart.bilibili = true; f.start(); await vi.advanceTimersByTimeAsync(500);
        expect(f.generate().hidden).toBe(true); expect(f.send).not.toHaveBeenCalled();
        valid = false; f.choose('off'); f.choose('bilingual'); await vi.advanceTimersByTimeAsync(500);
        expect(f.menu().querySelector('[data-source-status]')!.textContent).toBeTruthy();
        expect(f.send).not.toHaveBeenCalled(); expect(bilibiliCapture.start).not.toHaveBeenCalled();
    });
    it('平台读取失败不自动开始，手动可重试；停止、关闭及换 P 都取消旧会话', async () => {
        const f = aiFixture(); f.fetch.mockRejectedValue(new Error('network'));
        f.config.videoCourseAutoStart.bilibili = true; const dispose = f.start(); await vi.advanceTimersByTimeAsync(500);
        expect(f.send).not.toHaveBeenCalled();
        f.clickGenerate(); await vi.advanceTimersByTimeAsync(100); expect(bilibiliCapture.start).toHaveBeenCalledOnce();
        f.clickGenerate(); await vi.advanceTimersByTimeAsync(500); expect(bilibiliCapture.start).toHaveBeenCalledOnce();
        f.clickGenerate(); await vi.advanceTimersByTimeAsync(100); expect(bilibiliCapture.start).toHaveBeenCalledTimes(2);
        f.choose('off'); await vi.advanceTimersByTimeAsync(100); expect(f.generate().textContent).toBe('生成 AI 字幕');
        f.clickGenerate(); await vi.advanceTimersByTimeAsync(100);
        const before = bilibiliCapture.cancel.mock.calls.length;
        Object.defineProperty(f.window, 'location', {value: new URL('https://www.bilibili.com/video/BV1xx411c7mD/?p=2'), configurable: true});
        f.change(); expect(bilibiliCapture.cancel.mock.calls.length).toBeGreaterThan(before);
        dispose(); expect(bilibiliCapture.destroy).toHaveBeenCalled();
    });
    it('原生轨就绪时保持原生优先，缺模型和识别错误显示明确状态', async () => {
        const f = aiFixture(); f.send.mockResolvedValueOnce({success: true, models: []});
        f.config.videoCourseAutoStart.bilibili = true; f.start(); await vi.advanceTimersByTimeAsync(500);
        expect(f.menu().querySelector('[data-source-status]')!.textContent).toContain('下载');
        expect(bilibiliCapture.start).not.toHaveBeenCalled();
        f.clickGenerate(); await vi.advanceTimersByTimeAsync(100);
        bilibiliCapture.options!.onError(new Error('音轨不可用')); await vi.advanceTimersByTimeAsync(100);
        expect(f.menu().querySelector('[data-source-status]')!.textContent).toBe('音轨不可用');
        f.fetch.mockImplementation(async input => new Response(JSON.stringify(String(input).includes('hdslb.com')
            ? {body: [{from: 0, to: 1, content: f.source}]}
            : {code: 0, data: {cid: 456, subtitle: {subtitles: [{lan: 'en', subtitle_url: '//aisubtitle.hdslb.com/a.json'}]}}})));
        f.choose('off'); f.choose('bilingual'); await vi.advanceTimersByTimeAsync(500);
        expect(f.generate().hidden).toBe(true); expect(f.shadow()!.querySelector('.source')!.textContent).toBe(f.source);
    });
});

describe('平台运行时可靠性、低延迟与跨浏览器增强', () => {
    it('课程请求失败或为空时回退到 TextTrack 与原生字幕节点，加载中不误译原生 DOM', async () => {
        const f = courseFixture('edx');
        f.config.videoCourseAutoStart.edx = true;
        let rejectFetch!: (error: Error) => void;
        f.fetch.mockImplementationOnce(() => new Promise((_, reject) => { rejectFetch = reject; }));
        f.start();
        // loading 阶段没有 TextTrack 时不抢译原生字幕 DOM
        expect(f.translate).not.toHaveBeenCalled();
        rejectFetch(new Error('offline'));
        await vi.advanceTimersByTimeAsync(120);
        // 失败后自动回退到原生 .closed-captions DOM
        expect(f.shadow()?.querySelector('.source')?.textContent).toBe('Native caption');
        expect(f.translate).toHaveBeenCalledWith('Native caption', expect.any(AbortSignal));

        // 存在可用 TextTrack 时优先回退到 TextTrack（含 activeCues O(1) 快路径与 offset 回退）
        const activeTrack = new f.window.EventTarget() as unknown as TextTrack & {mode: TextTrackMode; cues: unknown[]; activeCues: unknown[]};
        Object.assign(activeTrack, {
            kind: 'subtitles', language: 'en', label: 'English', mode: 'showing',
            activeCues: [{startTime: 0, endTime: 2, text: 'Active <b>fast</b> cue'}],
            cues: [{startTime: 0, endTime: 2, text: 'Fallback scanned cue'}],
        });
        (f.video.textTracks as unknown as TextTrack[]).push(activeTrack);
        f.video.dispatchEvent(new f.window.Event('timeupdate'));
        await vi.advanceTimersByTimeAsync(0);
        expect(f.shadow()?.querySelector('.source')?.textContent).toBe('Active fast cue');

        // 校时非零时绕过 activeCues 改扫 track.cues
        f.config.videoSubtitleOffsetMs = 100; f.change();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.shadow()?.querySelector('.source')?.textContent).toBe('Fallback scanned cue');
    });

    it('安全守护 Popover API、只读 TextTrack.mode 以及菜单上方空间不足时的下方翻转', async () => {
        const f = courseFixture('edx');
        const showPopover = vi.fn(() => { throw new Error('popover failed'); });
        const hidePopover = vi.fn(() => { throw new Error('hide failed'); });
        const origCreateElement = f.document.createElement.bind(f.document);
        vi.spyOn(f.document, 'createElement').mockImplementation((tag: string) => {
            const el = origCreateElement(tag);
            if (tag === 'div') {
                Object.defineProperty(el, 'showPopover', {configurable: true, value: showPopover});
                Object.defineProperty(el, 'hidePopover', {configurable: true, value: hidePopover});
                Object.defineProperty(el, 'matches', {configurable: true, value: () => true});
            }
            return el;
        });
        f.start();
        const button = f.menu().querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
        const menu = f.menu().querySelector<HTMLElement>('#fluent-read-video-subtitle-menu')!;
        expect(menu.getAttribute('popover')).toBe('manual');
        // 按钮靠近顶部（上方空间不足，下方空间充足）-> 菜单翻转到按钮下方
        button.getBoundingClientRect = () => ({left: 200, right: 240, top: 20, bottom: 52, width: 40, height: 32}) as DOMRect;
        menu.getBoundingClientRect = () => ({left: 0, top: 0, width: 280, height: 150}) as DOMRect;
        button.click();
        expect(showPopover).toHaveBeenCalledOnce();
        expect(Number.parseFloat(menu.style.top)).toBe(60);
        // 按钮高度超过视口剩余空间时夹边到安全视口内
        menu.getBoundingClientRect = () => ({left: 0, top: 0, width: 280, height: 890}) as DOMRect;
        button.click(); // close -> invokes guarded hidePopover
        expect(hidePopover).toHaveBeenCalledOnce();
        button.click(); // reopen with huge height -> clamped
        expect(Number.parseFloat(menu.style.top)).toBe(8);

        // 只读 TextTrack.mode 写入失败不中断渲染
        const readonlyTrack = {
            kind: 'subtitles', language: 'en', label: 'RO',
            get mode() { return 'showing' as TextTrackMode; },
            set mode(_v: TextTrackMode) { throw new Error('readonly mode'); },
            cues: [{startTime: 0, endTime: 2, text: 'Readonly track text'}],
        } as unknown as TextTrack;
        (f.video.textTracks as unknown as TextTrack[]).push(readonlyTrack);
        f.config.videoCourseAutoStart.edx = true; f.change();
        await vi.advanceTimersByTimeAsync(100);
        expect(f.document.getElementById('fluent-read-course-controls')).not.toBeNull();
    });

    it('过滤自有文本节点变更、支持后台与暂停轮询节流、立即响应 seeked/timeupdate/cuechange 并持续预取', async () => {
        const frames: FrameRequestCallback[] = [];
        let mutationCallback!: MutationCallback;
        const f = courseFixture('edx');
        vi.stubGlobal('MutationObserver', class {
            constructor(cb: MutationCallback) { mutationCallback = cb; }
            observe() {}
            disconnect() {}
        });
        Object.assign(f.window, {
            requestAnimationFrame: (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; },
            cancelAnimationFrame: vi.fn(),
        });
        f.config.videoCourseAutoStart.edx = true;
        f.config.videoService = 'openai';
        f.fetch.mockImplementation(async () => new Response(JSON.stringify({
            start: [2000, 15000],
            end: [14000, 20000],
            text: ['First long cue.', 'Second cue at 15s.'],
        })));
        Object.assign(f.video, {currentTime: 0.5, paused: false, playbackRate: 1});
        const dispose = f.start();
        await vi.advanceTimersByTimeAsync(100);
        // 片头静默期（currentTime=0.5s, 第一句在 2s）AI 30s 预取窗口已预热后续句子
        expect(f.translate).toHaveBeenCalledWith('First long cue.', expect.any(AbortSignal));
        expect(f.translate).toHaveBeenCalledWith('Second cue at 15s.', expect.any(AbortSignal));

        // 跳到第一句并派发 seeked -> 无需等待 250ms 轮询，立即同步命中缓存
        f.video.currentTime = 3;
        f.video.dispatchEvent(new f.window.Event('seeked'));
        expect(f.shadow()?.querySelector('.source')?.textContent).toBe('First long cue.');
        expect(f.shadow()?.querySelector('.translation')?.textContent).toBe('测试译文');

        // 自有容器内的 Text 节点 characterData 变更及探针 childList 变更均不触发重排调度
        const host = f.document.getElementById('fluent-read-platform-captions')!;
        const textNode = f.document.createTextNode('owned');
        host.appendChild(textNode);
        const probe = f.document.createElement('span');
        probe.setAttribute('aria-hidden', 'true');
        probe.setAttribute('style', 'padding-top:env(safe-area-inset-top,0px)');
        const measure = vi.fn(f.video.getBoundingClientRect);
        f.video.getBoundingClientRect = measure;
        mutationCallback([
            {type: 'characterData', target: textNode, addedNodes: [], removedNodes: []},
            {type: 'childList', target: f.document.body, addedNodes: [probe], removedNodes: []},
            {type: 'childList', target: f.document.body, addedNodes: [host], removedNodes: []},
        ] as unknown as MutationRecord[], {} as MutationObserver);
        await vi.advanceTimersByTimeAsync(100);
        expect(measure).not.toHaveBeenCalled();

        // rAF 合并 scroll 与 visualViewport 监听
        f.window.dispatchEvent(new f.window.Event('scroll'));
        f.window.dispatchEvent(new f.window.Event('scroll'));
        expect(frames).toHaveLength(1);
        frames.splice(0).forEach(cb => cb(0));
        expect(measure).toHaveBeenCalledTimes(1);
        measure.mockClear();

        // 后台页暂停 250ms 轮询，切回可见立即 sync
        Object.defineProperty(f.document, 'visibilityState', {configurable: true, value: 'hidden'});
        await vi.advanceTimersByTimeAsync(1000);
        expect(measure).not.toHaveBeenCalled();
        Object.defineProperty(f.document, 'visibilityState', {configurable: true, value: 'visible'});
        f.document.dispatchEvent(new f.window.Event('visibilitychange'));
        expect(measure).toHaveBeenCalled();

        // 暂停事件节流 250ms 轮询，play 立即恢复并 sync
        Object.assign(f.video, {paused: true});
        f.video.dispatchEvent(new f.window.Event('pause', {bubbles: true}));
        measure.mockClear();
        await vi.advanceTimersByTimeAsync(1000);
        expect(measure).not.toHaveBeenCalled();
        Object.assign(f.video, {paused: false});
        f.video.dispatchEvent(new f.window.Event('play', {bubbles: true}));
        expect(measure).toHaveBeenCalled();

        // 触发 rAF 队列内销毁释放 cancelAnimationFrame
        f.window.dispatchEvent(new f.window.Event('scroll'));
        dispose();
        expect(f.window.cancelAnimationFrame).toHaveBeenCalled();
    });

    it('穿透开放 Shadow DOM 发现 Disney+ 视频与字幕并即时响应 TextTrack cuechange', async () => {
        const f = fixture('https://www.disneyplus.com/video/demo', '<div id="player-host"></div>');
        const host = f.document.getElementById('player-host')!;
        const shadow = host.attachShadow({mode: 'open'});
        const wrapper = f.document.createElement('div');
        const video = f.document.createElement('video') as unknown as HTMLVideoElement;
        video.getBoundingClientRect = () => ({left: 0, top: 0, width: 800, height: 450}) as DOMRect;
        Object.assign(video, {currentTime: 1, paused: false, ended: false, seeking: false});
        const track = new f.window.EventTarget() as unknown as TextTrack & {mode: TextTrackMode; cues: Array<{startTime: number; endTime: number; text: string}>};
        Object.assign(track, {
            kind: 'subtitles', language: 'en', label: 'English', mode: 'showing',
            cues: [{startTime: 0, endTime: 2, text: 'Initial cue.'}],
        });
        Object.defineProperty(video, 'textTracks', {value: [track], configurable: true});
        wrapper.appendChild(video);
        shadow.appendChild(wrapper);
        const overlay = f.document.createElement('div');
        overlay.className = 'dss-hls-subtitle-overlay';
        overlay.textContent = 'Shadow overlay cue';
        host.appendChild(overlay);

        const dispose = f.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.shadow()?.querySelector('.source')?.textContent).toBe('Initial cue.');

        // cuechange 立即更新字幕，不等待 250ms 轮询
        (track as unknown as {cues: {startTime: number; endTime: number; text: string}[]}).cues = [{startTime: 0, endTime: 2, text: 'Cuechange immediate.'}];
        track.dispatchEvent(new f.window.Event('cuechange'));
        expect(f.shadow()?.querySelector('.source')?.textContent).toBe('Cuechange immediate.');

        // 清空轨道后穿透 ShadowRoot host 找到宿主侧原生字幕层
        (track as unknown as {cues: {startTime: number; endTime: number; text: string}[]}).cues = [];
        video.dispatchEvent(new f.window.Event('timeupdate'));
        expect(f.shadow()?.querySelector('.source')?.textContent).toBe('Shadow overlay cue');
        await vi.advanceTimersByTimeAsync(100);

        // Shadow DOM 视频直接派发非冒泡/非穿透的 pause/play/seeking 事件也能生效
        Object.assign(video, {paused: true});
        video.dispatchEvent(new f.window.Event('pause'));
        const shadowMeasure = vi.fn(video.getBoundingClientRect);
        video.getBoundingClientRect = shadowMeasure;
        await vi.advanceTimersByTimeAsync(1000);
        expect(shadowMeasure).not.toHaveBeenCalled();
        Object.assign(video, {paused: false});
        video.dispatchEvent(new f.window.Event('play'));
        expect(shadowMeasure).toHaveBeenCalled();
        shadowMeasure.mockClear();
        video.dispatchEvent(new f.window.Event('seeking'));
        await vi.advanceTimersByTimeAsync(100);
        expect(shadowMeasure).toHaveBeenCalled();

        // 无 rAF 环境滚动走 schedule 回退，非 video play 事件被忽略，视频移除时解绑事件
        f.window.dispatchEvent(new f.window.Event('scroll'));
        f.document.body.dispatchEvent(new f.window.Event('play', {bubbles: true}));
        video.remove();
        await vi.advanceTimersByTimeAsync(100);
        expect(f.document.getElementById('fluent-read-platform-captions')?.hidden).toBe(true);
        dispose();
    });

    it('停用/隐藏后重新启用仍保留 seeked 与 timeupdate 即时监听，多视频非课程页从 pollPaused 恢复', async () => {
        // 1) 课程页停用 videoTranslationEnabled 再重新启用，seeked/timeupdate 仍即时响应
        const f = courseFixture('edx');
        f.config.videoCourseAutoStart.edx = true;
        f.fetch.mockImplementation(async () => new Response(JSON.stringify({
            start: [0, 5000],
            end: [2000, 7000],
            text: ['First cue.', 'Second cue.'],
        })));
        Object.assign(f.video, {currentTime: 0.5, paused: true, playbackRate: 1});
        const disposeCourse = f.start();
        await vi.advanceTimersByTimeAsync(100);
        expect(f.shadow()?.querySelector('.source')?.textContent).toBe('First cue.');

        f.config.videoTranslationEnabled = false; f.change();
        expect(f.document.getElementById('fluent-read-platform-captions')?.hidden).toBe(true);
        f.config.videoTranslationEnabled = true; f.change();
        await vi.advanceTimersByTimeAsync(100);
        expect(f.shadow()?.querySelector('.source')?.textContent).toBe('First cue.');

        // 跳到第二句并直接派发 seeked（不推进 250ms 轮询定时器）
        f.video.currentTime = 5.5;
        f.video.dispatchEvent(new f.window.Event('seeked'));
        expect(f.shadow()?.querySelector('.source')?.textContent).toBe('Second cue.');

        // 回到第一句并派发 timeupdate（同样无需等待 250ms 轮询）
        f.video.currentTime = 0.5;
        f.video.dispatchEvent(new f.window.Event('timeupdate'));
        expect(f.shadow()?.querySelector('.source')?.textContent).toBe('First cue.');
        disposeCourse();

        // 2) 非课程页隐藏 videoSubtitleVisible 再恢复，且多视频暂停后由另一视频 play 唤醒 pollPaused
        const d = fixture('https://www.disneyplus.com/video/demo', `
            <div class="p1"><video id="v1" src="one.mp4"></video><div class="dss-hls-subtitle-overlay">Video 1 cue</div></div>
            <div class="p2"><video id="v2" src="two.mp4"></video><div class="dss-hls-subtitle-overlay">Video 2 cue</div></div>
        `);
        const v1 = d.document.getElementById('v1') as unknown as HTMLVideoElement;
        const v2 = d.document.getElementById('v2') as unknown as HTMLVideoElement;
        v1.getBoundingClientRect = () => ({left: 0, top: 0, width: 800, height: 450}) as DOMRect;
        v2.getBoundingClientRect = () => ({left: 0, top: 500, width: 640, height: 360}) as DOMRect;
        Object.assign(v1, {currentTime: 1, paused: false, ended: false, seeking: false});
        Object.assign(v2, {currentTime: 1, paused: true, ended: false, seeking: false});
        Object.defineProperty(v1, 'textTracks', {value: [], configurable: true});
        Object.defineProperty(v2, 'textTracks', {value: [], configurable: true});

        const disposeDisney = d.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(d.shadow()?.querySelector('.source')?.textContent).toBe('Video 1 cue');

        // 隐藏再显示：seeked 监听立即恢复
        d.config.videoSubtitleVisible = false; d.change();
        expect(d.document.getElementById('fluent-read-platform-captions')?.hidden).toBe(true);
        d.config.videoSubtitleVisible = true; d.change();
        d.document.querySelector('.p1 .dss-hls-subtitle-overlay')!.textContent = 'Video 1 after show';
        v1.dispatchEvent(new d.window.Event('seeked'));
        expect(d.shadow()?.querySelector('.source')?.textContent).toBe('Video 1 after show');

        // v1 暂停进入 pollPaused，随后 v2 开始播放 -> 必须重置 pollPaused 并切换到 v2
        Object.assign(v1, {paused: true});
        v1.dispatchEvent(new d.window.Event('pause'));
        Object.assign(v2, {paused: false});
        v2.dispatchEvent(new d.window.Event('play', {bubbles: true}));
        await vi.advanceTimersByTimeAsync(100);
        expect(d.shadow()?.querySelector('.source')?.textContent).toBe('Video 2 cue');
        disposeDisney();
    });
});
