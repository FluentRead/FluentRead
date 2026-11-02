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
        rollupOptions: {
            external: ['obsidian', 'electron'],
            output: {
                inlineDynamicImports: true,
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
