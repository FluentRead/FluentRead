#!/usr/bin/env node
'use strict';
/**
 * @file scripts/testing/run-page-translation-font-ui-test.cjs
 * 全局译文字体专项：用临时、后台可见且不抢焦点的 Edge 和本地确定性服务，
 * 从主面板真实 Aa 开关验证浏览器默认字体、双语/仅译文、跨页同步及持久化，
 * 同时检查图标两态保持尺寸和位置、译文字号不变，以及统一提示的悬停、聚焦与 Escape 关闭。
 * 仅使用 getPageTranslationFontState 读取状态；字体写入必须通过真实按钮。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const argument = (name, fallback) => {const index = process.argv.indexOf(`--${name}`); return index < 0 ? fallback : process.argv[index + 1];};
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const subset = (actual, expected) => expected && typeof expected === 'object' && !Array.isArray(expected)
  ? actual && Object.entries(expected).every(([key, value]) => subset(actual[key], value))
  : JSON.stringify(actual) === JSON.stringify(expected);
const DEFAULT_APPEARANCE = {textColor: '', backgroundColor: '', lineColor: '', fillColor: '', fontScale: 100,
  fontWeight: 'default', fontFamily: 'default', opacity: 100, customCss: ''};
const TEXT = {
  primary: 'Reading an article should not require deciphering a decorative website font. This paragraph is the existing translation.',
  secondary: 'A newly translated paragraph should use the same selected reading font without another settings visit.',
  emphasis: 'Emphasized ordinary text keeps its meaning and remains readable.',
  dynamic: 'Content arriving after full page translation should immediately use the saved global font choice.',
};
const TRANSLATED = {
  primary: '阅读文章不该需要辨认装饰性的网页字体。这一段用于验证已有译文。',
  secondary: '后来翻译的段落应当使用相同的阅读字体，无需再次访问设置。',
  emphasis: '强调的普通文字保留其含义，并且仍然清晰可读。',
  dynamic: '全文翻译后出现的新内容应当立即使用已保存的全局字体。',
};

async function startFixture() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', '*');
    if (request.method === 'OPTIONS') {response.writeHead(204); response.end(); return;}
    if (request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      let body;
      try {body = JSON.parse(Buffer.concat(chunks).toString());}
      catch {response.writeHead(400, {'Content-Type': 'application/json'}); response.end(JSON.stringify({error: {message: 'Invalid local fixture JSON'}})); return;}
      if (!Array.isArray(body?.messages)) {response.writeHead(400); response.end(); return;}
      const prompt = body.messages.filter(item => item?.role === 'user').map(item => item.content).join('\n');
      const source = /SOURCE_BEGIN([\s\S]*?)SOURCE_END/u.exec(prompt)?.[1] || '';
      requests.push({source, at: Date.now()});
      const translated = Object.entries(TEXT).reduce((text, [key, value]) => text.replaceAll(value, TRANSLATED[key]), source);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({id: 'page-translation-font-fixture', object: 'chat.completion', created: 1, model: 'fixture',
        choices: [{index: 0, message: {role: 'assistant', content: translated}, finish_reason: 'stop'}]}));
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Global translation font fixture</title>
      <style>
        body{margin:0;padding:48px 7vw;color:#243044;background:#fff;font:18px/1.8 cursive!important}
        main{max-width:1000px;margin:auto}h1{font-size:28px}p{margin:30px 0;font-family:monospace!important}
        strong,a{font-family:fantasy!important}code{font-family:monospace!important;color:#7c2d12;background:#fff7ed}
        math{font-family:serif!important}a{color:#1d4ed8}footer{font-size:14px}
      </style></head><body><main><h1 translate="no">全局译文字体确定性夹具</h1>
      <p id="primary">${TEXT.primary} <strong id="source-emphasis">${TEXT.emphasis}</strong>
        <code id="source-code">const untouched = 42;</code>
        <math id="source-math" xmlns="http://www.w3.org/1998/Math/MathML"><mrow><mi>x</mi><mo>+</mo><mn>2</mn></mrow></math>
      </p><p id="secondary">${TEXT.secondary}</p><footer translate="no">Host fonts are intentionally cursive, monospace and fantasy.</footer>
      </main></body></html>`);
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  return {url: `http://127.0.0.1:${server.address().port}`, requests,
    close: () => new Promise(resolve => {server.close(resolve); server.closeAllConnections();})};
}

async function main() {
  const extensionDir = path.resolve(argument('extension-dir', '.output/chrome-mv3'));
  const artifactsDir = path.resolve(argument('artifacts-dir', '/private/tmp/fluentread-page-translation-font'));
  const packages = argument('playwright-root');
  const helperPath = argument('focus-safe-helper', path.join(__dirname, 'focus-safe-browser.cjs'));
  const diagnosticsHelperPath = path.resolve(argument('runtime-diagnostics-helper', path.join(os.homedir(), '.codex', 'skills',
    'fluentread-extension-ui-test', 'scripts', 'runtime-diagnostics.cjs')));
  assert(packages, '需要 --playwright-root');
  assert(fs.existsSync(path.join(extensionDir, 'manifest.json')), `缺少扩展产物 ${extensionDir}`);
  assert(fs.existsSync(helperPath), '缺少 focus-safe helper');
  assert(fs.existsSync(diagnosticsHelperPath), '缺少 runtime diagnostics helper，请用 --runtime-diagnostics-helper 指定 UI 技能的 scripts/runtime-diagnostics.cjs');
  assert(!process.argv.includes('--headed') && !process.argv.includes('--headless'), '本专项只允许真实后台可见、无前台焦点模式');
  const {chromium} = require(require.resolve('playwright', {paths: [packages]}));
  const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground} = require(helperPath);
  const {createRuntimeDiagnostics, finalizeRun, redact} = require(diagnosticsHelperPath);
  const diagnostics = createRuntimeDiagnostics();
  fs.mkdirSync(artifactsDir, {recursive: true});
  const report = {ok: false, extensionDir, artifactsDir, diagnosticsHelperPath, checks: [], screenshots: [], metrics: {},
    evidenceBoundary: 'Real production/dev MV3 Edge runtime, real main-panel Aa toggle clicks, local deterministic HTML/provider and measured author-style-free browser baseline. This does not establish Firefox, a live provider, every website, or the reporter environment.'};
  let profileDir;
  let fixture;
  let launched;
  let launchAttempted = false;
  let failure;
  try {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-page-font-edge-'));
    report.profileDir = profileDir;
    fixture = await startFixture();
    launchAttempted = true;
    launched = await launchFocusSafePersistentContext({chromium, profileDir, background: true, headless: false,
      displayTarget: argument('display', 'secondary'),
      browserPath: argument('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      viewport: {width: 1280, height: 900}, timeout: 30000,
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    assert.equal(report.launchMode, 'macos-background-cdp');
    assert.equal(report.focusPolicy, 'launchservices-no-foreground');
    assert.equal(report.windowPlacement.mode, 'background-visible-no-focus');
    assert.equal(report.windowPlacement.browserFrontmost, false);
    const context = launched.context;
    // 先附加 CDP Runtime/Log，再创建和导航测试页；内容脚本的隔离世界与未处理异常由同一采集器观测。
    // Target 发现订阅覆盖本轮后来启动的扩展 Service Worker，附加空窗保存在 coverage.limitations。
    await diagnostics.start(context);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 30000});
    const extensionOrigin = /^chrome-extension:\/\/[^/]+/u.exec(worker.url())[0];
    diagnostics.setExtensionId(new URL(extensionOrigin).host);
    diagnostics.setPhase('popup-initialization');
    const createPage = async (url, viewport) => {
      const page = await newPageWithoutForeground(context, 30000);
      await diagnostics.attachPage(page, url.startsWith(extensionOrigin) ? 'popup' : `fixture-${new URL(url).pathname}`);
      if (viewport) await page.setViewportSize(viewport);
      await page.goto(url, {waitUntil: 'domcontentloaded'});
      return page;
    };
    const shot = async (page, name) => {
      const file = path.join(artifactsDir, `${name}.png`);
      await page.screenshot({path: file, fullPage: false});
      report.screenshots.push(file);
      if (name === '02-aa-main-browser-default') {
        const cardFile = path.join(artifactsDir, '02-independent-buttons-card.png');
        await page.locator('[data-popup-module="translation"]').screenshot({path: cardFile});
        report.screenshots.push(cardFile);
      }
    };
    let popup = await createPage(`${extensionOrigin}/popup.html`, {width: 360, height: 600});
    const readConfig = () => popup.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      if (!response?.success) throw new Error(response?.error || 'configuration read failed');
      return typeof response.value === 'string' ? JSON.parse(response.value) : response.value;
    });
    const untilConfig = async predicate => {
      for (let attempt = 0; attempt < 200; attempt++) {const config = await readConfig(); if (config && predicate(config)) return config; await delay(50);}
      throw new Error('configuration did not converge');
    };
    await untilConfig(config => config.service && config.to);
    const patchConfig = async patch => {
      const current = await readConfig();
      const initial = Object.hasOwn(patch, 'token');
      const expected = Object.fromEntries(Object.keys(patch).map(key => [key, current[key]]));
      const response = await popup.evaluate(({patch, current, expected, initial}) => chrome.runtime.sendMessage({
        type: 'persistConfig', mode: initial ? 'replace' : 'patch', config: initial ? {...current, ...patch} : patch, expected,
        baseRevision: initial ? current.__fluentConfigRevision : undefined, clientId: `page-font-${crypto.randomUUID()}`, sequence: 1,
      }), {patch, current, expected, initial});
      assert.equal(response?.success, true, response?.error);
      await untilConfig(config => Object.keys(patch).filter(key => key !== 'token').every(key => subset(config[key], patch[key])));
    };
    const service = 'custom:page-font-fixture';
    diagnostics.setPhase('fixture-configuration');
    await patchConfig({uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, on: true, theme: 'light', interfaceSkin: 'default',
      display: 1, style: 1, translationAppearance: DEFAULT_APPEARANCE, browserDefaultTranslationFont: false, service, from: 'en', to: 'zh-Hans', useCache: false,
      autoTranslate: false, bilingualSentenceHighlightEnabled: false, translationBeforeOriginal: false,
      customOpenAIProviders: [{id: service, name: '全局字体夹具', endpoint: `${fixture.url}/v1/chat/completions`, models: ['fixture']}],
      token: {[service]: 'synthetic-local-fixture-not-a-secret'}, model: {[service]: 'fixture'},
      user_role: {[service]: 'SOURCE_BEGIN{{origin}}SOURCE_END'}, enableAIContext: false, enableAIMultiSegment: false,
      glossaryEnabled: false, hotkey: 'Control', floatingBallHotkey: 'Alt+T', mouseHoverTranslationDelay: 0,
      selectionTranslatorMode: 'disabled', disableSelectionTranslator: true, animations: false});
    const page = await createPage(`${fixture.url}/article`);
    const other = await createPage(`${fixture.url}/other`);
    await page.locator('#fluent-read-page-styles').waitFor({state: 'attached'});
    await other.locator('#fluent-read-page-styles').waitFor({state: 'attached'});
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
    const otherTabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, other.url());
    assert(Number.isInteger(tabId) && Number.isInteger(otherTabId));
    const globalTabs = new Set([tabId, otherTabId]);
    const popupUrl = id => `${extensionOrigin}/popup.html?sourceTabId=${id}`;
    diagnostics.setPhase('popup-automatic-font-read');
    await popup.goto(popupUrl(tabId), {waitUntil: 'domcontentloaded'});
    const waitPopup = async () => {
      await activateExtensionTabWithoutForeground(context, popup, 30000);
      await popup.locator('.popup-shell[data-config-ready="true"]').waitFor({state: 'visible'});
      await popup.getByTestId('page-font-entry').waitFor({state: 'visible'});
      await popup.waitForFunction(() => {
        const button = document.querySelector('[data-testid="page-font-entry"]');
        return button && !button.disabled && ['host', 'browser-default'].includes(button.getAttribute('data-font-state'));
      });
    };
    const assertFontButton = async enabled => {
      await waitPopup();
      await popup.waitForFunction(value => {
        const button = document.querySelector('[data-testid="page-font-entry"]');
        return button?.getAttribute('aria-pressed') === String(value)
          && button.getAttribute('data-font-state') === (value ? 'browser-default' : 'host') && !button.disabled;
      }, enabled);
      assert.equal(await popup.getByTestId('page-font-entry').locator('svg').getAttribute('data-font-style'), enabled ? 'sans' : 'serif', 'Aa 应以字体造型表达当前状态');
      assert.equal(await popup.locator('.drawer-surface:visible').count(), 0, 'Aa 字体切换不应打开设置抽屉');
      assert.equal(await popup.getByTestId('page-font-error').count(), 0, '字体状态不得在卡片下方追加说明');
    };
    await waitPopup();
    await assertFontButton(false);
    assert.notEqual((await readConfig()).popupQuickFeatureVisibility?.appearance, true, '专项不得为了找到入口而开启隐藏的外观快捷卡');
    assert.equal(await popup.locator('[data-popup-quick-feature="appearance"]').count(), 0, '新配置的外观快捷卡应保持默认隐藏');
    assert.equal((await readConfig()).browserDefaultTranslationFont, false, '新配置的全局字体偏好应默认关闭');
    report.checks.push('default configuration exposes the permanent Aa toggle, reads the saved global preference, and leaves the optional appearance quick card hidden');
    const readState = id => popup.evaluate(async tab => chrome.tabs.sendMessage(tab, {type: 'getPageTranslationFontState'}, {frameId: 0}), id);
    const untilState = async (id, enabled) => {
      for (let attempt = 0; attempt < 160; attempt++) {
        const state = await readState(id);
        if (state?.status === 'success' && state.browserDefault === enabled) return state;
        await delay(50);
      }
      throw new Error(`page font state ${enabled} did not converge`);
    };
    const chooseFont = async enabled => {
      await waitPopup();
      const displayBefore = (await readConfig()).display;
      const button = popup.getByTestId('page-font-entry');
      if (await button.getAttribute('aria-pressed') !== String(enabled)) await button.click();
      await untilConfig(config => config.browserDefaultTranslationFont === enabled);
      for (const id of globalTabs) await untilState(id, enabled);
      await assertFontButton(enabled);
      assert.equal((await readConfig()).display, displayBefore, '字体按钮不得更改双语/仅译文模式');
      await popup.getByTestId('page-translation').hover();
      await popup.getByTestId('page-font-tooltip').waitFor({state: 'hidden'});
    };
    const inspectFontTooltip = async (enabled, keyboard = false) => {
      await assertFontButton(enabled);
      const button = popup.getByTestId('page-font-entry');
      if (keyboard) await button.focus();
      else {await popup.mouse.move(1, 1); await button.hover();}
      const tooltip = popup.getByTestId('page-font-tooltip');
      try {await tooltip.waitFor({state: 'visible', timeout: 5000});}
      catch (error) {
        report.metrics.tooltipFailure = await button.evaluate(element => ({button: element.outerHTML,
          active: {tag: document.activeElement?.tagName, class: document.activeElement?.className}, visible: document.visibilityState,
          hover: element.matches(':hover'), focus: element.matches(':focus'),
          tooltips: [...document.querySelectorAll('.el-popper')].map(node => ({html: node.outerHTML, display: getComputedStyle(node).display}))}));
        await shot(popup, 'tooltip-failure');
        throw error;
      }
      const action = enabled ? '恢复原有字体' : '使用浏览器默认字体';
      assert.equal(await tooltip.locator(':scope > span').innerText(), action, '字体提示应直接说明点击后的操作');
      assert.equal(await button.getAttribute('aria-label'), '使用浏览器默认字体', '字体开关应保持稳定功能名，由 aria-pressed 表达当前状态');
      assert.equal(await tooltip.locator('small').innerText(), '所有网页生效，自动保存', '字体提示应说明全局作用范围与自动保存');
      assert.equal(await tooltip.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " translation-tool-tooltip ")]').count(), 1, '字体提示应使用统一浮层');
      await shot(popup, `06-aa-tooltip-${enabled ? 'browser-default' : 'host'}-${keyboard ? 'keyboard' : 'hover'}`);
      await popup.keyboard.press('Escape');
      await tooltip.waitFor({state: 'hidden'});
      await popup.getByTestId('page-translation').hover();
      await popup.getByTestId('page-translation').focus();
    };
    const inspectDisplayModeTooltip = async (mode, keyboard = false, disabled = false) => {
      await waitPopup();
      const button = popup.getByTestId('popup-display-mode');
      await popup.waitForFunction(({mode, disabled}) => {
        const target = document.querySelector('[data-testid="popup-display-mode"]');
        return target?.getAttribute('data-display-mode') === mode && target.disabled === disabled;
      }, {mode, disabled});
      assert.equal(await button.getAttribute('title'), null, '显示模式不应再使用浏览器原生提示');
      const expected = mode === 'bilingual' ? '只显示译文' : '显示原文和译文';
      assert.equal(await button.getAttribute('aria-label'), '显示原文和译文', '显示模式开关应保持稳定功能名，由 aria-pressed 表达当前状态');
      assert.equal(await button.getAttribute('aria-description'), null, '可用状态不应附加禁用说明');
      await popup.getByTestId('page-translation').focus();
      if (keyboard) await button.focus();
      else {await popup.mouse.move(1, 1); await button.hover();}
      const tooltip = popup.getByTestId('display-mode-tooltip');
      await tooltip.waitFor({state: 'visible', timeout: 5000});
      assert.equal(await tooltip.innerText(), expected, '显示模式提示应直接说明点击后的操作');
      assert.equal(await tooltip.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " translation-tool-tooltip ")]').count(), 1, '显示模式提示应与字体提示使用统一浮层');
      await shot(popup, `07-mode-tooltip-${mode}-${keyboard ? 'keyboard' : 'hover'}`);
      await popup.keyboard.press('Escape');
      await tooltip.waitFor({state: 'hidden'});
      await popup.getByTestId('page-translation').hover();
      await popup.getByTestId('page-translation').focus();
    };
    const noNewRequests = async (count, label) => {await delay(350); assert.equal(fixture.requests.length, count, `${label} triggered translation requests`);};
    const hover = async (target, id) => {
      await activateExtensionTabWithoutForeground(context, target, 30000);
      await target.locator(`#${id}`).hover();
      await target.keyboard.down('Control'); await target.keyboard.up('Control');
    };
    const sourceMetrics = () => page.evaluate(() => {
      const font = selector => getComputedStyle(document.querySelector(selector)).fontFamily;
      return {primary: font('#primary'), emphasis: font('#source-emphasis'), code: font('#source-code'), math: font('#source-math'),
        codeHtml: document.querySelector('#source-code').outerHTML, mathHtml: document.querySelector('#source-math').outerHTML,
        primaryHtml: document.querySelector('#primary').innerHTML};
    });
    const original = await sourceMetrics();
    const browserDefault = await page.evaluate(async () => {
      const frame = document.createElement('iframe');
      frame.setAttribute('title', 'browser font measurement');
      frame.style.display = 'none';
      const ready = new Promise(resolve => frame.addEventListener('load', resolve, {once: true}));
      frame.srcdoc = '<!doctype html><html><body><p id="baseline">Aa 浏览器默认字体</p></body></html>';
      document.body.append(frame); await ready;
      const font = frame.contentWindow.getComputedStyle(frame.contentDocument.getElementById('baseline')).fontFamily;
      frame.remove(); return font;
    });
    assert.notEqual(original.primary, browserDefault, '夹具字体必须与浏览器无作者样式基准不同');
    report.metrics.browserDefaultFont = browserDefault;
    report.metrics.originalFonts = {primary: original.primary, emphasis: original.emphasis, code: original.code, math: original.math};
    const bilingual = id => page.locator(`#${id} > .fluent-read-bilingual-content`);
    const waitBilingual = async (id, target = page) => {
      await target.locator(`#${id} > .fluent-read-bilingual-content`).waitFor({state: 'attached'});
      await target.waitForFunction(({id, text}) => document.querySelector(`#${id} > .fluent-read-bilingual-content`)?.textContent.includes(text), {id, text: TRANSLATED[id]});
    };
    const fontOf = locator => locator.evaluate(element => getComputedStyle(element).fontFamily);
    const fontSizeOf = locator => locator.evaluate(element => getComputedStyle(element).fontSize);
    const waitFont = async (locator, expected) => {
      await locator.waitFor({state: 'attached'});
      for (let attempt = 0; attempt < 160; attempt++) {if (await fontOf(locator) === expected) return; await delay(50);}
      assert.equal(await fontOf(locator), expected);
    };
    const assertOriginalUnchanged = async label => {
      const current = await sourceMetrics();
      for (const key of ['primary', 'emphasis', 'code', 'math', 'codeHtml', 'mathHtml']) assert.equal(current[key], original[key], `${label}: source ${key} changed`);
    };

    // 已有双语译文、普通后代、代码和公式，以及之后新增的双语译文。
    diagnostics.setPhase('bilingual-font-toggle-and-tooltip');
    await hover(page, 'primary'); await waitBilingual('primary');
    await waitFont(bilingual('primary'), original.primary);
    await hover(other, 'primary'); await waitBilingual('primary', other);
    const otherTranslation = other.locator('#primary > .fluent-read-bilingual-content');
    await waitFont(otherTranslation, original.primary);
    const baselineState = await untilState(tabId, false);
    const translatedCode = bilingual('primary').locator('code');
    const translatedMath = bilingual('primary').locator('math');
    assert.equal(await translatedCode.count(), 1, '夹具必须覆盖译文内保留的代码');
    assert.equal(await translatedMath.count(), 1, '夹具必须覆盖译文内保留的公式');
    const protectedBefore = {code: await fontOf(translatedCode), math: await fontOf(translatedMath)};
    const bilingualSizes = async () => ({primary: await fontSizeOf(bilingual('primary')),
      emphasis: await fontSizeOf(bilingual('primary').locator('strong')), code: await fontSizeOf(translatedCode), math: await fontSizeOf(translatedMath)});
    const bilingualSizesBefore = await bilingualSizes();
    let count = fixture.requests.length;
    // 首次真实翻译计数通过配置广播到 Popup；等这次重绘完成再悬停，避免异步移位离开指针。
    await popup.waitForFunction(() => parseInt(document.querySelector('.popup-translation-count')?.textContent || '', 10) > 0);
    await assertFontButton(false);
    await shot(popup, '00-aa-main-host-font');
    await inspectFontTooltip(false);
    await inspectFontTooltip(false, true);
    await chooseFont(true);
    await waitFont(bilingual('primary'), browserDefault);
    await waitFont(otherTranslation, browserDefault);
    await waitFont(bilingual('primary').locator('strong'), browserDefault);
    assert.equal(await fontOf(translatedCode), protectedBefore.code, '译文内代码字体被改写');
    assert.equal(await fontOf(translatedMath), protectedBefore.math, '译文内公式字体被改写');
    const bilingualSizesEnabled = await bilingualSizes();
    assert.deepEqual(bilingualSizesEnabled, bilingualSizesBefore, '切换浏览器默认字体不得放大双语译文或其后代字号');
    await assertOriginalUnchanged('bilingual browser default');
    await noNewRequests(count, 'existing bilingual font change');
    await shot(page, '01-bilingual-browser-default');
    await shot(popup, '02-aa-main-browser-default');
    await inspectFontTooltip(true);
    await inspectFontTooltip(true, true);
    report.checks.push('hover and keyboard focus reveal the direct font action and concise all-pages autosave hint in both states; Escape dismisses the font tooltip');
    await hover(page, 'secondary'); await waitBilingual('secondary');
    await waitFont(bilingual('secondary'), browserDefault);
    report.checks.push('the real Aa toggle saves the global preference and updates existing translations in both already-open tabs plus later bilingual translations without a drawer; original, code and formula fonts remain unchanged');

    // 关闭恢复网页/全局外观；再开启覆盖全局自定义 CSS；任何字体操作都不能请求翻译。
    diagnostics.setPhase('custom-appearance-font-restoration');
    count = fixture.requests.length;
    await chooseFont(false); await waitFont(bilingual('primary'), original.primary);
    await waitFont(otherTranslation, original.primary);
    await waitFont(bilingual('primary').locator('strong'), original.emphasis);
    const bilingualSizesRestored = await bilingualSizes();
    assert.deepEqual(bilingualSizesRestored, bilingualSizesBefore, '恢复网页字体不得改变双语译文字号');
    report.metrics.bilingualFontSizes = {host: bilingualSizesBefore, browserDefault: bilingualSizesEnabled, restored: bilingualSizesRestored};
    await noNewRequests(count, 'return to host font');
    await patchConfig({translationAppearance: {...DEFAULT_APPEARANCE, fontFamily: 'serif', customCss: 'font-family: cursive;'}});
    await waitFont(bilingual('primary'), 'cursive');
    await chooseFont(true); await waitFont(bilingual('primary'), browserDefault);
    await chooseFont(false); await waitFont(bilingual('primary'), 'cursive');
    await chooseFont(true); await waitFont(bilingual('primary'), browserDefault);
    assert.deepEqual((await readConfig()).translationAppearance, {...DEFAULT_APPEARANCE, fontFamily: 'serif', customCss: 'font-family: cursive;'});
    await noNewRequests(count, 'global custom font override and restoration');
    await patchConfig({translationAppearance: DEFAULT_APPEARANCE});
    await waitFont(bilingual('primary'), browserDefault);
    report.checks.push('switching back restores host and configured appearance fonts across open tabs; saved font preference does not rewrite appearance presets or request translation');

    // Popup 重开、不同标签页、新页面和快速关闭都沿用已保存的全局选择。
    diagnostics.setPhase('popup-reopen-global-sync-and-quick-close');
    await popup.close();
    popup = await createPage(popupUrl(tabId), {width: 360, height: 600});
    await assertFontButton(true);
    await waitFont(bilingual('primary'), browserDefault);
    await waitFont(otherTranslation, browserDefault);
    await untilState(otherTabId, true);
    await popup.goto(popupUrl(otherTabId), {waitUntil: 'domcontentloaded'});
    await assertFontButton(true);
    await popup.goto(popupUrl(tabId), {waitUntil: 'domcontentloaded'});
    await assertFontButton(true);
    report.persistenceCases = [];
    for (const enabled of [false, true]) {
      const before = (await readConfig()).browserDefaultTranslationFont;
      const persistenceCase = {name: 'real Aa click then immediate popup close and reopen', before, requested: enabled, passed: false};
      report.persistenceCases.push(persistenceCase);
      await popup.getByTestId('page-font-entry').click();
      await popup.close();
      popup = await createPage(popupUrl(tabId), {width: 360, height: 600});
      const stored = await untilConfig(config => config.browserDefaultTranslationFont === enabled);
      await assertFontButton(enabled);
      for (const id of globalTabs) await untilState(id, enabled);
      await waitFont(otherTranslation, enabled ? browserDefault : original.primary);
      Object.assign(persistenceCase, {stored: stored.browserDefaultTranslationFont,
        reopened: await popup.getByTestId('page-font-entry').getAttribute('aria-pressed'), passed: true});
    }
    report.quickClose = true;
    const freshPage = await createPage(`${fixture.url}/new-page`);
    await freshPage.locator('#fluent-read-page-styles').waitFor({state: 'attached'});
    const freshTabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, freshPage.url());
    assert(Number.isInteger(freshTabId)); globalTabs.add(freshTabId);
    await untilState(freshTabId, true);
    await hover(freshPage, 'primary'); await waitBilingual('primary', freshPage);
    const freshTranslation = freshPage.locator('#primary > .fluent-read-bilingual-content');
    await waitFont(freshTranslation, browserDefault);
    count = fixture.requests.length;
    await chooseFont(false);
    for (const translated of [bilingual('primary'), otherTranslation, freshTranslation]) await waitFont(translated, original.primary);
    await chooseFont(true);
    for (const translated of [bilingual('primary'), otherTranslation, freshTranslation]) await waitFont(translated, browserDefault);
    await noNewRequests(count, 'global font updates across existing and newly opened tabs');
    report.crossPageSync = {existingTabs: 2, newTabs: 1, enabledAndDisabled: true, passed: true};
    report.checks.push('reopened popup and another tab show the same saved choice; immediate close after real Aa clicks persists both values; newly opened pages inherit it and every tab follows both global toggle directions');

    // 刷新与 SPA URL 改变继续沿用全局选择；刷新只更换文档 token。
    diagnostics.setPhase('reload-and-spa-lifecycle');
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.locator('#fluent-read-page-styles').waitFor({state: 'attached'});
    const afterRefresh = await untilState(tabId, true);
    assert.notEqual(afterRefresh.documentToken, baselineState.documentToken, '刷新应更换文档 token');
    await popup.reload({waitUntil: 'domcontentloaded'}); await assertFontButton(true);
    await hover(page, 'primary'); await waitBilingual('primary');
    await waitFont(bilingual('primary'), browserDefault);
    count = fixture.requests.length;
    await page.evaluate(() => history.pushState({}, '', '/article/spa'));
    const afterSpa = await untilState(tabId, true);
    assert.equal(afterSpa.pageUrl, page.url());
    if (await bilingual('primary').count()) await waitFont(bilingual('primary'), browserDefault);
    await untilConfig(config => config.browserDefaultTranslationFont === true);
    await noNewRequests(count, 'SPA retains global font');
    report.metrics.lifecycle = {initial: baselineState, afterRefresh, afterSpa};
    report.checks.push('refresh changes the document token while retaining the saved global font; SPA URL navigation also retains it without a translation request');

    // 仅译文采用闭合 ShadowRoot：CDP 直接读取真实渲染节点的计算样式，不注入替代 DOM。
    diagnostics.setPhase('translation-only-font-toggle');
    await chooseFont(false);
    await patchConfig({display: 0});
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.locator('#fluent-read-page-styles').waitFor({state: 'attached'});
    await untilState(tabId, false);
    await popup.reload({waitUntil: 'domcontentloaded'}); await assertFontButton(false);
    const session = await context.newCDPSession(page);
    await session.send('DOM.enable'); await session.send('CSS.enable');
    const attributes = node => Object.fromEntries(Array.from({length: (node.attributes || []).length / 2}, (_, index) => [node.attributes[index * 2], node.attributes[index * 2 + 1]]));
    const descend = node => [node, ...(node.children || []).flatMap(descend), ...(node.shadowRoots || []).flatMap(descend)];
    const singleStyles = async (id, property) => {
      const {root} = await session.send('DOM.getDocument', {depth: -1, pierce: true});
      const target = descend(root).find(node => attributes(node).id === id);
      assert(target, `missing fixture #${id}`);
      const nodes = descend(target).filter(node => (attributes(node).class || '').split(/\s/u).includes('fluent-read-single-content'));
      const values = [];
      for (const node of nodes) {
        const {computedStyle} = await session.send('CSS.getComputedStyleForNode', {nodeId: node.nodeId});
        values.push(computedStyle.find(item => item.name === property).value);
      }
      return values;
    };
    const singleFonts = id => singleStyles(id, 'font-family');
    const waitSingleFont = async (id, expected) => {
      let fonts;
      for (let attempt = 0; attempt < 160; attempt++) {
        fonts = await singleFonts(id);
        if (fonts.length && fonts.every(font => font === expected)) return fonts;
        await delay(50);
      }
      assert(fonts.length && fonts.every(font => font === expected), `single #${id} fonts ${JSON.stringify(fonts)} expected ${expected}`);
    };
    await hover(page, 'primary');
    await page.locator('#primary .fluent-read-single-slot').first().waitFor({state: 'attached'});
    const singleHostFonts = await singleFonts('primary');
    const singleHostSizes = await singleStyles('primary', 'font-size');
    assert(singleHostFonts.length > 0 && singleHostFonts.every(font => font !== browserDefault), '单译文必须先继承故意不同的网页字体');
    count = fixture.requests.length;
    await chooseFont(true);
    await waitSingleFont('primary', browserDefault);
    const singleBrowserSizes = await singleStyles('primary', 'font-size');
    assert.deepEqual(singleBrowserSizes, singleHostSizes, '切换浏览器默认字体不得放大闭合译文槽的字号');
    await assertOriginalUnchanged('single browser default');
    await noNewRequests(count, 'existing single font change');
    await hover(page, 'secondary');
    await page.locator('#secondary .fluent-read-single-slot').first().waitFor({state: 'attached'});
    await waitSingleFont('secondary', browserDefault);
    await shot(page, '03-single-browser-default');
    count = fixture.requests.length;
    await chooseFont(false);
    const singleRestored = await singleFonts('primary');
    assert.deepEqual(singleRestored, singleHostFonts, '关闭后单译文未恢复每个原始文本槽的字体');
    const singleRestoredSizes = await singleStyles('primary', 'font-size');
    assert.deepEqual(singleRestoredSizes, singleHostSizes, '恢复网页字体不得改变闭合译文槽的字号');
    await chooseFont(true); await waitSingleFont('primary', browserDefault);
    await noNewRequests(count, 'single return to host and browser default');
    await hover(page, 'primary');
    await page.locator('#primary .fluent-read-single-slot').first().waitFor({state: 'detached'});
    assert.equal((await sourceMetrics()).primaryHtml, original.primaryHtml, '恢复原文应还原原始 DOM');
    await hover(page, 'primary');
    await page.locator('#primary .fluent-read-single-slot').first().waitFor({state: 'attached'});
    await waitSingleFont('primary', browserDefault);
    assert.equal(await page.locator('#primary .fluent-read-bilingual-content').count(), 0, '仅译文不应遗留双语 wrapper');
    report.metrics.single = {hostFonts: singleHostFonts, restoredFonts: singleRestored, repeatedFonts: await singleFonts('primary'),
      fontSizes: {host: singleHostSizes, browserDefault: singleBrowserSizes, restored: singleRestoredSizes}};
    report.checks.push('existing, later and repeated single translations use browser default inside real closed roots; turning it off restores each slot; restore returns original DOM');
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.locator('#fluent-read-page-styles').waitFor({state: 'attached'});
    await untilState(tabId, true);
    await popup.reload({waitUntil: 'domcontentloaded'}); await assertFontButton(true);
    await hover(page, 'primary');
    await page.locator('#primary .fluent-read-single-slot').first().waitFor({state: 'attached'});
    await waitSingleFont('primary', browserDefault);
    report.checks.push('translation-only pages also retain the global preference after reload and apply it to newly rendered closed translation roots');
    await session.detach();

    // 从真实全文按钮进入；字体覆盖不依赖悬浮入口，全文会话的后续 DOM 也使用当前选择。
    diagnostics.setPhase('full-page-dynamic-translation-and-restore');
    await chooseFont(false);
    await patchConfig({display: 1});
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.locator('#fluent-read-page-styles').waitFor({state: 'attached'});
    await untilState(tabId, false);
    await popup.reload({waitUntil: 'domcontentloaded'}); await waitPopup();
    assert.equal(await popup.locator('[data-popup-quick-feature="appearance"]').count(), 0, '全文路径仍应使用默认可见的 Aa 入口');
    const beforeFullRequests = fixture.requests.length;
    const fullButton = popup.getByTestId('page-translation');
    assert.equal(await fullButton.getAttribute('aria-pressed'), 'false', '刷新后全文按钮应处于未翻译状态');
    await fullButton.click();
    await waitBilingual('primary'); await waitBilingual('secondary');
    await popup.waitForFunction(() => {
      const button = document.querySelector('[data-testid="page-translation"]');
      return button?.getAttribute('aria-pressed') === 'true' && button.getAttribute('aria-busy') === 'false';
    });
    assert(fixture.requests.length > beforeFullRequests, '真实全文入口必须向本地 provider 发送翻译请求');
    await waitFont(bilingual('primary'), original.primary);
    await waitFont(bilingual('secondary'), original.primary);
    count = fixture.requests.length;
    const fullInitialRequests = count;
    await chooseFont(true);
    await waitFont(bilingual('primary'), browserDefault);
    await waitFont(bilingual('primary').locator('strong'), browserDefault);
    await waitFont(bilingual('secondary'), browserDefault);
    await assertOriginalUnchanged('full page browser default');
    await noNewRequests(count, 'full page existing translation font change');
    await page.evaluate(text => {
      const paragraph = document.createElement('p'); paragraph.id = 'dynamic'; paragraph.textContent = text;
      document.querySelector('main').append(paragraph);
    }, TEXT.dynamic);
    await waitBilingual('dynamic');
    await waitFont(bilingual('dynamic'), browserDefault);
    assert(fixture.requests.length > fullInitialRequests, '全文会话必须处理后来新增的真实正文');
    count = fixture.requests.length;
    const fullLaterRequests = count;
    await shot(page, '04-full-page-browser-default-with-later-content');
    await chooseFont(false);
    for (const id of ['primary', 'secondary', 'dynamic']) await waitFont(bilingual(id), original.primary);
    await waitFont(bilingual('primary').locator('strong'), original.emphasis);
    await assertOriginalUnchanged('full page font restored');
    await noNewRequests(count, 'full page existing and later translation font restoration');
    assert.equal(await popup.locator('.drawer-surface:visible').count(), 0, '主面板字体切换后全文操作应直接可用');
    await fullButton.click();
    await page.locator('.fluent-read-bilingual-content').first().waitFor({state: 'detached'});
    await popup.waitForFunction(() => document.querySelector('[data-testid="page-translation"]')?.getAttribute('aria-pressed') === 'false');
    assert.equal((await sourceMetrics()).primaryHtml, original.primaryHtml, '真实全文恢复应完整还原原文 DOM');
    await noNewRequests(count, 'full page restore original');
    report.metrics.fullPage = {entry: 'real-popup-page-translation-click', beforeRequests: beforeFullRequests,
      afterInitialTranslation: fullInitialRequests, afterLaterContent: fullLaterRequests, afterFontChangesAndRestore: fixture.requests.length,
      laterContentFont: browserDefault, finalFont: original.primary, restoredOriginalDom: true};
    report.checks.push('real popup full-page translation supports existing and dynamically added content, Aa browser default and host restoration without extra requests, and full restore returns original DOM');

    // 显示模式使用与 Aa 相同的短提示；实际点击切换两态，禁用状态仍应能解释原因。
    diagnostics.setPhase('display-mode-actions-and-tooltips');
    count = fixture.requests.length;
    const fontStateBeforeMode = await popup.getByTestId('page-font-entry').getAttribute('data-font-state');
    await inspectDisplayModeTooltip('bilingual');
    await inspectDisplayModeTooltip('bilingual', true);
    await popup.getByTestId('popup-display-mode').click();
    await untilConfig(config => config.display === 0);
    await inspectDisplayModeTooltip('translation-only');
    await inspectDisplayModeTooltip('translation-only', true);
    await popup.getByTestId('popup-display-mode').click();
    await untilConfig(config => config.display === 1);
    assert.equal(await popup.getByTestId('page-font-entry').getAttribute('data-font-state'), fontStateBeforeMode, '显示模式切换不得更改全局字体选择');
    await patchConfig({service: 'google'});
    await inspectDisplayModeTooltip('bilingual');
    await popup.getByTestId('popup-display-mode').click();
    await untilConfig(config => config.display === 0);
    await inspectDisplayModeTooltip('translation-only');
    await popup.getByTestId('popup-display-mode').click();
    await untilConfig(config => config.display === 1);
    await patchConfig({service});
    await noNewRequests(count, 'display mode and tooltip checks without translated content');
    report.checks.push('real display-mode clicks switch bilingual/translation-only without changing font choice, including for Google Translate; both action tooltips support hover, keyboard focus and Escape');

    // 主面板开关在窄屏与深浅色主题下保留两态反馈，并且没有横向溢出。
    diagnostics.setPhase('light-dark-responsive-font-states');
    const layouts = {};
    for (const theme of ['light', 'dark']) {
      await patchConfig({theme});
      await popup.waitForFunction(dark => document.documentElement.classList.contains('dark') === dark, theme === 'dark');
      for (const width of [360, 320]) {
        await popup.setViewportSize({width, height: 600});
        for (const browserDefaultEnabled of [false, true]) {
          await chooseFont(browserDefaultEnabled);
          await delay(100);
          const metrics = await popup.evaluate(() => {
            const root = document.querySelector('.popup-shell');
            const button = document.querySelector('[data-testid="page-font-entry"]');
            const mode = document.querySelector('[data-testid="popup-display-mode"]');
            const rect = button.getBoundingClientRect(), modeRect = mode.getBoundingClientRect();
            const icon = button.querySelector('svg'), iconRect = icon.getBoundingClientRect();
            const slot = button.closest('.display-mode-slot'), slotStyle = getComputedStyle(slot);
            return {innerWidth, scrollWidth: document.documentElement.scrollWidth, rootWidth: root.getBoundingClientRect().width,
              buttonLeft: rect.left, buttonTop: rect.top, buttonRight: rect.right, buttonWidth: rect.width, buttonHeight: rect.height,
              iconLeft: iconRect.left, iconTop: iconRect.top, iconWidth: iconRect.width, iconHeight: iconRect.height,
              fontStyle: icon.getAttribute('data-font-style'), iconPath: icon.querySelector('path').getAttribute('d'),
              buttonTransform: getComputedStyle(button).transform, iconTransform: getComputedStyle(icon).transform,
              slotBackground: slotStyle.backgroundColor, slotBorderWidth: slotStyle.borderTopWidth,
              slotDivider: getComputedStyle(slot, '::after').content,
              modeLeft: modeRect.left, modeTop: modeRect.top, modeWidth: modeRect.width, modeHeight: modeRect.height,
              fontState: button.getAttribute('data-font-state'), pressed: button.getAttribute('aria-pressed')};
          });
          assert(metrics.scrollWidth <= metrics.innerWidth + 1, `${theme}/${width} 页面横向溢出`);
          assert(metrics.buttonLeft >= -1 && metrics.buttonRight <= metrics.innerWidth + 1 && metrics.buttonWidth >= 20, '字体按钮超出视口或被压缩');
          assert.equal(metrics.buttonWidth, 24, '桌面字体按钮宽度应保持 24px');
          assert.equal(metrics.buttonHeight, 24, '桌面字体按钮高度应保持 24px');
          assert.equal(metrics.iconWidth, 18, '字体图标宽度应保持 18px');
          assert.equal(metrics.iconHeight, 18, '字体图标高度应保持 18px');
          assert.equal(metrics.buttonTransform, 'none', '字体按钮不应通过缩放表达状态');
          assert.equal(metrics.iconTransform, 'none', '字体图标不应通过缩放表达状态');
          assert.equal(metrics.fontStyle, browserDefaultEnabled ? 'sans' : 'serif');
          assert(metrics.modeLeft - metrics.buttonRight >= 5.5, '两个独立功能按钮之间必须保留清晰间距');
          assert.equal(metrics.slotBackground, 'rgba(0, 0, 0, 0)', '两个独立功能不得共用底色');
          assert.equal(metrics.slotBorderWidth, '0px', '两个独立功能不得共用外框');
          assert(['none', 'normal'].includes(metrics.slotDivider), '两个独立功能不得用分隔线组成一组');
          const stateName = browserDefaultEnabled ? 'browser-default' : 'host';
          if (browserDefaultEnabled) {
            const host = layouts[`${theme}-${width}-host`];
            for (const key of ['buttonLeft', 'buttonTop', 'buttonWidth', 'buttonHeight', 'iconLeft', 'iconTop', 'iconWidth', 'iconHeight', 'modeLeft', 'modeTop', 'modeWidth', 'modeHeight']) {
              assert(Math.abs(metrics[key] - host[key]) < 0.01, `${theme}/${width} 切换字体后 ${key} 发生变化`);
            }
            assert.notEqual(metrics.iconPath, host.iconPath, '网页字体与浏览器默认字体应使用不同 Aa 造型');
          }
          layouts[`${theme}-${width}-${stateName}`] = metrics;
          await shot(popup, `05-aa-${theme}-${width}-${stateName}`);
        }
      }
    }
    report.metrics.layouts = layouts;
    report.checks.push('320/360 CSS px light/dark main panels show distinct serif/sans Aa states with identical 24px buttons, 18px icons and positions, retain separate font/display buttons, and have no horizontal overflow');
    report.requests = fixture.requests.length;
    report.metrics.requestSources = fixture.requests.map(item => item.source);
    await diagnostics.flush();
    diagnostics.assertClean();
    report.ok = true;
  } catch (error) {
    report.error = redact(error.stack || String(error));
    failure = error;
  } finally {
    report.cleanupErrors = [];
    let closed = !launchAttempted;
    const cleanup = (stage, action) => ({stage, action: async () => {
      try {await action();}
      catch (error) {report.cleanupErrors.push({stage, message: redact(error.message || error)}); throw error;}
    }});
    await finalizeRun({diagnostics, result: report, artifactsDir, primaryError: failure,
      cleanup: [
        cleanup('browser-close', async () => {if (launched) {await launched.close(); closed = true;}}),
        cleanup('fixture-close', async () => {await fixture?.close();}),
        cleanup('profile-removal', async () => {
          if (!profileDir) return;
          if (!closed) {report.retainedProfile = profileDir; return;}
          try {fs.rmSync(profileDir, {recursive: true, force: true});}
          catch (error) {report.retainedProfile = profileDir; throw error;}
        }),
      ],
      emitReport: result => {
        const snapshot = result.runtimeDiagnostics;
        const own = snapshot.entries.filter(entry => entry.ownership === 'fluentread' && !entry.expectedCase);
        result.diagnosticSummary = {
          passed: snapshot.passed,
          fluentreadErrors: own.filter(entry => entry.level === 'error').length,
          fluentreadWarnings: own.filter(entry => entry.level === 'warning').length,
          expectedDiagnostics: snapshot.entries.filter(entry => entry.expectedCase).length,
          provenSiteDiagnostics: snapshot.entries.filter(entry => entry.ownership === 'site').length,
          otherExtensionDiagnostics: snapshot.entries.filter(entry => entry.ownership === 'other-extension').length,
          unattributedDiagnostics: snapshot.entries.filter(entry => entry.ownership === 'unattributed').length,
          collectionFailures: snapshot.coverage.failures,
          collectionLimitations: snapshot.coverage.limitations,
          workerObserved: snapshot.workerObserved,
          completeCoverage: snapshot.completeCoverage,
          coverageScope: snapshot.coverageScope,
        };
        const serialized = `${JSON.stringify(result, null, 2)}\n`;
        fs.writeFileSync(path.join(artifactsDir, 'report.json'), serialized);
        fs.writeFileSync(path.join(artifactsDir, 'result.json'), serialized);
      }});
  }
  console.log(JSON.stringify(report, null, 2));
  if (failure) throw failure;
}
main().catch(error => {console.error(error.stack || error); process.exitCode = 1;});
