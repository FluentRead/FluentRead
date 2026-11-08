import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import JSZip from 'jszip';
import {bundleRelease, parseBundleArgs, RELEASE_TARGETS} from '../scripts/release/bundle.mjs';

const productVersion = '0.0.40';
const userscriptVersion = '2.0.2';
const prefix = `fluent-read-${productVersion}`;
const userscript = (version = userscriptVersion) => `// ==UserScript==\n// @name FluentRead\n// @version ${version}\n// ==/UserScript==\nconsole.log('fixture');\n`;

async function write(root, path, content) {
    const target = join(root, path);
    await mkdir(dirname(target), {recursive: true});
    await writeFile(target, typeof content === 'object' && !Buffer.isBuffer(content)
        ? JSON.stringify(content) : content);
}

function extensionManifest(manifestVersion, version = productVersion) {
    return {name: 'FluentRead', version, manifest_version: manifestVersion,
        background: manifestVersion === 3 ? {service_worker: 'background.js'} : {scripts: ['background.js']}};
}

async function zip(root, path, files) {
    const archive = new JSZip();
    for (const [name, content] of Object.entries(files)) {
        archive.file(name, typeof content === 'object' ? JSON.stringify(content) : content);
    }
    await write(root, path, await archive.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'}));
}

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'fluentread-release-bundle-'));
    t.after(() => rm(root, {recursive: true, force: true}));
    await write(root, 'package.json', {version: productVersion, userscriptVersion});
    for (const target of ['chrome', 'edge', 'firefox', 'thunderbird']) {
        await zip(root, `.output/${prefix}-${target}.${target === 'thunderbird' ? 'xpi' : 'zip'}`, {
            'manifest.json': extensionManifest(['chrome', 'edge'].includes(target) ? 3 : 2),
            'background.js': `console.log('${target}');`,
        });
    }
    await zip(root, `.output/${prefix}-sources.zip`, {
        'package.json': {version: productVersion, userscriptVersion},
        '.nvmrc': '22.23.4', 'pnpm-lock.yaml': 'lockfileVersion: 9.0', 'pnpm-workspace.yaml': 'overrides: {}',
        'patches/ppu-paddle-ocr@6.6.0.patch': 'patch fixture', 'wxt.config.ts': 'export default {}',
    });
    const zoteroManifest = {version: '3.1.4', applications: {zotero: {id: 'fluentread@fixture'}}};
    await write(root, 'integrations/zotero/manifest.json', zoteroManifest);
    await zip(root, 'integrations/zotero/dist/fluentread-zotero.xpi', {
        'manifest.json': zoteroManifest, 'bootstrap.js': 'function startup() {}',
    });
    const obsidianManifest = {id: 'fluentread-translation', version: '0.0.1'};
    await write(root, 'integrations/obsidian/manifest.json', obsidianManifest);
    await write(root, 'integrations/obsidian/dist/manifest.json', obsidianManifest);
    await write(root, 'integrations/obsidian/dist/main.js', 'module.exports = {};');
    await write(root, 'integrations/obsidian/dist/styles.css', '.fixture { color: red; }');
    await write(root, '.output/safari-mv2/manifest.json', {...extensionManifest(2),
        background: {page: 'safari-background.html', persistent: false}});
    await write(root, '.output/safari-mv2/safari-background.html', '<script src="./background.js"></script>');
    await write(root, '.output/safari-mv2/background.js', 'console.log("safari");');
    await write(root, '.output/safari-mv2/icon/16.png', 'fixture-icon');
    for (const target of ['userscript', 'userscript-standalone', 'userscript-greasyfork']) {
        await write(root, `.output/${target}/fluent-read.user.js`, userscript());
    }
    await write(root, '.output/userscript-greasyfork/fluentread-data.v1.js', 'var fixtureData = {};');
    return root;
}

async function assertSameArchiveFiles(leftBytes, rightBytes) {
    const [left, right] = await Promise.all([JSZip.loadAsync(leftBytes), JSZip.loadAsync(rightBytes)]);
    const names = archive => Object.values(archive.files).filter(entry => !entry.dir).map(entry => entry.name).sort();
    assert.deepEqual(names(left), names(right));
    for (const name of names(left)) {
        assert.deepEqual(await left.file(name).async('nodebuffer'), await right.file(name).async('nodebuffer'));
    }
}

test('all standard release targets preserve built archives, independent versions and portable fragments', async t => {
    const root = await fixture(t);
    const result = await bundleRelease({root});
    assert.equal(result.productVersion, productVersion);
    assert.equal(result.userscriptVersion, userscriptVersion);
    assert.equal(result.assets.length, 10);
    assert.deepEqual([...new Set(result.assets.map(asset => asset.target))], RELEASE_TARGETS);
    assert.equal(result.assets.find(asset => asset.target === 'obsidian').version, '0.0.1');
    assert.equal(result.assets.find(asset => asset.target === 'zotero').version, '3.1.4');
    assert.equal(result.assets.find(asset => asset.target === 'userscript').fileName,
        'fluent-read-2.0.2-userscript.user.js');
    assert.equal(result.assets.find(asset => asset.target === 'userscript-standalone').fileName,
        'fluent-read-2.0.2-userscript-standalone.user.js');
    assert.equal(result.assets.find(asset => asset.target === 'safari').fileName,
        `${prefix}-safari-webextension-unsigned.zip`);
    assert.equal(new Set(result.assets.map(asset => asset.fileName)).size, 10);
    for (const asset of result.assets) {
        assert.equal(asset.signed, false);
        assert((await readFile(asset.path)).length > 0);
    }
    for (const target of ['chrome', 'edge', 'firefox', 'thunderbird']) {
        const asset = result.assets.find(entry => entry.target === target);
        await assertSameArchiveFiles(await readFile(asset.path), await readFile(join(root, '.output', asset.fileName)));
    }
    await assertSameArchiveFiles(await readFile(join(root, 'reports/release/assets', `${prefix}-sources.zip`)),
        await readFile(join(root, '.output', `${prefix}-sources.zip`)));
    await assertSameArchiveFiles(await readFile(result.assets.find(entry => entry.target === 'zotero').path),
        await readFile(join(root, 'integrations/zotero/dist/fluentread-zotero.xpi')));
    for (const target of RELEASE_TARGETS) {
        const text = await readFile(join(root, 'reports/release/fragments', `${target}.json`), 'utf8');
        assert(!text.includes(root));
        const fragment = JSON.parse(text);
        assert.equal(fragment.productVersion, productVersion);
        assert.equal(fragment.userscriptVersion, userscriptVersion);
        assert(fragment.assets.every(asset => asset.target === target && !('path' in asset)));
    }
    assert.deepEqual((await readdir(join(root, 'reports/release/fragments'))).sort(),
        RELEASE_TARGETS.map(target => `${target}.json`).sort());
});

test('prebuilt ZIP and XPI metadata changes preserve all file bytes and produce identical release archives', async t => {
    const root = await fixture(t);
    const targets = ['chrome', 'edge', 'firefox', 'thunderbird', 'zotero'];
    const first = await bundleRelease({root, targets, outDir: 'first/assets'});
    for (const asset of first.assets) {
        const sourcePath = asset.target === 'zotero'
            ? join(root, 'integrations/zotero/dist/fluentread-zotero.xpi') : join(root, '.output', asset.fileName);
        const original = await readFile(sourcePath);
        const archive = await JSZip.loadAsync(original);
        const changed = new JSZip();
        changed.comment = 'different build metadata';
        for (const entry of Object.values(archive.files).filter(entry => !entry.dir).reverse()) {
            changed.file(entry.name, await entry.async('nodebuffer'), {
                date: new Date('2021-07-08T09:10:12.000Z'), createFolders: false, unixPermissions: 0o100755,
            });
        }
        const changedBytes = await changed.generateAsync({type: 'nodebuffer', platform: 'UNIX'});
        assert.notDeepEqual(original, changedBytes);
        await writeFile(sourcePath, changedBytes);
    }
    const second = await bundleRelease({root, targets, outDir: 'second/assets'});
    for (let index = 0; index < first.assets.length; index++) {
        const firstBytes = await readFile(first.assets[index].path);
        assert.deepEqual(firstBytes, await readFile(second.assets[index].path));
        const archive = await JSZip.loadAsync(firstBytes);
        for (const entry of Object.values(archive.files).filter(entry => !entry.dir)) {
            assert.equal(entry.date.toISOString(), '1980-01-01T00:00:00.000Z');
            assert.equal(entry.unixPermissions, 0o100644);
        }
    }
});

test('directory archives retain installable layout and bytes deterministically across runs', async t => {
    const root = await fixture(t);
    const first = await bundleRelease({root, targets: ['obsidian', 'safari'], outDir: 'first/assets'});
    const second = await bundleRelease({root, targets: ['obsidian', 'safari'], outDir: 'second/assets'});
    for (let index = 0; index < first.assets.length; index++) {
        const bytes = await readFile(first.assets[index].path);
        assert.deepEqual(bytes, await readFile(second.assets[index].path));
        const archive = await JSZip.loadAsync(bytes);
        assert(archive.file('manifest.json'));
        assert(!Object.keys(archive.files).some(name => name.startsWith('dist/')));
        if (first.assets[index].target === 'obsidian') {
            assert.equal(await archive.file('main.js').async('string'), 'module.exports = {};');
            assert.equal(await archive.file('styles.css').async('string'), '.fixture { color: red; }');
        } else assert.equal(await archive.file('icon/16.png').async('string'), 'fixture-icon');
    }
});

test('optional Greasy Fork source and additional resources keep installable script separate from sidecar ZIP', async t => {
    const root = await fixture(t);
    await write(root, '.output/userscript-greasyfork/resources/example.json', {value: true});
    const {assets} = await bundleRelease({root, targets: ['userscript-greasyfork']});
    assert.equal(assets.length, 2);
    assert.equal(assets[0].fileName, 'fluent-read-2.0.2-userscript-greasyfork.user.js');
    assert.equal((await readFile(assets[0].path)).toString(), userscript());
    const resources = await JSZip.loadAsync(await readFile(assets[1].path));
    assert(resources.file('fluentread-data.v1.js'));
    assert.equal(await resources.file('resources/example.json').async('string'), '{"value":true}');
    assert(!resources.file('fluent-read.user.js'));
});

test('stale product, source, plugin and userscript versions fail before writing a target fragment', async t => {
    for (const target of ['chrome', 'firefox', 'zotero', 'obsidian', 'userscript', 'safari']) {
        await t.test(target, async subtest => {
            const root = await fixture(subtest);
            if (target === 'chrome') await zip(root, `.output/${prefix}-chrome.zip`, {
                'manifest.json': extensionManifest(3, '0.0.39'), 'background.js': 'stale();',
            });
            else if (target === 'firefox') await zip(root, `.output/${prefix}-sources.zip`, {
                'package.json': {version: '0.0.39'}, 'pnpm-lock.yaml': 'lock', 'wxt.config.ts': 'config',
            });
            else if (target === 'zotero') await write(root, 'integrations/zotero/manifest.json',
                {version: '3.1.5', applications: {zotero: {id: 'fluentread@fixture'}}});
            else if (target === 'obsidian') await write(root, 'integrations/obsidian/dist/manifest.json',
                {id: 'fluentread-translation', version: '0.0.2'});
            else if (target === 'userscript') await write(root, '.output/userscript/fluent-read.user.js', userscript('2.0.1'));
            else await write(root, '.output/safari-mv2/manifest.json', extensionManifest(2, '0.0.39'));
            await assert.rejects(bundleRelease({root, targets: [target]}), /version/u);
            await assert.rejects(readFile(join(root, 'reports/release/fragments', `${target}.json`)), {code: 'ENOENT'});
        });
    }
});

test('rejects Firefox source archives without the pnpm workspace settings', async t => {
    const root = await fixture(t);
    const path = join(root, `.output/${prefix}-sources.zip`);
    const source = await JSZip.loadAsync(await readFile(path));
    source.remove('pnpm-workspace.yaml');
    await write(root, `.output/${prefix}-sources.zip`, await source.generateAsync({type: 'nodebuffer'}));
    await assert.rejects(bundleRelease({root, targets: ['firefox']}), /pnpm-workspace\.yaml/u);
});

test('empty, corrupt, incomplete and incorrect-format archives cannot become release assets', async t => {
    for (const scenario of ['empty-file', 'corrupt-zip', 'empty-zip', 'missing-script', 'wrong-manifest', 'unsafe-path']) {
        await t.test(scenario, async subtest => {
            const root = await fixture(subtest);
            const path = `.output/${prefix}-edge.zip`;
            if (scenario === 'empty-file') await write(root, path, '');
            else if (scenario === 'corrupt-zip') await write(root, path, 'not a ZIP');
            else if (scenario === 'empty-zip') await zip(root, path, {});
            else if (scenario === 'missing-script') await zip(root, path, {'manifest.json': extensionManifest(3)});
            else if (scenario === 'wrong-manifest') await zip(root, path, {
                'manifest.json': extensionManifest(2), 'background.js': 'fixture();',
            });
            else await zip(root, path, {
                'manifest.json': extensionManifest(3), 'background.js': 'fixture();', '../outside.txt': 'unexpected',
            });
            await assert.rejects(bundleRelease({root, targets: ['edge']}));
        });
    }
    const root = await fixture(t);
    await rm(join(root, '.output', `${prefix}-sources.zip`));
    await assert.rejects(bundleRelease({root, targets: ['firefox']}), {code: 'ENOENT'});
    await assert.rejects(readFile(join(root, 'reports/release/assets', `${prefix}-firefox.zip`)), {code: 'ENOENT'});
});

test('plugin IDs, required files and userscript headers are checked independently of version strings', async t => {
    const root = await fixture(t);
    await write(root, 'integrations/obsidian/dist/manifest.json', {id: 'different-plugin', version: '0.0.1'});
    await assert.rejects(bundleRelease({root, targets: ['obsidian']}), /plugin ID/u);
    await write(root, 'integrations/obsidian/dist/manifest.json', {id: 'fluentread-translation', version: '0.0.1'});
    await write(root, 'integrations/obsidian/dist/main.js', '');
    await assert.rejects(bundleRelease({root, targets: ['obsidian']}), /nonempty/u);
    await write(root, '.output/userscript/fluent-read.user.js', '// @version 2.0.2\nfixture();');
    await assert.rejects(bundleRelease({root, targets: ['userscript']}), /metadata header/u);
    await write(root, '.output/userscript/fluent-read.user.js', userscript().replace("console.log('fixture');", ''));
    await assert.rejects(bundleRelease({root, targets: ['userscript']}), /no script body/u);
    await rm(join(root, '.output/userscript-greasyfork/fluentread-data.v1.js'));
    await assert.rejects(bundleRelease({root, targets: ['userscript-greasyfork']}), /pinned data resource/u);
});

test('directory packaging rejects linked input files and output paths inside the build', async t => {
    const root = await fixture(t);
    await symlink(join(root, 'package.json'), join(root, 'integrations/obsidian/dist/linked.json'));
    await assert.rejects(bundleRelease({root, targets: ['obsidian']}), /symbolic link/u);
    await assert.rejects(bundleRelease({root, targets: ['safari'], outDir: '.output/safari-mv2/release'}), /outside/u);
    await assert.rejects(bundleRelease({root, targets: ['userscript'], outDir: '.output/userscript'}), /outside/u);
    await write(root, 'package.json', {version: '../unexpected', userscriptVersion});
    await assert.rejects(bundleRelease({root, targets: ['safari']}), /valid version/u);
});

test('CLI selection is explicit, supports repeated targets, and excludes Greasy Fork from --all', () => {
    assert.deepEqual(parseBundleArgs(['--target', 'chrome', '--target', 'firefox', '--out-dir', 'custom/assets']),
        {targets: ['chrome', 'firefox'], outDir: 'custom/assets'});
    assert.deepEqual(parseBundleArgs(['--all']).targets, RELEASE_TARGETS);
    assert(!parseBundleArgs(['--all']).targets.includes('userscript-greasyfork'));
    for (const arguments_ of [[], ['--target'], ['--out-dir'], ['--target', 'docker'],
        ['--all', '--target', 'chrome'], ['--all', '--all'], ['--target', 'chrome', '--target', 'chrome'], ['--unknown']]) {
        assert.throws(() => parseBundleArgs(arguments_));
    }
});

test('invalid CLI input exits with a concise error before examining build output', () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/release/bundle.mjs', import.meta.url)),
        '--target', 'docker'], {encoding: 'utf8'});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^\[release-bundle\] Unsupported release target: docker\s*$/u);
    assert.equal(result.stdout, '');
});
