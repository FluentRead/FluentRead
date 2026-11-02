import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {selectTypecheckNodeOptions} from '../scripts/testing/run-typecheck.mjs';

const gib = 1024 ** 3;
test('type checking gets a bounded default on a machine with sufficient visible memory', () => {
    assert.equal(selectTypecheckNodeOptions(undefined, 32 * gib), '--max-old-space-size=6144');
    assert.equal(selectTypecheckNodeOptions('--enable-source-maps', 16 * gib), '--enable-source-maps --max-old-space-size=6144');
    assert.equal(selectTypecheckNodeOptions('', 32 * gib, 16 * gib), '--max-old-space-size=6144');
});
test('small, constrained or unknown memory retains existing Node defaults', () => {
    for (const [total, constrained] of [[8*gib, 0], [32*gib, 8*gib], [NaN, 0], [32*gib, NaN], [32*gib, -1]]) {
        assert.equal(selectTypecheckNodeOptions(undefined, total, constrained), undefined);
        assert.equal(selectTypecheckNodeOptions('--enable-source-maps', total, constrained), '--enable-source-maps');
    }
});
test('explicit heap choices keep their exact spelling, size and companion options', () => {
    for (const options of ['--max-old-space-size=4096', '--max_old_space_size=8192',
        '--max-old-space-size 2048 --enable-source-maps', '"--max-old-space-size=6144"',
        '--max-old-space-size-percentage=50', '--trace-warnings --max_old_space_size=6144']) {
        assert.equal(selectTypecheckNodeOptions(options, 32 * gib), options);
    }
});

test('a symlinked CLI with spaces and Unicode still executes the compiler', {
    skip: process.platform === 'win32' ? 'File symlink creation requires Windows developer mode or elevation' : false,
}, () => {
    const directory = mkdtempSync(join(tmpdir(), 'fluentread-typecheck-'));
    try {
        const alias = join(directory, 'typecheck 入口.mjs');
        symlinkSync(fileURLToPath(new URL('../scripts/testing/run-typecheck.mjs', import.meta.url)), alias);
        const result = spawnSync(process.execPath, [alias, '--version'], {
            encoding: 'utf8', timeout: 30_000,
            env: {...process.env, FLUENTREAD_RESOURCE_LOCK_DIR: join(directory, 'locks'),
                FLUENTREAD_RESOURCE_LOCK_HELD: '', FLUENTREAD_RESOURCE_LOCK_TOKEN: '', FLUENTREAD_RESOURCE_LOCK_SLOT: ''},
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Version \d+\.\d+\.\d+/u);
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});

test('warm compiler state still rejects new TypeScript and Vue errors, then accepts their repair', {timeout: 120_000}, () => {
    const directory = mkdtempSync(join(tmpdir(), 'fluentread-warm-diagnostics-'));
    const script = fileURLToPath(new URL('../scripts/testing/run-typecheck.mjs', import.meta.url));
    try {
        // The fixture owns its build-info file; never overwrite the project's incremental state.
        symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(directory, 'node_modules'),
            process.platform === 'win32' ? 'junction' : 'dir');
        writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({
            compilerOptions: {strict: true, skipLibCheck: true, target: 'ES2022', module: 'ESNext',
                moduleResolution: 'Bundler', types: [], lib: ['ES2022', 'DOM']},
            include: ['probe.ts', 'Probe.vue'],
        }));
        const typescript = join(directory, 'probe.ts');
        const vue = join(directory, 'Probe.vue');
        const buildInfo = join(directory, 'probe.tsbuildinfo');
        const cleanTs = 'export const value: string = "ready";\n';
        const cleanVue = '<script setup lang="ts">const label: string = "ready";</script><template>{{ label }}</template>\n';
        writeFileSync(typescript, cleanTs);
        writeFileSync(vue, cleanVue);
        const check = () => {
            const result = spawnSync(process.execPath, [script, '--project', join(directory, 'tsconfig.json'),
                '--tsBuildInfoFile', buildInfo], {encoding: 'utf8', timeout: 25_000,
                env: {...process.env, FLUENTREAD_RESOURCE_LOCK_DIR: join(directory, 'locks'),
                    FLUENTREAD_RESOURCE_LOCK_HELD: '', FLUENTREAD_RESOURCE_LOCK_TOKEN: '', FLUENTREAD_RESOURCE_LOCK_SLOT: ''}});
            assert.ifError(result.error);
            return result;
        };
        let result = check();
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.ok(existsSync(buildInfo), 'the clean run must create compiler state');
        writeFileSync(typescript, 'export const value: string = 42;\n');
        result = check();
        assert.notEqual(result.status, 0);
        assert.match(result.stdout + result.stderr, /probe\.ts.*TS2322/u);
        writeFileSync(typescript, cleanTs);
        writeFileSync(vue, cleanVue.replace('"ready"', '42'));
        result = check();
        assert.notEqual(result.status, 0);
        assert.match(result.stdout + result.stderr, /Probe\.vue.*TS2322/u);
        writeFileSync(vue, cleanVue);
        result = check();
        assert.equal(result.status, 0, result.stdout + result.stderr);
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});
