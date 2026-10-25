import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, writeFile, access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const script = fileURLToPath(new URL('../scripts/testing/report-ci-builds.mjs', import.meta.url));

test('CI reports measure actual nested assets and append portable evidence to the Actions summary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fluentread-ci-builds-'));
  try {
    const chrome = path.join(root, '.output/chrome-mv3');
    const firefox = path.join(root, '.output/firefox-mv2');
    await mkdir(path.join(chrome, 'assets'), {recursive: true});
    await mkdir(firefox, {recursive: true});
    await writeFile(path.join(chrome, 'manifest.json'), '{}');
    await writeFile(path.join(chrome, 'assets/main.js'), '你好');
    // 最大脚本不在分析器最大的 15 个资源中，报告仍须准确找到它。
    for (let index = 0; index < 16; index++) await writeFile(path.join(chrome, 'assets', `${index}.wasm`), Buffer.alloc(10));
    await writeFile(path.join(firefox, 'manifest.json'), '{}');
    await writeFile(path.join(firefox, 'background.js'), 'hello');
    const summaryPath = path.join(root, 'summary.md');
    await writeFile(summaryPath, 'Previous job evidence\n');
    const result = spawnSync(process.execPath, [script, '.output/chrome-mv3', firefox], {
      cwd: root, encoding: 'utf8', env: {...process.env, GITHUB_STEP_SUMMARY: summaryPath},
    });
    assert.equal(result.status, 0, result.stderr);
    const chromeJson = await readFile(path.join(root, 'reports/ci-builds/chrome-mv3.json'), 'utf8');
    const report = JSON.parse(chromeJson);
    assert.equal(report.files, 18);
    assert.equal(report.totalBytes, 168);
    assert.deepEqual(report.largestScript, {path: 'assets/main.js', bytes: 6});
    assert.equal(JSON.parse(await readFile(path.join(root, 'reports/ci-builds/firefox-mv2.json'), 'utf8')).totalBytes, 7);
    const summary = await readFile(summaryPath, 'utf8');
    assert.ok(summary.startsWith('Previous job evidence\n'));
    assert.match(summary, /chrome-mv3 \| 18 \| 168/);
    assert.match(summary, /65,000,000-byte/);
    assert.equal(chromeJson.includes(root), false);
    assert.equal(summary.includes(root), false);
    assert.equal(result.stdout.includes(root), false);
    assert.deepEqual(await readFile(path.join(chrome, 'assets/main.js')), Buffer.from('你好'));
  } finally {await rm(root, {recursive: true, force: true});}
});

test('missing, non-extension and colliding targets fail before publishing partial build evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fluentread-ci-builds-invalid-'));
  try {
    await mkdir(path.join(root, 'chrome-mv3'));
    await writeFile(path.join(root, 'chrome-mv3/manifest.json'), '{}');
    await mkdir(path.join(root, 'empty'));
    for (const args of [[], ['chrome-mv3', 'missing'], ['empty'], ['chrome-mv3', './chrome-mv3']]) {
      const result = spawnSync(process.execPath, [script, ...args], {cwd: root, encoding: 'utf8', env: {...process.env, GITHUB_STEP_SUMMARY: ''}});
      assert.notEqual(result.status, 0, JSON.stringify(args));
      await assert.rejects(access(path.join(root, 'reports/ci-builds')));
    }
  } finally {await rm(root, {recursive: true, force: true});}
});
