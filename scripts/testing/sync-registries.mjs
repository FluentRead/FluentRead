#!/usr/bin/env node

/**
 * @file scripts/testing/sync-registries.mjs
 * 文件职责：自动审计并同步测试矩阵（tests/test-matrix.json）与四维 100% 严格覆盖率清单（tests/config/vitest.coverage.config.ts）。
 * 主要内容：
 * - 严格复用 verificationOwnership.test.ts 与 audit-test-suite.mjs 的同源判定规则，直接从 verificationOwnership.test.ts AST 读取 BUILD_ONLY_SRC_ALLOWLIST，拒绝硬编码双份维护；
 * - 发现未登记的 tests/ 下 *.test.ts（tests/architecture/ 归入 architecture，其余默认归入 --group，默认 unit）并清理已删除测试的陈旧条目与重复归类；
 * - 发现未登记的可执行 src/ 下 .ts/.vue 源码（自动排除纯类型模块、纯 barrel、声明式 Vue、vue-verification-owners.json 已有归属组件与 BUILD_ONLY_SRC_ALLOWLIST）并清理失效或已豁免的陈旧条目；
 * - 默认 --check 模式只读校验（有漂移即返回非零退出码），--write 模式在保留原文件格式与注释的前提下安全写回。
 * 模块边界：仅检查与同步仓库元数据清单，不运行测试、不修改业务源码或架构白名单。
 * 用法：node scripts/testing/sync-registries.mjs [--check | --write] [--group <unit|functional|regression>] [--root <dir>] [--json]
 */

import {existsSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import ts from 'typescript';
import {parse as parseSfc} from 'vue/compiler-sfc';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MATRIX_RELATIVE = 'tests/test-matrix.json';
const COVERAGE_RELATIVE = 'tests/config/vitest.coverage.config.ts';
const OWNERSHIP_TEST_RELATIVE = 'tests/architecture/verificationOwnership.test.ts';
const VUE_OWNERS_RELATIVE = 'tests/architecture/vue-verification-owners.json';

const ALL_GROUPS = ['architecture', 'unit', 'functional', 'regression'];
export const DEFAULT_GROUP = 'unit';
export const ALLOWED_GROUPS = ['unit', 'functional', 'regression'];

const CLASSIFICATION_COMPILER_OPTIONS = Object.freeze({
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ESNext,
});

export function parseArguments(argv) {
    const options = {
        write: false,
        group: DEFAULT_GROUP,
        root: PROJECT_ROOT,
        json: false,
        help: false,
    };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--') continue;
        if (arg === '--help' || arg === '-h') return {...options, help: true};
        if (arg === '--check') {options.write = false; continue;}
        if (arg === '--write') {options.write = true; continue;}
        if (arg === '--json') {options.json = true; continue;}
        if (arg === '--group' || arg === '--root') {
            const value = argv[++index];
            if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
            if (arg === '--group') {
                if (!ALLOWED_GROUPS.includes(value)) {
                    throw new Error(`--group 必须是 ${ALLOWED_GROUPS.join(' / ')} 之一，收到：${value}`);
                }
                options.group = value;
            } else {
                options.root = path.resolve(value);
            }
            continue;
        }
        throw new Error(`未知参数：${arg}`);
    }
    return options;
}

function listFiles(root, subDir, predicate) {
    const startDir = path.join(root, subDir);
    if (!existsSync(startDir)) return [];
    const found = [];
    const walk = directory => {
        for (const entry of readdirSync(directory, {withFileTypes: true})) {
            if (entry.name === '.DS_Store') continue;
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                walk(absolute);
                continue;
            }
            if (!entry.isFile()) continue;
            const rel = path.relative(root, absolute).split(path.sep).join('/');
            if (predicate(rel, entry.name)) found.push(rel);
        }
    };
    walk(startDir);
    return found.sort();
}

/**
 * 直接从 tests/architecture/verificationOwnership.test.ts 的 AST 中提取 BUILD_ONLY_SRC_ALLOWLIST，
 * 避免在多个脚本里复制维护同一份豁免清单。
 */
export function readBuildOnlyAllowlist(ownershipTestSource) {
    const ast = ts.createSourceFile(OWNERSHIP_TEST_RELATIVE, ownershipTestSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const items = new Set();
    let found = false;

    const visit = node => {
        if (ts.isVariableDeclaration(node)
            && ts.isIdentifier(node.name)
            && node.name.text === 'BUILD_ONLY_SRC_ALLOWLIST'
            && node.initializer
            && ts.isNewExpression(node.initializer)
            && ts.isIdentifier(node.initializer.expression)
            && node.initializer.expression.text === 'Set'
            && node.initializer.arguments?.length) {
            const firstArg = node.initializer.arguments[0];
            if (ts.isArrayLiteralExpression(firstArg)) {
                found = true;
                for (const element of firstArg.elements) {
                    if (ts.isStringLiteralLike(element)) items.add(element.text);
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(ast);
    if (!found) {
        throw new Error(`无法在 ${OWNERSHIP_TEST_RELATIVE} 中解析 BUILD_ONLY_SRC_ALLOWLIST`);
    }
    return items;
}

function hasDefiniteRuntimeStatement(sourceFile) {
    for (const statement of sourceFile.statements) {
        const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
        if (modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) continue;
        if (ts.isFunctionDeclaration(statement) && statement.body) return true;
        if (ts.isClassDeclaration(statement)) return true;
        if (ts.isEnumDeclaration(statement) && !modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ConstKeyword)) return true;
        if (ts.isVariableStatement(statement) || ts.isExportAssignment(statement)) return true;
        if (ts.isExpressionStatement(statement) || ts.isIfStatement(statement) || ts.isForStatement(statement)
            || ts.isForOfStatement(statement) || ts.isForInStatement(statement) || ts.isWhileStatement(statement)
            || ts.isDoStatement(statement) || ts.isSwitchStatement(statement) || ts.isTryStatement(statement)
            || ts.isThrowStatement(statement)) return true;
    }
    return false;
}

function literalData(node) {
    if (ts.isLiteralExpression(node) || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword
        || node.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isArrayLiteralExpression(node)) return node.elements.every(literalData);
    return ts.isObjectLiteralExpression(node) && node.properties.every(item => ts.isPropertyAssignment(item) && literalData(item.initializer));
}

function isDeclarativeVueSource(source, filename) {
    const parsed = parseSfc(source, {filename});
    if (parsed.errors.length || parsed.descriptor.script?.src || parsed.descriptor.scriptSetup?.src) return false;
    const script = [parsed.descriptor.script?.content, parsed.descriptor.scriptSetup?.content].filter(Boolean).join('\n');
    const ast = ts.createSourceFile(filename, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const macro = node => ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && ['defineProps', 'defineOptions', 'defineEmits'].includes(node.expression.text)
        && node.arguments.every(literalData);
    const declarative = ast.statements.every(statement => {
        if (ts.isImportDeclaration(statement)) return Boolean(statement.importClause?.isTypeOnly)
            || (ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.endsWith('.vue'));
        if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEmptyStatement(statement)) return true;
        if (ts.isExpressionStatement(statement)) return macro(statement.expression);
        return ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
            && statement.declarationList.declarations.every(item => item.initializer && (macro(item.initializer) || literalData(item.initializer)));
    });
    if (!declarative) return false;
    const visit = node => {
        if (!node || typeof node !== 'object') return true;
        if (node.type === 7 && !['bind', 'if', 'else-if', 'else', 'for', 'show', 'slot', 'pre', 'cloak', 'once', 'memo', 'text'].includes(node.name ?? '')) {
            return false;
        }
        if (node.type === 4 && !node.isStatic && typeof node.content === 'string') {
            const expression = ts.createSourceFile('template.ts', `(${node.content})`, ts.ScriptTarget.Latest, true);
            let safe = true;
            const check = item => {
                if (ts.isCallExpression(item) || ts.isNewExpression(item) || ts.isFunctionLike(item) || ts.isAwaitExpression(item)
                    || ts.isPostfixUnaryExpression(item)
                    || (ts.isPrefixUnaryExpression(item) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(item.operator))
                    || (ts.isBinaryExpression(item) && item.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
                        && item.operatorToken.kind <= ts.SyntaxKind.LastAssignment)) {
                    safe = false;
                }
                ts.forEachChild(item, check);
            };
            check(expression);
            if (!safe) return false;
        }
        return [...(node.children ?? []), ...(node.props ?? []), node.exp, node.arg,
            typeof node.content === 'object' ? node.content : undefined].every(visit);
    };
    return visit(parsed.descriptor.template?.ast);
}

export function classifySourceModule(filePath, source) {
    if (/\.d(?:\.[^./]+)?\.ts$/u.test(filePath)) {
        return {typeOnly: true, pureBarrel: false, declarativeVue: false};
    }
    if (filePath.endsWith('.vue')) {
        return {typeOnly: false, pureBarrel: false, declarativeVue: isDeclarativeVueSource(source, filePath)};
    }
    if (!filePath.endsWith('.ts')) {
        return {typeOnly: false, pureBarrel: false, declarativeVue: false};
    }
    const original = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const pureBarrel = original.statements.length > 0
        && original.statements.every(statement => ts.isExportDeclaration(statement));
    let typeOnly = false;
    if (!hasDefiniteRuntimeStatement(original)) {
        const emitted = ts.transpileModule(source, {compilerOptions: CLASSIFICATION_COMPILER_OPTIONS}).outputText;
        const runtime = ts.createSourceFile(`${filePath}.js`, emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        typeOnly = runtime.statements.every(statement => ts.isEmptyStatement(statement)
            || (ts.isExportDeclaration(statement)
                && !statement.moduleSpecifier
                && Boolean(statement.exportClause)
                && ts.isNamedExports(statement.exportClause)
                && statement.exportClause.elements.length === 0));
    }
    return {typeOnly, pureBarrel, declarativeVue: false};
}

function findCoverageIncludeArray(source) {
    const ast = ts.createSourceFile(COVERAGE_RELATIVE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let includeArray = null;
    const visit = node => {
        if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'coverage'
            && ts.isObjectLiteralExpression(node.initializer)) {
            const property = node.initializer.properties.find(item => ts.isPropertyAssignment(item)
                && item.name.getText(ast) === 'include');
            if (!property || !ts.isArrayLiteralExpression(property.initializer)
                || property.initializer.elements.some(item => !ts.isStringLiteral(item))) {
                throw new Error('严格覆盖率 include 必须保留显式源码路径清单');
            }
            includeArray = property.initializer;
        }
        ts.forEachChild(node, visit);
    };
    visit(ast);
    if (!includeArray) throw new Error('未找到严格覆盖率源码边界');
    return {ast, includeArray};
}

export function analyzeRegistries(projectRoot, options = {}) {
    const root = path.resolve(projectRoot);
    const defaultGroup = options.group ?? DEFAULT_GROUP;
    if (!ALLOWED_GROUPS.includes(defaultGroup)) {
        throw new Error(`非法默认分组：${defaultGroup}`);
    }

    const matrixPath = path.join(root, MATRIX_RELATIVE);
    const coveragePath = path.join(root, COVERAGE_RELATIVE);
    const ownershipPath = path.join(root, OWNERSHIP_TEST_RELATIVE);
    const vueOwnersPath = path.join(root, VUE_OWNERS_RELATIVE);

    const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
    const coverageSource = readFileSync(coveragePath, 'utf8');
    const allowlist = existsSync(ownershipPath)
        ? readBuildOnlyAllowlist(readFileSync(ownershipPath, 'utf8'))
        : new Set();
    const vueOwners = existsSync(vueOwnersPath)
        ? new Set(Object.keys(JSON.parse(readFileSync(vueOwnersPath, 'utf8')).components ?? {}))
        : new Set();

    // 1. 审计测试矩阵
    const actualTests = listFiles(root, 'tests', (_rel, name) => name.endsWith('.test.ts'));
    const actualTestSet = new Set(actualTests);
    const seenMatrixTests = new Map();
    const matrixDuplicates = [];
    const matrixStale = [];

    for (const group of ALL_GROUPS) {
        const list = matrix.groups?.[group] ?? [];
        for (const file of list) {
            if (seenMatrixTests.has(file)) {
                matrixDuplicates.push({file, firstGroup: seenMatrixTests.get(file), duplicateGroup: group});
            } else {
                seenMatrixTests.set(file, group);
            }
            if (!actualTestSet.has(file)) {
                matrixStale.push({file, group});
            }
        }
    }

    const matrixMissing = actualTests
        .filter(file => !seenMatrixTests.has(file))
        .map(file => ({
            file,
            group: file.startsWith('tests/architecture/') ? 'architecture' : defaultGroup,
        }));

    // 2. 审计严格覆盖率清单
    const {includeArray} = findCoverageIncludeArray(coverageSource);
    const coverageEntries = includeArray.elements.map(element => element.text);
    const coverageSet = new Set(coverageEntries);
    const coverageDuplicates = [];
    const seenCoverage = new Set();
    for (const entry of coverageEntries) {
        if (seenCoverage.has(entry)) coverageDuplicates.push(entry);
        else seenCoverage.add(entry);
    }

    const srcModules = listFiles(root, 'src', (_rel, name) => /\.(?:ts|vue)$/u.test(name) && !/\.d(?:\.[^./]+)?\.ts$/u.test(name));
    const srcModuleSet = new Set(srcModules);
    const classifications = new Map();
    const getClassification = file => {
        if (!classifications.has(file)) {
            classifications.set(file, classifySourceModule(file, readFileSync(path.join(root, file), 'utf8')));
        }
        return classifications.get(file);
    };

    const isExemptTs = file => {
        if (allowlist.has(file)) return true;
        const info = getClassification(file);
        return info.typeOnly || info.pureBarrel;
    };

    const coverageMissing = [];
    for (const file of srcModules) {
        if (coverageSet.has(file)) continue;
        if (allowlist.has(file)) continue;
        if (file.endsWith('.ts')) {
            if (!isExemptTs(file)) coverageMissing.push(file);
            continue;
        }
        if (file.endsWith('.vue')) {
            if (vueOwners.has(file)) continue;
            if (!getClassification(file).declarativeVue) coverageMissing.push(file);
        }
    }

    const coverageStale = [];
    for (const entry of seenCoverage) {
        const existsOnDisk = existsSync(path.join(root, entry)) && statSync(path.join(root, entry)).isFile();
        if (!existsOnDisk) {
            coverageStale.push(entry);
            continue;
        }
        if (entry.startsWith('src/') && entry.endsWith('.ts')) {
            if (!srcModuleSet.has(entry) || isExemptTs(entry)) {
                coverageStale.push(entry);
            }
        } else if (entry.startsWith('src/') && entry.endsWith('.vue')) {
            if (allowlist.has(entry)) coverageStale.push(entry);
        }
    }

    const hasDrift = matrixMissing.length > 0
        || matrixStale.length > 0
        || matrixDuplicates.length > 0
        || coverageMissing.length > 0
        || coverageStale.length > 0
        || coverageDuplicates.length > 0;

    return {
        hasDrift,
        matrix: {
            missing: matrixMissing,
            stale: matrixStale,
            duplicates: matrixDuplicates,
        },
        coverage: {
            missing: coverageMissing.sort(),
            stale: coverageStale.sort(),
            duplicates: [...new Set(coverageDuplicates)].sort(),
            allowlistCount: allowlist.size,
        },
    };
}

export function applyMatrixSync(matrixSource, report) {
    const parsed = JSON.parse(matrixSource);
    const staleSet = new Set(report.matrix.stale.map(item => item.file));
    const seen = new Set();

    for (const group of ALL_GROUPS) {
        const existing = Array.isArray(parsed.groups?.[group]) ? parsed.groups[group] : [];
        const cleaned = [];
        for (const file of existing) {
            if (staleSet.has(file) || seen.has(file)) continue;
            seen.add(file);
            cleaned.push(file);
        }
        parsed.groups[group] = cleaned;
    }

    for (const item of report.matrix.missing) {
        if (!seen.has(item.file)) {
            seen.add(item.file);
            parsed.groups[item.group].push(item.file);
        }
    }

    return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function applyCoverageConfigSync(configSource, report) {
    const {ast, includeArray} = findCoverageIncludeArray(configSource);
    const staleSet = new Set(report.coverage.stale);
    const newline = configSource.includes('\r\n') ? '\r\n' : '\n';

    const arrayStart = includeArray.getStart(ast);
    const arrayEnd = includeArray.getEnd();
    const inner = configSource.slice(arrayStart + 1, arrayEnd - 1);

    // 探测已有缩进和引号风格，默认与仓库 16 空格 + 单引号一致。
    let indent = '                ';
    let quote = "'";
    const firstElement = includeArray.elements[0];
    if (firstElement) {
        const elemStart = firstElement.getStart(ast);
        const lineStart = configSource.lastIndexOf('\n', elemStart) + 1;
        const leading = configSource.slice(lineStart, elemStart);
        if (/^[ \t]+$/u.test(leading)) indent = leading;
        const rawChar = configSource[elemStart];
        if (rawChar === '"' || rawChar === "'") quote = rawChar;
    }

    const closingLineStart = configSource.lastIndexOf('\n', arrayEnd - 1) + 1;
    const closingIndent = /^[ \t]*$/u.test(configSource.slice(closingLineStart, arrayEnd - 1))
        ? configSource.slice(closingLineStart, arrayEnd - 1)
        : '            ';

    // 逐行移除 stale/重复条目，同时保留其他条目的顺序与注释。
    const keptSeen = new Set();
    const lines = inner.split(/\r?\n/u);
    const keptLines = [];
    for (const line of lines) {
        const match = line.match(/^\s*(['"])([^'"]+)\1\s*,?\s*(?:\/\/.*)?$/u);
        if (match) {
            const value = match[2];
            if (staleSet.has(value) || keptSeen.has(value)) continue;
            keptSeen.add(value);
        }
        keptLines.push(line);
    }

    // 处理单行空数组或单行内联数组（如 include: [] 或 include: ['src/a.ts']）
    const isMultiline = inner.includes('\n');
    let nextBody;
    if (!isMultiline) {
        const remaining = [];
        for (const element of includeArray.elements) {
            const value = element.text;
            if (staleSet.has(value) || remaining.includes(value)) continue;
            remaining.push(value);
        }
        for (const added of report.coverage.missing) {
            if (!remaining.includes(added)) remaining.push(added);
        }
        if (!remaining.length) {
            nextBody = '';
        } else {
            nextBody = `${newline}${remaining.map(item => `${indent}${quote}${item}${quote},`).join(newline)}${newline}${closingIndent}`;
        }
    } else {
        // 移除末尾仅含缩进的尾行，追加新条目后再拼回 closingIndent
        while (keptLines.length && /^[ \t]*$/u.test(keptLines.at(-1))) keptLines.pop();
        if (keptLines.length && keptLines[0] === '') keptLines.shift();
        // 确保最后一个已有条目以逗号结尾（跳过末尾的空行和注释行）。
        for (let idx = keptLines.length - 1; idx >= 0; idx--) {
            const trimmed = keptLines[idx].trim();
            if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
            const entryMatch = keptLines[idx].match(/^(\s*['"][^'"]+['"])(\s*(?:\/\/.*)?)$/u);
            if (entryMatch) {
                keptLines[idx] = `${entryMatch[1]},${entryMatch[2]}`;
            }
            break;
        }
        for (const added of report.coverage.missing) {
            if (!keptSeen.has(added)) {
                keptSeen.add(added);
                keptLines.push(`${indent}${quote}${added}${quote},`);
            }
        }
        nextBody = keptLines.length
            ? `${newline}${keptLines.join(newline)}${newline}${closingIndent}`
            : '';
    }

    return `${configSource.slice(0, arrayStart + 1)}${nextBody}${configSource.slice(arrayEnd - 1)}`;
}

export function syncRegistries(projectRoot, options = {}) {
    const root = path.resolve(projectRoot);
    const report = analyzeRegistries(root, options);
    const written = [];

    if (options.write && report.hasDrift) {
        const matrixChanged = report.matrix.missing.length > 0
            || report.matrix.stale.length > 0
            || report.matrix.duplicates.length > 0;
        if (matrixChanged) {
            const matrixPath = path.join(root, MATRIX_RELATIVE);
            const updated = applyMatrixSync(readFileSync(matrixPath, 'utf8'), report);
            writeFileSync(matrixPath, updated, 'utf8');
            written.push(MATRIX_RELATIVE);
        }

        const coverageChanged = report.coverage.missing.length > 0
            || report.coverage.stale.length > 0
            || report.coverage.duplicates.length > 0;
        if (coverageChanged) {
            const coveragePath = path.join(root, COVERAGE_RELATIVE);
            const updated = applyCoverageConfigSync(readFileSync(coveragePath, 'utf8'), report);
            writeFileSync(coveragePath, updated, 'utf8');
            written.push(COVERAGE_RELATIVE);
        }
    }

    return {...report, written};
}

export function formatReport(result, options = {}) {
    const mode = options.write ? 'WRITE' : 'CHECK';
    if (!result.hasDrift) {
        return `[sync-registries] ${mode} OK — tests/test-matrix.json 与 tests/config/vitest.coverage.config.ts 全部同步（豁免白名单 ${result.coverage.allowlistCount} 项）`;
    }
    const lines = [
        `[sync-registries] ${mode} ${options.write ? 'UPDATED' : 'DRIFT DETECTED'}`,
    ];
    if (result.matrix.missing.length) {
        lines.push(`  test-matrix 缺少登记 (${result.matrix.missing.length}):`);
        for (const item of result.matrix.missing) lines.push(`    + [${item.group}] ${item.file}`);
    }
    if (result.matrix.stale.length) {
        lines.push(`  test-matrix 陈旧条目 (${result.matrix.stale.length}):`);
        for (const item of result.matrix.stale) lines.push(`    - [${item.group}] ${item.file}`);
    }
    if (result.matrix.duplicates.length) {
        lines.push(`  test-matrix 重复归类 (${result.matrix.duplicates.length}):`);
        for (const item of result.matrix.duplicates) lines.push(`    ! ${item.file} (${item.firstGroup} / ${item.duplicateGroup})`);
    }
    if (result.coverage.missing.length) {
        lines.push(`  vitest.coverage 缺少登记 (${result.coverage.missing.length}):`);
        for (const file of result.coverage.missing) lines.push(`    + ${file}`);
    }
    if (result.coverage.stale.length) {
        lines.push(`  vitest.coverage 陈旧/已豁免条目 (${result.coverage.stale.length}):`);
        for (const file of result.coverage.stale) lines.push(`    - ${file}`);
    }
    if (result.coverage.duplicates.length) {
        lines.push(`  vitest.coverage 重复条目 (${result.coverage.duplicates.length}):`);
        for (const file of result.coverage.duplicates) lines.push(`    ! ${file}`);
    }
    if (result.written?.length) {
        lines.push(`  已更新文件：${result.written.join(', ')}`);
    } else if (!options.write) {
        lines.push('  提示：运行 node scripts/testing/sync-registries.mjs --write 自动同步。');
    }
    return lines.join('\n');
}

export function main(argv = process.argv.slice(2)) {
    const options = parseArguments(argv);
    if (options.help) {
        console.log('用法: node scripts/testing/sync-registries.mjs [--check | --write] [--group <unit|functional|regression>] [--root <dir>] [--json]');
        return;
    }
    const result = syncRegistries(options.root, options);
    console.log(options.json ? JSON.stringify(result, null, 2) : formatReport(result, options));
    if (!options.write && result.hasDrift) {
        process.exitCode = 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        main();
    } catch (error) {
        console.error(`[sync-registries] ${error.message}`);
        process.exitCode = 1;
    }
}
