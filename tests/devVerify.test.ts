/**
 * @file tests/devVerify.test.ts
 * 文件职责：验证低 token 开发验证入口 dev-verify 的参数解析、流水线步骤拼装与失败摘要提取（含严格覆盖率缺口保留）。
 * 主要内容：覆盖 parseArguments 默认值与非法参数拒绝、buildSteps 常规与 --compile/--files/--all-architecture 组合、failureExcerpt 对 coverage-gaps 行级输出（语句/分支统计、编号行号、源码片段与省略提示）的完整保留与长度截断行为。
 * 模块边界：仅测试 dev-verify 的纯函数导出，不派生真实 Vitest 或 TypeScript 子进程。
 */
import {describe, expect, it} from 'vitest';
import {buildSteps, failureExcerpt, parseArguments} from '../scripts/testing/dev-verify.mjs';

describe('dev-verify CLI helpers', () => {
    it('parses CLI flags with sensible defaults and rejects invalid options', () => {
        expect(parseArguments([])).toEqual({
            base: 'origin/main',
            files: null,
            compile: false,
            allArchitecture: false,
            dryRun: false,
            failFast: true,
            continueOnError: false,
            artifactsDir: null,
            json: false,
            help: false,
        });

        expect(parseArguments([
            '--',
            '--base', 'HEAD~2',
            '--files', 'src/core/a.ts,src/core/b.ts',
            '--compile',
            '--all-architecture',
            '--dry-run',
            '--continue',
            '--artifacts-dir', 'coverage/custom',
            '--json',
        ])).toEqual({
            base: 'HEAD~2',
            files: 'src/core/a.ts,src/core/b.ts',
            compile: true,
            allArchitecture: true,
            dryRun: true,
            failFast: false,
            continueOnError: true,
            artifactsDir: 'coverage/custom',
            json: true,
            help: false,
        });

        expect(parseArguments(['--help']).help).toBe(true);
        expect(() => parseArguments(['--base'])).toThrow('--base 缺少值');
        expect(() => parseArguments(['--files', '--json'])).toThrow('--files 缺少值');
        expect(() => parseArguments(['--unknown-flag'])).toThrow('未知参数：--unknown-flag');
    });

    it('builds verification steps for base mode, explicit files, all-architecture and compile gate', () => {
        const defaultSteps = buildSteps(parseArguments([]), '/tmp/dev-verify');
        expect(defaultSteps.map(step => step.id)).toEqual(['audit', 'declarations', 'affected']);
        expect(defaultSteps[2].args).toEqual([
            'scripts/testing/run-affected-tests.mjs',
            '--base', 'origin/main',
            '--report', '/tmp/dev-verify/affected-plan.json',
            '--summary',
            '--reporter', 'dot',
        ]);

        const fullSteps = buildSteps(
            parseArguments(['--files', 'src/core/x.ts', '--all-architecture', '--compile']),
            '/tmp/dev-verify-2',
        );
        expect(fullSteps.map(step => step.id)).toEqual(['audit', 'declarations', 'affected', 'compile']);
        expect(fullSteps[2].args).toContain('--files');
        expect(fullSteps[2].args).toContain('src/core/x.ts');
        expect(fullSteps[2].args).toContain('--all-architecture');
        expect(fullSteps[2].args).not.toContain('--base');
        expect(fullSteps[3]).toMatchObject({id: 'compile', command: 'pnpm', args: ['compile']});
    });

    it('preserves full line-level coverage-gaps output inside failureExcerpt', () => {
        const tail = [
            'Running affected tests...',
            'ERROR: Coverage for branches (83.33%) does not meet global threshold (100%)',
            '[affected-tests] 严格覆盖率缺口：1 个文件未达 100%',
            '',
            '覆盖率产物：coverage/affected/coverage-final.json',
            '文件：1 个参与统计，1 个未达 100%',
            '门禁：statements 10/12  branches 4/6  functions 2/2  lines 10/12',
            '',
            '✗ src/foo.ts',
            '   语句 10/12  分支 4/6  函数 2/2  行 10/12',
            '  [1] src/foo.ts:42  branch  if 的第 2/2 个出口未走（条件为假）',
            '         42 │ if (ready) {',
            '  [2] src/foo.ts:58:12  statement  语句从未执行',
            '         58 │   return fallback();',
            '  …还有 3 处，用 --max 5 全部展开',
            '',
            '[affected-tests] 受影响测试失败：退出码 1，信号 none',
        ].join('\n');

        const excerpt = failureExcerpt(tail);
        expect(excerpt).toEqual([
            '[affected-tests] 严格覆盖率缺口：1 个文件未达 100%',
            '覆盖率产物：coverage/affected/coverage-final.json',
            '文件：1 个参与统计，1 个未达 100%',
            '门禁：statements 10/12  branches 4/6  functions 2/2  lines 10/12',
            '✗ src/foo.ts',
            '   语句 10/12  分支 4/6  函数 2/2  行 10/12',
            '  [1] src/foo.ts:42  branch  if 的第 2/2 个出口未走（条件为假）',
            '         42 │ if (ready) {',
            '  [2] src/foo.ts:58:12  statement  语句从未执行',
            '         58 │   return fallback();',
            '  …还有 3 处，用 --max 5 全部展开',
            '[affected-tests] 受影响测试失败：退出码 1，信号 none',
        ]);
    });

    it('retains coverage-gap blocks even when many noisy error lines precede them', () => {
        const noisyErrors = Array.from({length: 30}, (_, index) => `Error: noisy failure #${index + 1}`);
        const gapBlock = [
            '[affected-tests] 严格覆盖率缺口：1 个文件未达 100%',
            '✗ src/bar.ts',
            '   语句 8/9  分支 3/4  函数 1/1  行 8/9',
            '  [1] src/bar.ts:19  branch  cond-expr 的第 2/2 个出口未走（三元假值）',
            '         19 │ const mode = ok ? "fast" : "slow";',
            '  …还有 1 处，用 --max 2 全部展开',
        ];
        const excerpt = failureExcerpt([...noisyErrors, ...gapBlock].join('\n'), 18);
        expect(excerpt.length).toBeLessThanOrEqual(18);
        expect(excerpt[0]).toBe('Error: noisy failure #1');
        expect(excerpt).toContain('✗ src/bar.ts');
        expect(excerpt).toContain('  [1] src/bar.ts:19  branch  cond-expr 的第 2/2 个出口未走（三元假值）');
        expect(excerpt).toContain('         19 │ const mode = ok ? "fast" : "slow";');
        expect(excerpt).toContain('  …还有 1 处，用 --max 2 全部展开');
    });

    it('falls back to tail lines when no known pattern matches and truncates overly long lines', () => {
        const longLine = `Error: ${'x'.repeat(200)}`;
        const truncated = failureExcerpt(longLine);
        expect(truncated).toHaveLength(1);
        expect(truncated[0].length).toBe(160);
        expect(truncated[0].endsWith('...')).toBe(true);

        const plainTail = ['line 1', 'line 2', 'line 3', 'line 4'].join('\n');
        expect(failureExcerpt(plainTail, 2)).toEqual(['line 3', 'line 4']);
    });
});
