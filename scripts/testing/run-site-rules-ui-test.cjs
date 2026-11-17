'use strict';
const {guardBrowserClose} = require('./owned-browser-close.cjs');
// 网站规则专项：仅使用临时生产扩展 profile，验证独立标题分隔栏、配置保留、同页定位、单次保存、编辑导入、诊断与窄屏布局。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
function arg(name, fallback) { const index = process.argv.indexOf('--' + name); return index < 0 ? fallback : process.argv[index + 1]; }
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-site-rules-ui'));
const {chromium} = require(path.join(arg('playwright-root', '/Users/thinkstu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground} =
  require(arg('focus-safe-helper', path.join(__dirname, 'focus-safe-browser.cjs')));
fs.mkdirSync(artifactsDir, {recursive: true});
async function main() {
  const profileDir = fs.mkdtempSync('/private/tmp/fr-site-rules-');
  const report = {ok: false, artifact: 'production', extensionDir, cases: [], caseCoverage: [], persistenceCases: [], quickClose: false, crossPageSync: false, latestWriteWins: false, screenshots: [], consoleErrors: []};
  const timeout = 30000;
  let launched, page, server, primaryError;
  let launchAttempted = false;
  try {
    server = http.createServer((_request, response) => {response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html><body><article><h1>Local rules fixture</h1><p>This fixture does not call a translation provider.</p></article></body></html>');});
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
    report.manifest = {options: manifest.options_page || manifest.options_ui?.page, popup: manifest.action?.default_popup};
    assert(report.manifest.options && report.manifest.popup);
    launchAttempted = true;
    launched = await launchFocusSafePersistentContext({chromium, profileDir, timeout, background: true, headless: false,
      browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', displayTarget: arg('display', 'secondary'),
      viewport: {width: 1440, height: 900}, browserArgs: ['--disable-extensions-except=' + extensionDir, '--load-extension=' + extensionDir, '--no-first-run', '--no-default-browser-check']});
    guardBrowserClose(launched, profileDir);
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    const context = launched.context;
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout});
    worker.on('console', message => {if (message.type() === 'error') report.consoleErrors.push({surface: 'worker', message: message.text()});});
    const origin = 'chrome-extension://' + new URL(worker.url()).host;
    const optionsUrl = origin + '/' + report.manifest.options + '#settings-sites';
    async function open(url = optionsUrl) {
      const result = await newPageWithoutForeground(context, timeout);
      result.on('pageerror', error => report.consoleErrors.push({surface: 'page', message: error.message}));
      result.on('console', message => {if (message.type() === 'error') report.consoleErrors.push({surface: 'page', message: message.text()});});
      await result.emulateMedia({reducedMotion: 'reduce'});
      await result.addInitScript(() => {
        if (!chrome.runtime?.sendMessage) return;
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = (...args) => {
          if (window.__frFailSiteRuleSave && args[0]?.type === 'persistConfig' && args[0]?.config?.siteAdaptation) {
            window.__frFailSiteRuleSave = false;
            const failure = {success: false, error: 'Controlled site-rule save failure'};
            const callback = args[args.length - 1];
            if (typeof callback === 'function') { queueMicrotask(() => callback(failure)); return; }
            return Promise.resolve(failure);
          }
          return send(...args);
        };
      });
      await result.goto(url, {waitUntil: 'domcontentloaded'});
      return result;
    }
    async function readConfig() {
      const result = await page.evaluate(() => chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'}));
      assert(result.success && result.value); return result.value;
    }
    async function patchConfig(patch) {
      const previous = await readConfig();
      const expected = Object.fromEntries(Object.keys(patch).map(key => [key, previous[key]]));
      const result = await page.evaluate(({patch, expected}) => chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: patch, expected}), {patch, expected});
      assert(result.success);
    }
    async function panel(id) {
      await page.locator('[data-settings-anchor-link="' + id + '"]').click();
      await page.locator('#settings-sites [data-settings-panel="' + id + '"]').waitFor();
      await page.waitForFunction(id => {
        const container = document.querySelector('.settings-card');
        const section = document.querySelector('#settings-sites [data-settings-panel="' + id + '"]');
        const box = container.getBoundingClientRect(), target = section.getBoundingClientRect();
        return target.top < box.bottom && target.bottom > box.top;
      }, id);
      assert.equal(await page.locator('[data-settings-anchor-link="' + id + '"]').getAttribute('aria-current'), 'location');
    }
    const card = selector => page.locator(selector);
    async function shot(name) {const filename = path.join(artifactsDir, name + '.png'); await page.screenshot({path: filename}); report.screenshots.push(filename);}
    async function layout(name) {
      await page.waitForTimeout(120);
      const metrics = await page.evaluate(() => {
        const luminance = color => {
          const rgb = color.match(/[0-9.]+/g).slice(0, 3).map(Number).map(value => value / 255);
          const linear = rgb.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
          return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
        };
        const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
        const containers = [...document.querySelectorAll('.rule-card, .visual-editor, .rule-detail, .preview-states, .preference-row')].filter(element => element.getClientRects().length);
        const primaryContrast = [...document.querySelectorAll('.rule-workspace .rule-primary:not(:disabled)')].filter(element => element.getClientRects().length).map(element => {
          const style = getComputedStyle(element);
          const foreground = luminance(style.color), background = luminance(style.backgroundColor);
          return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
        });
        const sectionHeaders = [...document.querySelectorAll('#settings-sites .rule-section-heading')].map(heading => {
          const style = getComputedStyle(heading), title = heading.querySelector('h2');
          const section = heading.parentElement, box = heading.getBoundingClientRect(), sectionBox = section.getBoundingClientRect();
          const toggle = section.querySelector('.rule-toggle-row');
          return {title: title?.textContent, titleId: title?.id, labelledBy: section.getAttribute('aria-labelledby'),
            borderWidth: parseFloat(style.borderBottomWidth), borderStyle: style.borderBottomStyle,
            separateBackground: style.backgroundColor !== getComputedStyle(section).backgroundColor,
            fullWidth: box.left <= sectionBox.left + 2 && box.right >= sectionBox.right - 2,
            switchInHeading: Boolean(heading.querySelector('[role="switch"]')),
            toggleBelow: !toggle || toggle.getBoundingClientRect().top >= box.bottom - 1};
        });
        return {width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight, sectionHeaders,
          overflowing: containers.filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.className),
          duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index), primaryContrast};
      });
      assert(metrics.documentWidth <= metrics.width + 1 && metrics.documentHeight <= metrics.height + 1, JSON.stringify(metrics));
      assert.equal(metrics.overflowing.length, 0, JSON.stringify(metrics));
      assert.equal(metrics.duplicateIds.length, 0);
      assert.equal(metrics.sectionHeaders.length, 3, JSON.stringify(metrics.sectionHeaders));
      assert(metrics.sectionHeaders.every(header => header.title && header.titleId === header.labelledBy && header.borderWidth >= 1 && header.borderStyle === 'solid' && header.separateBackground && header.fullWidth && !header.switchInHeading && header.toggleBelow), 'Independent section headers: ' + JSON.stringify(metrics.sectionHeaders));
      assert(metrics.primaryContrast.every(value => value >= 4.5), 'Primary button contrast: ' + JSON.stringify(metrics.primaryContrast));
      report.cases.push({name, metrics});
    }
    page = await open();
    await page.locator('[data-setting="site-preferences"]').waitFor();
    assert.equal(await page.locator('nav [data-section="settings-sites"]').evaluate(element => element.closest('.nav-group').querySelector('.nav-group-toggle').textContent.trim().replace('›', '').trim()), '工具与学习');
    await page.locator('[data-settings-anchor-link="preview"]').waitFor();
    assert.deepEqual(await page.locator('[data-settings-anchor-link]').allTextContents(), ['网站偏好', '正文适配', '生效预览']);
    assert.equal(await page.locator('#settings-sites [data-settings-panel]:visible').count(), 3);
    assert.equal(await page.locator('[data-setting="site-preferences"] .rule-card').count(), 1);
    assert.equal(await page.locator('[data-setting="site-rule-preview"] .rule-empty').count(), 0);
    assert.equal(await page.locator('.backup-tools').evaluate(element => element.open), false);
    await shot('continuous-default');
    await patchConfig({on: true, uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, autoTranslate: false, disableFloatingBall: false,
      alwaysTranslateDomains: ['example.com'], disabledExtensionDomains: ['example.com'], floatingBallDisabledDomains: ['example.com']});
    const row = page.locator('[data-site-preference="example.com"]');
    await row.waitFor();
    assert.equal(await row.count(), 1);
    assert.match(await row.textContent(), /已禁用扩展/);
    await row.getByRole('checkbox', {name: '禁用扩展 example.com', exact: true}).uncheck();
    await page.close();
    page = await open();
    await page.locator('[data-site-preference="example.com"]').waitFor();
    assert.equal(await page.getByRole('checkbox', {name: '禁用扩展 example.com', exact: true}).isChecked(), false);
    assert.equal(await page.getByRole('checkbox', {name: '始终翻译 example.com', exact: true}).isChecked(), true);
    report.quickClose = true;
    report.persistenceCases.push({name: 'quick-close-site-preference', passed: true});
    const prefs = card('[data-setting="site-preferences"]');
    await prefs.getByRole('textbox', {name: '域名或完整网址'}).fill('http://127.0.0.1:' + server.address().port + '/article');
    await prefs.getByRole('button', {name: '添加网站', exact: true}).click();
    await page.locator('[data-site-preference="127.0.0.1"]').waitFor();
    await page.locator('[data-site-preference="example.com"]').getByRole('button', {name: '移除网站偏好 example.com'}).click();
    await page.locator('[data-site-preference="example.com"]').waitFor({state: 'detached'});
    await prefs.getByRole('button', {name: '撤销移除', exact: true}).click();
    await page.locator('[data-site-preference="example.com"]').waitFor();
    await layout('preferences-desktop'); await shot('preferences-desktop');
    const content = await open('http://127.0.0.1:' + server.address().port + '/article');
    await activateExtensionTabWithoutForeground(context, content);
    const popup = await newPageWithoutForeground(context, timeout);
    await popup.setViewportSize({width: 400, height: 600});
    // 普通扩展测试页签不是原生工具栏 popup，激活它后 active tab 就是扩展页。
    // 只控制当前页查询，返回真实本地 fixture 的 tab 对象；配置和保存接口仍为生产代码。
    await popup.addInitScript(fixtureUrl => {
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (info, callback) => {
        if (info.active !== true) return query(info, callback);
        const {active: _active, ...rest} = info;
        return query(rest, tabs => callback(tabs.filter(tab => tab.url === fixtureUrl)));
      };
    }, content.url());
    popup.on('pageerror', error => report.consoleErrors.push({surface: 'popup', message: error.message}));
    popup.on('console', message => {if (message.type() !== 'debug') report.popupConsole = [...(report.popupConsole || []), {type: message.type(), text: message.text()}];});
    popup.on('requestfailed', request => {report.popupFailedRequests = [...(report.popupFailedRequests || []), {url: request.url(), error: request.failure()}];});
    await popup.goto(origin + '/' + report.manifest.popup, {waitUntil: 'domcontentloaded'});
    await activateExtensionTabWithoutForeground(context, popup);
    report.currentTabFixture = 'actual local tab; active-tab lookup controlled for normal popup test tab';
    try { await popup.locator('[data-setting="always-translate-site"]').waitFor({timeout: 12000}); }
    catch (error) {
      report.popupDebug = await popup.evaluate(() => ({readyState: document.readyState, visibility: document.visibilityState,
        text: document.body.innerText}));
      await popup.screenshot({path: path.join(artifactsDir, 'popup-failure.png')});
      throw error;
    }
    assert.equal(await popup.locator('[data-setting="always-translate-site"]').getAttribute('data-enabled'), 'true');
    report.crossPageSync = true;
    const popupShot = path.join(artifactsDir, 'popup-cross-page.png');
    await popup.screenshot({path: popupShot}); report.screenshots.push(popupShot);
    await popup.close(); await content.close();
    const preferencesBefore = await readConfig();
    await patchConfig({autoTranslate: true, alwaysTranslateDomains: [], disabledExtensionDomains: [], floatingBallDisabledDomains: []});
    await prefs.locator('.rule-toggle-row .el-switch').filter({has: page.locator('[aria-checked="true"]')}).waitFor();
    assert.equal(await prefs.locator('.rule-empty').count(), 0);
    await shot('preferences-empty-global');
    await patchConfig({autoTranslate: false, alwaysTranslateDomains: preferencesBefore.alwaysTranslateDomains,
      disabledExtensionDomains: preferencesBefore.disabledExtensionDomains, floatingBallDisabledDomains: preferencesBefore.floatingBallDisabledDomains});
    await panel('adaptation');
    const adaptation = card('[data-setting="site-adaptation"]');
    assert.equal(await adaptation.locator('.catalog-rule').count(), 30);
    await adaptation.getByRole('button', {name: '新建规则', exact: true}).click();
    await page.getByRole('textbox', {name: '规则名称', exact: true}).fill('阅读测试规则');
    await adaptation.locator('.form-advanced > summary').click();
    assert.match(await page.getByRole('textbox', {name: '规则标识', exact: true}).inputValue(), /^user-site-/);
    await page.getByRole('textbox', {name: '规则标识', exact: true}).fill('user-article');
    await page.getByRole('textbox', {name: '匹配域名', exact: true}).fill('example.com\n*.example.com');
    await page.getByRole('textbox', {name: '匹配路径（可选）', exact: true}).fill('/articles/*');
    await page.getByRole('textbox', {name: '排除路径（可选）', exact: true}).fill('/articles/private/*');
    await page.getByRole('radio', {name: '限定范围：只翻译指定的正文区域', exact: true}).check();
    await adaptation.getByRole('button', {name: '添加正文区域', exact: true}).click();
    await page.getByRole('textbox', {name: '正文 CSS 选择器 1', exact: true}).fill(':is(article, main) p');
    await page.getByRole('textbox', {name: '保留原文区域（可选）', exact: true}).fill('code\nbutton');
    await adaptation.locator('[data-rule-form]').scrollIntoViewIfNeeded();
    await adaptation.locator('.form-advanced > summary').click();
    await adaptation.locator('[data-rule-form]').evaluate(element => element.scrollIntoView({block: 'start'}));
    assert((await page.getByRole('textbox', {name: '规则名称', exact: true}).boundingBox()).height <= 50, 'Single-line input stretched to adjacent textarea height');
    await layout('visual-form-desktop'); await shot('visual-form-desktop');
    assert.equal((await readConfig()).siteAdaptation.custom.rules.length, 0, 'Unsaved form unexpectedly persisted');
    await page.evaluate(() => { window.__frFailSiteRuleSave = true; });
    await adaptation.getByRole('button', {name: '保存并应用', exact: true}).click();
    await adaptation.getByRole('alert').filter({hasText: '保存失败'}).waitFor();
    assert.equal(await page.getByRole('textbox', {name: '规则名称', exact: true}).inputValue(), '阅读测试规则');
    assert.equal((await readConfig()).siteAdaptation.custom.rules.length, 0);
    await adaptation.getByRole('button', {name: '保存并应用', exact: true}).click();
    await adaptation.getByRole('status').filter({hasText: '规则已应用；'}).waitFor();
    assert.equal((await readConfig()).siteAdaptation.custom.rules[0].id, 'user-article');
    await adaptation.getByRole('button', {name: '结束编辑', exact: true}).first().click();
    await adaptation.locator('.catalog-filters').getByRole('button', {name: /^全部规则/}).click();
    await adaptation.getByRole('searchbox', {name: '搜索网站规则', exact: true}).fill('GitHub');
    assert((await adaptation.locator('.catalog-rule').count()) > 0);
    await layout('catalog-desktop'); await shot('catalog-desktop');
    await panel('preview');
    const preview = card('[data-setting="site-rule-preview"]');
    await preview.getByRole('textbox', {name: '输入完整网址', exact: true}).fill('https://docs.example.com/articles/hello');
    await preview.getByRole('button', {name: '检查规则', exact: true}).click();
    await page.locator('[data-preview-rule="user-article"]').waitFor();
    assert.match(await preview.textContent(), /自动翻译 · 网站偏好/);
    assert.match(await preview.textContent(), /限定范围：只翻译指定的正文区域/);
    await panel('preview');
    await layout('preview-desktop'); await shot('preview-desktop');
    await preview.getByRole('button', {name: '查看规则', exact: true}).click();
    await adaptation.locator('[data-rule-detail]').waitFor();
    await shot('rule-detail-desktop');
    assert.match(await adaptation.locator('[data-rule-detail]').textContent(), /阅读测试规则/);
    // 导入默认合并；同 ID 覆盖可撤销，未保存包不参与网址预览。
    const imported = {version: 1, rules: [{id: 'imported-rule', name: '导入规则', match: {hosts: ['other.test']}, protect: ['pre']}]};
    await adaptation.locator('.backup-tools > summary').click();
    await adaptation.locator('input[type="file"]').setInputFiles({name: 'rules.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported))});
    await page.locator('[data-adaptation-rule="imported-rule"]').waitFor();
    await adaptation.getByRole('button', {name: '保存并应用', exact: true}).click();
    await adaptation.getByRole('status').filter({hasText: '规则已应用；'}).waitFor();
    assert.deepEqual((await readConfig()).siteAdaptation.custom.rules.map(rule => rule.id), ['user-article', 'imported-rule']);
    // JSON 不合法时不改变已有配置，用户可以恢复与撤销草稿。
    await adaptation.locator('.json-editor > summary').click();
    const json = adaptation.getByRole('textbox', {name: 'JSON 编辑草稿', exact: true});
    const saved = await json.inputValue();
    await json.fill('{broken');
    assert.equal(await page.evaluate(() => {
      const event = new Event('beforeunload', {cancelable: true});
      window.dispatchEvent(event); return event.defaultPrevented;
    }), true, 'Unsaved draft must request the browser leave warning');
    await adaptation.getByRole('button', {name: '保存并应用', exact: true}).click();
    await adaptation.getByRole('alert').first().waitFor();
    assert.equal((await readConfig()).siteAdaptation.custom.rules.length, 2);
    await adaptation.getByRole('button', {name: '恢复已保存草稿', exact: true}).click();
    assert.equal(await json.inputValue(), saved);
    assert.equal(await page.evaluate(() => {
      const event = new Event('beforeunload', {cancelable: true});
      window.dispatchEvent(event); return event.defaultPrevented;
    }), false, 'Saved state must not block leaving');
    // 外部写入不能覆盖未保存草稿，也不能被旧草稿静默回写。
    await json.fill(saved.replace('导入规则', '草稿名称'));
    const current = (await readConfig()).siteAdaptation;
    current.custom.rules[1].name = '外部名称';
    await patchConfig({siteAdaptation: current});
    await page.getByRole('alert').filter({hasText: '已保存规则在其他页面发生变化'}).waitFor();
    assert.equal(await adaptation.getByRole('button', {name: '保存并应用', exact: true}).isDisabled(), true);
    assert.match(await json.inputValue(), /草稿名称/);
    await adaptation.getByRole('button', {name: '恢复已保存草稿', exact: true}).click();
    assert.match(await json.inputValue(), /外部名称/);
    report.latestWriteWins = true;
    // 查看、覆盖、停用和移除内置版本的完整往返，不遗失原来的自定义规则。
    await adaptation.locator('.catalog-filters').getByRole('button', {name: /^内置/}).click();
    await adaptation.getByRole('searchbox', {name: '搜索网站规则', exact: true}).fill('');
    const builtinRow = adaptation.locator('.catalog-rule').first();
    const builtinId = await builtinRow.getAttribute('data-adaptation-rule');
    await builtinRow.locator('.catalog-name').click();
    await adaptation.getByRole('button', {name: '基于此规则自定义', exact: true}).click();
    await page.getByRole('textbox', {name: '规则名称', exact: true}).fill('自定义覆盖测试');
    await adaptation.getByRole('button', {name: '保存并应用', exact: true}).click();
    await adaptation.getByRole('status').filter({hasText: '规则已应用；'}).waitFor();
    assert.equal((await readConfig()).siteAdaptation.custom.rules.length, 3);
    await adaptation.getByRole('button', {name: '结束编辑', exact: true}).first().click();
    const overrideRow = adaptation.locator('[data-adaptation-rule="' + builtinId + '"]');
    assert.match(await overrideRow.textContent(), /自定义覆盖/);
    await overrideRow.locator('.el-switch').click();
    await adaptation.getByRole('status').filter({hasText: '规则开关已保存'}).waitFor();
    assert((await readConfig()).siteAdaptation.disabledRuleIds.includes(builtinId));
    await overrideRow.locator('.catalog-name').click();
    // 若详情已展开，第一次点击会关闭，再点开以测试真实目录切换。
    if (!(await adaptation.locator('[data-rule-detail]').isVisible())) await overrideRow.locator('.catalog-name').click();
    await adaptation.getByRole('button', {name: '从草稿移除', exact: true}).click();
    await adaptation.getByRole('button', {name: '保存并应用', exact: true}).click();
    await adaptation.getByRole('status').filter({hasText: '规则已应用；'}).waitFor();
    assert.equal((await readConfig()).siteAdaptation.custom.rules.length, 2);
    assert((await readConfig()).siteAdaptation.disabledRuleIds.includes(builtinId));
    await adaptation.locator('.catalog-filters').getByRole('button', {name: /^已停用/}).click();
    assert.equal(await adaptation.locator('[data-adaptation-rule="' + builtinId + '"]').count(), 1);
    await panel('preview');
    await patchConfig({translationScope: 'all'});
    assert.equal((await readConfig()).translationScope, 'all');
    await preview.getByText(/不适用于全部节点/).waitFor();
    assert.match(await preview.textContent(), /不适用于全部节点/);
    assert.doesNotMatch(await preview.locator('.preview-adaptation > .rule-hint').last().textContent(), /限定范围：只翻译指定的正文区域/);
    await patchConfig({translationScope: 'content'});
    report.caseCoverage.push(...['tools-navigation-and-continuous-anchors', 'independent-section-headers-and-toggle-rows', 'domain-union-and-disable-precedence', 'global-auto-empty-state', 'quick-close-persistence', 'controlled-popup-cross-page', 'visual-rule-single-save-and-failure-retry', 'saved-config-preview-and-jump', 'merge-import-preserves-existing', 'invalid-json-preserves-saved', 'unsaved-exit-protection', 'external-draft-conflict', 'builtin-override-disable-remove-restore', 'all-node-scope-preview'].map(id => ({id, status: 'passed'})));
    await page.close(); page = await open(); await panel('adaptation');
    await page.locator('[data-setting="site-adaptation"]').waitFor();
    await page.locator('[data-setting="site-adaptation"] .catalog-filters').getByRole('button', {name: /^自定义/}).click();
    assert.equal(await page.locator('[data-adaptation-rule]').count(), 2);
    report.persistenceCases.push({name: 'visual-and-import-reopen', passed: true});
    await shot('rules-reopened');
    // 同一实例中检查窄屏与深色；不启动或激活用户的日常浏览器。
    for (const width of [1024, 820, 390]) {
      await page.setViewportSize({width, height: 900});
      for (const id of ['rules', 'adaptation', 'preview']) {await panel(id); await layout(id + '-' + width); await shot(id + '-' + width);}
    }
    await page.setViewportSize({width: 1440, height: 900});
    await patchConfig({theme: 'dark'}); await panel('adaptation');
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
    await layout('adaptation-dark'); await shot('adaptation-dark');
    // 复核资源按需加载后的英文标签、用户数据不被本地化，以及恢复中文。
    await patchConfig({uiLanguage: 'en-US', theme: 'light'});
    await page.getByRole('heading', {name: 'Content rules', exact: true}).waitFor();
    assert.match(await page.locator('[data-setting="site-adaptation"]').textContent(), /Advanced JSON editor/);
    assert.match(await page.locator('[data-setting="site-adaptation"]').textContent(), /阅读测试规则/);
    await layout('adaptation-english'); await shot('adaptation-english');
    await patchConfig({uiLanguage: 'zh-CN'});
    await page.getByRole('heading', {name: '正文适配', exact: true}).waitFor();
    await page.locator('nav [data-section="settings-data"]').click();
    await page.locator('[data-settings-anchor-link="history"]').click();
    await page.locator('.version-entry').first().waitFor();
    await page.locator('.version-entry').first().scrollIntoViewIfNeeded();
    assert.match(await page.locator('.version-entry').first().textContent(), /v[0-9]+/);
    await shot('configuration-history');
    report.persistenceCases.push({name: 'history-version-and-time', passed: true});
    assert.equal(report.consoleErrors.length, 0, JSON.stringify(report.consoleErrors));
    report.ok = true;
  } catch (error) {
    primaryError = error;
    report.failure = error.stack || String(error);
    if (page && !page.isClosed()) await page.screenshot({path: path.join(artifactsDir, 'failure.png')}).catch(() => {});
    process.exitCode = 1;
  } finally {
    const cleanupErrors = [];
    const cleanup = async (resource, release) => {
      try { await release(); } catch (error) {
        cleanupErrors.push(error);
        (report.cleanupErrors ||= []).push({resource, error: String(error.stack || error)});
        report.ok = false;
        process.exitCode = 1;
        console.error(`Cleanup failed (${resource}):`, error);
      }
    };
    let browserClosed = false;
    await cleanup('browser', async () => { if (launched) { await launched.close(); browserClosed = true; } });
    await cleanup('HTTP fixture', () => new Promise((resolve, reject) => {
  if (!server) return resolve();
  server.close(error => { if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve(); });
}));
    await cleanup('profile', () => {
      if (!profileDir) return;
      if (browserClosed) fs.rmSync(profileDir, {recursive: true, force: true});
      else if (!launchAttempted) {
        try { fs.rmdirSync(profileDir); } catch (error) {
          // 未尝试启动浏览器时，仅移除初始空目录。
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
        }
      }
    });
    await cleanup('report', () => { fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2)); });
    if (cleanupErrors.length && !primaryError) throw cleanupErrors[0];
    console.log(JSON.stringify({ok: report.ok, cases: report.cases.length, failure: report.failure, report: path.join(artifactsDir, 'report.json')}, null, 2));
  }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
