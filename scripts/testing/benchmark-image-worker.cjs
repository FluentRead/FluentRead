/**
 * 图片分割 Worker 的隔离浏览器 A/B：构建指定旧提交和本次 checkout 的真实客户端、消息处理器及像素算法。
 * 仅替换 ONNX 算子与模型缓存，实际使用浏览器 Worker、消息克隆/转移、队列和取消。
 * 比较完整模型输入 SHA-256、输出 SHA-256、原图字节及主线程预处理/发送阻塞；不代表真实模型性能。
 */
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {execFileSync}=require('node:child_process'),assert=require('node:assert/strict');
const {build}=require('esbuild');
const {guardBrowserClose}=require('./owned-browser-close.cjs');
const arg=(name,fallback)=>{const index=process.argv.indexOf(`--${name}`);return index<0?fallback:process.argv[index+1];};
const root=path.resolve(__dirname,'../..'),out=path.resolve(arg('out-dir'));
const base=execFileSync('git',['rev-parse','--verify',`${arg('before-ref')}^{commit}`],{cwd:root,encoding:'utf8'}).trim();
const packages=arg('playwright-root'),helper=arg('focus-safe-helper');
assert(packages&&helper,'须指定 --playwright-root 和 --focus-safe-helper');
const {chromium}=require(path.join(packages,'playwright'));
const {launchFocusSafePersistentContext,newPageWithoutForeground}=require(helper);
fs.mkdirSync(out,{recursive:true});
const report={base,scope:'isolated real browser Workers; production client/handler/pixels; controlled ONNX and model cache',
    limitations:['不运行真实 ONNX 算子，不代表实际模型推理、在线翻译或整页翻译性能。','仅观察本轮测试页面和其专用 Worker，不覆盖扩展后台或内容脚本。'],errors:[],warnings:[]};
const fixtureOrt=`
export const env={wasm:{}};
export class Tensor {constructor(type,data,dims){Object.assign(this,{type,data,dims});}dispose(){}}
let cpu=false;
self.addEventListener('message',event=>{cpu=event.data.cpu;});
const metadata=(name,shape)=>({name,isTensor:true,type:'float32',shape});
const tensor=dims=>({type:'float32',dims,data:new Float32Array(dims.reduce((a,b)=>a*b,1)),dispose(){}});
export const InferenceSession={create:async()=>({inputNames:['images'],outputNames:['blk','seg','det'],
 inputMetadata:[metadata('images',[1,3,1024,1024])],outputMetadata:[metadata('blk',[1,64512,7]),metadata('seg',[1,1,1024,1024]),metadata('det',[1,2,1024,1024])],
 async run({images}){
  const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',images.data)),byte=>byte.toString(16).padStart(2,'0')).join('');
  self.postMessage({benchmarkTensorSha256:sha});
  if(new URL(self.location.href).searchParams.has('fail-first')&&!cpu)throw new Error('controlled GPU execution failure');
  const result={blk:tensor([1,64512,7]),seg:tensor([1,1,1024,1024]),det:tensor([1,2,1024,1024])};
  const size=1024*1024;
  for(let i=0;i<size;i++)result.seg.data[i]=(images.data[i]+images.data[size+i]+images.data[2*size+i])/3;
  return result;
 },release:async()=>{}})};
`;
async function bundle(label,worker){
    const feature=path.join(root,'src/features/image-translation/services');
    const entry=worker?`import {startMangaInferenceWorker} from './mangaInference.worker';
        self.addEventListener('unhandledrejection',event=>self.postMessage({benchmarkError:String(event.reason)}));
        startMangaInferenceWorker();`:
        `export {createMangaInferenceClient} from './mangaInferenceClient';export {createImageTextSegmentationInput} from './imageTextSegmentation';`;
    const result=await build({stdin:{contents:entry,resolveDir:feature,sourcefile:`${label}-${worker?'worker':'page'}.ts`,loader:'ts'},
        bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',logLevel:'silent',
        plugins:[{name:'controlled-inference-only',setup(api){
            if(label==='before')api.onLoad({filter:/\/src\/features\/image-translation\/services\/(mangaInferenceClient|mangaInference\.worker|imageTextSegmentation)\.ts$/},args=>({
                contents:execFileSync('git',['show',`${base}:${path.relative(root,args.path)}`],{cwd:root,encoding:'utf8'}),loader:'ts',resolveDir:path.dirname(args.path),
            }));
            if(worker){
                api.onResolve({filter:/^onnxruntime-web\/webgpu$/},()=>({path:'ort',namespace:'fixture'}));
                api.onResolve({filter:/^\.\/manga(Ocr|Inpainting|OcrAssets)$/},args=>args.importer.endsWith('/mangaInference.worker.ts')?{path:args.path,namespace:'fixture'}:undefined);
                api.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='ort'?fixtureOrt:
                    args.path==='./mangaOcrAssets'?'export const loadMangaTextSegmentationAsset=async()=>new ArrayBuffer(1);':
                    args.path==='./mangaOcr'?'export const createBrowserMangaOcr=()=>{throw new Error("unexpected OCR");};':
                    'export const createBrowserMangaInpainter=()=>{throw new Error("unexpected inpainting");};',loader:'js'}));
            }
        }}]});
    return result.outputFiles[0].text;
}
(async()=>{
    let session,server,profile,primary;
    try{
        const routes=new Map();
        for(const label of ['before','after']){
            // 构建依赖与变更顺序明确，避免多个 bundler 同时重写临时模块。
            routes.set(`/${label}-page.js`,await bundle(label,false));routes.set(`/${label}-worker.js`,await bundle(label,true));
        }
        server=http.createServer((req,res)=>{
            const name=new URL(req.url,'http://localhost').pathname;
            res.setHeader('Cache-Control','no-store');
            if(name==='/favicon.ico'){res.writeHead(204);res.end();return;}
            if(routes.has(name)){res.setHeader('Content-Type','text/javascript');res.end(routes.get(name));return;}
            res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><title>FluentRead Worker responsiveness</title><h1>图片分割 Worker 响应测试</h1><pre id="result">测试中</pre>');
        });
        await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
        profile=fs.mkdtempSync(path.join(os.tmpdir(),'fluentread-image-worker-'));
        session=await launchFocusSafePersistentContext({chromium,profileDir:profile,browserPath:arg('browser-path','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
            headless:false,background:true,viewport:{width:1100,height:800}});
        guardBrowserClose(session,profile);
        Object.assign(report,{launchMode:session.launchMode,focusPolicy:session.focusPolicy,windowPlacement:session.windowPlacement});
        assert.equal(session.windowPlacement.browserFrontmost,false);
        const page=await newPageWithoutForeground(session.context);
        page.on('pageerror',error=>report.errors.push({surface:'page-or-worker',message:error.message}));
        page.on('console',message=>{if(['error','warning'].includes(message.type()))report[message.type()==='error'?'errors':'warnings'].push({surface:'page-or-worker-console',message:message.text(),location:message.location()});});
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        report.browser=await session.context.browser().version();
        report.results=await page.evaluate(async()=>{
            const before=await import('/before-page.js'),after=await import('/after-page.js');
            const sha=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',value)),byte=>byte.toString(16).padStart(2,'0')).join('');
            const check=(condition,message)=>{if(!condition)throw new Error(message);};
            const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
            const errors=[],clients=[];
            let active;
            function connect(label,failFirst=false){
                const state={created:0,workers:[],hash:'',mainBlockingMs:0,factoryAt:0};
                state.client=(label==='before'?before:after).createMangaInferenceClient(()=>{
                    state.created++;
                    const worker=new Worker(`/${label}-worker.js${failFirst?'?fail-first=1':''}`,{type:'module'});
                    state.workers.push(worker);
                    worker.addEventListener('error',event=>errors.push({surface:'worker',message:event.message}));
                    worker.addEventListener('messageerror',()=>errors.push({surface:'worker',message:'messageerror'}));
                    worker.addEventListener('message',event=>{if(event.data.benchmarkTensorSha256)state.hash=event.data.benchmarkTensorSha256;if(event.data.benchmarkError)errors.push({surface:'worker',message:event.data.benchmarkError});});
                    const post=worker.postMessage.bind(worker);
                    worker.postMessage=(message,transfer)=>{
                        post(message,transfer);
                        if(message.type==='segment'&&active===state)state.mainBlockingMs=performance.now()-state.factoryAt;
                    };
                    return worker;
                });
                clients.push(state.client);return state;
            }
            const states={before:connect('before'),after:connect('after')};
            try{
                for(const state of Object.values(states))check(await state.client.prepareTextSegmentation(),'fixture preparation failed');
                const cases=[];
                for(const [width,height] of [[512,256],[2048,2048],[4096,4096]]){
                    const pixels=new Uint8ClampedArray(width*height*4);
                    let seed=20261113;
                    for(let index=0;index<pixels.length;index++){
                        seed=(Math.imul(seed,1664525)+1013904223)>>>0;pixels[index]=seed>>>24;
                    }
                    const source={pixels,width,height},original=await sha(pixels),samples={before:[],after:[]};
                    let expectedTensor,expectedOutput;
                    for(let round=0;round<6;round++)for(const label of round%2?['after','before']:['before','after']){
                        const state=states[label];active=state;state.hash='';
                        const started=performance.now();
                        const tick=new Promise(resolve=>setTimeout(()=>resolve(performance.now()-started),0));
                        const output=await state.client.segmentText(()=>{
                            state.factoryAt=performance.now();
                            return label==='before'?before.createImageTextSegmentationInput(pixels,width,height):source;
                        });
                        const totalMs=performance.now()-started,mainTimerLatencyMs=await tick,outputSha=await sha(output);
                        check(state.hash,'missing model input hash');
                        if(!expectedTensor){expectedTensor=state.hash;expectedOutput=outputSha;}
                        check(expectedTensor===state.hash&&expectedOutput===outputSha,'A/B pixels or model inputs changed');
                        if(round>0)samples[label].push({mainBlockingMs:state.mainBlockingMs,mainTimerLatencyMs,totalMs});
                    }
                    check(await sha(pixels)===original,'original RGBA was changed or detached');
                    cases.push({width,height,rgbaBytes:pixels.byteLength,modelInputSha256:expectedTensor,outputSha256:expectedOutput,sourceUnchanged:true,
                        before:{samples:samples.before,medianMainBlockingMs:median(samples.before.map(value=>value.mainBlockingMs)),medianTimerLatencyMs:median(samples.before.map(value=>value.mainTimerLatencyMs)),medianTotalMs:median(samples.before.map(value=>value.totalMs))},
                        after:{samples:samples.after,medianMainBlockingMs:median(samples.after.map(value=>value.mainBlockingMs)),medianTimerLatencyMs:median(samples.after.map(value=>value.mainTimerLatencyMs)),medianTotalMs:median(samples.after.map(value=>value.totalMs))}});
                }
                const retry=connect('after',true);check(await retry.client.prepareTextSegmentation(),'retry preparation failed');
                const source={width:4,height:4,pixels:new Uint8ClampedArray(64).fill(128)},original=await sha(source.pixels);
                let reads=0;
                const retried=await retry.client.segmentText(()=>{reads++;return source;});
                check(retry.created===2&&reads===2&&retried.length===1024*1024,'CPU retry did not rebuild and reread');
                check(await sha(source.pixels)===original,'CPU retry changed source');
                const cancel=connect('after');check(await cancel.client.prepareTextSegmentation(),'cancel preparation failed');
                const controller=new AbortController();
                const pending=cancel.client.segmentText(()=>source,controller.signal).then(()=>({ok:true}),error=>({ok:false,name:error.name}));
                const started=performance.now();controller.abort();const canceled=await pending;
                const settledMs=performance.now()-started;
                check(!canceled.ok&&canceled.name==='AbortError','queued cancellation failed');
                const canceledReads={count:0};
                await cancel.client.segmentText(()=>{canceledReads.count++;return source;});
                check(canceledReads.count===1,'cancel poisoned next request');
                const result={warmups:1,samples:5,cases,cpuRetry:{workers:retry.created,sourceReads:reads,sourceUnchanged:true},cancellation:{name:canceled.name,settledMs,recovered:true},errors};
                document.querySelector('#result').textContent=JSON.stringify(result,null,2);
                return result;
            }finally{active=undefined;for(const client of clients)client.dispose();}
        });
        report.errors.push(...report.results.errors);
        assert.equal(report.errors.length,0);assert.equal(report.warnings.length,0);
        await page.screenshot({path:path.join(out,'benchmark.png'),fullPage:false});
        await page.goto('about:blank');report.passed=true;
    }catch(error){primary=error;report.passed=false;report.failure=error.stack||String(error);}
    finally{
        try{if(session)await session.close();}catch(error){primary??=error;report.passed=false;report.cleanupFailure=String(error);}
        if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
        if(profile&&!report.cleanupFailure)fs.rmSync(profile,{recursive:true,force:true});
        fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2));
        console.log(JSON.stringify({passed:report.passed,errors:report.errors.length,warnings:report.warnings.length,result:path.join(out,'result.json')}));
        if(primary){console.error(primary.stack||primary);process.exitCode=1;}
    }
})();
