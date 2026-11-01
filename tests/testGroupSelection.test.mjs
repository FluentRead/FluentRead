import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const groups = JSON.parse(readFileSync(new URL('./test-matrix.json', import.meta.url))).groups;
const run = (...args) => spawnSync(process.execPath, ['scripts/testing/run-test-group.mjs', ...args, '--dry-run'], {cwd: root, encoding: 'utf8'});
const plan = (...args) => {const result = run(...args);assert.equal(result.status, 0, result.stderr);return JSON.parse(result.stdout);};

test('file, absolute path and pnpm separator select only the requested test within its group', () => {
    const file = groups.unit[0];
    for (const filter of [file, `./${file}`, `${root}${file}`]) assert.deepEqual(plan('unit', '--', filter).files, [file]);
    assert.deepEqual(plan('unit').files, groups.unit);
});

test('multiple path fragments select a deduplicated union and keep case selection separate', () => {
    const files = groups.unit.slice(0, 2);
    assert.deepEqual(plan('unit', ...files, files[0], '-t', 'specific case').files, files);
    assert.equal(plan('unit', files[0], '--testNamePattern=specific case').testNamePattern, 'specific case');
    assert.equal(plan('unit', files[0], '--coverage').coverage, true);
    const directory = groups.unit[0].split('/').slice(0, -1).join('/') + '/';
    assert.deepEqual(plan('unit', directory).files, groups.unit.filter(file => file.includes(directory)));
});

test('unknown, unmatched, cross-group and invalid selections fail without silently running the group', () => {
    const crossGroup = groups.functional.find(file => !groups.unit.includes(file));
    for (const args of [
        ['unit', 'tests/missing.test.ts'], ['unit', groups.unit[0], 'tests/missing.test.ts'],
        ['unit', crossGroup], ['unit', '--unknown'], ['unit', '-t'], ['unit', '--testNamePattern='],
        ['unit', '../outside'], ['missing'],
    ]) {
        const result = run(...args);
        assert.equal(result.status, 1, JSON.stringify(args));
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /\[test-group\]/u);
    }
});
