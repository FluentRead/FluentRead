/**
 * 回归报告只整理执行结果、校验本轮证据并生成可复现的待排查清单。
 * 阶段退出码不等于已确认产品缺陷；本模块不执行修复、不读取凭据或保存环境变量。
 */
import {spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const COVERAGE_METRICS = ['statements', 'branches', 'functions', 'lines'];
const TERMINAL_EXECUTED_STATES = new Set(['passed', 'failed', 'interrupted']);
const STATE_LABELS = {
    running: '执行中', pending: '未执行', passed: '通过', failed: '失败',
    blocked: '依赖受阻', interrupted: '已中断', incomplete: '证据不完整',
    complete: '完整', 'not-run': '未执行', missing: '缺少报告', skipped: '跳过',
};

function timestamp(now) {
    const value = typeof now === 'function' ? now() : now ?? Date.now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError('报告时间无效');
    return date.toISOString();
}

function gitContext(cwd, env) {
    const read = (args) => {
        const result = spawnSync('git', args, {cwd, env, encoding: 'utf8', timeout: 5000, shell: false});
        return result.status === 0 ? result.stdout.trim() : null;
    };
    const head = read(['rev-parse', 'HEAD']);
    if (!head) return {available: false, head: null, branch: null, dirty: null};
    const branch = read(['branch', '--show-current']);
    const status = read(['status', '--porcelain']);
    return {available: true, head, branch: branch || null, dirty: status === null ? null : status.length > 0};
}

export function createRegressionReport(plan, {cwd = process.cwd(), env = process.env, now} = {}) {
    const projectRoot = path.resolve(cwd);
    const artifactsDir = path.resolve(projectRoot, plan.artifactsDir);
    return {
        version: 1,
        mode: plan.mode,
        artifactsDir,
        context: {
            cwd: projectRoot,
            git: gitContext(projectRoot, env),
            node: process.version,
            platform: process.platform,
            arch: process.arch,
        },
        startedAt: timestamp(now),
        finishedAt: null,
        durationMs: null,
        status: 'running',
        policies: {...plan.policies},
        paths: {
            json: path.join(artifactsDir, 'report.json'),
            summary: path.join(artifactsDir, 'summary.md'),
            repairPlan: path.join(artifactsDir, 'repair-plan.md'),
        },
        scopeSnapshot: createScopeSnapshot(plan, projectRoot, artifactsDir),
        steps: plan.steps.map((step) => ({
            id: step.id,
            label: step.label,
            phase: step.phase,
            command: step.command,
            args: [...step.args],
            gates: [...(step.gates || [])],
            ...(step.launchMode ? {launchMode: step.launchMode} : {}),
            ...(step.focusPolicy ? {focusPolicy: step.focusPolicy} : {}),
            ...(step.windowPlacement ? {windowPlacement: {...step.windowPlacement}} : {}),
            ...(step.artifactsDir ? {artifactsDir: step.artifactsDir} : {}),
            ...(step.networkPolicy ? {networkPolicy: step.networkPolicy} : {}),
            dependsOn: [...(step.dependsOn || [])],
            status: 'pending',
            startedAt: null,
            finishedAt: null,
            durationMs: null,
            exitCode: null,
            signal: null,
            error: null,
            logPath: null,
            blockedBy: [],
        })),
        evidence: {status: 'not-run', issues: [], tests: {status: 'not-run'}, coverage: {status: 'not-run'}},
    };
}

function readJson(file, issues, label) {
    try {
        return {value: JSON.parse(readFileSync(file, 'utf8')), status: 'complete'};
    } catch (error) {
        const missing = error?.code === 'ENOENT';
        issues.push(`${label}${missing ? '不存在' : '无法读取或不是有效 JSON'}：${file}`);
        return {value: null, status: missing ? 'incomplete' : 'failed'};
    }
}

function isCount(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

function expectedTestFiles(cwd, scopePath) {
    const matrix = JSON.parse(readFileSync(scopePath, 'utf8'));
    if (matrix.version !== 1 || !matrix.groups || typeof matrix.groups !== 'object' || Array.isArray(matrix.groups) ||
        !Object.values(matrix.groups).length || Object.values(matrix.groups).some((group) => !Array.isArray(group))) {
        throw new Error('测试矩阵不是有效的 version 1 groups 清单');
    }
    const expected = Object.values(matrix.groups).flat();
    if (!expected.length || expected.some((name) => typeof name !== 'string' || !name || path.isAbsolute(name) ||
        path.relative(cwd, path.resolve(cwd, name)).startsWith('..')) || new Set(expected).size !== expected.length) {
        throw new Error('测试矩阵包含无效、重复或项目外测试路径');
    }
    const files = expected.map((name) => path.resolve(cwd, name));
    if (new Set(files).size !== files.length) throw new Error('测试矩阵包含同一测试文件的路径别名');
    return files;
}

function fileHash(file) {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function codeInventory(cwd, artifactsDir) {
    const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        cwd, encoding: 'utf8', timeout: 5000, shell: false,
    });
    if (result.status !== 0) return {available: false, files: []};
    const files = result.stdout.split('\0').filter((file) => /\.(?:[cm]?js|[cm]?ts|tsx|vue|json|ya?ml|css|scss|md|html)$/.test(file))
        .map((file) => path.resolve(cwd, file)).filter((file) => {
            const relative = path.relative(artifactsDir, file);
            return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
        });
    return {available: true, files: [...new Set(files)].sort()};
}

function createScopeSnapshot(plan, cwd, artifactsDir) {
    const snapshot = {
        status: 'not-run', files: [], expectedCoverageFiles: [], expectedTestFiles: [],
        inventory: {available: false, files: []}, issues: [],
    };
    if (!plan.steps.some((step) => step.id === 'strict-coverage')) return snapshot;
    snapshot.status = 'complete';
    const configPath = path.join(cwd, 'tests/config/vitest.coverage.config.ts');
    const matrixPath = path.join(cwd, 'tests', 'test-matrix.json');
    try {
        snapshot.expectedCoverageFiles = expectedCoverageFiles(cwd, configPath);
        snapshot.expectedTestFiles = expectedTestFiles(cwd, matrixPath);
        // 固定已跟踪和未跟踪的源码/helper/config，排除 ignored 产物与本轮证据；无 Git fixture 固定完整显式清单。
        snapshot.inventory = codeInventory(cwd, artifactsDir);
        const files = new Set([configPath, matrixPath, ...snapshot.expectedCoverageFiles, ...snapshot.expectedTestFiles, ...snapshot.inventory.files]);
        snapshot.files = [...files].sort().map((file) => Object.freeze({path: file, sha256: fileHash(file)}));
    } catch (error) {
        snapshot.status = 'incomplete';
        snapshot.issues.push(`初始验证范围和文件快照无法完整固定：${error.message}`);
    }
    Object.freeze(snapshot.files);
    Object.freeze(snapshot.expectedCoverageFiles);
    Object.freeze(snapshot.expectedTestFiles);
    Object.freeze(snapshot.issues);
    Object.freeze(snapshot.inventory.files);
    Object.freeze(snapshot.inventory);
    return Object.freeze(snapshot);
}

function verifyScopeSnapshot(snapshot, cwd, artifactsDir) {
    const scope = {status: 'complete', changedFiles: [], changes: [], addedFiles: [], removedFiles: [], issues: []};
    if (snapshot?.status !== 'complete' || !snapshot.files?.length) {
        return {...scope, status: 'incomplete', issues: snapshot?.issues?.length ? [...snapshot.issues] : ['缺少有效的本轮初始验证范围快照']};
    }
    for (const entry of snapshot.files) {
        let actualSha256 = null;
        try { actualSha256 = fileHash(entry.path); } catch { /* 文件不可读也属于证据漂移，不能按初始范围认定通过。 */ }
        if (actualSha256 !== entry.sha256) {
            scope.changedFiles.push(entry.path);
            scope.changes.push({path: entry.path, expectedSha256: entry.sha256, actualSha256});
        }
    }
    if (scope.changedFiles.length) {
        scope.status = 'incomplete';
        scope.issues.push(`本轮执行期间 ${scope.changedFiles.length} 份源码、测试或配置发生变化；当前结果不能证明初始完整范围通过`);
    }
    if (snapshot.inventory?.available) {
        const current = codeInventory(cwd, artifactsDir);
        if (!current.available) {
            scope.status = 'incomplete';
            scope.issues.push('本轮结束时无法重新确认源码、helper 和配置文件清单');
        } else {
            const initialSet = new Set(snapshot.inventory.files);
            const currentSet = new Set(current.files);
            scope.addedFiles = current.files.filter((file) => !initialSet.has(file));
            scope.removedFiles = snapshot.inventory.files.filter((file) => !currentSet.has(file));
            if (scope.addedFiles.length || scope.removedFiles.length) {
                scope.status = 'incomplete';
                scope.issues.push(`本轮源码、helper 或配置清单发生变化：新增 ${scope.addedFiles.length} 项、移除 ${scope.removedFiles.length} 项`);
            }
        }
    }
    return scope;
}

function collectTests(data, file, cwd, expectedFiles, issues) {
    const result = {
        status: 'complete', path: file, failures: [], skippedTests: [], scopePath: path.join(cwd, 'tests', 'test-matrix.json'),
        expectedFiles: [], reportedFiles: [], missingFiles: [], unexpectedFiles: [],
    };
    const counters = {
        total: 'numTotalTests', passed: 'numPassedTests', failed: 'numFailedTests',
        pending: 'numPendingTests', todo: 'numTodoTests',
        suitesTotal: 'numTotalTestSuites', suitesPassed: 'numPassedTestSuites',
        suitesFailed: 'numFailedTestSuites', suitesPending: 'numPendingTestSuites',
    };
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        issues.push('Vitest 报告必须是包含测试计数的对象');
        return {...result, status: 'failed'};
    }
    for (const [key, field] of Object.entries(counters)) {
        if (!isCount(data[field])) {
            issues.push(`Vitest ${field} 不是有效非负整数`);
            result.status = 'failed';
        } else result[key] = data[field];
    }
    if (result.status === 'failed') return result;
    result.success = data.success;
    result.skipped = result.pending + result.todo;
    if (result.passed + result.failed + result.pending + result.todo !== result.total ||
        result.suitesPassed + result.suitesFailed + result.suitesPending !== result.suitesTotal ||
        typeof data.success !== 'boolean' ||
        data.success !== (result.failed === 0 && result.suitesFailed === 0)) {
        issues.push('Vitest 汇总计数或 success 标志互相矛盾');
        result.status = 'failed';
    }
    if (!Array.isArray(data.testResults)) {
        issues.push('Vitest 报告缺少逐文件 testResults');
        return {...result, status: 'failed'};
    }
    result.files = data.testResults.length;
    if (expectedFiles?.length) result.expectedFiles = [...expectedFiles];
    else {
        issues.push('完整测试范围无法从本轮初始清单确认');
        if (result.status !== 'failed') result.status = 'incomplete';
    }
    for (const testFile of data.testResults) {
        if (typeof testFile?.name !== 'string' || !testFile.name) {
            issues.push('Vitest 逐文件报告缺少测试文件 name');
            result.status = 'failed';
        } else result.reportedFiles.push(path.resolve(cwd, testFile.name));
    }
    if (new Set(result.reportedFiles).size !== result.reportedFiles.length) {
        issues.push('Vitest 逐文件报告包含重复测试文件');
        result.status = 'failed';
    }
    if (result.expectedFiles.length) {
        const expected = new Set(result.expectedFiles);
        const reported = new Set(result.reportedFiles);
        result.missingFiles = result.expectedFiles.filter((name) => !reported.has(name));
        result.unexpectedFiles = result.reportedFiles.filter((name) => !expected.has(name));
        if (result.missingFiles.length || result.unexpectedFiles.length) {
            issues.push(`完整测试文件范围不一致：缺少 ${result.missingFiles.length} 项，多出 ${result.unexpectedFiles.length} 项`);
            if (result.status !== 'failed') result.status = 'incomplete';
        }
    }
    const observed = {passed: 0, failed: 0, pending: 0, todo: 0};
    let failedFiles = 0;
    let pendingFiles = 0;
    for (const testFile of data.testResults) {
        if (!testFile || !Array.isArray(testFile.assertionResults)) {
            issues.push('Vitest 逐文件报告缺少 assertionResults');
            result.status = 'failed';
            continue;
        }
        if (testFile.status === 'failed') {
            failedFiles += 1;
            result.status = 'failed';
            result.failures.push({file: testFile.name || null, name: null, messages: [String(testFile.message || 'Vitest 文件级状态为 failed')]});
        } else if (testFile.status === 'pending' || testFile.status === 'skipped') {
            pendingFiles += 1;
            issues.push(`Vitest 测试文件未完整执行：${testFile.name || '未提供文件名称'} (${testFile.status})`);
            if (result.status !== 'failed') result.status = 'incomplete';
        } else if (testFile.status !== 'passed') {
            issues.push(`Vitest 测试文件状态无法确认：${String(testFile.status)}`);
            result.status = 'failed';
        }
        for (const assertion of testFile.assertionResults) {
            const key = assertion?.status === 'skipped' ? 'pending' : assertion?.status;
            if (!Object.hasOwn(observed, key)) {
                issues.push(`Vitest 用例状态无法确认：${String(assertion?.status)}`);
                result.status = 'failed';
                continue;
            }
            observed[key] += 1;
            if (key === 'pending' || key === 'todo') result.skippedTests.push({
                file: testFile.name || null,
                name: assertion.fullName || assertion.title || null,
                status: assertion.status,
            });
            if (key === 'failed') result.failures.push({
                file: testFile.name || null,
                name: assertion.fullName || assertion.title || null,
                messages: Array.isArray(assertion.failureMessages) ? assertion.failureMessages.map(String) : [],
            });
        }
        if (testFile.status === 'passed' && testFile.assertionResults.some((assertion) => assertion?.status === 'failed')) {
            issues.push(`Vitest 文件通过状态与失败用例矛盾：${testFile.name || '未提供文件名称'}`);
            result.status = 'failed';
        }
    }
    if (failedFiles > result.suitesFailed) {
        issues.push('Vitest 文件失败状态与 suite 汇总失败计数矛盾');
        result.status = 'failed';
    }
    if (pendingFiles && result.suitesPending === 0) issues.push('Vitest 文件未执行状态与 suite 汇总通过计数矛盾，无法认定完整通过');
    if (Object.entries(observed).some(([key, count]) => count !== result[key])) {
        issues.push('Vitest 汇总计数与逐用例记录不一致');
        result.status = 'failed';
    }
    if (result.failed > 0 || result.suitesFailed > 0) {
        issues.push(`Vitest 存在失败：${result.failed} 个用例，${result.suitesFailed} 个 suite`);
        result.status = 'failed';
    }
    if (result.status !== 'failed' && (result.total === 0 || result.files === 0 || result.suitesTotal === 0 ||
        result.skipped > 0 || result.suitesPending > 0)) {
        issues.push(`Vitest 测试未完整执行：总用例 ${result.total}，跳过/待处理 ${result.skipped}`);
        result.status = 'incomplete';
    }
    return result;
}

function unwrapExpression(node) {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))) {
        node = node.expression;
    }
    return node;
}

function property(object, name) {
    if (!object || !ts.isObjectLiteralExpression(object)) return null;
    const matches = object.properties.filter((entry) => ts.isPropertyAssignment(entry) &&
        (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) && entry.name.text === name);
    return matches.length === 1 ? unwrapExpression(matches[0].initializer) : null;
}

function expectedCoverageFiles(cwd, scopePath) {
    const source = ts.createSourceFile(scopePath, readFileSync(scopePath, 'utf8'), ts.ScriptTarget.Latest, true);
    if (source.parseDiagnostics.length) throw new Error('覆盖配置包含语法错误');
    const exports = source.statements.filter((node) => ts.isExportAssignment(node) && !node.isExportEquals);
    if (exports.length !== 1) throw new Error('覆盖配置必须有唯一默认配置');
    let config = unwrapExpression(exports[0].expression);
    if (ts.isCallExpression(config) && ts.isIdentifier(config.expression) && config.expression.text === 'defineConfig' &&
        config.arguments.length === 1) config = unwrapExpression(config.arguments[0]);
    const include = property(property(property(config, 'test'), 'coverage'), 'include');
    if (!include || !ts.isArrayLiteralExpression(include) || include.elements.length === 0 ||
        include.elements.some((entry) => !ts.isStringLiteral(entry))) {
        throw new Error('无法确认 test.coverage.include 的完整显式源码清单');
    }
    const files = include.elements.map((entry) => entry.text);
    if (new Set(files).size !== files.length || files.some((file) => !file || /[*?{}\[\]!]/.test(file) ||
        path.isAbsolute(file) || path.relative(cwd, path.resolve(cwd, file)).startsWith('..'))) {
        throw new Error('覆盖清单包含重复项、glob 或项目外路径，不能缩小范围后验收');
    }
    const resolved = files.map((file) => path.resolve(cwd, file));
    if (new Set(resolved).size !== resolved.length) throw new Error('覆盖清单包含同一源码文件的路径别名');
    return resolved;
}

function validateMetric(metric) {
    return metric && isCount(metric.total) && isCount(metric.covered) && isCount(metric.skipped) &&
        Number.isFinite(metric.pct) && metric.covered <= metric.total && metric.skipped <= metric.total;
}

function collectCoverage(data, file, cwd, expectedFiles, issues) {
    const result = {
        status: 'complete', path: file, scopePath: path.join(cwd, 'tests/config/vitest.coverage.config.ts'),
        expectedFiles: [], reportedFiles: [], missingFiles: [], unexpectedFiles: [], metrics: {}, failures: [],
    };
    if (expectedFiles?.length) result.expectedFiles = [...expectedFiles];
    else {
        issues.push('覆盖范围无法从本轮初始清单确认');
        result.status = 'incomplete';
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || !data.total || typeof data.total !== 'object') {
        issues.push('覆盖报告缺少有效 total 汇总');
        return {...result, status: 'failed'};
    }
    const records = Object.entries(data);
    const pathKeys = new Map();
    for (const [name] of records) {
        if (name === 'total') continue;
        const resolved = path.resolve(cwd, name);
        if (pathKeys.has(resolved)) {
            issues.push(`覆盖报告包含重复源码路径：${resolved}`);
            result.status = 'failed';
        }
        pathKeys.set(resolved, name);
    }
    result.reportedFiles = [...pathKeys.keys()].sort();
    if (result.expectedFiles.length) {
        const expected = new Set(result.expectedFiles);
        result.missingFiles = result.expectedFiles.filter((name) => !pathKeys.has(name));
        result.unexpectedFiles = result.reportedFiles.filter((name) => !expected.has(name));
        if (result.missingFiles.length || result.unexpectedFiles.length) {
            issues.push(`覆盖源码范围不一致：缺少 ${result.missingFiles.length} 项，多出 ${result.unexpectedFiles.length} 项`);
            if (result.status !== 'failed') result.status = 'incomplete';
        }
    }
    for (const [name, record] of records) {
        for (const metricName of COVERAGE_METRICS) {
            const metric = record?.[metricName];
            if (!validateMetric(metric)) {
                result.failures.push({file: name, metric: metricName, reason: 'invalid-metric'});
                result.status = 'failed';
            } else if (metric.covered !== metric.total || metric.skipped !== 0 || metric.pct !== 100) {
                result.failures.push({file: name, metric: metricName, reason: 'below-100', ...metric});
                result.status = 'failed';
            }
            if (name === 'total') result.metrics[metricName] = metric;
        }
    }
    for (const metricName of COVERAGE_METRICS) {
        const total = data.total[metricName];
        const members = records.filter(([name]) => name !== 'total').map(([, record]) => record?.[metricName]);
        if (validateMetric(total) && members.every(validateMetric) &&
            ['total', 'covered', 'skipped'].some((key) => members.reduce((sum, metric) => sum + metric[key], 0) !== total[key])) {
            result.failures.push({file: 'total', metric: metricName, reason: 'inconsistent-total'});
            result.status = 'failed';
        }
    }
    if (result.failures.length) issues.push(`覆盖报告有 ${result.failures.length} 项无效或未达到四维 100% 的指标`);
    return result;
}

export function refreshRegressionEvidence(report) {
    const strict = report.steps.find((step) => step.id === 'strict-coverage');
    if (!strict || !TERMINAL_EXECUTED_STATES.has(strict.status)) {
        report.evidence = {status: 'not-run', issues: [], tests: {status: 'not-run'}, coverage: {status: 'not-run'}};
        return report.evidence;
    }
    const issues = [];
    const scope = verifyScopeSnapshot(report.scopeSnapshot, report.context.cwd, report.artifactsDir);
    issues.push(...scope.issues);
    const testsPath = path.join(report.artifactsDir, 'vitest-results.json');
    const coveragePath = path.join(report.artifactsDir, 'coverage', 'coverage-summary.json');
    const tests = readJson(testsPath, issues, 'Vitest 结果报告');
    const coverage = readJson(coveragePath, issues, '覆盖率结果报告');
    report.evidence = {
        status: 'complete', issues, scope,
        tests: tests.status === 'complete' ? collectTests(tests.value, testsPath, report.context.cwd, report.scopeSnapshot?.expectedTestFiles, issues) : {status: tests.status, path: testsPath},
        coverage: coverage.status === 'complete' ? collectCoverage(coverage.value, coveragePath, report.context.cwd, report.scopeSnapshot?.expectedCoverageFiles, issues) : {status: coverage.status, path: coveragePath},
    };
    const states = [report.evidence.tests.status, report.evidence.coverage.status, scope.status];
    report.evidence.status = states.includes('failed') ? 'failed' : states.every((state) => state === 'complete') ? 'complete' : 'incomplete';
    return report.evidence;
}

export function deriveRegressionStatus(report) {
    if (report.interruption || report.steps.some((step) => step.status === 'interrupted')) return 'interrupted';
    if (report.executionError || report.steps.some((step) => step.status === 'failed') || report.evidence?.status === 'failed') return 'failed';
    if (report.steps.some((step) => step.status === 'running') ||
        (!report.finishedAt && report.steps.some((step) => step.status === 'pending'))) return 'running';
    if (!report.steps.length || report.steps.some((step) => step.status !== 'passed')) return 'incomplete';
    if (report.steps.some((step) => step.id === 'strict-coverage') && report.evidence?.status !== 'complete') return 'incomplete';
    return 'passed';
}

function markdown(value) {
    return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[\\`*_{}\[\]<>()|#!]/g, '\\$&').replace(/\r?\n/g, '<br>');
}

function inlineCode(value) {
    const text = String(value ?? '').replace(/\r?\n/g, ' ');
    const longest = Math.max(0, ...(text.match(/`+/g) || []).map((run) => run.length));
    const fence = '`'.repeat(longest + 1);
    return `${fence} ${text} ${fence}`;
}

function codeBlock(value, language = '') {
    const text = String(value ?? '');
    const longest = Math.max(2, ...(text.match(/`+/g) || []).map((run) => run.length));
    const fence = '`'.repeat(longest + 1);
    return `${fence}${language}\n${text}\n${fence}`;
}

function shellWord(value) {
    const text = String(value);
    return /^[\w./:=+-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

function commandText(step) {
    return [step.command, ...step.args].map(shellWord).join(' ');
}

function freshRecheckCommand(step, report) {
    const outputFlags = new Set(['--outputFile', '--coverage.reportsDirectory', '--artifacts-dir']);
    let unknownArtifactReference = false;
    const words = step.args.map((argument, index) => {
        const text = String(argument);
        const equal = text.indexOf('=');
        const flag = equal >= 0 ? text.slice(0, equal) : step.args[index - 1];
        const value = equal >= 0 ? text.slice(equal + 1) : text;
        if (outputFlags.has(flag) && (value === report.artifactsDir || value.startsWith(`${report.artifactsDir}${path.sep}`))) {
            const suffix = path.relative(report.artifactsDir, value).replace(/\\/g, '/');
            const rewritten = '"${regression_recheck_dir}"' + (suffix ? shellWord(`/${suffix}`) : '');
            return (equal >= 0 ? shellWord(`${flag}=`) : '') + rewritten;
        }
        if (text.includes(report.artifactsDir)) unknownArtifactReference = true;
        return shellWord(text);
    });
    if (unknownArtifactReference) return null;
    return [
        `regression_recheck_dir=$(mktemp -d ${shellWord(`${report.artifactsDir}-recheck.XXXXXX`)}) || exit 1`,
        [shellWord(step.command), ...words].join(' '),
    ].join('\n');
}

function reportLink(label, file, report) {
    const href = path.relative(report.artifactsDir, path.resolve(report.context.cwd, file)).replace(/\\/g, '/')
        .split('/').map((part) => encodeURIComponent(part).replace(/\(/g, '%28').replace(/\)/g, '%29')).join('/');
    return `[${markdown(label)}](${href})`;
}

function duration(value) {
    return typeof value === 'number' && Number.isFinite(value) ? `${(value / 1000).toFixed(2)} 秒` : '—';
}

function boundaries(report) {
    const executed = (phase) => report.steps.some((step) => step.phase === phase && TERMINAL_EXECUTED_STATES.has(step.status));
    return [
        executed('browser') ? '真实浏览器仅证明本次列出的 fixture 范围，请结合该阶段日志和独立证据。' : '本轮未执行真实浏览器验证；单元测试和本地 fixture 不能证明浏览器实际行为。',
        executed('network') ? '网络验证仅证明本次列出的站点、服务和执行时刻，不代表全部网站或供应商。' : '本轮未执行真实网站网络矩阵或在线翻译供应商验证。',
        '通过结论只覆盖本报告的阶段和本轮证据；定向复验不能自动替代完整回归。',
    ];
}

function summaryMarkdown(report) {
    const tests = report.evidence?.tests || {status: 'not-run'};
    const coverage = report.evidence?.coverage || {status: 'not-run'};
    const lines = [
        '# FluentRead 回归总报告', '',
        `结果：**${markdown(STATE_LABELS[report.status] || report.status)}**；模式：${inlineCode(report.mode)}。`, '',
        `开始：${markdown(report.startedAt)}；结束：${markdown(report.finishedAt || '尚未结束')}；总耗时：${duration(report.durationMs)}。`, '',
        ...(!report.finishedAt ? ['本轮仍在继续。当前结果是已结束阶段的中间状态，尚未完成的阶段不能计为通过。', ''] : []),
        `源码：${inlineCode(report.context.git.head || 'Git 信息不可用')}；分支：${inlineCode(report.context.git.branch || '不可用/分离 HEAD')}；工作树：${report.context.git.dirty === null ? '未知' : report.context.git.dirty ? '含未提交改动' : '干净'}。`, '',
        `Node：${inlineCode(report.context.node)}；平台：${inlineCode(`${report.context.platform}/${report.context.arch}`)}。`, '',
        `结构化证据：${reportLink('report.json', report.paths.json, report)}；后续排查：${reportLink('repair-plan.md', report.paths.repairPlan, report)}。`, '',
        '## 阶段结果', '',
        '| 阶段 | 状态 | 完整命令 | 开始 / 结束 | 耗时 | 退出码 / 信号 | 日志 |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        ...report.steps.map((step) => `| ${markdown(`${step.id}：${step.label}`)} | ${markdown(STATE_LABELS[step.status] || step.status)} | ${markdown(commandText(step))} | ${markdown(step.startedAt || '—')} / ${markdown(step.finishedAt || '—')} | ${duration(step.durationMs)} | ${markdown(step.exitCode ?? step.signal ?? '—')} | ${step.logPath ? reportLink('日志', step.logPath, report) : '—'} |`),
        '', '## 测试与覆盖证据', '',
        `Vitest：${markdown(STATE_LABELS[tests.status] || tests.status)}${tests.total === undefined ? '' : `；${tests.total} 个用例，通过 ${tests.passed}、失败 ${tests.failed}、跳过/待处理 ${tests.pending + tests.todo}；${tests.files} 份测试文件`}。`, '',
        `覆盖率：${markdown(STATE_LABELS[coverage.status] || coverage.status)}${coverage.expectedFiles ? `；清单 ${coverage.expectedFiles.length} 份源码，报告 ${coverage.reportedFiles.length} 份源码` : ''}。`, '',
        ...(coverage.metrics && Object.keys(coverage.metrics).length ? [
            '| 指标 | covered / total | skipped | 百分比 |', '| --- | --- | --- | --- |',
            ...COVERAGE_METRICS.map((name) => `| ${name} | ${markdown(coverage.metrics[name]?.covered ?? '—')} / ${markdown(coverage.metrics[name]?.total ?? '—')} | ${markdown(coverage.metrics[name]?.skipped ?? '—')} | ${markdown(coverage.metrics[name]?.pct ?? '—')} |`), '',
        ] : []),
        ...(report.evidence?.issues?.length ? ['证据待处理项：', '', ...report.evidence.issues.map((issue) => `- ${markdown(issue)}`), ''] : []),
        ...(report.executionError ? [`执行器错误：${markdown(report.executionError)}`, ''] : []),
        ...(report.interruption ? [`中断：${markdown(report.interruption.signal)}。`, ''] : []),
        '## 验证边界', '', ...boundaries(report).map((item) => `- ${item}`), '',
    ];
    return lines.join('\n');
}

function repairMarkdown(report) {
    const strictEvidenceIncomplete = report.evidence?.status !== 'complete';
    const unresolved = report.steps.filter((step) => step.status !== 'passed' || (step.id === 'strict-coverage' && strictEvidenceIncomplete));
    const failedAssertions = report.evidence?.tests?.failures || [];
    const skippedTests = report.evidence?.tests?.skippedTests || [];
    const coverageFailures = report.evidence?.coverage?.failures || [];
    const lines = [
        '# FluentRead 回归排查与修复清单', '',
        '阶段执行失败不等于已确认产品缺陷。先确认输入、环境和可重复的失败，再定位实际代码原因；仅对已确认缺陷自动修复并定向复验。', '',
        '保留必要用例和断言，不降低四维 100% 阈值，不删除覆盖源码、不添加 skip 或覆盖率忽略来制造通过。修复后保存定向复验报告；涉及共享代码或测试配置时补跑相应完整回归。', '',
        `总报告：${reportLink('summary.md', report.paths.summary, report)}；原始结果：${reportLink('report.json', report.paths.json, report)}。`, '',
        '## 阶段排查', '',
    ];
    if (!unresolved.length) lines.push('本轮阶段均已通过。', '');
    for (const step of unresolved) {
        lines.push(`### ${markdown(step.id)}：${markdown(step.label)}`, '',
            `状态：${markdown(STATE_LABELS[step.status] || step.status)}；退出码：${markdown(step.exitCode ?? '—')}；信号：${markdown(step.signal || '—')}。`, '',
            ...(step.id === 'strict-coverage' && strictEvidenceIncomplete ? [`命令执行状态与验证证据分别记录：严格测试证据为 **${markdown(STATE_LABELS[report.evidence?.status] || report.evidence?.status || '未执行')}**；退出码为 0 也不能替代完整、有效的报告。`, ''] : []),
            ...(step.blockedBy?.length ? [`受阻依赖：${step.blockedBy.map(inlineCode).join('、')}。先恢复依赖，受阻阶段没有通过证据。`, ''] : []),
            ...(step.error ? [`执行错误：${markdown(step.error)}。`, ''] : []),
            `工作目录：${inlineCode(report.context.cwd)}。${step.logPath ? `原始日志：${reportLink('阶段日志', step.logPath, report)}。` : '本阶段没有日志证据。'}`, '',
            '按原始 argv 重现（JSON 数组，仅供复现工具读取）：', '',
            codeBlock(JSON.stringify([step.command, ...step.args], null, 2), 'json'), '',
            '原始命令（仅供审计，不可直接重复写入本轮证据目录）：', '', codeBlock(commandText(step), 'sh'), '',
            ...(freshRecheckCommand(step, report) ? [
                '定向复验命令（在上述工作目录执行，使用新的临时目录保留原始证据）：', '',
                codeBlock(freshRecheckCommand(step, report), 'sh'), '',
            ] : [
                '此命令包含无法安全重写的本轮证据路径；先为命令的所有输出指定新的目录，再执行定向复验。也可在项目目录使用下面的完整回归入口生成独立报告：', '',
                codeBlock(`regression_recheck_dir=$(mktemp -d ${shellWord(`${report.artifactsDir}-recheck.XXXXXX`)}) || exit 1\npnpm test:regression:all -- --artifacts-dir "${'${regression_recheck_dir}'}"`, 'sh'), '',
            ]),
            '先核对必要语料、构建产物、依赖和权限。若失败不能可靠重现或仅由环境引起，记录原因并恢复环境，不把它自动归为产品缺陷。', '');
    }
    lines.push('## 测试失败与覆盖缺口', '');
    if (!failedAssertions.length && !skippedTests.length && !coverageFailures.length && !report.evidence?.issues?.length) {
        lines.push(report.evidence?.status === 'not-run' ? '本轮尚未取得全量 Vitest 与覆盖率证据。' : '本轮证据未发现测试失败或覆盖缺口。', '');
    }
    for (const failure of failedAssertions) {
        lines.push(`- 用例：${markdown(failure.name || '文件级执行失败')}；文件：${inlineCode(failure.file || '未提供')}。`, '',
            ...failure.messages.flatMap((message) => [codeBlock(message), '']));
    }
    if (skippedTests.length) lines.push('未执行的用例必须恢复必要输入并重新运行，不能根据 skip 判定生产代码缺陷：', '');
    for (const skipped of skippedTests) {
        lines.push(`- ${markdown(skipped.name || '未提供用例名称')}；文件：${inlineCode(skipped.file || '未提供')}；状态：${inlineCode(skipped.status)}。`);
    }
    if (skippedTests.length) lines.push('',
        '真实论文输入检查：FLUENTREAD_ATTENTION_PDF 需指向本地 Attention PDF；FLUENTREAD_PDF_CORPUS 需指向包含论文 PDF 的本地目录；FLUENTREAD_HARNESS_PDF 需指向对应 Harness PDF。历史修订用例还需要 FLUENTREAD_HARNESS_LAYOUT_OLD 与 FLUENTREAD_HARNESS_LAYOUT_FIXED 两份对应解析结果。上述名称只说明输入契约，报告不保存环境变量值。', '');
    if (coverageFailures.length) lines.push('覆盖原始失败项：', '', codeBlock(JSON.stringify(coverageFailures, null, 2), 'json'), '');
    for (const issue of report.evidence?.issues || []) lines.push(`- ${markdown(issue)}`);
    const tests = report.evidence?.tests;
    if (tests?.missingFiles?.length) lines.push('', '矩阵中尚未取得执行报告的测试文件：', '', ...tests.missingFiles.map((file) => `- ${inlineCode(file)}`));
    if (tests?.unexpectedFiles?.length) lines.push('', '执行报告中超出矩阵的测试文件：', '', ...tests.unexpectedFiles.map((file) => `- ${inlineCode(file)}`));
    if (report.evidence?.scope?.changedFiles?.length) lines.push('', '本轮执行期间发生变化的初始快照文件：', '',
        ...report.evidence.scope.changedFiles.map((file) => `- ${inlineCode(file)}`), '', '先确认正确的工作树版本，再用新目录重新执行；不能通过重新缩小初始清单来接受旧报告。');
    if (report.evidence?.scope?.addedFiles?.length) lines.push('', '本轮新增的源码、测试或构建输入：', '',
        ...report.evidence.scope.addedFiles.map((file) => `- ${inlineCode(file)}`));
    if (report.evidence?.scope?.removedFiles?.length) lines.push('', '本轮移除的源码、测试或构建输入：', '',
        ...report.evidence.scope.removedFiles.map((file) => `- ${inlineCode(file)}`));
    const coverage = report.evidence?.coverage;
    if (coverage?.missingFiles?.length) lines.push('', '清单中缺少报告的源码：', '', ...coverage.missingFiles.map((file) => `- ${inlineCode(file)}`));
    if (coverage?.unexpectedFiles?.length) lines.push('', '报告中超出清单的源码：', '', ...coverage.unexpectedFiles.map((file) => `- ${inlineCode(file)}`));
    lines.push('', '证据位置：', '',
        `- Vitest：${reportLink('vitest-results.json', path.join(report.artifactsDir, 'vitest-results.json'), report)}。`,
        `- 覆盖：${reportLink('coverage-summary.json', path.join(report.artifactsDir, 'coverage', 'coverage-summary.json'), report)}。`,
        '', '## 验证边界', '', ...boundaries(report).map((item) => `- ${item}`), '');
    return lines.join('\n');
}

function atomicWrite(file, contents) {
    mkdirSync(path.dirname(file), {recursive: true});
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, contents, 'utf8');
        renameSync(temporary, file);
    } finally {
        try { unlinkSync(temporary); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
}

export function saveRegressionReport(report) {
    report.status = deriveRegressionStatus(report);
    atomicWrite(report.paths.summary, summaryMarkdown(report));
    atomicWrite(report.paths.repairPlan, repairMarkdown(report));
    atomicWrite(report.paths.json, `${JSON.stringify(report, null, 2)}\n`);
    return report.paths;
}
