import {afterEach, describe, expect, it} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {verifyTypecheckReceipts} from '../scripts/testing/run-typecheck.mjs';
const temporary: string[] = [];
const worker = resolve('scripts/testing/typecheck-part-worker.cjs');
const native = resolve('node_modules/vue-tsc/bin/vue-tsc.js');
function directory() {const root = mkdtempSync(join(tmpdir(), 'fr-typecheck-contract-')); temporary.push(root); return root;}
function save(root: string, name: string, text: string) {writeFileSync(join(root, name), text);}
function fixture() {
    const root = directory();
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
    save(root, 'package.json', '{"type":"module"}');
    save(root, 'tsconfig.json', JSON.stringify({compilerOptions: {target: 'ESNext', module: 'ESNext', moduleResolution: 'Bundler',
        strict: true, noEmit: true, skipLibCheck: true, noUnusedLocals: true, types: []}, include: ['*.ts', '*.vue']}));
    return root;
}
function execute(script: string, root: string, part?: number) {
    const evidence = join(root, 'evidence'); mkdirSync(evidence, {recursive: true});
    const result = spawnSync(process.execPath, [script, '--noEmit', '--pretty', 'false', '-p', join(root, 'tsconfig.json')], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 45_000,
        env: {...process.env, FLUENTREAD_TYPECHECK_PART: String(part ?? 0), FLUENTREAD_TYPECHECK_RECEIPTS: evidence},
    });
    expect(result.error, result.stderr).toBeUndefined(); expect(result.signal, result.stderr).toBeNull();
    return result;
}
const lines = (value: string) => [...new Set(value.trim().split('\n').map(line => line.trim()).filter(Boolean))].sort();
afterEach(() => {for (const root of temporary.splice(0)) rmSync(root, {recursive: true, force: true});});

describe('complete Program diagnostic partition contracts', () => {
    it('matches native Vue diagnostics for cross-file globals, augmentation, unused declarations and template errors', () => {
        const root = fixture();
        save(root, 'a.ts', "export {}; declare global {interface PartitionProbe {value: string}}\n");
        save(root, 'b.ts', "export {}; declare global {interface PartitionProbe {value: number}}\n");
        save(root, 'base.ts', "export interface Thing {value: string}; export declare function pick(value: string): 'base';\n");
        save(root, 'augment.ts', "import './base'; declare module './base' {interface Thing {flag: boolean}}\n");
        save(root, 'consumer.ts', "import type {Thing} from './base'; export const item: Thing = {value: 'x'};\n");
        save(root, 'overload-a.ts', "import './base'; declare module './base' {function pick(value: 'same'): 'a'}\n");
        save(root, 'overload-b.ts', "import './base'; declare module './base' {function pick(value: 'same'): 'b'}\n");
        save(root, 'overload-use.ts', "import {pick} from './base'; export const wrong: 'never' = pick('same');\n");
        for (const owner of ['left', 'right']) {
            const folder = join(root, owner, 'node_modules', 'identity-contract'); mkdirSync(folder, {recursive: true});
            save(folder, 'package.json', '{"name":"identity-contract","version":"1.0.0","types":"index.d.ts"}');
            save(folder, 'index.d.ts', 'export declare class Token {private brand: void}');
            save(join(root, owner), 'entry.ts', "export {Token} from 'identity-contract';");
        }
        save(root, 'identity.ts', "import {Token as A} from './left/entry'; import {Token as B} from './right/entry'; export const token: A = new B();");
        save(root, 'unused.ts', 'export {}; const unused = 1;\n');
        save(root, 'Broken.vue', '<script setup lang="ts">const count: number = "wrong";</script><template>{{ count.missing }}</template>');
        const expected = execute(native, root); expect(expected.status).not.toBe(0);
        expect(expected.stdout.match(/error TS/g)!.length).toBeGreaterThanOrEqual(5);
        const actual = Array.from({length: 4}, (_, part) => execute(worker, root, part));
        expect(lines(actual.map(result => result.stdout).join('\n'))).toEqual(lines(expected.stdout));
        const manifests = actual.map((_, i) => JSON.parse(readFileSync(join(root, 'evidence', `${i}.manifest.json`), 'utf8')));
        const results = actual.map((_, i) => JSON.parse(readFileSync(join(root, 'evidence', `${i}.result.json`), 'utf8')));
        expect(verifyTypecheckReceipts(manifests, results).sourceFiles).toBeGreaterThan(7);
    }, 120_000);
    it('does not turn native syntax/config failure or an unsupported incremental mode into success', () => {
        const root = fixture(); save(root, 'bad.ts', 'export const broken = ;');
        const expected = execute(native, root); const actual = execute(worker, root);
        expect(actual.status).not.toBe(0); expect(lines(actual.stdout)).toEqual(lines(expected.stdout));
        save(root, 'bad.ts', 'export const fixed = 1;');
        save(root, 'tsconfig.json', '{"compilerOptions":{"noEmit":true,"incremental":true},"files":["bad.ts"]}');
        expect(execute(worker, root).status).not.toBe(0);
        save(root, 'tsconfig.json', '{"compilerOptions":{"unknownPartitionOption":true},"files":["bad.ts"]}');
        const invalidNative = execute(native, root), invalidWorker = execute(worker, root);
        expect(invalidWorker.status).not.toBe(0); expect(lines(invalidWorker.stdout)).toEqual(lines(invalidNative.stdout));
    }, 60_000);
    it('runs a successful Vue project through the actual sequential parent and cleans temporary receipts', () => {
        const root = fixture(); save(root, 'Good.vue', '<script setup lang="ts">const count = 1;</script><template>{{ count }}</template>');
        const nativeResult = execute(native, root); expect(nativeResult.status, nativeResult.stdout).toBe(0);
        const temporaryRoot = join(root, 'temporary'); mkdirSync(temporaryRoot);
        const moduleUrl = pathToFileURL(resolve('scripts/testing/run-typecheck.mjs')).href;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {runTypecheck} from ${JSON.stringify(moduleUrl)}; await runTypecheck(process.argv[1]);`, join(root, 'tsconfig.json')],
            {cwd: process.cwd(), env: {...process.env, TMPDIR: temporaryRoot}, encoding: 'utf8', timeout: 60_000});
        expect(result.error).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain('[typecheck] complete:'); expect(readdirSync(temporaryRoot)).toEqual([]);
    }, 65_000);
    it('forwards parent interruption to its owned worker and does not report completion', async () => {
        const root = fixture(); save(root, 'Good.vue', '<script setup lang="ts">const count = 1;</script><template>{{ count }}</template>');
        const temporaryRoot = join(root, 'temporary'); mkdirSync(temporaryRoot);
        const moduleUrl = pathToFileURL(resolve('scripts/testing/run-typecheck.mjs')).href;
        const child = spawn(process.execPath, ['--input-type=module', '-e', `import {runTypecheck} from ${JSON.stringify(moduleUrl)}; await runTypecheck(process.argv[1]);`, join(root, 'tsconfig.json')],
            {cwd: process.cwd(), env: {...process.env, TMPDIR: temporaryRoot}, stdio: ['ignore', 'pipe', 'pipe']});
        let output = '', sent = false;
        child.stdout.on('data', chunk => {output += chunk; if (!sent && output.includes('partition 1/4')) {sent = true; child.kill('SIGTERM');}});
        child.stderr.resume();
        const outcome = await new Promise<{code: number | null; signal: string | null}>((resolveResult, reject) => {
            const timer = setTimeout(() => {child.kill('SIGKILL'); reject(new Error('Interrupted parent did not settle'));}, 10_000);
            child.once('error', error => {clearTimeout(timer); reject(error);});
            child.once('close', (code, signal) => {clearTimeout(timer); resolveResult({code, signal});});
        });
        expect(sent).toBe(true); expect(outcome.code).not.toBe(0); expect(output).not.toContain('[typecheck] complete:');
        expect(readdirSync(temporaryRoot)).toEqual([]);
    }, 15_000);
    it('accepts a complete identical manifest only and rejects missing, repeated or shifted work', () => {
        const manifest = {roots: ['a'], files: [{name: 'a'}, {name: 'b'}, {name: 'c'}, {name: 'd'}]};
        const fingerprint = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
        const manifests = Array.from({length: 4}, () => ({fingerprint, manifest}));
        const results = Array.from({length: 4}, (_, i) => ({fingerprint, complete: true, selected: [i]}));
        expect(verifyTypecheckReceipts(manifests, results)).toMatchObject({sourceFiles: 4, partitions: 4});
        expect(() => verifyTypecheckReceipts(manifests.slice(1), results)).toThrow('Missing');
        expect(() => verifyTypecheckReceipts(manifests, results.map((r, i) => i ? r : {...r, complete: false}))).toThrow('complete');
        expect(() => verifyTypecheckReceipts(manifests, results.map((r, i) => i ? r : {...r, selected: [0, 0]}))).toThrow('duplicate');
        expect(() => verifyTypecheckReceipts(manifests, results.map((r, i) => i ? r : {...r, selected: []}))).toThrow('not checked');
        expect(() => verifyTypecheckReceipts(manifests, results.map((r, i) => i ? r : {...r, fingerprint: 'changed'}))).toThrow('changed');
        expect(() => verifyTypecheckReceipts(manifests, results.map((r, i) => i ? r : {...r, selected: [1]}))).toThrow('assignment');
    });
});
