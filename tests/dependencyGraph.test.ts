/**
 * @file tests/dependencyGraph.test.ts
 * 文件职责：验证 AST 精确依赖图引擎、按符号 barrel 解析、定向运行器与低 token 开发验证入口的行为契约。
 * 主要内容：覆盖纯类型导入剔除、纯 barrel 按符号与通配传播、注册表数据隔离、常量折叠模板路径、断言/脚手架字面量过滤、test-for 参数与计划选择、dev-verify 步骤拼装以及 .d.mts 声明一致性检查。
 * 模块边界：仅使用内存图与纯参数解析，不启动真实浏览器或修改仓库文件。
 */
import {describe, expect, it} from 'vitest';
import {
    analyzeDependencyGraph,
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
