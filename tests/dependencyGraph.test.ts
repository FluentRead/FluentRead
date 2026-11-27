/**
 * @file tests/dependencyGraph.test.ts
 * 文件职责：验证 AST 精确依赖图引擎、按符号 barrel 解析、定向运行器与低 token 开发验证入口的行为契约。
 * 主要内容：覆盖纯类型导入剔除、纯 barrel 按符号与通配传播、注册表数据隔离、常量折叠模板路径、断言/脚手架字面量过滤、test-for 参数与计划选择、dev-verify 步骤拼装以及 .d.mts 声明一致性检查。
 * 模块边界：仅使用内存图与纯参数解析，不启动真实浏览器或修改仓库文件。
 */
import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
    DEFAULT_DEP_GRAPH_CACHE_PATH,
    DEP_GRAPH_CACHE_VERSION,
    analyzeDependencyGraph,
    analyzeProjectDependencyGraph,
    collectAffectedClosure,
    explainDependencies,
} from '../scripts/testing/dependency-graph.mjs';
import {parseArguments as parseTestForArgs} from '../scripts/testing/test-for.mjs';
import {buildSteps as buildDevVerifySteps, parseArguments as parseDevVerifyArgs} from '../scripts/testing/dev-verify.mjs';
import {comparePair} from '../scripts/testing/check-module-declarations.mjs';

describe('precision AST dependency graph engine', () => {
    it('excludes type-only imports and exports from runtime test propagation', () => {
        const files = {
            'src/core/types.ts': 'export interface Shape { id: string; }',
            'src/core/value.ts': "import type {Shape} from './types'; export const make = (s: Shape) => s.id;",
            'src/core/mixed.ts': "import {type Shape} from './types'; import {make} from './value'; export const run = (s: Shape) => make(s);",
            'tests/mixed.test.ts': "import {run} from '@/src/core/mixed';",
        };
        const {reverse} = analyzeDependencyGraph(files);
        expect([...collectAffectedClosure(reverse, ['src/core/types.ts'])]).toEqual(['src/core/types.ts']);
        expect([...collectAffectedClosure(reverse, ['src/core/value.ts'])].sort()).toEqual([
            'src/core/mixed.ts',
            'src/core/value.ts',
            'tests/mixed.test.ts',
        ]);
    });

    it('resolves pure re-export barrels per imported symbol without waking unrelated sibling consumers', () => {
        const files = {
            'src/core/sample-barrel/match.ts': 'export const matchTerm = () => true;',
            'src/core/sample-barrel/transfer.ts': 'export const exportGlossary = () => "";',
            'src/core/sample-barrel/index.ts': "export {matchTerm} from './match';\nexport {exportGlossary} from './transfer';",
            'tests/match.test.ts': "import {matchTerm} from '@/src/core/sample-barrel';",
            'tests/transfer.test.ts': "import {exportGlossary} from '@/src/core/sample-barrel';",
            'tests/all.test.ts': "import * as glossary from '@/src/core/sample-barrel';",
        };
        const {reverse, barrels} = analyzeDependencyGraph(files);
        expect(barrels.has('src/core/sample-barrel/index.ts')).toBe(true);

        const transferImpact = [...collectAffectedClosure(reverse, ['src/core/sample-barrel/transfer.ts'])].sort();
        expect(transferImpact).toContain('tests/transfer.test.ts');
        expect(transferImpact).toContain('tests/all.test.ts');
        expect(transferImpact).not.toContain('tests/match.test.ts');

        const matchImpact = [...collectAffectedClosure(reverse, ['src/core/sample-barrel/match.ts'])].sort();
        expect(matchImpact).toContain('tests/match.test.ts');
        expect(matchImpact).toContain('tests/all.test.ts');
        expect(matchImpact).not.toContain('tests/transfer.test.ts');

        // 修改 barrel 自身仍影响所有导入该 barrel 的消费者。
        const barrelImpact = [...collectAffectedClosure(reverse, ['src/core/sample-barrel/index.ts'])];
        expect(barrelImpact).toContain('tests/match.test.ts');
        expect(barrelImpact).toContain('tests/transfer.test.ts');
        expect(barrelImpact).toContain('tests/all.test.ts');
    });

    it('isolates registry data files so they never bridge unrelated source modules to infrastructure tests', () => {
        const files = {
            'src/core/leaf.ts': 'export const leaf = 1;',
            'tests/config/vitest.coverage.config.ts': "export default {test:{coverage:{include:['src/core/leaf.ts']}}};",
            'tests/test-matrix.json': JSON.stringify({groups: {unit: ['tests/leaf.test.ts', 'tests/config.test.ts']}}),
            'tests/leaf.test.ts': "import {leaf} from '@/src/core/leaf';",
            'tests/config.test.ts': "import cfg from './config/vitest.coverage.config'; const m = 'tests/test-matrix.json';",
        };
        const {reverse} = analyzeDependencyGraph(files);
        const leafImpact = [...collectAffectedClosure(reverse, ['src/core/leaf.ts'])].sort();
        expect(leafImpact).toEqual(['src/core/leaf.ts', 'tests/leaf.test.ts']);

        // 注册表文件自身改动时，读取它的基础设施测试仍被精确选中。
        const configImpact = [...collectAffectedClosure(reverse, ['tests/config/vitest.coverage.config.ts'])];
        expect(configImpact).toContain('tests/config.test.ts');
    });

    it('folds top-level const folder prefixes into exact template targets and ignores matcher/scaffold strings', () => {
        const files = {
            'src/features/settings/ui/Panel.vue': '<template><div/></template>',
            'src/features/settings/ui/Other.vue': '<template><div/></template>',
            'scripts/testing/helper.mjs': 'export const helper = 1;',
            'tests/panel.test.ts': "const folder = 'src/features/settings/ui/'; const target = `${folder}Panel.vue`;",
            'tests/contract.test.ts': "expect(src).not.toContain('@/src/features/'); mkdirSync(path.join(tmp, 'scripts/testing'));",
        };
        const {reverse, known} = analyzeDependencyGraph(files);
        expect([...collectAffectedClosure(reverse, ['src/features/settings/ui/Panel.vue'])]).toContain('tests/panel.test.ts');
        expect([...collectAffectedClosure(reverse, ['src/features/settings/ui/Other.vue'])]).not.toContain('tests/panel.test.ts');
        expect([...collectAffectedClosure(reverse, ['src/features/settings/ui/Other.vue'])]).not.toContain('tests/contract.test.ts');
        expect([...collectAffectedClosure(reverse, ['scripts/testing/helper.mjs'])]).not.toContain('tests/contract.test.ts');

        const explained = explainDependencies('tests/panel.test.ts', files['tests/panel.test.ts'], known, files);
        expect(explained).toEqual([
            {reference: 'src/features/settings/ui/Panel.vue', via: 'file-read', files: ['src/features/settings/ui/Panel.vue']},
        ]);
    });
});

describe('developer workflow CLI helpers', () => {
    it('parses test-for arguments and rejects empty or unknown options', () => {
        expect(parseTestForArgs(['--', 'src/core/glossary/', '--dry-run', '--coverage', '--include-arch', '-t', 'barrel']))
            .toMatchObject({targets: ['src/core/glossary/'], dryRun: true, coverage: true, includeArch: true, reporter: 'dot', testNamePattern: 'barrel'});
        expect(() => parseTestForArgs([])).toThrow('必须提供至少一个');
        expect(() => parseTestForArgs(['--bogus'])).toThrow('未知参数');
        expect(() => parseTestForArgs(['src/core', '--reporter'])).toThrow('缺少值');
    });

    it('builds dev-verify pipeline steps with compact summary and optional compile gate', () => {
        const baseOptions = parseDevVerifyArgs(['--base', 'HEAD~1']);
        expect(buildDevVerifySteps(baseOptions, '/tmp/verify').map(step => step.id))
            .toEqual(['audit', 'declarations', 'affected']);
        const fullOptions = parseDevVerifyArgs(['--files', 'src/core/a.ts', '--compile', '--all-architecture']);
        const steps = buildDevVerifySteps(fullOptions, '/tmp/verify');
        expect(steps.map(step => step.id)).toEqual(['audit', 'declarations', 'affected', 'compile']);
        expect(steps[2].args).toContain('--files');
        expect(steps[2].args).toContain('--all-architecture');
        expect(steps[2].args).toContain('--summary');
    });

    it('detects missing runtime exports and extra value declarations in paired .d.mts files while ignoring type re-exports', () => {
        const result = comparePair(
            'export function a() {} export const b = 1;',
            'export type Helper = string; export type {SharedType} from "./other.mjs"; export {type InlineType} from "./other.mjs"; export function a(): void; export const ghost: number;',
            'sample.mjs',
        );
        expect(result).toEqual({missing: ['b'], extra: ['ghost']});
    });
});

describe('incremental disk cache for project dependency graph', () => {
    const tempDirs: string[] = [];
    const makeProject = (files: Record<string, string>) => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'fluentread-dep-cache-'));
        tempDirs.push(dir);
        for (const [rel, content] of Object.entries(files)) {
            const abs = path.join(dir, rel);
            mkdirSync(path.dirname(abs), {recursive: true});
            writeFileSync(abs, content, 'utf8');
        }
        return dir;
    };
    const normalizeMap = (map: Map<string, Set<string>>) => Object.fromEntries(
        [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, [...v].sort()]),
    );

    afterEach(() => {
        for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
    });

    it('matches uncached analyzeDependencyGraph bit-for-bit across cold run, warm hit, edit invalidation, deletion eviction, and corrupt fallback', () => {
        const initialFiles: Record<string, string> = {
            'src/core/a.ts': 'export const a = 1;',
            'src/core/b.ts': 'export const b = 2;',
            'src/core/index.ts': "export {a} from './a';\nexport {b} from './b';",
            'src/ui/card.css': '@import "./base.css";',
            'src/ui/base.css': '.card { display: block; }',
            'tests/a.test.ts': "import {a} from '@/src/core';",
            'tests/b.test.ts': "import {b} from '@/src/core';",
            'tests/card.test.ts': "import '../src/ui/card.css';",
            'tests/fixtures/sample.html': '<p>fixture</p>',
        };
        const root = makeProject(initialFiles);
        const cacheFile = path.join(root, DEFAULT_DEP_GRAPH_CACHE_PATH);

        const pure = analyzeDependencyGraph(initialFiles);
        const cold = analyzeProjectDependencyGraph(root);

        expect(existsSync(cacheFile)).toBe(true);
        expect(cold.cacheStats.fromCache).toBe(false);
        expect(cold.cacheStats.hits).toBe(0);
        expect(cold.cacheStats.misses).toBe(8);
        expect(normalizeMap(cold.graph)).toEqual(normalizeMap(pure.graph));
        expect(normalizeMap(cold.reverse)).toEqual(normalizeMap(pure.reverse));
        expect([...cold.barrels].sort()).toEqual([...pure.barrels].sort());

        const warm = analyzeProjectDependencyGraph(root);
        expect(warm.cacheStats.fromCache).toBe(true);
        expect(warm.cacheStats.hits).toBe(8);
        expect(warm.cacheStats.misses).toBe(0);
        expect(normalizeMap(warm.graph)).toEqual(normalizeMap(pure.graph));
        expect(normalizeMap(warm.reverse)).toEqual(normalizeMap(pure.reverse));
        expect([...warm.barrels].sort()).toEqual([...pure.barrels].sort());

        // Edit a single file and verify only that file misses cache while graph updates accurately.
        const updatedTest = "import {a, b} from '@/src/core';\nexport const touched = true;";
        writeFileSync(path.join(root, 'tests/a.test.ts'), updatedTest, 'utf8');
        const edited = analyzeProjectDependencyGraph(root);
        expect(edited.cacheStats.misses).toBe(1);
        expect(edited.cacheStats.hits).toBe(7);
        const pureEdited = analyzeDependencyGraph({...initialFiles, 'tests/a.test.ts': updatedTest});
        expect(normalizeMap(edited.graph)).toEqual(normalizeMap(pureEdited.graph));
        expect(normalizeMap(edited.reverse)).toEqual(normalizeMap(pureEdited.reverse));

        // Delete a file and verify cache eviction.
        rmSync(path.join(root, 'tests/b.test.ts'));
        const afterDelete = analyzeProjectDependencyGraph(root);
        expect(afterDelete.cacheStats.evicted).toBe(1);
        expect(afterDelete.known.has('tests/b.test.ts')).toBe(false);
        const cachedJson = JSON.parse(readFileSync(cacheFile, 'utf8'));
        expect(cachedJson.version).toBe(DEP_GRAPH_CACHE_VERSION);
        expect(cachedJson.entries['tests/b.test.ts']).toBeUndefined();

        // Corrupt the cache file and verify graceful fallback + rewrite.
        writeFileSync(cacheFile, '{corrupt json', 'utf8');
        const recovered = analyzeProjectDependencyGraph(root);
        expect(recovered.cacheStats.fromCache).toBe(false);
        expect(recovered.cacheStats.misses).toBe(7);
        expect(recovered.cacheStats.hits).toBe(0);
        expect(JSON.parse(readFileSync(cacheFile, 'utf8')).version).toBe(DEP_GRAPH_CACHE_VERSION);
    });
});
