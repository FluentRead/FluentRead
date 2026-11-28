#!/usr/bin/env node

/**
 * @file scripts/testing/dev-verify.mjs
 * 文件职责：低 token、结构化的日常开发验证总入口，将完整日志写入证据目录并向终端返回高信号摘要。
 * 主要内容：
 * - 按需串联：测试套件审计（test:audit）→ 手写 .d.mts 声明一致性（check-module-declarations）→ 受影响测试与改动严格覆盖（run-affected-tests）→ 可选增量类型检查（--compile）；
 * - 完整原始 stdout/stderr 落盘到证据目录（默认 coverage/dev-verify/<timestamp>/），终端仅打印每步耗时、状态、精确失败摘要与日志路径；
 * - 支持 --base、--files、--compile、--all-architecture、--dry-run、--fail-fast、--artifacts-dir 与 --json。
 * 模块边界：用于日常快速迭代与提交前自检；发版或跨浏览器构建验收仍使用 pnpm test:regression:all。
 */

import {spawn} from 'node:child_process';
import {createWriteStream, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {performance} from 'node:perf_hooks';
import {fileURLToPath, pathToFileURL} from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export function parseArguments(argv) {
    const options = {
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
    };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--') continue;
        if (arg === '--help') return {...options, help: true};
        if (arg === '--compile') {options.compile = true; continue;}
        if (arg === '--all-architecture') {options.allArchitecture = true; continue;}
        if (arg === '--dry-run') {options.dryRun = true; continue;}
        if (arg === '--continue') {options.continueOnError = true; options.failFast = false; continue;}
        if (arg === '--fail-fast') {options.failFast = true; continue;}
        if (arg === '--json') {options.json = true; continue;}
        if (arg === '--base' || arg === '--files' || arg === '--artifacts-dir') {
            const value = argv[++index];
            if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
            if (arg === '--artifacts-dir') options.artifactsDir = value;
            else options[arg.slice(2)] = value;
            continue;
        }
        throw new Error(`未知参数：${arg}`);
    }
    return options;
}

export function buildSteps(options, artifactsDir) {
    const affectedArgs = [
        'scripts/testing/run-affected-tests.mjs',
        ...(options.files ? ['--files', options.files] : ['--base', options.base]),
        '--report', path.join(artifactsDir, 'affected-plan.json'),
        '--summary',
        '--reporter', 'dot',
    ];
    if (options.allArchitecture) affectedArgs.push('--all-architecture');

    const steps = [
        {id: 'audit', label: '测试矩阵与禁令审计', command: process.execPath, args: ['scripts/testing/audit-test-suite.mjs']},
        {id: 'declarations', label: '手写 .d.mts 声明检查', command: process.execPath, args: ['scripts/testing/check-module-declarations.mjs']},
        {id: 'affected', label: '受影响测试与改动覆盖', command: process.execPath, args: affectedArgs},
    ];
    if (options.compile) {
        const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
        steps.push({id: 'compile', label: 'TypeScript/Vue 增量类型检查', command: pnpmCommand, args: ['compile']});
    }
    return steps;
}

function runCaptured(step, cwd, logPath) {
    return new Promise((resolve, reject) => {
        const start = performance.now();
        const stream = createWriteStream(logPath, {encoding: 'utf8'});
        const child = spawn(step.command, step.args, {cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false});
        let tail = '';
        const append = chunk => {
            const text = chunk.toString('utf8');
            stream.write(text);
            tail = (tail + text).slice(-12000);
        };
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        child.once('error', error => {
            stream.end();
            reject(error);
        });
        child.once('close', (code, signal) => {
            stream.end(() => {
                resolve({
                    id: step.id,
                    label: step.label,
                    status: code === 0 && !signal ? 'passed' : 'failed',
                    exitCode: code,
                    signal,
                    durationMs: Math.round(performance.now() - start),
                    logPath,
                    tail,
                });
            });
        });
    });
}

const GENERAL_FAILURE_LINE = /(?:FAIL|AssertionError|Error:|✗|缺口|退出码|TS\d{4}|重复测试名|未归类|缺少导出|多余声明|禁止提交|覆盖率忽略|已归类但文件不存在|同时出现在|缺少 skip:)/u;
const COVERAGE_GAP_LINE = /^(?:覆盖率产物：|文件：.+未达 100%|门禁：|\s*语句\s+\d+\/\d+\s+分支\s+|\s*\[\d+\]\s+\S+:\d+|\s*\d+\s*│|\s*…还有\s+\d+\s+处)/u;
const COVERAGE_GAP_START = /(?:\[affected-tests\]\s*严格覆盖率缺口|^覆盖率产物：)/u;

export function failureExcerpt(tail, maxLines = 35) {
    const lines = tail.split(/\r?\n/u).map(line => line.trimEnd()).filter(Boolean);
    const interesting = lines.filter(line => GENERAL_FAILURE_LINE.test(line) || COVERAGE_GAP_LINE.test(line));
    let chosen;
    if (!interesting.length) {
        chosen = lines.slice(-maxLines);
    } else if (interesting.length <= maxLines) {
        chosen = interesting;
    } else {
        const gapStartIndex = interesting.findIndex(line => COVERAGE_GAP_START.test(line));
        const firstMetricGapIndex = interesting.findIndex(line => /^\s*语句\s+\d+\/\d+\s+分支\s+/u.test(line));
        const blockStart = gapStartIndex >= 0
            ? gapStartIndex
            : (firstMetricGapIndex > 0 && interesting[firstMetricGapIndex - 1].startsWith('✗ ')
                ? firstMetricGapIndex - 1
                : firstMetricGapIndex);
        if (blockStart > 0) {
            const headBudget = Math.min(blockStart, Math.max(4, Math.floor(maxLines / 3)));
            const gapBudget = Math.max(0, maxLines - headBudget);
            chosen = [...interesting.slice(0, headBudget), ...interesting.slice(blockStart, blockStart + gapBudget)];
        } else {
            chosen = interesting.slice(0, maxLines);
        }
    }
    return chosen.map(line => (line.length > 160 ? `${line.slice(0, 157)}...` : line));
}

function formatDuration(ms) {
    return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

export async function main(argv = process.argv.slice(2)) {
    const options = parseArguments(argv);
    if (options.help) {
        console.log('用法: pnpm verify:dev [-- --base <git-ref> | --files <p1,p2>] [--compile] [--all-architecture] [--continue] [--dry-run] [--artifacts-dir <dir>] [--json]');
        return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    const artifactsDir = path.resolve(PROJECT_ROOT, options.artifactsDir ?? path.join('coverage', 'dev-verify', stamp));
    const steps = buildSteps(options, artifactsDir);
    if (options.dryRun) {
        const preview = {artifactsDir, steps: steps.map(({id, label, command, args}) => ({id, label, command, args}))};
        console.log(JSON.stringify(preview, null, 2));
        return;
    }

    mkdirSync(artifactsDir, {recursive: true});
    const started = performance.now();
    const results = [];
    for (const step of steps) {
        const logPath = path.join(artifactsDir, `${step.id}.log`);
        const result = await runCaptured(step, PROJECT_ROOT, logPath);
        results.push(result);
        if (result.status !== 'passed' && options.failFast) break;
    }
    const totalMs = Math.round(performance.now() - started);
    const failed = results.filter(result => result.status !== 'passed');

    let planSummary = null;
    try {
        const plan = JSON.parse(readFileSync(path.join(artifactsDir, 'affected-plan.json'), 'utf8'));
        planSummary = {
            changed: plan.changed.length,
            tests: plan.testFiles.length,
            alwaysRunArch: plan.alwaysRunArchitecture?.length ?? 0,
            scopedTests: plan.affectedScopedTests?.length ?? 0,
            strictCoverage: plan.coverageFiles.length,
            reason: plan.reason,
        };
    } catch {
        // 未执行到 affected 阶段时跳过。
    }

    const summary = {
        status: failed.length ? 'failed' : 'passed',
        totalMs,
        artifactsDir,
        plan: planSummary,
        steps: results.map(({tail: _tail, ...rest}) => rest),
    };
    writeFileSync(path.join(artifactsDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

    if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
    } else {
        const relDir = path.relative(PROJECT_ROOT, artifactsDir).split(path.sep).join('/');
        console.log(`[dev-verify] ${summary.status.toUpperCase()} (${formatDuration(totalMs)}) | 日志目录：${relDir}`);
        for (const result of results) {
            const mark = result.status === 'passed' ? '✓' : '✗';
            console.log(`  ${mark} ${result.id.padEnd(13)} ${formatDuration(result.durationMs).padStart(7)}  ${result.label}`);
        }
        if (planSummary) {
            console.log(`  范围：改动 ${planSummary.changed} 文件 → 测试 ${planSummary.tests} 个（全局架构 ${planSummary.alwaysRunArch} + 受影响 ${planSummary.scopedTests}），严格覆盖 ${planSummary.strictCoverage} 个（${planSummary.reason}）`);
        }
        for (const result of failed) {
            console.error(`\n[dev-verify] 失败摘要 (${result.id}, exit=${result.exitCode ?? result.signal}) → ${path.relative(PROJECT_ROOT, result.logPath)}`);
            for (const line of failureExcerpt(result.tail)) console.error(`  ${line}`);
        }
    }

    if (failed.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch(error => {
        console.error(`[dev-verify] ${error.message}`);
        process.exitCode = 1;
    });
}
