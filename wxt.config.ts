import fs from 'fs';
import {resolve} from 'path';
import vue from '@vitejs/plugin-vue';
import type {PluginOption} from 'vite';
import {defineConfig, type ConfigEnv, type UserManifest} from 'wxt';
import {resolveBrowserCapabilities} from './src/platform/browser/capabilities';
import {sharedOnnxBuildPlugin, sharedOnnxDist} from './scripts/wasm/manga-onnx-build';
import {kokoroTransformersBuildPlugin} from './scripts/wasm/kokoro-transformers-build';
import {packageWasmDiagnostics} from './scripts/wasm/package-diagnostics';
import {tesseractSdkBuildPlugin} from './scripts/wasm/tesseract-sdk-build';
import {compactExtensionZip} from './scripts/wasm/compact-extension-zip';
import {createDeepLXRuntimeBuildPlugin} from './scripts/testing/deeplx-runtime-build';
import {defuddleEntityBuildPlugin} from './scripts/testing/defuddle-entity-build';
import {dictionaryScriptBuildPlugin} from './scripts/testing/dictionary-script-build';
import {extensionCspBuildPlugin} from './scripts/testing/extension-csp-build';
import {checkExtensionSize} from './scripts/testing/extension-size-budget';
import {francRuntimeBuildPlugin} from './scripts/testing/franc-runtime-build';
import {createPdfReaderBidiBuildPlugin} from './scripts/testing/pdfjs-bidi-build';
import {createReadingDictionaryAliases} from './scripts/testing/reading-annotation-build';
import {wllamaExtensionWorker} from './scripts/testing/wllama-extension-build';
import {
    configureSafariBackgroundPage,
    configureStableContentUiResources,
    createChromiumManifest,
    createExtensionWebAccessibleResources,
    createFirefoxManifest,
    createGoogleDriveManifest,
    createSafariBackgroundPage,
    createSafariManifest,
    EXTENSION_HOST_PERMISSIONS,
    resolveOnnxWasmVariant,
} from './scripts/testing/wxt-manifest-helpers';
import {
    aiSdkGatewayStubBuildPlugin,
    attachRolldownTransformFilters,
    configureExtensionUiChunks,
    extendRemoteConfigBuildConfig,
    extendScopedChineseCatalogBuildConfig,
    extendSubframePageContextBuildConfig,
    extendSubframeSiteCatalogBuildConfig,
    extendSubframeSiteRulesBuildConfig,
    groupModuleWorkers,
    pruneEntrypointVitePlugins,
    remoteConfigStorageBuildPlugin,
    subframePageContextBuildPlugin,
    subframeSiteCatalogBuildPlugin,
    subframeSiteRulesBuildPlugin,
} from './scripts/testing/wxt-vite-helpers';
import {
    collectStaticExtensionPublicAssets,
    escapeExtensionNoncharacters,
    finalizeExtensionZip,
    isFastZipEnabled,
    resolveExtensionBuildBudget,
} from './scripts/testing/wxt-asset-helpers';

export {
    resolveOnnxWasmVariant,
    createSafariBackgroundPage,
    configureSafariBackgroundPage,
    configureStableContentUiResources,
    finalizeExtensionZip,
    isFastZipEnabled,
    aiSdkGatewayStubBuildPlugin,
    remoteConfigStorageBuildPlugin,
    extendRemoteConfigBuildConfig,
    subframePageContextBuildPlugin,
    extendSubframePageContextBuildConfig,
    subframeSiteCatalogBuildPlugin,
    extendSubframeSiteCatalogBuildConfig,
    subframeSiteRulesBuildPlugin,
    extendSubframeSiteRulesBuildConfig,
    extendScopedChineseCatalogBuildConfig,
    pruneEntrypointVitePlugins,
    attachRolldownTransformFilters,
    groupModuleWorkers,
    configureExtensionUiChunks,
};

const packageJson = JSON.parse(fs.readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
const firefoxRunnerBinary = process.env.FLUENTREAD_FIREFOX_RUNNER_BINARY;
const firefoxRunnerProfile = process.env.FLUENTREAD_FIREFOX_RUNNER_PROFILE;
const firefoxRunnerStartUrl = process.env.FLUENTREAD_FIREFOX_RUNNER_START_URL;

/** 根据编译目标能力生成权限，避免 Firefox/MV2 产物声明不可用的 Offscreen API。 */
export function createExtensionManifest(
    env: Pick<ConfigEnv, 'browser' | 'manifestVersion'>,
): UserManifest {
    const capabilities = resolveBrowserCapabilities(env);
    return {
        name: '__MSG_extensionName__',
        description: '__MSG_extensionDescription__',
        default_locale: 'en',
        ...(['chrome', 'edge', 'firefox'].includes(env.browser) ? {
            commands: {'open-translation-window': {description: 'Open translation window'}},
        } : {}),
        permissions: [
            ...(env.manifestVersion === 3 ? ['scripting'] : []),
            'storage',
            'unlimitedStorage',
            'alarms',
            'contextMenus',
            'declarativeNetRequestWithHostAccess',
            ...(env.browser === 'chrome' ? ['identity'] : []),
            ...(capabilities.offscreenDocument ? ['offscreen'] : []),
        ],
        content_security_policy: {
            // 扩展页面只执行自身静态脚本和 WASM；本地 TTS Worker 通过打包的
            // 静态 MJS 与随包原始 CPU/WebGPU WASM（Edge 商店拒绝嵌套压缩文件），不放宽到 blob 脚本。
            extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
        },
        host_permissions: [...EXTENSION_HOST_PERMISSIONS],
        web_accessible_resources: createExtensionWebAccessibleResources(env),
        ...createChromiumManifest(env),
        ...createFirefoxManifest(env),
        ...createSafariManifest(env),
        ...createGoogleDriveManifest(env),
    } as UserManifest;
}

let cachedBuildStaticSetup: {
    alias: ReturnType<typeof createReadingDictionaryAliases>;
    plugins: PluginOption[];
} | undefined;

function getBuildStaticSetup() {
    if (!cachedBuildStaticSetup) {
        cachedBuildStaticSetup = {
            alias: createReadingDictionaryAliases(__dirname),
            plugins: [
                dictionaryScriptBuildPlugin(),
                createDeepLXRuntimeBuildPlugin(__dirname),
                createPdfReaderBidiBuildPlugin(__dirname),
                extensionCspBuildPlugin(),
                defuddleEntityBuildPlugin(),
                francRuntimeBuildPlugin(),
                sharedOnnxBuildPlugin(),
                kokoroTransformersBuildPlugin(),
                aiSdkGatewayStubBuildPlugin(),
                wllamaExtensionWorker(),
                tesseractSdkBuildPlugin(),
                escapeExtensionNoncharacters(),
            ],
        };
    }
    return cachedBuildStaticSetup;
}

// WXT 配置参考：https://wxt.dev/api/config.html
export default defineConfig({
    modules: ['@wxt-dev/webextension-polyfill'],
    // Firefox 的开发 runner 使用一次性 profile；预置启动参数，避免每轮 UI
    // 回归都被 about:welcome 首次启动引导遮挡。仅影响 pnpm dev:firefox，
    // 不会写入用户 Firefox profile，也不会进入扩展发布产物。
    webExt: {
        disabled: process.env.FLUENTREAD_DISABLE_BROWSER_RUNNER === '1',
        binaries: firefoxRunnerBinary ? {firefox: firefoxRunnerBinary} : undefined,
        firefoxProfile: firefoxRunnerProfile || undefined,
        startUrls: [firefoxRunnerStartUrl || 'about:blank'],
        firefoxPref: {
            'browser.aboutwelcome.enabled': false,
            'browser.aboutwelcome.screens': '',
            'browser.startup.homepage_override.mstone': 'ignore',
            'browser.startup.homepage_override.buildID': 'ignore',
            'startup.homepage_override_url': 'about:blank',
            'startup.homepage_override_nimbus_disable_wnp': true,
            'browser.messaging-system.whatsNewPanel.enabled': false,
            'browser.startup.homepage': 'about:blank',
            'startup.homepage_welcome_url': 'about:blank',
            'startup.homepage_welcome_url.additional': '',
            'trailhead.firstrun.didSeeAboutWelcome': true,
            'trailhead.firstrun.branches': 'nofirstrun-exp',
            'browser.shell.checkDefaultBrowser': false,
        },
    },
    imports: {
        // Vue 模板不使用 WXT 自动导入；源文件的进一步过滤由 attachRolldownTransformFilters 在 Rolldown 原生侧执行。
        addons: {
            vueTemplate: false,
        },
    },
    vite: (env) => {
        const isProductionBuild = env.command === 'build' && env.mode === 'production';
        const browserTargets: Readonly<Record<string, string>> = {chrome: 'chrome137', edge: 'edge137', firefox: 'firefox140', safari: 'safari26'};
        const staticSetup = getBuildStaticSetup();
        return {
            // 固定版本的本地分词算法通过缓存适配器读取纯数据，不采用供应商自带的网络加载器。
            resolve: {alias: staticSetup.alias},
            plugins: [...staticSetup.plugins, vue()],
            // WXT 默认在每个开发脚本中内联源码与 sourcemap；需要源码调试时显式开启。
            build: {
                // WXT 不展示 Vite 的 gzip 统计；实际产物和安装包继续由独立体积门禁校验。
                reportCompressedSize: false,
                // 各目标浏览器已在 manifest 明确最低版本（Chrome/Edge 137、Firefox 140、Safari 26）。
                target: browserTargets[env.browser] ?? ['es2020', 'edge137', 'firefox140', 'chrome137', 'safari26'],
                // 源码层脱敏之外，生产构建也移除 console 和 debugger。
                ...(isProductionBuild ? {rolldownOptions: {output: {minify: {mangle: true, compress: {dropConsole: true, dropDebugger: true}}}}} : {}),
                ...(env.command === 'serve' ? {sourcemap: process.env.FLUENTREAD_DEV_SOURCEMAPS === '1' ? 'inline' as const : false} : {}),
            },
            define: {
                'process.env.VUE_APP_VERSION': JSON.stringify(packageJson.version),
                '__FLUENTREAD_ONNX_WASM_VARIANT__': JSON.stringify(resolveOnnxWasmVariant(env.browser)),
            },
        };
    },
    manifest: createExtensionManifest,
    zip: {
        name: 'fluent-read',
        // 发布包默认采用标准 DEFLATE 最高压缩等级；显式设置 FLUENTREAD_ZIP_FAST=1 时切换为快速本地打包。
        compressionLevel: isFastZipEnabled() ? 1 : 9,
        // WXT 0.21 将 includeSources 作为白名单。仅包含复现扩展和审核所需的
        // 文件，点文件只明确允许 .nvmrc，避免带入 .env 等本地配置。
        includeSources: [
            '.nvmrc', 'LICENSE', 'README.md', 'PRIVACY.md', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'wxt.config.ts',
            'entrypoints/**', 'src/**', 'assets/**', 'misc/**', 'public/**', 'scripts/**',
            'docs/development/service-icons.md', 'docs/guide/deepseek-harness.md',
        ],
        excludeSources: ['coverage/**', 'scripts/testing/evidence/**', '**/.DS_Store'],
    },
    hooks: {
        'build:manifestGenerated': (wxt, manifest) => {
            configureSafariBackgroundPage(wxt.config, manifest);
            configureStableContentUiResources(wxt.config, manifest);
            // 保留 WXT 构建的侧边栏页面及权限，显示范围由打开操作注册。
            if (wxt.config.browser === 'chrome' || wxt.config.browser === 'edge') delete manifest.side_panel;
        },
        'zip:extension:done': async (wxt, zipPath) => {
            await finalizeExtensionZip(wxt.config.browser, zipPath);
            if (isFastZipEnabled()) {
                wxt.logger.warn('FLUENTREAD_ZIP_FAST=1 已启用：使用 DEFLATE 1 级且跳过 Zopfli WASM 压缩（仅限本地验证，请勿用于商店发布）');
                return;
            }
            const compact = await compactExtensionZip(zipPath, __dirname);
            wxt.logger.info(`WASM ZIP compression saved ${compact.savedBytes.toLocaleString('en-US')} bytes`);
        },
        'build:done': async (wxt) => {
            // 可选词典按需下载，不再为离线读音放宽安装包体积预算。
            if (fs.existsSync(resolve(wxt.config.outDir, 'reading-annotation'))) throw new Error('读音离线数据不得随扩展打包');
            const maxBytes = resolveExtensionBuildBudget(wxt.config.browser, wxt.config.command === 'serve');
            await checkExtensionSize(wxt.config.outDir, maxBytes);
        },
        'entrypoints:grouped': (_wxt, groups) => {
            groupModuleWorkers(groups);
        },
        'vite:build:extendConfig': (entrypoints, viteConfig) => {
            extendRemoteConfigBuildConfig(entrypoints, viteConfig as {plugins?: unknown[]});
            extendSubframePageContextBuildConfig(entrypoints, viteConfig as {plugins?: unknown[]});
            extendSubframeSiteCatalogBuildConfig(entrypoints, viteConfig as {plugins?: unknown[]});
            extendSubframeSiteRulesBuildConfig(entrypoints, viteConfig as {plugins?: unknown[]});
            extendScopedChineseCatalogBuildConfig(entrypoints, viteConfig as {plugins?: unknown[]});
            pruneEntrypointVitePlugins(entrypoints, viteConfig as {plugins?: unknown[]});
            attachRolldownTransformFilters(viteConfig as {plugins?: unknown[]});
            configureExtensionUiChunks(entrypoints, viteConfig);
            // Vite 的动态导入预加载帮助器访问 document；模块 Worker 只能使用原生 import。
            if (entrypoints.every(entrypoint => entrypoint.type === 'unlisted-script')) {
                viteConfig.build = {...viteConfig.build, modulePreload: false};
            }
        },
        'build:publicAssets': (wxt, files) => {
            files.push(...createSafariBackgroundPage(wxt.config));
            files.push(...collectStaticExtensionPublicAssets(__dirname));
            // JS 和 WASM 来自同一锁定版本；模型数据继续按需下载，执行代码只用包内资源。
            const ortDist = sharedOnnxDist();
            const onnxVariant = resolveOnnxWasmVariant(wxt.config.browser);
            const onnxMjs = `ort-wasm-simd-threaded.${onnxVariant}.mjs`;
            const onnxWasm = `ort-wasm-simd-threaded.${onnxVariant}.wasm`;
            files.push({absoluteSrc: packageWasmDiagnostics(__dirname, resolve(ortDist, onnxMjs), onnxMjs, 'onnx'), relativeDest: `fluent-read-ai/${onnxMjs}`});
            files.push({absoluteSrc: resolve(ortDist, onnxWasm), relativeDest: `fluent-read-ai/${onnxWasm}`});
        },
    },
});
