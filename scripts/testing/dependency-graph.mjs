/**
 * @file scripts/testing/dependency-graph.mjs
 * 文件职责：提供同源、可解释、按符号精确解析的仓库依赖图与反向影响面分析引擎。
 * 主要内容：
 * - 用 TypeScript AST 区分运行时 import/export 与纯类型 import/export，避免纯类型改动触发数百个无关运行时测试；
 * - 对纯 re-export barrel（如 index.ts）做按导出符号追踪，防止修改兄弟模块通过 barrel 放大到全部消费者；
 * - 隔离矩阵/覆盖率清单等注册表数据文件，阻止它们作为反向星型枢纽把无关源码与测试耦合在一起；
 * - 仅在真实路径/文件/夹具上下文提取非 import 引用，并将目录回退限定在夹具、资源与数据目录，消除断言字符串和临时目录脚手架误报；
 * - 输出边来源（import / barrel-symbol / dynamic-import / vi-mock / file-read / template / directory / css-import / vue-asset）供门禁与诊断共用。
 * 模块边界：analyzeDependencyGraph / buildDependencyGraph 保持纯内存静态分析，不执行测试、不读写 Git、不修改磁盘；analyzeProjectDependencyGraph 提供可选的 .wxt/cache/dep-graph-v1.json 增量磁盘缓存，供 run-affected-tests、test-impact 与 test-for 复用。
 */

import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

export const CODE = /\.(?:[cm]?[jt]sx?|vue|css|html|json)$/u;
export const DEPENDENCY_CONTENT = /^(?:src|entrypoints|userscript|scripts|tests|docs\/\.vitepress)\//u;
export const TEST_FILE_PATTERN = /^tests\/.*\.test\.(?:[cm]?[jt]s)$/u;
export const DEFAULT_DEP_GRAPH_CACHE_PATH = '.wxt/cache/dep-graph-v1.json';
const SELF_SOURCE_HASH = createHash('sha256')
    .update(readFileSync(fileURLToPath(import.meta.url), 'utf8'))
    .digest('hex')
    .slice(0, 12);
export const DEP_GRAPH_CACHE_VERSION = `dep-graph-v1:${ts.version}:${SELF_SOURCE_HASH}`;
const WALK_SKIPPED_DIRS = new Set(['node_modules', '.git', '.wxt', '.output', 'coverage', 'dist', 'temp']);

// 清单/注册表数据文件按文本列出仓库内数百个路径，不能作为反向依赖枢纽把任意源码改动桥接到无关测试。
// 当注册表文件自身改动时，引用它的测试仍通过自身出边被精确选中。
export const REGISTRY_DATA_FILES = new Set([
    'tests/test-matrix.json',
    'tests/config/vitest.coverage.config.ts',
    'tests/architecture/vue-verification-owners.json',
]);

// 这些是「前缀声明」而非「读取整个目录」：避免回退成整层源码依赖。
const PROJECT_ROOTS = new Set([
    'src', 'tests', 'scripts', 'entrypoints', 'userscript', 'docs', 'public', 'styles',
    'assets', 'docs/.vitepress',
]);

// 只有真实的夹具、静态资源与语言数据目录允许目录级回退；源码目录不允许由裸目录字符串整棵挂接。
const ALLOWED_DIRECTORY_FALLBACK = /^(?:tests\/fixtures(?:\/|$)|assets(?:\/|$)|public(?:\/|$)|userscript\/languages(?:\/|$)|src\/core\/i18n\/messages(?:\/|$)|src\/ui\/styles(?:\/|$)|scripts\/testing\/image-format-fixtures(?:\/|$))/u;

// 断言匹配器与字符串前缀/包含比较中的字面量是期望值或谓词，不构成文件读取依赖。
const NON_READER_METHODS = new Set([
    'toContain', 'toEqual', 'toStrictEqual', 'toBe', 'toMatch', 'toThrow', 'toContainEqual',
    'toHaveBeenCalledWith', 'toHaveBeenLastCalledWith', 'toHaveBeenNthCalledWith', 'toMatchObject',
    'startsWith', 'endsWith', 'includes', 'indexOf', 'lastIndexOf', 'replace', 'replaceAll', 'split',
]);

// 临时夹具脚手架调用（向临时目录建目录或写假文件）中的路径片段不是对仓库真实目录的读取。
const FIXTURE_SCAFFOLD_CALLS = new Set([
    'mkdirSync', 'mkdir', 'writeFileSync', 'writeFile', 'rmSync', 'rm', 'unlinkSync', 'unlink',
]);

const READER_CALLS = new Set([
    'readFileSync', 'readFile', 'readdirSync', 'readdir', 'existsSync', 'statSync', 'lstatSync',
    'compileVueFixture', 'compileVueInlineFixture', 'source', 'sourceBody', 'readSource',
    'readProjectFile', 'readScript', 'loadClient', 'ssrLoadModule', 'cssDeclarations',
    'resolve', 'join', 'projectPath', 'require',
]);

const RUNTIME_SOURCE_ONLY = /^(?:src|entrypoints|scripts)\//u;
const SCRIPT_EXT = /\.(?:[cm]?[jt]sx?|vue)$/u;
const MODULE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.vue', '.json', '.css'];
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.mts', 'index.js', 'index.vue'];

export function projectPath(owner, value) {
    if (!value || typeof value !== 'string') return null;
    let candidate;
    if (value.startsWith('@/')) candidate = value.slice(2);
    else if (value.startsWith('/src/') && value.length > 5) candidate = value.slice(1);
    else if (/^(?:src|scripts|tests|userscript|entrypoints|docs|public|styles|assets)\//u.test(value)) candidate = value;
    else if (value.startsWith('./') || value.startsWith('../')) {
        if (!value.replace(/^(?:\.\.?\/)+/u, '')) return null;
        candidate = path.posix.normalize(path.posix.join(path.posix.dirname(owner), value));
    } else if (/^(?:vitest(?:\.[^/]+)?\.config\.ts|wxt\.config\.ts|tsconfig\.json|package\.json)$/u.test(value)) {
        candidate = value;
    } else {
        return null;
    }
    return candidate;
}

export function resolveExactModule(known, owner, specifier) {
    if (!specifier || specifier.includes('${') || specifier.includes('\n')) return null;
    let candidate = projectPath(owner, specifier);
    if (!candidate) return null;
    candidate = candidate.split(/[?#]/u)[0];
    const alternatives = [
        candidate,
        ...MODULE_EXTENSIONS.map(extension => candidate + extension),
        ...INDEX_FILES.map(index => `${candidate}/${index}`),
    ];
    return alternatives.find(item => known.has(item)) ?? null;
}

function resolveTemplateReference(known, owner, parts) {
    const [head, ...tails] = parts;
    const prefix = projectPath(owner, head);
    if (!prefix || parts.some(part => part.includes('\n'))) return [];
    const directory = head.endsWith('/') ? prefix.replace(/\/$/u, '') : path.posix.dirname(prefix);
    if (!/^(?:src|entrypoints|userscript|scripts|tests|docs|public|styles|assets)\/[^/]+(?:\/[^/]+)*$/u.test(directory)
        || directory.split('/').some(part => part === '..' || part === '.')) return [];
    const normalizedParts = [prefix, ...tails];
    const query = normalizedParts.findIndex(part => /[?#]/u.test(part));
    if (query >= 0) {
        normalizedParts.splice(query + 1);
        normalizedParts[query] = normalizedParts[query].split(/[?#]/u)[0];
    }
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const pattern = new RegExp('^' + normalizedParts.map(escape).join('.*') + '$', 'u');
    return [...known].filter(file => file.startsWith(directory + '/') && pattern.test(file));
}

function resolvePathReference(known, owner, reference) {
    if (typeof reference !== 'string') {
        const files = resolveTemplateReference(known, owner, reference.parts);
        return {files, via: files.length ? 'template' : 'none'};
    }
    if (reference.includes('${') || reference.includes('\n')) return {files: [], via: 'none'};
    const exact = resolveExactModule(known, owner, reference);
    if (exact) return {files: [exact], via: 'file-read'};
    let candidate = projectPath(owner, reference);
    if (!candidate) return {files: [], via: 'none'};
    candidate = candidate.split(/[?#]/u)[0];
    const directory = candidate.replace(/\/+$/u, '');
    if (!directory || directory === '.' || directory === '..' || PROJECT_ROOTS.has(directory)) {
        return {files: [], via: 'none'};
    }
    if (!ALLOWED_DIRECTORY_FALLBACK.test(directory)) return {files: [], via: 'none'};
    const files = [...known].filter(item => item.startsWith(directory + '/'));
    return {files, via: files.length ? 'directory' : 'none'};
}

function extractCssReferences(source) {
    const refs = new Set();
    for (const match of source.matchAll(/@import\s+(?:url\(\s*)?(['"])([^'"\n]+)\1/gu)) refs.add(match[2]);
    for (const match of source.matchAll(/url\(\s*(['"]?)([^)'"\n]+)\1\s*\)/gu)) {
        const value = match[2].trim();
        if (value && !value.startsWith('data:') && !value.startsWith('http')) refs.add(value);
    }
    return [...refs];
}

function extractVueSections(source) {
    const scripts = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/giu)].map(match => match[1]);
    const styles = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)].map(match => match[1]);
    const templates = [...source.matchAll(/<template\b[^>]*>([\s\S]*?)<\/template>/giu)].map(match => match[1]);
    const templateAssets = new Set();
    for (const template of templates) {
        for (const match of template.matchAll(/\b(?:src|href|poster)\s*=\s*(['"])([^'"\n]+)\1/gu)) {
            templateAssets.add(match[2]);
        }
    }
    const styleRefs = styles.flatMap(extractCssReferences);
    return {script: scripts.join('\n'), styleRefs, templateAssets: [...templateAssets]};
}

function collectBindingNames(name, add) {
    if (ts.isIdentifier(name)) {
        add(name.text);
        return;
    }
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
        for (const element of name.elements) {
            if (ts.isBindingElement(element)) collectBindingNames(element.name, add);
        }
    }
}

function callName(callee) {
    if (ts.isIdentifier(callee)) return callee.text;
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    return null;
}

/**
 * 判断某个字符串/模板字面量是否位于断言匹配器或临时目录脚手架的参数中（且不在嵌套的真实文件读取调用内）。
 */
function isIgnoredLiteralContext(node) {
    let current = node.parent;
    while (current) {
        if (ts.isCallExpression(current)) {
            const name = callName(current.expression);
            if (name && READER_CALLS.has(name)) return false;
            if (name && (NON_READER_METHODS.has(name) || FIXTURE_SCAFFOLD_CALLS.has(name))) return true;
        }
        if (ts.isNewExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === 'URL') {
            return false;
        }
        current = current.parent;
    }
    return false;
}

function isUrlImportMetaContext(node) {
    let current = node.parent;
    while (current) {
        if (ts.isNewExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === 'URL'
            && current.arguments && current.arguments.length >= 2) {
            const second = current.arguments[1].getText();
            if (second.includes('import.meta.url')) return true;
        }
        if (ts.isStatement(current)) break;
        current = current.parent;
    }
    return false;
}

function parseScriptModule(file, source) {
    const isVue = file.endsWith('.vue');
    const vueSections = isVue ? extractVueSections(source) : null;
    const code = isVue ? vueSections.script : source;
    const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    const runtimeImports = []; // {specifier, symbols: Set<string>|'*', via}
    const reexports = []; // {specifier, exportedName, localName}
    const starReexports = []; // specifier
    const localExports = new Set();
    const fileRefs = []; // string | {parts: string[]}
    const fileRefKeys = new Set();
    const skippedSpecifierNodes = new Set();
    const constStrings = new Map();
    let hasRuntimeBody = isVue;

    const addFileRef = ref => {
        const key = typeof ref === 'string' ? `s:${ref}` : `t:${JSON.stringify(ref.parts)}`;
        if (fileRefKeys.has(key)) return;
        fileRefKeys.add(key);
        fileRefs.push(ref);
    };

    for (const statement of sf.statements) {
        if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const)) {
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isStringLiteralLike(declaration.initializer)) {
                    constStrings.set(declaration.name.text, declaration.initializer.text);
                }
            }
        }
        if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
            skippedSpecifierNodes.add(statement.moduleSpecifier);
            const specifier = statement.moduleSpecifier.text;
            const clause = statement.importClause;
            if (!clause) {
                // 副作用导入：`import './side-effect'` 既依赖模块，也使当前文件不是纯 barrel。
                hasRuntimeBody = true;
                runtimeImports.push({specifier, symbols: '*', via: 'import'});
                continue;
            }
            if (clause.isTypeOnly) continue;
            const symbols = new Set();
            let wildcard = false;
            if (clause.name) symbols.add('default');
            if (clause.namedBindings) {
                if (ts.isNamespaceImport(clause.namedBindings)) {
                    wildcard = true;
                } else {
                    for (const element of clause.namedBindings.elements) {
                        if (!element.isTypeOnly) symbols.add((element.propertyName ?? element.name).text);
                    }
                }
            }
            if (wildcard) runtimeImports.push({specifier, symbols: '*', via: 'import'});
            else if (symbols.size > 0) runtimeImports.push({specifier, symbols, via: 'import'});
            continue;
        }
        if (ts.isExportDeclaration(statement)) {
            if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
                skippedSpecifierNodes.add(statement.moduleSpecifier);
            }
            if (statement.isTypeOnly) continue;
            if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
                const specifier = statement.moduleSpecifier.text;
                if (!statement.exportClause) {
                    starReexports.push(specifier);
                } else if (ts.isNamedExports(statement.exportClause)) {
                    for (const element of statement.exportClause.elements) {
                        if (element.isTypeOnly) continue;
                        reexports.push({
                            specifier,
                            exportedName: element.name.text,
                            localName: (element.propertyName ?? element.name).text,
                        });
                    }
                } else if (ts.isNamespaceExport(statement.exportClause)) {
                    reexports.push({specifier, exportedName: statement.exportClause.name.text, localName: '*'});
                }
            } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
                for (const element of statement.exportClause.elements) {
                    if (!element.isTypeOnly) localExports.add(element.name.text);
                }
            }
            continue;
        }
        if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEmptyStatement(statement)) {
            continue;
        }
        const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
        if (modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) continue;
        hasRuntimeBody = true;
        if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
            localExports.add('default');
            continue;
        }
        const exported = modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
        if (exported) {
            if (modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) localExports.add('default');
            if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement))
                && statement.name) {
                localExports.add(statement.name.text);
            } else if (ts.isVariableStatement(statement)) {
                for (const declaration of statement.declarationList.declarations) {
                    collectBindingNames(declaration.name, name => localExports.add(name));
                }
            }
        }
    }

    const strictRuntimeOnly = RUNTIME_SOURCE_ONLY.test(file);

    const resolveTemplateParts = node => {
        // 将模板中引用的顶层 const 字符串常量静态折叠，避免 `${folder}Foo.vue` 退化为整目录或漏匹配。
        const parts = [node.head.text];
        for (const span of node.templateSpans) {
            if (ts.isIdentifier(span.expression) && constStrings.has(span.expression.text)) {
                parts[parts.length - 1] += constStrings.get(span.expression.text) + span.literal.text;
            } else {
                parts.push(span.literal.text);
            }
        }
        return parts.length === 1 ? parts[0] : {parts};
    };

    const visit = node => {
        if (ts.isImportTypeNode(node)) return; // 纯类型 `import('./x').T` 不构成运行时依赖。
        if (ts.isCallExpression(node)) {
            const argument = node.arguments[0];
            if (node.expression.kind === ts.SyntaxKind.ImportKeyword && argument) {
                if (ts.isStringLiteralLike(argument)) {
                    skippedSpecifierNodes.add(argument);
                    runtimeImports.push({specifier: argument.text, symbols: '*', via: 'dynamic-import'});
                } else if (ts.isTemplateExpression(argument)) {
                    skippedSpecifierNodes.add(argument);
                    addFileRef(resolveTemplateParts(argument));
                }
            } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require' && argument && ts.isStringLiteralLike(argument)) {
                skippedSpecifierNodes.add(argument);
                runtimeImports.push({specifier: argument.text, symbols: '*', via: 'dynamic-import'});
            } else if (ts.isPropertyAccessExpression(node.expression)
                && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'vi'
                && ['mock', 'doMock', 'unmock', 'doUnmock', 'importActual', 'importMock'].includes(node.expression.name.text)
                && argument && ts.isStringLiteralLike(argument)) {
                skippedSpecifierNodes.add(argument);
                runtimeImports.push({specifier: argument.text, symbols: '*', via: 'vi-mock'});
            }
        }

        if (ts.isStringLiteralLike(node) && !skippedSpecifierNodes.has(node)) {
            if (strictRuntimeOnly) {
                if (isUrlImportMetaContext(node)) addFileRef(node.text);
            } else if (!isIgnoredLiteralContext(node)) {
                addFileRef(node.text);
            }
        } else if (ts.isTemplateExpression(node) && !skippedSpecifierNodes.has(node)) {
            if (strictRuntimeOnly) {
                if (isUrlImportMetaContext(node)) addFileRef(resolveTemplateParts(node));
            } else if (!isIgnoredLiteralContext(node)) {
                addFileRef(resolveTemplateParts(node));
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);

    const styleRefs = vueSections?.styleRefs ?? [];
    const templateAssets = vueSections?.templateAssets ?? [];
    const isPureBarrel = !hasRuntimeBody && (reexports.length > 0 || starReexports.length > 0) && fileRefs.length === 0;

    return {runtimeImports, reexports, starReexports, localExports, fileRefs, styleRefs, templateAssets, hasRuntimeBody, isPureBarrel};
}

function createEmptyModuleInfo() {
    return {
        runtimeImports: [],
        reexports: [],
        starReexports: [],
        localExports: new Set(),
        fileRefs: [],
        styleRefs: [],
        templateAssets: [],
        hasRuntimeBody: false,
        isPureBarrel: false,
    };
}

function parseModule(file, source) {
    if (REGISTRY_DATA_FILES.has(file) || !CODE.test(file)) {
        return createEmptyModuleInfo();
    }
    if (file.endsWith('.css')) {
        return {runtimeImports: [], reexports: [], starReexports: [], localExports: new Set(), fileRefs: [], styleRefs: extractCssReferences(source), templateAssets: [], hasRuntimeBody: true, isPureBarrel: false};
    }
    if (SCRIPT_EXT.test(file)) return parseScriptModule(file, source);
    return createEmptyModuleInfo();
}

function shouldParseModuleSource(file) {
    return (DEPENDENCY_CONTENT.test(file) || !file.includes('/'))
        && !REGISTRY_DATA_FILES.has(file)
        && (file.endsWith('.css') || SCRIPT_EXT.test(file));
}

function serializeModuleInfo(info) {
    return {
        runtimeImports: info.runtimeImports.map(imp => ({
            specifier: imp.specifier,
            symbols: imp.symbols === '*' ? '*' : [...imp.symbols],
            via: imp.via,
        })),
        reexports: info.reexports,
        starReexports: info.starReexports,
        localExports: [...info.localExports],
        fileRefs: info.fileRefs,
        styleRefs: info.styleRefs,
        templateAssets: info.templateAssets,
        hasRuntimeBody: info.hasRuntimeBody,
        isPureBarrel: info.isPureBarrel,
    };
}

function deserializeModuleInfo(raw) {
    if (!raw || typeof raw !== 'object'
        || !Array.isArray(raw.runtimeImports)
        || !Array.isArray(raw.reexports)
        || !Array.isArray(raw.starReexports)
        || !Array.isArray(raw.localExports)
        || !Array.isArray(raw.fileRefs)
        || !Array.isArray(raw.styleRefs)
        || !Array.isArray(raw.templateAssets)
        || typeof raw.hasRuntimeBody !== 'boolean'
        || typeof raw.isPureBarrel !== 'boolean') {
        return null;
    }
    const runtimeImports = [];
    for (const imp of raw.runtimeImports) {
        if (!imp || typeof imp.specifier !== 'string' || typeof imp.via !== 'string'
            || (imp.symbols !== '*' && !Array.isArray(imp.symbols))) {
            return null;
        }
        runtimeImports.push({
            specifier: imp.specifier,
            symbols: imp.symbols === '*' ? '*' : new Set(imp.symbols),
            via: imp.via,
        });
    }
    return {
        runtimeImports,
        reexports: raw.reexports,
        starReexports: raw.starReexports,
        localExports: new Set(raw.localExports),
        fileRefs: raw.fileRefs,
        styleRefs: raw.styleRefs,
        templateAssets: raw.templateAssets,
        hasRuntimeBody: raw.hasRuntimeBody,
        isPureBarrel: raw.isPureBarrel,
    };
}

function discoverProjectFiles(root) {
    if (existsSync(path.join(root, '.git'))) {
        try {
            const tracked = execFileSync('git', ['ls-files', '-z'], {
                cwd: root,
                encoding: 'utf8',
                maxBuffer: 32 * 1024 * 1024,
                stdio: ['ignore', 'pipe', 'pipe'],
            }).split('\0');
            const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
                cwd: root,
                encoding: 'utf8',
                maxBuffer: 32 * 1024 * 1024,
                stdio: ['ignore', 'pipe', 'pipe'],
            }).split('\0');
            return [...new Set([...tracked, ...untracked])]
                .filter(file => Boolean(file) && !file.startsWith('.wxt/'))
                .sort();
        } catch {
            // 非标准 Git 环境时回退到目录扫描。
        }
    }
    const found = [];
    const walk = directory => {
        for (const entry of readdirSync(directory, {withFileTypes: true})) {
            if (entry.isDirectory()) {
                if (!WALK_SKIPPED_DIRS.has(entry.name)) walk(path.join(directory, entry.name));
                continue;
            }
            if (entry.isFile()) {
                found.push(path.relative(root, path.join(directory, entry.name)).split(path.sep).join('/'));
            }
        }
    };
    if (existsSync(root)) walk(root);
    return found.sort();
}

function canSafelyWriteDefaultCache(root) {
    if (!existsSync(path.join(root, '.git'))) return true;
    const gitignorePath = path.join(root, '.gitignore');
    if (!existsSync(gitignorePath)) return false;
    try {
        const content = readFileSync(gitignorePath, 'utf8');
        return /(?:^|\r?\n)\.wxt\/?(?:\r?\n|$)/u.test(content);
    } catch {
        return false;
    }
}

function resolveSymbolOrigins(infoMap, known, file, symbol, visited = new Set()) {
    const key = `${file}#${symbol}`;
    if (visited.has(key)) return [];
    visited.add(key);
    const info = infoMap.get(file);
    if (!info) return [file];
    if (info.localExports.has(symbol)) return [file];

    const origins = [];
    const direct = info.reexports.filter(entry => entry.exportedName === symbol);
    if (direct.length > 0) {
        origins.push(file);
        for (const entry of direct) {
            const target = resolveExactModule(known, file, entry.specifier);
            if (!target) continue;
            if (entry.localName === '*') origins.push(target);
            else origins.push(...resolveSymbolOrigins(infoMap, known, target, entry.localName, visited));
        }
        return origins;
    }

    if (info.starReexports.length > 0) {
        let matched = false;
        for (const specifier of info.starReexports) {
            const target = resolveExactModule(known, file, specifier);
            if (!target) continue;
            const nested = resolveSymbolOrigins(infoMap, known, target, symbol, visited);
            if (nested.length > 0) {
                matched = true;
                origins.push(file, ...nested);
            }
        }
        if (matched) return origins;
    }

    return info.hasRuntimeBody ? [file] : [];
}

function buildGraphFromInfoMap(infoMap, known) {
    const barrels = new Set();
    for (const [owner, info] of infoMap) {
        if (info.isPureBarrel) barrels.add(owner);
    }

    const graph = new Map();
    const wildcardBarrelImporters = new Map();

    for (const [owner, info] of infoMap) {
        const deps = new Set();
        if (info.isPureBarrel) {
            for (const entry of info.reexports) {
                const target = resolveExactModule(known, owner, entry.specifier);
                if (target) deps.add(target);
            }
            for (const specifier of info.starReexports) {
                const target = resolveExactModule(known, owner, specifier);
                if (target) deps.add(target);
            }
            graph.set(owner, deps);
            continue;
        }

        for (const imp of info.runtimeImports) {
            const target = resolveExactModule(known, owner, imp.specifier);
            if (!target) continue;
            if (barrels.has(target) && imp.symbols !== '*') {
                // 导入具名符号：依赖 barrel 自身 + 该符号对应的具体源模块，不挂接 barrel 内的无关兄弟模块。
                deps.add(target);
                for (const symbol of imp.symbols) {
                    for (const origin of resolveSymbolOrigins(infoMap, known, target, symbol)) deps.add(origin);
                }
            } else {
                deps.add(target);
                if (barrels.has(target) && imp.symbols === '*') {
                    if (!wildcardBarrelImporters.has(target)) wildcardBarrelImporters.set(target, new Set());
                    wildcardBarrelImporters.get(target).add(owner);
                }
            }
        }
        // 非纯 barrel 但仍有 re-export（例如同时定义自身函数并 re-export 外部符号）
        for (const entry of info.reexports) {
            const target = resolveExactModule(known, owner, entry.specifier);
            if (target) deps.add(target);
        }
        for (const specifier of info.starReexports) {
            const target = resolveExactModule(known, owner, specifier);
            if (target) deps.add(target);
        }
        for (const ref of info.fileRefs) {
            for (const file of resolvePathReference(known, owner, ref).files) deps.add(file);
        }
        for (const styleRef of info.styleRefs) {
            const target = resolveExactModule(known, owner, styleRef);
            if (target) deps.add(target);
        }
        for (const assetRef of info.templateAssets) {
            const target = resolveExactModule(known, owner, assetRef);
            if (target) deps.add(target);
        }
        deps.delete(owner);
        graph.set(owner, deps);
    }

    // 反向传播图：纯 barrel 的子节点改动只透传给 wildcard 导入该 barrel 的模块；
    // 具名导入者已直接挂在符号源模块上，不会被 barrel 里的无关兄弟改动唤醒。
    const reverse = new Map();
    const addReverse = (dependency, owner) => {
        if (dependency === owner) return;
        if (!reverse.has(dependency)) reverse.set(dependency, new Set());
        reverse.get(dependency).add(owner);
    };

    for (const [owner, deps] of graph) {
        if (barrels.has(owner)) {
            const wildcardConsumers = wildcardBarrelImporters.get(owner);
            if (!wildcardConsumers?.size) continue;
            for (const dependency of deps) {
                for (const consumer of wildcardConsumers) addReverse(dependency, consumer);
            }
            continue;
        }
        for (const dependency of deps) addReverse(dependency, owner);
    }

    return {graph, reverse, barrels, infoMap, known};
}

/**
 * 构建完整依赖分析结构：
 * - `graph`: owner -> Set<dependency>（直接与经纯 barrel 按符号展开后的运行时依赖）
 * - `reverse`: dependency -> Set<owner>（反向传播图：纯 barrel 仅向通配导入者传播，避免兄弟模块污染）
 * - `barrels`: 纯 re-export barrel 集合
 * - `infoMap`: 各文件的 AST 摘要
 */
export function analyzeDependencyGraph(files) {
    const known = new Set(Object.keys(files));
    const infoMap = new Map();
    for (const [owner, source] of Object.entries(files)) {
        infoMap.set(owner, parseModule(owner, source));
    }
    return buildGraphFromInfoMap(infoMap, known);
}

/**
 * 带增量磁盘缓存的仓库依赖图分析器：
 * - 按每个可解析源码文件的 mtimeNs/mtimeMs + size 命中缓存，跳过未改动文件的磁盘读取与 TS AST 解析；
 * - 缓存写入 <projectRoot>/.wxt/cache/dep-graph-v1.json（损坏或版本变更时自动降级重建）；
 * - 产出与无缓存 analyzeDependencyGraph 完全等价的 graph / reverse / barrels / infoMap / known。
 */
export function analyzeProjectDependencyGraph(projectRoot, options = {}) {
    const root = path.resolve(projectRoot);
    const useCache = !options.noCache;
    const explicitCachePath = typeof options.cachePath === 'string' && options.cachePath.length > 0;
    const cachePath = path.resolve(root, explicitCachePath ? options.cachePath : DEFAULT_DEP_GRAPH_CACHE_PATH);
    const rawPaths = options.filePaths
        ? [...new Set(options.filePaths)].sort()
        : discoverProjectFiles(root);
    const virtualEmptyFiles = options.virtualEmptyFiles ? [...new Set(options.virtualEmptyFiles)].sort() : [];

    let previousEntries = {};
    let loadedValidCache = false;
    if (useCache && existsSync(cachePath)) {
        try {
            const parsed = JSON.parse(readFileSync(cachePath, 'utf8'));
            if (parsed && parsed.version === DEP_GRAPH_CACHE_VERSION && parsed.entries && typeof parsed.entries === 'object') {
                previousEntries = parsed.entries;
                loadedValidCache = true;
            }
        } catch {
            // 损坏缓存自动退回冷构建，不中断主流程。
        }
    }

    const existingFiles = new Set();
    const known = new Set();
    const infoMap = new Map();
    const nextEntries = {};
    let hits = 0;
    let misses = 0;
    let dirty = false;

    for (const file of rawPaths) {
        const absolute = path.join(root, file);
        let stat;
        try {
            stat = statSync(absolute, {bigint: true});
        } catch {
            continue;
        }
        if (!stat.isFile()) continue;
        existingFiles.add(file);
        known.add(file);

        if (!shouldParseModuleSource(file)) {
            infoMap.set(file, createEmptyModuleInfo());
            continue;
        }

        const size = Number(stat.size);
        const mtimeMs = Number(stat.mtimeMs);
        const mtimeNs = stat.mtimeNs.toString();
        const cached = Object.hasOwn(previousEntries, file) ? previousEntries[file] : undefined;
        if (useCache && cached && cached.size === size
            && (cached.mtimeNs ? cached.mtimeNs === mtimeNs : cached.mtimeMs === mtimeMs)) {
            const restored = deserializeModuleInfo(cached.info);
            if (restored) {
                infoMap.set(file, restored);
                nextEntries[file] = cached;
                hits += 1;
                continue;
            }
        }

        const source = readFileSync(absolute, 'utf8');
        const info = parseModule(file, source);
        infoMap.set(file, info);
        nextEntries[file] = {mtimeMs, mtimeNs, size, info: serializeModuleInfo(info)};
        misses += 1;
        dirty = true;
    }

    const isPartialScan = Boolean(options.filePaths);
    let evicted = 0;
    for (const cachedFile of Object.keys(previousEntries)) {
        if (!Object.hasOwn(nextEntries, cachedFile)) {
            if (isPartialScan && !explicitCachePath) {
                nextEntries[cachedFile] = previousEntries[cachedFile];
            } else {
                evicted += 1;
                dirty = true;
            }
        }
    }

    for (const file of virtualEmptyFiles) {
        if (!known.has(file)) {
            known.add(file);
            infoMap.set(file, parseModule(file, ''));
        }
    }

    const shouldPersist = useCache && (dirty || !loadedValidCache)
        && (explicitCachePath || canSafelyWriteDefaultCache(root));
    if (shouldPersist) {
        try {
            mkdirSync(path.dirname(cachePath), {recursive: true});
            const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
            writeFileSync(tempPath, JSON.stringify({version: DEP_GRAPH_CACHE_VERSION, entries: nextEntries}));
            renameSync(tempPath, cachePath);
        } catch {
            // 缓存目录不可写时静默降级为纯内存执行。
        }
    }

    const analysis = buildGraphFromInfoMap(infoMap, known);
    return {
        ...analysis,
        existingFiles,
        cacheStats: {
            hits,
            misses,
            evicted,
            total: hits + misses,
            fromCache: loadedValidCache && misses === 0,
            cachePath,
        },
    };
}

export function buildDependencyGraph(files) {
    return analyzeDependencyGraph(files).graph;
}

/** 从反向图计算修改 seeds 后受影响的所有模块闭包（包含 seeds 自身）。 */
export function collectAffectedClosure(reverse, seeds) {
    const affected = new Set(seeds);
    const queue = [...affected];
    for (let index = 0; index < queue.length; index++) {
        for (const owner of reverse.get(queue[index]) ?? []) {
            if (!affected.has(owner)) {
                affected.add(owner);
                queue.push(owner);
            }
        }
    }
    return affected;
}

/** 诊断：列出单个文件的每条出边来源与分类（--why 使用）。 */
export function explainDependencies(owner, source, known, files = null) {
    if (REGISTRY_DATA_FILES.has(owner)) return [];
    const info = parseModule(owner, source);
    const rows = [];
    const infoMap = files instanceof Map ? files : (files ? analyzeDependencyGraph(files).infoMap : null);

    for (const imp of info.runtimeImports) {
        const target = resolveExactModule(known, owner, imp.specifier);
        if (!target) continue;
        if (infoMap && infoMap.get(target)?.isPureBarrel && imp.symbols !== '*') {
            const resolved = new Set([target]);
            for (const symbol of imp.symbols) {
                for (const origin of resolveSymbolOrigins(infoMap, known, target, symbol)) resolved.add(origin);
            }
            rows.push({reference: `${imp.specifier} {${[...imp.symbols].join(', ')}}`, via: 'barrel-symbol', files: [...resolved]});
        } else {
            rows.push({reference: imp.specifier, via: imp.via, files: [target]});
        }
    }
    for (const entry of info.reexports) {
        const target = resolveExactModule(known, owner, entry.specifier);
        if (target) rows.push({reference: `${entry.specifier} (export ${entry.exportedName})`, via: 'import', files: [target]});
    }
    for (const specifier of info.starReexports) {
        const target = resolveExactModule(known, owner, specifier);
        if (target) rows.push({reference: `${specifier} (export *)`, via: 'import', files: [target]});
    }
    for (const ref of info.fileRefs) {
        const label = typeof ref === 'string' ? ref : ref.parts.join('${…}');
        const resolved = resolvePathReference(known, owner, ref);
        if (resolved.files.length) rows.push({reference: label, via: resolved.via, files: resolved.files});
    }
    for (const styleRef of info.styleRefs) {
        const target = resolveExactModule(known, owner, styleRef);
        if (target) rows.push({reference: styleRef, via: 'css-import', files: [target]});
    }
    for (const assetRef of info.templateAssets) {
        const target = resolveExactModule(known, owner, assetRef);
        if (target) rows.push({reference: assetRef, via: 'vue-asset', files: [target]});
    }
    return rows;
}
