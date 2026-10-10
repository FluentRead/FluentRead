#!/usr/bin/env node
'use strict';

// 文档产品流程回归：临时 profile、生产扩展、真实 UI 输入和下载，网络仅连接本机确定性服务。
// 覆盖所有支持格式、长 PDF/归档取消重试、暂停续译、失败恢复、完整校订、设置变化、离开保护及响应式外观。
const assert = require('node:assert/strict');
const {guardBrowserClose} = require('./testing/owned-browser-close.cjs');
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
      const protocol = /(___FLUENTREAD_([a-z0-9_-]+)_(\d+)_BEGIN___)([\s\S]*?)(___FLUENTREAD_\2_\3_END___)/giu;
      const translation = protocol.test(source) ? source.replace(protocol, (_match, begin, _nonce, _index, text, end) => `${begin}测试译文：${text}${end}`) : `测试译文：${source}`;
      await new Promise(resolve => setTimeout(resolve, state.delay));
      if (state.fail && source.includes('Failure target')) { res.writeHead(400); res.end(JSON.stringify({error: {message: 'Fixture intentional failure'}})); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({id: 'document-fixture', object: 'chat.completion', created: 1, model: 'document-fixture',
        choices: [{index: 0, message: {role: 'assistant', content: translation}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 10, completion_tokens: 10, total_tokens: 20}}));
    } catch (error) { res.writeHead(400); res.end(JSON.stringify({error: {message: error.message}})); }
  });
  await new Promise((resolve, reject) => {const onError = error => {server.close(() => reject(error)); server.closeAllConnections();}; server.once('error', onError); server.listen(0, '127.0.0.1', () => {server.off('error', onError); resolve();});});
  return {...state, state, url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, close: () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); }};
}

async function pdfPageTexts(bytes) {
  const requireRepo = createRequire(path.join(__dirname, '..', 'package.json'));
  const {getDocument} = await import(requireRepo.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
  const task = getDocument({data: new Uint8Array(bytes), disableFontFace: true, isEvalSupported: false, useWorkerFetch: false, verbosity: 0,
    standardFontDataUrl: path.join(path.dirname(requireRepo.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep});
  try {
    const pdf = await task.promise, pages = [];
    for (let number = 1; number <= pdf.numPages; number++) {const page = await pdf.getPage(number); try {pages.push((await page.getTextContent()).items.filter(item => 'str' in item).map(item => item.str).join('\n'));} finally {page.cleanup();}}
    return pages;
  } finally {await task.destroy();}
}

async function main() {
  const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
  const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-document-experience'));
  const suite = arg('suite', 'full');
  assert(['full', 'formats', 'archives', 'experience', 'pdf-export', 'scanned'].includes(suite), 'suite 仅支持 full、formats、archives、experience、pdf-export 或 scanned');
  const formats = arg('formats', 'sample.pdf,sample.epub,sample.docx,sample.html,sample.txt,sample.md,sample.srt,sample.vtt,sample.ass,sample.ssa,sample.lrc,sample.json').split(',');
  const exampleDir = path.resolve(arg('example-dir', 'examples/document-translation'));
  const packages = arg('playwright-root');
  const helperPath = arg('focus-safe-helper', path.join(__dirname, 'testing/focus-safe-browser.cjs'));
  assert(packages && helperPath, '需要 Playwright 和 focus-safe helper');
  const requireRuntime = createRequire(path.join(packages, 'document-runner.cjs'));
  const {chromium} = requireRuntime('playwright');
  const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(helperPath);
  fs.mkdirSync(artifactsDir, {recursive: true});
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-document-flow-'));
  const report = {ok: false, extensionDir, artifactsDir, service: 'loopback deterministic fixture', suite, scriptsByStage: {}, cases: [], screenshots: [], downloads: [], consoleErrors: [], exampleLoads: {}};
  let fixture, launched, page; let launchAttempted = false;
  try {
    fixture = await fixtureServer();
    launchAttempted = true;
    launched = await launchFocusSafePersistentContext({chromium, profileDir,
      browserPath: arg('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      background: true, headless: false, viewport: {width: 1440, height: 960}, timeout: 30000,
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    guardBrowserClose(launched, profileDir);
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
    // 新界面：“调整设置”在左侧栏底部（工具栏里不再有设置按钮）；文件列表在侧栏“文件”页，PDF 目录在“目录”页。
    const showSidebar = async () => {if (!await page.locator('aside.document-sidebar').isVisible()) await page.locator('.sidebar-toggle').click(); await page.locator('aside.document-sidebar').waitFor();};
    const sidebarTab = async label => {
      await showSidebar();
      const tab = page.locator('.sidebar-tabs [role="tab"]').filter({hasText: label});
      if (await tab.getAttribute('aria-selected') !== 'true') await tab.click();
      assert.equal(await tab.getAttribute('aria-selected'), 'true');
    };
    const openSettings = async () => {
      await showSidebar();
      assert.equal(await page.locator('.document-taskbar .document-settings-button').count(), 0, '工具栏不应再有设置按钮');
      await page.locator('aside.document-sidebar').getByRole('button', {name: '调整文档翻译设置', exact: true}).click();
      await page.locator('.document-settings-dialog[open]').waitFor();
    };
    // PDF 缩放是自定义菜单：点开 .pdf-menu-button，再点 li[role=option][data-value]。
    const pdfMenu = async (root, value) => {
      const menu = page.locator(root);
      await menu.locator('.pdf-menu-button').click(); await menu.locator(`li[role="option"][data-value="${value}"]`).click();
      await menu.locator('.pdf-menu-list').waitFor({state: 'detached'});
    };
    const pdfZoom = value => pdfMenu('.pdf-zoom-control .pdf-menu', value);
    const pdfPresentation = async value => {await pdfMenu('.pdf-presentation-control.pdf-menu', value); await page.locator(`.pdf-layout-viewer[data-pdf-presentation="${value}"]`).waitFor();};
    const compact = value => value.replace(/\s+/gu, '');
    const select = async (name, label) => {
      if (name.startsWith('文档') && !await page.getByRole('combobox', {name, exact: true}).isVisible()) await openSettings();
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
      await openSettings();
      await page.locator('.document-settings-dialog[open] .sidebar-change-file').click();
      const dialog = page.locator('dialog[open]').filter({has: page.locator('#confirm-document-heading')});
      if (await dialog.count()) await dialog.locator('.translate-document-button').click();
      await page.locator('.file-drop-zone').waitFor();
      await page.waitForFunction(() => !document.querySelector('.document-app')?.classList.contains('is-workspace'));
      assert.equal(await page.evaluate(() => sessionStorage.getItem('fluentread.document.open')), null, '离开文档后不应再记住已打开的文档');
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
      // 打包可能在对话框动画结束前就完成；不等待按钮位置稳定，按钮一出现就点击，避免与“已完成”竞争。
      await dialog.getByRole('button', {name: '取消生成', exact: true}).click({force: true});
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
        // 原版排版下载：每个源页对应一个输出页；双语同页左右对照，译文保持单宽。
        const texts = await pdfPageTexts(bytes), originals = texts.map((text, index) => ({index, text})).filter(entry => entry.text.includes('Long document page'));
        assert.equal(output.getPageCount(), 100, '下载必须保留 100 个源页的一一对应关系');
        if (mode === 'bilingual') {
          assert.equal(originals.length, 100, '双语下载必须保留全部 100 个原页');
          originals.forEach((entry, order) => {
            assert.equal(Number(/Long document page\s+(\d+)/u.exec(entry.text)?.[1]), order + 1, '原页必须按源页顺序排列');
            assert.equal(entry.index, order, `第 ${order + 1} 个原页必须在同一个左右对照输出页中`);
          });
        } else assert.equal(originals.length, 0, '仅译文下载不含原页矢量文字');
        const expectedWidth = mode === 'bilingual' ? 595 * 2 + Math.max(8, Math.min(24, 595 * .025)) : 595;
        for (const sheet of output.getPages()) {assert.equal(sheet.getWidth(), expectedWidth); assert.equal(sheet.getHeight(), 842);}
        report.exampleLoads[mode] = {pages: output.getPageCount(), originalPages: originals.length, bytes: bytes.length, elapsedMs: Date.now() - start};
      }
      await page.getByRole('button', {name: '校订译文', exact: true}).click();
      assert.equal(await page.locator('textarea.document-translation').first().inputValue(), '100 页导出校订保留测试');
      await page.setViewportSize({width: 390, height: 844});
      await page.getByRole('button', {name: '下载文件 ↓', exact: true}).click();
      await noOverflow(); await shot('pdf-100-export-mobile');
      report.cases.push('100-page bilingual and translated-only downloads reopen with every original page, translated pages and original page dimensions');
      assert.equal(report.consoleErrors.length, 0);
      report.ok = true;
      return;
    }
    if (suite === 'scanned') {
      // 扫描版 PDF：页面只有图像、没有文字层。本套件需要联网下载一次英文识别语言包，因此不在默认的 full 套件里。
      const {PDFDocument} = require('pdf-lib');
      const printed = ['Scanned pages carry no text layer at all.', 'Recognition must find these printed sentences.', 'The translated page keeps the original picture.'];
      const png = await page.evaluate(lines => {
        const canvas = document.createElement('canvas'); canvas.width = 1240; canvas.height = 1754;
        const context = canvas.getContext('2d'); context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#111111'; context.font = '44px Georgia, serif';
        lines.forEach((line, index) => context.fillText(line, 110, 260 + index * 150));
        return canvas.toDataURL('image/png').split(',')[1];
      }, printed);
      const scan = await PDFDocument.create();
      const picture = await scan.embedPng(Buffer.from(png, 'base64'));
      // 第 1 页是带文字层的普通页，后两页是扫描页：文字 PDF 里夹着的扫描页同样要识别。
      const typed = 'A typed first page already has a real text layer.';
      scan.addPage([595, 842]).drawText(typed, {x: 60, y: 600, size: 16});
      for (let index = 0; index < 2; index++) scan.addPage([595, 842]).drawImage(picture, {x: 0, y: 0, width: 595, height: 842});
      // 第 4～6 页是旋转 90、180、270 度的扫描页：图像反向转好放进竖页，再用 /Rotate 摆正；90 与 270 度展示出来是横页。
      const {degrees} = require('pdf-lib');
      const turnedPages = [
        {angle: 90, landscape: true, lines: ['Sideways scans are turned upright first.', 'Rotated pages translate like the others.'], place: {x: 595, y: 0, width: 842, height: 595, rotate: degrees(90)}},
        {angle: 180, landscape: false, lines: ['Upside down scans read normally again.', 'Half turns keep the portrait shape.'], place: {x: 595, y: 842, width: 595, height: 842, rotate: degrees(180)}},
        {angle: 270, landscape: true, lines: ['Three quarter turns also end upright.', 'Every scanned angle reaches the translator.'], place: {x: 0, y: 842, width: 842, height: 595, rotate: degrees(-90)}},
      ];
      for (const turned of turnedPages) {
        const turnedPng = await page.evaluate(({lines, landscape}) => {
          const canvas = document.createElement('canvas'); canvas.width = landscape ? 1754 : 1240; canvas.height = landscape ? 1240 : 1754;
          const context = canvas.getContext('2d'); context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = '#111111'; context.font = '44px Georgia, serif';
          lines.forEach((line, index) => context.fillText(line, 130, 300 + index * 170));
          return canvas.toDataURL('image/png').split(',')[1];
        }, {lines: turned.lines, landscape: turned.landscape});
        const turnedPage = scan.addPage([595, 842]);
        turnedPage.drawImage(await scan.embedPng(Buffer.from(turnedPng, 'base64')), turned.place);
        turnedPage.setRotation(degrees(turned.angle));
      }
      const requestsBeforeScan = fixture.state.requests.length;
      await load('scanned.pdf', Buffer.from(await scan.save()));
      await page.locator('.pdf-page-row[data-page-number="1"]').waitFor();
      assert.match(await page.locator('.document-status').innerText(), /扫描件/, '没有文字层的 PDF 应提示开始翻译时先识别文字');
      assert.equal(await page.locator('.pdf-translation-block').count(), 0, '开始翻译之前不能有译文块');
      assert.equal(fixture.state.requests.length, requestsBeforeScan, '打开扫描件不得发送翻译请求');
      await shot('scanned-opened');
      await page.locator('.translation-actions .translate-document-button').click();
      await page.locator('.document-status').filter({hasText: '正在识别文字'}).waitFor({timeout: 60000});
      assert.equal(fixture.state.requests.length, requestsBeforeScan, '识别进行中还没有可翻译的文字');
      await page.locator('.document-status').filter({hasText: '翻译完成'}).waitFor({timeout: 240000});
      const recognized = fixture.state.requests.slice(requestsBeforeScan);
      // 识别允许个别字符有出入，但三句印刷文字都必须被认出并送去翻译。
      for (const phrase of [/scanned pages carry/iu, /recognition must find/iu, /translated page keeps/iu]) assert(recognized.some(source => phrase.test(source)), `识别结果缺少印刷文字 ${phrase}：${JSON.stringify(recognized)}`);
      assert(recognized.includes(typed), `带文字层的页应照常翻译：${JSON.stringify(recognized)}`);
      const pageInput = page.locator('.pdf-page-navigation input'); await pageInput.fill('2'); await pageInput.press('Enter');
      await page.locator('.pdf-page-row[data-page-number="2"] .pdf-translation-block').first().waitFor();
      const scannedBlocks = await page.locator('.pdf-page-row[data-page-number="2"] .pdf-translation-block').evaluateAll(blocks => blocks.map(block => {
        const frame = block.closest('.pdf-page-frame, .pdf-page-column').getBoundingClientRect(), box = block.getBoundingClientRect();
        return {text: block.innerText.trim(), inside: box.left >= frame.left - 2 && box.right <= frame.right + 2 && box.top >= frame.top - 2 && box.bottom <= frame.bottom + 2};
      }));
      assert(scannedBlocks.length >= 3, `扫描页上应有三段译文：${JSON.stringify(scannedBlocks)}`);
      assert(scannedBlocks.every(block => block.text && block.inside), `译文块必须有内容且不超出页面：${JSON.stringify(scannedBlocks)}`);
      assert.equal(await page.locator('.pdf-translation-spinner, .pdf-translation-block.pending').count(), 0, '翻译完成后不能残留等待动画');
      await shot('scanned-translated');
      const turnedReport = [];
      for (const [index, turned] of turnedPages.entries()) {
        const number = 4 + index;
        for (const line of turned.lines) {
          const phrase = new RegExp(line.split(' ').slice(0, 3).join(' '), 'iu');
          assert(recognized.some(source => phrase.test(source)), `旋转 ${turned.angle} 度的扫描页没有认出“${line}”：${JSON.stringify(recognized)}`);
        }
        await pageInput.fill(String(number)); await pageInput.press('Enter');
        await page.locator(`.pdf-page-row[data-page-number="${number}"] .pdf-translation-block`).first().waitFor();
        const turnedBlocks = await page.locator(`.pdf-page-row[data-page-number="${number}"] .pdf-translation-block`).evaluateAll(blocks => blocks.map(block => {
          const frame = block.closest('.pdf-page-frame, .pdf-page-column').getBoundingClientRect(), box = block.getBoundingClientRect();
          // 段落框可以向下留出余量，是否横排要看第一行文字本身的形状。
          const range = document.createRange(); range.selectNodeContents(block.querySelector('.pdf-translation-text span')); const line = range.getBoundingClientRect();
          return {text: block.innerText.trim(), width: Math.round(line.width), height: Math.round(line.height), upright: line.width > line.height * 3, landscape: frame.width > frame.height,
            inside: box.left >= frame.left - 2 && box.right <= frame.right + 2 && box.top >= frame.top - 2 && box.bottom <= frame.bottom + 2};
        }));
        await shot(`scanned-rotated-${turned.angle}-translated`);
        assert(turnedBlocks.length >= 2, `旋转 ${turned.angle} 度的扫描页上应有两段译文：${JSON.stringify(turnedBlocks)}`);
        assert(turnedBlocks.every(block => block.text && block.inside && block.upright && block.landscape === turned.landscape), `旋转 ${turned.angle} 度的扫描页，译文必须横排、摆正并留在页面内：${JSON.stringify(turnedBlocks)}`);
        turnedReport.push({angle: turned.angle, blocks: turnedBlocks.length});
      }
      report.scanned = {pages: 6, scannedPages: 5, rotatedScannedPages: turnedReport, recognizedSources: [...new Set(recognized)], blocksOnFirstScannedPage: scannedBlocks.length};
      report.cases.push('a PDF with one typed page, two scanned pages and three rotated scanned pages (90, 180 and 270 degrees) opens without requests, recognises the scanned pages when translation starts, translates the typed page as usual and shows upright translations inside the scanned pages');
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
        assert.equal(await page.locator('.batch-files li').count(), 1, '单份文件应直接进入阅读区'); assert.equal(await page.locator('.document-reading-pane').isVisible(), true);
        assert.equal(fixture.state.requests.length, 0, '导入范例不得自动发送翻译请求');
        await newFile();
      }
      report.cases.push('three local samples import through the normal reader without automatic translation');
      await load('sample.srt', fs.readFileSync(path.join(exampleDir, 'sample.srt')));
      await page.setViewportSize({width: 390, height: 844});
      // 窄屏：侧栏叠在工具栏下方、最多占四成高度，可以用工具栏的按钮收起；设置入口在侧栏底部。
      const narrowSidebar = await page.locator('aside.document-sidebar').boundingBox();
      assert(narrowSidebar && narrowSidebar.height <= 844 * 0.4 + 1, `窄屏侧栏不应挤占文档内容：${JSON.stringify(narrowSidebar)}`);
      assert.equal(await page.locator('aside.document-sidebar .document-settings-button').isVisible(), true);
      await page.locator('.sidebar-toggle').click();
      assert.equal(await page.locator('aside.document-sidebar').isVisible(), false, '侧栏应可收起'); assert.equal(await page.locator('.document-reading-pane').isVisible(), true);
      await noOverflow(); await shot('subtitle-ready-mobile');
      await openSettings();
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
      // 添加第二份文件后它立即成为当前文档，侧栏切到“文件”页。
      await page.locator('.workspace-heading h1').filter({hasText: 'extra.txt'}).waitFor();
      await page.locator('aside.document-sidebar .batch-file').filter({hasText: 'extra.txt'}).waitFor();
      assert.match(await page.locator('.batch-files li.selected').innerText(), /extra.txt/);
      await page.getByRole('button', {name: '开始翻译', exact: true}).click(); await status('翻译完成');
      await page.locator('.batch-file').filter({hasText: 'sample.srt'}).click();
      await page.getByRole('button', {name: '校订译文', exact: true}).click();
      assert.equal(await page.locator('textarea.document-translation').first().inputValue(), '你好，欢迎阅读');
      await page.locator('textarea.document-translation').nth(1).fill('保持时间轴不变。');
      await page.getByRole('button', {name: '阅读', exact: true}).click();
      await page.locator('.sidebar-toggle').click();
      assert.equal(await page.locator('.batch-files').isVisible(), false);
      await noOverflow(); await shot('subtitle-workspace-desktop');
      await page.locator('.sidebar-toggle').click(); await sidebarTab('文件');
      await select('打包内容', '仅译文');
      const [archive] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', {name: '下载已完成文件（ZIP）', exact: true}).click()]);
      const archivePath = path.join(artifactsDir, archive.suggestedFilename()); await archive.saveAs(archivePath);
      const zip = await require('jszip').loadAsync(fs.readFileSync(archivePath));
      assert.equal(await zip.file('1/sample.translated.srt').async('string'), translatedText);
      assert(zip.file('2/extra.translated.txt'));
      report.downloads.push(archivePath);
      report.cases.push('an added file becomes current; switching files preserves corrections; the sidebar collapses; the file list offers ZIP with the selected output mode');
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
      const requestsBeforeLoad = fixture.state.requests.length;
      await load(name, fs.readFileSync(path.join(exampleDir, name)));
      recordScripts(`import:${name}`);
      assert.equal(fixture.state.requests.length, requestsBeforeLoad, '打开文件不得自动开始翻译');
      // 工具栏只有一行：文件名、状态、工作区页签、阅读方式、服务/目标语言选择、下载与最右侧的翻译按钮；设置入口和添加文件都在侧栏。
      const chrome = await page.evaluate(() => {
        const bar = document.querySelector('section.document-taskbar[aria-label="当前文档与翻译任务"]'), sidebar = document.querySelector('aside.document-sidebar');
        const right = selector => bar?.querySelector(selector)?.getBoundingClientRect().right ?? null, visible = element => Boolean(element) && element.getClientRects().length > 0;
        return {bars: document.querySelectorAll('.document-taskbar').length, heading: bar?.querySelector('.workspace-heading h1')?.textContent, status: bar?.querySelector('.document-status')?.textContent,
          workspaceTabs: [...(bar?.querySelectorAll('[aria-label="文档工作区"] button') || [])].map(button => button.textContent.trim()), readingModes: [...(bar?.querySelectorAll('[aria-label="阅读方式"] button') || [])].map(button => button.textContent.trim()),
          controlsSlot: Boolean(bar?.querySelector('.reader-controls-slot')), service: bar?.querySelector('.toolbar-service input')?.getAttribute('aria-label') ?? bar?.querySelector('.toolbar-service')?.getAttribute('aria-label'),
          language: bar?.querySelector('.toolbar-language input')?.getAttribute('aria-label') ?? bar?.querySelector('.toolbar-language')?.getAttribute('aria-label'),
          downloadRight: right('.download-button'), translateRight: right('.translate-document-button'), languageRight: right('.toolbar-language'),
          settingsInBar: bar?.querySelectorAll('.document-settings-button').length, settingsInSidebar: visible(sidebar?.querySelector('.document-settings-button')), settingsText: sidebar?.querySelector('.document-settings-button small')?.textContent,
          sidebarOpen: visible(sidebar), sidebarTabs: [...(sidebar?.querySelectorAll('.sidebar-tabs [role="tab"]') || [])].map(tab => tab.firstChild.textContent.trim()),
          addFile: [...document.querySelectorAll('.sidebar-add-file')].map(button => ({inSidebar: Boolean(button.closest('aside.document-sidebar')), text: button.textContent.trim()})), addFileInBar: [...(bar?.querySelectorAll('button') || [])].filter(button => button.textContent.includes('添加文件')).length,
          saveNote: document.querySelectorAll('.reader-save-note').length, noticesInBar: Boolean(bar?.querySelector('.taskbar-notices')), selectionHint: document.querySelectorAll('.pdf-selection-hint').length};
      });
      assert.deepEqual({bars: chrome.bars, heading: chrome.heading, workspaceTabs: chrome.workspaceTabs, controlsSlot: chrome.controlsSlot, service: chrome.service, language: chrome.language, settingsInBar: chrome.settingsInBar, settingsInSidebar: chrome.settingsInSidebar,
        settingsText: chrome.settingsText, sidebarOpen: chrome.sidebarOpen, addFile: chrome.addFile, addFileInBar: chrome.addFileInBar, saveNote: chrome.saveNote, noticesInBar: chrome.noticesInBar, selectionHint: chrome.selectionHint},
      {bars: 1, heading: name, workspaceTabs: ['阅读', '校订译文'], controlsSlot: true, service: '翻译服务', language: '目标语言', settingsInBar: 0, settingsInSidebar: true,
        settingsText: '调整设置', sidebarOpen: true, addFile: [{inSidebar: true, text: '添加文件'}], addFileInBar: 0, saveNote: 0, noticesInBar: true, selectionHint: 0}, `新工具栏与侧栏结构不符：${JSON.stringify(chrome)}`);
      assert.match(chrome.status, /准备就绪/); assert.deepEqual(chrome.readingModes, ['原文', '双语', '译文']);
      assert(chrome.translateRight > chrome.downloadRight && chrome.downloadRight > chrome.languageRight, `翻译按钮应在最右侧，下载按钮在其左：${JSON.stringify(chrome)}`);
      // PDF 总有“目录”页；其他格式只有带标题的文档才有（HTML、Markdown、ePub 预览里的标题，Word 的标题样式段落），并且此时侧栏里必须真的列出目录项。
      const outlineItems = await page.locator('.document-sidebar .document-outline-item').count();
      const richHeadings = (await page.locator('.rich-preview-frame').count() ? await page.locator('.rich-preview-frame').contentFrame().locator('h1,h2,h3,h4,h5,h6').count() : 0)
        + await page.locator('.docx-paragraph.docx-role-heading, .docx-paragraph.docx-role-title').count();
      assert.deepEqual(chrome.sidebarTabs, name === 'sample.pdf' || richHeadings ? ['文件', '目录'] : ['文件'], `侧栏页签与文档是否带目录不符：${JSON.stringify({name, tabs: chrome.sidebarTabs, richHeadings, outlineItems})}`);
      if (name !== 'sample.pdf') assert.equal(outlineItems > 0, richHeadings > 0, `目录项应与文档中的标题同时出现：${JSON.stringify({name, richHeadings, outlineItems})}`);
      if (name === 'sample.pdf') {
        // PDF 打开即为双语两栏的原版排版；阅读器把页码、缩放等控件传送到工具栏槽位，目录托管在侧栏“目录”页。
        const viewer = page.locator('.pdf-layout-viewer');
        assert.equal(await viewer.getAttribute('data-pdf-presentation'), 'layout');
        assert.equal(await page.locator('[aria-label="阅读方式"]').getByRole('button', {name: '双语', exact: true}).getAttribute('aria-pressed'), 'true');
        await page.locator('.pdf-page-row[data-render-state="ready"] .pdf-page-column.translated canvas').first().waitFor();
        for (const selector of ['.reader-controls-slot .pdf-viewer-toolbar .pdf-page-navigation', '.reader-controls-slot .pdf-zoom-control .pdf-menu', '.reader-controls-slot .pdf-presentation-control.pdf-menu', '.reader-controls-slot .pdf-search', '.reader-controls-slot .pdf-style', '.document-taskbar .focus-toggle'])
          assert.equal(await page.locator(selector).count(), 1, `缺少 PDF 工具：${selector}`);
        assert.equal(await page.locator('.pdf-zoom-control select, .pdf-presentation-control select').count(), 0, '缩放与展示方式应为自定义菜单');
        assert.equal(await page.locator('.pdf-translation-block, .pdf-translation-spinner, .pdf-reading-sheet').count(), 0, '未翻译时译页只是原页副本');
        await sidebarTab('目录'); await page.locator('aside.document-sidebar nav.pdf-reader-outline.hosted .pdf-outline-item').first().waitFor();
        await sidebarTab('文件'); assert.equal(await page.locator('aside.document-sidebar section.document-batch .batch-files .batch-file').filter({hasText: name}).isVisible(), true, '文件列表应在侧栏“文件”页');
      }
      await page.getByRole('button', {name: '开始翻译', exact: true}).click();
      await status('翻译完成');
      assert.equal(await page.getByRole('progressbar', {includeHidden: true}).getAttribute('aria-valuenow'), '100');
      await page.getByRole('button', {name: '校订译文', exact: true}).click();
      assert.match(await page.locator('textarea.document-translation').first().inputValue(), /测试译文/);
      const editedSegment = await page.locator('.segment-edit-row').first().getAttribute('data-segment-id');
      await page.locator('textarea.document-translation').first().fill(`人工校订：${name}`);
      await page.getByRole('button', {name: '阅读', exact: true}).click();
      await noOverflow();
      if (name === 'sample.pdf') {
        // 译文不再画进图片：译页是原页画布副本，上面叠着每段一个 HTML 译文块；校订只改文字，不重新渲染页面。
        await page.locator('.pdf-page-column.translated .pdf-translation-block').first().waitFor();
        assert.equal(await page.locator('.pdf-page-row').count(), 2);
        assert.equal(await page.locator('.pdf-page-column.translated img').count(), 0, '译页不再是整页图片');
        const pdfPages = await page.evaluate(() => [...document.querySelectorAll('.pdf-page-row')].map(row => {
          const frame = row.querySelector('.pdf-page-column.translated .pdf-page-frame'), bounds = frame.getBoundingClientRect(), source = row.querySelector('.pdf-page-column:not(.translated) canvas'), copy = frame.querySelector('canvas[data-pdf-resource="translation"]');
          return {page: row.dataset.pageNumber, state: row.dataset.renderState, frame: {width: bounds.width, height: bounds.height}, sourceText: Boolean(row.querySelector('.pdf-page-column:not(.translated) [data-fluentread-pdf-text] span')),
            canvases: source && copy ? {source: [source.width, source.height], copy: [copy.width, copy.height]} : null, spinners: row.querySelectorAll('.pdf-translation-spinner').length, sheets: row.querySelectorAll('.pdf-reading-sheet').length,
            blocks: [...frame.querySelectorAll('.pdf-translation-layer[data-fluentread-pdf-translation] .pdf-translation-block')].map(block => {const rect = block.getBoundingClientRect(); return {segment: block.dataset.pdfSegmentIndex, id: block.dataset.pdfSourceId, source: block.dataset.pdfSourceText, role: block.dataset.pdfRole,
              text: [...block.querySelectorAll('.pdf-translation-text span')].map(line => line.textContent).join(''), left: rect.left - bounds.left, top: rect.top - bounds.top, right: rect.right - bounds.left, bottom: rect.bottom - bounds.top};})};
        }));
        const pdfSources = new Set(fixture.state.requests.slice(requestsBeforeLoad));
        for (const entry of pdfPages) {
          assert(entry.sourceText && entry.canvases && entry.canvases.source.join() === entry.canvases.copy.join(), `第 ${entry.page} 页应为原文画布+文字层与同尺寸的译页画布副本：${JSON.stringify(entry)}`);
          assert.equal(entry.spinners, 0, '翻译完成后不能残留等待动画'); assert.equal(entry.sheets, 0, '原版排版下不应出现重排续页'); assert(entry.blocks.length > 0, `第 ${entry.page} 页应有译文块`);
          for (const block of entry.blocks) {
            assert(pdfSources.has(block.source), `译文块的原文必须真实送往翻译服务：${block.source}`);
            assert.equal(compact(block.text), compact(block.segment === editedSegment ? `人工校订：${name}` : `测试译文：${block.source}`), `第 ${entry.page} 页片段 ${block.segment} 的译文块必须完整等于译文`);
            assert(block.left >= -2 && block.top >= -2 && block.right <= entry.frame.width + 2 && block.bottom <= entry.frame.height + 2, `译文块不能超出页面：${JSON.stringify({block, frame: entry.frame})}`);
          }
        }
        assert(pdfPages.flatMap(entry => entry.blocks).some(block => block.segment === editedSegment), '人工校订的片段应显示在译文块里');
        const blockSources = new Set(pdfPages.flatMap(entry => entry.blocks.map(block => block.source)));
        // “重排阅读”仍以 HTML 段落列出同一页的全部片段并标明角色；页眉页脚与元数据（footer/metadata）在阅读器里保留原文，因此在原版排版里没有译文块。
        await pdfPresentation('readable');
        await page.locator('.pdf-page-row[data-page-number="1"] .pdf-reading-sheet .pdf-reading-paragraph').first().waitFor(); await page.locator('.pdf-page-row[data-page-number="2"] .pdf-reading-sheet .pdf-reading-paragraph').first().waitFor();
        const readable = await page.locator('.pdf-reading-sheet .pdf-reading-paragraph').evaluateAll(elements => elements.map(element => ({segment: element.dataset.pdfSegmentIndex, source: element.dataset.pdfSourceText, role: element.dataset.pdfRole, text: element.textContent})));
        assert.equal(await page.locator('.pdf-translation-layer').count(), 0, '重排阅读不显示原版排版的译文层');
        const keptAsSource = new Set(readable.filter(entry => ['footer', 'metadata'].includes(entry.role)).map(entry => entry.source));
        for (const entry of readable) assert.equal(entry.text, keptAsSource.has(entry.source) ? entry.source : entry.segment === editedSegment ? `人工校订：${name}` : `测试译文：${entry.source}`, `重排阅读片段 ${entry.segment}（${entry.role}）内容不符`);
        for (const source of pdfSources) assert(blockSources.has(source) !== keptAsSource.has(source), `每个已翻译的正文段落都必须恰好有译文块，保留原文的页眉页脚不能有：${source}`);
        assert.deepEqual([...blockSources].sort(), readable.filter(entry => !keptAsSource.has(entry.source)).map(entry => entry.source).sort(), '原版排版的译文块应覆盖重排阅读里全部非页眉页脚片段');
        report.pdfKeptAsSource = [...keptAsSource];
        await pdfPresentation('layout'); await page.locator('.pdf-page-column.translated .pdf-translation-block').first().waitFor();
        assert.equal(await page.locator('.pdf-reading-sheet').count(), 0);
        report.pdfLayout = pdfPages.map(entry => ({page: entry.page, canvases: entry.canvases, blocks: entry.blocks.map(({segment, role, source}) => ({segment, role, source}))}));
        const translatedFrame = page.locator('.pdf-page-column.translated .pdf-page-frame').first();
        const beforeZoom = (await translatedFrame.boundingBox()).width;
        await pdfZoom('1.5');
        await page.waitForFunction(width => document.querySelector('.pdf-page-column.translated .pdf-page-frame').getBoundingClientRect().width > width * 1.4, beforeZoom).catch(() => {});
        assert((await translatedFrame.boundingBox()).width > beforeZoom * 1.4, 'PDF 放大必须实际改变页面尺寸');
        await pdfZoom('fit');
      }
      const dest = await download();
      recordScripts(`export:${name}`);
      const bytes = fs.readFileSync(dest);
      assert(bytes.length > 0);
      if (name === 'sample.pdf') {
        // 原版排版的双语下载：每个原页保留矢量内容，其后是同尺寸的原版面译文预览页，再接完整译文续页（不再是左右拼接的横向页）。
        const {PDFDocument} = require('pdf-lib'); const pdf = await PDFDocument.load(bytes);
        const sourceTexts = await pdfPageTexts(fs.readFileSync(path.join(exampleDir, name))), outputTexts = await pdfPageTexts(bytes);
        const originals = outputTexts.map((text, index) => ({index, text})).filter(entry => entry.text.trim());
        assert.deepEqual(originals.map(entry => entry.text), sourceTexts, '双语下载必须按顺序保留每个原页的可选文字');
        assert.equal(originals[0].index, 0, '下载文件应从原文第一页开始');
        for (const [order, original] of originals.entries()) {
          const next = originals[order + 1]?.index ?? pdf.getPageCount(), size = pdf.getPage(original.index).getSize();
          assert.deepEqual(size, {width: 612, height: 792}, '原页尺寸必须保持');
          assert(next - original.index >= 3, `每个原页后应有原版面译文页和至少一页完整译文续页：${JSON.stringify(originals.map(entry => entry.index))} / ${pdf.getPageCount()}`);
          assert.deepEqual(pdf.getPage(original.index + 1).getSize(), size, '原版面译文页与原页同尺寸');
        }
        report.pdfExport = {pages: pdf.getPageCount(), originalPageIndexes: originals.map(entry => entry.index), sizes: pdf.getPages().map(sheet => sheet.getSize())};
      } else if (name.endsWith('.epub') || name.endsWith('.docx')) {
        const zip = await require('jszip').loadAsync(bytes);
        assert(zip.file(name.endsWith('.epub') ? 'OEBPS/chapter-1.xhtml' : 'word/document.xml'));
        if (name.endsWith('.epub')) {
          // ePub 的章节列在侧栏目录里，当前章节有标记；正文上方不再有章节按钮。
          const chapters = await page.locator('.document-outline-item.chapter').evaluateAll(items => items.map(item => ({text: item.innerText.trim(), current: item.classList.contains('current')})));
          assert(chapters.length >= 1 && chapters.filter(chapter => chapter.current).length === 1, `ePub 目录应列出章节并标出当前章节：${JSON.stringify(chapters)}`);
          assert.equal(await page.locator('.rich-document-reader .reader-native-toolbar').count(), 0, 'ePub 正文上方不应再有章节按钮');
          report.epubOutline = chapters;
        }
      } else assert(bytes.toString().includes('人工校订'));
      report.exampleLoads[name] = {translated: true, edited: true, exported: true, bytes: bytes.length};
      if (['sample.pdf', 'sample.epub', 'sample.docx', 'sample.md', 'sample.srt', 'sample.json'].includes(name)) await shot(`reader-${name.replace('.', '-')}`);
      if (['formats', 'archives'].includes(suite) && name === formats.at(-1)) {
        if (await page.locator('.batch-files li').count() < 2) {
          await page.locator('input[type=file]').setInputFiles({name: 'batch-extra.txt', mimeType: 'text/plain', buffer: Buffer.from('An extra document.')});
          await page.locator('.workspace-heading h1').filter({hasText: 'batch-extra.txt'}).waitFor();
          await page.getByRole('button', {name: '翻译剩余文件', exact: true}).click();
          await page.waitForFunction(() => document.querySelectorAll('.batch-file small').length === 2 && [...document.querySelectorAll('.batch-file small')].every(element => element.textContent.includes('翻译完成')));
        }
        await sidebarTab('文件');
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
    if (suite === 'archives') {
      const JSZip = require('jszip');
      const {randomBytes} = require('node:crypto');
      const resource = randomBytes(4 * 1024 * 1024);
      for (const format of ['epub', 'docx']) {
        const zip = await JSZip.loadAsync(fs.readFileSync(path.join(exampleDir, `sample.${format}`)));
        const bodyPath = format === 'epub' ? 'OEBPS/chapter-1.xhtml' : 'word/document.xml';
        const resourcePath = format === 'epub' ? 'OEBPS/performance.bin' : 'word/media/performance.bin';
        const paragraphCount = format === 'epub' ? 2000 : 8000;
        const paragraphs = Array.from({length: paragraphCount}, (_, index) => {
          const source = `Archive paragraph ${index + 1}. ${randomBytes(96).toString('hex')}`;
          return format === 'epub' ? `<p>${source}</p>` : `<w:p><w:r><w:t>${source}</w:t></w:r></w:p>`;
        }).join('');
        const body = await zip.file(bodyPath).async('string');
        zip.file(bodyPath, body.replace(format === 'epub' ? /<body[^>]*>/u : /<w:body[^>]*>/u, opening => opening + paragraphs));
        zip.file(resourcePath, resource);
        const manifestPath = format === 'epub' ? 'OEBPS/content.opf' : '[Content_Types].xml';
        const manifest = await zip.file(manifestPath).async('string');
        zip.file(manifestPath, format === 'epub'
          ? manifest.replace('</manifest>', '<item id="performance" href="performance.bin" media-type="application/octet-stream"/></manifest>')
          : manifest.replace('</Types>', '<Default Extension="bin" ContentType="application/octet-stream"/></Types>'));
        const input = await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: {level: 3}});
        const name = `long-document.${format}`;
        await load(name, input);
        await page.getByRole('button', {name: '校订译文', exact: true}).click();
        const correction = `Large ${format} reviewed translation`;
        await page.locator('textarea.document-translation').first().fill(correction);
        await page.getByRole('button', {name: '阅读', exact: true}).click();
        await page.getByRole('button', {name: '下载文件 ↓', exact: true}).click();
        const dialog = page.locator('.download-dialog[open]');
        await dialog.getByRole('checkbox').check();
        await dialog.getByRole('button', {name: '下载双语文件', exact: true}).click();
        await dialog.locator('.export-progress').filter({hasText: '正在打包文件'}).waitFor();
        // 打包可能在对话框动画结束前就完成；不等待按钮位置稳定，按钮一出现就点击，避免与“已完成”竞争。
      await dialog.getByRole('button', {name: '取消生成', exact: true}).click({force: true});
        await dialog.locator('.export-progress').filter({hasText: '已取消生成'}).waitFor();
        assert.equal(await dialog.getByRole('button', {name: '下载双语文件', exact: true}).isEnabled(), true);
        await shot(`${format}-large-canceled`);
        await dialog.getByRole('button', {name: '返回文档', exact: true}).click();
        const start = Date.now();
        const dest = await download('translated', true);
        const output = await JSZip.loadAsync(fs.readFileSync(dest));
        const renderedBody = await output.file(bodyPath).async('string');
        assert(renderedBody.includes(correction));
        assert(renderedBody.includes(`Archive paragraph ${paragraphCount}.`), '部分翻译导出仍应保留末段原文');
        assert.deepEqual(await output.file(resourcePath).async('nodebuffer'), resource);
        if (format === 'epub') assert.equal(await output.file('mimetype').async('string'), 'application/epub+zip');
        report.exampleLoads[name] = {paragraphCount, inputBytes: input.length, outputBytes: fs.statSync(dest).size, retryElapsedMs: Date.now() - start, canceledDuringPackaging: true};
        await page.getByRole('button', {name: '校订译文', exact: true}).click();
        assert.equal(await page.locator('textarea.document-translation').first().inputValue(), correction);
        report.cases.push(`large ${format} packaging shows progress, cancels and retries with all paragraphs, binary resources and corrections intact`);
        await newFile();
      }
    }
    if (['formats', 'archives'].includes(suite)) {
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
    await openSettings();
    await page.locator('.document-settings-dialog[open]').getByRole('button', {name: '打开新文件', exact: true}).click();
    await page.locator('dialog[open]').getByRole('button', {name: '返回文档'}).click();
    assert.match(await page.locator('.workspace-heading h1').innerText(), /long-document/);
    await select('文档目标语言', '日本語 / Japanese / 日语');
    await page.locator('.document-taskbar .notice.warning.task-notice').filter({hasText: '设置已更改'}).waitFor();
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
    // 失败不再立刻中断：服务出错时自动退避重试（2 s、4 s……累计最多 120 s），工具栏下方浮出重试提示；已完成的片段保留，服务恢复后无需手动操作即可译完。
    const retryNotice = page.locator('.document-taskbar .taskbar-notices .task-notice').filter({hasText: '翻译服务暂时没有响应，将自动重试'});
    await retryNotice.waitFor();
    assert.match(await page.locator('.document-status').innerText(), /正在翻译/, '自动重试期间文档仍在翻译，不应显示翻译中断');
    await page.waitForFunction(() => document.querySelector('[role=progressbar][aria-label="文档翻译进度"]')?.getAttribute('aria-valuenow') === '66');
    assert.equal(await page.locator('.pause-button').count(), 1, '重试期间可以暂停');
    const failureRequests = fixture.state.requests.filter(source => source.includes('Failure target paragraph')).length;
    assert(failureRequests >= 1 && fixture.state.requests.filter(source => source.includes('A successful first paragraph')).length === 1, '重试只针对失败的片段，已完成的片段不重复请求');
    await shot('08-retrying');
    fixture.state.fail = false;
    await status('翻译完成');
    assert.equal(await retryNotice.count(), 0, '恢复后重试提示应消失');
    assert(fixture.state.requests.filter(source => source.includes('Failure target paragraph')).length > failureRequests, '失败片段应由自动重试再次请求');
    assert.equal(fixture.state.requests.filter(source => source.includes('A successful first paragraph')).length, 1);
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
    report.cases.push('service failure keeps completed work, shows the automatic-retry notice while still translating, recovers without user action, translated-only export works');
    // 本地历史：结果已下载、没有未保存内容时刷新不再询问，直接恢复当前文档与译文；离开文档后首页“最近翻译”列出它。
    await page.waitForTimeout(600);
    assert.match(await page.evaluate(() => sessionStorage.getItem('fluentread.document.open')), /^[0-9a-f]{32}$/u, '当前文档应记录在会话存储中');
    await page.evaluate(() => {globalThis.__beforeReload = true;});
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.locator('.workspace-heading h1').filter({hasText: 'replacement.txt'}).waitFor();
    assert.equal(await page.evaluate(() => globalThis.__beforeReload), undefined, '页面必须真的重新加载');
    assert.equal(await page.locator('.file-drop-zone').count(), 0, '刷新后应恢复文档而不是回到首页');
    await status('翻译完成');
    await page.getByRole('button', {name: '校订译文', exact: true}).click();
    assert.match(await page.locator('textarea.document-translation').first().inputValue(), /测试译文：A replacement document/);
    await page.getByRole('button', {name: '阅读', exact: true}).click();
    const restoreRequests = fixture.state.requests.length;
    await newFile();
    const historyEntry = page.locator('section.document-history .history-open').filter({hasText: 'replacement.txt'});
    await historyEntry.waitFor(); assert.match(await historyEntry.innerText(), /翻译完成/);
    assert.equal(fixture.state.requests.length, restoreRequests, '恢复与离开文档不得发送翻译请求');
    await shot('08b-landing-history');
    report.cases.push('reload restores the open document and its translations from local history without re-translating; landing page lists it under recent documents');
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
    // 持续失败的文件现在会自动重试（累计最多 120 s）而不是立即中断：批量队列停在它上面并显示重试提示，后面的文件仍在等待。
    await page.locator('.document-taskbar .taskbar-notices .task-notice').filter({hasText: '翻译服务暂时没有响应，将自动重试'}).waitFor();
    assert.match(await entries.nth(0).innerText(), /翻译完成/); assert.match(await entries.nth(2).innerText(), /正在翻译/); assert.match(await entries.nth(3).innerText(), /等待翻译/);
    assert.equal(await entries.nth(2).evaluate(element => element.classList.contains('selected')), true, '正在重试的文件应是当前文档');
    assert.equal(fixture.state.requests.filter(text => text.includes('Batch alpha first paragraph')).length, firstRequests, '续译不能重新请求已提交的片段');
    // 不等两分钟的重试预算：暂停后失败文件保持未完成，读者可以直接翻译队列里的其他文件。
    await page.getByRole('button', {name: '暂停全部', exact: true}).click();
    await status('已暂停');
    assert.equal(await page.locator('.document-taskbar .task-notice').filter({hasText: '将自动重试'}).count(), 0, '暂停后重试提示应消失');
    await entries.nth(3).locator('.batch-file').click();
    await page.locator('.workspace-heading h1').filter({hasText: 'same.txt'}).waitFor();
    await page.getByRole('button', {name: '开始翻译', exact: true}).click();
    await status('翻译完成');
    await page.getByRole('button', {name: '翻译剩余文件', exact: true}).waitFor();
    assert.match(await entries.nth(2).innerText(), /已暂停/);
    assert.match(await entries.nth(3).innerText(), /翻译完成/);
    report.cases.push('batch multi-select accepts mixed formats; invalid import does not block; a persistently failing file auto-retries with a notice, can be paused, and later files still translate; pause/resume retains completed segments');
    await entries.nth(0).locator('.batch-file').click();
    await page.getByRole('button', {name: '校订译文', exact: true}).click();
    await page.locator('textarea.document-translation').first().fill('批量文件人工校订');
    await entries.nth(3).locator('.batch-file').click();
    await page.getByRole('button', {name: '校订译文', exact: true}).click();
    assert.match(await page.locator('textarea.document-translation').first().inputValue(), /Batch omega/);
    await entries.nth(0).locator('.batch-file').click();
    await page.getByRole('button', {name: '校订译文', exact: true}).click();
    assert.equal(await page.locator('textarea.document-translation').first().inputValue(), '批量文件人工校订');
    await entries.nth(0).hover();
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
    report.cases.push('batch task switching preserves independent edits; removal protects undownloaded work; ZIP contains only completed files and preserves duplicate names; the paused failing file completes once the service recovers');
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
    // 在已打开的工作区再添加一份文件：新文件立即成为当前文档，侧栏切到“文件”页，且不会自动开始翻译。
    assert.match(await page.locator('.workspace-heading h1').innerText(), /drop-first.txt/, '一次添加多份时停在第一份');
    const requestsBeforeAdd = fixture.state.requests.length;
    await page.locator('aside.document-sidebar .sidebar-add-file').waitFor();
    await page.locator('input[type=file]').setInputFiles({name: 'added-later.txt', mimeType: 'text/plain', buffer: Buffer.from('A file added to the open workspace.')});
    await page.locator('.workspace-heading h1').filter({hasText: 'added-later.txt'}).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.batch-files li').length === 3);
    assert.match(await page.locator('.batch-files li.selected').innerText(), /added-later.txt/, '新添加的文件应成为当前文档');
    assert.equal(await page.locator('.sidebar-tabs [role="tab"]').filter({hasText: '文件'}).getAttribute('aria-selected'), 'true');
    assert.match(await page.locator('.document-status').innerText(), /准备就绪/); assert.equal(fixture.state.requests.length, requestsBeforeAdd, '添加文件不得自动开始翻译');
    await shot('12-added-file-current');
    report.cases.push('drag-and-drop imports every file and stays on the first; a file added to the open workspace becomes the current document without starting translation');
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
    report.cleanupErrors = [];
    let closed = false;
    if (launched) {
      try {await launched.close(); closed = true;}
      catch (error) {report.cleanupErrors.push(`session close: ${error.stack || error}`);}
    }
    try {await fixture?.close();} catch (error) {report.cleanupErrors.push(`fixture close: ${error.message}`);}
    if (profileDir) {
      if (closed) {
        try {fs.rmSync(profileDir, {recursive: true, force: true});}
        catch (error) {report.cleanupErrors.push(`profile removal: ${error.message}`); report.retainedProfile = profileDir;}
      } else if (!launchAttempted) {
        try {fs.rmdirSync(profileDir);}
        catch (error) {report.cleanupErrors.push(`profile removal: ${error.message}`); report.retainedProfile = profileDir;}
      } else report.retainedProfile = profileDir;
    }
    if (report.cleanupErrors.length) {report.ok = false; if ('status' in report) report.status = 'failed'; process.exitCode = 1;}
    try {fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));}
    catch (error) {console.error(error.stack || error); process.exitCode = 1;}
    console.log(JSON.stringify({ok: report.ok, cases: report.cases, report: path.join(artifactsDir, 'report.json'), failure: report.failure}, null, 2));
  }
}
main().catch(error => {console.error(error.stack || String(error)); process.exitCode = 1;});
