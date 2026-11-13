#!/usr/bin/env node
'use strict';
/**
 * @file scripts/testing/run-google-image-context-test.cjs
 * 文件职责：通过生产图片 handler、broker 和 Google adapter 验证有序同图 HTML 的成功与回退路径。
 * 主要内容：所有 Google 请求在扩展后台显式改送自有 loopback 服务；检查标题隔离、重复短句位置、整组缓存、句末与缺项拒绝、关闭合批，并保存实际 HTTP 正文和诊断。
 * 模块边界：仅使用自有临时后台 Edge、合成文字和确定性响应，不读取凭据、不处理图片、不访问在线 Google；不将协议通过解释为真实翻译准确率。
 */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const allowed = new Set(['extension-dir','playwright-root','focus-safe-helper','runtime-diagnostics-helper','artifacts-dir']);
if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/testing/run-google-image-context-test.cjs --extension-dir PATH --playwright-root PATH --focus-safe-helper PATH --runtime-diagnostics-helper PATH --artifacts-dir PATH');
    process.exit(0);
}
const args = {};
for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index].replace(/^--/u, ''), value = process.argv[index + 1];
    assert.ok(allowed.has(key) && value && !value.startsWith('--'), `Invalid argument ${process.argv[index]}`);
    args[key] = path.resolve(value);
}
for (const key of allowed) assert.ok(args[key], `Missing --${key}`);
const extension = args['extension-dir'], artifacts = args['artifacts-dir'];
const {chromium} = require(path.join(args['playwright-root'], 'playwright'));
const {launchFocusSafePersistentContext,newPageWithoutForeground} = require(args['focus-safe-helper']);
const diagnostics = require(args['runtime-diagnostics-helper']).createRuntimeDiagnostics();
fs.mkdirSync(artifacts, {recursive:true});
const temporaryRoot = fs.realpathSync(os.tmpdir()), profile = fs.mkdtempSync(path.join(temporaryRoot, 'fluentread-google-image-context-'));
const profileIdentity = fs.lstatSync(profile), owner = crypto.randomUUID();
fs.writeFileSync(path.join(profile, '.owner'), owner, {flag:'wx'});
const sources = ['ROUTE MAP','TURN TOWARD THE EAST.','RIGHT.','LATER AT THE QUIZ','IS YOUR ANSWER CORRECT?','RIGHT.'];
const report = {scope:'production image handler, broker and Google adapter with all translation HTTP redirected to owned loopback; no live Google or semantic-quality claim',cases:[],requests:[],cleanupErrors:[]};
let phase = 'startup', corruption = '', launched, worker;
const decode = value => value.replace(/&(amp|lt|gt|quot|#39);/gu, (_, key) => ({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"})[key]);
const translated = (source, document = '') => source === 'RIGHT.' ? document.includes('TURN TOWARD') ? '向右。' : document.includes('CORRECT?') ? '没错。' : '普通短句。'
    : source === 'IS YOUR ANSWER CORRECT?' ? '你的答案正确吗？' : source.endsWith('.') ? '这是一句说明。' : '独立标题';
const server = http.createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*'); response.setHeader('Access-Control-Allow-Headers', '*');
    if (request.method === 'OPTIONS') {response.writeHead(204); response.end(); return;}
    if (request.method !== 'POST' || request.url !== '/google-html') {response.writeHead(404); response.end(); return;}
    try {
        assert.ok(['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress));
        let bytes = 0; const chunks = [];
        for await (const chunk of request) {bytes += chunk.length; assert.ok(bytes <= 100000); chunks.push(chunk);}
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')), documents = body[0][0];
        assert.ok(Array.isArray(documents) && documents.length > 0 && documents.every(value => typeof value === 'string'));
        const contextual = documents.some(value => value.includes('data-fr-slot='));
        const record = {phase, contextual, documents, sourceLanguage:body[0][1], targetLanguage:body[0][2], corruption:contextual ? corruption : '', completed:false};
        report.requests.push(record);
        const outputs = documents.map(document => contextual
            ? document.replace(/(<span data-fr-slot="\d+">)([^<>]*)(<\/span>)/gu, (_, start, text, end) => start + translated(decode(text), document) + end)
            : `<pre>${translated(decode(document.replace(/^<pre>([\s\S]*)<\/pre>$/u, '$1')))}</pre>`);
        if (contextual && corruption === 'boundary') outputs[1] = outputs[1].replace('。', '，');
        if (contextual && corruption === 'missing') outputs[1] = outputs[1].replace(/<span data-fr-slot="\d+">[^<>]*<\/span>/u, '');
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify([outputs])); record.completed = true;
    } catch (error) {
        report.requests.push({phase,error:String(error)});
        response.writeHead(400, {'Content-Type':'application/json'}); response.end(JSON.stringify({error:String(error)}));
    }
});
const files = [];
function collect(directory) {
    for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) collect(file); else if (file.endsWith('.js')) files.push(file);
    }
}
collect(extension); const hash = crypto.createHash('sha256');
for (const file of files.sort()) hash.update(path.relative(extension, file)).update('\0').update(fs.readFileSync(file));
report.javascriptAssetsSha256 = hash.digest('hex');
(async () => {
    await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
    const endpoint = `http://127.0.0.1:${server.address().port}/google-html`;
    launched = await launchFocusSafePersistentContext({chromium,profileDir:profile,
        browserPath:'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',headless:false,background:true,
        viewport:{width:1280,height:900},browserArgs:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--no-first-run','--no-default-browser-check']});
    Object.assign(report, {launchMode:launched.launchMode,focusPolicy:launched.focusPolicy,windowPlacement:launched.windowPlacement});
    const context = launched.context; await diagnostics.start(context);
    worker = context.serviceWorkers().find(item => item.url().startsWith('chrome-extension://')) || await context.waitForEvent('serviceworker', {timeout:30000});
    const id = new URL(worker.url()).host; diagnostics.setExtensionId(id);
    await worker.evaluate(endpoint => {
        const original = globalThis.fetch.bind(globalThis), redirects = [];
        globalThis.__googleImageContextFixture = {redirects};
        globalThis.fetch = (input, options) => {
            const url = new URL(typeof input === 'string' ? input : input.url || input);
            if (/^translate(?:-pa)?\.google(?:apis)?\./u.test(url.hostname)) {
                if (url.hostname !== 'translate-pa.googleapis.com' || url.pathname !== '/v1/translateHtml') {
                    throw new Error('Unexpected Google endpoint in loopback-only fixture');
                }
                redirects.push({from:url.href,to:endpoint});
                return original(endpoint, {method:'POST',headers:{'Content-Type':'application/json'},body:options.body,signal:options.signal});
            }
            if (url.protocol === 'http:' || url.protocol === 'https:') throw new Error('Unexpected external network request in loopback-only fixture');
            return original(input, options);
        };
    }, endpoint);
    const popup = context.pages()[0] || await newPageWithoutForeground(context); await diagnostics.attachPage(popup, 'google-image-context-control');
    await popup.goto(`chrome-extension://${id}/popup.html`);
    let sequence = 0;
    const patch = values => popup.evaluate(async ({values,sequence}) => {
        const read = await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'});
        if (!read.success) throw new Error(read.error);
        const result = await chrome.runtime.sendMessage({type:'persistConfig',mode:'patch',config:values,
            expected:Object.fromEntries(Object.keys(values).map(key => [key,read.value[key]])),clientId:'google-image-context-fixture',sequence,baseRevision:read.value.__fluentConfigRevision || 0});
        if (!result.success) throw new Error(result.error);
    }, {values,sequence:++sequence});
    await patch({on:true,uiLanguage:'zh-CN',uiLanguageSetupCompleted:true,service:'google',imageTranslationService:'google',
        from:'en',to:'zh-Hans',useCache:true,nativeBatchTranslationEnabled:{google:true},translationMaxRetries:0});
    const translate = async (name, texts = sources) => {
        phase = name; diagnostics.setPhase(name); const before = report.requests.length;
        const result = await popup.evaluate(({name,texts}) => chrome.runtime.sendMessage({type:'fluentReadImageTranslateTexts',texts,requestId:`google-image-${name}`,timeoutMs:30000}), {name,texts});
        assert.equal(result.success, true, JSON.stringify(result));
        return {result,requests:report.requests.slice(before)};
    };
    const first = await translate('context-success');
    assert.equal(first.requests.length, 1); assert.equal(first.requests[0].contextual, true);
    assert.deepEqual(first.requests[0].documents.map(value => value.startsWith('<pre>')), [true,false,true,false]);
    assert.equal(first.result.translations[2], '向右。'); assert.equal(first.result.translations[5], '没错。');
    report.cases.push('Complete sentence groups preserve distinct repeated slots and isolated headings through the production Google path');
    const cached = await translate('context-cache'); assert.equal(cached.requests.length, 0); assert.deepEqual(cached.result.translations, first.result.translations);
    report.cases.push('An identical ordered image batch reuses the completed cache');
    const changed = await translate('changed-neighbor', [sources[0],'TURN TOWARD THE WEST.',...sources.slice(2)]);
    assert.equal(changed.requests.length, 1); assert.equal(changed.requests[0].contextual, true);
    assert.equal(changed.requests[0].documents.join('').match(/data-fr-slot=/gu).length, sources.length);
    report.cases.push('Changing a neighbor recomputes the complete ordered group instead of stitching partial context caches');
    await patch({useCache:false});
    for (const kind of ['boundary','missing']) {
        corruption = kind; const fallback = await translate(`reject-${kind}`);
        assert.deepEqual(fallback.requests.map(row => row.contextual), [true,false]);
        assert.equal(fallback.result.translations[2], '普通短句。'); assert.equal(fallback.result.translations[5], '普通短句。');
        report.cases.push(`Invalid ${kind} response retries independent pre slots through the same HTML engine`);
    }
    corruption = ''; await patch({nativeBatchTranslationEnabled:{google:false}});
    const disabled = await translate('native-batching-disabled');
    assert.ok(disabled.requests.length > 0 && disabled.requests.every(row => !row.contextual));
    assert.equal(disabled.result.translations[2], '普通短句。'); assert.equal(disabled.result.translations[5], '普通短句。');
    report.cases.push('Disabling native batching prevents contextual HTML and preserves ordinary translation');
    report.redirects = await worker.evaluate(() => globalThis.__googleImageContextFixture.redirects);
    assert.equal(report.redirects.length, report.requests.length); assert.ok(report.requests.every(row => row.completed && !row.error));
    report.success = true;
})().catch(error => {report.success = false; report.failure = String(error.stack || error); process.exitCode = 1;})
.finally(async () => {
    if (launched) {
        try {if (worker) report.redirects = await worker.evaluate(() => globalThis.__googleImageContextFixture?.redirects || []);}
        catch (error) {report.cleanupErrors.push(`transport evidence: ${error}`);}
        try {await diagnostics.flush(); report.runtimeDiagnostics = diagnostics.snapshot(); if (!report.runtimeDiagnostics.passed) {report.success = false; process.exitCode = 1;}}
        catch (error) {report.cleanupErrors.push(`diagnostics: ${error}`);}
        await diagnostics.stop().catch(error => report.cleanupErrors.push(`diagnostic detach: ${error}`));
        try {
            await launched.close(); const current = fs.lstatSync(profile);
            assert.ok(current.isDirectory() && !current.isSymbolicLink()); assert.equal(path.dirname(profile), temporaryRoot);
            assert.equal(current.dev, profileIdentity.dev); assert.equal(current.ino, profileIdentity.ino); assert.equal(fs.readFileSync(path.join(profile, '.owner'), 'utf8'), owner);
            fs.rmSync(profile, {recursive:true}); report.profileRemoved = true;
        } catch (error) {report.cleanupErrors.push(`owned browser/profile cleanup: ${error}`); report.retainedProfile = profile;}
    } else report.retainedProfile = profile;
    await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
    if (report.cleanupErrors.length) {report.success = false; process.exitCode = 1;}
    fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({success:report.success,cases:report.cases.length,requests:report.requests.length,
        diagnostics:report.runtimeDiagnostics?.counts,profileRemoved:report.profileRemoved,failure:report.failure,
        cleanupErrors:report.cleanupErrors,report:path.join(artifacts, 'report.json')}));
});
