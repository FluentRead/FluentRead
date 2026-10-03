import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {describe, expect, it, vi} from 'vitest';
import {ungzip} from 'pako';
import {zhCNMessages} from '@/src/core/i18n/messages/zh-CN';
import {inflateWithPako} from '@/userscript/pakoRuntime';
import {
    executionGuardEnd,
    executionGuardStart,
    createUserscriptCatalogCompressionPlugin,
    findDexieGlobalRegistration,
    findFreeBrowserGlobals,
    injectUserscriptBrowserImports,
    userscriptAliases,
    wrapUserscriptEntry,
} from '@/userscript/vite.config';

const entrypointId = resolve(process.cwd(), 'entrypoints/userscript-injection-fixture.ts');
const sourceModuleId = resolve(process.cwd(), 'src/app/content/runtime.ts');
const vueScriptModuleId = `${resolve(process.cwd(), 'src/features/selection-translation/ui/SelectionTranslator.vue')}?vue&type=script&setup=true&lang.ts`;

describe('userscript browser shim injection', () => {
    it('embeds the complete Chinese fallback catalog as lossless static data', () => {
        const plugin = createUserscriptCatalogCompressionPlugin() as unknown as {
            resolveId: (source: string, importer: string) => string | null;
            load: (id: string) => string | null;
        };
        const id = plugin.resolveId('./messages/zh-CN', resolve(process.cwd(), 'src/core/i18n/index.ts'));
        expect(id).toBeTruthy();
        const moduleSource = plugin.load(id!);
        const base64 = moduleSource?.match(/atob\("([A-Za-z0-9+/=]+)"\)/u)?.[1];
        expect(base64).toBeTruthy();
        const restored = JSON.parse(gunzipSync(Buffer.from(base64!, 'base64')).toString('utf8'));
        expect(restored).toEqual(zhCNMessages);
        vi.stubGlobal('pako', {ungzip});
        try {
            expect(JSON.parse(inflateWithPako(new Uint8Array(Buffer.from(base64!, 'base64'))))).toEqual(zhCNMessages);
        } finally {
            vi.unstubAllGlobals();
        }
        expect(moduleSource).toContain(createHash('sha256').update(JSON.stringify(zhCNMessages)).digest('hex'));
    });

    it('keeps all site rule JSON data intact when embedding compressed offline catalogs', () => {
        const plugin = createUserscriptCatalogCompressionPlugin() as unknown as {
            resolveId: (source: string, importer: string) => string | null;
            load: (id: string) => string | null;
        };
        const importer = resolve(process.cwd(), 'src/core/site-adaptation/catalog.ts');
        for (const name of ['established', 'websites', 'profiles']) {
            const id = plugin.resolveId(`./catalog/${name}.json`, importer);
            expect(id).toContain('fluentread-userscript-site-catalog:');
            const moduleSource = plugin.load(id!);
            const base64 = moduleSource?.match(/atob\("([A-Za-z0-9+/=]+)"\)/u)?.[1];
            expect(base64).toBeTruthy();
            const original = JSON.parse(readFileSync(resolve(process.cwd(), `src/core/site-adaptation/catalog/${name}.json`), 'utf8'));
            const restored = JSON.parse(gunzipSync(Buffer.from(base64!, 'base64')).toString('utf8'));
            expect(restored).toEqual(original);
            expect(moduleSource).toContain(createHash('sha256').update(JSON.stringify(original)).digest('hex'));
        }
        expect(plugin.resolveId('./catalog/other.json', importer)).toBeNull();
    });

    it('wraps the complete single-file runtime in a duplicate-injection guard', () => {
        const wrapped = wrapUserscriptEntry('ENTRY_SENTINEL', 'BOOTSTRAP_SENTINEL');
        const guardStart = wrapped.indexOf(executionGuardStart);
        const condition = wrapped.indexOf('if (!globalThis.__fluentReadUserscriptBootstrapped) {');
        const bootstrap = wrapped.indexOf('BOOTSTRAP_SENTINEL');
        const entry = wrapped.indexOf('ENTRY_SENTINEL');
        const guardEnd = wrapped.indexOf(executionGuardEnd);

        expect(guardStart).toBeGreaterThan(-1);
        expect(condition).toBeGreaterThan(guardStart);
        expect(bootstrap).toBeGreaterThan(condition);
        expect(entry).toBeGreaterThan(bootstrap);
        expect(guardEnd).toBeGreaterThan(entry);
    });

    it('在 app 使用的 public contract 边界替换扩展专属 feature 与可信 GM 凭据上下文', () => {
        const stringAliases = new Map(userscriptAliases
            .filter((entry): entry is {find: string; replacement: string} => typeof entry.find === 'string')
            .map((entry) => [entry.find, entry.replacement]));

        for (const feature of ['area-translation', 'image-translation', 'video-subtitle']) {
            expect(stringAliases.get(`@/src/features/${feature}/public`)).toMatch(/userscript\/unsupportedCapabilities\.ts$/u);
        }
        expect(stringAliases.get('@/src/features/writing-assistant/public')).toMatch(/userscript\/writingAssistant\.ts$/u);
        expect(stringAliases.get('@/src/platform/storage/credentialContext')).toMatch(/userscript\/credentialContext\.ts$/u);
        expect(stringAliases.get('@/src/platform/storage/configStorageRuntime')).toMatch(/userscript\/storage\.ts$/u);
        expect(userscriptAliases.at(-1)?.find).toBe('@');
    });

    it('把 dexie 换成不注册全局单例的入口，且不改写 dexie 自身的实现产物路径', () => {
        const dexieAlias = userscriptAliases.find((entry) => entry.find instanceof RegExp
            && (entry.find as RegExp).test('dexie'));

        expect(dexieAlias?.replacement).toMatch(/userscript\/dexie\.ts$/u);
        // 别名必须严格匹配裸模块名；否则 userscript/dexie.ts 内部对实现产物的引用会被改写回自身。
        expect((dexieAlias!.find as RegExp).test('dexie/dist/dexie.min.js')).toBe(false);
    });

    it('产物中残留 Dexie 全局注册时能被构建守卫识别', () => {
        expect(findDexieGlobalRegistration('const s=Symbol.for("Dexie");globalThis[s]=D;')).toBe(true);
        expect(findDexieGlobalRegistration("globalThis[Symbol.for('Dexie')]=D;")).toBe(true);
        expect(findDexieGlobalRegistration('Symbol . for ( "Dexie" )')).toBe(true);
        expect(findDexieGlobalRegistration('Symbol.for("vercel.ai.schema")')).toBe(false);
        expect(findDexieGlobalRegistration('const label="Dexie";')).toBe(false);
    });

    it('imports only unresolved browser globals', () => {
        const transformed = injectUserscriptBrowserImports(
            'browser.runtime.sendMessage({}); chrome.runtime.getURL("icon.png");',
            entrypointId,
        );

        expect(transformed).toContain('import {default as browser, chrome}');

        expect(injectUserscriptBrowserImports(
            'browser.runtime.sendMessage({type: "from-app"});',
            sourceModuleId,
        )).toContain('import {default as browser}');
        expect(injectUserscriptBrowserImports(
            'chrome.runtime.getURL("from-vue.png");',
            vueScriptModuleId,
        )).toContain('import {chrome}');
    });

    it('ignores property names and lexically bound identifiers', () => {
        expect(injectUserscriptBrowserImports(
            'const extensionGlobal = {} as {browser?: unknown}; void extensionGlobal.browser;',
            entrypointId,
        )).toBeNull();
        expect(injectUserscriptBrowserImports(
            'function useBrowser(browser: {runtime: unknown}) { return browser.runtime; }',
            entrypointId,
        )).toBeNull();
        expect(injectUserscriptBrowserImports(
            'import chrome from "webextension-polyfill"; void chrome.runtime;',
            entrypointId,
        )).toBeNull();
        expect(injectUserscriptBrowserImports(
            'browser.runtime.sendMessage({});',
            '/tmp/fluentread-external-module.ts',
        )).toBeNull();
        expect(injectUserscriptBrowserImports(
            '<script setup>browser.runtime.sendMessage({})</script>',
            resolve(process.cwd(), 'src/RawComponent.vue'),
        )).toBeNull();
    });

    it('checks generated JavaScript for free extension globals', () => {
        const bundleId = resolve(process.cwd(), '.output/userscript/fluent-read.user.js');
        expect(findFreeBrowserGlobals(
            'const browser = {runtime: {}}; void browser.runtime; const chrome = browser; void chrome.runtime;',
            bundleId,
        )).toEqual([]);
        expect(findFreeBrowserGlobals(
            'browser.runtime.sendMessage({}); chrome.runtime.getURL("icon.png");',
            bundleId,
        )).toEqual(['browser', 'chrome']);
    });
});
