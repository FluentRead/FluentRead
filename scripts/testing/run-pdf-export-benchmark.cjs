#!/usr/bin/env node
'use strict';

// Real-PDF production export benchmark. Each run owns an isolated background
// Edge profile and uses only a deterministic loopback translation fixture.
// Export timing starts at the actual UI click and stops at the download event;
// import, translation, save and PDF reopening have separate measurements.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground, queryMacFrontmostApplication} = require('./focus-safe-browser.cjs');
const {getGuardedBrowserPid} = require('./owned-browser-close.cjs');
const arg = (name, fallback) => {const index = process.argv.indexOf(`--${name}`); return index < 0 ? fallback : process.argv[index + 1];};
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const tight = value => value.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();

function buildFingerprint(directory) {
  const files = [];
  const walk = (root, relative = '') => {
    for (const entry of fs.readdirSync(root, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name), absolute = path.join(root, entry.name);
      if (entry.isDirectory()) walk(absolute, name);
      else if (entry.isFile()) files.push({name, bytes: fs.statSync(absolute).size, sha256: sha(fs.readFileSync(absolute))});
    }
  };
  walk(directory);
  return {sha256: sha(JSON.stringify(files)), files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), manifestSha256: sha(fs.readFileSync(path.join(directory, 'manifest.json')))};
}

async function fixtureServer(overflowRepeat) {
  const responses = new Map(), requests = [];
  let expandedMarker;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {res.writeHead(204); res.end(); return;}
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const prompt = body.messages.filter(message => message.role === 'user').map(message => message.content).join('\n');
      const source = /SOURCE_BEGIN([\s\S]*?)SOURCE_END/u.exec(prompt)?.[1];
      assert.equal(typeof source, 'string');
      const slots = [];
      const translate = text => {
        const marker = `BENCH_${sha(text).slice(0, 12)}`;
        if (!expandedMarker) expandedMarker = marker;
        const translation = `${marker} 测试译文：${Array(marker === expandedMarker ? overflowRepeat : 1).fill(text).join('\n')}`;
        slots.push({marker, sourceChars: text.length, translationChars: translation.length}); responses.set(marker, translation); return translation;
      };
      const protocol = /(___FLUENTREAD_([a-z0-9_-]+)_(\d+)_BEGIN___)([\s\S]*?)(___FLUENTREAD_\2_\3_END___)/giu;
      const translation = protocol.test(source) ? source.replace(protocol, (_match, begin, _nonce, _index, text, end) => `${begin}${translate(text)}${end}`) : translate(source);
      requests.push({slots});
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({id: 'pdf-export-fixture', object: 'chat.completion', created: 1, model: 'pdf-export-fixture',
        choices: [{index: 0, message: {role: 'assistant', content: translation}, finish_reason: 'stop'}], usage: {prompt_tokens: 10, completion_tokens: 10, total_tokens: 20}}));
    } catch (error) {res.writeHead(400); res.end(JSON.stringify({error: {message: error.message}}));}
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  return {responses, requests, resetDocument: () => {expandedMarker = undefined;}, get expandedMarker() {return expandedMarker;}, url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    close: () => {server.closeAllConnections(); return new Promise(resolve => server.close(resolve));}};
}

async function inspectPdf(bytes, requireRepo) {
  const {getDocument} = await import(requireRepo.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
  const task = getDocument({data: new Uint8Array(bytes), disableFontFace: true, isEvalSupported: false, useWorkerFetch: false, verbosity: 0,
    standardFontDataUrl: path.join(path.dirname(requireRepo.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep});
  try {
    const pdf = await task.promise, pages = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      try {
        const viewport = page.getViewport({scale: 1});
        const items = (await page.getTextContent()).items.filter(item => 'str' in item);
        const annotations = (await page.getAnnotations()).filter(annotation => annotation.subtype === 'Text').map(annotation => ({contents: annotation.contentsObj?.str ?? annotation.contents ?? '', rect: annotation.rect, flags: annotation.annotationFlags}));
        pages.push({number, width: viewport.width, height: viewport.height, text: items.map(item => item.str).join('\n'), annotations});
      } finally {page.cleanup();}
    }
    return pages;
  } finally {await task.destroy();}
}

async function renderPdfSamples(file, count, artifactsDir, prefix, executable) {
  const pages = [...new Set([1, Math.ceil(count / 2), count])], output = [];
  for (const number of pages) {
    const target = path.join(artifactsDir, `${prefix}-page-${number}`);
    await promisify(execFile)(executable, ['-f', String(number), '-l', String(number), '-singlefile', '-scale-to', '2000', '-png', file, target], {timeout: 60000, maxBuffer: 1024 * 1024});
    output.push({page: number, path: `${target}.png`});
  }
  return output;
}

function validateOutput(sourcePages, outputPages, fixture, mode, layout) {
  const sourceTexts = sourcePages.map(page => tight(page.text)), outputTexts = outputPages.map(page => tight(page.text));
  const fingerprints = sourceTexts.map((text, index) => {
    const candidates = [];
    for (const fraction of [0, .15, .33, .5, .7, .9]) {
      const start = Math.max(0, Math.min(Math.floor(text.length * fraction), text.length - 70));
      const snippet = text.slice(start, start + 70);
      if (snippet.length >= 24 && !sourceTexts.some((other, otherIndex) => otherIndex !== index && other.includes(snippet)) && !candidates.includes(snippet)) candidates.push(snippet);
    }
    return candidates;
  });
  const sourceOrder = fingerprints.map((anchors, index) => ({sourcePage: index + 1, anchors: anchors.length,
    outputPages: outputTexts.map((text, outputIndex) => ({page: outputIndex + 1, hits: anchors.filter(anchor => text.includes(anchor)).length})).filter(entry => entry.hits > 0)}));
  const dimensionFailures = [], missingOriginalPages = [], incorrectPageOrder = [];
  const sideBySide = mode === 'bilingual';
  sourcePages.forEach((source, index) => {
    const output = outputPages[index], expectedWidth = sideBySide ? source.width * 2 + Math.max(8, Math.min(24, source.width * .025)) : source.width;
    if (!output || Math.abs(output.width - expectedWidth) > .02 || Math.abs(output.height - source.height) > .02) dimensionFailures.push({page: index + 1, expected: {width: expectedWidth, height: source.height}, actual: output && {width: output.width, height: output.height}});
    if (sideBySide && fingerprints[index].length && !sourceOrder[index].outputPages.length) missingOriginalPages.push(index + 1);
    if (sideBySide && fingerprints[index].length && !sourceOrder[index].outputPages.some(entry => entry.page === index + 1 && entry.hits === fingerprints[index].length)) incorrectPageOrder.push(index + 1);
  });
  const annotations = outputPages.flatMap(page => page.annotations.map(annotation => ({page: page.number, pageWidth: page.width, pageHeight: page.height, ...annotation})));
  const fixtureAnnotations = annotations.filter(annotation => /BENCH_[a-f0-9]{12}/u.test(annotation.contents));
  const incompleteAnnotations = fixtureAnnotations.filter(annotation => {
    const marker = /BENCH_[a-f0-9]{12}/u.exec(annotation.contents)?.[0]; return fixture.responses.get(marker) !== annotation.contents;
  }).map(annotation => ({page: annotation.page, marker: /BENCH_[a-f0-9]{12}/u.exec(annotation.contents)?.[0], chars: annotation.contents.length}));
  const expandedAnnotation = fixtureAnnotations.find(annotation => annotation.contents === fixture.responses.get(fixture.expandedMarker));
  const outsideAnnotations = fixtureAnnotations.filter(annotation => annotation.rect[0] < 0 || annotation.rect[1] < 0 || annotation.rect[2] > annotation.pageWidth + .01 || annotation.rect[3] > annotation.pageHeight + .01).map(annotation => ({page: annotation.page, rect: annotation.rect}));
  const checks = {oneOutputPagePerSource: outputPages.length === sourcePages.length, originalPagesComplete: missingOriginalPages.length === 0,
    originalPageOrder: incorrectPageOrder.length === 0, exactPageDimensions: dimensionFailures.length === 0, annotationFullText: incompleteAnnotations.length === 0,
    overflowAnnotationsPresent: fixtureAnnotations.length > 0, annotationNoPrint: fixtureAnnotations.every(annotation => !(annotation.flags & 4)), annotationInsidePage: outsideAnnotations.length === 0};
  return {layout, checks, semanticOk: Object.values(checks).every(Boolean), sourceOrder, dimensionFailures, missingOriginalPages, incorrectPageOrder,
    sourcePagesWithoutUniqueFingerprint: fingerprints.map((anchors, index) => !anchors.length ? index + 1 : null).filter(Boolean),
    annotations: {total: annotations.length, fixture: fixtureAnnotations.length, incomplete: incompleteAnnotations, outside: outsideAnnotations, expandedMarker: fixture.expandedMarker, expandedPage: expandedAnnotation?.page, expandedChars: expandedAnnotation?.contents.length,
      expandedAnnotationPresent: Boolean(expandedAnnotation), expandedNote: 'The first sixfold translation may fit at >=6pt; a note is required only when the bounded raster fitting cannot display all text.'}};
}

async function main() {
  const repository = path.resolve(__dirname, '../..'), requireRepo = createRequire(path.join(repository, 'package.json'));
  const inputs = arg('inputs', '').split(',').filter(Boolean).map(file => path.resolve(file));
  assert(inputs.length && inputs.every(file => fs.existsSync(file)), '--inputs requires comma-separated existing real PDF files');
  const extensionDir = path.resolve(arg('extension-dir', path.join(repository, '.output/chrome-mv3')));
  assert(fs.existsSync(path.join(extensionDir, 'manifest.json')) && !/-dev$/u.test(extensionDir), 'Use a built production extension');
  const label = arg('label', 'fixed'), layout = arg('layout', 'side-by-side');
  assert(['observe', 'side-by-side'].includes(layout));
  const modes = arg('modes', 'bilingual').split(','); assert(modes.length && modes.every(mode => ['bilingual', 'translated'].includes(mode)));
  const packages = arg('playwright-root'); assert(packages, '--playwright-root required');
  const {chromium} = createRequire(path.join(packages, 'pdf-export-runner.cjs'))('playwright');
  const artifactsDir = path.resolve(arg('artifacts-dir', `/private/tmp/fluentread-pdf-export-${label}`)); fs.mkdirSync(artifactsDir, {recursive: true});
  const pdftoppm = arg('pdftoppm', '/Users/thinkstu/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/pdftoppm');
  assert(fs.existsSync(pdftoppm), '--pdftoppm must point to Poppler for export preview evidence');
  const overflowRepeat = Number(arg('overflow-repeat', 6)), cancelAfterPages = Number(arg('cancel-after-pages', 2));
  const exportTimeout = Number(arg('export-timeout-ms', 180000)), translationTimeout = Number(arg('translation-timeout-ms', 600000)), cancelTimeout = Number(arg('cancel-timeout-ms', 5000));
  assert(Number.isInteger(overflowRepeat) && overflowRepeat >= 1 && Number.isInteger(cancelAfterPages) && cancelAfterPages >= 1);
  const report = {ok: false, label, declaredBuildCommit: arg('build-commit', null), extensionDir, build: buildFingerprint(extensionDir), artifactsDir,
    parameters: {modes, layout, overflowRepeat, cancelAfterPages, exportTimeout, translationTimeout, cancelTimeout, fixtureDelayMs: 0, documentBatchTranslation: 'default true when available', viewport: {width: 1440, height: 960}},
    timingContract: 'exportMs: actual export UI click to Playwright download event; excludes import, translation, saveAs, reopening and screenshots',
    limitations: ['Deterministic loopback translation, not an online provider.', 'Cancellation invokes the visible UI button from a progress observer; heartbeat measures main-thread responsiveness.', 'Source text fingerprints validate order/completeness; rendering requires visual inspection.'],
    inputs: [], screenshots: [], consoleErrors: [], cleanupErrors: []};
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-pdf-export-'));
  let fixture, launched, page, launchAttempted = false;
  try {
    fixture = await fixtureServer(overflowRepeat); launchAttempted = true;
    launched = await launchFocusSafePersistentContext({chromium, profileDir, browserPath: arg('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      background: true, headless: false, displayTarget: arg('display', 'secondary'), viewport: {width: 1440, height: 960}, timeout: 30000,
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    assert.equal(report.launchMode, 'macos-background-cdp'); assert.equal(report.windowPlacement.browserFrontmost, false);
    const context = launched.context, worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 30000});
    const origin = /^chrome-extension:\/\/[^/]+/u.exec(worker.url())[0];
    page = await newPageWithoutForeground(context, 30000); page.setDefaultTimeout(30000);
    page.on('pageerror', error => report.consoleErrors.push(error.message));
    page.on('console', message => {if (message.type() === 'error') report.consoleErrors.push(message.text());});
    await page.goto(`${origin}/document.html`, {waitUntil: 'domcontentloaded'}); await activateExtensionTabWithoutForeground(context, page);
    await page.locator('.file-drop-zone').waitFor();
    const service = 'custom:pdf-export-fixture';
    const seeded = await page.evaluate(async ({service, endpoint}) => {
      const stored = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'}); if (!stored.success) throw new Error(stored.error);
      const current = typeof stored.value === 'string' ? JSON.parse(stored.value) : stored.value;
      return chrome.runtime.sendMessage({type: 'persistConfig', mode: 'replace', baseRevision: current.__fluentConfigRevision, clientId: `pdf-export-fixture-${crypto.randomUUID()}`, sequence: 1,
        config: {...current, uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, from: 'en', to: 'zh-Hans', documentService: service,
          documentModel: {...current.documentModel, [service]: 'pdf-export-fixture'}, customOpenAIProviders: [{id: service, name: '本机 PDF 导出基准', endpoint, models: ['pdf-export-fixture']}],
          requireApiKey: {[`v2:${JSON.stringify([service, 'pdf-export-fixture'])}`]: false}, user_role: {...current.user_role, [service]: 'SOURCE_BEGIN{{origin}}SOURCE_END'}, enableAIContext: false, enableAIMultiSegment: false}});
    }, {service, endpoint: fixture.url}); assert.equal(seeded.success, true, seeded.error);
    const shot = async name => {const file = path.join(artifactsDir, `${name}.png`); await page.screenshot({path: file, animations: 'disabled'}); report.screenshots.push(file);};
    const openDialog = async mode => {
      const existing = page.locator('.download-dialog[open]');
      if (!await existing.count()) await page.locator('.download-button').click();
      const dialog = page.locator('.download-dialog[open]'); await dialog.waitFor();
      await dialog.locator('.export-options button').nth(mode === 'bilingual' ? 0 : 1).click(); return dialog;
    };
    const startMonitor = async cancel => page.evaluate(({cancel, cancelAfterPages}) => {
      const dialog = document.querySelector('.download-dialog[open]');
      const state = window.__pdfExportBenchmark = {startedAt: null, startedPerf: null, maxHeartbeatGapMs: 0, heartbeats: 0, progress: [], cancelRequestedAt: null, canceledAt: null};
      let lastTick = performance.now(), lastText = '';
      const capture = () => {
        const text = dialog.querySelector('.export-progress')?.textContent.trim() || '';
        if (text && text !== lastText) {lastText = text; const match = /(\d+)\s*\/\s*(\d+)/u.exec(text); state.progress.push({text, elapsedMs: performance.now() - state.startedPerf, completed: match ? Number(match[1]) : null, total: match ? Number(match[2]) : null});}
        if (text.includes('已取消生成')) state.canceledAt ??= performance.now();
        if (cancel && state.cancelRequestedAt === null && state.progress.some(entry => entry.completed >= cancelAfterPages)) {
          const button = [...dialog.querySelectorAll('button')].find(button => button.textContent.trim() === '取消生成');
          if (button && !button.disabled) {state.cancelRequestedAt = performance.now(); button.click();}
        }
      };
      window.__pdfExportTimer = setInterval(() => {const now = performance.now(); if (state.startedAt !== null) {state.maxHeartbeatGapMs = Math.max(state.maxHeartbeatGapMs, now - lastTick); state.heartbeats++;} lastTick = now; capture();}, 25);
      window.__pdfExportObserver = new MutationObserver(capture); window.__pdfExportObserver.observe(dialog, {subtree: true, childList: true, characterData: true, attributes: true});
      const button = dialog.querySelector('.translate-document-button');
      button.addEventListener('click', () => {state.startedAt = Date.now(); state.startedPerf = performance.now(); lastTick = performance.now();}, {once: true});
    }, {cancel, cancelAfterPages});
    const stopMonitor = () => page.evaluate(() => {clearInterval(window.__pdfExportTimer); window.__pdfExportObserver?.disconnect(); const state = window.__pdfExportBenchmark; return {...state, cancelLatencyMs: state.canceledAt !== null && state.cancelRequestedAt !== null ? state.canceledAt - state.cancelRequestedAt : null};});
    const translated = [];
    for (const input of inputs) {
      const bytes = fs.readFileSync(input), inspectStart = Date.now(), sourcePages = await inspectPdf(bytes, requireRepo);
      const evidence = {input, sha256: sha(bytes), inputBytes: bytes.length, sourcePages: sourcePages.length, sourceInspectMs: Date.now() - inspectStart, exports: []}; report.inputs.push(evidence);
      fixture.resetDocument();
      const name = path.basename(input), requestStart = fixture.requests.length, importStart = Date.now();
      await page.locator('input[type=file]').setInputFiles({name, mimeType: 'application/pdf', buffer: bytes});
      await page.locator('.workspace-heading h1').filter({hasText: name}).waitFor({timeout: translationTimeout});
      await page.locator('.pdf-page-row[data-render-state="ready"] canvas').first().waitFor({timeout: translationTimeout}); evidence.importMs = Date.now() - importStart;
      console.log(JSON.stringify({stage: 'imported', label, name, pages: sourcePages.length, importMs: evidence.importMs}));
      evidence.batchTranslation = await page.locator('.document-batch-translation input').count() ? await page.locator('.document-batch-translation input').isChecked() : null;
      const translationStart = Date.now(); await page.locator('.taskbar-actions .translate-document-button').filter({hasText: '开始翻译'}).click();
      await page.locator('.document-status').filter({hasText: '翻译完成'}).waitFor({state: 'attached', timeout: translationTimeout});
      evidence.translationMs = Date.now() - translationStart; evidence.translationRequests = fixture.requests.length - requestStart;
      evidence.fixtureProtocol = {batchRequests: fixture.requests.slice(requestStart).filter(request => request.slots.length > 1).length, singleRequests: fixture.requests.slice(requestStart).filter(request => request.slots.length === 1).length};
      evidence.fixture = {expandedMarker: fixture.expandedMarker, expandedChars: fixture.responses.get(fixture.expandedMarker)?.length}; translated.push(name);
      console.log(JSON.stringify({stage: 'translated', label, name, translationMs: evidence.translationMs, requests: evidence.translationRequests, protocol: evidence.fixtureProtocol}));
      await shot(`${label}-${name}-translated`);
      const cancelDialog = await openDialog(modes[0]); await startMonitor(true);
      const cancellationDownloads = []; const onCanceledDownload = download => cancellationDownloads.push(download.suggestedFilename()); page.on('download', onCanceledDownload);
      await cancelDialog.locator('.translate-document-button').click();
      let cancelError;
      try {await page.waitForFunction(() => window.__pdfExportBenchmark?.canceledAt !== null, null, {timeout: exportTimeout});} catch (error) {cancelError = error.message;}
      const cancellation = await stopMonitor(); page.off('download', onCanceledDownload);
      Object.assign(cancellation, {error: cancelError, downloads: cancellationDownloads, responsive: cancellation.cancelLatencyMs !== null && cancellation.cancelLatencyMs <= cancelTimeout, retryEnabled: await page.locator('.download-dialog[open] .translate-document-button').isEnabled().catch(() => false)});
      evidence.cancellation = cancellation; await shot(`${label}-${name}-canceled`);
      console.log(JSON.stringify({stage: 'canceled', label, name, cancelLatencyMs: cancellation.cancelLatencyMs, heartbeatGapMs: cancellation.maxHeartbeatGapMs, responsive: cancellation.responsive}));
      if (layout === 'side-by-side') {assert(cancellation.responsive, `Cancellation did not complete within ${cancelTimeout}ms: ${JSON.stringify(cancellation)}`); assert.equal(cancellationDownloads.length, 0); assert(cancellation.retryEnabled);}
      if (cancelError) throw new Error(`Cancellation attempt did not settle: ${cancelError}`);
      for (const mode of modes) {
        const dialog = await openDialog(mode); await startMonitor(false);
        const result = {mode}; evidence.exports.push(result);
        const downloadPromise = page.waitForEvent('download', {timeout: exportTimeout}).then(download => ({download, at: Date.now()}));
        await dialog.locator('.translate-document-button').click();
        let downloaded;
        try {downloaded = await downloadPromise;} catch (error) {result.error = error.message; result.monitor = await stopMonitor(); await shot(`${label}-${name}-${mode}-timeout`); throw error;}
        result.monitor = await stopMonitor(); result.exportMs = downloaded.at - result.monitor.startedAt;
        console.log(JSON.stringify({stage: 'exported', label, name, mode, exportMs: result.exportMs, heartbeatGapMs: result.monitor.maxHeartbeatGapMs}));
        const saveStart = Date.now(), output = path.join(artifactsDir, `${label}-${name.replace(/\.pdf$/iu, '')}-${mode}.pdf`);
        await downloaded.download.saveAs(output); result.saveMs = Date.now() - saveStart; result.output = output;
        const outputBytes = fs.readFileSync(output); result.bytes = outputBytes.length; result.sha256 = sha(outputBytes);
        const reopenStart = Date.now(), outputPages = await inspectPdf(outputBytes, requireRepo); result.reopenMs = Date.now() - reopenStart; result.pages = outputPages.length;
        result.validation = validateOutput(sourcePages, outputPages, fixture, mode, layout);
        const renderStart = Date.now(); result.previews = await renderPdfSamples(output, outputPages.length, artifactsDir, `${label}-${name.replace(/\.pdf$/iu, '')}-${mode}`, pdftoppm); result.renderMs = Date.now() - renderStart;
        fs.writeFileSync(path.join(artifactsDir, `${label}-${name}-${mode}-page-validation.json`), JSON.stringify(result.validation, null, 2));
        // Evidence is emitted before an assertion so baseline/fixed failures
        // retain the output PDF and timing for independent investigation.
        fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
        if (layout === 'side-by-side') assert(result.validation.semanticOk, `Export page/content validation failed for ${name}/${mode}: ${JSON.stringify(result.validation.checks)}`);
      }
      if (input !== inputs.at(-1)) {
        const settings = page.locator('aside.document-sidebar').getByRole('button', {name: '调整文档翻译设置', exact: true});
        if (!await settings.isVisible()) await page.locator('.sidebar-toggle').click(); await settings.click();
        await page.locator('.document-settings-dialog[open] .sidebar-change-file').click();
        const confirm = page.locator('dialog[open]').filter({has: page.locator('#confirm-document-heading')});
        if (await confirm.count()) await confirm.locator('.translate-document-button').click(); await page.locator('.file-drop-zone').waitFor();
      }
    }
    report.fixtureRequests = fixture.requests.length;
    const frontmost = await queryMacFrontmostApplication(); assert(frontmost); assert.notEqual(frontmost.pid, await getGuardedBrowserPid(launched)); report.finalFrontmostApplication = frontmost;
    assert.equal(report.consoleErrors.length, 0, JSON.stringify(report.consoleErrors)); report.ok = true;
  } catch (error) {
    report.failure = error.stack || String(error); if (page) await page.screenshot({path: path.join(artifactsDir, 'failure.png')}).catch(() => {}); throw error;
  } finally {
    let closed = false;
    if (launched) {try {await launched.close(); closed = true;} catch (error) {report.cleanupErrors.push(`browser close: ${error.stack || error}`);}}
    try {await fixture?.close();} catch (error) {report.cleanupErrors.push(`fixture close: ${error.message}`);}
    if (closed) {try {fs.rmSync(profileDir, {recursive: true, force: true});} catch (error) {report.cleanupErrors.push(`profile removal: ${error.message}`); report.retainedProfile = profileDir;}}
    else if (!launchAttempted) fs.rmdirSync(profileDir); else report.retainedProfile = profileDir;
    if (report.cleanupErrors.length) {report.ok = false; process.exitCode = 1;}
    fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ok: report.ok, label, report: path.join(artifactsDir, 'report.json'), inputs: report.inputs.map(input => ({input: input.input, pages: input.sourcePages, cancellationMs: input.cancellation?.cancelLatencyMs, exports: input.exports.map(result => ({mode: result.mode, exportMs: result.exportMs, pages: result.pages, bytes: result.bytes, semanticOk: result.validation?.semanticOk}))})), failure: report.failure, cleanupErrors: report.cleanupErrors}));
  }
}

main().catch(error => {console.error(error.stack || error); process.exitCode = 1;});
