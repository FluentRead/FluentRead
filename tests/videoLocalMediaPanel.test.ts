/**
 * @file tests/videoLocalMediaPanel.test.ts
 * 文件职责：以真实 Vue 3 组件挂载验证 LocalMediaTranscriptionPanel 的文件导入、离线转写、双语播放、逐句循环、导出与卸载清理。
 * 主要内容：覆盖不支持环境提示、格式/空文件/体积校验、拖拽与点击导入、Object URL 释放、转写阶段进度与取消、补译、显示模式切换、单句循环与句末暂停以及多格式导出。
 * 模块边界：仅通过组件公开 props 注入传输、解码、翻译与下载端口，直接编译并挂载真实 SFC 模板与交互逻辑。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import * as vue from 'vue';
import {Config} from '@/src/core/config/model';
import {translate} from '@/src/core/i18n';
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';

registerAllUiLanguageBundles();

const capabilityState = vi.hoisted(() => ({extensionDom: true}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: vi.fn(async () => ({success: true}))}}}));
vi.mock('@/src/ui/i18n', () => ({
    useUiI18n: () => ({
        t: (key: string, params?: Record<string, string | number>) => translate(key, 'zh-CN', params),
    }),
}));
vi.mock('@/src/platform/browser/capabilities', () => ({
    browserCapabilities: {
        get extensionDom() { return capabilityState.extensionDom; },
    },
}));
vi.mock('@/src/platform/browser/runtimeMessages', () => ({sendRuntimeMessage: vi.fn(async () => ({success: true}))}));
vi.mock('@/src/services/translation/client', () => ({translateVideoText: vi.fn(async (text: string) => `默认译:${text}`)}));
vi.mock('@/src/shared/dom/downloadTextFile', () => ({downloadTextFile: vi.fn()}));

import LocalMediaTranscriptionPanel from '@/src/features/video-subtitle/local-media/LocalMediaTranscriptionPanel.vue';
import {VIDEO_AI_SAMPLE_RATE} from '@/src/features/video-subtitle/content/video-ai/audioWindow';

let unmountActive: (() => void) | undefined;
let createdUrls: string[] = [];
let revokedUrls: string[] = [];

function makeSpeechPcm(seconds = 5): Float32Array {
    const pcm = new Float32Array(seconds * VIDEO_AI_SAMPLE_RATE);
    for (let i = 0; i < pcm.length; i += 1) pcm[i] = Math.sin((i / VIDEO_AI_SAMPLE_RATE) * 440 * Math.PI * 2) * 0.25;
    return pcm;
}

function makeFakeFile(name: string, type: string, size: number): File {
    return {
        name,
        type,
        size,
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    } as unknown as File;
}

function mountPanel(propsObj: InstanceType<typeof LocalMediaTranscriptionPanel>['$props'], wrapInClosedDetails = false) {
    const bodyHtml = wrapInClosedDetails
        ? '<details id="wrapper-details"><summary>Toggle</summary><div id="root"></div></details>'
        : '<div id="root"></div>';
    const {document, window} = parseHTML(`<html><body>${bodyHtml}</body></html>`);
    const selectedValues = new WeakMap<object, string>();
    let focusedElement: Element | null = null;
    Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
        configurable: true,
        get() { return selectedValues.get(this) || ''; },
        set(val: string) { selectedValues.set(this, val); },
    });
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', window);
    vi.stubGlobal('HTMLElement', window.HTMLElement);
    vi.stubGlobal('Element', window.Element);
    vi.stubGlobal('Node', window.Node);
    vi.stubGlobal('Event', window.Event);
    vi.stubGlobal('URL', {
        createObjectURL: vi.fn(() => {
            const url = `blob:local-media/${createdUrls.length + 1}`;
            createdUrls.push(url);
            return url;
        }),
        revokeObjectURL: vi.fn((url: string) => {
            revokedUrls.push(url);
        }),
    });

    const renderer = vue.createRenderer<Node, Element>({
        insert: (node, parent, anchor) => parent.insertBefore(node, anchor || null),
        remove: node => node.parentNode?.removeChild(node),
        createElement: tag => {
            const el = vue.markRaw(document.createElement(tag)) as HTMLElement;
            el.focus = () => { focusedElement = el; };
            return el;
        },
        createText: value => document.createTextNode(value),
        createComment: value => document.createComment(value),
        setText: (node, value) => { node.nodeValue = value; },
        setElementText: (node, value) => { node.textContent = value; },
        parentNode: node => node.parentElement,
        nextSibling: node => node.nextSibling,
        patchProp: (node, key, previous, next) => {
            if (/^on[A-Z]/.test(key)) {
                const event = key.slice(2).toLowerCase();
                if (previous) node.removeEventListener(event, previous);
                if (next) node.addEventListener(event, next);
            } else if (key === 'class') {
                node.setAttribute('class', Array.isArray(next) ? next.filter(Boolean).join(' ') : String(next || ''));
            } else if (key === 'value') {
                (node as HTMLInputElement).value = next == null ? '' : String(next);
            } else if (next == null || (next === false && !/^(aria-|data-)/.test(key))) {
                node.removeAttribute(key);
            } else {
                node.setAttribute(key, next === true && !/^(aria-|data-)/.test(key) ? '' : String(next));
            }
        },
    });
    const host = document.getElementById('root')!;
    const app = renderer.createApp({
        setup: () => () => vue.h(LocalMediaTranscriptionPanel, propsObj),
    });
    app.mount(host);
    const unmount = () => { app.unmount(); };
    unmountActive = unmount;
    return {document, window, host, unmount, getFocusedElement: () => focusedElement};
}

async function flush(): Promise<void> {
    await Promise.resolve();
    await vue.nextTick();
    await Promise.resolve();
    await vue.nextTick();
}

beforeEach(() => {
    createdUrls = [];
    revokedUrls = [];
    capabilityState.extensionDom = true;
});

afterEach(() => {
    unmountActive?.();
    unmountActive = undefined;
    vi.unstubAllGlobals();
});

describe('LocalMediaTranscriptionPanel 真实组件生命周期', () => {
    it('校验不支持浏览器、空文件、超大文件与不支持格式，并支持拖拽与文件选择导入', async () => {
        const config = vue.reactive(new Config());
        config.uiLanguage = 'zh-CN';
        config.videoTranslationEnabled = true;
        capabilityState.extensionDom = false;

        const props = vue.reactive({
            config,
            active: true,
        });
        const {document, window, unmount} = mountPanel(props);
        await flush();

        expect(document.querySelector('.fr-local-media-warning')?.textContent).toContain('不支持本地音视频');

        // 不可操作状态拖拽直接忽略
        const dropzone = document.querySelector<HTMLElement>('[data-local-media-dropzone]')!;
        dropzone.dispatchEvent(Object.assign(new window.Event('drop', {bubbles: true, cancelable: true}), {
            dataTransfer: {files: [makeFakeFile('clip.mp4', 'video/mp4', 1024)]},
        }));
        await flush();
        expect(document.querySelector('[data-local-media-player]')).toBeNull();

        // 启用后重新挂载并校验三类非法文件
        unmount();
        capabilityState.extensionDom = true;
        const mounted = mountPanel({config, active: true});
        await flush();
        const activeDoc = mounted.document;
        const activeWin = mounted.window;

        const pickBtn = activeDoc.querySelector<HTMLButtonElement>('[data-local-media-action="pick"]')!;
        const input = activeDoc.querySelector<HTMLInputElement>('[data-local-media-input]')!;
        const clickSpy = vi.spyOn(input, 'click');
        pickBtn.click();
        expect(clickSpy).toHaveBeenCalledOnce();

        const dispatchInput = async (file?: File) => {
            Object.defineProperty(input, 'files', {value: file ? [file] : [], configurable: true});
            input.dispatchEvent(new activeWin.Event('change', {bubbles: true}));
            await flush();
        };

        await dispatchInput(undefined);
        await dispatchInput(makeFakeFile('empty.mp3', 'audio/mpeg', 0));
        expect(activeDoc.querySelector('[data-local-media-error]')?.textContent).toContain('为空');

        await dispatchInput(makeFakeFile('huge.mp4', 'video/mp4', 201 * 1024 * 1024));
        expect(activeDoc.querySelector('[data-local-media-error]')?.textContent).toContain('200 MB');

        await dispatchInput(makeFakeFile('notes.txt', 'text/plain', 100));
        expect(activeDoc.querySelector('[data-local-media-error]')?.textContent).toContain('不支持该文件格式');

        // 拖拽悬停、离开、空拖拽与成功导入音频文件
        const activeDropzone = activeDoc.querySelector<HTMLElement>('[data-local-media-dropzone]')!;
        activeDropzone.dispatchEvent(new activeWin.Event('dragover', {bubbles: true, cancelable: true}));
        await flush();
        expect(activeDropzone.getAttribute('class')).toContain('is-dragging');
        activeDropzone.dispatchEvent(new activeWin.Event('dragleave', {bubbles: true, cancelable: true}));
        await flush();
        activeDropzone.dispatchEvent(Object.assign(new activeWin.Event('drop', {bubbles: true, cancelable: true}), {
            dataTransfer: {files: []},
        }));
        await flush();

        activeDropzone.dispatchEvent(Object.assign(new activeWin.Event('drop', {bubbles: true, cancelable: true}), {
            dataTransfer: {files: [makeFakeFile('podcast.mp3', 'audio/mpeg', 4096)]},
        }));
        await flush();
        expect(activeDoc.querySelector('[data-local-media-filename]')?.textContent).toBe('podcast.mp3');
        expect(activeDoc.querySelector('audio[data-local-media-player]')).not.toBeNull();
        expect(createdUrls).toEqual(['blob:local-media/1']);

        // 清除文件释放 Object URL
        activeDoc.querySelector<HTMLButtonElement>('[data-local-media-action="clear"]')!.click();
        await flush();
        expect(revokedUrls).toEqual(['blob:local-media/1']);
        expect(activeDoc.querySelector('[data-local-media-dropzone]')).not.toBeNull();
    });

    it('完整执行离线转写、双语播放、逐句循环/句末暂停、补译、导出与卸载释放', async () => {
        const config = vue.reactive(new Config());
        config.uiLanguage = 'zh-CN';
        config.to = 'zh-Hans';
        config.videoTranslationEnabled = true;
        config.videoLocalModel = 'small';

        const speech = makeSpeechPcm(5);
        const sendMessage = vi.fn<(msg: unknown) => Promise<unknown>>(async (msg: unknown) => {
            const payload = msg as {type: string};
            if (payload.type === 'fluentReadGetLocalVideoModelState') {
                return {success: true, models: ['small'], available: {tiny: false, base: false, small: true}};
            }
            if (payload.type === 'fluentReadTranscribeLocalVideoAudio') {
                return {
                    success: true,
                    text: 'This is the first complete sentence. And this is the second complete sentence.',
                    segments: [
                        {startMs: 0, endMs: 1400, text: 'This is the first complete sentence.'},
                        {startMs: 2800, endMs: 4600, text: 'And this is the second complete sentence.'},
                    ],
                };
            }
            return {success: true};
        });
        const translateText = vi.fn()
            .mockResolvedValueOnce('这是第一句完整的话。')
            .mockRejectedValueOnce(new Error('temp error'))
            .mockResolvedValue('这是第二句完整的话。');
        const downloadFile = vi.fn();

        const {document, window, unmount, getFocusedElement} = mountPanel({
            config,
            active: true,
            sendMessage,
            translateText,
            downloadFile,
            decodePorts: {
                decodeAudioData: async () => ({
                    duration: 5,
                    length: speech.length,
                    numberOfChannels: 1,
                    sampleRate: VIDEO_AI_SAMPLE_RATE,
                    getChannelData: () => speech,
                } as unknown as AudioBuffer),
            },
        });
        await flush();

        // 导入视频文件
        const input = document.querySelector<HTMLInputElement>('[data-local-media-input]')!;
        Object.defineProperty(input, 'files', {value: [makeFakeFile('demo.mp4', 'video/mp4', 8192)], configurable: true});
        input.dispatchEvent(new window.Event('change', {bubbles: true}));
        await flush();

        const video = document.querySelector<HTMLVideoElement>('video[data-local-media-player]')!;
        expect(video).not.toBeNull();
        const playSpy = vi.fn(async () => { throw new Error('autoplay blocked'); });
        const pauseSpy = vi.fn();
        Object.defineProperty(video, 'play', {value: playSpy, configurable: true});
        Object.defineProperty(video, 'pause', {value: pauseSpy, configurable: true});
        Object.defineProperty(video, 'currentTime', {value: 0.5, writable: true, configurable: true});

        // 禁用状态下自动暂停播放且点击开始按钮被忽略
        config.videoTranslationEnabled = false;
        await flush();
        expect(pauseSpy).toHaveBeenCalledOnce();
        pauseSpy.mockClear();
        document.querySelector<HTMLButtonElement>('[data-local-media-action="transcribe"]')!.click();
        await flush();
        expect(sendMessage).not.toHaveBeenCalled();
        config.videoTranslationEnabled = true;
        await flush();

        // 开始离线转写（第二句翻译失败，暴露补译按钮）
        document.querySelector<HTMLButtonElement>('[data-local-media-action="transcribe"]')!.click();
        await vi.waitFor(() => expect(document.querySelector('[data-local-media-status]')?.textContent).toContain('已生成'));
        await flush();

        expect(document.querySelectorAll('[data-sentence-index]').length).toBe(2);
        expect(document.querySelector('[data-local-media-action="translate-pending"]')).not.toBeNull();

        // 已尝试但失败的条目在切换 仅原文 -> 双语 时不自动无限重译，仍保留手动补译按钮
        const translateCallsAfterFailure = translateText.mock.calls.length;
        document.querySelector<HTMLButtonElement>('[data-local-media-mode="original-only"]')!.click();
        await flush();
        document.querySelector<HTMLButtonElement>('[data-local-media-mode="bilingual"]')!.click();
        await flush();
        expect(translateText.mock.calls.length).toBe(translateCallsAfterFailure);

        // 点击补译按钮完成第二句翻译
        document.querySelector<HTMLButtonElement>('[data-local-media-action="translate-pending"]')!.click();
        await vi.waitFor(() => expect(document.querySelector('[data-local-media-action="translate-pending"]')).toBeNull());
        await flush();

        // 触发 timeupdate 展示双语字幕叠层并自动跟随句子
        video.currentTime = 0.5;
        video.dispatchEvent(new window.Event('timeupdate'));
        await flush();
        expect(document.querySelector('[data-local-media-cue-source]')?.textContent).toBe('This is the first complete sentence.');
        expect(document.querySelector('[data-local-media-cue-translation]')?.textContent).toBe('这是第一句完整的话。');

        // 切换显示模式（仅译文 / 仅原文 / 关闭 / 双语）并校验分段按钮与逐句列表响应
        const selectMode = async (mode: 'bilingual' | 'translation-only' | 'original-only' | 'off') => {
            const btn = document.querySelector<HTMLButtonElement>(`[data-local-media-mode="${mode}"]`)!;
            btn.click();
            await flush();
            expect(btn.getAttribute('aria-checked')).toBe('true');
        };

        await selectMode('translation-only');
        expect(document.querySelector('[data-local-media-cue-source]')).toBeNull();
        expect(document.querySelector('[data-local-media-cue-translation]')?.textContent).toBe('这是第一句完整的话。');

        await selectMode('original-only');
        expect(document.querySelector('[data-local-media-cue-source]')?.textContent).toBe('This is the first complete sentence.');
        expect(document.querySelector('[data-local-media-cue-translation]')).toBeNull();
        expect(document.querySelector('.fr-local-media-sentence-translation')).toBeNull();

        await selectMode('off');
        expect(document.querySelector('[data-local-media-overlay]')).toBeNull();
        expect(document.querySelectorAll('[data-local-media-sentence-hidden]').length).toBe(2);

        await selectMode('bilingual');
        expect(document.querySelector('.fr-local-media-sentence-translation')?.textContent).toBe('这是第一句完整的话。');

        // 遵循 bilingualOrder = translation-first 时译文在原文上方
        config.videoSubtitleAppearance.bilingualOrder = 'translation-first';
        await flush();
        expect([...document.querySelector('[data-local-media-overlay]')!.children].map(el => el.getAttribute('data-local-media-cue-translation') !== null ? 'translation' : 'source')).toEqual(['translation', 'source']);
        config.videoSubtitleAppearance.bilingualOrder = 'original-first';
        await flush();

        // WAI-ARIA radiogroup roving tabindex 与方向键/Home/End 导航
        const dispatchModeKey = async (mode: string, key: string) => {
            const btn = document.querySelector<HTMLButtonElement>(`[data-local-media-mode="${mode}"]`)!;
            const ev: any = new window.Event('keydown', {bubbles: true, cancelable: true});
            ev.key = key;
            ev.preventDefault = vi.fn();
            btn.dispatchEvent(ev);
            await flush();
            return ev;
        };
        expect(document.querySelector('[data-local-media-mode="bilingual"]')?.getAttribute('tabindex')).toBe('0');
        expect(document.querySelector('[data-local-media-mode="translation-only"]')?.getAttribute('tabindex')).toBe('-1');
        const rightEv = await dispatchModeKey('bilingual', 'ArrowRight');
        expect(rightEv.preventDefault).toHaveBeenCalledOnce();
        expect(document.querySelector('[data-local-media-mode="translation-only"]')?.getAttribute('aria-checked')).toBe('true');
        expect(getFocusedElement()).toBe(document.querySelector('[data-local-media-mode="translation-only"]'));
        await dispatchModeKey('translation-only', 'ArrowDown');
        expect(document.querySelector('[data-local-media-mode="original-only"]')?.getAttribute('aria-checked')).toBe('true');
        await dispatchModeKey('original-only', 'ArrowLeft');
        expect(document.querySelector('[data-local-media-mode="translation-only"]')?.getAttribute('aria-checked')).toBe('true');
        await dispatchModeKey('translation-only', 'ArrowUp');
        expect(document.querySelector('[data-local-media-mode="bilingual"]')?.getAttribute('aria-checked')).toBe('true');
        await dispatchModeKey('bilingual', 'End');
        expect(document.querySelector('[data-local-media-mode="off"]')?.getAttribute('aria-checked')).toBe('true');
        expect(getFocusedElement()).toBe(document.querySelector('[data-local-media-mode="off"]'));
        await dispatchModeKey('off', 'Home');
        expect(document.querySelector('[data-local-media-mode="bilingual"]')?.getAttribute('aria-checked')).toBe('true');
        const noopModeEv = await dispatchModeKey('bilingual', 'Tab');
        expect(noopModeEv.preventDefault).not.toHaveBeenCalled();

        // 键盘快捷键切换工作台字幕模式（Alt+M），且弹窗打开时自动让行
        config.videoSubtitleModeHotkeyEnabled = true;
        config.videoSubtitleModeHotkey = 'Alt+M';
        config.videoSubtitleModeHotkeyAction = 'bilingual-original';
        await flush();
        const makeShortcutEvent = () => {
            const ev: any = new window.Event('keydown', {bubbles: true, cancelable: true});
            Object.defineProperty(ev, 'isTrusted', {value: true, configurable: true});
            Object.assign(ev, {
                key: 'm', code: 'KeyM', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false,
                repeat: false, isComposing: false,
            });
            ev.composedPath = () => [document.body];
            return ev;
        };
        const modal = document.createElement('div');
        modal.setAttribute('aria-modal', 'true');
        document.body.appendChild(modal);
        window.dispatchEvent(makeShortcutEvent());
        await flush();
        expect(document.querySelector('[data-local-media-mode="bilingual"]')?.getAttribute('aria-checked')).toBe('true');
        modal.remove();

        window.dispatchEvent(makeShortcutEvent());
        await flush();
        expect(document.querySelector('[data-local-media-mode="original-only"]')?.getAttribute('aria-checked')).toBe('true');
        await selectMode('bilingual');

        // 逐句跳转（含越界保护）、重播、单句循环与句末暂停
        document.querySelector<HTMLButtonElement>('[data-local-media-action="prev-sentence"]')!.click();
        await flush();
        document.querySelector<HTMLButtonElement>('[data-local-media-action="next-sentence"]')!.click();
        await flush();
        expect(playSpy).toHaveBeenCalled();

        document.querySelector<HTMLButtonElement>('[data-local-media-action="prev-sentence"]')!.click();
        await flush();
        document.querySelector<HTMLButtonElement>('[data-local-media-action="replay-sentence"]')!.click();
        await flush();
        document.querySelector<HTMLButtonElement>('[data-sentence-index="1"]')!.click();
        await flush();

        // 开启单句循环并越过句尾 + 触发媒体 ended，验证回跳至该句起点
        const loopBtn = document.querySelector<HTMLButtonElement>('[data-local-media-action="toggle-loop"]')!;
        loopBtn.click();
        await flush();
        expect(loopBtn.getAttribute('aria-pressed')).toBe('true');
        video.currentTime = 5.0;
        video.dispatchEvent(new window.Event('timeupdate'));
        await flush();
        expect(video.currentTime).toBeLessThan(3.5);
        video.currentTime = 5.0;
        video.dispatchEvent(new window.Event('ended'));
        await flush();
        expect(video.currentTime).toBeLessThan(3.5);

        // 切换为句末暂停并越过句尾，验证 pause 被调用；点击播放后释放句末暂停不再卡死
        const pauseBtn = document.querySelector<HTMLButtonElement>('[data-local-media-action="toggle-pause"]')!;
        pauseBtn.click();
        await flush();
        video.currentTime = 3.0;
        video.dispatchEvent(new window.Event('timeupdate'));
        await flush();
        expect(pauseSpy).not.toHaveBeenCalled();
        video.currentTime = 5.0;
        video.dispatchEvent(new window.Event('timeupdate'));
        await flush();
        expect(pauseSpy).toHaveBeenCalledOnce();
        // 再次触发 timeupdate 不重复暂停，ended 保持 pausedAtEnd
        video.dispatchEvent(new window.Event('timeupdate'));
        video.dispatchEvent(new window.Event('ended'));
        await flush();
        expect(pauseSpy).toHaveBeenCalledOnce();
        // 用户按下播放后自动解除句末暂停，不再卡在句尾
        video.dispatchEvent(new window.Event('play'));
        await flush();
        expect(pauseBtn.getAttribute('aria-pressed')).toBe('false');
        // 非 pausedAtEnd 状态下 play 不产生副作用
        video.dispatchEvent(new window.Event('play'));
        await flush();

        // 切换再关闭句末暂停并触发无命中区间的 timeupdate 与普通 ended
        pauseBtn.click();
        await flush();
        pauseBtn.click();
        await flush();
        expect(pauseBtn.getAttribute('aria-pressed')).toBe('false');
        video.currentTime = 2.0;
        video.dispatchEvent(new window.Event('timeupdate'));
        video.dispatchEvent(new window.Event('ended'));
        await flush();

        // 导出字幕：SRT / VTT / Markdown
        const exportModeSelect = document.querySelector<HTMLSelectElement>('[data-local-media-export-mode]')!;
        const exportFormatSelect = document.querySelector<HTMLSelectElement>('[data-local-media-export-format]')!;
        const exportBtn = document.querySelector<HTMLButtonElement>('[data-local-media-action="export"]')!;
        exportBtn.click();
        expect(downloadFile).toHaveBeenLastCalledWith('demo-bilingual.srt', expect.stringContaining('This is the first complete sentence.'), 'application/x-subrip;charset=utf-8');

        exportModeSelect.value = 'translated';
        exportModeSelect.dispatchEvent(new window.Event('change'));
        exportFormatSelect.value = 'vtt';
        exportFormatSelect.dispatchEvent(new window.Event('change'));
        await flush();
        exportBtn.click();
        expect(downloadFile).toHaveBeenLastCalledWith('demo-translated.vtt', expect.stringContaining('WEBVTT'), 'text/vtt;charset=utf-8');

        exportModeSelect.value = 'original';
        exportModeSelect.dispatchEvent(new window.Event('change'));
        exportFormatSelect.value = 'md';
        exportFormatSelect.dispatchEvent(new window.Event('change'));
        await flush();
        exportBtn.click();
        expect(downloadFile).toHaveBeenLastCalledWith('demo-original.md', expect.stringContaining('### '), 'text/markdown;charset=utf-8');

        // 重新转写为更短的 1 句字幕时自动重置 activeSentenceIndex，不越界崩溃
        sendMessage.mockImplementation(async (msg: unknown) => {
            const payload = msg as {type: string};
            if (payload.type === 'fluentReadGetLocalVideoModelState') {
                return {success: true, models: ['small'], available: {tiny: false, base: false, small: true}};
            }
            if (payload.type === 'fluentReadTranscribeLocalVideoAudio') {
                return {success: true, text: 'Only one sentence now.', segments: [{startMs: 0, endMs: 1800, text: 'Only one sentence now.'}]};
            }
            return {success: true};
        });
        document.querySelector<HTMLButtonElement>('[data-sentence-index="1"]')!.click();
        await flush();
        document.querySelector<HTMLButtonElement>('[data-local-media-action="transcribe"]')!.click();
        await vi.waitFor(() => expect(document.querySelectorAll('[data-sentence-index]').length).toBe(1));
        await flush();
        document.querySelector<HTMLButtonElement>('[data-local-media-action="replay-sentence"]')!.click();
        await flush();

        // 卸载组件自动清理会话并释放 Object URL
        unmount();
        unmountActive = undefined;
        expect(revokedUrls).toEqual(['blob:local-media/1']);
    });

    it('支持在转写中途点击取消按钮并展示各阶段状态文案，以及默认端口与相同译文去重', async () => {
        const config = vue.reactive(new Config());
        config.uiLanguage = 'zh-CN';
        config.to = 'en';
        config.videoTranslationEnabled = true;

        let resolveModels!: (value: unknown) => void;
        let resolveDecode!: (value: AudioBuffer) => void;
        let resolveAsr!: (value: unknown) => void;
        let resolveTranslate!: (value: string) => void;
        const speech = makeSpeechPcm(3);

        const sendMessage = vi.fn<(msg: unknown) => Promise<unknown>>((msg: unknown) => {
            const payload = msg as {type: string};
            if (payload.type === 'fluentReadGetLocalVideoModelState') {
                return new Promise(resolve => { resolveModels = resolve; });
            }
            if (payload.type === 'fluentReadTranscribeLocalVideoAudio') {
                return new Promise(resolve => { resolveAsr = resolve; });
            }
            return Promise.resolve({success: true});
        });

        const {document, window} = mountPanel({
            config,
            sendMessage,
            translateText: () => new Promise<string>(resolve => { resolveTranslate = resolve; }),
            decodePorts: {
                decodeAudioData: () => new Promise<AudioBuffer>(resolve => { resolveDecode = resolve; }),
            },
        });
        await flush();

        const input = document.querySelector<HTMLInputElement>('[data-local-media-input]')!;
        Object.defineProperty(input, 'files', {value: [makeFakeFile('voice.wav', 'audio/wav', 2048)], configurable: true});
        input.dispatchEvent(new window.Event('change', {bubbles: true}));
        await flush();

        // 1) checking -> decoding -> transcribing -> translating -> ready（含相同译文去重）
        document.querySelector<HTMLButtonElement>('[data-local-media-action="transcribe"]')!.click();
        await flush();
        expect(document.querySelector('[data-local-media-status]')?.textContent).toContain('检查本地语音模型');

        resolveModels({success: true, models: ['small'], available: {tiny: false, base: false, small: true}});
        await vi.waitFor(() => expect(resolveDecode).toBeTypeOf('function'));
        await flush();
        expect(document.querySelector('[data-local-media-status]')?.textContent).toContain('解码');

        resolveDecode({
            duration: 3,
            length: speech.length,
            numberOfChannels: 1,
            sampleRate: VIDEO_AI_SAMPLE_RATE,
            getChannelData: () => speech,
        } as unknown as AudioBuffer);
        await vi.waitFor(() => expect(resolveAsr).toBeTypeOf('function'));
        await flush();
        expect(document.querySelector('[data-local-media-status]')?.textContent).toContain('离线识别语音');

        config.to = 'zh-Hans';
        resolveAsr({success: true, text: 'Same text', segments: [{startMs: 0, endMs: 2500, text: 'Same text'}]});
        await vi.waitFor(() => expect(resolveTranslate).toBeTypeOf('function'));
        await flush();
        expect(document.querySelector('[data-local-media-status]')?.textContent).toContain('生成译文');

        resolveTranslate('Same text');
        await vi.waitFor(() => expect(document.querySelector('[data-local-media-status]')?.textContent).toContain('已生成'));
        await flush();

        const audio = document.querySelector<HTMLAudioElement>('audio[data-local-media-player]')!;
        Object.defineProperty(audio, 'currentTime', {value: 0.5, writable: true, configurable: true});
        audio.dispatchEvent(new window.Event('timeupdate'));
        await flush();
        expect(document.querySelector('[data-local-media-cue-source]')?.textContent).toBe('Same text');
        expect(document.querySelector('[data-local-media-cue-translation]')).toBeNull();

        // 2) 默认下载端口覆盖，然后再次转写并在中途点击取消按钮（且覆盖仅译文导出禁用态）
        document.querySelector<HTMLButtonElement>('[data-local-media-action="export"]')!.click();
        document.querySelector<HTMLButtonElement>('[data-local-media-action="transcribe"]')!.click();
        await flush();
        document.querySelector<HTMLButtonElement>('[data-local-media-action="cancel"]')!.click();
        await flush();
        expect(document.querySelector('[data-local-media-action="transcribe"]')).not.toBeNull();
    });

    it('使用默认运行时消息与翻译端口，覆盖空来源语言回退与无译文时导出守卫', async () => {
        const config = vue.reactive(new Config());
        config.uiLanguage = 'zh-CN';
        config.to = 'zh-Hans';
        config.videoSourceLanguage = '';
        config.videoTranslationEnabled = true;

        const {sendRuntimeMessage} = await import('@/src/platform/browser/runtimeMessages');
        const sendMock = vi.mocked(sendRuntimeMessage);
        sendMock.mockImplementation(async (msg: unknown) => {
            const payload = msg as {type: string};
            if (payload.type === 'fluentReadGetLocalVideoModelState') {
                return {success: true, models: ['small'], available: {tiny: false, base: false, small: true}};
            }
            if (payload.type === 'fluentReadTranscribeLocalVideoAudio') {
                return {success: true, text: 'Default port sentence.', segments: [{startMs: 0, endMs: 2500, text: 'Default port sentence.'}]};
            }
            return {success: true};
        });

        const speech = makeSpeechPcm(3);
        const {document, window} = mountPanel({
            config,
            decodePorts: {
                decodeAudioData: async () => ({
                    duration: 3,
                    length: speech.length,
                    numberOfChannels: 1,
                    sampleRate: VIDEO_AI_SAMPLE_RATE,
                    getChannelData: () => speech,
                } as unknown as AudioBuffer),
            },
        });
        await flush();

        const input = document.querySelector<HTMLInputElement>('[data-local-media-input]')!;
        Object.defineProperty(input, 'files', {value: [makeFakeFile('default.ogg', 'audio/ogg', 1024)], configurable: true});
        input.dispatchEvent(new window.Event('change', {bubbles: true}));
        await flush();

        // 仅原文模式不触发翻译 -> translatedCount === 0 -> 切换导出模式为 translated 时按钮禁用且点击被守卫
        document.querySelector<HTMLButtonElement>('[data-local-media-mode="original-only"]')!.click();
        await flush();

        document.querySelector<HTMLButtonElement>('[data-local-media-action="transcribe"]')!.click();
        await vi.waitFor(() => expect(document.querySelector('[data-local-media-status]')?.textContent).toContain('已生成'));
        await flush();

        // 零译文且零失败时按钮展示「立即翻译」而非「重试」
        const pendingBtnBefore = document.querySelector<HTMLButtonElement>('[data-local-media-action="translate-pending"]')!;
        expect(pendingBtnBefore.textContent?.trim()).toBe(translate('video.localMedia.translateNow', 'zh-CN'));

        const exportModeSelect = document.querySelector<HTMLSelectElement>('[data-local-media-export-mode]')!;
        exportModeSelect.value = 'translated';
        exportModeSelect.dispatchEvent(new window.Event('change'));
        await flush();
        const exportBtn = document.querySelector<HTMLButtonElement>('[data-local-media-action="export"]')!;
        expect(exportBtn.hasAttribute('disabled')).toBe(true);
        exportBtn.click();

        // 禁用态下补译按钮被禁用且直接点击被守卫
        config.videoTranslationEnabled = false;
        await flush();
        const retryPendingBtn = document.querySelector<HTMLButtonElement>('[data-local-media-action="translate-pending"]')!;
        expect(retryPendingBtn.hasAttribute('disabled')).toBe(true);
        retryPendingBtn.click();
        await flush();

        // 禁用态切换到仅译文时不自动触发补译，且无译文时字幕叠层不显示空黑框
        const audio = document.querySelector<HTMLAudioElement>('audio[data-local-media-player]')!;
        Object.defineProperty(audio, 'currentTime', {value: 0.5, writable: true, configurable: true});
        audio.dispatchEvent(new window.Event('timeupdate'));
        await flush();
        document.querySelector<HTMLButtonElement>('[data-local-media-mode="translation-only"]')!.click();
        await flush();
        expect(document.querySelector('[data-local-media-overlay]')).toBeNull();
        document.querySelector<HTMLButtonElement>('[data-local-media-mode="original-only"]')!.click();
        await flush();
        config.videoTranslationEnabled = true;
        await flush();

        // 从仅原文切换到双语时自动触发补译（走默认 translateVideoText 端口）
        document.querySelector<HTMLButtonElement>('[data-local-media-mode="bilingual"]')!.click();
        await vi.waitFor(() => expect(document.querySelector('[data-local-media-action="translate-pending"]')).toBeNull());
        await flush();

        // 从配置初始化显示模式（videoSubtitleVisible = false 时初始化为 off）
        const offConfig = vue.reactive(new Config());
        offConfig.videoTranslationEnabled = true;
        offConfig.videoSubtitleVisible = false;
        const offMounted = mountPanel({config: offConfig, active: true});
        await flush();
        const offInput = offMounted.document.querySelector<HTMLInputElement>('[data-local-media-input]')!;
        Object.defineProperty(offInput, 'files', {value: [makeFakeFile('off.mp3', 'audio/mpeg', 1024)], configurable: true});
        offInput.dispatchEvent(new offMounted.window.Event('change', {bubbles: true}));
        await flush();
        expect(offMounted.document.querySelector('[data-local-media-mode="off"]')?.getAttribute('aria-checked')).toBe('true');
        offMounted.unmount();

        // KeepAlive 失活与 active=false 均暂停播放并取消在途转写
        const keepAliveActive = vue.ref(true);
        let resolveModelWait!: (v: unknown) => void;
        const kaSend = vi.fn<(msg: unknown) => Promise<unknown>>(msg => {
            const payload = msg as {type: string};
            if (payload.type === 'fluentReadGetLocalVideoModelState') {
                return new Promise(resolve => { resolveModelWait = resolve; });
            }
            return Promise.resolve({success: true});
        });
        const kaDoc = parseHTML('<html><body><div id="ka-root"></div></body></html>');
        vi.stubGlobal('document', kaDoc.document);
        vi.stubGlobal('window', kaDoc.window);
        const kaRenderer = vue.createRenderer<Node, Element>({
            insert: (node, parent, anchor) => parent.insertBefore(node, anchor || null),
            remove: node => node.parentNode?.removeChild(node),
            createElement: tag => vue.markRaw(kaDoc.document.createElement(tag)),
            createText: value => kaDoc.document.createTextNode(value),
            createComment: value => kaDoc.document.createComment(value),
            setText: (node, value) => { node.nodeValue = value; },
            setElementText: (node, value) => { node.textContent = value; },
            parentNode: node => node.parentElement,
            nextSibling: node => node.nextSibling,
            patchProp: (node, key, previous, next) => {
                if (/^on[A-Z]/.test(key)) {
                    const event = key.slice(2).toLowerCase();
                    if (previous) node.removeEventListener(event, previous);
                    if (next) node.addEventListener(event, next);
                } else if (next == null || (next === false && !/^(aria-|data-)/.test(key))) {
                    node.removeAttribute(key);
                } else {
                    node.setAttribute(key, next === true && !/^(aria-|data-)/.test(key) ? '' : String(next));
                }
            },
        });
        const activeProp = vue.ref(true);
        const kaApp = kaRenderer.createApp({
            setup: () => () => vue.h(vue.KeepAlive, null, {
                default: () => keepAliveActive.value
                    ? vue.h(LocalMediaTranscriptionPanel, {config, active: activeProp.value, sendMessage: kaSend})
                    : null,
            }),
        });
        kaApp.mount(kaDoc.document.getElementById('ka-root')!);
        await flush();

        const kaInput = kaDoc.document.querySelector<HTMLInputElement>('[data-local-media-input]')!;
        Object.defineProperty(kaInput, 'files', {value: [makeFakeFile('ka.mp3', 'audio/mpeg', 2048)], configurable: true});
        kaInput.dispatchEvent(new kaDoc.window.Event('change', {bubbles: true}));
        await flush();

        const kaAudio = kaDoc.document.querySelector<HTMLAudioElement>('audio[data-local-media-player]')!;
        const kaPause = vi.fn();
        Object.defineProperty(kaAudio, 'pause', {value: kaPause, configurable: true});
        // 无句时触发 ended 安全返回
        kaAudio.dispatchEvent(new kaDoc.window.Event('ended'));
        await flush();

        // 1) KeepAlive 切离触发 onDeactivated -> 暂停播放并取消转写
        kaDoc.document.querySelector<HTMLButtonElement>('[data-local-media-action="transcribe"]')!.click();
        await flush();
        keepAliveActive.value = false;
        await flush();
        expect(kaPause).toHaveBeenCalledTimes(1);
        resolveModelWait({success: true, models: ['small'], available: {tiny: false, base: false, small: true}});
        await flush();

        // 2) 重新激活后通过 active=false 触发 watch(canOperate) -> 暂停播放并取消转写
        keepAliveActive.value = true;
        await flush();
        kaDoc.document.querySelector<HTMLButtonElement>('[data-local-media-action="transcribe"]')!.click();
        await flush();
        activeProp.value = false;
        await flush();
        expect(kaPause).toHaveBeenCalledTimes(2);
        activeProp.value = true;
        await flush();
        kaApp.unmount();
    });

    it('面板位于折叠的 details 内或节点脱离文档时，快捷键自动失效', async () => {
        const config = vue.reactive(new Config());
        config.uiLanguage = 'zh-CN';
        config.videoTranslationEnabled = true;
        config.videoSubtitleModeHotkeyEnabled = true;
        config.videoSubtitleModeHotkey = 'Alt+M';
        config.videoSubtitleModeHotkeyAction = 'bilingual-original';

        const {document, window, unmount} = mountPanel({config, active: true}, true);
        await flush();

        const input = document.querySelector<HTMLInputElement>('[data-local-media-input]')!;
        Object.defineProperty(input, 'files', {value: [makeFakeFile('folded.mp3', 'audio/mpeg', 1024)], configurable: true});
        input.dispatchEvent(new window.Event('change', {bubbles: true}));
        await flush();

        const dispatchAltM = async () => {
            const ev: any = new window.Event('keydown', {bubbles: true, cancelable: true});
            Object.defineProperty(ev, 'isTrusted', {value: true, configurable: true});
            Object.assign(ev, {
                key: 'm', code: 'KeyM', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false,
                repeat: false, isComposing: false,
            });
            ev.composedPath = () => [document.body];
            window.dispatchEvent(ev);
            await flush();
        };

        // 1) details 折叠状态下按快捷键无效
        await dispatchAltM();
        expect(document.querySelector('[data-local-media-mode="bilingual"]')?.getAttribute('aria-checked')).toBe('true');

        // 2) 展开 details 后快捷键生效
        const details = document.getElementById('wrapper-details')!;
        details.setAttribute('open', '');
        await dispatchAltM();
        expect(document.querySelector('[data-local-media-mode="original-only"]')?.getAttribute('aria-checked')).toBe('true');

        // 3) 面板节点脱离文档后快捷键无效
        document.querySelector('[data-local-media-studio]')!.remove();
        await dispatchAltM();
        expect(document.querySelector('[data-local-media-studio]')).toBeNull();

        unmount();
    });
});
