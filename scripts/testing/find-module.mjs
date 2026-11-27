#!/usr/bin/env node

/**
 * @file scripts/testing/find-module.mjs
 * 文件职责：零盲搜源码模块定位器，基于源码文件头语义注释建立增量磁盘索引并支持多词加权检索。
 * 主要内容：
 * - 解析 src/（以及可选 scripts/testing/）文件头的 @file、文件职责、主要内容与模块边界注释；
 * - 按文件 mtimeNs/mtimeMs + size 缓存解析结果到 .wxt/cache/module-index-v1.json，损坏或目录缺失时自动降级重建；
 * - 支持多词大小写不敏感加权评分（路径与文件职责权重最高）、--dir 前缀过滤、--limit 限流、--include-scripts、--no-cache 与 --json；
 * - 终端默认输出紧凑单行摘要（路径 + 单行文件职责），最大限度降低 AI 与开发者定位模块的 token 消耗。
 * 模块边界：纯只读检索与本地缓存维护，不修改任何源码或注册表，也不执行测试或构建。
 * 用法：node scripts/testing/find-module.mjs <query...> [--dir <prefix>] [--limit <n>] [--include-scripts] [--json] [--no-cache]
 */

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const DEFAULT_MODULE_INDEX_CACHE_PATH = '.wxt/cache/module-index-v1.json';
const SELF_HASH = createHash('sha256')
    .update(readFileSync(fileURLToPath(import.meta.url), 'utf8'))
    .digest('hex')
    .slice(0, 12);
export const MODULE_INDEX_CACHE_VERSION = `module-index-v1:${SELF_HASH}`;

const SRC_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.vue', '.css', '.md']);
const SCRIPT_EXTENSIONS = new Set(['.mjs', '.ts', '.cjs', '.js']);
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.wxt', '.output', 'coverage', 'dist', 'temp', 'image-format-fixtures', 'evidence']);
const SECTION_PREFIXES = [
    ['responsibility', '文件职责：'],
    ['contents', '主要内容：'],
    ['boundary', '模块边界：'],
];
const OTHER_SECTION_PATTERN = /^(?:用法|背景|注意|依赖|参考)[：:]/u;

export function parseArguments(argv) {
    const options = {
        queries: [],
        dir: null,
        limit: 15,
        includeScripts: false,
        json: false,
        noCache: false,
        help: false,
    };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--') continue;
        if (arg === '--help' || arg === '-h') return {...options, help: true};
        if (arg === '--json') {options.json = true; continue;}
        if (arg === '--no-cache') {options.noCache = true; continue;}
        if (arg === '--include-scripts') {options.includeScripts = true; continue;}
        if (arg === '--dir' || arg === '--limit') {
            const value = argv[++index];
            if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
            if (arg === '--dir') {
                options.dir = value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
            } else {
                const parsed = Number(value);
                if (!Number.isInteger(parsed) || parsed < 1) throw new Error('--limit 需要正整数');
                options.limit = parsed;
            }
            continue;
        }
        if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`);
        options.queries.push(arg);
    }
    if (!options.queries.length) {
        throw new Error('必须提供至少一个检索关键词');
    }
    return options;
}

export function parseHeader(filePath, source) {
    const normalizedPath = filePath.replaceAll('\\', '/');
    const stripped = source.replace(/^#![^\n]*\r?\n+/u, '');
    const isHtmlComment = normalizedPath.endsWith('.vue') || normalizedPath.endsWith('.md');
    const match = isHtmlComment
        ? stripped.match(/^<!--([\s\S]*?)-->/u)
        : stripped.match(/^\/\*\*([\s\S]*?)\*\//u);

    if (!match) {
        return {
            path: normalizedPath,
            fileTag: null,
            responsibility: '',
            contents: '',
            boundary: '',
            hasHeader: false,
        };
    }

    const lines = match[1]
        .split(/\r?\n/u)
        .map(line => line.trim().replace(/^\*\s?/u, '').trim())
        .filter(Boolean);

    let fileTag = null;
    const sections = {responsibility: [], contents: [], boundary: []};
    let activeSection = null;
    const fallbackLead = [];

    for (const line of lines) {
        if (line.startsWith('@file ')) {
            fileTag = line.slice('@file '.length).trim();
            activeSection = null;
            continue;
        }
        const matchedSection = SECTION_PREFIXES.find(([, prefix]) => line.startsWith(prefix));
        if (matchedSection) {
            const [key, prefix] = matchedSection;
            activeSection = key;
            const value = line.slice(prefix.length).trim();
            if (value) sections[key].push(value);
            continue;
        }
        if (OTHER_SECTION_PATTERN.test(line)) {
            activeSection = null;
            continue;
        }
        if (activeSection) {
            sections[activeSection].push(line.replace(/^[-*]\s+/u, ''));
        } else if (!sections.responsibility.length && !sections.contents.length) {
            fallbackLead.push(line);
        }
    }

    const compact = values => values.join(' ').replace(/\s+/gu, ' ').trim();
    const responsibility = compact(sections.responsibility) || compact(fallbackLead);

    return {
        path: normalizedPath,
        fileTag,
        responsibility,
        contents: compact(sections.contents),
        boundary: compact(sections.boundary),
        hasHeader: Boolean(fileTag || responsibility || sections.contents.length || sections.boundary.length),
    };
}

function listCandidateFiles(root, roots) {
    const found = [];
    const walk = (directory, extensions) => {
        if (!existsSync(directory)) return;
        for (const entry of readdirSync(directory, {withFileTypes: true})) {
            if (entry.name === '.DS_Store') continue;
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!SKIPPED_DIRS.has(entry.name)) walk(absolute, extensions);
                continue;
            }
            if (!entry.isFile()) continue;
            const ext = path.extname(entry.name);
            if (!extensions.has(ext) || /\.d(?:\.[^./]+)?\.ts$/u.test(entry.name)) continue;
            found.push(path.relative(root, absolute).split(path.sep).join('/'));
        }
    };

    for (const relRoot of roots) {
        const normalized = relRoot.replaceAll('\\', '/').replace(/\/+$/u, '');
        const extensions = normalized.startsWith('scripts') ? SCRIPT_EXTENSIONS : SRC_EXTENSIONS;
        walk(path.join(root, normalized), extensions);
    }
    return [...new Set(found)].sort();
}

function canSafelyWriteDefaultCache(root) {
    if (!existsSync(path.join(root, '.git'))) return true;
    const gitignorePath = path.join(root, '.gitignore');
    if (!existsSync(gitignorePath)) return false;
    try {
        return /(?:^|\r?\n)\.wxt\/?(?:\r?\n|$)/u.test(readFileSync(gitignorePath, 'utf8'));
    } catch {
        return false;
    }
}

function isValidCachedEntry(raw) {
    return Boolean(raw && typeof raw === 'object'
        && typeof raw.path === 'string'
        && typeof raw.responsibility === 'string'
        && typeof raw.contents === 'string'
        && typeof raw.boundary === 'string'
        && typeof raw.hasHeader === 'boolean');
}

export function loadModuleIndex(projectRoot, options = {}) {
    const root = path.resolve(projectRoot);
    const roots = options.roots ?? (options.includeScripts ? ['src', 'scripts/testing'] : ['src']);
    const useCache = !options.noCache;
    const explicitCachePath = typeof options.cachePath === 'string' && options.cachePath.length > 0;
    const cachePath = path.resolve(root, explicitCachePath ? options.cachePath : DEFAULT_MODULE_INDEX_CACHE_PATH);

    let previousEntries = {};
    let loadedValidCache = false;
    if (useCache && existsSync(cachePath)) {
        try {
            const parsed = JSON.parse(readFileSync(cachePath, 'utf8'));
            if (parsed && parsed.version === MODULE_INDEX_CACHE_VERSION && parsed.entries && typeof parsed.entries === 'object') {
                previousEntries = parsed.entries;
                loadedValidCache = true;
            }
        } catch {
            // 损坏缓存自动降级为重建。
        }
    }

    const candidates = listCandidateFiles(root, roots);
    const nextEntries = {...previousEntries};
    const activeSet = new Set(candidates);
    const entries = [];
    let hits = 0;
    let misses = 0;
    let dirty = false;

    for (const file of candidates) {
        const absolute = path.join(root, file);
        let stat;
        try {
            stat = statSync(absolute, {bigint: true});
        } catch {
            continue;
        }
        if (!stat.isFile()) continue;

        const size = Number(stat.size);
        const mtimeMs = Number(stat.mtimeMs);
        const mtimeNs = stat.mtimeNs.toString();
        const cached = Object.hasOwn(previousEntries, file) ? previousEntries[file] : undefined;
        if (useCache && cached && cached.size === size
            && (cached.mtimeNs ? cached.mtimeNs === mtimeNs : cached.mtimeMs === mtimeMs)
            && isValidCachedEntry(cached.entry)) {
            entries.push(cached.entry);
            nextEntries[file] = cached;
            hits += 1;
            continue;
        }

        const source = readFileSync(absolute, 'utf8');
        const entry = parseHeader(file, source);
        entries.push(entry);
        nextEntries[file] = {mtimeMs, mtimeNs, size, entry};
        misses += 1;
        dirty = true;
    }

    // 仅清理本次扫描 roots 下已删除文件的旧缓存记录，避免开关 --include-scripts 相互抖动。
    const rootPrefixes = roots.map(item => `${item.replaceAll('\\', '/').replace(/\/+$/u, '')}/`);
    let evicted = 0;
    for (const cachedFile of Object.keys(nextEntries)) {
        if (rootPrefixes.some(prefix => cachedFile.startsWith(prefix)) && !activeSet.has(cachedFile)) {
            delete nextEntries[cachedFile];
            evicted += 1;
            dirty = true;
        }
    }

    const shouldPersist = useCache && (dirty || !loadedValidCache)
        && (explicitCachePath || canSafelyWriteDefaultCache(root));
    if (shouldPersist) {
        try {
            mkdirSync(path.dirname(cachePath), {recursive: true});
            const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
            writeFileSync(tempPath, JSON.stringify({version: MODULE_INDEX_CACHE_VERSION, entries: nextEntries}));
            renameSync(tempPath, cachePath);
        } catch {
            // 缓存目录不可写时降级为纯内存执行。
        }
    }

    return {
        entries,
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

export function tokenizeQuery(queries) {
    const rawList = Array.isArray(queries) ? queries : [String(queries ?? '')];
    const tokens = [];
    const seen = new Set();
    for (const item of rawList) {
        for (const piece of String(item).trim().toLowerCase().split(/\s+/u)) {
            if (piece && !seen.has(piece)) {
                seen.add(piece);
                tokens.push(piece);
            }
        }
    }
    return tokens;
}

export function searchModules(entries, queries, options = {}) {
    const tokens = tokenizeQuery(queries);
    const dirPrefix = options.dir ? options.dir.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '') : null;
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 15;

    const scoped = dirPrefix
        ? entries.filter(entry => entry.path === dirPrefix || entry.path.startsWith(`${dirPrefix}/`))
        : entries;

    if (!tokens.length) {
        return {totalIndexed: scoped.length, totalMatched: 0, results: []};
    }

    const scored = [];
    for (const entry of scoped) {
        const lowerPath = entry.path.toLowerCase();
        const baseName = path.posix.basename(lowerPath);
        const stem = baseName.replace(/\.[^.]+$/u, '');
        const lowerResp = entry.responsibility.toLowerCase();
        const lowerContents = entry.contents.toLowerCase();
        const lowerBoundary = entry.boundary.toLowerCase();

        let score = 0;
        let matchedTokens = 0;

        for (const token of tokens) {
            let tokenScore = 0;
            if (stem === token || baseName === token) tokenScore += 20;
            else if (baseName.includes(token)) tokenScore += 14;
            else if (lowerPath.includes(token)) tokenScore += 10;

            if (lowerResp.includes(token)) tokenScore += 8;
            if (lowerContents.includes(token)) tokenScore += 4;
            if (lowerBoundary.includes(token)) tokenScore += 2;

            if (tokenScore > 0) {
                matchedTokens += 1;
                score += tokenScore;
            }
        }

        if (matchedTokens === 0) continue;
        if (matchedTokens === tokens.length && tokens.length > 1) score += 20;

        scored.push({
            path: entry.path,
            score,
            matchedTokens,
            responsibility: entry.responsibility,
            contents: entry.contents,
            boundary: entry.boundary,
        });
    }

    scored.sort((left, right) => right.matchedTokens - left.matchedTokens
        || right.score - left.score
        || left.path.localeCompare(right.path));

    return {
        totalIndexed: scoped.length,
        totalMatched: scored.length,
        results: scored.slice(0, limit),
    };
}

export function formatResults(queryLabel, searchResult) {
    const lines = [
        `[find-module] "${queryLabel}" → ${searchResult.totalMatched}/${searchResult.totalIndexed} 命中（展示前 ${searchResult.results.length} 条）`,
    ];
    if (!searchResult.results.length) {
        lines.push('  （无匹配模块，请尝试更短的关键词或加 --include-scripts）');
        return lines.join('\n');
    }
    for (const item of searchResult.results) {
        const rawSummary = item.responsibility || item.contents || '（无文件职责说明）';
        const summary = rawSummary.length > 110 ? `${rawSummary.slice(0, 107)}...` : rawSummary;
        lines.push(`  ${item.path} — ${summary}`);
    }
    return lines.join('\n');
}

export function main(argv = process.argv.slice(2)) {
    const options = parseArguments(argv);
    if (options.help) {
        console.log('用法: node scripts/testing/find-module.mjs <query...> [--dir <prefix>] [--limit <n>] [--include-scripts] [--json] [--no-cache]');
        return;
    }
    const includeScripts = options.includeScripts || Boolean(options.dir && options.dir.startsWith('scripts'));
    const {entries} = loadModuleIndex(PROJECT_ROOT, {
        includeScripts,
        noCache: options.noCache,
    });
    const result = searchModules(entries, options.queries, {dir: options.dir, limit: options.limit});
    const queryLabel = options.queries.join(' ');
    if (options.json) {
        console.log(JSON.stringify({query: queryLabel, dir: options.dir, ...result}, null, 2));
        return;
    }
    console.log(formatResults(queryLabel, result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        main();
    } catch (error) {
        console.error(`[find-module] ${error.message}`);
        process.exitCode = 1;
    }
}
