#!/usr/bin/env node
/**
 * @file scripts/testing/run-github-nested-list-test.cjs
 * Reproduce GitHub README nested-list ownership and verify one bilingual wrapper per list line.
 * Use the production extension, a local GitHub-shaped fixture and a deterministic provider in a
 * temporary, focus-safe Edge. Cover hover, full-page translation, restore and retranslation.
 */
const assert = require('node:assert/strict');
const {guardBrowserClose} = require('./owned-browser-close.cjs');
const {controlledProviderRuntime} = require('../site-translation/controlled-provider.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {createRequire} = require('node:module');
const {assertFreshProductionExtension} = require('../run-site-translation-test.cjs');

const root = path.resolve(__dirname, '../..');
const args = {focusSafeHelper: path.join(__dirname, 'focus-safe-browser.cjs'), timeout: 30000};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (key === '--background') continue;
  assert.ok(key.startsWith('--') && process.argv[i + 1], `Invalid argument ${key}`);
  args[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = process.argv[++i];
}
for (const key of ['extensionDir', 'playwrightRoot', 'focusSafeHelper', 'artifactsDir']) {
  assert.ok(args[key], `Missing ${key}`); args[key] = path.resolve(args[key]);
}
args.timeout = Number(args.timeout);
const helper = require(args.focusSafeHelper);
const {chromium} = createRequire(path.join(args.playwrightRoot, 'github-nested-list.cjs'))('playwright');
const owned = '.fluent-read-bilingual-content';
const url = 'https://github.com/linuxscreen/duo-translator';
const sourceIds = ['shortcut-item', 'selection-popup-item', 'extension-popup-item'];
const translatedIds = ['features-heading', 'customization-label', ...sourceIds];
const report = {
  scope: 'local-GitHub-nested-README-list-fixture',
  provider: 'microsoft-local-deterministic-response',
  profileMode: 'new-temporary-profile',
  baseline: false,
  cases: [],
  errors: [],
};
fs.mkdirSync(args.artifactsDir, {recursive: true});
const save = () => fs.writeFileSync(
  path.join(args.artifactsDir, 'report.json'),
  JSON.stringify(report, null, 2),
);

async function main() {
  assertFreshProductionExtension(args.extensionDir, root);
  report.contentSha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(args.extensionDir, 'content-scripts/content.js')))
    .digest('hex');

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-github-nested-list-'));
  let session, primaryError;
  let context;
  let worker;
  let popup;
  let page;
  let sequence = 0;
  const installedWorkers = new WeakMap();
  const installWorker = current => {
    if (!installedWorkers.has(current)) installedWorkers.set(current, current.evaluate(controlledProviderRuntime, true).then(() => current.evaluate(() => {
      globalThis.nestedListRequests = [];
      globalThis.failNestedListRequests = false;
      globalThis.fetch = async (input, init) => {
        const requestUrl = new URL(typeof input === 'string' || input instanceof URL
          ? String(input) : input.url);
        if (requestUrl.hostname !== 'edge.microsoft.com' || requestUrl.pathname !== '/translate/translatetext') {
          throw Error('External fetch disabled');
        }
        const texts = JSON.parse(init?.body ?? await input.text());
        globalThis.nestedListRequests.push(texts);
        if (globalThis.failNestedListRequests) return new Response('', {status: 503});
        return new Response(JSON.stringify(texts.map(text => ({translations: [{text: globalThis.__frCompatibilityTransport.encode(text, 'microsoft-escaped-text')}]}))), {
          status: 200,
          headers: {'content-type': 'application/json'},
        });
      };
    })));
    return installedWorkers.get(current);
  };
  const patchConfig = async updates => {
    const result = await popup.evaluate(async ({updates, sequence}) => {
      const read = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      const current = typeof read.value === 'string' ? JSON.parse(read.value) : read.value;
      return chrome.runtime.sendMessage({
        type: 'persistConfig',
        mode: 'patch',
        config: updates,
        expected: Object.fromEntries(Object.keys(updates).map(key => [key, current[key]])),
        clientId: 'github-nested-list',
        sequence,
        baseRevision: current.__fluentConfigRevision,
      });
    }, {updates, sequence: ++sequence});
    assert.equal(result.success, true, JSON.stringify(result));
  };
  const waitCount = (selector, expected) => page.waitForFunction(
    ({selector, expected}) => document.querySelectorAll(selector).length === expected,
    {selector, expected},
    {timeout: args.timeout},
  );
  const full = async () => {
    await helper.activateExtensionTabWithoutForeground(context, page);
    await page.keyboard.down('Alt');
    await page.keyboard.press('t');
    await page.keyboard.up('Alt');
  };
  const hover = async selector => {
    await helper.activateExtensionTabWithoutForeground(context, page);
    const box = await page.locator(selector).boundingBox();
    assert.ok(box, `No bounding box for ${selector}`);
    await page.mouse.move(box.x + 15, box.y + 8);
    await page.keyboard.down('Control');
    await page.keyboard.up('Control');
  };
  const state = () => page.evaluate(({owned, sourceIds, translatedIds}) => {
    const byId = id => document.querySelector(`[data-testid="${id}"]`);
    const directOwned = element => [...element.children].filter(child => child.matches(owned)).length;
    return {
      total: document.querySelectorAll(owned).length,
      outerDirect: directOwned(byId('customization-item')),
      source: Object.fromEntries(sourceIds.map(id => [id, byId(id).querySelectorAll(owned).length])),
      translated: Object.fromEntries(translatedIds.map(id => [id, byId(id).querySelectorAll(owned).length])),
      nested: document.querySelectorAll(`${owned} ${owned}`).length,
    };
  }, {owned, sourceIds, translatedIds});
  const assertListGranularity = actual => {
    assert.equal(actual.outerDirect, 0, 'outer nested list item must not own one combined wrapper');
    assert.equal(actual.nested, 0, 'translated wrappers must not be nested');
  };

  try {
    session = await helper.launchFocusSafePersistentContext({
      chromium,
      profileDir,
      browserPath: args.browserPath || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      background: true,
      headless: false,
      viewport: {width: 1280, height: 900},
      displayTarget: 'secondary',
      timeout: args.timeout,
      browserArgs: [
        `--disable-extensions-except=${args.extensionDir}`,
        `--load-extension=${args.extensionDir}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    guardBrowserClose(session, profileDir);
    context = session.context;
    Object.assign(report, {
      launchMode: session.launchMode,
      focusPolicy: session.focusPolicy,
      windowPlacement: session.windowPlacement,
    });
    assert.equal(report.launchMode, 'macos-background-cdp');
    assert.equal(report.focusPolicy, 'launchservices-no-foreground');
    assert.equal(report.windowPlacement.mode, 'background-visible-no-focus');
    assert.equal(report.windowPlacement.browserFrontmost, false);

    context.on('serviceworker', current => { void installWorker(current).catch(error => report.errors.push(error.message)); });
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await installWorker(worker);
    const fixture = fs.readFileSync(path.join(root, 'tests/fixtures/translation-pages/github-nested-list.html'), 'utf8');
    await context.route('**/*', route => {
      if (route.request().isNavigationRequest() && route.request().url() === url) {
        return route.fulfill({status: 200, contentType: 'text/html', body: fixture});
      }
      if (/^https?:/u.test(route.request().url())) return route.abort('blockedbyclient');
      return route.continue();
    });

    popup = await helper.newPageWithoutForeground(context, args.timeout);
    await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    await popup.waitForTimeout(600);
    await patchConfig({
      service: 'microsoft',
      from: 'en',
      to: 'zh-Hans',
      display: 1,
      style: 1,
      autoTranslate: false,
      hotkey: 'Control',
      floatingBallHotkey: 'Alt+T',
      mouseHoverTranslationDelay: 0,
      fullPageTranslationMode: 'all',
      useCache: false,
      enableAIContext: false,
      enableAIMultiSegment: false,
      uiLanguageSetupCompleted: true,
    });

    page = await helper.newPageWithoutForeground(context, args.timeout);
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(url);
    await page.waitForSelector('#fluent-read-page-styles', {state: 'attached'});
    await page.waitForTimeout(600);
    const original = await page.locator('main').innerHTML();
    const sourceTexts = await page.evaluate(ids => Object.fromEntries(ids.map(id => [
      id,
      document.querySelector(`[data-testid="${id}"]`).textContent.trim(),
    ])), sourceIds);
    const result = {before: await state(), hover: null, full: null, restored: null, retranslated: null};
    report.cases.push(result);
    await page.screenshot({path: path.join(args.artifactsDir, 'before.png')});

    await hover('[data-testid="shortcut-item"]');
    await waitCount('[data-testid="shortcut-item"] ' + owned, 1);
    result.hover = await state();
    assertListGranularity(result.hover);
    assert.equal(result.hover.source['selection-popup-item'], 0);
    assert.equal(result.hover.source['extension-popup-item'], 0);
    await hover('[data-testid="shortcut-item"]');
    await waitCount(owned, 0);
    assert.equal(await page.locator('main').innerHTML(), original);

    await full();
    await waitCount(owned, translatedIds.length);
    await waitCount('.fluent-read-loading', 0);
    result.full = await state();
    assertListGranularity(result.full);
    for (const id of translatedIds) assert.equal(result.full.translated[id], 1, `${id} must have one wrapper`);
    const requests = await worker.evaluate(() => globalThis.nestedListRequests.flat());
    for (const id of sourceIds) {
      assert.ok(requests.some(request => String(request).includes(sourceTexts[id])), `${id} was not sent independently`);
    }
    assert.equal(requests.some(request => sourceIds.filter(id => String(request).includes(sourceTexts[id])).length > 1), false);
    await page.screenshot({path: path.join(args.artifactsDir, 'translated.png')});

    await full();
    await waitCount(owned, 0);
    await page.waitForTimeout(200);
    result.restored = await state();
    assert.deepEqual(result.restored, result.before);
    assert.equal(await page.locator('main').innerHTML(), original);

    await full();
    await waitCount(owned, translatedIds.length);
    await waitCount('.fluent-read-loading', 0);
    result.retranslated = await state();
    assertListGranularity(result.retranslated);
    for (const id of translatedIds) assert.equal(result.retranslated.translated[id], 1, `${id} must retranslate once`);
    await page.screenshot({path: path.join(args.artifactsDir, 'retranslated.png')});
    assert.equal(page.url(), url);
    result.passed = true;
    await page.close();
    page = null;
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    primaryError = error;
    report.error = error.stack;
    if (page) await page.screenshot({path: path.join(args.artifactsDir, 'failure.png')}).catch(() => {});
    throw error;
  } finally {
    const cleanupErrors = [];
    const cleanup = async (resource, release) => {
      try {await release();} catch (error) {
        cleanupErrors.push(error);
        (report.cleanupErrors ||= []).push({resource, error: String(error.stack || error)});
        report.passed = false;
        if (resource === 'profile') report.retainedProfile = profileDir;
      }
    };
    let browserClosed = false;
    await cleanup('browser', async () => {
      if (session) {await session.close(); browserClosed = true;}
    });
    await cleanup('profile', () => {
      if (browserClosed) fs.rmSync(profileDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
      else report.retainedProfile = profileDir;
    });
    await cleanup('report', () => {save();});
    if (report.retainedProfile) process.stderr.write(`Unconfirmed browser/profile cleanup; retained profile: ${profileDir}\n`);
    for (const error of cleanupErrors) process.stderr.write(`Cleanup failed: ${error.stack || error}\n`);
    if (cleanupErrors.length && !primaryError) throw cleanupErrors[0];
  }
  console.log(JSON.stringify({passed: report.passed, cases: report.cases, artifacts: args.artifactsDir}));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
