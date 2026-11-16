/**
 * @file scripts/testing/run-site-rule-editor-ui-test.cjs
 * 文件职责：定向验收正文适配编辑器的连续调试流程与长规则布局。
 * 主要内容：生产扩展、临时后台窗口、真实持久化、保存失败重试、跨页冲突、20 区域和窄屏多语截图；导航前启动 CDP 诊断。
 * 模块边界：复用焦点安全与诊断 helper，只修改临时 profile，不访问翻译供应商或用户浏览器配置。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {guardBrowserClose} = require('./owned-browser-close.cjs');
function arg(name) {const index = process.argv.indexOf('--' + name);const value = process.argv[index + 1];if (index < 0 || !value || value.startsWith('--')) throw new Error('Missing --' + name);return value;}
assert.equal(arg('suite'), 'editor');
const extensionDir = path.resolve(arg('extension-dir'));
const artifactsDir = path.resolve(arg('artifacts-dir'));
const {chromium} = require(path.join(arg('playwright-root'), 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(path.resolve(arg('focus-safe-helper')));
const {createRuntimeDiagnostics, finalizeRun} = require(path.resolve(arg('runtime-diagnostics-helper')));
fs.mkdirSync(artifactsDir, {recursive: true});

async function main() {
  const profileDir = fs.mkdtempSync('/private/tmp/fr-site-rule-editor-');
  const report = {ok: false, suite: 'editor', extensionDir, cases: [], screenshots: [], persistenceCases: [], quickClose: false, crossPageSync: false, latestWriteWins: false};
  const diagnostics = createRuntimeDiagnostics();
  const timeout = 30000;
  let launched, page, primaryError, browserClosed = false;
  try {
    launched = await launchFocusSafePersistentContext({chromium, profileDir, timeout, background: true, headless: false,
      browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', displayTarget: 'secondary', viewport: {width: 1440, height: 900},
      browserArgs: ['--disable-extensions-except=' + extensionDir, '--load-extension=' + extensionDir, '--no-first-run', '--no-default-browser-check']});
    guardBrowserClose(launched, profileDir);
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    const context = launched.context;
    await diagnostics.start(context);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout});
    const extensionId = new URL(worker.url()).host;
    diagnostics.setExtensionId(extensionId);
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
    const url = 'chrome-extension://' + extensionId + '/' + (manifest.options_page || manifest.options_ui.page) + '#settings-sites';
    async function open() {
      const next = await newPageWithoutForeground(context, timeout);
      await diagnostics.attachPage(next, 'site-rule-editor-options');
      await next.emulateMedia({reducedMotion: 'reduce'});
      await next.addInitScript(() => {
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        window.__ruleSaveRequests = 0;
        chrome.runtime.sendMessage = (...args) => {
          if (args[0]?.type === 'persistConfig' && args[0]?.config?.siteAdaptation) {
            window.__ruleSaveRequests++;
            if (window.__failNextRuleSave) {
              window.__failNextRuleSave = false;
              const failure = {success: false, error: 'Controlled site-rule save failure'};
              const callback = args.at(-1);
              if (typeof callback === 'function') {queueMicrotask(() => callback(failure));return;}
              return Promise.resolve(failure);
            }
          }
          return send(...args);
        };
      });
      await next.goto(url, {waitUntil: 'domcontentloaded'});
      await next.locator('[data-setting="site-adaptation"]').waitFor();
      return next;
    }
    async function config(target = page) {const result = await target.evaluate(() => chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'}));assert(result.success && result.value);return result.value;}
    async function patch(patch, target = page) {
      const current = await config(target), expected = Object.fromEntries(Object.keys(patch).map(key => [key, current[key]]));
      const result = await target.evaluate(({patch, expected}) => chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: patch, expected}), {patch, expected});assert(result.success);
    }
    async function shot(name) {const filename = path.join(artifactsDir, name + '.png');await page.screenshot({path: filename});report.screenshots.push(filename);}
    const saved = () => page.locator('.editor-actions [role="status"]').filter({hasText: /规则已应用|Rules applied/}).waitFor();
    const finish = () => page.getByRole('button', {name: '结束编辑', exact: true}).first().click();
    const save = () => page.locator('.editor-actions button[type="submit"]').click();
    async function checkLayout(name) {
      const metrics = await page.evaluate(() => {
        const boxes = [...document.querySelectorAll('.rule-card, .visual-editor, .content-row, .editor-actions')].filter(element => element.getClientRects().length);
        const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
        const button = document.querySelector('.editor-actions button[type="submit"]'), box = button?.getBoundingClientRect();
        return {width: innerWidth, documentWidth: document.documentElement.scrollWidth, overflowing: boxes.filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.className),
          duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index), saveVisible: !!box && box.top >= 0 && box.bottom <= innerHeight,
          saveClickable: !!box && button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))};
      });
      assert(metrics.documentWidth <= metrics.width + 1, JSON.stringify(metrics));assert.deepEqual(metrics.overflowing, []);assert.deepEqual(metrics.duplicateIds, []);
      assert(metrics.saveVisible && metrics.saveClickable, JSON.stringify(metrics));report.cases.push({name, metrics});await shot(name);
    }
    page = await open();
    await patch({uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, theme: 'light'});
    await page.getByRole('heading', {name: '正文适配', exact: true}).waitFor();
    await page.getByRole('button', {name: '新建规则', exact: true}).click();
    await page.getByRole('textbox', {name: '规则名称', exact: true}).fill('连续调试规则');
    await page.getByRole('textbox', {name: '匹配域名', exact: true}).fill('example.test');
    await page.getByRole('button', {name: '添加正文区域', exact: true}).click();
    await page.getByRole('textbox', {name: '正文 CSS 选择器 1', exact: true}).fill('article p');
    await page.evaluate(() => {window.__editorNode = document.querySelector('[data-rule-form]');window.__failNextRuleSave = true;});
    diagnostics.setPhase('controlled-save-failure');
    await save();await page.getByRole('alert').filter({hasText: '保存失败'}).waitFor();
    assert.equal((await config()).siteAdaptation.custom.rules.length, 0);
    await save();await saved();
    const id = (await config()).siteAdaptation.custom.rules[0].id;
    for (const name of ['第二次调试', '第三次调试']) {
      await page.getByRole('textbox', {name: '规则名称', exact: true}).fill(name);await save();await saved();
      assert.equal(await page.evaluate(() => window.__editorNode === document.querySelector('[data-rule-form]')), true);
      const rules = (await config()).siteAdaptation.custom.rules;assert.equal(rules.length, 1);assert.equal(rules[0].id, id);assert.equal(rules[0].name, name);
    }
    assert.equal(await page.evaluate(() => {const event = new Event('beforeunload', {cancelable: true});window.dispatchEvent(event);return event.defaultPrevented;}), false);
    report.cases.push({name: 'new-rule-three-saves-and-failure-retry', passed: true});
    await finish();
    // 用 20 区域暴露标题入口与逐区折叠的工作量，并保留未展示的高级字段。
    const longRule = {id: 'long-editor-fixture', name: '长规则 · 20 个正文区域', match: {hosts: ['long.example.test']}, allScopes: true, omit: ['.author'],
      content: Array.from({length: 20}, (_, index) => ({css: ['article .paragraph-' + index, 'main .paragraph-' + index], resolve: 'closest', splitOnBr: true, atomic: true, key: '正文分区 ' + (index + 1)}))};
    const current = (await config()).siteAdaptation;
    await patch({siteAdaptation: {...current, custom: {version: 1, rules: [...current.custom.rules, longRule]}}});
    await page.getByRole('searchbox', {name: '搜索网站规则', exact: true}).fill(longRule.id);
    await page.locator('[data-adaptation-rule="' + longRule.id + '"] .catalog-name').click();
    await page.locator('[data-rule-detail]').evaluate(element => element.scrollIntoView({block: 'start'}));
    const placement = await page.locator('[data-rule-detail]').evaluate(element => ({heading: element.querySelector('header').getBoundingClientRect().bottom, actions: element.querySelector('.detail-actions').getBoundingClientRect().top, content: element.querySelector('dl').getBoundingClientRect().top}));
    assert(placement.actions >= placement.heading && placement.actions < placement.content);await shot('long-rule-title-actions');
    await page.getByRole('button', {name: '编辑自定义规则', exact: true}).click();
    assert.equal(await page.locator('.content-row').count(), 20);assert.equal(await page.locator('.content-row details').count(), 0);
    await page.getByRole('textbox', {name: '区域描述 11', exact: true}).scrollIntoViewIfNeeded();
    await checkLayout('twenty-regions-desktop');
    const position = () => page.locator('.settings-card').evaluate(element => element.scrollTop);
    const before = await position();await save();await saved();assert(Math.abs(await position() - before) < 3, 'Save moved the editor scroll position');
    assert.deepEqual((await config()).siteAdaptation.custom.rules.find(rule => rule.id === longRule.id).omit, ['.author']);
    assert.equal((await config()).siteAdaptation.custom.rules.find(rule => rule.id === longRule.id).allScopes, true);
    for (const [language, width, theme] of [['zh-CN', 390, 'light'], ['en-US', 820, 'light'], ['fr-FR', 390, 'dark']]) {
      await page.setViewportSize({width, height: 900});await patch({uiLanguage: language, theme});
      await page.waitForFunction(language => document.documentElement.lang === language, language);
      await page.locator('.content-row').nth(10).scrollIntoViewIfNeeded();await checkLayout('twenty-regions-' + language + '-' + width + '-' + theme);
    }
    await patch({uiLanguage: 'zh-CN', theme: 'light'});await page.setViewportSize({width: 1440, height: 900});
    await page.getByRole('textbox', {name: '规则名称', exact: true}).fill('本地尚未保存');
    const peer = await open();const external = (await config(peer)).siteAdaptation;
    external.custom.rules.find(rule => rule.id === longRule.id).name = '来自另一个设置页';
    await patch({siteAdaptation: external}, peer);
    await page.getByRole('alert').filter({hasText: '规则已从其他页面更新'}).waitFor();assert.equal(await page.locator('.editor-actions button[type="submit"]').isDisabled(), true);
    page.once('dialog', dialog => dialog.dismiss());await finish();assert.equal(await page.locator('[data-rule-form]').count(), 1);
    page.once('dialog', dialog => dialog.accept());await finish();await peer.close();
    report.crossPageSync = true;report.latestWriteWins = true;report.cases.push({name: 'conflict-after-saving-preserves-external-update-and-local-draft', passed: true});
    await page.close();page = await open();
    const reopened = (await config()).siteAdaptation.custom.rules;
    assert.equal(reopened.find(rule => rule.id === id).name, '第三次调试');assert.equal(reopened.find(rule => rule.id === longRule.id).name, '来自另一个设置页');
    report.persistenceCases.push({name: 'rule-revisions-survive-close-and-reopen', passed: true});
    diagnostics.setPhase('complete');report.ok = true;
  } catch (error) {
    primaryError = error;report.error = String(error.stack || error);process.exitCode = 1;
    if (page && !page.isClosed()) await page.screenshot({path: path.join(artifactsDir, 'failure.png')}).catch(() => {});
  } finally {
    await finalizeRun({diagnostics, result: report, artifactsDir, primaryError, cleanup: [
      {stage: 'browser-close', action: async () => {if (launched) {await launched.close();browserClosed = true;}}},
      {stage: 'profile-remove', action: async () => {if (browserClosed) await fs.promises.rm(profileDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});}},
    ], emitReport: value => console.log(JSON.stringify({ok: value.ok, cases: value.cases.length, diagnostics: value.runtimeDiagnostics?.counts, error: value.error, report: path.join(artifactsDir, 'result.json')}))});
  }
}
main().catch(error => {console.error(error);process.exitCode = 1;});
