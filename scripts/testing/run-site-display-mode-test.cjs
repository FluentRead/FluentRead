#!/usr/bin/env node
'use strict';
/**
 * @file scripts/testing/run-site-display-mode-test.cjs
 * 文件职责：用生产扩展验证网站仅译文偏好及新增内置词库的实际用户链路。
 * 主要内容：本地跨站页面和确定性供应商、设置即时保存与重开、已有和迟到译文切换、动态正文、恢复重译、词库预览与添加，以及隔离世界和后台诊断。
 * 模块边界：仅操作自建临时 Edge profile；普通扩展页的当前标签查询绑定本地页面，不读取用户配置，不证明外部服务质量或 Firefox 行为。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const arg = name => {const index = process.argv.indexOf(`--${name}`); assert(index >= 0 && process.argv[index + 1], `Missing --${name}`); return process.argv[index + 1];};
const extensionDir = path.resolve(arg('extension-dir'));
const artifactsDir = path.resolve(arg('artifacts-dir'));
const {chromium} = require(path.join(arg('playwright-root'), 'playwright'));
const diagnostics = require(arg('runtime-diagnostics')).createRuntimeDiagnostics();
const helper = require('./focus-safe-browser.cjs');
const {guardBrowserClose} = require('./owned-browser-close.cjs');
const profileDir = fs.mkdtempSync('/private/tmp/fluentread-site-display-');
const source = 'Cloud computing uses object storage. Reading this article should feel calm and effortless.';
const translation = '云计算使用对象存储。阅读这篇文章应该轻松自然。';
const service = 'custom:site-display-fixture';
const report = {ok: false, extensionDir, artifact: 'production', cases: [], screenshots: [], cleanupErrors: [],
  boundary: 'Isolated production Edge, local deterministic provider, ordinary extension-tab popup. No live-provider or native-toolbar or Firefox acceptance claim.'};
let launched, context, control, content, popup, monitor, browserPid, focusError, origin, fixtureUrl, responseGate;
let requestCount = 0;
fs.mkdirSync(artifactsDir, {recursive: true});
const server = http.createServer(async (request, response) => {
  response.setHeader('access-control-allow-origin', '*'); response.setHeader('access-control-allow-headers', '*');
  if (request.method === 'OPTIONS') {response.writeHead(204); response.end(); return;}
  if (request.method === 'POST') {
    for await (const _chunk of request) { /* 排空本地合成请求，不记录凭据。 */ }
    requestCount++; if (responseGate) await responseGate;
    if (response.destroyed) return;
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({choices: [{message: {role: 'assistant', content: translation}, finish_reason: 'stop'}]})); return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html lang="en"><head><title>Site display fixture</title></head><body><article id="article"><p id="primary">${source}</p></article></body></html>`);
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function focusSafe() {if (focusError) throw focusError;}
async function until(check, label) {const end = Date.now() + 20000; while (Date.now() < end) {focusSafe(); if (await check()) return; await pause(60);} throw new Error(`${label}: timeout`);}
async function open(url, name) {focusSafe(); const page = await helper.newPageWithoutForeground(context, 30000); await diagnostics.attachPage(page, name); await page.goto(url); return page;}
async function read() {const result = await control.evaluate(() => chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'})); assert(result.success); return result.value;}
async function patch(values, initial = false) {
  const before = await read(); const result = await control.evaluate(({before, values, initial}) => chrome.runtime.sendMessage({type: 'persistConfig', mode: initial ? 'replace' : 'patch', config: initial ? {...before, ...values} : values,
    expected: Object.fromEntries(Object.keys(values).map(key => [key, before[key]])), baseRevision: initial ? before.__fluentConfigRevision || 0 : undefined, clientId: `site-display-${crypto.randomUUID()}`, sequence: 1}), {before, values, initial}); assert.equal(result.success, true);
}
async function saved(key, value) {await until(async () => JSON.stringify((await read())[key]) === JSON.stringify(value), `saved ${key}`);}
async function message(action) {return control.evaluate(async ({url, action}) => {const tab = (await chrome.tabs.query({})).find(tab => tab.url === url); return chrome.tabs.sendMessage(tab.id, action);}, {url: content.url(), action});}
async function ready() {await until(async () => {try {return (await message({type: 'getFullPageTranslationState'})).status === 'success';} catch {return false;}}, 'content ready');}
async function translate() {assert.equal((await message({type: 'contextMenuTranslate', action: 'fullPage'})).status, 'success');}
async function restore() {assert.equal((await message({type: 'contextMenuTranslate', action: 'restore'})).status, 'success'); await until(async () => await content.locator('.fluent-read-single-slot,.fluent-read-bilingual-content').count() === 0, 'restored');}
async function singles() {
  const session = await context.newCDPSession(content);
  try {const {root} = await session.send('DOM.getDocument', {depth: -1, pierce: true}); const slots = [];
    const text = node => node.nodeType === 3 ? node.nodeValue : (node.children || []).map(text).join('');
    const visit = node => {const attrs = Object.fromEntries(Array.from({length: (node.attributes || []).length / 2}, (_, i) => [node.attributes[i * 2], node.attributes[i * 2 + 1]]));
      if ((attrs.class || '').split(/\s/u).includes('fluent-read-single-slot')) slots.push({source: text(node), translation: (node.shadowRoots || []).map(text).join(''), closed: node.shadowRoots?.[0]?.shadowRootType === 'closed'});
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) visit(child);}; visit(root); return slots;
  } finally {await session.detach();}
}
async function singleReady(count = 1) {await until(async () => {const slots = await singles(); return slots.length === count && slots.every(slot => slot.closed && slot.translation === translation);}, 'translation-only text slots'); assert.equal(await content.locator('.fluent-read-bilingual-content').count(), 0);}
async function shot(page, name) {focusSafe(); const filename = path.join(artifactsDir, `${name}.png`); await page.screenshot({path: filename, animations: 'disabled'}); report.screenshots.push(filename);}
async function openPopup() {
  popup = await helper.newPageWithoutForeground(context, 30000); await diagnostics.attachPage(popup, 'popup'); await popup.setViewportSize({width: 400, height: 600});
  await popup.addInitScript(url => {const query = chrome.tabs.query.bind(chrome.tabs); chrome.tabs.query = (info, callback) => {
    if (!info.active) return query(info, callback); const {active: _, ...rest} = info; const filter = tabs => tabs.filter(tab => tab.url === url);
    return callback ? query(rest, tabs => callback(filter(tabs))) : query(rest).then(filter);};}, content.url());
  await popup.goto(`${origin}/popup.html`); await popup.locator('.popup-shell[data-config-ready="true"]').waitFor();
  await until(async () => (await popup.locator('[data-setting="disable-extension-site"]').getAttribute('data-site-domain')) === new URL(content.url()).hostname, 'popup source');
}
async function closePage(page) {const id = await page.evaluate(async () => (await chrome.tabs.getCurrent()).id); await control.evaluate(async id => {await chrome.tabs.update((await chrome.tabs.getCurrent()).id, {active: true}); await chrome.tabs.remove(id);}, id);}
async function run() {
  try {
    await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);}); fixtureUrl = `http://127.0.0.1:${server.address().port}/article`;
    monitor = helper.startFocusEventMonitor({onEvent: event => {if (event.pid === browserPid) focusError = new Error('Owned Edge became frontmost');}, onError: error => {focusError = error;}}); await monitor.ready;
    launched = await helper.launchFocusSafePersistentContext({chromium, profileDir, background: true, headless: false, displayTarget: 'secondary', viewport: {width: 1440, height: 900},
      browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']}); guardBrowserClose(launched, profileDir);
    context = launched.context; Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    const session = await context.browser().newBrowserCDPSession(); try {browserPid = (await session.send('SystemInfo.getProcessInfo')).processInfo.find(item => item.type === 'browser').id;} finally {await session.detach();}
    assert.equal(report.windowPlacement.browserFrontmost, false); await diagnostics.start(context);
    const worker = context.serviceWorkers().find(item => item.url().startsWith('chrome-extension://')) || await context.waitForEvent('serviceworker'); origin = `chrome-extension://${new URL(worker.url()).host}`; diagnostics.setExtensionId(new URL(worker.url()).host);
    control = await open(`${origin}/options.html#settings-sites`, 'options'); await until(async () => Boolean((await read())?.service), 'configuration hydration'); const initial = await read();
    await patch({on: true, uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, service, from: 'en', to: 'zh-Hans', display: 1, autoTranslate: false, useCache: false, translationOnlyDomains: [], disableFloatingBall: true,
      customOpenAIProviders: [{id: service, name: '本地测试服务', endpoint: fixtureUrl.replace('/article', '/v1/chat/completions'), models: ['fixture-model']}], model: {...initial.model, [service]: 'fixture-model'},
      token: {[service]: 'synthetic-local-fixture-not-a-secret'}, enableAIContext: false, enableAIMultiSegment: false, glossaryEnabled: false, animations: false}, true);
    content = await open(fixtureUrl, 'content'); await ready(); await content.evaluate(() => {window.__original = document.querySelector('#primary').firstChild;}); await translate(); await content.locator('#primary .fluent-read-bilingual-content').waitFor(); const before = requestCount;
    diagnostics.setPhase('site preference UI');
    const prefs = control.locator('[data-setting="site-preferences"]'); await prefs.getByRole('textbox', {name: '域名或完整网址'}).fill(fixtureUrl);
    await prefs.locator('.el-select').click(); await control.getByRole('option', {name: '仅显示译文', exact: true}).click(); await prefs.getByRole('button', {name: '添加网站', exact: true}).click();
    await saved('translationOnlyDomains', ['127.0.0.1']); await singleReady(); assert.equal(requestCount, before); assert.equal((await read()).display, 1); await shot(content, 'site-translation-only');
    await control.reload(); await control.getByRole('checkbox', {name: '仅显示译文 127.0.0.1', exact: true}).waitFor(); assert(await control.getByRole('checkbox', {name: '仅显示译文 127.0.0.1', exact: true}).isChecked()); await shot(control, 'options-reopened');
    await openPopup(); const toggle = popup.getByTestId('popup-display-mode'); assert.equal(await toggle.getAttribute('data-display-mode'), 'translation-only'); assert(await toggle.isDisabled()); await shot(popup, 'popup-site-only'); await closePage(popup); popup = null;
    report.cases.push('UI saves only the site preference, existing translation changes without a provider request, reopening preserves it and Popup shows the effective mode');
    await content.evaluate(source => {const p = document.createElement('p'); p.textContent = source + ' A new paragraph is now available.'; document.querySelector('#article').append(p);}, source); await singleReady(2); await restore();
    assert(await content.evaluate(() => document.querySelector('#primary').firstChild === window.__original)); await translate(); await singleReady(2); await restore();
    await content.goto(fixtureUrl.replace('127.0.0.1', 'localhost')); await ready(); await translate(); await content.locator('#primary .fluent-read-bilingual-content').waitFor(); assert.equal((await singles()).length, 0); await restore();
    await content.goto(fixtureUrl); await ready(); await translate(); await singleReady(); await restore(); report.cases.push('Dynamic content, restore and repeat, cross-site navigation and return respect site versus global display');
    await patch({floatingBallDisabledDomains: ['127.0.0.1']}); await helper.activateExtensionTabWithoutForeground(context, control);
    const checkbox = control.getByRole('checkbox', {name: '仅显示译文 127.0.0.1', exact: true}); await checkbox.uncheck(); await saved('translationOnlyDomains', []);
    let release; responseGate = new Promise(resolve => {release = resolve;}); const started = requestCount; await translate(); await until(() => requestCount > started, 'gated provider request');
    try {await checkbox.check(); await saved('translationOnlyDomains', ['127.0.0.1']);} finally {responseGate = null; release();} await singleReady(); await restore(); report.cases.push('A result arriving after the site preference changes commits in the latest display mode');
    await control.setViewportSize({width: 390, height: 850}); assert(await control.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await shot(control, 'options-narrow'); await control.setViewportSize({width: 1440, height: 900});
    diagnostics.setPhase('new built-in glossary UI'); await control.goto(`${origin}/options.html#settings-glossary`); await control.getByTestId('builtin-glossaries').waitFor(); assert.equal(await control.getByTestId('builtin-glossaries').locator('article').count(), 8);
    await control.getByRole('button', {name: '预览 网络与云计算', exact: true}).click(); const preview = control.getByTestId('builtin-glossary-preview'); await preview.locator('input[type="search"]').fill('object storage'); await until(async () => await preview.locator('tbody tr').count() === 1, 'glossary search'); assert.match(await preview.textContent(), /对象存储/u); await shot(control, 'glossary-preview'); await preview.getByRole('button', {name: '关闭', exact: true}).click();
    await control.getByRole('button', {name: '添加 计算机硬件', exact: true}).click(); await until(async () => (await read()).glossaryLibraries.some(item => item.preset?.id === 'hardware-en-zh-hans' && item.entries.length === 30), 'editable glossary copy'); assert.equal((await read()).glossaryEnabled, false); await control.reload();
    const editor = control.getByRole('region', {name: '词库设置', exact: true}); await editor.waitFor(); await editor.locator('tbody tr').first().waitFor(); await editor.scrollIntoViewIfNeeded(); assert.match(await editor.textContent(), /central processing unit/u); await shot(control, 'glossary-reopened'); report.cases.push('Eight built-ins render; new terms are searchable and adding a 30-entry editable copy persists without enabling the global switch');
    focusSafe(); report.ok = true;
  } catch (error) {report.failure = error.stack; process.exitCode = 1; if (control && !control.isClosed()) await shot(control, 'failure').catch(() => {});}
  finally {
    try {await diagnostics.flush(); report.runtimeDiagnostics = diagnostics.snapshot(); fs.writeFileSync(path.join(artifactsDir, 'runtime-diagnostics.json'), JSON.stringify(report.runtimeDiagnostics, null, 2)); if (report.ok) diagnostics.assertClean();} catch (error) {report.ok = false; report.cleanupErrors.push(error.message); process.exitCode = 1;}
    await diagnostics.stop().catch(error => {report.ok = false; report.cleanupErrors.push(error.message); process.exitCode = 1;});
    try {await launched?.close(); await monitor?.stop(); focusSafe(); if (launched) fs.rmSync(profileDir, {recursive: true, force: true});} catch (error) {report.ok = false; report.cleanupErrors.push(error.message); process.exitCode = 1;}
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); report.providerRequests = requestCount; report.focusEvents = monitor?.events; fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify({ok: report.ok, cases: report.cases, failure: report.failure, cleanupErrors: report.cleanupErrors}));
}
void run().catch(error => {console.error(error); process.exitCode = 1;});
