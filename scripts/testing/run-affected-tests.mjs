#!/usr/bin/env node

/**
 * @file scripts/testing/run-affected-tests.mjs
 * 文件职责：基于同源 AST 依赖图与两级架构门禁，规划并执行受本次改动影响的测试与严格覆盖率检查。
 * 主要内容：
 * - 复用 dependency-graph.mjs 的按符号 barrel 解析、纯类型过滤与注册表隔离能力，大幅减少无关测试误触发；
 * - 将架构测试分为「全局仓库不变量门禁（tests/architecture/*.test.ts，始终运行）」与「领域契约测试（按依赖图精确触发）」；
 * - 支持 --base、--files、--all-architecture、--reporter（默认 dot，降低终端与上下文 token 消耗）、--summary 与 --plan-only；
 * - 严格覆盖率门禁失败时自动复用 istanbul 产物输出精确缺口行号。
 * 模块边界：不启动浏览器、不调用在线供应商，也不把构建或静态归属描述为行为覆盖。
 */
import {spawn, execFileSync} from 'node:child_process';
import {appendFileSync, existsSync, readFileSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import ts from 'typescript';
import {analyze as analyzeCoverage, formatText as formatCoverageGaps} from './coverage-gaps.mjs';
import {
    CODE,
    DEPENDENCY_CONTENT,
    analyzeDependencyGraph,
    buildDependencyGraph,
    collectAffectedClosure,
    explainDependencies,
} from './dependency-graph.mjs';

export {CODE, DEPENDENCY_CONTENT, analyzeDependencyGraph, buildDependencyGraph, collectAffectedClosure, explainDependencies};

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const COVERAGE_CONFIG = 'tests/config/vitest.coverage.config.ts';
const LEGACY_COVERAGE_CONFIG = 'vitest.coverage.config.ts';
const GROUPS = ['architecture', 'unit', 'functional', 'regression'];
export const REPO_WIDE_ARCHITECTURE_GATE = /^tests\/architecture\/.*\.test\.ts$/u;
const GLOBAL_TEST_INPUTS = new Set(['.nvmrc', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json',
    'vitest.config.ts',
    'scripts/testing/vitest-resource-lock.mjs']);
// 只有这些字段改变才会影响测试的解析与执行环境；scripts、version、描述性字段不影响用例集合。
const PACKAGE_RUNTIME_FIELDS = ['type', 'imports', 'exports', 'engines', 'packageManager', 'dependencies',
    'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'workspaces', 'pnpm',
    'overrides', 'resolutions'];

/** 键序稳定化：依赖字段可能被包管理器重排，键序不同不代表依赖变化。 */
function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort()
            .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

/** 提取 package.json 中真正影响测试行为的字段签名；无法解析时抛错，由调用方退回全量。 */
export function packageJsonRuntimeSignature(source) {
    const parsed = JSON.parse(source);
    const selected = {};
    for (const field of PACKAGE_RUNTIME_FIELDS) {
        if (parsed[field] !== undefined) selected[field] = parsed[field];
    }
    return stableStringify(selected);
}

function git(root, args) {
    // stderr 一并捕获：`git show <ref>:<path>` 在路径缺席时会打印 fatal，不能污染命令输出。
    return execFileSync('git', args, {cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe']});
}

export function changedPaths(root, base) {
    if (!base || base.startsWith('-')) throw new Error('必须提供有效的 Git 基线');
    const reference = /^0+$/u.test(base) ? 'HEAD^' : base;
    const resolved = git(root, ['rev-parse', '--verify', `${reference}^{commit}`]).trim();
    // 不启用 rename detection，旧路径与新路径都进入图，避免删除的依赖悄悄脱离筛选。
    const changed = git(root, ['diff', '--name-only', '--no-renames', '-z', resolved, '--']).split('\0');
    const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0');
    return {base: resolved, paths: [...new Set([...changed, ...untracked].filter(Boolean))].sort()};
}

export function strictCoveragePaths(source) {
    const ast = ts.createSourceFile(COVERAGE_CONFIG, source, ts.ScriptTarget.Latest, true);
    let include;
    const visit = node => {
        if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'coverage'
            && ts.isObjectLiteralExpression(node.initializer)) {
            const property = node.initializer.properties.find(item => ts.isPropertyAssignment(item)
                && item.name.getText(ast) === 'include');
            if (!property || !ts.isArrayLiteralExpression(property.initializer)
                || property.initializer.elements.some(item => !ts.isStringLiteral(item))) {
                throw new Error('严格覆盖率 include 必须保留显式源码路径清单');
            }
            include = property.initializer.elements.map(item => item.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(ast);
    if (!include) throw new Error('未找到严格覆盖率源码边界');
    return [...new Set(include)];
}

export function coverageRuntimeSignature(source, configPath = COVERAGE_CONFIG) {
    const ast = ts.createSourceFile(configPath, source, ts.ScriptTarget.Latest, true);
    const configDirectory = path.posix.dirname(configPath);
    const transformed = ts.transform(ast, [context => root => {
        const visit = node => {
            // 配置移动时，相对导入按各自位置还原为仓库内的同一个路径。
            if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith('.')) {
                const modulePath = path.posix.join(configDirectory, node.moduleSpecifier.text);
                return ts.factory.updateImportDeclaration(node, node.modifiers, node.importClause,
                    ts.factory.createStringLiteral(`./${modulePath}`), node.attributes);
            }
            // 只登记新覆盖源码/测试不会改变执行环境；plugins、时钟、阈值或其他设置变化仍扩大行为范围。
            if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'include'
                && ts.isObjectLiteralExpression(node.parent) && ts.isPropertyAssignment(node.parent.parent)
                && ['coverage', 'test'].includes(node.parent.parent.name.getText(ast))) {
                return ts.factory.updatePropertyAssignment(node, node.name, ts.factory.createArrayLiteralExpression());
            }
            return ts.visitEachChild(node, visit, context);
        };
        return ts.visitNode(root, visit);
    }]);
    try {return ts.createPrinter({removeComments: true}).printFile(transformed.transformed[0]);}
    finally {transformed.dispose();}
}

export function selectAffected({
    files,
    changed,
    matrix,
    coveragePaths,
    coverageAdded = [],
    coverageRuntimeChanged = false,
    inertGlobalInputs = [],
    allArchitecture = false,
}) {
    const allTests = GROUPS.flatMap(group => matrix.groups?.[group] ?? []);
    if (new Set(allTests).size !== allTests.length) throw new Error('测试矩阵存在重复归类');
    const architecture = new Set(matrix.groups?.architecture ?? []);
    // 只有 tests/architecture/*.test.ts 属于全仓库不变量门禁（始终运行）；
    // 其余 architecture 契约测试（如 userscriptViteConfig、firefoxAmoLint、各后台 handler）按依赖图精确触发。
    const alwaysRunArchitecture = allTests.filter(file => architecture.has(file)
        && (allArchitecture || REPO_WIDE_ARCHITECTURE_GATE.test(file))
        && Object.hasOwn(files, file));
    const alwaysRunSet = new Set(alwaysRunArchitecture);
    const scopedTests = allTests.filter(file => !alwaysRunSet.has(file) && Object.hasOwn(files, file));

    const nodes = {...files};
    for (const file of changed) nodes[file] ??= ''; // 被删除源码仍保留在解析空间内。
    const {reverse} = analyzeDependencyGraph(nodes);
    const affected = collectAffectedClosure(reverse, [...changed, ...coverageAdded]);

    // inertGlobalInputs 只用于撤销「文件被改但语义未变」的扩大，例如仅新增 npm script 的 package.json。
    const globalInputs = changed.filter(file => GLOBAL_TEST_INPUTS.has(file) && !inertGlobalInputs.includes(file));
    if (coverageRuntimeChanged) globalInputs.push(COVERAGE_CONFIG);
    const affectedScopedTests = globalInputs.length ? scopedTests : scopedTests.filter(file => affected.has(file));
    const testFiles = [...new Set([...alwaysRunArchitecture, ...affectedScopedTests])].sort();
    const coverageFiles = coveragePaths.filter(file => (changed.includes(file) || coverageAdded.includes(file)) && Object.hasOwn(files, file));
    for (const file of coverageFiles) {
        const reachable = collectAffectedClosure(reverse, [file]);
        if (!testFiles.some(test => reachable.has(test))) throw new Error(`改动的严格覆盖模块没有可追踪行为测试：${file}`);
    }
    return {
        changed: [...changed].sort(),
        testFiles,
        alwaysRunArchitecture: [...alwaysRunArchitecture].sort(),
        affectedScopedTests: [...affectedScopedTests].sort(),
        coverageFiles: coverageFiles.sort(),
        globalInputs,
        reason: globalInputs.length ? 'shared-test-configuration' : 'changed-dependency-graph',
        extensionChanged: changed.some(file => /^(?:src|entrypoints|userscript|public|styles|scripts|tests|assets)\//u.test(file)
            || /^(?:\.nvmrc|package\.json|pnpm-(?:lock|workspace)\.yaml|tsconfig\.json|wxt\.config\.ts|vitest[^/]*\.ts)$/u.test(file)
            || file === '.github/workflows/extension-quality.yml'),
    };
}

export function loadWorkspaceFiles(root, extraPaths = []) {
    const paths = [...new Set([
        ...git(root, ['ls-files', '-z']).split('\0'),
        ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
        ...extraPaths,
    ].filter(Boolean))];
    return Object.fromEntries(paths.filter(file => existsSync(path.join(root, file)))
        .map(file => [file, CODE.test(file) && (DEPENDENCY_CONTENT.test(file) || !file.includes('/'))
            ? readFileSync(path.join(root, file), 'utf8') : '']));
}

export function createPlan(root, base, options = {}) {
    const difference = options.explicitFiles
        ? {base: git(root, ['rev-parse', 'HEAD']).trim(), paths: [...new Set(options.explicitFiles)].sort()}
        : changedPaths(root, base);
    const files = loadWorkspaceFiles(root, difference.paths);
    const coverageConfig = files[COVERAGE_CONFIG];
    const coveragePaths = strictCoveragePaths(coverageConfig);
    let coverageRuntimeChanged = false;
    let coverageAdded = [];
    if (!options.explicitFiles && difference.paths.includes(COVERAGE_CONFIG)) {
        const previousPath = git(root, ['ls-tree', '--name-only', difference.base, '--', COVERAGE_CONFIG]).trim()
            ? COVERAGE_CONFIG : LEGACY_COVERAGE_CONFIG;
        const previous = git(root, ['show', `${difference.base}:${previousPath}`]);
        coverageRuntimeChanged = coverageRuntimeSignature(previous, previousPath) !== coverageRuntimeSignature(coverageConfig);
        const previousPaths = new Set(strictCoveragePaths(previous));
        coverageAdded = coveragePaths.filter(file => !previousPaths.has(file));
    }
    // 仅改动 scripts、version 等字段时，package.json 不应把选择范围扩大到全部行为测试。
    let inertGlobalInputs = [];
    const baselineManifest = !options.explicitFiles && difference.paths.includes('package.json')
        && git(root, ['ls-tree', '--name-only', difference.base, '--', 'package.json']).trim();
    if (baselineManifest && Object.hasOwn(files, 'package.json')) {
        try {
            const previous = git(root, ['show', `${difference.base}:package.json`]);
            if (packageJsonRuntimeSignature(previous) === packageJsonRuntimeSignature(files['package.json'])) {
                inertGlobalInputs = ['package.json'];
            }
        } catch {
            // 基线缺失或 JSON 不可解析时保持原有全量扩大，不静默缩小验证范围。
        }
    }
    return {
        base: difference.base,
        head: git(root, ['rev-parse', 'HEAD']).trim(),
        ...selectAffected({
            files,
            changed: difference.paths,
            matrix: JSON.parse(files['tests/test-matrix.json']),
            coveragePaths,
            coverageAdded,
            coverageRuntimeChanged,
            inertGlobalInputs,
            allArchitecture: Boolean(options.allArchitecture),
        }),
    };
}

export function scopedCoverageConfig(plan, baseConfigUrl) {
    // V8 插桩下，仓库扫描与大型样本在 CI 中曾耗时超过 Vitest 默认的 5 秒。
    return `import base from ${JSON.stringify(baseConfigUrl)};\nexport default {...base,test:{...base.test,testTimeout:30_000,include:${JSON.stringify(plan.testFiles)},coverage:{...base.test.coverage,enabled:true,all:true,reportOnFailure:true,include:${JSON.stringify(plan.coverageFiles)},reportsDirectory:'coverage/affected',thresholds:{...base.test.coverage.thresholds,statements:100,branches:100,functions:100,lines:100,perFile:true}}}};\n`;
}

export function testInvocation(plan, configPath, options = {}) {
    if (!plan.testFiles.length) return null;
    const reporter = options.reporter ?? 'dot';
    const reporterArgs = reporter ? [`--reporter=${reporter}`] : [];
    return plan.coverageFiles.length
        ? ['exec', 'vitest', 'run', ...reporterArgs, '--config', configPath]
        : ['exec', 'vitest', 'run', ...reporterArgs, ...plan.testFiles];
}

function vitestEnv(baseEnv = process.env) {
    // 非 TTY 管道下 Vitest 5 的 dot reporter 会重复重绘进度条，产生数十 KB 无效输出；设置 CI=1 抑制重绘并保留完整失败栈。
    if (!process.stdout.isTTY && baseEnv.CI === undefined) return {...baseEnv, CI: '1'};
    return baseEnv;
}

function run(root, args) {
    return new Promise((resolve, reject) => {
        const child = spawn('pnpm', args, {cwd: root, stdio: 'inherit', shell: false, env: vitestEnv()});
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({code, signal}));
    });
}

/**
 * 覆盖率门禁失败时附带缺口清单：Vitest 只报告文件名和百分比，不指出具体行。
 * 复用同一份 istanbul 产物，让 CI 日志一次给出可改代码的位置，省掉一轮重跑。
 */
function reportCoverageGaps(root, plan) {
    if (!plan.coverageFiles.length) return;
    try {
        const report = analyzeCoverage(path.join(root, 'coverage', 'affected', 'coverage-final.json'));
        if (!report.files.length) return;
        console.error(`\n[affected-tests] 严格覆盖率缺口：${report.totals.failing} 个文件未达 100%\n`);
        console.error(formatCoverageGaps(report, {max: 5}));
        console.error('');
    } catch {
        // 产物缺失或格式异常不得掩盖原始失败原因。
    }
}

export async function executePlan(root, plan, runner = run, options = {}) {
    const directory = path.join(root, 'coverage', 'affected-plan');
    mkdirSync(directory, {recursive: true});
    // 运行产物由 Vite 加载；不作为源码参与并行的 TypeScript/Vue 全工程检查。
    const configPath = path.join(directory, 'vitest.affected.config.mjs');
    const args = testInvocation(plan, configPath, options);
    if (!args) return {skipped: true, reason: 'no-affected-behavior-tests'};
    try {
        if (plan.coverageFiles.length) writeFileSync(configPath, scopedCoverageConfig(plan, path.join(root, COVERAGE_CONFIG)));
        const result = await runner(root, args);
        if (result.code !== 0 || result.signal) {
            reportCoverageGaps(root, plan);
            throw new Error(`受影响测试失败：退出码 ${result.code ?? 'none'}，信号 ${result.signal ?? 'none'}`);
        }
        return {skipped: false};
    } finally {
        rmSync(configPath, {force: true});
    }
}

/** 人读摘要：只给出规模与影响面，避免把数百个测试路径刷进终端和上下文。 */
export function renderSummary(plan) {
    const archCount = plan.alwaysRunArchitecture?.length ?? 0;
    const scopedCount = plan.affectedScopedTests?.length ?? Math.max(0, plan.testFiles.length - archCount);
    const lines = [
        `基线 ${plan.base.slice(0, 7)} → ${plan.head.slice(0, 7)}，选择原因 ${plan.reason}`,
        `改动 ${plan.changed.length} 个文件`,
        `将运行 ${plan.testFiles.length} 个测试文件（全局架构门禁 ${archCount} + 受影响测试 ${scopedCount}）`,
        `严格覆盖 ${plan.coverageFiles.length} 个源文件（statements/branches/functions/lines 各 100%）`,
        `扩展产物受影响 ${plan.extensionChanged ? '是（含类型检查、Chrome/Firefox 与 userscript 构建）' : '否'}`,
    ];
    if (plan.globalInputs.length) lines.push(`共享测试输入 ${plan.globalInputs.join(', ')}（整体扩大到全部行为测试）`);
    return lines.join('\n');
}

export async function main(argv = process.argv.slice(2), env = process.env) {
    const allowed = new Set(['--base', '--report', '--files', '--reporter', '--plan-only', '--summary', '--all-architecture', '--help']);
    const options = {};
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--') continue;
        if (!allowed.has(arg)) throw new Error(`未知参数：${arg}`);
        if (arg === '--base' || arg === '--report' || arg === '--files' || arg === '--reporter') {
            const value = argv[++index];
            if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
            options[arg] = value;
        } else options[arg] = true;
    }
    if (options['--help']) {
        console.log('node scripts/testing/run-affected-tests.mjs [--base <git-ref> | --files <p1,p2>] [--report <json>] [--reporter <name>] [--all-architecture] [--plan-only] [--summary]');
        return;
    }
    const explicitFiles = options['--files']
        ? options['--files'].split(',').map(item => item.trim().replaceAll('\\', '/').replace(/^\.\//u, '')).filter(Boolean)
        : null;
    const plan = createPlan(PROJECT_ROOT, options['--base'] ?? env.FLUENTREAD_CI_BASE ?? 'origin/main', {
        explicitFiles,
        allArchitecture: Boolean(options['--all-architecture']),
    });
    if (options['--report']) {
        const report = path.resolve(PROJECT_ROOT, options['--report']);
        mkdirSync(path.dirname(report), {recursive: true});
        writeFileSync(report, JSON.stringify(plan, null, 2) + '\n');
    }
    console.log(options['--summary'] ? renderSummary(plan) : JSON.stringify(plan, null, 2));
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `extension_changed=${plan.extensionChanged}\n`);
    if (!options['--plan-only']) await executePlan(PROJECT_ROOT, plan, run, {reporter: options['--reporter'] ?? 'dot'});
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch(error => {console.error(`[affected-tests] ${error.message}`);process.exitCode = 1;});
}
