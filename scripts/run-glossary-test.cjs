#!/usr/bin/env node
'use strict';

// 术语库生产端到端回归：独立临时 Edge、真实配置消息与页面手势、仅 loopback AI fixture。
// 不读取日常浏览器配置、不使用真实密钥、不以模拟译文证明任何外部模型的遵守率。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
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
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {url: `http://127.0.0.1:${server.address().port}`, requests,
    close: () => new Promise(resolve => server.close(resolve))};
}

async function main() {
  const extensionDir = path.resolve(argument('extension-dir', '.output/chrome-mv3'));
  const packages = argument('playwright-root');
  const helperPath = argument('focus-safe-helper');
  assert(packages && helperPath, '必须传入 Playwright 包目录和 focus-safe helper');
  assert(fs.existsSync(path.join(extensionDir, 'manifest.json')), '缺少扩展构建产物');
  const {chromium} = require(path.join(packages, 'playwright'));
  const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground} = require(helperPath);
  const artifactsDir = path.resolve(argument('artifacts-dir', '/private/tmp/fluentread-glossary-browser'));
  fs.mkdirSync(artifactsDir, {recursive: true});
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-glossary-edge-'));
  const report = {ok: false, extensionDir, artifactsDir, profileDir, service: 'loopback-openai-fixture',
    scope: 'production built-in glossary catalog/preview/adoption/removal, real matched-term requests, persistence, lossless language import/export, hover/full-page toggles, document selection, cache invalidation and responsive themes',
    cases: [], consoleErrors: [], screenshots: [], persistenceCases: [], quickClose: null, crossPageSync: null, latestWriteWins: null};
  const fixture = await startFixture();
  let launched;
  let currentPage;
  try {
    launched = await launchFocusSafePersistentContext({chromium, profileDir,
      browserPath: argument('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      background: true, headless: false, viewport: {width: 1440, height: 960}, timeout: 30000,
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
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
      throw new Error('配置未达到预期持久化状态');
    };
    const shot = async (page, name) => {
      const file = path.join(artifactsDir, `${name}.png`);
      await page.screenshot({path: file, animations: 'disabled'}); report.screenshots.push(file);
    };
    const service = 'custom:glossary-fixture';
    await patchConfig({uiLanguage: 'zh-CN', on: true, service, from: 'en', to: 'zh-Hans', display: 1,
      customOpenAIProviders: [{id: service, name: '术语库测试服务', endpoint: `${fixture.url}/v1/chat/completions`, models: ['glossary-fixture']}],
      token: {[service]: 'synthetic-local-fixture-not-a-secret'}, model: {[service]: 'glossary-fixture'},
      user_role: {[service]: 'SOURCE_BEGIN{{origin}}SOURCE_END'}, enableAIContext: false, enableAIMultiSegment: false,
      hotkey: 'Control', mouseHoverTranslationDelay: 0, disableSelectionTranslator: true});
    const ui = options.getByTestId('glossary-settings');
    await ui.waitFor({state: 'visible'});
    await shot(options, 'glossary-empty');
    assert.equal(await ui.getByTestId('builtin-glossaries').locator('article').count(), 5);
    await ui.getByRole('button', {name: '预览 AI 与机器学习', exact: true}).click();
    const builtinPreview = options.getByTestId('builtin-glossary-preview');
    await builtinPreview.getByLabel('搜索原词或译词', {exact: true}).fill('context window');
    await builtinPreview.getByRole('cell', {name: '上下文窗口', exact: true}).waitFor();
    assert.equal(await builtinPreview.locator('tbody tr').count(), 1);
    await shot(options, 'builtin-preview-search');
    await builtinPreview.getByRole('button', {name: '添加词库', exact: true}).click();
    let builtinState = await waitConfig(config => config.glossaryLibraries.length === 1);
    assert.equal(builtinState.glossaryLibraries[0].entries.length, 60);
    assert.deepEqual(builtinState.glossaryLibraries[0].preset, {id: 'ai-en-zh-hans', version: 1});
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
    assert.deepEqual(fixture.requests.at(-1).terms, [{source: 'large language model', target: '大语言模型'}, {source: 'context window', target: '上下文窗口'}]);
    await shot(builtinPage, 'builtin-actual-translation');
    await toggleBuiltin(0);
    await activateExtensionTabWithoutForeground(context, options, 30000);
    await ui.getByRole('switch', {name: '启用术语库'}).uncheck();
    await waitConfig(config => !config.glossaryEnabled);
    await toggleBuiltin(1);
    assert.deepEqual(fixture.requests.at(-1).terms, [], '总开关关闭后不得复用内置词库请求');
    await builtinPage.close();
    await options.reload({waitUntil: 'domcontentloaded'}); await ui.waitFor();
    builtinState = await readConfig();
    assert.deepEqual(builtinState.glossaryLibraries[0].preset, {id: 'ai-en-zh-hans', version: 1});
    const deleteBuiltin = async () => {
      await ui.getByRole('button', {name: '删除词库', exact: true}).click();
      await options.locator('.el-message-box').getByRole('button', {name: '删除', exact: true}).click();
      await waitConfig(config => config.glossaryLibraries.length === 0);
    };
    await deleteBuiltin();
    await ui.getByRole('button', {name: '添加 AI 与机器学习', exact: true}).click();
    await waitConfig(config => config.glossaryLibraries[0]?.entries.length === 60);
    await deleteBuiltin();
    report.cases.push('five offline catalogs, searchable real preview, editable-copy adoption, source version persistence, deletion and re-addition; live pipeline sends only two matched terms and none when disabled');
    await ui.getByRole('button', {name: '新建术语库', exact: true}).click();
    const editor = ui.getByRole('region', {name: '词库设置'});
    await editor.getByLabel('词库名称', {exact: true}).fill('技术词库');
    await editor.getByLabel('词库名称', {exact: true}).press('Tab');
    await waitConfig(config => config.glossaryLibraries[0]?.name === '技术词库');
    const addTerm = async (source, target, caseSensitive = false) => {
      await ui.getByRole('button', {name: '添加词条', exact: true}).click();
      const form = ui.locator('.glossary-entry-form');
      await form.getByLabel('原词', {exact: true}).fill(source);
      await form.getByLabel('译词', {exact: true}).fill(target);
      if (caseSensitive) await form.getByLabel('区分大小写').check();
      await form.getByRole('button', {name: '保存', exact: true}).click();
      await form.waitFor({state: 'hidden'});
    };
    await addTerm('agent', '智能体');
    await addTerm('FluentRead', '', true);
    await editor.getByLabel('源语言', {exact: true}).selectOption('en');
    await waitConfig(config => config.glossaryLibraries[0].sourceLanguage === 'en');
    await editor.getByLabel('目标语言', {exact: true}).selectOption('zh-hans');
    await waitConfig(config => config.glossaryLibraries[0].targetLanguage === 'zh-hans');
    await editor.getByLabel('适用网站', {exact: true}).fill('127.0.0.1');
    await editor.getByLabel('适用网站', {exact: true}).press('Tab');
    await waitConfig(config => config.glossaryLibraries[0].domains[0] === '127.0.0.1');
    await ui.getByRole('switch', {name: '启用术语库'}).check();
    await waitConfig(config => config.glossaryEnabled);
    await ui.getByLabel('输入一段原文', {exact: true}).fill('The agent uses FluentRead.');
    await ui.getByLabel('网页网址（可选）', {exact: true}).fill(`${fixture.url}/article`);
    await ui.getByTestId('glossary-matches').getByText('agent → 智能体', {exact: true}).waitFor();
    await ui.getByLabel('网页网址（可选）', {exact: true}).fill('https://unrelated.example/article');
    await ui.getByTestId('glossary-matches').waitFor({state: 'hidden'});
    await ui.getByLabel('网页网址（可选）', {exact: true}).fill(`${fixture.url}/article`);
    await shot(options, 'glossary-configured');
    report.cases.push('UI create/edit/keep-original/case-sensitive and actual domain match preview');

    await ui.getByRole('button', {name: '导入术语库', exact: true}).click();
    const dialog = options.getByRole('dialog', {name: '导入术语库'});
    await dialog.getByLabel('或粘贴文件内容').fill('source,target,tgt_lng\nunused_private_term,未命中隐私词,zh-CN\nagent,通用智能体,zh-CN');
    await dialog.getByRole('button', {name: '确认导入', exact: true}).click();
    await dialog.waitFor({state: 'hidden'});
    await waitConfig(config => config.glossaryLibraries.length === 2);
    report.cases.push('CSV source,target,tgt_lng import preview and confirmed append');
    await ui.locator('.glossary-library-name').filter({hasText: '技术词库'}).click();
    const downloadPromise = options.waitForEvent('download');
    await editor.getByRole('button', {name: '导出', exact: true}).click();
    const download = await downloadPromise;
    const exportPath = path.join(artifactsDir, 'technical-glossary.csv');
    await download.saveAs(exportPath);
    const exportedCsv = fs.readFileSync(exportPath, 'utf8');
    assert(exportedCsv.includes('智能体'));
    assert(exportedCsv.includes('src_lng') && exportedCsv.includes('tgt_lng'), '导出必须携带源语言与目标语言');
    await ui.getByRole('button', {name: '导入术语库', exact: true}).click();
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
    assert.deepEqual(fixture.requests.at(-1).terms.map(term => term.source).sort(), ['FluentRead', 'agent']);
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
    await documentPage.getByLabel('术语库使用方式').selectOption('none');
    await waitConfig(config => Array.isArray(config.documentGlossaryIds) && config.documentGlossaryIds.length === 0);
    await documentPage.getByRole('button', {name: '开始翻译', exact: true}).click();
    await documentPage.getByText('翻译完成，可以编辑译文后下载', {exact: true}).waitFor();
    assert.deepEqual(fixture.requests.at(-1).terms, []);
    report.crossPageSync = 'document selection persisted through shared background store';
    await documentPage.reload({waitUntil: 'domcontentloaded'});
    await documentPage.locator('input[type="file"]').setInputFiles({name: 'glossary.txt', mimeType: 'text/plain', buffer: Buffer.from('The agent uses FluentRead.')});
    assert.equal(await documentPage.getByLabel('术语库使用方式').inputValue(), 'none');
    await shot(documentPage, 'glossary-document-persisted');
    report.cases.push('document native glossary selector, explicit disable, actual provider request and reload persistence');

    await documentPage.getByLabel('术语库使用方式').selectOption('selected');
    const documentPicker = documentPage.getByTestId('glossary-library-select');
    await documentPicker.locator('input[type="checkbox"]').nth(1).check();
    await documentPicker.locator('input[type="checkbox"]').nth(0).uncheck();
    await waitConfig(config => config.documentGlossaryIds?.length === 1 && config.documentGlossaryIds[0] === persisted.glossaryLibraries[1].id);
    await documentPage.getByRole('button', {name: '开始翻译', exact: true}).click();
    await documentPage.getByText('翻译完成，可以编辑译文后下载', {exact: true}).waitFor();
    assert.deepEqual(fixture.requests.at(-1).terms, [{source: 'agent', target: '通用智能体'}]);
    await shot(documentPage, 'glossary-document-selected');
    report.cases.push('document selected global library uses imported zh-CN terms instead of website-scoped library');

    await options.reload({waitUntil: 'domcontentloaded'});
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
    await patchConfig({theme: 'dark'});
    await options.reload({waitUntil: 'domcontentloaded'});
    await options.getByTestId('glossary-settings').waitFor();
    await shot(options, 'glossary-dark');
    await options.setViewportSize({width: 390, height: 850});
    await options.getByTestId('glossary-settings').waitFor();
    assert(await options.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    await shot(options, 'glossary-narrow');
    await options.getByTestId('builtin-glossaries').locator('summary').click();
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
    report.cases.push('latest-write-wins, immediate-close persistence, dark theme and 390px no horizontal overflow');
    report.requests = fixture.requests;
    assert.deepEqual(report.consoleErrors, []);
    report.ok = true;
  } catch (error) {
    report.error = error.stack || String(error);
    if (currentPage && !currentPage.isClosed()) {
      await currentPage.screenshot({path: path.join(artifactsDir, 'failure.png')}).catch(() => {});
      report.visibleText = await currentPage.locator('body').innerText().catch(() => '');
    }
    throw error;
  } finally {
    fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
    await launched?.close();
    await fixture.close();
    fs.rmSync(profileDir, {recursive: true, force: true});
    process.stdout.write(`${JSON.stringify({ok: report.ok, cases: report.cases, error: report.error, artifactsDir})}\n`);
  }
}

if (require.main === module) main().catch(error => {process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1;});
module.exports = {startFixture};
