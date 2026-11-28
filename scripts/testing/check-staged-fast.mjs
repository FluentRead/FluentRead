#!/usr/bin/env node

/**
 * @file scripts/testing/check-staged-fast.mjs
 * 文件职责：极速、工具无关的提交前暂存文件检查器，在毫秒级拦截文件头违规、测试禁令、未登记测试与废弃目录改动。
 * 主要内容：
 * - 校验暂存区（或 --files 指定）的 src/ 下源码文件（.ts/.tsx/.mts/.cts/.vue/.css/.md）是否符合 sourceFileHeaders.test.ts 的首字符文件头规范（@file、文件职责、主要内容、模块边界、>=160 字符、中文语义、无占位词）；
 * - 校验暂存的 tests/ 下 *.test.ts 不含 .only、无说明 .skip 与覆盖率 ignore 注释，且已在 tests/test-matrix.json 中登记；
 * - 拦截任何指向已废弃 entrypoints/utils/ 目录的暂存改动；
 * - 对 src/ui/ 与 src/features/∗/ui/ 下的 .vue/.css 样式块扫描裸 hex 颜色并给出非阻断提示（豁免 tokens/skins 定义文件与 CSS 变量声明）。
 * 模块边界：纯静态快速预检（<2s），供 .githooks/pre-commit 与本地 CLI 直接调用；不替代完整测试、覆盖率或类型检查。
 * 用法：node scripts/testing/check-staged-fast.mjs [--files <p1,p2>] [--root <dir>] [--json]
 */

import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import process from 'node:process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import ts from 'typescript';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DOCUMENTED_SRC_EXTENSIONS = new Set(['.css', '.cts', '.md', '.mts', '.ts', '.tsx', '.vue']);
const REQUIRED_HEADER_SECTIONS = ['文件职责：', '主要内容：', '模块边界：'];
const PLACEHOLDER_HEADER_PATTERN = /(?:TODO|待补充|此文件负责相关功能|文件职责：\s*(?:无|未知|待定))/u;
const TEST_GLOBALS = new Set(['describe', 'it', 'test']);
const COVERAGE_IGNORE_PATTERN = /\b(?:v8|istanbul|c8|coverage)\s+ignore\b/iu;
const UI_STYLE_PATH_PATTERN = /^(?:src\/ui\/|src\/features\/[^/]+\/ui\/).*\.(?:vue|css)$/u;
const ALLOWED_TOKEN_FILES = /^src\/ui\/styles\/(?:tokens|skins)[^/]*\.css$/u;
const RAW_HEX_PATTERN = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/gu;

export function parseArguments(argv) {
    const options = {
        files: null,
        root: PROJECT_ROOT,
        json: false,
        help: false,
    };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--') continue;
        if (arg === '--help' || arg === '-h') return {...options, help: true};
        if (arg === '--json') {options.json = true; continue;}
        if (arg === '--files' || arg === '--root') {
            const value = argv[++index];
            if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
            if (arg === '--files') {
                options.files = value.split(',').map(normalizePath).filter(Boolean);
            } else {
                options.root = path.resolve(value);
            }
            continue;
        }
        throw new Error(`未知参数：${arg}`);
    }
    return options;
}

function normalizePath(file) {
    return file.trim().replaceAll('\\', '/').replace(/^\.\//u, '');
}

export function getStagedFiles(root) {
    const output = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return [...new Set(output.split('\0').map(normalizePath).filter(Boolean))].sort();
}

export function checkSourceHeader(filePath, source) {
    const errors = [];
    const isHtmlComment = filePath.endsWith('.vue') || filePath.endsWith('.md');
    const match = isHtmlComment
        ? source.match(/^<!--[\s\S]*?-->/u)
        : source.match(/^\/\*\*[\s\S]*?\*\//u);

    if (!match) {
        errors.push(`${filePath}: 必须从第一个字符开始书写语义化文件头注释（${isHtmlComment ? '<!-- ... -->' : '/** ... */'}）`);
        return errors;
    }

    const header = match[0];
    const lines = header
        .split(/\r?\n/u)
        .map(line => line.trim())
        .map(line => (['/**', '<!--', '*/', '-->'].includes(line) ? '' : line.replace(/^\*\s?/u, '').trim()))
        .filter(Boolean);

    const fileLines = lines.filter(line => line.startsWith('@file '));
    if (fileLines.length !== 1 || fileLines[0] !== `@file ${filePath}`) {
        errors.push(`${filePath}: 文件头缺少精确匹配的 "@file ${filePath}" 声明`);
    }

    for (const label of REQUIRED_HEADER_SECTIONS) {
        const sectionLines = lines.filter(line => line.startsWith(label));
        if (sectionLines.length !== 1) {
            errors.push(`${filePath}: 文件头的 "${label}" 必须是唯一独立行`);
            continue;
        }
        const value = sectionLines[0].slice(label.length).trim();
        if (value.length < 12) {
            errors.push(`${filePath}: 文件头的 "${label}" 长度不足 12 字符，不能使用空泛占位`);
        }
        if (!/\p{Script=Han}/u.test(value)) {
            errors.push(`${filePath}: 文件头的 "${label}" 应包含中文说明`);
        }
    }

    if (header.length < 160) {
        errors.push(`${filePath}: 文件头总长度 ${header.length} < 160 字符，应写为可独立阅读的长注释`);
    }
    if (PLACEHOLDER_HEADER_PATTERN.test(header)) {
        errors.push(`${filePath}: 文件头包含占位词（TODO / 待补充 / 无 / 未知 / 待定）`);
    }
    return errors;
}

function calleeInfo(expression) {
    if (ts.isIdentifier(expression) && TEST_GLOBALS.has(expression.text)) {
        return {kind: expression.text, modifier: 'normal'};
    }
    if (ts.isPropertyAccessExpression(expression)) {
        const base = expression.expression;
        const name = expression.name.text;
        if (ts.isIdentifier(base) && TEST_GLOBALS.has(base.text) && ['only', 'skip', 'each'].includes(name)) {
            return {kind: base.text, modifier: name};
        }
    }
    if (ts.isCallExpression(expression)) {
        const inner = calleeInfo(expression.expression);
        if (inner?.modifier === 'each') return {...inner, modifier: 'each-call'};
    }
    return null;
}

function hasSkipExplanation(lines, lineNumber) {
    const current = lines[lineNumber - 1] || '';
    const previous = lines[lineNumber - 2] || '';
    return /(?:skip|跳过|原因|reason)\s*[:：]/iu.test(current)
        || /(?:skip|跳过|原因|reason)\s*[:：]/iu.test(previous);
}

export function checkTestFile(filePath, source, registeredTests = null) {
    const errors = [];
    if (COVERAGE_IGNORE_PATTERN.test(source)) {
        errors.push(`${filePath}: 禁止提交覆盖率忽略指令`);
    }

    const ast = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const lines = source.split(/\r?\n/u);
    const visit = node => {
        if (ts.isCallExpression(node)) {
            const info = calleeInfo(node.expression);
            if (info && (info.modifier === 'only' || info.modifier === 'skip')) {
                const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
                if (info.modifier === 'only') {
                    errors.push(`${filePath}:${line}: 禁止提交 ${info.kind}.only`);
                } else if (!hasSkipExplanation(lines, line)) {
                    errors.push(`${filePath}:${line}: ${info.kind}.skip 缺少 skip:/原因: 说明`);
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(ast);

    if (registeredTests && !registeredTests.has(filePath)) {
        errors.push(`${filePath}: 未登记在 tests/test-matrix.json（可运行 node scripts/testing/sync-registries.mjs --write 自动登记）`);
    }
    return errors;
}

export function checkRawHexColors(filePath, source) {
    if (!UI_STYLE_PATH_PATTERN.test(filePath) || ALLOWED_TOKEN_FILES.test(filePath)) {
        return [];
    }
    const styleBlocks = filePath.endsWith('.vue')
        ? [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)].map(match => match[1])
        : [source];

    const hits = new Set();
    for (const block of styleBlocks) {
        const withoutComments = block.replace(/\/\*[\s\S]*?\*\//gu, '');
        // CSS 自定义属性定义（例如局部主题变量 --fr-surface: #171b24;）跳过提示。
        const withoutCustomProps = withoutComments.replace(/--[\w-]+\s*:[^;}]+/gu, '');
        for (const match of withoutCustomProps.matchAll(RAW_HEX_PATTERN)) {
            hits.add(match[0].toLowerCase());
        }
    }

    if (!hits.size) return [];
    const sample = [...hits].slice(0, 6).join(', ');
    const more = hits.size > 6 ? ` 等共 ${hits.size} 处` : '';
    return [`${filePath}: 检测到裸 hex 颜色（${sample}${more}），建议优先使用 src/ui/styles/tokens.css 中的语义 token`];
}

function loadRegisteredMatrixTests(root) {
    const matrixPath = path.join(root, 'tests/test-matrix.json');
    if (!existsSync(matrixPath)) return null;
    try {
        const parsed = JSON.parse(readFileSync(matrixPath, 'utf8'));
        return new Set(Object.values(parsed.groups ?? {}).flat());
    } catch {
        return null;
    }
}

export function checkFiles(root, files) {
    const started = performance.now();
    const resolvedRoot = path.resolve(root);
    const normalized = [...new Set(files.map(normalizePath).filter(Boolean))].sort();
    const hasStagedTests = normalized.some(file => file.startsWith('tests/') && file.endsWith('.test.ts'));
    const registeredTests = hasStagedTests ? loadRegisteredMatrixTests(resolvedRoot) : null;

    const errors = [];
    const warnings = [];
    let checkedCount = 0;

    for (const file of normalized) {
        if (file.startsWith('entrypoints/utils/')) {
            errors.push(`${file}: 禁止修改或新增已废弃的 entrypoints/utils/ 路径，请迁移至 src/ 对应层级`);
            checkedCount += 1;
            continue;
        }

        const absolute = path.join(resolvedRoot, file);
        if (!existsSync(absolute)) continue;
        checkedCount += 1;

        const ext = path.extname(file);
        const needsSrcHeader = file.startsWith('src/') && DOCUMENTED_SRC_EXTENSIONS.has(ext);
        const needsTestCheck = file.startsWith('tests/') && file.endsWith('.test.ts');
        const needsSourceIgnoreCheck = /^(?:entrypoints|scripts|src|userscript)\/.*\.(?:cjs|js|mjs|ts|vue)$/u.test(file);
        const needsHexCheck = UI_STYLE_PATH_PATTERN.test(file) && !ALLOWED_TOKEN_FILES.test(file);

        if (!needsSrcHeader && !needsTestCheck && !needsSourceIgnoreCheck && !needsHexCheck) continue;

        const source = readFileSync(absolute, 'utf8');
        if (needsSrcHeader) errors.push(...checkSourceHeader(file, source));
        if (needsTestCheck) errors.push(...checkTestFile(file, source, registeredTests));
        if (needsSourceIgnoreCheck && COVERAGE_IGNORE_PATTERN.test(source)) {
            errors.push(`${file}: 禁止提交覆盖率忽略指令`);
        }
        if (needsHexCheck) warnings.push(...checkRawHexColors(file, source));
    }

    return {
        status: errors.length ? 'failed' : 'passed',
        checked: checkedCount,
        durationMs: Math.round(performance.now() - started),
        errors,
        warnings,
    };
}

export function formatReport(result) {
    const lines = [
        `[check-staged-fast] ${result.status.toUpperCase()} (${result.durationMs}ms) | 检查 ${result.checked} 个文件`,
    ];
    if (result.errors.length) {
        lines.push(`  阻断错误 (${result.errors.length}):`);
        for (const error of result.errors) lines.push(`    ✗ ${error}`);
    }
    if (result.warnings.length) {
        lines.push(`  样式提示 (${result.warnings.length}, 非阻断):`);
        for (const warning of result.warnings) lines.push(`    ! ${warning}`);
    }
    return lines.join('\n');
}

export function main(argv = process.argv.slice(2)) {
    const options = parseArguments(argv);
    if (options.help) {
        console.log('用法: node scripts/testing/check-staged-fast.mjs [--files <p1,p2>] [--root <dir>] [--json]');
        return;
    }
    const files = options.files ?? getStagedFiles(options.root);
    const result = checkFiles(options.root, files);
    console.log(options.json ? JSON.stringify(result, null, 2) : formatReport(result));
    if (result.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        main();
    } catch (error) {
        console.error(`[check-staged-fast] ${error.message}`);
        process.exitCode = 1;
    }
}
