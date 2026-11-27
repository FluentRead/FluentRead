/**
 * @file tests/scaffoldFeatureMessages.test.ts
 * 文件职责：验证 i18n 模块化文案脚手架的文件生成、七语言 JSON 有效性、文件头规范与覆盖保护契约。
 * 主要内容：覆盖计划构建、七语目录与 TS 包装文件写入、≥160 字符中文文件头校验、dry-run 与 overwrite 保护以及 CLI 执行。
 * 模块边界：仅在临时目录中验证脚手架脚本行为，不写入或修改仓库内正式语言目录。
 */
import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
    buildFeatureMessagePlan,
    kebabToCamelCase,
    parseArguments,
    scaffoldFeatureMessages,
    SUPPORTED_LOCALES,
    validateFeatureName,
} from '../scripts/i18n/scaffold-feature-messages.mjs';

const PROJECT_ROOT = resolve(__dirname, '..');
const SCRIPT_PATH = resolve(PROJECT_ROOT, 'scripts/i18n/scaffold-feature-messages.mjs');
const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop()!, {recursive: true, force: true});
    }
});

function assertCompliantSourceHeader(source: string, expectedFileTag: string): void {
    const match = source.match(/^\/\*\*[\s\S]*?\*\//u);
    expect(match, '必须从首字符起包含 JSDoc 文件头').not.toBeNull();
    const header = match![0];
    expect(header.length).toBeGreaterThanOrEqual(160);
    expect(header).not.toMatch(/(?:TODO|待补充|此文件负责相关功能|文件职责：\s*(?:无|未知|待定))/u);

    const lines = header.split('\n')
        .map(line => line.trim())
        .map(line => (['/**', '*/'].includes(line) ? '' : line.replace(/^\*\s?/u, '').trim()))
        .filter(Boolean);

    expect(lines.filter(line => line.startsWith('@file '))).toEqual([`@file ${expectedFileTag}`]);
    for (const label of ['文件职责：', '主要内容：', '模块边界：']) {
        const matched = lines.filter(line => line.startsWith(label));
        expect(matched).toHaveLength(1);
        const value = matched[0]!.slice(label.length).trim();
        expect(value.length).toBeGreaterThanOrEqual(12);
        expect(value).toMatch(/\p{Script=Han}/u);
    }
}

describe('i18n feature messages scaffold', () => {
    it('校验 kebab-case 功能名并正确派生 camelCase 标识', () => {
        expect(validateFeatureName('smart-glossary')).toBe('smart-glossary');
        expect(kebabToCamelCase('smart-glossary')).toBe('smartGlossary');
        expect(kebabToCamelCase('pdf-reader-v2')).toBe('pdfReaderV2');

        for (const invalid of ['', 'SmartGlossary', 'smart_glossary', '../escape', '-leading', 'trailing-', 'a--b']) {
            expect(() => validateFeatureName(invalid)).toThrow(/kebab-case/u);
        }
    });

    it('生成七语言合法 JSON 与符合仓库文件头规范的 TS 包装模块', () => {
        const tempRoot = createTempDir('fluentread-i18n-scaffold-');
        const baseDir = join(tempRoot, 'src', 'core', 'i18n', 'messages');

        const result = scaffoldFeatureMessages({
            featureName: 'smart-glossary',
            title: '智能术语表',
            keys: ['glossary.title', 'glossary.save', 'glossary.empty'],
            dir: baseDir,
            root: tempRoot,
        });

        expect(result.dryRun).toBe(false);
        expect(result.camelCaseName).toBe('smartGlossary');
        expect(result.written).toHaveLength(SUPPORTED_LOCALES.length + 1);

        for (const locale of SUPPORTED_LOCALES) {
            const jsonPath = join(baseDir, 'smart-glossary', `${locale}.json`);
            expect(existsSync(jsonPath)).toBe(true);
            const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<string, string>;
            expect(Object.keys(parsed)).toEqual(['glossary.title', 'glossary.save', 'glossary.empty']);
            for (const value of Object.values(parsed)) {
                expect(typeof value).toBe('string');
                expect(value.trim().length).toBeGreaterThan(0);
            }
        }

        const zh = JSON.parse(readFileSync(join(baseDir, 'smart-glossary', 'zh-CN.json'), 'utf8')) as Record<string, string>;
        expect(zh['glossary.title']).toBe('智能术语表');

        const wrapperPath = join(baseDir, 'smartGlossary.ts');
        expect(existsSync(wrapperPath)).toBe(true);
        const wrapperSource = readFileSync(wrapperPath, 'utf8');
        assertCompliantSourceHeader(wrapperSource, 'src/core/i18n/messages/smartGlossary.ts');
        expect(wrapperSource).toContain("import type {UiLanguage} from '../types';");
        expect(wrapperSource).toContain('export const smartGlossaryChineseMessages = chinese;');
        expect(wrapperSource).toContain('export const smartGlossaryMessages: Readonly<Record<UiLanguage, Readonly<Record<string, string>>>> =');
        for (const locale of SUPPORTED_LOCALES) {
            expect(wrapperSource).toContain(`./smart-glossary/${locale}.json`);
        }
    });

    it('不同功能生成的包装模块具有不重复的职责和主要内容说明', () => {
        const tempRoot = createTempDir('fluentread-i18n-unique-');
        const baseDir = join(tempRoot, 'src', 'core', 'i18n', 'messages');
        const planA = buildFeatureMessagePlan({featureName: 'feature-alpha', title: '功能甲', dir: baseDir, root: tempRoot});
        const planB = buildFeatureMessagePlan({featureName: 'feature-beta', title: '功能乙', dir: baseDir, root: tempRoot});
        const sourceA = planA.files.find(file => file.kind === 'wrapper-ts')!.content;
        const sourceB = planB.files.find(file => file.kind === 'wrapper-ts')!.content;

        const extract = (src: string, label: string) => src.split('\n').find(line => line.includes(label))?.trim();
        expect(extract(sourceA, '文件职责：')).not.toBe(extract(sourceB, '文件职责：'));
        expect(extract(sourceA, '主要内容：')).not.toBe(extract(sourceB, '主要内容：'));
    });

    it('支持 --dry-run 预览且不触碰磁盘，默认拒绝覆盖已有文件并支持 --force', () => {
        const tempRoot = createTempDir('fluentread-i18n-guard-');
        const baseDir = join(tempRoot, 'messages');

        const preview = scaffoldFeatureMessages({
            featureName: 'quick-notes',
            title: '快捷笔记',
            dir: baseDir,
            root: tempRoot,
            dryRun: true,
        });
        expect(preview.dryRun).toBe(true);
        expect(preview.written).toEqual([]);
        expect(preview.files).toHaveLength(8);
        expect(existsSync(join(baseDir, 'quickNotes.ts'))).toBe(false);
        expect(existsSync(join(baseDir, 'quick-notes'))).toBe(false);

        // 首次写入成功
        scaffoldFeatureMessages({
            featureName: 'quick-notes',
            title: '快捷笔记',
            dir: baseDir,
            root: tempRoot,
        });
        const sentinel = '// custom edit\n';
        writeFileSync(join(baseDir, 'quickNotes.ts'), sentinel, 'utf8');

        // 未传 force 时拒绝覆盖并保留原内容
        expect(() => scaffoldFeatureMessages({
            featureName: 'quick-notes',
            title: '快捷笔记新版',
            dir: baseDir,
            root: tempRoot,
        })).toThrow(/已存在/u);
        expect(readFileSync(join(baseDir, 'quickNotes.ts'), 'utf8')).toBe(sentinel);

        // 显式传入 force 允许覆盖
        const overwritten = scaffoldFeatureMessages({
            featureName: 'quick-notes',
            title: '快捷笔记新版',
            dir: baseDir,
            root: tempRoot,
            force: true,
        });
        expect(overwritten.written).toHaveLength(8);
        expect(readFileSync(join(baseDir, 'quickNotes.ts'), 'utf8')).toContain('快捷笔记新版');
    });

    it('CLI 解析参数并可通过 node 命令行正常执行', () => {
        expect(parseArguments(['--help']).help).toBe(true);
        expect(() => parseArguments([])).toThrow(/缺少必需参数/u);
        expect(() => parseArguments(['smart-glossary', '--unknown'])).toThrow(/未知参数/u);

        const tempRoot = createTempDir('fluentread-i18n-cli-');
        const output = execFileSync(process.execPath, [
            SCRIPT_PATH,
            'reading-bookmarks',
            '--title', '阅读书签',
            '--keys', 'bookmarks.title,bookmarks.add',
            '--dir', tempRoot,
        ], {encoding: 'utf8'});

        expect(output).toContain('readingBookmarks');
        expect(existsSync(join(tempRoot, 'readingBookmarks.ts'))).toBe(true);
        expect(existsSync(join(tempRoot, 'reading-bookmarks', 'zh-CN.json'))).toBe(true);
        const wrapper = readFileSync(join(tempRoot, 'readingBookmarks.ts'), 'utf8');
        assertCompliantSourceHeader(wrapper, 'src/core/i18n/messages/readingBookmarks.ts');
    });
});
