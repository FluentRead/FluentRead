#!/usr/bin/env node
/**
 * @file integrations/zotero/package.mjs
 * 文件职责：组装自包含的 Zotero XPI，校验入口、脚本和本地 PDF.js 资源。
 * 主要内容：保留独立 worker、CMap 与标准字体，附带 GPL 和第三方授权；不下载远程代码或读取用户配置。
 * 模块边界：只读仓库与依赖，所有写入限制在本集成的 dist 目录，不安装插件或修改 Zotero 文献库。
 */
import {cp, mkdir, readFile, readdir, stat, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname, join, posix, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Script} from 'node:vm';
import {createRequire} from 'node:module';
import JSZip from 'jszip';
import {PDFJS_DECODER_FILES} from '../../scripts/testing/pdfjs-assets.mjs';

const integrationDir = dirname(fileURLToPath(import.meta.url));
const repositoryDir = resolve(integrationDir, '../..');
const outputDir = join(integrationDir, 'dist/plugin');
const archivePath = join(integrationDir, 'dist/fluentread-zotero.xpi');
const requiredFiles = [
    'manifest.json', 'bootstrap.js', 'content/native.js', 'content/workspace.js',
    'content/workspace.html', 'content/workspace.css', 'content/pdfjs/pdf.worker.min.mjs',
    'content/pdfjs/cmaps/UniGB-UCS2-H.bcmap', 'content/pdfjs/standard_fonts/LiberationSans-Regular.ttf',
    ...PDFJS_DECODER_FILES.map(file => `content/pdfjs/wasm/${file}`),
    'LICENSE', 'THIRD-PARTY-NOTICES.md',
];

async function listFiles(directory, relative = '') {
    const result = [];
    for (const entry of await readdir(join(directory, relative), {withFileTypes: true})) {
        const file = posix.join(relative, entry.name);
        if (entry.isDirectory()) result.push(...await listFiles(directory, file));
        else if (entry.isFile()) result.push(file);
        else throw new Error(`Zotero 安装包不允许符号链接或特殊文件：${file}`);
    }
    return result.sort();
}

async function copyFile(source, target) {
    await mkdir(dirname(target), {recursive: true});
    await cp(source, target);
}

async function copyDependencyLicenses(noticesDir) {
    const seen = new Set();
    async function visit(name, resolver) {
        let metadata;
        try { metadata = resolver.resolve(`${name}/package.json`); }
        catch {
            // 某些包通过 exports 隐藏 package.json，但随包发布的授权仍须保留。
            for (const candidate of resolver.resolve.paths(name) ?? []) {
                const path = join(candidate, name, 'package.json');
                try {await stat(path); metadata = path; break;} catch { /* 继续 Node 的模块查找路径。 */ }
            }
            if (!metadata) return;
        }
        if (seen.has(metadata)) return;
        seen.add(metadata);
        const directory = dirname(metadata);
        const pkg = JSON.parse(await readFile(metadata, 'utf8'));
        const entries = await readdir(directory);
        for (const file of entries.filter(file => /^(?:licen[cs]e|notice|copyright)(?:[.-]|$)/iu.test(file))) {
            if ((await stat(join(directory, file))).isFile()) {
                await copyFile(join(directory, file), join(noticesDir, `${pkg.name.replaceAll('/', '-')}-${pkg.version}-${file}`));
            }
        }
        const dependencyResolver = createRequire(metadata);
        for (const dependency of Object.keys(pkg.dependencies ?? {})) await visit(dependency, dependencyResolver);
    }
    const rootResolver = createRequire(import.meta.url);
    for (const name of ['vue', 'pdf-lib', '@pdf-lib/fontkit', 'jszip', 'saxes', '@noble/hashes', 'bidi-js']) await visit(name, rootResolver);
}

async function assemble() {
    await mkdir(outputDir, {recursive: true});
    const manifest = JSON.parse(await readFile(join(integrationDir, 'manifest.json'), 'utf8'));
    await writeFile(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const file of ['bootstrap.js', 'workspace.html', 'workspace.css']) {
        await copyFile(join(integrationDir, file), join(outputDir, file === 'bootstrap.js' ? file : `content/${file}`));
    }
    await copyFile(join(repositoryDir, 'LICENSE'), join(outputDir, 'LICENSE'));
    const pdfDir = join(repositoryDir, 'node_modules/pdfjs-dist');
    await copyFile(join(pdfDir, 'legacy/build/pdf.worker.min.mjs'), join(outputDir, 'content/pdfjs/pdf.worker.min.mjs'));
    for (const resource of ['cmaps', 'standard_fonts']) {
        await cp(join(pdfDir, resource), join(outputDir, 'content/pdfjs', resource), {recursive: true});
    }
    for (const file of PDFJS_DECODER_FILES) {
        await copyFile(join(pdfDir, 'wasm', file), join(outputDir, 'content/pdfjs/wasm', file));
    }
    await copyFile(join(pdfDir, 'LICENSE'), join(outputDir, 'content/pdfjs/LICENSE'));
    const noticesDir = join(outputDir, 'licenses');
    await mkdir(noticesDir, {recursive: true});
    await copyDependencyLicenses(noticesDir);
    const fontNotices = join(repositoryDir, 'public/third-party-notices');
    for (const file of (await readdir(fontNotices)).filter(file => file.startsWith('pdf-reading-font-') || file === 'pdf-fallback-bidi-NOTICE.txt')) {
        await copyFile(join(fontNotices, file), join(noticesDir, file));
    }
    await writeFile(join(outputDir, 'THIRD-PARTY-NOTICES.md'), [
        '# FluentRead for Zotero', '',
        'FluentRead for Zotero is independently implemented under GPL-3.0. Source: https://github.com/Bistutu/FluentRead', '',
        'Bundled dependencies retain their licenses in licenses/ and content/pdfjs/LICENSE.',
        '- Vue: MIT, https://github.com/vuejs/core',
        '- PDF.js: Apache-2.0, https://github.com/mozilla/pdf.js; CMap, standard-font and image-decoder licenses accompany those files.',
        '- bidi-js 1.1.0: MIT, https://github.com/lojjic/bidi-js; the unchanged PDF.js bidi kernel is statically extracted at build time.',
        '- pdf-lib and fontkit: MIT, https://github.com/Hopding/pdf-lib and https://github.com/Hopding/fontkit',
        '- JSZip: MIT or GPL-3.0, https://github.com/Stuk/jszip',
        '- pako: MIT and Zlib, https://github.com/nodeca/pako',
        '- saxes: ISC, https://github.com/lddubeau/saxes',
        '- tslib: 0BSD, https://github.com/microsoft/tslib', '',
        '- @noble/hashes: MIT, https://github.com/paulmillr/noble-hashes', '',
        'Optional PDF export fonts are fetched separately only when needed; their source and integrity information are in the FluentRead source.', '',
    ].join('\n'));
}

async function verify() {
    for (const file of requiredFiles) {
        const info = await stat(join(outputDir, file));
        if (!info.isFile() || info.size === 0) throw new Error(`Zotero 安装包缺少有效资源：${file}`);
    }
    const manifest = JSON.parse(await readFile(join(outputDir, 'manifest.json'), 'utf8'));
    if (!manifest.applications?.zotero?.id || !manifest.version) throw new Error('Zotero manifest 缺少应用 ID 或版本');
    const updateURL = new URL(manifest.applications.zotero.update_url ?? '');
    if (updateURL.protocol !== 'https:') throw new Error('Zotero manifest 缺少 HTTPS 更新清单地址');
    for (const file of ['bootstrap.js', 'content/native.js', 'content/workspace.js']) {
        const source = await readFile(join(outputDir, file), 'utf8');
        new Script(source, {filename: file});
        if (/\bprocess\.env\.NODE_ENV\b/u.test(source)) throw new Error(`浏览器产物残留未替换的 Node 环境变量：${file}`);
        if (/data:(?:application|text)\/javascript;base64,[A-Za-z0-9+/=]{100000}/u.test(source)) throw new Error(`不允许内联大体积 worker：${file}`);
    }
    const workspace = await readFile(join(outputDir, 'content/workspace.html'), 'utf8');
    if (!workspace.includes('workspace.js')) throw new Error('工作台页面缺少 workspace.js');
    return manifest;
}

async function main() {
    if (!process.argv.includes('--verify')) await assemble();
    const manifest = await verify();
    if (process.argv.includes('--verify')) {
        console.log(JSON.stringify({verified: true, directory: outputDir, version: manifest.version}));
        return;
    }
    const archive = new JSZip();
    for (const file of await listFiles(outputDir)) archive.file(file, await readFile(join(outputDir, file)));
    const bytes = await archive.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'});
    await writeFile(archivePath, bytes);
    console.log(JSON.stringify({archive: archivePath, bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'), version: manifest.version}));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        console.error(`[zotero-package] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}
