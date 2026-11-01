#!/usr/bin/env node
'use strict';

/**
 * @file scripts/testing/run-document-export-pages-test.cjs
 * 文件职责：在生产扩展与第二屏临时 Edge 中，验证文档页实际导出按钮的 PDF 页数与完整性。
 * 主要内容：真实导入 PDF、人工校订和下载，PDF.js 独立重开及逐页渲染；--outline-only 限定章节书签、标题回退、层级、双语和重排落点，不运行其它分页场景。
 * 模块边界：只写本轮临时 profile 的人工校订和真实仓库字体缓存，不调用或模拟翻译供应商，不操作用户浏览器。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {pathToFileURL} = require('node:url');
const {createRequire} = require('node:module');
const helper = require('./focus-safe-browser.cjs');
const argument = (name, fallback) => {const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1];};
const repository = path.resolve(__dirname, '../..');
const packages = path.resolve(argument('playwright-root', path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules')));
const extensionDir = path.resolve(argument('extension-dir', '.output/chrome-mv3'));
const artifacts = path.resolve(argument('artifacts-dir', '/private/tmp/fluentread-document-export-pages'));
const outlineOnly = process.argv.includes('--outline-only');
const diagnosticsHelper = argument('runtime-diagnostics-helper');
assert(!outlineOnly || diagnosticsHelper, '--outline-only requires --runtime-diagnostics-helper');
const diagnostics = diagnosticsHelper ? require(path.resolve(diagnosticsHelper)).createRuntimeDiagnostics() : undefined;
const requireRepo = createRequire(path.join(repository, 'package.json'));
const {chromium} = require(path.join(packages, 'playwright'));
const compact = text => text.normalize('NFKC').replace(/\s/gu, '');
const report = {ok: false, extensionDir, artifactKind: 'production', scope: 'document page actual PDF export button only',
  limitations: ['Translations are manual corrections entered through the real editor; no provider translation quality is covered.',
    `${outlineOnly ? 'Controlled two-page PDFs with native and inferred headings' : 'Controlled one-page text PDFs'} only; no reporter file, public complex document, Firefox, Safari or physical mobile acceptance.`],
  cases: [], corrections: [], downloads: [], screenshots: [], consoleErrors: [], workerErrors: [], blockedRequests: [], cleanupErrors: []};
fs.mkdirSync(artifacts, {recursive: true});
function fingerprint(directory) {
  const files = [];
  const visit = relative => {for (const entry of fs.readdirSync(path.join(directory, relative), {withFileTypes: true})) {
    const file = path.join(relative, entry.name); if (entry.isDirectory()) visit(file); else if (entry.isFile()) files.push(file);
  }};
  visit(''); const hash = crypto.createHash('sha256');
  for (const file of files.sort()) hash.update(file).update(fs.readFileSync(path.join(directory, file)));
  return {sha256: hash.digest('hex'), fileCount: files.length, manifest: JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))};
}
async function fixture(name, count) {
  const {PDFDocument, StandardFonts} = requireRepo('pdf-lib');
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595, 842]), sources = [];
  for (let i = 0; i < count; i++) {
    const source = `Source paragraph ${i + 1}: preserve every original word in this page.`;
    page.drawText(source, {x: 44, y: 730 - i * 230, size: 12, font}); sources.push(source);
  }
  const file = path.join(artifacts, name), bytes = Buffer.from(await pdf.save()); fs.writeFileSync(file, bytes);
  return {name, file, sources, bytes};
}
async function outlineFixture(native) {
  const {PDFDocument, PDFName, PDFHexString} = requireRepo('pdf-lib');
  const pdf = await PDFDocument.create(), first = pdf.addPage([600, 800]), second = pdf.addPage([600, 800]);
  first.drawText('1 Introduction', {x: 44, y: 730, size: 24});
  first.drawText('Source body before the next section.', {x: 44, y: 680, size: 12});
  first.drawText('1.1 Details', {x: 44, y: 440, size: 20});
  first.drawText('Source details paragraph.', {x: 44, y: 390, size: 12});
  second.drawText('2 Conclusion', {x: 44, y: 730, size: 24});
  second.drawText('Source final paragraph.', {x: 44, y: 680, size: 12});
  if (native) {
    const root = pdf.context.obj({Type: 'Outlines'}), rootRef = pdf.context.register(root);
    const refs = ['1 Introduction', '1.1 Details', '2 Conclusion', 'Native appendix'].map((title, index) => pdf.context.register(pdf.context.obj({
      Title: PDFHexString.fromText(title), Parent: rootRef, Dest: [index < 2 ? first.ref : second.ref, PDFName.of('Fit')],
    })));
    root.set(PDFName.of('First'), refs[0]); root.set(PDFName.of('Last'), refs[3]);
    const chapter = pdf.context.lookup(refs[0]); chapter.set(PDFName.of('First'), refs[1]); chapter.set(PDFName.of('Last'), refs[1]); chapter.set(PDFName.of('Next'), refs[2]);
    pdf.context.lookup(refs[1]).set(PDFName.of('Parent'), refs[0]); pdf.context.lookup(refs[2]).set(PDFName.of('Next'), refs[3]);
    pdf.catalog.set(PDFName.of('Outlines'), rootRef);
  }
  const name = native ? 'native-chapters.pdf' : 'detected-chapters.pdf', file = path.join(artifacts, name), bytes = Buffer.from(await pdf.save());
  fs.writeFileSync(file, bytes); return {name, file, bytes};
}
async function main() {
  assert(fs.existsSync(path.join(extensionDir, 'manifest.json')), 'A prebuilt production extension is required');
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-document-pages-'));
  let session, page, closed = false, launchAttempted = false;
  try {
    report.productionFingerprint = fingerprint(extensionDir);
    const short = await fixture('one-page-short.pdf', 3), single = await fixture('one-page-single.pdf', 1);
    report.fixtures = [short, single].map(({name, file, sources, bytes}) => ({name, file, sources, bytes: bytes.length, pageCount: 1}));
    launchAttempted = true;
    session = await helper.launchFocusSafePersistentContext({chromium, profileDir,
      browserPath: argument('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      background: true, headless: false, displayTarget: 'secondary', viewport: {width: 1440, height: 960}, timeout: 30000,
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking']});
    Object.assign(report, {launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement});
    assert.equal(session.windowPlacement.browserFrontmost, false);
    const context = session.context;
    if (diagnostics) await diagnostics.start(context);
    await context.route('**/*', route => {
      const url = route.request().url();
      if (/^https?:/u.test(url)) {report.blockedRequests.push(url); return route.abort();}
      return route.continue();
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 30000});
    worker.on('console', message => {if (message.type() === 'error') report.workerErrors.push(message.text());});
    const origin = `chrome-extension://${new URL(worker.url()).host}`;
    diagnostics?.setExtensionId(new URL(worker.url()).host);
    page = await helper.newPageWithoutForeground(context, 30000); page.setDefaultTimeout(30000);
    if (diagnostics) await diagnostics.attachPage(page, 'pdf-export-document');
    page.on('pageerror', error => report.consoleErrors.push(error.message));
    page.on('console', message => {if (message.type() === 'error') report.consoleErrors.push(message.text());});
    page.on('dialog', dialog => {if (dialog.type() === 'beforeunload') void dialog.accept(); else void dialog.dismiss();});
    await page.goto(`${origin}/document.html`);
    await page.locator('.file-drop-zone').waitFor();
    await page.evaluate(async () => {
      const read = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      const current = typeof read.value === 'string' ? JSON.parse(read.value) : read.value;
      const result = await chrome.runtime.sendMessage({type: 'persistConfig', mode: 'replace', config: {...current, uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true},
        clientId: 'document-export-pages', sequence: 1, baseRevision: current.__fluentConfigRevision || 0});
      if (!result.success) throw new Error(result.error);
    });
    await page.reload(); await page.locator('.file-drop-zone').waitFor();
    // 使用生产字体摘要/缓存键，不改变导出器或结果；离线测试不下载可选字体。
    const font = fs.readFileSync(path.join(repository, 'assets/pdf-fonts/FluentReadNotoSansSC-Regular.woff2'));
    const fontSha = crypto.createHash('sha256').update(font).digest('hex');
    assert(fs.readFileSync(path.join(repository, 'src/features/document-translation/services/pdfReadingFont.ts'), 'utf8').includes(`PDF_READING_FONT_SHA256 = '${fontSha}'`));
    await page.evaluate(async ({base64, sha}) => {
      const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
      const cache = await caches.open('fluentread-pdf-reading-font-v1');
      await cache.put(`https://fluentread.app/__optional_assets__/pdf-font/${sha}.woff2`, new Response(bytes, {headers: {'Content-Type': 'font/woff2'}}));
    }, {base64: font.toString('base64'), sha: fontSha});
    report.readingFont = {sha256: fontSha, bytes: font.length, source: 'Verified actual repository font cached in the isolated profile'};
    const pdfjs = await import(pathToFileURL(path.join(packages, 'pdfjs-dist/legacy/build/pdf.mjs')).href);
    const {createCanvas} = require(path.join(packages, '@napi-rs/canvas'));
    const shot = async name => {const file = path.join(artifacts, `${name}.png`); await page.screenshot({path: file}); report.screenshots.push(file);};
    const showEdit = async () => {await page.locator('.reader-tabs button').nth(1).click(); await page.locator('.segment-editor').waitFor();};
    const showRead = async () => {await page.locator('.reader-tabs button').first().click(); await page.locator('[data-pdf-scroll]').waitFor();};
    const importPdf = async input => {
      await page.locator('input[type=file]').setInputFiles({name: input.name, mimeType: 'application/pdf', buffer: input.bytes});
      await page.locator('.workspace-heading h1').filter({hasText: input.name}).waitFor();
      await page.locator('.pdf-page-row[data-render-state="ready"]').first().waitFor(); await showEdit();
      return page.locator('.segment-edit-row[data-segment-id]').evaluateAll(nodes => nodes.map(node => ({id: Number(node.dataset.segmentId), source: node.querySelector('.document-source').textContent})));
    };
    const correct = async (rows, makeText, name) => {
      await showEdit(); const entries = [];
      for (const row of rows) {
        const value = makeText(row); const editor = page.locator(`.segment-edit-row[data-segment-id="${row.id}"] textarea`);
        await editor.fill(value); await editor.blur();
        const actual = await editor.inputValue();
        const normalized = value.replace(/\r\n?/gu, '\n');
        entries.push({...row, requested: value, actual, uiTrimmed: actual.replace(/\r\n?/gu, '\n') !== normalized, uiLineEndingsNormalized: actual !== value && actual === normalized});
        assert.equal(actual.replace(/\r\n?/gu, '\n'), normalized, 'Real manual-correction editor must retain controlled boundary blank lines');
      }
      report.corrections.push({name, entries}); await shot(`${name}-editor`); await showRead(); return entries;
    };
    const presentation = async value => {
      const menu = page.locator('.pdf-presentation-control.pdf-menu');
      await menu.locator('.pdf-menu-button').click(); await menu.locator(`button[role="option"][data-value="${value}"]`).click();
      await page.locator(`.pdf-layout-viewer[data-pdf-presentation="${value}"]`).waitFor();
    };
    const download = async (name, kind, mode, entries, expectedPages) => {
      await presentation(kind); await page.locator('.taskbar-actions .download-button').click();
      const dialog = page.locator('.download-dialog[open]'); await dialog.waitFor();
      await dialog.locator('.export-options button').nth(mode === 'bilingual' ? 0 : 1).click();
      const partial = dialog.locator('.partial-export input'); if (await partial.isVisible()) await partial.check();
      await shot(`${name}-download-dialog`);
      const [item] = await Promise.all([page.waitForEvent('download', {timeout: 120000}), dialog.locator('.dialog-actions .translate-document-button').click()]);
      const file = path.join(artifacts, `${name}.pdf`); await item.saveAs(file); assert.equal(await item.failure(), null);
      const task = pdfjs.getDocument({data: new Uint8Array(fs.readFileSync(file)), isEvalSupported: false, useWorkerFetch: false, verbosity: 0,
        standardFontDataUrl: path.join(packages, 'pdfjs-dist/standard_fonts') + path.sep});
      const sheets = [], chapters = [];
      try {
        const pdf = await task.promise, labels = await pdf.getPageLabels();
        const collect = async (items, level = 1) => {for (const item of items) {
          const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
          chapters.push({title: item.title, level, page: await pdf.getPageIndex(dest[0]) + 1, x: dest[2], y: dest[3]});
          await collect(item.items, level + 1);
        }};
        await collect(await pdf.getOutline() || []);
        for (let number = 1; number <= pdf.numPages; number++) {
          const sheet = await pdf.getPage(number), text = (await sheet.getTextContent()).items.map(item => item.str || '').join('\n');
          const viewport = sheet.getViewport({scale: 1}), canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await sheet.render({canvasContext: canvas.getContext('2d'), viewport}).promise;
          const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          let inkPixels = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] && Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 235) inkPixels++;
          const png = file.replace(/\.pdf$/u, `-page-${number}.png`); fs.writeFileSync(png, canvas.toBuffer('image/png'));
          sheets.push({number, label: labels?.[number - 1] ?? null, width: viewport.width, height: viewport.height, text, inkPixels, png});
        }
      } finally {await task.destroy();}
      const result = {name, kind, mode, file, pages: sheets.length, sheets, chapters}; report.downloads.push(result);
      fs.writeFileSync(file.replace(/\.pdf$/u, '.text.json'), JSON.stringify(sheets, null, 2));
      // 页脚只在各自页面剔除；跨页拼接后再匹配会把下一页数字开头的章节编号吞进分母。
      const whole = sheets.map(sheet => compact(sheet.text).replace(/原文第\d+页·译文续页·?\d+\/\d+/gu, '')).join('');
      for (const correction of entries) assert(whole.includes(compact(correction.actual)), `${name}: complete correction ${correction.id} must survive`);
      if (mode === 'bilingual') for (const correction of entries) assert(whole.includes(compact(correction.source)), `${name}: complete original ${correction.id} must survive`);
      assert(!/工作区|工作空间|下载文件|打开新文件|服务连接设置|Document workspace/iu.test(whole), `${name}: document UI must not enter exported PDF`);
      for (const sheet of sheets) {
        const content = compact(sheet.text).replace(/原文第\d+页·译文续页·?\d+\/\d+/gu, '');
        assert(content && sheet.inkPixels > 100, `${name}: exported page ${sheet.number} must contain body content`);
      }
      if (expectedPages) assert.equal(sheets.length, expectedPages, `${name}: no extra blank or continuation page`);
      else assert(sheets.length > 1, `${name}: genuine overflow must create readable continuation pages`);
      if (await dialog.isVisible()) await dialog.getByRole('button', {name: '返回文档', exact: true}).click();
      report.cases.push({name, ok: true, pageCount: sheets.length});
      return result;
    };
    if (outlineOnly) {
      report.scope = 'PDF native and detected chapter outlines through actual download buttons';
      for (const native of [true, false]) {
        const input = await outlineFixture(native);
        const rows = await importPdf(input);
        const titles = {'1 Introduction': '第一章 导言', '1.1 Details': '第一节 细节', '2 Conclusion': '第二章 总结'};
        const entries = await correct(rows, row => titles[row.source] || (row.source.includes('before') ? '完整译文用于验证重排后目录的真实落点。'.repeat(250) : '正文译文完整保留。'), `${native ? 'native' : 'detected'}-chapters`);
        const expected = ['第一章 导言', '第一节 细节', '第二章 总结', ...(native ? ['Native appendix'] : [])];
        for (const [kind, mode] of [['layout', 'bilingual'], ['layout', 'translated'], ['readable', 'translated']]) {
          const result = await download(`${native ? 'native' : 'detected'}-outline-${kind}-${mode}`, kind, mode, entries);
          assert.deepEqual(result.chapters.map(item => item.title), expected);
          assert.equal(result.chapters[1].level, 2);
          for (const chapter of result.chapters.filter(item => item.title !== 'Native appendix')) assert(compact(result.sheets[chapter.page - 1].text).includes(compact(chapter.title)), 'Bookmark must target the page actually containing its translated heading');
          if (kind === 'layout' && mode === 'bilingual') assert(result.chapters.slice(0, 3).every(item => item.x > 600), 'Bilingual bookmark must target the translated side');
          if (kind === 'readable') assert(result.chapters[1].page > result.chapters[0].page, 'Long body must move the next heading to a later reflow page');
        }
        // 隔离下一次导入的队列和会话状态；采集器在新页导航前继续附着。
        await page.close(); page = await helper.newPageWithoutForeground(context, 30000); page.setDefaultTimeout(30000);
        if (diagnostics) await diagnostics.attachPage(page, 'pdf-export-document-next');
        await page.goto(`${origin}/document.html`); await page.locator('.file-drop-zone').waitFor();
      }
    } else {
    const shortRows = await importPdf(short); assert.equal(shortRows.length, 3, 'Three separate source paragraphs must be parsed');
    const shortCorrections = await correct(shortRows, row => `\n\n短译文第${row.id + 1}段完整保留。\n \t\n`, 'short-whitespace');
    await download('short-layout-bilingual', 'layout', 'bilingual', shortCorrections, 1);
    await download('short-layout-translated', 'layout', 'translated', shortCorrections, 1);
    // 独立后台页签不继承上一个页签的 sessionStorage，避免把队列/会话恢复混入分页专项。
    await page.close(); page = await helper.newPageWithoutForeground(context, 30000); page.setDefaultTimeout(30000);
    page.on('pageerror', error => report.consoleErrors.push(error.message));
    page.on('console', message => {if (message.type() === 'error') report.consoleErrors.push(message.text());});
    await page.goto(`${origin}/document.html`);
    await page.locator('.file-drop-zone').waitFor();
    const singleRows = await importPdf(single); assert.equal(singleRows.length, 1);
    const lines = await correct(singleRows, () => '译文\n'.repeat(36) + ' \t\r\n\r\n', 'readable-36-lines');
    await download('readable-36-lines-translated', 'readable', 'translated', lines, 1);
    const long = await correct(singleRows, () => '完整长译文必须跨页保留，每个字都能重新读取且末段完整。'.repeat(700) + '长译文终点标记玖零。', 'genuine-long');
    await download('long-layout-translated', 'layout', 'translated', long);
    }
    if (diagnostics) {await diagnostics.flush(); diagnostics.assertClean();}
    assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.workerErrors, []); assert.deepEqual(report.blockedRequests, []);
    report.ok = true;
  } catch (error) {report.failure = String(error.stack || error); process.exitCode = 1; if (page) await page.screenshot({path: path.join(artifacts, 'failure.png')}).catch(() => {});}
  finally {
    if (diagnostics) {
      await diagnostics.flush(); report.runtimeDiagnostics = diagnostics.snapshot();
      fs.writeFileSync(path.join(artifacts, 'runtime-diagnostics.json'), JSON.stringify(report.runtimeDiagnostics, null, 2));
      await diagnostics.stop();
    }
    if (session) try {await session.close(); closed = true;} catch (error) {report.cleanupErrors.push(error.message);}
    if (closed || !launchAttempted) fs.rmSync(profileDir, {recursive: true, force: true}); else report.retainedProfile = profileDir;
    if (report.cleanupErrors.length) {report.ok = false; process.exitCode = 1;}
    fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify({ok: report.ok, report: path.join(artifacts, 'report.json'), cases: report.cases, failure: report.failure, cleanupErrors: report.cleanupErrors}, null, 2));
}
main().catch(error => {console.error(error); process.exitCode = 1;});
