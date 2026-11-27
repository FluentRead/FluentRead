const test = require('node:test');
const assert = require('node:assert/strict');
const {browserReport} = require('./report-summary.cjs');

test('large diagnostic evidence stays in files while blockers, counts and coverage remain visible', () => {
  const entries = Array.from({length: 100}, (_, index) => ({id: index, level: 'warning', message: `warning ${index} ${'detail '.repeat(300)}`, ownership: 'fluentread'}));
  const result = {ok: false, error: 'Failure', runtimeDiagnostics: {entries, blockerIds: entries.map(item => item.id), counts: {errors: 0, warnings: 100, expected: 2, site: 9}, passed: false, workerObserved: true, completeCoverage: false, coverageScope: 'declared scope', coverage: {failures: [{reason: 'attachment missing'}]}}};
  const report = browserReport(result, '/private/tmp/fluentread-report-fixture');
  assert.equal(report.ok, false);
  assert.equal(report.blockerCount, 100);
  assert.equal(report.blockers.length, 5);
  assert.equal(report.runtime.counts.warnings, 100);
  assert.equal(report.runtime.coverageFailures, 1);
  assert.equal(report.runtime.completeCoverage, false);
  assert.equal(report.evidence.result.exists, false);
  assert.match(report.evidence.result.path, /result\.json$/);
  assert.ok(JSON.stringify(report).length < JSON.stringify(result).length / 20);
  assert.equal(result.runtimeDiagnostics.entries.length, 100);
  assert.equal(browserReport(result, '/private/tmp', 'json'), result);
});

test('missing diagnostics stay unknown, finalization failures are visible, and invalid formats fail', () => {
  const report = browserReport({ok: false, finalizationErrors: [{stage: 'evidence-write', message: 'denied'}]}, '/private/tmp');
  assert.equal(report.runtime, null);
  assert.equal(report.finalizationErrorCount, 1);
  assert.deepEqual(report.finalizationErrors, [{stage: 'evidence-write', message: 'denied'}]);
  assert.throws(() => browserReport({}, '/private/tmp', 'verbose'), /report-format/);
});


test('runner rejects unsupported report format before starting a browser', () => {
  const {spawnSync} = require('node:child_process');
  const result = spawnSync(process.execPath, [require('node:path').join(__dirname, 'run-ui-test.cjs'), '--report-format', 'unsupported'], {encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /report-format/);
});


test('UI runner requires an explicit suite instead of defaulting to a full regression', () => {
  const {spawnSync} = require('node:child_process');
  const result = spawnSync(process.execPath, [require('node:path').join(__dirname, 'run-ui-test.cjs'), '--extension-dir', '/unused'], {encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--suite/);
});
