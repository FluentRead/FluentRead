// 从固定 Unicode 17.0.0 Unihan_Variants.txt 提取单向专属字形；运行时不下载数据。
// 用法：node scripts/testing/generate-chinese-variants.mjs /path/to/Unihan_Variants.txt
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const input = readFileSync(process.argv[2], 'utf8');
if (!input.includes('# Unicode Version 17.0.0')) throw new Error('需要 Unicode 17.0.0 数据');
const variants = new Map();
for (const line of input.split('\n')) {
    const [code, property] = line.split('\t');
    if (!['kSimplifiedVariant', 'kTraditionalVariant'].includes(property)) continue;
    const properties = variants.get(code) ?? new Set();
    properties.add(property);
    variants.set(code, properties);
}
// 同时有两种属性的字可能在两种书写体系中均合法，不作为专属字形。
const characters = property => [...variants]
    .filter(([, properties]) => properties.size === 1 && properties.has(property))
    .map(([code]) => String.fromCodePoint(Number.parseInt(code.slice(2), 16))).join('');
const output = `/**
 * @file src/core/language/chineseVariants.ts
 * 文件职责：保存 Unicode 17.0.0 简繁专属汉字数据，补齐人工短表之外的冲突检测。
 * 主要内容：由 scripts/testing/generate-chinese-variants.mjs 从 Unihan_Variants.txt 生成；只收录单向变体属性，双向及共享字不作为证据。
 * 模块边界：仅导出静态字符数据，不转换原文、不检测语言、不请求网络；使用时必须另行确认中文语境。
 * 来源：https://www.unicode.org/Public/17.0.0/ucd/Unihan.zip
 * 原文件 SHA-256：${createHash('sha256').update(input).digest('hex')}
 * Copyright © 2025 Unicode, Inc. Unicode License V3，见 public/third-party-notices/unicode-17.0.0.txt。
 * 自动生成，请勿手工编辑。
 */

export const simplifiedOnlyCharacters = '${characters('kTraditionalVariant')}';
export const traditionalOnlyCharacters = '${characters('kSimplifiedVariant')}';
`;
writeFileSync(new URL('../../src/core/language/chineseVariants.ts', import.meta.url), output);
