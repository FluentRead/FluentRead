'use strict';

// 在隔离扩展副本中比较原始与已适配的真实 OCR core；语言包从指定本地测试目录读取。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const source = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const languageDirectory = arg('language-dir');
assert.ok(languageDirectory, '--language-dir must contain chi_sim.traineddata and eng.traineddata');
const languages = path.resolve(languageDirectory);
const artifacts = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-ocr-diagnostics'));
const {chromium} = require(path.join(arg('playwright-root', '/Users/thinkstu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(arg('focus-safe-helper', '/Users/thinkstu/.codex/skills/fluentread-extension-ui-test/scripts/focus-safe-browser.cjs'));
for (const language of ['chi_sim', 'eng']) assert.ok(fs.existsSync(path.join(languages, `${language}.traineddata`)), `Missing ${language} test data`);
const report = {source, cases: [], pageErrors: [], evidence: 'Real packaged Tesseract SIMD LSTM core, local chi_sim + eng models and a generated printed-text fixture; no handwriting or live-page accuracy claim.'};
(async () => {
    let session;
    let profile;
    let fixture;
    let launchAttempted = false;
    try {
        fs.mkdirSync(artifacts, {recursive: true});
        profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-ocr-diagnostics-profile-'));
        fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-ocr-diagnostics-extension-'));
        fs.cpSync(source, fixture, {recursive: true});
        fs.mkdirSync(path.join(fixture, 'probe-data'));
        for (const language of ['chi_sim', 'eng']) fs.copyFileSync(path.join(languages, `${language}.traineddata`), path.join(fixture, 'probe-data', `${language}.traineddata`));
        const sdkRequire = createRequire(require.resolve('tesseract.js'));
        fs.copyFileSync(sdkRequire.resolve('tesseract.js-core/tesseract-core-simd-lstm.wasm.js'), path.join(fixture, 'probe-ocr-baseline.js'));
        fs.copyFileSync(path.resolve('node_modules/tesseract.js/dist/tesseract.min.js'), path.join(fixture, 'probe-tesseract.js'));
        fs.writeFileSync(path.join(fixture, 'probe.html'), '<!doctype html><title>OCR diagnostics verification</title><h1>OCR diagnostics verification</h1>');
        launchAttempted = true;
        session = await launchFocusSafePersistentContext({chromium, profileDir: profile,
            browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', headless: false, background: true,
            viewport: {width: 1100, height: 800}, browserArgs: ['--no-first-run', '--no-default-browser-check', `--disable-extensions-except=${fixture}`, `--load-extension=${fixture}`]});
        Object.assign(report, {launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement});
        const {context} = session;
        const background = context.serviceWorkers().find(worker => worker.url().startsWith('chrome-extension://')) || await context.waitForEvent('serviceworker', {timeout: 30000});
        const origin = background.url().match(/^chrome-extension:\/\/[^/]+/)[0];
        const page = await newPageWithoutForeground(context);
        const logs = [];
        page.on('console', message => logs.push({type: message.type(), text: message.text()}));
        page.on('pageerror', error => report.pageErrors.push(error.message));
        await page.goto(`${origin}/probe.html`);
        await page.addScriptTag({url: `${origin}/probe-tesseract.js`});
        for (const label of ['baseline', 'adapted']) {
            logs.length = 0;
            const result = await page.evaluate(async ({label, origin}) => {
                const canvas = document.createElement('canvas');
                canvas.width = 1000; canvas.height = 130;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.fillStyle = '#000000'; ctx.font = '42px Arial';
                ctx.fillText('流畅阅读 FluentRead 123', 30, 80);
                const dataUrl = canvas.toDataURL('image/png');
                const worker = await Tesseract.createWorker(['chi_sim', 'eng'], 1, {
                    workerPath: `${origin}/fluent-read-ocr/worker/worker.min.js`,
                    corePath: `${origin}/${label === 'baseline' ? 'probe-ocr-baseline.js' : 'fluent-read-ocr/core/tesseract-core-simd-lstm.wasm.js'}`,
                    langPath: `${origin}/probe-data`, gzip: false, cacheMethod: 'none', workerBlobURL: false,
                    errorHandler: () => {},
                }, {tessedit_load_sublangs: ''});
                try {
                    await worker.setParameters({tessedit_pageseg_mode: 11, preserve_interword_spaces: '1'});
                    const first = await worker.recognize(dataUrl, {}, {blocks: true});
                    const second = await worker.recognize(dataUrl, {}, {blocks: true});
                    return {text: first.data.text, confidence: first.data.confidence, repeatedText: second.data.text};
                } finally {await worker.terminate();}
            }, {label, origin});
            report.cases.push({label, ...result, logs: [...logs]});
            assert.match(result.text, /FluentRead 123/);
            assert.equal(result.text, result.repeatedText);
        }
        assert.equal(report.cases[0].text, report.cases[1].text);
        assert.equal(report.cases[0].confidence, report.cases[1].confidence);
        const oldParameter = entry => /Warning: Parameter not found: language_model_ngram_on/.test(entry.text);
        assert.ok(report.cases[0].logs.some(entry => oldParameter(entry) && entry.type === 'error'));
        assert.ok(report.cases[1].logs.some(entry => oldParameter(entry) && entry.type === 'debug'));
        assert.equal(report.cases[1].logs.filter(entry => ['warning', 'error'].includes(entry.type)).length, 0);
        logs.length = 0;
        // 仅破坏这次临时 Worker 的虚拟文件；不修改下载目录、浏览器缓存或用户数据。
        report.failureCase = await page.evaluate(async origin => {
            const worker = await Tesseract.createWorker('eng', 1, {
                workerPath: `${origin}/fluent-read-ocr/worker/worker.min.js`,
                corePath: `${origin}/fluent-read-ocr/core/tesseract-core-simd-lstm.wasm.js`,
                langPath: `${origin}/probe-data`, gzip: false, cacheMethod: 'none', workerBlobURL: false,
                errorHandler: () => {},
            }, {tessedit_load_sublangs: ''});
            try {
                await worker.FS('unlink', ['/eng.traineddata']);
                try {await worker.reinitialize('eng', 1, {tessedit_load_sublangs: ''}); return {rejected: false};}
                catch (error) {return {rejected: true, error: String(error)};}
            } finally {await worker.terminate();}
        }, origin);
        report.failureCase.logs = [...logs];
        assert.equal(report.failureCase.rejected, true);
        assert.ok(logs.some(entry => entry.type === 'error' && /Error|Failed|couldn.t/i.test(entry.text)));
        assert.deepEqual(report.pageErrors, []);
        report.ok = true;
    } catch (error) {report.ok = false; report.failure = error.stack || String(error); process.exitCode = 1; console.error(error);}
    finally {
        let closed = !launchAttempted;
        try {
            if (session) {await session.close(); closed = true;}
        } catch (error) {
            report.cleanupError = error.stack || String(error);
            report.ok = false;
            process.exitCode = 1;
        }
        if (closed) {
            for (const directory of [profile, fixture]) {
                if (!directory) continue;
                try {fs.rmSync(directory, {recursive: true, force: true});}
                catch (error) {
                    (report.directoryCleanupErrors ||= []).push({directory, error: error.stack || String(error)});
                    report.ok = false;
                    process.exitCode = 1;
                }
            }
        } else {
            // close 未确认完成时保留本次 profile 与加载中的扩展副本，供人工精确清理。
            report.retainedProfile = profile;
            report.retainedFixture = fixture;
        }
        try {fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));}
        catch (error) {report.reportWriteError = error.stack || String(error); console.error(error); report.ok = false; process.exitCode = 1;}
        console.log(JSON.stringify(report, null, 2));
    }
})();
