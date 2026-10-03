/** 漫画入口专项：真实隔离浏览器、关闭普通图片/悬浮球的基线与新入口、可信手势和持久化验证。 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const arg = (name, fallback) => {const i = process.argv.indexOf(`--${name}`);return i < 0 ? fallback : process.argv[i + 1];};
const baseline = process.argv.includes('--baseline');
const artifacts = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-manga-entry'));
const extension = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const {chromium} = require(path.join(arg('playwright-root'), 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(arg('focus-safe-helper'));
const profile = fs.mkdtempSync('/private/tmp/fluentread-manga-entry-');
fs.mkdirSync(artifacts, {recursive: true});
const report = {suite: baseline ? 'baseline live discovery' : 'manga entry UI', cases: [], screenshots: [], consoleErrors: [], errors: []};
let launched, popup, page, worker, cdp, browserPid;
function focusGuard() {
    const app = JSON.parse(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', "ObjC.import('AppKit');const a=$.NSWorkspace.sharedWorkspace.frontmostApplication;JSON.stringify({pid:Number(a.processIdentifier),name:ObjC.unwrap(a.localizedName)});"], {encoding: 'utf8'}));
    assert.notEqual(app.pid, browserPid);(report.focusChecks ??= []).push(app);
}
async function shadow(hostId, code) {
    const tree = await cdp.send('DOM.getDocument', {depth: -1, pierce: true});let host;
    function visit(node) {const attrs = node.attributes || [];for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'id' && attrs[i + 1] === hostId) host = node;for (const n of [...(node.children || []), ...(node.shadowRoots || [])]) visit(n);}
    visit(tree.root);if (!host?.shadowRoots?.[0]) return null;
    let object;
    try {({object} = await cdp.send('DOM.resolveNode', {nodeId: host.shadowRoots[0].nodeId}));}
    catch (error) {if (error.message.includes('No node with given id')) return null;throw error;}
    try {const result = await cdp.send('Runtime.callFunctionOn', {objectId: object.objectId, functionDeclaration: `function(){${code}}`, returnByValue: true});if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);return result.result.value;}
    finally {await cdp.send('Runtime.releaseObject', {objectId: object.objectId});}
}
const ball = code => shadow('fluent-read-floating-ball-container', code);
const entry = code => shadow('fluent-read-manga-entry-container', code);
async function wait(test, timeout = 20000) {const until = Date.now() + timeout;while (Date.now() < until) {if (await test()) return;await page.waitForTimeout(100);}throw new Error(`Timeout: ${report.currentCase}`);}
async function patch(config) {await popup.evaluate(async config => {
    const {value: current} = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
    const response = await chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config, expected: Object.fromEntries(Object.keys(config).map(key => [key, current[key]])), clientId: 'manga-entry-test', sequence: Date.now(), baseRevision: current.__fluentConfigRevision || 0});
    if (!response.success) throw new Error(response.error);
}, config);}
async function shot(name) {focusGuard();const file = path.join(artifacts, `${name}.png`);await page.screenshot({path: file});report.screenshots.push(file);}
async function clickEntry(selector) {const point = await entry(`const b=this.querySelector(${JSON.stringify(selector)});if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}`);assert.ok(point);await page.mouse.click(point.x, point.y);}
(async () => {
    launched = await launchFocusSafePersistentContext({chromium, profileDir: profile, browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', headless: false, background: true,
        browserArgs: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run', '--no-default-browser-check'], viewport: {width: 1280, height: 900}, timeout: 30000});
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    assert.equal(report.windowPlacement.browserFrontmost, false);
    const context = launched.context, system = await context.browser().newBrowserCDPSession();
    browserPid = (await system.send('SystemInfo.getProcessInfo')).processInfo.find(p => p.type === 'browser').id;await system.detach();focusGuard();
    worker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://')) || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    popup = context.pages()[0];popup.on('pageerror',e=>report.errors.push(e.message));popup.on('console',m=>{if(m.type()==='error')report.consoleErrors.push(m.text());});await popup.goto(`chrome-extension://${id}/popup.html`);
    await patch({on: true, uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, disableImageTranslator: true, disableFloatingBall: false,
        imageTranslationMangaEnabled: true, imageTranslationMangaPromptEnabled: true, imageTranslationMangaDownloadConfirmed: false, animations: false, service: 'google', from: 'en', to: 'zh-Hans'});
    page = await newPageWithoutForeground(context);page.on('pageerror', e => report.errors.push(e.message));page.on('console', m => {if(m.type()==='error' && m.location().url.startsWith('chrome-extension://'))report.consoleErrors.push(m.text());});
    cdp = await context.newCDPSession(page);
    await page.goto('https://mangaplus.shueisha.co.jp/viewer/1024050', {waitUntil: 'domcontentloaded', timeout: 60000});
    await page.waitForSelector('.zao-image-container img.zao-image', {timeout: 45000});
    report.readerImages = await page.locator('.zao-image-container img.zao-image').count();
    if (baseline) {
        report.currentCase = 'ordinary images disabled hides the manga entry';
        await page.waitForTimeout(1500);assert.equal(await ball("return !!this.querySelector('.floating-ball-manga')"), false);
        assert.equal(await entry('return true'), null);await shot('baseline-default-hidden');report.cases.push(report.currentCase);
        report.currentCase = 'ordinary images enabled reveals the manga button';await patch({disableImageTranslator: false});
        await wait(async () => await ball("return !!this.querySelector('.floating-ball-manga')"));await shot('baseline-image-enabled');report.cases.push(report.currentCase);
        report.currentCase = 'closing floating ball removes every manga entry';await patch({disableFloatingBall: true});
        await wait(async () => !await ball('return true'));assert.equal(await entry('return true'), null);report.cases.push(report.currentCase);
    } else {
        report.currentCase = 'manga discovered with ordinary image translation disabled';await wait(async () => await ball('return !!this.querySelector(".floating-ball-manga")'));
        assert.equal(await entry('return !!this.querySelector(".fr-manga-entry")'),false);
        assert.equal(await ball('return this.querySelector(".manga-icon")?.tagName.toLowerCase()'), 'svg');
        assert.equal(await ball('return this.querySelector(".manga-icon")?.textContent.trim()'), '');
        const mangaButtons = await ball('return [".floating-ball-main", ".floating-ball-manga"].map(s => {const r=this.querySelector(s).getBoundingClientRect();return {left:r.left,right:r.right,width:r.width}})');
        assert.equal(mangaButtons[0].width, 40);assert.equal(mangaButtons[1].width, 40);
        assert.ok(mangaButtons.every(r => r.left >= 0 && r.right <= 1280), 'Both manga reader buttons remain fully visible');
        report.mangaButtons = mangaButtons;
        await shot('entry-initial');report.cases.push(report.currentCase);
        report.currentCase = 'manga entry remains after closing floating ball';await patch({disableFloatingBall: true});
        await wait(async () => !await ball('return true'));await wait(async()=>await entry('return !!this.querySelector(".fr-manga-launcher")'));
        assert.equal(await entry('return !!this.querySelector(".fr-manga-entry")'),false);report.cases.push(report.currentCase);
        report.currentCase = 'first use explains downloads before any model download';await clickEntry('.fr-manga-launcher');
        await wait(async () => await entry('return this.textContent.includes("首次使用，先准备阅读资源")'));
        assert.ok(await entry('return this.textContent.includes("30 MB") && this.textContent.includes("197 MB")'));
        report.modelStatusBeforeConsent=await popup.evaluate(()=>chrome.runtime.sendMessage({type:'fluentReadMangaModelStatus'}));
        assert.equal(report.modelStatusBeforeConsent.bytes,0);assert.equal(report.modelStatusBeforeConsent.ready,false);
        assert.ok(!report.modelStatusBeforeConsent.download);
        await shot('entry-first-use');report.cases.push(report.currentCase);
        report.currentCase = 'dismiss first-use confirmation never opens it again automatically';await clickEntry('.fr-manga-close');
        assert.equal(await entry('return !!this.querySelector(".fr-manga-entry")'), false);await page.reload({waitUntil: 'domcontentloaded'});
        await wait(async () => await entry('return !!this.querySelector(".fr-manga-launcher")'));
        assert.equal(await entry('return !!this.querySelector(".fr-manga-entry")'),false);report.cases.push(report.currentCase);
        report.currentCase = 'disable standalone button persists across visit and ordinary config changes';await patch({imageTranslationMangaPromptEnabled:false});
        await wait(async () => await entry('return !this.querySelector(".fr-manga-launcher")'));await page.reload({waitUntil: 'domcontentloaded'});
        await page.waitForTimeout(1200);assert.equal(await entry('return !!this.querySelector(".fr-manga-launcher")'), false);
        await patch({from: 'auto'});await page.waitForTimeout(300);assert.equal(await entry('return !!this.querySelector(".fr-manga-launcher")'), false);report.cases.push(report.currentCase);
        report.currentCase = 'settings restore prompt through the actual switch';
        await popup.goto(`chrome-extension://${id}/options.html#settings-image-translation`);
        const switchPrompt=popup.getByRole('switch',{name:'独立漫画按钮',exact:true});await switchPrompt.waitFor({state:'attached'});
        await popup.locator('.el-switch').filter({has:switchPrompt}).waitFor();
        assert.equal(await switchPrompt.getAttribute('aria-checked'),'false');
        await popup.locator('.el-switch').filter({has:switchPrompt}).click();
        await wait(async () => await entry('return !!this.querySelector(".fr-manga-launcher")'));assert.equal(await entry('return !!this.querySelector(".fr-manga-entry")'),false);report.cases.push(report.currentCase);
        report.currentCase = 'unified settings show main switches without tabs and expand resources on demand';
        assert.ok(await popup.getByRole('heading',{name:'图片/漫画翻译',exact:true}).count());
        assert.ok(await popup.locator('[data-testid=manga-settings]').isVisible());
        assert.equal(await popup.locator('#settings-image-translation .settings-page-panel').count(),0);
        assert.equal(await popup.locator('[role=tab]').count(),0);
        assert.equal(await popup.locator('.manga-model-settings').count(),0);
        assert.equal(await popup.locator('.image-ocr-settings:visible').count(),0);
        const settingsShot=path.join(artifacts,'settings-manga.png');focusGuard();await popup.screenshot({path:settingsShot});report.screenshots.push(settingsShot);report.cases.push(report.currentCase);
        report.currentCase='custom site rule validates selector and persists on reopen';
        await popup.locator('.manga-sites > summary').click();await popup.getByText('添加其他漫画网站',{exact:true}).click();
        await popup.getByLabel('阅读页或阅读路径',{exact:true}).fill('https://comic.example.test/reader/');
        await popup.getByLabel('漫画图片选择器',{exact:true}).fill('[');await popup.getByRole('button',{name:'添加网站',exact:true}).click();
        await popup.getByRole('alert').filter({hasText:'图片选择器无效'}).waitFor();
        await popup.getByLabel('漫画图片选择器',{exact:true}).fill('main img');await popup.getByRole('button',{name:'添加网站',exact:true}).click();
        await popup.locator('.manga-custom-site').filter({hasText:'comic.example.test'}).waitFor();await popup.reload();
        await popup.locator('.manga-sites > summary').click();await popup.getByText('添加其他漫画网站',{exact:true}).click();assert.equal(await popup.locator('.manga-custom-site').count(),1);report.cases.push(report.currentCase);
        report.currentCase='custom reader is discovered with both ordinary image and floating button off';
        await context.route('https://comic.example.test/reader/1',route=>route.fulfill({contentType:'text/html',body:'<html><body><main><img width="400" height="800"></main></body></html>'}));
        await page.goto('https://comic.example.test/reader/1');await wait(async()=>await entry('return !!this.querySelector(".fr-manga-launcher")'));assert.equal(await entry('return !!this.querySelector(".fr-manga-entry")'),false);
        await shot('custom-reader-entry');report.cases.push(report.currentCase);
        report.currentCase='first download prompt fits narrow viewport and dark theme';
        await page.setViewportSize({width:320,height:550});await page.emulateMedia({colorScheme:'dark'});await clickEntry('.fr-manga-launcher');
        await wait(async()=>await entry('return this.textContent.includes("首次使用，先准备阅读资源")'));
        const bounds=await entry('const r=this.querySelector(".fr-manga-entry").getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}');
        assert.ok(bounds.left>=0 && bounds.right<=320 && bounds.top>=0 && bounds.bottom<=550);await shot('entry-first-use-dark-narrow');report.cases.push(report.currentCase);
        await popup.goto(`chrome-extension://${id}/popup.html`);
        report.currentCase='icon and first-use actions work in English and all UI locales';
        await patch({uiLanguage:'en-US',disableFloatingBall:false});
        await wait(async()=>await entry('return this.querySelector(".fr-manga-primary")?.textContent.trim() === "Prepare resources and start"'));
        await wait(async()=>await ball('return this.querySelector(".floating-ball-manga")?.getAttribute("aria-label") === "Manga translation"'));
        assert.equal(await ball('return this.querySelector(".manga-icon")?.textContent.trim()'), '');
        const unobstructed=await entry('const r=this.querySelector(".fr-manga-entry").getBoundingClientRect();return document.elementFromPoint(r.right-22,r.top+r.height/2)?.id === "fluent-read-manga-entry-container"');
        assert.equal(unobstructed,true);
        await shot('entry-first-use-english');
        for(const [locale,title] of [['ja-JP','リソースを準備して開始'],['ko-KR','리소스 준비 후 시작'],['fr-FR','Préparer et commencer'],['ru-RU','Подготовить и начать'],['es-ES','Preparar y comenzar']]){
            await patch({uiLanguage:locale});
            await wait(async()=>await entry(`return this.querySelector(".fr-manga-primary")?.textContent.trim() === ${JSON.stringify(title)}`));
        }
        report.cases.push(report.currentCase);
        report.currentCase = 'ordinary pages retain edge docking and reveal on hover';
        await page.setViewportSize({width:1280,height:900});
        await context.route('https://ordinary.example.test/article', route => route.fulfill({contentType:'text/html',body:'<html><body><p>Ordinary reading page</p></body></html>'}));
        await page.mouse.move(30,30);await page.goto('https://ordinary.example.test/article');
        await wait(async () => await ball('return !!this.querySelector(".floating-ball-main")'));
        assert.equal(await ball('return this.querySelector(".floating-ball-manga") !== null'), false);
        const docked = await ball('const r=this.querySelector(".floating-ball-main").getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}');
        assert.ok(docked.right>1280 && docked.left<1280, 'Ordinary brand button rests partially beyond the edge');
        await page.mouse.move(1278,(docked.top+docked.bottom)/2);
        await wait(async () => await ball('return this.querySelector(".floating-ball-main").getBoundingClientRect().right <= 1280'));
        report.ordinaryDocking=docked;report.cases.push(report.currentCase);
        report.currentCase = 'confirm closes immediately and continuous mode can pause without a dialog';
        await patch({uiLanguage:'zh-CN'});await page.goto('https://comic.example.test/reader/1');
        await wait(async () => await ball('return !!this.querySelector(".floating-ball-manga")'));
        const clickBall=async()=>{const p=await ball('const r=this.querySelector(".floating-ball-manga").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}');await page.mouse.click(p.x,p.y);};
        await clickBall();await wait(async()=>await entry('return !!this.querySelector(".fr-manga-primary")'));
        await clickEntry('.fr-manga-primary');
        await wait(async()=>await ball('return this.querySelector(".floating-ball-manga")?.getAttribute("aria-pressed") === "true"'));
        assert.equal(await entry('return !!this.querySelector(".fr-manga-entry")'),false);
        const acknowledged=await popup.evaluate(async()=>{const c=await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'});return c.value.imageTranslationMangaDownloadConfirmed;});
        assert.equal(acknowledged,true);await clickBall();
        await wait(async()=>await ball('return this.querySelector(".floating-ball-manga")?.getAttribute("aria-pressed") === "false"'));
        assert.equal(await entry('return !!this.querySelector(".fr-manga-entry")'),false);report.cases.push(report.currentCase);
        report.currentCase = 'master switch removes manga UI';
        await patch({on: false});await wait(async () => !await entry('return true'));assert.equal(await ball('return true'),null);report.cases.push(report.currentCase);
    }
    assert.deepEqual(report.errors,[]);assert.deepEqual(report.consoleErrors,[]);report.status = 'passed';
})().catch(async e => {report.status = 'failed';report.failure = e.stack;process.exitCode = 1;if(popup){report.popupText=await popup.locator('body').innerText().catch(()=>null);await popup.screenshot({path:path.join(artifacts,'failed-popup.png')}).catch(()=>{});}if(page)await page.screenshot({path:path.join(artifacts,'failed-reader.png')}).catch(()=>{});}).finally(async () => {
    if (launched) await launched.close().catch(() => {});
    fs.rmSync(profile, {recursive: true, force: true});report.profileRemoved = !fs.existsSync(profile);
    fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
});
