import {afterEach,describe,expect,it,vi} from 'vitest';
import {createRequire} from 'node:module';
import {createMangaRecognitionInput,MANGA_RECOGNITION_INPUT_RECORDS} from '@/src/features/image-translation/services/mangaRecognitionInput';
import {createMangaOcrColorAdapter,withMangaOcrColorRead} from '@/src/features/image-translation/services/mangaOcrColor';

const image=(width=8,color=[255,0,255,255])=>{
    const data=new Uint8ClampedArray(width*48*4);
    for(let offset=0;offset<data.length;offset+=4)data.set([255,255,255,255],offset);
    data.set(color,(width+1)*4);
    return {data};
};
const normalized=(value:number)=>Math.fround(value*(1/127.5)-1);
function stacked(images:Array<{data:Uint8ClampedArray}>,widths:number[],order=[0,1,2],pad=Math.max(...widths)){
    const data=new Float32Array(images.length*3*48*pad);
    for(let row=0;row<images.length;row++)for(let channel=0;channel<3;channel++)for(let y=0;y<48;y++)for(let x=0;x<pad;x++){
        data[(row*3+channel)*48*pad+y*pad+x]=normalized(images[row].data[(y*widths[row]+Math.min(x,widths[row]-1))*4+order[channel]]);
    }
    return data;
}
const start=(count:number,batchSize=6,order:'bgr'|'rgb'='bgr')=>{
    const input=createMangaRecognitionInput(order);input.adapter.beginPage();input.beginRun({cropCount:count,batchSize,enabled:true});return input;
};
const capture=(input:ReturnType<typeof start>,sample:ReturnType<typeof image>,width=8)=>input.adapter.transform(width,48,()=>sample,value=>value);
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('原批次三通道输入的完整性与资源合同',()=>{
    it.each(['bgr','rgb'] as const)('只在整批验证成功后改写既有数组为%s，分别复制每通道真实右边缘',order=>{
        const a=image(8,[255,13,50,255]),b=image(10,[12,220,74,255]),input=start(2,6,order),aBefore=a.data.slice(),bBefore=b.data.slice();
        expect(capture(input,b,10)).toBe(b);expect(capture(input,a)).toBe(a);
        expect(input.retainedPixels).toBe(18*48);expect(input.pendingReads).toBe(2);
        const data=stacked([a,b],[8,10],[0,0,0]);
        input.patchInput(['float32',data,[2,3,48,10]]);
        expect(data).toEqual(stacked([a,b],[8,10],order==='bgr'?[2,1,0]:[0,1,2]));
        expect(a.data).toEqual(aBefore);expect(b.data).toEqual(bBefore);expect(input.retainedPixels).toBe(0);expect(input.pendingReads).toBe(0);input.endRun();
    });
    it.each(['args','type','data','dims','count','channels','height','width','length','rrr','red','pad'])('晚期%s不匹配时整批逐byte不变、首因同对象重抛',kind=>{
        const a=image(8,[125,13,50,255]),b=image(10,[22,220,74,255]),input=start(2);capture(input,a);capture(input,b,10);
        let data=stacked([a,b],[8,10],[0,0,0]);const dimensions=[2,3,48,10],args:unknown[]=['float32',data,dimensions];
        if(kind==='args')args.push('unknown');if(kind==='type')args[0]='float64';if(kind==='data')args[1]=new Uint8Array(data.length);
        if(kind==='dims')args[2]=[2,3,48,NaN];if(kind==='count')dimensions[0]=1;if(kind==='channels')dimensions[1]=1;
        if(kind==='height')dimensions[2]=47;if(kind==='width'){dimensions[3]=11;args[1]=data=new Float32Array(2*3*48*11);}
        if(kind==='length')args[1]=data=data.slice(1);if(kind==='rrr')data[48*10]=.77;
        if(kind==='red')for(let c=0;c<3;c++)data[c*48*10]=.5;
        if(kind==='pad')for(let c=0;c<3;c++)data[c*48*10+9]=.5;
        const before=data.slice();let native:unknown;
        try{input.patchInput(args);}catch(error){native=error;}
        expect(native).toBeInstanceOf(Error);expect(data).toEqual(before);
        try{input.endRun();throw Error('missing first cause');}catch(error){expect(error).toBe(native);}
        expect(input.retainedPixels).toBe(0);expect(input.pendingReads).toBe(0);
    });
    it('缺读、额外读、Tensor之后的新读以及嵌套run均fail closed',()=>{
        const sample=image(),input=start(2);capture(input,sample);
        expect(()=>input.patchInput(['float32',stacked([sample],[8],[0,0,0]),[1,3,48,8]])).toThrow('不匹配');expect(()=>input.endRun()).toThrow('不匹配');
        const next=start(1);capture(next,sample);expect(()=>capture(next,sample)).toThrow('不匹配');expect(()=>next.endRun()).toThrow('不匹配');
        const after=start(1);capture(after,sample);after.patchInput(['float32',stacked([sample],[8],[0,0,0]),[1,3,48,8]]);expect(()=>capture(after,sample)).toThrow('不匹配');expect(()=>after.endRun()).toThrow('不匹配');
        const nested=start(1);expect(()=>nested.beginRun({cropCount:1,batchSize:1,enabled:true})).toThrow('不匹配');expect(()=>nested.endRun()).toThrow('不匹配');
    });
    it.each([{width:7,height:48},{width:8.5,height:48},{width:8,height:47}])('未知读回尺寸%j不进入关联',({width,height})=>{
        const input=start(1);expect(()=>input.adapter.transform(width,height,()=>image(),value=>value)).toThrow('不匹配');expect(()=>input.endRun()).toThrow('不匹配');
    });
    it('读回失败、无效RGBA与replace失败保存同一首因；page重置不继承错误',()=>{
        for(const stage of ['read','data','replace']){
            const input=start(1),native=new Error(stage);let actual:unknown;
            try{input.adapter.transform(8,48,()=>{if(stage==='read')throw native;return stage==='data'?{data:new Uint8ClampedArray(1)}:image();},()=>{throw native;});}catch(error){actual=error;}
            if(stage!=='data')expect(actual).toBe(native);expect(()=>input.patchInput(['float32',new Float32Array(3*48*8),[1,3,48,8]])).toThrow(actual as Error);
            try{input.endRun();}catch(error){expect(error).toBe(actual);}
            input.adapter.endPage();input.adapter.beginPage();input.beginRun({cropCount:0,batchSize:1,enabled:true});expect(()=>input.endRun()).not.toThrow();
        }
    });
    it.each(['abort','end','begin'])('读回期间%s后不保留过期像素，取消在构造前阻止推理',kind=>{
        const input=createMangaRecognitionInput(),abort=new AbortController();input.adapter.beginPage(abort.signal);input.beginRun({cropCount:1,batchSize:1,enabled:true});
        input.adapter.transform(8,48,()=>{if(kind==='abort')abort.abort();else if(kind==='end')input.adapter.endPage();else input.adapter.beginPage();return image();},value=>value);
        expect(input.retainedPixels).toBe(0);
        if(kind==='abort'){expect(()=>input.patchInput(['float32',new Float32Array(3*48*8),[1,3,48,8]])).toThrow('已取消');expect(()=>input.endRun()).toThrow('已取消');}
        else {expect(()=>input.patchInput([])).not.toThrow();input.endRun();}
    });
    it.each([{enabled:false,cropCount:1,batchSize:6},{enabled:true,cropCount:0,batchSize:6},{enabled:true,cropCount:MANGA_RECOGNITION_INPUT_RECORDS+1,batchSize:6},
        {enabled:true,cropCount:1.5,batchSize:6},{enabled:true,cropCount:1,batchSize:0},{enabled:true,cropCount:1,batchSize:Infinity}])('已知未准入%j精确走旧增强RRR，无RGB数据队列',options=>{
        const input=createMangaRecognitionInput(),legacy=createMangaOcrColorAdapter(),a=image(),b={data:a.data.slice()};input.adapter.beginPage();legacy.beginPage();input.beginRun(options);
        expect(input.adapter.transform(8,48,()=>a,value=>value)).toEqual(legacy.transform(8,48,()=>b,value=>value));expect(a.data).toEqual(b.data);
        expect(a.data[(8+1)*4]).toBeLessThan(255);expect(input.retainedPixels).toBe(0);input.patchInput([]);input.endRun();
    });
    it('同页RGB与旧增强共用2MP；超额/超单框预算原R保持，新的页重置',()=>{
        const input=createMangaRecognitionInput();input.adapter.beginPage();const sample=image(5000);
        for(let index=0;index<8;index++){input.beginRun({cropCount:1,batchSize:1,enabled:true});capture(input,sample,5000);input.patchInput(['float32',stacked([sample],[5000],[0,0,0]),[1,3,48,5000]]);input.endRun();}
        input.beginRun({cropCount:1,batchSize:1,enabled:false});const denied=image(5000);expect(capture(input,denied,5000)).toBeUndefined();expect(denied.data[(5000+1)*4]).toBe(255);input.endRun();
        input.beginRun({cropCount:2,batchSize:6,enabled:true});const huge=image(5462),last=image(5000);expect(capture(input,huge,5462)).toBeUndefined();expect(capture(input,last,5000)).toBeUndefined();
        const data=stacked([last,huge],[5000,5462],[0,0,0]),before=data.slice();input.patchInput(['float32',data,[2,3,48,5462]]);expect(data).toEqual(before);input.endRun();
        input.adapter.endPage();input.adapter.beginPage();input.beginRun({cropCount:1,batchSize:1,enabled:false});const fresh=image(5000);expect(capture(input,fresh,5000)).toBe(fresh);expect(fresh.data[(5000+1)*4]).toBeLessThan(255);input.endRun();
    });
    it('未beginPage时保持旧无效果，已入stack批次逐次释放且未读finally也能释放',()=>{
        const input=createMangaRecognitionInput();input.beginRun({cropCount:1,batchSize:1,enabled:true});expect(capture(input,image())).toBeUndefined();input.patchInput([]);input.endRun();
        input.adapter.beginPage();input.beginRun({cropCount:2,batchSize:1,enabled:true});const a=image(),b=image(9);capture(input,b,9);capture(input,a);
        input.patchInput(['float32',stacked([a],[8],[0,0,0]),[1,3,48,8]]);expect(input.retainedPixels).toBe(9*48);expect(input.pendingReads).toBe(1);
        expect(()=>input.endRun()).toThrow('不完整');expect(input.retainedPixels).toBe(0);expect(input.pendingReads).toBe(0);
    });
    it('同一批的已准入小裁图改BGR，超单框上限行仍逐值保持旧RRR',()=>{
        const input=start(2),a=image(),b=image(5462);capture(input,a);expect(capture(input,b,5462)).toBeUndefined();
        const data=stacked([a,b],[8,5462],[0,0,0]),expected=data.slice();expected.set(stacked([a],[8],[2,1,0],5462));
        input.patchInput(['float32',data,[2,3,48,5462]]);expect(data.every((value,index)=>value===expected[index])).toBe(true);
        expect(input.retainedPixels).toBe(0);input.endRun();
    });
    it('200个已消费裁图在最后native仍pending时不保留RGBA，失败finally清空尚未消费队列',async()=>{
        const input=start(200,1),samples=Array.from({length:200},()=>image());for(const sample of samples)capture(input,sample);
        expect(input.retainedPixels).toBe(200*8*48);let release!:()=>void,ready!:()=>void;
        const pending=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{ready=resolve;});
        const inference=(async()=>{for(let index=0;index<samples.length;index++){input.patchInput(['float32',stacked([samples[index]],[8],[0,0,0]),[1,3,48,8]]);if(index===199){ready();await pending;}}input.endRun();})();
        await started;expect(input.pendingReads).toBe(0);expect(input.retainedPixels).toBe(0);release();await inference;
        const failing=start(2,1),native=new Error('native first cause');capture(failing,image());capture(failing,image());failing.fail(native);failing.fail(new Error('later'));
        try{failing.endRun();throw Error('missing failure');}catch(error){expect(error).toBe(native);}
        expect(failing.retainedPixels).toBe(0);expect(failing.pendingReads).toBe(0);
    });
    it('未被SDK吞掉的外部异常收尾只释放数据，不用批次不完整覆盖其首因',()=>{
        const input=start(1),failure=new Error('external native rejection');capture(input,image());
        try{try{throw failure;}finally{input.endRun(false);}}catch(error){expect(error).toBe(failure);}
        expect(input.retainedPixels).toBe(0);expect(input.pendingReads).toBe(0);
    });
});

// 测试通过依赖自己的 package exports 加载它已锁定的原生 Canvas；不引用用户路径或另一个仓库。
const localRequire=createRequire(import.meta.url),sdkRequire=createRequire(localRequire.resolve('ppu-paddle-ocr/web'));
const canvasRequire=createRequire(sdkRequire.resolve('ppu-ocv/canvas-web'));
const native=canvasRequire('@napi-rs/canvas');

async function publicSdkAdapter(input:ReturnType<typeof createMangaRecognitionInput>,session:unknown,
    options:Partial<import('ppu-paddle-ocr/web').RecognitionOptions>,batchSize:number){
    const {RecognitionService}=await import('ppu-paddle-ocr/web');
    class Adapter extends RecognitionService{
        private restores=new Set<()=>void>();
        constructor(){
            super(session as ConstructorParameters<typeof RecognitionService>[0],options);
            const original=this.platform.ort;this.platform.ort={...original,Tensor:new Proxy(original.Tensor,{construct(target,args,newTarget){try{input.patchInput(args);return Reflect.construct(target,args,newTarget);}catch(error){input.fail(error);throw error;}}})};
            const create=this.platform.canvas.createProcessor.bind(this.platform.canvas);
            this.platform.canvas.createProcessor=canvas=>{const processor=create(canvas),resize=processor.resize.bind(processor);processor.resize=options=>{
                try{
                    const result=resize(options),output=result.toCanvas(),context=output.getContext('2d');
                    const restore=withMangaOcrColorRead(context,output.width,output.height,input.adapter,consumed=>this.restores.delete(consumed),input.fail);if(restore)this.restores.add(restore);return result;
                }catch(error){input.fail(error);throw error;}
            };return processor;};
        }
        async run(...args:Parameters<InstanceType<typeof RecognitionService>['run']>){
            input.beginRun({cropCount:args[1].length,batchSize,enabled:true});
            try{return await super.run(...args);}catch(error){input.fail(error);throw error;}
            finally{for(const restore of this.restores)restore();this.restores.clear();input.endRun();}
        }
    }
    return new Adapter();
}

describe('实际public SDK的裁图顺序及批处理合同（fake session，不运行模型）',()=>{
    it('默认竖裁图旋转和整数缩放后的宽度排序不改变BGR关联，空间恢复及validSeq仍由原decoder处理',async()=>{
        const ort=await import('onnxruntime-web');vi.stubGlobal('document',{createElement:()=>native.createCanvas(1,1)});vi.stubGlobal('OffscreenCanvas',undefined);
        const source=native.createCanvas(80,48),ctx=source.getContext('2d'),boxes=[{x:0,y:0,width:8,height:48},{x:30,y:0,width:10,height:48}];
        boxes.forEach((box,index)=>{ctx.fillStyle=`rgb(125,${20+index*60},${220-index*50})`;ctx.fillRect(box.x,0,box.width,48);});
        const references=boxes.map(box=>{
            const crop=native.createCanvas(box.width,box.height);crop.getContext('2d').drawImage(source,box.x,box.y,box.width,box.height,0,0,box.width,box.height);
            const rotated=native.createCanvas(box.height,box.width),rc=rotated.getContext('2d');rc.translate(0,box.width);rc.rotate(-Math.PI/2);rc.drawImage(crop,0,0);
            const width=Math.round(48*rotated.width/rotated.height),resized=native.createCanvas(width,48);resized.getContext('2d').drawImage(rotated,0,0,width,48);
            return {width,data:resized.getContext('2d').getImageData(0,0,width,48).data};
        }).sort((a,b)=>a.width-b.width);
        const input=createMangaRecognitionInput(),run=vi.fn(async(feeds:Record<string,{data:Float32Array;dims:readonly number[]}>)=>{
            expect(feeds.x.dims).toEqual([2,3,48,288]);expect(feeds.x.data).toEqual(stacked(references,references.map(item=>item.width),[2,1,0]));expect(input.retainedPixels).toBe(0);
            const data=new Float32Array(2*8*4);
            for(let row=0;row<2;row++)for(let time=0;time<8;time++){const offset=(row*8+time)*4;data[offset+(time%2===0?1:2)]=.99;data[offset+3]=.002;}
            return {out:new ort.Tensor('float32',data,[2,8,4])};
        });
        const recognizer=await publicSdkAdapter(input,{inputMetadata:[{shape:['N',3,48,'W']}],run},{charactersDictionary:['','A','B',' '],recBatchSize:6,mainThreadYieldMs:0,minimumConfidence:0,spaceRecovery:true},6);
        input.adapter.beginPage();const result=await recognizer.run(source,boxes,undefined,'per-box');
        expect(run).toHaveBeenCalledOnce();expect(result.map(item=>item.box)).toEqual(boxes);
        // W230只解码ceil(8*230/288)=7步，W288为8步；原spaceRecovery插入的空格保留。
        expect(result.map(item=>item.text)).toEqual([' A B A B A B A B',' A B A B A B A']);input.adapter.endPage();
    });
    it.each([{requested:1,fixed:false},{requested:2,fixed:false},{requested:6,fixed:false},{requested:6,fixed:true}])('同宽同R异GB跨batch%j与两个原序均保持颜色身份、原批数及解码位置',async({requested,fixed})=>{
        const batchSize=fixed?1:requested;
        const ort=await import('onnxruntime-web'),originalTensor=ort.Tensor;
        vi.stubGlobal('document',{createElement:()=>native.createCanvas(1,1)});vi.stubGlobal('OffscreenCanvas',undefined);
        for(const reverse of [false,true]){
            const widths=[8,17,8,9,8,12,8,13,8,8,8,8],colors=widths.map((_,index)=>[125,20+index*20,220-index*20,255]);
            const source=native.createCanvas(widths.length*28,48),ctx=source.getContext('2d'),boxes=widths.map((width,index)=>({x:index*28,y:0,width,height:48}));
            boxes.forEach((box,index)=>{ctx.fillStyle=`rgb(${colors[index].slice(0,3).join(',')})`;ctx.fillRect(box.x,0,box.width,48);});
            const detections=reverse?[...boxes].reverse():boxes,cohort=detections.map((box,index)=>({box,index})).sort((a,b)=>a.box.width-b.box.width||a.index-b.index);
            const input=createMangaRecognitionInput(),inputs:Array<{dims:readonly number[];data:Float32Array}>=[];let offset=0;
            const session={inputMetadata:[{shape:[fixed?1:'N',3,48,'W']}],run:vi.fn(async(feeds:Record<string,{dims:readonly number[];data:Float32Array}>)=>{
                const tensor=feeds.x,chunk=cohort.slice(offset,offset+batchSize);offset+=chunk.length;
                const images=chunk.map(({box})=>({data:ctx.getImageData(box.x,0,box.width,48).data}));
                expect(tensor.data).toEqual(stacked(images,chunk.map(item=>item.box.width),[2,1,0]));
                inputs.push({dims:[...tensor.dims],data:tensor.data.slice()});
                expect(input.pendingReads).toBe(cohort.length-offset);
                const output=new Float32Array(chunk.length*2*4);for(let row=0;row<chunk.length;row++){output[row*8+1]=.99;output[row*8+4]=.99;}
                return {out:new ort.Tensor('float32',output,[chunk.length,2,4])};
            })};
            const recognizer=await publicSdkAdapter(input,session,{charactersDictionary:['','A','B',' '],recBatchSize:requested,mainThreadYieldMs:0,minimumConfidence:0,maxCropSourceSideLength:8192,rotateVerticalCrops:false},batchSize);input.adapter.beginPage();const result=await recognizer.run(source,detections,undefined,'per-box');
            expect(result.map(item=>item.box.x)).toEqual([...boxes].sort((a,b)=>a.x-b.x).map(box=>box.x));expect(result.every(item=>item.text==='A')).toBe(true);
            expect(session.run).toHaveBeenCalledTimes(Math.ceil(boxes.length/batchSize));expect(inputs.every(item=>item.dims[1]===3&&item.dims[2]===48)).toBe(true);
            expect(input.retainedPixels).toBe(0);expect(input.pendingReads).toBe(0);expect(ort.Tensor).toBe(originalTensor);input.adapter.endPage();
        }
    });
});
