#!/usr/bin/env node

import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const MATRIX_PATH = path.join(PROJECT_ROOT, 'tests/test-matrix.json');
const VALID_GROUPS = ['architecture', 'unit', 'functional', 'regression'];

function printUsage() {
    console.log([
        '用法: node scripts/testing/run-test-group.mjs <group|all> [文件或目录...] [-t 用例名] [--dry-run] [--coverage]',
        '',
        '可用 group: architecture, unit, functional, regression, all',
        '--dry-run  只打印将执行的 Vitest 文件，不启动测试',
        '--coverage 传递 --coverage 给 Vitest',
        '文件或目录按路径片段筛选当前分组；零匹配、跨组或未知参数会报错',
        '-t, --testNamePattern 仅运行名称匹配的用例',
    ].join('\n'));
}

async function loadMatrix() {
    const raw = await readFile(MATRIX_PATH, 'utf8');
    return JSON.parse(raw);
}

function filesForGroup(matrix, group) {
    if (group === 'all') {
        return VALID_GROUPS.flatMap((name) => matrix.groups?.[name] || []);
    }
    return matrix.groups?.[group] || [];
}

function run(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: PROJECT_ROOT,
            env: process.env,
            stdio: 'inherit',
            shell: false,
        });
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({code, signal}));
    });
}

async function main() {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.length === 0) {
        printUsage();
        process.exit(args.length === 0 ? 1 : 0);
    }

    const [group, ...options] = args;
    let dryRun = false, coverage = false, testNamePattern;
    const filters = [];
    for (let index = 0; index < options.length; index += 1) {
        const option = options[index];
        if (option === '--') continue;
        if (option === '--dry-run') dryRun = true;
        else if (option === '--coverage') coverage = true;
        else if (option === '-t' || option === '--testNamePattern') {
            testNamePattern = options[++index];
            if (!testNamePattern || testNamePattern.startsWith('--')) throw new Error(`${option} 需要非空用例名`);
        } else if (option.startsWith('--testNamePattern=')) {
            testNamePattern = option.slice('--testNamePattern='.length);
            if (!testNamePattern) throw new Error('--testNamePattern 需要非空用例名');
        } else if (option.startsWith('-')) throw new Error(`未知参数：${option}`);
        else filters.push(option);
    }
    if (![...VALID_GROUPS, 'all'].includes(group)) {
        throw new Error(`未知测试组：${group}`);
    }

    const matrix = await loadMatrix();
    const candidates = filesForGroup(matrix, group);
    const selected = new Set();
    for (const filter of filters) {
        const normalized = (path.isAbsolute(filter) ? path.relative(PROJECT_ROOT, filter) : filter).replaceAll('\\', '/').replace(/^\.\//u, '');
        if (!normalized || normalized === '.' || normalized.split('/').includes('..')) throw new Error(`无效测试路径：${filter}`);
        const matches = candidates.filter(file => file.includes(normalized));
        if (!matches.length) throw new Error(`测试筛选在 ${group} 分组中没有匹配：${filter}`);
        matches.forEach(file => selected.add(file));
    }
    const files = filters.length ? candidates.filter(file => selected.has(file)) : candidates;
    if (files.length === 0) throw new Error(`测试组为空：${group}`);

    // 步骤 1：先从矩阵解析出本次要运行的文件，runner 不自行发明分类。
    const vitestArgs = ['exec', 'vitest', 'run', '--reporter=dot'];
    if (coverage) vitestArgs.push('--coverage');
    if (testNamePattern !== undefined) vitestArgs.push('--testNamePattern', testNamePattern);
    vitestArgs.push(...files);

    // 步骤 2：dry-run 用于 CI 或本地自检命令，不把未运行伪装成通过。
    if (dryRun) {
        console.log(JSON.stringify({group, coverage, ...(testNamePattern !== undefined ? {testNamePattern} : {}), files}, null, 2));
        return;
    }

    // 步骤 3：真正执行时继承 stdio，让失败栈和 Vitest 摘要完整暴露。
    const result = await run('pnpm', vitestArgs);
    if (result.code !== 0) {
        process.exit(result.code ?? 1);
    }
}

main().catch((error) => {
    console.error(`[test-group] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
