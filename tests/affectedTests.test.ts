import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {buildDependencyGraph, changedPaths, coverageRuntimeSignature, createPlan, executePlan, scopedCoverageConfig, selectAffected,
    strictCoveragePaths, testInvocation} from '../scripts/testing/run-affected-tests.mjs';

const temporary: string[] = [];
const matrix = {groups: {architecture: ['tests/architecture/boundary.test.ts'], unit: ['tests/a.test.ts'],
    functional: ['tests/b.test.ts'], regression: ['tests/fixture.test.ts']}};
function files(): Record<string, string> {
    return {'src/core/a.ts': 'export const a = 1;', 'src/services/b.ts': "export {a} from '@/src/core/a';",
        'src/unrelated.ts': 'export const unrelated = 1;',
        'tests/a.test.ts': "import {a} from '@/src/core/a';",
        'tests/b.test.ts': "const b = await import('../src/services/b');",
        'tests/fixture.test.ts': "readFileSync(new URL('./fixtures/sample.html', import.meta.url));",
        'tests/fixtures/sample.html': '<p>Example</p>', 'tests/architecture/boundary.test.ts': ''};
}
function select(changed: string[], input = files(), coveragePaths = ['src/core/a.ts']) {
    return selectAffected({files: input, changed, matrix, coveragePaths});
}
function directory() {const root = mkdtempSync(path.join(os.tmpdir(), 'fluentread-affected-'));temporary.push(root);return root;}
function save(root: string, file: string, value: string) {
    mkdirSync(path.dirname(path.join(root, file)), {recursive: true});writeFileSync(path.join(root, file), value);
}
function git(root: string, ...args: string[]) {return execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();}
afterEach(() => {temporary.splice(0).forEach(root => rmSync(root, {recursive: true, force: true}));});

describe('affected behavior test planning', () => {
    it('traces direct and transitive imports with one always-run architecture gate and no unrelated behavior', () => {
        expect(select(['src/core/a.ts'])).toMatchObject({testFiles: ['tests/a.test.ts', 'tests/architecture/boundary.test.ts', 'tests/b.test.ts'],
            coverageFiles: ['src/core/a.ts'], reason: 'changed-dependency-graph', extensionChanged: true});
        expect(select(['src/unrelated.ts']).testFiles).toEqual(['tests/architecture/boundary.test.ts']);
    });
    it('tracks actual SFC reads and embedded source imports used by the existing component harnesses', () => {
        const input = {...files(), 'src/ui/Card.vue': '<script setup>import {a} from "../core/a";</script>',
            'tests/b.test.ts': "const filename = 'src/ui/Card.vue'; readFileSync(filename);"};
        expect(select(['src/core/a.ts'], input).testFiles).toEqual(['tests/a.test.ts', 'tests/architecture/boundary.test.ts', 'tests/b.test.ts']);
    });
    it('tracks fixtures, query suffixes, CSS imports and folder readers', () => {
        const input = {...files(), 'src/ui.css': '@import "./base.css";', 'src/base.css': 'p {color: red;}',
            'tests/b.test.ts': "import css from '../src/ui.css?inline'; const folder = './fixtures';"};
        expect(select(['src/base.css'], input, []).testFiles).toEqual(['tests/architecture/boundary.test.ts', 'tests/b.test.ts']);
        expect(select(['tests/fixtures/sample.html'], input, []).testFiles).toEqual(['tests/architecture/boundary.test.ts', 'tests/b.test.ts', 'tests/fixture.test.ts']);
    });
    it.each([
        ['relative URL', "readFileSync(new URL(`./fixtures/articles/${name}.html`, import.meta.url))"],
        ['root alias', "import(`@/tests/fixtures/articles/${name}.html?raw`)"],
        ['root path', "readFileSync(`tests/fixtures/articles/${name}.html`)"],
        ['filename prefix and several substitutions', "readFileSync(`./fixtures/articles/page-${language}-${id}.html`)"],
        ['concatenated directory', "readFileSync('./fixtures/articles/' + name + '.html')"],
        ['template with a dynamic query', "import(`./fixtures/articles/${name}.html?variant=${variant}`)"],
    ])('bounds dynamic %s to its declared fixture directory', (_variant, reader) => {
        const input = {...files(), 'tests/fixture.test.ts': reader,
            'tests/fixtures/articles/page-en-one.html': '', 'tests/fixtures/articles/page-en-one.json': '',
            'tests/fixtures/other/page-en-one.html': ''};
        expect(select(['tests/fixtures/articles/page-en-one.html'], input, []).testFiles)
            .toEqual(['tests/architecture/boundary.test.ts', 'tests/fixture.test.ts']);
        expect(select(['tests/fixtures/other/page-en-one.html'], input, []).testFiles)
            .toEqual(['tests/architecture/boundary.test.ts']);
        if (!reader.includes(' + ')) {
            expect(select(['tests/fixtures/articles/page-en-one.json'], input, []).testFiles)
                .toEqual(['tests/architecture/boundary.test.ts']);
        }
    });
    it('retains renamed and deleted dynamic fixture dependencies without widening to unrelated paths', () => {
        const reader = 'readFileSync(new URL(`./fixtures/articles/${name}.html`, import.meta.url))';
        const input = {...files(), 'tests/fixture.test.ts': reader, 'tests/fixtures/articles/renamed.html': ''};
        expect(select(['tests/fixtures/articles/old.html', 'tests/fixtures/articles/renamed.html'], input, []).testFiles)
            .toEqual(['tests/architecture/boundary.test.ts', 'tests/fixture.test.ts']);
        expect(select(['tests/fixtures/articles/deleted.html'], input, []).testFiles)
            .toEqual(['tests/architecture/boundary.test.ts', 'tests/fixture.test.ts']);
        expect(select(['tests/fixtures/articles-other/old.html'], input, []).testFiles)
            .toEqual(['tests/architecture/boundary.test.ts']);
    });
    it('keeps the real Defuddle consumer selected for page-context input changes', () => {
        const reader = 'tests/pageContextDefuddle.test.ts', fixture = 'tests/fixtures/page-context/semantic-elements.html';
        const actualMatrix = JSON.parse(readFileSync('tests/test-matrix.json', 'utf8'));
        const fixturePaths = readdirSync('tests/fixtures/page-context').map(name => `tests/fixtures/page-context/${name}`);
        const sources: Record<string, string> = {...Object.fromEntries(fixturePaths.map(file => [file, ''])),
            [reader]: readFileSync(reader, 'utf8'), 'tests/fixtures/unrelated.html': ''};
        const plan = (changed: string[], input = sources) => selectAffected({files: input, changed, matrix: actualMatrix, coveragePaths: []});
        expect(plan([fixture]).testFiles).toEqual([reader]);
        const removed = {...sources};delete removed[fixture];
        expect(plan([fixture], removed).testFiles).toEqual([reader]);
        expect(plan([fixture, 'tests/fixtures/page-context/renamed.html'], removed).testFiles).toEqual([reader]);
        expect(plan(['tests/fixtures/unrelated.html']).testFiles).toEqual([]);
    });
    it('does not evaluate template expressions or turn unbounded roots into all-source dependencies', () => {
        const graph = buildDependencyGraph({'src/core/a.ts': '', 'tests/fixtures/a.html': '', 'tests/fixture.test.ts':
            'const a = `src/${globalThis.untrusted()}.ts`; const b = `./${name}.html`; const c = `https://host/${name}`;'});
        expect([...graph.get('tests/fixture.test.ts')!]).toEqual([]);
    });
    it('preserves deleted module references while never running deleted test files', () => {
        const input = files();delete input['src/core/a.ts'];
        expect(select(['src/core/a.ts'], input).testFiles).toEqual(['tests/a.test.ts', 'tests/architecture/boundary.test.ts', 'tests/b.test.ts']);
        expect(select(['src/core/a.ts'], input).coverageFiles).toEqual([]);
        delete input['tests/a.test.ts'];
        expect(select(['tests/a.test.ts'], input, []).testFiles).toEqual(['tests/architecture/boundary.test.ts']);
        delete input['tests/architecture/boundary.test.ts'];
        expect(select(['tests/architecture/boundary.test.ts'], input, []).testFiles).toEqual([]);
    });
    it('runs changed tests themselves and recognizes docs-only changes without production builds', () => {
        expect(select(['tests/b.test.ts']).testFiles).toEqual(['tests/architecture/boundary.test.ts', 'tests/b.test.ts']);
        expect(select(['docs/testing.md'])).toMatchObject({testFiles: ['tests/architecture/boundary.test.ts'], coverageFiles: [], extensionChanged: false});
    });
    it.each(['integrations/obsidian/main.ts', 'integrations/zotero/vite.config.ts', 'scripts/safari/package.mjs'])
    ('keeps production builds required when only %s changes', file => {
        expect(select([file])).toMatchObject({testFiles: ['tests/architecture/boundary.test.ts'], extensionChanged: true});
    });
    it('explicitly widens behavior scope when shared test configuration changes', () => {
        expect(select(['vitest.config.ts'])).toMatchObject({testFiles: ['tests/a.test.ts', 'tests/architecture/boundary.test.ts', 'tests/b.test.ts', 'tests/fixture.test.ts'],
            coverageFiles: [], globalInputs: ['vitest.config.ts'], reason: 'shared-test-configuration'});
    });
    it('rejects duplicated classification and changed covered code without traceable behavior tests', () => {
        expect(() => selectAffected({files: files(), changed: [], matrix: {groups: {unit: ['tests/a.test.ts'], functional: ['tests/a.test.ts']}}, coveragePaths: []})).toThrow('重复归类');
        expect(() => select(['src/unrelated.ts'], files(), ['src/unrelated.ts'])).toThrow('没有可追踪行为测试');
    });
    it('resolves barrel index files and ignores external packages and unresolved dynamic paths', () => {
        const graph = buildDependencyGraph({'src/core/index.ts': 'export {}', 'tests/a.test.ts':
            "import a from '../src/core'; import v from 'vue'; const dynamic = `src/${name}.ts`;"});
        expect([...graph.get('tests/a.test.ts')!]).toEqual(['src/core/index.ts']);
    });
    it('reads the strict coverage literal regardless of base configuration spread', () => {
        expect(strictCoveragePaths("export default defineConfig({...base,test:{...base.test,coverage:{include:['src/a.ts','src/a.ts']}}});")).toEqual(['src/a.ts']);
        expect(() => strictCoveragePaths('export default {test:{coverage:{include:dynamic}}}')).toThrow('显式源码路径');
        expect(() => strictCoveragePaths('export default {}')).toThrow('未找到');
    });
    it('keeps newly registered coverage paths targeted while execution policy changes widen scope', () => {
        const config = (include: string, branches = 100) => `export default {test:{include:['tests/a.test.ts'],coverage:{include:[${include}],thresholds:{branches:${branches}}}}}`;
        expect(coverageRuntimeSignature(config("'src/a.ts'"))).toBe(coverageRuntimeSignature(config("'src/a.ts','src/b.ts'")));
        expect(coverageRuntimeSignature(config("'src/a.ts'", 90))).not.toBe(coverageRuntimeSignature(config("'src/a.ts'")));
        expect(select(['tests/test-matrix.json', 'vitest.coverage.config.ts', 'tests/b.test.ts']).testFiles).toEqual(['tests/architecture/boundary.test.ts', 'tests/b.test.ts']);
        expect(selectAffected({files: files(), changed: ['vitest.coverage.config.ts'], matrix,
            coveragePaths: ['src/core/a.ts'], coverageAdded: ['src/core/a.ts']})).toMatchObject({
            testFiles: ['tests/a.test.ts', 'tests/architecture/boundary.test.ts', 'tests/b.test.ts'], coverageFiles: ['src/core/a.ts']});
    });
    it('uses an actual Git diff, including deletion and untracked new tests, without evaluating ref text in a shell', () => {
        const root = directory();git(root, 'init', '-q');git(root, 'config', 'user.email', 'fixture@example.test');git(root, 'config', 'user.name', 'Fixture');
        save(root, 'src/core/a.ts', 'export const a = 1;');git(root, 'add', '.');git(root, 'commit', '-qm', 'baseline');
        const base = git(root, 'rev-parse', 'HEAD');rmSync(path.join(root, 'src/core/a.ts'));save(root, 'tests/new.test.ts', 'export {}');
        expect(changedPaths(root, base)).toEqual({base, paths: ['src/core/a.ts', 'tests/new.test.ts']});
        expect(() => changedPaths(root, '--help')).toThrow('有效的 Git 基线');
    });
    it('creates a scoped plan from real tracked files and a committed baseline', () => {
        const root = directory();git(root, 'init', '-q');git(root, 'config', 'user.email', 'fixture@example.test');git(root, 'config', 'user.name', 'Fixture');
        for (const [file, source] of Object.entries(files())) save(root, file, source);
        save(root, 'tests/test-matrix.json', JSON.stringify(matrix));
        save(root, 'vitest.coverage.config.ts', "export default {test:{coverage:{include:['src/core/a.ts']}}}");
        git(root, 'add', '.');git(root, 'commit', '-qm', 'baseline');const base = git(root, 'rev-parse', 'HEAD');
        save(root, 'src/core/a.ts', 'export const a = 2;');
        expect(createPlan(root, base)).toMatchObject({base, head: base, changed: ['src/core/a.ts'],
            testFiles: ['tests/a.test.ts', 'tests/architecture/boundary.test.ts', 'tests/b.test.ts'], coverageFiles: ['src/core/a.ts']});
    });
    it('reads integration source dependencies from real Git files so shared changes select their actual consumers', () => {
        const root = directory();git(root, 'init', '-q');git(root, 'config', 'user.email', 'fixture@example.test');git(root, 'config', 'user.name', 'Fixture');
        save(root, 'src/provider.ts', 'export const provider = 1;');
        save(root, 'integrations/obsidian/gateway.ts', "export {provider} from '../../src/provider';");
        save(root, 'integrations/obsidian/main.ts', "export {provider} from './gateway';");
        save(root, 'integrations/other/main.ts', 'export const other = 1;');
        save(root, 'tests/consumer.test.ts', "import {provider} from '../integrations/obsidian/main';");
        save(root, 'tests/unrelated.test.ts', "import {other} from '../integrations/other/main';");
        save(root, 'tests/test-matrix.json', JSON.stringify({groups: {unit: ['tests/consumer.test.ts', 'tests/unrelated.test.ts']}}));
        save(root, 'vitest.coverage.config.ts', 'export default {test:{coverage:{include:[]}}}');
        git(root, 'add', '.');git(root, 'commit', '-qm', 'integration baseline');const base = git(root, 'rev-parse', 'HEAD');
        save(root, 'src/provider.ts', 'export const provider = 2;');
        expect(createPlan(root, base)).toMatchObject({testFiles: ['tests/consumer.test.ts'], extensionChanged: true});
        git(root, 'checkout', '--', 'src/provider.ts');
        save(root, 'integrations/obsidian/gateway.ts', "export {provider} from '../../src/provider'; export const changed = true;");
        expect(createPlan(root, base)).toMatchObject({testFiles: ['tests/consumer.test.ts'], extensionChanged: true});
    });
    it('tracks actual root asset readers and builds even when an unrelated asset has no behavior reader', () => {
        const root = directory();git(root, 'init', '-q');git(root, 'config', 'user.email', 'fixture@example.test');git(root, 'config', 'user.name', 'Fixture');
        const asset = 'assets/optional/dictionary.json', unrelated = 'assets/interface-fonts/preview.woff2';
        save(root, asset, '["before"]');save(root, unrelated, 'font-before');
        save(root, 'tests/asset.test.ts', `import {readFileSync} from 'node:fs';import {resolve} from 'node:path';
            const dictionary = JSON.parse(readFileSync(resolve(process.cwd(), '${asset}'), 'utf8'));`);
        save(root, 'tests/test-matrix.json', JSON.stringify({groups: {regression: ['tests/asset.test.ts']}}));
        save(root, 'vitest.coverage.config.ts', 'export default {test:{coverage:{include:[]}}}');
        git(root, 'add', '.');git(root, 'commit', '-qm', 'asset baseline');const base = git(root, 'rev-parse', 'HEAD');
        save(root, asset, '["after"]');
        expect(createPlan(root, base)).toMatchObject({changed: [asset], testFiles: ['tests/asset.test.ts'],
            coverageFiles: [], extensionChanged: true});
        // Vue/CSS 原文也支持根资源路径，资源本身的二进制字节无需进入解析图。
        const graph = buildDependencyGraph({'src/ui/Font.vue': `<template><img src="${asset}" /></template>`, [asset]: ''});
        expect([...graph.get('src/ui/Font.vue')!]).toEqual([asset]);
        git(root, 'checkout', '--', asset);save(root, unrelated, 'font-after');
        expect(createPlan(root, base)).toMatchObject({changed: [unrelated], testFiles: [],
            coverageFiles: [], extensionChanged: true});
    });
    it('keeps the actual matrix runtime consumers of all thirteen coverage targets in one architecture and behavior pass', () => {
        const readers = {
            'src/app/background/handlers/configPersistence.ts': 'tests/backgroundConfigPersistenceHandler.test.ts',
            'src/app/background/handlers/configStorage.ts': 'tests/backgroundConfigStorage.test.ts',
            'src/app/background/handlers/translation.ts': 'tests/backgroundTranslationHandler.test.ts',
            'src/app/background/harnessRuntime.ts': 'tests/harnessAppRuntime.test.ts',
            'src/services/messaging/backgroundRouter.ts': 'tests/backgroundMessageRouter.test.ts',
            'src/app/background/handlers/configHistory.ts': 'tests/backgroundCoreHandlers.test.ts',
            'src/app/background/handlers/connectionTest.ts': 'tests/backgroundConnectionTestHandler.test.ts',
            'src/app/background/providerRuntime.ts': 'tests/backgroundProviderRuntime.test.ts',
            'src/app/background/chatgptPlanRuntime.ts': 'tests/chatgptPlanBridgeClient.test.ts',
            'src/app/background/handlers/freeTranslationWeights.ts': 'tests/freeTranslationWeightsHandler.test.ts',
            'src/app/background/handlers/translationCache.ts': 'tests/backgroundCoreHandlers.test.ts',
            'src/services/translation/broker.ts': 'tests/compositeTranslationBroker.test.ts',
            'src/services/translation/visionProbe.ts': 'tests/backgroundVisionProbe.test.ts',
        };
        const actualMatrix = JSON.parse(readFileSync('tests/test-matrix.json', 'utf8'));
        const targets = Object.keys(readers);
        const paths: string[] = [...new Set([...targets, ...actualMatrix.groups.architecture, ...Object.values(readers)])] as string[];
        const sources = Object.fromEntries(paths.map(file => [file, readFileSync(file, 'utf8')]));
        const graph = buildDependencyGraph(sources);
        const plan = selectAffected({files: sources, changed: targets, matrix: actualMatrix, coveragePaths: targets});
        expect(plan.coverageFiles).toEqual([...targets].sort());
        expect(plan.testFiles.filter(file => actualMatrix.groups.architecture.includes(file))).toEqual([...actualMatrix.groups.architecture].sort());
        for (const [target, reader] of Object.entries(readers)) {
            expect([...graph.get(reader)!], reader).toContain(target);
            expect(plan.testFiles, target).toContain(reader);
        }
        expect(new Set(plan.testFiles).size).toBe(plan.testFiles.length);
    });
});

describe('affected behavior test execution', () => {
    it('skips when neither architecture nor affected behavior tests exist instead of invoking every Vitest file', async () => {
        const runner = vi.fn();
        const plan = selectAffected({files: files(), changed: ['docs/testing.md'], matrix: {groups: {unit: ['tests/a.test.ts']}}, coveragePaths: []});
        await expect(executePlan(directory(), plan, runner)).resolves.toMatchObject({skipped: true});
        expect(runner).not.toHaveBeenCalled();expect(testInvocation({testFiles: [], coverageFiles: []}, '/tmp/config')).toBeNull();
    });
    it('passes only selected files to the regular Vitest entry', async () => {
        const runner = vi.fn().mockResolvedValue({code: 0, signal: null});const root = directory();
        await executePlan(root, select(['tests/b.test.ts']), runner);
        expect(runner).toHaveBeenCalledWith(root, ['exec', 'vitest', 'run', 'tests/architecture/boundary.test.ts', 'tests/b.test.ts']);
    });
    it('executes a generated config that inherits real plugins and preserves 100 percent thresholds', async () => {
        const root = directory();save(root, 'base.mjs', 'export default {plugins:["actual-plugin"],test:{coverage:{all:true,thresholds:{statements:100,branches:100,functions:100,lines:100}}}};');
        const plan = select(['src/core/a.ts']);const filename = path.join(root, 'scoped.mjs');
        writeFileSync(filename, scopedCoverageConfig(plan, path.join(root, 'base.mjs')));
        const compiled = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
            'const {default: config} = await import(process.argv[1]);console.log(JSON.stringify(config));', filename], {encoding: 'utf8'}));
        expect(compiled).toMatchObject({plugins: ['actual-plugin'], test: {include: plan.testFiles,
            coverage: {all: true, reportOnFailure: true, include: ['src/core/a.ts'], thresholds: {statements: 100, branches: 100, functions: 100, lines: 100, perFile: true}}}});
        save(root, 'vitest.coverage.config.ts', 'export default {test:{coverage:{thresholds:{statements:100,branches:100,functions:100,lines:100}}}};');
        save(root, 'tsconfig.json', JSON.stringify({compilerOptions: {noEmit: true, strict: true, types: []}, include: ['**/*']}));
        const runner = vi.fn(async (_root: string, args: string[]) => {
            const generatedPath = args[args.length - 1];
            expect(generatedPath).toBe(path.join(root, 'coverage/affected-plan/vitest.affected.config.mjs'));
            expect(readFileSync(generatedPath, 'utf8')).toContain('vitest.coverage.config.ts');
            // 真实 TS compiler 在产物存活时检查源码；.mjs 不被 **/* 当成 TypeScript 源文件。
            execFileSync(process.execPath, [path.resolve('node_modules/typescript/lib/tsc.js'), '--project', path.join(root, 'tsconfig.json')], {encoding: 'utf8'});
            return {code: 0, signal: null};
        });
        await executePlan(root, plan, runner);
        expect(runner.mock.calls[0][1].slice(0, 4)).toEqual(['exec', 'vitest', 'run', '--config']);
    });
    it('fails on command failure or termination and cleans the generated config in both cases', async () => {
        for (const outcome of [{code: 1, signal: null}, {code: null, signal: 'SIGTERM'}]) {
            const root = directory();await expect(executePlan(root, select(['src/core/a.ts']), vi.fn().mockResolvedValue(outcome))).rejects.toThrow('受影响测试失败');
            expect(() => readFileSync(path.join(root, 'coverage/affected-plan/vitest.affected.config.mjs'))).toThrow();
        }
    });
    it('actually enforces scoped V8 coverage and rejects an untested branch', () => {
        const root = directory();save(root, 'package.json', '{"name":"affected-fixture","private":true,"type":"module"}');
        symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir');
        save(root, 'vitest.coverage.config.ts', `export default {test:{environment:'node',maxWorkers:1,minWorkers:1,fileParallelism:false,
            coverage:{provider:'v8',enabled:true,all:true,reporter:['json-summary'],thresholds:{statements:100,branches:100,functions:100,lines:100}}}};`);
        save(root, 'src/choice.ts', "export const choice = (flag: boolean) => flag ? 'yes' : 'no';");
        const fixtureSource = (both: boolean) => `import {it,expect} from 'vitest';import {choice} from '../src/choice';
            it('observes outcomes',()=>{expect(choice(true)).toBe('yes');${both ? "expect(choice(false)).toBe('no');" : ''}});`;
        const plan = {...select(['tests/b.test.ts']), testFiles: ['tests/choice.test.ts'], coverageFiles: ['src/choice.ts']};
        const program = `import {executePlan} from ${JSON.stringify(path.resolve('scripts/testing/run-affected-tests.mjs'))};
            try {await executePlan(process.argv[1],JSON.parse(process.argv[2]));} catch(error) {console.error(error.message);process.exitCode=1;}`;
        const execute = () => execFileSync(process.execPath, ['--input-type=module', '-e', program, root, JSON.stringify(plan)],
            {encoding: 'utf8', timeout: 30_000, stdio: 'pipe'});
        save(root, 'tests/choice.test.ts', fixtureSource(true));execute();
        const summary = JSON.parse(readFileSync(path.join(root, 'coverage/affected/coverage-summary.json'), 'utf8'));
        for (const dimension of ['statements', 'branches', 'functions', 'lines']) expect(summary.total[dimension].pct).toBe(100);
        save(root, 'tests/choice.test.ts', fixtureSource(false));
        expect(execute).toThrow();
        const failed = JSON.parse(readFileSync(path.join(root, 'coverage/affected/coverage-summary.json'), 'utf8'));
        expect(failed.total.branches.pct).toBeLessThan(100);
        // 行为断言失败也须重新生成真实覆盖证据，不能只在覆盖率阈值失败时有报告。
        rmSync(path.join(root, 'coverage/affected/coverage-summary.json'));
        save(root, 'tests/choice.test.ts', fixtureSource(true).replace("toBe('yes')", "toBe('wrong')"));
        expect(execute).toThrow();
        const behaviorFailure = JSON.parse(readFileSync(path.join(root, 'coverage/affected/coverage-summary.json'), 'utf8'));
        expect(behaviorFailure.total.statements.covered).toBeGreaterThan(0);
        expect(behaviorFailure.total.branches.pct).toBeLessThan(100);
    }, 60_000);
});
