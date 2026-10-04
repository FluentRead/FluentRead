'use strict';
/**
 * @file scripts/testing/run-webdav-backup-ui-test.cjs
 * 文件职责：在不抢焦点的临时 Edge 中验证生产扩展的 WebDAV 配置云备份。
 * 主要内容：真实本机 HTTP 夹具、连接测试、预览取消、密文保存、HEAD 版本补取、只读恢复、七语言与窄屏。
 * 模块边界：不操作日常 profile 或真实账号；服务器与凭据均为本次测试创建，报告不包含配置正文。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createServer} = require('node:http');
function arg(name, fallback) {const index = process.argv.indexOf(`--${name}`); return index < 0 ? fallback : process.argv[index + 1];}
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-webdav-ui'));
const playwrightRoot = arg('playwright-root');
const helperPath = arg('focus-safe-helper');
if (!playwrightRoot || !helperPath) throw new Error('必须显式指定 Playwright 与 focus-safe helper');
const {chromium} = require(path.join(playwrightRoot, 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground} = require(helperPath);
async function main() {
    fs.mkdirSync(artifactsDir, {recursive:true});
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-webdav-profile-'));
    const state = {content:null, version:0, folder:false, failPut:false, etagMode:'prop', calls:[]};
    const expected = 'Basic '+Buffer.from('fixture-user:fixture-app-password').toString('base64');
    const server = createServer(async (req,res) => {
        state.calls.push({method:req.method,url:req.url,match:req.headers['if-match']});
        if (![expected,'Basic '+Buffer.from('fixture-other:fixture-app-password').toString('base64')].includes(req.headers.authorization)) {res.writeHead(401).end(); return;}
        if (req.method === 'PROPFIND' && (req.url === '/dav/' || req.url === '/dav/FluentRead/')) {
            if (req.url === '/dav/FluentRead/' && !state.folder) {res.writeHead(404).end(); return;}
            res.writeHead(207, {'Content-Type':'application/xml'}).end(`<d:multistatus xmlns:d = "DAV:"><d:response xmlns:p="DAV:"><p:href>${req.url}</p:href><p:propstat><p:prop><p:resourcetype><p:collection/></p:resourcetype></p:prop><p:status><![CDATA[HTTP/1.1 200 OK]]></p:status></p:propstat></d:response></d:multistatus>`); return;
        }
        if (req.method === 'MKCOL' && req.url === '/dav/FluentRead/') {res.writeHead(state.folder ? 405 : 201).end(); state.folder=true; return;}
        if (req.url !== '/dav/FluentRead/fluentread-config.encrypted.json') {res.writeHead(404).end(); return;}
        if (req.method === 'PROPFIND') {res.writeHead(207, {'Content-Type':'application/xml'}).end(`<multistatus xmlns="DAV:"><response xmlns:p = "DAV:"><p:href>${req.url}</p:href><p:propstat><p:prop>${state.etagMode==='prop'?`<p:getetag>&#34;v${state.version}&#x22;</p:getetag>`:''}</p:prop><p:status><![CDATA[HTTP/1.1 200 OK]]></p:status></p:propstat></response></multistatus>`);return;}
        if (req.method === 'HEAD') {res.writeHead(200,state.etagMode==='head'?{ETag:`"v${state.version}"`}:{}).end();return;}
        if (req.method === 'GET') {if (!state.content) res.writeHead(state.folder ? 404 : 409).end(); else if (req.headers['if-match'] && req.headers['if-match'] !== `"v${state.version}"`) res.writeHead(412).end(); else res.writeHead(200).end(state.content); return;}
        if (req.method === 'PUT') {
            if (state.failPut || (req.headers['if-none-match'] === '*' && state.content) || (req.headers['if-match'] && req.headers['if-match'] !== `"v${state.version}"`)) {res.writeHead(412).end(); return;}
            const chunks=[]; for await (const chunk of req) chunks.push(Buffer.from(chunk));
            state.content=Buffer.concat(chunks).toString(); state.version++; res.writeHead(201).end(); return;
        }
        res.writeHead(405).end();
    });
    const report = {ok:false,evidence:'real extension and fetch to a local WebDAV HTTP fixture',extensionDir,buildKind:extensionDir.endsWith('-dev')?'development':'production',launchMode:null,focusPolicy:null,windowPlacement:null,cases:[],consoleErrors:[],screenshots:[]};
    let launched;
    const check = (condition,label) => {if (!condition) throw new Error(label); report.cases.push(label);};
    try {
        await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
        const url=`http://127.0.0.1:${server.address().port}/dav/`;
        launched=await launchFocusSafePersistentContext({chromium,profileDir,browserPath:'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',headless:false,background:true,displayTarget:'secondary',browserArgs:[`--disable-extensions-except=${extensionDir}`,`--load-extension=${extensionDir}`,'--no-first-run','--no-default-browser-check'],viewport:{width:1440,height:1000},timeout:30000});
        report.launchMode=launched.launchMode; report.focusPolicy=launched.focusPolicy; report.windowPlacement=launched.windowPlacement;
        const {context}=launched;
        const worker=context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://')) || await context.waitForEvent('serviceworker',{timeout:30000});
        const id=new URL(worker.url()).host;
        const page=await newPageWithoutForeground(context,30000);
        page.on('pageerror',e => report.consoleErrors.push(e.message));
        page.on('console',message => {if (message.type()==='error' || message.text().includes('Failed to resolve component')) report.consoleErrors.push(message.text());});
        const settingsUrl=`chrome-extension://${id}/options.html#settings-data`;
        await page.goto(settingsUrl,{waitUntil:'domcontentloaded'});
        let sequence=0;
        async function savePatch(patch) {
            const result=await page.evaluate(async ({patch,sequence}) => {
                const current=await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'});
                const credentials=await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:credentials'});
                return chrome.runtime.sendMessage({type:'persistConfig',mode:'replace',config:{...current.value,...credentials.value,...patch},clientId:'fixture-webdav-ui',sequence});
            },{patch,sequence:++sequence});
            check(result.success===true,`production configuration persistence ${sequence}`);
        }
        async function navigate() {const navigation=page.locator('button[data-section="settings-data"]');if (await navigation.isVisible()) await navigation.click();await page.locator('[data-testid="cloud-config-backup"]').waitFor();}
        async function shot(name) {await page.waitForTimeout(200);await page.waitForFunction(()=>!document.querySelector('.el-message'),null,{timeout:6000});const target=path.join(artifactsDir,name+'.png');await page.screenshot({path:target,animations:'disabled'});report.screenshots.push(target);}
        const writes=() => state.calls.filter(c => ['PUT','MKCOL'].includes(c.method)).length;
        await savePatch({uiLanguage:'zh-CN',uiLanguageSetupCompleted:true,token:{openai:'fixture-private-key'},apiKeys:{openai:['fixture-private-key']},customBody:{openai:'{"auth":"fixture-private-body"}'},to:'fr'});
        await page.reload({waitUntil:'domcontentloaded'}); await navigate();
        const card=page.locator('[data-testid="cloud-config-backup"]');
        check(await card.getByRole('heading',{name:'配置云备份',exact:true}).isVisible(),'Google Drive and WebDAV share one cloud backup heading');
        await page.locator('[data-testid="cloud-method-webdav"]').check();
        await page.locator('[data-testid="webdav-setup"]').click();
        const setup=page.locator('.webdav-settings-dialog');await setup.waitFor();
        await page.locator('#webdav-url').fill(url);await page.locator('#webdav-username').fill('fixture-user');await page.locator('#webdav-password').fill('wrong-fixture');
        check(!(await page.locator('[data-testid="webdav-test"]').isEnabled()),'HTTP requires explicit acknowledgement before requests');
        await setup.locator('input[type="checkbox"]').check();
        await page.locator('[data-testid="webdav-test"]').click();await setup.getByText('账号或应用密码不正确',{exact:false}).waitFor();
        check(writes()===0,'wrong credentials and connection test make no cloud writes');
        await page.locator('#webdav-password').fill('fixture-app-password');await page.locator('[data-testid="webdav-test"]').click();
        await setup.getByText('连接测试通过',{exact:false}).waitFor();check(writes()===0,'successful connection test is read only');
        await shot('webdav-connection-desktop');
        await page.locator('[data-testid="webdav-save"]').click();await setup.waitFor({state:'hidden'});
        await page.locator('[data-testid="webdav-sync-now"]').waitFor();check(writes()===0,'saving connection does not create a backup');
        await page.locator('[data-testid="webdav-setup"]').click();await setup.waitFor();
        check(await page.locator('#webdav-password').inputValue()==='','saved app password is not returned to form');
        await setup.getByRole('button',{name:'取消',exact:true}).click();await setup.waitFor({state:'hidden'});
        for (const key of ['local:webdavBackupConnection','local:webdavEncryptedSyncState']) {
            const result=await page.evaluate(key => chrome.runtime.sendMessage({type:'configStorageRead',key}),key);
            check(result.success===false,`${key} is inaccessible through generic configuration proxy`);
        }
        const dialog=page.locator('.drive-dialog');
        async function chooseIntent(direction) {if (await page.locator('[data-testid="webdav-back"]').count()) await page.locator('[data-testid="webdav-back"]').click(); if (direction==='merge') await page.locator('[data-testid="webdav-direction-merge"]').click(); else {await page.locator(`[data-testid="webdav-direction-${direction}"]`).check();await page.locator('[data-testid="webdav-continue"]').click();}}
        if (process.argv.includes('--sensitive-only')) {
            const toggle=page.locator('[data-testid="cloud-include-sensitive"]');
            const switchInput=toggle.locator('input[role="switch"]');
            const consent=page.locator('.cloud-consent-dialog');
            async function expectOff(label) {check(await switchInput.getAttribute('aria-checked')==='false',label);}
            async function allowSensitive() {
                await toggle.click();await consent.waitFor();
                check(!(await page.locator('[data-testid="cloud-consent-confirm"]').isEnabled()),'sensitive confirmation requires an unchecked acknowledgement');
                await page.locator('[data-testid="cloud-risk-acknowledgement"]').check();
                await page.locator('[data-testid="cloud-consent-confirm"]').click();await consent.waitFor({state:'hidden'});
                check(await switchInput.getAttribute('aria-checked')==='true','explicit acknowledgement enables only this operation');
            }
            async function readPayload() {
                return page.evaluate(async content=>{
                    const envelope=JSON.parse(content);const decode=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
                    const material=await crypto.subtle.importKey('raw',new TextEncoder().encode('FluentReadEncryption'),'PBKDF2',false,['deriveKey']);
                    const key=await crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',iterations:envelope.iterations,salt:decode(envelope.salt)},material,{name:'AES-GCM',length:256},false,['decrypt']);
                    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(envelope.iv),additionalData:new TextEncoder().encode('fluentread-drive-encrypted:1:PBKDF2:SHA-256:600000:AES-256-GCM'),tagLength:128},key,decode(envelope.ciphertext));
                    return JSON.parse(new TextDecoder().decode(plain));
                },state.content);
            }
            async function credentials() {return page.evaluate(async()=> (await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:credentials'})).value);}
            async function confirm() {await page.locator('[data-testid="webdav-confirm"]').click();await dialog.waitFor({state:'hidden'});await expectOff('completing an operation resets sensitive consent');}
            const beforeConsent=state.calls.length;
            await expectOff('sensitive information is excluded by default');await shot('cloud-default-scope-desktop');
            await toggle.click();await consent.waitFor();
            check((await consent.innerText()).includes('公开的应用口令')&&(await consent.innerText()).includes('第三方账号被盗'),'risk dialog explains public encryption and stolen third-party accounts');
            await shot('cloud-sensitive-consent-desktop');
            await page.locator('[data-testid="cloud-consent-cancel"]').click();await consent.waitFor({state:'hidden'});
            await expectOff('cancelling risk acknowledgement leaves sensitive sync disabled');
            check(state.calls.length===beforeConsent,'opening and cancelling risk dialog makes no provider requests');
            await savePatch({proxy:{openai:'https://fixture.invalid/?key=fixture-private-url'},system_role:'fixture-private-prompt'});
            await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor();
            check((await dialog.locator('[data-testid="cloud-preview-scope"]').innerText()).includes('仅普通设置'),'preview repeats the selected settings-only scope');
            await confirm();
            const ordinary=await readPayload();const ordinaryText=JSON.stringify(ordinary);
            check(!ordinaryText.includes('fixture-private')&&!ordinaryText.includes('fixture-app-password'),'default decrypted backup excludes keys, bodies, authenticated URLs, private prompts and connection password');
            check(!Object.hasOwn(ordinary.config,'token')&&!Object.hasOwn(ordinary.config,'proxy'),'settings-only payload omits sensitive fields instead of empty deletion placeholders');
            await savePatch({to:'de',token:{openai:'fixture-device-key'},apiKeys:{openai:['fixture-device-key']},proxy:{openai:'https://device.fixture.invalid/v1'},customBody:{openai:'{"auth":"fixture-device-body"}'}});
            await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor();await chooseIntent('download');await confirm();
            const device=await credentials();
            check(JSON.stringify(device).includes('fixture-device-key'),'restoring a settings-only backup preserves device credentials');
            check((await page.evaluate(()=>chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'}))).value.proxy.openai==='https://device.fixture.invalid/v1','settings-only restore preserves the endpoint bound to local credentials');
            await allowSensitive();await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor();await chooseIntent('upload');await confirm();
            const complete=await readPayload();
            check(complete.version===1&&JSON.stringify(complete).includes('fixture-device-key')&&JSON.stringify(complete).includes('fixture-device-body'),'explicit consent creates a legacy-compatible complete backup');
            await savePatch({to:'ja',token:{openai:'fixture-new-device-key'},apiKeys:{openai:['fixture-new-device-key']},proxy:{openai:'https://new-device.fixture.invalid/v1'}});
            const legacyContent=state.content;const legacyVersion=state.version;
            await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor();
            check(await dialog.locator('[data-testid="cloud-legacy-sensitive"]').isVisible(),'old complete backup has a visible sensitive-content warning');
            await chooseIntent('download');await shot('cloud-legacy-restore-desktop');await confirm();
            check(JSON.stringify(await credentials()).includes('fixture-new-device-key'),'default restore from a legacy complete backup preserves local keys');
            check((await page.evaluate(()=>chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'}))).value.proxy.openai==='https://new-device.fixture.invalid/v1','legacy restore cannot bind local keys to the old cloud endpoint');
            check(state.version===legacyVersion&&state.content===legacyContent,'default restore leaves the existing sensitive cloud file untouched');
            await allowSensitive();await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor();await chooseIntent('download');await confirm();
            check(JSON.stringify(await credentials()).includes('fixture-device-key'),'explicit sensitive restore still imports complete legacy credentials');
            // 普通设置完全一致时，仍要允许用户主动替换含敏感信息的旧云文件。
            await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor();
            check(await page.locator('[data-testid="webdav-direction-upload"]').isVisible(),'scope change remains actionable even when ordinary settings are identical');
            await chooseIntent('upload');await confirm();
            check(!JSON.stringify(await readPayload()).includes('fixture-device-key'),'saving settings-only removes secrets from the current cloud file');
            check(JSON.stringify(await credentials()).includes('fixture-device-key'),'downgrading cloud scope does not erase local credentials');
            await allowSensitive();await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor();
            await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'});await expectOff('cancelling preview resets sensitive consent');
            await allowSensitive();await page.locator('[data-testid="cloud-method-google-drive"]').check();
            await expectOff('switching provider cannot reuse sensitive consent');
            await page.locator('[data-testid="cloud-method-webdav"]').check();await expectOff('returning to provider keeps safe default');
            await allowSensitive();await page.reload({waitUntil:'domcontentloaded'});await navigate();await expectOff('reopening settings never restores a previous sensitive consent');
            await page.setViewportSize({width:390,height:900});await activateExtensionTabWithoutForeground(context,page);await shot('cloud-default-scope-mobile');
            await toggle.click();await consent.waitFor();
            check(await consent.evaluate(el=>el.scrollWidth<=el.clientWidth),'risk dialog wraps without horizontal overflow at 390px');await shot('cloud-sensitive-consent-mobile');
            await page.keyboard.press('Escape');await consent.waitFor({state:'hidden'});await expectOff('Escape cancels risk acknowledgement');
            for (const language of ['en-US','ja-JP','ko-KR','fr-FR','ru-RU','es-ES']) {
                await savePatch({uiLanguage:language,uiLanguageSetupCompleted:true});await page.reload({waitUntil:'domcontentloaded'});await navigate();
                await toggle.click();await consent.waitFor();
                const text=await consent.innerText();
                check(!text.includes('settings.cloud.')&&!/[\u3400-\u9fff]/u.test(language==='en-US'?text:''),'consent strings resolve in '+language);
                check(await consent.evaluate(el=>el.scrollWidth<=el.clientWidth),'localized consent wraps at 390px: '+language);
                if(language==='en-US')await shot('cloud-sensitive-consent-english-mobile');
                await page.locator('[data-testid="cloud-consent-cancel"]').click();await consent.waitFor({state:'hidden'});
            }
            await savePatch({uiLanguage:'zh-CN',theme:'dark'});await page.reload({waitUntil:'domcontentloaded'});await navigate();await page.setViewportSize({width:1440,height:1000});
            await toggle.click();await consent.waitFor();await shot('cloud-sensitive-consent-dark-desktop');
            const riskContrast=await consent.locator('.cloud-consent-risk').evaluate(el=>{
                const luminance=color=>{const [r,g,b]=color.match(/[\d.]+/g).slice(0,3).map(Number).map(value=>{const c=value/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;});return .2126*r+.7152*g+.0722*b;};
                const background=luminance(getComputedStyle(el).backgroundColor);const text=luminance(getComputedStyle(el.querySelector('p')).color);
                return (Math.max(background,text)+.05)/(Math.min(background,text)+.05);
            });
            check(riskContrast>=4.5,'dark risk message has readable text contrast');
            check(report.consoleErrors.length===0,'sensitive scope UI has no unhandled console errors');report.ok=true;return;
        }
        await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor();
        check(!state.folder && writes()===0 && state.calls.some(c => c.method==='PROPFIND' && c.url==='/dav/FluentRead/'),'missing-parent 409 reaches first-backup preview without creating a folder or file');
        await shot('webdav-first-backup-409-preview');
        check((await dialog.innerText()).includes('fixture-user'),'preview identifies the configured account');
        check(!(await dialog.innerText()).includes('fixture-private'),'preview does not expose complete credentials');
        check(await dialog.locator('input[type="password"]').count()===0,'backup has no user encryption passphrase');
        await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'});check(writes()===0,'cancelling first preview leaves cloud unchanged');
        await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor();
        await page.reload({waitUntil:'domcontentloaded'});await navigate();
        await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor({timeout:6000});
        check(writes()===0,'reloading an unconfirmed preview releases its owner and permits a fresh preview');
        await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'});
        const otherPage=await newPageWithoutForeground(context,30000);
        await otherPage.goto(settingsUrl,{waitUntil:'domcontentloaded'});
        await otherPage.locator('[data-testid="webdav-sync-now"]').waitFor();
        await otherPage.locator('[data-testid="webdav-sync-now"]').click();await otherPage.locator('.drive-dialog').waitFor();
        await page.locator('[data-testid="webdav-sync-now"]').click();await card.getByText('另一个设置页面正在确认同步',{exact:false}).waitFor();
        check(writes()===0,'a second settings page cannot replace another page’s unconfirmed preview');
        await otherPage.close();
        await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor({timeout:6000});
        check(writes()===0,'closing the owning settings tab releases its preview without cloud writes');
        await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'});
        const changer=await newPageWithoutForeground(context,30000);
        await changer.goto(settingsUrl,{waitUntil:'domcontentloaded'});
        const changedConnection=await changer.evaluate(async url=>{
            const saved=await chrome.runtime.sendMessage({type:'webDavConfigBackup',action:'settings',clientId:'fixture-change-account'});
            return chrome.runtime.sendMessage({type:'webDavConfigBackup',action:'save',clientId:'fixture-change-account',connection:{url,username:'fixture-other',password:'fixture-app-password',allowInsecure:true,revision:saved.data.revision}});
        },url);
        check(changedConnection.success===true,'another trusted settings page can change the connection after preview cancellation');
        await changer.close();
        await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor();
        check((await dialog.innerText()).includes('fixture-other'),'new preview identifies the account changed in another page');
        check((await card.locator('[data-testid="webdav-account"]').innerText()).includes('fixture-other'),'the account beside sync refreshes to the connection used by the preview');
        await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'});
        const restoredConnection=await page.evaluate(async url=>{
            const saved=await chrome.runtime.sendMessage({type:'webDavConfigBackup',action:'settings',clientId:'fixture-restore-account'});
            return chrome.runtime.sendMessage({type:'webDavConfigBackup',action:'save',clientId:'fixture-restore-account',connection:{url,username:'fixture-user',password:'fixture-app-password',allowInsecure:true,revision:saved.data.revision}});
        },url);
        check(restoredConnection.success===true && writes()===0,'changing accounts and cancelling their previews never writes a cloud backup');
        await page.reload({waitUntil:'domcontentloaded'});await navigate();
        await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor();await page.locator('[data-testid="webdav-confirm"]').click();await dialog.waitFor({state:'hidden'});
        check(state.version===1 && state.content && !state.content.includes('fixture-private') && !state.content.includes('fixture-app-password'),'confirmed first backup uploads only a ciphertext envelope');
        await page.locator('[data-testid="webdav-account"]').waitFor();
        check(await card.locator('.webdav-connection').count()===0,'configured account is not duplicated above the action');
        check((await card.innerText()).split('fixture-user').length===2,'configured username appears once');
        const actionRect=await page.locator('[data-testid="webdav-sync-now"]').boundingBox();const accountRect=await page.locator('[data-testid="webdav-account"]').boundingBox();
        check(accountRect.x>actionRect.x+actionRect.width,'desktop account summary is to the right of the sync action');
        check(state.calls.some(call=>call.method==='GET'&&call.match==='"v1"'),'missing GET ETag is recovered and checked through file properties');
        await page.locator('[data-testid="cloud-backup-privacy"]').hover();await page.getByText('仅访问你指定服务器下的 FluentRead 备份文件。',{exact:true}).waitFor();await shot('webdav-privacy-desktop');await page.locator('[data-testid="webdav-sync-now"]').hover();await shot('webdav-backup-desktop');
        const requestCount=state.calls.length;
        await page.reload({waitUntil:'domcontentloaded'});await navigate();await page.locator('[data-testid="webdav-sync-now"]').waitFor();
        check(state.calls.length===requestCount,'reopening remembers selected method and connection without network requests');
        await savePatch({to:'de',token:{},apiKeys:{},customBody:{}});
        await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor();
        await chooseIntent('download');
        check((await dialog.innerText()).includes('WebDAV'),'restore review describes the correct provider');
        check(await dialog.locator('.drive-change').count()>0,'restore review shows changed settings by default');
        check(!(await dialog.innerText()).includes('API Key、OAuth Token 与鉴权信息') && !(await dialog.innerText()).includes('fixture-private'),'settings-only preview omits connection differences and secrets');
        await shot('webdav-restore-review');
        await page.locator('[data-testid="webdav-confirm"]').click();await dialog.waitFor({state:'hidden'});
        const restored=await page.evaluate(async () => ({config:await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'}),credentials:await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:credentials'})}));
        check(restored.config.value.to==='fr' && !JSON.stringify(restored.credentials.value).includes('fixture-private-key'),'settings-only restore does not import excluded credentials');
        check(state.version===1,'restoring does not rewrite the server file');
        await savePatch({to:'de'});await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor();
        await chooseIntent('upload');
        const original=state.content;state.failPut=true;
        await page.locator('[data-testid="webdav-confirm"]').click();await dialog.waitFor({state:'hidden'});
        await card.getByText('云端备份已变化',{exact:false}).waitFor();check(state.content===original && state.version===1,'ETag rejection keeps existing cloud backup intact');state.failPut=false;
        await savePatch({hotkey:'Shift'});
        await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor();await chooseIntent('merge');
        check((await dialog.innerText()).includes('逐项合并'),'merge remains a secondary deliberate action');
        check((await dialog.innerText()).includes('鼠标悬浮快捷键') && (await dialog.innerText()).includes('目标语言'),'merge review shows recognizable single-side modifications by default');
        await shot('webdav-merge-changes');
        await page.locator('[data-testid="webdav-confirm"]').click();await dialog.waitFor({state:'hidden'});
        check(state.version===2 && state.content!==original && state.calls.some(call=>call.method==='PUT'&&call.match==='"v1"'),'second modified backup succeeds without a GET ETag and uses conditional PUT');
        const updated=state.content;
        await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor();
        check((await dialog.innerText()).includes('配置已一致'),'repeated sync recognizes identical settings');
        await page.locator('[data-testid="webdav-confirm"]').click();await dialog.waitFor({state:'hidden'});
        check(state.version===2 && state.content===updated,'identical configuration does not rewrite the backup');
        state.etagMode='head';
        await savePatch({to:'es'});await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor();await chooseIntent('merge');
        await page.locator('[data-testid="webdav-confirm"]').click();await dialog.waitFor({state:'hidden'});
        check(state.version===3 && state.calls.some(call=>call.method==='HEAD') && state.calls.some(call=>call.method==='PUT'&&call.match==='"v2"'),'HEAD-only ETag permits a second safe modified backup');
        const headBackup=state.content;const readOnlyWrites=writes();
        state.etagMode='none';await savePatch({to:'de'});
        await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor();
        check(await dialog.locator('[data-testid="webdav-restore-only"]').isVisible(),'missing version presents a restore-only preview instead of a failed sync');
        check(await dialog.evaluate(el=>el.querySelector('.drive-review-title').getBoundingClientRect().top-el.querySelector('.drive-preview-notice').getBoundingClientRect().bottom>=20),'restore notice has a clear gap before review content');
        check(await page.locator('[data-testid="webdav-confirm"]').isEnabled(),'restore remains available without any server ETag');
        check(await page.locator('[data-testid="webdav-back"]').count()===0 && await page.locator('[data-testid="webdav-direction-upload"]').count()===0 && await page.locator('[data-testid="webdav-direction-merge"]').count()===0,'restore-only preview skips unavailable operation choices');
        await shot('webdav-restore-only-desktop');
        await dialog.locator('.drive-footer-actions .el-button').first().click();await dialog.waitFor({state:'hidden'});
        check(writes()===readOnlyWrites && state.content===headBackup,'cancelling a read-only preview never changes the cloud backup');
        await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor();await page.locator('[data-testid="webdav-confirm"]').click();await dialog.waitFor({state:'hidden'});
        const readOnlyRestored=await page.evaluate(()=>chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'}));
        check(readOnlyRestored.value.to==='es' && writes()===readOnlyWrites,'confirming restore without ETag restores settings and never writes');
        state.etagMode='prop';await savePatch({to:'de'});
        await page.setViewportSize({width:390,height:900});await activateExtensionTabWithoutForeground(context,page);
        check(await page.evaluate(() => document.documentElement.scrollWidth<=document.documentElement.clientWidth),'390px backup has no horizontal overflow');await shot('webdav-backup-mobile');
        await page.locator('[data-testid="webdav-setup"]').click();await setup.waitFor();await shot('webdav-connection-mobile');
        check(await setup.evaluate(el => {const rect=el.getBoundingClientRect();return el.scrollWidth<=el.clientWidth && rect.top>=0 && rect.bottom<=window.innerHeight;}),'390px connection dialog fits the viewport');
        await setup.getByRole('button',{name:'取消',exact:true}).click();await setup.waitFor({state:'hidden'});
        for (const language of ['en-US','ja-JP','ko-KR','fr-FR','ru-RU','es-ES']) {
            await savePatch({uiLanguage:language,uiLanguageSetupCompleted:true});await page.reload({waitUntil:'domcontentloaded'});await navigate();await page.locator('[data-testid="webdav-sync-now"]').waitFor();
            check(!(await card.innerText()).includes('配置云备份') && !(await card.innerText()).includes('请先设置'),'cloud backup is localized: '+language);
            check(await page.evaluate(() => document.documentElement.scrollWidth<=document.documentElement.clientWidth),'localized narrow layout: '+language);
            await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor();await chooseIntent('merge');
            check(!(await dialog.innerText()).includes('settings.cloud.'),'preview resolves message keys: '+language);
            check(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),'localized review fits narrow screen: '+language);
            if (language==='en-US') {const text=await card.innerText();check(!/[\u3400-\u9fff]/u.test(text),'English cloud card has no Chinese source text'+(/[\u3400-\u9fff]/u.test(text)?': '+text:''));check(!/[\u3400-\u9fff]/u.test(await dialog.innerText()),'English change preview has no Chinese source text');await shot('webdav-english-review-mobile');}
            await dialog.locator('.drive-footer-actions .el-button').first().click();await dialog.waitFor({state:'hidden'});
            state.etagMode='none';await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor();
            const restoreOnly=dialog.locator('[data-testid="webdav-restore-only"]');
            const expectedWarning=JSON.parse(fs.readFileSync(path.join(__dirname,'../../src/core/i18n/messages/cloud-backup',language+'.json'),'utf8')).messages['settings.cloud.restoreOnly'];
            check(await restoreOnly.isVisible() && (await restoreOnly.innerText()).trim()===expectedWarning,'restore-only warning is localized: '+language);
            check(await dialog.evaluate(el=>{const title=el.querySelector('.el-alert__title');return title.scrollWidth<=title.clientWidth && el.querySelector('.drive-review-title').getBoundingClientRect().top-el.querySelector('.drive-preview-notice').getBoundingClientRect().bottom>=20;}),'localized notice wraps without touching review content: '+language);
            check(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),'restore-only preview fits narrow screen: '+language);
            if(language==='en-US') await shot('webdav-restore-only-english-mobile');
            await dialog.locator('.drive-footer-actions .el-button').first().click();await dialog.waitFor({state:'hidden'});state.etagMode='prop';
        }
        await savePatch({uiLanguage:'zh-CN',uiLanguageSetupCompleted:true,theme:'dark'});await page.reload({waitUntil:'domcontentloaded'});await navigate();await page.locator('[data-testid="webdav-sync-now"]').waitFor();await page.setViewportSize({width:1440,height:1000});await shot('webdav-dark-desktop');
        await page.locator('[data-testid="webdav-setup"]').click();await setup.waitFor();await page.locator('#webdav-username').fill('fixture-other');await page.locator('#webdav-password').fill('fixture-app-password');await page.locator('[data-testid="webdav-save"]').click();await setup.waitFor({state:'hidden'});
        check((await card.innerText()).includes('fixture-other') && !(await card.innerText()).includes('fixture-user') && !(await card.innerText()).includes('上次同步'),'changing connection shows current account without the old account or timestamp');
        await page.locator('[data-testid="webdav-setup"]').click();await setup.waitFor();await page.locator('[data-testid="webdav-clear"]').click();await page.locator('.el-message-box').getByRole('button',{name:'清除连接设置',exact:true}).click();await setup.waitFor({state:'hidden'});
        check(await page.locator('[data-testid="webdav-sync-now"]').count()===0 && state.content===headBackup,'clearing connection keeps cloud file and disables backup until configured');
        const final=await page.evaluate(() => chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'}));check(final.value.to==='de','clearing connection preserves device settings');
        check(report.consoleErrors.length===0,'no unhandled options page errors');report.ok=true;
    } catch (error) {report.failure=error.message;throw error;}
    finally {if(launched)await launched.close();await new Promise(resolve => server.close(resolve));fs.writeFileSync(path.join(artifactsDir,'report.json'),JSON.stringify(report,null,2));fs.rmSync(profileDir,{recursive:true,force:true});}
    console.log(JSON.stringify(report,null,2));
}
main().catch(error => {console.error(error.message);process.exitCode=1;});
