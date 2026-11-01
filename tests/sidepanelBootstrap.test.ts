import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {mountTranslationSidepanel} from '@/src/app/sidepanel';

const ports = vi.hoisted(() => ({
    config: {uiLanguage: 'zh-CN', interfaceFont: 'system'}, ready: Promise.resolve(), hydration: 'ready',
    bundle: vi.fn(), font: vi.fn(), create: vi.fn(), use: vi.fn(), mount: vi.fn(), unmount: vi.fn(),
    plugin: vi.fn(), cleanup: undefined as (() => void) | undefined,
}));
vi.mock('vue', () => ({createApp: (...args: unknown[]) => ports.create(...args)}));
vi.mock('element-plus/es/components/base/style/css', () => ({}));
vi.mock('@/src/app/sidepanel/SidepanelApp.vue', () => ({default: {kind: 'sidepanel'}}));
vi.mock('@/src/services/config/store', () => ({config: ports.config, get configReady() {return ports.ready;}, getConfigHydrationStatus: () => ports.hydration}));
vi.mock('@/src/ui/i18n', () => ({createUiI18nPlugin: (...args: unknown[]) => ports.plugin(...args)}));
vi.mock('@/src/platform/i18n/uiLanguageBundles', () => ({ensureUiLanguageBundle: (...args: unknown[]) => ports.bundle(...args)}));
vi.mock('@/src/ui/interfaceAppearance', () => ({prepareInterfaceFont: (...args: unknown[]) => ports.font(...args)}));
const gate = () => {let resolve!: () => void;const promise = new Promise<void>(yes => {resolve = yes;});return {promise, resolve};};
let reload: ReturnType<typeof vi.fn>;
beforeEach(() => {
    vi.clearAllMocks();Object.assign(ports.config, {uiLanguage: 'zh-CN', interfaceFont: 'system'});
    ports.ready = Promise.resolve();ports.hydration = 'ready';ports.cleanup = undefined;
    ports.bundle.mockReset().mockResolvedValue(undefined);ports.font.mockReset().mockResolvedValue(undefined);
    ports.create.mockReturnValue({use: ports.use, mount: ports.mount, unmount: ports.unmount, onUnmount: (fn: () => void) => {ports.cleanup = fn;}});
    ports.unmount.mockImplementation(() => ports.cleanup?.());
    const {document} = parseHTML('<html><body><div id="app"></div></body></html>');
    vi.stubGlobal('document', document);reload = vi.fn();vi.stubGlobal('window', Object.assign(new EventTarget(), {location: {reload}}));
});
afterEach(() => {window.dispatchEvent(new Event('pagehide'));vi.unstubAllGlobals();});

describe('translation sidepanel bootstrap ownership', () => {
    it('prepares shared resources, mounts the page and unmounts only once on page exit', async () => {
        await mountTranslationSidepanel('#app');
        expect(ports.bundle).toHaveBeenCalledWith('zh-CN');expect(ports.font).toHaveBeenCalledWith('system');
        expect(ports.plugin).toHaveBeenCalledWith({documentRoot: document.body, documentTitleKey: 'sidepanel.title'});
        expect(ports.mount).toHaveBeenCalledWith('#app');
        window.dispatchEvent(new Event('pagehide'));window.dispatchEvent(new Event('pagehide'));
        expect(ports.unmount).toHaveBeenCalledOnce();
    });
    it('releases the page listener when the Vue app is explicitly unmounted', async () => {
        await mountTranslationSidepanel('#app');ports.cleanup!();
        window.dispatchEvent(new Event('pagehide'));expect(ports.unmount).not.toHaveBeenCalled();
    });
    it.each(['config', 'assets'])('does not mount late after closing during %s loading', async phase => {
        const pending = gate();if (phase === 'config') ports.ready = pending.promise;else ports.bundle.mockReturnValueOnce(pending.promise);
        const mounting = mountTranslationSidepanel('#app');
        if (phase === 'assets') await vi.waitFor(() => expect(ports.bundle).toHaveBeenCalledOnce());
        window.dispatchEvent(new Event('pagehide'));pending.resolve();await mounting;expect(ports.create).not.toHaveBeenCalled();
    });
    it('rechecks changing language and font while keeping unchanged resource preparation', async () => {
        const first = gate(), second = gate();ports.bundle.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const pending = mountTranslationSidepanel('#app');await vi.waitFor(() => expect(ports.bundle).toHaveBeenCalledOnce());
        ports.config.uiLanguage = 'en-US';first.resolve();await vi.waitFor(() => expect(ports.bundle).toHaveBeenCalledTimes(2));
        expect(ports.font).toHaveBeenCalledOnce();ports.config.interfaceFont = 'inter';second.resolve();await pending;
        expect(ports.bundle).toHaveBeenCalledTimes(2);expect(ports.font).toHaveBeenLastCalledWith('inter');expect(ports.mount).toHaveBeenCalledOnce();
    });
    it.each(['initial', 'after-assets', 'rejection'])('shows localized retry after %s hydration failure', async stage => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        if (stage === 'initial') ports.hydration = 'blocked';
        if (stage === 'after-assets') ports.bundle.mockImplementationOnce(async () => {ports.hydration = 'blocked';});
        if (stage === 'rejection') ports.ready = Promise.reject(new Error('storage failed'));
        await mountTranslationSidepanel('#app');
        expect(ports.mount).not.toHaveBeenCalled();expect(document.querySelector('[role="alert"]')?.textContent).toContain('加载失败');
        document.querySelector('button')!.click();expect(reload).toHaveBeenCalledOnce();expect(error).toHaveBeenCalledOnce();error.mockRestore();
    });
    it('consumes a late startup failure after page exit without touching the closed document', async () => {
        let reject!: (error: Error) => void;ports.ready = new Promise<void>((_, no) => {reject = no;});
        const error = vi.spyOn(console, 'error');const pending = mountTranslationSidepanel('#app');
        await Promise.resolve();await Promise.resolve();
        window.dispatchEvent(new Event('pagehide'));reject(new Error('late failure'));await pending;
        expect(error).not.toHaveBeenCalled();expect(document.querySelector('[role="alert"]')).toBeNull();error.mockRestore();
    });

});
