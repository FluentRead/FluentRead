#!/usr/bin/env node

/**
 * PR 与本地定向回归共用变更依赖图；架构门禁与受影响行为测试一次去重执行，对改动的严格覆盖模块保留四维 100%。
 * 文件清单来自现有测试矩阵，外部边界、SFC 源码读取与资源路径同样纳入依赖追踪。
 * 本入口不启动浏览器、不调用在线供应商，也不把构建或静态归属描述为行为覆盖。
 */
import {spawn, execFileSync} from 'node:child_process';
import {appendFileSync, existsSync, readFileSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import ts from 'typescript';
import {analyze as analyzeCoverage, formatText as formatCoverageGaps} from './coverage-gaps.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const COVERAGE_CONFIG = 'tests/config/vitest.coverage.config.ts';
const LEGACY_COVERAGE_CONFIG = 'vitest.coverage.config.ts';
const GROUPS = ['architecture', 'unit', 'functional', 'regression'];
export const CODE = /\.(?:[cm]?[jt]sx?|vue|css|html|json)$/u;
export const DEPENDENCY_CONTENT = /^(?:src|entrypoints|userscript|scripts|tests|docs\/\.vitepress)\//u;
const GLOBAL_TEST_INPUTS = new Set(['.nvmrc', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json',
    'vitest.config.ts',
    'scripts/testing/vitest-resource-lock.mjs']);
// 只有这些字段改变才会影响测试的解析与执行环境；scripts、version、描述性字段不影响用例集合。
const PACKAGE_RUNTIME_FIELDS = ['type', 'imports', 'exports', 'engines', 'packageManager', 'dependencies',
    'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'workspaces', 'pnpm',
    'overrides', 'resolutions'];
// 这些是「前缀声明」而非「读取整个目录」：源码里出现 'src/'、'docs/' 常是在做 startsWith
// 判断或写架构规则，若回退成整个目录，会让一个字符串把数百个文件挂成依赖。
const PROJECT_ROOTS = new Set(['src', 'tests', 'scripts', 'entrypoints', 'userscript', 'docs', 'public', 'styles',
    'assets', 'docs/.vitepress']);
const slash = value => value.split(path.sep).join('/');

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

function references(source, filename) {
    const values = new Set();
    const templates = new Map();
    const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = node => {
        if (ts.isStringLiteralLike(node)) values.add(node.text);
        if (ts.isTemplateExpression(node)) {
            // 只记录静态片段；表达式既不执行，也不把不可解析的根路径扩大成整个源码树。
            const parts = [node.head.text, ...node.templateSpans.map(span => span.literal.text)];
            templates.set(JSON.stringify(parts), {parts});
        }
        ts.forEachChild(node, visit);
    };
    visit(ast);
    // Vue 模板、CSS @import 与夹具拼接的 import 源码未必是合法 TS；保留其中明确的项目文件路径。
    for (const match of source.matchAll(/(['"`])((?:@\/|\/src\/|src\/|scripts\/|tests\/|userscript\/|assets\/|\.\.?\/)[^'"`\n]+)\1/gu)) {
        values.add(match[2]);
    }
    return [...values, ...templates.values()];
}

function projectPath(owner, value) {
    let candidate;
    if (value.startsWith('@/')) candidate = value.slice(2);
    // '/src/' 常是 startsWith 比较用的字面量，本身不指向任何文件，必须要求后面还有路径段。
    else if (value.startsWith('/src/') && value.length > 5) candidate = value.slice(1);
    else if (/^(?:src|scripts|tests|userscript|entrypoints|docs|public|styles|assets)\//u.test(value)) candidate = value;
    // 只有 './' 与 '../' 才是相对模块路径；裸 '.' 是标点映射表里的普通字符串，
    // 若当作相对路径会解析成所在目录，再由目录回退把整层源码误算成依赖。
    else if (value.startsWith('./') || value.startsWith('../')) {
        // './'、'../'、'../../' 去掉前导点段后没有名称，同样不是模块引用；
        // 否则它们会归一化成所在目录或父目录，被目录回退当成整层依赖。
        if (!value.replace(/^(?:\.\.?\/)+/u, '')) return null;
        candidate = path.posix.normalize(path.posix.join(path.posix.dirname(owner), value));
    } else return null;
    return candidate;
}

/** 解析单个引用的落点；via 标明是精确命中还是目录回退，诊断时可据此判断依赖真假。 */
function resolveReference(known, owner, reference) {
    if (typeof reference !== 'string') {
        const [head, ...tails] = reference.parts;
        const prefix = projectPath(owner, head);
        if (!prefix || reference.parts.some(part => part.includes('\n'))) return {files: [], via: 'none'};
        const directory = head.endsWith('/') ? prefix.replace(/\/$/u, '') : path.posix.dirname(prefix);
        // 至少固定一个项目根内的子目录，例如 tests/fixtures 或 src/features。
        // `src/${name}`、`./${name}`、外部 URL 与越出仓库的路径没有可靠边界，要求调用者显式登记目录。
        if (!/^(?:src|entrypoints|userscript|scripts|tests|docs|public|styles|assets)\/[^/]+(?:\/[^/]+)*$/u.test(directory)
            || directory.split('/').some(part => part === '..' || part === '.')) return {files: [], via: 'none'};
        const parts = [prefix, ...tails];
        const query = parts.findIndex(part => /[?#]/u.test(part));
        if (query >= 0) {parts.splice(query + 1);parts[query] = parts[query].split(/[?#]/u)[0];}
        const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        const pattern = new RegExp('^' + parts.map(escape).join('.*') + '$', 'u');
        return {files: [...known].filter(file => file.startsWith(directory + '/') && pattern.test(file)), via: 'template'};
    }
    if (reference.includes('${') || reference.includes('\n')) return {files: [], via: 'none'};
    let candidate = projectPath(owner, reference);
    if (!candidate) return {files: [], via: 'none'};
    candidate = candidate.split(/[?#]/u)[0];
    const alternatives = [candidate, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.vue', '.json', '.css'].map(extension => candidate + extension),
        ...['index.ts', 'index.tsx', 'index.mts', 'index.js', 'index.vue'].map(index => `${candidate}/${index}`)];
    const exact = alternatives.find(item => known.has(item));
    if (exact) return {files: [exact], via: 'exact'};
    // 读取整个夹具目录也应受其中任一资源的变化影响。但空路径与项目根只是前缀声明
    // （例如源码里的 'src/'、'docs/' 用于 startsWith 判断），回退会把整层源码挂成依赖。
    const directory = candidate.replace(/\/+$/u, '');
    if (!directory || directory === '.' || directory === '..' || PROJECT_ROOTS.has(directory)) return {files: [], via: 'none'};
    return {files: [...known].filter(item => item.startsWith(directory + '/')), via: 'directory'};
}

/** 诊断：列出某个文件每条向上依赖的来源字符串与落点，回答「这条边从哪来」。 */
export function explainDependencies(owner, source, known) {
    return references(source, owner).map(reference => {
        const label = typeof reference === 'string' ? reference : reference.parts.join('${…}');
        const {files, via} = resolveReference(known, owner, reference);
        return {reference: label, via, files};
    }).filter(row => row.files.length);
}

export function buildDependencyGraph(files) {
    const graph = new Map();
    const known = new Set(Object.keys(files));
    for (const [owner, source] of Object.entries(files)) {
        graph.set(owner, new Set(CODE.test(owner)
            ? references(source, owner).flatMap(value => resolveReference(known, owner, value).files) : []));
    }
    return graph;
}

export function selectAffected({files, changed, matrix, coveragePaths, coverageAdded = [], coverageRuntimeChanged = false,
    inertGlobalInputs = []}) {
    const allTests = GROUPS.flatMap(group => matrix.groups?.[group] ?? []);
    if (new Set(allTests).size !== allTests.length) throw new Error('测试矩阵存在重复归类');
    const architecture = new Set(matrix.groups?.architecture ?? []);
    // 现有架构组也包含真实 runtime 消费者；统一进入同一次执行才能贡献严格覆盖。
    const architectureTests = allTests.filter(file => architecture.has(file) && Object.hasOwn(files, file));
    const behaviorTests = allTests.filter(file => !architecture.has(file) && Object.hasOwn(files, file));
    const nodes = {...files};
    for (const file of changed) nodes[file] ??= ''; // 被删除源码仍保留在解析空间内。
    const graph = buildDependencyGraph(nodes);
    const reverse = new Map();
    for (const [owner, dependencies] of graph) {
        for (const dependency of dependencies) {
            if (!reverse.has(dependency)) reverse.set(dependency, new Set());
            reverse.get(dependency).add(owner);
        }
    }
    const affected = new Set([...changed, ...coverageAdded]);
    const queue = [...affected];
    for (let index = 0; index < queue.length; index++) {
        for (const owner of reverse.get(queue[index]) ?? []) {
            if (!affected.has(owner)) {affected.add(owner);queue.push(owner);}
        }
    }
    // inertGlobalInputs 只用于撤销「文件被改但语义未变」的扩大，例如仅新增 npm script 的 package.json。
    const globalInputs = changed.filter(file => GLOBAL_TEST_INPUTS.has(file) && !inertGlobalInputs.includes(file));
    if (coverageRuntimeChanged) globalInputs.push(COVERAGE_CONFIG);
    const affectedBehaviorTests = globalInputs.length ? behaviorTests : behaviorTests.filter(file => affected.has(file));
    const testFiles = [...new Set([...architectureTests, ...affectedBehaviorTests])];
    const coverageFiles = coveragePaths.filter(file => (changed.includes(file) || coverageAdded.includes(file)) && Object.hasOwn(files, file));
    for (const file of coverageFiles) {
        const reachable = new Set([file]), pending = [file];
        for (let index = 0; index < pending.length; index++) {
            for (const owner of reverse.get(pending[index]) ?? []) {
                if (!reachable.has(owner)) {reachable.add(owner);pending.push(owner);}
            }
        }
        if (!testFiles.some(test => reachable.has(test))) throw new Error(`改动的严格覆盖模块没有可追踪行为测试：${file}`);
    }
    return {changed: [...changed].sort(), testFiles: testFiles.sort(), coverageFiles: coverageFiles.sort(),
        globalInputs, reason: globalInputs.length ? 'shared-test-configuration' : 'changed-dependency-graph',
        extensionChanged: changed.some(file => /^(?:src|entrypoints|userscript|public|styles|scripts|tests|assets)\//u.test(file)
            || /^(?:\.nvmrc|package\.json|pnpm-(?:lock|workspace)\.yaml|tsconfig\.json|wxt\.config\.ts|vitest[^/]*\.ts)$/u.test(file)
            || file === '.github/workflows/extension-quality.yml')};
}

export function createPlan(root, base) {
    const difference = changedPaths(root, base);
    const paths = [...new Set([...git(root, ['ls-files', '-z']).split('\0'), ...difference.paths].filter(Boolean))];
    const files = Object.fromEntries(paths.filter(file => existsSync(path.join(root, file)))
        .map(file => [file, CODE.test(file) && (DEPENDENCY_CONTENT.test(file) || !file.includes('/'))
            ? readFileSync(path.join(root, file), 'utf8') : '']));
    const coverageConfig = files[COVERAGE_CONFIG];
    const coveragePaths = strictCoveragePaths(coverageConfig);
    let coverageRuntimeChanged = false;
    let coverageAdded = [];
    if (difference.paths.includes(COVERAGE_CONFIG)) {
        const previousPath = git(root, ['ls-tree', '--name-only', difference.base, '--', COVERAGE_CONFIG]).trim()
            ? COVERAGE_CONFIG : LEGACY_COVERAGE_CONFIG;
        const previous = git(root, ['show', `${difference.base}:${previousPath}`]);
        coverageRuntimeChanged = coverageRuntimeSignature(previous, previousPath) !== coverageRuntimeSignature(coverageConfig);
        const previousPaths = new Set(strictCoveragePaths(previous));
        coverageAdded = coveragePaths.filter(file => !previousPaths.has(file));
    }
    // 仅改动 scripts、version 等字段时，package.json 不应把选择范围扩大到全部行为测试。
    let inertGlobalInputs = [];
    const baselineManifest = difference.paths.includes('package.json')
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
    return {base: difference.base, head: git(root, ['rev-parse', 'HEAD']).trim(),
        ...selectAffected({files, changed: difference.paths, matrix: JSON.parse(files['tests/test-matrix.json']),
            coveragePaths, coverageAdded, coverageRuntimeChanged, inertGlobalInputs})};
}

export function scopedCoverageConfig(plan, baseConfigUrl) {
    // V8 插桩下，仓库扫描与大型样本在 CI 中曾耗时超过 Vitest 默认的 5 秒。
    return `import base from ${JSON.stringify(baseConfigUrl)};\nexport default {...base,test:{...base.test,testTimeout:30_000,include:${JSON.stringify(plan.testFiles)},coverage:{...base.test.coverage,enabled:true,all:true,reportOnFailure:true,include:${JSON.stringify(plan.coverageFiles)},reportsDirectory:'coverage/affected',thresholds:{...base.test.coverage.thresholds,statements:100,branches:100,functions:100,lines:100,perFile:true}}}};\n`;
}

export function testInvocation(plan, configPath) {
    if (!plan.testFiles.length) return null;
    return plan.coverageFiles.length
        ? ['exec', 'vitest', 'run', '--config', configPath]
        : ['exec', 'vitest', 'run', ...plan.testFiles];
}

function run(root, args) {
    return new Promise((resolve, reject) => {
        const child = spawn('pnpm', args, {cwd: root, stdio: 'inherit', shell: false, env: process.env});
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
        console.error(formatCoverageGaps(report, {max: 3}));
        console.error('');
    } catch {
        // 产物缺失或格式异常不得掩盖原始失败原因。
    }
}

export async function executePlan(root, plan, runner = run) {
    const directory = path.join(root, 'coverage', 'affected-plan');
    mkdirSync(directory, {recursive: true});
    // 运行产物由 Vite 加载；不作为源码参与并行的 TypeScript/Vue 全工程检查。
    const configPath = path.join(directory, 'vitest.affected.config.mjs');
    const args = testInvocation(plan, configPath);
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
    const lines = [
        `基线 ${plan.base.slice(0, 7)} → ${plan.head.slice(0, 7)}，选择原因 ${plan.reason}`,
        `改动 ${plan.changed.length} 个文件`,
        `将运行 ${plan.testFiles.length} 个测试文件`,
        `严格覆盖 ${plan.coverageFiles.length} 个源文件（statements/branches/functions/lines 各 100%）`,
        `扩展产物受影响 ${plan.extensionChanged ? '是（含类型检查、Chrome/Firefox 与 userscript 构建）' : '否'}`,
    ];
    if (plan.globalInputs.length) lines.push(`共享测试输入 ${plan.globalInputs.join(', ')}（整体扩大到全部行为测试）`);
    return lines.join('\n');
}

export async function main(argv = process.argv.slice(2), env = process.env) {
    const allowed = new Set(['--base', '--report', '--plan-only', '--summary', '--help']);
    const options = {};
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (!allowed.has(arg)) throw new Error(`未知参数：${arg}`);
        if (arg === '--base' || arg === '--report') {
            const value = argv[++index];
            if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
            options[arg] = value;
        } else options[arg] = true;
    }
    if (options['--help']) {
        console.log('node scripts/testing/run-affected-tests.mjs --base <git-ref> [--report <json>] [--plan-only] [--summary]');
        return;
    }
    const plan = createPlan(PROJECT_ROOT, options['--base'] ?? env.FLUENTREAD_CI_BASE);
    if (options['--report']) {
        const report = path.resolve(PROJECT_ROOT, options['--report']);
        mkdirSync(path.dirname(report), {recursive: true});
        writeFileSync(report, JSON.stringify(plan, null, 2) + '\n');
    }
    console.log(options['--summary'] ? renderSummary(plan) : JSON.stringify(plan, null, 2));
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `extension_changed=${plan.extensionChanged}\n`);
    if (!options['--plan-only']) await executePlan(PROJECT_ROOT, plan);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch(error => {console.error(`[affected-tests] ${error.message}`);process.exitCode = 1;});
}
