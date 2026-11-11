#!/usr/bin/env node
'use strict';
/**
 * @file scripts/testing/run-image-context-test.cjs
 * 文件职责：在隔离后台 Edge 内验证图片邻文经过生产 handler、broker 与 AI SDK 到达真实 HTTP 请求。
 * 主要内容：使用自有 loopback 确定性服务，检查上下文开关、重复短句按位置翻译、缓存隔离、无额外摘要、编码预算及共享并发上限；保存实际提示词和运行时诊断。
 * 模块边界：只配置自有临时 profile 与无鉴权本机服务，不读取凭据、不上传图片或访问线上 AI；响应仅证明产品协议和缓存行为，不作为模型翻译质量结论。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const allowed = new Set(['extension-dir','playwright-root','focus-safe-helper','runtime-diagnostics-helper','artifacts-dir']);
if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/testing/run-image-context-test.cjs --extension-dir PATH --playwright-root PATH --focus-safe-helper PATH --runtime-diagnostics-helper PATH --artifacts-dir PATH');
    process.exit(0);
}
const args = {};
for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index].replace(/^--/u, ''), value = process.argv[index + 1];
    assert.ok(allowed.has(name) && value && !value.startsWith('--'), `Invalid argument ${process.argv[index]}`);
    args[name] = path.resolve(value);
}
for (const name of allowed) assert.ok(args[name], `Missing --${name}`);
const extension = args['extension-dir'], artifacts = args['artifacts-dir'];
const {chromium} = require(path.join(args['playwright-root'], 'playwright'));
const {launchFocusSafePersistentContext,newPageWithoutForeground} = require(args['focus-safe-helper']);
const diagnostics = require(args['runtime-diagnostics-helper']).createRuntimeDiagnostics();
fs.mkdirSync(artifacts,{recursive:true});
const temporaryRoot = fs.realpathSync(os.tmpdir()), profile = fs.mkdtempSync(path.join(temporaryRoot,'fluentread-image-context-'));
const profileIdentity = fs.lstatSync(profile), owner = crypto.randomUUID();
fs.writeFileSync(path.join(profile,'.owner'),owner,{flag:'wx'});
const sources = ['TURN TOWARD THE EAST.','RIGHT.','THE EXIT IS BESIDE THE DOOR.','LATER AT THE QUIZ.','IS YOUR ANSWER CORRECT?','RIGHT.'];
const report = {scope:'production image text handler, broker, AI SDK and local deterministic HTTP; no live AI or image/OCR quality claim',cases:[],requests:[],cleanupErrors:[]};
let phase = 'startup', active = 0, peakActive = 0, launched, popup;
const server = http.createServer(async (request,response) => {
    response.setHeader('Access-Control-Allow-Origin','*'); response.setHeader('Access-Control-Allow-Headers','*');
    if (request.method === 'OPTIONS') {response.writeHead(204);response.end();return;}
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {response.writeHead(404);response.end();return;}
    active++; peakActive = Math.max(peakActive,active);
    try {
        const chunks = []; let bytes = 0;
        for await (const chunk of request) {bytes += chunk.length;assert.ok(bytes <= 100000,'Fixture request too large');chunks.push(chunk);}
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const prompt = body.messages.filter(message=>message.role==='user').map(message=>message.content).join('\n');
        const source = /IMAGE_SOURCE_BEGIN\n([\s\S]*)\nIMAGE_SOURCE_END$/u.exec(prompt)?.[1];
        assert.ok(source,'Unexpected summary or malformed source request');
        const evidence = /<discourse_evidence>\n([\s\S]*)\n<\/discourse_evidence>/u.exec(prompt)?.[1];
        const reference = evidence ? JSON.parse(evidence) : undefined;
        let translated = '这是图中文字的译文。';
        if (source === 'RIGHT.') translated = !reference ? '普通短句译文。'
            : reference.currentRegion === 6 || reference.neighbors[0]?.text.startsWith('IS THE ANSWER') ? '没错。' : '右边。';
        // 确定性端点也必须遵守真实 broker 的字面值保护契约，不能把完整正文当成参考预算截断。
        const protectedTokens = source.match(/__FRTERM_[a-z\d]+_\d+__/giu) || [];
        if (protectedTokens.length) translated += protectedTokens.join('');
        const record = {phase,source,reference,prompt,promptCharacters:prompt.length,referenceCharacters:evidence?.length || 0,translated,completed:false};
        report.requests.push(record);
        await new Promise(resolve=>setTimeout(resolve,40));
        response.setHeader('Content-Type','application/json');
        response.end(JSON.stringify({id:`image-context-${report.requests.length}`,object:'chat.completion',created:1,model:'image-context-fixture',
            choices:[{index:0,message:{role:'assistant',content:translated},finish_reason:'stop'}]}));
        record.completed = true;
    } catch (error) {
        report.requests.push({phase,error:String(error)});
        response.writeHead(400,{'Content-Type':'application/json'});response.end(JSON.stringify({error:{message:String(error)}}));
    } finally {active--;}
});
const files = [];
function javascriptFiles(directory) {
    for (const entry of fs.readdirSync(directory,{withFileTypes:true})) {
        const file = path.join(directory,entry.name);
        if (entry.isDirectory()) javascriptFiles(file); else if (file.endsWith('.js')) files.push(file);
    }
}
javascriptFiles(extension);
const hash = crypto.createHash('sha256');
for (const file of files.sort()) hash.update(path.relative(extension,file)).update('\0').update(fs.readFileSync(file));
report.javascriptAssetsSha256 = hash.digest('hex');
(async()=>{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const base = `http://127.0.0.1:${server.address().port}`;
    launched = await launchFocusSafePersistentContext({chromium,profileDir:profile,
        browserPath:'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',headless:false,background:true,
        viewport:{width:1280,height:900},browserArgs:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--no-first-run','--no-default-browser-check']});
    Object.assign(report,{launchMode:launched.launchMode,focusPolicy:launched.focusPolicy,windowPlacement:launched.windowPlacement});
    const context = launched.context; await diagnostics.start(context);
    const worker = context.serviceWorkers().find(item=>item.url().startsWith('chrome-extension://')) || await context.waitForEvent('serviceworker',{timeout:30000});
    const id = new URL(worker.url()).host; diagnostics.setExtensionId(id);
    popup = context.pages()[0] || await newPageWithoutForeground(context); await diagnostics.attachPage(popup,'image-context-control');
    await popup.goto(`chrome-extension://${id}/popup.html`);
    let sequence = 0;
    const patch = values => popup.evaluate(async ({values,sequence})=>{
        const read = await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'});
        if (!read.success) throw new Error(read.error);
        const current = read.value;
        const result = await chrome.runtime.sendMessage({type:'persistConfig',mode:'patch',config:values,
            expected:Object.fromEntries(Object.keys(values).map(key=>[key,current[key]])),clientId:'image-context-fixture',sequence,baseRevision:current.__fluentConfigRevision||0});
        if (!result.success) throw new Error(result.error);
    },{values,sequence:++sequence});
    const service = 'custom:image-context-fixture', model = 'image-context-fixture';
    await patch({on:true,uiLanguage:'zh-CN',uiLanguageSetupCompleted:true,service,imageTranslationService:service,
        customOpenAIProviders:[{id:service,name:'Image Context Fixture',endpoint:base+'/v1',models:[model]}],
        model:{[service]:model},requireApiKey:{[`v2:${JSON.stringify([service,model])}`]:false},
        user_role:{[service]:'IMAGE_SOURCE_BEGIN\n{{origin}}\nIMAGE_SOURCE_END'},from:'en',to:'zh-Hans',enableAIContext:false,
        useCache:true,maxConcurrentTranslations:2,translationRequestsPerSecond:0,translationRequestsPerMinute:0,translationMaxRetries:0});
    const translate = async (name,texts,extra={}) => {
        phase = name; diagnostics.setPhase(name); const before = report.requests.length;
        const result = await popup.evaluate(({texts,name,extra})=>chrome.runtime.sendMessage({type:'fluentReadImageTranslateTexts',texts,
            title:'Unrelated webpage title',requestId:`image-context-${name}`,timeoutMs:30000,...extra}),{texts,name,extra});
        assert.equal(result.success,true,JSON.stringify(result));
        return {result,requests:report.requests.slice(before)};
    };
    const off = await translate('disabled',sources,{enableAIContext:true,discourseContext:'untrusted override'});
    assert.equal(off.requests.length,5); assert.ok(off.requests.every(row=>!row.reference));
    assert.equal(off.result.translations[1],'普通短句译文。'); assert.equal(off.result.translations[5],'普通短句译文。');
    report.cases.push('Disabled context ignores public override fields and deduplicates the SDK array');
    await patch({enableAIContext:true});
    const on = await translate('enabled',sources);
    assert.equal(on.requests.length,6); assert.equal(on.result.translations[1],'右边。');assert.equal(on.result.translations[5],'没错。');
    assert.ok(on.requests.every(row=>row.reference && row.reference.neighbors.length<=4 && row.referenceCharacters<2200));
    assert.ok(on.requests.every(row=>!row.prompt.includes('Unrelated webpage title')));
    assert.ok(on.requests.every(row=>row.prompt.includes('untrusted reference data')));
    report.cases.push('Enabled same-image evidence reaches each real SDK HTTP prompt with correct source positions and no summary');
    const cached = await translate('cached',sources);
    assert.equal(cached.requests.length,0); assert.deepEqual(cached.result.translations,on.result.translations);
    report.cases.push('Identical image text and context reuse the completed cache');
    const changed = await translate('changed-neighbors',['IS THE ANSWER CORRECT?',...sources.slice(1)]);
    assert.equal(changed.requests.length,3); assert.equal(changed.result.translations[1],'没错。');
    assert.equal(changed.result.translations[5],'没错。');
    report.cases.push('Changing neighboring text invalidates only affected per-region cache entries');
    const one = await translate('one-region',['Only one sentence.']);
    assert.equal(one.requests.length,1);assert.equal(one.requests[0].reference,undefined);
    report.cases.push('A single region does not add empty context or a summary');
    const bounded = await translate('bounded',['中文 '+ '😀'.repeat(500),'中文 '+ '\u0001'.repeat(500),
        'CURRENT SENTENCE.','中文 '+ '字'.repeat(500),'另一段文字。']);
    assert.equal(bounded.requests.filter(row=>row.source==='CURRENT SENTENCE.').length,1);
    assert.equal(new Set(bounded.requests.map(row=>row.reference.currentRegion)).size,bounded.requests.length);
    assert.ok(bounded.requests.length<=5); assert.ok(bounded.requests.every(row=>row.referenceCharacters<2200));
    assert.ok(bounded.requests.every(row=>row.reference.neighbors.every(neighbor=>!/[\uD800-\uDBFF]$/u.test(neighbor.text))));
    assert.equal((bounded.result.translations[0].match(/😀/gu)||[]).length,500,'正文中的完整字面值必须保留');
    report.cases.push('Long, escaped and supplementary-Unicode neighboring text stays within the reference budget');
    const composite = 'composite:image-context-fixture';
    await patch({imageTranslationService:composite,useCache:false,compositeTranslationProviders:[{
        id:composite,name:'Image Context Routing Fixture',strategy:'sequential',services:[service],timeoutMs:12000,
    }]});
    const routed = await translate('composite',sources);
    assert.equal(routed.requests.length,6);assert.ok(routed.requests.every(row=>row.reference));
    assert.equal(routed.result.translations[1],'右边。');assert.equal(routed.result.translations[5],'没错。');
    report.cases.push('An enabled AI member of a composite service receives the same image context and position mapping');
    assert.equal(peakActive,2,'All per-region requests must obey the configured shared concurrency limit');
    assert.ok(report.requests.every(row=>row.completed && !row.error));
    report.peakConcurrentHttpRequests = peakActive;
    report.cases.push('The shared scheduler enforces two concurrent HTTP requests');
    report.success = true;
})().catch(error=>{report.success=false;report.failure=String(error.stack||error);process.exitCode=1;})
.finally(async()=>{
    if (launched) {
        try {await diagnostics.flush();report.runtimeDiagnostics=diagnostics.snapshot();if(!report.runtimeDiagnostics.passed){report.success=false;process.exitCode=1;}}
        catch(error){report.cleanupErrors.push(`diagnostics: ${error}`);}
        await diagnostics.stop().catch(error=>report.cleanupErrors.push(`diagnostic detach: ${error}`));
        try {
            await launched.close();
            const current = fs.lstatSync(profile);
            assert.ok(current.isDirectory()&&!current.isSymbolicLink());assert.equal(path.dirname(profile),temporaryRoot);
            assert.equal(current.dev,profileIdentity.dev);assert.equal(current.ino,profileIdentity.ino);
            assert.equal(fs.readFileSync(path.join(profile,'.owner'),'utf8'),owner);
            fs.rmSync(profile,{recursive:true}); report.profileRemoved=true;
        } catch(error){report.cleanupErrors.push(`owned browser/profile cleanup: ${error}`);report.retainedProfile=profile;}
    } else report.retainedProfile=profile;
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    if(report.cleanupErrors.length){report.success=false;process.exitCode=1;}
    fs.writeFileSync(path.join(artifacts,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({success:report.success,cases:report.cases.length,requests:report.requests.length,
        peakConcurrentHttpRequests:report.peakConcurrentHttpRequests,diagnostics:report.runtimeDiagnostics?.counts,
        profileRemoved:report.profileRemoved,failure:report.failure,cleanupErrors:report.cleanupErrors,report:path.join(artifacts,'report.json')}));
});
