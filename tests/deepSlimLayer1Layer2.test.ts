import {afterEach, describe, expect, it, vi} from 'vitest';
import {createHash, webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {
    buildGithubAssetMirrorUrls,
    buildNpmAssetMirrorUrls,
    demoteMirrorOrigin,
    detectPreferredMirrorLocale,
    isChinaPreferredLocale,
    orderMirrorUrls,
    rememberPreferredMirrorOrigin,
    resetPreferredMirrorOrigins,
} from '@/src/core/assets/mirrors';
import {
    canUseVerifiedAssetCache,
    downloadVerifiedAsset,
    fetchVerifiedAsset,
    readVerifiedCachedAsset,
} from '@/src/platform/assets/verifiedAssetCache';
import {
    clearPdfBinaryDataMemoryCache,
    createPdfBinaryDataFactory,
    PDFJS_REMOTE_ASSET_VERSION,
} from '@/src/features/document-translation/services/pdfBinaryDataFactory';
import pdfBinaryDataManifest from '@/src/features/document-translation/services/pdfBinaryDataManifest.json';
import {createUiLanguageBundleFiles} from '@/src/core/i18n/bundles';
import {
    createDeltaUiLanguageBundle,
    EXTENSION_I18N_BASE_REVISION,
    getRemoteLanguageBaseUrls,
    isDeltaUiLanguageBundle,
    mergeDeltaUiLanguageBundle,
    REMOTE_LANGUAGE_BASE_ASSETS,
    type DeltaUiLanguageBundle,
    type RemoteDeltaUiLanguage,
} from '@/src/core/i18n/remoteLanguagePacks';
import {createExtensionUiLanguageBundleFiles} from '@/scripts/i18n/extensionLanguageBundles';
import {
    clearPinnedRemoteUiLanguageBaseCache,
    createUiLanguageBundleLoader,
    isExtensionOriginContext,
    loadPinnedRemoteUiLanguageBase,
    UI_LANGUAGE_BASE_MESSAGE_TYPE,
} from '@/src/platform/i18n/uiLanguageBundles';
import {createUiLanguageBaseHandler} from '@/src/app/background/handlers/uiLanguageBase';
import {hasUiLanguageBundle, translate, translateLegacyText, type UiLanguageBundle} from '@/src/core/i18n';
import * as fullDomain from '@/src/core/site-rules/domain';
import * as subframeDomain from '@/src/core/site-rules/subframeDomain';
import {scopedChineseCatalogBuildPlugin, selectReachableChineseMessages} from '@/scripts/i18n/scopedChineseCatalogPlugin';
import {
    extendScopedChineseCatalogBuildConfig,
    extendSubframeSiteCatalogBuildConfig,
    extendSubframeSiteRulesBuildConfig,
    subframeSiteCatalogBuildPlugin,
    subframeSiteRulesBuildPlugin,
} from '@/wxt.config';

const PROJECT_ROOT = resolve(__dirname, '..');

function makeCacheStub() {
    const store = new Map<string, Response>();
    const cache = {
        match: async (key: string) => store.get(key)?.clone(),
        put: async (key: string, value: Response) => { store.set(key, value.clone()); },
        delete: async (key: string) => store.delete(key),
    };
    return {store, cache, openCache: async () => cache};
}

function sha256Hex(data: Uint8Array): string {
    return createHash('sha256').update(data).digest('hex');
}

afterEach(() => {
    resetPreferredMirrorOrigins();
    clearPdfBinaryDataMemoryCache();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('multi-mirror pure-data asset platform', () => {
    it('orders China and Global mirrors by locale and promotes the last working mirror origin', () => {
        expect(isChinaPreferredLocale('zh-CN')).toBe(true);
        expect(isChinaPreferredLocale('zh-Hans')).toBe(true);
        expect(isChinaPreferredLocale('en-US')).toBe(false);

        const chinaNpm = buildNpmAssetMirrorUrls('pdfjs-dist', '6.5.438', 'cmaps/UniGB-UTF16-H.bcmap', 'zh-CN');
        expect(chinaNpm).toEqual([
            'https://cdn.jsdmirror.com/npm/pdfjs-dist@6.5.438/cmaps/UniGB-UTF16-H.bcmap',
            'https://jsd.onmicrosoft.cn/npm/pdfjs-dist@6.5.438/cmaps/UniGB-UTF16-H.bcmap',
            'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/cmaps/UniGB-UTF16-H.bcmap',
            'https://unpkg.com/pdfjs-dist@6.5.438/cmaps/UniGB-UTF16-H.bcmap',
        ]);

        const globalGithub = buildGithubAssetMirrorUrls('FluentRead/FluentRead', 'deadbeef', 'public/ecdict-core.json', 'en-US');
        expect(globalGithub[0]).toContain('cdn.jsdelivr.net');
        expect(globalGithub[1]).toContain('raw.githubusercontent.com');
        expect(globalGithub[2]).toContain('cdn.jsdmirror.com');
        expect(globalGithub[3]).toContain('jsd.onmicrosoft.cn');

        rememberPreferredMirrorOrigin('https://jsd.onmicrosoft.cn/npm/pdfjs-dist@6.5.438/cmaps/a.bcmap');
        const reordered = orderMirrorUrls(globalGithub);
        expect(reordered[0]).toContain('jsd.onmicrosoft.cn');
        expect(reordered).toHaveLength(4);
    });

    it('verifies exact byte length and SHA-256, fails over across mirrors, caches and self-heals corrupt cache', async () => {
        const payload = new TextEncoder().encode('{"ok":true,"asset":"verified"}');
        const digest = sha256Hex(payload);
        const {store, openCache} = makeCacheStub();
        const spec = {
            id: 'test-asset',
            cacheName: 'test-cache',
            cacheKey: `https://fluentread.app/__optional_assets__/test/${digest}.json`,
            bytes: payload.byteLength,
            sha256: digest,
            contentType: 'application/json',
            urls: [
                'https://cdn.jsdmirror.com/gh/example/repo@1/a.json',
                'https://jsd.onmicrosoft.cn/gh/example/repo@1/a.json',
                'https://cdn.jsdelivr.net/gh/example/repo@1/a.json',
            ],
        };

        // Pre-seed corrupt cache entry to verify automatic self-healing eviction.
        store.set(spec.cacheKey, new Response(new Uint8Array(payload.byteLength)));
        expect(await readVerifiedCachedAsset(spec, {openCache, digest: data => webcrypto.subtle.digest('SHA-256', data)})).toBeNull();
        expect(store.size).toBe(0);

        const requested: string[] = [];
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            requested.push(url);
            if (requested.length === 1) return new Response('<html>blocked</html>', {status: 200, headers: {'Content-Type': 'text/html'}});
            if (requested.length === 2) return new Response(new Uint8Array(payload.byteLength + 5), {status: 200});
            return new Response(payload, {status: 200, headers: {'Content-Type': 'application/json'}});
        });

        const bytes = await fetchVerifiedAsset(spec, {
            fetch: fetchMock as typeof fetch,
            openCache,
            digest: data => webcrypto.subtle.digest('SHA-256', data),
        });
        expect(Buffer.from(bytes).toString('utf8')).toBe('{"ok":true,"asset":"verified"}');
        expect(requested).toHaveLength(3);
        expect(store.size).toBe(1);

        // Subsequent read hits CacheStorage without network.
        const fromCache = await fetchVerifiedAsset(spec, {
            fetch: vi.fn(() => { throw new Error('should not fetch when cached'); }) as unknown as typeof fetch,
            openCache,
            digest: data => webcrypto.subtle.digest('SHA-256', data),
        });
        expect(Buffer.from(fromCache).equals(Buffer.from(payload))).toBe(true);
    });
});

describe('PDF.js pinned binary data factory', () => {
    it('matches every pinned cmap and standard font in node_modules/pdfjs-dist byte-for-byte', () => {
        const pkg = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'node_modules/pdfjs-dist/package.json'), 'utf8'));
        expect(PDFJS_REMOTE_ASSET_VERSION).toBe(pkg.version);
        expect(Object.keys(pdfBinaryDataManifest.cmaps)).toHaveLength(168);
        expect(Object.keys(pdfBinaryDataManifest.standard_fonts)).toHaveLength(14);
        for (const [name, meta] of Object.entries(pdfBinaryDataManifest.standard_fonts)) {
            const bytes = readFileSync(resolve(PROJECT_ROOT, 'node_modules/pdfjs-dist/standard_fonts', name));
            expect(bytes.byteLength).toBe(meta.bytes);
            expect(sha256Hex(bytes)).toBe(meta.sha256);
        }
    });

    it('keeps wasmUrl strictly local and loads cmaps/fonts via verified mirrors returning independent buffers', async () => {
        const fontName = 'FoxitSymbol.pfb';
        const fontBytes = new Uint8Array(readFileSync(resolve(PROJECT_ROOT, 'node_modules/pdfjs-dist/standard_fonts', fontName)));
        const {openCache} = makeCacheStub();
        const localFetch = vi.fn(async (input: RequestInfo | URL) => {
            expect(String(input)).toBe('chrome-extension://id/pdfjs/wasm/openjpeg.wasm');
            return new Response(new Uint8Array([0x00, 0x61, 0x73, 0x6d]));
        });
        const remoteFetch = vi.fn(async (input: RequestInfo | URL) => {
            expect(String(input)).toContain(`pdfjs-dist@${PDFJS_REMOTE_ASSET_VERSION}/standard_fonts/${fontName}`);
            return new Response(fontBytes);
        });

        const Factory = createPdfBinaryDataFactory({
            locale: () => 'zh-CN',
            localFetch: localFetch as typeof fetch,
            deps: {
                fetch: remoteFetch as typeof fetch,
                openCache,
                digest: data => webcrypto.subtle.digest('SHA-256', data),
            },
        });
        const instance = new Factory({
            cMapUrl: 'chrome-extension://id/pdfjs/cmaps/',
            standardFontDataUrl: 'chrome-extension://id/pdfjs/standard_fonts/',
            wasmUrl: 'chrome-extension://id/pdfjs/wasm/',
        });

        const wasm = await instance.fetch({kind: 'wasmUrl', filename: 'openjpeg.wasm'});
        expect(Array.from(wasm)).toEqual([0x00, 0x61, 0x73, 0x6d]);
        expect(localFetch).toHaveBeenCalledOnce();
        expect(remoteFetch).not.toHaveBeenCalled();

        const first = await instance.fetch({kind: 'standardFontDataUrl', filename: fontName});
        const second = await instance.fetch({kind: 'standardFontDataUrl', filename: fontName});
        expect(first.byteLength).toBe(fontBytes.byteLength);
        expect(first.buffer).not.toBe(second.buffer);
        expect(remoteFetch).toHaveBeenCalledOnce();

        await expect(instance.fetch({kind: 'cMapUrl', filename: '../escape.bcmap'})).rejects.toThrow(/Invalid/);
        await expect(instance.fetch({kind: 'cMapUrl', filename: 'unknown.bcmap'})).rejects.toThrow(/Unsupported/);
    });
});

describe('delta UI language packs', () => {
    it('keeps en-US and zh-TW full locally and reconstructs all 5 remote-base languages identically to full bundles', () => {
        const fullFiles = new Map(createUiLanguageBundleFiles().map(item => [item.relativeDest, JSON.parse(item.contents)]));
        const extFiles = createExtensionUiLanguageBundleFiles(PROJECT_ROOT);
        expect(extFiles).toHaveLength(7);

        for (const {relativeDest, contents} of extFiles) {
            const parsed = JSON.parse(contents);
            if (relativeDest === 'i18n/en-US.json' || relativeDest === 'i18n/zh-TW.json') {
                expect(isDeltaUiLanguageBundle(parsed)).toBe(false);
                expect(parsed).toEqual(fullFiles.get(relativeDest));
                continue;
            }
            expect(isDeltaUiLanguageBundle(parsed)).toBe(true);
            const language = relativeDest.slice('i18n/'.length, -'.json'.length) as RemoteDeltaUiLanguage;
            const baseline = JSON.parse(readFileSync(resolve(PROJECT_ROOT, REMOTE_LANGUAGE_BASE_ASSETS[language].path), 'utf8'));
            const reconstructed = mergeDeltaUiLanguageBundle(baseline, parsed);
            expect(reconstructed).toEqual(fullFiles.get(relativeDest));
        }
    });

    it('loads delta-v1 language bundles through createUiLanguageBundleLoader and registers merged translations', async () => {
        const extFiles = new Map(createExtensionUiLanguageBundleFiles(PROJECT_ROOT).map(item => [item.relativeDest, JSON.parse(item.contents)]));
        const jaDelta = extFiles.get('i18n/ja-JP.json');
        const jaBase = JSON.parse(readFileSync(resolve(PROJECT_ROOT, REMOTE_LANGUAGE_BASE_ASSETS['ja-JP'].path), 'utf8'));

        const loadRemoteBase = vi.fn(async () => jaBase);
        const ensure = createUiLanguageBundleLoader({
            resolveUrl: path => `chrome-extension://id/${path}`,
            fetch: async () => ({ok: true, status: 200, json: async () => jaDelta}),
            warn: vi.fn(),
            loadRemoteBase,
        });

        await expect(ensure('ja-JP')).resolves.toBe(true);
        expect(loadRemoteBase).toHaveBeenCalledOnce();
        expect(hasUiLanguageBundle('ja-JP')).toBe(true);
        expect(translate('common.brand', 'ja-JP')).toBe('FluentRead');
        expect(translateLegacyText('查看原网页', 'ja-JP')).not.toBe('查看原网页');
    });
});

describe('subframe site rules and scoped Chinese catalog plugins', () => {
    it('matches background-normalized domains identically to full tldts rules without PSL trie', () => {
        const normalizedList = fullDomain.normalizeSiteDomains([
            'https://mail.163.com/js6/main.jsp',
            'https://sub.example.co.uk/page',
            'https://user.github.io/docs',
            'http://localhost:3000',
            'http://127.0.0.1:8080',
        ]);
        const cases = [
            'https://sub.mail.163.com/read',
            'https://my163.com/',
            'https://deep.sub.example.co.uk/a',
            'https://other.co.uk/',
            'https://a.user.github.io/x',
            'https://other.github.io/x',
            'http://localhost:5173/',
            'http://127.0.0.1/path',
            'http://127.0.0.2/path',
        ];
        for (const url of cases) {
            expect(subframeDomain.isExtensionDisabledOnSite(url, normalizedList), url)
                .toBe(fullDomain.isExtensionDisabledOnSite(url, normalizedList));
        }

        const matcher = subframeDomain.createSiteRuleMatcher({
            on: true,
            autoTranslate: false,
            alwaysTranslateDomains: normalizedList,
            disabledExtensionDomains: ['163.com'],
        });
        expect(matcher.isExtensionDisabled('https://mail.163.com/x')).toBe(true);
        expect(matcher.shouldAutoTranslate('https://mail.163.com/x')).toBe(false);
        expect(matcher.shouldAutoTranslate('https://docs.example.co.uk/x')).toBe(true);
        expect(matcher.shouldAutoTranslate('https://unrelated.org/x')).toBe(false);
    });

    it('keeps referenced keys, plurals, dynamic prefixes and Chinese legacy strings while pruning unreachable page copy', () => {
        const code = [
            'const a = t("popup.compact.translate");',
            'const b = t(`sidepanel.${name}`);',
            'const c = "工具栏图标点击行为";',
        ].join('\n');
        const selected = selectReachableChineseMessages(code);
        expect(selected['popup.compact.translate']).toBe('翻译');
        expect(selected['sidepanel.title']).toBe('侧边栏翻译');
        expect(selected['toolbar.click.label']).toBe('工具栏图标点击行为');
        expect(selected['settings.headers.title']).toBeUndefined();
        expect(Object.keys(selected).length).toBeLessThan(100);
    });

    it('attaches subframe site rules only to subframe scripts and scoped zh-CN only to content/background', () => {
        const subConfig: {plugins?: unknown[]} = {};
        extendSubframeSiteRulesBuildConfig([{type: 'content-script', name: 'youtubeEmbed'}], subConfig);
        expect(subConfig.plugins).toHaveLength(1);

        const topConfig: {plugins?: unknown[]} = {};
        extendSubframeSiteRulesBuildConfig([{type: 'content-script', name: 'content'}], topConfig);
        expect(topConfig.plugins).toBeUndefined();

        const plugin = subframeSiteRulesBuildPlugin();
        expect(plugin.resolveId('@/src/core/site-rules/domain')).toContain('subframeDomain.ts');
        expect(plugin.resolveId('../site-rules/domain', '/repo/src/core/config/writing.ts')).toContain('subframeDomain.ts');
        expect(plugin.resolveId('./other', '/repo/src/core/config/writing.ts')).toBeNull();

        const bgConfig: {plugins?: unknown[]} = {};
        extendScopedChineseCatalogBuildConfig([{type: 'background'}], bgConfig);
        expect(bgConfig.plugins).toHaveLength(1);

        const pagesConfig: {plugins?: unknown[]} = {};
        extendScopedChineseCatalogBuildConfig([{type: 'popup'}, {type: 'options'}], pagesConfig);
        expect(pagesConfig.plugins).toBeUndefined();

        const bridgeConfig: {plugins?: unknown[]} = {};
        extendScopedChineseCatalogBuildConfig([{type: 'content-script', name: 'youtubeBridge'}], bridgeConfig);
        expect(bridgeConfig.plugins).toBeUndefined();

        const namelessContentConfig: {plugins?: unknown[]} = {};
        extendScopedChineseCatalogBuildConfig([{type: 'content-script'}], namelessContentConfig);
        expect(namelessContentConfig.plugins).toHaveLength(1);

        // Verify generateBundle replaces double, single, and backtick-quoted sentinels (Rolldown minifier uses backticks).
        const pluginInstance = scopedChineseCatalogBuildPlugin();
        const generateBundle = pluginInstance.generateBundle as (options: unknown, bundle: Record<string, {type: string; fileName: string; code: string}>) => void;
        for (const quote of ['"', "'", '`'] as const) {
            const bundle = {
                'test.js': {
                    type: 'chunk',
                    fileName: 'test.js',
                    code: `const catalog = JSON.parse(${quote}__FLUENTREAD_SCOPED_ZH_CN_CATALOG__${quote}); const k = "popup.compact.translate";`,
                },
            };
            generateBundle({}, bundle);
            expect(bundle['test.js'].code).not.toContain('__FLUENTREAD_SCOPED_ZH_CN_CATALOG__');
            const parsed = new Function(`${bundle['test.js'].code}; return catalog;`)() as Record<string, string>;
            expect(parsed['popup.compact.translate']).toBe('翻译');
            expect(parsed['settings.headers.title']).toBeUndefined();
        }
    });
});

describe('deep slim Layer 1 + Layer 2 edge branches and contracts', () => {
    it('covers mirror locale detection, deduplication, invalid URLs, and LRU preferred origin cap', () => {
        vi.stubGlobal('navigator', undefined);
        expect(detectPreferredMirrorLocale()).toBe('zh-CN');
        vi.stubGlobal('navigator', {language: 'en-US'});
        expect(detectPreferredMirrorLocale()).toBe('en-US');

        expect(buildNpmAssetMirrorUrls('pkg', '1.0.0', '/a/b.bin', 'en-US')[0]).toBe('https://cdn.jsdelivr.net/npm/pkg@1.0.0/a/b.bin');
        expect(buildGithubAssetMirrorUrls('org/repo', 'abc', '/dir/file.json', 'zh-CN')[0]).toBe('https://cdn.jsdmirror.com/gh/org/repo@abc/dir/file.json');

        // Single URL & duplicates without preferred origins.
        expect(orderMirrorUrls(['https://a.example/x', 'https://a.example/x'])).toEqual(['https://a.example/x']);

        // Invalid URL in rememberPreferredMirrorOrigin is ignored.
        rememberPreferredMirrorOrigin('not a url');

        // Fill preferredOrigins beyond 8 entries and test re-promoting index 0 and index > 0.
        for (let i = 0; i < 10; i += 1) {
            rememberPreferredMirrorOrigin(`https://m${i}.example/a`);
        }
        rememberPreferredMirrorOrigin('https://m9.example/b'); // index 0 no-op
        rememberPreferredMirrorOrigin('https://m5.example/c'); // index > 0 promoted

        const ordered = orderMirrorUrls([
            'not-a-valid-url',
            'https://unranked.example/a',
            'https://m9.example/a',
            'https://m5.example/a',
            'https://m5.example/a',
        ]);
        expect(ordered).toEqual([
            'https://m5.example/a',
            'https://m9.example/a',
            'not-a-valid-url',
            'https://unranked.example/a',
        ]);
    });

    it('covers verifiedAssetCache spec validation, abort paths, error branches, and concurrent deduplication', async () => {
        const payload = new TextEncoder().encode('verified-payload-1234');
        const digestHex = sha256Hex(payload);
        const baseSpec = {
            id: 'edge-asset',
            cacheName: 'edge-cache',
            cacheKey: `https://fluentread.app/__optional_assets__/edge/${digestHex}.bin`,
            bytes: payload.byteLength,
            sha256: digestHex,
            contentType: 'application/octet-stream',
            urls: ['https://cdn.jsdelivr.net/gh/example/repo@1/edge.bin'],
        };

        // Spec validation failures.
        await expect(readVerifiedCachedAsset({...baseSpec, id: ''})).rejects.toThrow(/Invalid verified asset spec/);
        await expect(readVerifiedCachedAsset({...baseSpec, bytes: 0})).rejects.toThrow(/Invalid verified asset spec/);
        await expect(readVerifiedCachedAsset({...baseSpec, sha256: 'bad'})).rejects.toThrow(/Invalid verified asset spec/);
        await expect(readVerifiedCachedAsset({...baseSpec, urls: []})).rejects.toThrow(/Invalid verified asset spec/);
        await expect(readVerifiedCachedAsset({...baseSpec, urls: ['not a url']})).rejects.toThrow(/Invalid verified asset mirror URL/);
        await expect(readVerifiedCachedAsset({...baseSpec, urls: ['http://insecure.example/a']})).rejects.toThrow(/Unsafe verified asset mirror URL/);
        await expect(readVerifiedCachedAsset({...baseSpec, urls: ['https://user:pass@cdn.example/a']})).rejects.toThrow(/Unsafe verified asset mirror URL/);

        // Missing globals return null / false / throw.
        vi.stubGlobal('caches', undefined);
        vi.stubGlobal('crypto', undefined);
        expect(canUseVerifiedAssetCache()).toBe(false);
        expect(await readVerifiedCachedAsset(baseSpec)).toBeNull();
        await expect(downloadVerifiedAsset(baseSpec)).rejects.toThrow(/crypto digest unavailable/);

        // Cache open / match errors return null; pre-aborted / mid-flight abort rethrows.
        const digestFn = (data: ArrayBuffer) => webcrypto.subtle.digest('SHA-256', data);
        expect(await readVerifiedCachedAsset(baseSpec, {
            openCache: async () => { throw new Error('open failed'); },
            digest: digestFn,
        })).toBeNull();
        expect(await readVerifiedCachedAsset(baseSpec, {
            openCache: async () => ({
                match: async () => { throw new Error('match failed'); },
                put: async () => undefined,
                delete: async () => true,
            }),
            digest: digestFn,
        })).toBeNull();

        const aborted = new AbortController();
        aborted.abort(new Error('already aborted'));
        await expect(downloadVerifiedAsset(baseSpec, {digest: digestFn}, aborted.signal)).rejects.toThrow('already aborted');

        // Abort during cache.open, cache.match, and cached body verification all rethrow instead of evicting cache.
        const openAbort = new AbortController();
        await expect(readVerifiedCachedAsset(baseSpec, {
            openCache: async () => {
                openAbort.abort(new Error('open abort'));
                return new Promise(() => {});
            },
            digest: digestFn,
        }, openAbort.signal)).rejects.toThrow('open abort');

        const matchAbort = new AbortController();
        await expect(readVerifiedCachedAsset(baseSpec, {
            openCache: async () => ({
                match: async () => {
                    matchAbort.abort(new Error('match abort'));
                    return new Promise(() => {});
                },
                put: async () => undefined,
                delete: async () => true,
            }),
            digest: digestFn,
        }, matchAbort.signal)).rejects.toThrow('match abort');

        const slowReadAbort = new AbortController();
        const delSpy = vi.fn(async () => true);
        await expect(readVerifiedCachedAsset(baseSpec, {
            openCache: async () => ({
                match: async () => new Response(payload),
                put: async () => undefined,
                delete: delSpy,
            }),
            digest: async () => {
                slowReadAbort.abort(new Error('mid-read abort'));
                return new Promise(() => {});
            },
        }, slowReadAbort.signal)).rejects.toThrow('mid-read abort');
        expect(delSpy).not.toHaveBeenCalled();

        // Download failure modes: HTTP 500, declared Content-Length > bytes, short body, oversize stream, timeout, cache put failure.
        const fetchEdge = vi.fn()
            .mockResolvedValueOnce(new Response('err', {status: 500}))
            .mockResolvedValueOnce(new Response(payload, {headers: {'Content-Length': String(payload.byteLength + 10)}}))
            .mockResolvedValueOnce(new Response(payload.slice(0, 3)))
            .mockResolvedValueOnce(new Response(new Uint8Array(payload.byteLength + 2)));
        await expect(downloadVerifiedAsset({
            ...baseSpec,
            urls: [
                'https://a.example/1',
                'https://b.example/2',
                'https://c.example/3',
                'https://d.example/4',
            ],
        }, {fetch: fetchEdge as unknown as typeof fetch, digest: digestFn})).rejects.toThrow(/sources unavailable/);

        // Timeout branch + cache.put error swallowed + default globals deduplication.
        vi.useFakeTimers();
        const timeoutFetch = vi.fn(() => new Promise<Response>(() => {}));
        const timeoutPromise = downloadVerifiedAsset({...baseSpec, timeoutMs: 25}, {
            fetch: timeoutFetch as unknown as typeof fetch,
            digest: digestFn,
        });
        const caughtTimeout = expect(timeoutPromise).rejects.toThrow(/sources unavailable/);
        await vi.advanceTimersByTimeAsync(30);
        await caughtTimeout;
        vi.useRealTimers();

        // Caller abort during download rethrows immediately without trying next mirror.
        const callerAbort = new AbortController();
        const abortFetch = vi.fn(async () => {
            callerAbort.abort(new Error('caller cancelled'));
            return new Promise<Response>(() => {});
        });
        await expect(downloadVerifiedAsset({
            ...baseSpec,
            urls: ['https://a.example/1', 'https://b.example/2'],
        }, {fetch: abortFetch as unknown as typeof fetch, digest: digestFn}, callerAbort.signal)).rejects.toThrow('caller cancelled');
        expect(abortFetch).toHaveBeenCalledTimes(1);

        // Corrupt cache entry where cache.delete itself fails still returns null cleanly.
        expect(await readVerifiedCachedAsset(baseSpec, {
            openCache: async () => ({
                match: async () => new Response(new Uint8Array(payload.byteLength)),
                put: async () => undefined,
                delete: async () => { throw new Error('delete failed'); },
            }),
            digest: digestFn,
        })).toBeNull();

        // Successful download without CacheStorage available skips persistence cleanly.
        vi.stubGlobal('caches', undefined);
        const noCacheBytes = await downloadVerifiedAsset(baseSpec, {
            fetch: (async () => new Response(payload)) as typeof fetch,
            digest: digestFn,
        });
        expect(Buffer.from(noCacheBytes).equals(Buffer.from(payload))).toBe(true);

        // Concurrent default-dependency deduplication + cache.put error tolerance.
        let resolveFetch!: (res: Response) => void;
        let markFetchStarted!: () => void;
        const fetchStarted = new Promise<void>(resolve => { markFetchStarted = resolve; });
        const globalFetch = vi.fn(() => {
            markFetchStarted();
            return new Promise<Response>(r => { resolveFetch = r; });
        });
        const failingPutCache = {
            match: vi.fn(async () => undefined),
            put: vi.fn(async () => { throw new Error('quota'); }),
            delete: vi.fn(async () => true),
        };
        vi.stubGlobal('fetch', globalFetch);
        vi.stubGlobal('caches', {open: vi.fn(async () => failingPutCache)});
        vi.stubGlobal('crypto', webcrypto);
        expect(canUseVerifiedAssetCache()).toBe(true);

        const p1 = fetchVerifiedAsset(baseSpec);
        const p2 = fetchVerifiedAsset(baseSpec);
        await fetchStarted;
        resolveFetch(new Response(payload, {headers: {'Content-Encoding': 'gzip', 'Content-Length': String(payload.byteLength + 100)}}));
        const [r1, r2] = await Promise.all([p1, p2]);
        expect(Buffer.from(r1).equals(Buffer.from(payload))).toBe(true);
        expect(Buffer.from(r2).equals(Buffer.from(payload))).toBe(true);
        expect(globalFetch).toHaveBeenCalledTimes(1);

        // Global default readVerifiedCachedAsset path (no deps override).
        const {store: globalStore, openCache: globalOpenCache} = makeCacheStub();
        globalStore.set(baseSpec.cacheKey, new Response(payload));
        vi.stubGlobal('caches', {open: globalOpenCache});
        const cachedDefault = await readVerifiedCachedAsset(baseSpec);
        expect(cachedDefault && Buffer.from(cachedDefault).equals(Buffer.from(payload))).toBe(true);
    });

    it('covers pdfBinaryDataFactory local fallback, memory cache, .ttf contentType, and error branches', async () => {
        const ttfName = 'LiberationSans-Regular.ttf';
        const ttfBytes = new Uint8Array(readFileSync(resolve(PROJECT_ROOT, 'node_modules/pdfjs-dist/standard_fonts', ttfName)));
        const cmapName = 'UniGB-UTF16-H.bcmap';
        const cmapBytes = new Uint8Array(readFileSync(resolve(PROJECT_ROOT, 'node_modules/pdfjs-dist/cmaps', cmapName)));

        // Default options + missing wasmUrl + HTTP failure + invalid kind.
        const DefaultFactory = createPdfBinaryDataFactory();
        const emptyInstance = new DefaultFactory();
        await expect(emptyInstance.fetch({kind: 'wasmUrl', filename: 'a.wasm'})).rejects.toThrow(/wasmUrl/);
        await expect(emptyInstance.fetch({kind: 'unknown' as 'wasmUrl', filename: 'a'})).rejects.toThrow(/Unsupported/);

        // Local fetch failure for wasmUrl and local preferLocalDataAssets hit + mismatch + throw fallback.
        const badWasmFactory = createPdfBinaryDataFactory({
            localFetch: (async () => new Response('missing', {status: 404})) as typeof fetch,
        });
        await expect(new badWasmFactory({wasmUrl: 'chrome://app/wasm/'}).fetch({kind: 'wasmUrl', filename: 'a.wasm'}))
            .rejects.toThrow(/HTTP 404/);

        const localHitFactory = createPdfBinaryDataFactory({
            preferLocalDataAssets: true,
            localFetch: (async () => new Response(cmapBytes)) as typeof fetch,
        });
        const localHit = new localHitFactory({cMapUrl: 'chrome://app/cmaps/'});
        const loadedLocal = await localHit.fetch({kind: 'cMapUrl', filename: cmapName});
        expect(loadedLocal.byteLength).toBe(cmapBytes.byteLength);
        // Second call hits memory cache.
        const loadedMem = await localHit.fetch({kind: 'cMapUrl', filename: cmapName});
        expect(loadedMem.byteLength).toBe(cmapBytes.byteLength);
        expect(loadedMem.buffer).not.toBe(loadedLocal.buffer);

        clearPdfBinaryDataMemoryCache();
        // preferLocalDataAssets with wrong byte length & throwing localFetch falls back to verified remote mirror (.ttf branch + default globals memory cache).
        const {openCache} = makeCacheStub();
        vi.stubGlobal('caches', {open: openCache});
        vi.stubGlobal('crypto', webcrypto);
        vi.stubGlobal('fetch', vi.fn(async () => new Response(ttfBytes)));

        const fallbackFactory = createPdfBinaryDataFactory({
            preferLocalDataAssets: true,
            localFetch: vi.fn()
                .mockResolvedValueOnce(new Response(new Uint8Array(4)))
                .mockRejectedValueOnce(new Error('disk error')) as unknown as typeof fetch,
        });
        const fbInstance = new fallbackFactory({
            standardFontDataUrl: 'chrome://app/standard_fonts/',
            cMapUrl: 'chrome://app/cmaps/',
        });
        const ttfLoaded = await fbInstance.fetch({kind: 'standardFontDataUrl', filename: ttfName});
        expect(ttfLoaded.byteLength).toBe(ttfBytes.byteLength);

        vi.stubGlobal('fetch', vi.fn(async () => new Response(cmapBytes)));
        const cmapLoaded = await fbInstance.fetch({kind: 'cMapUrl', filename: cmapName});
        expect(cmapLoaded.byteLength).toBe(cmapBytes.byteLength);

        // Default localFetch uses globalThis.fetch.
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))));
        const defaultWasm = await new DefaultFactory({wasmUrl: 'chrome-extension://id/pdfjs/wasm/'}).fetch({kind: 'wasmUrl', filename: 'x.wasm'});
        expect(Array.from(defaultWasm)).toEqual([1, 2, 3]);
    });

    it('covers remoteLanguagePacks validation, diff/merge edge cases, and defaultLoadRemoteBase in uiLanguageBundles', async () => {
        const asset = REMOTE_LANGUAGE_BASE_ASSETS['ja-JP'];
        const urls = getRemoteLanguageBaseUrls({baseRevision: 'deadbeef', basePath: asset.path}, 'zh-CN');
        expect(urls[0]).toContain('cdn.jsdmirror.com');

        const baseBundle: UiLanguageBundle = {
            messages: {b: 'B', a: 'A', retired: 'OLD'},
            legacyText: {k1: 'V1', k2: 'V2'},
            legacyPatterns: {
                early: [['^foo$', 'bar', [1]]],
                late: [['^x$', 'y']],
            },
        };
        const nextBundle: UiLanguageBundle = {
            messages: {c: 'C', a: 'A2', b: 'B'},
            legacyText: {k1: 'V1'},
            legacyPatterns: {
                early: [['^new$', 'n'], ['^foo$', 'bar', [1]]],
                late: [['^x$', 'y']],
            },
        };
        const delta = createDeltaUiLanguageBundle('ja-JP', nextBundle, baseBundle);
        expect(isDeltaUiLanguageBundle(delta)).toBe(true);
        expect(delta.removedMessages).toEqual(['retired']);
        expect(delta.removedLegacyText).toEqual(['k2']);
        expect(mergeDeltaUiLanguageBundle(baseBundle, delta)).toEqual(nextBundle);

        const emptyDelta = createDeltaUiLanguageBundle('ja-JP', baseBundle, baseBundle);
        expect(emptyDelta.removedMessages).toBeUndefined();
        expect(emptyDelta.removedLegacyText).toBeUndefined();
        expect(emptyDelta.patternOrder).toBeUndefined();
        expect(mergeDeltaUiLanguageBundle(baseBundle, emptyDelta)).toEqual(baseBundle);

        // Merge without patternOrder but with appended legacyPatterns, and invalid patternOrder index.
        const appendDelta: DeltaUiLanguageBundle = {
            ...delta,
            patternOrder: undefined,
            legacyPatterns: {early: [['^extra$', 'e']], late: []},
        };
        expect(mergeDeltaUiLanguageBundle(baseBundle, appendDelta).legacyPatterns.early).toHaveLength(2);
        expect(() => mergeDeltaUiLanguageBundle(baseBundle, {...delta, patternOrder: {early: [99]}})).toThrow(RangeError);

        // Reject every invalid shape in isDeltaUiLanguageBundle.
        const invalidCases: unknown[] = [
            null,
            [],
            {...delta, format: 'wrong'},
            {...delta, language: 'en-US'},
            {...delta, baseRevision: 123},
            {...delta, baseBytes: 0},
            {...delta, baseSha256: 'short'},
            {...delta, messages: null},
            {...delta, messages: {a: 123}},
            {...delta, legacyText: {a: 123}},
            {...delta, removedMessages: 'not-array'},
            {...delta, removedMessages: [1]},
            {...delta, removedLegacyText: [1]},
            {...delta, legacyPatterns: null},
            {...delta, legacyPatterns: {early: [['only-one']], late: []}},
            {...delta, patternOrder: 'bad'},
            {...delta, patternOrder: {early: ['bad']}},
        ];
        for (const candidate of invalidCases) {
            expect(isDeltaUiLanguageBundle(candidate)).toBe(false);
        }

        // Test defaultLoadRemoteBase (no loadRemoteBase override) on valid and invalid remote JSON + invalid merged bundle.
        const koBase: UiLanguageBundle = {
            messages: {'common.brand': 'FluentRead'},
            legacyText: {'确定': '확인'},
            legacyPatterns: {early: [], late: []},
        };
        const koBaseBytes = new TextEncoder().encode(JSON.stringify(koBase));
        const koBaseSha = sha256Hex(koBaseBytes);
        const koDelta: DeltaUiLanguageBundle = {
            format: 'delta-v1',
            language: 'ko-KR',
            baseRevision: '3a8a32e3e2b8a213ea02452f881b9064e6d9d816',
            basePath: 'userscript/languages/ko-KR.test.json',
            baseBytes: koBaseBytes.byteLength,
            baseSha256: koBaseSha,
            messages: {'common.ok': 'OK'},
            legacyText: {},
            legacyPatterns: {early: [], late: []},
        };
        const {openCache} = makeCacheStub();
        vi.stubGlobal('location', {protocol: 'chrome-extension:'});
        vi.stubGlobal('caches', {open: openCache});
        vi.stubGlobal('crypto', webcrypto);
        vi.stubGlobal('fetch', vi.fn(async () => new Response(koBaseBytes)));
        const warn = vi.fn();
        const defaultLoader = createUiLanguageBundleLoader({
            resolveUrl: p => `chrome-extension://id/${p}`,
            fetch: async () => ({ok: true, status: 200, json: async () => koDelta}),
            warn,
        });
        await expect(defaultLoader('ko-KR')).resolves.toBe(true);

        // Invalid remote JSON payload with matching SHA-256 fails defaultLoadRemoteBase validation.
        const badRemoteBytes = new TextEncoder().encode('{}');
        const badRemoteSha = sha256Hex(badRemoteBytes);
        const frDeltaBadRemote: DeltaUiLanguageBundle = {
            ...koDelta,
            language: 'fr-FR',
            baseBytes: badRemoteBytes.byteLength,
            baseSha256: badRemoteSha,
        };
        vi.stubGlobal('fetch', vi.fn(async () => new Response(badRemoteBytes)));
        const badRemoteLoader = createUiLanguageBundleLoader({
            resolveUrl: p => `chrome-extension://id/${p}`,
            fetch: async () => ({ok: true, status: 200, json: async () => frDeltaBadRemote}),
            warn,
        });
        await expect(badRemoteLoader('fr-FR')).resolves.toBe(false);

        // Invalid merged bundle from custom loadRemoteBase hits post-merge guard.
        const ruDelta: DeltaUiLanguageBundle = {...koDelta, language: 'ru-RU'};
        const badMergedLoader = createUiLanguageBundleLoader({
            resolveUrl: p => `chrome-extension://id/${p}`,
            fetch: async () => ({ok: true, status: 200, json: async () => ruDelta}),
            warn,
            loadRemoteBase: async () => ({messages: {x: 123 as unknown as string}, legacyText: {}, legacyPatterns: {early: [], late: []}}),
        });
        await expect(badMergedLoader('ru-RU')).resolves.toBe(false);
    });

    it('covers all subframeDomain URL parsing, IP/DNS validation, display resolution, and matcher cache branches', () => {
        expect(subframeDomain.getSiteBaseDomain(new URL('https://Sub.Example.COM./path'))).toBe('sub.example.com');
        expect(subframeDomain.getSiteBaseDomain(new URL('chrome://extensions'))).toBeNull();
        expect(subframeDomain.getSiteBaseDomain(123 as unknown as string)).toBeNull();
        expect(subframeDomain.getSiteBaseDomain('   ')).toBeNull();
        expect(subframeDomain.getSiteBaseDomain('mailto:user@example.com')).toBeNull();
        expect(subframeDomain.getSiteBaseDomain('localhost:8080/test')).toBe('localhost');
        expect(subframeDomain.getSiteBaseDomain('https://[invalid')).toBeNull();
        expect(subframeDomain.getSiteBaseDomain('https://*.example.com')).toBeNull();
        expect(subframeDomain.getSiteBaseDomain(`https://${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.${'e'.repeat(20)}.com`)).toBeNull();
        expect(subframeDomain.getSiteBaseDomain('http://[::1]:8080/')).toBe('[::1]');
        expect(subframeDomain.getSiteBaseDomain('http://999.0.0.1/')).toBeNull();
        expect(subframeDomain.getSiteBaseDomain('http://bad_host/')).toBeNull();

        expect(subframeDomain.normalizeSiteDomains('not-array')).toEqual([]);
        expect(subframeDomain.normalizeAlwaysTranslateDomains([123, 'example.com', 'EXAMPLE.COM', 'mailto:a@b'])).toEqual(['example.com']);
        expect(subframeDomain.normalizeDisabledExtensionDomains(['a.com'])).toEqual(['a.com']);
        expect(subframeDomain.normalizeFloatingBallDisabledDomains(['b.com'])).toEqual(['b.com']);

        expect(subframeDomain.isFloatingBallDisabledOnSite('https://a.b.com', ['b.com'])).toBe(true);
        expect(subframeDomain.isFloatingBallDisabledOnSite('https://a.b.com', 'bad')).toBe(false);
        expect(subframeDomain.isFloatingBallDisabledOnSite('mailto:x@y', ['b.com'])).toBe(false);
        expect(subframeDomain.isFloatingBallDisabledOnSite('http://127.0.0.1/', [123, 'invalid_host', '127.0.0.2'])).toBe(false);
        expect(subframeDomain.isAlwaysTranslateSite('https://sub.example.com', ['example.com'])).toBe(true);

        expect(subframeDomain.resolveSiteTranslationDisplay({display: 1, translationOnlyDomains: ['example.com']}, 'https://sub.example.com')).toBe(0);
        expect(subframeDomain.resolveSiteTranslationDisplay({display: 1, translationOnlyDomains: ['other.com']}, 'https://sub.example.com')).toBe(1);
        expect(subframeDomain.resolveSiteTranslationDisplay({display: 1}, 'https://sub.example.com')).toBe(1);

        expect(subframeDomain.shouldAutoTranslatePage('https://a.com', {on: false, autoTranslate: true, alwaysTranslateDomains: []})).toBe(false);
        expect(subframeDomain.shouldAutoTranslatePage('https://a.com', {on: true, autoTranslate: true, alwaysTranslateDomains: [], disabledExtensionDomains: ['a.com']})).toBe(false);
        expect(subframeDomain.shouldAutoTranslatePage('https://a.com', {on: true, autoTranslate: true, alwaysTranslateDomains: []})).toBe(true);
        expect(subframeDomain.shouldAutoTranslatePage('https://a.com', {on: true, autoTranslate: false, alwaysTranslateDomains: ['a.com']})).toBe(true);

        const matcher = subframeDomain.createSiteRuleMatcher({
            on: true,
            autoTranslate: false,
            alwaysTranslateDomains: ['example.com'],
            disabledExtensionDomains: undefined,
        });
        // Exact domain match, subdomain match, cached hostname hit, URL input, and IP non-suffix match.
        expect(matcher.shouldAutoTranslate('https://example.com/root')).toBe(true);
        expect(matcher.shouldAutoTranslate(new URL('https://sub.example.com/1'))).toBe(true);
        expect(matcher.shouldAutoTranslate(new URL('https://sub.example.com/1'))).toBe(true);
        expect(matcher.shouldAutoTranslate('http://[::1]/')).toBe(false);
        expect(matcher.shouldAutoTranslate('mailto:a@b')).toBe(false);

        // Update with identical array skips rebuild; update with different element of same length rebuilds.
        matcher.update({on: true, autoTranslate: false, alwaysTranslateDomains: ['example.com'], disabledExtensionDomains: []});
        matcher.update({on: true, autoTranslate: false, alwaysTranslateDomains: ['other.com'], disabledExtensionDomains: ['blocked.com']});
        expect(matcher.shouldAutoTranslate('https://sub.other.com/')).toBe(true);
        expect(matcher.isExtensionDisabled('https://sub.blocked.com/')).toBe(true);
    });

    it('demotes failing mirror origins with cooldown, caps demotion history, and restores on success', () => {
        resetPreferredMirrorOrigins();
        const urls = ['https://m1.example/a', 'https://m2.example/a', 'https://m3.example/a'];
        demoteMirrorOrigin('not-a-url');
        demoteMirrorOrigin(urls[0]!);
        expect(orderMirrorUrls(urls)).toEqual([urls[1], urls[2], urls[0]]);

        // Remembering a demoted origin restores it to preferred.
        rememberPreferredMirrorOrigin(urls[0]!);
        expect(orderMirrorUrls(urls)[0]).toBe(urls[0]);

        // Cooldown expiry automatically restores origin priority.
        demoteMirrorOrigin(urls[1]!, 0);
        expect(orderMirrorUrls(urls)).toEqual([urls[0], urls[1], urls[2]]);

        // Demoting > 16 distinct origins evicts the oldest entry.
        for (let i = 0; i < 20; i += 1) {
            demoteMirrorOrigin(`https://dead-${i}.example/asset`, 60_000);
        }
        expect(orderMirrorUrls(['https://dead-0.example/x', 'https://dead-19.example/x']))
            .toEqual(['https://dead-0.example/x', 'https://dead-19.example/x']);
        resetPreferredMirrorOrigins();
    });

    it('covers verifiedAssetCache deduplication, 206 rejection, abort-during-cache, and late-response cancel', async () => {
        resetPreferredMirrorOrigins();
        const payload = new TextEncoder().encode('verified-dedup-payload');
        const sha = sha256Hex(payload);
        const {openCache} = makeCacheStub();
        vi.stubGlobal('caches', {open: openCache});
        vi.stubGlobal('crypto', webcrypto);

        // Concurrent default-dependency fetches for the same cacheKey share one network fetch and return independent byte copies.
        let releaseFetch: ((r: Response) => void) | undefined;
        const fetchMock = vi.fn(() => new Promise<Response>(r => { releaseFetch = r; }));
        vi.stubGlobal('fetch', fetchMock);
        const spec = {
            id: 'dedup-test',
            cacheName: 'dedup-cache',
            cacheKey: 'https://fluentread.app/__optional_assets__/dedup-test',
            bytes: payload.byteLength,
            sha256: sha,
            contentType: 'application/octet-stream',
            urls: ['https://primary.test/file.bin', 'https://secondary.test/file.bin'],
        };
        const first = fetchVerifiedAsset(spec);
        const second = fetchVerifiedAsset(spec);
        await vi.waitFor(() => expect(releaseFetch).toBeTypeOf('function'));
        releaseFetch!(new Response(payload));
        const [b1, b2] = await Promise.all([first, second]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        b1[0] ^= 0xff;
        expect(b2[0]).toBe(payload[0]);
        // Subsequent call hits CacheStorage through the deduplicated fast path without network fetch.
        const b3 = await fetchVerifiedAsset(spec);
        expect(b3).toEqual(payload);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // HTTP 206 partial content is rejected and demotes primary mirror.
        const partialThenOk = vi.fn()
            .mockResolvedValueOnce(new Response(payload, {status: 206}))
            .mockResolvedValueOnce(new Response(payload, {status: 200}));
        await expect(fetchVerifiedAsset({
            ...spec,
            cacheKey: 'https://fluentread.app/__optional_assets__/partial-test',
        }, {openCache, fetch: partialThenOk})).resolves.toEqual(payload);
        expect(partialThenOk).toHaveBeenCalledTimes(2);

        // Abort while openCache is pending during persistence rejects with AbortError without hanging.
        const abortController = new AbortController();
        const hangingOpen = vi.fn(() => new Promise<never>(() => {}));
        const abortedPromise = downloadVerifiedAsset({
            ...spec,
            cacheKey: 'https://fluentread.app/__optional_assets__/abort-open',
        }, {openCache: hangingOpen, fetch: vi.fn(async () => new Response(payload))}, abortController.signal);
        await vi.waitFor(() => expect(hangingOpen).toHaveBeenCalled());
        abortController.abort('user-cancelled');
        await expect(abortedPromise).rejects.toMatchObject({name: 'AbortError'});

        // Late response arriving after abort cancels its body cleanly.
        const lateController = new AbortController();
        const cancelSpy = vi.fn(async () => undefined);
        let resolveLate: ((r: Response) => void) | undefined;
        const lateFetch = vi.fn(() => new Promise<Response>(r => { resolveLate = r; }));
        const latePromise = downloadVerifiedAsset({
            ...spec,
            cacheKey: 'https://fluentread.app/__optional_assets__/late-cancel',
        }, {openCache, fetch: lateFetch}, lateController.signal);
        await vi.waitFor(() => expect(resolveLate).toBeTypeOf('function'));
        lateController.abort();
        resolveLate!({ok: true, status: 200, headers: new Headers(), body: {cancel: cancelSpy}} as unknown as Response);
        await expect(latePromise).rejects.toMatchObject({name: 'AbortError'});
        expect(cancelSpy).toHaveBeenCalled();

        // Late rejection after abort is silently absorbed without unhandled rejection.
        const lateRejectController = new AbortController();
        let rejectLate: ((reason: unknown) => void) | undefined;
        const lateRejectFetch = vi.fn(() => new Promise<Response>((_res, rej) => { rejectLate = rej; }));
        const lateRejectPromise = downloadVerifiedAsset({
            ...spec,
            cacheKey: 'https://fluentread.app/__optional_assets__/late-reject',
        }, {openCache, fetch: lateRejectFetch}, lateRejectController.signal);
        await vi.waitFor(() => expect(rejectLate).toBeTypeOf('function'));
        lateRejectController.abort();
        rejectLate!(new Error('late network error'));
        await expect(lateRejectPromise).rejects.toMatchObject({name: 'AbortError'});
    });

    it('covers pdfBinaryDataFactory chrome:// XHR fallback, LRU eviction, and concurrent in-flight dedup', async () => {
        clearPdfBinaryDataMemoryCache();
        // 1. Zotero chrome:// XHR fallback: success, HTTP error, network error.
        const sampleBytes = new Uint8Array([10, 20, 30, 40]);
        const xhrCalls: string[] = [];
        let xhrMode: 'ok' | 'http404' | 'networkError' = 'ok';
        class FakeXhr {
            responseType = '';
            status = 200;
            response: unknown = null;
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;
            open(_method: string, url: string) { xhrCalls.push(url); }
            send() {
                queueMicrotask(() => {
                    if (xhrMode === 'networkError') { this.onerror?.(); return; }
                    if (xhrMode === 'http404') { this.status = 404; this.onload?.(); return; }
                    this.status = 0;
                    this.response = sampleBytes.buffer.slice(0);
                    this.onload?.();
                });
            }
        }
        vi.stubGlobal('XMLHttpRequest', FakeXhr);
        const ZoteroFactory = createPdfBinaryDataFactory({preferLocalDataAssets: true});
        const zoteroInstance = new ZoteroFactory({wasmUrl: 'chrome://fluentread/content/pdfjs/wasm/'});
        const loaded = await zoteroInstance.fetch({kind: 'wasmUrl', filename: 'openjpeg.wasm'});
        expect(loaded).toEqual(sampleBytes);
        expect(xhrCalls).toEqual(['chrome://fluentread/content/pdfjs/wasm/openjpeg.wasm']);

        xhrMode = 'http404';
        await expect(zoteroInstance.fetch({kind: 'wasmUrl', filename: 'missing.wasm'})).rejects.toThrow('HTTP 404');
        xhrMode = 'networkError';
        await expect(zoteroInstance.fetch({kind: 'wasmUrl', filename: 'broken.wasm'})).rejects.toThrow('chrome://fluentread/content/pdfjs/wasm/broken.wasm');

        // 2. Concurrent in-flight dedup & bounded LRU (> 64 entries) returning independent byte copies.
        clearPdfBinaryDataMemoryCache();
        const cmapEntries = Object.entries(pdfBinaryDataManifest.cmaps).slice(0, 67);
        expect(cmapEntries.length).toBeGreaterThan(64);
        const [firstName, firstMeta] = cmapEntries[0]!;
        let releaseFirst: ((r: Response) => void) | undefined;
        let fetchCount = 0;
        const localFetch = vi.fn((input: string | URL | Request) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            const fileName = url.split('/').pop()!;
            const expectedBytes = (pdfBinaryDataManifest.cmaps as Record<string, {bytes: number}>)[fileName]!.bytes;
            fetchCount += 1;
            if (fileName === firstName) {
                return new Promise<Response>(r => { releaseFirst = r; });
            }
            return Promise.resolve(new Response(new Uint8Array(expectedBytes).fill(fetchCount & 0xff)));
        });
        const LocalFactory = createPdfBinaryDataFactory({preferLocalDataAssets: true, localFetch});
        const local = new LocalFactory({cMapUrl: 'chrome-extension://id/pdfjs/cmaps/'});
        const p1 = local.fetch({kind: 'cMapUrl', filename: firstName});
        const p2 = local.fetch({kind: 'cMapUrl', filename: firstName});
        await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
        releaseFirst!(new Response(new Uint8Array(firstMeta.bytes).fill(7)));
        const [r1, r2] = await Promise.all([p1, p2]);
        expect(fetchCount).toBe(1);
        r1[0] = 99;
        expect(r2[0]).toBe(7);

        // Fill past 64-entry LRU cap so oldest entry evicts cleanly.
        for (let i = 1; i < cmapEntries.length; i += 1) {
            await local.fetch({kind: 'cMapUrl', filename: cmapEntries[i]![0]});
        }
        const beforeHotRead = fetchCount;
        await local.fetch({kind: 'cMapUrl', filename: cmapEntries[cmapEntries.length - 1]![0]});
        expect(fetchCount).toBe(beforeHotRead);
        clearPdfBinaryDataMemoryCache();
    });

    it('delegates remote UI language base loading via background IPC in content scripts and validates handler security', async () => {
        clearPinnedRemoteUiLanguageBaseCache();
        vi.stubGlobal('location', {protocol: 'chrome-extension:'});
        expect(isExtensionOriginContext()).toBe(true);
        vi.stubGlobal('location', {protocol: 'moz-extension:'});
        expect(isExtensionOriginContext()).toBe(true);
        vi.stubGlobal('location', {protocol: 'safari-web-extension:'});
        expect(isExtensionOriginContext()).toBe(true);
        vi.stubGlobal('location', {protocol: 'http:'});
        expect(isExtensionOriginContext()).toBe(false);
        vi.stubGlobal('location', {protocol: 'https:'});
        expect(isExtensionOriginContext()).toBe(false);
        vi.stubGlobal('location', undefined);
        expect(isExtensionOriginContext()).toBe(false);

        const baseBundle: UiLanguageBundle = {
            messages: {'common.brand': 'FluentRead'},
            legacyText: {'确定': '確定'},
            legacyPatterns: {early: [], late: []},
        };
        const baseBytes = new TextEncoder().encode(JSON.stringify(baseBundle));
        const delta: DeltaUiLanguageBundle = {
            format: 'delta-v1',
            language: 'es-ES',
            baseRevision: EXTENSION_I18N_BASE_REVISION,
            basePath: REMOTE_LANGUAGE_BASE_ASSETS['es-ES'].path,
            baseBytes: baseBytes.byteLength,
            baseSha256: sha256Hex(baseBytes),
            messages: {'common.ok': 'OK'},
            legacyText: {},
            legacyPatterns: {early: [], late: []},
        };

        // Background handler enforces sender.id === runtimeId and language allowlist.
        const mockLoadBase = vi.fn(async () => baseBundle);
        const handler = createUiLanguageBaseHandler({runtimeId: 'ext-123', loadBase: mockLoadBase});
        expect(handler.type).toBe(UI_LANGUAGE_BASE_MESSAGE_TYPE);
        await expect(handler.handle({type: UI_LANGUAGE_BASE_MESSAGE_TYPE, language: 'es-ES'}, {sender: {id: 'other-ext'}} as never))
            .resolves.toEqual({success: false, error: '当前上下文无权加载界面语言基线'});
        await expect(handler.handle({type: UI_LANGUAGE_BASE_MESSAGE_TYPE, language: 'en-US' as never}, {sender: {id: 'ext-123'}} as never))
            .resolves.toEqual({success: false, error: '不支持的远程界面语言'});
        await expect(handler.handle({type: UI_LANGUAGE_BASE_MESSAGE_TYPE, language: 'es-ES'}, {sender: {id: 'ext-123'}} as never))
            .resolves.toEqual({success: true, bundle: baseBundle});

        // Content script on http:// delegates remote base loading through browser.runtime.sendMessage.
        vi.stubGlobal('location', {protocol: 'http:'});
        const sendMessage = vi.fn(async (msg: {type: string; language: RemoteDeltaUiLanguage}) =>
            handler.handle(msg as never, {sender: {id: 'ext-123'}} as never));
        vi.stubGlobal('browser', {runtime: {sendMessage}});
        const contentLoader = createUiLanguageBundleLoader({
            resolveUrl: p => `chrome-extension://id/${p}`,
            fetch: async () => ({ok: true, status: 200, json: async () => delta}),
            warn: vi.fn(),
        });
        await expect(contentLoader('es-ES')).resolves.toBe(true);
        expect(sendMessage).toHaveBeenCalledWith({type: UI_LANGUAGE_BASE_MESSAGE_TYPE, language: 'es-ES'});

        // Failed / malformed IPC responses return false without crashing.
        vi.stubGlobal('browser', {runtime: {sendMessage: vi.fn(async () => ({success: false, error: 'offline'}))}});
        const failLoader = createUiLanguageBundleLoader({
            resolveUrl: p => `chrome-extension://id/${p}`,
            fetch: async () => ({ok: true, status: 200, json: async () => ({...delta, language: 'fr-FR'})}),
            warn: vi.fn(),
        });
        await expect(failLoader('fr-FR')).resolves.toBe(false);

        vi.stubGlobal('browser', {runtime: {sendMessage: vi.fn(async () => ({success: true, bundle: {bad: true}}))}});
        const invalidIpcLoader = createUiLanguageBundleLoader({
            resolveUrl: p => `chrome-extension://id/${p}`,
            fetch: async () => ({ok: true, status: 200, json: async () => ({...delta, language: 'ru-RU'})}),
            warn: vi.fn(),
        });
        await expect(invalidIpcLoader('ru-RU')).resolves.toBe(false);

        vi.stubGlobal('browser', undefined);
        vi.stubGlobal('chrome', undefined);
        const noSendLoader = createUiLanguageBundleLoader({
            resolveUrl: p => `chrome-extension://id/${p}`,
            fetch: async () => ({ok: true, status: 200, json: async () => ({...delta, language: 'ru-RU'})}),
            warn: vi.fn(),
        });
        await expect(noSendLoader('ru-RU')).resolves.toBe(false);

        // Background handler with default loadBase loads & caches pinned bundle in memory.
        const pinnedAsset = REMOTE_LANGUAGE_BASE_ASSETS['ja-JP'];
        const realPinnedBytes = readFileSync(resolve(PROJECT_ROOT, pinnedAsset.path));
        const {openCache} = makeCacheStub();
        vi.stubGlobal('caches', {open: openCache});
        vi.stubGlobal('crypto', webcrypto);
        const pinnedFetch = vi.fn(async () => new Response(realPinnedBytes));
        vi.stubGlobal('fetch', pinnedFetch);
        const defaultHandler = createUiLanguageBaseHandler({runtimeId: 'ext-123'});
        const firstReply = await defaultHandler.handle({type: UI_LANGUAGE_BASE_MESSAGE_TYPE, language: 'ja-JP'}, {sender: {id: 'ext-123'}} as never);
        const secondPinned = await loadPinnedRemoteUiLanguageBase('ja-JP');
        expect(firstReply.success).toBe(true);
        if (firstReply.success) expect(firstReply.bundle).toBe(secondPinned);
        expect(pinnedFetch).toHaveBeenCalledTimes(1);
        clearPinnedRemoteUiLanguageBaseCache();
    });

    it('extracts Chinese messages & dynamic template keys cleanly via lexical scanner across regexes, division, nested templates, and plus concat', () => {
        const code = [
            "const re = /['\"`<>]/gu;",
            "if (cond) /['\"]/g.test(input);",
            "while (cond) /=foo['\"]/.test(input);",
            "function fn() { return /['\"]/; } /['\"]/.test(x);",
            "const div1 = a / b / c;",
            "const div2 = obj.return / 2;",
            "const div3 = obj.if(x) / 2;",
            "const div4 = obj?.if(x) / 2;",
            "let n = 10; n /= 2;",
            "for (let t of /a'b/.exec(s)) { const k = 'popup.compact.translate'; }",
            "async function iter(y) { for await (const x of y) /foo'bar/.test(x); return 'sidepanel.title'; }",
            "const divOf = of / 2;",
            "a++\n'paragraphCopy.notice.copied' + kind;",
            'function copy(kind) { return t(`paragraphCopy.notice.copied${kind ? `sidepanel.${{k: "popup.compact.translate"}.k}` : "common." + "brand"}`); }',
            "const escaped = '\\u7ffb\\u8bd1';",
        ].join('\n');
        const selected = selectReachableChineseMessages(code);
        expect(selected).toHaveProperty('paragraphCopy.notice.copiedOriginal');
        expect(selected).toHaveProperty('paragraphCopy.notice.copiedTranslation');
        expect(selected).toHaveProperty('paragraphCopy.notice.copiedBilingual');
        expect(selected).toHaveProperty('popup.compact.translate', '翻译');
        expect(selected).toHaveProperty('sidepanel.title', '侧边栏翻译');
        expect(selected).toHaveProperty('common.brand', '流畅阅读');

        // C-style for(;;) / destructuring default 中的 of 除法，以及表达式位置 } 后的除法不得误判为正则
        for (const snippet of [
            'for (let x = of / 2; x < 10; x++) { const k = "popup.compact.translate"; const y = b / 2; }',
            'for (let i = 0; i < of / 2; i++) { const k = "popup.compact.translate"; const y = b / 2; }',
            'for (let [a = of / 2] of arr) { const k = "popup.compact.translate"; const y = b / 3; }',
            'const x = { a: 1 } / 2; const k = "popup.compact.translate"; const y = b / 3;',
            'const x = function() {} / 2; const k = "popup.compact.translate"; const y = b / 3;',
            'const x = async function() {} / 2; const k = "popup.compact.translate"; const y = b / 3;',
            'const x = class {} / 2; const k = "popup.compact.translate"; const y = b / 3;',
            'const x = `a ${ {v:1} / 2 } popup.compact.translate ${ b / 3 }`;',
        ]) {
            expect(selectReachableChineseMessages(snippet), snippet).toHaveProperty('popup.compact.translate', '翻译');
        }
    });

    it('prunes site-adaptation catalog JSON for subframe entrypoints without dropping matching rules', () => {
        expect(subframeSiteCatalogBuildPlugin('content')).toBeNull();
        const neteasePlugin = subframeSiteCatalogBuildPlugin('neteaseMailFrame', PROJECT_ROOT)!;
        const catalogImporter = resolve(PROJECT_ROOT, 'src/core/site-adaptation/catalog.ts');
        expect(neteasePlugin.resolveId('./catalog/established.json', catalogImporter)).toContain('established.js');
        expect(neteasePlugin.resolveId('./other.json', catalogImporter)).toBeNull();
        const neteaseWebsites = JSON.parse(neteasePlugin.load(neteasePlugin.resolveId('./catalog/websites.json', catalogImporter)!)!.replace(/^export default /u, '').replace(/;$/u, ''));
        const neteaseEstablished = JSON.parse(neteasePlugin.load(neteasePlugin.resolveId('./catalog/established.json', catalogImporter)!)!.replace(/^export default /u, '').replace(/;$/u, ''));
        expect(neteaseWebsites).toHaveLength(0);
        expect(neteaseEstablished).toHaveLength(0);

        const supportedPlugin = subframeSiteCatalogBuildPlugin('supportedFrame', PROJECT_ROOT)!;
        const supportedWebsites = JSON.parse(supportedPlugin.load(supportedPlugin.resolveId('./catalog/websites.json', catalogImporter)!)!.replace(/^export default /u, '').replace(/;$/u, ''));
        const supportedEstablished = JSON.parse(supportedPlugin.load(supportedPlugin.resolveId('./catalog/established.json', catalogImporter)!)!.replace(/^export default /u, '').replace(/;$/u, ''));
        const totalSupported = supportedWebsites.length + supportedEstablished.length;
        expect(totalSupported).toBeGreaterThan(0);
        expect(totalSupported).toBeLessThan(10);

        const cfg: {plugins?: unknown[]} = {plugins: []};
        extendSubframeSiteCatalogBuildConfig([{type: 'content-script', name: 'supportedFrame'}], cfg);
        expect(cfg.plugins).toHaveLength(1);
        const multiCfg: {plugins?: unknown[]} = {plugins: []};
        extendSubframeSiteCatalogBuildConfig([{type: 'content-script', name: 'content'}], multiCfg);
        expect(multiCfg.plugins).toHaveLength(0);
    });
});
