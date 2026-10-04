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
  const suite = arg('suite', 'full');
  assert(['full', 'formats', 'experience', 'pdf-export'].includes(suite), 'suite 仅支持 full、formats、experience 或 pdf-export');
  const formats = arg('formats', 'sample.pdf,sample.epub,sample.docx,sample.html,sample.txt,sample.md,sample.srt,sample.vtt,sample.ass,sample.ssa,sample.lrc,sample.json').split(',');
  const exampleDir = path.resolve(arg('example-dir', 'examples/document-translation'));
  const packages = arg('playwright-root');
  const helperPath = arg('focus-safe-helper');
  assert(packages && helperPath, '需要 Playwright 和 focus-safe helper');
  const requireRuntime = createRequire(path.join(packages, 'document-runner.cjs'));
  const {chromium} = requireRuntime('playwright');
  const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(helperPath);
  fs.mkdirSync(artifactsDir, {recursive: true});
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-document-flow-'));
  const report = {ok: false, extensionDir, artifactsDir, service: 'loopback deterministic fixture', suite, scriptsByStage: {}, cases: [], screenshots: [], downloads: [], consoleErrors: [], exampleLoads: {}};
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
    const scriptPaths = new Set();
    page.on('response', response => {
      if (response.request().resourceType() !== 'script' || !response.url().startsWith(origin + '/')) return;
      scriptPaths.add(new URL(response.url()).pathname.slice(1));
    });
    const recordScripts = label => {
      const files = [...scriptPaths].sort().map(file => ({file, bytes: fs.statSync(path.join(extensionDir, file)).size}));
      report.scriptsByStage[label] = {bytes: files.reduce((sum, file) => sum + file.bytes, 0), files};
    };
    await page.goto(`${origin}/document.html`, {waitUntil: 'domcontentloaded'});
    await page.locator('.file-drop-zone').waitFor();
    recordScripts('initial');
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
    const select = async (name, label) => {
      if (name.startsWith('文档') && !await page.getByRole('combobox', {name, exact: true}).isVisible()) {
        await page.getByRole('button', {name: '调整文档翻译设置', exact: true}).click();
      }
      await page.locator('.el-select__wrapper').filter({has: page.getByRole('combobox', {name, exact: true})}).click();
      await page.getByRole('option', {name: label, exact: true}).click();
      if (name.startsWith('文档')) await page.locator('.document-settings-dialog[open]').getByRole('button', {name: '返回文档', exact: true}).click();
    };
    const status = label => page.locator('.document-status').filter({hasText: label}).waitFor();
    const load = async (name, buffer) => {
      await page.locator('input[type=file]').setInputFiles({name, mimeType: 'application/octet-stream', buffer});
      await page.locator('.workspace-heading h1').filter({hasText: name}).waitFor();
      await page.waitForFunction(() => document.querySelector('.document-app')?.classList.contains('is-workspace'));
      if (await page.locator('.rich-preview-frame').count()) {
        const frame = await (await page.locator('.rich-preview-frame').elementHandle()).contentFrame();
        await frame.waitForFunction(() => Boolean(document.body?.innerText.trim()));
      }
    };
    const newFile = async () => {
      await page.getByRole('button', {name: '调整文档翻译设置', exact: true}).click();
      await page.locator('.sidebar-change-file').click();
      const dialog = page.locator('dialog[open]').filter({has: page.locator('#confirm-document-heading')});
      if (await dialog.count()) await dialog.locator('.translate-document-button').click();
      await page.locator('.file-drop-zone').waitFor();
      await page.waitForFunction(() => !document.querySelector('.document-app')?.classList.contains('is-workspace'));
    };
    const download = async (mode = 'bilingual', partial = false) => {
      await page.getByRole('button', {name: '下载文件 ↓', exact: true}).click();
      const dialog = page.locator('dialog[open]').filter({hasText: '下载翻译结果'});
      await dialog.locator('.export-options button').nth(mode === 'bilingual' ? 0 : 1).click();
      if (partial) {
        assert.equal(await dialog.getByRole('button', {name: mode === 'bilingual' ? '下载双语文件' : '下载译文文件', exact: true}).isDisabled(), true);
        await dialog.getByRole('checkbox').check();
      }
      const [file] = await Promise.all([page.waitForEvent('download', {timeout: suite === 'pdf-export' ? 120000 : 30000}), dialog.getByRole('button', {name: mode === 'bilingual' ? '下载双语文件' : '下载译文文件', exact: true}).click()]);
      const dest = path.join(artifactsDir, file.suggestedFilename()); await file.saveAs(dest); report.downloads.push(dest); return dest;
    };
    assert.equal(await page.locator('.format-card').count(), 8);
    if (suite === 'pdf-export') {
      const {PDFDocument, rgb} = require('pdf-lib');
      const pdf = await PDFDocument.create();
      for (let index = 1; index <= 100; index++) {
        const sheet = pdf.addPage([595, 842]);
        sheet.drawText(`Long document page ${index}`, {x: 45, y: 760, size: 18});
        sheet.drawText('Export must preserve every page and all reviewed translations.', {x: 45, y: 700, size: 11});
        sheet.drawRectangle({x: 45, y: 500, width: 300, height: 120, color: rgb(0.8, 0.9, 1)});
      }
      await load('long-100.pdf', Buffer.from(await pdf.save()));
      await page.getByRole('button', {name: '开始翻译', exact: true}).click();
      await page.locator('.document-status').filter({hasText: '翻译完成'}).waitFor({timeout: 120000});
      await page.getByRole('button', {name: '校订译文', exact: true}).click();
      await page.locator('textarea.document-translation').first().fill('100 页导出校订保留测试');
      await page.getByRole('button', {name: '阅读', exact: true}).click();
      await page.getByRole('button', {name: '下载文件 ↓', exact: true}).click();
      const dialog = page.locator('.download-dialog[open]');
      await dialog.getByRole('button', {name: '下载双语文件', exact: true}).click();
      await dialog.locator('.export-progress').filter({hasText: /\d+ \/ 100 页/}).waitFor();
      await shot('pdf-100-progress');
      await dialog.getByRole('button', {name: '取消生成', exact: true}).click();
      await dialog.locator('.export-progress').filter({hasText: '已取消生成'}).waitFor();
      assert.equal(await dialog.getByRole('button', {name: '下载双语文件', exact: true}).isEnabled(), true);
      await shot('pdf-100-canceled');
      await dialog.getByRole('button', {name: '返回文档', exact: true}).click();
      report.cases.push('100-page export displays progress, cancels and keeps reviewed translations');
      for (const mode of ['bilingual', 'translated']) {
        const start = Date.now();
        const dest = await download(mode);
        const bytes = fs.readFileSync(dest);
        const output = await PDFDocument.load(bytes);
        assert.equal(output.getPageCount(), 100);
        assert.equal(output.getPage(99).getWidth(), mode === 'bilingual' ? 1204.875 : 595);
        report.exampleLoads[mode] = {pages: 100, bytes: bytes.length, elapsedMs: Date.now() - start};
      }
      await page.getByRole('button', {name: '校订译文', exact: true}).click();
      assert.equal(await page.locator('textarea.document-translation').first().inputValue(), '100 页导出校订保留测试');
      await page.setViewportSize({width: 390, height: 844});
      await page.getByRole('button', {name: '下载文件 ↓', exact: true}).click();
      await noOverflow(); await shot('pdf-100-export-mobile');
      report.cases.push('100-page bilingual and translated-only downloads reopen with correct page count and dimensions');
      assert.equal(report.consoleErrors.length, 0);
      report.ok = true;
      return;
    }
    if (suite === 'experience') {
      await shot('import-desktop');
      await page.setViewportSize({width: 390, height: 844}); await noOverflow(); await shot('import-mobile');
      await page.setViewportSize({width: 1440, height: 960});
      for (const label of ['文章', '字幕', '语言文件']) {
        await page.locator('.document-samples summary').click();
        await page.locator('.sample-buttons button').filter({hasText: label}).click();
        await status('准备就绪');
        assert.equal(await page.locator('.document-batch').count(), 0, '单份文件应直接进入阅读区');
        assert.equal(fixture.state.requests.length, 0, '导入范例不得自动发送翻译请求');
        await newFile();
      }
      report.cases.push('three local samples import through the normal reader without automatic translation');
      await load('sample.srt', fs.readFileSync(path.join(exampleDir, 'sample.srt')));
      await page.setViewportSize({width: 390, height: 844});
      assert.equal(await page.locator('.document-sidebar').count(), 0, '文档内容不应被常驻设置侧栏挤占');
      assert.equal(await page.locator('.document-settings-button').isVisible(), true);
      await noOverflow(); await shot('subtitle-ready-mobile');
      await page.getByRole('button', {name: '调整文档翻译设置', exact: true}).click();
      assert.equal(await page.getByRole('combobox', {name: '文档目标语言', exact: true}).isVisible(), true);
      await noOverflow(); await shot('document-settings-mobile');
      await page.locator('.document-settings-dialog[open]').getByRole('button', {name: '返回文档', exact: true}).click();
      await page.setViewportSize({width: 1440, height: 960});
      await page.getByRole('button', {name: '开始翻译', exact: true}).click(); await status('翻译完成');
      await page.getByRole('button', {name: '校订译文', exact: true}).click();
      await page.locator('textarea.document-translation').nth(0).fill('你好，欢迎阅读');
      await page.locator('textarea.document-translation').nth(1).fill('保持时间轴不变。');
      await page.getByRole('button', {name: '阅读', exact: true}).click();
      await page.getByRole('button', {name: '译文', exact: true}).click();
      await page.getByRole('button', {name: '下载文件 ↓', exact: true}).click();
      const dialog = page.locator('.download-dialog[open]');
      await page.waitForFunction(() => document.querySelector('.download-dialog[open] .export-options button:nth-child(2)')?.getAttribute('aria-pressed') === 'true');
      assert.equal(await dialog.locator('.export-options button').nth(1).getAttribute('aria-pressed'), 'true');
      assert.match(await dialog.locator('.export-file-name').innerText(), /sample.translated.srt/);
      const preview = await dialog.locator('.export-preview pre').innerText();
      assert(preview.includes('00:00:01,000 --> 00:00:03,000'));
      assert(!preview.includes('Hello subtitle') && !preview.includes('Keep the timing intact.'));
      await shot('subtitle-translated-export');
      const [translatedFile] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', {name: '下载译文文件', exact: true}).click()]);
      const translatedPath = path.join(artifactsDir, translatedFile.suggestedFilename()); await translatedFile.saveAs(translatedPath);
      const translatedText = fs.readFileSync(translatedPath, 'utf8');
      assert.equal(translatedText.trim(), preview.trim(), '文本下载内容应与预览一致');
      assert(!translatedText.includes('Hello subtitle') && !translatedText.includes('Keep the timing intact.'));
      report.downloads.push(translatedPath);
      report.cases.push('translated reading selects translation-only export; downloaded SRT matches preview and contains no reviewed source text');
      await page.getByRole('button', {name: '双语', exact: true}).click();
      await page.getByRole('button', {name: '下载文件 ↓', exact: true}).click();
      assert.equal(await dialog.locator('.export-options button').first().getAttribute('aria-pressed'), 'true');
      await dialog.getByRole('button', {name: '返回文档', exact: true}).click();
      const bilingualPath = await download('bilingual');
      assert(fs.readFileSync(bilingualPath, 'utf8').includes('Hello subtitle'));
      assert(fs.readFileSync(bilingualPath, 'utf8').includes('你好，欢迎阅读'));
      await page.getByRole('button', {name: '校订译文', exact: true}).click();
      await page.locator('textarea.document-translation').nth(1).fill('');
      await page.getByRole('button', {name: '阅读', exact: true}).click();
      await page.getByRole('button', {name: '译文', exact: true}).click();
      const partialPath = await download('translated', true);
      const partialText = fs.readFileSync(partialPath, 'utf8');
      assert(partialText.includes('你好，欢迎阅读') && partialText.includes('Keep the timing intact.'));
      assert(!partialText.includes('Hello subtitle'));
      report.cases.push('bilingual SRT retains both texts; clearing a cue requires partial-download acknowledgement and preserves source for that cue');
      await page.locator('input[type=file]').setInputFiles({name: 'extra.txt', mimeType: 'text/plain', buffer: Buffer.from('Another document.')});
      await page.locator('.batch-toggle').click();
      await page.locator('.batch-file').filter({hasText: 'extra.txt'}).waitFor();
      await page.locator('.batch-file').filter({hasText: 'extra.txt'}).click();
      await page.getByRole('button', {name: '开始翻译', exact: true}).click(); await status('翻译完成');
      await page.locator('.batch-file').filter({hasText: 'sample.srt'}).click();
      await page.getByRole('button', {name: '校订译文', exact: true}).click();
      assert.equal(await page.locator('textarea.document-translation').first().inputValue(), '你好，欢迎阅读');
      await page.locator('textarea.document-translation').nth(1).fill('保持时间轴不变。');
      await page.getByRole('button', {name: '阅读', exact: true}).click();
      await page.locator('.batch-toggle').click();
      assert.equal(await page.locator('.batch-files').isVisible(), false);
      await noOverflow(); await shot('subtitle-workspace-desktop');
      await page.locator('.batch-toggle').click();
      await select('打包内容', '仅译文');
      const [archive] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', {name: '下载已完成文件（ZIP）', exact: true}).click()]);
      const archivePath = path.join(artifactsDir, archive.suggestedFilename()); await archive.saveAs(archivePath);
      const zip = await require('jszip').loadAsync(fs.readFileSync(archivePath));
      assert.equal(await zip.file('1/sample.translated.srt').async('string'), translatedText);
      assert(zip.file('2/extra.translated.txt'));
      report.downloads.push(archivePath);
      await page.locator('.batch-toggle').click();
      report.cases.push('adding and switching files preserves corrections; collapsed queue supports ZIP with the selected output mode');
      await select('文档目标语言', '日本語 / Japanese / 日语');
      await page.getByRole('button', {name: '按新设置翻译', exact: true}).click();
      await page.locator('dialog[open]').getByRole('button', {name: '返回文档', exact: true}).click();
      await select('文档目标语言', '简体中文 / Simplified Chinese');
      assert.match(await page.locator('.subtitle-translation').first().innerText(), /你好，欢迎阅读/);
      report.cases.push('settings dropdown works inside native dialog; changing target and cancelling restart retains reviewed translations');
      await page.emulateMedia({colorScheme: 'dark'}); await shot('subtitle-workspace-dark');
      assert.equal(await page.locator('.document-app.dark').count(), 1);
      await page.setViewportSize({width: 820, height: 960}); await noOverflow(); await shot('subtitle-tablet-dark');
      await page.setViewportSize({width: 390, height: 844}); await noOverflow(); await shot('subtitle-mobile-dark');
      await page.getByRole('button', {name: '下载文件 ↓', exact: true}).click();
      await noOverflow(); await shot('subtitle-export-mobile-dark');
      await dialog.getByRole('button', {name: '返回文档', exact: true}).click();
      await page.emulateMedia({colorScheme: 'light'}); await shot('subtitle-mobile-light');
      report.cases.push('1440, 820 and 390 px layouts and dark download dialog render without horizontal overflow');
      await page.setViewportSize({width: 1440, height: 960});
      const english = await page.evaluate(async () => {
        const stored = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
        const current = typeof stored.value === 'string' ? JSON.parse(stored.value) : stored.value;
        return chrome.runtime.sendMessage({type: 'persistConfig', mode: 'replace', baseRevision: current.__fluentConfigRevision,
          clientId: `document-language-${crypto.randomUUID()}`, sequence: 1, config: {...current, uiLanguage: 'en-US'}});
      });
      assert.equal(english.success, true);
      await page.waitForFunction(() => document.querySelector('.document-settings-button')?.innerText.includes('Adjust settings'));
      await noOverflow(); await shot('subtitle-workspace-english');
      await page.locator('.document-settings-button').click(); await noOverflow(); await shot('document-settings-english');
      await page.locator('.document-settings-dialog[open] button.ghost-button').click();
      report.cases.push('English workspace and settings retain localized controls and reviewed subtitle content');
      assert.equal(report.consoleErrors.length, 0);
      report.ok = true;
      return;
    }
    await shot('01-import-desktop'); await noOverflow();
    await page.setViewportSize({width: 390, height: 844}); await noOverflow(); await shot('02-import-mobile');
    await page.setViewportSize({width: 1440, height: 960});
    await page.locator('input[type=file]').setInputFiles({name: 'unsupported.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('not a document')});
    await page.locator('.notice.error').waitFor();
    assert.match(await page.locator('.notice.error').innerText(), /不支持/);
    report.cases.push('unsupported import has persistent actionable error');

    for (const name of formats) {
      await load(name, fs.readFileSync(path.join(exampleDir, name)));
      recordScripts(`import:${name}`);
      await page.getByRole('button', {name: '开始翻译', exact: true}).click();
      await status('翻译完成');
      assert.equal(await page.getByRole('progressbar', {includeHidden: true}).getAttribute('aria-valuenow'), '100');
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
        await select('PDF 预览缩放', '150%');
        assert((await previewImage.boundingBox()).width > beforeZoom * 1.4, 'PDF 放大必须实际改变页面尺寸');
        await select('PDF 预览缩放', '适合宽度');
      }
      const dest = await download();
      recordScripts(`export:${name}`);
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
      if (suite === 'formats' && name === formats.at(-1)) {
        if (!await page.locator('.document-batch').count()) {
          await page.locator('input[type=file]').setInputFiles({name: 'batch-extra.txt', mimeType: 'text/plain', buffer: Buffer.from('An extra document.')});
          await page.getByRole('button', {name: '翻译剩余文件', exact: true}).click();
          await page.waitForFunction(() => [...document.querySelectorAll('.batch-file small')].every(element => element.textContent.includes('翻译完成')));
        }
        if (await page.locator('.batch-toggle').getAttribute('aria-expanded') === 'false') await page.locator('.batch-toggle').click();
        const [archive] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', {name: '下载已完成文件（ZIP）', exact: true}).click()]);
        const archivePath = path.join(artifactsDir, archive.suggestedFilename());
        await archive.saveAs(archivePath);
        const zip = await require('jszip').loadAsync(fs.readFileSync(archivePath));
        assert(Object.keys(zip.files).some(file => file.endsWith(path.basename(dest))), '批量 ZIP 应包含已导出的文件');
        report.downloads.push(archivePath);
        recordScripts('batch-export');
        report.cases.push('lazy batch ZIP download contains completed document');
      }
      await newFile();
    }
    report.cases.push(`${formats.length} formats parse, translate through provider, edit via UI and export original format`);
    if (suite === 'formats') {
      assert.equal(report.consoleErrors.length, 0, '文档导入导出不得产生控制台错误');
      report.ok = true;
      return;
    }

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
    await select('校订页码', '3 / 3');
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
    await page.getByRole('button', {name: '调整文档翻译设置', exact: true}).click();
    await page.getByRole('button', {name: '打开新文件', exact: true}).click();
    await page.locator('dialog[open]').getByRole('button', {name: '返回文档'}).click();
    assert.match(await page.locator('.workspace-heading h1').innerText(), /long-document/);
    await select('文档目标语言', '日本語 / Japanese / 日语');
    await page.locator('.notice.warning').filter({hasText: '设置已更改'}).waitFor();
    await page.getByRole('button', {name: '按新设置翻译'}).click();
    await page.locator('dialog[open]').getByRole('button', {name: '返回文档'}).click();
    await select('文档目标语言', '简体中文 / Simplified Chinese');
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
    await select('文档目标语言', '日本語 / Japanese / 日语');
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
    await newFile();
    fixture.state.delay = 1000;
    fixture.state.fail = true;
    const batchFiles = [
      {name: 'same.txt', text: ['Batch alpha first paragraph.', ...Array.from({length: 20}, (_, i) => `Batch alpha paragraph ${i + 2}.`)].join('\n\n')},
      {name: 'broken.json', text: '{not valid json'},
      {name: 'failure.txt', text: 'Failure target batch paragraph.'},
      {name: 'same.txt', text: 'Batch omega successful after failure.'},
    ];
    await page.locator('input[type=file]').setInputFiles(batchFiles.map(file => ({name: file.name, mimeType: 'application/octet-stream', buffer: Buffer.from(file.text)})));
    await page.waitForFunction(() => document.querySelectorAll('.batch-files li').length === 4 && document.querySelector('.document-batch')?.getAttribute('aria-busy') === 'false');
    const entries = page.locator('.batch-files li');
    assert.match(await entries.nth(1).innerText(), /导入失败/);
    await page.getByRole('button', {name: '翻译剩余文件', exact: true}).click();
    await status('正在翻译');
    await page.waitForFunction(() => Number(document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')) > 0);
    await page.getByRole('button', {name: '暂停全部', exact: true}).click();
    await status('已暂停');
    assert.match(await entries.nth(3).innerText(), /等待翻译/);
    fixture.state.delay = 5;
    const firstRequests = fixture.state.requests.filter(text => text.includes('Batch alpha first paragraph')).length;
    await page.getByRole('button', {name: '翻译剩余文件', exact: true}).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.batch-files li')].filter(li => li.textContent.includes('翻译完成')).length === 2);
    await page.getByRole('button', {name: '翻译剩余文件', exact: true}).waitFor();
    assert.equal(fixture.state.requests.filter(text => text.includes('Batch alpha first paragraph')).length, firstRequests, '续译不能重新请求已提交的片段');
    assert.match(await entries.nth(2).innerText(), /翻译中断/);
    assert.match(await entries.nth(3).innerText(), /翻译完成/);
    report.cases.push('batch multi-select accepts mixed formats; invalid import and failed translation do not block later files; pause/resume retains completed segments');
    await entries.nth(0).locator('.batch-file').click();
    await page.getByRole('button', {name: '校订译文', exact: true}).click();
    await page.locator('textarea.document-translation').first().fill('批量文件人工校订');
    await entries.nth(3).locator('.batch-file').click();
    await page.getByRole('button', {name: '校订译文', exact: true}).click();
    assert.match(await page.locator('textarea.document-translation').first().inputValue(), /Batch omega/);
    await entries.nth(0).locator('.batch-file').click();
    await page.getByRole('button', {name: '校订译文', exact: true}).click();
    assert.equal(await page.locator('textarea.document-translation').first().inputValue(), '批量文件人工校订');
    await entries.nth(0).getByRole('button', {name: '移除 same.txt', exact: true}).click();
    await page.locator('dialog[open]').getByRole('button', {name: '返回文档', exact: true}).click();
    assert.equal(await entries.count(), 4);
    const [archive] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', {name: '下载已完成文件（ZIP）', exact: true}).click()]);
    const archivePath = path.join(artifactsDir, 'batch-completed.zip');
    await archive.saveAs(archivePath);
    report.downloads.push(archivePath);
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(fs.readFileSync(archivePath));
    const outputs = Object.values(zip.files).filter(file => !file.dir);
    assert.equal(outputs.length, 2, '仅打包完整译文');
    assert.notEqual(outputs[0].name, outputs[1].name, '同名源文件不覆盖');
    const contents = await Promise.all(outputs.map(file => file.async('string')));
    assert(contents.some(text => text.includes('批量文件人工校订')));
    assert(contents.some(text => text.includes('Batch omega')));
    await shot('09-batch-completed'); await noOverflow();
    await page.setViewportSize({width: 390, height: 844}); await noOverflow(); await shot('10-batch-mobile');
    await page.emulateMedia({colorScheme: 'dark'}); await shot('11-batch-mobile-dark');
    await page.setViewportSize({width: 1440, height: 960});
    await page.emulateMedia({colorScheme: 'light'});
    fixture.state.fail = false;
    await page.getByRole('button', {name: '翻译剩余文件', exact: true}).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.batch-files li')].filter(li => li.textContent.includes('翻译完成')).length === 3);
    report.cases.push('batch task switching preserves independent edits; removal protects undownloaded work; ZIP contains only completed files and preserves duplicate names; failed file retries');
    await newFile();
    await page.locator('.file-drop-zone').evaluate(zone => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['Dropped first file.'], 'drop-first.txt', {type: 'text/plain'}));
      transfer.items.add(new File(['Dropped second file.'], 'drop-second.txt', {type: 'text/plain'}));
      zone.dispatchEvent(new DragEvent('drop', {bubbles: true, dataTransfer: transfer}));
    });
    await page.waitForFunction(() => document.querySelectorAll('.batch-files li').length === 2);
    assert.match(await page.locator('.batch-files').innerText(), /drop-first.txt/);
    assert.match(await page.locator('.batch-files').innerText(), /drop-second.txt/);
    report.cases.push('drag-and-drop imports every file');
    assert.equal(report.consoleErrors.filter(message => !/Fixture intentional failure|400 \(Bad Request\)/u.test(message)).length, 0);
    report.expectedFixtureErrors = report.consoleErrors.filter(message => /Fixture intentional failure|400 \(Bad Request\)/u.test(message));
    report.consoleErrors = report.consoleErrors.filter(message => !/Fixture intentional failure|400 \(Bad Request\)/u.test(message));
    report.ok = true;
  } catch (error) {
    report.failure = error.stack || String(error);
    if (page) report.visibleUi = await page.evaluate(() => ({rootClass: document.querySelector('.document-app')?.className,
      activeDialogs: [...document.querySelectorAll('dialog[open]')].map(element => element.innerText),
      workspace: document.querySelector('.workspace-section')?.innerText})).catch(() => ({}));
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
