import {copyFileSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {defineConfig} from 'vite';
import {createDeepLXRuntimeBuildPlugin} from '../../scripts/testing/deeplx-runtime-build';
import {createPdfReaderBidiBuildPlugin} from '../../scripts/testing/pdfjs-bidi-build';

const integrationDir = dirname(fileURLToPath(import.meta.url));
const repositoryDir = resolve(integrationDir, '../..');
const outputDir = resolve(integrationDir, 'dist');
const pdfLicense = readFileSync(resolve(repositoryDir, 'node_modules/pdfjs-dist/LICENSE'), 'utf8');
const bidiLicense = readFileSync(resolve(repositoryDir, 'node_modules/bidi-js/LICENSE.txt'), 'utf8');

export default defineConfig({
    publicDir: false,
    resolve: {alias: {'@': repositoryDir}},
    plugins: [createDeepLXRuntimeBuildPlugin(repositoryDir), createPdfReaderBidiBuildPlugin(repositoryDir), {
        name: 'obsidian-pdfjs-node-fallback',
        transform(source, id) {
            if (!/\/pdfjs-dist\/legacy\/build\/pdf\.mjs$/u.test(id.replaceAll('\\', '/'))) return null;
            // Obsidian 桌面 CJS 已提供绝对文件名。PDF.js 的 Node 回退需要绝对路径，
            // 在浏览器渲染进程不会执行该分支，也不会新增对 Node 模块的顶层加载。
            const code = source.replaceAll('.createRequire(import.meta.url)', '.createRequire(__filename)');
            return code === source ? null : {code, map: null};
        },
    }, {
        name: 'copy-obsidian-manifest',
        closeBundle() {
            copyFileSync(resolve(integrationDir, 'manifest.json'), resolve(outputDir, 'manifest.json'));
        },
    }],
    build: {
        outDir: outputDir,
        emptyOutDir: true,
        target: 'es2022',
        lib: {
            entry: resolve(integrationDir, 'main.ts'),
            formats: ['cjs'],
            fileName: () => 'main.js',
        },
        rolldownOptions: {
            external: ['obsidian', 'electron'],
            output: {
                codeSplitting: false,
                banner: `/*!
FluentRead Translation for Obsidian is licensed under GPL-3.0; source: https://github.com/FluentRead/FluentRead
This bundle includes PDF.js, Copyright 2024 Mozilla Foundation, licensed under Apache-2.0.
${pdfLicense}
The unchanged PDF.js pure bidi module is extracted at build time; no worker is launched for the compatibility check.
This bundle includes bidi-js 1.1.0, Jason Johnston, licensed under MIT.
${bidiLicense}
*/`,
            },
        },
    },
});
