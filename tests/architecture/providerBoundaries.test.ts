import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {dirname, relative, resolve, sep} from 'node:path';
import ts from 'typescript';
import {describe, expect, it} from 'vitest';

const PROJECT_ROOT = resolve(__dirname, '../..');
const PROVIDER_ROOT = resolve(PROJECT_ROOT, 'src/providers/translation');

const EXPECTED_PROVIDER_FILES = [
    'registry.ts',
    'ai-sdk/endpoints.ts',
    'ai-sdk/errors.ts',
    'ai-sdk/openai-compatible.ts',
    'auth.ts',
    'azure-openai.ts',
    'mymemory.ts',
    'apertium.ts',
    'libretranslate.ts',
    'structuredText.ts',
    'chrome-translator.ts',
    'chromeTranslatorRequest.ts',
    'claude.ts',
    'connectionTest.ts',
    'deepl.ts',
    'deeplx.ts',
    'deepseek.ts',
    'free-translation.ts',
    'gemini.ts',
    'google.ts',
    'hunyuan-translation.ts',
    'microsoft.ts',
    'tencent.ts',
    'tongyi.ts',
    'usage.ts',
    'xiaoniu.ts',
    'youdao.ts',
    'zhipu.ts',
] as const;

function listTypeScriptFiles(directory: string): string[] {
    const files: string[] = [];
    const visit = (current: string) => {
        for (const entry of readdirSync(current)) {
            const absolute = resolve(current, entry);
            if (statSync(absolute).isDirectory()) visit(absolute);
            else if (entry.endsWith('.ts')) files.push(relative(PROVIDER_ROOT, absolute).split(sep).join('/'));
        }
    };
    visit(directory);
    return files.sort();
}

function readProjectFile(path: string): string {
    return readFileSync(resolve(PROJECT_ROOT, path), 'utf8');
}

function importedSpecifiers(path: string): string[] {
    const source = readProjectFile(`src/providers/translation/${path}`);
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const specifiers: string[] = [];
    const visit = (node: ts.Node) => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
            && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            specifiers.push(node.moduleSpecifier.text);
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
            && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
            specifiers.push(node.arguments[0].text);
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return specifiers;
}

function resolveProjectSpecifier(providerPath: string, specifier: string): string | null {
    if (specifier.startsWith('@/')) return specifier.slice(2);
    if (!specifier.startsWith('.')) return null;
    const absolute = resolve(PROVIDER_ROOT, dirname(providerPath), specifier);
    return relative(PROJECT_ROOT, absolute).split(sep).join('/');
}

function runtimeFetchCalls(path: string): ts.CallExpression[] {
    const source = readProjectFile(`src/providers/translation/${path}`);
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
            && node.expression.text === 'runtimeFetch') {
            calls.push(node);
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return calls;
}

function objectLiteralHasSignal(node: ts.Node | undefined): boolean {
    return Boolean(node && ts.isObjectLiteralExpression(node) && node.properties.some((property) => (
        ts.isPropertyAssignment(property)
        && ((ts.isIdentifier(property.name) && property.name.text === 'signal')
            || (ts.isStringLiteral(property.name) && property.name.text === 'signal'))
    )));
}

describe('translation provider architecture', () => {
    it('目标目录保留完整 provider 清单，旧 entrypoints 实现目录已经移除', () => {
        expect(listTypeScriptFiles(PROVIDER_ROOT)).toEqual([...EXPECTED_PROVIDER_FILES].sort());
        expect(existsSync(resolve(PROJECT_ROOT, 'entrypoints/service'))).toBe(false);
    });

    it('provider 内部和生产入口不再引用旧 service 路径', () => {
        const audited = [
            ...EXPECTED_PROVIDER_FILES.map((path) => `src/providers/translation/${path}`),
            'src/app/translation/runtime.ts',
            'src/app/background/providerRuntime.ts',
            'src/app/background/messageRuntime.ts',
            'entrypoints/background.ts',
            'userscript/platform.ts',
        ];
        const violations = audited.filter((path) => readProjectFile(path).includes('@/entrypoints/service/'));

        expect(violations).toEqual([]);
    });

    it('扫描全部 provider 并禁止依赖 app 或任何 feature 内部/类型契约', () => {
        const violations = listTypeScriptFiles(PROVIDER_ROOT).flatMap((path) =>
            importedSpecifiers(path).flatMap((specifier) => {
                const target = resolveProjectSpecifier(path, specifier);
                return target && /^src\/(?:app|features)(?:\/|$)/u.test(target)
                    ? [`${path} -> ${specifier}`]
                    : [];
            }),
        );

        expect(violations).toEqual([]);
    });

    it('WXT background 只通过 app composition root 获取 provider 能力', () => {
        const entrypoint = readProjectFile('entrypoints/background.ts');
        const composition = readProjectFile('src/app/background/messageRuntime.ts');

        expect(entrypoint).toContain("from '@/src/app/background/runtime';");
        expect(entrypoint).not.toContain('@/src/providers/translation/');
        expect(composition).toContain("from './providerRuntime';");
        expect(composition).not.toContain('@/src/providers/translation/');
    });

    it('所有 legacy 网络 provider 都把 broker signal 传入 runtimeFetch', () => {
        const networkProviders = [
            'claude.ts',
            'deepl.ts',
            'deeplx.ts',
            'deepseek.ts',
            'gemini.ts',
            'google.ts',
            'hunyuan-translation.ts',
            'microsoft.ts',
            'tencent.ts',
            'tongyi.ts',
            'xiaoniu.ts',
            'youdao.ts',
            'zhipu.ts',
        ];
        const violations = networkProviders.filter((path) => {
            const calls = runtimeFetchCalls(path);
            return calls.length === 0 || calls.some((call) => !objectLiteralHasSignal(call.arguments[1]));
        });

        expect(violations).toEqual([]);
    });

    it('AI SDK compatibility transport 通过 runtimeFetch，不绕过 userscript 网络端口', () => {
        const source = readProjectFile('src/providers/translation/ai-sdk/openai-compatible.ts');
        expect(source).toContain('runtimeFetch(endpoint.exactEndpoint || input, init)');
        expect(source).not.toMatch(/\bawait\s+fetch\(/u);
    });
});
