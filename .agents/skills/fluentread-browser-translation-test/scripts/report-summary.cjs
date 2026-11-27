const path = require('node:path');
const fs = require('node:fs');
const {redact} = require('./runtime-diagnostics.cjs');

// 完整证据由 finalizeRun 写盘；这里仅改变标准输出，不影响断言、诊断或退出码。
function browserReport(result, artifactsDir, format = 'summary') {
  if (!['summary', 'json'].includes(format)) throw new Error('--report-format 只能使用 summary 或 json');
  if (format === 'json') return result;
  const diagnostics = result.runtimeDiagnostics;
  const entries = diagnostics?.entries ?? [];
  const blockers = new Set(diagnostics?.blockerIds ?? []);
  const findings = entries.filter(entry => blockers.has(entry.id));
  const file = name => {const filename = path.resolve(artifactsDir, name);return {path: filename, exists: fs.existsSync(filename)};};
  return {
    ok: result.ok === true,
    ...(result.suite !== undefined ? {suite: result.suite} : {}),
    launchMode: result.launchMode ?? null,
    focusPolicy: result.focusPolicy ?? null,
    windowPlacement: result.windowPlacement ?? null,
    ...(result.error ? {error: redact(String(result.error)).slice(0, 800)} : {}),
    runtime: diagnostics ? {
      counts: diagnostics.counts,
      passed: diagnostics.passed,
      workerObserved: diagnostics.workerObserved,
      completeCoverage: diagnostics.completeCoverage,
      coverageScope: diagnostics.coverageScope,
      coverageFailures: diagnostics.coverage?.failures?.length ?? 0,
    } : null,
    blockerCount: findings.length,
    blockers: findings.slice(0, 5).map(entry => ({id: entry.id, level: entry.level, message: redact(String(entry.message)).slice(0, 400), ownership: entry.ownership})),
    finalizationErrorCount: result.finalizationErrors?.length ?? 0,
    finalizationErrors: (result.finalizationErrors ?? []).slice(0, 3).map(entry => ({stage: entry.stage, message: redact(String(entry.message)).slice(0, 400)})),
    evidence: {result: file('result.json'), diagnostics: file('runtime-diagnostics.json')},
  };
}
module.exports = {browserReport};
