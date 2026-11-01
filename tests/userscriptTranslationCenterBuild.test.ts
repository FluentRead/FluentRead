import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {compileScript, parse} from 'vue/compiler-sfc';
import {transformWithEsbuild} from 'vite';
import {describe, expect, it} from 'vitest';
import {createUserscriptTranslationCenterPlugin} from '@/userscript/translationCenterPlugin';

const filename = resolve('src/features/translation-center/ui/TranslationCenter.vue');
const plugin = createUserscriptTranslationCenterPlugin(process.cwd());
const transform = (code: string, id = filename) => (plugin.transform as Function).call({}, code, id) as {code: string; map: null} | null;

describe('userscript translation center build surface', () => {
    it('changes executable surface predicates while preserving text, comments and unrelated expressions', () => {
        const source = `<script>const other = service.surface === 'sidebar'; const call = getProps().surface !== 'sidebar';</script>
<script setup lang="ts">
const props = defineProps<{surface: string}>();
const on = props.surface === 'sidebar', off = props.surface !== "sidebar";
const text = "props.surface === 'sidebar'";
// props.surface !== 'sidebar'
const a = props.other === 'sidebar', b = surface === 'sidebar', c = props.surface === 'settings';
const d = props.surface == 'sidebar', e = props.surface === 3;
</script>
<template><div title="surface === 'sidebar'" v-if="surface !== 'sidebar'">
<!-- surface === 'sidebar' -->
<p v-if="surface === 'sidebar'">native</p><p v-else>settings</p>
<p :class="{wide: surface !== 'sidebar', other: service === 'sidebar'}">{{ surface === 'sidebar' ? 'native' : 'comparison' }}</p>
<p v-if="surface === 'settings' || props.surface === 'sidebar' || surface == 'sidebar'">unrelated predicates</p>
</div></template>`;
        const result = transform(source)!;
        expect(result.map).toBeNull();
        expect(result.code).toContain('const on = false, off = true;');
        expect(result.code).toContain('v-if="true"');expect(result.code).toContain('v-if="false"');
        expect(result.code).toContain(':class="{wide: true, other: service === \'sidebar\'}"');
        expect(result.code).toContain("{{ false ? 'native' : 'comparison' }}");
        for (const preserved of [
            'const text = "props.surface === \'sidebar\'";', "// props.surface !== 'sidebar'", 'title="surface === \'sidebar\'"',
            "<!-- surface === 'sidebar' -->", "props.other === 'sidebar'", "surface === 'settings'", "surface == 'sidebar'",
            "service.surface === 'sidebar'", "getProps().surface !== 'sidebar'", "props.surface === 3",
        ]) expect(result.code).toContain(preserved);
        expect(parse(result.code).errors).toEqual([]);
    });
    it('accepts script-only, setup-only and template-only SFCs without introducing a route', () => {
        expect(transform(`<script>const props = {}; const wide = props.surface !== 'sidebar';</script>`)!.code).toContain('wide = true');
        expect(transform(`<script setup>const props = {}; const native = props.surface === 'sidebar';</script>`)!.code).toContain('native = false');
        expect(transform('<template><p>comparison text</p></template>')!.code).toBe('<template><p>comparison text</p></template>');
    });
    it.each([filename + '?vue&type=template', resolve('src/app/sidepanel/SidepanelApp.vue'), '/unrelated/TranslationCenter.vue'])('does not transform another module or virtual request: %s', id => {
        expect(transform('<template><p v-if="surface === \'sidebar\'" /></template>', id)).toBeNull();
    });
    it('normalizes Windows separators before matching the one allowed source', () => {
        expect(transform('<template><p v-if="surface === \'sidebar\'" /></template>', filename.replaceAll('/', '\\'))!.code).toContain('v-if="false"');
    });
    it('fails the build when the target SFC cannot be parsed', () => {
        expect(() => transform('<template><p>')).toThrow('Userscript translation center SFC is invalid');
    });
    it('keeps the real settings comparison controls and drops native-only controls after Vue compilation', async () => {
        const result = transform(readFileSync(filename, 'utf8'))!;
        const {descriptor, errors} = parse(result.code, {filename});expect(errors).toEqual([]);
        const compiled = compileScript(descriptor, {id: 'userscript-center', inlineTemplate: true});
        const output = await transformWithEsbuild(compiled.content, 'translation-center.ts', {loader: 'ts', minify: true, treeShaking: true});
        for (const required of ['translation-input-meta', 'service-picker-option', 'results-layout-control', 'copy-all-button']) expect(output.code).toContain(required);
        for (const native of ['sidebar-clear-button', 'sidebar-copy-button', 'service-picker-count']) expect(output.code).not.toContain(native);
    });
});
