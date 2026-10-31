import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {inflateWithPako} from '@/userscript/pakoBundled';
import {decodeUserscriptData} from '@/userscript/dataEncoding';
import {gzipUserscriptBuildData} from '@/userscript/buildGzip';
import ts from 'typescript';
import {describe, expect, it, vi} from 'vitest';
import {createUserscriptSettingsDataPlugin} from '@/userscript/settingsDataPlugin';

const root = process.cwd();
const tables = [
    ['src/core/harness/promptLocales.ts', 'HARNESS_TRANSLATED_PROMPTS'],
    ['src/core/config/catalog.ts', 'localizedTargetLanguageLabels'],
    ['src/core/config/translationAppearance.ts', 'TRANSLATION_STYLE_PRESETS'],
    ['src/core/config/catalog.ts', 'multilingualTargetLanguageLabels'],
    ['src/core/config/catalog.ts', 'englishTargetLanguageLabels'],
    ['src/core/config/interfaceAppearance.ts', 'interfaceSkinOptions'],
    ['src/core/config/interfaceAppearance.ts', 'interfaceFontOptions'],
    ['src/core/config/interfaceAppearance.ts', 'popupModuleOptions'],
    ['src/core/config/interfaceAppearance.ts', 'popupQuickFeatureOptions'],
    ['src/features/full-page-translation/ui/translationIndicators.ts', 'iconPaths'],
    ['src/providers/translation/aliyun-translation.ts', 'aliyunErrorHints'],
    ['src/core/i18n/language.ts', 'localizedUiLanguageLabels'],
    ['src/features/reading-assistant/sentenceAnalysis.ts', 'ROLES'],
    ['src/core/harness/promptDefaults.ts', 'GRAMMAR_CARD_FORMAT'],
    ['src/services/diagnostics/index.ts', 'diagnosticUiKeys'],
    ['src/core/language/codes.ts', 'LANGUAGE_ALIASES'],
    ['src/core/language/codes.ts', 'DEFAULT_SCRIPTS'],
    ['src/features/image-translation/ocrLanguages.ts', 'IMAGE_OCR_LANGUAGE_PACKS'],
    ['src/core/config/selectionPreview.ts', 'learningPreviewAnswers'],
    ['src/ui/translationLoadingIndicator.ts', 'HOST_IMPORTANT_STYLES'],
] as const;

function transform(code: string, id = resolve(root, tables[0][0]), enabled = true, fullOptions = true) {
    const plugin = createUserscriptSettingsDataPlugin(root, enabled, fullOptions);
    const run = plugin.transform as (code: string, id: string) => {code: string} | null;
    return run(code, id);
}

function initializer(code: string, name: string): string {
    const source = ts.createSourceFile('fixture.ts', code, ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        const declaration = statement.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === name);
        if (declaration?.initializer) return declaration.initializer.getText(source);
    }
    throw new Error(`Missing fixture initializer ${name}`);
}

function value(expression: string): unknown {
    const javascript = ts.transpileModule(`globalThis.result = ${expression};`, {compilerOptions: {target: ts.ScriptTarget.ES2018}}).outputText;
    const context = {result: undefined as unknown, Uint8Array, atob,
        __fluentreadInflateSettingsData: inflateWithPako, __fluentreadDecodeSettingsData: decodeUserscriptData};
    runInNewContext(javascript, context, {timeout: 1000});
    return context.result;
}

describe('standalone static settings data representation', () => {
    it.each(tables)('round-trips the actual %s table with exact keys, order, strings and JSON types', (path, name) => {
        const source = readFileSync(resolve(root, path), 'utf8');
        const transformed = transform(source, resolve(root, path))!.code;
        const before = value(initializer(source, name));
        const after = value(initializer(transformed, name));
        expect(JSON.stringify(after)).toBe(JSON.stringify(before));
        const encoded = JSON.parse(initializer(transformed, name).match(/__fluentreadDecodeSettingsData\(("[^"]+")\)/u)![1]) as string;
        expect(encoded.startsWith('~91:')).toBe(true);
        expect(Buffer.from(decodeUserscriptData(encoded))).toEqual(gzipUserscriptBuildData(Buffer.from(JSON.stringify(before)), undefined, true));
        expect(initializer(transformed, name)).not.toContain('eval');
        // Every other byte of the owning source stays in place; functions and declarations remain executable code.
        let restored = transformed;
        for (const [owner, table] of tables) {
            if (owner === path) restored = restored.replace(`/* @__PURE__ */ ${initializer(transformed, table)}`, initializer(source, table));
        }
        expect(restored.replace(/import \{inflateWithPako as __fluentreadInflateSettingsData\} from '@\/userscript\/pakoRuntime';\n/u, '')
            .replace(/import \{decodeUserscriptData as __fluentreadDecodeSettingsData\} from '@\/userscript\/dataEncoding';\n/u, '')).toBe(source);
    });

    it.each([
        ['ordinary', '0', '0', false],
        ['standalone', '1', '0', true],
        ['greasy-fork', '0', '1', false],
        ['standalone-and-greasy', '1', '1', false],
    ] as const)('preserves full language labels through the actual %s Vite configuration', async (_label, standalone, greasy, enabled) => {
        vi.stubEnv('FLUENTREAD_USERSCRIPT_STANDALONE', standalone);
        vi.stubEnv('FLUENTREAD_USERSCRIPT_GREASYFORK_SOURCE', greasy);
        vi.stubEnv('FLUENTREAD_USERSCRIPT_VENDOR_URL', 'https://fixture.invalid/vendor.js');
        vi.stubEnv('FLUENTREAD_USERSCRIPT_DATA_URL', 'https://fixture.invalid/data.js');
        try {
            vi.resetModules();
            // This case checks real settings-plugin registration and complete label data.
            // Unrelated large UI-message worker compression has its own real-worker suite.
            // Keep its lossless baseline here; the settings AST/codec remain the real ones.
            vi.doMock('@/userscript/buildGzip', async original => {
                const actual = await original<typeof import('@/userscript/buildGzip')>();
                return {...actual, gzipLargeStandaloneUserscriptData: async (data: Uint8Array) => actual.gzipUserscriptBuildData(data)};
            });
            const {default: configuration} = await import('@/userscript/vite.config');
            const config = configuration as {plugins: Array<{name?: string; transform?: unknown}>};
            const plugin = config.plugins.find(item => item.name === 'standalone-settings-data')!;
            const run = plugin.transform as (code: string, id: string) => {code: string} | null;
            const path = resolve(root, 'src/core/config/catalog.ts');
            const original = readFileSync(path, 'utf8');
            const result = run(original, path);
            if (!enabled) expect(result).toBeNull();
            else for (const name of ['multilingualTargetLanguageLabels', 'englishTargetLanguageLabels']) {
                expect(JSON.stringify(value(initializer(result!.code, name)))).toBe(JSON.stringify(value(initializer(original, name))));
            }
        } finally {
            vi.doUnmock('@/userscript/buildGzip');
            vi.unstubAllEnvs();
            vi.resetModules();
        }
    });

    it('keeps the standard build style table in Base85 with identical gzip bytes and values', () => {
        const [path, name] = tables[2];
        const source = readFileSync(resolve(root, path), 'utf8');
        const transformed = transform(source, resolve(root, path), true, false)!.code;
        const before = value(initializer(source, name));
        const after = value(initializer(transformed, name));
        const encoded = JSON.parse(initializer(transformed, name).match(/__fluentreadDecodeSettingsData\(("[^"]+")\)/u)![1]) as string;
        expect(encoded.startsWith('~85:')).toBe(true);
        expect(Buffer.from(decodeUserscriptData(encoded))).toEqual(gzipUserscriptBuildData(Buffer.from(JSON.stringify(before))));
        expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    });

    it('keeps all six translated prompt catalogs and their actual placeholders after synchronous decode', () => {
        const path = resolve(root, tables[0][0]);
        const generated = transform(readFileSync(path, 'utf8'), path)!.code;
        const decoded = value(initializer(generated, tables[0][1])) as Record<string, Record<string, string>>;
        expect(Object.keys(decoded)).toEqual(['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES']);
        for (const prompts of Object.values(decoded)) {
            expect(Object.keys(prompts)).toEqual(['system', 'meaning', 'grammar', 'usage', 'practice']);
            expect(prompts.system).toContain('{{to}}');
        }
    });

    it('preserves plain nested objects, arrays, values and typed literal wrappers', () => {
        const source = 'export const HARNESS_TRANSLATED_PROMPTS = ({"constructor": "ordinary", 1e2: "numeric key", unquoted: [`line\\ntext`, 1, true, false, null], nested: {key: "🚚"}} as const) satisfies Record<string, unknown>;';
        const decoded = value(initializer(transform(source)!.code, tables[0][1]));
        expect(JSON.stringify(decoded)).toBe(JSON.stringify(value(initializer(source, tables[0][1]))));
    });

    it('does not touch standard builds, unrelated files or same-named tables outside the owner', () => {
        const source = 'const HARNESS_TRANSLATED_PROMPTS = sideEffect();';
        expect(transform(source, resolve(root, tables[0][0]), false)).toBeNull();
        expect(transform(source, resolve(root, 'unrelated.ts'))).toBeNull();
        expect(transform(source, resolve(root, `other/${tables[0][0]}`))).toBeNull();
    });

    it('leaves partially used catalogs visible to standard tree shaking while compressing its complete style table', () => {
        const plugin = createUserscriptSettingsDataPlugin(root, true, false);
        const run = plugin.transform as (code: string, id: string) => {code: string} | null;
        for (const [path, name] of tables.slice(0, 2)) expect(run(`const ${name} = {};`, resolve(root, path))).toBeNull();
        expect(run('const TRANSLATION_STYLE_PRESETS = [];', resolve(root, tables[2][0]))?.code).toContain('JSON.parse');
    });

    it('recognizes an owner query while leaving surrounding expressions and other declarations unchanged', () => {
        const source = 'function unrelated(){ return 1; } const irrelevant = 3, HARNESS_TRANSLATED_PROMPTS = {key: "value"};';
        const transformed = transform(source, `${resolve(root, tables[0][0])}?fixture`)!.code;
        expect(transformed).toContain('function unrelated(){ return 1; } const irrelevant = 3, HARNESS_TRANSLATED_PROMPTS = /* @__PURE__ */');
    });

    it.each([
        '', 'const other = {};', 'let HARNESS_TRANSLATED_PROMPTS = {};',
        'const HARNESS_TRANSLATED_PROMPTS = {}, HARNESS_TRANSLATED_PROMPTS = {};',
        'const HARNESS_TRANSLATED_PROMPTS: unknown;',
        'const HARNESS_TRANSLATED_PROMPTS = {}; const __fluentreadInflateSettingsData = 1;',
        'const HARNESS_TRANSLATED_PROMPTS = {}; const __fluentreadDecodeSettingsData = 1;',
    ])('fails closed when the owned declaration changes: %s', source => {
        expect(() => transform(source)).toThrow('declaration changed');
    });

    it.each([
        'functionCall()', '[...values]', '[,]', '{...value}', '{["computed"]: 1}', '{shorthand}',
        '{method(){}}', '{get value(){return 1;}}', '{key: 1, key: 2}', '{__proto__: null}',
        '{value: 1e999}', '{value: -0}', '{value: undefined}', '{value: `interpolate ${x}`}',
    ])('rejects executable or lossy data expressions: %s', expression => {
        expect(() => transform(`const HARNESS_TRANSLATED_PROMPTS = ${expression};`)).toThrow('Standalone settings data');
    });

    it.each(['[1 2]', '{a:1 b:2}'])('does not silently repair malformed data syntax: %s', expression => {
        expect(() => transform(`const HARNESS_TRANSLATED_PROMPTS = ${expression};`)).toThrow('syntax errors');
    });
});
