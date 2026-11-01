#!/usr/bin/env node
'use strict';
const {guardBrowserClose} = require('./testing/owned-browser-close.cjs');

// 术语库回归：--suite ui 仅验证管理界面；默认全链路使用 loopback AI fixture。
// 独立临时 Edge、真实配置消息与页面手势，不抢占前台焦点。
// 不读取日常浏览器配置、不使用真实密钥、不以模拟译文证明任何外部模型的遵守率。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

// 只读取生产目录的静态字面量，不执行模块或复用添加副本的被测函数。
// 浏览器必须保存与目录逐项相同的词对、大小写规则、语言和来源版本。
function readBuiltinGlossaryCatalog() {
  const ts = require('typescript');
  const sourcePath = path.join(__dirname, '../src/core/glossary/builtins.ts');
  const sourceFile = ts.createSourceFile(sourcePath, fs.readFileSync(sourcePath, 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = sourceFile.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .find(item => ts.isIdentifier(item.name) && item.name.text === 'BUILTIN_GLOSSARIES');
  assert(declaration?.initializer && ts.isArrayLiteralExpression(declaration.initializer), '生产内置词库必须有完整静态目录');
  const literal = node => {
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
    if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(property => {
      assert(ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)), '目录只能使用静态命名属性');
      return [property.name.text, literal(property.initializer)];
    }));
    assert.fail(`内置词库有未支持的非静态数据：${node.getText(sourceFile)}`);
  };
  return literal(declaration.initializer);
}

function assertAdoptedBuiltin(library, preset) {
  assert.deepEqual(library.preset, {id: preset.id, version: preset.version});
  assert.equal(library.sourceLanguage, preset.sourceLanguage);
  assert.equal(library.targetLanguage, preset.targetLanguage);
  assert.deepEqual(library.entries, preset.terms.map(([source, target], index) => ({
    id: `term-${index + 1}`, source, target, caseSensitive: preset.caseSensitive,
  })), '添加与重新打开必须保留生产目录的全部词对及顺序，含空译词');
}

function documentTermToken(source, index) {
  return `__FRTERM_${createHash('sha256').update(`0\0${source}`).digest('hex').slice(0, 12)}_${index}__`;
}


// 设置页和文档页的下拉框是 Element Plus 组合框：点击后按可见选项文字选择。
async function chooseComboboxOption(page, combobox, optionText) {
  await combobox.click({force: true});
  // 只在该组合框控制的列表里找选项，避免上一个下拉框的离场动画残留被误点。
  const listbox = page.locator(`[id="${await combobox.getAttribute('aria-controls')}"]`);
  const option = listbox.locator('[role="option"]').filter({hasText: optionText}).first();
  await option.waitFor({state: 'visible'});
  await option.evaluate((element) => element.click());
}
async function startFixture() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', '*');
    if (request.method === 'OPTIONS') {response.writeHead(204); response.end(); return;}
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const prompt = body.messages.filter(message => message.role === 'user').map(message => message.content).join('\n');
        const source = /SOURCE_BEGIN([\s\S]*?)SOURCE_END/u.exec(prompt)?.[1];
        assert.equal(typeof source, 'string', 'fixture 应收到正常用户模板');
        const terms = JSON.parse(/<fluentread_glossary>([\s\S]*?)<\/fluentread_glossary>/u.exec(prompt)?.[1] || '[]');
        requests.push({source, terms});
        let translated = source;
        for (const term of terms) translated = translated.replaceAll(term.source, term.target);
        if (!terms.some(term => term.source === 'agent')) translated = translated.replaceAll('agent', '代理人');
        translated = /___FLUENTREAD_[a-z0-9_-]+_\d+_BEGIN___/iu.test(translated)
          ? translated.replace(/(___FLUENTREAD_[a-z0-9_-]+_\d+_BEGIN___)/giu, '$1测试译文：')
          : `测试译文：${translated}`;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({id: 'glossary-fixture', object: 'chat.completion', created: 1,
          model: 'glossary-fixture', choices: [{index: 0, message: {role: 'assistant', content: translated}, finish_reason: 'stop'}],
          usage: {prompt_tokens: 20, completion_tokens: 10, total_tokens: 30}}));
      } catch (error) {response.writeHead(400); response.end(JSON.stringify({error: {message: error.message}}));}
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    const paragraph = request.url === '/builtin' ? 'The large language model uses a context window to read this document.' : 'The agent uses FluentRead to understand this document.';
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Glossary fixture</title></head><body style="padding:60px;font:20px/1.8 sans-serif"><main><h1>Terminology reading test</h1><p id="glossary-primary">${paragraph}</p><p id="glossary-neighbor">This paragraph is a separate sentence without a matching term.</p></main></body></html>`);
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  return {url: `http://127.0.0.1:${server.address().port}`, requests,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))};
}

async function main() {
  const suite = argument('suite', 'full');
  assert(['ui', 'full'].includes(suite), 'suite 仅支持 ui 或 full');
  const builtinCatalog = suite === 'full' ? readBuiltinGlossaryCatalog() : [];
  const aiBuiltin = builtinCatalog.find(preset => preset.id === 'ai-en-zh-hans');
  if (suite === 'full') assert(aiBuiltin, 'AI 与机器学习词库必须存在于生产目录');
  const extensionDir = path.resolve(argument('extension-dir', '.output/chrome-mv3'));
  const packages = argument('playwright-root');
  const helperPath = argument('focus-safe-helper', path.join(__dirname, 'testing/focus-safe-browser.cjs'));
  assert(packages && helperPath, '必须传入 Playwright 包目录和 focus-safe helper');
  assert(fs.existsSync(path.join(extensionDir, 'manifest.json')), '缺少扩展构建产物');
  const {chromium} = require(path.join(packages, 'playwright'));
  const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground} = require(helperPath);
  const artifactsDir = path.resolve(argument('artifacts-dir', '/private/tmp/fluentread-glossary-browser'));
  fs.mkdirSync(artifactsDir, {recursive: true});
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-glossary-edge-'));
  const report = {ok: false, suite, extensionDir, artifactsDir, profileDir, service: suite === 'ui' ? null : 'loopback-openai-fixture',
    scope: suite === 'ui' ? 'glossary direct actions, stable settings disclosure, multi-library order/drafts, import/export, persistence and responsive themes' : 'production built-in glossary catalog/preview/adoption/removal, real matched-term requests, persistence, lossless language import/export, hover/full-page toggles, document selection, cache invalidation and responsive themes',
    cases: [], consoleErrors: [], screenshots: [], persistenceCases: [], quickClose: null, crossPageSync: null, latestWriteWins: null,
    builtinCatalog: builtinCatalog.map(preset => ({id: preset.id, version: preset.version, entries: preset.terms.length}))};
  let fixture;
  let launched;
  let currentPage;
  let primaryError;
  let launchAttempted = false;
  try {
    fixture = suite === 'full' ? await startFixture() : null;
    launchAttempted = true;
    launched = await launchFocusSafePersistentContext({chromium, profileDir,
      browserPath: argument('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      background: true, headless: false, viewport: {width: 1440, height: 960}, timeout: 30000,
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    guardBrowserClose(launched, profileDir);
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    const context = launched.context;
    const capture = (surface, source) => {
      surface.on('console', message => {if (message.type() === 'error') report.consoleErrors.push({source, message: message.text()});});
      surface.on('pageerror', error => report.consoleErrors.push({source, message: error.message}));
    };
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 30000});
    capture(worker, 'worker');
    const extensionOrigin = new URL(worker.url()).origin === 'null'
      ? /^chrome-extension:\/\/[^/]+/u.exec(worker.url())[0] : new URL(worker.url()).origin;
    const createPage = async (url, name) => {
      const page = await newPageWithoutForeground(context, 30000);
      page.setDefaultTimeout(15000); capture(page, name);
      await page.goto(url, {waitUntil: 'domcontentloaded'});
      currentPage = page;
      return page;
    };
    let options = await createPage(`${extensionOrigin}/options.html#settings-glossary`, 'options');
    const readConfig = () => options.evaluate(async () => {
      const result = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      if (!result?.success) throw new Error(result?.error || '读取配置失败');
      return typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
    });
    const patchConfig = async patch => {
      const current = await readConfig();
      const expected = Object.fromEntries(Object.keys(patch).map(key => [key, current[key]]));
      // 只在全新的临时 profile 初始化合成凭据时使用带 revision 的完整替换；公开记录不包含 token，不能充当其 CAS 旧值。
      const initialCredentials = Object.hasOwn(patch, 'token');
      if (initialCredentials) assert.equal(current.glossaryLibraries?.length, 0, '合成凭据只能在空白隔离 profile 初始化');
      const result = await options.evaluate(async ({patch, expected, current, initialCredentials}) => chrome.runtime.sendMessage({
        type: 'persistConfig', mode: initialCredentials ? 'replace' : 'patch',
        config: initialCredentials ? {...current, ...patch} : patch, expected,
        baseRevision: initialCredentials ? current.__fluentConfigRevision : undefined,
        clientId: `glossary-fixture-${crypto.randomUUID()}`, sequence: 1}), {patch, expected, current, initialCredentials});
      assert.equal(result?.success, true, result?.error);
    };
    const waitConfig = async predicate => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const value = await readConfig();
        if (predicate(value)) return value;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const current = await readConfig();
      const names = current.glossaryLibraries?.map(library => ({id: library.id, name: library.name})) || [];
      const status = await ui?.locator('.glossary-save-state, .glossary-error').allTextContents().catch(() => []);
      throw new Error(`配置未达到预期持久化状态: ${JSON.stringify({names, status})}`);
    };
    const shot = async (page, name) => {
      const file = path.join(artifactsDir, `${name}.png`);
      await page.screenshot({path: file, animations: 'disabled'}); report.screenshots.push(file);
    };
    const service = 'custom:glossary-fixture';
    if (suite === 'ui') {
      await patchConfig({uiLanguage: 'zh-CN', theme: 'light'});
    } else {
      await patchConfig({uiLanguage: 'zh-CN', on: true, service, from: 'en', to: 'zh-Hans', display: 1,
        customOpenAIProviders: [{id: service, name: '术语库测试服务', endpoint: `${fixture.url}/v1/chat/completions`, models: ['glossary-fixture']}],
        token: {[service]: 'synthetic-local-fixture-not-a-secret'}, model: {[service]: 'glossary-fixture'},
        user_role: {[service]: 'SOURCE_BEGIN{{origin}}SOURCE_END'}, enableAIContext: false, enableAIMultiSegment: false,
        hotkey: 'Control', mouseHoverTranslationDelay: 0, disableSelectionTranslator: true});
    }
    const ui = options.getByTestId('glossary-settings');
    await ui.waitFor({state: 'visible'});
    await shot(options, 'glossary-empty');
    const showPanel = async (root, name) => {
      const checkDialog = root.page().getByRole('dialog', {name: '匹配预览', exact: true});
      if (name !== '匹配预览' && await checkDialog.isVisible()) await checkDialog.locator('.el-dialog__headerbtn').click();
      if (name === '内置词库') {
        await root.getByTestId('builtin-glossaries').scrollIntoViewIfNeeded();
      } else if (name === '匹配预览') {
        if (!(await checkDialog.isVisible())) {
          await root.locator('.glossary-main-toolbar').getByRole('button', {name, exact: true}).click();
          await checkDialog.waitFor();
        }
        const conditions = checkDialog.locator('.glossary-preview-options');
        if (await conditions.count() && !(await conditions.evaluate(element => element.open))) await conditions.locator('summary').click();
      }
    };
    const showSection = name => showPanel(ui, name);
    const toolbarAction = name => ui.locator('.glossary-main-toolbar').getByRole('button', {name, exact: true}).click();
    const selectLibrary = async (root, index) => {
      const select = root.locator('.glossary-library-picker [role="combobox"]');
      await select.click({force: true});
      const list = options.locator(`[id="${await select.getAttribute('aria-controls')}"]`);
      await list.getByRole('option').nth(index).evaluate(element => element.click());
    };
    const showSettings = async () => {
      await showSection('我的术语库');
      const toggle = ui.getByRole('button', {name: '词库设置', exact: true});
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    };
    assert.equal(await ui.locator('.glossary-more').count(), 0, '术语库管理不使用更多菜单');
    assert.equal(await ui.locator('.glossary-main-toolbar').getByRole('button', {name: '匹配预览', exact: true}).count(), 0, '空词库不引导无效检查');
    await shot(options, 'glossary-empty-guidance');
    if (suite === 'ui') {
      const toggle = ui.getByRole('button', {name: '词库设置', exact: true});
      const name = ui.getByLabel('词库名称', {exact: true});
      const stableSettings = async expanded => {
        await options.waitForFunction(expected => document.querySelector('.glossary-settings-toggle')?.getAttribute('aria-expanded') === String(expected), expanded);
        const frames = await ui.locator('.glossary-editor').evaluate(async element => {
          const frames = [];
          for (let index = 0; index < 12; index++) {
            await new Promise(resolve => requestAnimationFrame(resolve));
            const rect = element.getBoundingClientRect();
            frames.push({height: rect.height, width: rect.width, expanded: element.querySelector('.glossary-settings-toggle').getAttribute('aria-expanded')});
          }
          return frames;
        });
        assert(frames.every(frame => frame.expanded === String(expanded)), '异步事件不得反转设置展开状态');
        assert(Math.max(...frames.map(frame => frame.height)) - Math.min(...frames.map(frame => frame.height)) <= 1, '展开后卡片高度不抖动');
        assert(Math.max(...frames.map(frame => frame.width)) - Math.min(...frames.map(frame => frame.width)) <= 1, '卡片宽度不抖动');
        report.disclosureFrames ||= [];
        report.disclosureFrames.push({expanded, frames});
      };
      await toolbarAction('新建术语库');
      await name.waitFor();
      await stableSettings(true);
      await name.fill('常用术语'); await name.press('Tab');
      await waitConfig(config => config.glossaryLibraries[0]?.name === '常用术语');
      for (let round = 0; round < 3; round++) {
        await toggle.focus(); await toggle.press(round % 2 ? 'Space' : 'Enter');
        await stableSettings(false); assert.equal(await name.isVisible(), false);
        await toggle.click(); await stableSettings(true); assert.equal(await name.isVisible(), true);
      }
      await toolbarAction('导入术语库');
      const importDialog = options.getByRole('dialog', {name: '导入术语库', exact: true});
      await importDialog.waitFor(); await stableSettings(true);
      await importDialog.getByRole('button', {name: '取消', exact: true}).click();
      await importDialog.waitFor({state: 'hidden'}); await stableSettings(true);
      await shot(options, 'glossary-empty-settings');
      await toggle.click(); await stableSettings(false);
      await ui.getByRole('button', {name: '添加词条', exact: true}).click();
      const form = ui.locator('.glossary-entry-form');
      await form.getByLabel('原词', {exact: true}).fill('large language model');
      await form.getByLabel('译词', {exact: true}).fill('大语言模型');
      await form.getByRole('button', {name: '保存', exact: true}).click();
      await form.waitFor({state: 'hidden'});
      const first = await waitConfig(config => config.glossaryLibraries[0]?.entries.length === 1);
      const firstId = first.glossaryLibraries[0].id;
      assert.equal(first.glossaryEnabled, false, '词库管理不得自动开启翻译总开关');
      await showSection('匹配预览');
      const preview = options.getByTestId('glossary-preview');
      await preview.getByLabel('输入一段原文', {exact: true}).fill('large language model');
      await preview.getByTestId('glossary-matches').getByRole('cell', {name: '大语言模型', exact: true}).waitFor();
      await stableSettings(false);
      await shot(options, 'glossary-direct-match-preview');
      await showSection('我的术语库');
      await ui.getByRole('button', {name: '添加词条', exact: true}).click();
      await form.getByLabel('原词', {exact: true}).fill('draft-example');
      await toolbarAction('新建术语库'); await stableSettings(true);
      await name.fill('技术术语'); await name.press('Tab');
      const second = await waitConfig(config => config.glossaryLibraries[1]?.name === '技术术语');
      const secondId = second.glossaryLibraries[1].id;
      await selectLibrary(ui, 0); await stableSettings(false);
      assert.equal(await form.getByLabel('原词', {exact: true}).inputValue(), 'draft-example');
      await form.getByRole('button', {name: '取消', exact: true}).click();
      const priority = ui.locator('.glossary-order-details');
      await priority.locator(':scope > summary').click();
      assert(await priority.getByRole('button', {name: '上移 常用术语', exact: true}).isDisabled());
      await priority.getByRole('button', {name: '上移 技术术语', exact: true}).click();
      await waitConfig(config => config.glossaryLibraries[0]?.id === secondId);
      assert.equal(await ui.getByRole('cell', {name: '大语言模型', exact: true}).count(), 1, '排序保留正在编辑的词库');
      await priority.locator(':scope > summary').click();
      await toolbarAction('导入术语库');
      await importDialog.getByRole('radio', {name:'粘贴内容',exact:true}).check();
      await importDialog.getByRole('textbox', {name:'粘贴内容',exact:true}).fill('source,target,tgt_lng\ncomponent,组件,zh-CN');
      await importDialog.getByRole('button', {name: '确认导入', exact: true}).click();
      await importDialog.waitFor({state: 'hidden'});
      await waitConfig(config => config.glossaryLibraries.length === 3);
      await ui.getByRole('cell', {name: '组件', exact: true}).waitFor();
      await showSettings();
      const downloadPromise = options.waitForEvent('download');
      await ui.getByRole('button', {name: '导出', exact: true}).click();
      const download = await downloadPromise;
      const csvPath = path.join(artifactsDir, 'imported-glossary.csv');
      await download.saveAs(csvPath);
      assert(fs.readFileSync(csvPath, 'utf8').includes('component'));
      await ui.getByRole('button', {name: '删除词库', exact: true}).click();
      await options.locator('.el-message-box').getByRole('button', {name: '取消', exact: true}).click();
      assert.equal((await readConfig()).glossaryLibraries.length, 3, '取消删除保留词库');
      await options.reload({waitUntil: 'domcontentloaded'}); await ui.waitFor();
      const persisted = await readConfig();
      assert.deepEqual(persisted.glossaryLibraries.map(library => library.id).slice(0, 2), [secondId, firstId]);
      await selectLibrary(ui, 1);
      report.persistenceCases.push('new/rename/entry/import/order persist after reload');
      report.layouts = [];
      for (const width of [1440, 1024, 820, 390]) {
        await options.setViewportSize({width, height: 960});
        const metrics = await ui.evaluate(element => ({width: innerWidth, documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, glossaryOverflow: element.scrollWidth - element.clientWidth}));
        assert(metrics.documentOverflow <= 1 && metrics.glossaryOverflow <= 1, JSON.stringify(metrics));
        report.layouts.push(metrics);
        await shot(options, `glossary-light-${width}`);
        await showSettings(); await stableSettings(true);
        assert(await options.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
        if (width === 390) await shot(options, 'glossary-settings-narrow');
        await toggle.click(); await stableSettings(false);
      }
      await options.setViewportSize({width: 1440, height: 960});
      await showSettings();
      await name.fill('关闭后仍保存'); await name.press('Tab');
      await options.close();
      options = await createPage(`${extensionOrigin}/options.html#settings-glossary`, 'options-reopened');
      await waitConfig(config => config.glossaryLibraries[1]?.name === '关闭后仍保存');
      report.quickClose = {immediatelyClosedAfterChange: true, reopenedValueMatches: true};
      await options.getByTestId('glossary-settings').waitFor();
      await selectLibrary(options.getByTestId('glossary-settings'), 1);
      await shot(options, 'glossary-reopened');
      await patchConfig({theme: 'dark'});
      await shot(options, 'glossary-dark');
      await options.setViewportSize({width: 390, height: 960});
      await patchConfig({uiLanguage: 'en-US'});
      await options.getByTestId('glossary-settings').getByRole('button', {name: 'Import glossaries', exact: true}).waitFor();
      assert(await options.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
      await shot(options, 'glossary-english-narrow-dark');
      report.cases.push('direct create/import/preview controls; empty and populated settings remain discoverable',
        'keyboard and repeated disclosure cycles stay stable across 12 frames; dialogs retain settings state',
        'multi-library drafts, priority changes, import/export and cancelled deletion',
        'reload and immediate-close persistence; 1440/1024/820/390px, dark and English layouts');
      assert.deepEqual(report.consoleErrors, []);
      report.ok = true;
      return;
    }

    await showSection('我的术语库');
    await ui.locator('.glossary-start').getByRole('button', {name: '添加词条', exact: true}).click();
    const firstForm = ui.locator('.glossary-entry-form');
    await firstForm.getByLabel('原词', {exact: true}).fill('large language model');
    await firstForm.getByLabel('译词', {exact: true}).fill('大语言模型');
    await shot(options, 'glossary-first-entry');
    await firstForm.getByRole('button', {name: '保存', exact: true}).click();
    await waitConfig(config => config.glossaryLibraries[0]?.entries.length === 1);
    await showSection('匹配预览');
    await options.getByTestId('glossary-preview').getByLabel('输入一段原文', {exact: true}).fill('large language model');
    await options.getByTestId('glossary-preview').getByTestId('glossary-matches').getByRole('cell', {name: '大语言模型', exact: true}).waitFor();
    await options.getByTestId('glossary-preview').locator('.glossary-preview-options summary').click();
    await shot(options, 'glossary-first-match');
    assert.equal((await readConfig()).glossaryEnabled, false, '关闭总开关时仍能匹配，预览不会自动开启实际翻译');
    await options.setViewportSize({width: 390, height: 850});
    assert(await options.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    await shot(options, 'glossary-match-narrow');
    await options.setViewportSize({width: 1440, height: 960});
    await showSettings();
    await ui.getByRole('button', {name: '删除词库', exact: true}).click();
    await options.locator('.el-message-box').getByRole('button', {name: '删除', exact: true}).click();
    await waitConfig(config => config.glossaryLibraries.length === 0);
    report.cases.push('empty glossary guides entry creation; first saved term matches without manual library setup');
    await showSection('内置词库');

    await shot(options, 'glossary-builtin-catalog');
    assert.equal(await ui.getByTestId('builtin-glossaries').locator('article').count(), builtinCatalog.length);
    await ui.getByRole('button', {name: '预览 AI 与机器学习', exact: true}).click();
    const builtinPreview = options.getByTestId('builtin-glossary-preview');
    await builtinPreview.getByLabel('搜索原词或译词', {exact: true}).fill('context window');
    await builtinPreview.getByRole('cell', {name: '上下文窗口', exact: true}).waitFor();
    assert.equal(await builtinPreview.locator('tbody tr').count(), 1);
    await shot(options, 'builtin-preview-search');
    await builtinPreview.getByRole('button', {name: '添加词库', exact: true}).click();
    let builtinState = await waitConfig(config => config.glossaryLibraries.length === 1);
    assertAdoptedBuiltin(builtinState.glossaryLibraries[0], aiBuiltin);
    assert.equal(builtinState.glossaryEnabled, false, '添加内置词库不能偷偷开启总开关');
    await ui.getByRole('switch', {name: '启用术语库'}).check();
    await waitConfig(config => config.glossaryEnabled);
    const builtinPage = await createPage(`${fixture.url}/builtin`, 'builtin-article');
    await builtinPage.locator('#fluent-read-page-styles').waitFor({state: 'attached'});
    const toggleBuiltin = async expected => {
      await activateExtensionTabWithoutForeground(context, builtinPage, 30000);
      const paragraph = builtinPage.locator('#glossary-primary');
      await paragraph.click(); await paragraph.hover();
      await builtinPage.keyboard.down('Control'); await builtinPage.keyboard.up('Control');
      await builtinPage.waitForFunction(count => document.querySelectorAll('#glossary-primary .fluent-read-bilingual-content').length === count, expected);
    };
    await toggleBuiltin(1);
    assert((await builtinPage.locator('#glossary-primary').innerText()).includes('大语言模型'));
    assert.equal(fixture.requests.at(-1).terms.length, 2);
    assert(fixture.requests.at(-1).terms.every(term => term.source.startsWith('__FRTERM_') && term.source === term.target));
    assert(!fixture.requests.at(-1).source.includes('large language model'));
    await shot(builtinPage, 'builtin-actual-translation');
    await toggleBuiltin(0);
    await activateExtensionTabWithoutForeground(context, options, 30000);
    await ui.getByRole('switch', {name: '启用术语库'}).uncheck();
    await waitConfig(config => !config.glossaryEnabled);
    await toggleBuiltin(1);
    assert.deepEqual(fixture.requests.at(-1).terms, [], '总开关关闭后不得复用内置词库请求');
    await builtinPage.close(); currentPage = options;
    await options.reload({waitUntil: 'domcontentloaded'}); await ui.waitFor();
    builtinState = await readConfig();
    assertAdoptedBuiltin(builtinState.glossaryLibraries[0], aiBuiltin);
    const deleteBuiltin = async () => {
      await showSettings();
      await ui.getByRole('button', {name: '删除词库', exact: true}).click();
      await options.locator('.el-message-box').getByRole('button', {name: '删除', exact: true}).click();
      await waitConfig(config => config.glossaryLibraries.length === 0);
    };
    await deleteBuiltin();
    await showSection('内置词库');
    await ui.getByRole('button', {name: '添加 AI 与机器学习', exact: true}).click();
    builtinState = await waitConfig(config => config.glossaryLibraries[0]?.entries.length === aiBuiltin.terms.length);
    assertAdoptedBuiltin(builtinState.glossaryLibraries[0], aiBuiltin);
    await deleteBuiltin();
    report.cases.push('complete source catalog, searchable real preview, exact ordered editable-copy adoption, source version persistence, deletion and exact re-addition; live pipeline sends only two matched terms and none when disabled');
    await toolbarAction('新建术语库');
    const editor = ui.getByRole('region', {name: '词库设置'});
    await editor.getByLabel('词库名称', {exact: true}).fill('技术词库');
    await editor.getByLabel('词库名称', {exact: true}).press('Tab');
    await waitConfig(config => config.glossaryLibraries[0]?.name === '技术词库');
    const addTerm = async (source, target, caseSensitive = false) => {
      await ui.getByRole('button', {name: '添加词条', exact: true}).click();
      const form = ui.locator('.glossary-entry-form');
      await form.getByLabel('原词', {exact: true}).fill(source);
      await form.getByLabel('译词', {exact: true}).fill(target);
      if (caseSensitive) {await form.locator('.glossary-entry-options summary').click(); await form.getByLabel('区分大小写').check();}
      await form.getByRole('button', {name: '保存', exact: true}).click();
      await form.waitFor({state: 'hidden'});
    };
    await addTerm('agent', '智能体');
    await addTerm('FluentRead', '', true);
    await chooseComboboxOption(options, editor.getByRole('combobox', {name: '源语言', exact: true}), 'English');
    await waitConfig(config => config.glossaryLibraries[0].sourceLanguage === 'en');
    await chooseComboboxOption(options, editor.getByRole('combobox', {name: '目标语言', exact: true}), 'Simplified Chinese');
    await waitConfig(config => config.glossaryLibraries[0].targetLanguage === 'zh-hans');
    await editor.getByLabel('适用网站', {exact: true}).fill('127.0.0.1');
    await editor.getByLabel('适用网站', {exact: true}).press('Tab');
    await waitConfig(config => config.glossaryLibraries[0].domains[0] === '127.0.0.1');
    await ui.getByRole('switch', {name: '启用术语库'}).check();
    await waitConfig(config => config.glossaryEnabled);
    await showSection('匹配预览');
    await options.getByTestId('glossary-preview').getByLabel('输入一段原文', {exact: true}).fill('The agent uses FluentRead.');
    await options.getByTestId('glossary-preview').getByLabel('网页网址（可选）', {exact: true}).fill(`${fixture.url}/article`);
    await options.getByTestId('glossary-preview').getByTestId('glossary-matches').getByRole('cell', {name: '智能体', exact: true}).waitFor();
    await options.getByTestId('glossary-preview').getByLabel('网页网址（可选）', {exact: true}).fill('https://unrelated.example/article');
    await options.getByTestId('glossary-preview').getByTestId('glossary-matches').waitFor({state: 'hidden'});
    await options.getByTestId('glossary-preview').getByLabel('网页网址（可选）', {exact: true}).fill(`${fixture.url}/article`);
    await shot(options, 'glossary-configured');
    report.cases.push('UI create/edit/keep-original/case-sensitive and actual domain match preview');

    await showSection('我的术语库');
    await toolbarAction('导入术语库');
    const dialog = options.getByRole('dialog', {name: '导入术语库'});
    await dialog.getByRole('radio', {name:'粘贴内容',exact:true}).check();
    await dialog.getByRole('textbox', {name:'粘贴内容',exact:true}).fill('source,target,tgt_lng\nunused_private_term,未命中隐私词,zh-CN\nagent,通用智能体,zh-CN');
    await dialog.getByRole('button', {name: '确认导入', exact: true}).click();
    await dialog.waitFor({state: 'hidden'});
    await waitConfig(config => config.glossaryLibraries.length === 2);
    report.cases.push('CSV source,target,tgt_lng import preview and confirmed append');
    await selectLibrary(ui, 0);
    await showSettings();
    const downloadPromise = options.waitForEvent('download');
    await editor.getByRole('button', {name: '导出', exact: true}).click();
    const download = await downloadPromise;
    const exportPath = path.join(artifactsDir, 'technical-glossary.csv');
    await download.saveAs(exportPath);
    const exportedCsv = fs.readFileSync(exportPath, 'utf8');
    assert(exportedCsv.includes('智能体'));
    assert(exportedCsv.includes('src_lng') && exportedCsv.includes('tgt_lng'), '导出必须携带源语言与目标语言');
    await showSection('我的术语库');
    await toolbarAction('导入术语库');
    await dialog.locator('input[type="file"]').setInputFiles(exportPath);
    await dialog.getByRole('button', {name: '确认导入', exact: true}).click();
    await dialog.waitFor({state: 'hidden'});
    const roundTrip = await waitConfig(config => config.glossaryLibraries.length === 3);
    const restoredLibrary = roundTrip.glossaryLibraries[2];
    assert.equal(restoredLibrary.sourceLanguage, 'en');
    assert.equal(restoredLibrary.targetLanguage, 'zh-hans');
    assert.deepEqual(restoredLibrary.entries.map(({source, target, caseSensitive}) => ({source, target, caseSensitive})),
      roundTrip.glossaryLibraries[0].entries.map(({source, target, caseSensitive}) => ({source, target, caseSensitive})));
    report.exportRoundTrip = {sourceLanguage: restoredLibrary.sourceLanguage, targetLanguage: restoredLibrary.targetLanguage,
      entries: restoredLibrary.entries.length, caseSensitiveAndKeepOriginal: true};
    report.cases.push('real CSV download and file re-import retain source/target languages, keep-original and case-sensitive entries');
    await options.reload({waitUntil: 'domcontentloaded'});
    await ui.waitFor();
    const persisted = await readConfig();
    assert.equal(persisted.glossaryLibraries[0].entries[0].target, '智能体');
    report.persistenceCases.push('options reload retains created/imported libraries and enabled state');
    await shot(options, 'glossary-reloaded');

    const article = await createPage(`${fixture.url}/article`, 'article');
    await article.locator('#fluent-read-page-styles').waitFor({state: 'attached'});
    const paragraph = article.locator('#glossary-primary');
    const toggle = async expected => {
      await activateExtensionTabWithoutForeground(context, article, 30000);
      await paragraph.click(); await paragraph.hover();
      await article.keyboard.down('Control');
      await article.keyboard.up('Control');
      await article.waitForFunction(count => document.querySelectorAll('#glossary-primary .fluent-read-bilingual-content').length === count, expected);
      assert.equal(await article.locator('#glossary-neighbor .fluent-read-bilingual-content').count(), 0);
    };
    await toggle(1);
    assert((await paragraph.innerText()).includes('智能体'));
    assert.equal(fixture.requests.at(-1).terms.length, 2);
    assert(fixture.requests.at(-1).terms.every(term => term.source.startsWith('__FRTERM_') && term.source === term.target));
    const countBeforeCache = fixture.requests.length;
    await toggle(0); await toggle(1);
    assert.equal(fixture.requests.length, countBeforeCache, '再次翻译应命中缓存');
    await shot(article, 'glossary-hover-translated');
    await toggle(0);
    const revisedLibraries = persisted.glossaryLibraries.map(library => library.id !== persisted.glossaryLibraries[0].id ? library : ({...library,
      entries: library.entries.map(entry => entry.source === 'agent' ? {...entry, target: '代理智能体'} : entry)}));
    await patchConfig({glossaryLibraries: revisedLibraries});
    await waitConfig(config => config.glossaryLibraries[0].entries[0].target === '代理智能体');
    await article.reload({waitUntil: 'domcontentloaded'});
    await article.locator('#fluent-read-page-styles').waitFor({state: 'attached'});
    await toggle(1);
    assert((await paragraph.innerText()).includes('代理智能体'));
    assert(fixture.requests.length > countBeforeCache, '词库修改后不得命中旧译文');
    assert(fixture.requests.every(request => request.terms.every(term => term.source !== 'unused_private_term')));
    report.cases.push('real Control hover [1,0,1], adjacent paragraph isolation, cache hit, glossary edit invalidation, only matched terms sent');
    await shot(article, 'glossary-new-revision');

    await toggle(0);
    await patchConfig({enableAIMultiSegment: true});
    await article.reload({waitUntil: 'domcontentloaded'});
    await article.locator('#fluent-read-page-styles').waitFor({state: 'attached'});
    const fullToggle = async translated => {
      await activateExtensionTabWithoutForeground(context, article, 30000);
      await article.keyboard.down('Alt'); await article.keyboard.press('t'); await article.keyboard.up('Alt');
      await article.waitForFunction(translated => {
        const primary = document.querySelectorAll('#glossary-primary .fluent-read-bilingual-content').length;
        const neighbor = document.querySelectorAll('#glossary-neighbor .fluent-read-bilingual-content').length;
        return translated ? primary === 1 && neighbor === 1 : document.querySelectorAll('.fluent-read-bilingual-content').length === 0;
      }, translated);
    };
    await fullToggle(true);
    assert((await paragraph.innerText()).includes('代理智能体'));
    await fullToggle(false); await fullToggle(true);
    assert.equal(await article.locator('.fluent-read-bilingual-content .fluent-read-bilingual-content').count(), 0);
    assert.equal(article.url(), `${fixture.url}/article`);
    await shot(article, 'glossary-full-page');
    report.cases.push('real Alt+T full-page translate/restore/retranslate, selected terms and no nested wrappers');

    await patchConfig({documentService: service, documentModel: {[service]: 'glossary-fixture'}});
    const documentPage = await createPage(`${extensionOrigin}/document.html`, 'document');
    await documentPage.locator('input[type="file"]').setInputFiles({name: 'glossary.txt', mimeType: 'text/plain', buffer: Buffer.from('The agent uses FluentRead to understand this document.')});
    const documentSettings = documentPage.getByRole('dialog', {name: '翻译设置', exact: true});
    await documentPage.getByRole('button', {name: '调整文档翻译设置', exact: true}).click();
    await documentSettings.waitFor({state: 'visible'});
    await chooseComboboxOption(documentPage, documentSettings.getByRole('combobox', {name: '术语库使用方式', exact: true}), '不使用术语库');
    await waitConfig(config => Array.isArray(config.documentGlossaryIds) && config.documentGlossaryIds.length === 0);
    const withoutGlossaryRequests = fixture.requests.length;
    await documentSettings.getByRole('button', {name: '开始翻译', exact: true}).click();
    await documentSettings.waitFor({state: 'hidden'});
    await documentPage.locator('.document-status').filter({hasText: /^翻译完成\s*·\s*1\s*\/\s*1$/}).waitFor();
    assert(fixture.requests.length > withoutGlossaryRequests, '文档禁用词库必须实际请求当前文本');
    const literalSource = 'The agent uses FluentRead to understand this document.';
    const brandToken = documentTermToken(literalSource, 0);
    assert.deepEqual(fixture.requests.at(-1).terms, [{source: brandToken, target: brandToken}], '文档自动保护 CamelCase 品牌；禁用词库后不能发送 agent 用户术语');
    assert.equal(fixture.requests.at(-1).source, literalSource.replace('FluentRead', brandToken));
    assert.equal(await documentPage.frameLocator('.rich-preview-frame').locator('.fluentread-translation').innerText(), '测试译文：The 代理人 uses FluentRead to understand this document.', 'agent 使用普通供应商译法，FluentRead 原样回填且无占位符残留');
    report.crossPageSync = 'document selection persisted through shared background store';
    await documentPage.reload({waitUntil: 'domcontentloaded'});
    await documentPage.locator('input[type="file"]').setInputFiles({name: 'glossary.txt', mimeType: 'text/plain', buffer: Buffer.from('The agent uses FluentRead.')});
    await documentPage.getByRole('button', {name: '调整文档翻译设置', exact: true}).click();
    await documentSettings.waitFor({state: 'visible'});
    await documentPage.waitForFunction(() => document.querySelector('.document-settings-dialog[open] [aria-label="术语库使用方式"]')?.closest('.el-select')?.querySelector('.el-select__selected-item:not(.el-select__input-wrapper)')?.textContent?.trim() === '不使用术语库');
    await shot(documentPage, 'glossary-document-persisted');
    report.cases.push('document native glossary selector, explicit user-glossary disable, exact automatic brand token and local literal restore, ordinary agent translation and reload persistence');

    await chooseComboboxOption(documentPage, documentSettings.getByRole('combobox', {name: '术语库使用方式', exact: true}), '指定词库');
    const documentPicker = documentSettings.getByTestId('glossary-library-select');
    await documentPicker.locator('input[type="checkbox"]').nth(1).check();
    await documentPicker.locator('input[type="checkbox"]').nth(0).uncheck();
    await waitConfig(config => config.documentGlossaryIds?.length === 1 && config.documentGlossaryIds[0] === persisted.glossaryLibraries[1].id);
    await documentSettings.getByRole('button', {name: '开始翻译', exact: true}).click();
    await documentSettings.waitFor({state: 'hidden'});
    await documentPage.locator('.document-status').filter({hasText: /^翻译完成\s*·\s*1\s*\/\s*1$/}).waitFor();
    const selectedSource = 'The agent uses FluentRead.';
    const selectedAgentToken = documentTermToken(selectedSource, 0);
    const selectedBrandToken = documentTermToken(selectedSource, 1);
    assert.deepEqual(fixture.requests.at(-1).terms, [
      {source: selectedAgentToken, target: selectedAgentToken},
      {source: selectedBrandToken, target: selectedBrandToken},
    ], '指定词库的 agent 与自动保护的品牌都必须逐个保留');
    assert.equal(fixture.requests.at(-1).source, `The ${selectedAgentToken} uses ${selectedBrandToken}.`);
    assert.equal(await documentPage.frameLocator('.rich-preview-frame').locator('.fluentread-translation').innerText(), '测试译文：The 通用智能体 uses FluentRead.', '只应用选择的通用词库，不复用网站词库译法，品牌仍原样保留');
    await shot(documentPage, 'glossary-document-selected');
    report.cases.push('document selected global library uses imported zh-CN terms instead of website-scoped library');

    await options.reload({waitUntil: 'domcontentloaded'});
    await showSettings();
    const nameInput = options.getByTestId('glossary-settings').getByRole('region', {name: '词库设置'}).getByLabel('词库名称', {exact: true});
    await activateExtensionTabWithoutForeground(context, options, 30000);
    currentPage = options;
    await nameInput.evaluate(input => {
      window.__glossaryNameTrace = [];
      for (const type of ['input', 'change', 'blur']) input.addEventListener(type, () => {
        window.__glossaryNameTrace.push({type, value: input.value});
      });
    });
    try {
      for (let round = 1; round <= 3; round++) {
        await nameInput.fill(`技术词库第一次 ${round}`); await nameInput.press('Tab');
        await nameInput.fill('技术词库最终'); await nameInput.press('Tab');
        await waitConfig(config => config.glossaryLibraries[0].name === '技术词库最终');
      }
    } finally {
      report.nameEditTrace = await options.evaluate(() => window.__glossaryNameTrace);
      report.nameEditSnapshot = {inputValue: await nameInput.inputValue(), persistedName: (await readConfig()).glossaryLibraries[0]?.name};
    }
    report.latestWriteWins = {rounds: 3, final: '技术词库最终', persisted: true};
    await nameInput.fill('关闭后仍保存'); await nameInput.press('Tab');
    await options.close();
    options = await createPage(`${extensionOrigin}/options.html#settings-glossary`, 'options-reopened');
    await waitConfig(config => config.glossaryLibraries[0].name === '关闭后仍保存');
    report.quickClose = {value: '关闭后仍保存', immediatelyClosedAfterChange: true, reopenedValueMatches: true};
    await shot(options, 'glossary-quick-close-reopened');
    const finalUi = options.getByTestId('glossary-settings');
    const finalSection = name => showPanel(finalUi, name);
    await finalUi.getByRole('button', {name: '添加词条', exact: true}).click();
    const draftForm = finalUi.locator('.glossary-entry-form');
    await draftForm.getByLabel('原词', {exact: true}).fill('draft-example');
    await draftForm.getByLabel('译词', {exact: true}).fill('未保存的草稿');
    await selectLibrary(finalUi, 1);
    assert.equal(await finalUi.locator('.glossary-entry-form').count(), 0);
    await selectLibrary(finalUi, 0);
    assert.equal(await draftForm.getByLabel('译词', {exact: true}).inputValue(), '未保存的草稿');
    await draftForm.getByLabel('原词', {exact: true}).fill('AGENT');
    assert(await draftForm.getByRole('button', {name: '保存', exact: true}).isDisabled());
    await draftForm.getByRole('button', {name: '编辑已有词条', exact: true}).waitFor();
    await shot(options, 'glossary-duplicate-draft');
    await draftForm.getByRole('button', {name: '取消', exact: true}).click();
    await finalSection('匹配预览');
    await options.getByTestId('glossary-preview').getByLabel('输入一段原文', {exact: true}).fill('The agent uses FluentRead.');
    assert.equal(await options.getByTestId('glossary-preview').getByRole('combobox', {name: '源语言', exact: true}).evaluate(input => input.closest('.el-select').querySelector('.el-select__selected-item:not(.el-select__input-wrapper)').textContent.trim()), '自动检测');
    await options.getByTestId('glossary-preview').locator('.glossary-diagnostic-details summary').click();
    await options.getByTestId('glossary-preview').locator('.glossary-diagnostics').getByText('网址未填写或不在适用范围', {exact: true}).first().waitFor();
    await options.getByTestId('glossary-preview').getByLabel('网页网址（可选）', {exact: true}).fill(`${fixture.url}/article`);
    await options.getByTestId('glossary-preview').getByTestId('glossary-matches').waitFor();
    await options.getByTestId('glossary-preview').getByText('存在多个译法', {exact: true}).waitFor();
    await shot(options, 'glossary-preview-diagnostics');
    await finalSection('我的术语库');
    await patchConfig({service: 'microsoft'});
    assert.equal(await finalUi.locator('.glossary-service-notice').count(), 0);
    await shot(options, 'glossary-machine-ready');
    await patchConfig({service});
    report.cases.push('preserved drafts across library selection, blocked duplicate entry, explained website exclusions and conflicts; machine services have no unsupported notice');
    report.layouts = [];
    for (const width of [1440, 1024, 820, 390]) {
      await options.setViewportSize({width, height: 960});
      await finalSection('我的术语库');
      const layout = await finalUi.evaluate(element => ({width: innerWidth, documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, glossaryOverflow: element.scrollWidth - element.clientWidth}));
      assert(layout.documentOverflow <= 1 && layout.glossaryOverflow <= 1, JSON.stringify(layout));
      if (width === 390) {
        await selectLibrary(finalUi, 1); await selectLibrary(finalUi, 0);
        assert((await finalUi.locator('.glossary-editor').boundingBox()).y < 720, '窄屏应直接显示词条编辑区');
      }
      report.layouts.push(layout);
      await shot(options, `glossary-light-${width}`);
    }
    await options.setViewportSize({width: 1440, height: 960});
    await patchConfig({theme: 'dark'});
    await options.reload({waitUntil: 'domcontentloaded'});
    await options.getByTestId('glossary-settings').waitFor();
    await shot(options, 'glossary-dark');
    await options.setViewportSize({width: 390, height: 850});
    await options.getByTestId('glossary-settings').waitFor();
    assert(await options.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    await shot(options, 'glossary-narrow');
    await showPanel(options.getByTestId('glossary-settings'), '内置词库');
    await shot(options, 'builtin-catalog-narrow-dark');
    await options.getByRole('button', {name: '预览 AI 与机器学习', exact: true}).click();
    const narrowPreview = options.getByTestId('builtin-glossary-preview');
    await narrowPreview.getByLabel('搜索原词或译词', {exact: true}).fill('does-not-exist-in-this-catalog');
    await narrowPreview.getByText('没有匹配的词条', {exact: true}).waitFor();
    await narrowPreview.getByLabel('搜索原词或译词', {exact: true}).fill('上下文');
    assert.equal(await narrowPreview.locator('tbody tr').count(), 3);
    assert(await options.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    await shot(options, 'builtin-preview-narrow-dark');
    await narrowPreview.getByRole('button', {name: '关闭', exact: true}).click();
    await patchConfig({uiLanguage: 'en-US'});
    const englishUi = options.getByTestId('glossary-settings');
    await englishUi.locator('.glossary-main-toolbar').getByRole('button', {name: 'New glossary', exact: true}).waitFor();
    assert(await options.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    await shot(options, 'glossary-english-narrow-dark');
    report.cases.push('latest-write-wins, immediate-close persistence, dark theme and 390px no horizontal overflow');
    await patchConfig({uiLanguage: 'zh-CN', theme: 'light', glossaryLibraries: [{
      id: 'showcase', name: '常用术语', enabled: true, sourceLanguage: '', targetLanguage: 'zh-hans', domains: [],
      entries: [{id: 'llm', source: 'large language model', target: '大语言模型', caseSensitive: false},
        {id: 'brand', source: 'FluentRead', target: '', caseSensitive: true}],
    }]});
    await options.setViewportSize({width: 1440, height: 960});
    await options.reload({waitUntil: 'domcontentloaded'});
    await options.getByTestId('glossary-settings').getByRole('cell', {name: '大语言模型', exact: true}).waitFor();
    assert((await options.locator('.glossary-scope-summary').innerText()).includes('所有网站'));
    assert.equal(await options.getByRole('dialog', {name: '匹配预览', exact: true}).isVisible(), false);
    await shot(options, 'glossary-overview');
    report.requests = fixture.requests;
    assert.deepEqual(report.consoleErrors, []);
    report.ok = true;
  } catch (error) {
    primaryError = error;
    report.error = error.stack || String(error);
    if (currentPage && !currentPage.isClosed()) {
      await currentPage.screenshot({path: path.join(artifactsDir, 'failure.png')}).catch(() => {});
      report.visibleText = await currentPage.locator('body').innerText().catch(() => '');
    }
    throw error;
  } finally {
    const cleanupErrors = [];
    const cleanup = async action => {
      try {await action();} catch (error) {cleanupErrors.push(error);}
    };
    let browserClosed = false;
    await cleanup(async () => {
      if (launched) {await launched.close(); browserClosed = true;}
    });
    await cleanup(async () => {await fixture?.close();});
    await cleanup(() => {
      if (browserClosed) fs.rmSync(profileDir, {recursive: true, force: true, maxRetries: 8, retryDelay: 250});
      else if (!launchAttempted) {
        // No browser launch was attempted; only remove an empty initial profile.
        try {fs.rmdirSync(profileDir);} catch (error) {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
        }
      }
    });
    if (cleanupErrors.length) {
      report.ok = false;
      report.cleanupErrors = cleanupErrors.map(error => error.stack || String(error));
    }
    await cleanup(() => {fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));});
    for (const error of cleanupErrors) process.stderr.write(`Cleanup failed: ${error.stack || error}\n`);
    if (cleanupErrors.length && !primaryError) throw cleanupErrors[0];
    process.stdout.write(`${JSON.stringify({ok: report.ok, cases: report.cases, error: report.error, artifactsDir})}\n`);
  }
}

if (require.main === module) main().catch(error => {process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1;});
module.exports = {startFixture};
