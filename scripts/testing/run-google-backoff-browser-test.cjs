#!/usr/bin/env node
'use strict';
// Google 合批与限流恢复生产专项：临时 Edge、后台可见窗口、受控 HTTP 与真实翻译手势。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const support = require('../run-selection-trigger-test.cjs');
const {assertFreshProductionExtension} = require('../run-site-translation-test.cjs');
const {guardBrowserClose} = require('./owned-browser-close.cjs');
const arg = name => process.argv[process.argv.indexOf(`--${name}`) + 1];
for (const name of ['extension-dir', 'playwright-root', 'focus-safe-helper', 'artifacts-dir']) {
    assert(process.argv.includes(`--${name}`), `missing --${name}`);
}
const extensionDir = path.resolve(arg('extension-dir'));
const artifactsDir = path.resolve(arg('artifacts-dir'));
const {chromium} = require(path.join(arg('playwright-root'), 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground} = require(path.resolve(arg('focus-safe-helper')));
const profileDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluentread-google-backoff-'));
const identity = fs.lstatSync(profileDir);
const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>谷歌翻译限流测试</title></head><body style="font:22px/1.8 system-ui;margin:60px auto;max-width:900px"><main><p id="primary">The translation service should wait for the server and recover while the reader continues reading.</p><p id="neighbor">This separate paragraph must remain unchanged during the single paragraph translation.</p></main></body></html>';
const server = http.createServer((_request, response) => {
    response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    response.end(html);
});
const report = {ok: false, extensionDir, profileDir, profileMode: 'automatically-created-temporary-profile',
    scope: 'Google actual HTTP batching/pacing/429 recovery, cancellation, hover/full-page restore and repeat',
    evidenceBoundary: 'Production extension and real browser input with a local page and synthetic Google responses; no live Google quota or translation quality measurement.',
    cases: [], errors: [], screenshots: []};
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let launched, popup, page, worker;
const snapshot = () => worker.evaluate(() => globalThis.__googleBackoffFixture.events);
async function setScenario(mode, rejectNext = 0, retryAfter = '1') {
    await worker.evaluate(options => Object.assign(globalThis.__googleBackoffFixture, options), {mode, rejectNext, retryAfter});
}
async function gesture(selector) {
    await activateExtensionTabWithoutForeground(launched.context, page);
    await page.locator(selector).click();
    await page.locator(selector).hover();
    await page.keyboard.down('Control');
    await page.keyboard.up('Control');
}
async function expectCount(selector, count) {
    await page.waitForFunction(({selector, count}) => document.querySelector(selector).querySelectorAll('.fluent-read-bilingual-content').length === count,
        {selector, count}, {timeout: 20000});
}
async function screenshot(name) {
    const file = path.join(artifactsDir, `${name}.png`);
    await page.screenshot({path: file, animations: 'disabled'});
    report.screenshots.push(file);
}
(async () => {
    fs.mkdirSync(artifactsDir, {recursive: true});
    report.buildFreshness = assertFreshProductionExtension(extensionDir);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        launched = guardBrowserClose(await launchFocusSafePersistentContext({chromium, profileDir,
            browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            background: true, headless: false, viewport: {width: 1280, height: 900}, timeout: 30000,
            browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check'],
        }), profileDir);
        Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
        assert.equal(report.launchMode, 'macos-background-cdp');
        assert.equal(report.focusPolicy, 'launchservices-no-foreground');
        assert.equal(report.windowPlacement.browserFrontmost, false);
        const context = launched.context;
        worker = context.serviceWorkers().find(value => value.url().startsWith('chrome-extension://'))
            || await context.waitForEvent('serviceworker', {timeout: 30000});
        const extensionOrigin = `chrome-extension://${new URL(worker.url()).host}`;
        popup = await newPageWithoutForeground(context);
        await popup.goto(`${extensionOrigin}/popup.html`);
        await support.patchStoredConfig(popup, {on: true, service: 'google', from: 'en', to: 'zh-Hans', display: 1,
            hotkey: 'Control', autoTranslate: false, disableFloatingBall: true, disableSelectionTranslator: true,
            useCache: true, enableAIContext: false, glossaryEnabled: false, uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true});
        await worker.evaluate(() => {
            const nativeFetch = globalThis.fetch.bind(globalThis);
            const fixture = globalThis.__googleBackoffFixture = {mode: 'continuous', rejectNext: 1, retryAfter: '1', active: 0, events: []};
            globalThis.fetch = async (input, init = {}) => {
                const url = new URL(String(input));
                if (!['translate-pa.googleapis.com', 'translate.googleapis.com', 'translate.google.com', 'translate.google.co.uk'].includes(url.hostname)) {
                    return nativeFetch(input, init);
                }
                const texts = url.pathname.endsWith('translateHtml') ? JSON.parse(String(init.body))[0][0]
                    : url.pathname.endsWith('/translate_a/t') ? new URLSearchParams(String(init.body)).getAll('q')
                    : JSON.parse(new URLSearchParams(String(init.body)).get('f.req'))[0].map(record => JSON.parse(record[1])[0][0]);
                const event = {mode: fixture.mode, at: Date.now(), host: url.hostname, texts, active: ++fixture.active, status: 200, cancelled: false};
                fixture.events.push(event);
                try {
                    if (fixture.rejectNext > 0) {
                        fixture.rejectNext--;
                        event.status = fixture.mode === 'fallback' ? 503 : 429;
                        return new Response('', {status: event.status, headers: {'Retry-After': fixture.retryAfter}});
                    }
                    await new Promise((resolve, reject) => {
                        const abort = () => {clearTimeout(timer); event.cancelled = true; reject(new DOMException('Fixture cancelled', 'AbortError'));};
                        const timer = setTimeout(() => {init.signal?.removeEventListener('abort', abort); resolve();}, 70);
                        if (init.signal?.aborted) abort();
                        else init.signal?.addEventListener('abort', abort, {once: true});
                    });
                    const translated = texts.map(text => text.split(/(___FLUENTREAD_[A-Za-z0-9]+_\d+_(?:BEGIN|END)___)/u)
                        .map(part => part.startsWith('___FLUENTREAD_') || !part.trim() ? part : '软件等待服务恢复后继续翻译，让读者能够连续阅读。').join(''));
                    const body = url.pathname.endsWith('translateHtml') ? [translated]
                        : url.pathname.endsWith('/translate_a/t') ? translated
                        : translated.map((text, index) => ['wrb.fr', 'MkEWBc', JSON.stringify([null, [[[null, null, null, null, null, [[text]]]]]]), null, null, null, String(index)]);
                    return new Response(JSON.stringify(body), {status: 200});
                } finally {
                    fixture.active--;
                }
            };
        });
        report.continuousResults = await popup.evaluate(async () => {
            const tasks = [];
            for (let index = 0; index < 12; index++) {
                tasks.push(chrome.runtime.sendMessage({origin: `Continuous paragraph ${index} describes reading and translation recovery.`,
                    serviceOverride: 'google', sourceLanguage: 'en', targetLanguage: 'zh-Hans', useCache: false, requestTimeoutMs: 8000}));
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            return Promise.all(tasks);
        });
        assert(report.continuousResults.every(value => typeof value === 'string' && /\p{Script=Han}/u.test(value)));
        const continuous = (await snapshot()).filter(event => event.mode === 'continuous');
        assert.equal(continuous[0].status, 429);
        assert(continuous[1].at - continuous[0].at >= 990, 'Retry-After was ignored');
        assert(continuous.length < 12, 'staggered paragraphs were not coalesced');
        assert(continuous.some(event => event.texts.length > 1));
        assert(continuous.every(event => event.active <= 2));
        for (let index = 1; index < continuous.length; index++) assert(continuous[index].at - continuous[index - 1].at >= 190, 'actual HTTP pacing was bypassed');
        report.cases.push('12 staggered requests coalesce and all recover after one 429 without early alternate-host requests');
        await setScenario('fallback', 1);
        const fallback = await popup.evaluate(() => chrome.runtime.sendMessage({origin: 'A separate paragraph checks that ordinary server failure still uses a backup endpoint.',
            serviceOverride: 'google', sourceLanguage: 'en', targetLanguage: 'zh-Hans', useCache: false}));
        assert.equal(typeof fallback, 'string');
        const fallbacks = (await snapshot()).filter(event => event.mode === 'fallback');
        assert.equal(fallbacks.length, 2);
        assert(fallbacks[1].at - fallbacks[0].at >= 190);
        report.cases.push('ordinary 503 fallback remains available and uses the same actual HTTP pacing');
        await setScenario('cancel', 1, '2');
        await popup.evaluate(() => {
            globalThis.__googleCancelFirst = chrome.runtime.sendMessage({origin: 'The first cancellation fixture paragraph keeps its own translation active.',
                serviceOverride: 'google', sourceLanguage: 'en', targetLanguage: 'zh-Hans', useCache: false, clientRequestId: 'google-surviving-owner'});
        });
        for (let index = 0; index < 100 && !(await snapshot()).some(event => event.mode === 'cancel'); index++) await delay(30);
        assert((await snapshot()).some(event => event.mode === 'cancel' && event.status === 429));
        await popup.evaluate(() => {
            globalThis.__googleCancelSecond = chrome.runtime.sendMessage({origin: 'The cancelled queued paragraph must never reach a Google endpoint.',
                serviceOverride: 'google', sourceLanguage: 'en', targetLanguage: 'zh-Hans', useCache: false, clientRequestId: 'google-cancelled-owner'});
        });
        await delay(200);
        const cancellation = await popup.evaluate(() => chrome.runtime.sendMessage({type: 'fluentReadTranslationCancel', clientRequestId: 'google-cancelled-owner'}));
        assert.equal(cancellation.success, true);
        const surviving = await popup.evaluate(() => globalThis.__googleCancelFirst);
        const cancelled = await popup.evaluate(() => globalThis.__googleCancelSecond);
        assert.equal(typeof surviving, 'string');
        assert.equal(typeof cancelled, 'object');
        assert(!(await snapshot()).some(event => event.texts.some(text => text.includes('cancelled queued paragraph'))));
        report.cases.push('queued owner cancellation sends no HTTP and preserves the other owner recovery');
        await setScenario('hover', 1);
        page = await newPageWithoutForeground(context);
        page.on('pageerror', error => report.errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        await page.locator('#fluent-read-page-styles').waitFor({state: 'attached'});
        const originalUrl = page.url();
        const original = await page.locator('main').innerHTML();
        report.hoverCounts = [];
        for (const count of [1, 0, 1]) {
            await gesture('#primary');
            await expectCount('#primary', count);
            report.hoverCounts.push(await page.locator('#primary .fluent-read-bilingual-content').count());
            assert.equal(await page.locator('#neighbor .fluent-read-bilingual-content').count(), 0);
            assert.equal(page.url(), originalUrl);
            if (count) assert(/\p{Script=Han}/u.test(await page.locator('#primary .fluent-read-bilingual-content').innerText()));
        }
        assert.equal(await page.locator('.fluent-read-retry-wrapper').count(), 0);
        await screenshot('google-hover-recovered');
        await gesture('#primary'); await expectCount('#primary', 0);
        assert.equal(await page.locator('main').innerHTML(), original);
        await setScenario('full-page', 1);
        for (const count of [1, 0, 1]) {
            await page.keyboard.press('Alt+T');
            await expectCount('#primary', count); await expectCount('#neighbor', count);
            if (count === 0) assert.equal(await page.locator('main').innerHTML(), original);
            else for (const selector of ['#primary', '#neighbor']) {
                assert(/\p{Script=Han}/u.test(await page.locator(`${selector} .fluent-read-bilingual-content`).innerText()));
            }
            assert.equal(page.url(), originalUrl);
        }
        assert.equal(await page.locator('.fluent-read-retry-wrapper').count(), 0);
        await screenshot('google-full-page-recovered');
        report.cases.push('real Control and Alt+T translate/restore/retranslate without retry placeholders or duplicate wrappers');
        report.events = await snapshot();
        assert.deepEqual(report.errors, []);
        report.ok = true;
    } catch (error) {
        report.error = error.stack || String(error);
        if (worker) report.events = await snapshot().catch(() => []);
        if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
        process.exitCode = 1;
    } finally {
        try {
            if (launched) {
                await launched.close();
                const currentIdentity = fs.lstatSync(profileDir);
                assert.equal(currentIdentity.dev, identity.dev); assert.equal(currentIdentity.ino, identity.ino);
                fs.rmSync(profileDir, {recursive: true});
                report.profileCleaned = !fs.existsSync(profileDir);
            }
        } catch (error) {
            report.ok = false; report.cleanupError = error.stack || String(error); process.exitCode = 1;
        } finally {
            await new Promise(resolve => server.close(resolve));
            fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
        }
        console.log(JSON.stringify({ok: report.ok, cases: report.cases, hoverCounts: report.hoverCounts,
            profileCleaned: report.profileCleaned, error: report.error, cleanupError: report.cleanupError, report: path.join(artifactsDir, 'report.json')}, null, 2));
    }
})();
