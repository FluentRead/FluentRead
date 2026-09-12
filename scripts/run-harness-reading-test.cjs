#!/usr/bin/env node
// 在隔离、可见但不抢焦点的 Edge profile 中验证 ReadingPanel 与真实 Harness gateway。
// 本脚本只操作临时 profile；fixture API 只模拟模型/TTS HTTP，保留扩展后台、真实音频播放器及消息路由。
// 测试浏览器始终静音；朗读结果只证明播放/停止链路，不代表发音或听感验证。
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const { createRequire } = require('node:module');
function arg(argv, name, fallback) { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; }
function parseArgs(argv) {
    const out = {
        extensionDir: path.resolve(arg(argv, 'extension-dir', '.output/chrome-mv3')),
        playwrightRoot: arg(argv, 'playwright-root', process.env.PLAYWRIGHT_ROOT),
        artifactsDir: path.resolve(arg(argv, 'artifacts-dir', path.join(os.tmpdir(), 'fluentread-harness-reading-test'))),
        browserPath: arg(argv, 'browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
        focusSafeHelper: arg(argv, 'focus-safe-helper', ''), triggerOnly: argv.includes('--triggers-only'), themeOnly: argv.includes('--theme-only'), persistenceOnly: argv.includes('--persistence-only'), headed: argv.includes('--headed'),
    };
    if (!out.playwrightRoot)
        throw new Error('必须传入 --playwright-root');
    if (!fs.existsSync(path.join(out.extensionDir, 'manifest.json')))
        throw new Error(`找不到扩展产物：${out.extensionDir}`);
    if (!out.headed && !out.focusSafeHelper)
        throw new Error('后台模式必须传入 --focus-safe-helper');
    return out;
}
function loadPlaywright(root) { try {
    return require('playwright');
}
catch {
    return createRequire(path.join(path.resolve(root), '__harness_runner__.cjs'))('playwright');
} }
function assert(ok, message) { if (!ok)
    throw new Error(message); }
async function waitUntil(predicate, message, timeout = 10000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Error(message);
}
function parseStored(value) { if (typeof value !== 'string')
    return value || {}; try {
    return JSON.parse(value) || {};
}
catch {
    return {};
} }
async function send(page, message) { return page.evaluate((request) => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`消息超时: ${request.type}`)), 10000); chrome.runtime.sendMessage(request, (response) => { const error = chrome.runtime.lastError?.message; clearTimeout(timer); error ? reject(new Error(error)) : resolve(response); }); }), message); }
async function selectSettingsOption(page, label, option) {
    const combobox = page.getByRole('combobox', {name: label, exact: true});
    // Element Plus 的选中值覆盖只读 input；点击用户实际操作的外层控件，不绕过可点击性检查。
    await combobox.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " el-select__wrapper ")][1]').click();
    await page.getByRole('option', {name: option, exact: true}).click();
}
function silentWav(seconds = 8) {
    const sampleRate = 24000, bytes = sampleRate * seconds * 2;
    const audio = Buffer.alloc(44 + bytes);
    audio.write('RIFF', 0); audio.writeUInt32LE(36 + bytes, 4); audio.write('WAVEfmt ', 8);
    audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
    audio.writeUInt32LE(sampleRate, 24); audio.writeUInt32LE(sampleRate * 2, 28);
    audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(bytes, 40);
    return audio;
}
function buildProvenance(extensionDir) {
    const root = path.resolve(__dirname, '..');
    const filesBelow = dir => fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => entry.isDirectory() ? filesBelow(path.join(dir, entry.name)) : entry.isFile() ? [path.join(dir, entry.name)] : []);
    const hashFiles = (files, base) => files.sort().map(file => ({path: path.relative(base, file), sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}));
    const sourceFiles = hashFiles(['src', 'entrypoints'].flatMap(dir => filesBelow(path.join(root, dir))).concat(['package.json', 'pnpm-lock.yaml', 'wxt.config.ts', 'scripts/run-harness-reading-test.cjs'].map(file => path.join(root, file))), root);
    const buildFiles = hashFiles(filesBelow(extensionDir), extensionDir);
    return {
        capturedAt: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
        sourceDigest: crypto.createHash('sha256').update(JSON.stringify(sourceFiles)).digest('hex'), sourceFiles,
        extensionDigest: crypto.createHash('sha256').update(JSON.stringify(buildFiles)).digest('hex'), extensionFiles: buildFiles,
    };
}
async function openLearningRecords(page, extensionId) {
    const url = `chrome-extension://${extensionId}/options.html#settings-vocabulary`;
    // 同一地址重新查看记录时实际重载，覆盖后台变化与 IndexedDB fixture 的重新读取。
    if (page.url() === url) await page.reload({waitUntil: 'domcontentloaded'});
    else await page.goto(url, {waitUntil: 'domcontentloaded'});
    const sections = page.getByRole('radiogroup', {name: '学习内容', exact: true});
    await sections.getByRole('radio', {name: '阅读记录', exact: true}).click();
    await page.locator('.harness-history-body').waitFor();
}
async function openLearningMemories(page, extensionId) {
    const url = `chrome-extension://${extensionId}/options.html#settings-vocabulary`;
    // 重载验证持久化；只变 hash 的跨设置导航仍使用 goto，以验证真实路由响应。
    if (page.url() === url) await page.reload({waitUntil: 'domcontentloaded'});
    else await page.goto(url, {waitUntil: 'domcontentloaded'});
    await page.getByRole('radiogroup', {name: '学习内容', exact: true}).getByRole('radio', {name: '学习记忆', exact: true}).click();
    await page.locator('.fr-learning-memory').waitFor();
    await page.locator('.fr-learning-memory').getByRole('button', {name: '添加记忆', exact: true}).waitFor();
}
async function addLearningMemoryInUi(page, content, kind = 'preference') {
    const manager = page.locator('.fr-learning-memory');
    await manager.getByRole('button', {name: '添加记忆', exact: true}).click();
    await manager.getByRole('combobox', {name: '记忆类型', exact: true}).selectOption(kind);
    await manager.getByRole('textbox', {name: '记忆内容', exact: true}).fill(content);
    await manager.getByRole('button', {name: '保存', exact: true}).click();
    await manager.locator('.fr-memory-editor').waitFor({state: 'hidden'});
}
async function optionsTarget(context, section) {
    let target;
    await waitUntil(() => {
        target = context.pages().find(page => !page.isClosed() && page.url().startsWith('chrome-extension://') && page.url().endsWith(`#${section}`));
        return Boolean(target);
    }, `点击阅读卡按钮后没有实际打开 ${section}`);
    await target.locator(`#${section}`).first().waitFor({state: 'visible'});
    return target;
}
async function readConfig(page) { const [configResponse, credentialResponse] = await Promise.all([send(page, { type: 'configStorageRead', key: 'local:config' }), send(page, { type: 'configStorageRead', key: 'local:credentials' })]); assert(configResponse?.success === true && credentialResponse?.success === true, `配置读取失败: ${JSON.stringify({ configResponse, credentialResponse })}`); const config = parseStored(configResponse.value); const credentials = parseStored(credentialResponse.value); return { ...config, ...credentials }; }
async function persistConfig(page, patch) {
    const current = await readConfig(page);
    const response = await send(page, { type: 'persistConfig', config: { ...current, ...patch }, clientId: `harness-fixture-${process.pid}`, sequence: Date.now(), baseRevision: current.__fluentConfigRevision });
    assert(response?.success === true, `配置保存失败: ${JSON.stringify(response)}`);
    await page.waitForTimeout(400);
    return readConfig(page);
}
function cdpChildren(node) { return [...(node?.children || []), ...(node?.shadowRoots || []), ...(node?.contentDocument ? [node.contentDocument] : [])]; }
function attr(node, name) { const a = node?.attributes || []; for (let i = 0; i < a.length; i += 2)
    if (a[i] === name)
        return a[i + 1] || ''; return ''; }
function find(node, predicate) { if (!node)
    return null; if (predicate(node))
    return node; for (const child of cdpChildren(node)) {
    const hit = find(child, predicate);
    if (hit)
        return hit;
} return null; }
function text(node) { return !node ? '' : node.nodeName === '#text' ? node.nodeValue || '' : cdpChildren(node).map(text).join(''); }
async function shadowSnapshot(page) { const session = await page.context().newCDPSession(page); const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true }); const host = find(root, n => attr(n, 'id') === 'fluent-read-selection-translator-container'); return { host, text: text(host), session }; }
async function clickShadowButton(page, label) { const { host, session } = await shadowSnapshot(page); const buttons = []; const collect = node => { if (!node)
    return; if (node.nodeName?.toLowerCase() === 'button')
    buttons.push({ aria: attr(node, 'aria-label'), text: text(node).trim(), nodeId: node.nodeId }); for (const child of cdpChildren(node))
    collect(child); }; collect(host); const button = find(host, n => n.nodeName?.toLowerCase() === 'button' && (attr(n, 'aria-label') === label || text(n).trim() === label)); assert(button?.nodeId, `找不到闭合 Shadow 按钮: ${label}; buttons=${JSON.stringify(buttons)}`); const box = await session.send('DOM.getBoxModel', { nodeId: button.nodeId }); const quad = box.model?.content || box.model?.border; assert(quad?.length >= 8, `按钮没有可点击几何位置: ${label}; box=${JSON.stringify(box)}`); const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4; const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4; await session.send('DOM.focus', { nodeId: button.nodeId }).catch(() => { }); await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }); await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); return { buttons, x, y }; }
async function fillShadowInput(page, label, value) { const { host, session } = await shadowSnapshot(page); const input = find(host, n => n.nodeName?.toLowerCase() === 'input' && attr(n, 'aria-label') === label); assert(input?.nodeId, `找不到闭合 Shadow 输入框: ${label}`); const resolved = await session.send('DOM.resolveNode', { nodeId: input.nodeId }); await session.send('Runtime.callFunctionOn', { objectId: resolved.object.objectId, functionDeclaration: `function(value) { this.focus(); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(this, value); this.dispatchEvent(new Event('input', {bubbles: true})); }`, arguments: [{ value }] }); await session.send('Runtime.releaseObject', { objectId: resolved.object.objectId }).catch(() => { }); }
async function clickShadowFirstSession(page) { const { host, session } = await shadowSnapshot(page); const node = find(host, n => n.nodeName?.toLowerCase() === 'button' && attr(n, 'class').split(' ').includes('fr-reading-session')); assert(node?.nodeId, '最近会话列表没有可恢复的历史按钮'); const box = await session.send('DOM.getBoxModel', { nodeId: node.nodeId }); const quad = box.model?.content || box.model?.border; assert(quad?.length >= 8, '最近会话按钮没有可点击几何位置'); const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4; const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4; await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', clickCount: 1}); await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button: 'left', clickCount: 1}); }
async function clickShadowSummary(page, label) { const {host, session} = await shadowSnapshot(page); const node = find(host, n => n.nodeName?.toLowerCase() === 'summary' && text(n).trim() === label); assert(node?.nodeId, `找不到闭合 Shadow summary: ${label}`); const box = await session.send('DOM.getBoxModel', {nodeId: node.nodeId}); const quad = box.model?.content || box.model?.border; assert(quad?.length >= 8, `summary 没有可点击几何位置: ${label}`); const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4; const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4; await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', clickCount: 1}); await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button: 'left', clickCount: 1}); }
function findAll(node, predicate, out = []) { if (!node) return out; if (predicate(node)) out.push(node); for (const child of cdpChildren(node)) findAll(child, predicate, out); return out; }
async function currentReadingAnswer(page) {
    const snapshot = await shadowSnapshot(page);
    const answer = find(snapshot.host, node => attr(node, 'class').split(' ').includes('fr-reading-answer'));
    return text(answer).trim();
}
async function verifyReadingTheme({page, configPage, requests, record, args, result}) {
    const inspect = async (id, expectedDark) => {
        const {host, session} = await shadowSnapshot(page);
        const panel = find(host, node => attr(node, 'data-reading-panel') !== '' || attr(node, 'class').split(' ').includes('fr-reading'));
        assert(panel?.nodeId, '主题检查缺少阅读面板');
        const {object} = await session.send('DOM.resolveNode', {nodeId: panel.nodeId});
        const measured = await session.send('Runtime.callFunctionOn', {
            objectId: object.objectId, returnByValue: true,
            functionDeclaration: `function() {
                const surface = this.closest('.fr-translation-tooltip');
                const rgb = value => value.match(/[\\d.]+/g).map(Number);
                const blend = (front, back) => front.slice(0, 3).map((v, i) => v * (front[3] ?? 1) + back[i] * (1 - (front[3] ?? 1)));
                const background = node => {
                    if (!node) return [255, 255, 255];
                    const color = rgb(getComputedStyle(node).backgroundColor);
                    return blend(color, (color[3] ?? 1) === 1 ? color : background(node.parentElement));
                };
                const luminance = color => color.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
                const contrast = (foreground, bg) => {
                    const a = luminance(blend(rgb(foreground), bg)), b = luminance(bg);
                    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
                };
                const samples = [...this.querySelectorAll('p,h3,h4,li,span,strong,em,code,blockquote,th,td,button,input,summary,small')]
                    .filter(node => node.getClientRects().length && !node.closest(':disabled') && (node.matches('input') || [...node.childNodes].some(child => child.nodeType === 3 && child.textContent.trim())))
                    .map(node => ({tag: node.tagName, className: node.className, text: (node.textContent || node.placeholder || '').slice(0, 60), color: getComputedStyle(node).color, background: background(node), ratio: contrast(getComputedStyle(node).color, background(node))}));
                const input = this.querySelector('input:not(:disabled)');
                if (input) samples.push({tag: 'placeholder', ratio: contrast(getComputedStyle(input, '::placeholder').color, background(input))});
                return {dark: surface.classList.contains('fr-dark-theme'), samples, richElements: [...this.querySelectorAll('.fr-reading-markdown blockquote,.fr-reading-markdown code,.fr-reading-markdown th,.fr-reading-markdown td')].map(node => node.tagName)};
            }`,
        });
        await session.send('Runtime.releaseObject', {objectId: object.objectId});
        await session.detach();
        const details = measured.result.value;
        assert(details?.samples?.length, `没有获取到文字对比度: ${JSON.stringify(measured)}`);
        const failures = details.samples.filter(sample => sample.ratio < 4.5);
        const screenshot = path.join(args.artifactsDir, `${id}.png`);
        await page.screenshot({path: screenshot}); result.screenshots.push(screenshot);
        record(id, details.dark === expectedDark && !failures.length ? 'passed' : 'failed', {...details, failures});
        assert(details.dark === expectedDark, `${id} 未应用预期主题`);
        assert(!failures.length, `${id} 文字对比度低于 4.5:1: ${JSON.stringify(failures)}`);
        return details;
    };
    await page.emulateMedia({colorScheme: 'light'});
    await persistConfig(configPage, {theme: 'dark'});
    await clickShadowButton(page, '读懂');
    await waitUntil(async () => (await shadowSnapshot(page)).text.includes('正在'), '未显示生成状态');
    await inspect('theme-streaming-dark', true);
    await waitForReadingComplete(page);
    const firstAnswer = await currentReadingAnswer(page);
    const beforeThemes = requests.length;
    for (const [theme, system, dark] of [['dark', 'light', true], ['light', 'dark', false], ['auto', 'light', false], ['auto', 'dark', true], ['auto', 'light', false]]) {
        await page.emulateMedia({colorScheme: system});
        await persistConfig(configPage, {theme});
        const details = await inspect(`theme-${result.cases.length}-${theme}-${system}`, dark);
        assert(['BLOCKQUOTE', 'CODE', 'TH', 'TD'].every(tag => details.richElements.includes(tag)), '没有测试到引用、代码和表格的实际回答');
        assert(await currentReadingAnswer(page) === firstAnswer && requests.length === beforeThemes, '切换主题重置了回答或调用了模型');
    }
    await persistConfig(configPage, {theme: 'dark'});
    const hostBefore = await page.locator('#neighbor').evaluate(node => ({text: node.textContent, color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor}));
    await clickShadowButton(page, '阅读记录');
    await waitForShadowButton(page, '返回当前阅读');
    await inspect('theme-history-dark', true);
    await clickShadowButton(page, '返回当前阅读');
    await clickShadowButton(page, '关闭翻译结果');
    await page.locator('#target').click({position: {x: 1, y: 12}});
    await selectFixtureSentence(page);
    await clickShadowButton(page, '读懂');
    await waitForReadingComplete(page);
    await inspect('theme-reopened-dark', true);
    const hostAfter = await page.locator('#neighbor').evaluate(node => ({text: node.textContent, color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor}));
    assert(JSON.stringify(hostBefore) === JSON.stringify(hostAfter), '阅读主题或开关卡片改变了宿主段落');
    record('theme-host-unchanged', 'passed', hostAfter);
    await persistConfig(configPage, {token: {'custom:fixture': ''}});
    await clickShadowButton(page, '重新生成');
    await waitForShadowButton(page, '重试');
    await inspect('theme-error-dark', true);
    await persistConfig(configPage, {token: {'custom:fixture': 'fixture-token'}});
    await clickShadowButton(page, '重试');
    await waitForReadingComplete(page);
    await inspect('theme-retry-dark', true);
}
async function waitForShadowButton(page, label, timeout = 10000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        const snapshot = await shadowSnapshot(page);
        const button = find(snapshot.host, node => node.nodeName?.toLowerCase() === 'button' && (attr(node, 'aria-label') === label || text(node).trim() === label));
        if (button) return snapshot;
        await page.waitForTimeout(80);
    }
    throw new Error(`没有等到阅读卡按钮: ${label}`);
}
async function selectFixtureSentence(page) {
    const box = await page.locator('#target').boundingBox();
    assert(box, '原文没有可选择的几何位置');
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, {steps: 10});
    await page.mouse.up();
    await page.waitForTimeout(450);
    return page.evaluate(() => getSelection()?.toString().trim() || '');
}
async function verifyCardTriggers({page, configPage, requests, record, args, result}) {
    const state = async () => {
        const {host} = await shadowSnapshot(page);
        const root = find(host, n => attr(n, 'class').split(' ').includes('fr-selection-translator-root'));
        const visible = root && !attr(root, 'style').includes('display: none');
        return {toolbar: Boolean(visible && find(root, n => attr(n, 'class').split(' ').includes('fr-reading-indicator'))), card: Boolean(visible && find(root, n => attr(n, 'class').split(' ').includes('fr-translation-tooltip')))};
    };
    const setup = async (patch) => {
        await persistConfig(configPage, {selectionTranslatorMode: 'disabled', disableSelectionTranslator: true, harness: {...(await readConfig(configPage)).harness, enabled: true, ...patch}});
        await page.reload({waitUntil: 'domcontentloaded'});
        await page.waitForTimeout(700);
        await page.evaluate(() => {
            const button = document.createElement('button'); button.id = 'retains-selection'; button.textContent = 'Other action';
            button.style.cssText = 'position:fixed;right:24px;bottom:24px';
            button.addEventListener('pointerdown', event => event.preventDefault());
            button.addEventListener('click', () => {window.__otherActionClicks = (window.__otherActionClicks || 0) + 1;});
            document.body.append(button);
        });
        await selectFixtureSentence(page);
    };
    const hoverAction = async (label) => {
        const {host, session} = await shadowSnapshot(page);
        const toolbar = find(host, n => attr(n, 'class').split(' ').includes('fr-reading-indicator'));
        const button = find(toolbar, n => n.nodeName === 'BUTTON' && text(n).trim() === label);
        assert(button, `没有悬停动作 ${label}`);
        const {model} = await session.send('DOM.getBoxModel', {nodeId: button.nodeId});
        const quad = model.border;
        await page.mouse.move((quad[0] + quad[2]) / 2, (quad[1] + quad[5]) / 2);
    };
    await setup({trigger: 'click'});
    const reselect = async () => {
        // 先完成原生单击以结束已有选区，避免拖动已选文字进入浏览器的原生拖放流程。
        await page.locator('#target').click({position: {x: 1, y: 12}});
        const text = await selectFixtureSentence(page);
        assert(text.includes('Although'), `重新划词没有产生目标选区: ${text}`);
    };
    const beforeClick = requests.length;
    assert((await state()).toolbar, '默认点击模式没有浮条');
    await hoverAction('读懂'); await page.waitForTimeout(800);
    assert(!(await state()).card && requests.length === beforeClick, '默认模式悬停触发了模型');
    record('trigger.click-default-no-hover-request', 'passed');
    const selected = await page.evaluate(() => getSelection().toString());
    await page.locator('#retains-selection').click(); await page.waitForTimeout(1900);
    assert(await page.evaluate(() => getSelection().toString()) === selected, '测试按钮未保留选区');
    assert(!(await state()).toolbar && !(await state()).card && requests.length === beforeClick, '外部按钮保留选区后重新显示或请求');
    assert(await page.evaluate(() => window.__otherActionClicks) === 1, '拦截了宿主按钮的点击');
    record('dismiss.retained-selection-external-button', 'passed');
    await reselect();
    assert((await state()).toolbar, '重新选择同一段无法恢复浮条');
    await clickShadowButton(page, '读懂'); await waitForReadingComplete(page);
    await page.locator('#retains-selection').click(); await page.waitForTimeout(800);
    assert(!(await state()).card && !(await state()).toolbar, '已打开卡片被外部点击后再次显示');
    record('dismiss.reselect-same-text-and-close-card', 'passed');

    await setup({trigger: 'hover', hoverDelay: 900});
    const beforeHover = requests.length;
    await hoverAction('读懂'); await page.waitForTimeout(180);
    assert(!(await state()).card && requests.length === beforeHover, '悬停延迟前发起请求');
    await page.mouse.move(5, 5); await page.waitForTimeout(1050);
    assert(!(await state()).card && requests.length === beforeHover, '移开后未取消悬停');
    record('trigger.hover-delay-and-leave-cancel', 'passed');
    await hoverAction('读懂'); await page.waitForTimeout(180);
    await page.locator('#retains-selection').click(); await page.waitForTimeout(1050);
    assert(!(await state()).toolbar && !(await state()).card && requests.length === beforeHover, '外部点击未取消悬停计时器');
    record('trigger.hover-external-click-cancel', 'passed');
    await reselect(); await hoverAction('拆句');
    await waitForReadingComplete(page);
    assert(requests.length > beforeHover, '完成悬停等待没有请求');
    assert((await currentReadingAnswer(page)).includes('主干'), '悬停没有使用指向的拆句动作');
    record('trigger.hover-opens-pointed-action', 'passed');

    await setup({trigger: 'shortcut', customHotkey: 'Alt+R', defaultAction: 'grammar'});
    const beforeShortcut = requests.length;
    assert(!(await state()).toolbar && !(await state()).card && requests.length === beforeShortcut, '仅划词触发了快捷键模式');
    await page.keyboard.press('Alt+r'); await waitForReadingComplete(page);
    assert((await currentReadingAnswer(page)).includes('主干'), '快捷键没有打开优先动作');
    record('trigger.shortcut-with-ordinary-selection-disabled', 'passed');
    await page.keyboard.press('Escape'); await page.waitForTimeout(600);
    assert(!(await state()).card && !(await state()).toolbar, 'Escape 关闭后重新出现');
    await page.keyboard.press('Alt+r'); await waitForReadingComplete(page);
    record('trigger.shortcut-reopens-dismissed-selection', 'passed');
    const screenshot = path.join(args.artifactsDir, 'card-trigger-light.png');
    await page.screenshot({path: screenshot}); result.screenshots.push(screenshot);
    await persistConfig(configPage, {theme: 'dark'}); await page.waitForTimeout(250);
    const darkSnapshot = await shadowSnapshot(page);
    const darkAnswer = find(darkSnapshot.host, node => attr(node, 'class').split(' ').includes('fr-reading-markdown'));
    assert(darkAnswer?.nodeId, '暗色阅读卡缺少回答');
    const resolvedAnswer = await darkSnapshot.session.send('DOM.resolveNode', {nodeId: darkAnswer.nodeId});
    const measuredAnswer = await darkSnapshot.session.send('Runtime.callFunctionOn', {
      objectId: resolvedAnswer.object.objectId, returnByValue: true,
      functionDeclaration: `function() { const answer = this;
      const reading = answer.closest('[data-reading-panel]');
      const surface = reading.closest('.fr-translation-tooltip');
      const luminance = color => {
        const channels = color.match(/[\\d.]+/g).slice(0, 3).map(value => Number(value) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
        return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
      };
      const text = luminance(getComputedStyle(answer).color);
      const background = luminance(getComputedStyle(surface).backgroundColor);
      const tabs = [...reading.querySelectorAll('.fr-reading-actions button[aria-pressed]')].map(button => luminance(getComputedStyle(button).backgroundColor));
      return {contrast: (Math.max(text, background) + .05) / (Math.min(text, background) + .05), tabs};
    }`,
    });
    await darkSnapshot.session.send('Runtime.releaseObject', {objectId: resolvedAnswer.object.objectId});
    const darkReadability = measuredAnswer.result.value;
    assert(darkReadability.contrast >= 4.5, `暗色阅读正文对比度不足：${JSON.stringify(darkReadability)}`);
    assert(darkReadability.tabs.every(value => value < .2), '暗色学习方式按钮仍使用浅色背景');
    record('trigger.dark-reading-contrast', 'passed', darkReadability);
    const darkScreenshot = path.join(args.artifactsDir, 'card-trigger-dark.png');
    await page.screenshot({path: darkScreenshot}); result.screenshots.push(darkScreenshot);
    await configPage.reload({waitUntil: 'domcontentloaded'});
    const triggerGroup = configPage.getByRole('radiogroup', {name: '打开翻译卡片', exact: true});
    await triggerGroup.getByRole('radio', {name: '延迟悬停', exact: true}).click();
    const delayInput = configPage.getByRole('spinbutton', {name: '悬停等待（毫秒）', exact: true});
    await delayInput.fill('1100'); await delayInput.press('Tab');
    await waitUntil(async () => {const reading = (await readConfig(configPage)).harness; return reading.trigger === 'hover' && reading.hoverDelay === 1100;}, '翻译卡片触发设置未保存');
    await configPage.reload({waitUntil: 'domcontentloaded'});
    assert(await triggerGroup.getByRole('radio', {name: '延迟悬停', exact: true}).getAttribute('aria-checked') === 'true', '重开设置后丢失悬停方式');
    assert(await delayInput.inputValue() === '1100', '重开设置后丢失悬停延迟');
    record('trigger.settings-ui-persists-after-reload', 'passed');
    const settingsScreenshot = path.join(args.artifactsDir, 'card-trigger-settings.png');
    await triggerGroup.scrollIntoViewIfNeeded(); await configPage.screenshot({path: settingsScreenshot}); result.screenshots.push(settingsScreenshot);

}

async function waitForReadingComplete(page, timeout = 10000) {
    const started = Date.now();
    await page.waitForTimeout(100);
    let snapshot;
    while (Date.now() - started < timeout) {
        snapshot = await shadowSnapshot(page);
        const activeAnswer = find(snapshot.host, node => attr(node, 'class').split(' ').includes('fr-reading-answer'));
        const stop = find(snapshot.host, node => node.nodeName?.toLowerCase() === 'button' && text(node).trim() === '停止');
        if (activeAnswer && text(activeAnswer).trim() && !stop) return snapshot;
        await page.waitForTimeout(100);
    }
    throw new Error(`回答没有在 ${timeout}ms 内完成: ${snapshot?.text.slice(-500)}`);
}
async function startCardSampling(page, durationMs = 1800) {
    const {host, session} = await shadowSnapshot(page);
    const shadow = host?.shadowRoots?.[0];
    assert(shadow?.nodeId, '无法解析真实闭合 ShadowRoot 来逐帧检查阅读卡');
    const resolved = await session.send('DOM.resolveNode', {nodeId: shadow.nodeId});
    const done = session.send('Runtime.callFunctionOn', {
        objectId: resolved.object.objectId, awaitPromise: true, returnByValue: true,
        functionDeclaration: `function(duration) {
            const root = this, win = root.ownerDocument.defaultView, samples = [];
            const started = performance.now(); let frames = 0, lastFrame = 0;
            const capture = () => {
                const card = root.querySelector('.fr-translation-tooltip');
                if (!card || !card.getBoundingClientRect().width || win.getComputedStyle(card).visibility === 'hidden' || Number(win.getComputedStyle(card).opacity) === 0) return;
                const box = card.getBoundingClientRect(), scroll = card.querySelector('.fr-reading-scroll'), form = card.querySelector('.fr-reading-followup');
                samples.push({t: Math.round(performance.now() - started), x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom, right: box.right, viewportWidth: win.innerWidth, viewportHeight: win.innerHeight, placement: card.dataset.placement, scrollHeight: scroll?.scrollHeight || 0, clientHeight: scroll?.clientHeight || 0, formBottom: form?.getBoundingClientRect().bottom || 0});
            };
            return new Promise(resolve => {
                let finished = false;
                const frame = () => {if (finished) return; frames += 1; capture(); lastFrame = win.requestAnimationFrame(frame);};
                capture(); lastFrame = win.requestAnimationFrame(frame);
                const interval = win.setInterval(capture, 32);
                win.setTimeout(() => {finished = true; win.cancelAnimationFrame(lastFrame); win.clearInterval(interval); capture(); resolve({samples, animationFrames: frames});}, duration);
            });
        }`, arguments: [{value: durationMs}],
    }).then(response => {
        assert(!response.exceptionDetails, `阅读卡逐帧采样失败: ${JSON.stringify(response.exceptionDetails)}`);
        return response.result.value;
    }).finally(() => session.send('Runtime.releaseObject', {objectId: resolved.object.objectId}).catch(() => {}));
    void done.catch(() => {});
    return {done};
}
function assertCardStable(trace, label) {
    const samples = trace.samples;
    assert(samples.length >= 8, `${label} 未采集到足够的真实布局样本: ${samples.length}`);
    const span = key => Math.max(...samples.map(item => item[key])) - Math.min(...samples.map(item => item[key]));
    assert(span('x') <= 2 && span('y') <= 2, `${label} 发生弹跳: x=${span('x')}, y=${span('y')}, first=${JSON.stringify(samples[0])}, last=${JSON.stringify(samples.at(-1))}`);
    assert(new Set(samples.map(item => item.placement)).size <= 1, `${label} 在生成中切换了卡片方向`);
    for (const item of samples) {
        assert(item.x >= -1 && item.y >= -1 && item.right <= item.viewportWidth + 1 && item.bottom <= item.viewportHeight + 1, `${label} 卡片超出视口: ${JSON.stringify(item)}`);
        if (item.formBottom) assert(item.formBottom <= item.bottom + 1, `${label} 追问输入框被挤出卡片`);
    }
    return {sampleCount: samples.length, animationFrames: trace.animationFrames, deltaX: span('x'), deltaY: span('y'), minHeight: Math.min(...samples.map(item => item.height)), maxHeight: Math.max(...samples.map(item => item.height)), first: samples[0], last: samples.at(-1)};
}
async function selectText(page, selector, end = 42) { return page.evaluate(({ selector, end }) => { const node = document.querySelector(selector)?.firstChild; if (!node)
    throw new Error(`找不到文本: ${selector}`); const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, Math.min(end, node.textContent.length)); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); return selection.toString(); }, { selector, end }); }
// 只冻结页面收到的首条保存回执；真实 runtime 请求、后台校验与落盘全部照常执行。
// 后续 UI 修改因此确定停留在页面队列，不依赖机器负载碰巧制造竞态。
function harnessSaveProbeScript() {
    const state = {installed: false, requests: [], responses: [], heldResponses: 0, releasedResponses: 0, batches: [], beforeUnloads: 0, pageHides: 0};
    const release = [];
    globalThis.__fluentReadHarnessSaveProbe = state;
    globalThis.__fluentReadHarnessReleaseSave = () => { for (const deliver of release.splice(0)) { state.releasedResponses += 1; deliver(); } };
    const original = globalThis.chrome.runtime.sendMessage.bind(globalThis.chrome.runtime);
    const emit = (kind, details) => console.info(`FR_HARNESS_SAVE_PROBE ${JSON.stringify({kind, at: Date.now(), ...details})}`);
    globalThis.chrome.runtime.sendMessage = function (...args) {
        const message = args.find(value => value && typeof value === 'object' && typeof value.type === 'string');
        if (message?.type === 'persistConfigBatch') {
            const batch = {clientId: message.clientId, sequences: (message.patches || []).map(patch => patch.sequence), harness: (message.patches || []).map(patch => patch.config?.harness || null)};
            state.batches.push(batch); emit('batch', batch);
            return original(...args);
        }
        if (message?.type !== 'persistConfig' || !message.config?.harness) return original(...args);
        const request = {clientId: message.clientId, sequence: message.sequence, mode: message.mode || 'replace', harness: JSON.parse(JSON.stringify(message.config.harness))};
        state.requests.push(request); emit('request', request);
        const hold = state.requests.length === 1;
        const recordResponse = response => {
            const value = {sequence: message.sequence, success: response?.success === true, revision: response?.revision};
            state.responses.push(value); emit('response', value);
        };
        const callbackIndex = args.findLastIndex(value => typeof value === 'function');
        if (callbackIndex >= 0) {
            const callback = args[callbackIndex];
            args[callbackIndex] = response => {
                recordResponse(response);
                if (!hold) return callback(response);
                state.heldResponses += 1;
                release.push(() => callback(response));
            };
            return original(...args);
        }
        return Promise.resolve(original(...args)).then(response => {
            recordResponse(response);
            if (!hold) return response;
            state.heldResponses += 1;
            return new Promise(resolve => release.push(() => resolve(response)));
        });
    };
    state.installed = true;
    addEventListener('beforeunload', () => { state.beforeUnloads += 1; emit('beforeunload', {beforeUnloads: state.beforeUnloads}); });
    addEventListener('pagehide', () => { state.pageHides += 1; emit('pagehide', {pageHides: state.pageHides}); });
}
async function waitForHarnessSaved(configPage, expected, timeout = 10000) {
    const deadline = Date.now() + timeout;
    let actual;
    do {
        actual = (await readConfig(configPage)).harness;
        if (Object.entries(expected).every(([key, value]) => actual[key] === value)) return actual;
        await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw new Error(`Harness 设置未持久化: ${JSON.stringify({expected, actual})}`);
}
async function verifyHarnessSaveRace({newPage, configPage, extensionId, args, result, record, quickClose}) {
    const id = quickClose ? 'settings-ui-quick-close-pending-save' : 'settings-ui-continuous-latest-write-wins';
    const details = {executed: true, heldResponseControl: true, events: []};
    let editedPage;
    let reopenedPage;
    try {
        const baseline = {...(await readConfig(configPage)).harness, enabled: false, contextMode: 'paragraph', explanationDepth: 'concise'};
        await persistConfig(configPage, {harness: baseline});
        editedPage = await newPage();
        editedPage.on('console', message => {
            const prefix = 'FR_HARNESS_SAVE_PROBE ';
            if (message.text().startsWith(prefix)) details.events.push(JSON.parse(message.text().slice(prefix.length)));
        });
        await editedPage.addInitScript(harnessSaveProbeScript);
        await editedPage.goto(`chrome-extension://${extensionId}/options.html#settings-harness`, {waitUntil: 'domcontentloaded'});
        const enabled = editedPage.getByRole('switch', {name: '启用翻译卡片'});
        await editedPage.waitForFunction(() => document.querySelector('[role="switch"][aria-label="启用翻译卡片"]')?.getAttribute('aria-checked') === 'false');
        assert(await editedPage.evaluate(() => globalThis.__fluentReadHarnessSaveProbe.installed && globalThis.__fluentReadHarnessSaveProbe.requests.length === 0), '保存观察器未在首次 UI 修改前就绪');
        await enabled.locator('xpath=ancestor::*[contains(@class, "el-switch")][1]').locator('.el-switch__core').click();
        await editedPage.waitForFunction(() => globalThis.__fluentReadHarnessSaveProbe.heldResponses === 1);
        assert((await readConfig(configPage)).harness.enabled === true, '首个 UI 请求没有真实落盘，无法验证回执在途竞态');
        await editedPage.getByRole('radio', {name: '仅选中文字', exact: true}).click();
        const expected = {enabled: true, contextMode: 'selection', explanationDepth: 'concise'};
        if (!quickClose) {
            await editedPage.getByRole('radio', {name: '可参考本段', exact: true}).click();
            await editedPage.getByRole('radio', {name: '仅选中文字', exact: true}).click();
        }
        details.beforeRelease = await editedPage.evaluate(() => ({
            probe: structuredClone(globalThis.__fluentReadHarnessSaveProbe),
            selected: document.querySelector('[role="radio"][aria-label="仅选中文字"]')?.getAttribute('aria-checked')
                || Array.from(document.querySelectorAll('[role="radio"]')).find(node => node.textContent.trim() === '仅选中文字')?.getAttribute('aria-checked'),
        }));
        assert(details.beforeRelease.probe.requests.length === 1 && details.beforeRelease.probe.heldResponses === 1, '后续 UI 修改未形成首回执阻塞的页面待发队列');
        assert(details.beforeRelease.selected === 'true', '最终上下文选项没有通过真实 UI 生效');
        if (quickClose) {
            // Page.close 走浏览器真实 beforeunload/pagehide 路径，不合成 pagehide，不释放被阻塞的回执。
            const closed = editedPage.waitForEvent('close');
            await editedPage.close({runBeforeUnload: true});
            await closed;
            editedPage = null;
        } else {
            await editedPage.evaluate(() => globalThis.__fluentReadHarnessReleaseSave());
            await editedPage.waitForFunction(() => globalThis.__fluentReadHarnessSaveProbe.responses.length >= 4);
            details.afterRelease = await editedPage.evaluate(() => structuredClone(globalThis.__fluentReadHarnessSaveProbe));
            assert(details.afterRelease.requests.length === 4 && details.afterRelease.responses.every(response => response.success), '连续 UI 写入没有依次提交成功');
        }
        details.expected = expected;
        details.persisted = await waitForHarnessSaved(configPage, expected);
        if (editedPage) { await editedPage.close(); editedPage = null; }
        reopenedPage = await newPage();
        await reopenedPage.goto(`chrome-extension://${extensionId}/options.html#settings-harness`, {waitUntil: 'domcontentloaded'});
        await reopenedPage.waitForFunction(() => document.querySelector('[role="switch"][aria-label="启用翻译卡片"]')?.getAttribute('aria-checked') === 'true');
        assert(await reopenedPage.getByRole('radio', {name: '仅选中文字', exact: true}).getAttribute('aria-checked') === 'true', '重开后最终上下文选择回滚');
        details.reopened = (await readConfig(reopenedPage)).harness;
        const screenshot = path.join(args.artifactsDir, `${id}.png`);
        await reopenedPage.screenshot({path: screenshot}); result.screenshots.push(screenshot);
        record(id, 'passed', details);
    } catch (error) {
        details.error = error.stack || error.message;
        details.persistedAfterFailure = (await readConfig(configPage)).harness;
        record(id, 'failed', details);
    } finally {
        if (editedPage && !editedPage.isClosed()) {
            await editedPage.evaluate(() => globalThis.__fluentReadHarnessReleaseSave?.()).catch(() => {});
            await editedPage.close().catch(() => {});
        }
        if (reopenedPage && !reopenedPage.isClosed()) await reopenedPage.close().catch(() => {});
    }
    result[quickClose ? 'quickClose' : 'latestWriteWins'] = details;
}
async function main() {
    const args = parseArgs(process.argv.slice(2));
    fs.mkdirSync(args.artifactsDir, { recursive: true });
    fs.writeFileSync(path.join(args.artifactsDir, 'build-provenance.json'), `${JSON.stringify(buildProvenance(args.extensionDir), null, 2)}\n`);
    const { chromium } = loadPlaywright(args.playwrightRoot);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-harness-edge-'));
    let context;
    let close = async () => context?.close();
    let newPage = () => context.newPage();
    const requests = [];
    const ttsRequests = [];
    let responseDelayMs = 0;
    const server = http.createServer(async (req, res) => {
        if (req.method === 'GET' && req.url === '/favicon.ico') {
            res.writeHead(204).end();
            return;
        }
        if (req.method === 'GET' && req.url === '/fixture') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Harness fixture</title><style>body{margin:0;font:16px/1.6 Arial,sans-serif}main{max-width:760px;margin:0 auto;padding:340px 24px 700px}p{margin:0 0 18px}#navigation{margin-bottom:16px}</style></head><body><main><p id="target">Although the task was difficult, she finished it on time.</p><p id="neighbor">A neighboring paragraph must remain untouched.</p><nav id="navigation">Hidden navigation metadata</nav><input id="input" value="form text"></main></body></html>');
            return;
        }
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
            res.writeHead(404).end();
            return;
        }
        const chunks = [];
        for await (const chunk of req)
            chunks.push(chunk);
        let body = {};
        try {
            body = JSON.parse(Buffer.concat(chunks).toString());
        }
        catch { }
        requests.push(body);
        const requestDelayMs = responseDelayMs;
        const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
        const toolRound = hasTools && !body.messages?.some(item => item.role === 'tool');
        const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
        if (toolRound) {
            send({id: 'harness-fixture', choices: [{index: 0, delta: {role: 'assistant', tool_calls: [{index: 0, id: 'fixture-read-context', type: 'function', function: {name: 'read_context', arguments: '{}'}}]}, finish_reason: null}]});
            await wait(requestDelayMs || 120);
            send({id: 'harness-fixture', choices: [{index: 0, delta: {}, finish_reason: 'tool_calls'}]});
        } else {
            const system = JSON.stringify(body.messages?.find(item => item.role === 'system')?.content || '');
            const answers = {
                meaning: '### 大意\n这句话表示：虽然任务很难，她仍然按时完成了。\n\n### 关键点\n- **Although**：虽然，用困难衬托结果。\n- **on time**：按时，而不是刚好赶得及。',
                grammar: '### 主干\n**she → finished → it**：她完成了任务。\n\n### 成分\n- **Although the task was difficult**：让步从句，说明困难。\n- **on time**：修饰 finished，说明完成的时间。\n\n### 关键点\nAlthough 已表示转折，主句不用再加 but。',
                usage: '### 表达\n**on time** 表示按约定时间完成。\n\n### 怎么用\n常与 arrive、finish 搭配。\n\n### 例句\n> The train arrived on time.\n\n火车准点到达。',
                practice: '### 试一试\n虽然今天下雨了，我们还是准时到达。\n\n**Although it was raining, we arrived __ __.**\n\n### 提示\n想想“按约定时间到达”的表达。',
            };
            const intent = system.includes('### 主干') ? 'grammar' : system.includes('### 怎么用') ? 'usage' : system.includes('### 试一试') ? 'practice' : 'meaning';
            const themeAnswer = '### 大意\n这句话表示：虽然任务很难，她仍然按时完成了。\n\n### 关键点\n- **Although** 表示让步，`on time` 表示按时。\n\n> The task was difficult.\n\n```text\nShe finished on time.\n```\n\n| 表达 | 含义 |\n| --- | --- |\n| on time | 按时 |';
            const answer = requestDelayMs ? '迟到的旧回答不应覆盖当前卡片内容。' : args.themeOnly ? themeAnswer : answers[intent];
            const chunks = answer.match(requestDelayMs ? /[\s\S]{1,8}/gu : /[\s\S]{1,12}/gu) || [answer];
            for (const [index, chunk] of chunks.entries()) {
                if (index > 0) await wait(requestDelayMs ? Math.max(180, Math.floor(requestDelayMs / 3)) : 70);
                send({id: 'harness-fixture', choices: [{index: 0, delta: {content: chunk}, finish_reason: null}]});
            }
            send({id: 'harness-fixture', choices: [{index: 0, delta: {}, finish_reason: 'stop'}], usage: {prompt_tokens: 12, completion_tokens: 9, total_tokens: 21}});
        }
        res.write('data: [DONE]\n\n');
        res.end();
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    const result = { ok: false, extensionDir: args.extensionDir, browser: 'Microsoft Edge', launchMode: null, focusPolicy: null, windowPlacement: null, cases: [], caseCoverage: {}, screenshots: [], consoleErrors: [], httpErrors: [], apiRequests: requests, audio: {muted: true, fixture: 'silent PCM WAV over mocked Microsoft TTS HTTP endpoints', listeningVerified: false, requests: ttsRequests}, persistenceCases: [], quickClose: {}, crossPageSync: {}, latestWriteWins: {} };
    const record = (id, status, details = {}) => { const item = { id, status, ...details }; result.cases.push(item); result.caseCoverage[id] = item; return item; };
    try {
        const browserArgs = [`--disable-extensions-except=${args.extensionDir}`, `--load-extension=${args.extensionDir}`, '--no-first-run', '--no-default-browser-check', '--mute-audio'];
        if (!args.headed) {
            const helper = require(path.resolve(args.focusSafeHelper));
            const session = await helper.launchFocusSafePersistentContext({ chromium, profileDir: profile, browserPath: args.browserPath, headless: false, background: true, browserArgs, viewport: { width: 1280, height: 900 } });
            context = session.context;
            close = session.close;
            newPage = () => helper.newPageWithoutForeground(context);
            Object.assign(result, { launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement });
        }
        else {
            context = await chromium.launchPersistentContext(profile, { executablePath: args.browserPath, headless: false, args: browserArgs, viewport: { width: 1280, height: 900 } });
            result.launchMode = 'playwright-headed';
            result.focusPolicy = 'foreground-authorized';
            result.windowPlacement = { mode: 'headed-explicit-foreground' };
        }
        context.on('response', response => { if (response.status() >= 400)
            result.httpErrors.push({ status: response.status(), url: response.url() }); });
        context.on('page', target => { target.on('console', message => { if (message.type() === 'error')
            result.consoleErrors.push(`context: ${message.text()} @ ${message.location().url}`); }); });
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
        // 只替换供应商网络响应；扩展的签名、SSML、后台归属及音频播放/停止仍走生产代码。
        await context.route('https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({t: 'fixture-tts-token', r: 'fixture'})}));
        await context.route('https://fixture.tts.speech.microsoft.com/cognitiveservices/v1', route => {
            ttsRequests.push({url: route.request().url(), ssml: route.request().postData() || ''});
            return route.fulfill({status: 200, contentType: 'audio/wav', body: silentWav()});
        });
        await worker.evaluate(() => {
            globalThis.__fluentReadHarnessSaveReceipts = [];
            globalThis.__harnessTtsMessages = [];
            chrome.runtime.onMessage.addListener((message, sender) => {
                if (message?.type === 'persistConfigBatch' || (message?.type === 'persistConfig' && message.config?.harness)) {
                    globalThis.__fluentReadHarnessSaveReceipts.push({receivedAt: Date.now(), type: message.type, clientId: message.clientId,
                        sequence: message.sequence, mode: message.mode, harness: message.config?.harness,
                        patches: message.patches, senderUrl: sender.url});
                }
                if (['selectionTts', 'selectionTtsStop', 'selectionTtsPlaybackState', 'PLAY_SELECTION_TTS', 'STOP_SELECTION_TTS'].includes(message?.type))
                    globalThis.__harnessTtsMessages.push({type: message.type, state: message.state, text: message.text, clientRequestId: message.clientRequestId});
                return false;
            });
        });
        const extensionId = worker.url().match(/^chrome-extension:\/\/([^/]+)/)[1];
        result.extensionId = extensionId;
        const configPage = await newPage();
        configPage.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon.ico'))
            result.consoleErrors.push(`config: ${m.text()}`); });
        await configPage.goto(`chrome-extension://${extensionId}/options.html#settings-harness`, { waitUntil: 'domcontentloaded' });
        await configPage.waitForTimeout(1200);
        const fixtureUrl = `http://127.0.0.1:${port}/fixture`;
        await persistConfig(configPage, { service: 'openai', vocabularyBookEnabled: true, customOpenAIProviders: [{ id: 'custom:fixture', name: 'Local fixture', endpoint: `http://127.0.0.1:${port}/v1/chat/completions`, models: ['learning-fixture'] }], token: { 'custom:fixture': 'fixture-token' }, model: { 'custom:fixture': 'learning-fixture' }, harness: { enabled: false, service: 'custom:fixture', model: 'learning-fixture', defaultAction: 'meaning', actions: ['meaning', 'grammar', 'usage', 'practice'], contextMode: 'paragraph', maxContextChars: 1500, explanationDepth: 'concise', learningLevel: 'intermediate' } });
        const page = await newPage();
        page.on('pageerror', e => result.consoleErrors.push(e.message));
        page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon.ico'))
            result.consoleErrors.push(m.text()); });
        await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(700);
        if (!args.persistenceOnly) {
        const disabled = await shadowSnapshot(page);
        record('disabled-no-entry', disabled.host ? 'failed' : 'passed');
        const config = await readConfig(configPage);
        assert(config.harness.memoryEnabled === false, '新配置默认开启了长期学习记忆');
        record('memory-disabled-by-default', 'passed');
        await persistConfig(configPage, { harness: { ...config.harness, enabled: true, service: 'custom:fixture', model: 'learning-fixture' } });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(700);
        const beforeSelection = requests.length;
        const targetBox = await page.locator('#target').boundingBox();
        assert(targetBox && targetBox.width > 20 && targetBox.height > 10, '目标段落没有有效几何位置');
        await page.mouse.move(targetBox.x + 8, targetBox.y + targetBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(Math.min(targetBox.x + targetBox.width - 8, targetBox.x + 420), targetBox.y + targetBox.height / 2, { steps: 12 });
        await page.mouse.up();
        await page.waitForTimeout(700);
        const actualSelection = await page.evaluate(() => getSelection()?.toString().trim() || '');
        assert(actualSelection && /lthough the task was difficult/.test(actualSelection) && !actualSelection.includes('WXT Shadow Root'), `真实选区未落在目标文本: ${actualSelection.slice(0, 180)}`);
        const selected = await shadowSnapshot(page);
        assert(selected.host, '启用翻译卡片 后没有 closed Shadow UI');
        assert(requests.length === beforeSelection, '仅选择文本就发起了 Harness 请求');
        const actionToolbar = find(selected.host, node => attr(node, 'class').split(' ').includes('fr-reading-indicator'));
        const toolbarLabels = findAll(actionToolbar, node => node.nodeName?.toLowerCase() === 'button').map(node => text(node).trim());
        assert(['读懂', '拆句', '用法', '练习'].every(label => toolbarLabels.includes(label)) && toolbarLabels.includes('记录'), `网页浮条未显示已启用的学习动作与阅读记录: ${toolbarLabels}`);
        record('selection-toolbar-enabled-actions', 'passed', {actions: toolbarLabels});
        record('selection-entry-visible-no-request', 'passed', { selectedText: actualSelection });
        if (args.triggerOnly || args.themeOnly) {
            await (args.themeOnly ? verifyReadingTheme : verifyCardTriggers)({page, configPage, requests, record, args, result});
            result.ok = result.consoleErrors.length === 0 && result.httpErrors.length === 0;
            fs.writeFileSync(path.join(args.artifactsDir, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            if (!result.ok) process.exitCode = 1;
            return;
        }
        const before = requests.length;
        const initialFrames = await startCardSampling(page, 1900);
        const clickInfo = await clickShadowButton(page, '读懂');
        await page.waitForTimeout(350);
        const partial = await shadowSnapshot(page);
        assert(partial.text.includes('正在') && partial.text.includes('这句话表示'), `流式首段未在网络结束前显示或 busy 已消失: ${partial.text.slice(-300)}`);
        const partialScreenshot = path.join(args.artifactsDir, 'harness-reading-partial.png');
        await page.screenshot({path: partialScreenshot});
        result.screenshots.push(partialScreenshot);
        record('stream-partial-visible-while-busy', 'passed', { partialText: partial.text.slice(-180), requestCount: requests.length });
        const firstComplete = await waitForReadingComplete(page);
        const initialGeometry = assertCardStable(await initialFrames.done, '首次流式回答');
        record('stream-card-position-stable', 'passed', initialGeometry);
        const headings = findAll(firstComplete.host, node => ['h3', 'h4'].includes(node.nodeName?.toLowerCase()));
        assert(headings.length >= 2 && find(firstComplete.host, node => node.nodeName?.toLowerCase() === 'strong') && find(firstComplete.host, node => node.nodeName?.toLowerCase() === 'ul'), '阅读回答缺少真实标题、列表或强调结构');
        assert(!firstComplete.text.includes('###') && !firstComplete.text.includes('**Although**'), '阅读回答仍展示 Markdown 原始标记');
        record('answer-markdown-hierarchy', 'passed', {headings: headings.map(text)});
        assert(requests.length > before, `点击理解没有经过真实 gateway 发请求: ${JSON.stringify({ clickInfo, after: (await shadowSnapshot(page)).text.slice(-400) })}`);
        record('click-sends-request', 'passed', { requestCount: requests.length });
        assert(requests.some(item => item.messages?.some(message => message.role === 'tool')), '段落工具没有完成配对回合');
        const speechBefore = ttsRequests.length;
        await clickShadowButton(page, '朗读原文');
        await waitForShadowButton(page, '停止朗读');
        await waitUntil(() => ttsRequests.length > speechBefore, '点击原文朗读没有经过真实 TTS 合成 HTTP');
        assert(ttsRequests.at(-1).ssml.includes(actualSelection), '原文朗读合成了回答或其他文本');
        await page.waitForTimeout(250);
        await clickShadowButton(page, '停止朗读');
        await waitForShadowButton(page, '朗读原文');
        await waitUntil(async () => (await worker.evaluate(() => globalThis.__harnessTtsMessages)).some(item => item.type === 'selectionTtsStop'), '原文停止按钮没有进入生产 TTS 停止路由');
        record('reading-source-audio-play-stop', 'passed', {synthesisRequests: ttsRequests.length - speechBefore, muted: true, listeningVerified: false});
        const beforeRecordList = requests.length;
        await clickShadowButton(page, '阅读记录');
        await page.waitForTimeout(250);
        const recordList = await shadowSnapshot(page);
        assert(recordList.text.includes('选择一条') && recordList.text.includes('继续阅读') && !find(recordList.host, node => attr(node, 'class').split(' ').includes('fr-reading-answer')), '阅读记录列表没有独立显示选择说明');
        await clickShadowButton(page, '返回当前阅读');
        assert(requests.length === beforeRecordList && (await shadowSnapshot(page)).text.includes('虽然任务很难'), '查看记录并返回改变了当前回答或触发模型');
        record('reading-record-list-return-preserves-answer', 'passed');
        await page.evaluate(() => getSelection()?.removeAllRanges());
        await page.mouse.click(1000, 700);
        await page.waitForTimeout(350);
        const restoreTarget = await page.locator('#target').boundingBox();
        assert(restoreTarget, '重新打开历史前目标段落没有几何位置');
        await page.mouse.move(restoreTarget.x + 8, restoreTarget.y + restoreTarget.height / 2);
        await page.mouse.down();
        await page.mouse.move(restoreTarget.x + 260, restoreTarget.y + restoreTarget.height / 2, {steps: 8});
        await page.mouse.up();
        await page.waitForTimeout(500);
        const beforeRestore = requests.length;
        await clickShadowButton(page, '阅读记录');
        await page.waitForTimeout(250);
        await clickShadowFirstSession(page);
        await page.waitForTimeout(450);
        const restored = await shadowSnapshot(page);
        const restoredExpanded = await shadowSnapshot(page);
        assert(requests.length === beforeRestore && restoredExpanded.text.includes('虽然任务很难') && restoredExpanded.text.includes(actualSelection), '恢复阅读记录改变了 HTTP 或没有显示原文与已保存回答');
        assert(find(restoredExpanded.host, node => (node.attributes || []).includes('data-reading-answer')), '恢复记录未使用共享 Markdown 阅读组件');
        await fillShadowInput(page, '继续追问', '恢复后为什么仍然按时完成？');
        await clickShadowButton(page, '发送追问');
        await page.waitForTimeout(1400);
        const restoredFollowup = requests.slice(beforeRestore).at(-1);
        assert(restoredFollowup && JSON.stringify(restoredFollowup).includes('恢复后为什么仍然按时完成？') && JSON.stringify(restoredFollowup).includes('虽然任务很难，她仍然按时完成了'), '恢复历史后的追问没有携带完整已保存问答');
        record('close-reselect-restore-followup-history', 'passed', {requestCount: requests.length});
        for (const action of ['拆句', '用法', '练习']) {
            const beforeAction = requests.length;
            await clickShadowButton(page, action);
            await waitForReadingComplete(page);
            assert(requests.length > beforeAction, `${action} 没有产生请求`);
            const actionRequests = requests.slice(beforeAction);
            assert(actionRequests.every(item => item.messages?.filter(message => message.role === 'user').length === 1), `${action} 独立动作混入了先前问答`);
            const actionUser = actionRequests[0].messages.find(message => message.role === 'user');
            assert(JSON.stringify(actionUser).includes('选中文本（数据）') && !JSON.stringify(actionUser).includes('这是当前卡片的既有问答'), `${action} 原文被包装成了会话指令`);
            record(`action-${action}`, 'passed', {independentAnalysis: true});
        }
        const cachedPractice = await currentReadingAnswer(page);
        const beforeCacheSwitch = requests.length;
        await clickShadowButton(page, '拆句');
        await waitForReadingComplete(page);
        await clickShadowButton(page, '练习');
        await waitForReadingComplete(page);
        assert(requests.length === beforeCacheSwitch && await currentReadingAnswer(page) === cachedPractice, '练习切换其他动作再返回时没有恢复同一回答，或产生了重复模型请求');
        record('action-cache-practice-switch-return', 'passed', {requestsBefore: beforeCacheSwitch, requestsAfter: requests.length});
        await clickShadowButton(page, '重新生成');
        await waitForReadingComplete(page);
        assert(requests.length > beforeCacheSwitch && (await currentReadingAnswer(page)).includes('试一试'), '显式重新生成没有为当前练习发起新请求');
        record('action-explicit-regenerate-sends-request', 'passed', {requestsBefore: beforeCacheSwitch, requestsAfter: requests.length});
        const cachedPracticeForFollowup = await currentReadingAnswer(page);
        await clickShadowButton(page, '拆句');
        await waitForReadingComplete(page);
        for (let turn = 0; turn < 4; turn += 1) {
            await clickShadowButton(page, '重新生成');
            await waitForReadingComplete(page);
        }
        const beforeReturnToPractice = requests.length;
        await clickShadowButton(page, '练习');
        await waitForReadingComplete(page);
        assert(requests.length === beforeReturnToPractice && await currentReadingAnswer(page) === cachedPracticeForFollowup, '其他动作生成四轮后，缓存练习没有恢复');
        const { host: followHost } = await shadowSnapshot(page);
        const followInput = find(followHost, n => n.nodeName?.toLowerCase() === 'input' && attr(n, 'aria-label') === '继续追问');
        assert(followInput?.nodeId, '找不到继续追问输入框');
        const beforeFollowup = requests.length;
        await fillShadowInput(page, '继续追问', '为什么使用 although？');
        const followupFrames = await startCardSampling(page, 1600);
        await clickShadowButton(page, '发送追问');
        await waitForReadingComplete(page);
        record('followup-card-position-stable', 'passed', assertCardStable(await followupFrames.done, '追问流式回答'));
        assert(requests.length > beforeFollowup, '继续追问没有提交请求');
        assert(requests.at(-1).messages.filter(message => message.role === 'user').length >= 2 && JSON.stringify(requests.at(-1)).includes('为什么使用 although？'), '追问没有携带真实问答历史');
        record('followup-submit-history', 'passed', { requestCount: requests.length });
        assert(requests.at(-1).messages.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes('Although it was raining, we arrived __ __.')), '其他动作四轮后缓存练习的追问丢失了原练习题');
        record('cached-practice-followup-keeps-question-after-other-turns', 'passed');
        responseDelayMs = 1800;
        const beforeCancel = requests.length;
        await clickShadowButton(page, '重新生成');
        let beforeStop;
        for (let attempt = 0; attempt < 60; attempt++) {
            beforeStop = await shadowSnapshot(page);
            if (beforeStop.text.includes('迟到') && beforeStop.text.includes('正在')) break;
            await page.waitForTimeout(100);
        }
        assert(beforeStop.text.includes('迟到') && beforeStop.text.includes('正在'), '停止前没有看到真实流式 partial 或 busy 状态');
        await clickShadowButton(page, '停止');
        await page.waitForTimeout(2200);
        const cancelled = await shadowSnapshot(page);
        assert(requests.length > beforeCancel && cancelled.text.includes('迟到的旧回答') && cancelled.text.includes('已停止') && !cancelled.text.includes('不应覆盖当前卡片内容'), '取消后迟到结果覆盖了已保留的 partial');
        responseDelayMs = 0;
        record('cancel-delayed-result-does-not-overwrite', 'passed', { requestCount: requests.length });
        await page.evaluate(() => getSelection()?.removeAllRanges());
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(700);
        const targetBox2 = await page.locator('#target').boundingBox();
        assert(targetBox2, '换选区目标没有几何位置');
        await page.mouse.move(targetBox2.x + 8, targetBox2.y + targetBox2.height / 2);
        await page.mouse.down();
        await page.mouse.move(targetBox2.x + 260, targetBox2.y + targetBox2.height / 2, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(500);
        const firstSelection = await page.evaluate(() => getSelection()?.toString().trim() || '');
        responseDelayMs = 1800;
        await clickShadowButton(page, '读懂');
        await page.waitForTimeout(150);
        responseDelayMs = 0;
        await page.evaluate(() => getSelection()?.removeAllRanges());
        const neighborBox = await page.locator('#neighbor').boundingBox();
        assert(neighborBox, '换选区邻段没有几何位置');
        await page.mouse.move(neighborBox.x + 8, neighborBox.y + neighborBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(neighborBox.x + 220, neighborBox.y + neighborBox.height / 2, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(500);
        const secondSelection = await page.evaluate(() => getSelection()?.toString().trim() || '');
        assert(firstSelection && secondSelection && !secondSelection.includes(firstSelection), '快速换选区没有产生新选区');
        await clickShadowButton(page, '读懂');
        await page.waitForTimeout(2200);
        const freshCard = await shadowSnapshot(page);
        assert(freshCard.text.includes(secondSelection) && !freshCard.text.includes('迟到的旧回答'), '旧选区的迟到回答覆盖了新卡片');
        record('switch-selection-staleness', 'passed', { firstSelection, secondSelection });
        await persistConfig(configPage, { harness: { ...(await readConfig(configPage)).harness, contextMode: 'selection' } });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(700);
        const selectionBox = await page.locator('#target').boundingBox();
        await page.mouse.move(selectionBox.x + 8, selectionBox.y + selectionBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(selectionBox.x + 260, selectionBox.y + selectionBox.height / 2, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(500);
        const selectionOnlyBefore = requests.length;
        await clickShadowButton(page, '读懂');
        await waitForReadingComplete(page);
        const selectionOnlyRequest = requests.slice(selectionOnlyBefore).find(item => item.messages?.some(message => message.role === 'user'));
        assert(selectionOnlyRequest && !JSON.stringify(selectionOnlyRequest).includes('neighbor') && !JSON.stringify(selectionOnlyRequest).includes('Hidden navigation'), 'selection-only 请求带入了段落或隐藏内容');
        assert(!selectionOnlyRequest.tools?.length && !JSON.stringify(selectionOnlyRequest).includes('finished it on time.'), 'selection-only 请求包含未选中的同段内容或工具');
        record('selection-only-no-paragraph', 'passed');
        const settingsPage = await newPage();
        settingsPage.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon.ico'))
            result.consoleErrors.push(`settings: ${m.text()}`); });
        await settingsPage.goto(`chrome-extension://${extensionId}/options.html#settings-harness`, { waitUntil: 'domcontentloaded' });
        await settingsPage.waitForTimeout(1200);
        const toolsGroup = settingsPage.locator('.nav-group').filter({has: settingsPage.locator('.nav-group-label', {hasText: '工具与学习'})});
        const toolLabels = await toolsGroup.locator('button strong').allTextContents();
        assert(JSON.stringify(toolLabels) === JSON.stringify(['翻译中心', '学习中心', '术语库', '模型用量']), `工具与学习导航顺序不符: ${toolLabels}`);
        const specializedGroup = settingsPage.locator('.nav-group').filter({has: settingsPage.locator('.nav-group-label', {hasText: '专项翻译'})});
        assert(await specializedGroup.locator('[data-section="settings-harness"]').count() === 1, '翻译卡片没有进入专项翻译');
        for (const [label, section] of [['翻译中心', 'settings-translation-center'], ['学习中心', 'settings-vocabulary'], ['术语库', 'settings-glossary'], ['模型用量', 'settings-model-usage']]) {
            await toolsGroup.getByRole('button', {name: label, exact: false}).click();
            await settingsPage.waitForFunction(id => location.hash === `#${id}`, section);
            assert(await settingsPage.locator('h1').innerText() === label, `${label} 导航没有激活对应页面`);
        }
        await specializedGroup.locator('[data-section="settings-harness"]').click();
        record('settings-navigation-learning-tools-order', 'passed', {tools: toolLabels, harnessGroup: '专项翻译'});
        const previewRequestsBefore = requests.length;
        const preview = settingsPage.locator('.harness-preview');
        assert((await preview.innerText()).includes('不调用模型'), '示例没有说明本地演示边界');
        for (const [action, heading] of [['读懂', '这句话在说什么'], ['拆句', '先找主干'], ['用法', 'on time'], ['练习', '试着补完整']]) {
            await preview.getByRole('button', {name: action, exact: true}).click();
            assert((await preview.locator('[data-reading-answer]').innerText()).includes(heading) && await preview.locator('[data-reading-answer] h3, [data-reading-answer] h4').count() >= 2, `设置示例 ${action} 没有切换成有层次的实际回答`);
        }
        assert(requests.length === previewRequestsBefore, '设置示例产生了模型请求');
        record('settings-interactive-preview-four-actions', 'passed');
        assert(await settingsPage.getByRole('combobox', {name: '默认动作', exact: true}).isVisible(), 'Harness 更多设置需要额外展开才能使用');
        record('settings-more-controls-always-visible', 'passed');
        const grammarToggle = settingsPage.locator('.harness-action').filter({hasText: '拆句'}).locator('input');
        await grammarToggle.uncheck();
        await selectSettingsOption(settingsPage, '默认动作', '用法');
        await settingsPage.waitForTimeout(500);
        assert(await preview.getByRole('button', {name: '拆句', exact: true}).count() === 0 && await preview.getByRole('button', {name: '用法', exact: true}).getAttribute('aria-pressed') === 'true', '设置动作开关或优先动作没有同步预览');
        const updatedActions = (await readConfig(settingsPage)).harness;
        assert(!updatedActions.actions.includes('grammar') && updatedActions.defaultAction === 'usage', '设置动作选择未持久化');
        await page.reload({waitUntil: 'domcontentloaded'});
        await page.waitForTimeout(700);
        const configuredBox = await page.locator('#target').boundingBox();
        await page.mouse.move(configuredBox.x + 8, configuredBox.y + configuredBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(configuredBox.x + 260, configuredBox.y + configuredBox.height / 2, {steps: 8});
        await page.mouse.up();
        await page.waitForTimeout(450);
        const configuredSnapshot = await shadowSnapshot(page);
        const configuredToolbar = find(configuredSnapshot.host, node => attr(node, 'class').split(' ').includes('fr-reading-indicator'));
        const configuredLabels = findAll(configuredToolbar, node => node.nodeName?.toLowerCase() === 'button' && ['读懂', '拆句', '用法', '练习'].includes(text(node).trim())).map(node => text(node).trim());
        assert(configuredLabels.length === 3 && ['读懂', '用法', '练习'].every(label => configuredLabels.includes(label)), `网页浮条和设置动作不同步: ${configuredLabels}`);
        const primaryAction = find(configuredToolbar, node => node.nodeName?.toLowerCase() === 'button' && attr(node, 'data-default-action') === 'true');
        assert(primaryAction && text(primaryAction).trim() === '用法' && attr(primaryAction, 'class').split(' ').includes('is-default'), '网页浮条没有把用户选择的用法显示为主要动作');
        const beforeConfiguredAction = requests.length;
        await clickShadowButton(page, '用法');
        await waitForReadingComplete(page);
        assert(requests.slice(beforeConfiguredAction).some(item => JSON.stringify(item.messages?.find(message => message.role === 'system')).includes('### 怎么用')), '点击网页用法入口没有直接启动对应动作');
        record('settings-toolbar-actions-and-default-sync', 'passed', {actions: configuredLabels});
        await grammarToggle.check();
        await selectSettingsOption(settingsPage, '默认动作', '读懂');
        await settingsPage.waitForTimeout(500);
        const settingsState = {moreControlsVisible: await settingsPage.getByRole('combobox', {name: '默认动作', exact: true}).isVisible()};
        assert(settingsState.moreControlsVisible, '修改配置后常驻偏好控件消失');
        await settingsPage.evaluate(() => window.scrollTo({top: 0, behavior: 'instant'}));
        await settingsPage.screenshot({ path: path.join(args.artifactsDir, 'harness-settings-1280.png') });
        result.screenshots.push(path.join(args.artifactsDir, 'harness-settings-1280.png'));
        record('settings-page-and-persistence', 'passed', {section: 'settings-harness', ...settingsState});
        await settingsPage.setViewportSize({ width: 390, height: 844 });
        assert(await settingsPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '390px设置页横向溢出');
        await settingsPage.screenshot({ path: path.join(args.artifactsDir, 'harness-settings-390.png') });
        result.screenshots.push(path.join(args.artifactsDir, 'harness-settings-390.png'));
        record('settings-narrow-390', 'passed');
        await settingsPage.emulateMedia({ colorScheme: 'dark' });
        await settingsPage.waitForFunction(() => document.documentElement.classList.contains('dark'));
        await settingsPage.screenshot({ path: path.join(args.artifactsDir, 'harness-settings-dark.png') });
        result.screenshots.push(path.join(args.artifactsDir, 'harness-settings-dark.png'));
        record('settings-dark', 'passed');
        const sessionCountBefore = requests.length;
        await openLearningRecords(settingsPage, extensionId);
        await settingsPage.goBack({waitUntil: 'domcontentloaded'});
        await settingsPage.locator('#settings-harness').waitFor({state: 'visible'});
        assert(settingsPage.url().endsWith('#settings-harness'), '设置页后退没有回到 Harness 地址');
        await settingsPage.goForward({waitUntil: 'domcontentloaded'});
        await settingsPage.locator('#settings-vocabulary').waitFor({state: 'visible'});
        assert(settingsPage.url().endsWith('#settings-vocabulary'), '设置页前进没有回到学习中心地址');
        await settingsPage.getByRole('radiogroup', {name: '学习内容', exact: true}).getByRole('radio', {name: '阅读记录', exact: true}).click();
        await settingsPage.locator('.harness-history-body').waitFor();
        record('settings-deep-link-back-forward', 'passed', {back: 'settings-harness', forward: 'settings-vocabulary'});
        await settingsPage.waitForTimeout(350);
        const historyRows = settingsPage.locator('.harness-history-row');
        const beforeRows = await historyRows.count();
        assert(beforeRows > 0, '学习中心阅读记录没有显示最近会话');
        const firstRow = historyRows.first();
        const firstText = await firstRow.locator('.harness-history-open > span').innerText();
        await firstRow.locator('.harness-history-open').click();
        await settingsPage.locator('.harness-history-detail').waitFor();
        const detail = settingsPage.locator('.harness-history-detail');
        assert(await historyRows.count() === 0 && (await detail.innerText()).includes(firstText), '设置记录详情未替代列表，或丢失原文');
        assert(await detail.locator('[data-reading-answer]').count() > 0 && await detail.locator('[data-reading-answer] h3, [data-reading-answer] h4').count() > 0 && await detail.locator('[data-reading-answer] strong').count() > 0, '设置页记录未将 Markdown 标题与重点渲染为可读结构');
        assert(requests.length === sessionCountBefore, '在设置查看记录意外调用模型');
        await settingsPage.locator('.harness-history-body').scrollIntoViewIfNeeded();
        await settingsPage.screenshot({path: path.join(args.artifactsDir, 'harness-settings-history-detail.png')});
        result.screenshots.push(path.join(args.artifactsDir, 'harness-settings-history-detail.png'));
        await settingsPage.getByRole('button', {name: '返回记录列表', exact: true}).click();
        assert(await historyRows.count() === beforeRows, '返回记录列表丢失已有记录');
        await historyRows.first().locator('.harness-history-open').click();
        await settingsPage.getByRole('button', {name: '删除此条', exact: true}).click();
        await settingsPage.waitForTimeout(250);
        assert(await historyRows.count() === beforeRows - 1, '设置页删除按钮没有移除会话');
        record('settings-session-view-delete', 'passed', {rowsBefore: beforeRows, rowsAfterDelete: await historyRows.count()});
        responseDelayMs = 1800;
        await page.setViewportSize({width: 1280, height: 900});
        await page.reload({waitUntil: 'domcontentloaded'});
        await page.waitForTimeout(700);
        const streamingTarget = await page.locator('#target').boundingBox();
        assert(streamingTarget, '清空会话 streaming fixture 没有目标几何位置');
        await page.mouse.move(streamingTarget.x + 8, streamingTarget.y + streamingTarget.height / 2);
        await page.mouse.down();
        await page.mouse.move(streamingTarget.x + 220, streamingTarget.y + streamingTarget.height / 2, {steps: 8});
        await page.mouse.up();
        await page.waitForTimeout(450);
        await clickShadowButton(page, '读懂');
        await page.waitForTimeout(150);
        const clearDialog = settingsPage.waitForEvent('dialog').then(dialog => dialog.accept());
        await settingsPage.getByRole('button', {name: '清空记录', exact: true}).click();
        await clearDialog;
        await page.waitForTimeout(2200);
        const afterClear = await send(settingsPage, {type: 'fluentReadHarness', action: 'sessions-list', offset: 0});
        assert(afterClear?.success === true && afterClear.sessions.length === 0 && requests.length > sessionCountBefore, '确认清空后会话未清空或 streaming 没有真实发起 provider 请求');
        record('settings-session-clear-streaming-no-resurrection', 'passed', {requestCount: requests.length});
        responseDelayMs = 0;
        const staleInserted = await settingsPage.evaluate(() => new Promise((resolve, reject) => {
            const request = indexedDB.open('FluentReadHarnessSessions');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const db = request.result;
                const transaction = db.transaction('sessions', 'readwrite');
                const now = Date.now();
                transaction.objectStore('sessions').put({id: 'stale-fixture', text: 'stale', context: '', createdAt: now - 31 * 24 * 60 * 60 * 1000, updatedAt: now, oldestTurnAt: now - 30 * 24 * 60 * 60 * 1000 - 1, intent: 'meaning', turns: [{id: 'stale-turn', question: 'old', answer: 'old', intent: 'meaning', status: 'completed', createdAt: now - 30 * 24 * 60 * 60 * 1000 - 1, service: 'fixture', model: 'fixture'}]});
                transaction.oncomplete = () => { db.close(); resolve(true); };
                transaction.onerror = () => reject(transaction.error);
            };
        }));
        assert(staleInserted === true, '无法向 Harness 会话 IndexedDB 写入过期 fixture');
        const afterExpiry = await send(settingsPage, {type: 'fluentReadHarness', action: 'sessions-list', offset: 0});
        assert(afterExpiry?.success === true && !afterExpiry.sessions.some(item => item.id === 'stale-fixture'), '超过 30 天的会话没有在读取时清理');
        record('session-expiry-over-30-days', 'passed');
        await settingsPage.evaluate(() => new Promise((resolve, reject) => {
            const request = indexedDB.open('FluentReadHarnessSessions');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const db = request.result;
                const transaction = db.transaction('sessions', 'readwrite');
                const now = Date.now();
                for (let index = 0; index < 32; index += 1) {
                    const createdAt = now - index * 1000;
                    transaction.objectStore('sessions').put({id: `pagination-${index}`, text: `Pagination session ${index}`, context: '', createdAt, updatedAt: createdAt, oldestTurnAt: createdAt, intent: 'meaning', turns: [{id: `pagination-turn-${index}`, question: '读懂', answer: '分页回归回答', intent: 'meaning', status: 'completed', createdAt, service: 'fixture', model: 'fixture'}]});
                }
                transaction.oncomplete = () => {db.close(); resolve(true);};
                transaction.onerror = () => reject(transaction.error);
            };
        }));
        await openLearningRecords(settingsPage, extensionId);
        await settingsPage.waitForFunction(() => document.querySelectorAll('.harness-history-row').length === 30);
        assert(await historyRows.count() === 30, '阅读记录第一页应只加载 30 条');
        await historyRows.first().getByRole('button', {name: '删除这条阅读记录', exact: true}).click();
        await settingsPage.waitForFunction(() => document.querySelectorAll('.harness-history-row').length === 29);
        await settingsPage.getByRole('button', {name: '加载更多', exact: true}).click();
        await settingsPage.waitForFunction(() => document.querySelectorAll('.harness-history-row').length >= 30);
        const pageTexts = await historyRows.locator('button span').allTextContents();
        assert(pageTexts.length === 31 && new Set(pageTexts).size === 31 && pageTexts.some(value => value.startsWith('Pagination session 30')) && pageTexts.some(value => value.startsWith('Pagination session 31')), '删除后继续分页跳过或重复了会话');
        record('settings-session-delete-then-pagination', 'passed', {visibleSessions: pageTexts.length});
        const historyScreenshot = path.join(args.artifactsDir, 'harness-settings-history.png');
        await settingsPage.screenshot({path: historyScreenshot});
        result.screenshots.push(historyScreenshot);
        await settingsPage.close();
        await persistConfig(configPage, { harness: { ...(await readConfig(configPage)).harness, contextMode: 'paragraph' } });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(700);
        const sentenceBox = await page.locator('#target').boundingBox();
        await page.mouse.move(sentenceBox.x + 8, sentenceBox.y + sentenceBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(sentenceBox.x + 180, sentenceBox.y + sentenceBox.height / 2, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(500);
        const sentenceBefore = requests.length;
        await clickShadowButton(page, '读懂');
        await page.waitForTimeout(400);
        await clickShadowButton(page, '理解整句');
        await page.waitForTimeout(1000);
        const sentenceRequest = requests.slice(sentenceBefore).filter(item => item.messages?.some(message => message.role === 'user')).at(-1);
        assert(sentenceRequest && JSON.stringify(sentenceRequest).includes('Although the task was difficult, she finished it on time.'), '理解整句请求未使用完整句子');
        record('expand-sentence-sends-full-sentence', 'passed');
        await persistConfig(configPage, { selectionTranslatorMode: 'bilingual', disableSelectionTranslator: false, harness: { ...(await readConfig(configPage)).harness, contextMode: 'selection' } });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(700);
        const dualBox = await page.locator('#target').boundingBox();
        await page.mouse.move(dualBox.x + 8, dualBox.y + dualBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(dualBox.x + 180, dualBox.y + dualBox.height / 2, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(500);
        const dualSnapshot = await shadowSnapshot(page);
        assert(dualSnapshot.text.includes('读懂') && dualSnapshot.text.includes('翻译'), 'Harness 与原有划词入口未同时可用');
        record('harness-and-legacy-selection-entry', 'passed');
        await page.mouse.move(dualBox.x + 1, dualBox.y + dualBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(dualBox.x + dualBox.width - 1, dualBox.y + dualBox.height / 2, {steps: 10});
        await page.mouse.up();
        await page.waitForTimeout(500);
        await clickShadowButton(page, '读懂');
        await page.waitForTimeout(900);
        await waitForReadingComplete(page);
        await page.setViewportSize({width: 390, height: 620});
        await page.waitForTimeout(250);
        const narrowFrames = await startCardSampling(page, 650);
        const narrowGeometry = assertCardStable(await narrowFrames.done, '窄屏阅读卡');
        record('reading-card-narrow-viewport-bounded', 'passed', narrowGeometry);
        const narrowScreenshot = path.join(args.artifactsDir, 'harness-reading-390.png');
        await page.screenshot({path: narrowScreenshot});
        result.screenshots.push(narrowScreenshot);
        await page.setViewportSize({width: 1280, height: 900});
        await page.waitForTimeout(250);
        const screenshot = path.join(args.artifactsDir, 'harness-reading-panel.png');
        const {host: cardHost, session: cardSession} = await shadowSnapshot(page);
        const card = find(cardHost, node => attr(node, 'class').split(' ').includes('fr-translation-tooltip'));
        const {model: cardBox} = await cardSession.send('DOM.getBoxModel', {nodeId: card.nodeId});
        const quad = cardBox.border;
        await page.screenshot({path: screenshot, clip: {x: quad[0], y: quad[1], width: quad[2] - quad[0], height: quad[5] - quad[1]}});
        result.screenshots.push(screenshot);
        // 没有凭据时也应能收藏原文；错误操作必须真正打开服务配置。
        await persistConfig(configPage, {token: {'custom:fixture': ''}});
        await page.reload({waitUntil: 'domcontentloaded'});
        await page.waitForTimeout(700);
        const savedSentence = await selectFixtureSentence(page);
        const beforeMissingCredential = requests.length;
        await clickShadowButton(page, '读懂');
        await waitForShadowButton(page, '设置模型');
        assert(requests.length === beforeMissingCredential && !await currentReadingAnswer(page), '缺少凭据时仍发起模型请求或显示了其他选区缓存');
        await clickShadowButton(page, '收藏原文');
        await waitForShadowButton(page, '已收藏原文');
        const learningPage = await newPage();
        await learningPage.goto(`chrome-extension://${extensionId}/options.html#settings-vocabulary`, {waitUntil: 'domcontentloaded'});
        await learningPage.getByRole('radiogroup', {name: '学习内容', exact: true}).getByRole('radio', {name: '收藏', exact: true}).click();
        const sentenceRow = learningPage.locator('.word-row').filter({has: learningPage.locator('.word-heading h3', {hasText: savedSentence})});
        await sentenceRow.waitFor();
        assert(await sentenceRow.locator('.word-heading h3').innerText() === savedSentence, '学习中心的句子收藏丢失原文');
        assert(requests.length === beforeMissingCredential, '收藏或打开学习中心产生了额外模型请求');
        record('sentence-save-without-answer-learning-center', 'passed', {source: savedSentence, modelRequests: 0});
        const learningSpeechBefore = ttsRequests.length;
        await sentenceRow.getByRole('button', {name: '朗读原文', exact: true}).click();
        await sentenceRow.getByRole('button', {name: '停止朗读', exact: true}).waitFor();
        await waitUntil(() => ttsRequests.length > learningSpeechBefore, '学习中心朗读没有发起 TTS 合成 HTTP');
        assert(ttsRequests.at(-1).ssml.includes(savedSentence), '学习中心没有朗读收藏的原文');
        await learningPage.waitForTimeout(250);
        await sentenceRow.getByRole('button', {name: '停止朗读', exact: true}).click();
        await sentenceRow.getByRole('button', {name: '朗读原文', exact: true}).waitFor();
        record('learning-center-sentence-audio-play-stop', 'passed', {synthesisRequests: ttsRequests.length - learningSpeechBefore, muted: true, listeningVerified: false});
        const learningScreenshot = path.join(args.artifactsDir, 'harness-learning-center-sentence.png');
        await learningPage.screenshot({path: learningScreenshot}); result.screenshots.push(learningScreenshot);
        await learningPage.close();
        // 只适配两次设置跳转的 OS 建页边界：UI→消息→handler→原始 URL→真实页面挂载保持生产路径。
        // 此 Edge 的 chrome.tabs.create 即使 active:false 也可能激活前台。先由焦点安全 helper 预建
        // 两张真实隔离页，仅将对应 create 委托为 tabs.update，返回原生真实 Tab；结束后恢复 API。
        if (!args.headed) {
            const reservedTargets = [await newPage(), await newPage()];
            const reservedIds = [];
            for (const target of reservedTargets) {
                await target.goto(`chrome-extension://${extensionId}/options.html#settings-general`, {waitUntil: 'domcontentloaded'});
                reservedIds.push(await target.evaluate(async () => (await chrome.tabs.getCurrent())?.id));
            }
            await worker.evaluate(reservedIds => {
                if (reservedIds.some(id => !Number.isSafeInteger(id))) throw new Error('找不到焦点安全预建的隔离设置页');
                const original = chrome.tabs.create;
                const nativeUpdate = chrome.tabs.update;
                const prefix = chrome.runtime.getURL('options.html');
                globalThis.__harnessOptionsNavigation = [];
                globalThis.__harnessRestoreTabsCreate = () => {chrome.tabs.create = original;};
                chrome.tabs.create = function(properties, ...rest) {
                    if (properties?.url === prefix || properties?.url?.startsWith(`${prefix}#`)) {
                        const tabId = reservedIds.shift();
                        if (!Number.isSafeInteger(tabId)) throw new Error('超出两次设置导航测试边界');
                        globalThis.__harnessOptionsNavigation.push({original: {...properties}, realReservedTabId: tabId});
                        return nativeUpdate.call(chrome.tabs, tabId, {url: properties.url, active: false}, ...rest);
                    }
                    return original.call(chrome.tabs, properties, ...rest);
                };
            }, reservedIds);
        }
        try {
            await clickShadowButton(page, '设置模型');
            const modelSettings = await optionsTarget(context, 'settings-services');
            record('reading-error-opens-model-settings', 'passed', {url: modelSettings.url(), foregroundActivationVerified: args.headed});
            for (const target of context.pages().filter(target => !target.isClosed() && target.url().endsWith('#settings-harness'))) {
                await target.goto(`chrome-extension://${extensionId}/options.html#settings-general`, {waitUntil: 'domcontentloaded'});
            }
            await clickShadowButton(page, '打开翻译卡片设置');
            const harnessSettings = await optionsTarget(context, 'settings-harness');
            record('reading-footer-opens-harness-settings', 'passed', {url: harnessSettings.url(), foregroundActivationVerified: args.headed});
        } finally {
            if (!args.headed) result.optionsNavigationFocusAdapter = await worker.evaluate(() => {
                globalThis.__harnessRestoreTabsCreate?.();
                return {scope: 'two reading-card options navigation clicks only', adapter: 'CDP background precreated real tabs + native tabs.update(url, active:false)', nativeTabCreation: false, nativeTabUpdate: true, foregroundActivationVerified: false, originalCalls: globalThis.__harnessOptionsNavigation};
            });
        }
        if (!args.headed) assert(result.optionsNavigationFocusAdapter.originalCalls.length === 2, '两次设置跳转没有经过预期的真实 tabs.create');
        await persistConfig(configPage, {token: {'custom:fixture': 'fixture-token'}});
        result.audio.messages = await worker.evaluate(() => globalThis.__harnessTtsMessages);

        const memoryPage = await newPage();
        await openLearningMemories(memoryPage, extensionId);
        const memoryManager = memoryPage.locator('.fr-learning-memory');
        assert((await memoryManager.innerText()).includes('当前未启用记忆'), '学习中心没有明确说明记忆关闭时仍可管理内容');
        const memoryV1 = 'HARNESS_MEMORY_PREF_V1：解释 although 时，先解释主干，再说明让步关系。';
        const memoryV2 = 'HARNESS_MEMORY_PREF_V2：解释 although 时，先说作用，再介绍语法术语。';
        const beforeMemoryManagement = requests.length;
        await addLearningMemoryInUi(memoryPage, memoryV1);
        const memoryRows = memoryManager.locator('.fr-memory-item');
        await memoryRows.first().getByRole('button', {name: '查看 / 编辑', exact: true}).click();
        await memoryManager.getByRole('textbox', {name: '记忆内容', exact: true}).fill(memoryV2);
        await memoryManager.getByRole('button', {name: '保存', exact: true}).click();
        await memoryManager.locator('.fr-memory-editor').waitFor({state: 'hidden'});
        await addLearningMemoryInUi(memoryPage, memoryV2);
        assert(await memoryRows.count() === 1 && (await memoryRows.first().innerText()).includes(memoryV2), '记忆编辑或精确重复幂等失效');
        await openLearningMemories(memoryPage, extensionId);
        await memoryPage.getByText(memoryV2, {exact: true}).waitFor();
        assert(!(await memoryManager.innerText()).includes(memoryV1) && requests.length === beforeMemoryManagement, '重载丢失记忆编辑，或关闭记忆时手动管理调用了模型');
        record('memory-manage-disabled-edit-dedupe-reload', 'passed', {savedMemories: await memoryRows.count(), modelRequests: 0});
        await addLearningMemoryInUi(memoryPage, 'HARNESS_MEMORY_NOTE：这是独立的测试笔记。', 'note');
        await memoryManager.getByRole('searchbox', {name: '搜索记忆', exact: true}).fill('PREF_V2');
        assert(await memoryRows.count() === 1 && (await memoryRows.innerText()).includes(memoryV2), '学习记忆搜索没有筛选出对应内容');
        await memoryManager.getByRole('searchbox', {name: '搜索记忆', exact: true}).fill('');
        await memoryRows.filter({hasText: 'HARNESS_MEMORY_NOTE'}).getByRole('button', {name: '删除', exact: true}).click();
        await waitUntil(async () => await memoryRows.count() === 1, '记忆删除没有更新可见列表');
        record('memory-search-delete', 'passed');

        const setMemoryEnabled = async value => {
            await configPage.goto(`chrome-extension://${extensionId}/options.html#settings-harness`, {waitUntil: 'domcontentloaded'});
            const control = configPage.getByRole('switch', {name: '启用学习记忆', exact: true});
            await control.waitFor({state: 'attached'});
            const switchCore = control.locator('xpath=ancestor::*[contains(@class, "el-switch")][1]').locator('.el-switch__core');
            await switchCore.waitFor({state: 'visible'});
            if ((await control.getAttribute('aria-checked') === 'true') !== value)
                await switchCore.click();
            await waitUntil(async () => (await readConfig(configPage)).harness.memoryEnabled === value, '学习记忆开关未持久化');
            await configPage.reload({waitUntil: 'domcontentloaded'});
            await control.waitFor({state: 'attached'});
            await switchCore.waitFor({state: 'visible'});
            assert(await control.getAttribute('aria-checked') === String(value), '学习记忆开关重载后丢失');
        };
        const freshMemoryReading = async () => {
            await page.reload({waitUntil: 'domcontentloaded'});
            await page.waitForTimeout(700);
            await selectFixtureSentence(page);
            const start = requests.length;
            await clickShadowButton(page, '读懂');
            await waitForReadingComplete(page);
            return requests.slice(start);
        };
        await setMemoryEnabled(true);
        const withMemory = await freshMemoryReading();
        assert(withMemory.length === 1 && JSON.stringify(withMemory).includes(memoryV2) && !JSON.stringify(withMemory).includes(memoryV1), '开启后新会话没有召回编辑后的记忆，或为记忆多调用了模型');
        assert((await shadowSnapshot(page)).text.includes('参考 1 条记忆'), '阅读卡没有说明参考了已保存记忆');
        record('memory-enabled-persist-recall-new-session', 'passed', {providerCalls: withMemory.length});
        const beforeRemember = requests.length;
        await clickShadowButton(page, '记住要点');
        await waitForShadowButton(page, '已记住');
        const rememberedReadingScreenshot = path.join(args.artifactsDir, 'harness-reading-memory.png');
        await page.screenshot({path: rememberedReadingScreenshot}); result.screenshots.push(rememberedReadingScreenshot);
        await openLearningMemories(memoryPage, extensionId);
        await waitUntil(async () => await memoryRows.count() === 2, '记住要点没有保存到学习中心');
        assert((await memoryManager.innerText()).includes('学习要点：') && requests.length === beforeRemember, '主动记住要点丢失内容或额外调用模型');
        record('memory-explicit-remember-answer', 'passed', {savedMemories: await memoryRows.count()});
        const memoryScreenshot = path.join(args.artifactsDir, 'harness-learning-memories.png');
        await memoryPage.screenshot({path: memoryScreenshot}); result.screenshots.push(memoryScreenshot);
        await memoryPage.setViewportSize({width: 390, height: 844});
        assert(await memoryPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '390px 学习记忆页横向溢出');
        const narrowMemoryScreenshot = path.join(args.artifactsDir, 'harness-learning-memories-390.png');
        await memoryPage.screenshot({path: narrowMemoryScreenshot}); result.screenshots.push(narrowMemoryScreenshot);
        await setMemoryEnabled(false);
        const withoutMemory = await freshMemoryReading();
        assert(!JSON.stringify(withoutMemory).includes(memoryV2) && !JSON.stringify(withoutMemory).includes('用户主动保存的学习记忆'), '关闭开关后新请求仍包含长期学习记忆');
        await openLearningMemories(memoryPage, extensionId);
        await waitUntil(async () => await memoryRows.count() === 2, '关闭功能删除了用户保存的记忆');
        record('memory-disable-stops-recall-keeps-data', 'passed', {savedMemories: await memoryRows.count()});
        await setMemoryEnabled(true);
        await memoryRows.filter({hasText: memoryV2}).getByRole('button', {name: '删除', exact: true}).click();
        await waitUntil(async () => await memoryRows.count() === 1, '没有删除学习偏好');
        const afterMemoryDelete = await freshMemoryReading();
        assert(!JSON.stringify(afterMemoryDelete).includes(memoryV2), '新请求仍召回已删除的学习偏好');
        record('memory-delete-excludes-from-recall', 'passed');
        const memoryClearDialog = memoryPage.waitForEvent('dialog').then(dialog => dialog.accept());
        await memoryManager.getByRole('button', {name: '清空记忆', exact: true}).click();
        await memoryClearDialog;
        await waitUntil(async () => await memoryRows.count() === 0, '清空学习记忆没有更新列表');
        await openLearningMemories(memoryPage, extensionId);
        await memoryManager.getByText('还没有学习记忆', {exact: true}).waitFor();
        const afterMemoryClear = await freshMemoryReading();
        assert(!JSON.stringify(afterMemoryClear).includes('用户主动保存的学习记忆'), '清空后新会话仍含旧记忆');
        record('memory-clear-reload-stops-recall', 'passed');
        await memoryPage.close();
        await setMemoryEnabled(false);
        } else {
            await persistConfig(configPage, {harness: {...(await readConfig(configPage)).harness, enabled: true, contextMode: 'selection'}});
        }
        const uiPersistPage = await newPage();
        uiPersistPage.on('console', message => {if (message.type() === 'warning') (result.warnings ||= []).push(message.text())});
        await uiPersistPage.goto(`chrome-extension://${extensionId}/options.html#settings-harness`, { waitUntil: 'domcontentloaded' });
        await uiPersistPage.waitForTimeout(1000);
        const enabledSwitch = uiPersistPage.getByRole('switch', { name: '启用翻译卡片' });
        const beforeSwitch = await enabledSwitch.getAttribute('aria-checked');
        assert(beforeSwitch === 'true', '持久化测试起始开关应开启');
        await enabledSwitch.locator('xpath=ancestor::*[contains(@class, "el-switch")][1]').locator('.el-switch__core').click();
        await uiPersistPage.waitForFunction(() => document.querySelector('[role="switch"][aria-label="启用翻译卡片"]')?.getAttribute('aria-checked') === 'false');
        await uiPersistPage.getByRole('radio', { name: '可参考本段' }).click();
        await uiPersistPage.waitForTimeout(900);
        result.persistenceBeforeClose = {harness: (await readConfig(uiPersistPage)).harness, checked: await enabledSwitch.getAttribute('aria-checked')};
        await uiPersistPage.close();
        const reopened = await newPage();
        await reopened.goto(`chrome-extension://${extensionId}/options.html#settings-harness`, { waitUntil: 'domcontentloaded' });
        await reopened.waitForTimeout(1000);
        const reopenedSwitch = reopened.getByRole('switch', { name: '启用翻译卡片' });
        const reopenedConfig = await readConfig(reopened);
        const switchState = await reopenedSwitch.getAttribute('aria-checked');
        result.persistenceAfterReopen = {harness: reopenedConfig.harness, checked: switchState};
        assert(switchState === 'false' && reopenedConfig.harness.enabled === false && reopenedConfig.harness.contextMode === 'paragraph', '设置 UI 修改关闭重开后未持久化');
        const persistence = record('settings-ui-modify-close-reopen', 'passed', { before: {enabled: true, contextMode: 'selection'}, after: {enabled: false, contextMode: 'paragraph'}, uiChecked: switchState });
        result.persistenceCases.push(persistence);
        await reopened.screenshot({path: path.join(args.artifactsDir, 'harness-settings-reopened.png')});
        await page.reload({waitUntil: 'domcontentloaded'});
        await page.waitForTimeout(500);
        const resumedConfig = await readConfig(configPage);
        assert(resumedConfig.harness.enabled === false, '关闭重开后其他设置页没有同步');
        result.crossPageSync = {passed: true};
        await reopened.close();
        await verifyHarnessSaveRace({newPage, configPage, extensionId, args, result, record, quickClose: false});
        await verifyHarnessSaveRace({newPage, configPage, extensionId, args, result, record, quickClose: true});
        result.backgroundSaveReceipts = await worker.evaluate(() => globalThis.__fluentReadHarnessSaveReceipts);
        result.apiRequests = requests;
        result.ok = result.cases.every(item => item.status === 'passed') && result.consoleErrors.length === 0 && result.httpErrors.length === 0;
        fs.writeFileSync(path.join(args.artifactsDir, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if (!result.ok)
            process.exitCode = 1;
    }
    catch (error) {
        result.error = error.stack || error.message;
        result.failureSurfaces = [];
        const openPages = context?.pages().filter(target => !target.isClosed() && target.url() !== 'about:blank') || [];
        for (const [index, target] of openPages.entries()) {
            const failurePath = path.join(args.artifactsDir, `harness-failure-${index + 1}.png`);
            try {
                await target.screenshot({path: failurePath, timeout: 5000});
                result.screenshots.push(failurePath);
                result.failureSurfaces.push({url: target.url(), screenshot: failurePath});
            } catch (captureError) {
                result.failureSurfaces.push({url: target.url(), captureError: captureError.message});
            }
        }
        fs.writeFileSync(path.join(args.artifactsDir, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        process.exitCode = 1;
    }
    finally {
        await close().catch(() => { });
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(profile, { recursive: true, force: true });
    }
}
main().catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
