#!/usr/bin/env node
/**
 * @file scripts/testing/report-ci-builds.mjs
 * 汇总已构建扩展的真实体积、最大脚本和重复资源，生成小型 JSON 证据与 Actions 摘要。
 * 复用现有 bundle 分析器；不构建、不联网、不更改产物或既有体积预算。
 */
import {execFileSync} from 'node:child_process';
import {appendFile, mkdir, readdir, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const analyzer = fileURLToPath(new URL('./analyze-bundle-size.mjs', import.meta.url));

async function largestScript(directory, current = directory) {
  let largest = null;
  for (const entry of await readdir(current, {withFileTypes: true})) {
    const absolute = path.join(current, entry.name);
    let candidate = null;
    if (entry.isDirectory()) candidate = await largestScript(directory, absolute);
    else if (entry.isFile() && /\.(?:js|mjs|cjs)$/u.test(entry.name)) {
      candidate = {path: path.relative(directory, absolute).split(path.sep).join('/'), bytes: (await stat(absolute)).size};
    }
    if (candidate && (!largest || candidate.bytes > largest.bytes
      || (candidate.bytes === largest.bytes && candidate.path < largest.path))) largest = candidate;
  }
  return largest;
}

function tableCell(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('|', '&#124;').replaceAll('`', '&#96;').replace(/[\r\n]/gu, ' ');
}

export async function reportCiBuilds(directories, {cwd = process.cwd(), summaryPath = process.env.GITHUB_STEP_SUMMARY} = {}) {
  if (!directories.length) throw new Error('Usage: node scripts/testing/report-ci-builds.mjs <extension-directory> [extension-directory ...]');
  const targets = new Set();
  const reports = [];
  for (const input of directories) {
    const absolute = path.resolve(cwd, input);
    const target = path.basename(absolute);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(target) || targets.has(target)) {
      throw new Error(`Invalid or duplicate build target: ${target}`);
    }
    targets.add(target);
    const {directory: _absoluteDirectory, ...analysis} = JSON.parse(execFileSync(process.execPath, [analyzer, absolute], {encoding: 'utf8'}));
    reports.push({target, ...analysis, totalMiB: Number((analysis.totalBytes / 1024 ** 2).toFixed(3)), largestScript: await largestScript(absolute)});
  }
  // 先完成全部测量，避免后续目标缺失时留下一组看似完整的报告。
  const output = path.join(cwd, 'reports/ci-builds');
  await mkdir(output, {recursive: true});
  for (const report of reports) await writeFile(path.join(output, `${report.target}.json`), JSON.stringify(report, null, 2) + '\n');
  if (summaryPath) {
    const rows = reports.map(report => {
      const script = report.largestScript ? `${tableCell(report.largestScript.path)} (${report.largestScript.bytes} bytes)` : '—';
      return `| ${report.target} | ${report.files} | ${report.totalBytes} | ${report.totalMiB.toFixed(3)} | ${script} |`;
    });
    await appendFile(summaryPath, [
      '\n## Extension build sizes\n',
      '| Target | Files | Actual bytes | MiB | Largest script |',
      '| --- | ---: | ---: | ---: | --- |', ...rows,
      '\nProduction builds retain the existing 65,000,000-byte budget in `wxt.config.ts`. This report does not change or replace that gate.\n',
    ].join('\n'));
  }
  return reports;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  reportCiBuilds(process.argv.slice(2)).then(reports => {
    console.log(JSON.stringify(reports.map(({target, files, totalBytes}) => ({target, files, totalBytes})), null, 2));
  }).catch(error => {
    console.error(`[ci-build-report] ${error.message}`);
    process.exitCode = 1;
  });
}
