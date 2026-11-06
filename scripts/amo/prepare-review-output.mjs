#!/usr/bin/env node
/**
 * @file scripts/amo/prepare-review-output.mjs
 * 文件职责：让 AMO 构建目录采用固定清单格式，便于审核者逐文件复现。
 * 主要内容：确认输出属于 Firefox，再以两空格缩进写入同一份 manifest JSON。
 * 模块边界：不改清单字段、不改 JavaScript、不复制既有安装包，也不创建或上传商店版本。
 */
import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const manifestPath = fileURLToPath(new URL('../../.output/firefox-mv2/manifest.json', import.meta.url));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (!manifest.browser_specific_settings?.gecko?.id) {
    throw new Error('AMO review output must contain a Firefox extension ID');
}

// AMO 返回的 0.0.40 审核包采用两空格缩进且没有末尾换行；这里只统一序列化格式。
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
console.log('AMO review output ready: .output/firefox-mv2');
