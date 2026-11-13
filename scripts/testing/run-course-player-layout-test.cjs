#!/usr/bin/env node
/** 独立课程播放器复刻页的图标、精简菜单与 Fullscreen API 验收；不访问真实课程和账号。 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {coursePlayerFixture, source} = require('../../tests/fixtures/course-players/player.cjs');
const args = process.argv.slice(2);
const allowed = new Set(['--sites','--extension-dir','--artifacts-dir','--playwright-root','--background']);
const options = {};
for (let i=0;i<args.length;i++) {
    const name=args[i]; if(!allowed.has(name)) throw Error(`Unknown option: ${name}`);
    if(name==='--background')options.background=true;
    else {const value=args[++i];if(!value||value.startsWith('--'))throw Error(`Missing value: ${name}`);options[name.slice(2)]=value;}
}
if(!options.background)throw Error('Use --background for an isolated visible secondary-display browser');
const sites=(options.sites||'').split(',');
if(!sites.length||sites.some(site=>!['bilibili','udemy','edx'].includes(site)))throw Error('Specify --sites bilibili,udemy,edx or a non-empty subset');
const root=path.resolve(__dirname,'../..');
const extension=path.resolve(options['extension-dir']||path.join(root,'.output/chrome-mv3'));
const artifacts=path.resolve(options['artifacts-dir']||path.join(os.tmpdir(),'fluentread-course-layout-results'));
const {chromium}=require(path.join(options['playwright-root']||process.env.PLAYWRIGHT_ROOT||'', 'playwright'));
const skill=path.join(os.homedir(),'.codex/skills/fluentread-browser-translation-test/scripts');
const helper=require(path.join(skill,'focus-safe-browser.cjs'));
const {createRuntimeDiagnostics}=require(path.join(skill,'runtime-diagnostics.cjs'));
const urls={bilibili:'https://www.bilibili.com/video/BV1xx411c7mD/',udemy:'https://www.udemy.com/course/python/learn/lecture/123/',edx:'https://courses.edx.org/courseware/layout-test'};
const captionSelectors={bilibili:'.bpx-player-ctrl-subtitle-result',udemy:'[data-purpose="captions-dropdown-button"] svg',edx:'.toggle-captions svg'};
const report={kind:'local-native-layout-reproduction',sites,mocked:{page:true,subtitles:true,translation:true},results:[],limitations:['Bilibili dimensions were measured on the live site on 2026-11-14; Udemy and edX are representative layouts, not live-course acceptance.']};
const diagnostics=createRuntimeDiagnostics();
let session,profile,page;

async function main(){
    fs.mkdirSync(artifacts,{recursive:true});
    const videoFile=path.join(artifacts,'fixture.mp4');
    const media=spawnSync('/opt/homebrew/bin/ffmpeg',['-y','-f','lavfi','-i','color=c=#111824:s=960x540:r=5','-t','20','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',videoFile],{encoding:'utf8',timeout:30000});
    fs.writeFileSync(path.join(artifacts,'ffmpeg.log'),media.stderr||'');assert.equal(media.status,0);
    const mediaUrl=`data:video/mp4;base64,${fs.readFileSync(videoFile).toString('base64')}`;
    profile=fs.mkdtempSync(path.join(os.tmpdir(),'fluentread-course-layout-'));
    try{
        session=await helper.launchFocusSafePersistentContext({chromium,profileDir:profile,browserPath:'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',headless:false,background:true,displayTarget:'secondary',viewport:{width:1280,height:900},browserArgs:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--no-first-run','--no-default-browser-check']});
        report.launchMode=session.launchMode;report.focusPolicy=session.focusPolicy;report.windowPlacement=session.windowPlacement;
        const context=session.context;await diagnostics.start(context);
        const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
        const extensionId=new URL(worker.url()).host;diagnostics.setExtensionId(extensionId);
        await worker.evaluate(()=>{const original=fetch.bind(globalThis);globalThis.fetch=async(input,init)=>{
            const url=String(typeof input==='string'||input instanceof URL?input:input.url);
            if(url.startsWith('https://edge.microsoft.com/translate/translatetext'))return new Response(JSON.stringify(JSON.parse(init.body).map(()=>({translations:[{text:'类是创建对象的蓝图。',to:'zh-Hans'}]}))),{headers:{'content-type':'application/json'}});
            return original(input,init);
        };});
        const control=await helper.newPageWithoutForeground(context);await diagnostics.attachPage(control,'layout-options');
        await control.goto(`chrome-extension://${extensionId}/options.html`,{waitUntil:'domcontentloaded'});
        const result=await control.evaluate(async()=>{
            const stored=await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'});const config=typeof stored.value==='string'?JSON.parse(stored.value):stored.value;
            return chrome.runtime.sendMessage({type:'persistConfig',clientId:'course-layout-test',sequence:1,baseRevision:config.__fluentConfigRevision,config:{...config,on:true,uiLanguageSetupCompleted:true,uiLanguage:'zh-CN',from:'en',to:'zh-Hans',service:'microsoft',videoService:'microsoft',videoTranslationEnabled:true,videoSubtitleVisible:true,videoSubtitleDisplayMode:'original-only',videoCourseAutoStart:{bilibili:true,udemy:true,edx:true}}});
        });assert.equal(result.success,true,JSON.stringify(result));
        let platform;
        await context.route('**/*',async route=>{
            const req=route.request(),url=new URL(req.url());
            if(url.protocol==='chrome-extension:')return route.continue();
            const headers={'access-control-allow-origin':req.headers().origin||'*','access-control-allow-credentials':'true'};
            if(req.isNavigationRequest())return route.fulfill({contentType:'text/html; charset=utf-8',body:coursePlayerFixture(platform,mediaUrl)});
            let body;
            if(url.hostname==='api.bilibili.com')body={data:{cid:456,subtitle:{subtitles:[{lan:'en',subtitle_url:'https://aisubtitle.hdslb.com/layout.json'}]}}};
            else if(url.hostname==='aisubtitle.hdslb.com')body={body:[{from:0,to:20,content:source}]};
            else if(url.pathname.startsWith('/api-2.0/courses/'))body={id:77,locale:{locale:'en_US'}};
            else if(url.pathname.startsWith('/api-2.0/users/'))body={asset:{captions:[{locale_id:'en_US',source:'manual',status:1,url:'https://captions.udemycdn.com/layout.vtt'}]}};
            else if(url.hostname==='captions.udemycdn.com')return route.fulfill({contentType:'text/vtt',headers,body:`WEBVTT\n\n00:00.000 --> 00:20.000\n${source}\n`});
            else if(url.pathname.startsWith('/transcript/'))body={start:[0],end:[20000],text:[source]};
            else return route.fulfill({status:204,headers});
            return route.fulfill({contentType:'application/json',headers,body:JSON.stringify(body)});
        });
        page=await helper.newPageWithoutForeground(context);await diagnostics.attachPage(page,'course-layout-main-and-isolated');page.setDefaultTimeout(15000);
        const host=()=>page.locator('#fluent-read-course-controls');
        const menu=()=>host().locator('#fluent-read-video-subtitle-menu');
        const button=()=>host().locator('button[aria-haspopup]');
        const check=async state=>{
            diagnostics.setPhase(`${platform}-${state}`);
            await page.locator(captionSelectors[platform]).hover();
            await page.waitForFunction(selector=>{const host=document.getElementById('fluent-read-course-controls');const own=host?.shadowRoot?.querySelector('[aria-haspopup]');const native=document.querySelector(selector);if(!own||!native)return false;const a=own.getBoundingClientRect(),b=native.getBoundingClientRect();return a.height>0&&Math.abs(a.y+a.height/2-b.y-b.height/2)<.75;},captionSelectors[platform]);
            const a=await button().boundingBox(),b=await page.locator(captionSelectors[platform]).boundingBox(),progress=await page.locator('[data-fixture-progress]').boundingBox();
            const delta=Math.abs(a.y+a.height/2-b.y-b.height/2);
            const settingsIcon=await page.locator('.bpx-player-ctrl-setting svg').boundingBox();
            assert.ok(Math.abs(a.y+a.height/2-settingsIcon.y-settingsIcon.height/2)<.75,'Brand must align with the visible settings icon too');
            assert.ok(a.x+a.width<=b.x+.75,'Brand must precede captions');
            assert.ok(a.y>=progress.y+progress.height||a.y+a.height<=progress.y,'Brand must avoid progress');
            await button().click();assert.equal(await menu().evaluate(n=>n.matches(':popover-open')),true);
            const bounds=await menu().boundingBox();const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
            assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=viewport.width+.75&&bounds.y+bounds.height<=viewport.height+.75,'Menu must fit viewport');
            assert.equal(await menu().evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(24, 24, 28)');
            await menu().locator('[data-mode="original-only"]').click();
            assert.equal(await menu().locator('.fluent-read-video-menu-order-setting').isVisible(),false);
            assert.equal(await menu().locator('[data-subtitle-order-hint]').count(),0);
            await menu().locator('[data-action="toggle-reading-annotation"]').hover();
            assert.equal(await menu().locator('[data-reading-help]').isVisible(),false);
            await menu().locator('[data-mode="bilingual"]').click();
            assert.equal(await menu().locator('.fluent-read-video-menu-order-setting').isVisible(),true);
            await menu().locator('[data-mode="bilingual"]').focus();
            await page.screenshot({path:path.join(artifacts,`${platform}-${state}-menu.png`)});
            await menu().screenshot({path:path.join(artifacts,`${platform}-${state}-menu-panel.png`)});
            await menu().locator('[data-action="close-menu"]').click();
            await page.locator('.bpx-player-control-wrap').screenshot({path:path.join(artifacts,`${platform}-${state}-controls.png`)});
            assert.equal(await host().count(),1);
            report.results.push({platform,state,centerDeltaCssPx:delta,icon:a,nativeButton:b,menu:bounds,viewport,fullscreen:await page.evaluate(()=>!!document.fullscreenElement),passed:true});
            console.log(`${platform} ${state}: aligned (${delta.toFixed(2)}px), menu fits`);
        };
        for(platform of sites){
            diagnostics.setPhase(platform+'-navigation');await page.goto(urls[platform],{waitUntil:'domcontentloaded'});await helper.activateExtensionTabWithoutForeground(context,page);
            await host().waitFor({state:'visible'});await page.locator('video').waitFor({state:'visible'});
            await check('normal');
            await page.locator('[data-fixture-web]').click();await page.waitForFunction(()=>document.querySelector('.player').classList.contains('web-fullscreen'));await check('web-fullscreen');
            await page.locator('[data-fixture-web]').click();await page.locator('[data-fixture-full]').click();await page.waitForFunction(()=>!!document.fullscreenElement);await check('native-fullscreen');
            await page.evaluate(()=>document.exitFullscreen());await page.waitForFunction(()=>!document.fullscreenElement);await check('restored');
            await page.setViewportSize({width:390,height:844});await check('narrow');await page.setViewportSize({width:1280,height:900});
        }
        diagnostics.setPhase('teardown');await page.goto('about:blank');await control.reload();await diagnostics.flush();diagnostics.assertClean();report.passed=true;
    }catch(error){report.passed=false;report.failure=error.stack;if(page&&!page.isClosed())await page.screenshot({path:path.join(artifacts,'failure.png')});throw error;}
    finally{await diagnostics.flush();diagnostics.write(artifacts,report);await diagnostics.stop();if(session)await session.close();if(profile)fs.rmSync(profile,{recursive:true,force:true});console.log(JSON.stringify({passed:report.passed,cases:report.results.length,artifacts,failure:report.failure}));}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
