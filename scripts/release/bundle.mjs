#!/usr/bin/env node
// 收集已经构建的发布出口并记录版本；不构建、不签名，也不调用外部发布服务。
import assert from 'node:assert/strict';
import {lstat, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import JSZip from 'jszip';

export const RELEASE_TARGETS = Object.freeze([
    'chrome', 'edge', 'firefox', 'thunderbird', 'zotero', 'obsidian',
    'userscript', 'userscript-standalone', 'safari',
]);
// Greasy Fork 的资源提交和平台上传另有流程，不列入常规 Release 的 --all。
export const SUPPORTED_RELEASE_TARGETS = Object.freeze([...RELEASE_TARGETS, 'userscript-greasyfork']);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const archiveDate = new Date('1980-01-01T00:00:00.000Z');

function version(value, label) {
    assert(typeof value === 'string' && /^\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value),
        `${label} must be a valid version safe for an asset filename`);
    return value;
}

async function jsonFile(path) {
    return JSON.parse(await readFile(path, 'utf8'));
}

async function nonemptyFile(path) {
    const info = await lstat(path);
    assert(info.isFile() && info.size > 0, `Required release input must be a nonempty regular file: ${path}`);
    return readFile(path);
}

async function directoryFiles(directory, prefix = '') {
    if (!prefix) assert((await lstat(directory)).isDirectory(), `Release input must be a regular directory: ${directory}`);
    const files = [];
    for (const name of (await readdir(join(directory, prefix))).sort()) {
        const entry = join(prefix, name);
        const info = await lstat(join(directory, entry));
        assert(!info.isSymbolicLink(), `Release input must not contain a symbolic link: ${join(directory, entry)}`);
        if (info.isDirectory()) files.push(...await directoryFiles(directory, entry));
        else {
            assert(info.isFile(), `Release input must be a regular file: ${join(directory, entry)}`);
            files.push(entry.split(sep).join('/'));
        }
    }
    if (!prefix) assert(files.length > 0, `Release input directory is empty: ${directory}`);
    return files;
}

function assertOutputOutside(directory, outDir, target) {
    const outputRelative = relative(directory, outDir);
    assert(outputRelative.startsWith(`..${sep}`) || outputRelative === '..',
        `Release output directory must be outside the ${target} build directory`);
}

async function zipDirectory(directory, files) {
    const archive = new JSZip();
    for (const name of [...files].sort()) {
        archive.file(name, await readFile(join(directory, name)), {
            date: archiveDate, createFolders: false, unixPermissions: 0o100644,
        });
    }
    return archiveBytes(archive);
}

function archiveBytes(archive) {
    return archive.generateAsync({type: 'nodebuffer', compression: 'DEFLATE',
        compressionOptions: {level: 9}, platform: 'UNIX'});
}

async function normalizeArchive(archive) {
    const normalized = new JSZip();
    const entries = Object.values(archive.files).filter(entry => !entry.dir)
        .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
        normalized.file(entry.name, await entry.async('nodebuffer'), {
            date: archiveDate, createFolders: false, unixPermissions: 0o100644,
        });
    }
    return archiveBytes(normalized);
}

async function openArchive(bytes, label) {
    const archive = await JSZip.loadAsync(bytes, {checkCRC32: true});
    const files = Object.values(archive.files).filter(entry => !entry.dir);
    assert(files.length > 0, `Release archive is empty: ${label}`);
    for (const entry of files) {
        const name = entry.unsafeOriginalName ?? entry.name;
        assert(!name.startsWith('/') && !name.includes('\\')
            && !name.split('/').includes('..') && !/^[A-Za-z]:/u.test(name),
        `Release archive contains an unsafe path: ${label}: ${name}`);
        assert(((entry.unixPermissions ?? 0) & 0o170000) !== 0o120000,
            `Release archive contains a symbolic link: ${label}: ${name}`);
    }
    return archive;
}

async function archiveFile(archive, name, label) {
    const entry = archive.file(name);
    assert(entry, `Release archive is missing ${name}: ${label}`);
    const bytes = await entry.async('nodebuffer');
    assert(bytes.length > 0, `Release archive contains empty ${name}: ${label}`);
    return bytes;
}

async function verifyExtensionArchive(bytes, expectedVersion, manifestVersion, label) {
    const archive = await openArchive(bytes, label);
    const manifest = JSON.parse((await archiveFile(archive, 'manifest.json', label)).toString());
    assert.equal(manifest.version, expectedVersion, `${label} manifest version does not match the product version`);
    assert.equal(manifest.manifest_version, manifestVersion, `${label} manifest format is incorrect`);
    const entrypoints = [manifest.background?.service_worker, manifest.background?.page,
        ...manifest.background?.scripts ?? [],
        ...(manifest.content_scripts ?? []).flatMap(entry => [...entry.js ?? [], ...entry.css ?? []]),
    ].filter(Boolean);
    assert(entrypoints.length > 0, `${label} manifest has no background or content entrypoint`);
    for (const entrypoint of entrypoints) await archiveFile(archive, entrypoint, label);
    return archive;
}

function asset(target, fileName, componentVersion, kind, bytes) {
    return {target, fileName, version: componentVersion, kind, signed: false, bytes};
}

async function collectTarget(root, target, productVersion, userscriptVersion, outDir) {
    const prefix = `fluent-read-${productVersion}`;
    if (['chrome', 'edge', 'firefox', 'thunderbird'].includes(target)) {
        const extension = target === 'thunderbird' ? 'xpi' : 'zip';
        const fileName = `${prefix}-${target}.${extension}`;
        const bytes = await nonemptyFile(join(root, '.output', fileName));
        const archive = await verifyExtensionArchive(bytes, productVersion, ['chrome', 'edge'].includes(target) ? 3 : 2, target);
        const assets = [asset(target, fileName, productVersion, 'browser-extension', await normalizeArchive(archive))];
        if (target === 'firefox') {
            const sourceName = `${prefix}-sources.zip`;
            const sourceBytes = await nonemptyFile(join(root, '.output', sourceName));
            const sourceArchive = await openArchive(sourceBytes, sourceName);
            const sourcePackage = JSON.parse((await archiveFile(sourceArchive, 'package.json', sourceName)).toString());
            assert.equal(sourcePackage.version, productVersion, 'Firefox source package version does not match the product version');
            for (const input of ['.nvmrc', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches/ppu-paddle-ocr@6.6.0.patch', 'wxt.config.ts']) {
                await archiveFile(sourceArchive, input, sourceName);
            }
            assets.push(asset(target, sourceName, productVersion, 'browser-extension-source', await normalizeArchive(sourceArchive)));
        }
        return assets;
    }

    if (target === 'zotero') {
        const sourceManifest = await jsonFile(join(root, 'integrations/zotero/manifest.json'));
        const componentVersion = version(sourceManifest.version, 'Zotero version');
        const bytes = await nonemptyFile(join(root, 'integrations/zotero/dist/fluentread-zotero.xpi'));
        const archive = await openArchive(bytes, 'Zotero');
        const builtManifest = JSON.parse((await archiveFile(archive, 'manifest.json', 'Zotero')).toString());
        assert.equal(builtManifest.version, componentVersion, 'Zotero build version does not match its source manifest');
        assert(sourceManifest.applications?.zotero?.id, 'Zotero source manifest must identify the plugin');
        assert.equal(builtManifest.applications?.zotero?.id, sourceManifest.applications.zotero.id,
            'Zotero build plugin ID does not match its source manifest');
        await archiveFile(archive, 'bootstrap.js', 'Zotero');
        return [asset(target, `${prefix}-zotero.xpi`, componentVersion, 'zotero-plugin', await normalizeArchive(archive))];
    }

    if (target.startsWith('userscript')) {
        const directory = join(root, '.output', target);
        assertOutputOutside(directory, outDir, target);
        const files = await directoryFiles(directory);
        const script = await nonemptyFile(join(directory, 'fluent-read.user.js'));
        const source = script.toString('utf8');
        assert(source.startsWith('// ==UserScript==') && source.includes('// ==/UserScript=='),
            `${target} is missing its userscript metadata header`);
        const headerEnd = source.indexOf('// ==/UserScript==') + '// ==/UserScript=='.length;
        const matches = [...source.slice(0, headerEnd).matchAll(/^\/\/\s*@version\s+([^\r\n]+)$/gmu)];
        assert(matches.length === 1 && matches[0][1].trim() === userscriptVersion,
            `${target} metadata version does not match userscriptVersion`);
        assert(source.slice(headerEnd).trim(), `${target} has no script body`);
        const scriptPrefix = `fluent-read-${userscriptVersion}-${target}`;
        const assets = [asset(target, `${scriptPrefix}.user.js`, userscriptVersion, 'userscript', script)];
        const resources = files.filter(name => name !== 'fluent-read.user.js');
        if (target === 'userscript-greasyfork') {
            assert(resources.includes('fluentread-data.v1.js'), 'Greasy Fork build is missing its pinned data resource');
            await nonemptyFile(join(directory, 'fluentread-data.v1.js'));
        }
        if (resources.length) {
            assets.push(asset(target, `${scriptPrefix}-resources.zip`, userscriptVersion,
                'userscript-resources', await zipDirectory(directory, resources)));
        }
        return assets;
    }

    const directory = target === 'obsidian'
        ? join(root, 'integrations/obsidian/dist') : join(root, '.output/safari-mv2');
    assertOutputOutside(directory, outDir, target);
    const files = await directoryFiles(directory);
    let componentVersion = productVersion;
    if (target === 'obsidian') {
        const sourceManifest = await jsonFile(join(root, 'integrations/obsidian/manifest.json'));
        const builtManifest = await jsonFile(join(directory, 'manifest.json'));
        componentVersion = version(sourceManifest.version, 'Obsidian version');
        assert.equal(builtManifest.version, componentVersion, 'Obsidian build version does not match its source manifest');
        assert(sourceManifest.id, 'Obsidian source manifest must identify the plugin');
        assert.equal(builtManifest.id, sourceManifest.id, 'Obsidian build plugin ID does not match its source manifest');
        await nonemptyFile(join(directory, 'main.js'));
    }
    const bytes = await zipDirectory(directory, files);
    if (target === 'safari') await verifyExtensionArchive(bytes, productVersion, 2, 'Safari');
    return [asset(target, target === 'safari' ? `${prefix}-safari-webextension-unsigned.zip` : `${prefix}-obsidian.zip`,
        componentVersion, target === 'safari' ? 'safari-webextension-source' : 'obsidian-plugin', bytes)];
}

export async function bundleRelease({root = repositoryRoot, targets = RELEASE_TARGETS,
    outDir = 'reports/release/assets'} = {}) {
    assert(Array.isArray(targets) && targets.length > 0, 'Select at least one release target');
    assert(new Set(targets).size === targets.length, 'Release targets must not contain duplicates');
    for (const target of targets) assert(SUPPORTED_RELEASE_TARGETS.includes(target), `Unsupported release target: ${target}`);
    root = resolve(root);
    outDir = resolve(root, outDir);
    const fragmentsDir = join(dirname(outDir), 'fragments');
    const packageJson = await jsonFile(join(root, 'package.json'));
    const productVersion = version(packageJson.version, 'Product version');
    const userscriptVersion = version(packageJson.userscriptVersion, 'userscriptVersion');
    const assets = [];
    for (const target of targets) {
        const collected = await collectTarget(root, target, productVersion, userscriptVersion, outDir);
        await mkdir(outDir, {recursive: true});
        await mkdir(fragmentsDir, {recursive: true});
        const metadata = [];
        for (const {bytes, ...entry} of collected) {
            const path = join(outDir, entry.fileName);
            await writeFile(path, bytes);
            metadata.push(entry);
            assets.push({...entry, path});
        }
        await writeFile(join(fragmentsDir, `${target}.json`),
            `${JSON.stringify({productVersion, userscriptVersion, assets: metadata}, null, 2)}\n`);
    }
    return {productVersion, userscriptVersion, assets};
}

export function parseBundleArgs(argv) {
    const targets = [];
    let all = false;
    let outDir = 'reports/release/assets';
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--all') {
            assert(!all, '--all may only be specified once');
            all = true;
        } else if (argument === '--target' || argument === '--out-dir') {
            const value = argv[++index];
            assert(value && !value.startsWith('--'), `${argument} requires a value`);
            if (argument === '--target') targets.push(value);
            else outDir = value;
        } else throw new Error(`Unknown release bundle argument: ${argument}`);
    }
    assert(!(all && targets.length), 'Use --all or --target, not both');
    assert(all || targets.length, 'Usage: bundle.mjs --all | --target TARGET [--target TARGET] [--out-dir DIRECTORY]');
    for (const target of targets) assert(SUPPORTED_RELEASE_TARGETS.includes(target), `Unsupported release target: ${target}`);
    assert(new Set(targets).size === targets.length, 'Release targets must not contain duplicates');
    return {targets: all ? [...RELEASE_TARGETS] : targets, outDir};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        const result = await bundleRelease(parseBundleArgs(process.argv.slice(2)));
        console.log(JSON.stringify(result, null, 2));
    } catch (error) {
        console.error(`[release-bundle] ${error.message}`);
        process.exitCode = 1;
    }
}
