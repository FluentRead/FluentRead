import {sharedOnnxBuildPlugin, sharedOnnxDist} from './scripts/wasm/manga-onnx-build';
import {defineConfig, type ConfigEnv, type UserManifest, type Entrypoint, type EntrypointGroup} from 'wxt';
import vue from '@vitejs/plugin-vue';
import {resolve} from 'path';
import fs from 'fs';
import {randomUUID} from 'node:crypto';
import JSZip from 'jszip';
import {resolveBrowserCapabilities} from './src/platform/browser/capabilities';
import {checkExtensionSize} from './scripts/testing/extension-size-budget';
import {wllamaExtensionWorker} from './scripts/testing/wllama-extension-build';
import {createExtensionNameLocaleFiles, createUiLanguageBundleFiles} from './src/core/i18n/bundles';
import {UI_LANGUAGE_BUNDLE_DIRECTORY} from './src/core/i18n/language';
import {packageWasmDiagnostics, packageTesseractWasm, packageTesseractWorker} from './scripts/wasm/package-diagnostics';
import {tesseractSdkBuildPlugin} from './scripts/wasm/tesseract-sdk-build';
import {GOOGLE_DRIVE_DEFAULT_CLIENT_ID, GOOGLE_DRIVE_EXTENSION_PUBLIC_KEY, GOOGLE_DRIVE_SCOPES} from './src/platform/google-drive/constants';


const packageJson = JSON.parse(fs.readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
const firefoxRunnerBinary = process.env.FLUENTREAD_FIREFOX_RUNNER_BINARY;
const firefoxRunnerProfile = process.env.FLUENTREAD_FIREFOX_RUNNER_PROFILE;
const firefoxRunnerStartUrl = process.env.FLUENTREAD_FIREFOX_RUNNER_START_URL;

/** 仅商店 ZIP 移除开发用固定 ID；保留本地构建的 key、OAuth 和全部运行文件。 */
export async function prepareExtensionStoreZip(browser: string, zipPath: string): Promise<void> {
    if (browser !== 'chrome') return;
    const archive = await JSZip.loadAsync(fs.readFileSync(zipPath), {checkCRC32: true});
    const entry = archive.file('manifest.json');
    if (!entry) throw new Error('Chrome 商店包缺少 manifest.json');
    const manifest = JSON.parse(await entry.async('string'));
    if (!Object.hasOwn(manifest, 'key')) return;
    delete manifest.key;
    archive.file('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`, {date: entry.date});
    const data = await archive.generateAsync({
        type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: {level: 6},
    });
    const temporary = `${zipPath}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, data, {flag: 'wx'});
        fs.renameSync(temporary, zipPath);
    } finally {
        fs.rmSync(temporary, {force: true});
    }
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

/** 这些入口都由 new Worker(..., {type: 'module'}) 启动，可共享一次 ESM 构建及依赖 chunk。 */
export function groupModuleWorkers(groups: EntrypointGroup[]): void {
    const moduleWorkers = new Set(['localTranslationWorker', 'localTtsWorker', 'videoTranscriptionWorker', 'mangaInferenceWorker', 'informationHighlightWorker']);
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
    // Safari 16.4 起支持 MV3 与模块化 service worker；17 起 offscreen 依赖的后台标签页行为稳定。
    const safariManifest = env.browser === 'safari' ? {
        browser_specific_settings: {safari: {strict_min_version: '17.0'}},
        // Safari 设置里的扩展列表图标由系统直接渲染清单图标，不支持按外观切换，
        // 因此 Safari 产物固定使用深色版（近黑底 + 品牌粉字形），与深色系统一致。
        icons: {
            16: 'icon/appearance/dark-16.png',
            32: 'icon/appearance/dark-32.png',
            48: 'icon/appearance/dark-48.png',
            64: 'icon/appearance/dark-64.png',
            128: 'icon/appearance/dark-128.png',
        },
        // Safari 按模板渲染工具栏按钮，只取图形的轮廓；提供带底色的应用图标会被压成灰底方块，
        // 因此单独给一套透明底的模板图标，让工具栏只显示 A/中 字形。
        action: {
            default_icon: {
                16: 'icon/action/16.png',
                19: 'icon/action/19.png',
                32: 'icon/action/32.png',
                38: 'icon/action/38.png',
            },
        },
    } : {};
    // Safari 的扩展页面使用系统默认 CSP；自定义 extension_pages 只对 Chromium/Firefox 有意义。
    const contentSecurityPolicy = env.browser === 'safari' ? undefined : {
        // 扩展页面只执行自身静态脚本和 WASM；本地 TTS Worker 通过打包的
        // 静态 MJS 与随包原始 CPU/WebGPU WASM（Edge 商店拒绝嵌套压缩文件），不放宽到 blob 脚本。
        extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    };
    return {
        name: '__MSG_extensionName__',
        default_locale: 'en',
        permissions: [
            'storage',
            'unlimitedStorage',
            'alarms',
            'contextMenus',
            'declarativeNetRequestWithHostAccess',
            ...(env.browser === 'chrome' ? ['identity'] : []),
            ...(capabilities.offscreenDocument ? ['offscreen'] : []),
        ],
        ...(contentSecurityPolicy ? {content_security_policy: contentSecurityPolicy} : {}),
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
                // 页内快捷面板只暴露 HTML；任何 iframe 都须先兑换内容脚本持有的一次性凭据，才可加载界面和配置。
                resources: ['popup.html'],
                matches: ['<all_urls>'],
            },
            {
                // 界面语言资源包由内容脚本按需 fetch；use_dynamic_url 避免网页用固定地址探测扩展。
                // 不要把需要 import() 执行的脚本放进这里：动态 ID 地址不满足内容脚本隔离环境的 script-src 'self'。
                resources: ['icon/32.png', 'icon/48.png', 'icon/128.png', `${UI_LANGUAGE_BUNDLE_DIRECTORY}/*.json`],
                matches: ['<all_urls>'],
                // Safari 与 Firefox 没有动态 URL 机制，声明后会被忽略，这里只为支持的浏览器保留。
                ...(env.browser === 'chrome' || env.browser === 'edge' ? {use_dynamic_url: true} : {}),
            },
        ],
        ...firefoxManifest,
        ...safariManifest,
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
        addons: {
            vueTemplate: true,
        },
    },
    vite: (env) => {
        const isProductionBuild = env.command === 'build' && env.mode === 'production';
        return {
            plugins: [vue(), sharedOnnxBuildPlugin(), wllamaExtensionWorker(), tesseractSdkBuildPlugin(), escapeExtensionNoncharacters()],
            // WXT 默认在每个开发脚本中内联源码与 sourcemap；需要源码调试时显式开启。
            build: env.command === 'serve' ? {sourcemap: process.env.FLUENTREAD_DEV_SOURCEMAPS === '1' ? 'inline' : false} : undefined,
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
        // AMO 源码包保留扩展源码、锁文件、构建脚本及字体/OCR 资产，
        // 排除网站素材、测试证据和其他发布出口，避免超过 200 MB 上传限制。
        excludeSources: [
            'coverage/**',
            'docs/**',
            'marketing/**',
            'userscript/**',
            'storybook/**',
            'integrations/**',
            'examples/**',
            'scripts/testing/evidence/**',
        ],
        // 保留源码中的第三方来源说明；includeSources 会覆盖上述排除规则。
        includeSources: ['docs/development/service-icons.md', 'docs/guide/deepseek-harness.md'],
    },
    hooks: {
        'zip:extension:done': async (wxt, zipPath) => {
            await prepareExtensionStoreZip(wxt.config.browser, zipPath);
        },
        'build:done': async (wxt) => {
            const dev = wxt.config.command === 'serve';
            // PDF 字体首次导出时下载并缓存，不进入安装包；fontkit 仍使用包内静态代码。
            // 恢复字体加入前的生产体积预算，防止完整字体再次随 public/ 打包。
            const budget = dev ? (process.env.FLUENTREAD_DEV_SOURCEMAPS === '1' ? 170_000_000 : 70_000_000) : 65_000_000;
            await checkExtensionSize(wxt.config.outDir, budget);
        },
        'entrypoints:grouped': (_wxt, groups) => {
            groupModuleWorkers(groups);
        },
        'vite:build:extendConfig': (entrypoints, viteConfig) => {
            extendRemoteConfigBuildConfig(entrypoints, viteConfig as {plugins?: unknown[]});
            // Vite 的动态导入预加载帮助器访问 document；模块 Worker 只能使用原生 import。
            if (entrypoints.every(entrypoint => entrypoint.type === 'unlisted-script')) {
                viteConfig.build = {...viteConfig.build, modulePreload: false};
            }
        },
        'build:publicAssets': (_wxt, files) => {
            // 非中文界面文案只生成一份 JSON，由各运行上下文按当前语言加载，不再内联进每个 bundle。
            files.push(...createUiLanguageBundleFiles());
            // 安装名称由浏览器原生 locale 解析，复用七语品牌，不复制完整界面目录。
            files.push(...createExtensionNameLocaleFiles());
            files.push({absoluteSrc: resolve(__dirname, 'node_modules/@wllama/wllama/LICENCE'), relativeDest: 'third-party-notices/wllama-MIT.txt'});
            files.push({absoluteSrc: resolve(__dirname, 'node_modules/@noble/hashes/LICENSE'), relativeDest: 'third-party-notices/noble-hashes-MIT.txt'});
            files.push({absoluteSrc: resolve(__dirname, 'node_modules/ppu-paddle-ocr/LICENSE'), relativeDest: 'third-party-notices/ppu-paddle-ocr-MIT.txt'});
            files.push({absoluteSrc: resolve(fs.realpathSync(resolve(__dirname, 'node_modules/ppu-paddle-ocr')), '../ppu-ocv/LICENSE'), relativeDest: 'third-party-notices/ppu-ocv-MIT.txt'});
            // JS 和 WASM 来自同一锁定版本；模型数据继续按需下载，执行代码只用包内资源。
            const ortDist = sharedOnnxDist();
            files.push({absoluteSrc: packageWasmDiagnostics(__dirname, resolve(ortDist, 'ort-wasm-simd-threaded.asyncify.mjs'), 'ort-wasm-simd-threaded.asyncify.mjs', 'onnx'), relativeDest: 'fluent-read-ai/ort-wasm-simd-threaded.asyncify.mjs'});
            files.push({absoluteSrc: resolve(ortDist, 'ort-wasm-simd-threaded.asyncify.wasm'), relativeDest: 'fluent-read-ai/ort-wasm-simd-threaded.asyncify.wasm'});
            files.push({absoluteSrc: resolve(__dirname, 'node_modules/@wllama/wllama/esm/wasm/wllama.wasm'), relativeDest: 'fluent-read-ai/wllama.wasm'});
            const ocrCore = files.find(file => file.relativeDest === 'fluent-read-ocr/core/tesseract-core-simd-lstm.wasm.js');
            if (!ocrCore || !('absoluteSrc' in ocrCore)) throw new Error('Missing packaged OCR core');
            const packagedOcr = packageTesseractWasm(__dirname, ocrCore.absoluteSrc);
            ocrCore.absoluteSrc = packagedOcr.glue;
            files.push({absoluteSrc: packagedOcr.wasm, relativeDest: 'fluent-read-ocr/core/tesseract-core-simd-lstm.wasm'});
            const ocrWorker = files.find(file => file.relativeDest === 'fluent-read-ocr/worker/worker.min.js');
            if (!ocrWorker || !('absoluteSrc' in ocrWorker)) throw new Error('Missing packaged OCR worker');
            ocrWorker.absoluteSrc = packageTesseractWorker(__dirname, ocrWorker.absoluteSrc);
            files.push({absoluteSrc: resolve(__dirname, 'node_modules/tesseract.js/dist/worker.min.js.LICENSE.txt'), relativeDest: 'fluent-read-ocr/worker/worker.min.js.LICENSE.txt'});
            files.push({absoluteSrc: resolve(__dirname, 'node_modules/tesseract.js/LICENSE.md'), relativeDest: 'fluent-read-ocr/LICENSE.md'});
        },
    },

});
