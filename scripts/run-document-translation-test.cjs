#!/usr/bin/env node
'use strict';

// 文档产品流程回归：临时 profile、生产扩展、真实 UI 输入和下载，网络仅连接本机确定性服务。
// 覆盖所有支持格式、暂停续译、失败恢复、完整校订、设置变化、离开保护及响应式外观。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };

async function fixtureServer() {
  const state = {requests: [], delay: 5, fail: false};
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const prompt = body.messages.filter(message => message.role === 'user').map(message => message.content).join('\n');
      const source = /SOURCE_BEGIN([\s\S]*?)SOURCE_END/u.exec(prompt)?.[1];
      assert.equal(typeof source, 'string');
      state.requests.push(source);
      await new Promise(resolve => setTimeout(resolve, state.delay));
      if (state.fail && source.includes('Failure target')) { res.writeHead(400); res.end(JSON.stringify({error: {message: 'Fixture intentional failure'}})); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({id: 'document-fixture', object: 'chat.completion', created: 1, model: 'document-fixture',
        choices: [{index: 0, message: {role: 'assistant', content: `测试译文：${source}`}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 10, completion_tokens: 10, total_tokens: 20}}));
    } catch (error) { res.writeHead(400); res.end(JSON.stringify({error: {message: error.message}})); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {...state, state, url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, close: () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); }};
}

async function main() {
  const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
  const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-document-experience'));
  const exampleDir = path.resolve(arg('example-dir', 'examples/document-translation'));
  const packages = arg('playwright-root');
  const helperPath = arg('focus-safe-helper');
  assert(packages && helperPath, '需要 Playwright 和 focus-safe helper');
  const requireRuntime = createRequire(path.join(packages, 'document-runner.cjs'));
  const {chromium} = requireRuntime('playwright');
  const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(helperPath);
  fs.mkdirSync(artifactsDir, {recursive: true});
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-document-flow-'));
  const report = {ok: false, extensionDir, artifactsDir, service: 'loopback deterministic fixture', cases: [], screenshots: [], downloads: [], consoleErrors: [], exampleLoads: {}};
  const fixture = await fixtureServer();
  let launched, page;
  try {
    launched = await launchFocusSafePersistentContext({chromium, profileDir,
      browserPath: arg('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      background: true, headless: false, viewport: {width: 1440, height: 960}, timeout: 30000,
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    const context = launched.context;
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 30000});
    const origin = /^chrome-extension:\/\/[^/]+/u.exec(worker.url())[0];
    page = await newPageWithoutForeground(context, 30000);
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => report.consoleErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    await page.goto(`${origin}/document.html`, {waitUntil: 'domcontentloaded'});
    await page.locator('.file-drop-zone').waitFor();
    const service = 'custom:document-fixture';
    const seeded = await page.evaluate(async ({service, endpoint}) => {
      const stored = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      if (!stored.success) throw new Error(stored.error);
      const current = typeof stored.value === 'string' ? JSON.parse(stored.value) : stored.value;
      return chrome.runtime.sendMessage({type: 'persistConfig', mode: 'replace', baseRevision: current.__fluentConfigRevision,
        clientId: `document-fixture-${crypto.randomUUID()}`, sequence: 1, config: {...current,
          uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, from: 'en', to: 'zh-Hans', documentService: service,
          documentModel: {...current.documentModel, [service]: 'document-fixture'},
          customOpenAIProviders: [{id: service, name: '本机测试翻译', endpoint, models: ['document-fixture']}],
          requireApiKey: {[`v2:${JSON.stringify([service, 'document-fixture'])}`]: false},
          user_role: {...current.user_role, [service]: 'SOURCE_BEGIN{{origin}}SOURCE_END'},
          enableAIContext: false, enableAIMultiSegment: false,
        }});
    }, {service, endpoint: fixture.url});
    assert.equal(seeded.success, true, seeded.error);
    const shot = async name => { const file = path.join(artifactsDir, `${name}.png`); await page.screenshot({path: file, animations: 'disabled'}); report.screenshots.push(file); };
    const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '页面不得横向溢出');
    const status = label => page.locator('.document-status').filter({hasText: label}).waitFor();
    const load = async (name, buffer) => {
      await page.locator('input[type=file]').setInputFiles({name, mimeType: 'application/octet-stream', buffer});
      await page.locator('.workspace-heading h1').filter({hasText: name}).waitFor();
      if (await page.locator('.rich-preview-frame').count()) {
        const frame = await (await page.locator('.rich-preview-frame').elementHandle()).contentFrame();
        await frame.waitForFunction(() => Boolean(document.body?.innerText.trim()));
      }
    };
    const newFile = async () => {
      await page.getByRole('button', {name: '打开新文件', exact: true}).first().click();
      const dialog = page.locator('dialog[open]').filter({hasText: '打开另一份文档'});
      if (await dialog.count()) await dialog.getByRole('button', {name: '打开新文件', exact: true}).click();
      await page.locator('.file-drop-zone').waitFor();
    };
    const download = async (mode = 'bilingual', partial = false) => {
      await page.getByRole('button', {name: '下载文件 ↓', exact: true}).click();
      const dialog = page.locator('dialog[open]').filter({hasText: '下载翻译结果'});
      await dialog.locator('.export-options button').nth(mode === 'bilingual' ? 0 : 1).click();
      if (partial) {
        assert.equal(await dialog.getByRole('button', {name: '下载双语文件', exact: true}).isDisabled(), true);
        await dialog.getByRole('checkbox').check();
      }
      const [file] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', {name: mode === 'bilingual' ? '下载双语文件' : '下载译文文件', exact: true}).click()]);
      const dest = path.join(artifactsDir, file.suggestedFilename()); await file.saveAs(dest); report.downloads.push(dest); return dest;
    };
    assert.equal(await page.locator('.format-card').count(), 8);
    await shot('01-import-desktop'); await noOverflow();
    await page.setViewportSize({width: 390, height: 844}); await noOverflow(); await shot('02-import-mobile');
    await page.setViewportSize({width: 1440, height: 960});
    await page.locator('input[type=file]').setInputFiles({name: 'unsupported.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('not a document')});
    await page.locator('.notice.error').waitFor();
    assert.match(await page.locator('.notice.error').innerText(), /不支持/);
    report.cases.push('unsupported import has persistent actionable error');

    for (const name of ['sample.pdf', 'sample.epub', 'sample.docx', 'sample.html', 'sample.txt', 'sample.md', 'sample.srt', 'sample.vtt', 'sample.ass', 'sample.ssa', 'sample.lrc', 'sample.json']) {
      await load(name, fs.readFileSync(path.join(exampleDir, name)));
      await page.getByRole('button', {name: '开始翻译', exact: true}).click();
      await status('翻译完成');
      assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), '100');
      await page.getByRole('button', {name: '校订译文', exact: true}).click();
      assert.match(await page.locator('textarea.document-translation').first().inputValue(), /测试译文/);
      await page.locator('textarea.document-translation').first().fill(`人工校订：${name}`);
      await page.getByRole('button', {name: '阅读', exact: true}).click();
      await noOverflow();
      if (name === 'sample.pdf') {
        await page.locator('.pdf-page-column.translated img').last().waitFor();
        assert.equal(await page.locator('.pdf-page-row').count(), 2);
        const previewImage = page.locator('.pdf-page-column.translated img').first();
        const beforeZoom = (await previewImage.boundingBox()).width;
        await page.getByRole('combobox', {name: 'PDF 预览缩放'}).selectOption('1.5');
        assert((await previewImage.boundingBox()).width > beforeZoom * 1.4, 'PDF 放大必须实际改变页面尺寸');
        await page.getByRole('combobox', {name: 'PDF 预览缩放'}).selectOption('1');
      }
      const dest = await download();
      const bytes = fs.readFileSync(dest);
      assert(bytes.length > 0);
      if (name === 'sample.pdf') {
        const {PDFDocument} = require('pdf-lib'); const pdf = await PDFDocument.load(bytes);
        assert.equal(pdf.getPageCount(), 2); assert(pdf.getPage(0).getSize().width > pdf.getPage(0).getSize().height);
      } else if (name.endsWith('.epub') || name.endsWith('.docx')) {
        const zip = await require('jszip').loadAsync(bytes);
        assert(zip.file(name.endsWith('.epub') ? 'OEBPS/chapter-1.xhtml' : 'word/document.xml'));
      } else assert(bytes.toString().includes('人工校订'));
      report.exampleLoads[name] = {translated: true, edited: true, exported: true, bytes: bytes.length};
      if (['sample.pdf', 'sample.epub', 'sample.docx', 'sample.md', 'sample.srt', 'sample.json'].includes(name)) await shot(`reader-${name.replace('.', '-')}`);
      await newFile();
    }
    report.cases.push('12 formats parse, translate through provider, edit via UI and export original format');

    fixture.state.delay = 650;
    const longText = Array.from({length: 95}, (_, i) => `Long document paragraph ${i + 1}. This is a complete sentence for testing translation and proofreading.`).join('\n\n');
    await load('long-document.txt', Buffer.from(longText));
    await shot('03-ready-to-translate');
    await page.getByRole('button', {name: '开始翻译', exact: true}).click();
    await page.waitForFunction(() => Number(document.querySelector('[role=progressbar]').getAttribute('aria-valuenow')) > 0);
    await page.getByRole('button', {name: '暂停翻译', exact: true}).click();
    await status('已暂停');
    const pausedProgress = await page.getByRole('progressbar').getAttribute('aria-valuenow');
    await page.getByRole('button', {name: '校订译文', exact: true}).click();
    await page.getByRole('combobox', {name: '校订页码'}).selectOption('3');
    assert.equal(await page.locator('[data-segment-id="94"]').count(), 1);
    await page.getByRole('searchbox', {name: '搜索原文、译文或位置'}).fill('paragraph 91.');
    assert.equal(await page.locator('.segment-edit-row').count(), 1);
    await page.getByRole('checkbox', {name: '只看未翻译'}).check();
    await page.getByRole('textbox', {name: '第 91 段译文', exact: true}).fill('第 91 段人工校订结果');
    assert.equal(await page.getByRole('textbox', {name: '第 91 段译文', exact: true}).count(), 1, '输入中不得因为未翻译筛选而卸载编辑框');
    await page.getByRole('checkbox', {name: '只看未翻译'}).uncheck();
    await page.getByRole('searchbox').fill('');
    await shot('04-paused-proofreading');
    const partial = await download('bilingual', true);
    assert(fs.readFileSync(partial, 'utf8').includes('第 91 段人工校订结果'));
    assert(fs.readFileSync(partial, 'utf8').includes('Long document paragraph 95.'));
    assert(Number(pausedProgress) < 100);
    report.cases.push('pause retains partial result, page 3 reaches segment 95, search edits segment 91, partial export requires acknowledgement');
    fixture.state.delay = 15;
    await page.getByRole('button', {name: '继续翻译', exact: true}).click();
    await status('翻译完成');
    await page.getByRole('searchbox').fill('第 91 段人工校订结果');
    assert.equal(await page.getByRole('textbox', {name: '第 91 段译文', exact: true}).inputValue(), '第 91 段人工校订结果');
    assert(!fixture.state.requests.some(source => source.startsWith('Long document paragraph 91.')));
    report.cases.push('resume does not translate or overwrite manual completed segments');
    const reloadAttempt = page.reload({timeout: 5000}).catch(() => undefined);
    const unloadDialog = await page.waitForEvent('dialog');
    assert.equal(unloadDialog.type(), 'beforeunload');
    await unloadDialog.dismiss(); await reloadAttempt;
    assert.match(await page.locator('.workspace-heading h1').innerText(), /long-document/);
    report.cases.push('browser reload prompts beforeunload and cancellation retains unsaved document');
    await page.getByRole('button', {name: '阅读', exact: true}).click();
    await page.getByRole('button', {name: '原文', exact: true}).click();
    await page.getByRole('button', {name: '下载文件 ↓', exact: true}).click();
    assert.equal(await page.locator('dialog[open] .export-options button').first().getAttribute('aria-pressed'), 'true');
    await page.locator('dialog[open]').getByRole('button', {name: '返回文档'}).click();
    await page.getByRole('button', {name: '双语', exact: true}).click();
    await page.getByRole('button', {name: '打开新文件', exact: true}).click();
    await page.locator('dialog[open]').getByRole('button', {name: '返回文档'}).click();
    assert.match(await page.locator('.workspace-heading h1').innerText(), /long-document/);
    await page.getByRole('combobox', {name: '文档目标语言'}).selectOption('ja');
    await page.locator('.notice.warning').filter({hasText: '设置已更改'}).waitFor();
    await page.getByRole('button', {name: '按新设置翻译'}).click();
    await page.locator('dialog[open]').getByRole('button', {name: '返回文档'}).click();
    await page.getByRole('combobox', {name: '文档目标语言'}).selectOption('zh-Hans');
    report.cases.push('reading and download modes independent; discard/restart dialogs cancel safely; setting change cannot mix translation sessions');
    await page.emulateMedia({colorScheme: 'dark'});
    const richRoot = page.locator('.rich-preview-frame').contentFrame().locator('html');
    await richRoot.waitFor();
    assert.equal(await richRoot.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(32, 38, 50)', '深色阅读区不应保留刺眼的白底');
    await shot('05-reader-dark');
    await page.getByRole('button', {name: '校订译文', exact: true}).click();
    assert.equal(await page.getByRole('searchbox').inputValue(), '第 91 段人工校订结果', '阅读与校订切换应保留查询');
    await page.setViewportSize({width: 390, height: 844}); await noOverflow(); await shot('06-proofreading-mobile-dark');
    await page.emulateMedia({colorScheme: 'light'}); await shot('07-proofreading-mobile-light');
    await page.setViewportSize({width: 820, height: 960}); await noOverflow();
    await page.setViewportSize({width: 1440, height: 960});
    await newFile();
    fixture.state.fail = true;
    await load('failure.txt', Buffer.from('A successful first paragraph.\n\nAnother successful paragraph.\n\nFailure target paragraph.'));
    await page.getByRole('button', {name: '开始翻译', exact: true}).click();
    await status('翻译中断');
    assert(Number(await page.getByRole('progressbar').getAttribute('aria-valuenow')) < 100);
    await shot('08-interrupted');
    fixture.state.fail = false;
    await page.locator('.translation-actions button').click();
    await status('翻译完成');
    await page.getByRole('combobox', {name: '文档目标语言'}).selectOption('ja');
    await page.getByRole('button', {name: '按新设置翻译', exact: true}).click();
    const restartDialog = page.locator('dialog[open]');
    fixture.state.delay = 1000;
    await restartDialog.getByRole('button', {name: '重新翻译', exact: true}).click();
    await status('正在翻译');
    await newFile();
    await load('replacement.txt', Buffer.from('A replacement document with independent text.'));
    await page.getByRole('button', {name: '校订译文', exact: true}).click();
    assert.equal(await page.locator('textarea.document-translation').first().inputValue(), '');
    fixture.state.delay = 5;
    await page.getByRole('button', {name: '开始翻译', exact: true}).click();
    await status('翻译完成');
    assert.match(await page.locator('textarea.document-translation').first().inputValue(), /replacement document/);
    report.cases.push('confirmed restart then replace aborts previous task; late results cannot contaminate new document');
    const recovery = await download('translated');
    assert(fs.readFileSync(recovery, 'utf8').includes('测试译文：A replacement document'));
    report.cases.push('failure keeps completed work, error stays visible, retry succeeds, translated-only export works');
    assert.equal(report.consoleErrors.filter(message => !/Fixture intentional failure|400 \(Bad Request\)/u.test(message)).length, 0);
    report.expectedFixtureErrors = report.consoleErrors.filter(message => /Fixture intentional failure|400 \(Bad Request\)/u.test(message));
    report.consoleErrors = report.consoleErrors.filter(message => !/Fixture intentional failure|400 \(Bad Request\)/u.test(message));
    report.ok = true;
  } catch (error) {
    report.failure = error.stack || String(error);
    if (page) await page.screenshot({path: path.join(artifactsDir, 'failure.png')}).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
    if (launched) await launched.close().catch(() => {});
    await fixture.close(); fs.rmSync(profileDir, {recursive: true, force: true});
    console.log(JSON.stringify({ok: report.ok, cases: report.cases, report: path.join(artifactsDir, 'report.json'), failure: report.failure}, null, 2));
  }
}
main().catch(error => {console.error(error.stack || String(error)); process.exitCode = 1;});
