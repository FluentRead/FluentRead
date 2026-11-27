import {defineConfig} from 'vitest/config';
import {resolve} from 'node:path';
import {realpathSync} from 'node:fs';
import {searchForWorkspaceRoot} from 'vite';
import vue from '@vitejs/plugin-vue';
import {createDeepLXRuntimeBuildPlugin} from './scripts/testing/deeplx-runtime-build.ts';
import {createPdfReaderBidiBuildPlugin} from './scripts/testing/pdfjs-bidi-build.ts';
import {createReadingDictionaryAliases} from './scripts/testing/reading-annotation-build.ts';

const ROOT = import.meta.dirname;
const configuredMaxWorkers = Number(process.env.FLUENTREAD_TEST_MAX_WORKERS);
const maxWorkers = Number.isInteger(configuredMaxWorkers) && configuredMaxWorkers > 0 ? configuredMaxWorkers : 2;

/** 测试在 Node 里提供自己的 DOM。保留客户端 SFC 模板，模块加载仍由 Vitest 管理。 */
function clientVue(options: Parameters<typeof vue>[0]) {
    const plugin = vue(options);
    const load = plugin.load;
    const transform = plugin.transform;
    if (load && typeof load !== 'function') {
        plugin.load = {...load, handler(id, context) {
            return load.handler.call(this, id, {...context, ssr: false});
        }};
    }
    if (transform && typeof transform !== 'function') {
        plugin.transform = {...transform, handler(code, id, context) {
            return transform.handler.call(this, code, id, {...context, moduleType: context?.moduleType ?? 'js', ssr: false});
        }};
    }
    return plugin;
}

// 独立的 Vitest 配置（与 wxt 构建配置互不影响）
export default defineConfig({
    // worktree 可共享安装的依赖；客户端 SFC 测试须能加载其真实路径，保留默认严格文件边界。
    server: {fs: {allow: [searchForWorkspaceRoot(ROOT), realpathSync(resolve(ROOT, 'node_modules'))]}},
    // Vite 仅按需编译测试实际导入的 Vue SFC；统一匹配 /\.vue$/ 避免每次新增组件测试都修改根配置触发全量回归。
    plugins: [{name: 'obsidian-test-api', enforce: 'pre',
        // npm 包只发布类型；测试须显式 mock 应用端口，禁止落到真实 Obsidian 环境。
        resolveId: (id) => id === 'obsidian' ? '\0fluentread-test-obsidian' : null,
        load: (id) => id === '\0fluentread-test-obsidian' ? 'throw new Error("Obsidian application API must be mocked in tests"); export {};' : null,
    }, createDeepLXRuntimeBuildPlugin(ROOT), createPdfReaderBidiBuildPlugin(ROOT), clientVue({include: /\.vue$/u})],
    resolve: {
        alias: [
            // 与 wxt 一致：'@' 指向项目根目录
            {find: '@', replacement: resolve(ROOT, '.')},
            ...createReadingDictionaryAliases(ROOT),
        ],
    },
    test: {
        environment: 'node',
        // 对已发布 core 执行同一 transport/browser 替换，避免 Node 外置依赖绕过插件。
        server: {deps: {inline: ['@deeplx/core']}},
        include: ['tests/**/*.test.ts'],
        globalSetup: ['./scripts/testing/vitest-resource-lock.mjs'],
        maxWorkers,
        clearMocks: false,
        // 单 worker（如 CI）保持严格串行；多 worker 时启用文件级并行，避免闲置已分配 worker。
        fileParallelism: maxWorkers > 1,
        // 页内样式契约执行实际 CSS，避免空 inline 样式掩盖命名、对比度或所有权回归。
        css: {include: [/(?:src\/app\/content\/page|src\/ui\/styles\/(?:translation-display|translation-loading-indicator|bilingual-sentence-highlight|vocabulary-reencounter)|src\/features\/image-translation\/ui\/image-(?:text-reader|controls))\.css(?:\?|$)/]},
    },
});
