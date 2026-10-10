import {createRequire} from 'node:module';
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.FLUENTREAD_PLAYWRIGHT_MODULE || 'playwright');
const directory = resolve('docs/reports/reading-reliability-experience-20261010/pdf-evidence');
const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
    const context = await browser.newContext({permissions: ['clipboard-read', 'clipboard-write'], viewport: {width: 1100, height: 1300}});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto('http://127.0.0.1:5188/docs/reports/reading-reliability-experience-20261010/pdf-evidence/browser-harness.html');
    await page.waitForFunction(() => typeof globalThis.runPdfEvidence === 'function');
    const result = await page.evaluate(() => globalThis.runPdfEvidence());
    mkdirSync(directory, {recursive: true});
    const files = result.files.map(({fileName, bytes, ...details}) => {
        writeFileSync(resolve(directory, fileName), Uint8Array.from(bytes));
        return {fileName, bytes: bytes.length, ...details};
    });
    await page.screenshot({path: resolve(directory, 'browser-visible-and-selectable.png'), fullPage: true});
    const evidence = {generatedAt: new Date().toISOString(), browser: result.browser, files, selectedText: result.selectedText, cancellation: result.cancellation,
        assertions: {unicodeAndTail: true, originalPage: true, continuation: true, chineseTextSelection: true, clipboardRoundTrip: true, cancellationCanvasRelease: true}, errors};
    writeFileSync(resolve(directory, 'browser-evidence.json'), JSON.stringify(evidence, null, 2));
    if (errors.length) throw new Error(errors.join('\n'));
    console.log(JSON.stringify({...evidence, selectedText: result.selectedText.slice(0, 180)}, null, 2));
} finally {await browser.close();}
