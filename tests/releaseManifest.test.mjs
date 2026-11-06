import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {copyFile, mkdtemp, mkdir, readFile, rm, unlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {EXPECTED_TARGETS, finalizeRelease, validateReleaseVersion} from '../scripts/release/manifest.mjs';
import {validatePreparedRelease} from '../scripts/release/publish.mjs';

async function amoFixture(t, manifestText) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fluentread-amo-review-'));
    t.after(() => rm(root, {recursive: true, force: true}));
    const script = path.join(root, 'scripts/amo/prepare-review-output.mjs');
    const manifest = path.join(root, '.output/firefox-mv2/manifest.json');
    await mkdir(path.dirname(script), {recursive: true});
    await mkdir(path.dirname(manifest), {recursive: true});
    await copyFile(new URL('../scripts/amo/prepare-review-output.mjs', import.meta.url), script);
    await writeFile(manifest, manifestText);
    return {root, script, manifest, run: () => execFileSync(process.execPath, [script], {cwd: os.tmpdir(), encoding: 'utf8', stdio: 'pipe'})};
}

test('AMO review output preserves every manifest field and leaves JavaScript unchanged across repeated runs', async t => {
    const input = {manifest_version: 2, version: '1.2.3', name: 'FluentRead',
        browser_specific_settings: {gecko: {id: 'fixture@example.org', strict_min_version: '140.0'}},
        permissions: ['storage', '<all_urls>'], custom: {nested: ['保留', false, null]}};
    const options = await amoFixture(t, JSON.stringify(input) + '\n');
    const background = path.join(options.root, '.output/firefox-mv2/background.js');
    const javascript = Buffer.from('globalThis.fixture = "unchanged";\n');
    await writeFile(background, javascript);
    for (let attempt = 0; attempt < 2; attempt++) {
        assert.match(options.run(), /AMO review output ready: \.output\/firefox-mv2/);
        const actual = await readFile(options.manifest, 'utf8');
        assert.deepEqual(JSON.parse(actual), input);
        assert.equal(actual, JSON.stringify(input, null, 2));
        assert.deepEqual(await readFile(background), javascript);
    }
});

test('AMO review output rejects non-Firefox and invalid manifests without overwriting them', async t => {
    for (const input of [JSON.stringify({manifest_version: 3, version: '1.2.3'}), '{invalid']) {
        const options = await amoFixture(t, input);
        assert.throws(options.run, /Firefox extension ID|SyntaxError/);
        assert.equal(await readFile(options.manifest, 'utf8'), input);
    }
});

async function fixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fluentread-release-manifest-'));
    t.after(() => rm(root, {recursive: true, force: true}));
    for (const dir of ['integrations/zotero', 'integrations/obsidian', 'reports/release/assets', 'reports/release/fragments']) await mkdir(path.join(root, dir), {recursive: true});
    await writeFile(path.join(root, 'package.json'), JSON.stringify({version: '1.2.3', userscriptVersion: '2.0.2'}));
    for (const [component, version] of [['zotero', '1.1.0'], ['obsidian', '0.0.1']]) await writeFile(path.join(root, `integrations/${component}/manifest.json`), JSON.stringify({version}));
    for (const target of EXPECTED_TARGETS) {
        const version = target.startsWith('userscript') ? '2.0.2' : target === 'obsidian' ? '0.0.1' : target === 'zotero' ? '1.1.0' : '1.2.3';
        await writeFile(path.join(root, `reports/release/assets/${target}.zip`), `package:${target}`);
        await writeFile(path.join(root, `reports/release/fragments/${target}.json`), JSON.stringify({productVersion: '1.2.3', userscriptVersion: '2.0.2', assets: [{target, version, fileName: `${target}.zip`, signed: false, kind: 'fixture'}]}));
    }
    return {root, directory: path.join(root, 'reports/release'), tag: 'v1.2.3', repository: 'FluentRead/FluentRead', sourceCommit: 'a'.repeat(40)};
}

test('release preserves independent component versions and hashes every package plus manifest', async t => {
    const options = await fixture(t);
    const manifest = await finalizeRelease(options);
    assert.equal(manifest.assets.length, EXPECTED_TARGETS.length);
    assert.equal(manifest.assets.find(asset => asset.target === 'obsidian').version, '0.0.1');
    const assetsDir = path.join(options.directory, 'assets');
    const checksums = (await readFile(path.join(assetsDir, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n');
    assert.equal(checksums.length, EXPECTED_TARGETS.length + 1);
    for (const line of checksums) {
        const [digest, name] = line.split('  ');
        assert.equal(digest, createHash('sha256').update(await readFile(path.join(assetsDir, name))).digest('hex'));
    }
    assert.deepEqual(await finalizeRelease(options), manifest);
    assert.match(await readFile(path.join(assetsDir, 'release-notes.md'), 'utf8'), /unsigned web-extension/);
    const prepared = validatePreparedRelease({tag: options.tag, assetsDir,
        env: {GH_TOKEN: 'offline-fixture', GITHUB_REPOSITORY: options.repository, GITHUB_SHA: options.sourceCommit}});
    assert.equal(prepared.assets.length, EXPECTED_TARGETS.length + 2);
    assert.equal(prepared.sourceCommit, options.sourceCommit);
});

test('version changes do not silently publish another tag', async t => {
    const options = await fixture(t);
    await assert.rejects(validateReleaseVersion({...options, tag: 'v1.2.4'}), /must match/);
    await assert.rejects(validateReleaseVersion({...options, tag: 'v1.2.3\nunsafe=true'}), /must match/);
});

test('missing targets or mixed source builds cannot produce a Release manifest', async t => {
    const options = await fixture(t);
    const fragment = path.join(options.directory, 'fragments/chrome.json');
    const original = await readFile(fragment, 'utf8');
    await unlink(fragment);
    await assert.rejects(finalizeRelease(options), /target fragments/);
    await writeFile(fragment, original.replace('1.2.3', '9.9.9'));
    await assert.rejects(finalizeRelease(options), /Mixed source versions/);
});

test('extra stale assets and duplicate filenames fail before checksums are finalized', async t => {
    const options = await fixture(t);
    const stale = path.join(options.directory, 'assets/stale.zip');
    await writeFile(stale, 'old build');
    await assert.rejects(finalizeRelease(options), /Unexpected file/);
    await unlink(stale);
    const fragmentPath = path.join(options.directory, 'fragments/edge.json');
    const fragment = JSON.parse(await readFile(fragmentPath, 'utf8'));
    fragment.assets[0].fileName = 'chrome.zip';
    await writeFile(fragmentPath, JSON.stringify(fragment));
    await assert.rejects(finalizeRelease(options), /Duplicate release asset/);
});

test('directory traversal and false component version metadata are rejected', async t => {
    const options = await fixture(t);
    const filename = path.join(options.directory, 'fragments/obsidian.json');
    const fragment = JSON.parse(await readFile(filename, 'utf8'));
    fragment.assets[0].version = '1.2.3';
    await writeFile(filename, JSON.stringify(fragment));
    await assert.rejects(finalizeRelease(options), /Invalid version/);
    fragment.assets[0].fileName = '../outside.zip';
    await writeFile(filename, JSON.stringify(fragment));
    await assert.rejects(finalizeRelease(options), /Unsafe asset metadata/);
});
