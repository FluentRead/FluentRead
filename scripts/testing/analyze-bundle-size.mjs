#!/usr/bin/env node
// 分析已有构建目录的实际字节数和重复文件；不构建、不修改产物。
// 用法：pnpm analyze:bundle [构建目录] [基线目录]
import {createHash} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';

async function measure(directory) {
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, {withFileTypes: true})) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        const data = await readFile(absolute);
        files.push({path: path.relative(directory, absolute), bytes: data.length,
          hash: createHash('sha256').update(data).digest('hex')});
      }
    }
  }
  await walk(directory);
  if (!files.some(file => file.path === 'manifest.json')) {
    throw new Error(`不是扩展构建目录（缺少 manifest.json）：${directory}`);
  }
  return files.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
}

const directory = path.resolve(process.argv[2] || '.output/chrome-mv3');
const files = await measure(directory);
const total = files.reduce((sum, file) => sum + file.bytes, 0);
const groups = new Map();
for (const file of files) {
  if (!groups.has(file.hash)) groups.set(file.hash, []);
  groups.get(file.hash).push(file);
}
const duplicates = [...groups.values()].filter(group => group.length > 1).map(group => ({
  paths: group.map(file => file.path), bytesEach: group[0].bytes,
  duplicateBytes: group[0].bytes * (group.length - 1),
}));
const result = {directory, files: files.length, totalBytes: total,
  largestFiles: files.slice(0, 15).map(({path, bytes}) => ({path, bytes})), duplicates};
if (process.argv[3]) {
  const baseline = await measure(path.resolve(process.argv[3]));
  const baselineBytes = baseline.reduce((sum, file) => sum + file.bytes, 0);
  result.comparison = {baselineBytes, savedBytes: baselineBytes - total,
    savedPercent: Number(((baselineBytes - total) / baselineBytes * 100).toFixed(3))};
}
console.log(JSON.stringify(result, null, 2));
