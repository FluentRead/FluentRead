/**
 * @file scripts/testing/wxt-vite-helpers.ts
 * 文件职责：封装 WXT 各入口组的 Vite/Rolldown 构建插件注入、按组插件裁剪、原生 transform 过滤与分块策略。
 * 主要内容：
 * - 提供非后台远程配置存储、未使用 @ai-sdk/gateway 桩、受限子 frame 正文提取/站点规则替代及按入口裁剪中文目录插件；
 * - 提供按入口组裁剪无关 Vite 插件与挂接 Rolldown 原生 transform 过滤器的优化钩子；
 * - 提供模块 Worker 分组与扩展 UI 页面共享 chunk 拆分函数。
 * 模块边界：纯构建期 Vite/Rolldown 配置变换函数，不涉及浏览器清单、归档压缩或运行时状态。
 */
import fs from 'node:fs';
import {basename, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Entrypoint, EntrypointGroup} from 'wxt';
import type {InlineConfig} from 'vite';
import {scopedChineseCatalogBuildPlugin} from '../i18n/scopedChineseCatalogPlugin';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const SUBFRAME_CONTENT_SCRIPT_NAMES = new Set(['youtubeEmbed', 'videoSubtitleFrame', 'supportedFrame', 'neteaseMailFrame']);
export const SHARED_CONTENT_SCRIPT_NAMES: ReadonlySet<string> = new Set([
    'content',
    'supportedFrame',
    'neteaseMailFrame',
    'videoSubtitleFrame',
]);
const SHADOW_UI_CONTENT_SCRIPT_NAMES = new Set(['content', 'neteaseMailFrame']);
const VIRTUAL_ISOLATED_CS_PREFIX = '\0virtual:wxt-content-script-isolated-world-entrypoint?';
const WXT_SHADOW_ROOT_MODULE = /[\\/]wxt[\\/]dist[\\/]utils[\\/]content-script-ui[\\/]shadow-root\.mjs$/u;
const SUBFRAME_CATALOG_HOSTS: Readonly<Record<string, readonly string[]>> = {
    neteaseMailFrame: ['mail.163.com', 'mail.126.com', 'mail.yeah.net'],
    supportedFrame: ['hf.space', 'disqus.com', 'www.kaggleusercontent.com', 'mail.qq.com', 'courses.edx.org'],
};
const BRIDGE_OR_WORKLET_NAMES = new Set([
    'bilibiliCaptionBridge',
    'shadowBridge',
    'xVideoBridge',
    'youtubeBridge',
    'youtubeEmbedBridge',
    'videoPcmWorklet',
]);

function isAllBridgesOrWorklet(entrypoints: readonly {name?: string}[]): boolean {
    return entrypoints.length > 0 && entrypoints.every((entrypoint) =>
        typeof entrypoint.name === 'string' && BRIDGE_OR_WORKLET_NAMES.has(entrypoint.name));
}

const NON_CONTENT_SCRIPT_PLUGIN_NAMES = new Set([
    'fluentread-shared-onnx',
    'fluentread-kokoro-transformers',
    'fluentread-kokoro-phonemizer',
    'fluentread-fontkit-slim',
    'fluentread-ai-sdk-gateway-stub',
    'wllama-static-extension-worker',
    'fluent-read-tesseract-sdk-initialization',
    'fluentread-pinned-pdfjs-bidi',
    'fluentread-dictionary-script-runtime',
    'fluentread-deeplx-runtime-fetch',
]);

type RolldownTransformFilter = {
    id?: RegExp | {include?: RegExp[]; exclude?: RegExp[]};
    code?: RegExp;
};

const ROLLDOWN_TRANSFORM_FILTERS: Readonly<Record<string, RolldownTransformFilter>> = {
    unimport: {
        id: {
            include: [/\.[jt]sx?$/, /\.vue(?:\?vue.*)?$/],
            exclude: [/[\\/]node_modules[\\/]/, /[\\/]\.git[\\/]/, /[\\/]src[\\/](?:core|shared)[\\/]/],
        },
        code: /\b(?:ContentScriptContext|InvalidMatchPattern|MatchPattern|browser|createIframeUi|createIntegratedUi|createShadowRootUi|defineAppConfig|defineBackground|defineContentScript|defineUnlistedScript|defineWxtPlugin|fakeBrowser|getAppConfig|injectScript|storage|useAppConfig)\b/,
    },
    'fluentread-extension-csp-vendor': {
        id: /(?:^|[\\/])(?:regenerator-runtime[\\/]runtime\.js|jszip[\\/]dist[\\/]jszip\.min\.js|pdfjs-dist[\\/]legacy[\\/]build[\\/]pdf\.mjs|@pdf-lib[\\/]fontkit[\\/]dist[\\/]fontkit\.es\.js|lodash-es[\\/]_root\.js|zod[\\/]v4[\\/]core[\\/]schemas\.js)$/,
    },
    'fluentread-fontkit-slim': {id: /(?:^|[\\/])@pdf-lib[\\/]fontkit[\\/]dist[\\/]fontkit\.es\.js$/},
    'fluentread-defuddle-entity-decoder': {id: /(?:^|[\\/])defuddle[\\/]dist[\\/]index\.js$/},
    'fluentread-deferred-franc-models': {id: /(?:^|[\\/])franc-min[\\/]index\.js$/},
    'wllama-static-extension-worker': {id: /@wllama[\\/]wllama[\\/]esm[\\/]index\.js$/},
    'fluent-read-tesseract-sdk-initialization': {id: /tesseract\.js[\\/]src[\\/]createWorker\.js(?:\?.*)?$/},
};

/**
 * Vercel AI SDK（ai@7）无条件静态导入 @ai-sdk/gateway 以支持字符串模型 ID 路由，
 * 而 FluentRead 始终传入显式 LanguageModel 实例，永不走 Vercel AI Gateway；
 * 在后台等非内容脚本构建中以极简显式抛错桩替代之，避免将 76 KB+ 网关逻辑与 schema 打入 background.js。
 */
export function aiSdkGatewayStubBuildPlugin() {
    const virtualId = '\0fluentread-ai-sdk-gateway-stub';
    const aiSdkImporter = /[\\/]node_modules[\\/]ai[\\/]/u;
    return {
        name: 'fluentread-ai-sdk-gateway-stub',
        enforce: 'pre' as const,
        resolveId(source: string, importer?: string) {
            if (source === '@ai-sdk/gateway' && importer && aiSdkImporter.test(importer)) {
                return virtualId;
            }
            return null;
        },
        load(id: string) {
            if (id !== virtualId) return null;
            return [
                'export class GatewayError extends Error { static isInstance() { return false; } }',
                'export class GatewayAuthenticationError extends GatewayError { static isInstance() { return false; } }',
                'const unsupported = () => { throw new Error("FluentRead does not use @ai-sdk/gateway; pass an explicit LanguageModel instance."); };',
                'export const createGateway = unsupported;',
                'export const gateway = Object.assign(unsupported, {',
                '    specificationVersion: "v4",',
                '    languageModel: unsupported,',
                '    embeddingModel: unsupported,',
                '    textEmbeddingModel: unsupported,',
                '    imageModel: unsupported,',
                '    transcriptionModel: unsupported,',
                '    speechModel: unsupported,',
                '    rerankingModel: unsupported,',
                '    videoModel: unsupported,',
                '    speechTranslationModel: unsupported,',
                '});',
            ].join('\n');
        },
    };
}

/** 内容脚本和扩展 UI 永远通过 runtime 代理读取后台权威配置。通用配置存储运行时同时
 * 装配后台加密 IndexedDB（Dexie、加密与旧存储迁移），这些非后台入口无需解析它们；
 * 只对明确不包含后台的构建组使用纯远程实现，MV2 background page 仍保留数据库端口。
 */
export function remoteConfigStorageBuildPlugin(projectRoot = PROJECT_ROOT) {
    const runtimeModule = /\/src\/platform\/storage\/configStorageRuntime(?:\.ts)?$/u;
    const remoteRuntime = resolve(projectRoot, 'src/platform/storage/remoteConfigStorageRuntime.ts');
    return {
        name: 'fluentread-remote-config-storage',
        enforce: 'pre' as const,
        resolveId(source: string) {
            return runtimeModule.test(source) ? remoteRuntime : null;
        },
    };
}

export function extendRemoteConfigBuildConfig(
    entrypoints: readonly {type: string; name?: string}[],
    viteConfig: {plugins?: unknown[]},
): void {
    const remoteOnlyTypes = new Set(['content-script', 'popup', 'options', 'unlisted-page', 'sidepanel']);
    if (entrypoints.length === 0
        || isAllBridgesOrWorklet(entrypoints)
        || !entrypoints.every((entrypoint) => remoteOnlyTypes.has(entrypoint.type))) return;
    viteConfig.plugins = [...(viteConfig.plugins ?? []), remoteConfigStorageBuildPlugin()];
}

/**
 * 受限子 frame 内容脚本（嵌入播放器、受限评论/文档 frame、网易邮箱正文 frame）仅需已清洗的脱离 DOM 文本作为上下文，
 * 不必各自内联 Defuddle + Turndown + MathML-to-LaTeX 正文提取器；顶层网页与扩展页仍保留完整提取器。
 */
export function subframePageContextBuildPlugin(projectRoot = PROJECT_ROOT) {
    const extractorModule = /[\\/]src[\\/]services[\\/]translation[\\/]context[\\/]readableExtractor(?:\.ts)?$/u;
    const browserContextImporter = /[\\/]src[\\/]services[\\/]translation[\\/]context[\\/]browser\.ts$/u;
    const subframeExtractor = resolve(projectRoot, 'src/services/translation/context/subframeReadableExtractor.ts');
    return {
        name: 'fluentread-subframe-page-context',
        enforce: 'pre' as const,
        resolveId(source: string, importer?: string) {
            if (extractorModule.test(source)) return subframeExtractor;
            if ((source === './readableExtractor' || source === './readableExtractor.ts')
                && importer && browserContextImporter.test(importer)) {
                return subframeExtractor;
            }
            return null;
        },
    };
}

export function extendSubframePageContextBuildConfig(
    entrypoints: readonly {type: string; name?: string}[],
    viteConfig: {plugins?: unknown[]},
): void {
    if (entrypoints.length === 0 || !entrypoints.every((entrypoint) =>
        entrypoint.type === 'content-script' && typeof entrypoint.name === 'string' && SUBFRAME_CONTENT_SCRIPT_NAMES.has(entrypoint.name))) return;
    viteConfig.plugins = [...(viteConfig.plugins ?? []), subframePageContextBuildPlugin()];
}

/**
 * 受限子 frame（youtubeEmbed、supportedFrame、neteaseMailFrame）只消费后台已规范化的域名名单，
 * 不必各自内联 261 KB 的 tldts Public Suffix 数据表；顶层网页、后台与设置页仍保留完整 tldts 实现。
 */
export function subframeSiteRulesBuildPlugin(projectRoot = PROJECT_ROOT) {
    const domainModule = /[\\/]src[\\/]core[\\/]site-rules[\\/]domain(?:\.ts)?$/u;
    const relativeDomainImporter = /[\\/]src[\\/]core[\\/]/u;
    const subframeDomain = resolve(projectRoot, 'src/core/site-rules/subframeDomain.ts');
    return {
        name: 'fluentread-subframe-site-rules',
        enforce: 'pre' as const,
        resolveId(source: string, importer?: string) {
            if (domainModule.test(source)) return subframeDomain;
            if ((source === '../site-rules/domain' || source === '../site-rules/domain.ts')
                && importer && relativeDomainImporter.test(importer)) {
                return subframeDomain;
            }
            return null;
        },
    };
}

export function extendSubframeSiteRulesBuildConfig(
    entrypoints: readonly {type: string; name?: string}[],
    viteConfig: {plugins?: unknown[]},
): void {
    if (entrypoints.length === 0 || !entrypoints.every((entrypoint) =>
        entrypoint.type === 'content-script' && typeof entrypoint.name === 'string' && SUBFRAME_CONTENT_SCRIPT_NAMES.has(entrypoint.name))) return;
    viteConfig.plugins = [...(viteConfig.plugins ?? []), subframeSiteRulesBuildPlugin()];
}

function hostPatternMatchesSubframeHost(pattern: string, host: string): boolean {
    const normalizedPattern = pattern.trim().toLowerCase();
    const normalizedHost = host.trim().toLowerCase();
    if (!normalizedPattern || normalizedPattern === '*') return true;
    const base = normalizedPattern.startsWith('*.') ? normalizedPattern.slice(2) : normalizedPattern;
    if (base.includes('*')) return true;
    return base === normalizedHost
        || base.endsWith(`.${normalizedHost}`)
        || normalizedHost.endsWith(`.${base}`);
}

/**
 * 受限子 frame（neteaseMailFrame、supportedFrame）只在固定白名单主机上运行，
 * 构建期按其允许主机静态裁剪站点适配 JSON（established、websites、profiles），避免把全量 129 KB 规则复制进每个子 frame。
 */
export function subframeSiteCatalogBuildPlugin(entrypointName: string, projectRoot = PROJECT_ROOT) {
    const allowedHosts = SUBFRAME_CATALOG_HOSTS[entrypointName];
    if (!allowedHosts) return null;
    const catalogDir = resolve(projectRoot, 'src/core/site-adaptation/catalog');
    const targetFiles = new Set(['established.json', 'websites.json', 'profiles.json'].map(name => resolve(catalogDir, name)));
    const virtualPrefix = `\0fluentread-subframe-site-catalog:${entrypointName}:`;
    let cached: {established: unknown[]; websites: unknown[]; profiles: Record<string, unknown>} | undefined;
    const loadFiltered = () => {
        if (cached) return cached;
        type RawRule = {match?: {hosts?: unknown}; profile?: unknown};
        const matchesAllowed = (rule: RawRule): boolean => {
            const hosts = rule.match?.hosts;
            if (!Array.isArray(hosts) || hosts.length === 0) return true;
            return hosts.some(pattern => typeof pattern === 'string'
                && allowedHosts.some(host => hostPatternMatchesSubframeHost(pattern, host)));
        };
        const established = (JSON.parse(fs.readFileSync(resolve(catalogDir, 'established.json'), 'utf8')) as RawRule[]).filter(matchesAllowed);
        const websites = (JSON.parse(fs.readFileSync(resolve(catalogDir, 'websites.json'), 'utf8')) as RawRule[]).filter(matchesAllowed);
        const allProfiles = JSON.parse(fs.readFileSync(resolve(catalogDir, 'profiles.json'), 'utf8')) as Record<string, unknown>;
        const usedProfiles = new Set<string>();
        for (const rule of [...established, ...websites]) {
            if (typeof rule.profile === 'string' && rule.profile in allProfiles) usedProfiles.add(rule.profile);
        }
        const profiles = Object.fromEntries([...usedProfiles].sort().map(name => [name, allProfiles[name]]));
        cached = {established, websites, profiles};
        return cached;
    };
    return {
        name: 'fluentread-subframe-site-catalog',
        enforce: 'pre' as const,
        resolveId(source: string, importer?: string) {
            if (!importer || !source.endsWith('.json')) return null;
            const resolved = resolve(importer.split('?')[0], '..', source);
            if (!targetFiles.has(resolved)) return null;
            return `${virtualPrefix}${basename(resolved, '.json')}.js`;
        },
        load(id: string) {
            if (!id.startsWith(virtualPrefix)) return null;
            const key = id.slice(virtualPrefix.length, -'.js'.length) as 'established' | 'websites' | 'profiles';
            return `export default ${JSON.stringify(loadFiltered()[key])};`;
        },
    };
}

export function extendSubframeSiteCatalogBuildConfig(
    entrypoints: readonly {type: string; name?: string}[],
    viteConfig: {plugins?: unknown[]},
): void {
    if (entrypoints.length !== 1) return;
    const [entrypoint] = entrypoints;
    if (entrypoint.type !== 'content-script' || typeof entrypoint.name !== 'string') return;
    const plugin = subframeSiteCatalogBuildPlugin(entrypoint.name);
    if (!plugin) return;
    viteConfig.plugins = [...(viteConfig.plugins ?? []), plugin];
}

/** 内容脚本与后台仅注入其产物实际可达的中文界面条目；极轻 MAIN 世界桥/AudioWorklet 跳过注入，所有扩展 UI 页面继续共享完整中文目录块。 */
export function extendScopedChineseCatalogBuildConfig(
    entrypoints: readonly {type: string; name?: string}[],
    viteConfig: {plugins?: unknown[]},
): void {
    const scopedTypes = new Set(['content-script', 'background']);
    if (entrypoints.length === 0
        || isAllBridgesOrWorklet(entrypoints)
        || !entrypoints.every((entrypoint) => scopedTypes.has(entrypoint.type))) return;
    viteConfig.plugins = [...(viteConfig.plugins ?? []), scopedChineseCatalogBuildPlugin()];
}

/** 按入口构建组裁剪不可能命中的 Vite 插件，减少 13 组串行构建中无关插件的 hook 调度开销。 */
export function pruneEntrypointVitePlugins(
    entrypoints: readonly {type: string; name?: string}[],
    viteConfig: {plugins?: unknown[]},
): void {
    if (entrypoints.length === 0 || !Array.isArray(viteConfig.plugins) || viteConfig.plugins.length === 0) return;
    const removed = new Set<string>();
    const allBridgesOrWorklet = isAllBridgesOrWorklet(entrypoints);
    const allNonUiScripts = entrypoints.every((entrypoint) =>
        entrypoint.type === 'background' || entrypoint.type === 'unlisted-script'
        || (typeof entrypoint.name === 'string' && BRIDGE_OR_WORKLET_NAMES.has(entrypoint.name)));
    const allContentScripts = entrypoints.every((entrypoint) => entrypoint.type === 'content-script');
    const allSubframeContentScripts = allContentScripts && entrypoints.every((entrypoint) =>
        typeof entrypoint.name === 'string' && SUBFRAME_CONTENT_SCRIPT_NAMES.has(entrypoint.name));
    if (allNonUiScripts) {
        removed.add('vite:vue');
        removed.add('fluentread-defuddle-entity-decoder');
    }
    if (allContentScripts || allBridgesOrWorklet) {
        for (const name of NON_CONTENT_SCRIPT_PLUGIN_NAMES) removed.add(name);
    }
    if (allSubframeContentScripts || allBridgesOrWorklet) {
        removed.add('fluentread-defuddle-entity-decoder');
    }
    if (allBridgesOrWorklet) {
        removed.add('fluentread-deferred-franc-models');
        removed.add('fluentread-extension-csp-vendor');
    }
    if (removed.size === 0) return;
    viteConfig.plugins = viteConfig.plugins.filter((plugin) => {
        if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) return true;
        const name = (plugin as {name?: unknown}).name;
        return typeof name !== 'string' || !removed.has(name);
    });
}

/** 为 legacy Rollup/unplugin transform 挂接 Rolldown 原生过滤器，在 Rust 侧跳过无关模块以减少跨边界调用。 */
export function attachRolldownTransformFilters(viteConfig: {plugins?: unknown[]}): void {
    if (!Array.isArray(viteConfig.plugins) || viteConfig.plugins.length === 0) return;
    const apply = (entry: unknown): unknown => {
        if (Array.isArray(entry)) return entry.map(apply);
        if (!entry || typeof entry !== 'object') return entry;
        const plugin = entry as {name?: unknown; transform?: unknown};
        if (typeof plugin.name !== 'string') return entry;
        const filter = ROLLDOWN_TRANSFORM_FILTERS[plugin.name];
        if (!filter || !plugin.transform) return entry;
        if (typeof plugin.transform === 'function') {
            return {...plugin, transform: {filter, handler: plugin.transform}};
        }
        if (typeof plugin.transform === 'object' && !('filter' in plugin.transform)) {
            return {...plugin, transform: {...plugin.transform, filter}};
        }
        return entry;
    };
    viteConfig.plugins = viteConfig.plugins.map(apply);
}

/** 这些入口都由 new Worker(..., {type: 'module'}) 启动，可共享一次 ESM 构建及依赖 chunk。 */
export function groupModuleWorkers(groups: EntrypointGroup[]): void {
    const moduleWorkers = new Set([
        'localTranslationWorker',
        'localTtsWorker',
        'videoTranscriptionWorker',
        'mangaInferenceWorker',
        'informationHighlightWorker',
        'readingAnnotationWorker',
    ]);
    const workers = groups.filter((group): group is Entrypoint =>
        !Array.isArray(group) && group.type === 'unlisted-script' && moduleWorkers.has(group.name));
    if (workers.length < 2) return;
    const index = groups.indexOf(workers[0]);
    for (const worker of workers) groups.splice(groups.indexOf(worker), 1);
    // 只组合明确使用模块加载的自有 Worker；classic background 与轻桥仍由 WXT 单独打包。
    groups.splice(index, 0, workers);
}

/** 判断当前构建组是否为共享 ESM 依赖块的内容脚本组合。 */
export function isSharedContentScriptGroup(entrypoints: readonly {type: string; name?: string}[]): boolean {
    return entrypoints.length >= 2 && entrypoints.every((entrypoint) =>
        entrypoint.type === 'content-script'
        && typeof entrypoint.name === 'string'
        && SHARED_CONTENT_SCRIPT_NAMES.has(entrypoint.name));
}

/**
 * 将四个重型内容脚本（顶层网页、受限子 frame、网易邮箱、视频字幕子 frame）合并为单次 ESM 构建，
 * 共享 Vue / 翻译核心 / i18n / 配置等 chunk，并各自生成轻量 classic 加载器保持原有清单与隔离世界入口。
 */
export function groupContentScriptRuntimes(groups: EntrypointGroup[]): void {
    const runtimes = groups.filter((group): group is Entrypoint =>
        !Array.isArray(group) && group.type === 'content-script' && SHARED_CONTENT_SCRIPT_NAMES.has(group.name));
    if (runtimes.length < 2) return;
    const index = groups.indexOf(runtimes[0]);
    for (const runtime of runtimes) groups.splice(groups.indexOf(runtime), 1);
    groups.splice(index, 0, runtimes);
}

export interface SharedContentScriptEntry {
    readonly type: string;
    readonly name: string;
    readonly inputPath?: string;
    readonly options?: object;
}

interface SharedContentBundleChunk {
    readonly type: 'chunk';
    readonly fileName: string;
    readonly imports?: readonly string[];
    readonly dynamicImports?: readonly string[];
    readonly viteMetadata?: {readonly importedCss?: ReadonlySet<string>};
}

interface SharedContentBundleAsset {
    readonly type: 'asset';
    readonly fileName: string;
    readonly source: string | Uint8Array;
}

type SharedContentBundleItem = SharedContentBundleChunk | SharedContentBundleAsset;

function normalizeModulePath(value: string): string {
    return value.replaceAll('\\', '/');
}

function buildClassicContentScriptLoader(name: string, esmEntryPath: string, isProduction: boolean): string {
    const esmLiteral = JSON.stringify(esmEntryPath);
    const loadEsm = `void import(r.getURL(${esmLiteral})).catch(e=>{if(r.id)throw e;});`;
    if (SHADOW_UI_CONTENT_SCRIPT_NAMES.has(name)) {
        const cssLiteral = JSON.stringify(`/content-scripts/${name}.css`);
        const warnFn = isProduction ? '()=>{}' : 'console.warn.bind(console)';
        return `(()=>{const r=(typeof browser!=="undefined"?browser:chrome)?.runtime;if(!r?.id)return;const w=${warnFn};(globalThis.__FLUENTREAD_CONTENT_UI_CSS__??={})[${JSON.stringify(name)}]={reset:"/* WXT Shadow Root Reset */ :host{all:initial !important;}",loadCss:async()=>{const u=r.getURL(${cssLiteral});try{return await(await fetch(u)).text()}catch(e){w(\`Failed to load styles @ \${u}\`,e);return""}}};${loadEsm}})();\n`;
    }
    if (name === 'supportedFrame') {
        return `(()=>{const r=(typeof browser!=="undefined"?browser:chrome)?.runtime;if(!r?.id)return;globalThis.__FLUENTREAD_SUPPORTED_FRAME_CSS_URL__=r.getURL("content-scripts/supportedFrame.css");${loadEsm}})();\n`;
    }
    return `(()=>{const r=(typeof browser!=="undefined"?browser:chrome)?.runtime;if(!r?.id)return;${loadEsm}})();\n`;
}

function collectReachableChunkCss(
    entryFileName: string,
    chunks: ReadonlyMap<string, SharedContentBundleChunk>,
): string[] {
    const visited = new Set<string>();
    const collected: string[] = [];
    const seenCss = new Set<string>();
    const visit = (fileName: string): void => {
        if (visited.has(fileName)) return;
        visited.add(fileName);
        const chunk = chunks.get(fileName);
        if (!chunk) return;
        for (const imported of chunk.imports ?? []) visit(imported);
        for (const dynamicImport of chunk.dynamicImports ?? []) visit(dynamicImport);
        for (const cssFile of chunk.viteMetadata?.importedCss ?? []) {
            if (!seenCss.has(cssFile)) {
                seenCss.add(cssFile);
                collected.push(cssFile);
            }
        }
    };
    visit(entryFileName);
    return collected;
}

/**
 * 为共享 ESM 内容脚本构建组修复多入口 ENTRYPOINT 标识、Shadow UI 样式路由，
 * 并在 generateBundle 后置阶段按各入口依赖图重建原始 `content-scripts/<name>.css` 与轻量 classic 加载器。
 */
export function sharedContentScriptBuildPlugin(
    entrypoints: readonly SharedContentScriptEntry[],
    isProduction = true,
) {
    const inputPathToName = new Map<string, string>();
    for (const entrypoint of entrypoints) {
        if (typeof entrypoint.inputPath === 'string') {
            inputPathToName.set(normalizeModulePath(entrypoint.inputPath), entrypoint.name);
        }
    }
    const resetLine = 'if (!options.inheritStyles) css.push(`/* WXT Shadow Root Reset */ :host{all:initial !important;}`);';
    const loadCallLine = 'const entryCss = await loadCss();';
    const loadDeclPattern = /async function loadCss\(\)\s*\{\s*const url = browser\.runtime\.getURL\(`\/content-scripts\/\$\{import\.meta\.env\.ENTRYPOINT\}\.css`\);/u;

    return {
        name: 'fluentread-shared-content-scripts',
        transform: {
            order: 'pre' as const,
            handler(code: string, id: string) {
                if (id.startsWith(VIRTUAL_ISOLATED_CS_PREFIX)) {
                    const inputPath = normalizeModulePath(id.slice(VIRTUAL_ISOLATED_CS_PREFIX.length));
                    const entryName = inputPathToName.get(inputPath);
                    if (!entryName || !code.includes('import.meta.env.ENTRYPOINT')) return null;
                    return {
                        code: code.replaceAll('import.meta.env.ENTRYPOINT', JSON.stringify(entryName)),
                        map: null,
                    };
                }
                const cleanId = id.split('?', 1)[0] ?? id;
                if (!WXT_SHADOW_ROOT_MODULE.test(cleanId)) return null;
                if (!code.includes(resetLine) || !code.includes(loadCallLine) || !loadDeclPattern.test(code)) {
                    throw new Error('WXT shadow-root.mjs 结构已变化，无法安全适配共享内容脚本样式加载器');
                }
                const transformed = code
                    .replace(
                        resetLine,
                        'const __frEntryUi = globalThis.__FLUENTREAD_CONTENT_UI_CSS__?.[ctx?.contentScriptName];\n\t'
                        + 'if (!options.inheritStyles) css.push(__frEntryUi?.reset ?? `/* WXT Shadow Root Reset */ :host{all:initial !important;}`);',
                    )
                    .replace(
                        loadCallLine,
                        'const entryCss = await (__frEntryUi ? __frEntryUi.loadCss() : loadCss(ctx?.contentScriptName));',
                    )
                    .replace(
                        loadDeclPattern,
                        'async function loadCss(entryName = import.meta.env.ENTRYPOINT) {\n\tconst url = browser.runtime.getURL(`/content-scripts/${entryName}.css`);',
                    );
                return {code: transformed, map: null};
            },
        },
        generateBundle: {
            order: 'post' as const,
            handler(
                this: {emitFile: (file: {type: 'asset'; fileName: string; source: string}) => void},
                _options: unknown,
                bundle: Record<string, SharedContentBundleItem>,
            ) {
                const chunks = new Map<string, SharedContentBundleChunk>();
                const intermediateCss = new Map<string, string>();
                for (const [fileName, item] of Object.entries(bundle)) {
                    if (item.type === 'chunk') {
                        chunks.set(fileName, item);
                    } else if (item.type === 'asset' && fileName.endsWith('.css')) {
                        const text = typeof item.source === 'string'
                            ? item.source
                            : Buffer.from(item.source).toString('utf8');
                        intermediateCss.set(fileName, text);
                    }
                }
                for (const entrypoint of entrypoints) {
                    const esmFileName = `content-scripts/chunks/${entrypoint.name}.esm.js`;
                    if (!chunks.has(esmFileName)) {
                        throw new Error(`共享内容脚本 ESM 入口缺失：${esmFileName}`);
                    }
                    const cssInjectionMode = (entrypoint.options as {cssInjectionMode?: unknown} | undefined)?.cssInjectionMode;
                    if (cssInjectionMode === 'ui') {
                        const cssFiles = collectReachableChunkCss(esmFileName, chunks);
                        const combinedCss = cssFiles
                            .map((cssFile) => intermediateCss.get(cssFile) ?? '')
                            .filter((part) => part.length > 0)
                            .join('\n');
                        if (combinedCss.length > 0) {
                            this.emitFile({
                                type: 'asset',
                                fileName: `content-scripts/${entrypoint.name}.css`,
                                source: combinedCss,
                            });
                        }
                    }
                    this.emitFile({
                        type: 'asset',
                        fileName: `content-scripts/${entrypoint.name}.js`,
                        source: buildClassicContentScriptLoader(entrypoint.name, esmFileName, isProduction),
                    });
                }
                for (const cssFile of intermediateCss.keys()) {
                    delete bundle[cssFile];
                }
            },
        },
    };
}

/** 配置共享内容脚本 ESM 组的独立 chunk 目录、禁用宿主文档 modulePreload 并挂载加载器生成插件。 */
export function configureSharedContentScriptBuild(
    entrypoints: readonly SharedContentScriptEntry[],
    config: InlineConfig,
    isProduction = config.mode === 'production',
): void {
    if (!isSharedContentScriptGroup(entrypoints)) return;
    const build = config.build ??= {};
    build.modulePreload = false;
    const applyOutput = (container: {output?: unknown}): void => {
        const output = container.output ??= {};
        for (const target of (Array.isArray(output) ? output : [output]) as Record<string, unknown>[]) {
            target.entryFileNames = 'content-scripts/chunks/[name].esm.js';
            target.chunkFileNames = 'content-scripts/chunks/[name]-[hash].js';
            target.assetFileNames = 'assets/cs-[name]-[hash].[ext]';
            if (target.codeSplitting === undefined && target.manualChunks === undefined) {
                target.codeSplitting = {
                    groups: [
                        {name: 'vue-runtime', test: /[\\/]node_modules[\\/](?:@vue[\\/](?:reactivity|runtime-core|runtime-dom|shared)|vue)[\\/]/u},
                        {name: 'domain-parser', test: /[\\/]node_modules[\\/](?:tldts|tldts-core)[\\/]/u},
                    ],
                };
            }
        }
    };
    const buildRecord = build as Record<string, {output?: unknown} | undefined>;
    if (buildRecord.rollupOptions) applyOutput(buildRecord.rollupOptions);
    applyOutput(build.rolldownOptions ??= {});
    config.plugins = [...(config.plugins ?? []), sharedContentScriptBuildPlugin(entrypoints, isProduction)];
}

/** 页面共用的框架、域名数据与简体中文目录独立成块，避免与共享配置/规则合并出超 500 kB 的 i18n 公共块。 */
export function configureExtensionUiChunks(entrypoints: readonly {type: string}[], config: InlineConfig): void {
    const pages = new Set(['popup', 'options', 'unlisted-page', 'sidepanel']);
    if (entrypoints.length === 0 || !entrypoints.every(entrypoint => pages.has(entrypoint.type)) || config.build?.lib) return;
    const build = config.build ??= {};
    const rolldown = build.rolldownOptions ??= {};
    const output = rolldown.output ??= {};
    for (const target of Array.isArray(output) ? output : [output]) {
        if (target.codeSplitting !== undefined || target.manualChunks !== undefined) continue;
        target.codeSplitting = {groups: [
            {name: 'vue-runtime', test: /[\\/]node_modules[\\/](?:@vue[\\/](?:reactivity|runtime-core|runtime-dom|shared)|vue)[\\/]/u},
            {name: 'domain-parser', test: /[\\/]node_modules[\\/](?:tldts|tldts-core)[\\/]/u},
            {name: 'zh-cn-catalog', test: /[\\/]src[\\/]core[\\/]i18n[\\/]messages[\\/]/u},
        ]};
    }
}
