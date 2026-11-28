#!/usr/bin/env node

/**
 * @file scripts/i18n/scaffold-feature-messages.mjs
 * 文件职责：为新功能模块一键生成符合仓库七语言规范的静态 JSON 文案目录与带类型包装的 TypeScript 导出入口。
 * 主要内容：
 * - 校验 kebab-case 功能名并派生 camelCase 模块标识；
 * - 按 `src/core/i18n/messages/dictionaryWorkspace.ts` 约定生成 `zh-CN`、`en-US`、`ja-JP`、`ko-KR`、`fr-FR`、`ru-RU`、`es-ES` 七份 JSON 文件及包装 `.ts`；
 * - 生成满足 `tests/architecture/sourceFileHeaders.test.ts` 长度（≥160 字符）与中文分节要求的文件头注释；
 * - 默认拒绝覆盖已有文件，支持 `--title`、`--keys`、`--dir`、`--dry-run` 与 `--force`。
 * 模块边界：仅操作本地文件系统脚手架，不修改全局语言总表注册、不执行网络翻译或运行时构建。
 */

import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DEFAULT_BASE_DIR = path.resolve(PROJECT_ROOT, 'src/core/i18n/messages');

export const SUPPORTED_LOCALES = Object.freeze([
    'zh-CN',
    'en-US',
    'ja-JP',
    'ko-KR',
    'fr-FR',
    'ru-RU',
    'es-ES',
]);

const LOCALE_IMPORT_IDENTIFIERS = Object.freeze({
    'zh-CN': 'chinese',
    'en-US': 'english',
    'ja-JP': 'japanese',
    'ko-KR': 'korean',
    'fr-FR': 'french',
    'ru-RU': 'russian',
    'es-ES': 'spanish',
});

const KEBAB_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const MESSAGE_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;

/** 校验功能目录名必须为小写 kebab-case，避免非法标识符与路径穿越。 */
export function validateFeatureName(name) {
    if (typeof name !== 'string' || !KEBAB_NAME_PATTERN.test(name)) {
        throw new Error(`无效的功能名称「${String(name ?? '')}」：必须使用小写 kebab-case（例如 smart-glossary）`);
    }
    return name;
}

/** 将 kebab-case 功能名转换为 camelCase 模块标识。 */
export function kebabToCamelCase(name) {
    validateFeatureName(name);
    return name.replace(/-([a-z0-9])/gu, (_, char) => char.toUpperCase());
}

function normalizeKeys(keysInput, camelCaseName) {
    if (!keysInput || keysInput.length === 0) {
        return [`${camelCaseName}.title`, `${camelCaseName}.description`];
    }
    const rawList = Array.isArray(keysInput) ? keysInput : String(keysInput).split(',');
    const unique = [];
    const seen = new Set();
    for (const item of rawList) {
        const key = String(item).trim();
        if (!key) continue;
        if (!MESSAGE_KEY_PATTERN.test(key)) {
            throw new Error(`无效的文案键「${key}」：仅允许字母、数字、点、下划线和连字符`);
        }
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(key);
        }
    }
    if (unique.length === 0) {
        throw new Error('--keys 至少需要提供一个有效文案键');
    }
    return unique;
}

function defaultMessageValue(locale, key, title) {
    if (locale === 'zh-CN') {
        if (key.endsWith('.title')) return title;
        if (key.endsWith('.description')) return `${title}的相关配置与操作说明。`;
        const suffix = key.includes('.') ? key.slice(key.lastIndexOf('.') + 1) : key;
        return `${title}（${suffix}）`;
    }
    return `[${locale}] ${key}`;
}

function resolveHeaderFileTag(wrapperPath, root, camelCaseName) {
    const relative = path.relative(root, wrapperPath).split(path.sep).join('/');
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return relative;
    }
    return `src/core/i18n/messages/${camelCaseName}.ts`;
}

function renderWrapperSource({fileTag, featureName, camelCaseName, title}) {
    const imports = SUPPORTED_LOCALES.map(
        locale => `import ${LOCALE_IMPORT_IDENTIFIERS[locale]} from './${featureName}/${locale}.json';`,
    );
    const mappingEntries = SUPPORTED_LOCALES.map(
        locale => `'${locale}': ${LOCALE_IMPORT_IDENTIFIERS[locale]}`,
    ).join(', ');
    return [
        '/**',
        ` * @file ${fileTag}`,
        ` * 文件职责：提供「${title}」（${featureName}）功能模块的界面文案、操作提示与状态反馈七语言静态目录。`,
        ` * 主要内容：统一维护 ${featureName} 目录下的简体中文与六语 JSON 文案资源，并导出带类型约束的按语言只读映射对象。`,
        ' * 模块边界：纯静态界面文案资源封装，不包含运行时状态管理、网络请求、浏览器 API 调用或用户配置持久化逻辑。',
        ' */',
        "import type {UiLanguage} from '../types';",
        ...imports,
        `export const ${camelCaseName}ChineseMessages = chinese;`,
        `export const ${camelCaseName}Messages: Readonly<Record<UiLanguage, Readonly<Record<string, string>>>> = {${mappingEntries}};`,
        '',
    ].join('\n');
}

/** 根据参数构建待生成的文件计划，不触碰磁盘。 */
export function buildFeatureMessagePlan({
    featureName,
    title,
    keys,
    dir = DEFAULT_BASE_DIR,
    root = PROJECT_ROOT,
}) {
    validateFeatureName(featureName);
    const camelCaseName = kebabToCamelCase(featureName);
    const baseDir = path.resolve(dir);
    const resolvedTitle = typeof title === 'string' && title.trim()
        ? title.trim()
        : `${featureName} 功能界面`;
    if (/[\r\n]|\*\//u.test(resolvedTitle)) {
        throw new Error('标题不能包含换行符或注释结束符 "*/"');
    }
    const normalizedKeys = normalizeKeys(keys, camelCaseName);
    const localeDir = path.join(baseDir, featureName);
    const wrapperPath = path.join(baseDir, `${camelCaseName}.ts`);
    const fileTag = resolveHeaderFileTag(wrapperPath, path.resolve(root), camelCaseName);

    const files = SUPPORTED_LOCALES.map(locale => {
        const record = {};
        for (const key of normalizedKeys) {
            record[key] = defaultMessageValue(locale, key, resolvedTitle);
        }
        return {
            path: path.join(localeDir, `${locale}.json`),
            kind: 'locale-json',
            locale,
            content: `${JSON.stringify(record, null, 2)}\n`,
        };
    });

    files.push({
        path: wrapperPath,
        kind: 'wrapper-ts',
        locale: null,
        content: renderWrapperSource({
            fileTag,
            featureName,
            camelCaseName,
            title: resolvedTitle,
        }),
    });

    return {
        featureName,
        camelCaseName,
        title: resolvedTitle,
        baseDir,
        localeDir,
        wrapperPath,
        keys: normalizedKeys,
        files,
    };
}

/** 执行脚手架生成；默认拒绝覆盖任何已存在文件，除非显式传入 force。 */
export function scaffoldFeatureMessages(options) {
    const {dryRun = false, force = false} = options;
    const plan = buildFeatureMessagePlan(options);
    const conflicts = plan.files.filter(file => existsSync(file.path)).map(file => file.path);

    if (conflicts.length > 0 && !force) {
        throw new Error(`目标文件已存在（如需覆盖请显式传入 --force）：\n${conflicts.join('\n')}`);
    }

    if (!dryRun) {
        mkdirSync(plan.localeDir, {recursive: true});
        for (const file of plan.files) {
            writeFileSync(file.path, file.content, 'utf8');
        }
    }

    return {
        ...plan,
        dryRun: Boolean(dryRun),
        force: Boolean(force),
        written: dryRun ? [] : plan.files.map(file => file.path),
        conflicts,
    };
}

/** 解析命令行参数。 */
export function parseArguments(argv) {
    const options = {
        featureName: '',
        title: undefined,
        keys: undefined,
        dir: DEFAULT_BASE_DIR,
        dryRun: false,
        force: false,
        help: false,
    };

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--') continue;
        if (arg === '--help' || arg === '-h') {
            options.help = true;
            return options;
        }
        if (arg === '--dry-run') {
            options.dryRun = true;
            continue;
        }
        if (arg === '--force') {
            options.force = true;
            continue;
        }
        if (arg === '--title' || arg === '--keys' || arg === '--dir') {
            const value = argv[++index];
            if (value === undefined || !value.trim() || value.startsWith('-')) {
                throw new Error(`${arg} 缺少参数值`);
            }
            if (arg === '--title') options.title = value;
            else if (arg === '--keys') options.keys = value;
            else options.dir = path.resolve(value);
            continue;
        }
        if (arg.startsWith('-')) {
            throw new Error(`未知参数：${arg}`);
        }
        if (options.featureName) {
            throw new Error(`多余的位置参数：${arg}`);
        }
        options.featureName = arg;
    }

    if (!options.featureName) {
        throw new Error('缺少必需参数 <feature-kebab-name>（使用 --help 查看用法）');
    }
    validateFeatureName(options.featureName);
    return options;
}

export async function main(argv = process.argv.slice(2)) {
    const options = parseArguments(argv);
    if (options.help) {
        console.log('用法: node scripts/i18n/scaffold-feature-messages.mjs <feature-kebab-name> [--title <中文模块名>] [--keys <k1,k2>] [--dir <baseDir>] [--dry-run] [--force]');
        return;
    }
    const result = scaffoldFeatureMessages(options);
    const prefix = result.dryRun ? '[i18n-scaffold] DRY-RUN 将生成' : '[i18n-scaffold] 已生成';
    console.log(`${prefix} ${result.files.length} 个文件（模块：${result.camelCaseName}，键数：${result.keys.length}）：`);
    for (const file of result.files) {
        console.log(`  - ${file.path}`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch(error => {
        console.error(`[i18n-scaffold] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}
