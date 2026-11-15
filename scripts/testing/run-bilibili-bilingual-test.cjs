#!/usr/bin/env node
/**
 * @file scripts/testing/run-bilibili-bilingual-test.cjs
 * 文件职责：用生产扩展验证 B 站中文轨在前时的原文选择及双语显示。
 * 主要内容：临时 Edge profile、第二屏后台窗口、受控中英字幕和翻译响应，覆盖模式、顺序、语言、关闭及刷新，保存截图和隔离世界诊断。
 * 模块边界：复用课程播放器夹具及焦点安全工具；不读取日常浏览器、账号或真实翻译服务，不代表登录态原站验收。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {coursePlayerFixture, source} = require('../../tests/fixtures/course-players/player.cjs');
const options = {};
for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i];
    if (key === '--background') options.background = true;
    else if (['--extension-dir', '--artifacts-dir', '--playwright-root'].includes(key)) {
        const value = process.argv[++i];
        assert(value && !value.startsWith('--'), `Missing value: ${key}`); options[key.slice(2)] = value;
    } else throw Error(`Unknown option: ${key}`);
}
assert(options.background, 'Use --background for a visible isolated secondary-display browser');
assert(options['artifacts-dir'] && options['playwright-root'], 'Specify --artifacts-dir and --playwright-root');
const root = path.resolve(__dirname, '../..');
const extension = path.resolve(options['extension-dir'] || path.join(root, '.output/chrome-mv3'));
const artifacts = path.resolve(options['artifacts-dir']);
const {chromium} = require(path.join(options['playwright-root'], 'playwright'));
const skill = path.join(os.homedir(), '.codex/skills/fluentread-browser-translation-test/scripts');
const helper = require(path.join(skill, 'focus-safe-browser.cjs'));
const {createRuntimeDiagnostics} = require(path.join(skill, 'runtime-diagnostics.cjs'));
const diagnostics = createRuntimeDiagnostics();
const chinese = '类是创建对象的蓝图。';
const report = {kind: 'bilibili-bilingual-source-regression', mocked: {page: true, subtitles: true, translation: true}, cases: [],
    limitations: ['Controlled player and subtitle data; no logged-in Bilibili, live translation or Firefox runtime acceptance.', 'Initial extension bootstrap before CDP attachment is not observable.']};
let session, profile, page;

async function main() {
    fs.mkdirSync(artifacts, {recursive: true});
    const file = path.join(artifacts, 'fixture.mp4');
    const media = spawnSync('/opt/homebrew/bin/ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=#111824:s=960x540:r=5', '-t', '20', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], {encoding: 'utf8', timeout: 30000});
    fs.writeFileSync(path.join(artifacts, 'ffmpeg.log'), media.stderr || ''); assert.equal(media.status, 0);
    const mediaUrl = `data:video/mp4;base64,${fs.readFileSync(file).toString('base64')}`;
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-bilibili-bilingual-'));
    try {
        session = await helper.launchFocusSafePersistentContext({chromium, profileDir: profile,
            browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', headless: false, background: true,
            displayTarget: 'secondary', viewport: {width: 1280, height: 900},
            browserArgs: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run', '--no-default-browser-check']});
        Object.assign(report, {launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement});
        const context = session.context; await diagnostics.start(context);
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const extensionId = new URL(worker.url()).host; diagnostics.setExtensionId(extensionId);
        await worker.evaluate(({source, chinese}) => {
            const original = fetch.bind(globalThis);
            globalThis.fetch = async (input, init) => {
                const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
                if (url.startsWith('https://edge.microsoft.com/translate/translatetext')) {
                    return new Response(JSON.stringify(JSON.parse(init.body).map(text => ({translations: [{text: text === chinese ? source : chinese}]}))), {headers: {'content-type': 'application/json'}});
                }
                return original(input, init);
            };
        }, {source, chinese});
        const control = await helper.newPageWithoutForeground(context); await diagnostics.attachPage(control, 'bilibili-options');
        await control.goto(`chrome-extension://${extensionId}/options.html`, {waitUntil: 'domcontentloaded'});
        let sequence = 0;
        const patch = async value => {
            const result = await control.evaluate(async ({value, sequence}) => {
                const stored = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
                const config = typeof stored.value === 'string' ? JSON.parse(stored.value) : stored.value;
                return chrome.runtime.sendMessage({type: 'persistConfig', clientId: 'bilibili-bilingual-test', sequence,
                    baseRevision: config.__fluentConfigRevision, config: {...config, ...value}});
            }, {value, sequence: ++sequence});
            assert.equal(result.success, true, JSON.stringify(result));
        };
        await patch({on: true, uiLanguageSetupCompleted: true, uiLanguage: 'zh-CN', from: 'auto', to: 'zh-Hans',
            service: 'microsoft', videoService: 'microsoft', videoTranslationEnabled: true, videoSubtitleVisible: true,
            videoSubtitleDisplayMode: 'bilingual', videoCourseAutoStart: {bilibili: true, udemy: false, edx: false}});
        let singleLanguage = false;
        const subtitleRequests = [];
        report.subtitleRequests = subtitleRequests;
        await context.route('**/*', async route => {
            const request = route.request(), url = new URL(request.url());
            if (url.protocol === 'chrome-extension:') return route.continue();
            const headers = {'access-control-allow-origin': request.headers().origin || '*', 'access-control-allow-credentials': 'true'};
            if (request.isNavigationRequest()) return route.fulfill({contentType: 'text/html; charset=utf-8', body: coursePlayerFixture('bilibili', mediaUrl)});
            let body;
            if (url.hostname === 'api.bilibili.com') body = {data: {cid: 456, subtitle: {subtitles: [
                {lan: 'zh-Hans', subtitle_url: '//aisubtitle.hdslb.com/zh.json'},
                ...singleLanguage ? [] : [{lan: 'en-US', subtitle_url: '//aisubtitle.hdslb.com/en.json'}],
            ]}}};
            else if (url.hostname === 'aisubtitle.hdslb.com') {
                subtitleRequests.push(url.pathname); body = {body: [{from: 0, to: 20, content: url.pathname === '/en.json' ? source : chinese}]};
            } else return route.fulfill({status: 204, headers});
            return route.fulfill({contentType: 'application/json', headers, body: JSON.stringify(body)});
        });
        page = await helper.newPageWithoutForeground(context); await diagnostics.attachPage(page, 'bilibili-page-and-isolated'); page.setDefaultTimeout(15000);
        const host = () => page.locator('#fluent-read-course-controls');
        const menu = () => host().locator('#fluent-read-video-subtitle-menu');
        const open = async () => {if (!await menu().isVisible()) await host().locator('[aria-haspopup="menu"]').click();};
        const choose = async mode => {await open(); await menu().locator(`[data-mode="${mode}"]`).click();};
        const check = async (name, original, translation, hidden = false) => {
            diagnostics.setPhase(name);
            await page.waitForFunction(({original, translation, hidden}) => {
                const host = document.getElementById('fluent-read-platform-captions'), root = host?.shadowRoot;
                const source = root?.querySelector('.source'), translated = root?.querySelector('.translation');
                return host && !host.hidden && source?.textContent === original && source.hidden === hidden && translated?.textContent === translation;
            }, {original, translation, hidden});
            assert.equal(await page.locator('#fluent-read-platform-captions').count(), 1);
            report.cases.push({name, passed: true});
        };
        diagnostics.setPhase('navigation');
        await page.goto('https://www.bilibili.com/video/BV1xx411c7mD/', {waitUntil: 'domcontentloaded'});
        await helper.activateExtensionTabWithoutForeground(context, page);
        await check('chinese-first-english-source', source, chinese);
        assert.deepEqual(subtitleRequests, ['/en.json']);
        await page.locator('#fluent-read-platform-captions').screenshot({path: path.join(artifacts, 'bilingual-caption-lines.png')});
        await open(); await page.screenshot({path: path.join(artifacts, 'bilingual-original-first.png')});
        await choose('translation-only'); await check('translation-only', source, chinese, true);
        await choose('original-only'); await check('original-only', source, '');
        await choose('bilingual'); await check('bilingual-again', source, chinese);
        assert.deepEqual(subtitleRequests, ['/en.json']);
        await menu().locator('[data-subtitle-order="translation-first"]').click();
        await page.waitForFunction(() => document.getElementById('fluent-read-platform-captions').shadowRoot.querySelector('.panel').firstElementChild.className === 'translation');
        report.cases.push({name: 'translation-first-order', passed: true});
        await page.screenshot({path: path.join(artifacts, 'bilingual-translation-first.png')});
        await choose('off');
        await page.waitForFunction(() => document.getElementById('fluent-read-platform-captions')?.hidden === true && getComputedStyle(document.querySelector('.bpx-player-subtitle-wrap')).visibility !== 'hidden');
        await choose('bilingual'); await check('off-restore-reenable', source, chinese);
        await patch({to: 'en'}); await check('target-language-reselects', chinese, source);
        await patch({from: 'en'}); await check('explicit-original-language', source, '');
        await patch({from: 'auto', to: 'zh-Hans'}); await check('return-auto-chinese-target', source, chinese);
        singleLanguage = true; diagnostics.setPhase('single-language-reload'); await page.reload({waitUntil: 'domcontentloaded'});
        await check('only-chinese-track-keeps-one-line', chinese, '');
        await page.screenshot({path: path.join(artifacts, 'only-chinese-track.png')});
        singleLanguage = false; await page.reload({waitUntil: 'domcontentloaded'}); await check('reload-restores-bilingual', source, chinese);
        report.subtitleRequests = subtitleRequests;
        diagnostics.setPhase('teardown'); await page.goto('about:blank'); await control.reload();
        await diagnostics.flush(); diagnostics.assertClean(); report.passed = true;
    } catch (error) {
        report.passed = false; report.failure = error.stack;
        if (page && !page.isClosed()) {
            report.lastState = await page.evaluate(() => {
                const root = document.getElementById('fluent-read-platform-captions')?.shadowRoot;
                return {source: root?.querySelector('.source')?.textContent, translation: root?.querySelector('.translation')?.textContent};
            });
            await page.screenshot({path: path.join(artifacts, 'failure.png')});
        }
        throw error;
    } finally {
        await diagnostics.flush(); diagnostics.write(artifacts, report); await diagnostics.stop();
        if (session) await session.close(); if (profile) fs.rmSync(profile, {recursive: true, force: true});
        console.log(JSON.stringify({passed: report.passed, cases: report.cases.length, artifacts, failure: report.failure}));
    }
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
