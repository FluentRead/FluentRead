/**
 * @file scripts/testing/wxt-manifest-helpers.ts
 * 文件职责：封装 WXT 扩展构建中的浏览器目标能力、Safari 后台页、稳定内容 UI 资源与平台清单片段生成逻辑。
 * 主要内容：
 * - 提供 `resolveOnnxWasmVariant` 按目标浏览器区分 JSPI/Asyncify WASM 变体；
 * - 提供 Safari MV2 显式 UTF-8 后台页生成与清单改写函数；
 * - 提供 Chromium 公开内容 UI 稳定资源 URL 拆分逻辑；
 * - 提供 Google Drive、Firefox AMO、Safari 平台清单片段与公共主机权限/可访问资源表。
 * 模块边界：纯构建期清单与目标规则辅助模块，不读取本地磁盘产物、不修改运行时代码。
 */
import type {ConfigEnv, UserManifest} from 'wxt';
import {FREE_PROVIDER_ORIGINS} from '../../src/core/config/freeProviderOrigins';
import {UI_LANGUAGE_BUNDLE_DIRECTORY} from '../../src/core/i18n/language';
import {
    GOOGLE_DRIVE_DEFAULT_CLIENT_ID,
    GOOGLE_DRIVE_EXTENSION_PUBLIC_KEY,
    GOOGLE_DRIVE_SCOPES,
} from '../../src/platform/google-drive/constants';

export const EXTENSION_HOST_PERMISSIONS: readonly string[] = [
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
];

/**
 * 按目标浏览器选择本地 ONNX WASM 变体：
 * - Chrome / Edge（已通过 minimum_chrome_version 137 锁定 JSPI）：使用体积更小且无栈改写开销的 JSPI 变体；
 * - Firefox（strict_min_version 140.0，JSPI 直到 Firefox 153 才默认开启，且 Thunderbird 复用 Firefox 产物）与 Safari：使用兼容更广的 Asyncify 变体。
 */
export function resolveOnnxWasmVariant(browser: string): 'jspi' | 'asyncify' {
    return browser === 'chrome' || browser === 'edge' ? 'jspi' : 'asyncify';
}

/** 生成 Chromium（Chrome / Edge）最低版本要求，与打包的 ONNX JSPI WASM 变体对齐（Chrome/Edge 137+）。 */
export function createChromiumManifest(env: Pick<ConfigEnv, 'browser'>): Partial<UserManifest> {
    if (env.browser !== 'chrome' && env.browser !== 'edge') return {};
    return {minimum_chrome_version: '137'} as Partial<UserManifest>;
}

/** Safari 的自动 MV2 后台页没有编码声明；显式页面在任何宿主语言下均按 UTF-8 加载原后台脚本。 */
export function createSafariBackgroundPage(
    env: Pick<ConfigEnv, 'browser' | 'manifestVersion'>,
): {relativeDest: string; contents: string}[] {
    if (env.browser !== 'safari' || env.manifestVersion !== 2) return [];
    return [{
        relativeDest: 'safari-background.html',
        contents: '<!doctype html>\n<html>\n<head><meta charset="utf-8"></head>\n<body><script src="./background.js"></script></body>\n</html>\n',
    }];
}

/** WXT 先由入口生成 scripts，再调用 manifestGenerated；在此保留非持久生命周期并替换页面。 */
export function configureSafariBackgroundPage(
    env: Pick<ConfigEnv, 'browser' | 'manifestVersion'>,
    manifest: {background?: {scripts?: string[]; persistent?: boolean; page?: string; service_worker?: string}},
): void {
    if (env.browser !== 'safari' || env.manifestVersion !== 2) return;
    const background = manifest.background;
    if (background?.persistent !== false || background.scripts?.length !== 1 || background.scripts[0] !== 'background.js'
        || background.page !== undefined || background.service_worker !== undefined) {
        throw new Error('Safari 后台入口已变化，无法安全生成显式 UTF-8 页面');
    }
    manifest.background = {persistent: false, page: 'safari-background.html'};
}

/**
 * Chromium 重载扩展会更换动态资源 UUID，旧页面保存的 CSS/图标地址因此失效。
 * WXT 在生成清单时才追加 Shadow UI CSS，故在 manifestGenerated 阶段
 * 仅将这几项已公开的界面资源改为稳定地址；语言包和其他资源继续保持原规则。
 * edX 学习面板的共用 frame 样式只在对应课程源公开；稳定地址的公开 UI 资产可被网页按固定 ID 探测。
 */
export function configureStableContentUiResources(
    env: Pick<ConfigEnv, 'browser' | 'manifestVersion'>,
    manifest: Pick<UserManifest, 'web_accessible_resources'>,
): void {
    if (env.manifestVersion !== 3 || !['chrome', 'edge'].includes(env.browser)) return;
    const rules = manifest.web_accessible_resources;
    if (!rules || rules.some(rule => typeof rule === 'string')) return;
    const stableResources = new Set([
        'icon/32.png', 'icon/48.png', 'icon/128.png',
        'content-scripts/content.css',
        'content-scripts/neteaseMailFrame.css',
    ]);
    const courseStylesheet = 'content-scripts/supportedFrame.css';
    const courseOrigin = 'https://courses.edx.org/*';
    manifest.web_accessible_resources = rules.flatMap(rule => {
        if (typeof rule === 'string') return [];
        const stable = rule.resources.filter(resource => stableResources.has(resource));
        const course = rule.resources.includes(courseStylesheet);
        if (stable.length === 0 && !course) return [rule];
        const remaining = rule.resources.filter(resource => resource !== courseStylesheet && !stableResources.has(resource));
        return [
            ...(stable.length ? [{...rule, resources: stable, use_dynamic_url: false}] : []),
            ...(course && rule.matches?.includes(courseOrigin)
                ? [{...rule, resources: [courseStylesheet], matches: [courseOrigin], use_dynamic_url: false}] : []),
            ...(remaining.length ? [{...rule, resources: remaining}] : []),
        ];
    });
}

/** 生成 Chrome 专属的 Google Drive OAuth 与固定扩展 ID 公钥字段。 */
export function createGoogleDriveManifest(
    env: Pick<ConfigEnv, 'browser'>,
    processEnv: NodeJS.ProcessEnv = process.env,
): Partial<UserManifest> {
    if (env.browser !== 'chrome') return {};
    // manifest 回调在 WXT 加载 .env 后执行；公开 Client ID 可随扩展发布。
    return {
        oauth2: {
            client_id: processEnv.WXT_GOOGLE_CLIENT_ID?.trim() || GOOGLE_DRIVE_DEFAULT_CLIENT_ID,
            scopes: [...GOOGLE_DRIVE_SCOPES],
        },
        key: processEnv.WXT_EXTENSION_KEY?.trim() || GOOGLE_DRIVE_EXTENSION_PUBLIC_KEY,
    } as Partial<UserManifest>;
}

/** 生成 Firefox AMO 固定 ID、最低版本与数据收集分类字段。 */
export function createFirefoxManifest(env: Pick<ConfigEnv, 'browser'>): Partial<UserManifest> {
    if (env.browser !== 'firefox') return {};
    return {
        // 大型材料备份需要在用户主动导出时观察下载终态；安装时不请求此权限。
        optional_permissions: ['downloads'],
        browser_specific_settings: {
            gecko: {
                id: '{3096bd53-3bda-4556-b076-ebf47442a5c1}',
                // 桌面内置同意机制从 Firefox 140 起支持，保留 ESR 140。
                // Android 从 142 起支持；未经实机验收不通过 gecko_android 声明 Android 支持。
                // 因而 AMO 可能提示 Android 最低版本告警，提交说明中应解释这一兼容范围。
                strict_min_version: '140.0',
                // Firefox taxonomy counts any transmission outside the add-on/browser.
                // FluentRead sends page/image/subtitle text, user-supplied provider credentials,
                // and may translate text/chat/social content through the selected provider.
                data_collection_permissions: {
                    required: ['websiteContent', 'authenticationInfo', 'personalCommunications'],
                },
            },
        },
    } as Partial<UserManifest>;
}

/** 生成 Safari 最低版本与 MV2 服务域可选权限字段。 */
export function createSafariManifest(env: Pick<ConfigEnv, 'browser' | 'manifestVersion'>): Partial<UserManifest> {
    if (env.browser !== 'safari') return {};
    // Safari 26 起支持现有 DNR initiatorDomains/requestMethods 隔离条件；iOS 与 Safari 版本号一致。
    // 更早系统不应安装后才发现请求头适配不可用，最低版本同时写入可检查的清单。
    return {
        browser_specific_settings: {safari: {strict_min_version: '26.0'}},
        // iOS 26.2 单变量验收中，只有显式 optional_permissions 才实际弹出服务域授权。
        // 这是 MV2 字段；required 网页访问保持原样，授权入口每次仅请求一个服务的精确域。
        ...(env.manifestVersion === 2 ? {optional_permissions: Object.values(FREE_PROVIDER_ORIGINS).flat()} : {}),
    } as Partial<UserManifest>;
}

/** 生成各目标浏览器的基础 web_accessible_resources 规则。 */
export function createExtensionWebAccessibleResources(
    env: Pick<ConfigEnv, 'browser'>,
): UserManifest['web_accessible_resources'] {
    return [
        {
            resources: ['videoPcmWorklet.js'],
            matches: ['<all_urls>'],
        },
        {
            // 页内快捷面板只暴露 HTML；任何 iframe 都须先兑换内容脚本持有的一次性凭据，才可加载界面和配置。
            resources: ['popup.html'],
            matches: ['<all_urls>'],
        },
        {
            // 语言包保持动态 URL；Chromium 的公开 UI 图标在清单生成后与语言包拆分为稳定地址。
            // 不要把需要 import() 执行的脚本放进这里：动态 ID 地址不满足内容脚本隔离环境的 script-src 'self'。
            resources: ['icon/32.png', 'icon/48.png', 'icon/128.png', `${UI_LANGUAGE_BUNDLE_DIRECTORY}/*.json`],
            matches: ['<all_urls>'],
            ...(env.browser === 'safari' ? {} : {use_dynamic_url: true}),
        },
        {
            // 内容脚本隔离世界通过原生 import() 加载共享 ESM 运行时与按需分块；
            // 必须保持稳定地址（不得设 use_dynamic_url: true），否则动态 UUID 违反内容脚本 script-src 'self'。
            // 仅限定 content-scripts/chunks/*.js，不暴露扩展页面（popup/options/offscreen/sidepanel）的 chunks/*.js。
            resources: ['content-scripts/chunks/*.js'],
            matches: ['<all_urls>'],
        },
    ];
}
