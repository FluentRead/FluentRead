import {defineConfig, type ConfigEnv, type UserManifest} from 'wxt';
import vue from '@vitejs/plugin-vue';
import {resolve} from 'path';
import fs from 'fs';
import {resolveBrowserCapabilities} from './src/platform/browser/capabilities';


const packageJson = JSON.parse(fs.readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
const firefoxRunnerBinary = process.env.FLUENTREAD_FIREFOX_RUNNER_BINARY;
const firefoxRunnerProfile = process.env.FLUENTREAD_FIREFOX_RUNNER_PROFILE;
const firefoxRunnerStartUrl = process.env.FLUENTREAD_FIREFOX_RUNNER_START_URL;

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

/** 根据编译目标能力生成权限，避免 Firefox/MV2 产物声明不可用的 Offscreen API。 */
export function createExtensionManifest(
    env: Pick<ConfigEnv, 'browser' | 'manifestVersion'>,
): UserManifest {
    const capabilities = resolveBrowserCapabilities(env);
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
            ...(capabilities.offscreenDocument ? ['offscreen'] : []),
        ],
        content_security_policy: {
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
                resources: ['icon/32.png', 'icon/48.png', 'icon/128.png'],
                matches: ['<all_urls>'],
                use_dynamic_url: true,
            },
        ],
        ...firefoxManifest,
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
            plugins: [vue(), escapeExtensionNoncharacters()],
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
        // 仅排除本地测试产物；Firefox 同样需要可复现的 OCR worker/core 资产。
        excludeSources: ['coverage/**'],
    },
    hooks: {
        'build:publicAssets': (_wxt, files) => {
            for (const name of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
                files.push({absoluteSrc: resolve(__dirname, `node_modules/@huggingface/transformers/dist/${name}`), relativeDest: `fluent-read-ai/${name}`});
            }
        },
    },

});
