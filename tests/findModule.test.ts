/**
 * @file tests/findModule.test.ts
 * 文件职责：验证零盲搜模块定位器 find-module 的文件头解析、多词加权排序、前缀过滤与增量磁盘缓存行为。
 * 主要内容：覆盖 JSDoc/HTML 注释及 shebang 文件头提取、多词全匹配优先与字段权重排序、--dir/--limit/--include-scripts 参数解析、冷热缓存命中/修改失效/删除清理与损坏缓存自愈。
 * 模块边界：仅使用内存样本与临时目录，不修改仓库真实文件或缓存。
 */
import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
    DEFAULT_MODULE_INDEX_CACHE_PATH,
    MODULE_INDEX_CACHE_VERSION,
    formatResults,
    loadModuleIndex,
    parseArguments,
    parseHeader,
    searchModules,
} from '../scripts/testing/find-module.mjs';

describe('find-module header parsing and CLI arguments', () => {
    it('extracts @file, responsibility, contents, and boundary from TS, Vue, and shebang scripts', () => {
        const tsEntry = parseHeader('src/core/glossary/protection.ts', [
            '/**',
            ' * @file src/core/glossary/protection.ts',
            ' * 文件职责：负责术语表保护占位符的替换与还原纯逻辑。',
            ' * 主要内容：',
            ' * - 匹配正文中的术语词条并替换为不可译占位符；',
            ' * - 译文回填时恢复原始术语。',
            ' * 模块边界：纯函数，不访问存储或网络。',
            ' */',
            'export const protect = () => {};',
        ].join('\n'));
        expect(tsEntry).toEqual({
            path: 'src/core/glossary/protection.ts',
            fileTag: 'src/core/glossary/protection.ts',
            responsibility: '负责术语表保护占位符的替换与还原纯逻辑。',
            contents: '匹配正文中的术语词条并替换为不可译占位符； 译文回填时恢复原始术语。',
            boundary: '纯函数，不访问存储或网络。',
            hasHeader: true,
        });

        const vueEntry = parseHeader('src/ui/GlossaryCard.vue', [
            '<!--',
            '  @file src/ui/GlossaryCard.vue',
            '  文件职责：渲染术语卡片与命中预览。',
            '  主要内容：展示词条与开关按钮。',
            '  模块边界：纯 UI 展示组件。',
            '-->',
            '<template><div/></template>',
        ].join('\n'));
        expect(vueEntry.responsibility).toBe('渲染术语卡片与命中预览。');
        expect(vueEntry.hasHeader).toBe(true);

        const scriptEntry = parseHeader('scripts/testing/tool.mjs', [
            '#!/usr/bin/env node',
            '',
            '/**',
            ' * @file scripts/testing/tool.mjs',
            ' * 覆盖率缺口定位器：把门禁失败翻译成行级清单。',
            ' * 主要内容：解析覆盖率产物。',
            ' */',
        ].join('\n'));
        expect(scriptEntry.responsibility).toBe('覆盖率缺口定位器：把门禁失败翻译成行级清单。');
        expect(scriptEntry.contents).toBe('解析覆盖率产物。');
    });

    it('parses CLI arguments and rejects empty queries or invalid flags', () => {
        expect(parseArguments(['--', 'glossary', 'protection', '--dir', 'src/core/', '--limit', '5', '--include-scripts', '--json', '--no-cache']))
            .toEqual({
                queries: ['glossary', 'protection'],
                dir: 'src/core',
                limit: 5,
                includeScripts: true,
                json: true,
                noCache: true,
                help: false,
            });
        expect(parseArguments(['--help']).help).toBe(true);
        expect(() => parseArguments([])).toThrow('必须提供至少一个检索关键词');
        expect(() => parseArguments(['foo', '--limit', '0'])).toThrow('--limit 需要正整数');
        expect(() => parseArguments(['foo', '--dir'])).toThrow('--dir 缺少值');
        expect(() => parseArguments(['foo', '--bogus'])).toThrow('未知参数');
    });
});

describe('find-module scoring and incremental disk cache', () => {
    const tempDirs: string[] = [];
    const createRepo = (files: Record<string, string>) => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'fluentread-find-module-'));
        tempDirs.push(dir);
        for (const [rel, content] of Object.entries(files)) {
            const abs = path.join(dir, rel);
            mkdirSync(path.dirname(abs), {recursive: true});
            writeFileSync(abs, content, 'utf8');
        }
        return dir;
    };

    afterEach(() => {
        for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
    });

    it('ranks multi-token matches with higher weight on path and responsibility and respects dir/limit', () => {
        const entries = [
            parseHeader('src/core/glossary/protection.ts', '/**\n * @file src/core/glossary/protection.ts\n * 文件职责：术语表保护占位符替换。\n * 主要内容：术语匹配与还原。\n * 模块边界：核心纯函数。\n */'),
            parseHeader('src/services/translation/broker.ts', '/**\n * @file src/services/translation/broker.ts\n * 文件职责：翻译调度器。\n * 主要内容：调用 glossary protection 模块。\n * 模块边界：服务层编排。\n */'),
            parseHeader('src/ui/Badge.vue', '<!--\n @file src/ui/Badge.vue\n 文件职责：状态徽章。\n 主要内容：展示状态。\n 模块边界：无状态组件，仅用于 glossary 页面。\n-->'),
        ];

        const hit = searchModules(entries, ['glossary', 'protection']);
        expect(hit.totalMatched).toBe(3);
        expect(hit.results[0].path).toBe('src/core/glossary/protection.ts');
        expect(hit.results[0].matchedTokens).toBe(2);
        expect(hit.results[1].path).toBe('src/services/translation/broker.ts');
        expect(hit.results[2].path).toBe('src/ui/Badge.vue');

        const filtered = searchModules(entries, ['glossary'], {dir: 'src/services', limit: 1});
        expect(filtered.totalIndexed).toBe(1);
        expect(filtered.results.map(item => item.path)).toEqual(['src/services/translation/broker.ts']);

        const formatted = formatResults('glossary protection', hit);
        expect(formatted).toContain('src/core/glossary/protection.ts — 术语表保护占位符替换。');
    });

    it('caches parsed headers on disk, invalidates on edit, evicts deleted files, and recovers from corrupt cache', () => {
        const root = createRepo({
            'src/core/a.ts': '/**\n * @file src/core/a.ts\n * 文件职责：解析配置规则。\n * 主要内容：读取规则。\n * 模块边界：核心层。\n */',
            'src/core/b.ts': '/**\n * @file src/core/b.ts\n * 文件职责：缓存翻译结果。\n * 主要内容：LRU 缓存。\n * 模块边界：核心层。\n */',
            'scripts/testing/helper.mjs': '#!/usr/bin/env node\n/**\n * @file scripts/testing/helper.mjs\n * 文件职责：测试辅助脚本。\n */',
        });
        const cacheFile = path.join(root, DEFAULT_MODULE_INDEX_CACHE_PATH);

        const cold = loadModuleIndex(root);
        expect(existsSync(cacheFile)).toBe(true);
        expect(cold.entries).toHaveLength(2);
        expect(cold.cacheStats.fromCache).toBe(false);
        expect(cold.cacheStats.misses).toBe(2);

        const warm = loadModuleIndex(root);
        expect(warm.cacheStats.fromCache).toBe(true);
        expect(warm.cacheStats.hits).toBe(2);
        expect(warm.cacheStats.misses).toBe(0);

        const withScripts = loadModuleIndex(root, {includeScripts: true});
        expect(withScripts.entries.map(e => e.path)).toContain('scripts/testing/helper.mjs');

        writeFileSync(
            path.join(root, 'src/core/a.ts'),
            '/**\n * @file src/core/a.ts\n * 文件职责：解析站点白名单与黑名单规则。\n * 主要内容：更新后的规则。\n * 模块边界：核心层。\n */',
            'utf8',
        );
        const edited = loadModuleIndex(root);
        expect(edited.cacheStats.misses).toBe(1);
        expect(edited.cacheStats.hits).toBe(1);
        expect(edited.entries.find(e => e.path === 'src/core/a.ts')?.responsibility).toContain('白名单');

        rmSync(path.join(root, 'src/core/b.ts'));
        const afterDelete = loadModuleIndex(root);
        expect(afterDelete.cacheStats.evicted).toBe(1);
        expect(afterDelete.entries).toHaveLength(1);

        writeFileSync(cacheFile, '{not valid json', 'utf8');
        const recovered = loadModuleIndex(root);
        expect(recovered.cacheStats.fromCache).toBe(false);
        expect(recovered.cacheStats.misses).toBe(1);
        expect(JSON.parse(readFileSync(cacheFile, 'utf8')).version).toBe(MODULE_INDEX_CACHE_VERSION);
    });
});
