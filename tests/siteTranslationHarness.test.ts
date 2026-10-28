import {EventEmitter} from 'node:events';
import {mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {parseHTML} from 'linkedom';
import {describe, expect, it, vi} from 'vitest';
import cases from './browser-translation-cases.json';
import establishedFixtures from '../scripts/site-translation/site-adaptation-established-fixtures.json';
import type {YoutubeFetchPort} from '../src/features/video-subtitle/content/youtubeTimedTextBridgeCore';

const require = createRequire(import.meta.url);

describe('X request-level runtime attribution', () => {
  const {POLICY, explicitArguments, classifyRequest, createXRuntimeDiagnostics} =
    require('../scripts/testing/x-runtime-diagnostics.cjs');
  const extensionId = 'fixture-extension';
  const initiator = () => ({type: 'script', stack: {callFrames: POLICY.frames.map((frame: {
    bridge?: boolean; url?: string; functionName: string; lineNumber: number; columnNumber: number;
  }) => ({functionName: frame.functionName,
    url: frame.bridge ? `chrome-extension://${extensionId}/${POLICY.bridgePath}` : frame.url,
    lineNumber: frame.lineNumber, columnNumber: frame.columnNumber, scriptId: 'opaque-runtime-id'}))}});
  function facts() {
    return {extensionId, artifactHash: POLICY.bridgeSha256,
      entry: {id: 7, ownership: 'unattributed', type: 'browser-log', browserSource: 'network',
        targetType: 'page', level: 'error', targetUrl: POLICY.pageUrl, sourceUrl: POLICY.requestUrl,
        message: 'Failed to load resource: the server responded with a status of 404 ()',
        contextOrigin: '', contextName: '', stack: []},
      binding: {networkRequestId: 'request-1', entryIds: [7], targetId: 'target-1', sessionKey: 'session-1',
        loaderId: 'loader-1', frameId: 'frame-1', pageUrl: POLICY.pageUrl},
      request: {requestId: 'request-1', targetId: 'target-1', sessionKey: 'session-1', loaderId: 'loader-1',
        frameId: 'frame-1', pageUrl: POLICY.pageUrl, documentURL: POLICY.pageUrl,
        requestCount: 1, responseCount: 1, finishCount: 1, logCount: 1,
        method: 'GET', url: POLICY.requestUrl, responseUrl: POLICY.requestUrl, status: 404,
        type: 'Fetch', initiator: initiator()},
    };
  }
  type Facts = ReturnType<typeof facts>;

  it('accepts only the saved four-frame native startup chain through the reviewed transparent forwarder', () => {
    expect(classifyRequest(facts())).toMatchObject({matched: true, policyId: POLICY.id, requestId: 'request-1'});
  });

  it.each<[string, (value: Facts) => void]>([
    ['network destination without a request binding', value => {value.binding.networkRequestId = '';}],
    ['a changed native page', value => {value.entry.targetUrl = 'https://x.com/other/status/1';}],
    ['a different API origin', value => {value.request.url = POLICY.requestUrl.replace('api.x.com', 'provider.test');}],
    ['a different endpoint', value => {value.request.url = POLICY.requestUrl.replace('/2/guide.json', '/2/timeline.json');}],
    ['additional request parameters', value => {value.request.url += '&unexpected=1';}],
    ['a POST to the same URL', value => {value.request.method = 'POST';}],
    ['request data on GET', value => {Object.assign(value.request, {hasPostData: true});}],
    ['a different response URL', value => {value.request.responseUrl = 'https://api.x.com/redirected';}],
    ['a different response status', value => {value.request.status = 500;}],
    ['a preflight response', value => {value.request.type = 'Preflight';}],
    ['a redirected request reusing an ID', value => {Object.assign(value.request, {redirected: true});}],
    ['a failed/CORS request', value => {Object.assign(value.request, {failed: true});}],
    ['a service-worker response', value => {Object.assign(value.request, {fromServiceWorker: true});}],
    ['a second request sharing the ID', value => {value.request.requestCount = 2;}],
    ['duplicate responses', value => {value.request.responseCount = 2;}],
    ['an unfinished request', value => {value.request.finishCount = 0;}],
    ['two logs associated with one request', value => {value.request.logCount = 2;}],
    ['an ambiguous new-entry set', value => {value.binding.entryIds.push(8);}],
    ['the wrong actual entry ID', value => {value.binding.entryIds = [8];}],
    ['the wrong target', value => {value.binding.targetId = 'other-target';}],
    ['another CDP session', value => {value.binding.sessionKey = 'other-session';}],
    ['a previous loader', value => {value.binding.loaderId = 'previous-loader';}],
    ['another frame', value => {value.binding.frameId = 'child-frame';}],
    ['a different document URL', value => {value.request.documentURL = 'https://x.com/home';}],
    ['an unknown bridge build', value => {value.artifactHash = 'unreviewed';}],
    ['the same file in another extension', value => {value.request.initiator.stack.callFrames[0].url = 'chrome-extension://other/content-scripts/xVideoBridge.js';}],
    ['a changed bridge call position', value => {value.request.initiator.stack.callFrames[0].columnNumber += 1;}],
    ['an extension-initiated request with no native caller', value => {value.request.initiator.stack.callFrames.splice(1);}],
    ['another native script with a similar name', value => {value.request.initiator.stack.callFrames[1].url += '.unknown';}],
    ['reordered native startup frames', value => {value.request.initiator.stack.callFrames.reverse();}],
    ['an extra extension frame', value => {value.request.initiator.stack.callFrames.push(value.request.initiator.stack.callFrames[0]);}],
    ['an unknown asynchronous initiator parent', value => {Object.assign(value.request.initiator.stack, {parent: {callFrames: []}});}],
    ['a known FluentRead error', value => {value.entry.ownership = 'fluentread';}],
    ['a console error with the same words', value => {value.entry.type = 'console';}],
    ['an exception with the same words', value => {value.entry.type = 'exception';}],
    ['a background error', value => {value.entry.targetType = 'service_worker';}],
    ['an isolated-world context', value => {value.entry.contextName = 'FluentRead';}],
    ['an explicit extension stack', value => {Object.assign(value.entry, {stack: [{url: 'chrome-extension://fixture-extension/content.js'}]});}],
  ])('keeps %s blocking', (_name, mutate) => {
    const value = facts(); mutate(value);
    expect(classifyRequest(value).matched).toBe(false);
  });

  async function fixture(options: {networkUnavailable?: boolean; artifactHash?: string;
    extraEntries?: boolean; rawVerdictError?: string; snapshotFault?: boolean;
    rawPassedOverride?: boolean; rawVerdictSucceeds?: boolean; stopError?: string;
    redact?: (value: unknown) => string} = {}) {
    const entries: Record<string, unknown>[] = [];
    const coverage = {pages: [{status: 'listening'}], workers: [{attached: true}], failures: [] as unknown[], limitations: ['original limitation']};
    const originalCalls: {receiver: unknown; params: unknown}[] = [];
    const session = new EventEmitter() as EventEmitter & {
      send: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn>;
    };
    session.send = vi.fn(async (method: string) => {
      if (method === 'Network.enable' && options.networkUnavailable) throw new Error('Network domain unavailable');
      if (method === 'Target.getTargetInfo') return {targetInfo: {targetId: 'target-1', type: 'page'}};
      if (method === 'Page.getFrameTree') return {frameTree: {frame: {id: 'frame-1', loaderId: 'loader-1', url: POLICY.pageUrl}}};
      return {};
    });
    session.detach = vi.fn(async () => session.removeAllListeners());
    const page = {url: () => POLICY.pageUrl};
    const context = {newCDPSession: vi.fn(async (_page: unknown) => session)};
    let sequence = 0, phase = 'bootstrap', workerObserved = true, snapshotReads = 0;
    const rawSnapshot = () => {
      if (options.snapshotFault && ++snapshotReads === 1) throw new Error('Binding snapshot unavailable');
      const blockers = entries.filter(entry => ['fluentread', 'unattributed'].includes(String(entry.ownership)));
      return {entries: structuredClone(entries), coverage: structuredClone(coverage), completeCoverage: false,
        coverageScope: 'original scope', counts: {errors: blockers.filter(entry => entry.level === 'error').length,
          warnings: blockers.filter(entry => entry.level === 'warning').length, expected: 0,
          site: entries.filter(entry => entry.ownership === 'site').length},
        workerObserved, passed: options.rawPassedOverride ?? (!blockers.length && !coverage.failures.length && workerObserved),
        blockerIds: blockers.map(entry => entry.id)};
    };
    const base = {
      async start(wrappedContext: typeof context) {
        const sameSession = await wrappedContext.newCDPSession(page);
        sameSession.on('Log.entryAdded', function (this: unknown, params: {entry: {
          level: string; source: string; text: string; url?: string; timestamp: number;
        }}) {
          originalCalls.push({receiver: this, params});
          const log = params.entry;
          if (!['warning', 'error'].includes(log.level)) return;
          entries.push({id: ++sequence, phase, surface: 'translation-page', targetType: 'page', type: 'browser-log',
            level: log.level, message: log.text, sourceUrl: log.url || '', stack: [], browserSource: log.source,
            contextOrigin: '', contextName: '', targetUrl: page.url(), protocolTimestamp: log.timestamp,
            ownership: log.source === 'network' ? 'unattributed' : 'fluentread'});
          if (options.extraEntries) entries.push({...entries.at(-1), id: ++sequence});
        });
        await sameSession.send('Runtime.enable'); await sameSession.send('Log.enable');
      },
      attachPage: vi.fn(async () => {}), setExtensionId: vi.fn(), setPhase(value: string) {phase = value;},
      flush: vi.fn(async () => {}), snapshot: rawSnapshot,
      assertClean() {
        if (options.rawVerdictError) throw new Error(options.rawVerdictError);
        if (options.rawVerdictSucceeds) return;
        const raw = rawSnapshot();
        if (!raw.passed) throw new Error(`运行时诊断未通过：${raw.counts.errors} 个错误、${raw.counts.warnings} 个告警、${raw.coverage.failures.length} 个采集失败，后台采集${raw.workerObserved ? '已连接' : '未连接'}；见 runtime-diagnostics.json`);
      },
      stop: vi.fn(async () => {await session.detach(); if (options.stopError) throw new Error(options.stopError);}),
    };
    const readArtifactHash = vi.fn(() => options.artifactHash || POLICY.bridgeSha256);
    const diagnostics = createXRuntimeDiagnostics({rawHelper: {createRuntimeDiagnostics: () => base, redact: options.redact ?? String},
      extensionDir: '/explicit/test-build', readArtifactHash});
    await diagnostics.start(context); diagnostics.setExtensionId(extensionId); diagnostics.setPhase('full/restore');
    const request = (overrides = {}) => session.emit('Network.requestWillBeSent', {
      requestId: 'request-1', frameId: 'frame-1', loaderId: 'loader-1', documentURL: POLICY.pageUrl,
      request: {url: POLICY.requestUrl, method: 'GET'}, initiator: initiator(), ...overrides,
    });
    const response = (overrides = {}) => session.emit('Network.responseReceived', {
      requestId: 'request-1', frameId: 'frame-1', loaderId: 'loader-1', type: 'Fetch',
      response: {url: POLICY.requestUrl, status: 404, fromServiceWorker: false}, ...overrides,
    });
    const log = (overrides = {}) => {
      const params = {entry: {level: 'error', source: 'network', timestamp: 12345,
        text: 'Failed to load resource: the server responded with a status of 404 ()',
        url: POLICY.requestUrl, networkRequestId: 'request-1', ...overrides}};
      session.emit('Log.entryAdded', params); return params;
    };
    const finish = () => session.emit('Network.loadingFinished', {requestId: 'request-1'});
    return {diagnostics, base, entries, coverage, session, context, originalCalls, rawSnapshot,
      request, response, log, finish, readArtifactHash,
      loseWorker() {workerObserved = false;}};
  }

  it('uses the exact original session and callback, binds actual IDs, retains raw failure and audits derived counts', async () => {
    const f = await fixture();
    f.request(); f.response(); const params = f.log(); f.finish();
    expect(f.context.newCDPSession).toHaveBeenCalledTimes(1);
    expect(f.originalCalls).toEqual([{receiver: f.session, params}]);
    expect(f.originalCalls[0].params).toBe(params);
    expect(f.session.send.mock.calls.map(call => call[0])).toEqual([
      'Network.enable', 'Page.enable', 'Target.getTargetInfo', 'Page.getFrameTree', 'Runtime.enable', 'Log.enable',
    ]);
    expect(f.readArtifactHash).toHaveBeenCalledWith('/explicit/test-build/content-scripts/xVideoBridge.js');
    expect(() => f.base.assertClean()).toThrow('运行时诊断未通过');
    expect(() => f.diagnostics.assertClean()).not.toThrow();
    const report = f.diagnostics.snapshot();
    expect(report.rawDiagnostics).toEqual(f.rawSnapshot());
    expect(report.rawDiagnostics).toMatchObject({passed: false, blockerIds: [1], counts: {errors: 1, site: 0}});
    expect(report.rawVerdict).toMatchObject({observed: true, passed: false});
    expect(report).toMatchObject({passed: true, blockerIds: [], counts: {errors: 0, warnings: 0, site: 1},
      completeCoverage: false, coverage: {limitations: ['original limitation']}});
    expect(report.requestOwnership.adjustments).toHaveLength(1);
    expect(report.requestOwnership.adjustments[0]).toMatchObject({entryId: 1, evidence: {requestId: 'request-1'}});
    await f.diagnostics.stop();
    expect(f.base.stop).toHaveBeenCalledOnce(); expect(f.session.listenerCount('Network.requestWillBeSent')).toBe(0);
  });

  it.each(['missing-id', 'missing-request', 'missing-response', 'missing-finish', 'duplicate-log',
    'duplicate-entry', 'changed-loader', 'response-from-other-frame', 'failed-request', 'unreviewed-build', 'network-gap'])(
    'keeps actual event-stream %s blocking without URL/timestamp reconstruction', async problem => {
      const f = await fixture({extraEntries: problem === 'duplicate-entry',
        artifactHash: problem === 'unreviewed-build' ? 'other-build' : undefined,
        networkUnavailable: problem === 'network-gap'});
      if (problem !== 'missing-request') f.request();
      if (problem !== 'missing-response') f.response(problem === 'response-from-other-frame' ? {frameId: 'child'} : {});
      if (problem === 'changed-loader') f.session.emit('Page.frameNavigated', {frame: {id: 'frame-1', loaderId: 'later-loader', url: POLICY.pageUrl}});
      f.log(problem === 'missing-id' ? {networkRequestId: undefined} : {});
      if (problem === 'duplicate-log') f.log();
      if (problem !== 'missing-finish') f.finish();
      if (problem === 'failed-request') f.session.emit('Network.loadingFailed', {requestId: 'request-1', errorText: 'blocked'});
      expect(() => f.diagnostics.assertClean()).toThrow();
      expect(f.diagnostics.snapshot().passed).toBe(false);
      expect(f.diagnostics.snapshot().requestOwnership.adjustments).toEqual([]);
      expect(f.originalCalls.length).toBe(problem === 'duplicate-log' ? 2 : 1);
      await f.diagnostics.stop();
    });

  it.each(['extension-error', 'extension-warning', 'coverage-gap', 'worker-gap', 'unknown-network', 'extra-raw-verdict'])(
    'never releases a separate %s alongside an evidenced native 404', async problem => {
      const f = await fixture({rawVerdictError: problem === 'extra-raw-verdict' ? 'Additional raw verifier failure' : undefined});
      f.request(); f.response(); f.log(); f.finish();
      if (problem.startsWith('extension-')) f.log({source: 'javascript', text: 'Extension failed', level: problem.endsWith('warning') ? 'warning' : 'error'});
      if (problem === 'unknown-network') f.log({url: 'https://provider.test/translate', networkRequestId: 'unobserved'});
      if (problem === 'coverage-gap') f.coverage.failures.push({surface: 'worker', message: 'attach failed'});
      if (problem === 'worker-gap') f.loseWorker();
      expect(() => f.diagnostics.assertClean()).toThrow();
      const report = f.diagnostics.snapshot();
      expect(report.passed).toBe(false);
      expect(report.rawDiagnostics.passed).toBe(false);
      expect(report.rawVerdict.passed).toBe(false);
      await f.diagnostics.stop();
    });

  it('still invokes the original callback when observing its before-snapshot fails', async () => {
    const f = await fixture({snapshotFault: true});
    f.request(); f.response(); f.log(); f.finish();
    expect(f.originalCalls).toHaveLength(1); expect(f.entries).toHaveLength(1);
    expect(() => f.diagnostics.assertClean()).toThrow();
    expect(f.diagnostics.snapshot().requestOwnership.failures).toContainEqual({surface: 'entry-binding-before', message: 'Binding snapshot unavailable'});
    await f.diagnostics.stop();
  });

  it('cannot skip original collector cleanup when removing a diagnostic listener fails', async () => {
    const f = await fixture();
    vi.spyOn(f.session, 'off').mockImplementation(() => {throw new Error('Listener cleanup failed');});
    await expect(f.diagnostics.stop()).rejects.toThrow('Listener cleanup failed');
    expect(f.base.stop).toHaveBeenCalledOnce(); expect(f.session.detach).toHaveBeenCalledOnce();
    expect(f.diagnostics.snapshot().passed).toBe(false);
  });

  it.each([false, true])('rejects contradictory raw snapshot passed=%s even when all eligible requests are proven', async rawPassedOverride => {
    const f = await fixture({rawPassedOverride});
    if (rawPassedOverride) {f.request(); f.response(); f.log(); f.finish();}
    // false + no blockers and true + an original blocker both contradict the original documented predicate.
    expect(f.diagnostics.snapshot().requestOwnership.rawSnapshotConsistent).toBe(false);
    expect(() => f.diagnostics.assertClean()).toThrow();
    const report = f.diagnostics.snapshot();
    expect(report.passed).toBe(false); expect(report.rawDiagnostics.passed).toBe(rawPassedOverride);
    await f.diagnostics.stop();
  });

  it('rejects an original verifier that returns success despite a raw blocker', async () => {
    const f = await fixture({rawVerdictSucceeds: true});
    f.request(); f.response(); f.log(); f.finish();
    expect(() => f.diagnostics.assertClean()).toThrow();
    const report = f.diagnostics.snapshot();
    expect(report).toMatchObject({passed: false, rawVerdict: {observed: true, passed: true}, rawDiagnostics: {passed: false}});
    expect(report.requestOwnership.failures).toContainEqual({surface: 'raw-verdict', message: 'Raw verdict disagrees with its snapshot'});
    await f.diagnostics.stop();
  });

  it('retains an additional original verifier error even when its raw snapshot has no blockers', async () => {
    const f = await fixture({rawVerdictError: 'Additional raw verifier failure'});
    expect(() => f.diagnostics.assertClean()).toThrow('Additional raw verifier failure');
    expect(f.diagnostics.snapshot()).toMatchObject({passed: false, rawDiagnostics: {passed: true},
      rawVerdict: {observed: true, passed: false, message: 'Additional raw verifier failure'}});
    await f.diagnostics.stop();
  });

  it.each([false, true])('retains original collector stop failure alongside observer failure=%s', async observerFailure => {
    const f = await fixture({stopError: 'Original collector stop failed'});
    if (observerFailure) vi.spyOn(f.session, 'off').mockImplementation(() => {throw new Error('Listener cleanup failed');});
    await expect(f.diagnostics.stop()).rejects.toThrow(observerFailure ? 'Listener cleanup failed' : 'Original collector stop failed');
    expect(f.base.stop).toHaveBeenCalledOnce(); expect(f.session.detach).toHaveBeenCalledOnce();
    const report = f.diagnostics.snapshot();
    expect(report.passed).toBe(false);
    expect(report.requestOwnership.failures).toContainEqual({surface: 'raw-stop', message: 'Original collector stop failed'});
    if (observerFailure) expect(report.requestOwnership.failures).toContainEqual({surface: 'listener-cleanup', message: 'Listener cleanup failed'});
  });

  it('records a failed blob request as unknown evidence without changing the raw verdict or granting site ownership', async () => {
    const f = await fixture();
    const blobUrl = 'blob:https://x.com/native-player-resource';
    f.request({request: {url: blobUrl, method: 'GET'}, initiator: {type: 'other'}});
    f.session.emit('Network.loadingFailed', {requestId: 'request-1', errorText: 'net::ERR_FILE_NOT_FOUND',
      type: 'Media', canceled: false});
    f.log({url: blobUrl, text: 'Failed to load resource: net::ERR_FILE_NOT_FOUND'});
    expect(() => f.diagnostics.assertClean()).toThrow();
    const report = f.diagnostics.snapshot();
    expect(report.rawDiagnostics).toEqual(f.rawSnapshot());
    expect(report).toMatchObject({passed: false, blockerIds: [1], counts: {errors: 1, site: 0}});
    expect(report.requestOwnership.adjustments).toEqual([]);
    expect(report.requestOwnership.unclassifiedEntries).toMatchObject([{entryId: 1, reason: 'different-log',
      binding: {networkRequestId: 'request-1', targetId: 'target-1', loaderId: 'loader-1'},
      request: {url: blobUrl, method: 'GET', requestCount: 1, responseCount: 0, finishCount: 0,
        failed: true, failure: {errorText: 'net::ERR_FILE_NOT_FOUND', type: 'Media', canceled: false},
        initiator: {type: 'other'}}}]);
    await f.diagnostics.stop();
  });

  it('redacts unknown request URLs and stacks while never recording headers or request bodies', async () => {
    const f = await fixture({redact: value => String(value).replaceAll('fixture-private', '[REDACTED]')});
    f.request({request: {url: POLICY.requestUrl + '&token=fixture-private', method: 'GET',
      headers: {authorization: 'fixture-private'}, postData: 'fixture-private-body'},
    initiator: {type: 'script', stack: {callFrames: [{url: 'https://native.test/script.js?token=fixture-private'}]}}});
    f.response(); f.log(); f.finish();
    expect(() => f.diagnostics.assertClean()).toThrow();
    const report = f.diagnostics.snapshot();
    const observation = report.requestOwnership.unclassifiedEntries[0];
    expect(observation.request.url).toContain('token=[REDACTED]');
    expect(observation.request.initiator.stack.callFrames[0].url).toContain('token=[REDACTED]');
    expect(JSON.stringify(observation)).not.toContain('fixture-private');
    expect(observation.request).not.toHaveProperty('headers');
    expect(observation.request).not.toHaveProperty('postData');
    expect(report.rawDiagnostics).toEqual(f.rawSnapshot());
    expect(report.passed).toBe(false);
    await f.diagnostics.stop();
  });

  it('keeps a missing request ID explicit instead of reconstructing unknown evidence from its URL', async () => {
    const f = await fixture(); f.request(); f.response(); f.finish();
    f.log({networkRequestId: undefined});
    const report = f.diagnostics.snapshot();
    expect(report.requestOwnership.unclassifiedEntries).toMatchObject([{entryId: 1,
      reason: 'missing-or-ambiguous-entry-binding', binding: {networkRequestId: null}, request: null}]);
    expect(report.passed).toBe(false);
    await f.diagnostics.stop();
  });

  it('requires explicit nonduplicate base-helper and extension paths without a machine-specific default', () => {
    expect(explicitArguments(['--raw-runtime-diagnostics-helper', '/approved/raw.cjs', '--extension-dir', '/build']))
      .toEqual({rawHelperPath: '/approved/raw.cjs', extensionDir: '/build'});
    for (const argv of [[], ['--extension-dir', '/build'], ['--raw-runtime-diagnostics-helper', '/raw', '--extension-dir'],
      ['--raw-runtime-diagnostics-helper', '/raw', '--raw-runtime-diagnostics-helper', '/other', '--extension-dir', '/build']]) {
      expect(() => explicitArguments(argv)).toThrow('explicit');
    }
  });

  it('the actual bridge preserves guide input/init/receiver and the exact 404 response without clone or publication', async () => {
    const {installYoutubeTimedTextBridgeCore} = await import('../src/features/video-subtitle/content/youtubeTimedTextBridgeCore');
    const {isXVideoBridgeResourceUrl, createXVideoBridgeResourcePayload} = await import('../src/features/video-subtitle/content/xVideoSubtitleData');
    const response = {status: 404, clone: vi.fn(() => ({text: async () => 'should not read'}))};
    const original = vi.fn(async (_input: unknown, _init?: unknown) => response);
    let current: YoutubeFetchPort = original;
    const postMessage = vi.fn();
    const port = {get: () => current, set: (next: YoutubeFetchPort) => {current = next;}};
    const events = {addEventListener: vi.fn(), removeEventListener: vi.fn()};
    const xhr = {get: () => function () {}, set: vi.fn()};
    const dispose = installYoutubeTimedTextBridgeCore({stateHost: {}, fetch: port, xhrOpen: xhr, xhrSend: xhr,
      pageEvents: events, documentEvents: events, getHref: () => POLICY.pageUrl,
      getOrigin: () => 'https://x.com', postMessage,
      resourcePolicy: {matches: isXVideoBridgeResourceUrl, payload: createXVideoBridgeResourcePayload}});
    const receiver = {}, input = new Request(POLICY.requestUrl), init = {headers: {fixture: 'unchanged'}, credentials: 'include', signal: new AbortController().signal};
    expect(isXVideoBridgeResourceUrl(POLICY.requestUrl, POLICY.pageUrl)).toBe(false);
    expect(await current.call(receiver, input, init)).toBe(response);
    expect(original).toHaveBeenCalledTimes(1);
    expect(original.mock.contexts[0]).toBe(receiver);
    expect(original.mock.calls[0][0]).toBe(input); expect(original.mock.calls[0][1]).toBe(init);
    expect(response.clone).not.toHaveBeenCalled(); expect(postMessage).not.toHaveBeenCalled();
    dispose(); expect(current).toBe(original);
  });
});

describe('dismissible public promotion preparation', () => {
  const {prepareDismissiblePromotion} = require('../scripts/run-site-translation-test.cjs');
  const {normalizeDismissiblePromotion, normalizeCaseConfig, collectBaseCaseConfigErrors} =
    require('../scripts/site-translation/case-config.cjs');
  const config = {
    dialogSelector: '[role="dialog"][aria-modal="true"][aria-labelledby="base-contextual-sign-in-modal-modal-header"]',
    buttonSelector: 'button.contextual-sign-in-modal__modal-dismiss[data-tracking-control-name="pulse-article_contextual-sign-in-modal_modal_dismiss"]',
    contentSelector: 'article.article-main',
  };
  const publicUrl = 'https://www.linkedin.com/pulse/independently-authored-public-article';
  const html = '<main aria-hidden="true"><article class="article-main"><h1>A public article title</h1>' +
    '<p>The complete public paragraph is present before dismissing the promotion.</p></article></main>' +
    '<section role="dialog" aria-modal="true" aria-labelledby="base-contextual-sign-in-modal-modal-header">' +
    '<button class="contextual-sign-in-modal__modal-dismiss" data-tracking-control-name="pulse-article_contextual-sign-in-modal_modal_dismiss">Dismiss</button>' +
    '<form><input name="session_key"><button type="submit">Sign in</button></form></section>';
  type Fixture = {
    document: Document;
    page: {url: () => string; locator: (selector: string) => {click: ReturnType<typeof vi.fn>};
      evaluate: (fn: (input: unknown) => unknown, input: unknown) => Promise<unknown>;
      waitForFunction: ReturnType<typeof vi.fn>};
    nativeClick: ReturnType<typeof vi.fn>;
    location: {href: string; pathname: string};
  };
  async function withPromotion(run: (fixture: Fixture) => Promise<void>,
    options: {afterClick?: (fixture: Pick<Fixture, 'document' | 'location'>) => void;
      beforePoll?: (fixture: Pick<Fixture, 'document' | 'location'>) => void} = {}) {
    const parsed = parseHTML(`<html><body>${html}</body></html>`);
    const document = parsed.document as unknown as Document;
    Object.defineProperty(parsed.window.HTMLElement.prototype, 'getBoundingClientRect', {configurable: true,
      value: () => ({width: 400, height: 100})});
    const location = {href: publicUrl, pathname: new URL(publicUrl).pathname};
    const globals = {document, location, getComputedStyle: (node: HTMLElement) => ({
      display: node.style.display || 'block', visibility: node.style.visibility || 'visible', opacity: node.style.opacity || '1',
    })};
    const previous = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries(globals)) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
    }
    const nativeClick = vi.fn(async () => {
      // This is the authored site's native handler, not an action performed by the helper's page predicate.
      expect(document.querySelector('main')!.getAttribute('aria-hidden')).toBe('true');
      if (options.afterClick) options.afterClick({document, location});
      else {
        document.querySelector(config.dialogSelector)!.setAttribute('hidden', '');
        document.querySelector('main')!.removeAttribute('aria-hidden');
      }
    });
    const page = {url: () => location.href,
      locator: (selector: string) => {expect(selector).toBe(config.buttonSelector); return {click: nativeClick};},
      evaluate: async (fn: (input: unknown) => unknown, input: unknown) => fn(input),
      waitForFunction: vi.fn(async (fn: (input: unknown) => unknown, input: unknown) => {
        options.beforePoll?.({document, location});
        if (!fn(input)) throw new Error('promotion/public content did not become readable');
        return {dispose: vi.fn(async () => undefined)};
      })};
    try {await run({document, page, nativeClick, location});}
    finally {for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }}
  }

  it('normalizes only three explicit selectors and keeps the feature optional', () => {
    expect(normalizeDismissiblePromotion(undefined)).toBeUndefined();
    expect(normalizeDismissiblePromotion(Object.fromEntries(Object.entries(config).map(([key, value]) => [key, ` ${value} `])))).toEqual(config);
    const base = Object.values(cases)[0];
    expect(normalizeCaseConfig('public-promo', {...base, prepareDismissiblePromotion: config}).prepareDismissiblePromotion).toEqual(config);
    expect(normalizeCaseConfig('ordinary', base)).not.toHaveProperty('prepareDismissiblePromotion');
    expect(collectBaseCaseConfigErrors('public-promo', {...base, prepareDismissiblePromotion: config, prepareClickText: 'Any other action'}))
      .toContain('public-promo 的 prepareDismissiblePromotion 不得与 prepareClickText 同时使用');
  });

  it.each([null, false, true, 1, 'click', [], {}, {...config, contentSelector: undefined},
    {...config, dialogSelector: ''}, {...config, buttonSelector: '  '}, {...config, contentSelector: ['article']},
    {...config, action: 'remove'}, {...config, url: '/login'}, {...config, clicks: 2}])('rejects malformed or additional action configuration %#', value => {
    expect(() => normalizeDismissiblePromotion(value)).toThrow('prepareDismissiblePromotion');
    expect(() => normalizeCaseConfig('invalid-promo', {...Object.values(cases)[0], prepareDismissiblePromotion: value})).toThrow('prepareDismissiblePromotion');
  });

  it.each([undefined, 'button'])('uses one native click for an unassociated safe button type %s', async type => {
    await withPromotion(async ({document, page, nativeClick}) => {
      if (type) document.querySelector(config.buttonSelector)!.setAttribute('type', type);
      const before = document.querySelector('article')!.outerHTML;
      await expect(prepareDismissiblePromotion(page, config, publicUrl, 1000)).resolves.toMatchObject({status: 'dismissed', nativeClicks: 1});
      expect(nativeClick).toHaveBeenCalledTimes(1);
      expect(page.waitForFunction).toHaveBeenCalledOnce();
      expect(document.querySelector('article')!.outerHTML).toBe(before);
      expect(document.querySelector('input')!.getAttribute('value')).toBeNull();
    });
  });

  it.each(['absent', 'hidden'])('allows an already readable public article when the promotion is %s', async state => {
    await withPromotion(async ({document, page, nativeClick}) => {
      const dialog = document.querySelector(config.dialogSelector)!;
      if (state === 'absent') dialog.remove(); else dialog.setAttribute('hidden', '');
      document.querySelector('main')!.removeAttribute('aria-hidden');
      const before = document.body.innerHTML;
      await expect(prepareDismissiblePromotion(page, config, publicUrl, 1000)).resolves.toMatchObject({status: 'not-present', nativeClicks: 0});
      expect(nativeClick).not.toHaveBeenCalled();
      expect(document.body.innerHTML).toBe(before);
    });
  });

  it('waits within one deadline for a unique safe button to become painted, then rechecks before clicking', async () => {
    await withPromotion(async ({document, page, nativeClick}) => {
      document.querySelector<HTMLElement>(config.buttonSelector)!.style.visibility = 'hidden';
      await expect(prepareDismissiblePromotion(page, config, publicUrl, 1000)).resolves.toMatchObject({status: 'dismissed', nativeClicks: 1});
      expect(page.waitForFunction).toHaveBeenCalledTimes(2);
      expect(nativeClick).toHaveBeenCalledOnce();
      for (const call of page.waitForFunction.mock.calls) expect((call[2] as {timeout?: number} | undefined)?.timeout ?? 0).toBeLessThanOrEqual(1000);
    }, {beforePoll: ({document}) => {document.querySelector<HTMLElement>(config.buttonSelector)!.style.visibility = 'visible';}});
  });

  it('rejects a form association introduced while waiting and records its exact preconditions without clicking', async () => {
    await withPromotion(async ({document, page, nativeClick}) => {
      document.querySelector(config.buttonSelector)!.setAttribute('hidden', '');
      const error = await prepareDismissiblePromotion(page, config, publicUrl, 1000).catch((value: Error) => value);
      expect(error.message).toContain('belongs to a form');
      expect(error.promotionDiagnostic.button).toMatchObject({count: 1, ancestorForm: true, insideDialog: true, painted: true});
      expect(nativeClick).not.toHaveBeenCalled();
      expect(page.waitForFunction).toHaveBeenCalledOnce();
    }, {beforePoll: ({document}) => {
      const button = document.querySelector(config.buttonSelector)!;
      button.removeAttribute('hidden');
      document.querySelector('form')!.appendChild(button);
    }});
  });

  function inactiveOverlay(document: Document) {
    const dialog = document.querySelector(config.dialogSelector)!;
    const overlay = document.createElement('div');
    overlay.className = 'modal__overlay';
    overlay.setAttribute('aria-hidden', 'true');
    dialog.replaceWith(overlay);
    overlay.appendChild(dialog);
    document.querySelector('main')!.removeAttribute('aria-hidden');
    return overlay;
  }

  it('waits for an inactive known promotion to activate before its one native click', async () => {
    await withPromotion(async ({document, page, nativeClick}) => {
      inactiveOverlay(document);
      await expect(prepareDismissiblePromotion(page, config, publicUrl, 1000)).resolves.toMatchObject({status: 'dismissed', nativeClicks: 1});
      expect(nativeClick).toHaveBeenCalledOnce();
      expect(page.waitForFunction).toHaveBeenCalledTimes(2);
    }, {beforePoll: ({document}) => {
      const overlay = document.querySelector('.modal__overlay')!;
      if (overlay.getAttribute('aria-hidden') === 'true') {
        overlay.setAttribute('aria-hidden', 'false');
        document.querySelector('main')!.setAttribute('aria-hidden', 'true');
      }
    }});
  });

  it('allows an inactive known promotion to become visually hidden with readable public content and zero clicks', async () => {
    await withPromotion(async ({document, page, nativeClick}) => {
      inactiveOverlay(document);
      await expect(prepareDismissiblePromotion(page, config, publicUrl, 1000)).resolves.toMatchObject({status: 'not-present', nativeClicks: 0});
      expect(nativeClick).not.toHaveBeenCalled();
      expect(page.waitForFunction).toHaveBeenCalledOnce();
    }, {beforePoll: ({document}) => {document.querySelector<HTMLElement>('.modal__overlay')!.style.visibility = 'hidden';}});
  });

  it('times out with zero clicks when an inactive known promotion stays painted', async () => {
    await withPromotion(async ({document, page, nativeClick}) => {
      inactiveOverlay(document);
      const before = document.body.innerHTML;
      const error = await prepareDismissiblePromotion(page, config, publicUrl, 1000).catch((value: Error) => value);
      expect(error.promotionDiagnostic.button).toMatchObject({inactiveKnownPromotionAncestor: true, inaccessibleAncestor: true, painted: true});
      expect(nativeClick).not.toHaveBeenCalled();
      expect(page.waitForFunction).toHaveBeenCalledOnce();
      expect(document.body.innerHTML).toBe(before);
    });
  });

  it.each(['inner aria-hidden', 'inert overlay'])('still refuses %s immediately even inside a known inactive promotion', async state => {
    await withPromotion(async ({document, page, nativeClick}) => {
      const overlay = inactiveOverlay(document);
      if (state === 'inner aria-hidden') document.querySelector(config.buttonSelector)!.setAttribute('aria-hidden', 'true');
      else overlay.setAttribute('inert', '');
      await expect(prepareDismissiblePromotion(page, config, publicUrl, 1000)).rejects.toThrow('preparation refused');
      expect(nativeClick).not.toHaveBeenCalled();
      expect(page.waitForFunction).not.toHaveBeenCalled();
    });
  });

  const invalid: Array<[string, (document: Document) => void]> = [
    ['duplicate dialog', document => document.body.appendChild(document.querySelector(config.dialogSelector)!.cloneNode(true))],
    ['duplicate button', document => document.querySelector(config.dialogSelector)!.appendChild(document.querySelector(config.buttonSelector)!.cloneNode(true))],
    ['outside button', document => document.body.appendChild(document.querySelector(config.buttonSelector)!)],
    ['missing content', document => document.querySelector('article')!.remove()],
    ['ambiguous content', document => document.querySelector('main')!.appendChild(document.querySelector('article')!.cloneNode(true))],
    ['content inside dialog', document => document.querySelector(config.dialogSelector)!.appendChild(document.querySelector('article')!)],
    ['unrendered content', document => document.querySelector<HTMLElement>('article')!.style.display = 'none'],
    ['hidden button', document => document.querySelector(config.buttonSelector)!.setAttribute('hidden', '')],
    ['disabled button', document => document.querySelector(config.buttonSelector)!.setAttribute('disabled', '')],
    ['inert button', document => document.querySelector(config.buttonSelector)!.setAttribute('inert', '')],
    ['aria hidden button', document => document.querySelector(config.buttonSelector)!.setAttribute('aria-hidden', 'true')],
    ['submit button', document => document.querySelector(config.buttonSelector)!.setAttribute('type', 'submit')],
    ['reset button', document => document.querySelector(config.buttonSelector)!.setAttribute('type', 'reset')],
    ['form attribute', document => document.querySelector(config.buttonSelector)!.setAttribute('form', 'login-form')],
    ['submit override', document => document.querySelector(config.buttonSelector)!.setAttribute('formaction', '/login')],
    ['ancestor form', document => document.querySelector('form')!.appendChild(document.querySelector(config.buttonSelector)!)],
    ['associated form property', document => Object.defineProperty(document.querySelector(config.buttonSelector)!, 'form', {value: document.querySelector('form')})],
    ['unrecognized blocking dialog', document => document.body.insertAdjacentHTML('beforeend', '<div role="dialog" aria-modal="true">Authentication required</div>')],
    ['nonmodal known element', document => document.querySelector(config.dialogSelector)!.removeAttribute('aria-modal')],
    ['hidden content with no promotion', document => document.querySelector(config.dialogSelector)!.remove()],
  ];
  it.each(invalid)('refuses %s before any native action', async (_name, alter) => {
    await withPromotion(async ({document, page, nativeClick}) => {
      alter(document);
      const before = document.body.innerHTML;
      await expect(prepareDismissiblePromotion(page, config, publicUrl, 1000)).rejects.toThrow('preparation refused');
      expect(nativeClick).not.toHaveBeenCalled();
      if (_name !== 'hidden button') expect(page.waitForFunction).not.toHaveBeenCalled();
      expect(document.body.innerHTML).toBe(before);
    });
  });

  it.each(['/authwall', '/checkpoint/challenge', '/login', '/signup/cold-join'])('stops an authentication or challenge path %s even with article DOM', async pathname => {
    await withPromotion(async ({page, nativeClick, location}) => {
      location.href = 'https://www.linkedin.com' + pathname;
      location.pathname = pathname;
      await expect(prepareDismissiblePromotion(page, config, location.href, 1000)).rejects.toThrow('authentication or challenge path');
      expect(nativeClick).not.toHaveBeenCalled();
    });
  });

  it.each(['URL change', 'promotion remains', 'main remains hidden', 'main remains inert', 'new blocking dialog'])
    ('refuses incomplete native dismissal: %s', async mode => {
      await withPromotion(async ({page, nativeClick}) => {
        await expect(prepareDismissiblePromotion(page, config, publicUrl, 1000)).rejects.toThrow();
        expect(nativeClick).toHaveBeenCalledTimes(1);
      }, {afterClick: ({document, location}) => {
        if (mode === 'URL change') {location.href = 'https://www.linkedin.com/login'; location.pathname = '/login'; return;}
        if (mode === 'promotion remains') return;
        document.querySelector(config.dialogSelector)!.setAttribute('hidden', '');
        if (mode === 'main remains hidden') return;
        document.querySelector('main')!.removeAttribute('aria-hidden');
        if (mode === 'main remains inert') document.querySelector('main')!.setAttribute('inert', '');
        if (mode === 'new blocking dialog') document.body.insertAdjacentHTML('beforeend', '<div role="alertdialog">Authentication required</div>');
      }});
    });
});

describe('coverage readiness failure diagnostics', () => {
  const {waitForCoverageReady, readSanitizedFailureDomInPage} = require('../scripts/run-site-translation-test.cjs');
  it('preserves raw counts and the original error while the same predicate reports each eligibility rejection', async () => {
    const {document, window} = parseHTML('<html><body><main>' +
      '<p id="good">A complete natural paragraph remains an eligible target.</p>' +
      '<p id="tags">#LinkedInArticles #LinkedInMarketing #SocialMediaMarketing #JDRGroup</p>' +
      '<div aria-hidden="true"><p id="excluded">A hidden paragraph has readable words.</p></div>' +
      '<p id="no-rect" data-zero>A paragraph without layout still has words.</p>' +
      '<p id="style" style="display:none">A hidden style paragraph has readable words.</p>' +
      '<p id="natural">这段中文不属于英语正文。</p><p id="protected"><code>ORIGINAL_CODE</code></p>' +
      '<p id="short">Short text</p></main><div id="single">Introduction</div></body></html>');
    Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {configurable: true,
      value(this: Element) {return {width: this.hasAttribute('data-zero') ? 0 : 400, height: 40};}});
    const globals = {document, HTMLElement: window.HTMLElement, getComputedStyle: (node: HTMLElement) => ({
      display: node.style.display || 'block', visibility: node.style.visibility || 'visible',
    })};
    const previous = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries(globals)) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
    }
    const originalError = new Error('raw readiness timeout');
    const page = {evaluate: vi.fn(async (fn: (input: unknown) => unknown, input: unknown) => fn(input)),
      waitForFunction: vi.fn(async (fn: (input: unknown) => unknown, input: unknown) => {
        expect(fn(input)).toBe(false); throw originalError;
      })};
    try {
      const rules = [
        {name: 'paragraphs', selector: 'main p', minInitial: 3, minTextLength: 15, sourceIncludes: []},
        {name: 'fragment', selector: '#good', minInitial: 1, sourceIncludes: ['Absent required fragment']},
        {name: 'phrase', selector: '#single', minInitial: 1, sourceIncludes: [], requiresPhrase: true},
      ];
      const error = await waitForCoverageReady(page, rules, 100).catch((value: Error) => value);
      expect(error.cause).toBe(originalError);
      expect(error.message).toContain('raw readiness timeout');
      expect(page.waitForFunction.mock.calls[0][0]).toBe(page.evaluate.mock.calls[0][0]);
      const [paragraphs, fragment, phrase] = error.readinessDiagnostic;
      expect(paragraphs).toMatchObject({count: 8, eligibleCount: 2, minInitial: 3, ready: false});
      expect(paragraphs.samples).toHaveLength(8);
      expect(paragraphs.eligibleSamples.map((node: {index: number}) => node.index)).toEqual([0, 1]);
      for (const [id, reason] of [['excluded', 'excluded-ancestor'], ['no-rect', 'no-rect'], ['style', 'hidden-style'],
        ['natural', 'natural-language-false'], ['protected', 'protected-source-empty'], ['short', 'min-text-length']]) {
        expect(paragraphs.rejected.find((node: {id: string}) => node.id === id).reasons).toContain(reason);
      }
      expect(fragment).toMatchObject({count: 1, eligibleCount: 1, ready: false,
        missingSourceIncludes: ['Absent required fragment'], ruleRejections: ['source-fragment-missing'], rejected: []});
      expect(phrase.rejected[0].reasons).toContain('requires-phrase');
    } finally {for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }}
  });

  it('captures failure markup with native visibility intact but no form values, scripts or token attributes', () => {
    const {document} = parseHTML('<html nonce="private-nonce"><head><script>private-script</script><style>private-style</style></head>' +
      '<body><main aria-hidden="true"><article class="article-main"><p>Public source<br>and complete last line.</p></article></main>' +
      '<section role="dialog" aria-modal="true"><button data-csrf="private-csrf">Dismiss</button>' +
      '<form><input name="session_key" value="private-value"><textarea>private-textarea</textarea></form></section></body></html>');
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {configurable: true, value: document});
    const before = document.documentElement.outerHTML;
    try {
      const html = readSanitizedFailureDomInPage();
      for (const secret of ['private-nonce', 'private-script', 'private-style', 'private-csrf', 'private-value', 'private-textarea']) expect(html).not.toContain(secret);
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain('role="dialog"');
      expect(html).toContain('Public source<br>and complete last line.');
      expect(document.documentElement.outerHTML).toBe(before);
    } finally {if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');}
  });
});

const {inspectFixtureTranslationParts} = require('../scripts/site-translation/fixture-translation-parts.cjs');
const {
  COVERAGE_EXCLUDED_ANCESTORS,
  COVERAGE_PROTECTED_DESCENDANTS,
  COVERAGE_TRACKER_KEY,
  assertPageContract,
  assertFreshProductionExtension,
  assertCoverageReport,
  assertCoverageRestoration,
  capturePageContract,
  evaluateProductionBuildFreshness,
  installCoverageTracker,
  isNaturalLanguageText,
  normalizeCoverageRules,
  normalizeHoverTargets,
  normalizeInteractionScenarios,
  reconcileForbiddenContractState,
  findHoverTextPointInPage,
  toggleHover,
  resolveHoverTarget,
  resolveForbiddenMustExistSelectors,
  closeInteractionDialog,
  settleCoverageByReveal,
  validateCoverageRevealStatuses,
  validateCoverageRules,
  validateMutableForbiddenSelectors,
  waitForCoverageReady,
  waitForHostMathRendering,
  waitForStableTarget,
  withMandatoryHeadingCoverage,
} = {
  ...require('../scripts/run-site-translation-test.cjs'),
  ...require('../scripts/site-translation/case-config.cjs'),
} as {
  COVERAGE_EXCLUDED_ANCESTORS: string;
  COVERAGE_PROTECTED_DESCENDANTS: string;
  COVERAGE_TRACKER_KEY: string;
  assertFreshProductionExtension: (extensionDir: string, projectRoot: string) => unknown;
  waitForHostMathRendering: (page: unknown, timeout: number) => Promise<unknown>;
  waitForStableTarget: (page: unknown, selector: string, timeout: number) => Promise<void>;
  findHoverTextPointInPage: (target: {selector: string; index: number; textIncludes?: string[]}) => {x: number; y: number; text: string} | null;
  toggleHover: (page: unknown, target: unknown, config: {selector: string; index: number}, count: number, timeout: number,
    attempt?: number, prepareClickText?: string) => Promise<void>;
  assertPageContract: (
    page: {
      evaluate: (fn: (argument: unknown) => unknown, argument: unknown) => Promise<unknown>;
      url: () => string;
    },
    baseline: Record<string, unknown>,
    requiredSelectors: string[],
    expectedUrl: string,
    phase: string,
  ) => Promise<unknown>;
  assertCoverageReport: (rules: unknown[], report: unknown[], phase: string) => unknown;
  assertCoverageRestoration: (report: unknown[], phase: string) => unknown;
  capturePageContract: (
    page: {evaluate: (fn: (argument: unknown) => unknown, argument: unknown) => Promise<unknown>},
    requiredSelectors: string[],
    forbiddenSelectors: string[],
    interactionSelectors: string[],
    dynamicForbiddenSelectors: string[],
    optionalForbiddenSelectors: string[],
    mutableForbiddenSelectors?: string[],
  ) => Promise<{
    requiredState: Array<Record<string, unknown>>;
    forbiddenState: Array<Record<string, unknown> & {signatures: unknown[]}>;
    interactionState: Array<Record<string, unknown>>;
  }>;
  evaluateProductionBuildFreshness: (input: {
    extensionDir: string;
    manifestMtimeMs: number;
    latestSource: {path: string; mtimeMs: number} | null;
  }) => {ok: boolean; production: boolean};
  installCoverageTracker: (page: {
    evaluate: (fn: (argument: unknown) => unknown, argument: unknown) => Promise<unknown>;
  }, rules: unknown[]) => Promise<void>;
  isNaturalLanguageText: (value: unknown) => boolean;
  normalizeCoverageRules: (rules: unknown[]) => Array<{
    name: string;
    selector: string;
    kind: string;
    minInitial: number;
    minSeen: number;
    trackDynamic: boolean;
    requiresPhrase?: boolean;
    minTextLength?: number;
    sourceIncludes: string[];
    sourcePartition?: {excludeSelectors: string[]};
  }>;
  normalizeHoverTargets: (targets: unknown[], options?: string | {
    fallbackSelector?: string;
    coverageRules?: Array<{name: string; selector: string; sourceIncludes: string[]; sourcePartition?: {excludeSelectors: string[]}}>;
  }) => Array<{
    name: string;
    selector: string;
    index: number;
    sourceIncludes: string[];
    textIncludes?: string[];
    sourcePartition?: {excludeSelectors: string[]};
  }>;
  normalizeInteractionScenarios: (scenarios: unknown[]) => Array<{
    name: string;
    triggerSelector: string;
    openKey: string;
    dialogSelector: string;
    comboboxSelector: string;
    listboxSelector: string;
    inputText: string;
    closeKey: string;
    closeAttempts: number;
  }>;
  reconcileForbiddenContractState: (
    initial: Record<string, unknown>,
    current: Record<string, unknown>,
  ) => string | null;
  resolveHoverTarget: (
    page: {
      evaluate: (fn: (argument: unknown) => unknown, argument: unknown) => Promise<unknown>;
      waitForFunction: (
        fn: (argument: unknown) => unknown,
        argument: unknown,
        options: {timeout: number},
      ) => Promise<unknown>;
    },
    target: {name: string; selector: string; index: number; sourceIncludes: string[]},
    timeout: number,
  ) => Promise<{rawIndex: number; sourceText: string}>;
  resolveForbiddenMustExistSelectors: (
    tier: string,
    forbidden: string[],
    configured?: string[],
    optional?: string[],
  ) => string[];
  closeInteractionDialog: (
    page: {
      keyboard: {press: (key: string) => Promise<void>};
      waitForFunction: (fn: (argument: unknown) => unknown, argument: unknown, options: {timeout: number; polling: number}) => Promise<unknown>;
    },
    scenario: {name: string; triggerSelector: string; dialogSelector: string; closeKey: string; closeAttempts: number},
    timeout: number,
    phase: string,
  ) => Promise<number>;
  settleCoverageByReveal: (
    page: {evaluate: (fn: (argument: unknown) => unknown, argument: unknown) => Promise<unknown>},
    timeout: number,
    phase: string,
    round?: number,
    verifyUnchanged?: (remainingMs?: number) => Promise<void>,
  ) => Promise<unknown[]>;
  validateCoverageRevealStatuses: (statuses: Array<{
    token: string;
    rule: string;
    source: string;
    connected: boolean;
    eligible: boolean;
    translated: boolean;
    loading: boolean;
    retry: boolean;
    reason?: string;
  }>, phase: string) => void;
  validateCoverageRules: (
    caseName: string,
    rules: unknown[],
    options?: {requireExplicit?: boolean; explicitRules?: unknown[]},
  ) => string[];
  validateMutableForbiddenSelectors: (
    caseName: string,
    forbiddenSelectors: string[],
    dynamicForbiddenSelectors: string[],
    mutableForbiddenSelectors: string[],
  ) => void;
  waitForCoverageReady: (
    page: {
      evaluate: (fn: (argument: unknown) => unknown, argument: unknown) => Promise<unknown>;
      waitForFunction: (
        fn: (argument: unknown) => unknown,
        argument: unknown,
        options: {timeout: number},
      ) => Promise<unknown>;
    },
    rules: unknown[],
    timeout: number,
  ) => Promise<void>;
  withMandatoryHeadingCoverage: (rules: unknown[], protectPageHeading?: boolean) => Array<{
    name: string;
    selector: string;
    kind: string;
    minInitial: number;
    minSeen: number;
    trackDynamic: boolean;
    requiresPhrase?: boolean;
  }>;
};
const {
  MATRIX_REQUIREMENTS,
  computeJobTimeoutMs,
  runChildWithWatchdog,
  runJobAttempts,
  validateMatrix,
} = require('../scripts/run-site-translation-matrix.cjs') as {
  MATRIX_REQUIREMENTS: {
    total: number;
    required: number;
    requiredHosts: number;
    quarantine: number;
  };
  computeJobTimeoutMs: (pageTimeout: number, mode: string, override?: number) => number;
  runChildWithWatchdog: (
    command: string,
    values: string[],
    options: {
      timeoutMs: number;
      killGraceMs?: number;
      stdio?: string;
      spawnImpl?: (command: string, values: string[], options: unknown) => EventEmitter & {pid?: number};
      killProcessGroupImpl?: (child: EventEmitter & {pid?: number}, signal: string) => boolean;
    },
  ) => Promise<{ok: boolean; timedOut: boolean; signal: string | null}>;
  runJobAttempts: (
    runAttempt: (attempt: number) => Promise<{ok: boolean; timedOut: boolean}>,
    maxAttempts: number,
  ) => Promise<{ok: boolean; timedOut: boolean; attempts: Array<{ok: boolean; timedOut: boolean}>}>;
  validateMatrix: (caseConfigs?: Record<string, unknown>) => {
    entries: Array<[string, unknown]>;
    required: Array<[string, unknown]>;
    quarantine: Array<[string, unknown]>;
    requiredHosts: Set<string>;
  };
};

describe('site translation coverage contract', () => {
  it('rejects selector unions that can pass after translating only one semantic region', () => {
    const rules = normalizeCoverageRules([{
      name: 'title-or-body',
      selector: 'main h1, .markdown-body p',
      kind: 'content',
      minInitial: 1,
    }]);

    expect(validateCoverageRules('union-case', rules)).toContain(
      'union-case.coverageRules[0] selector 不得包含逗号，请拆成独立覆盖规则',
    );
  });

  it('fails when one translated node hides untranslated siblings', () => {
    const rules = normalizeCoverageRules([{
      name: 'paragraphs',
      selector: '.markdown-body p',
      kind: 'content',
      minInitial: 4,
    }]);
    const report = [{
      name: 'paragraphs',
      seenCount: 4,
      translatedCount: 1,
      sourceSamples: ['one', 'two', 'three', 'four'],
      missedSamples: ['two', 'three', 'four'],
    }];

    expect(() => assertCoverageReport(rules, report, 'test')).toThrow('仅翻译 1/4 个节点');
  });

  it('fails when body content translates but the H1 is missed', () => {
    const rules = normalizeCoverageRules([
      {name: 'title', selector: 'main h1', kind: 'heading', minInitial: 1},
      {name: 'body', selector: '.markdown-body p', kind: 'content', minInitial: 2},
    ]);
    const report = [
      {name: 'title', seenCount: 1, translatedCount: 0, sourceSamples: ['Title'], missedSamples: ['Title']},
      {name: 'body', seenCount: 2, translatedCount: 2, sourceSamples: ['A', 'B'], missedSamples: []},
    ];

    expect(() => assertCoverageReport(rules, report, 'test')).toThrow('title 仅翻译 0/1 个节点');
  });

  it('adds a mandatory dynamic H1 invariant even when a site forgets to declare one', () => {
    const runtimeRules = withMandatoryHeadingCoverage(normalizeCoverageRules([{
      name: 'body',
      selector: 'main p',
      kind: 'content',
      minInitial: 1,
    }]));
    const mandatory = runtimeRules.find(({name}) => name === 'mandatory-visible-latin-h1');

    expect(mandatory).toMatchObject({
      selector: 'h1',
      kind: 'heading',
      minInitial: 0,
      minSeen: 0,
      trackDynamic: true,
      requiresPhrase: true,
    });
    expect(() => assertCoverageReport(runtimeRules, [
      {name: 'body', seenCount: 1, translatedCount: 1, sourceSamples: ['Body'], missedSamples: []},
      {
        name: 'mandatory-visible-latin-h1',
        seenCount: 1,
        translatedCount: 0,
        sourceSamples: ['Forgotten title'],
        missedSamples: ['Forgotten title'],
      },
    ], 'global heading')).toThrow('mandatory-visible-latin-h1 仅翻译 0/1 个节点');
  });

  it('protects a list page H1 only when its forbidden contract explicitly owns that heading', () => {
    const rules = normalizeCoverageRules(cases['github-project-pulls'].coverageRules);
    expect(cases['github-project-pulls'].forbiddenSelectors).toContain('main h1');
    expect(withMandatoryHeadingCoverage(rules).some(({name}) => name === 'mandatory-visible-latin-h1')).toBe(true);
    expect(withMandatoryHeadingCoverage(rules, true)).toEqual(rules);
  });

  it('uses an explicit minimum length for live-site coverage of short product names', () => {
    expect(normalizeCoverageRules(cases['hacker-news-8863'].coverageRules)
      .find(({name}) => name === 'discussion-comments')?.minTextLength).toBe(10);
    const invalidCases = structuredClone(cases) as unknown as Record<string, Record<string, unknown>>;
    const rules = invalidCases['hacker-news-8863'].coverageRules as Array<Record<string, unknown>>;
    rules[1].minTextLength = -1;
    expect(() => validateMatrix(invalidCases)).toThrow('minTextLength 必须是非负整数');
  });

  it('does not count screen-reader-only headings as visible page headings', () => {
    expect(COVERAGE_EXCLUDED_ANCESTORS).toContain('.sr-only');
    expect(COVERAGE_EXCLUDED_ANCESTORS).toContain('.visually-hidden');
    expect(COVERAGE_EXCLUDED_ANCESTORS).toContain('.MathJax_Display');
    expect(COVERAGE_EXCLUDED_ANCESTORS).toContain('mjx-container');
    expect(COVERAGE_EXCLUDED_ANCESTORS).toContain('.katex');
    expect(COVERAGE_PROTECTED_DESCENDANTS).toContain('script');
    expect(COVERAGE_PROTECTED_DESCENDANTS).toContain('.MathJax_Display');
    expect(COVERAGE_PROTECTED_DESCENDANTS).toContain('mjx-container');
    expect(COVERAGE_PROTECTED_DESCENDANTS).toContain('.katex');
  });

  it('rejects code-shaped and technical identifiers without rejecting natural prose or headings', () => {
    expect(isNaturalLanguageText('#!/bin/sh')).toBe(false);
    expect(isNaturalLanguageText('#lang plai-typed')).toBe(false);
    expect(isNaturalLanguageText('<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN">')).toBe(false);
    expect(isNaturalLanguageText('select-stmt: hide')).toBe(false);
    expect(isNaturalLanguageText('select-stmt: 藏起来')).toBe(false);
    expect(isNaturalLanguageText('HTTPS')).toBe(false);
    expect(isNaturalLanguageText('https://science.nasa.gov/webb')).toBe(false);
    expect(isNaturalLanguageText('Read https://science.nasa.gov/webb for details.')).toBe(true);
    expect(isNaturalLanguageText('Referer')).toBe(false);
    expect(isNaturalLanguageText('Introduction')).toBe(true);
    expect(isNaturalLanguageText('WHY')).toBe(true);
    expect(isNaturalLanguageText('The SELECT statement is used to query the database.')).toBe(true);
  });

  it('uses the same natural-language eligibility for readiness, tracking, and hover resolution', async () => {
    const {document, window} = parseHTML(`
      <html><body><main>
        <p>#!/bin/sh</p>
        <p>HTTPS</p>
        <p>The natural paragraph remains an eligible translation target.</p>
        <p>https://science.nasa.gov/webb</p>
      </main></body></html>
    `);
    Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({width: 400, height: 40, top: 0, left: 0, right: 400, bottom: 40}),
    });
    const globals = {
      window,
      document,
      Node: window.Node,
      HTMLElement: window.HTMLElement,
      HTMLAnchorElement: window.HTMLAnchorElement,
      MutationObserver: window.MutationObserver,
      getComputedStyle: () => ({display: 'block', visibility: 'visible'}),
    };
    const previous = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries(globals)) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
    }
    const page = {
      evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => fn(argument),
      waitForFunction: async (
        fn: (argument: unknown) => unknown,
        argument: unknown,
        _options: {timeout: number},
      ) => {
        if (!fn(argument)) throw new Error('predicate did not become true');
      },
    };
    try {
      const rules = normalizeCoverageRules([{
        name: 'paragraphs',
        selector: 'main p',
        kind: 'content',
        minInitial: 1,
        sourceIncludes: ['The natural paragraph remains'],
      }]);
      await expect(waitForCoverageReady(page, rules, 100)).resolves.toBeUndefined();
      await installCoverageTracker(page, rules);
      const tracker = (window as unknown as Record<string, {
        report: () => Array<{name: string; seenCount: number; sourceSamples: string[]}>;
        stop: () => void;
      }>)[COVERAGE_TRACKER_KEY];
      expect(tracker.report()).toContainEqual(expect.objectContaining({
        name: 'paragraphs',
        seenCount: 1,
        sourceSamples: ['The natural paragraph remains an eligible translation target.'],
      }));
      await expect(resolveHoverTarget(page, {
        name: 'paragraph',
        selector: 'main p',
        index: 0,
        sourceIncludes: [],
      }, 100)).resolves.toMatchObject({
        rawIndex: 2,
        sourceText: 'The natural paragraph remains an eligible translation target.',
      });
      tracker.stop();
    } finally {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  it.each([
    ['github-eugeny-issue-list', 'issue-listitem-title-link'],
    ['github-eugeny-issue-list', 'issue-pr-title-link'],
    ['example-com', 'multilingual-paragraphs'],
  ] as const)('uses current %s DOM while retaining legacy resolution and complete coverage (%s)', async (caseId, variant) => {
    const config = cases[caseId];
    const html = caseId === 'example-com'
      ? '<html><head><title>Example Domain</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><svg aria-hidden="true"><path d="M0 0"></path></svg><p lang="zh">该域名仅用于文档示例，无需获得许可。</p><p lang="en">This domain is for use in documentation examples without needing permission.</p><p lang="ar" dir="rtl">هذا النطاق مُخصص للاستخدام في أمثلة التوثيق.</p><p lang="fr">L’usage de ce domaine est réservé à des exemples de documentation.</p><p lang="ru">Данный домен предназначен для использования в примерах документации.</p><p lang="es">Este dominio está destinado al uso en ejemplos de documentación.</p><a href="https://iana.org/help/example-domains">Learn more</a></body></html>'
      : '<html><body><main><section data-testid="issues-list-surface"><a data-testid="' + variant + '" href="/Eugeny/tabby/issues/10084">right click not working</a><span class="IssueLabel">bug</span><div class="Description-module__container"><span>Eugeny/tabby#10084</span><span> · <button data-testid="author-filter-link">kikyoulg</button> opened <relative-time data-testid="issue-activity-timestamp">on Dec 6, 2024</relative-time></span></div></section></main></body></html>';
    const {document, window} = parseHTML(html);
    Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {configurable: true,
      value: () => ({width: 400, height: 40, top: 0, left: 0, right: 400, bottom: 40})});
    const globals = {window, document, Node: window.Node, HTMLElement: window.HTMLElement,
      HTMLAnchorElement: window.HTMLAnchorElement, MutationObserver: window.MutationObserver,
      getComputedStyle: () => ({display: 'block', visibility: 'visible'})};
    const previous = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries(globals)) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
    }
    const page = {evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => fn(argument),
      waitForFunction: async (fn: (argument: unknown) => unknown, argument: unknown) => {
        if (!fn(argument)) throw new Error('coverage was not ready');
      }};
    let tracker: {report: () => Array<{name: string; seenCount: number; sourceSamples: string[]}>; stop: () => void} | undefined;
    try {
      const rules = normalizeCoverageRules(config.coverageRules);
      await expect(waitForCoverageReady(page, rules, 100)).resolves.toBeUndefined();
      await installCoverageTracker(page, rules);
      tracker = (window as unknown as Record<string, typeof tracker>)[COVERAGE_TRACKER_KEY];
      const report = tracker!.report();
      const completed = report.map(state => ({...state, translatedCount: state.seenCount, completedCount: state.seenCount}));
      expect(() => assertCoverageReport(rules, completed, 'all owners')).not.toThrow();
      for (const state of completed) {
        expect(state.seenCount).toBeGreaterThanOrEqual(1);
        expect(() => assertCoverageReport(rules, completed.map(item => item === state
          ? {...item, translatedCount: 0} : item), 'missing owner')).toThrow(state.name);
      }
      const baseline = await capturePageContract(page, config.requiredSelectors, config.forbiddenSelectors,
        config.interactionSelectors, [], []);
      expect(baseline.forbiddenState.every(state => state.signatures.length > 0)).toBe(true);
      const fallbackSelector = 'hoverSelector' in config ? config.hoverSelector : config.selector;
      const [target] = normalizeHoverTargets([], {fallbackSelector, coverageRules: rules});
      const resolved = await resolveHoverTarget(page, target, 100);
      expect(resolved.sourceText).toContain(caseId === 'example-com' ? 'documentation examples' : 'right click not working');
      if (caseId === 'example-com') {
        expect(report).toHaveLength(3);
        expect(document.querySelector('h1')).toBeNull();
        expect(withMandatoryHeadingCoverage(rules).some(rule => rule.name === 'mandatory-visible-latin-h1')).toBe(true);
      }
    } finally {
      tracker?.stop();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  it('reveals each connected missing coverage leaf once and skips a disconnected dynamic record', async () => {
    const {document, window} = parseHTML(`
      <html><body><main>
        <p id="translated">The first natural paragraph already has a translation.</p>
        <p id="missing">The second natural paragraph must receive one visibility opportunity.</p>
        <p id="detached">A virtualized paragraph can leave before the convergence snapshot.</p>
      </main></body></html>
    `);
    Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({width: 400, height: 40, top: 0, left: 0, right: 400, bottom: 40}),
    });
    const revealed: string[] = [];
    Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value(this: HTMLElement) {
        revealed.push(this.id);
      },
    });
    const globals = {
      window,
      document,
      Node: window.Node,
      HTMLElement: window.HTMLElement,
      HTMLAnchorElement: window.HTMLAnchorElement,
      MutationObserver: window.MutationObserver,
      getComputedStyle: () => ({display: 'block', visibility: 'visible'}),
    };
    const previous = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries(globals)) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
    }

    try {
      const translated = document.querySelector('#translated')!;
      const existingWrapper = document.createElement('span');
      existingWrapper.className = 'fluent-read-bilingual-content';
      existingWrapper.setAttribute('data-fr-translation-owned', 'true');
      existingWrapper.textContent = '已有译文';
      translated.append(existingWrapper);

      const page = {evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => fn(argument)};
      const rules = normalizeCoverageRules([{
        name: 'dynamic-paragraphs',
        selector: 'main p',
        kind: 'content',
        minInitial: 3,
        trackDynamic: true,
      }]);
      await installCoverageTracker(page, rules);
      const tracker = (window as unknown as Record<string, {
        snapshotMissing: () => Array<{token: string; source: string}>;
        activateMissing: (token: string) => {found: boolean; reason?: string};
        beginRevealRound: () => void;
        missingStatuses: (tokens: string[]) => Array<{translated: boolean}>;
        stop: () => void;
      }>)[COVERAGE_TRACKER_KEY];

      document.querySelector('#detached')!.remove();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const batch = tracker.snapshotMissing();
      expect(batch).toHaveLength(1);
      expect(batch[0]?.source).toContain('second natural paragraph');

      const token = batch[0]!.token;
      expect(tracker.activateMissing(token)).toMatchObject({found: true});
      expect(revealed).toEqual(['missing']);
      expect(tracker.activateMissing(token)).toMatchObject({found: false, reason: 'already-activated'});
      tracker.beginRevealRound();
      expect(tracker.activateMissing(token)).toMatchObject({found: true});
      expect(revealed).toEqual(['missing', 'missing']);

      const missing = document.querySelector('#missing')!;
      const wrapper = document.createElement('span');
      wrapper.className = 'fluent-read-bilingual-content';
      wrapper.setAttribute('data-fr-translation-owned', 'true');
      wrapper.textContent = '新的译文';
      missing.append(wrapper);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(tracker.snapshotMissing()).toEqual([]);
      expect(tracker.missingStatuses([token])).toEqual([
        expect.objectContaining({translated: true}),
      ]);
      missing.remove();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(tracker.missingStatuses([token])).toEqual([
        expect.objectContaining({connected: false, translated: true}),
      ]);
      tracker.stop();
    } finally {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  it.each([
    ['Division', '/', '（', '除法（'],
    ['Logical NOT', '!a', 'LOGICAL NOT (', '逻辑非（'],
  ] as const)('keeps Swift %s paragraph and list coverage strict until the actual owner has Chinese prose', async (label, code, invalid, translated) => {
    const {document, window} = parseHTML(`<html><body><main><ul><li id="owner"><p id="target">${label} (<code>${code}</code>)</p></li><li><p id="neighbor">Unary operators operate on a single target.</p></li><li><p id="other-a">Another independent operator explanation.</p></li><li><p id="other-b">Assignment stores a value in the target variable.</p></li><li><p id="other-c">Comparison produces a Boolean result for two values.</p></li></ul></main></body></html>`);
    Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {configurable: true,
      value: () => ({width: 400, height: 40, top: 0, left: 0, right: 400, bottom: 40})});
    const globals = {window, document, Node: window.Node, HTMLElement: window.HTMLElement,
      HTMLAnchorElement: window.HTMLAnchorElement, MutationObserver: window.MutationObserver,
      getComputedStyle: () => ({display: 'block', visibility: 'visible'})};
    const previous = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries(globals)) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
    }
    type Tracker = {report: () => Array<{name: string; seenCount: number; translatedCount: number}>;
      snapshotMissing: () => Array<{token: string; source: string}>;
      missingStatuses: (tokens: string[]) => Parameters<typeof validateCoverageRevealStatuses>[0];
      reset: () => void; restorationReport: () => unknown[]; stop: () => void};
    let tracker: Tracker | undefined;
    try {
      const rules = normalizeCoverageRules(cases['swift-basic-operators'].coverageRules)
        .filter(rule => ['chapter-paragraphs', 'chapter-list-items'].includes(rule.name));
      const page = {evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => fn(argument)};
      const target = document.querySelector('#target')!;
      const original = target.innerHTML;
      const originalCode = target.querySelector('code');
      const append = (owner: Element, text: string) => {
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.textContent = text;
        owner.append(wrapper);
        return wrapper;
      };
      // A sibling's Chinese wrapper certifies only that sibling and its own li.
      const neighbors = ['neighbor', 'other-a', 'other-b', 'other-c'].map(id => document.getElementById(id)!);
      const neighborWrappers = neighbors.map(owner => append(owner, '另一段说明'));
      await installCoverageTracker(page, rules);
      tracker = (window as unknown as Record<string, Tracker>)[COVERAGE_TRACKER_KEY];
      const tokens = tracker.snapshotMissing().map(status => status.token);
      expect(tokens).toHaveLength(2);
      expect(tracker.snapshotMissing().map(status => status.source)).toEqual([`${label} ()`, `${label} ()`]);
      const checkCounts = (count: number) => {
        expect(tracker!.report().map(state => ({name: state.name, seen: state.seenCount, translated: state.translatedCount})))
          .toEqual([{name: 'chapter-paragraphs', seen: 5, translated: count},
            {name: 'chapter-list-items', seen: 5, translated: count}]);
      };
      checkCounts(4);
      const bad = append(target, `${invalid}${code})`);
      checkCounts(4);
      expect(() => validateCoverageRevealStatuses(tracker!.missingStatuses(tokens), 'swift invalid output')).toThrow(/missing-wrapper/u);
      const retry = document.createElement('span');
      retry.className = 'fluent-read-retry-wrapper';
      retry.setAttribute('data-fr-translation-owned', 'true');
      target.append(retry);
      expect(() => validateCoverageRevealStatuses(tracker!.missingStatuses(tokens), 'swift retry')).toThrow(/terminal-retry/u);
      retry.remove();
      bad.remove();
      const good = append(target, `${translated}${code})`);
      checkCounts(5);
      expect(() => assertCoverageReport(rules, tracker!.report(), 'swift all owners')).not.toThrow();
      expect(() => validateCoverageRevealStatuses(tracker!.missingStatuses(tokens), 'swift translated')).not.toThrow();
      good.remove();
      neighborWrappers.forEach(wrapper => wrapper.remove());
      expect(target.innerHTML).toBe(original);
      expect(target.querySelector('code')).toBe(originalCode);
      expect(() => assertCoverageRestoration(tracker!.restorationReport(), 'swift restored')).not.toThrow();
      tracker.reset();
      checkCounts(0);
      // The second pass still requires new owned wrappers; no stale translatedEver credit.
      expect(() => validateCoverageRevealStatuses(tracker!.missingStatuses(tracker!.snapshotMissing().map(status => status.token)), 'swift second pass')).toThrow(/missing-wrapper/u);
      append(target, `${translated}${code})`);
      neighbors.forEach(owner => append(owner, '第二次另一段说明'));
      checkCounts(5);
      expect(() => assertCoverageReport(rules, tracker!.report(), 'swift second pass all owners')).not.toThrow();
    } finally {
      tracker?.stop();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  it('accepted unchanged evidence does not certify Chinese wrapper coverage in the original contract', () => {
    const evidence = {status: 'available', reason: 'accepted-result-identical', sources: ['Spec'], outputs: ['Spec']};
    const status = {token: '1:6:0', rule: 'headings', source: 'Spec',
      connected: true, eligible: true, translated: false, loading: false, retry: false, completion: evidence};
    expect(() => validateCoverageRevealStatuses([status], 'original68'))
      .toThrow(/missing-wrapper/u);
    expect(() => assertCoverageReport([{name: 'headings', minSeen: 1, sourceIncludes: []}], [{name: 'headings',
      seenCount: 1, translatedCount: 0, completedCount: 1, verifiedUnchangedCount: 1}], 'original68'))
      .toThrow(/仅翻译/u);
  });

  it('keeps terminal retry, disconnect and untranslated outcomes strict after a reveal pass', () => {
    const base = {
      token: '0:1:0',
      rule: 'paragraphs',
      source: 'Natural prose remains untranslated.',
      connected: true,
      eligible: true,
      translated: false,
      loading: false,
      retry: false,
    };
    expect(() => validateCoverageRevealStatuses([{...base, retry: true}], 'coverage'))
      .toThrow(/terminal-retry/u);
    expect(() => validateCoverageRevealStatuses([{...base, connected: false}], 'coverage'))
      .toThrow(/disconnected|missing-wrapper/u);
    expect(() => validateCoverageRevealStatuses([{...base, translated: true}], 'coverage'))
      .not.toThrow();
  });

  it('does not let an old wrapper certify a new dynamic source generation', async () => {
    const {document, window} = parseHTML(`
      <html><body><main><p id="target">The original natural paragraph is translated.</p></main></body></html>
    `);
    Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({width: 400, height: 40, top: 0, left: 0, right: 400, bottom: 40}),
    });
    let observer: {
      emit: (records: MutationRecord[]) => void;
      disconnect: () => void;
    } | undefined;
    class ControlledMutationObserver {
      constructor(private readonly callback: MutationCallback) {
        observer = this;
      }

      observe() {}
      disconnect() {}
      emit(records: MutationRecord[]) {
        this.callback(records, this as unknown as MutationObserver);
      }
    }
    const globals = {
      window,
      document,
      Node: window.Node,
      HTMLElement: window.HTMLElement,
      HTMLAnchorElement: window.HTMLAnchorElement,
      MutationObserver: ControlledMutationObserver,
      getComputedStyle: () => ({display: 'block', visibility: 'visible'}),
    };
    const previous = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries(globals)) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
    }

    try {
      const target = document.querySelector('#target')!;
      const oldWrapper = document.createElement('span');
      oldWrapper.className = 'fluent-read-bilingual-content';
      oldWrapper.setAttribute('data-fr-translation-owned', 'true');
      oldWrapper.textContent = '旧译文';
      target.append(oldWrapper);
      const page = {evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => fn(argument)};
      const rules = normalizeCoverageRules([{
        name: 'dynamic-source',
        selector: 'main p',
        kind: 'content',
        minInitial: 1,
        trackDynamic: true,
      }]);
      await installCoverageTracker(page, rules);
      const tracker = (window as unknown as Record<string, {
        report: () => Array<{
          seenCount: number;
          dynamicSeenCount: number;
          translatedCount: number;
          missedSamples: string[];
        }>;
        snapshotMissing: () => Array<{source: string}>;
        stop: () => void;
      }>)[COVERAGE_TRACKER_KEY];
      expect(tracker.report()[0]).toMatchObject({seenCount: 1, dynamicSeenCount: 0, translatedCount: 1});

      const sourceNode = target.firstChild!;
      sourceNode.nodeValue = 'The replacement natural paragraph requires a fresh translation.';
      observer!.emit([{
        type: 'characterData',
        target: sourceNode,
        addedNodes: [] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      } as unknown as MutationRecord]);
      expect(tracker.report()[0]).toMatchObject({seenCount: 1, dynamicSeenCount: 1, translatedCount: 0});
      expect(tracker.snapshotMissing()).toEqual([
        expect.objectContaining({source: 'The replacement natural paragraph requires a fresh translation.'}),
      ]);

      oldWrapper.remove();
      const newWrapper = document.createElement('span');
      newWrapper.className = 'fluent-read-bilingual-content';
      newWrapper.setAttribute('data-fr-translation-owned', 'true');
      newWrapper.textContent = '新译文';
      target.append(newWrapper);
      observer!.emit([{
        type: 'childList',
        target,
        addedNodes: [newWrapper] as unknown as NodeList,
        removedNodes: [oldWrapper] as unknown as NodeList,
      } as unknown as MutationRecord]);
      expect(tracker.report()[0]).toMatchObject({
        seenCount: 1,
        dynamicSeenCount: 1,
        translatedCount: 1,
        missedSamples: [],
      });
      tracker.stop();
    } finally {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  it('fails before an unbounded reveal loop when a page has too many missing leaves', async () => {
    const batch = Array.from({length: 257}, (_, index) => ({
      token: `0:${index}:0`,
      rule: 'paragraphs',
      source: `Natural paragraph ${index}`,
      connected: true,
      eligible: true,
      translated: false,
      loading: false,
      retry: false,
    }));
    const page = {
      evaluate: vi.fn(async () => batch),
    };
    await expect(settleCoverageByReveal(page, 60_000, 'coverage'))
      .rejects.toThrow(/有界唤醒上限/u);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  it('budgets one bounded translation poll per missing leaf before the shared idle wait', async () => {
    const batch = Array.from({length: 100}, (_, index) => ({
      token: `0:${index}:0`,
      rule: 'paragraphs',
      source: `Natural paragraph ${index}`,
      connected: true,
      eligible: true,
      translated: false,
      loading: false,
      retry: false,
    }));
    let now = Date.parse('2026-09-16T00:00:00Z');
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let snapshots = 0;
    const page = {
      evaluate: vi.fn(async (_fn: unknown, argument: unknown) => {
        if (argument === COVERAGE_TRACKER_KEY) return snapshots++ === 0 ? batch : undefined;
        if (typeof argument === 'string') return [];
        const request = argument as {token?: string; requestedTokens?: string[]};
        if (request.token) return {found: true, token: request.token, alreadyTranslated: false};
        return request.requestedTokens!.map((token) => ({...batch[Number(token.split(':')[1])], translated: true}));
      }),
      // 模拟每个叶节点耗尽可见窗口；批次预算必须覆盖全部 100 个节点。
      waitForFunction: vi.fn(async (_fn: unknown, _argument: unknown, options?: {timeout?: number}) => {
        if (options?.timeout === 2000) now += 2000;
      }),
    };
    try {
      const statuses = await settleCoverageByReveal(page, 60_000, 'coverage');
      expect(statuses).toHaveLength(100);
      expect(page.waitForFunction).toHaveBeenCalledTimes(101);
      expect(page.waitForFunction.mock.calls.filter(([, , options]) => options?.timeout === 2000)).toHaveLength(100);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('revisits only remaining leaves after slow requests release the translation queue', async () => {
    const batch = ['0:0:0', '0:1:0'].map(token => ({
      token, rule: 'paragraphs', source: `Natural paragraph ${token}`, connected: true,
      eligible: true, translated: false, loading: false, retry: false,
    }));
    let round = 0;
    const page = {
      evaluate: vi.fn(async (fn: Function, argument: unknown) => {
        if (argument === COVERAGE_TRACKER_KEY) {
          if (fn.toString().includes('snapshotMissing')) return round++ === 0 ? batch : [batch[1]];
          return undefined;
        }
        if (typeof argument === 'string') return [];
        const request = argument as {token?: string; requestedTokens?: string[]};
        if (request.token) return {found: true, token: request.token, alreadyTranslated: false};
        return request.requestedTokens!.map(token => ({...batch[Number(token.split(':')[1])],
          translated: round > 1 || token === batch[0].token}));
      }),
      waitForFunction: vi.fn(async () => undefined),
    };
    const statuses = await settleCoverageByReveal(page, 60_000, 'coverage');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({token: batch[1].token, translated: true});
    expect(round).toBe(2);
  });

  it('normalizes only adjacent Text runs around protected MathJax roots', async () => {
    const {document, window} = parseHTML(`
      <html><body><main>
        <p id="math">Perspective prose appears before <span class="MathJax_Preview">x + y</span><script type="math/tex">x + y</script> and after the formula.</p>
        <p id="outer-structure">Outer prose <em>structure</em> must remain exactly as it started.<span class="MathJax_Preview">z</span><script type="math/tex">z</script></p>
        <p id="outer-text">Outer prose text must remain exactly as it started.</p>
      </main></body></html>
    `);
    Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({width: 400, height: 40, top: 0, left: 0, right: 400, bottom: 40}),
    });
    let observer: {
      emit: (records: MutationRecord[]) => void;
      disconnect: () => void;
    } | undefined;
    class ControlledMutationObserver {
      constructor(private readonly callback: MutationCallback) {
        observer = this;
      }

      observe() {}
      disconnect() {}
      emit(records: MutationRecord[]) {
        this.callback(records, this as unknown as MutationObserver);
      }
    }
    const globals = {
      window,
      document,
      Node: window.Node,
      HTMLElement: window.HTMLElement,
      HTMLAnchorElement: window.HTMLAnchorElement,
      MutationObserver: ControlledMutationObserver,
      getComputedStyle: () => ({display: 'block', visibility: 'visible'}),
    };
    const previous = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries(globals)) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
    }

    try {
      const page = {evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => fn(argument)};
      const rules = normalizeCoverageRules([{
        name: 'static-paragraphs',
        selector: 'main p',
        kind: 'content',
        minInitial: 3,
        trackDynamic: false,
      }]);
      await installCoverageTracker(page, rules);
      const tracker = (window as unknown as Record<string, {
        metrics: () => Record<string, number>;
        restorationReport: () => Array<{
          name: string;
          changedCount: number;
          changedSamples: Array<{source: string; current: string; initialStructure: string; currentStructure: string}>;
        }>;
        stop: () => void;
      }>)[COVERAGE_TRACKER_KEY];

      const math = document.querySelector('#math')!;
      const preview = math.querySelector('.MathJax_Preview')!;
      const oldScript = math.querySelector('script[type^="math/tex"]')!;
      preview.remove();
      oldScript.remove();
      // MathJax v2 在用最终 Display/script 对替换 Preview/script 根节点时，
      // 可能同时合并正文 Text 节点。
      math.normalize();
      const display = document.createElement('div');
      display.className = 'MathJax_Display';
      display.innerHTML = '<span class="MathJax">rendered formula</span>';
      const nextScript = document.createElement('script');
      nextScript.setAttribute('type', 'math/tex; mode=display');
      nextScript.textContent = 'x + y';
      math.append(display, nextScript);
      observer!.emit([{
        type: 'childList',
        target: math,
        addedNodes: [display, nextScript] as unknown as NodeList,
        removedNodes: [preview, oldScript] as unknown as NodeList,
      } as unknown as MutationRecord]);

      const afterMath = tracker.restorationReport()[0]!;
      expect(afterMath).toMatchObject({changedCount: 0});
      expect(tracker.metrics()).toMatchObject({
        ignoredProtectedMutationCount: 1,
        hostMutationCount: 0,
      });
      expect(() => assertCoverageRestoration([afterMath], 'MathJax restore')).not.toThrow();

      const outerStructure = document.querySelector('#outer-structure')!;
      const emphasized = outerStructure.querySelector('em')!;
      const strong = document.createElement('strong');
      strong.textContent = emphasized.textContent;
      emphasized.replaceWith(strong);
      const structurePreview = outerStructure.querySelector('.MathJax_Preview')!;
      const structureScript = outerStructure.querySelector('script[type^="math/tex"]')!;
      structurePreview.remove();
      structureScript.remove();
      outerStructure.normalize();
      const structureDisplay = document.createElement('div');
      structureDisplay.className = 'MathJax_Display';
      const nextStructureScript = document.createElement('script');
      nextStructureScript.setAttribute('type', 'math/tex; mode=display');
      nextStructureScript.textContent = 'z';
      outerStructure.append(structureDisplay, nextStructureScript);
      observer!.emit([{
        type: 'childList',
        target: outerStructure,
        addedNodes: [strong] as unknown as NodeList,
        removedNodes: [emphasized] as unknown as NodeList,
      } as unknown as MutationRecord, {
        type: 'childList',
        target: outerStructure,
        addedNodes: [structureDisplay, nextStructureScript] as unknown as NodeList,
        removedNodes: [structurePreview, structureScript] as unknown as NodeList,
      } as unknown as MutationRecord]);

      const outerText = document.querySelector('#outer-text')!;
      const outerTextNode = outerText.firstChild!;
      outerTextNode.nodeValue = 'Outer prose text changed outside every protected subtree.';
      observer!.emit([{
        type: 'characterData',
        target: outerTextNode,
        addedNodes: [] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      } as unknown as MutationRecord]);

      const strict = tracker.restorationReport()[0]!;
      expect(strict).toMatchObject({changedCount: 2});
      expect(strict.changedSamples).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: 'Outer prose structure must remain exactly as it started.',
          initialStructure: expect.stringContaining('"em"'),
          currentStructure: expect.stringContaining('"strong"'),
        }),
        expect.objectContaining({source: 'Outer prose text must remain exactly as it started.'}),
      ]));
      expect(tracker.metrics()).toMatchObject({
        ignoredProtectedMutationCount: 2,
        hostMutationCount: 2,
      });
      expect(() => assertCoverageRestoration([strict], 'outer prose restore'))
        .toThrow(/有 2 个节点未恢复/u);
      tracker.stop();
    } finally {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  it('does not recompute large MathML topology for 150 extension artifact mutations', async () => {
    const {document, window} = parseHTML('<html><body><main></main></body></html>');
    const main = document.querySelector('main')!;
    for (let index = 0; index < 100; index += 1) {
      const paragraph = document.createElement('p');
      paragraph.append(`Natural language paragraph ${index} has enough words for coverage. `);
      const math = document.createElement('span');
      math.className = 'MathJax';
      for (let depth = 0; depth < 20; depth += 1) {
        const nested = document.createElement('span');
        nested.textContent = `formula-${index}-${depth}`;
        math.append(nested);
      }
      paragraph.append(math);
      main.append(paragraph);
    }

    Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({width: 400, height: 40, top: 0, left: 0, right: 400, bottom: 40}),
    });
    const style = () => ({display: 'block', visibility: 'visible'});
    const globals = {
      window,
      document,
      Node: window.Node,
      HTMLElement: window.HTMLElement,
      HTMLAnchorElement: window.HTMLAnchorElement,
      MutationObserver: window.MutationObserver,
      getComputedStyle: style,
    };
    const previous = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries(globals)) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
    }

    try {
      const page = {evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => fn(argument)};
      const rules = normalizeCoverageRules([{
        name: 'large-math-paragraphs',
        selector: 'main p',
        kind: 'content',
        minInitial: 100,
        trackDynamic: true,
      }]);
      await installCoverageTracker(page, rules);
      const tracker = (window as unknown as Record<string, {
        metrics: () => Record<string, number>;
        report: () => Array<{name: string; seenCount: number; dynamicSeenCount: number}>;
        restorationReport: () => unknown;
        stop: () => void;
      }>)[COVERAGE_TRACKER_KEY];
      const initial = tracker.metrics();
      expect(initial.initialStructureSignatureCalls).toBe(100);
      expect(initial.structureSignatureCalls).toBe(100);

      const paragraphs = [...document.querySelectorAll('main p')];
      for (let index = 0; index < 150; index += 1) {
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.textContent = '译文';
        paragraphs[index % paragraphs.length].append(wrapper);
        wrapper.remove();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));

      const afterArtifacts = tracker.metrics();
      expect(afterArtifacts.artifactMutationCount).toBeGreaterThanOrEqual(150);
      expect(afterArtifacts.dynamicStructureSignatureCalls).toBe(0);
      expect(afterArtifacts.structureSignatureCalls).toBe(100);

      const replacement = document.createElement('p');
      replacement.append('A newly rendered paragraph contains natural prose and an embedded formula. ');
      const replacementMath = document.createElement('span');
      replacementMath.className = 'MathJax';
      replacementMath.textContent = 'x + y';
      replacement.append(replacementMath);
      paragraphs[0].replaceWith(replacement);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const afterHostReplacement = tracker.metrics();
      expect(afterHostReplacement.dynamicStructureSignatureCalls).toBe(1);
      expect(tracker.report()).toContainEqual(expect.objectContaining({
        name: 'large-math-paragraphs',
        seenCount: 101,
        dynamicSeenCount: 1,
      }));

      tracker.restorationReport();
      const restored = tracker.metrics();
      expect(restored.restorationStructureSignatureCalls).toBe(100);
      expect(restored.structureSignatureCalls).toBe(201);
      tracker.stop();
    } finally {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  it('tracks host prose mounted in the same childList record as an extension artifact', async () => {
    const {document, window} = parseHTML(`
      <html><body><main>
        <p id="initial">Initial natural language paragraph remains eligible.</p>
      </main></body></html>
    `);
    Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({width: 400, height: 40, top: 0, left: 0, right: 400, bottom: 40}),
    });

    let observer: {
      emit: (records: MutationRecord[]) => void;
      disconnect: () => void;
    } | undefined;
    class ControlledMutationObserver {
      constructor(private readonly callback: MutationCallback) {
        observer = this;
      }

      observe() {}
      disconnect() {}
      emit(records: MutationRecord[]) {
        this.callback(records, this as unknown as MutationObserver);
      }
    }
    const globals = {
      window,
      document,
      Node: window.Node,
      HTMLElement: window.HTMLElement,
      HTMLAnchorElement: window.HTMLAnchorElement,
      MutationObserver: ControlledMutationObserver,
      getComputedStyle: () => ({display: 'block', visibility: 'visible'}),
    };
    const previous = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries(globals)) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
    }

    try {
      const page = {evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => fn(argument)};
      const rules = normalizeCoverageRules([{
        name: 'dynamic-prose',
        selector: 'main p',
        kind: 'content',
        minInitial: 1,
        minSeen: 2,
        trackDynamic: true,
      }]);
      await installCoverageTracker(page, rules);
      const tracker = (window as unknown as Record<string, {
        metrics: () => Record<string, number>;
        report: () => Array<{name: string; seenCount: number; dynamicSeenCount: number}>;
        stop: () => void;
      }>)[COVERAGE_TRACKER_KEY];

      const main = document.querySelector('main')!;
      const artifact = document.createElement('span');
      artifact.className = 'fluent-read-bilingual-content';
      artifact.setAttribute('data-fr-translation-owned', 'true');
      artifact.textContent = '译文';
      const late = document.createElement('p');
      late.textContent = 'Late host paragraph must not hide behind an artifact mutation.';
      main.append(artifact, late);
      observer!.emit([{
        type: 'childList',
        target: main,
        addedNodes: [artifact, late] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      } as unknown as MutationRecord]);

      expect(tracker.metrics()).toMatchObject({hostMutationCount: 1, dynamicStructureSignatureCalls: 1});
      expect(tracker.report()).toContainEqual(expect.objectContaining({
        name: 'dynamic-prose',
        seenCount: 2,
        dynamicSeenCount: 1,
      }));
      tracker.stop();
    } finally {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  it('rejects stale production output but does not apply the production mtime gate to dev output', () => {
    const latestSource = {path: '/repo/src/features/full-page-translation/content/runtime.ts', mtimeMs: 200};
    expect(evaluateProductionBuildFreshness({
      extensionDir: '/repo/.output/chrome-mv3',
      manifestMtimeMs: 100,
      latestSource,
    })).toMatchObject({ok: false, production: true});
    expect(evaluateProductionBuildFreshness({
      extensionDir: '/repo/.output/chrome-mv3-dev',
      manifestMtimeMs: 100,
      latestSource,
    })).toMatchObject({ok: true, production: false});
  });

  it('includes migrated src files in the actual production freshness scan', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'fluentread-freshness-test-'));
    const extensionDir = join(projectRoot, '.output', 'chrome-mv3');
    const sourceDir = join(projectRoot, 'src', 'features');
    try {
      mkdirSync(extensionDir, {recursive: true});
      mkdirSync(sourceDir, {recursive: true});
      const manifest = join(extensionDir, 'manifest.json');
      const source = join(sourceDir, 'runtime.ts');
      writeFileSync(manifest, '{}');
      writeFileSync(source, '// changed runtime');
      utimesSync(manifest, 100, 100);
      utimesSync(source, 200, 200);
      expect(() => assertFreshProductionExtension(extensionDir, projectRoot)).toThrow('拒绝测试旧 production extension');
      utimesSync(manifest, 300, 300);
      expect(() => assertFreshProductionExtension(extensionDir, projectRoot)).not.toThrow();
    } finally {
      rmSync(projectRoot, {recursive: true, force: true});
    }
  });

  it('reveals layout-preserving hidden entrance content before waiting for visibility', async () => {
    const {document} = parseHTML('<html><body><li hidden><p>Entrance content remains translatable.</p></li></body></html>');
    const paragraph = document.querySelector('p')!;
    Object.defineProperty(paragraph, 'getBoundingClientRect', {value: () => ({width: 400, height: 40})});
    vi.stubGlobal('document', document);
    vi.stubGlobal('getComputedStyle', () => ({display: 'block', visibility: 'visible'}));
    let revealed = false;
    const scroll = vi.fn(async () => {
      revealed = true;
      paragraph.parentElement!.removeAttribute('hidden');
    });
    const page = {
      waitForSelector: vi.fn(async () => undefined),
      evaluate: async (fn: (arg: string) => unknown, arg: string) => fn(arg),
      waitForFunction: async (fn: (arg: string) => boolean, arg: string) => {
        expect(revealed).toBe(true);
        expect(fn(arg)).toBe(true);
      },
      locator: () => ({nth: () => ({scrollIntoViewIfNeeded: scroll})}),
      waitForTimeout: vi.fn(async () => undefined),
    };
    try {
      await waitForStableTarget(page, 'p', 100);
      expect(scroll).toHaveBeenCalled();
      expect(document.querySelector('[hidden]')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('aims at original text instead of heading padding, permalink text, or appended translations', () => {
    const {document} = parseHTML('<html><body><h1><a href="#heading">¶</a><span>Everything you would expect</span><span data-fr-translation-owned="true">所有译文</span></h1></body></html>');
    const original = document.querySelector('h1 > span')!;
    const permalink = document.querySelector('a')!;
    let covered = false;
    Object.defineProperty(document, 'createRange', {value: () => {
      let parent: Node | null;
      return {
        selectNodeContents(node: Node) { parent = node.parentNode; },
        getClientRects: () => [{left: parent === permalink ? 500 : 20, right: parent === permalink ? 700 : 220,
          top: 140, bottom: 160, width: 200, height: 20}],
      };
    }});
    Object.defineProperty(document, 'elementFromPoint', {
      value: (x: number) => covered ? document.body : x > 400 ? permalink : original,
    });
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', {innerWidth: 1280, innerHeight: 900});
    vi.stubGlobal('getComputedStyle', () => ({display: 'inline', visibility: 'visible'}));
    try {
      expect(findHoverTextPointInPage({selector: 'h1', index: 0})).toMatchObject({
        x: 90, y: 150, text: 'Everything you would expect',
      });
      covered = true;
      expect(findHoverTextPointInPage({selector: 'h1', index: 0})).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('targets the explicit original body Text instead of a descendant H2 and rechecks changed text', () => {
    const {document} = parseHTML('<html><body><div id="body"><h2>About This Game</h2><strong>Many ways to play.</strong><br><span id="prose">When it comes to diversity of heroes, every player can find a role.</span></div></body></html>');
    let textParent: Element | null = null;
    Object.defineProperty(document, 'createRange', {value: () => ({
      selectNodeContents(node: Node) {textParent = node.parentElement;},
      getClientRects: () => [{left: 20, right: 220, top: 140, bottom: 160, width: 200, height: 20}],
    })});
    Object.defineProperty(document, 'elementFromPoint', {value: () => textParent});
    vi.stubGlobal('document', document);vi.stubGlobal('window', {innerWidth: 1280, innerHeight: 900});
    vi.stubGlobal('getComputedStyle', () => ({display: 'inline', visibility: 'visible'}));
    try {
      expect(findHoverTextPointInPage({selector: '#body', index: 0})?.text).toBe('About This Game');
      const config = {selector: '#body', index: 0, textIncludes: ['When it comes to diversity of heroes']};
      expect(findHoverTextPointInPage(config)?.text).toBe('When it comes to diversity of heroes, every player can find a role.');
      document.querySelector('#prose')!.textContent = 'A different source replaced the intended body.';
      expect(findHoverTextPointInPage(config)).toBeNull();
      document.querySelector('#body')!.innerHTML = '<h2>About This Game</h2>';
      expect(findHoverTextPointInPage(config)).toBeNull();
    } finally {vi.unstubAllGlobals();}
  });

  function steamTopicHoverFixture(mode = 'transparent') {
    const {document} = parseHTML('<html><body><div id="AppHubContent"><div class="forum_topics">' +
      '<div id="topic" class="forum_topic" role="button" data-gidforumtopic="123456">' +
      '<a id="steam-overlay" class="forum_topic_overlay" href="https://steamcommunity.com/app/570/discussions/0/123456/">\n\t</a>' +
      '<div id="steam-title" class="forum_topic_name"><span class="forum_topic_label">Pinned:</span> A readable discussion title</div></div>' +
      '<div id="other-topic" class="forum_topic" role="button" data-gidforumtopic="654321">' +
      '<a id="other-overlay" class="forum_topic_overlay" href="https://steamcommunity.com/app/570/discussions/0/654321/"> </a>' +
      '<div class="forum_topic_name">Another discussion title</div></div></div></div>' +
      '<div id="steam-dialog" role="dialog">Sign in</div><div id="steam-mask"></div></body></html>');
    const row = document.querySelector('#topic')!;
    const title = document.querySelector('#steam-title')!;
    const overlay = document.querySelector('#steam-overlay')!;
    const dialog = document.querySelector('#steam-dialog')!;
    const mask = document.querySelector('#steam-mask')!;
    if (mode === 'overlay-text') overlay.textContent = 'Click here';
    if (mode === 'overlay-child') overlay.innerHTML = '<span></span>';
    if (mode === 'overlay-comment') overlay.append(document.createComment('not text'));
    if (mode === 'wrong-topic') overlay.setAttribute('href', 'https://steamcommunity.com/app/570/discussions/0/654321/');
    if (mode === 'wrong-app') overlay.setAttribute('href', 'https://steamcommunity.com/app/571/discussions/0/123456/');
    if (mode === 'external-href') overlay.setAttribute('href', 'https://example.com/app/570/discussions/0/123456/');
    if (mode === 'query-href') overlay.setAttribute('href', '/app/570/discussions/0/123456/?foo=bar');
    if (mode === 'hash-href') overlay.setAttribute('href', '/app/570/discussions/0/123456/#comment');
    if (mode === 'javascript-href') overlay.setAttribute('href', 'javascript:alert(1)');
    if (mode === 'missing-id') row.removeAttribute('data-gidforumtopic');
    if (mode === 'invalid-id') row.setAttribute('data-gidforumtopic', 'not-a-number');
    if (mode === 'duplicate-overlay') row.prepend(overlay.cloneNode(true));
    if (mode === 'nested-title') title.innerHTML = '<span>A readable discussion title</span>';
    if (mode === 'dialog-ancestor') document.querySelector('#AppHubContent')!.setAttribute('role', 'dialog');
    if (mode === 'editor-row') row.setAttribute('contenteditable', 'true');
    if (mode === 'modal-row') row.setAttribute('aria-modal', 'true');
    if (mode === 'wrong-row-role') row.setAttribute('role', 'dialog');
    if (mode === 'hidden-row') row.setAttribute('hidden', '');
    if (mode === 'hidden-overlay') overlay.setAttribute('aria-hidden', 'true');
    if (mode === 'inert-overlay') overlay.setAttribute('inert', '');
    if (mode === 'owned-overlay') overlay.setAttribute('data-fr-translation-owned', 'true');
    const candidate = mode === 'cross-row' ? document.querySelector('#other-overlay')! : overlay;
    let covered = mode === 'dialog';
    const stack = () => covered ? [dialog, candidate, title, row] : mode === 'intervening-mask' ? [candidate, mask, title, row] :
      mode === 'missing-title' ? [candidate, row] : [candidate, title, row];
    Object.defineProperty(document, 'createRange', {value: () => ({
      selectNodeContents: vi.fn(),
      getClientRects: () => [{left: 20, right: 220, top: 140, bottom: 160, width: 200, height: 20}],
    })});
    Object.defineProperty(document, 'elementFromPoint', {value: () => stack()[0]});
    Object.defineProperty(document, 'elementsFromPoint', {value: stack});
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', {innerWidth: 1280, innerHeight: 900});
    vi.stubGlobal('innerWidth', 1280);
    vi.stubGlobal('innerHeight', 900);
    vi.stubGlobal('location', new URL(mode === 'other-host' ? 'https://example.com/app/570/discussions/' :
      mode === 'other-app' ? 'https://steamcommunity.com/app/571/discussions/' :
        mode === 'thread-path' ? 'https://steamcommunity.com/app/570/discussions/0/123456/' :
          mode === 'page-query' ? 'https://steamcommunity.com/app/570/discussions/?p=2' :
            'https://steamcommunity.com/app/570/discussions/'));
    vi.stubGlobal('getComputedStyle', (element: Element, pseudo?: string) => pseudo ? {
      content: (mode === 'overlay-pseudo' && element === overlay || mode === 'title-pseudo' && element === title ||
        mode === 'row-pseudo' && element === row) ? '"x"' : 'none',
    } : {
      display: mode === 'display-none' && element === overlay ? 'none' : 'block',
      visibility: mode === 'invisible' && element === overlay ? 'hidden' : 'visible',
      opacity: mode === 'opacity' && element === overlay ? '0.5' : '1',
      pointerEvents: mode === 'pointer-events-none' && element === overlay ? 'none' : 'auto',
      position: mode === 'non-absolute' && element === overlay ? 'relative' : 'absolute',
      backgroundColor: mode === 'opaque' && element === overlay ? 'rgb(255, 255, 255)' : 'rgba(0, 0, 0, 0)',
      backgroundImage: mode === 'background-image' && element === overlay ? 'url("cover.png")' : 'none',
      boxShadow: mode === 'shadow' && element === overlay ? '0 0 4px black' : 'none',
      filter: mode === 'filter' && element === overlay ? 'blur(1px)' : 'none',
      backdropFilter: mode === 'backdrop' && element === overlay ? 'blur(1px)' : 'none',
      borderTopWidth: mode === 'border' && element === overlay ? '1px' : '0px',
      borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
      outlineWidth: mode === 'outline' && element === overlay ? '1px' : '0px',
    });
    return {document, cover: () => {covered = true;}, changeDestination: () => {overlay.setAttribute('href', '/app/570/discussions/0/654321/');}};
  }

  it('accepts the observed Steam discussion title through its own empty overlay and waits for stability', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const {document} = steamTopicHoverFixture();
    const html = document.body.innerHTML;
    const page = {
      evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
      mouse: {move: vi.fn()}, keyboard: {down: vi.fn(), up: vi.fn()},
      waitForTimeout: async (ms: number) => {vi.advanceTimersByTime(ms);}, waitForFunction: vi.fn(),
    };
    try {
      expect(findHoverTextPointInPage({selector: '#steam-title', index: 0})).toMatchObject({
        x: 90, y: 150, text: ' A readable discussion title',
        hitPolicy: 'steam-community-topic-overlay:["https://steamcommunity.com/app/570/discussions/0/123456/","123456"]',
      });
      await toggleHover(page, hoverScrollTarget(), {selector: '#steam-title', index: 0}, 1, 500);
      expect(Date.now()).toBeGreaterThanOrEqual(200);
      expect(page.keyboard.down.mock.calls).toEqual([['Control']]);
      expect(page.keyboard.up.mock.calls).toEqual([['Control']]);
      expect(document.body.innerHTML).toBe(html);
    } finally {vi.unstubAllGlobals(); vi.useRealTimers();}
  });

  it.each(['overlay-text', 'overlay-child', 'overlay-comment', 'wrong-topic', 'wrong-app', 'external-href', 'query-href',
    'hash-href', 'javascript-href', 'missing-id', 'invalid-id', 'duplicate-overlay', 'nested-title', 'dialog-ancestor',
    'editor-row', 'modal-row', 'wrong-row-role', 'hidden-row', 'hidden-overlay', 'inert-overlay', 'owned-overlay',
    'cross-row', 'dialog', 'intervening-mask', 'missing-title', 'other-host', 'other-app', 'thread-path', 'page-query',
    'display-none', 'invisible', 'opacity', 'pointer-events-none', 'non-absolute', 'opaque', 'background-image',
    'shadow', 'filter', 'backdrop', 'border', 'outline', 'overlay-pseudo', 'title-pseudo', 'row-pseudo'])
  ('rejects the Steam topic overlay exception for %s', mode => {
    const {document} = steamTopicHoverFixture(mode);
    const html = document.body.innerHTML;
    try {
      expect(findHoverTextPointInPage({selector: '#steam-title', index: 0})).toBeNull();
      expect(document.body.innerHTML).toBe(html);
    } finally {vi.unstubAllGlobals();}
  });

  it.each(['cover', 'changeDestination'] as const)
  ('rechecks Steam topic overlay after pointer movement and sends no hotkey for %s', async action => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const fixture = steamTopicHoverFixture();
    const page = {
      evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
      mouse: {move: vi.fn(async () => {fixture[action]();})}, keyboard: {down: vi.fn(), up: vi.fn()},
      waitForTimeout: async (ms: number) => {vi.advanceTimersByTime(ms);},
    };
    try {
      await expect(toggleHover(page, hoverScrollTarget(),
        {selector: '#steam-title', index: 0}, 1, 300)).rejects.toThrow('悬浮原文没有稳定且可命中的位置');
      expect(page.mouse.move).toHaveBeenCalledOnce();
      expect(page.keyboard.down).not.toHaveBeenCalled();
      expect(page.keyboard.up).not.toHaveBeenCalled();
    } finally {vi.unstubAllGlobals(); vi.useRealTimers();}
  });

  function googleNewsHoverFixture(mode = 'transparent') {
    // 双层内容壳来自 wave32 保存的实际 Google News 首页卡片，非自由祖先匹配。
    const nested = mode.startsWith('nested-card');
    const headline = '<a id="headline" href="./read/fixture-story?hl=en-US" target="_blank">A readable headline from the current card</a>';
    const content = nested ? `<div id="content-shell" class="B6pJDd"><div id="headline-parent" class="IL9Cne"><div class="MCAGUe">Fixture publisher</div>${headline}</div></div>` :
      `<div>Fixture publisher</div>${headline}<time>2 hours ago</time>`;
    const {document} = parseHTML('<html><body><main><section>' +
      '<div id="card" class="m5k28"><div id="stretch" class="XlKvRb"><a id="news-overlay" class="WwrzSb" href="./read/fixture-story?hl=en-US" target="_blank" aria-hidden="true" tabindex="-1"></a></div>' +
      content + (nested ? '<figure class="K0q4G" role="presentation" aria-hidden="true"></figure>' : '') + '</div>' +
      '<div><div id="other-stretch"><a id="other-news-overlay" href="./read/fixture-story?hl=en-US" target="_blank" aria-hidden="true" tabindex="-1"></a></div><a href="./read/fixture-story?hl=en-US" target="_blank">A different card</a></div>' +
      '</section></main><div id="news-dialog" role="dialog">Sign in</div><div id="other-mask"></div></body></html>');
    const target = document.querySelector('#headline')!;
    const overlay = document.querySelector('#news-overlay')!;
    const wrapper = document.querySelector('#stretch')!;
    const card = document.querySelector('#card')!;
    const dialog = document.querySelector('#news-dialog')!;
    const mask = document.querySelector('#other-mask')!;
    let covered = mode === 'dialog';
    if (mode === 'text-in-overlay') overlay.textContent = 'A covering label';
    if (mode === 'child-in-overlay') overlay.innerHTML = '<span></span>';
    if (mode === 'extra-wrapper-text') wrapper.append(' ');
    if (mode === 'extra-wrapper-node') wrapper.append(document.createElement('span'));
    if (mode === 'different-href') overlay.setAttribute('href', './read/different-story?hl=en-US');
    if (mode === 'different-query') overlay.setAttribute('href', './read/fixture-story?hl=fr');
    if (mode === 'different-target') overlay.setAttribute('target', '_self');
    if (mode === 'missing-target') target.removeAttribute('target');
    if (mode === 'wrong-tabindex') overlay.setAttribute('tabindex', '0');
    if (mode === 'missing-aria-hidden') overlay.removeAttribute('aria-hidden');
    if (mode === 'topic-link') {target.setAttribute('href', './topics/fixture'); overlay.setAttribute('href', './topics/fixture');}
    if (mode === 'nested-title') target.innerHTML = '<span>A readable headline from the current card</span>';
    if (mode === 'dialog-ancestor') card.setAttribute('role', 'dialog');
    if (mode === 'editor-ancestor') card.setAttribute('contenteditable', 'true');
    if (mode === 'textbox-ancestor') card.setAttribute('role', 'textbox');
    if (mode === 'button-wrapper') wrapper.setAttribute('role', 'button');
    if (mode === 'hidden-ancestor') card.setAttribute('aria-hidden', 'true');
    if (mode === 'hidden-overlay') overlay.setAttribute('hidden', '');
    if (mode === 'inert-overlay') overlay.setAttribute('inert', '');
    if (mode === 'owned-overlay') overlay.setAttribute('data-fr-translation-owned', 'true');
    if (mode === 'not-first-wrapper') card.prepend(document.createElement('span'));
    if (mode === 'nested-card-extra-title') {
      const extra = document.createElement('a');
      extra.setAttribute('href', './read/another-story'); extra.textContent = 'Another title'; card.append(extra);
    }
    if (mode === 'nested-card-extra-shell-child') document.querySelector('#content-shell')!.append(document.createElement('div'));
    if (mode === 'nested-card-title-not-last') target.parentElement!.append(document.createElement('span'));
    if (mode === 'nested-card-intervening-sibling') wrapper.after(document.createElement('div'));
    if (mode === 'nested-card-cross-card') document.querySelector('#other-news-overlay')!.parentElement!.replaceWith(wrapper);
    if (mode === 'nested-card-different-href') overlay.setAttribute('href', './read/another-story');
    if (mode === 'nested-card-dialog') card.setAttribute('role', 'dialog');
    if (mode === 'nested-card-button') wrapper.setAttribute('role', 'button');
    if (mode === 'nested-card-parent-button') target.parentElement!.setAttribute('role', 'button');
    if (mode === 'nested-card-hidden') card.setAttribute('aria-hidden', 'true');
    if (mode === 'nested-card-too-deep') {
      let owner = card;
      for (let index = 0; index < 130; index += 1) {
        const parent = document.createElement('div');
        owner.replaceWith(parent); parent.appendChild(owner); owner = parent;
      }
    }
    const candidateOverlay = mode === 'cross-card' ? document.querySelector('#other-news-overlay')! : overlay;
    const stack = () => covered ? [dialog, overlay, wrapper, target] :
      mode === 'intervening-mask' ? [candidateOverlay, mask, wrapper, target] :
        mode === 'missing-headline' ? [candidateOverlay, wrapper, card] :
          mode === 'stack-disagrees' ? [mask, candidateOverlay, wrapper, target] : [candidateOverlay, candidateOverlay.parentElement, target, card];
    Object.defineProperty(document, 'createRange', {value: () => ({
      selectNodeContents: vi.fn(),
      getClientRects: () => [{left: 20, right: 220, top: 140, bottom: 160, width: 200, height: 20}],
    })});
    Object.defineProperty(document, 'elementFromPoint', {value: () => mode === 'stack-disagrees' ? candidateOverlay : stack()[0]});
    Object.defineProperty(document, 'elementsFromPoint', {value: stack});
    Object.defineProperty(target, 'getBoundingClientRect', {value: () => ({
      x: 20, y: 140, left: 20, right: 220, top: 140, bottom: 160, width: 200, height: 20,
    })});
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', {innerWidth: 1280, innerHeight: 900});
    vi.stubGlobal('innerWidth', 1280);
    vi.stubGlobal('innerHeight', 900);
    vi.stubGlobal('location', new URL(mode === 'other-host' ? 'https://example.com/home' :
      mode === 'other-subdomain' ? 'https://www.news.google.com/home' :
        mode === 'search-path' ? 'https://news.google.com/search' :
          mode === 'article-path' ? 'https://news.google.com/read/fixture-story' : 'https://news.google.com/home?hl=en-US'));
    vi.stubGlobal('getComputedStyle', (element: Element, pseudo?: string) => {
      if (mode === 'nested-card-style-unavailable' && element.localName === 'section') throw new Error('style unavailable');
      if (mode === 'nested-card-style-missing' && element.localName === 'section') return null;
      if (mode === 'nested-card-target-style-unavailable' && element === target && !pseudo) throw new Error('style unavailable');
      return pseudo ? {
      content: mode === 'nested-card-shell-pseudo' && element.id === 'content-shell' ||
        mode === 'nested-card-parent-pseudo' && element.id === 'headline-parent' ||
        mode === 'overlay-pseudo' && element === overlay || mode === 'wrapper-pseudo' && element === wrapper ||
        mode === 'headline-pseudo' && element === target || mode === 'card-pseudo' && element === card ? '""' : 'none',
    } : {
      display: mode === 'nested-card-section-display-none' && element.localName === 'section' ? 'none' : 'block',
      visibility: mode === 'nested-card-section-visibility-hidden' && element.localName === 'section' ? 'hidden' : 'visible',
      opacity: mode === 'nested-card-shell-transparent' && element.id === 'content-shell' ||
        mode === 'nested-card-parent-transparent' && element.id === 'headline-parent' ||
        mode === 'nested-card-target-transparent' && element === target ||
        mode === 'nested-card-card-transparent' && element === card ||
        mode === 'nested-card-section-transparent' && element.localName === 'section' ? '0' :
          mode === 'nested-card-section-opacity-invalid' && element.localName === 'section' ? 'invalid' : '1',
      position: mode === 'static-overlay' && element === overlay || mode === 'static-wrapper' && element === wrapper ? 'static' : 'absolute',
      left: mode === 'offset-overlay' && element === overlay ? '1px' : '0px', right: '0px', top: '0px', bottom: '0px',
      backgroundColor: mode === 'opaque-overlay' && element === overlay || mode === 'opaque-wrapper' && element === wrapper ? 'rgb(255, 255, 255)' : 'rgba(0, 0, 0, 0)',
      backgroundImage: mode === 'background-image' && element === overlay ? 'url("cover.png")' : 'none',
      boxShadow: mode === 'shadow' && element === wrapper ? '0 0 4px black' : 'none',
      filter: mode === 'filter' && element === wrapper ? 'blur(1px)' : 'none',
      backdropFilter: mode === 'backdrop' && element === overlay ? 'blur(1px)' : 'none',
      borderTopWidth: mode === 'border' && element === overlay ? '1px' : '0px',
      borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
      outlineWidth: mode === 'outline' && element === wrapper ? '1px' : '0px',
      };
    });
    return {document, cover: () => {covered = true;}, changeDestination: () => {overlay.setAttribute('href', './read/changed-after-pointer');}};
  }

  function hoverScrollTarget() {
    return {
      scrollIntoViewIfNeeded: async () => undefined,
      evaluate: async (fn: (node: {scrollIntoView: (options: unknown) => void}) => unknown) =>
        fn({scrollIntoView: () => undefined}),
    };
  }

  it('uses only the observed Google News empty same-destination link stack, preserving host DOM and 200ms stability', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const {document} = googleNewsHoverFixture();
    const html = document.body.innerHTML;
    const page = {
      evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
      mouse: {move: vi.fn()}, keyboard: {down: vi.fn(), up: vi.fn()},
      waitForTimeout: async (ms: number) => {vi.advanceTimersByTime(ms);}, waitForFunction: vi.fn(),
    };
    try {
      expect(findHoverTextPointInPage({selector: '#headline', index: 0})).toMatchObject({
        x: 90, y: 150, text: 'A readable headline from the current card',
        hitPolicy: 'google-news-stretched-link:["./read/fixture-story?hl=en-US","_blank"]',
      });
      await toggleHover(page, hoverScrollTarget(), {selector: '#headline', index: 0}, 1, 500);
      expect(Date.now()).toBeGreaterThanOrEqual(200);
      expect(page.keyboard.down.mock.calls).toEqual([['Control']]);
      expect(page.keyboard.up.mock.calls).toEqual([['Control']]);
      expect(document.body.innerHTML).toBe(html);
    } finally {vi.unstubAllGlobals(); vi.useRealTimers();}
  });

  it('accepts the observed nested Google News card without clicking its overlay', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const {document} = googleNewsHoverFixture('nested-card');
    const html = document.body.innerHTML;
    const page = {
      evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
      mouse: {move: vi.fn(), click: vi.fn()}, keyboard: {down: vi.fn(), up: vi.fn()},
      waitForTimeout: async (ms: number) => {vi.advanceTimersByTime(ms);}, waitForFunction: vi.fn(),
    };
    try {
      expect(findHoverTextPointInPage({selector: '#headline', index: 0})).toMatchObject({
        hitPolicy: 'google-news-stretched-link:["./read/fixture-story?hl=en-US","_blank"]',
      });
      await toggleHover(page, hoverScrollTarget(), {selector: '#headline', index: 0}, 1, 500);
      expect(Date.now()).toBeGreaterThanOrEqual(200);
      expect(page.mouse.click).not.toHaveBeenCalled();
      expect(page.keyboard.down.mock.calls).toEqual([['Control']]);
      expect(page.keyboard.up.mock.calls).toEqual([['Control']]);
      expect(document.body.innerHTML).toBe(html);
    } finally {vi.unstubAllGlobals(); vi.useRealTimers();}
  });

  it.each(['nested-card-extra-title', 'nested-card-extra-shell-child', 'nested-card-title-not-last',
    'nested-card-intervening-sibling', 'nested-card-cross-card', 'nested-card-different-href',
    'nested-card-dialog', 'nested-card-button', 'nested-card-parent-button', 'nested-card-hidden',
    'nested-card-shell-transparent', 'nested-card-parent-transparent', 'nested-card-target-transparent',
    'nested-card-card-transparent', 'nested-card-section-transparent', 'nested-card-section-display-none',
    'nested-card-section-visibility-hidden', 'nested-card-section-opacity-invalid', 'nested-card-style-unavailable',
    'nested-card-style-missing', 'nested-card-target-style-unavailable', 'nested-card-too-deep', 'nested-card-shell-pseudo',
    'nested-card-parent-pseudo'])('rejects an unsafe nested Google News card: %s', mode => {
    const {document} = googleNewsHoverFixture(mode);
    const html = document.body.innerHTML;
    try {
      expect(findHoverTextPointInPage({selector: '#headline', index: 0})).toBeNull();
      expect(document.body.innerHTML).toBe(html);
    } finally {vi.unstubAllGlobals();}
  });

  it.each(['cover', 'changeDestination'] as const)
  ('rechecks the nested Google News card after pointer movement for %s', async action => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const fixture = googleNewsHoverFixture('nested-card');
    const page = {
      evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
      mouse: {move: vi.fn(async () => {fixture[action]();}), click: vi.fn()},
      keyboard: {down: vi.fn(), up: vi.fn()},
      waitForTimeout: async (ms: number) => {vi.advanceTimersByTime(ms);},
    };
    try {
      await expect(toggleHover(page, hoverScrollTarget(),
        {selector: '#headline', index: 0}, 1, 300)).rejects.toThrow('悬浮原文没有稳定且可命中的位置');
      expect(page.mouse.click).not.toHaveBeenCalled();
      expect(page.keyboard.down).not.toHaveBeenCalled();
      expect(page.keyboard.up).not.toHaveBeenCalled();
    } finally {vi.unstubAllGlobals(); vi.useRealTimers();}
  });

  it.each(['text-in-overlay', 'child-in-overlay', 'extra-wrapper-text', 'extra-wrapper-node', 'different-href',
    'different-query', 'different-target', 'missing-target', 'wrong-tabindex', 'missing-aria-hidden', 'topic-link',
    'nested-title', 'dialog', 'dialog-ancestor', 'editor-ancestor', 'textbox-ancestor', 'button-wrapper',
    'hidden-ancestor', 'hidden-overlay', 'inert-overlay', 'owned-overlay', 'not-first-wrapper', 'cross-card',
    'intervening-mask', 'missing-headline', 'stack-disagrees', 'other-host', 'other-subdomain', 'search-path', 'article-path',
    'opaque-overlay', 'opaque-wrapper', 'static-overlay', 'static-wrapper', 'offset-overlay', 'background-image',
    'shadow', 'filter', 'backdrop', 'border', 'outline', 'overlay-pseudo', 'wrapper-pseudo', 'headline-pseudo', 'card-pseudo'])
  ('rejects the Google News stretched-link exception for %s', mode => {
    const {document} = googleNewsHoverFixture(mode);
    const html = document.body.innerHTML;
    try {
      expect(findHoverTextPointInPage({selector: '#headline', index: 0})).toBeNull();
      expect(document.body.innerHTML).toBe(html);
    } finally {vi.unstubAllGlobals();}
  });

  it.each(['cover', 'changeDestination'] as const)
  ('rechecks Google News after pointer movement and sends zero hotkeys for %s', async action => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fixture = googleNewsHoverFixture();
    const page = {
      evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
      mouse: {move: vi.fn(async () => {fixture[action]();})}, keyboard: {down: vi.fn(), up: vi.fn()},
      waitForTimeout: async (ms: number) => {vi.advanceTimersByTime(ms);},
    };
    try {
      await expect(toggleHover(page, hoverScrollTarget(),
        {selector: '#headline', index: 0}, 1, 300)).rejects.toThrow('悬浮原文没有稳定且可命中的位置');
      expect(page.mouse.move).toHaveBeenCalledOnce();
      expect(page.keyboard.down).not.toHaveBeenCalled();
      expect(page.keyboard.up).not.toHaveBeenCalled();
    } finally {vi.unstubAllGlobals(); vi.useRealTimers();}
  });

  function productHuntHoverFixture(mode = 'transparent') {
    const {document} = parseHTML('<html><body><main><div data-test="homepage-section-today">' +
      '<section data-container><div><span><a href="/products/first"><span id="overlay" data-target="true"></span>1. First Product</a></span>' +
      '<span id="tagline">Build useful tools with your team.</span></div></section>' +
      '<section data-container><div><span><a href="/products/second"><span id="other-overlay" data-target="true"></span>2. Other Product</a></span>' +
      '<span>Another introduction.</span></div></section></div></main>' +
      '<div id="dialog" role="dialog">Sign in</div><button id="button">Vote</button><span id="text-overlay">Covering text</span></body></html>');
    const target = document.querySelector('#tagline')!;
    const overlay = document.querySelector('#overlay')!;
    const dialog = document.querySelector('#dialog')!;
    const button = document.querySelector('#button')!;
    const textOverlay = document.querySelector('#text-overlay')!;
    let covered = mode === 'dialog';
    if (mode === 'text-in-overlay') overlay.textContent = 'Covering text';
    if (mode === 'dialog-ancestor') document.querySelector('main')!.setAttribute('role', 'dialog');
    const emptyOverlay = mode === 'cross-card' ? document.querySelector('#other-overlay')! : overlay;
    const stack = () => covered ? [dialog, overlay, target] : mode === 'button' ? [button, overlay, target] :
      mode === 'intervening-text' ? [emptyOverlay, textOverlay, target] :
        mode === 'missing-text-parent' ? [emptyOverlay, document.body] : [emptyOverlay, target, target.parentElement];
    Object.defineProperty(document, 'createRange', {value: () => ({
      selectNodeContents: vi.fn(),
      getClientRects: () => [{left: 20, right: 220, top: 140, bottom: 160, width: 200, height: 20}],
    })});
    Object.defineProperty(document, 'elementFromPoint', {value: () => stack()[0]});
    Object.defineProperty(document, 'elementsFromPoint', {value: stack});
    Object.defineProperty(target, 'getBoundingClientRect', {value: () => ({
      x: 20, y: 140, left: 20, right: 220, top: 140, bottom: 160, width: 200, height: 20,
    })});
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', {innerWidth: 1280, innerHeight: 900});
    vi.stubGlobal('innerWidth', 1280);
    vi.stubGlobal('innerHeight', 900);
    vi.stubGlobal('location', new URL(mode === 'other-host' ? 'https://example.com/' :
      mode === 'other-subdomain' ? 'https://help.producthunt.com/' :
        mode === 'detail-path' ? 'https://www.producthunt.com/products/first' : 'https://www.producthunt.com/'));
    vi.stubGlobal('getComputedStyle', (element: Element, pseudo?: string) => pseudo ? {
      content: mode === 'painted-pseudo' && element === overlay && pseudo === '::before' ? '""' : 'none',
    } : {
      display: 'inline', visibility: 'visible', position: 'absolute',
      left: '0px', right: '0px', top: '0px', bottom: '0px',
      backgroundColor: mode === 'opaque' && element === overlay ? 'rgb(255, 255, 255)' : 'rgba(0, 0, 0, 0)',
      backgroundImage: 'none', boxShadow: 'none', filter: 'none', backdropFilter: 'none',
      borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px', outlineWidth: '0px',
    });
    return {document, target, cover: () => {covered = true;}};
  }

  it('finds Product Hunt introduction text beneath only its observed empty stretched product link without changing the host DOM', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const {document} = productHuntHoverFixture();
    const html = document.body.innerHTML;
    const page = {
      evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
      mouse: {move: vi.fn()}, keyboard: {down: vi.fn(), up: vi.fn()},
      waitForTimeout: async (ms: number) => {vi.advanceTimersByTime(ms);},
      waitForFunction: vi.fn(),
    };
    try {
      expect(findHoverTextPointInPage({selector: '#tagline', index: 0})).toMatchObject({
        x: 90, y: 150, text: 'Build useful tools with your team.', hitPolicy: 'product-hunt-stretched-link',
      });
      await toggleHover(page, hoverScrollTarget(), {selector: '#tagline', index: 0}, 1, 500);
      expect(page.keyboard.down.mock.calls).toEqual([['Control']]);
      expect(page.keyboard.up.mock.calls).toEqual([['Control']]);
      expect(document.body.innerHTML).toBe(html);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it.each(['opaque', 'dialog', 'dialog-ancestor', 'button', 'text-in-overlay', 'intervening-text',
    'other-host', 'other-subdomain', 'detail-path', 'cross-card', 'missing-text-parent', 'painted-pseudo'])
  ('rejects a Product Hunt stretched-link exception for %s', (mode) => {
    const {document} = productHuntHoverFixture(mode);
    const html = document.body.innerHTML;
    try {
      expect(findHoverTextPointInPage({selector: '#tagline', index: 0})).toBeNull();
      expect(document.body.innerHTML).toBe(html);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rechecks the Product Hunt hit stack after moving the pointer and sends no hotkey through a newly shown dialog', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const {document, cover} = productHuntHoverFixture();
    const html = document.body.innerHTML;
    const page = {
      evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
      mouse: {move: vi.fn(async () => {cover();})}, keyboard: {down: vi.fn(), up: vi.fn()},
      waitForTimeout: async (ms: number) => {vi.advanceTimersByTime(ms);},
    };
    try {
      await expect(toggleHover(page, hoverScrollTarget(),
        {selector: '#tagline', index: 0}, 1, 300)).rejects.toThrow('悬浮原文没有稳定且可命中的位置');
      expect(page.mouse.move).toHaveBeenCalledOnce();
      expect(page.keyboard.down).not.toHaveBeenCalled();
      expect(page.keyboard.up).not.toHaveBeenCalled();
      expect(document.body.innerHTML).toBe(html);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it.each([
    'What is a Frontend Developer?',
    '<strong>What is a Frontend Developer?</strong>',
  ])('requires the original text Range of a decorated collapsible h2 even when its outer-box hit is valid: %s', async (label) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const {document} = parseHTML(`<html><body><main><h2 aria-expanded="false" class="flex select-none"><span class="flex grow"><svg aria-hidden="true"><title>Information</title></svg>${label}</span><span><svg aria-hidden="true"></svg></span></h2></main><aside>Cookie panel</aside></body></html>`);
    const heading = document.querySelector('h2')!;
    const source = document.querySelector('h2 > span')!;
    const cookie = document.querySelector('aside')!;
    const originalHtml = heading.outerHTML;
    let covered = true;
    Object.defineProperty(document, 'createRange', {value: () => ({
      selectNodeContents: vi.fn(),
      getClientRects: () => [{left: 199, right: 400, top: 558, bottom: 575, width: 201, height: 17}],
    })});
    Object.defineProperty(document, 'elementFromPoint', {
      value: (x: number) => covered && x < 480 ? cookie : source,
    });
    Object.defineProperty(document, 'elementsFromPoint', {value: (x: number) =>
      covered && x < 480 ? [cookie, document.body] : [source, heading, heading.parentElement]});
    Object.defineProperty(heading, 'getBoundingClientRect', {value: () => ({
      x: 169, y: 548, left: 169, right: 1103, top: 548, bottom: 585.2890625, width: 934, height: 37.2890625,
    })});
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', {innerWidth: 1272, innerHeight: 816});
    vi.stubGlobal('innerWidth', 1272);
    vi.stubGlobal('innerHeight', 816);
    vi.stubGlobal('getComputedStyle', () => ({display: 'flex', visibility: 'visible'}));
    const page = {
      evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
      mouse: {move: vi.fn()}, keyboard: {down: vi.fn(), up: vi.fn()},
      waitForTimeout: async (ms: number) => { vi.advanceTimersByTime(ms); },
    };
    try {
      // 实际诊断只检测 H2 宽外框的 35% 点；该点在遮挡文字的面板右侧。
      expect(document.elementFromPoint(169 + 934 * 0.35, 548 + 37.2890625 / 2)).toBe(source);
      expect(findHoverTextPointInPage({selector: 'main h2', index: 0})).toBeNull();
      const error = await toggleHover(page, hoverScrollTarget(),
        {selector: 'main h2', index: 0}, 1, 200, 1).catch((failure: Error) => failure);
      expect(error).toBeInstanceOf(Error);
      const diagnostics = JSON.parse((error as Error).message.split('：')[1]);
      expect(diagnostics.lastPoint).toBeNull();
      expect(diagnostics.targetState.hitStack[0].tag).toBe('SPAN');
      expect(diagnostics.targetState.textRangeSamples.find((sample: {text: string}) =>
        sample.text === 'What is a Frontend Developer?')).toMatchObject({
        excluded: false, display: 'flex', visibility: 'visible',
        rects: [{x: 269.35, y: 566.5, hit: {tag: 'ASIDE', insideTarget: false, containsTextParent: false}}],
      });
      expect(page.mouse.move).not.toHaveBeenCalled();
      expect(page.keyboard.down).not.toHaveBeenCalled();
      expect(page.keyboard.up).not.toHaveBeenCalled();
      covered = false;
      expect(findHoverTextPointInPage({selector: 'main h2', index: 0})).toMatchObject({
        x: 269.35, y: 566.5, text: 'What is a Frontend Developer?',
      });
      expect(heading.outerHTML).toBe(originalHtml);
      expect(heading.getAttribute('aria-expanded')).toBe('false');
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('rechecks a declared late cookie button using one native click before the unchanged h2 hotkey', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const point = {x: 269.35, y: 566.5, textIndex: 1, text: 'What is a Frontend Developer?',
      rect: {left: 199, top: 558, width: 201, height: 17}};
    let dismissed = false;
    const button = {
      isVisible: vi.fn(async () => Date.now() >= 100 && !dismissed),
      click: vi.fn(async ({timeout}: {timeout: number}) => {
        expect(timeout).toBe(900);
        vi.advanceTimersByTime(60);
        dismissed = true;
      }),
      waitFor: vi.fn(async (options: unknown) => {
        expect(options).toEqual({state: 'hidden', timeout: 840});
        vi.advanceTimersByTime(10);
      }),
    };
    const target = {...hoverScrollTarget(), scrollIntoViewIfNeeded: vi.fn(async () => undefined)};
    const down = vi.fn(async () => { expect(Date.now()).toBeGreaterThanOrEqual(370); });
    const page = {
      evaluate: vi.fn(async () => Date.now() >= 100 && !dismissed ? null : point),
      getByText: vi.fn(() => ({filter: (options: unknown) => {
        expect(options).toEqual({visible: true});return {last: () => button};
      }})),
      mouse: {move: vi.fn(async () => undefined)},
      keyboard: {down, up: vi.fn(async () => undefined)},
      waitForTimeout: async (ms: number) => { vi.advanceTimersByTime(ms); },
      waitForFunction: vi.fn(async () => undefined),
    };
    try {
      await toggleHover(page, target, {selector: 'main h2', index: 0}, 1, 1000, 1, 'Reject All');
      expect(page.getByText.mock.calls).toEqual([['Reject All', {exact: true}]]);
      expect(button.click).toHaveBeenCalledOnce();
      expect(button.waitFor).toHaveBeenCalledOnce();
      expect(page.mouse.move.mock.calls).toEqual([[point.x, point.y], [point.x, point.y]]);
      expect(down.mock.calls).toEqual([['Control']]);
      expect(page.keyboard.up.mock.calls).toEqual([['Control']]);
      expect(page.waitForFunction.mock.calls[0]?.slice(1)).toEqual([
        {targetSelector: 'main h2', targetIndex: 0, count: 1}, {timeout: 1000},
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])('chooses the visible declared cookie button when a duplicate is hidden (hidden first: %s)', async hiddenFirst => {
    vi.useFakeTimers();vi.setSystemTime(0);
    const {document} = parseHTML('<html><body><button>Reject All</button><button hidden>Reject All</button></body></html>');
    const visible = document.querySelector('button:not([hidden])')!;
    const hidden = document.querySelector('button[hidden]')!;
    if (hiddenFirst) document.body.prepend(hidden);
    const clicked: Element[] = [];
    const point = {x: 100, y: 120, textIndex: 0, text: 'What is a Frontend Developer?',
      rect: {left: 20, top: 110, width: 220, height: 20}};
    const locator = (nodes: Element[]): any => ({
      filter: ({visible: onlyVisible}: {visible: boolean}) => locator(nodes.filter(node => !onlyVisible || !node.hasAttribute('hidden'))),
      last: () => {
        const node = nodes.at(-1);
        return {isVisible: async () => Boolean(node && !node.hasAttribute('hidden')),
          click: async () => {if (!node || node.hasAttribute('hidden')) throw Error('hidden action');clicked.push(node);node.setAttribute('hidden', '');},
          waitFor: async () => {expect(node?.hasAttribute('hidden')).toBe(true);}};
      },
    });
    const page = {evaluate: async () => visible.hasAttribute('hidden') ? point : null,
      getByText: (text: string) => locator([...document.querySelectorAll('button')].filter(node => node.textContent === text)),
      mouse: {move: vi.fn()}, keyboard: {down: vi.fn(), up: vi.fn()},
      waitForFunction: vi.fn(), waitForTimeout: async (ms: number) => {vi.advanceTimersByTime(ms);}};
    try {
      await toggleHover(page, hoverScrollTarget(), {selector: 'main h2', index: 0}, 1, 1000, 1, 'Reject All');
      expect(clicked).toEqual([visible]);expect(hidden.hasAttribute('hidden')).toBe(true);
      expect(page.keyboard.down.mock.calls).toEqual([['Control']]);
      expect(page.keyboard.up.mock.calls).toEqual([['Control']]);
    } finally {vi.useRealTimers();}
  });

  it('charges late cookie preparation to the existing pointer deadline and sends no hotkey without 200ms stability', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const point = {x: 269.35, y: 566.5, textIndex: 1, text: 'What is a Frontend Developer?',
      rect: {left: 199, top: 558, width: 201, height: 17}};
    let dismissed = false;
    const button = {
      isVisible: vi.fn(async () => Date.now() >= 800 && !dismissed),
      click: vi.fn(async ({timeout}: {timeout: number}) => {
        expect(timeout).toBe(200);
        vi.advanceTimersByTime(150);
        dismissed = true;
      }),
      waitFor: vi.fn(async (options: unknown) => {
        expect(options).toEqual({state: 'hidden', timeout: 50});
        vi.advanceTimersByTime(25);
      }),
    };
    const page = {
      evaluate: vi.fn(async (fn: unknown) => fn === findHoverTextPointInPage ? dismissed ? point : null : {}),
      getByText: vi.fn(() => ({filter: (options: unknown) => {
        expect(options).toEqual({visible: true});return {last: () => button};
      }})),
      mouse: {move: vi.fn(async () => undefined)},
      keyboard: {down: vi.fn(), up: vi.fn()},
      waitForTimeout: async (ms: number) => { vi.advanceTimersByTime(ms); },
      waitForFunction: vi.fn(),
    };
    try {
      await expect(toggleHover(page, hoverScrollTarget(),
        {selector: 'main h2', index: 0}, 1, 1000, 1, 'Reject All'))
        .rejects.toThrow('悬浮原文没有稳定且可命中的位置');
      expect(button.click).toHaveBeenCalledOnce();
      expect(Date.now()).toBe(1025); // 原有 50ms 轮询最多跨过预算一次；未重启截止时间。
      expect(page.keyboard.down).not.toHaveBeenCalled();
      expect(page.keyboard.up).not.toHaveBeenCalled();
      expect(page.waitForFunction).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])('centers native text under a sticky title and keeps persistent occlusion blocking (%s)', async staysCovered => {
    vi.useFakeTimers();vi.setSystemTime(0);
    const {document, window} = parseHTML('<html><body><header id="sticky">Native sticky title</header><main><p>Run using <code>npm run serve</code></p></main></body></html>');
    const original = document.body.innerHTML;
    const paragraph = document.querySelector('p')!;
    const sticky = document.querySelector('header')!;
    let top = 17;
    const rect = () => ({left: 69, right: 140, top, bottom: top + 17, width: 71, height: 17});
    Object.defineProperty(paragraph, 'getBoundingClientRect', {value: rect});
    Object.defineProperty(document, 'createRange', {value: () => ({selectNodeContents: () => undefined, getClientRects: () => [rect()]})});
    Object.defineProperty(document, 'elementFromPoint', {value: (_x: number, y: number) => y < 60 ? sticky : paragraph});
    Object.defineProperty(document, 'elementsFromPoint', {value: (_x: number, y: number) => [y < 60 ? sticky : paragraph]});
    for (const [key, value] of Object.entries({window, document, HTMLElement: window.HTMLElement,
      innerWidth: 1272, innerHeight: 816, getComputedStyle: () => ({display: 'block', visibility: 'visible'})})) vi.stubGlobal(key, value);
    Object.defineProperty(window, 'innerWidth', {configurable: true, value: 1272});
    Object.defineProperty(window, 'innerHeight', {configurable: true, value: 816});
    const center = vi.fn((options: unknown) => {
      expect(options).toEqual({block: 'center', inline: 'nearest', behavior: 'instant'});
      if (!staysCovered) top = 390;
    });
    const target = {scrollIntoViewIfNeeded: vi.fn(async () => undefined),
      evaluate: async (fn: (node: {scrollIntoView: typeof center}) => unknown) => fn({scrollIntoView: center})};
    const page = {evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
      mouse: {move: vi.fn()}, keyboard: {down: vi.fn(), up: vi.fn()}, waitForFunction: vi.fn(),
      waitForTimeout: async (ms: number) => {vi.advanceTimersByTime(ms);}};
    try {
      expect(findHoverTextPointInPage({selector: 'main p', index: 0})).toBeNull();
      const run = toggleHover(page, target, {selector: 'main p', index: 0}, 1, 500);
      if (staysCovered) {
        await expect(run).rejects.toThrow('悬浮原文没有稳定且可命中的位置');
        expect(page.keyboard.down).not.toHaveBeenCalled();
        expect(page.waitForFunction).not.toHaveBeenCalled();
      } else {
        await run;
        expect(Date.now()).toBeGreaterThanOrEqual(200);
        expect(page.mouse.move.mock.calls).toEqual([[93.85, 398.5]]);
        expect(page.keyboard.down.mock.calls).toEqual([['Control']]);
        expect(page.keyboard.up.mock.calls).toEqual([['Control']]);
      }
      expect(center).toHaveBeenCalledOnce();
      expect(target.scrollIntoViewIfNeeded).toHaveBeenCalledOnce();
      expect(document.body.innerHTML).toBe(original);
    } finally {vi.unstubAllGlobals();vi.useRealTimers();}
  });

  it('waits through post-restore movement and temporary occlusion before sending one trusted hotkey', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const point = (y: number) => ({
      x: 90, y, textIndex: 0, text: 'Everything you would expect',
      rect: {left: 20, top: y - 10, width: 200, height: 20},
    });
    const down = vi.fn(async () => { expect(Date.now()).toBeGreaterThanOrEqual(350); });
    const up = vi.fn(async () => undefined);
    const move = vi.fn(async () => undefined);
    const page = {
      evaluate: async () => Date.now() < 50 ? point(100) : Date.now() < 100 ? point(130) : Date.now() < 150 ? null : point(180),
      mouse: {move},
      keyboard: {down, up},
      waitForTimeout: async (ms: number) => { vi.advanceTimersByTime(ms); },
      waitForFunction: vi.fn(async () => undefined),
    };
    try {
      await toggleHover(page, hoverScrollTarget(), {selector: 'h1', index: 0}, 1, 1000);
      expect(move.mock.calls).toEqual([[90, 100], [90, 130], [90, 180]]);
      expect(down.mock.calls).toEqual([['Control']]);
      expect(up.mock.calls).toEqual([['Control']]);
      expect(page.waitForFunction).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails without issuing a translation hotkey when original text never becomes hittable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const down = vi.fn();
    const page = {
      evaluate: async () => null,
      mouse: {move: vi.fn()},
      keyboard: {down, up: vi.fn()},
      waitForTimeout: async (ms: number) => { vi.advanceTimersByTime(ms); },
    };
    try {
      await expect(toggleHover(page, hoverScrollTarget(), {selector: 'h1', index: 0}, 1, 200))
        .rejects.toThrow('悬浮原文没有稳定且可命中的位置');
      expect(down).not.toHaveBeenCalled();
      expect(page.mouse.move).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('tracks newly revealed descendants when their ancestor loses its hidden attribute', async () => {
    const {document, window} = parseHTML('<html><body><section hidden><p>Newly revealed prose must be translated during the first pass.</p></section></body></html>');
    Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({width: 400, height: 40, top: 0, left: 0, right: 400, bottom: 40}),
    });
    for (const [key, value] of Object.entries({
      window, document, Node: window.Node, HTMLElement: window.HTMLElement,
      HTMLAnchorElement: window.HTMLAnchorElement, MutationObserver: window.MutationObserver,
      getComputedStyle: () => ({display: 'block', visibility: 'visible'}),
    })) vi.stubGlobal(key, value);
    let tracker: {report: () => unknown[]; stop: () => void} | undefined;
    try {
      const rules = normalizeCoverageRules([{name: 'prose', selector: 'section p', minInitial: 1, trackDynamic: true}]);
      await installCoverageTracker({evaluate: async (fn, argument) => fn(argument)}, rules);
      tracker = (window as unknown as Record<string, typeof tracker>)[COVERAGE_TRACKER_KEY]!;
      expect(tracker.report()).toContainEqual(expect.objectContaining({seenCount: 0}));
      document.querySelector('section')!.removeAttribute('hidden');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(tracker.report()).toContainEqual(expect.objectContaining({seenCount: 1, translatedCount: 0}));
      expect(() => assertCoverageReport(rules, tracker!.report(), 'revealed')).toThrow('仅翻译 0/1');
      const wrapper = document.createElement('span');
      wrapper.className = 'fluent-read-bilingual-content';
      wrapper.textContent = '新揭示正文的译文';
      document.querySelector('p')!.append(wrapper);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(() => assertCoverageReport(rules, tracker!.report(), 'revealed')).not.toThrow();
    } finally {
      tracker?.stop();
      vi.unstubAllGlobals();
    }
  });

  it('keeps SQLite prose selection stable when bilingual wrappers move syntax labels', () => {
    const {document} = parseHTML(`<html><body><div class="fancy">
      <p id="syntax"><b><a href="syntax/select-stmt.html">select-stmt</a>:</b></p>
      <p id="prose">The SELECT statement is used to query the database.</p>
      <p id="reference">The <a href="syntax/select-stmt.html">select-stmt</a> diagram explains the grammar.</p>
    </div></body></html>`);
    const selector = cases['sqlite-select-language'].hoverSelector;
    expect([...document.querySelectorAll(selector)].map((node) => node.id)).toEqual(['prose', 'reference']);
    document.querySelector('#syntax')!.innerHTML = '<span class="fluent-read-original-text"><b><span><a href="syntax/select-stmt.html">select-stmt</a>:</span></b></span><span class="fluent-read-bilingual-content">select-stmt：</span>';
    expect([...document.querySelectorAll(selector)].map((node) => node.id)).toEqual(['prose', 'reference']);
  });

  it('captures host MathJax errors only after its existing startup queue completes', async () => {
    const {document} = parseHTML('<html><body><p id="formula">Raw formula source</p></body></html>');
    let complete: (() => void) | undefined;
    const Queue = vi.fn((callback: () => void) => { complete = callback; });
    vi.stubGlobal('window', {MathJax: {version: '2.7', Hub: {Queue}}});
    vi.stubGlobal('document', document);
    const page = {evaluate: (fn: (timeout: number) => unknown, timeout: number) => fn(timeout)};
    try {
      const pending = waitForHostMathRendering(page, 1000);
      expect(Queue).toHaveBeenCalledTimes(1);
      document.querySelector('#formula')!.innerHTML = '<span class="MathJax_Error" id="math-error">[Math Processing Error]</span>';
      complete!();
      await expect(pending).resolves.toEqual({detected: true, version: '2.7', errors: [{id: 'math-error', text: '[Math Processing Error]'}]});
      expect(Queue.mock.calls[0]).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails boundedly when host MathJax never finishes and skips pages without its queue', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {MathJax: {Hub: {Queue: () => undefined}}});
    const page = {evaluate: (fn: (timeout: number) => unknown, timeout: number) => fn(timeout)};
    try {
      const pending = waitForHostMathRendering(page, 50);
      const failure = expect(pending).rejects.toThrow('宿主 MathJax 初始排版等待超时');
      await vi.advanceTimersByTimeAsync(50);
      await failure;
      vi.stubGlobal('window', {});
      await expect(waitForHostMathRendering(page, 50)).resolves.toEqual({detected: false, errors: []});
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('requires every non-optional forbidden selector to exist for required cases', () => {
    const forbidden = ['pre, code', 'svg'];
    expect(resolveForbiddenMustExistSelectors('required', forbidden, ['svg'])).toEqual(forbidden);
    expect(resolveForbiddenMustExistSelectors('required', forbidden, [], ['svg'])).toEqual(['pre, code']);
    expect(resolveForbiddenMustExistSelectors('quarantine', forbidden, ['svg'])).toEqual(['svg']);
    expect(resolveForbiddenMustExistSelectors('quarantine', forbidden, ['svg'], ['svg'])).toEqual([]);
  });

  it('adopts a clean late dynamic optional forbidden subtree and then enforces its baseline', () => {
    const optional = {
      selector: '.MathJax_Display',
      dynamic: true,
      optional: true,
      count: 0,
      translatedDescendants: 0,
      ownedDescendants: 0,
      signatures: [],
    };
    const appeared = {
      ...optional,
      count: 1,
      signatures: [{tagName: 'DIV', text: 'x + y', structure: '["div",["#text"]]'}],
    };

    expect(reconcileForbiddenContractState(optional, {...optional})).toBeNull();
    expect(reconcileForbiddenContractState(optional, appeared)).toBeNull();
    expect(optional).toEqual(appeared);
    expect(reconcileForbiddenContractState(optional, {...appeared})).toBeNull();
    expect(reconcileForbiddenContractState(optional, {
      ...appeared,
      signatures: [{tagName: 'DIV', text: 'changed', structure: '["div",["#text"]]'}],
    })).toContain('动态 forbidden DOM 基线丢失');
    expect(reconcileForbiddenContractState(optional, {...appeared, count: 0, signatures: []}))
      .toContain('动态 forbidden DOM 基线丢失');
  });

  it('rejects owned content and untracked late optional forbidden subtrees', () => {
    const optional = {
      selector: '.MathJax_Display',
      dynamic: true,
      optional: true,
      count: 0,
      translatedDescendants: 0,
      ownedDescendants: 0,
      signatures: [],
    };
    expect(reconcileForbiddenContractState({...optional}, {
      ...optional,
      count: 1,
      ownedDescendants: 1,
    })).toContain('forbidden DOM 出现译文');
    expect(reconcileForbiddenContractState({...optional, dynamic: false}, {
      ...optional,
      dynamic: false,
      count: 1,
    })).toContain('可选 forbidden DOM 在静态 contract 后出现');
  });

  it.each(['changed-duplicate', 'clean-appended-node', 'owned-original',
    'missing-duplicate-with-clean-append', 'owned-appended-node', 'translated-appended-node'])(
    'preserves every duplicate dynamic forbidden occurrence for %s', async mode => {
      const {document, window} = parseHTML('<html><body><main><time>2 hours ago</time><time>2 hours ago</time></main></body></html>');
      const url = 'https://news.google.com/home';
      vi.stubGlobal('document', document);vi.stubGlobal('Node', window.Node);vi.stubGlobal('location', new URL(url));
      const page = {
        evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => fn(argument),
        url: () => url,
      };
      try {
        const baseline = await capturePageContract(page, [], ['main time'], [], ['main time'], []);
        expect(baseline.forbiddenState[0].signatures).toHaveLength(2);
        const second = document.querySelectorAll('time')[1]!;
        if (mode === 'changed-duplicate') second.textContent = 'A damaged relative timestamp';
        if (mode === 'clean-appended-node') {
          const appended = document.createElement('time');appended.textContent = '5 hours ago';
          document.querySelector('main')!.append(appended);
        }
        if (mode === 'missing-duplicate-with-clean-append') {
          second.remove();
          const appended = document.createElement('time');appended.textContent = '5 hours ago';
          document.querySelector('main')!.append(appended);
        }
        if (mode === 'owned-appended-node' || mode === 'translated-appended-node') {
          const appended = document.createElement('time');appended.textContent = '5 hours ago';
          if (mode === 'owned-appended-node') appended.setAttribute('data-fr-translation-owned', 'true');
          else {
            const translation = document.createElement('span');translation.className = 'fluent-read-bilingual-content';
            translation.textContent = 'Unexpected translated metadata';appended.append(translation);
          }
          document.querySelector('main')!.append(appended);
        }
        if (mode === 'owned-original') second.setAttribute('data-fr-translation-owned', 'true');
        const check = assertPageContract(page, baseline, [], url, mode);
        if (mode === 'clean-appended-node') await expect(check).resolves.toBeDefined();
        else await expect(check).rejects.toThrow(mode === 'owned-original' || mode === 'owned-appended-node' || mode === 'translated-appended-node'
          ? 'forbidden DOM 出现译文' : '动态 forbidden DOM 基线丢失');
      } finally {vi.unstubAllGlobals();}
    });

  it('allows only explicitly mutable dynamic forbidden roots to finish host rendering', () => {
    const mutable = {
      selector: '.MathJax_Display',
      dynamic: true,
      optional: true,
      mutable: true,
      count: 2,
      translatedDescendants: 0,
      ownedDescendants: 0,
      signatures: [{tagName: 'DIV', text: '', structure: '["div",[["span",[]]]]'}],
    };
    const typeset = {
      ...mutable,
      signatures: [{tagName: 'DIV', text: 'x + y', structure: '["div",[["span",["#text"]]]]'}],
    };

    expect(reconcileForbiddenContractState(mutable, typeset)).toBeNull();
    expect(reconcileForbiddenContractState(mutable, {...typeset, count: 3})).toBeNull();
    expect(mutable.count).toBe(3);
    expect(reconcileForbiddenContractState(mutable, {...typeset, count: 2}))
      .toContain('宿主可变 forbidden DOM 数量减少');
    expect(reconcileForbiddenContractState(mutable, {...typeset, ownedDescendants: 1}))
      .toContain('forbidden DOM 出现译文');
    expect(() => validateMutableForbiddenSelectors('invalid', ['.formula'], [], ['.formula']))
      .toThrow('必须同时是允许列表、dynamicForbiddenSelectors 与 forbiddenSelectors 的子集');
    expect(() => validateMutableForbiddenSelectors(
      'valid',
      ['.MathJax_Display'],
      ['.MathJax_Display'],
      ['.MathJax_Display'],
    )).not.toThrow();
    for (const protectedChrome of ['#nav', '#content pre, #content code', "script[type^='math/tex']"]) {
      expect(() => validateMutableForbiddenSelectors(
        'strict-protected',
        [protectedChrome],
        [protectedChrome],
        [protectedChrome],
      )).toThrow('必须同时是允许列表');
    }
  });

  it('keeps every forbidden signature and detects damage in the thirteenth node', async () => {
    const formulas = Array.from({length: 13}, (_, index) =>
      `<span class="formula">formula-${index + 1}</span>`).join('');
    const {document, window} = parseHTML(`<html><body><main>${formulas}</main></body></html>`);
    const url = 'https://example.test/forbidden-contract';
    const globals = {
      window,
      document,
      location: {href: url},
      Node: window.Node,
      HTMLElement: window.HTMLElement,
      HTMLAnchorElement: window.HTMLAnchorElement,
      getComputedStyle: () => ({display: 'block', visibility: 'visible'}),
    };
    const previous = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries(globals)) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
    }
    const page = {
      evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => fn(argument),
      url: () => url,
    };

    try {
      const baseline = await capturePageContract(page, [], ['.formula'], [], [], []);
      expect(baseline.forbiddenState[0].signatures).toHaveLength(13);

      const first = document.querySelector('.formula')!;
      first.setAttribute('data-fr-translation-owned', 'true');
      const selfOwned = await capturePageContract(page, [], ['.formula'], [], [], []);
      expect(selfOwned.forbiddenState[0]).toMatchObject({ownedDescendants: 1});
      first.removeAttribute('data-fr-translation-owned');

      const thirteenth = document.querySelectorAll('.formula')[12];
      thirteenth.textContent = 'damaged formula';
      thirteenth.append(document.createElement('em'));

      const error = await assertPageContract(page, baseline, [], url, '第十三节点回归')
        .then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('forbidden DOM 被修改');
      expect((error as Error).message).toContain('"signatureCount":13');
      // 契约比较覆盖全部 13 个节点，但诊断刻意只保留前 12 个签名，控制失败输出规模。
      expect((error as Error).message).not.toContain('damaged formula');
    } finally {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  it('retries a controlled dialog close until the second key press hides it', async () => {
    let visible = true;
    const pressed: string[] = [];
    const waitTimeouts: number[] = [];
    const [scenario] = normalizeInteractionScenarios([{
      name: 'two-stage-close',
      triggerSelector: '#trigger',
      openKey: 'click',
      dialogSelector: '#dialog',
      closeKey: 'Escape',
      closeAttempts: 2,
    }]);
    const page = {
      keyboard: {
        press: async (key: string) => {
          pressed.push(key);
          if (pressed.length === 2) visible = false;
        },
      },
      waitForFunction: async (_fn: unknown, _argument: unknown, options: {timeout: number; polling: number}) => {
        waitTimeouts.push(options.timeout);
        expect(options.polling).toBe(50);
        if (visible) throw new Error('dialog remains visible');
      },
    };

    await expect(closeInteractionDialog(page, scenario!, 60_000, 'baseline')).resolves.toBe(2);
    expect(pressed).toEqual(['Escape', 'Escape']);
    expect(waitTimeouts).toEqual([1500, 1500]);
  });

  it('fails strictly when every configured dialog close attempt leaves it visible', async () => {
    const pressed: string[] = [];
    const [scenario] = normalizeInteractionScenarios([{
      name: 'never-closes',
      triggerSelector: '#trigger',
      openKey: 'click',
      dialogSelector: '#dialog',
      closeKey: 'Escape',
      closeAttempts: 2,
    }]);
    const page = {
      keyboard: {press: async (key: string) => void pressed.push(key)},
      waitForFunction: async () => {
        throw new Error('dialog remains visible');
      },
      evaluate: async () => ({dialogVisible: true}),
    };

    await expect(closeInteractionDialog(page, scenario!, 60_000, 'first-translation'))
      .rejects.toThrow('first-translation/never-closes 对话框在 2 次 Escape 后仍未隐藏');
    expect(pressed).toEqual(['Escape', 'Escape']);
  });

  it.each(['open-second-dialog', 'expanded-trigger', 'missing-trigger', 'closed'] as const)(
    'checks every real matching dialog and the original trigger (%s)', async state => {
      const {document} = parseHTML('<html><body><button id="trigger" aria-expanded="false"></button><div class="dialog" hidden></div><div class="dialog" hidden></div></body></html>');
      if (state === 'open-second-dialog') document.querySelectorAll('.dialog')[1].removeAttribute('hidden');
      if (state === 'expanded-trigger') document.querySelector('#trigger')!.setAttribute('aria-expanded', 'true');
      if (state === 'missing-trigger') document.querySelector('#trigger')!.remove();
      for (const dialog of document.querySelectorAll('.dialog')) {
        Object.defineProperty(dialog, 'getBoundingClientRect', {value: () => ({width: dialog.hasAttribute('hidden') ? 0 : 100, height: dialog.hasAttribute('hidden') ? 0 : 50})});
      }
      const {runInNewContext} = require('node:vm');
      const run = (fn: (argument: unknown) => unknown, argument: unknown) => runInNewContext(`(${fn.toString()})(argument)`, {
        document, argument, getComputedStyle: (node: Element) => ({display: node.hasAttribute('hidden') ? 'none' : 'block', visibility: 'visible'}),
      }, {timeout: 1000});
      const pressed: string[] = [];
      const timeouts: number[] = [];
      const page = {
        keyboard: {press: async (key: string) => void pressed.push(key)},
        waitForFunction: async (fn: (argument: unknown) => unknown, argument: unknown, options: {timeout: number; polling: number}) => {
          timeouts.push(options.timeout); expect(options.polling).toBe(50);
          if (!run(fn, argument)) throw new Error('actual DOM did not close');
        },
        evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => run(fn, argument),
      };
      const scenario = {name: state, triggerSelector: '#trigger', dialogSelector: '.dialog', closeKey: 'Escape', closeAttempts: 3};
      if (state === 'closed') await expect(closeInteractionDialog(page, scenario, 30_000, 'baseline')).resolves.toBe(1);
      else await expect(closeInteractionDialog(page, scenario, 30_000, 'baseline')).rejects.toThrow('3 次 Escape 后仍未隐藏');
      expect(pressed).toEqual(Array(state === 'closed' ? 1 : 3).fill('Escape'));
      expect(timeouts).toEqual(Array(pressed.length).fill(1500));
    },
  );

  it.each(['visible-dialog-after-sample-cap', 'expanded-trigger', 'missing-trigger', 'rect-error', 'style-error', 'query-error', 'closed'] as const)(
    'retains serialized close-predicate evidence without relaxing the assertion (%s)', async state => {
      const {document} = parseHTML('<html><body><button id="trigger" aria-expanded="false"></button>' +
        Array.from({length: 12}, (_, index) => `<div class="dialog" id="dialog-${index}" hidden></div>`).join('') + '</body></html>');
      const triggerSelector = '#trigger';
      const dialogSelector = '.dialog';
      const dialogs = [...document.querySelectorAll(dialogSelector)];
      if (state === 'visible-dialog-after-sample-cap') dialogs[11].removeAttribute('hidden');
      if (state === 'expanded-trigger') document.querySelector(triggerSelector)!.setAttribute('aria-expanded', 'true');
      if (state === 'missing-trigger') document.querySelector(triggerSelector)!.remove();
      let predicateActive = false;
      for (const dialog of dialogs) Object.defineProperty(dialog, 'getBoundingClientRect', {value: () => {
        if (predicateActive && state === 'rect-error' && dialog.id === 'dialog-11') throw new Error('PRIVATE_CALLBACK_ERROR');
        return {width: dialog.hasAttribute('hidden') ? 0 : 100, height: dialog.hasAttribute('hidden') ? 0 : 50};
      }});
      const {runInNewContext} = require('node:vm');
      const run = (fn: (argument: unknown) => unknown, argument: unknown) => runInNewContext(`(${fn.toString()})(argument)`, {
        argument,
        document: {
          querySelector: (selector: string) => document.querySelector(selector),
          querySelectorAll: (selector: string) => {
            if (predicateActive && state === 'query-error' && selector === dialogSelector) throw new Error('PRIVATE_CALLBACK_ERROR');
            return document.querySelectorAll(selector);
          },
          activeElement: null,
        },
        getComputedStyle: (node: Element) => {
          if (predicateActive && state === 'style-error' && node.id === 'dialog-11') throw new Error('PRIVATE_CALLBACK_ERROR');
          return {display: node.hasAttribute('hidden') ? 'none' : 'block', visibility: 'visible'};
        },
      }, {timeout: 1000});
      let handleState: unknown;
      const dispose = vi.fn(async () => undefined);
      const handle = {evaluate: async (fn: (argument: unknown) => unknown) => run(fn, handleState), dispose};
      const pressed: string[] = [];
      const waits: unknown[] = [];
      const page = {
        keyboard: {press: async (key: string) => void pressed.push(key)},
        evaluateHandle: async (fn: () => unknown) => {handleState = run(fn, undefined); return handle;},
        waitForFunction: async (fn: (argument: unknown) => unknown, argument: unknown, options: {timeout: number; polling: number}) => {
          const args = argument as {diagnosticState: unknown; attempt: number; dialogSelector: string; triggerSelector: string};
          expect(args).toEqual({dialogSelector, triggerSelector, diagnosticState: handle, attempt: pressed.length});
          waits.push(options);
          let closed;
          predicateActive = true;
          try {
            closed = run(fn, {...args, diagnosticState: handleState});
            expect(typeof closed).toBe('boolean');
            if (!closed) expect(run(fn, {...args, diagnosticState: handleState})).toBe(false);
          } finally {
            predicateActive = false;
          }
          if (!closed) {
            // 和真实日志相同：超时后的页面可已关闭，但最后一次 false 必须保留下来。
            if (pressed.length === 3) {
              dialogs.forEach(dialog => dialog.setAttribute('hidden', ''));
              document.querySelector(triggerSelector)?.setAttribute('aria-expanded', 'false');
            }
            const error = new Error('PRIVATE_WAIT_ERROR');
            error.name = 'TimeoutError';
            throw error;
          }
        },
        evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => run(fn, argument),
      };
      const scenario = {name: state, triggerSelector, dialogSelector, closeKey: 'Escape', closeAttempts: 3};
      if (state === 'closed') await expect(closeInteractionDialog(page, scenario, 30_000, 'baseline')).resolves.toBe(1);
      else {
        let message = '';
        try {await closeInteractionDialog(page, scenario, 30_000, 'first-translation');}
        catch (error) {message = (error as Error).message;}
        expect(message).toContain(`first-translation/${state} 对话框在 3 次 Escape 后仍未隐藏`);
        expect(message).not.toContain('PRIVATE_');
        const diagnostic = JSON.parse(message.split('；诊断：')[1]);
        expect(diagnostic.closeWait.waitFailures).toEqual([1, 2, 3].map(attempt => ({attempt,
          category: state.endsWith('error') ? 'wait-error' : 'wait-timeout'})));
        expect(diagnostic.closeWait.predicateState.status).toBe('available');
        expect(diagnostic.closeWait.predicateState.attempts).toHaveLength(3);
        for (const [index, attempt] of diagnostic.closeWait.predicateState.attempts.entries()) {
          expect(attempt.pollCount).toBe(state.endsWith('error') ? 1 : 2);
          expect(attempt.lastPoll.attempt).toBe(index + 1);
          expect(attempt.lastPoll.capturedAt).toEqual(expect.any(Number));
          if (state.endsWith('error')) {
            expect(attempt.lastFalse).toBeNull();
            expect(attempt.lastPredicateError.category).toBe('predicate-error');
            expect(attempt.lastPredicateError.stage).toBe(
              state === 'query-error' ? 'dialog-query' : state === 'rect-error' ? 'dialog-rect' : 'dialog-style');
          } else {
            expect(attempt.lastPredicateError).toBeNull();
            expect(attempt.lastFalse.category).toBe(state === 'expanded-trigger' ? 'trigger-expanded' :
              state === 'missing-trigger' ? 'trigger-missing' : 'matching-dialog-visible');
          }
        }
        if (state === 'visible-dialog-after-sample-cap') {
          const lastFalse = diagnostic.closeWait.predicateState.attempts[2].lastFalse;
          expect(lastFalse.matchingDialogCount).toBe(12);
          expect(lastFalse.inspectedDialogs).toBe(12);
          expect(lastFalse.dialogs).toHaveLength(9);
          expect(lastFalse.dialogs[8]).toEqual(expect.objectContaining({index: 11, visible: true, width: 100, height: 50}));
          expect(diagnostic.matchingDialogs).toHaveLength(12);
          expect(diagnostic.matchingDialogs.every((dialog: {width: number; display: string}) => dialog.width === 0 && dialog.display === 'none')).toBe(true);
          expect(diagnostic.triggerState).toEqual({connected: true, ariaExpanded: 'false'});
        }
      }
      expect(pressed).toEqual(Array(state === 'closed' ? 1 : 3).fill('Escape'));
      expect(waits).toEqual(Array(pressed.length).fill({timeout: 1500, polling: 50}));
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it('reports no-predicate-sample literally when the wait rejects before polling', async () => {
    const state = {attempts: []};
    const dispose = vi.fn(async () => undefined);
    const handle = {evaluate: async (fn: (argument: unknown) => unknown) => fn(state), dispose};
    const page = {
      keyboard: {press: vi.fn(async () => undefined)},
      evaluateHandle: async () => handle,
      waitForFunction: vi.fn(async () => {const error = new Error('PRIVATE_WAIT_ERROR'); error.name = 'TimeoutError'; throw error;}),
      evaluate: async () => ({dialogVisible: false}),
    };
    let message = '';
    try {await closeInteractionDialog(page, {name: 'not-polled', triggerSelector: '#trigger', dialogSelector: '.dialog',
      closeKey: 'Escape', closeAttempts: 3}, 30_000, 'baseline');}
    catch (error) {message = (error as Error).message;}
    expect(message).toContain('3 次 Escape 后仍未隐藏');
    expect(message).not.toContain('PRIVATE_');
    expect(JSON.parse(message.split('；诊断：')[1]).closeWait.predicateState).toEqual({status: 'available',
      attempts: Array.from({length: 3}, () => ({pollCount: 0, category: 'no-predicate-sample'}))});
    expect(page.keyboard.press).toHaveBeenCalledTimes(3);
    expect(page.waitForFunction).toHaveBeenCalledTimes(3);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each(['create', 'read', 'snapshot'] as const)(
    'keeps all close retries and strict failure when diagnostic %s is unavailable', async unavailable => {
      const pressed: string[] = [];
      const dispose = vi.fn(async () => {throw new Error('PRIVATE_DISPOSE_ERROR');});
      const handle = {evaluate: async () => {throw new Error('PRIVATE_READ_ERROR');}, dispose};
      const page = {
        keyboard: {press: async (key: string) => void pressed.push(key)},
        evaluateHandle: async () => {
          if (unavailable === 'create') throw new Error('PRIVATE_CREATE_ERROR');
          return handle;
        },
        waitForFunction: vi.fn(async (_fn: unknown, _arg: unknown, options: {timeout: number; polling: number}) => {
          expect(options).toEqual({timeout: 1500, polling: 50});
          throw new Error('PRIVATE_WAIT_ERROR');
        }),
        evaluate: async () => {
          if (unavailable === 'snapshot') throw new Error('PRIVATE_SNAPSHOT_ERROR');
          return {dialogVisible: false};
        },
      };
      let message = '';
      try {await closeInteractionDialog(page, {name: unavailable, triggerSelector: '#trigger', dialogSelector: '.dialog',
        closeKey: 'Escape', closeAttempts: 3}, 30_000, 'baseline');}
      catch (error) {message = (error as Error).message;}
      expect(message).toContain('3 次 Escape 后仍未隐藏');
      expect(message).not.toContain('PRIVATE_');
      const diagnostic = JSON.parse(message.split('；诊断：')[1]);
      expect(diagnostic.closeWait.predicateState).toEqual({status: 'unavailable',
        category: unavailable === 'create' ? 'state-create-unavailable' : 'state-read-unavailable'});
      if (unavailable === 'snapshot') expect(diagnostic.category).toBe('final-snapshot-unavailable');
      expect(page.waitForFunction).toHaveBeenCalledTimes(3);
      expect(pressed).toEqual(['Escape', 'Escape', 'Escape']);
      expect(dispose).toHaveBeenCalledTimes(unavailable === 'create' ? 0 : 1);
    },
  );

  it('keeps a late true close sample as evidence while preserving every timeout failure', async () => {
    const {document} = parseHTML('<html><body><button id="trigger" aria-expanded="true"></button><div class="dialog" hidden></div></body></html>');
    const dialog = document.querySelector('.dialog')!;
    Object.defineProperty(dialog, 'getBoundingClientRect', {value: () => ({width: 0, height: 0})});
    let wallClock = 1791385900000;
    let browserMono = 1000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => ++wallClock);
    const {runInNewContext} = require('node:vm');
    const run = (fn: (argument: unknown) => unknown, argument: unknown) => runInNewContext(`(${fn.toString()})(argument)`, {
      document, argument, Date: {now: () => ++wallClock}, performance: {now: () => ++browserMono},
      getComputedStyle: () => ({display: 'none', visibility: 'visible'}),
    }, {timeout: 1000});
    let state: unknown;
    const pending: Array<() => unknown> = [];
    const dispose = vi.fn(async () => undefined);
    const handle = {evaluate: async (fn: (argument: unknown) => unknown) => {
      // 模拟不可取消的 CDP 操作：第三次等待已经被拒绝后，回调才运行并返回 true。
      expect(pending.shift()!()).toBe(true);
      return run(fn, state);
    }, dispose};
    const pressed: string[] = [];
    const page = {
      keyboard: {press: async (key: string) => void pressed.push(key)},
      evaluateHandle: async (fn: () => unknown) => {state = run(fn, undefined); return handle;},
      waitForFunction: vi.fn(async (fn: (argument: unknown) => unknown, argument: unknown, options: {timeout: number; polling: number}) => {
        expect(options).toEqual({timeout: 1500, polling: 50});
        const args = argument as {attempt: number; diagnosticState: unknown};
        const evaluatePredicate = () => run(fn, {...args, diagnosticState: state});
        if (args.attempt === 1) {
          expect(evaluatePredicate()).toBe(false);
          document.querySelector('#trigger')!.setAttribute('aria-expanded', 'false');
        } else {
          if (args.attempt === 3) expect(pending.shift()!()).toBe(true);
          pending.push(evaluatePredicate);
        }
        const error = new Error('PRIVATE_DEADLINE_ERROR');
        error.name = 'TimeoutError';
        throw error;
      }),
      evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => run(fn, argument),
    };
    try {
      let message = '';
      try {await closeInteractionDialog(page, {name: 'late-cdp-result', triggerSelector: '#trigger', dialogSelector: '.dialog',
        closeKey: 'Escape', closeAttempts: 3}, 30_000, 'retranslation');}
      catch (error) {message = (error as Error).message;}
      expect(message).toContain('retranslation/late-cdp-result 对话框在 3 次 Escape 后仍未隐藏');
      expect(message).not.toContain('PRIVATE_');
      const diagnostic = JSON.parse(message.split('；诊断：')[1]);
      const {attemptTimings, predicateState, waitFailures} = diagnostic.closeWait;
      expect(waitFailures).toEqual([1, 2, 3].map(attempt => ({attempt, category: 'wait-timeout'})));
      expect(attemptTimings).toHaveLength(3);
      for (const [index, timing] of attemptTimings.entries()) {
        expect(timing.attempt).toBe(index + 1);
        expect(timing.outcome).toBe('wait-timeout');
        expect(timing.start.wallMs).toBeLessThan(timing.keyDone.wallMs);
        expect(timing.keyDone.wallMs).toBeLessThan(timing.beforeWait.wallMs);
        expect(timing.beforeWait.wallMs).toBeLessThan(timing.afterWait.wallMs);
        expect(timing.afterWait.monotonicMs).toBeGreaterThanOrEqual(timing.beforeWait.monotonicMs);
      }
      expect(predicateState.attempts[0].lastFalse.category).toBe('trigger-expanded');
      for (const index of [1, 2]) {
        const sample = predicateState.attempts[index];
        expect(sample.pollCount).toBe(1);
        expect(sample.lastPoll.category).toBe('closed');
        expect(sample.lastFalse).toBeNull();
        expect(sample.firstPollAt).toBeGreaterThan(attemptTimings[index].afterWait.wallMs);
        expect(sample.lastPoll.recordedAt).toBeGreaterThan(sample.lastPoll.capturedAt);
        expect(sample.lastPoll.recordedMonoMs).toBeGreaterThan(sample.lastPoll.capturedMonoMs);
      }
      expect(page.waitForFunction).toHaveBeenCalledTimes(3);
      expect(pressed).toEqual(['Escape', 'Escape', 'Escape']);
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      now.mockRestore();
    }
  });


  it('defaults dialog close attempts to one and rejects values outside the bounded range', () => {
    expect(normalizeInteractionScenarios([{
      name: 'default-close',
      triggerSelector: '#trigger',
      openKey: 'click',
      dialogSelector: '#dialog',
    }])[0]?.closeAttempts).toBe(1);
    for (const closeAttempts of [0, 4, 1.5]) {
      expect(() => normalizeInteractionScenarios([{
        name: 'invalid-close',
        triggerSelector: '#trigger',
        openKey: 'click',
        dialogSelector: '#dialog',
        closeAttempts,
      }])).toThrow('closeAttempts 必须是 1-3 的整数');
    }
  });

  it('adds one anchored hover target for every missing coverage selector', () => {
    const coverageRules = normalizeCoverageRules([
      {
        name: 'title',
        selector: 'main h1',
        kind: 'heading',
        sourceIncludes: ['Expected title', 'Second page sample'],
      },
      {name: 'body', selector: 'main p', kind: 'content'},
    ]);
    const targets = normalizeHoverTargets([{name: 'body', selector: 'main p'}], {
      fallbackSelector: 'main p',
      coverageRules,
    });
    expect(targets).toEqual([
      expect.objectContaining({name: 'body', selector: 'main p', sourceIncludes: []}),
      expect.objectContaining({
        name: 'coverage-title',
        selector: 'main h1',
        sourceIncludes: ['Expected title'],
      }),
    ]);

    expect(normalizeHoverTargets([{
      name: 'explicit-title',
      selector: 'main h1',
      sourceIncludes: ['Expected title', 'Second page sample'],
    }], {coverageRules})[0].sourceIncludes).toEqual(['Expected title', 'Second page sample']);
  });

  it('inherits a fixed sourcePartition into its hover target and keeps Text-range targeting separate', () => {
    const coverageRules = normalizeCoverageRules([{name: 'body', selector: '#body', kind: 'content',
      sourceIncludes: ['An entire body fragment'], sourcePartition: {excludeSelectors: ['h2']}}]);
    const targets = normalizeHoverTargets([{name: 'body', selector: '#body', textIncludes: [' Actual text line ']}], {coverageRules});
    expect(targets[0]).toMatchObject({sourceIncludes: ['An entire body fragment'], textIncludes: ['Actual text line'],
      sourcePartition: {excludeSelectors: ['h2']}});
    expect(validateCoverageRules('dynamic-partition', normalizeCoverageRules([{name: 'body', selector: '#body',
      kind: 'content', trackDynamic: true, sourcePartition: {excludeSelectors: ['h2']}}])))
      .toContain('dynamic-partition.coverageRules[0] sourcePartition 固定基线不得启用 trackDynamic');
    for (const sourcePartition of [null, true, {}, {excludeSelectors: 'h2'}, {excludeSelectors: ['']},
      {excludeSelectors: ['h2'], ignoreEverything: true}]) {
      expect(() => normalizeCoverageRules([{name: 'body', selector: '#body', sourcePartition}])).toThrow('sourcePartition');
    }
    for (const textIncludes of [[], [''], true, 'A line']) {
      expect(() => normalizeHoverTargets([{name: 'body', selector: '#body', textIncludes}])).toThrow('textIncludes');
    }
  });

  it.each(['hover', 'full'])('fails fast for the Steam %s partition contract without a controlled provider', mode => {
    const {parseArgs} = require('../scripts/run-site-translation-test.cjs');
    const args = ['--case', 'steam-dota2-product', '--mode', mode, '--extension-dir', '/isolated/extension',
      '--playwright-root', '/isolated/deps', '--runtime-diagnostics-helper', '/isolated/diagnostics.cjs', '--allow-network'];
    expect(() => parseArgs(args)).toThrow('sourcePartition 完整正文契约必须使用 --controlled-provider');
    const config = parseArgs([...args, '--controlled-provider']);
    expect(config.coverageRules.find((rule: {name: string}) => rule.name === 'game-body').sourcePartition)
      .toEqual({excludeSelectors: ['h2']});
    expect(config.hoverTargets.find((target: {name: string}) => target.name === 'game-body')).toMatchObject({
      textIncludes: ['When it comes to diversity of heroes'], sourcePartition: {excludeSelectors: ['h2']},
    });
  });

  it('requires a real partition ledger and carries the same baseline through translate, restore and retranslate', async () => {
    const {captureSourcePartitionLedger, verifySourcePartitionLedger} = require('../scripts/run-site-translation-test.cjs');
    const page = {}, ledger = Object.freeze({});
    const configs = [{name: 'body', selector: '#body', sourcePartition: {excludeSelectors: ['h2']}}];
    await expect(captureSourcePartitionLedger(page, [], undefined)).resolves.toBeNull();
    await expect(captureSourcePartitionLedger(page, configs, undefined)).rejects.toThrow('--controlled-provider');
    const provider = {captureSourcePartitions: vi.fn(async () => ledger), assertSourcePartitions: vi.fn(async () => [])};
    expect(await captureSourcePartitionLedger(page, configs, provider)).toBe(ledger);
    for (const [phase, restored] of [['first', false], ['restore', true], ['second', false]] as const) {
      await verifySourcePartitionLedger(page, ledger, provider, phase, restored);
    }
    expect(provider.captureSourcePartitions).toHaveBeenCalledOnce();
    expect(provider.assertSourcePartitions.mock.calls).toEqual([
      [page, ledger, 'first', {restored: false}], [page, ledger, 'restore', {restored: true}],
      [page, ledger, 'second', {restored: false}],
    ]);
    await expect(captureSourcePartitionLedger(page, configs, {...provider, captureSourcePartitions: async () => null}))
      .rejects.toThrow('原生正文基线 ledger');
    await expect(verifySourcePartitionLedger(page, undefined, provider, 'lost-baseline')).rejects.toThrow('ledger');
  });

  it('binds an indexed hover partition only to the resolved native root through restore and retranslation', async () => {
    const {captureSourcePartitions, assertSourcePartitions, encodeControlledTranslation} = require('../scripts/site-translation/controlled-provider.cjs');
    const {document} = parseHTML('<html><body><div class="reply">First independent native reply.</div><div class="reply">Second independent native reply.</div></body></html>');
    const page = {evaluate: async (fn: (value: unknown) => unknown, value: unknown) => fn(value)};
    const roots = [...document.querySelectorAll('.reply')];
    const append = (root: Element) => {
      const wrapper = document.createElement('span');
      wrapper.className = 'fluent-read-bilingual-content';
      wrapper.setAttribute('data-fr-translation-owned', 'true');
      wrapper.textContent = encodeControlledTranslation(root.textContent);
      root.append(wrapper);
      return wrapper;
    };
    vi.stubGlobal('document', document);
    try {
      const ledger = await captureSourcePartitions(page, [{name: 'reply', selector: '.reply', index: 1,
        sourcePartition: {excludeSelectors: []}}]);
      let wrapper = append(roots[1]);
      expect(await assertSourcePartitions(page, ledger, 'second-hover')).toMatchObject([{
        selector: '.reply', index: 1, expectedSource: 'Second independent native reply.', ownerCount: 1,
      }]);
      expect(roots[0].querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(0);
      wrapper.remove();
      expect(await assertSourcePartitions(page, ledger, 'second-restored', {restored: true}))
        .toMatchObject([{index: 1, ownerCount: 0, restored: true}]);
      wrapper = append(roots[1]);
      expect(await assertSourcePartitions(page, ledger, 'second-retranslated')).toMatchObject([{index: 1, ownerCount: 1}]);
      wrapper.remove();
      roots[1].replaceWith(roots[1].cloneNode(true));
      await expect(assertSourcePartitions(page, ledger, 'replaced-selected-root', {restored: true}))
        .rejects.toThrow('native container changed: .reply/1');
      const firstLedger = await captureSourcePartitions(page, [{name: 'first-reply', selector: '.reply', index: 0,
        sourcePartition: {excludeSelectors: []}}]);
      append(roots[0]);
      expect(await assertSourcePartitions(page, firstLedger, 'explicit-zero-index'))
        .toMatchObject([{index: 0, expectedSource: 'First independent native reply.', ownerCount: 1}]);
    } finally {
      delete (globalThis as Record<string, unknown>).__fluentReadControlledSourcePartitionsV1;
      vi.unstubAllGlobals();
    }
  });

  it.each([-1, 0.5, '1', null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an explicitly invalid source partition index %s instead of silently capturing every root', async index => {
      const {captureSourcePartitions} = require('../scripts/site-translation/controlled-provider.cjs');
      const {document} = parseHTML('<html><body><div class="reply">A complete native reply.</div></body></html>');
      vi.stubGlobal('document', document);
      try {
        const page = {evaluate: async (fn: (value: unknown) => unknown, value: unknown) => fn(value)};
        await expect(captureSourcePartitions(page, [{selector: '.reply', index, sourcePartition: {excludeSelectors: []}}]))
          .rejects.toThrow('index must be a non-negative safe integer');
      } finally {
        delete (globalThis as Record<string, unknown>).__fluentReadControlledSourcePartitionsV1;
        vi.unstubAllGlobals();
      }
    });

  it('keeps all native roots mandatory for an unindexed full partition and rejects missing or out-of-range targets', async () => {
    const {captureSourcePartitions, assertSourcePartitions, encodeControlledTranslation} = require('../scripts/site-translation/controlled-provider.cjs');
    const {document} = parseHTML('<html><body><div class="reply">First independent native reply.</div><div class="reply">Second independent native reply.</div></body></html>');
    const page = {evaluate: async (fn: (value: unknown) => unknown, value: unknown) => fn(value)};
    vi.stubGlobal('document', document);
    try {
      for (const index of [2, Number.MAX_SAFE_INTEGER]) {
        await expect(captureSourcePartitions(page, [{selector: '.reply', index, sourcePartition: {excludeSelectors: []}}]))
          .rejects.toThrow('index out of range');
      }
      await expect(captureSourcePartitions(page, [{selector: '.missing', index: 0, sourcePartition: {excludeSelectors: []}}]))
        .rejects.toThrow('container missing');
      const ledger = await captureSourcePartitions(page, [{name: 'all-replies', selector: '.reply',
        sourcePartition: {excludeSelectors: []}}]);
      const roots = [...document.querySelectorAll('.reply')];
      const append = (root: Element) => {
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.textContent = encodeControlledTranslation(root.textContent);
        root.append(wrapper);
      };
      append(roots[0]);
      await expect(assertSourcePartitions(page, ledger, 'missing-second-reply')).rejects.toThrow('owners missing');
      append(roots[1]);
      expect(await assertSourcePartitions(page, ledger, 'all-replies')).toMatchObject([
        {index: 0, expectedSource: 'First independent native reply.', ownerCount: 1},
        {index: 1, expectedSource: 'Second independent native reply.', ownerCount: 1},
      ]);
      document.querySelectorAll('.fluent-read-bilingual-content').forEach(wrapper => wrapper.remove());
      expect(await assertSourcePartitions(page, ledger, 'all-restored', {restored: true}))
        .toMatchObject([{index: 0, restored: true}, {index: 1, restored: true}]);
    } finally {
      delete (globalThis as Record<string, unknown>).__fluentReadControlledSourcePartitionsV1;
      vi.unstubAllGlobals();
    }
  });

  it('counts late dynamic nodes and fails if any observed node is untranslated', () => {
    const rules = normalizeCoverageRules([{
      name: 'dynamic-comments',
      selector: 'shreddit-comment p',
      kind: 'content',
      minInitial: 1,
      minSeen: 3,
      trackDynamic: true,
    }]);
    const report = [{
      name: 'dynamic-comments',
      seenCount: 3,
      dynamicSeenCount: 2,
      translatedCount: 2,
      sourceSamples: ['initial', 'late one', 'late two'],
      missedSamples: ['late two'],
    }];

    expect(() => assertCoverageReport(rules, report, 'test')).toThrow('仅翻译 2/3 个节点');
  });

  it('fails the old seven-wrapper PR 4038 baseline', () => {
    const pr = cases['github-project-pr'];
    const rules = normalizeCoverageRules(pr.coverageRules);
    const oldSevenWrapperBaseline = [
      {
        name: 'pull-request-title',
        seenCount: 1,
        translatedCount: 1,
        sourceSamples: ['fix(github): preserve quick search during translation'],
        missedSamples: [],
      },
      {
        name: 'body-headings',
        seenCount: 3,
        translatedCount: 0,
        sourceSamples: ['What changed', 'Why', 'Validation'],
        missedSamples: ['What changed', 'Why', 'Validation'],
      },
      {
        name: 'body-paragraphs',
        seenCount: 2,
        translatedCount: 0,
        sourceSamples: ['GitHub mounts its global search UI dynamically', 'Fixes #3997.'],
        missedSamples: ['GitHub mounts its global search UI dynamically', 'Fixes #3997.'],
      },
      {
        name: 'body-list-items',
        seenCount: 7,
        translatedCount: 6,
        sourceSamples: ["Exclude GitHub's global search trigger", 'Ran git diff --check.'],
        missedSamples: ['Ran git diff --check.'],
      },
    ];

    expect(() => assertCoverageReport(rules, oldSevenWrapperBaseline, 'PR4038')).toThrow(
      'PR4038 全文覆盖断言失败',
    );
  });

  it('requires source anchors so selector drift cannot silently pass', () => {
    const rules = normalizeCoverageRules([{
      name: 'title',
      selector: 'main h1',
      kind: 'heading',
      minInitial: 1,
      sourceIncludes: ['Expected title'],
    }]);
    const report = [{
      name: 'title',
      seenCount: 1,
      translatedCount: 1,
      sourceSamples: ['Wrong page title'],
      missedSamples: [],
    }];

    expect(() => assertCoverageReport(rules, report, 'test')).toThrow('未命中预期原文');
  });

  it('checks source anchors across the whole rule instead of only the 16 diagnostic samples', () => {
    const rules = normalizeCoverageRules([{
      name: 'long-document',
      selector: 'main p',
      kind: 'content',
      minInitial: 30,
      sourceIncludes: ['The SELECT statement is used to query the database.'],
    }]);
    const report = [{
      name: 'long-document',
      seenCount: 30,
      translatedCount: 30,
      sourceSamples: Array.from({length: 16}, (_, index) => `Earlier paragraph ${index}`),
      matchedSourceIncludes: ['The SELECT statement is used to query the database.'],
      missedSamples: [],
    }];

    expect(assertCoverageReport(rules, report, 'long document')).toBe(report);
  });

  it('fails restoration when extension nodes or changed source DOM remain', () => {
    expect(() => assertCoverageRestoration([{
      name: 'body',
      ownedCount: 1,
      changedCount: 1,
      missingStaticCount: 0,
      changedSamples: [{source: 'before', current: 'after'}],
    }], 'restore')).toThrow('恢复断言失败');
  });
});

describe('real-site translation matrix gates', () => {
  it('contains enough required real sites and validates every explicit coverage rule', () => {
    const matrix = validateMatrix();
    expect(matrix.entries.length).toBeGreaterThanOrEqual(MATRIX_REQUIREMENTS.total);
    expect(matrix.required.length).toBeGreaterThanOrEqual(MATRIX_REQUIREMENTS.required);
    expect(matrix.requiredHosts.size).toBeGreaterThanOrEqual(MATRIX_REQUIREMENTS.requiredHosts);
    expect(matrix.quarantine.length).toBeGreaterThanOrEqual(MATRIX_REQUIREMENTS.quarantine);
  });

  it('collects an invalid URL as a named matrix error instead of throwing during host aggregation', () => {
    expect(() => validateMatrix({
      'invalid-url': {
        url: 'not a valid url',
        tier: 'quarantine',
        quarantineReason: 'invalid fixture',
        selector: 'main p',
        requiredSelectors: ['main p'],
        forbiddenSelectors: ['pre, code'],
        optionalForbiddenSelectors: [''],
        interactionSelectors: ['main a[href]'],
        coverageRules: [{name: 'body', selector: 'main p', kind: 'content', minInitial: 1}],
        hoverTargets: [{name: 'body', selector: 'main p', index: 0}],
        modes: ['hover', 'full'],
      },
    })).toThrow(/invalid-url 的 url 无效：not a valid url[\s\S]*optionalForbiddenSelectors/u);
  });

  it('rejects an empty raw required selector instead of normalizing it away', () => {
    const invalidCases = structuredClone(cases) as unknown as Record<string, Record<string, unknown>>;
    const config = invalidCases['bambu-dual-nozzles'];
    config.requiredSelectors = [...config.requiredSelectors as string[], '   '];
    expect(() => validateMatrix(invalidCases)).toThrow(
      'bambu-dual-nozzles 必须配置 requiredSelectors 或旧版 selector',
    );
  });

  it('requires forbiddenSelectors to be a non-empty raw array', () => {
    const invalidCases = structuredClone(cases) as unknown as Record<string, Record<string, unknown>>;
    invalidCases['bambu-dual-nozzles'].forbiddenSelectors = 'header svg';
    expect(() => validateMatrix(invalidCases)).toThrow('bambu-dual-nozzles 缺少 forbiddenSelectors');
  });

  it('gives each browser child a bounded multi-stage budget and terminates a hung process', async () => {
    expect(computeJobTimeoutMs(60_000, 'hover')).toBe(5 * 60_000);
    expect(computeJobTimeoutMs(60_000, 'full')).toBe(30 * 60_000);
    expect(computeJobTimeoutMs(240_000, 'hover')).toBe(8 * 60_000);
    expect(computeJobTimeoutMs(240_000, 'full')).toBe(37 * 60_000);
    expect(computeJobTimeoutMs(60_000, 'full', 1234)).toBe(1234);

    const result = await runChildWithWatchdog(process.execPath, [
      '-e',
      'setInterval(() => {}, 1000)',
    ], {timeoutMs: 80, killGraceMs: 30, stdio: 'ignore'});
    expect(result).toMatchObject({ok: false, timedOut: true});
  });

  it('retries a failed required site in a fresh complete run while keeping both outcomes visible', async () => {
    const flaky = vi.fn(async (attempt: number) => ({ok: attempt === 2, timedOut: false}));
    const recovered = await runJobAttempts(flaky, 2);
    expect(flaky.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2]);
    expect(recovered).toMatchObject({ok: true, attempts: [{ok: false}, {ok: true}]});

    const timedOut = vi.fn(async () => ({ok: false, timedOut: true}));
    expect(await runJobAttempts(timedOut, 2)).toMatchObject({ok: false, attempts: [{timedOut: true}]});
    expect(timedOut).toHaveBeenCalledTimes(1);
  });

  it('still SIGKILLs the process group when the direct child closes after SIGTERM', async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), {pid: 4242});
      const signals: string[] = [];
      const resultPromise = runChildWithWatchdog('fake-runner', [], {
        timeoutMs: 100,
        killGraceMs: 25,
        stdio: 'ignore',
        spawnImpl: () => child,
        killProcessGroupImpl: (_target, signal) => {
          signals.push(signal);
          if (signal === 'SIGTERM') {
            // runner 虽已退出，但脱离的浏览器孙进程仍留在进程组中，
            // 因此仍需向整个进程组发送 SIGKILL。
            queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
          }
          return true;
        },
      });

      await vi.advanceTimersByTimeAsync(100);
      expect(signals).toEqual(['SIGTERM']);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(25);
      await expect(resultPromise).resolves.toMatchObject({ok: false, timedOut: true, signal: 'SIGTERM'});
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the watchdog without sending signals when the child exits normally', async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), {pid: 4343});
      const signals: string[] = [];
      const resultPromise = runChildWithWatchdog('fake-runner', [], {
        timeoutMs: 100,
        killGraceMs: 25,
        stdio: 'ignore',
        spawnImpl: () => child,
        killProcessGroupImpl: (_target, signal) => {
          signals.push(signal);
          return true;
        },
      });

      child.emit('close', 0, null);
      await expect(resultPromise).resolves.toMatchObject({ok: true, timedOut: false, signal: null});
      expect(signals).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(200);
      expect(signals).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('normalizes required hover coverage across every semantic rule', () => {
    for (const [name, rawConfig] of Object.entries(cases)) {
      const config = rawConfig as {
        tier?: string;
        hoverSelector?: string;
        selector?: string;
        hoverTargets?: unknown[];
        coverageRules: unknown[];
      };
      if ((config.tier || 'required') !== 'required') continue;
      const coverageRules = normalizeCoverageRules(config.coverageRules);
      const targets = normalizeHoverTargets(config.hoverTargets || [], {
        fallbackSelector: config.hoverSelector || config.selector,
        coverageRules,
      });
      const targetSelectors = new Set(targets.map(({selector}) => selector));
      expect(
        coverageRules.every(({selector}) => targetSelectors.has(selector)),
        `${name} hover/full candidate parity`,
      ).toBe(true);
    }
  });

  it('keeps the live front page and help article in both translation modes', () => {
    expect(cases['hacker-news-home'].url).toBe('https://news.ycombinator.com/');
    expect(cases['hacker-news-home'].hoverSelector).toBe('.titleline > a');
    expect(cases['producthunt-posting-access'].url).toBe(
      'https://help.producthunt.com/en/articles/481909-how-can-i-get-access-to-post',
    );
    for (const name of ['hacker-news-home', 'producthunt-posting-access'] as const) {
      expect(cases[name].tier).toBe('required');
      expect(cases[name].modes).toEqual(['hover', 'full']);
    }
    expect(cases['producthunt-posting-access'].forbiddenSelectors).toContain('.intercom-reaction');
  });

  it('restores recovered pages to required while keeping challenged pages quarantined', () => {
    expect(cases['hacker-news-8863'].tier).toBe('required');
    expect(cases['ubuntu-apt-manpage'].tier).toBe('required');
    expect(cases['pubdev-provider'].tier).toBe('required');
    expect(cases['reddit-minimax-thread'].tier).toBe('quarantine');
    expect(cases['w3c-accessibility-introduction'].tier).toBe('quarantine');
    expect(cases['nginx-beginners-guide'].tier).toBe('required');
    expect(cases['curl-http-scripting'].tier).toBe('required');
    expect(cases['sqlite-select-language'].tier).toBe('required');
    expect(cases['git-book-version-control'].tier).toBe('required');
    expect(cases['github-project-pulls'].forbiddenSelectors).toEqual([
      'main h1',
      "button[aria-haspopup='dialog'][aria-label*='search' i]",
    ]);
    expect(cases['brown-pl-introduction'].forbiddenSelectors).toEqual(['table.RktBlk']);
    expect(cases['sqlite-select-language'].hoverSelector).toBe(
      ".fancy > p:not(:has(b a[href^='syntax/']))",
    );
    expect(cases['sqlite-select-language'].coverageRules).toContainEqual(expect.objectContaining({
      name: 'reference-paragraphs',
      selector: ".fancy > p:not(:has(b a[href^='syntax/']))",
      sourceIncludes: ['The SELECT statement is used to query the database.'],
    }));
    expect(cases['learnopengl-coordinate-systems'].forbiddenSelectors).toEqual([
      '#content pre, #content code',
      '.MathJax_Display',
      "script[type^='math/tex']",
      '#nav',
    ]);
    expect(cases['learnopengl-coordinate-systems'].optionalForbiddenSelectors).toEqual([
      '.MathJax_Display',
    ]);
    expect(cases['learnopengl-coordinate-systems'].dynamicForbiddenSelectors).toEqual([
      '.MathJax_Display',
    ]);
    expect(cases['learnopengl-coordinate-systems'].mutableForbiddenSelectors).toEqual([
      '.MathJax_Display',
    ]);
    expect(resolveForbiddenMustExistSelectors(
      'required',
      cases['learnopengl-coordinate-systems'].forbiddenSelectors,
      [],
      cases['learnopengl-coordinate-systems'].optionalForbiddenSelectors,
    )).toEqual(['#content pre, #content code', "script[type^='math/tex']", '#nav']);
    expect(cases['learnopengl-coordinate-systems'].interactionSelectors).toEqual([
      '#content a[href], #nav a[href]',
    ]);
  });

  it.each([
    ['legacy', 'ReposListItem-module__TopicsList__fixture', 'ReposListItem-module__LabelsContainer__fixture'],
    ['current-small', 'TopicsList__XBoKUv SmallScreenOnly__KktHod', 'LabelsContainer__Bi_rOW'],
    ['current-large', 'TopicsList__XBoKUv HideOnSmallScreen__zMyWHa', 'LabelsContainer__Bi_rOW'],
  ])('keeps GitHub %s repository topics and metadata mandatory while preserving description coverage', (_variant, topicsClass, labelsClass) => {
    const {document} = parseHTML(`<main><ul data-listview-component="items-list"><li>
      <a href="/microsoft/TypeScript">TypeScript</a><svg class="octicon"></svg>
      <span id="visibility" data-listview-item-visibility-label="true">Public</span>
      <div id="description" class="repos-list-description">TypeScript adds types to JavaScript.</div>
      <div id="topics" class="${topicsClass}"><span>arbitrary-runtime-label</span></div>
      <div id="metadata" class="${labelsClass}"><span>TypeScript</span><span>MIT License</span><span>42 forks</span></div>
    </li></ul><p class="TopicsList__XBoKUv" id="outside-topics">A readable topic explanation.</p>
      <p class="LabelsContainer__Bi_rOW" id="outside-labels">A readable label explanation.</p></main>`);
    const config = cases['github-microsoft-repositories'];
    const mandatory = resolveForbiddenMustExistSelectors(config.tier, config.forbiddenSelectors, [], []);
    expect(mandatory).toEqual(config.forbiddenSelectors);
    expect(mandatory).toHaveLength(4);
    expect(mandatory.every(selector => document.querySelectorAll(selector).length > 0)).toBe(true);
    expect([...document.querySelectorAll(config.forbiddenSelectors[1]!)].map(node => node.id)).toEqual(['topics']);
    expect([...document.querySelectorAll(config.forbiddenSelectors[2]!)].map(node => node.id)).toEqual(['metadata']);
    expect([...document.querySelectorAll(config.requiredSelectors[0]!)].map(node => node.id)).toEqual(['description']);
    expect(config.coverageRules[0]!.sourceIncludes).toEqual(['TypeScript']);
    expect(config.modes).toEqual(['hover', 'full']);
    expect(config.url).toBe('https://github.com/orgs/microsoft/repositories?q=TypeScript&type=all&language=&sort=');
  });

  it.each(['Description-module__container__fixture', 'container__W45oI6'])('keeps GitHub issue metadata mandatory for %s without selecting the title or ordinary prose', metadataClass => {
    const {document} = parseHTML(`<main><div data-testid="issues-list-surface"><ul><li>
      <a id="title" data-testid="issue-10084-title-link" href="/Eugeny/tabby/issues/10084">right click not working</a>
      <span id="label" class="prc-Token-IssueLabel-2IazM">T: Bug</span>
      <div id="metadata" class="${metadataClass}"><span>Eugeny/tabby#10084</span><span>
        <button data-testid="author-filter-link">Fixture Author</button> opened
        <relative-time id="timestamp" data-testid="issue-activity-timestamp">yesterday</relative-time></span></div>
      <div class="container__W45oI6" id="ordinary"><p>Ordinary description remains readable.</p></div>
    </li></ul></div></main>`);
    const config = cases['github-eugeny-issue-list'];
    const mandatory = resolveForbiddenMustExistSelectors(config.tier, config.forbiddenSelectors, config.forbiddenMustExistSelectors, []);
    expect(mandatory).toEqual(config.forbiddenSelectors);
    expect(mandatory).toHaveLength(3);
    expect(mandatory.every(selector => document.querySelectorAll(selector).length > 0)).toBe(true);
    expect([...document.querySelectorAll(config.forbiddenSelectors[1]!)].map(node => node.id)).toEqual(['metadata']);
    expect([...document.querySelectorAll(config.requiredSelectors[0]!)].map(node => node.id)).toEqual(['title']);
    expect(config.dynamicForbiddenSelectors).toEqual(["span[class*='IssueLabel']"]);
    expect(config.modes).toEqual(['hover', 'full']);
    expect(config.url).toBe('https://github.com/Eugeny/tabby/issues?q=is%3Aissue%20state%3Aopen%20in%3Atitle%20%22right%20click%20not%20working%22');
  });

  it('keeps modern manpage prose separate from mandatory command syntax and command labels', () => {
    const {document} = parseHTML('<main><div id="manpage-content"><h2 id="synopsis" class="Sh">SYNOPSIS</h2><section><p class="Pp HP"><b>apt</b> [<b>--help</b>]</p></section><h2 id="description" class="Sh">DESCRIPTION</h2><section><p class="Pp">The command provides a package management interface.</p><p class="Pp">Its manual explains the most common options.</p><p class="Pp"><b>update</b></p><div class="Bd-indent">Download package information from configured sources.</div></section></div></main>');
    const config = cases['ubuntu-apt-manpage'];
    expect([...document.querySelectorAll(config.hoverSelector)].map((node) => node.textContent)).toEqual([
      'The command provides a package management interface.',
      'Its manual explains the most common options.',
    ]);
    const protectedNodes = config.forbiddenMustExistSelectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
    expect(protectedNodes.map((node) => node.textContent)).toEqual(['apt [--help]', 'update']);
    expect(config.forbiddenMustExistSelectors.every((selector) => config.forbiddenSelectors.includes(selector))).toBe(true);
  });

  it('covers MDN body headings while preserving the sidebar table of contents', () => {
    const {document} = parseHTML('<main id="content" class="layout__content"><h1>Grammar and types</h1><aside class="layout__right-sidebar reference-layout__toc"><nav class="reference-toc"><h2>In this article</h2><a href="#basics">Basics</a></nav></aside><div class="layout__body reference-layout__body"><section class="content-section"><h2 id="basics">Basics</h2><p>The language distinguishes upper and lower case.</p><p>Statements have a defined structure.</p><p>Use <code>let</code> for a local binding.</p></section><section class="content-section"><h2>Comments</h2><p>Comments explain the surrounding source.</p><p>They are ignored during execution.</p><pre>let value = 1;</pre></section></div></main>');
    const config = cases['mdn-javascript-guide'];
    const rules = normalizeCoverageRules(config.coverageRules);
    const headings = rules.find(({name}) => name === 'guide-sections')!;
    expect([...document.querySelectorAll(headings.selector)].map((node) => node.textContent)).toEqual(['Basics', 'Comments']);
    expect(headings.minInitial).toBe(2);
    expect(rules.find(({name}) => name === 'guide-title')?.minInitial).toBe(1);
    const paragraphs = rules.find(({name}) => name === 'guide-paragraphs')!;
    expect(paragraphs.minInitial).toBe(5);
    expect(document.querySelectorAll(paragraphs.selector)).toHaveLength(5);
    const protectedNodes = resolveForbiddenMustExistSelectors('required', config.forbiddenSelectors, [])
      .flatMap((selector) => [...document.querySelectorAll(selector)]);
    expect(protectedNodes.some((node) => node.matches('nav.reference-toc'))).toBe(true);
    expect(protectedNodes.some((node) => node.matches('pre'))).toBe(true);
    expect(protectedNodes.some((node) => node.matches('code'))).toBe(true);
  });

  it('requires each mixed-manpage source part and does not accept only its nested paragraph translation', () => {
    const fixture = establishedFixtures.find(({id}) => id === 'ubuntu-manpage')!;
    const {document} = parseHTML(fixture.html);
    const parts = fixture.translationParts!;
    const child = document.querySelector('#body2')!;
    child.insertAdjacentHTML('beforeend', `<span class="fluent-read-bilingual-content">测试译文：${child.textContent}</span>`);
    const onlyChild = inspectFixtureTranslationParts({parts}, document);
    expect(onlyChild.map(({translated}: {translated: boolean}) => translated)).toEqual([false, true, false]);
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(false);
    const mixed = document.querySelector('#mixed-command')!;
    const segment = document.createElement('span');
    segment.setAttribute('data-fr-translation-segment', 'true');
    while (mixed.firstChild !== child) segment.append(mixed.firstChild!);
    mixed.insertBefore(segment, child);
    segment.insertAdjacentHTML('beforeend', `<span class="fluent-read-bilingual-content">测试译文：${segment.textContent}</span>`);
    const second = document.querySelector('#second-command')!;
    second.insertAdjacentHTML('beforeend', `<span class="fluent-read-bilingual-content">测试译文：${second.innerHTML}</span>`);
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(true);
    const translatedCommand = second.querySelector('.fluent-read-bilingual-content b')!;
    const exactCommand = translatedCommand.textContent;
    translatedCommand.textContent = exactCommand!.replace(/\s+/gu, ' ');
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(false);
    translatedCommand.textContent = exactCommand;
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(true);
    segment.querySelector('.fluent-read-bilingual-content')!.textContent = `测试译文：${parts[0].sourceIncludes}`;
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(false);
    expect(fixture.restoreSelectors).toEqual(['#mixed-command', '#second-command']);
  });

  it('rejects X Chat metadata copied into the translated message or duplicate translated parts', () => {
    const fixture = establishedFixtures.find(({id}) => id === 'x-chat')!;
    const {document} = parseHTML(fixture.html);
    const parts = fixture.translationParts!;
    const owner = document.querySelector('#body1')!;
    const source = parts[0].sourceIncludes;
    owner.insertAdjacentHTML('beforeend', `<span class="fluent-read-bilingual-content">测试译文：${source}</span>`);
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(true);
    const translation = owner.querySelector('.fluent-read-bilingual-content')!;
    translation.textContent += ' Yesterday 10:30 Edited';
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(false);
    translation.textContent = source;
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(false);
    translation.textContent = `测试译文：${source}`;
    owner.appendChild(translation.cloneNode(true));
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(false);
  });

  it('compares local echo prose across actual inline Text slots while keeping exact code and link markup', () => {
    const {document} = parseHTML('<p id="owner"><span class="fluent-read-bilingual-content">测试译文：This readable opening describes a <a href="https://example.test/reference">测试译文：useful reference</a> 测试译文：with <code>requestIdleCallback()</code>测试译文：.</span></p>');
    const parts = [{selector: '#owner', sourceIncludes: 'This readable opening describes a useful reference with requestIdleCallback().',
      preservedText: ['requestIdleCallback()'], omittedText: ['Fixture Author'],
      preservedMarkup: [{selector: 'code', text: 'requestIdleCallback()'},
        {selector: 'a[href="https://example.test/reference"]', text: '测试译文：useful reference'}]}];
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(true);
    const wrapper = document.querySelector('.fluent-read-bilingual-content')!;
    const code = wrapper.querySelector('code')!;
    code.textContent = '测试译文：requestIdleCallback()';
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(false);
    code.textContent = 'requestIdleCallback()';
    const link = wrapper.querySelector('a')!;
    link.setAttribute('href', 'https://wrong.test/reference');
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(false);
    link.setAttribute('href', 'https://example.test/reference');
    wrapper.insertAdjacentHTML('beforeend', '<span>Fixture 测试译文：Author</span>');
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(false);
    wrapper.lastChild!.remove();
    wrapper.firstChild!.textContent = 'This readable 其他译文：opening describes a ';
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(false);
  });

  it('still rejects missing Chinese, missing prose, duplicate owners and duplicate wrappers in slot echoes', () => {
    const {document} = parseHTML('<main><p id="owner"><span class="fluent-read-bilingual-content">测试译文：Readable <em>测试译文：inline source</em>测试译文： remains complete.</span></p></main>');
    const parts = [{selector: '#owner', sourceIncludes: 'Readable inline source remains complete.'}];
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(true);
    const owner = document.querySelector('#owner')!, wrapper = owner.querySelector('.fluent-read-bilingual-content')!;
    const html = wrapper.innerHTML;
    wrapper.innerHTML = html.replaceAll('测试译文：', '');
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(false);
    wrapper.innerHTML = html.replace('inline source', 'wrong source');
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(false);
    wrapper.innerHTML = html;
    owner.append(wrapper.cloneNode(true));
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(false);
    owner.lastChild!.remove();
    owner.parentElement!.append(owner.cloneNode(true));
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(false);
  });

  it('changes one original fixture Text slot despite a translated link clone and rejects two original links', async () => {
    const source = readFileSync(new URL('../scripts/run-site-adaptation-test.cjs', import.meta.url), 'utf8');
    const start = source.indexOf('async function fixtureHostWrite(');
    const end = source.indexOf('async function runFixtureDynamic(', start);
    expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
    const {document} = parseHTML('<html><body><p id="body">Original <a href="#same">inline source</a><span class="fluent-read-bilingual-content">测试 <a href="#same">译文 inline source</a></span></p></body></html>');
    const {document: expected} = parseHTML('<html><body><p id="body">Original <a href="#same">inline source</a></p></body></html>');
    const {Script} = require('node:vm');
    const write = new Script(`(${source.slice(start, end)})`, {filename: 'actual-fixture-host-write.cjs'}).runInNewContext({
      document, window: {__adaptationFixtureHost: expected}, NodeFilter: {SHOW_TEXT: 4},
    }) as (page: {evaluate: (fn: (operation: unknown) => unknown, operation: unknown) => Promise<unknown>},
      operation: Record<string, unknown>) => Promise<void>;
    const page = {evaluate: async (fn: (operation: unknown) => unknown, operation: unknown) => fn(operation)};
    const link = document.querySelector('#body > a')!, node = link.firstChild;
    const wrapper = document.querySelector('.fluent-read-bilingual-content')!;
    const wrapperHtml = wrapper.outerHTML;
    await write(page, {kind: 'text', selector: '#body a', from: 'inline source', to: 'updated source'});
    expect(link.firstChild).toBe(node);
    expect(node?.textContent).toBe('updated source');
    expect(link.getAttribute('href')).toBe('#same');
    expect(expected.querySelector('#body a')?.textContent).toBe('updated source');
    expect(wrapper.outerHTML).toBe(wrapperHtml);
    document.querySelector('#body')!.insertAdjacentHTML('beforeend', '<a href="#second">second original</a>');
    await expect(write(page, {kind: 'text', selector: '#body a', from: 'updated source', to: 'must reject'})).rejects.toThrow('must be unique');
    expect(node?.textContent).toBe('updated source');
    expect(expected.querySelector('#body a')?.textContent).toBe('updated source');
    expect(wrapper.outerHTML).toBe(wrapperHtml);
  });

  it('targets visible package readme content while requiring both fenced and inline code protection', () => {
    const {document} = parseHTML('<main><div hidden><p class="detail-lead-text">A hidden responsive summary.</p></div><section class="detail-tab-readme-content"><p>Language navigation</p><p>A wrapper around <a href="https://api.flutter.dev/flutter/widgets/InheritedWidget-class.html">InheritedWidget</a> for reuse.</p><h2>Usage</h2><p>Read the <code>provider</code> state.</p><pre><code>final value = context.watch&lt;int&gt;();</code></pre></section></main>');
    const config = cases['pubdev-provider'];
    const targets = [...document.querySelectorAll(config.hoverSelector)];
    expect(targets).toHaveLength(1);
    expect(targets[0].textContent).toBe('A wrapper around InheritedWidget for reuse.');
    expect(targets[0].closest('[hidden]')).toBeNull();
    const protectedNodes = config.forbiddenMustExistSelectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
    expect(protectedNodes.some((node) => node.tagName === 'PRE')).toBe(true);
    expect(protectedNodes.some((node) => node.tagName === 'CODE' && node.parentElement?.tagName === 'P')).toBe(true);
  });

  it('keeps the English PR title, body headings, paragraphs and lists as separate requirements', () => {
    const rules = normalizeCoverageRules(cases['github-project-pr'].coverageRules);
    expect(rules.map(({selector}) => selector)).toEqual([
      'main h1',
      "[id^='pullrequest-'] .markdown-body > h2",
      "[id^='pullrequest-'] .markdown-body > p:first-of-type",
      "[id^='pullrequest-'] .markdown-body > ul:first-of-type > li:nth-child(-n+3)",
    ]);
    expect(rules.every(({selector}) => !selector.includes(','))).toBe(true);
    expect(rules.every(({trackDynamic}) => trackDynamic)).toBe(true);
    const prHoverTargets = normalizeHoverTargets(cases['github-project-pr'].hoverTargets, {
      coverageRules: rules,
    });
    expect(prHoverTargets.map(({selector}) => selector)).toEqual([
      'main h1',
      "[id^='pullrequest-'] .markdown-body > h2",
      "[id^='pullrequest-'] .markdown-body > p:first-of-type",
      "[id^='pullrequest-'] .markdown-body > ul:first-of-type > li:nth-child(-n+3)",
    ]);
    expect(prHoverTargets.find(({selector}) => selector.endsWith('> h2'))?.sourceIncludes).toEqual([
      'Problem',
    ]);
    expect(prHoverTargets.find(({selector}) => selector.includes('> li:nth-child'))?.sourceIncludes).toEqual([
      'Resolve explicit selections',
    ]);
    expect(rules.find(({name}) => name === 'body-list-items')?.sourceIncludes).toEqual([
      'Resolve explicit selections',
    ]);
    expect(cases['github-project-pr'].forbiddenMustExistSelectors).toEqual([
      "button[aria-haspopup='dialog'][aria-label*='search' i]",
    ]);
    expect(cases['github-project-pr'].interactionScenarios).toEqual([
      expect.objectContaining({
        triggerSelector: "button[aria-haspopup='dialog'][aria-label*='search' i]",
        openKey: 'click',
        dialogSelector: "[role='dialog'][aria-modal='true']:has([role='combobox'])",
        comboboxSelector: "[role='combobox']",
        listboxSelector: "[role='listbox']",
        inputText: 'issues',
        closeAttempts: 3,
      }),
    ]);
  });
});

// 在既有 suite 内运行实际 tracker 与既有消息 reader；不加载生产 runtime、不启动浏览器。
const {beginCoverageCompletionPass, verifyCoverageUnchanged, createUnchangedCompletionReader, readCoverageReport, readCoverageStatuses} =
  require('../scripts/run-site-translation-test.cjs');
type CompletionQuery = {selector: string; index: number; source: string; sessionId: number};
type CompletionReply = (queries: CompletionQuery[]) => unknown | Promise<unknown>;
type CompletionStatus = {token: string; rule: string; source: string; connected: boolean; eligible: boolean;
  translated: boolean; loading: boolean; retry: boolean; verifiedUnchanged?: boolean; reason?: string};
type CompletionBatch = Array<{bindingId: number; query: {selector: string; index: number; source: string; sessionId: number}}>;
type CompletionTracker = {
  beginCompletionPass: (sessionId: number | null) => number;
  metrics: () => Record<string, number>;
  discardUnchangedQueries: (batch: CompletionBatch) => void;
  snapshotMissing: () => Array<{token: string}>;
  prepareUnchangedQueries: (tokens: string[], sessionId: number, pass: number, deadline?: number) => CompletionBatch;
  acceptUnchangedQueries: (batch: CompletionBatch, response: unknown, sessionId: number, pass: number) => void;
  report: () => Array<{name: string; seenCount: number; translatedCount: number; verifiedUnchangedCount: number; completedCount: number}>;
  missingStatuses: (tokens: string[]) => CompletionStatus[];
  restorationReport: () => unknown[];
  reset: () => void;
  stop: () => void;
};
async function withCompletionFixture(
  run: (fixture: {document: Document; tracker: CompletionTracker;
    page: {evaluate: (fn: (argument: unknown) => unknown, argument: unknown) => Promise<unknown>;
      url: () => string; waitForFunction?: (fn: unknown, argument: unknown, options?: {timeout: number; polling?: number}) => Promise<void>}; rules: unknown[];
    trustedReader: (reply: CompletionReply) => Promise<(queries: CompletionQuery[], remainingMs?: number) => Promise<unknown>>;
    mutate: (records: unknown[]) => void; observerOptions: () => MutationObserverInit}) => Promise<void>,
  html = '<main><h2>Cookies</h2><h2>Cookies</h2><p>A full paragraph stays eligible.</p></main>',
  additionalRules: unknown[] = [],
  styleReader: (element: Element) => {display: string; visibility: string} = () => ({display: 'block', visibility: 'visible'}),
) {
  const {document, window} = parseHTML(`<html><body>${html}</body></html>`);
  Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {configurable: true,
    value: () => ({width: 400, height: 40, top: 0, left: 0, right: 400, bottom: 40})});
  let deliver: (records: unknown[]) => void = () => {};
  let observed: MutationObserverInit = {};
  class Observer {
    constructor(callback: typeof deliver) { deliver = callback; }
    observe(_target: unknown, options: MutationObserverInit) { observed = options; }
    disconnect() {}
  }
  const ownedUrl = 'https://example.test/owned-completion';
  let replySource: CompletionReply = () => null;
  const chrome = {runtime: {lastError: null as {message: string} | null}, tabs: {
    query: vi.fn(async () => [{id: 7, url: ownedUrl}]),
    get: vi.fn((id: number, reply: (tab: {id: number; url: string}) => void) => reply({id, url: ownedUrl})),
    sendMessage: vi.fn((id: number, message: {type: string; unchangedQueries: CompletionQuery[]},
      options: {frameId: number}, reply: (response: unknown) => void) => {
      expect(id).toBe(7);
      expect(options).toEqual({frameId: 0});
      expect(message.type).toBe('getFullPageTranslationState');
      expect(message.unchangedQueries.length).toBeLessThanOrEqual(16);
      const currentReplySource = replySource;
      void Promise.resolve().then(() => currentReplySource(message.unchangedQueries)).then(reply, (error: Error) => {
        chrome.runtime.lastError = {message: error.message};
        try { reply(undefined); } finally { chrome.runtime.lastError = null; }
      });
    }),
  }};
  const globals = {window, document, Node: window.Node, HTMLElement: window.HTMLElement,
    HTMLAnchorElement: window.HTMLAnchorElement, MutationObserver: Observer, chrome,
    getComputedStyle: styleReader};
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
  }
  const page: {evaluate: (fn: (argument: unknown) => unknown, argument: unknown) => Promise<unknown>;
    url: () => string; waitForFunction?: (fn: unknown, argument: unknown, options?: {timeout: number; polling?: number}) => Promise<void>} = {
    evaluate: async (fn, argument) => fn(argument), url: () => ownedUrl,
  };
  const worker = {url: () => 'chrome-extension://owned/background.js',
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg)};
  const trustedReader = async (reply: CompletionReply) => {
    replySource = reply;
    return createUnchangedCompletionReader({serviceWorkers: () => [worker]}, page, 2000);
  };
  const rules = normalizeCoverageRules([
    {name: 'headings', selector: 'main h2', kind: 'heading', minInitial: 2, trackDynamic: true, sourceIncludes: ['Cookies']},
    {name: 'paragraphs', selector: 'main p', kind: 'content', minInitial: 1, trackDynamic: true,
      sourceIncludes: ['A full paragraph']},
    ...additionalRules,
  ]);
  let tracker: CompletionTracker | undefined;
  try {
    await installCoverageTracker(page, rules);
    tracker = (window as unknown as Record<string, CompletionTracker>)[COVERAGE_TRACKER_KEY];
    await run({document: document as unknown as Document, tracker, page, rules, trustedReader,
      observerOptions: () => observed,
      mutate: records => deliver(records.filter(record => {
        const mutation = record as {type: string; attributeName?: string};
        return mutation.type !== 'attributes' || !observed.attributeFilter ||
          observed.attributeFilter.includes(mutation.attributeName || '');
      })),
    });
  } finally {
    tracker?.stop();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}
function acceptedCompletion(query: CompletionBatch[number]['query'], generation = 1) {
  return {status: 'available', reason: 'accepted-result-identical', sessionId: query.sessionId,
    source: query.source, sources: [query.source], outputs: [query.source], sourceCurrent: true,
    generation, renderCommitGeneration: 1, configuredService: 'freeTranslation', targetLanguage: 'zh-CN',
    completedAtUnixMs: 1791410000000, requestBoundary: 'accepted-same-session-result-reuse', upstreamDispatchAndRoute: 'unavailable'};
}
function prepareCompletion(tracker: CompletionTracker, sessionId = 10) {
  const pass = tracker.beginCompletionPass(sessionId);
  const tokens = tracker.snapshotMissing().map(item => item.token);
  const batch = tracker.prepareUnchangedQueries(tokens, sessionId, pass, Date.now() + 2000);
  return {pass, tokens, batch, sessionId};
}
function acceptCompletion(tracker: CompletionTracker, prepared: ReturnType<typeof prepareCompletion>,
  outcomes: unknown[] = prepared.batch.map((item, index) => acceptedCompletion(item.query, index + 1))) {
  tracker.acceptUnchangedQueries(prepared.batch, {status: 'success', sessionId: prepared.sessionId, outcomes},
    prepared.sessionId, prepared.pass);
}

function currentCompletionResponse(queries: CompletionQuery[], sessionId = 10) {
  return {status: 'success', sessionId, outcomes: queries.map(query => acceptedCompletion(query))};
}

describe('site coverage exact owner completion v2', () => {
  it('counts Chinese wrappers separately and requires an exact completion for every other owner', async () => {
    await withCompletionFixture(async ({document, tracker, rules, page, trustedReader}) => {
      const paragraph = document.querySelector('p')!;
      const wrapper = document.createElement('span');
      wrapper.className = 'fluent-read-bilingual-content';
      wrapper.setAttribute('data-fr-translation-owned', 'true');
      wrapper.textContent = '完整段落译文';
      paragraph.append(wrapper);
      const prepared = prepareCompletion(tracker);
      expect(prepared.batch.map(item => item.query)).toEqual([
        {selector: 'main h2', index: 0, source: 'Cookies', sessionId: 10},
        {selector: 'main h2', index: 1, source: 'Cookies', sessionId: 10},
      ]);
      tracker.acceptUnchangedQueries(prepared.batch.slice(0, 1), {status: 'success', sessionId: 10,
        outcomes: [acceptedCompletion(prepared.batch[0].query)]}, 10, prepared.pass);
      expect(() => assertCoverageReport(rules, tracker.report(), 'one sibling missing')).toThrow('headings');
      tracker.acceptUnchangedQueries(prepared.batch.slice(1), {status: 'success', sessionId: 10,
        outcomes: [acceptedCompletion(prepared.batch[1].query)]}, 10, prepared.pass);
      expect(() => assertCoverageReport(rules, tracker.report(), 'untrusted aggregate')).toThrow();
      const forgedReport = await readCoverageReport(page);
      expect(forgedReport).toMatchObject([
        {seenCount: 2, translatedCount: 0, verifiedUnchangedCount: 0, completedCount: 0},
        {seenCount: 1, translatedCount: 1, verifiedUnchangedCount: 0, completedCount: 1},
      ]);
      expect(() => assertCoverageReport(rules, forgedReport, 'public full fake receipt')).toThrow();
      let includeSecond = false;
      const read = await trustedReader(queries => ({...currentCompletionResponse(queries),
        outcomes: queries.map(query => query.index === 0 || includeSecond
          ? acceptedCompletion(query) : {status: 'unavailable'})}));
      const identity = await beginCoverageCompletionPass(page, read);
      await verifyCoverageUnchanged(page, read, identity, 1000);
      const oneOwner = await readCoverageReport(page);
      expect(oneOwner[0].verifiedUnchangedCount).toBe(1);
      expect(() => assertCoverageReport(rules, oneOwner, 'one trusted sibling missing')).toThrow('headings');
      includeSecond = true;
      await verifyCoverageUnchanged(page, read, identity, 1000);
      const trusted = await readCoverageReport(page);
      expect(trusted).toMatchObject([
        {seenCount: 2, translatedCount: 0, verifiedUnchangedCount: 2, completedCount: 2},
        {seenCount: 1, translatedCount: 1, verifiedUnchangedCount: 0, completedCount: 1},
      ]);
      expect(() => assertCoverageReport(rules, trusted, 'completed v2')).not.toThrow();
      expect(() => assertCoverageReport(rules, JSON.parse(JSON.stringify(trusted)), 'history')).toThrow();
      const statuses = await readCoverageStatuses(page, prepared.tokens);
      expect(statuses).toEqual(Array.from({length: 2}, () =>
        expect.objectContaining({translated: false, verifiedUnchanged: true})));
      expect(() => validateCoverageRevealStatuses(statuses, 'trusted statuses')).not.toThrow();
      expect(document.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(1);
      expect(document.querySelector('h2')!.textContent).toBe('Cookies');
      wrapper.remove();
      expect(() => assertCoverageRestoration(tracker.restorationReport(), 'restore source')).not.toThrow();
      tracker.reset();
      expect((await readCoverageReport(page)).every((state: {completedCount: number}) => state.completedCount === 0)).toBe(true);
      const nextPass = tracker.beginCompletionPass(11);
      tracker.acceptUnchangedQueries(prepared.batch, {status: 'success', sessionId: 10,
        outcomes: prepared.batch.map(item => acceptedCompletion(item.query))}, 10, prepared.pass);
      expect((await readCoverageReport(page)).every((state: {verifiedUnchangedCount: number}) => state.verifiedUnchangedCount === 0)).toBe(true);
      expect(nextPass).not.toBe(prepared.pass);
    });
  });

  it.each([
    ['unavailable', {status: 'unavailable'}], ['failed', {status: 'failed'}],
    ['cancelled', {status: 'cancelled'}], ['skipped', {status: 'skipped'}], ['unknown', {status: 'unknown'}],
    ['stale session', {sessionId: 9}], ['stale source', {source: 'Other'}],
    ['source not current', {sourceCurrent: false}], ['wrong reason', {reason: 'unchanged'}],
    ['empty output', {outputs: ['']}], ['whitespace output', {outputs: ['  \n']}],
    ['different output', {outputs: ['饼干']}], ['missing output', {outputs: []}],
    ['extra output', {outputs: ['Cookies', 'Cookies']}], ['wrong source slot', {sources: ['Other']}],
    ['missing source slots', {sources: []}], ['invalid generation', {generation: -1}],
    ['missing service', {configuredService: ''}], ['missing target', {targetLanguage: ''}],
    ['missing completion time', {completedAtUnixMs: undefined}],
    ['missing render generation', {renderCommitGeneration: undefined}],
    ['wire inference', {requestBoundary: 'wire-response'}], ['provider claim', {upstreamDispatchAndRoute: 'live'}],
  ])('gives no completion credit for %s', async (_label, override) => {
    await withCompletionFixture(async ({tracker, page, rules, trustedReader}) => {
      const tokens = tracker.snapshotMissing().map(item => item.token);
      const read = await trustedReader(queries => ({...currentCompletionResponse(queries),
        outcomes: queries.map(query => ({...acceptedCompletion(query), ...override}))}));
      const identity = await beginCoverageCompletionPass(page, read);
      await verifyCoverageUnchanged(page, read, identity, 1000);
      const report = await readCoverageReport(page);
      expect(report.every((state: {verifiedUnchangedCount: number}) => state.verifiedUnchangedCount === 0)).toBe(true);
      expect(() => assertCoverageReport(rules, report, 'rejected')).toThrow();
      const statuses = await readCoverageStatuses(page, tokens);
      expect(() => validateCoverageRevealStatuses(statuses, 'rejected')).toThrow();
    });
  });

  it.each(['loading', 'retry', 'wrapper', 'hidden', 'disconnect', 'source', 'source-back', 'remount', 'sibling-index', 'generation'])
    ('revalidates original Node and generation before and after the query: %s', async (change) => {
      await withCompletionFixture(async ({document, tracker, mutate}) => {
        const prepared = prepareCompletion(tracker);
        const node = document.querySelector('h2')!;
        const emit = (target: Node, type = 'childList', addedNodes: Node[] = [], removedNodes: Node[] = []) =>
          mutate([{type, target, addedNodes, removedNodes}]);
        if (['loading', 'retry', 'wrapper'].includes(change)) {
          const artifact = document.createElement('span');
          artifact.className = change === 'loading' ? 'fluent-read-loading'
            : change === 'retry' ? 'fluent-read-retry-wrapper' : 'fluent-read-bilingual-content';
          artifact.setAttribute('data-fr-translation-owned', 'true');
          node.append(artifact);
        } else if (change === 'hidden') node.setAttribute('hidden', '');
        else if (change === 'disconnect') node.remove();
        else if (change === 'remount') node.replaceWith(node.cloneNode(true));
        else if (change === 'sibling-index') node.before(node.nextElementSibling!);
        else {
          node.firstChild!.nodeValue = 'Different source';
          if (change !== 'source') emit(node.firstChild!, 'characterData');
          if (change === 'source-back') {node.firstChild!.nodeValue = 'Cookies'; emit(node.firstChild!, 'characterData');}
        }
        tracker.acceptUnchangedQueries(prepared.batch.slice(0, 1), {status: 'success', sessionId: 10,
          outcomes: [acceptedCompletion(prepared.batch[0].query)]}, 10, prepared.pass);
        expect(tracker.report().every(state => state.verifiedUnchangedCount === 0)).toBe(true);
        expect(tracker.prepareUnchangedQueries([prepared.tokens[0]], 10, prepared.pass))
          .toHaveLength(change === 'sibling-index' ? 1 : 0);
      });
    });

  it('revokes pending qualification when same-text siblings swap and return with unchanged selector/index/source/generation', async () => {
    await withCompletionFixture(async ({document, tracker, mutate}) => {
      const prepared = prepareCompletion(tracker);
      const [first, second] = [...document.querySelectorAll('h2')];
      const parent = first.parentElement!;
      expect(tracker.metrics().pendingCompletionBindings).toBe(3);
      first.before(second);
      mutate([{type: 'childList', target: parent, addedNodes: [second], removedNodes: [second]}]);
      expect(tracker.metrics().pendingCompletionBindings).toBe(0);
      second.before(first);
      mutate([{type: 'childList', target: parent, addedNodes: [first], removedNodes: [first]}]);
      expect(document.querySelectorAll('h2')[0]).toBe(first);
      expect(document.querySelectorAll('h2')[1]).toBe(second);
      expect(first.textContent).toBe(second.textContent);
      expect(tracker.snapshotMissing().map(item => item.token)).toEqual(prepared.tokens);
      expect(tracker.metrics().hostMutationCount).toBe(2);
      acceptCompletion(tracker, prepared);
      expect(tracker.report().every(state => state.verifiedUnchangedCount === 0)).toBe(true);
    });
  });

  it('does not grant credit from spoofed DOM receipts or an available response without a pending query', async () => {
    await withCompletionFixture(async ({document, tracker}) => {
      const pass = tracker.beginCompletionPass(10);
      const owner = document.querySelector('h2')!;
      const query = {selector: 'main h2', index: 0, source: 'Cookies', sessionId: 10};
      owner.setAttribute('data-fr-unchanged-completion', JSON.stringify(acceptedCompletion(query)));
      owner.setAttribute('data-fr-owner-completed', 'true');
      tracker.acceptUnchangedQueries([{bindingId: 1, query}], {status: 'success', sessionId: 10,
        outcomes: [acceptedCompletion(query)]}, 10, pass);
      expect(tracker.metrics().pendingCompletionBindings).toBe(0);
      expect(tracker.report().every(state => state.verifiedUnchangedCount === 0)).toBe(true);
      const prepared = prepareCompletion(tracker);
      tracker.discardUnchangedQueries(prepared.batch);
      acceptCompletion(tracker, prepared);
      expect(tracker.report().every(state => state.verifiedUnchangedCount === 0)).toBe(true);
    });
  });

  it.each(['success', 'unavailable', 'exception', 'deadline'])
    ('cleans all batch Node tokens after collection %s', async (outcome) => {
      await withCompletionFixture(async ({page, tracker, trustedReader}) => {
        const read = await trustedReader(queries => {
          if (queries.length) {
            expect(tracker.metrics().pendingCompletionBindings).toBe(3);
            if (outcome === 'unavailable') return null;
            if (outcome === 'exception') throw new Error('message read rejected');
          }
          return currentCompletionResponse(queries);
        });
        const identity = await beginCoverageCompletionPass(page, read);
        await verifyCoverageUnchanged(page, read, identity, outcome === 'deadline' ? 0 : 1000);
        expect(tracker.metrics().pendingCompletionBindings).toBe(0);
        const report = await readCoverageReport(page);
        if (outcome !== 'success') expect(report.every((state: {verifiedUnchangedCount: number}) => state.verifiedUnchangedCount === 0)).toBe(true);
        else expect(report.map((state: {verifiedUnchangedCount: number}) => state.verifiedUnchangedCount)).toEqual([2, 1]);
      });
    });

  it('invalidates accepted completion after observed source change-back and pass reset', async () => {
    await withCompletionFixture(async ({document, tracker, page, trustedReader, mutate}) => {
      const read = await trustedReader(currentCompletionResponse);
      const identity = await beginCoverageCompletionPass(page, read);
      await verifyCoverageUnchanged(page, read, identity, 1000);
      expect((await readCoverageReport(page))[0].verifiedUnchangedCount).toBe(2);
      const tokens = tracker.snapshotMissing().map(item => item.token);
      const node = document.querySelector('h2')!;
      const text = node.firstChild!;
      text.nodeValue = 'New prose';
      mutate([{type: 'characterData', target: text, addedNodes: [], removedNodes: []}]);
      text.nodeValue = 'Cookies';
      mutate([{type: 'characterData', target: text, addedNodes: [], removedNodes: []}]);
      expect((await readCoverageReport(page)).every((state: {verifiedUnchangedCount: number}) => state.verifiedUnchangedCount === 0)).toBe(true);
      tracker.beginCompletionPass(null);
      expect(tracker.prepareUnchangedQueries(tokens, 10, identity.pass, Date.now() + 2000)).toHaveLength(0);
    });
  });

  it.each(['detach', 'remount', 'loading', 'retry', 'wrapper', 'session'])
    ('rechecks already accepted credit when the owner later changes: %s', async (change) => {
      await withCompletionFixture(async ({document, tracker, page, trustedReader}) => {
        const tokens = tracker.snapshotMissing().map(item => item.token);
        const read = await trustedReader(currentCompletionResponse);
        const identity = await beginCoverageCompletionPass(page, read);
        await verifyCoverageUnchanged(page, read, identity, 1000);
        expect((await readCoverageReport(page))[0].verifiedUnchangedCount).toBe(2);
        const owner = document.querySelector('h2')!;
        if (change === 'detach') owner.remove();
        else if (change === 'remount') owner.replaceWith(owner.cloneNode(true));
        else if (change === 'session') tracker.beginCompletionPass(11);
        else {
          const artifact = document.createElement('span');
          artifact.className = change === 'wrapper' ? 'fluent-read-bilingual-content'
            : change === 'loading' ? 'fluent-read-loading' : 'fluent-read-retry-wrapper';
          artifact.setAttribute('data-fr-translation-owned', 'true');
          owner.append(artifact);
        }
        expect((await readCoverageStatuses(page, [tokens[0]]))[0].verifiedUnchanged).toBe(false);
        expect((await readCoverageReport(page))[0].verifiedUnchangedCount).toBeLessThan(2);
      });
    });

  it('accepts nonempty normalized-equal output without inserting translated DOM', async () => {
    await withCompletionFixture(async ({document, page, trustedReader}) => {
      const read = await trustedReader(queries => ({...currentCompletionResponse(queries), outcomes: queries.map(query => ({
        ...acceptedCompletion(query), outputs: [' \n' + query.source.replaceAll(' ', '  ') + '  '],
      }))}));
      const identity = await beginCoverageCompletionPass(page, read);
      await verifyCoverageUnchanged(page, read, identity, 1000);
      expect((await readCoverageReport(page)).map((state: {verifiedUnchangedCount: number}) => state.verifiedUnchangedCount)).toEqual([2, 1]);
      expect(document.querySelectorAll('[data-fr-translation-owned="true"]')).toHaveLength(0);
    });
  });

  it('keeps terminal and stale statuses strict even when a caller supplies an unchanged flag', () => {
    const status = {token: '0:0:0', rule: 'owner', source: 'Cookies', connected: true, eligible: true,
      translated: false, loading: false, retry: false, verifiedUnchanged: true};
    expect(() => validateCoverageRevealStatuses([status], 'bare verified flag')).toThrow();
    for (const override of [{loading: true}, {retry: true}, {connected: false}, {eligible: false},
      {reason: 'stale-generation'}, {verifiedUnchanged: 'unknown'}]) {
      const untrustedStatuses = [{...status, ...override}];
      expect(() => validateCoverageRevealStatuses(untrustedStatuses, 'rejected')).toThrow();
    }
  });

  it('uses exact owner receipts in the existing bounded reveal settlement without extra reveal rounds', async () => {
    await withCompletionFixture(async ({page, rules, trustedReader}) => {
      const requests: number[] = [];
      const read = await trustedReader(queries => {requests.push(queries.length); return currentCompletionResponse(queries);});
      const identity = await beginCoverageCompletionPass(page, read);
      const waits = vi.fn(async (_fn: unknown, argument: unknown) => {
        if (argument && typeof argument === 'object' && 'token' in argument) throw new Error('Timeout waiting for Chinese wrapper');
      });
      page.waitForFunction = waits;
      const verified = vi.fn((remainingMs = 1000) => verifyCoverageUnchanged(page, read, identity, remainingMs));
      const statuses = await settleCoverageByReveal(page, 1000, 'receipt settlement', 0, verified);
      expect(statuses).toHaveLength(3);
      expect(statuses).toEqual(Array.from({length: 3}, () =>
        expect.objectContaining({translated: false, verifiedUnchanged: true})));
      expect(verified).toHaveBeenCalledTimes(1);
      expect(verified.mock.calls[0][0]).toBeGreaterThan(0);
      expect(verified.mock.calls[0][0]).toBeLessThanOrEqual(7000);
      expect(waits).toHaveBeenCalledTimes(4); // 原每节点 poll + 一次共享 idle；没有新 retry。
      expect(requests.filter(length => length > 0)).toEqual([3]);
      const report = await readCoverageReport(page);
      expect(() => assertCoverageReport(rules, report, 'settled v2')).not.toThrow();
    });
  });

  it('accepts the same owner-local generation for independent exact sibling owners', async () => {
    await withCompletionFixture(async ({page, trustedReader}) => {
      const read = await trustedReader(currentCompletionResponse);
      const identity = await beginCoverageCompletionPass(page, read);
      await verifyCoverageUnchanged(page, read, identity, 1000);
      expect((await readCoverageReport(page)).map((state: {verifiedUnchangedCount: number}) => state.verifiedUnchangedCount)).toEqual([2, 1]);
    });
  });

  it('rejects aggregate count inconsistencies and retains minimum and source anchor requirements', () => {
    const rules = normalizeCoverageRules([{name: 'owners', selector: 'p', kind: 'content', minInitial: 2,
      sourceIncludes: ['Expected source']}]);
    const state = {name: 'owners', seenCount: 2, translatedCount: 1, verifiedUnchangedCount: 1, completedCount: 2,
      sourceSamples: ['Expected source']};
    expect(() => assertCoverageReport(rules, [state], 'bare completion counts')).toThrow();
    for (const override of [{completedCount: 1}, {verifiedUnchangedCount: -1}, {completedCount: 3},
      {seenCount: 1, translatedCount: 0, completedCount: 1}, {sourceSamples: ['Wrong']}]) {
      expect(() => assertCoverageReport(rules, [{...state, ...override}], 'invalid')).toThrow();
    }
  });

  it('reads session first, batches only missing exact owners in groups of at most 16 and rereads session', async () => {
    const html = '<main>' + '<h2>Cookies</h2>'.repeat(18) + '<p>A full paragraph stays eligible.</p></main>';
    await withCompletionFixture(async ({page, rules, trustedReader}) => {
      const requests: CompletionQuery[][] = [];
      const read = await trustedReader(queries => {requests.push(queries); return currentCompletionResponse(queries);});
      const identity = await beginCoverageCompletionPass(page, read);
      expect(requests).toEqual([[]]);
      await verifyCoverageUnchanged(page, read, identity, 1000);
      expect(requests.filter(items => items.length).map(items => items.length)).toEqual([16, 3]);
      expect(requests[0]).toEqual([]);
      expect(requests.at(-1)).toEqual([]);
      expect(requests.flat().every(query => query.sessionId === 10)).toBe(true);
      const report = await readCoverageReport(page);
      expect(report).toMatchObject([{translatedCount: 0, verifiedUnchangedCount: 18, completedCount: 18},
        {translatedCount: 0, verifiedUnchangedCount: 1, completedCount: 1}]);
      expect(() => assertCoverageReport(rules, report, 'receipt')).not.toThrow();
    }, html);
  });

  it.each(['old-api', 'unavailable', 'session-rollover', 'malformed', 'read-error', 'node-replaced'])
    ('fails closed at the actual collection path for %s', async (failure) => {
      await withCompletionFixture(async ({document, page, rules, trustedReader}) => {
        let reads = 0;
        const read = await trustedReader(queries => {
          reads += 1;
          if (failure === 'old-api') return {isTranslated: true};
          if (failure === 'unavailable') return null;
          if (queries.length && failure === 'read-error') throw new Error('unavailable channel');
          if (queries.length && failure === 'node-replaced') {
            for (const node of document.querySelectorAll('h2, p')) node.replaceWith(node.cloneNode(true));
          }
          return {status: 'success', sessionId: failure === 'session-rollover' && reads >= 4 ? 11 : 10,
            outcomes: failure === 'malformed' && queries.length ? [] : queries.map(query => acceptedCompletion(query))};
        });
        const identity = await beginCoverageCompletionPass(page, read);
        await verifyCoverageUnchanged(page, read, identity, 1000);
        const report = await readCoverageReport(page);
        expect(report.every((state: {verifiedUnchangedCount: number}) => state.verifiedUnchangedCount === 0)).toBe(true);
        expect(() => assertCoverageReport(rules, report, 'failed collection')).toThrow();
      });
    });

  it('refuses the prior session on retranslation and never carries receipts across pass reset', async () => {
    await withCompletionFixture(async ({page, trustedReader}) => {
      const read = await trustedReader(currentCompletionResponse);
      const first = await beginCoverageCompletionPass(page, read);
      await verifyCoverageUnchanged(page, read, first, 1000);
      expect((await readCoverageReport(page))[0].verifiedUnchangedCount).toBe(2);
      const second = await beginCoverageCompletionPass(page, read, first.sessionId);
      expect(second.sessionId).toBeNull();
      await verifyCoverageUnchanged(page, read, second, 1000);
      expect((await readCoverageReport(page)).every((state: {verifiedUnchangedCount: number}) => state.verifiedUnchangedCount === 0)).toBe(true);
    });
  });

  it('bounds service worker discovery and message reads, and rejects late completion credit', async () => {
    vi.useFakeTimers();
    try {
      const url = 'https://example.test/owned';
      const hungWorker = {url: () => 'chrome-extension://owned/background.js',
        evaluate: () => new Promise(() => {})};
      const discovering = createUnchangedCompletionReader({serviceWorkers: () => [hungWorker]}, {url: () => url}, 1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await (await discovering)([])).toBeNull();
      let calls = 0;
      const worker = {url: hungWorker.url, evaluate: async () => ++calls === 1 ? 7 : new Promise(() => {})};
      const read = await createUnchangedCompletionReader({serviceWorkers: () => [worker]}, {url: () => url}, 1000);
      const reading = read([]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await reading).toBeNull();
    } finally { vi.useRealTimers(); }
    await withCompletionFixture(async ({page, trustedReader}) => {
      let now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        const read = await trustedReader(queries => {
          if (queries.length) now += 2001;
          return {status: 'success', sessionId: 10,
            outcomes: queries.map((query, index) => acceptedCompletion(query, index + 1))};
        });
        const identity = await beginCoverageCompletionPass(page, read);
        await verifyCoverageUnchanged(page, read, identity, 2000);
        expect((await readCoverageReport(page)).every((state: {verifiedUnchangedCount: number}) => state.verifiedUnchangedCount === 0)).toBe(true);
      } finally { clock.mockRestore(); }
    });
  });

  it('uses the owned service worker and exact tab/frame without creating or activating an options page', async () => {
    const url = 'https://example.test/owned';
    const sendMessage = vi.fn((_id, _message, _options, reply) => reply({status: 'success', sessionId: 10, outcomes: []}));
    const chrome = {runtime: {lastError: null as {message: string} | null}, tabs: {
      query: vi.fn(async () => [{id: 7, url}, {id: 8, url: 'https://other.test/'}]),
      get: vi.fn((id, reply) => reply({id, url})), sendMessage,
    }};
    const oldChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    Object.defineProperty(globalThis, 'chrome', {configurable: true, value: chrome});
    try {
      const worker = {url: () => 'chrome-extension://owned/background.js',
        evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg)};
      const context = {serviceWorkers: () => [worker]};
      const page = {url: () => url};
      const read = await createUnchangedCompletionReader(context, page, 1000);
      expect(await read([])).toMatchObject({sessionId: 10});
      expect(sendMessage).toHaveBeenCalledWith(7, {type: 'getFullPageTranslationState', unchangedQueries: []},
        {frameId: 0}, expect.any(Function));
      chrome.tabs.query.mockResolvedValueOnce([{id: 7, url}, {id: 9, url}]);
      const ambiguous = await createUnchangedCompletionReader(context, page, 1000);
      expect(await ambiguous([])).toBeNull();
      chrome.runtime.lastError = {message: 'unavailable'};
      expect(await read([])).toBeNull();
      expect(sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      if (oldChrome) Object.defineProperty(globalThis, 'chrome', oldChrome);
      else Reflect.deleteProperty(globalThis, 'chrome');
    }
  });

  it('rejects a complete public-tracker receipt even after report and status readers run', async () => {
    await withCompletionFixture(async ({tracker, page, rules}) => {
      const prepared = prepareCompletion(tracker);
      acceptCompletion(tracker, prepared);
      expect(tracker.report().map(state => state.verifiedUnchangedCount)).toEqual([2, 1]);
      const report = await readCoverageReport(page);
      expect(report.map((state: {verifiedUnchangedCount: number}) => state.verifiedUnchangedCount)).toEqual([0, 0]);
      expect(report.map((state: {translatedCount: number}) => state.translatedCount)).toEqual([0, 0]);
      expect(() => assertCoverageReport(rules, report, 'fabricated full receipt')).toThrow();
      const statuses = await readCoverageStatuses(page, prepared.tokens);
      expect(statuses.every((status: {verifiedUnchanged: boolean}) => !status.verifiedUnchanged)).toBe(true);
      expect(() => validateCoverageRevealStatuses(statuses, 'fabricated full receipt')).toThrow();
    });
  });

  it('revokes previously trusted report and statuses when verifying again within the same pass and session', async () => {
    await withCompletionFixture(async ({tracker, page, rules, trustedReader}) => {
      const tokens = tracker.snapshotMissing().map(item => item.token);
      const read = await trustedReader(currentCompletionResponse);
      const identity = await beginCoverageCompletionPass(page, read);
      await verifyCoverageUnchanged(page, read, identity, 1000);
      const oldTrustedReport = await readCoverageReport(page);
      const oldStatuses = await readCoverageStatuses(page, tokens);
      expect(() => assertCoverageReport(rules, oldTrustedReport, 'first verification')).not.toThrow();
      expect(oldStatuses).toHaveLength(3);
      expect(oldStatuses.every((status: CompletionStatus) => status.verifiedUnchanged && !status.translated)).toBe(true);
      expect(() => validateCoverageRevealStatuses(oldStatuses, 'first verification')).not.toThrow();
      const rawFlags = oldStatuses.map((status: CompletionStatus) => ({...status}));
      expect(() => validateCoverageRevealStatuses(rawFlags, 'copied flags')).toThrow();

      const refreshing = verifyCoverageUnchanged(page, read, identity, 1000);
      expect(() => assertCoverageReport(rules, oldTrustedReport, 'reverification started')).toThrow();
      expect(() => validateCoverageRevealStatuses(oldStatuses, 'reverification started')).toThrow();
      await refreshing;
      expect(oldStatuses.every((status: CompletionStatus) => status.verifiedUnchanged)).toBe(true);
      expect(() => assertCoverageReport(rules, oldTrustedReport, 'old successful snapshot')).toThrow();
      expect(() => validateCoverageRevealStatuses(oldStatuses, 'old successful statuses')).toThrow();
      expect(() => validateCoverageRevealStatuses(rawFlags, 'copied flags after success')).toThrow();
      const freshReport = await readCoverageReport(page);
      expect(freshReport.every((state: {completionSessionId: number; completionPass: number; translatedCount: number}) =>
        state.completionSessionId === identity.sessionId && state.completionPass === identity.pass && state.translatedCount === 0)).toBe(true);
      expect(freshReport.map((state: {verifiedUnchangedCount: number}) => state.verifiedUnchangedCount)).toEqual([2, 1]);
      expect(() => assertCoverageReport(rules, freshReport, 'fresh successful snapshot')).not.toThrow();
      const freshStatuses = await readCoverageStatuses(page, tokens);
      expect(() => validateCoverageRevealStatuses(freshStatuses, 'fresh successful statuses')).not.toThrow();
    });
  });

  it('denies fabricated public acceptance when the owned channel returns unavailable for that owner', async () => {
    await withCompletionFixture(async ({tracker, page, rules, trustedReader}) => {
      const accept = tracker.acceptUnchangedQueries;
      const read = await trustedReader(queries => ({...currentCompletionResponse(queries),
        outcomes: queries.map(() => ({status: 'unavailable', reason: 'no-current-accepted-completion'}))}));
      const identity = await beginCoverageCompletionPass(page, read);
      tracker.acceptUnchangedQueries = (batch, _actualReply, sessionId, pass) => {
        accept(batch, {status: 'success', sessionId, outcomes: batch.map(item => acceptedCompletion(item.query))}, sessionId, pass);
      };
      try {
        await verifyCoverageUnchanged(page, read, identity, 1000);
        expect(tracker.report().map(state => state.verifiedUnchangedCount)).toEqual([2, 1]);
        const report = await readCoverageReport(page);
        expect(report.map((state: {verifiedUnchangedCount: number}) => state.verifiedUnchangedCount)).toEqual([0, 0]);
        expect(() => assertCoverageReport(rules, report, 'owned unavailable; public fabricated')).toThrow();
        const tokens = tracker.snapshotMissing().map(item => item.token);
        expect(() => validateCoverageRevealStatuses(tracker.missingStatuses(tokens), 'public flags')).toThrow();
        const statuses = await readCoverageStatuses(page, tokens);
        expect(statuses.every((status: {verifiedUnchanged: boolean}) => !status.verifiedUnchanged)).toBe(true);
      } finally { tracker.acceptUnchangedQueries = accept; }
    });
  });

  it('rejects an unbranded reader even when it returns complete valid-shaped session receipts', async () => {
    await withCompletionFixture(async ({page, rules, trustedReader}) => {
      const rawRead = vi.fn(currentCompletionResponse);
      const identity = await beginCoverageCompletionPass(page, rawRead);
      expect(identity.sessionId).toBeNull();
      await verifyCoverageUnchanged(page, rawRead, identity, 1000);
      expect(rawRead).not.toHaveBeenCalled();
      const owned = await trustedReader(currentCompletionResponse);
      const ownedIdentity = await beginCoverageCompletionPass(page, owned);
      await verifyCoverageUnchanged(page, rawRead, ownedIdentity, 1000);
      const report = await readCoverageReport(page);
      expect(report.every((state: {verifiedUnchangedCount: number}) => state.verifiedUnchangedCount === 0)).toBe(true);
      expect(() => assertCoverageReport(rules, report, 'unbranded reader')).toThrow();
      expect(rawRead).not.toHaveBeenCalled();
    });
  });

  it.each(['query-to-accept', 'accepted-to-report'])
    ('revokes lang edit-return receipt qualification across %s using the existing observer', async (phase) => {
      await withCompletionFixture(async ({document, tracker, page, rules, trustedReader, mutate, observerOptions}) => {
        const owner = document.querySelector('h2')!;
        const text = owner.firstChild;
        const tokens = tracker.snapshotMissing().map(item => item.token);
        const revision = tracker.metrics().hostMutationCount;
        const changeBack = () => {
          owner.setAttribute('lang', 'fr');
          mutate([{type: 'attributes', attributeName: 'lang', target: owner, addedNodes: [], removedNodes: []}]);
          owner.removeAttribute('lang');
          mutate([{type: 'attributes', attributeName: 'lang', target: owner, addedNodes: [], removedNodes: []}]);
        };
        const read = await trustedReader(queries => {
          const result = currentCompletionResponse(queries);
          if (queries.length && phase === 'query-to-accept') changeBack();
          return result;
        });
        const identity = await beginCoverageCompletionPass(page, read);
        await verifyCoverageUnchanged(page, read, identity, 1000);
        if (phase === 'accepted-to-report') {
          expect((await readCoverageReport(page))[0].verifiedUnchangedCount).toBe(2);
          changeBack();
        }
        expect(observerOptions().attributes).toBe(true);
        expect(observerOptions().attributeFilter).toBeUndefined();
        expect(owner.getAttribute('lang')).toBeNull();
        expect(owner.firstChild).toBe(text);
        expect(tracker.snapshotMissing().map(item => item.token)).toEqual(tokens);
        expect(tracker.metrics().hostMutationCount).toBe(revision + 2);
        expect(tracker.metrics().pendingCompletionBindings).toBe(0);
        const report = await readCoverageReport(page);
        expect(report.every((state: {verifiedUnchangedCount: number}) => state.verifiedUnchangedCount === 0)).toBe(true);
        expect(() => assertCoverageReport(rules, report, 'lang edit-return')).toThrow();
      });
    });

  it.each(['same-value Text replacement', 'ordered same-value Text swap', 'semantic attribute'])
    ('rechecks exact identity before acceptance even without observer delivery: %s', async (change) => {
      const html = change === 'ordered same-value Text swap'
        ? '<main><h2><span>Cookies</span><span>Cookies</span></h2><h2>Cookies</h2><p>A full paragraph stays eligible.</p></main>'
        : undefined;
      await withCompletionFixture(async ({document, page, trustedReader}) => {
        const owner = document.querySelector('h2')!;
        const textBefore = owner.textContent;
        const read = await trustedReader(queries => {
          const result = currentCompletionResponse(queries);
          if (queries.length) {
            if (change === 'same-value Text replacement') owner.firstChild!.replaceWith(document.createTextNode(owner.firstChild!.textContent || ''));
            else if (change === 'ordered same-value Text swap') {
              const [left, right] = [...owner.querySelectorAll('span')];
              const leftText = left.firstChild!;
              const rightText = right.firstChild!;
              left.replaceChild(rightText, leftText);
              right.append(leftText);
            } else owner.setAttribute('lang', 'fr');
          }
          return result;
        });
        const identity = await beginCoverageCompletionPass(page, read);
        await verifyCoverageUnchanged(page, read, identity, 1000);
        expect(owner.textContent).toBe(textBefore);
        const report = await readCoverageReport(page);
        expect(report[0].verifiedUnchangedCount).toBe(1); // 未变化的另一 owner 可以正常完成。
        expect(report[0].translatedCount).toBe(0);
      }, html);
    });

  it.each(['clearCompletionReceipts', 'prepareUnchangedQueries', 'acceptUnchangedQueries', 'discardUnchangedQueries'])
    ('returns within the shared 2-second window when page %s hangs and rejects late credit', async (stage) => {
      await withCompletionFixture(async ({page, tracker, rules, trustedReader}) => {
        const read = await trustedReader(currentCompletionResponse);
        const identity = await beginCoverageCompletionPass(page, read);
        const originalEvaluate = page.evaluate;
        let releaseLate: (() => Promise<void>) | undefined;
        let delayedFirstClear = false;
        let hung = false;
        const startedAt = 1800000000000;
        vi.useFakeTimers();
        vi.setSystemTime(startedAt);
        try {
          page.evaluate = (fn, argument) => {
            const source = String(fn);
            if (!hung && source.includes(stage)) {
              hung = true;
              return new Promise<unknown>((resolve, reject) => {
                releaseLate = async () => {
                  try {resolve(await originalEvaluate(fn, argument));} catch (error) {reject(error);}
                };
              });
            }
            if (stage !== 'clearCompletionReceipts' && !delayedFirstClear && source.includes('clearCompletionReceipts')) {
              delayedFirstClear = true;
              return new Promise<unknown>((resolve, reject) => setTimeout(() => {
                void originalEvaluate(fn, argument).then(resolve, reject);
              }, 500));
            }
            return originalEvaluate(fn, argument);
          };
          let settled = false;
          let failure: unknown;
          const collecting = verifyCoverageUnchanged(page, read, identity, 2000).then(
            () => {settled = true;}, (error: unknown) => {settled = true; failure = error;});
          await vi.advanceTimersByTimeAsync(1999);
          expect(hung).toBe(true);
          expect(settled).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          expect(settled).toBe(true);
          await collecting;
          expect(failure).toBeUndefined();
          expect(Date.now() - startedAt).toBe(2000);
          page.evaluate = originalEvaluate;
          const denied = await readCoverageReport(page);
          expect(denied.every((state: {verifiedUnchangedCount: number}) => state.verifiedUnchangedCount === 0)).toBe(true);
          expect(() => assertCoverageReport(rules, denied, 'hung page collector')).toThrow();
          expect(releaseLate).toBeDefined();
          await releaseLate?.();
          await vi.advanceTimersByTimeAsync(0);
          const afterLate = await readCoverageReport(page);
          expect(afterLate.every((state: {verifiedUnchangedCount: number}) => state.verifiedUnchangedCount === 0)).toBe(true);
          expect(() => assertCoverageReport(rules, afterLate, 'late page execution')).toThrow();
          if (stage === 'acceptUnchangedQueries') {
            expect(tracker.report().every(state => state.verifiedUnchangedCount === 0)).toBe(true);
          }
          // 被挂起的 prepare 可能晚到，但过期 binding 不能通过 accept，且只保存 WeakRef。
          const expired = prepareCompletion(tracker);
          tracker.discardUnchangedQueries(expired.batch);
          expect(tracker.metrics().pendingCompletionBindings).toBe(0);
        } finally {
          page.evaluate = originalEvaluate;
          vi.useRealTimers();
        }
      });
    });

  it.each(['clearCompletionReceipts', 'prepareUnchangedQueries', 'acceptUnchangedQueries', 'discardUnchangedQueries'])
    ('preserves page %s errors while revoking Node authority and cleaning pending tokens', async (stage) => {
      await withCompletionFixture(async ({page, tracker, rules, trustedReader}) => {
        const read = await trustedReader(currentCompletionResponse);
        const identity = await beginCoverageCompletionPass(page, read);
        const evaluate = page.evaluate;
        let rejected = false;
        page.evaluate = async (fn, argument) => {
          if (!rejected && String(fn).includes(stage)) {
            rejected = true;
            throw new Error('page operation failed: ' + stage);
          }
          return evaluate(fn, argument);
        };
        try {
          await expect(verifyCoverageUnchanged(page, read, identity, 1000))
            .rejects.toThrow('page operation failed: ' + stage);
          expect(rejected).toBe(true);
          const report = await readCoverageReport(page);
          expect(report.every((state: {verifiedUnchangedCount: number}) => state.verifiedUnchangedCount === 0)).toBe(true);
          expect(() => assertCoverageReport(rules, report, 'page exception')).toThrow();
          expect(tracker.metrics().pendingCompletionBindings).toBe(0);
        } finally {page.evaluate = evaluate;}
      });
    });

  it('rejects an oversized owner before allocating an unbounded child traversal binding', async () => {
    await withCompletionFixture(async ({document, tracker, page, trustedReader}) => {
      const owner = document.querySelector('h2')!;
      for (let index = 0; index < 4097; index += 1) owner.append(document.createElement('span'));
      const read = await trustedReader(currentCompletionResponse);
      const identity = await beginCoverageCompletionPass(page, read);
      await verifyCoverageUnchanged(page, read, identity, 1000);
      const report = await readCoverageReport(page);
      expect(report[0]).toMatchObject({seenCount: 2, translatedCount: 0, verifiedUnchangedCount: 1, completedCount: 1});
      expect(tracker.metrics().pendingCompletionBindings).toBe(0);
    });
  });

  it('bounds begin-pass first page clearing within its one shared deadline', async () => {
    await withCompletionFixture(async ({page, rules, trustedReader}) => {
      const read = await trustedReader(currentCompletionResponse);
      const evaluate = page.evaluate;
      let lateClear: (() => Promise<void>) | undefined;
      vi.useFakeTimers();
      try {
        page.evaluate = (fn, argument) => new Promise<unknown>((resolve) => {
          lateClear = async () => {resolve(await evaluate(fn, argument));};
        });
        let settled = false;
        const beginning = beginCoverageCompletionPass(page, read).then((identity: {sessionId: number | null}) => {
          settled = true; return identity;
        });
        await vi.advanceTimersByTimeAsync(2000);
        expect(settled).toBe(true);
        expect((await beginning).sessionId).toBeNull();
        page.evaluate = evaluate;
        await lateClear?.();
        const report = await readCoverageReport(page);
        expect(() => assertCoverageReport(rules, report, 'late initial clear')).toThrow();
      } finally {page.evaluate = evaluate; vi.useRealTimers();}
    });
  });

});


describe('Factorio multilingual live-source catalog', () => {
  const descriptions = {
    zh: '为异星工厂添加全新生产配方和机器，改善物流与自动化体验。',
    a: 'Adds new production recipes and machines for your factory.',
    b: 'Improves railway logistics with automatic train scheduling.',
    c: 'Provides additional tools for planning large production lines.',
    d: 'Expands circuit networks with useful automation components.',
  };
  const selector = '.mod-list > .panel-inset-lighter p.result-field.pre-line.line-clamp-4';

  it.each([
    ['Chinese first', ['zh', 'a', 'b', 'c', 'd']],
    ['Chinese middle', ['b', 'zh', 'a', 'd', 'c']],
    ['English reordered', ['d', 'c', 'zh', 'b', 'a']],
    ['exactly three English', ['zh', 'c', 'a', 'b']],
    ['only two English', ['zh', 'a', 'b']],
  ] as const)('%s retains eligibility, all-owner coverage and the minimum of three', async (_name, order) => {
    const config = cases['factorio-issue-209'];
    const normalized = require('../scripts/site-translation/case-config.cjs').normalizeCaseConfig('factorio-issue-209', config);
    const rules = normalizeCoverageRules(config.coverageRules);
    expect(config.url).toBe('https://mods.factorio.com/');
    expect(config.tier).toBe('required');
    expect(config.modes).toEqual(['hover', 'full']);
    expect(config.forbiddenSelectors).toEqual(['input[name="query"]']);
    expect(config.interactionSelectors).toEqual(['.mod-list a.result-field[href]']);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({selector, minInitial: 3, minSeen: 3});
    expect(normalized.selector).toBe('.mod-list');
    expect(normalized.requiredSelectors).toEqual(['.mod-list']);
    // An explicit hover target avoids normalizeCaseConfig's shared hoverSelector/full selector.
    expect(normalized.hoverTargets).toHaveLength(1);
    expect(normalized.hoverTargets[0]).toMatchObject({selector, index: 0});
    expect(computeJobTimeoutMs(undefined as unknown as number, 'hover')).toBe(300000);
    expect(computeJobTimeoutMs(undefined as unknown as number, 'full')).toBe(1800000);

    const {document, window} = parseHTML('<html><body><input name="query" value="unchanged"><div class="mod-list">' +
      order.map(key => '<div class="panel-inset-lighter"><a class="result-field" href="/mod/' + key + '">Mod</a>' +
        '<p class="result-field pre-line line-clamp-4">' + descriptions[key] + '</p></div>').join('') + '</div></body></html>');
    Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {configurable: true,
      value: () => ({width: 400, height: 40, top: 0, left: 0, right: 400, bottom: 40})});
    const globals = {window, document, location: {href: config.url}, Node: window.Node, HTMLElement: window.HTMLElement,
      HTMLAnchorElement: window.HTMLAnchorElement, MutationObserver: window.MutationObserver,
      getComputedStyle: () => ({display: 'block', visibility: 'visible'})};
    const previous = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries(globals)) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
    }
    const page = {url: () => config.url,
      evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => fn(argument),
      waitForFunction: async (fn: (argument: unknown) => unknown, argument: unknown) => {
        if (!fn(argument)) throw new Error('coverage was not ready');
      }};
    let tracker: {report: () => Array<{name: string; seenCount: number; translatedCount: number; sourceSamples: string[]}>;
      restorationReport: () => unknown[]; stop: () => void} | undefined;
    try {
      const nodes = [...document.querySelectorAll(selector)];
      expect(isNaturalLanguageText(descriptions.zh)).toBe(false);
      const eligible = nodes.filter(node => isNaturalLanguageText(node.textContent));
      expect(eligible).toHaveLength(order.length - 1);
      // Executes the real page predicate, not a mock of resolveHoverTarget/findHoverTargetInPage.
      const resolved = await resolveHoverTarget(page, normalized.hoverTargets[0], 100);
      expect(resolved).toMatchObject({rawIndex: order.findIndex(key => key !== 'zh'),
        sourceText: eligible[0].textContent});
      const frozenRules = normalizeCoverageRules([{name: 'first-three-mod-descriptions',
        selector: '.mod-list > .panel-inset-lighter:nth-child(-n+3) p.result-field.pre-line.line-clamp-4',
        kind: 'content', minInitial: 3}]);
      await expect(waitForCoverageReady(page, frozenRules, 100)).rejects.toThrow('coverage was not ready');
      if (eligible.length < 3) {
        await expect(waitForCoverageReady(page, rules, 100)).rejects.toThrow('coverage was not ready');
        return;
      }
      await expect(waitForCoverageReady(page, rules, 100)).resolves.toBeUndefined();
      const baseline = await capturePageContract(page, config.requiredSelectors, config.forbiddenSelectors,
        config.interactionSelectors, [], []);
      await installCoverageTracker(page, rules);
      tracker = (window as unknown as Record<string, typeof tracker>)[COVERAGE_TRACKER_KEY];
      expect(tracker!.report()[0]).toMatchObject({seenCount: eligible.length,
        sourceSamples: eligible.map(node => node.textContent)});
      // Translation wrappers are fixture evidence only; host source text is never rewritten.
      const addTranslation = (node: Element) => {
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.textContent = '模拟译文';
        node.appendChild(wrapper);
      };
      eligible.slice(0, -1).forEach(addTranslation);
      expect(() => assertCoverageReport(rules, tracker!.report(), 'missing eligible owner')).toThrow('eligible-mod-descriptions');
      addTranslation(eligible[eligible.length - 1]);
      expect(() => assertCoverageReport(rules, tracker!.report(), 'all eligible owners')).not.toThrow();
      // Reproduce full's first-DOM predicate: the wide paragraph selector fails for Chinese first,
      // while the list anchor sees descendant translations and leaf coverage still checks every owner.
      const firstParagraphCount = document.querySelector(selector)!.querySelectorAll('.fluent-read-bilingual-content').length;
      expect(firstParagraphCount).toBe(order[0] === 'zh' ? 0 : 1);
      expect(document.querySelector(normalized.selector)!.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(eligible.length);
      await expect(assertPageContract(page, baseline, config.requiredSelectors, config.url, 'translated')).resolves.toBeDefined();
      document.querySelectorAll('.fluent-read-bilingual-content').forEach(node => node.remove());
      expect(nodes.map(node => node.textContent)).toEqual(order.map(key => descriptions[key]));
      expect(() => assertCoverageRestoration(tracker!.restorationReport(), 'restored')).not.toThrow();
      await expect(assertPageContract(page, baseline, config.requiredSelectors, config.url, 'restored')).resolves.toBeDefined();
    } finally {
      tracker?.stop();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
});


describe('structured site failure diagnostic codes', () => {
  const assert = require('node:assert/strict');
  const {collectErrorCodes, reportErrorCodes} = require('../scripts/testing/site-error-diagnostics.cjs');
  const coded = (code: string): Error & {code: string; cause?: unknown} =>
    Object.assign(new Error('Browser close operation timed out'), {code});

  it('keeps distinct timeout stage codes and shared primary cause references', () => {
    const primary = coded('CDP_QUERY_TIMEOUT');
    const error = new AggregateError([primary, coded('DETACH_TIMEOUT'), coded('NATIVE_CLOSE_TIMEOUT')],
      'Browser close failed', {cause: primary});
    assert.deepEqual(collectErrorCodes(error), {
      id: 1, codeStatus: 'absent',
      cause: {id: 2, codeStatus: 'reported', code: 'CDP_QUERY_TIMEOUT'},
      errors: [{reference: 2}, {id: 3, codeStatus: 'reported', code: 'DETACH_TIMEOUT'},
        {id: 4, codeStatus: 'reported', code: 'NATIVE_CLOSE_TIMEOUT'}],
    });
  });

  it('does not infer a timeout stage from text or stack', () => {
    const error = new Error('NATIVE_CLOSE_TIMEOUT Browser close operation timed out');
    assert.deepEqual(collectErrorCodes(error), {id: 1, codeStatus: 'absent'});
  });

  it('reports the existing local public code vocabulary', () => {
    for (const code of ['CDP_CONNECT_TIMEOUT', 'CDP_QUERY_TIMEOUT', 'DETACH_TIMEOUT',
      'NATIVE_CLOSE_TIMEOUT', 'CONTEXT_CLOSE_TIMEOUT', 'PS_TIMEOUT', 'PROFILE_INVALID', 'PS_INVALID',
      'PLATFORM_UNSUPPORTED', 'OWNERSHIP_UNKNOWN', 'IDENTITY_CHANGED', 'TERMINATION_TIMEOUT',
      'PROFILE_CHANGED', 'HELPER_UNSUPPORTED', 'SESSION_UNGUARDED']) {
      assert.equal(collectErrorCodes(coded(code)).code, code);
    }
  });

  it('omits arbitrary code values and all sensitive error fields', () => {
    const secret = 'api-token-should-not-be-persisted';
    const error = Object.assign(new Error(secret), {
      code: secret, name: secret, stack: secret, url: secret, token: secret, argv: [secret],
    });
    const encoded = JSON.stringify(collectErrorCodes(error));
    assert.equal(encoded.includes(secret), false);
    assert.deepEqual(JSON.parse(encoded), {id: 1, codeStatus: 'omitted'});
    assert.equal(collectErrorCodes({code: 1}).codeStatus, 'omitted');
    assert.equal(collectErrorCodes({code: 'UNKNOWN_BUT_UPPERCASE_TOKEN'}).codeStatus, 'omitted');
  });

  it('marks circular causes without revisiting or mutating errors', () => {
    const first = coded('NATIVE_CLOSE_TIMEOUT'), second = coded('PS_TIMEOUT');
    first.cause = second;
    second.cause = first;
    Object.freeze(first);
    Object.freeze(second);
    assert.deepEqual(collectErrorCodes(first), {
      id: 1, codeStatus: 'reported', code: 'NATIVE_CLOSE_TIMEOUT',
      cause: {id: 2, codeStatus: 'reported', code: 'PS_TIMEOUT', cause: {reference: 1}},
    });
    assert.equal(first.cause, second);
    assert.equal(second.cause, first);
  });

  it('does not invoke code, cause, errors or array child getters', () => {
    let reads = 0;
    const getter = () => {reads += 1; throw new Error('Unexpected getter');};
    const accessorError = Object.defineProperties({}, {
      code: {get: getter}, cause: {get: getter}, errors: {get: getter},
    });
    assert.deepEqual(collectErrorCodes(accessorError), {
      id: 1, codeStatus: 'unreadable', causeStatus: 'unreadable', errorsStatus: 'unreadable',
    });
    const children = [null];
    Object.defineProperty(children, '0', {get: getter});
    assert.deepEqual(collectErrorCodes({errors: children}), {
      id: 1, codeStatus: 'absent', errors: [{codeStatus: 'unreadable'}],
    });
    assert.equal(reads, 0);
  });

  it('tolerates throwing property descriptors without replacing the original failure', () => {
    const error = new Proxy({}, {getOwnPropertyDescriptor() {throw new Error('Descriptor unavailable');}});
    assert.deepEqual(collectErrorCodes(error), {
      id: 1, codeStatus: 'unreadable', causeStatus: 'unreadable', errorsStatus: 'unreadable',
    });
  });

  it('does not inherit arbitrary codes or invoke primitive conversion', () => {
    const inherited = Object.create({code: 'NATIVE_CLOSE_TIMEOUT'});
    inherited.toString = () => {throw new Error('Conversion must not happen');};
    assert.deepEqual(collectErrorCodes(inherited), {id: 1, codeStatus: 'absent'});
    for (const value of [undefined, null, 'secret', 1, Symbol('secret'), 2n]) {
      assert.deepEqual(collectErrorCodes(value), {codeStatus: 'non-object'});
    }
  });

  it('retains available cause codes alongside malformed aggregate children', () => {
    const error = {cause: coded('OWNERSHIP_UNKNOWN'), errors: new Set(['secret'])};
    assert.deepEqual(collectErrorCodes(error), {
      id: 1, codeStatus: 'absent', cause: {id: 2, codeStatus: 'reported', code: 'OWNERSHIP_UNKNOWN'},
      errorsStatus: 'non-array',
    });
  });

  it('bounds deep cause chains without recursive overflow', () => {
    let error: unknown = coded('NATIVE_CLOSE_TIMEOUT');
    for (let index = 0; index < 2000; index += 1) error = {cause: error};
    const encoded = JSON.stringify(collectErrorCodes(error));
    assert.ok(encoded.length < 5000);
    assert.ok(encoded.includes('"truncated":true'));
    assert.equal(encoded.includes('NATIVE_CLOSE_TIMEOUT'), false);
  });

  it('bounds huge aggregate children while preserving the first available phase code', () => {
    const children = new Array(1_000_000).fill(coded('DETACH_TIMEOUT'));
    children[0] = coded('CDP_CONNECT_TIMEOUT');
    const result = collectErrorCodes({errors: children});
    assert.equal(result.errors[0].code, 'CDP_CONNECT_TIMEOUT');
    assert.equal(result.truncatedErrors, true);
    assert.ok(result.errors.length <= 128);
    assert.ok(JSON.stringify(result).length < 5000);
  });

  it('bounds many distinct nodes including nested branches', () => {
    const children = Array.from({length: 200}, () => ({cause: coded('PS_TIMEOUT')}));
    const result = collectErrorCodes({errors: children});
    assert.equal(result.truncatedErrors, true);
    assert.ok(JSON.stringify(result).length < 15000);
  });

  it('does not modify frozen error descriptors or exception identity', () => {
    const error = Object.freeze(coded('IDENTITY_CHANGED'));
    const before = Object.getOwnPropertyDescriptors(error);
    let observed;
    try {throw error;} catch (caught) {
      reportErrorCodes(caught, 'terminal', () => {});
      observed = caught;
    }
    assert.equal(observed, error);
    assert.deepEqual(Object.getOwnPropertyDescriptors(error), before);
  });

  it('emits one parseable record with only the allowed terminal or cleanup phase', () => {
    const lines: string[] = [];
    for (const phase of ['terminal', 'cleanup', 'arbitrary-secret-phase']) {
      reportErrorCodes(coded('NATIVE_CLOSE_TIMEOUT'), phase, (line: string) => lines.push(line));
    }
    assert.equal(lines.length, 2);
    assert.equal(lines[0].endsWith('\n'), true);
    const records = lines.map(line => JSON.parse(line.slice('[site-error-codes] '.length)));
    assert.deepEqual(records.map(record => record.phase), ['terminal', 'cleanup']);
    assert.ok(records.every(record => record.pid === process.pid));
    assert.ok(records.every(record => record.error.code === 'NATIVE_CLOSE_TIMEOUT'));
  });

  it('suppresses diagnostic write failures while preserving CLI exit status', () => {
    const before = process.exitCode;
    assert.doesNotThrow(() => reportErrorCodes(coded('PS_TIMEOUT'), 'cleanup', () => {
      throw new Error('stderr unavailable');
    }));
    assert.equal(process.exitCode, before);
  });
});

describe('pubdev mandatory caption unchanged-query diagnostic', () => {
  const background = '<h2>Cookies</h2><h2>Cookies</h2><p>A full paragraph stays eligible.</p>';
  const clean = 'provider 6.1.5+1';
  const copy = '<span class="pkg-page-title-copy"><img data-copy-content="provider: ^6.1.5+1" tabindex="0">' +
    '<div class="pkg-page-title-copy-feedback" style="display:none"><span class="code">provider: ^6.1.5+1</span> copied to clipboard</div></span>';
  const styles = (element: Element) => ({display: element.matches('.pkg-page-title-copy-feedback') ? 'none' : 'block', visibility: 'visible'});
  it('keeps the clean caption mandatory and accepts only its exact identical-result receipt without DOM wrappers', async () => {
    expect(isNaturalLanguageText(clean)).toBe(true);
    await withCompletionFixture(async ({page, document, rules, trustedReader}) => {
      const read = await trustedReader(queries => currentCompletionResponse(queries));
      const identity = await beginCoverageCompletionPass(page, read);
      await verifyCoverageUnchanged(page, read, identity, 1000);
      const report = await readCoverageReport(page);
      expect((report as Array<{name: string}>).find(state => state.name === 'mandatory-visible-latin-h1'))
        .toMatchObject({seenCount: 1, translatedCount: 0, verifiedUnchangedCount: 1, completedCount: 1});
      expect(() => assertCoverageReport(rules, report, 'exact clean caption')).not.toThrow();
      expect(document.querySelectorAll('[data-fr-translation-owned="true"]')).toHaveLength(0);
    }, '<main>' + background + '<h1>' + clean + '</h1></main>', withMandatoryHeadingCoverage([]), styles);
  });
  it('uses live visibility for the exact unchanged query while retaining hidden host structure in restoration', async () => {
    await withCompletionFixture(async ({page, document, tracker, rules, trustedReader}) => {
      const queriesSeen: CompletionQuery[] = [];
      const read = await trustedReader(queries => {
        queriesSeen.push(...queries);
        return {status: 'success', sessionId: 10, outcomes: queries.map(query =>
          query.selector === 'h1' && query.source !== clean
            ? {status: 'unavailable', reason: 'no-current-accepted-completion'}
            : acceptedCompletion(query))};
      });
      const identity = await beginCoverageCompletionPass(page, read);
      await verifyCoverageUnchanged(page, read, identity, 1000);
      const heading = document.querySelector('h1')!;
      expect(heading.cloneNode(true).textContent?.replace(/\s+/gu, ' ').trim())
        .toBe('provider 6.1.5+1 provider: ^6.1.5+1 copied to clipboard');
      expect(queriesSeen.find(query => query.selector === 'h1')?.source).toBe(clean);
      expect(isNaturalLanguageText(clean)).toBe(true);
      const report = await readCoverageReport(page);
      expect((report as Array<{name: string}>).find(state => state.name === 'mandatory-visible-latin-h1'))
        .toMatchObject({seenCount: 1, translatedCount: 0, verifiedUnchangedCount: 1, completedCount: 1});
      expect(() => assertCoverageReport(rules, report, 'exact visible caption')).not.toThrow();
      expect(document.querySelectorAll('[data-fr-translation-owned="true"]')).toHaveLength(0);
      expect(tracker.restorationReport()).toEqual(expect.arrayContaining([
        expect.objectContaining({name: 'mandatory-visible-latin-h1', changedCount: 0})]));
      const hiddenCode = document.querySelector('.pkg-page-title-copy-feedback .code')!;
      const originalText = hiddenCode.textContent;
      hiddenCode.textContent = 'provider: ^99.0.0';
      expect(tracker.restorationReport()).toEqual(expect.arrayContaining([
        expect.objectContaining({name: 'mandatory-visible-latin-h1', changedCount: 1})]));
      expect((await readCoverageReport(page)).find((state: {name: string}) => state.name === 'mandatory-visible-latin-h1'))
        .toMatchObject({verifiedUnchangedCount: 0, completedCount: 0});
      hiddenCode.textContent = originalText;
      expect(tracker.restorationReport()).toEqual(expect.arrayContaining([
        expect.objectContaining({name: 'mandatory-visible-latin-h1', changedCount: 0})]));
      const replacement = document.createElement('strong');
      replacement.textContent = hiddenCode.textContent;
      hiddenCode.replaceWith(replacement);
      expect(tracker.restorationReport()).toEqual(expect.arrayContaining([
        expect.objectContaining({name: 'mandatory-visible-latin-h1', changedCount: 1})]));
    }, '<main>' + background + '<h1>' + clean + ' ' + copy + '</h1></main>', withMandatoryHeadingCoverage([]), styles);
  });
  it('does not give an eligible clean caption credit when accepted completion is absent', async () => {
    await withCompletionFixture(async ({page, document, tracker, rules, trustedReader}) => {
      const read = await trustedReader(queries => ({status: 'success', sessionId: 10,
        outcomes: queries.map(() => ({status: 'unavailable', reason: 'no-current-accepted-completion'}))}));
      const identity = await beginCoverageCompletionPass(page, read);
      await verifyCoverageUnchanged(page, read, identity, 1000);
      const report = await readCoverageReport(page);
      expect((report as Array<{name: string}>).find(state => state.name === 'mandatory-visible-latin-h1'))
        .toMatchObject({seenCount: 1, translatedCount: 0, verifiedUnchangedCount: 0, completedCount: 0});
      expect(() => assertCoverageReport(rules, report, 'no completion')).toThrow('mandatory-visible-latin-h1');
      expect(() => validateCoverageRevealStatuses(tracker.missingStatuses(tracker.snapshotMissing().map(item => item.token)), 'no completion'))
        .toThrow('missing-wrapper');
      expect(document.querySelectorAll('[data-fr-translation-owned="true"]')).toHaveLength(0);
    }, '<main>' + background + '<h1>' + clean + ' ' + copy + '</h1></main>', withMandatoryHeadingCoverage([]), styles);
  });
  it('retains visible feedback text and rejects a receipt for only the caption', async () => {
    await withCompletionFixture(async ({page, rules, trustedReader}) => {
      const queriesSeen: CompletionQuery[] = [];
      const read = await trustedReader(queries => {
        queriesSeen.push(...queries);
        return {status: 'success', sessionId: 10, outcomes: queries.map(query =>
          query.selector === 'h1' && query.source !== clean
            ? {status: 'unavailable', reason: 'no-current-accepted-completion'}
            : acceptedCompletion(query))};
      });
      const identity = await beginCoverageCompletionPass(page, read);
      await verifyCoverageUnchanged(page, read, identity, 1000);
      expect(queriesSeen.find(query => query.selector === 'h1')?.source)
        .toBe('provider 6.1.5+1 provider: ^6.1.5+1 copied to clipboard');
      const report = await readCoverageReport(page);
      expect((report as Array<{name: string}>).find(state => state.name === 'mandatory-visible-latin-h1'))
        .toMatchObject({seenCount: 1, translatedCount: 0, verifiedUnchangedCount: 0, completedCount: 0});
      expect(() => assertCoverageReport(rules, report, 'visible feedback')).toThrow('mandatory-visible-latin-h1');
    }, '<main>' + background + '<h1>' + clean + ' ' + copy + '</h1></main>', withMandatoryHeadingCoverage([]),
      () => ({display: 'block', visibility: 'visible'}));
  });

  it.each([
    {display: 'none', visibility: 'visible'},
    {display: 'block', visibility: 'hidden'},
    {display: 'block', visibility: 'collapse'},
  ])('requires the same live presentation when verifying a query: $display/$visibility', async (hiddenStyle) => {
    let presentation = hiddenStyle;
    await withCompletionFixture(async ({page, document, rules, trustedReader}) => {
      const read = await trustedReader(queries => ({status: 'success', sessionId: 10,
        outcomes: queries.map(query => query.selector === 'h1' && query.source !== clean
          ? {status: 'unavailable', reason: 'no-current-accepted-completion'} : acceptedCompletion(query))}));
      const identity = await beginCoverageCompletionPass(page, read);
      await verifyCoverageUnchanged(page, read, identity, 1000);
      expect((await readCoverageReport(page)).find((state: {name: string}) => state.name === 'mandatory-visible-latin-h1'))
        .toMatchObject({seenCount: 1, translatedCount: 0, verifiedUnchangedCount: 1, completedCount: 1});
      const htmlBefore = document.querySelector('h1')!.outerHTML;
      // A stylesheet/media-query change can alter computed visibility without
      // delivering a host DOM mutation or changing any captured node/attribute.
      presentation = {display: 'block', visibility: 'visible'};
      expect(document.querySelector('h1')!.outerHTML).toBe(htmlBefore);
      const report = await readCoverageReport(page);
      expect((report as Array<{name: string}>).find(state => state.name === 'mandatory-visible-latin-h1'))
        .toMatchObject({seenCount: 1, translatedCount: 0, verifiedUnchangedCount: 0, completedCount: 0});
      expect(() => assertCoverageReport(rules, report, 'presentation changed')).toThrow('mandatory-visible-latin-h1');
    }, '<main>' + background + '<h1>' + clean + ' ' + copy + '</h1></main>', withMandatoryHeadingCoverage([]),
      element => element.matches('.pkg-page-title-copy-feedback') ? presentation : {display: 'block', visibility: 'visible'});
  });
});

describe('LearnOpenGL protected native slot contract', () => {
  const exactUrl = 'https://learnopengl.com/Getting-started/Coordinate-Systems';
  const html = `<html><body><div id="nav">
    <div id="social"><a href="/social">Social</a></div><img src="nav-arrow.png">
    <ol><li><a id="first-link" href="/Introduction">Introduction</a></li>
      <li><a id="last-link" href="/Getting-started/Camera">Camera</a></li></ol>
    <div id="menu_book"></div><div id="donate"></div><div id="lefttwotenthad"></div>
    <div id="leftfourthtenthad"><div id="ezoic-pub-ad-placeholder-111"><div>
      <span class="ezoic-ad" data-ez-name="Sidebar_1/observed">
        <span class="ezoic-ad" id="div-gpt-ad-Sidebar_1/observed-0"></span>
        <span class="reportline"><span><img alt="Ezoic" src="ezoic.png"></span></span>
      </span></div></div></div>
    <div id="leftsixthtenthad"><div></div></div><div id="lefteighttenthad"><div id="ezoic-pub-ad-placeholder-113"><div><span class="ezoic-ad" data-ez-name="Sidebar_1/observed-113"><span class="ezoic-ad" id="div-gpt-ad-Sidebar_1/observed-113-0"></span></span></div></div></div>
    <div id="lefttenthtenthad"></div></div></body></html>`;
  type PagePort = Parameters<typeof assertPageContract>[0] & {
    evaluateHandle: (fn: (argument: unknown) => unknown, argument: unknown) => Promise<unknown>;
  };
  async function fixture(
    run: (port: {document: Document; page: PagePort; hydrate: () => void; close: () => void;
      liveHandles: () => number}) => Promise<void>,
    options: {url?: string; prepare?: (document: Document) => void; readError?: 'property' | 'json' | 'dispose' | 'json-dispose'} = {},
  ) {
    const parsed = parseHTML(html), document = parsed.document as unknown as Document, window = parsed.window;
    Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true, value: () => ({width: 100, height: 20, left: 0, top: 0, right: 100, bottom: 20}),
    });
    const url = options.url ?? exactUrl;
    options.prepare?.(document);
    const {runInNewContext} = require('node:vm');
    const handles = new Set<{value: unknown; disposed: boolean}>();
    const injectedError = new Error(`controlled ${options.readError ?? 'context'} failure`);
    const evaluate = (fn: (argument: unknown) => unknown, argument: unknown) => {
      const input = {...argument as Record<string, unknown>};
      if (input.navIdentity) {
        const handle = input.navIdentity as {value: unknown; disposed: boolean};
        if (handle.disposed) throw injectedError;
        input.navIdentity = handle.value;
      }
      return runInNewContext(`(${fn.toString()})(argument)`, {
        argument: input, window, document, location: {href: url}, Node: window.Node,
        HTMLElement: window.HTMLElement, HTMLAnchorElement: window.HTMLAnchorElement,
        getComputedStyle: () => ({display: 'block', visibility: 'visible'}),
      }, {timeout: 1000});
    };
    const makeHandle = (value: unknown, child = false) => {
      const state = {value, disposed: false};
      handles.add(state);
      return Object.assign(state, {
        getProperty: async (name: string) => {
          if (options.readError === 'property') throw injectedError;
          return makeHandle((value as Record<string, unknown>)[name], true);
        },
        jsonValue: async () => {
          if (options.readError === 'json' || options.readError === 'json-dispose') throw injectedError;
          return JSON.parse(JSON.stringify(value));
        },
        dispose: async () => {
          state.disposed = true;
          if (child && options.readError === 'dispose') throw injectedError;
          if (child && options.readError === 'json-dispose') throw new Error('controlled cleanup failure');
        },
      });
    };
    const page = {
      url: () => url,
      evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => evaluate(fn, argument),
      evaluateHandle: async (fn: (argument: unknown) => unknown, argument: unknown) => makeHandle(evaluate(fn, argument)),
    } as PagePort;
    const hydrate = () => {
      const outer = document.querySelector('#leftfourthtenthad [data-ez-name]')!;
      const primary = outer.children[0];
      primary.innerHTML = '<div id="native-primary-container"><iframe title="3rd party ad content" aria-label="Advertisement"></iframe></div>';
      const high = document.createElement('span');
      high.id = 'div-gpt-ad-Sidebar_1/observed-0-highvalue';
      high.className = 'ezoic-ad';
      high.innerHTML = '<div id="native-highvalue-container"></div>';
      outer.insertBefore(high, outer.children[1]);
    };
    const close = () => handles.forEach(handle => {handle.disposed = true;});
    try {await run({document, page, hydrate, close, liveHandles: () => [...handles].filter(handle => !handle.disposed).length});}
    finally {close();}
  }
  const capture = (page: PagePort) => capturePageContract(page, [], ['#nav'], ['#nav a[href]'], [], []);
  const assertNav = (page: PagePort, baseline: Awaited<ReturnType<typeof capture>>, url = exactUrl) =>
    assertPageContract(page, baseline, [], url, 'native slot regression');

  it('allows only the observed empty native renderer hydration and keeps the original baseline', async () => {
    await fixture(async ({document, page, hydrate}) => {
      const baseline = await capture(page), before = JSON.stringify(baseline);
      expect(baseline.forbiddenState[0]).toMatchObject({dynamic: false, mutable: false, count: 1, ownedDescendants: 0});
      const anchors = [...document.querySelectorAll('#nav a')];
      hydrate();
      const current = await assertNav(page, baseline) as {hostNativeDiagnostics: Array<{unprojectedStructure: string}>};
      expect(baseline.forbiddenState[0].signatures[0]).toMatchObject({nativeSlotProjection: {
        slots: [{id: 'leftfourthtenthad', directElementChildIndex: 6}, {id: 'lefteighttenthad', directElementChildIndex: 8}], navIdentityValid: true,
      }});
      expect(document.querySelector('#leftfourthtenthad iframe')?.hasAttribute('src')).toBe(false);
      expect(current.hostNativeDiagnostics[0].unprojectedStructure)
        .not.toBe((baseline as unknown as typeof current).hostNativeDiagnostics[0].unprojectedStructure);
      expect([...document.querySelectorAll('#nav a')]).toEqual(anchors);
      expect(JSON.stringify(baseline)).toBe(before);
      document.querySelector('#native-highvalue-container')!.append(document.createElement('iframe'));
      await expect(assertNav(page, baseline)).resolves.toBeDefined();
      expect(JSON.stringify(baseline)).toBe(before);
    });
  });

  it('keeps Ezoic slot 113 hydration separate from protected navigation and slot metadata', async () => {
    await fixture(async ({document, page}) => {
      const baseline = await capture(page), before = JSON.stringify(baseline);
      const ad = document.querySelector('#lefteighttenthad [data-ez-name]')!;
      ad.setAttribute('style', 'display:none !important');
      ad.children[0].setAttribute('data-google-query-id', 'observed-query');
      ad.children[0].append(document.createElement('div'));
      await expect(assertNav(page, baseline)).resolves.toBeDefined();
      expect(JSON.stringify(baseline)).toBe(before);
    });
  });

  it.each(['text', 'anchor', 'owned', 'moved', 'missing', 'replaced', 'metadata', 'duplicate'] as const)(
    'rejects second native slot damage instead of projecting the whole nav (%s)', async damage => {
      await fixture(async ({document, page}) => {
        const baseline = await capture(page), slot = document.querySelector('#lefteighttenthad')!;
        if (damage === 'text') slot.append('Injected navigation');
        if (damage === 'anchor') slot.append(document.createElement('a'));
        if (damage === 'owned') {const injected = document.createElement('span'); injected.className = 'fluent-read-loading'; slot.append(injected);}
        if (damage === 'moved') document.querySelector('#nav')!.append(slot);
        if (damage === 'missing') slot.remove();
        if (damage === 'replaced') slot.replaceWith(slot.cloneNode(true));
        if (damage === 'metadata') slot.setAttribute('aria-label', 'changed');
        if (damage === 'duplicate') document.body.append(slot.cloneNode(true));
        await expect(assertNav(page, baseline)).rejects.toThrow(/forbidden DOM/);
      });
    },
  );

  it.each(['wrong-host', 'wrong-url', 'non-direct', 'duplicate-slot'] as const)(
    'keeps raw native topology strict for a nonqualifying %s baseline', async state => {
      const url = state === 'wrong-host' ? 'https://example.test/Getting-started/Coordinate-Systems'
        : state === 'wrong-url' ? exactUrl + '?different=1' : exactUrl;
      await fixture(async ({page, hydrate}) => {
        const baseline = await capture(page);
        expect(baseline.forbiddenState[0].signatures[0]).not.toMatchObject({nativeSlotProjection: {slots: expect.arrayContaining([expect.objectContaining({id: 'leftfourthtenthad'})])}});
        hydrate();
        await expect(assertNav(page, baseline, url)).rejects.toThrow('forbidden DOM 被修改');
      }, {url, prepare: document => {
        if (state === 'non-direct') {
          const slot = document.querySelector('#leftfourthtenthad')!, wrapper = document.createElement('div');
          slot.replaceWith(wrapper); wrapper.append(slot);
        }
        if (state === 'duplicate-slot') {
          const duplicate = document.createElement('div'); duplicate.id = 'leftfourthtenthad'; document.body.append(duplicate);
        }
      }});
    },
  );

  it.each(['slot-text', 'slot-anchor', 'slot-missing', 'slot-moved', 'slot-tag', 'slot-id', 'slot-meta',
    'nav-text', 'nav-topology', 'nav-meta', 'anchor-href', 'anchor-meta', 'anchor-replaced',
    'anchor-reparented-lookalike', 'slot-replaced-lookalike'] as const)(
    'rejects protected damage after capture (%s)', async state => {
      await fixture(async ({document, page}) => {
        const baseline = await capture(page), slot = document.querySelector('#leftfourthtenthad')!,
          anchor = document.querySelector('#last-link')!;
        if (state === 'slot-text') slot.append('Injected natural text');
        if (state === 'slot-anchor') slot.append(document.createElement('a'));
        if (state === 'slot-missing') slot.remove();
        if (state === 'slot-moved') document.querySelector('#nav')!.append(slot);
        if (state === 'slot-tag') {const replacement = document.createElement('section'); replacement.id = slot.id; replacement.innerHTML = slot.innerHTML; slot.replaceWith(replacement);}
        if (state === 'slot-id') slot.id = 'different';
        if (state === 'slot-meta') slot.setAttribute('data-protected-metadata', 'changed');
        if (state === 'nav-text') anchor.textContent = 'Changed navigation';
        if (state === 'nav-topology') anchor.append(document.createElement('em'));
        if (state === 'nav-meta') document.querySelector('#menu_book')!.setAttribute('aria-label', 'changed');
        if (state === 'anchor-href') anchor.setAttribute('href', '/different-camera');
        if (state === 'anchor-meta') anchor.setAttribute('aria-label', 'changed');
        if (state === 'anchor-replaced') anchor.replaceWith(anchor.cloneNode(true));
        if (state === 'anchor-reparented-lookalike') {
          const parent = anchor.parentElement!, replacement = parent.cloneNode(true) as Element;
          parent.replaceWith(replacement); replacement.querySelector('a')!.replaceWith(anchor);
        }
        if (state === 'slot-replaced-lookalike') slot.replaceWith(slot.cloneNode(true));
        await expect(assertNav(page, baseline)).rejects.toThrow('forbidden DOM 被修改');
      });
    },
  );

  it.each(['fluent-read-bilingual-content', 'fluent-read-loading', 'fluent-read-retry-wrapper', 'data-owned'])(
    'checks the unprojected full nav for injected owned content (%s)', async owner => {
      await fixture(async ({document, page, hydrate}) => {
        const baseline = await capture(page); hydrate();
        const injected = document.createElement('span');
        if (owner === 'data-owned') injected.setAttribute('data-fr-translation-owned', 'true');
        else injected.className = owner;
        document.querySelector('#leftfourthtenthad')!.append(injected);
        await expect(assertNav(page, baseline)).rejects.toThrow('forbidden DOM 出现译文');
      });
    },
  );

  it('refuses projection without a real private handle port', async () => {
    await fixture(async ({page}) => {
      const unsupported = {...page, evaluateHandle: undefined} as unknown as PagePort;
      await expect(capture(unsupported)).rejects.toThrow('identity handle unavailable');
    });
  });

  it('refuses copied and foreign-page baseline identity instead of granting projection credit', async () => {
    await fixture(async ({page}) => {
      const baseline = await capture(page);
      await expect(assertNav(page, JSON.parse(JSON.stringify(baseline))))
        .rejects.toThrow('baseline identity is unavailable');
      await expect(assertNav({...page}, baseline)).rejects.toThrow('belongs to another page');
    });
  });

  it.each(['property', 'json', 'dispose'] as const)('propagates the private handle %s error and releases failed acquisition', async readError => {
    await fixture(async ({page, liveHandles}) => {
      await expect(capture(page)).rejects.toThrow(`controlled ${readError} failure`);
      expect(liveHandles()).toBe(0);
    }, {readError});
  });

  it('retains the original read cause and secondary disposal error when both reject', async () => {
    await fixture(async ({page, liveHandles}) => {
      let failure: unknown;
      try {await capture(page);} catch (error) {failure = error;}
      expect(failure).toBeInstanceOf(AggregateError);
      const aggregate = failure as AggregateError;
      expect(aggregate.errors.map((error: Error) => error.message))
        .toEqual(['controlled json-dispose failure', 'controlled cleanup failure']);
      expect(aggregate.cause).toBe(aggregate.errors[0]);
      expect(liveHandles()).toBe(0);
    }, {readError: 'json-dispose'});
  });

  it('fails strictly when the original context destroys the identity handle', async () => {
    await fixture(async ({page, close}) => {
      const baseline = await capture(page); close();
      await expect(assertNav(page, baseline)).rejects.toThrow('controlled context failure');
    });
  });
});


// Hover positive cases require an unambiguous source for their Chinese-output assertion.
// Full coverage keeps every original natural-language candidate and its owner obligations.
describe('hover source choice for the original Chinese-output flow', () => {
  const mixedTitle = 'fix(translation): 修复 flex/grid 标签在仅译文模式下反复重译';
  const selector = '[data-testid="listitem-title-link"]';

  function hoverPage(page: Parameters<Parameters<typeof withCompletionFixture>[0]>[0]['page']) {
    const waitForFunction = vi.fn(async (
      fn: (argument: unknown) => unknown,
      argument: unknown,
      _options: {timeout: number},
    ) => {
      if (!fn(argument)) throw new Error('controlled hover target timeout');
    });
    return {...page, waitForFunction};
  }

  it('chooses the next source title without reducing original full-owner coverage', async () => {
    const titleA = 'Fix repeated translation in flexible labels';
    const titleB = 'Preserve ownership when a pull request title changes';
    const html = '<main><h2>Cookies</h2><h2>Cookies</h2><p>A full paragraph stays eligible.</p>' +
      [mixedTitle, titleA, titleB].map(text => `<a data-testid="listitem-title-link">${text}</a>`).join('') + '</main>';
    await withCompletionFixture(async ({document, page, tracker}) => {
      const actualPage = hoverPage(page);
      const config = cases['github-project-pulls'];
      const rule = normalizeCoverageRules(config.coverageRules)[0];
      expect(rule).toMatchObject({selector, minInitial: 2, minSeen: 2, trackDynamic: true});
      expect(isNaturalLanguageText(mixedTitle)).toBe(true);
      expect(tracker.report().find(item => item.name === rule.name)).toMatchObject({seenCount: 3});
      await expect(resolveHoverTarget(actualPage, {name: 'primary', selector, index: 0, sourceIncludes: []}, 100))
        .resolves.toMatchObject({rawIndex: 1, sourceText: titleA});
      await expect(resolveHoverTarget(actualPage, {name: 'second', selector, index: 1, sourceIncludes: []}, 100))
        .resolves.toMatchObject({rawIndex: 2, sourceText: titleB});
      expect(actualPage.waitForFunction).toHaveBeenCalledWith(expect.any(Function), expect.any(Object), {timeout: 100});
      expect([...document.querySelectorAll(selector)].map(node => node.textContent)).toEqual([mixedTitle, titleA, titleB]);
      expect(() => assertCoverageReport([rule], tracker.report(), 'untranslated original owners')).toThrow();
    }, html, cases['github-project-pulls'].coverageRules);
  });

  it.each(['h1', 'h2', 'p', 'li'] as const)('retains the original %s semantic selector and source anchor', async tag => {
    const scopedSelector = `.hover ${tag}`;
    const first = 'Read the anchored source paragraph';
    const second = 'Read another anchored source paragraph';
    const html = `<main><div class="hover"><${tag}>${mixedTitle}</${tag}>` +
      `<${tag}>A different visible paragraph</${tag}><${tag}>${first}</${tag}><${tag}>${second}</${tag}></div></main>`;
    await withCompletionFixture(async ({page}) => {
      const actualPage = hoverPage(page);
      await expect(resolveHoverTarget(actualPage, {
        name: tag, selector: scopedSelector, index: 1, sourceIncludes: ['anchored source'],
      }, 100)).resolves.toMatchObject({rawIndex: 3, sourceText: second});
      expect(actualPage.waitForFunction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
        selector: scopedSelector, eligibleIndex: 1, sourceIncludes: ['anchored source'],
      }), {timeout: 100});
    }, html);
  });

  it('does not borrow Han from owned or protected descendants or select hidden or technical nodes', async () => {
    const html = '<main><div class="hover"><p>HTTPS</p><p class="sr-only">Read the hidden paragraph</p>' +
      '<p hidden>Read another hidden paragraph</p>' +
      '<p>Read the visible source paragraph<span class="fluent-read-bilingual-content">已有译文</span><script>中文</script></p>' +
      '</div></main>';
    await withCompletionFixture(async ({document, page}) => {
      await expect(resolveHoverTarget(hoverPage(page), {
        name: 'paragraph', selector: '.hover p', index: 0, sourceIncludes: ['visible source'],
      }, 100)).resolves.toMatchObject({rawIndex: 3, sourceText: 'Read the visible source paragraph'});
      expect(document.querySelector('.fluent-read-bilingual-content')?.textContent).toBe('已有译文');
      expect(document.querySelector('script')?.textContent).toBe('中文');
    }, html, [], element => ({display: element.hasAttribute('hidden') ? 'none' : 'block', visibility: 'visible'}));
  });

  it('keeps a list with only Chinese or mixed titles failing within the original timeout', async () => {
    const html = '<main><a data-testid="listitem-title-link">' + mixedTitle + '</a>' +
      '<a data-testid="listitem-title-link">Fix API 配置与 UI 标签</a></main>';
    await withCompletionFixture(async ({document, page}) => {
      const actualPage = hoverPage(page);
      await expect(resolveHoverTarget(actualPage, {name: 'primary', selector, index: 0, sourceIncludes: []}, 100))
        .rejects.toThrow('controlled hover target timeout');
      expect(actualPage.waitForFunction).toHaveBeenCalledTimes(1);
      expect(actualPage.waitForFunction).toHaveBeenCalledWith(expect.any(Function), expect.any(Object), {timeout: 100});
      expect(document.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(0);
    }, html);
  });
});

describe('full-page failure modal and geometry evidence',()=>{
  it('captures an obstructing delayed consent dialog without changing source DOM or granting completion',()=>{
    const {readFullPageFailureSnapshotInPage}=require('../scripts/run-site-translation-test.cjs');
    const {runInNewContext}=require('node:vm');
    const {document}=parseHTML('<html><head></head><body><main><p>Original readable page content.</p></main><div class="overlay"></div><section role="dialog" aria-modal="true"><a href="/cookies">Cookie Notice</a><button>OK</button></section><section role="dialog" hidden>Hidden panel</section></body></html>');
    const target=document.querySelector('p')!,dialog=document.querySelector('[aria-modal]')!,mask=document.querySelector('.overlay')!,button=document.querySelector('button')!;
    const rect={left:10,top:10,right:510,bottom:110,width:500,height:100};for(const node of document.querySelectorAll('*'))Object.defineProperty(node,'getBoundingClientRect',{configurable:true,value:()=>rect});
    Object.defineProperty(document,'activeElement',{value:dialog.querySelector('a')});Object.assign(document,{elementsFromPoint:()=>[dialog,mask,target]});
    const before=document.documentElement.outerHTML;
    const result=runInNewContext(`(${readFullPageFailureSnapshotInPage.toString()})('main p')`,{document,innerWidth:1000,innerHeight:800,getComputedStyle:(node:Element)=>({display:node.hasAttribute('hidden')?'none':'block',visibility:'visible',opacity:'1',position:node===dialog?'fixed':'static',zIndex:'100',overflow:'visible',overflowY:'visible',pointerEvents:'auto'})});
    expect(result.totalBilingual).toBe(0);expect(result.targetAncestors[0]).toMatchObject({tag:'P',rect,html:'<p>Original readable page content.</p>'});expect(result.visibleModals).toHaveLength(1);expect(result.visibleModals[0]).toMatchObject({role:'dialog',ariaModal:'true',containsTarget:false,containsActive:true});expect(result.visibleButtons[0].text).toBe(button.textContent);expect(result.pointStack[0].role).toBe('dialog');expect(result).not.toHaveProperty('ready');expect(document.documentElement.outerHTML).toBe(before);
  });
  it('records missing geometry targets and unavailable hit testing without inventing an occluder',()=>{
    const {readFullPageFailureSnapshotInPage}=require('../scripts/run-site-translation-test.cjs');const {runInNewContext}=require('node:vm');const {document}=parseHTML('<html><body></body></html>');
    const result=runInNewContext(`(${readFullPageFailureSnapshotInPage.toString()})('missing')`,{document,innerWidth:1000,innerHeight:800,getComputedStyle:()=>null});expect(result.targetText).toBe('');expect(result.targetPoint).toBeNull();expect(result.targetAncestors).toEqual([]);expect(result.pointStack).toEqual([]);expect(result.visibleModals).toEqual([]);
  });
});

describe('geometry-bounded long-page scrolling',()=>{
  async function scrollFixture(options:{extent:number;bodyExtent?:number;rootViewport?:number;stuck?:boolean;growAt?:number;growTo?:number;endless?:boolean}){
    const {scrollAndWaitFullPage}=require('../scripts/run-site-translation-test.cjs');const {createContext,runInContext}=require('node:vm');
    const {document,window:domWindow}=parseHTML('<html><head></head><body><p>Target source.</p></body></html>');
    let extent=options.extent,position=0,clock=100000,moves=0;const positions:number[]=[],distances:number[]=[];
    Object.defineProperty(document.body,'scrollHeight',{get:()=>options.bodyExtent ?? extent});Object.defineProperty(document.documentElement,'scrollHeight',{get:()=>extent});
    Object.defineProperty(document,'scrollingElement',{value:document.documentElement});Object.defineProperty(document.documentElement,'clientHeight',{value:options.rootViewport ?? 816});Object.defineProperty(document.documentElement,'scrollTop',{get:()=>position});
    const window={innerHeight:816,get scrollY(){return position},scrollTo(value:number|{top:number}){const next=typeof value==='number'?value:value.top;distances.push(Math.abs(next-position));moves++;if(!options.stuck)position=Math.max(0,Math.min(extent-(options.rootViewport ?? 816),next));positions.push(position);if(moves===options.growAt)extent=options.growTo!;if(options.endless)extent+=2000;}};
    const context=createContext({document,window,HTMLElement:domWindow.HTMLElement,Date:{now:()=>clock},performance:{now:()=>clock}});
    const evaluate=async(fn:Function,arg?:unknown)=>{context.argument=arg;return runInContext(`(${fn.toString()})(argument)`,context)};
    const page={evaluate,waitForTimeout:async(ms:number)=>{clock+=ms},waitForFunction:async(fn:Function,arg:unknown)=>{for(let i=0;i<100;i++){if(await evaluate(fn,arg))return;clock+=100}throw new Error('controlled idle did not settle')},locator:()=>({first:()=>({scrollIntoViewIfNeeded:async()=>{}})})};
    const run=()=>scrollAndWaitFullPage(page,1000,undefined,'p',async()=>{},async()=>{});
    return{run,positions,distances,get moves(){return moves},get extent(){return extent}};
  }
  it('visits every interval of a finite page taller than the old 320-step limit before returning to the target',async()=>{
    const fixture=await scrollFixture({extent:300000});await fixture.run();expect(Math.max(...fixture.positions)).toBe(300000-816);expect(fixture.moves).toBeGreaterThan(320);expect(fixture.distances.slice(1,-1).every(step=>step<=530)).toBe(true);
  });
  it('uses the actual scrolling root rather than a clipped body that is taller than the viewport',async()=>{
    const fixture=await scrollFixture({extent:816,bodyExtent:831});await fixture.run();expect(Math.max(...fixture.positions)).toBe(0);expect(fixture.moves).toBeLessThan(5);
  });
  it('requires the real scrolling root bottom even when body is shorter and a horizontal scrollbar reduces the viewport',async()=>{
    const fixture=await scrollFixture({extent:30000,bodyExtent:816,rootViewport:801});await fixture.run();expect(Math.max(...fixture.positions)).toBe(30000-801);expect(fixture.distances.slice(1,-1).every(step=>step<=520)).toBe(true);
  });
  it('accounts for observed translation layout growth while preserving contiguous viewport exposure',async()=>{
    const fixture=await scrollFixture({extent:60000,growAt:20,growTo:200000});await fixture.run();expect(Math.max(...fixture.positions)).toBe(200000-816);expect(fixture.distances.slice(1,-1).every(step=>step<=530)).toBe(true);
  });
  it('fails early when the page refuses scrolling instead of granting bottom coverage',async()=>{
    const fixture=await scrollFixture({extent:30000,stuck:true});await expect(fixture.run()).rejects.toThrow('没有滚动进展');expect(fixture.moves).toBeLessThan(20);
  });
  it('retains an absolute work cap for an infinitely growing page',async()=>{
    const fixture=await scrollFixture({extent:30000,endless:true});await expect(fixture.run()).rejects.toThrow('2048');expect(fixture.moves).toBeLessThanOrEqual(2050);
  });
});

describe('Steam discussion pinned-label source projection', () => {
  const {encodeControlledTranslation, readControlledPageEvidenceInPage, assertControlledPageEvidence,
    captureSourcePartitions, assertSourcePartitions} = require('../scripts/site-translation/controlled-provider.cjs');
  const title = 'A complete title explains stable behavior.\nThe final title words remain required.';
  const nativeTitle = '<div id="title" class="forum_topic_name"><span class="forum_topic_label sticky_label">PINNED:</span>' +
    'A complete title explains stable behavior.<br><strong>The final title words remain required.</strong></div>';
  const nativeContainer = `<div id="AppHubContent"><div class="forum_topics">${nativeTitle}</div></div>`;
  const withDom = async (url: string, html: string, run: (document: Document) => unknown) => {
    const document = parseHTML(`<html><body>${html}</body></html>`).document as unknown as Document;
    vi.stubGlobal('document', document);
    vi.stubGlobal('location', new URL(url));
    try {await run(document);} finally {
      delete (globalThis as Record<string, unknown>).__fluentReadControlledSourcePartitionsV1;
      vi.unstubAllGlobals();
    }
  };
  const appendOutput = (document: Document, text: string) => {
    const wrapper = document.createElement('span');
    wrapper.className = 'fluent-read-bilingual-content';
    wrapper.setAttribute('data-fr-translation-owned', 'true');
    wrapper.textContent = encodeControlledTranslation(text);
    document.querySelector('#title')!.append(wrapper);
    return wrapper;
  };

  it.each([
    'https://steamcommunity.com/app/570/discussions/',
    'https://steamcommunity.com/app/570/discussions/0/123456/',
    'http://steamcommunity.com/app/42/discussions/',
  ])('omits only the native label from complete source on %s and preserves the actual DOM', async url => {
    await withDom(url, nativeContainer, async document => {
      const page = {evaluate: async (fn: (value: unknown) => unknown, value: unknown) => fn(value)};
      const ledger = await captureSourcePartitions(page, [{selector: '#title', index: 0, sourcePartition: {excludeSelectors: []}}]);
      const label = document.querySelector('.forum_topic_label')!.outerHTML;
      const wrapper = appendOutput(document, title), rendered = document.body.innerHTML;
      const evidence = readControlledPageEvidenceInPage();
      expect(assertControlledPageEvidence(evidence, 'native-pinned')).toMatchObject({owners: 1});
      expect(evidence[0].source).toBe(title);
      expect(evidence[0].omittedParts).toContainEqual({tag: 'span', text: 'PINNED:', reason: 'site-rule-omission'});
      expect(await assertSourcePartitions(page, ledger, 'complete-pinned')).toMatchObject([{
        expectedSource: title, ownerCount: 1, completeSourceMatched: true,
      }]);
      expect(document.body.innerHTML).toBe(rendered);
      expect(document.querySelector('.forum_topic_label')!.outerHTML).toBe(label);
      wrapper.remove();
      expect(await assertSourcePartitions(page, ledger, 'restored-pinned', {restored: true})).toMatchObject([{restored: true}]);
    });
  });

  it('projects the actual observed Chinese pinned label while requiring the entire title', async () => {
    await withDom('https://steamcommunity.com/app/570/discussions/', nativeContainer.replace('PINNED:', '置顶：'), document => {
      appendOutput(document, title);
      const evidence = readControlledPageEvidenceInPage();
      expect(assertControlledPageEvidence(evidence, 'observed-chinese-label')).toMatchObject({owners: 1});
      expect(evidence[0].source).toBe(title);
      expect(evidence[0].omittedParts).toContainEqual({tag: 'span', text: '置顶：', reason: 'site-rule-omission'});
      expect(document.querySelector('.forum_topic_label')!.textContent).toBe('置顶：');
    });
  });

  it.each([
    'https://example.test/app/570/discussions/',
    'https://steamcommunity.com.evil.test/app/570/discussions/',
    'https://www.steamcommunity.com/app/570/discussions/',
    'https://steamcommunity.com/app/570/reviews/',
    'https://steamcommunity.com/app/not-numeric/discussions/',
    'https://steamcommunity.com/app/570/discussions',
    'https://steamcommunity.com/app/570/discussions-other/',
    'ftp://steamcommunity.com/app/570/discussions/',
  ])('keeps the same label as required source outside the exact native host/path %s', async url => {
    await withDom(url, nativeContainer, document => {
      appendOutput(document, title);
      const evidence = readControlledPageEvidenceInPage();
      expect(evidence[0].source).toContain('PINNED:');
      expect(evidence[0].omittedParts).not.toContainEqual(expect.objectContaining({reason: 'site-rule-omission'}));
      expect(() => assertControlledPageEvidence(evidence, 'wrong-site')).toThrow('complete source');
    });
  });

  it.each([
    `<div class="forum_topics">${nativeTitle}</div>`,
    `<div id="AppHubContent">${nativeTitle}</div>`,
    `<div id="AppHubContent"><div class="forum_topics">${nativeTitle.replace('forum_topic_name', 'commentthread_comment_text')}</div></div>`,
    nativeContainer.replace('forum_topic_label sticky_label', 'ordinary-title-word'),
  ])('does not omit an external or lookalike label merely because its text or class is familiar', async html => {
    await withDom('https://steamcommunity.com/app/570/discussions/', html, document => {
      appendOutput(document, title);
      const evidence = readControlledPageEvidenceInPage();
      expect(evidence[0].source).toContain('PINNED:');
      expect(() => assertControlledPageEvidence(evidence, 'wrong-container')).toThrow('complete source');
    });
  });

  it.each([
    ['missing body suffix', 'A complete title explains stable behavior.'],
    ['wrong encoded body', 'A different title explains stable behavior.\nThe final title words remain required.'],
    ['extra encoded label', 'PINNED:' + title],
    ['duplicated title', title + '\n' + title],
  ])('rejects %s even after the exact source metadata omission', async (_name, output) => {
    await withDom('https://steamcommunity.com/app/570/discussions/', nativeContainer, document => {
      appendOutput(document, output);
      expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'bad-output')).toThrow('complete source');
    });
  });

  it('never removes a literal or encoded label from actual translation output', async () => {
    await withDom('https://steamcommunity.com/app/570/discussions/', nativeContainer, document => {
      const wrapper = appendOutput(document, title);
      const label = document.createElement('span');
      label.className = 'forum_topic_label';
      label.textContent = 'PINNED:';
      wrapper.prepend(label);
      const literalHtml = wrapper.outerHTML;
      expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'literal-output-label')).toThrow('complete source');
      expect(wrapper.outerHTML).toBe(literalHtml);
      label.textContent = encodeControlledTranslation('PINNED:');
      const encodedHtml = wrapper.outerHTML;
      expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'encoded-output-label')).toThrow('complete source');
      expect(wrapper.outerHTML).toBe(encodedHtml);
    });
  });
});

describe('Bing native search redirect equivalence', () => {
  const {interactionHrefsEquivalent} = require('../scripts/site-translation/interaction-url.cjs');
  const page = 'https://www.bing.com/search?q=machine+translation';
  const target = 'https://www.machinetranslation.com/';
  const redirect = `https://www.bing.com/ck/a?p=tracking&u=a1${Buffer.from(target).toString('base64url')}&ntb=1`;

  it('keeps the same destination when Bing changes an observed tracking URL to a direct result link', () => {
    expect(interactionHrefsEquivalent(redirect, target, page)).toBe(true);
    expect(interactionHrefsEquivalent(target, target, 'https://example.com')).toBe(true);
  });

  it('still rejects a different destination, protocol, foreign redirect host, page or malformed payload', () => {
    for (const [before, after, url] of [
      [redirect, 'https://other.example/', page],
      [redirect, 'http://www.machinetranslation.com/', page],
      [redirect.replace('www.bing.com', 'www.bing.com.evil.test'), target, page],
      [redirect, target, 'https://www.bing.com/images/search'],
      [redirect, target, 'https://example.com/search'],
      ['https://www.bing.com/ck/a?u=a1!!invalid', target, page],
      [`https://www.bing.com/ck/a?u=a1${Buffer.from('javascript:alert(1)').toString('base64')}`, 'javascript:alert(1)', page],
    ]) expect(interactionHrefsEquivalent(before, after, url)).toBe(false);
  });
});
