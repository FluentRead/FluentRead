#!/usr/bin/env node

/**
 * @file scripts/testing/coverage-gaps.mjs
 * 覆盖率缺口定位器：把「语句/分支/函数/行 四维 100%」门禁的失败翻译成可改代码的行级清单。
 *
 * 主要内容：
 * - 读取 Vitest 的 istanbul JSON 产物（默认 coverage/affected/coverage-final.json），逐个文件重算四维覆盖；
 * - 只输出未达标的文件，逐条给出 文件:行号、维度、分支语义（条件为真/为假、逻辑右操作数等）与源码原文；
 * - 支持按文件过滤、限制条数与 JSON 输出，便于人读也便于自动化消费。
 *
 * 模块边界：纯只读分析，不执行测试、不改源码、不写覆盖率产物；不参与构建，也不被运行时导入。
 * 用法：node scripts/testing/coverage-gaps.mjs [--coverage <file>] [--file <substr>] [--max <n>] [--context <n>] [--json]
 */

import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DEFAULT_COVERAGE = 'coverage/affected/coverage-final.json';

// 分支类型的可读语义：istanbul 的 locations 顺序即命中计数数组顺序。
const BRANCH_LABELS = {
    if: index => (index === 0 ? '条件为真' : '条件为假'),
    'cond-expr': index => (index === 0 ? '三元真值' : '三元假值'),
    'binary-expr': (index, total) => (total === 2 ? (index === 0 ? '左操作数' : '右操作数') : `操作数 #${index + 1}`),
    'default-arg': () => '默认参数',
    switch: index => `case #${index + 1}`,
};

function parseArguments(argv) {
    const options = {coverage: DEFAULT_COVERAGE, file: null, max: 20, context: 0, json: false};
    const withValue = new Set(['--coverage', '--file', '--max', '--context']);
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--') continue;
        if (argument === '--help') return {help: true};
        if (argument === '--json') {
            options.json = true;
            continue;
        }
        if (!withValue.has(argument)) throw new Error(`未知参数：${argument}`);
        const value = argv[++index];
        if (value === undefined || value.startsWith('--')) throw new Error(`${argument} 缺少值`);
        if (argument === '--coverage' || argument === '--file') options[argument.slice(2)] = value;
        else {
            const number = Number(value);
            if (!Number.isInteger(number) || number < 0) throw new Error(`${argument} 需要非负整数`);
            options[argument.slice(2)] = number;
        }
    }
    return options;
}

/** 把 istanbul 的分支计数整理成「哪个出口没走到」。 */
function findMissingBranches(entry) {
    const missing = [];
    for (const [id, counts] of Object.entries(entry.b)) {
        const dead = counts.map((count, index) => ({count, index})).filter(item => item.count === 0);
        if (!dead.length) continue;
        const map = entry.branchMap[id];
        if (!map) continue;
        const label = BRANCH_LABELS[map.type];
        for (const item of dead) {
            const location = map.locations?.[item.index] ?? map.loc;
            missing.push({
                id,
                type: map.type,
                line: location?.start?.line ?? map.line,
                column: location?.start?.column ?? 0,
                index: item.index,
                total: counts.length,
                meaning: label ? label(item.index, counts.length) : `分支 #${item.index + 1}`,
            });
        }
    }
    return missing;
}

function summarizeFile(entry) {
    const statements = Object.entries(entry.s);
    const functions = Object.entries(entry.f);
    // 行覆盖按语句起始行聚合，与 istanbul 的 line 统计口径一致。
    const lines = new Map();
    for (const [id, count] of statements) {
        const line = entry.statementMap[id]?.start?.line;
        if (line === undefined) continue;
        lines.set(line, Math.max(lines.get(line) ?? 0, count));
    }
    const covered = counts => counts.filter(count => count > 0).length;
    return {
        statements: {covered: covered(statements.map(item => item[1])), total: statements.length},
        branches: {covered: covered(Object.values(entry.b).flat()), total: Object.values(entry.b).flat().length},
        functions: {covered: covered(functions.map(item => item[1])), total: functions.length},
        lines: {covered: covered([...lines.values()]), total: lines.size},
    };
}

/** 收集单文件的所有缺口条目，按行号排序；context 为源码上下文的行数。 */
function collectGaps(relativePath, entry, source, context = 0) {
    const sourceLines = source === null ? [] : source.split(/\r?\n/u);
    const read = (line, span) => {
        if (!sourceLines.length || !line) return [];
        const start = Math.max(1, line - span);
        const end = Math.min(sourceLines.length, line + span);
        const rows = [];
        for (let current = start; current <= end; current++) {
            rows.push({line: current, text: sourceLines[current - 1] ?? ''});
        }
        return rows;
    };
    const gaps = [];
    for (const [id, count] of Object.entries(entry.s)) {
        if (count > 0) continue;
        const location = entry.statementMap[id];
        gaps.push({file: relativePath, line: location?.start?.line ?? 0, column: location?.start?.column ?? 0,
            dimension: 'statement', detail: '语句从未执行', source: read(location?.start?.line ?? 0, context)});
    }
    for (const [id, count] of Object.entries(entry.f)) {
        if (count > 0) continue;
        const map = entry.fnMap[id];
        gaps.push({file: relativePath, line: map?.decl?.start?.line ?? map?.loc?.start?.line ?? 0,
            column: map?.decl?.start?.column ?? 0, dimension: 'function',
            detail: `函数 ${map?.name || '(匿名)'} 从未调用`, source: read(map?.loc?.start?.line ?? 0, context)});
    }
    for (const branch of findMissingBranches(entry)) {
        gaps.push({file: relativePath, line: branch.line, column: branch.column, dimension: 'branch',
            detail: `${branch.type} 的第 ${branch.index + 1}/${branch.total} 个出口未走（${branch.meaning}）`,
            source: read(branch.line, context)});
    }
    const order = {branch: 0, statement: 1, function: 2};
    return gaps.sort((left, right) => left.line - right.line || order[left.dimension] - order[right.dimension]);
}

function formatLocation(gap) {
    return `${gap.file}:${gap.line}${gap.column ? `:${gap.column}` : ''}`;
}

export function formatText(report, options = {}) {
    // 内部调用（门禁失败时）可能只传部分选项，这里必须兜底；否则 slice(0, undefined) 会静默丢掉全部缺口。
    const max = Number.isInteger(options.max) && options.max > 0 ? options.max : 20;
    const lines = [];
    lines.push(`覆盖率产物：${report.coveragePath}`);
    lines.push(`文件：${report.totals.files} 个参与统计，${report.totals.failing} 个未达 100%`);
    const total = report.totals.requirements;
    lines.push(`门禁：${['statements', 'branches', 'functions', 'lines']
        .map(key => `${key} ${report.totals.passed[key]}/${total[key]}`).join('  ')}`);
    if (!report.files.length) {
        lines.push('');
        lines.push('全部达标，无需补测。');
        return lines.join('\n');
    }
    for (const file of report.files) {
        const percent = key => (file[key].total ? `${file[key].covered}/${file[key].total}` : '0/0');
        lines.push('');
        lines.push(`✗ ${file.file}`);
        lines.push(`   语句 ${percent('statements')}  分支 ${percent('branches')}  函数 ${percent('functions')}  行 ${percent('lines')}`);
        const shown = file.gaps.slice(0, max);
        for (const [index, gap] of shown.entries()) {
            lines.push(`  [${index + 1}] ${formatLocation(gap)}  ${gap.dimension}  ${gap.detail}`);
            for (const row of gap.source) {
                const text = row.text.length > 160 ? `${row.text.slice(0, 157)}...` : row.text;
                lines.push(`      ${String(row.line).padStart(5)} │ ${text}`);
            }
        }
        if (file.gaps.length > shown.length) {
            lines.push(`  …还有 ${file.gaps.length - shown.length} 处，用 --max ${file.gaps.length} 全部展开`);
        }
    }
    return lines.join('\n');
}

export function analyze(coveragePath, options = {}) {
    if (!existsSync(coveragePath)) {
        throw new Error(`找不到覆盖率产物：${coveragePath}（先运行受影响测试或 pnpm test:coverage）`);
    }
    const raw = JSON.parse(readFileSync(coveragePath, 'utf8'));
    const entries = Object.values(raw).filter(entry => entry && entry.path);
    // 空产物通常意味着插桩未生效或产物被清空；此时报「全部达标」会把门禁失败误判为通过。
    if (!entries.length) throw new Error(`覆盖率产物没有有效条目：${coveragePath}`);
    const files = [];
    const passed = {statements: 0, branches: 0, functions: 0, lines: 0};
    const requirements = {statements: 0, branches: 0, functions: 0, lines: 0};
    let scoped = 0;
    for (const total of entries) {
        const relativePath = path.relative(PROJECT_ROOT, total.path).split(path.sep).join('/');
        if (options.file && !relativePath.includes(options.file)) continue;
        scoped += 1;
        const summary = summarizeFile(total);
        for (const key of Object.keys(passed)) {
            requirements[key] += summary[key].total;
            passed[key] += summary[key].covered;
        }
        const failing = Object.entries(summary).filter(([, value]) => value.covered < value.total);
        if (!failing.length) continue;
        const source = existsSync(total.path) ? readFileSync(total.path, 'utf8') : null;
        files.push({file: relativePath, ...summary, gaps: collectGaps(relativePath, total, source, options.context ?? 0)});
    }
    files.sort((left, right) => right.gaps.length - left.gaps.length);
    // 产物在仓库外（例如临时目录）时相对路径会退化成大量 ../，直接保留绝对路径便于定位。
    const shownPath = path.relative(PROJECT_ROOT, coveragePath).split(path.sep).join('/');
    return {coveragePath: shownPath.startsWith('..') ? coveragePath : shownPath, files,
        totals: {files: scoped, failing: files.length, passed, requirements}};
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArguments(argv);
    if (options.help) {
        console.log('node scripts/testing/coverage-gaps.mjs [--coverage <file>] [--file <substr>] [--max <n>] [--context <n>] [--json]');
        return;
    }
    const coveragePath = path.resolve(PROJECT_ROOT, options.coverage);
    const report = analyze(coveragePath, options);
    console.log(options.json ? JSON.stringify(report, null, 2) : formatText(report, options));
    // 与门禁一致：存在缺口即失败，避免被误当作纯信息输出。
    if (report.files.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch(error => {
        console.error(`[coverage-gaps] ${error.message}`);
        process.exitCode = 1;
    });
}
