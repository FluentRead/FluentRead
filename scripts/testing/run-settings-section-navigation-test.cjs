'use strict';
/**
 * @file scripts/testing/run-settings-section-navigation-test.cjs
 * 文件职责：在隔离生产扩展中验证连续设置页顶部导航的定位与滚动高亮。
 * 主要内容：检查九个长表单的全部入口、折叠展开、搜索与跨页直达、手动滚动、窄屏横向导航、主题和语言，并确认统计与网站规则仍切换视图，导航不写配置或改路由。
 * 模块边界：使用临时 Edge profile 和不抢焦点 helper，不操作用户浏览器、不请求翻译或下载模型；不代表 Firefox 运行时或全量回归。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index < 0 ? fallback : process.argv[index + 1]; };
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifacts = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-settings-section-navigation'));
const packages = arg('playwright-root');
const helper = arg('focus-safe-helper');
assert(packages && helper, 'Provide bundled Playwright and focus-safe helper paths');
const {chromium} = require(path.join(packages, 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(helper);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-settings-anchors-'));
fs.mkdirSync(artifacts, {recursive: true});
const report = {ok: false, artifact: 'production', extensionDir, caseCoverage: [], layouts: [], screenshots: [], consoleErrors: []};
let session, page;
const save = () => fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
async function shot(name) {
  const file = path.join(artifacts, `${name}.png`);
  await page.screenshot({path: file}); report.screenshots.push(file);
}
async function layout(label) {
  const metrics = await page.evaluate(() => {
    const content = document.querySelector('.settings-card');
    const nav = document.querySelector('.settings-section-navigation');
    return {width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight, scrollX, scrollY,
      contentWidth: content.clientWidth, contentScrollWidth: content.scrollWidth,
      contentHeight: content.clientHeight, navHeight: nav?.clientHeight};
  });
  assert(metrics.documentWidth <= metrics.width + 1 && metrics.documentHeight <= metrics.height + 1 && !metrics.scrollX && !metrics.scrollY, `${label}: document overflow`);
  assert(metrics.contentScrollWidth <= metrics.contentWidth + 1 && metrics.contentHeight > 250, `${label}: content overflow or too short`);
  if (metrics.navHeight) assert(metrics.navHeight < 70, `${label}: navigation wraps`);
  report.layouts.push({label, ...metrics});
}
async function navigate(section) {
  if (await page.locator('.mobile-settings-navigation').isVisible()) await page.locator('.mobile-settings-navigation').selectOption(section);
  else await page.locator(`.sidebar [data-section="${section}"]`).click();
  await page.waitForFunction(id => location.hash === `#${id}`, section);
}
async function anchorState(id) {
  return page.evaluate(id => {
    const container = document.querySelector('.settings-card');
    const target = [...container.querySelectorAll('[data-settings-anchor], [data-settings-panel]')]
      .find(el => (el.dataset.settingsAnchor || el.dataset.settingsPanel) === id && el.getClientRects().length);
    const top = container.scrollTop + target.getBoundingClientRect().top - container.getBoundingClientRect().top - container.clientTop - 2;
    const expected = Math.max(0, Math.min(top, container.scrollHeight - container.clientHeight));
    return {top: container.scrollTop, expected, delta: Math.abs(expected - container.scrollTop),
      current: document.querySelector('.settings-section-navigation [aria-current]')?.dataset.settingsAnchorLink,
      open: target.tagName !== 'DETAILS' || target.open};
  }, id);
}
async function clickAnchor(id) {
  const hash = await page.evaluate(() => location.hash);
  const beforeCount = await page.locator('[data-settings-panel]:visible, [data-settings-anchor]:visible').count();
  await page.locator(`[data-settings-anchor-link="${id}"]`).click();
  await page.waitForFunction(id => {
    const c = document.querySelector('.settings-card');
    const target = [...c.querySelectorAll('[data-settings-anchor], [data-settings-panel]')]
      .find(el => (el.dataset.settingsAnchor || el.dataset.settingsPanel) === id && el.getClientRects().length);
    const top = c.scrollTop + target.getBoundingClientRect().top - c.getBoundingClientRect().top - c.clientTop - 2;
    return Math.abs(c.scrollTop - Math.max(0, Math.min(top, c.scrollHeight - c.clientHeight))) < 4;
  }, id);
  const state = await anchorState(id);
  assert(state.open, `${id}: collapsed target not opened`);
  assert.equal(state.current, id, `${id}: wrong highlighted anchor`);
  assert.equal(await page.evaluate(() => location.hash), hash, 'Anchor changes the page route');
  assert.equal(await page.locator('[data-settings-panel]:visible, [data-settings-anchor]:visible').count(), beforeCount, 'Anchor hides other modules');
  report.caseCoverage.push({section: hash, anchor: id, ...state});
}
async function readConfig() {
  return page.evaluate(async () => {
    const result = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
    if (!result.success) throw new Error(result.error);
    return typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
  });
}
async function patch(patch) {
  const current = await readConfig();
  const expected = Object.fromEntries(Object.keys(patch).map(key => [key, current[key]]));
  const result = await page.evaluate(({patch, expected}) => chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: patch, expected}), {patch, expected});
  assert(result.success, result.error);
}
(async () => {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
    report.manifest = {options: manifest.options_page || manifest.options_ui?.page, popup: manifest.action?.default_popup};
    assert(report.manifest.options && report.manifest.popup);
    session = await launchFocusSafePersistentContext({chromium, profileDir: profile, background: true, headless: false,
      displayTarget: 'secondary', browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      viewport: {width: 1440, height: 960}, timeout: 30000,
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    Object.assign(report, {launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement});
    assert.equal(session.launchMode, 'macos-background-cdp');
    assert.equal(session.windowPlacement.browserFrontmost, false);
    const context = session.context;
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 30000});
    const base = worker.url().match(/^chrome-extension:\/\/[^/]+/)[0];
    page = await newPageWithoutForeground(context, 30000);
    page.on('pageerror', error => report.consoleErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    await page.goto(`${base}/${report.manifest.options}`, {waitUntil: 'domcontentloaded'});
    await page.locator('[data-settings-anchor-link="basics"]').waitFor();
    const initialConfig = await readConfig();
    await page.emulateMedia({reducedMotion: 'reduce'});
    const sections = ['general', 'translation', 'interface', 'selection', 'image-translation', 'video', 'writing', 'advanced', 'data'];
    for (const name of sections) {
      await navigate(`settings-${name}`);
      await page.locator('.settings-section-navigation button').first().waitFor();
      const ids = await page.locator('[data-settings-anchor-link]').evaluateAll(items => items.map(item => item.dataset.settingsAnchorLink));
      assert(ids.length >= 2 && new Set(ids).size === ids.length, `${name}: invalid anchors`);
      for (const id of ids) await clickAnchor(id);
      await layout(name);
      await clickAnchor(ids[0]);
      if (['general', 'translation', 'image-translation'].includes(name)) await shot(`${name}-desktop`);
    }
    assert.deepEqual(await readConfig(), initialConfig, 'Navigation writes user configuration');
    report.navigationPreservesConfig = true;
    await navigate('settings-selection');
    await patch({selectionTranslatorMode: 'bilingual'});
    await page.locator('[data-settings-anchor-link="trigger"]').waitFor();
    await clickAnchor('trigger'); await clickAnchor('learning');
    await patch({selectionTranslatorMode: 'disabled'});
    await page.waitForFunction(() => !document.querySelector('[data-settings-anchor-link="trigger"]'));
    await patch({selectionTranslatorMode: initialConfig.selectionTranslatorMode});
    report.conditionalAnchors = true;
    await navigate('settings-translation');
    await page.emulateMedia({reducedMotion: 'no-preference'});
    await clickAnchor('input');
    await shot('translation-input');
    const hoverLink = page.locator('[data-settings-anchor-link="hover"]');
    await hoverLink.focus(); await hoverLink.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-settings-anchor-link="hover"]')?.getAttribute('aria-current') === 'location');
    await page.waitForFunction(() => {
      const c = document.querySelector('.settings-card');
      const target = [...c.querySelectorAll('[data-settings-panel="hover"]')].find(el => el.getClientRects().length);
      return Math.abs(target.getBoundingClientRect().top - c.getBoundingClientRect().top - 2) < 4;
    });
    assert((await anchorState('hover')).delta < 4, 'Keyboard navigation misses target');
    report.keyboardNavigation = true;
    // 手动滚动的高亮只读取内容滚动位置。
    await page.locator('.settings-card').hover();
    await page.mouse.wheel(0, -10000);
    await page.waitForFunction(() => document.querySelector('[data-settings-anchor-link="reading"]')?.getAttribute('aria-current') === 'location');
    await page.mouse.wheel(0, 10000);
    await page.waitForFunction(() => document.querySelector('[data-settings-anchor-link="tools"]')?.getAttribute('aria-current') === 'location');
    report.scrollHighlight = true;
    await page.emulateMedia({reducedMotion: 'reduce'});
    for (const [query, anchor] of [['输入框', 'input'], ['界面字体', 'font'], ['翻译缓存', 'cache']]) {
      await page.locator('.search-box input').fill(query);
      await page.locator('.search-results button').first().click();
      await page.waitForFunction(id => document.querySelector(`[data-settings-anchor-link="${id}"]`)?.getAttribute('aria-current') === 'location', anchor);
      assert((await anchorState(anchor)).delta < 4, `${query}: search misses continuation target`);
    }
    // 搜索与顶部导航各自的延迟定位必须在后续操作时交接，不争抢滚动位置。
    await clickAnchor('recognition');
    await page.locator('.search-box input').fill('翻译缓存');
    await page.locator('.search-results button').first().click();
    await page.waitForFunction(() => document.querySelector('[data-settings-anchor-link="cache"]')?.getAttribute('aria-current') === 'location');
    await clickAnchor('recognition');
    await page.waitForTimeout(300);
    assert((await anchorState('recognition')).delta < 4, 'Search observer overrides an anchor click');
    await navigate('settings-general');
    await page.locator('[data-testid="open-floating-ball-settings"]').click();
    await page.waitForFunction(() => document.querySelector('[data-settings-anchor-link="tools"]')?.getAttribute('aria-current') === 'location');
    report.searchAndCrossPageLinks = true;
    for (const section of ['settings-translation-stats', 'settings-sites']) {
      await navigate(section);
      await page.locator('[data-settings-category]').first().waitFor();
      assert.equal(await page.locator('[data-settings-anchor-link]').count(), 0);
      const categories = await page.locator('[data-settings-category]').evaluateAll(items => items.map(item => item.dataset.settingsCategory));
      for (const id of categories) {
        await page.locator(`[data-settings-category="${id}"]`).click();
        await page.waitForFunction(id => [...document.querySelectorAll('[data-settings-panel]')].filter(el => el.getClientRects().length).every(el => el.dataset.settingsPanel === id), id);
      }
    }
    report.existingViewTabsPreserved = true;
    await navigate('settings-interface');
    for (const width of [1024, 820, 390]) {
      await page.setViewportSize({width, height: 960});
      await clickAnchor('font'); await layout(`interface-${width}`);
      const visible = await page.locator('[data-settings-anchor-link="font"]').evaluate(el => {
        const a = el.getBoundingClientRect(), b = el.parentElement.getBoundingClientRect();
        return a.left >= b.left - 1 && a.right <= b.right + 1;
      });
      assert(visible, 'Active anchor not scrolled into view');
    }
    await patch({theme: 'dark'});
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
    await shot('interface-mobile-dark');
    await patch({uiLanguage: 'en-US'});
    await page.waitForFunction(() => document.querySelector('[data-settings-anchor-link="font"]')?.textContent.includes('font'));
    await page.waitForFunction(() => {
      const button = document.querySelector('[data-settings-anchor-link="font"]');
      const a = button.getBoundingClientRect(), b = button.parentElement.getBoundingClientRect();
      return a.left >= b.left - 1 && a.right <= b.right + 1;
    });
    await layout('interface-mobile-english'); await shot('interface-mobile-english');
    report.localizedAnchors = [];
    for (const name of sections) {
      await navigate(`settings-${name}`);
      await page.locator('.settings-section-navigation button').first().waitFor();
      const labels = await page.locator('[data-settings-anchor-link]').allTextContents();
      assert(labels.every(label => label.trim() && !/\p{Script=Han}/u.test(label)), `${name}: unlocalized anchors ${labels.join('|')}`);
      report.localizedAnchors.push({section: name, labels});
    }
    assert.equal(report.consoleErrors.length, 0, report.consoleErrors.join('\n'));
    report.ok = true; save();
    console.log(JSON.stringify({ok: true, cases: report.caseCoverage.length, report: path.join(artifacts, 'report.json')}));
  } catch (error) {
    report.error = error.stack || String(error); save();
    if (page) await shot('failure').catch(() => {});
    save(); console.error(report.error); process.exitCode = 1;
  } finally {
    if (session) await session.close().catch(() => {});
    fs.rmSync(profile, {recursive: true, force: true});
  }
})();
