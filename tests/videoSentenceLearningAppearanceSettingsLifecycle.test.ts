import './helpers/vueDomFixture';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// 执行真实 Vue 模板和共享设置布局；linkedom 只替代外部浏览器 DOM。
const dom = await vi.hoisted(async () => {
    const {parseHTML} = await import('linkedom');
    const parsed = parseHTML('<html><body></body></html>');
    Object.defineProperty(parsed.window.Node.prototype, Symbol.toStringTag, {configurable: true, get() {return this.constructor.name;}});
    for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'Event']) {
        Object.defineProperty(globalThis, key, {configurable: true, writable: true, value: (parsed.window as any)[key]});
    }
    Object.defineProperty(parsed.window, 'getSelection', {configurable: true, value: () => ({toString: () => ''})});
    return {document: parsed.document as unknown as Document, Event: parsed.window.Event};
});
const ports = vi.hoisted(() => ({locale: null as any}));
vi.mock('@/src/ui/i18n', async () => {
    const {ref} = await import('vue');
    const {translate} = await import('@/src/core/i18n');
    ports.locale = ref('zh-CN');
    return {useUiI18n: () => ({t: (key: string) => translate(key, ports.locale.value)})};
});
import {createApp, h, nextTick, reactive, type App} from 'vue';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {parseStoredConfig, serializeConfig} from '@/src/services/config/schema';
import {DEFAULT_VIDEO_SENTENCE_LEARNING_APPEARANCE} from '@/src/core/config/videoSentenceLearningAppearance';
import {registerAllUiLanguageBundles, UI_LANGUAGE_BUNDLES} from './helpers/uiLanguageBundles';
import {zhCNMessages} from '@/src/core/i18n/messages/zh-CN';
import {translate, translateLegacyText} from '@/src/core/i18n';
import Settings from '@/src/features/settings/ui/VideoSentenceLearningAppearanceSettings.vue';

registerAllUiLanguageBundles();
let app: App | undefined, root: HTMLElement, props: {config: Config};
async function settle(): Promise<void> {await nextTick(); await nextTick();}
async function mount(config = new Config()): Promise<void> {
    root = dom.document.createElement('div'); dom.document.body.append(root);
    props = reactive({config});
    app = createApp({setup: () => () => h(Settings, props)}); app.mount(root); await settle();
}
function event(element: Element, type: string): void {
    const value = new dom.Event(type, {bubbles: true});
    Object.assign(value, {_vts: Date.now() + 1}); element.dispatchEvent(value);
}
async function range(selector: string, value: number): Promise<void> {
    const input = root.querySelector<HTMLInputElement>(selector)!; input.value = String(value); event(input, 'input'); await settle();
}
async function click(selector: string): Promise<void> {event(root.querySelector(selector)!, 'click'); await settle();}
beforeEach(() => {ports.locale.value = 'zh-CN'; dom.document.body.replaceChildren();});
afterEach(() => {app?.unmount(); app = undefined; dom.document.body.replaceChildren();});

describe('完整句学习外观设置实际模板', () => {
    it('左预览右控件清晰分组，布局/内容字号/背景/宽度/四角即时更新且不改字幕样式', async () => {
        await mount();
        expect(root.querySelector('#video-sentence-learning-appearance')).not.toBeNull();
        const preview = root.querySelector<HTMLElement>('[data-video-learning-preview]')!;
        const scene = root.querySelector<HTMLElement>('[data-video-learning-preview-scene]')!;
        expect(root.querySelector('.settings-preview-example [data-video-learning-preview]')).toBe(preview);
        expect(root.querySelector('.settings-preview-controls [data-video-learning-width]')).not.toBeNull();
        expect(preview.dataset.layout).toBe('compact');
        expect(scene.dataset.position).toBe('top-right');
        expect(root.textContent).toContain('海獭有坚硬的牙齿。');
        const footer = preview.querySelector('footer')!;
        expect([...footer.children].map(node => node.textContent)).toEqual(['查看解释', '收藏此句']);
        expect(footer.querySelector('small')).toBeNull();
        const playback = preview.querySelector('[data-video-learning-preview-playback]')!;
        expect([...playback.children].map(node => node.textContent)).toEqual(['‹', '▷ 重播原句', '›']);
        expect(preview.querySelector('header')?.textContent).not.toContain('重播原句');
        expect(playback.parentElement?.lastElementChild).toBe(playback);
        expect(playback.parentElement?.nextElementSibling).toBe(footer);
        const subtitle = serializeConfig(props.config.videoSubtitleAppearance);
        await click('[data-video-learning-layout] [data-option-index="1"]');
        await range('[data-video-learning-opacity]', 71);
        await range('[data-video-learning-font-scale]', 120);
        await range('[data-video-learning-width]', 430);
        await click('[data-video-learning-position="bottom-left"]');
        expect(props.config.videoSentenceLearningAppearance).toEqual({layout: 'comfortable', backgroundOpacity: 71, fontScale: 120, width: 430, position: 'bottom-left'});
        expect(preview.dataset.layout).toBe('comfortable');
        expect(preview.querySelector('[data-video-learning-preview-playback]')).toBe(playback);
        expect(scene.dataset.position).toBe('bottom-left');
        expect(preview.style.getPropertyValue('--fluent-read-video-learning-background')).toBe('rgba(24,24,28,0.71)');
        expect(preview.style.getPropertyValue('--fluent-read-video-learning-original-font-size')).toBe('22.8px');
        expect(preview.style.getPropertyValue('--fluent-read-video-learning-width')).toBe('430px');
        expect(serializeConfig(props.config.videoSubtitleAppearance)).toBe(subtitle);
        expect(root.querySelector('[data-video-learning-opacity]')?.getAttribute('min')).toBe('60');
        expect(root.querySelector('[data-video-learning-width]')?.getAttribute('max')).toBe('520');
    });

    it('重开配置往返保留编辑，父级更换草稿后操作只改当前配置，恢复默认不改其他偏好', async () => {
        await mount();
        await range('[data-video-learning-width]', 470); await click('[data-video-learning-position="top-left"]');
        const persisted = serializeConfig(props.config);
        app!.unmount(); app = undefined;
        await mount(normalizeConfig(parseStoredConfig(persisted)));
        expect(props.config.videoSentenceLearningAppearance.width).toBe(470);
        expect(root.querySelector('[data-video-learning-preview-scene]')?.getAttribute('data-position')).toBe('top-left');
        const previous = props.config;
        props.config = normalizeConfig({videoSentenceLearningAppearance: {layout: 'comfortable', width: 410}, videoSubtitleAppearance: {fontScale: 250}});
        await settle(); await range('[data-video-learning-width]', 390);
        expect(previous.videoSentenceLearningAppearance.width).toBe(470);
        expect(props.config.videoSentenceLearningAppearance.width).toBe(390);
        await click('[data-video-learning-reset]');
        expect(props.config.videoSentenceLearningAppearance).toEqual(DEFAULT_VIDEO_SENTENCE_LEARNING_APPEARANCE);
        expect(props.config.videoSubtitleAppearance.fontScale).toBe(250);
        expect(root.querySelector('[data-video-learning-layout] [data-option-index="0"]')?.getAttribute('aria-checked')).toBe('true');
    });

    it('全部支持语言都有新分类与控件文案，切换语言会刷新布局/位置标签', async () => {
        const keys = Object.keys(zhCNMessages).filter(key => key.startsWith('video.learningAppearance.') || key === 'options.panel.videoLearning');
        expect(keys.length).toBe(20);
        for (const [locale, bundle] of Object.entries(UI_LANGUAGE_BUNDLES)) {
            for (const key of keys) {
                expect(bundle.messages[key]).toBeTruthy();
                expect(translate(key, locale as any)).not.toBe(key);
            }
            expect(translateLegacyText('完整句学习外观', locale as any)).toBe(bundle.messages['video.learningAppearance.title']);
        }
        await mount(); ports.locale.value = 'en-US'; await settle();
        expect(root.querySelector('[data-video-learning-layout]')?.textContent).toContain('Compact');
        expect(root.querySelector('[data-video-learning-position="bottom-left"]')?.textContent).toBe('Bottom left');
        expect(root.querySelector('[data-video-learning-opacity]')?.getAttribute('aria-label')).toBe('Background opacity');
    });
});
