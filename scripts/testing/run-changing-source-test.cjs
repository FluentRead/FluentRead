#!/usr/bin/env node
'use strict';
const {guardBrowserClose, getGuardedBrowserPid} = require('./owned-browser-close.cjs');

// 生产扩展、可信按键、本地确定性翻译；每批复用隔离 Edge，始终保持后台且不抢焦点。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const {startTranslationFixtureServer, installTranslationFixtureOnWorker} = require('../run-full-page-translation-test.cjs');
const argument = (name, fallback) => {const index = process.argv.indexOf(`--${name}`); return index < 0 ? fallback : process.argv[index + 1];};
const extensionDir = path.resolve(argument('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(argument('artifacts-dir', '/private/tmp/fluentread-changing-source'));
const {chromium} = require(path.join(argument('playwright-root'), 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground, startFocusEventMonitor, queryMacFrontmostApplication} = require(argument('focus-safe-helper', path.join(__dirname, 'focus-safe-browser.cjs')));
const displayCases = [
    {id:'clock', initial:'12:34 PM', latest:'12:35 PM'},
    {id:'clock-prefix', initial:'AM 08:17', latest:'AM 08:18'},
    {id:'clock-dotted', initial:'8:19 a.m.', latest:'8:20 p.m.'},
    {id:'clock-24h', initial:'23:57', latest:'23:58'},
    {id:'clock-seconds', initial:'14:35:26', latest:'14:35:27'},
    {id:'clock-fraction', initial:'01:02:03.456', latest:'01:02:03.457'},
    {id:'clock-fullwidth', initial:'１２：４１ ＰＭ', latest:'１２：４２ ＰＭ'},
    {id:'clock-offset', initial:'14:43 +08:00', latest:'14:44 +08:00'},
    {id:'clock-utc', initial:'14:45 UTC', latest:'14:46 UTC'},
    {id:'clock-gmt-offset', initial:'14:47 GMT+0800', latest:'14:48 GMT+0800'},
    {id:'clock-us-zone', initial:'8:49 AM PST', latest:'8:50 AM PST'},
    {id:'date-iso', initial:'2026-10-10', latest:'2026-10-11'},
    {id:'date-slash', initial:'2026/10/12', latest:'2026/10/13'},
    {id:'datetime-z', initial:'2026-10-10T14:51:26.789Z', latest:'2026-10-10T14:51:27.789Z'},
    {id:'datetime-offset', initial:'2026-10-10 14:52:26 +08:00', latest:'2026-10-10 14:52:27 +08:00'},
    {id:'date-localized', initial:'2026年10月14日', latest:'2026年10月15日'},
    {id:'datetime-traditional', initial:'2026年10月10日 14時53分26秒', latest:'2026年10月10日 14時53分27秒'},
    {id:'social-clock-date', initial:'14:54 · 2026年10月10日', latest:'14:55 · 2026年10月10日'},
    {id:'social-date-clock', initial:'2026年10月10日 · 14:56', latest:'2026年10月10日 · 14:57'},
    {id:'duration', initial:'5 minutes', latest:'4 minutes'},
    {id:'duration-seconds', initial:'27 seconds', latest:'26 seconds'},
    {id:'duration-milliseconds', initial:'0.25 ms', latest:'0.24 ms'},
    {id:'duration-dotted-sec', initial:'28 sec.', latest:'29 sec.'},
    {id:'duration-dotted-min', initial:'6 min.', latest:'7 min.'},
    {id:'duration-dotted-hour', initial:'3 hr.', latest:'4 hr.'},
    {id:'duration-compact', initial:'1h 15m 31s', latest:'1h 15m 32s'},
    {id:'duration-mixed', initial:'2 hours, 16 minutes', latest:'2 hours, 17 minutes'},
    {id:'duration-future', initial:'in 18 minutes', latest:'in 17 minutes'},
    {id:'duration-ago', initial:'19 minutes ago', latest:'20 minutes ago'},
    {id:'duration-traditional-minute', initial:'21分鐘', latest:'22分鐘'},
    {id:'duration-traditional-second', initial:'32秒鐘', latest:'33秒鐘'},
    {id:'duration-traditional-hour', initial:'5小時', latest:'6小時'},
    {id:'duration-traditional-future', initial:'23分鐘後', latest:'22分鐘後'},
    {id:'duration-chinese-past', initial:'34秒前', latest:'35秒前'},
    {id:'number', initial:'1,234.56', latest:'1,234.57'},
    {id:'number-percent', initial:'98.5%', latest:'98.6%'},
    {id:'number-currency', initial:'$12.75', latest:'$12.76'},
    {id:'split-timer', initial:'5 minutes 12 seconds', latest:'4 minutes 13 seconds', attributes:' role="timer"',
        html:'<span data-part="minutes">5</span> minutes <span data-part="seconds">12</span> seconds', edits:{minutes:'4',seconds:'13'}},
    {id:'split-duration', initial:'24 minutes 36 seconds', latest:'25 minutes 37 seconds',
        html:'<span data-part="minutes">24</span><b> minutes </b><i data-part="seconds">36 seconds</i>', edits:{minutes:'25',seconds:'37 seconds'}},
    {id:'split-clock', initial:'14:58:38', latest:'14:59:39',
        html:'<span>14</span>:<i data-part="minutes">58</i>:<b data-part="seconds">38</b>', edits:{minutes:'59',seconds:'39'}},
    {id:'split-date', initial:'2026-10-16 15:01 UTC', latest:'2026-10-17 15:02 UTC',
        html:'<span data-part="date">2026-10-16</span><i data-part="clock"> 15:01 UTC</i>', edits:{date:'2026-10-17',clock:' 15:02 UTC'}},
    {id:'time-element', initial:'26 minutes ago', latest:'27 minutes ago',
        html:'<time datetime="2026-10-10T15:03:00Z" data-part="time">26 minutes ago</time>', edits:{time:'27 minutes ago'}},
];
const escapeHtml = value => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const shell = body => `<!doctype html><html lang="en"><meta charset="utf-8"><title>Changing source fixture</title>
<style>body{font:18px/1.5 system-ui;margin:24px}main{max-width:1150px}p{margin:10px 0}.display-matrix{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:3px 12px}.display-matrix p{font-size:13px;margin:2px 0;overflow-wrap:anywhere}#probe{position:fixed;right:20px;top:12px}</style>
<button id="probe" translate="no">Host click</button><main>${body}</main>
<script>window.probeClicks=0;document.querySelector('#probe').onclick=()=>window.probeClicks++;</script></html>`;
const html = shell(`<section class="display-matrix">${displayCases.map(item => `<p id="${item.id}"${item.attributes || ''}>${item.html || escapeHtml(item.initial)}</p>`).join('')}</section>
<p id="normal">The task takes 8 minutes and processes 123 records.</p>
<p id="neighbor">Readers can continue reading this stable neighboring paragraph.</p>
<p id="counter">Visitors: 100</p><p id="changing">Processing the first section.</p><p id="changing-words">Preparing the chapter for reading.</p>
<p id="counter-owner">Readers: 300</p><p id="changing-owner">Preparing the table of contents.</p>
<p id="inline">This stable paragraph includes <span id="inline-number">99</span> records and a timer <time>2 minutes ago</time>.</p>`);
const cancelHtml = shell('<p id="cancel-counter">Visitors: 200</p><p id="cancel-changing">Preparing the glossary.</p><p id="cancel-neighbor">This neighboring article stays stable during cancellation.</p>');
const staleSource = 'An outdated paragraph started its translation request.';
const staleLatest = 'The host replaced it with a freshly published paragraph.';
const inflightSource = 'A second request will be cancelled before its response.';
const inflightLatest = 'The current host text must survive cancellation unchanged.';
const slowHtml = shell('<p id="slow-changing">The chapter is preparing its first draft.</p><p id="slow-neighbor">This nearby paragraph remains stable while status changes slowly.</p>');
const staleHtml = shell(`<p id="stale">${staleSource}</p><p id="stale-neighbor">This paragraph keeps the translation session active.</p>`);
const server = http.createServer((request, response) => {
    response.writeHead(200, {'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
    response.end(request.url?.includes('/stale') ? staleHtml : request.url?.includes('/cancel') ? cancelHtml : request.url?.includes('/slow') ? slowHtml : html);
});
const report = {ok:false, extensionDir, evidenceBoundary:'Production extension, isolated real Edge, deterministic local Microsoft transport; no live-provider or Firefox runtime claims.',
    coverage:{displayValues:displayCases.length, modes:['bilingual','single'], changingSourceMinimumQuietWindowMs:1800,changingSourceMaximumQuietWindowMs:10000}, cases:[], errors:[]};
fs.mkdirSync(artifactsDir, {recursive:true});
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-changing-source-'));
const normalize = value => String(value).normalize('NFKC').replace(/[\s\u3000]+/gu,' ').trim();
const artifacts = '.fluent-read-bilingual-content,.fluent-read-single-slot';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds));

(async () => {
    let launched, provider, focusMonitor, browserPid, focusFailure, fixturePage;
    let primaryError;
    let launchAttempted = false;
    try {
        await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
        provider = await startTranslationFixtureServer([],250);
        const stopForFocus = error => {
            focusFailure ||= error;
            if (launched) void launched.close().catch(closeError => report.errors.push(String(closeError)));
        };
        focusMonitor = startFocusEventMonitor({
            onEvent: event => {if (event.pid === browserPid) stopForFocus(new Error('Isolated test browser became foreground; stopping the test.'));},
            onError: stopForFocus,
        });
        await focusMonitor.ready;
        launchAttempted = true;
        launched = await launchFocusSafePersistentContext({chromium,profileDir,background:true,headless:false,
            browserPath:'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',viewport:{width:1280,height:900},
            browserArgs:[`--disable-extensions-except=${extensionDir}`,`--load-extension=${extensionDir}`,'--no-first-run','--no-default-browser-check']});
        guardBrowserClose(launched,profileDir);
        browserPid = await getGuardedBrowserPid(launched);
        const assertSafeFocus = async () => {
            if (focusFailure) throw focusFailure;
            if (focusMonitor.error) throw focusMonitor.error;
            assert.ok(!focusMonitor.events.some(event => event.pid === browserPid),'Test browser must never be activated');
            const frontmost = await queryMacFrontmostApplication();
            assert.ok(frontmost,'Foreground application must be observable');
            assert.notEqual(frontmost.pid,browserPid,'Test browser must stay in the background');
        };
        await assertSafeFocus();
        Object.assign(report,{launchMode:launched.launchMode,focusPolicy:launched.focusPolicy,windowPlacement:launched.windowPlacement});
        assert.equal(launched.launchMode,'macos-background-cdp');
        assert.equal(launched.focusPolicy,'launchservices-no-foreground');
        assert.equal(launched.windowPlacement.mode,'background-visible-no-focus');
        assert.equal(launched.windowPlacement.browserFrontmost,false);
        const {context} = launched;
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker',{timeout:30000});
        const install = item => installTranslationFixtureOnWorker(item,{translationUrl:provider.translationUrl,blockedUrl:provider.blockedUrl});
        await install(worker);
        context.on('serviceworker',item => {void install(item).catch(error => report.errors.push(String(error)));});
        const origin = `chrome-extension://${new URL(worker.url()).host}`;
        const setup = await newPageWithoutForeground(context);
        await setup.goto(`${origin}/icon/128.png`);
        let sequence = 0;
        const configure = patch => setup.evaluate(async ({patch,sequence}) => {
            const current = await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'});
            const saved = await chrome.runtime.sendMessage({type:'persistConfig',mode:'patch',config:patch,
                expected:Object.fromEntries(Object.keys(patch).map(key => [key,current.value[key]])),
                clientId:'changing-source-fixture',sequence,baseRevision:current.value.__fluentConfigRevision || 0});
            if (!saved?.success) throw new Error(saved?.error || 'Fixture config failed');
        },{patch,sequence:++sequence});
        await configure({on:true,service:'microsoft',hoverTranslationService:'microsoft',to:'zh-Hans',from:'en',display:1,
            fullPageTranslationMode:'all',translationScope:'all',useCache:false,enableAIContext:false,enableAIMultiSegment:false,
            glossaryEnabled:false,autoTranslate:false,hotkey:'Control',floatingBallHotkey:'Alt+T',
            uiLanguage:'zh-CN',uiLanguageSetupCompleted:true,translationRequestsPerSecond:0,translationRequestsPerMinute:0});
        const openPage = async route => {
            await assertSafeFocus();
            // 导航复用同一临时页，避免关闭最后一个宿主页后重建窗口影响桌面焦点。
            if (!fixturePage) {
                fixturePage = await newPageWithoutForeground(context);
                fixturePage.on('pageerror',error => report.errors.push(error.message));
            }
            const page = fixturePage;
            await page.goto(`http://127.0.0.1:${server.address().port}/${route}`);
            await page.locator('#fluent-read-page-styles').waitFor({state:'attached'});
            await activateExtensionTabWithoutForeground(context,page);
            await page.waitForTimeout(500);
            await assertSafeFocus();
            return page;
        };
        const waitForPayload = async (source,from) => {
            const deadline = Date.now()+15000;
            while (!provider.requestPayloads().slice(from).flat().some(value => normalize(value) === normalize(source))) {
                if (Date.now() >= deadline) throw new Error(`Provider never received source: ${source}`);
                await pause(15);
            }
        };
        const assertMatrix = async (page,mode,phase,requestStart) => {
            const samples = await page.evaluate(({cases,artifacts}) => cases.map(item => {
                const owner = document.getElementById(item.id);
                const saved = window.__displayExpected[item.id];
                const nodes = [];
                const visit = node => {nodes.push(node);node.childNodes.forEach(visit);};
                owner.childNodes.forEach(visit);
                return {id:item.id,text:owner.textContent,html:owner.innerHTML,expectedHtml:saved.html,
                    artifacts:owner.querySelectorAll(artifacts).length,
                    sameNodes:nodes.length === saved.nodes.length && nodes.every((node,index) => node === saved.nodes[index])};
            }),{cases:displayCases,artifacts});
            const payloads = provider.requestPayloads().slice(requestStart).flat().map(normalize);
            for (const sample of samples) {
                const item = displayCases.find(candidate => candidate.id === sample.id);
                assert.equal(sample.artifacts,0,`${mode} ${phase} ${item.id} must have no translation artifacts`);
                assert.equal(sample.html,sample.expectedHtml,`${mode} ${phase} ${item.id} DOM structure must stay intact`);
                assert.equal(sample.sameNodes,true,`${mode} ${phase} ${item.id} original nodes must stay intact`);
                assert.equal(sample.text,phase === 'initial' ? item.initial : item.latest,`${mode} ${phase} ${item.id} must show the host's latest value`);
                // 检查具体 provider 条目中是否含 fixture 展示值；正文刻意使用不同的 “8 minutes”，仍必须翻译。
                assert.ok(!payloads.some(value => value.includes(normalize(item.initial)) || value.includes(normalize(item.latest))),`${mode} ${item.id} display value leaked to provider`);
            }
            assert.equal(await page.locator(`.display-matrix ${artifacts.split(',').join(',.display-matrix ')}`).count(),0,`${mode} ${phase} display container must have no translation artifacts`);
            return samples;
        };
        for (const mode of ['bilingual','single']) {
            // 同一候选范围比较两个显示模式，避免把 viewport 可见性误当成文本过滤结果。
            await configure({display:mode === 'bilingual' ? 1 : 0,fullPageTranslationMode:'all'});
            const page = await openPage(mode);
            const selector = mode === 'bilingual' ? '.fluent-read-bilingual-content' : '.fluent-read-single-slot';
            const requestStart = provider.requestCount();
            await page.evaluate(cases => {
                window.__displayExpected = {};
                cases.forEach(item => {
                    const owner = document.getElementById(item.id);
                    const nodes = [];
                    const visit = node => {nodes.push(node);node.childNodes.forEach(visit);};
                    owner.childNodes.forEach(visit);
                    window.__displayExpected[item.id] = {html:owner.innerHTML,nodes};
                });
                window.__inlineOriginalNodes = Array.from(document.querySelector('#inline').childNodes);
            },displayCases);
            await page.keyboard.press('Alt+t');
            for (const id of ['normal','neighbor','counter','changing','changing-words','counter-owner','changing-owner']) await page.locator(`#${id} ${selector}`).waitFor({state:'attached'});
            await page.waitForTimeout(700);
            await assertMatrix(page,mode,'initial',requestStart);
            assert.ok(provider.requestPayloads().slice(requestStart).flat().includes('The task takes 8 minutes and processes 123 records.'),'A full sentence mentioning minutes must translate');
            assert.ok(!provider.requestPayloads().slice(requestStart).flat().some(value => normalize(value).includes('2 minutes ago')),'Inline time display must be excluded from provider payloads');
            const baselineItems = provider.translatedItemCount();
            await page.evaluate(cases => {
                cases.forEach(item => {
                    const owner = document.getElementById(item.id);
                    if (item.edits) Object.entries(item.edits).forEach(([part,value]) => {owner.querySelector(`[data-part="${part}"]`).firstChild.nodeValue=value;});
                    else owner.firstChild.nodeValue=item.latest;
                    window.__displayExpected[item.id].html=owner.innerHTML;
                });
                window.__stableArtifact=document.querySelector('#neighbor .fluent-read-bilingual-content, #neighbor .fluent-read-single-slot');
                window.__changes=[];
                const words=['Loading the glossary.','Rendering the preview.','Checking the references.','Preparing the outline.'];
                let value=101;
                window.__interval=setInterval(() => {
                    // 同一 Element 中交替 characterData 与 childList，保留候选身份。
                    const write=(id,text) => {
                        const owner=document.getElementById(id);
                        const source=owner.querySelector('.fluent-read-single-slot')?.firstChild || owner.firstChild;
                        if (value % 2) source.nodeValue=text;
                        else source.replaceWith(document.createTextNode(text));
                    };
                    write('counter',`Visitors: ${value}`);
                    write('changing',`Processing section number ${value}.`);
                    write('changing-words',words[value % words.length]);
                    const replaceOwner=(id,text) => {
                        const replacement=document.createElement('p');
                        replacement.id=id;
                        replacement.append(document.createTextNode(text));
                        document.getElementById(id).replaceWith(replacement);
                    };
                    replaceOwner('counter-owner',`Readers: ${value+200}`);
                    replaceOwner('changing-owner',words[(value+1) % words.length]);
                    document.querySelector('#inline-number').firstChild.nodeValue=String(value);
                    window.__changes.push(Object.fromEntries(['counter','changing','changing-words','counter-owner','changing-owner'].map(id => [id,document.getElementById(id).querySelectorAll('.fluent-read-bilingual-content,.fluent-read-single-slot').length])));
                    value++;
                },250);
            },displayCases);
            await page.waitForTimeout(4200);
            await page.locator('#probe').click();
            const running=await page.evaluate(() => ({
                sameNeighbor:window.__stableArtifact === document.querySelector('#neighbor .fluent-read-bilingual-content, #neighbor .fluent-read-single-slot'),
                lastSamples:window.__changes.slice(-10),clicks:window.probeClicks,
                duplicates:document.querySelectorAll('.fluent-read-bilingual-content .fluent-read-bilingual-content').length,
            }));
            report.dynamicSamples ||= [];
            report.dynamicSamples.push({mode,...running});
            assert.equal(running.sameNeighbor,true);
            assert.equal(running.duplicates,0);
            assert.ok(running.clicks > 0);
            assert.ok(running.lastSamples.every(sample => Object.values(sample).every(count => count === 0)));
            assert.equal(provider.translatedItemCount(),baselineItems,'Continuously changing numeric and nonnumeric sources must not request translation');
            await assertMatrix(page,mode,'updated',requestStart);
            for (const name of ['continuous-numeric-label','continuous-numeric-prose','continuous-nonnumeric-prose','continuous-owner-numeric-label','continuous-owner-nonnumeric-prose']) report.cases.push({name,mode,requestsWhileChanging:0,neighborUnchanged:true});
            await page.evaluate(() => {
                clearInterval(window.__interval);
                document.querySelector('#changing').firstChild.nodeValue='The processing task is now complete.';
                document.querySelector('#changing-words').firstChild.nodeValue='The finished chapter is ready for reading.';
                document.querySelector('#changing-owner').firstChild.nodeValue='The table of contents is now ready.';
            });
            await page.locator(`#changing ${selector}`).waitFor({state:'attached',timeout:15000});
            await page.locator(`#changing-words ${selector}`).waitFor({state:'attached',timeout:15000});
            await page.locator(`#changing-owner ${selector}`).waitFor({state:'attached',timeout:15000});
            assert.equal(await page.locator(`#counter ${selector}`).count(),0,'Recognized numeric label stays original after stopping');
            assert.equal(await page.locator(`#counter-owner ${selector}`).count(),0,'Replaced numeric owner stays original after stopping');
            assert.equal(provider.translatedItemCount(),baselineItems+3,'Only the three latest stable prose sources are translated');
            report.cases.push({name:'latest-stable-prose',mode,settledRequests:3,numericLabelArtifacts:0,replacedNumericOwnerArtifacts:0});
            await page.screenshot({path:path.join(artifactsDir,`${mode}-settled.png`)});
            await page.evaluate(() => {document.querySelector('#counter').firstChild.nodeValue='A newly published article is ready.';});
            await page.locator(`#counter ${selector}`).waitFor({state:'attached',timeout:15000});
            const beforePendingRestore=provider.translatedItemCount();
            await page.evaluate(() => {
                const owner=document.querySelector('#changing-words');
                (owner.querySelector('.fluent-read-single-slot')?.firstChild || owner.firstChild).nodeValue='The host is still computing the final preview.';
            });
            await page.waitForTimeout(100);
            await page.keyboard.press('Alt+t');
            await page.waitForTimeout(10500);
            assert.equal(provider.translatedItemCount(),beforePendingRestore,'Restore must cancel the pending quiet-window retranslation');
            assert.equal(await page.locator(artifacts).count(),0);
            assert.equal(await page.locator('#counter').textContent(),'A newly published article is ready.');
            assert.equal(await page.locator('#changing').textContent(),'The processing task is now complete.');
            assert.equal(await page.locator('#changing-owner').innerHTML(),'The table of contents is now ready.');
            assert.match(await page.locator('#counter-owner').innerHTML(),/^Readers: \d+$/);
            assert.equal(await page.locator('#changing-words').textContent(),'The host is still computing the final preview.');
            const inlineNumber=await page.locator('#inline-number').textContent();
            assert.equal(await page.locator('#inline').textContent(),`This stable paragraph includes ${inlineNumber} records and a timer 2 minutes ago.`);
            assert.equal(await page.evaluate(() => {
                const nodes=Array.from(document.querySelector('#inline').childNodes);
                return nodes.length === window.__inlineOriginalNodes.length && nodes.every((node,index) => node === window.__inlineOriginalNodes[index]);
            }),true,'Restoring inline text must preserve original DOM nodes');
            await assertMatrix(page,mode,'restored',requestStart);
            displayCases.forEach(item => report.cases.push({name:'standalone-display',id:item.id,mode,initial:item.initial,latest:item.latest,
                translationArtifacts:0,providerItems:0,originalNodesPreserved:true,restoreShowsLatest:true}));
            report.cases.push({name:'restore-with-pending-quiet-window',mode,requestsAfterRestore:0});
            await page.keyboard.press('Alt+t');
            await page.locator(`#normal ${selector}`).waitFor({state:'attached'});
            assert.equal(await page.locator(`#normal ${selector}`).count(),1);
            await assertMatrix(page,mode,'retranslated',requestStart);
            report.cases.push({name:'restore-and-retranslate',mode,normalArtifacts:1,displayArtifacts:0});
            await page.goto('about:blank');

            const cancel=await openPage(`cancel/${mode}`);
            await cancel.keyboard.press('Alt+t');
            for (const id of ['cancel-counter','cancel-changing','cancel-neighbor']) await cancel.locator(`#${id} ${selector}`).waitFor({state:'attached'});
            await cancel.waitForTimeout(400);
            const beforeContinuousCancel=provider.translatedItemCount();
            await cancel.evaluate(() => {
                const words=['Loading the stylesheet.','Rendering the illustration.','Checking the article.','Preparing the glossary.'];
                let value=201;
                window.__interval=setInterval(() => {
                    const write=(id,text) => {const owner=document.getElementById(id);(owner.querySelector('.fluent-read-single-slot')?.firstChild || owner.firstChild).nodeValue=text;};
                    write('cancel-counter',`Visitors: ${value}`);
                    write('cancel-changing',words[value % words.length]);
                    value++;
                },250);
            });
            await cancel.waitForTimeout(1500);
            assert.equal(await cancel.locator(`#cancel-changing ${selector}`).count(),0);
            await cancel.keyboard.press('Alt+t');
            await cancel.waitForTimeout(650); // 宿主定时器在恢复期间和恢复后仍继续运行。
            const restoredSource=await cancel.evaluate(() => {
                clearInterval(window.__interval);
                return Object.fromEntries(['cancel-counter','cancel-changing'].map(id => [id,document.getElementById(id).textContent]));
            });
            await cancel.waitForTimeout(10500);
            assert.equal(provider.translatedItemCount(),beforeContinuousCancel,'Restore during continuous changes must cancel all deferred translation');
            assert.equal(await cancel.locator(artifacts).count(),0);
            for (const [id,text] of Object.entries(restoredSource)) assert.equal(await cancel.locator(`#${id}`).innerHTML(),text);
            report.cases.push({name:'restore-while-continuously-changing',mode,requestsAfterRestore:0,latestSources:restoredSource});
            await cancel.goto('about:blank');

            const slow=await openPage(`slow/${mode}`);
            await slow.keyboard.press('Alt+t');
            for (const id of ['slow-changing','slow-neighbor']) await slow.locator(`#${id} ${selector}`).waitFor({state:'attached'});
            await slow.waitForTimeout(400);
            const beforeSlowChanges=provider.translatedItemCount();
            const slowSources=['The chapter is loading its glossary.','The chapter is arranging its illustrations.',
                'The chapter is checking its references.','The chapter is updating its outline.','The chapter is preparing the final preview.'];
            const slowSamples=[];
            for (const source of slowSources) {
                await slow.evaluate(source => {
                    const owner=document.querySelector('#slow-changing');
                    (owner.querySelector('.fluent-read-single-slot')?.firstChild || owner.firstChild).nodeValue=source;
                },source);
                await slow.waitForTimeout(2200);
                slowSamples.push({source,translatedItems:provider.translatedItemCount(),artifacts:await slow.locator(`#slow-changing ${selector}`).count()});
            }
            // 第两次真实间隔才足以识别 2.2 秒更新；前两次允许有限的识别前请求。
            const afterRecognition=slowSamples[1].translatedItems;
            assert.ok(slowSamples.slice(2).every(sample => sample.translatedItems === afterRecognition && sample.artifacts === 0),'Recognized slow updates must stay original without further requests');
            await slow.locator(`#slow-changing ${selector}`).waitFor({state:'attached',timeout:15000});
            assert.equal(provider.translatedItemCount(),afterRecognition+1,'Stopping slow updates must translate only the latest stable prose once');
            const latestSlow=slowSources.at(-1);
            assert.equal(normalize(provider.requestPayloads().flat().at(-1)),normalize(latestSlow));
            report.cases.push({name:'slow-nonnumeric-source-cadence',mode,cadenceMs:2200,samples:slowSamples,
                requestsBeforeRecognition:afterRecognition-beforeSlowChanges,requestsAfterRecognition:0,settledRequests:1});
            await slow.keyboard.press('Alt+t');
            await slow.waitForTimeout(300);
            assert.equal(await slow.locator('#slow-changing').innerHTML(),latestSlow);
            assert.equal(await slow.locator(artifacts).count(),0);
            await slow.goto('about:blank');

            const stale=await openPage(`stale/${mode}`);
            await stale.evaluate(() => {
                window.__committedArtifacts=[];
                window.__commitObserver=new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => {
                    if (node.nodeType !== Node.ELEMENT_NODE) return;
                    const found=[...(node.matches('.fluent-read-bilingual-content,.fluent-read-single-slot') ? [node] : []),...node.querySelectorAll('.fluent-read-bilingual-content,.fluent-read-single-slot')];
                    // 仅译文内容位于 closed ShadowRoot，宿主 aria-label 才是实际译文。
                    found.forEach(item => window.__committedArtifacts.push(item.getAttribute('aria-label') || item.textContent));
                })));
                window.__commitObserver.observe(document.querySelector('#stale'),{childList:true,subtree:true});
            });
            const staleRequestStart=provider.requestCount();
            await stale.keyboard.press('Alt+t');
            await waitForPayload(staleSource,staleRequestStart);
            await stale.evaluate(source => {document.querySelector('#stale').firstChild.nodeValue=source;},staleLatest);
            await stale.waitForTimeout(450);
            assert.equal(await stale.locator(`#stale ${selector}`).count(),0,'An old in-flight response must not insert a stale translation');
            await stale.locator(`#stale ${selector}`).waitFor({state:'attached',timeout:15000});
            await waitForPayload(staleLatest,staleRequestStart);
            const commits=await stale.evaluate(() => window.__committedArtifacts);
            assert.ok(commits.length > 0);
            assert.ok(commits.some(text => text.includes(staleLatest)),'Commit observer must capture the latest actual translation');
            assert.ok(commits.every(text => !text.includes(staleSource)),'Stale source must never be committed, even transiently');
            report.cases.push({name:'stale-provider-result',mode,oldSourceNeverCommitted:true,latestSourceTranslated:true});
            const inflightRequestStart=provider.requestCount();
            await stale.evaluate(source => {
                const owner=document.querySelector('#stale');
                (owner.querySelector('.fluent-read-single-slot')?.firstChild || owner.firstChild).nodeValue=source;
            },inflightSource);
            await waitForPayload(inflightSource,inflightRequestStart);
            await stale.keyboard.press('Alt+t');
            await stale.evaluate(source => {document.querySelector('#stale').firstChild.nodeValue=source;},inflightLatest);
            const beforeInflightRestore=provider.translatedItemCount();
            await stale.waitForTimeout(10500);
            assert.equal(provider.translatedItemCount(),beforeInflightRestore,'Cancelled in-flight response must not trigger another request');
            assert.equal(await stale.locator(artifacts).count(),0);
            assert.equal(await stale.locator('#stale').innerHTML(),inflightLatest);
            report.cases.push({name:'restore-with-inflight-request',mode,translationArtifacts:0,latestSource:inflightLatest});
            await stale.goto('about:blank');
        }
        await configure({display:1});
        const hover=await openPage('hover');
        const counts=[];
        for (const expected of [1,0,1]) {
            await hover.locator('#normal').click({position:{x:80,y:12}});
            await hover.keyboard.press('Control');
            await hover.waitForFunction(expected => document.querySelectorAll('#normal .fluent-read-bilingual-content').length === expected,expected);
            counts.push(await hover.locator('#normal .fluent-read-bilingual-content').count());
        }
        report.cases.push({name:'hover-normal-toggle',mode:'hover',counts});
        for (const id of ['duration','clock-utc','duration-traditional-minute','split-duration']) {
            const before=provider.translatedItemCount();
            await hover.locator(`#${id}`).click();
            await hover.keyboard.press('Control');
            await hover.waitForTimeout(700);
            assert.equal(await hover.locator(`#${id} ${artifacts.split(',').join(`,#${id} `)}`).count(),0);
            assert.equal(provider.translatedItemCount(),before,`Hover ${id} display must not request translation`);
            report.cases.push({name:'hover-display-exclusion',mode:'hover',id,translationArtifacts:0,providerItems:0});
        }
        assert.equal(await hover.locator('#neighbor .fluent-read-bilingual-content').count(),0);
        await assertSafeFocus();
        report.payloads=provider.requestPayloads();
        report.coverage.completedDisplayExecutions=report.cases.filter(item => item.name === 'standalone-display').length;
        report.coverage.completedLifecycleExecutions=report.cases.filter(item => item.mode !== 'hover' && item.name !== 'standalone-display').length;
        report.coverage.completedHoverExecutions=report.cases.filter(item => item.mode === 'hover').length;
        assert.deepEqual(report.errors,[]);
        report.ok=true;
    } catch (error) {
        primaryError=error;
        report.errors.push(String(error.stack || error));
        process.exitCode=1;
    } finally {
        const cleanupErrors=[];
        const cleanup=async action => {try {await action();} catch (error) {cleanupErrors.push(error);}};
        let browserClosed=false;
        await cleanup(async () => {if (launched) {await launched.close();browserClosed=true;}});
        await cleanup(async () => {await focusMonitor?.stop();});
        report.focusEvents = focusMonitor?.events ?? [];
        report.focusViolation = focusFailure ? String(focusFailure) : null;
        if (focusFailure || focusMonitor?.error || report.focusEvents.some(event => event.pid === browserPid)) report.ok=false;
        await cleanup(async () => {await provider?.close();});
        await cleanup(async () => {if (server.listening) await new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve()));});
        await cleanup(() => {
            if (browserClosed) fs.rmSync(profileDir,{recursive:true,force:true});
            else if (!launchAttempted) {
                try {fs.rmdirSync(profileDir);} catch (error) {if (!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code)) throw error;}
            }
        });
        if (cleanupErrors.length) {report.ok=false;report.cleanupErrors=cleanupErrors.map(error => error.stack || String(error));}
        if (!report.ok) process.exitCode=1;
        report.caseCount=report.cases.length;
        await cleanup(() => {fs.writeFileSync(path.join(artifactsDir,'report.json'),JSON.stringify(report,null,2));});
        for (const error of cleanupErrors) process.stderr.write(`Cleanup failed: ${error.stack || error}\n`);
        if (cleanupErrors.length && !primaryError) throw cleanupErrors[0];
        console.log(JSON.stringify({ok:report.ok,caseCount:report.caseCount,coverage:report.coverage,cases:report.cases,errors:report.errors,artifactsDir},null,2));
    }
})().catch(error => {console.error(error.stack || error);process.exitCode=1;});
