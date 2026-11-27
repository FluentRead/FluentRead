const fs = require('node:fs');
const path = require('node:path');

// Chromium 内容脚本运行在隔离世界，不能只依赖 Playwright 的 pageerror。
// 此采集器在导航前启用 Runtime；后台通过 Target 协议监听重建后的 worker。
function redact(value) {
  return String(value ?? '')
    .replace(/(["'](?:[^"']*(?:key|token|secret|password|authorization)[^"']*)["']\s*:\s*)(["'])(?:\\.|(?!\2)[^\\])*?\2/gi, '$1"[REDACTED]"')
    .replace(/\b(Bearer\s+)[\w.+/=-]+/gi, '$1[REDACTED]')
    .replace(/\b(sk-(?:proj-)?)[A-Za-z0-9_-]{8,}/g, '$1[REDACTED]')
    .replace(/([?&](?:key|api_key|apikey|token|access_token|secret)=)[^&#\s]*/gi, '$1[REDACTED]')
    .replace(/(["']?(?:apiKey|api_key|accessToken|access_token|authorization|password|secret)["']?\s*[:=]\s*["']?)[^\s,"'}/]+/gi, '$1[REDACTED]');
}

function stackFrames(stack) {
  return [...(stack?.callFrames || []), ...(stack?.parent ? stackFrames(stack.parent) : [])]
    .map(frame => ({ functionName: frame.functionName || '', url: redact(frame.url), line: (frame.lineNumber ?? -1) + 1, column: (frame.columnNumber ?? -1) + 1 }));
}

function remoteText(argument) {
  if (argument.value !== undefined) return typeof argument.value === 'string' ? argument.value : JSON.stringify(argument.value);
  return argument.description || argument.unserializableValue || argument.type || '';
}

function createRuntimeDiagnostics() {
  const entries = [];
  const coverage = { pages: [], workers: [], failures: [], limitations: [
    '采集从连接隔离浏览器后开始；连接前的首次后台启动异常和扩展管理页历史记录无法追溯。',
    '浏览器 API 自动打开的页面在 page 事件后立即附加；其附加前日志不能保证完整。',
    '未启用跨进程 iframe 子 target 的自动附加；相关测试需要另行检查其控制台。',
    '后台启动或重启后，从发现 target 到 Runtime.enable 生效之间存在附加空窗；未输出到 Runtime/Log 的 API 失败不会自动变成日志。',
  ] };
  const pages = new WeakMap();
  const pageStates = [];
  const pending = new Set();
  const workerSessions = new Map();
  const attachingWorkers = new Map();
  const destroyedWorkers = new Set();
  let extensionId;
  let browserSession;
  let context;
  let closing = false;
  let sequence = 0;
  let commandId = 0;
  let pageListener;
  let phase = 'bootstrap';

  const track = promise => {
    pending.add(promise);
    promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  };
  const coverageFailure = (surface, error) => {
    if (!closing) coverage.failures.push({ surface, message: redact(error.message || error), timestamp: new Date().toISOString() });
  };

  function add(entry) {
    entries.push({ id: ++sequence, timestamp: new Date().toISOString(), phase, ...entry });
  }

  function handleRuntime(state, method, params) {
    if (method === 'Log.entryAdded') {
      const entry = params.entry;
      if (!['warning', 'error'].includes(entry.level)) return;
      const stack = stackFrames(entry.stackTrace);
      add({ surface: state.label, targetType: state.targetType, type: 'browser-log', level: entry.level,
        message: redact(entry.text), sourceUrl: redact(entry.url || stack[0]?.url || ''), stack,
        browserSource: entry.source, contextOrigin: '', contextName: '', targetUrl: redact(state.url()), protocolTimestamp: entry.timestamp });
      return;
    }
    if (method === 'Runtime.executionContextCreated') {
      state.contexts.set(params.context.id, params.context);
      return;
    }
    if (method === 'Runtime.executionContextDestroyed') {
      state.contexts.delete(params.executionContextId);
      return;
    }
    if (method === 'Runtime.executionContextsCleared') {
      state.contexts.clear();
      return;
    }
    if (method === 'Runtime.consoleAPICalled') {
      if (!['warning', 'error', 'assert'].includes(params.type)) return;
      const executionContext = state.contexts.get(params.executionContextId);
      const stack = stackFrames(params.stackTrace);
      add({ surface: state.label, targetType: state.targetType, type: 'console', level: params.type === 'warning' ? 'warning' : 'error',
        message: redact((params.args || []).map(remoteText).join(' ')), sourceUrl: stack[0]?.url || '', stack,
        contextOrigin: redact(executionContext?.origin || ''), contextName: redact(executionContext?.name || ''),
        contextIsDefault: executionContext?.auxData?.isDefault, targetUrl: redact(state.url()), protocolTimestamp: params.timestamp });
      return;
    }
    if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails;
      const executionContext = state.contexts.get(details.executionContextId);
      const stack = stackFrames(details.stackTrace);
      add({ surface: state.label, targetType: state.targetType, type: 'exception', level: 'error',
        message: redact(details.exception?.description || details.text), sourceUrl: redact(details.url || stack[0]?.url || ''), stack,
        line: (details.lineNumber ?? -1) + 1, column: (details.columnNumber ?? -1) + 1,
        contextOrigin: redact(executionContext?.origin || ''), contextName: redact(executionContext?.name || ''),
        contextIsDefault: executionContext?.auxData?.isDefault, targetUrl: redact(state.url()), protocolTimestamp: params.timestamp });
    }
  }

  async function attachPage(page, label = 'auto-page') {
    if (pages.has(page)) {
      const state = pages.get(page);
      if (label !== 'auto-page') state.label = label;
      if (state.coverageItem) state.coverageItem.label = state.label;
      return state.ready;
    }
    const state = { label, targetType: 'page', contexts: new Map(), url: () => page.url() };
    pages.set(page, state);
    pageStates.push(state);
    const item = { label, status: 'attaching' };
    state.coverageItem = item;
    coverage.pages.push(item);
    state.ready = track((async () => {
      try {
        const session = await context.newCDPSession(page);
        state.session = session;
        for (const method of ['Runtime.executionContextCreated', 'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared', 'Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded']) {
          session.on(method, params => handleRuntime(state, method, params));
        }
        await session.send('Runtime.enable');
        await session.send('Log.enable');
        item.label = state.label;
        item.status = 'listening';
      } catch (error) {
        item.status = 'failed';
        coverageFailure(state.label, error);
      }
    })());
    return state.ready;
  }

  function sendWorker(sessionId, method) {
    const state = workerSessions.get(sessionId);
    const id = ++commandId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.commands.delete(id);
        reject(new Error(`后台诊断命令超时：${method}`));
      }, 5000);
      state.commands.set(id, { resolve, reject, timer });
      browserSession.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method }) }).catch(error => {
        clearTimeout(timer);
        state.commands.delete(id);
        reject(error);
      });
    });
  }

  async function attachWorker(info) {
    if (info.type !== 'service_worker' || !info.url.startsWith('chrome-extension://') || attachingWorkers.has(info.targetId)) return;
    const item = { targetId: info.targetId, url: redact(info.url), status: 'attaching' };
    coverage.workers.push(item);
    const operation = track((async () => {
      try {
        const { sessionId } = await browserSession.send('Target.attachToTarget', { targetId: info.targetId, flatten: false });
        const state = { label: 'service-worker', targetType: 'service_worker', contexts: new Map(), url: () => info.url, commands: new Map(), item };
        workerSessions.set(sessionId, state);
        await sendWorker(sessionId, 'Runtime.enable');
        item.status = 'listening';
        item.attached = true;
        try {
          await sendWorker(sessionId, 'Log.enable');
          item.logStatus = 'listening';
        } catch (error) {
          item.logStatus = 'unavailable';
          item.logLimitation = redact(error.message);
        }
      } catch (error) {
        item.status = destroyedWorkers.has(info.targetId) ? 'closed-before-attach' : 'failed';
        if (item.status === 'failed') coverageFailure('service-worker', error);
      }
    })());
    attachingWorkers.set(info.targetId, operation);
    return operation;
  }

  async function start(browserContext) {
    context = browserContext;
    pageListener = page => { attachPage(page).catch(error => coverageFailure('auto-page', error)); };
    context.on('page', pageListener);
    await Promise.all(context.pages().map(page => attachPage(page)));
    try {
      browserSession = await context.browser().newBrowserCDPSession();
      browserSession.on('Target.receivedMessageFromTarget', event => {
        const state = workerSessions.get(event.sessionId);
        if (!state) return;
        const message = JSON.parse(event.message);
        if (message.id) {
          const command = state.commands.get(message.id);
          if (!command) return;
          state.commands.delete(message.id);
          clearTimeout(command.timer);
          if (message.error) command.reject(new Error(message.error.message));
          else command.resolve(message.result);
        } else handleRuntime(state, message.method, message.params || {});
      });
      browserSession.on('Target.targetCreated', ({ targetInfo }) => { attachWorker(targetInfo).catch(error => coverageFailure('service-worker', error)); });
      browserSession.on('Target.targetInfoChanged', ({ targetInfo }) => { attachWorker(targetInfo).catch(error => coverageFailure('service-worker', error)); });
      browserSession.on('Target.targetDestroyed', ({ targetId }) => { destroyedWorkers.add(targetId); });
      browserSession.on('Target.detachedFromTarget', ({ sessionId }) => {
        const state = workerSessions.get(sessionId);
        if (!state) return;
        for (const command of state.commands.values()) {
          clearTimeout(command.timer);
          command.reject(new Error('后台 target 已关闭'));
        }
        state.item.status = 'closed';
        workerSessions.delete(sessionId);
      });
      await browserSession.send('Target.setDiscoverTargets', { discover: true });
      const { targetInfos } = await browserSession.send('Target.getTargets');
      await Promise.all(targetInfos.map(attachWorker));
    } catch (error) {
      coverageFailure('browser-worker-discovery', error);
    }
  }

  function ownership(entry) {
    // Log 网络条目的 url 是请求目标；只有发起堆栈/上下文才能证明归属。
    const sources = [entry.browserSource === 'network' ? '' : entry.sourceUrl, entry.targetType === 'service_worker' ? entry.targetUrl : '', entry.contextOrigin, ...entry.stack.map(frame => frame.url)].filter(Boolean);
    const ownPrefix = extensionId ? `chrome-extension://${extensionId}/` : null;
    if (ownPrefix && sources.some(url => `${url.replace(/\/$/, '')}/`.startsWith(ownPrefix))) return 'fluentread';
    if (entry.targetType === 'page' && entry.targetUrl.startsWith(ownPrefix || '\0')) return 'fluentread';
    if (entry.contextIsDefault === false && /fluent\s*-?\s*read/i.test(entry.contextName)) return 'fluentread';
    // 动态 WAR 的 UUID 不等于 runtime.id；非匹配 host 不能证明来自其他扩展。
    // 安全日志可能只在正文提及被拒绝的资源，也不能仅凭网页 sourceUrl 排除。
    if (sources.some(url => url.startsWith('chrome-extension://')) || /\bchrome-extension:\/\//i.test(entry.message)) return 'unattributed';
    if (sources.some(url => /^https?:|^file:/.test(url))) return 'site';
    return 'unattributed';
  }

  function snapshot() {
    const all = entries.map(entry => ({ ...entry, ownership: ownership(entry) }));
    const blockers = all.filter(entry => !entry.expectedCase && ['fluentread', 'unattributed'].includes(entry.ownership));
    const workerObserved = !extensionId || coverage.workers.some(item => item.attached && item.url.startsWith(`chrome-extension://${extensionId}/`));
    return { entries: all, coverage, completeCoverage: false, coverageScope: 'attached-top-level-pages-and-extension-service-workers', counts: {
      errors: blockers.filter(entry => entry.level === 'error').length,
      warnings: blockers.filter(entry => entry.level === 'warning').length,
      expected: all.filter(entry => entry.expectedCase).length,
      site: all.filter(entry => entry.ownership === 'site').length,
    }, workerObserved, passed: blockers.length === 0 && coverage.failures.length === 0 && workerObserved, blockerIds: blockers.map(entry => entry.id) };
  }

  function assertClean() {
    const report = snapshot();
    if (!report.passed) throw new Error(`运行时诊断未通过：${report.counts.errors} 个错误、${report.counts.warnings} 个告警、${coverage.failures.length} 个采集失败，后台采集${report.workerObserved ? '已连接' : '未连接'}；见 runtime-diagnostics.json`);
  }

  return { start, attachPage, setExtensionId: value => { extensionId = value; }, setPhase: value => { phase = String(value); }, checkpoint: () => sequence,
    expectSince(checkpoint, { caseId, surface, exactMessages, level = 'error', maxCount = 1 }) {
      if (!extensionId || !Array.isArray(exactMessages) || !Number.isInteger(maxCount) || maxCount < 1) throw new Error('预期诊断需要扩展 ID、精确消息列表和有限次数');
      let count = 0;
      const end = sequence;
      for (const entry of entries) {
        const ownSource = [entry.sourceUrl, ...entry.stack.map(frame => frame.url)].some(url => url.startsWith(`chrome-extension://${extensionId}/`));
        if (entry.id > checkpoint && entry.id <= end && entry.surface === surface && entry.type === 'console' && entry.level === level
          && ownership(entry) === 'fluentread' && ownSource && exactMessages.includes(entry.message.split('\n')[0]) && count < maxCount) {
          entry.expectedCase = caseId;
          count += 1;
        }
      }
      return count;
    },
    snapshot, assertClean,
    async flush() { await Promise.allSettled([...pending]); },
    async stop() {
      closing = true;
      context?.off('page', pageListener);
      await Promise.allSettled([...workerSessions.keys()].map(sessionId => browserSession.send('Target.detachFromTarget', { sessionId })));
      await Promise.allSettled(pageStates.filter(state => state.session).map(state => state.session.detach()));
      if (browserSession) await browserSession.detach().catch(() => {});
    },
    write(artifactsDir, result) {
      result.runtimeDiagnostics = snapshot();
      result.errors = result.runtimeDiagnostics.entries.filter(entry => result.runtimeDiagnostics.blockerIds.includes(entry.id) && entry.level === 'error');
      result.runtimeWarnings = result.runtimeDiagnostics.entries.filter(entry => result.runtimeDiagnostics.blockerIds.includes(entry.id) && entry.level === 'warning');
      fs.writeFileSync(path.join(artifactsDir, 'runtime-diagnostics.json'), `${JSON.stringify(result.runtimeDiagnostics, null, 2)}\n`);
      fs.writeFileSync(path.join(artifactsDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    },
  };
}

// 证据写盘或诊断解绑失败，也必须继续关闭本次浏览器、HTTP server 与临时 profile。
// 保留原始测试异常；附加的清理失败单列在报告中，不能覆盖首个失败。
async function finalizeRun({ diagnostics, result, artifactsDir, primaryError, cleanup, emitReport }) {
  const failures = [];
  let firstError = primaryError;
  const attempt = async (stage, action) => {
    try { await action(); return true; }
    catch (error) {
      firstError ||= error;
      result.ok = false;
      result.error ||= redact(error.message || error);
      failures.push({ stage, message: redact(error.message || error) });
      result.finalizationErrors = failures;
      return false;
    }
  };
  await attempt('diagnostics-flush', () => diagnostics.flush());
  await attempt('diagnostics-verdict', () => {
    if (result.ok) diagnostics.assertClean();
  });
  const evidenceWritten = await attempt('diagnostics-write', () => diagnostics.write(artifactsDir, result));
  const failuresBeforeCleanup = failures.length;
  await attempt('diagnostics-stop', () => diagnostics.stop());
  for (const { stage, action } of cleanup) await attempt(stage, action);
  if (evidenceWritten && failures.length !== failuresBeforeCleanup) await attempt('final-evidence-write', () => diagnostics.write(artifactsDir, result));
  if (emitReport) await attempt('report-output', () => emitReport(result));
  if (firstError && !primaryError) throw firstError;
}

module.exports = { createRuntimeDiagnostics, finalizeRun, redact };
