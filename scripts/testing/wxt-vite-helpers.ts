/**
 * @file scripts/testing/wxt-vite-helpers.ts
 * 文件职责：封装 WXT 各入口组的 Vite/Rolldown 构建插件注入、按组插件裁剪、原生 transform 过滤与分块策略。
 * 主要内容：
 * - 提供非后台远程配置存储、受限子 frame 正文提取/站点规则替代及按入口裁剪中文目录插件；
 * - 提供按入口组裁剪无关 Vite 插件与挂接 Rolldown 原生 transform 过滤器的优化钩子；
 * - 提供模块 Worker 分组与扩展 UI 页面共享 chunk 拆分函数。
 * 模块边界：纯构建期 Vite/Rolldown 配置变换函数，不涉及浏览器清单、归档压缩或运行时状态。
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Entrypoint, EntrypointGroup} from 'wxt';
import type {InlineConfig} from 'vite';
import {scopedChineseCatalogBuildPlugin} from '../i18n/scopedChineseCatalogPlugin';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const SUBFRAME_CONTENT_SCRIPT_NAMES = new Set(['youtubeEmbed', 'supportedFrame', 'neteaseMailFrame']);
const BRIDGE_OR_WORKLET_NAMES = new Set([
    'bilibiliCaptionBridge',
    'shadowBridge',
    'xVideoBridge',
    'youtubeBridge',
    'youtubeEmbedBridge',
    'videoPcmWorklet',
]);
const NON_CONTENT_SCRIPT_PLUGIN_NAMES = new Set([
    'fluentread-shared-onnx',
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
    'fluentread-defuddle-entity-decoder': {id: /(?:^|[\\/])defuddle[\\/]dist[\\/]index\.js$/},
    'fluentread-deferred-franc-models': {id: /(?:^|[\\/])franc-min[\\/]index\.js$/},
    'wllama-static-extension-worker': {id: /@wllama[\\/]wllama[\\/]esm[\\/]index\.js$/},
    'fluent-read-tesseract-sdk-initialization': {id: /tesseract\.js[\\/]src[\\/]createWorker\.js(?:\?.*)?$/},
};

/**
 * 内容脚本和扩展 UI 永远通过 runtime 代理读取后台权威配置。通用配置存储运行时同时
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
    entrypoints: readonly {type: string}[],
    viteConfig: {plugins?: unknown[]},
): void {
    const remoteOnlyTypes = new Set(['content-script', 'popup', 'options', 'unlisted-page', 'sidepanel']);
    if (entrypoints.length === 0 || !entrypoints.every((entrypoint) => remoteOnlyTypes.has(entrypoint.type))) return;
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

/** 内容脚本与后台仅注入其产物实际可达的中文界面条目；所有扩展 UI 页面继续共享完整中文目录块。 */
export function extendScopedChineseCatalogBuildConfig(
    entrypoints: readonly {type: string}[],
    viteConfig: {plugins?: unknown[]},
): void {
    const scopedTypes = new Set(['content-script', 'background']);
    if (entrypoints.length === 0 || !entrypoints.every((entrypoint) => scopedTypes.has(entrypoint.type))) return;
    viteConfig.plugins = [...(viteConfig.plugins ?? []), scopedChineseCatalogBuildPlugin()];
}

/** 按入口构建组裁剪不可能命中的 Vite 插件，减少 13 组串行构建中无关插件的 hook 调度开销。 */
export function pruneEntrypointVitePlugins(
    entrypoints: readonly {type: string; name?: string}[],
    viteConfig: {plugins?: unknown[]},
): void {
    if (entrypoints.length === 0 || !Array.isArray(viteConfig.plugins) || viteConfig.plugins.length === 0) return;
    const removed = new Set<string>();
    const allBridgesOrWorklet = entrypoints.every((entrypoint) =>
        typeof entrypoint.name === 'string' && BRIDGE_OR_WORKLET_NAMES.has(entrypoint.name));
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
    // 只组合明确使用模块加载的自有 Worker；内容脚本和 classic background 仍由 WXT 单独打包。
    groups.splice(index, 0, workers);
}

/** 页面共用的框架与域名数据独立成块，避免与中文目录及配置合成一个超大公共块。 */
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
        ]};
    }
}
