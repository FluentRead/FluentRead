#!/usr/bin/env node
'use strict';

/**
 * @file scripts/testing/run-pro-document-ui-test.cjs
 * 文件职责：只在临时后台 Edge 中验收专业文档的人工校订、原位全文、迁移与实际 PDF 下载。
 * 主要内容：生成三页受控 PDF，经生产 UI 填写人工校订，并打开真实 Word/EPUB 校订后刷新；校验原生 dialog、搜索、响应式、刷新与受控旧快照迁移，检查下载的 Unicode 全文、页序和 Poppler 渲染证据。
 * 模块边界：不构建扩展、不调用或模拟翻译供应商、不操作用户 profile 或日常页面；仅迁移本轮临时 profile 的 IndexedDB 旧结构。字体缓存使用仓库真实字体，绝不注入生产导出结果。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');
const {pathToFileURL} = require('node:url');
const {createHash} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground, queryMacFrontmostApplication} = require('./focus-safe-browser.cjs');
const {getGuardedBrowserPid} = require('./owned-browser-close.cjs');
const repository = path.resolve(__dirname, '../..');
const requireRepo = createRequire(path.join(repository, 'package.json'));
const arg = name => {const index = process.argv.indexOf(`--${name}`); return index < 0 ? undefined : process.argv[index + 1];};
const compact = text => text.replace(/\s/gu, '');
const FIXTURE = 'controlled-pro-document.pdf';
const REPEAT = 'Repeated professional statement has a separate review on each page.';
const METADATA = 'controlled.author@example.org';
const CONTINUATION_FROM = 'A continuous paragraph ends in unfin-';
const CONTINUATION_TO = 'ished without deleting the source hyphen; this continues the same paragraph.';
const LONG_END = '长译文终点标记玖零';
function productionFingerprint(directory) {
    const files = [];
    const visit = relative => {for (const entry of fs.readdirSync(path.join(directory, relative), {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(relative, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (entry.isFile()) {const bytes = fs.readFileSync(path.join(directory, file)); files.push({path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')});}
    }};
    visit('');
    return {algorithm: 'SHA-256', files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex')};
}
const LONG_TEXT = '🦄🔬这是一段通过真实校订界面填写的受控长译文。跨页段落、脚注、复杂图表与公式必须保全，不能因为版面空间不足而截断。'.repeat(35) + LONG_END;

async function makeControlledPdf(file) {
    const {PDFDocument, StandardFonts, rgb, degrees} = requireRepo('pdf-lib');
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    pdf.setTitle('Controlled professional document — manual proofreading acceptance');
    for (let number = 1; number <= 3; number++) {
        const page = pdf.addPage([595, 842]);
        const draw = (text, x, y, size = 11, weight = font) => page.drawText(text, {x, y, size, font: weight});
        if (number === 2) draw(CONTINUATION_TO, 42, 770);
        draw(`Controlled professional document ${number}`, 42, number === 2 ? 730 : 782, 20, bold);
        if (number === 1) draw(METADATA, 42, 752, 10);
        draw(`${number} Professional reading`, 42, 705, 16, bold);
        draw(`Source page ${number} marker preserves native page order.`, 42, 669);
        draw('Body paragraphs must remain selectable and searchable.', 42, 650);
        if (number === 1) {
            draw('Long paragraph target requires complete reviewed translation.', 42, 604);
            draw('The complete ending must remain available in every export.', 42, 590);
            draw('A following paragraph limits the previous block space.', 42, 564);
        }
        if (number <= 2) draw(REPEAT, 42, number === 1 ? 450 : 410);
        if (number === 2) {
            draw('Left column starts before the right column.', 42, 560, 10);
            draw('Left column preserves this sentence.', 42, 546, 10);
            draw('Right column follows the left column.', 315, 560, 10);
            draw('Right column preserves its own sentence.', 315, 546, 10);
        }
        page.drawRectangle({x: 70, y: 240, width: 170, height: 90, color: rgb(.9, .94, .98), borderColor: rgb(.2, .3, .5), borderWidth: 1});
        page.drawLine({start: {x: 82, y: 254}, end: {x: 220, y: 254}, color: rgb(.1, .2, .4), thickness: 1});
        page.drawLine({start: {x: 82, y: 254}, end: {x: 82, y: 314}, color: rgb(.1, .2, .4), thickness: 1});
        page.drawLine({start: {x: 88, y: 261}, end: {x: 207, y: 303}, color: rgb(.1, .5, .6), thickness: 2});
        draw('Chart axis label', 100, 270, 9);
        draw(`Figure ${number}. Protected chart pixels and labels.`, 42, 218, 10);
        draw('E = mc^2', 210, 155, 13);
        if (number === 1) draw(CONTINUATION_FROM, 42, 122);
        page.drawLine({start: {x: 42, y: 95}, end: {x: 220, y: 95}, color: rgb(.2, .2, .2), thickness: .5});
        draw(`[1] Footnote page ${number}: preserve this qualifying condition.`, 42, 80, 8);
        draw(String(number), 290, 28, 9);
        if (number === 3) page.setRotation(degrees(90));
    }
    const bytes = Buffer.from(await pdf.save()); fs.writeFileSync(file, bytes);
    return {file, bytes, pages: 3, rotatedSourcePage: 3, repeatSource: REPEAT, metadata: METADATA,
        provenance: 'Generated controlled PDF; every translation is a manually entered UI correction. No supplier requests or responses are mocked.'};
}

async function main() {
    for (const name of ['extension-dir', 'playwright-root', 'artifacts-dir']) assert(arg(name), `--${name} is required`);
    const extensionDir = path.resolve(arg('extension-dir'));
    const artifactsDir = path.resolve(arg('artifacts-dir'));
    assert(fs.existsSync(path.join(extensionDir, 'manifest.json')), 'A prebuilt extension manifest is required');
    assert(!extensionDir.endsWith('-dev'), 'This harness requires production extension output');
    fs.mkdirSync(artifactsDir, {recursive: true});
    const {chromium} = createRequire(path.join(path.resolve(arg('playwright-root')), 'pro-document-runner.cjs'))('playwright');
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-pro-document-'));
    const report = {ok: false, artifactKind: 'production', extensionDir, artifactsDir,
        scope: 'Controlled manual corrections, full passage dialog, native PDF location migration, three actual PDF download modes, and real DOCX/EPUB correction refresh recovery.',
        limitations: ['No live translation supplier, public-paper semantic acceptance, Firefox, Safari or physical mobile device is covered.',
            'Copy coverage captures a trusted native copy event and its selected text while preventing system clipboard mutation; no OS clipboard roundtrip is claimed.',
            'Resident page/canvas counts and available JS heap snapshots are measured, including a 356-page public PDF; this is not a peak-memory benchmark.'],
        cases: [], screenshots: [], downloads: [], consoleErrors: [], workerErrors: [], expectedPdfDiagnostics: [], providerRequests: [], cleanupErrors: [],
        controlledMigration: [], startedAt: new Date().toISOString()};
    let launched, page, cdp, attempted = false, expectedCorruptPdfPhase = false, currentCase = 'bootstrap';
    const record = (name, evidence = {}) => report.cases.push({name, ok: true, ...evidence});
    const step = name => {currentCase = name; console.log(`[pro-document] ${name}`);};
    const writeReport = () => fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
    try {
        const controlled = await makeControlledPdf(path.join(artifactsDir, FIXTURE));
        report.fixture = {...controlled, bytes: {length: controlled.bytes.length, sha256: createHash('sha256').update(controlled.bytes).digest('hex')}};
        report.productionFingerprint = productionFingerprint(extensionDir);
        attempted = true;
        launched = await launchFocusSafePersistentContext({chromium, profileDir,
            browserPath: arg('browser-path') || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            background: true, headless: false, displayTarget: arg('display') || 'secondary', viewport: {width: 1440, height: 960}, timeout: 30000,
            browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
        Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
        assert.equal(report.launchMode, 'macos-background-cdp');
        assert.equal(report.focusPolicy, 'launchservices-no-foreground');
        assert.equal(report.windowPlacement.mode, 'background-visible-no-focus');
        assert.equal(report.windowPlacement.browserFrontmost, false);
        const context = launched.context;
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 30000});
        const origin = /^chrome-extension:\/\/[^/]+/u.exec(worker.url())[0];
        const expectedPdfDiagnostic = (message, channel) => {
            if (!expectedCorruptPdfPhase || !/(?:InvalidPDFException|Invalid PDF structure|Indexing all PDF objects)/u.test(message.text()) || /(?:TypeError|ReferenceError|Uncaught)/u.test(message.text())) return false;
            report.expectedPdfDiagnostics.push({channel, type: message.type(), text: message.text(), controlledInput: 'controlled-corrupt.pdf'}); return true;
        };
        worker.on('console', message => {if (!expectedPdfDiagnostic(message, 'worker') && message.type() === 'error') report.workerErrors.push(message.text());});
        page = await newPageWithoutForeground(context, 30000);
        page.setDefaultTimeout(30000);
        page.on('pageerror', error => report.consoleErrors.push(error.message));
        page.on('console', message => {if (!expectedPdfDiagnostic(message, 'page') && message.type() === 'error') report.consoleErrors.push(message.text());});
        page.on('dialog', dialog => {if (dialog.type() === 'beforeunload') void dialog.accept(); else void dialog.dismiss();});
        page.on('request', request => {if (/https?:/u.test(request.url()) && /(?:chat\/completions|translate|api\.openai|deepl|doubao)/iu.test(request.url())) report.providerRequests.push({url: request.url(), method: request.method()});});
        await page.goto(`${origin}/document.html`, {waitUntil: 'domcontentloaded'});
        await activateExtensionTabWithoutForeground(context, page);
        await page.locator('.file-drop-zone').waitFor();
        const languageSetup = await page.evaluate(async () => {
            const result = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
            if (!result.success) throw new Error(result.error);
            const stored = typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
            return chrome.runtime.sendMessage({type: 'persistConfig', mode: 'replace', baseRevision: stored.__fluentConfigRevision,
                clientId: `pro-document-language-${crypto.randomUUID()}`, sequence: 1,
                config: {...stored, uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true}});
        });
        assert.equal(languageSetup.success, true, languageSetup.error);
        report.profileConfig = {changed: ['uiLanguage', 'uiLanguageSetupCompleted'], provenance: 'UI language only; no translation endpoint, supplier, result or request is replaced.'};
        await page.reload({waitUntil: 'domcontentloaded'}); await page.locator('.file-drop-zone').waitFor();
        cdp = await context.newCDPSession(page);
        const focusCheck = async () => {
            const frontmost = await queryMacFrontmostApplication();
            assert(frontmost, 'Frontmost application must remain observable');
            assert.notEqual(frontmost.pid, await getGuardedBrowserPid(launched), 'Isolated Edge must never become frontmost');
            return frontmost;
        };
        const shot = async name => {await focusCheck(); const file = path.join(artifactsDir, `${name}.png`); await page.screenshot({path: file, animations: 'disabled'}); report.screenshots.push(file); return file;};
        const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const showRead = async () => {await page.locator('.reader-tabs button').first().click(); await page.locator('[data-pdf-scroll]').waitFor();};
        const showEdit = async () => {await page.locator('.reader-tabs button').nth(1).click(); await page.locator('.segment-editor').waitFor({state: 'visible'});};
        const presentation = async value => {
            const menu = page.locator('.pdf-presentation-control.pdf-menu');
            await menu.locator('.pdf-menu-button').click(); await menu.locator(`button[role="option"][data-value="${value}"]`).click();
            await page.locator(`.pdf-layout-viewer[data-pdf-presentation="${value}"]`).waitFor();
        };
        const openTop = async () => {await page.locator('[data-pdf-scroll]').evaluate(node => {node.scrollTop = 0; node.scrollLeft = 0;}); await frames();};
        const history = async () => page.evaluate(async () => {
            const database = await new Promise((resolve, reject) => {const request = indexedDB.open('FluentReadDocumentHistory', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);});
            try {return await new Promise((resolve, reject) => {const request = database.transaction('documents', 'readonly').objectStore('documents').getAll(); request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result.map(record => ({id: record.id, name: record.name, parsedVersion: record.parsedVersion, total: record.total,
                segments: record.parsed?.segments?.map(segment => ({id: segment.id, source: segment.source, contextLabel: segment.contextLabel})), translations: record.translations, retainedRevisions: record.retainedRevisions,
                pages: record.parsed?.binary?.pages?.map(sheet => ({pageNumber: sheet.pageNumber, blocks: sheet.blocks.map(block => ({segmentIndex: block.segmentIndex, kind: block.kind, source: block.source, x: block.x, y: block.y}))}))})));});}
            finally {database.close();}
        });
        const waitHistory = async (expected, name = FIXTURE) => {
            const started = Date.now();
            while (Date.now() - started < 15000) {const records = await history(); const value = records.find(record => record.name === name); if (value && expected(value)) return value; await new Promise(resolve => setTimeout(resolve, 150));}
            throw new Error('Controlled history did not reach the expected persisted revision');
        };
        const reloadEditor = async () => {await page.reload({waitUntil: 'domcontentloaded'}); await page.locator('.reader-tabs').waitFor(); await showEdit();};

        step('empty state and controlled import');
        const empty = await page.locator('.file-drop-zone').innerText(); assert(empty.includes('选择文件'));
        await shot('01-empty-light-1440');
        step('actual malformed PDF import error then retry through the same file input');
        expectedCorruptPdfPhase = true;
        await page.locator('input[type=file]').setInputFiles({name: 'controlled-corrupt.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n% controlled malformed PDF with no pages\n%%EOF')});
        const failedFile = page.locator('.batch-files li').filter({hasText: 'controlled-corrupt.pdf'}); await failedFile.waitFor({state: 'attached'});
        if (await page.locator('.batch-toggle').getAttribute('aria-expanded') === 'false') await page.locator('.batch-toggle').click();
        const importError = failedFile.getByRole('alert'); await importError.waitFor(); const importErrorText = await importError.innerText(); assert(importErrorText.trim());
        assert.equal(await failedFile.locator('.batch-file').isDisabled(), true);
        await page.locator('.file-drop-zone').waitFor(); await frames(); expectedCorruptPdfPhase = false;
        await shot('01b-corrupt-pdf-error'); record(currentCase, {visibleError: importErrorText, file: 'controlled-corrupt.pdf', failureQueueDisabled: true, diagnostics: report.expectedPdfDiagnostics.slice(), unhandledPageErrorsExempted: false});
        step('normal controlled PDF retry after actual import error');
        await page.locator('input[type=file]').setInputFiles({name: FIXTURE, mimeType: 'application/pdf', buffer: controlled.bytes});
        await page.locator('.workspace-heading h1').filter({hasText: FIXTURE}).waitFor();
        await page.locator('.pdf-page-row[data-render-state="ready"]').first().waitFor();
        await shot('02-imported-original'); record(currentCase, {pages: 3, provenance: controlled.provenance});

        step('controlled manual corrections through production editor');
        await showEdit();
        const rows = await page.locator('.segment-edit-row[data-segment-id]').evaluateAll(nodes => nodes.map(node => ({id: Number(node.dataset.segmentId), source: node.querySelector('.document-source')?.textContent || '', context: node.querySelector('.segment-position span')?.textContent || ''})));
        assert(rows.length > 5 && rows.length <= 40, `Controlled corpus must fit one real editor page, got ${rows.length}`);
        assert.equal(rows.filter(row => row.source === REPEAT).length, 2, 'Repeat must be two independently parsed source segments');
        assert(rows.some(row => row.source.includes('Long paragraph target')), 'Long paragraph must remain in parsed content');
        const corrections = rows.map(row => ({...row, translation: row.source.includes('Long paragraph target') ? LONG_TEXT : row.source === CONTINUATION_FROM || row.source === CONTINUATION_TO
            ? `${row.source === CONTINUATION_FROM ? '跨页前半段' : '跨页后半段'}。` + '本页校订与原文位置稳定关联，滚动时应能持续查看对应原文，不得覆盖其他页的原文内容。'.repeat(32) : `人工校订第${row.id + 1}段。${row.source === REPEAT ? `重复原文独立校订，位置${row.context}。` : '本段内容由受控界面手工填写，用于验证完整导出与稳定定位。'}`}));
        for (const correction of corrections) await page.locator(`.segment-edit-row[data-segment-id="${correction.id}"] textarea`).fill(correction.translation);
        await page.locator('.editor-search input').fill(LONG_END);
        assert.equal(await page.locator('.segment-edit-row[data-segment-id]').count(), 1, 'Editor searches the complete long correction');
        await page.locator('.editor-search input').fill('');
        const persisted = await waitHistory(value => corrections.every(correction => value.translations[correction.id] === correction.translation));
        report.corrections = corrections; report.initialHistory = persisted;
        record(currentCase, {count: corrections.length, longCharacters: LONG_TEXT.length, repeatLocations: corrections.filter(row => row.source === REPEAT).map(({id, context, translation}) => ({id, context, translation}))});
        await shot('03-manual-proofreading'); await showRead(); await openTop();

        step('full passage mouse keyboard selection and focus');
        const longSegmentId = corrections.find(correction => correction.source.includes('Long paragraph target')).id;
        const fullButton = page.locator(`.pdf-page-row[data-page-number="1"] .pdf-translation-block[data-pdf-segment-index="${longSegmentId}"] .pdf-full-passage-button`); await fullButton.waitFor();
        await fullButton.click(); const fullDialog = page.locator('.pdf-full-passage-dialog[open]'); await fullDialog.waitFor();
        assert.equal(await fullDialog.locator('.pdf-full-passage-translation').innerText(), LONG_TEXT);
        await page.evaluate(() => {
            window.__proDocumentCopy = [];
            const node = document.querySelector('.pdf-full-passage-translation'); const range = document.createRange(); range.selectNodeContents(node);
            const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
            document.addEventListener('copy', event => {window.__proDocumentCopy.push({trusted: event.isTrusted, selected: getSelection()?.toString() || ''}); event.preventDefault();}, {once: true});
        });
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c');
        const copied = await page.evaluate(() => window.__proDocumentCopy);
        assert.equal(copied.length, 1); assert.equal(copied[0].trusted, true); assert.equal(copied[0].selected, LONG_TEXT);
        await page.keyboard.press('Escape'); await fullDialog.waitFor({state: 'detached'});
        assert.equal(await fullButton.evaluate(node => node === document.activeElement), true, 'Escape restores the full passage trigger focus');
        await fullButton.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
        assert.equal(await fullButton.evaluate(node => node === document.activeElement), true, 'Tab reaches the actual full passage button');
        await page.keyboard.press('Enter'); await fullDialog.waitFor();
        assert.equal(await fullDialog.evaluate(node => node.contains(document.activeElement)), true, 'Native modal owns keyboard focus');
        await shot('04-keyboard-full-passage'); await page.keyboard.press('Escape');
        record(currentCase, {copyEventTrusted: copied[0].trusted, selectedCharacters: copied[0].selected.length, systemClipboardUnchanged: true, nativeDialogFocusReturned: true});

        step('full passage viewport and color-scheme matrix');
        const responsive = [];
        for (const width of [1440, 820, 390]) for (const colorScheme of ['light', 'dark']) {
            await page.setViewportSize({width, height: width === 390 ? 844 : 960}); await page.emulateMedia({colorScheme}); await frames();
            if (width < 1024 && await page.locator('aside.document-sidebar').isVisible() && await page.locator('.sidebar-toggle').getAttribute('aria-expanded') === 'true') await page.locator('.sidebar-toggle').click();
            await openTop();
            await fullButton.click(); await fullDialog.waitFor();
            const metrics = await fullDialog.evaluate(node => {const rect = node.getBoundingClientRect(); const content = node.querySelector('.pdf-full-passage-content'); return {width: innerWidth, bodyWidth: document.documentElement.scrollWidth,
                left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, dialogWidth: node.clientWidth, scrollWidth: node.scrollWidth,
                contentWidth: content.clientWidth, contentScrollWidth: content.scrollWidth, contentHeight: content.clientHeight, contentScrollHeight: content.scrollHeight,
                foreground: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor, dark: matchMedia('(prefers-color-scheme: dark)').matches};});
            assert(metrics.bodyWidth <= width + 1 && metrics.left >= 0 && metrics.right <= width + 1, JSON.stringify(metrics));
            assert(metrics.scrollWidth <= metrics.dialogWidth + 1 && metrics.contentScrollWidth <= metrics.contentWidth + 1, 'Full passage must not overflow horizontally');
            assert.equal(metrics.dark, colorScheme === 'dark');
            await fullDialog.locator('.pdf-full-passage-content').evaluate(node => {node.scrollTop = node.scrollHeight;}); await frames();
            const sticky = await fullDialog.evaluate(node => {
                const content = node.querySelector('.pdf-full-passage-content'), source = node.querySelector('.pdf-full-passage-source'), translation = node.querySelector('.pdf-full-passage-translation');
                const box = element => {const rect = element.getBoundingClientRect(); return {x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom};};
                return {content: box(content), source: box(source), translation: box(translation), position: getComputedStyle(source).position, scrollTop: content.scrollTop, sourceText: source.querySelector('p')?.textContent};
            });
            if (width > 600) {
                assert.equal(sticky.position, 'sticky');
                assert(sticky.scrollTop > 0, 'Desktop long-passage test must reach the translation tail');
                assert(sticky.source.y >= sticky.content.y - 1 && sticky.source.bottom <= sticky.content.bottom + 1, 'The source pane remains visible when the long translation is scrolled to its end');
                assert(sticky.source.right < sticky.translation.x && sticky.source.width < sticky.translation.width, 'Primary width belongs to the translation without source overlap');
                assert(sticky.sourceText.includes('Long paragraph target'));
            } else assert.equal(sticky.position, 'static', 'Narrow-screen source pane uses normal single-column flow');
            metrics.stickyAtTranslationTail = sticky;
            assert((await fullDialog.locator('.pdf-full-passage-translation').innerText()).endsWith(LONG_END));
            await shot(`05-full-passage-${width}-${colorScheme}`); responsive.push({width, colorScheme, ...metrics});
            await page.keyboard.press('Escape');
        }
        record(currentCase, {responsive}); await page.setViewportSize({width: 1440, height: 960}); await page.emulateMedia({colorScheme: 'light'}); await frames();

        step('search original translation and preserved metadata');
        const metadataBlocks = persisted.pages.flatMap(sheet => sheet.blocks.filter(block => block.source?.includes(METADATA)));
        report.metadataParseEvidence = {expected: METADATA, preservedBlocks: metadataBlocks, foundInSegments: persisted.segments.some(segment => segment.source.includes(METADATA))};
        assert(metadataBlocks.length || report.metadataParseEvidence.foundInSegments, 'Controlled metadata was absent from parsed snapshot; classify this as parser/content-preservation failure, not a search failure');
        const searchEvidence = [];
        await page.locator('.pdf-search > button').click();
        for (const query of ['Long paragraph target', LONG_END, METADATA]) {
            await page.locator('.pdf-search input').fill(query);
            await page.waitForFunction(() => /\d+\s*\/\s*[1-9]\d*/u.test(document.querySelector('.pdf-search-count')?.textContent || ''));
            searchEvidence.push({query, count: await page.locator('.pdf-search-count').innerText()});
        }
        await shot('06-search-preserved-metadata'); await page.keyboard.press('Escape'); record(currentCase, {searchEvidence});

        step('cross-page context preserves two original segments and both corrections');
        const from = corrections.find(correction => correction.source === CONTINUATION_FROM);
        const to = corrections.find(correction => correction.source === CONTINUATION_TO);
        assert(from && to, 'Controlled cross-page text must remain two exact original source segments including its hyphen');
        const crossPageEvidence = [];
        for (const kind of ['layout', 'readable']) {
            await presentation(kind); await openTop();
            const trigger = page.locator(kind === 'layout'
                ? `.pdf-translation-block[data-pdf-segment-index="${from.id}"] .pdf-full-passage-button`
                : `.pdf-reading-paragraph[data-pdf-segment-index="${from.id}"] .pdf-cross-page-context`).first();
            await trigger.click(); await fullDialog.waitFor();
            const sourceParts = await fullDialog.locator('.pdf-full-passage-content section').evaluateAll(nodes => nodes.filter((_node, index) => index % 2 === 0).map(node => node.querySelector('p')?.textContent));
            const translatedParts = await fullDialog.locator('.pdf-full-passage-translation').allTextContents();
            assert.deepEqual(sourceParts, [CONTINUATION_FROM, CONTINUATION_TO]);
            assert.deepEqual(translatedParts, [from.translation, to.translation]);
            const crossSourceGeometry = await fullDialog.evaluate(node => {
                const content = node.querySelector('.pdf-full-passage-content');
                const box = element => {const rect = element.getBoundingClientRect(); return {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom};};
                const samples = [];
                for (const fraction of [0, .5, 1]) {
                    content.scrollTop = (content.scrollHeight - content.clientHeight) * fraction;
                    const clip = box(content), sources = [...node.querySelectorAll('.pdf-full-passage-source')].map(box);
                    samples.push({fraction, scrollTop: content.scrollTop, clip, sources});
                }
                return samples;
            });
            report.crossPageGeometry ||= []; report.crossPageGeometry.push({kind, samples: crossSourceGeometry});
            for (const sample of crossSourceGeometry) for (let index = 1; index < sample.sources.length; index++) {
                const previous = sample.sources[index - 1], next = sample.sources[index], clip = sample.clip;
                const previousVisible = previous.bottom > clip.top && previous.top < clip.bottom;
                const nextVisible = next.bottom > clip.top && next.top < clip.bottom;
                if (previousVisible && nextVisible) assert(previous.bottom <= next.top + 1, 'Sticky source panes belonging to different cross-page parts must not overlap');
            }
            await shot(`06-cross-page-${kind}`); crossPageEvidence.push({kind, sourceParts, translatedParts, crossSourceGeometry}); await page.keyboard.press('Escape');
        }
        record(currentCase, {modes: crossPageEvidence, sourceHyphenUnchanged: true}); await presentation('layout');

        step('resident pages and canvas memory bounds');
        const memory = await page.evaluate(() => ({residentPages: document.querySelectorAll('.pdf-page-row').length, canvases: [...document.querySelectorAll('.pdf-page-row canvas')].map(canvas => ({width: canvas.width, height: canvas.height})),
            heap: performance.memory ? {usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize} : null}));
        assert(memory.residentPages <= 5); assert(memory.canvases.length <= 10); record(currentCase, memory);

        step('refresh restores manual corrections');
        await reloadEditor();
        for (const correction of corrections) assert.equal(await page.locator(`.segment-edit-row[data-segment-id="${correction.id}"] textarea`).inputValue(), correction.translation);
        await shot('07-refresh-restored'); record(currentCase, {restored: corrections.length});

        // This migration mutates only this freshly-created profile. It never changes PDF bytes or inserts translations.
        const migrate = async mode => page.evaluate(async ({name, mode}) => {
            const database = await new Promise((resolve, reject) => {const request = indexedDB.open('FluentReadDocumentHistory', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);});
            try {return await new Promise((resolve, reject) => {
                const transaction = database.transaction('documents', 'readwrite'); const store = transaction.objectStore('documents'); const request = store.getAll(); let evidence;
                transaction.oncomplete = () => resolve(evidence); transaction.onabort = () => reject(transaction.error);
                request.onerror = () => reject(request.error); request.onsuccess = () => {
                    const record = request.result.find(value => value.name === name); if (!record?.parsed?.segments || record.parsed.binary?.kind !== 'pdf') {transaction.abort(); return;}
                    const before = record.parsed.segments, oldTranslations = record.translations.slice(); const oldVersion = record.parsedVersion;
                    record.parsedVersion = 0;
                    if (mode === 'reorder-with-native-location') {
                        const reverse = before.map((segment, index) => ({segment, index})).reverse(); const indexes = new Map(reverse.map(({index}, current) => [index, current]));
                        record.parsed.segments = reverse.map(({segment}, id) => ({...segment, id}));
                        record.translations = reverse.map(({index}) => oldTranslations[before[index].id]);
                        for (const sheet of record.parsed.binary.pages) {sheet.segmentIndexes = sheet.segmentIndexes.map(index => indexes.get(index)); sheet.blocks = sheet.blocks.map(block => ({...block, segmentIndex: block.segmentIndex < 0 ? block.segmentIndex : indexes.get(block.segmentIndex)}));}
                    } else if (mode === 'legacy-missing-native-location') record.parsed.binary.pages = [];
                    else {transaction.abort(); return;}
                    store.put(record); evidence = {mode, oldVersion, migratedVersion: 0, segments: before.length, translationCount: record.translations.filter(Boolean).length, bytesUnchanged: true,
                        controlled: 'Only prior snapshot version/order/native geometry in this temporary profile is changed; existing manual correction strings and original PDF bytes are retained.'};
                };
            });} finally {database.close();}
        }, {name: FIXTURE, mode});
        step('controlled migration preserves native positions across reparse');
        report.controlledMigration.push(await migrate('reorder-with-native-location')); await reloadEditor();
        for (const correction of corrections) assert.equal(await page.locator(`.segment-edit-row[data-segment-id="${correction.id}"] textarea`).inputValue(), correction.translation, `Source location shifted for segment ${correction.id}`);
        const nativeRestored = await waitHistory(value => value.parsedVersion !== 0 && corrections.every(correction => value.translations[correction.id] === correction.translation));
        report.controlledMigration.push({mode: 'native-location-result', parsedVersion: nativeRestored.parsedVersion, repeatLocations: nativeRestored.segments.filter(segment => segment.source === REPEAT)});
        await shot('08-native-location-migration'); record(currentCase, {correctionsPreserved: corrections.length});

        step('verified real font cached locally for complete visible continuation pages');
        const fontPath = path.join(repository, 'assets/pdf-fonts/FluentReadNotoSansSC-Regular.woff2');
        const font = fs.readFileSync(fontPath); const hash = createHash('sha256').update(font).digest('hex');
        const owner = fs.readFileSync(path.join(repository, 'src/features/document-translation/services/pdfReadingFont.ts'), 'utf8');
        assert(owner.includes(`PDF_READING_FONT_SHA256 = '${hash}'`), 'Cache must match the production font digest');
        const cacheKey = `https://fluentread.app/__optional_assets__/pdf-font/${hash}.woff2`;
        await page.evaluate(async ({base64, cacheKey}) => {const raw = atob(base64); const bytes = Uint8Array.from(raw, character => character.charCodeAt(0)); const cache = await caches.open('fluentread-pdf-reading-font-v1'); await cache.put(cacheKey, new Response(bytes, {headers: {'Content-Type': 'font/woff2'}}));}, {base64: font.toString('base64'), cacheKey});
        record(currentCase, {fontSha256: hash, bytes: font.length, source: 'Actual repository font cached in isolated test profile; production font verification still runs.'});

        const openDownload = async mode => {
            await page.locator('.taskbar-actions .download-button').click(); const dialog = page.locator('.download-dialog[open]'); await dialog.waitFor();
            await dialog.locator('.export-options button').nth(mode === 'bilingual' ? 0 : 1).click();
            const partial = dialog.locator('.partial-export input'); if (await partial.isVisible()) await partial.check();
            return dialog;
        };
        step('cancel export then retry');
        await showRead(); await presentation('layout');
        const cancelDialog = await openDownload('bilingual'); let canceledDownloads = 0; const downloadedDuringCancel = () => {canceledDownloads++;}; page.on('download', downloadedDuringCancel);
        await cdp.send('Emulation.setCPUThrottlingRate', {rate: 6});
        try {
            await cancelDialog.locator('.dialog-actions .translate-document-button').click();
            await cancelDialog.locator('.dialog-actions .ghost-button').filter({hasText: '取消生成'}).click({timeout: 5000});
            await page.waitForFunction(() => document.querySelector('.download-dialog[open]')?.getAttribute('aria-busy') === 'false');
            assert.equal(canceledDownloads, 0, 'Cancellation must not leave a downloaded partial PDF');
        } finally {await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1}); page.off('download', downloadedDuringCancel);}
        assert.equal(await cancelDialog.locator('.dialog-actions .translate-document-button').isEnabled(), true);
        await cancelDialog.getByRole('button', {name: '返回文档', exact: true}).click(); record(currentCase, {throttling: 6, downloadsAfterCancel: canceledDownloads, retryEnabled: true});

        const {getDocument} = await import(pathToFileURL(requireRepo.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
        const extract = async file => {
            const task = getDocument({data: new Uint8Array(fs.readFileSync(file)), disableFontFace: true, isEvalSupported: false, useWorkerFetch: false, verbosity: 0,
                standardFontDataUrl: path.join(path.dirname(requireRepo.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep});
            try {const document = await task.promise, pages = [], labels = await document.getPageLabels(); for (let number = 1; number <= document.numPages; number++) {const sheet = await document.getPage(number); try {const text = await sheet.getTextContent({disableNormalization: true}); pages.push({number, label: labels?.[number - 1] ?? null, width: sheet.view[2] - sheet.view[0], height: sheet.view[3] - sheet.view[1], text: text.items.filter(item => 'str' in item).map(item => item.str).join('\n')});} finally {sheet.cleanup();}} return pages;} finally {await task.destroy();}
        };
        step('download layout bilingual layout translated and readable translated');
        for (const [kind, mode] of [['layout', 'bilingual'], ['layout', 'translated'], ['readable', 'translated']]) {
            await presentation(kind); const dialog = await openDownload(mode);
            const [download] = await Promise.all([page.waitForEvent('download', {timeout: 120000}), dialog.locator('.dialog-actions .translate-document-button').click()]);
            const file = path.join(artifactsDir, `${kind}-${mode}.pdf`); await download.saveAs(file); assert.equal(await download.failure(), null);
            const pages = await extract(file);
            const textFile = file.replace(/\.pdf$/u, '.text.json'); fs.writeFileSync(textFile, JSON.stringify(pages, null, 2));
            // Generated continuation footers are separate document furniture, not paragraph characters.
            // Strip only that explicit footer grammar; then require the entire original correction as an exact contiguous string.
            const whole = compact(pages.map(sheet => sheet.text).join('\n')).replace(/原文第\d+页·译文续页·?\d+\/\d+/gu, '');
            assert(whole.includes(compact(LONG_TEXT)), `${kind}/${mode} must preserve every character of the complete long correction`);
            for (const correction of corrections) assert(whole.includes(compact(correction.translation)), `${kind}/${mode} missing controlled correction ${correction.id}`);
            assert(whole.includes(compact(METADATA)), `${kind}/${mode} loses preserved author metadata`);
            if (mode === 'bilingual') {assert(whole.includes(compact('Source page 1 marker'))); assert(whole.includes(compact('Source page 3 marker')));}
            const order = [1, 2, 3].map(number => pages.findIndex(sheet => compact(sheet.text).includes(compact(corrections.find(correction => correction.source.includes(`Source page ${number} marker`))?.translation || '__missing_source_page_marker__'))));
            assert(order.every(index => index >= 0) && order[0] <= order[1] && order[1] <= order[2], `Export order changed: ${JSON.stringify(order)}`);
            assert(pages.length >= 3);
            if (kind === 'layout') {
                assert.deepEqual(pages.filter(sheet => /^\d+$/u.test(sheet.label || '')).map(sheet => sheet.label), ['1', '2', '3'], 'Standard PDF page labels must retain native source page order');
                assert(pages.some(sheet => /^1 · 译文续页 \d+$/u.test(sheet.label || '')), 'Long correction must have labeled native-page continuation pages');
            }
            const selectedPages = [...new Set([1, Math.min(2, pages.length), pages.length])]; const renders = [];
            for (const number of selectedPages) {const prefix = file.replace(/\.pdf$/u, `-page-${number}`); execFileSync(arg('pdftoppm') || path.resolve(arg('playwright-root'), '../../native/poppler/bin/pdftoppm'), ['-f', String(number), '-l', String(number), '-singlefile', '-scale-to', '1440', '-png', file, prefix], {timeout: 30000, stdio: 'pipe'}); const png = `${prefix}.png`; assert(fs.statSync(png).size > 1000); renders.push(png);}
            report.downloads.push({kind, mode, file, bytes: fs.statSync(file).size, pages: pages.length, pageLabels: pages.map(sheet => sheet.label), sourcePageOrder: order, fullLongCorrectionCharacters: LONG_TEXT.length, textFile, renders});
            if (await dialog.isVisible()) await dialog.getByRole('button', {name: '返回文档', exact: true}).click();
        }
        record(currentCase, {downloads: report.downloads.length, textValidation: 'PDF.js extracts complete manual corrections; Poppler renders first, second and last actual output pages for visual review.'});

        step('controlled ambiguous legacy migration retains separate earlier revisions');
        await showEdit(); await waitHistory(value => value.parsedVersion !== 0);
        report.controlledMigration.push(await migrate('legacy-missing-native-location')); await reloadEditor();
        const repeats = corrections.filter(correction => correction.source === REPEAT);
        for (const repeat of repeats) assert.equal(await page.locator(`.segment-edit-row[data-segment-id="${repeat.id}"] textarea`).inputValue(), '', 'Ambiguous repeated source must not receive a guessed correction');
        const retained = page.locator('.editor-retained'); await retained.waitFor(); await retained.locator('summary').click();
        for (const repeat of repeats) assert((await retained.innerText()).includes(repeat.translation), 'Every separate earlier revision must remain available');
        await shot('09-ambiguous-earlier-revisions');
        const retainedSaved = await waitHistory(value => repeats.every(repeat => value.retainedRevisions?.some(revision => revision.translation === repeat.translation)));
        record(currentCase, {retained: retainedSaved.retainedRevisions, controlledMigration: true});
        await reloadEditor(); await page.locator('.editor-retained summary').click();
        for (const repeat of repeats) assert((await page.locator('.editor-retained').innerText()).includes(repeat.translation));
        record('retained earlier revisions survive another refresh', {count: repeats.length});

        step('close document view and inspect unload cleanup');
        await showRead(); await presentation('layout'); await openTop();
        await fullButton.click(); await fullDialog.waitFor();
        const beforeClose = await page.evaluate(() => ({dialogs: document.querySelectorAll('dialog[open]').length, canvases: document.querySelectorAll('.pdf-page-row canvas').length}));
        await page.goto('about:blank', {waitUntil: 'load'});
        assert.equal(await page.locator('.pdf-page-row, .pdf-full-passage-dialog').count(), 0);
        record(currentCase, {beforeClose, afterClose: {pdfRows: 0, passageDialogs: 0}, limitations: 'Checks page teardown, closed modal and absence of late page/console errors; cannot inspect freed process heap after navigation.'});
        for (const [number, name] of [[11, 'sample.docx'], [12, 'sample.epub']]) {
            step(`real native ${name} correction persists through production refresh`);
            await page.goto(`${origin}/document.html`, {waitUntil: 'domcontentloaded'}); await page.locator('.reader-tabs').waitFor();
            const sourceFile = path.join(repository, 'tests/fixtures/document-translation', name);
            await page.locator('input[type=file]').setInputFiles(sourceFile);
            await page.locator('.workspace-heading h1').filter({hasText: name}).waitFor(); await showEdit();
            const row = page.locator('.segment-edit-row[data-segment-id]').first();
            const segmentId = Number(await row.getAttribute('data-segment-id')); const original = await row.locator('.document-source').innerText();
            const correction = `受控原生${name.endsWith('docx') ? 'Word' : 'EPUB'}人工校订，刷新后仍准确关联本段原文。`;
            await row.locator('textarea').fill(correction);
            await waitHistory(record => record.translations[segmentId] === correction, name);
            await page.reload({waitUntil: 'domcontentloaded'});
            await page.locator('.workspace-heading h1').filter({hasText: name}).waitFor(); await showEdit();
            const restored = page.locator(`.segment-edit-row[data-segment-id="${segmentId}"]`);
            assert.equal(await restored.locator('.document-source').innerText(), original);
            assert.equal(await restored.locator('textarea').inputValue(), correction);
            const savedNative = await waitHistory(record => record.translations[segmentId] === correction, name);
            assert.equal(savedNative.retainedRevisions?.length || 0, 0, 'An unchanged native Word/EPUB correction must stay active instead of becoming a retained earlier revision');
            assert.equal(await page.locator('.editor-retained').count(), 0);
            await shot(`${number}-native-${name.replace('.', '-')}-refresh`);
            record(currentCase, {file: sourceFile, original, segmentId, correction, restoredActive: true, retainedRevisions: 0,
                provenance: 'Actual repository DOCX/EPUB bytes selected through the production file input; manual textarea edit and native refresh; no supplier interception or result injection.'});
            await page.goto('about:blank', {waitUntil: 'load'});
        }

        if (arg('memory-input')) {
            step('optional long public PDF import cancellation retry and original-page memory budget');
            const memoryInput = path.resolve(arg('memory-input')); assert(fs.existsSync(memoryInput), '--memory-input must point to an existing public PDF');
            const memoryName = path.basename(memoryInput);
            const sample = () => page.evaluate(() => ({heap: performance.memory ? {usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize} : null,
                residents: [...document.querySelectorAll('.pdf-page-row')].map(row => ({page: Number(row.dataset.pageNumber), canvases: [...row.querySelectorAll('canvas')].map(canvas => ({width: canvas.width, height: canvas.height, pixels: canvas.width * canvas.height}))}))}));
            await page.goto(`${origin}/document.html`, {waitUntil: 'domcontentloaded'}); await page.locator('.reader-tabs').waitFor(); await page.locator('.reader-tabs button').first().click();
            const activeBeforeImport = await page.locator('.workspace-heading h1').innerText();
            await page.getByRole('group', {name: '阅读方式', exact: true}).getByRole('button', {name: '原文', exact: true}).click();
            const before = await sample(); const cancelStarted = Date.now();
            await page.locator('input[type=file]').setInputFiles(memoryInput);
            await page.locator('.document-import-progress button, .import-cancel').filter({hasText: '取消'}).first().click({timeout: 15000});
            await page.locator('.document-import-progress').waitFor({state: 'hidden'});
            const cancellationMs = Date.now() - cancelStarted;
            assert.equal(await page.locator('.workspace-heading h1').innerText(), activeBeforeImport, 'Canceled import must not replace the active document');
            const afterCancel = await sample(); const importStarted = Date.now();
            await page.locator('input[type=file]').setInputFiles(memoryInput);
            await page.locator('.workspace-heading h1').filter({hasText: memoryName}).waitFor({timeout: 180000});
            const importMs = Date.now() - importStarted;
            await page.getByRole('group', {name: '阅读方式', exact: true}).getByRole('button', {name: '原文', exact: true}).click();
            const pageInput = page.locator('.pdf-page-navigation input'); const total = Number(await pageInput.getAttribute('max'));
            assert.equal(total, 356, 'This optional scope is the actual 356-page NASA Systems Engineering Handbook');
            await pageInput.fill('300'); await pageInput.press('Enter');
            await page.locator('.pdf-page-row[data-page-number="300"][data-render-state="ready"]').waitFor({timeout: 60000}); await frames();
            const atPage300 = await sample(); assert(atPage300.residents.length <= 5, 'Long PDF may retain at most five resident pages');
            assert(atPage300.residents.some(row => row.page === 300));
            for (const resident of atPage300.residents) {
                assert(resident.canvases.reduce((sum, canvas) => sum + canvas.pixels, 0) <= 8_000_000, `Page ${resident.page} exceeds the production pixel budget`);
                assert(resident.canvases.every(canvas => canvas.width <= 8192 && canvas.height <= 8192));
            }
            await shot('10-nasa-356-pages-original-page-300');
            await page.goto('about:blank', {waitUntil: 'load'}); await new Promise(resolve => setTimeout(resolve, 250));
            assert.equal(await page.locator('.pdf-page-row, canvas, dialog[open]').count(), 0);
            record(currentCase, {source: memoryInput, bytes: fs.statSync(memoryInput).size, pages: total, mode: 'original only', cancellationMs, importMs,
                before, afterCancel, atPage300, closed: true, imports: {canceled: 1, successful: 1},
                scope: 'One canceled import and one complete import of the public 356-page handbook; page 300 original reading only. No claim of translating this book or bounding retained parsed-text heap.'});
        }
        report.finalFrontmostApplication = await focusCheck();
        assert.equal(report.providerRequests.length, 0, 'Manual correction acceptance must not invoke translation suppliers');
        assert.equal(report.consoleErrors.length, 0, JSON.stringify(report.consoleErrors));
        assert.equal(report.workerErrors.length, 0, JSON.stringify(report.workerErrors));
        report.ok = true;
    } catch (error) {
        report.failedCase = currentCase; report.failure = error.stack || String(error);
        if (page) {report.failureUi = await page.evaluate(() => ({url: location.href, text: document.body?.innerText.slice(0, 14000), dialogs: [...document.querySelectorAll('dialog[open]')].map(node => node.className)})).catch(() => null); await page.screenshot({path: path.join(artifactsDir, 'failure.png')}).catch(() => {});}
        throw error;
    } finally {
        await cdp?.detach().catch(() => {}); let closed = false;
        if (launched) {try {await launched.close(); closed = true;} catch (error) {report.cleanupErrors.push(`browser close: ${error.stack || error}`);}}
        if (closed || !attempted) {try {fs.rmSync(profileDir, {recursive: true, force: true});} catch (error) {report.cleanupErrors.push(`profile removal: ${error.message}`); report.retainedProfile = profileDir;}}
        else report.retainedProfile = profileDir;
        if (report.cleanupErrors.length) {report.ok = false; process.exitCode = 1;}
        if (report.productionFingerprint) {
            const finalFingerprint = productionFingerprint(extensionDir);
            report.finalProductionSha256 = finalFingerprint.sha256;
            if (finalFingerprint.sha256 !== report.productionFingerprint.sha256) {report.ok = false; report.cleanupErrors.push('Production build files changed during the acceptance run'); process.exitCode = 1;}
        }
        report.finishedAt = new Date().toISOString(); writeReport();
        console.log(JSON.stringify({ok: report.ok, report: path.join(artifactsDir, 'report.json'), cases: report.cases.length, failedCase: report.failedCase, failure: report.failure}));
    }
}
main().catch(error => {console.error(error.stack || error); process.exitCode = 1;});
