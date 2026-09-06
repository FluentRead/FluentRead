#!/usr/bin/env node

import {readFile, readdir} from 'node:fs/promises';
import JSZip from 'jszip';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

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

async function main() {
    const args = process.argv.slice(2);
    const chromeDir = path.resolve(PROJECT_ROOT, optionValue(args, '--chrome-dir', '.output/chrome-mv3'));
    const firefoxDir = path.resolve(PROJECT_ROOT, optionValue(args, '--firefox-dir', '.output/firefox-mv2'));
    const outputDir = path.resolve(PROJECT_ROOT, optionValue(args, '--output-dir', '.output'));
    const requireFirefoxArchives = args.includes('--require-firefox-archives');
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
    const [chromeBackground, firefoxBackground] = await Promise.all([
        readBackgroundBundle(chromeDir, chromeManifest),
        readBackgroundBundle(firefoxDir, firefoxManifest),
    ]);

    assert(chromeManifest.manifest_version === 3, 'Chrome 产物必须是 Manifest V3');
    assert(countPermission(chromeManifest, 'offscreen') === 1, 'Chrome MV3 必须且只能声明一次 offscreen 权限');
    assert(chromeArtifacts.includes('offscreen.html'), 'Chrome MV3 缺少 offscreen.html');
    assert(firefoxManifest.manifest_version === 2, 'Firefox 默认产物必须是 Manifest V2');
    assert(countPermission(firefoxManifest, 'offscreen') === 0, 'Firefox 不得声明 Chrome-only offscreen 权限');
    assert(firefoxArtifacts.includes('offscreen.html'), 'Firefox 缺少后台 iframe 使用的共享 DOM 页面');
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
        firefoxArchiveOcrAssets = [
            ...extensionArchive.filter((file) => file.startsWith('fluent-read-ocr/')),
            ...sourceArchive.filter((file) => file.startsWith('public/fluent-read-ocr/')),
        ];
        assert(extensionArchive.includes('offscreen.html')
            && firefoxArchiveOcrAssets.some(file => file.startsWith('fluent-read-ocr/core/'))
            && firefoxArchiveOcrAssets.some(file => file.startsWith('fluent-read-ocr/worker/'))
            && sourceArchive.some(file => file.startsWith('public/fluent-read-ocr/core/')),
        'Firefox 扩展包与源码包必须保留共享 DOM 页面和 OCR 资源');
    }

    console.log(JSON.stringify({
        status: 'ok',
        chrome: {
            manifestVersion: 3,
            offscreenPermission: true,
            runtimeCapabilityMarker: chromeBuildMarker,
            artifacts: chromeArtifacts,
            ocrAssets: chromeOcrAssets.length,
        },
        firefox: {
            manifestVersion: 2,
            offscreenPermission: false,
            runtimeCapabilityMarker: firefoxBuildMarker,
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
