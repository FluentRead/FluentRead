/**
 * @file integrations/zotero/vite.config.ts
 * 文件职责：分别构建 Zotero 特权适配和独立 Vue 工作台，不走浏览器扩展入口。
 * 主要内容：固定 IIFE 全局、共享依赖和相对资源路径；PDF.js worker 由打包脚本作为本地文件复制。
 * 模块边界：只影响 Zotero 产物，不更改 WXT、浏览器扩展或 Obsidian 构建。
 */
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';
import vue from '@vitejs/plugin-vue';
import {createDeepLXRuntimeBuildPlugin} from '../../scripts/testing/deeplx-runtime-build';
import {createPdfReaderBidiBuildPlugin} from '../../scripts/testing/pdfjs-bidi-build';

const integrationDir = dirname(fileURLToPath(import.meta.url));
const repositoryDir = resolve(integrationDir, '../..');

export default defineConfig(({mode}) => {
    if (mode !== 'native' && mode !== 'workspace') throw new Error('Zotero 构建须指定 native 或 workspace 模式');
    const native = mode === 'native';
    return {
        base: './',
        publicDir: false,
        envDir: integrationDir,
        envPrefix: 'FLUENTREAD_ZOTERO_PUBLIC_',
        resolve: {alias: {'@': repositoryDir}},
        plugins: [{
            name: 'zotero-local-pdf-worker',
            enforce: 'pre',
            resolveId(source) {
                return /^pdfjs-dist\/(?:legacy\/)?build\/pdf\.worker(?:\.min)?\.mjs\?url$/u.test(source)
                    ? '\0fluentread-zotero-local-pdf-worker' : null;
            },
            load(id) {
                return id === '\0fluentread-zotero-local-pdf-worker'
                    ? 'export default "chrome://fluentread/content/pdfjs/pdf.worker.min.mjs";' : null;
            },
        }, createDeepLXRuntimeBuildPlugin(repositoryDir), createPdfReaderBidiBuildPlugin(repositoryDir), vue()],
        define: {
            'process.env.NODE_ENV': JSON.stringify('production'),
            __VUE_OPTIONS_API__: true,
            __VUE_PROD_DEVTOOLS__: false,
            __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
            'import.meta.url': JSON.stringify(`chrome://fluentread/content/${mode}.js`),
        },
        build: {
            outDir: resolve(integrationDir, 'dist/plugin'),
            emptyOutDir: native,
            target: 'es2022',
            sourcemap: false,
            cssCodeSplit: false,
            lib: {
                entry: resolve(integrationDir, `${mode}.ts`),
                name: native ? 'FluentReadZotero' : 'FluentReadZoteroWorkspace',
                formats: ['iife'],
                fileName: () => `content/${mode}.js`,
            },
            rollupOptions: {
                output: {
                    inlineDynamicImports: true,
                    assetFileNames: 'content/[name][extname]',
                    banner: '/*! FluentRead for Zotero — GPL-3.0; source: https://github.com/Bistutu/FluentRead */',
                },
            },
        },
    };
});
