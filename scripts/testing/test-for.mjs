#!/usr/bin/env node

/**
 * @file scripts/testing/test-for.mjs
 * 文件职责：按源码文件或业务目录即时反查并运行精确受影响的测试，免去在千余个扁平测试文件中人工猜测。
 * 主要内容：
 * - 复用 dependency-graph.mjs 的同源 AST 依赖图（按符号 barrel 解析、纯类型过滤、注册表隔离）；
 * - 接受一个或多个源码文件、测试文件或目录路径（例如 src/features/video-subtitle/），支持 --dry-run、--coverage、--include-arch 与 --reporter；
 * - 零匹配或无效路径立即报错，不静默退化为全量测试；默认使用 --reporter=dot 降低终端与上下文 token 消耗；
 * - 开启 --coverage 时自动为命中的严格覆盖源码生成有界 V8 100% 配置，失败时附带精确缺口行号。
 * 模块边界：用于日常定向开发与局部回归，不替代完整架构检查、类型检查或浏览器验收。
 * 用法：node scripts/testing/test-for.mjs <file-or-dir...> [--dry-run] [--coverage] [--include-arch] [--reporter <name>] [-t <pattern>]
 */

import {spawn} from 'node:child_process';
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {analyze as analyzeCoverage, formatText as formatCoverageGaps} from './coverage-gaps.mjs';
import {analyzeProjectDependencyGraph, collectAffectedClosure} from './dependency-graph.mjs';
import {
    REPO_WIDE_ARCHITECTURE_GATE,
    scopedCoverageConfig,
    strictCoveragePaths,
} from './run-affected-tests.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const COVERAGE_CONFIG = 'tests/config/vitest.coverage.config.ts';

export function parseArguments(argv) {
    const options = {targets: [], dryRun: false, coverage: false, includeArch: false, noCache: false, reporter: 'dot', testNamePattern: null, json: false, help: false};
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--') continue;
        if (arg === '--help') return {...options, help: true};
        if (arg === '--dry-run') {options.dryRun = true; continue;}
        if (arg === '--coverage') {options.coverage = true; continue;}
        if (arg === '--include-arch') {options.includeArch = true; continue;}
        if (arg === '--no-cache') {options.noCache = true; continue;}
        if (arg === '--json') {options.json = true; continue;}
        if (arg === '--reporter' || arg === '-t' || arg === '--testNamePattern') {
            const value = argv[++index];
            if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
            if (arg === '--reporter') options.reporter = value;
            else options.testNamePattern = value;
            continue;
        }
        if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`);
        options.targets.push(arg);
    }
    if (!options.targets.length) throw new Error('必须提供至少一个源码文件、测试文件或目录路径');
    return options;
}

function normalizeTarget(root, raw) {
    const relative = (path.isAbsolute(raw) ? path.relative(root, raw) : raw)
        .replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
    if (!relative || relative === '.' || relative.split('/').includes('..')) {
        throw new Error(`无效路径：${raw}`);
    }
    return relative;
}

export function planTestsForPaths(root, rawTargets, options = {}) {
    const {reverse, known, existingFiles} = analyzeProjectDependencyGraph(root, {noCache: Boolean(options.noCache)});
    const matrix = JSON.parse(readFileSync(path.join(root, 'tests/test-matrix.json'), 'utf8'));
    const allMatrixTests = new Set(Object.values(matrix.groups).flat());
    const repoArchGates = (matrix.groups.architecture ?? []).filter(file => REPO_WIDE_ARCHITECTURE_GATE.test(file) && existingFiles.has(file));

    const matchedTargets = new Set();
    for (const raw of rawTargets) {
        const normalized = normalizeTarget(root, raw);
        if (known.has(normalized)) {
            matchedTargets.add(normalized);
            continue;
        }
        const prefix = `${normalized}/`;
        let found = false;
        for (const file of known) {
            if (file.startsWith(prefix)) {
                matchedTargets.add(file);
                found = true;
            }
        }
        if (!found) throw new Error(`未在仓库中找到匹配路径：${raw}`);
    }

    const targets = [...matchedTargets].sort();
    const closure = collectAffectedClosure(reverse, targets);
    const selected = [...closure].filter(file => allMatrixTests.has(file) && existingFiles.has(file));
    if (options.includeArch) {
        for (const gate of repoArchGates) selected.push(gate);
    }
    const testFiles = [...new Set(selected)].sort();
    if (!testFiles.length) {
        throw new Error(`目标路径没有可追踪的运行时测试（若为纯类型文件请运行 pnpm compile）：${rawTargets.join(', ')}`);
    }

    const strictSet = new Set(strictCoveragePaths(readFileSync(path.join(root, COVERAGE_CONFIG), 'utf8')));
    const coverageFiles = options.coverage ? targets.filter(file => strictSet.has(file)) : [];
    return {targets, testFiles, coverageFiles};
}

function runCommand(root, args) {
    const env = !process.stdout.isTTY && process.env.CI === undefined ? {...process.env, CI: '1'} : process.env;
    return new Promise((resolve, reject) => {
        const child = spawn('pnpm', args, {cwd: root, stdio: 'inherit', shell: false, env});
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({code, signal}));
    });
}

export async function main(argv = process.argv.slice(2)) {
    const options = parseArguments(argv);
    if (options.help) {
        console.log('用法: pnpm test:for -- <file-or-dir...> [--dry-run] [--coverage] [--include-arch] [--reporter <name>] [-t <pattern>] [--json]');
        return;
    }
    const plan = planTestsForPaths(PROJECT_ROOT, options.targets, options);
    if (options.dryRun) {
        if (options.json) console.log(JSON.stringify(plan, null, 2));
        else {
            console.log(`[test-for] 命中 ${plan.targets.length} 个源码/目录文件 → ${plan.testFiles.length} 个受影响测试${options.coverage ? `（严格覆盖 ${plan.coverageFiles.length} 个源文件）` : ''}`);
            for (const file of plan.testFiles) console.log(`  ${file}`);
        }
        return;
    }

    console.log(`[test-for] 命中 ${plan.targets.length} 个目标 → 执行 ${plan.testFiles.length} 个受影响测试${plan.coverageFiles.length ? ` + 严格覆盖 ${plan.coverageFiles.length} 个文件` : ''}`);
    const extraArgs = [`--reporter=${options.reporter}`];
    if (options.testNamePattern) extraArgs.push('--testNamePattern', options.testNamePattern);

    if (plan.coverageFiles.length) {
        const dir = path.join(PROJECT_ROOT, 'coverage', 'affected-plan');
        mkdirSync(dir, {recursive: true});
        const configPath = path.join(dir, 'vitest.test-for.config.mjs');
        try {
            writeFileSync(configPath, scopedCoverageConfig(plan, path.join(PROJECT_ROOT, COVERAGE_CONFIG)));
            const result = await runCommand(PROJECT_ROOT, ['exec', 'vitest', 'run', ...extraArgs, '--config', configPath]);
            if (result.code !== 0 || result.signal) {
                try {
                    const report = analyzeCoverage(path.join(PROJECT_ROOT, 'coverage', 'affected', 'coverage-final.json'));
                    if (report.files.length) console.error('\n' + formatCoverageGaps(report, {max: 5}) + '\n');
                } catch {
                    // 保留原始失败原因。
                }
                process.exitCode = result.code ?? 1;
            }
        } finally {
            rmSync(configPath, {force: true});
        }
        return;
    }

    const result = await runCommand(PROJECT_ROOT, ['exec', 'vitest', 'run', ...extraArgs, ...plan.testFiles]);
    if (result.code !== 0 || result.signal) process.exitCode = result.code ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch(error => {
        console.error(`[test-for] ${error.message}`);
        process.exitCode = 1;
    });
}
