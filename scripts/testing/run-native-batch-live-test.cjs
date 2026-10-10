/**
 * @file scripts/testing/run-native-batch-live-test.cjs
 * 文件职责：在生产扩展和临时 Edge 中验证原生机器批量翻译的请求对应、结构恢复与完整缓存发布。
 * 主要内容：默认仅跑三家云服务的合成响应；--settings 验证五项独立开关、快速关闭持久化与停用后的逐条请求，--live 显式增加 Google/微软小样本，--full-page 增加六段本地页面 Alt+T 翻译/恢复/再翻译。只记录已知测试文本、端点路径和开关，不读取用户凭据或 profile。
 * 模块边界：通过 options 页 runtime 消息调用真实 broker；仅本次 worker 的 fetch 接受合成云响应，焦点安全 helper 管理后台可见窗口，所有证据明确区分 synthetic 与 live。
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {createHash, randomUUID} = require('node:crypto');

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/testing/run-native-batch-live-test.cjs --extension-dir PATH --playwright-root PATH --focus-safe-helper PATH --artifacts-dir PATH [--settings] [--live] [--full-page] [--background]');
  process.exit(0);
}
for (const name of ['extension-dir', 'playwright-root', 'focus-safe-helper', 'artifacts-dir']) {
  assert.ok(process.argv.includes(`--${name}`), `必须提供 --${name}`);
}
assert.equal(process.platform, 'darwin', '本专项只支持 macOS 后台可见且不抢焦点的临时 Edge');
assert.ok(!process.argv.includes('--headed'), '本专项不允许前台启动');
const extensionDir = path.resolve(argument('extension-dir'));
const artifactsDir = path.resolve(argument('artifacts-dir'));
const helperPath = path.resolve(argument('focus-safe-helper'));
const playwrightRoot = path.resolve(argument('playwright-root'));
const live = process.argv.includes('--live');
const fullPage = process.argv.includes('--full-page');
const settings = process.argv.includes('--settings');
const timeout = Number(argument('timeout', '45000'));
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
assert.ok(!extensionDir.endsWith('-dev') && !manifest.name.includes('DEV'), '仅接受 production 产物');
const {assertFreshProductionExtension} = require('../run-site-translation-test.cjs');
const {patchStoredConfig} = require('../run-selection-trigger-test.cjs');
const {chromium} = require(path.join(playwrightRoot, 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground} = require(helperPath);

const samples = [
  {source: 'The astronomer counted 11 bright stars before sunrise.', translated: '天文学家在日出前数到了 11 颗亮星。', numbers: ['11']},
  {source: 'The chef baked 22 bread rolls for the morning market.', translated: '厨师为早市烤了 22 个面包卷。', numbers: ['22']},
  {source: 'The cyclist travelled 33 kilometres beside the river.', translated: '骑车人在河边骑行了 33 公里。', numbers: ['33']},
  {source: 'The librarian shelved 44 books.\nThe gardener watered 55 plants.', translated: '图书管理员上架了 44 本书。\n园丁浇了 55 株植物。', numbers: ['44', '55']},
  {source: 'Use the literal text <b>66</b> & &lt; in the manual.', translated: '在手册中使用字面文本 <b>66</b> & &lt;。', numbers: ['66']},
];
const sourceTexts = [...samples.map(sample => sample.source), samples[0].source];
const expectedTexts = [...samples.map(sample => sample.translated), samples[0].translated];
fs.mkdirSync(artifactsDir, {recursive: true});
const report = {
  ok: false, scope: 'native arrays, scalar recovery, atomic cache and optional bounded live/DOM samples',
  extensionDir, profileMode: 'automatically-created-temporary-profile',
  liveRequested: live, fullPageRequested: fullPage, settingsRequested: settings,
  cases: [], screenshots: [], pageErrors: [], persistenceCases: [], storageEvents: [],
  quickClose: false, latestWriteWins: false, crossPageSync: false,
  evidenceLimits: ['Synthetic cloud fixtures do not prove real cloud API acceptance.', 'Small live samples do not prove complete translation quality or all sites/devices.'],
};
let launched, optionsPage, articlePage, worker, profileDir, launchAttempted = false, server;
let liveSample;
const nativeServices = ['google', 'microsoft', 'deepL', 'azureTranslator', 'googleCloudTranslation'];

async function runSettings(context, servicesUrl) {
  const control = await newPageWithoutForeground(context, timeout);
  await control.goto(servicesUrl, {waitUntil: 'domcontentloaded'});
  const read = () => control.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
    if (!response?.success) throw new Error('Public configuration read failed');
    const value = typeof response.value === 'string' ? JSON.parse(response.value) : response.value;
    return {service: value.service, nativeBatchTranslationEnabled: value.nativeBatchTranslationEnabled, enableAIMultiSegment: value.enableAIMultiSegment};
  });
  const initial = await read();
  assert.equal(initial.enableAIMultiSegment, false);
  const open = async () => {
    optionsPage = await newPageWithoutForeground(context, timeout);
    optionsPage.on('pageerror', error => report.pageErrors.push(error.message));
    await optionsPage.exposeBinding('__nativeSettingsSave', (_source, event) => report.storageEvents.push(event));
    await optionsPage.addInitScript(() => {
      const runtime = chrome.runtime;
      const original = runtime.sendMessage.bind(runtime);
      runtime.sendMessage = (...args) => {
        const message = args.find(arg => arg && typeof arg === 'object' && arg.type);
        const preferences = message?.type === 'persistConfig' ? message.config?.nativeBatchTranslationEnabled : undefined;
        const record = event => {void globalThis.__nativeSettingsSave?.(event).catch(() => {});};
        if (preferences) record({event: 'request', preferences});
        const next = preferences ? args.map(arg => typeof arg === 'function' ? (...responses) => {
          record({event: 'response', success: responses[0]?.success === true});
          return arg(...responses);
        } : arg) : args;
        const result = original(...next);
        if (preferences && result?.then) result.then(response => record({event: 'response', success: response?.success === true}), () => record({event: 'rejection'}));
        return result;
      };
    });
    await optionsPage.goto(servicesUrl, {waitUntil: 'domcontentloaded'});
    await optionsPage.locator('.service-catalog').waitFor({timeout});
  };
  const close = async () => {
    const id = await optionsPage.evaluate(async () => (await chrome.tabs.getCurrent()).id);
    await activateExtensionTabWithoutForeground(context, control, timeout);
    await control.evaluate(id => chrome.tabs.remove(id), id);
  };
  const select = async (service, page = optionsPage) => {
    const target = page.locator(`.service-rail [data-service-value="${service}"]`);
    const group = target.locator('xpath=ancestor::section[@data-service-section]').locator('.directory-section-toggle');
    if (await group.count() && await group.getAttribute('aria-expanded') === 'false') await group.click();
    await target.click();
    await page.waitForFunction(service => document.querySelector('.service-catalog')?.dataset.editingService === service, service);
  };
  const toggle = service => optionsPage.locator(`[data-native-batch-service="${service}"]`).getByRole('switch', {name: '合并翻译请求', exact: true});
  const clickToggle = service => optionsPage.locator(`[data-native-batch-service="${service}"] .el-switch__core`).click();
  const saved = async (service, expected) => control.waitForFunction(async ({service, expected}) => {
    const response = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
    const value = typeof response.value === 'string' ? JSON.parse(response.value) : response.value;
    return response.success && value?.nativeBatchTranslationEnabled?.[service] === expected;
  }, {service, expected}, {timeout});
  await close();
  await open();
  for (const service of nativeServices) {
    await select(service);
    assert.equal(await toggle(service).getAttribute('aria-checked'), 'true', `${service} should default on`);
    await clickToggle(service);
    await close(); // UI 反馈后立刻关闭，保存必须仍完成。
    await saved(service, false);
    await select(service, control);
    await control.waitForFunction(service => document.querySelector(`[data-native-batch-service="${service}"] [role="switch"]`)?.getAttribute('aria-checked') === 'false', service, {timeout});
    await open();
    await select(service);
    assert.equal(await toggle(service).getAttribute('aria-checked'), 'false', `${service} did not survive reopening`);
    assert.equal((await read()).service, initial.service, 'Editing a switch changed the default provider');
    report.persistenceCases.push({service, before: true, after: false, reopened: false, quickClose: true});
    if (service === 'azureTranslator') {
      await clickToggle(service);
      await clickToggle(service);
      await close();
      await saved(service, false);
      await open();
      await select(service);
      assert.equal(await toggle(service).getAttribute('aria-checked'), 'false');
      report.latestWriteWins = true;
      await shot(optionsPage, 'native-batch-azure-disabled-reopened');
    }
  }
  assert.deepEqual((await read()).nativeBatchTranslationEnabled, Object.fromEntries(nativeServices.map(service => [service, false])));
  for (const service of ['deeplx', 'bilibili', 'openai']) {
    await select(service);
    assert.equal(await optionsPage.locator('[data-native-batch-service]:visible').count(), 0);
    if (service === 'bilibili') {
      const badges = optionsPage.locator('[data-service-nature-badge="bilibili"]:visible');
      assert.ok(await badges.count() > 0);
      for (const text of await badges.allTextContents()) assert.equal(text.trim(), '免费');
      await shot(optionsPage, 'bilibili-free-label');
    }
  }
  for (const service of nativeServices) {
    if (!live && ['google', 'microsoft'].includes(service)) continue;
    await clearCache();
    await fixtureMode(service);
    const origins = service === 'microsoft' ? sourceTexts.filter((_, index) => index !== 4) : sourceTexts;
    const translations = await translate(service, origins, true);
    const requests = await calls();
    assert.ok(requests.length >= new Set(origins).size);
    assert.ok(requests.every(request => request.inputs.length === 1), `${service} off still sent an array`);
    if (['google', 'microsoft'].includes(service)) {
      verifyLiveCorrespondence(translations, true, origins);
      await fixtureMode(service);
      await Promise.all(origins.slice(0, 3).map(source => translate(service, source)));
      assert.ok((await calls()).every(request => request.inputs.length === 1), `${service} concurrent scalars still grouped`);
    } else {
      assert.deepEqual(translations, expectedTexts);
      await clearCache();
      await fixtureMode(service, 'atomic-failure');
      let failure;
      try { await translate(service, sourceTexts.slice(0, 3), true); }
      catch (error) { failure = error; }
      assert.equal(failure?.code, 'NATIVE_BATCH_RESPONSE_INVALID', 'Disabled scalar failure should reject the complete result');
      assert.equal((await cacheStats()).entries, 0, 'Disabled scalar failure wrote partial cache');
      assert.ok((await calls()).every(request => request.inputs.length === 1));
    }
    report.cases.push({name: `${service}:disabled-sends-individual-http`, evidence: ['google', 'microsoft'].includes(service) ? 'live-provider' : 'synthetic-official-response', ok: true, requests});
  }
  assert.equal((await read()).enableAIMultiSegment, false);
  report.quickClose = true;
  report.crossPageSync = true;
  assert.ok(report.storageEvents.some(event => event.event === 'request'));
  assert.ok(report.storageEvents.some(event => event.event === 'response' && event.success));
  await patchStoredConfig(optionsPage, {nativeBatchTranslationEnabled: Object.fromEntries(nativeServices.map(service => [service, true]))});
  await control.close();
  report.cases.push({name: 'native-settings-defaults-isolation-persistence-and-bilibili-label', evidence: 'real-extension-ui', ok: true});
}

async function send(message) {
  return optionsPage.evaluate(message => chrome.runtime.sendMessage(message), message);
}
async function clearCache() {
  const response = await send({type: 'clearTranslationCache'});
  assert.equal(response?.success, true, '临时 profile 缓存清理失败');
}
async function cacheStats() {
  const response = await send({type: 'getTranslationCacheStats'});
  assert.equal(response?.success, true, '缓存统计失败');
  return response.stats;
}
async function translate(service, origin, useCache = false) {
  const result = await send({origin, serviceOverride: service, sourceLanguage: 'en', targetLanguage: 'zh-Hans',
    enableAIContext: false, useCache, requestTimeoutMs: timeout, clientRequestId: `native-harness-${randomUUID()}`});
  if (result && !Array.isArray(result) && typeof result === 'object') {
    const error = new Error(result.message || '翻译消息失败');
    Object.assign(error, {kind: result.kind, code: result.code, statusCode: result.statusCode});
    throw error;
  }
  return result;
}
async function fixtureMode(service, behavior = 'success', reset = true) {
  await worker.evaluate(({service, behavior, reset}) => {
    const state = globalThis.__nativeBatchHarness;
    state.service = service; state.behavior = behavior; state.faultIssued = false; state.scalarCalls = 0;
    if (reset) state.calls = [];
  }, {service, behavior, reset});
}
async function calls() {
  return worker.evaluate(() => globalThis.__nativeBatchHarness.calls.map(call => ({...call, inputs: [...call.inputs]})));
}
async function shot(page, name) {
  const file = path.join(artifactsDir, `${name}.png`);
  await page.screenshot({path: file});
  report.screenshots.push(file);
}

function verifyLiveCorrespondence(translations, repeatMustMatch, origins = sourceTexts) {
  assert.ok(Array.isArray(translations) && translations.length === origins.length, 'live 译文数量不匹配');
  translations.forEach((translation, index) => {
    const sample = samples.find(sample => sample.source === origins[index]);
    assert.ok(sample, '未知对照源槽');
    assert.equal(typeof translation, 'string');
    assert.match(translation, /[\u3400-\u9fff]/u, '样本未返回中文译文');
    for (const number of sample.numbers) assert.ok(translation.includes(number), `源槽 ${index} 的数字 ${number} 缺失或错位`);
    assert.ok(!translation.includes('___FLUENTREAD_'), '原生数组结果不应泄漏槽标记');
  });
  // 数组中的重复来源由 broker 共用同一结果；独立网络请求允许正常措辞变体。
  if (repeatMustMatch) assert.equal(translations.at(-1), translations[0], '批次中的重复原文没有对应相同结果');
  assert.match(translations[0], /星/u, '天文学家源槽没有保留自己的主题');
  assert.match(translations[1], /面包/u, '厨师源槽没有保留自己的主题');
  assert.match(translations[2], /骑|自行车/u, '骑车人源槽没有保留自己的主题');
  assert.match(translations[3], /书/u, '多行源槽没有保留图书主题');
  assert.match(translations[3], /植物|株|花草/u, '多行源槽没有保留园丁主题');
  assert.equal(translations[3].split('\n').length, 2, '多行源槽的换行没有保留');
  const literalIndex = origins.indexOf(samples[4].source);
  if (literalIndex >= 0) assertLiteralPreserved(translations[literalIndex]);
}

function assertLiteralPreserved(translation) {
  assert.equal(typeof translation, 'string');
  assert.ok(translation.includes('<b>66</b>') && translation.includes('&lt;'), 'HTML 字面文本被当作标签或实体解释');
}

async function runLive(service) {
  liveSample = {service, batchTranslations: [], individualTranslations: []};
  // 微软当前会改写实体字面值：普通批量对照与下方明确拒收验证分别记录。
  const origins = service === 'microsoft' ? sourceTexts.filter((_, index) => index !== 4) : sourceTexts;
  await clearCache();
  await fixtureMode(service);
  const started = Date.now();
  const batchTranslations = await translate(service, origins);
  liveSample.batchTranslations = batchTranslations;
  const batchCalls = await calls();
  const batchMs = Date.now() - started;
  assert.ok(batchCalls.some(call => call.inputs.length > 1), `${service}没有发出真实数组请求`);
  await fixtureMode(service);
  const individualStarted = Date.now();
  const individualTranslations = [];
  // 顺序请求，防止 Google 的收集窗口把“逐条对照”再次合成一批。
  for (const source of origins) individualTranslations.push(await translate(service, source));
  liveSample.individualTranslations = individualTranslations;
  verifyLiveCorrespondence(batchTranslations, true, origins);
  verifyLiveCorrespondence(individualTranslations, false, origins);
  const individualCalls = await calls();
  assert.ok(batchCalls.length < individualCalls.length, `${service}小样本未减少 HTTP 请求`);
  report.cases.push({name: `${service}:bounded-live-batch-vs-scalar`, evidence: 'live-provider', ok: true,
    sourceCount: origins.length, batchRequests: batchCalls, individualRequests: individualCalls,
    batchMs, individualMs: Date.now() - individualStarted, batchTranslations, individualTranslations});
}

async function runMicrosoftLiteralSafety() {
  await clearCache();
  await fixtureMode('microsoft');
  const origins = [samples[0].source, samples[4].source];
  const outcomes = [];
  for (const [mode, source] of [['batch', origins], ['scalar', origins[1]]]) {
    if (mode === 'scalar') await clearCache();
    try {
      const result = await translate('microsoft', source, true);
      assertLiteralPreserved(mode === 'batch' ? result[1] : result);
      outcomes.push({mode, outcome: 'literal-preserved', translations: result});
    } catch (error) {
      assert.equal(error.kind, 'response', '实体测试不能把网络或鉴权失败计为安全拒收');
      assert.equal(error.code, 'NATIVE_BATCH_RESPONSE_INVALID', '损坏的实体未被协议层明确拒收');
      outcomes.push({mode, outcome: 'invalid-literal-rejected', error: {kind: error.kind, code: error.code}});
      assert.equal((await cacheStats()).entries, 0, '损坏实体或前面的成功槽不得写入部分缓存');
    }
  }
  const requests = await calls();
  assert.ok(requests.some(call => call.inputs.length === 2), '未执行实体数组对照');
  assert.ok(requests.some(call => call.inputs.length === 1), '未执行实体单槽对照');
  report.cases.push({name: 'microsoft:literal-entity-preservation-or-safe-rejection', evidence: 'live-provider', ok: true,
    outcomes, requests, limitation: 'Safe rejection preserves the original text; it does not repair upstream semantic corruption.'});
}

async function runSynthetic(service) {
  await clearCache();
  await fixtureMode(service);
  assert.deepEqual(await translate(service, sourceTexts, true), expectedTexts);
  const successCalls = await calls();
  assert.equal(successCalls.length, 1, `${service} fixture应仅发一次原生数组 HTTP`);
  assert.equal(successCalls[0].inputs.length, samples.length, 'broker应复用重复原文而保留返回序号');
  assert.deepEqual(await translate(service, sourceTexts, true), expectedTexts);
  assert.equal((await calls()).length, 1, '成功批次未复用稳定缓存');
  report.cases.push({name: `${service}:success-repeat-and-cache`, evidence: 'synthetic-official-response', ok: true, requests: successCalls});

  const small = samples.slice(0, 3);
  for (const behavior of ['missing-middle', 'empty-middle', 'truncated-json']) {
    await clearCache();
    await fixtureMode(service, behavior);
    assert.deepEqual(await translate(service, small.map(sample => sample.source), true), small.map(sample => sample.translated));
    const recoveredCalls = await calls();
    assert.deepEqual(recoveredCalls.map(call => call.inputs.length), [3, 1, 1, 1], '结构异常必须整批逐段恢复');
    assert.deepEqual(recoveredCalls.slice(1).flatMap(call => call.inputs), small.map(sample => sample.source), '恢复源槽错位');
    assert.deepEqual(await translate(service, small.map(sample => sample.source), true), small.map(sample => sample.translated));
    assert.equal((await calls()).length, 4, '恢复完整成功后必须稳定命中缓存');
    report.cases.push({name: `${service}:${behavior}-scalar-recovery`, evidence: 'synthetic-official-response', ok: true, requests: recoveredCalls});
  }

  await clearCache();
  await fixtureMode(service, 'atomic-failure');
  let failure;
  try { await translate(service, small.map(sample => sample.source), true); }
  catch (error) { failure = {kind: error.kind, code: error.code}; }
  assert.ok(failure, '恢复中的后槽空译文不能返回部分成功');
  assert.equal((await cacheStats()).entries, 0, '失败前成功的源槽不应写入部分缓存');
  const failedCalls = await calls();
  await fixtureMode(service);
  assert.deepEqual(await translate(service, small.map(sample => sample.source), true), small.map(sample => sample.translated));
  const retryCalls = await calls();
  assert.equal(retryCalls.length, 1);
  assert.equal(retryCalls[0].inputs.length, small.length, '失败后重试应发送全部源槽');
  report.cases.push({name: `${service}:later-scalar-failure-is-atomic`, evidence: 'synthetic-official-response', ok: true, failure, failedCalls, retryCalls});
}

async function runFullPage(context, enableNativeBatch = true) {
  if (articlePage) {
    await activateExtensionTabWithoutForeground(context, optionsPage, timeout);
    await articlePage.close();
  }
  await patchStoredConfig(optionsPage, {service: 'azureTranslator', enableAIMultiSegment: false, enableAIContext: false,
    nativeBatchTranslationEnabled: Object.fromEntries(nativeServices.map(service => [service, service === 'azureTranslator' ? enableNativeBatch : true])),
    autoTranslate: false, on: true, display: 1, useCache: false, fullPageTranslationMode: 'all',
    maxConcurrentTranslations: 10, pageTitleTranslationEnabled: false});
  await clearCache();
  await fixtureMode('azureTranslator');
  const escapeHtml = text => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>原生批量翻译验证</title></head><body style="font:19px/1.5 system-ui;padding:24px;max-width:1100px"><main>${sourceTexts.map((source, index) => `<p id="native-slot-${index}" style="white-space:pre-wrap">${escapeHtml(source)}</p>`).join('')}</main></body></html>`;
  if (server) await new Promise(resolve => server.close(resolve));
  server = http.createServer((_request, response) => { response.writeHead(200, {'content-type': 'text/html; charset=utf-8'}); response.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  articlePage = await newPageWithoutForeground(context, timeout);
  articlePage.on('pageerror', error => report.pageErrors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}/native-array`;
  await articlePage.goto(url, {waitUntil: 'domcontentloaded'});
  await articlePage.locator('#fluent-read-page-styles').waitFor({state: 'attached', timeout});
  const before = await articlePage.locator('main').innerHTML();
  const toggles = [];
  for (const expected of [sourceTexts.length, 0, sourceTexts.length]) {
    await activateExtensionTabWithoutForeground(context, articlePage, timeout);
    await articlePage.keyboard.press('Alt+T');
    await articlePage.waitForFunction(expected => document.querySelectorAll('main .fluent-read-bilingual-content').length === expected
      && document.querySelectorAll('main .fluent-read-loading, main .fluent-read-retry-wrapper').length === 0, expected, {timeout});
    const counts = await articlePage.locator('main > p').evaluateAll(paragraphs => paragraphs.map(paragraph => paragraph.querySelectorAll('.fluent-read-bilingual-content').length));
    assert.deepEqual(counts, Array.from({length: sourceTexts.length}, () => expected ? 1 : 0));
    if (expected) {
      const translations = await articlePage.locator('main > p .fluent-read-bilingual-content').allTextContents();
      assert.deepEqual(translations.map(text => text.trim()), expectedTexts);
      assert.equal(await articlePage.locator('.fluent-read-bilingual-content .fluent-read-bilingual-content').count(), 0);
    } else assert.equal(await articlePage.locator('main').innerHTML(), before, '恢复没有还原源 DOM');
    assert.equal(articlePage.url(), url);
    toggles.push(expected);
    await shot(articlePage, `native-full-page-${enableNativeBatch ? '' : 'disabled-'}${toggles.length}-${expected ? 'translated' : 'restored'}`);
  }
  const requests = await calls();
  assert.ok(enableNativeBatch ? requests.some(call => call.inputs.length > 1) : requests.every(call => call.inputs.length === 1), '全文请求形态必须遵循服务合批开关');
  assert.ok(requests.every(call => call.inputs.every(text => !text.includes('___FLUENTREAD_'))), '全文机器原生数组不应上传结构占位符');
  report.cases.push({name: enableNativeBatch ? 'six-paragraph-native-auto-with-ai-off' : 'six-paragraph-native-disabled-individual-requests', evidence: 'synthetic-official-response-and-real-content-shortcut',
    ok: true, toggles, settings: {enableAIMultiSegment: false, enableNativeBatch, useCache: false, fullPageTranslationMode: 'all', maxConcurrentTranslations: 10, display: 1}, requests});
}

(async () => {
  try {
    report.buildFreshness = assertFreshProductionExtension(extensionDir);
    profileDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluentread-native-batch-'));
    launchAttempted = true;
    launched = await launchFocusSafePersistentContext({chromium, profileDir,
      browserPath: argument('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      background: true, headless: false, viewport: {width: 1280, height: 900}, timeout,
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check']});
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    assert.equal(report.launchMode, 'macos-background-cdp');
    assert.equal(report.focusPolicy, 'launchservices-no-foreground');
    assert.equal(report.windowPlacement.mode, 'background-visible-no-focus');
    assert.equal(report.windowPlacement.browserFrontmost, false);
    const context = launched.context;
    report.extensionInstall = {method: 'isolated-cli-load-unpacked'};
    report.browserVersion = context.browser().version();
    assert.equal(typeof manifest.key, 'string', '生产 manifest 必须包含可计算扩展身份的公钥');
    const extensionId = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex')
      .slice(0, 32).replace(/[0-9a-f]/gu, digit => String.fromCharCode(97 + parseInt(digit, 16)));
    const extensionOrigin = `chrome-extension://${extensionId}`;
    // Worker 可能在后台窗口定位期间休眠；先打开固定身份的 options 页唤醒消息链路。
    optionsPage = await newPageWithoutForeground(context, timeout);
    optionsPage.on('pageerror', error => report.pageErrors.push(error.message));
    await optionsPage.goto(`${extensionOrigin}/${manifest.options_page || manifest.options_ui.page}#settings-services`, {waitUntil: 'domcontentloaded'});
    await optionsPage.locator('.service-catalog').waitFor({timeout});
    worker = context.serviceWorkers().find(candidate => candidate.url().startsWith('chrome-extension://'))
      || await context.waitForEvent('serviceworker', {timeout});
    assert.equal(new URL(worker.url()).host, extensionId);
    await patchStoredConfig(optionsPage, {on: true, from: 'en', to: 'zh-Hans', service: 'google', useCache: true,
      token: {deepL: '00000000-0000-4000-8000-000000000000:fx', googleCloudTranslation: 'fixture-native-gcp-key', azureTranslator: 'fixture-native-azure-key'},
      apiKeys: {deepL: ['00000000-0000-4000-8000-000000000000:fx'], googleCloudTranslation: ['fixture-native-gcp-key'], azureTranslator: ['fixture-native-azure-key']},
      apiKeyRotationEnabled: {}, proxy: {}, deeplApiPlan: 'free', serviceRegion: {azureTranslator: 'global'},
      translationMaxRetries: 0, maxConcurrentTranslations: 8, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0,
      enableAIMultiSegment: false, enableAIContext: false, autoTranslate: false, glossaryEnabled: false,
      uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, disableSelectionTranslator: true, disableFloatingBall: true, display: 1});
    await worker.evaluate(({live, samples}) => {
      const originalFetch = globalThis.fetch.bind(globalThis);
      const state = globalThis.__nativeBatchHarness = {live, samples, service: '', behavior: 'success', faultIssued: false, scalarCalls: 0, calls: []};
      const normalized = text => text.replace(/\s+/gu, ' ').trim();
      const fixtureText = text => samples.find(sample => normalized(sample.source) === normalized(text))?.translated || `测试译文：${text}`;
      globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
        let service, sources;
        const body = typeof init?.body === 'string' ? init.body : '';
        if (url.pathname === '/translate/translatetext') { service = 'microsoft'; sources = JSON.parse(body); }
        else if (url.pathname === '/v1/translateHtml') { service = 'google'; sources = JSON.parse(body)[0][0]; }
        else if (url.pathname === '/translate_a/t') { service = 'google'; sources = new URLSearchParams(body).getAll('q'); }
        else if (url.pathname.endsWith('/data/batchexecute')) { service = 'google'; sources = JSON.parse(new URLSearchParams(body).get('f.req'))[0].map(record => JSON.parse(record[1])[0][0]); }
        else if (url.hostname === 'translation.googleapis.com' && url.pathname.endsWith('/language/translate/v2')) { service = 'googleCloudTranslation'; const q = JSON.parse(body).q; sources = Array.isArray(q) ? q : [q]; }
        else if (url.hostname === 'api.cognitive.microsofttranslator.com' && url.pathname === '/translate') { service = 'azureTranslator'; sources = JSON.parse(body).map(item => item.Text); }
        else if (/^api(?:-free)?\.deepl\.com$/u.test(url.hostname) && url.pathname === '/v2/translate') { service = 'deepL'; sources = JSON.parse(body).text; }
        else return originalFetch(input, init);
        const synthetic = !['google', 'microsoft'].includes(service);
        state.calls.push({service, path: `${url.hostname}${url.pathname}`, evidence: synthetic ? 'synthetic-official-response' : 'live-provider', inputs: [...sources]});
        if (!synthetic) {
          if (!live) throw new Error('Live provider disabled: run with --live for the bounded sample');
          return originalFetch(input, init);
        }
        let translations = sources.map(fixtureText);
        let badJson = false;
        if (sources.length > 1 && !state.faultIssued && state.behavior !== 'success') {
          state.faultIssued = true;
          if (state.behavior === 'missing-middle' || state.behavior === 'atomic-failure') translations.splice(1, 1);
          else if (state.behavior === 'empty-middle') translations[1] = '\u200b';
          else if (state.behavior === 'truncated-json') badJson = true;
        } else if (state.behavior === 'atomic-failure' && sources.length === 1 && ++state.scalarCalls === 2) translations[0] = '';
        const response = service === 'deepL' ? {translations: translations.map(text => ({text}))}
          : service === 'azureTranslator' ? translations.map(text => ({translations: [{text, to: 'zh-Hans'}]}))
            : {data: {translations: translations.map(translatedText => ({translatedText}))}};
        return new Response(badJson ? '{"truncated":' : JSON.stringify(response), {status: 200, headers: {'Content-Type': 'application/json'}});
      };
    }, {live, samples});
    for (const service of ['deepL', 'azureTranslator', 'googleCloudTranslation']) await runSynthetic(service);
    if (settings) await runSettings(context, `${extensionOrigin}/${manifest.options_page || manifest.options_ui.page}#settings-services`);
    if (fullPage) await runFullPage(context);
    if (settings && fullPage) await runFullPage(context, false);
    if (live) for (const service of ['google', 'microsoft']) {
      try { await runLive(service); }
      catch (error) {
        report.cases.push({name: `${service}:bounded-live-batch-vs-scalar`, evidence: 'live-provider', ok: false,
          limitation: 'Live service/response or sample assertion failed; synthetic results are separate.', error: {message: error.message, kind: error.kind, code: error.code, statusCode: error.statusCode}, samples: liveSample, requests: await calls()});
      }
    }
    if (live) {
      try { await runMicrosoftLiteralSafety(); }
      catch (error) {
        report.cases.push({name: 'microsoft:literal-entity-preservation-or-safe-rejection', evidence: 'live-provider', ok: false,
          error: {message: error.message, kind: error.kind, code: error.code}, requests: await calls()});
      }
    }
    await shot(optionsPage, 'native-batch-options-production');
    assert.equal(report.pageErrors.length, 0, '扩展页面出现未捕获异常');
    report.ok = report.cases.every(testCase => testCase.ok);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    report.error = {message: error.message, stack: error.stack};
    process.exitCode = 1;
    if (articlePage || optionsPage) await shot(articlePage || optionsPage, 'native-batch-failure').catch(() => {});
  } finally {
    report.cleanupErrors = [];
    if (server) await new Promise(resolve => server.close(resolve));
    let closed = !launchAttempted;
    if (launched) {
      try { await launched.close(); closed = true; }
      catch (error) { report.cleanupErrors.push(`session close: ${error.message}`); }
    }
    if (profileDir && closed) {
      try { fs.rmSync(profileDir, {recursive: true, force: true}); }
      catch (error) { report.cleanupErrors.push(`temporary profile removal: ${error.message}`); report.retainedProfile = profileDir; }
    } else if (profileDir) report.retainedProfile = profileDir;
    if (report.cleanupErrors.length) { report.ok = false; process.exitCode = 1; }
    fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
})();
