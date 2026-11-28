/**
 * @file tests/verifyUserscriptStandaloneBudget.test.ts
 * 文件职责：验证独立油猴脚本体积预算配置、软告警/硬上限分层判定与校验脚本的契约保留。
 * 主要内容：覆盖预算 JSON 校验、ok/warn/fail 精确边界、显式基线刷新以及独立脚本断言与体积门禁联动行为。
 * 模块边界：仅使用内存数据与临时目录夹具，不执行真实油猴打包，也不修改仓库内正式预算文件。
 */
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
    DEFAULT_USERSCRIPT_SIZE_BUDGET_PATH,
    evaluateUserscriptStandaloneSize,
    loadUserscriptSizeBudget,
    updateUserscriptSizeBudget,
    validateUserscriptSizeBudget,
} from '../scripts/testing/userscript-size-budget.mjs';
import {verifyUserscriptStandaloneBuild} from '../scripts/verify-userscript-standalone-build.mjs';

const PROJECT_ROOT = resolve(__dirname, '..');
const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function buildValidStandaloneFixture(targetBytes: number, extraChunk = ''): string {
    const {userscriptVersion} = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'package.json'), 'utf8')) as {userscriptVersion: string};
    const {version: vueVersion} = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'node_modules/vue/package.json'), 'utf8')) as {version: string};
    const {version: elementPlusVersion} = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'node_modules/element-plus/package.json'), 'utf8')) as {version: string};
    const base = [
        '// ==UserScript==',
        `// @version      ${userscriptVersion}`,
        '// @inject-into  content',
        '// @grant        GM.xmlHttpRequest',
        '// @grant        GM_xmlhttpRequest',
        '// @grant        GM.openInTab',
        '// @grant        GM_openInTab',
        '// ==/UserScript==',
        'const route = "fluentread-userscript-settings";',
        'const capability = "__FLUENTREAD_BROWSER_CAPABILITY_BUILD__:userscript:mv2__";',
        '/* pako 2.1.0 — MIT */',
        `/* @vue/runtime-dom ${vueVersion} — MIT */`,
        `/* element-plus ${elementPlusVersion} — MIT */`,
        extraChunk,
    ].join('\n');
    const padLength = Math.max(0, targetBytes - Buffer.byteLength(base));
    return base + 'a'.repeat(padLength);
}

afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop()!, {recursive: true, force: true});
    }
});

describe('userscript standalone size budget', () => {
    it('仓库内置预算 JSON 保持预期的基线与软/硬增量阈值', () => {
        const budget = loadUserscriptSizeBudget(DEFAULT_USERSCRIPT_SIZE_BUDGET_PATH);
        expect(budget.baselineBytes).toBe(3_827_157);
        expect(budget.softWarnDeltaBytes).toBe(20_000);
        expect(budget.hardMaxDeltaBytes).toBe(64_000);
    });

    it('按基线、+20 kB 软线与 +64 kB 硬上限精确返回 ok / warn / fail', () => {
        const budget = {
            baselineBytes: 3_756_047,
            softWarnDeltaBytes: 20_000,
            hardMaxDeltaBytes: 64_000,
        };

        const below = evaluateUserscriptStandaloneSize(3_750_000, budget);
        expect(below.status).toBe('ok');
        expect(below.deltaBytes).toBe(-6_047);
        expect(below.softWarnBytes).toBe(3_776_047);
        expect(below.hardMaxBytes).toBe(3_820_047);

        const atSoft = evaluateUserscriptStandaloneSize(3_776_047, budget);
        expect(atSoft.status).toBe('ok');
        expect(atSoft.deltaBytes).toBe(20_000);

        const overSoft = evaluateUserscriptStandaloneSize(3_776_048, budget);
        expect(overSoft.status).toBe('warn');
        expect(overSoft.deltaBytes).toBe(20_001);
        expect(overSoft.message).toContain('[userscript-size] WARN');
        expect(overSoft.message).toContain('+20,001 bytes (+20.00 kB)');

        const atHard = evaluateUserscriptStandaloneSize(3_820_047, budget);
        expect(atHard.status).toBe('warn');
        expect(atHard.deltaBytes).toBe(64_000);

        const overHard = evaluateUserscriptStandaloneSize(3_820_048, budget);
        expect(overHard.status).toBe('fail');
        expect(overHard.deltaBytes).toBe(64_001);
        expect(overHard.message).toContain('[userscript-size] FAIL');
        expect(overHard.message).toContain('+64,001 bytes (+64.00 kB)');
    });

    it('拒绝非法的预算配置与非法字节数', () => {
        expect(() => validateUserscriptSizeBudget(null)).toThrow(/JSON object/u);
        expect(() => validateUserscriptSizeBudget({
            baselineBytes: 1000,
            softWarnDeltaBytes: 500,
            hardMaxDeltaBytes: 200,
        })).toThrow(/softWarnDeltaBytes/u);
        expect(() => evaluateUserscriptStandaloneSize(-1, {
            baselineBytes: 1000,
            softWarnDeltaBytes: 100,
            hardMaxDeltaBytes: 200,
        })).toThrow(/non-negative integer/u);
    });

    it('显式刷新基线时保留软/硬阈值与说明字段', () => {
        const dir = createTempDir('fluentread-budget-update-');
        const budgetPath = join(dir, 'budget.json');
        writeFileSync(budgetPath, JSON.stringify({
            baselineBytes: 100_000,
            softWarnDeltaBytes: 20_000,
            hardMaxDeltaBytes: 64_000,
            updatedFromCommit: 'old1234',
            notes: 'keep me',
        }, null, 2));

        const updated = updateUserscriptSizeBudget(budgetPath, 108_500, {updatedFromCommit: 'new5678'});
        expect(updated.baselineBytes).toBe(108_500);
        expect(updated.softWarnDeltaBytes).toBe(20_000);
        expect(updated.hardMaxDeltaBytes).toBe(64_000);
        expect(updated.updatedFromCommit).toBe('new5678');
        expect(updated.notes).toBe('keep me');

        const reloaded = loadUserscriptSizeBudget(budgetPath);
        expect(reloaded).toEqual(updated);
    });

    it('校验脚本在软线内通过、软硬之间告警不失败、超硬线失败，并严格保留协议与排除断言', () => {
        const dir = createTempDir('fluentread-standalone-verify-');
        const budgetPath = join(dir, 'budget.json');
        const artifactPath = join(dir, 'fluent-read.user.js');
        writeFileSync(budgetPath, JSON.stringify({
            baselineBytes: 2_000,
            softWarnDeltaBytes: 500,
            hardMaxDeltaBytes: 1_500,
        }, null, 2));

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // 1. 软线内：通过且无告警
        writeFileSync(artifactPath, buildValidStandaloneFixture(2_300), 'utf8');
        const okResult = verifyUserscriptStandaloneBuild(['--artifact', artifactPath, '--budget', budgetPath]);
        expect(okResult.status).toBe('ok');
        expect(warnSpy).not.toHaveBeenCalled();

        // 2. 软线与硬线之间：输出 WARN 但不抛错
        writeFileSync(artifactPath, buildValidStandaloneFixture(2_900), 'utf8');
        const warnResult = verifyUserscriptStandaloneBuild(['--artifact', artifactPath, '--budget', budgetPath]);
        expect(warnResult.status).toBe('warn');
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[userscript-size] WARN'));

        // 3. 超出硬上限：抛错阻断
        writeFileSync(artifactPath, buildValidStandaloneFixture(3_600), 'utf8');
        expect(() => verifyUserscriptStandaloneBuild(['--artifact', artifactPath, '--budget', budgetPath]))
            .toThrow(/\[userscript-size\] FAIL/u);

        // 4. 即使体积很小，协议/排除项断言仍然严格生效
        writeFileSync(artifactPath, buildValidStandaloneFixture(1_000, 'const bad = "fluent-read-writing-assistant";'), 'utf8');
        expect(() => verifyUserscriptStandaloneBuild(['--artifact', artifactPath, '--budget', budgetPath]))
            .toThrow(/Writing assistant runtime must be excluded/u);

        // 5. --update-baseline 在断言通过后刷新基线
        writeFileSync(artifactPath, buildValidStandaloneFixture(2_800), 'utf8');
        verifyUserscriptStandaloneBuild(['--artifact', artifactPath, '--budget', budgetPath, '--update-baseline', '--commit', 'abc1234']);
        expect(loadUserscriptSizeBudget(budgetPath).baselineBytes).toBe(2_800);
        expect(loadUserscriptSizeBudget(budgetPath).updatedFromCommit).toBe('abc1234');
        expect(logSpy).toHaveBeenCalled();
    });
});
