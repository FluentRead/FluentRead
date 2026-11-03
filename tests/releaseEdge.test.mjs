import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import JSZip from 'jszip';
import {verifyEdgeArchive, verifyEdgeBackground, verifyEdgeManifest} from '../scripts/release/verify-edge.mjs';

test('Edge release identity rejects Chrome permissions, foreign browser targets and stale versions', () => {
  const manifest = {manifest_version: 3, version: '0.0.40', permissions: ['storage', 'offscreen'], background: {service_worker: 'background.js'}};
  assert.equal(verifyEdgeManifest(manifest, '0.0.40'), manifest);
  for (const patch of [
    {manifest_version: 2}, {version: '0.0.39'}, {key: 'chrome-key'}, {oauth2: {}},
    {permissions: ['offscreen', 'identity']}, {permissions: ['offscreen', 'offscreen']},
    {permissions: []}, {background: {service_worker: '../background.js'}},
    {browser_specific_settings: {gecko: {id: 'firefox'}}},
  ]) assert.throws(() => verifyEdgeManifest({...manifest, ...patch}, '0.0.40'));
  const marker = '__FLUENTREAD_BROWSER_CAPABILITY_BUILD__:edge:mv3__';
  verifyEdgeBackground(`const target=${JSON.stringify(marker)};`);
  for (const source of ['', marker.replace('edge', 'chrome'), `${marker};import.meta.env.BROWSER`,
    `${marker};process.env.VUE_APP_VERSION`, `${marker};__FLUENTREAD_BROWSER_CAPABILITY_BUILD__:firefox:mv2__`]) {
    assert.throws(() => verifyEdgeBackground(source));
  }
});

test('Edge archive verification compares every nested byte and rejects missing, extra or stale assets', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fluentread-edge-release-'));
  try {
    await mkdir(path.join(directory, 'assets'));
    const manifest = {version: '0.0.40'};
    const manifestBytes = JSON.stringify(manifest);
    await writeFile(path.join(directory, 'manifest.json'), manifestBytes);
    await writeFile(path.join(directory, 'assets/worker.js'), '中文脚本');
    const createArchive = () => new JSZip().file('manifest.json', manifestBytes).file('assets/worker.js', '中文脚本');
    assert.deepEqual(await verifyEdgeArchive(await createArchive().generateAsync({type: 'nodebuffer'}), directory, manifest), {files: 2});
    for (const archive of [
      createArchive().remove('assets/worker.js'), createArchive().file('extra.js', 'extra'),
      createArchive().file('assets/worker.js', 'changed'), createArchive().file('manifest.json', '{"version":"old"}'),
    ]) await assert.rejects(verifyEdgeArchive(await archive.generateAsync({type: 'nodebuffer'}), directory, manifest));
    assert.equal(await readFile(path.join(directory, 'assets/worker.js'), 'utf8'), '中文脚本');
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('Edge release verification refuses symlinked files, directories and unsafe ZIP entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fluentread-edge-links-'));
  const directory = path.join(root, 'build');
  try {
    await mkdir(directory);
    await writeFile(path.join(directory, 'manifest.json'), '{}');
    const createArchive = () => new JSZip().file('manifest.json', '{}');
    await symlink('manifest.json', path.join(directory, 'link.json'));
    await assert.rejects(verifyEdgeArchive(await createArchive().generateAsync({type: 'nodebuffer'}), directory, {}), /符号链接/);
    await rm(path.join(directory, 'link.json'));
    await symlink('build', path.join(root, 'linked-build'));
    await assert.rejects(verifyEdgeArchive(await createArchive().generateAsync({type: 'nodebuffer'}), path.join(root, 'linked-build'), {}), /符号链接/);
    for (const archive of [
      createArchive().file('../escaped.js', 'unsafe'),
      createArchive().file('manifest.json', '{}', {unixPermissions: 0o120777}),
    ]) await assert.rejects(verifyEdgeArchive(await archive.generateAsync({type: 'nodebuffer', platform: 'UNIX'}), directory, {}), /ZIP/);
  } finally {await rm(root, {recursive: true, force: true});}
});

test('Edge rejects embedded compressed files by bytes while preserving the complete readable license', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fluentread-edge-compressed-'));
  try {
    const manifest = {version: '0.0.40'};
    const manifestBytes = JSON.stringify(manifest);
    const filename = 'license.txt';
    await writeFile(path.join(directory, 'manifest.json'), manifestBytes);
    const gzip = await readFile(new URL('./fixtures/reading-annotation/koroman-upstream-LICENSE.txt.gz', import.meta.url));
    const license = await readFile(new URL('../public/third-party-notices/reading-koroman-MIT.txt', import.meta.url));
    const nestedZip = await new JSZip().file('LICENSE.txt', license).generateAsync({type: 'nodebuffer'});
    const emptyZip = await new JSZip().generateAsync({type: 'nodebuffer'});
    for (const bytes of [gzip, nestedZip, emptyZip]) {
      await writeFile(path.join(directory, filename), bytes);
      const archive = await new JSZip().file('manifest.json', manifestBytes).file(filename, bytes)
        .generateAsync({type: 'nodebuffer', compression: 'DEFLATE'});
      await assert.rejects(verifyEdgeArchive(archive, directory, manifest), /嵌套压缩文件：license\.txt \((?:GZIP|ZIP)\)/);
    }
    await writeFile(path.join(directory, filename), license);
    const archive = await new JSZip().file('manifest.json', manifestBytes).file(filename, license)
      .generateAsync({type: 'nodebuffer', compression: 'DEFLATE'});
    assert.deepEqual(await verifyEdgeArchive(archive, directory, manifest), {files: 2});
  } finally {await rm(directory, {recursive: true, force: true});}
});
