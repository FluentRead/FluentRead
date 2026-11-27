#!/usr/bin/env node

/**
 * @file scripts/testing/test-impact.mjs
 * 测试影响面诊断：回答「改一个文件为什么要跑 N 个测试」，并定位扩散枢纽、边来源与最短依赖链。
 *
 * 主要内容：
 * - 复用 dependency-graph.mjs 的同源 AST 依赖图（按符号 barrel 解析、纯类型过滤、注册表隔离），保证诊断与门禁完全一致；
 * - `--explain <path>` 输出单文件的反向触达规模、上游分层、扩散放大器与最长扩散链；
 * - `--why <path>` 列出该文件每条依赖的来源字符串、边类型（import/barrel-symbol/file-read/template/directory 等）与落点；
 * - `--hubs [n]` 统计全仓 `src/` 影响面分布（p50/p90/p95/max）并列出扩散最大的枢纽模块，辅助持续解耦；
 * - `--for <p1,p2>` 列出指定文件或目录的精确受影响测试集合；
 * - 不传路径时，诊断当前分支相对基线的每处改动；支持 `--json` 输出。
 *
 * 模块边界：纯只读诊断，不执行测试、不修改源码，也不参与 CI 判定；门禁仍以 run-affected-tests 为准。
 * 用法：node scripts/testing/test-impact.mjs [--explain <file>] [--why <file>] [--hubs] [--for <paths>] [--base <git-ref>] [--limit <n>] [--json]
 */

import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {
    CODE,
    DEPENDENCY_CONTENT,
    TEST_FILE_PATTERN,
    analyzeDependencyGraph,
    collectAffectedClosure,
    explainDependencies,
} from './dependency-graph.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCANNED = DEPENDENCY_CONTENT;
const TEST = TEST_FILE_PATTERN;

const VIA_LABELS = {
    directory: '目录回退',
    template: '模板匹配',
    'file-read': '文件读取',
    'vi-mock': '测试模拟',
    'dynamic-import': '动态导入',
    'barrel-symbol': '符号穿透',
    'css-import': '样式导入',
    'vue-asset': '模板资源',
    import: '静态导入',
};

const VIA_RANK = {
    directory: 0,
    template: 1,
    'file-read': 2,
    'dynamic-import': 3,
    'vi-mock': 4,
    'css-import': 5,
    'vue-asset': 6,
    'barrel-symbol': 7,
    import: 8,
};

function parseArguments(argv) {
    const options = {explain: null, why: null, hubs: false, forPaths: null, base: 'origin/main', limit: 12, json: false};
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--') continue;
        if (argument === '--help') return {help: true};
        if (argument === '--hubs') {
            options.hubs = true;
            continue;
        }
        if (argument === '--json') {
            options.json = true;
            continue;
        }
        if (!['--explain', '--why', '--for', '--base', '--limit'].includes(argument)) {
            throw new Error(`未知参数：${argument}`);
        }
        const value = argv[++index];
        if (value === undefined || value.startsWith('--')) throw new Error(`${argument} 缺少值`);
        if (argument === '--limit') {
            const number = Number(value);
            if (!Number.isInteger(number) || number < 1) throw new Error('--limit 需要正整数');
            options.limit = number;
        } else if (argument === '--for') {
            options.forPaths = value.split(',').map(item => normalizePath(item.trim())).filter(Boolean);
        } else {
            options[argument.slice(2)] = value;
        }
    }
    return options;
}

function normalizePath(file) {
    return file.split(path.sep).join('/').replace(/^\.\//u, '').replace(/\/+$/u, '');
}

function git(...args) {
    return execFileSync('git', args, {cwd: PROJECT_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe']});
}

function loadWorkspace() {
    const files = {};
    const tracked = git('ls-files', '-z').split('\0');
    const untracked = git('ls-files', '--others', '--exclude-standard', '-z').split('\0');
    for (const file of [...new Set([...tracked, ...untracked])]) {
        if (!file) continue;
        const absolute = path.join(PROJECT_ROOT, file);
        if (!existsSync(absolute)) continue;
        files[file] = CODE.test(file) && (SCANNED.test(file) || !file.includes('/'))
            ? readFileSync(absolute, 'utf8') : '';
    }
    return {files, ...analyzeDependencyGraph(files)};
}

function upstreamOf(reverse, node, cache) {
    if (cache.has(node)) return cache.get(node);
    const reachable = collectAffectedClosure(reverse, [node]);
    reachable.delete(node);
    cache.set(node, reachable);
    return reachable;
}

function shortestChain(graph, from, target) {
    const previous = new Map([[from, null]]);
    const queue = [from];
    for (let index = 0; index < queue.length; index++) {
        const current = queue[index];
        if (current === target) {
            const chain = [];
            for (let node = current; node !== null; node = previous.get(node)) chain.unshift(node);
            return chain;
        }
        for (const next of graph.get(current) ?? []) {
            if (previous.has(next)) continue;
            previous.set(next, current);
            queue.push(next);
        }
    }
    return null;
}

function explain(graph, reverse, target, limit) {
    if (!graph.has(target)) throw new Error(`依赖图中没有 ${target}（是否路径写错或文件未被引用）`);
    const cache = new Map();
    const upstream = upstreamOf(reverse, target, cache);
    const tests = [...upstream].filter(file => TEST.test(file));
    const modules = [...upstream].filter(file => !TEST.test(file));

    const layers = new Map();
    for (const file of modules) {
        const layer = file.split('/').slice(0, 2).join('/');
        layers.set(layer, (layers.get(layer) ?? 0) + 1);
    }
    const direct = [...(reverse.get(target) ?? [])]
        .map(file => ({file, tests: [...upstreamOf(reverse, file, cache)].filter(item => TEST.test(item)).length + (TEST.test(file) ? 1 : 0)}))
        .sort((left, right) => right.tests - left.tests);
    const chains = tests.map(test => shortestChain(graph, test, target)).filter(Boolean)
        .sort((left, right) => right.length - left.length);

    const data = {
        target,
        reachableTests: tests.length,
        reachableModules: modules.length,
        layers: [...layers].sort((left, right) => right[1] - left[1]).slice(0, 8),
        direct: direct.slice(0, limit),
        directTotal: direct.length,
        longestChain: chains[0] ?? null,
    };

    const lines = [`改 ${target} 会触达 ${tests.length} 个测试、${modules.length} 个非测试模块`];
    if (!tests.length && !modules.length) {
        lines.push('没有运行时消费者引用它：改动不会触发任何行为测试（类型变更仍由 pnpm compile 检查）。');
        return {data, text: lines.join('\n')};
    }
    lines.push('', '上游分布：');
    for (const [layer, count] of data.layers) {
        lines.push(`  ${String(count).padStart(4)}  ${layer}`);
    }
    if (direct.length) {
        lines.push('', '直接依赖它的模块（左侧为经该通道触达的测试数）：');
        for (const row of data.direct) lines.push(`  ${String(row.tests).padStart(4)}  ${row.file}`);
        if (direct.length > limit) lines.push(`  …共 ${direct.length} 个，用 --limit ${direct.length} 全部展开`);
    }
    if (data.longestChain) {
        const chain = data.longestChain;
        lines.push('', `最长扩散链（${chain.length} 跳，共 ${chains.length} 个测试可到达）：`);
        const shown = chain.length > 10 ? [...chain.slice(0, 7), '…', ...chain.slice(-2)] : chain;
        shown.forEach((node, index) => lines.push(`${'  '.repeat(index)}└─ ${node}`));
        if (chain.length > shown.length) lines.push(`  （省略 ${chain.length - shown.length} 跳）`);
    }
    return {data, text: lines.join('\n')};
}

function explainEdges(files, graph, known, target, limit) {
    if (!graph.has(target)) throw new Error(`依赖图中没有 ${target}（是否路径写错或文件未被引用）`);
    const rows = explainDependencies(target, files[target] ?? '', known, files);
    rows.sort((left, right) => (VIA_RANK[left.via] ?? 9) - (VIA_RANK[right.via] ?? 9) || right.files.length - left.files.length);
    const lines = [`${target} 解析出 ${rows.length} 条依赖（目录回退与模板匹配排在前）`];
    for (const row of rows.slice(0, limit)) {
        const tag = VIA_LABELS[row.via] ?? row.via;
        lines.push(`  [${tag}] ${JSON.stringify(row.reference)} → ${row.files.length} 个文件`);
        for (const file of row.files.slice(0, 3)) lines.push(`        ${file}`);
        if (row.files.length > 3) lines.push(`        …还有 ${row.files.length - 3} 个`);
    }
    if (rows.length > limit) lines.push(`  …共 ${rows.length} 条，用 --limit ${rows.length} 全部展开`);
    return {data: {target, edges: rows}, text: lines.join('\n')};
}

function summarizeHubs(graph, reverse, barrels, limit) {
    const srcFiles = [...graph.keys()].filter(file => file.startsWith('src/') && /\.(?:ts|vue)$/u.test(file));
    const cache = new Map();
    const rows = srcFiles.map(file => {
        const upstream = upstreamOf(reverse, file, cache);
        let tests = 0;
        for (const item of upstream) if (TEST.test(item)) tests++;
        return {file, tests, directImporters: reverse.get(file)?.size ?? 0, isBarrel: barrels.has(file)};
    }).sort((left, right) => right.tests - left.tests);

    const counts = rows.map(row => row.tests).sort((left, right) => left - right);
    const pct = ratio => counts[Math.min(counts.length - 1, Math.floor(counts.length * ratio))] ?? 0;
    const summary = {
        srcModules: srcFiles.length,
        pureBarrels: barrels.size,
        min: counts[0] ?? 0,
        p25: pct(0.25),
        median: pct(0.5),
        p75: pct(0.75),
        p90: pct(0.9),
        p95: pct(0.95),
        max: counts.at(-1) ?? 0,
        avg: Number((counts.reduce((sum, value) => sum + value, 0) / Math.max(1, counts.length)).toFixed(1)),
        over100: counts.filter(value => value >= 100).length,
        over400: counts.filter(value => value >= 400).length,
        topHubs: rows.slice(0, limit),
    };
    const lines = [
        `全仓 src/ 影响面分布（${summary.srcModules} 个模块，${summary.pureBarrels} 个纯 barrel）：`,
        `  min=${summary.min}  p25=${summary.p25}  median=${summary.median}  p75=${summary.p75}  p90=${summary.p90}  p95=${summary.p95}  max=${summary.max}  avg=${summary.avg}`,
        `  触达 ≥100 测试：${summary.over100} 个模块；触达 ≥400 测试：${summary.over400} 个模块`,
        '',
        `扩散最大的前 ${summary.topHubs.length} 个枢纽模块：`,
        ...summary.topHubs.map(row => `  ${String(row.tests).padStart(4)} tests (直接引用 ${String(row.directImporters).padStart(3)}${row.isBarrel ? ', barrel' : ''})  ${row.file}`),
    ];
    return {data: summary, text: lines.join('\n')};
}

function resolveTargets(known, rawPaths) {
    const matched = new Set();
    for (const raw of rawPaths) {
        if (known.has(raw)) {
            matched.add(raw);
            continue;
        }
        const prefix = `${raw}/`;
        let found = false;
        for (const file of known) {
            if (file.startsWith(prefix)) {
                matched.add(file);
                found = true;
            }
        }
        if (!found) throw new Error(`找不到匹配的文件或目录：${raw}`);
    }
    return [...matched].sort();
}

function changedFiles(base) {
    const tracked = git('diff', '--name-only', '--no-renames', base, '--').split('\n');
    const untracked = git('ls-files', '--others', '--exclude-standard').split('\n');
    return [...new Set([...tracked, ...untracked])].filter(file => file && SCANNED.test(file) && CODE.test(file));
}

function main(argv = process.argv.slice(2)) {
    const options = parseArguments(argv);
    if (options.help) {
        console.log('node scripts/testing/test-impact.mjs [--explain <file>] [--why <file>] [--hubs] [--for <p1,p2>] [--base <git-ref>] [--limit <n>] [--json]');
        return;
    }
    const {files, graph, reverse, barrels, known} = loadWorkspace();
    if (options.explain) {
        const result = explain(graph, reverse, normalizePath(options.explain), options.limit);
        console.log(options.json ? JSON.stringify(result.data, null, 2) : `依赖图：${graph.size} 个节点（${barrels.size} 个纯 barrel）\n\n${result.text}`);
        return;
    }
    if (options.why) {
        const result = explainEdges(files, graph, known, normalizePath(options.why), options.limit);
        console.log(options.json ? JSON.stringify(result.data, null, 2) : `依赖图：${graph.size} 个节点\n\n${result.text}`);
        return;
    }
    if (options.hubs) {
        const result = summarizeHubs(graph, reverse, barrels, options.limit);
        console.log(options.json ? JSON.stringify(result.data, null, 2) : result.text);
        return;
    }
    if (options.forPaths) {
        const targets = resolveTargets(known, options.forPaths);
        const closure = collectAffectedClosure(reverse, targets);
        const tests = [...closure].filter(file => TEST.test(file)).sort();
        const data = {targets, testCount: tests.length, tests};
        if (options.json) console.log(JSON.stringify(data, null, 2));
        else {
            console.log(`输入 ${targets.length} 个文件 → 精确受影响测试 ${tests.length} 个`);
            for (const test of tests.slice(0, options.limit)) console.log(`  ${test}`);
            if (tests.length > options.limit) console.log(`  …共 ${tests.length} 个，用 --limit ${tests.length} 全部展开`);
        }
        return;
    }
    const changed = changedFiles(options.base);
    const cache = new Map();
    const rows = changed.map(file => {
        if (!graph.has(file)) return {file, tests: 0};
        const tests = [...upstreamOf(reverse, file, cache)].filter(item => TEST.test(item)).length;
        return {file, tests};
    }).sort((left, right) => right.tests - left.tests);
    if (options.json) {
        console.log(JSON.stringify({nodes: graph.size, pureBarrels: barrels.size, base: options.base, changed: rows}, null, 2));
        return;
    }
    console.log(`依赖图：${graph.size} 个节点（${barrels.size} 个纯 barrel）`);
    if (!rows.length) {
        console.log(`相对 ${options.base} 没有源码改动。`);
        return;
    }
    for (const row of rows.slice(0, options.limit)) {
        console.log(`  ${String(row.tests).padStart(4)} tests  ${row.file}`);
    }
    if (rows.length > options.limit) console.log(`  …共 ${rows.length} 个改动文件，用 --limit ${rows.length} 全部展开`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        main();
    } catch (error) {
        console.error(`[test-impact] ${error.message}`);
        process.exitCode = 1;
    }
}
