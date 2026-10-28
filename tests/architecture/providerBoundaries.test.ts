import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {dirname, relative, resolve, sep} from 'node:path';
import ts from 'typescript';
import {describe, expect, it} from 'vitest';

const PROJECT_ROOT = resolve(__dirname, '../..');
const PROVIDER_ROOT = resolve(PROJECT_ROOT, 'src/providers/translation');

const EXPECTED_PROVIDER_FILES = [
    'registry.ts',
    'chatgpt-plan.ts',
    'ai-sdk/boundedErrorResponse.ts',
    'ai-sdk/endpoints.ts',
    'ai-sdk/errors.ts',
    'ai-sdk/openai-compatible.ts',
    'ai-sdk/openai-http.ts',
    'ai-sdk/openai-transport.ts',
    'ai-sdk/transport-errors.ts',
    'aliyun-translation.ts',
    'auth.ts',
    'azure-openai.ts',
    'azure-translator.ts',
    'baidu-translation.ts',
    'cloud/languages.ts',
    'cloud/signature.ts',
    'google-cloud-translation.ts',
    'volc-translation.ts',
    'mymemory.ts',
    'chrome-translator.ts',
    'chromeTranslatorRequest.ts',
    'claude.ts',
    'connectionTest.ts',
    'deepl.ts',
    'deeplx.ts',
    'deepseek.ts',
    'doubao.ts',
    'doubao-seed-translation.ts',
    'doubao-web.ts',
    'documentFreeBatch.ts',
    'free-translation.ts',
    'free-web.ts',
    'free-chinese-web.ts',
    'free-extra-web.ts',
    'free-official-web.ts',
    'freeTextChunks.ts',
    'bilibili-free.ts',
    'gemini.ts',
    'google.ts',
    'googleErrorBody.ts',
    'googleRequestGate.ts',
    'hunyuan-translation.ts',
    'local-translation.ts',
    'microsoft.ts',
    'microsoftTransport.ts',
    'native-batch.ts',
    'responses-api.ts',
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
    return sourceImportSpecifiers(path, source);
}

function sourceImportSpecifiers(path: string, source: string): string[] {
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
        if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
            && ts.isStringLiteral(node.argument.literal)) specifiers.push(node.argument.literal.text);
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

function runtimeFetchCalls(path: string, transportName = 'runtimeFetch'): ts.CallExpression[] {
    const source = readProjectFile(`src/providers/translation/${path}`);
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
            && node.expression.text === transportName) {
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

    it('provider 及其提示词、语言和端点依赖都不能隐式读取全局配置 store', () => {
        const pending = EXPECTED_PROVIDER_FILES.map(path => `src/providers/translation/${path}`);
        const visited = new Set<string>();
        const violations: string[] = [];
        while (pending.length) {
            const path = pending.pop()!;
            if (visited.has(path)) continue;
            visited.add(path);
            for (const specifier of sourceImportSpecifiers(path, readProjectFile(path))) {
                const unresolved = specifier.startsWith('@/') ? resolve(PROJECT_ROOT, specifier.slice(2))
                    : specifier.startsWith('.') ? resolve(PROJECT_ROOT, dirname(path), specifier) : null;
                if (!unresolved) continue;
                const target = [unresolved, `${unresolved}.ts`, `${unresolved}.vue`, resolve(unresolved, 'index.ts')]
                    .find(candidate => existsSync(candidate) && statSync(candidate).isFile());
                if (!target) continue;
                const relativeTarget = relative(PROJECT_ROOT, target).split(sep).join('/');
                if (relativeTarget === 'src/services/config/store.ts') {
                    violations.push(`${path} -> ${specifier}`);
                } else if (relativeTarget.startsWith('src/') && /\.(?:ts|vue)$/u.test(relativeTarget)) {
                    pending.push(relativeTarget);
                }
            }
        }
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
            'doubao-seed-translation.ts',
            'gemini.ts',
            'google.ts',
            'hunyuan-translation.ts',
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
        const microsoftAdapter = readProjectFile('src/providers/translation/microsoft.ts');
        expect(microsoftAdapter).toContain('translateMicrosoftTextsWithTransport(runtimeFetch, texts, fromLang, toLang, abortSignal, enableNativeBatch, lease)');
        const microsoftTransportCalls = runtimeFetchCalls('microsoftTransport.ts', 'transport');
        expect(microsoftTransportCalls).toHaveLength(1);
        expect(microsoftTransportCalls.every((call) => objectLiteralHasSignal(call.arguments[1]))).toBe(true);
    });

    it('共享 OpenAI transport 通过 runtimeFetch，两个执行器都不绕过其网络端口', () => {
        const source = readProjectFile('src/providers/translation/ai-sdk/openai-transport.ts');
        const calls = runtimeFetchCalls('ai-sdk/openai-transport.ts');
        expect(calls).toHaveLength(1);
        expect(calls[0].arguments).toHaveLength(3);
        const [target, init, policy] = calls[0].arguments;
        expect(target.getText()).toBe('endpoint.exactEndpoint || input');
        expect(init.getText()).toMatch(/^\{\s*\.\.\.init,\s*signal:\s*transport\.signal\s*\}$/u);
        // The limit is a separate local transport argument, not an HTTP header.
        // The GM boundary test additionally checks the actual transmitted headers.
        expect(policy.getText()).toMatch(/^\{\s*errorBodyLimit:\s*OPENAI_ERROR_BODY_LIMIT\s*,?\s*\}$/u);
        expect(source).not.toMatch(/\bawait\s+fetch\(/u);
        const sdk = readProjectFile('src/providers/translation/ai-sdk/openai-compatible.ts');
        const http = readProjectFile('src/providers/translation/ai-sdk/openai-http.ts');
        expect(sdk).toContain('fetch: call.fetch');
        expect(http).toContain('await call.fetch(');
        expect(sdk + http).not.toMatch(/\b(?:await\s+fetch|globalThis\.fetch)\(/u);
    });
});
