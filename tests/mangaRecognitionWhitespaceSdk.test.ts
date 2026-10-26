import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createRequire} from 'node:module';

const state=vi.hoisted(()=>({session:undefined as any,dictionary:[] as string[],boxes:[] as any[],raw:[] as any[],batch:6}));
vi.mock('@/src/shared/onnx/resources',async original=>({...await original<any>(),paceLocalInference:(operation:()=>unknown)=>operation()}));
vi.mock('@/src/shared/onnx/webgpu',()=>({probeWebGpu:async()=>({available:false,info:''})}));
vi.mock('@/src/features/image-translation/services/mangaOcrAssets',async original=>({...await original<any>(),loadMangaOcrAssets:async()=>({charactersDictionary:new ArrayBuffer(0)})}));
vi.mock('@/src/features/image-translation/services/mangaInferenceClient',()=>({mangaExtensionUrl:(path:string)=>`chrome-extension://test${path}`,mangaInferenceClient:{}}));
vi.mock('@/src/features/image-translation/services/mangaInpainting',()=>({mangaInpaintingRuntime:{dispose:vi.fn()}}));
vi.mock('onnxruntime-web/webgpu',async()=>({env:{wasm:{numThreads:1,proxy:false}},InferenceSession:{}}));
vi.mock('ppu-paddle-ocr/web',async original=>{
    const sdk=await original<any>();
    return {...sdk,PaddleOcrService:class{
        recognitionSession=state.session;
        recognition:unknown;recognitor:any;
        constructor(public options:any){}
        async initialize(){this.options.recognition.charactersDictionary=state.dictionary;this.options.recognition.recBatchSize=state.batch;}
        async recognize(canvas:unknown,options:unknown){return {results:await this.recognitor.run(canvas,state.boxes,undefined,'per-box',options)};}
        async destroy(){}
    }};
});
import {createBrowserMangaOcr} from '@/src/features/image-translation/services/mangaOcr';
import * as spacing from '@/src/features/image-translation/services/mangaRecognitionWhitespace';

const localRequire=createRequire(import.meta.url),sdkRequire=createRequire(localRequire.resolve('ppu-paddle-ocr/web'));
const canvasRequire=createRequire(sdkRequire.resolve('ppu-ocv/canvas-web')),native=canvasRequire('@napi-rs/canvas');
beforeEach(()=>{
    state.dictionary=Array.from({length:18710},(_,index)=>index===0||index===18709?'':`unused-${index}`);
    state.dictionary[1]='A';state.dictionary[2]='B';state.dictionary[3]='C';state.raw=[];
    vi.stubGlobal('document',{createElement:()=>native.createCanvas(1,1)});vi.stubGlobal('OffscreenCanvas',undefined);
});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('产品公开facade贯通原SDK预处理和decoder（仅fake session，无模型）',()=>{
    it.each([{batch:1,fixed:false},{batch:2,fixed:false},{batch:6,fixed:false},{batch:6,fixed:true}])('原批次/Box排序/decoder与有界空格恢复同时成立：%j',async({batch,fixed})=>{
        const ort=await import('onnxruntime-web'),original=spacing.createMangaRecognitionWhitespace;
        let controller!:ReturnType<typeof original>;
        vi.spyOn(spacing,'createMangaRecognitionWhitespace').mockImplementation(()=>{
            controller=original();const apply=controller.applyToSdkResults.bind(controller);
            controller.applyToSdkResults=results=>{state.raw.push(results.map(result=>({...result})));return apply(results);};return controller;
        });
        for(const reverse of [false,true]){
            state.batch=batch;
            const source=native.createCanvas(160,210),ctx=source.getContext('2d');ctx.fillStyle='rgb(24,44,68)';ctx.fillRect(0,0,160,210);
            const boxes=[{x:4,y:4,width:96,height:48},{x:4,y:74,width:144,height:48},{x:4,y:144,width:96,height:48}];
            for(const index of [0,2])for(const [left,right] of [[8,20],[23,35],[63,76]]){ctx.fillStyle='rgb(24,220,220)';ctx.fillRect(boxes[index].x+left,boxes[index].y+8,right-left,32);}
            state.boxes=reverse?[...boxes].reverse():boxes;
            const stable=state.boxes.map((box,index)=>({box,index})).sort((a,b)=>a.box.width-b.box.width||a.index-b.index),effective=fixed?1:batch;
            let offset=0;const outputs:any[]=[],inputs:any[]=[],run=vi.fn(async(feeds:Record<string,InstanceType<typeof ort.Tensor>>)=>{
                const tensor=feeds.x,chunk=stable.slice(offset,offset+effective);offset+=chunk.length;inputs.push(tensor);
                const width=Math.max(...chunk.map(item=>item.box.width)),T=width/8,C=18710,data=new Float32Array(chunk.length*T*C);
                expect(tensor.dims).toEqual([chunk.length,3,48,width]);
                for(let row=0;row<chunk.length;row++){
                    for(let t=0;t<T;t++)data[(row*T+t)*C]=.99;
                    for(const [t,index] of [[1,1],[3,2],[9,3]]){const base=(row*T+t)*C;data[base]=0;data[base+index]=.99;}
                    const peak=(row*T+5)*C;data[peak]=.6;data[peak+C-1]=.4;
                }
                const output=new ort.Tensor('float32',data,[chunk.length,T,C]);outputs.push({output,data:new Float32Array(data)});return {out:output};
            });
            state.session={inputMetadata:[{shape:[fixed?1:'N',3,48,'W']}],run};
            const port=await createBrowserMangaOcr();
            const dictionary=state.dictionary;
            const result=await port.recognize('unused',{flatten:true,noCache:true,strategy:'per-box',decodedImage:source});
            expect(result.results.map(item=>item.text)).toEqual(['AB C','ABC','AB C']);
            expect(result.results.map(item=>item.box)).toEqual(boxes);
            expect(result.results.every((item,index)=>item.box===boxes[index]&&item.confidence>.98)).toBe(true);
            expect(state.raw.at(-1).map((item:any)=>item.text)).toEqual(['ABC','ABC','ABC']);
            expect(run).toHaveBeenCalledTimes(Math.ceil(3/effective));expect(inputs).toHaveLength(Math.ceil(3/effective));
            for(const {output,data} of outputs)expect(output.data).toEqual(data);
            expect(state.dictionary).toBe(dictionary);await port.destroy();
        }
    });
});
