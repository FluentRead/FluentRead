#!/usr/bin/env node
'use strict';
// 生产侧边栏专项：原生面板、临时 Chromium、可信 CDP 点击及本地确定性供应商；不操作用户浏览器或系统剪贴板。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const arg = name => {const index = process.argv.indexOf(`--${name}`);if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing --${name}`);return process.argv[index + 1];};
const extensionDir = path.resolve(arg('extension-dir'));
const artifactsDir = path.resolve(arg('artifacts-dir'));
const browserPathIndex = process.argv.indexOf('--browser-path');
const browserPath = browserPathIndex < 0 ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' : arg('browser-path');
const loadViaCdp = process.argv.includes('--load-via-cdp');
const {chromium} = require(path.join(arg('playwright-root'), 'playwright'));
const {PNG} = require(path.join(arg('playwright-root'), 'pngjs'));
const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground} = require(arg('focus-safe-helper'));
const {createRuntimeDiagnostics, finalizeRun} = require(arg('runtime-diagnostics-helper'));
const diagnostics = createRuntimeDiagnostics();
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-sidepanel-1160-'));
fs.mkdirSync(artifactsDir, {recursive: true});
const SOURCE = 'Copied text can be translated while you keep reading the current page.';
const TRANSLATION = '复制的文本可以在继续阅读当前网页时翻译。';
const service = 'custom:sidepanel-fixture';
const fixtures = Array.from({length: 16}, (_, index) => ({id: index === 0 ? service : `custom:sidepanel-fixture-${index + 1}`,
    name: index === 0 ? '侧栏测试服务' : index === 15 ? '测试服务 16 · 学术长文与技术文档对照' : `测试服务 ${index + 1}`,
    model: index === 0 ? 'fixture-model' : `fixture-model-${String(index + 1).padStart(2, '0')}`,
    translation: index === 0 ? TRANSLATION : index === 1 ? '继续阅读当前页面，同时翻译复制的文本。' : '阅读当前网页时，也能直接翻译复制的文字。'}));
const report = {ok: false, artifact: 'production', extensionDir, cases: [], screenshots: [], nativeDiagnostics: [], requests: [], aborts: 0,
    browserPath,
    evidenceBoundary: 'Native Chromium side panel from an actual extension-page click; production translation client, broker and local HTTP provider. Clipboard writes use a controlled port to preserve the user clipboard. No online provider, Firefox runtime or native toolbar-popup claim.',
    collectionGaps: ['Native sidepanel Runtime collection begins at target discovery; pre-attachment startup cannot be guaranteed. Other attached surfaces and workers are recorded by runtime-diagnostics.']};
let launched, context, browserSession, control, popup, native, origin, providerUrl, holdNext = false, failNext = false, releaseHeld;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, duration = 30000) {const end = Date.now() + duration;while (Date.now() < end) {if (await check()) return;await wait(70);}throw new Error(`${label}: timeout`);}
const server = http.createServer(async (request, response) => {
    response.setHeader('access-control-allow-origin', '*');response.setHeader('access-control-allow-headers', '*');
    if (request.method === 'OPTIONS') {response.writeHead(204);response.end();return;}
    if (request.method !== 'POST') {response.setHeader('content-type', 'text/html; charset=utf-8');response.end('<!doctype html><html><head><title>Sidebar fixture</title></head><body><p>Keep reading this page while the sidebar translates copied text.</p></body></html>');return;}
    const chunks = [];for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const text = body.messages.filter(item => item.role === 'user').map(item => item.content).join('\n');
    report.requests.push({source: /SOURCE_BEGIN([\s\S]*?)SOURCE_END/u.exec(text)?.[1] || text, model: body.model});
    response.on('close', () => {if (!response.writableEnded) report.aborts++;});
    if (failNext) {failNext = false;response.writeHead(400, {'content-type': 'application/json'});response.end(JSON.stringify({error: {message: 'sidepanel fixture rejected this request'}}));return;}
    if (holdNext) {holdNext = false;await new Promise(resolve => {releaseHeld = resolve;});}
    response.setHeader('content-type', 'application/json');response.end(JSON.stringify({id: 'sidepanel-fixture', object: 'chat.completion', model: body.model,
        choices: [{index: 0, message: {role: 'assistant', content: fixtures.find(item => item.model === body.model)?.translation || TRANSLATION}, finish_reason: 'stop'}]}));
});
async function page(url) {const result = await newPageWithoutForeground(context, 30000);await diagnostics.attachPage(result);await result.goto(url, {waitUntil: 'domcontentloaded'});return result;}
async function readConfig() {const result = await control.evaluate(() => chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'}));assert(result.success);return result.value;}
async function patch(values) {
    const current = await readConfig(), replace = Object.hasOwn(values, 'token');
    const result = await control.evaluate(({current, values, replace}) => chrome.runtime.sendMessage({type: 'persistConfig', mode: replace ? 'replace' : 'patch',
        config: replace ? {...current, ...values} : values, expected: Object.fromEntries(Object.keys(values).map(key => [key, current[key]])),
        baseRevision: replace ? current.__fluentConfigRevision || 0 : undefined, clientId: `sidepanel-${crypto.randomUUID()}`, sequence: 1}), {current, values, replace});
    assert.equal(result.success, true, result.error);
}
// Chromium 将原生侧边栏暴露为 other target；使用它自己的 CDP session，保留真实面板尺寸与用户手势。
async function attachNative(target) {
    const {sessionId} = await browserSession.send('Target.attachToTarget', {targetId: target.targetId, flatten: false});
    let sequence = 0;const pending = new Map();
    const listener = event => {
        if (event.sessionId !== sessionId) return;
        const message = JSON.parse(event.message);
        if (message.id) {const task = pending.get(message.id);if (!task) return;pending.delete(message.id);clearTimeout(task.timer);if (message.error) task.reject(new Error(message.error.message));else task.resolve(message.result);}
        else if (message.method === 'Runtime.exceptionThrown' || message.method === 'Runtime.consoleAPICalled' && ['warning', 'error'].includes(message.params.type)) report.nativeDiagnostics.push({phase: report.phase, method: message.method, params: message.params});
    };
    browserSession.on('Target.receivedMessageFromTarget', listener);
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++sequence, timer = setTimeout(() => {pending.delete(id);reject(new Error(`Native ${method}: timeout`));}, 15000);
        pending.set(id, {resolve, reject, timer});browserSession.send('Target.sendMessageToTarget', {sessionId, message: JSON.stringify({id, method, params})}).catch(reject);
    });
    await send('Runtime.enable');await send('Page.enable');
    return {send, target, async evaluate(fn, value) {
        const result = await send('Runtime.evaluate', {expression: `(${fn.toString()})(${JSON.stringify(value) ?? ''})`, returnByValue: true, awaitPromise: true, userGesture: true});
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description);return result.result.value;
    }, async dispose() {browserSession.off('Target.receivedMessageFromTarget', listener);for (const task of pending.values()) {clearTimeout(task.timer);task.reject(new Error('Native target closed'));}pending.clear();await browserSession.send('Target.detachFromTarget', {sessionId});}};
}
async function openNative() {
    await popup.locator('[data-testid="sidebar-translation"]:not(:disabled)').click();
    let target;await until(async () => {target = (await browserSession.send('Target.getTargets')).targetInfos.find(item => item.url === `${origin}/sidepanel.html`);return target;}, 'native target');
    native = await attachNative(target);
    try {await until(() => native.evaluate(() => Boolean(document.querySelector('.translation-center.is-sidebar .translate-primary-button'))), 'native Vue mount');}
    catch (error) {report.nativeMountFailure = await native.evaluate(() => ({url: location.href, ready: document.readyState, body: document.body.innerText, app: document.querySelector('#app')?.innerHTML.slice(0, 1500)}));throw error;}
    report.nativeTarget = {type: target.type, url: target.url};
    report.userAgent = await native.evaluate(() => navigator.userAgent);
    await native.evaluate(() => {window.__sidepanelDocumentId ||= crypto.randomUUID();});
}
async function nativeClick(selector) {
    const point = await native.evaluate(selector => {const node = document.querySelector(selector);if (!node || node.disabled) throw new Error(`Unavailable ${selector}`);node.scrollIntoView({block: 'center'});const r = node.getBoundingClientRect();return {x: r.x + r.width / 2, y: r.y + r.height / 2};}, selector);
    await native.send('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, ...point});
    await native.send('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, ...point});
}
async function input(text, selector = 'textarea') {
    await native.evaluate(selector => {const node = document.querySelector(selector);node.focus();node.value = '';node.dispatchEvent(new Event('input', {bubbles: true}));}, selector);
    await native.send('Input.insertText', {text});
}
async function screenshot(name) {
    const result = await native.send('Page.captureScreenshot', {format: 'png'}), bytes = Buffer.from(result.data, 'base64');
    const file = path.join(artifactsDir, name + '.png');fs.writeFileSync(file, bytes);report.screenshots.push(file);
    if (name === 'native-sidebar-translated' || name === 'native-sidebar-dark') {
        const rgba = [...PNG.sync.read(bytes).data.subarray(0, 4)];
        (report.themePixels ||= {})[name] = rgba;
        assert(rgba.slice(0, 3).every(channel => name === 'native-sidebar-dark' ? channel < 100 : channel > 220), `${name}: native surface overrode the selected theme (${rgba})`);
    }
}
async function geometry(label) {
    const result = await native.evaluate(() => {
        const root = document.querySelector('.translation-center'), ids = [...document.querySelectorAll('[id]')].map(node => node.id);
        return {width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, rootWidth: root.clientWidth, rootScrollWidth: root.scrollWidth,
            editorHeight: document.querySelector('.translation-editor').getBoundingClientRect().height,
            serviceControlHeight: document.querySelector('.add-service-button').getBoundingClientRect().height,
            colorScheme: getComputedStyle(document.documentElement).colorScheme, background: getComputedStyle(root).backgroundColor, dark: document.documentElement.classList.contains('dark'),
            duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index)};
    });
    assert(result.scrollWidth <= result.width + 1 && result.rootScrollWidth <= result.rootWidth + 1, `${label} horizontal overflow: ${JSON.stringify(result)}`);assert.equal(result.duplicateIds.length, 0);
    assert.equal(result.editorHeight, 144, `${label}: sidebar editor expanded into the reading space`);
    assert(result.serviceControlHeight <= 30, `${label}: service control expanded vertically`);
    report.cases.push({name: label, geometry: result});
}
async function main() {
    let primaryError;
    try {
        await new Promise((resolve, reject) => {server.once('error', reject);server.listen(0, '127.0.0.1', resolve);});providerUrl = `http://127.0.0.1:${server.address().port}`;
        const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json')));
        assert.equal(manifest.side_panel.default_path, 'sidepanel.html');assert(manifest.permissions.includes('sidePanel'));
        report.manifest = {version: manifest.version, sidebar: manifest.side_panel.default_path, permission: 'sidePanel'};
        launched = await launchFocusSafePersistentContext({chromium, profileDir, background: true, headless: false,
            browserPath, viewport: {width: 1280, height: 900}, displayTarget: 'secondary', timeout: 30000,
            browserArgs: [...(loadViaCdp ? ['--enable-unsafe-extension-debugging'] : [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]), '--no-first-run', '--no-default-browser-check']});
        ({context} = launched);Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
        assert.equal(report.windowPlacement.browserFrontmost, false);await diagnostics.start(context);
        browserSession = await context.browser().newBrowserCDPSession();
        assert(manifest.key, 'This production fixture needs the fixed manifest public key');
        const id = loadViaCdp ? (await browserSession.send('Extensions.loadUnpacked', {path: extensionDir})).id
            : createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, hex => String.fromCharCode(97 + parseInt(hex, 16)));
        diagnostics.setExtensionId(id);origin = `chrome-extension://${id}`;control = await page(`${origin}/popup.html`);
        await until(async () => (await readConfig())?.service, 'configuration');const initial = await readConfig();
        await patch({on: true, uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, theme: 'light', interfaceSkin: 'default', animations: false,
            service, translationCenterServices: [service], translationCenterSourceLanguage: 'en', translationCenterTargetLanguage: 'zh-Hans', translationCenterLayout: 'grid',
            model: {...initial.model, ...Object.fromEntries(fixtures.map(item => [item.id, item.model]))}, token: Object.fromEntries(fixtures.map(item => [item.id, 'synthetic-local-fixture'])),
            user_role: {...initial.user_role, ...Object.fromEntries(fixtures.map(item => [item.id, 'SOURCE_BEGIN{{origin}}SOURCE_END']))},
            customOpenAIProviders: fixtures.map(item => ({id: item.id, name: item.name, endpoint: providerUrl + '/v1/chat/completions', models: [item.model]})),
            autoTranslate: false, disableFloatingBall: true, selectionTranslatorMode: 'disabled', enableAIContext: false, enableAIMultiSegment: false, glossaryEnabled: false});
        const content = await page(providerUrl + '/article');
        const sourceTab = await control.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), content.url());
        assert(sourceTab?.id); // 只让已核验身份的 FluentRead 页面激活它的夹具，不选浏览器自带的其他扩展 worker。
        await control.evaluate(tabId => chrome.tabs.update(tabId, {active: true}), sourceTab.id);
        popup = await newPageWithoutForeground(context, 30000);await diagnostics.attachPage(popup);
        await popup.addInitScript(() => {window.close = () => {window.__popupClosed = true;};});
        await popup.goto(`${origin}/popup.html?sourceTabId=${sourceTab.id}`);await popup.locator('.popup-shell[data-config-ready="true"]').waitFor();
        const popupShot = path.join(artifactsDir, 'popup-sidebar-entry.png');await popup.locator('.popup-shell').screenshot({path: popupShot});report.screenshots.push(popupShot);
        report.phase = 'native-open';diagnostics.setPhase(report.phase);await openNative();await geometry('native sidebar initial');
        report.nativeLifecycle = await native.evaluate(async () => ({windowId: (await chrome.windows.getCurrent()).id, visible: document.visibilityState,
            opened: Boolean(chrome.sidePanel.onOpened), closed: Boolean(chrome.sidePanel.onClosed)}));
        await control.evaluate(() => {
            window.__panelEvents = [];
            chrome.sidePanel.onClosed?.addListener(info => window.__panelEvents.push({type: 'closed', ...info}));
            chrome.sidePanel.onOpened?.addListener(info => window.__panelEvents.push({type: 'opened', ...info}));
        });
        const scheme = await native.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
        assert(scheme.includes('light') && scheme.includes('only'));
        assert.equal(await popup.evaluate(() => window.__popupClosed), true);assert.equal((await readConfig()).translationCenterLayout, 'grid');
        await native.evaluate(() => {Object.defineProperty(navigator, 'clipboard', {value: {writeText: async text => {window.__copiedText = text;}}, configurable: true});});
        await input(SOURCE);await nativeClick('.translate-primary-button');
        await until(() => native.evaluate(text => document.querySelector('.translation-result-content p')?.textContent === text, TRANSLATION), 'native translation');
        assert.equal(report.requests[0].source, SOURCE);await screenshot('native-sidebar-translated');
        await nativeClick('.sidebar-copy-button');assert.equal(await native.evaluate(() => window.__copiedText), TRANSLATION);
        report.cases.push({name: 'native paste, translate and copy', passed: true});
        await activateExtensionTabWithoutForeground(context, control);await control.evaluate(tabId => chrome.tabs.update(tabId, {active: true}), sourceTab.id);
        assert.equal(await native.evaluate(() => document.querySelector('textarea').value), SOURCE);report.cases.push({name: 'tab switching preserves input and result', passed: true});
        report.phase = 'stop-retry';diagnostics.setPhase(report.phase);holdNext = true;const count = report.requests.length;
        await nativeClick('.translate-primary-button');await until(() => report.requests.length > count, 'held provider request');
        const stoppedAborts = report.aborts;
        await nativeClick('.translate-stop-button');await until(() => native.evaluate(() => !document.querySelector('.translate-stop-button')), 'stop settles');
        await until(() => report.aborts > stoppedAborts, 'stop aborts upstream provider');releaseHeld();
        await until(() => native.evaluate(() => document.querySelector('.translation-result-card')?.dataset.status === 'cancelled'), 'late result rejected');
        await nativeClick('.translation-result-placeholder button');await until(() => native.evaluate(() => document.querySelector('.translation-result-card')?.dataset.status === 'success'), 'retry after stop');
        failNext = true;await nativeClick('.translate-primary-button');await until(() => native.evaluate(() => Boolean(document.querySelector('.translation-result-error'))), 'failure visible');
        await nativeClick('.translation-result-error button');await until(() => native.evaluate(() => document.querySelector('.translation-result-card')?.dataset.status === 'success'), 'retry after failure');
        report.cases.push({name: 'stop, late response isolation, failure and retry', passed: true});
        report.phase = 'multi-service';diagnostics.setPhase(report.phase);
        await patch({translationCenterServices: [service, fixtures[1].id]});
        await until(() => native.evaluate(() => document.querySelector('.service-picker-count')?.textContent === '2'), 'shared comparison selection');
        await nativeClick('.add-service-button');await input(fixtures[15].model, '.service-picker-search input');
        await until(() => native.evaluate(() => document.querySelectorAll('.service-picker-option').length === 1), 'search a model among sixteen configured providers');
        await nativeClick('.service-picker-option');
        const compared = [fixtures[0], fixtures[1], fixtures[15]];
        await until(async () => JSON.stringify((await readConfig()).translationCenterServices) === JSON.stringify(compared.map(item => item.id)), 'multi-selection persists');
        assert.equal(await native.evaluate(() => document.querySelector('.service-picker-option').getAttribute('aria-pressed')), 'true');
        await nativeClick('.service-picker-close');assert.equal(await native.evaluate(() => document.querySelector('textarea').value), SOURCE);
        const compareStart = report.requests.length;await nativeClick('.translate-primary-button');
        await until(() => native.evaluate(expected => expected.every(item => document.querySelector(`[data-service="${item.id}"] .translation-result-content p`)?.textContent === item.translation), compared), 'three attributed translations');
        assert.deepEqual(report.requests.slice(compareStart).map(item => item.model).sort(), compared.map(item => item.model).sort());
        assert.equal(await native.evaluate(() => document.querySelector('.sidepanel-header h1').textContent), '翻译中心');
        const attribution = await native.evaluate(() => [...document.querySelectorAll('.translation-result-card')].map(card => ({
            service: card.dataset.service, name: card.querySelector('.translation-result-service-name strong').textContent,
            model: card.querySelector('.translation-result-service-name small').textContent,
        })));
        assert.deepEqual(attribution, compared.map(item => ({service: item.id, name: item.name, model: item.model})));
        await nativeClick(`[data-service="${fixtures[15].id}"] .translation-result-content footer button`);
        assert.equal(await native.evaluate(() => window.__copiedText), fixtures[15].translation);
        await native.evaluate(() => {document.querySelector('.translation-center').scrollTop = 0;});
        await geometry('native sidebar multi-service comparison');await screenshot('native-sidebar-multi-translated');
        // 设置页读取同一份选择；重开页面也不能把侧栏多选截断成一个服务。
        const settings = await page(`${origin}/options.html#settings-translation-center`);
        await settings.locator('.translation-center:not(.is-sidebar) .translation-result-card').first().waitFor();
        assert.deepEqual(await settings.locator('.translation-result-card').evaluateAll(cards => cards.map(card => card.dataset.service)), compared.map(item => item.id));
        await settings.reload();await settings.locator('.translation-center:not(.is-sidebar) .translation-result-card').first().waitFor();
        assert.deepEqual(await settings.locator('.translation-result-card').evaluateAll(cards => cards.map(card => card.dataset.service)), compared.map(item => item.id));
        await settings.close();
        report.cases.push({name: 'sixteen configured services, searchable multi-select, three attributed results and settings-page persistence', providers: fixtures.length, selected: compared.length, attribution, passed: true});
        await nativeClick('.add-service-button');await until(() => native.evaluate(() => Boolean(document.querySelector('.service-picker-popover'))), 'service menu');
        const serviceScroll = await native.evaluate(() => {const groups = document.querySelector('.service-picker-groups');return {height: groups.clientHeight, scrollHeight: groups.scrollHeight};});
        assert(serviceScroll.scrollHeight > serviceScroll.height);report.serviceScroll = serviceScroll;
        await geometry('native sidebar service menu');await screenshot('native-sidebar-services');await nativeClick('.service-picker-close');
        await native.send('Emulation.setDeviceMetricsOverride', {width: 320, height: 480, deviceScaleFactor: 1, mobile: false});
        await geometry('native sidebar emulated 320x480');await nativeClick('.add-service-button');
        const menu = await native.evaluate(() => {const r = document.querySelector('.service-picker-popover').getBoundingClientRect();return {top: r.top, bottom: r.bottom, height: innerHeight};});
        assert(menu.top >= 0 && menu.bottom <= menu.height);await screenshot('native-sidebar-narrow-services');await nativeClick('.service-picker-close');
        await native.send('Emulation.clearDeviceMetricsOverride');
        await patch({translationCenterServices: [service]});await until(() => native.evaluate(() => !document.querySelector('.service-picker-count')), 'restore single service for lifecycle check');
        await patch({theme: 'dark'});await until(() => native.evaluate(() => document.documentElement.classList.contains('dark')), 'dark theme');await screenshot('native-sidebar-dark');
        report.phase = 'close-reopen';diagnostics.setPhase(report.phase);holdNext = true;const closing = report.requests.length;
        await nativeClick('.translate-primary-button');await until(() => report.requests.length > closing, 'closing provider request');
        const targetId = native.target.targetId, closedAborts = report.aborts;
        const documentBeforeClose = await native.evaluate(() => window.__sidepanelDocumentId);await native.dispose();native = undefined;
        report.closeMethod = await control.evaluate(async windowId => {
            if (typeof chrome.sidePanel.close !== 'function') return 'Target.closeTarget';
            await chrome.sidePanel.close({windowId});return 'sidePanel.close';
        }, sourceTab.windowId);
        if (report.closeMethod === 'Target.closeTarget') await browserSession.send('Target.closeTarget', {targetId});
        try {await until(() => report.aborts > closedAborts, 'close aborts upstream provider');}
        catch (error) {report.closeEvents = await control.evaluate(() => window.__panelEvents);throw error;}
        releaseHeld();
        const requestsBeforeReopen = report.requests.length;await openNative();
        const documentReused = documentBeforeClose === await native.evaluate(() => window.__sidepanelDocumentId);
        assert.equal(await native.evaluate(() => document.querySelector('textarea').value), documentReused ? SOURCE : '');
        assert.equal(await native.evaluate(() => document.querySelector('.translation-result-card')?.dataset.status ?? null), documentReused ? 'cancelled' : null);
        assert.equal(report.requests.length, requestsBeforeReopen);
        report.cases.push({name: 'close stops upstream; reopening respects document lifetime without restarting translation', documentReused, passed: true});
        assert.equal(report.nativeDiagnostics.length, 0, JSON.stringify(report.nativeDiagnostics));
        await newPageWithoutForeground(context, 30000); // 交付前再次验证窗口位置与未抢前台。
        await diagnostics.flush();diagnostics.assertClean();report.ok = true;
    } catch (error) {primaryError = error;report.error = error.stack || String(error);process.exitCode = 1;}
    finally {
        releaseHeld?.();
        await finalizeRun({diagnostics, result: report, artifactsDir, primaryError, cleanup: [
            {stage: 'native-session', action: async () => native?.dispose()},
            {stage: 'browser-session', action: async () => browserSession?.detach()},
            {stage: 'browser', action: async () => launched?.close()},
            {stage: 'http', action: async () => {server.closeAllConnections();await new Promise(resolve => server.close(resolve));}},
            {stage: 'profile', action: async () => fs.rmSync(profileDir, {recursive: true, force: true})},
        ], emitReport: () => console.log(JSON.stringify({ok: report.ok, cases: report.cases.length, error: report.error, artifactsDir}))});
    }
}
main().catch(error => {console.error(error);process.exitCode = 1;});
