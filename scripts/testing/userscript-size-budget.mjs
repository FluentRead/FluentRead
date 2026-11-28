/**
 * @file scripts/testing/userscript-size-budget.mjs
 * 文件职责：提供独立油猴脚本体积预算的加载、分层判定（ok/warn/fail）与显式基线刷新纯逻辑。
 * 主要内容：
 * - 读取并校验 `scripts/testing/userscript-size-budget.json` 的基线字节数、软告警增量与硬上限增量；
 * - 依据实际产物大小计算精确字节/kB 差值并输出分级结论，避免常规几 kB 文案/UI 改动反复打断 CI；
 * - 保留硬上限门禁拦截意外依赖、静态资源或模型膨胀，并提供显式基线更新工具。
 * 模块边界：仅负责体积预算配置读写与数值判定，不执行构建，也不替代元数据、许可或排除项断言。
 */

import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const DEFAULT_USERSCRIPT_SIZE_BUDGET_PATH = resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    'userscript-size-budget.json',
);

function assertNonNegativeInteger(value, field) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error(`Invalid userscript size budget field "${field}": expected a non-negative integer`);
    }
}

function formatSignedDelta(deltaBytes) {
    const sign = deltaBytes > 0 ? '+' : deltaBytes < 0 ? '-' : '';
    const absBytes = Math.abs(deltaBytes);
    const absKb = (absBytes / 1000).toFixed(2);
    return `${sign}${absBytes.toLocaleString('en-US')} bytes (${sign}${absKb} kB)`;
}

/** 校验并规范化预算对象。 */
export function validateUserscriptSizeBudget(budget) {
    if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
        throw new Error('Userscript size budget must be a JSON object');
    }
    assertNonNegativeInteger(budget.baselineBytes, 'baselineBytes');
    assertNonNegativeInteger(budget.softWarnDeltaBytes, 'softWarnDeltaBytes');
    assertNonNegativeInteger(budget.hardMaxDeltaBytes, 'hardMaxDeltaBytes');
    if (budget.softWarnDeltaBytes > budget.hardMaxDeltaBytes) {
        throw new Error('softWarnDeltaBytes must be less than or equal to hardMaxDeltaBytes');
    }
    return {
        baselineBytes: budget.baselineBytes,
        softWarnDeltaBytes: budget.softWarnDeltaBytes,
        hardMaxDeltaBytes: budget.hardMaxDeltaBytes,
        ...(typeof budget.updatedFromCommit === 'string' ? {updatedFromCommit: budget.updatedFromCommit} : {}),
        ...(typeof budget.notes === 'string' ? {notes: budget.notes} : {}),
    };
}

/** 从磁盘读取独立油猴脚本体积预算 JSON。 */
export function loadUserscriptSizeBudget(budgetPath = DEFAULT_USERSCRIPT_SIZE_BUDGET_PATH) {
    const raw = JSON.parse(readFileSync(budgetPath, 'utf8'));
    return validateUserscriptSizeBudget(raw);
}

/** 判定独立油猴脚本产物大小：<=软线 ok，软线..硬线 warn，>硬线 fail。 */
export function evaluateUserscriptStandaloneSize(bytes, budget) {
    assertNonNegativeInteger(bytes, 'bytes');
    const valid = validateUserscriptSizeBudget(budget);
    const deltaBytes = bytes - valid.baselineBytes;
    const softWarnBytes = valid.baselineBytes + valid.softWarnDeltaBytes;
    const hardMaxBytes = valid.baselineBytes + valid.hardMaxDeltaBytes;
    const deltaText = formatSignedDelta(deltaBytes);

    if (bytes > hardMaxBytes) {
        return {
            status: 'fail',
            bytes,
            baselineBytes: valid.baselineBytes,
            deltaBytes,
            softWarnBytes,
            hardMaxBytes,
            message: `[userscript-size] FAIL: Standalone userscript grew past hard limit ${hardMaxBytes.toLocaleString('en-US')} bytes: ${bytes.toLocaleString('en-US')} bytes (${deltaText} vs baseline ${valid.baselineBytes.toLocaleString('en-US')} bytes). Check for unexpected dependencies/assets, or refresh intentionally with --update-baseline.`,
        };
    }

    if (bytes > softWarnBytes) {
        return {
            status: 'warn',
            bytes,
            baselineBytes: valid.baselineBytes,
            deltaBytes,
            softWarnBytes,
            hardMaxBytes,
            message: `[userscript-size] WARN: Standalone userscript exceeded soft threshold ${softWarnBytes.toLocaleString('en-US')} bytes: ${bytes.toLocaleString('en-US')} bytes (${deltaText} vs baseline ${valid.baselineBytes.toLocaleString('en-US')} bytes; hard limit ${hardMaxBytes.toLocaleString('en-US')} bytes).`,
        };
    }

    return {
        status: 'ok',
        bytes,
        baselineBytes: valid.baselineBytes,
        deltaBytes,
        softWarnBytes,
        hardMaxBytes,
        message: `[userscript-size] OK: ${bytes.toLocaleString('en-US')} bytes (${deltaText} vs baseline ${valid.baselineBytes.toLocaleString('en-US')} bytes; soft ${softWarnBytes.toLocaleString('en-US')} / hard ${hardMaxBytes.toLocaleString('en-US')}).`,
    };
}

/** 显式刷新预算文件中的基线字节数（保留软/硬增量阈值与说明）。 */
export function updateUserscriptSizeBudget(budgetPath, newBaselineBytes, metadata = {}) {
    assertNonNegativeInteger(newBaselineBytes, 'newBaselineBytes');
    const existing = loadUserscriptSizeBudget(budgetPath);
    const updated = {
        ...existing,
        baselineBytes: newBaselineBytes,
        ...(typeof metadata.updatedFromCommit === 'string' && metadata.updatedFromCommit.trim()
            ? {updatedFromCommit: metadata.updatedFromCommit.trim()}
            : {}),
        ...(typeof metadata.notes === 'string' && metadata.notes.trim()
            ? {notes: metadata.notes.trim()}
            : {}),
    };
    writeFileSync(budgetPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
    return updated;
}
