#!/usr/bin/env node
'use strict';

/**
 * @file scripts/testing/run-document-export-pages-test.cjs
 * 文件职责：在生产扩展与第二屏临时 Edge 中，验证文档页实际导出按钮的 PDF 页数与完整性。
 * 主要内容：真实导入 PDF、人工校订和下载，PDF.js 独立重开及逐页渲染；--outline-only 限定目录与目标页，--dialog-only 限定可视化版本选择与单一下载动作、未完成确认、排版选择、原文下载、主题与窄屏、错误与重试，不运行其它分页场景。
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
const dialogOnly = process.argv.includes('--dialog-only');
const encryptedInput = argument('encrypted-input');
assert(!encryptedInput || outlineOnly || dialogOnly, '--encrypted-input requires --outline-only or --dialog-only');
assert(!dialogOnly || encryptedInput, '--dialog-only requires the controlled --encrypted-input fixture');
const diagnosticsHelper = argument('runtime-diagnostics-helper');
assert(!(outlineOnly || dialogOnly) || diagnosticsHelper, 'Outline and dialog tests require --runtime-diagnostics-helper');
const diagnostics = diagnosticsHelper ? require(path.resolve(diagnosticsHelper)).createRuntimeDiagnostics() : undefined;
const requireRepo = createRequire(path.join(repository, 'package.json'));
const {chromium} = require(path.join(packages, 'playwright'));
const compact = text => text.normalize('NFKC').replace(/\s/gu, '');
const report = {ok: false, extensionDir, artifactKind: 'production', scope: 'document page actual PDF export button only',
  limitations: ['Translations are manual corrections entered through the real editor; no provider translation quality is covered.',
    `${dialogOnly ? 'Controlled one- and two-page PDF fixtures' : outlineOnly ? 'Controlled two-page PDFs with native and inferred headings' : 'Controlled one-page text PDFs'} only; no reporter file, public complex document, Firefox, Safari or physical mobile acceptance.`],
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
      await dialog.getByRole('radio', {name: mode === 'bilingual' ? '双语对照' : '仅译文', exact: true}).check();
      await shot(`${name}-download-panel`);
      const [item] = await Promise.all([page.waitForEvent('download', {timeout: 120000}), (async () => {
        await dialog.locator('.download-submit').click();
        const confirmation = dialog.locator('.download-confirmation');
        if (await confirmation.isVisible()) await confirmation.getByRole('button', {name: '下载当前结果', exact: true}).click();
      })()]);
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
      if (await dialog.isVisible()) await dialog.getByRole('button', {name: '关闭下载窗口', exact: true}).click();
      report.cases.push({name, ok: true, pageCount: sheets.length});
      return result;
    };
    if (dialogOnly) {
      report.scope = 'Visual version selection before a single download action, partial confirmation, progressive PDF layout, exact original bytes, anchored light/dark and narrow panel, failure and retry';
      const rows = await importPdf(short);
      await correct(rows.slice(0, 1), () => '首段校订保留。', 'partial-dialog');
      await page.locator('.taskbar-actions .download-button').click();
      let dialog = page.locator('.download-dialog[open]'); await dialog.waitFor();
      assert.equal(await dialog.locator('.download-version').count(), 2);
      assert.equal(await dialog.locator('.download-submit').count(), 1);
      assert.equal(await dialog.locator('.download-layout').evaluate(node => node.open), false);
      await dialog.getByRole('radio', {name:'双语对照',exact:true}).focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await dialog.getByRole('radio', {name:'仅译文',exact:true}).isChecked(), true);
      assert.equal(await dialog.locator('.download-confirmation').count(), 0, 'Choosing a version must not start a download');
      assert.equal(await dialog.locator('pre,.download-file-identity,.download-options').count(), 0);
      await dialog.screenshot({path:path.join(artifacts,'download-panel-preview.png'),animations:'disabled',scale:'css'});
      await dialog.locator('.download-layout > summary').click();
      const layoutGroup = dialog.getByRole('radiogroup', {name: 'PDF 排版', exact: true});
      await layoutGroup.getByRole('radio', {name: '保留原版', exact: true}).focus();
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => document.querySelector('.download-layout [role=radio][aria-checked=true]')?.textContent.trim() === '重新排版');
      assert.equal(await page.locator('[data-document-reader="pdf"]').getAttribute('data-pdf-presentation'), 'layout');
      await dialog.locator('.download-submit').click();
      await dialog.locator('.download-confirmation').waitFor();
      assert.equal(await dialog.locator('input[type=checkbox]').count(), 0);
      assert.equal(await dialog.locator('button:focus').textContent(), '返回');
      await dialog.screenshot({path: path.join(artifacts, 'partial-download-confirmation.png')});
      await dialog.getByRole('button', {name: '返回', exact: true}).click();
      assert((await dialog.locator('.download-layout-value').textContent()).includes('重新排版'));
      assert.equal(await dialog.getByRole('radio', {name:'仅译文',exact:true}).isChecked(), true);
      await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'});
      await page.waitForFunction(() => document.querySelector('.download-button')?.getAttribute('aria-expanded') === 'false');
      assert.equal(await page.locator('.download-button').evaluate(node => node === document.activeElement), true);
      await page.locator('.taskbar-actions .download-button').click(); await dialog.waitFor();
      assert.equal(await dialog.locator('.download-confirmation').count(), 0);
      assert((await dialog.locator('.download-layout-value').textContent()).includes('保留原版'));
      assert.equal(await dialog.locator('.download-layout').evaluate(node => node.open), false);
      const original = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', {name: '下载原文', exact: true}).click()]);
      const originalPath = path.join(artifacts, 'exact-original.pdf'); await original[0].saveAs(originalPath);
      assert(fs.readFileSync(originalPath).equals(short.bytes), 'Original shortcut must keep exact source bytes');
      await dialog.waitFor({state:'hidden'});
      await page.locator('.taskbar-actions .download-button').click(); await dialog.waitFor();
      await page.mouse.click(16, 400); await dialog.waitFor({state:'hidden'});
      report.cases.push({name: 'partial-confirmation-independent-layout-original-bytes-escape-outside-click', ok: true});
      const shortEntries = await correct(rows, row => `第${row.id + 1}段校订保留。`, 'complete-dialog');
      await download('download-panel-direct-bilingual', 'layout', 'bilingual', shortEntries, 1);
      await page.close(); page = await helper.newPageWithoutForeground(context, 30000); page.setDefaultTimeout(30000);
      await diagnostics.attachPage(page, 'download-dialog-protected');
      await page.goto(`${origin}/document.html`); await page.locator('.file-drop-zone').waitFor();
      const input = {name: '一份文件名较长的研究资料-用于验证下载文件名不会超出窗口-protected.pdf', bytes: fs.readFileSync(encryptedInput)};
      const protectedRows = await importPdf(input);
      const entries = await correct(protectedRows, row => `第${row.id + 1}段校订内容保留。`, 'protected-dialog');
      await page.locator('.taskbar-actions .download-button').click(); dialog = page.locator('.download-dialog[open]'); await dialog.waitFor();
      const metrics = async name => {
        await page.waitForFunction(() => {const node = document.querySelector('.download-dialog[open]');if (!node) return false;const r = node.getBoundingClientRect();return r.left >= 11 && r.top >= 11 && r.right <= innerWidth - 11 && r.bottom <= innerHeight - 11;});
        const result = await dialog.evaluate(node => {const r = node.getBoundingClientRect();return {width:r.width,height:r.height,left:r.left,top:r.top,right:r.right,bottom:r.bottom,viewportWidth:innerWidth,viewportHeight:innerHeight,horizontalOverflow:node.scrollWidth-node.clientWidth,verticalOverflow:node.scrollHeight-node.clientHeight};});
        assert(result.width <= 360.5 && result.width <= result.viewportWidth - 23, 'Panel must remain compact and fit the viewport');
        assert(result.height <= result.viewportHeight - 23 && result.horizontalOverflow <= 1, 'Panel must fit without horizontal overflow');
        assert(result.left >= 11 && result.top >= 11 && result.right <= result.viewportWidth - 11 && result.bottom <= result.viewportHeight - 11, 'Panel must remain inside viewport after reflow');
        await dialog.screenshot({path: path.join(artifacts, `${name}.png`),animations:'disabled',scale:'css'});
        report.cases.push({name, ok:true, ...result});
      };
      await metrics('download-panel-light');
      await dialog.locator('.download-layout > summary').click();
      await metrics('download-panel-layout-expanded');
      await dialog.locator('.download-layout > summary').click();
      await page.screenshot({path:path.join(artifacts,'download-panel-context.png')});
      const backdrop = await dialog.evaluate(node => ({color:getComputedStyle(node,'::backdrop').backgroundColor,filter:getComputedStyle(node,'::backdrop').backdropFilter}));
      assert.equal(backdrop.color,'rgba(0, 0, 0, 0)'); assert.equal(backdrop.filter,'none');
      report.backdrop=backdrop;
      await page.emulateMedia({colorScheme:'dark'}); await page.locator('.document-app.dark').waitFor();
      assert.notEqual(await dialog.evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(255, 255, 255)');
      await metrics('download-panel-dark');
      await page.setViewportSize({width:390,height:740}); await metrics('download-panel-dark-narrow');
      await page.emulateMedia({colorScheme:'light'}); await page.locator('.document-app:not(.dark)').waitFor();
      await page.setViewportSize({width:320,height:568}); await metrics('download-panel-small');
      await page.setViewportSize({width:390,height:280}); await metrics('download-panel-short');
      await dialog.getByRole('button',{name:'下载原文',exact:true}).focus();
      const footer = await dialog.evaluate(node => {const button=node.querySelector('.download-original');const r=node.getBoundingClientRect(),b=button.getBoundingClientRect();return {focused:button===document.activeElement,inside:b.top>=r.top && b.bottom<=r.bottom,scrollTop:node.scrollTop};});
      assert(footer.focused && footer.inside && footer.scrollTop > 0, 'Keyboard focus must reveal the original-download shortcut in a short viewport');
      Object.assign(report.cases[report.cases.length-1],{footerReachable:true,scrollTop:footer.scrollTop});
      await dialog.screenshot({path:path.join(artifacts,'download-panel-short-scrolled.png'),animations:'disabled',scale:'css'});
      await page.setViewportSize({width:390,height:740});
      let languageSequence = 0;
      const setLanguage = async language => {
        await page.evaluate(async ({language, sequence}) => {
          const read = await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'});
          const config = typeof read.value === 'string' ? JSON.parse(read.value) : read.value;
          const result = await chrome.runtime.sendMessage({type:'persistConfig',mode:'replace',config:{...config,uiLanguage:language,uiLanguageSetupCompleted:true},clientId:'download-panel-language',sequence,baseRevision:config.__fluentConfigRevision || 0});
          if (!result.success) throw new Error(result.error);
        }, {language, sequence: ++languageSequence});
      };
      await setLanguage('en-US');
      await dialog.getByRole('button',{name:'Download bilingual file',exact:true}).waitFor();
      await metrics('download-panel-english');
      await setLanguage('fr-FR');
      await dialog.getByRole('button',{name:'Télécharger le fichier bilingue',exact:true}).waitFor();
      await metrics('download-panel-french');
      await setLanguage('zh-CN');
      await dialog.getByRole('button',{name:'下载双语文件',exact:true}).waitFor();
      await page.setViewportSize({width:1440,height:960});
      await dialog.locator('.download-submit').click();
      const failure = dialog.locator('.download-failure'); await failure.waitFor();
      assert((await failure.getByRole('alert').textContent()).includes('原文件受保护'));
      assert(!(await failure.getByRole('alert').textContent()).includes('PDFDocument'));
      assert.equal(await failure.locator('details').evaluate(node => node.open), false);
      assert.equal(await failure.locator('pre').isVisible(), false);
      assert.equal(await dialog.getByRole('button',{name:'重试下载',exact:true}).isEnabled(),true);
      await metrics('download-panel-error');
      await failure.locator('summary').click(); assert((await failure.locator('pre').textContent()).includes('PDFDocument.load'));
      await metrics('download-panel-error-details');
      await failure.locator('summary').click();
      await page.setViewportSize({width:390,height:740}); await metrics('download-panel-narrow-error');
      await page.setViewportSize({width:1440,height:960});
      await dialog.getByRole('button', {name:'关闭下载窗口',exact:true}).click();
      await download('download-panel-direct-translated-retry', 'layout', 'translated', entries, 2);
    } else if (outlineOnly) {
      report.scope = encryptedInput ? 'Protected PDF translated download with detected-heading outline fallback' : 'PDF native and detected chapter outlines through actual download buttons';
      for (const native of encryptedInput ? [false] : [true, false]) {
        const input = encryptedInput ? {name: path.basename(encryptedInput), file: path.resolve(encryptedInput), bytes: fs.readFileSync(encryptedInput)} : await outlineFixture(native);
        if (encryptedInput) report.encryptedInput = {file: input.file, sha256: crypto.createHash('sha256').update(input.bytes).digest('hex')};
        const rows = await importPdf(input);
        const titles = {'1 Introduction': '第一章 导言', '1.1 Details': '第一节 细节', '2 Conclusion': '第二章 总结'};
        const entries = await correct(rows, row => titles[row.source] || (row.source.includes('before') ? '完整译文用于验证重排后目录的真实落点。'.repeat(250) : '正文译文完整保留。'), `${native ? 'native' : 'detected'}-chapters`);
        const expected = ['第一章 导言', '第一节 细节', '第二章 总结', ...(native ? ['Native appendix'] : [])];
        for (const [kind, mode] of encryptedInput ? [['layout', 'translated']] : [['layout', 'bilingual'], ['layout', 'translated'], ['readable', 'translated']]) {
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
