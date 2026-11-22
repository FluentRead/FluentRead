#!/usr/bin/env node

/**
 * @file scripts/testing/test-impact.mjs
 * 测试影响面诊断：回答「改一个文件为什么要跑 N 个测试」，并定位扩散枢纽与最短依赖链。
 *
 * 主要内容：
 * - 复用 run-affected-tests 的依赖图算法（含 @/ 别名、barrel、SFC 与动态 import），保证诊断与门禁同源；
 * - `--explain <path>` 输出单文件的反向触达规模、上游分层、扩散难点与最长链路；
 * - `--why <path>` 列出该文件每条依赖的来源字符串与落点，用来分辨真实依赖与误报边；
 * - 不传路径时，改用当前分支相对 main 的改动逐项诊断，解释本次 PR 的验证范围为何扩大。
 *
 * 模块边界：纯只读诊断，不执行测试、不修改源码，也不参与 CI 判定；门禁仍以 run-affected-tests 为准。
 * 用法：node scripts/testing/test-impact.mjs [--explain <file>] [--why <file>] [--base <git-ref>] [--limit <n>]
 */

import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {CODE, DEPENDENCY_CONTENT, buildDependencyGraph, explainDependencies} from './run-affected-tests.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
// 与门禁共用同一套扫描规则：诊断范围比门禁窄会得出「不受影响」的错误结论。
const SCANNED = DEPENDENCY_CONTENT;
const TEST = /^tests\/.*\.test\.(?:[cm]?[jt]s)$/u;

function parseArguments(argv) {
    const options = {explain: null, why: null, base: 'origin/main', limit: 12};
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--help') return {help: true};
        if (!['--explain', '--why', '--base', '--limit'].includes(argument)) throw new Error(`未知参数：${argument}`);
        const value = argv[++index];
        if (value === undefined || value.startsWith('--')) throw new Error(`${argument} 缺少值`);
        if (argument === '--limit') {
            const number = Number(value);
            if (!Number.isInteger(number) || number < 1) throw new Error('--limit 需要正整数');
            options.limit = number;
        } else options[argument.slice(2)] = value;
    }
    return options;
}

function git(...args) {
    return execFileSync('git', args, {cwd: PROJECT_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe']});
}

/** 读取纳入分析的源码并建立同源依赖图；未跟踪的新文件同样参与，否则新模块会被当成不存在。 */
function loadGraph() {
    const files = {};
    const tracked = git('ls-files', '-z').split('\0');
    const untracked = git('ls-files', '--others', '--exclude-standard', '-z').split('\0');
    for (const file of [...tracked, ...untracked]) {
        if (!file || !SCANNED.test(file) || !CODE.test(file)) continue;
        const absolute = path.join(PROJECT_ROOT, file);
        if (existsSync(absolute)) files[file] = readFileSync(absolute, 'utf8');
    }
    return buildDependencyGraph(files);
}

function indexReverse(graph) {
    const reverse = new Map();
    for (const [owner, dependencies] of graph) {
        for (const dependency of dependencies) {
            if (!reverse.has(dependency)) reverse.set(dependency, []);
            reverse.get(dependency).push(owner);
        }
    }
    return reverse;
}

/** 反向可达闭包：改 node 会影响到的全部模块（含测试）。 */
function upstreamOf(reverse, node, cache) {
    if (cache.has(node)) return cache.get(node);
    const reachable = new Set();
    const stack = [node];
    const visited = new Set([node]);
    while (stack.length) {
        for (const owner of reverse.get(stack.pop()) ?? []) {
            if (visited.has(owner)) continue;
            visited.add(owner);
            reachable.add(owner);
            stack.push(owner);
        }
    }
    cache.set(node, reachable);
    return reachable;
}

/** 从测试正向 BFS 到目标模块，给出最省跳数的扩散链。 */
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
    const lines = [`改 ${target} 会触达 ${tests.length} 个测试、${modules.length} 个非测试模块`];
    if (!tests.length && !modules.length) {
        lines.push('没有模块引用它：改动不会触发任何行为测试。');
        return lines.join('\n');
    }
    const layers = new Map();
    for (const file of modules) {
        const layer = file.split('/').slice(0, 2).join('/');
        layers.set(layer, (layers.get(layer) ?? 0) + 1);
    }
    lines.push('', '上游分布：');
    for (const [layer, count] of [...layers].sort((left, right) => right[1] - left[1]).slice(0, 8)) {
        lines.push(`  ${String(count).padStart(4)}  ${layer}`);
    }
    // 直接依赖者是第一层放大器：每个都代表一条真实传播通道，比同层兄弟模块更能解释扩散。
    const direct = (reverse.get(target) ?? [])
        .map(file => ({file, tests: [...upstreamOf(reverse, file, cache)].filter(item => TEST.test(item)).length}))
        .sort((left, right) => right.tests - left.tests);
    if (direct.length) {
        lines.push('', `直接依赖它的模块（括号内为经该通道触达的测试数）：`);
        for (const row of direct.slice(0, limit)) lines.push(`  ${String(row.tests).padStart(4)}  ${row.file}`);
        if (direct.length > limit) lines.push(`  …共 ${direct.length} 个，用 --limit ${direct.length} 全部展开`);
    }
    // 最长链说明"层层穿透"的深度，比最短直连更能解释范围为何扩大到全量。
    const chains = tests.map(test => shortestChain(graph, test, target)).filter(Boolean)
        .sort((left, right) => right.length - left.length);
    if (chains.length) {
        const chain = chains[0];
        lines.push('', `最长扩散链（${chain.length} 跳，共 ${chains.length} 个测试可到达）：`);
        // 起点是测试、终点才是目标模块；只截头部会让读者看不到「最后落到哪里」。
        const shown = chain.length > 10 ? [...chain.slice(0, 7), '…', ...chain.slice(-2)] : chain;
        shown.forEach((node, index) => lines.push(`${'  '.repeat(index)}└─ ${node}`));
        if (chain.length > shown.length) lines.push(`  （省略 ${chain.length - shown.length} 跳）`);
    }
    return lines.join('\n');
}

function normalizePath(file) {
    return file.split(path.sep).join('/');
}

/** 依赖来源诊断：区分精确命中、模板匹配与目录回退，后者是误报高发区。 */
function explainEdges(graph, target, limit) {
    if (!graph.has(target)) throw new Error(`依赖图中没有 ${target}（是否路径写错或文件未被引用）`);
    const rows = explainDependencies(target, readFileSync(path.join(PROJECT_ROOT, target), 'utf8'), new Set(graph.keys()));
    const rank = row => (row.via === 'directory' ? 0 : row.via === 'template' ? 1 : 2);
    rows.sort((left, right) => rank(left) - rank(right) || right.files.length - left.files.length);
    const lines = [`${target} 解析出 ${rows.length} 条依赖（目录回退排在前，是误报高发区）`];
    for (const row of rows.slice(0, limit)) {
        const tag = row.via === 'directory' ? '目录回退' : row.via === 'template' ? '模板匹配' : '精确命中';
        lines.push(`  [${tag}] ${JSON.stringify(row.reference)} → ${row.files.length} 个文件`);
        for (const file of row.files.slice(0, 3)) lines.push(`        ${file}`);
        if (row.files.length > 3) lines.push(`        …还有 ${row.files.length - 3} 个`);
    }
    if (rows.length > limit) lines.push(`  …共 ${rows.length} 条，用 --limit ${rows.length} 全部展开`);
    return lines.join('\n');
}

function changedFiles(base) {
    // 未跟踪文件同样参与门禁（本地新增源码/测试），诊断也必须看见它们。
    const tracked = git('diff', '--name-only', '--no-renames', base, '--').split('\n');
    const untracked = git('ls-files', '--others', '--exclude-standard').split('\n');
    return [...new Set([...tracked, ...untracked])].filter(file => file && SCANNED.test(file) && CODE.test(file));
}

function main(argv = process.argv.slice(2)) {
    const options = parseArguments(argv);
    if (options.help) {
        console.log('node scripts/testing/test-impact.mjs [--explain <file>] [--why <file>] [--base <git-ref>] [--limit <n>]');
        return;
    }
    const graph = loadGraph();
    const reverse = indexReverse(graph);
    console.log(`依赖图：${graph.size} 个模块`);
    if (options.explain) {
        console.log('');
        console.log(explain(graph, reverse, normalizePath(options.explain), options.limit));
        return;
    }
    if (options.why) {
        console.log('');
        console.log(explainEdges(graph, normalizePath(options.why), options.limit));
        return;
    }
    const changed = changedFiles(options.base);
    if (!changed.length) {
        console.log(`相对 ${options.base} 没有源码改动。`);
        return;
    }
    const cache = new Map();
    for (const file of changed) {
        console.log('');
        console.log(`── ${file}`);
        if (!graph.has(file)) {
            console.log('   未被任何模块引用，改动不触发行为测试。');
            continue;
        }
        const tests = [...upstreamOf(reverse, file, cache)].filter(item => TEST.test(item)).length;
        console.log(`   触达 ${tests} 个测试`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        main();
    } catch (error) {
        console.error(`[test-impact] ${error.message}`);
        process.exitCode = 1;
    }
}
