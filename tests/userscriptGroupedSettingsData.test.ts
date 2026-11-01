import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {describe, expect, it} from 'vitest';
import {inflateWithPako} from '@/userscript/pakoBundled';
import {decodeUserscriptData} from '@/userscript/dataEncoding';
import {createUserscriptSettingsDataPlugin} from '@/userscript/settingsDataPlugin';

const root = process.cwd();
const owners = [
    ['src/core/config/translationAppearance.ts', 'TRANSLATION_STYLE_PRESETS'],
    ['src/core/config/interfaceAppearance.ts', 'interfaceSkinOptions', 'interfaceFontOptions'],
    ['src/core/harness/promptLocales.ts', 'HARNESS_TRANSLATED_PROMPTS'],
    ['src/core/config/catalog.ts', 'localizedTargetLanguageLabels'],
    ['src/core/glossary/builtins.ts', 'BUILTIN_GLOSSARIES'],
    ['src/core/config/videoSubtitleAppearance.ts', 'VIDEO_SUBTITLE_SKINS'],
    ['src/features/settings/model/chromeTranslationPreparation.ts', 'TEST_SAMPLES'],
    ['src/features/settings/model/navigation.ts', 'settingsPagePanels', 'settingsSearchTargets'],
    ['src/core/config/translationLoadingStyle.ts', 'translationLoadingStyleOptions'],
    ['src/core/config/freeTranslation.ts', 'FREE_TRANSLATION_PROVIDERS'],
    ['src/core/language/catalog.ts', 'translationLanguageOptions'],
    ['src/core/language/partOfSpeech.ts', 'PARTS'],
    ['src/core/config/sentenceHighlight.ts', 'SENTENCE_HIGHLIGHT_STYLES'],
    ['src/core/config/selectionTts.ts', 'SELECTION_TTS_VOICE_OPTIONS'],
] as const;

function initializer(code: string, name: string) {
    const source = ts.createSourceFile('owner.ts', code, ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) if (ts.isVariableStatement(statement)) {
        const declaration = statement.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === name);
        if (declaration?.initializer) return declaration.initializer.getText(source);
    }
    throw new Error(`Missing ${name}`);
}
function evaluate(expression: string): unknown {
    const js = ts.transpileModule(`globalThis.result = ${expression}`, {compilerOptions: {target: ts.ScriptTarget.ES2018}}).outputText;
    const context = {result: undefined as unknown};
    runInNewContext(js, context, {timeout: 1000});
    return context.result;
}

describe('standalone grouped settings data', () => {
    it('round trips every grouped table, initializes lazily, and isolates module instances', async () => {
        const plugin = createUserscriptSettingsDataPlugin(root, true, true, true);
        const resolveId = plugin.resolveId as (id: string) => string | undefined;
        const virtualId = resolveId('virtual:fluentread-standalone-settings-data')!;
        const load = plugin.load as (id: string) => Promise<string>;
        const watchFiles: string[] = [];
        const module = await load.call({addWatchFile: (path: string) => watchFiles.push(path)}, virtualId);
        expect(watchFiles.sort()).toEqual(owners.map(([path]) => resolve(root, path)).sort());
        let inflations = 0;
        const context = {decodeUserscriptData, inflateWithPako: (bytes: Uint8Array) => { inflations++; return inflateWithPako(bytes); },
            getSettingsData: undefined as undefined | ((index: number) => unknown)};
        const executable = module.replace(/^import .*;\n/gmu, '').replace('export function getSettingsData', 'globalThis.getSettingsData = function');
        runInNewContext(executable, context, {timeout: 1000});
        expect(inflations).toBe(0);
        const transform = plugin.transform as (code: string, id: string) => {code: string};
        for (const [path, ...names] of owners) {
            const id = resolve(root, path);
            const source = readFileSync(id, 'utf8');
            const transformed = transform(source, id).code;
            for (const name of names) {
                const expr = initializer(transformed, name);
                const index = Number(expr.match(/__fluentreadGetSettingsData\((\d+)\)/u)?.[1]);
                expect(Number.isInteger(index)).toBe(true);
                const first = context.getSettingsData!(index);
                const second = context.getSettingsData!(index);
                expect(JSON.stringify(first)).toBe(JSON.stringify(evaluate(initializer(source, name))));
                expect(JSON.stringify(second)).toBe(JSON.stringify(first));
                expect(second).not.toBe(first);
            }
        }
        expect(inflations).toBe(1);
        const path = resolve(root, 'src/core/harness/promptLocales.ts');
        const source = readFileSync(path, 'utf8');
        expect(transform(source, `${path}?fixture`).code).not.toContain('__fluentreadGetSettingsData');
        expect(transform(source, `${path}?fixture`).code).toContain('__fluentreadDecodeSettingsData');
        const querySource = source.replace('You are the FluentRead', 'query-specific FluentRead');
        const queryCode = transform(querySource, `${path}?fixture`).code;
        const queryExpression = initializer(queryCode, 'HARNESS_TRANSLATED_PROMPTS');
        const encoded = JSON.parse(queryExpression.match(/__fluentreadDecodeSettingsData\(("[^"]+")\)/u)![1]) as string;
        expect(JSON.stringify(JSON.parse(inflateWithPako(decodeUserscriptData(encoded)))))
            .toBe(JSON.stringify(evaluate(initializer(querySource, 'HARNESS_TRANSLATED_PROMPTS'))));
        expect(() => transform(source.replace('You are the FluentRead', 'changed text'), path)).toThrow('changed during build');
    });

    it('keeps standard and disabled builds outside the shared-data route', () => {
        for (const plugin of [createUserscriptSettingsDataPlugin(root, true, false, true), createUserscriptSettingsDataPlugin(root, false, true, true)]) {
            const resolveId = plugin.resolveId as (id: string) => string | undefined;
            expect(resolveId('virtual:fluentread-standalone-settings-data')).toBeUndefined();
        }
    });

    it('refreshes grouped sources on the next watch build', () => {
        const fixture = mkdtempSync(resolve(tmpdir(), 'fluentread-grouped-settings-'));
        try {
            for (const [path] of owners) {
                const dest = resolve(fixture, path);
                mkdirSync(dirname(dest), {recursive: true});
                writeFileSync(dest, readFileSync(resolve(root, path)));
            }
            const plugin = createUserscriptSettingsDataPlugin(fixture, true, true, true);
            const transform = plugin.transform as (code: string, id: string) => {code: string};
            const path = resolve(fixture, owners[2][0]);
            const changed = readFileSync(path, 'utf8').replace('You are the FluentRead', 'updated FluentRead');
            writeFileSync(path, changed);
            expect(() => transform(changed, path)).toThrow('changed during build');
            (plugin.buildStart as () => void)();
            expect(transform(changed, path).code).toContain('__fluentreadGetSettingsData');
        } finally {
            rmSync(fixture, {recursive: true, force: true});
        }
    });

    it('rejects malformed or changed grouped declarations before creating a payload', () => {
        const fixture = mkdtempSync(resolve(tmpdir(), 'fluentread-grouped-invalid-'));
        try {
            for (const [path] of owners) {
                const dest = resolve(fixture, path);
                mkdirSync(dirname(dest), {recursive: true});
                writeFileSync(dest, readFileSync(resolve(root, path)));
            }
            const path = resolve(fixture, owners[0][0]);
            for (const source of [
                'export const TRANSLATION_STYLE_PRESETS = [1 2];',
                'const different = [];',
                'export const TRANSLATION_STYLE_PRESETS = []; export const TRANSLATION_STYLE_PRESETS = [];',
                'export let TRANSLATION_STYLE_PRESETS = [];',
                'export const TRANSLATION_STYLE_PRESETS;',
            ]) {
                writeFileSync(path, source);
                expect(() => createUserscriptSettingsDataPlugin(fixture, true, true, true)).toThrow('Standalone settings data');
            }
        } finally {
            rmSync(fixture, {recursive: true, force: true});
        }
    });

});
