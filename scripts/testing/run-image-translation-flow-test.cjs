'use strict';
/**
 * 图片翻译生产产物回归：真实 Tesseract、可信点击、确定性翻译 transport。
 * 所有用例复用同一自动临时配置，由 focus-safe helper 保持正常尺寸、后台且不抢焦点。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

function arg(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`缺少 --${name} 的值`);
    return value;
}
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifacts = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-image-flow'));
const playwrightRoot = arg('playwright-root', process.env.PLAYWRIGHT_ROOT);
const focusHelper = arg('focus-safe-helper', process.env.FLUENTREAD_FOCUS_SAFE_HELPER);
const xSurface = process.argv.includes('--x-surface');
const liveTranslation = process.argv.includes('--live-translation');
const multilingual = process.argv.includes('--multilingual');
if (!playwrightRoot || !focusHelper)
    throw new Error('必须提供 --playwright-root 与 --focus-safe-helper');
const { chromium } = require(path.join(playwrightRoot, 'playwright'));
const { launchFocusSafePersistentContext, newPageWithoutForeground } = require(focusHelper);
fs.mkdirSync(artifacts, { recursive: true });
const report = {
    scope: `real Tesseract OCR + ${liveTranslation ? 'live Google transport' : 'deterministic Google transport'} + production extension`,
    cases: [], errors: [], screenshots: [], geometry: [], cleanupErrors: [],
    profileMode: 'automatically-created-temporary-profile',
};
const temporaryRoot = fs.realpathSync(os.tmpdir());
const profileDir = fs.mkdtempSync(path.join(temporaryRoot, 'fluentread-image-flow-'));
const profileToken = crypto.randomUUID();
const profileMarker = path.join(profileDir, '.fluentread-fixture-owner');
fs.writeFileSync(profileMarker, profileToken, {flag: 'wx'});
const profileIdentity = fs.lstatSync(profileDir);
const html = `<!doctype html>
<html><head><title>Image translation workflow</title><style>
body {font:16px system-ui;background:#eef1f6;margin:40px}
h1 {font-size:24px}
.card {padding:24px;background:white;border-radius:16px;width:760px}
img {display:block;width:700px;height:350px;object-fit:contain}
button {background:red;color:black;border:30px solid green}
body>div {animation:none}
</style></head><body>
<h1>图片翻译 · 端到端验证</h1>
<p>真实 OCR / ${liveTranslation ? '在线翻译' : '确定性翻译'} / 原图与译图切换</p>
<div class="card"><img id="sample" alt="英文截图"></div>
<div style="height:1000px"></div>
<script>
const canvas = document.createElement('canvas');
canvas.width = 1400; canvas.height = 700;
const context = canvas.getContext('2d');
context.fillStyle = '#fff'; context.fillRect(0, 0, 1400, 700);
context.fillStyle = '#19304b'; context.font = '48px Arial';
${JSON.stringify(multilingual
    ? ['简体中文阅读测试', '繁體中文閱讀測試', 'English OCR language test']
    : ['Welcome to FluentRead', 'Translate images with one click', 'Read every word in your language'])}
    .forEach((text, index) => context.fillText(text, 70, 145 + index * 155));
document.querySelector('#sample').src = canvas.toDataURL();
${xSurface ? `
const image = document.querySelector('#sample');
const photo = document.createElement('div');
photo.dataset.testid = 'tweetPhoto';
photo.style.cssText = 'position:relative;width:700px;height:350px;overflow:hidden;border-radius:16px';
image.before(photo); photo.append(image);
const background = document.createElement('div');
background.id = 'x-surface';
background.style.cssText = 'position:absolute;inset:0;background-size:cover;background-position:center';
background.style.backgroundImage = 'url("' + image.src + '")';
photo.prepend(background);
image.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;opacity:0;z-index:-1';
` : ''}
</script></body></html>`;
const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(html);
});
let launched;
let launchAttempted = false;
let page;
let cdp;
let diagnosticCdp;
let readUi;
let currentCase = 'launch';

/** 在真实浏览器内读取内容框和拟合矩形；不依赖原图 opacity，它可能正被翻译替换租约隐藏。 */
function readGeometry() {
    const source = document.querySelector('#sample');
    const overlay = this.querySelector('.fluent-read-image-translation-overlay');
    const bitmap = overlay?.querySelector('img');
    if (!source || !bitmap || !bitmap.complete || !bitmap.naturalWidth) return null;
    const rectOf = node => {
        const rect = node.getBoundingClientRect();
        return {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height};
    };
    const intersection = (...rectangles) => {
        const left = Math.max(...rectangles.map(rect => rect.left));
        const top = Math.max(...rectangles.map(rect => rect.top));
        const right = Math.max(left, Math.min(...rectangles.map(rect => rect.right)));
        const bottom = Math.max(top, Math.min(...rectangles.map(rect => rect.bottom)));
        return {left, top, right, bottom, width: right - left, height: bottom - top};
    };
    const geometryOf = image => {
        const rect = rectOf(image);
        const style = getComputedStyle(image);
        const edges = Object.fromEntries(['Top', 'Right', 'Bottom', 'Left'].map(side => [side.toLowerCase(), {
            border: Number.parseFloat(style[`border${side}Width`]) || 0,
            padding: Number.parseFloat(style[`padding${side}`]) || 0,
        }]));
        const left = rect.left + edges.left.border + edges.left.padding;
        const top = rect.top + edges.top.border + edges.top.padding;
        const width = rect.width - edges.left.border - edges.left.padding - edges.right.border - edges.right.padding;
        const height = rect.height - edges.top.border - edges.top.padding - edges.bottom.border - edges.bottom.padding;
        const content = {left, top, width, height, right: left + width, bottom: top + height};
        const intrinsic = {width: image.naturalWidth, height: image.naturalHeight};
        const fit = style.objectFit;
        const containScale = Math.min(width / intrinsic.width, height / intrinsic.height);
        const scale = fit === 'cover' ? Math.max(width / intrinsic.width, height / intrinsic.height)
            : fit === 'none' ? 1 : fit === 'scale-down' ? Math.min(1, containScale) : containScale;
        const paintedWidth = fit === 'fill' ? width : intrinsic.width * scale;
        const paintedHeight = fit === 'fill' ? height : intrinsic.height * scale;
        const position = style.objectPosition.split(/\s+/);
        const offset = (value, available) => value.endsWith('%') ? Number.parseFloat(value) * available / 100 : Number.parseFloat(value);
        const paintedLeft = left + offset(position[0], width - paintedWidth);
        const paintedTop = top + offset(position[1], height - paintedHeight);
        const painted = {left: paintedLeft, top: paintedTop, width: paintedWidth, height: paintedHeight,
            right: paintedLeft + paintedWidth, bottom: paintedTop + paintedHeight};
        return {rect, content, painted, intrinsic, edges, fit, position: style.objectPosition};
    };
    const sourceGeometry = geometryOf(source);
    const bitmapGeometry = geometryOf(bitmap);
    const viewport = {left: 0, top: 0, right: innerWidth, bottom: innerHeight};
    const ancestorClips = [];
    for (let ancestor = source.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const clipsX = /^(hidden|clip|auto|scroll)$/.test(style.overflowX);
        const clipsY = /^(hidden|clip|auto|scroll)$/.test(style.overflowY);
        if (!clipsX && !clipsY) continue;
        const rect = rectOf(ancestor);
        const left = rect.left + ancestor.clientLeft;
        const top = rect.top + ancestor.clientTop;
        ancestorClips.push({
            left: clipsX ? left : -Infinity, right: clipsX ? left + ancestor.clientWidth : Infinity,
            top: clipsY ? top : -Infinity, bottom: clipsY ? top + ancestor.clientHeight : Infinity,
        });
    }
    const overlayRect = rectOf(overlay);
    const matched = /^inset\(([^)]+)\)$/.exec(getComputedStyle(overlay).clipPath);
    if (!matched) return null;
    const values = matched[1].split(/\s+/).map(Number.parseFloat);
    const insets = [values[0], values[1] ?? values[0], values[2] ?? values[0], values[3] ?? values[1] ?? values[0]];
    const overlayClip = {
        left: overlayRect.left + insets[3], top: overlayRect.top + insets[0],
        right: overlayRect.right - insets[1], bottom: overlayRect.bottom - insets[2],
    };
    return {
        source: sourceGeometry, bitmap: bitmapGeometry, overlayRect, insets,
        sourceVisible: intersection(sourceGeometry.painted, sourceGeometry.content, viewport, ...ancestorClips),
        bitmapVisible: intersection(bitmapGeometry.painted, bitmapGeometry.content, overlayClip),
        ancestorClipCount: ancestorClips.length,
        bitmapIdentity: bitmap.dataset.probeIdentity,
    };
}

function assertRectClose(actual, expected, label) {
    for (const key of ['left', 'top', 'right', 'bottom', 'width', 'height']) {
        assert.ok(Number.isFinite(actual[key]) && Math.abs(actual[key] - expected[key]) <= 1,
            `${label}.${key}: expected ${expected[key]}, received ${actual[key]}`);
    }
}

function assertGeometry(snapshot) {
    assert.ok(snapshot, '译图尚未形成可测量布局');
    assertRectClose(snapshot.overlayRect, snapshot.source.rect, 'overlay border box');
    assertRectClose(snapshot.bitmap.rect, snapshot.source.rect, 'bitmap border box');
    assertRectClose(snapshot.bitmap.content, snapshot.source.content, 'bitmap content box');
    assertRectClose(snapshot.bitmap.painted, snapshot.source.painted, 'fitted image');
    assertRectClose(snapshot.bitmapVisible, snapshot.sourceVisible, 'visible image');
    assert.deepEqual(snapshot.bitmap.intrinsic, snapshot.source.intrinsic);
    assert.equal(snapshot.bitmapIdentity, 'retained');
}

async function verifyGeometryCases({worker, ui, wait, shot}) {
    const requestsBefore = await worker.evaluate(() => globalThis.__imageFixture.requests.length);
    const properties = ['width', 'height', 'box-sizing', 'padding', 'border', 'object-fit', 'object-position'];
    // 只恢复本夹具修改的属性，保留图片 runtime 正在持有的 opacity 租约。
    const originalStyles = await page.locator('#sample').evaluate((image, properties) =>
        properties.map(property => [property, image.style.getPropertyValue(property), image.style.getPropertyPriority(property)]), properties);
    const cases = [
        {name: 'contain-padding-border', fit: 'contain', position: '25% 75%'},
        {name: 'cover-padding-border', fit: 'cover', position: '70% 30%'},
        {name: 'none-padding-border', fit: 'none', position: '25% 75%'},
        {name: 'ancestor-clipping', fit: 'cover', position: '50% 50%', clipped: true},
        {name: 'ancestor-scroll-clipping', fit: 'contain', position: '50% 50%', clipped: true, scroll: true},
    ];
    try {
        for (const fixture of cases) {
            currentCase = `geometry: ${fixture.name}`;
            await page.evaluate(fixture => {
                const image = document.querySelector('#sample');
                Object.assign(image.style, {
                    width: '620px', height: '390px', boxSizing: 'content-box',
                    padding: '12px 18px 24px 30px', border: '6px solid #637fad',
                    objectFit: fixture.fit, objectPosition: fixture.position,
                });
                if (fixture.clipped) {
                    let clip = document.querySelector('#geometry-clip');
                    if (!clip) {
                        clip = document.createElement('div');
                        clip.id = 'geometry-clip';
                        image.before(clip);
                        clip.append(image);
                    }
                    Object.assign(clip.style, {
                        width: '480px', height: '240px', padding: '11px', border: '9px solid #303d52',
                        overflow: fixture.scroll ? 'auto' : 'hidden', boxSizing: 'content-box',
                    });
                    clip.scrollLeft = fixture.scroll ? 45 : 0;
                    clip.scrollTop = fixture.scroll ? 35 : 0;
                }
                window.scrollTo(0, 0);
            }, fixture);
            let snapshot;
            let lastFailure;
            await wait(async () => {
                snapshot = await ui(`return (${readGeometry.toString()}).call(this)`);
                try {
                    assertGeometry(snapshot);
                    if (fixture.clipped) {
                        assert.ok(snapshot.ancestorClipCount > 0, '祖先裁切夹具未生效');
                        assert.ok(snapshot.insets.some(value => value > 0), '译图必须发生实际裁切');
                    }
                    return true;
                } catch (error) {
                    lastFailure = error.message;
                    return false;
                }
            }, 5_000).catch(async error => {
                report.geometry.push({name: fixture.name, success: false, snapshot, failure: lastFailure});
                await shot(`failure-${fixture.name}`).catch(() => undefined);
                throw error;
            });
            report.geometry.push({name: fixture.name, success: true, snapshot});
            report.cases.push(`DOM geometry matches source: ${fixture.name}`);
            await shot(`geometry-${fixture.name}`);
        }
        assert.equal(await worker.evaluate(() => globalThis.__imageFixture.requests.length), requestsBefore);
    } finally {
        await page.evaluate(styles => {
            const image = document.querySelector('#sample');
            document.querySelector('#geometry-clip')?.replaceWith(image);
            for (const [property, value, priority] of styles) {
                if (value) image.style.setProperty(property, value, priority);
                else image.style.removeProperty(property);
            }
            window.scrollTo(0, 0);
        }, originalStyles);
    }
}

(async () => {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    launchAttempted = true;
    launched = await launchFocusSafePersistentContext({
        chromium, profileDir,
        browserPath: arg('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
        headless: false, background: true,
        browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check'],
        viewport: {width: 1280, height: 900}, timeout: 30_000,
    });
    Object.assign(report, { launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement });
    assert.equal(launched.launchMode, 'macos-background-cdp');
    assert.equal(launched.focusPolicy, 'launchservices-no-foreground');
    assert.equal(launched.windowPlacement.mode, 'background-visible-no-focus');
    assert.equal(launched.windowPlacement.browserFrontmost, false);
    const context = launched.context;
    report.console = [];
    context.on('console', message => {
        if (['warning', 'error'].includes(message.type())) report.console.push({type: message.type(), text: message.text().slice(0, 1500)});
    });
    // Offscreen / dedicated OCR Worker 不一定由 Playwright 作为 Page 暴露，直接订阅其 CDP 控制台。
    if (xSurface) {
        diagnosticCdp = await context.browser().newBrowserCDPSession();
        const observed = new Set();
        const enabledSessions = new Set();
        const sessionParents = new Map();
        let diagnosticMessageId = 0;
        report.ocrConsole = [];
        report.ocrTargets = [];
        const targetIsOcr = targetInfo => targetInfo.url.includes('/fluent-read-ocr/') || targetInfo.url.endsWith('/offscreen.html');
        const sendToTargetSession = async (sessionId, method, params = {}) => {
            const id = ++diagnosticMessageId;
            const message = JSON.stringify({id, method, params});
            const parentSessionId = sessionParents.get(sessionId);
            if (parentSessionId) {
                await sendToTargetSession(parentSessionId, 'Target.sendMessageToTarget', {
                    sessionId,
                    message,
                });
                return;
            }
            await diagnosticCdp.send('Target.sendMessageToTarget', {sessionId, message});
        };
        const enableNestedTargets = async sessionId => {
            if (enabledSessions.has(sessionId)) return;
            enabledSessions.add(sessionId);
            await sendToTargetSession(sessionId, 'Runtime.enable');
            await sendToTargetSession(sessionId, 'Target.setAutoAttach', {
                autoAttach: true,
                waitForDebuggerOnStart: false,
                flatten: false,
            });
        };
        const recordTarget = (targetInfo, parentSessionId) => {
            if (!targetIsOcr(targetInfo)) return;
            if (observed.has(targetInfo.targetId)) return;
            observed.add(targetInfo.targetId);
            report.ocrTargets.push({
                targetId: targetInfo.targetId,
                parentSessionId: parentSessionId || null,
                type: targetInfo.type,
                url: targetInfo.url,
            });
        };
        const attachTarget = async (targetInfo, parentSessionId = null) => {
            if (!targetIsOcr(targetInfo) || observed.has(targetInfo.targetId)) return;
            try {
                const {sessionId} = await diagnosticCdp.send('Target.attachToTarget', {
                    targetId: targetInfo.targetId,
                    flatten: false,
                });
                sessionParents.set(sessionId, parentSessionId);
                recordTarget(targetInfo, parentSessionId);
                await enableNestedTargets(sessionId);
            } catch (error) {
                report.ocrConsole.push({diagnosticError: error.message, targetUrl: targetInfo.url});
            }
        };
        const handleTargetEvent = async (event, parentSessionId = null) => {
            if (event.method === 'Target.attachedToTarget') {
                const {sessionId, targetInfo} = event.params;
                if (!targetIsOcr(targetInfo)) return;
                sessionParents.set(sessionId, parentSessionId);
                recordTarget(targetInfo, parentSessionId);
                try {
                    await enableNestedTargets(sessionId);
                } catch (error) {
                    report.ocrConsole.push({diagnosticError: error.message, targetUrl: targetInfo.url});
                }
                return;
            }
            if (event.method === 'Target.detachedFromTarget') return;
            if (event.method === 'Runtime.consoleAPICalled' && ['warning','error'].includes(event.params.type)) {
                report.ocrConsole.push({
                    type: event.params.type,
                    targetSessionId: parentSessionId,
                    text: event.params.args.map(arg=>arg.value ?? arg.description ?? '').join(' ').slice(0,2000),
                });
            }
        };
        diagnosticCdp.on('Target.receivedMessageFromTarget', async ({sessionId, message}) => {
            try {
                await handleTargetEvent(JSON.parse(message), sessionId);
            } catch (error) {
                report.ocrConsole.push({diagnosticError: error.message, targetSessionId: sessionId});
            }
        });
        diagnosticCdp.on('Target.attachedToTarget', event => {
            void handleTargetEvent(event).catch(error => report.ocrConsole.push({diagnosticError: error.message}));
        });
        const observeTarget = ({targetInfo}) => void attachTarget(targetInfo);
        diagnosticCdp.on('Target.targetCreated', observeTarget);
        diagnosticCdp.on('Target.targetInfoChanged', observeTarget);
        await diagnosticCdp.send('Target.setDiscoverTargets',{discover:true});
        const {targetInfos}=await diagnosticCdp.send('Target.getTargets');
        await Promise.all(targetInfos.map(targetInfo=>attachTarget(targetInfo)));
    }
    const worker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://')) || await context.waitForEvent('serviceworker', { timeout: 30000 });
    const popup = await newPageWithoutForeground(context, 30000);
    await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    await popup.evaluate(async xSurface => {
        const read = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
        const config = read.value;
        const patch = {on: true, disableImageTranslator: false, from: xSurface ? 'auto' : 'en', to: 'zh-Hans', service: 'google'};
        const response = await chrome.runtime.sendMessage({
            type: 'persistConfig', mode: 'patch', config: patch,
            expected: Object.fromEntries(Object.keys(patch).map(key => [key, config[key]])),
            clientId: 'image-flow-fixture', sequence: 1, baseRevision: config.__fluentConfigRevision || 0,
        });
        if (!response.success) throw new Error(response.error);
    }, xSurface);
    await worker.evaluate(liveTranslation => {
        const originalFetch = globalThis.fetch.bind(globalThis);
        globalThis.__imageFixture = {requests: [], delay: 250};
        globalThis.fetch = async (input, options) => {
            const url = String(typeof input === 'string' ? input : input.url || input);
            if (url.includes('/_/TranslateWebserverUi/data/batchexecute')) {
                const body = new URLSearchParams(options.body);
                const rpc = JSON.parse(body.get('f.req'))[0][0];
                const origin = JSON.parse(rpc[1])[0][0];
                if (typeof origin !== 'string') throw new Error('Unexpected Google batchexecute payload');
                globalThis.__imageFixture.requests.push(origin);
                if (liveTranslation) return originalFetch(input, options);
                await new Promise((resolve, reject) => {
                    const signal = options.signal;
                    const onAbort = () => {
                        clearTimeout(timer);
                        signal?.removeEventListener('abort', onAbort);
                        reject(new DOMException('Aborted', 'AbortError'));
                    };
                    const timer = setTimeout(() => {
                        signal?.removeEventListener('abort', onAbort);
                        resolve();
                    }, globalThis.__imageFixture.delay);
                    if (signal?.aborted) onAbort();
                    else signal?.addEventListener('abort', onAbort, {once: true});
                });
                const text = origin.toLowerCase().includes('welcome') ? '欢迎使用流畅阅读'
                    : origin.toLowerCase().includes('click') ? '单击即可翻译图片' : '用自己的语言读懂每一个字';
                const entry = [null, null, null, null, null, [[text]]];
                return new Response(JSON.stringify([['wrb.fr', 'MkEWBc', JSON.stringify([null, [[entry]]])]]), {status: 200});
            }
            if (url.includes('translate.googleapis.com') || url.includes('translate.google')) {
                throw new Error('Unexpected translation fallback in deterministic fixture');
            }
            // OCR worker、wasm 和语言包仍沿真实生产路径加载，不 mock Tesseract。
            return originalFetch(input, options);
        };
    }, liveTranslation);
    page = await newPageWithoutForeground(context, 30000);
    page.on('pageerror', e => report.errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    cdp = await context.newCDPSession(page);
    async function rootObject() {
        const tree = await cdp.send('DOM.getDocument', {depth: -1, pierce: true});
        let host;
        function visit(node) {
            const attributes = node.attributes || [];
            for (let index = 0; index < attributes.length; index += 2) {
                if (attributes[index] === 'id' && attributes[index + 1] === 'fluent-read-image-translation-root') host = node;
            }
            for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) visit(child);
        }
        visit(tree.root);
        const shadow = host?.shadowRoots?.[0];
        if (!shadow) return null;
        return (await cdp.send('DOM.resolveNode', {nodeId: shadow.nodeId})).object.objectId;
    }
    async function ui(code) {
        const objectId = await rootObject();
        if (!objectId) return null;
        try {
            const response = await cdp.send('Runtime.callFunctionOn', {
                objectId, functionDeclaration: `function(){${code}}`, returnByValue: true,
            });
            if (response.exceptionDetails) {
                throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
            }
            return response.result.value;
        } finally {
            await cdp.send('Runtime.releaseObject', {objectId}).catch(error => {
                report.cleanupErrors.push(`CDP object release: ${error.message}`);
            });
        }
    }
    readUi = ui;
    async function wait(test, timeout = 30_000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            if (await test()) return;
            await page.waitForTimeout(100);
        }
        const state = await ui('return this.textContent').catch(() => null);
        throw new Error(`${currentCase}: 图片状态等待超时 ${JSON.stringify(state)}`);
    }
    async function click(text) {
        const point = await ui(`
            const button = [...this.querySelectorAll('button')].find(item => item.textContent === ${JSON.stringify(text)} && !item.hidden);
            if (!button) return null;
            const rect = button.getBoundingClientRect();
            return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
        `);
        assert.ok(point, `未找到按钮 ${text}`);
        // 只发送 DevTools 可信输入，不操作系统鼠标或激活 macOS 应用。
        await page.mouse.click(point.x, point.y);
    }
    async function shot(name) {
        const file = path.join(artifacts, `${name}.png`);
        await page.screenshot({path: file, timeout: 10_000});
        report.screenshots.push(file);
    }
    const image = page.locator('#sample');
    if (xSurface) {
        currentCase = 'X snapshot surface and first-use automatic OCR languages';
        const {verifyXSurface} = require('./image-translation-x-surface.cjs');
        await verifyXSurface({page, context, popup, worker, ui, wait, click, shot, report,
            originalImage: arg('original-image', null)});
        assert.ok(report.ocrTargets.some(target => target.type === 'worker' && target.url.includes('/fluent-read-ocr/')),
            '必须实际监听 dedicated OCR Worker，才能断言不存在语言加载错误');
        assert.equal(report.ocrConsole.some(entry => entry.diagnosticError), false, 'OCR 控制台监听不得静默失效');
        assert.equal(report.ocrConsole.some(entry => /Error opening data file|Failed loading language|Tesseract couldn't load/.test(entry.text || '')),
            false, '显式下载的语言包不应触发子语言文件加载错误');
        if (multilingual) {
            const requests = report.requests.join('\n');
            assert.match(requests, /简体中文/u, '真实 OCR 请求缺少简体中文');
            assert.match(requests, /繁體中文/u, '真实 OCR 请求缺少繁體中文');
            assert.match(requests, /English|OCR|language/u, '真实 OCR 请求缺少英文');
            report.cases.push('multilingual OCR requests include simplified Chinese, traditional Chinese, and English');
        }
        assert.equal(report.errors.length, 0);
        report.success = true;
        return;
    }
    currentCase = 'first-use language preparation';
    await image.hover();
    await wait(() => ui("return !!this.querySelector('.fr-image-controls')"));
    await ui(`
        this.__progress = [];
        const root = this;
        this.__progressObserver = new MutationObserver(() => {
            const text = root.querySelector('.fr-image-status')?.textContent;
            if (text && !root.__progress.includes(text)) root.__progress.push(text);
        });
        this.__progressObserver.observe(this, {subtree:true, childList:true, characterData:true});
        return true;
    `);
    await click('翻译');
    await wait(() => ui("return this.querySelector('.fr-image-controls')?.dataset.phase==='error'"));
    await shot('01-language-preparation');
    report.cases.push('missing languages exposes preparation action');
    await click('下载语言包并翻译');
    const began = Date.now();
    await wait(() => ui("return this.querySelector('.fr-image-controls')?.dataset.phase==='translated'"), 300000);
    report.coldPreparationAndTranslationMs = Date.now() - began;
    report.progress = await ui('return this.__progress');
    assert.ok(report.progress.some(t => t.includes('识别图片文字')));
    assert.ok(report.progress.some(t => t.includes('翻译文字')));
    assert.ok(report.progress.some(t => t.includes('生成译图')));
    await shot('02-translated');
    await click('文字');
    const fullText = await ui("return this.querySelector('.fr-image-details').textContent");
    assert.match(fullText, /欢迎|单击|语言/);
    report.translatedText = fullText;
    report.cases.push('real language download, OCR, translation and replacement');
    await shot('03-complete-text');
    await click('文字');
    currentCase = 'restore and cached redisplay';
    const before = await image.getAttribute('src');
    const requests = await worker.evaluate(() => globalThis.__imageFixture.requests.length);
    report.requests = await worker.evaluate(() => globalThis.__imageFixture.requests);
    await click('原图');
    await wait(() => ui("return this.querySelector('.fr-image-controls')?.dataset.phase==='idle'"));
    const started = Date.now();
    await click('翻译');
    await wait(() => ui("return this.querySelector('.fr-image-controls')?.dataset.phase==='translated'"));
    report.cachedRedisplayMs = Date.now() - started;
    assert.equal(await worker.evaluate(() => globalThis.__imageFixture.requests.length), requests);
    assert.equal(await image.getAttribute('src'), before);
    report.cases.push('restore and redisplay reuse result without requests or source mutation');
    await ui("this.querySelector('.fluent-read-image-translation-overlay img').dataset.probeIdentity='retained'; return true;");
    await page.evaluate(() => window.scrollTo(0, 90));
    await page.waitForTimeout(150);
    assert.equal(await ui("return this.querySelector('.fluent-read-image-translation-overlay img')?.dataset.probeIdentity"), 'retained');
    report.cases.push('scroll retains same decoded bitmap');
    await verifyGeometryCases({worker, ui, wait, shot});
    currentCase = 'dynamic source, cancellation and retry';
    await page.evaluate(() => { const i = document.querySelector('#sample'); i.src = i.src + '#changed'; });
    await wait(() => ui("return this.querySelector('.fr-image-controls')?.dataset.phase==='idle'"));
    assert.equal(await ui("return !!this.querySelector('.fluent-read-image-translation-overlay img')"), false);
    report.cases.push('dynamic source change removes old translation');
    await image.hover();
    await click('翻译');
    await click('取消');
    await page.waitForTimeout(1200);
    assert.equal(await ui("return this.querySelector('.fr-image-controls')?.dataset.phase"), 'idle');
    report.cases.push('cancel never installs a late result');
    await image.hover();
    await click('翻译');
    await wait(() => ui("return this.querySelector('.fr-image-controls')?.dataset.phase==='translated'"));
    report.cases.push('retry works after cancellation');
    await shot('04-retry');

    currentCase = 'transparent PNG replacement and opacity ownership';
    const transparentFixture = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 1000;
        canvas.height = 500;
        const context = canvas.getContext('2d');
        context.fillStyle = '#173453';
        context.font = '50px Arial';
        context.fillText('Transparent picture test', 50, 145);
        context.fillText('Original words stay hidden', 50, 295);
        const alpha = context.getImageData(0, 0, 1, 1).data[3];
        document.body.style.backgroundColor = '#dbeafe';
        document.querySelector('.card').style.backgroundColor = '#dbeafe';
        const image = document.querySelector('#sample');
        image.src = canvas.toDataURL('image/png');
        return {alpha, width: canvas.width, height: canvas.height};
    });
    assert.equal(transparentFixture.alpha, 0, '透明夹具必须实际包含透明像素');
    await wait(() => ui("return this.querySelector('.fr-image-controls')?.dataset.phase==='idle'"));
    const originalOpacity = await image.evaluate(image => ({
        computed: getComputedStyle(image).opacity,
        value: image.style.getPropertyValue('opacity'),
        priority: image.style.getPropertyPriority('opacity'),
    }));
    await image.hover();
    await click('翻译');
    await wait(() => ui("return this.querySelector('.fr-image-controls')?.dataset.phase==='translated'"));
    const transparentState = await ui(`
        const source = document.querySelector('#sample');
        const bitmap = this.querySelector('.fluent-read-image-translation-overlay img');
        return {
            sourceOpacity: Number(getComputedStyle(source).opacity),
            bitmapOpacity: Number(getComputedStyle(bitmap).opacity),
            bitmapWidth: bitmap.naturalWidth,
            bitmapHeight: bitmap.naturalHeight,
        };
    `);
    assert.equal(transparentState.sourceOpacity, 0);
    assert.equal(transparentState.bitmapOpacity, 1);
    assert.equal(transparentState.bitmapWidth, transparentFixture.width);
    assert.equal(transparentState.bitmapHeight, transparentFixture.height);
    report.transparentReplacement = {fixture: transparentFixture, translated: transparentState};
    report.cases.push('transparent PNG hides original letters while translated bitmap remains visible');
    await shot('05-transparent-translation');
    await click('原图');
    await wait(() => ui("return this.querySelector('.fr-image-controls')?.dataset.phase==='idle'"));
    assert.deepEqual(await image.evaluate(image => ({
        computed: getComputedStyle(image).opacity,
        value: image.style.getPropertyValue('opacity'),
        priority: image.style.getPropertyPriority('opacity'),
    })), originalOpacity);
    report.cases.push('restoring transparent source releases only the extension opacity lease');
    await shot('06-transparent-original');
    await click('翻译');
    await wait(() => ui("return this.querySelector('.fr-image-controls')?.dataset.phase==='translated'"));
    await image.evaluate(image => image.style.setProperty('opacity', '0.6'));
    await wait(async () => {
        const sourceOpacity = await image.evaluate(image => Number(getComputedStyle(image).opacity));
        const hasBitmap = await ui("return !!this.querySelector('.fluent-read-image-translation-overlay img')");
        return sourceOpacity === 0.6 && !hasBitmap;
    });
    assert.equal(await image.evaluate(image => image.style.getPropertyValue('opacity')), '0.6');
    report.cases.push('host opacity change removes old replacement and preserves the host value');
    await shot('07-transparent-host-opacity');
    await ui('this.__progressObserver?.disconnect(); return true;');
    currentCase = 'image removal';
    await page.evaluate(() => document.querySelector('#sample').remove());
    await wait(() => ui("return this.querySelectorAll('.fluent-read-image-translation-overlay').length===0"));
    report.cases.push('image removal cleans overlay');
    assert.equal(report.errors.length, 0);
    report.success = true;
})().catch(async error => {
    report.success = false;
    report.failure = {case: currentCase, message: error.message, stack: error.stack};
    process.exitCode = 1;
    if (page && !page.isClosed()) {
        const file = path.join(artifacts, 'failure.png');
        await page.screenshot({path: file, timeout: 10_000})
            .then(() => report.screenshots.push(file))
            .catch(failure => report.cleanupErrors.push(`failure screenshot: ${failure.message}`));
        if (readUi) report.failure.ui = await readUi('return this.textContent').catch(() => null);
    }
}).finally(async () => {
    if (diagnosticCdp) await diagnosticCdp.detach().catch(error=>report.cleanupErrors.push(`OCR console detach: ${error.message}`));
    if (cdp) {
        if (readUi) await readUi('this.__progressObserver?.disconnect(); return true;').catch(() => undefined);
        await cdp.detach().catch(error => report.cleanupErrors.push(`CDP session detach: ${error.message}`));
    }
    // 启动抛错时无法在这里证明浏览器已退出，保留本次临时配置以供诊断。
    let browserClosed = !launchAttempted;
    if (launched) {
        try {
            // helper.close 还负责关闭其 CDP 后台进程；仅 context.close 不足以证明进程已退出。
            await launched.close();
            browserClosed = true;
        } catch (error) {
            report.cleanupErrors.push(`isolated browser close: ${error.message}`);
        }
    }
    await new Promise(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
    });
    if (browserClosed) {
        try {
            const current = fs.lstatSync(profileDir);
            assert.ok(!current.isSymbolicLink() && current.isDirectory());
            assert.equal(path.dirname(profileDir), temporaryRoot);
            assert.equal(current.dev, profileIdentity.dev);
            assert.equal(current.ino, profileIdentity.ino);
            assert.equal(fs.readFileSync(profileMarker, 'utf8'), profileToken);
            fs.rmSync(profileDir, {recursive: true});
            report.profileRemoved = true;
        } catch (error) {
            report.cleanupErrors.push(`temporary profile retained: ${error.message}`);
            report.retainedProfile = profileDir;
        }
    } else report.retainedProfile = profileDir;
    if (report.cleanupErrors.length > 0) {
        report.success = false;
        process.exitCode = 1;
    }
    fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
}).catch(error => {
    console.error('图片翻译回归清理或报告写入失败', error);
    process.exitCode = 1;
});
