import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {dirname, relative, resolve, sep} from 'node:path';
import ts from 'typescript';
import {describe, expect, it} from 'vitest';

const PROJECT_ROOT = resolve(__dirname, '../..');

function projectPath(...parts: string[]): string {
    return resolve(PROJECT_ROOT, ...parts);
}

function listSourceFiles(directory: string): string[] {
    const root = projectPath(directory);
    const files: string[] = [];

    const visit = (current: string) => {
        // 步骤 1：递归读取目录，只收集会参与 TypeScript/Vue 依赖图的源码。
        for (const name of readdirSync(current)) {
            const absolute = resolve(current, name);
            if (statSync(absolute).isDirectory()) {
                visit(absolute);
            } else if (/\.(?:cts|mts|ts|tsx|vue)$/.test(name) && !name.endsWith('.d.ts')) {
                files.push(absolute);
            }
        }
    };

    visit(root);
    return files.sort();
}

function readSource(path: string): string {
    return readFileSync(path, 'utf8');
}

function sourceBody(path: string): string {
    const source = readSource(projectPath(path));
    const header = source.match(/^\/\*\*[\s\S]*?\*\/\s*/u)?.[0];
    return header?.includes(`@file ${path}`) ? source.slice(header.length) : source;
}

function relativePath(path: string): string {
    return relative(PROJECT_ROOT, path).split(sep).join('/');
}

function importSpecifiers(source: string): string[] {
    // Vue 文件只把 script 区域交给 TypeScript；模板文字和样式不能伪装成依赖边。
    const script = source.includes('<script')
        ? [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/giu)].map((match) => match[1]).join('\n')
        : source;
    const sourceFile = ts.createSourceFile('dependency-graph.tsx', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const imports = new Set<string>();

    const addStringLiteral = (node: ts.Node | undefined) => {
        if (node && ts.isStringLiteralLike(node)) imports.add(node.text);
    };
    const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            addStringLiteral(node.moduleSpecifier);
        } else if (ts.isCallExpression(node)
            && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            addStringLiteral(node.arguments[0]);
        } else if (ts.isImportTypeNode(node)
            && ts.isLiteralTypeNode(node.argument)) {
            addStringLiteral(node.argument.literal);
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return [...imports];
}

function resolveProjectImport(fromFile: string, specifier: string): string | null {
    let unresolved: string;
    if (specifier.startsWith('@/')) {
        unresolved = projectPath(specifier.slice(2));
    } else if (specifier.startsWith('.')) {
        unresolved = resolve(dirname(fromFile), specifier);
    } else {
        return null;
    }

    for (const candidate of [
        unresolved,
        `${unresolved}.ts`,
        `${unresolved}.tsx`,
        `${unresolved}.mts`,
        `${unresolved}.cts`,
        `${unresolved}.vue`,
        resolve(unresolved, 'index.ts'),
        resolve(unresolved, 'index.tsx'),
        resolve(unresolved, 'index.mts'),
        resolve(unresolved, 'index.cts'),
        resolve(unresolved, 'index.vue'),
    ]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
}

function lineCount(path: string): number {
    let source = readSource(projectPath(path));
    if (path.startsWith('src/') || path.startsWith('entrypoints/')) {
        const pattern = path.endsWith('.vue')
            ? /^<!--[\s\S]*?-->\s*/u
            : /^\/\*\*[\s\S]*?\*\/\s*/u;
        const header = source.match(pattern)?.[0];
        if (header?.includes('@file ' + path)) source = source.slice(header.length);
    }
    return source.endsWith('\n') ? source.split('\n').length - 1 : source.split('\n').length;
}

const APP_COMPOSITION_ROOT_ENTRYPOINT_IMPORTS = new Map<string, Set<string>>();

const PROVIDER_TRANSITIONAL_ENTRYPOINT_IMPORTS = new Set<string>();

const FEATURE_BROWSER_ENTRYPOINT_IMPORTS = new Map<string, Set<string>>();

const COMPLEXITY_DEBT_CEILINGS: Record<string, number> = {
    'entrypoints/background.ts': 11,
    'entrypoints/content.ts': 11,
    'entrypoints/offscreen/main.ts': 3,
    'entrypoints/shadowBridge.content.ts': 9,
    'entrypoints/youtubeBridge.content.ts': 9,
    'src/app/background/contextMenuRuntime.ts': 142,
    'src/app/background/messageRuntime.ts': 162,
    'src/app/background/runtime.ts': 25,
    'src/app/content/hotkeyRuntime.ts': 208,
    'src/app/content/messageRuntime.ts': 169,
    'src/app/content/runtime.ts': 277,
    'src/features/settings/ui/SettingsSections.vue': 1558,
    'src/features/full-page-translation/content/runtime.ts': 2196,
    'src/features/video-subtitle/content/runtime.ts': 1887,
};

describe('architecture module boundaries', () => {
    it('依赖提取覆盖副作用、导出、动态与类型 import，并忽略注释、字符串和 Vue 模板', () => {
        const source = `
            <template><p>import '@/src/template-decoy'</p></template>
            <script setup lang="ts">
                import '@/src/side-effect';
                export {value} from '@/src/re-export';
                const lazy = import('@/src/lazy');
                type Imported = import('@/src/type-only').Imported;
                const decoy = "import('@/src/string-decoy')";
                // 注释诱饵：import '@/src/comment-decoy';
            </script>
        `;

        expect(importSpecifiers(source)).toEqual([
            '@/src/side-effect',
            '@/src/re-export',
            '@/src/lazy',
            '@/src/type-only',
        ]);
    });

    it('每个 WXT 入口都有语义化中文文件说明，HTML 保持 doctype 在首行', () => {
        const files = [
            'entrypoints/background.ts',
            'entrypoints/content.ts',
            'entrypoints/document/main.ts',
            'entrypoints/offscreen/main.ts',
            'entrypoints/options/main.ts',
            'entrypoints/popup/main.ts',
            'entrypoints/shadowBridge.content.ts',
            'entrypoints/youtubeBridge.content.ts',
            'entrypoints/document/index.html',
            'entrypoints/offscreen/index.html',
            'entrypoints/options/index.html',
            'entrypoints/popup/index.html',
        ];

        for (const path of files) {
            const source = readSource(projectPath(path));
            if (path.endsWith('.html')) expect(source, path).toMatch(/^<!doctype html>\n<!--/iu);
            else expect(source, path).toMatch(/^\/\*\*/u);
            expect(source, path).toContain(`@file ${path}`);
            expect(source, path).toMatch(/文件职责：[^\n]*[\u3400-\u9fff]/u);
            expect(source, path).toMatch(/主要内容：[^\n]*[\u3400-\u9fff]/u);
            expect(source, path).toMatch(/模块边界：[^\n]*[\u3400-\u9fff]/u);
        }
    });

    it('核心 WXT entrypoint 只声明元数据并委托给唯一 app composition root', () => {
        const contracts = [
            {
                path: 'entrypoints/background.ts',
                imports: ['@/src/app/background/runtime'],
                declaration: 'defineBackground({',
                delegate: 'main: startBackgroundApp',
            },
            {
                path: 'entrypoints/content.ts',
                imports: ['@/src/app/content/runtime'],
                declaration: 'defineContentScript({',
                delegate: 'main: startContentApp',
            },
        ];

        for (const contract of contracts) {
            const source = readSource(projectPath(contract.path));
            expect(importSpecifiers(source), contract.path).toEqual(contract.imports);
            expect(source, contract.path).toContain(contract.declaration);
            expect(source, contract.path).toContain(contract.delegate);
            expect(source, contract.path).not.toContain('browser.');
        }
    });

    it('特殊 WXT entrypoint 只保留目标元数据并委托 app composition root', () => {
        const contracts = [
            {
                path: 'entrypoints/offscreen/main.ts',
                imports: ['@/src/app/offscreen/runtime'],
                delegate: 'startOffscreenApp();',
            },
            {
                path: 'entrypoints/shadowBridge.content.ts',
                imports: ['@/src/app/content/shadowBridge'],
                delegate: 'main: startShadowBridgeApp',
                metadata: ["runAt: 'document_start'", "world: 'MAIN'"],
            },
            {
                path: 'entrypoints/youtubeBridge.content.ts',
                imports: ['@/src/app/content/youtubeTimedTextBridge'],
                delegate: 'main: startYoutubeTimedTextBridgeApp',
                metadata: ["runAt: 'document_start'", "world: 'MAIN'"],
            },
        ];

        for (const contract of contracts) {
            const source = readSource(projectPath(contract.path));
            expect(importSpecifiers(source), contract.path).toEqual(contract.imports);
            expect(source, contract.path).toContain(contract.delegate);
            for (const metadata of contract.metadata ?? []) expect(source, contract.path).toContain(metadata);
            expect(source, contract.path).not.toContain('chrome.');
            expect(source, contract.path).not.toContain('window.');
        }
    });

    it('src 的静态依赖图不存在跨文件循环', () => {
        const files = listSourceFiles('src');
        const sourceSet = new Set(files);
        const graph = new Map(files.map((file) => [
            file,
            importSpecifiers(readSource(file))
                .map((specifier) => resolveProjectImport(file, specifier))
                .filter((target): target is string => Boolean(target) && sourceSet.has(target as string)),
        ]));
        const visiting = new Set<string>();
        const visited = new Set<string>();
        const stack: string[] = [];
        const cycles: string[] = [];

        const visit = (file: string) => {
            if (visited.has(file)) return;
            if (visiting.has(file)) {
                const start = stack.indexOf(file);
                cycles.push([...stack.slice(start), file].map(relativePath).join(' -> '));
                return;
            }

            visiting.add(file);
            stack.push(file);
            for (const dependency of graph.get(file) ?? []) visit(dependency);
            stack.pop();
            visiting.delete(file);
            visited.add(file);
        };

        for (const file of files) visit(file);
        expect(cycles).toEqual([]);
    });

    it('src 只能通过精确登记的 composition/browser/provider 迁移边界读取 entrypoints', () => {
        const violations: string[] = [];
        const appRuntimeImports: string[] = [];
        const providerEntrypointImports: string[] = [];
        const featureBrowserEntrypointEdges: string[] = [];

        for (const file of listSourceFiles('src')) {
            const path = relativePath(file);
            for (const specifier of importSpecifiers(readSource(file))) {
                if (!specifier.startsWith('@/entrypoints/')) continue;

                // 步骤 1：app composition root 负责把 WXT/provider/config 依赖静态注入纯 service。
                if (APP_COMPOSITION_ROOT_ENTRYPOINT_IMPORTS.get(path)?.has(specifier)) {
                    appRuntimeImports.push(`${path} -> ${specifier}`);
                    continue;
                }
                // 步骤 2：provider 已迁入目标目录；配置/模板等尚在迁移的依赖只开放精确集合。
                if (path.startsWith('src/providers/translation/')
                    && PROVIDER_TRANSITIONAL_ENTRYPOINT_IMPORTS.has(specifier)) {
                    providerEntrypointImports.push(specifier);
                    continue;
                }
                // 步骤 3：内容脚本 runtime/UI 仍承载浏览器 DOM/WXT glue；迁移期只允许逐文件精确列明的旧依赖。
                if (FEATURE_BROWSER_ENTRYPOINT_IMPORTS.get(path)?.has(specifier)) {
                    featureBrowserEntrypointEdges.push(`${path} -> ${specifier}`);
                    continue;
                }
                violations.push(`${path} -> ${specifier}`);
            }
        }

        // 步骤 4：已登记集合必须与实际依赖精确匹配，防止残留白名单静默扩大。
        expect(violations).toEqual([]);
        expect(new Set(appRuntimeImports)).toEqual(new Set(
            [...APP_COMPOSITION_ROOT_ENTRYPOINT_IMPORTS].flatMap(([path, imports]) =>
                [...imports].map((specifier) => `${path} -> ${specifier}`)),
        ));
        expect(new Set(providerEntrypointImports)).toEqual(PROVIDER_TRANSITIONAL_ENTRYPOINT_IMPORTS);
        expect(new Set(featureBrowserEntrypointEdges)).toEqual(new Set(
            [...FEATURE_BROWSER_ENTRYPOINT_IMPORTS].flatMap(([path, imports]) =>
                [...imports].map((specifier) => `${path} -> ${specifier}`)),
        ));
    });

    it('feature 的运行时和类型契约都不反向依赖 app 组装层', () => {
        const violations: string[] = [];
        for (const file of listSourceFiles('src/features')) {
            for (const specifier of importSpecifiers(readSource(file))) {
                const target = resolveProjectImport(file, specifier);
                if (target && relativePath(target).startsWith('src/app/')) {
                    violations.push(`${relativePath(file)} -> ${specifier}`);
                }
            }
        }
        expect(violations).toEqual([]);
    });

    it('core 与 shared 保持低层，不依赖 app、feature、service、provider、platform 或 UI', () => {
        const forbidden = /^@\/src\/(?:app|features|services|providers|platform|ui)(?:\/|$)/;
        const violations: string[] = [];

        for (const directory of ['src/core', 'src/shared']) {
            const absolute = projectPath(directory);
            try {
                for (const file of listSourceFiles(directory)) {
                    for (const specifier of importSpecifiers(readSource(file))) {
                        if (specifier.startsWith('@/entrypoints/') || forbidden.test(specifier)) {
                            violations.push(`${relativePath(file)} -> ${specifier}`);
                        }
                    }
                }
            } catch {
                // 迁移早期目录可以尚未创建；一旦出现源码就自动纳入约束。
                expect(absolute).toBeTruthy();
            }
        }

        expect(violations).toEqual([]);
    });

    it('feature 不能跨目录读取另一个 feature 的内部实现', () => {
        const violations: string[] = [];

        for (const file of listSourceFiles('src/features')) {
            const path = relativePath(file);
            const owner = path.split('/')[2];
            if (!owner) continue;

            for (const specifier of importSpecifiers(readSource(file))) {
                const target = resolveProjectImport(file, specifier);
                const targetPath = target ? relativePath(target) : '';
                const match = targetPath.match(/^src\/features\/([^/]+)\//);
                const usesPublicContract = /\/(?:public|protocol)\.ts$/u.test(targetPath);
                if (match && match[1] !== owner && !usesPublicContract) violations.push(`${path} -> ${specifier}`);
            }
        }

        expect(violations).toEqual([]);
    });

    it('文档 WXT 页面只通过 app public API 进入垂直功能切片', () => {
        expect(sourceBody('entrypoints/document/main.ts')).toBe(
            "import {mountDocumentTranslationApp} from '@/src/app/document-translation/page';\n\nmountDocumentTranslationApp('#app');\n",
        );
        const documentUiImports = importSpecifiers(readSource(projectPath('src/app/document-translation/DocumentApp.vue')))
            .filter((specifier) => specifier.startsWith('@/src/'));
        const featureEntrypointImports = listSourceFiles('src/features/document-translation')
            .flatMap((file) => importSpecifiers(readSource(file)))
            .filter((specifier) => specifier.startsWith('@/entrypoints/'));

        expect(documentUiImports).toEqual(['@/src/app/document-translation']);
        expect(featureEntrypointImports).toEqual([]);
    });

    it('WXT entrypoint 只能进入 app composition root，兼容 utils 目录不得复活', () => {
        const violations: string[] = [];

        for (const file of listSourceFiles('entrypoints')) {
            const path = relativePath(file);
            for (const specifier of importSpecifiers(readSource(file))) {
                if (!specifier.startsWith('@/src/')) continue;
                if (specifier.startsWith('@/src/app/')) continue;
                violations.push(`${path} -> ${specifier}`);
            }
        }

        expect(violations).toEqual([]);
        expect(existsSync(projectPath('entrypoints/utils'))).toBe(false);
    });

    it('业务模块不能继续迁入 WXT entrypoints/core 或 entrypoints/features', () => {
        const misplaced = listSourceFiles('entrypoints').filter((file) => {
            const path = relativePath(file);
            return path.startsWith('entrypoints/core/') || path.startsWith('entrypoints/features/');
        });

        expect(misplaced.map(relativePath)).toEqual([]);
    });

    it('按需加载的大体积资源不得被扩展运行时代码静态引入', () => {
        // 六种非中文界面文案只能经构建期 JSON 按需加载。
        const allowed = new Map<string, RegExp>([
            ['src/core/i18n/bundles.ts', /^\.\/messages\/(?:en-US|es-ES|fr-FR|ja-JP|ko-KR|ru-RU)$/u],
        ]);
        const onDemand = /^(?:@\/src\/core\/i18n\/bundles|\.\/bundles|(?:@\/src\/core\/i18n\/|\.\/|\.\.\/)messages\/(?:en-US|es-ES|fr-FR|ja-JP|ko-KR|ru-RU))$/u;
        const violations: string[] = [];
        for (const file of listSourceFiles('src')) {
            const path = relativePath(file);
            const source = readSource(file);
            const script = source.includes('<script')
                ? [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/giu)].map((match) => match[1]).join('\n')
                : source;
            const sourceFile = ts.createSourceFile(path, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
            for (const statement of sourceFile.statements) {
                if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
                const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
                if (!onDemand.test(specifier)) continue;
                if (!allowed.get(path)?.test(specifier)) violations.push(`${path} -> ${specifier}`);
            }
        }
        expect(violations).toEqual([]);
    });

    it('服务配置与固定自检不拉入正文检测依赖', () => {
        for (const owner of [
            'src/features/settings/ui/services/ServiceConfiguration.vue',
            'src/features/settings/model/chromeTranslationPreparation.ts',
        ]) {
            const visited = new Set<string>();
            const pending = [projectPath(owner)];
            while (pending.length) {
                const file = pending.pop()!;
                if (visited.has(file)) continue;
                visited.add(file);
                for (const specifier of importSpecifiers(readSource(file))) {
                    const dependency = resolveProjectImport(file, specifier);
                    if (dependency) pending.push(dependency);
                }
            }
            const bodyDetection = [...visited].map(relativePath).filter(path =>
                /^src\/core\/language\/(?:detect|identify|chineseText|chineseVariants|statistical|lexicon|functionWordData|scripts|technicalTokens)\.ts$/u.test(path));
            expect(bodyDetection, owner).toEqual([]);
        }
    });

    it('历史巨型文件不得继续增长，后续迁移只降低债务上限', () => {
        const growth = Object.entries(COMPLEXITY_DEBT_CEILINGS)
            .map(([path, ceiling]) => ({path, lines: lineCount(path), ceiling}))
            .filter(({lines, ceiling}) => lines > ceiling);

        expect(growth).toEqual([]);
    });
});
