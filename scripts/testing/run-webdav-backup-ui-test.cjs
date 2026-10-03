'use strict';
/**
 * @file scripts/testing/run-webdav-backup-ui-test.cjs
 * 文件职责：在不抢焦点的临时 Edge 中验证生产扩展的 WebDAV 配置云备份。
 * 主要内容：真实本机 HTTP 夹具、连接测试、预览取消、密文保存、凭据恢复、并发失败、七语言与窄屏。
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
    const state = {content:null, version:0, folder:false, failPut:false, calls:[]};
    const expected = 'Basic '+Buffer.from('fixture-user:fixture-app-password').toString('base64');
    const server = createServer(async (req,res) => {
        state.calls.push({method:req.method,url:req.url});
        if (req.headers.authorization !== expected) {res.writeHead(401).end(); return;}
        if (req.method === 'PROPFIND' && req.url === '/dav/') {res.writeHead(207, {'Content-Type':'application/xml'}).end('<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>'); return;}
        if (req.method === 'MKCOL' && req.url === '/dav/FluentRead/') {res.writeHead(state.folder ? 405 : 201).end(); state.folder=true; return;}
        if (req.url !== '/dav/FluentRead/fluentread-config.encrypted.json') {res.writeHead(404).end(); return;}
        if (req.method === 'GET') {if (!state.content) res.writeHead(404).end(); else res.writeHead(200, {ETag:`"v${state.version}"`}).end(state.content); return;}
        if (req.method === 'PUT') {
            if (state.failPut || (req.headers['if-none-match'] === '*' && state.content) || (req.headers['if-match'] && req.headers['if-match'] !== `"v${state.version}"`)) {res.writeHead(412).end(); return;}
            const chunks=[]; for await (const chunk of req) chunks.push(Buffer.from(chunk));
            state.content=Buffer.concat(chunks).toString(); state.version++; res.writeHead(201).end(); return;
        }
        res.writeHead(405).end();
    });
    const report = {ok:false,evidence:'production extension and real fetch to a local WebDAV HTTP fixture',extensionDir,launchMode:null,focusPolicy:null,windowPlacement:null,cases:[],consoleErrors:[],screenshots:[]};
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
        async function shot(name) {await page.waitForTimeout(200);const target=path.join(artifactsDir,name+'.png');await page.screenshot({path:target,animations:'disabled'});report.screenshots.push(target);}
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
        await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor();
        check((await dialog.innerText()).includes('fixture-user'),'preview identifies the configured account');
        check(!(await dialog.innerText()).includes('fixture-private'),'preview does not expose complete credentials');
        check(await dialog.locator('input[type="password"]').count()===0,'backup has no user encryption passphrase');
        await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'});check(writes()===0,'cancelling first preview leaves cloud unchanged');
        await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor();await page.locator('[data-testid="webdav-confirm"]').click();await dialog.waitFor({state:'hidden'});
        check(state.version===1 && state.content && !state.content.includes('fixture-private') && !state.content.includes('fixture-app-password'),'confirmed first backup uploads only a ciphertext envelope');
        await page.locator('[data-testid="webdav-last-account"]').waitFor();await page.locator('[data-testid="cloud-backup-privacy"]').hover();await page.getByText('仅访问你指定服务器下的 FluentRead 备份文件。',{exact:true}).waitFor();await shot('webdav-privacy-desktop');await page.locator('[data-testid="webdav-sync-now"]').hover();await shot('webdav-backup-desktop');
        const requestCount=state.calls.length;
        await page.reload({waitUntil:'domcontentloaded'});await navigate();await page.locator('[data-testid="webdav-sync-now"]').waitFor();
        check(state.calls.length===requestCount,'reopening remembers selected method and connection without network requests');
        await savePatch({to:'de',token:{},apiKeys:{},customBody:{}});
        await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor();
        await chooseIntent('download');
        check((await dialog.innerText()).includes('WebDAV'),'restore review describes the correct provider');
        check(await dialog.locator('.drive-change').count()===0,'restore differences are collapsed by default');
        await shot('webdav-restore-review');
        await page.locator('[data-testid="webdav-confirm"]').click();await dialog.waitFor({state:'hidden'});
        const restored=await page.evaluate(async () => ({config:await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'}),credentials:await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:credentials'})}));
        check(restored.config.value.to==='fr' && JSON.stringify(restored.credentials.value).includes('fixture-private-key'),'restore applies full configuration and credentials through real persistence');
        check(state.version===1,'restoring does not rewrite the server file');
        await savePatch({to:'de'});await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor();
        await chooseIntent('upload');
        const original=state.content;state.failPut=true;
        await page.locator('[data-testid="webdav-confirm"]').click();await dialog.waitFor({state:'hidden'});
        await card.getByText('云端备份已变化',{exact:false}).waitFor();check(state.content===original && state.version===1,'ETag rejection keeps existing cloud backup intact');state.failPut=false;
        await page.locator('[data-testid="webdav-sync-now"]').click();await dialog.waitFor();await chooseIntent('merge');
        check((await dialog.innerText()).includes('逐项合并'),'merge remains a secondary deliberate action');
        await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'});
        await page.setViewportSize({width:390,height:900});await activateExtensionTabWithoutForeground(context,page);
        check(await page.evaluate(() => document.documentElement.scrollWidth<=document.documentElement.clientWidth),'390px backup has no horizontal overflow');await shot('webdav-backup-mobile');
        await page.locator('[data-testid="webdav-setup"]').click();await setup.waitFor();await shot('webdav-connection-mobile');
        check(await setup.evaluate(el => {const rect=el.getBoundingClientRect();return el.scrollWidth<=el.clientWidth && rect.top>=0 && rect.bottom<=window.innerHeight;}),'390px connection dialog fits the viewport');
        await setup.getByRole('button',{name:'取消',exact:true}).click();await setup.waitFor({state:'hidden'});
        for (const language of ['en-US','ja-JP','ko-KR','fr-FR','ru-RU','es-ES']) {
            await savePatch({uiLanguage:language,uiLanguageSetupCompleted:true});await page.reload({waitUntil:'domcontentloaded'});await navigate();await page.locator('[data-testid="webdav-sync-now"]').waitFor();
            check(!(await card.innerText()).includes('配置云备份') && !(await card.innerText()).includes('请先设置'),'cloud backup is localized: '+language);
            check(await page.evaluate(() => document.documentElement.scrollWidth<=document.documentElement.clientWidth),'localized narrow layout: '+language);
            if (language==='en-US') {check(!/[\u3400-\u9fff]/u.test(await card.innerText()),'English cloud card has no Chinese source text');await shot('webdav-english-mobile');}
        }
        await savePatch({uiLanguage:'zh-CN',uiLanguageSetupCompleted:true,theme:'dark'});await page.reload({waitUntil:'domcontentloaded'});await navigate();await page.locator('[data-testid="webdav-sync-now"]').waitFor();await page.setViewportSize({width:1440,height:1000});await shot('webdav-dark-desktop');
        await page.locator('[data-testid="webdav-setup"]').click();await setup.waitFor();await page.locator('[data-testid="webdav-clear"]').click();await page.locator('.el-message-box').getByRole('button',{name:'清除连接设置',exact:true}).click();await setup.waitFor({state:'hidden'});
        check(await page.locator('[data-testid="webdav-sync-now"]').count()===0 && state.content===original,'clearing connection keeps cloud file and disables backup until configured');
        const final=await page.evaluate(() => chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'}));check(final.value.to==='de','clearing connection preserves device settings');
        check(report.consoleErrors.length===0,'no unhandled options page errors');report.ok=true;
    } catch (error) {report.failure=error.message;throw error;}
    finally {if(launched)await launched.close();await new Promise(resolve => server.close(resolve));fs.writeFileSync(path.join(artifactsDir,'report.json'),JSON.stringify(report,null,2));fs.rmSync(profileDir,{recursive:true,force:true});}
    console.log(JSON.stringify(report,null,2));
}
main().catch(error => {console.error(error.message);process.exitCode=1;});
