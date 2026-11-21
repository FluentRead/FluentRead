import {spawn, spawnSync} from 'node:child_process';
import {access, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';

const runnerUrl = pathToFileURL(resolve(__dirname, '../scripts/testing/run-full-regression.mjs')).href;
const resultPrefix = '__FLUENTREAD_REGRESSION_CONTRACT_RESULT__=';
const temporaryDirectories: string[] = [];
const children = new Map<ReturnType<typeof spawn>, Promise<ChildResult>>();
const fixturePids = new Set<number>();

interface ChildResult {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
}

interface FixtureStep {
    id: string;
    label: string;
    phase: string;
    command: string;
    args: string[];
    gates: string[];
    dependsOn: string[];
}

interface FixturePlan {
    version: number;
    mode: string;
    dryRun: boolean;
    artifactsDir: string;
    failFast: boolean;
    continueOnError: boolean;
    policies: Record<string, string>;
    steps: FixtureStep[];
}

interface ReportedStep extends FixtureStep {
    status: string;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    exitCode: number | null;
    signal: string | null;
    error: string | null;
    logPath: string;
    blockedBy: string[];
}

interface FixtureReport {
    status: string;
    context: {cwd: string};
    paths: {json: string; summary: string; repairPlan: string};
    steps: ReportedStep[];
    scopeSnapshot?: {status: string; expectedCoverageFiles: string[]; expectedTestFiles: string[];
        inventory?: {available: boolean}};
    evidence: {
        status: string;
        issues: unknown[];
        scope?: {status: string; changedFiles?: string[]; addedFiles?: string[]};
        tests: {status: string; total: number; passed: number; failed: number; pending: number; todo: number};
        coverage: {status: string; expectedFiles: string[]; reportedFiles: string[]; missingFiles: string[]};
    };
}

async function workspace() {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'fluentread-regression-report-contract-')));
    temporaryDirectories.push(directory);
    return directory;
}

function nodeStep(id: string, source: string, dependsOn: string[] = []): FixtureStep {
    return {id, label: `${id} fixture`, phase: 'local', command: process.execPath,
        args: ['-e', source], gates: [], dependsOn};
}

function fixturePlan(directory: string, steps: FixtureStep[], options: Partial<FixturePlan> = {}): FixturePlan {
    return {
        version: 3,
        // 小型契约探针只验证报告边界，不能被误认成生产完整回归。
        mode: 'contract-fixture',
        dryRun: false,
        artifactsDir: join(directory, 'artifacts'),
        failFast: false,
        continueOnError: true,
        policies: {local: 'deterministic-contract-fixture', browser: 'disabled', network: 'disabled', headed: 'disabled'},
        steps,
        ...options,
    };
}

async function launchPlan(directory: string, plan: FixturePlan, {stdoutFactory = ''} = {}) {
    const planFile = join(directory, 'plan.json');
    await writeFile(planFile, JSON.stringify(plan));
    const harness = `import {readFile} from 'node:fs/promises';
        import {writeFileSync} from 'node:fs';
        import {Writable} from 'node:stream';
        import {executePlan} from ${JSON.stringify(runnerUrl)};
        const plan = JSON.parse(await readFile(${JSON.stringify(planFile)}, 'utf8'));
        const runtime = {cwd: ${JSON.stringify(directory)}};
        ${stdoutFactory ? `runtime.stdout = ${stdoutFactory};` : ''}
        const report = await executePlan(plan, runtime);
        console.log(${JSON.stringify(resultPrefix)} + JSON.stringify(report ?? null));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', harness], {
        cwd: directory,
        env: {...process.env, FLUENTREAD_REGRESSION_CONTRACT_ENV: 'owned-contract-child'},
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', chunk => { stdout += chunk; });
    child.stderr!.on('data', chunk => { stderr += chunk; });
    const done = new Promise<ChildResult>((resolveResult, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => {
            children.delete(child);
            resolveResult({code, signal, stdout, stderr});
        });
    });
    children.set(child, done);
    return {child, done, output: () => stdout};
}

function reportFromResult(result: ChildResult): FixtureReport | null {
    expect(result.code, result.stderr).toBe(0);
    const resultLine = result.stdout.split('\n').find(line => line.startsWith(resultPrefix));
    expect(resultLine, result.stdout).toBeDefined();
    return JSON.parse(resultLine!.slice(resultPrefix.length));
}

async function runPlan(directory: string, plan: FixturePlan): Promise<FixtureReport | null> {
    return reportFromResult(await (await launchPlan(directory, plan)).done);
}

async function waitForOutput(job: Awaited<ReturnType<typeof launchPlan>>, predicate: (output: string) => boolean) {
    if (predicate(job.output())) return;
    await new Promise<void>((resolveReady, reject) => {
        const cleanup = () => {
            clearTimeout(deadline);
            job.child.stdout!.off('data', check);
            job.child.off('close', exited);
        };
        const check = () => {
            if (!predicate(job.output())) return;
            cleanup();
            resolveReady();
        };
        const exited = () => {
            cleanup();
            reject(new Error('回归探针尚未就绪就退出'));
        };
        const deadline = setTimeout(() => {
            cleanup();
            reject(new Error('回归探针未在 10 秒内就绪'));
        }, 10_000);
        job.child.stdout!.on('data', check);
        job.child.once('close', exited);
    });
}

function isProcessAlive(pid: number) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        throw error;
    }
}

function passedVitestResult(directory: string) {
    return {
        success: true,
        numTotalTestSuites: 1,
        numPassedTestSuites: 1,
        numFailedTestSuites: 0,
        numPendingTestSuites: 0,
        numTotalTests: 2,
        numPassedTests: 2,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        testResults: [{
            name: join(directory, 'tests/probe.test.ts'),
            status: 'passed',
            startTime: 1,
            endTime: 3,
            message: '',
            assertionResults: ['first behavior', 'second behavior'].map(title => ({
                title,
                fullName: `contract fixture ${title}`,
                ancestorTitles: ['contract fixture'],
                status: 'passed',
                duration: 1,
                failureMessages: [],
            })),
        }],
    };
}

function fullCoverageMetric(total: number) {
    return {total, covered: total, skipped: 0, pct: 100};
}

async function strictEvidenceFixture(directory: string) {
    const plan = fixturePlan(directory, [nodeStep('strict-coverage', 'console.log("strict fixture completed")')]);
    await mkdir(join(directory, 'src'), {recursive: true});
    await mkdir(join(directory, 'tests', 'config'), {recursive: true});
    const inputDirectory = join(directory, '.fixture-inputs');
    await mkdir(inputDirectory);
    const sourcePath = join(directory, 'src/probe.ts');
    await writeFile(sourcePath, 'export function probe(value: boolean) { return value ? 1 : 0; }\n');
    // 只允许静态读取这个配置；不执行配置里的 import 或任何任意代码。
    await writeFile(join(directory, 'tests/config/vitest.coverage.config.ts'),
        'import {defineConfig} from "vitest/config";\n' +
        'export default defineConfig({test: {coverage: {include: ["src/probe.ts"]}}});\n');
    await writeFile(join(directory, 'tests/probe.test.ts'), '// 自包含的回归报告契约范围探针。\n');
    await writeFile(join(directory, 'tests/test-matrix.json'), JSON.stringify({version: 1, groups: {unit: ['tests/probe.test.ts']}}));
    const vitestResult = passedVitestResult(directory);
    const metrics = {statements: fullCoverageMetric(10), branches: fullCoverageMetric(4),
        functions: fullCoverageMetric(3), lines: fullCoverageMetric(10)};
    const coverageSummary = {total: structuredClone(metrics), [sourcePath]: structuredClone(metrics)};
    const vitestPath = join(inputDirectory, 'vitest-results.json');
    const coveragePath = join(inputDirectory, 'coverage-summary.json');
    await writeFile(vitestPath, JSON.stringify(vitestResult));
    await writeFile(coveragePath, JSON.stringify(coverageSummary));
    // 本轮短子命令生成证据；runner 不得删除旧结果或把预先放入产物目录的文件当成新结果。
    plan.steps[0] = nodeStep('strict-coverage', `const fs = require('node:fs');
        fs.mkdirSync(${JSON.stringify(join(plan.artifactsDir, 'coverage'))}, {recursive: true});
        for (const [input, output] of ${JSON.stringify([
            [vitestPath, join(plan.artifactsDir, 'vitest-results.json')],
            [coveragePath, join(plan.artifactsDir, 'coverage/coverage-summary.json')],
        ])}) if (fs.existsSync(input)) fs.copyFileSync(input, output);
        console.log('strict fixture completed');`);
    return {plan, vitestResult, coverageSummary, vitestPath, coveragePath, sourcePath};
}

afterEach(async () => {
    for (const pid of fixturePids) {
        if (isProcessAlive(pid)) process.kill(pid, 'SIGTERM');
    }
    fixturePids.clear();
    const unfinished = [...children.entries()];
    for (const [child] of unfinished) child.kill('SIGTERM');
    await Promise.allSettled(unfinished.map(([, done]) => done));
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

describe('one-click regression report contracts', () => {
    it('dry-run 不启动子进程，也不创建报告或产物目录', async () => {
        const directory = await workspace();
        const marker = join(directory, 'must-not-run');
        const plan = fixturePlan(directory, [nodeStep('probe',
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected');`)], {dryRun: true});

        await runPlan(directory, plan);

        await expect(access(marker)).rejects.toMatchObject({code: 'ENOENT'});
        await expect(access(plan.artifactsDir)).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('成功执行使用指定工作目录和环境，并保存完整 stdout、stderr 与三份报告', async () => {
        const directory = await workspace();
        const report = await runPlan(directory, fixturePlan(directory, [nodeStep('passed-probe',
            'console.log("stdout:" + process.cwd() + ":" + process.env.FLUENTREAD_REGRESSION_CONTRACT_ENV);' +
            'console.error("stderr:owned child");')]));

        expect(report!.status).toBe('passed');
        expect(report!.context.cwd).toBe(directory);
        expect(report!.steps[0]).toMatchObject({status: 'passed', exitCode: 0, signal: null});
        expect(report!.steps[0].durationMs).toBeGreaterThanOrEqual(0);
        const log = await readFile(report!.steps[0].logPath, 'utf8');
        expect(log).toContain(`stdout:${directory}:owned-contract-child`);
        expect(log).toContain('stderr:owned child');
        expect(JSON.parse(await readFile(report!.paths.json, 'utf8')).status).toBe('passed');
        expect(await readFile(report!.paths.summary, 'utf8')).toContain('passed-probe');
        expect(await readFile(report!.paths.repairPlan, 'utf8')).toContain('通过');
    });

    it('真实非零退出生成失败报告和可复验修复计划，不从 executePlan 抛出错误', async () => {
        const directory = await workspace();
        const source = 'console.error("confirmed fixture failure"); process.exit(7);';
        const report = await runPlan(directory, fixturePlan(directory, [nodeStep('failed-probe', source)]));

        expect(report!.status).toBe('failed');
        expect(report!.steps[0]).toMatchObject({status: 'failed', exitCode: 7});
        expect(await readFile(report!.steps[0].logPath, 'utf8')).toContain('confirmed fixture failure');
        const summary = await readFile(report!.paths.summary, 'utf8');
        const repairPlan = await readFile(report!.paths.repairPlan, 'utf8');
        expect(summary).toContain('failed-probe');
        expect(repairPlan).toContain('failed-probe');
        expect(repairPlan).toContain('process.exit(7)');
        expect(JSON.parse(await readFile(report!.paths.json, 'utf8')).status).toBe('failed');
    });

    it('ENOENT 启动失败仍落盘，并继续采集独立步骤的结果', async () => {
        const directory = await workspace();
        const missing = {...nodeStep('missing-command', ''), command: join(directory, 'missing-executable'), args: []};
        const report = await runPlan(directory, fixturePlan(directory, [missing, nodeStep('independent', 'console.log("independent ran")')]));

        expect(report!.status).toBe('failed');
        expect(report!.steps.map(step => step.status)).toEqual(['failed', 'passed']);
        expect(JSON.stringify(report!.steps[0])).toContain('ENOENT');
        expect(await readFile(report!.steps[1].logPath, 'utf8')).toContain('independent ran');
        expect(await readFile(report!.paths.repairPlan, 'utf8')).toContain('missing-command');
    });

    it('输出流异步写入失败时保存失败报告，等待拥有的子进程退出并释放产物锁', async () => {
        const directory = await workspace();
        const pidPath = join(directory, 'stream-child.pid');
        const terminationMarker = join(directory, 'stream-child-terminated');
        const laterMarker = join(directory, 'after-stream-error-ran');
        const source = `process.on('SIGTERM', () => {
                require('node:fs').writeFileSync(${JSON.stringify(terminationMarker)}, 'terminated'); process.exit(0);
            }); console.log('STREAM_CHILD_READY:' + process.pid); setInterval(() => {}, 1000);`;
        const plan = fixturePlan(directory, [nodeStep('stream-probe', source),
            nodeStep('after-stream-error', `require('node:fs').writeFileSync(${JSON.stringify(laterMarker)}, 'ran');`)]);
        const stdoutFactory = `new Writable({write(chunk, encoding, callback) {
            const ready = chunk.toString().split('\\n').map(line => /^STREAM_CHILD_READY:(\\d+)$/.exec(line)).find(Boolean);
            if (ready) {
                writeFileSync(${JSON.stringify(pidPath)}, ready[1]);
                callback(new Error('owned output failed'));
            } else callback();
        }})`;
        const job = await launchPlan(directory, plan, {stdoutFactory});

        const result = await job.done;
        const ownedPid = Number(await readFile(pidPath, 'utf8'));
        fixturePids.add(ownedPid);
        const report = reportFromResult(result);

        expect(report!.status).toBe('failed');
        expect(report!.steps.map(step => step.status)).toEqual(['failed', 'not-run']);
        expect(JSON.stringify(report)).toContain('owned output failed');
        const log = await readFile(report!.steps[0].logPath, 'utf8');
        expect(log).toContain(`STREAM_CHILD_READY:${ownedPid}`);
        expect(log).toContain('owned output failed');
        expect(await readFile(terminationMarker, 'utf8')).toBe('terminated');
        expect(isProcessAlive(ownedPid)).toBe(false);
        await expect(access(laterMarker)).rejects.toMatchObject({code: 'ENOENT'});
        await expect(access(join(plan.artifactsDir, '.regression.lock'))).rejects.toMatchObject({code: 'ENOENT'});
        expect(JSON.parse(await readFile(report!.paths.json, 'utf8')).status).toBe('failed');
        fixturePids.delete(ownedPid);
    }, 15_000);

    it('失败依赖和其后继均被阻塞，独立步骤仍执行且阻塞命令不触及磁盘', async () => {
        const directory = await workspace();
        const blockedMarker = join(directory, 'blocked-command-ran');
        const independentMarker = join(directory, 'independent-command-ran');
        const report = await runPlan(directory, fixturePlan(directory, [
            nodeStep('producer', 'process.exit(9)'),
            nodeStep('consumer', `require('node:fs').writeFileSync(${JSON.stringify(blockedMarker)}, 'consumer');`, ['producer']),
            nodeStep('consumer-child', `require('node:fs').writeFileSync(${JSON.stringify(blockedMarker)}, 'child');`, ['consumer']),
            nodeStep('independent', `require('node:fs').writeFileSync(${JSON.stringify(independentMarker)}, 'ran');`),
        ]));

        expect(report!.status).toBe('failed');
        expect(report!.steps.map(step => step.status)).toEqual(['failed', 'blocked', 'blocked', 'passed']);
        expect(report!.steps[1].blockedBy).toContain('producer');
        expect(report!.steps[2].blockedBy).toContain('consumer');
        await expect(access(blockedMarker)).rejects.toMatchObject({code: 'ENOENT'});
        expect(await readFile(independentMarker, 'utf8')).toBe('ran');
        expect(await readFile(report!.paths.repairPlan, 'utf8')).toContain('consumer');
    });

    it('显式 fail-fast 将剩余独立步骤记为未运行，而不是误报通过', async () => {
        const directory = await workspace();
        const marker = join(directory, 'late-command-ran');
        const report = await runPlan(directory, fixturePlan(directory, [
            nodeStep('first-failure', 'process.exit(2)'),
            nodeStep('late-command', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`),
        ], {failFast: true}));

        expect(report!.status).toBe('failed');
        expect(report!.steps.map(step => step.status)).toEqual(['failed', 'not-run']);
        await expect(access(marker)).rejects.toMatchObject({code: 'ENOENT'});
        expect(await readFile(report!.paths.summary, 'utf8')).toContain('late-command');
    });

    it('同一产物目录不能并发运行或重用旧结果，并保留原报告与未执行命令', async () => {
        const directory = await workspace();
        const release = join(directory, 'release-active-probe');
        const mustNotRun = join(directory, 'reused-command-ran');
        const plan = fixturePlan(directory, [nodeStep('active-probe', `const fs = require('node:fs');
            console.log('ACTIVE_PROBE_READY');
            const timer = setInterval(() => {if (fs.existsSync(${JSON.stringify(release)})) clearInterval(timer);}, 10);`)]);
        const first = await launchPlan(directory, plan);
        await waitForOutput(first, output => output.split('\n').includes('ACTIVE_PROBE_READY'));
        const originalRunningReport = await readFile(join(plan.artifactsDir, 'report.json'), 'utf8');
        const prohibitedPlan = fixturePlan(directory, [nodeStep('must-not-run',
            `require('node:fs').writeFileSync(${JSON.stringify(mustNotRun)}, 'ran');`)]);

        const concurrent = await (await launchPlan(directory, prohibitedPlan)).done;

        expect(concurrent.code).not.toBe(0);
        expect(concurrent.stderr).toContain('EEXIST');
        expect(await readFile(join(plan.artifactsDir, 'report.json'), 'utf8')).toBe(originalRunningReport);
        await writeFile(release, 'release');
        const completed = reportFromResult(await first.done);
        expect(completed!.status).toBe('passed');
        const originalCompletedReport = await readFile(completed!.paths.json, 'utf8');

        const reused = await (await launchPlan(directory, prohibitedPlan)).done;

        expect(reused.code).not.toBe(0);
        expect(reused.stderr).toContain('回归产物目录已包含运行证据');
        expect(await readFile(completed!.paths.json, 'utf8')).toBe(originalCompletedReport);
        await expect(access(mustNotRun)).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('严格回归只有零跳过、四维原始计数全满且完整源码范围匹配才通过', async () => {
        const directory = await workspace();
        const fixture = await strictEvidenceFixture(directory);
        const report = await runPlan(directory, fixture.plan);

        expect(report!.status).toBe('passed');
        expect(report!.evidence.status).toBe('complete');
        expect(report!.evidence.tests).toMatchObject({status: 'complete', total: 2, passed: 2, failed: 0, pending: 0, todo: 0});
        expect(report!.evidence.coverage).toMatchObject({status: 'complete', expectedFiles: [fixture.sourcePath],
            reportedFiles: [fixture.sourcePath], missingFiles: []});
        expect(report!.evidence.issues).toEqual([]);
    });

    it('命令成功但有跳过用例时保持未完成状态，不能给出绿色验收', async () => {
        const directory = await workspace();
        const fixture = await strictEvidenceFixture(directory);
        fixture.vitestResult.numPassedTests = 1;
        fixture.vitestResult.numPendingTests = 1;
        fixture.vitestResult.testResults[0].assertionResults[1].status = 'pending';
        await writeFile(fixture.vitestPath, JSON.stringify(fixture.vitestResult));

        const report = await runPlan(directory, fixture.plan);

        expect(report!.status).toBe('incomplete');
        expect(report!.evidence.tests).toMatchObject({passed: 1, pending: 1});
        expect(report!.evidence.issues.length).toBeGreaterThan(0);
    });

    it('缺少机器可读测试报告时不能凭子命令退出码零认定回归通过', async () => {
        const directory = await workspace();
        const fixture = await strictEvidenceFixture(directory);
        await rm(fixture.vitestPath);

        const report = await runPlan(directory, fixture.plan);

        expect(report!.steps[0].status).toBe('passed');
        expect(report!.status).toBe('incomplete');
        expect(report!.evidence.issues.length).toBeGreaterThan(0);
        expect(JSON.parse(await readFile(report!.paths.json, 'utf8')).status).toBe('incomplete');
    });

    it('fail-fast 在命令退出零但严格证据不完整时同样停止后续步骤', async () => {
        const directory = await workspace();
        const fixture = await strictEvidenceFixture(directory);
        const marker = join(directory, 'after-incomplete-ran');
        await rm(fixture.vitestPath);
        fixture.plan.failFast = true;
        fixture.plan.steps.push(nodeStep('after-incomplete',
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`));

        const report = await runPlan(directory, fixture.plan);

        expect(report!.status).toBe('incomplete');
        expect(report!.steps.map(step => step.status)).toEqual(['passed', 'not-run']);
        await expect(access(marker)).rejects.toMatchObject({code: 'ENOENT'});
        expect(report!.evidence.status).toBe('incomplete');
    });

    it('损坏的覆盖率 JSON 生成失败证据，并保留其余报告供诊断', async () => {
        const directory = await workspace();
        const fixture = await strictEvidenceFixture(directory);
        await writeFile(fixture.coveragePath, '{broken coverage');

        const report = await runPlan(directory, fixture.plan);

        expect(report!.status).toBe('failed');
        expect(report!.evidence.coverage.status).toBe('failed');
        expect(report!.evidence.tests.passed).toBe(2);
        expect(await readFile(report!.paths.summary, 'utf8')).toContain('strict-coverage');
        expect(await readFile(report!.paths.repairPlan, 'utf8')).toContain('strict-coverage');
    });

    it('测试汇总与实际断言数量矛盾时拒绝 success:true 的虚假通过结果', async () => {
        const directory = await workspace();
        const fixture = await strictEvidenceFixture(directory);
        fixture.vitestResult.numPassedTests = 1;
        await writeFile(fixture.vitestPath, JSON.stringify(fixture.vitestResult));

        const report = await runPlan(directory, fixture.plan);

        expect(report!.status).toBe('failed');
        expect(report!.evidence.tests.status).toBe('failed');
        expect(report!.evidence.issues.length).toBeGreaterThan(0);
    });

    it('逐文件结果失败时拒绝汇总和断言全部通过的矛盾报告', async () => {
        const directory = await workspace();
        const fixture = await strictEvidenceFixture(directory);
        fixture.vitestResult.testResults[0].status = 'failed';
        await writeFile(fixture.vitestPath, JSON.stringify(fixture.vitestResult));

        const report = await runPlan(directory, fixture.plan);

        expect(report!.status).toBe('failed');
        expect(report!.evidence.tests.status).toBe('failed');
        expect(report!.evidence.issues.length).toBeGreaterThan(0);
        expect(await readFile(report!.paths.repairPlan, 'utf8')).toContain('strict-coverage');
    });

    it('即使 pct 显示 100，原始 covered 少于 total 也判定覆盖率失败', async () => {
        const directory = await workspace();
        const fixture = await strictEvidenceFixture(directory);
        fixture.coverageSummary.total.branches.covered = 3;
        fixture.coverageSummary[fixture.sourcePath].branches.covered = 3;
        await writeFile(fixture.coveragePath, JSON.stringify(fixture.coverageSummary));

        const report = await runPlan(directory, fixture.plan);

        expect(report!.status).toBe('failed');
        expect(report!.evidence.coverage.status).toBe('failed');
        expect(report!.evidence.issues.length).toBeGreaterThan(0);
    });

    it('覆盖率汇总遗漏配置中的源码文件时不能把剩余文件的满覆盖当作全量覆盖', async () => {
        const directory = await workspace();
        const fixture = await strictEvidenceFixture(directory);
        delete fixture.coverageSummary[fixture.sourcePath];
        await writeFile(fixture.coveragePath, JSON.stringify(fixture.coverageSummary));

        const report = await runPlan(directory, fixture.plan);

        expect(report!.status).not.toBe('passed');
        expect(report!.evidence.coverage.missingFiles).toContain(fixture.sourcePath);
        expect(report!.evidence.coverage).toMatchObject({expectedFiles: [fixture.sourcePath], reportedFiles: []});
        expect(report!.evidence.issues.length).toBeGreaterThan(0);
    });

    it('Vitest 遗漏测试矩阵中的文件时保持未完成状态，即使现有用例和覆盖率都通过', async () => {
        const directory = await workspace();
        const fixture = await strictEvidenceFixture(directory);
        await writeFile(join(directory, 'tests/omitted.test.ts'), '// 必须包含在本探针验收范围内。\n');
        await writeFile(join(directory, 'tests/test-matrix.json'), JSON.stringify({version: 1,
            groups: {unit: ['tests/probe.test.ts', 'tests/omitted.test.ts']}}));

        const report = await runPlan(directory, fixture.plan);

        expect(report!.status).toBe('incomplete');
        expect(report!.evidence.tests.status).toBe('incomplete');
        expect(report!.evidence.coverage.status).toBe('complete');
        expect(report!.evidence.issues.length).toBeGreaterThan(0);
    });

    it('执行中缩小源码清单和测试矩阵并生成匹配小报告，仍不能冒充初始完整范围通过', async () => {
        const directory = await workspace();
        const fixture = await strictEvidenceFixture(directory);
        const additionalSource = join(directory, 'src/omitted.ts');
        const additionalTest = join(directory, 'tests/omitted.test.ts');
        const coverageConfig = join(directory, 'tests/config/vitest.coverage.config.ts');
        const testMatrix = join(directory, 'tests/test-matrix.json');
        await writeFile(additionalSource, 'export const initialScopeMember = 2;\n');
        await writeFile(additionalTest, '// 初始测试范围内必须验证的另一个文件。\n');
        await writeFile(coverageConfig,
            'export default {test: {coverage: {include: ["src/probe.ts", "src/omitted.ts"]}}};\n');
        await writeFile(testMatrix, JSON.stringify({version: 1,
            groups: {unit: ['tests/probe.test.ts', 'tests/omitted.test.ts']}}));
        const originalEvidenceCommand = fixture.plan.steps[0].args[1];
        fixture.plan.steps[0] = nodeStep('strict-coverage', `require('node:fs').writeFileSync(
            ${JSON.stringify(coverageConfig)}, 'export default {test: {coverage: {include: ["src/probe.ts"]}}};\\n');
            require('node:fs').writeFileSync(${JSON.stringify(testMatrix)},
                ${JSON.stringify(JSON.stringify({version: 1, groups: {unit: ['tests/probe.test.ts']}}))});
            ${originalEvidenceCommand}`);

        const report = await runPlan(directory, fixture.plan);

        expect(report!.steps[0].status).toBe('passed');
        expect(report!.status).toBe('incomplete');
        expect(report!.scopeSnapshot?.expectedCoverageFiles).toHaveLength(2);
        expect(report!.scopeSnapshot?.expectedCoverageFiles).toEqual(expect.arrayContaining([fixture.sourcePath, additionalSource]));
        expect(report!.scopeSnapshot?.expectedTestFiles).toHaveLength(2);
        expect(report!.scopeSnapshot?.expectedTestFiles).toEqual(expect.arrayContaining([join(directory, 'tests/probe.test.ts'), additionalTest]));
        expect(report!.evidence.status).toBe('incomplete');
        expect(report!.evidence.issues.length).toBeGreaterThan(0);
        expect(JSON.parse(await readFile(report!.paths.json, 'utf8')).status).toBe('incomplete');
    });

    it('严格回归后继阶段修改已覆盖源码时，旧覆盖证据不能验收新源码', async () => {
        const directory = await workspace();
        const fixture = await strictEvidenceFixture(directory);
        fixture.plan.steps.push(nodeStep('modify-covered-source',
            `require('node:fs').writeFileSync(${JSON.stringify(fixture.sourcePath)},
                'export function probe(value: boolean) { return value ? 2 : 0; }\\n');`));

        const report = await runPlan(directory, fixture.plan);

        expect(report!.steps.map(step => step.status)).toEqual(['passed', 'passed']);
        expect(report!.status).toBe('incomplete');
        expect(report!.evidence.status).toBe('incomplete');
        expect(report!.evidence.scope?.status).toBe('incomplete');
        expect(report!.evidence.issues.length).toBeGreaterThan(0);
        expect(await readFile(fixture.sourcePath, 'utf8')).toContain('value ? 2 : 0');
        expect(await readFile(report!.paths.repairPlan, 'utf8')).toContain('strict-coverage');
    });

    it('Git 未跟踪源码的修改和新增均使证据失效，但本轮报告产物不制造范围漂移', async () => {
        const directory = await workspace();
        const fixture = await strictEvidenceFixture(directory);
        const untrackedHelper = join(directory, 'src/untracked-helper.ts');
        const addedHelper = join(directory, 'src/added-helper.ts');
        await writeFile(untrackedHelper, 'export const untrackedHelper = 1;\n');
        const initialized = spawnSync('git', ['init', '--quiet'], {cwd: directory, encoding: 'utf8', timeout: 5_000});
        expect(initialized.status, initialized.stderr).toBe(0);
        fixture.plan.steps.push(nodeStep('modify-untracked-and-add-source', `const fs = require('node:fs');
            const checkpoint = JSON.parse(fs.readFileSync(${JSON.stringify(join(fixture.plan.artifactsDir, 'report.json'))}, 'utf8'));
            console.log('STRICT_SCOPE_BEFORE_MUTATION:' + checkpoint.evidence.scope.status);
            fs.writeFileSync(${JSON.stringify(untrackedHelper)}, 'export const untrackedHelper = 2;\\n');
            fs.writeFileSync(${JSON.stringify(addedHelper)}, 'export const addedHelper = 3;\\n');`));

        const report = await runPlan(directory, fixture.plan);

        expect(report!.steps.map(step => step.status)).toEqual(['passed', 'passed']);
        expect(await readFile(report!.steps[1].logPath, 'utf8')).toContain('STRICT_SCOPE_BEFORE_MUTATION:complete');
        expect(report!.scopeSnapshot?.inventory?.available).toBe(true);
        expect(report!.status).toBe('incomplete');
        expect(report!.evidence.scope?.status).toBe('incomplete');
        expect(report!.evidence.scope?.changedFiles).toEqual([untrackedHelper]);
        expect(report!.evidence.scope?.addedFiles).toEqual([addedHelper]);
        expect(JSON.parse(await readFile(report!.paths.json, 'utf8')).status).toBe('incomplete');
    });

    it('SIGTERM 等待本步骤拥有的子进程树退出后保存中断报告，并将后续步骤记为未运行', async () => {
        const directory = await workspace();
        const directMarker = join(directory, 'direct-child-terminated');
        const descendantMarker = join(directory, 'descendant-terminated');
        const laterMarker = join(directory, 'interrupted-later-ran');
        const descendantCode = `const fs = require('node:fs');
            process.on('SIGTERM', () => {fs.writeFileSync(${JSON.stringify(descendantMarker)}, 'terminated'); process.exit(0)});
            console.log('DESCENDANT_READY:' + process.pid); setInterval(() => {}, 1000);`;
        const directCode = `const fs = require('node:fs');
            const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], {stdio: ['ignore', 'pipe', 'pipe']});
            child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
            process.on('SIGTERM', () => {fs.writeFileSync(${JSON.stringify(directMarker)}, 'terminated');
                if (child.exitCode !== null || child.signalCode !== null) process.exit(0);
                child.once('close', () => process.exit(0));});
            console.log('DIRECT_CHILD_READY:' + process.pid);`;
        const plan = fixturePlan(directory, [nodeStep('interrupted-probe', directCode),
            nodeStep('later', `require('node:fs').writeFileSync(${JSON.stringify(laterMarker)}, 'ran');`)]);
        const job = await launchPlan(directory, plan);
        await waitForOutput(job, output => output.split('\n').some(line => /^DESCENDANT_READY:\d+$/.test(line)));
        const ownedPids = job.output().split('\n').flatMap(line => {
            const match = /^(?:DIRECT_CHILD_READY|DESCENDANT_READY):(\d+)$/.exec(line);
            return match ? [Number(match[1])] : [];
        });
        ownedPids.forEach(pid => fixturePids.add(pid));
        expect(ownedPids).toHaveLength(2);

        job.child.kill('SIGTERM');
        const report = reportFromResult(await job.done);

        expect(report!.status).toBe('interrupted');
        expect(report!.steps.map(step => step.status)).toEqual(['interrupted', 'not-run']);
        expect(await readFile(directMarker, 'utf8')).toBe('terminated');
        expect(await readFile(descendantMarker, 'utf8')).toBe('terminated');
        expect(ownedPids.map(isProcessAlive)).toEqual([false, false]);
        await expect(access(laterMarker)).rejects.toMatchObject({code: 'ENOENT'});
        expect(JSON.parse(await readFile(report!.paths.json, 'utf8')).status).toBe('interrupted');
        expect(await readFile(report!.paths.repairPlan, 'utf8')).toContain('interrupted-probe');
        ownedPids.forEach(pid => fixturePids.delete(pid));
    }, 20_000);
});
