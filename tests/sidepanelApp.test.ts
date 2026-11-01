import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import * as vue from 'vue';
import SidepanelApp from '@/src/app/sidepanel/SidepanelApp.vue';

const ports = vi.hoisted(() => ({config: {theme: 'auto', interfaceSkin: 'default', interfaceFont: 'system'},
    settings: vi.fn(), createTab: vi.fn(), subscribe: vi.fn(), release: vi.fn(), releaseAppearance: vi.fn(),
    skin: vi.fn(), font: vi.fn(), register: vi.fn(), media: Object.assign(new EventTarget(), {matches: false}),
}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {getURL: (path: string) => 'chrome-extension://fixture/' + path, openOptionsPage: ports.settings}, tabs: {create: ports.createTab}}}));
vi.mock('@/src/services/config/store', () => ({config: ports.config, subscribeConfig: (...args: unknown[]) => ports.subscribe(...args)}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({t: (key: string) => key, translateLegacy: (text: string) => text})}));
vi.mock('@/src/ui/interfaceAppearance', () => ({applyInterfaceSkin: ports.skin, applyInterfaceFont: ports.font, registerInterfaceAppearanceRoot: (...args: unknown[]) => ports.register(...args)}));
vi.mock('@/src/ui/components/UiIcon.vue', () => ({default: {render: () => null}}));
vi.mock('@/src/features/translation-center/public', () => ({TranslationCenter: {props: ['surface'], emits: ['configure-service', 'configure-general'],
    setup: (props: {surface: string}, {emit}: any) => () => vue.h('section', {class: 'center-port', 'data-surface': props.surface}, [
        vue.h('button', {class: 'configure-service', onClick: () => emit('configure-service', 'custom:test with spaces')}, 'service'),
        vue.h('button', {class: 'configure-general', onClick: () => emit('configure-general')}, 'general'),
    ]),
}}));
let app: vue.App, host: HTMLElement, subscription: () => void;
async function click(selector: string) {host.querySelector<HTMLElement>(selector)!.click();await Promise.resolve();await vue.nextTick();}
beforeEach(() => {
    vi.clearAllMocks();ports.settings.mockReset().mockResolvedValue(undefined);ports.createTab.mockReset().mockResolvedValue(undefined);
    Object.assign(ports.config, {theme: 'auto', interfaceSkin: 'default', interfaceFont: 'system'});ports.media.matches = false;
    ports.subscribe.mockImplementation(fn => {subscription = fn;return ports.release;});ports.register.mockReturnValue(ports.releaseAppearance);
    const {document} = parseHTML('<html><body></body></html>');vi.stubGlobal('document', document);
    vi.stubGlobal('window', {matchMedia: () => ports.media});
    const renderer = vue.createRenderer<any, any>({
        createElement: tag => document.createElement(tag), createText: text => document.createTextNode(text), createComment: text => document.createComment(text),
        setText: (node, text) => {node.nodeValue = text;},setElementText: (node, text) => {node.textContent = text;},
        parentNode: node => node.parentNode, nextSibling: node => node.nextSibling, insert: (node, parent, anchor) => parent.insertBefore(node, anchor || null), remove: node => node.remove(),
        patchProp: (node, key, previous, next) => {if (key.startsWith('on')) {const event = key.slice(2).toLowerCase();if (previous) node.removeEventListener(event, previous);if (next) node.addEventListener(event, next);} else if (next == null) node.removeAttribute(key);else node.setAttribute(key, next);},
    });
    host = document.createElement('div');document.body.appendChild(host);app = renderer.createApp(SidepanelApp);app.mount(host);
});
afterEach(() => {app.unmount();vi.unstubAllGlobals();});

describe('translation sidepanel app composition', () => {
    it('shares the compact translation surface and opens normal or service-specific settings', async () => {
        expect(host.querySelector('.sidepanel-header h1')!.textContent).toBe('翻译中心');
        expect(host.querySelector('.center-port')!.getAttribute('data-surface')).toBe('sidebar');
        await click('.sidepanel-header button');expect(ports.settings).toHaveBeenCalledOnce();
        await click('.configure-service');expect(ports.createTab).toHaveBeenCalledWith({url: 'chrome-extension://fixture/options.html?service=custom%3Atest+with+spaces#settings-services'});
        await click('.configure-general');expect(ports.createTab).toHaveBeenLastCalledWith({url: 'chrome-extension://fixture/options.html#settings-general'});
    });
    it('syncs theme, skin and font, then releases the exact media and config subscriptions', () => {
        expect(ports.register).toHaveBeenCalledWith(document.documentElement);expect(ports.skin).toHaveBeenCalledWith('default');
        ports.media.matches = true;ports.media.dispatchEvent(new Event('change'));expect(document.documentElement.classList.contains('dark')).toBe(true);
        ports.config.theme = 'light';ports.config.interfaceSkin = 'qinghua';ports.config.interfaceFont = 'inter';subscription();
        expect(document.documentElement.classList.contains('dark')).toBe(false);expect(ports.font).toHaveBeenLastCalledWith('inter');expect(ports.skin).toHaveBeenLastCalledWith('qinghua');
        ports.config.theme = 'dark';subscription();expect(document.documentElement.classList.contains('dark')).toBe(true);
        app.unmount();app = {unmount() {}} as vue.App;
        expect(ports.release).toHaveBeenCalledOnce();expect(ports.releaseAppearance).toHaveBeenCalledOnce();
        const calls = ports.skin.mock.calls.length;ports.media.dispatchEvent(new Event('change'));expect(ports.skin).toHaveBeenCalledTimes(calls);
    });
    it('shows a navigation failure, permits retry and ignores a reply after unmount', async () => {
        ports.settings.mockRejectedValueOnce(new Error('closed'));await click('.sidepanel-header button');expect(host.querySelector('[role="alert"]')).not.toBeNull();
        await click('.sidepanel-header button');expect(host.querySelector('[role="alert"]')).toBeNull();
        let fail!: (error: Error) => void;ports.createTab.mockReturnValueOnce(new Promise((_, reject) => {fail = reject;}));
        const oldSettings = host.querySelector<HTMLButtonElement>('.sidepanel-header button')!;
        await click('.configure-service');app.unmount();app = {unmount() {}} as vue.App;oldSettings.click();expect(ports.settings).toHaveBeenCalledTimes(2);fail(new Error('late'));await Promise.resolve();
        expect(host.textContent).toBe('');
    });
});
