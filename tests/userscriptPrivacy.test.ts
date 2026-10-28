import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it, vi} from 'vitest';

function readSource(path: string): string {
    return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('standalone userscript privacy boundaries', () => {
    const userscriptStorage = readSource('userscript/storage.ts');
    const userscriptApi = readSource('userscript/api.ts');
    const userscriptCount = readSource('userscript/count.ts');
    const userscriptMain = readSource('userscript/main.ts');
    const userscriptHttp = readSource('userscript/http.ts');
    const translationCache = readSource('src/services/translation/cache.ts');
    const legacyPageCache = readSource('src/services/translation/legacyPageCache.ts');
    const gemini = readSource('src/providers/translation/gemini.ts');
    const httpError = readSource('src/platform/http/errors.ts');

    it('keeps userscript configuration in GM storage instead of host-page Web Storage', () => {
        expect(userscriptStorage).not.toMatch(/\b(?:localStorage|sessionStorage)\b/);
        expect(userscriptStorage).toContain("getUserscriptFunction('GM_getValue', 'getValue')");
        expect(userscriptStorage).toContain("getUserscriptFunction('GM_setValue', 'setValue')");
        expect(userscriptStorage).toContain("getUserscriptFunction('GM_deleteValue', 'deleteValue')");
        expect(userscriptApi).toContain('(globalThis as Record<string, unknown>)[legacyName]');
        expect(userscriptApi).toContain("typeof GM === 'undefined'");
    });

    it('计数副本只使用随机 GM 命名空间，不把页面证据或凭据写入键名', () => {
        expect(userscriptCount).toContain("'fluentread:count:v1:base:'");
        expect(userscriptCount).toContain("'fluentread:count:v1:replica:'");
        expect(userscriptCount).not.toMatch(/\b(?:location|localStorage|sessionStorage)\b/u);
        expect(userscriptCount).not.toMatch(/config\.(?:token|proxy|custom)\b/u);
    });

    it.each(['bootstrap failure', 'page exit'] as const)('初始化失败和页面离开都会释放消息、可见性与设置监听器：%s', async phase => {
        // 49F 已覆盖桥恢复、BFCache、清理异常与重试；这里验证旧隐私断言的公开事件/消息行为。
        // 只控制内容启动与外部端口，main、context、browser 的监听和分派实现均真实执行。
        vi.resetModules();
        const pageWindow = new EventTarget();
        const pageDocument = Object.assign(new EventTarget(), {readyState: 'complete', visibilityState: 'visible'});
        vi.stubGlobal('window', pageWindow);
        vi.stubGlobal('document', pageDocument);
        vi.stubGlobal('__FLUENTREAD_FULL_OPTIONS__', false);
        vi.stubGlobal('__fluentReadUserscriptBootstrapped', undefined);
        vi.stubGlobal('__fluentReadUserscriptCssCompressed', undefined);
        vi.stubGlobal('GM', undefined);
        vi.stubGlobal('GM_registerMenuCommand', undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const windowListeners = vi.spyOn(pageWindow, 'addEventListener');
        const documentListeners = vi.spyOn(pageDocument, 'addEventListener');
        const windowRemovals = vi.spyOn(pageWindow, 'removeEventListener');
        const documentRemovals = vi.spyOn(pageDocument, 'removeEventListener');
        const opens = vi.fn().mockResolvedValue(undefined);
        const closes = vi.fn();
        const count = vi.fn().mockResolvedValue(0);
        const translate = vi.fn().mockResolvedValue(undefined);
        const disposeBridge = vi.fn();
        let context: import('@/userscript/context').UserscriptContentContext | undefined;
        let resolveStart!: () => void;
        let rejectStart!: (error: Error) => void;
        const startup = new Promise<void>((resolve, reject) => {resolveStart = resolve; rejectStart = reject;});
        const start = vi.fn((ctx: NonNullable<typeof context>) => {context = ctx; return startup;});
        const mockedPaths = [
            '@/src/platform/shadow-ui/pageBridge', '@/src/platform/http/runtime', '@/userscript/http',
            '@/userscript/initialize', '@/userscript/storage', '@/userscript/count', '@/userscript/compression',
            '@/userscript/settings', '@/userscript/platform', '@/entrypoints/content',
            '@/src/app/content/features', '@/src/services/config/store',
        ];
        vi.doMock('@/src/platform/shadow-ui/pageBridge', () => ({installShadowAndRouteBridge: () => disposeBridge}));
        vi.doMock('@/src/platform/http/runtime', () => ({setRuntimeFetch: vi.fn()}));
        vi.doMock('@/userscript/http', () => ({userscriptFetch: vi.fn()}));
        vi.doMock('@/userscript/initialize', () => ({ensureUserscriptConfig: vi.fn().mockResolvedValue(undefined)}));
        vi.doMock('@/userscript/storage', () => ({
            completeUserscriptConfigPreparation: vi.fn(), failUserscriptConfigPreparation: vi.fn(),
            getStoredValue: vi.fn(), listStoredKeys: vi.fn(), setStoredValue: vi.fn(), storage: {watch: vi.fn()},
        }));
        vi.doMock('@/userscript/count', () => ({getUserscriptConfigCount: count}));
        vi.doMock('@/userscript/compression', () => ({inflateGzipBase64: vi.fn()}));
        vi.doMock('@/userscript/settings', () => ({openUserscriptSettings: opens, closeUserscriptSettings: closes}));
        vi.doMock('@/entrypoints/content', () => ({default: {main: start}}));
        vi.doMock('@/src/app/content/features', () => ({
            isFullPageTranslationActive: () => false, restoreOriginalContent: vi.fn(), autoTranslateEnglishPage: translate,
        }));
        vi.doMock('@/src/services/config/store', () => ({configReady: Promise.resolve(), config: {count: 0}, saveConfig: vi.fn()}));
        let pagehide: EventListenerOrEventListenerObject | null | undefined;
        const leavePage = () => {
            // Node 不能构造可信浏览器事件；调用实际注册的 listener，与 49F 的受控事件端口一致。
            const event = {type: 'pagehide', isTrusted: true, persisted: false} as PageTransitionEvent;
            if (typeof pagehide === 'function') pagehide(event);
            else pagehide?.handleEvent(event);
        };
        const exerciseEvents = () => {
            pageWindow.dispatchEvent(new Event('fluentread-userscript-open-settings'));
            pageWindow.dispatchEvent(new Event('fluentread-userscript-close-settings'));
            pageWindow.dispatchEvent(new Event('focus'));
            pageDocument.dispatchEvent(new Event('visibilitychange'));
        };
        try {
            const {default: adapter, UNHANDLED_RUNTIME_MESSAGE} = await import('@/userscript/browser');
            const platform = vi.fn(async (message: {type?: string}) => message?.type === 'privacy-platform-probe'
                ? {success: true} : UNHANDLED_RUNTIME_MESSAGE);
            vi.doMock('@/userscript/platform', () => ({createPlatformMessageHandler: () => platform}));
            await import('@/userscript/main');
            await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
            pagehide = windowListeners.mock.calls.find(([type]) => type === 'pagehide')?.[1];
            expect(pagehide).toBeTruthy();
            expect(context?.isInvalid).toBe(false);

            // 先证明同一组公开入口确实活跃，避免“从未装上监听器”也让清理测试通过。
            exerciseEvents();
            expect(opens).toHaveBeenCalledOnce(); expect(closes).toHaveBeenCalledOnce();
            expect(count).toHaveBeenCalledTimes(3);
            await expect(adapter.tabs.sendMessage(1, {type: 'userscriptTogglePageTranslation'})).resolves.toEqual({success: true});
            expect(translate).toHaveBeenCalledOnce();

            if (phase === 'bootstrap failure') {
                const failure = new Error('controlled privacy bootstrap failure');
                rejectStart(failure);
                await vi.waitFor(() => expect(globalThis.__fluentReadUserscriptBootstrapped).toBe(false));
            } else {
                resolveStart();
                await vi.waitFor(() => expect(platform).toHaveBeenCalledWith({type: 'userscriptCacheMaintenance'}));
                leavePage();
            }
            expect(context?.isInvalid).toBe(true);
            expect(disposeBridge).toHaveBeenCalledOnce();
            expect(closes).toHaveBeenCalledTimes(2);
            for (const type of ['fluentread-userscript-open-settings', 'fluentread-userscript-close-settings', 'focus', 'pagehide']) {
                const listener = windowListeners.mock.calls.find(([registered]) => registered === type)?.[1];
                expect(listener).toBeTruthy();
                expect(windowRemovals).toHaveBeenCalledWith(type, listener);
            }
            const visibilityListener = documentListeners.mock.calls.find(([type]) => type === 'visibilitychange')?.[1];
            expect(visibilityListener).toBeTruthy();
            expect(documentRemovals).toHaveBeenCalledWith('visibilitychange', visibilityListener);
            // 启动失败重置平台闭包；真正离页保留适配器供最后一次计数 flush。
            await expect(adapter.runtime.sendMessage({type: 'privacy-platform-probe'})).resolves.toEqual(
                phase === 'bootstrap failure' ? undefined : {success: true},
            );
            opens.mockClear(); closes.mockClear(); count.mockClear(); translate.mockClear();
            exerciseEvents();
            await expect(adapter.tabs.sendMessage(1, {type: 'userscriptTogglePageTranslation'})).resolves.toBeUndefined();
            expect(opens).not.toHaveBeenCalled(); expect(closes).not.toHaveBeenCalled();
            expect(count).not.toHaveBeenCalled(); expect(translate).not.toHaveBeenCalled();
        } finally {
            resolveStart();
            try {leavePage(); context?.invalidate();}
            finally {
                for (const path of mockedPaths) vi.doUnmock(path);
                vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules();
            }
        }
    });

    it('在共享配置 store 和内容应用就绪前完成 userscript 配置准备', () => {
        const ensureIndex = userscriptMain.indexOf('await ensureUserscriptConfig()');
        const releaseIndex = userscriptMain.indexOf('completeUserscriptConfigPreparation()');
        const dynamicImportIndex = userscriptMain.indexOf('const [platformModule');
        const contentMountIndex = userscriptMain.indexOf('await contentModule.default.main');

        expect(ensureIndex).toBeGreaterThan(-1);
        expect(releaseIndex).toBeGreaterThan(ensureIndex);
        expect(dynamicImportIndex).toBeGreaterThan(releaseIndex);
        expect(contentMountIndex).toBeGreaterThan(dynamicImportIndex);
        expect(userscriptMain).toContain('failUserscriptConfigPreparation(error)');
        expect(userscriptStorage).toContain('await waitForConfigPreparation()');
        expect(userscriptStorage).toContain('void waitForConfigPreparation().then');
    });

    it('migrates only FluentRead-owned legacy page-cache keys', () => {
        expect(legacyPageCache).not.toContain('.clear(');
        expect(legacyPageCache).toContain('key?.startsWith(LEGACY_TRANSLATION_CACHE_PREFIX)');
        expect(legacyPageCache).toContain('pageStorage.removeItem(LEGACY_CACHE_TIMESTAMP_KEY)');
        expect(legacyPageCache).not.toMatch(/(?:localStorage|sessionStorage)\.clear\(\)/);
    });

    it('uses per-entry hard TTL for the shared IndexedDB translation cache', () => {
        expect(translationCache).toContain('createdAt + TRANSLATION_CACHE_TTL_MS <= now');
        expect(translationCache).toContain('expiresAt: now + TRANSLATION_CACHE_TTL_MS');
        expect(translationCache).toContain(".or('createdAt')");
        expect(translationCache).toContain('belowOrEqual(now - TRANSLATION_CACHE_TTL_MS)');
        expect(translationCache).not.toContain('lastAccessedAt + TRANSLATION_CACHE_TTL_MS');
    });

    it('keeps the official Gemini key out of its URL and restricts automatic key headers to the official endpoint', () => {
        expect(gemini).not.toContain('generateContent?key=');
        expect(gemini).toContain("'x-goog-api-key'");
        expect(gemini).toContain('if (usesOfficialEndpoint)');
        expect(gemini).not.toContain('responseText');
    });

    it('does not reflect provider response bodies in transport errors', () => {
        const errorFunction = userscriptHttp.match(
            /function errorFromResponse\([\s\S]*?\n\}/,
        )?.[0] || '';
        expect(httpError).toContain('new Error(`${label}: ${response.status}`)');
        expect(httpError).toContain('throw new Error(label);');
        expect(httpError).not.toContain('response.text');
        expect(httpError).not.toContain('response.statusText');
        expect(userscriptHttp).toContain("response?.statusText || (response?.status ? `HTTP ${response.status}` : 'unknown error')");
        expect(errorFunction).toBeTruthy();
        expect(errorFunction).not.toContain('responseText');
    });

    it('uses the safe, abort-aware JSON reader for successful Gemini responses', () => {
        expect(gemini).toContain("readJsonResponse<any>(resp, 'Gemini 返回的不是有效 JSON', abortContext.signal)");
        expect(gemini).toContain('if (abortContext.signal.aborted) throw abortErrorFromSignal(abortContext.signal)');
        expect(gemini).not.toMatch(/JSON\.parse\(/);
        expect(httpError).toContain('catch {');
    });

    it('does not log provider credentials or raw response objects in the userscript transport', () => {
        expect(userscriptHttp).not.toMatch(/console\.(?:log|debug|info|warn|error)\(/);
        expect(httpError).not.toMatch(/console\.(?:log|debug|info|warn|error)\(/);
        expect(gemini).not.toMatch(/console\.(?:log|debug|info|warn|error)\(/);
    });
});
