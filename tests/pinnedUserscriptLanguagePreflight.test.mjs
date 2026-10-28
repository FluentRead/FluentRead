import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {verifyPinnedUserscriptLanguages} from '../scripts/testing/verify-pinned-userscript-languages.mjs';

function fixture() {
    const root = mkdtempSync(resolve(tmpdir(), 'fluentread-pinned-languages-'));
    const directory = resolve(root, 'userscript/languages');
    mkdirSync(directory, {recursive: true});
    const imports = [], files = [];
    for (const language of ['es-ES', 'fr-FR', 'ja-JP', 'ko-KR', 'ru-RU']) {
        const serialized = JSON.stringify({messages: {language}, legacyText: {}, legacyPatterns: {early: [], late: []}});
        const hash = createHash('sha256').update(serialized).digest('hex').slice(0, 16);
        const name = `${language}.${hash}.json`;
        const path = resolve(directory, name);
        writeFileSync(path, `${serialized}\n`);
        writeFileSync(path.replace(/\.json$/u, '.d.json.ts'), 'export {};\n');
        imports.push(`import value${imports.length} from './languages/${name}';`);
        files.push(path);
    }
    writeFileSync(resolve(root, 'userscript/languageBundles.ts'), imports.join('\n'));
    return {root, files, imports};
}

test('validates all referenced pinned resources before type checking', () => {
    const {root, files} = fixture();
    try {
        assert.doesNotThrow(() => verifyPinnedUserscriptLanguages(root));
        writeFileSync(files[0], readFileSync(files[0], 'utf8').replace(/\n$/u, '\r\n'));
        assert.doesNotThrow(() => verifyPinnedUserscriptLanguages(root));
    }
    finally {rmSync(root, {recursive: true, force: true});}
});

test('CLI validates the repository even when invoked from another directory', () => {
    const script = fileURLToPath(new URL('../scripts/testing/verify-pinned-userscript-languages.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script], {cwd: tmpdir(), encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
});

test('rejects missing JSON and declaration files', () => {
    const {root, files} = fixture();
    try {
        unlinkSync(files[0]);
        assert.throws(() => verifyPinnedUserscriptLanguages(root), /ENOENT/u);
        const other = fixture();
        try {
            const declaration = other.files[0].replace(/\.json$/u, '.d.json.ts');
            unlinkSync(declaration);
            assert.throws(() => verifyPinnedUserscriptLanguages(other.root), /ENOENT/u);
            mkdirSync(declaration);
            assert.throws(() => verifyPinnedUserscriptLanguages(other.root), /声明不存在/u);
        } finally {rmSync(other.root, {recursive: true, force: true});}
    } finally {rmSync(root, {recursive: true, force: true});}
});

test('rejects invalid, altered and noncanonical JSON without echoing its contents', () => {
    const {root, files} = fixture();
    try {
        const original = readFileSync(files[0], 'utf8');
        writeFileSync(files[0], '{"secret":"broken');
        assert.throws(() => verifyPinnedUserscriptLanguages(root), error =>
            /不是有效 JSON/u.test(error.message) && !error.message.includes('secret'));
        writeFileSync(files[0], '{"different":true}\n');
        assert.throws(() => verifyPinnedUserscriptLanguages(root), /内容或摘要不匹配/u);
        writeFileSync(files[0], ` ${original}`);
        assert.throws(() => verifyPinnedUserscriptLanguages(root), /内容或摘要不匹配/u);
    } finally {rmSync(root, {recursive: true, force: true});}
});

test('rejects a missing or duplicated import', () => {
    const {root, imports} = fixture();
    try {
        const path = resolve(root, 'userscript/languageBundles.ts');
        writeFileSync(path, imports.slice(0, 4).join('\n'));
        assert.throws(() => verifyPinnedUserscriptLanguages(root), /列表不完整/u);
        writeFileSync(path, [...imports, imports[0].replace('value0', 'duplicate')].join('\n'));
        assert.throws(() => verifyPinnedUserscriptLanguages(root), /重复/u);
        writeFileSync(path, ["import x from './languages/es-ES.bad.json';", ...imports.slice(1)].join('\n'));
        assert.throws(() => verifyPinnedUserscriptLanguages(root), /无效/u);
    } finally {rmSync(root, {recursive: true, force: true});}
});
