const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRuntimeDiagnostics, finalizeRun, redact } = require('./runtime-diagnostics.cjs');

const extensionId = 'fixture-extension';
const extensionUrl = `chrome-extension://${extensionId}/content-scripts/content.js`;
const frame = url => ({ functionName: 'handler', url, lineNumber: 3, columnNumber: 17 });
const consoleEvent = (type, text, url = extensionUrl, executionContextId = 2) => ({
  type, args: [{ type: 'string', value: text }], timestamp: 12345, executionContextId,
  stackTrace: { callFrames: url ? [frame(url)] : [] },
});

class Session extends EventEmitter {
  async send(method) {
    if (method === 'Runtime.enable') {
      this.emit('Runtime.executionContextCreated', { context: { id: 1, origin: 'https://fixture.test', name: '', auxData: { isDefault: true } } });
      this.emit('Runtime.executionContextCreated', { context: { id: 2, origin: `chrome-extension://${extensionId}`, name: 'FluentRead', auxData: { isDefault: false } } });
    }
    return {};
  }
  async detach() { this.detached = true; }
}

class BrowserSession extends Session {
  constructor() { super(); this.attached = new Map(); this.commands = []; }
  async send(method, params) {
    this.commands.push({ method, params });
    if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'worker-1', type: 'service_worker', url: `chrome-extension://${extensionId}/background.js` }] };
    if (method === 'Target.attachToTarget') {
      assert.equal(params.flatten, false);
      const sessionId = `${params.targetId}-session`;
      this.attached.set(params.targetId, sessionId);
      return { sessionId };
    }
    if (method === 'Target.sendMessageToTarget') {
      assert.deepEqual(Object.keys(params).sort(), ['message', 'sessionId']);
      const request = JSON.parse(params.message);
      queueMicrotask(() => this.emit('Target.receivedMessageFromTarget', { sessionId: params.sessionId, message: JSON.stringify({ id: request.id, result: {} }) }));
    }
    if (method === 'Target.detachFromTarget') this.emit('Target.detachedFromTarget', { sessionId: params.sessionId });
    return {};
  }
  runtime(targetId, method, params) {
    this.emit('Target.receivedMessageFromTarget', { sessionId: this.attached.get(targetId), message: JSON.stringify({ method, params }) });
  }
}

async function fixture({ failPage = false, pageUrl = 'https://fixture.test/article' } = {}) {
  const pageSession = new Session();
  const browserSession = new BrowserSession();
  const page = { url: () => pageUrl };
  const context = new EventEmitter();
  context.pages = () => [page];
  context.newCDPSession = async () => { if (failPage) throw new Error('CDP attach refused'); return pageSession; };
  context.browser = () => ({ newBrowserCDPSession: async () => browserSession });
  const diagnostics = createRuntimeDiagnostics();
  await diagnostics.start(context);
  diagnostics.setExtensionId(extensionId);
  await diagnostics.attachPage(page, 'fixture-page');
  await diagnostics.flush();
  return { diagnostics, pageSession, browserSession, context };
}

test('isolated-world exceptions gate the run with source, stack and line evidence', async () => {
  const { diagnostics, pageSession } = await fixture();
  pageSession.emit('Runtime.exceptionThrown', { timestamp: 12345, exceptionDetails: {
    text: 'Uncaught', exception: { description: "TypeError: Cannot read properties of undefined (reading 'toLowerCase')" },
    executionContextId: 2, url: extensionUrl, lineNumber: 3, columnNumber: 17, stackTrace: { callFrames: [frame(extensionUrl)] },
  } });
  const report = diagnostics.snapshot();
  assert.equal(report.passed, false);
  assert.equal(report.entries[0].ownership, 'fluentread');
  assert.equal(report.entries[0].sourceUrl, extensionUrl);
  assert.equal(report.entries[0].line, 4);
  assert.equal(report.entries[0].surface, 'fixture-page');
  assert.match(report.entries[0].timestamp, /^\d{4}-/);
  assert.throws(() => diagnostics.assertClean(), /运行时诊断未通过/);
  await diagnostics.stop();
});

test('site errors remain in evidence, extension warnings and unattributed entries block', async () => {
  const { diagnostics, pageSession } = await fixture();
  pageSession.emit('Runtime.consoleAPICalled', consoleEvent('error', 'site-only failure', 'https://fixture.test/app.js', 1));
  assert.equal(diagnostics.snapshot().passed, true);
  assert.equal(diagnostics.snapshot().entries[0].ownership, 'site');
  pageSession.emit('Runtime.consoleAPICalled', consoleEvent('warning', 'extension warning'));
  assert.equal(diagnostics.snapshot().counts.warnings, 1);
  assert.equal(diagnostics.snapshot().passed, false);
  pageSession.emit('Runtime.consoleAPICalled', consoleEvent('error', 'unknown', '', 987));
  assert.equal(diagnostics.snapshot().entries[2].ownership, 'unattributed');
  assert.equal(diagnostics.snapshot().counts.errors, 1);
  await diagnostics.stop();
});

test('expected negative case is bounded by checkpoint, source, level and one occurrence', async () => {
  const { diagnostics, pageSession } = await fixture();
  const expected = 'Error: No active tab';
  pageSession.emit('Runtime.consoleAPICalled', consoleEvent('error', expected));
  const checkpoint = diagnostics.checkpoint();
  pageSession.emit('Runtime.consoleAPICalled', consoleEvent('warning', expected));
  pageSession.emit('Runtime.consoleAPICalled', consoleEvent('error', `${expected}\n    at handler`));
  pageSession.emit('Runtime.consoleAPICalled', consoleEvent('error', expected));
  pageSession.emit('Runtime.exceptionThrown', { exceptionDetails: { text: expected, executionContextId: 2, url: extensionUrl } });
  const count = diagnostics.expectSince(checkpoint, { caseId: 'fixture.negative', surface: 'fixture-page', exactMessages: [expected], level: 'error', maxCount: 1 });
  assert.equal(count, 1);
  const report = diagnostics.snapshot();
  assert.equal(report.counts.expected, 1);
  assert.equal(report.entries[0].expectedCase, undefined);
  assert.equal(report.entries[1].expectedCase, undefined);
  assert.equal(report.entries[2].expectedCase, 'fixture.negative');
  assert.equal(report.entries[3].expectedCase, undefined);
  assert.equal(report.entries[4].expectedCase, undefined);
  assert.equal(report.passed, false);
  await diagnostics.stop();
});

test('worker errors are captured after a destroyed worker is replaced', async () => {
  const { diagnostics, browserSession, context } = await fixture();
  assert.equal(diagnostics.snapshot().workerObserved, true);
  browserSession.emit('Target.targetDestroyed', { targetId: 'worker-1' });
  browserSession.emit('Target.detachedFromTarget', { sessionId: 'worker-1-session' });
  browserSession.emit('Target.targetCreated', { targetInfo: { targetId: 'worker-2', type: 'service_worker', url: `chrome-extension://${extensionId}/background.js` } });
  await diagnostics.flush();
  browserSession.runtime('worker-2', 'Runtime.consoleAPICalled', consoleEvent('error', 'worker restarted error', `chrome-extension://${extensionId}/background.js`));
  const report = diagnostics.snapshot();
  assert.equal(report.entries[0].targetType, 'service_worker');
  assert.equal(report.entries[0].ownership, 'fluentread');
  assert.equal(report.coverage.workers.filter(worker => worker.attached).length, 2);
  assert.equal(report.passed, false);
  await diagnostics.stop();
  assert.equal(context.listenerCount('page'), 0);
  assert.equal(browserSession.detached, true);
});

test('CDP attach failure fails clean verdict, and failure/expected evidence is saved', async () => {
  const { diagnostics } = await fixture({ failPage: true });
  assert.equal(diagnostics.snapshot().passed, false);
  assert.equal(diagnostics.snapshot().coverage.failures.length, 1);
  assert.equal(diagnostics.snapshot().completeCoverage, false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-diagnostics-unit-'));
  try {
    const result = { ok: false, error: 'test stopped' };
    diagnostics.write(dir, result);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')).error, 'test stopped');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'runtime-diagnostics.json'), 'utf8')).coverage.failures.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true });
    await diagnostics.stop();
  }
});

test('common credentials are redacted in runtime evidence', () => {
  const message = redact('Authorization: Bearer abc123 key?api_key=secret-value&token=sensitive-value {"apiKey":"credential-value"} sk-proj-abcdefgh123');
  assert.doesNotMatch(message, /abc123|secret-value|sensitive-value|credential-value|abcdefgh123/);
  assert.doesNotMatch(redact('{"stored":{"local:config":{"siliconCloudKey":"example-secret-value"}}}'), /example-secret-value/);
  assert.doesNotMatch(redact('{"password":"two word password"}'), /two|word password/);
});

test('browser Log warnings are collected and include phase, source and attribution', async () => {
  const { diagnostics, pageSession } = await fixture();
  diagnostics.setPhase('fixture.navigation');
  pageSession.emit('Log.entryAdded', { entry: { level: 'warning', source: 'javascript', text: 'Unchecked runtime.lastError: fixture failure', url: extensionUrl, timestamp: 54321 } });
  const report = diagnostics.snapshot();
  assert.equal(report.entries[0].type, 'browser-log');
  assert.equal(report.entries[0].phase, 'fixture.navigation');
  assert.equal(report.entries[0].ownership, 'fluentread');
  assert.equal(report.passed, false);
  assert.equal(report.coverage.pages[0].label, 'fixture-page');
  await diagnostics.stop();
});

test('report and detach failures cannot skip browser/server/profile cleanup or replace a primary test error', async () => {
  const calls = [];
  const primary = new Error('primary test assertion');
  const result = { ok: false, error: primary.message };
  const diagnostics = {
    flush: async () => calls.push('flush'),
    write: () => { calls.push('write'); throw new Error('disk full'); },
    stop: async () => { calls.push('stop'); throw new Error('CDP detach failed'); },
  };
  await finalizeRun({ diagnostics, result, artifactsDir: '/unused', primaryError: primary,
    cleanup: [
      { stage: 'browser-close', action: async () => { calls.push('browser'); throw new Error('browser close failed'); } },
      { stage: 'server-close', action: async () => calls.push('server') },
      { stage: 'profile-cleanup', action: async () => calls.push('profile') },
    ],
    emitReport: value => { calls.push('output'); assert.equal(value.error, primary.message); },
  });
  assert.deepEqual(calls, ['flush', 'write', 'stop', 'browser', 'server', 'profile', 'output']);
  assert.deepEqual(result.finalizationErrors.map(entry => entry.stage), ['diagnostics-write', 'diagnostics-stop', 'browser-close']);
});

test('new evidence-write failure is propagated after every cleanup action has run', async () => {
  const calls = [];
  const result = { ok: true };
  const diagnostics = { flush: async () => {}, assertClean: () => {}, write: () => { throw new Error('evidence directory denied'); }, stop: async () => calls.push('stop') };
  await assert.rejects(finalizeRun({ diagnostics, result, artifactsDir: '/unused', cleanup: [
    { stage: 'browser-close', action: async () => calls.push('browser') },
    { stage: 'profile-cleanup', action: async () => calls.push('profile') },
  ] }), /evidence directory denied/);
  assert.deepEqual(calls, ['stop', 'browser', 'profile']);
  assert.equal(result.ok, false);
});

test('network destination alone cannot prove site ownership; own initiator or page proves FluentRead', async () => {
  const { diagnostics, pageSession } = await fixture();
  const entry = { level: 'error', source: 'network', text: 'Failed to load resource', url: 'https://provider.test/translate', timestamp: 55555 };
  pageSession.emit('Log.entryAdded', { entry });
  pageSession.emit('Log.entryAdded', { entry: { ...entry, stackTrace: { callFrames: [frame(extensionUrl)] } } });
  assert.equal(diagnostics.snapshot().entries[0].ownership, 'unattributed');
  assert.equal(diagnostics.snapshot().entries[1].ownership, 'fluentread');
  assert.equal(diagnostics.snapshot().passed, false);
  await diagnostics.stop();
  const ownPage = await fixture({ pageUrl: `chrome-extension://${extensionId}/popup.html` });
  ownPage.pageSession.emit('Log.entryAdded', { entry });
  assert.equal(ownPage.diagnostics.snapshot().entries[0].ownership, 'fluentread');
  await ownPage.diagnostics.stop();
});

test('unproven dynamic UUID and other extension hosts block instead of being excluded as another extension', async () => {
  const { diagnostics, pageSession } = await fixture();
  for (const host of ['52a76114-8297-41ac-a823-b14e6ec200eb', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
    const resource = `chrome-extension://${host}/content-scripts/content.css`;
    pageSession.emit('Log.entryAdded', { entry: {
      level: 'error', source: 'security', text: `Unsafe attempt to load URL ${resource}`, url: resource, timestamp: 55555,
    } });
    // 浏览器安全日志也可能把所属网页记为 url，而把被拒绝的资源只放在消息正文。
    pageSession.emit('Log.entryAdded', { entry: {
      level: 'error', source: 'security', text: `Unsafe attempt to load URL ${resource} from frame with URL https://fixture.test/article. Domains, protocols and ports must match.`,
      url: 'https://fixture.test/article', timestamp: 55556,
    } });
  }
  const report = diagnostics.snapshot();
  assert.deepEqual(report.entries.map(entry => entry.ownership), Array(4).fill('unattributed'));
  assert.equal(report.counts.errors, 4);
  assert.equal(report.counts.site, 0);
  assert.equal(report.passed, false);
  assert.deepEqual(report.blockerIds, report.entries.map(entry => entry.id));
  assert.throws(() => diagnostics.assertClean(), /运行时诊断未通过/);
  await diagnostics.stop();
});

test('dynamic resource diagnostics retain own attribution when the execution context or initiator proves it', async () => {
  const { diagnostics, pageSession } = await fixture();
  const resource = 'chrome-extension://52a76114-8297-41ac-a823-b14e6ec200eb/icon/128.png';
  pageSession.emit('Runtime.consoleAPICalled', consoleEvent('warning', 'dynamic resource failed in own context', resource, 2));
  pageSession.emit('Runtime.executionContextCreated', { context: { id: 3, origin: '', name: 'FluentRead', auxData: { isDefault: false } } });
  pageSession.emit('Runtime.consoleAPICalled', consoleEvent('error', 'dynamic resource failed in named own isolated world', resource, 3));
  pageSession.emit('Log.entryAdded', { entry: {
    level: 'error', source: 'security', text: `Unsafe attempt to load URL ${resource}`, url: resource,
    stackTrace: { callFrames: [frame(extensionUrl)] }, timestamp: 55557,
  } });
  pageSession.emit('Runtime.consoleAPICalled', consoleEvent('warning', 'actual own content script still blocks', extensionUrl, 2));
  const report = diagnostics.snapshot();
  assert.deepEqual(report.entries.map(entry => entry.ownership), Array(4).fill('fluentread'));
  assert.equal(report.counts.errors, 2);
  assert.equal(report.counts.warnings, 2);
  assert.equal(report.passed, false);
  assert.deepEqual(report.blockerIds, report.entries.map(entry => entry.id));
  await diagnostics.stop();
});
