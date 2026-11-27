/**
 * @file tests/syncRegistries.test.ts
 * 文件职责：验证测试矩阵与严格覆盖率清单同步器 sync-registries 的漂移检测、白名单动态读取与无损写回行为。
 * 主要内容：覆盖缺失测试自动分类（architecture vs unit/functional/regression）、删除测试陈旧条目清理、可执行源码与纯类型/纯 barrel/声明式 Vue/BUILD_ONLY_SRC_ALLOWLIST/vue-verification-owners 的准确区分，以及 --write 保留原文件格式与注释的幂等性。
 * 模块边界：所有读写仅发生在系统临时目录中，绝不修改真实仓库的矩阵或覆盖率配置。
 */
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
    analyzeRegistries,
    classifySourceModule,
    parseArguments,
    readBuildOnlyAllowlist,
    syncRegistries,
} from '../scripts/testing/sync-registries.mjs';

describe('sync-registries classification and allowlist extraction', () => {
    it('parses CLI flags and validates group values', () => {
        expect(parseArguments([])).toMatchObject({write: false, group: 'unit', json: false, help: false});
        expect(parseArguments(['--write', '--group', 'functional', '--json'])).toMatchObject({
            write: true,
            group: 'functional',
            json: true,
        });
        expect(() => parseArguments(['--group', 'architecture'])).toThrow('--group 必须是');
        expect(() => parseArguments(['--unknown'])).toThrow('未知参数');
    });

    it('reads BUILD_ONLY_SRC_ALLOWLIST directly from verificationOwnership.test.ts', () => {
        const realSource = readFileSync(path.resolve('tests/architecture/verificationOwnership.test.ts'), 'utf8');
        const allowlist = readBuildOnlyAllowlist(realSource);
        expect(allowlist.size).toBeGreaterThan(20);
        expect(allowlist.has('src/app/background/runtime.ts')).toBe(true);
        expect(allowlist.has('src/core/i18n/index.ts')).toBe(true);
    });

    it('distinguishes executable TS, type-only modules, pure barrels, declarative Vue, and interactive Vue', () => {
        expect(classifySourceModule('src/core/types.ts', 'export interface Foo { a: number }\nexport type Bar = string;'))
            .toEqual({typeOnly: true, pureBarrel: false, declarativeVue: false});
        expect(classifySourceModule('src/core/index.ts', "export {a} from './a';\nexport * from './b';"))
            .toEqual({typeOnly: false, pureBarrel: true, declarativeVue: false});
        expect(classifySourceModule('src/core/exec.ts', 'export const answer = () => 42;'))
            .toEqual({typeOnly: false, pureBarrel: false, declarativeVue: false});
        expect(classifySourceModule('src/ui/Stat.vue', '<script setup lang="ts">defineProps<{label: string}>()</script><template><span>{{ label }}</span></template>'))
            .toEqual({typeOnly: false, pureBarrel: false, declarativeVue: true});
        expect(classifySourceModule('src/ui/Counter.vue', '<script setup lang="ts">import {ref} from "vue"; const n = ref(0);</script><template><button @click="n++">{{ n }}</button></template>'))
            .toEqual({typeOnly: false, pureBarrel: false, declarativeVue: false});
    });
});

describe('sync-registries end-to-end check and write in isolated temp repo', () => {
    const tempDirs: string[] = [];
    const createRepo = (files: Record<string, string>) => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'fluentread-sync-reg-'));
        tempDirs.push(dir);
        for (const [rel, content] of Object.entries(files)) {
            const abs = path.join(dir, rel);
            mkdirSync(path.dirname(abs), {recursive: true});
            writeFileSync(abs, content, 'utf8');
        }
        return dir;
    };

    afterEach(() => {
        for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
    });

    it('detects missing/stale entries across matrix and coverage config and writes cleanly while preserving comments', () => {
        const root = createRepo({
            'tests/architecture/verificationOwnership.test.ts': `const BUILD_ONLY_SRC_ALLOWLIST = new Set([\n  'src/app/runtime.ts',\n]);\n`,
            'tests/architecture/vue-verification-owners.json': JSON.stringify({
                schemaVersion: 1,
                components: {'src/ui/OwnedPanel.vue': {kind: 'behavior', tests: ['tests/owned.test.ts'], scenario: 'ok'}},
            }, null, 2),
            'tests/test-matrix.json': JSON.stringify({
                version: 1,
                groups: {
                    architecture: ['tests/architecture/verificationOwnership.test.ts'],
                    unit: ['tests/existing.test.ts', 'tests/deleted.test.ts'],
                    functional: [],
                    regression: [],
                },
            }, null, 2) + '\n',
            'tests/config/vitest.coverage.config.ts': [
                "import {defineConfig} from 'vitest/config';",
                '// keep header comment',
                'export default defineConfig({',
                '    test: {',
                '        coverage: {',
                '            include: [',
                "                'src/core/existing.ts',",
                "                'src/core/removed.ts',",
                "                'src/core/nowTypeOnly.ts',",
                '            ],',
                '            thresholds: {statements: 100, branches: 100, functions: 100, lines: 100},',
                '        },',
                '    },',
                '});',
                '',
            ].join('\n'),
            'tests/existing.test.ts': 'export {};',
            'tests/newFeature.test.ts': 'export {};',
            'tests/architecture/newArch.test.ts': 'export {};',
            'src/core/existing.ts': 'export const existing = 1;',
            'src/core/newExec.ts': 'export const compute = (x: number) => x + 1;',
            'src/core/nowTypeOnly.ts': 'export interface OnlyType { id: string; }',
            'src/core/barrel.ts': "export {existing} from './existing';",
            'src/app/runtime.ts': 'export const boot = () => {};',
            'src/ui/OwnedPanel.vue': '<script setup>const x = 1;</script><template><button @click="x++">{{ x }}</button></template>',
            'src/ui/PureBadge.vue': '<script setup lang="ts">defineProps<{text: string}>()</script><template><span>{{ text }}</span></template>',
            'src/ui/NewInteractive.vue': '<script setup lang="ts">let count = 0;</script><template><button @click="count++">{{ count }}</button></template>',
        });

        const check = analyzeRegistries(root, {group: 'functional'});
        expect(check.hasDrift).toBe(true);
        expect(check.matrix.missing).toEqual([
            {file: 'tests/architecture/newArch.test.ts', group: 'architecture'},
            {file: 'tests/newFeature.test.ts', group: 'functional'},
        ]);
        expect(check.matrix.stale).toEqual([{file: 'tests/deleted.test.ts', group: 'unit'}]);
        expect(check.coverage.missing).toEqual(['src/core/newExec.ts', 'src/ui/NewInteractive.vue']);
        expect(check.coverage.stale).toEqual(['src/core/nowTypeOnly.ts', 'src/core/removed.ts']);

        const synced = syncRegistries(root, {write: true, group: 'functional'});
        expect(synced.written).toEqual(['tests/test-matrix.json', 'tests/config/vitest.coverage.config.ts']);

        const nextMatrix = JSON.parse(readFileSync(path.join(root, 'tests/test-matrix.json'), 'utf8'));
        expect(nextMatrix.groups.architecture).toContain('tests/architecture/newArch.test.ts');
        expect(nextMatrix.groups.functional).toEqual(['tests/newFeature.test.ts']);
        expect(nextMatrix.groups.unit).toEqual(['tests/existing.test.ts']);

        const nextCoverage = readFileSync(path.join(root, 'tests/config/vitest.coverage.config.ts'), 'utf8');
        expect(nextCoverage).toContain('// keep header comment');
        expect(nextCoverage).toContain("'src/core/existing.ts',");
        expect(nextCoverage).toContain("'src/core/newExec.ts',");
        expect(nextCoverage).toContain("'src/ui/NewInteractive.vue',");
        expect(nextCoverage).not.toContain('src/core/removed.ts');
        expect(nextCoverage).not.toContain('src/core/nowTypeOnly.ts');

        // Re-running check after write must report zero drift.
        const verify = analyzeRegistries(root, {group: 'functional'});
        expect(verify.hasDrift).toBe(false);
    });
});
