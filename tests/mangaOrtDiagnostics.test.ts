/** 固定模型创建旁观协议：仅伪造内存 buffer/Promise/CDP 消息，不运行 ORT、模型或浏览器。 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const require=createRequire(import.meta.url);
const {getMangaOrtModelCatalog,validateMangaOrtModelFiles,createMangaOrtDecorator,createOrtConsoleObserver,analyze}=require('../scripts/testing/manga-ort-diagnostics.cjs');
const worker='chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/mangaInferenceWorker.js',diagnosticId='direct_test',marker='__FR_ORT_LOGID__';
const catalog=[{key:'detection',kind:'det',bytes:8,sha256:'a'.repeat(64),optional:false},{key:'recognition',kind:'rec',bytes:12,sha256:'b'.repeat(64),optional:false}];
const seg=getMangaOrtModelCatalog({includeSeg:true}).find((x:any)=>x.kind==='seg');
const folders:string[]=[];
afterEach(async()=>{await Promise.all(folders.splice(0).map(p=>fs.rm(p,{recursive:true,force:true})));});
class FakeBuffer {
    constructor(public byteLength:number){}
    static isView(value:any){return value?.fullView===true;}
}
function runtime(models:any[]=catalog){
    const logs:any[]=[];
    const native=vi.fn((_model:any,_options:any)=>Promise.resolve({inputNames:['x']}));
    const ort={InferenceSession:{create:native}};
    const context:any={ArrayBuffer:FakeBuffer,Promise,WeakMap,Reflect,Object,Array,Number,String,
        location:{href:worker},console:{debug:(m:string,value:string)=>{expect(m).toBe(marker);logs.push(JSON.parse(value));}}};
    runInNewContext(createMangaOrtDecorator({diagnosticId,expectedWorkerUrl:worker,modelCatalog:models}),context);
    const det=new FakeBuffer(8),rec=new FakeBuffer(12);
    context.__frOrtLogIdInstall(ort,{detection:det,recognition:rec});
    return {logs,native,ort,context,det,rec};
}
function rows(logs:any[]){return logs.map((value,index)=>({sequence:index+1,sessionId:'s',targetId:'t',prestart:true,params:{type:'debug',args:[{type:'string',value:marker},{type:'string',value:JSON.stringify(value)}]}}));}
function verdict(logs:any[],models:any[]=catalog){return analyze(rows(logs),new Map([['s',{sessionId:'s',targetId:'t',url:worker,exact:true,waiting:true,enabled:true,resumed:true}]]),[],diagnosticId,models);}
async function ocr(rt:ReturnType<typeof runtime>){await rt.ort.InferenceSession.create(rt.det,{executionProviders:['wasm'],graphOptimizationLevel:'all'});await rt.ort.InferenceSession.create(rt.rec,{executionProviders:['wasm'],graphOptimizationLevel:'all'});}

describe('漫画固定 ORT 创建协议',()=>{
    it('默认仅det/rec；可选seg严格固定大小与SHA，不混入字典/LaMa',()=>{
        expect(getMangaOrtModelCatalog().map((x:any)=>x.kind)).toEqual(['det','rec']);
        expect(getMangaOrtModelCatalog({includeSeg:true}).map((x:any)=>x.kind)).toEqual(['det','rec','seg']);
        expect(seg).toMatchObject({key:'segmentation',bytes:94669756,sha256:'1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f',optional:true});
        expect(()=>validateMangaOrtModelFiles(catalog,catalog)).not.toThrow();
        expect(()=>validateMangaOrtModelFiles(catalog,[...catalog,seg])).toThrow('identity mismatch: seg');
    });

    it('保持原生Promise及provider/graph参数，OCR绑定不把未加载CTD算missing',async()=>{
        const rt=runtime([...catalog,seg]),options={executionProviders:['wasm'],graphOptimizationLevel:'all'},promise=rt.ort.InferenceSession.create(rt.det,options);
        expect(promise).toBe(rt.native.mock.results[0].value);await promise;
        expect(rt.native.mock.calls[0][1]).toMatchObject({...options,logId:'FRORT_direct_test_det_1'});
        expect(options).not.toHaveProperty('logId');await rt.ort.InferenceSession.create(rt.rec,options);
        expect(rt.logs.filter(x=>x.type==='asset-bound').map(x=>x.kind)).toEqual(['det','rec']);
        expect(rt.logs.some(x=>x.type==='incomplete')).toBe(false);expect(verdict(rt.logs,[...catalog,seg]).complete).toBe(true);
    });

    it('CTD只在显式seg加载组绑定，不重复要求OCR；完整创建保持同一buffer',async()=>{
        const rt=runtime([...catalog,seg]);await ocr(rt);const buffer=new FakeBuffer(seg.bytes);
        rt.context.__frOrtLogIdInstall(rt.ort,{segmentation:buffer},'seg');
        await rt.ort.InferenceSession.create(buffer,{executionProviders:['wasm'],graphOptimizationLevel:'all'});
        expect(rt.native.mock.calls[2][0]).toBe(buffer);
        const result=verdict(rt.logs,[...catalog,seg]);expect(result.complete).toBe(true);
        expect(result.targets[0].creates.map((x:any)=>x.kind)).toEqual(['det','rec','seg']);
        expect(rt.logs.some(x=>x.type==='incomplete')).toBe(false);
    });

    it.each(['binding-only','failed-only'])('CTD实际绑定后%s不能冒充创建完整',async mode=>{
        const rt=runtime([...catalog,seg]);await ocr(rt);const buffer=new FakeBuffer(seg.bytes);
        rt.context.__frOrtLogIdInstall(rt.ort,{segmentation:buffer},'seg');
        if(mode==='failed-only'){
            rt.native.mockImplementationOnce(()=>Promise.reject(new Error('original GPU creation failed')));
            await expect(rt.ort.InferenceSession.create(buffer,{executionProviders:['webgpu']})).rejects.toThrow('original GPU creation failed');
        }
        const result=verdict(rt.logs,[...catalog,seg]);
        expect(result.complete).toBe(false);expect(result.problems).toContain('missing-successful-seg:t');
    });

    it('同一已绑定CTD的GPU失败后CPU成功仍保留原错误拒绝门与原Promise',async()=>{
        const rt=runtime([...catalog,seg]);await ocr(rt);const buffer=new FakeBuffer(seg.bytes);
        rt.context.__frOrtLogIdInstall(rt.ort,{segmentation:buffer},'seg');
        rt.native.mockImplementationOnce(()=>Promise.reject(new Error('original GPU creation failed')));
        const failed=rt.ort.InferenceSession.create(buffer,{executionProviders:['webgpu']});
        expect(failed).toBe(rt.native.mock.results[2].value);
        await expect(failed).rejects.toThrow('original GPU creation failed');
        await rt.ort.InferenceSession.create(buffer,{executionProviders:['wasm']});
        const result=verdict(rt.logs,[...catalog,seg]);expect(result.complete).toBe(false);
        expect(result.problems).toContain('create-error:t:3');
        expect(result.problems).not.toContain('missing-successful-seg:t');
        expect(result.targets[0].creates.map((x:any)=>x.outcome)).toEqual(['create-ok','create-ok','create-error','create-ok']);
        expect(rt.logs.find(x=>x.type==='create-error')).toMatchObject({kind:'seg',message:'original GPU creation failed',executionProviders:['webgpu']});
        expect(rt.native).toHaveBeenCalledTimes(4);
    });

    it('相同长度但未绑定的buffer仍unknown，原创建照常返回且诊断拒绝',async()=>{
        const rt=runtime();await ocr(rt);const buffer=new FakeBuffer(8),options={executionProviders:['wasm']};
        await rt.ort.InferenceSession.create(buffer,options);
        expect(rt.native.mock.calls[2]).toEqual([buffer,options]);
        expect(verdict(rt.logs).problems).toContain('unknown-create:t:3');
    });

    it('绑定只接受完整view、纯data options与固定加载组；不改未知签名',async()=>{
        const rt=runtime();const view={fullView:true,buffer:rt.det,byteLength:8,byteOffset:0};await rt.ort.InferenceSession.create(view,{});
        expect(rt.logs.find(x=>x.type==='create-start').kind).toBe('det');
        await rt.ort.InferenceSession.create({fullView:true,buffer:rt.det,byteLength:7,byteOffset:1},{});
        const options=Object.defineProperty({},'executionProviders',{get:()=>['wasm'],enumerable:true});
        await rt.ort.InferenceSession.create(rt.det,options);
        rt.context.__frOrtLogIdInstall(rt.ort,{},'other');
        expect(rt.logs.filter(x=>x.type==='create-start').map(x=>x.kind)).toEqual(['det','unknown','unknown']);
        expect(rt.logs.some(x=>x.reason==='unknown-binding-group')).toBe(true);
    });

    it.each(['bytes','sha256'])('parser核对已知%s，不以有格式的marker冒充真实固定身份',async field=>{
        const rt=runtime([...catalog,seg]);await ocr(rt);const copied=structuredClone(rt.logs),bound=copied.find((x:any)=>x.type==='asset-bound');
        bound[field]=field==='bytes'?bound.bytes+1:'c'.repeat(64);
        expect(verdict(copied,[...catalog,seg]).problems).toContain('invalid-asset-binding:t');
    });

    it('seg可选不等于OCR可选，det/rec成功创建仍分别必需',async()=>{
        const rt=runtime([...catalog,seg]);await rt.ort.InferenceSession.create(rt.det,{});
        expect(verdict(rt.logs,[...catalog,seg]).problems).toContain('missing-successful-rec:t');
        const only=runtime([...catalog,seg]);const b=new FakeBuffer(seg.bytes);only.context.__frOrtLogIdInstall(only.ort,{segmentation:b},'seg');await only.ort.InferenceSession.create(b,{});
        expect(verdict(only.logs,[...catalog,seg]).problems).toContain('missing-successful-det:t');
    });

    it('CTD未列入catalog时拒绝第三kind；错误SHA/unknown catalog均拒绝',async()=>{
        const rt=runtime([...catalog,seg]);await ocr(rt);const b=new FakeBuffer(seg.bytes);rt.context.__frOrtLogIdInstall(rt.ort,{segmentation:b},'seg');await rt.ort.InferenceSession.create(b,{});
        expect(verdict(rt.logs).complete).toBe(false);
        expect(()=>createMangaOrtDecorator({diagnosticId,expectedWorkerUrl:worker,modelCatalog:[...catalog,{...seg,sha256:'d'.repeat(64)}]})).toThrow('CTD identity');
        expect(()=>createMangaOrtDecorator({diagnosticId,expectedWorkerUrl:worker,modelCatalog:[...catalog,{...seg,kind:'unknown'}]})).toThrow('catalog');
    });

    it('原create上限8不扩张，超限保留原调用且诊断失败',async()=>{
        const rt=runtime();for(let i=0;i<9;i++)await rt.ort.InferenceSession.create(rt.det,{});
        expect(rt.native).toHaveBeenCalledTimes(9);expect(rt.logs.some(x=>x.reason==='create-cap')).toBe(true);
        expect(verdict(rt.logs).complete).toBe(false);
        expect(()=>createMangaOrtDecorator({diagnosticId,expectedWorkerUrl:worker,maxCreates:9})).toThrow('bounded');
    });

    it('拒绝序列缺口、遗失结果和pre-start缺口',async()=>{
        const rt=runtime();await ocr(rt);
        const missing=rt.logs.filter(x=>!(x.type==='create-ok'&&x.kind==='rec'));expect(verdict(missing).problems).toContain('missing-create-outcome:t:2');
        const gaps=structuredClone(rt.logs);gaps[1].sequence=99;expect(verdict(gaps).problems).toContain('marker-sequence-gap:t');
        const records=rows(rt.logs);records[1].prestart=false;
        expect(analyze(records,new Map([['s',{sessionId:'s',targetId:'t',url:worker,exact:true,waiting:true,enabled:true,resumed:true}]]),[],diagnosticId,catalog).complete).toBe(false);
    });

    it('严格CDP旁观不加命令；原始warning保留且不声称warning-free',async()=>{
        const root=await fs.mkdtemp(path.join(os.tmpdir(),'fluentread-ort-observer-'));folders.push(root);
        class Socket extends EventTarget {sent:any[]=[];send(...args:any[]){this.sent.push(args);return 'original-send';}close(){this.dispatchEvent(new Event('close'));return 'original-close';}}
        const observer=createOrtConsoleObserver({outputDirectory:path.join(root,'raw'),expectedWorkerUrl:worker,diagnosticId,modelCatalog:catalog,WebSocketClass:Socket});
        const socket=new observer.WebSocketClass();const incoming=(value:any)=>socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));
        incoming({method:'Target.attachedToTarget',params:{sessionId:'s',waitingForDebugger:true,targetInfo:{targetId:'t',type:'worker',url:worker}}});
        expect(socket.send(JSON.stringify({id:1,method:'Runtime.enable',sessionId:'s'}))).toBe('original-send');incoming({id:1});
        socket.send(JSON.stringify({id:2,method:'Runtime.runIfWaitingForDebugger',sessionId:'s'}));incoming({id:2});
        const rt=runtime();await ocr(rt);
        for(const row of rows(rt.logs))incoming({method:'Runtime.consoleAPICalled',sessionId:'s',params:row.params});
        incoming({method:'Runtime.consoleAPICalled',sessionId:'s',params:{type:'warning',args:[{type:'string',value:'retained native warning'}]}});
        const result=observer.finish();expect(result.complete).toBe(true);expect(result.observerAddsCdpCommands).toBe(false);expect(socket.sent).toHaveLength(2);
        expect(await fs.readFile(result.rawFile,'utf8')).toContain('retained native warning');expect(result.guardWarningPolicyUnchanged).toBe(true);
        expect(socket.close()).toBe('original-close');
        for(const limits of [{records:8193},{bytes:8*1024*1024+1},{recordBytes:65537}])expect(()=>createOrtConsoleObserver({outputDirectory:path.join(root,'invalid'),expectedWorkerUrl:worker,diagnosticId,modelCatalog:catalog,WebSocketClass:Socket,limits})).toThrow('only be reduced');
    });
});
