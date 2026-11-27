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
        expect(wxtConfig.remoteConfigStorageBuildPlugin).toBe(viteHelpers.remoteConfigStorageBuildPlugin);
        expect(wxtConfig.extendRemoteConfigBuildConfig).toBe(viteHelpers.extendRemoteConfigBuildConfig);
        expect(wxtConfig.subframePageContextBuildPlugin).toBe(viteHelpers.subframePageContextBuildPlugin);
        expect(wxtConfig.extendSubframePageContextBuildConfig).toBe(viteHelpers.extendSubframePageContextBuildConfig);
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
        expect(manifestHelpers.resolveOnnxWasmVariant('firefox')).toBe('jspi');
        expect(manifestHelpers.resolveOnnxWasmVariant('safari')).toBe('asyncify');

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
        expect(assetHelpers.resolveExtensionBuildBudget('chrome', false)).toBe(52_734_250);
        expect(assetHelpers.resolveExtensionBuildBudget('edge', false)).toBe(52_729_250);
        expect(assetHelpers.resolveExtensionBuildBudget('firefox', false)).toBe(52_339_250);
        expect(assetHelpers.resolveExtensionBuildBudget('safari', false)).toBe(61_345_250);
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

    it('Vite/Rolldown 辅助插件按入口组正确路由、裁剪与挂接过滤器', () => {
        const remoteConfig: {plugins?: unknown[]} = {plugins: []};
        viteHelpers.extendRemoteConfigBuildConfig([{type: 'popup'}], remoteConfig);
        expect(remoteConfig.plugins).toHaveLength(1);

        const mixedConfig: {plugins?: unknown[]} = {plugins: []};
        viteHelpers.extendRemoteConfigBuildConfig([{type: 'background'}], mixedConfig);
        expect(mixedConfig.plugins).toHaveLength(0);

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

        const filterTarget = {
            plugins: [{name: 'fluentread-defuddle-entity-decoder', transform: (code: string) => code}],
        };
        viteHelpers.attachRolldownTransformFilters(filterTarget);
        const transformed = filterTarget.plugins[0] as unknown as {transform: {filter: {id: RegExp}; handler: unknown}};
        expect(transformed.transform.filter.id).toBeInstanceOf(RegExp);
        expect(typeof transformed.transform.handler).toBe('function');
    });
});
