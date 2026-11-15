#!/usr/bin/env node
/**
 * @file scripts/testing/run-github-spacing-test.cjs
 * Reproduce GitHub ListView's padded empty badge creating a blank line after bilingual titles.
 * Use a production extension, local domain fixture and deterministic provider in a temporary,
 * focus-safe Edge. Inspect geometry, title/metadata ownership, restore, remount and retry.
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
  if (key === '--expect-regression') { args.expectRegression = true; continue; }
  assert.ok(key.startsWith('--') && process.argv[i + 1], `Invalid argument ${key}`);
  args[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = process.argv[++i];
}
for (const key of ['extensionDir', 'playwrightRoot', 'focusSafeHelper', 'artifactsDir']) {
  assert.ok(args[key], `Missing ${key}`); args[key] = path.resolve(args[key]);
}
args.timeout = Number(args.timeout);
const helper = require(args.focusSafeHelper);
const {chromium} = createRequire(path.join(args.playwrightRoot, 'github-spacing.cjs'))('playwright');
const owned = '.fluent-read-bilingual-content';
const url = 'https://github.com/FluentRead/FluentRead/pulls';
const report = {scope: 'local-GitHub-ListView-fixture', provider: 'microsoft-local-deterministic-response',
  profileMode: 'new-temporary-profile', baseline: !!args.expectRegression, cases: [], errors: []};
fs.mkdirSync(args.artifactsDir, {recursive: true});
const save = () => fs.writeFileSync(path.join(args.artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
async function main() {
  if (!args.expectRegression) assertFreshProductionExtension(args.extensionDir, root);
  report.contentSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(args.extensionDir, 'content-scripts/content.js'))).digest('hex');
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-github-spacing-'));
  let session, context, worker, popup, page, primaryError, sequence = 0;
  const installedWorkers = new WeakMap();
  const installWorker = current => {
    if (!installedWorkers.has(current)) installedWorkers.set(current, current.evaluate(controlledProviderRuntime, true).then(() => current.evaluate(() => {
      globalThis.spacingRequests = []; globalThis.failSpacingRequests = false;
      globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
        if (url.hostname !== 'edge.microsoft.com' || url.pathname !== '/translate/translatetext') throw Error('External fetch disabled');
        const texts = JSON.parse(init?.body ?? await input.text()); globalThis.spacingRequests.push(texts);
        if (globalThis.failSpacingRequests) return new Response('', {status: 503});
        return new Response(JSON.stringify(texts.map(text => ({translations: [{text:
          /translate hovered visual text blocks/.test(text) ? '修复：翻译悬停的视觉文本块' : globalThis.__frCompatibilityTransport.encode(text, 'microsoft-escaped-text')}]}))),
        {status: 200, headers: {'content-type': 'application/json'}});
      };
    })));
    return installedWorkers.get(current);
  };
  const patchConfig = async updates => {
    const result = await popup.evaluate(async ({updates, sequence}) => {
      const read = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      const c = typeof read.value === 'string' ? JSON.parse(read.value) : read.value;
      return chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: updates,
        expected: Object.fromEntries(Object.keys(updates).map(k => [k, c[k]])),
        clientId: 'github-spacing', sequence, baseRevision: c.__fluentConfigRevision});
    }, {updates, sequence: ++sequence});
    assert.equal(result.success, true, JSON.stringify(result));
  };
  const waitCount = (selector, expected) => page.waitForFunction(({selector, expected}) => document.querySelectorAll(selector).length === expected,
    {selector, expected}, {timeout: args.timeout});
  const full = async () => {
    await helper.activateExtensionTabWithoutForeground(context, page);
    await page.keyboard.down('Alt'); await page.keyboard.press('t'); await page.keyboard.up('Alt');
  };
  const hover = async selector => {
    await helper.activateExtensionTabWithoutForeground(context, page);
    const box = await page.locator(selector).boundingBox(); assert.ok(box);
    // Mouse movement + a real Control gesture, without following the title's link.
    await page.mouse.move(box.x + 15, box.y + 8);
    await page.keyboard.down('Control'); await page.keyboard.up('Control');
  };
  const geometry = () => page.evaluate(owned => ['empty', 'badge', 'issue'].map(id => {
    const row = document.getElementById(`${id}-row`), heading = row.querySelector('h3');
    const translation = heading.querySelector(owned), metadata = row.querySelector('.main-content');
    const badge = row.querySelector('.badge');
    return {id, rowHeight: row.getBoundingClientRect().height, headingDisplay: getComputedStyle(heading).display,
      gap: translation ? metadata.getBoundingClientRect().top - translation.getBoundingClientRect().bottom : null,
      // A real badge may wrap below a long narrow title; its visible row is not blank space.
      blankGap: translation ? metadata.getBoundingClientRect().top - Math.max(translation.getBoundingClientRect().bottom,
        badge?.getBoundingClientRect().bottom ?? 0) : null,
      badgeVisible: !badge || (badge.getBoundingClientRect().width > 0 && badge.getBoundingClientRect().height > 0),
      overflow: row.scrollWidth > row.clientWidth + 1};
  }), owned);
  const assertGeometry = rows => {
    for (const row of rows) {
      assert.ok(row.blankGap >= 0 && row.blankGap <= 16, `${row.id}: unwanted blank gap ${row.blankGap}px`);
      assert.ok(row.badgeVisible); assert.equal(row.overflow, false);
    }
  };
  try {
    session = await helper.launchFocusSafePersistentContext({chromium, profileDir,
      browserPath: args.browserPath || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', background: true,
      headless: false, viewport: {width: 1280, height: 900}, displayTarget: 'secondary', timeout: args.timeout,
      browserArgs: [`--disable-extensions-except=${args.extensionDir}`, `--load-extension=${args.extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    guardBrowserClose(session, profileDir);
    context = session.context;
    Object.assign(report, {launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement});
    assert.equal(report.launchMode, 'macos-background-cdp'); assert.equal(report.focusPolicy, 'launchservices-no-foreground');
    assert.equal(report.windowPlacement.mode, 'background-visible-no-focus'); assert.equal(report.windowPlacement.browserFrontmost, false);
    context.on('serviceworker', current => { void installWorker(current).catch(e => report.errors.push(e.message)); });
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); await installWorker(worker);
    const fixture = fs.readFileSync(path.join(root, 'tests/fixtures/translation-pages/github-list-spacing.html'), 'utf8');
    await context.route('**/*', route => {
      if (route.request().isNavigationRequest() && route.request().url() === url) return route.fulfill({status: 200, contentType: 'text/html', body: fixture});
      if (/^https?:/.test(route.request().url())) return route.abort('blockedbyclient');
      return route.continue();
    });
    popup = await helper.newPageWithoutForeground(context, args.timeout);
    await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`); await popup.waitForTimeout(600);
    report.config = {service: 'microsoft', from: 'en', to: 'zh-Hans', display: 1, style: 1, autoTranslate: false,
      hotkey: 'Control', floatingBallHotkey: 'Alt+T', mouseHoverTranslationDelay: 0, fullPageTranslationMode: 'all',
      useCache: false, enableAIContext: false, enableAIMultiSegment: false, uiLanguageSetupCompleted: true};
    await patchConfig(report.config);
    for (const width of args.expectRegression ? [1150] : [1150, 360]) {
      page = await helper.newPageWithoutForeground(context, args.timeout);
      page.on('pageerror', e => report.errors.push(e.message));
      await page.goto(url); await page.waitForSelector('#fluent-read-page-styles', {state: 'attached'}); await page.waitForTimeout(600);
      // Resize only the fixture's main content, keeping the safe browser window placement intact.
      await page.locator('main').evaluate((el, width) => { el.style.width = `${width}px`; }, width);
      await page.evaluate(() => {
        window.spacingSourceNodes = [...document.querySelector('main').querySelectorAll('*')];
        window.spacingClicks = 0; document.getElementById('checks').addEventListener('click', () => window.spacingClicks++);
      });
      const original = await page.locator('main').innerHTML();
      const result = {width, before: await geometry(), hoverCounts: []}; report.cases.push(result);
      await page.screenshot({path: path.join(args.artifactsDir, `${width}-before.png`)});
      if (!args.expectRegression) {
        for (const expected of [1, 0, 1]) {
          await hover('#empty-title'); await waitCount(`#empty-title ${owned}`, expected);
          result.hoverCounts.push(await page.locator(`#empty-title ${owned}`).count());
          assert.equal(await page.locator(`#badge-title ${owned}, #neighbor ${owned}`).count(), 0);
        }
        await hover('#empty-title'); await waitCount(owned, 0);
        assert.equal(await page.locator('main').innerHTML(), original);
      }
      await full(); await waitCount(`#empty-row h3 ${owned}`, 1); await waitCount(`#issue-title ${owned}`, 1);
      await waitCount(`#legacy-title ${owned}`, 1); await waitCount(`#prose ${owned}`, 1); await waitCount('.fluent-read-loading', 0);
      result.translated = await geometry(); await page.screenshot({path: path.join(args.artifactsDir, `${width}-translated.png`)});
      if (args.expectRegression) {
        assert.ok(result.translated[0].gap >= 30, `Expected old blank line: ${JSON.stringify(result.translated)}`);
        assert.ok(await page.locator(`#empty-meta ${owned}`).count()); report.reproduced = true; break;
      }
      assertGeometry(result.translated);
      assert.equal(await page.locator(`#empty-meta ${owned}, #badge-meta ${owned}, .badge ${owned}, #code ${owned}`).count(), 0);
      assert.equal(await page.locator(`${owned} ${owned}`).count(), 0);
      assert.equal(await page.evaluate(() => window.spacingSourceNodes.every(el => el.isConnected)), true);
      await page.locator('#checks').click(); assert.equal(await page.evaluate(() => window.spacingClicks), 1);
      await page.evaluate(() => { document.querySelector('#empty-meta relative-time').textContent = '2 months ago'; });
      await page.waitForTimeout(400);
      const requests = await worker.evaluate(() => globalThis.spacingRequests.flat());
      assert.equal(requests.some(text => /example-author|opened|Updated|1\/1/.test(text)), false);
      await full(); await waitCount(owned, 0); await page.waitForTimeout(200);
      assert.equal(await page.locator('main').innerHTML(), original.replace('last month</relative-time>', '2 months ago</relative-time>'));
      result.restored = await geometry(); assert.deepEqual(result.restored, result.before);
      await full(); await waitCount(`#empty-title ${owned}`, 1); await waitCount(`#issue-title ${owned}`, 1); await waitCount(`#badge-title ${owned}`, 1);
      await waitCount('.fluent-read-loading', 0); assertGeometry(await geometry());
      // GitHub may clone/remount a translated row. It must keep one wrapper and remain restorable.
      await page.locator('#empty-row').evaluate(row => row.replaceWith(row.cloneNode(true)));
      await page.waitForTimeout(800); await waitCount(`#empty-title ${owned}`, 1); assertGeometry(await geometry());
      await full(); await waitCount(owned, 0);
      if (width === 1150) {
        await worker.evaluate(() => { globalThis.failSpacingRequests = true; });
        await hover('#empty-title'); await waitCount('#empty-title .fluent-read-retry-wrapper', 1);
        assert.equal(await page.locator('#empty-row h3').evaluate(el => getComputedStyle(el).display), 'inline');
        await worker.evaluate(() => { globalThis.failSpacingRequests = false; });
        await page.locator('#empty-title .fluent-read-retry').click(); await waitCount(`#empty-title ${owned}`, 1);
        const retryGeometry = await geometry(); assert.ok(retryGeometry[0].gap <= 16); result.retry = retryGeometry[0];
        await hover('#empty-title'); await waitCount(owned, 0);
      }
      assert.equal(page.url(), url); result.passed = true; await page.close(); page = null; save();
    }
    assert.deepEqual(report.errors, []); report.passed = true;
  } catch (error) {
    primaryError = error;
    report.error = error.stack;
    if (page) { report.failureGeometry = await geometry().catch(() => null); await page.screenshot({path: path.join(args.artifactsDir, 'failure.png')}).catch(() => {}); }
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
  console.log(JSON.stringify({passed: report.passed, reproduced: report.reproduced, cases: report.cases, artifacts: args.artifactsDir}));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
