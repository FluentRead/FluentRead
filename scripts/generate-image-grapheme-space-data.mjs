/** Generate only the Unicode 17 properties needed at ASCII-space boundaries, without network access. */
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';

const input = new URL('../tests/fixtures/unicode-17.0.0/GraphemeBreakProperty.txt', import.meta.url);
const output = new URL('../src/features/image-translation/graphemeSpaceData.ts', import.meta.url);
const expectedHash = 'd6b51d1d2ae5c33b451b7ed994b48f1f4dc62b2272a5831e7fd418514a6bae89';
const raw = readFileSync(input);
if (createHash('sha256').update(raw).digest('hex') !== expectedHash) throw new Error('Unexpected Unicode 17 input');
const properties = new Map();
for (const line of raw.toString('utf8').split('\n')) {
    const match = /^([0-9A-F]+)(?:\.\.([0-9A-F]+))?\s*;\s*(\w+)/.exec(line);
    if (!match) continue;
    const [, first, last, property] = match;
    const ranges = properties.get(property) || [];
    ranges.push([Number.parseInt(first, 16), Number.parseInt(last || first, 16)]);
    properties.set(property, ranges);
}
function table(name, selected) {
    const merged = [];
    const ranges = selected.flatMap(property => properties.get(property)).sort((a, b) => a[0] - b[0]);
    for (const range of ranges) {
        const previous = merged.at(-1);
        if (previous && range[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], range[1]);
        else merged.push([...range]);
    }
    const rows = merged.map(([first, last]) => `0x${first.toString(16)}, 0x${last.toString(16)}`);
    const lines = [];
    for (let index = 0; index < rows.length; index += 4) lines.push('    ' + rows.slice(index, index + 4).join(', ') + ',');
    return `// GCB=${selected.join('|')}; ${merged.length} merged ranges.\nconst ${name}: readonly number[] = [\n${lines.join('\n')}\n];`;
}
const generated = `/**
 * @file src/features/image-translation/graphemeSpaceData.ts
 * 文件职责：为无 Intl.Segmenter 的图片排版提供固定 Unicode 17 的空格两侧字素阻断属性。
 * 主要内容：合并 Extend、SpacingMark、ZWJ 与 Prepend 的完整区间并二分查询，避免仅凭通用类别漏掉泰语/老挝语附着字符。
 * 模块边界：仅判断 U+0020 两侧属性，不实现完整 UAX29、不规范化正文，不依赖运行时网络或可变的宿主 Unicode 数据。
 * 数据来源：https://www.unicode.org/Public/17.0.0/ucd/auxiliary/GraphemeBreakProperty.txt
 * 原始 SHA-256：${expectedHash}
 * Copyright © 2025 Unicode, Inc.；Unicode License V3 见 public/third-party-notices/unicode-17.0.0.txt。
 * 由 scripts/generate-image-grapheme-space-data.mjs 离线生成，请勿手动编辑区间。
 */
${table('SPACE_EXTENSION', ['Extend', 'SpacingMark', 'ZWJ'])}

${table('SPACE_PREPEND', ['Prepend'])}

function includesPoint(ranges: readonly number[], point: number): boolean {
    let left = 0, right = ranges.length / 2 - 1;
    while (left <= right) {
        const middle = (left + right) >>> 1;
        if (point < ranges[middle * 2]) right = middle - 1;
        else if (point > ranges[middle * 2 + 1]) left = middle + 1;
        else return true;
    }
    return false;
}

/** 调用方传入文本中的真实码点；这些属性不允许在 ASCII 空格之后断开字素。 */
export function isSpaceGraphemeExtension(point: number): boolean {
    return includesPoint(SPACE_EXTENSION, point);
}

/** 调用方传入文本中的真实码点；Prepend 不允许在 ASCII 空格之前断开字素。 */
export function isSpaceGraphemePrepend(point: number): boolean {
    return includesPoint(SPACE_PREPEND, point);
}
`;
if (process.argv.includes('--check')) {
    if (readFileSync(output, 'utf8') !== generated) throw new Error('Generated grapheme-space data is out of date');
    console.log('Unicode 17 grapheme-space data matches the pinned offline source.');
} else {
    writeFileSync(output, generated);
    console.log('Generated Unicode 17 grapheme-space data.');
}
