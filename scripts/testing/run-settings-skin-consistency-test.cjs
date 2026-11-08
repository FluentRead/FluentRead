#!/usr/bin/env node
'use strict';

/**
 * @file scripts/testing/run-settings-skin-consistency-test.cjs
 * 文件职责：定向验收生产设置界面的语义提示色、皮肤卡片一致性与内嵌折叠键盘焦点。
 * 主要内容：从真实皮肤选择器读取全部选项，逐皮肤、亮暗主题和桌面/窄屏验证文字与实际祖先背景的合成对比度、卡片边框圆角、紧凑风格对齐、摘要去重；Tab 到原生 summary 后 Space 开合，真实无效网址表单触发错误提示。
 * 模块边界：使用独立 profile、helper 首 tab、公共配置消息和真实 UI 操作，不注入样式或改变 DOM；仅保存代表性截图，不能证明 Firefox、真实设备、在线供应商或所有页面的完整无障碍。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {guardBrowserClose, getGuardedBrowserPid} = require('./owned-browser-close.cjs');
const arg = (name, fallback) => {const index = process.argv.indexOf(`--${name}`); return index < 0 ? fallback : process.argv[index + 1];};
const timeout = Number(arg('timeout', '30000'));
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-settings-skin-consistency'));
const helperPath = path.resolve(arg('focus-safe-helper', path.join(__dirname, 'focus-safe-browser.cjs')));
const playwrightRoot = arg('playwright-root', '/Users/thinkstu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const browserPath = arg('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {if (await check()) return; await pause(60);}
  throw new Error(`Timeout: ${label}`);
}
function fingerprint(directory) {
  const hash = crypto.createHash('sha256'); let files = 0;
  function walk(folder) {
    for (const name of fs.readdirSync(folder).sort()) {
      const file = path.join(folder, name), stat = fs.lstatSync(file);
      assert(!stat.isSymbolicLink(), 'Production artifact must not contain symlinks');
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) {hash.update(path.relative(directory, file)); hash.update('\0'); hash.update(fs.readFileSync(file)); files += 1;}
    }
  }
  walk(directory); return {sha256: hash.digest('hex'), files};
}

// This function runs read-only in the page. OffscreenCanvas resolves browser-supported CSS
// colors (including color-mix), then alpha-composites every contributing background layer.
// Non-solid backgrounds, group opacity and blend modes fail explicitly instead of producing
// a misleading WCAG ratio. The opaque card surface makes the browser canvas fallback irrelevant.
function contrastReadout(nodes) {
  const canvas = new OffscreenCanvas(1, 1), context = canvas.getContext('2d', {willReadFrequently: true});
  const rgba = css => {context.clearRect(0, 0, 1, 1); context.fillStyle = css; context.fillRect(0, 0, 1, 1); return Array.from(context.getImageData(0, 0, 1, 1).data).map((value, index) => index === 3 ? value / 255 : value);};
  const composite = (front, back) => {const alpha = front[3] + back[3] * (1 - front[3]); return [...front.slice(0, 3).map((value, index) => alpha ? (value * front[3] + back[index] * back[3] * (1 - front[3])) / alpha : 0), alpha];};
  const luminance = color => color.slice(0, 3).map(channel => {const value = channel / 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;}).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  return nodes.map(node => {
    const layers = [], unsupported = [];
    for (let current = node; current; current = current.parentElement) {
      const css = getComputedStyle(current), color = rgba(css.backgroundColor);
      if (css.backgroundImage !== 'none') unsupported.push(`background-image: ${css.backgroundImage}`);
      layers.push({tag: current.tagName, className: current.className, color: css.backgroundColor, rgba: color});
      if (color[3] === 1) break;
    }
    // Effects above an opaque surface can still alter the entire rendered group.
    for (let current = node; current; current = current.parentElement) {
      const css = getComputedStyle(current);
      if (Number(css.opacity) !== 1) unsupported.push(`opacity: ${css.opacity}`);
      if (css.mixBlendMode !== 'normal') unsupported.push(`mix-blend-mode: ${css.mixBlendMode}`);
      if (css.filter !== 'none') unsupported.push(`filter: ${css.filter}`);
    }
    if (layers.at(-1)?.rgba[3] !== 1) unsupported.push('No opaque ancestor surface');
    let background = [0, 0, 0, 0];
    for (const layer of [...layers].reverse()) background = composite(layer.rgba, background);
    const css = getComputedStyle(node), foreground = composite(rgba(css.color), background), a = luminance(foreground), b = luminance(background);
    return {text: node.textContent.trim(), color: css.color, fontSize: css.fontSize, foreground, background,
      ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), layers, unsupported};
  });
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write('Production UI consistency: --extension-dir PATH --artifacts-dir PATH --playwright-root PATH --focus-safe-helper PATH --browser-path PATH --display secondary --timeout 30000\n'); return;
  }
  assert.equal(process.platform, 'darwin');
  assert(!process.argv.includes('--headed') && !process.argv.includes('--headless'), 'Only visible background mode is supported');
  assert(!path.basename(extensionDir).endsWith('-dev'), 'Use a production extension');
  assert(Number.isFinite(timeout) && timeout > 0 && timeout <= 60000);
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
  const optionsEntry = manifest.options_page || manifest.options_ui?.page;
  assert(optionsEntry && manifest.background?.service_worker && manifest.action?.default_popup, 'Production MV3 options and worker required');
  const helper = require(helperPath), {chromium} = require(path.join(playwrightRoot, 'playwright'));
  for (const name of ['launchFocusSafePersistentContext', 'queryMacFrontmostApplication', 'activateExtensionTabWithoutForeground']) assert.equal(typeof helper[name], 'function');
  fs.mkdirSync(artifactsDir, {recursive: true});
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-settings-skin-consistency-'));
  const reportPath = path.join(artifactsDir, 'report.json');
  const report = {ok: false, artifact: 'production', extensionDir, profileDir, browserPath, startedAt: new Date().toISOString(), productionFingerprint: fingerprint(extensionDir),
    singlePageReuse: true, pageNavigations: 0, cases: [], contrasts: [], cardStyles: [], alignments: [], focusStates: [], layouts: [], screenshots: [], consoleErrors: [], focusSamples: [], fixtureWrites: [], additionalPages: [], remoteRequests: [],
    evidenceBoundary: 'One owned background Chromium tab, isolated profile, production build. Public config messages set fixtures; real selectors, Tab/Space and invalid URL form exercise UI. Contrast is computed from rendered CSS foreground and solid alpha-composited ancestor surfaces, not screenshot antialiasing. Browser-page HTTP(S) blocked; no translation, provider request, download, Firefox, native-toolbar or real-device claim.'};
  let session, context, page, worker, browserPid, origin, currentCase = 'launch', primaryError, launchAttempted = false, focusViolation = false;
  const save = () => fs.writeFileSync(reportPath, JSON.stringify({...report, currentCase}, null, 2));
  async function focus(label) {
    const app = await helper.queryMacFrontmostApplication();
    report.focusSamples.push({label, application: app, ownedPid: browserPid, at: new Date().toISOString()});
    if (!app?.pid || !browserPid || app.pid === browserPid) {focusViolation = true; throw new Error(`${label}: foreground identity unavailable or owned browser took focus`);}
  }
  function clean(label) {assert.deepEqual(report.consoleErrors, [], `${label}: console/page error`); assert.deepEqual(report.additionalPages, [], `${label}: extra page opened`);}
  async function settle() {await page.evaluate(() => document.fonts.ready); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));}
  async function layout(label) {
    const metrics = await page.evaluate(() => {
      const visible = node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
      const containers = [...document.querySelectorAll('.workspace,.settings-card,.settings-group,.settings-disclosure,.rule-card,.settings-item,.feature-service-control')].filter(visible).map(node => ({className: node.className, width: node.clientWidth, scrollWidth: node.scrollWidth}));
      return {viewport: {width: innerWidth, height: innerHeight}, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, scrollX, containers};
    });
    report.layouts.push({label, ...metrics});
    assert(metrics.documentWidth <= metrics.viewport.width + 1 && metrics.bodyWidth <= metrics.viewport.width + 1 && metrics.scrollX === 0, `${label}: document horizontal overflow`);
    assert(metrics.containers.every(row => row.scrollWidth <= row.width + 1), `${label}: container horizontal overflow ${JSON.stringify(metrics.containers.filter(row => row.scrollWidth > row.width + 1))}`);
  }
  async function shot(label) {
    await settle(); clean(label); await layout(label); await focus(`before:${label}`);
    const file = path.join(artifactsDir, `${label}.png`); await page.screenshot({path: file, animations: 'disabled'});
    await focus(`after:${label}`); clean(label); report.screenshots.push(file); save();
  }
  async function navigate(target, viewport) {
    await focus(`navigate:${target.replace(origin, '')}`); if (viewport) await page.setViewportSize(viewport);
    await page.goto(target, {waitUntil: 'domcontentloaded', timeout}); report.pageNavigations += 1;
  }
  async function readConfig() {
    const result = await page.evaluate(() => chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'}));
    assert(result?.success && result.value, 'Read authoritative isolated config'); return typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
  }
  async function patchFixture(patch) {
    const config = await readConfig(), expected = Object.fromEntries(Object.keys(patch).map(key => [key, config[key]]));
    const result = await page.evaluate(({patch, expected}) => chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: patch, expected}), {patch, expected});
    assert(result?.success, `Fixture save: ${Object.keys(patch).join(',')}`); report.fixtureWrites.push({fields: Object.keys(patch), revision: result.revision});
    await until(async () => {const saved = await readConfig(); return Object.entries(patch).every(([key, value]) => JSON.stringify(saved[key]) === JSON.stringify(value));}, 'fixture persistence');
  }
  async function openOptions(section, width = 1440, panel) {
    await navigate(`${origin}/icon/128.png`);
    await navigate(`${origin}/${optionsEntry}#${section}`, {width, height: width === 390 ? 844 : 960});
    await page.locator('.settings-app').waitFor(); await page.locator(`#${section}`).waitFor({state: 'visible'});
    if (panel) {await page.locator(`[data-settings-anchor-link="${panel}"]:visible,[data-settings-category="${panel}"]:visible`).first().click(); await settle();}
    await settle();
  }
  async function contrast(label, locator, minimumCount) {
    const readings = await locator.evaluateAll(contrastReadout); report.contrasts.push({label, readings});
    assert(readings.length >= minimumCount, `${label}: expected at least ${minimumCount} visible text samples`);
    for (const reading of readings) {assert.deepEqual(reading.unsupported, [], `${label}: unsupported background composition`); assert(reading.ratio >= 4.5, `${label}: ${reading.text} contrast ${reading.ratio.toFixed(3)} < 4.5`);}
  }
  async function geometry(label, compact) {
    const result = await page.evaluate(() => {
      const visible = node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
      // Inner SettingsGroup deliberately loses its outline inside a disclosure. Keep every
      // outer card, including skins that deliberately remove both outer borders.
      const nodes = [...document.querySelectorAll('.settings-section .settings-group,.settings-section .settings-disclosure')].filter(node => visible(node) && !node.parentElement.closest('.settings-group,.settings-disclosure'));
      const cards = nodes.map(node => {const css = getComputedStyle(node), summary = node.querySelector(':scope > summary'), summaryCss = summary && getComputedStyle(summary); return {type: node.matches('.settings-disclosure') ? 'disclosure' : 'group',
        radius: [css.borderTopLeftRadius, css.borderTopRightRadius, css.borderBottomRightRadius, css.borderBottomLeftRadius],
        summaryTopRadius: summaryCss ? [summaryCss.borderTopLeftRadius, summaryCss.borderTopRightRadius] : null,
        border: ['Top', 'Right', 'Bottom', 'Left'].map(side => ({width: css[`border${side}Width`], style: css[`border${side}Style`], color: css[`border${side}Color`]}))};});
      const alignments = nodes.flatMap(node => {
        const heading = node.querySelector(':scope > .settings-group-heading .settings-card-heading-copy,:scope > summary .settings-disclosure-copy');
        if (!heading) return [];
        const rows = [...node.querySelectorAll('.settings-item-copy')].filter(visible);
        const left = heading.getBoundingClientRect().left;
        return rows.map(row => ({type: node.matches('.settings-disclosure') ? 'disclosure' : 'group', headingLeft: left, rowLeft: row.getBoundingClientRect().left, delta: row.getBoundingClientRect().left - left}));
      });
      return {cards, alignments};
    });
    report.cardStyles.push({label, cards: result.cards});
    const groups = result.cards.filter(card => card.type === 'group'), disclosures = result.cards.filter(card => card.type === 'disclosure');
    assert(groups.length > 0 && disclosures.length > 0, `${label}: both outer card types must exist`);
    for (const card of result.cards) {assert.deepEqual(card.radius, groups[0].radius, `${label}: outer card radius`); assert.deepEqual(card.border, groups[0].border, `${label}: outer card border`); if (card.summaryTopRadius) assert.deepEqual(card.summaryTopRadius, card.radius.slice(0, 2), `${label}: disclosure summary top radius`);}
    if (compact) {
      report.alignments.push({label, rows: result.alignments});
      assert(result.alignments.some(row => row.type === 'group') && result.alignments.some(row => row.type === 'disclosure'), `${label}: alignment samples for both card types`);
      assert(result.alignments.every(row => Math.abs(row.delta) <= 1), `${label}: compact title/row misalignment ${JSON.stringify(result.alignments.filter(row => Math.abs(row.delta) > 1))}`);
    }
  }
  async function keyboardSummary(label, selector) {
    const disclosure = page.locator(selector), summary = disclosure.locator(':scope > summary'); await summary.waitFor();
    assert.equal(await disclosure.getAttribute('open'), null, `${label}: default collapsed`);
    let tabs = 0;
    while (!await summary.evaluate(node => document.activeElement === node) && tabs < 180) {await page.keyboard.press('Tab'); tabs += 1;}
    assert(tabs > 0 && tabs < 180, `${label}: summary reachable through real Tab navigation`);
    await summary.scrollIntoViewIfNeeded();
    const state = await summary.evaluate(node => {const css = getComputedStyle(node), rect = node.getBoundingClientRect(); return {focused: document.activeElement === node, focusVisible: node.matches(':focus-visible'),
      outlineWidth: css.outlineWidth, outlineStyle: css.outlineStyle, outlineColor: css.outlineColor, outlineOffset: css.outlineOffset,
      rect: {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom}, viewport: {width: innerWidth, height: innerHeight}};});
    report.focusStates.push({label, tabs, ...state});
    assert(state.focused && state.focusVisible, `${label}: keyboard focus must be visibly styled`);
    assert(parseFloat(state.outlineWidth) >= 2 && state.outlineStyle !== 'none' && state.outlineColor !== 'rgba(0, 0, 0, 0)', `${label}: visible outline required`);
    assert(parseFloat(state.outlineOffset) < 0, `${label}: outline must be inset to avoid clipping`);
    assert(state.rect.left >= 0 && state.rect.top >= 0 && state.rect.right <= state.viewport.width + 1 && state.rect.bottom <= state.viewport.height + 1, `${label}: focused summary visible in viewport`);
    await page.keyboard.press('Space'); await until(async () => await disclosure.getAttribute('open') !== null, `${label}: Space expands`);
    assert(await summary.evaluate(node => document.activeElement === node && node.matches(':focus-visible')), `${label}: expansion retains keyboard focus`);
    await shot(`${label}-expanded`);
    await page.keyboard.press('Space'); await until(async () => await disclosure.getAttribute('open') === null, `${label}: Space collapses`);
    report.cases.push({name: label, tabReachable: true, spaceExpandCollapse: true, insetOutline: true});
  }
  try {
    launchAttempted = true;
    session = await helper.launchFocusSafePersistentContext({chromium, profileDir, browserPath, timeout, background: true, headless: false,
      displayTarget: arg('display', 'secondary'), viewport: {width: 1440, height: 960},
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    guardBrowserClose(session, profileDir); browserPid = await getGuardedBrowserPid(session); context = session.context;
    Object.assign(report, {launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement, ownedPid: browserPid});
    assert.equal(session.launchMode, 'macos-background-cdp'); assert.equal(session.focusPolicy, 'launchservices-no-foreground');
    assert.equal(session.windowPlacement?.mode, 'background-visible-no-focus'); assert.equal(session.windowPlacement?.browserFrontmost, false); await focus('launch');
    const initialPages = context.pages(); report.initialPageCount = initialPages.length;
    page = initialPages.find(candidate => candidate.url().startsWith('about:blank#fluentread-background-')) || (initialPages.length === 1 ? initialPages[0] : undefined);
    assert(page, 'Reuse helper first page without creating a fallback');
    context.on('page', other => {if (other !== page) report.additionalPages.push({url: other.url()});});
    page.setDefaultTimeout(timeout); page.on('pageerror', error => report.consoleErrors.push({surface: 'page', case: currentCase, message: error.message}));
    page.on('console', message => {if (message.type() === 'error') report.consoleErrors.push({surface: 'page', case: currentCase, message: message.text()});});
    await context.route(/^https?:/u, async route => {const url = new URL(route.request().url()); report.remoteRequests.push({origin: url.origin, path: url.pathname}); await route.abort();});
    await until(async () => {
      for (const candidate of context.serviceWorkers()) {
        if (!candidate.url().endsWith(`/${manifest.background.service_worker}`)) continue;
        const value = await candidate.evaluate(name => {const m = chrome.runtime.getManifest(), key = /^__MSG_(.+)__$/u.exec(name); return {name: m.name, expected: key ? chrome.i18n.getMessage(key[1]) : name, version: m.version, popup: m.action?.default_popup, key: m.key};}, manifest.name).catch(() => null);
        if (value && value.name === value.expected && value.version === manifest.version && value.popup === manifest.action.default_popup && value.key === manifest.key) {worker = candidate; report.loadedManifest = {name: value.name, version: value.version}; return true;}
      }
      return false;
    }, 'exact production worker');
    worker.on('console', message => {if (message.type() === 'error') report.consoleErrors.push({surface: 'worker', case: currentCase, message: message.text()});});
    origin = `chrome-extension://${new URL(worker.url()).host}`;
    await navigate(`${origin}/icon/128.png`); await helper.activateExtensionTabWithoutForeground(context, page); await focus('activate-owned-page');
    await until(async () => {try {return Boolean((await readConfig()).uiLanguage);} catch {return false;}}, 'config initialization');
    const initial = await readConfig();
    await patchFixture({on: true, uiLanguageSetupCompleted: true, uiLanguage: 'zh-CN', interfaceFont: 'system', animations: false, interfaceSkin: 'default', theme: 'light', service: 'microsoft',
      harness: {...initial.harness, enabled: true, service: ''}, writing: {...initial.writing, enabled: true, service: ''}});
    currentCase = 'discover-skins'; await openOptions('settings-interface', 1440, 'skin');
    const skins = await page.locator('.interface-skin-option[data-skin]').evaluateAll(nodes => nodes.map(node => node.dataset.skin));
    assert.equal(skins.length, 14, 'Expected all 14 actual skin options'); assert.equal(new Set(skins).size, skins.length); report.skins = skins;
    const representative = (skin, theme) => skin === 'default' && theme === 'dark' || ['compact', 'wujin', 'xuanqing'].includes(skin) && theme === 'light';
    for (const skin of skins) for (const theme of ['light', 'dark']) {
      await patchFixture({interfaceSkin: skin, theme});
      for (const width of [1440, 390]) {
        const label = `${skin}-${theme}-${width}`; currentCase = `general-${label}`; await openOptions('settings-general', width);
        await page.waitForFunction(({skin, dark}) => document.documentElement.dataset.interfaceSkin === skin && document.documentElement.classList.contains('dark') === dark, {skin, dark: theme === 'dark'});
        const disclosure = page.locator('details.feature-services'); assert.notEqual(await disclosure.getAttribute('open'), null);
        assert.equal(await disclosure.locator('[data-feature-service]:visible').count(), 9);
        await page.mouse.move(0, 0); await settle();
        const summaryTitle = await disclosure.locator('.feature-services-status').getAttribute('title');
        const warned = await disclosure.locator('.settings-item:has(.feature-service-warning)').evaluateAll(nodes => nodes.map(node => ({name: node.querySelector('.feature-service-heading strong').textContent.trim(), feature: node.querySelector('[data-feature-service]').dataset.featureService})));
        assert.deepEqual(warned.map(row => row.feature).sort(), ['reading', 'writing']);
        assert.equal(summaryTitle.split('\n').length, 2, `${label}: two actionable feature warnings`);
        for (const row of warned) assert.equal(summaryTitle.split(row.name).length - 1, 1, `${label}: summary feature name ${row.name} appears once`);
        await contrast(label, disclosure.locator('.feature-service-warning:visible,.feature-services-status:visible'), 3);
        await geometry(label, skin === 'compact'); await layout(label); clean(label);
        if (representative(skin, theme)) {await disclosure.locator('[data-feature-service="writing"]').scrollIntoViewIfNeeded(); await shot(`general-${label}`);}
        report.cases.push({name: `general-${label}`, summaryTitle, warningContrast: true, matchingCards: true, compactAlignment: skin === 'compact'});
      }
      if (representative(skin, theme)) {
        for (const width of [1440, 390]) {
          const label = `danger-${skin}-${theme}-${width}`; currentCase = label; await openOptions('settings-sites', width, 'preview');
          const form = page.locator('[data-setting="site-rule-preview"] .preview-form');
          await form.locator('input').fill('not-a-valid-url'); await form.locator('button[type="submit"]').click();
          const error = page.locator('[data-setting="site-rule-preview"] .rule-error[role="alert"]'); await error.waitFor();
          assert.equal(await form.locator('input').getAttribute('aria-invalid'), 'true');
          await contrast(label, error, 1); await layout(label); clean(label);
          // One error screenshot per width is sufficient; other representative surfaces
          // still receive the real form and contrast assertions without redundant images.
          if (skin === 'default') {await error.scrollIntoViewIfNeeded(); await shot(label);}
          report.cases.push({name: label, actualInvalidUrlForm: true, dangerContrast: true});
          const domainLabel = `domain-danger-${skin}-${theme}-${width}`; currentCase = domainLabel;
          await openOptions('settings-translation', width, 'floating-ball');
          const domainEditor = page.locator('[data-setting="disabled-floating-ball-sites"]');
          await domainEditor.locator('input').fill('https://');
          await domainEditor.locator('button[type="submit"]').click();
          const domainError = domainEditor.locator('.site-rules-feedback.error'); await domainError.waitFor();
          assert.equal(await domainEditor.locator('input').getAttribute('aria-invalid'), 'true');
          await contrast(domainLabel, domainError, 1); await layout(domainLabel); clean(domainLabel);
          // Border feedback has a finite CSS transition; assert its settled result, not an intermediate frame.
          await until(() => domainEditor.evaluate(node => getComputedStyle(node.querySelector('input')).borderTopColor === getComputedStyle(node.querySelector('.site-rules-feedback.error')).color), 'invalid domain border reaches the danger color');
          const errorColors = await domainEditor.evaluate(node => ({border: getComputedStyle(node.querySelector('input')).borderTopColor, text: getComputedStyle(node.querySelector('.site-rules-feedback.error')).color}));
          assert.equal(errorColors.border, errorColors.text, 'Invalid domain field and feedback use the same danger color');
          if (skin === 'default') {await domainError.scrollIntoViewIfNeeded(); await shot(domainLabel);}
          report.cases.push({name: domainLabel, actualInvalidDomainForm: true, dangerContrast: true, errorColors});
        }
      }
    }
    await patchFixture({interfaceSkin: 'default', theme: 'dark'});
    for (const width of [1440, 390]) for (const [panel, selector] of [['cache', '[data-cache-limits]'], ['requests', '[data-testid="translation-retry-settings"]']]) {
      currentCase = `focus-${panel}-${width}`; await openOptions('settings-advanced', width, panel); await keyboardSummary(currentCase, selector); clean(currentCase);
    }
    await focus('complete'); clean('complete'); report.ok = true;
  } catch (error) {
    primaryError = error; report.failure = {case: currentCase, message: error.message, stack: error.stack};
    if (!focusViolation && page && !page.isClosed() && browserPid) {
      try {await focus('before:failure'); const file = path.join(artifactsDir, 'failure.png'); await page.screenshot({path: file, animations: 'disabled'}); await focus('after:failure'); report.screenshots.push(file);} catch (captureError) {report.failureCaptureError = captureError.message;}
    }
  } finally {
    // Closing the verified owned process must happen even if evidence cannot be written.
    try {
      if (session) {await session.close(); report.cleanup = {ownedBrowserClosed: true}; fs.rmSync(profileDir, {recursive: true, force: true}); report.cleanup.profileRemoved = true;}
      else if (!launchAttempted) {fs.rmSync(profileDir, {recursive: true, force: true}); report.cleanup = {profileRemoved: true, browserNotStarted: true};}
      else report.cleanup = {profileRetained: true, reason: 'Launch did not return a verified owned session'};
    } catch (error) {report.ok = false; report.cleanup = {profileRetained: true, message: error.message}; primaryError ||= error;}
    try {report.finalProductionFingerprint = fingerprint(extensionDir); assert.deepEqual(report.finalProductionFingerprint, report.productionFingerprint, 'Production artifact changed during validation');}
    catch (error) {report.ok = false; report.artifactError = error.message; primaryError ||= error;}
    report.finishedAt = new Date().toISOString(); save();
  }
  if (primaryError) throw primaryError;
  process.stdout.write(JSON.stringify({ok: report.ok, reportPath, cases: report.cases.length, screenshots: report.screenshots.length, contrastSamples: report.contrasts.reduce((count, item) => count + item.readings.length, 0)}, null, 2) + '\n');
}
main().catch(error => {process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1;});
