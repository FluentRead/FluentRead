#!/usr/bin/env node
'use strict';

// Targeted document zoom evidence in an isolated, visible background Edge.
// CDP wheel/keyboard verifies browser defaults; synthetic WheelEvent bursts
// verify frame coalescing/disposal. Neither substitutes for a physical trackpad.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');
const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground, queryMacFrontmostApplication} = require('./focus-safe-browser.cjs');
const {getGuardedBrowserPid} = require('./owned-browser-close.cjs');
const arg = (name, fallback) => {const index = process.argv.indexOf(`--${name}`); return index < 0 ? fallback : process.argv[index + 1];};
const SUPPORTED = ['sample.pdf', 'sample.docx', 'sample.html', 'sample.epub', 'sample.md', 'sample.txt', 'sample.srt', 'sample.json'];

async function fixtureServer() {
  const requests = [];
  const state = {delay: 0};
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {res.writeHead(204); res.end(); return;}
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const prompt = body.messages.filter(message => message.role === 'user').map(message => message.content).join('\n');
      const source = /SOURCE_BEGIN([\s\S]*?)SOURCE_END/u.exec(prompt)?.[1];
      assert.equal(typeof source, 'string'); requests.push(source);
      const protocol = /(___FLUENTREAD_([a-z0-9_-]+)_(\d+)_BEGIN___)([\s\S]*?)(___FLUENTREAD_\2_\3_END___)/giu;
      const translation = protocol.test(source) ? source.replace(protocol, (_match, begin, _nonce, _index, text, end) => `${begin}测试译文：${text}${end}`) : `测试译文：${source}`;
      if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({id: 'document-zoom-fixture', object: 'chat.completion', created: 1, model: 'document-zoom-fixture',
        choices: [{index: 0, message: {role: 'assistant', content: translation}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 10, completion_tokens: 10, total_tokens: 20}}));
    } catch (error) {res.writeHead(400); res.end(JSON.stringify({error: {message: error.message}}));}
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  return {requests, state, url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, close: () => {server.closeAllConnections(); return new Promise(resolve => server.close(resolve));}};
}

async function main() {
  const repository = path.resolve(__dirname, '../..');
  const extensionDir = path.resolve(arg('extension-dir', path.join(repository, '.output/chrome-mv3')));
  const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-document-zoom-production'));
  const exampleDir = path.resolve(arg('example-dir', path.join(repository, 'examples/document-translation')));
  const suites = arg('suite', 'all').split(',');
  const extremeOnly = process.argv.includes('--extreme-only');
  assert(suites.every(suite => ['all', 'pdf', 'readers', 'lifecycle', 'responsive'].includes(suite)), 'suite supports all, pdf, readers, lifecycle, responsive (comma separated)');
  const requested = arg('formats', SUPPORTED.join(',')).split(',').map(value => value.trim()).filter(Boolean);
  assert(requested.length && requested.every(name => SUPPORTED.includes(name)), `formats must be selected from ${SUPPORTED.join(',')}`);
  const formats = requested.filter(name => suites.includes('all') || suites.includes('lifecycle') || (suites.includes('responsive') && ['sample.pdf', 'sample.docx'].includes(name)) || (name === 'sample.pdf' ? suites.includes('pdf') : suites.includes('readers')));
  assert(formats.length, 'Selected suite has no matching formats');
  assert(fs.existsSync(path.join(extensionDir, 'manifest.json')), 'Build the extension before running this production browser test');
  assert(!/-dev$/u.test(extensionDir), 'This delivery script requires a production extension build');
  const packages = arg('playwright-root'); assert(packages, '--playwright-root is required');
  const requireRuntime = createRequire(path.join(packages, 'document-zoom-runner.cjs'));
  const {chromium} = requireRuntime('playwright');
  fs.mkdirSync(artifactsDir, {recursive: true});
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-document-zoom-'));
  const report = {ok: false, extensionDir, artifactKind: 'production', suites, formats, artifactsDir,
    scope: 'document reader zoom gestures, scrolling, keyboard, raster settling, editor isolation and document/iframe lifecycle',
    interactionCoverage: ['trusted CDP wheel and keyboard', 'synthetic WheelEvent bursts and synchronous switch'],
    limitations: ['No physical trackpad pinch, Firefox runtime, online provider, OCR quality or full document regression was tested.'],
    cases: [], screenshots: [], consoleErrors: [], formatEvidence: {}, cleanupErrors: []};
  let fixture, launched, page, cdp, launchAttempted = false;
  const record = (name, evidence) => report.cases.push({name, ...evidence});
  try {
    fixture = await fixtureServer(); launchAttempted = true;
    launched = await launchFocusSafePersistentContext({chromium, profileDir,
      browserPath: arg('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      background: true, headless: false, displayTarget: arg('display', 'secondary'), viewport: {width: 1440, height: 960}, timeout: 30000,
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    assert.equal(report.launchMode, 'macos-background-cdp');
    assert.equal(report.focusPolicy, 'launchservices-no-foreground');
    assert.equal(report.windowPlacement.browserFrontmost, false);
    const context = launched.context;
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 30000});
    const origin = /^chrome-extension:\/\/[^/]+/u.exec(worker.url())[0];
    page = await newPageWithoutForeground(context, 30000);
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => report.consoleErrors.push(error.message));
    page.on('console', message => {if (message.type() === 'error') report.consoleErrors.push(message.text());});
    await page.goto(`${origin}/document.html`, {waitUntil: 'domcontentloaded'});
    await activateExtensionTabWithoutForeground(context, page);
    await page.locator('.file-drop-zone').waitFor();
    cdp = await context.newCDPSession(page);
    const service = 'custom:document-zoom-fixture';
    const seeded = await page.evaluate(async ({service, endpoint}) => {
      const stored = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      if (!stored.success) throw new Error(stored.error);
      const current = typeof stored.value === 'string' ? JSON.parse(stored.value) : stored.value;
      return chrome.runtime.sendMessage({type: 'persistConfig', mode: 'replace', baseRevision: current.__fluentConfigRevision,
        clientId: `document-zoom-fixture-${crypto.randomUUID()}`, sequence: 1, config: {...current,
          uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, from: 'en', to: 'zh-Hans', documentService: service,
          documentModel: {...current.documentModel, [service]: 'document-zoom-fixture'},
          customOpenAIProviders: [{id: service, name: '本机缩放测试翻译', endpoint, models: ['document-zoom-fixture']}],
          requireApiKey: {[`v2:${JSON.stringify([service, 'document-zoom-fixture'])}`]: false},
          user_role: {...current.user_role, [service]: 'SOURCE_BEGIN{{origin}}SOURCE_END'}, enableAIContext: false, enableAIMultiSegment: false,
        }});
    }, {service, endpoint: fixture.url});
    assert.equal(seeded.success, true, seeded.error);
    const shot = async name => {const file = path.join(artifactsDir, `${name}.png`); await page.screenshot({path: file, animations: 'disabled'}); report.screenshots.push(file);};
    const browserScale = async () => {
      const result = await page.evaluate(async () => {const tab = await chrome.tabs.getCurrent(); return {tabZoom: await chrome.tabs.getZoom(tab.id), visualViewportScale: window.visualViewport?.scale ?? 1};});
      assert.equal(result.tabZoom, 1, 'Document zoom must not zoom the browser tab');
      assert.equal(result.visualViewportScale, 1, 'Document zoom must not zoom the outer viewport');
      return result;
    };
    const waitFrames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // Probe actual DOM surfaces, including the same-origin sandboxed preview.
    const probe = (kind, action, params = {}) => page.evaluate(async ({kind, action, params}) => {
      const outer = document.querySelector('.reading-content');
      const frame = document.querySelector('.rich-preview-frame');
      const rich = kind === 'rich';
      const target = kind === 'pdf' ? document.querySelector('[data-pdf-scroll]') : rich ? frame?.contentDocument?.documentElement : outer;
      if (!target) throw new Error(`Missing ${kind} zoom target`);
      const doc = target.ownerDocument, view = doc.defaultView;
      const scroller = kind === 'pdf' ? target : rich ? doc.scrollingElement : document.querySelector('.docx-page-stage') || outer;
      const content = rich ? doc.body : kind === 'pdf' ? target.querySelector('.pdf-page-column:not(.translated) .pdf-page-frame') : outer.querySelector('.docx-page,[data-native-zoom-content]');
      const scale = () => Number((kind === 'pdf' ? target : outer).dataset.readerZoom);
      const box = scroller.getBoundingClientRect();
      const point = params.point || (rich ? {clientX: Math.min(scroller.clientWidth * .45, 320), clientY: Math.min(scroller.clientHeight * .45, 280)} : {clientX: box.left + scroller.clientWidth * .45, clientY: box.top + Math.min(scroller.clientHeight * .45, 280)});
      const metrics = () => ({scale: scale(), contentZoom: content ? Number(view.getComputedStyle(content).zoom) : null,
        scrollTop: scroller.scrollTop, scrollLeft: scroller.scrollLeft, scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth,
        scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight});
      if (action === 'metrics') return metrics();
      if (action === 'ordinary') {const event = new view.WheelEvent('wheel', {bubbles: true, cancelable: true, deltaY: 100, ...point}); target.dispatchEvent(event); return {defaultPrevented: event.defaultPrevented, ...metrics()};}
      if (action === 'focus') {const focus = rich ? doc.body : target; if (rich) focus.tabIndex = 0; focus.focus({preventScroll: true}); return metrics();}
      if (action === 'scrollStart') {scroller.scrollTop = 0; scroller.scrollLeft = 0; return metrics();}
      if (action === 'anchor') {
        const frame = target.querySelector('.pdf-page-column:not(.translated) .pdf-page-frame'), rect = frame.getBoundingClientRect();
        const viewRect = target.getBoundingClientRect();
        const clientX = (Math.max(rect.left, viewRect.left + 8) + Math.min(rect.right, viewRect.right - 8)) / 2;
        const clientY = (Math.max(rect.top, viewRect.top + 8) + Math.min(rect.bottom, viewRect.bottom - 8)) / 2;
        const anchorPoint = params.point || {clientX, clientY};
        return {point: anchorPoint, page: frame.closest('[data-page-number]').dataset.pageNumber, x: (anchorPoint.clientX - rect.left) / rect.width, y: (anchorPoint.clientY - rect.top) / rect.height, width: rect.width, height: rect.height};
      }
      if (action === 'wheel' || action === 'switch') {
        const started = performance.now();
        const before = scale(), prevented = [];
        const mutations = []; const observer = new MutationObserver(entries => mutations.push(...entries.filter(entry => entry.attributeName === 'data-reader-zoom')));
        observer.observe(kind === 'pdf' ? target : outer, {attributes: true});
        const canvases = kind === 'pdf' ? [...target.querySelectorAll('canvas')].map(node => ({node, width: node.width, height: node.height})) : [];
        for (let index = 0; index < (params.count || 1); index++) {
          const event = new view.WheelEvent('wheel', {bubbles: true, cancelable: true, ctrlKey: params.modifier !== 'meta', metaKey: params.modifier === 'meta', deltaY: params.delta ?? -30, ...point});
          target.dispatchEvent(event); prevented.push(event.defaultPrevented);
        }
        const immediate = scale();
        if (action === 'switch') {
          const button = [...document.querySelectorAll('.batch-file')].find(button => button.querySelector('span')?.textContent === params.name);
          if (!button || button.disabled) throw new Error(`Cannot switch synchronously to ${params.name}`); button.click();
        }
        await new Promise(resolve => view.requestAnimationFrame(() => view.requestAnimationFrame(resolve)));
        observer.disconnect();
        return {before, immediate, after: scale(), prevented, mutations: mutations.length,
          elapsedMs: performance.now() - started,
          canvasesRetained: canvases.every(({node, width, height}) => node.isConnected && node.width === width && node.height === height),
          rasterBefore: canvases.map(({width, height}) => ({width, height})), point, ...metrics()};
      }
      throw new Error(`Unknown action ${action}`);
    }, {kind, action, params});
    const kindFor = name => name === 'sample.pdf' ? 'pdf' : ['sample.html', 'sample.md', 'sample.txt', 'sample.epub'].includes(name) ? 'rich' : 'native';
    const selectFile = async name => {
      if (await page.locator('.workspace-heading h1').textContent() !== name) {
        if (!await page.locator('aside.document-sidebar').isVisible()) await page.locator('.sidebar-toggle').click();
        const filesTab = page.locator('.sidebar-tabs [role="tab"]').filter({hasText: '文件'});
        if (await filesTab.getAttribute('aria-selected') !== 'true') await filesTab.click();
        await page.locator('.batch-file').filter({has: page.locator('span', {hasText: name})}).click();
      }
      await page.locator('.workspace-heading h1').filter({hasText: name}).waitFor();
      await page.getByRole('button', {name: '阅读', exact: true}).click();
      const kind = kindFor(name);
      if (kind === 'rich') {
        await page.waitForFunction(() => Boolean(document.querySelector('.rich-preview-frame')?.contentDocument?.body?.innerText.trim()));
      } else if (kind === 'pdf') await page.locator('.pdf-page-row[data-render-state="ready"] canvas').first().waitFor();
      else await page.locator('.reading-content .docx-page,.reading-content [data-native-zoom-content]').first().waitFor();
      await waitFrames(); return kind;
    };
    await page.locator('input[type=file]').setInputFiles(formats.map(name => ({name, mimeType: 'application/octet-stream', buffer: fs.readFileSync(path.join(exampleDir, name))})));
    await page.locator('.workspace-heading h1').waitFor();
    await page.waitForFunction(count => [...document.querySelectorAll('.batch-file')].filter(button => !button.disabled).length === count, formats.length);
    for (const name of suites.every(suite => suite === 'responsive') ? [] : formats) {
      const kind = await selectFile(name), details = {kind};
      const ordinary = await probe(kind, 'ordinary'); assert.equal(ordinary.defaultPrevented, false);
      const burst = await probe(kind, 'wheel', {count: 12, delta: -8});
      assert.equal(burst.immediate, burst.before, 'Wheel bursts must wait for a rendering frame');
      assert(burst.prevented.every(Boolean), 'Pinch events must suppress browser zoom');
      assert(burst.after > burst.before, 'Pinch must increase document scale');
      assert.equal(burst.mutations, 1, 'A same-frame burst must commit the scale only once');
      if (kind !== 'pdf') assert(Math.abs(burst.contentZoom - burst.after) < .0002, 'Actual body/content zoom must match reader scale');
      details.burst = burst; details.browserScale = await browserScale();
      // Trusted Ctrl and Cmd wheel reach the browser's real default-zoom path.
      const surface = kind === 'pdf' ? page.locator('[data-pdf-scroll]') : kind === 'rich' ? page.locator('.rich-preview-frame') : page.locator('.reading-content');
      const rect = await surface.boundingBox(); assert(rect);
      const point = {x: rect.x + Math.min(rect.width * .4, 250), y: rect.y + Math.min(rect.height * .4, 250)};
      for (const modifier of [2, 4]) {
        const before = (await probe(kind, 'metrics')).scale;
        await cdp.send('Input.dispatchMouseEvent', {type: 'mouseMoved', ...point});
        await cdp.send('Input.dispatchMouseEvent', {type: 'mouseWheel', ...point, deltaX: 0, deltaY: -70, modifiers: modifier});
        await page.waitForFunction(({kind, before}) => Number(document.querySelector(kind === 'pdf' ? '[data-pdf-scroll]' : '.reading-content').dataset.readerZoom) > before, {kind, before});
        await browserScale();
      }
      details.trustedWheel = ['Ctrl', 'Cmd'];
      if (name === 'sample.docx') await shot('docx-enlarged');
      await probe(kind, 'focus');
      const beforeKeyboard = (await probe(kind, 'metrics')).scale;
      await page.keyboard.press('Control+='); await waitFrames();
      const afterPlus = (await probe(kind, 'metrics')).scale; assert(afterPlus > beforeKeyboard);
      await page.keyboard.press('Meta+-'); await waitFrames();
      assert((await probe(kind, 'metrics')).scale < afterPlus, 'Cmd minus must decrease document scale');
      await page.keyboard.press('Control+0'); await waitFrames();
      const reset = await probe(kind, 'metrics');
      if (kind === 'pdf') assert.match(await page.locator('.pdf-zoom-control .pdf-menu-button').innerText(), /适合宽度|Fit width/u);
      else assert.equal(reset.scale, 1);
      details.keyboard = {before: beforeKeyboard, reset: reset.scale}; await browserScale();
      await page.getByRole('button', {name: '校订译文', exact: true}).click();
      const editable = page.locator('textarea.document-translation').first(); await editable.waitFor();
      const editorEvents = await editable.evaluate(element => {
        const wheel = new WheelEvent('wheel', {bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100});
        const key = new KeyboardEvent('keydown', {bubbles: true, cancelable: true, ctrlKey: true, key: '+'});
        element.dispatchEvent(wheel); element.dispatchEvent(key); return {wheel: wheel.defaultPrevented, key: key.defaultPrevented};
      });
      assert.deepEqual(editorEvents, {wheel: false, key: false}, 'Editing must retain its own interactions');
      await page.getByRole('button', {name: '阅读', exact: true}).click(); await waitFrames();
      assert.equal((await probe(kind, 'metrics')).scale, reset.scale, 'Editor events must not change reader scale');
      details.editorEvents = editorEvents;
      report.formatEvidence[name] = details; record(`${name}: ordinary wheel, batched pinch, trusted Ctrl/Cmd wheel, keyboard reset and editor isolation`, {});
      if (['sample.pdf', 'sample.docx', 'sample.html', 'sample.srt', 'sample.json'].includes(name)) await shot(`zoom-${name.replace('.', '-')}`);
    }
    if (formats.includes('sample.pdf') && (suites.includes('all') || suites.includes('pdf'))) {
      await selectFile('sample.pdf');
      await page.locator('.pdf-zoom-control .pdf-menu-button').click();
      await page.locator('.pdf-zoom-control [data-value="1"]').click();
      await page.waitForFunction(() => Number(document.querySelector('[data-pdf-scroll]').dataset.readerZoom) === 1);
      await page.waitForFunction(() => document.querySelector('.pdf-page-row[data-page-number="1"]')?.dataset.renderState === 'ready');
      // Wait for the explicit menu change to finish rasterizing before probing the gesture.
      await page.waitForFunction(() => {const canvas = document.querySelector('.pdf-page-column:not(.translated) canvas'); return canvas && Math.abs(canvas.getBoundingClientRect().width - canvas.width / devicePixelRatio) < 2;});
      await page.locator('[data-pdf-scroll]').evaluate(element => {element.scrollTop = 120; element.scrollLeft = 40;});
      await waitFrames();
      const before = await probe('pdf', 'anchor');
      const raster = await probe('pdf', 'wheel', {count: 10, delta: -20, point: before.point});
      assert.equal(raster.canvasesRetained, true, 'Immediate pinch must reuse the raster canvases');
      const after = await probe('pdf', 'anchor', {point: before.point});
      const drift = {x: Math.abs(after.x - before.x) * after.width, y: Math.abs(after.y - before.y) * after.height};
      assert(drift.x < 3 && drift.y < 3, `Pointer anchor drifted: ${JSON.stringify(drift)}`);
      await page.waitForFunction(width => document.querySelector('.pdf-page-column:not(.translated) canvas')?.width > width * 1.35, raster.rasterBefore[0].width);
      await page.waitForFunction(() => document.querySelector('.pdf-page-row[data-page-number="1"]')?.dataset.renderState === 'ready');
      await waitFrames();
      const settled = await page.locator('.pdf-page-column:not(.translated) canvas').first().evaluate(canvas => ({width: canvas.width, height: canvas.height, cssWidth: canvas.getBoundingClientRect().width, pixelRatio: devicePixelRatio, styleWidth: canvas.style.width, hostStyle: canvas.parentElement?.getAttribute('style')}));
      report.pdfEvidence = {before, after, drift, raster, settled};
      // The renderer supersamples up to 2x, with an aggregate page pixel budget;
      // devicePixelRatio is not a promise that every raster retains exactly 2x.
      assert(Math.abs(Number.parseFloat(settled.styleWidth) - settled.cssWidth) < 3, 'Settled canvas CSS width must match the displayed scale');
      assert.match(settled.hostStyle, /transform: scale\(1\)/u, 'After settling the host must stop scaling the previous raster');
      assert(settled.width > settled.cssWidth * 1.5, 'The settled sample must retain clear supersampled pixels within the page budget');
      const scrollBefore = await probe('pdf', 'scrollStart');
      assert(scrollBefore.scrollWidth > scrollBefore.clientWidth, 'Enlarged PDF must expose horizontal overflow');
      const rect = await page.locator('[data-pdf-scroll]').boundingBox();
      await cdp.send('Input.dispatchMouseEvent', {type: 'mouseWheel', x: rect.x + rect.width * .55, y: rect.y + 220, deltaX: 210, deltaY: 230});
      await page.waitForFunction(() => {const scroll = document.querySelector('[data-pdf-scroll]'); return scroll.scrollTop > 0 && scroll.scrollLeft > 0;});
      const scrollAfter = await probe('pdf', 'metrics');
      assert.equal(scrollAfter.scale, scrollBefore.scale, 'Ordinary pan must keep the document scale');
      record('PDF pointer anchor, immediate raster reuse, 160 ms settling raster and two-axis scrolling', {before, after, drift, raster, settled, scrollBefore, scrollAfter});
      await shot('pdf-enlarged-pan');
      await page.locator('.pdf-zoom-control .pdf-menu-button').click();
      await page.locator('.pdf-zoom-control [data-value="2"]').click();
      await page.waitForFunction(() => Number(document.querySelector('[data-pdf-scroll]').dataset.readerZoom) === 2);
      await page.getByRole('button', {name: '开始翻译', exact: true}).click();
      await page.locator('.document-status').filter({hasText: '翻译完成'}).waitFor();
      await page.locator('.pdf-page-column.translated .pdf-translation-block').first().waitFor();
      await page.locator('[data-pdf-scroll]').evaluate(scroll => {scroll.scrollLeft = scroll.scrollWidth - scroll.clientWidth - 30; scroll.scrollTop = 140;});
      await waitFrames();
      await shot('pdf-translated-200-percent');
    }
    if (suites.includes('all') || suites.includes('lifecycle')) {
      const richName = formats.find(name => kindFor(name) === 'rich');
      if (richName) {
        await selectFile(richName);
        const zoom = await probe('rich', 'wheel', {count: 10, delta: -20});
        const identity = await page.evaluate(() => {const frame = document.querySelector('.rich-preview-frame'); window.__zoomTestFrameDocument = frame.contentDocument; return frame.srcdoc;});
        await page.getByRole('button', {name: '开始翻译', exact: true}).click();
        await page.locator('.document-status').filter({hasText: '翻译完成'}).waitFor();
        const after = await probe('rich', 'metrics'); assert.equal(after.scale, zoom.after); assert.equal(after.contentZoom, zoom.after);
        const retained = await page.evaluate(expected => {const frame = document.querySelector('.rich-preview-frame'); const identitySame = frame.contentDocument === window.__zoomTestFrameDocument; delete window.__zoomTestFrameDocument; return {srcdocSame: frame.srcdoc === expected, identitySame, translated: frame.contentDocument.body.innerText.includes('测试译文')};}, identity);
        assert.deepEqual(retained, {srcdocSame: true, identitySame: true, translated: true}, 'Translation refresh must retain the iframe and scale');
        record(`${richName}: in-place translation refresh retains zoom and iframe`, {scale: zoom.after, after, retained, fixtureRequests: fixture.requests.length});
        await shot('rich-translated-zoom-retained');
      }
      if (formats.length > 1) {
        const firstName = formats.find(name => name !== 'sample.pdf') || formats[0];
        const otherName = formats.find(name => name !== firstName && name !== 'sample.pdf') || formats.find(name => name !== firstName);
        const kind = await selectFile(firstName);
        if (!await page.locator('aside.document-sidebar').isVisible()) await page.locator('.sidebar-toggle').click();
        const filesTab = page.locator('.sidebar-tabs [role="tab"]').filter({hasText: '文件'}); if (await filesTab.getAttribute('aria-selected') !== 'true') await filesTab.click();
        const switched = await probe(kind, 'switch', {name: otherName, count: 20, delta: -30});
        await page.locator('.workspace-heading h1').filter({hasText: otherName}).waitFor();
        const nextKind = await selectFile(otherName); await waitFrames();
        const scale = (await probe(nextKind, 'metrics')).scale;
        if (nextKind !== 'pdf') assert.equal(scale, 1, 'A pending gesture from the previous document must not alter the next document');
        record('Synchronous document switch cancels the pending wheel frame', {from: firstName, to: otherName, nextScale: scale, switched});
      }
    }
    if (suites.includes('all') || suites.includes('responsive')) {
      const responsiveEvidence = [];
      report.responsiveEvidence = responsiveEvidence;
      const visibleControls = () => page.evaluate(() => {
        const bar = document.querySelector('.document-taskbar');
        const controls = [...bar.querySelectorAll('button,.el-select__wrapper,.pdf-page-navigation input')]
          .filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && !element.closest('.taskbar-notices'))
          .map(element => {
            const rect = element.getBoundingClientRect();
            let horizontalScroller = null;
            for (let parent = element.parentElement; parent; parent = parent.parentElement) {
              if (/auto|scroll/u.test(getComputedStyle(parent).overflowX) && parent.scrollWidth > parent.clientWidth) {horizontalScroller = parent.className; break;}
              if (parent === bar) break;
            }
            return {name: element.getAttribute('aria-label') || element.textContent.trim() || element.className,
              x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height, horizontalScroller};
          });
        const overlaps = [];
        for (let index = 0; index < controls.length; index++) for (let next = index + 1; next < controls.length; next++) {
          const a = controls[index], b = controls[next];
          if (Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1) overlaps.push([a.name, b.name]);
        }
        return {width: innerWidth, bodyWidth: document.documentElement.scrollWidth, barHeight: bar.getBoundingClientRect().height,
          controls, overlaps,
          horizontallyScrollableControls: controls.filter(rect => (rect.x < -1 || rect.right > innerWidth + 1) && rect.horizontalScroller),
          outside: controls.filter(rect => ((rect.x < -1 || rect.right > innerWidth + 1) && !rect.horizontalScroller) || rect.y < -1 || rect.bottom > innerHeight + 1)};
      });
      const rowLayout = async kind => {
        const rows = await page.evaluate(() => {
          const bar = document.querySelector('.document-taskbar');
          const rect = element => {if (!element?.getClientRects().length) return null; const value = element.getBoundingClientRect(); return {x: value.x, y: value.y, right: value.right, bottom: value.bottom, width: value.width, height: value.height, centerY: value.y + value.height / 2};};
          const primary = Object.fromEntries([
            ['file', '.workspace-heading'], ['workspaceTabs', '.reader-tabs'], ['readingModes', '[aria-label="阅读方式"]'], ['focus', '.focus-toggle'],
            ['nativeZoom', '.document-zoom-control'],
          ].map(([name, selector]) => [name, rect(bar.querySelector(selector))]).filter(([, value]) => value));
          const pdfToolbar = bar.querySelector('.pdf-viewer-toolbar');
          return {bar: rect(bar), primary,
            pdfSlot: rect(bar.querySelector('.reader-controls-slot')),
            pdfGroups: pdfToolbar ? [...pdfToolbar.children].map(element => ({name: element.className, ...rect(element)})).filter(value => value.height) : [],
            actions: rect(bar.querySelector('.taskbar-actions'))};
        });
        assert(rows.primary.workspaceTabs && rows.primary.readingModes, 'Read/edit tabs and reading modes must both remain available');
        const sameCenter = (values, message) => {const centers = values.map(value => value.centerY); assert(Math.max(...centers) - Math.min(...centers) <= 3, `${message}: ${JSON.stringify(rows.primary)}`);};
        const compact = await page.evaluate(() => innerWidth < 1000);
        const firstRow = compact ? [rows.primary.file, rows.primary.workspaceTabs] : Object.values(rows.primary);
        sameCenter(firstRow, compact ? 'File and read/edit tabs must share the first row' : 'File, read/edit, reading modes and focus must share one row');
        const readingRow = compact ? [rows.primary.readingModes, rows.primary.focus, rows.primary.nativeZoom].filter(Boolean) : firstRow;
        if (compact) {
          sameCenter(readingRow, 'Reading modes, native zoom and focus must share a complete row');
          assert(Math.min(...readingRow.map(value => value.y)) >= Math.max(...firstRow.map(value => value.bottom)) - 1, 'The reading row must follow the file/tabs row');
        }
        if (kind === 'pdf') {
          assert(rows.pdfSlot && rows.pdfGroups.length, 'PDF controls must have their own complete row');
          if (compact) {
            const pageAndZoom = rows.pdfGroups.filter(value => /pdf-page-navigation|pdf-zoom-control/u.test(value.name));
            const displayAndTools = rows.pdfGroups.filter(value => !/pdf-page-navigation|pdf-zoom-control/u.test(value.name));
            sameCenter(pageAndZoom, 'PDF page navigation and zoom must stay together');
            if (displayAndTools.length) {
              sameCenter(displayAndTools, 'PDF presentation, search, style and highlighting must stay together');
              const firstCenter = pageAndZoom[0].centerY, secondCenter = displayAndTools[0].centerY;
              assert(Math.abs(firstCenter - secondCenter) <= 3 || Math.min(...displayAndTools.map(value => value.y)) >= Math.max(...pageAndZoom.map(value => value.bottom)) - 1, 'The two PDF control groups must form complete rows');
            }
          } else sameCenter(rows.pdfGroups, 'The complete PDF controls must not wrap inside their row');
          const primaryBottom = Math.max(...Object.values(rows.primary).map(value => value.bottom));
          assert(rows.pdfSlot.y >= primaryBottom - 1, 'The complete PDF row must follow the file/reading row');
          assert(rows.actions.y >= rows.pdfSlot.bottom - 1, 'Translation settings/actions must follow the complete PDF row');
          assert(rows.pdfSlot.x <= rows.bar.x + 24 && rows.pdfSlot.right >= rows.bar.right - 24, 'The PDF row must span the toolbar width');
        }
        return rows;
      };
      const menuInside = async selector => {
        await waitFrames();
        const result = await page.locator(selector).evaluate(menu => {const rect = menu.getBoundingClientRect(); const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.bottom - Math.min(6, rect.height / 2)); return {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, bottomReachable: Boolean(hit && (hit === menu || menu.contains(hit)))};});
        assert(result.left >= -1 && result.right <= result.viewportWidth + 1 && result.top >= -1 && result.bottom <= result.viewportHeight + 1, `Menu must remain inside the viewport: ${JSON.stringify(result)}`);
        assert(result.bottomReachable, `A functional row must not clip the menu below its bounds: ${JSON.stringify(result)}`);
        return result;
      };
      for (const name of formats.filter(name => ['sample.pdf', 'sample.docx'].includes(name))) {
        await page.setViewportSize({width: 1440, height: 960});
        const kind = await selectFile(name);
        if (await page.locator('.sidebar-toggle').getAttribute('aria-expanded') === 'true') await page.locator('.sidebar-toggle').click();
        // A bounded local response keeps pause visible long enough to interact.
        const start = page.locator('.taskbar-actions .translate-document-button');
        if (await start.count()) {
          fixture.state.delay = 400;
          await start.click(); await page.locator('.taskbar-actions .pause-button').waitFor();
          await page.setViewportSize({width: 390, height: 844}); await waitFrames();
          const pausedLayout = await visibleControls();
          assert(pausedLayout.bodyWidth <= 390, `Body overflow in paused layout: ${pausedLayout.bodyWidth}`);
          assert.equal(pausedLayout.overlaps.length, 0, JSON.stringify(pausedLayout.overlaps));
          assert.equal(pausedLayout.outside.length, 0, JSON.stringify(pausedLayout.outside));
          pausedLayout.rows = await rowLayout(kind);
          await shot(`responsive-${name.replace('.', '-')}-390-translating`);
          await page.locator('.taskbar-actions .pause-button').click();
          await page.locator('.taskbar-actions .translate-document-button').waitFor();
          fixture.state.delay = 0;
          await page.locator('.taskbar-actions .translate-document-button').click();
          await page.locator('.document-status').filter({hasText: '翻译完成'}).waitFor({state: 'attached'});
          responsiveEvidence.push({name, state: 'translating', ...pausedLayout, pauseReached: true});
        }
        for (const width of extremeOnly ? [] : [1024, 820, 640, 390]) {
          await page.setViewportSize({width, height: width < 640 ? 844 : 960}); await waitFrames();
          const layout = await visibleControls();
          assert(layout.bodyWidth <= width, `Body overflow at ${width}px: ${layout.bodyWidth}`);
          assert.equal(layout.overlaps.length, 0, `Controls overlap at ${width}px: ${JSON.stringify(layout.overlaps)}`);
          assert.equal(layout.outside.length, 0, `Controls are clipped at ${width}px: ${JSON.stringify(layout.outside)}`);
          layout.rows = await rowLayout(kind);
          await page.getByRole('button', {name: '校订译文', exact: true}).click();
          await page.locator('textarea.document-translation').first().waitFor();
          await page.getByRole('button', {name: '阅读', exact: true}).click(); await waitFrames();
          const menus = {};
          if (kind === 'pdf') {
            await page.locator('.pdf-zoom-control .pdf-menu-button').click();
            menus.zoom = await menuInside('.pdf-zoom-control .pdf-menu-list');
            await page.locator('.pdf-zoom-control [data-value="1.5"]').click();
            await page.locator('.pdf-presentation-control .pdf-menu-button').click();
            menus.presentation = await menuInside('.pdf-presentation-control .pdf-menu-list');
            await page.locator('.pdf-presentation-control [data-value="layout"]').click();
          } else {
            const zoom = page.locator('.document-zoom-control');
            await zoom.getByRole('button', {name: '放大', exact: true}).click();
            await zoom.locator('[data-document-zoom]').click();
            assert.equal((await probe(kind, 'metrics')).scale, 1);
          }
          let language = page.locator('.toolbar-language .el-select__wrapper');
          const compactSettings = !await language.isVisible();
          if (compactSettings) {
            await page.locator('.toolbar-settings-toggle').click();
            await page.locator('.document-settings-dialog[open]').waitFor();
            assert.equal(await page.getByRole('combobox', {name: '文档翻译服务', exact: true}).isVisible(), true, 'Compact toolbar must retain translation service settings');
            assert.equal(await page.getByRole('combobox', {name: '文档翻译模型', exact: true}).isVisible(), true, 'Compact toolbar must retain model settings');
            language = page.locator('.document-settings-dialog[open] .el-select__wrapper').filter({has: page.getByRole('combobox', {name: '文档目标语言', exact: true})});
          }
          await language.click();
          // Element Plus positions its popper against the viewport; choose the
          // current language so this interaction does not invalidate translations.
          const visibleList = page.locator('.el-select-dropdown').filter({visible: true}).last();
          menus.language = await menuInside('.el-select-dropdown:visible');
          await visibleList.getByRole('option', {name: /^简体中文(?: \/ Simplified Chinese)?$/u}).click();
          if (compactSettings) await page.locator('.document-settings-dialog[open]').getByRole('button', {name: '返回文档', exact: true}).click();
          await page.locator('.taskbar-actions .download-button').click();
          const dialog = page.locator('.download-dialog[open]'); await dialog.waitFor();
          const dialogBounds = await dialog.boundingBox();
          assert(dialogBounds.x >= -1 && dialogBounds.x + dialogBounds.width <= width + 1, `Download dialog clipped at ${width}px`);
          await dialog.getByRole('button', {name: '返回文档', exact: true}).click();
          await shot(`responsive-${name.replace('.', '-')}-${width}`);
          responsiveEvidence.push({name, state: 'translated', ...layout, menus, workspaceTabsReached: true, zoomReached: true, downloadReached: true});
        }
        if (kind === 'pdf' && !extremeOnly) {
          await page.setViewportSize({width: 820, height: 480}); await waitFrames();
          const menus = {};
          await page.locator('.pdf-zoom-control .pdf-menu-button').click();
          menus.zoom = await menuInside('.pdf-zoom-control .pdf-menu-list');
          await shot('responsive-pdf-820x480-zoom-menu');
          await page.locator('.pdf-zoom-control [data-value="1.25"]').click();
          await page.locator('.pdf-presentation-control .pdf-menu-button').click();
          menus.presentation = await menuInside('.pdf-presentation-control .pdf-menu-list');
          await page.locator('.pdf-presentation-control [data-value="layout"]').click();
          for (const type of ['search', 'style']) {
            const button = page.locator(`.pdf-${type} > .pdf-tool-button`);
            if (await button.isVisible()) {
              await button.click(); menus[type] = await menuInside(`.pdf-${type}-panel`);
              if (type === 'search') await page.locator('.pdf-search-panel input').fill('document');
              else await page.locator('.pdf-style-fonts button').first().click();
              await shot(`responsive-pdf-820x480-${type}-panel`);
              await page.keyboard.press('Escape');
            } else menus[type] = {visible: false, reason: 'Compact toolbar hides this secondary control'};
          }
          await shot('responsive-pdf-820x480-popovers');
          responsiveEvidence.push({name, state: 'low-height-popovers', width: 820, height: 480, menus});
        }
        await page.setViewportSize({width: 390, height: 320}); await waitFrames();
        const paneMetrics = () => page.evaluate(() => {const rect = document.querySelector('.document-reading-pane').getBoundingClientRect(); return {width: innerWidth, height: innerHeight, bodyWidth: document.documentElement.scrollWidth, pane: {x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom}};});
        const closedGeometry = await paneMetrics();
        for (const open of [true, false]) {
          if ((await page.locator('.sidebar-toggle').getAttribute('aria-expanded') === 'true') !== open) await page.locator('.sidebar-toggle').click();
          await waitFrames();
          const geometry = await paneMetrics();
          assert(geometry.bodyWidth <= 390, `Extreme-height sidebar must not create horizontal overflow: ${geometry.bodyWidth}`);
          assert(geometry.pane.height >= 60 && geometry.pane.bottom <= 321, `Sidebar must leave readable document space at 390x320: ${JSON.stringify(geometry)}`);
          assert(Math.abs(geometry.pane.height - closedGeometry.pane.height) < 1, 'Extreme-height sidebar must overlay rather than consume reader space');
          assert.equal(await page.locator('aside.document-sidebar').isVisible(), open, 'Sidebar must remain operable at very low height');
          await shot(`responsive-${name.replace('.', '-')}-390x320-sidebar-${open ? 'open' : 'closed'}`);
          responsiveEvidence.push({name, state: 'extreme-height-sidebar', sidebarOpen: open, ...geometry});
        }
        const menus = {};
        if (kind === 'pdf') {
          await page.locator('.pdf-zoom-control .pdf-menu-button').click();
          menus.zoom = await menuInside('.pdf-zoom-control .pdf-menu-list');
          await shot('responsive-pdf-390x320-zoom-menu');
          await page.locator('.pdf-zoom-control [data-value="1.5"]').click();
          await page.locator('.pdf-presentation-control .pdf-menu-button').click();
          menus.presentation = await menuInside('.pdf-presentation-control .pdf-menu-list');
          await page.locator('.pdf-presentation-control [data-value="layout"]').click();
        }
        await page.locator('.toolbar-settings-toggle').click();
        const settings = page.locator('.document-settings-dialog[open]'); await settings.waitFor();
        menus.settingsDialog = await menuInside('.document-settings-dialog[open]');
        await settings.getByRole('button', {name: '返回文档', exact: true}).click();
        await page.locator('.taskbar-actions .download-button').click();
        await page.locator('.download-dialog[open]').waitFor();
        menus.downloadDialog = await menuInside('.download-dialog[open]');
        await page.locator('.download-dialog[open]').getByRole('button', {name: '返回文档', exact: true}).click();
        responsiveEvidence.push({name, state: 'extreme-height-dialogs', width: 390, height: 320, menus});
      }
      if (responsiveEvidence.length) record('PDF and Word responsive toolbar: pause, read/edit, zoom, settings, menus and download', {viewports: extremeOnly ? ['390x320'] : ['1024x960', '820x960', '640x960', '390x844', '820x480', '390x320'], formats: formats.filter(name => ['sample.pdf', 'sample.docx'].includes(name))});
      await page.setViewportSize({width: 1440, height: 960});
    }
    report.finalBrowserScale = await browserScale();
    report.fixtureProtocol = {batchRequests: fixture.requests.filter(source => source.includes('___FLUENTREAD_')).length, singleRequests: fixture.requests.filter(source => !source.includes('___FLUENTREAD_')).length};
    const frontmost = await queryMacFrontmostApplication();
    assert(frontmost, 'Frontmost application must remain readable');
    assert.notEqual(frontmost.pid, await getGuardedBrowserPid(launched), 'The test browser must not take foreground focus');
    report.finalFrontmostApplication = frontmost;
    assert.equal(report.consoleErrors.length, 0, JSON.stringify(report.consoleErrors));
    report.ok = true;
  } catch (error) {
    report.failure = error.stack || String(error);
    if (page) {
      report.visibleUi = await page.evaluate(() => ({title: document.querySelector('.workspace-heading h1')?.textContent, dialogs: [...document.querySelectorAll('dialog[open]')].map(dialog => dialog.innerText), zoom: [...document.querySelectorAll('[data-reader-zoom]')].map(node => ({className: node.className, zoom: node.dataset.readerZoom}))})).catch(() => ({}));
      await page.screenshot({path: path.join(artifactsDir, 'failure.png')}).catch(() => {});
    }
    throw error;
  } finally {
    await cdp?.detach().catch(() => {});
    let closed = false;
    if (launched) {try {await launched.close(); closed = true;} catch (error) {report.cleanupErrors.push(`browser close: ${error.stack || error}`);}}
    try {await fixture?.close();} catch (error) {report.cleanupErrors.push(`fixture close: ${error.message}`);}
    if (closed) {try {fs.rmSync(profileDir, {recursive: true, force: true});} catch (error) {report.cleanupErrors.push(`profile removal: ${error.message}`); report.retainedProfile = profileDir;}}
    else if (!launchAttempted) {try {fs.rmdirSync(profileDir);} catch (error) {report.retainedProfile = profileDir;}}
    else report.retainedProfile = profileDir;
    if (report.cleanupErrors.length) {report.ok = false; process.exitCode = 1;}
    fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ok: report.ok, report: path.join(artifactsDir, 'report.json'), cases: report.cases.length, formats, failure: report.failure, cleanupErrors: report.cleanupErrors}));
  }
}

main().catch(error => {console.error(error.stack || error); process.exitCode = 1;});
