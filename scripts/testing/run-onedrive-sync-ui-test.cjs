'use strict';
/**
 * @file scripts/testing/run-onedrive-sync-ui-test.cjs
 * 文件职责：在隔离 Edge 扩展中验证两个云盘的真实设置界面和后台配置事务。
 * 主要内容：注入虚构微软授权与 Graph 响应，检查保存、恢复、换号、取消、失败、多语言和窄屏布局。
 * 模块边界：不连接真实云账号，不读取日常 profile；需要显式传入 focus-safe helper，截图均为测试账号。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
function arg(name, fallback) {const index = process.argv.indexOf(`--${name}`); return index < 0 ? fallback : process.argv[index + 1];}
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-onedrive-ui'));
const playwrightRoot = arg('playwright-root'), helperPath = arg('focus-safe-helper');
if (!playwrightRoot || !helperPath) throw new Error('必须显式提供隔离浏览器依赖与 helper');
const {chromium} = require(path.join(playwrightRoot, 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground} = require(helperPath);
fs.mkdirSync(artifactsDir,{recursive:true});
async function main() {
    const profileDir=fs.mkdtempSync(path.join(os.tmpdir(),'fluentread-onedrive-ui-'));
    const report={ok:false,evidence:'production extension with synthetic OAuth and Graph; no live Microsoft or Google account',cases:[],screenshots:[],consoleErrors:[]};
    let launched;
    const check=(condition,label)=>{if(!condition)throw new Error(label);report.cases.push(label);};
    try {
        launched=await launchFocusSafePersistentContext({chromium,profileDir,browserPath:'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',headless:false,background:true,displayTarget:'secondary',browserArgs:[`--disable-extensions-except=${extensionDir}`,`--load-extension=${extensionDir}`],viewport:{width:1440,height:1000},timeout:30000});
        Object.assign(report,{launchMode:launched.launchMode,focusPolicy:launched.focusPolicy,windowPlacement:launched.windowPlacement});
        const {context}=launched;
        const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'))||await context.waitForEvent('serviceworker',{timeout:30000});
        const extensionId=new URL(worker.url()).host;
        await worker.evaluate(()=>{
            Object.defineProperty(navigator,'userAgent',{get:()=> 'Chrome/142.0.0.0 synthetic fixture'});
            globalThis.__cloudFixture={user:'a',clouds:{},auth:0,requests:0,uploads:0,google:null,googleVersion:0,fail:false,deny:false};
            chrome.identity.launchWebAuthFlow=(details,callback)=>{
                const s=globalThis.__cloudFixture;s.auth++;
                const url=new URL(details.url);
                if(url.searchParams.get('code_challenge_method')!=='S256'||url.searchParams.get('scope')!=='Files.ReadWrite.AppFolder User.Read')throw new Error('wrong OAuth contract');
                const result=`${url.searchParams.get('redirect_uri')}?state=${url.searchParams.get('state')}&${s.deny?'error=access_denied':'code=synthetic-code'}`;
                if(callback)callback(result);return Promise.resolve(result);
            };
            chrome.identity.getAuthToken=async()=>({token:'synthetic-google-token',grantedScopes:['https://www.googleapis.com/auth/drive.appdata']});
            chrome.identity.removeCachedAuthToken=async()=>undefined;chrome.identity.clearAllCachedAuthTokens=async()=>undefined;
            const original=globalThis.fetch.bind(globalThis);
            globalThis.fetch=async(input,init={})=>{
                const url=new URL(String(input)),s=globalThis.__cloudFixture;
                const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json'}});
                if(url.hostname==='login.microsoftonline.com')return json({access_token:`synthetic-ms-${s.user}`,token_type:'Bearer',expires_in:3600,scope:'Files.ReadWrite.AppFolder User.Read'});
                if(url.hostname==='graph.microsoft.com'||url.hostname==='fixture.files.1drv.com'){
                    s.requests++;
                    const cloud=s.clouds[s.user];const meta=()=>({id:'synthetic-file',eTag:String(cloud?.version??0),lastModifiedDateTime:'2026-10-03T00:00:00Z','@microsoft.graph.downloadUrl':`https://fixture.files.1drv.com/download/${s.user}`});
                    if(url.pathname==='/v1.0/me')return json({id:s.user,mail:`fixture-${s.user}@example.invalid`});
                    if(s.fail)return json({error:'synthetic failure'},503);
                    if(url.pathname.includes('/special/approot'))return json({id:'synthetic-folder'});
                    if(url.pathname.includes('createUploadSession'))return json({uploadUrl:`https://fixture.files.1drv.com/upload/${s.user}`});
                    if(url.pathname.startsWith('/download/'))return new Response(s.clouds[url.pathname.split('/').pop()].content);
                    if(url.pathname.startsWith('/upload/')){
                        if(init.method==='DELETE')return new Response(null,{status:204});
                        if(init.headers.Authorization)throw new Error('bearer leaked to signed URL');
                        const content=new TextDecoder().decode(init.body),envelope=JSON.parse(content);
                        if(envelope.format!=='fluentread-drive-encrypted'||!envelope.ciphertext)throw new Error('plaintext uploaded');
                        s.clouds[s.user]={content,version:(cloud?.version??0)+1};s.uploads++;
                        return json({...meta(),eTag:String(s.clouds[s.user].version)},201);
                    }
                    return cloud?json(meta()):json({},404);
                }
                if(url.hostname==='www.googleapis.com'){
                    s.requests++;const meta=()=>({id:'synthetic-google-file',version:String(s.googleVersion),modifiedTime:'2026-10-03T00:00:00Z'});
                    if(url.pathname==='/drive/v3/about')return json({user:{permissionId:'google:a',emailAddress:'google@example.invalid'}});
                    if(url.pathname.startsWith('/upload/')){
                        const body=String(init.body),marker='Content-Type: application/json\r\n\r\n',start=body.indexOf(marker)+marker.length;
                        s.google=body.slice(start,body.indexOf('\r\n--',start));s.googleVersion++;return json(meta());
                    }
                    if(url.pathname==='/drive/v3/files')return json({files:s.google?[meta()]:[]});
                    if(url.searchParams.get('alt')==='media')return new Response(s.google);
                    return json(meta());
                }
                return original(input,init);
            };
        });
        const page=await newPageWithoutForeground(context,30000);
        page.on('pageerror',error=>report.consoleErrors.push(error.message));
        const settings=`chrome-extension://${extensionId}/options.html#settings-data`;
        await page.goto(settings,{waitUntil:'domcontentloaded'});
        let sequence=0;
        async function patch(config){const result=await page.evaluate(async({config,sequence})=>{
            const preferences=(await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'})).value;
            const credentials=(await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:credentials'})).value;
            const current={...preferences,...credentials};
            return chrome.runtime.sendMessage({type:'persistConfig',mode:'replace',config:{...current,...config},clientId:'onedrive-ui-fixture',sequence});
        },{config,sequence:++sequence});check(result.success===true,'trusted config patch '+sequence+': '+(result.error??''));}
        await patch({uiLanguage:'zh-CN',uiLanguageSetupCompleted:true,theme:'light',token:{openai:'synthetic-service-key'},apiKeys:{openai:['synthetic-service-key']},customBody:{openai:'{"auth":"synthetic-body"}'},proxy:{openai:'https://fixture.invalid/?key=synthetic-url'}});await page.reload({waitUntil:'domcontentloaded'});
        await page.locator('button[data-section="settings-data"]').click();
        await page.getByTestId('cloud-method-onedrive').check();
        const card=page.getByTestId('onedrive-sync'),dialog=page.locator('.el-dialog').filter({has:page.getByTestId('onedrive-switch-account')});
        const begin=async()=>{await page.getByTestId('onedrive-sync-now').click();await dialog.waitFor({state:'visible'});};
        const finish=async()=>{await page.getByTestId('onedrive-confirm').click();await dialog.waitFor({state:'hidden'});};
        const shot=async name=>{for(const toast of await page.locator('.el-message').all())await toast.waitFor({state:'hidden'});await page.waitForTimeout(350);const output=path.join(artifactsDir,name+'.png');await page.screenshot({path:output});report.screenshots.push(output);};
        await page.getByTestId('onedrive-sync-now').waitFor();
        check(await worker.evaluate(()=>__cloudFixture.auth===0&&__cloudFixture.requests===0),'opening settings does not authorize or contact either cloud');
        check(await page.locator('[id="cloud-backup-title"]').count()===1&&await page.getByTestId('google-drive-sync').count()===0,'one cloud backup heading and only the selected provider are rendered');
        await begin();check(await worker.evaluate(()=>__cloudFixture.uploads===0),'preview performs no write');
        check((await dialog.innerText()).includes('fixture-a@example.invalid'),'preview identifies the selected Microsoft account');
        await shot('onedrive-first-save-desktop');await finish();
        await card.getByText('fixture-a@example.invalid',{exact:false}).waitFor();
        check(await worker.evaluate(()=>!__cloudFixture.clouds.a.content.includes('synthetic-ms-')),'Microsoft token is excluded from encrypted config');
        await patch({to:'fr',token:{},apiKeys:{},customBody:{},proxy:{}});await begin();
        if(await page.getByTestId('onedrive-back').count())await page.getByTestId('onedrive-back').click();
        check(await page.getByTestId('onedrive-continue').isDisabled(),'existing cloud requires explicit direction selection');
        await page.getByTestId('onedrive-direction-download').check();await page.getByTestId('onedrive-continue').click();
        check(!(await dialog.innerText()).includes('synthetic-service-key')&&!(await dialog.innerText()).includes('synthetic-body'),'preview never reveals service credentials');
        await shot('onedrive-restore-review-desktop');await finish();
        const restored=await page.evaluate(async()=>({
            ...(await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'})).value,
            ...(await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:credentials'})).value,
        }));
        check(JSON.stringify(restored).includes('synthetic-service-key')&&JSON.stringify(restored).includes('synthetic-body')&&JSON.stringify(restored).includes('synthetic-url'),'OneDrive restore preserves full service credentials through real storage');
        check((await page.evaluate(()=>chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'}))).value.to!=='fr','restore applies cloud settings through real configuration persistence');
        const original=await worker.evaluate(()=>__cloudFixture.clouds.a.content);
        await begin();await worker.evaluate(()=>{__cloudFixture.user='b';});await page.getByTestId('onedrive-switch-account').click();
        await dialog.getByText('fixture-b@example.invalid',{exact:false}).waitFor();
        await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'});
        check((await card.innerText()).includes('fixture-a@example.invalid'),'canceling a different account preserves the last successful account');
        check(await worker.evaluate(before=>__cloudFixture.clouds.a.content===before&&!__cloudFixture.clouds.b,original),'switch and cancel do not modify either account backup');
        const privateState=await page.evaluate(()=>chrome.runtime.sendMessage({type:'configStorageRead',key:'local:oneDriveEncryptedSyncState'}));
        check(privateState.success===false,'sync baseline is unavailable through the settings storage read proxy');
        await worker.evaluate(()=>{__cloudFixture.deny=true;});await page.getByTestId('onedrive-sync-now').click();
        await card.getByText('已取消微软账号授权',{exact:false}).waitFor();
        await worker.evaluate(()=>{__cloudFixture.deny=false;__cloudFixture.fail=true;});await page.getByTestId('onedrive-sync-now').click();
        await card.getByText('OneDrive 请求失败',{exact:false}).waitFor();
        await worker.evaluate(()=>{__cloudFixture.fail=false;__cloudFixture.user='a';});
        await page.getByTestId('cloud-method-google-drive').check();
        await page.getByTestId('google-drive-sync-now').click();const googleDialog=page.locator('.el-dialog').filter({has:page.getByTestId('google-drive-switch-account')});await googleDialog.waitFor({state:'visible'});await page.getByTestId('google-drive-confirm').click();await googleDialog.waitFor({state:'hidden'});
        await page.getByTestId('cloud-method-onedrive').check();await card.getByText('fixture-a@example.invalid',{exact:false}).waitFor();
        check((await card.innerText()).includes('fixture-a@example.invalid'),'Google sync does not change the OneDrive account record');
        const before=await worker.evaluate(()=>({requests:__cloudFixture.requests,auth:__cloudFixture.auth}));await page.reload({waitUntil:'domcontentloaded'});await page.getByTestId('onedrive-sync-now').waitFor();
        check(await worker.evaluate(v=>__cloudFixture.requests===v.requests&&__cloudFixture.auth===v.auth,before),'reopening settings does not reconnect to cloud');
        await shot('onedrive-idle-desktop');
        await patch({uiLanguage:'en-US',theme:'dark'});await page.reload({waitUntil:'domcontentloaded'});await card.getByTestId('onedrive-sync-now').waitFor();
        check(!/[\u3400-\u9fff]/u.test(await card.innerText()),'English card has no Chinese source copy');
        await page.setViewportSize({width:390,height:900});await activateExtensionTabWithoutForeground(context,page);
        check(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),'390px English dark settings have no horizontal overflow');
        await begin();check(!/[\u3400-\u9fff]/u.test(await dialog.innerText()),'English preview is fully localized');
        check(await dialog.getByRole('button',{name:'Cancel',exact:true}).isVisible(),'mobile preview keeps Cancel accessible');await shot('onedrive-english-dark-mobile');
        await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await dialog.waitFor({state:'hidden'});
        check(report.consoleErrors.length===0,'no options page errors');report.ok=true;
    } finally {
        if(launched)await launched.close();fs.writeFileSync(path.join(artifactsDir,'report.json'),JSON.stringify(report,null,2));fs.rmSync(profileDir,{recursive:true,force:true});
    }
    console.log(JSON.stringify(report,null,2));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
