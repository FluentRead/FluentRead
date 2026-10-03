import {defineConfig, type ConfigEnv, type UserManifest, type Entrypoint, type EntrypointGroup} from 'wxt';
import vue from '@vitejs/plugin-vue';
import {resolve} from 'path';
import fs from 'fs';
import {resolveBrowserCapabilities} from './src/platform/browser/capabilities';
import {wllamaExtensionWorker} from './scripts/testing/wllama-extension-build';
import {createUiLanguageBundleFiles} from './src/core/i18n/bundles';
import {UI_LANGUAGE_BUNDLE_DIRECTORY} from './src/core/i18n/language';
import {packageWasmDiagnostics, packageTesseractWasm} from './scripts/wasm/package-diagnostics';
import {GOOGLE_DRIVE_DEFAULT_CLIENT_ID, GOOGLE_DRIVE_EXTENSION_PUBLIC_KEY, GOOGLE_DRIVE_SCOPES} from './src/platform/google-drive/constants';


const packageJson = JSON.parse(fs.readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
const firefoxRunnerBinary = process.env.FLUENTREAD_FIREFOX_RUNNER_BINARY;
const firefoxRunnerProfile = process.env.FLUENTREAD_FIREFOX_RUNNER_PROFILE;
const firefoxRunnerStartUrl = process.env.FLUENTREAD_FIREFOX_RUNNER_START_URL;

function resolvePnpmDependencyDist(ownerPackagePath: string, dependencyName: string): string {
    const ownerPackage = JSON.parse(fs.readFileSync(resolve(__dirname, ownerPackagePath, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
    };
    const dependencyVersion = ownerPackage.dependencies?.[dependencyName];
    if (!dependencyVersion) throw new Error(`无法从 ${ownerPackagePath} 定位 ${dependencyName} 版本`);
    const pnpmRoot = resolve(__dirname, 'node_modules/.pnpm');
    const packagePrefix = `${dependencyName}@${dependencyVersion}`;
    const packageDirectory = fs.readdirSync(pnpmRoot).find((name) => name === packagePrefix || name.startsWith(`${packagePrefix}-`));
    if (!packageDirectory) throw new Error(`无法定位 ${packagePrefix} 的本地依赖产物`);
    return resolve(pnpmRoot, packageDirectory, 'node_modules', dependencyName, 'dist');
}

/**
 * Edge 的扩展内容脚本加载器会拒绝产物中的 Unicode 非字符 U+FFFE/U+FFFF，
 * 并把它们误报成“不是 UTF-8 编码”。部分第三方解析器会把源码中的转义
 * 序列展开成这些字符，因此在最终 JavaScript chunk 中重新写成 ASCII 转义，
 * 保持运行时值不变，同时避免扩展加载失败。
 */
function escapeExtensionNoncharacters() {
    const escapeActualNoncharacters = (code: string) => code.replace(/[\uFFFE\uFFFF]/g, (character) => {
        const codePoint = character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
        return `\\u${codePoint}`;
    });

    return {
        name: 'escape-extension-noncharacters',
        generateBundle(_options: unknown, bundle: Record<string, {type: string; code?: string}>) {
            // 部分构建阶段会在 renderChunk 之后再次序列化字符串，因此在
            // 写入扩展目录前再检查一次最终 chunk，覆盖后台脚本等产物。
            for (const chunk of Object.values(bundle)) {
                if (chunk.type !== 'chunk' || chunk.code === undefined) continue;

                const escaped = escapeActualNoncharacters(chunk.code);
                if (escaped !== chunk.code) chunk.code = escaped;
            }
        },
    };
}

/**
 * 内容脚本和扩展 UI 永远通过 runtime 代理读取后台权威配置。通用配置存储运行时同时
 * 装配后台加密 IndexedDB（Dexie、加密与旧存储迁移），这些非后台入口无需解析它们；
 * 只对明确不包含后台的构建组使用纯远程实现，MV2 background page 仍保留数据库端口。
 */
export function remoteConfigStorageBuildPlugin() {
    const runtimeModule = /\/src\/platform\/storage\/configStorageRuntime(?:\.ts)?$/u;
    const remoteRuntime = resolve(__dirname, 'src/platform/storage/remoteConfigStorageRuntime.ts');
    return {
        name: 'fluentread-remote-config-storage',
        enforce: 'pre' as const,
        resolveId(source: string) {
            return runtimeModule.test(source) ? remoteRuntime : null;
        },
    };
}

export function extendRemoteConfigBuildConfig(
    entrypoints: readonly {type: string}[],
    viteConfig: {plugins?: unknown[]},
): void {
    const remoteOnlyTypes = new Set(['content-script', 'popup', 'options', 'unlisted-page']);
    if (entrypoints.length === 0 || !entrypoints.every((entrypoint) => remoteOnlyTypes.has(entrypoint.type))) return;
    viteConfig.plugins = [...(viteConfig.plugins ?? []), remoteConfigStorageBuildPlugin()];
}

/** 三个入口都由 new Worker(..., {type: 'module'}) 启动，可共享一次 ESM 构建及依赖 chunk。 */
export function groupModuleWorkers(groups: EntrypointGroup[]): void {
    const moduleWorkers = new Set(['localTranslationWorker', 'localTtsWorker', 'videoTranscriptionWorker']);
    const workers = groups.filter((group): group is Entrypoint =>
        !Array.isArray(group) && group.type === 'unlisted-script' && moduleWorkers.has(group.name));
    if (workers.length < 2) return;
    const index = groups.indexOf(workers[0]);
    for (const worker of workers) groups.splice(groups.indexOf(worker), 1);
    // 只组合明确使用模块加载的自有 Worker；内容脚本和 classic background 仍由 WXT 单独打包。
    groups.splice(index, 0, workers);
}

/** 根据编译目标能力生成权限，避免 Firefox/MV2 产物声明不可用的 Offscreen API。 */
export function createExtensionManifest(
    env: Pick<ConfigEnv, 'browser' | 'manifestVersion'>,
): UserManifest {
    const capabilities = resolveBrowserCapabilities(env);
    // manifest 回调在 WXT 加载 .env 后执行；公开 Client ID 可随扩展发布。
    const googleDriveManifest = env.browser === 'chrome' ? {
        oauth2: {client_id: process.env.WXT_GOOGLE_CLIENT_ID?.trim() || GOOGLE_DRIVE_DEFAULT_CLIENT_ID, scopes: [...GOOGLE_DRIVE_SCOPES]},
        key: process.env.WXT_EXTENSION_KEY?.trim() || GOOGLE_DRIVE_EXTENSION_PUBLIC_KEY,
    } : {};
    const firefoxManifest = env.browser === 'firefox' ? {
        browser_specific_settings: {
            gecko: {
                id: '{3096bd53-3bda-4556-b076-ebf47442a5c1}',
                // data_collection_permissions requires Firefox 140 or later.
                strict_min_version: '140.0',
                // Firefox taxonomy counts any transmission outside the add-on/browser.
                // FluentRead sends page/image/subtitle text, user-supplied provider credentials,
                // and may translate text/chat/social content through the selected provider.
                data_collection_permissions: {
                    required: ['websiteContent', 'authenticationInfo', 'personalCommunications'],
                },
            },
        },
    } : {};
    return {
        permissions: [
            'storage',
            'unlimitedStorage',
            'alarms',
            'contextMenus',
            ...(['chrome', 'edge', 'firefox'].includes(env.browser) ? ['identity'] : []),
            ...(capabilities.offscreenDocument ? ['offscreen'] : []),
        ],
        content_security_policy: {
            // 扩展页面只执行自身静态脚本和 WASM；本地 TTS Worker 通过打包的
            // 静态 MJS 与随包原始 CPU/WebGPU WASM（Edge 商店拒绝嵌套压缩文件），不放宽到 blob 脚本。
            extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
        },
        host_permissions: [
            '<all_urls>',
            'https://translate.google.com/*',
            'https://translate.google.co.uk/*',
            'https://translate.googleapis.com/*',
            'https://dev.microsofttranslator.com/*',
            'https://*.tts.speech.microsoft.com/*',
            'https://deeplx.1stg.me/*',
            'https://freeapi.fanyimao.cn/*',
            'https://api.deeplx.org/*',
            'http://localhost/*',
            'http://127.0.0.1/*',
            'http://*/*',
            'https://*/*',
        ],
        web_accessible_resources: [
            {
                // 界面语言资源包由内容脚本按需 fetch；use_dynamic_url 避免网页用固定地址探测扩展。
                // 不要把需要 import() 执行的脚本放进这里：动态 ID 地址不满足内容脚本隔离环境的 script-src 'self'。
                resources: ['icon/32.png', 'icon/48.png', 'icon/128.png', `${UI_LANGUAGE_BUNDLE_DIRECTORY}/*.json`],
                matches: ['<all_urls>'],
                use_dynamic_url: true,
            },
        ],
        ...firefoxManifest,
        ...googleDriveManifest,
    } as UserManifest;
}


// WXT 配置参考：https://wxt.dev/api/config.html
export default defineConfig({
    modules: ['@wxt-dev/webextension-polyfill'],
    // Firefox 的开发 runner 使用一次性 profile；预置启动参数，避免每轮 UI
    // 回归都被 about:welcome 首次启动引导遮挡。仅影响 pnpm dev:firefox，
    // 不会写入用户 Firefox profile，也不会进入扩展发布产物。
    webExt: {
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
        addons: {
            vueTemplate: true,
        },
    },
    vite: (env) => {
        const isProductionBuild = env.command === 'build' && env.mode === 'production';
        return {
            plugins: [vue(), wllamaExtensionWorker(), escapeExtensionNoncharacters()],
            define: {
                'process.env.VUE_APP_VERSION': JSON.stringify(packageJson.version),
            },
            // 源码层脱敏是主要控制；生产构建再移除诊断输出，作为未来新增日志的纵深防护。
            esbuild: isProductionBuild ? {drop: ['console', 'debugger']} : undefined,
        };
    },
    manifest: createExtensionManifest,
    zip: {
        name: 'fluent-read',
        // 默认等级 9 的压缩耗时明显更长；6 保留标准 DEFLATE 和全部文件，平衡打包速度与体积。
        compressionLevel: 6,
        // 仅排除本地测试产物；Firefox 同样需要可复现的 OCR worker/core 资产。
        excludeSources: ['coverage/**'],
    },
    hooks: {
        'entrypoints:grouped': (wxt, groups) => {
            if (wxt.config.command === 'build') groupModuleWorkers(groups);
        },
        'vite:build:extendConfig': (entrypoints, viteConfig) => extendRemoteConfigBuildConfig(entrypoints, viteConfig as {plugins?: unknown[]}),
        'build:publicAssets': (_wxt, files) => {
            // 非中文界面文案只生成一份 JSON，由各运行上下文按当前语言加载，不再内联进每个 bundle。
            files.push(...createUiLanguageBundleFiles());
            files.push({absoluteSrc: resolve(__dirname, 'node_modules/@wllama/wllama/LICENCE'), relativeDest: 'third-party-notices/wllama-MIT.txt'});
            files.push({absoluteSrc: resolve(__dirname, 'node_modules/@noble/hashes/LICENSE'), relativeDest: 'third-party-notices/noble-hashes-MIT.txt'});
            files.push({absoluteSrc: resolve(__dirname, 'node_modules/@wllama/wllama/esm/wasm/wllama.wasm'), relativeDest: 'fluent-read-ai/wllama.wasm'});
            const opusOrtDist = resolvePnpmDependencyDist('node_modules/@huggingface/transformers', 'onnxruntime-web');
            files.push({absoluteSrc: packageWasmDiagnostics(__dirname, resolve(opusOrtDist, 'ort-wasm-simd-threaded.jsep.mjs'), 'ort-wasm-simd-threaded.jsep.mjs', 'onnx'), relativeDest: 'fluent-read-ai/ort-wasm-simd-threaded.jsep.mjs'});
            files.push({absoluteSrc: resolve(opusOrtDist, 'ort-wasm-simd-threaded.jsep.wasm'), relativeDest: 'fluent-read-ai/ort-wasm-simd-threaded.jsep.wasm'});
            const ttsOrtDist = resolvePnpmDependencyDist('node_modules/@huggingface/transformers-kokoro', 'onnxruntime-web');
            files.push({absoluteSrc: packageWasmDiagnostics(__dirname, resolve(ttsOrtDist, 'ort-wasm-simd-threaded.asyncify.mjs'), 'tts-ort-wasm-simd-threaded.asyncify.mjs', 'onnx'), relativeDest: 'fluent-read-ai/tts-ort-wasm-simd-threaded.asyncify.mjs'});
            files.push({absoluteSrc: resolve(ttsOrtDist, 'ort-wasm-simd-threaded.asyncify.wasm'), relativeDest: 'fluent-read-ai/tts-ort-wasm-simd-threaded.asyncify.wasm'});
            const ocrCore = files.find(file => file.relativeDest === 'fluent-read-ocr/core/tesseract-core-simd-lstm.wasm.js');
            if (!ocrCore || !('absoluteSrc' in ocrCore)) throw new Error('Missing packaged OCR core');
            const packagedOcr = packageTesseractWasm(__dirname, ocrCore.absoluteSrc);
            ocrCore.absoluteSrc = packagedOcr.glue;
            files.push({absoluteSrc: packagedOcr.wasm, relativeDest: 'fluent-read-ocr/core/tesseract-core-simd-lstm.wasm'});
        },
    },

});
