#!/usr/bin/env node
/**
 * @file scripts/release/verify-edge.mjs
 * 校验独立 Edge MV3 发布目录与 ZIP 的清单、后台目标、界面资源及逐文件字节一致性。
 * 拒绝包内嵌套的 GZIP/ZIP 文件，复用已有本地化与 frame 样式契约；不修改产物、不签名、不提交商店。
 */
import assert from 'node:assert/strict';
import {lstat, readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import JSZip from 'jszip';
import {verifyFrameUiStyles, verifyLocalizedExtensionMetadata} from '../testing/verify-extension-manifests.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const marker = '__FLUENTREAD_BROWSER_CAPABILITY_BUILD__:edge:mv3__';
const compressedSignatures = [
  {format: 'GZIP', bytes: Buffer.from([0x1f, 0x8b, 0x08])},
  ...[[0x03, 0x04], [0x05, 0x06], [0x07, 0x08]].map(suffix => ({
    format: 'ZIP', bytes: Buffer.from([0x50, 0x4b, ...suffix]),
  })),
];

function validRelativePath(value, directory = false) {
  if (typeof value !== 'string' || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value)) return false;
  const normalized = directory && value.endsWith('/') ? value.slice(0, -1) : value;
  return normalized.length > 0 && normalized.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes(':'));
}

async function listBuildFiles(directory, current = directory) {
  assert((await lstat(current)).isDirectory(), 'Edge 产物目录必须是普通目录，不能为符号链接');
  const files = [];
  for (const entry of await readdir(current, {withFileTypes: true})) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(directory, absolute).split(path.sep).join('/');
    assert(validRelativePath(relative), `Edge 产物路径无效：${relative}`);
    if (entry.isDirectory()) files.push(...await listBuildFiles(directory, absolute));
    else {
      assert(entry.isFile(), `Edge 产物不能包含符号链接或特殊文件：${relative}`);
      files.push(relative);
    }
  }
  return files.sort();
}

export function verifyEdgeManifest(manifest, expectedVersion) {
  assert(manifest.manifest_version === 3, 'Edge 发布产物必须是 Manifest V3');
  assert(manifest.version === expectedVersion, 'Edge 清单版本必须与根 package.json 一致');
  assert(!Object.hasOwn(manifest, 'oauth2') && !Object.hasOwn(manifest, 'key'), 'Edge 清单不得包含 Chrome OAuth 或固定 key');
  assert(Array.isArray(manifest.permissions) && !manifest.permissions.includes('identity')
    && manifest.permissions.filter(permission => permission === 'offscreen').length === 1,
  'Edge 必须仅声明一次 offscreen，且不得声明 Chrome identity 权限');
  assert(!manifest.browser_specific_settings?.gecko && !manifest.browser_specific_settings?.safari,
    'Edge 清单不得包含 Firefox 或 Safari 身份字段');
  assert(validRelativePath(manifest.background?.service_worker), 'Edge MV3 必须声明包内后台 service_worker');
  return manifest;
}

export function verifyEdgeBackground(source) {
  assert(source.includes(marker), 'Edge 后台缺少 edge/MV3 runtime capability 构建标记');
  assert(!/__FLUENTREAD_BROWSER_CAPABILITY_BUILD__:(?!edge:mv3__)/u.test(source), 'Edge 后台混入其他浏览器的构建标记');
  assert(!source.includes('import.meta') && !/\bprocess\.env\.(?:VUE_APP_VERSION|NODE_ENV|WXT_[A-Z_]+)/u.test(source),
    'Edge classic 后台残留未替换的构建环境变量');
}

export async function verifyEdgeArchive(zipBytes, directory, expectedManifest) {
  const files = await listBuildFiles(directory);
  const archive = await JSZip.loadAsync(zipBytes, {checkCRC32: true});
  const entries = Object.values(archive.files);
  for (const entry of entries) {
    assert(validRelativePath(entry.name, entry.dir) && (!entry.unsafeOriginalName || entry.unsafeOriginalName === entry.name),
      'Edge ZIP 不得包含越界或非规范路径');
    const type = Number(entry.unixPermissions ?? 0) & 0o170000;
    assert(type === 0 || type === (entry.dir ? 0o040000 : 0o100000), 'Edge ZIP 不得包含符号链接或特殊文件');
  }
  const names = entries.filter(entry => !entry.dir).map(entry => entry.name).sort();
  assert.deepEqual(names, files, 'Edge ZIP 的文件条目必须与构建目录一致');
  const manifestEntry = archive.file('manifest.json');
  assert(manifestEntry, 'Edge ZIP 缺少 manifest.json');
  assert.deepEqual(JSON.parse(await manifestEntry.async('string')), expectedManifest, 'Edge ZIP 清单与已校验清单不一致');
  for (const name of files) {
    const archived = await archive.file(name).async('nodebuffer');
    // 按文件内容识别，改扩展名不能让嵌套压缩包通过；外层安装 ZIP 的 DEFLATE 不受影响。
    const compressed = compressedSignatures.find(signature => archived.subarray(0, signature.bytes.length).equals(signature.bytes));
    assert(!compressed, `Edge 安装包不得包含嵌套压缩文件：${name} (${compressed?.format})`);
    const local = await readFile(path.join(directory, name));
    assert(archived.equals(local), `Edge ZIP 文件内容与构建目录不一致：${name}`);
  }
  return {files: files.length};
}

export async function verifyEdgeBuild({directory = path.join(root, '.output/edge-mv3'), archivePath} = {}) {
  const {version} = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const archive = archivePath ?? path.join(root, `.output/fluent-read-${version}-edge.zip`);
  const files = await listBuildFiles(directory);
  assert(files.includes('manifest.json') && files.includes('offscreen.html'), 'Edge 产物缺少清单或 offscreen 页面');
  const manifest = verifyEdgeManifest(JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')), version);
  assert(files.includes(manifest.background.service_worker), 'Edge 产物缺少清单声明的后台脚本');
  verifyEdgeBackground(await readFile(path.join(directory, manifest.background.service_worker), 'utf8'));
  const locales = await verifyLocalizedExtensionMetadata(directory, manifest);
  const scripts = Object.fromEntries(await Promise.all(files.filter(file => file.startsWith('content-scripts/') && file.endsWith('.js'))
    .map(async file => [file, await readFile(path.join(directory, file), 'utf8')])));
  verifyFrameUiStyles(manifest, files, scripts, 'Edge');
  assert((await lstat(archive)).isFile(), 'Edge ZIP 必须是普通文件，不能为符号链接');
  const result = await verifyEdgeArchive(await readFile(archive), directory, manifest);
  return {verified: true, target: 'edge-mv3', version, locales, archive: path.basename(archive), ...result};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  verifyEdgeBuild().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(`[edge-release] ${error.message}`);
    process.exitCode = 1;
  });
}
