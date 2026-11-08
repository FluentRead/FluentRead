#!/usr/bin/env node
'use strict';

/**
 * @file scripts/testing/run-ui-hierarchy-polish.cjs
 * 文件职责：为本轮设置与 Popup 信息层级调整生成生产扩展的真实浏览器证据。
 * 主要内容：复用 focus-safe helper 已创建的单一自有页签，通过 goto 验证渐进展开、语言恢复搜索、皮肤网格及键盘选择、Popup 精简与配置重开；逐截图检查前台 PID、横向布局及页面错误，可选遍历全部设置分类。
 * 模块边界：只使用临时 profile 和真实扩展配置消息，不调用翻译、连接测试或模型下载；同页导航模拟页面卸载与重开，不声称验证原生工具栏、真实供应商、Firefox 或移动设备。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {guardBrowserClose, getGuardedBrowserPid} = require('./owned-browser-close.cjs');
const arg = (name, fallback) => {const index = process.argv.indexOf(`--${name}`); return index < 0 ? fallback : process.argv[index + 1];};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = Number(arg('timeout', '30000'));
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-ui-hierarchy-polish'));
const browserPath = arg('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
const helperPath = path.resolve(arg('focus-safe-helper', path.join(__dirname, 'focus-safe-browser.cjs')));
const playwrightRoot = arg('playwright-root', '/Users/thinkstu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const auditSections = arg('audit-sections', 'false');

async function until(check, label, duration = timeout) {
  const deadline = Date.now() + duration;
  while (Date.now() < deadline) {if (await check()) return; await pause(60);}
  throw new Error(`Timeout: ${label}`);
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write('Production UI hierarchy proof: --extension-dir PATH --artifacts-dir PATH --playwright-root PATH --focus-safe-helper PATH --browser-path PATH --display secondary --timeout 30000 [--audit-sections true|desktop|false]\n');
    return;
  }
  assert.equal(process.platform, 'darwin', 'This runner requires the verified macOS background helper');
  assert(!process.argv.includes('--headed') && !process.argv.includes('--headless'), 'This runner only permits a visible background browser');
  assert(!path.basename(extensionDir).endsWith('-dev'), 'Use a production extension artifact');
  assert(['false', 'true', 'desktop'].includes(auditSections), '--audit-sections must be false, desktop or true');
  assert(Number.isFinite(timeout) && timeout > 0 && timeout <= 60000, '--timeout must be in 1..60000');
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
  const optionsEntry = manifest.options_page || manifest.options_ui?.page;
  assert(manifest.action?.default_popup && optionsEntry && manifest.background?.service_worker, 'Expected production MV3 popup, options and service worker');
  const {chromium} = require(path.join(playwrightRoot, 'playwright'));
  const helper = require(helperPath);
  for (const name of ['launchFocusSafePersistentContext', 'queryMacFrontmostApplication', 'activateExtensionTabWithoutForeground']) assert.equal(typeof helper[name], 'function', `Missing helper: ${name}`);
  fs.mkdirSync(artifactsDir, {recursive: true});
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-ui-hierarchy-'));
  const report = {ok: false, artifact: 'production', extensionDir, browserPath, profileDir, auditSections, startedAt: new Date().toISOString(),
    cases: [], layouts: [], screenshots: [], consoleErrors: [], focusSamples: [], persistenceCases: [], fixtureWrites: [], remoteRequests: [],
    singlePageReuse: true, pageNavigations: 0, additionalPages: [], quickClose: false, latestWriteWins: false, crossPageSync: false,
    evidenceBoundary: 'Production extension in one owned background Chromium tab. Public configuration messages and real UI events; navigation unloads and remounts each surface. Browser-page HTTP(S) requests are blocked. No translation, provider connection, model download, native-toolbar, Firefox, real-device or simultaneous cross-page-sync claim.'};
  let session, context, page, worker, browserPid, origin, currentCase = 'launch', primaryError, launchAttempted = false, focusViolation = false;
  const reportPath = path.join(artifactsDir, 'report.json');
  const saveReport = () => fs.writeFileSync(reportPath, JSON.stringify({...report, currentCase, updatedAt: new Date().toISOString()}, null, 2));
  async function focus(label) {
    const application = await helper.queryMacFrontmostApplication();
    assert(application?.pid, `${label}: cannot establish foreground app`);
    report.focusSamples.push({label, ...application, ownedPid: browserPid, at: new Date().toISOString()});
    if (application.pid === browserPid) {focusViolation = true; throw new Error(`${label}: owned browser ${browserPid} took foreground focus`);}
  }
  function cleanConsole(label) {
    assert.deepEqual(report.consoleErrors, [], `${label}: console or page errors`);
    assert.deepEqual(report.additionalPages, [], `${label}: this runner must reuse its owned page`);
  }
  async function settle() {
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  async function layout(label) {
    const metrics = await page.evaluate(() => {
      const visible = node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
      const selectors = ['.settings-card', '.interface-skin-picker', '.interface-skin-grid', '.interface-skin-option', '.feature-services', '.popup-shell', '.drawer-surface'];
      const containers = [...document.querySelectorAll(selectors.join(','))].filter(visible).map(node => ({
        className: node.className, width: node.clientWidth, scrollWidth: node.scrollWidth,
      }));
      return {viewport: {width: innerWidth, height: innerHeight}, documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth, scrollX, containers,
        skin: document.documentElement.dataset.interfaceSkin, language: document.documentElement.lang,
        dark: document.documentElement.classList.contains('dark')};
    });
    assert(metrics.documentWidth <= metrics.viewport.width + 1 && metrics.bodyWidth <= metrics.viewport.width + 1 && metrics.scrollX === 0, `${label}: document horizontal overflow ${JSON.stringify(metrics)}`);
    assert(metrics.containers.every(item => item.scrollWidth <= item.width + 1), `${label}: container horizontal overflow ${JSON.stringify(metrics.containers)}`);
    report.layouts.push({label, ...metrics});
    return metrics;
  }
  async function shot(label) {
    currentCase = label; await settle(); cleanConsole(label); await layout(label); await focus(`before:${label}`);
    const file = path.join(artifactsDir, `${label}.png`);
    await page.screenshot({path: file, animations: 'disabled'});
    await focus(`after:${label}`); cleanConsole(label); report.screenshots.push(file); saveReport();
  }
  async function navigate(target, viewport) {
    await focus(`navigate:${target.replace(origin, '')}`);
    if (viewport) await page.setViewportSize(viewport);
    await page.goto(target, {waitUntil: 'domcontentloaded', timeout}); report.pageNavigations += 1;
  }
  async function readConfig() {
    const result = await page.evaluate(() => chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'}));
    assert(result?.success && result.value, 'Read authoritative isolated configuration'); return result.value;
  }
  async function patchFixture(patch) {
    const config = await readConfig();
    const expected = Object.fromEntries(Object.keys(patch).map(key => [key, config[key]]));
    const result = await page.evaluate(({patch, expected}) => chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: patch, expected}), {patch, expected});
    assert(result?.success, `Fixture patch failed: ${Object.keys(patch).join(',')}`);
    report.fixtureWrites.push({fields: Object.keys(patch), success: result.success, revision: result.revision});
    await until(async () => {const value = await readConfig(); return Object.entries(patch).every(([key, expectedValue]) => JSON.stringify(value[key]) === JSON.stringify(expectedValue));}, 'fixture persistence');
  }
  async function saved(key, expected) {await until(async () => JSON.stringify((await readConfig())[key]) === JSON.stringify(expected), `saved ${key}`);}
  async function openOptions(section = 'settings-general', viewport = {width: 1440, height: 960}) {
    await navigate(`${origin}/${optionsEntry}#${section}`, viewport);
    await page.locator('.settings-app').waitFor(); await page.locator(`#${section}`).waitFor({state: 'visible'}); await settle();
  }
  async function openPopup() {
    await navigate(`${origin}/${manifest.action.default_popup}`, {width: 400, height: 560});
    await page.locator('.popup-shell[data-config-ready="true"] [data-testid="page-translation"]').waitFor(); await settle();
    const rect = await page.locator('.popup-shell').evaluate(node => {const r = node.getBoundingClientRect(); return {width: Math.ceil(r.width), height: Math.min(560, Math.ceil(r.height))};});
    assert(rect.width > 0 && rect.width <= 400 && rect.height > 0, 'Popup must have intrinsic geometry');
    await page.setViewportSize(rect); await settle();
  }
  async function closeDrawer() {await page.locator('.drawer-header > button, .popup-service-toolbar > .service-panel-close').click(); await page.locator('.drawer-surface').waitFor({state: 'hidden'});}
  async function featureDrawer(id) {await page.locator(`[data-popup-quick-feature="${id}"]`).click(); await page.locator('.drawer-header').waitFor(); await settle();}
  async function anchor(id) {
    const link = page.locator(`[data-settings-anchor-link="${id}"]`); await link.waitFor(); await link.click(); await settle();
  }
  async function revealSkin() {
    const link = page.locator('[data-settings-anchor-link="skin"], [data-settings-category="skin"]');
    if (await link.count()) await link.first().click();
    await page.locator('.interface-skin-picker').waitFor(); await page.locator('.interface-skin-picker').scrollIntoViewIfNeeded(); await settle();
  }
  async function selectedSkin(expected, focusExpected = false) {
    await saved('interfaceSkin', expected);
    await page.waitForFunction(expected => document.querySelector(`.interface-skin-option[data-skin="${expected}"]`)?.getAttribute('aria-checked') === 'true', expected);
    const states = await page.locator('.interface-skin-option').evaluateAll(nodes => nodes.map(node => ({skin: node.dataset.skin, checked: node.getAttribute('aria-checked'), tabIndex: node.tabIndex, focused: node === document.activeElement})));
    assert.equal(states.filter(item => item.checked === 'true').length, 1, 'Exactly one selected skin');
    assert.equal(states.filter(item => item.tabIndex === 0).length, 1, 'Exactly one skin enters Tab order');
    assert(states.every(item => item.tabIndex === (item.skin === expected ? 0 : -1)), 'Roving tab index follows selection');
    if (focusExpected) assert.equal(states.find(item => item.focused)?.skin, expected, 'Skin keyboard focus follows selected option');
  }
  try {
    launchAttempted = true;
    session = await helper.launchFocusSafePersistentContext({chromium, profileDir, browserPath, timeout, background: true, headless: false,
      displayTarget: arg('display', 'secondary'), viewport: {width: 1440, height: 960},
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    guardBrowserClose(session, profileDir); browserPid = await getGuardedBrowserPid(session); context = session.context;
    Object.assign(report, {launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement, ownedPid: browserPid});
    assert.equal(session.launchMode, 'macos-background-cdp'); assert.equal(session.focusPolicy, 'launchservices-no-foreground');
    assert.equal(session.windowPlacement?.mode, 'background-visible-no-focus'); assert.equal(session.windowPlacement?.browserFrontmost, false);
    await focus('launch');
    // The helper already owns and places this page. Creating a second tab is deliberately unnecessary.
    const initialPages = context.pages(); report.initialPageCount = initialPages.length;
    page = initialPages.find(candidate => candidate.url().startsWith('about:blank#fluentread-background-')) || (initialPages.length === 1 ? initialPages[0] : undefined);
    assert(page, 'Reuse the helper-created blank page; do not create a fallback tab');
    context.on('page', other => {if (other !== page) report.additionalPages.push({url: other.url(), at: new Date().toISOString()});});
    page.setDefaultTimeout(timeout); page.on('pageerror', error => report.consoleErrors.push({surface: 'page', case: currentCase, message: error.message}));
    page.on('console', message => {if (message.type() === 'error') report.consoleErrors.push({surface: 'page', case: currentCase, message: message.text()});});
    await context.route(/^https?:/u, async route => {const url = new URL(route.request().url()); report.remoteRequests.push({origin: url.origin, path: url.pathname, method: route.request().method()}); await route.abort();});
    await until(async () => {
      for (const candidate of context.serviceWorkers()) {
        if (!candidate.url().endsWith(`/${manifest.background.service_worker}`)) continue;
        const value = await candidate.evaluate(rawName => {const m = chrome.runtime.getManifest(); const message = /^__MSG_(.+)__$/u.exec(rawName); return {name: m.name, expectedName: message ? chrome.i18n.getMessage(message[1]) : rawName, version: m.version, popup: m.action?.default_popup, key: m.key};}, manifest.name).catch(() => null);
        if (value && value.name === value.expectedName && value.version === manifest.version && value.popup === manifest.action.default_popup && value.key === manifest.key) {worker = candidate; report.loadedManifest = {name: value.name, version: value.version, popup: value.popup}; return true;}
      }
      return false;
    }, 'exact production worker');
    worker.on('console', message => {if (message.type() === 'error') report.consoleErrors.push({surface: 'worker', case: currentCase, message: message.text()});});
    origin = `chrome-extension://${new URL(worker.url()).host}`;
    await navigate(`${origin}/icon/128.png`); await helper.activateExtensionTabWithoutForeground(context, page); await focus('activate-owned-page');
    await until(async () => {try {return Boolean((await readConfig()).uiLanguage);} catch {return false;}}, 'configuration initialization');
    const initial = await readConfig();
    await patchFixture({on: true, uiLanguageSetupCompleted: true, uiLanguage: 'zh-CN', theme: 'light', interfaceSkin: 'default', interfaceFont: 'system', animations: false,
      service: 'microsoft', hotkey: 'Control', hoverShortcutBeforeDisable: 'Control', quickTranslationProfiles: [],
      selectionTranslatorMode: 'bilingual', selectionTranslatorModeBeforeDisable: 'bilingual', selectionAreaEnabled: true, disableImageTranslator: false,
      popupModuleOrder: ['translation', 'siteRule', 'quickFeatures', 'footer'], popupQuickFeatureOrder: ['hover', 'selection', 'appearance', 'image', 'document'],
      interfaceVisibility: {...initial.interfaceVisibility, popupQuickFeatures: true, popupSiteRule: true, popupFooter: true}});

    currentCase = 'general-disclosure'; await openOptions();
    const services = page.locator('details.feature-services[data-testid="feature-services"]');
    const servicesSummary = services.locator(':scope > summary');
    assert.notEqual(await services.getAttribute('open'), null, 'Feature services initially expanded');
    assert.equal(await services.locator('[data-feature-service]:visible').count(), 9);
    await servicesSummary.scrollIntoViewIfNeeded(); await shot('general-services-expanded');
    await servicesSummary.click();
    assert.equal(await services.locator('[data-feature-service]:visible').count(), 0, 'Collapsed services do not occupy the form');
    await shot('general-services-collapsed');
    await servicesSummary.click(); assert.equal(await services.locator('[data-feature-service]:visible').count(), 9);
    await servicesSummary.click();
    await page.locator('.search-box input').fill('按功能选择服务');
    await page.locator('.search-results button').filter({hasText: '翻译服务选择'}).click();
    await page.waitForFunction(() => document.querySelector('#feature-services')?.hasAttribute('open'));
    assert.equal(await services.locator('[data-feature-service]:visible').count(), 9); assert.equal(await page.locator('.search-box input').inputValue(), '');
    await shot('general-services-search-reveal');
    await servicesSummary.click(); await anchor('services');
    await page.waitForFunction(() => document.querySelector('#feature-services')?.hasAttribute('open'));
    assert.equal(await services.locator('[data-feature-service]:visible').count(), 9); await shot('general-services-anchor-reveal');
    report.cases.push({name: 'general-disclosure', rows: 9, defaultOpen: true, searchReveal: true, anchorReveal: true});

    currentCase = 'language-recovery';
    for (const [query, nextLanguage, optionName] of [['language', 'en-US', /English/], ['语言', 'zh-CN', /Chinese|中文/]]) {
      await page.locator('.search-box input').fill(query); const result = page.locator('.search-results button').first();
      assert.match(await result.textContent(), /Language/, 'Recovery search ranks the bilingual language entry first'); await result.click();
      await page.waitForFunction(() => document.activeElement?.matches('[data-testid="ui-language-select"] input'));
      await shot(`language-recovery-${nextLanguage}`);
      await page.locator('[data-testid="ui-language-select"]').click();
      await page.locator('.ui-language-select-popper:visible [role="option"]').filter({hasText: optionName}).click();
      await saved('uiLanguage', nextLanguage); await openOptions();
      await anchor('preferences');
      assert.match(await page.locator('[data-testid="ui-language-select"]').textContent(), nextLanguage === 'en-US' ? /English/ : /中文|Chinese/);
      await shot(`language-reopened-${nextLanguage}`);
      report.persistenceCases.push({name: 'ui-language', query, saved: nextLanguage, reopening: 'same-tab document navigation', passed: true});
    }

    currentCase = 'skin-keyboard'; await openOptions('settings-interface'); await revealSkin();
    const skinIds = await page.locator('.interface-skin-option').evaluateAll(nodes => nodes.map(node => node.dataset.skin));
    assert(skinIds.length > 2 && skinIds.includes('minimal'), 'Existing skin choices are available');
    await page.locator(`.interface-skin-option[data-skin="${skinIds[0]}"]`).click(); await selectedSkin(skinIds[0]);
    await page.locator(`.interface-skin-option[data-skin="${skinIds[0]}"]`).focus();
    for (const [key, index] of [['End', skinIds.length - 1], ['Home', 0], ['ArrowRight', 1], ['ArrowLeft', 0], ['ArrowDown', 1], ['ArrowUp', 0]]) {
      await page.keyboard.press(key); await selectedSkin(skinIds[index], true); report.cases.push({name: 'skin-keyboard', key, selected: skinIds[index], passed: true});
    }
    await page.locator('.interface-skin-option[data-skin="minimal"]').click(); await selectedSkin('minimal');
    await openOptions('settings-interface'); await revealSkin(); await selectedSkin('minimal'); await shot('skin-selection-reopened');
    report.persistenceCases.push({name: 'skin-selection', saved: 'minimal', reopening: 'same-tab document navigation', passed: true});
    for (const language of ['zh-CN', 'en-US']) for (const theme of ['light', 'dark']) for (const width of [1440, 820, 390]) {
      currentCase = `skin-${language}-${theme}-${width}`;
      await patchFixture({uiLanguage: language, theme, interfaceSkin: 'default'}); await openOptions('settings-interface', {width, height: width === 390 ? 844 : 960}); await revealSkin(); await selectedSkin('default');
      const geometry = await page.locator('.interface-skin-picker').evaluate(root => {
        const rect = node => {const r = node.getBoundingClientRect(); return {left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height};};
        return {picker: rect(root), cards: [...root.querySelectorAll('.interface-skin-option')].map(node => ({skin: node.dataset.skin, ...rect(node), name: node.querySelector('strong')?.textContent, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth})), descriptions: root.querySelectorAll('.interface-skin-current p').length};
      });
      assert.equal(geometry.cards.length, skinIds.length); assert.equal(geometry.descriptions, 1, 'Only the current skin needs a full description');
      assert(geometry.cards.every(card => card.left >= geometry.picker.left - 1 && card.right <= geometry.picker.right + 1 && card.width > 100 && card.height >= 44 && card.scrollWidth <= card.clientWidth + 1), `Skin cards must remain readable and bounded: ${JSON.stringify(geometry)}`);
      const metrics = await layout(currentCase); assert.equal(metrics.dark, theme === 'dark'); assert.match(metrics.language, language === 'en-US' ? /^en/ : /^zh/);
      report.cases.push({name: currentCase, geometry, passed: true}); await shot(currentCase);
    }

    currentCase = 'popup-services'; await patchFixture({uiLanguage: 'zh-CN', theme: 'light', interfaceSkin: 'default'}); await openPopup();
    assert.equal(await page.locator('.provider-overflow').count(), 0); await shot('popup-home');
    await page.locator('[data-testid="popup-feature-services"]').click(); await page.locator('.popup-service-overview').waitFor();
    await page.locator('[data-feature-service="default"]').click(); await page.locator('[data-service-picker="default"]').waitFor();
    assert.equal(await page.locator('.service-picker-more').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('[data-service-choice="ollama"]').count(), 0, 'Unconfigured non-common service starts hidden');
    const search = page.locator('.service-picker-search input'); await shot('popup-services-common');
    await search.fill('Ollama'); await page.locator('[data-service-choice="ollama"]').waitFor(); await shot('popup-services-hidden-search');
    await page.locator('.service-picker-search button').click(); assert.equal(await search.inputValue(), '');
    assert.equal(await page.locator('.service-picker-more').getAttribute('aria-expanded'), 'false'); assert.equal(await page.locator('[data-service-choice="ollama"]').count(), 0);
    await search.press('Escape'); await page.waitForFunction(() => document.activeElement?.getAttribute('data-feature-service') === 'default');
    await shot('popup-services-return-focus'); await closeDrawer();
    report.cases.push({name: 'popup-services', defaultCollapsed: true, crossDirectorySearch: true, restoredFocus: 'default', passed: true});
    for (const feature of ['hover', 'selection']) {
      currentCase = `popup-${feature}`; await featureDrawer(feature);
      const control = page.locator(`[data-testid="${feature}-enable"]`);
      assert.equal(await page.locator(`.drawer-title-row [data-testid="${feature}-enable"]`).count(), 1, 'One switch belongs to the title');
      assert.equal((await page.locator('.drawer-header h2').textContent()).trim(), feature === 'hover' ? '默认悬浮快捷键' : '划词翻译', 'Title names the exact switch scope');
      assert.equal(await control.getAttribute('role'), 'switch'); assert(await control.getAttribute('aria-label'), 'Switch keeps an accessible name');
      assert.equal(await page.locator('.drawer-content .quick-enable-row').count(), 0, 'No duplicate enable row');
      assert.equal(await control.getAttribute('aria-checked'), 'true'); await shot(`popup-${feature}-enabled`);
      await control.click();
      // Navigate immediately: pagehide must hand off the same short-lived Popup edit.
      await navigate(`${origin}/icon/128.png`); const key = feature === 'hover' ? 'hotkey' : 'selectionTranslatorMode'; const disabled = feature === 'hover' ? 'none' : 'disabled';
      await saved(key, disabled); await openPopup(); await featureDrawer(feature);
      assert.equal(await control.getAttribute('aria-checked'), 'false'); await shot(`popup-${feature}-disabled-reopened`);
      await control.click(); await saved(key, feature === 'hover' ? 'Control' : 'bilingual');
      await openPopup(); await featureDrawer(feature); assert.equal(await control.getAttribute('aria-checked'), 'true');
      await shot(`popup-${feature}-restored-reopened`); await closeDrawer();
      report.persistenceCases.push({name: `popup-${feature}`, disabled, restored: feature === 'hover' ? 'Control' : 'bilingual', rapidUnload: true, passed: true});
    }
    report.quickClose = true;
    await featureDrawer('image'); assert.equal(await page.locator('.image-method kbd').count(), 0, 'No repeated inline area shortcut');
    assert.equal(await page.locator('[data-testid="area-translation-demo"] .area-hotkey').count(), 1);
    assert(await page.locator('[data-testid="area-translation-demo"] kbd').count() > 0, 'Area shortcut remains in the operation preview');
    await shot('popup-image-single-shortcut'); await closeDrawer();
    report.cases.push({name: 'popup-image-shortcut', singlePreview: true, passed: true});

    if (auditSections !== 'false') {
      currentCase = 'settings-section-audit'; await openOptions();
      const sections = await page.locator('.sidebar nav [data-section], aside nav [data-section]').evaluateAll(nodes => [...new Set(nodes.map(node => node.dataset.section))]);
      assert.equal(sections.length, 16, 'Audit must cover all 16 top-level setting sections'); report.auditedSections = sections;
      const combinations = auditSections === 'desktop' ? [[1440, 'light']] : [[1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']];
      for (const [width, theme] of combinations) {
        await patchFixture({uiLanguage: 'zh-CN', theme, interfaceSkin: 'default'});
        for (const section of sections) {
          await openOptions(section, {width, height: width === 390 ? 844 : 960});
          const label = `audit-${section}-${theme}-${width}`; await shot(label); report.cases.push({name: label, rendered: true, passed: true});
        }
      }
    }
    await focus('complete'); cleanConsole('complete'); report.ok = true;
  } catch (error) {
    primaryError = error; report.ok = false; report.failure = {case: currentCase, message: error.message, stack: error.stack};
    // A focus failure must stop all further UI work, including failure screenshots.
    if (!focusViolation && page && !page.isClosed() && browserPid) {
      try {await focus('before:failure'); const file = path.join(artifactsDir, 'failure.png'); await page.screenshot({path: file}); await focus('after:failure'); report.screenshots.push(file);} catch (captureError) {report.failureCaptureError = captureError.message;}
    }
  } finally {
    try {
      if (session) {await session.close(); report.cleanup = {ownedBrowserClosed: true}; fs.rmSync(profileDir, {recursive: true, force: true}); report.cleanup.profileRemoved = true;}
      else if (!launchAttempted) {fs.rmSync(profileDir, {recursive: true, force: true}); report.cleanup = {profileRemoved: true, browserNotStarted: true};}
      else report.cleanup = {profileRetained: true, reason: 'launch did not return a verified owned session'};
    } catch (error) {report.ok = false; report.cleanup = {profileRetained: true, message: error.message}; primaryError ||= error;}
    report.finishedAt = new Date().toISOString(); saveReport();
  }
  if (primaryError) throw primaryError;
  process.stdout.write(JSON.stringify({ok: report.ok, reportPath, screenshots: report.screenshots.length, cases: report.cases.length, pageNavigations: report.pageNavigations}, null, 2) + '\n');
}
main().catch(error => {process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1;});
