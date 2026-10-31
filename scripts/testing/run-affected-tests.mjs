#!/usr/bin/env node

/**
 * PR 与本地定向回归共用变更依赖图；架构门禁与受影响行为测试一次去重执行，对改动的严格覆盖模块保留四维 100%。
 * 文件清单来自现有测试矩阵，外部边界、SFC 源码读取与资源路径同样纳入依赖追踪。
 * 本入口不启动浏览器、不调用在线供应商，也不把构建或静态归属描述为行为覆盖。
 */
import {spawn, execFileSync} from 'node:child_process';
import {existsSync, readFileSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import ts from 'typescript';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const GROUPS = ['architecture', 'unit', 'functional', 'regression'];
const CODE = /\.(?:[cm]?[jt]sx?|vue|css|html|json)$/u;
const DEPENDENCY_CONTENT = /^(?:src|entrypoints|userscript|integrations|scripts|tests|docs\/\.vitepress)\//u;
const GLOBAL_TEST_INPUTS = new Set(['package.json', 'pnpm-lock.yaml', 'tsconfig.json',
    'vitest.config.ts',
    'scripts/testing/vitest-resource-lock.mjs']);
const slash = value => value.split(path.sep).join('/');

function git(root, args) {
    return execFileSync('git', args, {cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
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
    const ast = ts.createSourceFile('vitest.coverage.config.ts', source, ts.ScriptTarget.Latest, true);
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

export function coverageRuntimeSignature(source) {
    const ast = ts.createSourceFile('coverage.ts', source, ts.ScriptTarget.Latest, true);
    const transformed = ts.transform(ast, [context => root => {
        const visit = node => {
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
    for (const match of source.matchAll(/(['"`])((?:@\/|\/src\/|src\/|scripts\/|tests\/|userscript\/|integrations\/|assets\/|\.\.?\/)[^'"`\n]+)\1/gu)) {
        values.add(match[2]);
    }
    return [...values, ...templates.values()];
}

export function buildDependencyGraph(files) {
    const graph = new Map();
    const known = new Set(Object.keys(files));
    const projectPath = (owner, value) => {
        let candidate;
        if (value.startsWith('@/')) candidate = value.slice(2);
        else if (value.startsWith('/src/')) candidate = value.slice(1);
        else if (/^(?:src|scripts|tests|userscript|integrations|entrypoints|docs|public|styles|assets)\//u.test(value)) candidate = value;
        else if (value.startsWith('.')) candidate = path.posix.normalize(path.posix.join(path.posix.dirname(owner), value));
        else return null;
        return candidate;
    };
    const resolveReference = (owner, reference) => {
        if (typeof reference !== 'string') {
            const [head, ...tails] = reference.parts;
            const prefix = projectPath(owner, head);
            if (!prefix || reference.parts.some(part => part.includes('\n'))) return [];
            const directory = head.endsWith('/') ? prefix.replace(/\/$/u, '') : path.posix.dirname(prefix);
            // 至少固定一个项目根内的子目录，例如 tests/fixtures 或 src/features。
            // `src/${name}`、`./${name}`、外部 URL 与越出仓库的路径没有可靠边界，要求调用者显式登记目录。
            if (!/^(?:src|entrypoints|userscript|integrations|scripts|tests|docs|public|styles|assets)\/[^/]+(?:\/[^/]+)*$/u.test(directory)
                || directory.split('/').some(part => part === '..' || part === '.')) return [];
            const parts = [prefix, ...tails];
            const query = parts.findIndex(part => /[?#]/u.test(part));
            if (query >= 0) {parts.splice(query + 1);parts[query] = parts[query].split(/[?#]/u)[0];}
            const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
            const pattern = new RegExp('^' + parts.map(escape).join('.*') + '$', 'u');
            return [...known].filter(file => file.startsWith(directory + '/') && pattern.test(file));
        }
        if (reference.includes('${') || reference.includes('\n')) return [];
        let candidate = projectPath(owner, reference);
        if (!candidate) return [];
        candidate = candidate.split(/[?#]/u)[0];
        const alternatives = [candidate, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.vue', '.json', '.css'].map(extension => candidate + extension),
            ...['index.ts', 'index.tsx', 'index.mts', 'index.js', 'index.vue'].map(index => `${candidate}/${index}`)];
        const exact = alternatives.find(item => known.has(item));
        if (exact) return [exact];
        // 读取整个夹具目录也应受其中任一资源的变化影响。
        return [...known].filter(item => item.startsWith(candidate.replace(/\/$/u, '') + '/'));
    };
    for (const [owner, source] of Object.entries(files)) {
        graph.set(owner, new Set(CODE.test(owner) ? references(source, owner).flatMap(value => resolveReference(owner, value)) : []));
    }
    return graph;
}

export function selectAffected({files, changed, matrix, coveragePaths, coverageAdded = [], coverageRuntimeChanged = false}) {
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
    const globalInputs = changed.filter(file => GLOBAL_TEST_INPUTS.has(file));
    if (coverageRuntimeChanged) globalInputs.push('vitest.coverage.config.ts');
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
        extensionChanged: changed.some(file => /^(?:src|entrypoints|userscript|integrations|public|styles|scripts|tests|assets)\//u.test(file)
            || /^(?:package\.json|pnpm-lock\.yaml|tsconfig\.json|wxt\.config\.ts|vitest[^/]*\.ts)$/u.test(file)
            || file === '.github/workflows/extension-quality.yml')};
}

export function createPlan(root, base) {
    const difference = changedPaths(root, base);
    const paths = [...new Set([...git(root, ['ls-files', '-z']).split('\0'), ...difference.paths].filter(Boolean))];
    const files = Object.fromEntries(paths.filter(file => existsSync(path.join(root, file)))
        .map(file => [file, CODE.test(file) && (DEPENDENCY_CONTENT.test(file) || !file.includes('/'))
            ? readFileSync(path.join(root, file), 'utf8') : '']));
    let coverageRuntimeChanged = false;
    let coverageAdded = [];
    if (difference.paths.includes('vitest.coverage.config.ts')) {
        const previous = git(root, ['show', `${difference.base}:vitest.coverage.config.ts`]);
        coverageRuntimeChanged = coverageRuntimeSignature(previous) !== coverageRuntimeSignature(files['vitest.coverage.config.ts']);
        const previousPaths = new Set(strictCoveragePaths(previous));
        coverageAdded = strictCoveragePaths(files['vitest.coverage.config.ts']).filter(file => !previousPaths.has(file));
    }
    return {base: difference.base, head: git(root, ['rev-parse', 'HEAD']).trim(),
        ...selectAffected({files, changed: difference.paths, matrix: JSON.parse(files['tests/test-matrix.json']),
            coveragePaths: strictCoveragePaths(files['vitest.coverage.config.ts']), coverageAdded, coverageRuntimeChanged})};
}

export function scopedCoverageConfig(plan, baseConfigUrl) {
    return `import base from ${JSON.stringify(baseConfigUrl)};\nexport default {...base,test:{...base.test,include:${JSON.stringify(plan.testFiles)},coverage:{...base.test.coverage,enabled:true,all:true,reportOnFailure:true,include:${JSON.stringify(plan.coverageFiles)},reportsDirectory:'coverage/affected',thresholds:{...base.test.coverage.thresholds,statements:100,branches:100,functions:100,lines:100,perFile:true}}}};\n`;
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

export async function executePlan(root, plan, runner = run) {
    const directory = path.join(root, 'coverage', 'affected-plan');
    mkdirSync(directory, {recursive: true});
    // 运行产物由 Vite 加载；不作为源码参与并行的 TypeScript/Vue 全工程检查。
    const configPath = path.join(directory, 'vitest.affected.config.mjs');
    const args = testInvocation(plan, configPath);
    if (!args) return {skipped: true, reason: 'no-affected-behavior-tests'};
    try {
        if (plan.coverageFiles.length) writeFileSync(configPath, scopedCoverageConfig(plan, path.join(root, 'vitest.coverage.config.ts')));
        const result = await runner(root, args);
        if (result.code !== 0 || result.signal) throw new Error(`受影响测试失败：退出码 ${result.code ?? 'none'}，信号 ${result.signal ?? 'none'}`);
        return {skipped: false};
    } finally {
        rmSync(configPath, {force: true});
    }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
    const allowed = new Set(['--base', '--report', '--plan-only', '--help']);
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
        console.log('node scripts/testing/run-affected-tests.mjs --base <git-ref> [--report <json>] [--plan-only]');
        return;
    }
    const plan = createPlan(PROJECT_ROOT, options['--base'] ?? env.FLUENTREAD_CI_BASE);
    if (options['--report']) {
        const report = path.resolve(PROJECT_ROOT, options['--report']);
        mkdirSync(path.dirname(report), {recursive: true});
        writeFileSync(report, JSON.stringify(plan, null, 2) + '\n');
    }
    console.log(JSON.stringify(plan, null, 2));
    if (env.GITHUB_OUTPUT) {
        const {appendFileSync} = await import('node:fs');
        appendFileSync(env.GITHUB_OUTPUT, `extension_changed=${plan.extensionChanged}\n`);
    }
    if (!options['--plan-only']) await executePlan(PROJECT_ROOT, plan);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch(error => {console.error(`[affected-tests] ${error.message}`);process.exitCode = 1;});
}
