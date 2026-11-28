/**
 * @file tests/checkStagedFast.test.ts
 * 文件职责：验证极速提交前检查器 check-staged-fast 的源码文件头校验、测试禁令与矩阵登记校验、废弃目录拦截和 UI 裸色提示。
 * 主要内容：覆盖合法与违规的 TS/Vue 文件头（缺失首行注释、错配 @file、长度不足、含 TODO 占位）、.only 与无说明 .skip 拦截、带说明 .skip 放行、未登记 test-matrix 报错、entrypoints/utils 阻断、UI 裸 hex 非阻断警告与 tokens.css 豁免。
 * 模块边界：仅使用内存样本与临时目录，不修改真实 Git 暂存区或仓库文件。
 */
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
    checkFiles,
    checkRawHexColors,
    checkSourceHeader,
    checkTestFile,
    parseArguments,
} from '../scripts/testing/check-staged-fast.mjs';

const VALID_TS_HEADER = [
    '/**',
    ' * @file src/core/sample.ts',
    ' * 文件职责：提供示例核心逻辑与输入规范化校验能力，确保跨模块调用行为稳定一致。',
    ' * 主要内容：解析外部配置对象、归一化默认字段并输出不可变数据结构供下游消费。',
    ' * 模块边界：纯 TypeScript 逻辑，不依赖浏览器扩展 API、DOM 或网络传输层。',
    ' */',
    'export const sample = 1;',
].join('\n');

const VALID_VUE_HEADER = [
    '<!--',
    '  @file src/ui/SampleCard.vue',
    '  文件职责：渲染通用示例状态卡片，展示标题、描述文本与交互操作区域及状态提示。',
    '  主要内容：接收标准化的只读 props 并在语义化容器中渲染卡片内容与状态徽章。',
    '  模块边界：纯 UI 展示组件，不直接读写持久化配置或发起后台网络请求。',
    '-->',
    '<template><div class="card">ok</div></template>',
    '<style scoped>',
    '.card { color: #ff00aa; --fr-local: #112233; }',
    '</style>',
].join('\n');

describe('check-staged-fast rules', () => {
    it('parses CLI arguments cleanly', () => {
        expect(parseArguments([])).toMatchObject({files: null, json: false, help: false});
        expect(parseArguments(['--files', 'src/a.ts,./tests/a.test.ts', '--json'])).toMatchObject({
            files: ['src/a.ts', 'tests/a.test.ts'],
            json: true,
        });
        expect(() => parseArguments(['--files'])).toThrow('--files 缺少值');
        expect(() => parseArguments(['--nope'])).toThrow('未知参数');
    });

    it('validates src file headers using sourceFileHeaders rules', () => {
        expect(checkSourceHeader('src/core/sample.ts', VALID_TS_HEADER)).toEqual([]);
        expect(checkSourceHeader('src/ui/SampleCard.vue', VALID_VUE_HEADER)).toEqual([]);

        const missingHeader = checkSourceHeader('src/core/sample.ts', 'export const x = 1;');
        expect(missingHeader).toEqual([expect.stringContaining('必须从第一个字符开始')]);

        const badHeader = checkSourceHeader('src/core/sample.ts', [
            '/**',
            ' * @file src/core/wrong.ts',
            ' * 文件职责：TODO',
            ' * 主要内容：short',
            ' * 模块边界：none',
            ' */',
        ].join('\n'));
        expect(badHeader.some(item => item.includes('@file src/core/sample.ts'))).toBe(true);
        expect(badHeader.some(item => item.includes('长度不足 12'))).toBe(true);
        expect(badHeader.some(item => item.includes('总长度'))).toBe(true);
        expect(badHeader.some(item => item.includes('占位词'))).toBe(true);
    });

    it('blocks .only, unexplained .skip, coverage-ignore directives, and unregistered tests while allowing explained .skip', () => {
        const matrix = new Set(['tests/ok.test.ts']);
        expect(checkTestFile('tests/ok.test.ts', "it('works', () => {});", matrix)).toEqual([]);

        const explainedSkip = "// skip: 等待上游修复\nit.skip('pending', () => {});";
        expect(checkTestFile('tests/ok.test.ts', explainedSkip, matrix)).toEqual([]);

        const directive = ['/*', 'v8', 'ignore', 'next', '*/'].join(' ');
        const violations = checkTestFile(
            'tests/unregistered.test.ts',
            `${directive}\ndescribe.only('x', () => {\n  it.skip('no reason', () => {});\n});`,
            matrix,
        );
        expect(violations.some(item => item.includes('覆盖率忽略'))).toBe(true);
        expect(violations.some(item => item.includes('describe.only'))).toBe(true);
        expect(violations.some(item => item.includes('it.skip 缺少'))).toBe(true);
        expect(violations.some(item => item.includes('未登记在 tests/test-matrix.json'))).toBe(true);
    });

    it('emits non-blocking warnings for raw hex colors in UI styles while exempting tokens.css and CSS vars', () => {
        expect(checkRawHexColors('src/ui/styles/tokens.css', ':root { --fr-brand: #e11d48; color: #fff; }')).toEqual([]);
        expect(checkRawHexColors('src/ui/SampleCard.vue', VALID_VUE_HEADER)).toEqual([
            expect.stringContaining('#ff00aa'),
        ]);
        expect(checkRawHexColors('src/ui/SampleCard.vue', VALID_VUE_HEADER)[0]).not.toContain('#112233');
        expect(checkRawHexColors('src/features/settings/ui/Panel.css', '.panel { background: var(--fr-color-surface); }')).toEqual([]);
    });
});

describe('check-staged-fast directory orchestration', () => {
    const tempDirs: string[] = [];
    const makeTempRepo = (files: Record<string, string>) => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'fluentread-staged-fast-'));
        tempDirs.push(dir);
        for (const [rel, content] of Object.entries(files)) {
            const abs = path.join(dir, rel);
            mkdirSync(path.dirname(abs), {recursive: true});
            writeFileSync(abs, content, 'utf8');
        }
        return dir;
    };

    afterEach(() => {
        for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
    });

    it('forbids entrypoints/utils/ paths and aggregates errors vs non-blocking UI warnings', () => {
        const root = makeTempRepo({
            'tests/test-matrix.json': JSON.stringify({groups: {unit: ['tests/sample.test.ts']}}),
            'src/core/sample.ts': VALID_TS_HEADER,
            'src/ui/SampleCard.vue': VALID_VUE_HEADER,
            'tests/sample.test.ts': "it('ok', () => {});",
            'entrypoints/utils/legacy.ts': 'export const legacy = true;',
        });

        const cleanResult = checkFiles(root, ['src/core/sample.ts', 'src/ui/SampleCard.vue', 'tests/sample.test.ts']);
        expect(cleanResult.status).toBe('passed');
        expect(cleanResult.errors).toEqual([]);
        expect(cleanResult.warnings).toHaveLength(1);
        expect(cleanResult.warnings[0]).toContain('#ff00aa');

        const blockedResult = checkFiles(root, ['entrypoints/utils/legacy.ts']);
        expect(blockedResult.status).toBe('failed');
        expect(blockedResult.errors).toEqual([expect.stringContaining('entrypoints/utils/')]);
    });
});
