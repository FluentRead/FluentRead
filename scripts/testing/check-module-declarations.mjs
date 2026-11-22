#!/usr/bin/env node

/**
 * @file scripts/testing/check-module-declarations.mjs
 * 手写声明一致性检查：与 `X.mjs` 同名的 `X.d.mts` 必须覆盖全部运行时导出。
 *
 * 主要内容：
 * - 扫描仓库内的 `*.d.mts`，配对同目录下的同名 `.mjs` / `.cjs`；
 * - 用 TypeScript AST 提取两侧的顶层导出：`.mjs` 只关心值导出，`.d.mts` 区分值与纯类型；
 * - 报告两类问题：`.mjs` 有导出但声明未登记（`.ts` 侧 import 会报 TS2305）；
 *   声明为值但 `.mjs` 未导出（运行时拿到 undefined）。
 *
 * 模块边界：纯只读静态检查，不执行被测模块、不生成声明、不修改文件；不参与构建与运行时。
 * 用法：node scripts/testing/check-module-declarations.mjs [--root <dir>] [--json]
 *
 * 背景：`tsc` 解析 `import '.../x.mjs'` 时会优先读取同名的 `x.d.mts`，而不是从 `.mjs`
 * 推断类型。因此新增导出只改 `.mjs` 时，本地 vitest（esbuild 不做类型检查）全绿，
 * CI 的类型检查才会以 TS2305 失败。本脚本把这一步提前到本地。
 */

import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import ts from 'typescript';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SKIPPED = new Set(['node_modules', '.git', '.wxt', '.output', 'coverage', 'dist']);
const DECLARATION = /\.d\.mts$/u;

function parseArguments(argv) {
    const options = {root: PROJECT_ROOT, json: false};
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--help') return {help: true};
        if (argument === '--json') {
            options.json = true;
            continue;
        }
        if (argument !== '--root') throw new Error(`未知参数：${argument}`);
        const value = argv[++index];
        if (value === undefined || value.startsWith('--')) throw new Error('--root 缺少值');
        options.root = path.resolve(value);
    }
    return options;
}

/** 递归收集声明文件；跳过依赖、构建产物与覆盖率目录。 */
export function findDeclarations(root) {
    const found = [];
    const walk = directory => {
        for (const entry of readdirSync(directory, {withFileTypes: true})) {
            if (entry.isDirectory()) {
                if (!SKIPPED.has(entry.name)) walk(path.join(directory, entry.name));
                continue;
            }
            if (entry.isFile() && DECLARATION.test(entry.name)) found.push(path.join(directory, entry.name));
        }
    };
    if (statSync(root).isDirectory()) walk(root);
    return found.sort();
}

function collectBindingNames(name, add) {
    if (ts.isIdentifier(name)) {
        add(name.text);
        return;
    }
    // `export const {a, b: c} = obj` 与数组解构，逐个登记实际绑定的名字。
    for (const element of name.elements) {
        if (ts.isBindingElement(element)) collectBindingNames(element.name, add);
    }
}

/**
 * 提取顶层导出。kind 为 `value` 时是运行时可访问的绑定，`type` 时只有类型信息。
 * `.mjs` 里 `interface`/`type` 不合法，因此只会有 value。
 */
export function exportedNames(source, filename) {
    const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const names = new Map();
    const add = (name, kind) => {
        if (name && !names.has(name)) names.set(name, kind);
    };
    for (const statement of ast.statements) {
        const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
        const exported = modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
        if (exported) {
            if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) add(statement.name?.text, 'value');
            else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) add(statement.name.text, 'type');
            else if (ts.isEnumDeclaration(statement)) add(statement.name.text, 'value');
            else if (ts.isVariableStatement(statement)) {
                for (const declaration of statement.declarationList.declarations) {
                    collectBindingNames(declaration.name, name => add(name, 'value'));
                }
            }
        }
        // `export {a, b as c}`：导出名是 c，不是 b。
        if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
            for (const element of statement.exportClause.elements) add(element.name.text, 'value');
        }
        if (ts.isExportAssignment(statement) && !statement.isExportEquals) add('default', 'value');
    }
    return names;
}

/** 对比一对文件，返回缺失导出与多余值声明。 */
export function comparePair(implementationSource, declarationSource, filename) {
    const implementation = exportedNames(implementationSource, filename);
    const declaration = exportedNames(declarationSource, `${filename}.d.mts`);
    const missing = [...implementation.keys()].filter(name => !declaration.has(name));
    const extra = [...declaration.entries()].filter(([name, kind]) => kind === 'value' && !implementation.has(name))
        .map(([name]) => name);
    return {missing, extra};
}

export function analyze(root) {
    const rows = [];
    for (const declarationPath of findDeclarations(root)) {
        const base = declarationPath.replace(DECLARATION, '');
        const implementationPath = [`${base}.mjs`, `${base}.cjs`].find(candidate => existsSync(candidate));
        if (!implementationPath) continue;
        const relative = path.relative(root, declarationPath).split(path.sep).join('/');
        const {missing, extra} = comparePair(readFileSync(implementationPath, 'utf8'), readFileSync(declarationPath, 'utf8'),
            path.basename(implementationPath));
        rows.push({declaration: relative, implementation: path.relative(root, implementationPath).split(path.sep).join('/'),
            missing, extra});
    }
    return rows;
}

export function formatText(rows) {
    const lines = [`检查 ${rows.length} 对声明文件`];
    const failing = rows.filter(row => row.missing.length || row.extra.length);
    for (const row of failing) {
        lines.push('');
        lines.push(`✗ ${row.declaration}`);
        if (row.missing.length) {
            lines.push(`   缺少导出：${row.missing.join(', ')}`);
            lines.push(`   → ${row.implementation} 已导出但声明未登记，.ts 侧 import 会报 TS2305`);
        }
        if (row.extra.length) {
            lines.push(`   多余声明：${row.extra.join(', ')}`);
            lines.push('   → 声明为值但实现未导出，运行时拿到 undefined');
        }
    }
    if (!failing.length) lines.push('', '全部一致。');
    return lines.join('\n');
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArguments(argv);
    if (options.help) {
        console.log('node scripts/testing/check-module-declarations.mjs [--root <dir>] [--json]');
        return;
    }
    const rows = analyze(options.root);
    console.log(options.json ? JSON.stringify({rows}, null, 2) : formatText(rows));
    // 与门禁一致：存在不一致即失败，避免被当成纯信息输出。
    if (rows.some(row => row.missing.length || row.extra.length)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch(error => {
        console.error(`[check-module-declarations] ${error.message}`);
        process.exitCode = 1;
    });
}
