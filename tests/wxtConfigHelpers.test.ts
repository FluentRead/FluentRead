/**
 * @file tests/wxtConfigHelpers.test.ts
 * 文件职责：验证从 wxt.config.ts 拆出的清单、Vite/Rolldown 优化与产物资源辅助模块的行为等价性与重导出完整性。
 * 主要内容：覆盖 Safari/Firefox/Chrome 清单片段、ONNX 变体、非字符转义、Chrome ZIP 校验、体积预算精确值与所有 wxt.config.ts 重导出标识。
 * 模块边界：纯构建配置辅助模块单测，不启动完整 WXT/Vite 扩展打包流程。
 */
import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import JSZip from 'jszip';
import {afterEach, describe, expect, it} from 'vitest';
import * as wxtConfig from '@/wxt.config';
import * as manifestHelpers from '@/scripts/testing/wxt-manifest-helpers';
import * as viteHelpers from '@/scripts/testing/wxt-vite-helpers';
import * as assetHelpers from '@/scripts/testing/wxt-asset-helpers';

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop()!, {recursive: true, force: true});
    }
});

describe('wxt.config extracted helpers', () => {
    it('wxt.config.ts 保持全部历史导出并与拆分模块引用一致', () => {
        expect(wxtConfig.resolveOnnxWasmVariant).toBe(manifestHelpers.resolveOnnxWasmVariant);
        expect(wxtConfig.createSafariBackgroundPage).toBe(manifestHelpers.createSafariBackgroundPage);
        expect(wxtConfig.configureSafariBackgroundPage).toBe(manifestHelpers.configureSafariBackgroundPage);
        expect(wxtConfig.configureStableContentUiResources).toBe(manifestHelpers.configureStableContentUiResources);
        expect(wxtConfig.finalizeExtensionZip).toBe(assetHelpers.finalizeExtensionZip);
        expect(wxtConfig.isFastZipEnabled).toBe(assetHelpers.isFastZipEnabled);
        expect(wxtConfig.aiSdkGatewayStubBuildPlugin).toBe(viteHelpers.aiSdkGatewayStubBuildPlugin);
        expect(wxtConfig.remoteConfigStorageBuildPlugin).toBe(viteHelpers.remoteConfigStorageBuildPlugin);
        expect(wxtConfig.extendRemoteConfigBuildConfig).toBe(viteHelpers.extendRemoteConfigBuildConfig);
        expect(wxtConfig.subframePageContextBuildPlugin).toBe(viteHelpers.subframePageContextBuildPlugin);
        expect(wxtConfig.extendSubframePageContextBuildConfig).toBe(viteHelpers.extendSubframePageContextBuildConfig);
        expect(wxtConfig.subframeSiteCatalogBuildPlugin).toBe(viteHelpers.subframeSiteCatalogBuildPlugin);
        expect(wxtConfig.extendSubframeSiteCatalogBuildConfig).toBe(viteHelpers.extendSubframeSiteCatalogBuildConfig);
        expect(wxtConfig.subframeSiteRulesBuildPlugin).toBe(viteHelpers.subframeSiteRulesBuildPlugin);
        expect(wxtConfig.extendSubframeSiteRulesBuildConfig).toBe(viteHelpers.extendSubframeSiteRulesBuildConfig);
        expect(wxtConfig.extendScopedChineseCatalogBuildConfig).toBe(viteHelpers.extendScopedChineseCatalogBuildConfig);
        expect(wxtConfig.pruneEntrypointVitePlugins).toBe(viteHelpers.pruneEntrypointVitePlugins);
        expect(wxtConfig.attachRolldownTransformFilters).toBe(viteHelpers.attachRolldownTransformFilters);
        expect(wxtConfig.groupModuleWorkers).toBe(viteHelpers.groupModuleWorkers);
        expect(wxtConfig.configureExtensionUiChunks).toBe(viteHelpers.configureExtensionUiChunks);
        expect(typeof wxtConfig.createExtensionManifest).toBe('function');
    });

    it('清单片段辅助函数按目标浏览器生成精确字段', () => {
        expect(manifestHelpers.resolveOnnxWasmVariant('chrome')).toBe('jspi');
        expect(manifestHelpers.resolveOnnxWasmVariant('edge')).toBe('jspi');
        expect(manifestHelpers.resolveOnnxWasmVariant('firefox')).toBe('asyncify');
        expect(manifestHelpers.resolveOnnxWasmVariant('safari')).toBe('asyncify');
        expect(manifestHelpers.resolveOnnxWasmVariant('thunderbird')).toBe('asyncify');

        expect(manifestHelpers.createChromiumManifest({browser: 'chrome'})).toEqual({minimum_chrome_version: '137'});
        expect(manifestHelpers.createChromiumManifest({browser: 'edge'})).toEqual({minimum_chrome_version: '137'});
        expect(manifestHelpers.createChromiumManifest({browser: 'firefox'})).toEqual({});
        expect(manifestHelpers.createChromiumManifest({browser: 'safari'})).toEqual({});

        expect(manifestHelpers.createSafariBackgroundPage({browser: 'chrome', manifestVersion: 3})).toEqual([]);
        const safariPages = manifestHelpers.createSafariBackgroundPage({browser: 'safari', manifestVersion: 2});
        expect(safariPages).toHaveLength(1);
        expect(safariPages[0]!.relativeDest).toBe('safari-background.html');
        expect(safariPages[0]!.contents).toContain('<meta charset="utf-8">');

        const safariManifest = {background: {persistent: false, scripts: ['background.js']}} as {
            background?: {scripts?: string[]; persistent?: boolean; page?: string; service_worker?: string};
        };
        manifestHelpers.configureSafariBackgroundPage({browser: 'safari', manifestVersion: 2}, safariManifest);
        expect(safariManifest.background).toEqual({persistent: false, page: 'safari-background.html'});

        const chromeDrive = manifestHelpers.createGoogleDriveManifest({browser: 'chrome'}, {
            WXT_GOOGLE_CLIENT_ID: 'custom-client-id',
            WXT_EXTENSION_KEY: 'custom-key',
        }) as {oauth2?: {client_id: string}; key?: string};
        expect(chromeDrive.oauth2?.client_id).toBe('custom-client-id');
        expect(chromeDrive.key).toBe('custom-key');
        expect(manifestHelpers.createGoogleDriveManifest({browser: 'firefox'})).toEqual({});

        const firefox = manifestHelpers.createFirefoxManifest({browser: 'firefox'}) as {
            optional_permissions?: string[];
            browser_specific_settings?: {gecko?: {strict_min_version?: string}};
        };
        expect(firefox.optional_permissions).toEqual(['downloads']);
        expect(firefox.browser_specific_settings?.gecko?.strict_min_version).toBe('140.0');

        const safari = manifestHelpers.createSafariManifest({browser: 'safari', manifestVersion: 2}) as {
            optional_permissions?: string[];
            browser_specific_settings?: {safari?: {strict_min_version?: string}};
        };
        expect(safari.browser_specific_settings?.safari?.strict_min_version).toBe('26.0');
        expect(Array.isArray(safari.optional_permissions)).toBe(true);
        expect(safari.optional_permissions!.length).toBeGreaterThan(0);

        const chromeResources = manifestHelpers.createExtensionWebAccessibleResources({browser: 'chrome'}) as Array<{use_dynamic_url?: boolean}>;
        const safariResources = manifestHelpers.createExtensionWebAccessibleResources({browser: 'safari'}) as Array<{use_dynamic_url?: boolean}>;
        expect(chromeResources[2]!.use_dynamic_url).toBe(true);
        expect(safariResources[2]!.use_dynamic_url).toBeUndefined();
    });

    it('escapeExtensionNoncharacters 仅转义 chunk 中的 U+FFFE 与 U+FFFF', () => {
        const plugin = assetHelpers.escapeExtensionNoncharacters();
        expect(plugin.name).toBe('escape-extension-noncharacters');
        const bundle: Record<string, {type: string; code?: string}> = {
            'bg.js': {type: 'chunk', code: 'const a = "\uFFFE\uFFFF";'},
            'clean.js': {type: 'chunk', code: 'const b = "hello";'},
            'style.css': {type: 'asset', code: '\uFFFF'},
        };
        plugin.generateBundle({}, bundle);
        expect(bundle['bg.js']!.code).toBe('const a = "\\uFFFE\\uFFFF";');
        expect(bundle['clean.js']!.code).toBe('const b = "hello";');
        expect(bundle['style.css']!.code).toBe('\uFFFF');
    });

    it('resolveExtensionBuildBudget 与拆分前生产/开发各平台字节上限严格一致', () => {
        expect(assetHelpers.resolveExtensionBuildBudget('chrome', true, false)).toBe(70_000_000);
        expect(assetHelpers.resolveExtensionBuildBudget('chrome', true, true)).toBe(170_000_000);
        expect(assetHelpers.resolveExtensionBuildBudget('chrome', false)).toBe(53_699_250);
        expect(assetHelpers.resolveExtensionBuildBudget('edge', false)).toBe(53_694_250);
        expect(assetHelpers.resolveExtensionBuildBudget('firefox', false)).toBe(62_754_250);
        expect(assetHelpers.resolveExtensionBuildBudget('safari', false)).toBe(62_760_250);
    });

    it('finalizeExtensionZip 验证 Chrome ZIP 固定身份并清理旧 store 包', async () => {
        const dir = createTempDir('fluentread-zip-finalize-');
        const zipPath = join(dir, 'fluent-read-0.0.42-chrome.zip');
        const oldStoreZip = join(dir, 'fluent-read-0.0.42-chrome-store.zip');

        const validZip = new JSZip();
        validZip.file('manifest.json', JSON.stringify({name: 'FluentRead', key: 'MIIBIjANBgkqh'}));
        writeFileSync(zipPath, await validZip.generateAsync({type: 'nodebuffer'}));
        writeFileSync(oldStoreZip, 'legacy-store-package');

        await assetHelpers.finalizeExtensionZip('chrome', zipPath);
        expect(existsSync(oldStoreZip)).toBe(false);

        // 非 Chrome 浏览器直接跳过
        await expect(assetHelpers.finalizeExtensionZip('firefox', join(dir, 'missing.zip'))).resolves.toBeUndefined();

        // 缺少 key 的 Chrome ZIP 必须拒绝
        const noKeyZip = new JSZip();
        noKeyZip.file('manifest.json', JSON.stringify({name: 'FluentRead'}));
        const badZipPath = join(dir, 'bad.zip');
        writeFileSync(badZipPath, await noKeyZip.generateAsync({type: 'nodebuffer'}));
        await expect(assetHelpers.finalizeExtensionZip('chrome', badZipPath)).rejects.toThrow(/key/u);
    });

    it('Vite/Rolldown 辅助插件按入口组正确路由、裁剪、挂接过滤器与拆分扩展 UI 块', () => {
        const remoteConfig: {plugins?: unknown[]} = {plugins: []};
        viteHelpers.extendRemoteConfigBuildConfig([{type: 'popup'}], remoteConfig);
        expect(remoteConfig.plugins).toHaveLength(1);

        const namelessContentRemote: {plugins?: unknown[]} = {plugins: []};
        viteHelpers.extendRemoteConfigBuildConfig([{type: 'content-script'}], namelessContentRemote);
        expect(namelessContentRemote.plugins).toHaveLength(1);

        const contentRemote: {plugins?: unknown[]} = {plugins: []};
        viteHelpers.extendRemoteConfigBuildConfig([{type: 'content-script', name: 'content'}], contentRemote);
        expect(contentRemote.plugins).toHaveLength(1);

        const mixedConfig: {plugins?: unknown[]} = {plugins: []};
        viteHelpers.extendRemoteConfigBuildConfig([{type: 'background'}], mixedConfig);
        expect(mixedConfig.plugins).toHaveLength(0);

        for (const name of ['bilibiliCaptionBridge', 'shadowBridge', 'xVideoBridge', 'youtubeBridge', 'youtubeEmbedBridge', 'videoPcmWorklet']) {
            const type = name === 'videoPcmWorklet' ? 'unlisted-script' : 'content-script';
            const bridgeRemote: {plugins?: unknown[]} = {plugins: []};
            viteHelpers.extendRemoteConfigBuildConfig([{type, name}], bridgeRemote);
            expect(bridgeRemote.plugins).toEqual([]);

            const bridgeCatalog: {plugins?: unknown[]} = {plugins: []};
            viteHelpers.extendScopedChineseCatalogBuildConfig([{type, name}], bridgeCatalog);
            expect(bridgeCatalog.plugins).toEqual([]);
        }

        const pluginList = {
            plugins: [
                {name: 'vite:vue'},
                {name: 'fluentread-shared-onnx'},
                {name: 'fluentread-defuddle-entity-decoder', transform: () => null},
                {name: 'keep-me'},
            ],
        };
        viteHelpers.pruneEntrypointVitePlugins([{type: 'background', name: 'background'}], pluginList);
        expect(pluginList.plugins.map(p => (p as {name: string}).name)).toEqual(['fluentread-shared-onnx', 'keep-me']);

        const bridgePlugins = {
            plugins: [
                {name: 'vite:vue'},
                {name: 'fluentread-deferred-franc-models'},
                {name: 'fluentread-extension-csp-vendor'},
                {name: 'escape-extension-noncharacters'},
            ],
        };
        viteHelpers.pruneEntrypointVitePlugins([{type: 'content-script', name: 'youtubeBridge'}], bridgePlugins);
        expect(bridgePlugins.plugins.map(p => (p as {name: string}).name)).toEqual(['escape-extension-noncharacters']);

        const filterTarget = {
            plugins: [
                {name: 'fluentread-defuddle-entity-decoder', transform: (code: string) => code},
                {name: 'fluentread-extension-csp-vendor', transform: (code: string) => code},
            ],
        };
        viteHelpers.attachRolldownTransformFilters(filterTarget);
        const transformedDefuddle = filterTarget.plugins[0] as unknown as {transform: {filter: {id: RegExp}; handler: unknown}};
        expect(transformedDefuddle.transform.filter.id).toBeInstanceOf(RegExp);
        expect(typeof transformedDefuddle.transform.handler).toBe('function');

        const transformedCsp = filterTarget.plugins[1] as unknown as {transform: {filter: {id: RegExp}; handler: unknown}};
        expect(transformedCsp.transform.filter.id.test('/app/node_modules/pdfjs-dist/legacy/build/pdf.mjs')).toBe(true);
        expect(transformedCsp.transform.filter.id.test('/app/node_modules/zod/v4/core/schemas.js')).toBe(true);
        expect(transformedCsp.transform.filter.id.test('/app/src/app/popup/main.ts')).toBe(false);

        const uiChunkConfig: {build?: {rolldownOptions?: {output?: {codeSplitting?: {groups: {name: string; test: RegExp}[]}}}}} = {};
        viteHelpers.configureExtensionUiChunks([{type: 'popup'}, {type: 'options'}], uiChunkConfig);
        const groups = uiChunkConfig.build!.rolldownOptions!.output!.codeSplitting!.groups;
        expect(groups.map(group => group.name)).toEqual(['vue-runtime', 'domain-parser', 'zh-cn-catalog']);
        const choose = (id: string) => groups.find(group => group.test.test(id))?.name;
        expect(choose('/app/src/core/i18n/messages/zh-CN.ts')).toBe('zh-cn-catalog');
        expect(choose(String.raw`C:\app\src\core\i18n\messages\settings-copy\zh-CN.json`)).toBe('zh-cn-catalog');
        expect(choose('/app/src/core/i18n/index.ts')).toBeUndefined();

        const gatewayPlugin = viteHelpers.aiSdkGatewayStubBuildPlugin();
        expect(gatewayPlugin.name).toBe('fluentread-ai-sdk-gateway-stub');
        const resolvedGateway = gatewayPlugin.resolveId('@ai-sdk/gateway', '/app/node_modules/.pnpm/ai@7.0.165/node_modules/ai/dist/index.js');
        expect(resolvedGateway).toBe('\0fluentread-ai-sdk-gateway-stub');
        expect(gatewayPlugin.resolveId('@ai-sdk/gateway', '/app/node_modules/ai/dist/index.js')).toBe('\0fluentread-ai-sdk-gateway-stub');
        expect(gatewayPlugin.resolveId('@ai-sdk/gateway', '/app/node_modules/some-pkg/src/ai/index.js')).toBeNull();
        expect(gatewayPlugin.resolveId('@ai-sdk/gateway', '/app/src/app/background/runtime.ts')).toBeNull();
        expect(gatewayPlugin.resolveId('ai', '/app/node_modules/ai/dist/index.js')).toBeNull();
        const stubCode = gatewayPlugin.load(resolvedGateway!);
        expect(stubCode).toContain('GatewayError');
        expect(stubCode).toContain('GatewayAuthenticationError');
        expect(stubCode).toContain('createGateway');
        expect(stubCode).toContain('specificationVersion: "v4"');
        expect(stubCode).toContain('gateway');
        expect(gatewayPlugin.load('\0other')).toBeNull();
    });
});
