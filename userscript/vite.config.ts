import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {basename, dirname, resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import vue from '@vitejs/plugin-vue';
import ts from 'typescript';
import {defineConfig, normalizePath, transformWithEsbuild, type Plugin} from 'vite';
import {createUserscriptMetadata} from './metadata';
import {createUserscriptCharacterDataCompressionPlugin} from './characterDataPlugin';
import {createUserscriptFrancDataCompressionPlugin} from './francDataPlugin';
import {createUserscriptTldtsDataCompressionPlugin} from './tldtsDataPlugin';
import {createUserscriptInlineCssCompressionPlugin} from './inlineCssPlugin';
import {createUserscriptAboutImagesCompressionPlugin} from './aboutImagesPlugin';
import {createUserscriptServiceBrandIconsCompressionPlugin} from './serviceBrandIconsPlugin';
import {createUserscriptSettingsDataPlugin} from './settingsDataPlugin';
import {packKeyColumn, packLanguageUpdates, packMessageCatalog, packUiLanguageBundle} from './languageData';
import {gzipLargeStandaloneUserscriptData, gzipUserscriptBuildData} from './buildGzip';
import {encodeUserscriptDataCompact, encodeUserscriptData} from './buildDataEncoding';
import {UI_LANGUAGE_BUNDLES, zhCNMessages, currentUserscriptLanguageBundle, createUserscriptLanguageUpdate, userscriptPageMessages} from './languageBundles';
import type {RegisteredUiLanguage, UiLanguageBundle} from '../src/core/i18n/types';
import {createDeepLXRuntimeBuildPlugin} from '../scripts/testing/deeplx-runtime-build';

const root = resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    version: string;
    userscriptVersion: string;
};
const iconDataUrl = `data:image/png;base64,${fs.readFileSync(resolve(root, 'public/icon/64.png')).toString('base64')}`;
const bundleLibraries = process.env.FLUENTREAD_USERSCRIPT_STANDALONE === '1';
const greasyForkSource = process.env.FLUENTREAD_USERSCRIPT_GREASYFORK_SOURCE === '1';
const prepareGreasyForkData = process.env.FLUENTREAD_USERSCRIPT_PREPARE_RESOURCES === '1';
const vendorUrl = process.env.FLUENTREAD_USERSCRIPT_VENDOR_URL;
const dataUrl = process.env.FLUENTREAD_USERSCRIPT_DATA_URL;
const allowedResourceUrl = (url: string | undefined) => Boolean(url && /^(?:https:\/\/|http:\/\/127\.0\.0\.1(?::\d+)?\/)/u.test(url));
if (greasyForkSource && (!allowedResourceUrl(vendorUrl) || !allowedResourceUrl(dataUrl))) {
    throw new Error('Greasy Fork source build requires vendor and data resource URLs');
}
const vendorGlobals: Record<string, string> = {
    ai: 'FluentReadUserscriptVendor.ai',
    '@ai-sdk/openai-compatible': 'FluentReadUserscriptVendor.openAICompatible',
    'crypto-js/sha256': 'FluentReadUserscriptVendor.sha256',
    'crypto-js/md5': 'FluentReadUserscriptVendor.md5',
    'crypto-js/hmac-sha256': 'FluentReadUserscriptVendor.hmacSha256',
    'crypto-js/aes': 'FluentReadUserscriptVendor.aes',
    'crypto-js/enc-utf8': 'FluentReadUserscriptVendor.encUtf8',
    'crypto-js/enc-base64': 'FluentReadUserscriptVendor.encBase64',
    'crypto-js/mode-ecb': 'FluentReadUserscriptVendor.modeEcb',
    'crypto-js/pad-pkcs7': 'FluentReadUserscriptVendor.padPkcs7',
    'dexie/dist/dexie.min.js': 'FluentReadUserscriptVendor.Dexie',
    'franc-min': 'FluentReadUserscriptVendor.francMin',
};
function installedVersion(name: string): string {
    const manifest = JSON.parse(fs.readFileSync(resolve(root, 'node_modules', name, 'package.json'), 'utf8')) as {version: string};
    return manifest.version;
}

// 脚本管理器在安装时缓存固定版本的通用库；仓库资源固定到已发布提交，更新资源时同步换提交。
const userscriptResourceCommit = '184a3d74f61b9d2a8d47080787f7e0180b98414d';
// 语言文件的内容哈希来自合并后的消息目录，固定到首次包含这些文件的提交。
const userscriptLanguageResourceCommit = 'f804e1b39dbd3313c8bdae9738ebd69a51ad2074';
const pinnedIconUrl = `https://cdn.jsdelivr.net/gh/FluentRead/FluentRead@${userscriptResourceCommit}/public/icon/64.png`;
const iconMetaUrl = greasyForkSource ? pinnedIconUrl : bundleLibraries ? encodeUserscriptData(fs.readFileSync(resolve(root, 'public/icon/64.png'))) : iconDataUrl;
const uiRequires = [
    `https://cdn.jsdelivr.net/npm/vue@${installedVersion('vue')}/dist/vue.global.prod.js`,
    `https://cdn.jsdelivr.net/gh/FluentRead/FluentRead@${userscriptResourceCommit}/userscript/vueElementPlusBridge.v1.js`,
    `https://cdn.jsdelivr.net/npm/element-plus@${installedVersion('element-plus')}/dist/index.full.min.js`,
    `https://cdn.jsdelivr.net/npm/@element-plus/icons-vue@${installedVersion('@element-plus/icons-vue')}/dist/index.iife.min.js`,
    `https://cdn.jsdelivr.net/npm/tldts@${installedVersion('tldts')}/dist/index.umd.min.js`,
];
const userscriptRequires = bundleLibraries
    ? []
    : [...uiRequires, 'https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako_inflate.min.js',
        ...(greasyForkSource ? [vendorUrl!, dataUrl!] : [])];
// 标准版安装时已缓存同源固定依赖，管理器列表图标复用同一提交的图片，避免重复嵌入 PNG。
// 页面工具仍由 bootstrap 内嵌图片；无远程依赖的 standalone 连元数据图标也保持内嵌。
const metadata = createUserscriptMetadata({version: packageJson.userscriptVersion,
    iconDataUrl: bundleLibraries ? iconDataUrl : pinnedIconUrl, requires: userscriptRequires});
// 界面词典只按 key 查询，稳定排序把相似 key 聚在一起，提高静态 JSON 压缩率；数组顺序保持原样。
function serializeUiMessages(value: unknown): string {
    return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}
/** 独立版消息优先比较现有紧凑 gzip，再选择经构建 worker 校验的较小结果。 */
export async function gzipStandaloneUiMessages(input: Uint8Array,
    compress = gzipLargeStandaloneUserscriptData): Promise<Buffer> {
    const baseline = gzipUserscriptBuildData(input, undefined, true);
    const candidate = await compress(input, root);
    return candidate.byteLength < baseline.byteLength ? candidate : baseline;
}
// 与中文内嵌目录一致，仅投影扩展文档页专用 key；固定远程与外部资源继续使用原 bundle。
const defaultMessageColumns = packMessageCatalog(userscriptPageMessages(zhCNMessages));
const compressedUiLanguageBundles: Record<string, string> = {};
const englishBundle = UI_LANGUAGE_BUNDLES['en-US'];
if (!greasyForkSource && englishBundle) {
    const input = Buffer.from(serializeUiMessages(packUiLanguageBundle(
        {...englishBundle, messages: userscriptPageMessages(englishBundle.messages)},
        bundleLibraries ? defaultMessageColumns[0] as readonly string[] : undefined,
        bundleLibraries,
    )));
    const bytes = bundleLibraries ? await gzipLargeStandaloneUserscriptData(input, root) : gzipUserscriptBuildData(input);
    compressedUiLanguageBundles['en-US'] = bundleLibraries ? encodeUserscriptDataCompact(bytes) : bytes.toString('base64');
}
const remoteUiLanguageBundles = Object.fromEntries(Object.entries(UI_LANGUAGE_BUNDLES)
    .filter(([language]) => language !== 'en-US')
    .map(([language, bundle]) => {
        const contents = JSON.stringify(bundle);
        const digest = createHash('sha256').update(contents).digest('hex').slice(0, 16);
        const fileName = `${language}.${digest}.json`;
        const filePath = resolve(root, 'userscript/languages', fileName);
        if (!fs.existsSync(filePath) || fs.readFileSync(filePath, 'utf8').trimEnd() !== contents) {
            throw new Error(`Userscript language data missing or stale: ${fileName}; run pnpm generate:userscript-languages`);
        }
        return [language, fileName];
    }));
// 固定五语 JSON 和 Greasy Fork DATA 只作为发布基线；所有当前修订由构建期差分自动携带。
const pinnedData = greasyForkSource ? (runInNewContext(fs.readFileSync(resolve(root, 'userscript/resources/fluentread-data.v1.js'), 'utf8'), {}, {timeout: 5_000}) as {english: UiLanguageBundle; zhCNMessages: Record<string, string>; siteCatalogs: Record<string, unknown>; css: string}) : undefined;
const uiLanguageUpdates = Object.fromEntries(Object.entries(UI_LANGUAGE_BUNDLES).flatMap(([language, baseline]) => {
    if (language === 'en-US' && !pinnedData) return [];
    return [[language, createUserscriptLanguageUpdate(currentUserscriptLanguageBundle(language as RegisteredUiLanguage),
        language === 'en-US' ? pinnedData!.english : baseline)]];
}));
const languageUpdateInput = Buffer.from(serializeUiMessages(bundleLibraries ? packLanguageUpdates(uiLanguageUpdates) : uiLanguageUpdates));
const languageUpdateBytes = bundleLibraries && !greasyForkSource ? await gzipStandaloneUiMessages(languageUpdateInput)
    : gzipUserscriptBuildData(languageUpdateInput, undefined, bundleLibraries);
const compressedUiLanguageUpdates = bundleLibraries ? encodeUserscriptDataCompact(languageUpdateBytes) : languageUpdateBytes.toString('base64');
const unicodeNotice = `/*\n${fs.readFileSync(resolve(root, 'public/third-party-notices/unicode-17.0.0.txt'), 'utf8')}\n*/`;
const serviceIconsLicense = fs.readFileSync(resolve(root, 'public/third-party-notices/lobe-icons-MIT.txt'), 'utf8');
const tinycolorLicense = fs.readFileSync(resolve(root, 'public/third-party-notices/tinycolor-MIT.txt'), 'utf8');
const serviceIconsNotice = `/*\n${serviceIconsLicense}\n*/`;
// 两个库共用完全相同的 MIT 正文；分别保留包/版本、来源、提交与版权，只合并授权和免责正文。
const sharedMitNotice = bundleLibraries ? '' : (() => {
    const permissionStart = 'Permission is hereby granted';
    const iconsStart = serviceIconsLicense.indexOf(permissionStart);
    const tinycolorStart = tinycolorLicense.indexOf(permissionStart);
    const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim();
    if (iconsStart < 0 || tinycolorStart < 0
        || normalize(serviceIconsLicense.slice(iconsStart)) !== normalize(tinycolorLicense.slice(tinycolorStart))) {
        throw new Error('Bundled MIT notice bodies differ; retain both complete notices');
    }
    return `/*\n${serviceIconsLicense.slice(0, iconsStart).trimEnd()}\n\n@ctrl/tinycolor 3.6.1 — MIT\n${tinycolorLicense.slice(0, tinycolorStart).trimEnd()}\n\n${serviceIconsLicense.slice(iconsStart).trimEnd()}\n*/`;
})();
const browserShimPath = resolve(root, 'userscript/browser.ts');
const projectRoot = `${normalizePath(root)}/`;
const siteCatalogDir = resolve(root, 'src/core/site-adaptation/catalog');
const siteCatalogFiles = new Set(['established.json', 'websites.json', 'profiles.json']
    .map((name) => resolve(siteCatalogDir, name)));
const siteCatalogData = Object.fromEntries([...siteCatalogFiles]
    .map((sourcePath) => [basename(sourcePath, '.json'), JSON.parse(fs.readFileSync(sourcePath, 'utf8'))]));
// 构建目录提供权威规则；固定资源中未变的规则复用，新增或更新的规则随消费者补齐。
const pinnedSiteCatalogs = pinnedData?.siteCatalogs;
const compressedCatalogPrefix = '\0fluentread-userscript-site-catalog:';
const externalChineseMessagesId = '\0fluentread-userscript-zh-cn.js';

/** 只压缩站点规则与中文文案数据；产品逻辑仍留在可审查的 userscript 主文件中。 */
export function createUserscriptCatalogCompressionPlugin(): Plugin {
    return {
        name: 'compress-userscript-site-catalog',
        enforce: 'pre',
        resolveId(source, importer) {
            if (source === './messages/zh-CN'
                && importer?.split('?')[0] === resolve(root, 'src/core/i18n/index.ts')) return externalChineseMessagesId;
            if (!importer || !source.endsWith('.json')) return null;
            const sourcePath = resolve(dirname(importer.split('?')[0]), source);
            // 以 .js 结尾，避免 Vite 的 JSON 插件再次尝试解析虚拟模块源码。
            return siteCatalogFiles.has(sourcePath) ? `${compressedCatalogPrefix}${sourcePath}.js` : null;
        },
        load(id) {
            if (id === externalChineseMessagesId) {
                if (greasyForkSource) {
                    const current = userscriptPageMessages(zhCNMessages);
                    const delta = Object.fromEntries(Object.entries(current).filter(([key, value]) => pinnedData!.zhCNMessages[key] !== value));
                    const compressed = gzipUserscriptBuildData(Buffer.from(serializeUiMessages(delta))).toString('base64');
                    return [
                        "import {inflateWithPako} from '@/userscript/pakoRuntime';",
                        `const update = JSON.parse(inflateWithPako(Uint8Array.from(atob(${JSON.stringify(compressed)}), character => character.charCodeAt(0))));`,
                        'export const zhCNMessages = {...globalThis.__FLUENTREAD_USERSCRIPT_DATA__.zhCNMessages, ...update};',
                    ].join('\n');
                }
                const contents = serializeUiMessages(bundleLibraries ? [packKeyColumn(defaultMessageColumns[0] as readonly string[]), defaultMessageColumns[1]] : userscriptPageMessages(zhCNMessages));
                const input = Buffer.from(contents);
                const emit = (compressedBytes: Buffer) => {
                    const compressed = bundleLibraries ? encodeUserscriptDataCompact(compressedBytes) : compressedBytes.toString('base64');
                    return [
                    `/* Non-code Chinese UI messages; sha256 ${createHash('sha256').update(contents).digest('hex')}. */`,
                    "import {inflateWithPako} from '@/userscript/pakoRuntime';",
                    ...(bundleLibraries ? ["import {decodeUserscriptData} from '@/userscript/dataEncoding';",
                        "import {restoreDefaultMessageColumns} from '@/userscript/defaultMessageData';"] : []),
                    bundleLibraries ? `const bytes = decodeUserscriptData(${JSON.stringify(compressed)});`
                        : `const bytes = Uint8Array.from(atob(${JSON.stringify(compressed)}), (character) => character.charCodeAt(0));`,
                    bundleLibraries ? 'export const zhCNMessages = restoreDefaultMessageColumns(JSON.parse(inflateWithPako(bytes)));'
                        : 'export const zhCNMessages = JSON.parse(inflateWithPako(bytes));',
                    ].join('\n');
                };
                return bundleLibraries ? gzipStandaloneUiMessages(input).then(emit)
                    : emit(gzipUserscriptBuildData(input));
            }
            if (!id.startsWith(compressedCatalogPrefix)) return null;
            const sourcePath = id.slice(compressedCatalogPrefix.length, -'.js'.length);
            if (!siteCatalogFiles.has(sourcePath)) throw new Error(`Unexpected userscript site catalog: ${sourcePath}`);
            if (greasyForkSource) {
                const name = basename(sourcePath, '.json');
                const current = siteCatalogData[name];
                const pinned = pinnedSiteCatalogs?.[name];
                if (!Array.isArray(current) || !Array.isArray(pinned)) {
                    return `export default globalThis.__FLUENTREAD_USERSCRIPT_DATA__.siteCatalogs.${name};`;
                }
                const pinnedById = new Map(pinned.map((rule) => [rule.id, rule]));
                const updates = current.filter((rule) => JSON.stringify(rule) !== JSON.stringify(pinnedById.get(rule.id)));
                const order = current.map((rule) => rule.id);
                if (!updates.length && JSON.stringify(order) === JSON.stringify(pinned.map((rule) => rule.id))) {
                    return `export default globalThis.__FLUENTREAD_USERSCRIPT_DATA__.siteCatalogs.${name};`;
                }
                return [
                    `const catalog = globalThis.__FLUENTREAD_USERSCRIPT_DATA__.siteCatalogs.${name};`,
                    'const present = new Map(catalog.map((rule) => [rule.id, rule]));',
                    `const updates = new Map(${JSON.stringify(updates)}.map((rule) => [rule.id, rule]));`,
                    `export default ${JSON.stringify(order)}.map((id) => {`,
                    '  const rule = updates.get(id) ?? present.get(id);',
                    '  if (!rule) throw new Error("Missing pinned userscript site rule: " + id);',
                    '  return rule;',
                    '});',
                ].join('\n');
            }
            const contents = JSON.stringify(JSON.parse(fs.readFileSync(sourcePath, 'utf8')));
            const data = Buffer.from(contents);
            const baseline = gzipUserscriptBuildData(data, undefined, bundleLibraries);
            const digest = createHash('sha256').update(contents).digest('hex');
            const emit = (bytes: Uint8Array) => {
                const compressed = (bundleLibraries ? encodeUserscriptDataCompact : encodeUserscriptData)(bytes);
                return [
                `/* Non-code site rules: ${normalizePath(sourcePath).slice(projectRoot.length)}; sha256 ${digest}. */`,
                "import {inflateWithPako} from '@/userscript/pakoRuntime';",
                "import {decodeUserscriptData} from '@/userscript/dataEncoding';",
                `const bytes = decodeUserscriptData(${JSON.stringify(compressed)});`,
                'export default JSON.parse(inflateWithPako(bytes));',
                ].join('\n');
            };
            // 仅独立版的大目录使用构建期 worker；较大结果保留现有紧凑 gzip。
            return bundleLibraries && basename(sourcePath) === 'websites.json'
                ? gzipLargeStandaloneUserscriptData(data, root).then(candidate => emit(candidate.byteLength < baseline.byteLength ? candidate : baseline))
                : emit(baseline);
        },
    };
}

// dexie 的官方入口以 Symbol.for('Dexie') 作为跨 realm 的单例注册表；该注册一旦进入油猴产物，
// 与宿主页面的 Dexie 副本撞上不同版本就会在入口处抛错。用产物文本兜底，防止别名将来被改坏。
const DEXIE_GLOBAL_REGISTRATION = /Symbol\s*\.\s*for\s*\(\s*(['"])Dexie\1\s*\)/u;

export function findDexieGlobalRegistration(code: string): boolean {
    return DEXIE_GLOBAL_REGISTRATION.test(code);
}

export const compatibilityPreludeStart = '/* FluentRead userscript compatibility prelude:start */';
export const compatibilityPreludeEnd = '/* FluentRead userscript compatibility prelude:end */';
export const executionGuardStart = '/* FluentRead userscript execution guard:start */';
export const executionGuardEnd = '/* FluentRead userscript execution guard:end */';

export function wrapUserscriptEntry(entryCode: string, bootstrapCode: string, thirdPartyNotices = ''): string {
    return [
        metadata,
        unicodeNotice,
        bundleLibraries ? serviceIconsNotice : sharedMitNotice,
        ...(thirdPartyNotices ? [thirdPartyNotices] : []),
        executionGuardStart,
        'if (!globalThis.__fluentReadUserscriptBootstrapped) {',
        bootstrapCode,
        entryCode,
        '}',
        executionGuardEnd,
    ].join('\n');
}

export function bundledLibraryNotices(moduleIds: readonly string[]): string {
    const packageRoots = new Set<string>();
    for (const id of moduleIds) {
        if (id.startsWith('\0')) continue;
        const match = /^(.*\/node_modules\/\.pnpm\/[^/]+\/node_modules\/)(@[^/]+\/[^/]+|[^/]+)/u.exec(id);
        if (match) packageRoots.add(`${match[1]}${match[2]}`);
    }
    // 紧凑执行器按这些锁定上游的 HTTP/重试合同实现；即使通用 SDK 已裁掉，仍保留来源许可。
    if (moduleIds.includes(resolve(root, 'src/providers/translation/ai-sdk/openai-http.ts'))) {
        const aiRoot = fs.realpathSync(resolve(root, 'node_modules/ai'));
        const aiRequire = createRequire(resolve(aiRoot, 'package.json'));
        packageRoots.add(aiRoot);
        packageRoots.add(fs.realpathSync(resolve(root, 'node_modules/@ai-sdk/openai-compatible')));
        for (const name of ['@ai-sdk/provider', '@ai-sdk/provider-utils']) {
            packageRoots.add(dirname(dirname(aiRequire.resolve(name))));
        }
    }
    // 仅合并 trim 后逐字相同的完整许可（含版权）；每个包的原始标题都保留，组按首次出现排序。
    const licenseGroups = new Map<string, string[]>();
    for (const packageRoot of [...packageRoots].sort()) {
        const manifest = JSON.parse(fs.readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
            name: string;
            version: string;
            license?: string;
            repository?: string | {url?: string};
        };
        const licenseFile = fs.readdirSync(packageRoot).find((name) => /^LICEN[CS]E(?:[.-].*)?$/iu.test(name));
        if (!manifest.license) throw new Error(`Missing bundled library license: ${manifest.name}`);
        const repository = typeof manifest.repository === 'string'
            ? manifest.repository
            : manifest.repository?.url;
        const licenseText = licenseFile
            ? fs.readFileSync(resolve(packageRoot, licenseFile), 'utf8').trim()
            : `License source: ${repository || `https://www.npmjs.com/package/${manifest.name}/v/${manifest.version}`}`;
        if (licenseText.includes('*/')) throw new Error(`Unsafe bundled library license comment: ${manifest.name}`);
        const heading = `${manifest.name} ${manifest.version} — ${manifest.license}`;
        const headings = licenseGroups.get(licenseText);
        if (headings) headings.push(heading);
        else licenseGroups.set(licenseText, [heading]);
    }
    const notices = [...licenseGroups].map(([licenseText, headings]) =>
        `/*\n${headings.join('\n')}\n${licenseText}\n*/`).join('\n');
    if (!bundleLibraries) return notices;
    // 完整独立版还包含不同版权及内嵌子依赖的同一 MIT 正文。仅匹配现有许可文件的完整
    // 授权与免责文字，允许换行/空白差异；每个版权、来源和前后附加条款保留在原位置。
    const permissionStart = tinycolorLicense.indexOf('Permission is hereby granted');
    if (permissionStart < 0) throw new Error('Canonical bundled MIT permission terms are missing');
    const terms = tinycolorLicense.slice(permissionStart).trim();
    const escapedWords = terms.split(/\s+/u).map(word => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
    const repeatedTerms = new RegExp(escapedWords.join('\\s+'), 'gu');
    if ([...notices.matchAll(repeatedTerms)].length < 2) return notices;
    return notices.replace(repeatedTerms, '[Shared MIT terms below]')
        + `\n/*\nShared MIT permission and warranty terms for the references above:\n${terms}\n*/`;
}

// Via 等旧内核可能缺少共享核心使用的基础方法；在单文件入口最前方注入小型兼容层。
const compatibilityPrelude = `(function () {
    if (typeof Object.fromEntries !== 'function') {
        Object.defineProperty(Object, 'fromEntries', {
            configurable: true,
            writable: true,
            value: function (entries) {
                var result = {};
                Array.from(entries).forEach(function (entry) {
                    Object.defineProperty(result, entry[0], {
                        configurable: true,
                        enumerable: true,
                        writable: true,
                        value: entry[1]
                    });
                });
                return result;
            }
        });
    }
    if (typeof Promise.allSettled !== 'function') {
        Object.defineProperty(Promise, 'allSettled', {
            configurable: true,
            writable: true,
            value: function (values) {
                return Promise.all(Array.from(values, function (value) {
                    return Promise.resolve(value).then(function (fulfilledValue) {
                        return {status: 'fulfilled', value: fulfilledValue};
                    }, function (reason) {
                        return {status: 'rejected', reason: reason};
                    });
                }));
            }
        });
    }
    if (typeof Array.prototype.flatMap !== 'function') {
        Object.defineProperty(Array.prototype, 'flatMap', {
            configurable: true,
            writable: true,
            value: function (callback, thisArg) {
                if (this === null || this === undefined) throw new TypeError('Array.prototype.flatMap called on null or undefined');
                if (typeof callback !== 'function') throw new TypeError('flatMap callback must be a function');
                var source = Object(this);
                var numericLength = Number(source.length) || 0;
                var length = Math.min(Math.max(Math.floor(numericLength), 0), 9007199254740991);
                var result = [];
                for (var index = 0; index < length; index += 1) {
                    if (!(index in source)) continue;
                    var mapped = callback.call(thisArg, source[index], index, source);
                    if (!Array.isArray(mapped)) {
                        result.push(mapped);
                        continue;
                    }
                    for (var mappedIndex = 0; mappedIndex < mapped.length; mappedIndex += 1) {
                        if (mappedIndex in mapped) result.push(mapped[mappedIndex]);
                    }
                }
                return result;
            }
        });
    }
}());`;

type BrowserGlobal = 'browser' | 'chrome';

/**
 * 借助 TypeScript 符号解析查找真正未绑定的 browser/chrome 标识符；属性名和类型引用
 * 不应触发注入，避免对普通业务对象产生误改写。
 */
export function findFreeBrowserGlobals(code: string, id: string): BrowserGlobal[] {
    // 没有候选时不建立编译器 program；反斜杠保留 Unicode 转义标识符的完整解析路径。
    if (!code.includes('browser') && !code.includes('chrome') && !code.includes('\\')) return [];
    const sourceFile = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true);
    const options: ts.CompilerOptions = {
        allowJs: true,
        module: ts.ModuleKind.ESNext,
        noLib: true,
        noResolve: true,
        target: ts.ScriptTarget.Latest,
    };
    const host: ts.CompilerHost = {
        fileExists: (fileName) => fileName === id,
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => root,
        getDefaultLibFileName: () => '',
        getNewLine: () => '\n',
        getSourceFile: (fileName) => fileName === id ? sourceFile : undefined,
        readFile: (fileName) => fileName === id ? code : undefined,
        useCaseSensitiveFileNames: () => true,
        writeFile: () => undefined,
    };
    const checker = ts.createProgram([id], options, host).getTypeChecker();
    const found = new Set<BrowserGlobal>();
    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && (node.text === 'browser' || node.text === 'chrome')) {
            const parent = node.parent;
            const isPropertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node)
                || ((ts.isPropertyAssignment(parent)
                    || ts.isMethodDeclaration(parent)
                    || ts.isPropertyDeclaration(parent)
                    || ts.isPropertySignature(parent)
                    || ts.isMethodSignature(parent)) && parent.name === node);
            const isTypeOnlyReference = ts.isTypeReferenceNode(parent)
                || ts.isTypeQueryNode(parent)
                || ts.isQualifiedName(parent);
            if (!isPropertyName && !isTypeOnlyReference && !checker.getSymbolAtLocation(node)) {
                found.add(node.text);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return (['browser', 'chrome'] as const).filter((name) => found.has(name));
}

export function injectUserscriptBrowserImports(code: string, id: string): string | null {
    const [rawId, query = ''] = id.split('?', 2);
    const cleanId = normalizePath(rawId);
    const isScriptModule = /\.[cm]?[jt]sx?$/u.test(cleanId);
    const isVueScriptModule = cleanId.endsWith('.vue')
        && new URLSearchParams(query).get('type') === 'script';
    if (!cleanId.startsWith(projectRoot) || (!isScriptModule && !isVueScriptModule)) return null;

    const injected = findFreeBrowserGlobals(code, cleanId);
    if (injected.length === 0) return null;

    const specifiers = injected.map((name) => name === 'browser' ? 'default as browser' : 'chrome');
    return `import {${specifiers.join(', ')}} from ${JSON.stringify(browserShimPath)};\n${code}`;
}

/** 为项目内 TS/JS 与 Vue script 模块注入 userscript browser shim。 */
function injectUserscriptBrowserShim(): Plugin {
    return {
        name: 'inject-userscript-browser-shim',
        enforce: 'pre',
        transform(code, id) {
            const transformed = injectUserscriptBrowserImports(code, id);
            return transformed ? {code: transformed, map: null} : null;
        },
    };
}

/**
 * 把拆分出的 CSS、Userscript 元数据和兼容层合并进唯一入口，并阻止扩展全局泄漏到产物。
 */
function bundleUserscriptCss(): Plugin {
    return {
        name: 'bundle-userscript-css',
        enforce: 'post',
        transform: {
            order: 'pre',
            handler(code, id) {
                // page.css 使用 ?inline 进入 JS，必须在 Vite CSS 转换前排除不可达的扩展来源提示。
                if (normalizePath(id.split('?', 1)[0]) !== normalizePath(resolve(root, 'src/app/content/page.css'))) return null;
                const withoutCorrectionBadge = code.replace(/\.fluent-read-bilingual-content\[data-fr-personal-correction="true"\]::after\s*\{[^}]*\}/gu, '');
                return withoutCorrectionBadge === code ? null : {code: withoutCorrectionBadge, map: null};
            },
        },
        generateBundle: {
          order: 'post',
          async handler(_options, bundle) {
            // 个人校订需要扩展后台作为唯一写入者；public 别名之外的直接导入也必须在构建期阻止。
            const correctionFeatureRoot = `${resolve(root, 'src/features/personal-corrections')}/`;
            const leakedCorrectionModule = Object.values(bundle)
                .filter((item) => item.type === 'chunk')
                .flatMap((item) => item.moduleIds)
                .find((id) => id.startsWith(correctionFeatureRoot));
            if (leakedCorrectionModule) {
                throw new Error(`Userscript bundle contains unsupported personal correction feature: ${leakedCorrectionModule}`);
            }

            const cssEntries = Object.entries(bundle).filter(([, item]) => item.type === 'asset' && item.fileName.endsWith('.css'));
            const css = cssEntries.map(([, item]) => String(item.type === 'asset' ? item.source : '')).join('\n');
            const cssBytes = greasyForkSource ? undefined : bundleLibraries
                ? await gzipLargeStandaloneUserscriptData(Buffer.from(css, 'utf8'), root)
                : gzipUserscriptBuildData(Buffer.from(css, 'utf8'));
            const compressedCss = cssBytes === undefined ? '' : bundleLibraries
                ? encodeUserscriptDataCompact(cssBytes) : cssBytes.toString('base64');
            cssEntries.forEach(([fileName]) => delete bundle[fileName]);

            if (greasyForkSource) {
                // Greasy Fork 的源码文件保留产品逻辑，静态词条、站点规则和样式单独随固定版本缓存。
                if (!prepareGreasyForkData && cssEntries.length && css !== pinnedData!.css) {
                    throw new Error('Greasy Fork CSS changed; prepare and publish a new immutable data resource');
                }
                const data = {
                    english: UI_LANGUAGE_BUNDLES['en-US'],
                    zhCNMessages,
                    siteCatalogs: siteCatalogData,
                    css,
                };
                this.emitFile({
                    type: 'asset',
                    fileName: 'fluentread-data.v1.js',
                    // 已发布 DATA 是不可变基线；当前词典增量和站点规则分别随各自消费者更新。
                    source: prepareGreasyForkData ? [
                        '/* FluentRead non-code data: UI translations, site rules and CSS. */',
                        `globalThis.__FLUENTREAD_USERSCRIPT_DATA__=${JSON.stringify(data)};`,
                    ].join('\n') : fs.readFileSync(resolve(root, 'userscript/resources/fluentread-data.v1.js'), 'utf8'),
                });
            }

            const entry = Object.values(bundle).find((item) => item.type === 'chunk' && item.isEntry);
            if (!entry || entry.type !== 'chunk') throw new Error('Userscript entry chunk was not generated');

            // 兼容层在 Vite 主产物之外拼接，也需压缩空白和局部变量；不改语法或许可声明。
            const preludeCode = greasyForkSource ? compatibilityPrelude : (await transformWithEsbuild(
                compatibilityPrelude, 'userscript-compatibility-prelude.js',
                {target: 'es2018', minifyWhitespace: true, minifyIdentifiers: true, minifySyntax: false},
            )).code;
            const bootstrap = [
                `${compatibilityPreludeStart}\n${preludeCode}\n${compatibilityPreludeEnd}`,
                `globalThis.__FLUENTREAD_ICON_DATA__=${JSON.stringify(iconMetaUrl)};`,
                ...(greasyForkSource
                    ? ['globalThis.__fluentReadUserscriptCss=globalThis.__FLUENTREAD_USERSCRIPT_DATA__.css;']
                    : [`globalThis.__fluentReadUserscriptCssCompressed=${JSON.stringify(compressedCss)};`]),
            ].join('\n');
            // 入口内部的幂等标记只能在整个 IIFE 顶层求值后生效。脚本管理器若对同一
            // 文档再次注入，必须在最外层跳过整个 bundle，否则内联模块会重复创建
            // 配置 store、watch 和 preparation barrier，即使 bootstrap 最后选择返回。
            entry.code = wrapUserscriptEntry(
                entry.code,
                bootstrap,
                bundleLibraries ? bundledLibraryNotices(entry.moduleIds)
                    : entry.moduleIds.includes(resolve(root, 'src/providers/translation/ai-sdk/openai-http.ts'))
                        ? bundledLibraryNotices([resolve(root, 'src/providers/translation/ai-sdk/openai-http.ts')]) : '',
            );

            entry.code = entry.code.replace(/[\uFFFE\uFFFF]/gu, (character) => {
                const codePoint = character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
                return `\\u${codePoint}`;
            });

            const leakedGlobals = findFreeBrowserGlobals(entry.code, resolve(root, '.output/userscript/fluent-read.user.js'));
            if (leakedGlobals.length > 0) {
                throw new Error(`Userscript bundle contains unresolved extension globals: ${leakedGlobals.join(', ')}`);
            }

            if (findDexieGlobalRegistration(entry.code)) {
                throw new Error(
                    'Userscript bundle registers globalThis[Symbol.for("Dexie")]; import dexie through userscript/dexie.ts '
                    + 'so a host page carrying another Dexie version cannot abort the script (issue #524)',
                );
            }
          },
        },
        writeBundle(_options, bundle) {
            const files = Object.values(bundle).map((item) => item.fileName).sort();
            const expected = greasyForkSource
                ? ['fluent-read.user.js', 'fluentread-data.v1.js']
                : ['fluent-read.user.js'];
            if (JSON.stringify(files) !== JSON.stringify(expected)) {
                throw new Error(`Userscript build emitted unexpected files: ${files.join(', ')}`);
            }
        },
    };
}

/** 将 WXT 内容脚本声明展开为普通对象，使同一入口可在 userscript 单页 runtime 中复用。 */
function unwrapWxtEntrypoints(): Plugin {
    const entrypoints = new Set([
        resolve(root, 'entrypoints/content.ts'),
    ]);
    return {
        name: 'unwrap-wxt-entrypoints',
        enforce: 'pre',
        transform(code, id) {
            if (!entrypoints.has(id)) return null;
            return code.replace(/\bdefineContentScript\s*\(/gu, '((definition) => definition)(');
        },
    };
}

/** 直接安装的两种脚本复用自有非流式 provider 入口；Greasy Fork 继续使用固定版本 SDK。 */
export function createStandaloneOpenAITransportPlugin(): Plugin {
    const original = resolve(root, 'src/providers/translation/ai-sdk/openai-compatible');
    return {
        name: 'standalone-openai-transport',
        enforce: 'pre',
        resolveId(source, importer) {
            const target = source.startsWith('@/') ? resolve(root, source.slice(2))
                : source.startsWith('.') && importer ? resolve(dirname(importer.split('?')[0]), source) : source;
            return target === original || target === `${original}.ts`
                ? resolve(root, 'userscript/openaiCompatible.ts') : null;
        },
    };
}

export const userscriptAliases = [
    ...(bundleLibraries ? [{find: '@/userscript/pakoRuntime', replacement: resolve(root, 'userscript/pakoBundled.ts')}] : []),
    // dexie 官方 ESM 入口把自身注册到跨 realm 共享的 globalThis[Symbol.for('Dexie')]，版本不一致时会在
    // 模块求值阶段直接抛错。脚本管理器（如 Safari 的 Userscripts）把脚本注入页面主 world，与宿主页面共享
    // 该注册表，必须换成不注册全局符号的入口，否则整个 bundle 会在入口处中断（issue #524）。
    {find: /^dexie$/u, replacement: resolve(root, 'userscript/dexie.ts')},
    {find: '@/src/platform/storage/credentialContext', replacement: resolve(root, 'userscript/credentialContext.ts')},
    {find: '@/src/platform/storage/configStorageRuntime', replacement: resolve(root, 'userscript/storage.ts')},
    {find: /^@\/src\/services\/harness\/generation(?:\.ts)?$/u, replacement: resolve(root, 'userscript/readingGeneration.ts')},
    // 扩展从本地资源读取界面语言；userscript 内嵌英文，其他语言从仓库静态 JSON 按需加载。
    {find: '@/src/platform/i18n/uiLanguageBundles', replacement: resolve(root, 'userscript/uiLanguageBundles.ts')},
    {find: /^@\/src\/services\/translation\/context\/browser$/u, replacement: resolve(root, 'userscript/pageContext.ts')},
    {find: /^@\/src\/services\/translation\/context$/u, replacement: resolve(root, 'userscript/pageTranslationContext.ts')},
    // app/content 只依赖 feature 公开契约；在此边界替换，才能保证扩展专属 runtime 不进入产物。
    {find: '@/src/features/information-highlight/public', replacement: resolve(root, 'userscript/informationHighlight.ts')},
    {find: '@/src/features/area-translation/public', replacement: resolve(root, 'userscript/unsupportedCapabilities.ts')},
    {find: '@/src/features/image-translation/public', replacement: resolve(root, 'userscript/unsupportedCapabilities.ts')},
    {find: '@/src/features/video-subtitle/public', replacement: resolve(root, 'userscript/unsupportedCapabilities.ts')},
    {find: '@/src/features/vocabulary/content/public', replacement: resolve(root, 'userscript/unsupportedCapabilities.ts')},
    // 仅关闭没有材料后台的附加采集；material/text/public 原文投影仍由真实模块提供。
    {find: /^@\/src\/features\/vocabulary\/material\/public$/u, replacement: resolve(root, 'userscript/materialCapture.ts')},
    // 完整设置保留真实收藏组件；运行时材料门禁之外，构建也不携带未支持的材料 UI/客户端。
    {find: /^@\/src\/features\/vocabulary\/ui\/public$/u, replacement: resolve(root, 'userscript/vocabularyUi.ts')},
    {find: '@/src/features/personal-corrections/public', replacement: resolve(root, 'userscript/unsupportedCapabilities.ts')},
    {find: '@/src/features/writing-assistant/public', replacement: resolve(root, 'userscript/writingAssistant.ts')},
    {find: /^\.\/chrome-translator$/u, replacement: resolve(root, 'userscript/chromeTranslator.ts')},
    {find: '@wxt-dev/storage', replacement: resolve(root, 'userscript/storage.ts')},
    {find: 'webextension-polyfill', replacement: resolve(root, 'userscript/browser.ts')},
    {find: 'wxt/utils/content-script-ui/shadow-root', replacement: resolve(root, 'userscript/shadow-root.ts')},
    {find: '@', replacement: root},
];

export default defineConfig({
    root,
    publicDir: false,
    plugins: [...(!greasyForkSource ? [createStandaloneOpenAITransportPlugin()] : []), createUserscriptSettingsDataPlugin(root, !greasyForkSource, bundleLibraries), createDeepLXRuntimeBuildPlugin(root), unwrapWxtEntrypoints(), createUserscriptCatalogCompressionPlugin(), createUserscriptCharacterDataCompressionPlugin(root, !greasyForkSource, bundleLibraries), createUserscriptFrancDataCompressionPlugin(root, !greasyForkSource, !greasyForkSource, bundleLibraries), createUserscriptTldtsDataCompressionPlugin(root, bundleLibraries && !greasyForkSource, bundleLibraries && !greasyForkSource, bundleLibraries && !greasyForkSource), createUserscriptAboutImagesCompressionPlugin(root, bundleLibraries && !greasyForkSource, bundleLibraries), createUserscriptServiceBrandIconsCompressionPlugin(root, bundleLibraries && !greasyForkSource, bundleLibraries), injectUserscriptBrowserShim(), vue(), bundleUserscriptCss(), createUserscriptInlineCssCompressionPlugin(root, !greasyForkSource, bundleLibraries)],
    resolve: {
        alias: userscriptAliases,
    },
    define: {
        'process.env.NODE_ENV': JSON.stringify('production'),
        'process.env.VUE_APP_VERSION': JSON.stringify(packageJson.version),
        'process.env.VUE_APP_USERSCRIPT_VERSION': JSON.stringify(packageJson.userscriptVersion),
        'import.meta.env.BROWSER': JSON.stringify('userscript'),
        'import.meta.env.MANIFEST_VERSION': '2',
        __FLUENTREAD_USERSCRIPT_LANGUAGE_BUNDLES__: JSON.stringify(compressedUiLanguageBundles),
        __FLUENTREAD_USERSCRIPT_LANGUAGE_UPDATES__: JSON.stringify(compressedUiLanguageUpdates),
        __FLUENTREAD_USERSCRIPT_REMOTE_LANGUAGES__: JSON.stringify(remoteUiLanguageBundles),
        __FLUENTREAD_USERSCRIPT_RESOURCE_COMMIT__: JSON.stringify(userscriptLanguageResourceCommit),
        __FLUENTREAD_FULL_OPTIONS__: JSON.stringify(bundleLibraries),
    },
    build: {
        outDir: resolve(root, bundleLibraries ? '.output/userscript-standalone'
            : greasyForkSource ? '.output/userscript-greasyfork' : '.output/userscript'),
        emptyOutDir: true,
        target: 'es2018',
        minify: greasyForkSource ? false : 'esbuild',
        // 锁定的 CommonJS 26 默认 auto 会因条件 require 的分析时机改变 MD5 初始化包装。
        // 保留首次 require 的初始化顺序与循环依赖语义，使同源构建能稳定比较；不改库实现。
        commonjsOptions: {strictRequires: true},
        sourcemap: false,
        cssCodeSplit: false,
        assetsInlineLimit: Number.MAX_SAFE_INTEGER,
        lib: {
            entry: resolve(root, 'userscript/main.ts'),
            name: 'FluentReadUserscript',
            formats: ['iife'],
            fileName: () => 'fluent-read.user.js',
        },
        rollupOptions: {
            external: bundleLibraries ? [] : [
                'vue', 'element-plus', '@element-plus/icons-vue', 'tldts',
                ...(greasyForkSource ? Object.keys(vendorGlobals) : []),
            ],
            output: {
                inlineDynamicImports: true,
                entryFileNames: 'fluent-read.user.js',
                globals: {
                    vue: 'Vue',
                    'element-plus': 'ElementPlus',
                    '@element-plus/icons-vue': 'ElementPlusIconsVue',
                    tldts: 'tldts',
                    ...(greasyForkSource ? vendorGlobals : {}),
                },
            },
        },
    },
});
