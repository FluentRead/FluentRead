#!/usr/bin/env node
// 使用隔离真实 Edge 验证收藏学习、原句请求、造句反馈、取消隔离和窄屏布局。
// HTTP fixture 只代替模型响应；配置、存储、端口、Harness 和组件使用生产产物。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {createRequire} = require('node:module');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifacts = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-vocabulary-study'));
const playwrightRoot = arg('playwright-root');
const helperPath = arg('focus-safe-helper');
if (!playwrightRoot || !helperPath) throw new Error('需要 --playwright-root 和 --focus-safe-helper');
const {chromium} = createRequire(path.join(path.resolve(playwrightRoot), 'loader.cjs'))('playwright');
const helper = require(path.resolve(helperPath));
const assert = (value, message) => { if (!value) throw new Error(message); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, message) { for (let i = 0; i < 150; i++) { if (await predicate()) return; await delay(80); } throw new Error(message); }
async function send(page, request) { return page.evaluate(request => chrome.runtime.sendMessage(request), request); }
const parse = value => typeof value === 'string' ? JSON.parse(value) : value || {};
async function readConfig(page) {
  const config = await send(page, {type:'configStorageRead', key:'local:config'});
  const credentials = await send(page, {type:'configStorageRead', key:'local:credentials'});
  return {...parse(config.value), ...parse(credentials.value)};
}
async function persist(page, patch) {
  const current = await readConfig(page);
  const result = await send(page, {type:'persistConfig', config:{...current,...patch}, clientId:`vocabulary-study-${process.pid}`, sequence:Date.now(), baseRevision:current.__fluentConfigRevision});
  assert(result.success, '配置未保存'); await delay(300);
}
async function main() {
  fs.mkdirSync(artifacts,{recursive:true});
  const profile = fs.mkdtempSync(path.join(os.tmpdir(),'fluentread-study-profile-'));
  const requests = [];
  let slow = false, failNext = false;
  const server = http.createServer(async (req,res) => {
    if (req.method !== 'POST') {res.writeHead(404).end();return;}
    const chunks=[]; for await (const chunk of req) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    if (failNext) { failNext=false;res.writeHead(503,{'content-type':'application/json'}).end(JSON.stringify({error:{message:'fixture service unavailable'}}));return; }
    const delayed = slow;
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
    const event = delta => { if (!res.destroyed) res.write(`data: ${JSON.stringify({id:'study-fixture',choices:[{index:0,...delta}]})}\n\n`); };
    if (body.tools?.length && !body.messages.some(message=>message.role==='tool')) {
      event({delta:{role:'assistant',tool_calls:[{index:0,id:'context-1',type:'function',function:{name:'read_context',arguments:'{}'}}]},finish_reason:null});
      event({delta:{},finish_reason:'tool_calls'});
    } else {
      const raw = JSON.stringify(body.messages);
      const text = delayed ? '迟到的旧词讲解' : raw.includes('用户正在尝试使用这个表达')
        ? '### 表达反馈\n你的句子用法自然。**on time** 表示按预定时间到达，不需要强行修改。'
        : raw.includes('bank') ? '### 这里怎么理解\nbank 在这句中指河岸。\n### 怎样使用\non the river bank。'
        : '### 这里怎么理解\n**on time** 表示按约定时间，原句中的 arrived 说明到达准时。\n### 怎样使用\narrive on time：准时到达。\n### 自拟例句\nThe train left on time.\n火车准时发车。';
      if (delayed) await delay(1400);
      event({delta:{role:'assistant',content:text},finish_reason:null});
      event({delta:{},finish_reason:'stop'});
    }
    if (!res.destroyed) {res.write('data: [DONE]\n\n');res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const report={ok:false,extensionDir,modelEvidence:'local HTTP fixture; no live model quality claim',cases:[],screenshots:[],consoleErrors:[]};
  let session;
  try {
    session=await helper.launchFocusSafePersistentContext({chromium,profileDir:profile,browserPath:'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',headless:false,background:true,browserArgs:[`--disable-extensions-except=${extensionDir}`,`--load-extension=${extensionDir}`,'--no-first-run','--no-default-browser-check','--mute-audio'],viewport:{width:1440,height:1000}});
    Object.assign(report,{launchMode:session.launchMode,focusPolicy:session.focusPolicy,windowPlacement:session.windowPlacement});
    const context=session.context;
    const worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id=worker.url().match(/^chrome-extension:\/\/([^/]+)/)[1];
    const page=await helper.newPageWithoutForeground(context);
    page.on('pageerror',error=>report.consoleErrors.push(error.message));
    const url=`chrome-extension://${id}/options.html`;
    await page.goto(`${url}#settings-harness`); await page.locator('#settings-harness').waitFor();
    await persist(page,{on:true,to:'zh-CN',vocabularyBookEnabled:true,customOpenAIProviders:[{id:'custom:study-fixture',name:'Study fixture',endpoint:`http://127.0.0.1:${server.address().port}/v1/chat/completions`,models:['study-fixture']}],token:{'custom:study-fixture':'fixture-only'},harness:{...(await readConfig(page)).harness,enabled:true,service:'custom:study-fixture',model:'study-fixture',contextMode:'paragraph',memoryEnabled:false}});
    const seeded=[];
    for (const [term,translation,text] of [['on time','### 原来的用法分析\n**on time**：按时。\n'.repeat(10),'We arrived on time.'],['bank','河岸','We sat on the river bank.'],['resilient','有韧性的','resilient']]) {
      const response=await send(page,{type:'fluentReadVocabularyBook',action:'upsert',input:{term,translation,sourceLanguage:'en',targetLanguage:'zh-CN',context:{text,sourceUrl:'https://example.com/article',pageTitle:'我的阅读原句'}}});
      assert(response.success,'收藏 fixture 失败');seeded.push(response.data);
    }
    const shot=async name=>{const output=path.join(artifacts,`${name}.png`);await page.screenshot({path:output});report.screenshots.push(output);};
    const record=id=>report.cases.push({id,status:'passed'});
    const open=async term=>{await page.locator('.word-row').filter({has:page.getByRole('heading',{name:term,exact:true})}).getByRole('button',{name:'学习用法',exact:true}).click();await page.locator('.word-study').waitFor();};
    const back=async()=>{await page.getByRole('button',{name:'‹ 返回收藏',exact:true}).click();await page.locator('.word-list').waitFor();};
    const finish=async()=>{await waitFor(async()=>await page.locator('.study-status').count()===0,'学习请求未结束');};
    await page.goto(`${url}#settings-vocabulary`);await page.locator('.word-row').first().waitFor();
    await shot('learning-library');
    await open('on time');assert(requests.length===0,'浏览收藏自动调用了模型');
    assert(await page.locator('.study-source blockquote').innerText()==='We arrived on time.','没有显示真实原句');
    await page.getByRole('button',{name:'理解这个表达',exact:true}).click();await finish();
    assert((await page.locator('.study-step').first().innerText()).includes('准时到达'),'讲解未呈现');
    assert(requests.some(body=>body.messages.some(message=>message.role==='tool' && JSON.stringify(message).includes('We arrived on time.'))),'原句未通过 Harness 段落工具传入');
    assert(!JSON.stringify(requests).includes('https://example.com'),'来源网址被发送到模型');
    record('explicit-context-grounded-understanding');
    await page.getByRole('textbox',{name:'我的造句'}).fill('I arrived on time for our meeting.');
    await page.getByRole('button',{name:'看看用得是否自然',exact:true}).click();await finish();
    assert((await page.locator('.study-feedback').innerText()).includes('用法自然'),'造句反馈未呈现');
    assert(JSON.stringify(requests.at(-1)).includes('I arrived on time for our meeting.'),'造句未传入模型');
    const saved=await send(page,{type:'fluentReadVocabularyBook',action:'list'});
    assert(saved.data.every(entry=>entry.reviewCount===0),'AI 擅自更新了复习状态');record('writing-feedback-without-mastery-mutation');
    const buttonColors = await page.locator('.study-primary').first().evaluate(element => {const style=getComputedStyle(element);return {color:style.color,background:style.backgroundColor};});
    assert(buttonColors.background !== 'rgba(0, 0, 0, 0)' && buttonColors.background !== buttonColors.color,'学习按钮对比度不可读');
    const sessions = await send(page,{type:'fluentReadHarness',action:'sessions-list',offset:0});
    const conversation = await send(page,{type:'fluentReadHarness',action:'sessions-get',sessionId:sessions.sessions[0].id});
    assert(conversation.session.turns.every(turn=>!turn.question.includes('不另选词')),'内部提示词出现在阅读记录');
    record('readable-history-and-action-buttons');
    await shot('learning-study-desktop');
    await page.setViewportSize({width:390,height:844});
    await page.locator('.study-feedback').scrollIntoViewIfNeeded();
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'学习页窄屏溢出');await shot('learning-study-mobile');
    await persist(page,{theme:'dark'});await shot('learning-study-dark');await persist(page,{theme:'light'});
    await page.setViewportSize({width:1440,height:1000});record('desktop-mobile-dark-layout');
    const staleBefore=requests.length;slow=true;await page.getByRole('button',{name:'重新讲解',exact:true}).click();
    await waitFor(()=>requests.length>staleBefore,'没有发起讲解');
    await back();slow=false;await open('bank');await page.getByRole('button',{name:'理解这个表达',exact:true}).click();await finish();await delay(1600);
    assert((await page.locator('.word-study').innerText()).includes('河岸') && !(await page.locator('.word-study').innerText()).includes('迟到的旧词'),'旧请求污染新词');record('switch-cancels-stale-answer');
    failNext=true;await page.getByRole('button',{name:'重新讲解',exact:true}).click();await page.locator('.study-error').waitFor();
    await page.locator('.study-error').getByRole('button',{name:'重试',exact:true}).click();await finish();assert(await page.locator('.study-error').count()===0,'重试后错误未清除');record('model-failure-retry');
    const original = await readConfig(page);
    await persist(page,{harness:{...original.harness,contextMode:'selection'}});
    const selectionBefore=requests.length;
    await page.getByRole('button',{name:'重新讲解',exact:true}).click();await finish();
    const selectionRequests=requests.slice(selectionBefore);
    assert(selectionRequests.length>0 && selectionRequests.every(body=>!body.tools?.length),'仅选区模式仍提供原句工具');
    assert(!JSON.stringify(selectionRequests).includes('We sat on the river bank.'),'仅选区模式上传了原句');
    record('honors-context-preference');
    await persist(page,{harness:{...original.harness,enabled:false}});
    const disabledBefore=requests.length;
    await page.getByRole('button',{name:'重新讲解',exact:true}).click();
    await page.locator('#settings-harness').waitFor();assert(requests.length===disabledBefore,'关闭翻译卡片仍发起请求');
    await persist(page,{harness:original.harness});
    await page.goto(`${url}#settings-vocabulary`);await page.locator('.word-list').waitFor();record('disabled-feature-opens-settings-without-request');
    await open('resilient');assert((await page.locator('.study-source').innerText()).includes('没有可用的原句'),'单独一个词被当成原句');await back();
    await page.getByRole('button',{name:/开始复习/}).click();
    const all=await send(page,{type:'fluentReadVocabularyBook',action:'list'});
    const before=all.data.reduce((sum,entry)=>sum+entry.reviewCount,0);
    assert(await page.locator('.review-actions').count()===0,'揭晓前可评分');
    await page.getByRole('textbox',{name:'我的回忆'}).fill('按时；arrive on time');
    await page.getByRole('button',{name:/显示答案/}).click();
    assert((await page.locator('.recall-attempt').innerText()).includes('arrive on time'),'没有保留主动回忆');
    await page.locator('.review-actions .good').click();
    await waitFor(async()=>{const next=await send(page,{type:'fluentReadVocabularyBook',action:'list'});return next.data.reduce((sum,entry)=>sum+entry.reviewCount,0)===before+1;},'复习没有持久化');
    await shot('learning-review');record('recall-reveal-persist-rating');
    await page.goto(`${url}#settings-harness`);await page.getByRole('heading',{name:'翻译卡片',exact:true}).waitFor();
    const group=page.locator('.nav-group').filter({has:page.locator('.nav-group-label',{hasText:'专项翻译'})});assert(await group.locator('[data-section="settings-harness"]').count()===1,'翻译卡片分组错误');
    await page.locator('.harness-attribution').scrollIntoViewIfNeeded();assert(await page.locator('.harness-attribution a').getAttribute('href')==='https://github.com/deepseek-ai/deepseek-harness','来源链接错误');await shot('translation-card-source');record('translation-card-name-group-attribution');
    assert(report.consoleErrors.length===0,JSON.stringify(report.consoleErrors));
    report.ok=true;
  } catch(error) {report.failure=error.stack;throw error;}
  finally {
    report.requestCount=requests.length;
    fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify(report,null,2));
    fs.writeFileSync(path.join(artifacts,'fixture-requests.json'),JSON.stringify(requests,null,2));
    if(session) await session.close();
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    fs.rmSync(profile,{recursive:true,force:true});
  }
  console.log(JSON.stringify(report,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
