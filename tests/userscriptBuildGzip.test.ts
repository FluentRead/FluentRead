/**
 * @file tests/userscriptBuildGzip.test.ts
 * 文件职责：验证构建期 gzip 候选选择保持输入字节和标准解压语义。
 * 主要内容：覆盖空输入、二进制与可重复目录，验证 memLevel 5 更短时采用、平局稳定及输出不劣于既有三候选。
 * 模块边界：只运行锁定 pako 的有限压缩，不修改运行时解码器、资源内容或大小门禁。
 */
import {describe, expect, it} from 'vitest';
import {createRequire} from 'node:module';
import {gzipUserscriptBuildData} from '../userscript/buildGzip';
const {gzip, ungzip} = createRequire(import.meta.url)('pako');
const catalog = Buffer.from(JSON.stringify(Object.fromEntries(Array.from({length: 700}, (_, i) => [
    'item.' + i.toString(36),
    'This is a reusable translation message for document ' + (i % 73) + ' with setting ' + (i % 19)
        + ' and reason ' + (i % 113) + '。当前设置包含安全验证与资源恢复。',
]))));

describe('deterministic userscript gzip budget', () => {
    it.each([{name: 'empty', data: Buffer.alloc(0)}, {name: 'short', data: Buffer.from('short input')},
        {name: 'binary', data: Buffer.from(Array.from({length: 4096}, (_, i) => i % 256))}, {name: 'catalog', data: catalog}])(
        '$name round-trips data and chooses the first shortest supported encoding', ({data}) => {
            const original = Buffer.from(data);
            const choices = [8, 7, 9, 5].map(memLevel => Buffer.from(gzip(data, {level: 9, memLevel})));
            const expected = choices.reduce((best, candidate) => candidate.length < best.length ? candidate : best);
            const actual = gzipUserscriptBuildData(data);
            expect(actual).toEqual(expected);
            expect(Buffer.from(ungzip(actual))).toEqual(original);
            expect(data).toEqual(original);
            expect(gzipUserscriptBuildData(data)).toEqual(actual);
        });
    it('selects memLevel 5 for a representative repeated catalog rather than raising the output cap', () => {
        const oldSize = Math.min(...[8, 7, 9].map(memLevel => gzip(catalog, {level: 9, memLevel}).length));
        const candidate = Buffer.from(gzip(catalog, {level: 9, memLevel: 5}));
        expect(candidate.length).toBeLessThan(oldSize);
        expect(gzipUserscriptBuildData(catalog)).toEqual(candidate);
    });
});
