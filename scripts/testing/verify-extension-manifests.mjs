#!/usr/bin/env node

import {readFile, readdir} from 'node:fs/promises';
import JSZip from 'jszip';
import path from 'node:path';
import process from 'node:process';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash, createPublicKey} from 'node:crypto';
import {PDFJS_DECODER_FILES} from './pdfjs-assets.mjs';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
// 发布校验 CLI 不直接导入 TypeScript；与公开身份常量的对应关系由 manifest 合约测试校验。
const GOOGLE_DRIVE_DEFAULT_CLIENT_ID = '474699705334-7fua4hnkq1nmfu92cof0kdnmqsk5kth8.apps.googleusercontent.com';
const GOOGLE_DRIVE_EXTENSION_ID = 'djnlaiohfaaifbibleebjggkghlmcpcj';
const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

function optionValue(args, name, fallback) {
    const index = args.indexOf(name);
    if (index < 0) return fallback;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} 缺少目录`);
    return value;
}

async function readManifest(directory) {
    const manifestPath = path.join(directory, 'manifest.json');
    return JSON.parse(await readFile(manifestPath, 'utf8'));
}

async function readBackgroundBundle(directory, manifest) {
    const files = manifest.manifest_version === 3
        ? [manifest.background?.service_worker]
        : manifest.background?.scripts;
    assert(Array.isArray(files) && files.length > 0 && files.every((file) => typeof file === 'string'),
        `无法解析 ${directory} 的后台脚本`);
    return (await Promise.all(files.map((file) => readFile(path.join(directory, file), 'utf8')))).join('\n');
}

async function listOffscreenArtifacts(directory, current = directory) {
    const artifacts = [];
    for (const entry of await readdir(current, {withFileTypes: true})) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) artifacts.push(...await listOffscreenArtifacts(directory, absolute));
        else if (entry.name.toLocaleLowerCase().includes('offscreen')) {
            artifacts.push(path.relative(directory, absolute).split(path.sep).join('/'));
        }
    }
    return artifacts.sort();
}

async function listArtifacts(directory, current = directory) {
    const artifacts = [];
    for (const entry of await readdir(current, {withFileTypes: true})) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) artifacts.push(...await listArtifacts(directory, absolute));
        else artifacts.push(path.relative(directory, absolute).split(path.sep).join('/'));
    }
    return artifacts.sort();
}

async function listArchiveArtifacts(archivePath) {
    const archive = await JSZip.loadAsync(await readFile(archivePath));
    return Object.values(archive.files)
        .filter((entry) => !entry.dir)
        .map((entry) => entry.name)
        .sort();
}

async function readJavaScriptBundle(directory, current = directory) {
    const sources = [];
    for (const entry of await readdir(current, {withFileTypes: true})) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) sources.push(await readJavaScriptBundle(directory, absolute));
        else if (entry.name.endsWith('.js')) sources.push(await readFile(absolute, 'utf8'));
    }
    return sources.join('\n');
}

function countPermission(manifest, permission) {
    return Array.isArray(manifest.permissions)
        ? manifest.permissions.filter((candidate) => candidate === permission).length
        : 0;
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

/** 校验真实产物中的七语安装说明，防止占位符未接线、语言缺失或静态描述漂移。 */
export async function verifyLocalizedExtensionMetadata(directory, manifest) {
    assert(manifest.name === '__MSG_extensionName__' && manifest.description === '__MSG_extensionDescription__',
        '扩展名称和说明必须通过浏览器本地化 metadata 解析');
    assert(manifest.default_locale === 'en', '扩展安装 metadata 必须提供英文默认语言');
    const descriptions = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'src/core/i18n/messages/product-descriptions.json'), 'utf8'));
    const locales = Object.entries(descriptions).map(([language, description]) => ({
        locale: language === 'zh-CN' ? 'zh_CN' : language.split('-')[0], description,
    }));
    const actualLocales = (await readdir(path.join(directory, '_locales'), {withFileTypes: true}))
        .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    assert(isDeepStrictEqual(actualLocales, locales.map(({locale}) => locale).sort()), '扩展安装 metadata 的语言集合与源目录不一致');
    for (const {locale, description} of locales) {
        const messages = JSON.parse(await readFile(path.join(directory, '_locales', locale, 'messages.json'), 'utf8'));
        const name = messages.extensionName?.message;
        assert(typeof name === 'string' && name.trim().length > 0, `${locale} 缺少本地化扩展名称`);
        assert(messages.extensionDescription?.message === description && description.trim().length > 0
            && description.length <= 132 && !/[\r\n]/u.test(description), `${locale} 扩展说明缺失、漂移或超过 132 字符`);
    }
    return actualLocales;
}

export function verifyChromeOfflineManifest(offlineManifest, localManifest) {
    assert(isDeepStrictEqual(offlineManifest, localManifest), 'Chrome 离线清单必须与本地构建一致');
    assert(typeof offlineManifest.key === 'string' && offlineManifest.key.trim().length > 0,
        'Chrome 离线 ZIP 必须保留固定扩展 ID 的公开 key 字段');
    const keyBytes = Buffer.from(offlineManifest.key, 'base64');
    try {
        createPublicKey({key: keyBytes, format: 'der', type: 'spki'});
    } catch {
        throw new Error('Chrome 离线 ZIP 的 key 必须是有效的公开公钥');
    }
    const digest = createHash('sha256').update(keyBytes).digest('hex').slice(0, 32);
    const extensionId = [...digest].map(value => String.fromCharCode(97 + parseInt(value, 16))).join('');
    const oauth = offlineManifest.oauth2;
    assert(typeof oauth?.client_id === 'string' && oauth.client_id.trim().length > 0,
        'Chrome 离线 ZIP 必须保留 Google OAuth 客户端');
    assert(countPermission(offlineManifest, 'identity') === 1 && oauth.scopes?.includes(GOOGLE_DRIVE_SCOPE),
        'Chrome 离线 ZIP 必须保留 identity 权限与 Drive 应用数据授权范围');
    if (oauth.client_id === GOOGLE_DRIVE_DEFAULT_CLIENT_ID) {
        assert(extensionId === GOOGLE_DRIVE_EXTENSION_ID,
            'Chrome 离线 ZIP 的扩展 ID 与默认 Google OAuth 客户端不匹配');
    }
    return extensionId;
}

export async function verifyChromeArchive(zipBytes, localManifest, localDirectory) {
    const archive = await JSZip.loadAsync(zipBytes, {checkCRC32: true});
    const manifestEntry = archive.file('manifest.json');
    assert(manifestEntry, 'Chrome ZIP 缺少 manifest.json');
    verifyChromeOfflineManifest(JSON.parse(await manifestEntry.async('string')), localManifest);
    const names = Object.values(archive.files).filter(entry => !entry.dir).map(entry => entry.name).sort();
    assert(isDeepStrictEqual(names, await listArtifacts(localDirectory)),
        'Chrome ZIP 的文件条目必须与本地构建一致');
    for (const name of names) {
        const [archiveBytes, localBytes] = await Promise.all([
            archive.file(name).async('nodebuffer'), readFile(path.join(localDirectory, name)),
        ]);
        assert(archiveBytes.equals(localBytes), `Chrome ZIP 的文件内容与本地构建不一致：${name}`);
    }
}

export function verifyChromeArchiveNames(outputFiles, version) {
    const archive = `fluent-read-${version}-chrome.zip`;
    assert(outputFiles.includes(archive), `Chrome 发布压缩包缺失：${archive}`);
    assert(!outputFiles.includes(`fluent-read-${version}-chrome-store.zip`),
        'Chrome 当前版本不得残留旧的 -chrome-store.zip，请重新运行 pnpm zip');
    return archive;
}

function verifySharedFrameEntrypoint(manifest, files, browser) {
    const entries = manifest.content_scripts ?? [];
    const shared = entries.filter(entry => entry.js?.includes('content-scripts/supportedFrame.js'));
    const expectedMatches = [
        'https://*.hf.space/*',
        'https://courses.edx.org/*',
        'https://disqus.com/embed/comments/*',
        'https://mail.qq.com/cgi-bin/readmail*',
        'https://www.kaggleusercontent.com/kf/*/__results__.html*',
    ];
    assert(shared.length === 1, `${browser} 必须只注册一次共用子 frame 入口`);
    assert(JSON.stringify([...shared[0].matches].sort()) === JSON.stringify(expectedMatches),
        `${browser} 共用子 frame 入口的匹配范围变化`);
    assert(shared[0].all_frames === true && shared[0].match_about_blank !== true
        && shared[0].run_at === 'document_end', `${browser} 共用子 frame 注入条件变化`);
    assert(files.includes('content-scripts/supportedFrame.js'), `${browser} 缺少共用子 frame 脚本`);
    assert(!files.some(file => /^content-scripts\/(?:qqMailFrame|embeddedArticleFrame)\.(?:js|css)$/u.test(file)),
        `${browser} 保留了冗余的旧子 frame 产物`);
    const netease = entries.find(entry => entry.js?.includes('content-scripts/neteaseMailFrame.js'));
    assert(netease?.all_frames === true && netease.match_about_blank === true,
        `${browser} 网易邮箱必须继续匹配 about:blank 正文子 frame`);
}

const FRAME_SCRIPT_FILES = ['content', 'neteaseMailFrame', 'supportedFrame'].map(name => `content-scripts/${name}.js`);
const NETEASE_FRAME_MATCHES = ['https://*.mail.126.com/*', 'https://*.mail.163.com/*', 'https://*.mail.yeah.net/*'];

async function readFrameScripts(directory) {
    return Object.fromEntries(await Promise.all(FRAME_SCRIPT_FILES.map(async file =>
        [file, await readFile(path.join(directory, file), 'utf8')])));
}

function resourcePatternMatches(pattern, resource) {
    if (typeof pattern !== 'string') return false;
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*');
    return new RegExp(`^${escaped}$`, 'u').test(resource);
}

/** 校验实际入口的 Shadow UI CSS 依赖；无 UI 的共用 frame 不应生成或公开多余样式。 */
export function verifyFrameUiStyles(manifest, files, scripts, browser) {
    verifySharedFrameEntrypoint(manifest, files, browser);
    const entries = manifest.content_scripts ?? [];
    const resources = manifest.web_accessible_resources;
    assert(Array.isArray(resources), `${browser} 缺少 UI CSS 可访问资源声明`);
    const cssRules = resource => resources.filter(rule => typeof rule === 'string'
        ? resourcePatternMatches(rule, resource)
        : rule?.resources?.some(pattern => resourcePatternMatches(pattern, resource)));
    const expected = [
        {name: 'content', matches: ['<all_urls>'], allFrames: false, aboutBlank: false, runAt: 'document_start'},
        {name: 'neteaseMailFrame', matches: NETEASE_FRAME_MATCHES, allFrames: true, aboutBlank: true, runAt: 'document_end'},
    ];
    for (const {name, matches, allFrames, aboutBlank, runAt} of expected) {
        const js = `content-scripts/${name}.js`;
        const css = `content-scripts/${name}.css`;
        const entry = entries.filter(candidate => candidate.js?.includes(js));
        assert(entry.length === 1 && Array.isArray(entry[0].matches)
            && isDeepStrictEqual([...entry[0].matches].sort(), matches)
            && (entry[0].all_frames === true) === allFrames
            && (entry[0].match_about_blank === true) === aboutBlank
            && entry[0].match_origin_as_fallback !== true && entry[0].run_at === runAt,
        `${browser} ${name} UI 入口注入范围或时机变化`);
        assert(!entry[0].css?.length, `${browser} ${name} UI CSS 不应改为页面自动注入`);
        assert(files.includes(js) && files.includes(css), `${browser} 缺少 ${name} UI 脚本或 CSS 文件`);
        const source = scripts[js];
        assert(typeof source === 'string' && source.includes('WXT Shadow Root Reset')
            && source.includes('Failed to load styles @'), `${browser} ${name} 缺少 WXT UI CSS 加载器`);
        // 只依赖 WXT 的稳定 API 名和资源字面量，不依赖压缩后的函数或变量名。
        const urls = [...source.matchAll(/\.getURL\s*\(\s*(["'`])(\/?content-scripts\/[^"'`\s]+\.css)\1\s*\)/gu)]
            .map(match => match[2].replace(/^\//u, ''));
        const literals = [...source.matchAll(/(["'`])(\/?content-scripts\/[^"'`\s]+\.css)\1/gu)]
            .map(match => match[2].replace(/^\//u, ''));
        assert(urls.length > 0 && urls.every(url => url === css)
            && literals.length > 0 && literals.every(url => url === css), `${browser} ${name} WXT CSS URL 错误或缺失`);
        const rules = cssRules(css);
        assert(rules.length === 1, `${browser} ${name} UI CSS 必须只公开一次`);
        if (manifest.manifest_version === 3) {
            const rule = rules[0];
            assert(typeof rule === 'object' && rule.resources.includes(css)
                && Array.isArray(rule.matches) && isDeepStrictEqual([...rule.matches].sort(), matches)
                && !rule.extension_ids?.length, `${browser} ${name} UI CSS 可访问范围变化`);
            assert(rule.use_dynamic_url === false, `${browser} ${name} UI CSS 必须保留稳定 URL`);
        } else {
            assert(manifest.manifest_version === 2 && rules[0] === css,
                `${browser} ${name} MV2 UI CSS 必须保留精确资源路径`);
        }
    }
    const supportedCss = 'content-scripts/supportedFrame.css';
    const supported = entries.find(entry => entry.js?.includes('content-scripts/supportedFrame.js'));
    assert(!supported.css?.length && supported.match_origin_as_fallback !== true,
        `${browser} 共用子 frame 不应自动注入 CSS 或扩大来源匹配`);
    assert(!files.includes(supportedCss) && cssRules(supportedCss).length === 0,
        `${browser} 共用子 frame 保留了无消费的 UI CSS 文件或资源声明`);
    const source = scripts['content-scripts/supportedFrame.js'];
    assert(typeof source === 'string' && !/["'`]\/?content-scripts\/[^"'`\s]+\.css["'`]/u.test(source)
        && !source.includes('WXT Shadow Root Reset') && !source.includes('wxt-shadow-root-document-styles')
        && !source.includes('Failed to load styles @'), `${browser} 共用子 frame 仍引入 Shadow UI CSS 加载路径`);
}

export function findUnexpectedCurrentVersionArchives(outputFiles, version, expectedArchives) {
    const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const currentVersionArchive = new RegExp(
        `(?:^|\\D)${escapedVersion}-(?:firefox|sources)\\.zip$`,
        'u',
    );
    const expected = new Set(expectedArchives);
    return outputFiles
        .filter((file) => currentVersionArchive.test(file) && !expected.has(file))
        .sort();
}

/** 原生面板由 WXT 生成；验证最终产物，防止丢失权限或混入另一浏览器的字段。 */
export function verifyTranslationSidepanelManifest(manifest, files, browser) {
    assert(files.includes('sidepanel.html'), `${browser} 缺少原生翻译面板页面`);
    if (browser === 'Chrome') {
        assert(!manifest.side_panel && !manifest.sidebar_action,
            'Chrome 翻译面板清单不得注册全局默认面板');
        assert(countPermission(manifest, 'sidePanel') === 1, 'Chrome 必须且只能声明一次 sidePanel 权限');
    } else {
        assert(manifest.sidebar_action?.default_panel === 'sidepanel.html' && manifest.sidebar_action.open_at_install === false && !manifest.side_panel,
            'Firefox 翻译面板清单无效或安装时主动展开');
        assert(countPermission(manifest, 'sidePanel') === 0, 'Firefox 不得声明 Chrome-only sidePanel 权限');
    }
    const publicFiles = (manifest.web_accessible_resources || []).flatMap(rule => typeof rule === 'string' ? [rule] : rule.resources);
    assert(!publicFiles.includes('sidepanel.html'), `${browser} 不得向网页公开翻译面板`);
}

async function main() {
    const args = process.argv.slice(2);
    const chromeDir = path.resolve(PROJECT_ROOT, optionValue(args, '--chrome-dir', '.output/chrome-mv3'));
    const firefoxDir = path.resolve(PROJECT_ROOT, optionValue(args, '--firefox-dir', '.output/firefox-mv2'));
    const outputDir = path.resolve(PROJECT_ROOT, optionValue(args, '--output-dir', '.output'));
    const requireFirefoxArchives = args.includes('--require-firefox-archives');
    const requireChromeArchive = args.includes('--require-chrome-archive');
    const [
        chromeManifest,
        firefoxManifest,
        chromeArtifacts,
        firefoxArtifacts,
        chromeFiles,
        firefoxFiles,
        chromeJavaScript,
        firefoxJavaScript,
    ] = await Promise.all([
        readManifest(chromeDir),
        readManifest(firefoxDir),
        listOffscreenArtifacts(chromeDir),
        listOffscreenArtifacts(firefoxDir),
        listArtifacts(chromeDir),
        listArtifacts(firefoxDir),
        readJavaScriptBundle(chromeDir),
        readJavaScriptBundle(firefoxDir),
    ]);
    const [chromeBackground, firefoxBackground, chromeFrameScripts, firefoxFrameScripts] = await Promise.all([
        readBackgroundBundle(chromeDir, chromeManifest),
        readBackgroundBundle(firefoxDir, firefoxManifest),
        readFrameScripts(chromeDir),
        readFrameScripts(firefoxDir),
    ]);
    const [chromeMetadataLocales, firefoxMetadataLocales] = await Promise.all([
        verifyLocalizedExtensionMetadata(chromeDir, chromeManifest),
        verifyLocalizedExtensionMetadata(firefoxDir, firefoxManifest),
    ]);

    assert(chromeManifest.manifest_version === 3, 'Chrome 产物必须是 Manifest V3');
    assert(countPermission(chromeManifest, 'offscreen') === 1, 'Chrome MV3 必须且只能声明一次 offscreen 权限');
    assert(chromeArtifacts.includes('offscreen.html'), 'Chrome MV3 缺少 offscreen.html');
    assert(firefoxManifest.manifest_version === 2, 'Firefox 默认产物必须是 Manifest V2');
    assert(countPermission(firefoxManifest, 'offscreen') === 0, 'Firefox 不得声明 Chrome-only offscreen 权限');
    assert(firefoxArtifacts.includes('offscreen.html'), 'Firefox 缺少后台 iframe 使用的共享 DOM 页面');
    verifyTranslationSidepanelManifest(chromeManifest, chromeFiles, 'Chrome');
    verifyTranslationSidepanelManifest(firefoxManifest, firefoxFiles, 'Firefox');
    assert(!chromeManifest.browser_specific_settings?.gecko, 'Chrome manifest 不得包含 Firefox Gecko metadata');
    const firefoxGecko = firefoxManifest.browser_specific_settings?.gecko;
    assert(firefoxGecko?.id === '{3096bd53-3bda-4556-b076-ebf47442a5c1}', 'Firefox manifest 缺少稳定 AMO GUID');
    assert(firefoxGecko?.strict_min_version === '140.0', 'Firefox manifest 必须要求 Firefox 140.0 或更高版本');
    const requiredData = firefoxGecko?.data_collection_permissions?.required;
    const expectedData = ['authenticationInfo', 'personalCommunications', 'websiteContent'];
    assert(Array.isArray(requiredData)
        && requiredData.length === expectedData.length
        && expectedData.every((permission) => requiredData.includes(permission)),
    'Firefox manifest 的数据传输分类必须完整且不得声明 none');
    for (const file of PDFJS_DECODER_FILES.map(name => `pdfjs/wasm/${name}`)) {
        assert(chromeFiles.includes(file) && firefoxFiles.includes(file), `扩展缺少本地 PDF.js 解码资源：${file}`);
    }
    const chromeOcrAssets = chromeFiles.filter((file) => file.startsWith('fluent-read-ocr/'));
    const firefoxOcrAssets = firefoxFiles.filter((file) => file.startsWith('fluent-read-ocr/'));
    assert(chromeOcrAssets.some((file) => file.includes('/core/'))
        && chromeOcrAssets.some((file) => file.includes('/worker/')),
    'Chrome 产物必须保留本地 OCR core 与 worker');
    assert(firefoxOcrAssets.some((file) => file.includes('/core/'))
        && firefoxOcrAssets.some((file) => file.includes('/worker/')),
    'Firefox 必须打包与 Chrome 共用的 OCR core 与 worker');
    const chromeBuildMarker = '__FLUENTREAD_BROWSER_CAPABILITY_BUILD__:chrome:mv3__';
    const firefoxBuildMarker = '__FLUENTREAD_BROWSER_CAPABILITY_BUILD__:firefox:mv2__';
    assert(chromeJavaScript.includes(chromeBuildMarker), 'Chrome 产物缺少 chrome/MV3 runtime capability 构建标记');
    assert(!chromeJavaScript.includes(firefoxBuildMarker), 'Chrome 产物混入 Firefox runtime capability 构建标记');
    assert(firefoxJavaScript.includes(firefoxBuildMarker), 'Firefox 产物缺少 firefox/MV2 runtime capability 构建标记');
    assert(!firefoxJavaScript.includes(chromeBuildMarker), 'Firefox 产物混入 Chrome runtime capability 构建标记');
    assert(chromeBackground.includes(chromeBuildMarker), 'Chrome 后台脚本缺少 chrome/MV3 runtime capability 构建标记');
    assert(firefoxBackground.includes(firefoxBuildMarker), 'Firefox 后台脚本缺少 firefox/MV2 runtime capability 构建标记');
    assert(!chromeBackground.includes('import.meta'), 'Chrome classic MV3 background 不得残留 import.meta 语法');
    assert(!firefoxBackground.includes('import.meta'), 'Firefox classic MV2 background 不得残留 import.meta 语法');
    verifyFrameUiStyles(chromeManifest, chromeFiles, chromeFrameScripts, 'Chrome');
    verifyFrameUiStyles(firefoxManifest, firefoxFiles, firefoxFrameScripts, 'Firefox');

    let chromeArchive = null;
    if (requireChromeArchive) {
        chromeArchive = verifyChromeArchiveNames(await readdir(outputDir), chromeManifest.version);
        await verifyChromeArchive(await readFile(path.join(outputDir, chromeArchive)), chromeManifest, chromeDir);
    }

    let firefoxArchives = [];
    let firefoxArchiveOcrAssets = [];
    if (requireFirefoxArchives) {
        const outputFiles = await readdir(outputDir);
        firefoxArchives = [
            `fluent-read-${firefoxManifest.version}-firefox.zip`,
            `fluent-read-${firefoxManifest.version}-sources.zip`,
        ];
        firefoxArchives.forEach((archive) => {
            assert(outputFiles.includes(archive), `Firefox 发布压缩包名称无效或缺失：${archive}`);
        });
        const unexpectedArchives = findUnexpectedCurrentVersionArchives(
            outputFiles,
            firefoxManifest.version,
            firefoxArchives,
        );
        assert(unexpectedArchives.length === 0,
            `Firefox 发布压缩包存在当前版本的非期望命名：${unexpectedArchives.join(', ')}`);
        const [extensionArchive, sourceArchive] = await Promise.all(
            firefoxArchives.map((archive) => listArchiveArtifacts(path.join(outputDir, archive))),
        );
        for (const file of ['.nvmrc', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'wxt.config.ts',
            'src/app/background/runtime.ts', 'scripts/wasm/package-diagnostics.ts', 'patches/ppu-paddle-ocr@6.6.0.patch']) {
            assert(sourceArchive.includes(file), `Firefox 审核源码包缺少 ${file}`);
        }
        assert(!sourceArchive.some(file => /(?:^|\/)\.env(?:$|\.)|^(?:node_modules|coverage)\//u.test(file)),
            'Firefox 审核源码包包含本地环境文件或生成目录');
        for (const file of PDFJS_DECODER_FILES) {
            assert(extensionArchive.includes(`pdfjs/wasm/${file}`), `Firefox 扩展包缺少本地 PDF.js 解码资源：${file}`);
        }
        firefoxArchiveOcrAssets = [
            ...extensionArchive.filter((file) => file.startsWith('fluent-read-ocr/')),
            ...sourceArchive.filter((file) => file.startsWith('public/fluent-read-ocr/')),
        ];
        assert(extensionArchive.includes('offscreen.html')
            && firefoxArchiveOcrAssets.some(file => file.startsWith('fluent-read-ocr/core/'))
            && firefoxArchiveOcrAssets.some(file => file.startsWith('fluent-read-ocr/worker/'))
            && ['package.json', 'pnpm-lock.yaml', 'scripts/wasm/package-diagnostics.ts',
                'public/fluent-read-ocr/NOTICE.md'].every(file => sourceArchive.includes(file)),
        'Firefox 扩展包与源码包必须保留共享 DOM 页面、OCR 资源及可复现构建输入');
    }

    console.log(JSON.stringify({
        status: 'ok',
        chrome: {
            manifestVersion: 3,
            offscreenPermission: true,
            sidepanel: 'sidepanel.html',
            runtimeCapabilityMarker: chromeBuildMarker,
            metadataLocales: chromeMetadataLocales,
            artifacts: chromeArtifacts,
            ocrAssets: chromeOcrAssets.length,
            archive: chromeArchive,
        },
        firefox: {
            manifestVersion: 2,
            offscreenPermission: false,
            sidepanel: firefoxManifest.sidebar_action.default_panel,
            runtimeCapabilityMarker: firefoxBuildMarker,
            metadataLocales: firefoxMetadataLocales,
            artifacts: firefoxArtifacts,
            ocrAssets: firefoxOcrAssets.length,
            geckoId: firefoxGecko.id,
            strictMinVersion: firefoxGecko.strict_min_version,
            dataCollectionPermissions: requiredData,
            archives: firefoxArchives,
            archiveOcrAssets: firefoxArchiveOcrAssets.length,
        },
    }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(`[extension-manifest-verifier] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
