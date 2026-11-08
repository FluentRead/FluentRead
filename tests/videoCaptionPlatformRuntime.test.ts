import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {parseHTML} from 'linkedom';
import {Config} from '@/src/core/config/model';
import {mountPlatformCaptions} from '@/src/features/video-subtitle/content/platformRuntime';
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';
registerAllUiLanguageBundles();

const readingPort = vi.hoisted(() => ({annotate: vi.fn()}));
vi.mock('@/src/features/video-subtitle/content/readingAnnotationClient', () => ({annotateVideoReading: readingPort.annotate}));
vi.mock('@/src/platform/browser/capabilities', () => ({browserCapabilities: {extensionDom: true}}));
const disposals: Array<() => void> = [];
beforeEach(() => {
    vi.useFakeTimers();
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
    let subscription: (() => void) | undefined;
    const patch = vi.fn((value: Partial<Config>) => { Object.assign(config, value); subscription?.(); });
    const subscribe = vi.fn((listener: () => void) => { subscription = listener; return vi.fn(); });
    const ports = {document: document as unknown as Document, window: window as unknown as Window, config, translate, patch, subscribe, label: (text: string) => text};
    const start = () => { const dispose = mountPlatformCaptions(ports); disposals.push(dispose); return dispose; };
    const shadow = () => document.getElementById('fluent-read-platform-captions')?.shadowRoot;
    return {document, window, config, translate, patch, subscribe, start, shadow, change: () => subscription?.()};
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
        expect(measureHeight).toHaveBeenCalledTimes(11);
        measureHeight.mockClear(); await vi.advanceTimersByTimeAsync(1000); expect(measureHeight).not.toHaveBeenCalled();
    });

    it('失败文字和重试工具到达后重新适配，重试成功收起工具并稳定复用布局', async () => {
        let fail!: (reason: Error) => void, finish!: (text: string) => void;
        const translate = vi.fn().mockImplementationOnce(() => new Promise<string>((_, reject) => { fail = reject; }))
            .mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
        const f = videoFixture('https://www.udemy.com/course/demo/learn/', translate);
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
